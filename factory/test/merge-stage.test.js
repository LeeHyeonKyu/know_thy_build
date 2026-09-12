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
