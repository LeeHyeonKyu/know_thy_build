import { test, expect, vi } from "vitest";
import {
  runStage,
  makeDropPostHandoffDrift,
  implementHeadShaOf,
  driftDroppedLine,
  driftDroppedMarker,
  driftRefusedReason,
} from "../bin/run-stage.js";
import { makeFakeRun } from "../lib/exec.js";

/**
 * ── ADR-020 KTB-43 — **핸드오프 뒤에 붙은 툴체인 재생성 커밋은 사람이 볼 사건이 아니다.** ───────
 * own-calendar #3 implement(라이브, 2026-09-14 13:32Z): 빌더가 자기 작업을 커밋하고(bfff638)
 * head_sha=bfff638로 핸드오프를 쓴 다음, 검증(`flutter test`)이 툴체인 파일을 다시 만들었고 빌더가
 * 그것을 `f1909c6 "chore(3): reconcile flutter toolchain drift left by verification run"`으로 커밋했다
 * (건드린 파일은 KTB-39의 `setup_dirty` 기준선 집합 그대로였다). `requirements.js:69`가
 * `implement head_sha bfff638 != branch head f1909c6`으로 전이를 거부했고 이슈는 needs-human에 앉았다.
 * fail-closed는 옳았다 — 틀린 것은 **복구가 자동이 아니었다는 것**이다.
 */

const SHA_H = "b".repeat(40);   // 핸드오프가 적은 sha
const SHA_D = "f".repeat(40);   // 드리프트 커밋이 얹힌 뒤의 브랜치 head
const DRIFT = ["client/analysis_options.yaml", "client/linux/flutter/generated_plugin_registrant.cc"];

const baseline = (paths) => ({ ok: true, entries: paths.map((p) => ({ path: p, code: " M" })), stat: new Map() });

const git = (over = {}) =>
  makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "rev-parse", result: { code: 0, stdout: `${over.head ?? SHA_D}\n`, stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "merge-base", result: over.ancestor ?? { code: 0, stdout: "", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "diff", result: { code: 0, stdout: `${(over.files ?? DRIFT).join("\n")}\n`, stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "rev-list", result: { code: 0, stdout: `${SHA_D}\n`, stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "reset", result: over.reset ?? { code: 0, stdout: "", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "push", result: over.push ?? { code: 0, stdout: "", stderr: "" } },
  ]);

// ── 핸드오프 sha를 세션 산출물에서 읽는다 (게이트보다 **먼저** 판단해야 하므로) ─────────────────

test("implementHeadShaOf: the builder's head_sha is read from the session artifact before gates run", () => {
  const artifact = JSON.stringify({ issue: 3, head_sha: SHA_H, pr: 7, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "structural" });
  expect(implementHeadShaOf({ out: { result: artifact } })).toBe(SHA_H);
  // gates는 이 시점에 아직 없다 — 후보 채점은 verify-stage와 **같은** 방식으로 자리표시자를 채운다.
  expect(implementHeadShaOf({ out: { result: "no json here" } })).toBe(null);
  expect(implementHeadShaOf({ out: null })).toBe(null);
});

// ── 드리프트만 얹힌 커밋은 떨어뜨린다 ─────────────────────────────────────────────────────────

test("dropPostHandoffDrift: a drift-only extra commit is reset away and pushed with a lease", async () => {
  const run = git();
  const drop = makeDropPostHandoffDrift({ run, root: "/repo", issue: 3 });
  const r = await drop({ handoffSha: SHA_H, baseline: baseline(DRIFT) });
  expect(r.ok).toBe(true);
  expect(r.dropped).toEqual([SHA_D]);
  expect(r.files).toEqual(DRIFT);
  expect(run.calls.find((c) => c.args[0] === "reset").args).toEqual(["reset", "--hard", SHA_H]);
  // 리스 **없는** force는 절대 없다 — 기대하는 원격 head를 함께 싣는다.
  expect(run.calls.find((c) => c.args[0] === "push").args).toEqual(["push", `--force-with-lease=claude/fq-3:${SHA_D}`, "origin", "claude/fq-3"]);
  expect(run.calls.some((c) => c.args.includes("--force"))).toBe(false);
});

test("dropPostHandoffDrift: `[runtime].setup_generated` globs widen the drift set beyond this run's baseline", async () => {
  const files = ["client/windows/flutter/generated_plugin_registrant.cc"];
  const run = git({ files });
  const r = await makeDropPostHandoffDrift({ run, root: "/repo", issue: 3 })({
    handoffSha: SHA_H,
    baseline: baseline([]),                                   // setup이 이번 런에서는 그 파일을 건드리지 않았다
    generated: ["client/**/flutter/generated_plugin_*"],
  });
  expect(r.ok).toBe(true);
  expect(r.dropped).toEqual([SHA_D]);
});

test("dropPostHandoffDrift: an extra commit touching a source file is refused, and the reason names the files", async () => {
  const run = git({ files: [...DRIFT, "client/lib/main.dart"] });
  const r = await makeDropPostHandoffDrift({ run, root: "/repo", issue: 3 })({ handoffSha: SHA_H, baseline: baseline(DRIFT) });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe(driftRefusedReason(["client/lib/main.dart"]));
  expect(run.calls.some((c) => c.args[0] === "reset" || c.args[0] === "push")).toBe(false);
});

test("dropPostHandoffDrift: nothing to do when the branch head IS the handoff sha — no git writes at all", async () => {
  const run = git({ head: SHA_H });
  const r = await makeDropPostHandoffDrift({ run, root: "/repo", issue: 3 })({ handoffSha: SHA_H, baseline: baseline(DRIFT) });
  expect(r).toEqual({ ok: true, dropped: [] });
  expect(run.calls.map((c) => c.args[0])).toEqual(["rev-parse"]);
});

test("dropPostHandoffDrift: a branch head that does not descend from the handoff sha is refused, never rewritten", async () => {
  const run = git({ ancestor: { code: 1, stdout: "", stderr: "" } });
  const r = await makeDropPostHandoffDrift({ run, root: "/repo", issue: 3 })({ handoffSha: SHA_H, baseline: baseline(DRIFT) });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/does not descend from the implement handoff/);
  expect(run.calls.some((c) => c.args[0] === "reset" || c.args[0] === "push")).toBe(false);
});

test("dropPostHandoffDrift: a lost lease is a refusal — the stage never force-pushes over someone else's commit", async () => {
  const run = git({ push: { code: 1, stdout: "", stderr: "! [rejected] claude/fq-3 -> claude/fq-3 (stale info)" } });
  const r = await makeDropPostHandoffDrift({ run, root: "/repo", issue: 3 })({ handoffSha: SHA_H, baseline: baseline(DRIFT) });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/force-with-lease/);
  expect(r.reason).toMatch(/stale info/);
});

test("driftDroppedLine / marker: one run-record line and one comment marker, both naming the shas and the file count", () => {
  const line = driftDroppedLine({ dropped: [SHA_D], files: DRIFT, from: SHA_D, to: SHA_H, branch: "claude/fq-3" });
  expect(line).toMatch(/^dropped post-handoff drift commit\(s\): fffffff \(2 files: /);
  expect(line).toContain("client/analysis_options.yaml");
  const marker = driftDroppedMarker({ dropped: [SHA_D], files: DRIFT, from: SHA_D, to: SHA_H, branch: "claude/fq-3" });
  expect(marker.startsWith("<!-- factory-drift-dropped ")).toBe(true);
  expect(marker.endsWith("-->")).toBe(true);
  expect(marker.split("\n")).toHaveLength(1);
  expect(marker).toContain(`from=${SHA_D}`);
  expect(marker).toContain(`to=${SHA_H}`);
});

// ── runStage 배선 ────────────────────────────────────────────────────────────────────────────

const BRANCH = "claude/fq-3";
const deps = (over = {}) => ({
  charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }),
  heartbeat: async () => ({ stop() {} }), assertHandoff: async () => ({ ok: true }),
  buildContext: async () => ({ roster: [], orchestration: "workflow", limits: { K: 3 } }),
  resetAgentsLog: async () => {}, claudeP: async () => ({ is_error: false, result: "{}" }),
  gates: async () => ({ schema: "factory.gates.v1", status: "GREEN", level: "unit", head_sha: SHA_H }),
  verifyStage: () => ({ ok: true, reasons: [], data: { head_sha: SHA_H, pr: 7, verifier: { verdict: "accepted" } } }),
  writeHandoff: async () => {}, transition: async () => ({ ok: true, to: "factory:awaiting-review" }),
  runRecord: () => {}, release: async () => true,
  checkoutBranch: async () => ({ ok: true, branch: BRANCH, base: `origin/${BRANCH}`, existed: true }),
  overlayFactoryConfig: async () => ({ ok: true, sha: "a".repeat(40), paths: [] }),
  assertStageBranch: async () => ({ ok: true, branch: BRANCH }),
  ciSettingsPresent: async () => true,
  setupBaseline: async () => baseline(DRIFT),
  restoreSetupDirty: async () => ({ ok: true, tracked: DRIFT, untracked: [] }),
  handoffHeadSha: () => SHA_H,
  dropPostHandoffDrift: async () => ({ ok: true, dropped: [] }),
  ...over,
});

test("implement: a drift-only post-handoff commit is dropped BEFORE the gates run — the gate verdict binds the reset head", async () => {
  const order = [];
  const lines = [];
  const comment = vi.fn(async () => {});
  const dropPostHandoffDrift = vi.fn(async () => {
    order.push("drift");
    return { ok: true, dropped: [SHA_D], files: DRIFT, from: SHA_D, to: SHA_H, branch: BRANCH };
  });
  const d = deps({
    claudeP: async () => { order.push("claude"); return { is_error: false, result: "{}" }; },
    dropPostHandoffDrift,
    gates: async () => { order.push("gates"); return { schema: "factory.gates.v1", status: "GREEN", level: "unit", head_sha: SHA_H }; },
    comment, runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(0);
  expect(order).toEqual(["claude", "drift", "gates"]);
  expect(dropPostHandoffDrift.mock.calls[0][0]).toMatchObject({ handoffSha: SHA_H });
  expect(lines.some((l) => l.startsWith("dropped post-handoff drift commit(s): fffffff"))).toBe(true);
  expect(comment.mock.calls[0][1]).toContain("<!-- factory-drift-dropped ");
});

test("implement: no extra commit leaves the stage exactly as it was — no record line, no comment", async () => {
  const lines = [];
  const comment = vi.fn(async () => {});
  expect(await runStage({ stage: "implement", issue: 3, deps: deps({ runRecord: (l) => lines.push(...l), comment }) })).toBe(0);
  expect(lines.some((l) => l.startsWith("dropped post-handoff drift"))).toBe(false);
  expect(comment).not.toHaveBeenCalled();
});

test("implement: a post-handoff commit that touches a source file is refused with the file list — and the handoff is still written", async () => {
  const lines = [];
  const writeHandoff = vi.fn(async () => {});
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const reason = driftRefusedReason(["client/lib/main.dart"]);
  const d = deps({
    dropPostHandoffDrift: async () => ({ ok: false, files: ["client/lib/main.dart"], reason }),
    writeHandoff, transition, runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(2);
  expect(writeHandoff).toHaveBeenCalled();
  expect(transition.mock.calls.at(-1)[0]).toEqual({ to: "factory:needs-human", reason });
  expect(lines.some((l) => l === `drift: REFUSED — ${reason}`)).toBe(true);
});

test("implement: uncommitted drift left by the session is NOT this rule's business — KTB-39's baseline already covers it", async () => {
  // 세션이 트리를 더럽혀 둔 채(커밋하지 않고) 끝났다: HEAD는 여전히 핸드오프의 sha다.
  const run = git({ head: SHA_H });
  const drop = makeDropPostHandoffDrift({ run, root: "/repo", issue: 3 });
  expect(await drop({ handoffSha: SHA_H, baseline: baseline(DRIFT) })).toEqual({ ok: true, dropped: [] });
  // 그리고 implement는 쓰기 스테이지라 클린 체크를 돌지 않는다 — 남은 diff는 커밋되지 않았으므로 PR에도 없다.
  const assertCleanWorktree = vi.fn(async () => ({ ok: true }));
  expect(await runStage({ stage: "implement", issue: 3, deps: deps({ assertCleanWorktree }) })).toBe(0);
  expect(assertCleanWorktree).not.toHaveBeenCalled();
});

test("implement: the artifact carrying no head_sha is left to the transition requirement — the stage rewrites nothing", async () => {
  const dropPostHandoffDrift = vi.fn(async () => ({ ok: true, dropped: [] }));
  const d = deps({ handoffHeadSha: () => null, dropPostHandoffDrift });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(0);
  expect(dropPostHandoffDrift.mock.calls[0][0]).toMatchObject({ handoffSha: null });
});

test("review: the drift drop is implement-only — no other stage rewrites a branch", async () => {
  const dropPostHandoffDrift = vi.fn(async () => ({ ok: true, dropped: [] }));
  const d = deps({
    dropPostHandoffDrift, assertCleanWorktree: async () => ({ ok: true }),
    checkoutHead: async () => ({ ok: true, sha: SHA_H }),
    verifyStage: () => ({ ok: true, reasons: [], data: { head_sha: SHA_H, pr: 7, round: 1, verdicts: [] , decision: "approved" } }),
  });
  await runStage({ stage: "review", issue: 3, deps: d });
  expect(dropPostHandoffDrift).not.toHaveBeenCalled();
});

// KTB #50 — own-calendar #9(harness M2 promotion): charterReady가 읽은 harness는 잡 체크아웃(GITHUB_SHA=main)의 것이라
// 브랜치가 넓힌 test_glob을 게이트가 못 봤다("no new tests" 두 라운드). harness 이슈에서는 브랜치 체크아웃 뒤와
// 빌더 뒤에 작업 트리에서 다시 읽고, 무엇을 읽었는지 기록에 남긴다.
test("KTB #50: a harness issue reloads harness.toml after the branch checkout and after the builder — a plain issue never does", async () => {
  const lines = [];
  const reloadHarness = vi.fn(() => ({ test: { test_glob: ["client/test/**/*_test.dart", "server/tests/**/*.test.ts"] } }));
  const d = deps({
    issueLabels: async () => ["factory:planned", "factory:harness"],
    reloadHarness,
    runRecord: (l) => lines.push(...l),
  });
  expect(await runStage({ stage: "implement", issue: 3, deps: d })).toBe(0);
  expect(reloadHarness).toHaveBeenCalledTimes(2);
  expect(lines.filter((l) => l.startsWith("harness: reloaded from the branch after branch checkout")).length).toBe(1);
  expect(lines.filter((l) => l.startsWith("harness: reloaded from the branch after the builder")).length).toBe(1);
  expect(lines.find((l) => l.startsWith("harness: reloaded"))).toContain('"server/tests/**/*.test.ts"');

  // 평범한 이슈: overlay가 harness.toml을 base의 것으로 덮으므로 다시 읽을 것이 없다 — 호출도 기록도 없다.
  const plain = vi.fn(() => ({ test: { test_glob: [] } }));
  const lines2 = [];
  expect(await runStage({ stage: "implement", issue: 3, deps: deps({ issueLabels: async () => ["factory:planned"], reloadHarness: plain, runRecord: (l) => lines2.push(...l) }) })).toBe(0);
  expect(plain).not.toHaveBeenCalled();
  expect(lines2.some((l) => l.startsWith("harness: reloaded"))).toBe(false);
});
