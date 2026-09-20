#!/usr/bin/env node
// retro 잡(§8.1/§8.3/§8.4) — 라벨 상태 머신 밖에서 **머지 이벤트로만** 깨어난다(P4-R5).
// 매 머지마다 경량 수확(결정적, LLM 없음)을 하고, 누적 머지가 N에 도달하면 전체 retro를 돈다:
// `claude -p "/factory-retro"`가 후보를 보고 `factory.retro.v1`로 제안을 내놓고, **채택 여부는 전부
// 여기(L1)가 판정한다**(P4-R4 — 에이전트가 "채택"이라 해도 근거를 세지 못하면 채택하지 않는다).
//
// 세 가지 불변식:
//  1. **retro는 절대 라벨을 옮기지 않고 코드를 고치지 않는다.** 산출은 lessons/역할 예시·관점의 다크
//     append PR(자체 머지), 사람이 머지하는 제안 PR, 이슈 생성, `quarantine.toml`·`_retro.md` 갱신뿐이다.
//  2. **retro 실패는 공장을 멈추지 않는다.** 전체 분석이 죽거나 스키마를 어기면 `_retro.md`에
//     `last_full_failed`를 남기고 exit 0으로 물러난다 — `merges_since`를 리셋하지 않으므로 다음 머지가
//     다시 시도한다. 집행 단계도 각각 격리돼서, 한 단계의 실패가 나머지 단계를 막지 않는다.
//  3. **`_retro.md`의 이력은 조용히 사라지지 않는다.** 세 겹으로 막는다:
//     (a) 상태 파일이 손상됐으면(파서가 던진다) 아무것도 쓰지 않고 exit 2 — 사람의 몫이다.
//     (b) 하이드레이트가 브랜치 내용을 **확정하지 못했으면**(fetch 실패, 부분 읽기 실패) 역시 아무것도
//         쓰지 않고 exit 2 — `readRecords`는 절대 던지지 않으므로 실패한 회차가 "기록 없음"처럼 보이고,
//         그 기본 상태를 교체 동기화가 브랜치의 진짜 상태 위에 밀어버린다(fix round 1, Critical).
//     (c) 동기화는 하이드레이트한 blob sha를 걸고 교체한다(`expectBlob`) — 그 사이 다른 retro가 상태를
//         밀었으면 새 상태를 다시 읽어 같은 변이를 그 위에 얹고 한 번만 재시도하고, 그래도 움직였으면
//         덮어쓰지 않고 exit 1로 시끄럽게 실패한다.
//
// 모든 외부 접촉(fs·git·gh·claude)은 `deps`로 주입된다 — `runRetro`는 순수 오케스트레이션이고,
// `main()`이 실제 의존성을 조립한다(bin/run-stage.js와 같은 형태).

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { loadCharter, loadHarness, loadRoles, upstreamRepoOf } from "../lib/config.js";
import { routeMergedIssues } from "../lib/feedback/route.js";
import { loadInstallManifest, INSTALL_MANIFEST_PATH } from "../lib/feedback/install-manifest.js";
import { loadQuarantine, saveQuarantine } from "../lib/quarantine.js";
import { readRecordsDetailed, syncRecords } from "../lib/records-branch.js";
import { validate } from "../lib/schemas.js";
import { extractStageArtifact, readTranscript } from "../lib/stage-artifact.js";
import { harvest as harvestRecords, mergeCandidates } from "../lib/retro/harvest.js";
import { applyLessons as applyLessonsText } from "../lib/retro/lessons.js";
import { detectMaturityGaps } from "../lib/retro/maturity.js";
import { filterByEvidence, renderProposalPr } from "../lib/retro/proposals.js";
import { openAndMergeLessonsPr, openProposalPr } from "../lib/retro/publish.js";
import {
  deletionCandidates, expiredFromComments, quarantineComment,
  registerFromFlakyIssues, rewriteIssuesForExpired,
} from "../lib/retro/quarantine-ops.js";
import { applyRoleAdditions as applyRoleAdditionsText } from "../lib/retro/role-additions.js";
import { nextN, parseRetroState, renderRetroState, shouldRunFull } from "../lib/retro/state.js";
import { stageMaxTurns } from "./run-stage.js";
import { hitApiError, apiErrorReason } from "../lib/verify-stage.js";
import { HARNESS_LABEL } from "../lib/label-catalog.js";
export { HARNESS_LABEL };   // 재수출 — run-stage.js와 이 값이 같은 소스에서 왔다는 것을 테스트가 import equality로 확인한다

const QUEUE_LABEL = "factory:queue";
const FLAKY_LABEL = "factory:flaky";
const PROPOSAL_LABEL = "factory:retro-proposal";
const MIN_EVIDENCE = 2;                                               // lesson·예시·관점의 최소 근거 run(§8.4)
const TITLE_MAX = 240;                                                // GitHub 이슈 제목 여유 — 자르기는 결정적이라 dedup을 깨지 않는다
const STATE_FILE = "_retro.md";                                       // records dir 기준 — 교체 동기화의 대상
// 제안 PR 본문 첫 줄의 기계 마커(proposals.js가 쓴다) — 같은 창의 제안 PR을 두 번 열지 않는 dedup 키다.
const RETRO_MARKER = /<!-- factory-retro:v1 period=\S+ -->/;

/** 후보 목록의 빈 값. 함수로 둔다 — 상수 객체를 퍼뜨리면 한 실행의 push가 다음 실행에 새어 나간다. */
export const emptyCandidates = () => ({ lessons: [], examples: [], flaky: [], needs_human: [] });

/** `now`(ISO)를 브랜치·파일 이름에 쓰는 `YYYY-MM-DD-HHMM`으로. UTC로만 — 러너의 TZ와 무관하게 같은 값. */
export function stampOf(now) {
  const t = Date.parse(now);
  const d = Number.isFinite(t) ? new Date(t) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}
/** lesson id(`L-YYYY-MM-DD-NN`)의 날짜 부분. */
export const todayOf = (now) => stampOf(now).slice(0, 10);

/**
 * 제안 PR의 기간은 **날짜**로 쓴다(§8.3 `period=2026-09-01..2026-09-07`) — 커서는 delta 계산을 위해
 * 타임스탬프지만, 사람이 읽는 PR 제목·본문과 `proposals.js`의 ISO 주 계산(`isoWeek`)은 `YYYY-MM-DD`를
 * 전제한다. 타임스탬프를 그대로 넘기면 주차가 계산되지 않고 제목이 기계 문자열이 된다.
 */
export const ymdOf = (v) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? ""));
  return m ? m[1] : todayOf(v);
};

/**
 * run 기록의 가장 오래된 섹션 시각 — retro가 한 번도 돈 적 없을 때의 `period.from`이다.
 * 섹션 헤더는 `## <stage> · <iso> · <runner>`(run-record.js) — 코멘트 타임스탬프가 아니라 **기록**에서
 * 읽는다: 기간은 "공장이 무엇을 했는가"의 창이고 그 사실의 출처는 run 기록이다(`_retro`는 건너뛴다).
 */
export function earliestRecordAt(records) {
  const map = records instanceof Map ? records : new Map(Object.entries(records || {}));
  let best = null;
  let bestMs = Infinity;
  for (const [issue, text] of map) {
    if (issue === "_retro") continue;
    for (const m of String(text ?? "").matchAll(/^## \S+ · (\S+) · /gm)) {
      const ms = Date.parse(m[1]);
      if (!Number.isFinite(ms) || ms >= bestMs) continue;
      bestMs = ms;
      best = m[1];
    }
  }
  return best;
}

/** 서로 다른 근거 run 수 — `String(r)`로 정규화한다(에이전트가 110과 "110"을 섞어도 창은 한 번만 찬다). */
export const distinctRuns = (runs) => new Set((Array.isArray(runs) ? runs : []).map((r) => String(r))).size;

/**
 * 외부 감사 2026-09-14 M10/M11 — 근거로 적힌 run 중 **records 브랜치에 없는** 것들. 비어 있으면
 * 모두 실재한다는 뜻이다. `known`이 비어 있으면(기록이 하나도 없는 저장소) 검사를 걸지 않는다 —
 * 첫 retro에서 모든 제안을 거부해 버리면 그 회차가 통째로 무의미해지고, 그때의 "근거 없음"은
 * 에이전트의 지어냄이 아니라 이 저장소에 아직 run 기록이 없다는 사실이기 때문이다.
 */
export function unknownRuns(runs, known) {
  if (!(known instanceof Set) || known.size === 0) return [];
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(runs) ? runs : []) {
    const k = String(r);
    if (seen.has(k) || known.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * 성숙도 격차 이슈의 제목. `target`이 있으면 §5.2.1의 승격 제목(`harness: promote to M<n> — <reason>`)
 * 그대로 — 이 문자열이 dedup 키다. `target`이 null인 규칙(외부 SDK에 fake가 없음)은 **승격이 아니라
 * 경고**라 "promote to null"이 될 수 없으므로 규칙 이름으로 제목을 만든다(dedup 키는 여전히 제목이다).
 */
export const gapTitle = (gap) =>
  (gap?.target ? `harness: promote to ${gap.target} — ${gap.reason}` : `harness: ${gap?.rule} — ${gap?.reason}`).slice(0, TITLE_MAX);

const gapBody = (gap, agentReason) => [
  `결정적 감지(\`lib/retro/maturity.js\`, 규칙 \`${gap?.rule}\`)가 성숙도 격차를 찾았습니다(§5.2.1).`,
  "",
  `- 감지 근거: ${gap?.reason}`,
  `- 목표 성숙도: ${gap?.target ?? "(승격 아님 — 하네스 보완)"}`,
  ...(agentReason ? ["", `retro 분석가의 설명: ${agentReason}`] : []),
  "",
  "이 이슈는 retro가 만들었고 라벨을 옮기지 않습니다 — 큐에 들어간 뒤 정상적인 스테이지가 처리합니다.",
].join("\n");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/**
 * 다크 PR에 실릴 수 있는 경로는 **두 종류뿐**이다(§8.1): lessons 파일과 역할 파일. 그 둘만이 retro가
 * 사람 없이 스스로 머지하는 변경이고(P4-R2), 그 안전성은 `lessonsFormat`(L0 변조 규칙)·`additive_only`(L1 정책)가
 * 그 두 경로에만 걸려 있다는 사실에 기댄다. 경로가 하나라도 그 밖으로 나가면 retro는 "자체 머지되는
 * 임의 파일 쓰기"가 된다 — roles.toml이 이상한 경로를 가리키든, 에이전트가 역할 이름을 지어내든,
 * 여기서 막는다. 하위 디렉터리도 허용하지 않는다(`[^/]+`) — 허용 목록은 글자 그대로여야 한다.
 */
const DARK_PATH_RULES = [/^\.factory\/lessons\/[^/]+\.md$/, /^\.claude\/agents\/[^/]+\.md$/];
export function splitDarkFiles(files) {
  const allowed = {};
  const rejected = [];
  for (const [path, content] of Object.entries(files || {})) {
    if (DARK_PATH_RULES.some((re) => re.test(path))) allowed[path] = content;
    else rejected.push(path);
  }
  return { allowed, rejected };
}

/**
 * retro 자신이 쓴 토큰 — `claude -p`의 JSON 봉투(`total_cost_usd`/`usage`)에서 읽는다. 스테이지 비용은
 * run 기록에 남지만 retro는 스테이지가 아니라서(라벨 상태 머신 밖의 잡) 그 기록을 쓰지 않는다 —
 * 여기서 걷지 않으면 "공장이 자기를 돌아보는 데 든 비용"이 어디에도 남지 않는다(§4.4 보고 범위).
 * 봉투가 없거나(호출 실패) 필드가 비면 0이다 — null이 아니다: 호출은 분명히 일어났고, 비용을 모르는
 * 것과 "이번 창에 더할 것이 없다"는 것은 여기서 같은 값으로 충분하다(원본 stdout은 `.factory/out`에 남는다).
 */
export function retroUsageOf(envelope) {
  const e = envelope || {};
  const u = e.usage || {};
  return {
    cost_usd: round6(e.total_cost_usd),
    tokens: { input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0 },
  };
}

/**
 * 창(window) 통계를 누적 통계에 더한다 — **full run에서만** 부른다. 커서가 전진하는 순간이 창이 닫히는
 * 순간이고, 경량 실행은 커서를 움직이지 않으므로 같은 창을 다시 더하면 이중 집계가 된다(§8.4 delta).
 * `review_rounds_avg`는 머지 건수로 가중한 누적 평균이다 — 평균의 평균은 평균이 아니다.
 */
export function accumulateStats(total, window) {
  const t = total || {};
  const w = window || {};
  const tMerged = Number(t.merged) || 0;
  const wMerged = Number(w.merged) || 0;
  const merged = tMerged + wMerged;
  const weightedAvg = (key) => (merged
    ? ((Number(t[key]) || 0) * tMerged + (Number(w[key]) || 0) * wMerged) / merged
    : 0);
  const avg = weightedAvg("review_rounds_avg");
  // Task 10 (Phase-2 gate) — escaped 결함은 단순 합, revert는 분자·분모를 쌓아 비율을 **다시** 낸다
  // (비율의 평균은 비율이 아니다 — overlap_ratio·qa_na_ratio와 같은 규약). plan/implement 라운드는
  // review와 같은 병합 가중 평균으로 롤업한다. revert_rate는 누적 머지가 0이면 null(잴 것이 없음).
  const escapedDefects = (Number(t.escaped_defects) || 0) + (Number(w.escaped_defects) || 0);
  // revert는 **합**이 아니라 되돌린 머지 이슈 번호의 **유니온**으로 센다 — 뒤늦게 관측된 revert(그
  // 머지의 창보다 늦게 도착한 것)가 제 머지에 착지해야 하고(false-low 방지), 같은 revert가 여러 창에서
  // 다시 관측돼도 이슈 번호로 중복이 제거돼야 한다. 누적 revert_rate는 그 유니온 크기 ÷ 누적 머지다.
  const revertedSet = new Set([
    ...(Array.isArray(t.reverted_issues) ? t.reverted_issues : []),
    ...(Array.isArray(w.reverted_issues) ? w.reverted_issues : []),
  ]);
  const reverts = revertedSet.size;
  const rejects = { ...(t.rejects_by_role || {}) };
  for (const [role, n] of Object.entries(w.rejects_by_role || {})) rejects[role] = (rejects[role] || 0) + (Number(n) || 0);
  // P2-13: 겹침은 **비율의 합**이 아니라 분자·분모의 합에서 다시 나온다(비율의 평균은 비율이 아니다).
  const unique = { ...(t.unique_findings_by_role || {}) };
  for (const [role, n] of Object.entries(w.unique_findings_by_role || {})) unique[role] = (unique[role] || 0) + (Number(n) || 0);
  const findingsTotal = (Number(t.findings_total) || 0) + (Number(w.findings_total) || 0);
  const overlapping = (Number(t.overlapping_findings) || 0) + (Number(w.overlapping_findings) || 0);
  const qaClaims = (Number(t.qa_claims_total) || 0) + (Number(w.qa_claims_total) || 0);
  const qaNa = (Number(t.qa_na_total) || 0) + (Number(w.qa_na_total) || 0);
  const tok = (key, side) => (Number(t[key]?.tokens?.[side]) || 0) + (Number(w[key]?.tokens?.[side]) || 0);
  // 누적 비용은 **1e-6 자리로만** 반올림한다(센트로 깎지 않는다) — 센트 미만인 창을 round2로 접으면
  // 그 창의 비용이 누적에서 영구히 사라지고(0을 더한다) 작은 회차를 많이 도는 공장의 총계가 0에 머문다.
  // 센트 표기는 사람이 보는 순간에만 한다(`statsTable`의 `toFixed(2)`).
  const sumUsage = (key) => ({
    cost_usd: round6((Number(t[key]?.cost_usd) || 0) + (Number(w[key]?.cost_usd) || 0)),
    tokens: { input: tok(key, "input"), output: tok(key, "output") },
  });
  return {
    merged,
    review_rounds_avg: round2(avg),
    plan_rounds_avg: round2(weightedAvg("plan_rounds_avg")),
    implement_rounds_avg: round2(weightedAvg("implement_rounds_avg")),
    escaped_defects: escapedDefects,
    reverts,
    reverted_issues: [...revertedSet].sort((a, b) => a - b),
    revert_rate: merged ? round2(reverts / merged) : null,
    rejects_by_role: rejects,
    review_runs: (Number(t.review_runs) || 0) + (Number(w.review_runs) || 0),
    findings_total: findingsTotal,
    overlapping_findings: overlapping,
    unique_findings_by_role: unique,
    overlap_ratio: findingsTotal ? round2(overlapping / findingsTotal) : 0,
    needs_human: (Number(t.needs_human) || 0) + (Number(w.needs_human) || 0),
    // ADR-024 / KTB-42 SF-3 — qa claim 구성(최종 리뷰 A-SF6). 겹침과 같은 규약이다: 비율은 쌓지 않고
    // 분자·분모를 쌓아 거기서 다시 낸다(비율의 평균은 비율이 아니다).
    qa_approvals: (Number(t.qa_approvals) || 0) + (Number(w.qa_approvals) || 0),
    qa_claims_total: qaClaims,
    qa_na_total: qaNa,
    qa_na_ratio: qaClaims + qaNa ? round2(qaNa / (qaClaims + qaNa)) : 0,
    qa_na_heavy_approvals: (Number(t.qa_na_heavy_approvals) || 0) + (Number(w.qa_na_heavy_approvals) || 0),
    usage: sumUsage("usage"),
    // retro 자신의 비용은 스테이지 비용과 **따로** 쌓는다 — 섞으면 "공장이 일하는 데 든 비용"과
    // "공장이 자기를 돌아보는 데 든 비용"을 다시 가를 수 없고, N 자가 조정의 근거가 흐려진다.
    retro_usage: sumUsage("retro_usage"),
    retros: (Number(t.retros) || 0) + 1,
  };
}

const rejectCell = (s) => {
  const rejects = Object.entries(s?.rejects_by_role || {});
  return rejects.length ? rejects.map(([r, n]) => `${r} ${n}`).join(", ") : "없음";
};

/**
 * 외부 감사 2026-09-14 P2-13 — 리뷰어 겹침. `overlap_ratio`만으로는 "0.00"이 "겹치지 않았다"인지
 * "판정할 finding이 없었다"인지 가를 수 없어서, 분자/분모를 그대로 함께 적는다.
 */
const overlapCell = (s) => {
  const total = Number(s?.findings_total) || 0;
  if (total === 0) return "없음";
  return `${Number(s?.overlap_ratio ?? 0).toFixed(2)} (${Number(s?.overlapping_findings) || 0}/${total}, runs ${Number(s?.review_runs) || 0})`;
};
const uniqueCell = (s) => {
  const uniq = Object.entries(s?.unique_findings_by_role || {});
  return uniq.length ? uniq.map(([r, n]) => `${r} ${n}`).join(", ") : "없음";
};

/**
 * ADR-024 / KTB-42 SF-3 — qa 승인의 claim 구성(최종 리뷰 A-SF6). `overlapCell`과 같은 이유로 비율
 * 하나로 끝내지 않는다: "0.00"이 "na가 없었다"인지 "qa 기록이 있는 승인이 한 건도 없었다"인지
 * 가를 수 있어야 한다. 뒤의 괄호가 그 분모이고, `na-heavy`는 절반 이상을 `na`로 덮은 승인 수다.
 */
const qaNaCell = (s) => {
  const approvals = Number(s?.qa_approvals) || 0;
  if (approvals === 0) return "없음";
  const na = Number(s?.qa_na_total) || 0;
  const total = na + (Number(s?.qa_claims_total) || 0);
  return `${Number(s?.qa_na_ratio ?? 0).toFixed(2)} (${na}/${total} claims, na-heavy ${Number(s?.qa_na_heavy_approvals) || 0}/${approvals} approvals)`;
};

/**
 * Task 10 (Phase-2 gate) — escaped 결함 셀. 창 열은 이슈별 상세(`#N×k`)를 함께 싣고(어느 이슈에서
 * 결함이 샜는지 사람이 바로 본다), 누적 열은 합계만 싣는다(상세는 누적하지 않는다).
 */
const escapedCell = (s) => {
  const n = Number(s?.escaped_defects) || 0;
  const detail = Array.isArray(s?.escaped_defects_detail) ? s.escaped_defects_detail : null;
  return detail && detail.length ? `${n} (${detail.map((d) => `#${d.issue}×${d.count}`).join(", ")})` : String(n);
};
/**
 * Task 10 (Phase-2 gate) — revert 비율 셀. `overlapCell`과 같은 규약: 비율 하나로 끝내지 않고 분자·분모를
 * 함께 싣는다("0.00"이 "되돌림 0"인지 "잴 머지가 없음"인지 가른다). 창/누적 모두 머지가 0이면 "없음".
 */
const revertCell = (s) => {
  const merged = Number(s?.merged) || 0;
  if (merged === 0) return "없음";
  return `${Number(s?.revert_rate ?? 0).toFixed(2)} (${Number(s?.reverts) || 0}/${merged})`;
};

/**
 * Phase-2 게이트의 **기준선**(이 세션에서 동결). retro 출력과 ADR-026이 같은 값을 인용한다. 이 표가
 * 관측 가능하게 만드는 위험은 스펙 §7의 "단순화가 품질을 떨어뜨릴 수 있는가"다 — 리뷰어 커버리지를
 * 줄이는 Phase 2(Tasks 6,7)는 이 기준선 대비 escaped·revert가 나빠지지 않았음을 먼저 보여야 시작한다.
 */
export const QUALITY_BASELINE = Object.freeze({
  note: "KTB #18 = $143 / 12 stage-runs; own-cal #3 = 4 review rounds",
  // 게이트가 "≤ baseline"으로 비교할 **수치** 문턱(should_fix). $·라운드만으로는 escaped·revert에
  // 문턱이 없어 실행자가 추론해야 했다 — 이 세션의 관측값으로 동결한다: 둘 다 0.
  escaped_defects: 0,
  revert_rate: 0,
  // rounds_per_issue 예시(단순화가 목표로 낮추려는 값)와 escaped_defects 예시(post-approval find)는
  // **서로 다른 두 신호**다 — 게이트가 둘 다 읽는다.
  rounds_exemplar: "own-cal #3 = 4 review rounds (reject-heavy; caught in review, escaped_defects=0)",
  must_not_recur: Object.freeze([
    "KTB #18 R3 finish() regression (approve→reject flip — a post-approval escaped defect)",
  ]),
});

/** 이슈별 라운드/escaped 상세 표(이번 창) — 롤업 표 밑에 붙는다. 없으면 빈 문자열. */
function roundsPerIssueTable(window) {
  const rows = Array.isArray(window?.rounds_per_issue) ? window.rounds_per_issue : [];
  if (!rows.length) return "";
  const esc = new Map((Array.isArray(window?.escaped_defects_detail) ? window.escaped_defects_detail : []).map((d) => [d.issue, d.count]));
  const body = rows.map((r) => `| #${r.issue} | ${r.plan ?? 0} | ${r.implement ?? 0} | ${r.review ?? 0} | ${esc.get(r.issue) ?? 0} |`);
  return ["### Rounds per issue (this window)", "", "| issue | plan | implement | review | escaped |", "| --- | --- | --- | --- | --- |", ...body].join("\n");
}

/** Phase-2 게이트 기준선 블록(이 세션에서 동결) — retro 출력에 기준선과 must-not-recur 집합을 남긴다. */
function baselineNote() {
  return [
    "### Phase-2 gate baseline (this session)",
    "",
    `- baseline: ${QUALITY_BASELINE.note}`,
    `- frozen thresholds: escaped_defects ≤ ${QUALITY_BASELINE.escaped_defects}, revert_rate ≤ ${QUALITY_BASELINE.revert_rate.toFixed(2)}`,
    `- rounds-per-issue exemplar: ${QUALITY_BASELINE.rounds_exemplar}`,
    `- must-not-recur escaped defects: ${QUALITY_BASELINE.must_not_recur.join("; ")}`,
    "- gate (ADR-026): Phase 2 (plan Tasks 6, 7) starts only when, over ≥5 post-Phase-1 issues, escaped-defect rate AND revert rate are ≤ baseline while rounds-per-issue fell.",
  ].join("\n");
}

/**
 * `_retro.md` 위쪽에 사람이 먼저 읽는 통계 표(§8.3 "통계" 절과 같은 수치). 두 열이다: 이번 창(N 자가
 * 조정을 움직이는 값)과 누적(공장의 전체 이력). 창만 보면 "공장이 지금까지 무엇을 했는가"를 알 수 없고,
 * 누적만 보면 "이번에 무엇이 달라졌는가"를 알 수 없다.
 */
export function statsTable(window, total) {
  const w = window || {};
  const t = total || {};
  const row = (label, a, b) => `| ${label} | ${a} | ${b} |`;
  const roundsCell = (s) => `${s.plan_rounds_avg ?? 0} / ${s.implement_rounds_avg ?? 0} / ${s.review_rounds_avg ?? 0}`;
  const table = [
    "| metric | this window | cumulative |",
    "| --- | --- | --- |",
    row("merged", w.merged ?? 0, t.merged ?? 0),
    row("review rounds avg", w.review_rounds_avg ?? 0, t.review_rounds_avg ?? 0),
    // Task 10 (Phase-2 gate) — 게이트가 읽는 세 지표. 이슈별 상세는 이 표 밑의 rounds-per-issue 표에.
    row("rounds/issue (plan/impl/review)", roundsCell(w), roundsCell(t)),
    row("escaped defects", escapedCell(w), escapedCell(t)),
    row("revert rate", revertCell(w), revertCell(t)),
    row("needs-human", w.needs_human ?? 0, t.needs_human ?? 0),
    row("rejects by role", rejectCell(w), rejectCell(t)),
    row("reviewer overlap", overlapCell(w), overlapCell(t)),
    row("unique findings by role", uniqueCell(w), uniqueCell(t)),
    row("qa na ratio", qaNaCell(w), qaNaCell(t)),
    row("cost (usd)", Number(w.usage?.cost_usd || 0).toFixed(2), Number(t.usage?.cost_usd || 0).toFixed(2)),
    row("tokens", `input ${w.usage?.tokens?.input || 0} / output ${w.usage?.tokens?.output || 0}`, `input ${t.usage?.tokens?.input || 0} / output ${t.usage?.tokens?.output || 0}`),
    // retro 자신의 비용 — 스테이지 비용과 한 줄 떨어뜨려 둔다(§4.4). 이 줄이 없으면 공장은 자기를
    // 돌아보는 데 얼마를 쓰는지 모른 채 N을 조정한다.
    row("retro cost (usd)", Number(w.retro_usage?.cost_usd || 0).toFixed(2), Number(t.retro_usage?.cost_usd || 0).toFixed(2)),
    row("retro tokens", `input ${w.retro_usage?.tokens?.input || 0} / output ${w.retro_usage?.tokens?.output || 0}`, `input ${t.retro_usage?.tokens?.input || 0} / output ${t.retro_usage?.tokens?.output || 0}`),
    row("full retros", "—", t.retros ?? 0),
  ].join("\n");
  // 이슈별 상세(창)와 Phase-2 게이트 기준선을 표 밑에 붙인다 — 롤업만으로는 어느 이슈에서 결함이
  // 샜는지 모르고, 기준선이 없으면 게이트가 무엇 대비 좋아졌는지 판단할 근거가 사라진다(스펙 §7).
  return [table, roundsPerIssueTable(w), baselineNote()].filter(Boolean).join("\n\n");
}

/**
 * 채택된 항목을 후보 목록에서 내린다 — 채택된 후보를 남겨 두면 다음 retro가 같은 것을 또 제안하고
 * (`applyLessons`가 'duplicate'로 거부하므로 해롭지는 않지만) 후보 목록이 영원히 커진다. 근거가
 * 모자라 미룬 후보는 **남긴다**(Global Constraints) — 여기서 내리는 것은 실제로 파일에 들어간 텍스트뿐이다.
 */
export function retireCandidates(candidates, texts) {
  const drop = new Set((texts || []).map((t) => String(t ?? "").trim()).filter(Boolean));
  const c = candidates || emptyCandidates();
  if (!drop.size) return c;
  const keep = (list) => (list || []).filter((x) => !drop.has(String(x?.text ?? "").trim()));
  return { ...c, lessons: keep(c.lessons), examples: keep(c.examples) };
}

const byRole = (items) => {
  const map = new Map();
  for (const it of items || []) {
    const role = it?.role;
    if (!role) continue;
    if (!map.has(role)) map.set(role, []);
    map.get(role).push(it);
  }
  return map;
};

const dedupeIssues = (...lists) => {
  const seen = new Map();
  for (const list of lists) for (const i of list || []) if (i?.number != null && !seen.has(i.number)) seen.set(i.number, i);
  return [...seen.values()];
};

/**
 * 이번 실행이 **결정한 상태 변경**을 하나의 값으로 모아 둔다. 순수 함수라, 동기화가 "state moved"로
 * 튕겼을 때 새로 읽은 base 상태에 **같은 변이를 그대로 다시 적용**할 수 있다 — 그래서 경합에서도
 * 남의 이력을 지우지 않고 내 이력을 얹을 수 있다(불변식 3c). n_before/n_after와 후보 병합은 언제나
 * "적용 시점의 base"를 기준으로 다시 계산된다.
 */
export function applyMutation(base, m = {}) {
  const b = base || {};
  const s = {
    ...b,
    cursor: { last_retro_at: null, last_record_offsets: {}, ...(b.cursor || {}) },
    history: Array.isArray(b.history) ? [...b.history] : [],
  };
  if (!Number.isFinite(s.n) || s.n < 1) s.n = 1;
  if (!Number.isFinite(s.merges_since) || s.merges_since < 0) s.merges_since = 0;

  if (m.mergesSince != null) s.merges_since = m.mergesSince;           // 기록에서 센 값(결정적)
  else if (m.mergesDelta) s.merges_since += m.mergesDelta;             // 셀 수 없었을 때만 잡 실행 횟수로

  s.candidates = m.candidates ? mergeCandidates(b.candidates || emptyCandidates(), m.candidates) : (b.candidates || emptyCandidates());
  if (m.stats) s.stats = m.stats;
  // retro 자신의 비용은 창 통계 위에 **얹는다**(갈아치우지 않는다) — 수확이 실패해 이번 창 통계가
  // 없는 회차에도 비용은 기록돼야 하고, 그때 창 열은 지난 스냅샷을 그대로 들고 있어야 한다.
  if (m.retroUsage) s.stats = { ...(s.stats || {}), retro_usage: m.retroUsage };
  if (m.lastFullFailed) s.last_full_failed = m.lastFullFailed;

  if (m.full) {
    const nBefore = s.n;
    s.n = nextN(nBefore, { yield: m.full.yield, needsHumanSince: m.full.needsHumanSince }, m.full.bounds || { min: 1, max: Infinity });
    s.history.push({ ...m.full.entry, n_before: nBefore, n_after: s.n });
    s.merges_since = 0;
    s.cursor = { ...s.cursor, last_retro_at: m.full.at };
    s.candidates = retireCandidates(s.candidates, m.full.retire);
    // 누적에 더하는 것은 **이번 창**이다 — 수확이 실패했으면 창은 없고 retro 비용만 있다(지난 창
    // 스냅샷을 여기서 다시 더하면 그 창을 두 번 센다).
    s.stats_total = accumulateStats(b.stats_total, m.retroUsage ? { ...(m.stats || {}), retro_usage: m.retroUsage } : m.stats);
    s.deferred_proposals = m.full.deferredProposals || [];
    s.deletion_candidates = m.full.deletionCandidates || [];
    delete s.last_full_failed;
  }
  return s;
}

/**
 * `runRetro({ deps, force, now }) → 0 | 1 | 2`
 *   0 = 정상(경량 수확만 했든, 전체 retro를 돌았든, 전체 분석이 실패해 다음 머지로 넘겼든)
 *   1 = 예상하지 못한 중단, 또는 상태가 그 사이 움직여 덮어쓰기를 거부했다(no clobber)
 *   2 = 상태를 읽지 못했다 — 손상됐거나 브랜치 내용을 확정하지 못했다(아무것도 쓰지 않는다)
 *
 * `force`(`factory run retro --force`)는 N을 무시하고 전체 retro를 돌린다.
 */
export async function runRetro({ deps, force = false, now } = {}) {
  const d = deps;
  const at = now ?? d.now ?? new Date().toISOString();
  const record = (line) => { try { d.record(line); } catch (e) { console.error(`factory: retro record failed — ${e?.message || e}`); } };
  const applied = [];
  /** 집행 단계 격리 — 한 단계의 실패는 `applied`에 남고 나머지 단계는 그대로 진행한다. */
  const step = async (name, fn) => {
    try { return { ok: true, value: await fn() }; }
    catch (e) {
      const error = String(e?.message || e);
      applied.push({ step: name, error });
      record(`retro: ${name} failed — ${error}`);
      return { ok: false, error };
    }
  };

  try {
    // ⓪ L2 사전 확인 — `claude -p --settings`가 가리키는 `.factory/ci-settings.json`이 없으면 분석
    // 에이전트가 경로 deny 없이 돌게 된다(ADR-019). hydrate 실패와 같은 자리에서 같은 방식으로 끝낸다:
    // 아무것도 쓰지 않고 exit 2 — 커서도 `merges_since`도 그대로라 고친 뒤 다음 머지가 같은 창을 다시 본다.
    if (d.ciSettingsPresent && !(await d.ciSettingsPresent())) {
      console.error("factory: retro aborted — .factory/ci-settings.json missing (the analyst would run without the L2 path deny list); run `npx know-thy-build factory init --upgrade`");
      record("retro: ci-settings missing — refusing to run the analyst without the L2 deny list");
      return 2;
    }
    // ① hydrate — records 브랜치의 run 기록과 `_retro.md`를 로컬로 복원한다. **출처를 확인한다**:
    // 브랜치 내용을 확정하지 못했으면(fetch 실패, `_retro.md` 부분 읽기 실패) 상태를 쓰지 않는다.
    let hy = null;
    try { hy = await d.hydrate(); }
    catch (e) {
      console.error(`factory: retro aborted — hydrate threw: ${e?.message || e}`);
      record(`retro: hydrate failed — refusing to write state (${e?.message || e})`);
      return 2;
    }
    if (!hy?.fetched) {
      console.error("factory: retro aborted — could not read the factory/records branch");
      record(`retro: hydrate failed — refusing to write state (${hy?.reason || "records branch not read"})`);
      return 2;
    }
    if (hy.stateFailed) {
      console.error("factory: retro aborted — the branch has _retro.md but it could not be read");
      record("retro: hydrate failed — refusing to write state (_retro.md unreadable on the branch)");
      return 2;
    }
    // 브랜치에 `_retro.md`가 아예 없으면 첫 실행이다 — 기본 상태로 진행한다(교체가 아니라 생성이다).
    let expectBlob = { [STATE_FILE]: hy.stateBlob ?? null };

    // ② 상태 — 파서가 던지면 절대 덮어쓰지 않는다(손상된 `_retro.md`는 사람의 몫이다).
    let base;
    try { base = await d.readState(); }
    catch (e) {
      console.error(`factory: retro aborted — ${e?.message || e}`);
      record(`retro: _retro.md unreadable — ${e?.message || e}`);
      return 2;
    }
    if (!Number.isFinite(base.n) || base.n < 1) record(`retro: n was ${JSON.stringify(base.n)} — reset to 1`);
    const guardedN = Number.isFinite(base.n) && base.n >= 1 ? base.n : 1;
    const baseMerges = Number.isFinite(base.merges_since) && base.merges_since >= 0 ? base.merges_since : 0;
    const since = base.cursor?.last_retro_at ?? null;

    /**
     * 상태를 쓰고 records 브랜치로 동기화한다. 교체가 "state moved"로 튕기면(직렬화가 어떤 이유로든
     * 깨졌다) 새 상태를 다시 읽어 **같은 변이를 그 위에 얹고** 딱 한 번 더 시도한다. 그래도 움직였으면
     * 덮어쓰지 않고 실패를 알린다 — 남의 이력을 지우는 것보다 시끄럽게 실패하는 것이 낫다.
     */
    const persist = async (mutation) => {
      let cur = base;
      for (let attemptNo = 0; attemptNo < 2; attemptNo += 1) {
        const next = applyMutation(cur, mutation);
        try { await d.writeState(next, { statsTable: statsTable(next.stats, next.stats_total) }); }
        catch (e) { record(`retro: _retro.md write failed — ${e?.message || e}`); return { ok: false }; }

        let s;
        try { s = await d.sync({ expectBlob }); }
        catch (e) { record(`retro: records sync aborted — ${e?.message || e}`); return { ok: false }; }
        if (!s || s.ok !== false) return { ok: true };
        if (!s.moved) { record(`retro: records sync failed — ${s.reason}`); return { ok: false }; }

        record(`retro: state moved on the branch — ${attemptNo === 0 ? "re-hydrating and retrying once" : "refusing to overwrite"} (${s.reason})`);
        if (attemptNo === 1) return { ok: false, moved: true };
        try {
          const again = await d.hydrate();
          if (!again?.fetched || again.stateFailed) return { ok: false, moved: true };
          const hadState = expectBlob[STATE_FILE] != null;
          expectBlob = { [STATE_FILE]: again.stateBlob ?? null };
          // 브랜치에서 `_retro.md`가 **사라졌는데** 우리는 교체를 걸고 있었다면(누군가 지웠다),
          // 로컬 파일을 다시 읽으면 안 된다 — 그 파일은 방금 우리가 쓴 변이본이고, 그걸 base로 삼으면
          // 같은 변이를 두 번 얹는다(이력 중복·머지 수 이중 계산). 상태가 없어졌으면 없어진 대로,
          // 빈 상태에서 다시 시작한다.
          cur = hadState && again.stateBlob == null ? parseRetroState("") : await d.readState();
        } catch (e) {
          record(`retro: re-hydrate failed — ${e?.message || e}`);
          return { ok: false, moved: true };
        }
      }
      return { ok: false, moved: true };
    };

    // ② 경량 수확(§8.4) — 마지막 retro 커서 이후만 본다. 실패해도 물러나지 않는다: 수확이 비면
    // 이번 머지의 후보가 없을 뿐이고, 후보는 `_retro.md`에 누적되므로 다음 머지가 다시 본다.
    let h = { candidates: emptyCandidates(), stats: null, issues: [], flakyIssues: [], harnessTitles: [], commentsByIssue: new Map(), first: null };
    let harvestRan = false;
    const doHarvest = async () => {
      harvestRan = true;
      const r = await step("harvest", () => d.harvest({ since, records: hy.records }));
      if (r.ok && r.value) h = { ...h, ...r.value };
    };
    // 머지 수는 **기록에서 센다**(결정적) — 잡 실행 횟수로 세면 재실행이 부풀리고 놓친 이벤트가 빠진다.
    // 셀 수 없었을 때(수확 실패, light_on_merge:false)만 실행 횟수로 +1 한다.
    const counted = () => (Number.isFinite(h.stats?.merged) ? h.stats.merged : null);

    // `light_on_merge: false`는 "경량 실행에서는 후보 추출을 하지 않는다"는 선언이다(§8.4) — 그러면
    // 판정을 수확보다 **먼저** 내려야 하고, 그때 머지 수는 실행 횟수로만 셀 수 있다. 기본값(true)에서는
    // 수확이 먼저이므로 판정에 기록에서 센 값을 쓸 수 있다.
    const lightOnMerge = d.lightOnMerge !== false;
    if (lightOnMerge) await doHarvest();
    // `shouldRunFull`의 계약은 "`merges_since`는 **이번 머지를 아직 반영하지 않은** 값"이라 스스로 +1을
    // 더한다(state.js). 기록에서 센 값은 이번 머지를 **이미 포함한다**(머지 스테이지가 이슈를 닫은 뒤에
    // 이 잡이 뜬다) — 그래서 판정에는 1을 빼서 넘긴다. 0건이면 -1이 되어 판정은 light가 되는데, 그게
    // 맞다: 창에서 관측된 머지가 없으면 전체 retro가 볼 것도 없다.
    const forDecision = counted() != null ? counted() - 1 : baseMerges;
    const decision = await d.shouldRunFull({ state: { ...base, n: guardedN, merges_since: forDecision }, force });
    if (decision?.full && !harvestRan) await doHarvest();

    const mergesSince = counted();
    const countBits = mergesSince != null ? { mergesSince } : { mergesDelta: force ? 0 : 1 };
    const harvestBits = harvestRan ? { candidates: h.candidates, stats: h.stats } : {};

    /**
     * ②' 피드백 루프 Task 3 — **분류·라우팅 팔**(spec §4의 "on merge" 가지).
     *
     * light 회차에서도 돈다: 이 팔의 단위는 "N번의 머지"가 아니라 **한 번의 머지**이고, 전체 분석을
     * 기다리는 동안 원인의 증거(게이트 detail·self-gate 차단·전이 거부)는 그대로 남아 있지만 사람은
     * 그것을 읽지 않는다 — 그게 이 루프가 고치려는 바로 그 상태다. 수확이 돌지 않은 회차
     * (`light_on_merge: false`)에는 볼 이슈 목록이 없으므로 건너뛴다.
     *
     * `step`으로 감싸 **절대 회고를 죽이지 않는다**(spec §7 fail-safe): gh 실패는 `applied`의 한 줄과
     * run 기록 한 줄로 남고 나머지 단계는 그대로 진행한다. 라우팅 때문에 회고가 죽으면 그 회차의
     * lessons·통계·커서까지 같이 사라진다.
     */
    if (d.routeFeedback && harvestRan) {
      const r = await step("feedback-route", () => d.routeFeedback({ issues: h.issues, commentsByIssue: h.commentsByIssue, records: hy.records, since }));
      if (r.ok && r.value) {
        for (const a of r.value.actions || []) record(`feedback-route: ${a.kind}${a.issue == null ? "" : ` #${a.issue}`}${a.upstream_issue ? ` → ${a.repo}#${a.upstream_issue}` : ""}${a.harness_issue ? ` → harness #${a.harness_issue}` : ""}${a.reason ? ` — ${a.reason}` : ""}`);
        if ((r.value.actions || []).length) applied.push({ step: "feedback-route", issues: r.value.issues || [], actions: r.value.actions });
      }
    }

    // ③ light — 전체 분석 없이 후보만 쌓고 물러난다.
    if (!decision?.full) {
      const finalMerges = mergesSince ?? baseMerges + (force ? 0 : 1);
      record(`retro: light (merges_since=${finalMerges}/${guardedN})`);
      if (!harvestRan) record("retro: harvest skipped — light_on_merge is false");
      const p = await persist({ ...countBits, ...harvestBits });
      return p.moved ? 1 : 0;
    }

    // ④ 성숙도 격차는 **분석보다 먼저** 판정한다(결정적, §5.2.1) — 후보 파일에 실어서 에이전트가
    // "우리가 찾은 격차"에만 이유 문장을 보태게 한다(없는 격차를 지어내지 못한다).
    const gapsRes = await step("maturity", () => d.maturityGaps());
    const gaps = (gapsRes.ok && gapsRes.value) || [];

    // ⑤ 전체 분석 — 후보 파일을 쓰고 `claude -p "/factory-retro"`를 부른다(full일 때만 토큰을 쓴다).
    const period = { from: since ?? h.first ?? at, to: at };
    // history는 복사해서 넘긴다 — 후보 파일은 이 호출 시점의 스냅샷이어야 하고(이 실행의 이력 항목은
    // 아직 만들어지지도 않았다), 에이전트 쪽 코드가 상태 배열을 건드릴 길을 아예 두지 않는다.
    const snapshot = applyMutation(base, { ...countBits, ...harvestBits });
    const called = await step("claude-p", () => d.claudeP({
      period,
      candidates: snapshot.candidates,
      stats: snapshot.stats,
      history: [...snapshot.history],
      maturity_gaps: gaps,
    }));
    const envelope = called.ok ? called.value : null;
    /**
     * 산출물의 1순위 출처는 디스패처가 **재타이핑한** 최종 텍스트가 아니라 세션 트랜스크립트의
     * `Workflow` tool_result다(KTB-7). retro도 정확히 같은 방식으로 통째로 날아갈 수 있다 —
     * `retro.v1`은 lessons·예시·관점·제안과 각각의 근거 run을 전부 싣기 때문에 plan 못지않게 크고,
     * 모델이 그것을 다시 타이핑하다 요약하면 회차 전체가 `last_full_failed`가 된다.
     * `extractStageArtifact`는 후보를 훑어 **스키마를 통과하는 첫 객체**를 고른다(파싱만 되는 후보는
     * 이기지 못한다). 트랜스크립트 읽기는 best-effort다 — 없으면 후보가 하나 줄 뿐이다.
     */
    let transcriptText = "";
    if (envelope && !envelope.is_error) {
      try { transcriptText = (await d.transcript?.(envelope)) || ""; } catch { transcriptText = ""; }
    }
    // KTB-22: claude -p 자신의 API 쿼터/장애(429/5xx/스로틀)는 회차가 통째로 죽었다는 사실은 같지만
    // 사유는 달라야 한다 — "claude -p reported is_error"는 사람에게 아무것도 말해주지 않지만
    // 프로바이더 메시지 원문은 그대로 읽을 수 있다. `run-stage.js`(KTB-16)와 달리 여기서는 트랜스크립트
    // 복구를 시도하지 않는다 — retro의 실패는 이미 무해하다(라벨을 옮기지 않고, `merges_since`를
    // 리셋하지 않아 다음 머지가 다시 시도한다, 커서도 그대로다): 복구해서 얻는 것이 없다.
    const ex = envelope && !envelope.is_error
      ? extractStageArtifact({ envelopeResult: envelope.result, transcriptText, validate: (o) => validate("retro.v1", o) })
      : { ok: false, reason: envelope ? (hitApiError(envelope) ? apiErrorReason(envelope) : "claude -p reported is_error") : (called.error || "claude -p failed") };
    const out = ex.ok ? ex.data : null;
    const v = { ok: ex.ok, errors: ex.ok ? [] : [ex.reason] };
    // 호출이 실패했어도 토큰은 이미 쓰였다 — 비용은 성공한 회차만의 것이 아니다(F10). `retroUsage`는
    // `stats`와 **별개의 변이 필드**다: 수확이 실패해 이번 창 통계가 없으면 지난 창 스냅샷 위에 비용만
    // 얹어야 하고(창 열을 0으로 리셋하는 것은 "이번 창에 아무 일도 없었다"는 거짓 주장이다), 그 병합은
    // 재적용 가능해야 하므로 `applyMutation`(순수 함수) 안에서 base를 보고 일어나야 한다.
    const fullStatsBits = { ...harvestBits, retroUsage: retroUsageOf(envelope) };
    if (!v.ok) {
      const reason = v.errors.join("; ");
      // 실패를 상태에 남기지만 `merges_since`는 리셋하지 않는다 — 다음 머지가 다시 전체 retro를 돈다.
      record(`retro: full analysis failed — ${reason} (retrying on the next merge)`);
      const p = await persist({ ...countBits, ...fullStatsBits, lastFullFailed: { at, reason } });
      return p.ok ? 0 : 1;
    }

    // ⑥ 집행 — 각 단계는 격리되고, 결과는 `applied`에 쌓여 `_retro.md` 이력에 남는다.
    const files = {};                                                 // 다크 PR에 실릴 변경 파일: 경로 → 새 전문
    /**
     * 채택 **후보**를 파일 단위로 들고 있는다: `{kind, path, texts}`. 여기서 바로 세거나 후보를 내리지
     * 않는 이유는, 한 apply 결과가 실제로 착지하는지가 **그 파일의 경로**(허용 목록, F6)와 **그 PR의
     * 머지**(F3) 두 조건에 달려 있기 때문이다. 둘은 파일마다 다를 수 있다 — 역할 파일 두 개는 PR에
     * 실려 머지되고 lessons 경로 하나는 허용 목록에서 거절되는 회차가 정상이다. 합계를 미리 더해 두면
     * 그 회차가 착지하지 않은 텍스트까지 후보에서 내리고 yield로 센다(관측되지 않은 성공).
     */
    const pending = [];
    let harnessIssues = 0;

    /**
     * 외부 감사 2026-09-14 M10/M11 — **근거 run은 실재해야 한다.** 예전 검사는 `evidence_runs`의
     * *길이*만 셌다: `[1, 2]`라고 적으면 그 이슈가 존재하든 말든, 이 공장이 돌린 적이 있든 말든
     * 창이 찼다. 곧 "근거 2건 이상"은 에이전트가 숫자 두 개를 타이핑했다는 뜻이었다.
     * 이제 records 브랜치(`docs/factory/runs/<issue>.md`)에 실제로 있는 run id만 근거로 센다.
     */
    const knownRunIds = new Set([...(hy.records?.keys?.() ?? [])].map((k) => String(k)));
    const unknownRunsOf = (runs) => unknownRuns(runs, knownRunIds);
    const citationsOf = h.citations || {};

    // (a) lesson — 역할별로 한 번. 근거 run ≥2(서로 다른 이슈)는 `applyLessons`가 다시 센다.
    // 인용이 있는 역할은 **채택이 없어도** 돈다(감사 M11): 인용 카운터를 올리는 것 자체가 변경이다.
    const lessonsByRole = byRole(out.lessons);
    const lessonRoles = [...new Set([...lessonsByRole.keys(), ...Object.keys(citationsOf)])];
    for (const role of lessonRoles) {
      const items = lessonsByRole.get(role) || [];
      const unknownRejects = [];
      const adopted = [];
      for (const i of items) {
        const bad = unknownRunsOf(i.evidence_runs);
        if (bad.length) { unknownRejects.push({ text: i.text, reason: `unknown-evidence-run: ${bad.join(", ")}` }); continue; }
        adopted.push({ text: i.text, evidence_runs: i.evidence_runs });
      }
      const r = await step(`lessons:${role}`, () => d.applyLessons({
        role,
        adopted,
        today: todayOf(at),
        minEvidence: MIN_EVIDENCE,
        citations: citationsOf[role] || {},
      }));
      if (!r.ok || !r.value) continue;
      const res = r.value;
      applied.push({ step: `lessons:${role}`, added: (res.added || []).map((a) => a.id), rejected: [...unknownRejects, ...(res.rejected || [])], evicted: res.evicted || [], cited: res.cited || [] });
      // 실제로 바뀐 파일만 PR에 싣는다 — 채택이 하나도 없으면 `applyLessons`는 원문을 바이트 그대로
      // 돌려주므로, 넣어도 빈 diff가 되고 "변경 없음" 커밋이 실패한다.
      if (res.path && ((res.added || []).length || (res.evicted || []).length || (res.cited || []).length)) files[res.path] = res.text;
      if (res.path && (res.added || []).length) pending.push({ kind: "lessons", path: res.path, texts: res.added.map((a) => a.text) });
    }

    // (b) 역할 예시·관점 — 에이전트 파일별로 한 번. 근거 창은 `applyRoleAdditions`가 보지 않으므로
    // (그 모듈은 섹션·상한·중복만 본다) 여기서 L1이 센다.
    const roleItems = new Map();
    const push = (role, key, item) => {
      if (!role) return;
      if (!roleItems.has(role)) roleItems.set(role, { examples: [], perspectives: [], deferred: [] });
      roleItems.get(role)[key].push(item);
    };
    for (const x of out.examples || []) {
      const bad = unknownRunsOf(x?.evidence_runs);
      if (bad.length) { push(x?.role, "deferred", { kind: x?.kind, text: x?.text, reason: `unknown-evidence-run: ${bad.join(", ")}` }); continue; }
      if (distinctRuns(x?.evidence_runs) < MIN_EVIDENCE) { push(x?.role, "deferred", { kind: x?.kind, text: x?.text, reason: "insufficient-evidence" }); continue; }
      push(x?.role, "examples", { kind: x.kind, text: x.text });
    }
    for (const p of out.perspectives || []) {
      const bad = unknownRunsOf(p?.evidence_runs);
      if (bad.length) { push(p?.role, "deferred", { kind: "perspectives", text: p?.text, reason: `unknown-evidence-run: ${bad.join(", ")}` }); continue; }
      if (distinctRuns(p?.evidence_runs) < MIN_EVIDENCE) { push(p?.role, "deferred", { kind: "perspectives", text: p?.text, reason: "insufficient-evidence" }); continue; }
      push(p?.role, "perspectives", { text: p.text });
    }
    for (const [role, { examples, perspectives, deferred }] of roleItems) {
      if (!examples.length && !perspectives.length) { applied.push({ step: `role:${role}`, added: [], deferred }); continue; }
      const r = await step(`role:${role}`, () => d.applyRoleAdditions({ role, examples, perspectives }));
      if (!r.ok || !r.value) continue;
      const res = r.value;
      applied.push({ step: `role:${role}`, added: res.added || [], skipped: res.skipped || [], deferred });
      if (res.path && (res.added || []).length) {
        files[res.path] = res.text;
        pending.push({ kind: "role", path: res.path, texts: res.added.map((a) => a.text) });
      }
    }

    // (c) 다크 PR — 바뀐 파일이 하나라도 있을 때만. integrity GREEN이면 스스로 머지한다(P4-R2).
    // 실을 수 있는 경로는 lessons·역할 파일뿐이다(F6) — 자체 머지의 안전성이 그 두 경로에만 걸린
    // integrity 규칙에 기대고 있으므로, 그 밖의 경로는 PR에 **넣지 않고** 거절을 기록으로 남긴다.
    const { allowed: darkFiles, rejected: rejectedPaths } = splitDarkFiles(files);
    if (rejectedPaths.length) {
      applied.push({ step: "publish-lessons", rejected: rejectedPaths });
      record(`retro: refused to publish paths outside the dark allowlist — ${rejectedPaths.join(", ")}`);
    }
    let lessonsPr = null;
    if (Object.keys(darkFiles).length) {
      const r = await step("publish-lessons", () => d.publishLessons({ files: darkFiles, date: stampOf(at) }));
      if (r.ok) {
        lessonsPr = r.value;
        applied.push({ step: "publish-lessons", pr: lessonsPr?.pr ?? null, merged: lessonsPr?.merged ?? false, reason: lessonsPr?.reason ?? null, files: Object.keys(darkFiles) });
      }
    }
    /**
     * **PR에 실려서 머지된 파일의 텍스트만이 채택이다**(F3+F6). 두 조건을 파일마다 따로 본다:
     *   - 그 파일의 경로가 허용 목록을 통과해 PR에 실렸는가(`splitDarkFiles`의 accepted 집합).
     *   - 그 PR이 실제로 머지됐는가(`merged === true`).
     * 어느 한쪽이라도 아니면 그 텍스트는 파일에 **없다**: 후보에서 내리면 다음 retro가 다시 볼 수 없어
     * 영원히 사라지고, yield에 세면 "수확이 있었다"며 N을 줄여 토큰만 더 쓴다. 둘 다 관측되지 않은
     * 성공을 기록하는 셈이다 — 착지 전까지 후보도 텍스트도 그대로 둔다. 한 회차에서 역할 파일은
     * 머지되고 lessons 경로는 거절되는 조합이 정상이므로, 판정은 PR 단위가 아니라 파일 단위다.
     */
    const lessonsMerged = lessonsPr?.merged === true;
    const acceptedPaths = new Set(Object.keys(darkFiles));
    const landedFiles = lessonsMerged ? pending.filter((e) => acceptedPaths.has(e.path)) : [];
    const countOf = (kind, list) => list.filter((e) => e.kind === kind).reduce((n, e) => n + e.texts.length, 0);
    const attemptedLessons = countOf("lessons", pending);
    const attemptedRoleItems = countOf("role", pending);
    const landedLessons = countOf("lessons", landedFiles);
    const landedRoleItems = countOf("role", landedFiles);
    const retire = landedFiles.flatMap((e) => e.texts);                // 후보에서 내릴 텍스트 = 착지한 것뿐
    const strandedInPr = attemptedLessons + attemptedRoleItems - landedLessons - landedRoleItems;
    if (strandedInPr) {
      const why = lessonsMerged
        ? `paths outside the dark allowlist (${pending.filter((e) => !acceptedPaths.has(e.path)).map((e) => e.path).join(", ")})`
        : `lessons PR not merged (${lessonsPr?.reason ?? (lessonsPr?.pr == null ? "no PR" : "unmerged")})`;
      record(`retro: ${strandedInPr} additions stay candidates — ${why}`);
    }

    // (d) 성숙도 승격 이슈 — 판정은 위에서 이미 났고, 에이전트는 이유 문장만 보탠다. 제목으로 dedup한다
    // (열려 있는 `factory:harness` 이슈만 — 닫힌 이슈는 처리됐다는 뜻이라 새 격차는 새 이슈를 받는다).
    const openTitles = new Set((h.harnessTitles || []).map((t) => String(t ?? "").trim()));
    for (const gap of gaps) {
      const title = gapTitle(gap);
      if (openTitles.has(title)) { applied.push({ step: "harness", title, skipped: "duplicate" }); continue; }
      const agentReason = (out.harness || []).find((x) => x?.target === gap?.target)?.reason;
      const r = await step(`harness:${gap?.rule}`, () => d.createIssue({ title, body: gapBody(gap, agentReason), labels: [QUEUE_LABEL, HARNESS_LABEL] }));
      if (!r.ok) continue;
      openTitles.add(title);                                          // 같은 실행에서 같은 제목을 두 번 만들지 않는다
      harnessIssues += 1;
      applied.push({ step: "harness", title, issue: r.value ?? null });
    }

    // (e) flaky 격리 등록(§5.2.5-⑤, P4-R3) — 등록은 `quarantine.toml` 저장 + 이슈 코멘트까지 한 단계다.
    // 대상 목록은 라벨로 좁힌 `factory:flaky` 이슈다(200개 일반 스냅샷이 아니라).
    const reg = await step("quarantine-register", () => d.registerQuarantine({ issues: h.flakyIssues, commentsByIssue: h.commentsByIssue, now: at }));
    const registered = (reg.ok && reg.value?.registered) || [];
    if (registered.length) applied.push({ step: "quarantine-register", registered });

    // (f) TTL 만료 → "다른 레벨에서 다시 쓰라"는 이슈. 만료 사실은 sweeper가 flaky 이슈에 남긴
    // `<!-- factory-quarantine expired id=… -->` 코멘트에**만** 있다 — `applyPolicy`는 만료를 플래그로만
    // 내고 `quarantine.toml`에는 저장하지 않으므로(항목은 그대로 남는다) 파일에는 흔적이 없다.
    // 닫힌 flaky 이슈에 달린 만료 코멘트도 놓치지 않으려 일반 스냅샷과 합쳐서 본다.
    const allIssues = dedupeIssues(h.issues, h.flakyAll || h.flakyIssues);
    const exp = await step("quarantine-expired", () => d.expiredIds({ issues: allIssues, commentsByIssue: h.commentsByIssue, since }));
    const expired = (exp.ok && exp.value) || [];
    const openFlaky = (h.flakyIssues || []).filter((i) => i?.state !== "closed");
    for (const draft of rewriteIssuesForExpired({ expired, openIssues: openFlaky })) {
      const r = await step("rewrite-issue", () => d.createIssue(draft));
      if (r.ok) applied.push({ step: "rewrite-issue", title: draft.title, issue: r.value ?? null });
    }

    // (g) 삭제 후보 — 재작성 이슈가 다시 needs-human에 도달한 것. 삭제는 조용히 일어나지 않는다:
    // `_retro.md`에 후보로 남기고 **제안 PR**(사람 머지)의 `test-delete` 항목으로 낸다(§5.2.5-④).
    const deletions = deletionCandidates({ issues: openFlaky, commentsByIssue: h.commentsByIssue });
    const deletionProposals = deletions.map((x) => ({
      kind: "test-delete",
      title: `test-delete: ${x.id}`,
      body: [
        `격리된 테스트 \`${x.id}\`는 다른 레벨에서 다시 쓰라는 이슈(#${x.issue})마저 \`factory:needs-human\`에 도달했습니다.`,
        "이 동작을 어느 테스트가 대신 지킬지 정하고, 그것이 없다면 이 삭제를 승인하지 마세요 — 마지막 증명을 지우는 것은 단순화가 아닙니다(§5.2.5-④).",
      ].join("\n"),
      evidence_runs: [x.issue],
    }));

    // (h) 제안 PR — 최소 근거 창(§8.4)은 L1이 센다. 미달 제안은 버리지 않고 상태에 남긴다.
    const { accepted, deferred } = filterByEvidence([...(out.proposals || []), ...deletionProposals], { knownRuns: knownRunIds });
    if (deferred.length) applied.push({ step: "proposals", deferred: deferred.map((x) => ({ kind: x.proposal?.kind, title: x.proposal?.title, reason: x.reason })) });
    let proposalPr = null;
    if (accepted.length) {
      const { title, body } = renderProposalPr({ period: { from: ymdOf(period.from), to: ymdOf(period.to) }, proposals: accepted, stats: snapshot.stats });
      const date = stampOf(at);
      // 제안 PR은 **사람이 머지한다** — 며칠 열려 있는 것이 정상이고, 그 사이 retro는 여러 번 돈다.
      // 같은 기간 마커(또는 같은 제목)의 열린 PR이 이미 있으면 두 번째 PR은 사람이 읽을 것을 늘리기만
      // 하고(둘 중 어느 쪽이 최신인지도 알 수 없다) 아무것도 더 말하지 않는다 — 그래서 열지 않는다.
      const dupes = await step("proposal-dedup", () => d.listProposalPrs());
      const marker = RETRO_MARKER.exec(body)?.[0] ?? null;
      const dup = (dupes.ok ? dupes.value || [] : []).find((p) =>
        (marker && String(p?.body ?? "").includes(marker)) || String(p?.title ?? "").trim() === title);
      if (dup) {
        record(`retro: proposal skipped (duplicate #${dup.number})`);
        applied.push({ step: "publish-proposal", skipped: `duplicate #${dup.number}`, pr: dup.number ?? null, proposals: accepted.map((p) => p.kind) });
      } else {
        const r = await step("publish-proposal", () => d.publishProposal({ files: { [`docs/factory/retro/${date}.md`]: body }, title, body, date }));
        if (r.ok) {
          proposalPr = r.value;
          applied.push({ step: "publish-proposal", pr: proposalPr?.pr ?? null, reason: proposalPr?.reason ?? null, proposals: accepted.map((p) => p.kind) });
        }
      }
    }

    // ⑦ yield → N 자가 조정 → 이력 → 커서 전진(§8.4). PR이 실제로 열리지 않았으면(번호 없음) 세지 않는다.
    const proposalCount = proposalPr && proposalPr.pr != null ? 1 : 0;
    const y = landedLessons + landedRoleItems + harnessIssues + proposalCount;   // 착지한 것만 센다(F3+F6)
    const needsHumanSince = Number(h.stats?.needs_human ?? base.stats?.needs_human ?? 0) || 0;
    record(`retro: full — yield=${y} (lessons ${landedLessons}/${attemptedLessons}, role items ${landedRoleItems}/${attemptedRoleItems}, merged ${lessonsMerged}, harness ${harnessIssues}, proposal PR ${proposalCount})`);
    const p = await persist({
      ...countBits,
      ...fullStatsBits,
      full: {
        at,
        yield: y,
        needsHumanSince,
        bounds: d.nBounds || { min: 1, max: Infinity },
        retire,                                                        // 착지한 텍스트만 — 위에서 이미 걸렀다
        deferredProposals: deferred.map((x) => x.proposal),
        deletionCandidates: deletions,
        entry: { at, yield: y, needs_human_since: needsHumanSince, applied },
      },
    });
    // 여기까지 왔으면 부수 효과는 **이미 일어났다**(PR·이슈·quarantine.toml). 그 사실을 적은 상태를
    // 쓰지 못했다면 조용히 0으로 물러날 수 없다 — 다음 회차는 같은 창을 다시 보고 같은 일을 또 한다.
    return p.ok ? 0 : 1;
  } catch (e) {
    console.error(`factory: retro aborted — ${e?.message || e}`);
    record(`retro: aborted — ${e?.message || e}`);
    return 1;
  }
}

/**
 * 이슈 스냅샷은 **네 갈래**다 — 목적마다 물어보는 대상이 다르다:
 *   - `issues`: 일반 스냅샷(최근 200, state all). 창 통계(머지 수·리뷰 라운드·reject)의 재료다.
 *   - `flakyIssues`: `factory:flaky` 라벨의 **열린** 이슈 — 격리 등록·재작성 dedup·삭제 후보. 닫힌
 *     이슈는 사람이 끝났다고 말한 것이므로 등록 대상이 아니다(등록은 열린 부채에만 건다).
 *   - `flakyAll`: 같은 라벨의 **모든** 이슈(state all) — 만료 코멘트 스캔 전용(F8). sweeper는 닫힌
 *     flaky 이슈에도 `<!-- factory-quarantine expired … -->`를 남긴다(격리는 이슈가 열려 있는지와
 *     무관하게 계속되는 부채다). 열린 목록만 보면 그 만료는 영영 읽히지 않고 재작성 이슈도 안 생긴다.
 *   - `harnessTitles`: `factory:harness` 라벨의 열린 이슈 제목 — 성숙도 이슈 dedup.
 * 라벨로 좁히지 않으면 "최근 200개" 창 밖으로 밀려난 flaky·harness 이슈를 못 보고 중복을 만든다.
 * 코멘트는 창 안에서 움직인 이슈 + 모든 flaky 이슈만 읽는다(그 둘이 판정에 쓰이는 전부다).
 */
export async function collectIssues({ gh, since }) {
  const withState = (list) => list.map((i) => ({ ...i, state: i.closedAt ? "closed" : "open" }));
  const issues = withState(await gh.issueList({ state: "all", limit: 200 }));
  const flakyIssues = withState(await gh.issueList({ labels: [FLAKY_LABEL], state: "open" }));
  const flakyAll = withState(await gh.issueList({ labels: [FLAKY_LABEL], state: "all" }));
  const harnessTitles = (await gh.issueList({ labels: [HARNESS_LABEL], state: "open" })).map((i) => i.title);

  const sinceMs = since == null ? null : Date.parse(since);
  const moved = (i) => {
    if (sinceMs == null || !i.updatedAt) return true;
    const ms = Date.parse(i.updatedAt);
    return !Number.isFinite(ms) || ms > sinceMs;
  };
  const commentsByIssue = new Map();
  for (const i of dedupeIssues(issues.filter(moved), flakyAll)) {
    try { commentsByIssue.set(i.number, await gh.comments(i.number)); }
    catch (e) { console.error(`factory: retro could not read comments on #${i.number} — ${e?.message || e}`); }
  }
  return { issues, flakyIssues, flakyAll, harnessTitles, commentsByIssue };
}

/**
 * 역할 이름 → 그 역할의 lessons·agent 파일. 후보의 `role`은 handoff에 적힌 이름(예: `correctness`)이고
 * 파일 이름은 에이전트 파일의 basename(예: `reviewer-correctness`)이라 둘 다 받아야 한다 — roles.toml이
 * 유일한 출처이므로, 여기서 두 키를 같은 항목에 매달아 둔다. 모르는 역할은 파일을 만들지 않는다
 * (retro는 역할을 신설하지 않는다 — 신설은 사람이 머지하는 제안 PR의 몫이다).
 */
/**
 * retro의 `claude -p` 인자(KTB-15b item 2). 예전에는 `--max-turns 5`가 박혀 있었다 — run-stage.js가
 * 이미 KTB-16으로 고친 것과 같은 문제(짧은 하드코딩이 백그라운드 워크플로/자격 확인 왕복 턴을
 * 감당 못 한다)를 retro도 그대로 앓을 수 있어, 같은 `stageMaxTurns(harness, "retro")` 규칙 —
 * `[factory].max_turns` 공통값, `[factory].max_turns_by_stage.retro`가 있으면 그것이 이긴다,
 * 둘 다 없으면 기본 12 — 를 그대로 재사용한다. 순수 함수라 하네스만 바꿔가며 테스트할 수 있다.
 */
export function retroClaudeArgs({ harness, charter, ciSettingsPath }) {
  const args = ["-p", "/factory-retro", "--permission-mode", "dontAsk", "--max-turns", String(stageMaxTurns(harness, "retro")), "--output-format", "json", "--settings", ciSettingsPath];
  if (charter?.budget?.usd_per_stage) args.push("--max-budget-usd", String(charter.budget.usd_per_stage));
  return args;
}

export function roleFileMap(roles) {
  const map = new Map();
  const add = (name, def) => {
    if (!def?.agent) return;
    const entry = { agent: def.agent, lessons: def.lessons ?? null };
    map.set(name, entry);
    map.set(def.agent.split("/").pop().replace(/\.md$/, ""), entry);
  };
  for (const [stage, block] of Object.entries(roles || {})) {
    if (stage === "schema" || typeof block !== "object" || block === null) continue;
    if (block.agent) { add(stage, block); continue; }
    for (const [name, def] of Object.entries(block)) add(name, def);
  }
  return map;
}

/** CLI 진입: 실제 의존성 조립 */
async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
  const runnerId = process.env.FACTORY_RUNNER_ID || `local/${hostname()}`;
  const gh = makeGh({ run, repo });

  // 잠드는 건 정상이지만 "왜"는 반드시 말한다. retro는 라벨을 옮기지 않으므로 잠들어도 아무것도 막지 않는다.
  let charter, harness, roles;
  try { charter = loadCharter(root); harness = loadHarness(root); }
  catch (e) { console.error(`factory: retro dormant — ${e.message}`); process.exit(0); }
  if (charter.status !== "ready") { console.error(`factory: CHARTER status is ${charter.status} — retro dormant`); process.exit(0); }
  try { roles = loadRoles(root); }
  catch (e) { console.error(`factory: .factory/roles.toml unreadable — ${e.message}`); process.exit(0); }

  const retro = charter.retro?.every_merges || {};
  const now = new Date().toISOString();
  const runsDir = join(root, "docs/factory/runs");
  const outDir = join(root, ".factory/out");
  const statePath = join(runsDir, STATE_FILE);
  const readText = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const defaultBranch = harness.project?.default_branch ?? "main";
  const fileOf = roleFileMap(roles);

  const deps = {
    now,
    // 경량 실행은 매 머지마다 도므로 기록은 러너 로그로 충분하다 — `_retro.md`는 `renderRetroState`가
    // 통째로 다시 쓰는 상태 파일이라 run 기록을 append할 수 없다(append하면 다음 render가 지운다).
    record: (line) => console.log(`factory: ${line}`),
    lightOnMerge: charter.retro?.light_on_merge !== false,
    /**
     * 브랜치 내용을 **출처와 함께** 복원한다. run 기록은 append-only 로그라 로컬에 이미 있으면
     * 건드리지 않는다(아직 push되지 않은 꼬리일 수 있다 — hydrateRecord와 같은 규칙). `_retro.md`는
     * 예외다: retro만 쓰고 쓸 때마다 sync하므로 **브랜치가 유일한 진실**이고, 로컬 사본은 지난 실행이
     * 남긴 잔재일 뿐이다. 그 잔재를 읽으면(오래된 체크아웃에서 `factory run retro`) 옛 상태 위에 새
     * 이력을 쓰고 브랜치 이력을 덮어쓴다.
     */
    hydrate: async () => {
      const r = await readRecordsDetailed({ run, cwd: root });
      mkdirSync(runsDir, { recursive: true });
      if (r.fetched) {
        for (const [issue, text] of r.records) {
          const p = join(runsDir, `${issue}.md`);
          if (issue === "_retro" || !existsSync(p)) writeFileSync(p, text);
        }
      }
      const stateRel = `docs/factory/runs/${STATE_FILE}`;
      return {
        records: r.records,
        fetched: r.fetched,
        exists: r.exists,
        stateBlob: r.blobs.get("_retro") ?? null,
        stateFailed: (r.failures || []).includes(stateRel),
        reason: r.fetched ? null : "could not read the factory/records branch",
      };
    },
    readState: () => parseRetroState(readText(statePath), { initial: retro.initial ?? 1 }),
    writeState: (state, opts) => { mkdirSync(runsDir, { recursive: true }); writeFileSync(statePath, renderRetroState(state, opts)); },
    /** 이슈 스냅샷(`collectIssues`) + 기록에서 뽑은 후보·창 통계. 둘 다 결정적이다(P4-R1). */
    harvest: async ({ since, records }) => {
      const snapshot = await collectIssues({ gh, since });
      const { candidates, stats, citations } = harvestRecords({ records, issues: snapshot.issues, commentsByIssue: snapshot.commentsByIssue, since });
      return { candidates, stats, citations, ...snapshot, first: earliestRecordAt(records) };
    },
    shouldRunFull: ({ state, force: f }) => shouldRunFull({ state, retro, force: f }),
    /**
     * 후보 파일을 먼저 쓰고(워크플로가 그 경로만 인자로 받는다, P4-R6) `claude -p`를 부른다.
     * 파싱에 실패해도 원본 stdout은 `.factory/out/retro.json`에 남는다 — 사후 감사의 1차 증거다.
     */
    ciSettingsPresent: async () => existsSync(join(root, ".factory/ci-settings.json")),
    claudeP: async ({ period, candidates, stats, history, maturity_gaps }) => {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "retro-candidates.json"), `${JSON.stringify({ period, candidates, stats, history, maturity_gaps }, null, 2)}\n`);
      const args = retroClaudeArgs({ harness, charter, ciSettingsPath: join(root, ".factory/ci-settings.json") });
      const r = await run("claude", args, { cwd: root, env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", CLAUDE_PROJECT_DIR: root } });
      writeFileSync(join(outDir, "retro.json"), r.stdout);
      try { return JSON.parse(r.stdout); } catch { return { is_error: true, result: r.stdout + r.stderr }; }
    },
    /**
     * 이 회차의 세션 트랜스크립트 전문(KTB-7). `run-stage.js`와 **같은 계산**을 쓴다
     * (`lib/stage-artifact.js`의 `readTranscript`) — 스테이지마다 다른 경로 규칙을 갖고 있으면
     * "트랜스크립트가 1순위 출처"라는 계약이 한쪽만 고쳐지는 순간 갈라진다.
     */
    transcript: (envelope) => readTranscript({ root, home: homedir(), sessionId: envelope?.session_id, readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null) }) || "",
    applyLessons: ({ role, adopted, today, minEvidence, citations }) => {
      const rel = fileOf.get(role)?.lessons;
      const text = rel ? readText(join(root, rel)) : "";
      // 파일이 없으면 만들지 않는다 — lessons 파일은 역할의 존재 증명이고, retro는 역할을 신설하지 않는다.
      if (!rel || !text) return { path: null, text: "", added: [], rejected: (adopted || []).map((a) => ({ text: a.text, reason: rel ? "empty-lessons-file" : "unknown-role" })), evicted: [], cited: [] };
      return { path: rel, ...applyLessonsText({ text, adopted, today, minEvidence, citations }) };
    },
    applyRoleAdditions: ({ role, examples, perspectives }) => {
      const rel = fileOf.get(role)?.agent;
      const text = rel ? readText(join(root, rel)) : "";
      if (!rel || !text) return { path: null, text: "", added: [], skipped: [...examples, ...perspectives].map((x) => ({ text: x.text, reason: "unknown-role" })) };
      return { path: rel, ...applyRoleAdditionsText({ text, examples, perspectives }) };
    },
    publishLessons: ({ files, date }) => openAndMergeLessonsPr({ run, gh, cwd: root, defaultBranch, files, date, harness, log: (m) => console.log(m) }),
    maturityGaps: async () => {
      const ls = await run("git", ["ls-files"], { cwd: root });
      const files = ls.code === 0 ? ls.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
      let manifestDeps = [];
      try {
        const pkg = JSON.parse(readText(join(root, "package.json")) || "{}");
        manifestDeps = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})];
      } catch (e) { console.error(`factory: retro could not read package.json — ${e?.message || e}`); }
      return detectMaturityGaps({ files, harness, manifestDeps });
    },
    createIssue: (issue) => gh.createIssue(issue),
    /** 등록은 세 가지가 한 단계다: 판정 → `quarantine.toml` 저장 → 그 flaky 이슈에 마커 코멘트. */
    registerQuarantine: async ({ issues, commentsByIssue, now: at }) => {
      const { q, registered } = registerFromFlakyIssues({ issues, commentsByIssue, quarantine: loadQuarantine(root), now: at, K: charter.limits?.K });
      if (!registered.length) return { registered };
      saveQuarantine(root, q);
      for (const r of registered) {
        try {
          await gh.comment(r.issue, [
            quarantineComment("registered", r.id),
            `\`${r.id}\`를 \`.factory/quarantine.toml\`에 격리 등록했습니다 — 자가 수정이 한도(K)를 넘겨 \`factory:needs-human\`에 도달했기 때문입니다(§5.2.5-⑤).`,
            "격리된 테스트의 실패는 게이트를 RED로 만들지 않지만, 격리 수가 상한을 넘으면 back-pressure가 새 구현 착수를 막습니다 — 방치할 수 없는 부채입니다.",
          ].join("\n"));
        } catch (e) { console.error(`factory: retro could not comment on flaky issue #${r.issue} — ${e?.message || e}`); }
      }
      return { registered };
    },
    expiredIds: ({ issues, commentsByIssue, since }) => expiredFromComments({ issues, commentsByIssue, since }),
    /**
     * 피드백 루프 Task 3 — 이번 창에 머지된 이슈의 증거를 분류해 주인에게 보낸다(spec §7).
     * `upstream`이 없으면 교차 저장소 호출은 **한 번도** 나가지 않는다(로컬 코멘트만).
     */
    routeFeedback: async ({ issues, commentsByIssue, records, since }) => {
      const manifest = await loadInstallManifest(root);
      if (!manifest) {
        return { issues: [], actions: [{ kind: "error", step: "feedback-route", reason: `install manifest not found (no ${INSTALL_MANIFEST_PATH}, no factory/cli/manifest.js) — refusing to classify without the real owner map; run \`npx know-thy-build factory init --upgrade\`` }] };
      }
      return routeMergedIssues({
        gh, repo, upstream: upstreamRepoOf(harness), issues, commentsByIssue, records, since,
        ownerOf: manifest.ownerOf, isInstalled: manifest.isInstalled, ktbVersion: manifest.ktbVersion, harness,
      });
    },
    /** 열린 제안 PR — 같은 창의 제안을 두 번 열지 않기 위한 dedup 재료(본문 마커 또는 제목). */
    listProposalPrs: () => gh.prList({ label: PROPOSAL_LABEL, state: "open" }),
    publishProposal: ({ files, title, body, date }) => openProposalPr({ run, gh, cwd: root, defaultBranch, files, title, body, date, log: (m) => console.log(m) }),
    // `_retro.md`는 매번 통째로 다시 렌더링되는 상태 파일이라 꼬리 병합의 대상이 아니고(병합되면 마커·
    // JSON 펜스가 둘인 파일이 된다), 교체는 하이드레이트한 blob에만 건다 — 그 사이 상태가 움직였으면
    // 덮어쓰지 않고 moved로 튕긴다(records-branch.js `overwrite`/`expectBlob` 참조).
    sync: ({ expectBlob } = {}) => syncRecords({ run, cwd: root, message: `retro: state update (${runnerId})`, overwrite: [STATE_FILE], expectBlob }),
    nBounds: { min: retro.min ?? 1, max: retro.max ?? Infinity },
  };

  process.exit(await runRetro({ deps, force, now }));
}

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
