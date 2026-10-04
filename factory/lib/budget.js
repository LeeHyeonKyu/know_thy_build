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
 *
 * #196 (ADR-036) — **엔진 크래시 런은 상한에서 빠지고, 따로 보인다.** `runStage`의 catch가 프로그래밍 오류를 잡은 런의 섹션
 * (`engine_crash`, `lib/usage.js`의 `engineCrashLine` — 러너만 쓴다)은 `usd`·`runs`에 넣지 않고 `engineUsd`·`engineRuns`로 돌려준다.
 * 그 두 키는 크래시 섹션이 **하나라도 있을 때만** 선다 — 크래시 줄이 없는 기록은 값도 모양도 오늘과 같다(1.4.16 계약의 옛 고정이
 * 그대로 본다). 읽는 쪽은 `?? 0`으로 읽는다. 완료됐지만 엔진 결함으로 판정이 틀린 런(미러 verify·#174 라운드)은 빠지지 않는다 —
 * 그것을 가를 코드 경로가 없고, 문구로 가르면 게이밍이 된다.
 */
/**
 * #196 rework sec1 — **상한에서 빠지는 크래시 런은 이슈 평생 한 사건분이다.** engine-crash의 판정은 오류의 종류와 출처라서, 엔진이 에이전트
 * 산출물을 검증 없이 읽다가 낸 TypeError도 engine-crash다 — 즉 에이전트(와 그것을 프롬프트 주입하는 이슈 본문)가 고를 수 있다. 그 런의 비용이
 * 무한히 상한 밖으로 나가면 평생 예산(1.4.16)이 뚫린다. 그래서 빼 주는 것은 기록 순서로 앞의 이 개수(첫 크래시 + sweeper의
 * `ENGINE_CRASH_MAX_RETRIES` 재시도 = 한 blocked 사건)뿐이고, 그 뒤의 크래시 섹션은 보통 런으로 센다(기록에는 크래시로 남는다).
 * 결정적인 엔진 결함은 한 사건 안에서 사람에게 가고, 같은 엔진에 다시 재큐한 런의 비용은 그 재큐를 고른 쪽의 예산이다.
 * 달러 상한도, CHARTER 값도 아니다(plan non_goals) — 런 개수이고, 값은 sweeper 상수와 묶여 테스트가 핀한다(budget.js가 sweeper를 import하지 않게).
 */
export const ENGINE_CRASH_EXCLUDED_RUNS = 2;

export function lifetimeCostOf(recordText) {
  const entries = recordText ? parseRunRecord(String(recordText)) : [];
  let usd = 0, priced = 0, runs = 0, engineUsd = 0, engineRuns = 0, crashCountedUsd = 0, crashCountedRuns = 0;
  for (const e of entries) {
    const cost = e.cost_usd != null && Number.isFinite(Number(e.cost_usd)) ? Number(e.cost_usd) : null;
    if (e.engine_crash && engineRuns < ENGINE_CRASH_EXCLUDED_RUNS) { engineRuns++; if (cost != null) engineUsd += cost; continue; }
    runs++;
    if (cost != null) { usd += cost; priced++; }
    // skeptic f2 — 한 사건분을 넘은 크래시 런: usd에 들어가지만, 크래시였다는 사실은 줄에 남는다(따로 센다)
    if (e.engine_crash) { crashCountedRuns++; if (cost != null) crashCountedUsd += cost; }
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    usd: round2(usd), runs, priced,
    ...(engineRuns ? { engineUsd: round2(engineUsd), engineRuns } : {}),
    ...(crashCountedRuns ? { crashCountedUsd: round2(crashCountedUsd), crashCountedRuns } : {}),
  };
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
  const { usd, runs, priced, ...engine } = lifetimeCostOf(recordText);    // engine = { engineUsd, engineRuns, crashCounted* } | {} — 판정은 usd로만
  if (cap == null) return { ok: true, cap: null, usd, runs, priced, ...engine };
  if (usd <= cap) return { ok: true, cap, usd, runs, priced, ...engine };
  return {
    ok: false, cap, usd, runs, priced, ...engine,
    reason: `lifetime cost $${usd.toFixed(2)} over ${runs} run(s) exceeds [budget].usd_per_issue $${cap} — a person raises the budget (\`:proposal\`), splits the issue, or closes it (wont-do); the counter spans re-queues and human retries on purpose`,
  };
}

/** run 기록 한 줄 — 검사가 돌았다는 사실과 그 숫자(사람이 이슈 기록만 보고도 예산 대비 위치를 안다). */
/** #196 — 크래시 런이 있으면 빠진 돈과 런 수를 같은 줄에 덧붙인다("engine"만 쓰지 않는다 — #179의 self-change와 헷갈린다). */
/** skeptic f2 — 한 사건분을 넘어 상한 안으로 센 크래시 런도 줄에 이름을 남긴다(크래시였다는 사실이 숫자 속에 숨지 않게). */
const engineCrashNote = (b) => (b.engineRuns ? `; engine crash $${Number(b.engineUsd ?? 0).toFixed(2)} over ${b.engineRuns} run(s) excluded from the cap` : "")
  + (b.crashCountedRuns ? `; ${b.crashCountedRuns} further engine crash run(s) $${Number(b.crashCountedUsd ?? 0).toFixed(2)} counted in the cap (past the one-episode exclusion)` : "");
export const budgetLine = (b) => b.cap == null
  ? `budget: no [budget].usd_per_issue in CHARTER — lifetime cost $${b.usd.toFixed(2)} over ${b.runs} run(s) is not capped${engineCrashNote(b)}`
  : `budget: lifetime $${b.usd.toFixed(2)} / $${b.cap} over ${b.runs} run(s)${engineCrashNote(b)}${b.ok ? "" : " — REFUSED"}`;
