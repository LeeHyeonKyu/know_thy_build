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
