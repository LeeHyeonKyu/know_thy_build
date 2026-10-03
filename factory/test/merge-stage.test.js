import { test, expect, vi } from "vitest";
import { runMergeStage, HUMAN_MERGE_REQUIRED, verifyFactoryStatuses, REVIEW_EVIDENCE_STATUSES } from "../lib/merge-stage.js";
import { idlessFailedSuites } from "../lib/merge-stage.js";
import { canTransition } from "../lib/labels.js";
import { MergeBaseError } from "../lib/blocked-errors.js";
import { GitDiffError } from "../lib/changed-files.js";
import { runGates, gatesDetailLines } from "../lib/gates.js";
import { makeFakeRun } from "../lib/exec.js";

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

/**
 * 외부 감사 2026-09-14 H1c/H1b — 머지 직전 리뷰 검증(§(6b))의 기본 재료. 통과하는 모양이 기본값이고,
 * 개별 테스트가 한 조각씩 무너뜨린다. `run()`의 headSha와 같은 sha여야 한다("PR head가 움직였다"로
 * 떨어지지 않게).
 */
const HEAD = "b".repeat(40);
const approve = (role) => ({ role, verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] });
const REVIEW_OK = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: HEAD, round: 2, decision: "approved", verdicts: [approve("correctness"), approve("qa")], orchestration: "workflow", guarantee: "verified" };
/**
 * 리뷰 batch-1 MF-2 — handoff의 **출처**. 러너가 `factory/records`의 run 기록에 쓴 `review-evidence:`
 * 줄을 파싱한 모양 그대로다(run-record.js `parseReviewEvidence`). 기본값은 handoff와 일치한다.
 *
 * 리뷰 batch-2 MF-2 — 그 줄은 **어느 런의 것인지** 말하고(`runId`), 머지 스테이지는 그 기대값을
 * `reviewRunId`(이슈의 review 하트비트)에서 따로 읽는다. 기본값은 둘이 같은 런을 말한다.
 */
const RUN = "34809992796";
// KTB-42 — 이 로스터에는 `qa`가 있으므로 run 기록의 줄은 qa 증거 매니페스트의 지문도 싣는다.
// 그 필드가 없으면 머지는 거부한다(아래 "KTB-42" 테스트가 그 자리를 직접 친다).
const QA_DIGEST = "f".repeat(64);
const RECORD_OK = { stage: "review", at: "2026-09-14T09:02Z", runId: RUN, runnerId: `gha-${RUN}`, headSha: HEAD, round: 2, decision: "approved", verdicts: "correctness=approve,qa=approve", qaManifest: QA_DIGEST };
const reviewDeps = (over = {}) => ({
  reviewEvidence: vi.fn(async () => ({ ok: true, data: REVIEW_OK })),
  reviewRunId: vi.fn(async () => ({ ok: true, runId: RUN, runnerId: `gha-${RUN}` })),
  reviewRecord: vi.fn(async () => ({ ok: true, record: RECORD_OK })),
  reviewRoster: vi.fn(async () => ({ ok: true, roles: ["correctness", "qa"] })),
  maxRounds: 3,
  prHeadShaLive: vi.fn(async () => HEAD),
  factoryLogins: vi.fn(async () => ({ ok: true, logins: ["ktb-bot", "ktb-owner"] })),
  commitStatuses: vi.fn(async () => [
    { context: "factory/review", state: "success", creatorLogin: "ktb-bot" },
    { context: "factory/gates", state: "success", creatorLogin: "ktb-bot" },
  ]),
  ...over,
});

const baseD = (over = {}) => ({
  ...reviewDeps(),
  prInfo: vi.fn(async () => ({ number: 9, state: "OPEN", mergeable: "MERGEABLE" })),
  gates: vi.fn(async () => ({ schema: "factory.gates.v1", level: "full", status: "GREEN", head_sha: "a".repeat(40), passed: 3, failed: 0, skipped: [], misconfigured: [], tests: { excluded: [] } })),
  mergeGates: vi.fn(async () => ({ checksGreen: true, integrityGreen: true })),
  prChecks: vi.fn(async () => [{ name: "factory/integrity", state: "SUCCESS", bucket: "pass" }]),
  protectedPaths: vi.fn(async () => ({ ok: true, files: [] })),
  policyViolations: vi.fn(async () => ({ ok: true, files: [] })),
  comment: vi.fn(async () => {}),
  prReady: vi.fn(async () => {}),
  mergePr: vi.fn(async () => {}),
  transition: graphTransition(),
  closeIssue: vi.fn(async () => {}),
  sleep: vi.fn(async () => {}),
  ...over,
});
const basePostStatus = (over = {}) => Object.assign(vi.fn(async () => {}), over);
const run = (d, over = {}) => runMergeStage({
  issue: 7, defaultBranch: "main", headSha: "b".repeat(40), d,
  record: over.record ?? makeRecord().record, refusal, postStatus: over.postStatus ?? basePostStatus(),
  retryFromBlocked: over.retryFromBlocked ?? false,
});

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

// Feedback loop Task 3 — merge 스테이지의 게이트 RED도 **왜 RED였는지**를 남긴다. 예전에는
// `merge: gates RED` 한 줄(이름뿐)이라, 머지 직전에 죽은 게이트의 뿌리는 7일짜리 아티팩트에만
// 있었다 — Task 1이 run-stage에서 닫은 바로 그 구멍이 여기만 열려 있었다. 줄은 자기를 쓴 런을
// 지목해야 T3의 harvester가 그것을 증거로 센다(묶이지 않은 줄은 무시된다).
test("(3) gates RED at merge → gates-detail 줄이 런을 지목한 채 런 레코드에 남는다", async () => {
  const { lines, record } = makeRecord();
  const gates = {
    schema: "factory.gates.v1", status: "RED", head_sha: "a".repeat(40),
    gates: { unit: { status: "RED", reason: "command exited 1 with 0 failing tests — unhandled error outside tests (see gate log)", log: "boom", detail: { gate: "unit", failing: [], snippet: "boom" } } },
  };
  const d = baseD({ gates: vi.fn(async () => gates) });
  const code = await runMergeStage({
    issue: 7, defaultBranch: "main", headSha: "b".repeat(40), d,
    record, refusal, postStatus: basePostStatus(), stamp: { runId: "771", runnerId: "gha-771", round: null },
  });
  expect(code).toBe(2);
  const detail = lines.find((l) => l.startsWith("gates-detail: "));
  expect(detail).toBeTruthy();
  const parsed = JSON.parse(detail.slice("gates-detail: ".length));
  expect(parsed).toMatchObject({ gate: "unit", run_id: "771", runner: "gha-771" });
  expect(parsed.reason).toMatch(/unhandled error outside tests/);
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

// ── KTB-21: merge도 implement/review와 같은 test_env_reup 기록을 남긴다 ──────────────
test("(3) gates.test_env_reup ok is recorded alongside the GREEN gates line", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({
    gates: vi.fn(async () => ({
      schema: "factory.gates.v1", level: "full", status: "GREEN", head_sha: "a".repeat(40),
      passed: 3, failed: 0, skipped: [], misconfigured: [], tests: { excluded: [] },
      test_env_reup: { ran: true, ok: true, detail: "" },
    })),
  });
  const code = await run(d, { record });
  expect(code).toBe(0);
  expect(lines).toContain("test-env: re-up ok");
});

test("(3) gates BLOCKED by a failed test-env re-up records the failure detail alongside the blocked line", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({
    gates: vi.fn(async () => ({
      schema: "factory.gates.v1", status: "BLOCKED", blocked_reason: "test-env re-up failed: compose: exit 1",
      test_env_reup: { ran: true, ok: false, detail: "compose: exit 1" },
    })),
  });
  const code = await run(d, { record });
  expect(code).toBe(2);
  expect(lines.some((l) => /merge: gates BLOCKED — test-env re-up failed: compose: exit 1/.test(l))).toBe(true);
  expect(lines).toContain("test-env: re-up failed — compose: exit 1");
});

test("(3) no compose in the harness → no test-env note in the merge run record", async () => {
  const { lines, record } = makeRecord();
  const d = baseD();
  const code = await run(d, { record });
  expect(code).toBe(0);
  expect(lines.some((l) => l.startsWith("test-env:"))).toBe(false);
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

// ── (3b) 역할 프롬프트의 허용 섹션 밖 편집 = 사람이 머지한다 (KTB-6) ──────────────
// `additive_only`도 "누가 고쳐도 되는가"의 정책이지 커밋에 대한 사실이 아니다 — L0에 두면
// 모든 `:role` PR과 에이전트 파일을 건드리는 패키지 업그레이드를 사람도 머지할 수 없다.

test("(3b) an agent file edited outside Examples/Perspectives → needs-human naming the files, never merges", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ policyViolations: vi.fn(async () => ({ ok: true, files: [".claude/agents/factory-builder.md"] })) });
  const code = await run(d, { record });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:needs-human",
    reason: "agent role sections edited outside Examples/Perspectives — human merge required: .claude/agents/factory-builder.md (see PR #9)",
  }));
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(lines.some((l) => /agent role sections edited outside/.test(l))).toBe(true);
});

test("(3b) the policy check runs after protectedPaths and BEFORE gates — no PR-authored command runs", async () => {
  const calls = [];
  const d = baseD({
    protectedPaths: vi.fn(async () => { calls.push("protectedPaths"); return { ok: true, files: [] }; }),
    policyViolations: vi.fn(async () => { calls.push("policyViolations"); return { ok: true, files: [".claude/agents/x.md"] }; }),
    gates: vi.fn(async () => { calls.push("gates"); return { schema: "factory.gates.v1", status: "GREEN", head_sha: "a".repeat(40) }; }),
  });
  expect(await run(d)).toBe(2);
  expect(calls).toEqual(["protectedPaths", "policyViolations"]);
  expect(d.gates).not.toHaveBeenCalled();
  expect(d.mergeGates).not.toHaveBeenCalled();
});

test("(3b) the refusal comments on the PR, naming the allowed sections", async () => {
  const comment = vi.fn(async () => {});
  const d = baseD({ policyViolations: vi.fn(async () => ({ ok: true, files: [".claude/agents/x.md"] })), comment });
  await run(d);
  const [target, body] = comment.mock.calls[0];
  expect(target).toBe(9);
  expect(body).toMatch(/## Examples/);
  expect(body).toMatch(/`\.claude\/agents\/x\.md`/);
});

// ── (3b') 같은 dep이 실어 오는 **두 번째** 규칙: 사라진 lessons 파일 (KTB-10 I3) ──────
// `policyViolations`는 additive-only 위반과 `.factory/lessons/**`의 삭제·이동을 한 배열에 담는다.
// 둘은 사람이 할 일이 다르다 — 앞은 역할 정의가 바뀐 diff이고, 뒤는 누적된 교훈이 사라지는 diff다.
// 한 제목으로 뭉치면 "`## Examples`에만 추가하세요"라는 설명이 lessons 삭제 위에 붙는 오보가 된다.

const LESSONS_GONE = { file: ".factory/lessons/reviewer-qa.md", rule: "lessons file deleted or moved away — human merge required" };

test("(3b') a deleted lessons file gets its own heading and reason — not the additive-only copy", async () => {
  const comment = vi.fn(async () => {});
  const { lines, record } = makeRecord();
  const d = baseD({
    policyViolations: vi.fn(async () => ({ ok: true, files: [LESSONS_GONE.file], violations: [LESSONS_GONE] })),
    comment,
  });
  expect(await run(d, { record })).toBe(2);
  const [target, body] = comment.mock.calls[0];
  expect(target).toBe(9);
  expect(body).toContain("**lessons 파일 삭제/이동 — 팩토리가 자동 머지하지 않습니다.**");
  expect(body).not.toContain("역할 프롬프트의 허용 섹션 밖 편집");
  expect(body).toMatch(/`\.factory\/lessons\/reviewer-qa\.md`/);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:needs-human",
    reason: "lessons files deleted or moved away — human merge required: .factory/lessons/reviewer-qa.md (see PR #9)",
  }));
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(lines.some((l) => /lessons files deleted or moved away/.test(l))).toBe(true);
});

test("(3b') an additive-only violation keeps its own heading and never mentions lessons", async () => {
  const comment = vi.fn(async () => {});
  const d = baseD({
    policyViolations: vi.fn(async () => ({
      ok: true, files: [".claude/agents/x.md"],
      violations: [{ file: ".claude/agents/x.md", rule: "additive-only sections (## Examples) — removals or edits outside allowed sections" }],
    })),
    comment,
  });
  expect(await run(d)).toBe(2);
  const [, body] = comment.mock.calls[0];
  expect(body).toContain("**역할 프롬프트의 허용 섹션 밖 편집 — 팩토리가 자동 머지하지 않습니다.**");
  expect(body).not.toContain("lessons 파일 삭제/이동");
});

test("(3b') a PR that does both gets both headings, each above its own file list", async () => {
  const comment = vi.fn(async () => {});
  const d = baseD({
    policyViolations: vi.fn(async () => ({
      ok: true, files: [".claude/agents/x.md", LESSONS_GONE.file],
      violations: [
        { file: ".claude/agents/x.md", rule: "additive-only: header added" },
        LESSONS_GONE,
      ],
    })),
    comment,
  });
  expect(await run(d)).toBe(2);
  const [, body] = comment.mock.calls[0];
  expect(body).toContain("역할 프롬프트의 허용 섹션 밖 편집");
  expect(body).toContain("lessons 파일 삭제/이동");
  // 제목 사이에 각자의 목록이 온다 — 역할 파일이 lessons 제목 아래에 섞이지 않는다
  const agentAt = body.indexOf("`.claude/agents/x.md`"), lessonsHeadingAt = body.indexOf("lessons 파일 삭제/이동");
  expect(agentAt).toBeGreaterThan(0);
  expect(agentAt).toBeLessThan(lessonsHeadingAt);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:needs-human",
    reason: expect.stringMatching(/agent role sections edited outside.*; lessons files deleted or moved away/),
  }));
});

// ── (3b'') 같은 dep이 실어 오는 **네 번째** 규칙: 기존 테스트의 수정·삭제 (외부 감사 H5) ──────
// 테스트를 고치는 것은 "무엇이 통과인가"를 고치는 것이다 — 변조로 다루지 않는 이유는 스펙이 바뀌면
// 기존 단언이 실제로 틀리기 때문이고(그때는 이슈 본문의 `tests_changed_allowed:`가 길을 연다),
// 그래도 자동 머지는 안 되는 이유는 그 판단이 사람의 것이기 때문이다.

test("(3b'') 기존 테스트 수정은 자기 제목으로 거부된다 — 자동 머지 없음", async () => {
  const comment = vi.fn(async () => {});
  const { lines, record } = makeRecord();
  const d = baseD({
    policyViolations: vi.fn(async () => ({
      ok: true, files: ["test/a.test.js"],
      violations: [{ file: "test/a.test.js", rule: "tests-modified — 3 line(s) removed from an existing test — human merge required" }],
    })),
    comment,
  });
  expect(await run(d, { record })).toBe(2);
  const [, body] = comment.mock.calls[0];
  expect(body).toContain("**기존 테스트의 수정·삭제 — 팩토리가 자동 머지하지 않습니다.**");
  expect(body).toMatch(/`test\/a\.test\.js`/);
  expect(body).not.toContain("역할 프롬프트의 허용 섹션 밖 편집");
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:needs-human",
    reason: "existing tests modified or deleted — human merge required: test/a.test.js (see PR #9)",
  }));
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(lines.some((l) => /existing tests modified or deleted/.test(l))).toBe(true);
});

/**
 * KTB-46 — **사유 문구와 sweeper의 판정은 같은 출처에서 나와야 한다.** `sweepHumanMerged`는
 * `HUMAN_MERGE_REQUIRED` 하나로 "사람이 머지해 주기를 기다리는 needs-human"을 나머지 전부와 가른다.
 * 다섯 거부 갈래 중 하나라도 그 문구를 잃으면 그 갈래의 이슈는 사람이 머지한 뒤에도 영원히
 * needs-human에 남는다 — 그리고 그 실패는 **조용하다**(아무 에러도, 아무 코멘트도 나지 않는다).
 */
test("KTB-46: every human-merge refusal reason carries the exported HUMAN_MERGE_REQUIRED phrase", async () => {
  const cases = {
    "protected paths": { protectedPaths: async () => ({ ok: true, files: [".factory/harness.toml"] }) },
    "agent role sections": { policyViolations: async () => ({ ok: true, files: [".claude/agents/x.md"] }) },
    lessons: {
      policyViolations: async () => ({ ok: true, files: [".factory/lessons/reviewer-qa.md"], violations: [LESSONS_GONE] }),
    },
    "harness.toml frozen sections": {
      policyViolations: async () => ({
        ok: true, files: [".factory/harness.toml"],
        violations: [{ file: ".factory/harness.toml", rule: "harness.toml [gates.thresholds] edited — human merge required" }],
      }),
    },
    "existing tests": {
      policyViolations: async () => ({
        ok: true, files: ["test/a.test.js"],
        violations: [{ file: "test/a.test.js", rule: "tests-modified — 3 line(s) removed from an existing test — human merge required" }],
      }),
    },
  };
  for (const [name, over] of Object.entries(cases)) {
    const d = baseD(over);
    expect(await run(d), name).toBe(2);
    const { to, reason } = d.transition.mock.calls.at(-1)[0];
    expect(to, name).toBe("factory:needs-human");
    expect(HUMAN_MERGE_REQUIRED.test(reason), `${name}: ${reason}`).toBe(true);
    expect(d.mergePr, name).not.toHaveBeenCalled();
  }
});

/**
 * KTB-46 r2 — §(6b)의 판정 (d)를 꺼낸 순수 함수. sweeper의 사람-머지 반영 팔이 **같은 함수**를
 * 부른다(판정을 두 벌 구현하면 그 둘이 갈라지는 날 한쪽만 위조 상태를 통과시킨다). 위의 §(6b)
 * 테스트들이 그대로 초록인 것이 "동작이 한 글자도 바뀌지 않았다"의 증거다.
 */
test("KTB-46 r2: verifyFactoryStatuses — success + factory creator on both contexts, else a named refusal", () => {
  const SHA = "b".repeat(40);
  const ok = REVIEW_EVIDENCE_STATUSES.map((context) => ({ context, state: "success", creatorLogin: "ktb-bot" }));
  const logins = ["ktb-bot", "ktb-owner"];
  expect(verifyFactoryStatuses({ sha: SHA, statuses: ok, logins })).toEqual({ ok: true });
  // 대소문자는 무시한다(GitHub 로그인은 대소문자를 구분하지 않는다).
  expect(verifyFactoryStatuses({ sha: SHA, statuses: ok.map((s) => ({ ...s, creatorLogin: "KTB-Bot" })), logins })).toEqual({ ok: true });

  const bad = (over, re) => {
    const r = verifyFactoryStatuses({ sha: SHA, statuses: ok.map((s, i) => (i === 1 ? { ...s, ...over } : s)), logins });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(re);
  };
  bad({ state: "failure" }, /is "failure", not success/);
  bad({ creatorLogin: "mallory" }, /posted by @mallory.*not a factory account/s);
  bad({ creatorLogin: "" }, /names no creator/);

  // 상태가 아예 없는 것은 통과가 아니다 — "리뷰 스테이지가 이 커밋에 올린 적이 없다"이다.
  expect(verifyFactoryStatuses({ sha: SHA, statuses: [], logins }).reason).toMatch(/no factory\/review commit status/);
  // 조회 결과가 목록이 아니거나 대조할 계정이 없으면 **판정 불가**다(fail closed).
  expect(verifyFactoryStatuses({ sha: SHA, statuses: null, logins }).reason).toMatch(/unreadable — no list returned/);
  expect(verifyFactoryStatuses({ sha: SHA, statuses: ok, logins: [] }).reason).toMatch(/could not be resolved/);
  // 같은 context가 여러 번이면 **가장 최근 것**(목록의 첫 항목)이 유효한 상태다.
  const stale = [{ context: "factory/review", state: "failure", creatorLogin: "ktb-bot" }, ...ok];
  expect(verifyFactoryStatuses({ sha: SHA, statuses: stale, logins }).reason).toMatch(/factory\/review on bbbbbbb is "failure"/);
});

test("(3b) policyViolations could not be computed → factory:blocked, no gates, no merge", async () => {
  const d = baseD({ policyViolations: vi.fn(async () => ({ ok: false, files: [], reason: "git show exited 128" })) });
  expect(await run(d)).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:blocked",
    reason: "agent-section policy check could not be computed: git show exited 128",
  }));
  expect(d.gates).not.toHaveBeenCalled();
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("(3b) the dep missing altogether is not a pass — factory:blocked", async () => {
  const d = baseD({ policyViolations: undefined });
  expect(await run(d)).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: expect.stringMatching(/agent-section policy check/) }));
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("(3b) a protected-path refusal wins before the policy check is even asked", async () => {
  const d = baseD({
    protectedPaths: vi.fn(async () => ({ ok: true, files: [".factory/harness.toml"] })),
    policyViolations: vi.fn(async () => ({ ok: true, files: [] })),
  });
  expect(await run(d)).toBe(2);
  expect(d.policyViolations).not.toHaveBeenCalled();
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

// ── (3) 보호 경로 = 사람이 머지한다 (KTB-5) ────────────────────────────────
// L0(`factory/integrity` 체크)는 변조만 본다 — 보호 경로 변경으로 RED가 되면 사람조차 머지할 수
// 없기 때문이다(required context가 그것 하나뿐). 그래서 "사람이 머지해야 한다"는 판단은 여기,
// 자동 머지 경로 안에서 내린다 — 그리고 **게이트보다 먼저**다(게이트는 PR이 쓴 코드를 실행한다).

test("(3) protected paths in the PR range → needs-human naming the files and the PR, never merges", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ protectedPaths: vi.fn(async () => ({ ok: true, files: [".factory/harness.toml", "package.json"] })) });
  const code = await run(d, { record });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:needs-human",
    reason: "protected paths changed — human merge required: .factory/harness.toml, package.json (see PR #9)",
  }));
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(d.closeIssue).not.toHaveBeenCalled();
  expect(lines.some((l) => /protected paths changed/.test(l))).toBe(true);
});

// 핵심 순서 불변식: `gates()`는 `harness.commands`를 bash로 돌린다 = PR이 쓴 코드를 머지 잡 안에서
// 실행한다. 보호 경로를 실은 PR은 애초에 자동 머지 후보가 아니므로 그 코드가 한 줄도 돌지 않는다.
test("(3) the refusal happens BEFORE gates/mergeGates — no PR-authored command ever runs", async () => {
  const d = baseD({ protectedPaths: vi.fn(async () => ({ ok: true, files: [".factory/harness.toml"] })) });
  expect(await run(d)).toBe(2);
  expect(d.gates).not.toHaveBeenCalled();
  expect(d.mergeGates).not.toHaveBeenCalled();
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("(3) the refusal comments on the PR (not the issue), listing every protected file", async () => {
  const comment = vi.fn(async () => {});
  const d = baseD({ protectedPaths: vi.fn(async () => ({ ok: true, files: [".factory/harness.toml"] })), comment });
  await run(d);
  expect(comment).toHaveBeenCalledTimes(1);
  const [target, body] = comment.mock.calls[0];
  expect(target).toBe(9);                                   // PR 번호 — 이슈(7)가 아니다
  expect(body).toMatch(/`\.factory\/harness\.toml`/);
  expect(body).toMatch(/#7/);                               // 추적 이슈로 되돌아가는 포인터
});

test("(3) a failing comment never masks the refusal — still needs-human, still exit 2", async () => {
  const d = baseD({
    protectedPaths: vi.fn(async () => ({ ok: true, files: [".factory/harness.toml"] })),
    comment: vi.fn(async () => { throw new Error("gh down"); }),
  });
  expect(await run(d)).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human" }));
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("(3) protectedPaths could not be computed → factory:blocked (판정 불가, not needs-human), no merge", async () => {
  const d = baseD({ protectedPaths: vi.fn(async () => ({ ok: false, files: [], reason: "git diff --name-status exited 128" })) });
  const code = await run(d);
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:blocked",
    reason: "protected-path check could not be computed: git diff --name-status exited 128",
  }));
  expect(d.gates).not.toHaveBeenCalled();
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("(3) the dep missing altogether is not a pass — factory:blocked, no merge", async () => {
  const d = baseD({ protectedPaths: undefined });
  const code = await run(d);
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: expect.stringMatching(/protected-path check/) }));
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("(3) a clean PR range (no protected files, sections within policy) merges as before", async () => {
  const d = baseD();
  expect(await run(d)).toBe(0);
  expect(d.protectedPaths).toHaveBeenCalled();
  expect(d.policyViolations).toHaveBeenCalled();
  expect(d.comment).not.toHaveBeenCalled();
  expect(d.mergePr).toHaveBeenCalled();
});

// ── (5) prReady / mergePr / head sha ─────────────────────────────────────

// KTB-15: 데모 #8은 triage→plan→implement→review를 전부 통과하고 여기서 죽었다 —
// `gh pr merge failed (1): GraphQL: Pull Request is still a draft`. implement는 `--draft`로 PR을
// 열고(그건 의도된 설계다 — 리뷰 중인 PR을 사람이 실수로 머지하지 못하게), 아무도 ready로 뒤집지
// 않았다. 그래서 **어떤 PR도** 자동 머지될 수 없었다.
test("(5) prReady is called immediately before mergePr — after every gate and policy check", async () => {
  const calls = [];
  const d = baseD({
    protectedPaths: vi.fn(async () => { calls.push("protectedPaths"); return { ok: true, files: [] }; }),
    policyViolations: vi.fn(async () => { calls.push("policyViolations"); return { ok: true, files: [] }; }),
    gates: vi.fn(async () => { calls.push("gates"); return { schema: "factory.gates.v1", status: "GREEN", head_sha: "a".repeat(40) }; }),
    mergeGates: vi.fn(async () => { calls.push("mergeGates"); return { checksGreen: true, integrityGreen: true }; }),
    prChecks: vi.fn(async () => { calls.push("prChecks"); return [{ name: "factory/integrity", state: "SUCCESS", bucket: "pass" }]; }),
    prReady: vi.fn(async () => { calls.push("prReady"); }),
    mergePr: vi.fn(async () => { calls.push("mergePr"); }),
  });
  const code = await run(d);
  expect(code).toBe(0);
  // KTB-19: prReady 뒤 required checks가 더 이상 진행 중이 아닐 때까지 기다린 다음(여기서는 이미
  // 안정돼 있어 한 번의 조회로 끝난다), mergeGates가 무결성까지 한 번 더 확인한다.
  expect(calls).toEqual(["protectedPaths", "policyViolations", "gates", "mergeGates", "prReady", "prChecks", "mergeGates", "mergePr"]);
  expect(d.prReady).toHaveBeenCalledWith(9);
  expect(d.prChecks).toHaveBeenCalledWith(9);
  expect(d.mergeGates).toHaveBeenCalledTimes(2);
  expect(d.sleep).not.toHaveBeenCalled();   // 첫 조회부터 안정돼 있으면 재확인 사이 대기는 없다
});

// 게이트가 떨어진 PR을 ready로 만들어 두면, 그다음부터는 사람이 실수로 머지 버튼을 누를 수 있다 —
// draft는 그 실수를 막는 장치이므로 **머지하지 않기로 한 런은 draft를 건드리지 않는다**.
test("(5) a refused merge never flips the PR out of draft", async () => {
  const d = baseD({ gates: vi.fn(async () => ({ schema: "factory.gates.v1", status: "RED", head_sha: "a".repeat(40) })) });
  await run(d);
  expect(d.prReady).not.toHaveBeenCalled();
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("(5) prReady throws → factory:blocked, and mergePr is never called", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ prReady: vi.fn(async () => { throw new Error("gh pr ready failed (1): HTTP 403"); }) });
  const code = await run(d, { record });
  expect(code).toBe(2);
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: "ready-for-review failed: gh pr ready failed (1): HTTP 403" }));
  expect(d.closeIssue).not.toHaveBeenCalled();
  expect(lines.some((l) => /merge: prReady FAIL/.test(l))).toBe(true);
});

// dep이 배선되지 않은 오래된 호출자(또는 이미 ready인 PR)를 이유로 머지를 멈추지는 않는다 —
// `gh pr ready`는 이미 ready인 PR에 대해 exit 0이므로 이 호출 자체가 멱등이다.
test("(5) no prReady dep wired → the merge still proceeds, with a record line", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ prReady: undefined });
  const code = await run(d, { record });
  expect(code).toBe(0);
  expect(d.mergePr).toHaveBeenCalled();
  expect(lines.some((l) => /prReady dep not wired/.test(l))).toBe(true);
});

// ── (6a-ii) KTB-19: wait for required checks to settle (not GREEN, but no longer running) ──────
// Demo #8's retry: the PR branch still carried the OLD integrity.yml (with a `ready_for_review`
// trigger) — readying it queued a new required check, and the old fixed-3×10s re-poll expired
// while it was still queued. Now we wait until nothing required is queued/pending/in_progress
// (bounded by `harness.factory.merge_check_wait_sec`, 15s between polls), then judge GREEN/RED.

test("(6a-ii) a check queued at the ready flip settles GREEN on the second poll — mergePr proceeds", async () => {
  const prChecks = vi.fn()
    .mockResolvedValueOnce([{ name: "factory/integrity", state: "queued", bucket: "pending" }])
    .mockResolvedValueOnce([{ name: "factory/integrity", state: "SUCCESS", bucket: "pass" }]);
  const d = baseD({ prChecks, mergeCheckWaitSec: 30 });
  const code = await run(d);
  expect(code).toBe(0);
  expect(prChecks).toHaveBeenCalledTimes(2);
  expect(prChecks).toHaveBeenCalledWith(9);
  expect(d.sleep).toHaveBeenCalledTimes(1);
  expect(d.sleep).toHaveBeenCalledWith(15000);
  expect(d.mergeGates).toHaveBeenCalledTimes(2);   // step (5) + the final integrity re-check once settled
  expect(d.mergePr).toHaveBeenCalled();
});

test("(6a-ii) a required check settles RED → factory:blocked naming the check, mergePr never called", async () => {
  const { lines, record } = makeRecord();
  const prChecks = vi.fn(async () => [{ name: "factory/integrity", state: "FAILURE", bucket: "fail" }]);
  const d = baseD({ prChecks });
  const code = await run(d, { record });
  expect(code).toBe(2);
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:blocked", reason: "required check(s) failed: factory/integrity",
  }));
  expect(lines.some((l) => /required check\(s\) failed: factory\/integrity/.test(l))).toBe(true);
  expect(d.mergeGates).toHaveBeenCalledTimes(1);   // never reaches the post-settle integrity re-check
});

test("(6a-ii) a non-required check stays queued forever but is ignored when required_checks names only others", async () => {
  const prChecks = vi.fn(async () => [
    { name: "factory/integrity", state: "SUCCESS", bucket: "pass" },
    { name: "some-other-check", state: "queued", bucket: "pending" },
  ]);
  const d = baseD({ prChecks, requiredChecks: ["factory/integrity"] });
  const code = await run(d);
  expect(code).toBe(0);
  expect(prChecks).toHaveBeenCalledTimes(1);
  expect(d.sleep).not.toHaveBeenCalled();
});

test("(6a-ii) checks still pending after the wait budget → factory:blocked 'checks still pending after <n>s', retryable", async () => {
  const { lines, record } = makeRecord();
  const prChecks = vi.fn(async () => [{ name: "factory/integrity", state: "queued", bucket: "pending" }]);
  const d = baseD({ prChecks, mergeCheckWaitSec: 15 });   // one attempt only (15000ms window / 15000ms interval)
  const code = await run(d, { record });
  expect(code).toBe(2);
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:blocked", reason: "checks still pending after 15s",
  }));
  expect(lines.some((l) => /checks still pending after 15s/.test(l))).toBe(true);
});

test("(6a-ii) the wait budget defaults to 600s (40 polls of 15s) when harness doesn't set it", async () => {
  const prChecks = vi.fn(async () => [{ name: "factory/integrity", state: "queued", bucket: "pending" }]);
  const d = baseD({ prChecks });   // no mergeCheckWaitSec override
  const code = await run(d);
  expect(code).toBe(2);
  expect(prChecks).toHaveBeenCalledTimes(40);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ reason: "checks still pending after 600s" }));
});

test("(6a-ii) mergeGates() throwing MergeBaseError during the final integrity re-check → factory:blocked, not swallowed as needs-human", async () => {
  const mergeGates = vi.fn()
    .mockResolvedValueOnce({ checksGreen: true, integrityGreen: true })   // step (5)
    .mockRejectedValueOnce(new MergeBaseError("origin/main: exit 1"));    // final integrity re-check
  const d = baseD({ mergeGates });
  const code = await run(d);
  expect(code).toBe(2);
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: expect.stringContaining("merge-base") }));
});

test("(6a-ii) integrity not GREEN on the final re-check (checks were fine) → factory:blocked", async () => {
  const mergeGates = vi.fn()
    .mockResolvedValueOnce({ checksGreen: true, integrityGreen: true })
    .mockResolvedValueOnce({ checksGreen: true, integrityGreen: false });
  const d = baseD({ mergeGates });
  const code = await run(d);
  expect(code).toBe(2);
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked", reason: "integrity not GREEN" }));
});

test("(6a-ii) with no prReady dep wired, prChecks/mergeGates are never re-checked (no draft flip happened)", async () => {
  const mergeGates = vi.fn(async () => ({ checksGreen: true, integrityGreen: true }));
  const prChecks = vi.fn();
  const d = baseD({ mergeGates, prChecks, prReady: undefined });
  const code = await run(d);
  expect(code).toBe(0);
  expect(mergeGates).toHaveBeenCalledTimes(1);
  expect(prChecks).not.toHaveBeenCalled();
});

test("(6a-ii) prReady wired but no prChecks dep → factory:blocked (판정 불가), mergePr never called", async () => {
  const d = baseD({ prChecks: undefined });
  const code = await run(d);
  expect(code).toBe(2);
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:blocked", reason: expect.stringContaining("prChecks dep not wired"),
  }));
});

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
  // 이 런의 head는 `c…`다 — 리뷰 증거도 같은 커밋의 것이어야 한다(감사 H1c: 다른 sha의 리뷰는
  // 지금 머지하려는 트리의 얘기가 아니므로 needs-human이다).
  const other = "c".repeat(40);
  const d = baseD({
    reviewEvidence: vi.fn(async () => ({ ok: true, data: { ...REVIEW_OK, head_sha: other } })),
    reviewRecord: vi.fn(async () => ({ ok: true, record: { ...RECORD_OK, headSha: other } })),
    prHeadShaLive: vi.fn(async () => other),
  });
  await runMergeStage({ issue: 7, defaultBranch: "main", headSha: other, d, record, refusal, postStatus: basePostStatus() });
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

test("happy path: calls prInfo → protectedPaths → policyViolations → gates → mergeGates → prReady → mergePr → transition(merged) → closeIssue, in order, exit 0", async () => {
  const calls = [];
  const d = baseD({
    prInfo: vi.fn(async () => { calls.push("prInfo"); return { number: 9, state: "OPEN", mergeable: "MERGEABLE" }; }),
    gates: vi.fn(async () => { calls.push("gates"); return { schema: "factory.gates.v1", status: "GREEN", head_sha: "a".repeat(40) }; }),
    mergeGates: vi.fn(async () => { calls.push("mergeGates"); return { checksGreen: true, integrityGreen: true }; }),
    prChecks: vi.fn(async () => { calls.push("prChecks"); return [{ name: "factory/integrity", state: "SUCCESS", bucket: "pass" }]; }),
    protectedPaths: vi.fn(async () => { calls.push("protectedPaths"); return { ok: true, files: [] }; }),
    policyViolations: vi.fn(async () => { calls.push("policyViolations"); return { ok: true, files: [] }; }),
    prReady: vi.fn(async () => { calls.push("prReady"); }),
    mergePr: vi.fn(async () => { calls.push("mergePr"); }),
    transition: vi.fn(async ({ to }) => { calls.push(`transition:${to}`); return { ok: true, to }; }),
    closeIssue: vi.fn(async () => { calls.push("closeIssue"); }),
  });
  const { lines, record } = makeRecord();
  const code = await run(d, { record });
  expect(code).toBe(0);
  expect(calls).toEqual(["prInfo", "protectedPaths", "policyViolations", "gates", "mergeGates", "prReady", "prChecks", "mergeGates", "mergePr", "transition:factory:merged", "closeIssue"]);
  expect(d.closeIssue).toHaveBeenCalledWith(9);
  // 7단계 각각의 흔적이 런 레코드에 남는다
  expect(lines.length).toBeGreaterThanOrEqual(7);
});

// ── retryFromBlocked, before the label hops back to approved (KTB-19 review I-2) ────────────────
// While the label is still literally `factory:blocked` (steps 1–4, before (4b) re-confirms gates
// GREEN and flips it to approved), a second undecidable/BLOCKED outcome would ask the graph for a
// blocked→blocked self-transition — an edge this graph deliberately never has (no state transitions
// to itself). Two things had to be fixed: (a) a CONFLICTING PR must route to `factory:rework`
// (previously no edge existed at all), (b) any other "→ factory:blocked" must be record-only (the
// label truly doesn't change) but still refresh the `factory-blocked-origin` marker directly, since
// skipping `d.transition` means `lib/transition.js` never gets a chance to write a fresh one.

test("(retry from blocked) a CONFLICTING PR transitions factory:blocked → factory:rework via the graph, not a refusal", async () => {
  const { lines, record } = makeRecord();
  const transition = graphTransition("factory:blocked");
  const d = baseD({
    prInfo: vi.fn(async () => ({ number: 9, state: "OPEN", mergeable: "CONFLICTING" })),
    transition,
  });
  const code = await run(d, { record, retryFromBlocked: "factory:approved" });
  expect(code).toBe(2);
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:rework" }));
  expect(lines.some((l) => /transition refused/.test(l))).toBe(false);
  expect(lines.some((l) => /PR #9 conflicting/.test(l))).toBe(true);
});

test("(retry from blocked) gates BLOCKED before the approved hop → record-only, fresh origin marker, no graph call", async () => {
  const { lines, record } = makeRecord();
  const transition = vi.fn(async () => { throw new Error("d.transition must not be called for a blocked→blocked self-transition"); });
  const comment = vi.fn(async () => {});
  const d = baseD({
    gates: vi.fn(async () => ({ schema: "factory.gates.v1", status: "BLOCKED", blocked_reason: "cannot classify", head_sha: "a".repeat(40) })),
    transition, comment,
  });
  const code = await run(d, { record, retryFromBlocked: "factory:approved" });
  expect(code).toBe(2);
  expect(transition).not.toHaveBeenCalled();
  expect(comment).toHaveBeenCalledWith(7, expect.stringContaining("<!-- factory-blocked-origin from=factory:approved stage=merge -->"));
  expect(lines.some((l) => /still blocked — no self-transition/.test(l))).toBe(true);
  expect(d.mergeGates).not.toHaveBeenCalled();
});

test("(retry from blocked) protectedPaths undecidable before the approved hop is also record-only", async () => {
  const transition = vi.fn(async () => { throw new Error("must not be called"); });
  const comment = vi.fn(async () => {});
  const d = baseD({
    protectedPaths: vi.fn(async () => ({ ok: false, files: [], reason: "git diff exited 128" })),
    transition, comment,
  });
  const code = await run(d, { retryFromBlocked: "factory:approved" });
  expect(code).toBe(2);
  expect(transition).not.toHaveBeenCalled();
  expect(comment).toHaveBeenCalledWith(7, expect.stringContaining("factory-blocked-origin from=factory:approved"));
});

test("(retry from blocked) a failing origin-marker re-post is swallowed — still exit 2, never thrown", async () => {
  const d = baseD({
    gates: vi.fn(async () => ({ schema: "factory.gates.v1", status: "BLOCKED", head_sha: "a".repeat(40) })),
    transition: vi.fn(async () => { throw new Error("must not be called"); }),
    comment: vi.fn(async () => { throw new Error("gh comment 502"); }),
  });
  await expect(run(d, { retryFromBlocked: "factory:approved" })).resolves.toBe(2);
});

test("(retry from blocked) once gates re-verify GREEN and the label flips to approved, a LATER blocked outcome uses the normal approved→blocked edge", async () => {
  const transition = graphTransition("factory:blocked");
  const d = baseD({
    mergeGates: vi.fn(async () => { throw new MergeBaseError("origin/main: exit 1"); }),
    transition,
  });
  const code = await run(d, { retryFromBlocked: "factory:approved" });
  expect(code).toBe(2);
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:approved" }));
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked" }));
});

test("(not a retry) gates BLOCKED behaves exactly as before — real graph transition, no marker special-case", async () => {
  // retryFromBlocked defaults to false, so `leftBlocked` starts true — the pre-existing (3) test
  // above already covers this path with the default `graphTransition()` (starting at approved);
  // this just pins that the self-transition special case never fires when we're not mid-retry.
  const transition = graphTransition("factory:approved");
  const comment = vi.fn(async () => {});
  const d = baseD({
    gates: vi.fn(async () => ({ schema: "factory.gates.v1", status: "BLOCKED", blocked_reason: "x", head_sha: "a".repeat(40) })),
    transition, comment,
  });
  const code = await run(d);
  expect(code).toBe(2);
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked" }));
  expect(comment).not.toHaveBeenCalled();   // the record-only marker re-post path never runs
});

// ── (9) ADR-020 KTB-23 — 하네스 이슈가 머지되면 그것이 막고 있던 피처 이슈가 큐로 돌아온다 ────────
test("(9) merging a harness issue unblocks the feature issue its body names (KTB-23)", async () => {
  const { lines, record } = makeRecord();
  const transitionOther = vi.fn(async ({ to }) => ({ ok: true, from: "factory:needs-info", to }));
  const d = baseD({
    issueBody: vi.fn(async () => "harness stuff\n\nBlocks: #2\n"),
    transitionOther,
  });
  expect(await run(d, { record })).toBe(0);
  expect(d.mergePr).toHaveBeenCalled();
  expect(transitionOther).toHaveBeenCalledWith({ issue: 2, to: "factory:queue", reason: "harness issue #7 merged" });
  expect(lines).toContain("merge: unblocked #2 — factory:needs-info → factory:queue");
  // 그리고 그 전이는 그래프에 실제로 있다 — needs-info의 유일한 출구다
  expect(canTransition("factory:needs-info", "factory:queue")).toBe(true);
});

test("(9) a body with several Blocks targets unblocks each; a plain issue's merge does nothing (KTB-23)", async () => {
  const many = vi.fn(async ({ to }) => ({ ok: true, from: "factory:needs-info", to }));
  await run(baseD({ issueBody: async () => "Blocks: #2, #5\nBlocks: #7\n", transitionOther: many }));
  expect(many.mock.calls.map((c) => c[0].issue)).toEqual([2, 5]);        // #7은 자기 자신이라 건너뛴다
  const none = vi.fn();
  expect(await run(baseD({ issueBody: async () => "a normal issue body", transitionOther: none }))).toBe(0);
  expect(none).not.toHaveBeenCalled();
});

test("(9) unblocking is best-effort — a refused or failing transition never undoes the merge (KTB-23)", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({
    issueBody: async () => "Blocks: #2\nBlocks: #3",
    transitionOther: vi.fn(async ({ issue }) => {
      if (issue === 2) return { ok: false, reason: "no factory state label on issue" };
      throw new Error("gh down");
    }),
  });
  expect(await run(d, { record })).toBe(0);                              // 머지는 이미 일어났다 — exit 0
  expect(lines).toContain("merge: unblock #2 refused — no factory state label on issue");
  expect(lines.some((l) => l.startsWith("merge: unblock #3 failed — "))).toBe(true);
  // 본문 조회 자체가 실패해도 마찬가지다
  const { lines: l2, record: r2 } = makeRecord();
  expect(await run(baseD({ issueBody: async () => { throw new Error("boom"); }, transitionOther: vi.fn() }), { record: r2 })).toBe(0);
  expect(l2.some((l) => l.startsWith("merge: blocked-issue lookup failed — "))).toBe(true);
});

test("(9) the deps are optional — an older wiring merges exactly as before (KTB-23)", async () => {
  const d = baseD();                                                     // issueBody/transitionOther 없음
  expect(await run(d)).toBe(0);
  expect(d.closeIssue).toHaveBeenCalled();
});

// ── (6b) ADR-021 two-actor merge authority ──────────────────────────────────

test("(6b) two-actor mode: the merge actor approves BEFORE merging — order is the whole point", async () => {
  const order = [];
  const d = baseD({
    twoActor: true,
    approvePr: vi.fn(async () => { order.push("approve"); }),
    mergePr: vi.fn(async () => { order.push("merge"); }),
  });
  const code = await run(d);
  expect(code).toBe(0);
  expect(d.approvePr).toHaveBeenCalledWith(9);
  expect(order).toEqual(["approve", "merge"]);          // 승인이 낡지 않으려면(dismiss_stale_reviews) 머지 직전이어야 한다
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:merged" }));
});

test("(6b) two-actor mode: approval comes only after every gate — a rejected PR is never approved", async () => {
  const d = baseD({ twoActor: true, approvePr: vi.fn(async () => {}), mergeGates: vi.fn(async () => ({ checksGreen: false, integrityGreen: true })) });
  expect(await run(d)).toBe(2);
  expect(d.approvePr).not.toHaveBeenCalled();
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("(6b) two-actor mode: a refused approval (GitHub 422 on self-approval) → needs-human naming the cause, no merge, no retry loop", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({
    twoActor: true,
    approvePr: vi.fn(async () => { throw new Error("gh pr review failed (1): GraphQL: Can not approve your own pull request"); }),
  });
  const code = await run(d, { record });
  expect(code).toBe(2);
  expect(d.approvePr).toHaveBeenCalledTimes(1);                          // 한 번만 — 같은 422가 반복될 뿐이다
  expect(d.mergePr).not.toHaveBeenCalled();
  // blocked이 아니다: blocked은 sweeper·재시도 경로가 자동으로 다시 미는 상태이고, 이 실패는 사람이
  // 계정 설정을 고쳐야 풀린다.
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:needs-human",
    reason: expect.stringMatching(/approve your own pull request/),
  }));
  expect(d.transition).not.toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked" }));
  const reason = d.transition.mock.calls.at(-1)[0].reason;
  expect(reason).toMatch(/FACTORY_MERGE_TOKEN/);
  expect(reason).toMatch(/ADR-021/);
  expect(lines.some((l) => l.startsWith("merge: approvePr FAIL — "))).toBe(true);
});

test("(6b) two-actor mode with the approvePr dep missing → needs-human, never a merge attempt that the base branch would reject", async () => {
  const d = baseD({ twoActor: true });                                   // approvePr 없음
  expect(await run(d)).toBe(2);
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: expect.stringMatching(/approvePr dep is not wired/) }));
});

test("(6b) single-actor mode is unchanged — no approval call, merge exactly as before", async () => {
  const d = baseD({ approvePr: vi.fn(async () => {}) });                 // twoActor falsy
  expect(await run(d)).toBe(0);
  expect(d.approvePr).not.toHaveBeenCalled();
  expect(d.mergePr).toHaveBeenCalledWith(9);
});

// ── (6b) 외부 감사 2026-09-14 H1c/H1b — 머지 전에 리뷰를 확인한다 ─────────────────────────

/** 실패 전이의 사유를 한 줄로 꺼낸다 — 모든 리뷰 검증 실패는 같은 접두사를 쓴다. */
const lastReason = (d) => d.transition.mock.calls.at(-1)[0].reason;
const refusedReview = (d) => {
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(d.closeIssue).not.toHaveBeenCalled();
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human" }));
  expect(lastReason(d)).toMatch(/^review verification failed — /);
};

/**
 * 감사가 재현한 체인의 마지막 고리: `mergePr`(:476)가 `transition(merged)`(:487)보다 **앞**이고,
 * 정족수 검사는 `factory:approved` 규칙에만 있었다 — 곧 머지 스테이지 자신은 리뷰 증거를 한 번도
 * 보지 않았다. 재료(dep)가 아예 없는 런이 그대로 머지까지 갔다는 사실이 그 구멍 자체다.
 */
test("H1c: with no review-evidence deps wired the stage refuses to merge — an unverified review is not a passed review", async () => {
  const { lines, record } = makeRecord();
  const d = baseD({ reviewEvidence: undefined, reviewRoster: undefined, prHeadShaLive: undefined, commitStatuses: undefined, factoryLogins: undefined });
  expect(await run(d, { record })).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/review-evidence deps not wired/);
  expect(lines.some((l) => l.includes("review verification failed"))).toBe(true);
});

/**
 * **위조된 판정.** handoff는 스스로 `decision: "approved"`라고 적었지만 verdict 하나가 reject이고
 * must_fix가 차 있다. 감사 전 코드는 머지 경로에서 리뷰를 아예 읽지 않았고, `factory:merged` 규칙도
 * 정족수를 묻지 않았다 — 이 한 줄이 그대로 머지됐다.
 */
test("H1c: a review handoff that calls itself approved while a verdict rejects does not merge — the self-reported decision is ignored", async () => {
  const forged = {
    ...REVIEW_OK,
    decision: "approved",
    verdicts: [approve("correctness"), { role: "qa", verdict: "reject", confidence: "high", must_fix: [{ id: "qa1", where: "x.js", claim: "c", evidence: "e" }], should_fix: [], verified: [] }],
  };
  const d = baseD({ reviewEvidence: vi.fn(async () => ({ ok: true, data: forged })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/not all approve/);
});

/**
 * 모두 approve여도 판정은 must_fix에서 **다시 계산한다**: 분쟁 항목을 uphold한 ruling은
 * (`aggregate.js`) approve만 늘어놓은 handoff에서도 must_fix를 되살린다. 자기 신고를 믿었다면
 * 이 PR은 그대로 머지됐다.
 */
test("H1c: all-approve verdicts with an upheld ruling still recompute to rework — the decision comes from must_fix", async () => {
  const withRuling = { ...REVIEW_OK, decision: "approved", rulings: [{ id: "cf1", ruling: "uphold", by: "correctness" }] };
  const d = baseD({ reviewEvidence: vi.fn(async () => ({ ok: true, data: withRuling })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/recomputed from must_fix is "rework"/);
  expect(lastReason(d)).toMatch(/the handoff claims "approved"/);
  expect(lastReason(d)).toMatch(/cf1/);
});

test("H1c: a review handoff bound to a different commit does not merge", async () => {
  const d = baseD({ reviewEvidence: vi.fn(async () => ({ ok: true, data: { ...REVIEW_OK, head_sha: "f".repeat(40) } })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/head_sha .* != PR head/);
});

test("H1c: fewer verdicts than the tier's roster does not merge — quorum is the roster size", async () => {
  const d = baseD({ reviewEvidence: vi.fn(async () => ({ ok: true, data: { ...REVIEW_OK, verdicts: [approve("correctness")] } })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/verdict count 1 != roster size 2/);
});

test("H1c: one role approving twice does not fill the quorum", async () => {
  const d = baseD({ reviewEvidence: vi.fn(async () => ({ ok: true, data: { ...REVIEW_OK, verdicts: [approve("correctness"), approve("correctness")] } })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/review incomplete — qa/);
});

test("H1c: a round beyond K does not merge", async () => {
  const d = baseD({ reviewEvidence: vi.fn(async () => ({ ok: true, data: { ...REVIEW_OK, round: 4 } })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/round 4 > K=3/);
});

test("H1c: an unresolvable roster is undecidable, not a pass", async () => {
  const d = baseD({ reviewRoster: vi.fn(async () => ({ ok: false, reason: "no review roster for tier weird in CHARTER" })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/no review roster for tier weird/);
});

/**
 * H1b — 상태의 게시자를 확인하지 않으면 `gh api -X POST /repos/o/r/statuses/<sha> -f state=success
 * -f context=factory/review` 한 번이 "리뷰가 통과했다"가 된다. 봇 토큰은 `repo` 스코프라 그 호출이
 * 실제로 나간다(훅은 그 위의 한 겹일 뿐이다).
 */
test("H1b: a factory/review status posted by an account that is not the factory does not merge", async () => {
  const d = baseD({
    commitStatuses: vi.fn(async () => [
      { context: "factory/review", state: "success", creatorLogin: "drive-by" },
      { context: "factory/gates", state: "success", creatorLogin: "ktb-bot" },
    ]),
  });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/posted by @drive-by/);
});

test("H1b: a missing factory/gates status on the PR head does not merge", async () => {
  const d = baseD({ commitStatuses: vi.fn(async () => [{ context: "factory/review", state: "success", creatorLogin: "ktb-bot" }]) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/no factory\/gates commit status/);
});

test("H1b: an unresolvable factory login fails closed — no way to tell who posted the statuses", async () => {
  const d = baseD({ factoryLogins: vi.fn(async () => ({ ok: false, reason: "gh api user failed (1): HTTP 401" })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/could not be resolved/);
  expect(lastReason(d)).toMatch(/HTTP 401/);
});

test("H1c: a PR head that moved during the merge run is refused — the gates verified another tree", async () => {
  const d = baseD({ prHeadShaLive: vi.fn(async () => "9".repeat(40)) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/PR head moved during this run/);
});

test("H1c: review verification runs BEFORE the two-actor approval — a bad review costs no approval", async () => {
  const d = baseD({ twoActor: true, approvePr: vi.fn(async () => {}), reviewEvidence: vi.fn(async () => ({ ok: true, data: { ...REVIEW_OK, round: 9 } })) });
  expect(await run(d)).toBe(2);
  expect(d.approvePr).not.toHaveBeenCalled();
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("H1c: a verified review merges, and the record names what was verified", async () => {
  const { lines, record } = makeRecord();
  const d = baseD();
  expect(await run(d, { record })).toBe(0);
  expect(d.mergePr).toHaveBeenCalledWith(9);
  expect(d.prHeadShaLive).toHaveBeenCalledWith(9);
  expect(d.commitStatuses).toHaveBeenCalledWith(HEAD);
  expect(lines.some((l) => /^merge: review verified — 2\/2 approve/.test(l))).toBe(true);
  expect(lines.some((l) => l.includes("factory/review + factory/gates"))).toBe(true);
  expect(lines.some((l) => l.includes("review evidence bound to the factory/records run record"))).toBe(true);
});

// ── (6b2) 리뷰 batch-1 MF-2 — handoff의 **출처**가 factory/records의 run 기록에 묶인다 ────────────
// 재리뷰가 재현한 체인의 남은 절반: handoff 코멘트는 모든 스테이지가 쥔 봇 계정으로 나가고
// `parseHandoffs`는 작성자조차 남기지 않는다 — 곧 all-approve handoff를 손으로 지어내면 정족수
// 검사를 그대로 통과했다. 이제 러너가 `claude -p` **뒤에** 쓴 기록과 같아야 한다.

test("MF-2: a forged all-approve handoff with no review run record does not merge", async () => {
  const d = baseD({ reviewRecord: vi.fn(async () => ({ ok: false, reason: "factory/records carries no run record for issue #7" })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/review evidence not bound to a factory run/);
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("MF-2: a run record with no review-evidence line does not merge", async () => {
  const d = baseD({ reviewRecord: vi.fn(async () => ({ ok: true, record: null })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/review evidence not bound to a factory run/);
  expect(lastReason(d)).toMatch(/no review-evidence line/);
});

test("MF-2: a handoff whose verdicts differ from the recorded ones does not merge", async () => {
  // 기록은 qa가 reject했다고 말한다 — handoff는 2/2 approve라고 말한다. 둘 중 하나는 지어낸 것이다.
  const d = baseD({ reviewRecord: vi.fn(async () => ({ ok: true, record: { ...RECORD_OK, decision: "rework", verdicts: "correctness=approve,qa=reject" } })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/review evidence not bound to a factory run/);
  expect(lastReason(d)).toMatch(/are not the ones the review run recorded/);
});

test("MF-2: a handoff bound to a commit the review run never checked out does not merge", async () => {
  const d = baseD({ reviewRecord: vi.fn(async () => ({ ok: true, record: { ...RECORD_OK, headSha: "e".repeat(40) } })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/review evidence not bound to a factory run/);
});

test("MF-2: a replayed round number does not merge — the record pins the round too", async () => {
  const d = baseD({ reviewRecord: vi.fn(async () => ({ ok: true, record: { ...RECORD_OK, round: 1 } })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/the handoff says round 2, the review run recorded round 1/);
});

test("MF-2: an unreachable records branch fails closed — an unverified review is not a passed review", async () => {
  const d = baseD({ reviewRecord: vi.fn(async () => { throw new Error("git fetch failed: network"); }) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/review evidence not bound to a factory run/);
  expect(lastReason(d)).toMatch(/network/);
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("MF-2: the reviewRecord dep is required — a merge stage that cannot read the records branch refuses", async () => {
  const d = baseD({ reviewRecord: undefined });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/review-evidence deps not wired/);
  expect(lastReason(d)).toMatch(/reviewRecord/);
});

// ── 리뷰 batch-2 MF-2 — 증거는 **이 이슈의 review 런**에 묶인다(파일의 마지막 줄이 아니라) ────────
// 재리뷰가 재현한 것: `docs/factory/runs/**`는 에이전트가 쓸 수 있었고 파서는 마지막 줄을 골랐다 —
// 곧 implement 에이전트가 가짜 `## review` 섹션을 심으면 그것이 권위 있는 증거가 됐다.

test("MF-2b: the expected run id comes from the issue's review heartbeat and is handed to the record lookup", async () => {
  const d = baseD();
  expect(await run(d)).toBe(0);
  expect(d.reviewRunId).toHaveBeenCalled();
  expect(d.reviewRecord).toHaveBeenCalledWith({ runId: RUN });
});

test("MF-2b: a record line written by a different run does not merge (the forged section)", async () => {
  const d = baseD({ reviewRecord: vi.fn(async () => ({ ok: true, record: { ...RECORD_OK, runId: "999", runnerId: "gha-999" } })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/written by run 999, but the review stage on this issue ran as 34809992796/);
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("MF-2b: no review heartbeat on the issue is undecidable, not a pass", async () => {
  const d = baseD({ reviewRunId: vi.fn(async () => ({ ok: false, reason: "no review-stage heartbeat on issue #7" })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/review evidence not bound to a factory run/);
  expect(lastReason(d)).toMatch(/no review-stage heartbeat/);
  expect(d.reviewRecord).not.toHaveBeenCalled();
  expect(d.mergePr).not.toHaveBeenCalled();
});

test("MF-2b: the reviewRunId dep is required — without it the merge stage cannot name the review run", async () => {
  const d = baseD({ reviewRunId: undefined });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/review-evidence deps not wired/);
  expect(lastReason(d)).toMatch(/reviewRunId/);
});

test("MF-2b: the record line naming no run at all does not merge", async () => {
  const d = baseD({ reviewRecord: vi.fn(async () => ({ ok: true, record: { ...RECORD_OK, runId: "none" } })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/names no factory run/);
});

test("MF-2: provenance is checked BEFORE the two-actor approval", async () => {
  const d = baseD({ twoActor: true, approvePr: vi.fn(async () => {}), reviewRecord: vi.fn(async () => ({ ok: true, record: null })) });
  expect(await run(d)).toBe(2);
  expect(d.approvePr).not.toHaveBeenCalled();
  expect(d.mergePr).not.toHaveBeenCalled();
});

// ── ADR-024 / KTB-42 — qa 증거 매니페스트의 지문은 run 기록에서만 읽을 수 있다 ──────────────────
// `.factory/out/`는 gitignore다 — 머지 잡의 새 체크아웃에 매니페스트 파일은 존재하지 않는다.
// 그래서 머지가 볼 수 있는 유일한 증인이 review 런이 남긴 `qa_manifest=` 한 줄이다.

test("KTB-42: the roster includes qa but the review run recorded no qa_manifest → refuse, and name the tool", async () => {
  const d = baseD({ reviewRecord: vi.fn(async () => ({ ok: true, record: { ...RECORD_OK, qaManifest: null } })) });
  expect(await run(d)).toBe(2);
  refusedReview(d);
  expect(lastReason(d)).toMatch(/no qa_manifest digest/);
  expect(lastReason(d)).toMatch(/qa-evidence\.js finish/);
});

test("KTB-42: the recorded digest rides along to the merged transition (requirements re-asks there)", async () => {
  const d = baseD();
  expect(await run(d)).toBe(0);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:merged", qaManifestRecorded: QA_DIGEST }));
});

test("KTB-42: a roster without qa needs no manifest — an uncalled reviewer's missing evidence is not a defect", async () => {
  const d = baseD({
    reviewRoster: vi.fn(async () => ({ ok: true, roles: ["correctness"] })),
    reviewEvidence: vi.fn(async () => ({ ok: true, data: { ...REVIEW_OK, verdicts: REVIEW_OK.verdicts.filter((v) => v.role !== "qa") } })),
    reviewRecord: vi.fn(async () => ({ ok: true, record: { ...RECORD_OK, verdicts: "correctness=approve", qaManifest: null } })),
  });
  expect(await run(d)).toBe(0);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:merged", qaManifestRecorded: null }));
});

// ── (7) 외부 감사 H6 — 머지 전이 텍스트가 사람의 서명 유무를 말한다 ─────────────────────────

test("H6: the merged transition says whether a person signed this PR", async () => {
  const on = baseD({ humanGate: true });
  expect(await run(on)).toBe(0);
  expect(on.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:merged", reason: expect.stringMatching(/required reviewer/) }));

  const off = baseD({ humanGate: false });
  expect(await run(off)).toBe(0);
  expect(off.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:merged", reason: expect.stringMatching(/no per-PR human signature \(CHARTER merge\.human_gate=false\)/) }));

  const unset = baseD();
  expect(await run(unset)).toBe(0);
  expect(unset.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:merged", reason: expect.stringMatching(/charter\.merge-human-gate-unset/) }));
});


// ── 최종 리뷰 B-MF2 — merge 스테이지의 blocked 복귀 hop과 KTB-42의 qa 게이트 ────────────────────

import { buildCtxExtra } from "../bin/run-stage.js";
import { requirementFor } from "../lib/requirements.js";
import { renderHandoff } from "../lib/handoff.js";

/**
 * merge 스테이지는 script-only다 — `buildContext`를 거치지 않으므로 `ctxCache`가 없고, `buildCtxExtra`는
 * `roster`/`rosterSize`를 채우지 못한다. KTB-42가 `factory:approved`에 건 `qaEvidenceGate`는 로스터를
 * 못 구하면 fail closed이므로, 그 스테이지가 `factory:approved`를 겨누는 **유일한 자리** — KTB-15b의
 * blocked 복귀 hop((4b), 게이트를 방금 GREEN으로 다시 확인한 직후) — 이 "review roster unresolved"로
 * 영원히 거부됐다. `main()`은 `to === "factory:merged"`일 때만 로스터를 풀고 있었다.
 *
 * 이 테스트는 그 hop을 **진짜 요구조건**으로 돌린다: `deps.transition`의 모양 그대로 ctxExtra를 만들고
 * `requirementFor("factory:approved")`에 먹인다.
 */
const approvedHopGh = () => ({
  comments: vi.fn(async () => [
    { id: 1, body: renderHandoff({ stage: "implement", issue: 7, summary: "s", data: { schema: "factory.implement.v1", issue: 7, pr: 9, head_sha: HEAD } }), createdAt: "2026-09-14T08:00:00Z" },
    { id: 2, body: renderHandoff({ stage: "review", issue: 7, summary: "s", data: REVIEW_OK }), createdAt: "2026-09-14T09:00:00Z" },
  ]),
  prHeadSha: vi.fn(async () => HEAD),
});
const GREEN_GATES_FILE = { schema: "factory.gates.v1", level: "full", status: "GREEN", head_sha: HEAD, passed: 3, failed: 0, skipped: [], misconfigured: [], tests: { excluded: [] } };

/** `run-stage.js`의 `deps.transition`이 merge 스테이지에서 하는 일 그대로(로스터 해석 조건이 인자다). */
const mergeHopRequirement = async ({ to, resolveRosterFor }) => {
  const gh = approvedHopGh();
  const reviewRoster = resolveRosterFor.includes(to) ? ["correctness", "qa"] : null;
  const ctxExtra = await buildCtxExtra({
    gh, issue: 7, to, data: undefined, ctx: undefined, reviewRoster, maxRounds: 3,
    // 머지 잡에는 매니페스트 파일이 없다 — 로스터에 qa가 없을 때의 모양(skipped)이 아니라,
    // 리뷰 런이 이 커밋에 대해 유효하다고 판정한 요약을 그대로 흉내낸다.
    qaEvidence: async () => ({ ok: true, digest: QA_DIGEST, head_sha: HEAD, missing: [], reasons: [], claimIds: ["dw1"], counts: { claims: 1, na: 0 } }),
  });
  ctxExtra.gatesChecked = true;
  ctxExtra.gatesFile = GREEN_GATES_FILE;
  return requirementFor(to)({ comments: await gh.comments(7), ...ctxExtra });
};

test("B-MF2: the merge stage's blocked→approved hop passes the qa gate when the roster is resolved for that target too", async () => {
  // 고쳐진 모양: `factory:merged`와 `factory:approved` 둘 다 로스터를 푼다.
  const fixed = await mergeHopRequirement({ to: "factory:approved", resolveRosterFor: ["factory:merged", "factory:approved"] });
  expect(fixed).toEqual({ ok: true });

  // 회귀: `factory:merged`에만 풀면 같은 hop이 로스터 미해결로 fail closed가 된다 — 그 상태에서는
  // 게이트를 몇 번 다시 GREEN으로 돌려도 merge 잡이 blocked에서 빠져나오지 못한다.
  const regressed = await mergeHopRequirement({ to: "factory:approved", resolveRosterFor: ["factory:merged"] });
  expect(regressed.ok).toBe(false);
  expect(regressed.reason).toMatch(/review roster unresolved/);
});

test("B-MF2: the same fix makes the quorum measurable on that hop — a short roster is caught, not silently skipped", async () => {
  const gh = approvedHopGh();
  const ctxExtra = await buildCtxExtra({
    gh, issue: 7, to: "factory:approved", data: undefined, ctx: undefined,
    reviewRoster: ["correctness", "qa", "security"],                 // 리뷰는 둘만 돌았다
    qaEvidence: async () => ({ ok: true, digest: QA_DIGEST, head_sha: HEAD, missing: [], reasons: [], claimIds: ["dw1"], counts: { claims: 1, na: 0 } }),
  });
  ctxExtra.gatesChecked = true;
  ctxExtra.gatesFile = GREEN_GATES_FILE;
  const r = requirementFor("factory:approved")({ comments: await gh.comments(7), ...ctxExtra });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/verdict count 2 != roster size 3/);
});

// ── #157 — a merge-gate RED on a test outside the PR's diff is re-run once before needs-human ──────────
//
// own-calendar #111 (2026-10-02 01:52Z): a client-only PR with 3/3 approvals went to needs-human because
// `server/tests/follows.test.ts::test_49_event_visibility` (131/132 passed) flaked at merge. Every gates
// fixture below comes out of the real producer (`runGates` / `runStageGates` with a fake runner and a real
// vitest JSON report) — a hand-typed partial object would let the eligibility rule read fields the producer
// never writes (dw4).
const FLAKY_TEXT_157 = "PR 밖의 테스트가 두 번 RED — flaky 후보";
const OC_ID = "server/tests/follows.test.ts::test_49_event_visibility";
const GATE_ROOT = "/repo";
const STAMP_157 = { runId: "18113", runnerId: "gha-18113", round: null };
const CLIENT_ONLY = ["client/src/pages/Calendar.tsx", "client/src/api/follows.ts"];
const HARNESS_157 = (omitLint = false) => ({
  harness: { maturity: "M0" },
  gates: { fast: ["lint", "unit"], required: ["lint", "unit"], thresholds: {} },
  commands: { ...(omitLint ? {} : { lint: "node factory/bin/lint.js" }), unit: "npx vitest run --reporter=json --outputFile=.factory/out/unit.json" },
  test: {},
});
/** A vitest `--reporter=json` report whose failing assertions are exactly `failingIds` (`path::name`). */
function vitestReport157(failingIds, total = 132) {
  const byFile = new Map();
  for (const id of failingIds) {
    const [file, name] = id.split("::");
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(name);
  }
  return JSON.stringify({
    numTotalTests: total, numPassedTests: total - failingIds.length, numFailedTests: failingIds.length,
    testResults: [...byFile].map(([file, names]) => ({ name: `${GATE_ROOT}/${file}`, assertionResults: names.map((n) => ({ status: "failed", fullName: n })) })),
  });
}
/**
 * "The report on disk" for a produced gates object: the exact text `runGates` parsed for each test gate, keyed by
 * that gate entry's `failing_ids` array (it survives the shallow `{ ...g }` copies the cases below derive). The
 * merge stage's `suiteFailures` dep reads the report the gate run left behind — this registry is that file.
 */
const REPORTS_157 = new WeakMap();
const registerReports157 = (g, byGate) => { for (const [name, text] of Object.entries(byGate)) if (g.gates?.[name]?.failing_ids) REPORTS_157.set(g.gates[name].failing_ids, text); return g; };
const reportOnDisk157 = (g, name) => REPORTS_157.get(g?.gates?.[name]?.failing_ids) ?? null;
/** factory.gates.v1 from the real `runGates` — lint + unit, the unit report read from a real vitest JSON. */
async function producedGates({ failing = [], lint = "GREEN", report = true, unitExit, omitLint = false, sha = "a".repeat(40) } = {}) {
  const harness = HARNESS_157(omitLint);
  const fake = makeFakeRun([
    { match: (_c, a) => a[1] === harness.commands.lint, result: { code: lint === "RED" ? 1 : 0, stdout: "", stderr: lint === "RED" ? "factory/lib/x.js\n  3:1  error  no-unused-vars" : "" } },
    { match: (_c, a) => a[1] === harness.commands.unit, result: { code: unitExit ?? (failing.length ? 1 : 0), stdout: "JSON report written to .factory/out/unit.json", stderr: "" } },
  ]);
  const text = report ? vitestReport157(failing) : null;
  const g = await runGates({ run: fake, cwd: GATE_ROOT, harness, level: "fast", quarantine: { quarantined: [] }, readFile: () => text, now: "2026-10-02T01:52:00.000Z" });
  return registerReports157({ ...g, head_sha: sha }, { unit: text });
}
/** factory.gates.v1 BLOCKED from the real `runStageGates` (test-env re-up failed — the merge-stage BLOCKED producer). */
async function producedBlockedGates() {
  const { runStageGates } = await import("../lib/gates.js");
  const harness = { ...HARNESS_157(), test: { env: { compose: "docker-compose.test.yml" } } };
  const fake = makeFakeRun([
    { match: (c, a) => c === "node" && a[1] === "up", result: { code: 1, stdout: "", stderr: "compose: exit 1" } },
    { match: (c, a) => c === "git" && a[0] === "rev-parse", result: { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" } },
  ]);
  return runStageGates({ run: fake, cwd: GATE_ROOT, harness, stage: "merge", tier: "standard", base: "c".repeat(40), now: "2026-10-02T01:52:00.000Z" });
}
/**
 * Drives runMergeStage with `d.gates` answering `seq` in order (a function entry is called — it may throw).
 * A call past the end of `seq` answers GREEN, so an implementation that runs the gates a third time is
 * caught by the call count AND by reaching mergePr, not hidden behind a crash.
 */
async function run157({ seq, diff, retryFromBlocked = false, startFrom = "factory:approved", over = {} }) {
  const { lines, record: push } = makeRecord();
  const record = vi.fn(push);                                                  // call order is evidence (dw1: rerun line before the 2nd gates run)
  const postStatus = basePostStatus();
  const extra = await producedGates({ failing: [] });
  let i = 0;
  const gates = vi.fn(async () => { const v = i < seq.length ? seq[i] : extra; i++; return typeof v === "function" ? v() : v; });
  const diffDep = diff === undefined ? {} : { diffFiles: vi.fn(typeof diff === "function" ? diff : async () => diff) };
  // The suite-failure reader is the real one (`idlessFailedSuites`) over the report the gate run "left on disk".
  const suiteFailures = vi.fn(async (g) => idlessFailedSuites({ gates: g, root: GATE_ROOT, readReport: (name) => reportOnDisk157(g, name) }));
  // run-stage always wires resetGates (makeStageGateDeps); a case that needs it absent passes `over: { resetGates: undefined }`.
  const resetGates = vi.fn(async () => {});
  const d = baseD({ gates, transition: graphTransition(startFrom), ...diffDep, suiteFailures, resetGates, ...over });
  const code = await runMergeStage({ issue: 7, defaultBranch: "main", headSha: HEAD, d, record, refusal, postStatus, retryFromBlocked, stamp: STAMP_157 });
  return { code, d, lines, postStatus, record };
}
const detailsOf = (lines) => lines.filter((l) => l.startsWith("gates-detail: ")).map((l) => JSON.parse(l.slice("gates-detail: ".length)));
const flakyMarksOf = (lines) => lines.filter((l) => l.startsWith("factory-flaky-candidate: ")).map((l) => JSON.parse(l.slice("factory-flaky-candidate: ".length)));
const gateStatusesOf = (postStatus) => postStatus.mock.calls.map((c) => c[0]).filter((s) => s.context === "factory/gates");
const transitionsOf = (d) => d.transition.mock.calls.map((c) => c[0]);
/**
 * "Today's record" as a LITERAL, not as another run of the new code. Comparing against a run without `diffFiles`
 * only proves the two new-code paths agree — a line the change adds on every RED (e.g. `merge: re-run not proven
 * — …`) would sit in both and pass. So the gate step's record is pinned to exactly what the pre-#157 step (4)
 * wrote (main @ 72906cc, merge-stage.js `record([...])` in the BLOCKED and non-GREEN branches): the verdict line,
 * the stamped gates-detail lines (gates.js `gatesDetailLines`, unchanged by #157), and the test-env note.
 * `gateStepLines` cuts the record at the last line written before step (4) — nothing after it may differ.
 */
const GATE_STEP_START = "merge: agent role sections within policy";
const gateStepLines = (lines) => {
  const at = lines.indexOf(GATE_STEP_START);
  if (at < 0) throw new Error(`run record has no "${GATE_STEP_START}" line — the merge did not reach step (4)`);
  return lines.slice(at + 1);
};
function pre157GateStepLines(g) {
  const envNote = g?.test_env_reup?.ran ? [`test-env: re-up ${g.test_env_reup.ok ? "ok" : `failed — ${g.test_env_reup.detail}`}`] : [];
  if (g?.status === "BLOCKED") return [`merge: gates BLOCKED — ${g.blocked_reason || "gates could not be decided"}`, ...envNote];
  return [`merge: gates ${g?.status ?? "missing"}`, ...gatesDetailLines(g, STAMP_157), ...envNote];
}
/**
 * Review sec-s1 (plan dw3/dw4): a refused re-run is not silent. The record is the LITERAL pre-#157 gate step plus
 * EXACTLY one `merge: no gates rerun — <reason>` line, right after the verdict line, bound to this run by the same
 * run_id/runner stamp the gates-detail lines carry. An on-call reader can then tell "refused, because X" from
 * "the feature is broken". The prefix and the stamp tag are literals here, not imports from the code under test.
 */
const NO_RERUN_157 = "merge: no gates rerun — ";
/** What the gates-detail projection makes of a reason string (gates.js `gatesDetailLines`, unchanged by #157). */
const gatesDetailReason157 = (reason) => JSON.parse(gatesDetailLines({ gates: { x: { status: "RED", reason, detail: { failing: [], snippet: "" } } } }, STAMP_157)[0].slice("gates-detail: ".length)).reason;
const STAMP_TAG_157 = "[run_id=18113 runner=gha-18113]";
const refusalLinesOf = (lines) => lines.filter((l) => l.startsWith(NO_RERUN_157));
const withoutRefusal = (lines) => lines.filter((l) => !l.startsWith(NO_RERUN_157));
function expectRefusedRecord157(lines, g, name, why) {
  const step = gateStepLines(lines);
  const pre = pre157GateStepLines(g);
  const refusals = refusalLinesOf(step);
  expect(refusals, name).toHaveLength(1);
  expect(refusals[0].endsWith(` ${STAMP_TAG_157}`), `${name}: ${refusals[0]}`).toBe(true);
  expect(refusals[0], name).toMatch(why);
  expect(step, name).toEqual([pre[0], refusals[0], ...pre.slice(1)]);
  // Nothing else of the re-run path leaks into a refusal: no rerun line, no flaky-candidate marker.
  expect(withoutRefusal(lines).some((l) => /rerun|flaky-candidate/.test(l)), name).toBe(false);
}
/**
 * factory.gates.v1 from the real `runGates` with the gate ORDER chosen by the caller and an optional
 * `integration` test gate (`null` = GREEN, an id list = RED with that parsed report, "unparsed" = RED with no
 * report). The order matters: a rule that only looks at the first RED gate passes when the disqualifying gate
 * happens to come first, so these fixtures put an eligible test gate first and the disqualifier after it.
 */
async function producedGatesOrdered157({ order, unit = [], integration = null, lint = "GREEN" }) {
  const harness = {
    harness: { maturity: "M0" },
    gates: { fast: order, required: order, thresholds: {} },
    commands: {
      lint: "node factory/bin/lint.js",
      unit: "npx vitest run --reporter=json --outputFile=.factory/out/unit.json",
      integration: "npx vitest run --config vitest.integration.config.ts --reporter=json --outputFile=.factory/out/integration.json",
    },
    test: {},
  };
  const fake = makeFakeRun([
    { match: (_c, a) => a[1] === harness.commands.lint, result: { code: lint === "RED" ? 1 : 0, stdout: "", stderr: lint === "RED" ? "factory/lib/x.js\n  3:1  error  no-unused-vars" : "" } },
    { match: (_c, a) => a[1] === harness.commands.unit, result: { code: unit.length ? 1 : 0, stdout: "", stderr: "" } },
    { match: (_c, a) => a[1] === harness.commands.integration, result: { code: integration === null ? 0 : 1, stdout: "", stderr: integration === "unparsed" ? "Error: Cannot find module 'pg'" : "" } },
  ]);
  const texts = { unit: vitestReport157(unit), integration: Array.isArray(integration) ? vitestReport157(integration) : null };
  const readFile = (p) => (String(p).endsWith("integration.json") ? texts.integration : texts.unit);
  const g = await runGates({ run: fake, cwd: GATE_ROOT, harness, level: "fast", quarantine: { quarantined: [] }, readFile, now: "2026-10-02T01:52:00.000Z" });
  return registerReports157({ ...g, head_sha: "a".repeat(40) }, texts);
}

test("test_157_merge_gate_red_outside_the_diff_reruns_once", async () => {
  // The real own-calendar #111 shape: client-only diff, one parsed server test RED, whole-GREEN re-run.
  // Both runs are on the PR head the merge stage checked out (runStageGates stamps `git rev-parse HEAD`), so the
  // status assertions below can name the sha mergePr merges — HEAD — rather than restate whatever the fixture says.
  const first = await producedGates({ failing: [OC_ID], sha: HEAD });
  const second = await producedGates({ failing: [], sha: HEAD });
  expect(first.status).toBe("RED");
  expect(first.gates.unit).toMatchObject({ status: "RED", parsed: true, failing_ids: [OC_ID] });
  expect(second.status).toBe("GREEN");

  // No prReady here: with the draft flip wired, (6a-ii) legitimately calls mergeGates a second time.
  const r = await run157({ seq: [first, second], diff: { ok: true, files: CLIENT_ONLY }, over: { prReady: undefined } });
  expect(r.code).toBe(0);
  expect(r.d.gates).toHaveBeenCalledTimes(2);
  expect(r.d.diffFiles).toHaveBeenCalled();
  // mergeGates runs once, and only after the re-run resolved — it is not the re-run.
  expect(r.d.mergeGates).toHaveBeenCalledTimes(1);
  expect(r.d.mergeGates.mock.invocationCallOrder[0]).toBeGreaterThan(r.d.gates.mock.invocationCallOrder[1]);
  expect(r.d.mergePr).toHaveBeenCalledWith(9);
  // #184 dw1: the first run's report is cleared exactly once, strictly between the two gate runs (cf1).
  expect(r.d.resetGates).toHaveBeenCalledTimes(1);
  expect(r.d.resetGates.mock.invocationCallOrder[0]).toBeGreaterThan(r.d.gates.mock.invocationCallOrder[0]);
  expect(r.d.resetGates.mock.invocationCallOrder[0]).toBeLessThan(r.d.gates.mock.invocationCallOrder[1]);
  expect(r.d.mergePr.mock.invocationCallOrder[0]).toBeGreaterThan(r.d.gates.mock.invocationCallOrder[1]);
  // The commit status follows the final verdict, so the required `factory/gates` check is not left RED.
  const statuses = gateStatusesOf(r.postStatus);
  expect(statuses.map((s) => s.state)).toEqual(["failure", "success"]);
  // The success lands on the PR head itself — the sha runMergeStage was given and the required check is read on.
  expect(statuses.map((s) => s.sha)).toEqual([HEAD, HEAD]);
  const merged = transitionsOf(r.d).find((t) => t.to === "factory:merged");
  expect(merged).toBeTruthy();
  expect(merged.mergeGatesResult).toEqual({ checksGreen: true, integrityGreen: true });
  // The first RED is not lost: its stamped gates-detail line, a rerun line naming the id, and a stamped marker.
  const details = detailsOf(r.lines);
  expect(details).toHaveLength(1);
  expect(details[0]).toMatchObject({ gate: "unit", run_id: "18113", runner: "gha-18113", failing: [OC_ID], parsed: true });
  expect(r.lines.some((l) => /^merge: .*rerun/.test(l) && l.includes(OC_ID))).toBe(true);
  expect(flakyMarksOf(r.lines)).toEqual([expect.objectContaining({ test: OC_ID, outcome: "GREEN", run_id: "18113", runner: "gha-18113" })]);
  expect(r.lines).toContain("merge: gates GREEN");
  // dw1: the rerun line is stamped to this run and reached the record BEFORE the second gates run started, together
  // with the first run's gates-detail line — so a job killed during the re-run (timeout) is told apart from one
  // killed in the first run, and the first RED's evidence survives the re-run overwriting gates.json.
  const rerunLine = r.lines.find((l) => l.startsWith("merge: gates RED outside the PR diff — rerun 1/1 ("));
  expect(rerunLine).toContain(OC_ID);
  expect(rerunLine.endsWith(` ${STAMP_TAG_157}`)).toBe(true);
  const recordCallOf = (pred) => r.record.mock.calls.findIndex((c) => c[0].some(pred));
  const secondGatesRun = r.d.gates.mock.invocationCallOrder[1];
  expect(r.record.mock.invocationCallOrder[recordCallOf((l) => l === rerunLine)]).toBeLessThan(secondGatesRun);
  expect(r.record.mock.invocationCallOrder[recordCallOf((l) => l.startsWith("gates-detail: ") && l.includes(OC_ID))]).toBeLessThan(secondGatesRun);
  expect(refusalLinesOf(r.lines)).toEqual([]);                                 // a re-run that happened is not a refusal

  // The production dep shape: prReady wired (run-stage always wires it), so (6a-ii) re-checks mergeGates after
  // the draft flip. Both mergeGates calls and the flip come after the re-run resolved; the PR still merges,
  // the factory/gates status ends `success`, and the first RED's trace is kept.
  const prod = await run157({ seq: [first, second], diff: { ok: true, files: CLIENT_ONLY } });
  expect(typeof prod.d.prReady).toBe("function");
  expect(prod.code).toBe(0);
  expect(prod.d.gates).toHaveBeenCalledTimes(2);
  expect(prod.d.mergeGates).toHaveBeenCalledTimes(2);
  const rerunAt = prod.d.gates.mock.invocationCallOrder[1];
  expect(prod.d.resetGates).toHaveBeenCalledTimes(1);
  expect(prod.d.resetGates.mock.invocationCallOrder[0]).toBeGreaterThan(prod.d.gates.mock.invocationCallOrder[0]);
  expect(prod.d.resetGates.mock.invocationCallOrder[0]).toBeLessThan(rerunAt);
  expect(gateStatusesOf(prod.postStatus).at(-1)).toMatchObject({ state: "success", sha: HEAD });
  for (const order of prod.d.mergeGates.mock.invocationCallOrder) expect(order).toBeGreaterThan(rerunAt);
  expect(prod.d.prReady).toHaveBeenCalledTimes(1);
  expect(prod.d.prReady.mock.invocationCallOrder[0]).toBeGreaterThan(rerunAt);
  expect(prod.d.mergePr).toHaveBeenCalledWith(9);
  expect(prod.d.mergePr.mock.invocationCallOrder[0]).toBeGreaterThan(prod.d.prReady.mock.invocationCallOrder[0]);
  expect(gateStatusesOf(prod.postStatus).map((s) => s.state)).toEqual(["failure", "success"]);
  expect(gateStatusesOf(prod.postStatus).map((s) => s.sha)).toEqual([HEAD, HEAD]);
  expect(transitionsOf(prod.d).map((t) => t.to)).toEqual(["factory:merged"]);
  expect(transitionsOf(prod.d)[0].mergeGatesResult).toEqual({ checksGreen: true, integrityGreen: true });
  expect(detailsOf(prod.lines)).toEqual([expect.objectContaining({ gate: "unit", run_id: "18113", runner: "gha-18113", failing: [OC_ID] })]);
  expect(prod.lines.some((l) => /^merge: .*rerun/.test(l) && l.includes(OC_ID))).toBe(true);
  expect(flakyMarksOf(prod.lines)).toEqual([expect.objectContaining({ test: OC_ID, outcome: "GREEN", run_id: "18113", runner: "gha-18113" })]);

  // A blocked→approved retry: the 4b hop happens only after the re-run is GREEN (it sees the re-run, not the RED).
  const retry = await run157({ seq: [first, second], diff: { ok: true, files: CLIENT_ONLY }, retryFromBlocked: "factory:approved", startFrom: "factory:blocked" });
  expect(retry.code).toBe(0);
  const approvedIdx = transitionsOf(retry.d).findIndex((t) => t.to === "factory:approved");
  expect(approvedIdx).toBeGreaterThanOrEqual(0);
  expect(retry.d.transition.mock.invocationCallOrder[approvedIdx]).toBeGreaterThan(retry.d.gates.mock.invocationCallOrder[1]);
  expect(transitionsOf(retry.d).map((t) => t.to)).toEqual(["factory:approved", "factory:merged"]);
  for (const order of retry.d.mergeGates.mock.invocationCallOrder) expect(order).toBeGreaterThan(retry.d.gates.mock.invocationCallOrder[1]);
  expect(gateStatusesOf(retry.postStatus).map((s) => s.state)).toEqual(["failure", "success"]);

  // A GREEN re-run does not override a later refusal: mergeGates not GREEN still goes to needs-human for that reason.
  const later = await run157({ seq: [first, second], diff: { ok: true, files: CLIENT_ONLY }, over: { mergeGates: vi.fn(async () => ({ checksGreen: false, integrityGreen: true })) } });
  expect(later.code).toBe(2);
  expect(later.d.gates).toHaveBeenCalledTimes(2);
  expect(later.d.mergePr).not.toHaveBeenCalled();
  expect(transitionsOf(later.d)).toEqual([expect.objectContaining({ to: "factory:needs-human", reason: "required checks not GREEN" })]);
});

/**
 * #184 dw2 — factory.gates.v1 from the MERGE stage's real producer (`runStageGates({ stage: "merge" })`, the function
 * run-stage's merge `d.gates` calls), with every flaky-harvest dep it accepts (`gh`, `saveQuarantine`, `transitionIssue`)
 * handed in as a spy. A command the gate step does not own (isolation/base runs, a classify worktree) is answered ok and
 * logged, so a merge-stage classifier would produce a verdict here instead of crashing on an unknown command.
 */
async function mergeStageGates184({ failing, sha = HEAD }) {
  const { runStageGates } = await import("../lib/gates.js");
  const harness = {
    ...HARNESS_157(),
    gates: { fast: ["lint", "unit"], full: ["lint", "unit"], deep: ["lint", "unit"], required: ["lint", "unit"], thresholds: { new_test_repeats: 1, flaky_isolation_runs: 1, flaky_base_runs: 2, flaky_max: 2, quarantine_max_effective: 3 } },
    commands: { ...HARNESS_157().commands, test_files: "npx vitest run {files}", test_one: "npx vitest run {file} -t {name}" },
    test: { test_glob: ["**/*.test.ts"], source_glob: ["**/*.ts", "**/*.tsx"] },
  };
  const ok0 = { code: 0, stdout: "", stderr: "" };
  const fake = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "diff" && a.includes("--name-status"), result: { code: 0, stdout: CLIENT_ONLY.map((f) => `M\t${f}`).join("\n") + "\n", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "rev-parse", result: { code: 0, stdout: `${sha}\n`, stderr: "" } },
    { match: (_c, a) => a[1] === harness.commands.lint, result: ok0 },
    { match: (_c, a) => a[1] === harness.commands.unit, result: { code: failing.length ? 1 : 0, stdout: "", stderr: "" } },
    { match: () => true, result: ok0 },                                         // anything else: logged, answered ok
  ]);
  const text = vitestReport157(failing);
  const gh = { searchIssues: vi.fn(async () => []), createIssue: vi.fn(async () => 99), comment: vi.fn(async () => {}), addLabel: vi.fn(async () => {}), issue: vi.fn(async () => ({ body: "" })) };
  const saveQuarantine = vi.fn(async () => {});
  const transitionIssue = vi.fn(async () => ({ ok: true }));
  const g = await runStageGates({ run: fake, cwd: GATE_ROOT, harness, stage: "merge", tier: "standard", base: "c".repeat(40), quarantine: { quarantined: [] }, gh, issue: 7, readFile: () => text, now: "2026-10-02T01:52:00.000Z", saveQuarantine, transitionIssue });
  return { g: registerReports157(g, { unit: text }), fake, gh, saveQuarantine, transitionIssue, harness };
}

test("test_157_second_red_is_needs_human_with_flaky_candidate_marker", async () => {
  const ids = [OC_ID, "server/tests/follows.test.ts::test_50_follow_feed"];
  const first = await producedGates({ failing: ids });
  const again = await producedGates({ failing: [...ids].reverse() });           // same set, other order

  const same = await run157({ seq: [first, again], diff: { ok: true, files: CLIENT_ONLY } });
  expect(same.code).toBe(2);
  expect(same.d.gates).toHaveBeenCalledTimes(2);
  expect(same.d.mergeGates).not.toHaveBeenCalled();
  expect(same.d.mergePr).not.toHaveBeenCalled();
  const nh = transitionsOf(same.d);
  expect(nh).toHaveLength(1);
  expect(nh[0].to).toBe("factory:needs-human");
  expect(nh[0].reason).toContain(FLAKY_TEXT_157);
  for (const id of ids) expect(nh[0].reason).toContain(id);
  // One marker per id, bound to this run exactly like gates-detail; both runs' gates-detail lines kept.
  const marks = flakyMarksOf(same.lines);
  expect(marks.map((m) => m.test).sort()).toEqual([...ids].sort());
  for (const m of marks) expect(m).toMatchObject({ outcome: "RED", run_id: "18113", runner: "gha-18113" });
  const details = detailsOf(same.lines);
  expect(details).toHaveLength(2);
  for (const dl of details) expect(dl).toMatchObject({ gate: "unit", run_id: "18113", runner: "gha-18113" });
  expect(gateStatusesOf(same.postStatus).map((s) => s.state)).toEqual(["failure", "failure"]);
  // #184 dw2: the full marker text, naming each test, and nothing on the factory:flaky / harvest surface in the record.
  expect(nh[0].reason).toContain(`gates RED at merge — ${FLAKY_TEXT_157}: `);
  expect(same.lines.some((l) => /factory:flaky|flaky-existing|quarantin/.test(l))).toBe(false);

  // #184 dw2, through the merge stage's REAL gate producer: both RED runs come from `runStageGates({ stage: "merge" })`
  // with every harvest dep it accepts spied. Merge produces no classification verdict, runs no isolation/base command,
  // opens no factory:flaky issue, writes no quarantine entry and transitions no issue — only the needs-human with the marker.
  const p1 = await mergeStageGates184({ failing: [OC_ID] });
  const p2 = await mergeStageGates184({ failing: [OC_ID] });
  for (const p of [p1, p2]) {
    expect(p.g).toMatchObject({ status: "RED", head_sha: HEAD });
    expect(p.g.gates.unit).toMatchObject({ status: "RED", parsed: true, failing_ids: [OC_ID] });
    expect(p.g.classification).toBeUndefined();
    expect(p.g.quarantine_applied).toEqual([]);
    // Exactly one run of each gate command and nothing else but git: no isolation re-run, no base run, no worktree.
    const nonGit = p.fake.calls.filter((c) => c.cmd !== "git").map((c) => c.args[1]);
    expect(nonGit.sort()).toEqual([p.harness.commands.lint, p.harness.commands.unit].sort());
    expect(p.fake.calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree")).toEqual([]);
    expect(p.saveQuarantine).not.toHaveBeenCalled();
    expect(p.transitionIssue).not.toHaveBeenCalled();
    for (const fn of Object.values(p.gh)) expect(fn).not.toHaveBeenCalled();
  }
  const real = await run157({ seq: [p1.g, p2.g], diff: { ok: true, files: CLIENT_ONLY } });
  expect(real.code).toBe(2);
  expect(real.d.mergePr).not.toHaveBeenCalled();
  expect(transitionsOf(real.d)).toEqual([expect.objectContaining({ to: "factory:needs-human", reason: expect.stringContaining(`${FLAKY_TEXT_157}: ${OC_ID}`) })]);
  expect(flakyMarksOf(real.lines)).toEqual([expect.objectContaining({ test: OC_ID, outcome: "RED", run_id: "18113", runner: "gha-18113" })]);
  expect(real.lines.some((l) => /factory:flaky|flaky-existing|quarantin/.test(l))).toBe(false);

  // A different set on the re-run: an ordinary needs-human that names both sets — no flaky wording, no marker.
  const other = await producedGates({ failing: ["server/tests/auth.test.ts::test_12_login"] });
  const diffSet = await run157({ seq: [first, other], diff: { ok: true, files: CLIENT_ONLY } });
  expect(diffSet.code).toBe(2);
  expect(diffSet.d.gates).toHaveBeenCalledTimes(2);
  expect(diffSet.d.mergePr).not.toHaveBeenCalled();
  const dr = transitionsOf(diffSet.d);
  expect(dr).toHaveLength(1);
  expect(dr[0].to).toBe("factory:needs-human");
  expect(dr[0].reason).toContain(OC_ID);
  expect(dr[0].reason).toContain("server/tests/auth.test.ts::test_12_login");
  expect(dr[0].reason).not.toContain("flaky");
  expect(flakyMarksOf(diffSet.lines)).toEqual([]);

  // A subset is not the same set either (one of the two flaked, the other is still RED → no marker).
  const subset = await run157({ seq: [first, await producedGates({ failing: [OC_ID] })], diff: { ok: true, files: CLIENT_ONLY } });
  expect(transitionsOf(subset.d)[0].reason).not.toContain("flaky");
  expect(flakyMarksOf(subset.lines)).toEqual([]);

  // Same SIZE, different ids ([A,B] then [A,C]): not the same set — a size-only comparison would mark it flaky.
  const swapped = [OC_ID, "server/tests/auth.test.ts::test_12_login"];
  const sameSize = await producedGates({ failing: swapped });
  expect(sameSize.gates.unit.failing_ids).toHaveLength(first.gates.unit.failing_ids.length);
  const sizeOnly = await run157({ seq: [first, sameSize], diff: { ok: true, files: CLIENT_ONLY } });
  expect(sizeOnly.code).toBe(2);
  expect(sizeOnly.d.gates).toHaveBeenCalledTimes(2);
  expect(sizeOnly.d.mergePr).not.toHaveBeenCalled();
  const sr = transitionsOf(sizeOnly.d);
  expect(sr).toHaveLength(1);
  expect(sr[0].to).toBe("factory:needs-human");
  expect(sr[0].reason).not.toContain("flaky");
  expect(sr[0].reason).toContain("server/tests/follows.test.ts::test_50_follow_feed");
  expect(sr[0].reason).toContain("server/tests/auth.test.ts::test_12_login");
  expect(flakyMarksOf(sizeOnly.lines)).toEqual([]);

  // Re-run BLOCKED → factory:blocked; re-run throws a typed base/diff error → factory:blocked; re-run gives no verdict (null) → factory:blocked.
  const blockedGates = await producedBlockedGates();
  expect(blockedGates.status).toBe("BLOCKED");
  const blocked = await run157({ seq: [first, blockedGates], diff: { ok: true, files: CLIENT_ONLY } });
  expect(blocked.code).toBe(2);
  expect(transitionsOf(blocked.d)).toEqual([expect.objectContaining({ to: "factory:blocked" })]);
  const thrown = await run157({ seq: [first, () => { throw new MergeBaseError("origin/main: exit 128"); }], diff: { ok: true, files: CLIENT_ONLY } });
  expect(thrown.code).toBe(2);
  expect(transitionsOf(thrown.d)).toEqual([expect.objectContaining({ to: "factory:blocked" })]);
  const thrownDiff = await run157({ seq: [first, () => { throw new GitDiffError("fatal: bad revision"); }], diff: { ok: true, files: CLIENT_ONLY } });
  expect(thrownDiff.code).toBe(2);
  expect(transitionsOf(thrownDiff.d)).toEqual([expect.objectContaining({ to: "factory:blocked" })]);
  // A re-run that returns no verdict at all could not decide anything (plan dw2): blocked, never needs-human-as-flaky.
  const missing = await run157({ seq: [first, null], diff: { ok: true, files: CLIENT_ONLY } });
  expect(missing.code).toBe(2);
  expect(transitionsOf(missing.d)).toEqual([expect.objectContaining({ to: "factory:blocked" })]);
  expect(transitionsOf(missing.d)[0].reason).not.toContain("flaky");
  expect(transitionsOf(missing.d)[0].reason).toMatch(/rerun/);
  for (const x of [blocked, thrown, thrownDiff, missing]) {
    // Every one leaves a reason line for the re-run's outcome on the record.
    expect(x.lines.some((l) => /^merge: gates rerun BLOCKED — \S/.test(l)), x.lines.join("\n")).toBe(true);
    expect(x.d.gates).toHaveBeenCalledTimes(2);              // never a third run
    expect(x.d.mergePr).not.toHaveBeenCalled();
    expect(flakyMarksOf(x.lines)).toEqual([]);
  }
});

// cf1 (review round 2, correctness + qa, confirmed on code lines): the re-run must not read the FIRST run's report. The stage's
// own `resetGates` runs before the re-run; a re-run that then writes no report is `parsed:false` — "inconclusive", never "RED twice".
test("test_157_rerun_without_a_report_is_inconclusive_not_flaky", async () => {
  const first = await producedGatesOrdered157({ order: ["integration"], integration: [OC_ID] });
  const unreported = await producedGatesOrdered157({ order: ["integration"], integration: "unparsed" });
  expect(unreported.gates.integration).toMatchObject({ status: "RED", parsed: false });
  const resetGates = vi.fn(async () => {});
  const r = await run157({ seq: [first, unreported], diff: { ok: true, files: CLIENT_ONLY }, over: { resetGates } });
  expect(r.code).toBe(2);
  expect(r.d.gates).toHaveBeenCalledTimes(2);
  // reset happened exactly once, after the first gates() and before the re-run
  expect(resetGates).toHaveBeenCalledTimes(1);
  const [g1, g2] = r.d.gates.mock.invocationCallOrder;
  const [reset] = resetGates.mock.invocationCallOrder;
  expect(reset).toBeGreaterThan(g1);
  expect(reset).toBeLessThan(g2);
  const t = transitionsOf(r.d);
  expect(t).toHaveLength(1);
  expect(t[0].to).toBe("factory:needs-human");
  expect(t[0].reason).toContain("rerun inconclusive");
  expect(t[0].reason).toContain("wrote no test report");
  // #184 dw4: the issue's phrase verbatim, not two halves that a changed join would still satisfy.
  expect(t[0].reason).toContain("rerun inconclusive — the re-run wrote no test report");
  expect(t[0].reason).not.toContain(FLAKY_TEXT_157);
  expect(flakyMarksOf(r.lines)).toEqual([]);
  expect(r.d.mergePr).not.toHaveBeenCalled();
  expect(r.d.mergeGates).not.toHaveBeenCalled();
});

test("test_157_superset_on_rerun_is_not_a_flaky_candidate", async () => {
  // First run fails [A]; the re-run fails [A, B]. Every first-run id is in the re-run set, so an
  // "every id of the first run is in the second" check alone would call this the same set — it is not.
  const extra = "server/tests/auth.test.ts::test_12_login";
  const first = await producedGates({ failing: [OC_ID] });
  const wider = await producedGates({ failing: [OC_ID, extra] });
  expect(first.gates.unit.failing_ids).toEqual([OC_ID]);
  expect([...wider.gates.unit.failing_ids].sort()).toEqual([OC_ID, extra].sort());

  const sup = await run157({ seq: [first, wider], diff: { ok: true, files: CLIENT_ONLY } });
  expect(sup.code).toBe(2);
  expect(sup.d.gates).toHaveBeenCalledTimes(2);
  expect(sup.d.mergeGates).not.toHaveBeenCalled();
  expect(sup.d.mergePr).not.toHaveBeenCalled();
  const tr = transitionsOf(sup.d);
  expect(tr).toHaveLength(1);
  expect(tr[0].to).toBe("factory:needs-human");
  expect(tr[0].reason).not.toContain(FLAKY_TEXT_157);
  expect(tr[0].reason).not.toContain("flaky");
  expect(tr[0].reason).toContain(OC_ID);
  expect(tr[0].reason).toContain(extra);
  expect(flakyMarksOf(sup.lines)).toEqual([]);
});

test("test_157_red_inside_the_diff_is_not_rerun", async () => {
  // Control: the same RED outside the diff IS re-run — so every "not re-run" below is the rule, not a missing feature.
  const red = await producedGates({ failing: [OC_ID] });
  const green = await producedGates({ failing: [] });
  const control = await run157({ seq: [red, green], diff: { ok: true, files: CLIENT_ONLY } });
  expect(control.d.gates).toHaveBeenCalledTimes(2);

  const cases = [
    { name: "the failing test file itself is in the diff", files: ["client/src/App.tsx", "server/tests/follows.test.ts"], why: /diff touches server\/, where server\/tests\/follows\.test\.ts lives/ },
    { name: "a diff file shares the test's top-level directory", files: ["server/src/routes/follows.ts"], why: /diff touches server\// },
    { name: "package.json at the repo root", files: [...CLIENT_ONLY, "package.json"], why: /repo-root file: package\.json/ },
    { name: "package-lock.json at the repo root", files: [...CLIENT_ONLY, "package-lock.json"], why: /repo-root file: package-lock\.json/ },
    { name: "vitest.config.ts at the repo root", files: [...CLIENT_ONLY, "vitest.config.ts"], why: /repo-root file: vitest\.config\.ts/ },
    { name: "tsconfig.json at the repo root", files: [...CLIENT_ONLY, "tsconfig.json"], why: /repo-root file: tsconfig\.json/ },
    { name: "a root-level markdown file still counts as touched", files: [...CLIENT_ONLY, "README.md"], why: /repo-root file: README\.md/ },
    { name: "the failing test file is at the repo root", files: CLIENT_ONLY, failing: ["follows.test.ts::test_49_event_visibility"], why: /failing test at the repo root: follows\.test\.ts/ },
    // Review cf-s3: a failing test under a CONVENTIONAL TEST ROOT (test, tests, __tests__, spec, e2e as the top-level
    // directory) counts as touched by any non-empty diff. In a single-package src/** + tests/** layout every tests/**
    // failure is "outside" every src-only PR, so without this rule the heuristic filters nothing and a deterministic
    // break the PR caused would be re-run and, on a second RED, labelled "flaky 후보". The list is literal here.
    { name: "tests/ failure, src/ diff (single-package layout)", files: ["src/calc.ts"], failing: ["tests/calc.test.ts::adds"], why: /tests\/calc\.test\.ts.*test root tests\// },
    { name: "test/ failure, lib/ diff", files: ["lib/calc.js"], failing: ["test/calc.test.js::adds"], why: /test root test\// },
    { name: "__tests__/ failure, src/ diff", files: ["src/calc.ts"], failing: ["__tests__/calc.test.ts::adds"], why: /test root __tests__\// },
    { name: "spec/ failure, app/ diff", files: ["app/models/user.rb"], failing: ["spec/models/user.spec.ts::validates"], why: /test root spec\// },
    { name: "e2e/ failure, web/ diff", files: ["web/pages/index.tsx"], failing: ["e2e/home.spec.ts::loads"], why: /test root e2e\// },
    { name: "tests/ failure, docs-only diff (the stated trade-off: still not re-run)", files: ["docs/guide.md"], failing: ["tests/unit/calc.test.ts::adds"], why: /test root tests\// },
  ];
  for (const c of cases) {
    const first = await producedGates({ failing: c.failing ?? [OC_ID] });
    expect(first.gates.unit.parsed, c.name).toBe(true);
    const withDiff = await run157({ seq: [first, green], diff: { ok: true, files: c.files } });
    const today = await run157({ seq: [first, green] });                        // no diffFiles dep = the pre-#157 path
    expect(withDiff.d.gates, c.name).toHaveBeenCalledTimes(1);
    expect(withDiff.code, c.name).toBe(2);
    expect(withDiff.d.mergePr, c.name).not.toHaveBeenCalled();
    expect(transitionsOf(withDiff.d), c.name).toEqual([expect.objectContaining({ to: "factory:needs-human", reason: "gates RED at merge" })]);
    expect(transitionsOf(withDiff.d), c.name).toEqual(transitionsOf(today.d));
    expect(withoutRefusal(withDiff.lines), c.name).toEqual(withoutRefusal(today.lines));
    expectRefusedRecord157(withDiff.lines, first, c.name, c.why);
    expect(withDiff.lines, c.name).toContain("merge: gates RED");
    expect(gateStatusesOf(withDiff.postStatus).map((s) => s.state), c.name).toEqual(["failure"]);
  }

  // Positive controls for the test-root rule: only the EXACT top-level names count. A `tests/` segment deeper in the
  // path (server/tests/…, the #111 shape) and a top-level dir that merely starts with a root name are re-run.
  for (const c of [
    { name: "server/tests/ under a client-only diff (#111)", failing: ["server/tests/x.test.ts::t"], files: ["client/a.ts"] },
    { name: "testkit/ is not tests/", failing: ["testkit/x.test.ts::t"], files: ["client/a.ts"] },
    { name: "specs/ is not spec/", failing: ["specs/x.test.ts::t"], files: ["client/a.ts"] },
    { name: "a test root name deeper in the path", failing: ["server/e2e/flow.test.ts::t"], files: ["src/calc.ts"] },
  ]) {
    const r = await run157({ seq: [await producedGates({ failing: c.failing }), green], diff: { ok: true, files: c.files } });
    expect(r.d.gates, c.name).toHaveBeenCalledTimes(2);
    expect(r.d.mergePr, c.name).toHaveBeenCalledWith(9);
    expect(refusalLinesOf(r.lines), c.name).toEqual([]);
  }
  // …and the list is defined once, in merge-stage.js, as exactly these five names.
  expect([...TEST_ROOT_DIRS].sort()).toEqual(["__tests__", "e2e", "spec", "test", "tests"]);

  // Several failing ids: the one inside the diff is NOT the first. Every id must be outside — a rule that
  // checks only the first failing id would re-run these and merge.
  const CLIENT_TEST = "client/tests/Calendar.test.ts::test_9_renders_week";
  const multi = [
    { name: "second id's package is in the diff", failing: [CLIENT_TEST, OC_ID], files: ["server/src/routes/follows.ts"], why: /diff touches server\// },
    { name: "third id's test file is in the diff", failing: [CLIENT_TEST, "shared/tests/date.test.ts::test_3_dst", OC_ID], files: ["docs/notes/x.md", "server/tests/follows.test.ts"], why: /diff touches server\// },
    { name: "second id is at the repo root", failing: [CLIENT_TEST, "follows.test.ts::test_49_event_visibility"], files: ["docs/notes/x.md"], why: /failing test at the repo root/ },
    { name: "second id sits under a test root", failing: [CLIENT_TEST, "tests/calc.test.ts::adds"], files: ["docs/notes/x.md"], why: /test root tests\// },
  ];
  for (const c of multi) {
    const first = await producedGates({ failing: c.failing });
    expect(first.gates.unit.failing_ids, c.name).toEqual(c.failing);           // the eligible id really is first
    // Control: the same RED with only the first id is re-run under this diff — so the refusal below is about the later id.
    const firstOnly = await producedGates({ failing: [c.failing[0]] });
    expect((await run157({ seq: [firstOnly, green], diff: { ok: true, files: c.files } })).d.gates, c.name).toHaveBeenCalledTimes(2);
    const withDiff = await run157({ seq: [first, green], diff: { ok: true, files: c.files } });
    const today = await run157({ seq: [first, green] });
    expect(withDiff.d.gates, c.name).toHaveBeenCalledTimes(1);
    expect(withDiff.code, c.name).toBe(2);
    expect(withDiff.d.mergePr, c.name).not.toHaveBeenCalled();
    expect(transitionsOf(withDiff.d), c.name).toEqual([expect.objectContaining({ to: "factory:needs-human", reason: "gates RED at merge" })]);
    expect(withoutRefusal(withDiff.lines), c.name).toEqual(withoutRefusal(today.lines));
    expectRefusedRecord157(withDiff.lines, first, c.name, c.why);
    expect(flakyMarksOf(withDiff.lines), c.name).toEqual([]);
  }
});

test("test_157_unreadable_diff_or_failing_list_is_no_rerun", async () => {
  const red = await producedGates({ failing: [OC_ID] });
  const green = await producedGates({ failing: [] });
  // Control: readable diff + parsed failing list outside it → re-run. Everything below removes one proof.
  const control = await run157({ seq: [red, green], diff: { ok: true, files: CLIENT_ONLY } });
  expect(control.d.gates).toHaveBeenCalledTimes(2);

  const parsedFalse = await producedGates({ failing: [OC_ID], report: false });
  expect(parsedFalse.gates.unit).toMatchObject({ status: "RED", parsed: false, failing_ids: [] });
  const noIds = await producedGates({ failing: [], unitExit: 1 });              // KTB-35: report read, 0 failing, command failed
  expect(noIds.gates.unit).toMatchObject({ status: "RED", parsed: true, failing_ids: [] });
  const mixed = await producedGates({ failing: [OC_ID], lint: "RED" });
  expect(mixed.gates.lint.status).toBe("RED");
  const misconfigured = await producedGates({ failing: [OC_ID], omitLint: true });
  expect(misconfigured.status).toBe("MISCONFIGURED");
  const outside = await producedGates({ failing: ["../elsewhere/follows.test.ts::test_49_event_visibility"] });
  expect(outside.gates.unit.failing_ids).toEqual(["../elsewhere/follows.test.ts::test_49_event_visibility"]);
  const blockedGates = await producedBlockedGates();
  // Derived from a produced RED with only `parsed` flipped: ids that no parsed report vouches for (another
  // parser's shape) are still not proof — the rule keys on `parsed === true`, not on ids being present.
  const unvouched = { ...red, gates: { ...red.gates, unit: { ...red.gates.unit, parsed: false } } };

  const cases = [
    { name: "failing ids with parsed:false", first: unvouched, diff: { ok: true, files: CLIENT_ONLY }, why: /unit is RED without a parsed test report/ },
    { name: "diffFiles ok:false", first: red, diff: { ok: false, files: [], reason: "git diff failed: fatal: bad revision" }, why: /PR diff unreadable or empty: git diff failed: fatal: bad revision/ },
    { name: "diffFiles throws GitDiffError", first: red, diff: async () => { throw new GitDiffError("fatal: bad revision"); }, why: /PR diff unreadable or empty: .*fatal: bad revision/ },
    { name: "diffFiles throws MergeBaseError", first: red, diff: async () => { throw new MergeBaseError("origin/main: exit 128"); }, why: /PR diff unreadable or empty: .*origin\/main: exit 128/ },
    { name: "diffFiles throws a plain Error", first: red, diff: async () => { throw new Error("boom"); }, why: /PR diff unreadable or empty: boom/ },
    { name: "diffFiles returns nothing", first: red, diff: async () => undefined, why: /PR diff unreadable or empty/ },
    { name: "diffFiles dep absent", first: red, diff: undefined, why: /PR diff unreadable or empty: diffFiles dep not wired/ },
    { name: "empty diff", first: red, diff: { ok: true, files: [] }, why: /PR diff unreadable or empty/ },
    { name: "files is not a list", first: red, diff: { ok: true, files: "client/src/App.tsx" }, why: /PR diff unreadable or empty/ },
    { name: "a diff path that cannot be normalised", first: red, diff: { ok: true, files: [...CLIENT_ONLY, "../server/x.ts"] }, why: /diff path not normalisable: \.\.\/server\/x\.ts/ },
    { name: "RED test gate with parsed:false", first: parsedFalse, diff: { ok: true, files: CLIENT_ONLY }, why: /unit is RED without a parsed test report/ },
    { name: "RED test gate with empty failing_ids", first: noIds, diff: { ok: true, files: CLIENT_ONLY }, why: /unit is RED with no failing test ids/ },
    { name: "lint RED alongside the test RED", first: mixed, diff: { ok: true, files: CLIENT_ONLY }, why: /lint is RED without a parsed test report/ },
    { name: "a MISCONFIGURED gate", first: misconfigured, diff: { ok: true, files: CLIENT_ONLY }, why: /gates MISCONFIGURED/ },
    { name: "a failing path that cannot be normalised", first: outside, diff: { ok: true, files: CLIENT_ONLY }, why: /failing test path not normalisable: \.\.\/elsewhere/ },
    // BLOCKED never reaches the re-run question (it is not a verdict) — its record stays exactly today's, no refusal line.
    { name: "gates BLOCKED stays blocked", first: blockedGates, diff: { ok: true, files: CLIENT_ONLY }, why: null },
  ];
  for (const c of cases) {
    const r = await run157({ seq: [c.first, green], diff: c.diff });
    const today = await run157({ seq: [c.first, green] });
    expect(r.code, c.name).toBe(2);
    expect(r.d.gates, c.name).toHaveBeenCalledTimes(1);
    expect(r.d.mergePr, c.name).not.toHaveBeenCalled();
    expect(transitionsOf(r.d), c.name).toEqual(transitionsOf(today.d));
    expect(withoutRefusal(r.lines), c.name).toEqual(withoutRefusal(today.lines));
    if (c.why) expectRefusedRecord157(r.lines, c.first, c.name, c.why);
    else expect(gateStepLines(r.lines), c.name).toEqual(pre157GateStepLines(c.first));
    expect(flakyMarksOf(r.lines), c.name).toEqual([]);
  }
  // Several RED gates where the FIRST is an eligible parsed test gate and a later one is not provable
  // (a non-test gate, or a test gate without a parsed report). A rule that only looks at the first RED gate
  // would re-run these and merge.
  const unitThenLint = await producedGatesOrdered157({ order: ["unit", "lint"], unit: [OC_ID], lint: "RED" });
  expect(Object.keys(unitThenLint.gates)).toEqual(["unit", "lint"]);
  expect(unitThenLint.gates.unit).toMatchObject({ status: "RED", parsed: true, failing_ids: [OC_ID] });
  expect(unitThenLint.gates.lint.status).toBe("RED");
  const unitThenUnparsed = await producedGatesOrdered157({ order: ["lint", "unit", "integration"], unit: [OC_ID], integration: "unparsed" });
  expect(unitThenUnparsed.gates.integration).toMatchObject({ status: "RED", parsed: false });
  expect(unitThenUnparsed.status).toBe("RED");
  // Control: the same ordered fixtures with the later gate GREEN are re-run — the order alone is not a refusal.
  for (const ctl of [
    await producedGatesOrdered157({ order: ["unit", "lint"], unit: [OC_ID] }),
    await producedGatesOrdered157({ order: ["lint", "unit", "integration"], unit: [OC_ID] }),
  ]) {
    expect(ctl.status).toBe("RED");
    expect((await run157({ seq: [ctl, green], diff: { ok: true, files: CLIENT_ONLY } })).d.gates).toHaveBeenCalledTimes(2);
  }
  for (const [name, first, why] of [["lint RED after an eligible unit RED", unitThenLint, /lint is RED without a parsed test report/], ["integration RED unparsed after an eligible unit RED", unitThenUnparsed, /integration is RED without a parsed test report/]]) {
    const r = await run157({ seq: [first, green], diff: { ok: true, files: CLIENT_ONLY } });
    const today = await run157({ seq: [first, green] });
    expect(r.code, name).toBe(2);
    expect(r.d.gates, name).toHaveBeenCalledTimes(1);
    expect(r.d.mergePr, name).not.toHaveBeenCalled();
    expect(transitionsOf(r.d), name).toEqual([expect.objectContaining({ to: "factory:needs-human", reason: "gates RED at merge" })]);
    expect(withoutRefusal(r.lines), name).toEqual(withoutRefusal(today.lines));
    expectRefusedRecord157(r.lines, first, name, why);
    expect(flakyMarksOf(r.lines), name).toEqual([]);
  }

  // The refusal reason goes to a public place (the run record), so it goes through the gates-detail projection's scrub
  // (`gatesDetailLines` — one rule, not a copy). A credential inside an error message (here: a git error echoing a
  // remote URL) is redacted when it is in the process env, and passes through unchanged when it is not (both env paths pinned).
  const SECRET = "fake-secret-value-for-test-157-refusal";
  const leaky = { ok: false, files: [], reason: `git diff failed: fatal: https://x-access-token:${SECRET}@github.com/o/r: bad revision` };
  vi.stubEnv("GITHUB_TOKEN", SECRET);
  try {
    const r = await run157({ seq: [red, green], diff: leaky });
    const [line] = refusalLinesOf(r.lines);
    expect(line).toMatch(/^merge: no gates rerun — PR diff unreadable or empty: git diff failed/);
    expect(line).not.toContain(SECRET);
    expect(line).toContain("[REDACTED");
    expect(line).toContain(gatesDetailReason157(`PR diff unreadable or empty: ${leaky.reason}`));
  } finally {
    vi.unstubAllEnvs();
  }
  vi.stubEnv("GITHUB_TOKEN", "");
  try {
    const plain = { ok: false, files: [], reason: "git diff failed: fatal: bad revision 'c0ffee'" };
    const r = await run157({ seq: [red, green], diff: plain });
    expect(refusalLinesOf(r.lines)).toEqual([`${NO_RERUN_157}PR diff unreadable or empty: ${plain.reason} ${STAMP_TAG_157}`]);
  } finally {
    vi.unstubAllEnvs();
  }

  // The outcomes are today's: needs-human for RED / MISCONFIGURED, blocked for BLOCKED.
  expect(transitionsOf((await run157({ seq: [misconfigured], diff: { ok: true, files: CLIENT_ONLY } })).d)).toEqual([expect.objectContaining({ to: "factory:needs-human", reason: "gates MISCONFIGURED at merge" })]);
  expect(transitionsOf((await run157({ seq: [blockedGates], diff: { ok: true, files: CLIENT_ONLY } })).d)).toEqual([expect.objectContaining({ to: "factory:blocked" })]);
});

/**
 * A vitest `--reporter=json` report with failing assertions `failingIds` PLUS test files that failed as a whole
 * (`loadErrors`: a file that did not load, or a suite-level hook that threw). Vitest writes those as a
 * `testResults` entry with `status:"failed"`, a `message`, and NO failed assertion — counted in
 * `numFailedTestSuites`, never in `numFailedTests`. Shape taken from vitest's JSON reporter (`JsonTestResult`).
 */
function vitestReportWithSuiteErrors157(failingIds, loadErrors, total = 132) {
  const base = JSON.parse(vitestReport157(failingIds, total));
  for (const [file, message] of loadErrors) {
    base.testResults.push({ name: `${GATE_ROOT}/${file}`, status: "failed", message, assertionResults: [] });
  }
  base.numFailedTestSuites = new Set([...failingIds.map((id) => id.split("::")[0]), ...loadErrors.map(([f]) => f)]).size;
  return JSON.stringify(base);
}
async function producedGatesWithSuiteErrors157({ failing, loadErrors }) {
  const harness = HARNESS_157();
  const fake = makeFakeRun([
    { match: (_c, a) => a[1] === harness.commands.lint, result: { code: 0, stdout: "", stderr: "" } },
    { match: (_c, a) => a[1] === harness.commands.unit, result: { code: 1, stdout: "JSON report written to .factory/out/unit.json", stderr: "" } },
  ]);
  const text = vitestReportWithSuiteErrors157(failing, loadErrors);
  const g = await runGates({ run: fake, cwd: GATE_ROOT, harness, level: "fast", quarantine: { quarantined: [] }, readFile: () => text, now: "2026-10-02T01:52:00.000Z" });
  return registerReports157({ ...g, head_sha: "a".repeat(40) }, { unit: text });
}

test("test_157_suite_that_failed_without_a_failing_assertion_is_no_rerun", async () => {
  // Skeptic finding (dw4): `failing_ids` lists failed ASSERTIONS only. A test file that failed to load has none,
  // so a RED that is partly inside the diff (the client file the PR broke) looked "all outside" and was re-run.
  const green = await producedGates({ failing: [] });
  const LOAD_ERR = ["client/tests/Calendar.test.ts", "SyntaxError: Unexpected token (client/src/pages/Calendar.tsx:41:7)"];
  const DIFF = { ok: true, files: ["client/src/pages/Calendar.tsx"] };
  // Control: the server assertion RED alone, same diff, IS re-run — so the refusal below is about the load error.
  const alone = await producedGates({ failing: [OC_ID] });
  expect((await run157({ seq: [alone, green], diff: DIFF })).d.gates).toHaveBeenCalledTimes(2);

  const cases = [
    { name: "a client suite load error inside the diff's package beside an outside server RED", failing: [OC_ID], loadErrors: [LOAD_ERR] },
    // Even outside the diff's packages: a failure with no test id is not a parsed test failure, so nothing proves it a flake.
    { name: "a suite load error outside the diff beside an outside server RED", failing: [OC_ID], loadErrors: [["shared/tests/date.test.ts", "Error: Cannot find module './tz'"]] },
    { name: "a suite-level hook error in the failing test's own file", failing: [OC_ID], loadErrors: [["server/tests/feed.test.ts", "Error: afterAll hook timed out"]] },
  ];
  for (const c of cases) {
    const first = await producedGatesWithSuiteErrors157(c);
    // The producer is real: the unit gate is RED, parsed, and its assertion ids are only the server test.
    expect(first.status, c.name).toBe("RED");
    expect(first.gates.unit, c.name).toMatchObject({ status: "RED", parsed: true, failing_ids: [OC_ID] });
    // factory.gates.v1 is unchanged (plan non-goal): the entry carries no suite field — the merge stage reads the report.
    expect(Object.keys(first.gates.unit).sort(), c.name).toEqual(Object.keys(alone.gates.unit).sort());
    expect(idlessFailedSuites({ gates: first, root: GATE_ROOT, readReport: (n) => reportOnDisk157(first, n) }), c.name).toEqual({ ok: true, files: c.loadErrors.map(([f]) => f) });
    const r = await run157({ seq: [first, green], diff: DIFF });
    const today = await run157({ seq: [first, green] });
    expect(r.code, c.name).toBe(2);
    expect(r.d.gates, c.name).toHaveBeenCalledTimes(1);
    expect(r.d.mergePr, c.name).not.toHaveBeenCalled();
    expect(transitionsOf(r.d), c.name).toEqual([expect.objectContaining({ to: "factory:needs-human", reason: "gates RED at merge" })]);
    expect(withoutRefusal(r.lines), c.name).toEqual(withoutRefusal(today.lines));
    expectRefusedRecord157(r.lines, first, c.name, new RegExp(`test files failed without a failing test: .*${c.loadErrors[0][0].replace(/[.]/g, "\\.")}`));
    expect(flakyMarksOf(r.lines), c.name).toEqual([]);
    expect(gateStatusesOf(r.postStatus).map((s) => s.state), c.name).toEqual(["failure"]);
  }

  // When the report cannot vouch that no suite failed id-less, that is not proof either: the reader is not wired,
  // throws, or answers ok:false; the report is missing or unparseable; or the report on disk is not the one this gate
  // read (its failing assertions differ from `failing_ids` — another run overwrote it).
  const stale = vitestReport157([OC_ID, "server/tests/auth.test.ts::test_12_login"]);
  const unproven = [
    { name: "suiteFailures dep absent", over: { suiteFailures: undefined } },
    { name: "suiteFailures throws", over: { suiteFailures: vi.fn(async () => { throw new Error("EACCES .factory/out/unit.json"); }) } },
    { name: "suiteFailures ok:false", over: { suiteFailures: vi.fn(async () => ({ ok: false, files: [], reason: "x" })) } },
    { name: "suiteFailures returns nothing", over: { suiteFailures: vi.fn(async () => undefined) } },
    { name: "report missing", over: { suiteFailures: vi.fn(async (g) => idlessFailedSuites({ gates: g, root: GATE_ROOT, readReport: () => null })) } },
    { name: "report unparseable", over: { suiteFailures: vi.fn(async (g) => idlessFailedSuites({ gates: g, root: GATE_ROOT, readReport: () => "{not json" })) } },
    { name: "report on disk names other failures", over: { suiteFailures: vi.fn(async (g) => idlessFailedSuites({ gates: g, root: GATE_ROOT, readReport: () => stale })) } },
  ];
  for (const c of unproven) {
    const r = await run157({ seq: [alone, green], diff: DIFF, over: c.over });
    expect(r.code, c.name).toBe(2);
    expect(r.d.gates, c.name).toHaveBeenCalledTimes(1);
    expect(r.d.mergePr, c.name).not.toHaveBeenCalled();
    expect(transitionsOf(r.d), c.name).toEqual([expect.objectContaining({ to: "factory:needs-human", reason: "gates RED at merge" })]);
    expectRefusedRecord157(r.lines, alone, c.name, /suite-level failures not vouched for/);
  }

  // The re-run: the same assertion id fails again but a suite now fails to load too — not the same RED, so no
  // flaky-candidate wording or marker (the id set alone would call it "the same set").
  const againWithLoad = await producedGatesWithSuiteErrors157({ failing: [OC_ID], loadErrors: [LOAD_ERR] });
  expect(againWithLoad.gates.unit.failing_ids).toEqual([OC_ID]);
  const sameIdsPlusLoad = await run157({ seq: [alone, againWithLoad], diff: DIFF });
  expect(sameIdsPlusLoad.code).toBe(2);
  expect(sameIdsPlusLoad.d.gates).toHaveBeenCalledTimes(2);
  expect(sameIdsPlusLoad.d.mergePr).not.toHaveBeenCalled();
  const t = transitionsOf(sameIdsPlusLoad.d);
  expect(t).toEqual([expect.objectContaining({ to: "factory:needs-human" })]);
  expect(t[0].reason).not.toContain(FLAKY_TEXT_157);
  expect(flakyMarksOf(sameIdsPlusLoad.lines)).toEqual([]);
  // Control: the same re-run without the load error IS the flaky-candidate case.
  const sameIds = await run157({ seq: [alone, await producedGates({ failing: [OC_ID] })], diff: DIFF });
  expect(transitionsOf(sameIds.d)[0].reason).toContain(FLAKY_TEXT_157);
});

import { flakyCandidateLines, FLAKY_CANDIDATE_PREFIX, TEST_ROOT_DIRS } from "../lib/merge-stage.js";
import { DETAIL_MAX_NAME, GATES_DETAIL_PREFIX } from "../lib/gates.js";

test("test_157_flaky_candidate_names_follow_the_gates_detail_scrub_rule", () => {
  // Review arch1: the marker's test name is not scrubbed by a copy of the rule — it IS the `failing` name the
  // gates-detail projection (`gatesDetailLines`) writes, so the two lines sitting next to each other in one run
  // record carry byte-identical names whatever the rule becomes. Both env paths are pinned: with the secret in the
  // process env (redacted in both) and without it (passed through in both).
  const SECRET = "fake-secret-value-for-test-157";
  const ID = `server/tests/login.test.ts::login[${SECRET}]`;
  const LONG = `server/tests/long.test.ts::${"n".repeat(DETAIL_MAX_NAME * 2)}`;
  const markerTests = (lines) => lines.map((l) => { expect(l.startsWith(FLAKY_CANDIDATE_PREFIX)).toBe(true); return JSON.parse(l.slice(FLAKY_CANDIDATE_PREFIX.length)).test; });
  const detailNames = (ids) => {
    const result = { gates: { unit: { status: "RED", parsed: true, failing_ids: ids, detail: { gate: "unit", failing: ids, snippet: "" } } } };
    return JSON.parse(gatesDetailLines(result, { runId: "1", runnerId: "r" })[0].slice(GATES_DETAIL_PREFIX.length)).failing;
  };

  vi.stubEnv("GITHUB_TOKEN", SECRET);
  try {
    const [scrubbed, capped] = markerTests(flakyCandidateLines([ID, LONG], "RED", { runId: "1", runnerId: "r" }));
    expect(scrubbed).not.toContain(SECRET);
    expect(scrubbed).toContain("[REDACTED");
    expect(scrubbed.startsWith("server/tests/login.test.ts::login[")).toBe(true);
    expect(capped).toBe(LONG.slice(0, DETAIL_MAX_NAME));
    expect([scrubbed, capped]).toEqual(detailNames([ID, LONG]));
  } finally {
    vi.unstubAllEnvs();
  }

  vi.stubEnv("GITHUB_TOKEN", "");
  try {
    const names = markerTests(flakyCandidateLines([ID, LONG], "GREEN", { runId: "1", runnerId: "r" }));
    expect(names).toEqual([ID, LONG.slice(0, DETAIL_MAX_NAME)]);
    expect(names).toEqual(detailNames([ID, LONG]));
  } finally {
    vi.unstubAllEnvs();
  }
});

test("test_157_unhandled_error_on_the_rerun_never_merges", async () => {
  // Residual risk (ADR-034): vitest's JSON report has no trace of an unhandled error (vitest 3.2.7: exit 1, report
  // `success:true`, nothing on stderr), so a first RED with an outside assertion PLUS an unhandled error looks
  // eligible. The bound that still holds: the re-run must be WHOLE GREEN. An unhandled error that fires again on the
  // re-run is a RED with zero failing assertions (KTB-35) — never a merge, never a flaky-candidate marker.
  const first = await producedGates({ failing: [OC_ID] });
  const unhandledAgain = await producedGates({ failing: [], unitExit: 1 });
  expect(unhandledAgain.gates.unit).toMatchObject({ status: "RED", parsed: true, failing_ids: [] });
  expect(unhandledAgain.gates.unit.reason).toMatch(/unhandled error outside tests/);
  const r = await run157({ seq: [first, unhandledAgain], diff: { ok: true, files: CLIENT_ONLY } });
  expect(r.code).toBe(2);
  expect(r.d.gates).toHaveBeenCalledTimes(2);
  expect(r.d.mergePr).not.toHaveBeenCalled();
  expect(r.d.mergeGates).not.toHaveBeenCalled();
  const t = transitionsOf(r.d);
  expect(t).toEqual([expect.objectContaining({ to: "factory:needs-human" })]);
  expect(t[0].reason).not.toContain("flaky");
  expect(t[0].reason).toContain(OC_ID);
  expect(flakyMarksOf(r.lines)).toEqual([]);
  expect(gateStatusesOf(r.postStatus).map((s) => s.state)).toEqual(["failure", "failure"]);
  // The unhandled re-run's own evidence (KTB-35 reason) reaches the run record.
  expect(detailsOf(r.lines).some((dl) => /unhandled error outside tests/.test(dl.reason ?? ""))).toBe(true);

  // #184 dw5 — the throw paths themselves. A GREEN is queued after each throw, so an implementation that swallowed the
  // throw and carried on would reach mergePr; none may. Each outcome is visible: the stage rejects with the cause (run-stage
  // turns that into exit 1 + `error: merge aborted — <cause>`, pinned in run-stage.test.js), or needs-human with the cause.
  const green = await producedGates({ failing: [] });
  // (a) the re-run's gate call throws an untyped error.
  const viaGate = vi.fn(async () => {});
  await expect(run157({ seq: [first, () => { throw new Error("vitest worker crashed: SIGKILL"); }, green], diff: { ok: true, files: CLIENT_ONLY }, over: { mergePr: viaGate } }))
    .rejects.toThrow("vitest worker crashed: SIGKILL");
  expect(viaGate).not.toHaveBeenCalled();
  // (b) d.resetGates() throws: the re-run never starts, nothing merges.
  const viaReset = vi.fn(async () => {});
  const gatesSeen = [];
  await expect(run157({ seq: [first, green], diff: { ok: true, files: CLIENT_ONLY }, over: { mergePr: viaReset, resetGates: vi.fn(async () => { gatesSeen.push("reset"); throw new Error("EACCES: unlink .factory/out/unit.json"); }) } }))
    .rejects.toThrow("EACCES: unlink .factory/out/unit.json");
  expect(gatesSeen).toEqual(["reset"]);
  expect(viaReset).not.toHaveBeenCalled();
  // (c) the changed-files lookup throws: "outside the diff" is unproven — one gate run, needs-human, the cause on the record.
  const viaDiff = await run157({ seq: [first, green], diff: async () => { throw new Error("git diff exploded: exit 128"); } });
  expect(viaDiff.code).toBe(2);
  expect(viaDiff.d.gates).toHaveBeenCalledTimes(1);
  expect(viaDiff.d.resetGates).not.toHaveBeenCalled();
  expect(viaDiff.d.mergePr).not.toHaveBeenCalled();
  expect(transitionsOf(viaDiff.d)).toEqual([expect.objectContaining({ to: "factory:needs-human", reason: "gates RED at merge" })]);
  expect(refusalLinesOf(viaDiff.lines)).toEqual([expect.stringContaining("git diff exploded: exit 128")]);
});

// #184 dw4/cf1 — resetGates is not optional for the re-run. Without it the re-run could read the first run's report and
// call a test that never ran again a flaky candidate; so an unwired resetGates refuses the re-run (today's single-run
// needs-human plus one stamped refusal line), exactly like an unwired diffFiles/suiteFailures.
test("test_184_unwired_reset_gates_refuses_the_rerun", async () => {
  const first = await producedGates({ failing: [OC_ID], sha: HEAD });
  const green = await producedGates({ failing: [], sha: HEAD });
  const r = await run157({ seq: [first, green], diff: { ok: true, files: CLIENT_ONLY }, over: { resetGates: undefined } });
  expect(r.code).toBe(2);
  expect(r.d.gates).toHaveBeenCalledTimes(1);
  expect(r.d.mergePr).not.toHaveBeenCalled();
  expect(transitionsOf(r.d)).toEqual([expect.objectContaining({ to: "factory:needs-human", reason: "gates RED at merge" })]);
  expectRefusedRecord157(r.lines, first, "resetGates unwired", /resetGates dep not wired/);
  expect(gateStatusesOf(r.postStatus).map((s) => s.state)).toEqual(["failure"]);
});

// ── #184 — the #157 re-land's own pins (plan dw6, and the dw2/dw4/dw5 rubric points the #161 tests above leave implicit) ──

// dw6 (plan d1/d2/d3): a merge that happened only because the re-run was GREEN must be findable later. The run record's
// `merge: merged …` line — the one line written only after mergePr returned — names the test that failed and then passed
// and marks the merge as merged on re-run. A merge with no re-run, or a GREEN re-run that did not end in a merge, carries no
// such mark: the mark is a statement about the merge, not about the re-run.
const MERGED_ON_RERUN_184 = "merged on rerun";
test("test_184_green_rerun_merge_record_names_the_retried_test", async () => {
  const first = await producedGates({ failing: [OC_ID], sha: HEAD });
  const second = await producedGates({ failing: [], sha: HEAD });

  const resetGates = vi.fn(async () => {});
  const r = await run157({ seq: [first, second], diff: { ok: true, files: CLIENT_ONLY }, over: { resetGates } });
  expect(r.code).toBe(0);
  expect(r.d.gates).toHaveBeenCalledTimes(2);
  // dw1 on the merging path: the stale first-run report is cleared between the two gate runs, and the last
  // factory/gates status on the merged head is the re-run's success.
  expect(resetGates).toHaveBeenCalledTimes(1);
  expect(resetGates.mock.invocationCallOrder[0]).toBeGreaterThan(r.d.gates.mock.invocationCallOrder[0]);
  expect(resetGates.mock.invocationCallOrder[0]).toBeLessThan(r.d.gates.mock.invocationCallOrder[1]);
  expect(gateStatusesOf(r.postStatus).at(-1)).toMatchObject({ state: "success", sha: HEAD });
  expect(r.d.mergePr).toHaveBeenCalledWith(9);
  const marked = r.lines.filter((l) => l.includes(MERGED_ON_RERUN_184));
  expect(marked).toHaveLength(1);
  expect(marked[0].startsWith(`merge: merged ${HEAD.slice(0, 7)} via PR #9`)).toBe(true);
  expect(marked[0]).toContain(OC_ID);
  // Written after the merge happened, not when the re-run came back GREEN.
  const markedCall = r.record.mock.calls.findIndex((c) => c[0].includes(marked[0]));
  expect(r.record.mock.invocationCallOrder[markedCall]).toBeGreaterThan(r.d.mergePr.mock.invocationCallOrder[0]);

  // Two retried ids: both are named on the one line.
  const two = [OC_ID, "server/tests/follows.test.ts::test_50_follow_feed"];
  const r2 = await run157({ seq: [await producedGates({ failing: two, sha: HEAD }), second], diff: { ok: true, files: CLIENT_ONLY } });
  expect(r2.code).toBe(0);
  const marked2 = r2.lines.filter((l) => l.includes(MERGED_ON_RERUN_184));
  expect(marked2).toHaveLength(1);
  for (const id of two) expect(marked2[0]).toContain(id);

  // Control: a first-run GREEN merge has no re-run and no mark — the mark is not on every merge line.
  const plain = await run157({ seq: [second], diff: { ok: true, files: CLIENT_ONLY } });
  expect(plain.code).toBe(0);
  expect(plain.d.gates).toHaveBeenCalledTimes(1);
  expect(plain.lines.some((l) => l.startsWith(`merge: merged ${HEAD.slice(0, 7)} via PR #9`))).toBe(true);
  expect(plain.lines.some((l) => l.includes(MERGED_ON_RERUN_184))).toBe(false);

  // Control: a GREEN re-run whose merge call then fails did not merge — no mark.
  const failed = await run157({ seq: [first, second], diff: { ok: true, files: CLIENT_ONLY }, over: { mergePr: vi.fn(async () => { throw new Error("405 not mergeable"); }) } });
  expect(failed.code).toBe(2);
  expect(failed.lines.some((l) => l.includes(MERGED_ON_RERUN_184))).toBe(false);
});

// dw4 rubric: the issue fixes the inconclusive reason verbatim — pin the exact phrase, not two halves of it.
test("test_184_inconclusive_rerun_reason_carries_the_issue_phrase_verbatim", async () => {
  const first = await producedGatesOrdered157({ order: ["integration"], integration: [OC_ID] });
  const unreported = await producedGatesOrdered157({ order: ["integration"], integration: "unparsed" });
  const resetGates = vi.fn(async () => {});
  const r = await run157({ seq: [first, unreported], diff: { ok: true, files: CLIENT_ONLY }, over: { resetGates } });
  expect(r.code).toBe(2);
  expect(resetGates).toHaveBeenCalledTimes(1);
  expect(resetGates.mock.invocationCallOrder[0]).toBeLessThan(r.d.gates.mock.invocationCallOrder[1]);
  const t = transitionsOf(r.d);
  expect(t).toEqual([expect.objectContaining({ to: "factory:needs-human" })]);
  expect(t[0].reason).toContain("rerun inconclusive — the re-run wrote no test report");
  expect(t[0].reason).not.toContain(FLAKY_TEXT_157);
  expect(flakyMarksOf(r.lines)).toEqual([]);
  expect(r.d.mergePr).not.toHaveBeenCalled();
});

// dw2 rubric (plan d4): the flaky-candidate marker is reason/record text only. Merge asks no dep for a factory:flaky label,
// issue, quarantine entry or flaky verdict — every dep call the stage makes on a second RED is checked for that surface.
test("test_184_second_red_creates_nothing_on_the_factory_flaky_surface", async () => {
  const first = await producedGates({ failing: [OC_ID] });
  const again = await producedGates({ failing: [OC_ID] });
  const saveQuarantine = vi.fn(async () => {});
  const createIssue = vi.fn(async () => 1);
  const addLabel = vi.fn(async () => {});
  const r = await run157({ seq: [first, again], diff: { ok: true, files: CLIENT_ONLY }, over: { saveQuarantine, createIssue, addLabel } });
  expect(r.code).toBe(2);
  const t = transitionsOf(r.d);
  expect(t).toEqual([expect.objectContaining({ to: "factory:needs-human" })]);
  expect(t[0].reason).toContain(FLAKY_TEXT_157);
  expect(t[0].reason).toContain(OC_ID);
  expect(flakyMarksOf(r.lines)).toEqual([expect.objectContaining({ test: OC_ID, outcome: "RED" })]);
  expect(saveQuarantine).not.toHaveBeenCalled();
  expect(createIssue).not.toHaveBeenCalled();
  expect(addLabel).not.toHaveBeenCalled();
  // Nothing any dep was handed names the factory:flaky label or a flaky-existing verdict.
  for (const [name, fn] of Object.entries(r.d)) {
    if (!vi.isMockFunction(fn)) continue;
    for (const call of fn.mock.calls) expect(JSON.stringify(call ?? null), name).not.toMatch(/factory:flaky|flaky-existing/);
  }
  expect(r.lines.some((l) => /factory:flaky|flaky-existing/.test(l))).toBe(false);
});

// dw5 (plan d5): ANY throw between the first RED and mergePr never merges — the re-run's gate call, resetGates, the changed-files
// lookup and the suite-failure reader — and the outcome is visible (the stage rejects with the cause, or needs-human with it).
test("test_184_any_throw_between_first_red_and_merge_never_merges", async () => {
  const first = await producedGates({ failing: [OC_ID], sha: HEAD });
  const green = await producedGates({ failing: [], sha: HEAD });

  // resetGates throws: the re-run never starts, nothing merges, the stage fails loudly with the cause.
  const mergePr1 = vi.fn(async () => {});
  await expect(run157({ seq: [first, green], diff: { ok: true, files: CLIENT_ONLY }, over: { mergePr: mergePr1, resetGates: vi.fn(async () => { throw new Error("EACCES: reset .factory/out/unit.json"); }) } }))
    .rejects.toThrow(/EACCES: reset/);
  expect(mergePr1).not.toHaveBeenCalled();

  // The re-run's gate call throws a plain (untyped) error: no merge, the cause propagates.
  const mergePr2 = vi.fn(async () => {});
  await expect(run157({ seq: [first, () => { throw new Error("vitest crashed: SIGKILL"); }], diff: { ok: true, files: CLIENT_ONLY }, over: { mergePr: mergePr2 } }))
    .rejects.toThrow(/SIGKILL/);
  expect(mergePr2).not.toHaveBeenCalled();

  // The changed-files lookup throws: "outside the diff" is not proven — no re-run, today's needs-human, the cause on the record.
  const viaDiff = await run157({ seq: [first, green], diff: async () => { throw new Error("git diff exploded"); } });
  expect(viaDiff.code).toBe(2);
  expect(viaDiff.d.gates).toHaveBeenCalledTimes(1);
  expect(viaDiff.d.mergePr).not.toHaveBeenCalled();
  expect(transitionsOf(viaDiff.d)).toEqual([expect.objectContaining({ to: "factory:needs-human", reason: "gates RED at merge" })]);
  expect(refusalLinesOf(viaDiff.lines)).toEqual([expect.stringContaining("git diff exploded")]);

  // The suite-failure reader throws: not vouched for — same outcome.
  const viaSuites = await run157({ seq: [first, green], diff: { ok: true, files: CLIENT_ONLY }, over: { suiteFailures: vi.fn(async () => { throw new Error("report read failed"); }) } });
  expect(viaSuites.code).toBe(2);
  expect(viaSuites.d.gates).toHaveBeenCalledTimes(1);
  expect(viaSuites.d.mergePr).not.toHaveBeenCalled();
  expect(transitionsOf(viaSuites.d)).toEqual([expect.objectContaining({ to: "factory:needs-human", reason: "gates RED at merge" })]);
  expect(refusalLinesOf(viaSuites.lines)).toEqual([expect.stringContaining("report read failed")]);
});

// ── #179 (S4a-2, ADR-033) — 자기 변경 경로: 스위치 · 거부권 창 · 판정 경로 만장일치 ─────────────────────────────
// 보호 경로 PR은 오늘 전부 사람이 머지한다. CHARTER `self_change` 스위치가 켜지고(기본 off) 이 체크아웃이 엔진이면,
// 비판정 경로 PR(그리고 자기 스위치 + 만장일치 load-bearing 리뷰가 있는 판정 경로 PR)은 잡 안의 거부권 창을 지난 뒤
// 팩토리가 머지한다. 스위치가 꺼져 있으면 출력은 오늘과 바이트 단위로 같아야 한다.
import { VETO_WINDOW_CONTEXT } from "../lib/merge-stage.js";
import { loadCharter as loadCharter179 } from "../lib/config.js";
import { classifyProtected as classifyProtected179 } from "../lib/non-judge-paths.js";
import { fileURLToPath as fileURLToPath179 } from "node:url";

/**
 * dw1의 기대값 — **base 커밋(3e21223)의 `runMergeStage`가 실제로 낸 출력을 그대로 옮긴 것**이다. 새 헬퍼로 다시 만들지
 * 않는다: 이 문자열이 바뀌면 그것은 스위치가 꺼진 소유자에게 보이는 변화다.
 */
const BASE_FIXTURES_179 = {
  judge: {
    files: [".factory/harness.toml", "factory/lib/merge-stage.js"],
    reason: "protected paths changed — human merge required: .factory/harness.toml, factory/lib/merge-stage.js (see PR #9)",
    comment: "**보호 경로 변경 — 팩토리가 자동 머지하지 않습니다.**\n\n이 PR은 `[protected].factory` 경로를 바꿉니다. 게이트 정의·워크플로·CHARTER의 변경은\n사람의 판단이 곧 판결이라, 팩토리가 스스로 머지하지 않고 사람에게 넘깁니다(ADR-020).\n\n변경된 보호 경로:\n\n- `.factory/harness.toml`\n- `factory/lib/merge-stage.js`\n\ndiff를 확인한 뒤 사람이 직접 머지해 주세요 — `factory/integrity` 체크는 변조만 보므로 GREEN일 수 있습니다.\n추적 이슈 #7는 `factory:needs-human`으로 옮겼습니다.",
    lines: [
      "merge: PR #9 is OPEN",
      "merge: PR #9 not conflicting (MERGEABLE)",
      "merge: protected paths changed — human merge required: .factory/harness.toml, factory/lib/merge-stage.js",
    ],
  },
  non_judge: {
    files: ["factory/lib/status.js", "docs/factory/ops/runbook.md"],
    reason: "protected paths changed — human merge required: factory/lib/status.js, docs/factory/ops/runbook.md (see PR #9)",
    comment: "**보호 경로 변경 — 팩토리가 자동 머지하지 않습니다.**\n\n이 PR은 `[protected].factory` 경로를 바꿉니다. 게이트 정의·워크플로·CHARTER의 변경은\n사람의 판단이 곧 판결이라, 팩토리가 스스로 머지하지 않고 사람에게 넘깁니다(ADR-020).\n\n변경된 보호 경로:\n\n- `factory/lib/status.js`\n- `docs/factory/ops/runbook.md`\n\ndiff를 확인한 뒤 사람이 직접 머지해 주세요 — `factory/integrity` 체크는 변조만 보므로 GREEN일 수 있습니다.\n추적 이슈 #7는 `factory:needs-human`으로 옮겼습니다.",
    lines: [
      "merge: PR #9 is OPEN",
      "merge: PR #9 not conflicting (MERGEABLE)",
      "merge: protected paths changed — human merge required: factory/lib/status.js, docs/factory/ops/runbook.md",
    ],
  },
  both: {
    files: ["factory/lib/status.js", "factory/lib/gates.js"],
    reason: "protected paths changed — human merge required: factory/lib/status.js, factory/lib/gates.js (see PR #9)",
    comment: "**보호 경로 변경 — 팩토리가 자동 머지하지 않습니다.**\n\n이 PR은 `[protected].factory` 경로를 바꿉니다. 게이트 정의·워크플로·CHARTER의 변경은\n사람의 판단이 곧 판결이라, 팩토리가 스스로 머지하지 않고 사람에게 넘깁니다(ADR-020).\n\n변경된 보호 경로:\n\n- `factory/lib/status.js`\n- `factory/lib/gates.js`\n\ndiff를 확인한 뒤 사람이 직접 머지해 주세요 — `factory/integrity` 체크는 변조만 보므로 GREEN일 수 있습니다.\n추적 이슈 #7는 `factory:needs-human`으로 옮겼습니다.",
    lines: [
      "merge: PR #9 is OPEN",
      "merge: PR #9 not conflicting (MERGEABLE)",
      "merge: protected paths changed — human merge required: factory/lib/status.js, factory/lib/gates.js",
    ],
  },
};

const MIN_179 = 60 * 1000;
const JOB_START_179 = Date.parse("2026-10-03T10:00:00.000Z");
/** 주입한 시계: `sleep(ms)`가 시간을 그만큼 민다 — 실제로는 한 순간도 잠들지 않는다. */
const clock179 = (startMs = JOB_START_179 + 2 * MIN_179) => {
  let t = startMs;
  return { now: vi.fn(() => t), sleep: vi.fn(async (ms) => { t += ms; }) };
};
/**
 * 실제 생산자(run-stage)의 모양: GitHub이 그 커밋에 들고 있는 상태 목록(최신순)을 흉내낸다. open은 맨 앞에 하나를 올리고,
 * read는 그 context의 최신 항목을 돌려준다. `existing`은 이 런이 열기 전부터 붙어 있던 상태들이다.
 */
const vetoWindow179 = ({ creator = "ktb-bot", openResult = { ok: true }, existing = [] } = {}) => {
  const statuses = [...existing];
  return {
    statuses,
    open: vi.fn(async ({ sha, description }) => {
      if (openResult.ok) statuses.unshift({ context: VETO_WINDOW_CONTEXT, state: "pending", description, creatorLogin: creator, sha });
      return openResult;
    }),
    read: vi.fn(async () => ({ ok: true, status: statuses.find((x) => x.context === VETO_WINDOW_CONTEXT) ?? null })),
  };
};
const SELF_ON_179 = { auto_merge_non_judge: true, auto_merge_judge: false, veto_minutes: 60 };
/** 이 저장소의 실제 CHARTER가 내는 NEVER_AUTOMATE 글롭 — 실제 생산자(`loadCharter`)에서 읽는다. */
const NEVER_AUTOMATE_179 = loadCharter179(fileURLToPath179(new URL("../..", import.meta.url))).never_automate;
const selfD179 = (over = {}) => {
  const c = clock179();
  return baseD({
    protectedPaths: vi.fn(async () => ({ ok: true, files: BASE_FIXTURES_179.non_judge.files })),
    engine: true,
    selfChange: SELF_ON_179,
    neverAutomate: NEVER_AUTOMATE_179,
    now: c.now,
    sleep: c.sleep,
    jobStartedAt: JOB_START_179,
    jobTimeoutMinutes: 90,
    vetoWindow: vetoWindow179(),
    vetoLabel: vi.fn(async () => ({ ok: true, vetoes: [] })),
    ...over,
  });
};
const run179 = async (d, over = {}) => {
  const { lines, record } = makeRecord();
  const code = await runMergeStage({ issue: 7, defaultBranch: "main", headSha: HEAD, d, record, refusal, postStatus: basePostStatus(), retryFromBlocked: over.retryFromBlocked ?? false });
  return { code, lines };
};

test("test_179_switch_off_is_byte_identical", async () => {
  const off = { auto_merge_non_judge: false, auto_merge_judge: false, veto_minutes: 60 };
  const variants = [
    ["selfChange unwired", { engine: true }],
    ["both switches false", { engine: true, selfChange: off }],
    ["switches on, engine false", { engine: false, selfChange: { ...off, auto_merge_non_judge: true, auto_merge_judge: true } }],
    ["switches on, engine unwired", { selfChange: { ...off, auto_merge_non_judge: true, auto_merge_judge: true } }],
  ];
  for (const [kind, fx] of Object.entries(BASE_FIXTURES_179)) {
    for (const [label, wiring] of variants) {
      const c = clock179();
      const window = vetoWindow179();
      const vetoLabel = vi.fn(async () => ({ ok: true, vetoes: [] }));
      const d = baseD({ protectedPaths: vi.fn(async () => ({ ok: true, files: fx.files })), now: c.now, sleep: c.sleep, vetoWindow: window, vetoLabel, jobStartedAt: JOB_START_179, jobTimeoutMinutes: 90, ...wiring });
      const { code, lines } = await run179(d);
      const at = `${kind} / ${label}`;
      expect(code, at).toBe(2);
      expect(d.transition.mock.calls.map((x) => x[0]), at).toEqual([{ to: "factory:needs-human", reason: fx.reason }]);
      expect(d.comment.mock.calls, at).toEqual([[9, fx.comment]]);
      expect(lines, at).toEqual(fx.lines);
      for (const dep of [window.open, window.read, vetoLabel, c.sleep, c.now, d.gates, d.mergePr]) expect(dep, at).not.toHaveBeenCalled();
    }
  }
  // 판정 경로 PR은 비판정 스위치만 켜져 있으면 오늘 그대로다(판정 경로에는 자기 스위치가 있다).
  for (const kind of ["judge", "both"]) {
    const fx = BASE_FIXTURES_179[kind];
    const d = selfD179({ protectedPaths: vi.fn(async () => ({ ok: true, files: fx.files })) });
    const { lines } = await run179(d);
    expect(d.transition.mock.calls.map((x) => x[0]), kind).toEqual([{ to: "factory:needs-human", reason: fx.reason }]);
    expect(d.comment.mock.calls, kind).toEqual([[9, fx.comment]]);
    expect(lines, kind).toEqual(fx.lines);
    expect(d.vetoWindow.open, kind).not.toHaveBeenCalled();
  }
});

test("test_179_veto_window_opens_waits_and_closes", async () => {
  const d = selfD179();
  const { code, lines } = await run179(d);
  expect(code).toBe(0);
  const openedAt = JOB_START_179 + 2 * MIN_179;
  const closes = new Date(openedAt + 60 * MIN_179).toISOString();
  expect(closes).toBe("2026-10-03T11:02:00.000Z");

  // 상태 한 번, 코멘트 한 번 — 둘 다 첫 sleep보다 먼저.
  expect(d.vetoWindow.open).toHaveBeenCalledTimes(1);
  expect(d.vetoWindow.open).toHaveBeenCalledWith(expect.objectContaining({ sha: HEAD, description: `closes=${closes}` }));
  expect(d.comment).toHaveBeenCalledTimes(1);
  const [target, body] = d.comment.mock.calls[0];
  expect(target).toBe(9);
  expect(body).toContain("`factory:veto`");
  expect(body).toContain("#7");                                    // 라벨을 붙일 곳: 추적 이슈(vetoLabel이 읽는 곳)
  expect(body).toContain(closes);
  const firstSleep = d.sleep.mock.invocationCallOrder[0];
  expect(d.vetoWindow.open.mock.invocationCallOrder[0]).toBeLessThan(firstSleep);
  expect(d.comment.mock.invocationCallOrder[0]).toBeLessThan(firstSleep);

  // 5분 간격 폴링, 창이 닫힐 때까지(60분 = 12번 잠들고, 열 때와 매 깸마다 한 번씩 = 13번 읽는다).
  expect(d.sleep.mock.calls.map((x) => x[0])).toEqual(Array(12).fill(5 * MIN_179));
  expect(d.vetoLabel).toHaveBeenCalledTimes(13);
  expect(d.vetoLabel).toHaveBeenCalledWith({ since: new Date(openedAt).toISOString() });
  // 마지막 폴링은 창이 닫히는 순간 이후다 — 그 전에 머지하지 않는다.
  expect(d.mergePr).toHaveBeenCalledTimes(1);
  expect(d.mergePr.mock.invocationCallOrder[0]).toBeGreaterThan(d.vetoLabel.mock.invocationCallOrder.at(-1));
  expect(d.now()).toBeGreaterThanOrEqual(openedAt + 60 * MIN_179);
  expect(d.transition.mock.calls.map((x) => x[0].to)).toEqual(["factory:merged"]);
  expect(lines.some((l) => l.includes(`veto window opened — closes=${closes}`))).toBe(true);
  expect(lines.some((l) => /veto window closed/.test(l))).toBe(true);

  // 정책 hand-off는 언제나 새 경로를 이긴다 — 창은 열리지 않고, 오늘의 사유 그대로 needs-human.
  const policies = [
    [{ file: "factory/test/merge-stage.test.js", rule: "tests-modified — an existing test assertion changed" }, "existing tests modified or deleted — human merge required: factory/test/merge-stage.test.js (see PR #9)"],
    [{ file: ".claude/agents/x.md", rule: "additive-only sections (## Examples) — removals or edits outside allowed sections" }, "agent role sections edited outside Examples/Perspectives — human merge required: .claude/agents/x.md (see PR #9)"],
    [LESSONS_GONE, "lessons files deleted or moved away — human merge required: .factory/lessons/reviewer-qa.md (see PR #9)"],
    [{ file: ".factory/harness.toml", rule: "harness.toml [gates.thresholds] edited — human merge required" }, "harness.toml frozen sections edited — human merge required: [gates.thresholds] (see PR #9)"],
  ];
  for (const [v, reason] of policies) {
    const p = selfD179({ policyViolations: vi.fn(async () => ({ ok: true, files: [v.file], violations: [v] })) });
    expect(await run179(p).then((r) => r.code), reason).toBe(2);
    expect(p.transition.mock.calls.map((x) => x[0]), reason).toEqual([{ to: "factory:needs-human", reason }]);
    expect(p.vetoWindow.open, reason).not.toHaveBeenCalled();
    expect(p.vetoLabel, reason).not.toHaveBeenCalled();
    expect(p.sleep, reason).not.toHaveBeenCalled();
    expect(p.mergePr, reason).not.toHaveBeenCalled();
  }
});

test("test_179_veto_cannot_be_bypassed", async () => {
  const openedAt = JOB_START_179 + 2 * MIN_179;
  // (a) 창 안의 `labeled factory:veto` — 다음 폴링에서 라벨이 사라졌어도(dep은 창이 열린 뒤의 이벤트를 돌려준다) 거부권이다.
  let polls = 0;
  const a = selfD179({ vetoLabel: vi.fn(async () => (++polls === 3 ? { ok: true, vetoes: [{ login: "LeeHyeonKyu", at: new Date(openedAt + 7 * MIN_179).toISOString() }] } : { ok: true, vetoes: [] })) });
  const ra = await run179(a);
  expect(ra.code).toBe(2);
  const reasonA = a.transition.mock.calls.at(-1)[0];
  expect(reasonA.to).toBe("factory:needs-human");
  expect(reasonA.reason).toContain("vetoed by @LeeHyeonKyu — human merge required");
  expect(reasonA.reason).toMatch(HUMAN_MERGE_REQUIRED);
  expect(a.mergePr).not.toHaveBeenCalled();
  expect(a.vetoLabel).toHaveBeenCalledTimes(3);                       // 거부권을 본 순간 멈춘다
  // 그 이벤트가 다음 폴링에서 사라지는 모양: 한 번만 보인 거부권도 거부권이다.
  let seen = 0;
  const a2 = selfD179({ vetoLabel: vi.fn(async () => (++seen === 2 ? { ok: true, vetoes: [{ login: "ktb-bot", at: new Date(openedAt + 5 * MIN_179).toISOString() }] } : { ok: true, vetoes: [] })) });
  expect((await run179(a2)).code).toBe(2);
  expect(a2.transition.mock.calls.at(-1)[0].reason).toContain("vetoed by @ktb-bot — human merge required");
  expect(a2.mergePr).not.toHaveBeenCalled();
  // 행위자를 모르면 거부권은 그대로 서고, 사유가 그렇다고 말한다.
  const a3 = selfD179({ vetoLabel: vi.fn(async () => ({ ok: true, vetoes: [{ login: null, at: null }] })) });
  expect((await run179(a3)).code).toBe(2);
  const reasonA3 = a3.transition.mock.calls.at(-1)[0];
  expect(reasonA3.to).toBe("factory:needs-human");
  expect(reasonA3.reason).toMatch(HUMAN_MERGE_REQUIRED);
  expect(reasonA3.reason).toMatch(/vetoed by an unidentified account/);
  expect(a3.mergePr).not.toHaveBeenCalled();

  // (b) 이미 있는 `factory/veto-window` 상태(지난 closes=, 팩토리 계정이 올렸든 아니든)는 기다림을 줄이지 못한다.
  for (const creator of ["ktb-bot", "mallory"]) {
    const stale = { context: VETO_WINDOW_CONTEXT, state: "pending", description: "closes=2026-10-01T00:00:00.000Z", creatorLogin: creator };
    const window = vetoWindow179({ existing: [stale] });                   // 열기 전에 물으면 이것이 최신이다
    const b = selfD179({ vetoWindow: window, commitStatuses: vi.fn(async () => [
      { context: VETO_WINDOW_CONTEXT, state: "pending", description: stale.description, creatorLogin: creator },
      { context: "factory/review", state: "success", creatorLogin: "ktb-bot" },
      { context: "factory/gates", state: "success", creatorLogin: "ktb-bot" },
    ]) });
    const rb = await run179(b);
    // 위조 상태를 먼저 읽고 믿었다면 기다림 없이 머지했거나 blocked였을 것이다. 정답: 자기 창을 열고 끝까지 기다린 뒤 머지.
    expect(rb.code, creator).toBe(0);
    expect(b.vetoWindow.open, creator).toHaveBeenCalledTimes(1);
    expect(b.sleep.mock.calls.reduce((s, x) => s + x[0], 0), creator).toBe(60 * MIN_179);
    expect(b.mergePr, creator).toHaveBeenCalledTimes(1);
  }

  // (c) 기다린 뒤 라이브 head가 고정한 sha와 다르면, 또는 정족수가 그 head에 대해 더 이상 서지 않으면 mergePr는 없다.
  let headReads = 0;
  const c1 = selfD179({ prHeadShaLive: vi.fn(async () => (++headReads === 1 ? HEAD : "c".repeat(40))) });
  expect((await run179(c1)).code).toBe(2);
  expect(c1.sleep).toHaveBeenCalled();                                    // 창은 실제로 열렸다
  expect(c1.mergePr).not.toHaveBeenCalled();
  expect(c1.transition.mock.calls.at(-1)[0].reason).toMatch(/PR head moved/);
  let evReads = 0;
  const c2 = selfD179({ reviewEvidence: vi.fn(async () => (++evReads === 1
    ? { ok: true, data: REVIEW_OK }
    : { ok: true, data: { ...REVIEW_OK, verdicts: [approve("correctness"), { ...approve("qa"), verdict: "request_changes", must_fix: [{ id: "qa1", text: "x" }] }] } })) });
  expect((await run179(c2)).code).toBe(2);
  expect(c2.sleep).toHaveBeenCalled();
  expect(c2.mergePr).not.toHaveBeenCalled();
  expect(c2.transition.mock.calls.at(-1)[0].to).toBe("factory:needs-human");
});

test("test_179_window_deps_and_job_budget_fail_closed", async () => {
  const blockedOnly = (d, at) => {
    const ts = d.transition.mock.calls.map((x) => x[0]);
    expect(ts.at(-1).to, at).toBe("factory:blocked");
    expect(d.mergePr, at).not.toHaveBeenCalled();
    return ts.at(-1).reason;
  };
  const undecidableLine = (lines, at) => expect(lines.some((l) => /^merge: veto window could not be computed: /.test(l)), at).toBe(true);

  // 상태 게시 실패 — postStatus처럼 best-effort가 아니다.
  const w1 = vetoWindow179({ openResult: { ok: false, reason: "HTTP 403" } });
  const d1 = selfD179({ vetoWindow: w1 });
  const r1 = await run179(d1);
  expect(r1.code).toBe(2);
  expect(blockedOnly(d1, "open ok:false")).toMatch(/HTTP 403/);
  undecidableLine(r1.lines, "open ok:false");
  expect(d1.sleep).not.toHaveBeenCalled();
  const d1b = selfD179({ vetoWindow: { open: vi.fn(async () => { throw new Error("gh api exited 1"); }), read: vi.fn() } });
  const r1b = await run179(d1b);
  expect(blockedOnly(d1b, "open throws")).toMatch(/gh api exited 1/);
  undecidableLine(r1b.lines, "open throws");

  // 폴링 하나라도 실패하면(ok:false든 throw든) "거부권 없음"이 아니라 blocked.
  let n = 0;
  const d2 = selfD179({ vetoLabel: vi.fn(async () => (++n === 4 ? { ok: false, reason: "label events unreadable" } : { ok: true, vetoes: [] })) });
  const r2 = await run179(d2);
  expect(blockedOnly(d2, "poll ok:false")).toMatch(/label events unreadable/);
  undecidableLine(r2.lines, "poll ok:false");
  expect(d2.vetoLabel).toHaveBeenCalledTimes(4);
  const d2b = selfD179({ vetoLabel: vi.fn(async () => { throw new Error("socket hang up"); }) });
  const r2b = await run179(d2b);
  expect(blockedOnly(d2b, "poll throws")).toMatch(/socket hang up/);
  undecidableLine(r2b.lines, "poll throws");

  // 팩토리 계정을 모르면 상태 게시자를 대조할 수 없다 → blocked. 게시자가 팩토리 계정이 아니어도 blocked.
  const d3 = selfD179({ factoryLogins: vi.fn(async () => ({ ok: true, logins: ["ktb-bot"] })) });
  d3.factoryLogins.mockImplementationOnce(async () => ({ ok: true, logins: ["ktb-bot"] }));   // (6b)의 첫 조회는 통과
  d3.factoryLogins.mockImplementationOnce(async () => ({ ok: false, reason: "gh api user: 401" }));
  const r3 = await run179(d3);
  expect(blockedOnly(d3, "logins")).toMatch(/401/);
  undecidableLine(r3.lines, "logins");
  const d3b = selfD179({ vetoWindow: vetoWindow179({ creator: "mallory" }) });
  const r3b = await run179(d3b);
  expect(blockedOnly(d3b, "foreign poster")).toMatch(/@mallory/);
  undecidableLine(r3b.lines, "foreign poster");
  expect(d3b.sleep).not.toHaveBeenCalled();

  // 잡 시작 시각·잡 제한 시간을 모르면 blocked — 상태도 코멘트도 없다.
  for (const [label, over] of [["no FACTORY_JOB_STARTED", { jobStartedAt: null }], ["no job timeout", { jobTimeoutMinutes: null }], ["vetoWindow unwired", { vetoWindow: undefined }], ["vetoLabel unwired", { vetoLabel: undefined }], ["clock unwired", { now: undefined }]]) {
    const d = selfD179(over);
    const r = await run179(d);
    expect(r.code, label).toBe(2);
    blockedOnly(d, label);
    undecidableLine(r.lines, label);
    expect(d.comment, label).not.toHaveBeenCalled();
    if (d.vetoWindow) expect(d.vetoWindow.open, label).not.toHaveBeenCalled();
  }

  // 남은 잡 시간이 창보다 짧으면 창을 열지 않는다: 상태·코멘트 없음, 두 숫자를 다 대는 별도의 사유.
  const d5 = selfD179({ jobTimeoutMinutes: 30 });
  const r5 = await run179(d5);
  expect(r5.code).toBe(2);
  const why = blockedOnly(d5, "budget");
  expect(why).toMatch(/timeout-minutes: 30/);
  expect(why).toMatch(/veto_minutes: 60/);
  expect(d5.vetoWindow.open).not.toHaveBeenCalled();
  expect(d5.comment).not.toHaveBeenCalled();
  expect(d5.sleep).not.toHaveBeenCalled();
  expect(r5.lines.some((l) => /^merge: veto window not started — /.test(l))).toBe(true);
  expect(r5.lines.some((l) => /could not be computed/.test(l))).toBe(false);   // 판정 불가가 아니라 소유자가 고칠 숫자다
});

test("test_179_judge_path_unanimity_is_provenance_bound", async () => {
  const JUDGE = BASE_FIXTURES_179.judge;
  const LB_ROSTER = vi.fn(async () => ({ ok: true, roles: ["correctness", "qa"], tier: "load-bearing" }));
  const judgeD = (over = {}) => selfD179({
    protectedPaths: vi.fn(async () => ({ ok: true, files: JUDGE.files })),
    selfChange: { auto_merge_non_judge: false, auto_merge_judge: true, veto_minutes: 60 },
    reviewRoster: LB_ROSTER,
    ...over,
  });

  // auto_merge_judge:false → 오늘과 같다.
  const off = judgeD({ selfChange: { auto_merge_non_judge: true, auto_merge_judge: false, veto_minutes: 60 } });
  const roff = await run179(off);
  expect(off.transition.mock.calls.map((x) => x[0])).toEqual([{ to: "factory:needs-human", reason: JUDGE.reason }]);
  expect(off.comment.mock.calls).toEqual([[9, JUDGE.comment]]);
  expect(roff.lines).toEqual(JUDGE.lines);

  // true + 만장일치(load-bearing 로스터, 러너 기록에 묶임) + GREEN → 거부권 창을 지나 머지.
  const ok = judgeD();
  expect((await run179(ok)).code).toBe(0);
  expect(ok.vetoWindow.open).toHaveBeenCalledTimes(1);
  expect(ok.sleep.mock.calls.reduce((s, x) => s + x[0], 0)).toBe(60 * MIN_179);
  expect(ok.mergePr).toHaveBeenCalledTimes(1);
  expect(ok.mergePr.mock.invocationCallOrder[0]).toBeGreaterThan(ok.sleep.mock.invocationCallOrder.at(-1));

  // all-approve handoff인데 factory/records에 맞는 줄이 없다 → mergePr에 닿지 않는다(창도 열리지 않는다).
  const forged = judgeD({ reviewRecord: vi.fn(async () => ({ ok: false, reason: "factory/records carries no run record for issue #7" })) });
  expect((await run179(forged)).code).toBe(2);
  expect(forged.mergePr).not.toHaveBeenCalled();
  expect(forged.vetoWindow.open).not.toHaveBeenCalled();

  // 거부 하나 → needs-human, 사유에 역할과 판정, 표식이 있고, 창은 없다. 게이트도 돌지 않는다.
  const rejectQa = { ...approve("qa"), verdict: "request_changes", must_fix: [{ id: "qa1", text: "missing test" }] };
  const one = judgeD({ reviewEvidence: vi.fn(async () => ({ ok: true, data: { ...REVIEW_OK, decision: "approved", verdicts: [approve("correctness"), rejectQa] } })) });
  expect((await run179(one)).code).toBe(2);
  const r1 = one.transition.mock.calls.at(-1)[0];
  expect(r1.to).toBe("factory:needs-human");
  expect(r1.reason).toMatch(/^judge path needs a unanimous review — human merge required: /);
  expect(r1.reason).toContain("qa: request_changes");
  expect(r1.reason).toMatch(HUMAN_MERGE_REQUIRED);
  expect(one.vetoWindow.open).not.toHaveBeenCalled();
  expect(one.gates).not.toHaveBeenCalled();
  expect(one.mergePr).not.toHaveBeenCalled();

  // 판정 수가 로스터 크기와 다르다 → 같은 거부.
  const short = judgeD({ reviewRoster: vi.fn(async () => ({ ok: true, roles: ["correctness", "qa", "security"], tier: "load-bearing" })) });
  expect((await run179(short)).code).toBe(2);
  const r2 = short.transition.mock.calls.at(-1)[0];
  expect(r2.to).toBe("factory:needs-human");
  expect(r2.reason).toMatch(/^judge path needs a unanimous review — human merge required: /);
  expect(r2.reason).toMatch(/verdict count 2 != roster size 3/);
  expect(short.vetoWindow.open).not.toHaveBeenCalled();
  expect(short.mergePr).not.toHaveBeenCalled();

  // 로스터 tier가 load-bearing이 아니면 만장일치여도 판정 경로는 자동 머지하지 않는다.
  const std = judgeD({ reviewRoster: vi.fn(async () => ({ ok: true, roles: ["correctness", "qa"], tier: "standard" })) });
  expect((await run179(std)).code).toBe(2);
  const r3 = std.transition.mock.calls.at(-1)[0];
  expect(r3.to).toBe("factory:needs-human");
  expect(r3.reason).toMatch(HUMAN_MERGE_REQUIRED);
  expect(r3.reason).toMatch(/standard/);
  expect(std.vetoWindow.open).not.toHaveBeenCalled();
  expect(std.mergePr).not.toHaveBeenCalled();
});

// ── #179 self-critique — NEVER_AUTOMATE은 자기 변경 경로 안에서도 사람 머지다 ─────────────────────────────────────
// `templates/factory/docs/**`는 비판정 목록에 있지만 CHARTER NEVER_AUTOMATE의 `templates/factory/**`에도 걸린다. 스위치가 켜져도
// 그런 PR은 창을 열지 않고(게이트도 돌지 않고) 오늘의 보호 경로 hand-off 그대로 사람에게 간다. 글롭은 실제 CHARTER에서 읽는다.
test("test_179_never_automate_beats_self_change", async () => {
  const QA_DOC = "templates/factory/docs/QA.md";
  expect(NEVER_AUTOMATE_179).toContain("templates/factory/**");                 // 실제 CHARTER의 항목이다
  expect(classifyProtected179([QA_DOC], { engine: true })).toEqual({ non_judge: [QA_DOC], judge: [] });   // 구멍의 전제: 비판정이다

  const cases = [
    ["non-judge only", [QA_DOC], SELF_ON_179],
    ["non-judge + other non-judge", ["docs/factory/ops/runbook.md", QA_DOC], SELF_ON_179],
    ["judge path with both switches on", ["factory/lib/gates.js", QA_DOC], { auto_merge_non_judge: true, auto_merge_judge: true, veto_minutes: 60 }],
  ];
  for (const [label, files, selfChange] of cases) {
    const d = selfD179({ protectedPaths: vi.fn(async () => ({ ok: true, files })), selfChange, reviewRoster: vi.fn(async () => ({ ok: true, roles: ["correctness", "qa"], tier: "load-bearing" })) });
    const { code, lines } = await run179(d);
    const reason = `protected paths changed — human merge required: ${files.join(", ")}`;
    expect(code, label).toBe(2);
    expect(d.transition.mock.calls.map((x) => x[0]), label).toEqual([{ to: "factory:needs-human", reason: `${reason} (see PR #9)` }]);
    expect(d.comment, label).toHaveBeenCalledTimes(1);
    expect(d.comment.mock.calls[0][1], label).toContain(`- \`${QA_DOC}\``);
    expect(lines, label).toEqual([
      "merge: PR #9 is OPEN",
      "merge: PR #9 not conflicting (MERGEABLE)",
      `merge: self-change path refused — CHARTER NEVER_AUTOMATE matches ${QA_DOC} (templates/factory/**); a NEVER_AUTOMATE path is always human-merged`,
      `merge: ${reason}`,
    ]);
    for (const dep of [d.vetoWindow.open, d.vetoWindow.read, d.vetoLabel, d.sleep, d.gates, d.mergePr]) expect(dep, label).not.toHaveBeenCalled();
  }

  // NEVER_AUTOMATE 목록을 모르면(배선 안 됨) 자기 변경 경로는 판정 불가 — "걸린 것 없음"으로 읽지 않는다.
  for (const neverAutomate of [undefined, null, "templates/factory/**"]) {
    const d = selfD179({ neverAutomate });
    const { code, lines } = await run179(d);
    const at = JSON.stringify(neverAutomate);
    expect(code, at).toBe(2);
    expect(d.transition.mock.calls.at(-1)[0].to, at).toBe("factory:blocked");
    expect(d.transition.mock.calls.at(-1)[0].reason, at).toMatch(/NEVER_AUTOMATE check could not be computed/);
    expect(lines.some((l) => l.startsWith("merge: NEVER_AUTOMATE check could not be computed: ")), at).toBe(true);
    for (const dep of [d.vetoWindow.open, d.gates, d.mergePr]) expect(dep, at).not.toHaveBeenCalled();
  }
  // 스위치가 꺼져 있으면 그 dep은 묻지 않는다(오늘 그대로) — 배선이 없어도 오늘의 hand-off다.
  const off = selfD179({ neverAutomate: undefined, selfChange: { ...SELF_ON_179, auto_merge_non_judge: false } });
  await run179(off);
  expect(off.transition.mock.calls.map((x) => x[0])).toEqual([{ to: "factory:needs-human", reason: BASE_FIXTURES_179.non_judge.reason }]);

  // 대조군: NEVER_AUTOMATE에 걸리지 않는 비판정 PR은 그대로 창을 지나 머지된다.
  const ctl = selfD179();
  expect((await run179(ctl)).code).toBe(0);
  expect(ctl.mergePr).toHaveBeenCalledTimes(1);
});

// 판정 경로와 비판정 경로가 섞인 PR은 **두 스위치가 다 켜져야** 자기 변경 경로를 탄다 — 비판정 파일은 자기 스위치가 꺼져 있으면
// 판정 경로의 스위치를 빌려 자동 머지되지 않는다. 오늘의 hand-off 그대로이고, 왜 그 경로를 타지 않았는지 기록에 한 줄 남긴다.
test("test_179_mixed_pr_needs_both_switches", async () => {
  const BOTH = BASE_FIXTURES_179.both;
  expect(classifyProtected179(BOTH.files, { engine: true })).toEqual({ non_judge: ["factory/lib/status.js"], judge: ["factory/lib/gates.js"] });
  const LB = vi.fn(async () => ({ ok: true, roles: ["correctness", "qa"], tier: "load-bearing" }));
  const mixed = (selfChange) => selfD179({ protectedPaths: vi.fn(async () => ({ ok: true, files: BOTH.files })), selfChange, reviewRoster: LB });

  const judgeOnly = mixed({ auto_merge_non_judge: false, auto_merge_judge: true, veto_minutes: 60 });
  const r = await run179(judgeOnly);
  expect(r.code).toBe(2);
  expect(judgeOnly.transition.mock.calls.map((x) => x[0])).toEqual([{ to: "factory:needs-human", reason: BOTH.reason }]);
  expect(judgeOnly.comment.mock.calls).toEqual([[9, BOTH.comment]]);
  expect(r.lines).toEqual([
    ...BOTH.lines.slice(0, 2),
    "merge: self-change path not taken — the PR also changes non-judge protected paths (factory/lib/status.js) and CHARTER self_change.auto_merge_non_judge is false",
    ...BOTH.lines.slice(2),
  ]);
  for (const dep of [judgeOnly.vetoWindow.open, judgeOnly.vetoLabel, judgeOnly.sleep, judgeOnly.gates, judgeOnly.mergePr]) expect(dep).not.toHaveBeenCalled();

  // 둘 다 켜지면 판정 경로(만장일치 load-bearing 리뷰)로 창을 지나 머지된다.
  const both = mixed({ auto_merge_non_judge: true, auto_merge_judge: true, veto_minutes: 60 });
  expect((await run179(both)).code).toBe(0);
  expect(both.vetoWindow.open).toHaveBeenCalledTimes(1);
  expect(both.comment.mock.calls[0][1]).toContain("판정 경로 · 만장일치 리뷰");
  expect(both.mergePr).toHaveBeenCalledTimes(1);
});

// 창 열기 뒤의 의존성들 — 알림 코멘트, 상태 되읽기, 시계, 잠 — 중 어느 하나라도 실패하면 blocked다. 특히 알림 코멘트는
// best-effort가 아니다: 소유자에게 거부 방법을 알리지 못한 창은 기다리지도 머지하지도 않는다.
test("test_179_window_announcement_readback_and_clock_fail_closed", async () => {
  const expectBlocked = (d, lines, at, re) => {
    const last = d.transition.mock.calls.at(-1)[0];
    expect(last.to, at).toBe("factory:blocked");
    expect(last.reason, at).toMatch(re);
    expect(lines.some((l) => /^merge: veto window could not be computed: /.test(l)), at).toBe(true);
    expect(lines.some((l) => /veto window closed/.test(l)), at).toBe(false);
    expect(d.mergePr, at).not.toHaveBeenCalled();
    expect(d.transition.mock.calls.some((x) => x[0].to === "factory:merged"), at).toBe(false);
  };

  // 알림 코멘트가 던진다 → 기다림(폴링·잠) 없이 blocked.
  const c = selfD179({ comment: vi.fn(async () => { throw new Error("HTTP 502 on comment"); }) });
  const rc = await run179(c);
  expect(rc.code).toBe(2);
  expectBlocked(c, rc.lines, "comment throws", /announcement could not be posted.*HTTP 502 on comment/);
  expect(c.vetoLabel).not.toHaveBeenCalled();
  expect(c.sleep).not.toHaveBeenCalled();
  expect(rc.lines.some((l) => /veto window opened/.test(l))).toBe(false);
  // 코멘트 dep이 없어도 같다.
  const c0 = selfD179({ comment: undefined });
  const rc0 = await run179(c0);
  expectBlocked(c0, rc0.lines, "comment unwired", /owner could not be told how to veto/);
  expect(c0.sleep).not.toHaveBeenCalled();

  // 상태 되읽기 실패(ok:false·throw) → blocked, 코멘트·잠 없음.
  const w1 = vetoWindow179(); w1.read = vi.fn(async () => ({ ok: false, reason: "HTTP 500 statuses" }));
  const r1d = selfD179({ vetoWindow: w1 });
  const r1 = await run179(r1d);
  expectBlocked(r1d, r1.lines, "read ok:false", /could not be read back: HTTP 500 statuses/);
  expect(r1d.comment).not.toHaveBeenCalled();
  expect(r1d.sleep).not.toHaveBeenCalled();
  const w2 = vetoWindow179(); w2.read = vi.fn(async () => { throw new Error("ECONNRESET"); });
  const r2d = selfD179({ vetoWindow: w2 });
  const r2 = await run179(r2d);
  expectBlocked(r2d, r2.lines, "read throws", /could not be read back: ECONNRESET/);
  expect(r2d.comment).not.toHaveBeenCalled();

  // 시계가 창 도중에 던진다 → blocked(창이 닫혔다고 읽지 않는다).
  let ticks = 0;
  const base = clock179();
  const nowThrows = vi.fn(() => { if (++ticks === 4) throw new Error("clock gone"); return base.now(); });
  const t = selfD179({ now: nowThrows, sleep: base.sleep });
  const rt = await run179(t);
  expectBlocked(t, rt.lines, "now throws mid-loop", /clock unreadable: clock gone/);
  expect(t.sleep).toHaveBeenCalled();                                   // 창은 실제로 열려 있었다
  // 시계가 숫자가 아닌 값을 돌려준다 → blocked.
  let ticks2 = 0;
  const base2 = clock179();
  const nan = selfD179({ now: vi.fn(() => (++ticks2 >= 3 ? undefined : base2.now())), sleep: base2.sleep });
  const rn = await run179(nan);
  expectBlocked(nan, rn.lines, "now returns nothing", /clock returned no time/);

  // 잠이 던진다 → 판정 불가(blocked), 런이 터져 기록 없이 끝나지 않는다.
  const s = selfD179({ sleep: vi.fn(async () => { throw new Error("timer cancelled"); }) });
  const rs = await run179(s);
  expect(rs.code).toBe(2);
  expectBlocked(s, rs.lines, "sleep throws", /wait failed: timer cancelled/);
});

// 잡 예산은 창만이 아니라 창 **뒤**의 일(리뷰 재검증·승인·머지·전이)도 담아야 한다 — 창이 닫히는 순간 잡이 죽으면 run-stage의
// finally가 돌지 않아 이슈가 blocked도 merged도 아닌 채로 남는다(KTB-24). 그래서 창 + 10분 여유가 남아야 창을 연다.
test("test_179_job_budget_keeps_a_post_window_margin", async () => {
  // 잡 시작 2분 뒤에 창을 연다(clock179 기본값). timeout-minutes 62 → 남은 60분 = 창 60분: 여유가 없으니 열지 않는다.
  for (const [timeout, left] of [[62, 60], [71, 69]]) {
    const d = selfD179({ jobTimeoutMinutes: timeout });
    const r = await run179(d);
    const at = `timeout ${timeout}`;
    expect(r.code, at).toBe(2);
    const last = d.transition.mock.calls.at(-1)[0];
    expect(last.to, at).toBe("factory:blocked");
    expect(last.reason, at).toMatch(new RegExp(`timeout-minutes: ${timeout} leaves ${left} min`));
    expect(last.reason, at).toMatch(/veto_minutes: 60/);
    expect(last.reason, at).toMatch(/10 min margin/);
    for (const dep of [d.vetoWindow.open, d.comment, d.sleep, d.mergePr]) expect(dep, at).not.toHaveBeenCalled();
    expect(r.lines.some((l) => /^merge: veto window not started — /.test(l)), at).toBe(true);
  }
  // 남은 70분 = 창 60 + 여유 10 → 연다(경계는 포함).
  const fits = selfD179({ jobTimeoutMinutes: 72 });
  expect((await run179(fits)).code).toBe(0);
  expect(fits.vetoWindow.open).toHaveBeenCalledTimes(1);
  expect(fits.mergePr).toHaveBeenCalledTimes(1);
});

// 창 뒤에 검증한 head가 곧 머지되는 head다 — 자기 변경 경로는 `mergePr`에 그 sha를 넘겨(`--match-head-commit`) 재검증과
// 머지 사이의 push가 검증 없이 머지되지 못하게 한다.
test("test_179_self_change_merge_pins_the_verified_head", async () => {
  const d = selfD179();
  expect((await run179(d)).code).toBe(0);
  expect(d.mergePr.mock.calls).toEqual([[9, { matchHeadCommit: HEAD }]]);
  const j = selfD179({
    protectedPaths: vi.fn(async () => ({ ok: true, files: BASE_FIXTURES_179.judge.files })),
    selfChange: { auto_merge_non_judge: false, auto_merge_judge: true, veto_minutes: 60 },
    reviewRoster: vi.fn(async () => ({ ok: true, roles: ["correctness", "qa"], tier: "load-bearing" })),
  });
  expect((await run179(j)).code).toBe(0);
  expect(j.mergePr.mock.calls).toEqual([[9, { matchHeadCommit: HEAD }]]);
});

// ── #195 — the runner's PR evidence is published exactly once per merge run, before the merge or the hand-off ─────────────
// The dep is `publishPrEvidence` (not feedback's `appendEvidence`). Order is checked on the recorded dep calls; the evidence
// step must never block, duplicate or reorder the merge or the needs-human transition.
const evidence195 = (impl = async () => ({ ok: true, markdown: "## Factory evidence\n(md)" })) => ({
  publishPrEvidence: vi.fn(impl),
  postEvidenceComment: vi.fn(async () => ({ ok: true, posted: true })),
});
const failLines195 = (lines) => lines.filter((l) => l.startsWith("evidence: FAIL — "));
const order195 = (a, b) => expect(a.mock.invocationCallOrder[0]).toBeLessThan(b.mock.invocationCallOrder[0]);
const needsHumanCall195 = (d) => d.transition.mock.invocationCallOrder[d.transition.mock.calls.findIndex((c) => c[0].to === "factory:needs-human")];

test("test_195_merge_stage_publishes_evidence_once_before_merge_and_hand_off", async () => {
  // (a) auto-merge: once, after every gate and check, before mergePr; the issue comment follows the merge.
  {
    const ev = evidence195();
    const d = baseD(ev);
    const { lines, record } = makeRecord();
    expect(await run(d, { record })).toBe(0);
    expect(ev.publishPrEvidence).toHaveBeenCalledTimes(1);
    expect(ev.publishPrEvidence.mock.calls[0][0]).toMatchObject({ pr: 9, route: "merge", gatesRerun: false, reason: null, gates: { status: "GREEN", level: "full" } });
    order195(d.mergeGates, ev.publishPrEvidence);
    order195(d.prReady, ev.publishPrEvidence);
    order195(ev.publishPrEvidence, d.mergePr);
    expect(ev.postEvidenceComment.mock.calls.map((c) => c[0])).toEqual(["## Factory evidence\n(md)"]);
    order195(d.mergePr, ev.postEvidenceComment);
    expect(lines.filter((l) => l.startsWith("evidence: "))).toEqual(["evidence: published to PR #9 (merge)", "evidence: issue comment posted"]);
  }
  // (b) protected-path hand-off (before d.gates()): once, before the needs-human transition, with no gates and the hand-off reason.
  {
    const ev = evidence195();
    const d = baseD({ ...ev, protectedPaths: vi.fn(async () => ({ ok: true, files: [".github/workflows/x.yml"] })) });
    expect(await run(d)).toBe(2);
    expect(ev.publishPrEvidence).toHaveBeenCalledTimes(1);
    const args = ev.publishPrEvidence.mock.calls[0][0];
    expect(args).toMatchObject({ pr: 9, route: "hand-off", gates: null });
    expect(args.reason).toMatch(/^protected paths changed — human merge required: \.github\/workflows\/x\.yml/);
    expect(ev.publishPrEvidence.mock.invocationCallOrder[0]).toBeLessThan(needsHumanCall195(d));
    expect(d.gates).not.toHaveBeenCalled();
    expect(ev.postEvidenceComment).not.toHaveBeenCalled();
  }
  // (c) policy hand-off.
  {
    const ev = evidence195();
    const v = { file: "factory/test/merge-stage.test.js", rule: "tests-modified — an existing test assertion changed" };
    const d = baseD({ ...ev, policyViolations: vi.fn(async () => ({ ok: true, files: [v.file], violations: [v] })) });
    expect(await run(d)).toBe(2);
    expect(ev.publishPrEvidence).toHaveBeenCalledTimes(1);
    expect(ev.publishPrEvidence.mock.calls[0][0].reason).toMatch(/existing tests modified or deleted/);
    expect(ev.publishPrEvidence.mock.invocationCallOrder[0]).toBeLessThan(needsHumanCall195(d));
  }
  // (d) judge-path refusal hand-off.
  {
    const ev = evidence195();
    const d = selfD179({ ...ev,
      protectedPaths: vi.fn(async () => ({ ok: true, files: BASE_FIXTURES_179.judge.files })),
      selfChange: { auto_merge_non_judge: false, auto_merge_judge: true, veto_minutes: 60 },
      reviewRoster: vi.fn(async () => ({ ok: true, roles: ["correctness", "qa"], tier: "standard" })) });
    expect((await run179(d)).code).toBe(2);
    expect(ev.publishPrEvidence).toHaveBeenCalledTimes(1);
    expect(ev.publishPrEvidence.mock.calls[0][0]).toMatchObject({ route: "hand-off", gates: null });
    expect(ev.publishPrEvidence.mock.calls[0][0].reason).toMatch(/^judge path needs a unanimous review/);
    expect(ev.publishPrEvidence.mock.invocationCallOrder[0]).toBeLessThan(needsHumanCall195(d));
  }
  // (e) self-change path: once, before the veto-window announcement — not again at mergePr.
  {
    const ev = evidence195();
    const d = selfD179(ev);
    const r = await run179(d);
    expect(r.code).toBe(0);
    expect(ev.publishPrEvidence).toHaveBeenCalledTimes(1);
    expect(ev.publishPrEvidence.mock.calls[0][0]).toMatchObject({ route: "veto-window", gates: { status: "GREEN" } });
    const announce = d.comment.mock.calls.findIndex((c) => /거부권 창/.test(c[1]));
    expect(announce).toBeGreaterThanOrEqual(0);
    expect(ev.publishPrEvidence.mock.invocationCallOrder[0]).toBeLessThan(d.comment.mock.invocationCallOrder[announce]);
    expect(ev.publishPrEvidence.mock.invocationCallOrder[0]).toBeLessThan(d.sleep.mock.invocationCallOrder[0]);
    order195(ev.publishPrEvidence, d.mergePr);
    expect(ev.postEvidenceComment).toHaveBeenCalledTimes(1);
  }
  // (f) a veto: the window's evidence stands; the hand-off that ends the window does not publish a second time.
  {
    const ev = evidence195();
    const d = selfD179({ ...ev, vetoLabel: vi.fn(async () => ({ ok: true, vetoes: [{ login: "owner", at: null }] })) });
    expect((await run179(d)).code).toBe(2);
    expect(ev.publishPrEvidence).toHaveBeenCalledTimes(1);
    expect(ev.publishPrEvidence.mock.calls[0][0].route).toBe("veto-window");
    expect(d.transition.mock.calls.at(-1)[0].reason).toMatch(/^vetoed by @owner/);
    expect(ev.postEvidenceComment).not.toHaveBeenCalled();
  }
  // (g) the dep throws, rejects, times out or answers ok:false → the merge / the transition still happens, the exit code is
  // unchanged, and the record gets exactly one `evidence: FAIL — <reason>` line.
  const failing = {
    throws: () => { throw new Error("gh pr edit exploded"); },
    rejects: async () => { throw new Error("gh pr view failed (1): HTTP 502"); },
    "times out": () => new Promise(() => {}),
    "ok:false": async () => ({ ok: false, reason: "body unreadable" }),
  };
  for (const [kind, impl] of Object.entries(failing)) {
    const ev = evidence195(impl);
    const d = baseD({ ...ev, evidenceTimeoutMs: 5 });
    const { lines, record } = makeRecord();
    expect(await run(d, { record }), kind).toBe(0);
    expect(d.mergePr, kind).toHaveBeenCalledTimes(1);
    expect(d.transition.mock.calls.map((c) => c[0].to), kind).toEqual(["factory:merged"]);
    expect(failLines195(lines), kind).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("evidence: ")), kind).toHaveLength(1);
    expect(ev.postEvidenceComment, kind).not.toHaveBeenCalled();

    const ev2 = evidence195(impl);
    const h = baseD({ ...ev2, evidenceTimeoutMs: 5, protectedPaths: vi.fn(async () => ({ ok: true, files: [".github/workflows/x.yml"] })) });
    const rec2 = makeRecord();
    expect(await run(h, { record: rec2.record }), kind).toBe(2);
    expect(h.transition.mock.calls.map((c) => c[0].to), kind).toEqual(["factory:needs-human"]);
    expect(failLines195(rec2.lines), kind).toHaveLength(1);
  }
  expect(failLines195((await (async () => { const ev = evidence195(failing.rejects); const { lines, record } = makeRecord(); await run(baseD(ev), { record }); return lines; })()))[0]).toMatch(/HTTP 502/);
  // A failing issue comment after the merge is recorded and never undoes anything.
  {
    const ev = evidence195();
    ev.postEvidenceComment = vi.fn(async () => { throw new Error("comment 500"); });
    const d = baseD(ev);
    const { lines, record } = makeRecord();
    expect(await run(d, { record })).toBe(0);
    expect(d.closeIssue).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => /^evidence: issue comment failed — comment 500/.test(l))).toBe(true);
  }
  // An older wiring without the dep merges exactly as before.
  {
    const d = baseD();
    expect(await run(d)).toBe(0);
    expect(d.mergePr).toHaveBeenCalledTimes(1);
  }
});

// #195 self-critique — the rerun fact is a value merge-stage hands to the evidence dep; it is guarded at the wiring layer on
// the real #157 rerun route (runGates-produced RED, then GREEN), not only by calling buildEvidence with gatesRerun:true.
test("test_195_rerun_fact_reaches_the_evidence_dep_on_the_157_rerun_route", async () => {
  const first = await producedGates({ failing: [OC_ID], sha: HEAD });
  const second = await producedGates({ failing: [], sha: HEAD });
  const ev = evidence195();
  const r = await run157({ seq: [first, second], diff: { ok: true, files: CLIENT_ONLY }, over: { prReady: undefined, ...ev } });
  expect(r.code).toBe(0);
  expect(r.d.gates).toHaveBeenCalledTimes(2);
  expect(ev.publishPrEvidence).toHaveBeenCalledTimes(1);
  const args = ev.publishPrEvidence.mock.calls[0][0];
  expect(args.route).toBe("merge");
  expect(args.gatesRerun).toBe(true);
  // The gates row is the re-run's GREEN verdict, not the first run's RED.
  expect(args.gates.status).toBe("GREEN");
  expect(args.gates.gates.unit.failing_ids).toEqual([]);
  expect(ev.publishPrEvidence.mock.invocationCallOrder[0]).toBeGreaterThan(r.d.gates.mock.invocationCallOrder[1]);
  expect(ev.publishPrEvidence.mock.invocationCallOrder[0]).toBeLessThan(r.d.mergePr.mock.invocationCallOrder[0]);

  // Same harness, first run GREEN: no re-run, and the dep is told so.
  const ev2 = evidence195();
  const plain = await run157({ seq: [second], diff: { ok: true, files: CLIENT_ONLY }, over: { prReady: undefined, ...ev2 } });
  expect(plain.code).toBe(0);
  expect(plain.d.gates).toHaveBeenCalledTimes(1);
  expect(ev2.publishPrEvidence.mock.calls[0][0]).toMatchObject({ route: "merge", gatesRerun: false, gates: { status: "GREEN" } });
});

// #195 self-critique — a timed-out evidence step is CANCELLED, not abandoned: merge-stage aborts the signal it handed the dep
// before it moves on, so a dep that settles late cannot write the PR body after the merge or the needs-human transition.
test("test_195_evidence_timeout_cancels_the_write_before_the_merge_or_hand_off", async () => {
  for (const route of ["merge", "hand-off"]) {
    let release;
    const held = new Promise((res) => { release = res; });
    const events = [];
    const ev = evidence195(async ({ signal }) => {
      events.push("publish:start");
      await held;                                                        // gh is slow: settles only after the timeout fired
      if (signal?.aborted) { events.push("publish:cancelled"); throw signal.reason ?? new Error("aborted"); }
      events.push("publish:write");
      return { ok: true, markdown: "late" };
    });
    const signalNow = () => ev.publishPrEvidence.mock.calls[0]?.[0]?.signal;
    const over = route === "hand-off" ? { protectedPaths: vi.fn(async () => ({ ok: true, files: [".github/workflows/x.yml"] })) } : {};
    const d = baseD({ ...ev, evidenceTimeoutMs: 5, ...over });
    const mergePr = d.mergePr;
    d.mergePr = vi.fn(async (...a) => { events.push(`mergePr:aborted=${signalNow()?.aborted}`); return mergePr(...a); });
    const transition = d.transition;
    d.transition = vi.fn(async (t) => { if (t.to === "factory:needs-human") events.push(`needs-human:aborted=${signalNow()?.aborted}`); return transition(t); });
    const { lines, record } = makeRecord();
    expect(await run(d, { record }), route).toBe(route === "merge" ? 0 : 2);
    expect(signalNow(), route).toBeInstanceOf(AbortSignal);
    // The signal was aborted BEFORE the irreversible step ran.
    expect(events, route).toContain(route === "merge" ? "mergePr:aborted=true" : "needs-human:aborted=true");
    expect(failLines195(lines), route).toHaveLength(1);
    expect(failLines195(lines)[0], route).toMatch(/^evidence: FAIL — timed out after 5 ms — the PR-body write was cancelled/);
    // The late dep now settles: it sees the abort and never writes.
    release();
    await held;
    await new Promise((res) => setImmediate(res));
    expect(events, route).toContain("publish:cancelled");
    expect(events, route).not.toContain("publish:write");
    expect(ev.postEvidenceComment, route).not.toHaveBeenCalled();
  }
  // A dep that finishes in time is handed a signal that was never aborted.
  const ok = evidence195();
  await run(baseD(ok));
  expect(ok.publishPrEvidence.mock.calls[0][0].signal.aborted).toBe(false);
});

// #195 skeptic round 2 — a missing dep is never silent, and the post-merge issue comment is bounded and cancelled like the
// PR-body step: a hung `gh` there must not stop the factory:merged transition or the issue close. Its record line says what
// the dep did (posted vs already present), not what was hoped.
test("test_195_missing_evidence_dep_and_hung_issue_comment_are_recorded_not_silent", async () => {
  // (1) The publishPrEvidence slot is there but the dep is missing: the merge still happens, the exit code is unchanged, and
  // exactly one FAIL line says why.
  {
    const d = baseD({ publishPrEvidence: undefined });
    expect(Object.prototype.hasOwnProperty.call(d, "publishPrEvidence")).toBe(true);
    const { lines, record } = makeRecord();
    expect(await run(d, { record })).toBe(0);
    expect(d.mergePr).toHaveBeenCalledTimes(1);
    expect(d.transition.mock.calls.map((c) => c[0].to)).toEqual(["factory:merged"]);
    expect(failLines195(lines)).toEqual(["evidence: FAIL — publishPrEvidence dep not wired — no evidence section was written"]);
    expect(lines.filter((l) => l.startsWith("evidence: "))).toHaveLength(1);
  }
  // … and on the hand-off route: one FAIL line before the needs-human transition, exit code 2 as before.
  {
    const d = baseD({ publishPrEvidence: null, protectedPaths: vi.fn(async () => ({ ok: true, files: [".github/workflows/x.yml"] })) });
    const { lines, record } = makeRecord();
    expect(await run(d, { record })).toBe(2);
    expect(d.transition.mock.calls.map((c) => c[0].to)).toEqual(["factory:needs-human"]);
    expect(failLines195(lines)).toHaveLength(1);
  }
  // A wiring that predates the slot (no publishPrEvidence key at all — every pre-#195 test harness) keeps its record
  // byte-identical, as test_179_switch_off_is_byte_identical pins: no evidence line of any kind.
  {
    const d = baseD();
    expect(Object.prototype.hasOwnProperty.call(d, "publishPrEvidence")).toBe(false);
    const { lines, record } = makeRecord();
    expect(await run(d, { record })).toBe(0);
    expect(lines.filter((l) => l.startsWith("evidence: "))).toEqual([]);
  }
  // (2) The issue comment hangs: bounded by the same evidence timeout and cancelled through its signal; the merged
  // transition and the issue close still run, and the record says the comment failed.
  {
    const ev = evidence195();
    let seen = null;
    ev.postEvidenceComment = vi.fn((_md, opts) => { seen = opts?.signal ?? null; return new Promise(() => {}); });
    const d = baseD({ ...ev, evidenceTimeoutMs: 5 });
    const { lines, record } = makeRecord();
    expect(await run(d, { record })).toBe(0);
    expect(d.transition.mock.calls.map((c) => c[0].to)).toEqual(["factory:merged"]);
    expect(d.closeIssue).toHaveBeenCalledTimes(1);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen.aborted).toBe(true);
    expect(lines.filter((l) => l.startsWith("evidence: issue comment"))).toEqual(["evidence: issue comment failed — timed out after 5 ms — the issue comment was cancelled"]);
  }
  // (3) The record line follows what the dep did: an existing runner comment (a rerun) is not reported as a new post.
  for (const [answer, line] of [
    [{ ok: true, posted: true }, "evidence: issue comment posted"],
    [{ ok: true, posted: false, updated: 1 }, "evidence: issue comment already present — not posted again (1 updated in place)"],
    [{ ok: true, posted: false, updated: 0 }, "evidence: issue comment already present — not posted again (0 updated in place)"],
    [undefined, "evidence: issue comment dep returned without saying whether it posted"],
  ]) {
    const ev = evidence195();
    ev.postEvidenceComment = vi.fn(async () => answer);
    const { lines, record } = makeRecord();
    expect(await run(baseD(ev), { record })).toBe(0);
    expect(lines.filter((l) => l.startsWith("evidence: issue comment"))).toEqual([line]);
  }
});
