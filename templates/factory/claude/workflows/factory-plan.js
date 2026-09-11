export const meta = {
  name: 'factory-plan',
  description: 'Issue plan via a role debate: independent positions, cross-examination, synthesis, sign-off',
  phases: [
    { title: 'Load' },
    { title: 'Positions' },
    { title: 'Cross-examination' },
    { title: 'Synthesis' },
    { title: 'Sign-off' },
  ],
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

const DONE_WHEN_ITEM = {
  type: 'object',
  required: ['id', 'text', 'verify', 'level'],
  properties: {
    id: { type: 'string' },
    text: { type: 'string' },
    verify: { type: 'string' },
    level: { type: 'string', enum: ['unit', 'integration', 'e2e'] },
  },
};

// R1 — one role's independent position.
const POS = {
  type: 'object',
  required: ['position', 'risks', 'proposed_done_when', 'files_expected'],
  properties: {
    position: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    proposed_done_when: { type: 'array', items: DONE_WHEN_ITEM },
    files_expected: { type: 'array', items: { type: 'string' } },
  },
};

// R2 — cross-examination of everyone else's R1.
const XEX = {
  type: 'object',
  required: ['agreements', 'objections', 'concessions'],
  properties: {
    agreements: { type: 'array', items: { type: 'string' } },
    objections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['to', 'claim', 'evidence'],
        properties: { to: { type: 'string' }, claim: { type: 'string' }, evidence: { type: 'string' } },
      },
    },
    concessions: { type: 'array', items: { type: 'string' } },
  },
};

// R3 — the synthesized plan. Must satisfy factory.plan.v1 (plus `summary` for the human handoff body).
const PLAN_V1 = {
  type: 'object',
  required: ['summary', 'done_when', 'files_expected', 'dissent_log', 'non_goals', 'open_risks'],
  properties: {
    summary: { type: 'string' },
    done_when: { type: 'array', items: DONE_WHEN_ITEM },
    files_expected: { type: 'array', items: { type: 'string' } },
    dissent_log: {
      type: 'array',
      items: {
        type: 'object',
        required: ['role', 'objection', 'resolution'],
        properties: { role: { type: 'string' }, objection: { type: 'string' }, resolution: { type: 'string' } },
      },
    },
    non_goals: { type: 'array', items: { type: 'string' } },
    open_risks: { type: 'array', items: { type: 'string' } },
  },
};

// Sign-off.
const VOTE = {
  type: 'object',
  required: ['vote', 'reason'],
  properties: { vote: { type: 'string', enum: ['accept', 'object'] }, reason: { type: 'string' } },
};

// Insurance re-spawn (ADR-003): if an agent dies/skips and returns null/undefined, try exactly once more.
// A second null is left as null — the role is then dropped from the debate (never fabricated) and
// verify-stage's roster check turns the missing role into needs-human.
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

const issue = Number(args.issue);

// Fail-closed issue-provenance check (same pattern as factory-triage.js): a stale
// `.factory/out/context.json` or a wrong --context path must never let four debaters plan the wrong
// issue. Returning no done_when/tier here makes verify-stage's `plan.v1` check fail into needs-human.
if (loaded && Number(loaded.issue) !== issue) {
  return {
    issue,
    error: `context issue mismatch: loader saw ${loaded.issue}, dispatcher asked for ${args.issue}`,
    orchestration: 'workflow',
    guarantee: 'structural',
  };
}

const roster = (loaded && Array.isArray(loaded.roster)) ? loaded.roster.filter((r) => r && r.name && r.agentType) : [];
const rosterNames = roster.map((r) => r.name);
const tier = loaded ? loaded.tier : undefined;
// CHARTER plan_rounds, via the loader: docs tier debates in 2 rounds (positions → synthesis), every
// other tier in 3 (positions → cross-examination → synthesis). Sign-off is not a round.
const rounds = Number(loaded && loaded.rounds) || 3;

// The shared reading order. The workflow cannot read files — every role opens these itself.
const reading = (r) =>
  `Read \`${args.context}\` first (issue, tier, spec_path, roster, handoffs.triage, harness.maturity, limits), ` +
  `then the spec at its \`spec_path\` if one is named, \`docs/TECHNICAL.md\`, and your lessons file at ` +
  `\`${r.lessons || `.factory/lessons/${r.agentType}.md`}\` (treat every entry as a checklist item). ` +
  `Cite concrete repository paths — a claim with no path is not evidence. ` +
  `Every done_when \`level\` must stay within \`harness.maturity\`: M0 → \`unit\` only, ` +
  `M1 → \`unit\` or \`integration\`, M2 → \`unit\`, \`integration\` or \`e2e\`. ` +
  `Answer with the English field names of your output schema.`;

phase('Positions');

// R1 is independent by construction: no role's prompt contains any other role's position.
// (Showing them at once converges on whoever spoke first — the diversity is the point.)
const r1 = (await parallel(roster.map((r) => () =>
  once(() => agent(
    `${reading(r)}\n\n` +
    `Issue #${issue} (tier ${tier}). State your own position on what should be built and how it will be ` +
    `proved done, from your role's stance only. You are not being shown anyone else's position and must ` +
    `not look for one. Return: position (your recommendation and why), risks (what this issue puts at ` +
    `stake as you see it), proposed_done_when (each {id, text, verify: a test id of the form ` +
    `test_${issue}_<slug>, level}), files_expected (the repository paths you expect the change to touch, ` +
    `as few as the work honestly needs).`,
    { agentType: r.agentType, model: r.model, label: `R1:${r.name}`, schema: POS },
  ))().then((v) => (v ? { role: r.name, ...v } : null))
))).filter(Boolean);

// A role that never took a position does not cross-examine and does not sign off — the debate
// proceeds with the roles that actually spoke, and invents nothing for the one that did not.
const active = roster.filter((r) => r1.some((x) => x.role === r.name));

phase('Cross-examination');

const r2 = rounds >= 3 && r1.length > 0
  ? (await parallel(active.map((r) => () =>
      once(() => agent(
        `${reading(r)}\n\n` +
        `Issue #${issue} (tier ${tier}). Round 2 — cross-examination. The other roles' round-1 positions:\n` +
        `${JSON.stringify(r1.filter((x) => x.role !== r.name), null, 2)}\n\n` +
        `For each of them state agreements, objections and concessions. Every objection needs ` +
        `{to: the role name, claim, evidence} and the evidence must be a file path, a spec line or a ` +
        `CHARTER rule — "I disagree" is not an objection. A concession is a place where their position ` +
        `beat yours; name at least one if one exists.`,
        { agentType: r.agentType, model: r.model, label: `R2:${r.name}`, schema: XEX },
      ))().then((v) => (v ? { role: r.name, ...v } : null))
    ))).filter(Boolean)
  : [];

phase('Synthesis');

const synthesisReading =
  `Read \`${args.context}\` first (issue, tier, spec_path, handoffs.triage, harness.maturity, limits), ` +
  `then the spec at its \`spec_path\` if one is named, \`docs/TECHNICAL.md\`, and your lessons file at ` +
  `\`.factory/lessons/plan-synthesizer.md\` (treat every entry as a checklist item). ` +
  `Cite concrete repository paths. Every done_when needs a \`verify\` test id of the form ` +
  `test_${issue}_<slug> and a \`level\` within \`harness.maturity\`: M0 → \`unit\` only, ` +
  `M1 → \`unit\` or \`integration\`, M2 → \`unit\`, \`integration\` or \`e2e\`. ` +
  `Answer with the English field names of your output schema.`;

let plan = r1.length > 0
  ? await once(() => agent(
      `${synthesisReading}\n\n` +
      `Issue #${issue} (tier ${tier}). Round 1 positions:\n${JSON.stringify(r1, null, 2)}\n\n` +
      `Round 2 cross-examination:\n${JSON.stringify(r2, null, 2)}\n\n` +
      `Produce the single plan the builder will work from. done_when is the contract — each item ` +
      `verifiable by a named test. files_expected starts from what the positions agree on. non_goals ` +
      `names what this issue will not do, so review cannot widen it later. Every objection from round 2 ` +
      `that you did not resolve goes into dissent_log verbatim with the role that raised it — deleting an ` +
      `objection is forging consensus, not reaching it.`,
      { agentType: 'plan-synthesizer', model: 'opus', schema: PLAN_V1 },
    ))()
  : null;

phase('Sign-off');

let votes = [];
if (plan) {
  for (let attempt = 0; attempt < 2; attempt++) {
    votes = (await parallel(active.map((r) => () =>
      once(() => agent(
        `${reading(r)}\n\n` +
        `Issue #${issue} (tier ${tier}). The synthesized plan:\n${JSON.stringify(plan, null, 2)}\n\n` +
        `Sign off: accept, or object with a reason naming exactly what is wrong and what would fix it. ` +
        `Object only for something that would make the built change wrong or unverifiable from your ` +
        `stance — not for wording you would have chosen differently.`,
        { agentType: r.agentType, model: r.model, label: `sign:${r.name}`, schema: VOTE },
      ))().then((v) => (v ? { role: r.name, ...v } : null))
    ))).filter(Boolean);

    const objections = votes.filter((v) => v.vote === 'object');
    if (objections.length === 0) break;

    // Second failed sign-off: the disagreement is real. Record it and proceed — the plan handoff
    // carries the dissent to the human rather than pretending the room agreed.
    if (attempt === 1) {
      const log = Array.isArray(plan.dissent_log) ? plan.dissent_log : [];
      plan = {
        ...plan,
        dissent_log: [
          ...log,
          ...objections.map((o) => ({ role: o.role, objection: o.reason, resolution: 'unresolved — proceeding' })),
        ],
      };
      break;
    }

    const revised = await once(() => agent(
      `${synthesisReading}\n\n` +
      `Issue #${issue} (tier ${tier}). The plan you produced:\n${JSON.stringify(plan, null, 2)}\n\n` +
      `Objections raised at sign-off:\n${JSON.stringify(objections, null, 2)}\n\n` +
      `Revise the plan to answer each objection, or — where you will not change the plan — keep the ` +
      `objection in dissent_log with the reason you are overriding it. This is your only revision.`,
      { agentType: 'plan-synthesizer', model: 'opus', schema: PLAN_V1 },
    ))();
    if (revised) plan = revised;
  }
}

return {
  ...(plan || {}),
  issue,
  tier,
  roles: rosterNames,
  rounds,
  orchestration: 'workflow',
  guarantee: 'structural',
  debate: { r1, r2, votes },
};
