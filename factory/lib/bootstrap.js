import { LABELS } from "./label-catalog.js";
import { GH_FREE_PLAN_PROTECTION_RE } from "./gh.js";

/**
 * L0(branch protection)가 요구하는 체크는 `factory/integrity` 하나다(ADR-015 보강).
 * `factory/gates`·`factory/review`는 **이슈 파이프라인을 탄 PR에만** 게시자가 있다(run-stage가
 * PR head sha에 commit status로 올린다) — 사람이 직접 여는 retro-proposal·harness PR이나
 * 부트스트랩 직후의 첫 push에는 그 상태를 만들 주체가 아예 없어서, L0에 넣는 순간 그 PR들은
 * 영영 머지 불가가 된다(교착). 두 체크는 L1이 계속 강제한다 — merge 스테이지의
 * `allChecksGreen(prChecks, harness.factory.required_checks)`가 세 개 전부를 요구한다.
 * strict:false — 게이트 판정은 이미 sha에 묶여 있고(requirements.js gatesGate), strict(=up-to-date)는
 * 머지 직전 base 리베이스를 요구하는데 팩토리는 리베이스를 하지 않는다(하면 게이트가 검증한 sha가 바뀐다).
 */
export const L0_CONTEXTS = ["factory/integrity"];

/**
 * ADR-021 — **두 배우 모드의 표식은 `FACTORY_MERGE_TOKEN` 시크릿 하나다.** 이 시크릿이 있으면
 * 저장소는 "에이전트 배우(`FACTORY_BOT_TOKEN`, 비-admin write)"와 "머지 배우(admin PAT)"를
 * 나눠 쓰고 있다는 뜻이고, 그때만 base 브랜치에 **리뷰 승인 1건**을 요구할 수 있다. 단일 배우
 * 모드에서 같은 규칙을 걸면 다크 머지가 구조적으로 불가능해진다 — PR 작성자(에이전트 배우)는
 * 자기 PR을 승인할 수 없고, 승인해 줄 다른 계정이 없다.
 */
export const MERGE_TOKEN_SECRET = "FACTORY_MERGE_TOKEN";
/**
 * ADR-021 r2 (KTB-33 finding MF-A) — 모드는 저장소 시크릿 **OR** `factory-merge` 환경 시크릿, 둘 중
 * 하나에라도 토큰이 있으면 켜진다. 소유자 체크리스트는 정확히 "환경으로 옮기고 저장소 사본을
 * 지워라"라고 시키므로(ADR-021 r1), 저장소 시크릿 목록만 보면 그 권고를 따른 저장소가 영원히
 * 단일 배우 모드로 보이고 재부트스트랩이 코드 오너 요건 없는 보호 규칙을 덮어쓴다.
 */
export const isTwoActor = (secrets = [], envSecrets = []) => secrets.includes(MERGE_TOKEN_SECRET) || envSecrets.includes(MERGE_TOKEN_SECRET);

/**
 * ADR-021 r1 MF-1 — **승인은 수가 아니라 신원이어야 한다.** `required_approving_review_count: 1`은
 * "작성자가 아닌 누군가"만 요구한다. 에이전트 배우는 write 협력자이므로 **자기가 열지 않은** PR
 * (사람의 PR, `init --upgrade` PR, dependabot, 머지 배우의 PR)에 커밋을 밀어 넣고 스스로 approve한
 * 뒤 머지할 수 있었다 — 그 경로에서는 "자기 PR은 승인 못 한다"는 GitHub 규칙이 전혀 걸리지 않는다.
 * `require_code_owner_reviews: true` + `* @<머지 배우>`짜리 CODEOWNERS가 그 한 건의 승인을
 * **머지 배우의 것으로 못 박는다**: 어느 PR이든, 누가 열었든, 승인은 그 계정에서만 나올 수 있다.
 *
 * CODEOWNERS 자체가 다음 공격 지점이므로 `.github/**`가 `[protected].factory`에 들어간다(MF-2 c) —
 * 이 파일을 건드리는 PR은 L1이 자동 머지를 거부하고 사람에게 넘긴다.
 */
export const CODEOWNERS_PATH = ".github/CODEOWNERS";

/**
 * ADR-021 r1 MF-2 b — 머지 토큰은 **저장소 시크릿이 아니라 환경 시크릿**이다. 저장소 시크릿은
 * 같은 저장소의 **어느 브랜치에서 돌든** 워크플로에 주어진다(fork 제한은 same-repo 브랜치에 걸리지
 * 않는다) — 곧 에이전트가 자기 `claude/fq-*` 브랜치에 워크플로 한 장을 올리는 것만으로 admin PAT을
 * 읽어 갈 수 있었다. 배포 브랜치 정책이 `protected_branches: true`인 환경에 두면 그 값은 **기본
 * 브랜치(=보호된 브랜치)에서 시작한 잡에만** 주어지고, 에이전트 브랜치의 워크플로는 빈 문자열을 본다.
 */
export const TWO_ACTOR_VARIABLE = "FACTORY_TWO_ACTOR";

export const MERGE_ENVIRONMENT = "factory-merge";
export const MERGE_ENVIRONMENT_BODY = {
  deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
};

/**
 * 외부 감사 2026-09-14 H6 — **사람의 서명을 PR마다 요구하는 유일한 손잡이.** 감사 이전의 `factory-merge`
 * 환경에는 `deployment_branch_policy`만 있었다(시크릿을 보호 브랜치의 잡에만 준다) — 그건 *토큰이
 * 어디로 새는가*를 막을 뿐, *사람이 이 머지를 봤는가*와는 아무 상관이 없다. `merge-stage.js:465`의
 * `approvePr`가 admin PAT으로 자동 승인하므로, 사람의 서명은 토큰을 한 번 등록한 것이 전부였다.
 *
 * `reviewers`를 넣으면 GitHub이 이 환경을 쓰는 **모든 잡을** 시작 전에 멈춰 세우고 그 사람의 승인을
 * 기다린다 — 곧 머지 PR 하나당 사람의 클릭 하나다. 이것이 다크 루프를 끄는 스위치이므로 기본값이
 * 아니라 **CHARTER의 명시적 선택**(`merge.human_gate`)이고, 끄는 쪽을 고른 저장소는 doctor가
 * 매번 그 사실을 WARN으로 말한다.
 *
 * 소유자 id를 해석하지 못했으면 `reviewers`를 **넣지 않는다**: 존재하지 않는 리뷰어를 넣으면 PUT
 * 자체가 422로 실패해 환경이 아예 만들어지지 않고, 그러면 시크릿 보호(deployment_branch_policy)까지
 * 함께 잃는다. 그 경우는 note로 소리 내어 말한다(계획 단계).
 */
export function mergeEnvironmentBody({ humanGate = false, reviewerId = null } = {}) {
  const body = { ...MERGE_ENVIRONMENT_BODY };
  if (humanGate && Number.isInteger(reviewerId)) body.reviewers = [{ type: "User", id: reviewerId }];
  return body;
}

/**
 * CHARTER `merge.human_gate`를 부트스트랩이 읽는 방식. **없으면 true로 읽는다**(fail closed):
 * 아무도 고른 적 없는 저장소에 다크 머지를 기본값으로 주지 않는다. doctor는 같은 상태를 FAIL로
 * 세워 사람에게 고르라고 말한다 — 두 자리의 역할이 다르다(여기는 "지금 무엇을 설정할까", 거기는
 * "이 선언이 있는가").
 */
export const humanGateOf = (charter) => charter?.merge?.human_gate !== false;

/**
 * CODEOWNERS 본문. 주석이 길어도 되는 자리다 — 이 파일을 여는 사람은 "왜 한 사람만 적혀 있는가"를
 * 묻는 사람이고, 그 답이 곧 ADR-021의 요지다.
 */
export function codeownersContent(login) {
  return `# factory (ADR-021) — the merge actor is the sole code owner of this repository.
#
# The base branch requires one approving review AND \`require_code_owner_reviews: true\`.
# Together they mean: the one approval must come from an account listed here, for EVERY pull
# request regardless of who opened it. Counting approvals alone was not enough — a write
# collaborator (the agent actor) can approve any PR it did not author, and could push its own
# commits onto that PR's head branch first.
#
# NEVER list the agent actor (the account behind FACTORY_BOT_TOKEN) here. If it appears, the
# agent can approve its own way to a merge again and the whole ADR is void — \`factory doctor\`
# FAILs \`protection.codeowners\` in CI when it finds that login in this file.
#
# \`.github/**\` is in \`[protected].factory\`, so a pull request that edits this file is never
# auto-merged: the merge stage refuses and a human merges it (L1).
#
# Managed by \`npx know-thy-build factory bootstrap\`.
* @${login}
`;
}

/** `@login` 토큰 전부(패턴과 무관하게). doctor의 "에이전트 로그인이 들어 있는가" 판정용. */
export function codeownersMentions(text = "") {
  return [...String(text).replace(/(^|\s)#.*$/gm, "$1").matchAll(/@([A-Za-z0-9-]+(?:\/[A-Za-z0-9._-]+)?)/g)].map((m) => m[1]);
}

/** `*` 규칙(모든 파일)의 소유자 목록. 비어 있으면 "코드 오너가 없다" = 승인 요건이 충족 불가능하다. */
export function codeownersOwners(text = "") {
  const owners = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "$1").trim();
    if (!line) continue;
    const [pattern, ...rest] = line.split(/\s+/);
    if (pattern !== "*") continue;
    for (const o of rest) if (o.startsWith("@")) owners.push(o.slice(1));
  }
  return owners;
}

/**
 * ADR-021 — 두 배우 모드에서만 `required_pull_request_reviews`가 붙는다.
 *
 * 이것이 이 설계의 **유일하게 되돌릴 수 없는 문**이다: 승인 1건이 필수가 되는 순간, PR을 연
 * 계정(에이전트 배우)은 GitHub 규칙상 **자기 PR을 승인할 수 없으므로** 그 계정이 쥔 토큰으로는
 * `gh pr merge`가 어떤 모양으로 불려도 통과하지 못한다 — 명령 패턴을 열거해 막는 것이 아니라
 * **권한으로** 막는다(훅은 그 위의 defense in depth로 남는다). `dismiss_stale_reviews: true`인
 * 이유: 승인 뒤에 새 커밋이 밀려 들어오면 그 승인은 다른 diff에 대한 것이다.
 *
 * **r1 MF-1**: 여기에 `require_code_owner_reviews: true`가 함께 간다. 수만 세면 "작성자가 아닌
 * 누군가"로 충분해서, 에이전트 배우는 **자기가 열지 않은** PR을 승인하고 머지할 수 있었다(그 PR의
 * head 브랜치에 자기 커밋을 먼저 밀어 넣고서). 코드 오너 요건은 그 한 건의 승인을 CODEOWNERS에
 * 적힌 계정 — 곧 머지 배우 — 의 것으로 못 박는다. 그래서 이 플래그와 `.github/CODEOWNERS`는
 * 한 쌍이다: 둘 중 하나만 있으면 아무 것도 강제되지 않는다(doctor의 `protection.codeowners`).
 *
 * `enforce_admins: true`는 두 모드 모두 유지한다 — 머지 배우도 required check를 우회하지 못한다
 * (승인 요건만 충족하면 머지할 수 있고, 그것이 두 배우 모드가 여는 유일한 문이다).
 * `restrictions`는 두 모드 모두 null이다: push 제한은 GitHub Free의 개인 저장소에서 지원되지 않고
 * (조직 전용), 그것 없이도 위의 승인 요건이 같은 결과를 낸다.
 */
const PROTECTION_BODY = (contexts, { twoActor = false } = {}) => ({
  required_status_checks: { strict: false, contexts },
  enforce_admins: true,
  required_pull_request_reviews: twoActor
    ? { required_approving_review_count: 1, dismiss_stale_reviews: true, require_code_owner_reviews: true }
    : null,
  restrictions: null,
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
  required_conversation_resolution: false,
});

/**
 * ── 리뷰 batch-1 MF-2 (H1b-b) — **증거 브랜치에도 자물쇠가 필요하다.** ────────────────────────────
 * 머지 스테이지는 이제 review handoff를 `factory/records`의 run 기록과 대조한다(review-quorum.js
 * `verifyReviewProvenance`). 그런데 감사 시점의 `bootstrapPlan`은 `harness.project.default_branch`
 * 하나만 보호했고, `git push origin HEAD:factory/records`는 훅에서도 rc=0이었다 — 대조의 상대가
 * 에이전트가 쓸 수 있는 자리에 있으면 대조는 아무것도 증명하지 않는다. 훅은 이제 그 push를 막고,
 * 여기서는 **브랜치 쪽에서** 같은 말을 한다.
 *
 * 무엇을 걸 수 있고 무엇을 걸 수 없는가(이 구분이 이 블록의 요점이다):
 *  - `allow_force_pushes: false` · `allow_deletions: false` — **건다.** run 기록은 append-only 로그이고,
 *    이미 기록된 판정을 **다시 쓰거나 지우는** 것이 위조의 모양이다. 러너의 `syncRecords`는 언제나
 *    fast-forward push라 이 두 규칙에 걸리지 않는다.
 *  - `restrictions`(push 허용 계정 목록) — **걸지 않는다.** 기록을 쓰는 것은 머지 배우가 아니라
 *    **모든 스테이지의 러너**다(같은 봇 계정). 머지 배우로 좁히면 triage·plan·implement·review의
 *    기록 동기화가 통째로 실패한다 — 증거를 지키려다 증거를 없애는 설정이다. 게다가 조직 저장소
 *    전용이라 개인 저장소에서는 API가 받지도 않는다.
 *  - 그래서 **잔여 위험은 그대로 남는다**: 러너와 에이전트가 같은 자격증명을 쓰는 한, 훅이 보지
 *    못하는 철자로 나가는 append 하나는 이 보호를 통과한다. 진짜 분리는 두 번째 배우이거나
 *    Actions 실행 증명이고, 그것은 이 주기 밖이다(ADR-023 잔여 위험 #1).
 */
export const RECORDS_BRANCH = "factory/records";
export const RECORDS_PROTECTION_BODY = {
  required_status_checks: null,
  enforce_admins: false,            // 사람은 손으로 고칠 수 있어야 한다 — 이 브랜치는 기록이지 게이트가 아니다
  required_pull_request_reviews: null,
  restrictions: null,
  required_linear_history: false,
  allow_force_pushes: false,        // 이미 기록된 판정을 다시 쓰는 것이 위조의 모양이다
  allow_deletions: false,
  required_conversation_resolution: false,
};
/** 보호 PUT이 "그런 브랜치 없음"으로 실패했는가 — 첫 스테이지 런이 브랜치를 만들기 전에는 정상이다. */
export const GH_BRANCH_NOT_FOUND_RE = /\b404\b|not found|branch not found/i;

const secretNote = (label) => `gh secret set ${label} — bootstrap never writes secret values`;

/**
 * ADR-021 r1 MF-1 — CODEOWNERS 계획. 부트스트랩은 **사람의 손에서** 돈다(admin이 필요하다), 그래서
 * 머지 배우의 로그인을 여기서 알아낼 수 있다: `FACTORY_MERGE_TOKEN`이 로컬 env에 있으면 그 토큰으로
 * `gh api user`를 묻고, 없으면 지금 로그인한 gh 세션의 계정을 쓴다. **둘 중 어느 쪽이었는지는 반드시
 * 출력에 남는다**(`loginSource`) — 후자는 "지금 이 사람이 곧 머지 배우다"라는 가정이고, 그 가정이
 * 틀리면 CODEOWNERS가 엉뚱한 계정을 가리킨 채 모든 PR이 승인 불가가 된다.
 *
 * 로그인을 못 얻으면 **아무 것도 쓰지 않는다**. 자리표시자(`@<merge-actor-login>`)를 쓰는 쪽이
 * 훨씬 나빠 보이지만 실제로는 최악이다: 존재하지 않는 계정이 코드 오너면 그 저장소의 어떤 PR도
 * 승인될 수 없고(`enforce_admins: true`라 사람도 우회하지 못한다) 저장소가 통째로 잠긴다.
 */
function codeownersOps(existing) {
  const login = existing?.mergeActorLogin || null;
  const current = existing?.codeowners ?? null;
  const source = existing?.loginSource || "gh api user";
  if (!login) {
    return [{ kind: "note", message: `could not resolve the merge actor's login — ${CODEOWNERS_PATH} not written. Add it by hand: a single line \`* @<merge-actor-login>\` naming the FACTORY_MERGE_TOKEN account (never the agent actor). Without it \`require_code_owner_reviews\` has no owner to require and every PR becomes unapprovable (ADR-021 r1)` }];
  }
  const owners = codeownersOwners(current || "");
  if (owners.some((o) => o.toLowerCase() === login.toLowerCase())) {
    return [{ kind: "note", message: `${CODEOWNERS_PATH} already makes @${login} a code owner of \`*\` — leaving it as it is (resolved from ${source})` }];
  }
  return [
    { kind: "codeowners", path: CODEOWNERS_PATH, login, content: codeownersContent(login), replacing: current !== null },
    { kind: "note", message: `${CODEOWNERS_PATH}: @${login} is the sole code owner, resolved from ${source}. Commit and push it — GitHub reads CODEOWNERS from the **base branch**, so the rule does nothing until it is on ${"`"}main${"`"}. Verify it is the merge actor's account and NOT the agent actor's (ADR-021 r1)` },
  ];
}

/**
 * 부트스트랩 계획을 순수 함수로 만든다 — gh 호출은 전혀 하지 않는다.
 * 라벨: 카탈로그 전부를 항상 op으로 낸다(--force가 있어도 갱신 대상이라 existing.labels는 보고용일 뿐, 필터링에 쓰지 않는다).
 * protection: harness의 default_branch + 고정된 L0 contexts(`factory/integrity` 하나)로 body를 만든다.
 *   `harness.factory.required_checks`는 여기서 쓰지 않는다 — 그건 L1(머지 스테이지) 몫이다(ADR-015 보강).
 * variable: FACTORY_TOKEN_ISSUED_AT이 없을 때만 오늘 날짜로 세팅 — 있으면 값을 덮어쓰지 않고 note만 남긴다.
 * secrets: bootstrap은 값을 쓸 수 없으므로(비밀이라) 부재를 note로만 알린다.
 */
export function bootstrapPlan({ harness, today, existing, charter = null }) {
  const ops = LABELS.map((l) => ({ kind: "label", name: l.name, color: l.color, description: l.description }));

  // ADR-021 — 모드는 **관측된 시크릿 목록**에서 나온다(사람이 플래그로 고르지 않는다). 플래그였다면
  // "두 배우 모드라고 선언했지만 머지 토큰이 없어 머지가 영영 막힌 저장소"가 가능해진다.
  const twoActor = isTwoActor(existing?.secrets, existing?.envSecrets);
  ops.push({ kind: "protection", branch: harness.project.default_branch, twoActor, body: PROTECTION_BODY(L0_CONTEXTS, { twoActor }) });
  // 리뷰 batch-1 MF-2 — 리뷰 증거가 사는 브랜치. 실패해도 부트스트랩을 실패로 만들지 않는다
  // (브랜치가 아직 없거나 플랜이 지원하지 않는 것은 설정 오류가 아니다) — formatBootstrapFailure가
  // 그 두 경우를 이름으로 갈라 말한다.
  ops.push({ kind: "protection", branch: RECORDS_BRANCH, records: true, body: RECORDS_PROTECTION_BODY });

  // ADR-021 r1 — 두 배우 모드에서만 나오는 두 op. 단일 배우 모드에 이것들을 걸면 승인해 줄 두 번째
  // 계정이 없는 저장소에 "코드 오너 승인 필수"를 심는 셈이라 다크 머지가 영영 멈춘다.
  // ADR-021 r1 finding 2 — **CI는 모드를 스스로 관측할 수 없다.** `gh secret list`도
  // `GET …/branches/{b}/protection`도 repo admin을 요구하는데, sweeper가 쥔 것은 비-admin 봇
  // 토큰이다(그것이 이 설계의 전제다). 그래서 부트스트랩이 **자기가 관측한 사실**을 저장소 변수
  // 하나에 적어 둔다 — 사람이 고르는 플래그가 아니라 관측의 기록이다. doctor는 로컬에서 이 값을
  // 실제 시크릿 목록과 대조해 어긋나면 WARN한다(시크릿만 지우고 부트스트랩을 다시 안 돌린 경우).
  ops.push({ kind: "variable", name: TWO_ACTOR_VARIABLE, value: String(twoActor) });

  if (twoActor) {
    ops.push(...codeownersOps(existing));
    // 외부 감사 H6 — 환경 body가 두 가지를 싣는다: 시크릿을 보호 브랜치의 잡에만 주는
    // `deployment_branch_policy`(r1 MF-2 b)와, CHARTER가 그렇게 선언했을 때의 **사람 리뷰어 1명**.
    const humanGate = humanGateOf(charter);
    const reviewerId = existing?.mergeActorId ?? null;
    // 환경은 멱등하다(같은 body로 PUT을 반복해도 결과가 같다) — 존재 여부를 먼저 묻지 않는 이유다.
    ops.push({ kind: "environment", name: MERGE_ENVIRONMENT, body: mergeEnvironmentBody({ humanGate, reviewerId }) });
    if (humanGate && !Number.isInteger(reviewerId)) {
      ops.push({ kind: "note", message: `CHARTER \`merge.human_gate\` is on but the merge actor's numeric user id could not be resolved — the \`${MERGE_ENVIRONMENT}\` environment is created WITHOUT a required reviewer, so every merge job runs unattended. Add the reviewer by hand (repo Settings → Environments → ${MERGE_ENVIRONMENT} → Required reviewers) or re-run bootstrap with ${MERGE_TOKEN_SECRET} in your local env (audit H6)` });
    }
    ops.push({ kind: "note", message: humanGate
      ? `${MERGE_ENVIRONMENT} requires a human reviewer before every merge job starts${Number.isInteger(reviewerId) ? ` (user id ${reviewerId})` : ""} — CHARTER \`merge.human_gate: true\`. Each PR therefore carries one person's signature, not just the one-off token registration (audit H6)`
      : `${MERGE_ENVIRONMENT} has NO required reviewer — CHARTER declares \`merge.human_gate: false\`, so merges are fully dark: the only human signature in the whole loop is the one-off token registration. That is a deliberate owner choice and \`factory doctor\` says so on every run (\`merge.dark\`, audit H6)` });
  }

  const issuedAt = existing?.variables?.FACTORY_TOKEN_ISSUED_AT;
  if (issuedAt) {
    ops.push({ kind: "note", message: `FACTORY_TOKEN_ISSUED_AT already set to ${issuedAt} — leaving it (use --token-issued-at to force)` });
  } else {
    ops.push({ kind: "variable", name: "FACTORY_TOKEN_ISSUED_AT", value: today });
  }

  const secrets = existing?.secrets || [];
  if (!secrets.includes("FACTORY_BOT_TOKEN")) ops.push({ kind: "note", message: secretNote("FACTORY_BOT_TOKEN") });
  if (!secrets.includes("CLAUDE_CODE_OAUTH_TOKEN") && !secrets.includes("ANTHROPIC_API_KEY")) {
    ops.push({ kind: "note", message: secretNote("CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)") });
  }
  // ADR-021 — 어느 모드로 부트스트랩했는지는 **출력에서 읽을 수 있어야 한다**. 두 모드의 차이는
  // protection body 한 줄뿐이라 조용히 지나가면 사람이 "머지 권한이 여전히 에이전트 손에 있다"는
  // 사실을 모른 채로 운영하게 된다(그것이 단일 배우 모드의 실질적 위험이다).
  ops.push({ kind: "note", message: twoActor
    ? `two-actor mode: ${MERGE_TOKEN_SECRET} is set (as a repo secret and/or the \`${MERGE_ENVIRONMENT}\` environment secret) — the base branch requires 1 approving review FROM A CODE OWNER (${CODEOWNERS_PATH}), so no PR can be merged with the agent actor's token whoever authored it; the merge stage approves with the merge actor and then merges.`
    : `single-actor mode: no ${MERGE_TOKEN_SECRET} — merge power is reachable from agent stages and hooks are the only layer. Set ${MERGE_TOKEN_SECRET} (admin PAT, best kept as an environment secret in \`${MERGE_ENVIRONMENT}\`) + a non-admin FACTORY_BOT_TOKEN and re-run bootstrap for two-actor mode (ADR-021)` });

  // ADR-021 r2 (KTB-33 finding MF-A) — the mode can now be true purely from the environment secret,
  // which is the state the r1 advice above (and the owner checklist) actually recommends. A REPO-level
  // copy that is still there — whether or not it is ALSO in the environment — keeps the r1 MF-2 b risk
  // alive: a repository secret is handed to a workflow on ANY same-repo branch. Single-actor mode has
  // nothing to flag here (no merge token anywhere means nothing for a workflow to exfiltrate).
  if (twoActor && (existing?.secrets || []).includes(MERGE_TOKEN_SECRET)) {
    ops.push({ kind: "note", message: `${MERGE_TOKEN_SECRET} is still a repository secret; move it to the \`${MERGE_ENVIRONMENT}\` environment (\`gh secret set ${MERGE_TOKEN_SECRET} --env ${MERGE_ENVIRONMENT}\`) and delete the repo copy — a repository secret is readable by a workflow on ANY same-repo branch (ADR-021 r1)` });
  }

  return ops;
}

/**
 * 실패한 op 하나를 사람이 읽을 한 줄로 만든다 — 호출자(bootstrapCommand)가 `failed[]`를 순회하며 이 함수로
 * 딱 한 번만 찍는다. protection 실패가 GitHub Free 플랜 403이면(private repo에서는 branch protection API 자체가
 * 막힌다) "권한 문제"가 아니라 "이 플랜에서 못 함"이라는 걸 명시하고, L0가 꺼져도 L1(머지 스크립트의
 * allChecksGreen)·L2(경로 deny)는 그대로 강제된다는 걸 덧붙인다 — 사람이 "그래서 지금 아무 것도 안 지켜지냐"고
 * 오해하지 않게. 그 외 실패는 지금까지의 문구를 그대로 쓴다.
 */
export function formatBootstrapFailure({ op, error }) {
  // 리뷰 batch-1 MF-2 — 증거 브랜치의 보호는 두 가지 이유로 "실패"할 수 있고 둘 다 사고가 아니다.
  // 어느 쪽이든 **무엇이 꺼졌는지**를 말한다: 그 상태에서 리뷰 증거를 지키는 것은 훅 하나뿐이다.
  if (op.kind === "protection" && op.records) {
    if (GH_BRANCH_NOT_FOUND_RE.test(error)) {
      return `protection ${op.branch}: the branch does not exist yet — the first stage run creates it (records sync). Re-run \`factory bootstrap\` after that; until then the records branch is unprotected and the review evidence relies on the block-dangerous hook alone`;
    }
    if (GH_FREE_PLAN_PROTECTION_RE.test(error)) {
      return `protection ${op.branch}: records branch unprotected — not available on this plan (private repo on GitHub Free). The review evidence the merge stage checks against relies on hooks alone: make the repo public or upgrade to get force-push/deletion protection on ${op.branch}`;
    }
    return `protection ${op.branch}: records branch unprotected — ${error}. The review evidence the merge stage checks against relies on hooks alone until this is fixed`;
  }
  if (op.kind === "protection" && GH_FREE_PLAN_PROTECTION_RE.test(error)) {
    return `protection ${op.branch}: not available on this plan (private repo on GitHub Free) — make the repo public or upgrade; L0 required-check enforcement is off, L1 (merge script requires all checks GREEN) and L2 still apply`;
  }
  return `failed: ${op.kind} ${op.name || op.branch || ""} — ${error}`;
}

/**
 * ops를 실제로 적용한다. label/protection/variable만 gh를 부른다 — note는 보고만 하고 절대 gh를 건드리지 않는다.
 * harness는 받지 않는다 — protection op이 계획 단계에서 이미 branch/body를 다 갖춘 self-contained 객체라 필요 없다.
 * op마다 격리한다: 라벨 하나가 실패해도(권한/네트워크 등) 나머지 라벨·protection·variable은 계속 시도한다 — 부트스트랩은
 * 되돌릴 수 없는 단일 트랜잭션이 아니라 "최대한 맞춰놓기"이므로 한 실패가 전체를 막으면 안 된다. 실패는 failed[]에
 * 모아 반환하고, 종료 코드를 결정하는 건 호출자(bootstrapCommand) 몫이다.
 */
export async function applyBootstrap({ gh, ops, log = () => {}, writeFile = null }) {
  const applied = [];
  const failed = [];
  const notes = [];
  for (const op of ops) {
    try {
      switch (op.kind) {
        // ADR-021 r1 MF-1 — 유일하게 **디스크에** 쓰는 op다. gh가 아니라 파일이라 writeFile을 주입받는다
        // (호출자가 없으면 아무 것도 하지 않고 note만 남긴다 — 테스트/드라이런이 조용히 파일을 만들지 않게).
        case "codeowners":
          if (!writeFile) { notes.push(`${op.path} not written — no file writer wired into applyBootstrap`); break; }
          writeFile(op.path, op.content);
          log(`codeowners: ${op.path} → * @${op.login}${op.replacing ? " (replaced)" : ""}`);
          applied.push(op);
          break;
        // ADR-021 r1 MF-2 b — 환경 생성은 **실패해도 부트스트랩을 실패로 만들지 않는다.** GitHub Free의
        // private 저장소는 환경의 배포 브랜치 정책을 지원하지 않는다(환경 자체가 유료 기능이다) — 그것은
        // "설정이 틀렸다"가 아니라 "이 플랜에서 못 함"이고, 그때의 폴백은 오늘까지의 모습(저장소 시크릿)
        // 그대로다. 다만 그 폴백이 무엇을 되돌리는지는 **반드시 말한다**: 저장소 시크릿은 같은 저장소의
        // 어느 브랜치의 워크플로에서도 읽히므로, 에이전트가 워크플로 한 장으로 머지 토큰을 가져갈 수 있다.
        case "environment":
          try {
            await gh.putEnvironment(op.name, op.body);
            log(`environment: ${op.name} (default-branch deployments only)`);
            applied.push(op);
          } catch (e) {
            notes.push(`environment ${op.name} could not be created (${e.message}) — falling back to a REPOSITORY secret for ${MERGE_TOKEN_SECRET}. RISK: a repository secret is handed to a workflow running on ANY same-repo branch, so an agent that can push a workflow file onto its own branch can read the merge actor's admin PAT. Mitigations that remain: \`.github/**\` is a protected path (L1 human-merge), the agent PAT must not carry the \`workflow\` scope (doctor \`tokens.agent-workflow-scope\`), and \`merge-token-scope\` lints every workflow file (ADR-021 r1 MF-2)`);
          }
          break;
        case "label":
          await gh.createLabel({ name: op.name, color: op.color, description: op.description });
          log(`label: ${op.name}`);
          applied.push(op);
          break;
        case "protection":
          await gh.putBranchProtection(op.branch, op.body);
          log(`protection: ${op.branch}`);
          applied.push(op);
          break;
        case "variable":
          await gh.setVariable(op.name, op.value);
          log(`variable: ${op.name}=${op.value}`);
          applied.push(op);
          break;
        case "note":
          log(`note: ${op.message}`);
          notes.push(op.message);
          break;
        default:
          throw new Error(`applyBootstrap: unknown op kind "${op.kind}"`);
      }
    } catch (e) {
      // Do not also `log()` here — the caller (bootstrapCommand) prints each failure exactly once from the
      // returned `failed[]`, formatted per op kind (e.g. the GitHub-Free branch-protection 403 gets a dedicated
      // actionable line). Logging it here too used to double-print the same failure (once via log→io.out,
      // once via the caller's io.err loop).
      failed.push({ op, error: e.message });
    }
  }
  return { applied, failed, notes };
}
