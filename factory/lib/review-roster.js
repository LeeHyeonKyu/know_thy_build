import { latestHandoff } from "./handoff.js";
import { rosterFor } from "./config.js";

/**
 * **이 이슈의 리뷰 로스터** — 정족수(`verifyReviewQuorum`의 `rosterSize`/`rosterRoles`)의 유일한 출처.
 *
 * 선언 tier는 이슈에 남은 triage handoff가 말하고(없으면 CHARTER의 `tier_default`), 실효 tier는
 * 주입된 `effectiveTier`가 정한다 — 감사 H3의 판결이다: "docs"라고 자기 신고한 이슈가 load-bearing
 * 경로를 건드리면 리뷰어 한 명으로 정족수가 차면 안 된다. merge 스테이지는 `resolveTier`를 주입해
 * `base...HEAD` diff로 tier를 올리고, sweeper의 사람-머지 반영 팔(KTB-46)은 주입하지 않는다: 그
 * diff의 한쪽 끝인 `claude/fq-<n>`은 squash 머지와 함께 이미 지워졌고, 없는 것을 지어내는 것보다
 * **선언 tier로 내려가는 것**이 맞다(그 경우 로스터가 더 작을 수는 있어도, 지금처럼 로스터가 아예
 * 없어 정족수 검사가 통째로 무음이 되는 것보다는 언제나 엄격하다).
 *
 * KTB-46 r3 — 이 함수가 생긴 이유는 그 두 호출자가 **같은 해석**을 써야 하기 때문이다. 판정이 두
 * 벌이면 사람이 머지한 PR을 잇는 문이 팩토리 자신의 머지 문보다 싸질 수 있다(리뷰 must_fix 1이
 * 실제로 그랬다: sweeper가 로스터를 안 넘겨 1-of-4 approve가 통과했다).
 *
 * 실패(handoff 파싱·CHARTER 읽기·tier 계산)는 전부 `{ ok:false, reason }`이다 — 호출자는 그것을
 * "로스터를 확인 못 했다"로 읽고 fail closed 한다(빈 로스터를 통과로 읽지 않는다).
 */
export async function resolveReviewRoster({ charter, roles, comments, effectiveTier = null }) {
  try {
    const declared = latestHandoff(comments, "triage")?.data?.tier ?? charter.tier_default;
    const t = effectiveTier
      ? await effectiveTier(declared)
      : { tier_effective: declared, tier_source: "declared" };
    return { ok: true, roles: rosterFor(charter, roles, "review", t.tier_effective), tier: t.tier_effective, tier_declared: declared, tier_source: t.tier_source };
  } catch (e) {
    return { ok: false, reason: `review roster for this tier could not be resolved — ${e?.message || e}` };
  }
}
