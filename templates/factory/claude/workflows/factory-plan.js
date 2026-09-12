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
    maturity: { type: 'string' },
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
    let first = null;
    try {
      first = await fn();
    } catch {
      // 죽은 에이전트는 null을 돌려주기도 하고 그대로 throw하기도 한다 — 둘 다 "대답이 없다"이므로 보험은 둘 다에 건다.
      first = null;
    }
    if (first !== null && first !== undefined) return first;
    try {
      return await fn();
    } catch {
      // 두 번째도 실패하면 null로 접는다 — 각 workflow의 null 처리 경로(역할 제외·fail-closed)가 그 뒤를 받는다.
      return null;
    }
  };
}

// done_when의 `level`은 하네스 성숙도를 넘을 수 없다(§5.2.1). 프롬프트에도 규칙을 적지만 프롬프트는 부탁이고
// 이건 강제다: M0 저장소에 e2e done_when이 하나 섞이면 그 항목은 **영영 증명되지 않는다**(그 레벨의 게이트가
// 아예 돌지 않으므로) — "게이트 통과"와 "계약 확인"이 조용히 갈라진다.
// 넘는 항목은 버리지 않는다(사람이 원한 것은 그 항목이지 그 레벨이 아니다): 허용된 최고 레벨로 낮추고,
// 낮췄다는 사실을 dissent_log에 남겨 다음 성숙도에서 되돌릴 수 있게 한다.
const LEVELS = ['unit', 'integration', 'e2e'];
const ALLOWED_LEVELS = { M0: ['unit'], M1: ['unit', 'integration'], M2: ['unit', 'integration', 'e2e'] };

function boundToMaturity(p) {
  const allowed = ALLOWED_LEVELS[maturity];
  // 로더가 maturity를 못 읽었으면 workflow가 대신 지어내지 않는다 — 모르는 상태로 전부 unit으로 깎으면
  // 하네스가 실제로 M2인 저장소의 계약을 workflow가 임의로 좁히게 된다.
  if (!p || !allowed) return p;
  const highest = allowed[allowed.length - 1];
  const ceiling = LEVELS.indexOf(highest);
  const notes = [];
  const bounded = (Array.isArray(p.done_when) ? p.done_when : []).map((w) => {
    if (!w) return w;
    const at = LEVELS.indexOf(w.level);
    // 이 필터는 **낮추기만** 한다. 없는 레벨·오타 레벨(at === -1)은 그대로 둔다 — 빈 칸을 채우는 것은
    // 필터가 아니라 발명이고, 그렇게 채워 넣은 값은 "합의된 계약"처럼 보이면서 아무도 고르지 않은 값이다.
    // 스키마 위반(레벨 누락/오타)은 DONE_WHEN_ITEM의 enum과 verify-stage의 plan.v1 검사가 잡는 몫이다.
    if (at === -1 || at <= ceiling) return w;
    notes.push({
      role: 'workflow',
      objection: `done_when ${w.id} level ${w.level} exceeds maturity ${maturity}`,
      resolution: `downgraded to ${highest}`,
    });
    return { ...w, level: highest };
  });
  if (notes.length === 0) return p;
  // 재합성이 같은 항목을 다시 올려 보내면 같은 objection이 두 줄이 된다 — 사인오프 블록과 같은 방식으로
  // 앞선 동일 항목을 대체한다(하나의 반박, 하나의 줄, 마지막 처리 결과).
  const log = Array.isArray(p.dissent_log) ? p.dissent_log : [];
  const superseded = log.filter((d) => !notes.some((n) => d && d.role === n.role && d.objection === n.objection));
  return { ...p, done_when: bounded, dissent_log: [...superseded, ...notes] };
}

phase('Load');

const loaderPrompt =
  `Read \`${args.context}\`. Return exactly: issue=issue.number, stage, tier, ` +
  `roster = for each name in roster: {name, agentType: basename of role_agents[name] without .md, ` +
  `model: from \`.factory/roles.toml\` [<stage-section>.<name>].model (read the file), lessons: lessons[name]}, ` +
  `rounds, limits, spec_path, maturity = harness.maturity, orchestration; ` +
  `pr/head_sha from handoffs.implement if present; ` +
  `must_fix = union of handoffs.review.verdicts[].must_fix when handoffs.review.decision === "rework"; ` +
  `disputed = entries of the latest factory.rework-response.v1 PR comment with status disputed ` +
  `(read via \`gh pr view <pr> --comments\` only if pr exists). Do not invent roles. ` +
  `Note: for stage "triage" the roster in context.json is intentionally empty (triage is a single named ` +
  `role, not a debate roster) — in that case return roster: [{name: "triage", agentType: "factory-triage", ` +
  `model: <.factory/roles.toml [triage].model>}].`;

const loaded = await once(() => agent(loaderPrompt, { agentType: 'factory-loader', model: 'sonnet', schema: LOADER }))();

const issue = Number(args.issue);

// Fail-closed on a dead loader (same in all four workflows): without the loader there is no roster, so
// the debate would be a silent no-op returning an empty plan. A named error is what the human reads in
// the run record; an empty plan just fails the schema with nothing to act on.
if (!loaded) {
  return {
    issue,
    error: 'loader returned nothing',
    orchestration: 'workflow',
    guarantee: 'structural',
  };
}

// Fail-closed issue-provenance check (same pattern as factory-triage.js): a stale
// `.factory/out/context.json` or a wrong --context path must never let four debaters plan the wrong
// issue. Returning no done_when/tier here makes verify-stage's `plan.v1` check fail into needs-human.
if (Number(loaded.issue) !== issue) {
  return {
    issue,
    error: `context issue mismatch: loader saw ${loaded.issue}, dispatcher asked for ${args.issue}`,
    orchestration: 'workflow',
    guarantee: 'structural',
  };
}

const roster = Array.isArray(loaded.roster) ? loaded.roster.filter((r) => r && r.name && r.agentType) : [];
const rosterNames = roster.map((r) => r.name);
const tier = loaded.tier;
const maturity = loaded.maturity;
// CHARTER plan_rounds, via the loader: docs tier debates in 2 rounds (positions → synthesis), every
// other tier in 3 (positions → cross-examination → synthesis). Sign-off is not a round.
const rounds = Number(loaded.rounds) || 3;

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
  ? boundToMaturity(await once(() => agent(
      `${synthesisReading}\n\n` +
      `Issue #${issue} (tier ${tier}). Round 1 positions:\n${JSON.stringify(r1, null, 2)}\n\n` +
      `Round 2 cross-examination:\n${JSON.stringify(r2, null, 2)}\n\n` +
      `Produce the single plan the builder will work from. done_when is the contract — each item ` +
      `verifiable by a named test. files_expected starts from what the positions agree on. non_goals ` +
      `names what this issue will not do, so review cannot widen it later. Every objection from round 2 ` +
      `that you did not resolve goes into dissent_log verbatim with the role that raised it — deleting an ` +
      `objection is forging consensus, not reaching it.`,
      { agentType: 'plan-synthesizer', model: 'opus', schema: PLAN_V1 },
    ))())
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
    // The synthesizer may already have logged this same objection with its own override reason at
    // re-synthesis; the surviving vote supersedes that, so the earlier entry is replaced rather than
    // duplicated (one objection, one line, the final resolution).
    if (attempt === 1) {
      const log = Array.isArray(plan.dissent_log) ? plan.dissent_log : [];
      const superseded = log.filter((d) => !objections.some((o) => d && d.role === o.role && d.objection === o.reason));
      plan = {
        ...plan,
        dissent_log: [
          ...superseded,
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
    if (revised) plan = boundToMaturity(revised);
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
