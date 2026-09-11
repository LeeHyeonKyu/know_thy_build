import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWorkflow } from "./helpers/run-workflow.js";

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
