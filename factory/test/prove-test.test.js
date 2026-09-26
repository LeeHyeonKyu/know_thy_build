import { test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { proveTest, repeatNewTests, baseInstallCommand, inconclusiveOnBase } from "../lib/prove-test.js";
import { runStageGates } from "../lib/gates.js";
import { makeFakeRun } from "../lib/exec.js";

const harness = { commands: { test_files: "vitest run {files}", unit: "vitest run" } };
const wt = (res) => ({ match: (c, a) => c === "git" && a[0] === "worktree", result: res });
const ok = { code: 0, stdout: "", stderr: "" }, fail = { code: 1, stdout: "", stderr: "FAIL" };

test("proveTest ok when new tests FAIL on base", async () => {
  const run = makeFakeRun([wt(ok), { match: (c) => c === "cp", result: ok }, { match: (c, a) => c === "bash" && a[1].includes("vitest run") && a[1].includes("test/new.test.js"), result: fail }]);
  const r = await proveTest({ run, cwd: "/repo", harness, base: "abc", addedTests: ["test/new.test.js"], tmp: "/tmp/wt" });
  expect(r.ok).toBe(true);
  expect(run.calls.some((c) => c.cmd === "git" && c.args.join(" ") === "worktree add --detach /tmp/wt abc")).toBe(true);
  expect(run.calls.at(-1).args.join(" ")).toBe("worktree remove --force /tmp/wt");
});

test("proveTest NOT ok when new tests PASS on base (test proves nothing)", async () => {
  const run = makeFakeRun([wt(ok), { match: (c) => c === "cp", result: ok }, { match: (c) => c === "bash", result: ok }]);
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
    wt(ok),
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
    wt(ok),
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
    wt(ok),
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
    wt(ok),
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
  const run = makeFakeRun([wt(ok), { match: (c) => c === "cp", result: ok }, { match: (c, a) => c === "bash" && a[1].includes("vitest run"), result: importErr }]);
  const proven = await proveTest({ run, cwd: "/repo", harness, base: "abc", addedTests: ["test/version.test.js"], addedFiles: ["src/version.js", "test/version.test.js"], tmp: "/tmp/wt" });
  expect(proven.ok).toBe(true);
  expect(proven.misconfigured).toBeFalsy();
  expect(proven.detail).toContain("src/version.js");
  const run2 = makeFakeRun([wt(ok), { match: (c) => c === "cp", result: ok }, { match: (c, a) => c === "bash" && a[1].includes("vitest run"), result: importErr }]);
  const unclear = await proveTest({ run: run2, cwd: "/repo", harness, base: "abc", addedTests: ["test/version.test.js"], addedFiles: ["test/version.test.js"], tmp: "/tmp/wt" });
  expect(unclear.ok).toBe(false);
  expect(unclear.misconfigured).toBe(true);
});
