import { latestHandoff } from "./handoff.js";
import { rosterFor } from "./config.js";
import { maxTier } from "./gates.js";

/**
 * KTB-46 r4 — sweeper 쪽 주입점. review handoff가 실어 둔 `tier_effective`(리뷰 런이 `resolveTier`로
 * 계산한 값)를 선언 tier와 합쳐 **둘 중 높은 쪽**을 돌려준다. `maxTier`는 모르는 값을 `standard`로
 * 보수적으로 정규화하므로, 손상된 handoff가 tier를 끌어내리지 못한다.
 */
export const tierFromReviewHandoff = (tier) => async (declared) => ({
  tier_effective: maxTier(declared, tier),
  tier_source: "review handoff tier_effective (H3, recorded by the review run)",
});

/**
 * **이 이슈의 리뷰 로스터** — 정족수(`verifyReviewQuorum`의 `rosterSize`/`rosterRoles`)의 유일한 출처.
 *
 * 선언 tier는 이슈에 남은 triage handoff가 말하고(없으면 CHARTER의 `tier_default`), 실효 tier는
 * 주입된 `effectiveTier`가 정한다 — 감사 H3의 판결이다: "docs"라고 자기 신고한 이슈가 load-bearing
 * 경로를 건드리면 리뷰어 한 명으로 정족수가 차면 안 된다.
 *
 * 주입점이 하나인 대신 **출처는 둘**이다:
 *   - merge 스테이지는 `resolveTier`를 주입해 `base...HEAD` diff에서 직접 바닥을 계산한다.
 *   - sweeper의 사람-머지 반영 팔(KTB-46)은 그 diff를 다시 낼 수 없다 — squash 머지와 함께
 *     `claude/fq-<n>`이 지워졌다. 대신 **review 스테이지가 이미 계산해 둔 값**을 읽는다: 그 PR head에
 *     묶인 review handoff의 `tier_effective`다(리뷰 런이 `resolveTier`로 만들어 실은 바로 그 숫자).
 *     그리고 `maxTier(선언, handoff)`로 합친다 — 어느 쪽보다도 작아지지 않는다(r4). 다시 계산하는
 *     것이 아니라 **기록된 계산을 읽는 것**이라, 파이프라인을 탄 PR에서는 두 문의 로스터가 같다.
 *
 * 1.2 이전 기록에는 그 필드가 없다. 그때는 선언 tier로 내려가고, 팔이 `human-merged-note` 한 줄로
 * "이번에는 parity를 확인할 수 없었다"고 **소리 내어** 말한다 — 조용히 약해지지 않는 것이 요점이다.
 *
 * KTB-46 r3 — 이 함수가 생긴 이유는 그 두 호출자가 **같은 해석**을 써야 하기 때문이다. 판정이 두
 * 벌이면 사람이 머지한 PR을 잇는 문이 팩토리 자신의 머지 문보다 싸질 수 있다(리뷰 must_fix 1이
 * 실제로 그랬다: sweeper가 로스터를 안 넘겨 1-of-4 approve가 통과했다).
 *
 * 실패(handoff 파싱·CHARTER 읽기·tier 계산)는 전부 `{ ok:false, reason }`이다 — 호출자는 그것을
 * "로스터를 확인 못 했다"로 읽고 fail closed 한다(빈 로스터를 통과로 읽지 않는다).
 */
/**
 * `roles`는 `roles.toml`의 파싱 결과이거나 **그것을 읽는 함수**다(r5 nit 6). 후자를 받는 이유는
 * `loadRoles(root)`가 인자 자리에서 평가되면 그 파일이 깨졌을 때 예외가 이 함수의 catch **밖으로**
 * 빠져나가, 호출자가 `ok:false, reason` 대신 원시 예외를 받기 때문이다 — 두 문(merge 스테이지와
 * sweeper)이 같은 실패에 다른 문장을 내게 된다. 함수로 넘기면 읽기도 이 try 안에서 일어난다.
 */
export async function resolveReviewRoster({ charter, roles, comments, effectiveTier = null }) {
  try {
    const roleDefs = typeof roles === "function" ? roles() : roles;
    const declared = latestHandoff(comments, "triage")?.data?.tier ?? charter.tier_default;
    const t = effectiveTier
      ? await effectiveTier(declared)
      : { tier_effective: declared, tier_source: "declared" };
    return { ok: true, roles: rosterFor(charter, roleDefs, "review", t.tier_effective), tier: t.tier_effective, tier_declared: declared, tier_source: t.tier_source };
  } catch (e) {
    return { ok: false, reason: `review roster for this tier could not be resolved — ${e?.message || e}` };
  }
}
