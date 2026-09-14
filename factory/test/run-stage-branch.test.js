import { test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runStage, makeCheckoutBranch, assertStageBranch, stageBranch, stageClaudeEnv } from "../bin/run-stage.js";
import { makeFakeRun } from "../lib/exec.js";

/**
 * ── ADR-023 Task 8b — **브랜치 체크아웃은 스테이지의 것이다.** ──────────────────────────────────
 * Task 8(KTB-37)은 스테이지 **시작** 시점의 팩토리 설정을 base의 것으로 고정했지만, implement의
 * rework 라운드는 빌더가 `claude -p` 세션 **안에서** 자기 브랜치(`claude/fq-<issue>`)를 체크아웃했다
 * (커맨드 템플릿이 그렇게 지시했다). 훅 **스크립트**는 호출마다 디스크에서 읽히므로, 그 브랜치가
 * 변조된 `.claude/hooks/*.sh`를 들고 있으면 체크아웃 이후의 모든 Bash 판정이 PR의 훅으로 이뤄진다 —
 * overlay가 깔아 둔 base 설정이 세션 도중에 통째로 갈린다.
 * 그래서 체크아웃을 스테이지가 한다: fetch → checkout → overlay → drift → **그다음에** 빌더.
 */

const SHA = "c".repeat(40);
const BRANCH = "claude/fq-3";

/** implement 브랜치 체크아웃이 부르는 git만 흉내낸다. */
const branchStub = ({
  sha = SHA, onOrigin = true, localRef = null, calls = [],
  lsRemoteCode = 0, fetchCode = 0, checkoutCode = 0, revParseSha = sha,
} = {}) =>
  makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "ls-remote", result: (c, a) => { calls.push(a.join(" ")); return lsRemoteCode === 0 ? { code: 0, stdout: onOrigin ? `${"a".repeat(40)}\trefs/heads/${BRANCH}\n` : "", stderr: "" } : { code: lsRemoteCode, stdout: "", stderr: "fatal: could not read from remote" }; } },
    { match: (c, a) => c === "git" && a[0] === "fetch", result: (c, a) => { calls.push(a.join(" ")); return fetchCode === 0 ? { code: 0, stdout: "", stderr: "" } : { code: fetchCode, stdout: "", stderr: "fatal: couldn't find remote ref" }; } },
    { match: (c, a) => c === "git" && a[0] === "checkout", result: (c, a) => { calls.push(a.join(" ")); return checkoutCode === 0 ? { code: 0, stdout: "", stderr: "" } : { code: checkoutCode, stdout: "", stderr: "error: pathspec did not match" }; } },
    // rev-parse는 두 자리에서 온다: 스테이지 sha 해석(`origin/main`)과 로컬 브랜치 존재 확인.
    { match: (c, a) => c === "git" && a[0] === "rev-parse" && a.includes("--verify"), result: (c, a) => { calls.push(a.join(" ")); return localRef ? { code: 0, stdout: `${localRef}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" }; } },
    { match: (c, a) => c === "git" && a[0] === "rev-parse", result: () => (revParseSha ? { code: 0, stdout: `${revParseSha}\n`, stderr: "" } : { code: 128, stdout: "", stderr: "unknown revision" }) },
  ]);

const checkoutBranch = (run, env = { GITHUB_SHA: SHA }) => makeCheckoutBranch({ run, root: "/repo", issue: 3, env, defaultBranch: () => "main" })();

test("checkoutBranch: a rework round is checked out by the stage from origin — fetch, then checkout -B", async () => {
  const calls = [];
  const run = branchStub({ calls });
  const r = await checkoutBranch(run);
  expect(r.ok).toBe(true);
  expect(r.branch).toBe(BRANCH);
  expect(r.existed).toBe(true);
  expect(calls.find((c) => c.startsWith("fetch"))).toContain(BRANCH);
  const co = calls.find((c) => c.startsWith("checkout"));
  expect(co).toBe(`checkout -B ${BRANCH} origin/${BRANCH}`);
  // fetch가 checkout보다 먼저다 — 원격 tip을 모르고 -B하면 지난 라운드 위에 선다.
  expect(calls.findIndex((c) => c.startsWith("fetch"))).toBeLessThan(calls.findIndex((c) => c.startsWith("checkout")));
});

test("checkoutBranch: the first round creates the branch from the stage's own commit, not from the PR", async () => {
  const calls = [];
  const run = branchStub({ calls, onOrigin: false });
  const r = await checkoutBranch(run);
  expect(r.ok).toBe(true);
  expect(r.existed).toBe(false);
  expect(calls.find((c) => c.startsWith("checkout"))).toBe(`checkout -b ${BRANCH} ${SHA}`);
  expect(calls.some((c) => c.startsWith("fetch"))).toBe(false);
});

test("checkoutBranch: fail closed — ls-remote/fetch/checkout failing, and an unresolvable stage sha", async () => {
  expect((await checkoutBranch(branchStub({ lsRemoteCode: 128 }))).reason).toMatch(/ls-remote/);
  expect((await checkoutBranch(branchStub({ fetchCode: 128 }))).reason).toMatch(/fetch/);
  expect((await checkoutBranch(branchStub({ checkoutCode: 1 }))).reason).toMatch(/checkout/);
  const noSha = await checkoutBranch(branchStub({ revParseSha: null }), {});
  expect(noSha.ok).toBe(false);
  expect(noSha.reason).toMatch(/stage sha/);
});

test("checkoutBranch: a local-only branch is never reset — unpushed work is a person's call", async () => {
  const r = await checkoutBranch(branchStub({ onOrigin: false, localRef: "d".repeat(40) }));
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/exists locally/);
  expect(r.reason).toContain(BRANCH);
});

// ── 세션 뒤: HEAD가 아직 그 브랜치인가 ────────────────────────────────────────────────────────
const headStub = ({ head = BRANCH, headCode = 0, drift = [], driftCode = 0 } = {}) =>
  makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "rev-parse", result: () => (headCode === 0 ? { code: 0, stdout: `${head}\n`, stderr: "" } : { code: 128, stdout: "", stderr: "fatal: ambiguous argument" }) },
    { match: (c, a) => c === "git" && a[0] === "diff", result: () => (driftCode === 0 ? { code: 0, stdout: drift.join("\n"), stderr: "" } : { code: 128, stdout: "", stderr: "fatal: bad object" }) },
  ]);

test("assertStageBranch: HEAD still on the stage's branch with no config drift is the only pass", async () => {
  const ok = await assertStageBranch({ run: headStub(), cwd: "/repo", issue: 3, sha: SHA });
  expect(ok).toEqual({ ok: true, branch: BRANCH });
});

test("assertStageBranch: a session that switched branches is caught after the fact (fail closed)", async () => {
  const moved = await assertStageBranch({ run: headStub({ head: "main" }), cwd: "/repo", issue: 3, sha: SHA });
  expect(moved.ok).toBe(false);
  expect(moved.reason).toMatch(/main/);
  expect(moved.reason).toContain(BRANCH);
  // detach도 같다 — `HEAD`는 브랜치 이름이 아니다.
  expect((await assertStageBranch({ run: headStub({ head: "HEAD" }), cwd: "/repo", issue: 3, sha: SHA })).ok).toBe(false);
  // rev-parse 자체가 실패하면 "그대로다"를 증명할 수 없다.
  const broken = await assertStageBranch({ run: headStub({ headCode: 128 }), cwd: "/repo", issue: 3, sha: SHA });
  expect(broken.ok).toBe(false);
  expect(broken.reason).toMatch(/fatal/);
});

test("assertStageBranch: the overlay drift check runs again after the session", async () => {
  const drifted = await assertStageBranch({ run: headStub({ drift: [".claude/hooks/block-dangerous.sh"] }), cwd: "/repo", issue: 3, sha: SHA });
  expect(drifted.ok).toBe(false);
  expect(drifted.reason).toMatch(/block-dangerous\.sh/);
  const undecidable = await assertStageBranch({ run: headStub({ driftCode: 128 }), cwd: "/repo", issue: 3, sha: SHA });
  expect(undecidable.ok).toBe(false);
  // sha가 없으면(overlay가 돌지 않은 경로) 브랜치만 본다 — 없는 근거로 런을 죽이지 않는다.
  expect((await assertStageBranch({ run: headStub({ driftCode: 128 }), cwd: "/repo", issue: 3, sha: null })).ok).toBe(true);
});

// ── runStage 배선 ────────────────────────────────────────────────────────────────────────────

const implDeps = (over = {}) => ({
  charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }),
  heartbeat: async () => ({ stop() {} }), assertHandoff: async () => ({ ok: true }),
  buildContext: async () => ({ roster: [], orchestration: "workflow", limits: { K: 3 } }),
  resetAgentsLog: async () => {}, claudeP: async () => ({ is_error: false, result: "{}" }), gates: async () => null,
  verifyStage: () => ({ ok: true, reasons: [], data: {} }), writeHandoff: async () => {},
  transition: async () => ({ ok: true, to: "factory:awaiting-review" }), runRecord: () => {}, release: async () => true,
  checkoutBranch: async () => ({ ok: true, branch: BRANCH, base: `origin/${BRANCH}`, existed: true }),
  overlayFactoryConfig: async () => ({ ok: true, sha: "b".repeat(40), paths: [] }),
  assertStageBranch: async () => ({ ok: true, branch: BRANCH }),
  ciSettingsPresent: async () => true,
  ...over,
});

test("implement: the stage checks out the branch BEFORE the overlay and the builder — order is the whole fix", async () => {
  const calls = [];
  const lines = [];
  const d = implDeps({
    checkoutBranch: async () => { calls.push("branch"); return { ok: true, branch: BRANCH, base: `origin/${BRANCH}`, existed: true }; },
    overlayFactoryConfig: async () => { calls.push("overlay"); return { ok: true, sha: "b".repeat(40), paths: [] }; },
    claudeP: async () => { calls.push("claude"); return { is_error: false, result: "{}" }; },
    assertStageBranch: async () => { calls.push("assert-branch"); return { ok: true, branch: BRANCH }; },
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(0);
  expect(calls).toEqual(["branch", "overlay", "claude", "assert-branch"]);
  const line = lines.find((l) => l.startsWith("branch:"));
  expect(line).toContain(BRANCH);
  expect(line).toContain(`origin/${BRANCH}`);
});

test("implement: the branch checkout failing stops the stage — the builder never picks its own tree", async () => {
  const claudeP = vi.fn(async () => ({ is_error: false, result: "{}" }));
  const transition = vi.fn(async () => ({ ok: true, to: "factory:blocked" }));
  const lines = [];
  const d = implDeps({
    checkoutBranch: async () => ({ ok: false, reason: "git fetch failed: fatal: couldn't find remote ref" }),
    claudeP, transition, runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(2);
  expect(claudeP).not.toHaveBeenCalled();
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked" }));
  expect(lines.some((l) => /branch: FAIL/.test(l))).toBe(true);
});

test("implement: a session that left the branch is undecidable — blocked, and the artifact is not accepted", async () => {
  const gates = vi.fn(async () => null);
  const verifyStage = vi.fn(() => ({ ok: true, reasons: [], data: {} }));
  const transition = vi.fn(async () => ({ ok: true, to: "factory:blocked" }));
  const lines = [];
  const d = implDeps({
    assertStageBranch: async () => ({ ok: false, reason: `HEAD is main, not ${BRANCH}` }),
    gates, verifyStage, transition, runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(2);
  expect(gates).not.toHaveBeenCalled();
  expect(verifyStage).not.toHaveBeenCalled();
  const t = transition.mock.calls.at(-1)[0];
  expect(t.to).toBe("factory:blocked");
  expect(t.reason).toMatch(/undecidable/);
  expect(lines.some((l) => /branch: FAIL/.test(l))).toBe(true);
});

test("review/merge never run the branch checkout — they judge a fixed head, they do not own a branch", async () => {
  const checkoutBranch = vi.fn(async () => ({ ok: true, branch: BRANCH }));
  const d = implDeps({
    checkoutBranch,
    checkoutHead: async () => ({ ok: true, sha: "a".repeat(40), pr: 3 }),
    assertCleanWorktree: async () => ({ ok: true, dirty: [] }),
    transition: async () => ({ ok: true, to: "factory:approved" }),
  });
  await runStage({ stage: "review", issue: 3, deps: d });
  expect(checkoutBranch).not.toHaveBeenCalled();
});

test("stageClaudeEnv marks the stage session — the hook needs to know it is not a person's own session", () => {
  expect(stageClaudeEnv({ root: "/repo" }).FACTORY_STAGE).toBeTruthy();
  expect(stageBranch(42)).toBe("claude/fq-42");
});

// ── 프롬프트: 빌더에게 체크아웃을 시키던 문장이 남아 있으면 구멍도 남아 있다 ─────────────────────
test("the builder's prompt and command template no longer tell it to check out anything", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const files = [
    "templates/factory/claude/workflows/factory-implement.js",
    "templates/factory/claude/commands/factory-implement.md",
    "templates/factory/claude/agents/factory-builder.md",
  ];
  for (const f of files) {
    const text = readFileSync(root + f, "utf8");
    // 예전 규칙 1의 문장("create it if it does not exist, otherwise check it out")은 사라져야 한다.
    expect(text, f).not.toMatch(/check it out/i);
    // 그리고 남아 있는 `git checkout|switch|fetch` 언급은 전부 **금지문**이어야 한다 — 지시문이 아니라.
    for (const m of text.matchAll(/git\s+(checkout|switch|fetch)/g)) {
      const around = text.slice(Math.max(0, m.index - 300), m.index + 300);
      expect(around, `${f}: ${m[0]}`).toMatch(/never|막는다|옮긴다/i);
    }
  }
  // 그 자리에는 사실이 들어간다: 빌더는 이미 브랜치 위에 있다.
  const wf = readFileSync(root + "templates/factory/claude/workflows/factory-implement.js", "utf8");
  expect(wf).toMatch(/already on/i);
  expect(wf).toContain("claude/fq-${issue}");
});
