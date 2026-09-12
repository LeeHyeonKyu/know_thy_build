export const meta = {
  name: 'factory-retro',
  description: 'Read the harvested candidates and the run records, and propose what the factory should learn — lessons, role examples/perspectives, harness gaps, and the proposals a human must approve',
  phases: [
    { title: 'Analyze' },
  ],
};

// RETRO_V1 — `factory.retro.v1` (§8.1/§8.3/§8.4), mirroring `factory/lib/schemas.js` exactly. The analyst
// returns CANDIDATES ONLY (P4-R4): whether a candidate is adopted, what N becomes next, and which PRs and
// issues get opened is all L1's call, because L1 is the only side that can count evidence it did not write.
// Every array may be empty — "there was nothing to learn this week" is a real answer and a better one than
// an invented lesson. `harness` is the one entry without `evidence_runs`: a maturity gap is decided by the
// manifest and the files on disk (`lib/retro/maturity.js`), not by how many runs mentioned it.
// Counts are deliberately NOT in the literal (no `minItems`), exactly as `review.v1`'s verdicts are not:
// "≥1 evidence run per item", "≥2 distinct issues for a lesson", "≥20 runs for a threshold" are all things
// L1 re-counts against the records it owns. A shape the agent satisfies is not evidence the agent has any.
const RETRO_V1 = {
  type: 'object',
  required: ['period', 'lessons', 'examples', 'perspectives', 'harness', 'proposals', 'summary'],
  properties: {
    period: {
      type: 'object',
      required: ['from', 'to'],
      properties: { from: { type: 'string' }, to: { type: 'string' } },
    },
    lessons: {
      type: 'array',
      items: {
        type: 'object',
        required: ['role', 'text', 'evidence_runs'],
        properties: {
          role: { type: 'string' },
          text: { type: 'string' },
          evidence_runs: { type: 'array', items: { type: 'number' } },
        },
      },
    },
    examples: {
      type: 'array',
      items: {
        type: 'object',
        required: ['role', 'kind', 'text', 'evidence_runs'],
        properties: {
          role: { type: 'string' },
          kind: { type: 'string', enum: ['good', 'bad'] },
          text: { type: 'string' },
          evidence_runs: { type: 'array', items: { type: 'number' } },
        },
      },
    },
    perspectives: {
      type: 'array',
      items: {
        type: 'object',
        required: ['role', 'text', 'evidence_runs'],
        properties: {
          role: { type: 'string' },
          text: { type: 'string' },
          evidence_runs: { type: 'array', items: { type: 'number' } },
        },
      },
    },
    harness: {
      type: 'array',
      items: {
        type: 'object',
        required: ['target', 'reason'],
        properties: { target: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'title', 'body', 'evidence_runs'],
        properties: {
          kind: { type: 'string', enum: ['gate', 'threshold', 'role-change', 'role-new', 'test-delete'] },
          title: { type: 'string' },
          body: { type: 'string' },
          evidence_runs: { type: 'array', items: { type: 'number' } },
        },
      },
    },
    summary: { type: 'string' },
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

phase('Analyze');

// retro has no loader and no roster (P4-R6): there is no stage context file in this job, because retro is
// not a stage of the label state machine — it is woken by a merge, and everything it needs is either in the
// candidates file L1 wrote or in the repository itself.
const candidates = typeof args.candidates === 'string' && args.candidates !== ''
  ? args.candidates
  : '.factory/out/retro-candidates.json';

const prompt =
  `You are the factory's retro analyst. Read, in this order:\n` +
  `1. \`${candidates}\` — written by the retro job (L1) just now. It carries \`period\` ` +
  `({from, to}), the accumulated \`candidates\` ({lessons, examples, flaky, needs_human}, each entry with ` +
  `the \`runs\` it came from), the deterministic \`stats\` for this window, the \`history\` of previous ` +
  `retros from \`docs/factory/runs/_retro.md\`, and \`maturity_gaps\` — the harness gaps L1 already ` +
  `detected deterministically ({target, rule, reason}). Candidates are raw claims harvested from ` +
  `handoffs — they are NOT yet lessons, and some of them never will be.\n` +
  `2. \`docs/factory/runs/*.md\` — the run records for the issues those candidates cite (restored to the ` +
  `working tree before you were spawned). This is the only durable evidence of what actually happened.\n` +
  `3. \`.factory/lessons/*.md\` — every role's current lessons. The header of each file ` +
  `(\`<!-- factory-lessons:v1 role=<role> max=<n> -->\`) gives that role's cap: count the existing entries ` +
  `and propose at most the headroom that is left. When a role is already at its cap, L1 makes room by ` +
  `dropping its oldest never-cited entry — so propose a lesson for a full role only when it is worth more ` +
  `than the entry it will displace, and say in the text why it is.\n` +
  `4. \`.claude/agents/*.md\` — the roles themselves. Count the bullets that are already under ` +
  `\`## Examples\` / \`### 좋은 발견\`, \`### 나쁜 발견\` and \`## Perspectives\`: the caps are 8 good ` +
  `examples, 8 bad examples and 6 perspectives per role (Examples 8/8, Perspectives 6). Propose an addition ` +
  `only where there is room, and read each role's Lens so you do not propose an example for something the ` +
  `Lens already names.\n` +
  `5. \`docs/factory/CHARTER.md\` — the roster, tiers and limits this factory actually runs under. A ` +
  `proposal that contradicts the CHARTER is a CHARTER proposal, and it says so in its body.\n\n` +
  `Then decide what this factory should LEARN from the window \`period.from\` .. \`period.to\`. Both values ` +
  `are given in \`${candidates}\` — copy them into your answer's \`period\` exactly as they appear ` +
  `(\`from\` is the last retro's cursor, or the first run if there has never been one; \`to\` is now). Do ` +
  `not compute a date yourself.\n\n` +
  `Rules — these are the rules L1 will re-check against the records, so a candidate that breaks one is ` +
  `simply dropped and you will have spent the window saying nothing:\n` +
  `- **A lesson only when the same failure appears in ≥2 distinct issues.** Two findings in one issue are ` +
  `one event. Cite the issue numbers in \`evidence_runs\` (plain numbers — the run record is ` +
  `\`docs/factory/runs/<issue>.md\`). One issue, however painful, stays a candidate for next time.\n` +
  `- **Phrase every lesson as a checkable sentence**: where to look, under what condition, and how to ` +
  `verify it. "Be careful with timezones" is unusable; "when comparing a stored timestamp with a request ` +
  `parameter, check both sides are UTC — read the column type and the parser, not the variable name" can be ` +
  `checked by the next reviewer in one pass. A lesson is a checklist item for one named role, not advice.\n` +
  `- **Examples are written 위치·주장·근거** (where · claim · evidence), in the same voice as the role file ` +
  `they are going into, and a \`bad\` example says why the finding as written was useless.\n` +
  `- **A gate proposal only when the rule is expressible as a static check** — a lint rule, a config ` +
  `assertion, a test that runs in the harness. "Reviewers should think about X" is not a gate. Name the ` +
  `concrete check in the body and cite ≥3 runs where the rule would have fired. The best lesson stops ` +
  `being a lesson and becomes a gate (§8.2).\n` +
  `- **\`role-new\` only for a reject pattern no existing lens covers.** Open the role files and show which ` +
  `lenses were in the roster at the time and why each one would have missed it. If an existing role's Lens ` +
  `would have caught it with one more line, that is a \`role-change\`, not a new role. Either way the ` +
  `evidence window is ≥10 runs, and the body carries a cost estimate (tokens per issue).\n` +
  `- **A \`threshold\` proposal needs ≥20 runs of sample.** Below that, the number you would be moving is ` +
  `noise; leave it as a candidate.\n` +
  `- **A \`test-delete\` proposal only when a replacement verification exists.** Name the test that will ` +
  `cover the behaviour afterwards. Deleting the last thing that proves something is not a simplification, ` +
  `and a deletion never happens quietly — it goes to a human as a proposal.\n` +
  `- **Never invent a run number, an issue number, a quote or a statistic.** Every \`evidence_runs\` entry ` +
  `must be an issue you actually read in \`docs/factory/runs/\` or that the candidates file names. An item ` +
  `whose \`evidence_runs\` would be empty is not an item — leave it out. If nothing in this window has ` +
  `enough evidence, return empty arrays rather than filling them, and say what you were short of in ` +
  `\`summary\`.\n\n` +
  `For each finding worth keeping, ask the two questions this job exists for: **what would have caught this ` +
  `earlier** (a plan question, a builder check, a reviewer lens, a gate?), and **which layer does it belong ` +
  `to — prompt → lesson → gate** (move it as far toward the gate as the evidence allows).\n\n` +
  `\`harness\` entries are maturity gaps only (target \`M1\`/\`M2\` with a one-sentence reason); L1 detects ` +
  `them deterministically and uses your reason as the issue body, so do not invent a gap it did not find — ` +
  `\`maturity_gaps\` in the candidates file is the complete list it found, and your \`harness\` entries must ` +
  `match those targets one-for-one (an entry for anything else is dropped).\n` +
  `\`summary\` is one paragraph a human reads first: what this window looked like, what you are proposing, ` +
  `and what you deliberately left as a candidate because the evidence had not accumulated yet.`;

const out = await once(() => agent(prompt, {
  agentType: 'factory-retro',
  model: 'opus',
  label: 'retro',
  schema: RETRO_V1,
}))();

// Fail closed on a dead analyst. An empty `factory.retro.v1` would be a lie in the other direction: L1
// reads "no lessons, no proposals" as a yield of 0 and stretches N, so a retro that merely died would make
// the factory retro LESS often. A named error keeps the two facts apart — L1 records the failure in
// `_retro.md` and the next merge tries again.
if (!out) {
  return {
    error: 'retro analyst returned nothing',
    orchestration: 'workflow',
    guarantee: 'structural',
  };
}

// The analyst's own `orchestration`/`guarantee` are overwritten, not merged: they are claims about how the
// answer was produced, and only the workflow knows that.
return {
  ...out,
  orchestration: 'workflow',
  guarantee: 'structural',
};
