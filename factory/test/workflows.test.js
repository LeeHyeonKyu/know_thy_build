import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { runWorkflow } from "./helpers/run-workflow.js";
import { validate } from "../lib/schemas.js";

const FACTORY_TRIAGE_WORKFLOW = new URL("../../templates/factory/claude/workflows/factory-triage.js", import.meta.url).pathname;

function writeScript(src) {
  const dir = mkdtempSync(join(tmpdir(), "wf-"));
  const file = join(dir, "workflow.js");
  writeFileSync(file, src);
  return file;
}

test("runWorkflow executes a spike-shaped inline workflow: phases, agent() calls, and the returned handoff", async () => {
  const file = writeScript(
    `export const meta = {name:'t',description:'d',phases:[{title:'A'}]}
phase('A')
const r = await parallel([() => agent('x',{agentType:'w', schema:{type:'object'}})])
return { r }
`
  );

  const stubReturn = { ok: true, from: "stub" };
  const { result, calls, phases } = await runWorkflow(file, {
    agent: async () => stubReturn,
  });

  expect(result.r[0]).toEqual(stubReturn);
  expect(calls).toHaveLength(1);
  expect(calls[0].prompt).toBe("x");
  expect(calls[0].opts.agentType).toBe("w");
  expect(phases).toEqual(["A"]);
});

test("runWorkflow: a script referencing Date.now() rejects (Date is not in the sandbox)", async () => {
  const file = writeScript(
    `export const meta = {name:'t',description:'d',phases:[]}
return { now: Date.now() }
`
  );
  await expect(runWorkflow(file, { agent: async () => ({}) })).rejects.toThrow(/Date is not defined/);
});

test("runWorkflow: Math.random() is blocked (non-deterministic scripts must fail), Math.max still works", async () => {
  const randomFile = writeScript(
    `export const meta = {name:'t',description:'d',phases:[]}
return { r: Math.random() }
`
  );
  await expect(runWorkflow(randomFile, { agent: async () => ({}) })).rejects.toThrow(/Math\.random is not a function/);

  const maxFile = writeScript(
    `export const meta = {name:'t',description:'d',phases:[]}
return { m: Math.max(1, 2) }
`
  );
  const { result } = await runWorkflow(maxFile, { agent: async () => ({}) });
  expect(result.m).toBe(2);
});

test("runWorkflow: parallel isolates a rejecting thunk to null, keeps other results, and never leaves an unhandled rejection", async () => {
  const file = writeScript(
    `export const meta = {name:'t',description:'d',phases:[]}
const r = await parallel([
  () => Promise.resolve('ok'),
  () => Promise.reject(new Error('boom')),
])
return { r }
`
  );
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { result } = await runWorkflow(file, { agent: async () => ({}) });
    expect(result.r).toEqual(["ok", null]);
    // give any late unhandledRejection a microtask/macrotask to surface before asserting
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("runWorkflow: pipeline nulls only the item whose stage throws; other items complete normally", async () => {
  const file = writeScript(
    `export const meta = {name:'t',description:'d',phases:[]}
const r = await pipeline(
  [1, 2, 3],
  (x) => x + 1,
  (x) => { if (x === 3) throw new Error('bad'); return x * 10; },
)
return { r }
`
  );
  const { result } = await runWorkflow(file, { agent: async () => ({}) });
  expect(result.r).toEqual([20, null, 40]);
});

test("runWorkflow: a multi-line `export const meta = {...}` still parses, and meta.name/meta.phases are usable in the body", async () => {
  const file = writeScript(
    `export const meta = {
  name: 't',
  description: 'd',
  phases: [{ title: 'A' }, { title: 'B' }],
}

phase(meta.phases[0].title)
phase(meta.phases[1].title)
return { name: meta.name, count: meta.phases.length }
`
  );
  const { result, phases } = await runWorkflow(file, { agent: async () => ({}) });
  expect(result).toEqual({ name: "t", count: 2 });
  expect(phases).toEqual(["A", "B"]);
});

// --- Task 2: templates/factory/claude/workflows/factory-triage.js ---

test("factory-triage.js: meta.name equals the file's own basename", () => {
  const src = readFileSync(FACTORY_TRIAGE_WORKFLOW, "utf8");
  const m = /^\s*name:\s*['"]([^'"]+)['"]/m.exec(src);
  expect(m[1]).toBe(basename(FACTORY_TRIAGE_WORKFLOW, ".js"));
});

test("factory-triage.js: loader → triage call order, valid triage.v1 result, workflow orchestration, Load/Triage phases", async () => {
  const loaderFix = {
    issue: 7,
    stage: "triage",
    tier: "standard",
    roster: [{ name: "triage", agentType: "factory-triage", model: "sonnet" }],
    orchestration: "workflow",
  };
  const triageFix = { disposition: "ready", tier: "standard", reason: "done_when is concrete", summary: "add CSV export" };

  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return loaderFix;
    if (opts.agentType === "factory-triage") return triageFix;
    return null;
  };

  // the dispatcher command may hand the workflow a stringly-typed issue — the workflow must Number() it.
  const { result, calls, phases } = await runWorkflow(FACTORY_TRIAGE_WORKFLOW, {
    agent: stub,
    args: { issue: "7", context: ".factory/out/context.json" },
  });

  expect(calls.map((c) => c.opts.agentType)).toEqual(["factory-loader", "factory-triage"]);
  expect(calls[1].opts.model).toBe("sonnet");
  expect(result).toMatchObject({ issue: 7, disposition: "ready", tier: "standard", orchestration: "workflow", guarantee: "structural" });
  expect(validate("triage.v1", result).ok).toBe(true);
  expect(phases).toEqual(["Load", "Triage"]);
});

test("factory-triage.js: a null factory-triage result re-spawns once; a second null leaves the result without a disposition", async () => {
  const loaderFix = {
    issue: 9,
    stage: "triage",
    tier: "standard",
    roster: [{ name: "triage", agentType: "factory-triage", model: "sonnet" }],
    orchestration: "workflow",
  };
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return loaderFix;
    if (opts.agentType === "factory-triage") return null;
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_TRIAGE_WORKFLOW, {
    agent: stub,
    args: { issue: 9, context: ".factory/out/context.json" },
  });

  expect(calls.filter((c) => c.opts.agentType === "factory-triage")).toHaveLength(2);
  expect(result.disposition).toBeUndefined();
  expect(result.issue).toBe(9);
  expect(result.orchestration).toBe("workflow");
  expect(result.guarantee).toBe("structural");
});

test("factory-triage.js: a null factory-loader result re-spawns once; a second null still runs the Triage phase but invents no role", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return null;
    return null;
  };

  const { calls, phases, result } = await runWorkflow(FACTORY_TRIAGE_WORKFLOW, {
    agent: stub,
    args: { issue: 11, context: ".factory/out/context.json" },
  });

  expect(calls.filter((c) => c.opts.agentType === "factory-loader")).toHaveLength(2);
  expect(phases).toEqual(["Load", "Triage"]);
  expect(calls.filter((c) => c.opts.agentType === "factory-triage")).toHaveLength(0);
  expect(result).toEqual({ issue: 11, orchestration: "workflow", guarantee: "structural" });
});
