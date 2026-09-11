import { test, expect } from "vitest";
import { makeGh } from "../lib/gh.js";
import { makeFakeRun } from "../lib/exec.js";

const repo = "o/r";
test("issue() maps gh json; comments() maps id/body/createdAt", async () => {
  const run = makeFakeRun([
    { match: (c, a) => a.includes("view") && a.includes("--json"), result: { code: 0, stdout: JSON.stringify({ number: 5, title: "T", body: "B", labels: [{ name: "backlog" }, { name: "bug" }] }), stderr: "" } },
    { match: (c, a) => a[0] === "api" && a[1].includes("/comments"), result: { code: 0, stdout: JSON.stringify([{ id: 11, body: "x", created_at: "2026-09-11T00:00:00Z" }]), stderr: "" } },
  ]);
  const gh = makeGh({ run, repo });
  const issue = await gh.issue(5);
  expect(issue).toEqual({ number: 5, title: "T", body: "B", labels: ["backlog", "bug"] });
  expect(await gh.comments(5)).toEqual([{ id: 11, body: "x", createdAt: "2026-09-11T00:00:00Z" }]);
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

test("non-zero exit throws with stderr", async () => {
  const run = makeFakeRun([{ match: () => true, result: { code: 1, stdout: "", stderr: "boom" } }]);
  await expect(makeGh({ run, repo }).issue(1)).rejects.toThrow(/boom/);
});
