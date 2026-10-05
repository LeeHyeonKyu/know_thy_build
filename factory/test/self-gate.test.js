import { test, expect, vi } from "vitest";
import { runSelfGate, summarizeFindings, advisoryFindings, harnessFinding } from "../lib/self-gate.js";
import { makeFakeRun } from "../lib/exec.js";

/**
 * ── Structure B (review-efficiency Task 3) — the pre-handoff self-gate ─────────────────────────
 *
 * COST NOTE (regression the plan pins): a self-gate run is CHEAPER than a review round. It REUSES
 * the `gates` result the stage already computed (never re-runs the gates) and runs the deterministic
 * mutation check on only the NEW tests — no LLM reviewer panel is dispatched. A red deterministic
 * check caught here never spends a full multi-reviewer round.
 *
 * SCOPE (Defect A fix): the self-gate's deterministic half is the BUILDER-satisfiable checks only —
 * gates (reused), the new-test mutation check (own-cal R1 cf1), and carried regression pins (Task 5).
 * It does NOT grade qa evidence: the qa manifest is written by the qa REVIEWER at the review stage
 * (never by the builder at implement time), so at implement it cannot exist and its absence is
 * expected, not a defect. qa evidence stays enforced where it belongs — the qa reviewer at review and
 * `qaEvidenceGate` at `factory:approved`. KTB #18 R3 (a regressed finding under the same id) is
 * caught by REVIEW, and re-guarded here only via a carried Task 5 pin — not by any finish()/manifest
 * check at implement.
 */

// A vitest run double keyed per test file, returning baseline-then-mutated results in order — the
// same shape mutation-check.test.js uses, so (a) exercises the REAL mutation check deterministically.
const ok = { code: 0, stdout: "", stderr: "" };
const assertionRed = { code: 1, stdout: "", stderr: "AssertionError: expected 'a' to be 'b'" };
const harness = { commands: { test_files: "vitest run {files}" }, runtime: { setup: "npm ci" } };

const wtAdd = (res = ok) => ({ match: (c, a) => c === "git" && a[0] === "worktree" && a[1] === "add", result: res });
const wtOther = (res = ok) => ({ match: (c, a) => c === "git" && a[0] === "worktree", result: res });
const npmci = (res = ok) => ({ match: (c, a) => c === "bash" && a[1] === "npm ci", result: res });
function vitestSeq(seq) {
  const idx = {};
  return {
    match: (c, a) => c === "bash" && a[1].includes("vitest"),
    result: (c, a) => {
      const file = Object.keys(seq).find((f) => a[1].includes(f));
      const arr = seq[file];
      const i = (idx[file] = idx[file] || 0);
      idx[file] = i + 1;
      return arr[i] ?? arr[arr.length - 1];
    },
  };
}
function fakeFs(files) {
  const store = new Map(Object.entries(files));
  return {
    exists: (p) => store.has(p),
    readFile: (p) => (store.has(p) ? store.get(p) : null),
    writeFile: (p, c) => store.set(p, c),
  };
}

const src = 'export const WARNING = "danger: prod";\n';
// Both the working tree (root) and the base worktree (tmp) carry the source + the test file.
const baseFiles = () => ({ "/wt/src/warn.js": src, "/root/src/warn.js": src, "/root/test/warn.test.js": "// test" });

// (a) own-cal R1 cf1 regression: a guard test that stays green under a mutation asserts nothing.
test("(a) a new guard test that is not fail-closed → ok:false naming the survivor (via mutation-check)", async () => {
  const fs = fakeFs(baseFiles());
  // baseline green, then the string mutation runs green too → the test never noticed the change.
  const run = makeFakeRun([wtAdd(), wtOther(), npmci(), vitestSeq({ "test/warn.test.js": [ok, ok] })]);
  const res = await runSelfGate({
    root: "/root", harness, run,
    contract: [{ id: "dw1", check: { kind: "test", ref: "test_warn" }, rubric: "warns on prod" }],
    roster: ["correctness"], tier: "standard", gates: { schema: "factory.gates.v1", status: "GREEN" },
    changedTests: [{ file: "test/warn.test.js", target: "src/warn.js" }], changedSources: ["src/warn.js"],
    mutation: { tmp: "/wt", exists: fs.exists, readFile: fs.readFile, writeFile: fs.writeFile },
  });
  expect(res.ok).toBe(false);
  expect(res.ranChecks).toContain("mutation");
  const detail = res.findings.filter((f) => f.blocking).map((f) => f.detail).join(" ");
  expect(detail).toContain("survivor");
  expect(detail).toContain("test/warn.test.js");
});

// (b) a red gates result → ok:false (the self-gate composes the reviewer's first deterministic check).
test("(b) a red gates result → ok:false", async () => {
  const res = await runSelfGate({
    root: "/root", harness, run: makeFakeRun([]),
    contract: [], roster: ["correctness"], tier: "standard",
    gates: { schema: "factory.gates.v1", status: "RED", reason: "failing=unit" },
    changedTests: [], changedSources: [],
  });
  expect(res.ok).toBe(false);
  expect(res.ranChecks).toContain("gates");
  expect(summarizeFindings(res.findings)).toContain("RED");
});

// (c) a clean, fail-closed impl → ok:true. Gates GREEN + the new test IS fail-closed (a kill).
test("(c) clean fail-closed impl → ok:true", async () => {
  const fs = fakeFs(baseFiles());
  // baseline green, then the mutation goes assertion-red → the test IS fail-closed (a kill, not a survivor).
  const run = makeFakeRun([wtAdd(), wtOther(), npmci(), vitestSeq({ "test/warn.test.js": [ok, assertionRed] })]);
  const res = await runSelfGate({
    root: "/root", harness, run,
    roster: ["correctness"], tier: "standard", gates: { schema: "factory.gates.v1", status: "GREEN" },
    changedTests: [{ file: "test/warn.test.js", target: "src/warn.js" }], changedSources: ["src/warn.js"],
    mutation: { tmp: "/wt", exists: fs.exists, readFile: fs.readFile, writeFile: fs.writeFile },
  });
  expect(res.ok).toBe(true);
  expect(res.findings.filter((f) => f.blocking)).toEqual([]);
  expect(res.ranChecks).toEqual(expect.arrayContaining(["gates", "mutation"]));
});

// Defect A: a STANDARD-tier issue (its review roster has qa) with NO qa manifest present at implement
// time must NOT block. The manifest is written by the qa reviewer at REVIEW, never by the builder here,
// so its absence is expected — the self-gate never grades qa evidence and never runs a "contract" check.
test("Defect A: a standard-tier issue (roster has qa) with no manifest does NOT block at implement", async () => {
  const fs = fakeFs(baseFiles());
  const run = makeFakeRun([wtAdd(), wtOther(), npmci(), vitestSeq({ "test/warn.test.js": [ok, assertionRed] })]);
  const res = await runSelfGate({
    root: "/root", harness, run,
    // roster has qa (a standard-tier review roster) — pre-fix this ran finish() and demanded a manifest.
    roster: ["correctness", "qa"], tier: "standard", gates: { schema: "factory.gates.v1", status: "GREEN" },
    changedTests: [{ file: "test/warn.test.js", target: "src/warn.js" }], changedSources: ["src/warn.js"],
    // qaEvidence must never be consulted at implement — the manifest cannot exist yet.
    qaEvidence: () => { throw new Error("self-gate must not grade qa evidence at implement"); },
    mutation: { tmp: "/wt", exists: fs.exists, readFile: fs.readFile, writeFile: fs.writeFile },
  });
  expect(res.ok).toBe(true);
  expect(res.findings.filter((f) => f.blocking)).toEqual([]);
  // no "contract" check is run — the qa manifest is graded at review, not here.
  expect(res.ranChecks).not.toContain("contract");
  expect(res.findings.some((f) => f.check === "contract")).toBe(false);
});

// A misconfigured mutation check (harness cannot run a single test) is a harness-class finding the
// builder cannot fix — the caller routes it to a human, not a builder retry.
test("a misconfigured mutation check is a harness-class blocking finding", async () => {
  const res = await runSelfGate({
    root: "/root", harness: { commands: {} }, run: makeFakeRun([]),
    contract: [], roster: ["correctness"], tier: "standard", gates: { schema: "factory.gates.v1", status: "GREEN" },
    changedTests: [{ file: "test/warn.test.js", target: "src/warn.js" }], changedSources: ["src/warn.js"],
  });
  expect(res.ok).toBe(false);
  expect(harnessFinding(res.findings)).toBe(true);
});

// ── Structure D (review-efficiency Task 5) — regression pins carried across rework ─────────────
// A carried pin re-runs its guard test at the self-gate BEFORE another review round. A guardable pin
// (a runnable test) is a HARD gate; a prose pin is advisory only (spec §9 Q5: no unsatisfiable loop).
const vitestRun = (result) => makeFakeRun([{ match: (c, a) => c === "bash" && a[1].includes("vitest"), result }]);
const pinBase = { root: "/root", harness, contract: [], roster: ["correctness"], tier: "standard", gates: { schema: "factory.gates.v1", status: "GREEN" }, changedTests: [], changedSources: [] };

// KTB #18 R3: fixing round-2's must_fix introduced a new defect under the SAME id. A guardable pin
// re-run at the self-gate goes red → the handoff is blocked before another full review round.
test("Task 5 / KTB #18 R3: a carried guardable pin whose guard test is RED → ok:false naming the pin id (handoff blocked)", async () => {
  const res = await runSelfGate({
    ...pinBase, run: vitestRun(assertionRed),
    pins: [{ id: "dw1", guard: { kind: "test", ref: "test_7_create" }, text: "POST /notes returns 201" }],
  });
  expect(res.ok).toBe(false);
  expect(res.ranChecks).toContain("pins");
  const blocking = res.findings.filter((f) => f.blocking);
  expect(blocking.flatMap((f) => f.ids || [])).toContain("dw1");
  expect(blocking.map((f) => f.detail).join(" ")).toMatch(/regress/i);
});

test("Task 5: a guardable pin whose guard test is GREEN does not block (the pinned property held)", async () => {
  const res = await runSelfGate({
    ...pinBase, run: vitestRun(ok),
    pins: [{ id: "dw1", guard: { kind: "test", ref: "test_7_create" }, text: "t" }],
  });
  expect(res.ok).toBe(true);
  expect(res.findings.filter((f) => f.blocking)).toEqual([]);
  expect(res.ranChecks).toContain("pins");
});

test("Task 5: an advisory (prose) pin is surfaced but NEVER blocks — no unsatisfiable loop (spec §9 Q5)", async () => {
  const res = await runSelfGate({
    ...pinBase, run: makeFakeRun([]),   // a prose pin runs nothing — a fabricated guard would loop forever
    pins: [{ id: "mf-prose", guard: null, text: "the heading is misleading" }],
  });
  expect(res.ok).toBe(true);
  expect(res.findings.filter((f) => f.blocking)).toEqual([]);
  expect(advisoryFindings(res.findings).map((f) => f.detail).join(" ")).toContain("mf-prose");
});

test("Task 5: a guardable pin whose guard cannot run (module/parse error, no test matched) is advisory, not blocking — no unsatisfiable loop", async () => {
  const cantRun = { code: 1, stdout: "", stderr: "Cannot find module 'vitest'" };
  const res = await runSelfGate({
    ...pinBase, run: vitestRun(cantRun),
    pins: [{ id: "dw1", guard: { kind: "test", ref: "test_7_create" }, text: "t" }],
  });
  expect(res.ok).toBe(true);
  expect(res.findings.filter((f) => f.blocking)).toEqual([]);
  expect(advisoryFindings(res.findings).length).toBeGreaterThan(0);
});

// Portability (should_fix 1): the guard runs through the harness's OWN named-test contract (test_one),
// NOT a hardcoded `-t`. A Flutter harness's test_one is `flutter test {file} --plain-name {name}`.
const flutterHarness = { commands: { test_files: "flutter test {files}", test_one: "flutter test {file} --plain-name {name}" }, test: { test_glob: ["test/**/*_test.dart"] } };

test("Task 5: a Flutter guard runs through the harness's own test_one (--plain-name), a real red → blocking", async () => {
  const run = makeFakeRun([{ match: (c, a) => c === "bash" && a[1].includes("flutter") && a[1].includes("--plain-name"), result: { code: 1, stdout: "", stderr: "Expected: <201>\n  Actual: <500>" } }]);
  const res = await runSelfGate({
    ...pinBase, harness: flutterHarness, run, changedTests: [{ file: "test/warn_test.dart" }],
    pins: [{ id: "dw1", guard: { kind: "test", ref: "test_create" }, text: "creates a note" }],
  });
  expect(res.ok).toBe(false);
  const blocking = res.findings.filter((f) => f.blocking);
  expect(blocking.flatMap((f) => f.ids || [])).toContain("dw1");
  // the command used the harness's flag, never `-t` — proof the runner was addressed portably.
  expect(run.calls.some((c) => c.args[1].includes("--plain-name") && !c.args[1].includes("-t "))).toBe(true);
});

test("should_fix 1 / portability: a non-JS harness that cannot express a name filter (no test_one) → guard is ADVISORY, not blocking", async () => {
  const nonJs = { commands: { test_files: "flutter test {files}" }, test: { test_glob: ["test/**/*_test.dart"] } };
  const res = await runSelfGate({
    // run is empty on purpose: an unknown runner must never be invoked with a fabricated `-t`, so the
    // guard is downgraded to advisory WITHOUT running anything (a run call would throw here).
    ...pinBase, harness: nonJs, run: makeFakeRun([]), changedTests: [{ file: "test/warn_test.dart" }],
    pins: [{ id: "dw1", guard: { kind: "test", ref: "test_create" }, text: "creates a note" }],
  });
  expect(res.ok).toBe(true);
  expect(res.findings.filter((f) => f.blocking)).toEqual([]);
  expect(advisoryFindings(res.findings).map((f) => f.detail).join(" ")).toContain("dw1");
});

test("Task 5: a guard whose runner rejects the command (unrecognized option) classifies as can't-run → advisory, never a false regression", async () => {
  const run = makeFakeRun([{ match: (c, a) => c === "bash" && a[1].includes("flutter"), result: { code: 64, stdout: "", stderr: 'Could not find an option named "-t".' } }]);
  const res = await runSelfGate({
    ...pinBase, harness: flutterHarness, run, changedTests: [{ file: "test/warn_test.dart" }],
    pins: [{ id: "dw1", guard: { kind: "test", ref: "test_create" }, text: "t" }],
  });
  expect(res.ok).toBe(true);
  expect(res.findings.filter((f) => f.blocking)).toEqual([]);
});

test("Task 5: with no test_one, a recognizably vitest test_files still takes the -t fallback (JS name filter)", async () => {
  const res = await runSelfGate({
    ...pinBase, run: vitestRun(assertionRed),   // pinBase.harness is the vitest fixture (test_files only)
    pins: [{ id: "dw1", guard: { kind: "test", ref: "test_create" }, text: "t" }],
  });
  expect(res.ok).toBe(false);
  expect(res.findings.filter((f) => f.blocking).flatMap((f) => f.ids || [])).toContain("dw1");
});

// mutation-check skips (deliberately under-fires) and are advisory, not blocking.
test("mutation-check skips are advisory, not blocking", async () => {
  const fs = fakeFs({ "/root/test/x.test.js": "// no import", "/wt/x": "x" });
  const run = makeFakeRun([wtAdd(), wtOther(), npmci()]);
  const res = await runSelfGate({
    root: "/root", harness, run,
    contract: [], roster: ["correctness"], tier: "standard", gates: { schema: "factory.gates.v1", status: "GREEN" },
    changedTests: [{ file: "test/x.test.js" }], changedSources: ["src/x.js"],
    mutation: { tmp: "/wt", exists: fs.exists, readFile: fs.readFile, writeFile: fs.writeFile },
  });
  expect(res.ok).toBe(true);
  expect(advisoryFindings(res.findings).length).toBeGreaterThan(0);
});

// 1.4.28 (L31, own-calendar #43–#47): a test-only diff has no change for the new tests to guard — the mutation check is
// skipped (no-input, recorded), not run against whatever module the test happens to import.
test("mutation check is skipped for a test-only (characterization) diff and says why", async () => {
  const { SKIP_REASONS } = await import("../lib/self-gate.js");
  const run = makeFakeRun([]);   // nothing may be spawned — no worktree, no npm ci
  const res = await runSelfGate({
    root: "/root", harness, run,
    contract: [], roster: ["correctness"], tier: "standard", gates: { schema: "factory.gates.v1", status: "GREEN" },
    changedTests: [{ file: "server/tests/categories.test.ts" }], changedSources: [],
  });
  expect(res.ok).toBe(true);
  expect(res.ranChecks).not.toContain("mutation");
  const skip = res.skippedChecks.find((s) => s.check === "mutation");
  expect(skip).toMatchObject({ reason: SKIP_REASONS.NO_INPUT, detail: expect.stringContaining("test-only diff (characterization)") });
  expect(run.calls).toHaveLength(0);
});

/**
 * ── 피드백 루프 (T3 재리뷰 NEW-MF-1) — **"안 돌았다"와 "왜 안 돌았다"는 다른 사실이다** ──────────
 * `ranChecks`의 부재만으로는 "KTB가 검사를 거둬들였다"와 "이번 라운드에 볼 것이 없었다"를 가를 수
 * 없었고, 그 틈으로 **막힌 테스트를 지운 빌더**가 자기 차단을 KTB의 엔진 결함으로 만들 수 있었다.
 */
test("runSelfGate records why each check did not run, and the detail line carries ran/skipped/ktb_version", async () => {
  const { runSelfGate, selfGateDetailLine, SELF_GATE_DETAIL_PREFIX, SKIP_REASONS } = await import("../lib/self-gate.js");
  const harness = { commands: {}, test: {} };

  // 입력이 하나도 없는 라운드: 세 검사 모두 `no-input`으로 **기록된다**(조용히 사라지지 않는다)
  const none = await runSelfGate({ root: "/r", harness, gates: null, run: async () => ({ code: 0, stdout: "", stderr: "" }), changedTests: [], pins: [] });
  expect(none.ranChecks).toEqual([]);
  expect(none.skippedChecks.map((s) => s.check).sort()).toEqual(["gates", "mutation", "pins"]);
  for (const s of none.skippedChecks) expect(s.reason).toBe(SKIP_REASONS.NO_INPUT);
  expect(none.ok).toBe(true);

  // gates 결과가 있으면 gates는 돌고 skipped에서 빠진다
  const withGates = await runSelfGate({ root: "/r", harness, gates: { schema: "factory.gates.v1", status: "RED" }, run: async () => ({ code: 0 }), changedTests: [], pins: [] });
  expect(withGates.ranChecks).toEqual(["gates"]);
  expect(withGates.skippedChecks.map((s) => s.check).sort()).toEqual(["mutation", "pins"]);
  expect(withGates.ok).toBe(false);

  // 줄은 한 줄 JSON이고, 자기 런과 그 런의 팩토리 버전을 지목한다
  const line = selfGateDetailLine(withGates, { runId: "771", runnerId: "gha-771", ktbVersion: "1.3.2" });
  expect(line.startsWith(SELF_GATE_DETAIL_PREFIX)).toBe(true);
  const o = JSON.parse(line.slice(SELF_GATE_DETAIL_PREFIX.length));
  expect(o).toMatchObject({ run_id: "771", runner: "gha-771", ktb_version: "1.3.2", blocked: true, harness: false, ran: ["gates"] });
  expect(o.skipped).toEqual([{ check: "mutation", reason: "no-input" }, { check: "pins", reason: "no-input" }]);
  // 모르면 지어내지 않는다 — 버전을 못 읽은 런은 withdrawal 증거를 만들 수 없다
  expect(JSON.parse(selfGateDetailLine(withGates, {}).slice(SELF_GATE_DETAIL_PREFIX.length)).ktb_version).toBeNull();
  // 증거 수집이 판정을 막지 않는다
  expect(selfGateDetailLine(null, {})).toContain(SELF_GATE_DETAIL_PREFIX);
});

test("isNewerVersion compares numerically, and an unknown version is never 'newer'", async () => {
  const { isNewerVersion } = await import("../lib/feedback/harvest-findings.js");
  expect(isNewerVersion("1.3.10", "1.3.2")).toBe(true);      // 문자열 비교였다면 false였다
  expect(isNewerVersion("1.4.0", "1.3.9")).toBe(true);
  expect(isNewerVersion("1.3.2", "1.3.2")).toBe(false);
  expect(isNewerVersion("1.3.1", "1.3.2")).toBe(false);
  expect(isNewerVersion(null, "1.3.2")).toBe(false);
  expect(isNewerVersion("1.3.2", null)).toBe(false);
  expect(isNewerVersion("", "")).toBe(false);
});

/**
 * #174 — 재시작 브리프가 실린 라운드의 self-gate는 브리프 `where` 밖의 **새 파일**을 RED로 막는다. "새 파일"의 기준점은 merge-base가
 * 아니라 **재시작 head**다: 옛 작성자가 1라운드에 더한 파일은 이미 PR의 diff이고, 새 작성자는 그 diff에서 출발한다. 목록 계산(git)은
 * run-stage(`restartBriefInput`)가 하고, self-gate.js는 그 목록을 판정만 하는 순수 평가기로 남는다.
 */
import { restartBriefInput } from "../bin/run-stage.js";
test("test_174_self_gate_new_files_measured_from_restart_head", async () => {
  const head = "f".repeat(40);
  const brief = { pr: 31, head, scope: "s", paths: ["factory/lib/self-gate.js", "factory/test/new-guard.test.js"], findings: [] };
  // restart head의 트리: 옛 PR이 이미 더한 파일(round1.js)이 거기 있다.
  const treeAt = (sha) => ({
    match: (c, a) => c === "git" && a[0] === "ls-tree" && a.includes(sha),
    result: { code: 0, stdout: ["README.md", "factory/lib/self-gate.js", "factory/lib/round1.js"].join("\0") + "\0", stderr: "" },
  });
  // merge-base 대비 추가된 파일들(changedFiles().added가 내는 바로 그 목록).
  const added = ["factory/lib/round1.js", "factory/lib/extra-parser.js", "factory/test/new-guard.test.js", "factory/lib/self-gate.js"];
  const input = await restartBriefInput({ run: makeFakeRun([treeAt(head)]), cwd: "/root", brief, added });
  expect(input).toEqual({ paths: brief.paths, newFiles: ["factory/lib/extra-parser.js", "factory/test/new-guard.test.js"] });

  const gates = { schema: "factory.gates.v1", status: "GREEN" };
  const red = await runSelfGate({ root: "/root", harness, run: makeFakeRun([]), gates, changedTests: [], changedSources: [], restartBrief: input });
  expect(red.ok).toBe(false);
  expect(red.ranChecks).toContain("restart-brief");
  const blocking = red.findings.filter((f) => f.blocking);
  expect(blocking).toHaveLength(1);                                     // round1.js(옛 PR)·new-guard(브리프가 이름 댄 파일)는 통과
  expect(blocking[0].detail).toBe("new file outside the restart brief: factory/lib/extra-parser.js");

  // added에 옛 PR이 재시작 전에 더한 파일만 있는 라운드는 통과한다. 수정(M)·삭제(D)·이름 바꾸기(R)가 added에 들어오는지 아닌지는
  // 이 순수 평가기가 아니라 호출 자리(run-stage)가 정한다 — 실제 git 저장소로 핀한 것은 run-stage.test.js의
  // test_174_self_gate_dep_new_files_with_real_git_edits_deletions_and_renames다.
  const editsOnly = await restartBriefInput({ run: makeFakeRun([treeAt(head)]), cwd: "/root", brief, added: ["factory/lib/round1.js"] });
  const pass = await runSelfGate({ root: "/root", harness, run: makeFakeRun([]), gates, changedTests: [], changedSources: [], restartBrief: editsOnly });
  expect(pass.ok).toBe(true);
  expect(pass.ranChecks).toContain("restart-brief");

  // 재시작 head를 못 읽거나 브리프 블록이 깨졌으면 fail closed — "전부 허용"이 아니다.
  const unreadable = await restartBriefInput({ run: makeFakeRun([{ match: (c) => c === "git", result: { code: 128, stdout: "", stderr: "fatal: not a tree object" } }]), cwd: "/root", brief, added });
  const r1 = await runSelfGate({ root: "/root", harness, run: makeFakeRun([]), gates, changedTests: [], changedSources: [], restartBrief: unreadable });
  expect(r1.ok).toBe(false);
  expect(summarizeFindings(r1.findings)).toMatch(/restart head .* cannot be read/);
  const broken = await restartBriefInput({ run: makeFakeRun([treeAt(head)]), cwd: "/root", brief: { pr: 31, head, error: "the factory.k-restart-brief.v1 block is missing or unparsable" }, added });
  const r2 = await runSelfGate({ root: "/root", harness, run: makeFakeRun([]), gates, changedTests: [], changedSources: [], restartBrief: broken });
  expect(r2.ok).toBe(false);
  expect(summarizeFindings(r2.findings)).toMatch(/unparsable/);

  // 브리프가 없으면 결과는 오늘과 같다(바이트 하나 다르지 않다).
  const today = await runSelfGate({ root: "/root", harness, run: makeFakeRun([]), gates, changedTests: [], changedSources: [] });
  const withNull = await runSelfGate({ root: "/root", harness, run: makeFakeRun([]), gates, changedTests: [], changedSources: [], restartBrief: null });
  expect(withNull).toEqual(today);
  expect(JSON.stringify(withNull)).toBe(JSON.stringify(today));
});

test("test_174_restart_brief_allows_named_files_only_never_a_directory_prefix", async () => {
  const gates = { schema: "factory.gates.v1", status: "GREEN" };
  // Even if a directory reached the allow-list, it must not admit every file under it: only exact paths pass.
  const restartBrief = { paths: ["factory/test/", "factory/lib", "factory/lib/self-gate.js"], newFiles: ["factory/test/new-guard.test.js", "factory/lib/extra.js", "factory/lib/self-gate.js"] };
  const r = await runSelfGate({ root: "/root", harness, run: makeFakeRun([]), gates, changedTests: [], changedSources: [], restartBrief });
  expect(r.ok).toBe(false);
  expect(r.findings.filter((f) => f.blocking).map((f) => f.detail)).toEqual([
    "new file outside the restart brief: factory/test/new-guard.test.js",
    "new file outside the restart brief: factory/lib/extra.js",
  ]);
});

/**
 * ── #200 — `scope`: a path outside the plan's `files_expected` must carry a `Scope change (#<issue>)` line in the diff ───
 * The pure judge. run-stage (`makeSelfGateDep`) reads git and hands it `{ issue, plan, filesExpected, changes }`, where
 * `changes` is every path of `git diff --no-renames <base>...HEAD` with its status and ONLY the lines that diff added.
 * Removed and context lines never reach `added`, so a token that lives on one of them cannot satisfy the check — the
 * callers below model that by putting such text anywhere except `added`.
 */
// #200 — files_expected entries glob.js would hang on (or throw on). glob.js is mocked to delegate to the real module, except
// that one of these entries THROWS instead of compiling — so a missing guard surfaces as a RED assertion, never as a hang.
const { POISON_200, globCalls200 } = vi.hoisted(() => ({
  POISON_200: ["factory/lib/{a,b.js", "*********************b", "*a*a*a*a*b", "factory/{*}.js", "factory/{a*a*a*a*}.js", "factory/{a?,b}.js"],
  globCalls200: [],
}));
vi.mock("../lib/glob.js", async (importOriginal) => {
  const real = await importOriginal();
  const guard = (g) => { globCalls200.push(g); if (POISON_200.includes(g)) throw new Error(`glob.js reached with the malformed entry ${JSON.stringify(g)}`); };
  return {
    ...real,
    globToRegex: (g) => { guard(g); return real.globToRegex(g); },
    matchesAny: (globs, file) => { globs.forEach(guard); return real.matchesAny(globs, file); },
  };
});
const SCOPE_GATES = { schema: "factory.gates.v1", status: "GREEN" };
const scopeRun = (scope) => runSelfGate({ root: "/root", harness, run: makeFakeRun([]), gates: SCOPE_GATES, changedTests: [], changedSources: [], scope });
const scopeBlocking = (r) => r.findings.filter((f) => f.check === "scope" && f.blocking);
const FE200 = ["factory/lib/self-gate.js", "factory/bin/run-stage.js", "factory/test/*.test.js", "factory/test/fixtures/"];

test("test_200_scope_check_blocks_an_outside_path_without_a_scope_change_line", async () => {
  const outside = "factory/lib/glob.js";
  const base = (outsideAdded, extra = []) => ({
    issue: 200, plan: true, filesExpected: FE200,
    changes: [
      { path: "factory/lib/self-gate.js", status: "M", added: ["export const x = 1;"] },          // exact entry, no line → passes
      { path: "factory/test/self-gate.test.js", status: "M", added: ["test('x', () => {});"] },   // glob entry, no line → passes
      { path: "factory/test/fixtures/deep/a.json", status: "A", added: ["{}"] },                    // under a trailing-`/` entry → passes
      { path: outside, status: "M", added: outsideAdded },
      ...extra,
    ],
  });

  // No line anywhere → RED, and the builder-facing text names the exact path and the exact line it needs.
  const red = await scopeRun(base(["export const y = 2;"]));
  expect(red.ok).toBe(false);
  expect(red.ranChecks).toContain("scope");
  const b = scopeBlocking(red);
  expect(b).toHaveLength(1);
  expect(b[0].harness).toBeFalsy();
  expect(b[0].detail.startsWith(`${outside} is outside files_expected and carries no "Scope change (#200)" line`)).toBe(true);
  expect(summarizeFindings(b).startsWith(`scope: ${outside} is outside files_expected and carries no "Scope change (#200)" line`)).toBe(true);

  // The line among the path's own added lines → GREEN.
  const green = await scopeRun(base(["// Scope change (#200): the matcher needs a directory prefix rule — dw1", "export const y = 2;"]));
  expect(scopeBlocking(green)).toEqual([]);
  expect(green.ok).toBe(true);
  expect(green.ranChecks).toContain("scope");

  // Tokens that do NOT satisfy it: another issue's header carried over (and a longer number that merely starts with 200).
  for (const line of ["// Scope change (#199): carried over from another issue", "// Scope change (#2000): a different issue", "// scope change (#200) lower-case is not the convention"]) {
    const r = await scopeRun(base([line]));
    expect(scopeBlocking(r).map((f) => f.detail.split(" ")[0]), line).toEqual([outside]);
  }
  // A token on a removed or a context line is dropped by run-stage's diff parser before it reaches `added` — that property
  // is pinned where it lives, against real git: test_200_scope_check_ignores_a_token_on_a_removed_line and
  // test_200_added_lines_by_path_keeps_only_plus_lines (run-stage.test.js).

  // A second outside path is judged on its own: a line in glob.js covers glob.js only.
  const two = await scopeRun(base(["// Scope change (#200): dw1"], [{ path: "factory/lib/mirror.js", status: "M", added: ["export const z = 1;"] }]));
  expect(scopeBlocking(two).map((f) => f.detail.split(" ")[0])).toEqual(["factory/lib/mirror.js"]);

  // A trailing-`/` entry is a prefix, not a glob that matches nothing: without it, the fixture would be RED.
  const noPrefix = await scopeRun({ ...base(["// Scope change (#200): dw1"]), filesExpected: FE200.filter((e) => !e.endsWith("/")) });
  expect(scopeBlocking(noPrefix).map((f) => f.detail.split(" ")[0])).toEqual(["factory/test/fixtures/deep/a.json"]);
  // …and the prefix stops at a path boundary: `factory/test/fixtures-old/x` is not under `factory/test/fixtures/`.
  const sibling = await scopeRun(base(["// Scope change (#200): dw1"], [{ path: "factory/test/fixtures-old/x.json", status: "A", added: ["{}"] }]));
  expect(scopeBlocking(sibling).map((f) => f.detail.split(" ")[0])).toEqual(["factory/test/fixtures-old/x.json"]);
});

test("test_200_scope_check_accepts_an_outside_path_named_elsewhere", async () => {
  const fe = ["factory/lib/self-gate.js"];
  const judge = (changes) => scopeRun({ issue: 200, plan: true, filesExpected: fe, changes });
  const blockedPaths = (r) => scopeBlocking(r).map((f) => f.detail.split(" ")[0]).sort();
  const deleted = { path: "factory/lib/foo.js", status: "D", added: [] };
  const json = { path: "factory/test/fixtures/run.json", status: "M", added: ['{"a": 1}'] };
  const png = { path: "docs/img/flow.png", status: "A", added: [] };
  const own = (lines) => ({ path: "factory/lib/self-gate.js", status: "M", added: lines });

  // Nothing names them → all three RED.
  expect(blockedPaths(await judge([own(["x"]), deleted, json, png]))).toEqual(["docs/img/flow.png", "factory/lib/foo.js", "factory/test/fixtures/run.json"]);

  // One added line elsewhere names each one together with the token → GREEN (a deleted file, a JSON fixture, a binary).
  const named = await judge([own([
    "// Scope change (#200): factory/lib/foo.js is deleted — its parser moved here (dw2)",
    "// Scope change (#200): `factory/test/fixtures/run.json` gains the field the new reader needs.",
    "// Scope change (#200): docs/img/flow.png, the diagram of this gate",
  ]), deleted, json, png]);
  expect(blockedPaths(named)).toEqual([]);
  expect(named.ok).toBe(true);

  // Path boundaries: a longer path that merely starts with P, or ends with it, does not name P.
  const longer = await judge([own([
    "// Scope change (#200): factory/lib/foo.js.bak is the backup",
    "// Scope change (#200): old/factory/lib/foo.js moved",
    "// Scope change (#200): xfactory/lib/foo.js",
  ]), deleted]);
  expect(blockedPaths(longer)).toEqual(["factory/lib/foo.js"]);

  // A reason for a different file, a token with no path, the path without the token, or another issue's token → RED.
  for (const line of [
    "// Scope change (#200): factory/lib/bar.js is deleted",
    "// Scope change (#200): cleanup",
    "// removed factory/lib/foo.js (no token)",
    "// Scope change (#199): factory/lib/foo.js is deleted",
  ]) {
    expect(blockedPaths(await judge([own([line]), deleted])), line).toEqual(["factory/lib/foo.js"]);
  }
  // The token and the path on two DIFFERENT added lines do not combine.
  expect(blockedPaths(await judge([own(["// Scope change (#200): see below", "// factory/lib/foo.js"]), deleted]))).toEqual(["factory/lib/foo.js"]);

  // A token line on an outside file's OWN added lines makes that file GREEN (dw1), whatever other changed path it also
  // names — and it covers the path it names (dw2). The finding never tells a builder to add a line that is already there
  // (review cf1/spec1/qa1: "fixtures for factory/lib/self-gate.js" named the in-scope module and kept the host RED).
  const hostA = (lines) => ({ path: "factory/lib/a.js", status: "M", added: lines });
  expect(blockedPaths(await judge([own(["x"]), hostA(["// Scope change (#200): factory/lib/foo.js is deleted"]), deleted]))).toEqual([]);
  const helper = { path: "factory/test/helper.js", status: "A", added: ["// Scope change (#200): fixtures for the scope check in factory/lib/self-gate.js — dw1"] };
  expect(blockedPaths(await judge([{ path: "factory/lib/self-gate.js", status: "M", added: ["x"] }, helper]))).toEqual([]);
  expect(blockedPaths(await judge([own(["x"]), hostA(["// Scope change (#200): factory/lib/a.js replaces factory/lib/foo.js"]), deleted]))).toEqual([]);
  expect(blockedPaths(await judge([own(["x"]), hostA(["// Scope change (#200): the shared reader — dw2", "// Scope change (#200): factory/lib/foo.js is deleted"]), deleted]))).toEqual([]);

  // A path with a space is named whole: a reason for `docs/my notes.md` never covers the changed path `docs/my` that is
  // its space-delimited prefix (nor `factory/lib/a` for `factory/lib/a b.js`) from another file; a token on a path's own
  // added lines still makes that path GREEN (dw1).
  const spaced = { path: "docs/my notes.md", status: "D", added: [] };
  const prefix = { path: "docs/my", status: "D", added: [] };
  expect(blockedPaths(await judge([own(["// Scope change (#200): docs/my notes.md is folded into the gate docs"]), spaced, prefix]))).toEqual(["docs/my"]);
  expect(blockedPaths(await judge([own(["// Scope change (#200): docs/my notes.md and docs/my are folded in"]), spaced, prefix]))).toEqual([]);
  const spacedJs = { path: "factory/lib/a b.js", status: "A", added: ["// Scope change (#200): factory/lib/a b.js is the new reader"] };
  const prefixHost = { path: "factory/lib/a", status: "A", added: ["// Scope change (#200): factory/lib/a b.js is the new reader"] };
  expect(blockedPaths(await judge([own(["x"]), spacedJs, prefixHost]))).toEqual([]);
  expect(blockedPaths(await judge([own(["x"]), spacedJs, { ...prefixHost, added: ["x"] }]))).toEqual(["factory/lib/a"]);
});

test("test_200_scope_reason_for_the_mirror_twin_never_covers_the_source_path", async () => {
  // Every engine file here has a `.factory/` twin: a reason written for `.factory/lib/foo.js` must not clear the deleted
  // source `factory/lib/foo.js` from another file (dw2) — the `.` before the match continues the path.
  const judge = (lines) => scopeRun({ issue: 200, plan: true, filesExpected: ["factory/lib/self-gate.js"], changes: [
    { path: "factory/lib/self-gate.js", status: "M", added: lines },
    { path: "factory/lib/foo.js", status: "D", added: [] },
  ] });
  const blockedPaths = (r) => scopeBlocking(r).map((f) => f.detail.split(" ")[0]);
  for (const line of [
    "// Scope change (#200): .factory/lib/foo.js is regenerated by the runner",
    "// Scope change (#200): `.factory/lib/foo.js` is regenerated by the runner",
  ]) {
    const r = await judge([line]);
    expect(blockedPaths(r), line).toEqual(["factory/lib/foo.js"]);
    expect(r.ok, line).toBe(false);
  }
  // The same sentence naming the source path itself clears it — the RED above is the `.` boundary, not the wording.
  expect(blockedPaths(await judge(["// Scope change (#200): factory/lib/foo.js is regenerated by the runner"]))).toEqual([]);
});

test("test_200_scope_check_ignores_mirror_and_run_record_paths", async () => {
  const fe = ["factory/lib/self-gate.js"];
  const changes = [
    { path: ".factory/lib/self-gate.js", status: "M", added: ["x"] },
    { path: ".factory/bin/run-stage.js", status: "M", added: ["x"] },
    { path: ".factory/actions/a.yml", status: "M", added: ["x"] },
    { path: ".factory/install-manifest.json", status: "M", added: ["x"] },
    { path: ".claude/hooks/block-dangerous.sh", status: "M", added: ["x"] },
    { path: "docs/factory/runs/200.md", status: "M", added: ["x"] },
    { path: "docs/factory/runs/nested/1.md", status: "A", added: ["x"] },
    { path: "factory/lib/self-gate.js", status: "M", added: ["x"] },
  ];
  const r = await scopeRun({ issue: 200, plan: true, filesExpected: fe, changes });
  expect(r.ranChecks).toContain("scope");
  expect(r.findings.filter((f) => f.check === "scope")).toEqual([]);
  expect(r.ok).toBe(true);

  // The exclusion is mirror.js's own rule, not a broader prefix: a non-`.sh` file under `.claude/hooks/`, a sibling of
  // the manifest, another `.factory/` path and a `docs/factory/` file that is not a run record are still judged.
  const judged = [
    { path: ".claude/hooks/README.md", status: "A", added: ["x"] },
    { path: ".factory/install-manifest.json.bak", status: "A", added: ["x"] },
    { path: ".factory/harness.toml", status: "M", added: ["x"] },
    { path: "docs/factory/runs.md", status: "M", added: ["x"] },
    { path: "docs/factory/DECISIONS.md", status: "M", added: ["x"] },
  ];
  const red = await scopeRun({ issue: 200, plan: true, filesExpected: fe, changes: [...changes, ...judged] });
  expect(scopeBlocking(red).map((f) => f.detail.split(" ")[0]).sort()).toEqual(judged.map((c) => c.path).sort());
});

test("test_200_scope_check_skips_without_files_expected", async () => {
  const { selfGateDetailLine, SELF_GATE_DETAIL_PREFIX } = await import("../lib/self-gate.js");
  const changes = [{ path: "factory/lib/glob.js", status: "M", added: ["export const y = 2;"] }];
  const cases = [
    [{ issue: 200, plan: false, filesExpected: undefined, changes }, /no plan handoff/],
    [{ issue: 200, plan: true, filesExpected: [], changes }, /files_expected is empty/],
    [{ issue: 200, plan: true, filesExpected: "factory/lib/self-gate.js", changes }, /files_expected is not an array/],
  ];
  const details = [];
  for (const [scope, why] of cases) {
    const r = await scopeRun(scope);
    expect(r.findings.filter((f) => f.check === "scope")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.ranChecks).not.toContain("scope");
    const s = r.skippedChecks.filter((x) => x.check === "scope");
    expect(s).toHaveLength(1);
    expect(s[0].detail.startsWith("skipped — ")).toBe(true);
    expect(s[0].detail).toMatch(why);
    details.push(s[0].detail);
    // The run record's machine line carries the reason, so "not checked (and why)" is readable from the record alone.
    const o = JSON.parse(selfGateDetailLine(r, { runId: "1", runnerId: "gha-1", ktbVersion: "1.4.0" }).slice(SELF_GATE_DETAIL_PREFIX.length));
    const recorded = o.skipped.filter((x) => x.check === "scope");
    expect(recorded).toEqual([{ check: "scope", reason: s[0].reason, detail: s[0].detail }]);
  }
  expect(new Set(details).size).toBe(3);                                   // each case names itself

  // A judged round with nothing out of scope is a different record: scope ran, nothing skipped.
  const clean = await scopeRun({ issue: 200, plan: true, filesExpected: ["factory/lib/glob.js"], changes });
  expect(clean.ranChecks).toContain("scope");
  expect(clean.skippedChecks.filter((x) => x.check === "scope")).toEqual([]);

  // No scope input at all (null / absent) → exactly today's result: no ran or skipped entry for scope, same bytes.
  const today = await runSelfGate({ root: "/root", harness, run: makeFakeRun([]), gates: SCOPE_GATES, changedTests: [], changedSources: [] });
  const withNull = await scopeRun(null);
  expect(withNull).toEqual(today);
  expect(JSON.stringify(withNull)).toBe(JSON.stringify(today));
  expect(today.ranChecks).not.toContain("scope");
  expect(today.skippedChecks.map((x) => x.check)).not.toContain("scope");
  expect(selfGateDetailLine(withNull, { runId: "1" })).toBe(selfGateDetailLine(today, { runId: "1" }));
});

test("test_200_scope_check_fails_open_on_a_malformed_files_expected_entry", async () => {
  // files_expected comes from the plan handoff (LLM output, or any comment carrying the marker). An entry glob.js cannot
  // compile in bounded time — an unclosed `{` (endless loop), a long `*` run or too many `*` runs (catastrophic
  // backtracking), a `*`/`?` inside `{…}` (backtracking, or a RegExp the constructor rejects: `{*}`) — never reaches
  // glob.js: the mocked glob.js above THROWS on these entries instead of hanging, so a missing guard is a RED here, not a
  // stalled worker. The check is skipped visibly (skippedChecks + the self-gate-detail line), the same way as "no plan" —
  // never a finding, because non-blocking findings are copied into the reviewer handoff (plan non_goals).
  const { selfGateDetailLine } = await import("../lib/self-gate.js");
  const outside = { path: "factory/lib/" + "a".repeat(30) + ".js", status: "M", added: ["export const y = 2;"] };
  for (const bad of POISON_200) {
    globCalls200.length = 0;
    const r = await scopeRun({ issue: 200, plan: true, filesExpected: ["factory/lib/self-gate.js", bad], changes: [outside] });
    expect(globCalls200.filter((g) => POISON_200.includes(g)), bad).toEqual([]);
    expect(r.ok, bad).toBe(true);
    expect(r.ranChecks, bad).not.toContain("scope");
    expect(r.findings.filter((f) => f.check === "scope"), bad).toEqual([]);
    expect(advisoryFindings(r.findings).filter((f) => f.check === "scope"), bad).toEqual([]);
    const sk = r.skippedChecks.filter((x) => x.check === "scope");
    expect(sk, bad).toHaveLength(1);
    expect(sk[0].detail.startsWith(`skipped — files_expected entry ${JSON.stringify(bad)} `), bad).toBe(true);
    expect(selfGateDetailLine(r, { runId: "1" }), bad).toContain(JSON.stringify(sk[0].detail).slice(1, -1));
  }
  // Well-formed globs still judge: braces, `**`, and three `*` runs match; an outside path is still RED.
  const ok = await scopeRun({ issue: 200, plan: true, filesExpected: ["factory/**/*.{js,mjs}", "docs/**/*-*.md"], changes: [outside, { path: "docs/a/b-c.md", status: "M", added: ["x"] }] });
  expect(ok.ranChecks).toContain("scope");
  expect(ok.findings.filter((f) => f.check === "scope")).toEqual([]);
  const red = await scopeRun({ issue: 200, plan: true, filesExpected: ["factory/test/*.{js,mjs}"], changes: [outside] });
  expect(scopeBlocking(red).map((f) => f.detail.split(" ")[0])).toEqual([outside.path]);
});
