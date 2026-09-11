import { test, expect, vi } from "vitest";
import { runMergeStage } from "../lib/merge-stage.js";
import { canTransition } from "../lib/labels.js";
import { MergeBaseError } from "../lib/blocked-errors.js";
import { GitDiffError } from "../lib/changed-files.js";

/** runStage의 record/refusal과 같은 모양 — 실제 계약을 그대로 흉내낸다. */
const refusal = (t) => (t.ok ? [] : [`transition refused: ${t.reason}`]);
const makeRecord = () => { const lines = []; const record = (ls) => lines.push(...ls); return { lines, record }; };

/**
 * 진짜 라벨 그래프(canTransition)로 ok를 결정하는 transition mock — 순진하게 항상 ok:true를 돌려주면
 * "그래프에 없는 전이를 요청했다"는 버그(예: 예전에 factory:approved → factory:blocked 엣지가 없던 것)를
 * 테스트가 못 잡는다. merge-stage는 항상 factory:approved에서 시작한다(§review 통과 후).
 */
const graphTransition = (startFrom = "factory:approved") => {
  let from = startFrom;
  return vi.fn(async ({ to }) => {
    if (!canTransition(from, to)) return { ok: false, from, to, reason: `transition ${from} → ${to} not allowed` };
    from = to;
    return { ok: true, from, to };
  });
};

const baseD = (over = {}) => ({
  prInfo: vi.fn(async () => ({ number: 9, state: "OPEN", mergeable: "MERGEABLE" })),
  gates: vi.fn(async () => ({ schema: "factory.gates.v1", level: "full", status: "GREEN", head_sha: "a".repeat(40), passed: 3, failed: 0, skipped: [], misconfigured: [], tests: { excluded: [] } })),
  mergeGates: vi.fn(async () => ({ checksGreen: true, integrityGreen: true })),
  mergePr: vi.fn(async () => {}),
  transition: graphTransition(),
  closeIssue: vi.fn(async () => {}),
  sleep: vi.fn(async () => {}),
  ...over,
});
const basePostStatus = (over = {}) => Object.assign(vi.fn(async () => {}), over);
const run = (d, over = {}) => runMergeStage({ issue: 7, defaultBranch: "main", headSha: "b".repeat(40), d, record: over.record ?? makeRecord().record, refusal, postStatus: over.postStatus ?? basePostStatus() });

// ── (1) prInfo ───────────────────────────────────────────────────────────

test("(1) no PR in the implement handoff → needs-human, no further steps", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ prInfo: vi.fn(async () => null) });
  const code = await run(d, { record });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human" }));
  expect(d.gates).not.toHaveBeenCalled();
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(d.closeIssue).not.toHaveBeenCalled();
  expect(lines.length).toBeGreaterThan(0);
});

test("(1) PR not OPEN (e.g. CLOSED) → needs-human naming the state", async () => {
  const d = baseD({ prInfo: vi.fn(async () => ({ number: 9, state: "CLOSED", mergeable: "MERGEABLE" })) });
  const code = await run(d);
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: expect.stringMatching(/CLOSED/) }));
  expect(d.gates).not.toHaveBeenCalled();
});

// ── (2) mergeability: conflict / UNKNOWN re-poll ────────────────────────────

test("(2) mergeable CONFLICTING → transition to factory:rework naming the default branch", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ prInfo: vi.fn(async () => ({ number: 9, state: "OPEN", mergeable: "CONFLICTING" })) });
  const code = await run(d, { record });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:rework", reason: "merge conflict — rebase onto main" }));
  expect(d.gates).not.toHaveBeenCalled();
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(d.sleep).not.toHaveBeenCalled();               // 처음부터 CONFLICTING이면 재확인할 이유가 없다
  expect(lines.length).toBeGreaterThan(0);
});

test("(2) mergeable UNKNOWN → re-polls once after sleep(5000); becomes MERGEABLE → proceeds", async () => {
  const prInfo = vi.fn()
    .mockResolvedValueOnce({ number: 9, state: "OPEN", mergeable: "UNKNOWN" })
    .mockResolvedValueOnce({ number: 9, state: "OPEN", mergeable: "MERGEABLE" });
  const sleep = vi.fn(async () => {});
  const d = baseD({ prInfo, sleep });
  const code = await run(d);
  expect(code).toBe(0);
  expect(sleep).toHaveBeenCalledWith(5000);
  expect(prInfo).toHaveBeenCalledTimes(2);
  expect(d.mergePr).toHaveBeenCalled();
});

test("(2) mergeable UNKNOWN → re-poll still not MERGEABLE (still UNKNOWN) → needs-human, no merge", async () => {
  const { lines, record } = makeRecord();
  const prInfo = vi.fn(async () => ({ number: 9, state: "OPEN", mergeable: "UNKNOWN" }));
  const d = baseD({ prInfo, sleep: vi.fn(async () => {}) });
  const code = await run(d, { record });
  expect(code).toBe(2);
  expect(prInfo).toHaveBeenCalledTimes(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: "mergeability unknown after re-poll" }));
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(lines.some((l) => /re-polled/.test(l))).toBe(true);
});

test("(2) mergeable UNKNOWN → re-poll comes back CONFLICTING → rework, not needs-human", async () => {
  const prInfo = vi.fn()
    .mockResolvedValueOnce({ number: 9, state: "OPEN", mergeable: "UNKNOWN" })
    .mockResolvedValueOnce({ number: 9, state: "OPEN", mergeable: "CONFLICTING" });
  const d = baseD({ prInfo, sleep: vi.fn(async () => {}) });
  const code = await run(d);
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:rework" }));
  expect(d.mergePr).not.toHaveBeenCalled();
});

// ── (3) gates ────────────────────────────────────────────────────────────

test("(3) gates BLOCKED → factory:blocked; factory/gates status posted as failure (best-effort)", async () => {
  const { lines, record } = makeRecord();
  const postStatus = basePostStatus();
  const d = baseD({ gates: vi.fn(async () => ({ schema: "factory.gates.v1", status: "BLOCKED", blocked_reason: "cannot classify", head_sha: "a".repeat(40) })) });
  const code = await run(d, { record, postStatus });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: "cannot classify" }));
  expect(postStatus).toHaveBeenCalledWith(expect.objectContaining({ context: "factory/gates", state: "failure" }));
  expect(d.mergeGates).not.toHaveBeenCalled();
  expect(lines.length).toBeGreaterThan(0);
});

test("(3) gates non-GREEN (RED) → needs-human 'gates RED at merge'; status posted as failure", async () => {
  const postStatus = basePostStatus();
  const d = baseD({ gates: vi.fn(async () => ({ schema: "factory.gates.v1", status: "RED", head_sha: "a".repeat(40) })) });
  const code = await run(d, { postStatus });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: "gates RED at merge" }));
  expect(postStatus).toHaveBeenCalledWith(expect.objectContaining({ context: "factory/gates", state: "failure" }));
  expect(d.mergeGates).not.toHaveBeenCalled();
});

test("(3) gates null (no verdict at all) → needs-human 'gates missing at merge', never merges (F7)", async () => {
  const { lines, record } = makeRecord();
  const postStatus = basePostStatus();
  const d = baseD({ gates: vi.fn(async () => null) });
  const code = await run(d, { record, postStatus });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: "gates missing at merge" }));
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(d.mergeGates).not.toHaveBeenCalled();
  expect(postStatus).not.toHaveBeenCalledWith(expect.objectContaining({ context: "factory/gates" }));
  expect(lines.some((l) => /merge: gates missing/.test(l))).toBe(true);
});

test("(3) gates undefined → same fail-closed path as null", async () => {
  const d = baseD({ gates: vi.fn(async () => undefined) });
  expect(await run(d)).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: "gates missing at merge" }));
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("(3) gates GREEN → factory/gates status posted as success, flow continues", async () => {
  const postStatus = basePostStatus();
  const d = baseD();
  const code = await run(d, { postStatus });
  expect(code).toBe(0);
  expect(postStatus).toHaveBeenCalledWith(expect.objectContaining({ context: "factory/gates", state: "success" }));
});

test("(3) a diagnostic gates result is never posted as a status (same guard as run-stage's gated stages)", async () => {
  const postStatus = basePostStatus();
  const d = baseD({ gates: vi.fn(async () => ({ schema: "factory.gates.v1", status: "GREEN", diagnostic: true, head_sha: "a".repeat(40) })) });
  const code = await run(d, { postStatus });
  expect(code).toBe(0);
  expect(postStatus).not.toHaveBeenCalled();
});

test("(3) postStatus is injected from run-stage, not re-implemented — its absence never throws", async () => {
  const d = baseD();
  const code = await run(d, { postStatus: undefined });
  expect(code).toBe(0);
});

test("(3) gates() throwing MergeBaseError → factory:blocked with the typed-error reason, no re-throw", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ gates: vi.fn(async () => { throw new MergeBaseError("origin/main: exit 128"); }) });
  const code = await run(d, { record });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: "cannot compute merge-base (shallow clone?)" }));
  expect(lines.some((l) => /gates BLOCKED — cannot compute merge-base/.test(l))).toBe(true);
  expect(d.mergeGates).not.toHaveBeenCalled();
});

test("(3) gates() throwing GitDiffError → factory:blocked, same typed-error path", async () => {
  const d = baseD({ gates: vi.fn(async () => { throw new GitDiffError("fatal: bad revision"); }) });
  const code = await run(d);
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: "cannot compute diff" }));
});

test("(3) gates() throwing an unrelated error is NOT swallowed — it propagates", async () => {
  const d = baseD({ gates: vi.fn(async () => { throw new Error("gh exploded"); }) });
  await expect(run(d)).rejects.toThrow("gh exploded");
  expect(d.transition).not.toHaveBeenCalled();
});

// ── (4) mergeGates ───────────────────────────────────────────────────────

test("(4) checksGreen false → needs-human 'required checks not GREEN'", async () => {
  const d = baseD({ mergeGates: vi.fn(async () => ({ checksGreen: false, integrityGreen: true })) });
  const code = await run(d);
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: "required checks not GREEN" }));
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("(4) integrityGreen false (checks fine) → needs-human 'integrity not GREEN'", async () => {
  const d = baseD({ mergeGates: vi.fn(async () => ({ checksGreen: true, integrityGreen: false })) });
  const code = await run(d);
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: "integrity not GREEN" }));
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("(4) both flags false → needs-human names both reasons, joined", async () => {
  const d = baseD({ mergeGates: vi.fn(async () => ({})) });
  const code = await run(d);
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: "required checks not GREEN; integrity not GREEN" }));
});

test("(4) mergeGates() throwing MergeBaseError → factory:blocked, not swallowed as needs-human", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ mergeGates: vi.fn(async () => { throw new MergeBaseError(); }) });
  const code = await run(d, { record });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: "cannot compute merge-base (shallow clone?)" }));
  expect(lines.some((l) => /mergeGates BLOCKED/.test(l))).toBe(true);
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("(4) mergeGates() throwing GitDiffError → factory:blocked", async () => {
  const d = baseD({ mergeGates: vi.fn(async () => { throw new GitDiffError(); }) });
  const code = await run(d);
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: "cannot compute diff" }));
});

// ── (5) mergePr / head sha ───────────────────────────────────────────────

test("(5) mergePr throws → factory:blocked 'merge API failed: …'", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ mergePr: vi.fn(async () => { throw new Error("HTTP 405: not mergeable"); }) });
  const code = await run(d, { record });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: "merge API failed: HTTP 405: not mergeable" }));
  expect(d.closeIssue).not.toHaveBeenCalled();
  expect(d.transition).not.toHaveBeenCalledWith(expect.objectContaining({ to: "factory:merged" }));
  expect(lines.length).toBeGreaterThan(0);
});

test("(5) the merged sha is recorded before and after the merge call", async () => {
  const { lines, record } = makeRecord();
  const d = baseD();
  await runMergeStage({ issue: 7, defaultBranch: "main", headSha: "c".repeat(40), d, record, refusal, postStatus: basePostStatus() });
  expect(lines).toContain(`merge: head ${"c".repeat(7)}`);
  expect(lines).toContain(`merge: merged ${"c".repeat(7)} via PR #9`);
});

test("(5) no headSha given → falls back to gates().head_sha", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ gates: vi.fn(async () => ({ schema: "factory.gates.v1", status: "GREEN", head_sha: "d".repeat(40) })) });
  await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal, postStatus: basePostStatus() });
  expect(lines).toContain(`merge: head ${"d".repeat(7)}`);
});

test("(5) no sha anywhere → recorded as unknown, never invented", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ gates: vi.fn(async () => ({ schema: "factory.gates.v1", status: "GREEN" })) });
  await runMergeStage({ issue: 7, defaultBranch: "main", d, record, refusal, postStatus: basePostStatus() });
  expect(lines).toContain("merge: head unknown");
});

// ── (6) transition → factory:merged, mergeGatesResult passthrough ──────────

test("(6) transition to factory:merged carries the already-computed mergeGates result", async () => {
  const mg = { checksGreen: true, integrityGreen: true };
  const d = baseD({ mergeGates: vi.fn(async () => mg) });
  await run(d);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:merged", mergeGatesResult: mg }));
});

test("(6) a refused merged-transition is only recorded — merge already happened, irreversible; step 7 still runs, exit 0", async () => {
  const { lines, record } = makeRecord();
  const transition = vi.fn(async ({ to }) => (to === "factory:merged" ? { ok: false, reason: "requirement drifted" } : { ok: true, to }));
  const d = baseD({ transition });
  const code = await run(d, { record });
  expect(code).toBe(0);
  expect(d.mergePr).toHaveBeenCalled();
  expect(d.closeIssue).toHaveBeenCalled();          // PR is already merged — we still close the tracking issue
  expect(lines.some((l) => /transition refused: requirement drifted/.test(l))).toBe(true);
});

// ── (7) closeIssue ───────────────────────────────────────────────────────

test("(7) closeIssue is called with the PR number from prInfo", async () => {
  const d = baseD({ prInfo: vi.fn(async () => ({ number: 42, state: "OPEN", mergeable: "MERGEABLE" })) });
  await run(d);
  expect(d.closeIssue).toHaveBeenCalledWith(42);
});

test("(7) closeIssue failure is guarded — recorded, never thrown, still exit 0", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ closeIssue: vi.fn(async () => { throw new Error("issue already closed"); }) });
  const code = await run(d, { record });
  expect(code).toBe(0);
  expect(lines.some((l) => /merge: issue close failed — issue already closed/.test(l))).toBe(true);
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
  const code = await run(d, { record });
  expect(code).toBe(0);
  expect(calls).toEqual(["prInfo", "gates", "mergeGates", "mergePr", "transition:factory:merged", "closeIssue"]);
  expect(d.closeIssue).toHaveBeenCalledWith(9);
  // 7단계 각각의 흔적이 런 레코드에 남는다
  expect(lines.length).toBeGreaterThanOrEqual(7);
});
