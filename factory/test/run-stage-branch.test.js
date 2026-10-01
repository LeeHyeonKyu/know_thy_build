import { test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runStage, makeCheckoutBranch, assertStageBranch, stageBranch, stageClaudeEnv, baseMergedLine } from "../bin/run-stage.js";
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
  // KTB-38 — 기존 브랜치에 base를 머지한다: 이미 base를 들고 있는가(`merge-base --is-ancestor`),
  // 머지가 붙는가, 그리고 그 머지 커밋이 빌더 전에 push되는가.
  ancestorCode = 1, mergeCode = 0, abortCode = 0, pushCode = 0,
} = {}) =>
  makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "ls-remote", result: (c, a) => { calls.push(a.join(" ")); return lsRemoteCode === 0 ? { code: 0, stdout: onOrigin ? `${"a".repeat(40)}\trefs/heads/${BRANCH}\n` : "", stderr: "" } : { code: lsRemoteCode, stdout: "", stderr: "fatal: could not read from remote" }; } },
    { match: (c, a) => c === "git" && a[0] === "fetch", result: (c, a) => { calls.push(a.join(" ")); return fetchCode === 0 ? { code: 0, stdout: "", stderr: "" } : { code: fetchCode, stdout: "", stderr: "fatal: couldn't find remote ref" }; } },
    { match: (c, a) => c === "git" && a[0] === "checkout", result: (c, a) => { calls.push(a.join(" ")); return checkoutCode === 0 ? { code: 0, stdout: "", stderr: "" } : { code: checkoutCode, stdout: "", stderr: "error: pathspec did not match" }; } },
    { match: (c, a) => c === "git" && a.includes("merge-base"), result: (c, a) => { calls.push(a.join(" ")); return { code: ancestorCode, stdout: "", stderr: ancestorCode > 1 ? "fatal: Not a valid object name" : "" }; } },
    { match: (c, a) => c === "git" && a.includes("merge") && a.includes("--abort"), result: (c, a) => { calls.push(a.join(" ")); return { code: abortCode, stdout: "", stderr: "" }; } },
    { match: (c, a) => c === "git" && a.includes("merge"), result: (c, a) => { calls.push(a.join(" ")); return mergeCode === 0 ? { code: 0, stdout: "Merge made by the 'ort' strategy.\n", stderr: "" } : { code: mergeCode, stdout: "CONFLICT (content): Merge conflict in factory/bin/lint.js\n", stderr: "Automatic merge failed" }; } },
    { match: (c, a) => c === "git" && a[0] === "push", result: (c, a) => { calls.push(a.join(" ")); return pushCode === 0 ? { code: 0, stdout: "", stderr: "" } : { code: pushCode, stdout: "", stderr: "! [rejected] non-fast-forward" }; } },
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

// ── KTB-38 — 낡은 PR 위에서 도는 rework는 base의 도구를 들고 돌아야 한다 ────────────────────────
// 실측(KTB #3 R5): PR #4의 head는 1.2.0 이전이라 `factory/bin/lint.js`가 없었는데, overlay가 깔아 준
// base의 `harness.toml`은 그 파일을 부르는 lint 명령을 들고 있었다 — 게이트가 통째로 RED였고 빌더는
// 자기가 고칠 수 없는 실패를 계속 봤다. 그래서 스테이지가 rework 라운드 **전에** base를 머지한다.

test("checkoutBranch: an existing branch gets base merged in before the builder, and the merge commit is pushed", async () => {
  const calls = [];
  const r = await checkoutBranch(branchStub({ calls }));
  expect(r.ok).toBe(true);
  expect(r.merged).toBe(SHA);
  const merge = calls.find((c) => c.includes("merge ") || c.startsWith("merge"));
  expect(calls.some((c) => c.includes("merge --no-edit --no-ff") && c.includes(SHA))).toBe(true);
  expect(merge).toBeTruthy();
  // 머지는 체크아웃 뒤, push는 머지 뒤 — 빌더가 뜨기 전에 PR head가 그 커밋을 반영해야 한다.
  const i = (p) => calls.findIndex((c) => c.includes(p));
  expect(i("checkout -B")).toBeLessThan(i("merge --no-edit"));
  expect(i("merge --no-edit")).toBeLessThan(i(`push origin ${BRANCH}`));
  expect(calls.some((c) => c === `push origin ${BRANCH}`)).toBe(true);
});

test("checkoutBranch: the merge commit is the factory's, not the last human's", async () => {
  const run = branchStub();
  await makeCheckoutBranch({ run, root: "/repo", issue: 3, env: { GITHUB_SHA: SHA, FACTORY_BOT_LOGIN: "fq-bot" }, defaultBranch: () => "main" })();
  const merge = run.calls.find(({ args }) => args.includes("merge") && args.includes("--no-ff"));
  expect(merge.args).toContain("user.name=factory");
  expect(merge.args.some((a) => /^user\.email=fq-bot@/.test(a))).toBe(true);
});

test("checkoutBranch: a branch that already carries base is merged again for nothing — no merge, no push", async () => {
  const calls = [];
  const r = await checkoutBranch(branchStub({ calls, ancestorCode: 0 }));
  expect(r.ok).toBe(true);
  expect(r.merged).toBe(null);
  expect(calls.some((c) => c.includes("merge --no-edit"))).toBe(false);
  expect(calls.some((c) => c.startsWith("push"))).toBe(false);
});

test("checkoutBranch: the first round never merges — the branch is created from base itself", async () => {
  const calls = [];
  const r = await checkoutBranch(branchStub({ calls, onOrigin: false }));
  expect(r.ok).toBe(true);
  expect(r.existed).toBe(false);
  expect(r.merged).toBeFalsy();
  expect(calls.some((c) => c.includes("merge"))).toBe(false);
  expect(calls.some((c) => c.startsWith("push"))).toBe(false);
});

test("checkoutBranch: a conflict aborts the merge and is undecidable — a person rebases", async () => {
  const calls = [];
  const r = await checkoutBranch(branchStub({ calls, mergeCode: 1 }));
  expect(r.ok).toBe(false);
  expect(r.undecidable).toBe(true);
  expect(r.reason).toMatch(/stale PR conflicts with base — rebase by hand/);
  expect(calls.some((c) => c.includes("merge --abort"))).toBe(true);
  // 충돌난 트리를 그대로 두고 빌더를 띄우지 않는다 — push도 하지 않는다.
  expect(calls.some((c) => c.startsWith("push"))).toBe(false);
});

test("checkoutBranch: fail closed — the push failing, and an unreadable ancestry", async () => {
  expect((await checkoutBranch(branchStub({ pushCode: 1 }))).reason).toMatch(/push/);
  const bad = await checkoutBranch(branchStub({ ancestorCode: 128 }));
  expect(bad.ok).toBe(false);
  expect(bad.reason).toMatch(/already carries|merge-base/);
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

test("implement: a stale PR that conflicts with base is blocked as undecidable — a person rebases (KTB-38)", async () => {
  const claudeP = vi.fn(async () => ({ is_error: false, result: "{}" }));
  const transition = vi.fn(async () => ({ ok: true, to: "factory:blocked" }));
  const d = implDeps({
    checkoutBranch: async () => ({ ok: false, undecidable: true, reason: "stale PR conflicts with base — rebase by hand (merging ccccccc into claude/fq-3 failed, merge aborted)" }),
    claudeP, transition,
  });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(2);
  expect(claudeP).not.toHaveBeenCalled();
  const t = transition.mock.calls.at(-1)[0];
  expect(t.to).toBe("factory:blocked");
  expect(t.cause).toBe("undecidable");
  expect(t.reason).toMatch(/stale PR conflicts with base/);
});

test("implement: the run record says which base commit was merged into the PR branch (KTB-38)", async () => {
  const lines = [];
  const d = implDeps({
    checkoutBranch: async () => ({ ok: true, branch: BRANCH, base: `origin/${BRANCH}`, existed: true, merged: SHA, source: "GITHUB_SHA" }),
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(0);
  const line = lines.find((l) => l.startsWith("base_merged:"));
  expect(line).toContain(SHA.slice(0, 7));
  // 머지가 없었던 라운드는 그 줄을 만들지 않는다 — 없는 사실을 기록하지 않는다.
  const quiet = [];
  await runStage({ stage: "implement", issue: 3, deps: implDeps({ runRecord: (l) => quiet.push(...l) }) });
  expect(quiet.some((l) => l.startsWith("base_merged:"))).toBe(false);
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

/**
 * 설계 2026-09-30 §8.3 (S3, KTB #130 실측) — 브랜치의 러너 미러 커밋과 base의 미러 변경이 같은 생성 파일에서 충돌했다. 생성 파일의
 * 충돌은 사람이 풀 것이 아니라 병합된 소스에서 다시 만드는 것이다. 충돌이 미러 가족에만 있고 이 저장소가 KTB 자신일 때만 그렇게
 * 풀고, 소스가 충돌했으면 예전처럼 abort한다.
 */
import { mkdtempSync as _mkd, mkdirSync as _mk, writeFileSync as _wr, rmSync as _rm } from "node:fs";
import { tmpdir as _tmp } from "node:os";
import { join as _j } from "node:path";
const selfRepo = () => {
  const root = _mkd(_j(_tmp(), "ktb-self-"));
  _mk(_j(root, "factory/cli"), { recursive: true }); _mk(_j(root, ".factory"), { recursive: true });
  for (const f of ["manifest.js", "install.js"]) _wr(_j(root, "factory/cli", f), "// stub\n");
  return root;
};
const conflictStub = ({ calls, conflicted, mergeCode = 1 }) => {
  const base = branchStub({ calls, mergeCode });
  return async (cmd, args, opts) => {
    const key = `${cmd} ${args.join(" ")}`;
    if (cmd === "git" && args[0] === "diff" && args.includes("--diff-filter=U")) { calls.push(args.join(" ")); return { code: 0, stdout: conflicted.join("\n") + "\n", stderr: "" }; }
    if (cmd === "git" && args[0] === "checkout" && args[1] === SHA && args[2] === "--") { calls.push(args.join(" ")); return { code: 0, stdout: "", stderr: "" }; }
    if (cmd === "git" && args[0] === "add") { calls.push(args.join(" ")); return { code: 0, stdout: "", stderr: "" }; }
    if (cmd === "git" && args.includes("commit") && args.includes("--no-edit")) { calls.push(args.join(" ")); return { code: 0, stdout: "", stderr: "" }; }
    return base(cmd, args, opts);
  };
};

test("checkoutBranch: conflicts confined to the mirror families are resolved by regenerating from the merged sources — no abort, merge commit pushed", async () => {
  const root = selfRepo();
  try {
    const calls = []; const regenerate = vi.fn(async () => ({ ok: true, applicable: true, changed: [".factory/bin/run-stage.js", ".factory/lib/gates.js"] }));
    const run = conflictStub({ calls, conflicted: [".factory/bin/run-stage.js", ".factory/lib/gates.js"] });
    const r = await makeCheckoutBranch({ run, root, issue: 3, env: { GITHUB_SHA: SHA }, defaultBranch: () => "main", regenerate })();
    expect(r.ok).toBe(true);
    expect(r.merged).toBe(SHA);
    expect(r.mirrorResolved).toEqual({ conflicted: [".factory/bin/run-stage.js", ".factory/lib/gates.js"], regenerated: [".factory/bin/run-stage.js", ".factory/lib/gates.js"] });
    expect(regenerate).toHaveBeenCalledWith({ root });
    expect(calls.some((c) => c.includes("merge --abort"))).toBe(false);
    expect(calls.some((c) => c.startsWith(`checkout ${SHA} -- .factory/bin/run-stage.js`))).toBe(true);
    expect(calls.some((c) => c.startsWith("add -- .factory/lib .factory/bin .factory/actions .claude/hooks .factory/install-manifest.json"))).toBe(true);
    expect(calls.some((c) => /commit --no-edit/.test(c))).toBe(true);
    expect(calls.some((c) => c.startsWith("push"))).toBe(true);
    expect(baseMergedLine({ ...r, branch: BRANCH })).toMatch(/conflicts in 2 runner-generated mirror path\(s\) resolved by regenerating/);
  } finally { _rm(root, { recursive: true, force: true }); }
});

// #143 rescope: a source conflict alone is now left to the builder (test_143_source_conflict_is_left_to_the_builder). What still
// aborts is a conflict under an overlay root the builder cannot write — here a non-mirror `.factory/**` path next to the source one.
test("checkoutBranch: a conflict under a factory-owned overlay root (non-mirror .factory/**) is still aborted and undecidable, even next to a source conflict", async () => {
  const root = selfRepo();
  try {
    const calls = []; const regenerate = vi.fn();
    const run = conflictStub({ calls, conflicted: [".factory/lib/gates.js", ".factory/harness.toml", "factory/lib/gates.js"] });
    const r = await makeCheckoutBranch({ run, root, issue: 3, env: { GITHUB_SHA: SHA }, defaultBranch: () => "main", regenerate })();
    expect(r.ok).toBe(false);
    expect(r.undecidable).toBe(true);
    expect(regenerate).not.toHaveBeenCalled();
    expect(calls.some((c) => c.includes("merge --abort"))).toBe(true);
    expect(calls.some((c) => c.startsWith("push"))).toBe(false);
  } finally { _rm(root, { recursive: true, force: true }); }
});

test("checkoutBranch: in an adopter repo (no engine sources) a mirror-path conflict is aborted as before", async () => {
  const calls = []; const regenerate = vi.fn();
  const run = conflictStub({ calls, conflicted: [".factory/lib/gates.js"] });
  const r = await makeCheckoutBranch({ run, root: "/repo", issue: 3, env: { GITHUB_SHA: SHA }, defaultBranch: () => "main", regenerate })();
  expect(r.ok).toBe(false);
  expect(regenerate).not.toHaveBeenCalled();
  expect(calls.some((c) => c.includes("merge --abort"))).toBe(true);
});

/**
 * 1.4.39 (KTB #136 실측) — `docs/factory/DECISIONS.md`는 추가 전용이라 브랜치와 base가 함께 움직이면 반드시 충돌한다. 양쪽을 다 남기는
 * 합집합 병합이 언제나 옳다(`git merge-file --union`). 미러 가족과 섞여 충돌해도 함께 푼다; 그 밖의 소스가 충돌하면 여전히 abort.
 */
test("checkoutBranch: an append-only file (DECISIONS.md) conflicting alongside mirror paths is union-merged, not handed to a person", async () => {
  const root = selfRepo();
  try {
    _mk(_j(root, ".factory/out"), { recursive: true }); _mk(_j(root, "docs/factory"), { recursive: true });
    _wr(_j(root, "docs/factory/DECISIONS.md"), "<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n");
    const calls = []; const regenerate = vi.fn(async () => ({ ok: true, applicable: true, changed: [".factory/lib/gates.js"] }));
    const base = conflictStub({ calls, conflicted: [".factory/lib/gates.js", "docs/factory/DECISIONS.md"] });
    const run = async (cmd, args, opts) => {
      if (cmd === "git" && args[0] === "show" && /^:[123]:docs\/factory\/DECISIONS\.md$/.test(args[1])) { calls.push(args.join(" ")); return { code: 0, stdout: ({ "1": "base\n", "2": "base\nours\n", "3": "base\ntheirs\n" })[args[1][1]], stderr: "" }; }
      if (cmd === "git" && args[0] === "merge-file") { calls.push(args.slice(0, 3).join(" ")); return { code: 0, stdout: "base\nours\ntheirs\n", stderr: "" }; }
      return base(cmd, args, opts);
    };
    const r = await makeCheckoutBranch({ run, root, issue: 3, env: { GITHUB_SHA: SHA }, defaultBranch: () => "main", regenerate })();
    expect(r.ok).toBe(true);
    expect(r.mirrorResolved.conflicted).toEqual([".factory/lib/gates.js", "docs/factory/DECISIONS.md"]);
    expect(calls.some((c) => c.startsWith("merge-file -p --union"))).toBe(true);
    expect(readFileSync(_j(root, "docs/factory/DECISIONS.md"), "utf8")).toBe("base\nours\ntheirs\n");
    expect(calls.some((c) => c === "add -- docs/factory/DECISIONS.md")).toBe(true);
    expect(calls.some((c) => c.includes("merge --abort"))).toBe(false);
  } finally { _rm(root, { recursive: true, force: true }); }
});

/**
 * ── #143 (S3b) — **소스 충돌은 같은 implement 런 안에서 빌더의 일이다.** ──────────────────────────────
 * 엔진 이슈가 공장에서 도는 동안 엔진 릴리스가 나가면 소스가 겹친다(#130은 세 릴리스와 겹쳐 재시작했다 — $45 중 절반).
 * 미러 가족은 base 것을 받고(재생성은 세션 뒤 미러 단계가 병합된 소스로 한다), 추가 전용 파일은 합집합으로 풀고, 남은 소스 충돌은
 * 마커가 든 채로 빌더에게 넘긴다. 세션 뒤 병합이 끝나지 않았으면(MERGE_HEAD, abort, 커밋된 마커) 판정 불가다.
 * 픽스처는 진짜 두 갈래 git 저장소다(CLAUDE.md SDD 5: 실제 생산자로) — `conflictStub`의 stdout 흉내로는 인덱스 상태를 증명하지 못한다.
 */
import { run as realRun } from "../lib/exec.js";
import { makeFactoryOverlay, branchOwnFactoryPaths, assertBaseMergeComplete, baseMergeConflictLine } from "../bin/run-stage.js";
import { dirname as _dn } from "node:path";
import { existsSync as _ex } from "node:fs";

const BR143 = "claude/fq-143";
const git143 = async (cwd, ...args) => {
  const r = await realRun("git", args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};
/**
 * origin(bare) + 작업 사본. main의 시드 → 브랜치 `claude/fq-143`(빌더의 지난 라운드: 소스 + 러너의 미러 커밋 + DECISIONS 항목)
 * → main이 앞으로 간다(엔진 릴리스: 같은 소스·같은 미러·DECISIONS 항목·충돌하지 않는 `.claude/settings.json`).
 */
async function overlapRepo({ engine = true, conflictSource = true, clean = false, baseTouchesClaude = true, branchEditsAgent = false, conflictUnder = null, branchMirror = "gen a\ngen branch\ngen c\n" } = {}) {
  const top = _mkd(_j(_tmp(), "ktb-143-"));
  const origin = _j(top, "origin.git"), root = _j(top, "work");
  await git143(top, "init", "-q", "--bare", "-b", "main", origin);
  await git143(top, "init", "-q", "-b", "main", root);
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"], ["merge.conflictstyle", "merge"]]) await git143(root, "config", k, v);
  await git143(root, "remote", "add", "origin", origin);
  const w = (p, t) => { _mk(_dn(_j(root, p)), { recursive: true }); _wr(_j(root, p), t); };
  const commit = async (m) => { await git143(root, "add", "-A"); await git143(root, "commit", "-q", "-m", m); };
  if (engine) { w("factory/cli/manifest.js", "// stub\n"); w("factory/cli/install.js", "// stub\n"); }
  w("factory/lib/x.js", "a\nb\nc\n");
  w(".factory/lib/x.js", "gen a\ngen b\ngen c\n");
  w(".factory/harness.toml", "x = 1\n");
  w(".claude/settings.json", "{}\n");
  w(".claude/agents/a.md", "agent\n");
  w("docs/factory/DECISIONS.md", "# D\n\nseed\n");
  w("docs/factory/CHARTER.md", "charter\n");
  await commit("seed");
  await git143(root, "push", "-q", "origin", "main");
  await git143(root, "checkout", "-q", "-b", BR143);
  if (clean) w("factory/lib/y.js", "branch only\n");
  else {
    if (conflictSource) w("factory/lib/x.js", "a\nbranch\nc\n");
    w(".factory/lib/x.js", branchMirror);
    w("docs/factory/DECISIONS.md", "# D\n\nseed\n\nbranch entry\n");
  }
  if (branchEditsAgent) w(".claude/agents/a.md", "branch edit\n");
  if (conflictUnder) w(conflictUnder, "branch side\n");
  await commit("branch round 1");
  await git143(root, "push", "-q", "origin", BR143);
  await git143(root, "checkout", "-q", "main");
  if (conflictSource) w("factory/lib/x.js", "a\nbase\nc\n");
  w(".factory/lib/x.js", "gen a\ngen base\ngen c\n");
  w("docs/factory/DECISIONS.md", "# D\n\nseed\n\nbase entry\n");
  if (baseTouchesClaude) w(".claude/settings.json", "{ \"base\": 1 }\n");
  if (conflictUnder) w(conflictUnder, "base side\n");
  await commit("engine release");
  await git143(root, "push", "-q", "origin", "main");
  const baseSha = await git143(root, "rev-parse", "HEAD");
  return { top, root, baseSha, done: () => _rm(top, { recursive: true, force: true }) };
}
/** 실제 git을 돌리면서 무엇을 불렀는지 남긴다. */
const spyRun = (calls) => async (cmd, args, opts) => { if (cmd === "git") calls.push(args.join(" ")); return realRun(cmd, args, opts); };
const committed = (calls) => calls.some((c) => /(^| )commit( |$)/.test(c));
const pushed = (calls) => calls.some((c) => /^push( |$)/.test(c));
const aborted = (calls) => calls.some((c) => c.includes("merge --abort"));
const mergeHead = async (root) => (await realRun("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: root })).code === 0;
const checkout143 = ({ run, root, baseSha, regenerate }) => makeCheckoutBranch({ run, root, issue: 143, env: { GITHUB_SHA: baseSha }, defaultBranch: () => "main", regenerate })();
const read = (root, p) => readFileSync(_j(root, p), "utf8");

test("test_143_source_conflict_is_left_to_the_builder", async () => {
  const fx = await overlapRepo();
  try {
    const calls = []; const regenerate = vi.fn(async () => ({ ok: true, applicable: true, changed: [] }));
    const r = await checkout143({ run: spyRun(calls), root: fx.root, baseSha: fx.baseSha, regenerate });
    // 소스 충돌은 abort되지 않고 빌더에게 간다 — 그 경로만, 정확히.
    expect(r.ok).toBe(true);
    expect(r.merged).toBe(fx.baseSha);
    expect(r.conflicts).toEqual(["factory/lib/x.js"]);
    expect(aborted(calls)).toBe(false);
    // 트리는 병합 중이다: MERGE_HEAD가 있고, 소스에는 마커가 있다.
    expect(await mergeHead(fx.root)).toBe(true);
    expect(read(fx.root, "factory/lib/x.js")).toMatch(/^<<<<<<< /m);
    // 미러 경로는 base의 것을 받았고(재생성은 하지 않는다 — 소스에 아직 마커가 있다), DECISIONS.md는 양쪽을 다 남겼다.
    expect(read(fx.root, ".factory/lib/x.js")).toBe("gen a\ngen base\ngen c\n");
    const decisions = read(fx.root, "docs/factory/DECISIONS.md");
    expect(decisions).toContain("branch entry");
    expect(decisions).toContain("base entry");
    expect(decisions).not.toMatch(/^(<{7}|>{7})/m);
    expect(await git143(fx.root, "diff", "--name-only", "--diff-filter=U")).toBe("factory/lib/x.js");
    expect(regenerate).toHaveBeenCalledTimes(0);
    // 반쯤 병합된 것은 커밋도 push도 되지 않는다.
    expect(committed(calls)).toBe(false);
    expect(pushed(calls)).toBe(false);
    expect(await git143(fx.root, "rev-parse", `origin/${BR143}`)).toBe(await git143(fx.root, "rev-parse", "HEAD"));
    // run 기록: 경로·sha·출처를 말하고, push했다고 주장하지 않는다.
    const lines = [];
    const d = implDeps({ checkoutBranch: async () => r, baseMergeComplete: async () => ({ ok: true }), runRecord: (l) => lines.push(...l) });
    expect(await runStage({ stage: "implement", issue: 143, deps: d })).toBe(0);
    const line = lines.find((l) => l.startsWith("base_merge:"));
    expect(line).toMatch(/^base_merge: 1 conflicted source path\(s\) left to the builder: factory\/lib\/x\.js/);
    expect(line).toContain(fx.baseSha.slice(0, 7));
    expect(line).toContain("GITHUB_SHA");
    expect(lines.some((l) => /pushed before the builder/.test(l))).toBe(false);
    expect(lines.some((l) => l.startsWith("base_merged:"))).toBe(false);
    expect(line).toBe(baseMergeConflictLine(r));
  } finally { fx.done(); }
  // 충돌이 없는 라운드는 오늘의 base_merged 줄 그대로다(병합 커밋이 push된다).
  const ok = await overlapRepo({ clean: true });
  try {
    const calls = [];
    const r = await checkout143({ run: spyRun(calls), root: ok.root, baseSha: ok.baseSha, regenerate: vi.fn() });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toBeUndefined();
    expect(pushed(calls)).toBe(true);
    expect(await mergeHead(ok.root)).toBe(false);
    const lines = [];
    await runStage({ stage: "implement", issue: 143, deps: implDeps({ checkoutBranch: async () => r, runRecord: (l) => lines.push(...l) }) });
    expect(lines.find((l) => l.startsWith("base_merged:"))).toBe(`base_merged: ${ok.baseSha.slice(0, 7)} (GITHUB_SHA) merged into ${BR143} by the stage and pushed before the builder — the PR tree carries base's tooling`);
    expect(lines.some((l) => l.startsWith("base_merge:"))).toBe(false);
  } finally { ok.done(); }
});

/** 실제 체크아웃 + 실제 overlay + 실제 브랜치 경로 계산으로 runStage를 돌린다. 빌더(claudeP)는 주입한다. */
const realImplDeps = ({ fx, claudeP, transition, lines, over = {} }) => {
  const run = realRun;
  return implDeps({
    checkoutBranch: () => checkout143({ run, root: fx.root, baseSha: fx.baseSha, regenerate: vi.fn(async () => ({ ok: true, applicable: true, changed: [] })) }),
    overlayFactoryConfig: (h = false) => makeFactoryOverlay({ run, root: fx.root, env: { GITHUB_SHA: fx.baseSha }, defaultBranch: () => "main", harnessIssue: h })(),
    branchOwnFactoryPaths: ({ sha, harnessIssue }) => branchOwnFactoryPaths({ run, cwd: fx.root, sha, harnessIssue }),
    baseMergeComplete: ({ sha, paths }) => assertBaseMergeComplete({ run, cwd: fx.root, sha, paths }),
    // 브랜치의 미러 커밋은 브랜치 HEAD의 소스와 실제로 대조한다(생성기만 픽스처의 것 — `fakeGenerators`).
    mirrorMatchesBranchHead: () => mirrorMatchesBranchHead({ root: fx.root, run, importer: fakeGenerators }),
    claudeP, transition, runRecord: (l) => lines.push(...l),
    ...over,
  });
};
/** 빌더가 병합을 제대로 끝내는 세션. */
const resolvingBuilder = (root) => vi.fn(async () => {
  _wr(_j(root, "factory/lib/x.js"), "a\nbranch+base\nc\n");
  await git143(root, "add", "-A");
  await git143(root, "commit", "-q", "--no-edit");
  return { is_error: false, result: "{}" };
});

test("test_143_pending_merge_does_not_trip_overlay_guard", async () => {
  // 엔진 릴리스가 `.claude/settings.json`도 바꿨다(충돌 없음) — 병합 중인 인덱스에서는 그것이 HEAD 대비 staged 변경으로 보인다.
  const fx = await overlapRepo({ baseTouchesClaude: true });
  try {
    const lines = []; const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
    const claudeP = resolvingBuilder(fx.root);
    const code = await runStage({ stage: "implement", issue: 143, deps: realImplDeps({ fx, claudeP, transition, lines }) });
    expect(transition.mock.calls.filter(([a]) => a.to === "factory:blocked")).toEqual([]);
    expect(claudeP).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
    expect(lines.some((l) => /^overlay: FAIL/.test(l))).toBe(false);
  } finally { fx.done(); }
  // 브랜치가 정말로 팩토리 소유 경로(미러가 아닌 `.claude/agents/a.md`)를 고쳤다면 오늘처럼 멈춘다.
  const own = await overlapRepo({ baseTouchesClaude: true, branchEditsAgent: true });
  try {
    const lines = []; const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
    const claudeP = vi.fn(async () => ({ is_error: false, result: "{}" }));
    expect(await runStage({ stage: "implement", issue: 143, deps: realImplDeps({ fx: own, claudeP, transition, lines }) })).toBe(2);
    expect(claudeP).not.toHaveBeenCalled();
    const t = transition.mock.calls.at(-1)[0];
    expect(t.to).toBe("factory:blocked");
    expect(t.reason).toContain(".claude/agents/a.md");
    expect(t.reason).not.toContain(".claude/settings.json");
  } finally { own.done(); }
  // 브랜치의 경로 목록을 읽지 못하면 판단할 수 없다 — 멈춘다(fail closed).
  const t2 = vi.fn(async ({ to }) => ({ ok: true, to })); const claudeP2 = vi.fn();
  const d2 = implDeps({
    checkoutBranch: async () => ({ ok: true, branch: BR143, base: `origin/${BR143}`, existed: true, merged: SHA, source: "GITHUB_SHA", conflicts: ["factory/lib/x.js"] }),
    overlayFactoryConfig: async () => ({ ok: true, sha: SHA, paths: [".claude/settings.json"] }),
    branchOwnFactoryPaths: async () => ({ ok: false, reason: "git diff failed: fatal: bad object" }),
    baseMergeComplete: async () => ({ ok: true }), claudeP: claudeP2, transition: t2,
  });
  expect(await runStage({ stage: "implement", issue: 143, deps: d2 })).toBe(2);
  expect(claudeP2).not.toHaveBeenCalled();
  expect(t2.mock.calls.at(-1)[0].to).toBe("factory:blocked");
});

const pendingCb = { ok: true, branch: BR143, base: `origin/${BR143}`, existed: true, merged: SHA, source: "GITHUB_SHA", conflicts: ["factory/lib/x.js", "factory/bin/y.js"] };
/** 세션 뒤 단계들을 전부 스파이로 둔 implement 배선. */
const afterSessionSpies = (over = {}) => {
  const s = {
    gates: vi.fn(async () => null), verifyStage: vi.fn(() => ({ ok: true, reasons: [], data: {} })), writeHandoff: vi.fn(async () => {}),
    mirror: vi.fn(async () => ({ ok: true, applicable: false, changed: [], sha: null })),
    assertStageBranch: vi.fn(async () => ({ ok: true, branch: BR143 })),
    dropPostHandoffDrift: vi.fn(async () => ({ ok: true, dropped: [] })),
    transition: vi.fn(async ({ to }) => ({ ok: true, to })),
  };
  const lines = [];
  return { s, lines, d: implDeps({ checkoutBranch: async () => pendingCb, ...s, runRecord: (l) => lines.push(...l), ...over }) };
};

test("test_143_unfinished_merge_is_undecidable", async () => {
  // 실제 git: 빌더가 아무것도 하지 않았다 → MERGE_HEAD가 남아 있다.
  const fx = await overlapRepo();
  try {
    const r = await checkout143({ run: realRun, root: fx.root, baseSha: fx.baseSha, regenerate: vi.fn() });
    expect(r.conflicts).toEqual(["factory/lib/x.js"]);
    const pending = await assertBaseMergeComplete({ run: realRun, cwd: fx.root, sha: r.merged, paths: r.conflicts });
    expect(pending.ok).toBe(false);
    expect(pending.reason).toContain("factory/lib/x.js");
    expect(pending.reason).toMatch(/MERGE_HEAD/);
    // 빌더가 병합을 abort했다 → MERGE_HEAD는 사라졌지만 base는 HEAD의 조상이 아니다. KTB-38이 말없이 돌아오면 안 된다.
    await git143(fx.root, "merge", "--abort");
    expect(await mergeHead(fx.root)).toBe(false);
    const abortedMerge = await assertBaseMergeComplete({ run: realRun, cwd: fx.root, sha: r.merged, paths: r.conflicts });
    expect(abortedMerge.ok).toBe(false);
    expect(abortedMerge.reason).toMatch(/not an ancestor/);
  } finally { fx.done(); }
  // 실제 git: 빌더가 제대로 풀고 커밋했다 → 통과.
  const good = await overlapRepo();
  try {
    const r = await checkout143({ run: realRun, root: good.root, baseSha: good.baseSha, regenerate: vi.fn() });
    await resolvingBuilder(good.root)();
    expect(await assertBaseMergeComplete({ run: realRun, cwd: good.root, sha: r.merged, paths: r.conflicts })).toEqual({ ok: true });
  } finally { good.done(); }
  // git 상태를 읽지 못하면(0/1 밖의 종료 코드) 판정 불가다.
  const broken = makeFakeRun([{ match: (c) => c === "git", result: { code: 128, stdout: "", stderr: "fatal: not a git repository" } }]);
  const b = await assertBaseMergeComplete({ run: broken, cwd: "/repo", sha: SHA, paths: ["factory/lib/x.js"] });
  expect(b.ok).toBe(false);
  expect(b.reason).toMatch(/fatal: not a git repository/);

  // 배선: 끝나지 않은 병합은 세션 직후에 막힌다 — 브랜치 확인·드리프트·미러·게이트·verify·핸드오프 어느 것도 부르지 않는다.
  for (const out of [{ is_error: false, result: "{}" }, { is_error: true, subtype: "error_max_turns", terminal_reason: "max_turns", num_turns: 6, result: "" }]) {
    const baseMergeComplete = vi.fn(async () => ({ ok: false, reason: "MERGE_HEAD still present — the merge was never concluded" }));
    const { s, lines, d } = afterSessionSpies({ baseMergeComplete, claudeP: async () => out });
    expect(await runStage({ stage: "implement", issue: 143, deps: d })).toBe(2);
    expect(baseMergeComplete).toHaveBeenCalledWith({ sha: SHA, paths: pendingCb.conflicts });
    for (const k of ["gates", "verifyStage", "writeHandoff", "mirror", "assertStageBranch", "dropPostHandoffDrift"]) expect(s[k], k).not.toHaveBeenCalled();
    const t = s.transition.mock.calls.at(-1)[0];
    expect(t.to).toBe("factory:blocked");
    expect(t.cause).toBe("undecidable");
    expect(t.reason).toContain("builder did not complete the base merge");
    expect(t.reason).toContain("factory/lib/x.js");
    expect(t.reason).toContain("factory/bin/y.js");
    expect(lines.some((l) => /builder did not complete the base merge/.test(l))).toBe(true);
  }
  // 검사 dep이 배선되지 않았으면 끝났다고 볼 근거가 없다 — 막는다.
  const unwired = afterSessionSpies();
  expect(await runStage({ stage: "implement", issue: 143, deps: unwired.d })).toBe(2);
  expect(unwired.s.gates).not.toHaveBeenCalled();
  // 끝난 병합은 평소의 라운드다: 게이트·핸드오프가 정확히 한 번.
  const fine = afterSessionSpies({ baseMergeComplete: async () => ({ ok: true }) });
  expect(await runStage({ stage: "implement", issue: 143, deps: fine.d })).toBe(0);
  expect(fine.s.gates).toHaveBeenCalledTimes(1);
  expect(fine.s.writeHandoff).toHaveBeenCalledTimes(1);
  expect(fine.s.transition.mock.calls.some(([a]) => a.to === "factory:blocked")).toBe(false);
  // 충돌이 없던 라운드는 그 검사를 부르지 않는다.
  const noConflict = vi.fn(async () => ({ ok: false, reason: "should not be asked" }));
  const plain = afterSessionSpies({ checkoutBranch: async () => ({ ok: true, branch: BR143, base: `origin/${BR143}`, existed: true, merged: SHA, source: "GITHUB_SHA" }), baseMergeComplete: noConflict });
  expect(await runStage({ stage: "implement", issue: 143, deps: plain.d })).toBe(0);
  expect(noConflict).not.toHaveBeenCalled();
});

test("test_143_committed_conflict_markers_are_blocked", async () => {
  // 빌더가 풀지 않고 `git add -A && git commit`으로 병합을 "끝냈다" — MERGE_HEAD는 사라졌고 base는 조상이지만 마커가 커밋됐다.
  const fx = await overlapRepo();
  try {
    const r = await checkout143({ run: realRun, root: fx.root, baseSha: fx.baseSha, regenerate: vi.fn() });
    await git143(fx.root, "add", "-A");
    await git143(fx.root, "commit", "-q", "--no-edit");
    expect(await mergeHead(fx.root)).toBe(false);
    const c = await assertBaseMergeComplete({ run: realRun, cwd: fx.root, sha: r.merged, paths: r.conflicts });
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/conflict marker/);
    expect(c.reason).toContain("factory/lib/x.js");
  } finally { fx.done(); }
  // 같은 일을 runStage 안에서: 빌더 세션이 마커째 커밋하면 게이트도 핸드오프도 없다.
  const fx2 = await overlapRepo();
  try {
    const lines = []; const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
    const gates = vi.fn(async () => null); const writeHandoff = vi.fn(async () => {});
    const claudeP = vi.fn(async () => { await git143(fx2.root, "add", "-A"); await git143(fx2.root, "commit", "-q", "--no-edit"); return { is_error: false, result: "{}" }; });
    expect(await runStage({ stage: "implement", issue: 143, deps: realImplDeps({ fx: fx2, claudeP, transition, lines, over: { gates, writeHandoff } }) })).toBe(2);
    expect(claudeP).toHaveBeenCalledTimes(1);
    expect(gates).not.toHaveBeenCalled();
    expect(writeHandoff).not.toHaveBeenCalled();
    const t = transition.mock.calls.at(-1)[0];
    expect(t.to).toBe("factory:blocked");
    expect(t.cause).toBe("undecidable");
    expect(t.reason).toContain("builder did not complete the base merge");
    expect(t.reason).toContain("factory/lib/x.js");
  } finally { fx2.done(); }
  // 마커가 없는 해결(삭제 포함)은 통과한다 — 경로가 HEAD에 없으면 마커도 없다.
  const del = await overlapRepo();
  try {
    const r = await checkout143({ run: realRun, root: del.root, baseSha: del.baseSha, regenerate: vi.fn() });
    await git143(del.root, "rm", "-q", "factory/lib/x.js");
    await git143(del.root, "commit", "-q", "--no-edit");
    expect(await assertBaseMergeComplete({ run: realRun, cwd: del.root, sha: r.merged, paths: r.conflicts })).toEqual({ ok: true });
  } finally { del.done(); }
});

test("test_143_remaining_merge_failures_still_abort_loudly", async () => {
  // 오버레이 루트 아래의 충돌(빌더가 쓸 수 없는 경로)은 소스 충돌과 함께여도 세션 전에 abort된다 — 경로를 이름으로.
  for (const p of [".claude/agents/b.md", ".factory/harness.toml", "docs/factory/CHARTER.md"]) {
    const fx = await overlapRepo({ conflictUnder: p });
    try {
      const calls = []; const regenerate = vi.fn();
      const r = await checkout143({ run: spyRun(calls), root: fx.root, baseSha: fx.baseSha, regenerate });
      expect(r.ok, p).toBe(false);
      expect(r.undecidable).toBe(true);
      expect(r.reason).toMatch(/stale PR conflicts with base — rebase by hand/);
      expect(r.reason).toContain(p);
      expect(aborted(calls)).toBe(true);
      expect(await mergeHead(fx.root)).toBe(false);
      expect(pushed(calls)).toBe(false);
      expect(regenerate).not.toHaveBeenCalled();
      // 배선: 빌더는 뜨지 않고, 판정 불가로 막힌다.
      const claudeP = vi.fn(); const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
      expect(await runStage({ stage: "implement", issue: 143, deps: implDeps({ checkoutBranch: async () => r, claudeP, transition }) })).toBe(2);
      expect(claudeP).not.toHaveBeenCalled();
      expect(transition.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({ to: "factory:blocked", cause: "undecidable" }));
    } finally { fx.done(); }
  }
  // 채택자 저장소(엔진 소스가 없다): 소스 충돌도 예전처럼 abort — 넘김은 엔진 저장소에서만.
  const adopter = await overlapRepo({ engine: false });
  try {
    const calls = [];
    const r = await checkout143({ run: spyRun(calls), root: adopter.root, baseSha: adopter.baseSha, regenerate: vi.fn() });
    expect(r.ok).toBe(false);
    expect(r.undecidable).toBe(true);
    expect(r.reason).toMatch(/rebase by hand/);
    expect(aborted(calls)).toBe(true);
    expect(await mergeHead(adopter.root)).toBe(false);
  } finally { adopter.done(); }
  const root = selfRepo();
  try {
    // 병합이 실패했는데 충돌 경로가 하나도 없다 → 절대 `ok:true` + 빈 목록이 아니다.
    const calls = [];
    const none = await makeCheckoutBranch({ run: conflictStub({ calls, conflicted: [] }), root, issue: 3, env: { GITHUB_SHA: SHA }, defaultBranch: () => "main", regenerate: vi.fn() })();
    expect(none.ok).toBe(false);
    expect(none.undecidable).toBe(true);
    expect(none.reason).toMatch(/rebase by hand/);
    expect(calls.some((c) => c.includes("merge --abort"))).toBe(true);
    // 충돌 목록을 읽을 수 없다 → 같은 abort.
    const calls2 = []; const inner = conflictStub({ calls: calls2, conflicted: ["factory/lib/x.js"] });
    const unreadable = async (cmd, args, opts) => (cmd === "git" && args[0] === "diff" && args.includes("--diff-filter=U") ? { code: 128, stdout: "", stderr: "fatal: index file corrupt" } : inner(cmd, args, opts));
    const u = await makeCheckoutBranch({ run: unreadable, root, issue: 3, env: { GITHUB_SHA: SHA }, defaultBranch: () => "main", regenerate: vi.fn() })();
    expect(u.ok).toBe(false);
    expect(u.undecidable).toBe(true);
    expect(calls2.some((c) => c.includes("merge --abort"))).toBe(true);
    // abort 자체가 실패하면 그것도 사유에 적는다.
    const calls3 = [];
    const base3 = branchStub({ calls: calls3, mergeCode: 1, abortCode: 1 });
    const failingAbort = async (cmd, args, opts) => (cmd === "git" && args[0] === "diff" && args.includes("--diff-filter=U") ? { code: 0, stdout: ".claude/hooks/x.sh.bak\n", stderr: "" } : base3(cmd, args, opts));
    const fa = await makeCheckoutBranch({ run: failingAbort, root, issue: 3, env: { GITHUB_SHA: SHA }, defaultBranch: () => "main", regenerate: vi.fn() })();
    expect(fa.ok).toBe(false);
    expect(fa.undecidable).toBe(true);
    expect(fa.reason).toMatch(/git merge --abort also failed/);
  } finally { _rm(root, { recursive: true, force: true }); }
});

/**
 * #143 — 병합이 빌더에게 넘어간 라운드에서 컨텍스트(세션 **전**)가 구한 merge-base는 옛 분기점이다(HEAD에 아직 base가 없다).
 * 그 값을 게이트가 그대로 쓰면 엔진 릴리스 전체가 이 PR의 diff로 읽힌다(must-not·새 테스트·tier 바닥). 병합이 끝났다고 확인된
 * 직후, 게이트 **전에** 캐시를 버려 게이트가 병합된 HEAD로 다시 구하게 한다.
 */
test("test_143_completed_merge_resets_the_diff_base", async () => {
  const order = [];
  const { d } = afterSessionSpies({
    baseMergeComplete: async () => { order.push("complete"); return { ok: true }; },
    forgetMergeBase: vi.fn(() => { order.push("forget"); }),
    gates: vi.fn(async () => { order.push("gates"); return null; }),
  });
  expect(await runStage({ stage: "implement", issue: 143, deps: d })).toBe(0);
  expect(d.forgetMergeBase).toHaveBeenCalledTimes(1);
  expect(order).toEqual(["complete", "forget", "gates"]);
  // 넘긴 병합이 없던 라운드는 캐시를 건드리지 않는다.
  const plain = afterSessionSpies({ checkoutBranch: async () => ({ ok: true, branch: BR143, base: `origin/${BR143}`, existed: true, merged: SHA, source: "GITHUB_SHA" }), forgetMergeBase: vi.fn() });
  expect(await runStage({ stage: "implement", issue: 143, deps: plain.d })).toBe(0);
  expect(plain.d.forgetMergeBase).not.toHaveBeenCalled();
  // 끝나지 않은 병합도 건드리지 않는다(게이트까지 가지 않는다).
  const stuck = afterSessionSpies({ baseMergeComplete: async () => ({ ok: false, reason: "MERGE_HEAD still present" }), forgetMergeBase: vi.fn() });
  expect(await runStage({ stage: "implement", issue: 143, deps: stuck.d })).toBe(2);
  expect(stuck.d.forgetMergeBase).not.toHaveBeenCalled();
  expect(stuck.s.gates).not.toHaveBeenCalled();
  expect(d.gates).toHaveBeenCalledTimes(1);
});

/**
 * #143 (셀프 비판 f2) — dw4의 "읽을 수 없는 git 상태"는 **모든** 질문에 대해 판정 불가다, 첫 질문만이 아니라. MERGE_HEAD는 깨끗이
 * 없다고(1) 답했는데 그다음 질문이 고장 나면(128) 그 고장을 "끝났다"나 "마커 없음"으로 읽으면 안 된다. 각 단계를 하나씩 고장 낸다.
 */
test("test_143_unreadable_git_state_at_every_step_blocks", async () => {
  const PATHS = ["factory/lib/x.js"];
  const step = ({ anc = 0, ls = { code: 0, stdout: "factory/lib/x.js\n" }, show = { code: 0, stdout: "resolved\n" } }) => makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "rev-parse", result: { code: 1, stdout: "", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "merge-base", result: typeof anc === "number" ? { code: anc, stdout: "", stderr: anc > 1 ? "fatal: Not a valid commit name" : "" } : anc },
    { match: (c, a) => c === "git" && a[0] === "ls-tree", result: { stderr: ls.code ? "fatal: not a tree object" : "", ...ls } },
    { match: (c, a) => c === "git" && a[0] === "show", result: { stderr: show.code ? "fatal: bad object HEAD" : "", ...show } },
  ]);
  const check = (run) => assertBaseMergeComplete({ run, cwd: "/repo", sha: SHA, paths: PATHS });
  // 통제군: 모든 질문이 깨끗하게 답하면 끝난 병합이다 — 아래의 실패는 각 고장 하나 때문이다.
  expect(await check(step({}))).toEqual({ ok: true });
  // 조상 검사가 고장(0/1 밖) → 판정 불가. "조상이 아니다"(1)와도 구분된다.
  const anc = await check(step({ anc: 128 }));
  expect(anc.ok).toBe(false);
  expect(anc.reason).toMatch(/git state unreadable/);
  expect(anc.reason).toMatch(/merge-base/);
  expect(anc.reason).toContain("fatal: Not a valid commit name");
  // ls-tree가 고장 → 판정 불가(경로를 이름으로).
  const ls = await check(step({ ls: { code: 128, stdout: "" } }));
  expect(ls.ok).toBe(false);
  expect(ls.reason).toMatch(/git state unreadable/);
  expect(ls.reason).toMatch(/ls-tree/);
  expect(ls.reason).toContain("factory/lib/x.js");
  // show가 고장 → "마커 없음"이 아니라 판정 불가. stdout이 비어 있어도 그것을 깨끗한 파일로 읽지 않는다.
  const show = await check(step({ show: { code: 128, stdout: "" } }));
  expect(show.ok).toBe(false);
  expect(show.reason).toMatch(/git state unreadable/);
  expect(show.reason).toMatch(/git show HEAD:factory\/lib\/x\.js/);
  // 배선: 그 판정은 runStage에서 blocked(undecidable)이고 게이트·핸드오프에 닿지 않는다.
  for (const run of [step({ anc: 128 }), step({ ls: { code: 128, stdout: "" } }), step({ show: { code: 128, stdout: "" } })]) {
    const { s, d } = afterSessionSpies({ baseMergeComplete: ({ sha, paths }) => assertBaseMergeComplete({ run, cwd: "/repo", sha, paths }) });
    expect(await runStage({ stage: "implement", issue: 143, deps: d })).toBe(2);
    expect(s.gates).not.toHaveBeenCalled();
    expect(s.writeHandoff).not.toHaveBeenCalled();
    const t = s.transition.mock.calls.at(-1)[0];
    expect(t).toEqual(expect.objectContaining({ to: "factory:blocked", cause: "undecidable" }));
    expect(t.reason).toMatch(/builder did not complete the base merge \(git state unreadable/);
  }
});

/**
 * #143 (셀프 비판 f3) — dw2: "브랜치가 정말로 팩토리 소유 경로를 고쳤다면 오늘처럼 멈춘다." 오늘 브랜치의 미러 경로는 그 브랜치의
 * `factory/**`가 생성하는 것과 같을 때만 통과한다(`mirrorMatchesHead`). 병합이 진행 중이어도 그 대조는 그대로다 — 다만 워크트리의
 * 소스에는 마커가 있으므로, 대조는 **브랜치 HEAD의 소스**로 한다(`mirrorMatchesBranchHead`: HEAD를 임시 워크트리로 꺼낸다).
 * 생성기는 픽스처의 소스에서 미러를 만드는 작은 함수다: 줄마다 `gen ` 접두. 워크트리(마커)로 만들면 대조가 틀린다 — 그래서 통과
 * 케이스가 곧 "HEAD의 소스로 대조했다"의 증거다.
 */
import { mirrorMatchesBranchHead } from "../bin/run-stage.js";
const fakeGenerators = (p) => {
  if (p.endsWith("manifest.js")) return { buildManifest: ({ pkgRoot }) => [{ dest: ".factory/lib/x.js", src: _j(pkgRoot, "factory/lib/x.js") }] };
  if (p.endsWith("install.js")) return { freshContent: (e, { readFile }) => readFile(e.src).split("\n").map((l) => (l ? `gen ${l}` : l)).join("\n") };
  if (p.endsWith("init.js")) return { projectVars: () => ({}) };
  throw new Error(`unexpected import ${p}`);
};
test("test_143_branch_edited_mirror_is_still_blocked_during_a_pending_merge", async () => {
  // 브랜치가 설치본을 손으로 고쳤다(소스가 만드는 것이 아니다) + base 릴리스와 소스 충돌 → 넘김이 아니라 오늘처럼 멈춘다.
  const hand = await overlapRepo({ branchMirror: "hand edit\n" });
  try {
    const lines = []; const transition = vi.fn(async ({ to }) => ({ ok: true, to })); const claudeP = vi.fn();
    const d = realImplDeps({ fx: hand, claudeP, transition, lines, over: { mirrorMatchesBranchHead: () => mirrorMatchesBranchHead({ root: hand.root, run: realRun, importer: fakeGenerators }) } });
    expect(await runStage({ stage: "implement", issue: 143, deps: d })).toBe(2);
    expect(claudeP).not.toHaveBeenCalled();
    const t = transition.mock.calls.at(-1)[0];
    expect(t.to).toBe("factory:blocked");
    expect(t.reason).toContain(".factory/lib/x.js");
    expect(t.reason).toMatch(/not what its sources generate/);
    expect(lines.some((l) => /^overlay: FAIL/.test(l))).toBe(true);
  } finally { hand.done(); }
  // 같은 브랜치 모양인데 미러가 러너의 생성물(브랜치 소스 `a/branch/c` → `gen a/gen branch/gen c`)이면 넘어간다 — 대조는 마커가 든
  // 워크트리가 아니라 HEAD의 소스로 했다. 임시 워크트리는 남지 않는다.
  const gen = await overlapRepo();
  try {
    const lines = []; const transition = vi.fn(async ({ to }) => ({ ok: true, to })); const claudeP = resolvingBuilder(gen.root);
    const d = realImplDeps({ fx: gen, claudeP, transition, lines, over: { mirrorMatchesBranchHead: () => mirrorMatchesBranchHead({ root: gen.root, run: realRun, importer: fakeGenerators }) } });
    expect(await runStage({ stage: "implement", issue: 143, deps: d })).toBe(0);
    expect(claudeP).toHaveBeenCalledTimes(1);
    expect(transition.mock.calls.filter(([a]) => a.to === "factory:blocked")).toEqual([]);
    expect(lines.some((l) => /runner-generated mirror path\(s\).*verified against the branch's factory\/\*\*: \.factory\/lib\/x\.js/.test(l))).toBe(true);
    expect(await git143(gen.root, "worktree", "list", "--porcelain")).not.toMatch(/ktb-mirror-head/);
  } finally { gen.done(); }
  // 대조 수단이 배선되지 않았으면 오늘처럼 멈춘다(fail closed) — 미러 경로를 말없이 빼지 않는다.
  const bare = await overlapRepo();
  try {
    const lines = []; const transition = vi.fn(async ({ to }) => ({ ok: true, to })); const claudeP = vi.fn();
    expect(await runStage({ stage: "implement", issue: 143, deps: realImplDeps({ fx: bare, claudeP, transition, lines, over: { mirrorMatchesBranchHead: undefined } }) })).toBe(2);
    expect(claudeP).not.toHaveBeenCalled();
    expect(transition.mock.calls.at(-1)[0].reason).toContain(".factory/lib/x.js");
  } finally { bare.done(); }
});
