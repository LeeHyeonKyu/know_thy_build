import { test, expect } from "vitest";
import { runSelfGate, summarizeFindings, advisoryFindings, harnessFinding } from "../lib/self-gate.js";
import { makeFakeRun } from "../lib/exec.js";

/**
 * ── Structure B (review-efficiency Task 3) — the pre-handoff self-gate ─────────────────────────
 *
 * COST NOTE (regression the plan pins): a self-gate run is CHEAPER than a review round. It REUSES
 * the `gates` result the stage already computed (never re-runs the gates), reads the qa-evidence
 * manifest the runner already grades for the review stage, and runs the deterministic mutation
 * check on only the NEW tests — no LLM reviewer panel is dispatched. A red deterministic check
 * caught here never spends a full multi-reviewer round (KTB #18 R3 / own-cal R1).
 */

// A vitest run double keyed per test file, returning baseline-then-mutated results in order — the
// same shape mutation-check.test.js uses, so (a) exercises the REAL mutation check deterministically.
const ok = { code: 0, stdout: "", stderr: "" };
const assertionRed = { code: 1, stdout: "", stderr: "AssertionError: expected 'a' to be 'b'" };
const harness = { commands: { test_files: "vitest run {files}" }, runtime: { setup: "npm ci" } };

const wtAdd = (res = ok) => ({ match: (c, a) => c === "git" && a[0] === "worktree" && a[1] === "add", result: res });
const wtOther = (res = ok) => ({ match: (c, a) => c === "git" && a[0] === "worktree", result: res });
const npmci = (res = ok) => ({ match: (c, a) => c === "bash" && a[1] === "npm ci", result: res });
function vitestSeq(seq) {
  const idx = {};
  return {
    match: (c, a) => c === "bash" && a[1].includes("vitest"),
    result: (c, a) => {
      const file = Object.keys(seq).find((f) => a[1].includes(f));
      const arr = seq[file];
      const i = (idx[file] = idx[file] || 0);
      idx[file] = i + 1;
      return arr[i] ?? arr[arr.length - 1];
    },
  };
}
function fakeFs(files) {
  const store = new Map(Object.entries(files));
  return {
    exists: (p) => store.has(p),
    readFile: (p) => (store.has(p) ? store.get(p) : null),
    writeFile: (p, c) => store.set(p, c),
  };
}

const src = 'export const WARNING = "danger: prod";\n';
// Both the working tree (root) and the base worktree (tmp) carry the source + the test file.
const baseFiles = () => ({ "/wt/src/warn.js": src, "/root/src/warn.js": src, "/root/test/warn.test.js": "// test" });

// (a) own-cal R1 cf1 regression: a guard test that stays green under a mutation asserts nothing.
test("(a) a new guard test that is not fail-closed → ok:false naming the survivor (via mutation-check)", async () => {
  const fs = fakeFs(baseFiles());
  // baseline green, then the string mutation runs green too → the test never noticed the change.
  const run = makeFakeRun([wtAdd(), wtOther(), npmci(), vitestSeq({ "test/warn.test.js": [ok, ok] })]);
  const res = await runSelfGate({
    root: "/root", harness, run,
    contract: [{ id: "dw1", check: { kind: "test", ref: "test_warn" }, rubric: "warns on prod" }],
    roster: ["correctness"], tier: "standard", gates: { schema: "factory.gates.v1", status: "GREEN" },
    changedTests: [{ file: "test/warn.test.js", target: "src/warn.js" }], changedSources: ["src/warn.js"],
    mutation: { tmp: "/wt", exists: fs.exists, readFile: fs.readFile, writeFile: fs.writeFile },
  });
  expect(res.ok).toBe(false);
  expect(res.ranChecks).toContain("mutation");
  const detail = res.findings.filter((f) => f.blocking).map((f) => f.detail).join(" ");
  expect(detail).toContain("survivor");
  expect(detail).toContain("test/warn.test.js");
});

// (b) a red gates result → ok:false (the self-gate composes the reviewer's first deterministic check).
test("(b) a red gates result → ok:false", async () => {
  const res = await runSelfGate({
    root: "/root", harness, run: makeFakeRun([]),
    contract: [], roster: ["correctness"], tier: "standard",
    gates: { schema: "factory.gates.v1", status: "RED", reason: "failing=unit" },
    changedTests: [], changedSources: [],
  });
  expect(res.ok).toBe(false);
  expect(res.ranChecks).toContain("gates");
  expect(summarizeFindings(res.findings)).toContain("RED");
});

// (c) a clean, fail-closed impl with complete contract coverage → ok:true.
test("(c) clean fail-closed impl with complete contract coverage → ok:true", async () => {
  const fs = fakeFs(baseFiles());
  // baseline green, then the mutation goes assertion-red → the test IS fail-closed (a kill, not a survivor).
  const run = makeFakeRun([wtAdd(), wtOther(), npmci(), vitestSeq({ "test/warn.test.js": [ok, assertionRed] })]);
  const res = await runSelfGate({
    root: "/root", harness, run,
    contract: [{ id: "dw1", check: { kind: "test", ref: "test_warn" }, rubric: "warns on prod" }],
    roster: ["qa"], tier: "standard", gates: { schema: "factory.gates.v1", status: "GREEN" },
    changedTests: [{ file: "test/warn.test.js", target: "src/warn.js" }], changedSources: ["src/warn.js"],
    // roster has qa → the contract IS graded; a complete manifest → ok.
    qaEvidence: () => ({ ok: true, missing: [] }),
    mutation: { tmp: "/wt", exists: fs.exists, readFile: fs.readFile, writeFile: fs.writeFile },
  });
  expect(res.ok).toBe(true);
  expect(res.findings.filter((f) => f.blocking)).toEqual([]);
  expect(res.ranChecks).toEqual(expect.arrayContaining(["gates", "contract", "mutation"]));
});

// (d) a contract done_when left uncovered by evidence → ok:false naming the id.
test("(d) a contract done_when uncovered by evidence → ok:false naming the id", async () => {
  const res = await runSelfGate({
    root: "/root", harness, run: makeFakeRun([]),
    contract: [{ id: "dw2", check: { kind: "finish", ref: "manifest" }, rubric: "exports csv" }],
    roster: ["correctness"], tier: "standard", gates: { schema: "factory.gates.v1", status: "GREEN" },
    changedTests: [], changedSources: [],
    // contract has a finish-kind check → the manifest IS graded even without qa in the roster.
    qaEvidence: () => ({ ok: false, missing: ["dw2"], reason: "qa evidence manifest is incomplete — missing claims for dw2" }),
  });
  expect(res.ok).toBe(false);
  expect(res.ranChecks).toContain("contract");
  const blocking = res.findings.filter((f) => f.blocking);
  expect(blocking.map((f) => f.detail).join(" ")).toContain("dw2");
  expect(blocking.map((f) => f.detail).join(" ")).toContain("spec-evidence-missing");
});

// A rubric-only contract with no qa in the roster is reviewer-judged, not self-runnable — the
// self-gate does not fabricate a finish/gate check for it (spec §4.B).
test("a rubric-only contract with no qa roster does not grade evidence", async () => {
  const res = await runSelfGate({
    root: "/root", harness, run: makeFakeRun([]),
    contract: [{ id: "dw3", check: { kind: "rubric", ref: "" }, rubric: "reads well" }],
    roster: ["correctness"], tier: "docs", gates: { schema: "factory.gates.v1", status: "GREEN" },
    changedTests: [], changedSources: [],
    qaEvidence: () => { throw new Error("should not be called"); },
  });
  expect(res.ok).toBe(true);
  expect(res.ranChecks).not.toContain("contract");
});

// A misconfigured mutation check (harness cannot run a single test) is a harness-class finding the
// builder cannot fix — the caller routes it to a human, not a builder retry.
test("a misconfigured mutation check is a harness-class blocking finding", async () => {
  const res = await runSelfGate({
    root: "/root", harness: { commands: {} }, run: makeFakeRun([]),
    contract: [], roster: ["correctness"], tier: "standard", gates: { schema: "factory.gates.v1", status: "GREEN" },
    changedTests: [{ file: "test/warn.test.js", target: "src/warn.js" }], changedSources: ["src/warn.js"],
  });
  expect(res.ok).toBe(false);
  expect(harnessFinding(res.findings)).toBe(true);
});

// mutation-check skips (deliberately under-fires) and are advisory, not blocking.
test("mutation-check skips are advisory, not blocking", async () => {
  const fs = fakeFs({ "/root/test/x.test.js": "// no import", "/wt/x": "x" });
  const run = makeFakeRun([wtAdd(), wtOther(), npmci()]);
  const res = await runSelfGate({
    root: "/root", harness, run,
    contract: [], roster: ["correctness"], tier: "standard", gates: { schema: "factory.gates.v1", status: "GREEN" },
    changedTests: [{ file: "test/x.test.js" }], changedSources: [],
    mutation: { tmp: "/wt", exists: fs.exists, readFile: fs.readFile, writeFile: fs.writeFile },
  });
  expect(res.ok).toBe(true);
  expect(advisoryFindings(res.findings).length).toBeGreaterThan(0);
});
