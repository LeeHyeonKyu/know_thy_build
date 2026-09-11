import { test, expect } from "vitest";
import { classifyFailures } from "../lib/classify-failure.js";
import { makeFakeRun } from "../lib/exec.js";

// {name}은 lib이 따옴표를 붙인다 — 하네스는 맨 플레이스홀더만 쓴다(§5.1 test_one 계약).
const harness = { commands: { test_one: "vitest run {file} -t {name}" } };
const T = { flaky_isolation_runs: 3, flaky_base_runs: 5 };
const ok = { code: 0, stdout: "", stderr: "" }, fail = { code: 1, stdout: "", stderr: "" };
const f = { id: "test/a.test.js::x", file: "test/a.test.js", name: "x" };
const base = (codes) => { let i = 0; return { match: (c, a, o) => c === "bash" && o.cwd === "/tmp/wt", result: () => (codes[i++] === 0 ? ok : fail) }; };
const pr = (codes) => { let i = 0; return { match: (c, a, o) => c === "bash" && o.cwd === "/repo", result: () => (codes[i++] === 0 ? ok : fail) }; };
const wt = { match: (c) => c === "git", result: ok };

test("new test failure → red without reruns", async () => {
  const run = makeFakeRun([]);
  const r = await classifyFailures({ run, cwd: "/repo", harness, failing: [f], base: "b", thresholds: T, addedTests: ["test/a.test.js"] });
  expect(r).toEqual([{ id: f.id, verdict: "red", evidence: { reason: "new test in this change" } }]);
});
test("fails in PR isolation → red", async () => {
  const run = makeFakeRun([wt, pr([0, 1, 0])]);
  const [r] = await classifyFailures({ run, cwd: "/repo", harness, failing: [f], base: "b", thresholds: T, addedTests: [], tmp: "/tmp/wt" });
  expect(r.verdict).toBe("red"); expect(r.evidence.pr_isolation).toEqual([0, 1, 0]);
});
test("passes in PR isolation, never fails on base → introduced", async () => {
  const run = makeFakeRun([wt, pr([0, 0, 0]), base([0, 0, 0, 0, 0])]);
  const [r] = await classifyFailures({ run, cwd: "/repo", harness, failing: [f], base: "b", thresholds: T, addedTests: [], tmp: "/tmp/wt" });
  expect(r.verdict).toBe("introduced"); expect(r.evidence.base).toEqual([0, 0, 0, 0, 0]);
});
test("passes in PR isolation, fails on base too → flaky-existing", async () => {
  const run = makeFakeRun([wt, pr([0, 0, 0]), base([0, 1, 0, 0, 0])]);
  const [r] = await classifyFailures({ run, cwd: "/repo", harness, failing: [f], base: "b", thresholds: T, addedTests: [], tmp: "/tmp/wt" });
  expect(r.verdict).toBe("flaky-existing");
});
test("F8: {name}도 lib이 따옴표를 붙인다 — 이름의 작은따옴표가 명령을 깨지 않는다", async () => {
  const tricky = { id: "test/a.test.js::it's 'quoted'", file: "test/a.test.js", name: "it's 'quoted'" };
  const run = makeFakeRun([wt, pr([0, 0, 0]), base([0, 0, 0, 0, 0])]);
  await classifyFailures({ run, cwd: "/repo", harness, failing: [tricky], base: "b", thresholds: T, addedTests: [], tmp: "/tmp/wt" });
  const cmd = run.calls.find((c) => c.cmd === "bash").args[1];
  expect(cmd).toBe("vitest run 'test/a.test.js' -t 'it'\\''s '\\''quoted'\\'''");
});

test("F9: commands.test_one이 없으면 터지지 않고 blocked로 분류된다", async () => {
  const run = makeFakeRun([]);
  const f2 = { id: "test/b.test.js::y", file: "test/b.test.js", name: "y" };
  const r = await classifyFailures({ run, cwd: "/repo", harness: { commands: {} }, failing: [f, f2], base: "b", thresholds: T, addedTests: ["test/b.test.js"] });
  expect(r).toEqual([
    { id: f2.id, verdict: "red", evidence: { reason: "new test in this change" } },       // 새 테스트는 명령 없이도 red
    { id: f.id, verdict: "blocked", evidence: { error: "commands.test_one missing" } },
  ]);
  expect(run.calls).toHaveLength(0);
});

test("worktree add fails → this and every remaining existing test is blocked, no base runs attempted", async () => {
  const f2 = { id: "test/b.test.js::y", file: "test/b.test.js", name: "y" };
  const wtFail = { match: (c) => c === "git", result: fail };
  const run = makeFakeRun([wtFail, pr([0, 0, 0])]);
  const r = await classifyFailures({ run, cwd: "/repo", harness, failing: [f, f2], base: "b", thresholds: T, addedTests: [], tmp: "/tmp/wt" });
  expect(r).toEqual([
    { id: f.id, verdict: "blocked", evidence: { pr_isolation: [0, 0, 0], error: expect.stringContaining("worktree add failed") } },
    { id: f2.id, verdict: "blocked", evidence: { error: expect.stringContaining("worktree add failed") } },
  ]);
  // f2's isolation reruns must never have been attempted
  const f2Calls = run.calls.filter((c) => c.cmd === "bash" && c.args[1]?.includes(f2.file));
  expect(f2Calls.length).toBe(0);
  const baseCalls = run.calls.filter((c) => c.cmd === "bash" && c.opts.cwd === "/tmp/wt");
  expect(baseCalls.length).toBe(0);
});
