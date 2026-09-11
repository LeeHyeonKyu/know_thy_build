import { test, expect, vi } from "vitest";
import { runGates, verdictLine, recomputeStatus, runStageGates, levelForTier } from "../lib/gates.js";
import { makeFakeRun } from "../lib/exec.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const harness = {
  harness: { maturity: "M1" },
  commands: { lint: "npm run lint", typecheck: "tsc", unit: "vitest run --reporter=json --outputFile=.factory/out/unit.json", integration: "vitest run --project integration", build: "npm run build", proof: { coverage: "vitest --coverage" } },
  gates: { required: ["lint", "typecheck", "unit", "integration", "build"], fast: ["lint", "typecheck", "unit"], full: ["lint", "typecheck", "unit", "integration", "build", "diff_coverage"], deep: ["lint", "typecheck", "unit", "integration", "build", "diff_coverage", "e2e"], thresholds: {} },
  test: { unit_report: ".factory/out/unit.json" },
};
const ok = { code: 0, stdout: "", stderr: "" }, bad = { code: 1, stdout: "", stderr: "boom" };
const sh = (cmd, res) => ({ match: (c, a) => c === "bash" && a[1] === cmd, result: res });

test("all GREEN → GREEN; verdict line format", async () => {
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh(harness.commands.unit, ok), sh("vitest run --project integration", ok), sh("npm run build", ok)]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "full", quarantine: { quarantined: [] }, readFile: () => null, now: "2026-09-11T00:00:00Z" });
  expect(r.status).toBe("GREEN"); expect(r.passed).toBe(5); expect(r.skipped).toEqual(["diff_coverage"]);
  expect(verdictLine(r)).toBe("FACTORY_GATES: level=full status=GREEN passed=5 failed=0 failing=none skipped=diff_coverage misconfigured=none excluded=none");
});

test("one RED → RED with failing list; log captured", async () => {
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", bad), sh(harness.commands.unit, ok), sh("vitest run --project integration", ok), sh("npm run build", ok)]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "full", quarantine: { quarantined: [] }, readFile: () => null });
  expect(r.status).toBe("RED"); expect(r.failing).toEqual(["typecheck"]); expect(r.gates.typecheck.log).toContain("boom");
});

test("required gate without a command → MISCONFIGURED (fail-closed)", async () => {
  const h = { ...harness, commands: { ...harness.commands, integration: undefined } };
  const run = makeFakeRun([{ match: () => true, result: ok }]);
  const r = await runGates({ run, cwd: "/repo", harness: h, level: "full", quarantine: { quarantined: [] }, readFile: () => null });
  expect(r.status).toBe("MISCONFIGURED"); expect(r.misconfigured).toEqual(["integration"]);
});

test("maturity downgrade: M1 asked for deep → full, recorded", async () => {
  const run = makeFakeRun([{ match: () => true, result: ok }]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "deep", quarantine: { quarantined: [] }, readFile: () => null });
  expect(r.level).toBe("full"); expect(r.requested_level).toBe("deep"); expect(r.downgraded_from).toBe("deep");
});

test("quarantined test failures are excluded from the unit verdict", async () => {
  const report = JSON.stringify({ numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, testResults: [{ name: "/repo/test/a.test.js", assertionResults: [{ fullName: "flaky one", status: "failed" }, { fullName: "solid", status: "passed" }] }] });
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh(harness.commands.unit, bad)]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "fast", quarantine: { quarantined: [{ id: "test/a.test.js::flaky one" }] }, readFile: (p) => p.endsWith("unit.json") ? report : null });
  expect(r.gates.unit.status).toBe("GREEN"); expect(r.status).toBe("GREEN");
  expect(r.tests.excluded).toEqual(["test/a.test.js::flaky one"]); expect(r.tests.failing).toEqual([]);
  expect(verdictLine(r)).toContain("excluded=test/a.test.js::flaky one");
});

test("runGates without readFile uses the default (real fs); no report file → unit gate stays by exit code, still GREEN", async () => {
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh(harness.commands.unit, ok), sh("vitest run --project integration", ok), sh("npm run build", ok)]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "full", quarantine: { quarantined: [] }, now: "2026-09-11T00:00:00Z" });
  expect(r.status).toBe("GREEN"); expect(r.passed).toBe(5);
});

// ── runStageGates: 명령 게이트 + 실패 분류 + 증명 게이트를 한 판정으로 합산 ───────────

const stageHarness = {
  harness: { maturity: "M2" },
  commands: { unit: "vitest --json", test_files: "vitest run {files}", test_one: "vitest run {file} -t {name}", proof: {} },
  gates: { required: ["unit"], fast: ["unit"], full: ["unit", "diff_coverage", "mutation"], deep: ["unit"], thresholds: { new_test_repeats: 1, flaky_isolation_runs: 1, flaky_base_runs: 1 } },
  test: { unit_report: ".factory/out/unit.json", test_glob: ["test/**"], source_glob: ["src/**"] },
};
const TF = "vitest run 'test/new.test.js'", TO = "vitest run 'test/a.test.js' -t flaky one";
const diffOut = { code: 0, stdout: "M\tsrc/a.js\nA\ttest/new.test.js\n", stderr: "" };
// proveTest가 실제로 mkdir/cp를 하므로 cwd는 진짜 디렉터리여야 한다.
const stageCwd = mkdtempSync(join(tmpdir(), "stage-gates-"));
const readUnit = (p) => (p.endsWith("unit.json") ? JSON.stringify({ numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, testResults: [{ name: join(stageCwd, "test/a.test.js"), assertionResults: [{ fullName: "flaky one", status: "failed" }] }] }) : null);

test("levelForTier: docs→fast, standard→full, load-bearing→deep, unknown→full", () => {
  expect([levelForTier("docs"), levelForTier("standard"), levelForTier("load-bearing"), levelForTier(undefined)]).toEqual(["fast", "full", "deep", "full"]);
});

test("implement: flaky-existing 실패는 제외 + 이슈화되고, prove-test·반복·증명 게이트가 같은 판정에 합산된다", async () => {
  const run = makeFakeRun([
    { match: (c, a, o) => c === "bash" && a[1] === TF && o.cwd.endsWith("prove-wt"), result: { code: 1, stdout: "", stderr: "" } },   // 새 테스트는 base에서 실패해야 한다
    { match: (c, a) => c === "bash" && a[1] === TF, result: ok },                                                                     // PR 코드에서는 통과
    { match: (c, a, o) => c === "bash" && a[1] === TO && o.cwd.endsWith("classify-wt"), result: bad },                                // base에서도 실패 → 원래 흔들리던 테스트
    { match: (c, a) => c === "bash" && a[1] === TO, result: ok },                                                                     // PR 격리 실행은 통과
    { match: (c, a) => c === "bash" && a[1] === "vitest --json", result: bad },
    { match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--name-status", result: diffOut },
    { match: (c, a) => c === "git" && a[0] === "worktree", result: ok },
    { match: (c) => c === "cp", result: ok },
  ]);
  const gh = { createIssue: vi.fn(async () => 101) };
  const r = await runStageGates({ run, cwd: stageCwd, harness: stageHarness, stage: "implement", tier: "standard", base: "b".repeat(40), gh, issue: 7, readFile: readUnit });
  expect(r.level).toBe("full");
  expect(r.tests.excluded).toEqual(["test/a.test.js::flaky one"]);
  expect(r.tests.failing).toEqual([]);
  expect(r.gates.unit.status).toBe("GREEN");                       // 남은 실패가 없으면 테스트 게이트의 RED는 이 변경 책임이 아니다
  expect(r.gates["prove-test"].status).toBe("GREEN");
  expect(r.gates["new-test-repeat"].status).toBe("GREEN");
  expect(r.gates.diff_coverage.status).toBe("MISCONFIGURED");      // commands.proof.coverage 없음
  expect(r.gates.mutation.status).toBe("MISCONFIGURED");
  expect(r.status).toBe("GREEN");                                  // required는 unit뿐 — misconfigured가 required면 전체 MISCONFIGURED
  expect(gh.createIssue).toHaveBeenCalledWith(expect.objectContaining({ title: "flaky: test/a.test.js::flaky one", labels: ["backlog", "factory:flaky"] }));
  expect(r.flaky_issues).toEqual([101]);
});

test("implement: 판정 불가(blocked) 분류는 BLOCKED로 올라가고 증명 게이트는 아예 돌지 않는다", async () => {
  const run = makeFakeRun([
    { match: (c, a) => c === "bash" && a[1] === TO, result: ok },
    { match: (c, a) => c === "bash" && a[1] === "vitest --json", result: bad },
    { match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--name-status", result: diffOut },
    { match: (c, a) => c === "git" && a[0] === "worktree" && a[1] === "add", result: { code: 128, stdout: "", stderr: "fatal: disk full" } },
  ]);
  const r = await runStageGates({ run, cwd: stageCwd, harness: stageHarness, stage: "implement", tier: "standard", base: "b".repeat(40), readFile: readUnit });
  expect(r.status).toBe("BLOCKED");
  expect(r.blocked_reason).toMatch(/worktree add failed.*disk full/);
  expect(r.gates["prove-test"]).toBeUndefined();
  expect(r.classification[0].verdict).toBe("blocked");
});

test("review/merge는 실패를 재분류하지 않는다 — RED는 RED", async () => {
  const run = makeFakeRun([{ match: (c, a) => c === "bash" && a[1] === "vitest --json", result: bad }]);
  const r = await runStageGates({ run, cwd: stageCwd, harness: { ...stageHarness, gates: { ...stageHarness.gates, full: ["unit"] } }, stage: "review", tier: "standard", base: "b".repeat(40), readFile: readUnit });
  expect(r.status).toBe("RED");
  expect(r.classification).toBeUndefined();
  expect(r.gates["prove-test"]).toBeUndefined();
  expect(run.calls.filter((c) => c.cmd === "git")).toEqual([]);     // 분류도 diff도 없다
});

test("recomputeStatus recomputes after a caller mutates result.gates", async () => {
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh(harness.commands.unit, ok), sh("vitest run --project integration", ok), sh("npm run build", ok)]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "full", quarantine: { quarantined: [] }, readFile: () => null });
  expect(r.status).toBe("GREEN");
  r.gates.unit.status = "RED";
  const r2 = recomputeStatus(r, harness);
  expect(r2.status).toBe("RED");
  expect(r2.failing).toContain("unit");
});
