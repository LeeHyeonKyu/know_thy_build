import { aggregateReview } from "./aggregate.js";
import { normalizeVerdicts } from "./run-record.js";

/**
 * 거부 사유의 **접두어는 하나다** — 사후 조사와 테스트가 이 문자열 하나로 이 계열의 거부를 찾는다.
 */
export const NOT_BOUND = "review evidence not bound to a factory run";

const short = (s) => (typeof s === "string" && s.length >= 7 ? s.slice(0, 7) : String(s ?? "none"));

/**
 * ── 리뷰 batch-1 MF-2 (H1b-b) — **정족수 검사의 재료에 출처가 있는가.**
 *
 * `verifyReviewQuorum`은 handoff **내용**만 본다: head_sha도 verdicts도 round도 전부 에이전트가 적은
 * 값이고, 그 코멘트를 올린 계정은 모든 스테이지가 공유하는 봇이다(`creator.login` 대조가 두 번째
 * 권위가 되지 못하는 이유). 그래서 all-approve handoff를 손으로 지어내면 그대로 통과했다 —
 * 재리뷰가 재현한 H1 체인의 남은 절반이 이것이다.
 *
 * 이 함수가 묻는 것은 하나다: **그 handoff가 실제로 돈 review 런의 것인가.** 비교 대상은
 * `factory/records` 브랜치의 run 기록에 review 스테이지가 직접 쓴 `review-evidence:` 한 줄이다
 * (`run-record.js`). 그 줄은 `claude -p`가 **끝난 뒤** 러너가 쓰고, 에이전트 세션의
 * `git push … factory/records`는 훅이 막는다 — 곧 에이전트는 자기 판정을 미리 적어 둘 수 없다.
 *
 * **잔여 위험(반드시 소리 내어 말한다)**: 러너와 에이전트는 여전히 **같은 자격증명**을 쓴다. 훅이
 * 보지 못하는 철자(런타임 조립)나 훅 밖의 경로로 같은 push가 나갈 수 있다면 이 바인딩도 함께
 * 무너진다. 진짜 분리는 리뷰 증거를 다른 배우/Actions 실행 증명에 묶는 것이고, 그것은 이 주기 밖이다
 * (ADR-023 잔여 위험 #1).
 *
 * @param handoff    review.v1 handoff 본문(에이전트가 쓴 쪽)
 * @param record     `parseReviewEvidence()`가 records 브랜치 기록에서 읽은 줄(러너가 쓴 쪽) | null
 * @param prHeadSha  지금 이 순간의 PR head. 있으면 기록이 **그 커밋**의 것인지까지 묶는다.
 */
export function verifyReviewProvenance({ handoff, record, prHeadSha = null }) {
  if (!record) {
    return { ok: false, reason: `${NOT_BOUND} — there is no review-evidence line in this issue's run record on factory/records. The review stage writes it after \`claude -p\` exits, so a handoff without one was not produced by a factory review run` };
  }
  if (record.stage && record.stage !== "review") {
    return { ok: false, reason: `${NOT_BOUND} — the newest review-evidence line was written by the "${record.stage}" stage, not by review` };
  }
  if (!record.headSha || record.headSha === "none") {
    return { ok: false, reason: `${NOT_BOUND} — the review-evidence line names no commit` };
  }
  if (prHeadSha && record.headSha !== prHeadSha) {
    return { ok: false, reason: `${NOT_BOUND} — the review run checked out ${short(record.headSha)}, but the PR head is ${short(prHeadSha)}` };
  }
  if (handoff?.head_sha !== record.headSha) {
    return { ok: false, reason: `${NOT_BOUND} — the handoff claims ${short(handoff?.head_sha)} but the review run record says ${short(record.headSha)}` };
  }
  const claimed = normalizeVerdicts(handoff?.verdicts);
  if (claimed !== record.verdicts) {
    return { ok: false, reason: `${NOT_BOUND} — the handoff's verdicts (${claimed || "none"}) are not the ones the review run recorded (${record.verdicts || "none"})` };
  }
  if (Number.isInteger(record.round) && Number.isInteger(handoff?.round) && record.round !== handoff.round) {
    return { ok: false, reason: `${NOT_BOUND} — the handoff says round ${handoff.round}, the review run recorded round ${record.round}` };
  }
  return { ok: true };
}

/**
 * 외부 감사 2026-09-14 H1c — **"리뷰가 통과했다"를 판정하는 자리는 하나여야 한다.**
 *
 * 감사 전에는 그 판정이 두 벌로 흩어져 있었다: `requirements.js`의 `factory:approved` 규칙(정족수 +
 * all-approve)과, 머지 직전에는 **아무것도**. `factory:merged` 규칙은 `need(review)`로 handoff가
 * 있는지만 보고 정족수를 다시 묻지 않았고, `merge-stage.js`는 `mergePr` 전에 리뷰 증거를 전혀 보지
 * 않았다(`:476` merge → `:487` transition — 규칙은 이미 머지된 뒤에 평가된다). 그래서 위조한 review
 * handoff 코멘트 하나 + 위조한 commit status 하나면 리뷰어가 한 번도 뜨지 않고 main에 들어갔다.
 *
 * 이 모듈이 그 판정의 유일한 출처다. 세 자리가 같은 함수를 부른다:
 *   1. `requirements.js` `factory:approved` — 라벨 전이(K는 묻지 않는다, 아래)
 *   2. `requirements.js` `factory:merged`   — 머지 라벨 전이(K까지 묻는다)
 *   3. `merge-stage.js`                     — `approvePr`/`mergePr` **앞**(K까지 묻는다)
 *
 * **handoff의 `decision`은 절대 믿지 않는다.** 그 필드는 리뷰 워크플로가 자기 성적표에 적은 값이다 —
 * 판정은 언제나 `must_fix`에서 `aggregate.js`로 **다시 계산한다**(감사가 "잘 된 것"으로 꼽은 바로 그
 * 불변식을, 이제 머지 경로에도 건다).
 *
 * **K(라운드 한도)는 옵션이다**(ADR-020 KTB-29 r1 SF1): `factory:approved`는 K를 묻지 않는다 —
 * K는 실패를 끊는 한도이지 성공을 막는 한도가 아니고, 라운드 4의 만장일치 통과가 그래프에서 튕기면
 * 이슈가 `awaiting-review`에 남아 훨씬 느리고 시끄럽게 사람에게 올라간다. 하지만 **머지**는 다르다:
 * KTB-29 이후 `nextState`가 `round >= K`인 rework을 곧장 needs-human으로 보내므로, 정상 경로에서
 * `round > K`인 approve는 **만들어질 수 없다** — 그런 handoff는 정의상 이 그래프를 거치지 않고 생긴
 * 것(=위조이거나 옛 흐름의 잔재)이고, 되돌릴 수 없는 단계 앞에서 그것을 통과시킬 이유가 없다.
 *
 * @param data       review.v1 handoff 본문(스키마 검증은 호출자 몫 — 여기서는 내용만 본다)
 * @param rosterSize 이 tier의 로스터 크기. null이면 개수 검사를 건너뛴다(호출자가 로스터를 모를 때).
 * @param rosterRoles 로스터 이름들. 있으면 "개수는 맞는데 한 역할이 두 번 냈다"까지 걸린다.
 * @param maxRounds  K. null/비정수면 라운드 검사를 건너뛴다.
 * @param prHeadSha  PR head. 있으면 handoff가 **그 커밋**에 대한 판정인지까지 묶는다.
 * @returns { ok: true } | { ok: false, reason }
 */
export function verifyReviewQuorum({ data, rosterSize = null, rosterRoles = [], maxRounds = null, prHeadSha = null }) {
  if (!data) return { ok: false, reason: "review handoff missing" };

  if (prHeadSha && data.head_sha !== prHeadSha) {
    return { ok: false, reason: `review handoff head_sha ${String(data.head_sha ?? "none").slice(0, 7)} != PR head ${prHeadSha.slice(0, 7)}` };
  }

  const verdicts = Array.isArray(data.verdicts) ? data.verdicts : [];
  if (rosterSize != null && verdicts.length !== rosterSize) {
    return { ok: false, reason: `verdict count ${verdicts.length} != roster size ${rosterSize}` };
  }

  // verdict 한 줄이 reject면 그것으로 끝이다 — 가장 흔한 실패라 사유도 가장 짧아야 한다.
  if (!verdicts.every((v) => v?.verdict === "approve")) return { ok: false, reason: "not all approve" };

  // 그리고 **모두 approve여도** 판정은 다시 계산한다: `rulings`의 uphold가 must_fix를 되살릴 수 있고
  // (`aggregate.js`), 역할이 중복되면 개수가 맞아도 로스터가 비어 있다. 자기 신고(`data.decision`)는
  // 어느 갈래에서도 읽지 않는다.
  const roles = Array.isArray(rosterRoles) ? rosterRoles : [];
  const agg = aggregateReview({
    verdicts,
    rosterSize: rosterSize ?? verdicts.length,
    rosterRoles: roles,
    rulings: Array.isArray(data.rulings) ? data.rulings : [],
  });
  if (agg.decision === "incomplete") {
    const missing = agg.missing_roles.length ? agg.missing_roles.join(", ") : "verdict count below roster size";
    return { ok: false, reason: `review incomplete — ${missing}` };
  }
  if (agg.decision !== "approved") {
    const ids = agg.must_fix.map((m) => m.id).join(", ");
    const claimed = data.decision ? ` (the handoff claims "${data.decision}")` : "";
    return { ok: false, reason: `review decision recomputed from must_fix is "${agg.decision}"${claimed} — ${agg.must_fix.length} must_fix item(s): ${ids}` };
  }

  if (Number.isInteger(maxRounds) && maxRounds >= 1) {
    if (!Number.isInteger(data.round)) return { ok: false, reason: `review round is not a number (${JSON.stringify(data.round)}) — cannot check it against K=${maxRounds}` };
    if (data.round > maxRounds) return { ok: false, reason: `review round ${data.round} > K=${maxRounds}` };
  }

  return { ok: true };
}
