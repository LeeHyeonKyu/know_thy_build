import { test, expect, vi } from "vitest";
import { runMergeStage } from "../lib/merge-stage.js";

/** runStage의 record/refusal과 같은 모양 — 실제 계약을 그대로 흉내낸다. */
const refusal = (t) => (t.ok ? [] : [`transition refused: ${t.reason}`]);
const makeRecord = () => { const lines = []; const record = (ls) => lines.push(...ls); return { lines, record }; };

const baseD = (over = {}) => ({
  prInfo: vi.fn(async () => ({ number: 9, state: "OPEN", mergeable: "MERGEABLE" })),
  gates: vi.fn(async () => ({ schema: "factory.gates.v1", level: "full", status: "GREEN", head_sha: "a".repeat(40), passed: 3, failed: 0, skipped: [], misconfigured: [], tests: { excluded: [] } })),
  mergeGates: vi.fn(async () => ({ checksGreen: true, integrityGreen: true })),
  mergePr: vi.fn(async () => {}),
  transition: vi.fn(async ({ to }) => ({ ok: true, to })),
  closeIssue: vi.fn(async () => {}),
  reportStatus: vi.fn(async () => {}),
  ...over,
});

// ── (1) prInfo ───────────────────────────────────────────────────────────

test("(1) no PR in the implement handoff → needs-human, no further steps", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ prInfo: vi.fn(async () => null) });
  const code = await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human" }));
  expect(d.gates).not.toHaveBeenCalled();
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(d.closeIssue).not.toHaveBeenCalled();
  expect(lines.length).toBeGreaterThan(0);
});

test("(1) PR not OPEN (e.g. CLOSED) → needs-human naming the state", async () => {
  const { record } = makeRecord();
  const d = baseD({ prInfo: vi.fn(async () => ({ number: 9, state: "CLOSED", mergeable: "MERGEABLE" })) });
  const code = await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: expect.stringMatching(/CLOSED/) }));
  expect(d.gates).not.toHaveBeenCalled();
});

// ── (2) conflict ─────────────────────────────────────────────────────────

test("(2) mergeable CONFLICTING → transition to factory:rework naming the default branch", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ prInfo: vi.fn(async () => ({ number: 9, state: "OPEN", mergeable: "CONFLICTING" })) });
  const code = await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:rework", reason: "merge conflict — rebase onto main" }));
  expect(d.gates).not.toHaveBeenCalled();
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(lines.length).toBeGreaterThan(0);
});

// ── (3) gates ────────────────────────────────────────────────────────────

test("(3) gates BLOCKED → factory:blocked; factory/gates status posted as failure (best-effort)", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ gates: vi.fn(async () => ({ schema: "factory.gates.v1", status: "BLOCKED", blocked_reason: "cannot classify", head_sha: "a".repeat(40) })) });
  const code = await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: "cannot classify" }));
  expect(d.reportStatus).toHaveBeenCalledWith(expect.objectContaining({ context: "factory/gates", state: "failure" }));
  expect(d.mergeGates).not.toHaveBeenCalled();
  expect(lines.length).toBeGreaterThan(0);
});

test("(3) gates non-GREEN (RED) → needs-human 'gates RED at merge'; status posted as failure", async () => {
  const { record } = makeRecord();
  const d = baseD({ gates: vi.fn(async () => ({ schema: "factory.gates.v1", status: "RED", head_sha: "a".repeat(40) })) });
  const code = await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: "gates RED at merge" }));
  expect(d.reportStatus).toHaveBeenCalledWith(expect.objectContaining({ context: "factory/gates", state: "failure" }));
  expect(d.mergeGates).not.toHaveBeenCalled();
});

test("(3) gates GREEN → factory/gates status posted as success, flow continues", async () => {
  const { record } = makeRecord();
  const d = baseD();
  const code = await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal });
  expect(code).toBe(0);
  expect(d.reportStatus).toHaveBeenCalledWith(expect.objectContaining({ context: "factory/gates", state: "success" }));
});

test("(3) reportStatus is best-effort — a throw is recorded but the stage keeps going", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ reportStatus: vi.fn(async () => { throw new Error("network down"); }) });
  const code = await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal });
  expect(code).toBe(0);
  expect(lines.some((l) => /status: factory\/gates post failed — network down/.test(l))).toBe(true);
});

test("(3) reportStatus is optional — its absence never throws", async () => {
  const { record } = makeRecord();
  const d = baseD({ reportStatus: undefined });
  const code = await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal });
  expect(code).toBe(0);
});

// ── (4) mergeGates ───────────────────────────────────────────────────────

test("(4) checksGreen false → needs-human 'required checks not GREEN'", async () => {
  const { record } = makeRecord();
  const d = baseD({ mergeGates: vi.fn(async () => ({ checksGreen: false, integrityGreen: true })) });
  const code = await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: "required checks not GREEN" }));
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("(4) integrityGreen false (checks fine) → needs-human 'integrity not GREEN'", async () => {
  const { record } = makeRecord();
  const d = baseD({ mergeGates: vi.fn(async () => ({ checksGreen: true, integrityGreen: false })) });
  const code = await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: "integrity not GREEN" }));
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("(4) both flags unset (lookup failed, fail closed) → needs-human naming checks first", async () => {
  const { record } = makeRecord();
  const d = baseD({ mergeGates: vi.fn(async () => ({})) });
  const code = await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: "required checks not GREEN" }));
});

// ── (5) mergePr ──────────────────────────────────────────────────────────

test("(5) mergePr throws → factory:blocked 'merge API failed: …'", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ mergePr: vi.fn(async () => { throw new Error("HTTP 405: not mergeable"); }) });
  const code = await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: "merge API failed: HTTP 405: not mergeable" }));
  expect(d.closeIssue).not.toHaveBeenCalled();
  // step 6/7's transition (factory:merged) never runs after mergePr fails
  expect(d.transition).not.toHaveBeenCalledWith(expect.objectContaining({ to: "factory:merged" }));
  expect(lines.length).toBeGreaterThan(0);
});

// ── (6) transition → factory:merged, mergeGatesResult passthrough ──────────

test("(6) transition to factory:merged carries the already-computed mergeGates result", async () => {
  const { record } = makeRecord();
  const mg = { checksGreen: true, integrityGreen: true };
  const d = baseD({ mergeGates: vi.fn(async () => mg) });
  await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal });
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:merged", mergeGatesResult: mg }));
});

test("(6) a refused merged-transition is only recorded — merge already happened, irreversible; step 7 still runs, exit 0", async () => {
  const { lines, record } = makeRecord();
  const transition = vi.fn(async ({ to }) => (to === "factory:merged" ? { ok: false, reason: "requirement drifted" } : { ok: true, to }));
  const d = baseD({ transition });
  const code = await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal });
  expect(code).toBe(0);
  expect(d.mergePr).toHaveBeenCalled();
  expect(d.closeIssue).toHaveBeenCalled();          // PR is already merged — we still close the tracking issue
  expect(lines.some((l) => /transition refused: requirement drifted/.test(l))).toBe(true);
});

// ── (7) closeIssue ───────────────────────────────────────────────────────

test("(7) closeIssue is called with the PR number from prInfo", async () => {
  const { record } = makeRecord();
  const d = baseD({ prInfo: vi.fn(async () => ({ number: 42, state: "OPEN", mergeable: "MERGEABLE" })) });
  await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal });
  expect(d.closeIssue).toHaveBeenCalledWith(42);
});

// ── happy path: full order + record lines for every step ───────────────────

test("happy path: calls prInfo → gates → mergeGates → mergePr → transition(merged) → closeIssue, in order, exit 0", async () => {
  const calls = [];
  const d = baseD({
    prInfo: vi.fn(async () => { calls.push("prInfo"); return { number: 9, state: "OPEN", mergeable: "MERGEABLE" }; }),
    gates: vi.fn(async () => { calls.push("gates"); return { schema: "factory.gates.v1", status: "GREEN", head_sha: "a".repeat(40) }; }),
    mergeGates: vi.fn(async () => { calls.push("mergeGates"); return { checksGreen: true, integrityGreen: true }; }),
    mergePr: vi.fn(async () => { calls.push("mergePr"); }),
    transition: vi.fn(async ({ to }) => { calls.push(`transition:${to}`); return { ok: true, to }; }),
    closeIssue: vi.fn(async () => { calls.push("closeIssue"); }),
  });
  const { lines, record } = makeRecord();
  const code = await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal });
  expect(code).toBe(0);
  expect(calls).toEqual(["prInfo", "gates", "mergeGates", "mergePr", "transition:factory:merged", "closeIssue"]);
  expect(d.closeIssue).toHaveBeenCalledWith(9);
  // 7단계 각각의 흔적이 런 레코드에 남는다
  expect(lines.length).toBeGreaterThanOrEqual(7);
});
