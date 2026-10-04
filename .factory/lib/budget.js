import { parseRunRecord } from "./usage.js";

/**
 * 1.4.16 (KTB #44, 데모 #18 — 38 stage-runs · $212 for a README issue) — **이슈의 평생 비용.**
 *
 * K(리뷰 라운드)와 M(구현 라운드)은 **마지막 큐 진입 이후**를 센다 — 사람이 재큐하면 0에서 다시 시작한다. 그래서 재큐를
 * 두 번 지난 이슈는 매번 "새 이슈"처럼 보였고, 아무것도 평생을 세지 않았다. 여기서 세는 것은 기록 브랜치의 `usage:` 줄
 * (`parseRunRecord`, 러너가 적는다 — 에이전트가 쓸 수 없는 채널)의 합이다: 재큐·리트라이·사람 전이를 가로질러 이 이슈 번호로
 * 돈 **모든** 런의 청구액이다. 도는 런의 실시간 비용은 넣지 않는다(끝나면 기록으로 들어온다; 여기는 "시작해도 되는가"의 판정이다).
 *
 * `[budget].usd_per_issue`(CHARTER 프론트매터)를 넘으면 스테이지는 시작하지 않고 `needs-human`으로 세운다 — 예산을 올리든
 * (`:proposal`), 쪼개든, `wont-do`로 닫든 사람의 결정이다. 값이 없으면 검사하지 않는다(doctor가 `charter.budget-per-issue-unset`
 * WARN으로 그 침묵을 말한다 — `merge.human_gate`와 같은 규칙: 기본값을 채우지 않는다, 없는 것과 고른 것은 다른 사실이다).
 */
export function lifetimeCostOf(recordText) {
  const entries = recordText ? parseRunRecord(String(recordText)) : [];
  let usd = 0, priced = 0;
  for (const e of entries) if (e.cost_usd != null && Number.isFinite(Number(e.cost_usd))) { usd += Number(e.cost_usd); priced++; }
  return { usd: Math.round(usd * 100) / 100, runs: entries.length, priced };
}

/** `[budget].usd_per_issue` — 양수일 때만 켜진다. 그 밖(없음·0·문자열)은 "검사 없음"이다. */
export function budgetPerIssue(charter) {
  const v = Number(charter?.budget?.usd_per_issue);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * → `{ ok, cap, usd, runs, reason? }`. `ok:false`는 "이 스테이지를 시작하지 않는다"이고 reason은 사람이 읽는 한 문장이다.
 * 기록을 못 읽었으면(`recordText` null) 비용 0으로 통과한다 — 예산은 안전 게이트가 아니라 흐름 제어이고, 기록 없음은
 * `hydrate:` 줄이 따로 말한다.
 */
export function budgetCheck({ charter, recordText }) {
  const cap = budgetPerIssue(charter);
  const { usd, runs, priced } = lifetimeCostOf(recordText);
  if (cap == null) return { ok: true, cap: null, usd, runs, priced };
  if (usd <= cap) return { ok: true, cap, usd, runs, priced };
  return {
    ok: false, cap, usd, runs, priced,
    reason: `lifetime cost $${usd.toFixed(2)} over ${runs} run(s) exceeds [budget].usd_per_issue $${cap} — a person raises the budget (\`:proposal\`), splits the issue, or closes it (wont-do); the counter spans re-queues and human retries on purpose`,
  };
}

/** run 기록 한 줄 — 검사가 돌았다는 사실과 그 숫자(사람이 이슈 기록만 보고도 예산 대비 위치를 안다). */
export const budgetLine = (b) => b.cap == null
  ? `budget: no [budget].usd_per_issue in CHARTER — lifetime cost $${b.usd.toFixed(2)} over ${b.runs} run(s) is not capped`
  : `budget: lifetime $${b.usd.toFixed(2)} / $${b.cap} over ${b.runs} run(s)${b.ok ? "" : " — REFUSED"}`;
