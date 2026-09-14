import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";

const short = (iso) => iso.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}(\.\d+)?Z$/, "$1Z"); // 2026-09-08T09:02:00Z → 2026-09-08T09:02Z; already-short values pass through unchanged

export function appendRunRecord({ root, issue, title = "", stage, runnerId, lines = [], now = new Date().toISOString() }) {
  const p = join(root, "docs/factory/runs", `${issue}.md`);
  mkdirSync(dirname(p), { recursive: true });
  if (!existsSync(p)) writeFileSync(p, `# Run · #${issue}${title ? " " + title : ""}\n`);
  appendFileSync(p, `\n## ${stage} · ${short(now)} · ${runnerId}\n${lines.join("\n")}\n`);
  return p;
}

/**
 * ── 리뷰 batch-1 MF-2 (H1b-b): **리뷰 증거에 출처를 붙인다.** ────────────────────────────────────
 *
 * 재리뷰가 재현한 체인: 머지 직전의 정족수 검사(`verifyReviewQuorum`)가 읽는 것은 review handoff
 * **코멘트 하나**인데, `gh issue comment`는 훅이 일부러 열어 둔 문이고(handoff·rework-response가
 * 그리로 나간다) `parseHandoffs`는 작성자조차 기록하지 않는다. 게다가 `creator.login` 대조는 두 번째
 * 권위가 아니다 — `FACTORY_BOT_LOGIN`이 곧 모든 스테이지 에이전트가 쥔 계정이다. 곧 all-approve
 * handoff를 손으로 지어내면 정족수 검사를 그대로 통과했다.
 *
 * 그래서 판정의 재료를 **에이전트가 쓸 수 없는 자리**에 한 줄 더 둔다: 스테이지가 `claude -p`가
 * **끝난 뒤에** 직접 쓰는 run 기록이고, 그 기록은 `factory/records` 브랜치로 나간다(에이전트 세션의
 * push는 훅이 막는다). 머지 스테이지는 handoff와 이 줄이 **같은 커밋·같은 판정**을 말할 때만 머지한다
 * (`review-quorum.js` `verifyReviewProvenance`).
 *
 * 한 줄짜리 평문인 이유: run 기록은 사람이 읽는 append-only 로그이고, 파서가 섹션 헤더와 이 한 줄만
 * 알면 되게 해야 `records-branch.js`의 꼬리 병합(줄 단위)과 부딪히지 않는다.
 */
export const REVIEW_EVIDENCE_PREFIX = "review-evidence:";

/** verdict 목록을 순서에 독립적인 정규형으로 — 같은 판정이 두 자리에서 같은 문자열이 되도록. */
export const normalizeVerdicts = (verdicts = []) =>
  (Array.isArray(verdicts) ? verdicts : [])
    .map((v) => `${String(v?.role ?? "?")}=${String(v?.verdict ?? "?")}`)
    .sort()
    .join(",");

export function reviewEvidenceLine({ headSha, round, decision, verdicts = [] }) {
  return `${REVIEW_EVIDENCE_PREFIX} head_sha=${headSha ?? "none"} round=${round ?? "none"} decision=${decision ?? "none"} verdicts=${normalizeVerdicts(verdicts) || "none"}`;
}

const SECTION = /^##\s+(\S+)\s+·\s+(\S+)\s+·\s+(.+)$/;
const EVIDENCE = new RegExp(`^${REVIEW_EVIDENCE_PREFIX} head_sha=(\\S+) round=(\\S+) decision=(\\S+) verdicts=(\\S*)$`);

/**
 * run 기록 본문에서 **마지막** review-evidence 줄을 그 섹션 헤더(스테이지·시각·러너)와 함께 읽는다.
 * 없으면 null. 절대 throw하지 않는다 — 읽을 수 없는 기록은 "통과"가 아니라 호출자의 fail-closed 재료다.
 */
export function parseReviewEvidence(text) {
  if (typeof text !== "string" || !text) return null;
  let section = null;
  let found = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const m = SECTION.exec(line);
    if (m) { section = { stage: m[1], at: m[2], runnerId: m[3].trim() }; continue; }
    const e = EVIDENCE.exec(line);
    if (!e) continue;
    const round = Number(e[2]);
    found = {
      stage: section?.stage ?? null,
      at: section?.at ?? null,
      runnerId: section?.runnerId ?? null,
      headSha: e[1],
      round: Number.isInteger(round) ? round : null,
      decision: e[3],
      verdicts: e[4] === "none" ? "" : e[4],
    };
  }
  return found;
}
