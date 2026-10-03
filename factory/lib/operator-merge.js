import { NON_JUDGE_GLOBS, NON_JUDGE_EXCLUDES, isNonJudgePathIn } from "./non-judge-paths.js";

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
 * (`gh api …/merge`, GraphQL, 복합 명령, `--admin`)를 여전히 막는다.
 */
export { NON_JUDGE_GLOBS as OPERATOR_MERGE_GLOBS, NON_JUDGE_EXCLUDES as OPERATOR_MERGE_EXCLUDES };
/**
 * 운영 세션의 문 = 저장소 맥락을 받는 비판정 판정 그대로(`isNonJudgePathIn`). 엔진 저장소(`engine: true`)에서만 판정 닫힘 밖의 엔진
 * 모듈이 열리고, 채택자 저장소(기본값)에서는 #178 이전과 같이 문서 쪽만 열린다 — 채택자 저장소의 설치된 엔진(.factory 아래)은 사람이
 * 머지한다(#178 rework cf1·arch1). 맥락은 `bin/operator-merge-check.js`가 `isEngineCheckout`으로 정해 넘긴다.
 */
export const isOperatorMergePath = (p, { engine = false } = {}) => isNonJudgePathIn(p, { engine });

const checkState = (c) => String(c?.conclusion ?? c?.state ?? "").toUpperCase();

/**
 * 경로 하나로 온전히 분류되는 변경 종류(GitHub `PatchStatus`). RENAMED·COPIED는 `PullRequestChangedFile`이 **새 경로만** 주므로
 * 원래 경로(판정 경로일 수 있다 — CHARTER를 문서 이름으로 옮기면 CHARTER가 사라진다)를 볼 수 없다. 없거나 모르는 값도 같은 이유로 닫힌다
 * (#178 rework cf3).
 */
const SINGLE_PATH_CHANGE_TYPES = ["ADDED", "MODIFIED", "DELETED", "CHANGED"];

const listed = (items, n = 8) => `${items.slice(0, n).join(", ")}${items.length > n ? ", …" : ""}`;

/**
 * @param {object} pr `gh pr view --json number,isDraft,mergeable,baseRefName,changedFiles,files,statusCheckRollup`의 결과
 * @param {{defaultBranch?: string, engine?: boolean}} opts `engine`은 이 체크아웃이 엔진 저장소일 때만 `true`(기본 `false` — 닫힌 쪽)
 * @returns {{ok: boolean, reasons: string[], judge: string[]}}
 */
export function operatorMergeVerdict(pr, { defaultBranch = "main", engine = false } = {}) {
  const reasons = [];
  const entries = Array.isArray(pr?.files) ? pr.files : [];
  const files = entries.map((f) => (typeof f === "string" ? f : f?.path)).filter(Boolean);
  const judge = files.filter((p) => !isOperatorMergePath(p, { engine }));
  if (!files.length) reasons.push("the PR lists no changed files — nothing to classify, so nothing to allow");
  // cf2: gh는 `files(first: 100)`만 읽고 페이지를 넘기지 않는다 — 목록이 PR의 changedFiles와 같을 때만 안 본 파일이 없다.
  const total = pr?.changedFiles;
  if (!Number.isInteger(total) || total < 0) reasons.push(`the PR's changedFiles count is missing or invalid (${JSON.stringify(total)}) — cannot tell whether the file list is complete`);
  else if (total !== entries.length) reasons.push(`gh lists ${entries.length} of ${total} changed files — files beyond the list were never classified, so a person merges this`);
  // cf3: 원래 경로가 보이지 않는 변경(이름 바꾸기·복사)이나 종류를 모르는 변경은 분류할 수 없다.
  const unseen = entries.filter((f) => !SINGLE_PATH_CHANGE_TYPES.includes(String(typeof f === "string" ? "" : f?.changeType ?? "").toUpperCase()));
  if (unseen.length) {
    const label = (f) => `${typeof f === "string" || f?.changeType == null ? "UNKNOWN" : String(f.changeType).toUpperCase()} ${typeof f === "string" ? f : f?.path}`;
    reasons.push(`file change type hides or omits the source path (only ${SINGLE_PATH_CHANGE_TYPES.join("/")} can be classified) — a person merges these: ${listed(unseen.map(label))}`);
  }
  if (judge.length) reasons.push(`judge path(s) in the PR — a person merges these: ${listed(judge)}`);
  if (pr?.isDraft) reasons.push("the PR is a draft");
  if (String(pr?.mergeable ?? "").toUpperCase() !== "MERGEABLE") reasons.push(`the PR is not mergeable (${pr?.mergeable ?? "unknown"})`);
  if (pr?.baseRefName && pr.baseRefName !== defaultBranch) reasons.push(`the PR targets ${pr.baseRefName}, not ${defaultBranch} — stacked bases are how #150/#152 missed main`);
  const checks = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [];
  const notGreen = checks.filter((c) => !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(checkState(c)));
  if (notGreen.length) reasons.push(`check(s) not green: ${notGreen.map((c) => `${c.name || c.context || "?"}=${checkState(c) || "pending"}`).slice(0, 6).join(", ")}`);
  return { ok: reasons.length === 0, reasons, judge };
}
