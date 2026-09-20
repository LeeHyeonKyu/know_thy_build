import { test, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REHEARSAL_STALE } from "../lib/rehearsal.js";
import { runStage, completedForHead, abortStage, nextState, reviewFlips, reviewExhaustedReason, IN_FLIGHT_LABEL, buildCtxExtra, mergeGates, usageLine, makeCheckoutHead, makeLocalEntry, GATES_SELF_REPORTED, MergeBaseError, MERGE_BASE_BLOCKED_REASON, GIT_DIFF_BLOCKED_REASON, gateOutputPaths, resetGateOutputs, isNoWriteStage, assertNoWriteStageClean, stageMaxTurns, DEFAULT_MAX_TURNS, stageClaudeArgs, stageClaudeEnv, stagePrompt, ciSettingsFile, CI_SETTINGS, CI_SETTINGS_HARNESS, unhandledGateReason, reviewTier } from "../bin/run-stage.js";
import { GitDiffError } from "../lib/changed-files.js";
import { canTransition } from "../lib/labels.js";
import { commentsSinceRequeue } from "../lib/retro/issue-comments.js";
import { renderHandoff, parseHandoffs } from "../lib/handoff.js";
import { verifyStage } from "../lib/verify-stage.js";
import { requirementFor } from "../lib/requirements.js";
import { makeFakeRun } from "../lib/exec.js";
import { parseProgressMarker } from "../lib/progress.js";
import { appendRunRecord } from "../lib/run-record.js";
import { parseRunRecord } from "../lib/usage.js";

test("run-stage executes the §4.2.1 skeleton in order and transitions on success", async () => {
  const calls = [];
  const deps = {
    charterReady: vi.fn(async () => { calls.push("charter"); return true; }),
    trustWorkspace: vi.fn(async () => calls.push("trust")),
    claim: vi.fn(async () => { calls.push("claim"); return { ok: true }; }),
    resetGates: vi.fn(async () => calls.push("reset-gates")),
    assertHandoff: vi.fn(async () => { calls.push("assert"); return { ok: true }; }),
    buildContext: vi.fn(async () => { calls.push("context"); return { roster: ["correctness"], rounds: undefined, orchestration: "workflow", limits: { K: 3 } }; }),
    heartbeat: vi.fn(async () => { calls.push("heartbeat"); return { stop: () => calls.push("heartbeat-stop") }; }),
    resetAgentsLog: vi.fn(async () => calls.push("reset-agents")),
    claudeP: vi.fn(async () => { calls.push("claude"); return { is_error: false, result: '{"schema":"factory.review.v1"}' }; }),
    gates: vi.fn(async () => { calls.push("gates"); return null; }),
    verifyStage: vi.fn(() => { calls.push("verify"); return { ok: true, reasons: [], data: { round: 1 } }; }),
    writeHandoff: vi.fn(async () => calls.push("handoff")),
    transition: vi.fn(async () => { calls.push("transition"); return { ok: true }; }),
    runRecord: vi.fn(() => calls.push("record")),
    release: vi.fn(async () => calls.push("release")),
  };
  const code = await runStage({ stage: "review", issue: 7, deps });
  expect(code).toBe(0);
  expect(calls).toEqual(["charter", "trust", "claim", "reset-gates", "heartbeat", "assert", "context", "reset-agents", "claude", "gates", "verify", "handoff", "transition", "record", "heartbeat-stop", "release"]);
});

// ADR-019 / N3: `claude -p --settings`가 가리키는 파일이 없으면 경로 deny 없이 에이전트가 돈다 —
// 확인되지 않은 강제는 강제가 아니므로, 띄우기 전에 needs-human으로 멈춘다.
test("ci-settings.json missing → needs-human before claude -p is ever spawned, exit 2", async () => {
  const transition = vi.fn(async () => ({ ok: true }));
  const deps = {
    charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }),
    assertHandoff: async () => ({ ok: true }), heartbeat: async () => ({ stop() {} }),
    ciSettingsPresent: async () => false,
    buildContext: vi.fn(async () => ({ roster: [], orchestration: "workflow", limits: {} })),
    claudeP: vi.fn(), gates: async () => null,
    verifyStage: () => ({ ok: true, reasons: [], data: {} }), writeHandoff: async () => {},
    transition, runRecord: () => {}, release: async () => {},
  };
  expect(await runStage({ stage: "review", issue: 7, deps })).toBe(2);
  expect(deps.claudeP).not.toHaveBeenCalled();
  expect(deps.buildContext).not.toHaveBeenCalled();   // 컨텍스트를 만들기도 전에 멈춘다
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:needs-human",
    reason: expect.stringContaining(".factory/ci-settings.json missing"),
  }));
});

test("ci-settings.json present → the stage proceeds normally", async () => {
  const deps = {
    charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }),
    assertHandoff: async () => ({ ok: true }), heartbeat: async () => ({ stop() {} }),
    ciSettingsPresent: async () => true,
    buildContext: async () => ({ roster: [], orchestration: "workflow", limits: {} }),
    claudeP: vi.fn(async () => ({ is_error: false, result: "{}" })), gates: async () => null,
    verifyStage: () => ({ ok: true, reasons: [], data: {} }), writeHandoff: async () => {},
    transition: async () => ({ ok: true }), runRecord: () => {}, release: async () => {},
  };
  expect(await runStage({ stage: "review", issue: 7, deps })).toBe(0);
  expect(deps.claudeP).toHaveBeenCalled();
});

// KTB-28: 거부된 claim은 더 이상 조용한 exit 0이 아니다 — 잡을 실패로 끝내고(exit 2) 기록·코멘트를 남긴다.
test("claim failure does no work and fails the job; verify failure → transition to needs-human, exit 2", async () => {
  const base = (over) => ({
    charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }), assertHandoff: async () => ({ ok: true }),
    buildContext: async () => ({ roster: [], orchestration: "workflow", limits: {} }), heartbeat: async () => ({ stop() {} }),
    claudeP: async () => ({ is_error: false, result: "{}" }), gates: async () => null,
    verifyStage: () => ({ ok: true, reasons: [], data: {} }), writeHandoff: async () => {}, transition: vi.fn(async () => ({ ok: true })),
    runRecord: () => {}, release: async () => {}, ...over });
  const d1 = base({ claim: async () => ({ ok: false, holder: "other" }), claudeP: vi.fn() });
  expect(await runStage({ stage: "review", issue: 7, deps: d1 })).toBe(2);
  expect(d1.claudeP).not.toHaveBeenCalled();
  const d2 = base({ verifyStage: () => ({ ok: false, reasons: ["roster role not completed: qa"], data: {} }) });
  expect(await runStage({ stage: "review", issue: 7, deps: d2 })).toBe(2);
  expect(d2.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: expect.stringMatching(/stage artifact/) }));
});

test("charter not ready → exit 0 immediately", async () => {
  const deps = { charterReady: async () => false, claim: vi.fn() };
  expect(await runStage({ stage: "plan", issue: 1, deps })).toBe(0);
  expect(deps.claim).not.toHaveBeenCalled();
});

test("implement stage moves to in-progress after the handoff check, then to awaiting-review", async () => {
  const calls = [];
  const transition = vi.fn(async ({ to }) => { calls.push("transition"); return { ok: true, to }; });
  const deps = {
    charterReady: async () => { calls.push("charter"); return true; },
    trustWorkspace: async () => calls.push("trust"),
    claim: async () => { calls.push("claim"); return { ok: true }; },
    heartbeat: async () => { calls.push("heartbeat"); return { stop: () => calls.push("heartbeat-stop") }; },
    assertHandoff: async () => { calls.push("assert"); return { ok: true }; },
    buildContext: async () => { calls.push("context"); return { roster: [], orchestration: "workflow", limits: { K: 3 } }; },
    resetAgentsLog: async () => calls.push("reset-agents"),
    claudeP: async () => { calls.push("claude"); return { is_error: false, result: "{}" }; },
    gates: async () => { calls.push("gates"); return null; },
    verifyStage: () => { calls.push("verify"); return { ok: true, reasons: [], data: {} }; },
    writeHandoff: async () => calls.push("handoff"),
    transition,
    runRecord: () => calls.push("record"),
    release: async () => calls.push("release"),
  };
  expect(await runStage({ stage: "implement", issue: 9, deps, runnerId: "runner-1" })).toBe(0);
  expect(calls).toEqual(["charter", "trust", "claim", "heartbeat", "assert", "transition", "context", "reset-agents", "claude", "gates", "verify", "handoff", "transition", "record", "heartbeat-stop", "release"]);
  expect(transition.mock.calls[0][0]).toEqual(expect.objectContaining({ to: "factory:in-progress", reason: expect.stringContaining("runner-1") }));
  expect(transition.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({ to: "factory:awaiting-review" }));
});

/**
 * ── Structure B (리뷰 효율 Task 3) — the pre-handoff self-gate at the implement stage ──────────
 *
 * COST NOTE (regression the plan pins): the self-gate reuses the gates result the stage ALREADY
 * computed (it is handed `d.selfGate({ gates })`, never re-runs the gate commands) and grades the
 * qa manifest the runner already reads — so a self-gate run is CHEAPER than a review round, which
 * would dispatch the full LLM reviewer panel. A red deterministic check caught here never spends a
 * review round (KTB #18 R3 finish() regression; own-cal R1 cf1 fail-open guard).
 */
const selfGateDeps = (over = {}) => ({
  charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }),
  heartbeat: async () => ({ stop() {} }), assertHandoff: async () => ({ ok: true }),
  buildContext: async () => ({ roster: [], orchestration: "workflow", limits: { K: 3 } }),
  resetAgentsLog: async () => {}, claudeP: async () => ({ is_error: false, result: "{}" }),
  gates: async () => ({ schema: "factory.gates.v1", status: "GREEN", head_sha: "a".repeat(40) }),
  verifyStage: () => ({ ok: true, reasons: [], data: {} }), writeHandoff: vi.fn(async () => {}),
  runRecord: () => {}, release: async () => {},
  ...over,
});

// KTB #18 R3 + own-cal R1 regression: an ok:false self-gate must NOT reach factory:awaiting-review.
test("implement: an ok:false self-gate blocks the awaiting-review handoff and records the findings", async () => {
  const lines = [];
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const deps = selfGateDeps({
    transition, runRecord: (l) => lines.push(...l),
    selfGate: async ({ gates }) => {
      expect(gates).toEqual(expect.objectContaining({ status: "GREEN" }));   // reuses the computed gates
      return { ok: false, ranChecks: ["gates", "mutation"], findings: [{ check: "mutation", blocking: true, detail: "survivor: test/x.test.js asserts nothing under mutation (string in src/x.js)" }] };
    },
  });
  expect(await runStage({ stage: "implement", issue: 42, deps, runnerId: "r1" })).toBe(0);
  const targets = transition.mock.calls.map((c) => c[0].to);
  expect(targets).not.toContain("factory:awaiting-review");                  // the whole point
  expect(transition.mock.calls.at(-1)[0].to).toBe("factory:planned");        // a state the builder retries from
  expect(lines.some((l) => /self-gate: gates\+mutation → BLOCKED — .*survivor/.test(l))).toBe(true);
});

// A harness-class finding the builder cannot fix routes to a human, not a builder retry.
test("implement: a harness-class self-gate finding routes to needs-human, not planned", async () => {
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const deps = selfGateDeps({
    transition,
    selfGate: async () => ({ ok: false, ranChecks: ["mutation"], findings: [{ check: "mutation", blocking: true, harness: true, detail: "mutation check misconfigured — the harness cannot run a single test" }] }),
  });
  await runStage({ stage: "implement", issue: 43, deps, runnerId: "r1" });
  expect(transition.mock.calls.at(-1)[0].to).toBe("factory:needs-human");
});

// The green path proceeds to awaiting-review as today; advisory findings ride along in the handoff.
test("implement: an ok:true self-gate proceeds to awaiting-review and attaches advisory findings", async () => {
  const transition = vi.fn(async ({ to, data }) => ({ ok: true, to, data }));
  const writeHandoff = vi.fn(async () => {});
  const deps = selfGateDeps({
    transition, writeHandoff,
    selfGate: async () => ({ ok: true, ranChecks: ["gates", "mutation"], findings: [{ check: "mutation", blocking: false, detail: "mutation check skipped test/y.test.js: no resolvable source target" }] }),
  });
  expect(await runStage({ stage: "implement", issue: 44, deps, runnerId: "r1" })).toBe(0);
  expect(transition.mock.calls.at(-1)[0].to).toBe("factory:awaiting-review");
  // the advisory finding was attached to the handoff data so the reviewer starts ahead.
  expect(writeHandoff.mock.calls.at(-1)[0].data.self_gate.advisory[0]).toEqual(expect.objectContaining({ check: "mutation" }));
});

// Old wiring / other stages inject no d.selfGate — the stage skips the self-gate and behaves as before.
test("implement: no d.selfGate injected → self-gate is skipped and the stage reaches awaiting-review", async () => {
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const deps = selfGateDeps({ transition });   // no selfGate key
  expect(await runStage({ stage: "implement", issue: 45, deps, runnerId: "r1" })).toBe(0);
  expect(transition.mock.calls.at(-1)[0].to).toBe("factory:awaiting-review");
});

test("a refused transition is recorded, never silent", async () => {
  const lines = [];
  const deps = {
    charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }),
    heartbeat: async () => ({ stop() {} }), assertHandoff: async () => ({ ok: true }),
    buildContext: async () => ({ roster: [], orchestration: "workflow", limits: {} }),
    claudeP: async () => ({ is_error: false, result: "{}" }), gates: async () => null,
    verifyStage: () => ({ ok: true, reasons: [], data: {} }), writeHandoff: async () => {},
    transition: async () => ({ ok: false, reason: "plan handoff missing" }),
    runRecord: (l) => lines.push(...l), release: async () => {},
  };
  expect(await runStage({ stage: "plan", issue: 3, deps })).toBe(2);
  expect(lines).toContain("transition refused: plan handoff missing");

  const ipLines = [];
  const ipDeps = { ...deps, runRecord: (l) => ipLines.push(...l), writeHandoff: vi.fn(async () => {}) };
  expect(await runStage({ stage: "implement", issue: 3, deps: ipDeps, runnerId: "r1" })).toBe(2);
  expect(ipLines).toContain("transition refused: plan handoff missing");
  expect(ipDeps.writeHandoff).not.toHaveBeenCalled();          // in-progress 거부면 스테이지를 진행하지 않는다
});

test("review stage derives decision from verdicts via aggregateReview", async () => {
  const verdict = (role, kind) => ({
    role, verdict: kind, confidence: "high",
    must_fix: kind === "reject" ? [{ id: "MF1", where: "a.js:1", claim: "broken", evidence: "test fails" }] : [],
    should_fix: [], verified: [],
  });
  const depsFor = (verdicts) => ({
    charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }), assertHandoff: async () => ({ ok: true }),
    buildContext: async () => ({ roster: ["correctness", "qa"], orchestration: "workflow", limits: { K: 3 } }),
    heartbeat: async () => ({ stop() {} }), claudeP: async () => ({ is_error: false, result: "{}" }), gates: async () => null,
    verifyStage: () => ({ ok: true, reasons: [], data: { round: 1, verdicts } }),
    writeHandoff: vi.fn(async () => {}), transition: vi.fn(async () => ({ ok: true })),
    runRecord: () => {}, release: async () => {},
  });

  const rejected = depsFor([verdict("correctness", "reject"), verdict("qa", "approve")]);
  expect(await runStage({ stage: "review", issue: 7, deps: rejected })).toBe(0);
  expect(rejected.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:rework" }));
  expect(rejected.writeHandoff).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ decision: "rework", must_fix: [expect.objectContaining({ id: "MF1" })] }),
  }));

  const approved = depsFor([verdict("correctness", "approve"), verdict("qa", "approve")]);
  expect(await runStage({ stage: "review", issue: 7, deps: approved })).toBe(0);
  expect(approved.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:approved" }));

  const incomplete = depsFor([verdict("correctness", "approve")]);   // 2-role roster, 1 verdict
  expect(await runStage({ stage: "review", issue: 7, deps: incomplete })).toBe(2);
  expect(incomplete.transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:needs-human", reason: expect.stringMatching(/incomplete/),
  }));
  expect(incomplete.writeHandoff).not.toHaveBeenCalled();
});

// ── 여기부터: 최종 리뷰에서 걸린 것들 ────────────────────────────────────────

const baseDeps = (over = {}) => ({
  charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }),
  heartbeat: async () => ({ stop() {} }), assertHandoff: async () => ({ ok: true }),
  buildContext: async () => ({ roster: [], orchestration: "workflow", limits: { K: 3 } }),
  resetAgentsLog: async () => {}, claudeP: async () => ({ is_error: false, result: "{}" }), gates: async () => null,
  verifyStage: () => ({ ok: true, reasons: [], data: {} }), writeHandoff: async () => {},
  transition: async () => ({ ok: true, to: "factory:planned" }), runRecord: () => {}, release: async () => true, ...over,
});

test("I1: a heartbeat that throws still releases the lock and exits 1", async () => {
  const calls = [];
  const deps = baseDeps({
    heartbeat: async () => { calls.push("heartbeat"); throw new Error("gh comment failed"); },
    claudeP: vi.fn(), release: async () => { calls.push("release"); return true; },
    runRecord: (l) => calls.push(...l),
  });
  expect(await runStage({ stage: "plan", issue: 4, deps })).toBe(1);
  expect(calls).toContain("release");
  expect(calls.some((l) => /aborted — gh comment failed/.test(l))).toBe(true);
  expect(deps.claudeP).not.toHaveBeenCalled();
});

test("I2: the agents log is truncated between context and claude", async () => {
  const calls = [];
  const deps = baseDeps({
    buildContext: async () => { calls.push("context"); return { roster: [], orchestration: "workflow", limits: {} }; },
    resetAgentsLog: async () => calls.push("reset-agents"),
    claudeP: async () => { calls.push("claude"); return { is_error: false, result: "{}" }; },
  });
  expect(await runStage({ stage: "plan", issue: 4, deps })).toBe(0);
  expect(calls).toEqual(["context", "reset-agents", "claude"]);
});

test("I4: unverified gates are declared as self-reported on implement/review, not on plan (merge is script-only and has its own gates path — see merge-stage.test.js)", async () => {
  for (const stage of ["implement", "review"]) {
    const lines = [];
    await runStage({ stage, issue: 4, deps: baseDeps({ runRecord: (l) => lines.push(...l), verifyStage: () => ({ ok: true, reasons: [], data: { decision: "approved", verdicts: [] } }) }) });
    expect(lines, stage).toContain(GATES_SELF_REPORTED);
  }
  const planLines = [];
  await runStage({ stage: "plan", issue: 4, deps: baseDeps({ runRecord: (l) => planLines.push(...l) }) });
  expect(planLines).not.toContain(GATES_SELF_REPORTED);

  const verified = [];                                   // gates가 실제로 오면 그 줄은 사라진다
  await runStage({ stage: "implement", issue: 4, deps: baseDeps({ gates: async () => ({ status: "GREEN" }), runRecord: (l) => verified.push(...l) }) });
  expect(verified).not.toContain(GATES_SELF_REPORTED);
});

// I7 + r1 SF2: 라운드 번호는 에이전트의 자기 신고가 아니라 이슈에 남은 **완료된 rework 전이** 수에서
// 온다(`reviewRounds`) — handoff 개수가 아니다. handoff는 전이보다 먼저 나가므로, 전이에서 죽은 런이
// 재작업을 한 적도 없이 K 예산을 태우고 있었다.
test("I7: the review round is counted from completed rework transitions, so K bites on real rework", async () => {
  const deps = baseDeps({
    stage: "review",
    buildContext: async () => ({ roster: ["a"], orchestration: "workflow", limits: { K: 3 } }),
    reviewRounds: async () => 3,                                        // 이미 세 번 rework으로 돌아갔다
    verifyStage: () => ({ ok: true, reasons: [], data: { round: 1, decision: "rework", verdicts: [{ role: "a", verdict: "reject", must_fix: [] }] } }),
    writeHandoff: vi.fn(async () => {}), transition: vi.fn(async ({ to }) => ({ ok: true, to })),
  });
  expect(await runStage({ stage: "review", issue: 7, deps })).toBe(0);
  expect(deps.writeHandoff).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ round: 4 }) }));
  expect(deps.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human" }));
});

test("M3: a failed prerequisite assert is written to the run record", async () => {
  const lines = [];
  const deps = baseDeps({ assertHandoff: async () => ({ ok: false, reason: "plan handoff missing" }), runRecord: (l) => lines.push(...l) });
  expect(await runStage({ stage: "implement", issue: 4, deps })).toBe(2);
  expect(lines).toContain("assert: FAIL — plan handoff missing");
});

test("M7: a failed lock release is shouted about and recorded", async () => {
  const lines = [];
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  await runStage({ stage: "plan", issue: 11, deps: baseDeps({ release: async () => false, runRecord: (l) => lines.push(...l) }) });
  expect(err).toHaveBeenCalledWith(expect.stringContaining("lock release failed for issue 11"));
  expect(lines.some((l) => /lock: release failed for issue 11/.test(l))).toBe(true);
  err.mockRestore();
});

// ── Task 14: run 기록 브랜치 factory/records — syncRecords wiring ───────────

test("syncRecords runs after release, in its own try/catch, and a success doesn't change the exit code", async () => {
  const calls = [];
  const deps = baseDeps({
    release: async () => { calls.push("release"); return true; },
    syncRecords: vi.fn(async () => { calls.push("syncRecords"); return { ok: true, commit: "a".repeat(40), retried: false }; }),
  });
  expect(await runStage({ stage: "plan", issue: 7, deps })).toBe(0);
  expect(calls).toEqual(["release", "syncRecords"]);
  expect(deps.syncRecords).toHaveBeenCalledTimes(1);
});

test("syncRecords is optional — deps without it still work", async () => {
  const deps = baseDeps({});
  expect(deps.syncRecords).toBeUndefined();
  expect(await runStage({ stage: "plan", issue: 7, deps })).toBe(0);
});

test("a failed syncRecords ({ok:false}) is shouted about and recorded, but never changes the exit code", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const lines = [];
  const deps = baseDeps({
    syncRecords: async () => ({ ok: false, reason: "push failed: non-fast-forward", retried: true }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "plan", issue: 7, deps })).toBe(0);
  expect(err).toHaveBeenCalledWith(expect.stringContaining("push failed: non-fast-forward"));
  expect(lines.some((l) => /run-record sync: failed — push failed: non-fast-forward/.test(l))).toBe(true);
  err.mockRestore();
});

test("a syncRecords that throws is swallowed by its own try/catch, recorded, and doesn't change the exit code", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const lines = [];
  const deps = baseDeps({
    syncRecords: async () => { throw new Error("git fetch failed"); },
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "plan", issue: 7, deps })).toBe(0);
  expect(err).toHaveBeenCalledWith(expect.stringContaining("git fetch failed"));
  expect(lines.some((l) => /run-record sync: aborted — git fetch failed/.test(l))).toBe(true);
  err.mockRestore();
});

test("a failed syncRecords doesn't change a non-zero exit code either (e.g. a needs-human transition)", async () => {
  const lines = [];
  const deps = baseDeps({
    verifyStage: () => ({ ok: false, reasons: ["roster role not completed: qa"], data: {} }),
    syncRecords: async () => ({ ok: false, reason: "no origin remote", retried: false }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 7, deps })).toBe(2);
  expect(lines.some((l) => /run-record sync: failed — no origin remote/.test(l))).toBe(true);
});

test("a successful syncRecords that merged a record tail says so in the run record (F6)", async () => {
  const lines = [];
  const deps = baseDeps({
    syncRecords: async () => ({ ok: true, commit: "a".repeat(40), retried: true, merged: ["docs/factory/runs/7.md"], skipped: [] }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "plan", issue: 7, deps })).toBe(0);
  expect(lines).toContain("run-record sync: merged onto the branch tip — docs/factory/runs/7.md");
});

test("a successful syncRecords that skipped a record (nothing new) says so too", async () => {
  const lines = [];
  const deps = baseDeps({
    syncRecords: async () => ({ ok: true, commit: "a".repeat(40), retried: false, skipped: ["docs/factory/runs/7.md"], merged: [] }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "plan", issue: 7, deps })).toBe(0);
  expect(lines).toContain("run-record sync: skipped (nothing new) — docs/factory/runs/7.md");
});

test("a clean syncRecords (nothing merged or skipped) adds no extra record line", async () => {
  const lines = [];
  const deps = baseDeps({
    syncRecords: async () => ({ ok: true, commit: "a".repeat(40), retried: false, skipped: [], merged: [] }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "plan", issue: 7, deps })).toBe(0);
  expect(lines.some((l) => /run-record sync/.test(l))).toBe(false);
});

test("hydrateRecord runs right after charterReady — before back-pressure, claim and localEntry (F5)", async () => {
  const calls = [];
  const deps = baseDeps({
    charterReady: async () => { calls.push("charter"); return true; },
    hydrateRecord: vi.fn(async () => { calls.push("hydrate"); return { ok: true, hydrated: true }; }),
    backPressure: async () => { calls.push("back-pressure"); return { ok: true, reasons: [] }; },
    claim: async () => { calls.push("claim"); return { ok: true }; },
    localEntry: async () => { calls.push("local-entry"); return null; },
    resetGates: async () => calls.push("reset-gates"),
  });
  expect(await runStage({ stage: "implement", issue: 7, deps, runnerId: "r" })).toBe(0);
  // 기록 하이드레이트는 back-pressure 거부나 claim 실패로 물러날 때도 이미 끝나 있어야 한다 —
  // 그래야 그 경로에서 남기는 record 줄이 브랜치의 누적 기록 위에 얹힌다.
  expect(calls.slice(0, 2)).toEqual(["charter", "hydrate"]);
  expect(calls.indexOf("hydrate")).toBeLessThan(calls.indexOf("back-pressure"));
  expect(calls.indexOf("hydrate")).toBeLessThan(calls.indexOf("claim"));
  expect(calls.indexOf("hydrate")).toBeLessThan(calls.indexOf("local-entry"));
  expect(calls.indexOf("hydrate")).toBeLessThan(calls.indexOf("reset-gates"));
  expect(deps.hydrateRecord).toHaveBeenCalledTimes(1);
});

test("hydrateRecord is not called when the charter isn't ready (the stage never starts)", async () => {
  const hydrateRecord = vi.fn(async () => ({ ok: true, hydrated: false }));
  expect(await runStage({ stage: "plan", issue: 7, deps: baseDeps({ charterReady: async () => false, hydrateRecord }) })).toBe(0);
  expect(hydrateRecord).not.toHaveBeenCalled();
});

test("hydrateRecord still runs when back-pressure refuses the stage", async () => {
  const hydrateRecord = vi.fn(async () => ({ ok: true, hydrated: true }));
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const deps = baseDeps({ backPressure: async () => ({ ok: false, reasons: ["awaiting-review 4 ≥ 4"] }), hydrateRecord, claim: vi.fn() });
  expect(await runStage({ stage: "implement", issue: 7, deps, runnerId: "r" })).toBe(0);
  expect(hydrateRecord).toHaveBeenCalledTimes(1);
  expect(deps.claim).not.toHaveBeenCalled();
  err.mockRestore();
});

test("hydrateRecord is optional — deps without it still work", async () => {
  const deps = baseDeps({});
  expect(deps.hydrateRecord).toBeUndefined();
  expect(await runStage({ stage: "plan", issue: 7, deps })).toBe(0);
});

test("a hydrateRecord failure ({ok:false}) is recorded but never changes the exit code", async () => {
  const lines = [];
  const deps = baseDeps({
    hydrateRecord: async () => ({ ok: false, hydrated: false, reason: "local record diverged from branch" }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "plan", issue: 7, deps })).toBe(0);
  expect(lines.some((l) => /hydrate: local record diverged from branch/.test(l))).toBe(true);
});

test("a hydrateRecord that throws is swallowed by its own try/catch, recorded, and doesn't change the exit code", async () => {
  const lines = [];
  const deps = baseDeps({
    hydrateRecord: async () => { throw new Error("git fetch failed"); },
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "plan", issue: 7, deps })).toBe(0);
  expect(lines.some((l) => /hydrate: aborted — git fetch failed/.test(l))).toBe(true);
});

test("localEntry runs right after claim (and after hydrateRecord), before resetGates", async () => {
  const calls = [];
  const deps = baseDeps({
    claim: async () => { calls.push("claim"); return { ok: true }; },
    localEntry: vi.fn(async () => { calls.push("local-entry"); return "local entry: backlog → factory:queue"; }),
    hydrateRecord: async () => { calls.push("hydrate"); return { ok: true }; },
    resetGates: async () => calls.push("reset-gates"),
  });
  expect(await runStage({ stage: "triage", issue: 7, deps })).toBe(0);
  expect(calls.indexOf("hydrate")).toBeLessThan(calls.indexOf("claim"));
  expect(calls.indexOf("claim")).toBeLessThan(calls.indexOf("local-entry"));
  expect(calls.indexOf("local-entry")).toBeLessThan(calls.indexOf("reset-gates"));
  expect(deps.localEntry).toHaveBeenCalledTimes(1);
});

test("localEntry is not called when claim fails", async () => {
  const localEntry = vi.fn();
  const deps = baseDeps({ claim: async () => ({ ok: false, holder: "other" }), localEntry });
  expect(await runStage({ stage: "triage", issue: 7, deps })).toBe(2);   // KTB-28: 거부는 잡 실패다
  expect(localEntry).not.toHaveBeenCalled();
});

test("localEntry is optional — deps without it still work", async () => {
  const deps = baseDeps({});
  expect(deps.localEntry).toBeUndefined();
  expect(await runStage({ stage: "triage", issue: 7, deps })).toBe(0);
});

test("localEntry's returned line is recorded", async () => {
  const lines = [];
  const deps = baseDeps({
    localEntry: async () => "local entry: backlog → factory:queue",
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "triage", issue: 7, deps })).toBe(0);
  expect(lines).toContain("local entry: backlog → factory:queue");
});

test("localEntry returning null/undefined records nothing extra", async () => {
  const lines = [];
  const deps = baseDeps({ localEntry: async () => null, runRecord: (l) => lines.push(...l) });
  expect(await runStage({ stage: "triage", issue: 7, deps })).toBe(0);
  expect(lines.some((l) => /local entry/.test(l))).toBe(false);
});

test("a localEntry that throws is swallowed (best-effort), recorded, and doesn't change the exit code", async () => {
  const lines = [];
  const deps = baseDeps({
    localEntry: async () => { throw new Error("gh label failed"); },
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "triage", issue: 7, deps })).toBe(0);
  expect(lines.some((l) => /local entry: aborted — gh label failed/.test(l))).toBe(true);
});

// ── KTB-10 I2: 진입 상태 가드 ────────────────────────────────────────────
// concurrency 그룹 하나당 GitHub은 실행 1 + 대기 1만 유지한다 — sweeper/`--remote` dispatch가 PENDING에
// 걸렸다가 **원래 런이 끝난 뒤에** 풀리면, 락은 이미 해제돼 있어 claim이 막지 못하고 스테이지가
// 통째로 다시 돈다(plan 한 번 ~$12 + 중복 handoff). 전이 그래프는 그 **뒤에야** 거부한다.

test("I2: a dispatched plan on an issue already at factory:planned exits 0 before claude -p", async () => {
  const lines = [];
  const d = baseDeps({
    issueLabels: async () => ["factory:planned", "factory:tier-standard"],
    claudeP: vi.fn(), buildContext: vi.fn(), transition: vi.fn(), writeHandoff: vi.fn(),
    release: vi.fn(async () => true), runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "plan", issue: 5, deps: d })).toBe(0);
  expect(d.claudeP).not.toHaveBeenCalled();
  expect(d.buildContext).not.toHaveBeenCalled();
  expect(d.transition).not.toHaveBeenCalled();                    // 라벨을 건드리지 않는다
  expect(d.writeHandoff).not.toHaveBeenCalled();
  expect(d.release).toHaveBeenCalled();                           // 잡았던 락은 반드시 놓는다
  // ENTRY_LABELS.plan now also lists factory:blocked (KTB-15b) — the message names both.
  expect(lines).toContain("entry state factory:planned != expected factory:ready|factory:blocked — nothing to do");
});

test("I2: `factory run merge 5 --remote` on an unrelated issue makes no needs-human transition", async () => {
  const d = baseDeps({
    issueLabels: async () => ["factory:queue"],
    assertHandoff: vi.fn(async () => ({ ok: false, reason: "review handoff missing" })),
    transition: vi.fn(), prInfo: vi.fn(),
  });
  expect(await runStage({ stage: "merge", issue: 5, deps: d })).toBe(0);
  expect(d.assertHandoff).not.toHaveBeenCalled();                 // needs-human 전이는 여기서 난다 — 거기까지 가지 않는다
  expect(d.transition).not.toHaveBeenCalled();
  expect(d.prInfo).not.toHaveBeenCalled();
});

test("I2: each stage accepts exactly its entry labels — implement takes planned and rework", async () => {
  const at = async (stage, label) => {
    const d = baseDeps({ issueLabels: async () => [label], claudeP: vi.fn(async () => ({ is_error: false, result: "{}" })), transition: async ({ to }) => ({ ok: true, to }) });
    await runStage({ stage, issue: 5, deps: d, runnerId: "r" });
    return d.claudeP.mock.calls.length > 0;
  };
  expect(await at("triage", "factory:queue")).toBe(true);
  expect(await at("plan", "factory:ready")).toBe(true);
  expect(await at("implement", "factory:planned")).toBe(true);
  expect(await at("implement", "factory:rework")).toBe(true);
  expect(await at("implement", "factory:in-progress")).toBe(false);   // 이미 돌고 있던 스테이지의 재점화는 여기서 멈춘다
  expect(await at("review", "factory:awaiting-review")).toBe(true);
  expect(await at("plan", "factory:queue")).toBe(false);
});

test("I2: the guard runs AFTER local entry — `factory run triage` on a backlog issue still works", async () => {
  let label = "backlog";
  const d = baseDeps({
    localEntry: async () => { label = "factory:queue"; return "local entry: backlog → factory:queue"; },
    issueLabels: async () => [label],
    claudeP: vi.fn(async () => ({ is_error: false, result: "{}" })),
    verifyStage: () => ({ ok: true, reasons: [], data: { disposition: "ready" } }),
    transition: async ({ to }) => ({ ok: true, to }),
  });
  expect(await runStage({ stage: "triage", issue: 5, deps: d })).toBe(0);
  expect(d.claudeP).toHaveBeenCalled();
});

/**
 * 외부 감사 2026-09-14 M13 — **이 판정은 뒤집혔다.** KTB-10의 원래 규칙은 "라벨 조회 실패는 막지
 * 않는다(가드는 비용 방어일 뿐, 안전은 전이 그래프가 쥔다)"였는데, 그 전제가 틀렸다: 조회가 실패하면
 * 이 런은 **자기가 어떤 상태에서 출발했는지 모르는 채로** claude -p를 띄우고, 그 뒤의 전이 그래프는
 * "지금 라벨"만 볼 뿐 "돌기 전에 무엇이었는가"를 복원해 주지 않는다. 곧 이미 끝난 스테이지의 재점화가
 * 조회 장애 한 번으로 그대로 통과한다(중복 handoff, plan 한 번 ~$12).
 * 모르면 멈춘다: `factory:blocked`(cause `api-error`, KTB-22와 같은 등급 — sweeper가 재시도한다).
 */
test("M13: a label lookup that throws aborts the stage as blocked/api-error before claude -p", async () => {
  const lines = [];
  const transition = vi.fn(async () => ({ ok: true, to: "factory:blocked" }));
  const d = baseDeps({
    issueLabels: async () => { throw new Error("gh issue view failed"); },
    claudeP: vi.fn(), buildContext: vi.fn(), writeHandoff: vi.fn(),
    transition, release: vi.fn(async () => true), runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "plan", issue: 5, deps: d })).toBe(2);
  expect(d.claudeP).not.toHaveBeenCalled();
  expect(d.buildContext).not.toHaveBeenCalled();
  expect(d.writeHandoff).not.toHaveBeenCalled();
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", cause: "api-error", reason: expect.stringContaining("gh issue view failed") }));
  expect(d.release).toHaveBeenCalled();                             // 잡았던 락은 반드시 놓는다
  expect(lines.some((l) => /entry state: unreadable — gh issue view failed/.test(l))).toBe(true);
});

// ── 감사 M13 (b): 같은 head로 이미 끝난 스테이지는 두 번 돌지 않는다 ────────────────

test("M13: completedForHead only sees this turn's handoffs, and only for the same head", async () => {
  const HEAD = "a".repeat(40), OTHER = "b".repeat(40);
  const handoff = (sha, stage = "review") => ({ id: 2, createdAt: "2026-09-14T01:00:00Z", body: renderHandoff({ stage, issue: 7, summary: "s", data: { schema: `factory.${stage}.v1`, issue: 7, head_sha: sha } }) });
  const to = (label) => ({ id: 1, createdAt: "2026-09-14T02:00:00Z", body: `<!-- factory-transition:v1 from=factory:x to=${label} by=script -->` });
  expect(completedForHead({ comments: [handoff(HEAD)], stage: "review", headSha: HEAD })).toMatchObject({ head: HEAD });
  expect(completedForHead({ comments: [handoff(OTHER)], stage: "review", headSha: HEAD })).toBe(null);
  expect(completedForHead({ comments: [handoff(HEAD)], stage: "implement", headSha: HEAD })).toBe(null);
  expect(completedForHead({ comments: [handoff(HEAD), to("factory:queue")], stage: "review", headSha: HEAD })).toBe(null);
  expect(completedForHead({ comments: [handoff(HEAD)], stage: "review", headSha: null })).toBe(null);
  /*
   * 재작업이 죽지 않는다: rework 전이 시점의 PR head는 아직 그대로라 이전 implement handoff의
   * head sha가 현재 head와 같다 — 진입 라벨 전이에서 창을 자르지 않으면 이 이슈는 그대로 멈춘다.
   */
  expect(completedForHead({ comments: [handoff(HEAD, "implement"), to("factory:rework")], stage: "implement", headSha: HEAD })).toBe(null);
  // 같은 차례 안의 재점화는 그대로 걸린다(전이가 handoff보다 **앞**에 있다).
  expect(completedForHead({ comments: [to("factory:rework"), handoff(HEAD, "implement")], stage: "implement", headSha: HEAD })).toMatchObject({ head: HEAD });
});

test("M13: a duplicate run exits 0 with no side effects at all", async () => {
  const lines = [];
  const d = baseDeps({
    duplicateRun: async () => ({ head: "c".repeat(40), at: "2026-09-14T01:00:00Z" }),
    claudeP: vi.fn(), buildContext: vi.fn(), transition: vi.fn(), writeHandoff: vi.fn(), comment: vi.fn(),
    localEntry: vi.fn(), issueLabels: vi.fn(), release: vi.fn(async () => true), runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 7, deps: d })).toBe(0);
  for (const fn of [d.claudeP, d.buildContext, d.transition, d.writeHandoff, d.comment, d.localEntry, d.issueLabels]) expect(fn).not.toHaveBeenCalled();
  expect(d.release).toHaveBeenCalled();                             // 락만은 놓는다
  expect(lines.some((l) => /^duplicate-run: skipped/.test(l))).toBe(true);
});

test("M13: a duplicate-run check that throws does not stop the stage — it is a cost defense", async () => {
  const lines = [];
  const d = baseDeps({
    duplicateRun: async () => { throw new Error("gh comments failed"); },
    claudeP: vi.fn(async () => ({ is_error: false, result: "{}" })), runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 7, deps: d })).toBe(0);
  expect(d.claudeP).toHaveBeenCalled();
  expect(lines.some((l) => /duplicate-run: check failed — gh comments failed/.test(l))).toBe(true);
});

test("M13: a label lookup that returns nothing at all is the same abort — absence is not permission", async () => {
  const transition = vi.fn(async () => ({ ok: true, to: "factory:blocked" }));
  for (const labels of [null, undefined, "not-an-array"]) {
    const d = baseDeps({ issueLabels: async () => labels, claudeP: vi.fn(), transition });
    expect(await runStage({ stage: "plan", issue: 5, deps: d })).toBe(2);
    expect(d.claudeP).not.toHaveBeenCalled();
  }
  expect(transition).toHaveBeenCalledTimes(3);
});

test("I2: with no issueLabels dep wired the guard is inert (existing callers unchanged)", async () => {
  const d = baseDeps({ claudeP: vi.fn(async () => ({ is_error: false, result: "{}" })) });
  expect(await runStage({ stage: "plan", issue: 5, deps: d })).toBe(0);
  expect(d.claudeP).toHaveBeenCalled();
});

// ── KTB-18: a hand-applied label leaving 2+ factory state labels must never be silent ───────────
// The probe: a human applied `factory:approved` to an issue that still carried `backlog`.
// `factoryLabelOf` correctly threw "issue must carry exactly one factory state label" — but nothing
// caught it here, so it fell all the way to `lib/transition.js`'s own (unguarded) call to the same
// function inside `d.transition`, and the whole stage died with a bare `console.error` + exit 1:
// no issue comment, no transition, and the two labels just sat there forever.

test("KTB-18: 2+ factory state labels → a comment naming them, exit 1, no transition attempted", async () => {
  const lines = [];
  const comment = vi.fn(async () => {});
  const transition = vi.fn();
  const d = baseDeps({
    issueLabels: async () => ["backlog", "factory:approved"],
    comment, transition, claudeP: vi.fn(), buildContext: vi.fn(), writeHandoff: vi.fn(),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "merge", issue: 14, deps: d })).toBe(1);
  expect(comment).toHaveBeenCalledWith(14, expect.stringContaining("<!-- factory-label-set-invalid labels=backlog,factory:approved -->"));
  expect(comment.mock.calls[0][1]).toMatch(/backlog, factory:approved/);
  expect(transition).not.toHaveBeenCalled();
  expect(d.claudeP).not.toHaveBeenCalled();
  expect(lines.some((l) => /entry state: invalid — more than one factory state label: backlog, factory:approved/.test(l))).toBe(true);
});

test("KTB-18: the invalid-label check fires for every stage, not just merge", async () => {
  for (const stage of ["triage", "plan", "implement", "review"]) {
    const comment = vi.fn(async () => {});
    const d = baseDeps({ issueLabels: async () => ["factory:ready", "factory:planned"], comment, claudeP: vi.fn() });
    expect(await runStage({ stage, issue: 1, deps: d }), stage).toBe(1);
    expect(comment, stage).toHaveBeenCalledWith(1, expect.stringContaining("factory-label-set-invalid labels=factory:ready,factory:planned"));
    expect(d.claudeP, stage).not.toHaveBeenCalled();
  }
});

test("KTB-18: a failing comment doesn't mask the refusal — still exit 1, still no transition", async () => {
  const lines = [];
  const transition = vi.fn();
  const d = baseDeps({
    issueLabels: async () => ["backlog", "factory:approved"],
    comment: vi.fn(async () => { throw new Error("gh comment 502"); }),
    transition, claudeP: vi.fn(), runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "merge", issue: 14, deps: d })).toBe(1);
  expect(transition).not.toHaveBeenCalled();
  expect(lines.some((l) => /label-set-invalid: comment failed — gh comment 502/.test(l))).toBe(true);
});

test("KTB-18: with no comment dep wired, the refusal still happens (best-effort comment, not required)", async () => {
  const d = baseDeps({ issueLabels: async () => ["backlog", "factory:approved"], claudeP: vi.fn() });
  expect(await runStage({ stage: "merge", issue: 14, deps: d })).toBe(1);
  expect(d.claudeP).not.toHaveBeenCalled();
});

// ── KTB-20: `factory:harness` 이슈의 implement는 변형 설정 + 환경 플래그로 돈다 ─────────────────
// 도그푸딩: retro가 만든 승격 이슈 #15에서 builder는 `.factory/harness.toml`·컴포즈·e2e 설정을 하나도
// 건드릴 수 없어(ci-settings.json의 `Edit/Write(.factory/**)` + block-dangerous.sh) "승격 PR"이 승격을
// 담지 못하고 전부 사람에게 미뤄졌다. 스펙 §5.2.1의 의도는 반대다 — factory가 인프라를 만들고 사람이
// 그 diff를 머지한다. merge 스테이지는 한 글자도 바뀌지 않는다(보호 경로 → needs-human → 사람 머지).

test("KTB-20: a factory:harness issue implements with ci-settings-harness.json + FACTORY_HARNESS_ISSUE=1", async () => {
  const lines = [];
  const seen = [];
  const d = baseDeps({
    issueLabels: async () => ["factory:planned", "factory:harness", "factory:tier-standard"],
    ciSettingsPresent: vi.fn(async () => true),
    claudeP: vi.fn(async (_ctx, opts) => { seen.push(opts); return { is_error: false, result: "{}" }; }),
    transition: async ({ to }) => ({ ok: true, to }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 15, deps: d })).toBe(0);
  expect(seen).toEqual([{ harnessIssue: true }]);
  expect(d.ciSettingsPresent).toHaveBeenCalledWith(true);
  expect(lines.some((l) => /harness issue: builder runs with \.factory\/ci-settings-harness\.json \+ FACTORY_HARNESS_ISSUE=1/.test(l))).toBe(true);
});

test("KTB-20: a normal issue is unchanged — base settings, no env flag", async () => {
  const lines = [];
  const seen = [];
  const d = baseDeps({
    issueLabels: async () => ["factory:planned", "factory:tier-standard"],
    ciSettingsPresent: vi.fn(async () => true),
    claudeP: vi.fn(async (_ctx, opts) => { seen.push(opts); return { is_error: false, result: "{}" }; }),
    transition: async ({ to }) => ({ ok: true, to }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 8, deps: d })).toBe(0);
  expect(seen).toEqual([{ harnessIssue: false }]);
  expect(d.ciSettingsPresent).toHaveBeenCalledWith(false);
  expect(lines.some((l) => /harness issue:/.test(l))).toBe(false);
});

test("KTB-20: the variant is implement-only — the no-write stages keep the base settings", async () => {
  for (const stage of ["triage", "plan", "review"]) {
    const seen = [];
    const entry = { triage: "factory:queue", plan: "factory:ready", review: "factory:awaiting-review" }[stage];
    const d = baseDeps({
      issueLabels: async () => [entry, "factory:harness"],
      claudeP: vi.fn(async (_ctx, opts) => { seen.push(opts); return { is_error: false, result: "{}" }; }),
      verifyStage: () => ({ ok: true, reasons: [], data: { disposition: "ready", verdict: "approve" } }),
      transition: async ({ to }) => ({ ok: true, to }),
    });
    await runStage({ stage, issue: 15, deps: d });
    expect(seen, stage).toEqual([{ harnessIssue: false }]);
  }
});

test("KTB-20: a harness issue with the variant file missing stops before claude -p — no silent fallback", async () => {
  const lines = [];
  const transition = vi.fn(async () => ({ ok: true }));
  const d = baseDeps({
    issueLabels: async () => ["factory:planned", "factory:harness"],
    ciSettingsPresent: async (harnessIssue) => !harnessIssue,      // base는 있고 변형만 없다
    claudeP: vi.fn(), transition, runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 15, deps: d })).toBe(2);
  expect(d.claudeP).not.toHaveBeenCalled();
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:needs-human", reason: expect.stringContaining(".factory/ci-settings-harness.json missing"),
  }));
  expect(lines.some((l) => /ci-settings: FAIL — \.factory\/ci-settings-harness\.json missing/.test(l))).toBe(true);
});

/**
 * KTB-20의 원래 질문은 "라벨을 못 읽었을 때 **어느 settings 파일**로 도는가"였고(더 좁은 쪽),
 * 감사 M13이 그 질문을 지웠다: 라벨을 못 읽으면 스테이지가 아예 돌지 않는다. 좁은 쪽 기본값은
 * 라벨을 **읽었지만** `factory:harness`가 없을 때의 규칙으로 그대로 남는다 — 그것이 아래 단언이다.
 */
test("KTB-20/M13: an unreadable label set never reaches claude -p at all; a read one without factory:harness takes the narrower settings", async () => {
  const seen = [];
  const unreadable = baseDeps({
    issueLabels: async () => { throw new Error("gh issue view failed"); },
    claudeP: vi.fn(), transition: async ({ to }) => ({ ok: true, to }),
  });
  expect(await runStage({ stage: "implement", issue: 15, deps: unreadable })).toBe(2);
  expect(unreadable.claudeP).not.toHaveBeenCalled();
  const d = baseDeps({
    issueLabels: async () => ["factory:planned"],
    claudeP: vi.fn(async (_ctx, opts) => { seen.push(opts); return { is_error: false, result: "{}" }; }),
    transition: async ({ to }) => ({ ok: true, to }),
  });
  expect(await runStage({ stage: "implement", issue: 15, deps: d })).toBe(0);
  expect(seen).toEqual([{ harnessIssue: false }]);
});

test("KTB-20: stageClaudeArgs/stageClaudeEnv pick the file and the env flag from the same judgement", () => {
  const base = { root: "/r", stage: "implement", issue: 15, harness: {}, charter: { budget: { usd_per_stage: 12 } } };
  const normal = stageClaudeArgs(base);
  expect(normal).toContain("/r/.factory/ci-settings.json");
  expect(normal).not.toContain("/r/.factory/ci-settings-harness.json");
  expect(stageClaudeEnv({ root: "/r" })).not.toHaveProperty("FACTORY_HARNESS_ISSUE");

  const harness = stageClaudeArgs({ ...base, harnessIssue: true });
  expect(harness).toContain("/r/.factory/ci-settings-harness.json");
  expect(harness[harness.indexOf("--settings") + 1]).toBe("/r/.factory/ci-settings-harness.json");
  // 나머지 인자는 두 자리만 달라진다 — `--settings` 값과, KTB-23 fix가 더한 `-p` 프롬프트의 두 번째
  // 위치 인자다(디스패처가 `$2`로 읽어 워크플로의 `harness_issue`가 된다).
  const normalize = (args) => args.map((a) => (/ci-settings(-harness)?\.json$/.test(a) ? "SETTINGS" : a.startsWith("/factory-") ? "PROMPT" : a));
  expect(normalize(harness)).toEqual(normalize(normal));
  expect(stageClaudeEnv({ root: "/r", harnessIssue: true }).FACTORY_HARNESS_ISSUE).toBe("1");
  expect(ciSettingsFile(true)).toBe(CI_SETTINGS_HARNESS);
  expect(ciSettingsFile(false)).toBe(CI_SETTINGS);
});

// ADR-020 KTB-23 fix — 프롬프트도 같은 판단을 받는다. 그때까지 훅(env)과 L2(`--settings`)만 하네스
// 이슈를 알았고 **프롬프트는 몰랐다**: builder는 자기가 열려 있는 파일을 "보호 경로"로 읽고
// `harness_needed`를 채운 뒤 멈췄다 — 하네스 이슈가 또 하네스 이슈를 부르는 사슬이다.
test("KTB-23 fix: the implement prompt carries the harness flag as a second positional arg", () => {
  const base = { root: "/r", stage: "implement", issue: 15, harness: {}, charter: {} };
  expect(stagePrompt({ stage: "implement", issue: 15 })).toBe("/factory-implement 15 false");
  expect(stagePrompt({ stage: "implement", issue: 15, harnessIssue: true })).toBe("/factory-implement 15 true");
  // 값은 언제나 실린다 — 빠진 `$2`는 디스패처가 만드는 args JSON을 깨뜨린다
  expect(stagePrompt({ stage: "implement", issue: 15 }).split(" ")).toHaveLength(3);
  // 다른 스테이지의 커맨드는 `$ARGUMENTS` 하나를 읽는다 — 한 글자도 바뀌지 않는다
  for (const stage of ["triage", "plan", "review", "merge"]) {
    expect(stagePrompt({ stage, issue: 15, harnessIssue: true })).toBe(`/factory-${stage} 15`);
  }
  expect(stageClaudeArgs({ ...base, harnessIssue: true })[1]).toBe("/factory-implement 15 true");
  expect(stageClaudeArgs(base)[1]).toBe("/factory-implement 15 false");
});

// ── KTB-9: tier 라벨은 triage가 붙인다(§3.2) ──────────────────────────────
// `label-catalog.js`가 `factory:tier-*` 셋을 만들어 두는데 붙이는 코드가 어디에도 없었다 —
// tier는 handoff JSON 안에만 있어서 사람이 이슈 목록에서 볼 수 없었다.

const triageDeps = (over = {}) => baseDeps({
  verifyStage: () => ({ ok: true, reasons: [], data: { disposition: "ready", tier: "load-bearing" } }),
  transition: async () => ({ ok: true, to: "factory:ready" }),
  ...over,
});

test("triage applies the tier label after the handoff verifies — and only after", async () => {
  const calls = [];
  const setTierLabel = vi.fn(async (t) => calls.push(`tier:${t}`));
  const deps = triageDeps({
    setTierLabel,
    verifyStage: () => { calls.push("verify"); return { ok: true, reasons: [], data: { disposition: "ready", tier: "load-bearing" } }; },
    writeHandoff: async () => calls.push("handoff"),
    runRecord: (l) => calls.push(...l),
  });
  expect(await runStage({ stage: "triage", issue: 7, deps })).toBe(0);
  expect(setTierLabel).toHaveBeenCalledWith("load-bearing");
  expect(calls.indexOf("verify")).toBeLessThan(calls.indexOf("tier:load-bearing"));
  expect(calls).toContain("tier: factory:tier-load-bearing");
  // 그리고 **전이보다 먼저**여야 한다(KTB-10 M2). 라벨을 붙이는 것도 `issues: labeled` 이벤트라,
  // 그 이벤트가 만드는 5개짜리 런 물결이 뒤에 오면 전이가 막 띄운 다음 스테이지의 PENDING 런을
  // concurrency 슬롯에서 밀어낸다(KTB-8 — 데모 #2가 죽은 방식이다).
  const tierAt = calls.indexOf("tier: factory:tier-load-bearing");
  const transitionAt = calls.findIndex((l) => /^transition: /.test(l));
  expect(tierAt).toBeGreaterThan(-1);
  expect(transitionAt).toBeGreaterThan(-1);
  expect(tierAt).toBeLessThan(transitionAt);
});

test("a failed verify never applies a tier label — an unverified tier is the agent's self-report", async () => {
  const setTierLabel = vi.fn();
  const deps = triageDeps({ setTierLabel, verifyStage: () => ({ ok: false, reasons: ["tier is required"], data: null }) });
  expect(await runStage({ stage: "triage", issue: 7, deps })).toBe(2);
  expect(setTierLabel).not.toHaveBeenCalled();
});

test("only triage labels the tier, and only for a tier in the catalog", async () => {
  const setTierLabel = vi.fn();
  for (const stage of ["plan", "implement", "review"]) {
    await runStage({ stage, issue: 7, deps: triageDeps({ setTierLabel }) });
  }
  expect(setTierLabel).not.toHaveBeenCalled();
  const bogus = triageDeps({ setTierLabel, verifyStage: () => ({ ok: true, reasons: [], data: { disposition: "ready", tier: "enormous" } }) });
  expect(await runStage({ stage: "triage", issue: 7, deps: bogus })).toBe(0);
  expect(setTierLabel).not.toHaveBeenCalled();
});

test("a tier label that fails to apply is recorded but never fails the stage — the handoff still carries the tier", async () => {
  const lines = [];
  const deps = triageDeps({
    setTierLabel: async () => { throw new Error("gh label boom"); },
    writeHandoff: vi.fn(async () => {}), runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "triage", issue: 7, deps })).toBe(0);
  expect(deps.writeHandoff).toHaveBeenCalled();
  expect(lines.some((l) => /tier: factory:tier-load-bearing label failed — gh label boom/.test(l))).toBe(true);
});

test("makeLocalEntry: backlog issue with no factory label → sets factory:queue, comments the transition marker, returns the record line", async () => {
  const setFactoryLabel = vi.fn(async () => {});
  const comment = vi.fn(async () => {});
  const gh = { issue: async () => ({ number: 12, title: "t", body: "", labels: ["backlog", "priority:p1"] }), setFactoryLabel, comment };
  const entry = makeLocalEntry({ gh, issue: 12, stage: "triage", env: { FACTORY_LOCAL_ENTRY: "1" }, rehearsal: async () => ({ ok: true }) });
  const line = await entry();
  expect(line).toBe("local entry: backlog → factory:queue");
  expect(setFactoryLabel).toHaveBeenCalledWith(12, "factory:queue");
  expect(comment).toHaveBeenCalledWith(12, expect.stringContaining("<!-- factory-transition:v1 from=backlog to=factory:queue by=local -->"));
  expect(comment).toHaveBeenCalledWith(12, expect.stringContaining("backlog → factory:queue — claimed locally first (§4.2.5)"));
});

test("makeLocalEntry: a stale or unwired rehearsal refuses the local entry — the label is never written (KTB-44 nf-2)", async () => {
  // 리뷰 r2 nf-2 — 여기는 `transition()`을 거치지 않는 유일한 큐 진입이었다. 그 비대칭 때문에
  // `transition.js <n> factory:queue --human`은 거부당하는데 `factory run triage <n>`은 통과했고,
  // 그 뒤의 plan·implement·review는 **러너에서** 한 번도 리허설하지 않은 하네스 위로 갔다.
  for (const rehearsal of [
    async () => ({ ok: false, reason: "harness changed since the last rehearsal — run `factory rehearse`" }),
    null,                                     // 배선 자체가 없는 경우도 통과가 아니다(fail closed)
  ]) {
    const setFactoryLabel = vi.fn(async () => {});
    const comment = vi.fn(async () => {});
    const gh = { issue: async () => ({ number: 12, title: "t", body: "", labels: ["backlog"] }), setFactoryLabel, comment };
    const line = await makeLocalEntry({ gh, issue: 12, stage: "triage", env: { FACTORY_LOCAL_ENTRY: "1" }, rehearsal })();
    expect(line).toMatch(/^local entry refused: /);
    expect(setFactoryLabel).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
  }
});

test("makeLocalEntry: the refusal carries the same sentence the human CLI gets", async () => {
  const gh = { issue: async () => ({ number: 12, title: "t", body: "", labels: ["backlog"] }), setFactoryLabel: vi.fn(), comment: vi.fn() };
  const line = await makeLocalEntry({ gh, issue: 12, stage: "triage", env: { FACTORY_LOCAL_ENTRY: "1" }, rehearsal: async () => ({ ok: false, reason: REHEARSAL_STALE }) })();
  expect(line).toContain(REHEARSAL_STALE);
});

test("makeLocalEntry: issue already carries a factory label → no-op, returns null", async () => {
  const setFactoryLabel = vi.fn(async () => {});
  const comment = vi.fn(async () => {});
  const gh = { issue: async () => ({ number: 12, title: "t", body: "", labels: ["factory:ready"] }), setFactoryLabel, comment };
  const entry = makeLocalEntry({ gh, issue: 12, stage: "triage", env: { FACTORY_LOCAL_ENTRY: "1" }, rehearsal: async () => ({ ok: true }) });
  expect(await entry()).toBeNull();
  expect(setFactoryLabel).not.toHaveBeenCalled();
  expect(comment).not.toHaveBeenCalled();
});

test("makeLocalEntry: backlog issue but no factory label and no backlog label either → no-op, returns null", async () => {
  const setFactoryLabel = vi.fn(async () => {});
  const comment = vi.fn(async () => {});
  const gh = { issue: async () => ({ number: 12, title: "t", body: "", labels: ["priority:p1"] }), setFactoryLabel, comment };
  const entry = makeLocalEntry({ gh, issue: 12, stage: "triage", env: { FACTORY_LOCAL_ENTRY: "1" }, rehearsal: async () => ({ ok: true }) });
  expect(await entry()).toBeNull();
  expect(setFactoryLabel).not.toHaveBeenCalled();
});

test("makeLocalEntry: unlabeled issue → null, no gh mutation", async () => {
  const setFactoryLabel = vi.fn(async () => {});
  const comment = vi.fn(async () => {});
  const gh = { issue: async () => ({ number: 12, title: "t", body: "", labels: [] }), setFactoryLabel, comment };
  const entry = makeLocalEntry({ gh, issue: 12, stage: "triage", env: { FACTORY_LOCAL_ENTRY: "1" }, rehearsal: async () => ({ ok: true }) });
  expect(await entry()).toBeNull();
  expect(setFactoryLabel).not.toHaveBeenCalled();
  expect(comment).not.toHaveBeenCalled();
});

test("makeLocalEntry: FACTORY_LOCAL_ENTRY unset → no-op, returns null, gh untouched", async () => {
  const setFactoryLabel = vi.fn(async () => {});
  const comment = vi.fn(async () => {});
  const gh = { issue: vi.fn(async () => ({ number: 12, title: "t", body: "", labels: ["backlog"] })), setFactoryLabel, comment };
  const entry = makeLocalEntry({ gh, issue: 12, stage: "triage", env: {}, rehearsal: async () => ({ ok: true }) });
  expect(await entry()).toBeNull();
  expect(gh.issue).not.toHaveBeenCalled();
  expect(setFactoryLabel).not.toHaveBeenCalled();
});

test("makeLocalEntry: non-triage stage → no-op, returns null, gh untouched", async () => {
  const gh = { issue: vi.fn(async () => ({ number: 12, title: "t", body: "", labels: ["backlog"] })) };
  const entry = makeLocalEntry({ gh, issue: 12, stage: "plan", env: { FACTORY_LOCAL_ENTRY: "1" } });
  expect(await entry()).toBeNull();
  expect(gh.issue).not.toHaveBeenCalled();
});

test("M4: the usage line carries num_turns, terminal_reason and per-model cost", () => {
  const line = usageLine({
    usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.42, num_turns: 4, terminal_reason: "end_turn",
    modelUsage: { "claude-opus-4-6": { costUSD: 0.4 }, "claude-haiku-4-5": { costUSD: 0.02 } },
  });
  expect(line).toContain("num_turns: 4");
  expect(line).toContain("terminal_reason: end_turn");
  expect(line).toContain("claude-opus-4-6=$0.4");
  expect(line).toContain("claude-haiku-4-5=$0.02");
  expect(usageLine(undefined)).toContain("models: n/a");               // claude가 아무것도 못 뱉어도 터지지 않는다
  expect(usageLine(undefined).split("\n")).toHaveLength(1);            // progress를 안 주면 예전 그대로 한 줄
});

/**
 * ADR-022 — 런 기록에 **에이전트별** 토큰이 남는다. 봉투의 `usage`는 "이 런이 $12를 썼다"까지만
 * 말한다: 그 돈을 어느 리뷰어가 썼는지는 진행 스냅샷에만 있고, 그게 로스터를 손볼 때의 유일한 근거다.
 * 마커는 하트비트 코멘트와 **같은 모양**이라 뷰어가 살아 있는 런과 끝난 런을 하나의 파서로 읽는다.
 */
test("the usage line carries the final progress:v1 marker, and appendRunRecord keeps it in the section", () => {
  const progress = {
    stage: "review", issue: 7, runner: "gha-1", started: "2026-09-14T10:00:00Z", updated: "2026-09-14T10:30:00Z",
    step: { phase: "R2", label: "R2:qa", since: "2026-09-14T10:25:00Z" },
    agents: [{ label: "R1:correctness", kind: "subagent", status: "done", started: "2026-09-14T10:00:00Z", ended: "2026-09-14T10:12:00Z", last_tool: "Read a.js", turns: 9, input_tokens: 120000, output_tokens: 8000, cache_read_tokens: 0, cost_usd: 0.8 }],
    totals: { turns: 9, input_tokens: 120000, output_tokens: 8000, cache_read_tokens: 0, cost_usd: 0.8 },
    files_touched: [],
  };
  const line = usageLine({ usage: { input_tokens: 10 }, total_cost_usd: 0.8, num_turns: 9, terminal_reason: "end_turn" }, progress);
  const [first, second] = line.split("\n");
  expect(first).toMatch(/^usage: /);                                   // 기존 파서(`lib/usage.js`의 USAGE_RE)는 첫 줄만 본다
  expect(parseProgressMarker(second)).toEqual(progress);

  const root = mkdtempSync(join(tmpdir(), "rs-prog-"));
  const p = appendRunRecord({ root, issue: 7, stage: "review", runnerId: "gha-1", now: "2026-09-14T10:30:00Z", lines: ["verify: ok", line] });
  const text = readFileSync(p, "utf8");
  // 같은 섹션 안이다 — parseRunRecord가 읽는 usage 줄과 마커가 한 헤더 아래 있다
  const section = text.slice(text.indexOf("## review · "));
  expect(parseProgressMarker(section).totals.input_tokens).toBe(120000);
  expect(parseRunRecord(text)[0]).toMatchObject({ stage: "review", num_turns: 9, cost_usd: 0.8 });
});

// ── C1: 커밋/PR 바인딩 ────────────────────────────────────────────────────

const implHandoff = (pr) => [{ id: 1, createdAt: "2026-09-11T00:00:00Z", body: renderHandoff({ stage: "implement", issue: 7, summary: "s", data: { pr } }) }];

test("C1: awaiting-review binds the branch head sha into ctxExtra", async () => {
  const gh = { branchHeadSha: vi.fn(async () => "a".repeat(40)), comments: vi.fn(), prHeadSha: vi.fn() };
  const x = await buildCtxExtra({ gh, issue: 7, to: "factory:awaiting-review", ctx: { roster: ["a", "b"], rounds: 3 } });
  expect(gh.branchHeadSha).toHaveBeenCalledWith("claude/fq-7");
  // K는 여기 없다(r1 SF1) — 전이 요구조건은 approve를 라운드로 막지 않는다
  expect(x).toEqual({ issue: 7, roster: ["a", "b"], expectedRounds: 3, rosterSize: 2, headSha: "a".repeat(40) });
});

test("C1: approved/merged bind the PR head sha read from the implement handoff", async () => {
  for (const to of ["factory:approved", "factory:merged"]) {
    const gh = { comments: vi.fn(async () => implHandoff(9)), prHeadSha: vi.fn(async () => "b".repeat(40)), branchHeadSha: vi.fn() };
    const x = await buildCtxExtra({ gh, issue: 7, to, ctx: { roster: ["a"] }, charter: { limits: { K: 3 } } });
    expect(gh.prHeadSha, to).toHaveBeenCalledWith(9);
    expect(x.prHeadSha, to).toBe("b".repeat(40));
    expect(gh.branchHeadSha, to).not.toHaveBeenCalled();
  }
});

/**
 * 외부 감사 2026-09-14 H1c — merge는 script-only라 `buildContext`를 거치지 않는다(ctx=null). 그래서
 * `factory:merged` 규칙에 정족수 검사를 넣어도 **잴 자가 없었다**: roster도 rosterSize도 undefined.
 * 호출자가 CHARTER에서 읽은 로스터와 K를 실어 줘야 그 규칙이 실제로 물린다.
 */
test("H1c: the merged transition carries a roster and K even with no ctx — merge has no buildContext", async () => {
  const gh = { comments: vi.fn(async () => implHandoff(9)), prHeadSha: vi.fn(async () => "b".repeat(40)), branchHeadSha: vi.fn() };
  const x = await buildCtxExtra({ gh, issue: 7, to: "factory:merged", ctx: null, reviewRoster: ["correctness", "qa"], maxRounds: 3 });
  expect(x.roster).toEqual(["correctness", "qa"]);
  expect(x.rosterSize).toBe(2);
  expect(x.maxRounds).toBe(3);

  // approved는 K를 받지 않는다(ADR-020 KTB-29 r1 SF1) — 통과하는 리뷰를 라운드로 막지 않는다.
  const gh2 = { comments: vi.fn(async () => implHandoff(9)), prHeadSha: vi.fn(async () => "b".repeat(40)), branchHeadSha: vi.fn() };
  const y = await buildCtxExtra({ gh: gh2, issue: 7, to: "factory:approved", ctx: null, reviewRoster: ["correctness"], maxRounds: 3 });
  expect(y.maxRounds).toBeUndefined();
});

test("C1: a gh failure yields no sha plus a run-record line — never a crash", async () => {
  const lines = [];
  const gh = { branchHeadSha: async () => { throw new Error("HTTP 404"); }, comments: vi.fn(), prHeadSha: vi.fn() };
  const x = await buildCtxExtra({ gh, issue: 7, to: "factory:awaiting-review", ctx: {}, charter: {}, record: (l) => lines.push(l) });
  expect(x.headSha).toBeUndefined();
  expect(lines.some((l) => /commit binding: lookup failed for factory:awaiting-review — HTTP 404/.test(l))).toBe(true);

  const noPr = [];
  const gh2 = { comments: async () => [], prHeadSha: vi.fn(), branchHeadSha: vi.fn() };
  const y = await buildCtxExtra({ gh: gh2, issue: 7, to: "factory:merged", ctx: {}, charter: {}, record: (l) => noPr.push(l) });
  expect(y.prHeadSha).toBeUndefined();
  expect(gh2.prHeadSha).not.toHaveBeenCalled();
  expect(noPr.some((l) => /no PR number/.test(l))).toBe(true);
});

// ── Plan 1b: 파일 기반 게이트 판정 · back-pressure · blocked ────────────────

/** 게이트 통합은 진짜 verifyStage로만 의미가 있다 — 스텁을 쓰면 "파일이 이긴다"를 증명하지 못한다. */
const implDeps = (over = {}) => baseDeps({
  buildContext: async () => ({ roster: [], orchestration: "workflow", limits: { K: 3 }, tier: "standard" }),
  claudeP: async () => ({ is_error: false, result: JSON.stringify({ schema: "factory.implement.v1", issue: 7, head_sha: "a".repeat(40), pr: 9, gates: { status: "GREEN", level: "full" }, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" }) }),
  verifyStage: ({ stage, out, gates }) => verifyStage({ stage, out, agentsLog: { starts: [], stops: [], completed: [], orphans: [] }, roster: [], orchestration: "workflow", gates }),
  transition: vi.fn(async ({ to }) => ({ ok: true, to })),
  ...over,
});

test("implement: gates RED → verify fails → needs-human; gates file status wins over handoff claim", async () => {
  const lines = [];
  const gates = { schema: "factory.gates.v1", level: "full", status: "RED", failing: ["unit"], passed: 3, failed: 1, skipped: [], misconfigured: [], tests: { failing: [{ id: "t::x" }], excluded: [] } };
  const d = implDeps({ gates: async () => gates, runRecord: (l) => lines.push(...l) });
  const code = await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: expect.stringMatching(/gates mismatch|gates RED/) }));
  expect(lines.some((l) => /FACTORY_GATES: .*status=RED/.test(l))).toBe(true);   // 판정 한 줄은 런 기록에 남는다
  expect(lines).not.toContain(GATES_SELF_REPORTED);
});

// ── KTB-21: 게이트 결과의 test_env_reup을 run 기록에 한 줄로 남긴다 ──────────────────────────────
test("implement: gates.test_env_reup ok/failed is recorded alongside the FACTORY_GATES verdict line", async () => {
  const lines = [];
  const gates = { schema: "factory.gates.v1", level: "full", status: "GREEN", passed: 1, failed: 0, skipped: [], misconfigured: [], tests: { excluded: [] }, test_env_reup: { ran: true, ok: true, detail: "" } };
  const d = implDeps({ gates: async () => gates, runRecord: (l) => lines.push(...l) });
  await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" });
  expect(lines).toContain("test-env: re-up ok");
});

test("implement: gates BLOCKED by a failed test-env re-up records the failure detail and skips to blocked", async () => {
  const lines = [];
  const gates = { schema: "factory.gates.v1", status: "BLOCKED", blocked_reason: "test-env re-up failed: compose: exit 1", test_env_reup: { ran: true, ok: false, detail: "compose: exit 1" } };
  const d = implDeps({ gates: async () => gates, runRecord: (l) => lines.push(...l) });
  const code = await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: "test-env re-up failed: compose: exit 1" }));
  expect(lines.some((l) => /gates: BLOCKED — test-env re-up failed: compose: exit 1/.test(l))).toBe(true);
  expect(lines).toContain("test-env: re-up failed — compose: exit 1");
});

// harness가 compose를 안 쓰면 test_env_reup이 아예 없다(reUpTestEnv가 {ran:false} 반환) — 그때는
// 이 한 줄이 붙지 않는다(기존 동작 그대로).
test("implement: no compose in the harness → no test-env note in the run record", async () => {
  const lines = [];
  const gates = { schema: "factory.gates.v1", level: "full", status: "GREEN", passed: 1, failed: 0, skipped: [], misconfigured: [], tests: { excluded: [] } };
  const d = implDeps({ gates: async () => gates, runRecord: (l) => lines.push(...l) });
  await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" });
  expect(lines.some((l) => l.startsWith("test-env:"))).toBe(false);
});

test("implement: back-pressure refusal exits 0 before claim", async () => {
  const lines = [];
  const d = baseDeps({ backPressure: async () => ({ ok: false, reasons: ["awaiting-review 4 ≥ 4"] }), claim: vi.fn(), runRecord: (l) => lines.push(...l) });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(d.claim).not.toHaveBeenCalled();
  expect(lines.some((l) => /back-pressure: refused — awaiting-review 4 ≥ 4/.test(l))).toBe(true);
});

test("merge: 선행 handoff 확인은 게이트 파일을 요구하지 않는다 (진짜 requirementFor로)", async () => {
  const v = { role: "a", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] };
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: "a".repeat(40), round: 1, verdicts: [v], orchestration: "workflow", guarantee: "verified" };
  const comments = [{ id: 1, createdAt: "2026-09-11T00:00:00Z", body: renderHandoff({ stage: "review", issue: 7, summary: "s", data: review }) }];
  const assertHandoff = vi.fn(async () => requirementFor("factory:approved")({ issue: 7, comments, prerequisite: true }));   // run-stage/main()과 같은 ctx
  const lines = [];
  const d = baseDeps({
    assertHandoff, resetGates: async () => {}, runRecord: (l) => lines.push(...l),
    defaultBranch: "main",
    prInfo: async () => ({ number: 9, state: "OPEN", mergeable: "MERGEABLE" }),
    gates: async () => ({ schema: "factory.gates.v1", status: "GREEN", head_sha: "a".repeat(40) }),
    mergeGates: async () => ({ checksGreen: true, integrityGreen: true }),
    protectedPaths: async () => ({ ok: true, files: [] }),
    policyViolations: async () => ({ ok: true, files: [] }),
    ...mergeReviewDepsFor("a".repeat(40)),                          // 감사 H1c — 머지 전 리뷰 검증(같은 커밋)
    mergePr: async () => {}, closeIssue: async () => {},
  });
  expect(await runStage({ stage: "merge", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect((await assertHandoff()).ok).toBe(true);
  expect(lines.some((l) => /assert: FAIL/.test(l))).toBe(false);
  // 반대로 전이 경로(gatesChecked)에서는 같은 handoff라도 게이트 파일을 요구한다
  expect(requirementFor("factory:approved")({ issue: 7, comments, gatesChecked: true }).reason).toMatch(/gates file missing/);
  expect(requirementFor("factory:approved")({ issue: 7, comments }).reason).toMatch(/gates not verified/);
});

test("implement: a back-pressure check that throws is recorded and the stage proceeds", async () => {
  const lines = [];
  const d = baseDeps({ backPressure: async () => { throw new Error("gh search failed"); }, claim: vi.fn(async () => ({ ok: true })), runRecord: (l) => lines.push(...l) });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(d.claim).toHaveBeenCalled();
  expect(lines.some((l) => /back-pressure: check failed — gh search failed/.test(l))).toBe(true);
});

test("implement: 지난 런의 게이트 파일은 첫 전이(in-progress)보다 먼저 지워진다", async () => {
  const calls = [];
  const d = baseDeps({
    resetGates: async () => calls.push("reset-gates"),
    transition: async ({ to }) => { calls.push(`transition:${to}`); return { ok: true, to }; },
    resetAgentsLog: async () => calls.push("reset-agents"),
  });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(calls[0]).toBe("reset-gates");
  expect(calls[1]).toBe("transition:factory:in-progress");
  expect(calls.indexOf("reset-agents")).toBeGreaterThan(1);
});

test("implement: a BLOCKED gates result ends the stage at factory:blocked without verifying", async () => {
  const lines = [];
  const gates = { schema: "factory.gates.v1", level: "full", status: "BLOCKED", blocked_reason: "cannot classify failures: worktree add failed", failing: [], passed: 0, failed: 0, skipped: [], misconfigured: [] };
  const d = implDeps({ gates: async () => gates, verifyStage: vi.fn(), writeHandoff: vi.fn(), runRecord: (l) => lines.push(...l) });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: expect.stringMatching(/worktree add failed/) }));
  expect(d.verifyStage).not.toHaveBeenCalled();
  expect(d.writeHandoff).not.toHaveBeenCalled();
  expect(lines.some((l) => /FACTORY_GATES: .*status=BLOCKED/.test(l))).toBe(true);
});

test("merge gates: checks + integrity are measured, and a failed lookup leaves the flag unset (fail closed)", async () => {
  const lines = [];
  const HEAD = "f".repeat(40);
  // rev-parse는 로컬 HEAD를, 나머지 git 호출(diff)은 "변경 없음"을 돌려준다 → integrity ok
  const runner = async (cmd, a) => ({ code: 0, stdout: a[0] === "rev-parse" ? HEAD + "\n" : "", stderr: "" });
  const harness = { protected: {}, test: {} };
  const args = { root: "/x", harness, base: "b".repeat(40), readFile: () => "", runner, record: (l) => lines.push(l) };

  const gh = { prChecks: vi.fn(async () => [{ name: "ci", state: "SUCCESS", bucket: "pass" }]) };
  expect(await mergeGates({ ...args, gh, pr: 9, prHeadSha: HEAD })).toEqual({ checksGreen: true, integrityGreen: true });
  expect(gh.prChecks).toHaveBeenCalledWith(9);

  const noPr = await mergeGates({ ...args, gh, pr: null, prHeadSha: HEAD });
  expect(noPr.checksGreen).toBeUndefined();                                         // 확인 못 했으면 GREEN이라고 말하지 않는다
  expect(lines.some((l) => /no PR number/.test(l))).toBe(true);

  const boom = await mergeGates({ ...args, gh: { prChecks: async () => { throw new Error("HTTP 404"); } }, pr: 9, prHeadSha: HEAD });
  expect(boom.checksGreen).toBeUndefined();
  expect(boom.integrityGreen).toBe(true);
  expect(lines.some((l) => /gh pr checks failed — HTTP 404/.test(l))).toBe(true);
});

test("merge gates: integrity는 PR head에서 잰 것만 인정한다 — 로컬 HEAD가 다르면 false", async () => {
  const lines = [];
  const runner = vi.fn(async (cmd, a) => ({ code: 0, stdout: a[0] === "rev-parse" ? "1".repeat(40) : "", stderr: "" }));
  const gh = { prChecks: async () => [{ name: "ci", bucket: "pass" }] };
  const args = { root: "/x", harness: { protected: {}, test: {} }, base: "b".repeat(40), readFile: () => "", runner, record: (l) => lines.push(l), gh, pr: 9 };

  const drifted = await mergeGates({ ...args, prHeadSha: "2".repeat(40) });
  expect(drifted.integrityGreen).toBe(false);
  expect(lines.some((l) => /integrity: local HEAD != PR head/.test(l))).toBe(true);
  expect(runner.mock.calls.some((c) => c[1][0] === "diff")).toBe(false);            // 다른 트리를 검사하지도 않는다

  const unknown = await mergeGates({ ...args, prHeadSha: undefined });              // PR head를 못 알아냈으면 확인 안 된 것이다
  expect(unknown.integrityGreen).toBe(false);
});

test("merge gates: required_checks filters which checks matter — an optional failing check doesn't block, a missing required one does", async () => {
  const HEAD = "f".repeat(40);
  const runner = async (cmd, a) => ({ code: 0, stdout: a[0] === "rev-parse" ? HEAD + "\n" : "", stderr: "" });
  const harness = { protected: {}, test: {} };
  const args = { root: "/x", harness, base: "b".repeat(40), readFile: () => "", runner, record: () => {}, pr: 9, prHeadSha: HEAD };
  const required = ["factory/gates", "factory/review", "factory/integrity"];

  // 필수 체크는 모두 통과, 옵션 체크(lint)는 실패해도 checksGreen: true
  const ghPass = { prChecks: async () => [
    { name: "factory/gates", bucket: "pass" }, { name: "factory/review", bucket: "pass" }, { name: "factory/integrity", bucket: "pass" }, { name: "lint", bucket: "fail" },
  ] };
  expect((await mergeGates({ ...args, gh: ghPass, required })).checksGreen).toBe(true);

  // 필수 체크 하나가 아예 없으면 false
  const ghMissing = { prChecks: async () => [{ name: "factory/gates", bucket: "pass" }, { name: "factory/review", bucket: "pass" }] };
  expect((await mergeGates({ ...args, gh: ghMissing, required })).checksGreen).toBe(false);
});

// ── F1 / F5 / C1: 판정 불가·지난 런의 잔재·is_error ─────────────────────────

test("F1: merge-base를 못 구하면 스테이지는 판정 없이 factory:blocked로 끝난다", async () => {
  const lines = [];
  const d = implDeps({
    gates: vi.fn(async () => { throw new MergeBaseError("origin/main: exit 128 fatal: no merge base"); }),
    verifyStage: vi.fn(), writeHandoff: vi.fn(), runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: MERGE_BASE_BLOCKED_REASON }));
  expect(d.verifyStage).not.toHaveBeenCalled();
  expect(d.writeHandoff).not.toHaveBeenCalled();
  expect(lines.some((l) => /gates: BLOCKED — cannot compute merge-base/.test(l))).toBe(true);
});

test("F2: git diff를 못 구하면(GitDiffError) merge-base와 같은 방식으로 factory:blocked로 끝난다", async () => {
  const lines = [];
  const d = implDeps({
    gates: vi.fn(async () => { throw new GitDiffError("fatal: bad revision"); }),
    verifyStage: vi.fn(), writeHandoff: vi.fn(), runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: GIT_DIFF_BLOCKED_REASON }));
  expect(d.verifyStage).not.toHaveBeenCalled();
  expect(d.writeHandoff).not.toHaveBeenCalled();
  expect(lines.some((l) => /gates: BLOCKED — git diff failed/.test(l))).toBe(true);
});

test("F1: merge-base가 아닌 예외는 그대로 올라가 exit 1이 된다 — blocked로 덮지 않는다", async () => {
  const lines = [];
  const d = implDeps({ gates: async () => { throw new Error("gh exploded"); }, runRecord: (l) => lines.push(...l) });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(1);
  expect(d.transition).not.toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked" }));
  expect(lines.some((l) => /aborted — gh exploded/.test(l))).toBe(true);
});

test("C1: claude -p가 is_error면 게이트를 돌리지 않고 곧장 verify로 간다", async () => {
  const d = implDeps({
    claudeP: async () => ({ is_error: true, result: "boom" }),
    gates: vi.fn(async () => ({ status: "GREEN" })),
  });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(2);
  expect(d.gates).not.toHaveBeenCalled();
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: expect.stringMatching(/is_error/) }));
});

// ── KTB-16: `--max-turns`는 하네스가 정하고, 턴 한도는 needs-human이 아니라 blocked다 ─────────
// 데모 #2의 plan 재실행은 6턴째에 잘렸다 — 30분·$12.05가 산출물 없이 증발했고, 이슈에 남은 사유는
// "no JSON object in result"(증상)라 사람이 프롬프트를 의심하게 만들었다. 진짜 원인은 턴 한도다.

test("KTB-16: --max-turns는 [factory].max_turns에서 오고, 스테이지별 표가 그것을 이긴다", () => {
  expect(DEFAULT_MAX_TURNS).toBe(12);
  expect(stageMaxTurns(undefined, "plan")).toBe(12);                       // 하네스가 없으면 기본값
  expect(stageMaxTurns({ factory: {} }, "plan")).toBe(12);
  expect(stageMaxTurns({ factory: { max_turns: 20 } }, "plan")).toBe(20);
  expect(stageMaxTurns({ factory: { max_turns: 20, max_turns_by_stage: { plan: 30 } } }, "plan")).toBe(30);
  expect(stageMaxTurns({ factory: { max_turns: 20, max_turns_by_stage: { plan: 30 } } }, "review")).toBe(20);
  // 오타(문자열·0·소수)는 조용히 쓰지 않는다 — 기본값으로 떨어지고 doctor가 그 오타를 FAIL로 잡는다.
  expect(stageMaxTurns({ factory: { max_turns: "8" } }, "plan")).toBe(12);
  expect(stageMaxTurns({ factory: { max_turns: 0 } }, "plan")).toBe(12);
});

test("KTB-16: terminal_reason max_turns면 사유가 턴 한도를 말하고 등급은 blocked다 (needs-human 아님)", async () => {
  const lines = [];
  const d = implDeps({
    claudeP: async () => ({ is_error: true, subtype: "error_max_turns", terminal_reason: "max_turns", num_turns: 6, result: "" }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: expect.stringMatching(/claude -p hit max turns \(6\)/) }));
  expect(d.transition).not.toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human" }));
  expect(lines).toContain("- claude -p hit max turns (6)");
  expect(lines).not.toContain("- claude -p reported is_error");
});

test("KTB-16: subtype만 error_max_turns여도 같은 등급이다 (CLI 버전에 따라 한쪽만 온다)", async () => {
  const d = implDeps({ claudeP: async () => ({ is_error: true, subtype: "error_max_turns", num_turns: 9, result: "" }) });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: expect.stringMatching(/hit max turns \(9\)/) }));
});

/**
 * KTB-16 + KTB-17이 함께 닫는 그 케이스 — **데모 #2 그 자체**: 봉투는 `is_error` + `max_turns`인데
 * 워크플로는 이미 끝났고 산출물은 트랜스크립트 안에 있다. 그러면 이 런은 성공이다.
 * 게이트도 돌아야 한다 — 건너뛰면 복구한 산출물이 "gates file missing"으로 되떨어진다.
 */
test("KTB-16/17: max_turns 봉투라도 트랜스크립트에서 산출물을 복구하면 verify ok — 게이트도 돈다", async () => {
  const impl = { schema: "factory.implement.v1", issue: 7, head_sha: "a".repeat(40), pr: 9, gates: { status: "GREEN", level: "full" }, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" };
  const transcript = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Workflow", id: "w1" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "Workflow launched in background. Task ID: abc" }] } }),
    JSON.stringify({ type: "user", message: { content: `<task-notification>\n<status>completed</status>\n<result>${JSON.stringify(impl)}</result>\n</task-notification>` } }),
  ].join("\n");
  const gatesFile = { schema: "factory.gates.v1", level: "full", status: "GREEN", head_sha: "a".repeat(40), passed: 3, failed: 0, skipped: [], misconfigured: [], tests: { excluded: [] } };
  const lines = [];
  const d = implDeps({
    claudeP: async () => ({ is_error: true, subtype: "error_max_turns", terminal_reason: "max_turns", num_turns: 6, result: "I ran out of turns." }),
    gates: vi.fn(async () => gatesFile),
    verifyStage: ({ stage, out, gates }) => verifyStage({ stage, out, transcriptText: transcript, agentsLog: { starts: [], stops: [], completed: [], orphans: [] }, roster: [], orchestration: "workflow", gates }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(d.gates).toHaveBeenCalled();
  expect(lines).toContain("verify: ok");
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:awaiting-review" }));
});

// ── KTB-22: claude -p 자신의 API 쿼터/장애도 max_turns와 같은 자리(factory:blocked)다 ───────────
// 2026-09-12 20:20Z 데모: 구현 둘·계획 하나가 동시에 429(조직 월 지출 한도)로 죽었다.

test("KTB-22: a 429 quota envelope with no artifact ends the stage at factory:blocked with the provider message, not needs-human", async () => {
  const lines = [];
  const d = implDeps({
    claudeP: async () => ({ is_error: true, subtype: "success", terminal_reason: "api_error", api_error_status: 429, num_turns: 1, duration_ms: 299, result: "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/admin-settings/usage · your session limit resets 8:30pm (UTC)" }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: expect.stringContaining("claude -p api error 429: You've hit your org's monthly spend limit") }));
  expect(d.transition).not.toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human" }));
  expect(lines.some((l) => l.startsWith("- claude -p api error 429:"))).toBe(true);
  expect(lines).not.toContain("- claude -p reported is_error");
});

test("KTB-22: an api-error envelope recovered from the transcript is a pass — gates still run", async () => {
  const impl = { schema: "factory.implement.v1", issue: 7, head_sha: "a".repeat(40), pr: 9, gates: { status: "GREEN", level: "full" }, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" };
  const transcript = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Workflow", id: "w1" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "Workflow launched in background. Task ID: abc" }] } }),
    JSON.stringify({ type: "user", message: { content: `<task-notification>\n<status>completed</status>\n<result>${JSON.stringify(impl)}</result>\n</task-notification>` } }),
  ].join("\n");
  const gatesFile = { schema: "factory.gates.v1", level: "full", status: "GREEN", head_sha: "a".repeat(40), passed: 3, failed: 0, skipped: [], misconfigured: [], tests: { excluded: [] } };
  const lines = [];
  const d = implDeps({
    claudeP: async () => ({ is_error: true, terminal_reason: "api_error", api_error_status: 429, num_turns: 1, result: "monthly spend limit" }),
    gates: vi.fn(async () => gatesFile),
    verifyStage: ({ stage, out, gates }) => verifyStage({ stage, out, transcriptText: transcript, agentsLog: { starts: [], stops: [], completed: [], orphans: [] }, roster: [], orchestration: "workflow", gates }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(d.gates).toHaveBeenCalled();
  expect(lines).toContain("verify: ok");
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:awaiting-review" }));
});

// ── KTB-22 r1: 비일시적 4xx(400/401/403/404/422)는 blocked이 아니라 needs-human이다 ─────────────
// 자격증명/설정 문제는 재시도로 안 풀린다 — 사람이 고쳐야 다음 시도가 다르다. 408/425/429와 5xx는
// 여전히 blocked(sweeper의 ≤3회 재시도) 그대로다. 레코드에는 두 등급 다 프로바이더 메시지를 싣는다.

test("KTB-22 r1: a 401 (bad credentials) api-error envelope ends the stage at factory:needs-human, carrying the provider message", async () => {
  const lines = [];
  const d = implDeps({
    claudeP: async () => ({ is_error: true, terminal_reason: "api_error", api_error_status: 401, num_turns: 1, duration_ms: 250, result: "Authentication failed: invalid API key" }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: expect.stringContaining("claude -p api error 401: Authentication failed: invalid API key") }));
  expect(d.transition).not.toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked" }));
  expect(lines.some((l) => l.startsWith("- claude -p api error 401:"))).toBe(true);
});

test("KTB-22 r1: 429 and 503 api-error envelopes still end the stage at factory:blocked (transient)", async () => {
  for (const status of [429, 503]) {
    const d = implDeps({
      claudeP: async () => ({ is_error: true, terminal_reason: "api_error", api_error_status: status, num_turns: 1, duration_ms: 250, result: `provider error ${status}` }),
    });
    expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(2);
    expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: expect.stringContaining(`claude -p api error ${status}: provider error ${status}`) }));
    expect(d.transition).not.toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human" }));
  }
});

test("F5: resetGates는 판정 파일뿐 아니라 그 재료(테스트·커버리지·mutation 리포트)까지 지운다", () => {
  const root = mkdtempSync(join(tmpdir(), "reset-gates-"));
  const harness = {
    test: { unit_report: ".factory/out/unit.json", e2e_report: "reports/e2e.json" },      // integration_report는 기본값
    commands: { proof: { coverage_report: ".factory/out/coverage/coverage-final.json", mutation_report: "/etc/passwd" } },
  };
  const files = [".factory/out/gates.json", ".factory/out/unit.json", ".factory/out/integration.json", "reports/e2e.json", ".factory/out/coverage/coverage-final.json", "keep.json"];
  for (const f of files) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), "{}"); }

  const deleted = resetGateOutputs({ root, harness });
  for (const f of files.slice(0, -1)) expect(existsSync(join(root, f)), f).toBe(false);
  expect(existsSync(join(root, "keep.json"))).toBe(true);
  // 레포 밖(절대 경로) 리포트는 목록에도 오르지 않는다 — 남의 파일을 지우지 않는다
  expect(deleted.some((p) => p === "/etc/passwd")).toBe(false);
  expect(gateOutputPaths({ root, harness: {} })).toEqual([
    join(root, ".factory/out/gates.json"), join(root, ".factory/out/unit.json"),
    join(root, ".factory/out/integration.json"), join(root, ".factory/out/e2e.json"),
  ]);
});

test("C1: states with no commit binding get the plain ctxExtra and make no gh calls", async () => {
  const gh = { branchHeadSha: vi.fn(), comments: vi.fn(), prHeadSha: vi.fn() };
  const x = await buildCtxExtra({ gh, issue: 7, to: "factory:in-progress", ctx: { roster: ["a"] } });
  expect(x).toEqual({ issue: 7, roster: ["a"], expectedRounds: undefined, rosterSize: 1 });
  expect(gh.branchHeadSha).not.toHaveBeenCalled();
  expect(gh.comments).not.toHaveBeenCalled();
});

// ── Task 11: 체크 상태 게시 (factory/gates, factory/review) ─────────────────

test("status posting: implement GREEN → factory/gates success exactly once with the gates head_sha", async () => {
  const reportStatus = vi.fn(async () => {});
  const gates = { schema: "factory.gates.v1", level: "full", status: "GREEN", head_sha: "a".repeat(40), passed: 3, failed: 0, skipped: [], misconfigured: [], tests: { excluded: [] } };
  const d = implDeps({ gates: async () => gates, reportStatus });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(reportStatus).toHaveBeenCalledTimes(1);
  expect(reportStatus).toHaveBeenCalledWith(expect.objectContaining({ context: "factory/gates", state: "success", sha: "a".repeat(40) }));
});

test("status posting: review approved posts factory/gates and factory/review success", async () => {
  const reportStatus = vi.fn(async () => {});
  const gates = { schema: "factory.gates.v1", level: "full", status: "GREEN", head_sha: "b".repeat(40), passed: 1, failed: 0, skipped: [], misconfigured: [], tests: { excluded: [] } };
  const verdict = (role, kind) => ({ role, verdict: kind, confidence: "high", must_fix: [], should_fix: [], verified: [] });
  const d = baseDeps({
    buildContext: async () => ({ roster: ["correctness", "qa"], orchestration: "workflow", limits: { K: 3 } }),
    checkoutHead: async () => ({ ok: true, sha: "b".repeat(40), pr: 9 }),
    gates: async () => gates,
    verifyStage: () => ({ ok: true, reasons: [], data: { round: 1, head_sha: "b".repeat(40), verdicts: [verdict("correctness", "approve"), verdict("qa", "approve")] } }),
    writeHandoff: vi.fn(async () => {}), transition: vi.fn(async () => ({ ok: true })),
    reportStatus,
  });
  expect(await runStage({ stage: "review", issue: 7, deps: d })).toBe(0);
  expect(reportStatus).toHaveBeenCalledWith(expect.objectContaining({ context: "factory/gates", state: "success", sha: "b".repeat(40) }));
  expect(reportStatus).toHaveBeenCalledWith(expect.objectContaining({ context: "factory/review", state: "success", sha: "b".repeat(40), description: expect.stringContaining("review round 1: approved (2/2 approve)") }));
});

test("status posting: review rework posts factory/review failure (no gates file → no factory/gates post)", async () => {
  const reportStatus = vi.fn(async () => {});
  const verdict = (role, kind) => ({ role, verdict: kind, confidence: "high", must_fix: kind === "reject" ? [{ id: "MF1", where: "a.js:1", claim: "broken", evidence: "test fails" }] : [], should_fix: [], verified: [] });
  const d = baseDeps({
    buildContext: async () => ({ roster: ["correctness", "qa"], orchestration: "workflow", limits: { K: 3 } }),
    checkoutHead: async () => ({ ok: true, sha: "c".repeat(40), pr: 9 }),
    verifyStage: () => ({ ok: true, reasons: [], data: { round: 2, head_sha: "c".repeat(40), verdicts: [verdict("correctness", "reject"), verdict("qa", "approve")] } }),
    writeHandoff: vi.fn(async () => {}), transition: vi.fn(async () => ({ ok: true })),
    reportStatus,
  });
  expect(await runStage({ stage: "review", issue: 7, deps: d })).toBe(0);
  expect(reportStatus).toHaveBeenCalledWith(expect.objectContaining({ context: "factory/review", state: "failure", sha: "c".repeat(40), description: expect.stringContaining("review round 2: rework (1/2 approve)") }));
  expect(reportStatus).not.toHaveBeenCalledWith(expect.objectContaining({ context: "factory/gates" }));
});

test("status posting: a reportStatus throw is recorded but the run continues", async () => {
  const reportStatus = vi.fn(async () => { throw new Error("network down"); });
  const gates = { schema: "factory.gates.v1", level: "full", status: "GREEN", head_sha: "d".repeat(40), passed: 1, failed: 0, skipped: [], misconfigured: [], tests: { excluded: [] } };
  const lines = [];
  const d = implDeps({ gates: async () => gates, reportStatus, runRecord: (l) => lines.push(...l) });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(lines.some((l) => /status: factory\/gates post failed — network down/.test(l))).toBe(true);
});

test("status posting: plan stage posts nothing", async () => {
  const reportStatus = vi.fn(async () => {});
  await runStage({ stage: "plan", issue: 4, deps: baseDeps({ reportStatus }) });
  expect(reportStatus).not.toHaveBeenCalled();
});

test("status posting: gates RED → factory/gates failure", async () => {
  const reportStatus = vi.fn(async () => {});
  const gates = { schema: "factory.gates.v1", level: "full", status: "RED", head_sha: "e".repeat(40), failing: ["unit"], passed: 3, failed: 1, skipped: [], misconfigured: [], tests: { failing: [{ id: "t::x" }], excluded: [] } };
  const d = implDeps({ gates: async () => gates, reportStatus });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(2);
  expect(reportStatus).toHaveBeenCalledWith(expect.objectContaining({ context: "factory/gates", state: "failure", sha: "e".repeat(40) }));
});

// ── fix round 1 ──────────────────────────────────────────────────────────

test("status posting: a diagnostic gates file (bin/gates.js local run) is never published as a status", async () => {
  const reportStatus = vi.fn(async () => {});
  const gates = { schema: "factory.gates.v1", level: "full", status: "GREEN", head_sha: "f".repeat(40), diagnostic: true, passed: 1, failed: 0, skipped: [], misconfigured: [], tests: { excluded: [] } };
  const d = implDeps({ gates: async () => gates, reportStatus });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(2);   // real verifyStage also rejects diagnostic gates
  expect(reportStatus).not.toHaveBeenCalled();
});

test("status posting: incomplete review counts against the full roster, and posts before the needs-human transition", async () => {
  const calls = [];
  const reportStatus = vi.fn(async (s) => { calls.push(`report:${s.context}`); });
  const transition = vi.fn(async ({ to }) => { calls.push(`transition:${to}`); return { ok: true, to }; });
  const verdict = (role, kind) => ({ role, verdict: kind, confidence: "high", must_fix: [], should_fix: [], verified: [] });
  const d = baseDeps({
    buildContext: async () => ({ roster: ["correctness", "qa", "security"], orchestration: "workflow", limits: { K: 3 } }),
    checkoutHead: async () => ({ ok: true, sha: "g".repeat(40), pr: 9 }),
    verifyStage: () => ({ ok: true, reasons: [], data: { round: 1, head_sha: "g".repeat(40), verdicts: [verdict("correctness", "approve")] } }),
    writeHandoff: vi.fn(async () => {}), transition, reportStatus,
  });
  expect(await runStage({ stage: "review", issue: 7, deps: d })).toBe(2);
  expect(reportStatus).toHaveBeenCalledWith(expect.objectContaining({
    context: "factory/review", state: "error", sha: "g".repeat(40), description: expect.stringContaining("review round 1: incomplete (1/3 approve)"),
  }));
  expect(calls.indexOf("report:factory/review")).toBeGreaterThanOrEqual(0);
  expect(calls.indexOf("report:factory/review")).toBeLessThan(calls.indexOf("transition:factory:needs-human"));
});

test("status posting: a missing sha skips the post and leaves a record line", async () => {
  const reportStatus = vi.fn(async () => {});
  const lines = [];
  const gates = { schema: "factory.gates.v1", level: "full", status: "GREEN", passed: 1, failed: 0, skipped: [], misconfigured: [], tests: { excluded: [] } };   // no head_sha
  const d = implDeps({ gates: async () => gates, reportStatus, runRecord: (l) => lines.push(...l) });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(reportStatus).not.toHaveBeenCalled();
  expect(lines.some((l) => /status: factory\/gates skipped — no sha/.test(l))).toBe(true);
});

// ── fix round 2 (F4): factory/review is posted at the *verified* head, never at an agent-chosen sha ──

const reviewVerdict = (role, kind) => ({ role, verdict: kind, confidence: "high", must_fix: [], should_fix: [], verified: [] });

test("status posting: factory/review is posted at checkoutSha (the verified PR head), not at the handoff's own head_sha field", async () => {
  const reportStatus = vi.fn(async () => {});
  const sha = "1".repeat(40);
  const d = baseDeps({
    buildContext: async () => ({ roster: ["correctness", "qa"], orchestration: "workflow", limits: { K: 3 } }),
    checkoutHead: async () => ({ ok: true, sha, pr: 9 }),
    verifyStage: () => ({ ok: true, reasons: [], data: { round: 1, head_sha: sha, verdicts: [reviewVerdict("correctness", "approve"), reviewVerdict("qa", "approve")] } }),
    reportStatus,
  });
  expect(await runStage({ stage: "review", issue: 7, deps: d })).toBe(0);
  expect(reportStatus).toHaveBeenCalledWith(expect.objectContaining({ context: "factory/review", state: "success", sha }));
});

test("status posting: a handoff head_sha that differs from the checked-out head posts NO factory/review status and is recorded", async () => {
  const reportStatus = vi.fn(async () => {});
  const lines = [];
  const d = baseDeps({
    buildContext: async () => ({ roster: ["correctness", "qa"], orchestration: "workflow", limits: { K: 3 } }),
    checkoutHead: async () => ({ ok: true, sha: "1".repeat(40), pr: 9 }),
    verifyStage: () => ({ ok: true, reasons: [], data: { round: 1, head_sha: "2".repeat(40), verdicts: [reviewVerdict("correctness", "approve"), reviewVerdict("qa", "approve")] } }),
    reportStatus, runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 7, deps: d })).toBe(0);
  expect(reportStatus).not.toHaveBeenCalledWith(expect.objectContaining({ context: "factory/review" }));
  expect(lines).toContain("status: factory/review skipped — handoff head_sha differs from checked-out head");
});

test("status posting: an incomplete review with a drifted head_sha also posts nothing and is recorded", async () => {
  const reportStatus = vi.fn(async () => {});
  const lines = [];
  const d = baseDeps({
    buildContext: async () => ({ roster: ["correctness", "qa"], orchestration: "workflow", limits: { K: 3 } }),
    checkoutHead: async () => ({ ok: true, sha: "1".repeat(40), pr: 9 }),
    verifyStage: () => ({ ok: true, reasons: [], data: { round: 1, head_sha: "3".repeat(40), verdicts: [reviewVerdict("correctness", "approve")] } }),
    reportStatus, runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 7, deps: d })).toBe(2);
  expect(reportStatus).not.toHaveBeenCalledWith(expect.objectContaining({ context: "factory/review" }));
  expect(lines).toContain("status: factory/review skipped — handoff head_sha differs from checked-out head");
});

// ── Task 12: review·merge — PR head checkout (R6) ───────────────────────────

const checkoutBaseDeps = (over = {}) => baseDeps({
  buildContext: async () => { return { roster: [], orchestration: "workflow", limits: { K: 3 } }; },
  ...over,
});

/**
 * 외부 감사 2026-09-14 H1c/H1b — 주어진 커밋에 대한 "통과한 리뷰"의 재료 한 벌. merge 스테이지는
 * 이제 `mergePr` 전에 이것들을 전부 묻는다(§merge-stage (6b)).
 */
const mergeReviewDepsFor = (sha) => ({
  reviewEvidence: async () => ({ ok: true, data: { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 1, verdicts: [{ role: "correctness", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] }], orchestration: "workflow", guarantee: "verified" } }),
  reviewRoster: async () => ({ ok: true, roles: ["correctness"] }),
  // 리뷰 batch-1 MF-2 — handoff의 출처: 러너가 factory/records의 run 기록에 쓴 review-evidence 줄.
  // 리뷰 batch-2 MF-2 — 그 줄은 런을 지목하고(`runId`), 기대값은 이슈의 review 하트비트에서 따로 온다.
  reviewRunId: async () => ({ ok: true, runId: "4242", runnerId: "gha-4242" }),
  reviewRecord: async () => ({ ok: true, record: { stage: "review", runId: "4242", runnerId: "gha-4242", headSha: sha, round: 1, decision: "approved", verdicts: "correctness=approve" } }),
  maxRounds: 3,
  prHeadShaLive: async () => sha,
  factoryLogins: async () => ({ ok: true, logins: ["factory-bot"] }),
  commitStatuses: async () => [
    { context: "factory/review", state: "success", creatorLogin: "factory-bot" },
    { context: "factory/gates", state: "success", creatorLogin: "factory-bot" },
  ],
});

/** merge는 checkoutBaseDeps 위에 runMergeStage의 7단계 deps(happy path)를 얹는다. */
const mergeHappyDeps = (over = {}) => {
  /**
   * 외부 감사 2026-09-14 H1c/H1b — 머지 직전 리뷰 검증(§merge-stage (6b))의 재료. 이 런이 **실제로
   * 체크아웃한 sha**를 그대로 따라간다: 테스트마다 checkoutHead가 다른 sha를 주는데, 리뷰 증거가
   * 그 커밋의 것이 아니면 "PR head가 움직였다"로 떨어지는 것이 (이제) 올바른 동작이기 때문이다.
   */
  let live = "b".repeat(40);
  const deps = checkoutBaseDeps({
    defaultBranch: "main",
    prInfo: async () => ({ number: 9, state: "OPEN", mergeable: "MERGEABLE" }),
    gates: async () => ({ schema: "factory.gates.v1", status: "GREEN", head_sha: "b".repeat(40) }),
    mergeGates: async () => ({ checksGreen: true, integrityGreen: true }),
    protectedPaths: async () => ({ ok: true, files: [] }),          // KTB-5: 보호 경로 없음 = 자동 머지 가능
    policyViolations: async () => ({ ok: true, files: [] }),        // KTB-6: 역할 섹션 규칙도 통과
    mergePr: async () => {}, closeIssue: async () => {},
    reviewEvidence: async () => ({ ok: true, data: { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: live, round: 1, verdicts: [{ role: "correctness", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] }], orchestration: "workflow", guarantee: "verified" } }),
    reviewRoster: async () => ({ ok: true, roles: ["correctness"] }),
    reviewRunId: async () => ({ ok: true, runId: "4242", runnerId: "gha-4242" }),
    reviewRecord: async () => ({ ok: true, record: { stage: "review", runId: "4242", runnerId: "gha-4242", headSha: live, round: 1, decision: "approved", verdicts: "correctness=approve" } }),
    maxRounds: 3,
    prHeadShaLive: async () => live,
    factoryLogins: async () => ({ ok: true, logins: ["factory-bot"] }),
    commitStatuses: async () => [
      { context: "factory/review", state: "success", creatorLogin: "factory-bot" },
      { context: "factory/gates", state: "success", creatorLogin: "factory-bot" },
    ],
    ...over,
  });
  // checkoutHead가 아예 없는 배선(옛 테스트)은 그대로 둔다 — 없으면 runStage가 체크아웃을 건너뛴다.
  const base = deps.checkoutHead;
  if (base) {
    deps.checkoutHead = async (...args) => {
      const r = await base(...args);
      if (r?.ok && r.sha) live = r.sha;
      return r;
    };
  }
  return deps;
};

test("review: checkoutHead is called right after assertHandoff, before buildContext/gates", async () => {
  const calls = [];
  const d = checkoutBaseDeps({
    assertHandoff: async () => { calls.push("assert"); return { ok: true }; },
    checkoutHead: vi.fn(async () => { calls.push("checkout"); return { ok: true, sha: "a".repeat(40), pr: 9 }; }),
    buildContext: async () => { calls.push("context"); return { roster: [], orchestration: "workflow", limits: { K: 3 } }; },
    gates: async () => { calls.push("gates"); return null; },
  });
  expect(await runStage({ stage: "review", issue: 7, deps: d })).toBe(0);
  expect(d.checkoutHead).toHaveBeenCalledTimes(1);
  const assertIdx = calls.indexOf("assert");
  const checkoutIdx = calls.indexOf("checkout");
  const contextIdx = calls.indexOf("context");
  const gatesIdx = calls.indexOf("gates");
  expect(checkoutIdx).toBeGreaterThan(assertIdx);
  expect(checkoutIdx).toBeLessThan(contextIdx);
  expect(checkoutIdx).toBeLessThan(gatesIdx);
});

test("merge: checkoutHead is called for merge too", async () => {
  const checkoutHead = vi.fn(async () => ({ ok: true, sha: "b".repeat(40), pr: 9 }));
  const d = mergeHappyDeps({ checkoutHead });
  expect(await runStage({ stage: "merge", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(checkoutHead).toHaveBeenCalledTimes(1);
});

// ── Task 13: merge is script-only — no LLM-stage machinery ─────────────────

test("merge: never calls trustWorkspace, claudeP, buildContext, verifyStage or writeHandoff", async () => {
  const trustWorkspace = vi.fn(async () => {});
  const claudeP = vi.fn(async () => ({ is_error: false, result: "{}" }));
  const buildContext = vi.fn(async () => ({ roster: [], orchestration: "workflow", limits: { K: 3 } }));
  const verifyStage = vi.fn(() => ({ ok: true, reasons: [], data: {} }));
  const writeHandoff = vi.fn(async () => {});
  const d = mergeHappyDeps({
    checkoutHead: vi.fn(async () => ({ ok: true, sha: "a".repeat(40), pr: 9 })),
    trustWorkspace, claudeP, buildContext, verifyStage, writeHandoff,
  });
  expect(await runStage({ stage: "merge", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(trustWorkspace).not.toHaveBeenCalled();
  expect(claudeP).not.toHaveBeenCalled();
  expect(buildContext).not.toHaveBeenCalled();
  expect(verifyStage).not.toHaveBeenCalled();
  expect(writeHandoff).not.toHaveBeenCalled();
});

test("merge: calls checkoutHead, then runMergeStage's deps (prInfo → protectedPaths → policyViolations → gates → mergeGates → mergePr → transition → closeIssue) in order", async () => {
  const calls = [];
  const d = mergeHappyDeps({
    assertHandoff: async () => { calls.push("assert"); return { ok: true }; },
    checkoutHead: vi.fn(async () => { calls.push("checkout"); return { ok: true, sha: "a".repeat(40), pr: 9 }; }),
    prInfo: async () => { calls.push("prInfo"); return { number: 9, state: "OPEN", mergeable: "MERGEABLE" }; },
    gates: async () => { calls.push("gates"); return { schema: "factory.gates.v1", status: "GREEN", head_sha: "b".repeat(40) }; },
    mergeGates: async () => { calls.push("mergeGates"); return { checksGreen: true, integrityGreen: true }; },
    protectedPaths: async () => { calls.push("protectedPaths"); return { ok: true, files: [] }; },
    policyViolations: async () => { calls.push("policyViolations"); return { ok: true, files: [] }; },
    mergePr: async () => { calls.push("mergePr"); },
    transition: async ({ to }) => { calls.push(`transition:${to}`); return { ok: true, to }; },
    closeIssue: async () => { calls.push("closeIssue"); },
  });
  expect(await runStage({ stage: "merge", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(calls).toEqual(["assert", "checkout", "prInfo", "protectedPaths", "policyViolations", "gates", "mergeGates", "mergePr", "transition:factory:merged", "closeIssue"]);
});

// KTB-5: 보호 경로 변경은 L0(integrity 체크)가 아니라 여기서 자동 머지를 막는다 — 사람은 여전히
// 그 PR을 머지할 수 있어야 하기 때문이다(required context가 `factory/integrity` 하나뿐).
test("merge: a protected path in the PR range → needs-human, never merges, and never runs the gates (KTB-5)", async () => {
  const lines = [];
  const d = mergeHappyDeps({
    protectedPaths: async () => ({ ok: true, files: [".factory/harness.toml"] }),
    gates: vi.fn(async () => ({ schema: "factory.gates.v1", status: "GREEN", head_sha: "b".repeat(40) })),
    mergeGates: vi.fn(async () => ({ checksGreen: true, integrityGreen: true })),
    mergePr: vi.fn(async () => {}),
    comment: vi.fn(async () => {}),
    transition: vi.fn(async ({ to }) => ({ ok: true, to })),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "merge", issue: 7, deps: d, runnerId: "r" })).toBe(2);
  expect(d.mergePr).not.toHaveBeenCalled();
  // 게이트는 `harness.commands`(= PR이 쓴 코드)를 bash로 돌린다 — 거부가 그보다 먼저 일어난다
  expect(d.gates).not.toHaveBeenCalled();
  expect(d.mergeGates).not.toHaveBeenCalled();
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: expect.stringContaining(".factory/harness.toml") }));
  // 상세 코멘트는 **PR**에, 이슈에는 전이 사유 한 줄만
  expect(d.comment).toHaveBeenCalledWith(9, expect.stringContaining(".factory/harness.toml"));
  expect(lines.some((l) => /protected paths changed — human merge required/.test(l))).toBe(true);
});

test("merge: an agent file edited outside Examples/Perspectives → needs-human, no gates, no merge (KTB-6)", async () => {
  const lines = [];
  const d = mergeHappyDeps({
    policyViolations: async () => ({ ok: true, files: [".claude/agents/factory-builder.md"] }),
    gates: vi.fn(async () => ({ schema: "factory.gates.v1", status: "GREEN", head_sha: "b".repeat(40) })),
    mergePr: vi.fn(async () => {}),
    comment: vi.fn(async () => {}),
    transition: vi.fn(async ({ to }) => ({ ok: true, to })),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "merge", issue: 7, deps: d, runnerId: "r" })).toBe(2);
  expect(d.gates).not.toHaveBeenCalled();
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: expect.stringContaining("agent role sections edited outside") }));
  expect(d.comment).toHaveBeenCalledWith(9, expect.stringContaining(".claude/agents/factory-builder.md"));
  expect(lines.some((l) => /agent role sections edited outside/.test(l))).toBe(true);
});

test("merge: protectedPaths that cannot be computed → factory:blocked, no gates, no merge (KTB-5 fix round 1)", async () => {
  const d = mergeHappyDeps({
    protectedPaths: async () => ({ ok: false, files: [], reason: "git diff --name-status exited 128" }),
    gates: vi.fn(async () => ({ schema: "factory.gates.v1", status: "GREEN", head_sha: "b".repeat(40) })),
    mergePr: vi.fn(async () => {}),
    transition: vi.fn(async ({ to }) => ({ ok: true, to })),
  });
  expect(await runStage({ stage: "merge", issue: 7, deps: d, runnerId: "r" })).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: expect.stringContaining("protected-path check could not be computed") }));
  expect(d.gates).not.toHaveBeenCalled();
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("merge: postStatus is run-stage's own helper, not reimplemented — no sha skips the post and leaves a record line", async () => {
  const reportStatus = vi.fn(async () => {});
  const lines = [];
  const d = mergeHappyDeps({
    gates: async () => ({ schema: "factory.gates.v1", status: "GREEN" }),   // no head_sha
    reportStatus, runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "merge", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(reportStatus).not.toHaveBeenCalled();
  expect(lines.some((l) => /status: factory\/gates skipped — no sha/.test(l))).toBe(true);
});

test("merge: postStatus posts factory/gates via run-stage's reportStatus when a sha is present", async () => {
  const reportStatus = vi.fn(async () => {});
  const d = mergeHappyDeps({
    gates: async () => ({ schema: "factory.gates.v1", status: "GREEN", head_sha: "e".repeat(40) }),
    // 감사 H1c — 이 런의 head는 게이트 파일의 `e…`다(checkoutHead가 없는 배선). 리뷰 증거도 같은 커밋이어야 한다.
    ...mergeReviewDepsFor("e".repeat(40)),
    reportStatus,
  });
  expect(await runStage({ stage: "merge", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(reportStatus).toHaveBeenCalledWith(expect.objectContaining({ context: "factory/gates", state: "success", sha: "e".repeat(40) }));
});

test("merge: checkoutHead's sha flows into runMergeStage as headSha and is recorded", async () => {
  const lines = [];
  const d = mergeHappyDeps({
    checkoutHead: vi.fn(async () => ({ ok: true, sha: "f".repeat(40), pr: 9 })),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "merge", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(lines).toContain(`merge: head ${"f".repeat(7)}`);
  expect(lines).toContain(`merge: merged ${"f".repeat(7)} via PR #9`);
});

test("review: checkoutHead failure (PR head moved) → needs-human with that reason, exit 2, no claudeP", async () => {
  const lines = [];
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const claudeP = vi.fn(async () => ({ is_error: false, result: "{}" }));
  const d = checkoutBaseDeps({
    checkoutHead: vi.fn(async () => ({ ok: false, reason: "PR head moved since implement handoff (aaaaaaa → bbbbbbb)" })),
    transition, claudeP, runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 7, deps: d })).toBe(2);
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: "PR head moved since implement handoff (aaaaaaa → bbbbbbb)" }));
  expect(claudeP).not.toHaveBeenCalled();
  expect(lines.some((l) => /checkout: FAIL — PR head moved since implement handoff/.test(l))).toBe(true);
});

test("implement/triage/plan never call checkoutHead", async () => {
  for (const stage of ["implement", "triage", "plan"]) {
    const checkoutHead = vi.fn(async () => ({ ok: true, sha: "c".repeat(40) }));
    const d = checkoutBaseDeps({ checkoutHead, transition: vi.fn(async ({ to }) => ({ ok: true, to })) });
    await runStage({ stage, issue: 7, deps: d, runnerId: "r" });
    expect(checkoutHead, stage).not.toHaveBeenCalled();
  }
});

test("deps without checkoutHead still work — it is optional", async () => {
  const d = checkoutBaseDeps({});
  expect(d.checkoutHead).toBeUndefined();
  expect(await runStage({ stage: "review", issue: 7, deps: d })).toBe(0);
});

test("review: a successful checkout records checkout: <sha7> in the final run-record lines", async () => {
  const lines = [];
  const d = checkoutBaseDeps({
    checkoutHead: vi.fn(async () => ({ ok: true, sha: "deadbeef".repeat(5), pr: 9 })),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 7, deps: d })).toBe(0);
  expect(lines).toContain("checkout: deadbee");
});

// makeCheckoutHead: the real main()-style implementation, unit-tested via makeFakeRun + a fake gh.

const implHandoffFor = (issue, { head_sha, pr }) => [
  { id: 1, createdAt: "2026-09-11T00:00:00Z", body: renderHandoff({ stage: "implement", issue, summary: "s", data: { head_sha, pr } }) },
];

test("makeCheckoutHead: no implement handoff → { ok:false, reason:'implement handoff missing' }", async () => {
  const gh = { comments: vi.fn(async () => []), prHeadSha: vi.fn() };
  const run = makeFakeRun([]);
  const checkoutHead = makeCheckoutHead({ gh, run, root: "/repo", issue: 7 });
  const r = await checkoutHead();
  expect(r).toEqual({ ok: false, reason: "implement handoff missing" });
  expect(gh.prHeadSha).not.toHaveBeenCalled();
});

test("makeCheckoutHead: an implement handoff with no PR number is refused before calling gh.prHeadSha", async () => {
  const gh = { comments: vi.fn(async () => implHandoffFor(7, { head_sha: "a".repeat(40), pr: null })), prHeadSha: vi.fn() };
  const run = makeFakeRun([]);
  const checkoutHead = makeCheckoutHead({ gh, run, root: "/repo", issue: 7 });
  const r = await checkoutHead();
  expect(r).toEqual({ ok: false, reason: "implement handoff has no PR number" });
  expect(gh.prHeadSha).not.toHaveBeenCalled();
  expect(run.calls).toEqual([]);
});

test("makeCheckoutHead: a gh.prHeadSha failure (e.g. gh pr view) is caught, not thrown", async () => {
  const gh = {
    comments: vi.fn(async () => implHandoffFor(7, { head_sha: "a".repeat(40), pr: 9 })),
    prHeadSha: vi.fn(async () => { throw new Error("gh pr view 9 failed (1): could not find pull request"); }),
  };
  const run = makeFakeRun([]);
  const checkoutHead = makeCheckoutHead({ gh, run, root: "/repo", issue: 7 });
  const r = await checkoutHead();
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/^gh pr view failed: /);
  expect(r.reason).toMatch(/could not find pull request/);
  expect(run.calls).toEqual([]);
});

test("makeCheckoutHead: PR head moved since implement handoff → reason names both shas", async () => {
  const headSha = "a".repeat(40);
  const currentSha = "b".repeat(40);
  const gh = {
    comments: vi.fn(async () => implHandoffFor(7, { head_sha: headSha, pr: 9 })),
    prHeadSha: vi.fn(async () => currentSha),
  };
  const run = makeFakeRun([]);
  const checkoutHead = makeCheckoutHead({ gh, run, root: "/repo", issue: 7 });
  const r = await checkoutHead();
  expect(r).toEqual({ ok: false, reason: `PR head moved since implement handoff (${headSha.slice(0, 7)} → ${currentSha.slice(0, 7)})` });
  expect(gh.prHeadSha).toHaveBeenCalledWith(9);
  expect(run.calls).toEqual([]);
});

test("makeCheckoutHead: a git failure (fetch or checkout) surfaces { ok:false, reason }", async () => {
  const sha = "a".repeat(40);
  const gh = { comments: vi.fn(async () => implHandoffFor(7, { head_sha: sha, pr: 9 })), prHeadSha: vi.fn(async () => sha) };
  const run = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "fetch", result: { code: 1, stdout: "", stderr: "fatal: could not read from remote" } },
  ]);
  const checkoutHead = makeCheckoutHead({ gh, run, root: "/repo", issue: 7 });
  const r = await checkoutHead();
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/git fetch failed: fatal: could not read from remote/);

  const run2 = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "fetch", result: { code: 0, stdout: "", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "checkout", result: { code: 1, stdout: "", stderr: "fatal: reference is not a tree" } },
  ]);
  const checkoutHead2 = makeCheckoutHead({ gh, run: run2, root: "/repo", issue: 7 });
  const r2 = await checkoutHead2();
  expect(r2.ok).toBe(false);
  expect(r2.reason).toMatch(/git checkout failed: fatal: reference is not a tree/);
});

test("makeCheckoutHead: success fetches origin claude/fq-<issue> then checks out --detach <sha>", async () => {
  const sha = "a".repeat(40);
  const gh = { comments: vi.fn(async () => implHandoffFor(42, { head_sha: sha, pr: 9 })), prHeadSha: vi.fn(async () => sha) };
  const run = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "fetch", result: { code: 0, stdout: "", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "checkout", result: { code: 0, stdout: "", stderr: "" } },
  ]);
  const checkoutHead = makeCheckoutHead({ gh, run, root: "/repo", issue: 42 });
  const r = await checkoutHead();
  expect(r).toEqual({ ok: true, sha, pr: 9 });
  expect(run.calls[0]).toEqual(expect.objectContaining({ cmd: "git", args: ["fetch", "origin", "claude/fq-42"], opts: { cwd: "/repo" } }));
  expect(run.calls[1]).toEqual(expect.objectContaining({ cmd: "git", args: ["checkout", "--detach", sha], opts: { cwd: "/repo" } }));
});

// ── ADR-020 KTB-14: no-write stages (triage/plan/review) assert a clean worktree after claude -p ──
// KTB-13 r1's residual-risk register (gap 3) noted that reviewer-*/plan-*/factory-triage hold Bash,
// never commit, and stop-guard.sh exempts them from the dirty-tree check — so tampering by those
// roles reaches no diff that L1/integrity ever inspects. This is the structural backstop: it looks
// at the *result* (worktree diff), not at command shapes, so it doesn't matter which hook-unlisted
// shell shape produced the change.

test("isNoWriteStage: true for triage/plan/review (agent-md.js needsDenyAllWritesHook role names), false for implement/merge", () => {
  expect(isNoWriteStage("triage")).toBe(true);
  expect(isNoWriteStage("plan")).toBe(true);
  expect(isNoWriteStage("review")).toBe(true);
  expect(isNoWriteStage("implement")).toBe(false);
  expect(isNoWriteStage("merge")).toBe(false);
});

test("assertNoWriteStageClean: a dirty src file is reported", async () => {
  const run = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "status", result: { code: 0, stdout: " M src/a.js\n", stderr: "" } },
  ]);
  const r = await assertNoWriteStageClean({ run, cwd: "/repo" });
  expect(r).toEqual({ ok: false, dirty: ["src/a.js"] });
});

test("assertNoWriteStageClean: only .factory/out/** scratch changes are allowed", async () => {
  const run = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "status", result: { code: 0, stdout: "?? .factory/out/x\n", stderr: "" } },
  ]);
  const r = await assertNoWriteStageClean({ run, cwd: "/repo" });
  expect(r).toEqual({ ok: true, dirty: [] });
});

test("assertNoWriteStageClean: docs/factory/runs/** scratch changes are allowed too", async () => {
  const run = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "status", result: { code: 0, stdout: "M  docs/factory/runs/7-plan.md\n", stderr: "" } },
  ]);
  const r = await assertNoWriteStageClean({ run, cwd: "/repo" });
  expect(r).toEqual({ ok: true, dirty: [] });
});

test("assertNoWriteStageClean: a clean worktree passes", async () => {
  const run = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "status", result: { code: 0, stdout: "", stderr: "" } },
  ]);
  const r = await assertNoWriteStageClean({ run, cwd: "/repo" });
  expect(r).toEqual({ ok: true, dirty: [] });
});

test("assertNoWriteStageClean: a rename outside the allowed prefixes reports both sides", async () => {
  const run = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "status", result: { code: 0, stdout: "R  src/old.js -> src/new.js\n", stderr: "" } },
  ]);
  const r = await assertNoWriteStageClean({ run, cwd: "/repo" });
  expect(r.ok).toBe(false);
  expect(r.dirty.sort()).toEqual(["src/new.js", "src/old.js"]);
});

test("assertNoWriteStageClean: git status itself failing is fail-closed", async () => {
  const run = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "status", result: { code: 128, stdout: "", stderr: "fatal: not a git repository" } },
  ]);
  const r = await assertNoWriteStageClean({ run, cwd: "/repo" });
  expect(r.ok).toBe(false);
  expect(r.dirty).toEqual([]);
  expect(r.reason).toMatch(/git status failed: fatal: not a git repository/);
});

test("run-stage: a dirty src file after claude -p on a no-write stage (review) → needs-human, no verify", async () => {
  const transition = vi.fn(async () => ({ ok: true }));
  const verifyStage = vi.fn(() => ({ ok: true, reasons: [], data: {} }));
  const lines = [];
  const d = baseDeps({
    assertCleanWorktree: async () => ({ ok: false, dirty: ["src/a.js"] }),
    verifyStage, transition, runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 7, deps: d })).toBe(2);
  expect(verifyStage).not.toHaveBeenCalled();
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:needs-human",
    reason: "worktree dirty after review (no-write stage): src/a.js",
  }));
  expect(lines.some((l) => l.includes("worktree: FAIL — worktree dirty after review (no-write stage): src/a.js"))).toBe(true);
});

test("run-stage: only .factory/out/x dirty on a no-write stage (plan) → proceeds normally", async () => {
  const verifyStage = vi.fn(() => ({ ok: true, reasons: [], data: {} }));
  const d = baseDeps({ assertCleanWorktree: async () => ({ ok: true, dirty: [] }), verifyStage });
  expect(await runStage({ stage: "plan", issue: 7, deps: d })).toBe(0);
  expect(verifyStage).toHaveBeenCalled();
});

test("run-stage: a clean worktree on triage → proceeds normally", async () => {
  const assertCleanWorktree = vi.fn(async () => ({ ok: true, dirty: [] }));
  const verifyStage = vi.fn(() => ({ ok: true, reasons: [], data: { disposition: "ready" } }));
  const d = baseDeps({ assertCleanWorktree, verifyStage });
  expect(await runStage({ stage: "triage", issue: 7, deps: d })).toBe(0);
  expect(assertCleanWorktree).toHaveBeenCalled();
  expect(verifyStage).toHaveBeenCalled();
});

test("run-stage: the worktree check is skipped entirely on implement (the only writing stage)", async () => {
  const assertCleanWorktree = vi.fn(async () => ({ ok: false, dirty: ["src/a.js"] }));
  const d = implDeps({ assertCleanWorktree, gates: async () => ({ status: "GREEN", level: "full" }) });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(assertCleanWorktree).not.toHaveBeenCalled();
});

// KTB-14 r1: `git status`가 **실패한** 것은 더러운 트리와 같은 등급이 아니다 — GREEN도 RED도 아닌
// 판정 불가이고, 이 저장소에서 판정 불가의 자리는 언제나 blocked다(merge-stage의 `undecidable()`,
// 게이트 BLOCKED과 같은 계약). needs-human은 "사람이 판단할 것이 있다"는 뜻인데 여기엔 재료가 없다.
test("run-stage: git-status-failure on a no-write stage (review) is undecidable → factory:blocked", async () => {
  const transition = vi.fn(async () => ({ ok: true }));
  const lines = [];
  const d = baseDeps({
    assertCleanWorktree: async () => ({ ok: false, dirty: [], reason: "git status failed: fatal: not a git repository" }),
    transition, runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 7, deps: d })).toBe(2);
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:blocked",
    reason: "worktree check failed after review (no-write stage): git status failed: fatal: not a git repository",
  }));
  expect(transition).not.toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human" }));
  expect(lines.some((l) => l.includes("worktree: FAIL —"))).toBe(true);
});

// ── KTB-15b I2: generalized blocked-retry guard (triage/plan/implement/merge) ───────────────────
// Each of these stages can now enter from factory:blocked (ENTRY_LABELS), but only when the
// factory-blocked-origin marker (lib/labels.js BLOCKED_RETRY) says it came from that stage's own
// normal entry label. Merge is special — it does not hop the label here; merge-stage.js does,
// only after re-confirming gates GREEN in this run (see merge-stage.test.js retryFromBlocked).

test("KTB-15b: merge entering from factory:blocked whose origin was factory:approved retries and merges", async () => {
  const calls = [];
  const d = mergeHappyDeps({
    issueLabels: async () => ["factory:blocked"],
    blockedOrigin: async () => ({ from: "factory:approved", stage: "merge" }),
    transition: async ({ to }) => { calls.push(`transition:${to}`); return { ok: true, to }; },
    mergePr: async () => { calls.push("mergePr"); },
  });
  expect(await runStage({ stage: "merge", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(calls).toEqual(["transition:factory:approved", "mergePr", "transition:factory:merged"]);
});

test("KTB-15b: merge entering from factory:blocked whose origin was NOT approved refuses — no transition, no PR lookup", async () => {
  const lines = [];
  const d = mergeHappyDeps({
    issueLabels: async () => ["factory:blocked"],
    blockedOrigin: async () => ({ from: "factory:in-progress", stage: "implement" }),
    prInfo: vi.fn(async () => ({ number: 9, state: "OPEN", mergeable: "MERGEABLE" })),
    transition: vi.fn(async ({ to }) => ({ ok: true, to })),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "merge", issue: 7, deps: d, runnerId: "r" })).toBe(2);
  expect(d.prInfo).not.toHaveBeenCalled();
  expect(d.transition).not.toHaveBeenCalled();
  expect(lines.some((l) => /merge: blocked did not originate from approved — nothing to retry \(origin=in-progress\)/.test(l))).toBe(true);
});

test("KTB-15b: merge entering from factory:blocked with no origin marker at all refuses (unreadable is not approved)", async () => {
  const d = mergeHappyDeps({
    issueLabels: async () => ["factory:blocked"],
    blockedOrigin: async () => null,
    prInfo: vi.fn(),
    transition: vi.fn(async ({ to }) => ({ ok: true, to })),
  });
  expect(await runStage({ stage: "merge", issue: 7, deps: d, runnerId: "r" })).toBe(2);
  expect(d.prInfo).not.toHaveBeenCalled();
});

test("KTB-15b: plan entering from factory:blocked whose origin was factory:ready hops back to ready, then runs normally", async () => {
  const calls = [];
  const d = baseDeps({
    issueLabels: async () => ["factory:blocked"],
    blockedOrigin: async () => ({ from: "factory:ready", stage: "plan" }),
    transition: async ({ to }) => { calls.push(`transition:${to}`); return { ok: true, to }; },
    claudeP: async () => { calls.push("claudeP"); return { is_error: false, result: "{}" }; },
  });
  expect(await runStage({ stage: "plan", issue: 7, deps: d })).toBe(0);
  expect(calls).toEqual(["transition:factory:ready", "claudeP", "transition:factory:planned"]);
});

test("KTB-15b: plan entering from factory:blocked whose origin was NOT ready refuses — no transition, no claude -p", async () => {
  const lines = [];
  const d = baseDeps({
    issueLabels: async () => ["factory:blocked"],
    blockedOrigin: async () => ({ from: "factory:in-progress", stage: "implement" }),
    transition: vi.fn(async ({ to }) => ({ ok: true, to })),
    claudeP: vi.fn(),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "plan", issue: 7, deps: d })).toBe(2);
  expect(d.transition).not.toHaveBeenCalled();
  expect(d.claudeP).not.toHaveBeenCalled();
  expect(lines.some((l) => /plan: blocked did not originate from ready — nothing to retry \(origin=in-progress\)/.test(l))).toBe(true);
});

test("KTB-15b: triage entering from factory:blocked whose origin was factory:queue hops back to queue, then runs normally", async () => {
  const calls = [];
  const d = baseDeps({
    issueLabels: async () => ["factory:blocked"],
    blockedOrigin: async () => ({ from: "factory:queue", stage: "triage" }),
    transition: async ({ to }) => { calls.push(`transition:${to}`); return { ok: true, to }; },
    claudeP: async () => { calls.push("claudeP"); return { is_error: false, result: "{}" }; },
    verifyStage: () => ({ ok: true, reasons: [], data: { disposition: "ready" } }),
  });
  expect(await runStage({ stage: "triage", issue: 7, deps: d })).toBe(0);
  expect(calls).toEqual(["transition:factory:queue", "claudeP", "transition:factory:ready"]);
});

test("KTB-15b: implement entering from factory:blocked whose origin was factory:in-progress hops back to planned, then re-claims in-progress normally", async () => {
  const calls = [];
  const d = baseDeps({
    issueLabels: async () => ["factory:blocked"],
    blockedOrigin: async () => ({ from: "factory:in-progress", stage: "implement" }),
    transition: async ({ to }) => { calls.push(`transition:${to}`); return { ok: true, to }; },
    claudeP: async () => { calls.push("claudeP"); return { is_error: false, result: "{}" }; },
  });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  // hop back to planned (KTB-15b), then implement's own unconditional planned → in-progress step
  expect(calls).toEqual(["transition:factory:planned", "transition:factory:in-progress", "claudeP", "transition:factory:awaiting-review"]);
});

test("KTB-15b: implement entering from factory:blocked whose origin matches neither planned nor in-progress refuses", async () => {
  const lines = [];
  const d = baseDeps({
    issueLabels: async () => ["factory:blocked"],
    blockedOrigin: async () => ({ from: "factory:queue", stage: "triage" }),
    transition: vi.fn(async ({ to }) => ({ ok: true, to })),
    claudeP: vi.fn(),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(2);
  expect(d.transition).not.toHaveBeenCalled();
  expect(d.claudeP).not.toHaveBeenCalled();
  // 최종 리뷰 nit 1: origin 목록은 `in-progress` 하나다(`planned → blocked` 엣지가 없어 그 origin은 생길 수 없다).
  expect(lines.some((l) => /implement: blocked did not originate from in-progress — nothing to retry \(origin=queue\)/.test(l))).toBe(true);
});

// KTB-24 fix가 review에 blocked 재진입을 열었다 — 하지만 **origin 마커가 없으면** 여전히 아무것도
// 재시도하지 않는다(사람이 API로 라벨을 직접 blocked에 붙인 경우 등: "판정 불가"이지 "리뷰 중이었다"가 아니다).
test("KTB-24 fix: review from factory:blocked with no origin marker refuses — exit 2, no transition", async () => {
  const transition = vi.fn();
  const d = baseDeps({ issueLabels: async () => ["factory:blocked"], blockedOrigin: async () => null, transition, claudeP: vi.fn() });
  expect(await runStage({ stage: "review", issue: 7, deps: d })).toBe(2);
  expect(transition).not.toHaveBeenCalled();
  expect(d.claudeP).not.toHaveBeenCalled();
});

// ── KTB-15b M1: verifyStage's `source` (which candidate won) is recorded, not dropped ───────────
test("KTB-15b M1: run-stage records `artifact: <source>` when verifyStage names one", async () => {
  const lines = [];
  const d = baseDeps({
    verifyStage: () => ({ ok: true, reasons: [], data: {}, source: "transcript file read plan.json.output (.result)" }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "plan", issue: 7, deps: d })).toBe(0);
  expect(lines).toContain("artifact: transcript file read plan.json.output (.result)");
});

test("KTB-15b M1: no source (or verifyStage that doesn't return one) means no artifact: line", async () => {
  const lines = [];
  const d = baseDeps({
    verifyStage: () => ({ ok: true, reasons: [], data: {} }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "plan", issue: 7, deps: d })).toBe(0);
  expect(lines.some((l) => l.startsWith("artifact:"))).toBe(false);
});

test("KTB-15b: a refused hop-back transition stops the stage before claude -p runs", async () => {
  const d = baseDeps({
    issueLabels: async () => ["factory:blocked"],
    blockedOrigin: async () => ({ from: "factory:ready", stage: "plan" }),
    transition: vi.fn(async () => ({ ok: false, reason: "graph refused (unexpected)" })),
    claudeP: vi.fn(),
  });
  expect(await runStage({ stage: "plan", issue: 7, deps: d })).toBe(2);
  expect(d.claudeP).not.toHaveBeenCalled();
});

// ── ADR-020 KTB-24 — 취소·실패 정리 경로 ───────────────────────────────────────────────────────
// 잡 타임아웃과 취소는 runStage의 finally를 실행하지 않는다(프로세스가 SIGKILL로 사라진다).
// 데모 #15가 남긴 것: 고아 락 `refs/heads/factory/lock-15`, 전이 없음, run 기록 없음, 45분 소각.
// r1 MF2: 이 스텝은 **증명된 것만** 만진다 — 락이 있고 그 `runner=`가 이 런일 때만 전이·해제를 한다.
// 그래서 기본 더블은 "우리가 쥔 락"을 돌려준다(정상 경로: 잡이 SIGKILL로 죽어 finally가 못 돌았다).
const OUR_RUNNER = "gha-111";
const heldByUs = { present: true, runner: OUR_RUNNER, subject: `lock issue=15 stage=review runner=${OUR_RUNNER} at=t`, sha: "a".repeat(40) };
const abortDeps = (over = {}) => ({
  issueLabels: async () => ["factory:awaiting-review"],
  lockHolder: async () => heldByUs,
  transition: vi.fn(async ({ to }) => ({ ok: true, to })),
  release: vi.fn(async () => true),
  runRecord: vi.fn(),
  syncRecords: vi.fn(async () => ({ ok: true })),
  ...over,
});
const abort = (args) => abortStage({ runnerId: OUR_RUNNER, ...args });

test("KTB-24: --aborted with the stage's in-flight label → blocked + lock released + record line", async () => {
  const lines = [];
  const d = abortDeps({ runRecord: (l) => lines.push(...l) });
  expect(await abort({ stage: "review", issue: 15, status: "cancelled", deps: d })).toBe(0);
  expect(d.transition).toHaveBeenCalledWith({ to: "factory:blocked", reason: "job cancelled — retry via sweeper", cause: "cancelled" });
  expect(d.release).toHaveBeenCalled();
  expect(lines).toContain("aborted: cancelled (job timeout or cancel)");
  expect(lines).toContain("aborted: factory:awaiting-review → factory:blocked");
  expect(lines).toContain("lock: released after abort");
  expect(d.syncRecords).toHaveBeenCalled();
});

// ── ADR-020 O20 — 정리 스텝은 원인 등급을 **직접** 안다(GitHub이 job.status로 말해 줬다) ─────────
test("O20: the abort path passes a cause class taken from the job status", async () => {
  const timedOut = abortDeps();
  await abort({ stage: "review", issue: 15, status: "timed_out", deps: timedOut });
  expect(timedOut.transition).toHaveBeenCalledWith(expect.objectContaining({ cause: "timeout" }));
  // 표에 없는 상태는 등급을 세우지 않는다 — transition.js가 사유 문구에서 되짚는다
  const failed = abortDeps();
  await abort({ stage: "review", issue: 15, status: "failure", deps: failed });
  expect(failed.transition).toHaveBeenCalledWith(expect.objectContaining({ cause: undefined }));
});

test("KTB-24: --aborted on a label the stage already left → record only, no transition", async () => {
  const lines = [];
  const d = abortDeps({ issueLabels: async () => ["factory:approved"], runRecord: (l) => lines.push(...l) });
  expect(await abort({ stage: "review", issue: 15, status: "failure", deps: d })).toBe(0);
  expect(d.transition).not.toHaveBeenCalled();
  expect(d.release).toHaveBeenCalled();                                 // 락은 라벨과 무관하게 언제나 푼다
  expect(lines).toContain("aborted: failure (job timeout or cancel)");
  expect(lines.some((l) => l.includes("not factory:awaiting-review"))).toBe(true);
});

test("KTB-24: every stage's in-flight label, and merge is lock-release only", async () => {
  expect(IN_FLIGHT_LABEL).toEqual({ triage: "factory:queue", plan: "factory:ready", implement: "factory:in-progress", review: "factory:awaiting-review" });
  // 네 라벨 모두 blocked으로 나가는 엣지가 실제로 있어야 이 정리가 성립한다
  for (const from of Object.values(IN_FLIGHT_LABEL)) expect(canTransition(from, "factory:blocked"), from).toBe(true);
  const lines = [];
  const d = abortDeps({ issueLabels: vi.fn(), runRecord: (l) => lines.push(...l) });
  expect(await abort({ stage: "merge", issue: 15, status: "cancelled", deps: d })).toBe(0);
  expect(d.issueLabels).not.toHaveBeenCalled();                         // 조회조차 하지 않는다
  expect(d.transition).not.toHaveBeenCalled();
  expect(d.release).toHaveBeenCalled();
  expect(lines).toContain("aborted: merge is script-only — lock release and record only");
});

test("KTB-24: an unreadable label set still releases the lock and says why", async () => {
  const lines = [];
  const d = abortDeps({ issueLabels: async () => { throw new Error("gh down"); }, runRecord: (l) => lines.push(...l) });
  expect(await abort({ stage: "implement", issue: 2, status: "cancelled", deps: d })).toBe(0);
  expect(d.transition).not.toHaveBeenCalled();
  expect(d.release).toHaveBeenCalled();
  expect(lines.some((l) => l.includes("entry state unreadable — gh down"))).toBe(true);
});

test("KTB-24: a failed lock release is never silent", async () => {
  const lines = [];
  const d = abortDeps({ release: async () => false, runRecord: (l) => lines.push(...l) });
  await abort({ stage: "plan", issue: 7, status: "cancelled", deps: { ...d, issueLabels: async () => ["factory:ready"] } });
  expect(lines.some((l) => l.includes("lock: release failed for issue 7"))).toBe(true);
});

// ── ADR-020 KTB-25 — 라운드는 마지막 재큐 이후부터 센다 ────────────────────────────────────────
/**
 * ADR-020 r2 SF4(리뷰 finding 4) — **던지는 전이가 락 해제와 기록을 삼키면 안 된다.** KTB-30이 라벨
 * 변경에 재시도 + REST 폴백을 달면서 `transition()`은 던질 수 있는 호출이 됐고, `main()`은 이 함수를
 * 맨몸으로 부른다 — 그 예외 하나가 "언제나 락을 풀고 언제나 한 줄을 남긴다"는 이 스텝의 계약 전부를
 * 건너뛰었다. 하필 API 장애 창에서만.
 */
test("SF4: a throwing transition still releases the (owned) lock and writes the run record", async () => {
  const lines = [];
  const d = abortDeps({
    transition: vi.fn(async () => { throw new Error("gh api 502 — REST fallback (403) also failed: https://api.github.com/x") }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await abort({ stage: "review", issue: 15, status: "cancelled", deps: d })).toBe(0);
  expect(d.release).toHaveBeenCalled();                                // 락은 풀린다
  expect(d.syncRecords).toHaveBeenCalled();
  expect(lines.some((l) => l.startsWith("transition failed: factory:awaiting-review → factory:blocked"))).toBe(true);
  expect(lines.some((l) => l.includes("lock: released after abort"))).toBe(true);
  expect(lines.join("\n")).not.toMatch(/https:\/\//);                  // 원격 문구는 절단된다(<url>)
});

// r2 nit 7 — `claim refused` 줄과 **공개 이슈 코멘트**가 함께 쓰는 상태 문자열도 절단한다
// (`claim.js`는 unreachable일 때 원격 에러 메시지를 그대로 싣는다).
test("nit 7: a claim-refused status is truncated before it reaches the issue comment", async () => {
  const long = "unreachable (fatal: could not read from remote repository https://x-access-token:ghs_SECRET@github.com/o/r.git\nplease make sure)";
  const posted = [];
  const deps = baseDeps({ claim: async () => ({ ok: false, holder: "lock issue=7 runner=gha-1", runner: "gha-1", status: long }), comment: async (n, body) => { posted.push(body); }, runRecord: () => {} });
  expect(await runStage({ stage: "plan", issue: 7, deps })).toBe(2);
  expect(posted[0]).not.toMatch(/ghs_SECRET/);
  expect(posted[0]).toMatch(/<url>/);
});

test("KTB-25: review handoffs before the last `→ factory:queue` transition do not count toward K", () => {
  const handoff = (n) => ({ id: n, body: renderHandoff({ stage: "review", issue: 18, summary: "r", data: { issue: 18, round: n } }), createdAt: `2026-09-1${n}` });
  const requeue = { id: 99, body: "<!-- factory-transition:v1 from=factory:needs-human to=factory:queue by=human -->\nneeds-human → factory:queue", createdAt: "2026-09-13" };
  const count = (comments) => parseHandoffs(commentsSinceRequeue(comments)).filter((h) => h.stage === "review" && h.issue === 18).length;
  // 데모 #18: needs-human에서 재큐돼 triage부터 통째로 다시 돌았는데 첫 리뷰가 round 2로 시작했다
  expect(count([handoff(1), handoff(2)])).toBe(2);
  expect(count([handoff(1), handoff(2), requeue])).toBe(0);             // → 다음 리뷰는 round 1
  expect(count([handoff(1), handoff(2), requeue, handoff(3)])).toBe(1); // → 그다음이 round 2
  // 재큐가 여러 번이면 마지막 것만 센다
  expect(count([handoff(1), requeue, handoff(2), requeue, handoff(3)])).toBe(1);
  // 재큐가 한 번도 없으면 이력 전체(예전 동작)
  expect(commentsSinceRequeue([])).toEqual([]);
});

// ── ADR-020 KTB-23 — 하네스가 막고 있으면 needs-human 루프가 아니라 factory:harness 이슈다 ────────
const HARNESS_PG = { file: "package.json", change: "add dependency pg@^8", why: "dw1/dw3/dw4 need a Postgres client" };
const harnessImplDeps = (over = {}) => ({
  charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }),
  issueLabels: async () => ["factory:planned"],
  heartbeat: async () => ({ stop() {} }), assertHandoff: async () => ({ ok: true }),
  buildContext: async () => ({ roster: [], orchestration: "workflow", limits: { K: 3 } }),
  claudeP: async () => ({ is_error: false, result: "{}" }),
  gates: async () => ({ schema: "factory.gates.v1", status: "GREEN", level: "full", passed: 4, failed: 0, skipped: [], misconfigured: [], tests: { excluded: [] } }),
  verifyStage: () => ({ ok: true, reasons: [], data: { issue: 2, pr: 17, harness_needed: [HARNESS_PG], verifier: { verdict: "rejected" } } }),
  writeHandoff: vi.fn(async () => {}),
  ensureHarnessIssue: vi.fn(async () => ({ issue: 31, created: true, title: "harness: add dependency pg@^8 — for #2" })),
  transition: vi.fn(async ({ to }) => ({ ok: true, to })),
  runRecord: () => {}, release: async () => {},
  ...over,
});

test("KTB-23: a verified implement handoff with harness_needed opens ONE factory:harness issue and parks the feature on needs-info", async () => {
  const lines = [];
  const d = harnessImplDeps({ runRecord: (l) => lines.push(...l) });
  expect(await runStage({ stage: "implement", issue: 2, deps: d })).toBe(0);
  expect(d.ensureHarnessIssue).toHaveBeenCalledWith({ entries: [HARNESS_PG], pr: 17 });
  // handoff는 그대로 남는다 — 이 라운드가 무엇을 했고 무엇이 막았는지는 기록이다
  expect(d.writeHandoff).toHaveBeenCalledTimes(1);
  // verifier가 rejected여도 여기가 먼저다: 막은 것이 코드가 아니라 하네스일 때 다음 걸음은 사람이 아니다
  expect(d.transition).toHaveBeenLastCalledWith({ to: "factory:needs-info", reason: "waiting for harness issue #31" });
  expect(d.transition).not.toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human" }));
  expect(lines).toContain("harness: opened factory:harness issue #31 — package.json");
  expect(lines).toContain("transition: factory:needs-info");
  // 그리고 그 전이는 그래프에 실제로 있다(KTB-23이 더한 엣지), 복귀 경로도 그대로다
  expect(canTransition("factory:in-progress", "factory:needs-info")).toBe(true);
  expect(canTransition("factory:needs-info", "factory:queue")).toBe(true);
});

test("KTB-23: an existing open harness issue is reused, never duplicated", async () => {
  const lines = [];
  const d = harnessImplDeps({
    ensureHarnessIssue: async () => ({ issue: 31, created: false, title: "harness: add dependency pg@^8 — for #2" }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 2, deps: d })).toBe(0);
  expect(lines).toContain("harness: reusing factory:harness issue #31 — package.json");
});

test("KTB-23: if the harness issue cannot be created the feature is NOT parked — needs-human, exit 2", async () => {
  const lines = [];
  const d = harnessImplDeps({
    ensureHarnessIssue: async () => { throw new Error("gh down"); },
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 2, deps: d })).toBe(2);
  expect(d.transition).toHaveBeenLastCalledWith(expect.objectContaining({
    to: "factory:needs-human", reason: expect.stringContaining("could not be created — gh down"),
  }));
  expect(lines.some((l) => l.startsWith("harness: FAIL —"))).toBe(true);
});

test("KTB-23: no harness_needed (or an empty/ill-formed one) leaves the normal path untouched", async () => {
  for (const data of [{ issue: 2, pr: 17 }, { issue: 2, pr: 17, harness_needed: [] }, { issue: 2, pr: 17, harness_needed: [{ file: "package.json" }] }]) {
    const d = harnessImplDeps({ verifyStage: () => ({ ok: true, reasons: [], data }) });
    expect(await runStage({ stage: "implement", issue: 2, deps: d }), JSON.stringify(data)).toBe(0);
    expect(d.ensureHarnessIssue).not.toHaveBeenCalled();
    expect(d.transition).toHaveBeenLastCalledWith(expect.objectContaining({ to: "factory:awaiting-review" }));
  }
  // 다른 스테이지의 handoff에 같은 필드가 있어도 이 분기는 implement의 것이다
  const review = harnessImplDeps({ issueLabels: async () => ["factory:awaiting-review"], verifyStage: () => ({ ok: true, reasons: [], data: { round: 1, decision: "approved", harness_needed: [HARNESS_PG] } }) });
  expect(await runStage({ stage: "review", issue: 2, deps: review })).toBe(0);
  expect(review.ensureHarnessIssue).not.toHaveBeenCalled();
});

// ── ADR-020 KTB-23 fix — 하네스 이슈는 자기 자신을 위한 하네스 이슈를 열지 않는다 ──────────────
// 그 이슈의 builder는 `.factory/harness.toml`·러너 설정·매니페스트를 **쓰라고** 부른 것인데, 프롬프트는
// 그것을 여전히 "보호 경로"로 적어 두었다(KTB-20/23이 훅과 L2만 갈랐다). 그래서 builder가 `harness_needed`를
// 채우고 멈추면 L1이 또 하네스 이슈를 열었다 — 사슬이고, 주차된 피처는 그 끝까지 기다린다.
test("KTB-23 fix: a harness issue's own harness_needed is recorded, never spawns another issue", async () => {
  const lines = [];
  const d = harnessImplDeps({
    issueLabels: async () => ["factory:planned", "factory:harness"],
    ciSettingsPresent: async () => true,
    verifyStage: () => ({ ok: true, reasons: [], data: { issue: 15, pr: 20, harness_needed: [HARNESS_PG], verifier: { verdict: "accepted" } } }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 15, deps: d })).toBe(0);
  expect(d.ensureHarnessIssue).not.toHaveBeenCalled();
  // 요청은 기록으로 남고, 라우팅은 평소의 verifier 경로다 — 주차도 needs-info도 없다
  expect(lines).toContain("harness: this IS the harness issue — harness_needed recorded, no new issue (package.json)");
  expect(d.transition).toHaveBeenLastCalledWith(expect.objectContaining({ to: "factory:awaiting-review" }));
  expect(d.transition).not.toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-info" }));
});

test("KTB-23 fix: a harness issue with no harness_needed is completely unchanged", async () => {
  const lines = [];
  const d = harnessImplDeps({
    issueLabels: async () => ["factory:planned", "factory:harness"],
    ciSettingsPresent: async () => true,
    verifyStage: () => ({ ok: true, reasons: [], data: { issue: 15, pr: 20, verifier: { verdict: "accepted" } } }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 15, deps: d })).toBe(0);
  expect(lines.some((l) => l.startsWith("harness: this IS"))).toBe(false);
  expect(d.transition).toHaveBeenLastCalledWith(expect.objectContaining({ to: "factory:awaiting-review" }));
});

// ── ADR-020 KTB-24 fix — review도 blocked에서 되돌아온다 ───────────────────────────────────────
test("KTB-24 fix: review entering from factory:blocked whose origin was awaiting-review hops back and runs", async () => {
  const calls = [];
  const d = baseDeps({
    issueLabels: async () => ["factory:blocked"],
    blockedOrigin: async () => ({ from: "factory:awaiting-review", stage: "review" }),
    transition: vi.fn(async ({ to }) => { calls.push(`transition:${to}`); return { ok: true, to }; }),
    claudeP: async () => { calls.push("claudeP"); return { is_error: false, result: "{}" }; },
  });
  expect(await runStage({ stage: "review", issue: 15, deps: d })).toBe(0);
  expect(calls[0]).toBe("transition:factory:awaiting-review");
  expect(calls).toContain("claudeP");
  // hop은 **복구**이지 새 성취의 주장이 아니다 — 이번 런에는 아직 게이트 파일도 sha 바인딩도 없다.
  // `prerequisite`를 세우지 않으면 `factory:awaiting-review` 요구조건(GREEN 게이트 파일 + PR head 일치)이
  // 그 자리에서 hop을 거부하고, 이슈는 재시도 대신 곧장 needs-human으로 밀린다.
  expect(d.transition).toHaveBeenNthCalledWith(1, expect.objectContaining({ to: "factory:awaiting-review", prerequisite: true }));
});

test("KTB-24 fix: a review blocked from somewhere else is still refused — no transition, no claude -p", async () => {
  const lines = [];
  const d = baseDeps({
    issueLabels: async () => ["factory:blocked"],
    blockedOrigin: async () => ({ from: "factory:in-progress", stage: "implement" }),
    transition: vi.fn(async ({ to }) => ({ ok: true, to })),
    claudeP: vi.fn(),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 15, deps: d })).toBe(2);
  expect(d.transition).not.toHaveBeenCalled();
  expect(d.claudeP).not.toHaveBeenCalled();
  expect(lines.some((l) => /review: blocked did not originate from awaiting-review/.test(l))).toBe(true);
});

// ── ADR-020 KTB-24 fix — 정리 스텝은 **남의 락**을 지우지 않는다 ───────────────────────────────
// 이 스텝은 `always() && job.status != 'success'`로 돈다 — claim에 실패해 물러난 런에서도 돌 수 있고,
// 취소는 claim 이전에도 온다. 소유자를 묻지 않고 release()를 부르면 지금 정상적으로 돌고 있는 다른
// 러너의 락을 지우게 되고, 그러면 같은 이슈에 두 스테이지가 동시에 들어간다.
test("KTB-24 fix: the lock is released only when this runner holds it", async () => {
  const run = async (stage, holder) => {
    const lines = [];
    const d = abortDeps({
      issueLabels: async () => ["factory:awaiting-review"],
      lockHolder: async () => holder,
      release: vi.fn(async () => true),
      runRecord: (l) => lines.push(...l),
    });
    await abortStage({ stage, issue: 15, status: "failure", runnerId: OUR_RUNNER, deps: d });
    return { lines, release: d.release, transition: d.transition };
  };

  // ① 이미 풀렸다 — 지울 것도, 사람에게 "손으로 지우라"고 시킬 것도 없다
  const gone = await run("review", { present: false });
  expect(gone.release).not.toHaveBeenCalled();
  expect(gone.lines).toContain("lock: already released");
  expect(gone.lines.some((l) => l.includes("by hand"))).toBe(false);

  // ② 우리 것이다 — 지운다
  const ours = await run("review", heldByUs);
  expect(ours.release).toHaveBeenCalled();
  expect(ours.lines).toContain("lock: released after abort");

  // ③ 남의 것이다 — 그대로 두고 누구 것인지 적는다
  const theirs = await run("review", { present: true, runner: "gha-222", subject: "lock issue=15 stage=review runner=gha-222 at=t" });
  expect(theirs.release).not.toHaveBeenCalled();
  expect(theirs.lines).toContain("lock: held by gha-222 — left alone");
});

/**
 * r1 MF2 — **소유자를 모르면 아무것도 하지 않는다(fail closed).**
 *
 * 예전 계약은 "모르면 우리 것으로 치고 지운다"였고, 그것은 "이 스텝에 오는 런은 거의 다 락의 주인이다"
 * 라는 전제 위에 서 있었다. KTB-28 (b)가 그 전제를 깼다: claim에 **실패한** 런도 이제 잡을 실패로
 * 끝내므로 `Aborted cleanup`을 반드시 돈다. 그 런은 락을 쥔 적이 없는데, `git fetch` 한 번이 흔들리면
 * (M4가 `present:null`로 정확히 분류한 그 경우들) 정리 코드가 지금 돌고 있는 A의 라벨을 blocked으로
 * 밀고 A의 락을 지운다 — A의 리뷰 라운드가 버려지고, 락이 없어진 자리에 sweeper가 두 번째 review를
 * 얹는다. 고아 락은 sweeper가 소유자 런의 종료를 확인한 뒤 회수한다(KTB-28 c) — 그쪽이 훨씬 싸다.
 */
test("MF2: an unknown holder (unreadable, unparseable, or unwired) transitions nothing and releases nothing", async () => {
  const cases = {
    "present:null": { lockHolder: async () => ({ present: null, reason: "fatal: could not read from remote" }) },
    "unparseable subject": { lockHolder: async () => ({ present: true, runner: null, subject: "lock" }) },
    "lookup throws": { lockHolder: async () => { throw new Error("gh down"); } },
    "no lockHolder dep": { lockHolder: undefined },
  };
  for (const [name, over] of Object.entries(cases)) {
    const lines = [];
    const d = abortDeps({ release: vi.fn(async () => true), runRecord: (l) => lines.push(...l), ...over });
    expect(await abort({ stage: "review", issue: 15, status: "cancelled", deps: d }), name).toBe(0);
    expect(d.release, name).not.toHaveBeenCalled();
    expect(d.transition, name).not.toHaveBeenCalled();
    expect(lines.some((l) => l.startsWith("abort-skipped: holder unknown")), name).toBe(true);
    expect(lines.some((l) => l.startsWith("lock: holder unknown — left alone")), name).toBe(true);
  }
});

test("MF2: with no lock at all this run cannot prove it owned the stage — no transition, nothing to release", async () => {
  const lines = [];
  const d = abortDeps({ lockHolder: async () => ({ present: false }), release: vi.fn(async () => true), runRecord: (l) => lines.push(...l) });
  await abort({ stage: "review", issue: 15, status: "failure", deps: d });
  expect(d.transition).not.toHaveBeenCalled();
  expect(d.release).not.toHaveBeenCalled();
  expect(lines).toContain("lock: already released");
  expect(lines.some((l) => l.includes("by hand"))).toBe(false);
});

// nit 8: 원격 stderr는 `factory/records` 브랜치로 커밋되는 영구 기록에 그대로 실리면 안 된다.
test("nit8: a holder-lookup reason reaches the run record stripped of URLs and folded to one line", async () => {
  const lines = [];
  const d = abortDeps({
    lockHolder: async () => ({ present: null, reason: "remote: Repository not found.\nfatal: repository 'https://x@github.com/o/r.git/' not found" }),
    runRecord: (l) => lines.push(...l),
  });
  await abort({ stage: "review", issue: 15, status: "cancelled", deps: d });
  const line = lines.find((l) => l.startsWith("abort-skipped: holder unknown"));
  expect(line).not.toMatch(/https?:\/\//);
  expect(line).not.toMatch(/\n/);
});

// ── ADR-020 KTB-28 — 고아 락은 회수하고, 거부는 시끄럽다 ─────────────────────────────────────────
// 데모 #15: 04:39에 타임아웃으로 죽은 review 런의 `lock-15`가 살아남아 그 뒤의 모든 dispatch가
// `claim()`에서 26~40초 만에 죽었다 — exit 0, 기록 한 줄 없음, 코멘트 없음, 잡 결론 success.
// 바깥에서 보면 "디스패치가 잘 됐다"였고, 그래서 네 번을 더 밀었다.
test("KTB-28: a refused claim is LOUD — run-record line, issue comment, exit 2", async () => {
  const lines = [];
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const deps = baseDeps({
    claim: async () => ({ ok: false, holder: "lock issue=15 stage=review runner=gha-34736609544 at=t", runner: "gha-34736609544", status: "in_progress" }),
    comment: vi.fn(async () => {}), claudeP: vi.fn(), runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 15, deps })).toBe(2);
  expect(deps.claudeP).not.toHaveBeenCalled();
  expect(lines).toContain("claim refused: lock held by gha-34736609544 (in_progress)");
  expect(deps.comment).toHaveBeenCalledWith(15, expect.stringContaining("gha-34736609544"));
  expect(err).toHaveBeenCalledWith(expect.stringContaining("claim refused"));
  err.mockRestore();
});

test("KTB-28: a claim that reclaimed a dead runner's lock says so in the run record", async () => {
  const lines = [];
  const deps = baseDeps({
    claim: async () => ({ ok: true, commit: "c", reclaimed: { runner: "gha-34736609544", status: "completed" } }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "plan", issue: 15, deps })).toBe(0);
  expect(lines).toContain("lock: reclaimed from completed runner gha-34736609544");
});

test("KTB-28: a failing refusal comment never hides the refusal — still exit 2, still recorded", async () => {
  const lines = [];
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const deps = baseDeps({
    claim: async () => ({ ok: false, holder: "unknown", runner: null, status: "unknown" }),
    comment: async () => { throw new Error("comment API 502"); }, runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 15, deps })).toBe(2);
  expect(lines).toContain("claim refused: lock held by unknown (unknown)");
  expect(lines.some((l) => /claim refused: comment failed/.test(l))).toBe(true);
  err.mockRestore();
});

// exit 2는 잡 실패다 → `Aborted cleanup` 스텝이 돈다. 그 스텝이 **지금 돌고 있는 러너의** 라벨을
// blocked으로 밀면 KTB-28의 고침이 새 사고를 만든다 — 락이 남의 것이면 전이도 하지 않는다.
test("KTB-28: abortStage makes no transition when the lock belongs to another live runner", async () => {
  const lines = [];
  const d = abortDeps({
    issueLabels: async () => ["factory:awaiting-review"],
    lockHolder: async () => ({ present: true, runner: "gha-222", subject: "lock issue=15 stage=review runner=gha-222 at=t" }),
    release: vi.fn(async () => true), runRecord: (l) => lines.push(...l),
  });
  expect(await abort({ stage: "review", issue: 15, status: "failure", deps: d })).toBe(0);
  expect(d.transition).not.toHaveBeenCalled();
  expect(d.release).not.toHaveBeenCalled();
  expect(lines).toContain("lock: held by gha-222 — left alone");
  expect(lines.some((l) => /never owned the stage/.test(l))).toBe(true);
});

// ── ADR-020 KTB-29 — review의 K 한도(스펙 §3.2 `rework → needs_human: round > K`) ────────────────
// 데모 #18은 K=3인데 review 라운드 4에서 또 rework으로 갔다: `nextState`가 K를 아예 보지 않았다.
const reviewVerdictK = (role, kind) => ({
  role, verdict: kind, confidence: "high",
  must_fix: kind === "reject" ? [{ id: `MF-${role}`, where: "a.js:1", claim: "broken", evidence: "test fails" }] : [],
  should_fix: [], verified: [],
});
const kDeps = ({ round, verdicts, K = 3, ...over }) => baseDeps({
  buildContext: async () => ({ roster: ["correctness", "qa"], orchestration: "workflow", limits: { K } }),
  reviewRounds: async () => round - 1,
  verifyStage: () => ({ ok: true, reasons: [], data: { head_sha: "a".repeat(40), verdicts } }),
  writeHandoff: vi.fn(async () => {}), transition: vi.fn(async ({ to }) => ({ ok: true, to })),
  ...over,
});

test("KTB-29: a reject at round K goes to needs-human, not rework — with the must_fix count in the reason", async () => {
  const lines = [];
  const deps = kDeps({ round: 3, verdicts: [reviewVerdictK("correctness", "reject"), reviewVerdictK("qa", "reject")], runRecord: (l) => lines.push(...l) });
  expect(await runStage({ stage: "review", issue: 18, deps })).toBe(0);
  expect(deps.transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:needs-human", reason: "review rounds exhausted (K=3): 2 must_fix remain",
  }));
  expect(deps.writeHandoff).toHaveBeenCalled();                       // 판정 자체는 기록으로 남는다
});

// nit 9: `must_fix`는 이 런이 verdict를 집계했을 때만 찬다. 에이전트가 `decision`을 직접 실어 보내면
// 비어 있고, 그때 "0 must_fix remain"은 사람을 부르는 문장이 "아무 문제 없다"로 읽힌다.
test("nit9: the exhausted reason never reads '0 must_fix remain' — it names the verdict instead", () => {
  expect(reviewExhaustedReason({ decision: "rework", must_fix: [{ id: "a" }] }, 3)).toBe("review rounds exhausted (K=3): 1 must_fix remain");
  expect(reviewExhaustedReason({ decision: "rework" }, 3)).toBe("review rounds exhausted (K=3): last verdict: rework");
  expect(reviewExhaustedReason({}, 3)).toBe("review rounds exhausted (K=3): last verdict: unknown");
});

test("KTB-29: a reject below K still goes to rework (unchanged)", async () => {
  const deps = kDeps({ round: 2, verdicts: [reviewVerdictK("correctness", "reject"), reviewVerdictK("qa", "approve")] });
  expect(await runStage({ stage: "review", issue: 18, deps })).toBe(0);
  expect(deps.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:rework" }));
});

test("KTB-29: an approve is approved at any round — K never blocks a passing review", async () => {
  for (const round of [1, 3, 7]) {
    const deps = kDeps({ round, verdicts: [reviewVerdictK("correctness", "approve"), reviewVerdictK("qa", "approve")] });
    expect(await runStage({ stage: "review", issue: 18, deps }), `round ${round}`).toBe(0);
    expect(deps.transition, `round ${round}`).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:approved" }));
  }
});

test("KTB-29: nextState is pure — K only bites on a non-approved review with an integer round", () => {
  expect(nextState("review", { decision: "approved", round: 9 }, { maxRounds: 3 })).toBe("factory:approved");
  expect(nextState("review", { decision: "rework", round: 3 }, { maxRounds: 3 })).toBe("factory:needs-human");
  expect(nextState("review", { decision: "rework", round: 4 }, { maxRounds: 3 })).toBe("factory:needs-human");
  expect(nextState("review", { decision: "rework", round: 2 }, { maxRounds: 3 })).toBe("factory:rework");
  expect(nextState("review", { decision: "rework", round: 9 })).toBe("factory:rework");            // K 미상 → 예전 동작
  expect(nextState("review", { decision: "rework" }, { maxRounds: 3 })).toBe("factory:rework");     // round 미상 → 예전 동작
  expect(nextState("implement", {})).toBe("factory:awaiting-review");
});

// §12.4 지표(O21): 같은 역할이 라운드 사이에 판정을 뒤집는 빈도. 앞 라운드의 review handoff와 비교한다.
test("KTB-29: per-role verdict flips against the previous review handoff are recorded", () => {
  const prev = [{ role: "correctness", verdict: "approve" }, { role: "spec-conformance", verdict: "reject" }, { role: "qa", verdict: "approve" }];
  const now = [{ role: "correctness", verdict: "reject" }, { role: "spec-conformance", verdict: "approve" }, { role: "qa", verdict: "approve" }];
  expect(reviewFlips(prev, now)).toEqual(["correctness approve→reject", "spec-conformance reject→approve"]);
  expect(reviewFlips(prev, prev)).toEqual([]);
  expect(reviewFlips(null, now)).toEqual([]);                          // 앞 라운드가 없으면 뒤집힘도 없다
  expect(reviewFlips(prev, [{ role: "new-role", verdict: "reject" }])).toEqual([]);   // 새 역할은 뒤집힘이 아니다
});

test("KTB-29: the flips line lands in the run record, and an unreadable lookup never fails the stage", async () => {
  const lines = [];
  const deps = kDeps({
    round: 2, verdicts: [reviewVerdictK("correctness", "reject"), reviewVerdictK("qa", "approve")],
    priorReviewVerdicts: async () => [{ role: "correctness", verdict: "approve" }, { role: "qa", verdict: "approve" }],
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 18, deps })).toBe(0);
  expect(lines).toContain("review flips: correctness approve→reject");

  const broken = [];
  const d2 = kDeps({
    round: 2, verdicts: [reviewVerdictK("correctness", "approve"), reviewVerdictK("qa", "approve")],
    priorReviewVerdicts: async () => { throw new Error("gh down"); }, runRecord: (l) => broken.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 18, deps: d2 })).toBe(0);
  expect(broken.some((l) => /review flips: unreadable — gh down/.test(l))).toBe(true);
});

/**
 * ADR-020 KTB-35 — **테스트가 하나도 깨지지 않은 RED는 사람에게 다르게 말해야 한다.**
 *
 * 라이브(KTB #3 implement R2, run 34809992796): `unit`이 code 1로 RED인데 `unit.json`은 1715/1715
 * 통과였다. 그 런이 사람에게 남긴 문장은 `stage artifact missing or invalid: gates RED: failing=unit` —
 * "테스트가 깨졌다"고 읽히는데 깨진 테스트는 없었다. 등급도 틀렸다: 이것은 설계 오류가 아니라 대개
 * 일시적 인프라(포크된 워커의 stderr EPIPE)이므로, `needs-human`이 아니라 `blocked`(cause
 * `gates-unhandled`)으로 세우고 KTB-15b 경로가 같은 스테이지를 **한 번** 다시 돌린다.
 */
test("KTB-35: a test gate that exited ≠0 with 0 failing tests → blocked(cause=gates-unhandled), reason names the cause", async () => {
  const lines = [];
  const reason = "command exited 1 with 0 failing tests — unhandled error outside tests (see gate log)";
  const gates = {
    schema: "factory.gates.v1", level: "full", status: "RED", failing: ["unit"], passed: 3, failed: 1, skipped: [], misconfigured: [],
    tests: { total: 1715, passed: 1715, failed: 0, failing: [], excluded: [] },
    gates: { unit: { status: "RED", code: 1, reason, log: "Error: write EPIPE" } },
  };
  const d = implDeps({ gates: async () => gates, runRecord: (l) => lines.push(...l) });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason, cause: "gates-unhandled" }));
  expect(d.transition).not.toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human" }));
  expect(lines.some((l) => /gates: RED \(unhandled\)/.test(l))).toBe(true);
  expect(lines.some((l) => /FACTORY_GATES: .*status=RED/.test(l))).toBe(true);   // 판정 줄은 그대로 남는다
  // 판정 줄 그대로의 옛 문장은 더 이상 나가지 않는다
  expect(d.transition).not.toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining("stage artifact missing or invalid") }));
});

test("KTB-35: unhandledGateReason picks the first gate carrying the marker, and stays silent otherwise", () => {
  const reason = "command exited 1 with 0 failing tests — unhandled error outside tests (see gate log)";
  expect(unhandledGateReason({ status: "RED", gates: { lint: { status: "GREEN" }, unit: { status: "RED", reason } } })).toBe(reason);
  expect(unhandledGateReason({ status: "RED", gates: { unit: { status: "RED" } } })).toBe(null);
  expect(unhandledGateReason({ status: "GREEN", gates: { unit: { status: "GREEN", reason } } })).toBe(null);
  expect(unhandledGateReason(null)).toBe(null);
  expect(unhandledGateReason({ status: "RED" })).toBe(null);
});

// ── 리뷰 batch-1 잠정 tier 바닥(Task 4까지) ──────────────────────────────────────────────────────
// 로스터 크기 = 정족수이고, 그 크기는 tier가 정한다. tier가 triage 에이전트의 **자기 신고**에서만
// 나오면 낮춰 신고하는 것만으로 로스터도, 머지 스테이지가 강제하는 정족수도 함께 줄어든다(감사 H3).
// `gates.json`의 `tier_effective`는 이미 diff로 계산된 바닥인데 아무도 읽지 않았다.
test("review roster tier: the triage self-report can raise the tier but never lower it below the gates floor", () => {
  // 코드를 건드린 PR을 "docs"라고 신고해도 로스터는 standard의 것이다.
  expect(reviewTier({ claimed: "docs", floor: "standard" })).toBe("standard");
  expect(reviewTier({ claimed: "docs", floor: "load-bearing" })).toBe("load-bearing");
  expect(reviewTier({ claimed: "standard", floor: "load-bearing" })).toBe("load-bearing");
  // 올리는 방향은 그대로 존중한다 — 자기 신고는 더 엄격해질 수는 있다.
  expect(reviewTier({ claimed: "load-bearing", floor: "docs" })).toBe("load-bearing");
  expect(reviewTier({ claimed: "standard", floor: "docs" })).toBe("standard");
  // 바닥이 없으면(게이트 파일이 없는 경로) 오늘의 동작 그대로다.
  expect(reviewTier({ claimed: "docs", floor: null })).toBe("docs");
  // 모르는 값은 docs로 기울지 않는다 — 약한 쪽으로 기우는 정규화는 자기 신고를 그대로 믿는 것과 같다.
  expect(reviewTier({ claimed: "weird", floor: "standard" })).toBe("standard");
  expect(reviewTier({ claimed: "weird", floor: "weird" })).toBe("standard");
});


// ── 최종 리뷰 B-MF1 / A-SF1 — run-stage의 두 이음매 ────────────────────────────────────────────

import { transition as realTransition } from "../lib/transition.js";
import { REHEARSAL_UNWIRED } from "../lib/transition.js";
import { QA_SHORTFALL_ID } from "../bin/run-stage.js";

/**
 * B-MF1 — **triage의 blocked 재시도 hop은 `factory:queue`를 겨눈다.** 모든 스테이지 전이가 모이는
 * `deps.transition`은 `transition()`의 여섯 번째 프로덕션 호출자인데 리허설 검사기가 배선돼 있지
 * 않았다. `transition()`은 배선 없는 큐 전이를 fail closed로 거부하므로 보안 구멍은 아니지만, 그 hop은
 * **영원히** 거부된다 — 리허설을 새로 GREEN으로 돌려도 풀리지 않는다(값이 낡은 게 아니라 인자가 없다).
 * 결과는 triage 스테이지의 인프라 딸꾹질 하나마다 R번의 재시도와 사람 에스컬레이션이다.
 *
 * 여기서는 그 hop을 **진짜 `transition()`으로** 돌린다 — 배선된 자리의 모양 그대로.
 */
const blockedTriageDeps = ({ gh, rehearsal }) => ({
  charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }),
  heartbeat: async () => ({ stop() {} }), release: async () => {}, runRecord: () => {},
  issueLabels: async () => ["factory:blocked"],
  blockedOrigin: async () => ({ from: "factory:queue", stage: "triage" }),
  // `main()`이 만드는 자리와 같은 모양: 모든 스테이지 전이가 여기로 모이고, 검사기가 함께 실린다.
  transition: async ({ to, reason, prerequisite = false }) => realTransition({
    gh, issue: 7, to, reason, stage: "triage",
    ctxExtra: { gatesChecked: true, ...(prerequisite ? { prerequisite: true } : {}) },
    ...(rehearsal === undefined ? {} : { rehearsal }),
  }),
  // hop 이후로는 가지 않는다 — 이 테스트가 보는 것은 hop 하나다.
  assertHandoff: async () => ({ ok: false, reason: "stop here" }),
});

const blockedGh = () => ({
  issue: vi.fn(async () => ({ number: 7, title: "t", body: "", labels: ["factory:blocked"] })),
  comments: vi.fn(async () => []),
  setFactoryLabel: vi.fn(async () => {}),
  comment: vi.fn(async () => "url#issuecomment-1"),
});

test("B-MF1: the triage blocked-retry hop passes with a GREEN rehearsal checker wired into deps.transition", async () => {
  const gh = blockedGh();
  const lines = [];
  const deps = { ...blockedTriageDeps({ gh, rehearsal: async () => ({ ok: true, source: "variable" }) }), runRecord: (l) => lines.push(...l) };
  await runStage({ stage: "triage", issue: 7, deps });
  expect(gh.setFactoryLabel).toHaveBeenCalledWith(7, "factory:queue");
  expect(lines.some((l) => /triage: blocked retry — hopped back to factory:queue/.test(l))).toBe(true);
});

test("B-MF1: a stale rehearsal refuses the same hop — and an UNWIRED deps.transition is the regression this closes", async () => {
  // (a) 낡은 리허설: 거부는 정상이고, 사람이 `factory rehearse`를 돌리면 풀린다.
  const staleGh = blockedGh();
  const staleLines = [];
  const stale = { ...blockedTriageDeps({ gh: staleGh, rehearsal: async () => ({ ok: false, reason: `${REHEARSAL_STALE} — recorded abc, current def` }) }), runRecord: (l) => staleLines.push(...l) };
  expect(await runStage({ stage: "triage", issue: 7, deps: stale })).toBe(2);
  expect(staleGh.setFactoryLabel).not.toHaveBeenCalled();
  expect(staleLines.join("\n")).toMatch(REHEARSAL_STALE);

  // (b) 배선이 아예 없으면 사유는 "리허설이 낡았다"가 아니라 **배선 오류**다 — 그리고 그 상태는
  //     새 GREEN 리허설로도 풀리지 않는다. 이것이 B-MF1이 닫은 실패다.
  const unwiredGh = blockedGh();
  const unwiredLines = [];
  const unwired = { ...blockedTriageDeps({ gh: unwiredGh, rehearsal: undefined }), runRecord: (l) => unwiredLines.push(...l) };
  expect(await runStage({ stage: "triage", issue: 7, deps: unwired })).toBe(2);
  expect(unwiredGh.setFactoryLabel).not.toHaveBeenCalled();
  expect(unwiredLines.join("\n")).toMatch(REHEARSAL_UNWIRED);
});

/**
 * A-SF1 — **qa 증거 부족은 이 라운드의 reject이지 스테이지의 실패가 아니다.** 예전에는 `verify-stage`가
 * 그 부족을 `reasons`로 내보냈고, run-stage가 다른 분기의 기본 접두어(`stage artifact missing or
 * invalid`)를 붙여 `factory:needs-human`으로 보냈다 — 산출물은 멀쩡한데 산출물 탓을 했고, 리뷰어 넷이
 * 돈 라운드를 버리고 **한 라운드 더 돌면 풀릴 일**을 사람에게 올렸다(등급이 판단이 아니라 누락이었다).
 */
const qaShortfallDeps = ({ transition, record, round = 1, maxRounds = 3 }) => ({
  charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }),
  resetGates: async () => {}, assertHandoff: async () => ({ ok: true }),
  heartbeat: async () => ({ stop() {} }), resetAgentsLog: async () => {},
  buildContext: async () => ({ roster: ["correctness", "qa"], orchestration: "workflow", limits: { K: maxRounds } }),
  claudeP: async () => ({ is_error: false, result: "{}" }),
  gates: async () => null,
  reviewRounds: async () => round - 1,
  verifyStage: () => ({
    ok: true, reasons: [], source: "result",
    data: {
      schema: "factory.review.v1", issue: 7, pr: 9, head_sha: "a".repeat(40), round,
      orchestration: "workflow", guarantee: "verified",
      verdicts: [
        { role: "correctness", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: ["read it"] },
        { role: "qa", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: ["dw1 reproduced"] },
      ],
    },
    qaShortfall: { ids: ["dw2", "dw4"], reason: "qa evidence incomplete: spec-evidence-missing: dw2, dw4; the qa reviewer records it with `node .factory/bin/qa-evidence.js record|attach|na` and checks it with `finish`" },
  }),
  writeHandoff: async () => {}, transition, runRecord: record, release: async () => {},
});

test("A-SF1: a qa-only shortfall becomes a synthetic must_fix and the round goes to factory:rework", async () => {
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const lines = [];
  const code = await runStage({ stage: "review", issue: 7, deps: qaShortfallDeps({ transition, record: (l) => lines.push(...l) }) });
  expect(code).toBe(0);
  const call = transition.mock.calls.at(-1)[0];
  expect(call.to).toBe("factory:rework");
  expect(call.data.decision).toBe("rework");
  const mf = call.data.must_fix.find((m) => m.id === QA_SHORTFALL_ID);
  expect(mf.by).toBe("qa");                                         // 역할이 이름으로 실린다
  expect(mf.evidence).toMatch(/dw2, dw4/);                          // 부족한 id가 이름으로 실린다
  expect(mf.claim.startsWith("qa evidence incomplete:")).toBe(true);
  // 절대 쓰지 않는 두 문장: 산출물 탓, 그리고 누락으로 정해진 needs-human.
  expect(lines.join("\n")).not.toMatch(/stage artifact missing or invalid/);
  expect(transition.mock.calls.every((c) => c[0].to !== "factory:needs-human")).toBe(true);
  expect(lines.join("\n")).toMatch(/qa evidence incomplete: spec-evidence-missing: dw2, dw4/);
});

test("A-SF1: at the K limit the same shortfall takes the normal K path, not a stage failure", async () => {
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const lines = [];
  await runStage({ stage: "review", issue: 7, deps: qaShortfallDeps({ transition, record: (l) => lines.push(...l), round: 3, maxRounds: 3 }) });
  const call = transition.mock.calls.at(-1)[0];
  expect(call.to).toBe("factory:needs-human");
  expect(call.reason).toMatch(/review rounds/);                     // K의 문장이지 산출물의 문장이 아니다
  expect(lines.join("\n")).not.toMatch(/stage artifact missing or invalid/);
});
