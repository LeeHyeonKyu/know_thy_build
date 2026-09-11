import { test, expect } from "vitest";
import { changedFiles, changedLines } from "../lib/changed-files.js";
import { globToRegex } from "../lib/glob.js";
import { makeFakeRun } from "../lib/exec.js";

const harness = { test: { test_glob: ["test/**/*.test.js", "e2e/**/*.spec.{js,ts}"], source_glob: ["src/**/*.js"] } };

test("globToRegex handles **, *, {a,b}", () => {
  expect(globToRegex("test/**/*.test.js").test("test/a/b/c.test.js")).toBe(true);
  expect(globToRegex("test/**/*.test.js").test("src/c.test.js")).toBe(false);
  expect(globToRegex("e2e/**/*.spec.{js,ts}").test("e2e/x.spec.ts")).toBe(true);
  expect(globToRegex("src/**/*.js").test("src/a.js")).toBe(true);
});

test("changedFiles classifies by status and globs", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "diff" && a.includes("--name-status"), result: { code: 0, stdout: "A\ttest/new.test.js\nM\tsrc/a.js\nM\ttest/old.test.js\nA\tdocs/x.md\nD\tsrc/gone.js\n", stderr: "" } }]);
  const r = await changedFiles({ run, cwd: "/repo", base: "abc", harness });
  expect(r.all).toEqual(["test/new.test.js", "src/a.js", "test/old.test.js", "docs/x.md", "src/gone.js"]);
  expect(r.added).toEqual(["test/new.test.js", "docs/x.md"]);
  expect(r.tests).toEqual(["test/new.test.js", "test/old.test.js"]);
  expect(r.addedTests).toEqual(["test/new.test.js"]);
  expect(r.sources).toEqual(["src/a.js"]);                              // 지워진 파일은 검사 대상이 아니다
  expect(run.calls[0].args).toEqual(["diff", "--name-status", "abc...HEAD"]);
});

test("tests/sources는 삭제를 빼고, 이름이 바뀐 파일은 새 경로로 친다", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "diff" && a.includes("--name-status"), result: { code: 0, stdout: "D\ttest/gone.test.js\nR100\ttest/old.test.js\ttest/moved.test.js\nD\tsrc/dead.js\nR090\tsrc/from.js\tsrc/to.js\n", stderr: "" } }]);
  const r = await changedFiles({ run, cwd: "/repo", base: "abc", harness });
  expect(r.all).toContain("test/gone.test.js");                         // all은 삭제도 그대로 담는다
  expect(r.tests).toEqual(["test/moved.test.js"]);
  expect(r.sources).toEqual(["src/to.js"]);
  expect(r.addedTests).toEqual([]);
});

test("changedLines parses -U0 hunks (added/modified lines only)", async () => {
  const diff = `diff --git a/src/a.js b/src/a.js
--- a/src/a.js
+++ b/src/a.js
@@ -10,0 +11,2 @@
+x
+y
@@ -20 +22 @@
-old
+new
diff --git a/src/gone.js b/src/gone.js
--- a/src/gone.js
+++ /dev/null
@@ -1,3 +0,0 @@
-a
-b
-c
`;
  const run = makeFakeRun([{ match: (c, a) => a[0] === "diff" && a.includes("-U0"), result: { code: 0, stdout: diff, stderr: "" } }]);
  const m = await changedLines({ run, cwd: "/repo", base: "abc" });
  expect([...m.get("src/a.js")].sort((a, b) => a - b)).toEqual([11, 12, 22]);
  expect(m.has("src/gone.js")).toBe(false);
});
