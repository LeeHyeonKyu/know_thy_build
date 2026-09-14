import { test, expect, vi } from "vitest";
import { runStage, makeFactoryOverlay, resolveStageSha, overlayDrift, assertNoWriteStageClean, OVERLAY_PATHSPECS, OVERLAY_ROOTS, OVERLAY_LABEL } from "../bin/run-stage.js";
import { makeFakeRun } from "../lib/exec.js";

/**
 * KTB-37 — 스테이지는 PR의 **코드**를 돌지만 팩토리 자신의 **설정**은 base(스테이지 자신의 커밋)의 것이어야 한다.
 * 아래 스텁은 `git` 호출만 흉내낸다: cat-file(존재 확인) → checkout(덮어쓰기) → status(무엇이 덮였나).
 */
const gitStub = ({ sha = "b".repeat(40), present = OVERLAY_ROOTS, checkoutCode = 0, statusOut = "", revParse = null, calls = [] } = {}) =>
  makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "rev-parse", result: () => (revParse === null ? { code: 128, stdout: "", stderr: "unknown revision" } : { code: 0, stdout: `${revParse}\n`, stderr: "" }) },
    { match: (c, a) => c === "git" && a[0] === "cat-file", result: (c, a) => { calls.push(a.join(" ")); return present.some((p) => a[2] === `${sha}:${p}`) ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "not found" }; } },
    { match: (c, a) => c === "git" && a[0] === "checkout", result: (c, a) => { calls.push(a.join(" ")); return checkoutCode === 0 ? { code: 0, stdout: "", stderr: "" } : { code: checkoutCode, stdout: "", stderr: "error: pathspec did not match" }; } },
    { match: (c, a) => c === "git" && a[0] === "status", result: { code: 0, stdout: statusOut, stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "diff", result: { code: 0, stdout: "", stderr: "" } },
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
