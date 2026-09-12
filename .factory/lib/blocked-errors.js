/**
 * merge-base를 못 구하면 이번 런의 "무엇과 비교했는가"가 통째로 없다 — diff·integrity·prove-test가
 * 전부 근거를 잃는다. RED도 GREEN도 아닌 판정 불가이므로 typed error로 올려 blocked로 끝낸다.
 * run-stage.js(implement/review/plan)와 lib/merge-stage.js(merge)가 함께 쓰는 타입이라 여기 lib에 둔다 —
 * bin에 두면 merge-stage가 bin을 다시 import하는 순환 참조가 생긴다.
 */
export const MERGE_BASE_BLOCKED_REASON = "cannot compute merge-base (shallow clone?)";
export const MERGE_BASE_ERROR_CODE = "FACTORY_MERGE_BASE";
export class MergeBaseError extends Error {
  constructor(detail = "") {
    super(MERGE_BASE_BLOCKED_REASON + (detail ? ` — ${detail}` : ""));
    this.name = "MergeBaseError";
    this.code = MERGE_BASE_ERROR_CODE;
  }
}
export const isMergeBaseError = (e) => e?.code === MERGE_BASE_ERROR_CODE;

/** diff를 못 읽는 것도 판정 불가다 — merge-base와 같은 사유로 blocked로 끝낸다. */
export const GIT_DIFF_BLOCKED_REASON = "cannot compute diff";
