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
 *
 * ── 리뷰 batch-2 MF-2: **그 한 줄은 어느 런의 것인가.** ─────────────────────────────────────────
 * batch-1의 모양에는 런 식별자가 아예 없었고(`head_sha`·`round`·`decision`·`verdicts`가 전부였다),
 * 파서는 파일의 **마지막** 줄을 골랐다. 그런데 `docs/factory/runs/**`는 no-write 스테이지의 스크래치
 * 경로라 에이전트 세션이 그 파일에 줄을 덧붙일 수 있었고(재리뷰가 rc=0으로 실행해 확인했다),
 * `syncRecords`는 그 파일을 **있는 그대로** `factory/records`로 민다 — 곧 implement/rework 에이전트가
 * 가짜 `## review · … ` 섹션을 마지막에 적어 두면 그것이 "권위 있는" 리뷰 증거가 됐다.
 * 그래서 두 가지를 동시에 건다:
 *   ① 줄이 **런을 지목한다**: `run_id=<GITHUB_RUN_ID>` + `runner=<FACTORY_RUNNER_ID>`.
 *   ② 파서는 **기대하는 런의 줄만** 돌려준다(`parseReviewEvidence(text, { runId })`) — "마지막 줄"이
 *      아니다. 머지 스테이지는 그 기대값을 이슈의 review 하트비트에서 독립적으로 읽는다.
 * 그리고 훅/ci-settings의 deny가 `[protected].runner_only`로 그 디렉터리를 에이전트에게서 닫는다.
 */
export const REVIEW_EVIDENCE_PREFIX = "review-evidence:";

/**
 * 러너 이름 → **런 식별자**. CI에서 워크플로가 넘기는 값은 `gha-<github.run_id>`이므로 러너 이름이
 * 곧 런 id를 담고 있다(그래서 하트비트 한 줄이 "이 판정을 만든 런"의 독립적 출처가 된다).
 * 로컬(`local/<host>`)처럼 run id가 없는 이름은 그 이름 자체가 식별자다 — 없는 값을 지어내지 않는다.
 */
export const runIdOfRunner = (runner) => {
  const s = String(runner ?? "").trim();
  if (!s || s === "none" || s === "unknown") return null;
  return /^gha-(\d+)$/.exec(s)?.[1] ?? s;
};

/** verdict 목록을 순서에 독립적인 정규형으로 — 같은 판정이 두 자리에서 같은 문자열이 되도록. */
export const normalizeVerdicts = (verdicts = []) =>
  (Array.isArray(verdicts) ? verdicts : [])
    .map((v) => `${String(v?.role ?? "?")}=${String(v?.verdict ?? "?")}`)
    .sort()
    .join(",");

/**
 * ── ADR-024 / KTB-42: `qa_manifest=<sha256>` ─────────────────────────────────────────────────
 * qa 증거 매니페스트(`.factory/out/qa/<issue>/manifest.json`)는 **커밋되지 않는다** — `.factory/out/`는
 * gitignore다. 그래서 머지 스테이지는 그 파일을 열 수 없고, "이 커밋에 대해 유효한 증거가 있었다"를
 * 말해 줄 수 있는 것은 review 런이 여기 남긴 지문 하나뿐이다. 필드는 **선택**이다(뒤에 붙는다):
 * 이 기능 이전의 기록과 로스터에 qa가 없는 tier의 기록은 그 필드 없이 그대로 읽혀야 한다.
 */
export function reviewEvidenceLine({ headSha, round, decision, verdicts = [], runId, runnerId, qaManifest = null, qaClaims = null }) {
  const base = `${REVIEW_EVIDENCE_PREFIX} run_id=${runId ?? "none"} runner=${runnerId ?? "none"} head_sha=${headSha ?? "none"} round=${round ?? "none"} decision=${decision ?? "none"} verdicts=${normalizeVerdicts(verdicts) || "none"}`;
  return `${base} qa_manifest=${qaManifest ?? "none"} qa_claims=${qaClaims ?? "none"}`;
}

const SECTION = /^##\s+(\S+)\s+·\s+(\S+)\s+·\s+(.+)$/;
const EVIDENCE = new RegExp(`^${REVIEW_EVIDENCE_PREFIX} run_id=(\\S+) runner=(\\S+) head_sha=(\\S+) round=(\\S+) decision=(\\S+) verdicts=(\\S*?)( qa_manifest=(\\S+?))?( qa_claims=(\\S+))?$`);

/**
 * run 기록 본문에서 **기대하는 런**(`runId`)이 쓴 review-evidence 줄을 그 섹션 헤더(스테이지·시각·
 * 러너)와 함께 읽는다. 없으면 null. 절대 throw하지 않는다 — 읽을 수 없는 기록은 "통과"가 아니라
 * 호출자의 fail-closed 재료다.
 *
 * **"마지막 줄"이 아닌 이유**(리뷰 batch-2 MF-2): 이 파일은 append-only이고 `syncRecords`가 로컬
 * 내용을 그대로 민다. 마지막 줄을 고르면 "가장 나중에 쓴 사람"이 이기고, 그 자리는 에이전트도 닿을 수
 * 있었다. 이제 고르는 기준은 순서가 아니라 **신원**이다 — 머지 스테이지가 이슈의 review 하트비트에서
 * 따로 읽은 런 id와 같은 줄만 돌려준다.
 *
 * 기대값이 없으면 **아무것도 돌려주지 않는다**(판정 불능은 "통과"가 아니다). 같은 런 id를 말하는 줄이
 * 둘 이상이고 내용이 서로 다르면 그것도 null이다 — 그 파일에 둘 중 하나를 지어낸 사람이 있다는 뜻이고,
 * 되돌릴 수 없는 단계 앞에서 둘 중 하나를 고를 근거가 우리에게 없다.
 */
export function parseReviewEvidence(text, { runId = null } = {}) {
  if (typeof text !== "string" || !text) return null;
  const want = runId === null || runId === undefined ? "" : String(runId).trim();
  if (!want || want === "none") return null;
  let section = null;
  const found = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const m = SECTION.exec(line);
    if (m) { section = { stage: m[1], at: m[2], runnerId: m[3].trim() }; continue; }
    const e = EVIDENCE.exec(line);
    if (!e) continue;
    if (e[1] !== want) continue;
    const round = Number(e[4]);
    found.push({
      stage: section?.stage ?? null,
      at: section?.at ?? null,
      // 섹션 헤더의 러너가 아니라 **줄 자신이 말하는** 러너다 — 헤더는 그 줄 앞에 아무나 놓을 수 있다.
      runnerId: e[2],
      sectionRunnerId: section?.runnerId ?? null,
      runId: e[1],
      headSha: e[3],
      round: Number.isInteger(round) ? round : null,
      decision: e[5],
      verdicts: e[6] === "none" ? "" : e[6],
      // KTB-42 — 없는 기록(이 기능 이전, 또는 qa 없는 로스터)은 null이다. "없음"과 "다름"을 호출자가
      // 구분할 수 있어야 한다: 전자는 로스터에 qa가 없을 때 정상이고, 후자는 언제나 판정 불가다.
      qaManifest: e[8] && e[8] !== "none" ? e[8] : null,
      // SF-3 — 구성(`3c/1na`). 판정에는 쓰이지 않는다: retro가 "전부 na에 가까운 승인"을 **셀 수**
      // 있게 하려고 남기는 관측값이다(계약이 막는 것은 *전부* na인 경우뿐이다).
      qaClaims: e[10] && e[10] !== "none" ? e[10] : null,
    });
  }
  if (!found.length) return null;
  const shape = (r) => `${r.stage}|${r.runnerId}|${r.headSha}|${r.round}|${r.decision}|${r.verdicts}|${r.qaManifest ?? "none"}|${r.qaClaims ?? "none"}`;
  if (new Set(found.map(shape)).size > 1) return null;
  return found[found.length - 1];
}
