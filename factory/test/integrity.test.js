import { test, expect } from "vitest";
import { integrityCheck } from "../lib/integrity.js";
import { makeFakeRun } from "../lib/exec.js";

const harness = { protected: { factory: [".factory/**", ".claude/**", "docs/factory/CHARTER.md"], except: [".factory/lessons/**", "docs/factory/runs/**"], additive_only: { ".claude/agents/*.md": ["## Examples", "## Perspectives"] } }, test: { test_glob: ["test/**/*.test.js"] } };
const names = (s) => ({ match: (c, a) => a[0] === "diff" && a.includes("--name-status"), result: { code: 0, stdout: s, stderr: "" } });
const u0 = (s) => ({ match: (c, a) => a[0] === "diff" && a.includes("-U0"), result: { code: 0, stdout: s, stderr: "" } });

test("protected file change → violation; except path passes", async () => {
  const run = makeFakeRun([names("M\t.factory/harness.toml\nM\t.factory/lessons/reviewer-qa.md\nM\tsrc/a.js\n"), u0("")]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "<!-- factory-lessons:v1 role=reviewer-qa max=30 -->\n- [L-2026-09-01-01] x\n  근거: runs/1.md\n" });
  expect(r.ok).toBe(false); expect(r.violations).toEqual([{ file: ".factory/harness.toml", rule: "protected path changed" }]);
});
test("additive-only agent sections: additions in Examples ok; deletion or other section → violation", async () => {
  const okDiff = `+++ b/.claude/agents/reviewer-qa.md\n@@ -40,0 +41,2 @@\n+### 좋은 발견\n+- DST 25시간\n`;
  const run1 = makeFakeRun([names("M\t.claude/agents/reviewer-qa.md\n"), u0(okDiff)]);
  const r1 = await integrityCheck({ run: run1, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "## Purpose\n\n## Lens\n\n## Examples\n\n### 좋은 발견\n- DST 25시간\n\n## Perspectives\n" , readFileAt: () => "## Purpose\n\n## Lens\n\n## Examples\n\n## Perspectives\n" });
  expect(r1.ok).toBe(true);
  const badDiff = `+++ b/.claude/agents/reviewer-qa.md\n@@ -10,1 +10,1 @@\n-old lens\n+new lens\n`;
  const run2 = makeFakeRun([names("M\t.claude/agents/reviewer-qa.md\n"), u0(badDiff)]);
  const r2 = await integrityCheck({ run: run2, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "## Lens\nnew lens\n## Examples\n", readFileAt: () => "## Lens\nold lens\n## Examples\n" });
  expect(r2.ok).toBe(false); expect(r2.violations[0].rule).toMatch(/additive-only/);
});
test("skip/ignore pragmas added to tests → violation", async () => {
  const run = makeFakeRun([names("M\ttest/a.test.js\n"), u0(`+++ b/test/a.test.js\n@@ -1,0 +2,1 @@\n+test.skip("x", () => {});\n`)]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "" });
  expect(r.violations).toEqual([{ file: "test/a.test.js", rule: "test skip/ignore pragma added" }]);
});
test("lessons format violation", async () => {
  const run = makeFakeRun([names("M\t.factory/lessons/reviewer-qa.md\n"), u0("")]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "<!-- factory-lessons:v1 role=reviewer-qa max=1 -->\n- [L-2026-09-01-01] a\n  근거: r\n- bad entry\n" });
  expect(r.ok).toBe(false); expect(r.violations.map((v) => v.rule)).toEqual(expect.arrayContaining([expect.stringMatching(/lessons/)]));
});
