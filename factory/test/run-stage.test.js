import { test, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runStage, buildCtxExtra, mergeGates, usageLine, makeCheckoutHead, GATES_SELF_REPORTED, MergeBaseError, MERGE_BASE_BLOCKED_REASON, GIT_DIFF_BLOCKED_REASON, gateOutputPaths, resetGateOutputs } from "../bin/run-stage.js";
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

test("I4: unverified gates are declared as self-reported on implement/review/merge, not on plan", async () => {
  for (const stage of ["implement", "review", "merge"]) {
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
  const d = baseDeps({ assertHandoff, resetGates: async () => {}, runRecord: (l) => lines.push(...l) });
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

// ── Task 12: review·merge — PR head checkout (R6) ───────────────────────────

const checkoutBaseDeps = (over = {}) => baseDeps({
  buildContext: async () => { return { roster: [], orchestration: "workflow", limits: { K: 3 } }; },
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
  const d = checkoutBaseDeps({ checkoutHead });
  expect(await runStage({ stage: "merge", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(checkoutHead).toHaveBeenCalledTimes(1);
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
