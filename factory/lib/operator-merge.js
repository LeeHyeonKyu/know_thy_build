import { NON_JUDGE_GLOBS, NON_JUDGE_EXCLUDES, isNonJudgePathIn, DOOR_FILES, isDoorFile } from "./non-judge-paths.js";

/**
 * ── 운영 세션의 비판정 경로 머지 (2026-10-02, 소유자 결정) ──────────────────────────────────────────
 *
 * 2026-10-01 하루에 사람에게 간 머지·재시도 요청 14건 중 사람의 **판단**이 필요했던 것은 0건이었다 — 문서 PR,
 * 리서치 기록, 운영 스크립트까지 전부 "훅이 운영 세션의 `gh pr merge`를 통째로 막아서" 사람이 서명 기계가 됐다
 * (ADR-032). 소유자 결정: **운영 세션**(사람의 Claude 세션 — CI 러너가 아니다)은 PR의
 * 모든 파일이 **비판정 경로의 양의 목록**에 들고, 체크가 전부 GREEN이며, draft가 아니고, 기본 브랜치를 향할 때 그 PR을 머지할 수 있다.
 *
 * #178 (S4a-1): **목록은 하나다.** 운영 세션의 머지 범위 = 비판정 경로 전부(ADR-032 §2). 이 파일은 글롭을 갖지 않고
 * `non-judge-paths.js`의 것을 그대로 재export한다 — 두 목록이 갈라질 자리가 없다. 여기 없는 경로는 전부 판정 경로다.
 *
 * 이 모듈은 **순수**하다: PR을 읽는 것(`gh pr view`)은 `bin/operator-merge-check.js`가 하고, 여기서는 읽은 것만 판정한다.
 * 훅(`hooks/block-dangerous.sh`)이 그 bin을 부르고 exit 0일 때만 `gh pr merge <n>`을 통과시킨다 — 훅은 그 밖의 모든 철자
 * (`gh api …/merge`, GraphQL, 복합 명령)를 여전히 막는다. `--admin`은 2026-10-02(#166)부터 허용 목록이다: 이 저장소의 브랜치 보호가
 * 공장 PR에만 생기는 상태를 요구해서 사람이 머지할 때도 정확히 그 권한으로 넘는다.
 */
export { NON_JUDGE_GLOBS as OPERATOR_MERGE_GLOBS, NON_JUDGE_EXCLUDES as OPERATOR_MERGE_EXCLUDES };

// ADR-039 — door의 자기 목록도 `non-judge-paths.js`가 쥔다(#178: 목록은 하나다). 여기서는 재export만.
export { DOOR_FILES, isDoorFile };
/**
 * 운영 세션의 문 = 저장소 맥락을 받는 비판정 판정 그대로(`isNonJudgePathIn`). 엔진 저장소(`engine: true`)에서만 판정 닫힘 밖의 엔진
 * 모듈이 열리고, 채택자 저장소(기본값)에서는 #178 이전과 같이 문서 쪽만 열린다 — 채택자 저장소의 설치된 엔진(.factory 아래)은 사람이
 * 머지한다(#178 rework cf1·arch1). 맥락은 `bin/operator-merge-check.js`가 `isEngineCheckout`으로 정해 넘긴다.
 */
export const isOperatorMergePath = (p, { engine = false } = {}) => isNonJudgePathIn(p, { engine });

const checkState = (c) => String(c?.conclusion ?? c?.state ?? "").toUpperCase();

/**
 * @param {object} pr `gh pr view --json number,isDraft,mergeable,baseRefName,files,statusCheckRollup`의 결과
 * @param {{defaultBranch?: string, engine?: boolean}} opts `engine`은 이 체크아웃이 엔진 저장소일 때만 `true`(기본 `false` — 닫힌 쪽)
 * @returns {{ok: boolean, reasons: string[], judge: string[]}}
 */
/**
 * ADR-039 — `judgeAllowed` (CHARTER `self_change.operator_merge_judge`): true면 판정 경로가 들어 있어도 거부하지 않는다. 그 경로
 * 목록은 그대로 `judge`로 돌려준다 — 호출자가 "무엇을 판정 없이 머지하는가"를 소리내어 적게(사유 줄). 나머지 자물쇠(draft·mergeable·
 * 기본 브랜치·체크 GREEN)는 스위치와 무관하게 그대로다.
 */
export function operatorMergeVerdict(pr, { defaultBranch = "main", engine = false, judgeAllowed = false } = {}) {
  const reasons = [];
  const files = Array.isArray(pr?.files) ? pr.files.map((f) => (typeof f === "string" ? f : f?.path)).filter(Boolean) : [];
  const judge = files.filter((p) => !isOperatorMergePath(p, { engine }));
  if (!files.length) reasons.push("the PR lists no changed files — nothing to classify, so nothing to allow");
  if (judge.length && !judgeAllowed) reasons.push(`judge path(s) in the PR — a person merges these: ${judge.slice(0, 8).join(", ")}${judge.length > 8 ? ", …" : ""}`);
  const door = files.filter(isDoorFile);
  if (door.length && judgeAllowed) reasons.push(`the door cannot open itself — a person merges a change to the operator door: ${door.join(", ")}`);
  if (pr?.isDraft) reasons.push("the PR is a draft");
  if (String(pr?.mergeable ?? "").toUpperCase() !== "MERGEABLE") reasons.push(`the PR is not mergeable (${pr?.mergeable ?? "unknown"})`);
  if (pr?.baseRefName && pr.baseRefName !== defaultBranch) reasons.push(`the PR targets ${pr.baseRefName}, not ${defaultBranch} — stacked bases are how #150/#152 missed main`);
  const checks = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [];
  const notGreen = checks.filter((c) => !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(checkState(c)));
  if (notGreen.length) reasons.push(`check(s) not green: ${notGreen.map((c) => `${c.name || c.context || "?"}=${checkState(c) || "pending"}`).slice(0, 6).join(", ")}`);
  return { ok: reasons.length === 0, reasons, judge };
}
