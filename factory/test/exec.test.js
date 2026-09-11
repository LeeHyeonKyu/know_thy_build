import { test, expect } from "vitest";
import { run, makeFakeRun } from "../lib/exec.js";

test("run executes a real command and captures stdout/code", async () => {
  const r = await run("node", ["-e", "process.stdout.write('hi'); process.exit(3)"]);
  expect(r.stdout).toBe("hi");
  expect(r.code).toBe(3);
}, 30000);

test("run passes stdin input", async () => {
  const r = await run("node", ["-e", "process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase()))"], { input: "abc" });
  expect(r.stdout).toBe("ABC");
  expect(r.code).toBe(0);
});

test("makeFakeRun matches by predicate and records calls", async () => {
  const fake = makeFakeRun([
    { match: (c, a) => c === "gh" && a[0] === "issue", result: { code: 0, stdout: '{"n":1}', stderr: "" } },
  ]);
  const r = await fake("gh", ["issue", "view", "1"]);
  expect(JSON.parse(r.stdout)).toEqual({ n: 1 });
  expect(fake.calls).toEqual([{ cmd: "gh", args: ["issue", "view", "1"], opts: {} }]);
  await expect(fake("git", ["status"])).rejects.toThrow(/unexpected command: git status/);
});
