import { test, expect } from "vitest";
import { diffCoverage } from "../lib/diff-coverage.js";

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
