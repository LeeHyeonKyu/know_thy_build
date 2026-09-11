import { test, expect } from "vitest";
import { claim, release } from "../lib/claim.js";
import { makeFakeRun } from "../lib/exec.js";

const base = [
  { match: (c, a) => c === "git" && a[0] === "hash-object", result: { code: 0, stdout: "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n", stderr: "" } },
  { match: (c, a) => c === "git" && a[0] === "commit-tree", result: { code: 0, stdout: "deadbeef".repeat(5) + "\n", stderr: "" } },
];

test("claim succeeds when push creates the lock ref", async () => {
  const run = makeFakeRun([...base, { match: (c, a) => c === "git" && a[0] === "push", result: { code: 0, stdout: "", stderr: " * [new branch] deadbeef -> factory/lock-7" } }]);
  const r = await claim({ run, cwd: "/repo", issue: 7, stage: "implement", runnerId: "gha-1" });
  expect(r.ok).toBe(true);
  const push = run.calls.find((c) => c.args[0] === "push");
  expect(push.args).toEqual(["push", "origin", "deadbeef".repeat(5) + ":refs/heads/factory/lock-7"]);
  const ct = run.calls.find((c) => c.args[0] === "commit-tree");
  expect(ct.args.join(" ")).toMatch(/lock issue=7 stage=implement runner=gha-1/);
});

test("claim fails (ok:false, holder from remote message) when ref exists", async () => {
  const run = makeFakeRun([...base,
    { match: (c, a) => c === "git" && a[0] === "push", result: { code: 1, stdout: "", stderr: "! [rejected] deadbeef -> factory/lock-7 (fetch first)" } },
    { match: (c, a) => c === "git" && a[0] === "ls-remote", result: { code: 0, stdout: "cafebabe\trefs/heads/factory/lock-7\n", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "fetch", result: { code: 0, stdout: "", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "log", result: { code: 0, stdout: "lock issue=7 stage=implement runner=local/mac at=2026-09-11T00:00:00Z\n", stderr: "" } },
  ]);
  const r = await claim({ run, cwd: "/repo", issue: 7, stage: "implement", runnerId: "gha-2" });
  expect(r.ok).toBe(false);
  expect(r.holder).toMatch(/runner=local\/mac/);
});

test("release deletes the lock ref", async () => {
  const run = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "push", result: { code: 0, stdout: "", stderr: "" } }]);
  await release({ run, cwd: "/repo", issue: 7 });
  expect(run.calls[0].args).toEqual(["push", "origin", "--delete", "refs/heads/factory/lock-7"]);
});
