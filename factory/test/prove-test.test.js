import { test, expect } from "vitest";
import { proveTest, repeatNewTests } from "../lib/prove-test.js";
import { makeFakeRun } from "../lib/exec.js";

const harness = { commands: { test_files: "vitest run {files}", unit: "vitest run" } };
const wt = (res) => ({ match: (c, a) => c === "git" && a[0] === "worktree", result: res });
const ok = { code: 0, stdout: "", stderr: "" }, fail = { code: 1, stdout: "", stderr: "FAIL" };

test("proveTest ok when new tests FAIL on base", async () => {
  const run = makeFakeRun([wt(ok), { match: (c) => c === "cp", result: ok }, { match: (c, a) => c === "bash" && a[1].includes("vitest run") && a[1].includes("test/new.test.js"), result: fail }]);
  const r = await proveTest({ run, cwd: "/repo", harness, base: "abc", addedTests: ["test/new.test.js"], tmp: "/tmp/wt" });
  expect(r.ok).toBe(true);
  expect(run.calls.some((c) => c.cmd === "git" && c.args.join(" ") === "worktree add --detach /tmp/wt abc")).toBe(true);
  expect(run.calls.at(-1).args.join(" ")).toBe("worktree remove --force /tmp/wt");
});

test("proveTest NOT ok when new tests PASS on base (test proves nothing)", async () => {
  const run = makeFakeRun([wt(ok), { match: (c) => c === "cp", result: ok }, { match: (c) => c === "bash", result: ok }]);
  const r = await proveTest({ run, cwd: "/repo", harness, base: "abc", addedTests: ["test/new.test.js"], tmp: "/tmp/wt" });
  expect(r.ok).toBe(false); expect(r.detail).toMatch(/passed on base/);
});

test("proveTest fails when there are no new tests", async () => {
  const r = await proveTest({ run: makeFakeRun([]), cwd: "/repo", harness, base: "abc", addedTests: [] });
  expect(r.ok).toBe(false); expect(r.detail).toMatch(/no new tests/);
});

test("F9: commands.test_files가 없으면 터지지 않고 MISCONFIGURED로 돌아온다", async () => {
  const run = makeFakeRun([{ match: () => true, result: ok }]);
  const bare = { commands: {} };
  const pt = await proveTest({ run, cwd: "/repo", harness: bare, base: "abc", addedTests: ["test/new.test.js"], tmp: "/tmp/wt" });
  expect(pt).toEqual({ ok: false, misconfigured: true, detail: "commands.test_files missing" });
  const rp = await repeatNewTests({ run, cwd: "/repo", harness: bare, addedTests: ["test/new.test.js"], times: 3 });
  expect(rp).toMatchObject({ ok: false, misconfigured: true, detail: "commands.test_files missing" });
  expect(run.calls).toHaveLength(0);                                   // 워크트리도 만들지 않는다
});

test("repeatNewTests: 반복 횟수를 모르면 통과가 아니라 MISCONFIGURED다", async () => {
  const run = makeFakeRun([{ match: () => true, result: ok }]);
  for (const times of [undefined, 0, -1]) {
    const r = await repeatNewTests({ run, cwd: "/repo", harness, addedTests: ["test/new.test.js"], times });
    expect(r.ok, String(times)).toBe(false);
    expect(r.misconfigured, String(times)).toBe(true);
    expect(r.detail).toMatch(/new_test_repeats missing/);
  }
  expect(run.calls).toHaveLength(0);                                   // 설정이 없으면 아무것도 돌리지 않는다
});

test("repeatNewTests runs N times, first alongside the full suite; any failure → not ok", async () => {
  let n = 0;
  const run = makeFakeRun([
    { match: (c, a) => c === "bash" && a[1] === "vitest run", result: ok },
    { match: (c, a) => c === "bash" && a[1].includes("{files}") === false && a[1].includes("test/new.test.js"), result: () => (++n === 2 ? fail : ok) },
  ]);
  const r = await repeatNewTests({ run, cwd: "/repo", harness, addedTests: ["test/new.test.js"], times: 3 });
  expect(r.ok).toBe(false); expect(r.runs.map((x) => x.code)).toEqual([0, 1, 0]);
  expect(run.calls.filter((c) => c.args[1] === "vitest run")).toHaveLength(1);
});
