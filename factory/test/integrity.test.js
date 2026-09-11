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
  // 신규 파일 41~42번째 줄이 '## Examples' 아래에 오도록 채운 픽스처 (hunk: @@ -40,0 +41,2 @@)
  const examplesFixture = ["## Purpose", "## Lens", "## Examples", ...Array(37).fill(""), "### 좋은 발견", "- DST 25시간", "## Perspectives"].join("\n") + "\n";
  const okDiff = `+++ b/.claude/agents/reviewer-qa.md\n@@ -40,0 +41,2 @@\n+### 좋은 발견\n+- DST 25시간\n`;
  const run1 = makeFakeRun([names("M\t.claude/agents/reviewer-qa.md\n"), u0(okDiff)]);
  const r1 = await integrityCheck({ run: run1, cwd: "/repo", base: "b", head: "h", harness, readFile: () => examplesFixture, readFileAt: () => "## Purpose\n\n## Lens\n\n## Examples\n\n## Perspectives\n" });
  expect(r1.ok).toBe(true);
  const badDiff = `+++ b/.claude/agents/reviewer-qa.md\n@@ -10,1 +10,1 @@\n-old lens\n+new lens\n`;
  const run2 = makeFakeRun([names("M\t.claude/agents/reviewer-qa.md\n"), u0(badDiff)]);
  const r2 = await integrityCheck({ run: run2, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "## Lens\nnew lens\n## Examples\n", readFileAt: () => "## Lens\nold lens\n## Examples\n" });
  expect(r2.ok).toBe(false); expect(r2.violations[0].rule).toMatch(/additive-only/);
});
test("additive-only is position-aware: added blank line under Lens is a violation even though a blank line also exists under Examples", async () => {
  const diff = `+++ b/.claude/agents/reviewer-qa.md\n@@ -2,0 +3,1 @@\n+\n`;
  const run = makeFakeRun([names("M\t.claude/agents/reviewer-qa.md\n"), u0(diff)]);
  const readFile = () => "## Purpose\n## Lens\n\n## Examples\n\n## Perspectives\n"; // line 3 (added) is the blank line under ## Lens
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile });
  expect(r.ok).toBe(false);
  expect(r.violations[0].rule).toMatch(/additive-only/);
});
test("additive-only: an added '## ' header cannot self-legitimize the disallowed content it follows", async () => {
  // base: Purpose / Lens / Examples / Perspectives. Under Lens (after line 2) inject two new
  // lines: "malicious" content, then a forged "## Examples" header — trying to make sectionAt
  // treat "malicious" as if it were inside the (already-allowed) Examples section.
  const readFile = () => "## Purpose\n## Lens\nmalicious\n## Examples\n## Examples\n## Perspectives\n";
  const diff = `+++ b/.claude/agents/reviewer-qa.md\n@@ -2,0 +3,2 @@\n+malicious\n+## Examples\n`;
  const run = makeFakeRun([names("M\t.claude/agents/reviewer-qa.md\n"), u0(diff)]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile });
  expect(r.ok).toBe(false);
  expect(r.violations.some((v) => v.rule === "additive-only: header added")).toBe(true);
  expect(r.violations.some((v) => /additive-only sections.*outside/.test(v.rule))).toBe(true);
});
test("full deletion of an additive-only/protected file → violation", async () => {
  const delDiff = `--- a/.claude/agents/reviewer-qa.md\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-## Purpose\n-## Examples\n-content\n`;
  const run = makeFakeRun([names("D\t.claude/agents/reviewer-qa.md\n"), u0(delDiff)]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => null });
  expect(r.ok).toBe(false);
  expect(r.violations.some((v) => /additive-only|protected/.test(v.rule))).toBe(true);
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
test("lessons per-entry 근거: 3 entries, 2 missing 근거 → 2 violations", async () => {
  const run = makeFakeRun([names("M\t.factory/lessons/reviewer-qa.md\n"), u0("")]);
  const text = "<!-- factory-lessons:v1 role=reviewer-qa max=10 -->\n- [L-2026-09-01-01] a\n  근거: r1\n- [L-2026-09-01-02] b\n- [L-2026-09-01-03] c\n";
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => text });
  const missing = r.violations.filter((v) => /missing 근거/.test(v.rule));
  expect(missing.length).toBe(2);
  expect(missing.map((v) => v.rule)).toEqual(expect.arrayContaining([
    expect.stringContaining("L-2026-09-01-02"),
    expect.stringContaining("L-2026-09-01-03"),
  ]));
});
