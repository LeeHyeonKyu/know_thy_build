import { test, expect } from "vitest";
import { checkNewTestsFailOnMutation, structuralMutations, resolveTargets, isWrongReasonRed } from "../lib/mutation-check.js";
import { makeFakeRun } from "../lib/exec.js";

// runtime.setup forces baseInstallCommand → "npm ci" deterministically (no reliance on exists()).
const harness = { commands: { test_files: "vitest run {files}" }, runtime: { setup: "npm ci" } };
const ok = { code: 0, stdout: "", stderr: "" };
const assertionRed = { code: 1, stdout: "", stderr: "AssertionError: expected 'a' to be 'b'" };
const moduleRed = { code: 1, stdout: "Error: Cannot find module 'vitest'", stderr: "" };

// git worktree matchers: `add` must be separable from the pre-prune / finally `remove`.
const wtAdd = (res) => ({ match: (c, a) => c === "git" && a[0] === "worktree" && a[1] === "add", result: res });
const wtOther = (res = ok) => ({ match: (c, a) => c === "git" && a[0] === "worktree", result: res });
const npmci = (res = ok) => ({ match: (c, a) => c === "bash" && a[1] === "npm ci", result: res });

/** Injected fs double: a path→content map for reads, and a recorded write log. */
function fakeFs(files) {
  const writes = [];
  const store = new Map(Object.entries(files));
  return {
    writes, store,
    exists: (p) => store.has(p),
    readFile: (p) => (store.has(p) ? store.get(p) : null),
    writeFile: (p, c) => { store.set(p, c); writes.push({ p, c }); },
  };
}

/**
 * A vitest run double that returns per-test-file, per-invocation results — so a single command string
 * (`vitest run 'test/x.test.js'`) can yield baseline then mutated results in order.
 * `seq` = { "<test path>": [firstResult, secondResult, …] } (last entry repeats if exhausted).
 */
function vitestSeq(seq) {
  const idx = {};
  return {
    match: (c, a) => c === "bash" && a[1].includes("vitest"),
    result: (c, a) => {
      const file = Object.keys(seq).find((f) => a[1].includes(f));
      const arr = seq[file];
      const i = (idx[file] = (idx[file] || 0));
      idx[file] = i + 1;
      return arr[i] ?? arr[arr.length - 1];
    },
  };
}

// --- structuralMutations: the mutation set ---

test("structuralMutations: regression own-cal R1 cf1 — altering the asserted warning STRING is a real mutation", () => {
  const src = 'export const WARNING = "danger: never run against production";\n';
  const muts = structuralMutations(src);
  const s = muts.find((m) => m.name === "string");
  expect(s).toBeTruthy();
  expect(s.mutated).toContain("__MUTATED__");
  expect(s.mutated).not.toContain("danger: never run against production");
});

test("structuralMutations: covers boolean, comparison, numeric, logical — each applied to fresh source (not cumulative)", () => {
  expect(structuralMutations("return true;").find((m) => m.name === "boolean").mutated).toContain("false");
  expect(structuralMutations("if (a === b) {}").find((m) => m.name === "comparison").mutated).toContain("!==");
  expect(structuralMutations("const n = 41;").find((m) => m.name === "numeric").mutated).toContain("42");
  expect(structuralMutations("if (a && b) {}").find((m) => m.name === "logical").mutated).toContain("||");
  // fresh-source, not cumulative: a source with two tokens yields two INDEPENDENT single mutations.
  const two = structuralMutations("if (a === 1) {}");
  const cmp = two.find((m) => m.name === "comparison").mutated;
  const num = two.find((m) => m.name === "numeric").mutated;
  expect(cmp).toBe("if (a !== 1) {}"); // only the comparison changed
  expect(num).toBe("if (a === 2) {}"); // only the number changed
});

test("structuralMutations: import path strings are never the mutated string literal", () => {
  const src = 'import { warn } from "./warn.js";\nexport const M = "hello";\n';
  const s = structuralMutations(src).find((m) => m.name === "string");
  expect(s.mutated).toContain('from "./warn.js"');
  expect(s.mutated).toContain("__MUTATED__");
});

test("structuralMutations: a source with no mutable token yields nothing", () => {
  expect(structuralMutations("export const xs = [];\n")).toEqual([]);
});

test("isWrongReasonRed: module/parse/transform reds are wrong-reason; an assertion failure is not", () => {
  expect(isWrongReasonRed("Error: Cannot find module 'vitest'")).toBe(true);
  expect(isWrongReasonRed("SyntaxError: Unexpected token")).toBe(true);
  expect(isWrongReasonRed("Transform failed with 1 error")).toBe(true);
  expect(isWrongReasonRed("Failed to parse source")).toBe(true);
  expect(isWrongReasonRed("AssertionError: expected 3 to be 4")).toBe(false);
});

// --- resolveTargets ---

test("resolveTargets: resolves a relative source import, ignoring vitest and test files", () => {
  const fs = fakeFs({ "/wt/src/warn.js": "x" });
  const targets = resolveTargets({
    testFile: "test/warn.test.js", tmp: "/wt", exists: fs.exists,
    readFile: () => 'import { warn } from "../src/warn.js";\nimport { test } from "vitest";\n',
  });
  expect(targets).toEqual(["src/warn.js"]);
});

// --- checkNewTestsFailOnMutation: baseline-then-classify orchestration ---

const src = 'export const WARNING = "danger: prod";\n';
const baseFiles = () => ({ "/wt/src/warn.js": src, "/root/src/warn.js": src, "/root/test/warn.test.js": "// test" });
const call = (fs, run, extra = {}) => checkNewTestsFailOnMutation({
  root: "/root", tmp: "/wt", harness, run,
  newTests: [{ file: "test/warn.test.js", target: "src/warn.js" }],
  changedSources: ["src/warn.js"],
  exists: fs.exists, readFile: fs.readFile, writeFile: fs.writeFile, ...extra,
});

test("(a) a guard test that passes whether or not the property holds is a SURVIVOR", async () => {
  const fs = fakeFs(baseFiles());
  // baseline green, then the (only applicable) string mutation runs green → survivor.
  const run = makeFakeRun([wtAdd(ok), wtOther(), npmci(), vitestSeq({ "test/warn.test.js": [ok, ok] })]);
  const r = await call(fs, run);
  expect(r.ok).toBe(false);
  expect(r.survivors.map((s) => s.file)).toEqual(["test/warn.test.js"]);
  expect(r.survivors[0].mutation).toBe("string");
  // source restored after the mutated run
  expect(fs.store.get("/wt/src/warn.js")).toBe(src);
  expect(run.calls.at(-1).args.join(" ")).toBe("worktree remove --force /wt");
});

test("(b) a fail-closed test that goes RED (assertion) under mutation → ok:true, no survivor, it is a kill", async () => {
  const fs = fakeFs(baseFiles());
  const run = makeFakeRun([wtAdd(ok), wtOther(), npmci(), vitestSeq({ "test/warn.test.js": [ok, assertionRed] })]);
  const r = await call(fs, run);
  expect(r.ok).toBe(true);
  expect(r.survivors).toEqual([]);
  expect(r.checked[0]).toMatchObject({ file: "test/warn.test.js", verdict: "kill" });
});

test("wrong-reason red is NOT a kill — the check falls through to the next mutator and still finds the survivor", async () => {
  // Source with two applicable mutators (comparison then string). First attempt (comparison) is a
  // module/parse red (wrong reason) → must NOT be counted as 'the test noticed it'; fall through to the
  // string mutation, which runs green → survivor.
  const twoTok = 'export const f = (x) => x === 1 ? "hi" : "bye";\n';
  const fs = fakeFs({ "/wt/src/f.js": twoTok, "/root/src/f.js": twoTok, "/root/test/f.test.js": "// t" });
  const run = makeFakeRun([wtAdd(ok), wtOther(), npmci(),
    vitestSeq({ "test/f.test.js": [ok, moduleRed, ok] })]); // baseline green, attempt1 wrong-red, attempt2 green
  const r = await checkNewTestsFailOnMutation({
    root: "/root", tmp: "/wt", harness, run,
    newTests: [{ file: "test/f.test.js", target: "src/f.js" }], changedSources: ["src/f.js"],
    exists: fs.exists, readFile: fs.readFile, writeFile: fs.writeFile,
  });
  expect(r.ok).toBe(false);
  expect(r.survivors[0]).toMatchObject({ file: "test/f.test.js", mutation: "string" });
});

test("every applicable mutation is wrong-reason red → inconclusive/skipped, never a kill or survivor", async () => {
  const fs = fakeFs(baseFiles());
  const run = makeFakeRun([wtAdd(ok), wtOther(), npmci(), vitestSeq({ "test/warn.test.js": [ok, moduleRed] })]);
  const r = await call(fs, run);
  expect(r.survivors).toEqual([]);
  expect(r.checked).toEqual([]);
  expect(r.skipped[0].reason).toMatch(/inconclusive.*failed to load\/parse/);
});

test("baseline red (the test fails on its own) → inconclusive/skipped, never a survivor or kill", async () => {
  const fs = fakeFs(baseFiles());
  const run = makeFakeRun([wtAdd(ok), wtOther(), npmci(), vitestSeq({ "test/warn.test.js": [assertionRed] })]);
  const r = await call(fs, run);
  expect(r.survivors).toEqual([]);
  expect(r.checked).toEqual([]);
  expect(r.skipped[0].reason).toMatch(/not green unmutated.*fails on its own/);
});

test("REGRESSION (reviewer must_fix): depless worktree — a vacuous guard is SKIPPED (visible), not masked as a silent pass; a fail-closed test in the same run is still killed", async () => {
  // The masking the reviewer found: with the runner unable to load, the mutated run is red for the
  // wrong reason, was read as 'test noticed the mutation', and the vacuous guard silently returned
  // ok:true / survivors:[] / skipped:[]. Now the baseline catches 'cannot run' → the vacuous guard is
  // reported in `skipped` (never silently cleared), while a genuinely fail-closed test still resolves.
  const good = 'export const g = 1;\n';
  const fs = fakeFs({
    "/wt/src/warn.js": src, "/root/src/warn.js": src, "/root/test/vacuous.test.js": "// v",
    "/wt/src/good.js": good, "/root/src/good.js": good, "/root/test/good.test.js": "// g",
  });
  const run = makeFakeRun([wtAdd(ok), wtOther(), npmci(),
    vitestSeq({
      "test/vacuous.test.js": [moduleRed],       // baseline cannot even load → inconclusive, not a pass
      "test/good.test.js": [ok, assertionRed],   // baseline green, mutation assertion-red → kill
    })]);
  const r = await checkNewTestsFailOnMutation({
    root: "/root", tmp: "/wt", harness, run,
    newTests: [
      { file: "test/vacuous.test.js", target: "src/warn.js" },
      { file: "test/good.test.js", target: "src/good.js" },
    ],
    changedSources: ["src/warn.js", "src/good.js"],
    exists: fs.exists, readFile: fs.readFile, writeFile: fs.writeFile,
  });
  expect(r.survivors).toEqual([]);
  const vac = r.skipped.find((s) => s.file === "test/vacuous.test.js");
  expect(vac).toBeTruthy();                                   // NOT masked — it is visibly reported
  expect(vac.reason).toMatch(/inconclusive.*could not load\/parse/);
  expect(r.checked.find((c) => c.file === "test/good.test.js")).toMatchObject({ verdict: "kill" });
});

test("provisioning: it copies uncommitted working source+test into the worktree and installs deps before running", async () => {
  const fs = fakeFs(baseFiles());
  const run = makeFakeRun([wtAdd(ok), wtOther(), npmci(), vitestSeq({ "test/warn.test.js": [ok, assertionRed] })]);
  await call(fs, run);
  // working-tree files copied into the worktree
  expect(fs.writes.some((w) => w.p === "/wt/test/warn.test.js")).toBe(true);
  expect(fs.writes.some((w) => w.p === "/wt/src/warn.js")).toBe(true);
  // npm ci runs, in the worktree, before any vitest call
  const bash = run.calls.filter((c) => c.cmd === "bash");
  expect(bash[0].args[1]).toBe("npm ci");
  expect(bash[0].opts.cwd).toBe("/wt");
  expect(bash[1].args[1]).toContain("vitest");
});

test("base dependency install failure → misconfigured for the whole run (never a silent clear)", async () => {
  const fs = fakeFs(baseFiles());
  const run = makeFakeRun([wtAdd(ok), wtOther(), npmci({ code: 1, stdout: "", stderr: "ENOTFOUND registry" })]);
  const r = await call(fs, run);
  expect(r).toMatchObject({ ok: false, misconfigured: true });
  expect(r.detail).toMatch(/base dependency install failed/);
  expect(run.calls.some((c) => c.cmd === "bash" && c.args[1].includes("vitest"))).toBe(false);
});

test("(c) a test with no resolvable target is SKIPPED with a reason, not a survivor", async () => {
  const fs = fakeFs({ "/root/test/noop.test.js": "x" });
  const run = makeFakeRun([wtAdd(ok), wtOther(), npmci()]);
  const r = await checkNewTestsFailOnMutation({
    root: "/root", tmp: "/wt", harness, run,
    newTests: ["test/noop.test.js"], changedSources: [],
    exists: fs.exists,
    readFile: (p) => (p.endsWith("test/noop.test.js") ? 'import { test, expect } from "vitest";\ntest("noop", () => expect(1).toBe(1));\n' : fs.readFile(p)),
    writeFile: fs.writeFile,
  });
  expect(r.ok).toBe(true);
  expect(r.survivors).toEqual([]);
  expect(r.skipped[0]).toMatchObject({ file: "test/noop.test.js" });
  expect(r.skipped[0].reason).toMatch(/no resolvable source target/);
  expect(run.calls.some((c) => c.cmd === "bash" && c.args[1].includes("vitest"))).toBe(false);
});

test("(c') a target with no applicable mutation is SKIPPED, not a survivor", async () => {
  const inert = "export const xs = [];\n";
  const fs = fakeFs({ "/wt/src/inert.js": inert, "/root/src/inert.js": inert, "/root/test/inert.test.js": "// t" });
  const run = makeFakeRun([wtAdd(ok), wtOther(), npmci()]);
  const r = await checkNewTestsFailOnMutation({
    root: "/root", tmp: "/wt", harness, run,
    newTests: [{ file: "test/inert.test.js", target: "src/inert.js" }], changedSources: ["src/inert.js"],
    exists: fs.exists, readFile: fs.readFile, writeFile: fs.writeFile,
  });
  expect(r.skipped[0].reason).toMatch(/no applicable structural mutation/);
  expect(r.survivors).toEqual([]);
  expect(run.calls.some((c) => c.cmd === "bash" && c.args[1].includes("vitest"))).toBe(false);
});

test("(d) a throwing run still restores the source and removes the worktree", async () => {
  const fs = fakeFs(baseFiles());
  const run = makeFakeRun([wtAdd(ok), wtOther(), npmci(),
    { match: (c, a) => c === "bash" && a[1].includes("vitest"), result: () => { throw new Error("boom"); } }]);
  await expect(call(fs, run)).rejects.toThrow(/boom/);
  expect(fs.store.get("/wt/src/warn.js")).toBe(src);          // baseline threw before any mutation write — source intact
  expect(run.calls.at(-1).args.join(" ")).toBe("worktree remove --force /wt");
});

test("(d') a throwing MUTATED run restores the mutated source and removes the worktree", async () => {
  const fs = fakeFs(baseFiles());
  let n = 0; // first vitest call = baseline (green); second = mutated (throws)
  const run = makeFakeRun([wtAdd(ok), wtOther(), npmci(),
    { match: (c, a) => c === "bash" && a[1].includes("vitest"), result: () => { if (++n === 1) return ok; throw new Error("boom2"); } }]);
  await expect(call(fs, run)).rejects.toThrow(/boom2/);
  expect(fs.store.get("/wt/src/warn.js")).toBe(src);          // mutated source restored in the inner finally
  expect(run.calls.at(-1).args.join(" ")).toBe("worktree remove --force /wt");
});

test("commands.test_files missing → misconfigured, no worktree created", async () => {
  const run = makeFakeRun([{ match: () => true, result: ok }]);
  const r = await checkNewTestsFailOnMutation({
    root: "/root", harness: { commands: {} }, run,
    newTests: [{ file: "test/warn.test.js", target: "src/warn.js" }],
  });
  expect(r).toMatchObject({ ok: false, misconfigured: true });
  expect(run.calls).toHaveLength(0);
});

test("worktree add failure → all tests skipped (couldn't check), never fail-closed", async () => {
  const run = makeFakeRun([wtAdd({ code: 1, stdout: "", stderr: "add failed" }), wtOther()]);
  const r = await checkNewTestsFailOnMutation({
    root: "/root", tmp: "/wt", harness, run,
    newTests: [{ file: "test/warn.test.js", target: "src/warn.js" }],
  });
  expect(r.ok).toBe(true);
  expect(r.survivors).toEqual([]);
  expect(r.skipped[0].reason).toMatch(/worktree add failed/);
});
