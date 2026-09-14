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

test("factory-triage.js: triage call order, valid triage.v1 result, workflow orchestration, Load/Triage phases", async () => {
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
    args: { issue: "7", context: ".factory/out/context.json", loaded: loaderFix },
  });

  expect(calls.map((c) => c.opts.agentType)).toEqual(["factory-triage"]);
  expect(calls[0].opts.model).toBe("sonnet");
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
    args: { issue: 9, context: ".factory/out/context.json", loaded: loaderFix },
  });

  expect(calls.filter((c) => c.opts.agentType === "factory-triage")).toHaveLength(2);
  expect(result.disposition).toBeUndefined();
  expect(result.issue).toBe(9);
  expect(result.orchestration).toBe("workflow");
  expect(result.guarantee).toBe("structural");
});

test("factory-triage.js: payload/dispatcher issue mismatch fails closed — no triage call, error surfaced, no disposition", async () => {
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
    args: { issue: 7, context: ".factory/out/context.json", loaded: loaderFix },
  });

  expect(calls).toEqual([]);
  expect(result.issue).toBe(7);
  expect(result.error).toMatch(/context issue mismatch/);
  expect(result.disposition).toBeUndefined();
  expect(result.orchestration).toBe("workflow");
  expect(result.guarantee).toBe("structural");
  expect(validate("triage.v1", result).ok).toBe(false);
});

test("factory-triage.js: a missing args.loaded fails the stage closed with a named error and no role call", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return null;
    return null;
  };

  const { calls, phases, result } = await runWorkflow(FACTORY_TRIAGE_WORKFLOW, {
    agent: stub,
    args: { issue: 11, context: ".factory/out/context.json", loaded: null },
  });

  expect(calls).toEqual([]);
  expect(phases).toEqual(["Load"]);
  expect(calls.filter((c) => c.opts.agentType === "factory-triage")).toHaveLength(0);
  expect(result).toEqual({ issue: 11, error: "context payload missing", orchestration: "workflow", guarantee: "structural" });
  expect(validate("triage.v1", result).ok).toBe(false);
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

test("factory-plan.js: standard tier runs R1/R2/synthesis/sign-off over the context payload's roster and returns a valid plan.v1", async () => {
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
    args: { issue: "42", context: ".factory/out/context.json", loaded: planLoaderFix() },
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
  // F7: handoff에는 토론 전문이 아니라 다이제스트가 실린다 — R1은 {role, position}만, R2는 반박 **개수**만.
  expect(result.debate.r1.map((x) => x.role)).toEqual(PLAN_ROSTER.map((r) => r.name));
  expect(result.debate.r1.every((x) => Object.keys(x).sort().join(",") === "position,role")).toBe(true);
  expect(result.debate.r1.some((x) => "risks" in x || "proposed_done_when" in x)).toBe(false);
  expect(typeof result.debate.r2_objections).toBe("number");
  expect(result.debate.r2).toBeUndefined();
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
    args: { issue: 42, context: ".factory/out/context.json", loaded: planLoaderFix() },
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
    args: { issue: 42, context: ".factory/out/context.json", loaded: planLoaderFix() },
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
    args: { issue: 42, context: ".factory/out/context.json", loaded: planLoaderFix() },
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
    args: { issue: 42, context: ".factory/out/context.json", loaded: planLoaderFix({ tier: "docs", rounds: 2, roster: docsRoster }) },
  });

  expect(labelled(calls, "R1:")).toHaveLength(2);
  expect(labelled(calls, "R2:")).toHaveLength(0);
  expect(labelled(calls, "sign:")).toHaveLength(2);
  expect(phases).toEqual(["Load", "Positions", "Cross-examination", "Synthesis", "Sign-off"]);
  expect(result.rounds).toBe(2);
  expect(result.tier).toBe("docs");
  expect(result.roles).toEqual(["architect", "skeptic"]);
  expect(result.debate.r2_objections).toBe(0);   // 교차검토를 아예 돌지 않았으므로 반박도 0이다(F7)
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
    args: { issue: 42, context: ".factory/out/context.json", loaded: planLoaderFix() },
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

test("factory-plan.js: payload/dispatcher issue mismatch fails closed — no debate at all, error surfaced, plan.v1 invalid", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return planLoaderFix({ issue: 99 });
    return planFix();
  };

  const { result, calls } = await runWorkflow(FACTORY_PLAN_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: planLoaderFix({ issue: 99 }) },
  });

  expect(calls).toEqual([]);
  expect(result.issue).toBe(42);
  expect(result.error).toMatch(/context issue mismatch/);
  expect(result.done_when).toBeUndefined();
  expect(result.orchestration).toBe("workflow");
  expect(result.guarantee).toBe("structural");
  expect(validate("plan.v1", result).ok).toBe(false);
});

test("factory-plan.js: a missing args.loaded fails the stage closed — no debate, named error, plan.v1 invalid", async () => {
  const stub = async (prompt, opts) => (opts.agentType === "factory-loader" ? null : planFix());

  const { result, calls, phases } = await runWorkflow(FACTORY_PLAN_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: null },
  });

  expect(calls).toEqual([]);
  expect(phases).toEqual(["Load"]);
  expect(result).toEqual({ issue: 42, error: "context payload missing", orchestration: "workflow", guarantee: "structural" });
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
    args: { issue: 42, context: ".factory/out/context.json", loaded: planLoaderFix() },
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
    args: { issue: 42, context: ".factory/out/context.json", loaded: planLoaderFix() },
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

/*
 * --- 감사 Task 9 (P2): plan 기본 = 단일 opus 1패스 + skeptic 1패스 ---
 *
 * 근거는 `docs/factory/dogfood/2026-09-14-plan-baseline.md`다: 4역할 토론은 이슈당 5.4×–33.7×를
 * 쓰고도 #15·#18에서 단일 패스보다 못했고, must_fix 15건 중 5건이 토론이 스스로 발명한 done_when
 * 때문에 생겼다. 토론은 load-bearing tier에만 남는다.
 */

const SINGLE_ROSTER = [
  { name: "synthesizer", agentType: "plan-synthesizer", model: "opus", lessons: ".factory/lessons/plan-synthesizer.md" },
  { name: "skeptic", agentType: "plan-skeptic", model: "opus", lessons: ".factory/lessons/plan-skeptic.md" },
];
const singleLoaderFix = (over = {}) => planLoaderFix({ roster: SINGLE_ROSTER, rounds: 2, plan: { mode: "single", max_done_when: 6 }, ...over });
const singlePlanFix = (over = {}) => planFix({ roles: ["synthesizer", "skeptic"], rounds: 2, ...over });

test("factory-plan.js: single mode runs exactly two passes — one opus planner, one skeptic — and no debate at all", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return singleLoaderFix();
    if (opts.label === "plan:synthesizer") return singlePlanFix();
    if (opts.label === "skeptic:skeptic") return { risks: [], done_when: [] };
    return null;
  };

  const { result, calls, phases } = await runWorkflow(FACTORY_PLAN_WORKFLOW, {
    agent: stub, args: { issue: "42", context: ".factory/out/context.json", loaded: singleLoaderFix() },
  });

  const agents = calls.filter((c) => c.opts.agentType !== "factory-loader");
  expect(agents).toHaveLength(2);
  expect(agents.map((c) => c.opts.agentType)).toEqual(["plan-synthesizer", "plan-skeptic"]);
  expect(agents.map((c) => c.opts.model)).toEqual(["opus", "opus"]);
  expect(labelled(calls, "R1:")).toHaveLength(0);
  expect(labelled(calls, "R2:")).toHaveLength(0);
  expect(labelled(calls, "sign:")).toHaveLength(0);

  expect(validate("plan.v1", result).ok).toBe(true);
  expect(result).toMatchObject({ issue: 42, tier: "standard", rounds: 2, orchestration: "workflow", guarantee: "structural" });
  expect(result.roles).toEqual(["synthesizer", "skeptic"]);
  expect(result.debate.mode).toBe("single");
  // 선언된 phase 집합은 모드와 무관하게 고정이다(meta는 하나다).
  expect(phases).toEqual(["Load", "Positions", "Cross-examination", "Synthesis", "Sign-off"]);
  // done_when 상한은 skeptic이 알아야 한다 — 상한을 모르면 7번째 항목을 더해 핸드오프를 무효로 만든다.
  expect(agents[1].prompt).toContain("6");
});

test("factory-plan.js: the skeptic pass may only ADD — planner items are never replaced or dropped", async () => {
  const planner = singlePlanFix({
    done_when: [{ id: "dw1", text: "PLANNER-TEXT", verify: "test_42_a", level: "unit" }],
    open_risks: ["planner risk"],
    dissent_log: [],
  });
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return singleLoaderFix();
    if (opts.label === "plan:synthesizer") return planner;
    if (opts.label === "skeptic:skeptic") return {
      risks: ["skeptic risk", "planner risk"],                                    // 중복은 한 번만
      done_when: [
        { id: "dw1", text: "SKEPTIC-OVERWRITE", verify: "test_42_a", level: "unit" },   // 같은 id — 무시된다
        { id: "dw2", text: "connection failure without err.code still returns 503", verify: "test_42_b", level: "unit", covers: ["d1"] },
      ],
      dissent: [{ id: "d1", role: "skeptic", severity: "high", objection: "npm start never touches pg", resolution: "covered by dw2" }],
    };
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_PLAN_WORKFLOW, {
    agent: stub, args: { issue: "42", context: ".factory/out/context.json", loaded: singleLoaderFix() },
  });

  expect(result.done_when.map((d) => d.id)).toEqual(["dw1", "dw2"]);
  expect(result.done_when[0].text).toBe("PLANNER-TEXT");
  expect(result.done_when[1].covers).toEqual(["d1"]);
  expect(result.open_risks).toEqual(["planner risk", "skeptic risk"]);
  expect(result.dissent_log).toEqual([{ id: "d1", role: "skeptic", severity: "high", objection: "npm start never touches pg", resolution: "covered by dw2" }]);
  expect(result.summary).toBe(planner.summary);                                   // 종합은 계획자 자신의 최종본이다
  // skeptic은 계획을 통째로 본다 — 무엇에 반대하는지 알아야 하기 때문이다.
  expect(calls.find((c) => c.opts.label === "skeptic:skeptic").prompt).toContain("PLANNER-TEXT");
  expect(result.debate.skeptic_added).toEqual({ done_when: 1, risks: 1, dissent: 1 });
});

test("factory-plan.js: a dead skeptic leaves the planner's plan standing (re-spawned once, then dropped)", async () => {
  let skepticCalls = 0;
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return singleLoaderFix();
    if (opts.label === "plan:synthesizer") return singlePlanFix({ summary: "PLANNER-ONLY" });
    if (opts.label === "skeptic:skeptic") { skepticCalls++; return null; }
    return null;
  };
  const { result } = await runWorkflow(FACTORY_PLAN_WORKFLOW, { agent: stub, args: { issue: "42", context: ".factory/out/context.json", loaded: singleLoaderFix() } });
  expect(skepticCalls).toBe(2);                                                   // 보험 재spawn 1회
  expect(validate("plan.v1", result).ok).toBe(true);
  expect(result.summary).toBe("PLANNER-ONLY");
  expect(result.debate.skeptic_added).toBe(null);
});

test("factory-plan.js: a dead planner fails the single-mode stage closed — no plan, plan.v1 invalid", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return singleLoaderFix();
    return null;
  };
  const { result, calls } = await runWorkflow(FACTORY_PLAN_WORKFLOW, { agent: stub, args: { issue: "42", context: ".factory/out/context.json", loaded: singleLoaderFix() } });
  expect(calls.filter((c) => c.opts.label === "plan:synthesizer")).toHaveLength(2);
  expect(calls.filter((c) => c.opts.label === "skeptic:skeptic")).toHaveLength(0); // 계획이 없으면 반박할 것도 없다
  expect(validate("plan.v1", result).ok).toBe(false);
});

test("factory-plan.js: load-bearing keeps the 4-role debate — the payload's mode is the authority", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return planLoaderFix({ tier: "load-bearing", plan: { mode: "debate", max_done_when: 6 } });
    if (opts.label?.startsWith("R1:")) return posFix(roleOf(opts));
    if (opts.label?.startsWith("R2:")) return xexFix(roleOf(opts));
    if (opts.agentType === "plan-synthesizer") return planFix({ tier: "load-bearing" });
    if (opts.label?.startsWith("sign:")) return { vote: "accept", reason: "ok" };
    return null;
  };
  const { result, calls } = await runWorkflow(FACTORY_PLAN_WORKFLOW, { agent: stub, args: { issue: "42", context: ".factory/out/context.json", loaded: planLoaderFix({ tier: "load-bearing", plan: { mode: "debate", max_done_when: 6 } }) } });
  expect(labelled(calls, "R1:")).toHaveLength(4);
  expect(labelled(calls, "R2:")).toHaveLength(4);
  expect(labelled(calls, "sign:")).toHaveLength(4);
  expect(validate("plan.v1", result).ok).toBe(true);
});

// --- Task 4: templates/factory/claude/workflows/factory-implement.js ---

const FACTORY_IMPLEMENT_WORKFLOW = new URL("../../templates/factory/claude/workflows/factory-implement.js", import.meta.url).pathname;

const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "89abcdef0123456789abcdef0123456789abcdef";

// the implement roster in context.json is intentionally empty — builder and verifier are fixed roles
// (roles.toml [implement.builder]/[implement.verifier]), not a CHARTER-driven debate roster.
const implLoaderFix = (over = {}) => ({
  issue: 42,
  stage: "implement",
  tier: "standard",
  roster: [],
  spec_path: "docs/features/016-export-csv.md",
  orchestration: "workflow",
  ...over,
});

const buildFix = (over = {}) => ({
  head_sha: SHA_A,
  pr: 31,
  branch: "claude/fq-42",
  summary: "Export the report table as CSV",
  tests_added: ["test_42_export_csv_header"],
  commits: [SHA_A],
  ...over,
});

const verdictFix = (over = {}) => ({ verdict: "accepted", findings: [], prove_test_read: true, ...over });

const REJECTED = {
  verdict: "rejected",
  findings: [{ where: "test/export.test.js:20", claim: "the mock always returns three rows", evidence: "line 20 stubs read() with a fixed array — the since filter is never exercised" }],
  prove_test_read: true,
};

const byType = (calls, type) => calls.filter((c) => c.opts.agentType === type);

test("factory-implement.js: meta.name equals the file's own basename", () => {
  const src = readFileSync(FACTORY_IMPLEMENT_WORKFLOW, "utf8");
  const m = /^\s*name:\s*['"]([^'"]+)['"]/m.exec(src);
  expect(m[1]).toBe(basename(FACTORY_IMPLEMENT_WORKFLOW, ".js"));
});

test("factory-implement.js: builder → verifier, Load/Build/Verify/Fix phases, and a valid implement.v1 handoff", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix();
    if (opts.agentType === "factory-builder") return buildFix();
    if (opts.agentType === "factory-verifier") return verdictFix();
    return null;
  };

  const { result, calls, phases } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub,
    args: { issue: "42", context: ".factory/out/context.json", loaded: implLoaderFix() },
  });

  expect(calls.map((c) => c.opts.agentType)).toEqual(["factory-builder", "factory-verifier"]);
  expect(calls[0].opts.model).toBe("opus");
  expect(calls[1].opts.model).toBe("opus");
  // the fix phase is declared even when nothing is rejected — phases are the script's shape, not its history
  expect(phases).toEqual(["Load", "Build", "Verify", "Fix"]);

  expect(result).toMatchObject({
    issue: 42,
    head_sha: SHA_A,
    pr: 31,
    summary: "Export the report table as CSV",
    tests_added: ["test_42_export_csv_header"],
    orchestration: "workflow",
    guarantee: "structural",
    verifier: { verdict: "accepted", findings: [], prove_test_read: true },
  });
  expect(result.rework_response).toBeUndefined();
  // `gates` is filled in by verify-stage from the gate files, never by the workflow (ADR-010)
  expect(validate("implement.v1", result).ok).toBe(false);
  expect(validate("implement.v1", { ...result, gates: { status: "GREEN" } }).ok).toBe(true);
});

test("factory-implement.js: a rejected verdict buys exactly one fix round — the second head_sha wins and the builder is shown the findings", async () => {
  let builds = 0;
  let verifies = 0;
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix();
    if (opts.agentType === "factory-builder") { builds += 1; return buildFix(builds === 1 ? {} : { head_sha: SHA_B, commits: [SHA_A, SHA_B] }); }
    if (opts.agentType === "factory-verifier") { verifies += 1; return verifies === 1 ? REJECTED : verdictFix(); }
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix() },
  });

  expect(byType(calls, "factory-builder")).toHaveLength(2);
  expect(byType(calls, "factory-verifier")).toHaveLength(2);
  expect(byType(calls, "factory-builder")[1].prompt).toContain("the mock always returns three rows");
  // the second verdict is about the second head, not the one it already judged
  expect(byType(calls, "factory-verifier")[0].prompt).toContain(SHA_A);
  expect(byType(calls, "factory-verifier")[1].prompt).toContain(SHA_B);
  expect(byType(calls, "factory-verifier")[1].prompt).not.toContain(SHA_A);
  expect(result.head_sha).toBe(SHA_B);
  expect(result.verifier.verdict).toBe("accepted");
  expect(validate("implement.v1", { ...result, gates: { status: "GREEN" } }).ok).toBe(true);
});

test("factory-implement.js: a second rejection ends the stage rejected — no third builder, no third verifier", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix();
    if (opts.agentType === "factory-builder") return buildFix({ head_sha: SHA_B });
    if (opts.agentType === "factory-verifier") return REJECTED;
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix() },
  });

  expect(byType(calls, "factory-builder")).toHaveLength(2);
  expect(byType(calls, "factory-verifier")).toHaveLength(2);
  expect(calls).toHaveLength(4);
  expect(result.verifier.verdict).toBe("rejected");
  expect(result.verifier.findings).toEqual(REJECTED.findings);
  // implement.v1 still validates — `rejected` is a legal verdict. requirements.js refuses the
  // awaiting-review transition on it, which is what turns this into needs-human (P3-R2).
  expect(validate("implement.v1", { ...result, gates: { status: "GREEN" } }).ok).toBe(true);
});

// ADR-020 KTB-23 — 데모 #2: builder는 `pg`가 필요한데 `package.json`을 못 건드렸고, 프롬프트는 그것을
// PR 본문의 산문("Harness change needed")으로 쓰라고 시켰다. 그 산문을 읽는 기계는 없었다 —
// 네 라운드·≈$67·머지 0건. 이제 그 요청은 handoff의 필드이고, L1이 그것을 읽어 라우팅한다.
test("factory-implement.js: the builder asks for a protected-file change as a field, and it reaches the handoff (KTB-23)", async () => {
  const harnessNeeded = [{ file: "package.json", change: "add dependency pg@^8 to dependencies", why: "dw1/dw3/dw4 need a Postgres client" }];
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix();
    if (opts.agentType === "factory-builder") return buildFix({ harness_needed: harnessNeeded });
    if (opts.agentType === "factory-verifier") return REJECTED;          // 테스트를 못 썼으니 당연히 reject다
    return null;
  };
  const { result, calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub, args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix() },
  });
  expect(result.harness_needed).toEqual(harnessNeeded);
  expect(validate("implement.v1", { ...result, gates: { status: "GREEN" } }).ok).toBe(true);
  // 프롬프트가 필드를 시키고, 산문 제목은 더 이상 지시하지 않는다
  const buildPrompt = byType(calls, "factory-builder")[0].prompt;
  expect(buildPrompt).toContain("harness_needed");
  expect(buildPrompt).toContain("{file: the exact path, change:");
  expect(buildPrompt).not.toContain('"Harness change needed" heading and finish');
});

// ADR-020 KTB-23 fix — 하네스 이슈의 builder는 자기가 열려 있는 파일을 "보호 경로"로 읽고 있었다:
// 프롬프트만 그 판단을 못 받았기 때문이다(훅은 env로, L2는 `--settings`로 이미 알고 있었다).
// 그래서 승격 이슈의 builder가 `harness_needed`를 채우고 멈췄고, L1이 또 하네스 이슈를 열었다 — 사슬이다.
test("factory-implement.js: a harness issue gets the variant rule 8 — make the change, do not ask (KTB-23 fix)", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix();
    if (opts.agentType === "factory-builder") return buildFix();
    if (opts.agentType === "factory-verifier") return verdictFix();
    return null;
  };
  const promptFor = async (harness_issue) => {
    const { calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
      agent: stub, args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix(), ...(harness_issue === undefined ? {} : { harness_issue }) },
    });
    return byType(calls, "factory-builder")[0].prompt;
  };

  const harness = await promptFor(true);
  expect(harness).toContain("THIS IS A `factory:harness` ISSUE");
  expect(harness).toContain("Do NOT fill `harness_needed` and do NOT stop");
  // 열린 파일은 "보호 경로"로 나열되지 않는다 — 그 목록이 바로 이 이슈가 고치러 온 것이다
  expect(harness).toContain("`.factory/harness.toml`, `vitest.config.*`, `playwright.config.*`, `package.json`, `package-lock.json`");
  expect(harness).not.toContain("you must not edit `.factory/**`, `.claude/**`");
  // 그래도 닫혀 있는 것은 그대로 닫혀 있고, 머지는 여전히 사람이다
  expect(harness).toContain("`.factory/package.json` is the runner's own manifest and stays shut");
  expect(harness).toContain("The merge is still a human's");

  // 평범한 이슈는 한 글자도 바뀌지 않는다 — 플래그가 없거나 false면 예전 규칙 8 그대로다
  for (const flag of [false, "false", undefined]) {
    const normal = await promptFor(flag);
    expect(normal, String(flag)).toContain("Protected paths — you must not edit `.factory/**`");
    expect(normal, String(flag)).toContain("fill `harness_needed` in your output");
    expect(normal, String(flag)).not.toContain("THIS IS A `factory:harness` ISSUE");
  }
  // 문자열 "true"도 받는다 — 디스패처가 `$2`를 그대로 실어 보내는 모양이다
  expect(await promptFor("true")).toContain("THIS IS A `factory:harness` ISSUE");
});

// KTB-27 — Claude Code does not substitute positional `$1`/`$2` in a command md, only `$ARGUMENTS`
// (verified live: `claude -p "/argtest 42 true"` filled `$ARGUMENTS` correctly but turned `$1` into
// "true" and left `$2` as the literal text "$2"). The implement dispatcher now passes the whole
// `$ARGUMENTS` string as `args.raw` ("<issue> <harness_issue>"), and the workflow splits it itself.
test('factory-implement.js: args.raw "2 true" parses into issue 2 + the harness variant (KTB-27)', async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix({ issue: 2 });
    if (opts.agentType === "factory-builder") return buildFix({ branch: "claude/fq-2" });
    if (opts.agentType === "factory-verifier") return verdictFix();
    return null;
  };
  const { result, calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub, args: { raw: "2 true", context: ".factory/out/context.json", loaded: implLoaderFix({ issue: 2 }) },
  });
  expect(result.issue).toBe(2);
  const prompt = byType(calls, "factory-builder")[0].prompt;
  expect(prompt).toContain("Issue #2");
  expect(prompt).toContain("THIS IS A `factory:harness` ISSUE");
});

test('factory-implement.js: args.raw "2" (no second token) parses into issue 2 + the normal rules (KTB-27)', async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix({ issue: 2 });
    if (opts.agentType === "factory-builder") return buildFix({ branch: "claude/fq-2" });
    if (opts.agentType === "factory-verifier") return verdictFix();
    return null;
  };
  const { result, calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub, args: { raw: "2", context: ".factory/out/context.json", loaded: implLoaderFix({ issue: 2 }) },
  });
  expect(result.issue).toBe(2);
  const prompt = byType(calls, "factory-builder")[0].prompt;
  expect(prompt).toContain("Protected paths — you must not edit `.factory/**`");
  expect(prompt).not.toContain("THIS IS A `factory:harness` ISSUE");
});

test("factory-implement.js: args.issue/args.harness_issue still work with no raw at all (backward compat, KTB-27)", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix();
    if (opts.agentType === "factory-builder") return buildFix();
    if (opts.agentType === "factory-verifier") return verdictFix();
    return null;
  };
  const { result, calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub, args: { issue: 42, harness_issue: true, context: ".factory/out/context.json", loaded: implLoaderFix() },
  });
  expect(result.issue).toBe(42);
  const prompt = byType(calls, "factory-builder")[0].prompt;
  expect(prompt).toContain("THIS IS A `factory:harness` ISSUE");
});

test("factory-implement.js: no command md contains an unsubstituted positional $1/$2 (KTB-27)", () => {
  const t = readFileSync(new URL("../../templates/factory/claude/commands/factory-implement.md", import.meta.url).pathname, "utf8");
  expect(t).not.toMatch(/\$1\b/);
  expect(t).not.toMatch(/\$2\b/);
});

test("factory-implement.js: no harness_needed means the field is absent from the handoff, never an empty array (KTB-23)", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix();
    if (opts.agentType === "factory-builder") return buildFix({ harness_needed: [] });
    if (opts.agentType === "factory-verifier") return verdictFix();
    return null;
  };
  const { result } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, { agent: stub, args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix() } });
  expect("harness_needed" in result).toBe(false);                        // 빈 요청은 이슈를 공연히 주차시킨다
});

test("factory-implement.js: a head_sha that is not 40 hex re-spawns the builder exactly once, with the rule in the prompt", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix();
    if (opts.agentType === "factory-builder") return buildFix({ head_sha: "abc" });
    if (opts.agentType === "factory-verifier") return verdictFix();
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix() },
  });

  expect(byType(calls, "factory-builder")).toHaveLength(2);
  expect(byType(calls, "factory-builder")[1].prompt).toContain("git rev-parse HEAD");
  expect(byType(calls, "factory-verifier")).toHaveLength(1);
  expect(result.head_sha).toBe("abc");
  expect(validate("implement.v1", { ...result, gates: { status: "GREEN" } }).errors).toContain("head_sha must be a 40-hex sha");
});

test("factory-implement.js: rework — every must_fix id reaches the builder prompt and the response comes back as a valid rework-response.v1", async () => {
  const mustFix = [
    { id: "cf1", where: "src/sync/service.ts:88", claim: "the since cursor is parsed in local time", evidence: "line 88 `new Date(since)`" },
    { id: "arch2", where: "src/sync/service.ts", claim: "SyncService should be split", evidence: "500 lines, four responsibilities" },
  ];
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix({ pr: 31, head_sha: SHA_A, must_fix: mustFix, disputed: [{ id: "arch2", status: "disputed", reason: "out of scope per non_goals" }] });
    if (opts.agentType === "factory-builder") {
      return buildFix({
        rework_response: { responses: [
          { id: "cf1", status: "fixed", commit: SHA_B },
          { id: "arch2", status: "disputed", reason: "splitting SyncService is in the plan handoff non_goals (#42 plan)" },
        ] },
      });
    }
    if (opts.agentType === "factory-verifier") return verdictFix();
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix({ pr: 31, head_sha: SHA_A, must_fix: mustFix, disputed: [{ id: "arch2", status: "disputed", reason: "out of scope per non_goals" }] }) },
  });

  const build = byType(calls, "factory-builder")[0];
  expect(build.prompt).toContain("cf1");
  expect(build.prompt).toContain("arch2");
  expect(build.prompt).toContain("factory.rework-response.v1");
  expect(build.prompt).toContain("gh pr comment");
  expect(result.rework_response).toEqual({
    issue: 42,
    responses: [
      { id: "cf1", status: "fixed", commit: SHA_B },
      { id: "arch2", status: "disputed", reason: "splitting SyncService is in the plan handoff non_goals (#42 plan)" },
    ],
  });
  expect(validate("rework-response.v1", result.rework_response).ok).toBe(true);
});

test("factory-implement.js: the verifier reads cold — nothing of the builder's output but the head_sha and PR number reaches its prompt", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix();
    if (opts.agentType === "factory-builder") {
      return buildFix({ summary: "BUILDER-SUMMARY-MARKER", branch: "BUILDER-BRANCH-MARKER", tests_added: ["BUILDER-TEST-MARKER"], commits: ["BUILDER-COMMIT-MARKER"] });
    }
    if (opts.agentType === "factory-verifier") return verdictFix();
    return null;
  };

  const { calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix() },
  });

  const verify = byType(calls, "factory-verifier")[0];
  for (const marker of ["BUILDER-SUMMARY-MARKER", "BUILDER-BRANCH-MARKER", "BUILDER-TEST-MARKER", "BUILDER-COMMIT-MARKER"]) {
    expect(verify.prompt, marker).not.toContain(marker);
  }
  expect(verify.prompt).toContain(SHA_A);
  expect(verify.prompt).toContain("31");
  expect(verify.prompt).toMatch(/do not read/i);
});

test("factory-implement.js: payload/dispatcher issue mismatch fails closed — nothing is built, implement.v1 invalid", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix({ issue: 99 });
    return buildFix();
  };

  const { result, calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix({ issue: 99 }) },
  });

  expect(calls).toEqual([]);
  expect(result.issue).toBe(42);
  expect(result.error).toMatch(/context issue mismatch/);
  expect(result.head_sha).toBeUndefined();
  expect(result.orchestration).toBe("workflow");
  expect(result.guarantee).toBe("structural");
  expect(validate("implement.v1", { ...result, gates: { status: "GREEN" } }).ok).toBe(false);
});

test("factory-implement.js: a builder that dies twice is not invented around — no verifier call, no head_sha", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix();
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix() },
  });

  expect(byType(calls, "factory-builder")).toHaveLength(2);
  expect(byType(calls, "factory-verifier")).toHaveLength(0);
  expect(result.head_sha).toBeUndefined();
  expect(result.verifier).toEqual({});
  expect(validate("implement.v1", { ...result, gates: { status: "GREEN" } }).ok).toBe(false);
});

test("factory-implement.js: the builder prompt carries the protected build-config paths and the harness-change escape hatch", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix();
    if (opts.agentType === "factory-builder") return buildFix();
    return verdictFix();
  };
  const { calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix() },
  });
  const build = byType(calls, "factory-builder")[0].prompt;
  for (const p of [".factory/**", ".claude/**", "docs/factory/CHARTER.md", "package.json", "package-lock.json", "vitest.config.*", "playwright.config.*", "tsconfig*.json", ".eslintrc*", "eslint.config.*"]) {
    expect(build, p).toContain(p);
  }
  expect(build).toContain("Harness change needed");
  expect(build).toMatch(/npm install/);
  expect(build).toContain("claude/fq-42");
  expect(build).toContain("gh pr create --draft");
  expect(build).toContain("Closes #42");
});

const REWORK_MUST_FIX = [
  { id: "cf1", where: "src/sync/service.ts:88", claim: "the since cursor is parsed in local time", evidence: "line 88 `new Date(since)`" },
  { id: "arch2", where: "src/sync/service.ts", claim: "SyncService should be split", evidence: "500 lines, four responsibilities" },
];

test("factory-implement.js: a rework answer that skips a must_fix id re-spawns the builder once, naming the id it left out", async () => {
  let builds = 0;
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix({ pr: 31, must_fix: REWORK_MUST_FIX });
    if (opts.agentType === "factory-builder") {
      builds += 1;
      const responses = builds === 1
        ? [{ id: "cf1", status: "fixed", commit: SHA_B }]
        : [{ id: "cf1", status: "fixed", commit: SHA_B }, { id: "arch2", status: "disputed", reason: "non_goals of the #42 plan" }];
      return buildFix({ rework_response: { responses } });
    }
    if (opts.agentType === "factory-verifier") return verdictFix();
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix({ pr: 31, must_fix: REWORK_MUST_FIX }) },
  });

  expect(byType(calls, "factory-builder")).toHaveLength(2);
  const completion = byType(calls, "factory-builder")[1].prompt;
  expect(completion).toContain("rework_response was incomplete");
  expect(completion).toContain("arch2");
  expect(result.error).toBeUndefined();
  expect(result.rework_response.responses).toHaveLength(2);
  expect(validate("rework-response.v1", result.rework_response).ok).toBe(true);
  expect(validate("implement.v1", { ...result, gates: { status: "GREEN" } }).ok).toBe(true);
});

test("factory-implement.js: a rework answer still incomplete after the re-spawn fails closed — error, no verifier key, no verifier call", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix({ pr: 31, must_fix: REWORK_MUST_FIX });
    if (opts.agentType === "factory-builder") return buildFix({ rework_response: { responses: [{ id: "cf1", status: "fixed", commit: SHA_B }] } });
    if (opts.agentType === "factory-verifier") return verdictFix();
    return null;
  };

  const { result, calls, phases } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix({ pr: 31, must_fix: REWORK_MUST_FIX }) },
  });

  expect(byType(calls, "factory-builder")).toHaveLength(2);
  expect(byType(calls, "factory-verifier")).toHaveLength(0);
  expect(phases).toEqual(["Load", "Build"]);
  expect(result.error).toBe("rework response incomplete: arch2");
  expect(result.verifier).toBeUndefined();
  expect(result.head_sha).toBe(SHA_A);
  expect(result.pr).toBe(31);
  // no verifier verdict at all — verify-stage's implement.v1 check fails the stage into needs-human
  expect(validate("implement.v1", { ...result, gates: { status: "GREEN" } }).ok).toBe(false);
});

test("factory-implement.js: a malformed rework entry (fixed with no commit, unknown status) counts as incomplete", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix({ pr: 31, must_fix: REWORK_MUST_FIX });
    if (opts.agentType === "factory-builder") {
      return buildFix({ rework_response: { responses: [{ id: "cf1", status: "fixed" }, { id: "arch2", status: "acknowledged" }] } });
    }
    return verdictFix();
  };

  const { result, calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix({ pr: 31, must_fix: REWORK_MUST_FIX }) },
  });

  const completion = byType(calls, "factory-builder")[1].prompt;
  expect(completion).toContain("cf1 (status fixed needs a commit)");
  expect(completion).toContain("arch2 (status must be fixed or disputed)");
  expect(result.error).toMatch(/^rework response incomplete: /);
  expect(result.verifier).toBeUndefined();
});

test("factory-implement.js: the rework block is repeated in the fix prompt — a rejected rework round still has to answer must_fix", async () => {
  let verifies = 0;
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix({ pr: 31, must_fix: REWORK_MUST_FIX });
    if (opts.agentType === "factory-builder") {
      return buildFix({ rework_response: { responses: [
        { id: "cf1", status: "fixed", commit: SHA_B },
        { id: "arch2", status: "disputed", reason: "non_goals of the #42 plan" },
      ] } });
    }
    if (opts.agentType === "factory-verifier") { verifies += 1; return verifies === 1 ? REJECTED : verdictFix(); }
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix({ pr: 31, must_fix: REWORK_MUST_FIX }) },
  });

  const fix = byType(calls, "factory-builder")[1].prompt;
  expect(fix).toContain("REWORK round");
  expect(fix).toContain("arch2");
  expect(fix).toContain("gh pr comment");
  expect(result.verifier.verdict).toBe("accepted");
  expect(result.rework_response.responses).toHaveLength(2);
});

test("factory-implement.js: a missing args.loaded fails the stage closed — nothing is built, named error", async () => {
  const stub = async (prompt, opts) => (opts.agentType === "factory-loader" ? null : buildFix());

  const { result, calls, phases } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: null },
  });

  expect(calls).toEqual([]);
  expect(phases).toEqual(["Load"]);
  expect(result).toEqual({ issue: 42, error: "context payload missing", orchestration: "workflow", guarantee: "structural" });
  expect(validate("implement.v1", { ...result, gates: { status: "GREEN" } }).ok).toBe(false);
});

test("factory-implement.js: the verifier must quote prove-test's expected/observed line as evidence", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix();
    if (opts.agentType === "factory-builder") return buildFix();
    return verdictFix();
  };
  const { calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix() },
  });
  const verify = byType(calls, "factory-verifier")[0].prompt;
  expect(verify).toContain("expected/observed");
  expect(verify).toMatch(/quote/);
});

// --- Task 5: templates/factory/claude/workflows/factory-review.js ---

const FACTORY_REVIEW_WORKFLOW = new URL("../../templates/factory/claude/workflows/factory-review.js", import.meta.url).pathname;

// the review roster comes from CHARTER/roles.toml via the loader — the workflow never hardcodes it.
const REVIEW_ROSTER = [
  { name: "correctness", agentType: "reviewer-correctness", model: "opus", lessons: ".factory/lessons/reviewer-correctness.md" },
  { name: "architecture", agentType: "reviewer-architecture", model: "opus", lessons: ".factory/lessons/reviewer-architecture.md" },
  { name: "spec-conformance", agentType: "reviewer-spec-conformance", model: "sonnet", lessons: ".factory/lessons/reviewer-spec-conformance.md" },
  { name: "qa", agentType: "reviewer-qa", model: "sonnet", lessons: ".factory/lessons/reviewer-qa.md" },
];

const reviewLoaderFix = (over = {}) => ({
  issue: 42,
  stage: "review",
  tier: "standard",
  roster: REVIEW_ROSTER,
  rounds: 2,
  spec_path: "docs/features/016-export-csv.md",
  pr: 31,
  head_sha: SHA_A,
  must_fix: [],
  disputed: [],
  orchestration: "workflow",
  ...over,
});

const approveV = (role, over = {}) => ({
  role,
  verdict: "approve",
  confidence: "high",
  must_fix: [],
  should_fix: [],
  verified: [`${role}: read the diff and the tests it adds`],
  ...over,
});

const finding = (id) => ({ id, where: `src/export/${id}.js:12`, claim: `${id} claim`, evidence: `${id} evidence` });

const rejectV = (role, id, over = {}) => ({
  role,
  verdict: "reject",
  confidence: "high",
  must_fix: [finding(id)],
  should_fix: [],
  verified: [],
  ...over,
});

const labelOf = (c) => c.opts.label || "";
const withLabel = (calls, prefix) => calls.filter((c) => labelOf(c).startsWith(prefix));

test("factory-review.js: meta.name equals the file's own basename", () => {
  const src = readFileSync(FACTORY_REVIEW_WORKFLOW, "utf8");
  const m = /^\s*name:\s*['"]([^'"]+)['"]/m.exec(src);
  expect(m[1]).toBe(basename(FACTORY_REVIEW_WORKFLOW, ".js"));
});

test("factory-review.js: unanimous approve with nothing missed — R1 ×4 then light R2 ×4, and a valid review.v1 handoff", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return reviewLoaderFix();
    const label = opts.label;
    if (label.startsWith("R1:")) return approveV(label.slice(3));
    if (label.startsWith("R2-light:")) return { missed: [] };
    return null;
  };

  const { result, calls, phases } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: "42", context: ".factory/out/context.json", loaded: reviewLoaderFix() },
  });

  expect(phases).toEqual(["Load", "Disputes", "R1", "R2"]);
  expect(withLabel(calls, "R1:")).toHaveLength(4);
  expect(withLabel(calls, "R2-light:")).toHaveLength(4);
  expect(withLabel(calls, "R2:")).toHaveLength(0);
  expect(withLabel(calls, "dispute:")).toHaveLength(0);
  expect(calls).toHaveLength(8);

  // every reviewer is spawned as its own agent file, with the model the loader carried from roles.toml
  expect(withLabel(calls, "R1:").map((c) => c.opts.agentType)).toEqual([
    "reviewer-correctness", "reviewer-architecture", "reviewer-spec-conformance", "reviewer-qa",
  ]);
  expect(withLabel(calls, "R1:").map((c) => c.opts.model)).toEqual(["opus", "opus", "sonnet", "sonnet"]);

  expect(result.verdicts).toHaveLength(4);
  expect(result.verdicts.every((v) => v.verdict === "approve")).toBe(true);
  expect(result.verdicts.map((v) => v.role)).toEqual(["correctness", "architecture", "spec-conformance", "qa"]);
  expect(result.round).toBe(0); // run-stage recounts the round from the handoff comments
  expect(result.decision).toBeUndefined(); // aggregate-review.sh owns `decision`, never the workflow
  // F7: `r1`은 싣지 않는다 — `verdicts`가 곧 R2 결과이고, 경량 R2에서 missed가 없으면 그것이 R1 그대로다.
  expect(result.r1).toBeUndefined();
  expect(result.disputes).toEqual([]);
  expect(result.summary).toContain("4 approve");
  expect(validate("review.v1", result).ok).toBe(true);
});

test("factory-review.js: one R1 reject turns R2 into a full exchange — revise replaces, maintain keeps R1", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return reviewLoaderFix();
    const label = opts.label;
    if (label.startsWith("R1:")) {
      const role = label.slice(3);
      return role === "correctness" ? rejectV(role, "cf1") : approveV(role);
    }
    if (label.startsWith("R2:")) {
      const role = label.slice(3);
      if (role === "architecture") {
        return { verdict: "revise", must_fix: [finding("arch2")], should_fix: [], verified: [], on_others: [{ id: "cf1", stance: "agree", reason: "the UTC claim checks out" }] };
      }
      return { verdict: "maintain", must_fix: [], should_fix: [], verified: [], on_others: [] };
    }
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: reviewLoaderFix() },
  });

  expect(withLabel(calls, "R1:")).toHaveLength(4);
  expect(withLabel(calls, "R2:")).toHaveLength(4);
  expect(withLabel(calls, "R2-light:")).toHaveLength(0);

  const byRole = Object.fromEntries(result.verdicts.map((v) => [v.role, v]));
  // maintain keeps the R1 judgement verbatim
  expect(byRole.correctness.verdict).toBe("reject");
  expect(byRole.correctness.must_fix).toEqual([finding("cf1")]);
  // revise replaces the lists — an approve that grows a must_fix becomes a reject
  expect(byRole.architecture.verdict).toBe("reject");
  expect(byRole.architecture.must_fix).toEqual([finding("arch2")]);
  expect(byRole.architecture.verified).toEqual([]);
  expect(byRole.qa.verdict).toBe("approve");
  // F7: r1은 handoff에 실리지 않는다 — 그 사실은 프롬프트(각자에게 자기 R1을 되돌려 준다)로만 남는다
  expect(result.r1).toBeUndefined();
  expect(withLabel(calls, "R2:").find((c) => labelOf(c) === "R2:architecture").prompt).toContain('"verdict": "approve"');
  expect(validate("review.v1", result).ok).toBe(true);

  // the full R2 hands each reviewer the OTHERS' R1, never its own back
  const archR2 = withLabel(calls, "R2:").find((c) => labelOf(c) === "R2:architecture").prompt;
  expect(archR2).toContain("cf1");
  expect(archR2).toContain("correctness");
  // it sees its own R1 once (to decide maintain|revise) and never again inside the others' block
  const othersBlock = archR2.slice(archR2.indexOf("The other reviewers' round-1 judgements:"));
  expect(othersBlock).not.toContain('"role": "architecture"');
  expect(othersBlock).toContain('"role": "correctness"');
});

test("factory-review.js: a light R2 that reports `missed` promotes only that reviewer to a full R2", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return reviewLoaderFix();
    const label = opts.label;
    if (label.startsWith("R1:")) return approveV(label.slice(3));
    if (label.startsWith("R2-light:")) {
      return label.endsWith(":qa")
        ? { missed: [{ what: "nobody opened the export dialog", why: "the done_when is a user-visible download" }] }
        : { missed: [] };
    }
    if (label === "R2:qa") {
      return { verdict: "revise", must_fix: [finding("qa1")], should_fix: [], verified: [], on_others: [] };
    }
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: reviewLoaderFix() },
  });

  expect(withLabel(calls, "R2-light:")).toHaveLength(4);
  expect(withLabel(calls, "R2:")).toHaveLength(1);
  expect(labelOf(withLabel(calls, "R2:")[0])).toBe("R2:qa");
  // 4 light + 1 promoted full = 5 R2 spawns in total
  expect(calls.filter((c) => labelOf(c).startsWith("R2")).length).toBe(5);

  const promoted = withLabel(calls, "R2:")[0].prompt;
  expect(promoted).toContain("nobody opened the export dialog");

  const byRole = Object.fromEntries(result.verdicts.map((v) => [v.role, v]));
  expect(byRole.qa.verdict).toBe("reject");
  expect(byRole.qa.must_fix).toEqual([finding("qa1")]);
  expect(byRole.correctness.verdict).toBe("approve");
  expect(validate("review.v1", result).ok).toBe(true);
});

test("factory-review.js: a disputed cf1 goes to correctness only — uphold forces it back into that reviewer's must_fix", async () => {
  const disputed = [{ id: "cf1", status: "disputed", reason: "out of scope per the plan's non_goals" }];
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return reviewLoaderFix({ disputed, must_fix: [finding("cf1")] });
    const label = opts.label;
    if (label.startsWith("dispute:")) return { rulings: [{ id: "cf1", ruling: "uphold", reason: "non_goals says nothing about the parser" }] };
    if (label.startsWith("R1:")) return approveV(label.slice(3)); // even an approving R1 cannot bury an upheld item
    if (label.startsWith("R2:")) return { verdict: "maintain", must_fix: [], should_fix: [], verified: [], on_others: [] };
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: reviewLoaderFix({ disputed, must_fix: [finding("cf1")] }) },
  });

  const disputeCalls = withLabel(calls, "dispute:");
  expect(disputeCalls).toHaveLength(1);
  expect(disputeCalls[0].opts.agentType).toBe("reviewer-correctness");
  expect(disputeCalls[0].prompt).toContain("cf1");
  expect(disputeCalls[0].prompt).toContain("out of scope per the plan's non_goals");
  // the dispute runs before R1 and the upheld id is named in that reviewer's R1 prompt
  expect(calls.indexOf(disputeCalls[0])).toBeLessThan(calls.indexOf(withLabel(calls, "R1:")[0]));
  expect(withLabel(calls, "R1:").find((c) => labelOf(c) === "R1:correctness").prompt).toContain("uphold");

  const cf = result.verdicts.find((v) => v.role === "correctness");
  expect(cf.verdict).toBe("reject");
  expect(cf.must_fix.map((m) => m.id)).toEqual(["cf1"]);
  expect(result.disputes).toEqual([{ role: "correctness", by: "correctness", id: "cf1", ruling: "uphold", reason: "non_goals says nothing about the parser" }]);
  // nobody else is asked about someone else's id
  expect(result.verdicts.filter((v) => v.role !== "correctness").every((v) => v.must_fix.length === 0)).toBe(true);
  expect(validate("review.v1", result).ok).toBe(true);
});

test("factory-review.js: a withdrawn dispute is not forced back in — the R1 verdict stands", async () => {
  const disputed = [{ id: "cf1", status: "disputed", reason: "the plan's non_goals excludes the parser" }];
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return reviewLoaderFix({ disputed, must_fix: [finding("cf1")] });
    const label = opts.label;
    if (label.startsWith("dispute:")) return { rulings: [{ id: "cf1", ruling: "withdraw", reason: "agreed — non_goals covers it" }] };
    if (label.startsWith("R1:")) return approveV(label.slice(3));
    if (label.startsWith("R2-light:")) return { missed: [] };
    return null;
  };

  const { result } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: reviewLoaderFix({ disputed, must_fix: [finding("cf1")] }) },
  });

  const cf = result.verdicts.find((v) => v.role === "correctness");
  expect(cf.verdict).toBe("approve");
  expect(cf.must_fix).toEqual([]);
  expect(result.disputes[0].ruling).toBe("withdraw");
  expect(validate("review.v1", result).ok).toBe(true);
});

test("factory-review.js: a disputed id is routed by its prefix — sec/arch/spec/qa each reach exactly their owner", async () => {
  const disputed = [
    { id: "sec1", status: "disputed", reason: "r1" },
    { id: "arch3", status: "disputed", reason: "r2" },
    { id: "spec2", status: "disputed", reason: "r3" },
    { id: "qa7", status: "disputed", reason: "r4" },
    { id: "zzz9", status: "disputed", reason: "nobody owns this prefix" },
  ];
  const roster = [
    { name: "security", agentType: "reviewer-security", model: "opus", lessons: ".factory/lessons/reviewer-security.md" },
    ...REVIEW_ROSTER,
  ];
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return reviewLoaderFix({ roster, disputed });
    const label = opts.label;
    if (label.startsWith("dispute:")) return { rulings: [] };
    if (label.startsWith("R1:")) return approveV(label.slice(3));
    if (label.startsWith("R2-light:")) return { missed: [] };
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: reviewLoaderFix({ roster, disputed }) },
  });

  const disputeCalls = withLabel(calls, "dispute:");
  expect(disputeCalls.map((c) => c.opts.agentType).sort()).toEqual([
    "reviewer-architecture", "reviewer-qa", "reviewer-security", "reviewer-spec-conformance",
  ]);
  const secPrompt = disputeCalls.find((c) => c.opts.agentType === "reviewer-security").prompt;
  expect(secPrompt).toContain("sec1");
  expect(secPrompt).not.toContain("spec2");
  // an id no reviewer owns is recorded rather than silently dropped
  expect(result.disputes).toContainEqual({ role: null, by: null, id: "zzz9", ruling: "unowned", reason: "no reviewer in this round owns that id prefix" });
  expect(result.verdicts).toHaveLength(5);
});

test("factory-review.js: a reviewer that dies twice is dropped, not invented — no R2 for it, verdicts short of the roster", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return reviewLoaderFix();
    const label = opts.label;
    if (label.startsWith("R1:")) return label.endsWith(":qa") ? null : approveV(label.slice(3));
    if (label.startsWith("R2-light:")) return { missed: [] };
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: reviewLoaderFix() },
  });

  expect(withLabel(calls, "R1:qa")).toHaveLength(2); // one insurance re-spawn (ADR-003), then it is dropped
  expect(withLabel(calls, "R2-light:")).toHaveLength(3);
  expect(withLabel(calls, "R2-light:qa")).toHaveLength(0);
  expect(result.verdicts.map((v) => v.role)).toEqual(["correctness", "architecture", "spec-conformance"]);
  expect(result.summary).toContain("qa");
  // review.v1 still validates — aggregate-review.sh compares verdicts against the roster and calls this
  // `incomplete` → needs-human, naming the missing role (§7.5).
  expect(validate("review.v1", result).ok).toBe(true);
});

test("factory-review.js: R1 is a cold read — every reviewer is pointed at its OWN context file, never the orchestrator's", async () => {
  const stub = async (prompt, opts) => {
    const label = opts.label;
    if (label.startsWith("R1:")) {
      const role = label.slice(3);
      return role === "correctness" ? rejectV(role, "cf1") : approveV(role);
    }
    if (label.startsWith("R2:")) return { verdict: "maintain", must_fix: [], should_fix: [], verified: [], on_others: [] };
    return null;
  };

  const { calls } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: reviewLoaderFix() },
  });

  const r1 = withLabel(calls, "R1:");
  // 감사 H4 — cold read는 프롬프트의 부탁이 아니라 **파일 경계**다: 리뷰어가 받는 경로는 자기
  // `context.<role>.json`뿐이고, 오케스트레이터의 전체 파일 경로는 어떤 프롬프트에도 등장하지 않는다
  // (등장하는 유일한 자리는 "그 파일을 열지 마라"는 금지 문장이다).
  for (const c of r1) {
    const role = labelOf(c).slice(3);
    expect(c.prompt, labelOf(c)).toContain(`.factory/out/context.${role}.json`);
    expect(c.prompt, labelOf(c)).toContain("Do NOT open `.factory/out/context.json`");
    expect(c.prompt, labelOf(c)).toContain("PR description");
    // 역할별 파일을 주는 이상 프롬프트가 handoff 필드를 이름으로 배분할 이유가 없다 — 그 분배는
    // 이미 `factory/lib/context.js`(roleContextFor)가 파일을 쓸 때 끝났다.
    expect(c.prompt, labelOf(c)).not.toContain("handoffs.plan —");
  }
  // no R1 prompt carries another reviewer's judgement, and every one carries the diff + gates
  for (const c of r1) {
    expect(c.prompt, labelOf(c)).not.toContain("cf1 claim");
    expect(c.prompt, labelOf(c)).not.toContain("cf1 evidence");
    expect(c.prompt, labelOf(c)).not.toContain('"verdict"');
    expect(c.prompt, labelOf(c)).toContain("git diff origin/");
    expect(c.prompt, labelOf(c)).toContain(".factory/out/gates.json");
    expect(c.prompt, labelOf(c)).toContain(SHA_A);
  }
  // the id prefix each reviewer must number its must_fix with
  const prefixes = { correctness: "cf", architecture: "arch", "spec-conformance": "spec", qa: "qa" };
  for (const c of r1) {
    expect(c.prompt, labelOf(c)).toContain(`\`${prefixes[labelOf(c).slice(3)]}1\``);
  }
  // every R1 reviewer is told to read its own lessons file
  expect(r1.find((c) => labelOf(c) === "R1:qa").prompt).toContain(".factory/lessons/reviewer-qa.md");

  // the light-R2 path is the only one that hides the others' judgements behind `verified`
  const full = withLabel(calls, "R2:").find((c) => labelOf(c) === "R2:qa").prompt;
  expect(full).toContain("cf1");
});

test("factory-review.js: a light R2 shows only the others' verified[] — no verdict, no must_fix leaks", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return reviewLoaderFix();
    const label = opts.label;
    if (label.startsWith("R1:")) return approveV(label.slice(3), { should_fix: [{ where: "src/a.js:2", claim: "SECRET-SHOULD-FIX" }] });
    if (label.startsWith("R2-light:")) return { missed: [] };
    return null;
  };

  const { calls } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: reviewLoaderFix() },
  });

  const light = withLabel(calls, "R2-light:").find((c) => labelOf(c) === "R2-light:correctness").prompt;
  expect(light).toContain("qa: read the diff and the tests it adds");
  expect(light).not.toContain("SECRET-SHOULD-FIX");
  expect(light).not.toContain('"verdict"');
  expect(light).not.toContain("correctness: read the diff"); // not its own verified list back
});

test("factory-review.js: a missing args.loaded fails the stage closed — no reviewer runs, named error", async () => {
  const stub = async (prompt, opts) => (opts.agentType === "factory-loader" ? null : approveV("correctness"));

  const { result, calls, phases } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: null },
  });

  expect(calls).toEqual([]);
  expect(phases).toEqual(["Load"]);
  expect(result).toEqual({ issue: 42, error: "context payload missing", orchestration: "workflow", guarantee: "structural" });
  expect(validate("review.v1", result).ok).toBe(false);
});

test("factory-review.js: payload/dispatcher issue mismatch fails closed — nothing is reviewed, review.v1 invalid", async () => {
  const stub = async () => approveV("correctness");

  const { result, calls } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: reviewLoaderFix({ issue: 7 }) },
  });

  expect(calls).toHaveLength(0);
  expect(result.error).toContain("context issue mismatch");
  expect(result.verdicts).toBeUndefined();
  expect(validate("review.v1", result).ok).toBe(false);
});

test("factory-review.js: the findings decide the verdict — an approve carrying must_fix becomes reject", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return reviewLoaderFix();
    const label = opts.label;
    if (label.startsWith("R1:")) {
      const role = label.slice(3);
      // the word says approve, the list says otherwise
      return role === "qa" ? { ...approveV(role), must_fix: [finding("qa1")] } : approveV(role);
    }
    if (label.startsWith("R2:")) return { verdict: "maintain", must_fix: [], should_fix: [], verified: [], on_others: [] };
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: reviewLoaderFix() },
  });

  // a reject in R1 — even a derived one — is what turns R2 into the full exchange
  expect(withLabel(calls, "R2:")).toHaveLength(4);
  expect(withLabel(calls, "R2-light:")).toHaveLength(0);
  const qa = result.verdicts.find((v) => v.role === "qa");
  expect(qa.verdict).toBe("reject");
  expect(qa.must_fix).toEqual([finding("qa1")]);
  // R1의 (유도된) reject는 handoff에 실리지 않지만(F7), R2 프롬프트가 자기 R1을 그대로 되돌려 준다
  expect(result.r1).toBeUndefined();
  expect(withLabel(calls, "R2:").find((c) => labelOf(c) === "R2:qa").prompt).toContain('"verdict": "reject"');
  expect(validate("review.v1", result).ok).toBe(true);
});

test("factory-review.js: a reject with an empty must_fix becomes approve — should_fix is left as filed", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return reviewLoaderFix();
    const label = opts.label;
    if (label.startsWith("R1:")) {
      const role = label.slice(3);
      return role === "architecture"
        ? { role, verdict: "reject", confidence: "low", must_fix: [], should_fix: [{ where: "src/a.js:2", claim: "naming" }], verified: [] }
        : approveV(role);
    }
    if (label.startsWith("R2-light:")) return { missed: [] };
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: reviewLoaderFix() },
  });

  // an unactionable reject cannot hold the round hostage — `review.v1` refuses it outright
  expect(withLabel(calls, "R2-light:")).toHaveLength(4);
  const arch = result.verdicts.find((v) => v.role === "architecture");
  expect(arch.verdict).toBe("approve");
  expect(arch.must_fix).toEqual([]);
  expect(arch.should_fix).toEqual([{ where: "src/a.js:2", claim: "naming" }]);
  expect(validate("review.v1", result).ok).toBe(true);
});

test("factory-review.js: a `revise` that empties must_fix flips the reject to approve", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return reviewLoaderFix();
    const label = opts.label;
    if (label.startsWith("R1:")) {
      const role = label.slice(3);
      return role === "correctness" ? rejectV(role, "cf1") : approveV(role);
    }
    if (label === "R2:correctness") {
      return { verdict: "revise", must_fix: [], should_fix: [], verified: ["cf: the base already handled it — my read of line 88 was wrong"], on_others: [] };
    }
    if (label.startsWith("R2:")) return { verdict: "maintain", must_fix: [], should_fix: [], verified: [], on_others: [] };
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: reviewLoaderFix() },
  });

  const cf = result.verdicts.find((v) => v.role === "correctness");
  expect(cf.verdict).toBe("approve");
  expect(cf.must_fix).toEqual([]);
  expect(cf.verified).toEqual(["cf: the base already handled it — my read of line 88 was wrong"]);
  // R1의 reject는 handoff에 남지 않는다(F7) — R2 프롬프트가 자기 R1을 되돌려 주는 것으로만 확인한다
  expect(result.r1).toBeUndefined();
  expect(withLabel(calls, "R2:").find((c) => labelOf(c) === "R2:correctness").prompt).toContain('"verdict": "reject"');
  expect(result.summary).toContain("4 approve");
  expect(validate("review.v1", result).ok).toBe(true);
});

test("factory-review.js: an R2 that dies twice leaves the R1 judgement standing", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return reviewLoaderFix();
    const label = opts.label;
    if (label.startsWith("R1:")) {
      const role = label.slice(3);
      return role === "correctness" ? rejectV(role, "cf1") : approveV(role);
    }
    if (label === "R2:correctness") return null; // both attempts
    if (label.startsWith("R2:")) return { verdict: "maintain", must_fix: [], should_fix: [], verified: [], on_others: [] };
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: reviewLoaderFix() },
  });

  expect(withLabel(calls, "R2:correctness")).toHaveLength(2); // one insurance re-spawn, then give up
  const cf = result.verdicts.find((v) => v.role === "correctness");
  expect(cf.verdict).toBe("reject");
  expect(cf.must_fix).toEqual([finding("cf1")]);
  expect(result.verdicts).toHaveLength(4); // the role is not dropped — it already judged
  expect(validate("review.v1", result).ok).toBe(true);
});

test("factory-review.js: a dispute nobody answers is recorded as `unruled` and counts as upheld", async () => {
  const disputed = [
    { id: "cf1", status: "disputed", reason: "out of scope" },
    { id: "cf2", status: "disputed", reason: "already fixed" },
  ];
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return reviewLoaderFix({ disputed, must_fix: [finding("cf1"), finding("cf2")] });
    const label = opts.label;
    if (label.startsWith("dispute:")) return null; // the reviewer dies on both attempts
    if (label.startsWith("R1:")) return approveV(label.slice(3));
    if (label.startsWith("R2:")) return { verdict: "maintain", must_fix: [], should_fix: [], verified: [], on_others: [] };
    return null;
  };

  const { result, calls } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: reviewLoaderFix({ disputed, must_fix: [finding("cf1"), finding("cf2")] }) },
  });

  expect(withLabel(calls, "dispute:")).toHaveLength(2); // one insurance re-spawn
  expect(result.disputes).toEqual([
    { role: "correctness", by: "correctness", id: "cf1", ruling: "unruled", reason: "the reviewer did not respond" },
    { role: "correctness", by: "correctness", id: "cf2", ruling: "unruled", reason: "the reviewer did not respond" },
  ]);
  // 사람용 요약은 "판정 끝에 유지됨"과 "아무도 판정하지 않아 유지됨"을 구분해서 센다
  expect(result.summary).toContain("Disputes: 0 upheld, 0 withdrawn, 2 unruled.");
  // fail closed: silence does not withdraw a finding
  const cf = result.verdicts.find((v) => v.role === "correctness");
  expect(cf.verdict).toBe("reject");
  expect(cf.must_fix.map((m) => m.id)).toEqual(["cf1", "cf2"]);
  expect(validate("review.v1", result).ok).toBe(true);
});

test("factory-review.js: a partial ruling list upholds the ids it skipped and records the one it answered", async () => {
  const disputed = [
    { id: "sec1", status: "disputed", reason: "false positive" },
    { id: "sec2", status: "disputed", reason: "out of scope" },
  ];
  const roster = [{ name: "security", agentType: "reviewer-security", model: "opus", lessons: ".factory/lessons/reviewer-security.md" }, ...REVIEW_ROSTER];
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return reviewLoaderFix({ roster, disputed, must_fix: [finding("sec1"), finding("sec2")] });
    const label = opts.label;
    if (label.startsWith("dispute:")) return { rulings: [{ id: "sec1", ruling: "withdraw", reason: "fair — the call is unreachable" }] };
    if (label.startsWith("R1:")) return approveV(label.slice(3));
    if (label.startsWith("R2:")) return { verdict: "maintain", must_fix: [], should_fix: [], verified: [], on_others: [] };
    return null;
  };

  const { result } = await runWorkflow(FACTORY_REVIEW_WORKFLOW, {
    agent: stub,
    args: { issue: 42, context: ".factory/out/context.json", loaded: reviewLoaderFix({ roster, disputed, must_fix: [finding("sec1"), finding("sec2")] }) },
  });

  expect(result.disputes.map((d) => [d.id, d.ruling])).toEqual([["sec1", "withdraw"], ["sec2", "unruled"]]);
  expect(result.summary).toContain("Disputes: 0 upheld, 1 withdrawn, 1 unruled.");
  const sec = result.verdicts.find((v) => v.role === "security");
  expect(sec.verdict).toBe("reject");
  expect(sec.must_fix.map((m) => m.id)).toEqual(["sec2"]);
  expect(validate("review.v1", result).ok).toBe(true);
});

// --- Task 6: the blocks all four workflows share, and the maturity bound on done_when ---

const WORKFLOW_FILES = [FACTORY_TRIAGE_WORKFLOW, FACTORY_PLAN_WORKFLOW, FACTORY_IMPLEMENT_WORKFLOW, FACTORY_REVIEW_WORKFLOW];
const blockOf = (src, re, what) => {
  const m = re.exec(src);
  expect(m, what).not.toBeNull();
  return m[0];
};

/**
 * 감사 M5 — 로더는 없어졌지만 **네 워크플로가 같은 한 블록을 공유한다**는 성질은 그대로 지킨다.
 * 이제 공유되는 것은 스키마 리터럴이 아니라 "문맥은 어디서 오는가"의 한 줄과 `once()`다: 한 파일에서만
 * 출처를 바꾸면 그 스테이지만 다른 문맥을 받고, 그 차이는 실행 중에야 드러난다.
 */
test("the four workflows take the context payload from args.loaded — one shared line, no loader agent anywhere", () => {
  const srcs = WORKFLOW_FILES.map((f) => readFileSync(f, "utf8"));
  const loads = srcs.map((s) => blockOf(s, /phase\('Load'\);\n\n\/\/ 감사 M5[\s\S]*?\nconst loaded = args\.loaded \?\? null;\n/, "Load"));
  const onces = srcs.map((s) => blockOf(s, /function once\(fn\) \{[\s\S]*?\n\}/, "once"));

  for (const [what, set] of [["Load", loads], ["once", onces]]) {
    for (let i = 1; i < set.length; i += 1) expect(set[i], `${what} in ${WORKFLOW_FILES[i]}`).toBe(set[0]);
  }
  // 로더 에이전트를 띄우는 줄이 한 파일에도 남아 있으면 안 된다 — 그것이 M5가 없앤 스테이지당 LLM 호출이다.
  for (let i = 0; i < srcs.length; i += 1) {
    expect(srcs[i].includes("agentType: 'factory-loader'"), WORKFLOW_FILES[i]).toBe(false);
    expect(srcs[i].includes("const LOADER"), WORKFLOW_FILES[i]).toBe(false);
    expect(srcs[i].includes("loaderPrompt"), WORKFLOW_FILES[i]).toBe(false);
  }
});

test("once(): an agent that throws is re-spawned exactly once, and the second answer stands", async () => {
  let attempts = 0;
  const stub = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("subagent died mid-turn");
    return { disposition: "ready", tier: "standard", reason: "done_when is concrete", summary: "add CSV export" };
  };

  const loaded = { issue: 7, stage: "triage", tier: "standard", roster: [{ name: "triage", agentType: "factory-triage", model: "sonnet" }], orchestration: "workflow" };
  const { result, calls } = await runWorkflow(FACTORY_TRIAGE_WORKFLOW, { agent: stub, args: { issue: 7, context: ".factory/out/context.json", loaded } });
  expect(calls.filter((c) => c.opts.agentType === "factory-triage")).toHaveLength(2);
  expect(result.disposition).toBe("ready");
  expect(validate("triage.v1", result).ok).toBe(true);
});

test("a missing args.loaded fails every stage closed — no role runs, and the error names what was missing", async () => {
  for (const file of WORKFLOW_FILES) {
    const stub = async () => null;
    const { result, calls, phases } = await runWorkflow(file, { agent: stub, args: { issue: 5, context: ".factory/out/context.json" } });
    expect(calls, file).toEqual([]);
    expect(phases, file).toEqual(["Load"]);
    expect(result, file).toEqual({ issue: 5, error: "context payload missing", orchestration: "workflow", guarantee: "structural" });
  }
});

const planLevelArgs = (maturity, extra = {}) => ({ issue: 42, context: ".factory/out/context.json", loaded: planLoaderFix({ maturity, ...extra }) });
const planLevelStub = (maturity, doneWhen, extra = {}) => async (prompt, opts) => {
  if (opts.label?.startsWith("R1:")) return posFix(roleOf(opts));
  if (opts.label?.startsWith("R2:")) return xexFix(roleOf(opts));
  if (opts.agentType === "plan-synthesizer") return planFix({ done_when: doneWhen });
  if (opts.label?.startsWith("sign:")) return { vote: "accept", reason: "fine" };
  return null;
};

test("factory-plan.js: a done_when level beyond the harness maturity is downgraded, and the downgrade is logged as workflow dissent", async () => {
  const doneWhen = [
    { id: "dw1", text: "CSV export writes a header row", verify: "test_42_header", level: "unit" },
    { id: "dw2", text: "the export page downloads a file", verify: "test_42_download", level: "e2e" },
    { id: "dw3", text: "the API returns 200", verify: "test_42_api", level: "integration" },
  ];
  const { result } = await runWorkflow(FACTORY_PLAN_WORKFLOW, {
    agent: planLevelStub("M0", doneWhen),
    args: planLevelArgs("M0"),
  });

  expect(result.done_when.map((w) => [w.id, w.level])).toEqual([["dw1", "unit"], ["dw2", "unit"], ["dw3", "unit"]]);
  expect(result.dissent_log).toEqual([
    { role: "workflow", objection: "done_when dw2 level e2e exceeds maturity M0", resolution: "downgraded to unit" },
    { role: "workflow", objection: "done_when dw3 level integration exceeds maturity M0", resolution: "downgraded to unit" },
  ]);
  expect(validate("plan.v1", result).ok).toBe(true);
});

test("factory-plan.js: M1 allows integration and downgrades only e2e; M2 leaves every level alone", async () => {
  const doneWhen = [
    { id: "dw1", text: "a", verify: "test_42_a", level: "integration" },
    { id: "dw2", text: "b", verify: "test_42_b", level: "e2e" },
  ];
  const m1 = await runWorkflow(FACTORY_PLAN_WORKFLOW, { agent: planLevelStub("M1", doneWhen), args: planLevelArgs("M1") });
  expect(m1.result.done_when.map((w) => w.level)).toEqual(["integration", "integration"]);
  expect(m1.result.dissent_log).toEqual([{ role: "workflow", objection: "done_when dw2 level e2e exceeds maturity M1", resolution: "downgraded to integration" }]);

  const m2 = await runWorkflow(FACTORY_PLAN_WORKFLOW, { agent: planLevelStub("M2", doneWhen), args: planLevelArgs("M2") });
  expect(m2.result.done_when.map((w) => w.level)).toEqual(["integration", "e2e"]);
  expect(m2.result.dissent_log).toEqual([]);
});

test("factory-plan.js: the filter only ever downgrades — an unrecognized or missing level is left exactly as it came", async () => {
  const doneWhen = [
    { id: "dw1", text: "a", verify: "test_42_a" },                    // level 누락
    { id: "dw2", text: "b", verify: "test_42_b", level: "smoke" },    // 스키마에 없는 레벨
    { id: "dw3", text: "c", verify: "test_42_c", level: "e2e" },
  ];
  // M2: 아무것도 낮출 것이 없다 — 빈 칸과 오타를 e2e로 "채워 넣지" 않는다(스키마 위반은 plan.v1 검사의 몫)
  const m2 = await runWorkflow(FACTORY_PLAN_WORKFLOW, { agent: planLevelStub("M2", doneWhen), args: planLevelArgs("M2") });
  expect(m2.result.done_when).toEqual(doneWhen);
  expect(m2.result.dissent_log).toEqual([]);

  // M1: 알려진 레벨 중 한도를 넘는 e2e만 내려가고, 나머지 둘은 그대로다
  const m1 = await runWorkflow(FACTORY_PLAN_WORKFLOW, { agent: planLevelStub("M1", doneWhen), args: planLevelArgs("M1") });
  expect(m1.result.done_when).toEqual([doneWhen[0], doneWhen[1], { ...doneWhen[2], level: "integration" }]);
  expect(m1.result.dissent_log).toEqual([{ role: "workflow", objection: "done_when dw3 level e2e exceeds maturity M1", resolution: "downgraded to integration" }]);
});

test("factory-plan.js: a context payload with no maturity leaves the levels alone — the workflow does not invent a bound", async () => {
  const doneWhen = [{ id: "dw1", text: "a", verify: "test_42_a", level: "e2e" }];
  const { result } = await runWorkflow(FACTORY_PLAN_WORKFLOW, { agent: planLevelStub(undefined, doneWhen), args: planLevelArgs(undefined) });
  expect(result.done_when.map((w) => w.level)).toEqual(["e2e"]);
  expect(result.dissent_log).toEqual([]);
});

test("factory-plan.js: the re-synthesized plan is bound too — an objection round cannot smuggle a level back in", async () => {
  const overLevel = [{ id: "dw1", text: "a", verify: "test_42_a", level: "e2e" }];
  let synthesis = 0;
  let signOff = 0;
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return planLoaderFix({ maturity: "M0" });
    if (opts.label?.startsWith("R1:")) return posFix(roleOf(opts));
    if (opts.label?.startsWith("R2:")) return xexFix(roleOf(opts));
    if (opts.agentType === "plan-synthesizer") {
      synthesis += 1;
      // 1차는 규칙을 지키고, 재합성이 e2e를 다시 밀어 넣는다
      return planFix({ done_when: synthesis === 1 ? [{ id: "dw1", text: "a", verify: "test_42_a", level: "unit" }] : overLevel });
    }
    if (opts.label?.startsWith("sign:")) {
      signOff += 1;
      return signOff <= PLAN_ROSTER.length && roleOf(opts) === "skeptic" ? { vote: "object", reason: "범위가 넓다" } : { vote: "accept", reason: "ok" };
    }
    return null;
  };

  const { result } = await runWorkflow(FACTORY_PLAN_WORKFLOW, { agent: stub, args: { issue: 42, context: "c", loaded: planLoaderFix({ maturity: "M0" }) } });
  expect(synthesis).toBe(2);
  expect(result.done_when.map((w) => w.level)).toEqual(["unit"]);
  expect(result.dissent_log).toContainEqual({ role: "workflow", objection: "done_when dw1 level e2e exceeds maturity M0", resolution: "downgraded to unit" });
});

test("factory-plan.js: a workflow downgrade the re-synthesis echoes back is superseded, not duplicated", async () => {
  const overLevel = [{ id: "dw1", text: "a", verify: "test_42_a", level: "e2e" }];
  const note = { role: "workflow", objection: "done_when dw1 level e2e exceeds maturity M0", resolution: "downgraded to unit" };
  let synthesis = 0;
  let signOff = 0;
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return planLoaderFix({ maturity: "M0" });
    if (opts.label?.startsWith("R1:")) return posFix(roleOf(opts));
    if (opts.label?.startsWith("R2:")) return xexFix(roleOf(opts));
    if (opts.agentType === "plan-synthesizer") {
      synthesis += 1;
      // 재합성은 같은 e2e 항목을 다시 올리면서, 1차에서 workflow가 남긴 dissent 줄까지 그대로 되받아 적는다
      return planFix({ done_when: overLevel, dissent_log: synthesis === 1 ? [] : [note] });
    }
    if (opts.label?.startsWith("sign:")) {
      signOff += 1;
      return signOff <= PLAN_ROSTER.length && roleOf(opts) === "skeptic" ? { vote: "object", reason: "범위가 넓다" } : { vote: "accept", reason: "ok" };
    }
    return null;
  };

  const { result } = await runWorkflow(FACTORY_PLAN_WORKFLOW, { agent: stub, args: { issue: 42, context: "c", loaded: planLoaderFix({ maturity: "M0" }) } });
  expect(synthesis).toBe(2);
  expect(result.done_when.map((w) => w.level)).toEqual(["unit"]);
  expect(result.dissent_log).toEqual([note]);   // 하나의 반박, 하나의 줄
});

test("factory-implement.js: PR bodies and rework comments go through --body-file, never an inline body", async () => {
  const stub = async (prompt, opts) => {
    if (opts.agentType === "factory-loader") return implLoaderFix({ must_fix: REWORK_MUST_FIX, pr: 31 });
    if (opts.agentType === "factory-builder") {
      return buildFix({ rework_response: { responses: REWORK_MUST_FIX.map((m) => ({ id: m.id, status: "fixed", commit: "8f2c1a9" })) } });
    }
    return verdictFix();
  };
  const { calls } = await runWorkflow(FACTORY_IMPLEMENT_WORKFLOW, { agent: stub, args: { issue: 42, context: ".factory/out/context.json", loaded: implLoaderFix({ must_fix: REWORK_MUST_FIX, pr: 31 }) } });
  const build = byType(calls, "factory-builder")[0].prompt;

  expect(build).toContain("--body-file");
  expect(build).toContain("gh pr create --draft");
  expect(build).toContain("gh pr comment 31 --body-file");
  // 훅은 명령 문자열 전체를 읽는다 — 본문을 인라인으로 넘기면 `>`로 시작하는 줄 하나가 명령을 통째로 막는다
  expect(build).toMatch(/Write tool/);
  expect(build).toMatch(/NEVER pass a body inline/);
});

// ── Plan 4 Task 5: factory-retro.js — 단일 analyst, loader 없음(P4-R6) ─────────────────────────
const FACTORY_RETRO_WORKFLOW = new URL("../../templates/factory/claude/workflows/factory-retro.js", import.meta.url).pathname;

const retroFix = (over = {}) => ({
  period: { from: "2026-09-01T00:00:00Z", to: "2026-09-07T00:00:00Z" },
  lessons: [{ role: "reviewer-correctness", text: "타임스탬프를 비교하기 전에 양쪽이 UTC인지 확인한다", evidence_runs: [110, 112] }],
  examples: [{ role: "reviewer-qa", kind: "good", text: "위치: …. 주장: …. 근거: …", evidence_runs: [104, 109] }],
  perspectives: [{ role: "reviewer-qa", text: "시계가 뒤로 가는 사람의 눈", evidence_runs: [104, 109] }],
  harness: [{ target: "M1", reason: "prisma/schema.prisma가 있는데 harness는 M0다" }],
  proposals: [{ kind: "gate", title: "no-multiple-resolved를 lint에 추가", body: "…", evidence_runs: [110, 112, 118] }],
  summary: "12건 머지, lesson 후보 1건 채택 제안",
  ...over,
});

const retroArgs = { candidates: ".factory/out/retro-candidates.json" };

test("factory-retro.js: meta.name equals the file's own basename and the only phase is Analyze", async () => {
  const src = readFileSync(FACTORY_RETRO_WORKFLOW, "utf8");
  const m = /^\s*name:\s*['"]([^'"]+)['"]/m.exec(src);
  expect(m[1]).toBe(basename(FACTORY_RETRO_WORKFLOW, ".js"));

  const { phases } = await runWorkflow(FACTORY_RETRO_WORKFLOW, { agent: async () => retroFix(), args: retroArgs });
  expect(phases).toEqual(["Analyze"]);
});

test("factory-retro.js: one analyst call (opus, schema retro.v1 literal) and the answer comes back as a valid retro.v1", async () => {
  const { result, calls } = await runWorkflow(FACTORY_RETRO_WORKFLOW, { agent: async () => retroFix(), args: retroArgs });

  expect(calls).toHaveLength(1);
  expect(calls[0].opts.agentType).toBe("factory-retro");
  expect(calls[0].opts.model).toBe("opus");
  expect(calls[0].opts.label).toBe("retro");
  // 스키마 리터럴은 lib/schemas.js의 `retro.v1`을 그대로 비춘다 — 한쪽만 넓어지면 L1의 validate가
  // 워크플로가 이미 받아들인 출력을 거절한다.
  const schema = calls[0].opts.schema;
  expect(schema.required).toEqual(["period", "lessons", "examples", "perspectives", "harness", "proposals", "summary"]);
  expect(schema.properties.period.required).toEqual(["from", "to"]);
  expect(schema.properties.lessons.items.required).toEqual(["role", "text", "evidence_runs"]);
  expect(schema.properties.examples.items.properties.kind.enum).toEqual(["good", "bad"]);
  expect(schema.properties.proposals.items.properties.kind.enum).toEqual(["gate", "threshold", "role-change", "role-new", "test-delete"]);
  for (const k of ["lessons", "examples", "perspectives", "proposals"]) {
    expect(schema.properties[k].items.properties.evidence_runs, k).toEqual({ type: "array", items: { type: "number" } });
  }
  expect(schema.properties.harness.items.required).toEqual(["target", "reason"]);

  expect(result.summary).toBe("12건 머지, lesson 후보 1건 채택 제안");
  expect(result.orchestration).toBe("workflow");
  expect(result.guarantee).toBe("structural");
  expect(validate("retro.v1", result).ok).toBe(true);
});

test("factory-retro.js: the analyst prompt names the candidates file the dispatcher passed and everything it must read", async () => {
  const { calls } = await runWorkflow(FACTORY_RETRO_WORKFLOW, {
    agent: async () => retroFix(),
    args: { candidates: ".factory/out/other-candidates.json" },
  });
  const p = calls[0].prompt;
  expect(p).toContain(".factory/out/other-candidates.json");
  expect(p).toContain("docs/factory/runs/");
  expect(p).toContain(".factory/lessons/");
  expect(p).toContain(".claude/agents/");
  expect(p).toContain("docs/factory/CHARTER.md");
  // 최소 근거 창과 채택 규칙(§8.4 / Global Constraints)은 프롬프트에 적혀 있어야 한다 — L1이 다시 세지만,
  // 에이전트가 규칙을 모르면 셀 수 없는 후보만 잔뜩 낸다.
  expect(p).toMatch(/2 distinct issues|≥2 distinct/);
  expect(p).toContain("evidence_runs");
  expect(p).toMatch(/20 runs/);
  expect(p).toMatch(/Examples 8|8\/8\/6/);
  expect(p).toMatch(/never invent|do not invent/i);
  // 성숙도 격차는 L1이 분석 **전에** 결정적으로 판정해 후보 파일에 실어 준다 — 에이전트는 그 목록에만
  // 이유 문장을 보탠다(없는 격차를 지어낼 자리가 없다).
  expect(p).toContain("maturity_gaps");
});

test("factory-retro.js: with no candidates arg the workflow falls back to the standard path, never to a guess", async () => {
  const { calls } = await runWorkflow(FACTORY_RETRO_WORKFLOW, { agent: async () => retroFix(), args: {} });
  expect(calls[0].prompt).toContain(".factory/out/retro-candidates.json");
});

test("factory-retro.js: an analyst that returns null is re-spawned exactly once, and the second answer stands", async () => {
  let attempts = 0;
  const { result, calls } = await runWorkflow(FACTORY_RETRO_WORKFLOW, {
    agent: async () => {
      attempts += 1;
      return attempts === 1 ? null : retroFix({ summary: "second pass" });
    },
    args: retroArgs,
  });
  expect(calls).toHaveLength(2);
  expect(result.summary).toBe("second pass");
  expect(validate("retro.v1", result).ok).toBe(true);
});

test("factory-retro.js: an analyst that throws once is re-spawned, and a throw twice fails closed with a named error", async () => {
  let attempts = 0;
  const { result: afterThrow, calls: throwCalls } = await runWorkflow(FACTORY_RETRO_WORKFLOW, {
    agent: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("subagent died mid-turn");
      return retroFix({ summary: "survived" });
    },
    args: retroArgs,
  });
  expect(throwCalls).toHaveLength(2);
  expect(afterThrow.summary).toBe("survived");

  const { result, calls } = await runWorkflow(FACTORY_RETRO_WORKFLOW, {
    agent: async () => { throw new Error("dead again"); },
    args: retroArgs,
  });
  expect(calls).toHaveLength(2);
  expect(result).toEqual({ error: "retro analyst returned nothing", orchestration: "workflow", guarantee: "structural" });
  // 빈 제안을 지어내지 않는다 — retro가 죽은 것과 "배울 게 없었다"는 서로 다른 사실이고, L1은 전자에서
  // `_retro.md`에 실패를 기록할 뿐 lessons PR을 열지 않는다.
  expect(validate("retro.v1", result).ok).toBe(false);
});

test("factory-retro.js: a null twice returns the same error object (no partial retro output leaks through)", async () => {
  const { result, calls } = await runWorkflow(FACTORY_RETRO_WORKFLOW, { agent: async () => null, args: retroArgs });
  expect(calls).toHaveLength(2);
  expect(result).toEqual({ error: "retro analyst returned nothing", orchestration: "workflow", guarantee: "structural" });
});

test("factory-retro.js: the analyst's own orchestration/guarantee claims are overwritten by the workflow", async () => {
  const { result } = await runWorkflow(FACTORY_RETRO_WORKFLOW, {
    agent: async () => retroFix({ orchestration: "agent", guarantee: "verified" }),
    args: retroArgs,
  });
  expect(result.orchestration).toBe("workflow");
  expect(result.guarantee).toBe("structural");
});

test("factory-retro.js: once() is byte-identical to the four stage workflows', and there is no loader in it", () => {
  const retro = readFileSync(FACTORY_RETRO_WORKFLOW, "utf8");
  expect(blockOf(retro, /function once\(fn\) \{[\s\S]*?\n\}/, "once")).toBe(
    blockOf(readFileSync(FACTORY_REVIEW_WORKFLOW, "utf8"), /function once\(fn\) \{[\s\S]*?\n\}/, "once"),
  );
  // P4-R6: retro는 로스터가 없다 — 로더를 부르면 읽을 context.json 자체가 없는 잡에서 없는 파일을 읽는다.
  expect(retro).not.toContain("factory-loader");
  expect(retro).not.toContain("context.json");
});
