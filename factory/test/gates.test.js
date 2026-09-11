import { test, expect } from "vitest";
import { runGates, verdictLine, recomputeStatus } from "../lib/gates.js";
import { makeFakeRun } from "../lib/exec.js";

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

test("recomputeStatus recomputes after a caller mutates result.gates", async () => {
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh(harness.commands.unit, ok), sh("vitest run --project integration", ok), sh("npm run build", ok)]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "full", quarantine: { quarantined: [] }, readFile: () => null });
  expect(r.status).toBe("GREEN");
  r.gates.unit.status = "RED";
  const r2 = recomputeStatus(r, harness);
  expect(r2.status).toBe("RED");
  expect(r2.failing).toContain("unit");
});
