export const meta = {
  name: 'factory-implement',
  description: 'Build the planned change TDD-first, then have a cold-reading verifier judge whether the tests actually prove it',
  phases: [
    { title: 'Load' },
    { title: 'Build' },
    { title: 'Verify' },
    { title: 'Fix' },
  ],
};

// What the builder hands back. `head_sha` is the contract with L1: `verify-stage` checks the handoff
// against `factory.implement.v1` (40-hex) and `run-stage` only posts statuses on the commit it can
// actually check out, so a short sha or a branch name here costs the stage a needs-human.
const BUILD = {
  type: 'object',
  required: ['head_sha', 'pr', 'branch', 'summary', 'tests_added', 'commits'],
  properties: {
    head_sha: { type: 'string' },
    pr: { type: 'number' },
    branch: { type: 'string' },
    summary: { type: 'string' },
    tests_added: { type: 'array', items: { type: 'string' } },
    commits: { type: 'array', items: { type: 'string' } },
    // ADR-020 KTB-23 — optional. The one way the builder can say "I cannot finish this without a
    // change to a protected file". It used to say that in PR prose ("Harness change needed"), which
    // no machine read: the verifier rejected the missing tests, the stage landed on needs-human, and
    // a human re-queue replayed the whole thing (demo #2: four rounds, ~$67, zero merges). As a
    // field it routes — run-stage opens ONE `factory:harness` issue and parks this one on needs-info.
    harness_needed: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'change', 'why'],
        properties: { file: { type: 'string' }, change: { type: 'string' }, why: { type: 'string' } },
      },
    },
    rework_response: {
      type: 'object',
      required: ['responses'],
      properties: {
        responses: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'status'],
            properties: {
              id: { type: 'string' },
              status: { type: 'string', enum: ['fixed', 'disputed'] },
              commit: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

// The verifier's judgement (§5.2.2 — the prove-test half of "the tests are load-bearing").
const VERDICT = {
  type: 'object',
  required: ['verdict', 'findings', 'prove_test_read'],
  properties: {
    verdict: { type: 'string', enum: ['accepted', 'accepted-with-reservations', 'rejected'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['where', 'claim', 'evidence'],
        properties: { where: { type: 'string' }, claim: { type: 'string' }, evidence: { type: 'string' } },
      },
    },
    prove_test_read: { type: 'boolean' },
  },
};

// Insurance re-spawn (ADR-003): if an agent dies/skips and returns null/undefined, try exactly once more.
// A second null is left as null — the role is then dropped (never fabricated) and the missing field
// makes verify-stage's `implement.v1` check fail the stage into needs-human.
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

const isSha40 = (s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);

phase('Load');

// 감사 M5 (2026-09-14) — `factory-loader`는 사라졌다. 그 에이전트가 한 일은 `context.json`과
// `roles.toml`을 읽어 JSON을 JSON으로 옮겨 적는 것뿐이었는데, 그 한 번의 복사에 스테이지마다 sonnet
// 호출 하나가 들었고, 복사는 틀릴 수 있었다 — `model`은 이미 `factory/lib/context.js`가 `def.model`로
// 들고 있었다. 이제 그 파일이 같은 객체를 Node에서 결정적으로 만들어 `.factory/out/loaded.json`에 쓰고,
// 디스패처가 그것을 그대로 Workflow의 `args.loaded`로 넘긴다(워크플로 스크립트는 파일을 읽을 수 없다,
// §4.2.3). 역할 에이전트가 **스스로** 읽는 경로는 그대로 남는다 — 바뀐 것은 스크립트가 제 제어 흐름을
// 위해 쓰던 재료의 출처뿐이다.
const loaded = args.loaded ?? null;

// KTB-27: Claude Code does not substitute positional `$1`/`$2` in a command md — only `$ARGUMENTS`
// is filled in, as one string (verified live: `claude -p "/argtest 42 true"` turned `$ARGUMENTS`
// into "42 true" but `$1` into "true" and left `$2` as the literal text "$2"). The dispatcher
// therefore passes the whole `$ARGUMENTS` string as `raw` — "<issue> <harness_issue>" — and this
// workflow splits it. `args.issue`/`args.harness_issue` are kept as a fallback for any caller that
// already passes the parsed fields directly (tests, or a caller that predates this raw form).
const [rawIssueStr, rawHarnessStr] = String(args.raw ?? args.issue ?? '').trim().split(/\s+/);
const issue = Number(rawIssueStr);

// Fail-closed on a dead loader (same in all four workflows): without it we do not know the tier, the PR,
// or — worst — whether this run is a rework with must_fix items outstanding, so the builder would treat a
// rework as a fresh build and silently drop every reviewer finding. A named error beats a schema failure
// with no reason attached.
if (!loaded) {
  return {
    issue,
    error: 'context payload missing',
    orchestration: 'workflow',
    guarantee: 'structural',
  };
}

// Fail-closed issue-provenance check (same pattern as factory-triage.js / factory-plan.js): a stale
// `.factory/out/context.json` or a wrong --context path must never let the builder open a PR against the
// wrong issue. Returning no head_sha/pr here makes verify-stage's `implement.v1` check fail into
// needs-human rather than merging work nobody asked for.
if (Number(loaded.issue) !== issue) {
  return {
    issue,
    error: `context issue mismatch: the context payload says ${loaded.issue}, dispatcher asked for ${args.issue}`,
    orchestration: 'workflow',
    guarantee: 'structural',
  };
}

// implement's roster in context.json is intentionally empty: builder and verifier are fixed roles
// (`roles.toml [implement.builder]` / `[implement.verifier]`, both opus), not a CHARTER-driven debate
// roster. The loader still runs — it is where issue/tier/pr/must_fix/disputed come from.
const tier = loaded.tier;
const mustFix = Array.isArray(loaded.must_fix) ? loaded.must_fix.filter(Boolean) : [];
const disputed = Array.isArray(loaded.disputed) ? loaded.disputed.filter(Boolean) : [];
const priorPr = typeof loaded.pr === 'number' ? loaded.pr : null;

// Rework completeness (§7.5, P3-R4): every must_fix id must come back as `fixed` with the commit that
// fixed it or `disputed` with a reason. A silent omission is how an unanswered reviewer finding reaches
// merge looking answered, so this is checked here rather than left to the next review round to notice.
// Returns the gaps as human-readable strings — empty means the response is complete and well formed.
function reworkGaps(out) {
  if (mustFix.length === 0 || !out) return [];
  const responses = out.rework_response && Array.isArray(out.rework_response.responses)
    ? out.rework_response.responses.filter(Boolean)
    : [];
  const answered = new Set();
  const malformed = [];
  for (const r of responses) {
    if (typeof r.id !== 'string' || r.id === '') continue;
    answered.add(r.id);
    if (r.status === 'fixed') {
      if (typeof r.commit !== 'string' || r.commit === '') malformed.push(`${r.id} (status fixed needs a commit)`);
    } else if (r.status === 'disputed') {
      if (typeof r.reason !== 'string' || r.reason === '') malformed.push(`${r.id} (status disputed needs a reason)`);
    } else {
      malformed.push(`${r.id} (status must be fixed or disputed)`);
    }
  }
  const missing = mustFix
    .filter((m) => typeof m.id === 'string' && m.id !== '' && !answered.has(m.id))
    .map((m) => m.id);
  return [...missing, ...malformed];
}

// One completion re-spawn, naming exactly what is missing. A second incomplete answer is not retried —
// it is returned as an error without a `verifier`, which fails verify-stage's implement.v1 check closed.
async function completeRework(out, prompt, label) {
  const gaps = reworkGaps(out);
  if (gaps.length === 0) return out;
  const retry = await agent(
    `${prompt}\n\nYour rework_response was incomplete: ${gaps.join('; ')}. Answer EVERY must_fix id — ` +
    `status "fixed" with the commit sha that fixed it, or status "disputed" with a reason citing the plan ` +
    `handoff or a file path. Repost the complete factory.rework-response.v1 as a PR comment — write it to a ` +
    `temp file and pass \`gh pr comment <pr> --body-file <path>\`, never an inline --body — and return the ` +
    `same responses in rework_response.`,
    { agentType: 'factory-builder', model: 'opus', label, schema: BUILD },
  );
  return retry ? { ...out, ...retry } : out;
}

const reworkFailure = (out, gaps) => ({
  issue,
  head_sha: out ? out.head_sha : undefined,
  pr: out ? out.pr : undefined,
  error: `rework response incomplete: ${gaps.join('; ')}`,
  orchestration: 'workflow',
  guarantee: 'structural',
});

// The protected set is the same list in three places — `harness.toml [protected].factory`,
// `settings.json permissions.deny`, and `hooks/block-dangerous.sh`. Naming it in the prompt is not the
// enforcement (the hooks are); it is so the builder spends its turns asking for a harness change instead
// of discovering the wall three times.
const PROTECTED =
  '`.factory/**`, `.claude/**`, `.github/workflows/factory-*.yml`, `docs/factory/CHARTER.md`, ' +
  '`package.json`, `package-lock.json`, `vitest.config.*`, `playwright.config.*`, `tsconfig*.json`, ' +
  '`.eslintrc*`, `eslint.config.*`';

// ADR-020 KTB-23 fix — a `factory:harness` issue is the one issue whose whole point is to change those
// files, and the runner already runs its builder with the variant settings + FACTORY_HARNESS_ISSUE=1
// (KTB-20/KTB-23). The prompt was the one place that never got that judgement: it still listed
// package.json/vitest.config/.factory as PROTECTED and rule 8 still said "fill harness_needed and STOP",
// so the harness issue's own builder parked itself and the factory opened a harness issue for the
// harness issue — a chain, with the parked feature waiting at the end of it. KTB-27: the flag now
// arrives as the second token of `args.raw` (`rawHarnessStr`, from the same label read that picked
// the settings file), with `args.harness_issue` kept as a fallback for the old, pre-KTB-27 shape.
const isHarnessIssue = rawHarnessStr === 'true' || args.harness_issue === true || args.harness_issue === 'true';

// What the variant actually opens — the same list as `.factory/ci-settings-harness.json` and the
// FACTORY_HARNESS_ISSUE branch of `hooks/block-dangerous.sh`. `.factory/**` stays shut apart from
// `harness.toml`, so the exclusion is named file by file rather than as a whole directory.
// (KTB-36: neither settings file carries a blanket `.factory/**` any more — both enumerate, so that
// `.factory/out/qa/**` can stay writable for the qa reviewer's evidence. A builder still writes
// nothing under `.factory/out/`; that carve-out belongs to the review stage, not to this one.)
const HARNESS_OPEN =
  '`.factory/harness.toml`, `vitest.config.*`, `playwright.config.*`, `package.json`, `package-lock.json` ' +
  '(and `docker-compose.test.yml`/`.env.test`, which were never protected)';

const PROTECTED_FOR_HARNESS_ISSUE =
  '`.factory/**` **except `.factory/harness.toml`**, `.claude/**`, ' +
  '`.github/workflows/factory-*.yml`, `docs/factory/CHARTER.md`, `tsconfig*.json`, `.eslintrc*`, ' +
  '`eslint.config.*`';

const builderReading =
  `Read \`${args.context}\` first (issue, tier, spec_path, handoffs.plan.done_when and files_expected, ` +
  `harness.maturity, harness.commands), then the spec at its \`spec_path\` if one is named, ` +
  `\`docs/QA.md\` (how this project writes each test level) **if present**, \`docs/TECHNICAL.md\` ` +
  `§Testing Strategy **if present** — neither is guaranteed to exist and their absence is normal, and ` +
  `your lessons file at \`.factory/lessons/factory-builder.md\` (treat every entry as a checklist item). ` +
  `The default branch is \`[project].default_branch\` in \`.factory/harness.toml\` — read it there; the ` +
  `\`harness\` block of \`${args.context}\` does not carry it. ` +
  `Answer with the English field names of your output schema.`;

// Rule 8, normal issue: the protected files are a wall, and the way through the wall is a field.
const normalProtectedBlock =
  `Protected paths — you must not edit ${PROTECTED}. An \`Edit\` there is denied by a hook, and a PR ` +
  `carrying such a change is never auto-merged — the merge stage hands it to a human instead.\n` +
  `8. If the change genuinely needs one of those files changed — a new dependency, a new script, a ` +
  `runner/linter config change — fill \`harness_needed\` in your output, one entry per file: ` +
  `{file: the exact path, change: what must change (e.g. "add dependency pg@^8 to dependencies"), ` +
  `why: which done_when ids need it and why it cannot be done otherwise}. Then STOP: commit and push ` +
  `whatever is genuinely finished, open (or update) the draft PR as in rule 6, and return. Do not ` +
  `write the request as PR prose — prose is not a signal, and a "Harness change needed" heading is ` +
  `read by nobody. The factory opens ONE \`factory:harness\` issue from your entries and parks this ` +
  `issue until that lands, so a partial-but-honest answer costs one round; working around the deny ` +
  `(\`npm install\`, editing a lockfile, a shell redirection) is blocked by a hook and, if it got ` +
  `through, would only be refused at merge. Leave \`harness_needed\` out entirely when you do not ` +
  `need one — an empty request parks the issue for nothing.\n`;

// Rule 8, harness issue: there is nothing to ask for — you ARE the request. Asking again is a chain
// (a harness issue that opens a harness issue), and the feature parked behind this one waits for it.
const harnessProtectedBlock =
  `THIS IS A \`factory:harness\` ISSUE — the issue whose whole purpose is to change the build/test ` +
  `harness. Your session runs with the variant permissions (\`.factory/ci-settings-harness.json\` + ` +
  `\`FACTORY_HARNESS_ISSUE=1\`), so these files ARE yours to edit for this issue: ${HARNESS_OPEN}.\n` +
  `Still protected — you must not edit ${PROTECTED_FOR_HARNESS_ISSUE}. An \`Edit\` there is denied by ` +
  `a hook. (\`.factory/package.json\` is the runner's own manifest and stays shut: opening it would ` +
  `change the runtime that runs the gates.)\n` +
  `8. Do NOT fill \`harness_needed\` and do NOT stop — make the change. Leave the field out entirely. ` +
  `Asking for a harness change from inside the harness issue opens a second harness issue behind this ` +
  `one and the feature parked on it waits for both; the factory refuses to chain them, so the request ` +
  `is recorded and then ignored. Edit the files above directly, add the test that proves the new ` +
  `capability works (a smoke test at the level you just enabled), and finish rules 5-7 as usual.\n` +
  `The merge is still a human's: this PR carries protected paths, so the merge stage will refuse to ` +
  `auto-merge it and hand it to a person. That is the design — you make the diff, a human approves it. ` +
  `Do not try to merge it yourself.\n`;

const buildRules =
  `1. You are ALREADY on the branch \`claude/fq-${issue}\` — the stage checked it out before this session ` +
  `started (ADR-023 Task 8b) and it is the only branch this session may be on. Never run \`git checkout\`, ` +
  `\`git switch\`, \`git fetch\`, \`git reset --hard\` or \`git stash\`: a branch switch swaps the hook ` +
  `scripts and settings on disk underneath the session, so a PreToolUse hook blocks all of them. Commit ` +
  `and push where you are.\n` +
  `2. TDD, in this order: write the tests named by \`handoffs.plan.done_when[].verify\` FIRST and run ` +
  `them to watch them fail (RED), then implement until they pass (GREEN). A test you never saw fail ` +
  `proves nothing, and the verifier runs \`prove-test\` to check exactly that.\n` +
  `3. Never modify or delete an existing test (\`tests_are_load_bearing\`, spec §5.2.4) and never add a ` +
  `skip/ignore pragma (\`.skip\`, \`xit\`, \`@pytest.mark.skip\`, \`# pragma: no cover\`, ` +
  `\`istanbul ignore\`, \`Stryker disable\`). This is now enforced, not just asked: a removed or changed ` +
  `line in a file matched by \`harness.test.test_glob\` (and a deleted test file) is a policy violation ` +
  `that stops the auto-merge and hands the PR to a human (external audit H5). Adding new tests is always ` +
  `fine. The only exception is an existing test the ISSUE BODY lists under \`tests_changed_allowed:\` — ` +
  `if the change you need is not listed there, stop and write why in the PR body instead.\n` +
  `4. Stay inside \`handoffs.plan.files_expected\`. If the work honestly needs a path outside it, record ` +
  `the path and the reason in the PR body under a "Scope change" heading.\n` +
  `5. Run \`[commands].lint\` and \`[commands].unit\` from \`harness.commands\` yourself (plus the full ` +
  `level if the harness declares one) before you push. Do not hand a red tree to the verifier.\n` +
  `6. Commit in logical units with real messages, push the branch, and open a draft PR. Write the PR body ` +
  `to a temp file with the Write tool first (\`/tmp/factory-pr-${issue}.md\`) and pass it as a file: ` +
  `\`gh pr create --draft --title "#${issue}: <summary>" --body-file /tmp/factory-pr-${issue}.md\`. The body ` +
  `must say \`Closes #${issue}\`. NEVER pass a body inline (\`--body "…"\`, a heredoc, an echoed string): the ` +
  `PreToolUse hook reads the whole command text, so a body line that starts with \`>\` — a quote, a "Scope ` +
  `change" note, anything that looks like a redirection — is read as a write to a protected path and the ` +
  `command is blocked. The same rule holds for every \`gh pr comment\` and \`gh pr edit\` you run: write the ` +
  `file, then pass \`--body-file <path>\`. If the PR already exists, push to it and update its body with ` +
  `\`gh pr edit <pr> --body-file <path>\` instead of opening a second one.\n` +
  `7. Return head_sha = the output of \`git rev-parse HEAD\` **after** the push: 40 lowercase hex ` +
  `characters, not a short sha and not a branch name.\n\n` +
  (isHarnessIssue ? harnessProtectedBlock : normalProtectedBlock) +
  `Never write a credential, token or key into the repository, a test fixture, or a log line.`;

const reworkBlock = mustFix.length > 0
  ? `\n\nThis is a REWORK round. The review returned these must_fix items:\n` +
    `${JSON.stringify(mustFix, null, 2)}\n` +
    (disputed.length > 0 ? `Items you disputed in an earlier round (the reviewer who raised each one ` +
      `will rule withdraw|uphold on it next round):\n${JSON.stringify(disputed, null, 2)}\n` : '') +
    `Respond to EVERY id above — a silent omission reads as an unaddressed reject. For each item: ` +
    `status "fixed" with the commit sha that fixed it, or status "disputed" with a reason that cites the ` +
    `plan handoff (\`non_goals\`, \`files_expected\`) or a concrete file path. Opinion is not a dispute.\n` +
    `Post the whole response as a comment on PR #${priorPr === null ? '<pr>' : priorPr}: write it to ` +
    `\`/tmp/factory-rework-${issue}.md\` with the Write tool and run ` +
    `\`gh pr comment ${priorPr === null ? '<pr>' : priorPr} --body-file /tmp/factory-rework-${issue}.md\` ` +
    `(never an inline --body — see rule 6), as a \`\`\`json fenced block holding a factory.rework-response.v1 object ` +
    `({"schema": "factory.rework-response.v1", "issue": ${issue}, "responses": [...]}), and return the ` +
    `same responses in your output's rework_response.`
  : '';

const buildPrompt =
  `${builderReading}\n\n` +
  `Issue #${issue} (tier ${tier}). Build the planned change.\n\n` +
  `${buildRules}${reworkBlock}`;

const SHA_NOTE =
  `\n\nYour previous answer's head_sha was not a 40-character lowercase hex sha. head_sha must be the ` +
  `exact output of \`git rev-parse HEAD\` after the push — not a short sha, not a branch name, not a tag.`;

// One builder turn, plus the single insurance re-spawn for a null answer (ADR-003) and a single
// re-spawn for an unusable head_sha. Two different failures, one retry each, no loops.
async function build(prompt, label) {
  let out = await once(() => agent(prompt, { agentType: 'factory-builder', model: 'opus', label, schema: BUILD }))();
  if (out && !isSha40(out.head_sha)) {
    const retry = await agent(`${prompt}${SHA_NOTE}`, { agentType: 'factory-builder', model: 'opus', label, schema: BUILD });
    if (retry) out = retry;
  }
  return out;
}

phase('Build');

let built = await build(buildPrompt, 'build');

built = await completeRework(built, buildPrompt, 'build:rework');
const buildGaps = reworkGaps(built);
if (buildGaps.length > 0) return reworkFailure(built, buildGaps);

// Cold read (§7.1 `cold_read = true`): the verifier's prompt carries the head sha and PR number and
// nothing else the builder wrote — no summary, no branch name, no test list, no commit messages.
// Explanation is persuasion; the verifier judges the diff and the tests.
const verifyPrompt = (round, priorFindings) =>
  `Cold read. Read only: \`${args.context}\` (issue, handoffs.plan.done_when — id, text, verify, level), ` +
  `the diff \`git diff origin/<default_branch>...HEAD\` (default branch from \`.factory/harness.toml\` ` +
  `[project].default_branch), the test files that diff adds or changes, the implementation files it ` +
  `touches, and your lessons file at \`.factory/lessons/factory-verifier.md\` (treat every entry as a ` +
  `checklist item). Do NOT read the PR description, the PR comments, the commit message bodies, or any ` +
  `note the builder wrote, and do not go looking for them.\n\n` +
  `Issue #${issue} (tier ${tier}), PR #${built && built.pr !== undefined ? built.pr : '<unknown>'}, ` +
  `head ${built && built.head_sha ? built.head_sha : '<unknown>'} — judge that commit.\n` +
  (round > 1
    ? `This is your second judgement: the head above is new work on the same branch. Judge it from ` +
      `scratch. Your own findings from the first round were:\n${JSON.stringify(priorFindings || [], null, 2)}\n` +
      `A finding is only answered if the code and the tests now show it answered.\n`
    : '') +
  `\nFor each \`done_when\`: does a test whose name is its \`verify\` id actually exist, and would it ` +
  `fail if this change were reverted? Run \`node .factory/bin/prove-test.js\` and read its JSON output ` +
  `(base, changed_tests, prove_test, new_test_repeat) — set prove_test_read true only if you actually ` +
  `read it, false if the command could not run.\n` +
  `Reject if any of these is true: a done_when has no real test (1:1 is the contract); an assertion ` +
  `copies the implementation instead of observing its behaviour; a mock or stub fixes the result so the ` +
  `code under test could be wrong and still pass; an existing test was modified or deleted; a ` +
  `skip/ignore pragma was added; prove-test expected FAIL and observed PASS; the diff leaves ` +
  `\`files_expected\` with no reason given in the diff itself.\n` +
  `verdict: accepted | accepted-with-reservations | rejected. Every finding needs {where (path:line), ` +
  `claim, evidence}; rejected needs at least one. When a finding rests on prove-test, quote its verdict ` +
  `line (the expected/observed pair) verbatim in \`evidence\` — a finding that only says "prove-test ` +
  `failed" cannot be checked by the next reader. If you could not confirm something, reject and say ` +
  `what you could not confirm — an unverified accept is worth nothing.`;

phase('Verify');

let verdict = built
  ? await once(() => agent(verifyPrompt(1), { agentType: 'factory-verifier', model: 'opus', label: 'verify:1', schema: VERDICT }))()
  : null;

phase('Fix');

// Exactly one fix round (P3-R2). A second rejection is returned as-is: `implement.v1` still validates,
// requirements.js refuses the awaiting-review transition on a rejected verdict, and the stage lands on
// needs-human. Looping until the verifier gives up is how a factory ships unproven code.
if (built && verdict && verdict.verdict === 'rejected') {
  const fixPrompt =
    `${builderReading}\n\n` +
    `Issue #${issue} (tier ${tier}). The verifier REJECTED your change on PR #${built.pr} ` +
    `(head ${built.head_sha}). Its findings:\n${JSON.stringify(verdict.findings || [], null, 2)}\n\n` +
    `Answer every finding where you are — you are still on \`claude/fq-${issue}\` and must stay there. ` +
    `A finding about a test is a finding ` +
    `about the test: strengthen the assertion or the fixture rather than the code that makes it pass. ` +
    `This is your only fix round — the next verdict ends the stage either way.\n\n` +
    `${buildRules}${reworkBlock}`;

  const fixed = await build(fixPrompt, 'fix');
  if (fixed) built = { ...built, ...fixed, rework_response: fixed.rework_response || built.rework_response };

  // The fix round can drop or mangle the rework response it was told to carry — check it again rather
  // than trusting that what was complete before the fix is still complete after it.
  built = await completeRework(built, fixPrompt, 'fix:rework');
  const fixGaps = reworkGaps(built);
  if (fixGaps.length > 0) return reworkFailure(built, fixGaps);

  const second = await once(() => agent(verifyPrompt(2, verdict.findings), { agentType: 'factory-verifier', model: 'opus', label: 'verify:2', schema: VERDICT }))();
  if (second) verdict = second;
}

const reworkResponse = built && built.rework_response && Array.isArray(built.rework_response.responses)
  ? { issue, responses: built.rework_response.responses }
  : null;

return {
  issue,
  head_sha: built ? built.head_sha : undefined,
  pr: built ? built.pr : undefined,
  branch: built ? built.branch : undefined,
  summary: built ? built.summary : undefined,
  tests_added: built ? built.tests_added : undefined,
  commits: built ? built.commits : undefined,
  // KTB-23: only carried when the builder actually asked for something — an empty array would park
  // the issue on needs-info for nothing (run-stage keys on "non-empty", but the handoff should not
  // carry a field that says "I need nothing").
  ...(built && Array.isArray(built.harness_needed) && built.harness_needed.length > 0
    ? { harness_needed: built.harness_needed }
    : {}),
  verifier: verdict
    ? { verdict: verdict.verdict, findings: verdict.findings || [], prove_test_read: verdict.prove_test_read === true }
    : {},
  ...(reworkResponse ? { rework_response: reworkResponse } : {}),
  orchestration: 'workflow',
  guarantee: 'structural',
};
