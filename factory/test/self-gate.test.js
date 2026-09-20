import { test, expect } from "vitest";
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
    changedTests: [{ file: "test/x.test.js" }], changedSources: [],
    mutation: { tmp: "/wt", exists: fs.exists, readFile: fs.readFile, writeFile: fs.writeFile },
  });
  expect(res.ok).toBe(true);
  expect(advisoryFindings(res.findings).length).toBeGreaterThan(0);
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
