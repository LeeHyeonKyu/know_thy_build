import { isTwoActor, MERGE_TOKEN_SECRET, MERGE_ENVIRONMENT, CODEOWNERS_PATH, codeownersOwners, codeownersMentions } from "../bootstrap.js";

/**
 * ADR-021 — **머지 권한이 어디에 있는가**를 다섯 줄로 보고한다. 나머지 doctor 체크와 달리 이것들은
 * "설정이 있는가"가 아니라 "에이전트가 쥔 토큰으로 base 브랜치를 바꿀 수 있는가"를 묻는다.
 *
 * 이 파일이 `doctor/factory.js`에서 떨어져 나온 이유는 **CI에서 혼자 돌 수 있어야 하기 때문이다**
 * (r1 finding 2). `doctor/factory.js`는 `../../cli/install.js`를 import하는데 `factory init`이 설치하는
 * 트리에는 `cli/`가 없다 — 곧 설치된 저장소의 `.factory/lib/doctor/factory.js`는 **로드조차 되지 않는다**.
 * 머지 권한 판정만 여기에 두면 `.factory/bin/doctor-ci.js`가 `.factory/lib/**`만으로 돌 수 있다.
 *
 * 1. `tokens.two-actor`(PASS) / `tokens.single-actor`(WARN) — 모드 자체. 단일 배우 모드는 **틀린
 *    설정이 아니다**(Free 플랜의 개인 저장소처럼 두 계정을 둘 수 없는 곳이 있다) — 그래서 WARN이다.
 *    r2(KTB-33 MF-A)부터 이 판정은 저장소 시크릿 OR `factory-merge` 환경 시크릿, 둘 중 하나다.
 * 1-b. `tokens.merge-token-repo-level`(WARN, 두 배우 모드에서만) — 토큰이 **여전히 저장소 시크릿으로
 *    남아 있는가**(환경에도 있든 없든). 남아 있으면 ADR-021 r1이 환경으로 옮긴 이유(같은 저장소
 *    어느 브랜치의 워크플로에도 저장소 시크릿이 주어진다)가 그대로 열려 있다는 뜻이다.
 * 2. `protection.two-actor` — 보호 규칙의 **모양이 모드와 맞는가**(승인 1건 + 코드 오너 요건).
 * 3. `protection.codeowners` — 그 승인을 줄 수 있는 계정이 **누구인가**(r1 MF-1).
 * 4. `tokens.agent-is-admin` — 에이전트 배우의 실제 저장소 권한.
 * 5. `tokens.agent-workflow-scope` — 에이전트 PAT에 classic `workflow` 스코프가 붙어 있는가(r1 MF-2 a).
 *
 * 4·5와 3의 절반(에이전트 로그인 대조)은 **CI에서만** 판정할 수 있다: `gh`가 봇 계정의 토큰으로 도는
 * 곳이 거기뿐이고, 사람의 로컬 `gh`는 사람 자신(대개 admin)이다. 로컬에서는 건너뛰되 **PASS가 아니라
 * WARN으로** 남긴다(r1 finding 2) — 한 번도 평가된 적 없는 불변식이 매 로컬 실행에서 초록으로 보이면,
 * 그 검사를 부르는 CI 잡이 아예 없다는 사실이 아무에게도 보이지 않는다(정확히 4fa2c7f의 상태였다).
 * 토큰 **값**은 어디에서도 읽지 않는다 — 보고하는 것은 로그인 이름·권한 등급·스코프 이름뿐이다.
 */
const c = (id, level, detail = "") => ({ id, level, detail });

/** CI에서 봇 토큰으로 도는가 — `tokens.*`의 실판정 조건. 값은 존재만 본다. */
export const isCiWithToken = (env) => Boolean(env?.CI && (env.FACTORY_BOT_TOKEN || env.GH_TOKEN));

const UNVERIFIED = "unverified until CI — this is checked by the sweeper's doctor step, where gh runs as the agent actor's bot account";

/**
 * ADR-021 r1 finding 2 — **CI는 모드를 스스로 관측할 수 없다**(`gh secret list`도 branch protection GET도
 * repo admin을 요구하고, 에이전트 배우는 admin이면 안 된다). 그래서 CI는 부트스트랩이 적어 둔 변수
 * `FACTORY_TWO_ACTOR`를 읽는데, 그 값이 **없을 수도 있다**(아직 부트스트랩을 안 돌렸거나 옛 저장소).
 *
 * 그때 FAIL을 그대로 찍으면 단일 배우 모드의 저장소에 영구 FAIL이 심기고, 이 스텝은 며칠 안에
 * "원래 빨간 것"이 되어 아무도 읽지 않는다 — 그것이 이 검사를 만든 이유를 그대로 되돌린다.
 * 그래서 FAIL을 WARN으로 낮추되 **왜 낮췄는지를 그 줄에 적는다**(조용히 낮추면 같은 실명이다).
 */
export function downgradeUnknownMode(checks, variableName) {
  return checks.map((c) => (c.level === "FAIL"
    ? { ...c, level: "WARN", detail: `${c.detail} [downgraded: ${variableName} is not set, so the mode is unknown — run \`factory bootstrap\`]` }
    : c));
}

export async function checkMergeAuthority({ gh, secrets, branch, protection, protectionUnavailable, env, codeowners = null }) {
  // ADR-021 r2 (KTB-33 finding MF-A) — the repo secret list alone is not the whole picture: the owner
  // checklist tells owners to move FACTORY_MERGE_TOKEN into the `factory-merge` environment and delete
  // the repo copy, and `gh secret list -R` never sees an environment secret. listEnvSecrets never
  // throws (404 / missing environment → []), so this is safe to call unconditionally.
  const envSecrets = await gh.listEnvSecrets(MERGE_ENVIRONMENT);
  const twoActor = isTwoActor(secrets, envSecrets);
  const out = [twoActor
    ? c("tokens.two-actor", "PASS", `${MERGE_TOKEN_SECRET} is set — merging the base branch needs a code-owner approval the agent actor cannot give`)
    : c("tokens.single-actor", "WARN", `merge power is reachable from agent stages; hooks are the only layer (set ${MERGE_TOKEN_SECRET} + a non-admin FACTORY_BOT_TOKEN for two-actor mode)`)];

  // r2 — a REPO-level copy left behind (whether or not it is also in the environment) keeps the r1
  // MF-2 b risk alive: a repository secret is handed to a workflow on ANY same-repo branch. Single-actor
  // mode has nothing to flag (no merge token anywhere means nothing for a workflow to exfiltrate).
  if (twoActor && (secrets || []).includes(MERGE_TOKEN_SECRET)) {
    out.push(c("tokens.merge-token-repo-level", "WARN", `${MERGE_TOKEN_SECRET} is still a repository secret; move it to the ${MERGE_ENVIRONMENT} environment (gh secret set ${MERGE_TOKEN_SECRET} --env ${MERGE_ENVIRONMENT}) and delete the repo copy`));
  }

  const reviews = protection?.required_pull_request_reviews;
  const approvals = reviews?.required_approving_review_count ?? 0;
  const codeOwnerReviews = Boolean(reviews?.require_code_owner_reviews);
  if (protectionUnavailable) {
    out.push(c("protection.two-actor", "WARN", "branch protection unavailable on this plan — merge authority cannot be split by permission here; hooks are the only layer (ADR-021)"));
  } else if (!protection) {
    out.push(c("protection.two-actor", "WARN", `no branch protection on ${branch} — run factory bootstrap`));
  } else if (twoActor) {
    if (approvals < 1) {
      out.push(c("protection.two-actor", "FAIL", `${MERGE_TOKEN_SECRET} is set but ${branch} requires no approving review — the agent actor can still merge its own PR. Run factory bootstrap to apply two-actor protection`));
    } else if (!codeOwnerReviews) {
      // r1 MF-1 — 수만 세는 규칙은 "작성자가 아닌 누군가"만 요구한다. write 협력자인 에이전트 배우는
      // 자기가 열지 않은 PR(사람·dependabot·머지 배우의 PR)에 커밋을 밀어 넣고 스스로 approve한 뒤
      // 머지할 수 있다 — 자기 PR 승인 금지 규칙은 그 경로에 전혀 걸리지 않는다.
      out.push(c("protection.two-actor", "FAIL", `${branch} requires ${approvals} approving review but NOT require_code_owner_reviews — counting approvals only asks for "somebody other than the author", so the agent actor can approve and merge any PR it did not author (after pushing its own commits onto that PR's head). Run factory bootstrap to add the code-owner requirement (ADR-021 r1 MF-1)`));
    } else {
      out.push(c("protection.two-actor", "PASS", `${branch}: ${approvals} code-owner approving review required, dismiss_stale_reviews=${Boolean(reviews?.dismiss_stale_reviews)}`));
    }
  } else {
    out.push(approvals >= 1
      ? c("protection.two-actor", "WARN", `${branch} requires ${approvals} approving review but there is no ${MERGE_TOKEN_SECRET} — no second account can approve the agent's own PR, so dark merge is impossible. Set ${MERGE_TOKEN_SECRET} or drop the review requirement`)
      : c("protection.two-actor", "PASS", "single-actor mode: no review requirement, as designed"));
  }

  out.push(...(await checkCodeowners({ gh, twoActor, codeowners, env })));
  out.push(...(await checkAgentToken({ gh, twoActor, env })));
  return out;
}

/**
 * r1 MF-1 — `require_code_owner_reviews`는 **소유자가 있어야** 무언가를 요구한다. 파일이 없거나
 * `*` 규칙의 소유자가 비어 있으면 두 배우 모드는 이름뿐이다(그리고 GitHub은 소유자가 없는 경로에
 * 코드 오너 승인을 요구하지 않는다 — 곧 카운트만 남아 MF-1이 그대로 열린다).
 *
 * 에이전트 로그인이 이 파일에 있는지는 **CI에서만** 확인할 수 있다: 그 로그인을 아는 방법이
 * "봇 토큰으로 `gh api user`를 부른다" 하나뿐이기 때문이다. 로컬에서는 파일이 있고 소유자가
 * 있다는 사실까지만 확인하고 WARN으로 남긴다 — PASS로 두면 "누가 코드 오너인지 아무도 확인하지
 * 않았다"가 초록으로 보인다.
 */
export async function checkCodeowners({ gh, twoActor, codeowners, env }) {
  if (!twoActor) {
    return [c("protection.codeowners", "PASS", `single-actor mode: ${CODEOWNERS_PATH} is not part of the rule (no second account to own the code)`)];
  }
  const text = codeowners;
  if (text == null) {
    return [c("protection.codeowners", "FAIL", `${CODEOWNERS_PATH} is missing — the base branch requires a code-owner approval and there is no code owner to give it. Run factory bootstrap (it writes \`* @<merge actor>\`), then commit and push it: GitHub reads CODEOWNERS from the base branch (ADR-021 r1 MF-1)`)];
  }
  const owners = codeownersOwners(text);
  if (!owners.length) {
    return [c("protection.codeowners", "FAIL", `${CODEOWNERS_PATH} has no owner for \`*\` — a path with no code owner needs no code-owner approval, so the requirement degrades back to "any one approval", which the agent actor can give on any PR it did not author. Run factory bootstrap (ADR-021 r1 MF-1)`)];
  }
  if (!isCiWithToken(env)) {
    return [c("protection.codeowners", "WARN", `${CODEOWNERS_PATH} owns \`*\` with ${owners.map((o) => `@${o}`).join(", ")}, but whether the AGENT actor is among them is ${UNVERIFIED}`)];
  }
  let login;
  try {
    login = await gh.viewerLogin();
  } catch (e) {
    return [c("protection.codeowners", "WARN", `could not read the agent actor's login to check ${CODEOWNERS_PATH} — ${e.message}`)];
  }
  const mentioned = codeownersMentions(text).map((m) => m.toLowerCase());
  if (mentioned.includes(login.toLowerCase())) {
    return [c("protection.codeowners", "FAIL", `${CODEOWNERS_PATH} names the AGENT actor (@${login}) as a code owner — it can then satisfy the code-owner requirement itself on every PR it did not author and merge it. Remove that line; the only owner must be the merge actor (ADR-021 r1 MF-1)`)];
  }
  return [c("protection.codeowners", "PASS", `\`*\` is owned by ${owners.map((o) => `@${o}`).join(", ")}; the agent actor (@${login}) is not a code owner`)];
}

/**
 * 에이전트 배우의 토큰에 대한 두 판정. 둘 다 CI에서만 의미가 있고, 로컬에서는 **WARN**으로 남는다.
 *
 * - `tokens.agent-is-admin` — admin/maintain이면 그 토큰으로 branch protection을 고쳐 승인 요건을
 *   지울 수 있으므로 두 배우 모드가 강제하는 것이 아무것도 없다(FAIL).
 * - `tokens.agent-workflow-scope` (r1 MF-2 a) — classic `workflow` 스코프가 붙어 있으면 에이전트는
 *   자기 브랜치에 `.github/workflows/<아무거나>.yml`을 **push할 수 있다**. 같은 저장소 브랜치에서
 *   도는 워크플로에는 저장소 시크릿이 그대로 주어지므로(fork 제한은 걸리지 않는다), 그 한 장이
 *   `FACTORY_MERGE_TOKEN`을 밖으로 실어 나른다 — 아무 것도 머지되지 않은 채로. 스코프를 빼면
 *   GitHub이 그 push 자체를 거부한다("refusing to allow a Personal Access Token to create or update
 *   workflow"). 스코프를 뺀 대가는 없다: 워크플로 변경은 어차피 사람이 머지하는 `factory:harness`
 *   PR의 몫이고, sweeper가 부르는 `gh workflow run`(Actions dispatch)은 classic `repo` 스코프로
 *   충분하다 — `workflow` 스코프가 지배하는 것은 **워크플로 파일의 쓰기**이지 실행이 아니다.
 */
export async function checkAgentToken({ gh, twoActor, env }) {
  if (!isCiWithToken(env)) {
    return [
      c("tokens.agent-is-admin", "WARN", `the agent actor's repo permission is ${UNVERIFIED}`),
      c("tokens.agent-workflow-scope", "WARN", `the agent PAT's scopes are ${UNVERIFIED}`),
    ];
  }
  const out = [];
  try {
    const login = await gh.viewerLogin();
    const permission = await gh.collaboratorPermission(login);
    const elevated = permission === "admin" || permission === "maintain";
    out.push(!elevated
      ? c("tokens.agent-is-admin", "PASS", `${login}: ${permission}`)
      : c("tokens.agent-is-admin", twoActor ? "FAIL" : "WARN", `${login} has ${permission} on this repo — an admin agent actor can rewrite branch protection, so ${twoActor ? "two-actor mode enforces nothing" : "nothing but hooks stands between it and a merge"}. Make the bot account a plain write collaborator (ADR-021)`));
  } catch (e) {
    out.push(c("tokens.agent-is-admin", "WARN", `could not read the agent actor's permission — ${e.message}`));
  }
  try {
    const scopes = await gh.viewerScopes();
    if (scopes === null) {
      out.push(c("tokens.agent-workflow-scope", "PASS", "not a classic PAT (no X-OAuth-Scopes header) — the classic `workflow` scope does not apply"));
    } else if (scopes.includes("workflow")) {
      out.push(c("tokens.agent-workflow-scope", twoActor ? "FAIL" : "WARN", `the agent PAT carries the classic \`workflow\` scope — it can push \`.github/workflows/<anything>.yml\` onto its own branch, and a workflow on a same-repo branch is handed the repository secrets, so ${MERGE_TOKEN_SECRET} leaves the repo without anything being merged. Reissue FACTORY_BOT_TOKEN with \`repo\` only; \`gh workflow run\` (the sweeper's dispatch) needs \`repo\`, not \`workflow\`. Also move the merge token into the \`${MERGE_ENVIRONMENT}\` environment (ADR-021 r1 MF-2)`));
    } else {
      out.push(c("tokens.agent-workflow-scope", "PASS", `scopes: ${scopes.join(", ") || "(none)"} — no \`workflow\` scope, so GitHub refuses any push that touches .github/workflows/**`));
    }
  } catch (e) {
    out.push(c("tokens.agent-workflow-scope", "WARN", `could not read the agent PAT's scopes — ${e.message}`));
  }
  return out;
}
