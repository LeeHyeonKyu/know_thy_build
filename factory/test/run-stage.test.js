import { test, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runStage, buildCtxExtra, mergeGates, usageLine, makeCheckoutHead, makeLocalEntry, GATES_SELF_REPORTED, MergeBaseError, MERGE_BASE_BLOCKED_REASON, GIT_DIFF_BLOCKED_REASON, gateOutputPaths, resetGateOutputs, isNoWriteStage, assertNoWriteStageClean, stageMaxTurns, DEFAULT_MAX_TURNS, stageClaudeArgs, stageClaudeEnv, ciSettingsFile, CI_SETTINGS, CI_SETTINGS_HARNESS } from "../bin/run-stage.js";
import { GitDiffError } from "../lib/changed-files.js";
import { renderHandoff } from "../lib/handoff.js";
import { verifyStage } from "../lib/verify-stage.js";
import { requirementFor } from "../lib/requirements.js";
import { makeFakeRun } from "../lib/exec.js";

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

test("claim failure exits 0 without doing work; verify failure → transition to needs-human, exit 2", async () => {
  const base = (over) => ({
    charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }), assertHandoff: async () => ({ ok: true }),
    buildContext: async () => ({ roster: [], orchestration: "workflow", limits: {} }), heartbeat: async () => ({ stop() {} }),
    claudeP: async () => ({ is_error: false, result: "{}" }), gates: async () => null,
    verifyStage: () => ({ ok: true, reasons: [], data: {} }), writeHandoff: async () => {}, transition: vi.fn(async () => ({ ok: true })),
    runRecord: () => {}, release: async () => {}, ...over });
  const d1 = base({ claim: async () => ({ ok: false, holder: "other" }), claudeP: vi.fn() });
  expect(await runStage({ stage: "review", issue: 7, deps: d1 })).toBe(0);
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

test("I7: the review round is counted from prior handoffs, so K bites", async () => {
  const lines = [];
  const transition = vi.fn(async ({ data, to }) => (data?.round > 3 ? { ok: false, reason: `round ${data.round} > K=3` } : { ok: true, to }));
  const deps = baseDeps({
    stage: "review",
    buildContext: async () => ({ roster: ["a"], orchestration: "workflow", limits: { K: 3 } }),
    countHandoffs: async (s) => (s === "review" ? 3 : 0),               // 이미 3라운드를 돌았다
    verifyStage: () => ({ ok: true, reasons: [], data: { round: 1, verdicts: [{ role: "a", verdict: "approve", must_fix: [] }] } }),
    writeHandoff: vi.fn(async () => {}), transition, runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 7, deps })).toBe(2);
  expect(deps.writeHandoff).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ round: 4 }) }));
  expect(lines.some((l) => /transition refused: .*round/.test(l))).toBe(true);
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
  expect(await runStage({ stage: "triage", issue: 7, deps })).toBe(0);
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

test("I2: an unreadable label set never blocks the stage — the guard is a cost defense, not a safety gate", async () => {
  const lines = [];
  const d = baseDeps({
    issueLabels: async () => { throw new Error("gh issue view failed"); },
    claudeP: vi.fn(async () => ({ is_error: false, result: "{}" })), runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "plan", issue: 5, deps: d })).toBe(0);
  expect(d.claudeP).toHaveBeenCalled();
  expect(lines.some((l) => /entry state: unreadable — gh issue view failed/.test(l))).toBe(true);
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

test("KTB-20: an unreadable label set falls back to the narrower settings (not the variant)", async () => {
  const seen = [];
  const d = baseDeps({
    issueLabels: async () => { throw new Error("gh issue view failed"); },
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
  // 나머지 인자는 한 글자도 달라지지 않는다 — 바뀌는 것은 `--settings` 값 하나뿐이다.
  expect(harness.map((a) => (a.endsWith("ci-settings-harness.json") ? "SETTINGS" : a)))
    .toEqual(normal.map((a) => (a.endsWith("ci-settings.json") ? "SETTINGS" : a)));
  expect(stageClaudeEnv({ root: "/r", harnessIssue: true }).FACTORY_HARNESS_ISSUE).toBe("1");
  expect(ciSettingsFile(true)).toBe(CI_SETTINGS_HARNESS);
  expect(ciSettingsFile(false)).toBe(CI_SETTINGS);
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
  const entry = makeLocalEntry({ gh, issue: 12, stage: "triage", env: { FACTORY_LOCAL_ENTRY: "1" } });
  const line = await entry();
  expect(line).toBe("local entry: backlog → factory:queue");
  expect(setFactoryLabel).toHaveBeenCalledWith(12, "factory:queue");
  expect(comment).toHaveBeenCalledWith(12, expect.stringContaining("<!-- factory-transition:v1 from=backlog to=factory:queue by=local -->"));
  expect(comment).toHaveBeenCalledWith(12, expect.stringContaining("backlog → factory:queue — claimed locally first (§4.2.5)"));
});

test("makeLocalEntry: issue already carries a factory label → no-op, returns null", async () => {
  const setFactoryLabel = vi.fn(async () => {});
  const comment = vi.fn(async () => {});
  const gh = { issue: async () => ({ number: 12, title: "t", body: "", labels: ["factory:ready"] }), setFactoryLabel, comment };
  const entry = makeLocalEntry({ gh, issue: 12, stage: "triage", env: { FACTORY_LOCAL_ENTRY: "1" } });
  expect(await entry()).toBeNull();
  expect(setFactoryLabel).not.toHaveBeenCalled();
  expect(comment).not.toHaveBeenCalled();
});

test("makeLocalEntry: backlog issue but no factory label and no backlog label either → no-op, returns null", async () => {
  const setFactoryLabel = vi.fn(async () => {});
  const comment = vi.fn(async () => {});
  const gh = { issue: async () => ({ number: 12, title: "t", body: "", labels: ["priority:p1"] }), setFactoryLabel, comment };
  const entry = makeLocalEntry({ gh, issue: 12, stage: "triage", env: { FACTORY_LOCAL_ENTRY: "1" } });
  expect(await entry()).toBeNull();
  expect(setFactoryLabel).not.toHaveBeenCalled();
});

test("makeLocalEntry: unlabeled issue → null, no gh mutation", async () => {
  const setFactoryLabel = vi.fn(async () => {});
  const comment = vi.fn(async () => {});
  const gh = { issue: async () => ({ number: 12, title: "t", body: "", labels: [] }), setFactoryLabel, comment };
  const entry = makeLocalEntry({ gh, issue: 12, stage: "triage", env: { FACTORY_LOCAL_ENTRY: "1" } });
  expect(await entry()).toBeNull();
  expect(setFactoryLabel).not.toHaveBeenCalled();
  expect(comment).not.toHaveBeenCalled();
});

test("makeLocalEntry: FACTORY_LOCAL_ENTRY unset → no-op, returns null, gh untouched", async () => {
  const setFactoryLabel = vi.fn(async () => {});
  const comment = vi.fn(async () => {});
  const gh = { issue: vi.fn(async () => ({ number: 12, title: "t", body: "", labels: ["backlog"] })), setFactoryLabel, comment };
  const entry = makeLocalEntry({ gh, issue: 12, stage: "triage", env: {} });
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
});

// ── C1: 커밋/PR 바인딩 ────────────────────────────────────────────────────

const implHandoff = (pr) => [{ id: 1, createdAt: "2026-09-11T00:00:00Z", body: renderHandoff({ stage: "implement", issue: 7, summary: "s", data: { pr } }) }];

test("C1: awaiting-review binds the branch head sha into ctxExtra", async () => {
  const gh = { branchHeadSha: vi.fn(async () => "a".repeat(40)), comments: vi.fn(), prHeadSha: vi.fn() };
  const x = await buildCtxExtra({ gh, issue: 7, to: "factory:awaiting-review", ctx: { roster: ["a", "b"], rounds: 3 }, charter: { limits: { K: 3 } } });
  expect(gh.branchHeadSha).toHaveBeenCalledWith("claude/fq-7");
  expect(x).toEqual({ issue: 7, roster: ["a", "b"], expectedRounds: 3, rosterSize: 2, maxRounds: 3, headSha: "a".repeat(40) });
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
  const x = await buildCtxExtra({ gh, issue: 7, to: "factory:in-progress", ctx: { roster: ["a"] }, charter: { limits: { K: 5 } } });
  expect(x).toEqual({ issue: 7, roster: ["a"], expectedRounds: undefined, rosterSize: 1, maxRounds: 5 });
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

/** merge는 checkoutBaseDeps 위에 runMergeStage의 7단계 deps(happy path)를 얹는다. */
const mergeHappyDeps = (over = {}) => checkoutBaseDeps({
  defaultBranch: "main",
  prInfo: async () => ({ number: 9, state: "OPEN", mergeable: "MERGEABLE" }),
  gates: async () => ({ schema: "factory.gates.v1", status: "GREEN", head_sha: "b".repeat(40) }),
  mergeGates: async () => ({ checksGreen: true, integrityGreen: true }),
  protectedPaths: async () => ({ ok: true, files: [] }),          // KTB-5: 보호 경로 없음 = 자동 머지 가능
  policyViolations: async () => ({ ok: true, files: [] }),        // KTB-6: 역할 섹션 규칙도 통과
  mergePr: async () => {}, closeIssue: async () => {},
  ...over,
});

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
  expect(lines.some((l) => /implement: blocked did not originate from planned\|in-progress — nothing to retry \(origin=queue\)/.test(l))).toBe(true);
});

test("KTB-15b: review never accepts factory:blocked as an entry label — no BLOCKED_RETRY entry for it", async () => {
  const transition = vi.fn();
  const d = baseDeps({ issueLabels: async () => ["factory:blocked"], transition });
  expect(await runStage({ stage: "review", issue: 7, deps: d })).toBe(0);
  expect(transition).not.toHaveBeenCalled();   // entry guard already returned 0 — "nothing to do"
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
