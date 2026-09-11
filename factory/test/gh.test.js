import { test, expect } from "vitest";
import { makeGh, allChecksGreen } from "../lib/gh.js";
import { makeFakeRun } from "../lib/exec.js";

const repo = "o/r";
test("issue() maps gh json; comments() maps id/body/createdAt", async () => {
  const run = makeFakeRun([
    { match: (c, a) => a.includes("view") && a.includes("--json"), result: { code: 0, stdout: JSON.stringify({ number: 5, title: "T", body: "B", labels: [{ name: "backlog" }, { name: "bug" }] }), stderr: "" } },
    // --slurp은 페이지마다 하나의 배열을 담은 배열을 낸다
    { match: (c, a) => a[0] === "api" && a[1].includes("/comments"), result: { code: 0, stdout: JSON.stringify([[{ id: 11, body: "x", created_at: "2026-09-11T00:00:00Z" }], [{ id: 12, body: "y", created_at: "2026-09-11T01:00:00Z" }]]), stderr: "" } },
  ]);
  const gh = makeGh({ run, repo });
  const issue = await gh.issue(5);
  expect(issue).toEqual({ number: 5, title: "T", body: "B", labels: ["backlog", "bug"] });
  expect(await gh.comments(5)).toEqual([
    { id: 11, body: "x", createdAt: "2026-09-11T00:00:00Z" },
    { id: 12, body: "y", createdAt: "2026-09-11T01:00:00Z" },
  ]);
  const api = run.calls.find((c) => c.args[0] === "api");
  expect(api.args).toEqual(["api", "repos/o/r/issues/5/comments?per_page=100", "--paginate", "--slurp"]);
});

test("setFactoryLabel removes other factory state labels and adds the new one", async () => {
  const run = makeFakeRun([
    { match: (c, a) => a.includes("view"), result: { code: 0, stdout: JSON.stringify({ number: 5, title: "", body: "", labels: [{ name: "factory:ready" }, { name: "bug" }] }), stderr: "" } },
    { match: (c, a) => a.includes("edit"), result: { code: 0, stdout: "", stderr: "" } },
  ]);
  const gh = makeGh({ run, repo });
  await gh.setFactoryLabel(5, "factory:planned");
  const edit = run.calls.find((c) => c.args.includes("edit"));
  expect(edit.args).toEqual(["issue", "edit", "5", "-R", repo, "--remove-label", "factory:ready", "--add-label", "factory:planned"]);
});

test("comment() posts body via --body-file from stdin", async () => {
  const run = makeFakeRun([{ match: (c, a) => a.includes("comment"), result: { code: 0, stdout: "https://x/1#issuecomment-99", stderr: "" } }]);
  const gh = makeGh({ run, repo });
  const url = await gh.comment(5, "hello");
  expect(url).toContain("issuecomment-99");
  const call = run.calls[0];
  expect(call.args).toEqual(["issue", "comment", "5", "-R", repo, "--body-file", "-"]);
  expect(call.opts.input).toBe("hello");
});

test("patchComment sends body via --input stdin JSON (avoids -f @-prefix file interpretation)", async () => {
  const run = makeFakeRun([{ match: (c, a) => a.includes("PATCH"), result: { code: 0, stdout: "", stderr: "" } }]);
  const gh = makeGh({ run, repo });
  await gh.patchComment(42, "@user hi");
  const call = run.calls[0];
  expect(call.args.slice(-2)).toEqual(["--input", "-"]);
  expect(call.opts.input).toBe(JSON.stringify({ body: "@user hi" }));
});

test("non-zero exit throws with stderr", async () => {
  const run = makeFakeRun([{ match: () => true, result: { code: 1, stdout: "", stderr: "boom" } }]);
  await expect(makeGh({ run, repo }).issue(1)).rejects.toThrow(/boom/);
});

test("searchIssues lists open issues by label", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "issue" && a[1] === "list", result: { code: 0, stdout: JSON.stringify([{ number: 1, title: "T", updatedAt: "2026-09-11T00:00:00Z" }]), stderr: "" } }]);
  const gh = makeGh({ run, repo });
  const issues = await gh.searchIssues("factory:awaiting-review");
  expect(issues).toEqual([{ number: 1, title: "T", updatedAt: "2026-09-11T00:00:00Z" }]);
  const call = run.calls[0];
  expect(call.args).toEqual(["issue", "list", "-R", repo, "--label", "factory:awaiting-review", "--state", "open", "--limit", "200", "--json", "number,title,updatedAt"]);
});

test("createIssue returns the issue number parsed from the created URL", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "issue" && a[1] === "create", result: { code: 0, stdout: "https://github.com/o/r/issues/42\n", stderr: "" } }]);
  const gh = makeGh({ run, repo });
  const n = await gh.createIssue({ title: "factory: 토큰 갱신 필요", body: "body", labels: ["factory:needs-human"] });
  expect(n).toBe(42);
  const call = run.calls[0];
  expect(call.args).toEqual(["issue", "create", "-R", repo, "--title", "factory: 토큰 갱신 필요", "--body-file", "-", "--label", "factory:needs-human"]);
  expect(call.opts.input).toBe("body");
});

test("prChecks asks for name,state,bucket; allChecksGreen is fail-closed and falls back to state", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "pr" && a[1] === "checks", result: { code: 0, stdout: JSON.stringify([{ name: "ci", state: "SUCCESS", bucket: "pass" }]), stderr: "" } }]);
  expect(await makeGh({ run, repo }).prChecks(9)).toEqual([{ name: "ci", state: "SUCCESS", bucket: "pass" }]);
  expect(run.calls[0].args).toEqual(["pr", "checks", "9", "-R", repo, "--json", "name,state,bucket"]);
  expect(allChecksGreen([{ bucket: "pass" }, { bucket: "pass" }])).toBe(true);
  expect(allChecksGreen([{ bucket: "pass" }, { bucket: "fail" }])).toBe(false);
  expect(allChecksGreen([])).toBe(false);                                  // 체크가 하나도 없으면 "확인됨"이 아니다
  expect(allChecksGreen([{ state: "SUCCESS" }])).toBe(true);               // bucket을 모르는 gh 버전
  expect(allChecksGreen([{ state: "FAILURE" }])).toBe(false);
});

test("getVariable returns trimmed value, or null on non-zero exit (missing variable)", async () => {
  const run = makeFakeRun([{ match: () => true, result: { code: 0, stdout: "2025-10-11T00:00:00Z\n", stderr: "" } }]);
  expect(await makeGh({ run, repo }).getVariable("FACTORY_TOKEN_ISSUED_AT")).toBe("2025-10-11T00:00:00Z");
  const runMissing = makeFakeRun([{ match: () => true, result: { code: 1, stdout: "", stderr: "variable not found" } }]);
  expect(await makeGh({ run: runMissing, repo }).getVariable("FACTORY_TOKEN_ISSUED_AT")).toBe(null);
});
