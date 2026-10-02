import { matchesAny } from "./glob.js";

/**
 * ── 운영 세션의 비판정 경로 머지 (2026-10-02, 소유자 결정) ──────────────────────────────────────────
 *
 * 2026-10-01 하루에 사람에게 간 머지·재시도 요청 14건 중 사람의 **판단**이 필요했던 것은 0건이었다 — 문서 PR,
 * 리서치 기록, 운영 스크립트까지 전부 "훅이 운영 세션의 `gh pr merge`를 통째로 막아서" 사람이 서명 기계가 됐다
 * (ADR-032). 소유자 결정: **운영 세션**(사람의 Claude 세션 — CI 러너가 아니다)은 PR의
 * 모든 파일이 아래 **양의 목록**에 들고, 체크가 전부 GREEN이며, draft가 아니고, 기본 브랜치를 향할 때 그 PR을 머지할 수 있다.
 *
 * 목록은 **양의 목록**이다(S4 플랜 §2 S4a와 같은 이유 — `docs/research/s4-plan-debate.md`: 판정자 경로를 열거하면 샌다).
 * 여기 없는 경로는 전부 판정 경로다. 지금 목록은 S4a(KTB #149)의 `NON_JUDGE_GLOBS`보다 좁다 — 문서·리서치·운영 스크립트·
 * 보드 페이지뿐이고 엔진 소스는 하나도 없다. #149가 들어오면 두 목록을 하나로 합친다(이 파일이 그쪽을 import한다).
 *
 * 이 모듈은 **순수**하다: PR을 읽는 것(`gh pr view`)은 `bin/operator-merge-check.js`가 하고, 여기서는 읽은 것만 판정한다.
 * 훅(`hooks/block-dangerous.sh`)이 그 bin을 부르고 exit 0일 때만 `gh pr merge <n>`을 통과시킨다 — 훅은 그 밖의 모든 철자
 * (`gh api …/merge`, GraphQL, 복합 명령, `--admin`)를 여전히 막는다.
 */
export const OPERATOR_MERGE_GLOBS = Object.freeze([
  "docs/**",
  "templates/factory/docs/**",
]);
/** `docs/**` 안에서도 판정 경로인 것 — CHARTER는 규칙이고, runs는 러너가 쓰는 증거다(`[protected].runner_only`). */
export const OPERATOR_MERGE_EXCLUDES = Object.freeze([
  "docs/factory/CHARTER.md",
  "docs/factory/runs/**",
  "templates/factory/docs/factory/CHARTER.md",
]);

export const isOperatorMergePath = (p) => matchesAny(OPERATOR_MERGE_GLOBS, p) && !matchesAny(OPERATOR_MERGE_EXCLUDES, p);

const checkState = (c) => String(c?.conclusion ?? c?.state ?? "").toUpperCase();

/**
 * @param {object} pr `gh pr view --json number,isDraft,mergeable,baseRefName,files,statusCheckRollup`의 결과
 * @param {{defaultBranch?: string}} opts
 * @returns {{ok: boolean, reasons: string[], judge: string[]}}
 */
export function operatorMergeVerdict(pr, { defaultBranch = "main" } = {}) {
  const reasons = [];
  const files = Array.isArray(pr?.files) ? pr.files.map((f) => (typeof f === "string" ? f : f?.path)).filter(Boolean) : [];
  const judge = files.filter((p) => !isOperatorMergePath(p));
  if (!files.length) reasons.push("the PR lists no changed files — nothing to classify, so nothing to allow");
  if (judge.length) reasons.push(`judge path(s) in the PR — a person merges these: ${judge.slice(0, 8).join(", ")}${judge.length > 8 ? ", …" : ""}`);
  if (pr?.isDraft) reasons.push("the PR is a draft");
  if (String(pr?.mergeable ?? "").toUpperCase() !== "MERGEABLE") reasons.push(`the PR is not mergeable (${pr?.mergeable ?? "unknown"})`);
  if (pr?.baseRefName && pr.baseRefName !== defaultBranch) reasons.push(`the PR targets ${pr.baseRefName}, not ${defaultBranch} — stacked bases are how #150/#152 missed main`);
  const checks = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [];
  const notGreen = checks.filter((c) => !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(checkState(c)));
  if (notGreen.length) reasons.push(`check(s) not green: ${notGreen.map((c) => `${c.name || c.context || "?"}=${checkState(c) || "pending"}`).slice(0, 6).join(", ")}`);
  return { ok: reasons.length === 0, reasons, judge };
}
