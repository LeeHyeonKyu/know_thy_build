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

// The acceptance contract's check (Task 1 / Structure A): how a done_when is verified.
// kind:"test" → ref is a test name Task 3 runs; "gate" → a gate name; "finish" → graded by the qa
// manifest; "rubric" → reviewer-judged only, no self-runnable check.
const CHECK = {
  type: 'object',
  required: ['kind', 'ref'],
  properties: {
    kind: { type: 'string', enum: ['test', 'gate', 'finish', 'rubric'] },
    ref: { type: 'string' },
  },
};

// R1 proposals stay loose — a role proposes what should be proved; the final contract is the
// synthesizer's job (CONTRACT_ITEM below). `verify` is the legacy spelling of check{kind:"test"}.
const DONE_WHEN_ITEM = {
  type: 'object',
  required: ['id', 'text', 'level'],
  properties: {
    id: { type: 'string' },
    text: { type: 'string' },
    verify: { type: 'string' },
    check: CHECK,
    rubric: { type: 'string' },
    level: { type: 'string', enum: ['unit', 'integration', 'e2e'] },
  },
};

// The final plan's done_when — the acceptance contract, one artifact three stages consume (Task 1).
// Every item carries how it is checked (`check`) and the one-line bar a reviewer applies (`rubric`).
const CONTRACT_ITEM = {
  type: 'object',
  required: ['id', 'text', 'level', 'check', 'rubric'],
  properties: {
    id: { type: 'string' },
    text: { type: 'string' },
    verify: { type: 'string' },
    check: CHECK,
    rubric: { type: 'string' },
    level: { type: 'string', enum: ['unit', 'integration', 'e2e'] },
    covers: { type: 'array', items: { type: 'string' } },
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
    done_when: { type: 'array', items: CONTRACT_ITEM },
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

// Single mode (audit Task 9) — the skeptic's one pass. It may only ADD: risks it wants on the record,
// done_when items that turn those risks into gates, and dissent entries for what it could not resolve.
// There is no field for removing or rewriting the planner's items, by construction.
const SKEPTIC_ADD = {
  type: 'object',
  required: ['risks', 'done_when'],
  properties: {
    risks: { type: 'array', items: { type: 'string' } },
    done_when: { type: 'array', items: CONTRACT_ITEM },
    dissent: {
      type: 'array',
      items: {
        type: 'object',
        required: ['role', 'objection', 'resolution'],
        properties: {
          id: { type: 'string' },
          role: { type: 'string' },
          objection: { type: 'string' },
          resolution: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        },
      },
    },
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

// 감사 M5 (2026-09-14) — `factory-loader`는 사라졌다. 그 에이전트가 한 일은 `context.json`과
// `roles.toml`을 읽어 JSON을 JSON으로 옮겨 적는 것뿐이었는데, 그 한 번의 복사에 스테이지마다 sonnet
// 호출 하나가 들었고, 복사는 틀릴 수 있었다 — `model`은 이미 `factory/lib/context.js`가 `def.model`로
// 들고 있었다. 이제 그 파일이 같은 객체를 Node에서 결정적으로 만들어 `.factory/out/loaded.json`에 쓰고,
// 디스패처가 그것을 그대로 Workflow의 `args.loaded`로 넘긴다(워크플로 스크립트는 파일을 읽을 수 없다,
// §4.2.3). 역할 에이전트가 **스스로** 읽는 경로는 그대로 남는다 — 바뀐 것은 스크립트가 제 제어 흐름을
// 위해 쓰던 재료의 출처뿐이다.
const loaded = args.loaded ?? null;

const issue = Number(args.issue);

// Fail-closed on a dead loader (same in all four workflows): without the loader there is no roster, so
// the debate would be a silent no-op returning an empty plan. A named error is what the human reads in
// the run record; an empty plan just fails the schema with nothing to act on.
if (!loaded) {
  return {
    issue,
    error: 'context payload missing',
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
    error: `context issue mismatch: the context payload says ${loaded.issue}, dispatcher asked for ${args.issue}`,
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
// Audit Task 9: how this plan runs. `single` is one opus planner pass + one skeptic pass (2 calls);
// `debate` is the R1/R2/synthesis/sign-off room below. The CHARTER decides (`plan.mode` +
// `plan.debate_tiers`, default: single everywhere but `load-bearing`) and context.json carries the
// answer — the workflow never re-derives it from the tier. A context with no `plan` block is an
// un-upgraded mirror: fall back to `debate`, the behaviour that repo already had, rather than
// silently cutting a load-bearing plan down to one pass.
const mode = loaded.plan?.mode === 'single' ? 'single' : 'debate';
const maxDoneWhen = Number(loaded.plan?.max_done_when) || 6;

// The shared reading order. The workflow cannot read files — every role opens these itself.
const reading = (r) =>
  `Read \`${args.context}\` first (issue, tier, spec_path, roster, handoffs.triage, harness.maturity, limits), ` +
  `then the spec at its \`spec_path\` if one is named, \`docs/TECHNICAL.md\` (if present — it may not ` +
  `exist yet, and that is not a finding), and your lessons file at ` +
  `\`${r.lessons || `.factory/lessons/${r.agentType}.md`}\` (treat every entry as a checklist item). ` +
  `Cite concrete repository paths — a claim with no path is not evidence. ` +
  `Every done_when \`level\` must stay within \`harness.maturity\`: M0 → \`unit\` only, ` +
  `M1 → \`unit\` or \`integration\`, M2 → \`unit\`, \`integration\` or \`e2e\`. ` +
  `Answer with the English field names of your output schema.`;

// The contract both modes must satisfy, stated once. The validator in verify-stage enforces every
// line of it — a plan that breaks one is an invalid artifact, not a warning (audit Task 9).
const planRules =
  `Three rules bind the plan, and a script rejects the handoff that breaks one:\n` +
  `1. done_when has at most ${maxDoneWhen} items. Fewer is better — every item you invent is a new ` +
  `surface the reviewers will judge, and in the 2026-09-14 baseline a third of all must_fix items came ` +
  `from done_when the plan invented rather than from the issue.\n` +
  `2. Any risk you leave in dissent_log with severity medium or higher must be named by a done_when ` +
  `item's \`covers: [<dissent id>]\`. A risk you saw and left as prose is the single most expensive ` +
  `failure this factory has measured — recognition is not a contract.\n` +
  `3. done_when observes user-visible behaviour. It does not prescribe the shape of the test: no ` +
  `whitelists of paths or prefixes, no "must not appear anywhere", no required ordering of sections, ` +
  `no regex over the repository's files — unless the issue itself asks for a guard.\n` +
  `4. Every done_when carries how it is checked (\`check: {kind, ref}\` — kind is ` +
  `test|gate|finish|rubric; for a test, ref is its \`test_${issue}_<slug>\` id; "rubric" means no ` +
  `self-runnable check, reviewer-judged only) and the one-line bar a reviewer applies (\`rubric\`). ` +
  `An item with neither a check nor a rubric is rejected as an incomplete acceptance contract.`;

// Task 9 (Structure H, KTB-51) — the one-shot repair turn. When the deterministic validator rejected
// the previous handoff, run-stage re-dispatches this workflow once with `loaded.plan_repair` set to
// the exact reasons. The planner fixes precisely those (not a fresh re-plan) — this is the single
// feedback turn the plan stage gets before a handoff that is still red escalates to a human.
const planRepair = Array.isArray(loaded.plan_repair) ? loaded.plan_repair.filter((r) => typeof r === 'string' && r.trim()) : [];
const repairDirective = planRepair.length
  ? `\n\nREPAIR TURN (KTB-51): your previous plan handoff was rejected by the deterministic validator ` +
    `for exactly these reasons:\n${planRepair.map((r) => `  - ${r}`).join('\n')}\n` +
    `Fix precisely these and keep everything the validator did not object to. This is the one repair ` +
    `turn — a handoff that still breaks a rule goes to a human.`
  : '';

if (mode === 'single') {
  // One opus planner writes the whole plan; one skeptic gets one pass at it. No cross-examination,
  // no synthesizer, no sign-off round — the planner's own output, plus whatever the skeptic could
  // ADD to it, is the final plan. The phases below stay declared so `meta` is one shape for both modes.
  const planner = roster.find((r) => r.name === 'synthesizer') || roster[0];
  const sk = roster.find((r) => r !== planner && r.name === 'skeptic') || roster.find((r) => r !== planner) || null;

  phase('Positions');

  let plan = planner
    ? boundToMaturity(await once(() => agent(
        `${reading(planner)}\n\n` +
        `Issue #${issue} (tier ${tier}). Write the plan the builder will work from — the whole plan, ` +
        `in one pass. done_when is the acceptance contract: each item carries a \`check\` (how it is ` +
        `verified — \`{kind, ref}\`, usually \`{kind:"test", ref:"test_${issue}_<slug>"}\`) and a ` +
        `\`rubric\` (the one-line bar a reviewer applies). files_expected is the repository paths the change honestly needs and no ` +
        `more. non_goals names what this issue will not do, so review cannot widen it later. ` +
        `open_risks is what you saw and are not gating on; dissent_log is where a risk you are ` +
        `knowingly not resolving goes, each entry with an \`id\`, the \`role\` that would raise it and ` +
        `a \`severity\`.\n\n${planRules}${repairDirective}`,
        { agentType: planner.agentType, model: planner.model, label: `plan:${planner.name}`, schema: PLAN_V1 },
      ))())
    : null;

  phase('Cross-examination');

  // The skeptic's schema has no field for deleting or rewriting — it can only add. That is the
  // property that makes a second pass cheap: there is no negotiation to converge, so there is no R2.
  let added = null;
  if (plan && sk) {
    const add = await once(() => agent(
      `${reading(sk)}\n\n` +
      `Issue #${issue} (tier ${tier}). The plan, in full:\n${JSON.stringify(plan, null, 2)}\n\n` +
      `Attack it once. You cannot rewrite or delete anything in it — you can only add. Return: ` +
      `risks (what this plan does not see, one line each), done_when (ONLY items that turn a risk you ` +
      `just named into a gate — give each a fresh id not already in the plan, a \`check\` ({kind, ref}) ` +
      `and a \`rubric\`, and \`covers\` naming the ` +
      `dissent ids it answers), and dissent (risks you could not turn into a gate, each with an id, ` +
      `severity and the reason it stays open). The plan already has ${(plan.done_when || []).length} ` +
      `done_when items and the ceiling is ${maxDoneWhen} — if you have nothing that clears that bar, ` +
      `return empty arrays. An added item that merely restates one already in the plan is worse than ` +
      `no item at all.\n\n${planRules}`,
      { agentType: sk.agentType, model: sk.model, label: `skeptic:${sk.name}`, schema: SKEPTIC_ADD },
    ))();

    phase('Synthesis');

    if (add) {
      const dwIds = new Set((plan.done_when || []).map((d) => d && d.id));
      const newDw = (Array.isArray(add.done_when) ? add.done_when : []).filter((d) => d && !dwIds.has(d.id));
      const risks = Array.isArray(plan.open_risks) ? [...plan.open_risks] : [];
      const newRisks = (Array.isArray(add.risks) ? add.risks : []).filter((r) => r && !risks.includes(r));
      const newDissent = (Array.isArray(add.dissent) ? add.dissent : []).filter(Boolean);
      added = { done_when: newDw.length, risks: newRisks.length, dissent: newDissent.length };
      plan = boundToMaturity({
        ...plan,
        done_when: [...(plan.done_when || []), ...newDw],
        open_risks: [...risks, ...newRisks],
        dissent_log: [...(Array.isArray(plan.dissent_log) ? plan.dissent_log : []), ...newDissent],
      });
    }
  } else {
    phase('Synthesis');
  }

  phase('Sign-off');

  return {
    ...(plan || {}),
    issue,
    tier,
    roles: rosterNames,
    rounds,
    orchestration: 'workflow',
    guarantee: 'structural',
    // Same digest slot as the debate, different shape: there was no room, so there is nothing to
    // summarise except who wrote the plan and how much the one challenge actually added.
    debate: { mode: 'single', planner: planner ? planner.name : null, skeptic: sk ? sk.name : null, skeptic_added: added },
  };
}

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
  `then the spec at its \`spec_path\` if one is named, \`docs/TECHNICAL.md\` (if present — it may not ` +
  `exist yet, and that is not a finding), and your lessons file at ` +
  `\`.factory/lessons/plan-synthesizer.md\` (treat every entry as a checklist item). ` +
  `Cite concrete repository paths. Every done_when needs a \`check\` ({kind, ref} — for a test, ` +
  `ref is a test id of the form test_${issue}_<slug>), a \`rubric\` (the one-line reviewer bar), and a ` +
  `\`level\` within \`harness.maturity\`: M0 → \`unit\` only, ` +
  `M1 → \`unit\` or \`integration\`, M2 → \`unit\`, \`integration\` or \`e2e\`. ` +
  `Answer with the English field names of your output schema.`;

let plan = r1.length > 0
  ? boundToMaturity(await once(() => agent(
      `${synthesisReading}\n\n` +
      `Issue #${issue} (tier ${tier}). Round 1 positions:\n${JSON.stringify(r1, null, 2)}\n\n` +
      `Round 2 cross-examination:\n${JSON.stringify(r2, null, 2)}\n\n` +
      `Produce the single plan the builder will work from. done_when is the acceptance contract — each ` +
      `item carries a \`check\` ({kind, ref} — how it is verified) and a \`rubric\` (the one-line bar a ` +
      `reviewer applies). files_expected starts from what the positions agree on. non_goals ` +
      `names what this issue will not do, so review cannot widen it later. Every objection from round 2 ` +
      `that you did not resolve goes into dissent_log verbatim with the role that raised it (with an ` +
      `\`id\` and a \`severity\`) — deleting an objection is forging consensus, not reaching it.\n\n` +
      `${planRules}${repairDirective}`,
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
  // 토론 전문은 싣지 않는다(F7). 이 객체는 이슈 코멘트의 ```json 블록으로 그대로 나가고, 그 코멘트는 다음
  // 스테이지의 `context.json`에 다시 실린다 — R1 전문 4개 + R2 반박 전문까지 넣으면 handoff 하나가
  // 사람이 읽을 수 없는 크기가 되고, 그 비용을 implement·review가 매번 다시 치른다.
  // 남는 것: 누가 무엇을 주장했는지(한 줄), 반박이 몇 건이었는지, 서명 결과. 나머지는 dissent_log가 들고 있다.
  debate: {
    mode: 'debate',
    r1: r1.map(({ role, position }) => ({ role, position })),
    r2_objections: r2.reduce((n, x) => n + (Array.isArray(x.objections) ? x.objections.length : 0), 0),
    votes,
  },
};
