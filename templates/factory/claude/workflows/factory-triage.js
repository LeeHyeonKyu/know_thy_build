export const meta = {
  name: 'factory-triage',
  description: 'Read the roster/context the factory already built, then run the factory-triage role to judge readiness and tier',
  phases: [{ title: 'Load' }, { title: 'Triage' }],
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

// Fail-closed on a dead loader (same in all four workflows): a loader that returned nothing twice told us
// neither the issue it read nor the tier, so nothing downstream can be trusted to be about this issue.
// Proceeding would spend a role's turn to produce a result that fails the schema anyway — with no reason
// attached. Naming the failure here is what the human reads in the run record.
if (!loaded) {
  return {
    issue,
    error: 'context payload missing',
    orchestration: 'workflow',
    guarantee: 'structural',
  };
}

phase('Triage');

// Fail-closed issue-provenance check — copy this pattern into factory-plan.js/factory-implement.js/
// factory-review.js's own Load→<stage> transitions (Tasks 3-5). The loader is only trustworthy if the
// context.json it read actually belongs to the issue the dispatcher was asked to run: a stale
// `.factory/out/context.json` from a previous run, or a wrong --context path, must never let a role act
// on the wrong issue silently. Returning no `disposition` here makes verify-stage's `triage.v1` schema
// check fail the stage into needs-human instead.
if (Number(loaded.issue) !== issue) {
  return {
    issue,
    error: `context issue mismatch: the context payload says ${loaded.issue}, dispatcher asked for ${args.issue}`,
    orchestration: 'workflow',
    guarantee: 'structural',
  };
}

const roster = Array.isArray(loaded.roster) ? loaded.roster : [];
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
