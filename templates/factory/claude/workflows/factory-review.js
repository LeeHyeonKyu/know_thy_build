export const meta = {
  name: 'factory-review',
  description: 'Judge the PR with the review roster — independent cold R1, then a cross-examining R2, after ruling on anything the builder disputed',
  phases: [
    { title: 'Load' },
    { title: 'Disputes' },
    { title: 'R1' },
    { title: 'R2' },
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

// One reviewer's independent judgement (§7.3, `factory.verdict.v1` + the `role` that L1's roster check
// needs). `role` is asked for so the answer is self-describing in the log, but the workflow overwrites it
// with the roster name — a reviewer that misnames itself must not be able to fake a missing role.
const FINDING = {
  type: 'object',
  required: ['id', 'where', 'claim', 'evidence'],
  properties: {
    id: { type: 'string' },
    where: { type: 'string' },
    claim: { type: 'string' },
    evidence: { type: 'string' },
    repro: { type: 'string' },
  },
};

const VERDICT_V1 = {
  type: 'object',
  required: ['role', 'verdict', 'confidence', 'must_fix', 'should_fix', 'verified'],
  properties: {
    role: { type: 'string' },
    verdict: { type: 'string', enum: ['approve', 'reject'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    must_fix: { type: 'array', items: FINDING },
    should_fix: { type: 'array' },
    verified: { type: 'array', items: { type: 'string' } },
  },
};

// R2 · full exchange — every reviewer has read the others' R1 and either stands by its own or rewrites it.
const R2_FULL = {
  type: 'object',
  required: ['verdict', 'must_fix', 'should_fix', 'verified', 'on_others'],
  properties: {
    verdict: { type: 'string', enum: ['maintain', 'revise'] },
    must_fix: { type: 'array', items: FINDING },
    should_fix: { type: 'array' },
    verified: { type: 'array', items: { type: 'string' } },
    on_others: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'stance', 'reason'],
        properties: {
          id: { type: 'string' },
          stance: { type: 'string', enum: ['agree', 'disagree'] },
          reason: { type: 'string' },
        },
      },
    },
  },
};

// R2 · light — the unanimous-approve path. The only question is "did we all look away from the same thing".
const R2_LIGHT = {
  type: 'object',
  required: ['missed'],
  properties: {
    missed: {
      type: 'array',
      items: {
        type: 'object',
        required: ['what', 'why'],
        properties: { what: { type: 'string' }, why: { type: 'string' } },
      },
    },
  },
};

// The builder disputed a must_fix in its rework response (§7.5, P3-R4). Only the reviewer that raised the
// item rules on it: `withdraw` drops it, `uphold` keeps it — and uphold counts as a reject.
const DISPUTE = {
  type: 'object',
  required: ['rulings'],
  properties: {
    rulings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'ruling', 'reason'],
        properties: {
          id: { type: 'string' },
          ruling: { type: 'string', enum: ['withdraw', 'uphold'] },
          reason: { type: 'string' },
        },
      },
    },
  },
};

// Insurance re-spawn (ADR-003): if an agent dies/skips and returns null/undefined, try exactly once more.
// A second null is left as null — the role is then dropped (never fabricated) and the short `verdicts[]`
// makes aggregate-review.sh call the round `incomplete` → needs-human, naming the missing role.
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

// Fail-closed on a dead loader (same in all four workflows): without it we do not know the roster, the PR,
// or the head sha — and a review that invents its own roster is worse than no review, because the missing
// role would never show up in aggregate-review.sh's roster comparison. A named error beats a schema
// failure with no reason attached.
if (!loaded) {
  return {
    issue,
    error: 'loader returned nothing',
    orchestration: 'workflow',
    guarantee: 'structural',
  };
}

// Fail-closed issue-provenance check (same pattern as factory-triage.js / factory-plan.js): a stale
// `.factory/out/context.json` or a wrong --context path must never let reviewers sign off on the diff of
// another issue. Returning no verdicts here makes verify-stage's `review.v1` check fail into needs-human
// rather than approving work nobody asked about.
if (Number(loaded.issue) !== issue) {
  return {
    issue,
    error: `context issue mismatch: loader saw ${loaded.issue}, dispatcher asked for ${args.issue}`,
    orchestration: 'workflow',
    guarantee: 'structural',
  };
}

const roster = Array.isArray(loaded.roster) ? loaded.roster.filter(Boolean) : [];
const tier = loaded.tier;
const priorMustFix = Array.isArray(loaded.must_fix) ? loaded.must_fix.filter(Boolean) : [];
const disputed = Array.isArray(loaded.disputed) ? loaded.disputed.filter(Boolean) : [];
const pr = typeof loaded.pr === 'number' ? loaded.pr : undefined;
const headSha = typeof loaded.head_sha === 'string' ? loaded.head_sha : undefined;

const byRole = new Map();
for (const r of roster) byRole.set(r.name, r);

const lessonsOf = (r) => (typeof r.lessons === 'string' && r.lessons !== '' ? r.lessons : `.factory/lessons/${r.agentType}.md`);

// must_fix ids are `<prefix><n>` so that a builder's rework response, and the next round's dispute ruling,
// can be routed back to the reviewer that raised them without any extra bookkeeping. Longest prefix first:
// `spec2` must not be read as `sec`. A role the table does not know (a reviewer added through CHARTER)
// uses its own name as the prefix — the workflow still does not hardcode the roster, only the shorthands.
const PREFIXES = [
  ['arch', 'architecture'],
  ['spec', 'spec-conformance'],
  ['sec', 'security'],
  ['qa', 'qa'],
  ['cf', 'correctness'],
];

function prefixFor(role) {
  for (const p of PREFIXES) if (p[1] === role) return p[0];
  return role;
}

function ownerOf(id) {
  if (typeof id !== 'string') return null;
  for (const p of PREFIXES) {
    if (id.startsWith(p[0]) && /^[0-9]+$/.test(id.slice(p[0].length)) && byRole.has(p[1])) return p[1];
  }
  for (const r of roster) {
    if (id.startsWith(r.name) && /^[0-9]+$/.test(id.slice(r.name.length))) return r.name;
  }
  return null;
}

phase('Disputes');

// The phase is declared even when nothing is disputed — `phases` is the script's shape, not its history.
const disputes = [];
const upheldBy = new Map();

const disputeOwners = [];
for (const d of disputed) {
  const owner = ownerOf(d && d.id);
  if (owner === null) {
    // Recorded rather than dropped: an id nobody owns means the roster shrank between rounds (a reviewer
    // that was spawned last time is not in this tier's roster), and a human reading the handoff should see
    // that the dispute went unanswered instead of it vanishing.
    disputes.push({ role: null, by: null, id: d && d.id, ruling: 'unowned', reason: 'no reviewer in this round owns that id prefix' });
    continue;
  }
  if (!disputeOwners.includes(owner)) disputeOwners.push(owner);
}

const disputePrompt = (role, items) => {
  return (
    `Read \`${args.context}\` — the issue, and the plan handoff's \`non_goals\` and \`files_expected\` ` +
    `(scope is the one thing §7.5 grounds in the plan, because that is where the contract for this change ` +
    `was signed). You may read the diff \`git diff origin/<default_branch>...HEAD\` (default branch from ` +
    `\`.factory/harness.toml\` [project].default_branch). Do not read the PR description or any other note ` +
    `the builder wrote beyond the dispute text quoted below.\n\n` +
    `Issue #${issue} (tier ${tier})${pr === undefined ? '' : `, PR #${pr}`}. In the last round the builder ` +
    `answered your must_fix items with \`status: disputed\`:\n${JSON.stringify(items, null, 2)}\n` +
    (priorMustFix.length > 0
      ? `The items as you filed them last round:\n${JSON.stringify(priorMustFix.filter((m) => items.some((i) => i && m && i.id === m.id)), null, 2)}\n`
      : '') +
    `\nRule on EVERY id above: \`withdraw\` (the dispute is right — the item was out of scope, already ` +
    `answered, or wrong) or \`uphold\` (the item stands). A reason is required either way and must cite the ` +
    `plan's \`non_goals\`/\`files_expected\` or a concrete file path — "I still think so" is not a reason. ` +
    `An \`uphold\` counts as a reject this round: the item is put back into your must_fix, so do not uphold ` +
    `out of habit, and do not withdraw just because the builder pushed back.`
  );
};

if (disputeOwners.length > 0) {
  const rulings = await parallel(disputeOwners.map((role) => () => {
    const r = byRole.get(role);
    const items = disputed.filter((d) => ownerOf(d && d.id) === role);
    return once(() => agent(disputePrompt(role, items), {
      agentType: r.agentType,
      model: r.model,
      label: `dispute:${role}`,
      schema: DISPUTE,
    }))().then((out) => ({ role, out }));
  }));

  const answered = new Map();
  for (const entry of rulings) {
    if (entry && entry.out) answered.set(entry.role, entry.out);
  }

  for (const role of disputeOwners) {
    const out = answered.get(role);
    const ruled = out && Array.isArray(out.rulings) ? out.rulings.filter(Boolean) : [];

    // `by` is what aggregate.js reads when it turns an upheld ruling into a must_fix line; `role` is kept
    // for the human rendering. Anything that is not an explicit `withdraw` re-attaches to the R1.
    const record = (id, ruling, reason) => {
      disputes.push({ role, by: role, id, ruling, reason });
      if (ruling === 'withdraw') return;
      if (!upheldBy.has(role)) upheldBy.set(role, []);
      upheldBy.get(role).push({ id, ruling, reason });
    };

    for (const r of ruled) record(r.id, r.ruling, r.reason);

    // Fail closed on silence (P3-R8 + §7.5): a reviewer that died twice, or answered only some of its
    // ids, has not withdrawn anything. An unanswered dispute is recorded as `unruled` and counts as
    // upheld — otherwise the builder wins the argument by outlasting the reviewer.
    for (const d of disputed) {
      const id = d && d.id;
      if (typeof id !== 'string' || ownerOf(id) !== role) continue;
      if (ruled.some((r) => r.id === id)) continue;
      record(id, 'unruled', 'the reviewer did not respond');
    }
  }
}

phase('R1');

// Cold read (§7.1, Plan 3 Global Constraints) excludes what the BUILDER wrote — its summary, the PR
// description and comments, the commit bodies — and the other reviewers' R1. It does not exclude the
// contract. Two roles are handed the plan handoff, and only the fields their job needs:
// spec-conformance judges the contract itself (done_when + files_expected + non_goals + dissent_log,
// `roles.toml cold_read = false`), and qa reproduces `done_when` as a user (§5.2.3 — id/text/verify/level
// only; scope is not its call). correctness, security and architecture judge the code and get none of it.
const PLAN_FIELDS = new Map([
  ['spec-conformance', '`done_when` (id, text, verify, level), `files_expected`, `non_goals`, `dissent_log`'],
  ['qa', '`done_when` (id, text, verify, level) and nothing else from it — not `files_expected`, not `non_goals`'],
]);

const r1Prompt = (r) => {
  const planFields = PLAN_FIELDS.get(r.name);
  const prefix = prefixFor(r.name);
  const upheld = upheldBy.get(r.name) || [];
  return (
    `Cold read. Read: \`${args.context}\` (the issue text, tier, spec_path` +
    (planFields === undefined ? '' : `, and \`handoffs.plan\` — ${planFields}`) +
    `), the spec at its \`spec_path\` if one is named, the diff ` +
    `\`git diff origin/<default_branch>...HEAD\` (default branch from \`.factory/harness.toml\` ` +
    `[project].default_branch), the files that diff touches, and your lessons file at ` +
    `\`${lessonsOf(r)}\` (treat every entry as a checklist item). Also read \`.factory/out/gates.json\` ` +
    `**if present** — in the review stage the gates for this commit run after you, so it is normally ` +
    `absent; judge the diff and the tests themselves.\n` +
    (planFields === undefined
      ? `Do NOT read handoffs.plan, the PR description, the PR comments, the commit message bodies, or ` +
        `any note the builder wrote — and do not go looking for them. Explanation is persuasion; you judge ` +
        `the diff.\n`
      : `You are given those plan fields and no more of it. Do NOT read the PR description, the PR ` +
        `comments, the commit message bodies, or any note the builder wrote — and do not go looking for ` +
        `them. The contract is evidence; the builder's explanation is persuasion.\n`) +
    `\nIssue #${issue} (tier ${tier})${pr === undefined ? '' : `, PR #${pr}`}` +
    `${headSha === undefined ? '' : `, head ${headSha}`} — judge that commit as the \`${r.name}\` reviewer, ` +
    `through the Lens in your own role file.\n` +
    `This is round 1: you have not been given any other reviewer's judgement and you must not go looking ` +
    `for one. Independent judgements are the only thing that makes round 2 worth running.\n` +
    `verdict: approve | reject. Every must_fix item needs {id, where (path:line), claim, evidence} and may ` +
    `add repro; a reject needs at least one. Number your must_fix ids \`${prefix}1\`, \`${prefix}2\`, … — ` +
    `the prefix \`${prefix}\` is how the builder's response and the next round's dispute ruling find their ` +
    `way back to you, so never use another reviewer's prefix. should_fix is what does not block the merge. ` +
    `verified[] is what you actually checked and found sound, one line each, naming what you confirmed.\n` +
    `If you could not confirm something that matters, reject and say what you could not confirm — an ` +
    `unverified approve is worth nothing.` +
    (upheld.length > 0
      ? `\n\nThese disputed items of yours still stand this round — you ruled \`uphold\` on them, or no ` +
        `ruling came back at all (an unanswered dispute is not a won dispute): ` +
        `${JSON.stringify(upheld, null, 2)}\nAn item that stands is still open: it MUST appear in your ` +
        `must_fix with the same id and your verdict MUST be reject. Restate its where/claim/evidence ` +
        `against the current diff so the builder can act on it without reading the old round.`
      : '')
  );
};

const r1Raw = await parallel(roster.map((r) => () =>
  once(() => agent(r1Prompt(r), { agentType: r.agentType, model: r.model, label: `R1:${r.name}`, schema: VERDICT_V1 }))()
    .then((v) => (v ? { ...v, role: r.name } : null))));

const dropped = [];
const r1 = [];
roster.forEach((r, i) => {
  const v = r1Raw[i];
  if (!v) { dropped.push(r.name); return; }
  r1.push(normalize(v, r.name));
});

// The findings decide the verdict, not the word next to them (same rule as applyFull): an `approve` that
// carries must_fix items would let a blocking finding reach merge looking waved through, and a `reject`
// with an empty must_fix is a block nobody can act on — `review.v1` refuses the second outright.
// should_fix is left exactly as filed; it never blocks and never promotes.
function normalize(v, role) {
  const mustFix = Array.isArray(v.must_fix) ? v.must_fix.filter(Boolean) : [];
  return {
    role,
    verdict: mustFix.length > 0 ? 'reject' : 'approve',
    confidence: v.confidence,
    must_fix: mustFix,
    should_fix: Array.isArray(v.should_fix) ? v.should_fix.filter(Boolean) : [],
    verified: Array.isArray(v.verified) ? v.verified.filter(Boolean) : [],
  };
}

// An item that survived the dispute phase (upheld, or never ruled on) is re-attached by the workflow as
// well as asked for in the prompt: a reviewer that upheld an item and then filed an approving R1 would
// silently retract its own ruling, and the builder's dispute would have won by attrition rather than on
// the merits (§7.5, P3-R4).
for (const v of r1) {
  const upheld = upheldBy.get(v.role) || [];
  for (const ruling of upheld) {
    if (v.must_fix.some((m) => m && m.id === ruling.id)) continue;
    const prior = priorMustFix.find((m) => m && m.id === ruling.id);
    const how = ruling.ruling === 'unruled'
      ? `no ruling came back, so it stands: ${ruling.reason}`
      : `upheld against the builder's dispute: ${ruling.reason}`;
    v.must_fix.push({
      id: ruling.id,
      where: prior && prior.where ? prior.where : 'see the previous review round',
      claim: prior && prior.claim ? prior.claim : how,
      evidence: prior && prior.evidence ? prior.evidence : `dispute ruling this round — ${ruling.ruling}: ${ruling.reason}`,
    });
  }
  // re-derive after the merge, by the same rule normalize() used
  v.verdict = v.must_fix.length > 0 ? 'reject' : 'approve';
}

phase('R2');

const othersOf = (role) => r1.filter((v) => v.role !== role);

// A revised R2 replaces the lists wholesale; approve/reject is then read off must_fix so the two can never
// disagree (`review.v1` rejects a `reject` with no must_fix, and an `approve` carrying one would let a
// finding reach merge unanswered).
function applyFull(v, out) {
  if (!out) return v; // the R2 died twice — the completed R1 judgement stands rather than vanishing
  if (out.verdict !== 'revise') {
    return out.on_others ? { ...v, on_others: out.on_others } : v;
  }
  const mustFix = Array.isArray(out.must_fix) ? out.must_fix.filter(Boolean) : [];
  return {
    role: v.role,
    verdict: mustFix.length > 0 ? 'reject' : 'approve',
    confidence: v.confidence,
    must_fix: mustFix,
    should_fix: Array.isArray(out.should_fix) ? out.should_fix.filter(Boolean) : [],
    verified: Array.isArray(out.verified) ? out.verified.filter(Boolean) : [],
    ...(out.on_others ? { on_others: out.on_others } : {}),
  };
}

const fullPrompt = (v, missed) => {
  return (
    `Round 2 · cross-examination. Same diff, same commit` +
    `${headSha === undefined ? '' : ` (head ${headSha})`} — re-read anything you need to.\n\n` +
    `Your round-1 judgement:\n${JSON.stringify(v, null, 2)}\n\n` +
    `The other reviewers' round-1 judgements:\n${JSON.stringify(othersOf(v.role), null, 2)}\n\n` +
    (missed && missed.length > 0
      ? `You yourself reported that the round-1 pass missed something:\n${JSON.stringify(missed, null, 2)}\n` +
        `Go and look at it now, then file it properly or say in verified[] why it turned out to be fine.\n\n`
      : '') +
    `Answer each of the others' must_fix ids in on_others with agree|disagree and a reason — disagreement ` +
    `needs evidence from the code, not a preference. Then: \`maintain\` if your round-1 lists still stand ` +
    `as written, or \`revise\` if they do not. A \`revise\` REPLACES your must_fix, should_fix and ` +
    `verified entirely — repeat everything that still holds, because anything you leave out is dropped. ` +
    `Keep your own ids stable (\`${prefixFor(v.role)}<n>\`), and never file another reviewer's finding ` +
    `under your own id; agreeing with it in on_others is enough.\n` +
    `Agreement is not the goal. Change your mind only on evidence, and if the others are wrong, say so and ` +
    `maintain — a reviewer who folds to the room is worth nothing to the next one.`
  );
};

const lightPrompt = (v) => (
  `Round 2 · light. Every reviewer approved this change in round 1, so the only remaining question is ` +
  `whether we all looked away from the same thing.\n\n` +
  `What the other reviewers say they verified:\n` +
  `${JSON.stringify(othersOf(v.role).map((o) => ({ role: o.role, verified: o.verified })), null, 2)}\n\n` +
  `You are deliberately not shown their verdicts or their findings. Read those lists against your own ` +
  `pass: is there something that every one of us left unchecked — a done_when nobody exercised, a failure ` +
  `path nobody opened, an interface nobody called? Return missed: [] if the coverage is genuinely whole, ` +
  `or one {what, why} per gap. Naming a gap costs you nothing; a unanimous approve that no one earned ` +
  `costs the next person everything.`
);

const anyReject = r1.some((v) => v.verdict === 'reject');
let verdicts;

if (anyReject) {
  verdicts = await parallel(r1.map((v) => () => {
    const r = byRole.get(v.role);
    return once(() => agent(fullPrompt(v), { agentType: r.agentType, model: r.model, label: `R2:${v.role}`, schema: R2_FULL }))()
      .then((out) => applyFull(v, out));
  }));
} else {
  const light = await parallel(r1.map((v) => () => {
    const r = byRole.get(v.role);
    return once(() => agent(lightPrompt(v), { agentType: r.agentType, model: r.model, label: `R2-light:${v.role}`, schema: R2_LIGHT }))()
      .then((out) => (out && Array.isArray(out.missed) ? out.missed.filter(Boolean) : []));
  }));

  // Only the reviewer that found a gap is promoted (P3-R3) — a single `missed` does not drag four
  // reviewers back into a full exchange they had nothing to add to.
  verdicts = await parallel(r1.map((v, i) => () => {
    const missed = light[i] || [];
    if (missed.length === 0) return v;
    const r = byRole.get(v.role);
    return once(() => agent(fullPrompt(v, missed), { agentType: r.agentType, model: r.model, label: `R2:${v.role}`, schema: R2_FULL }))()
      .then((out) => applyFull(v, out));
  }));
}

verdicts = verdicts.map((v, i) => (v ? v : r1[i]));

const approves = verdicts.filter((v) => v.verdict === 'approve').length;
const upheldCount = disputes.filter((d) => d.ruling === 'uphold').length;
const withdrawnCount = disputes.filter((d) => d.ruling === 'withdraw').length;
// `unruled`(리뷰어가 두 번 다 죽었거나 일부 id만 답한 경우)는 upheld와 **같은 효과**를 갖지만 같은 사실은
// 아니다 — 세어서 보여주지 않으면 "아무도 판정하지 않아서 유지된 항목"이 "판단 끝에 유지된 항목"으로 읽힌다.
const unruledCount = disputes.filter((d) => d.ruling === 'unruled').length;

const summary =
  `${anyReject ? 'Full' : 'Light'} round 2: ${approves} approve / ${verdicts.length - approves} reject ` +
  `across ${verdicts.length} reviewer(s).` +
  (disputes.length > 0 ? ` Disputes: ${upheldCount} upheld, ${withdrawnCount} withdrawn, ${unruledCount} unruled.` : '') +
  (dropped.length > 0 ? ` No verdict from: ${dropped.join(', ')}.` : '');

// `decision` is deliberately absent: aggregate-review.sh counts the verdicts against the roster and fills
// it in (§7.5, §4.2.1 step 6). `round` is 0 for the same reason — run-stage recounts the round from the
// handoff comments already on the issue, and a workflow that guessed it would fight that count.
return {
  issue,
  pr,
  head_sha: headSha,
  round: 0,
  verdicts,
  // `r1`은 싣지 않는다(F7): `verdicts`가 이미 R2 결과이고, 경량 R2에서 missed가 없으면 R1 그대로다 —
  // 두 벌을 함께 실으면 handoff 코멘트가 두 배가 되는 대신 새로 알려 주는 것은 "누가 R2에서 마음을 바꿨는가"
  // 뿐인데, 그것은 `verdicts[].on_others`와 `summary`가 이미 말한다.
  disputes,
  orchestration: 'workflow',
  guarantee: 'structural',
  summary,
};
