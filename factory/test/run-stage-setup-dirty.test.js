import { test, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStage, parseStatusEntries, snapshotSetupDirty, setupDirtyLine, setupRestoreLine, makeRestoreSetupDirty, assertNoWriteStageClean } from "../bin/run-stage.js";
import { makeFakeRun } from "../lib/exec.js";

/**
 * ── ADR-020 KTB-39 — **`[runtime].setup`이 스스로 더럽힌 트리는 에이전트의 것이 아니다.** ───────
 * own-calendar #3(2026-09-14, 라이브): 하네스의 `[runtime].setup`이 `flutter pub get`이라 세션이
 * 시작하기도 전에 추적 파일들(`client/pubspec.lock`·`client/<platform>/flutter/generated_plugin…`·
 * `client/analysis_options.yaml`)이 다시 쓰였다. triage는 쓰기 금지 스테이지라 `claude -p` 직후
 * `assertNoWriteStageClean`이 워크트리를 다시 묻는데, 그 diff는 **에이전트가 만든 것이 아닌데도**
 * "worktree dirty after triage (no-write stage)"로 읽혀 이슈가 `factory:needs-human`으로 갔다.
 * 데모가 이 벽을 못 만난 이유는 `npm ci`가 추적 파일을 건드리지 않기 때문이지, 이 체크가 옳아서가
 * 아니다. 기준선(baseline)은 그 사실을 판정에서 뺀다 — **새로 생겼거나 세션 중에 더 바뀐 것만** 더럽다.
 */

const status = (stdout, extra = []) =>
  makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "status", result: { code: 0, stdout, stderr: "" } },
    ...extra,
  ]);
const numstat = (stdout) => ({ match: (c, a) => c === "git" && a[0] === "diff", result: { code: 0, stdout, stderr: "" } });

test("parseStatusEntries: path + status code per line, both sides of a rename", () => {
  expect(parseStatusEntries(" M client/pubspec.lock\n?? client/gen/x.dart\n")).toEqual([
    { path: "client/pubspec.lock", code: " M" },
    { path: "client/gen/x.dart", code: "??" },
  ]);
  expect(parseStatusEntries("R  a.js -> b.js\n")).toEqual([
    { path: "a.js", code: "R " },
    { path: "b.js", code: "R " },
  ]);
  expect(parseStatusEntries("")).toEqual([]);
});

test("snapshotSetupDirty: the stage-start snapshot carries paths, status codes and a per-path diff fingerprint", async () => {
  const run = status(" M client/pubspec.lock\n?? client/gen/x.dart\n?? .factory/out/scratch.json\n", [numstat("3\t1\tclient/pubspec.lock\n")]);
  const s = await snapshotSetupDirty({ run, cwd: "/repo" });
  expect(s.ok).toBe(true);
  // 스크래치 경로(.factory/out/**)는 애초에 클린 체크의 대상이 아니다 — 기준선에 실어도 바뀌는 것이 없다.
  expect(s.entries).toEqual([
    { path: "client/pubspec.lock", code: " M" },
    { path: "client/gen/x.dart", code: "??" },
  ]);
  expect(s.stat.get("client/pubspec.lock")).toBe("3/1");
});

test("snapshotSetupDirty: git status failing is not fatal — no baseline, and nothing is exempt", async () => {
  const run = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "status", result: { code: 128, stdout: "", stderr: "fatal: not a git repository" } }]);
  const s = await snapshotSetupDirty({ run, cwd: "/repo" });
  expect(s.ok).toBe(false);
  expect(s.entries).toEqual([]);
  expect(s.reason).toMatch(/git status failed/);
});

test("setupDirtyLine: one run-record line, path list capped", () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ path: `p${i}.dart`, code: " M" }));
  const line = setupDirtyLine(entries);
  expect(line).toMatch(/^setup dirtied: 12 path\(s\): /);
  expect(line).toContain("p0.dart");
  expect(line).toContain("(+2 more)");
  expect(line).not.toContain("p10.dart");
  expect(setupDirtyLine([{ path: "client/pubspec.lock", code: " M" }])).toBe("setup dirtied: 1 path(s): client/pubspec.lock");
});

// ── 클린 체크 ────────────────────────────────────────────────────────────────────────────────

const baseline = (entries, stat = {}) => ({ ok: true, entries, stat: new Map(Object.entries(stat)) });

test("assertNoWriteStageClean: the baseline excludes exactly what [runtime].setup dirtied", async () => {
  const run = status(" M client/pubspec.lock\n?? client/gen/x.dart\n", [numstat("3\t1\tclient/pubspec.lock\n")]);
  const r = await assertNoWriteStageClean({
    run, cwd: "/repo",
    baseline: baseline([{ path: "client/pubspec.lock", code: " M" }, { path: "client/gen/x.dart", code: "??" }], { "client/pubspec.lock": "3/1" }),
  });
  expect(r).toEqual({ ok: true, dirty: [] });
});

test("assertNoWriteStageClean: a path the agent wrote is still dirty — the baseline is an exemption list, not an amnesty", async () => {
  const run = status(" M client/pubspec.lock\n M lib/main.dart\n", [numstat("3\t1\tclient/pubspec.lock\n")]);
  const r = await assertNoWriteStageClean({
    run, cwd: "/repo",
    baseline: baseline([{ path: "client/pubspec.lock", code: " M" }], { "client/pubspec.lock": "3/1" }),
  });
  expect(r).toEqual({ ok: false, dirty: ["lib/main.dart"] });
});

test("assertNoWriteStageClean: a baseline path the session changed FURTHER is dirty again (status code or diff size moved)", async () => {
  // ① 같은 경로인데 diff가 커졌다 — setup이 남긴 그 모양이 아니다.
  const grown = status(" M client/pubspec.lock\n", [numstat("9\t4\tclient/pubspec.lock\n")]);
  expect(await assertNoWriteStageClean({ run: grown, cwd: "/repo", baseline: baseline([{ path: "client/pubspec.lock", code: " M" }], { "client/pubspec.lock": "3/1" }) }))
    .toEqual({ ok: false, dirty: ["client/pubspec.lock"] });
  // ② 상태 문자가 바뀌었다(unstaged → staged) — 에이전트가 손댄 흔적이다.
  const staged = status("M  client/pubspec.lock\n", [numstat("3\t1\tclient/pubspec.lock\n")]);
  expect((await assertNoWriteStageClean({ run: staged, cwd: "/repo", baseline: baseline([{ path: "client/pubspec.lock", code: " M" }], { "client/pubspec.lock": "3/1" }) })).ok).toBe(false);
});

test("assertNoWriteStageClean: the fingerprint read failing is fail-closed (undecidable, not clean)", async () => {
  const run = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "status", result: { code: 0, stdout: " M client/pubspec.lock\n", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "diff", result: { code: 128, stdout: "", stderr: "fatal: bad object" } },
  ]);
  const r = await assertNoWriteStageClean({ run, cwd: "/repo", baseline: baseline([{ path: "client/pubspec.lock", code: " M" }]) });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/git diff/);
});

test("assertNoWriteStageClean: no baseline behaves exactly as before (KTB-14/KTB-37 unchanged)", async () => {
  const run = status(" M src/a.js\n");
  expect(await assertNoWriteStageClean({ run, cwd: "/repo" })).toEqual({ ok: false, dirty: ["src/a.js"] });
  expect(run.calls.some((c) => c.args[0] === "diff")).toBe(false);   // 기준선이 없으면 추가 git 호출도 없다
});

// ── implement: 빌더 앞에서 되돌린다 ───────────────────────────────────────────────────────────

test("makeRestoreSetupDirty: tracked paths are checked out, untracked setup output is removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "ktb39-"));
  mkdirSync(join(root, "client/gen"), { recursive: true });
  writeFileSync(join(root, "client/gen/x.dart"), "generated");
  const run = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "checkout", result: { code: 0, stdout: "", stderr: "" } }]);
  const restore = makeRestoreSetupDirty({ run, root });
  const r = await restore(baseline([{ path: "client/pubspec.lock", code: " M" }, { path: "client/gen/x.dart", code: "??" }]));
  expect(r.ok).toBe(true);
  expect(run.calls[0].args).toEqual(["checkout", "--", "client/pubspec.lock"]);
  expect(existsSync(join(root, "client/gen/x.dart"))).toBe(false);
  expect(setupRestoreLine(r)).toBe("setup restore: 1 tracked path(s) checked out, 1 untracked path(s) removed before the builder");
});

test("makeRestoreSetupDirty: a path outside the repo root is never removed, and git checkout failing is reported, not thrown", async () => {
  const root = mkdtempSync(join(tmpdir(), "ktb39-"));
  const run = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "checkout", result: { code: 1, stdout: "", stderr: "error: pathspec did not match" } }]);
  const rm = vi.fn();
  const r = await makeRestoreSetupDirty({ run, root, rm })(baseline([{ path: "a.lock", code: " M" }, { path: "../outside.txt", code: "??" }]));
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/pathspec did not match/);
  expect(rm).not.toHaveBeenCalled();
});

// ── runStage 배선 ────────────────────────────────────────────────────────────────────────────

const BRANCH = "claude/fq-3";
const deps = (over = {}) => ({
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
  setupBaseline: async () => baseline([{ path: "client/pubspec.lock", code: " M" }]),
  ...over,
});

test("runStage: the setup baseline is recorded once and handed to the no-write clean check", async () => {
  const lines = [];
  const assertCleanWorktree = vi.fn(async () => ({ ok: true }));
  const d = deps({ runRecord: (l) => lines.push(...l), assertCleanWorktree, writeHandoff: async () => {} });
  expect(await runStage({ stage: "triage", issue: 3, deps: d })).toBe(0);
  expect(lines).toContain("setup dirtied: 1 path(s): client/pubspec.lock");
  const [allow, base] = assertCleanWorktree.mock.calls.at(-1);
  expect(allow).toEqual([]);
  expect(base.entries).toEqual([{ path: "client/pubspec.lock", code: " M" }]);
});

test("runStage: a clean tree at stage start records nothing — no line for a fact that did not happen", async () => {
  const lines = [];
  await runStage({ stage: "triage", issue: 3, deps: deps({ runRecord: (l) => lines.push(...l), setupBaseline: async () => baseline([]), assertCleanWorktree: async () => ({ ok: true }) }) });
  expect(lines.some((l) => l.startsWith("setup dirtied:"))).toBe(false);
});

test("runStage: a snapshot that failed says so — and no path is exempt from the clean check", async () => {
  const lines = [];
  const assertCleanWorktree = vi.fn(async () => ({ ok: true }));
  await runStage({ stage: "triage", issue: 3, deps: deps({ runRecord: (l) => lines.push(...l), assertCleanWorktree, setupBaseline: async () => ({ ok: false, entries: [], reason: "git status failed: fatal" }) }) });
  expect(lines.some((l) => /^setup baseline: unavailable/.test(l))).toBe(true);
  expect(assertCleanWorktree.mock.calls.at(-1)[1]).toBe(null);
});

test("implement: the setup's dirt is restored BEFORE the branch checkout and the builder — it never reaches `git add -A`", async () => {
  const calls = [];
  const lines = [];
  const d = deps({
    restoreSetupDirty: async () => { calls.push("restore"); return { ok: true, tracked: ["client/pubspec.lock"], untracked: [] }; },
    checkoutBranch: async () => { calls.push("branch"); return { ok: true, branch: BRANCH, base: `origin/${BRANCH}`, existed: true }; },
    overlayFactoryConfig: async () => { calls.push("overlay"); return { ok: true, sha: "b".repeat(40), paths: [] }; },
    claudeP: async () => { calls.push("claude"); return { is_error: false, result: "{}" }; },
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(0);
  expect(calls).toEqual(["restore", "branch", "overlay", "claude"]);
  expect(lines.some((l) => l.startsWith("setup restore: 1 tracked"))).toBe(true);
});

test("implement: a restore that failed is recorded but does not stop the stage — the judgement is still decidable", async () => {
  const lines = [];
  const claudeP = vi.fn(async () => ({ is_error: false, result: "{}" }));
  const d = deps({
    restoreSetupDirty: async () => ({ ok: false, tracked: ["client/pubspec.lock"], untracked: [], reason: "git checkout -- failed: exit 1" }),
    claudeP, runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(0);
  expect(claudeP).toHaveBeenCalled();
  expect(lines.some((l) => /setup restore: FAILED/.test(l))).toBe(true);
});

test("implement: no-write stages never restore — writing to the tree is exactly what they must not do", async () => {
  const restoreSetupDirty = vi.fn(async () => ({ ok: true, tracked: [], untracked: [] }));
  await runStage({ stage: "triage", issue: 3, deps: deps({ restoreSetupDirty, assertCleanWorktree: async () => ({ ok: true }) }) });
  expect(restoreSetupDirty).not.toHaveBeenCalled();
});
