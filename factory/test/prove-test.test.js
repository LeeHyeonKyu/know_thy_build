import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi, beforeEach, afterEach } from "vitest";
import { rmSync, readdirSync } from "node:fs";
import { proveTest, repeatNewTests, baseInstallCommand, inconclusiveOnBase } from "../lib/prove-test.js";
import { runStageGates } from "../lib/gates.js";
import { makeFakeRun } from "../lib/exec.js";

const harness = { commands: { test_files: "vitest run {files}", unit: "vitest run" } };
// 1.4.13 — the base worktree `git add --intent-to-add` of the copied tests answers ok in every fixture unless a test asserts on it.
const wt = (res) => [{ match: (c, a) => c === "git" && a[0] === "worktree", result: res }, { match: (c, a) => c === "git" && a.includes("--intent-to-add"), result: { code: 0, stdout: "", stderr: "" } }];
const ok = { code: 0, stdout: "", stderr: "" }, fail = { code: 1, stdout: "", stderr: "FAIL" };

test("proveTest ok when new tests FAIL on base", async () => {
  const run = makeFakeRun([...wt(ok), { match: (c) => c === "cp", result: ok }, { match: (c, a) => c === "bash" && a[1].includes("vitest run") && a[1].includes("test/new.test.js"), result: fail }]);
  const r = await proveTest({ run, cwd: "/repo", harness, base: "abc", addedTests: ["test/new.test.js"], tmp: "/tmp/wt" });
  expect(r.ok).toBe(true);
  expect(run.calls.some((c) => c.cmd === "git" && c.args.join(" ") === "worktree add --detach /tmp/wt abc")).toBe(true);
  expect(run.calls.at(-1).args.join(" ")).toBe("worktree remove --force /tmp/wt");
});

test("proveTest NOT ok when new tests PASS on base (test proves nothing)", async () => {
  const run = makeFakeRun([...wt(ok), { match: (c) => c === "cp", result: ok }, { match: (c) => c === "bash", result: ok }]);
  const r = await proveTest({ run, cwd: "/repo", harness, base: "abc", addedTests: ["test/new.test.js"], tmp: "/tmp/wt" });
  expect(r.ok).toBe(false); expect(r.detail).toMatch(/passed on base/);
});

test("proveTest fails when there are no new tests", async () => {
  const r = await proveTest({ run: makeFakeRun([]), cwd: "/repo", harness, base: "abc", addedTests: [] });
  expect(r.ok).toBe(false); expect(r.detail).toMatch(/no new tests/);
});

test("F9: commands.test_files가 없으면 터지지 않고 MISCONFIGURED로 돌아온다", async () => {
  const run = makeFakeRun([{ match: () => true, result: ok }]);
  const bare = { commands: {} };
  const pt = await proveTest({ run, cwd: "/repo", harness: bare, base: "abc", addedTests: ["test/new.test.js"], tmp: "/tmp/wt" });
  expect(pt).toEqual({ ok: false, misconfigured: true, detail: "commands.test_files missing" });
  const rp = await repeatNewTests({ run, cwd: "/repo", harness: bare, addedTests: ["test/new.test.js"], times: 3 });
  expect(rp).toMatchObject({ ok: false, misconfigured: true, detail: "commands.test_files missing" });
  expect(run.calls).toHaveLength(0);                                   // 워크트리도 만들지 않는다
});

test("repeatNewTests: 반복 횟수를 모르면 통과가 아니라 MISCONFIGURED다", async () => {
  const run = makeFakeRun([{ match: () => true, result: ok }]);
  for (const times of [undefined, 0, -1]) {
    const r = await repeatNewTests({ run, cwd: "/repo", harness, addedTests: ["test/new.test.js"], times });
    expect(r.ok, String(times)).toBe(false);
    expect(r.misconfigured, String(times)).toBe(true);
    expect(r.detail).toMatch(/new_test_repeats missing/);
  }
  expect(run.calls).toHaveLength(0);                                   // 설정이 없으면 아무것도 돌리지 않는다
});

test("repeatNewTests runs N times, first alongside the full suite; any failure → not ok", async () => {
  let n = 0;
  const run = makeFakeRun([
    { match: (c, a) => c === "bash" && a[1] === "vitest run", result: ok },
    { match: (c, a) => c === "bash" && a[1].includes("{files}") === false && a[1].includes("test/new.test.js"), result: () => (++n === 2 ? fail : ok) },
  ]);
  const r = await repeatNewTests({ run, cwd: "/repo", harness, addedTests: ["test/new.test.js"], times: 3 });
  expect(r.ok).toBe(false); expect(r.runs.map((x) => x.code)).toEqual([0, 1, 0]);
  expect(run.calls.filter((c) => c.args[1] === "vitest run")).toHaveLength(1);
});

// --- 외부 감사 2026-09-14 M2: base 워크트리에는 의존성이 없었다 ---

test("baseInstallCommand: harness [runtime].setup wins, then the lockfile, then package.json, else none", () => {
  const has = (...names) => (p) => names.some((n) => p.endsWith(n));
  expect(baseInstallCommand({ runtime: { setup: "pnpm i --frozen-lockfile" } }, "/wt", has("package-lock.json"))).toBe("pnpm i --frozen-lockfile");
  expect(baseInstallCommand({}, "/wt", has("package-lock.json", "package.json"))).toBe("npm ci");
  expect(baseInstallCommand({}, "/wt", has("package.json"))).toBe("npm install --no-audit");
  expect(baseInstallCommand({}, "/wt", () => false)).toBe(null);
});

test("inconclusiveOnBase: module-resolution failures are not proof; a missing export still is", () => {
  expect(inconclusiveOnBase("Error: Cannot find module 'vitest'")).toBe(true);
  expect(inconclusiveOnBase("code: 'ERR_MODULE_NOT_FOUND'")).toBe(true);
  expect(inconclusiveOnBase("SyntaxError: Unexpected token 'export'")).toBe(true);
  expect(inconclusiveOnBase("TypeError: undefined is not a function")).toBe(true);
  // 이것들은 base가 실제로 말해 준 사실이다 — 증명이지 설정 오류가 아니다.
  expect(inconclusiveOnBase("AssertionError: expected 3 to be 4")).toBe(false);
  expect(inconclusiveOnBase("SyntaxError: The requested module does not provide an export named 'parseX'")).toBe(false);
  expect(inconclusiveOnBase("TypeError: lib.parseX is not a function")).toBe(false);
});

test("proveTest installs dependencies in the base worktree before running the new tests", async () => {
  const run = makeFakeRun([
    ...wt(ok),
    { match: (c) => c === "cp", result: ok },
    { match: (c, a) => c === "bash" && a[1] === "npm ci", result: ok },
    { match: (c, a) => c === "bash" && a[1].includes("vitest run"), result: fail },
  ]);
  const r = await proveTest({ run, cwd: "/repo", harness, base: "abc", addedTests: ["test/new.test.js"], tmp: "/tmp/wt", exists: (p) => p.endsWith("package-lock.json") });
  expect(r.ok).toBe(true);
  const bash = run.calls.filter((c) => c.cmd === "bash");
  expect(bash[0].args[1]).toBe("npm ci");                              // 테스트보다 **먼저**, 그리고 워크트리 안에서
  expect(bash[0].opts.cwd).toBe("/tmp/wt");
  expect(bash[1].args[1]).toContain("vitest run");
});

test("proveTest: a base install that fails is fail-closed — misconfigured, not proof", async () => {
  const run = makeFakeRun([
    ...wt(ok),
    { match: (c) => c === "cp", result: ok },
    { match: (c, a) => c === "bash" && a[1] === "npm ci", result: { code: 1, stdout: "", stderr: "ENOTFOUND registry" } },
  ]);
  const r = await proveTest({ run, cwd: "/repo", harness, base: "abc", addedTests: ["test/new.test.js"], tmp: "/tmp/wt", exists: (p) => p.endsWith("package-lock.json") });
  expect(r).toMatchObject({ ok: false, misconfigured: true, inconclusive: ["test/new.test.js"] });
  expect(r.detail).toMatch(/base dependency install failed/);
  expect(run.calls.some((c) => c.cmd === "bash" && c.args[1].includes("vitest"))).toBe(false);
});

test("proveTest: a base run that dies on module resolution is INCONCLUSIVE, never proof", async () => {
  const run = makeFakeRun([
    ...wt(ok),
    { match: (c) => c === "cp", result: ok },
    { match: (c, a) => c === "bash" && a[1].includes("vitest run"), result: { code: 1, stdout: "Error: Cannot find module '../lib/thing.js'", stderr: "" } },
  ]);
  const r = await proveTest({ run, cwd: "/repo", harness, base: "abc", addedTests: ["test/new.test.js"], tmp: "/tmp/wt", exists: () => false });
  expect(r.ok).toBe(false);
  expect(r.misconfigured).toBe(true);                                  // 게이트는 GREEN도 RED도 아니다 — 설정 오류다
  expect(r.inconclusive).toEqual(["test/new.test.js"]);
  expect(r.detail).toMatch(/inconclusive/);
});

test("stage gates: an inconclusive prove-test is MISCONFIGURED and listed in prove_test.inconclusive — never GREEN", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "prove-gates-"));
  const stageHarness = {
    harness: { maturity: "M2" },
    commands: { unit: "vitest --json", test_files: "vitest run {files}", proof: {} },
    gates: { required: ["unit", "prove-test"], fast: ["unit"], full: ["unit"], deep: ["unit"], thresholds: { new_test_repeats: 1, flaky_isolation_runs: 1, flaky_base_runs: 2, flaky_max: 2, quarantine_max_effective: 3 } },
    test: { unit_report: ".factory/out/unit.json", test_glob: ["test/**"], source_glob: ["src/**"] },
  };
  const TF = "vitest run 'test/new.test.js'";
  const run = makeFakeRun([
    { match: (c, a, o) => c === "bash" && a[1] === TF && o.cwd.endsWith("prove-wt"), result: { code: 1, stdout: "Error: Cannot find module 'vitest'", stderr: "" } },
    { match: (c, a) => c === "bash" && a[1] === TF, result: ok },
    { match: (c, a) => c === "bash" && a[1] === "vitest --json", result: ok },
    { match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--name-status", result: { code: 0, stdout: "A\ttest/new.test.js\n", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "rev-parse", result: { code: 0, stdout: `${"h".repeat(40)}\n`, stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "worktree", result: ok },
    { match: (c, a) => c === "git" && a.includes("--intent-to-add"), result: ok },
    { match: (c) => c === "cp", result: ok },
  ]);
  const r = await runStageGates({ run, cwd, harness: stageHarness, stage: "implement", tier: "standard", base: "b".repeat(40), readFile: () => null });
  expect(r.gates["prove-test"].status).toBe("MISCONFIGURED");
  expect(r.prove_test).toEqual({ inconclusive: ["test/new.test.js"] });
  expect(r.status).toBe("MISCONFIGURED");                              // fail closed — 이 PR은 이 게이트로 머지되지 않는다
  expect(r.misconfigured).toContain("prove-test");
});

test("proveTest: a real failure on base is still proof, with dependencies installed", async () => {
  const run = makeFakeRun([
    ...wt(ok),
    { match: (c) => c === "cp", result: ok },
    { match: (c, a) => c === "bash" && a[1] === "npm ci", result: ok },
    { match: (c, a) => c === "bash" && a[1].includes("vitest run"), result: { code: 1, stdout: "AssertionError: expected 3 to be 4", stderr: "" } },
  ]);
  const r = await proveTest({ run, cwd: "/repo", harness, base: "abc", addedTests: ["test/new.test.js"], tmp: "/tmp/wt", exists: (p) => p.endsWith("package-lock.json") });
  expect(r).toMatchObject({ ok: true });
  expect(r.inconclusive).toBeUndefined();
});

// 1.4.8 (demo #58): a new test that imports a module ADDED by the same change cannot run on base — that is the proof,
// not an inconclusive run. Without an added module in the error, the old inconclusive verdict stands.
test("proveTest: an import error naming a module this change adds counts as failing on base; an unrelated import error stays inconclusive", async () => {
  const importErr = { code: 1, stdout: "", stderr: "Error: Cannot find module '../src/version.js' imported from test/version.test.js" };
  const run = makeFakeRun([...wt(ok), { match: (c) => c === "cp", result: ok }, { match: (c, a) => c === "bash" && a[1].includes("vitest run"), result: importErr }]);
  const proven = await proveTest({ run, cwd: "/repo", harness, base: "abc", addedTests: ["test/version.test.js"], addedFiles: ["src/version.js", "test/version.test.js"], tmp: "/tmp/wt" });
  expect(proven.ok).toBe(true);
  expect(proven.misconfigured).toBeFalsy();
  expect(proven.detail).toContain("src/version.js");
  const run2 = makeFakeRun([...wt(ok), { match: (c) => c === "cp", result: ok }, { match: (c, a) => c === "bash" && a[1].includes("vitest run"), result: importErr }]);
  const unclear = await proveTest({ run: run2, cwd: "/repo", harness, base: "abc", addedTests: ["test/version.test.js"], addedFiles: ["test/version.test.js"], tmp: "/tmp/wt" });
  expect(unclear.ok).toBe(false);
  expect(unclear.misconfigured).toBe(true);
});

// 1.4.9 (own-calendar #28/#29): a test-only diff characterizes existing behaviour — the new tests must PASS on base.
test("proveTest characterization mode: passing on base is GREEN, failing on base is RED, import error is inconclusive", async () => {
  const { CHARACTERIZATION } = await import("../lib/prove-test.js");
  const mk = (res) => makeFakeRun([...wt(ok), { match: (c) => c === "cp", result: ok }, { match: (c, a) => c === "bash" && a[1].includes("vitest run"), result: res }]);
  const green = await proveTest({ run: mk(ok), cwd: "/repo", harness, base: "abc", addedTests: ["test/rrule.test.js"], mode: CHARACTERIZATION, tmp: "/tmp/wt" });
  expect(green.ok).toBe(true);
  expect(green.detail).toContain("characterization");
  const red = await proveTest({ run: mk(fail), cwd: "/repo", harness, base: "abc", addedTests: ["test/rrule.test.js"], mode: CHARACTERIZATION, tmp: "/tmp/wt" });
  expect(red.ok).toBe(false);
  expect(red.misconfigured).toBeFalsy();
  const inc = await proveTest({ run: mk({ code: 1, stdout: "", stderr: "Cannot find module 'x'" }), cwd: "/repo", harness, base: "abc", addedTests: ["test/rrule.test.js"], mode: CHARACTERIZATION, tmp: "/tmp/wt" });
  expect(inc.misconfigured).toBe(true);
});

// 1.4.13 (own-calendar #31): the copied tests are intent-added to the base worktree's index so tests that read
// `git ls-files`/`git status` see the same world on base as on head; Dart/Python setup errors are inconclusive.
test("proveTest intent-adds the copied tests in the base worktree; Dart and Python resolution errors are inconclusive", async () => {
  const calls = [];
  const run = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "worktree", result: ok },
    { match: (c) => c === "cp", result: ok },
    { match: (c, a) => c === "git" && a.includes("--intent-to-add") && (calls.push(a), true), result: ok },
    { match: (c, a) => c === "bash" && a[1].includes("vitest run"), result: fail },
  ]);
  const r = await proveTest({ run, cwd: "/repo", harness, base: "abc", addedTests: ["test/guard.test.js"], tmp: "/tmp/wt" });
  expect(r.ok).toBe(true);
  expect(calls).toEqual([["-C", "/tmp/wt", "add", "--intent-to-add", "--", "test/guard.test.js"]]);
  for (const msg of ["Error: Target of URI doesn't exist: 'package:x/y.dart'", "Couldn't resolve the package 'own_calendar'", "ModuleNotFoundError: No module named 'app'", "ImportError: cannot import name 'x' from 'y'"]) {
    expect(inconclusiveOnBase(msg)).toBe(true);
  }
  expect(inconclusiveOnBase("Expected: <0>  Actual: <1>")).toBe(false);
});

// 1.4.13 (own-calendar #31, KTB #75): a new test that mentions its own path asserts about itself, not the product.
test("selfReferentialTests flags a new test that names its own file and leaves guard tests about other files alone", async () => {
  const { selfReferentialTests } = await import("../lib/prove-test.js");
  const files = {
    "client/test/charter_paths_guard_test.dart": "// guard\nexpect(gitLsFiles('client/test/charter_paths_guard_test.dart'), 0);",
    "client/test/rrule_test.dart": "expect(gitLsFiles('docs/factory/CHARTER.md'), 0);",
    // 1.4.22 (L25): a comment naming the file, or a bare mention with no file/git call on the line, is not a self-assertion
    "client/test/honest_test.dart": "// the changeset adds exactly one file: client/test/honest_test.dart.\nfinal name = 'honest_test';\nexpect(File('docs/factory/CHARTER.md').existsSync(), isTrue);",
  };
  const hits = selfReferentialTests(Object.keys(files), (f) => files[f]);
  expect(hits).toEqual([{ file: "client/test/charter_paths_guard_test.dart", hit: "client/test/charter_paths_guard_test.dart", line: "expect(gitLsFiles('client/test/charter_paths_guard_test.dart'), 0);" }]);
  expect(selfReferentialTests(["missing.test.js"], () => { throw new Error("ENOENT"); })).toEqual([]);
});

// 1.4.14 (own-calendar #31, L16): one mode rule for the stage gate and the diagnostic CLI; failed repeats carry output.
test("proveModeFor: all-test diffs are characterization, anything else is prove; repeatNewTests keeps the tail of a failed run", async () => {
  const { proveModeFor, CHARACTERIZATION } = await import("../lib/prove-test.js");
  expect(proveModeFor({ tests: ["t/a.test.js"], all: ["t/a.test.js"] })).toBe(CHARACTERIZATION);
  expect(proveModeFor({ tests: ["t/a.test.js"], all: ["t/a.test.js", "src/a.js"] })).toBe("prove");
  expect(proveModeFor({ tests: [], all: ["src/a.js"] })).toBe("prove");
  let n = 0;
  const run = makeFakeRun([{ match: (c, a) => c === "bash" && a[1].includes("vitest run") && a[1].includes("t/a.test.js"), result: () => (n++ === 0 ? { code: 1, stdout: "", stderr: "Waiting for another flutter command to release the startup lock" } : ok) }]);
  const r = await repeatNewTests({ run, cwd: "/repo", harness: { commands: { test_files: "vitest run {files}" } }, addedTests: ["t/a.test.js"], times: 3 });
  expect(r.ok).toBe(false);
  expect(r.runs[0]).toMatchObject({ code: 1, noisy: false, tail: expect.stringContaining("startup lock") });
  expect(r.detail).toMatch(/exit codes 1,0,0 — run 1: Waiting for another flutter command/);
});

// 1.4.15 (KTB #53, own-calendar #21): a fix of EXISTING red tests proves itself by those tests being red on base and
// green on head — no new test needed. Passing on base means nothing was fixed; a module error on base is inconclusive.
test("proveFixedTests: red on base + green on head is GREEN; green on base is RED; missing file is MISCONFIGURED", async () => {
  const { proveFixedTests } = await import("../lib/prove-test.js");
  const h = { commands: { test_files: "vitest run {files}" } };
  const mk = (onBase, onHead) => makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "worktree", result: ok },
    { match: (c, a, o) => c === "bash" && a[1].includes("group.test.ts") && o.cwd === "/tmp/wt", result: onBase },
    { match: (c, a, o) => c === "bash" && a[1].includes("group.test.ts") && o.cwd === "/repo", result: onHead },
  ]);
  const fixed = await proveFixedTests({ run: mk({ code: 1, stdout: "6 failed", stderr: "" }, ok), cwd: "/repo", harness: h, base: "abc1234", tests: ["server/tests/group.test.ts"], tmp: "/tmp/wt", exists: (p) => p.endsWith(".test.ts") });
  expect(fixed.ok).toBe(true);
  expect(fixed.detail).toMatch(/fixed 1 existing test file\(s\): server\/tests\/group\.test\.ts — red on base abc1234/);
  const nothing = await proveFixedTests({ run: mk(ok, ok), cwd: "/repo", harness: h, base: "abc1234", tests: ["server/tests/group.test.ts"], tmp: "/tmp/wt", exists: (p) => p.endsWith(".test.ts") });
  expect(nothing.ok).toBe(false);
  expect(nothing.detail).toMatch(/already pass on base/);
  const stillRed = await proveFixedTests({ run: mk(fail, fail), cwd: "/repo", harness: h, base: "abc1234", tests: ["server/tests/group.test.ts"], tmp: "/tmp/wt", exists: (p) => p.endsWith(".test.ts") });
  expect(stillRed.ok).toBe(false);
  expect(stillRed.detail).toMatch(/still red on head/);
  const inc = await proveFixedTests({ run: mk({ code: 1, stdout: "", stderr: "Cannot find module 'x'" }, ok), cwd: "/repo", harness: h, base: "abc1234", tests: ["server/tests/group.test.ts"], tmp: "/tmp/wt", exists: (p) => p.endsWith(".test.ts") });
  expect(inc.misconfigured).toBe(true);
  const missing = await proveFixedTests({ run: mk(ok, ok), cwd: "/repo", harness: h, base: "abc1234", tests: ["server/tests/nope.test.ts"], tmp: "/tmp/wt", exists: (p) => p.endsWith(".test.ts") && !p.endsWith("nope.test.ts") });
  expect(missing.misconfigured).toBe(true);
  expect(missing.detail).toMatch(/do not exist on base/);
});

test("stage gates: a source-only diff with fixes_tests in the issue body proves itself through the existing tests", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "prove-fixed-"));
  const stageHarness = {
    harness: { maturity: "M2" },
    commands: { unit: "vitest --json", test_files: "vitest run {files}", proof: {} },
    gates: { required: ["unit", "prove-test"], fast: ["unit"], full: ["unit"], deep: ["unit"], thresholds: { new_test_repeats: 1, flaky_isolation_runs: 1, flaky_base_runs: 2, flaky_max: 2, quarantine_max_effective: 3 } },
    test: { unit_report: ".factory/out/unit.json", test_glob: ["test/**"], source_glob: ["src/**"] },
  };
  const TF = "vitest run 'test/group.test.js'";
  const run = makeFakeRun([
    { match: (c, a, o) => c === "bash" && a[1] === TF && o.cwd.endsWith("prove-wt"), result: { code: 1, stdout: "FAIL", stderr: "" } },
    { match: (c, a) => c === "bash" && a[1] === TF, result: ok },
    { match: (c, a) => c === "bash" && a[1] === "vitest --json", result: ok },
    { match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--name-status", result: { code: 0, stdout: "M\tsrc/group.js\n", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "rev-parse", result: { code: 0, stdout: `${"h".repeat(40)}\n`, stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "worktree", result: ok },
  ]);
  const gh = { issue: async () => ({ body: "6 group tests fail on main — make them green\n\nfixes_tests: `test/group.test.js`\n" }) };
  mkdirSync(join(cwd, ".factory/out/prove-wt/test"), { recursive: true });
  writeFileSync(join(cwd, ".factory/out/prove-wt/test/group.test.js"), "// exists on base");
  const r = await runStageGates({ run, cwd, harness: stageHarness, stage: "implement", tier: "standard", base: "b".repeat(40), gh, issue: 21, readFile: () => null });
  expect(r.gates["prove-test"].status).toBe("GREEN");
  expect(r.gates["prove-test"].log).toMatch(/fixed 1 existing test file\(s\)/);
});

// 1.4.15 (own-calendar #31, L17): two concurrent `flutter test` runs in one project both fail (startup lock /
// native_assets race) — the repeat gate must not run the first repeat alongside the full suite for such toolchains.
test("repeatNewTests runs the full suite BEFORE the repeats when the toolchain holds a project lock; harness flag overrides", async () => {
  const { repeatAlongsideSuite } = await import("../lib/prove-test.js");
  expect(repeatAlongsideSuite({ commands: { test_files: "vitest run {files}", unit: "vitest run" } })).toBe(true);
  expect(repeatAlongsideSuite({ commands: { test_files: "cd client && flutter test {files}", unit: "cd client && flutter test" } })).toBe(false);
  expect(repeatAlongsideSuite({ commands: { test_files: "./gradlew test --tests {files}" } })).toBe(false);
  expect(repeatAlongsideSuite({ gates: { repeat_alongside_suite: true }, commands: { test_files: "flutter test {files}" } })).toBe(true);
  const order = [];
  let inFlight = 0, overlap = false;
  const mkRun = (label) => async () => { inFlight++; if (inFlight > 1) overlap = true; order.push(label); await new Promise((r) => setTimeout(r, 5)); inFlight--; return ok; };
  const run = makeFakeRun([
    { match: (c, a) => c === "bash" && a[1] === "cd client && flutter test", result: mkRun("suite") },
    { match: (c, a) => c === "bash" && a[1].includes("{f}") === false && a[1].includes("t/a_test.dart"), result: mkRun("repeat") },
  ]);
  const h = { commands: { test_files: "cd client && flutter test {files}", unit: "cd client && flutter test" } };
  const r = await repeatNewTests({ run, cwd: "/repo", harness: h, addedTests: ["t/a_test.dart"], times: 2 });
  expect(r.ok).toBe(true);
  expect(order).toEqual(["suite", "repeat", "repeat"]);
  expect(overlap).toBe(false);
  expect(r.detail).toMatch(/full suite ran before the repeats/);
});

// 1.4.30 (L36, own-calendar #51/#52): import errors name the module WITHOUT its extension — an added module must still count.
test("addedModuleNamedIn matches the added file's stem at a path/quote boundary, not only its basename", async () => {
  const { addedModuleNamedIn } = await import("../lib/prove-test.js");
  const added = ["server/src/lib/logger.ts", "server/tests/logger.test.ts"];
  expect(addedModuleNamedIn('Error: Failed to resolve import "../src/lib/logger" from "tests/logger.test.ts". Does the file exist?', added)).toBe("server/src/lib/logger.ts");
  expect(addedModuleNamedIn("Cannot find module '/w/server/src/lib/logger' imported from /w/server/tests/logger.test.ts", added)).toBe("server/src/lib/logger.ts");
  expect(addedModuleNamedIn("Cannot find module '../src/lib/other'", added)).toBeNull();
  // a stem that is merely a substring of another word does not match
  expect(addedModuleNamedIn("bloggerX is undefined", ["src/logger.js"])).toBeNull();
});

// ── #257: the fake-worktree fixtures must not depend on what the runner's filesystem holds ─────────────────────────────────
// #253 head b4aac9b: the implement `unit` gate was GREEN and the review `unit` gate RED on the same head — four fixtures above
// died with `unexpected command: bash -lc npm ci`. They pass `tmp: "/tmp/wt"` with no `exists`, so baseInstallCommand fell back
// to the real existsSync and a package-lock.json that happened to sit at /tmp/wt on that runner chose `npm ci`; proveTest's real
// mkdirSync also wrote /tmp/wt/test onto the host. Those fixtures are load-bearing and stay byte-for-byte as they are (no
// `tests_changed_allowed:` on #257). So every test in this file gets its OWN fake worktree: the "/tmp/wt" path resolves into a
// private directory created before each test and removed after it, and a REAL package-lock.json and package.json are planted
// there — the worst case the #253 runner had. The existing fixtures above therefore run against planted files on every run; what
// keeps them off `npm ci` is prove-test.js's default probe (it trusts a lockfile only inside a worktree git actually created —
// one with a `.git`), not this seam: on base the planted lockfile reaches baseInstallCommand and those fixtures die as on #253.
const FAKE_WT_257 = vi.hoisted(() => ({ root: "/tmp/wt", dir: null }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal();
  const redirect = (p) => {
    const s = String(p), r = FAKE_WT_257.root;
    if (s !== r && !s.startsWith(`${r}/`)) return p;
    if (!FAKE_WT_257.dir) throw new Error(`#257: fake worktree path ${s} used outside a test`);
    return FAKE_WT_257.dir + s.slice(r.length);
  };
  const existsSync = (p) => fs.existsSync(redirect(p));
  const mkdirSync = (p, o) => fs.mkdirSync(redirect(p), o);
  return { ...fs, existsSync, mkdirSync, default: { ...fs.default, existsSync, mkdirSync } };
});
const PLANTED_257 = { "package-lock.json": "{\"lockfileVersion\":3}\n", "package.json": "{\"name\":\"host-residue\"}\n" };
beforeEach(() => {
  FAKE_WT_257.dir = mkdtempSync(join(tmpdir(), "ktb257-fake-wt-"));
  for (const [name, body] of Object.entries(PLANTED_257)) writeFileSync(join(FAKE_WT_257.dir, name), body);
});
afterEach(() => { rmSync(FAKE_WT_257.dir, { recursive: true, force: true }); FAKE_WT_257.dir = null; });

test("test_257_prove_test_fixture_injects_exists_and_never_picks_npm_ci_from_the_host", async () => {
  const { existsSync } = await import("node:fs");
  const { CHARACTERIZATION, proveFixedTests } = await import("../lib/prove-test.js");
  const dir = FAKE_WT_257.dir;
  // The planting is real and per test: the default existsSync — what the fixtures fall back to — sees both files at /tmp/wt,
  // and they live in this test's private directory (a fresh mkdtemp), not in the host's /tmp/wt.
  expect(existsSync("/tmp/wt/package-lock.json")).toBe(true);
  expect(existsSync("/tmp/wt/package.json")).toBe(true);
  expect(dir.startsWith(join(tmpdir(), "ktb257-fake-wt-"))).toBe(true);
  const npm = (run) => run.calls.filter((c) => c.cmd === "bash" && /\bnpm (ci|install)\b/.test(c.args[1]));
  const cpOk = { match: (c) => c === "cp", result: ok };
  const importErr = { code: 1, stdout: "", stderr: "Error: Cannot find module '../src/version.js' imported from test/version.test.js" };
  const vit = (res) => makeFakeRun([...wt(ok), cpOk, { match: (c, a) => c === "bash" && a[1].includes("vitest run"), result: res }]);
  // Every existing fake-worktree fixture above that passes tmp "/tmp/wt" with no `exists`, call for call — same fake run, same
  // arguments, same expectation — here run against the lockfile and package.json planted where the probe looks. (The fixtures
  // themselves run against the same planted files through beforeEach; this list makes the item fail on its own on base.)
  const cases = [
    ["plain prove (:18)", makeFakeRun([...wt(ok), cpOk, { match: (c, a) => c === "bash" && a[1].includes("vitest run") && a[1].includes("test/new.test.js"), result: fail }]),
      { addedTests: ["test/new.test.js"] }, (r) => expect(r.ok).toBe(true)],
    ["passes on base (:26)", makeFakeRun([...wt(ok), cpOk, { match: (c) => c === "bash", result: ok }]),
      { addedTests: ["test/new.test.js"] }, (r) => { expect(r.ok).toBe(false); expect(r.detail).toMatch(/passed on base/); }],
    ["bare harness (:38)", makeFakeRun([{ match: () => true, result: ok }]),
      { addedTests: ["test/new.test.js"], harness: { commands: {} } }, (r) => expect(r).toEqual({ ok: false, misconfigured: true, detail: "commands.test_files missing" })],
    ["import of an added module (:171)", vit(importErr),
      { addedTests: ["test/version.test.js"], addedFiles: ["src/version.js", "test/version.test.js"] }, (r) => { expect(r.ok).toBe(true); expect(r.misconfigured).toBeFalsy(); expect(r.detail).toContain("src/version.js"); }],
    ["unrelated import error (:176)", vit(importErr),
      { addedTests: ["test/version.test.js"], addedFiles: ["test/version.test.js"] }, (r) => { expect(r).toMatchObject({ ok: false, misconfigured: true }); expect(r.detail).toContain("no dependency install command was found"); }],
    ["characterization green (:185)", vit(ok), { addedTests: ["test/rrule.test.js"], mode: CHARACTERIZATION }, (r) => { expect(r.ok).toBe(true); expect(r.detail).toContain("characterization"); }],
    ["characterization red (:188)", vit(fail), { addedTests: ["test/rrule.test.js"], mode: CHARACTERIZATION }, (r) => { expect(r.ok).toBe(false); expect(r.misconfigured).toBeFalsy(); }],
    ["characterization inconclusive (:191)", vit({ code: 1, stdout: "", stderr: "Cannot find module 'x'" }), { addedTests: ["test/rrule.test.js"], mode: CHARACTERIZATION }, (r) => expect(r.misconfigured).toBe(true)],
    ["intent-to-add guard (:205)", makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "worktree", result: ok }, cpOk, { match: (c, a) => c === "git" && a.includes("--intent-to-add"), result: ok }, { match: (c, a) => c === "bash" && a[1].includes("vitest run"), result: fail }]),
      { addedTests: ["test/guard.test.js"] }, (r) => expect(r.ok).toBe(true)],
  ];
  for (const [name, run, args, check] of cases) {
    const r = await proveTest({ run, cwd: "/repo", harness, base: "abc", tmp: "/tmp/wt", ...args });
    check(r);
    expect(npm(run), name).toEqual([]);                                  // no install command was chosen from the planted files
  }
  // proveFixedTests with the default probe: the listed test exists in the fake worktree, the lockfile too — still no install.
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "test/a.test.js"), "// on base");
  const fixed = makeFakeRun([...wt(ok), { match: (c, a, o) => c === "bash" && o.cwd === "/tmp/wt", result: fail }, { match: (c) => c === "bash", result: ok }]);
  expect(await proveFixedTests({ run: fixed, cwd: "/repo", harness, base: "abc1234", tests: ["test/a.test.js"], tmp: "/tmp/wt" })).toMatchObject({ ok: true });
  expect(npm(fixed)).toEqual([]);
  // The fixtures' real mkdirSync landed in the private fake worktree (not on the host); the planted files are still there.
  expect(readdirSync(dir).sort()).toEqual(["package-lock.json", "package.json", "test"]);
  // A worktree git really created (it has a `.git`) still installs from its lockfile through the same default probe — the
  // planted files are not ignored wholesale, only outside a real worktree.
  writeFileSync(join(dir, ".git"), "gitdir: /repo/.git/worktrees/wt\n");
  const real = makeFakeRun([...wt(ok), cpOk, { match: (c, a) => c === "bash" && a[1] === "npm ci", result: ok }, { match: (c, a) => c === "bash" && a[1].includes("vitest run"), result: fail }]);
  expect(await proveTest({ run: real, cwd: "/repo", harness, base: "abc", addedTests: ["test/new.test.js"], tmp: "/tmp/wt" })).toMatchObject({ ok: true });
  expect(npm(real).map((c) => [c.args[1], c.opts.cwd])).toEqual([["npm ci", "/tmp/wt"]]);
  const realFixed = makeFakeRun([...wt(ok), { match: (c, a) => c === "bash" && a[1] === "npm ci", result: ok }, { match: (c, a, o) => c === "bash" && o.cwd === "/tmp/wt", result: fail }, { match: (c) => c === "bash", result: ok }]);
  expect(await proveFixedTests({ run: realFixed, cwd: "/repo", harness, base: "abc1234", tests: ["test/a.test.js"], tmp: "/tmp/wt" })).toMatchObject({ ok: true });
  expect(npm(realFixed).map((c) => c.args[1])).toEqual(["npm ci"]);
  // …and a test that asks for installation by injecting `exists` gets exactly what it asked for, as before.
  const asked = makeFakeRun([...wt(ok), cpOk, { match: (c, a) => c === "bash" && a[1] === "npm install --no-audit", result: ok }, { match: (c, a) => c === "bash" && a[1].includes("vitest run"), result: fail }]);
  expect(await proveTest({ run: asked, cwd: "/repo", harness, base: "abc", addedTests: ["test/new.test.js"], tmp: "/tmp/wt", exists: (p) => p.endsWith("/package.json") })).toMatchObject({ ok: true });
  expect(npm(asked).map((c) => c.args[1])).toEqual(["npm install --no-audit"]);
});

test("test_257_base_install_command_never_probes_with_an_empty_worktree_path", async () => {
  const spy = () => { const f = vi.fn(() => true); return f; };
  // Empty or missing tmp: join("", "package-lock.json") resolves against the process cwd — the repository root, which has a
  // lockfile. No install command, and `exists` is never asked.
  for (const tmp of ["", undefined, null]) {
    const exists = spy();
    expect(baseInstallCommand({}, tmp, exists), String(tmp)).toBe(null);
    expect(exists, String(tmp)).toHaveBeenCalledTimes(0);
    // A harness [runtime].setup still wins when tmp is empty (it never needed a probe).
    const e2 = spy();
    expect(baseInstallCommand({ runtime: { setup: "pnpm i --frozen-lockfile" } }, tmp, e2)).toBe("pnpm i --frozen-lockfile");
    expect(e2).toHaveBeenCalledTimes(0);
  }
  // Non-empty tmp: the order is unchanged — setup, then lockfile, then package.json, then none — and the probe stays inside tmp.
  const seen = [];
  const has = (...names) => (p) => { seen.push(p); return names.some((n) => p.endsWith(`/${n}`)); };
  expect(baseInstallCommand({ runtime: { setup: "make deps" } }, "/wt", has("package-lock.json"))).toBe("make deps");
  expect(seen).toEqual([]);
  expect(baseInstallCommand({}, "/wt", has("package-lock.json", "package.json"))).toBe("npm ci");
  expect(baseInstallCommand({}, "/wt", has("package.json"))).toBe("npm install --no-audit");
  expect(baseInstallCommand({}, "/wt", has())).toBe(null);
  expect(seen).toEqual(["/wt/package-lock.json", "/wt/package-lock.json", "/wt/package.json", "/wt/package-lock.json", "/wt/package.json"]);
  // `git worktree add` fails: both provers return their existing detail before any probe or install.
  const { proveFixedTests } = await import("../lib/prove-test.js");
  const addFails = () => makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "worktree" && a[1] === "add", result: { code: 128, stdout: "", stderr: "fatal: '/tmp/wt' already exists" } }]);
  const e3 = spy(), run3 = addFails();
  expect(await proveTest({ run: run3, cwd: "/repo", harness, base: "abc", addedTests: ["test/new.test.js"], tmp: "/tmp/wt", exists: e3 })).toEqual({ ok: false, detail: "worktree add failed: fatal: '/tmp/wt' already exists" });
  expect(e3).toHaveBeenCalledTimes(0);
  expect(run3.calls.map((c) => c.cmd)).toEqual(["git"]);
  const e4 = spy(), run4 = addFails();
  expect(await proveFixedTests({ run: run4, cwd: "/repo", harness, base: "abc", tests: ["test/a.test.js"], tmp: "/tmp/wt", exists: e4 })).toEqual({ ok: false, detail: "worktree add failed: fatal: '/tmp/wt' already exists" });
  expect(e4).toHaveBeenCalledTimes(0);
  expect(run4.calls.map((c) => c.cmd)).toEqual(["git"]);
});
