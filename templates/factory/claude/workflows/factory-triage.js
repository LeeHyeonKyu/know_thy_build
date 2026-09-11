export const meta = {
  name: 'factory-triage',
  description: 'Load roster/context via factory-loader, then run the factory-triage role to judge readiness and tier',
  phases: [{ title: 'Load' }, { title: 'Triage' }],
};

// LOADER schema — every workflow shares this exact literal (Plan 3 Global Constraints).
const LOADER = {
  type: 'object',
  required: ['issue', 'stage', 'tier', 'roster', 'orchestration'],
  properties: {
    issue: { type: 'number' },
    stage: { type: 'string' },
    tier: { type: 'string' },
    roster: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'agentType', 'model'],
        properties: {
          name: { type: 'string' },
          agentType: { type: 'string' },
          model: { type: 'string' },
          lessons: { type: 'string' },
        },
      },
    },
    rounds: { type: 'number' },
    limits: { type: 'object' },
    spec_path: { type: 'string' },
    pr: { type: 'number' },
    head_sha: { type: 'string' },
    must_fix: { type: 'array', items: { type: 'object' } },
    disputed: { type: 'array', items: { type: 'object' } },
    orchestration: { type: 'string' },
  },
};

const TRIAGE = {
  type: 'object',
  required: ['disposition'],
  properties: {
    disposition: { type: 'string', enum: ['ready', 'needs-info', 'wont-do'] },
    tier: { type: 'string', enum: ['docs', 'standard', 'load-bearing'] },
    questions: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
    summary: { type: 'string' },
  },
};

// Insurance re-spawn (ADR-003): if an agent dies/skips and returns null/undefined, try exactly once more.
// A second null is left as null — the caller (verify-stage) treats a missing role as needs-human.
function once(fn) {
  return async () => {
    const first = await fn();
    if (first !== null && first !== undefined) return first;
    return await fn();
  };
}

phase('Load');

const loaderPrompt =
  `Read \`${args.context}\`. Return exactly: issue=issue.number, stage, tier, ` +
  `roster = for each name in roster: {name, agentType: basename of role_agents[name] without .md, ` +
  `model: from \`.factory/roles.toml\` [<stage-section>.<name>].model (read the file), lessons: lessons[name]}, ` +
  `rounds, limits, spec_path, orchestration; pr/head_sha from handoffs.implement if present; ` +
  `must_fix = union of handoffs.review.verdicts[].must_fix when handoffs.review.decision === "rework"; ` +
  `disputed = entries of the latest factory.rework-response.v1 PR comment with status disputed ` +
  `(read via \`gh pr view <pr> --comments\` only if pr exists). Do not invent roles. ` +
  `Note: for stage "triage" the roster in context.json is intentionally empty (triage is a single named ` +
  `role, not a debate roster) — in that case return roster: [{name: "triage", agentType: "factory-triage", ` +
  `model: <.factory/roles.toml [triage].model>}].`;

const loaded = await once(() => agent(loaderPrompt, { agentType: 'factory-loader', model: 'sonnet', schema: LOADER }))();

phase('Triage');

const issue = Number(args.issue);

// Fail-closed issue-provenance check — copy this pattern into factory-plan.js/factory-implement.js/
// factory-review.js's own Load→<stage> transitions (Tasks 3-5). The loader is only trustworthy if the
// context.json it read actually belongs to the issue the dispatcher was asked to run: a stale
// `.factory/out/context.json` from a previous run, or a wrong --context path, must never let a role act
// on the wrong issue silently. Returning no `disposition` here makes verify-stage's `triage.v1` schema
// check fail the stage into needs-human instead.
if (loaded && Number(loaded.issue) !== issue) {
  return {
    issue,
    error: `context issue mismatch: loader saw ${loaded.issue}, dispatcher asked for ${args.issue}`,
    orchestration: 'workflow',
    guarantee: 'structural',
  };
}

const roster = (loaded && Array.isArray(loaded.roster)) ? loaded.roster : [];
const role = roster.find((r) => r && r.name === 'triage');

let verdict = null;
if (role) {
  const triagePrompt =
    `Read \`${args.context}\`, your lessons file at \`${role.lessons || '.factory/lessons/factory-triage.md'}\`, ` +
    `\`docs/factory/CHARTER.md\` (sections NEVER_AUTOMATE and Tiers), the spec named by context.spec_path if present, ` +
    `and \`.factory/harness.toml\` [load_bearing]. Judge whether issue #${issue} is something the factory can build ` +
    `and, if so, its tier — per your Lens (a NEVER_AUTOMATE match -> wont-do; done_when not yet writable concretely ` +
    `-> needs-info with <=3 questions; predicted diff paths under docs/** only -> tier docs; touches ` +
    `[load_bearing].paths -> tier load-bearing; otherwise -> tier standard; a bug report with no repro steps -> ` +
    `needs-info). Return exactly the factory.triage.v1 fields: disposition, tier (required when ready), ` +
    `questions (required when needs-info), reason, summary.`;

  verdict = await once(() => agent(triagePrompt, { agentType: role.agentType, model: role.model, schema: TRIAGE }))();
}

return { ...(verdict || {}), issue, orchestration: 'workflow', guarantee: 'structural' };
