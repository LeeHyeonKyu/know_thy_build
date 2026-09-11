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

test("factory-triage.js: loader/dispatcher issue mismatch fails closed — no triage call, error surfaced, no disposition", async () => {
  const loaderFix = {
    issue: 99, // loader read a stale/wrong context.json
    stage: "triage",
    tier: "standard",
    roster: [{ name: "triage", agentType: "factory-triage", model: "sonnet" }],
    orchestration: "workflow",
  };
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return loaderFix;
    return { disposition: "ready", tier: "standard", reason: "should never run", summary: "should never run" };
  };

  const { result, calls } = await runWorkflow(FACTORY_TRIAGE_WORKFLOW, {
    agent: stub,
    args: { issue: 7, context: ".factory/out/context.json" },
  });

  expect(calls.map((c) => c.opts.agentType)).toEqual(["factory-loader"]);
  expect(result.issue).toBe(7);
  expect(result.error).toMatch(/context issue mismatch/);
  expect(result.disposition).toBeUndefined();
  expect(result.orchestration).toBe("workflow");
  expect(result.guarantee).toBe("structural");
  expect(validate("triage.v1", result).ok).toBe(false);
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

// --- Task 3: templates/factory/claude/workflows/factory-plan.js ---

const FACTORY_PLAN_WORKFLOW = new URL("../../templates/factory/claude/workflows/factory-plan.js", import.meta.url).pathname;

const PLAN_ROSTER = [
  { name: "product-advocate", agentType: "plan-product-advocate", model: "opus", lessons: ".factory/lessons/plan-product-advocate.md" },
  { name: "architect", agentType: "plan-architect", model: "opus", lessons: ".factory/lessons/plan-architect.md" },
  { name: "skeptic", agentType: "plan-skeptic", model: "opus", lessons: ".factory/lessons/plan-skeptic.md" },
  { name: "operator", agentType: "plan-operator", model: "sonnet", lessons: ".factory/lessons/plan-operator.md" },
];

const planLoaderFix = (over = {}) => ({
  issue: 42,
  stage: "plan",
  tier: "standard",
  roster: PLAN_ROSTER,
  rounds: 3,
  spec_path: "docs/features/016-export-csv.md",
  orchestration: "workflow",
  ...over,
});

// R1 answers carry a role-unique marker so the tests can prove independence (R1 prompts must contain
// no other role's position) and that R2 really is cross-examination (others' positions, never one's own).
const posFix = (role) => ({
  position: `POSITION-OF-${role}`,
  risks: [`${role} risk`],
  proposed_done_when: [{ id: "dw1", text: "CSV export writes a header row", verify: "test_42_export_csv", level: "unit" }],
  files_expected: ["src/export/csv.js"],
});
const xexFix = (role) => ({
  agreements: [`${role} agrees on the header row`],
  objections: [{ to: "architect", claim: "files_expected is too wide", evidence: "src/export/csv.js only" }],
  concessions: [],
});
const planFix = (over = {}) => ({
  issue: 42,
  tier: "standard",
  roles: ["product-advocate", "architect", "skeptic", "operator"],
  rounds: 3,
  summary: "Export the report table as CSV",
  done_when: [{ id: "dw1", text: "CSV export writes a header row", verify: "test_42_export_csv_header", level: "unit" }],
  files_expected: ["src/export/csv.js"],
  dissent_log: [],
  non_goals: ["streaming export"],
  open_risks: ["very large datasets"],
  ...over,
});

const labelled = (calls, prefix) => calls.filter((c) => typeof c.opts.label === "string" && c.opts.label.startsWith(prefix));
const roleOf = (opts) => String(opts.label).split(":")[1];

test("factory-plan.js: meta.name equals the file's own basename", () => {
  const src = readFileSync(FACTORY_PLAN_WORKFLOW, "utf8");
  const m = /^\s*name:\s*['"]([^'"]+)['"]/m.exec(src);
  expect(m[1]).toBe(basename(FACTORY_PLAN_WORKFLOW, ".js"));
});

test("factory-plan.js: standard tier runs R1/R2/synthesis/sign-off over the loader roster and returns a valid plan.v1", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return planLoaderFix();
    if (opts.label?.startsWith("R1:")) return posFix(roleOf(opts));
    if (opts.label?.startsWith("R2:")) return xexFix(roleOf(opts));
    if (opts.agentType === "plan-synthesizer") return planFix();
    if (opts.label?.startsWith("sign:")) return { vote: "accept", reason: "the done_when levels fit M0" };
    return null;
  };

  const { result, calls, phases } = await runWorkflow(FACTORY_PLAN_WORKFLOW, {
    agent: stub,
    args: { issue: "42", context: ".factory/out/context.json" },
  });

  expect(labelled(calls, "R1:")).toHaveLength(4);
  expect(labelled(calls, "R2:")).toHaveLength(4);
  expect(labelled(calls, "sign:")).toHaveLength(4);
  expect(calls.filter((c) => c.opts.agentType === "plan-synthesizer")).toHaveLength(1);

  // each debater is spawned as its own agent file, with its roles.toml model
  const r1 = labelled(calls, "R1:");
  expect(r1.map((c) => c.opts.agentType)).toEqual(PLAN_ROSTER.map((r) => r.agentType));
  expect(r1.map((c) => c.opts.model)).toEqual(["opus", "opus", "opus", "sonnet"]);
  expect(calls.find((c) => c.opts.agentType === "plan-synthesizer").opts.model).toBe("opus");

  expect(validate("plan.v1", result).ok).toBe(true);
  expect(result).toMatchObject({
    issue: 42,
    tier: "standard",
    rounds: 3,
    orchestration: "workflow",
    guarantee: "structural",
    summary: "Export the report table as CSV",
  });
  expect(result.roles).toEqual(["product-advocate", "architect", "skeptic", "operator"]);
  expect(result.debate.r1.map((x) => x.role)).toEqual(PLAN_ROSTER.map((r) => r.name));
  expect(result.debate.r2.map((x) => x.role)).toEqual(PLAN_ROSTER.map((r) => r.name));
  expect(result.debate.votes.every((v) => v.vote === "accept")).toBe(true);
  expect(phases).toEqual(["Load", "Positions", "Cross-examination", "Synthesis", "Sign-off"]);
});

test("factory-plan.js: R1 is independent (no other role's position in the prompt); R2 carries the others' R1 but not one's own", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return planLoaderFix();
    if (opts.label?.startsWith("R1:")) return posFix(roleOf(opts));
    if (opts.label?.startsWith("R2:")) return xexFix(roleOf(opts));
    if (opts.agentType === "plan-synthesizer") return planFix();
    if (opts.label?.startsWith("sign:")) return { vote: "accept", reason: "ok" };
    return null;
  };
  const { calls } = await runWorkflow(FACTORY_PLAN_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json" },
  });

  for (const c of labelled(calls, "R1:")) expect(c.prompt).not.toContain("POSITION-OF-");
  for (const c of labelled(calls, "R2:")) {
    const self = roleOf(c.opts);
    expect(c.prompt).not.toContain(`POSITION-OF-${self}`);
    for (const other of PLAN_ROSTER.map((r) => r.name).filter((n) => n !== self)) {
      expect(c.prompt, `R2:${self} should see ${other}'s position`).toContain(`POSITION-OF-${other}`);
    }
  }
});

test("factory-plan.js: one objection at sign-off re-runs the synthesizer once; a clean second vote leaves dissent_log untouched", async () => {
  let signRounds = 0;
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return planLoaderFix();
    if (opts.label?.startsWith("R1:")) return posFix(roleOf(opts));
    if (opts.label?.startsWith("R2:")) return xexFix(roleOf(opts));
    if (opts.agentType === "plan-synthesizer") return planFix();
    if (opts.label?.startsWith("sign:")) {
      if (roleOf(opts) === "skeptic") signRounds += 1;
      const objecting = signRounds === 1 && roleOf(opts) === "skeptic";
      return objecting ? { vote: "object", reason: "dw1 has no failing-test id" } : { vote: "accept", reason: "ok" };
    }
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_PLAN_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json" },
  });

  expect(calls.filter((c) => c.opts.agentType === "plan-synthesizer")).toHaveLength(2);
  expect(labelled(calls, "sign:")).toHaveLength(8);
  expect(calls.filter((c) => c.opts.agentType === "plan-synthesizer")[1].prompt).toContain("dw1 has no failing-test id");
  expect(result.dissent_log).toEqual([]);
  expect(result.debate.votes.every((v) => v.vote === "accept")).toBe(true);
  expect(validate("plan.v1", result).ok).toBe(true);
});

test("factory-plan.js: an objection that survives the re-synthesis is recorded in dissent_log as unresolved, and the plan proceeds", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return planLoaderFix();
    if (opts.label?.startsWith("R1:")) return posFix(roleOf(opts));
    if (opts.label?.startsWith("R2:")) return xexFix(roleOf(opts));
    if (opts.agentType === "plan-synthesizer") return planFix();
    if (opts.label?.startsWith("sign:")) {
      return roleOf(opts) === "skeptic"
        ? { vote: "object", reason: "the rollback path is still unspecified" }
        : { vote: "accept", reason: "ok" };
    }
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_PLAN_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json" },
  });

  expect(calls.filter((c) => c.opts.agentType === "plan-synthesizer")).toHaveLength(2);
  expect(labelled(calls, "sign:")).toHaveLength(8);
  expect(result.dissent_log).toEqual([
    { role: "skeptic", objection: "the rollback path is still unspecified", resolution: "unresolved — proceeding" },
  ]);
  expect(validate("plan.v1", result).ok).toBe(true);
});

test("factory-plan.js: docs tier (rounds 2, roster 2) skips cross-examination entirely but still declares the phase", async () => {
  const docsRoster = PLAN_ROSTER.filter((r) => r.name === "architect" || r.name === "skeptic");
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return planLoaderFix({ tier: "docs", rounds: 2, roster: docsRoster });
    if (opts.label?.startsWith("R1:")) return posFix(roleOf(opts));
    if (opts.label?.startsWith("R2:")) return xexFix(roleOf(opts));
    if (opts.agentType === "plan-synthesizer") return planFix({ tier: "docs", roles: ["architect", "skeptic"], rounds: 2 });
    if (opts.label?.startsWith("sign:")) return { vote: "accept", reason: "ok" };
    return null;
  };

  const { result, calls, phases } = await runWorkflow(FACTORY_PLAN_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json" },
  });

  expect(labelled(calls, "R1:")).toHaveLength(2);
  expect(labelled(calls, "R2:")).toHaveLength(0);
  expect(labelled(calls, "sign:")).toHaveLength(2);
  expect(phases).toEqual(["Load", "Positions", "Cross-examination", "Synthesis", "Sign-off"]);
  expect(result.rounds).toBe(2);
  expect(result.tier).toBe("docs");
  expect(result.roles).toEqual(["architect", "skeptic"]);
  expect(result.debate.r2).toEqual([]);
  expect(validate("plan.v1", result).ok).toBe(true);
});

test("factory-plan.js: a debater that returns null twice in R1 is re-spawned once and then dropped — the debate proceeds without it, never inventing a position", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return planLoaderFix();
    if (opts.label?.startsWith("R1:")) return roleOf(opts) === "operator" ? null : posFix(roleOf(opts));
    if (opts.label?.startsWith("R2:")) return xexFix(roleOf(opts));
    if (opts.agentType === "plan-synthesizer") return planFix();
    if (opts.label?.startsWith("sign:")) return { vote: "accept", reason: "ok" };
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_PLAN_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json" },
  });

  // 4 debaters + exactly one insurance re-spawn for the role that came back null (ADR-003)
  expect(labelled(calls, "R1:")).toHaveLength(5);
  expect(labelled(calls, "R1:").filter((c) => roleOf(c.opts) === "operator")).toHaveLength(2);
  expect(result.debate.r1.map((x) => x.role)).toEqual(["product-advocate", "architect", "skeptic"]);
  // a role with no position does not cross-examine and does not sign
  expect(labelled(calls, "R2:").map((c) => roleOf(c.opts))).toEqual(["product-advocate", "architect", "skeptic"]);
  expect(labelled(calls, "sign:").map((c) => roleOf(c.opts))).toEqual(["product-advocate", "architect", "skeptic"]);
  // `roles` stays the loader roster — verify-stage compares it against the hook log and flags the gap
  expect(result.roles).toEqual(PLAN_ROSTER.map((r) => r.name));
});

test("factory-plan.js: loader/dispatcher issue mismatch fails closed — no debate at all, error surfaced, plan.v1 invalid", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return planLoaderFix({ issue: 99 });
    return planFix();
  };

  const { result, calls } = await runWorkflow(FACTORY_PLAN_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json" },
  });

  expect(calls.map((c) => c.opts.agentType)).toEqual(["factory-loader"]);
  expect(result.issue).toBe(42);
  expect(result.error).toMatch(/context issue mismatch/);
  expect(result.done_when).toBeUndefined();
  expect(result.orchestration).toBe("workflow");
  expect(result.guarantee).toBe("structural");
  expect(validate("plan.v1", result).ok).toBe(false);
});

test("factory-plan.js: an objection the synthesizer already logged is superseded, not duplicated, when it survives the second vote", async () => {
  const OBJECTION = "the rollback path is still unspecified";
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return planLoaderFix();
    if (opts.label?.startsWith("R1:")) return posFix(roleOf(opts));
    if (opts.label?.startsWith("R2:")) return xexFix(roleOf(opts));
    if (opts.agentType === "plan-synthesizer") {
      // the synthesizer kept the objection with its own override reason at re-synthesis
      return planFix({
        dissent_log: [
          { role: "architect", objection: "files_expected is too wide", resolution: "narrowed to two paths" },
          { role: "skeptic", objection: OBJECTION, resolution: "overridden — rollback is out of scope" },
        ],
      });
    }
    if (opts.label?.startsWith("sign:")) {
      return roleOf(opts) === "skeptic" ? { vote: "object", reason: OBJECTION } : { vote: "accept", reason: "ok" };
    }
    return null;
  };

  const { result } = await runWorkflow(FACTORY_PLAN_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json" },
  });

  expect(result.dissent_log.filter((d) => d.role === "skeptic" && d.objection === OBJECTION)).toHaveLength(1);
  expect(result.dissent_log).toEqual([
    { role: "architect", objection: "files_expected is too wide", resolution: "narrowed to two paths" },
    { role: "skeptic", objection: OBJECTION, resolution: "unresolved — proceeding" },
  ]);
});

test("factory-plan.js: synthesis sees R1 and R2; the second sign-off votes on the revised plan, not the first draft", async () => {
  let synthCalls = 0;
  let signRounds = 0;
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return planLoaderFix();
    if (opts.label?.startsWith("R1:")) return posFix(roleOf(opts));
    if (opts.label?.startsWith("R2:")) return xexFix(roleOf(opts));
    if (opts.agentType === "plan-synthesizer") {
      synthCalls += 1;
      return planFix({ summary: `PLAN-DRAFT-${synthCalls}` });
    }
    if (opts.label?.startsWith("sign:")) {
      if (roleOf(opts) === "skeptic") signRounds += 1;
      return signRounds === 1 && roleOf(opts) === "skeptic"
        ? { vote: "object", reason: "dw1 has no failing-test id" }
        : { vote: "accept", reason: "ok" };
    }
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_PLAN_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json" },
  });

  // the synthesizer is given both rounds of the debate, not just the positions
  const synthesis = calls.filter((c) => c.opts.agentType === "plan-synthesizer");
  expect(synthesis[0].prompt).toContain("POSITION-OF-skeptic");
  expect(synthesis[0].prompt).toContain("files_expected is too wide"); // an R2 objection claim

  const signs = labelled(calls, "sign:");
  expect(signs).toHaveLength(8);
  for (const c of signs.slice(0, 4)) {
    expect(c.prompt).toContain("PLAN-DRAFT-1");
    expect(c.prompt).not.toContain("PLAN-DRAFT-2");
  }
  for (const c of signs.slice(4)) {
    expect(c.prompt).toContain("PLAN-DRAFT-2");
    expect(c.prompt).not.toContain("PLAN-DRAFT-1");
  }
  expect(result.summary).toBe("PLAN-DRAFT-2");
});
