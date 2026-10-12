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
/**
 * #212 (ADR-041) — **충돌 해소 전용 라운드의 비용도 상한에서 빠지고, 따로 보인다.** 승인된 PR이 base와 충돌해 rework로 돌아온 라운드가 충돌만
 * 풀었으면(러너가 진짜 merge 커밋에서 잰 `conflict-scope` GREEN) 러너가 그 섹션 첫 줄에 `conflict-round:`를 쓴다(`lib/usage.js`). 그 돈은
 * 사람도 에이전트도 고르지 않았다 — base가 움직였다. 그래도 무한히 빼 주지 않는다: 뜨거운 파일을 고친 PR은 "승인 → 충돌 → 해소 → 승인 → 다시
 * 충돌"을 되풀이할 수 있고, 거기서 비용을 하나도 세지 않으면 평생 예산이 멈출 장치가 없다. 그래서 engine-crash와 같은 모양의 런 개수 상한이다.
 * 같은 상수가 K 면제의 상한이기도 하다(`lib/retro/issue-comments.js` `countedTransitionIndices`). 값은 테스트가 핀한다.
 */
export const CONFLICT_ROUND_EXCLUDED_RUNS = 2;

export function lifetimeCostOf(recordText) {
  const entries = recordText ? parseRunRecord(String(recordText), { reviewReworks: true }) : [];
  let usd = 0, priced = 0, runs = 0, engineUsd = 0, engineRuns = 0, crashCountedUsd = 0, crashCountedRuns = 0;
  let conflictUsd = 0, conflictRuns = 0, conflictCountedUsd = 0, conflictCountedRuns = 0, conflictRevokedUsd = 0, conflictRevokedRuns = 0;
  entries.forEach((e, i) => {
    const cost = e.cost_usd != null && Number.isFinite(Number(e.cost_usd)) ? Number(e.cost_usd) : null;
    if (e.engine_crash && engineRuns < ENGINE_CRASH_EXCLUDED_RUNS) { engineRuns++; if (cost != null) engineUsd += cost; return; }
    // #212 dw6 — 뒤따른 리뷰가 거부한 conflict 라운드는 끝난 conflict 라운드가 아니다: 오늘처럼 센다(면제의 고리가 없다), 상한의 칸도 쓰지 않는다
    const revoked = e.conflict_round && reviewRejectedAfter(entries, i);
    // #212 — 기록 순서로 앞의 CONFLICT_ROUND_EXCLUDED_RUNS개 conflict-round 섹션만 빠진다
    if (e.conflict_round && !revoked && conflictRuns < CONFLICT_ROUND_EXCLUDED_RUNS) { conflictRuns++; if (cost != null) conflictUsd += cost; return; }
    runs++;
    if (cost != null) { usd += cost; priced++; }
    // skeptic f2 — 한 사건분을 넘은 크래시 런: usd에 들어가지만, 크래시였다는 사실은 줄에 남는다(따로 센다)
    if (e.engine_crash) { crashCountedRuns++; if (cost != null) crashCountedUsd += cost; }
    // #212 — 상한을 넘은 conflict 런도 같다: usd에 들어가고, 그 사실이 줄에 남는다(operator: 상한에 닿은 순간이 보여야 한다)
    if (revoked) { conflictRevokedRuns++; if (cost != null) conflictRevokedUsd += cost; }
    else if (e.conflict_round) { conflictCountedRuns++; if (cost != null) conflictCountedUsd += cost; }
  });
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    usd: round2(usd), runs, priced,
    ...(engineRuns ? { engineUsd: round2(engineUsd), engineRuns } : {}),
    ...(crashCountedRuns ? { crashCountedUsd: round2(crashCountedUsd), crashCountedRuns } : {}),
    // #212 — 키는 conflict 섹션이 하나라도 있을 때만 선다: 그 섹션이 없는 기록은 값도 모양도 오늘과 같다.
    ...(conflictRuns ? { conflictUsd: round2(conflictUsd), conflictRuns } : {}),
    ...(conflictCountedRuns ? { conflictCountedUsd: round2(conflictCountedUsd), conflictCountedRuns } : {}),
    ...(conflictRevokedRuns ? { conflictRevokedUsd: round2(conflictRevokedUsd), conflictRevokedRuns } : {}),
  };
}

/**
 * #212 dw6 — did a review REJECT the conflict round at `i`? Its review is any `review` section after it and before the next `implement`
 * section (the next round). Only rejections are read (`review_rejected`, a runner `transition:` line to anything but factory:approved —
 * factory:rework, or factory:needs-human when the rejection lands at round K): forged text can add
 * a rejection — the round then counts, as today — but cannot hide one. The K side reads the same event from the issue comments
 * (`lib/retro/issue-comments.js` `conflictExemptIndices`: the next rework after the round is not the merge stage's).
 * cf1/spec1 (round 3) — "the next round" is an implement section that RAN a round, not any implement section: runStage also writes
 * implement sections that are not rounds (`duplicate-run: skipped`, `entry state … — nothing to do`, `lock: release failed` — none
 * carries a usage line), and stopping at one of those hid the rejection behind it. A round is a section with a parsed usage line,
 * an engine crash or a conflict-round tag. A round this misses only lets a later rejection count the cost (the safe side).
 */
const startsRound = (e) => e.stage === "implement"
  && (e.engine_crash || e.conflict_round || e.cost_usd != null || e.num_turns != null || e.input_tokens != null || e.output_tokens != null);
function reviewRejectedAfter(entries, i) {
  for (let j = i + 1; j < entries.length; j++) {
    if (startsRound(entries[j])) return false;
    if (entries[j].review_rejected) return true;
  }
  return false;
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
  const { usd, runs, priced, ...engine } = lifetimeCostOf(recordText);    // engine = { engineUsd, engineRuns, crashCounted*, conflict* } | {} — 판정은 usd로만
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
/** #212 — conflict 런도 같은 모양으로: 빠진 돈과 런 수, 그리고 상한을 넘어 다시 센 런(그 순간이 줄에서 보이게). 섹션이 없으면 빈 문자열이다. */
const conflictRoundNote = (b) => (b.conflictRuns ? `; conflict round $${Number(b.conflictUsd ?? 0).toFixed(2)} over ${b.conflictRuns} run(s) excluded from the cap (base moved under an approved PR, #212)` : "")
  + (b.conflictCountedRuns ? `; ${b.conflictCountedRuns} further conflict round run(s) $${Number(b.conflictCountedUsd ?? 0).toFixed(2)} counted in the cap (past the CONFLICT_ROUND_EXCLUDED_RUNS=${CONFLICT_ROUND_EXCLUDED_RUNS} exclusion)` : "")
  + (b.conflictRevokedRuns ? `; ${b.conflictRevokedRuns} conflict round run(s) $${Number(b.conflictRevokedUsd ?? 0).toFixed(2)} counted in the cap (the review that followed rejected it)` : "");
export const budgetLine = (b) => b.cap == null
  ? `budget: no [budget].usd_per_issue in CHARTER — lifetime cost $${b.usd.toFixed(2)} over ${b.runs} run(s) is not capped${engineCrashNote(b)}${conflictRoundNote(b)}`
  : `budget: lifetime $${b.usd.toFixed(2)} / $${b.cap} over ${b.runs} run(s)${engineCrashNote(b)}${conflictRoundNote(b)}${b.ok ? "" : " — REFUSED"}`;
