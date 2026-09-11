import { test, expect, vi } from "vitest";
import { runStage, buildCtxExtra, mergeGates, usageLine, GATES_SELF_REPORTED } from "../bin/run-stage.js";
import { renderHandoff } from "../lib/handoff.js";
import { verifyStage } from "../lib/verify-stage.js";
import { requirementFor } from "../lib/requirements.js";

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
  const assertHandoff = vi.fn(async () => requirementFor("factory:approved")({ issue: 7, comments }));   // run-stage/main()과 같은 ctx: gatesChecked 없음
  const lines = [];
  const d = baseDeps({ assertHandoff, resetGates: async () => {}, runRecord: (l) => lines.push(...l) });
  expect(await runStage({ stage: "merge", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect((await assertHandoff()).ok).toBe(true);
  expect(lines.some((l) => /assert: FAIL/.test(l))).toBe(false);
  // 반대로 전이 경로(gatesChecked)에서는 같은 handoff라도 게이트 파일을 요구한다
  expect(requirementFor("factory:approved")({ issue: 7, comments, gatesChecked: true }).reason).toMatch(/gates file missing/);
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

test("C1: states with no commit binding get the plain ctxExtra and make no gh calls", async () => {
  const gh = { branchHeadSha: vi.fn(), comments: vi.fn(), prHeadSha: vi.fn() };
  const x = await buildCtxExtra({ gh, issue: 7, to: "factory:in-progress", ctx: { roster: ["a"] }, charter: { limits: { K: 5 } } });
  expect(x).toEqual({ issue: 7, roster: ["a"], expectedRounds: undefined, rosterSize: 1, maxRounds: 5 });
  expect(gh.branchHeadSha).not.toHaveBeenCalled();
  expect(gh.comments).not.toHaveBeenCalled();
});
