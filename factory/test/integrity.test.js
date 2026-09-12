import { test, expect } from "vitest";
import { integrityCheck, protectedPaths } from "../lib/integrity.js";
import { makeFakeRun } from "../lib/exec.js";

const harness = { protected: { factory: [".factory/**", ".claude/**", "docs/factory/CHARTER.md"], except: [".factory/lessons/**", "docs/factory/runs/**"], additive_only: { ".claude/agents/*.md": ["## Examples", "## Perspectives"] } }, test: { test_glob: ["test/**/*.test.js"] } };
const names = (s) => ({ match: (c, a) => a[0] === "diff" && a.includes("--name-status"), result: { code: 0, stdout: s, stderr: "" } });
const u0 = (s) => ({ match: (c, a) => a[0] === "diff" && a.includes("-U0"), result: { code: 0, stdout: s, stderr: "" } });

// ── KTB-5: L0(integrity 체크) = 변조만. 보호 경로 변경은 위반이 아니라 **보고**다 ──────────
// (사람이 머지해야 한다는 신호일 뿐 — 그 신호가 체크를 RED로 만들면 사람도 머지할 수 없다)

test("KTB-5: protected file change → ok:true, violations 비어 있고 protected에 실린다; except path는 아예 안 실린다", async () => {
  const run = makeFakeRun([names("M\t.factory/harness.toml\nM\t.factory/lessons/reviewer-qa.md\nM\tsrc/a.js\n"), u0("")]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "<!-- factory-lessons:v1 role=reviewer-qa max=30 -->\n- [L-2026-09-01-01] x\n  근거: runs/1.md\n" });
  expect(r.ok).toBe(true);
  expect(r.violations).toEqual([]);
  expect(r.protected).toEqual([".factory/harness.toml"]);
});

test("KTB-5: 변조가 함께 있으면 ok:false — protected 목록은 그래도 채워진다(두 관심사가 독립적이다)", async () => {
  const run = makeFakeRun([names("M\t.factory/harness.toml\nM\ttest/a.test.js\n"), u0(`+++ b/test/a.test.js\n@@ -1,0 +2,1 @@\n+test.skip("x", () => {});\n`)]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "" });
  expect(r.ok).toBe(false);
  expect(r.violations).toEqual([{ file: "test/a.test.js", rule: "test skip/ignore pragma added" }]);
  expect(r.protected).toEqual([".factory/harness.toml"]);
});

test("KTB-5: additive_only 규칙이 보는 파일은 protected 목록에 넣지 않는다 — 그 파일의 판정은 additive-only 규칙이 한다", async () => {
  const examplesFixture = ["## Purpose", "## Lens", "## Examples", ...Array(37).fill(""), "### 좋은 발견", "- DST 25시간", "## Perspectives"].join("\n") + "\n";
  const okDiff = `+++ b/.claude/agents/reviewer-qa.md\n@@ -40,0 +41,2 @@\n+### 좋은 발견\n+- DST 25시간\n`;
  const run = makeFakeRun([names("M\t.claude/agents/reviewer-qa.md\n"), u0(okDiff)]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => examplesFixture });
  expect(r.ok).toBe(true);
  expect(r.protected).toEqual([]);
});

test("KTB-5: 판정 불가도 protected를 [] 로 싣는다 — 호출자가 undefined.length로 터지지 않게", async () => {
  const r = await integrityCheck({ run: makeFakeRun([]), cwd: "/repo", base: "", head: "h", harness, readFile: () => "" });
  expect(r.ok).toBe(false);
  expect(r.protected).toEqual([]);
});

// ── KTB-5: protectedPaths() — L1(merge 스테이지)이 쓰는 목록 전용 계산 ────────────────────
// 파일 내용을 **읽지 않는다**: merge는 PR head를 체크아웃한 트리 위에서 도는데, 그 트리의 파일을
// 읽어 판단하면 PR이 자기 판정 재료를 고를 수 있다. name-status diff만 본다.

test("KTB-5 protectedPaths: name-status만 보고 목록을 만든다 — -U0 diff도 파일 읽기도 하지 않는다", async () => {
  const run = makeFakeRun([names("M\t.factory/harness.toml\nM\tpackage.json\nM\t.factory/lessons/reviewer-qa.md\nA\tsrc/a.js\n")]);
  const h = { ...harness, protected: { ...harness.protected, factory: [...harness.protected.factory, "package.json"] } };
  const r = await protectedPaths({ run, cwd: "/repo", base: "b", head: "h", harness: h });
  expect(r).toEqual({ ok: true, files: [".factory/harness.toml", "package.json"] });
  expect(run.calls).toHaveLength(1);
  expect(run.calls[0].args).toEqual(["diff", "--name-status", "b...h"]);
});

test("KTB-5 protectedPaths: 보호 경로가 없으면 빈 목록 — ok:true", async () => {
  const run = makeFakeRun([names("M\tsrc/a.js\nM\t.factory/lessons/reviewer-qa.md\n")]);
  const r = await protectedPaths({ run, cwd: "/repo", base: "b", head: "h", harness });
  expect(r).toEqual({ ok: true, files: [] });
});

test("KTB-5 protectedPaths: base가 없거나 git이 실패하면 ok:false — 빈 목록을 '보호 경로 없음'으로 읽지 않는다", async () => {
  const empty = await protectedPaths({ run: makeFakeRun([]), cwd: "/repo", base: "", head: "h", harness });
  expect(empty.ok).toBe(false);
  expect(empty.files).toEqual([]);
  expect(empty.reason).toMatch(/base is empty/);
  const boom = makeFakeRun([{ match: (c, a) => a[0] === "diff", result: { code: 128, stdout: "", stderr: "fatal: no merge base" } }]);
  const failed = await protectedPaths({ run: boom, cwd: "/repo", base: "b", head: "h", harness });
  expect(failed.ok).toBe(false);
  expect(failed.files).toEqual([]);
  expect(failed.reason).toMatch(/exited 128/);
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
// ── F1: 검사하지 못한 것은 통과가 아니다 ────────────────────────────────────

test("git diff가 실패하면 ok:false — 빈 diff를 '위반 없음'으로 읽지 않는다", async () => {
  const boom = { code: 128, stdout: "", stderr: "fatal: no merge base" };
  for (const table of [
    [{ match: (c, a) => a[0] === "diff" && a.includes("--name-status"), result: boom }],
    [names("M\tsrc/a.js\n"), { match: (c, a) => a[0] === "diff" && a.includes("-U0"), result: boom }],
  ]) {
    const r = await integrityCheck({ run: makeFakeRun(table), cwd: "/repo", base: "b", head: "h", harness, readFile: () => "" });
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([{ file: "-", rule: expect.stringContaining("integrity could not be computed") }]);
    expect(r.violations[0].rule).toMatch(/exited 128/);
  }
});

test("base가 비어 있으면 검사 자체가 성립하지 않는다 — git을 부르지도 않는다", async () => {
  for (const base of ["", null, undefined]) {
    const run = makeFakeRun([{ match: () => true, result: { code: 0, stdout: "", stderr: "" } }]);
    const r = await integrityCheck({ run, cwd: "/repo", base, head: "h", harness, readFile: () => "" });
    expect(r.ok, String(base)).toBe(false);
    expect(r.violations[0].rule).toMatch(/integrity could not be computed: base is empty/);
    expect(run.calls).toHaveLength(0);
  }
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
