import { test, expect, vi } from "vitest";
import { runStage, makeFactoryOverlay, resolveStageSha, overlayDrift, assertStageBranch, assertNoWriteStageClean, overlayPathspecs, OVERLAY_PATHSPECS, OVERLAY_ROOTS, OVERLAY_LABEL, SESSION_CONFIG_GLOBS, SESSION_CONFIG_PATHSPECS, SESSION_CONFIG_RE } from "../bin/run-stage.js";
import { HARNESS_OPENS } from "../lib/protected-paths.js";
import { makeFakeRun } from "../lib/exec.js";

/**
 * KTB-37 — 스테이지는 PR의 **코드**를 돌지만 팩토리 자신의 **설정**은 base(스테이지 자신의 커밋)의 것이어야 한다.
 * 아래 스텁은 `git` 호출만 흉내낸다: cat-file(존재 확인) → checkout(덮어쓰기) → status(무엇이 덮였나).
 */
const gitStub = ({ sha = "b".repeat(40), present = OVERLAY_ROOTS, checkoutCode = 0, statusOut = "", revParse = null, calls = [], tree = [], lsTreeCode = 0 } = {}) =>
  makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "rev-parse", result: () => (revParse === null ? { code: 128, stdout: "", stderr: "unknown revision" } : { code: 0, stdout: `${revParse}\n`, stderr: "" }) },
    { match: (c, a) => c === "git" && a[0] === "cat-file", result: (c, a) => { calls.push(a.join(" ")); return present.some((p) => a[2] === `${sha}:${p}`) ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "not found" }; } },
    { match: (c, a) => c === "git" && a[0] === "checkout", result: (c, a) => { calls.push(a.join(" ")); return checkoutCode === 0 ? { code: 0, stdout: "", stderr: "" } : { code: checkoutCode, stdout: "", stderr: "error: pathspec did not match" }; } },
    { match: (c, a) => c === "git" && a[0] === "status", result: { code: 0, stdout: statusOut, stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "diff", result: { code: 0, stdout: "", stderr: "" } },
    // 리뷰 batch-2 MF-3 — 스테이지 커밋의 트리 스캔(세션 설정 파일을 깊이 무관하게 찾는다).
    { match: (c, a) => c === "git" && a[0] === "ls-tree", result: () => (lsTreeCode === 0 ? { code: 0, stdout: `${tree.join("\n")}\n`, stderr: "" } : { code: lsTreeCode, stdout: "", stderr: "fatal: bad object" }) },
  ]);

test("overlay: restores the factory-owned paths from the stage's own sha, and excludes .factory/out/**", async () => {
  const calls = [];
  const sha = "c".repeat(40);
  const run = gitStub({ sha, calls, statusOut: "M  .claude/hooks/block-dangerous.sh\nM  .factory/ci-settings.json\n" });
  const overlay = makeFactoryOverlay({ run, root: "/repo", env: { GITHUB_SHA: sha }, defaultBranch: () => "main" });
  const r = await overlay();
  expect(r.ok).toBe(true);
  expect(r.sha).toBe(sha);
  expect(r.paths).toEqual([".claude/hooks/block-dangerous.sh", ".factory/ci-settings.json"]);
  const co = calls.find((c) => c.startsWith("checkout"));
  expect(co).toContain(sha);
  expect(co).toContain(":(exclude).factory/out");
  expect(co).toContain(".claude");
  expect(co).toContain("docs/factory/CHARTER.md");
  // 스테이지 산출물은 overlay의 대상이 아니다 — 체크아웃 pathspec에서 배제되어 있다.
  expect(OVERLAY_PATHSPECS).toContain(":(exclude).factory/out");
});

test("overlay: a path the stage sha does not carry is dropped, not a failure", async () => {
  const sha = "c".repeat(40);
  const calls = [];
  const run = gitStub({ sha, calls, present: [".factory"] });         // 어댑터 레포: .claude/도 CHARTER도 없다
  const r = await makeFactoryOverlay({ run, root: "/repo", env: { GITHUB_SHA: sha }, defaultBranch: () => "main" })();
  expect(r.ok).toBe(true);
  const co = calls.find((c) => c.startsWith("checkout"));
  expect(co).not.toContain(".claude ");
  expect(co).not.toContain("docs/factory/CHARTER.md");
});

test("overlay: fail-closed — the checkout failing is a refusal, never a silent pass", async () => {
  const sha = "c".repeat(40);
  const run = gitStub({ sha, checkoutCode: 1 });
  const r = await makeFactoryOverlay({ run, root: "/repo", env: { GITHUB_SHA: sha }, defaultBranch: () => "main" })();
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/overlay checkout failed/);
});

test("overlay: fail-closed — no resolvable stage sha is a refusal", async () => {
  const run = gitStub({ revParse: null });
  const r = await makeFactoryOverlay({ run, root: "/repo", env: {}, defaultBranch: () => "main" })();
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/stage sha/);
});

test("overlay: fail-closed — the stage sha carries none of the factory-owned paths", async () => {
  const sha = "c".repeat(40);
  const run = gitStub({ sha, present: [] });
  const r = await makeFactoryOverlay({ run, root: "/repo", env: { GITHUB_SHA: sha }, defaultBranch: () => "main" })();
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/carries none of/);
});

test("resolveStageSha: CI takes GITHUB_SHA; locally it resolves origin/<default branch>", async () => {
  const sha = "d".repeat(40);
  const runCi = gitStub({ sha });
  expect(await resolveStageSha({ run: runCi, root: "/repo", env: { GITHUB_SHA: sha }, defaultBranch: "main" })).toEqual({ ok: true, sha, source: "GITHUB_SHA" });

  const local = "e".repeat(40);
  const seen = [];
  const runLocal = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "rev-parse", result: (c, a) => { seen.push(a[1]); return { code: 0, stdout: `${local}\n`, stderr: "" }; } },
  ]);
  expect(await resolveStageSha({ run: runLocal, root: "/repo", env: {}, defaultBranch: "trunk" })).toEqual({ ok: true, sha: local, source: "origin/trunk" });
  expect(seen).toEqual(["origin/trunk"]);
});

test("resolveStageSha: a GITHUB_SHA that is not a sha is refused (never used as a pathspec-adjacent rev)", async () => {
  const run = gitStub({ revParse: null });
  const r = await resolveStageSha({ run, root: "/repo", env: { GITHUB_SHA: "refs/heads/main" }, defaultBranch: "main" });
  expect(r.ok).toBe(false);
});

test("overlayDrift: an agent that rewrites an overlaid file mid-session is caught", async () => {
  const sha = "c".repeat(40);
  const run = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "diff", result: { code: 0, stdout: ".claude/hooks/block-dangerous.sh\n", stderr: "" } },
  ]);
  expect(await overlayDrift({ run, cwd: "/repo", sha })).toEqual({ ok: false, paths: [".claude/hooks/block-dangerous.sh"] });
});

test("overlayDrift: git diff itself failing is fail-closed", async () => {
  const run = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "diff", result: { code: 128, stdout: "", stderr: "fatal: bad object" } },
  ]);
  const r = await overlayDrift({ run, cwd: "/repo", sha: "c".repeat(40) });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/fatal: bad object/);
});

test("assertNoWriteStageClean: the overlay's own paths are allowed, anything else is still dirty", async () => {
  const run = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "status", result: { code: 0, stdout: "M  .claude/settings.json\nM  src/a.js\n", stderr: "" } },
  ]);
  expect(await assertNoWriteStageClean({ run, cwd: "/repo", allow: [".claude/settings.json"] })).toEqual({ ok: false, dirty: ["src/a.js"] });
  expect((await assertNoWriteStageClean({ run, cwd: "/repo", allow: [".claude/settings.json", "src/a.js"] })).ok).toBe(true);
});

// ---- runStage wiring -------------------------------------------------------

const overlayDeps = (over = {}) => ({
  charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }),
  heartbeat: async () => ({ stop() {} }), assertHandoff: async () => ({ ok: true }),
  buildContext: async () => ({ roster: [], orchestration: "workflow", limits: { K: 3 } }),
  resetAgentsLog: async () => {}, claudeP: async () => ({ is_error: false, result: "{}" }), gates: async () => null,
  verifyStage: () => ({ ok: true, reasons: [], data: {} }), writeHandoff: async () => {},
  transition: async () => ({ ok: true, to: "factory:awaiting-review" }), runRecord: () => {}, release: async () => true,
  checkoutHead: async () => ({ ok: true, sha: "a".repeat(40), pr: 3 }),
  overlayFactoryConfig: async () => ({ ok: true, sha: "b".repeat(40), paths: [".factory/ci-settings.json"] }),
  assertCleanWorktree: async () => ({ ok: true, dirty: [] }),
  ...over,
});

test("review: the overlay runs after the detach and before claude -p, and says what it overlaid", async () => {
  const calls = [];
  const lines = [];
  const d = overlayDeps({
    checkoutHead: async () => { calls.push("checkout"); return { ok: true, sha: "a".repeat(40), pr: 3 }; },
    overlayFactoryConfig: async () => { calls.push("overlay"); return { ok: true, sha: "b".repeat(40), paths: [".factory/ci-settings.json", ".claude/hooks/x.sh"] }; },
    claudeP: async () => { calls.push("claude"); return { is_error: false, result: "{}" }; },
    runRecord: (l) => lines.push(...l),
  });
  await runStage({ stage: "review", issue: 3, deps: d });
  expect(calls).toEqual(["checkout", "overlay", "claude"]);
  const line = lines.find((l) => l.startsWith("overlay:"));
  expect(line).toContain("bbbbbbb");
  expect(line).toContain("2 path");
  expect(line).toContain(".factory/ci-settings.json");
});

// ── ADR-024 / KTB-42 — 증거 디렉터리 프로브는 오버레이 **직후**, `claude -p` **이전** ─────────────
// KTB #3: qa는 `.factory/out/qa/`에 한 글자도 쓸 수 없었고, 그 사실은 리뷰가 끝난 뒤 `spec1: qa
// evidence missing`이라는 **빌더를 가리키는 문장**으로만 드러났다(8라운드). 이제 먼저 묻는다.

test("KTB-42: the qa evidence probe runs after the overlay and before claude -p, and leaves a line", async () => {
  const calls = [];
  const lines = [];
  const d = overlayDeps({
    overlayFactoryConfig: async () => { calls.push("overlay"); return { ok: true, sha: "b".repeat(40), paths: [] }; },
    qaEvidenceProbe: async () => { calls.push("probe"); return { ok: true, line: "qa evidence probe: ok — .factory/out/qa/3 is writable" }; },
    claudeP: async () => { calls.push("claude"); return { is_error: false, result: "{}" }; },
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 3, deps: d })).toBe(0);
  expect(calls).toEqual(["overlay", "probe", "claude"]);
  expect(lines.some((l) => /qa evidence probe: ok/.test(l))).toBe(true);
});

test("KTB-42: a non-writable evidence dir is factory:blocked/undecidable — never a review reject", async () => {
  const transition = vi.fn(async () => ({ ok: true }));
  const claudeP = vi.fn(async () => ({ is_error: false, result: "{}" }));
  const lines = [];
  const d = overlayDeps({
    qaEvidenceProbe: async () => ({ ok: false, reason: "mkdir -p .factory/out/qa/3 failed: EACCES: permission denied" }),
    transition, claudeP, runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 3, deps: d })).toBe(2);
  expect(claudeP).not.toHaveBeenCalled();
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({
    to: "factory:blocked",
    cause: "undecidable",
    reason: expect.stringContaining("qa evidence dir not writable"),
  }));
  expect(lines.some((l) => /qa evidence probe: FAIL/.test(l))).toBe(true);
});

test("KTB-42: the probe is a review-stage thing — implement never runs it", async () => {
  const probe = vi.fn(async () => ({ ok: false, reason: "should not be asked" }));
  const d = overlayDeps({
    checkoutHead: undefined, ciSettingsPresent: async () => true,
    overlayFactoryConfig: async () => ({ ok: true, sha: "b".repeat(40), paths: [] }),
    qaEvidenceProbe: probe,
  });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(0);
  expect(probe).not.toHaveBeenCalled();
});

test("review: the overlay failing aborts the stage — the review never runs on PR-head config", async () => {
  const transition = vi.fn(async () => ({ ok: true }));
  const claudeP = vi.fn(async () => ({ is_error: false, result: "{}" }));
  const lines = [];
  const d = overlayDeps({
    overlayFactoryConfig: async () => ({ ok: false, reason: "overlay checkout failed: error: pathspec" }),
    transition, claudeP, runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "review", issue: 3, deps: d })).toBe(2);
  expect(claudeP).not.toHaveBeenCalled();
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked" }));
  expect(lines.some((l) => /overlay: FAIL/.test(l))).toBe(true);
});

test("review: the overlaid paths are handed to the clean check, so a legitimately edited .claude/** PR still gets reviewed", async () => {
  let got = null;
  const d = overlayDeps({
    overlayFactoryConfig: async () => ({ ok: true, sha: "b".repeat(40), paths: [".claude/settings.json"] }),
    assertCleanWorktree: async (allow) => { got = allow; return { ok: true, dirty: [] }; },
  });
  expect(await runStage({ stage: "review", issue: 3, deps: d })).toBe(0);
  expect(got).toEqual([".claude/settings.json"]);
});

test("merge: the overlay runs on the detached tree too (integrity still reads base via git show — unaffected)", async () => {
  const calls = [];
  const d = overlayDeps({
    checkoutHead: async () => { calls.push("checkout"); return { ok: true, sha: "a".repeat(40), pr: 3 }; },
    overlayFactoryConfig: async () => { calls.push("overlay"); return { ok: true, sha: "b".repeat(40), paths: [] }; },
    runMergeStage: async () => { calls.push("merge"); return 0; },
    // merge-stage 자신은 이 테스트의 대상이 아니다 — 아래 deps는 runMergeStage가 곧장 끝나도록만 채운다.
    protectedPaths: async () => ({ ok: true, files: [] }),
  });
  // runStage는 merge에서 runMergeStage로 넘어간다 — 그 전에 checkout → overlay 순서가 지켜져야 한다.
  await runStage({ stage: "merge", issue: 3, deps: d }).catch(() => {});
  expect(calls.slice(0, 2)).toEqual(["checkout", "overlay"]);
});

test("implement: a clean overlay proceeds — the tree is already the stage's own commit", async () => {
  const calls = [];
  const d = overlayDeps({
    checkoutHead: undefined,
    overlayFactoryConfig: async () => { calls.push("overlay"); return { ok: true, sha: "b".repeat(40), paths: [] }; },
    claudeP: async () => { calls.push("claude"); return { is_error: false, result: "{}" }; },
    ciSettingsPresent: async () => true,
  });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(0);
  expect(calls).toEqual(["overlay", "claude"]);
});

test("implement: an overlay that actually changes files aborts — the builder's commit can never carry .claude/** or .factory/**", async () => {
  const claudeP = vi.fn(async () => ({ is_error: false, result: "{}" }));
  const transition = vi.fn(async () => ({ ok: true, to: "factory:blocked" }));
  const lines = [];
  const d = overlayDeps({
    checkoutHead: undefined, claudeP, transition, runRecord: (l) => lines.push(...l),
    ciSettingsPresent: async () => true,
    overlayFactoryConfig: async () => ({ ok: true, sha: "b".repeat(40), paths: [".claude/hooks/block-dangerous.sh"] }),
  });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(2);
  expect(claudeP).not.toHaveBeenCalled();
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked" }));
  expect(lines.some((l) => /overlay: FAIL/.test(l) && /\.claude\/hooks\/block-dangerous\.sh/.test(l))).toBe(true);
});

test("OVERLAY_LABEL names exactly the factory-owned surface — one line a human can read", () => {
  expect(OVERLAY_LABEL).toMatch(/\.factory/);
  expect(OVERLAY_LABEL).toMatch(/\.claude/);
  expect(OVERLAY_LABEL).toMatch(/CHARTER\.md/);
});

// ── 리뷰 batch-1 MF-3 — overlay는 "덮어쓰기"가 아니라 "그 커밋과 바이트 동일하게 만들기"다 ────────
// 재리뷰가 스크래치 저장소에서 확인한 두 결함: ① `CLAUDE.md`·`.mcp.json`은 루트 밖이라 overlay도
// drift 검사도 보지 못했는데 `claude -p` 세션은 그것을 프로젝트 지시문·MCP 서버로 읽는다(리뷰
// 세션으로 가는 곧은 지시문 주입 경로였다), ② PR이 **추가한** 파일은 `git checkout <sha> -- …`가
// 지우지 않아 세션이 이미 그 파일과 함께 돈 뒤에야 drift로 잡혔다.

const overlayStub = ({ sha, present, added = [], drift = [], calls = [], rmCode = 0, tree = [], lsTreeCode = 0 }) => {
  let diffCall = 0;
  return makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "ls-tree", result: (c, a) => { calls.push(a.join(" ")); return lsTreeCode === 0 ? { code: 0, stdout: `${tree.join("\n")}\n`, stderr: "" } : { code: lsTreeCode, stdout: "", stderr: "fatal: bad object" }; } },
    { match: (c, a) => c === "git" && a[0] === "cat-file", result: (c, a) => (present.some((p) => a[2] === `${sha}:${p}`) ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "not found" }) },
    { match: (c, a) => c === "git" && a[0] === "checkout", result: (c, a) => { calls.push(a.join(" ")); return { code: 0, stdout: "", stderr: "" }; } },
    { match: (c, a) => c === "git" && a[0] === "rm", result: (c, a) => { calls.push(a.join(" ")); return rmCode === 0 ? { code: 0, stdout: "", stderr: "" } : { code: rmCode, stdout: "", stderr: "fatal: pathspec did not match" }; } },
    { match: (c, a) => c === "git" && a[0] === "status", result: { code: 0, stdout: "", stderr: "" } },
    // 첫 diff는 추가된 파일 스캔(--diff-filter=A), 두 번째는 overlay 직후의 drift 확인이다.
    { match: (c, a) => c === "git" && a[0] === "diff", result: (c, a) => { calls.push(a.join(" ")); diffCall += 1; return { code: 0, stdout: (diffCall === 1 ? added : drift).join("\n"), stderr: "" }; } },
  ]);
};

test("overlay: CLAUDE.md / .mcp.json / AGENTS.md are factory-owned session config and are overlaid (review batch-1 MF-3)", async () => {
  for (const g of ["**/CLAUDE*.md", "**/AGENTS*.md", "**/.mcp*.json"]) {
    expect(SESSION_CONFIG_GLOBS, g).toContain(g);
    expect(OVERLAY_PATHSPECS, g).toContain(`:(glob)${g}`);
    expect(OVERLAY_LABEL, g).toContain(g);
  }
  const sha = "c".repeat(40);
  const calls = [];
  // 어댑터 레포의 모양: main에도 CLAUDE.md와 .mcp.json이 있다 — PR이 고친 것을 되돌려야 한다.
  const run = overlayStub({ sha, present: [".factory", ".claude"], tree: ["CLAUDE.md", ".mcp.json", "src/app.js"], calls });
  const r = await makeFactoryOverlay({ run, root: "/repo", env: { GITHUB_SHA: sha }, defaultBranch: () => "main" })();
  expect(r.ok).toBe(true);
  const co = calls.find((c) => c.startsWith("checkout"));
  expect(co).toContain("CLAUDE.md");
  expect(co).toContain(".mcp.json");
  expect(co).not.toContain("src/app.js");
});

// ── 리뷰 batch-2 MF-3 — 그 보호는 전부 **루트에 앵커돼** 있었다 ─────────────────────────────────
// `globToRegex`는 `^…$`로 앵커하므로 `"CLAUDE.md"`는 루트만 맞는다. 그런데 Claude Code는 세션이
// 건드리는 디렉터리의 `CLAUDE.md`/`AGENTS.md`를 함께 읽는다 — 리뷰 세션은 정의상 소스 디렉터리를
// 건드린다. 곧 `docs/CLAUDE.md` 한 장이 overlay·drift·[protected]·Write deny를 전부 비켜 갔다.

test("overlay: nested session config (docs/CLAUDE.md, src/AGENTS.md, CLAUDE.local.md) is overlaid too (review batch-2 MF-3)", async () => {
  const sha = "c".repeat(40);
  const calls = [];
  const nested = ["CLAUDE.md", "CLAUDE.local.md", "docs/CLAUDE.md", "src/AGENTS.md", "packages/x/.mcp.local.json"];
  const run = overlayStub({ sha, present: [".factory"], tree: [...nested, "src/app.js", "docs/README.md"], calls });
  const r = await makeFactoryOverlay({ run, root: "/repo", env: { GITHUB_SHA: sha }, defaultBranch: () => "main" })();
  expect(r.ok).toBe(true);
  const co = calls.find((c) => c.startsWith("checkout"));
  for (const p of nested) expect(co, p).toContain(p);
  // 세션 설정이 아닌 파일은 overlay의 대상이 아니다(그건 PR의 코드다).
  expect(co).not.toContain("src/app.js");
  expect(co).not.toContain("docs/README.md");
  // 추가 파일 스캔과 drift 검사는 깊이 무관 pathspec으로 돈다 — 스테이지 커밋에 **없는** 경로가
  // 바로 PR이 새로 들여온 경로이므로, 그쪽은 목록이 아니라 글롭이어야 한다.
  const scan = calls.find((c) => c.includes("--diff-filter=A"));
  for (const g of SESSION_CONFIG_PATHSPECS) expect(scan, g).toContain(g);
});

test("SESSION_CONFIG_RE matches the three names at any depth, and nothing else (review batch-2 MF-3)", () => {
  for (const p of ["CLAUDE.md", "CLAUDE.local.md", "docs/CLAUDE.md", "a/b/c/CLAUDE.md", "AGENTS.md", "src/AGENTS.override.md", ".mcp.json", "pkg/.mcp.local.json"]) {
    expect(SESSION_CONFIG_RE.test(p), p).toBe(true);
  }
  for (const p of ["src/app.js", "docs/README.md", "docs/CLAUDE.md.bak", "claude.md.txt", "mcp.json", "docs/AGENTS.txt"]) {
    expect(SESSION_CONFIG_RE.test(p), p).toBe(false);
  }
});

test("overlay: fail-closed — the session-config scan failing stops the stage (review batch-2 MF-3)", async () => {
  const sha = "c".repeat(40);
  const run = overlayStub({ sha, present: [".factory", ".claude"], lsTreeCode: 128 });
  const r = await makeFactoryOverlay({ run, root: "/repo", env: { GITHUB_SHA: sha }, defaultBranch: () => "main" })();
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/session-config scan failed/);
});

test("overlay: a repo with only nested session config and no .factory/.claude still overlays it (review batch-2 MF-3)", async () => {
  const sha = "c".repeat(40);
  const calls = [];
  const run = overlayStub({ sha, present: [], tree: ["docs/CLAUDE.md"], calls });
  const r = await makeFactoryOverlay({ run, root: "/repo", env: { GITHUB_SHA: sha }, defaultBranch: () => "main" })();
  expect(r.ok).toBe(true);
  expect(calls.find((c) => c.startsWith("checkout"))).toContain("docs/CLAUDE.md");
});

test("overlay: files the PR ADDED under the overlay roots are removed, not left for the post-session drift check (review batch-1 MF-3)", async () => {
  const sha = "c".repeat(40);
  const calls = [];
  // main에는 CLAUDE.md가 없다 — PR이 새로 들여왔다. `present` 필터만 믿으면 정확히 이 파일이 남는다.
  const run = overlayStub({ sha, present: [".factory", ".claude"], added: ["CLAUDE.md", ".claude/hooks/x.sh", ".claude/settings.local.json"], calls });
  const r = await makeFactoryOverlay({ run, root: "/repo", env: { GITHUB_SHA: sha }, defaultBranch: () => "main" })();
  expect(r.ok).toBe(true);
  expect(r.removed).toEqual(["CLAUDE.md", ".claude/hooks/x.sh", ".claude/settings.local.json"]);
  expect(r.paths).toEqual(expect.arrayContaining(["CLAUDE.md", ".claude/hooks/x.sh", ".claude/settings.local.json"]));
  const rm = calls.find((c) => c.startsWith("rm"));
  expect(rm).toContain("CLAUDE.md");
  expect(rm).toContain(".claude/hooks/x.sh");
  // 추가된 파일 스캔은 `present`가 아니라 **전체 pathspec**을 본다 — 스테이지 커밋에 없는 경로야말로
  // PR이 새로 들여온 경로이기 때문이다.
  const scan = calls.find((c) => c.includes("--diff-filter=A"));
  for (const g of SESSION_CONFIG_PATHSPECS) expect(scan, g).toContain(g);
});

test("overlay: fail-closed — extras that cannot be removed stop the stage (review batch-1 MF-3)", async () => {
  const sha = "c".repeat(40);
  const run = overlayStub({ sha, present: [".factory"], added: [".claude/hooks/x.sh"], rmCode: 128 });
  const r = await makeFactoryOverlay({ run, root: "/repo", env: { GITHUB_SHA: sha }, defaultBranch: () => "main" })();
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/could not remove 1 PR-added factory-owned path/);
});

test("overlay: the drift check runs BEFORE `claude -p` — a tree that is still not byte-identical is a refusal (review batch-1 MF-3)", async () => {
  const sha = "c".repeat(40);
  const run = overlayStub({ sha, present: [".factory", ".claude"], drift: [".claude/settings.json"] });
  const r = await makeFactoryOverlay({ run, root: "/repo", env: { GITHUB_SHA: sha }, defaultBranch: () => "main" })();
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/\.claude\/settings\.json/);
});

// ── ADR-023 Task 8b 후속 — `factory:harness` 이슈의 rework는 자기 harness.toml을 지킨다 ──────────
// Task 8b가 체크아웃을 스테이지에게 준 뒤 생긴 회귀: 하네스 이슈의 rework 라운드는 **정의상**
// `.factory/harness.toml`을 고친 브랜치 위에서 돈다(그것이 그 이슈가 하는 일이다). overlay가 그 파일을
// base로 되돌리면 `overlaidPaths`가 비지 않고, implement의 "덮을 것이 있으면 빌더를 띄우지 않는다"
// 규칙이 **모든** 하네스 rework를 막는다 — 승격 자체가 한 라운드 이상 갈 수 없게 된다.
// 그래서 harness 모드에서는 `HARNESS_OPENS`(= L2 deny에서도 열리는 그 목록)를 overlay에서 뺀다:
// 훅·settings·에이전트 프롬프트·CHARTER·세션 설정은 그대로 base의 것이고, 그 파일들의 위험한 섹션은
// L1 섹션 검사(`[protected]`/`[gates.thresholds]`/`[load_bearing]` → 사람 머지)가 계속 지킨다.

const harnessRun = ({ sha, present = OVERLAY_ROOTS, tree = [] } = {}) =>
  makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "ls-tree", result: { code: 0, stdout: `${tree.join("\n")}\n`, stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "cat-file", result: (c, a) => (present.some((p) => a[2] === `${sha}:${p}`) ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "" }) },
    { match: (c, a) => c === "git" && a[0] === "checkout", result: { code: 0, stdout: "", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "status", result: { code: 0, stdout: "", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "diff", result: { code: 0, stdout: "", stderr: "" } },
  ]);

const pathspecArgs = (run, pred) => run.calls.filter(({ cmd, args }) => cmd === "git" && pred(args)).map(({ args }) => args.join(" "));

test("overlay: a factory:harness issue leaves HARNESS_OPENS to the branch — its own harness.toml survives", async () => {
  const sha = "c".repeat(40);
  const run = harnessRun({ sha });
  const r = await makeFactoryOverlay({ run, root: "/repo", env: { GITHUB_SHA: sha }, defaultBranch: () => "main", harnessIssue: true })();
  expect(r.ok).toBe(true);
  expect(r.harnessIssue).toBe(true);
  // 덮는 쪽(checkout)·지우는 쪽(diff --diff-filter=A)·읽는 쪽(status)·증명하는 쪽(drift diff) 넷 다
  // 같은 제외 목록을 들어야 한다 — 하나라도 빠지면 그 자리가 다시 빌더를 막는다.
  const seen = pathspecArgs(run, (a) => ["checkout", "status", "diff"].includes(a[0]));
  expect(seen.length).toBeGreaterThanOrEqual(4);
  for (const line of seen) for (const g of HARNESS_OPENS) expect(line, line).toContain(`:(exclude,glob)${g}`);
  for (const g of HARNESS_OPENS) expect(overlayPathspecs(true)).toContain(`:(exclude,glob)${g}`);
  // 나머지는 그대로 base의 것이다 — 훅도 settings도 에이전트 프롬프트도 열리지 않는다.
  const co = seen.find((l) => l.startsWith("checkout"));
  expect(co).toContain(".claude");
  expect(co).toContain("docs/factory/CHARTER.md");
});

test("overlay: a plain issue overlays harness.toml exactly as before — the carve-out is harness-mode only", async () => {
  const sha = "c".repeat(40);
  const run = harnessRun({ sha });
  const r = await makeFactoryOverlay({ run, root: "/repo", env: { GITHUB_SHA: sha }, defaultBranch: () => "main" })();
  expect(r.ok).toBe(true);
  expect(r.harnessIssue).toBeFalsy();
  for (const line of pathspecArgs(run, (a) => ["checkout", "status", "diff"].includes(a[0]))) expect(line).not.toContain("exclude,glob");
  expect(overlayPathspecs(false)).toEqual(OVERLAY_PATHSPECS);
});

test("overlayDrift: the post-session check honours the same harness carve-out (or it would block every harness rework)", async () => {
  const seen = [];
  const run = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "diff", result: (c, a) => { seen.push(a.join(" ")); return { code: 0, stdout: "", stderr: "" }; } },
    { match: (c, a) => c === "git" && a[0] === "rev-parse", result: { code: 0, stdout: "claude/fq-3\n", stderr: "" } },
  ]);
  await assertStageBranch({ run, cwd: "/repo", issue: 3, sha: "c".repeat(40), harnessIssue: true });
  expect(seen[0]).toContain(":(exclude,glob).factory/harness.toml");
});

test("implement: a harness issue's rework round launches the builder — the branch's harness.toml is not a blocker", async () => {
  let sawHarness = null;
  const claudeP = vi.fn(async () => ({ is_error: false, result: "{}" }));
  const d = overlayDeps({
    checkoutHead: undefined, claudeP, ciSettingsPresent: async () => true,
    issueLabels: async () => ["factory:rework", "factory:harness"],
    overlayFactoryConfig: async (h) => { sawHarness = h; return { ok: true, sha: "b".repeat(40), paths: [], harnessIssue: h }; },
    checkoutBranch: async () => ({ ok: true, branch: "claude/fq-3", base: "origin/claude/fq-3", existed: true }),
    assertStageBranch: async () => ({ ok: true, branch: "claude/fq-3" }),
  });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(0);
  expect(sawHarness).toBe(true);
  expect(claudeP).toHaveBeenCalled();
});

test("implement: a harness issue that edited .claude/hooks/** is still blocked — the carve-out is only HARNESS_OPENS", async () => {
  const claudeP = vi.fn(async () => ({ is_error: false, result: "{}" }));
  const transition = vi.fn(async () => ({ ok: true, to: "factory:blocked" }));
  const d = overlayDeps({
    checkoutHead: undefined, claudeP, transition, ciSettingsPresent: async () => true,
    issueLabels: async () => ["factory:rework", "factory:harness"],
    overlayFactoryConfig: async () => ({ ok: true, sha: "b".repeat(40), paths: [".claude/hooks/x.sh"], harnessIssue: true }),
    checkoutBranch: async () => ({ ok: true, branch: "claude/fq-3", base: "origin/claude/fq-3", existed: true }),
  });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(2);
  expect(claudeP).not.toHaveBeenCalled();
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked" }));
});

test("implement: a plain issue's overlay is asked in plain mode — harness mode is never the default", async () => {
  let sawHarness = "unset";
  const d = overlayDeps({
    checkoutHead: undefined, ciSettingsPresent: async () => true,
    issueLabels: async () => ["factory:planned"],
    overlayFactoryConfig: async (h) => { sawHarness = h; return { ok: true, sha: "b".repeat(40), paths: [] }; },
    checkoutBranch: async () => ({ ok: true, branch: "claude/fq-3", base: "origin/claude/fq-3", existed: true }),
    assertStageBranch: async () => ({ ok: true, branch: "claude/fq-3" }),
  });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(0);
  expect(sawHarness).toBe(false);
});
