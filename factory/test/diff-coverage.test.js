import { test, expect } from "vitest";
import { diffCoverage, runDiffCoverage } from "../lib/diff-coverage.js";
import { makeFakeRun } from "../lib/exec.js";

test("computes % of changed source lines executed; lists uncovered", () => {
  const changed = new Map([["src/a.js", new Set([1, 2, 3, 4])], ["test/a.test.js", new Set([9])], ["src/b.js", new Set([7])]]);
  const covered = new Map([["src/a.js", new Set([1, 2, 3])], ["src/b.js", new Set()]]);
  const r = diffCoverage({ changedLines: changed, covered, threshold: 80, sourceFilter: (f) => f.startsWith("src/") });
  expect(r.total).toBe(5); expect(r.coveredCount).toBe(3); expect(r.pct).toBe(60); expect(r.ok).toBe(false);
  expect(r.uncovered).toEqual([{ file: "src/a.js", lines: [4] }, { file: "src/b.js", lines: [7] }]);
});
test("no changed source lines → 100%, ok", () => {
  expect(diffCoverage({ changedLines: new Map(), covered: new Map(), threshold: 90, sourceFilter: () => true })).toMatchObject({ pct: 100, ok: true, total: 0 });
});

test("runDiffCoverage: coverage command failure does not fall back to a stale report", async () => {
  const run = makeFakeRun([{ match: (c) => c === "bash", result: { code: 1, stdout: "", stderr: "boom" } }]);
  const harness = { commands: { proof: { coverage: "npm run coverage", coverage_report: "coverage/coverage-final.json" } }, gates: { thresholds: { diff_coverage_pct: 90 } }, test: { source_glob: ["src/**"] } };
  const r = await runDiffCoverage({ run, cwd: "/repo", harness, base: "abc", readFile: () => JSON.stringify({ "src/a.js": { statementMap: {}, s: {} } }) });
  expect(r.ok).toBe(false);
  expect(r.detail).toMatch(/command failed/);
  expect(r.command_code).toBe(1);
});
