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

// 감사 M5 (2026-09-14) — `factory-loader`는 사라졌다. 그 에이전트가 한 일은 `context.json`과
// `roles.toml`을 읽어 JSON을 JSON으로 옮겨 적는 것뿐이었는데, 그 한 번의 복사에 스테이지마다 sonnet
// 호출 하나가 들었고, 복사는 틀릴 수 있었다 — `model`은 이미 `factory/lib/context.js`가 `def.model`로
// 들고 있었다. 이제 그 파일이 같은 객체를 Node에서 결정적으로 만들어 `.factory/out/loaded.json`에 쓰고,
// 디스패처가 그것을 그대로 Workflow의 `args.loaded`로 넘긴다(워크플로 스크립트는 파일을 읽을 수 없다,
// §4.2.3). 역할 에이전트가 **스스로** 읽는 경로는 그대로 남는다 — 바뀐 것은 스크립트가 제 제어 흐름을
// 위해 쓰던 재료의 출처뿐이다.
const loaded = args.loaded ?? null;

const issue = Number(args.issue);

// Fail-closed on a dead loader (same in all four workflows): without it we do not know the roster, the PR,
// or the head sha — and a review that invents its own roster is worse than no review, because the missing
// role would never show up in aggregate-review.sh's roster comparison. A named error beats a schema
// failure with no reason attached.
if (!loaded) {
  return {
    issue,
    error: 'context payload missing',
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
    error: `context issue mismatch: the context payload says ${loaded.issue}, dispatcher asked for ${args.issue}`,
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

// 감사 H4 — **리뷰어는 오케스트레이터의 문맥 파일을 받지 않는다.** `factory/lib/context.js`가 역할마다
// `context.<role>.json`을 따로 쓰고, `cold_read = true`인 역할의 파일에는 handoff가 아예 없다(verifier
// 판정도, builder의 PR 설명도, 다른 리뷰어의 판정도). 그래서 "읽지 마라"라고 부탁할 필요가 없다 —
// 이 워크플로는 전체 파일의 경로를 리뷰어에게 **한 번도 주지 않는다**. 읽기는 훅으로 막을 수 없으니
// (감사 H4의 핵심 지적), 막는 자리를 파일 경계로 옮긴 것이다.
const contextFor = (r) => (loaded.contexts && loaded.contexts[r.name]) || `.factory/out/context.${r.name}.json`;

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
    `Read \`${contextFor(byRole.get(role) || { name: role })}\` — your own context file. It carries the issue, ` +
    `the scope fields you are allowed to see, and nothing the builder wrote; if a field you expect is not in ` +
    `it, that is the answer, not an invitation to go looking elsewhere. ` +
    `You may read the diff \`git diff origin/<default_branch>...HEAD\` (default branch from ` +
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
// contract: the plan's `done_when` (id/text/verify/level) is in every reviewer's file, because "does the
// change do what was agreed" is not answerable without it (§5.2.3). What differs by role is how much MORE
// of the plan is there — spec-conformance (`roles.toml cold_read = false`) judges the contract itself and
// gets the whole handoff; everyone else gets `done_when` and nothing else of it.
//
// 감사 H4 — 이 문단은 이제 **설명**이지 강제가 아니다. 강제는 `context.<role>.json`이 한다: 각 역할이
// 받는 파일에 그 역할이 볼 수 있는 것만 들어 있고, 프롬프트가 다른 경로를 알려 주지 않는다.
const r1Prompt = (r) => {
  const prefix = prefixFor(r.name);
  const upheld = upheldBy.get(r.name) || [];
  return (
    `Cold read. Read: \`${contextFor(r)}\` — **your own** context file, built for the \`${r.name}\` role. ` +
    `It carries the issue, tier, roster, spec_path, the PR number and head sha, the gate summary, and the ` +
    `plan's \`done_when\`; whatever is not in it is not yours to judge on. Then read the spec at its ` +
    `\`spec_path\` if one is named, the diff ` +
    `\`git diff origin/<default_branch>...HEAD\` (default branch from \`.factory/harness.toml\` ` +
    `[project].default_branch), the files that diff touches, and your lessons file at ` +
    `\`${lessonsOf(r)}\` (treat every entry as a checklist item). Also read \`.factory/out/gates.json\` ` +
    `**if present** — in the review stage the gates for this commit run after you, so it is normally ` +
    `absent; judge the diff and the tests themselves.\n` +
    `Do NOT open \`.factory/out/context.json\` or another role's context file, the PR description, the PR ` +
    `comments, the commit message bodies, or any note the builder wrote — and do not go looking for them. ` +
    `Explanation is persuasion; you judge the diff.\n` +
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
