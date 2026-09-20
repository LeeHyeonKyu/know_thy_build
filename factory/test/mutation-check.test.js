import { test, expect } from "vitest";
import { checkNewTestsFailOnMutation, mutateSource, resolveTargets } from "../lib/mutation-check.js";
import { makeFakeRun } from "../lib/exec.js";

const harness = { commands: { test_files: "vitest run {files}" } };
const ok = { code: 0, stdout: "", stderr: "" };
const red = { code: 1, stdout: "", stderr: "AssertionError" };
const wt = (res) => ({ match: (c, a) => c === "git" && a[0] === "worktree", result: res });

/** Injected fs double: a path→content map for reads, and a recorded write log. */
function fakeFs(files) {
  const writes = [];
  const store = new Map(Object.entries(files));
  return {
    writes,
    exists: (p) => store.has(p),
    readFile: (p) => (store.has(p) ? store.get(p) : null),
    writeFile: (p, c) => { store.set(p, c); writes.push({ p, c }); },
  };
}

// --- mutateSource: the mutation set ---

test("mutateSource: regression own-cal R1 cf1 — altering the asserted warning STRING is a real mutation", () => {
  // The real defect: a safety guard test that stayed green when the warning content was deleted/altered.
  // The string mutator must change the warning content so a fail-closed test would go red.
  const src = 'export const WARNING = "danger: never run against production";\n';
  const { mutated, applied } = mutateSource(src);
  expect(applied).toContain("string");
  expect(mutated).toContain("__MUTATED__");
  expect(mutated).not.toContain("danger: never run against production");
});

test("mutateSource: covers boolean, comparison, numeric and logical operators", () => {
  expect(mutateSource("return true;").mutated).toContain("false");
  expect(mutateSource("if (a === b) {}").mutated).toContain("!==");
  expect(mutateSource("const n = 41;").mutated).toContain("42");
  expect(mutateSource("if (a && b) {}").mutated).toContain("||");
});

test("mutateSource: does not touch import path strings (they would break resolution, not test the property)", () => {
  const src = 'import { warn } from "./warn.js";\nexport const M = "hello";\n';
  const { mutated } = mutateSource(src);
  expect(mutated).toContain('from "./warn.js"'); // import path preserved
  expect(mutated).toContain("__MUTATED__");       // the real string literal is the one mutated
});

test("mutateSource: a source with no mutable token yields no mutation", () => {
  const { applied } = mutateSource("export const xs = [];\n");
  expect(applied).toEqual([]);
});

// --- resolveTargets: finding the source the test asserts on ---

test("resolveTargets: resolves a relative source import, ignoring vitest and test files", () => {
  const fs = fakeFs({ "/wt/src/warn.js": "x" });
  const targets = resolveTargets({
    testFile: "test/warn.test.js",
    tmp: "/wt",
    exists: fs.exists,
    readFile: () => 'import { warn } from "../src/warn.js";\nimport { test } from "vitest";\n',
  });
  expect(targets).toEqual(["src/warn.js"]);
});

// --- checkNewTestsFailOnMutation: orchestration ---

test("(a) a guard test that passes whether or not the property holds is a SURVIVOR", async () => {
  // Mutate the target source, the test still passes green → it asserts nothing → survivor.
  const fs = fakeFs({ "/wt/src/warn.js": 'export const WARNING = "danger: prod";\n' });
  const run = makeFakeRun([wt(ok), { match: (c) => c === "bash", result: ok }]);
  const r = await checkNewTestsFailOnMutation({
    root: "/wt", tmp: "/wt", harness, run,
    newTests: [{ file: "test/warn.test.js", target: "src/warn.js" }],
    exists: fs.exists, readFile: fs.readFile, writeFile: fs.writeFile,
  });
  expect(r.ok).toBe(false);
  expect(r.survivors.map((s) => s.file)).toEqual(["test/warn.test.js"]);
  // source restored after the run (mutated then written back to the original)
  const warnWrites = fs.writes.filter((w) => w.p === "/wt/src/warn.js");
  expect(warnWrites.at(-1).c).toBe('export const WARNING = "danger: prod";\n');
  // worktree removed
  expect(run.calls.at(-1).args.join(" ")).toBe("worktree remove --force /wt");
});

test("(b) a fail-closed test that goes RED under mutation → ok:true, no survivor", async () => {
  const fs = fakeFs({ "/wt/src/warn.js": 'export const WARNING = "danger: prod";\n' });
  const run = makeFakeRun([wt(ok), { match: (c) => c === "bash", result: red }]);
  const r = await checkNewTestsFailOnMutation({
    root: "/wt", tmp: "/wt", harness, run,
    newTests: [{ file: "test/warn.test.js", target: "src/warn.js" }],
    exists: fs.exists, readFile: fs.readFile, writeFile: fs.writeFile,
  });
  expect(r.ok).toBe(true);
  expect(r.survivors).toEqual([]);
});

test("(c) a test with no resolvable target is SKIPPED with a reason, not a survivor", async () => {
  const fs = fakeFs({});
  const run = makeFakeRun([wt(ok)]); // no bash run happens — nothing to mutate
  const r = await checkNewTestsFailOnMutation({
    root: "/wt", tmp: "/wt", harness, run,
    newTests: ["test/noop.test.js"],
    exists: fs.exists,
    readFile: () => 'import { test, expect } from "vitest";\ntest("noop", () => expect(1).toBe(1));\n',
    writeFile: fs.writeFile,
  });
  expect(r.ok).toBe(true);
  expect(r.survivors).toEqual([]);
  expect(r.skipped).toHaveLength(1);
  expect(r.skipped[0]).toMatchObject({ file: "test/noop.test.js" });
  expect(r.skipped[0].reason).toMatch(/no resolvable source target/);
  expect(run.calls.some((c) => c.cmd === "bash")).toBe(false);
});

test("(c') a target with no applicable mutation is SKIPPED, not a survivor", async () => {
  const fs = fakeFs({ "/wt/src/inert.js": "export const xs = [];\n" });
  const run = makeFakeRun([wt(ok)]);
  const r = await checkNewTestsFailOnMutation({
    root: "/wt", tmp: "/wt", harness, run,
    newTests: [{ file: "test/inert.test.js", target: "src/inert.js" }],
    exists: fs.exists, readFile: fs.readFile, writeFile: fs.writeFile,
  });
  expect(r.skipped[0].reason).toMatch(/no applicable structural mutation/);
  expect(r.survivors).toEqual([]);
});

test("(d) a throwing run still restores the source and removes the worktree", async () => {
  const fs = fakeFs({ "/wt/src/warn.js": 'export const WARNING = "danger: prod";\n' });
  const run = makeFakeRun([
    wt(ok),
    { match: (c) => c === "bash", result: () => { throw new Error("boom"); } },
  ]);
  await expect(checkNewTestsFailOnMutation({
    root: "/wt", tmp: "/wt", harness, run,
    newTests: [{ file: "test/warn.test.js", target: "src/warn.js" }],
    exists: fs.exists, readFile: fs.readFile, writeFile: fs.writeFile,
  })).rejects.toThrow(/boom/);
  // source restored despite the throw
  expect(fs.writes.at(-1)).toMatchObject({ p: "/wt/src/warn.js", c: 'export const WARNING = "danger: prod";\n' });
  // worktree removed in finally
  expect(run.calls.at(-1).args.join(" ")).toBe("worktree remove --force /wt");
});

test("commands.test_files missing → misconfigured, no worktree created", async () => {
  const run = makeFakeRun([{ match: () => true, result: ok }]);
  const r = await checkNewTestsFailOnMutation({
    root: "/wt", harness: { commands: {} }, run,
    newTests: [{ file: "test/warn.test.js", target: "src/warn.js" }],
  });
  expect(r).toMatchObject({ ok: false, misconfigured: true });
  expect(run.calls).toHaveLength(0);
});

test("worktree add failure → all tests skipped (couldn't check), never fail-closed", async () => {
  const run = makeFakeRun([wt({ code: 1, stdout: "", stderr: "add failed" })]);
  const r = await checkNewTestsFailOnMutation({
    root: "/wt", tmp: "/wt", harness, run,
    newTests: [{ file: "test/warn.test.js", target: "src/warn.js" }],
  });
  expect(r.ok).toBe(true);
  expect(r.survivors).toEqual([]);
  expect(r.skipped[0].reason).toMatch(/worktree add failed/);
});
