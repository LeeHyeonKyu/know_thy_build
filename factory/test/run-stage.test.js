import { test, expect, vi } from "vitest";
import { runStage } from "../bin/run-stage.js";

test("run-stage executes the §4.2.1 skeleton in order and transitions on success", async () => {
  const calls = [];
  const deps = {
    charterReady: vi.fn(async () => { calls.push("charter"); return true; }),
    trustWorkspace: vi.fn(async () => calls.push("trust")),
    claim: vi.fn(async () => { calls.push("claim"); return { ok: true }; }),
    assertHandoff: vi.fn(async () => { calls.push("assert"); return { ok: true }; }),
    buildContext: vi.fn(async () => { calls.push("context"); return { roster: ["correctness"], rounds: undefined, orchestration: "workflow", limits: { K: 3 } }; }),
    heartbeat: vi.fn(async () => { calls.push("heartbeat"); return { stop: () => calls.push("heartbeat-stop") }; }),
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
  expect(calls).toEqual(["charter", "trust", "claim", "heartbeat", "assert", "context", "claude", "gates", "verify", "handoff", "transition", "record", "heartbeat-stop", "release"]);
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
    claudeP: async () => { calls.push("claude"); return { is_error: false, result: "{}" }; },
    gates: async () => { calls.push("gates"); return null; },
    verifyStage: () => { calls.push("verify"); return { ok: true, reasons: [], data: {} }; },
    writeHandoff: async () => calls.push("handoff"),
    transition,
    runRecord: () => calls.push("record"),
    release: async () => calls.push("release"),
  };
  expect(await runStage({ stage: "implement", issue: 9, deps, runnerId: "runner-1" })).toBe(0);
  expect(calls).toEqual(["charter", "trust", "claim", "heartbeat", "assert", "transition", "context", "claude", "gates", "verify", "handoff", "transition", "record", "heartbeat-stop", "release"]);
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
