// 이슈 코멘트에서 전이 사실을 뽑는 결정적 파서 — harvest.js(경량 수확 통계)와 quarantine-ops.js
// (flaky 격리 등록의 사유 문구)가 정확히 같은 규칙으로 같은 사실을 읽어야 한다. 같은 전이 문법을
// 두 곳에서 다르게 파싱하면 harvest의 needs-human 통계와 quarantine 등록의 판단이 어긋난다 — 그래서
// 마커 정규식·사유 추출·flaky id 파싱을 여기 한 곳에 둔다. 순수 함수, fs를 만지지 않는다.

export const NEEDS_HUMAN_LABEL = "factory:needs-human";

/**
 * 네 번째 필드 `reason=`는 선택이다(r2 SF3): 요구사항 미달로 **라벨이 실제로 needs-human으로 옮겨진**
 * 거부도 이제 이 마커를 단다(`reason=refused`) — 그것도 완료된 전이이기 때문이다. 옛 마커
 * (`… by=script -->`)는 바이트 하나 안 바뀐 채 그대로 매치된다.
 */
export const TRANSITION_TO = /<!-- factory-transition:v1 from=(\S+) to=(\S+) by=(\S+)(?: reason=(\S+))? -->/;
export const TRANSITION_REFUSED = /<!-- factory-transition-refused from=(\S+) to=(\S+) -->/;
/**
 * ADR-020 r2 (리뷰 (c)) — **"코멘트는 나갔는데 라벨은 못 옮겼다"의 기록.** 전이 코멘트가 스왑보다
 * 먼저 나가는 이상(KTB-30 r1), 스왑이 통째로 실패하면 이슈에는 일어나지 않은 전이의 코멘트가 남는다.
 * 그 한 줄은 사람에게도 거짓말이고(라벨은 그대로인데 "옮겼다"고 적혀 있다), 라운드 카운터에게도
 * 거짓말이다(`countTransitionsTo`가 그것을 rework 한 번으로 센다 — K 예산을 태운다). 그래서 스왑이
 * throw하면 그 자리에서 이 마커를 남긴다: 뒤따르는 이 마커가 앞의 전이 하나를 **무효로 만든다**.
 */
export const TRANSITION_FAILED = /<!-- factory-transition-failed:v1 from=(\S+) to=(\S+) -->/;
export const transitionFailedMarker = ({ from, to }) => `<!-- factory-transition-failed:v1 from=${from} to=${to} -->`;
/**
 * 거부된 전이의 마커(위 `TRANSITION_REFUSED`가 읽는 바로 그 문자열). KTB-46까지 이 형식에는
 * **생산자만 있고 생성자가 없었다** — `lib/transition.js`가 두 자리에서 템플릿 리터럴로 직접 쓰고,
 * 그것을 읽는 쪽(sweeper의 사람-머지 반영 dedupe)은 같은 문자열을 손으로 베껴 왔다. 한쪽의 형식이
 * 바뀌면 다른 쪽은 **테스트가 전부 초록인 채로** 아무것도 찾지 못한다. `transitionFailedMarker`와
 * 같은 계약으로 맞춘다: 쓰는 쪽도 읽는 쪽도 이 함수 하나를 부른다.
 */
export const transitionRefusedMarker = ({ from, to }) => `<!-- factory-transition-refused from=${from} to=${to} -->`;

/**
 * 요구사항 미달로 **라벨이 실제로 `factory:needs-human`으로 옮겨진** 거부의 코멘트 전문. 마커 두 줄 +
 * 사유 + 라벨 이동 문장이 한 덩어리이고, 읽는 쪽(`extractNeedsHuman`, 피드백 루프의 수확)이 그 네
 * 조각을 전부 본다 — `transitionRefusedMarker`와 같은 이유로 생산자를 여기 둔다(쓰는 쪽은
 * `transition.js` 하나, 읽는 쪽은 여럿, 그리고 테스트는 손으로 베끼면 안 된다).
 */
export const transitionRefusedComment = ({ from, to, reason }) =>
  `<!-- factory-transition:v1 from=${from} to=${NEEDS_HUMAN_LABEL} by=script reason=refused -->\n` +
  `${transitionRefusedMarker({ from, to })}\n` +
  `**전이 거부** ${from} → ${to}: ${reason}\n\n` +
  `라벨을 \`${NEEDS_HUMAN_LABEL}\`으로 옮겼습니다. 산출물을 보강한 뒤 \`:unstick\`으로 재개하세요.`;
// label 이름 자체가 "factory:x" 형태라 콜론을 품는다 — 진짜 구분자는 "콜론+공백"뿐이다.
export const REFUSAL_REASON = /\*\*전이 거부\*\*.*?: ([^\n]+)/;
// 요구사항 미달로 실제 라벨이 needs-human으로 옮겨진 거부만 골라낸다(backtick 인용 — lib/transition.js의
// 문구 그대로). 그래프상 막힌 거부(canTransition=false)는 라벨을 옮기지 않으므로, 어쩌다 to=factory:needs-human이어도
// 이 문구가 없다.
export const ACTUALLY_MOVED_TO_NEEDS_HUMAN = "라벨을 `factory:needs-human`으로 옮겼습니다";

/** `since`(ISO|null) 이후만 통과시킨다. null이면 전부 통과 — "이력 전체"를 뜻한다. */
export function afterSince(at, sinceMs) {
  if (sinceMs == null) return true;
  const ms = at == null ? NaN : Date.parse(at);
  return Number.isFinite(ms) && ms > sinceMs;
}

/**
 * 이슈 제목에서 flaky 테스트 id만 뽑는다. 두 접두어를 받는다:
 *   - `flaky: <id>` — sweeper/quarantine이 처음 격리할 때 붙이는 제목.
 *   - `rewrite flaky test at another level: <id>` — TTL 만료 후 retro가 "다른 레벨에서 다시 쓰라"고
 *     만드는 후속 이슈 제목(§5.2.5-⑤). 이 이슈도 같은 근본 원인의 flaky 테스트를 추적하므로 같은
 *     id로 묶어야 한다.
 * 둘 다 아니면 제목 그대로(방어적).
 */
export function flakyIdFromTitle(title) {
  const m = /^(?:flaky|rewrite flaky test at another level):\s*(.+)$/.exec(String(title ?? "").trim());
  return m ? m[1].trim() : String(title ?? "").trim();
}

/**
 * 전이 코멘트에서 "이 이슈가 factory:needs-human으로 갔다"는 사건만 뽑는다. 두 경로 모두 라벨을
 * 실제로 옮긴다(lib/transition.js):
 *   - 명시적 성공 전이: `factory-transition:v1 … to=factory:needs-human` — 사유는 "— " 뒤.
 *   - 요구사항 미달 거부: `factory-transition-refused …` 중 실제로 라벨을 needs-human으로 옮긴 것만
 *     (본문에 "라벨을 `factory:needs-human`으로 옮겼습니다" 문구가 있는 것 — canTransition 자체가 막힌
 *     그래프 거부는 라벨을 안 옮긴다. `to=` 값만으로는 못 가른다).
 *     사유는 "**전이 거부** … : " 뒤(레이블 이름 자체의 콜론과 구분하려 "콜론+공백"만 구분자로 본다).
 */
/**
 * `lib/transition.js`가 `factory:blocked`로 성공한 모든 전이에 남기는 마커(KTB-15b I2) —
 * "이 blocked이 어디서, 어느 스테이지의 시도에서 왔는가"의 유일한 출처다. 코멘트 이력을 다시
 * 훑어 `TRANSITION_TO`로 추측하지 않는다 — 전이가 일어나는 바로 그 순간 이 마커가 사실을 싣는다.
 */
export const BLOCKED_ORIGIN = /<!-- factory-blocked-origin from=(\S+) stage=(\S+)(?: cause=(\S+))? -->/;

/**
 * ADR-020 O20 — **blocked의 원인 등급.** 마커에 `cause=`가 실린다(KTB-30 이전 마커에는 없다 — 그때는
 * 사유 문구에서 되짚는다). 이 여섯은 sweeper가 다르게 다뤄야 하는 만큼만 갈랐다:
 *   - `api-error` — 쿼터·레이트리밋·5xx. 몇 분~몇 시간이면 풀린다 → 3회까지 재시도(KTB-22).
 *   - `cancelled` — 사람이(또는 concurrency가) 잡을 껐다. 공장의 실패가 아니다 → R 예산을 쓰지 않고
 *     그 취소마다 한 번 다시 민다.
 *   - `timeout` — 잡·턴 한도. 같은 자리에서 또 잘릴 수 있지만 한 번은 값어치가 있다.
 *   - `gates` — 게이트 판정 자체가 BLOCKED(환경이 죽었다).
 *   - `undecidable` — merge-base·diff 같은 판정 재료를 못 구했다.
 *   - `gates-unhandled` — 테스트 명령이 exit≠0인데 리포트의 실패 테스트는 **0개**(KTB-35). 깨진
 *     테스트가 없으므로 "제품이 틀렸다"가 아니고, 대개 테스트 **밖**의 일시적 인프라다(포크된
 *     워커의 stderr `write EPIPE`가 실측 원인이었다) → 같은 스테이지를 한 번 다시 돌린다.
 *   - `other` — 나머지(환경·크리덴셜). 예전의 유일한 문구가 이것이었다.
 */
export const BLOCKED_CAUSES = ["api-error", "timeout", "cancelled", "gates", "gates-unhandled", "undecidable", "other"];
const CAUSE_RULES = [
  ["api-error", /api error|rate ?limit|quota|overloaded|\b429\b|HTTP [45]\d\d|something went wrong/i],
  ["cancelled", /cancell?ed/i],
  ["timeout", /tim(?:e|ed)[ _-]?out|timeout|max turns|turn limit/i],
  ["undecidable", /cannot compute|undecidable|unreadable|unparsable|merge-base|판정 불가/i],
  // KTB-35는 `gates`보다 **먼저** 물려야 한다 — 그 사유 문구에는 "gate log"가 들어 있어서
  // 뒤에 두면 전부 `gates`로 떨어진다(그러면 재시도 계약도 에스컬레이션 문장도 옛것이 된다).
  ["gates-unhandled", /0 failing tests|unhandled error outside tests/i],
  ["gates", /gates?\b/i],
];

/** 사유 문구 → 원인 등급(맞는 규칙이 없으면 `other`). 순수 함수 — 규칙 순서가 우선순위다. */
export function blockedCause(reason) {
  const text = String(reason ?? "");
  for (const [cause, re] of CAUSE_RULES) if (re.test(text)) return cause;
  return "other";
}

/**
 * `factory-blocked-origin` 마커를 만드는 유일한 곳(KTB-19 review I-2) — `lib/transition.js`가 실제
 * 전이 코멘트 안에 붙일 때와, `merge-stage.js`가 (그래프에 없는 blocked→blocked 자기 전이라 실제
 * 전이 없이) 그 마커만 새로 남길 때 둘 다 이 함수를 쓴다. 문구가 두 곳에서 따로 써지면 정규식
 * (`BLOCKED_ORIGIN`)과 어긋날 위험이 있다.
 */
export const blockedOriginMarker = ({ from, stage, cause }) =>
  `<!-- factory-blocked-origin from=${from} stage=${stage ?? "unknown"}${cause ? ` cause=${cause}` : ""} -->`;

/**
 * `lib/transition.js`가 남기는 전이 코멘트에서 "→ factory:blocked" 줄의 사유(있으면)만 뽑는다 —
 * `factory-blocked-origin` 마커와 **같은 코멘트**에서, 그 마커를 만든 전이 자체의 사유를 읽는다
 * (KTB-22). `merge-stage.js`의 `toBlocked()`처럼 전이를 거치지 않고 마커만 재게시하는 자리는 이
 * 줄 모양을 쓰지 않으므로 매치되지 않는다 — 그때는 사유를 "모른다"(빈 문자열)로 두는 것이 맞다
 * (재시도 카운팅이 그 사유로 API 에러 여부를 잘못 판단하는 것보다는 낫다).
 */
const BLOCKED_TRANSITION_REASON = /→ factory:blocked(?: — ([^\n]+))?/;

/**
 * 이슈 코멘트에서 **가장 최근** `factory-blocked-origin` 마커를 뽑는다. `{from, stage, reason}` 또는
 * 마커가 하나도 없으면 null(사람이 API로 라벨을 직접 blocked에 붙인 경우 등 — "판정 불가"이지
 * "queue에서 왔다"가 아니다). `reason`은 그 전이가 남긴 사유 문구(없으면 빈 문자열) — sweeper가
 * "이 blocked이 API 쿼터/장애에서 왔는가"(KTB-22)를 가르는 데 쓴다. 코멘트는 시간순으로 온다고
 * 가정한다(sweeper의 다른 판정들과 같은 가정).
 */
export function blockedOrigin(comments) {
  let found = null;
  for (const c of comments || []) {
    const body = String(c?.body ?? "");
    const m = BLOCKED_ORIGIN.exec(body);
    if (m) {
      const rm = BLOCKED_TRANSITION_REASON.exec(body);
      const reason = rm?.[1]?.trim() ?? "";
      // `cause=`는 KTB-30부터 마커에 실린다 — 없는(옛) 마커는 사유 문구에서 되짚는다. 그래서
      // 호출자는 언제나 등급 하나를 받는다(등급이 없는 경우를 따로 다루지 않아도 된다).
      found = { from: m[1], stage: m[2], reason, cause: m[3] ?? blockedCause(reason) };
    }
  }
  return found;
}

/**
 * ── Structure B (리뷰 효율 Task 3) — self-gate RED 경로의 재시도 마커 ──────────────────────────
 *
 * self-gate가 `ok:false`(빌더가 고칠 수 있는 finding)로 handoff를 막을 때, 스테이지는 이 마커를 남기고
 * `factory:planned`로 되돌려 빌더를 **정확히 한 번** 다시 돌린다. sweeper의 blocked-retry/stalled-restart
 * 마커와 같은 계열이다: 마커를 **head sha로 키잉**하므로, 진짜 수정(새 커밋 → 새 head)은 카운터를
 * 리셋하고, 같은 head에서 두 번째 RED면 `factory:needs-human`으로 에스컬레이션한다.
 *
 * K(`countTransitionsTo(…, rework)`)는 `→ rework`만 세고, `→ planned`에는 아무 카운터도 없었다 —
 * 그래서 self-gate의 무한 implement↔planned 루프를 막는 유일한 상한이 이 마커다. Task 9(one-shot
 * in-run repair)가 "스테이지 통째 재디스패치"를 세션 안 한 턴짜리 루프로 바꾸면, 이 카운터/에스컬레이션은
 * 그 바깥의 안전망으로 남는다.
 */
export const SELF_GATE_RETRY = /<!-- factory-self-gate-retry issue=(\d+) head=(\S+) attempt=(\d+) -->/;
export const selfGateRetryMarker = ({ issue, head, attempt }) =>
  `<!-- factory-self-gate-retry issue=${issue} head=${head} attempt=${attempt} -->`;
const SELF_GATE_FINDINGS_JSON = /```json\s*(\{[\s\S]*?"schema"\s*:\s*"factory\.self-gate-findings\.v1"[\s\S]*?\})\s*```/;

/** 마커 + findings를 담은 코멘트 한 통. 다음 implement 런이 findings를 읽어 빌더에게 되먹인다. */
export const selfGateRetryComment = ({ issue, head, attempt, findings = [] }) =>
  `${selfGateRetryMarker({ issue, head, attempt })}\n` +
  `**self-gate**: 결정적 self-gate가 이 head의 handoff를 막았습니다 (attempt ${attempt}). 리뷰로 보내기 ` +
  `전에 빌더가 아래를 고쳐야 합니다:\n` +
  "```json\n" +
  JSON.stringify({ schema: "factory.self-gate-findings.v1", issue, head, attempt, findings }, null, 2) +
  "\n```";

/** 이 head sha에 대해 남은 self-gate-retry 마커의 개수(호출자가 창을 `commentsSinceRequeue`로 좁힌다). */
export function countSelfGateRetries(comments, head) {
  let n = 0;
  for (const c of comments || []) {
    const m = SELF_GATE_RETRY.exec(String(c?.body ?? ""));
    if (m && m[2] === head) n += 1;
  }
  return n;
}

/**
 * ── 리뷰 효율 Phase-1 finalfix (SF-A) — head-agnostic backstop ─────────────────────────────────
 *
 * `countSelfGateRetries`는 **head별** 상한이다(진짜 수정은 새 head라 카운터를 리셋한다) — 그것이
 * 정상 경로의 1차 상한으로 옳다. 그러나 매 라운드 **새 head**를 뱉으면서도 self-gate를 계속 통과
 * 못 하는 빌더는 head별 카운터를 영원히 1로 리셋하며 implement↔planned를 무한 ping-pong한다: head별
 * 상한만으로는 누적 천장이 없다. 이 함수는 head를 무시하고 **이번 재큐 이후** 남은 self-gate-retry
 * 마커를 전부 센다(호출자가 창을 `commentsSinceRequeue`로 좁힌다). 그 총합이 `SELF_GATE_RETRY_BACKSTOP`에
 * 이르면 head가 매번 달라도 "빌더가 수렴하지 못한다"는 뜻이므로 needs-human으로 올린다. head별
 * 1차 상한을 대체하지 않고 그 바깥의 안전망으로만 얹는다.
 */
export const SELF_GATE_RETRY_BACKSTOP = 3;
export function countAllSelfGateRetries(comments) {
  let n = 0;
  for (const c of comments || []) {
    if (SELF_GATE_RETRY.test(String(c?.body ?? ""))) n += 1;
  }
  return n;
}

/** 이 head sha에 대한 **가장 최근** self-gate findings(없으면 null) — 재디스패치된 빌더가 받는다. */
export function latestSelfGateFindings(comments, head) {
  let found = null;
  for (const c of comments || []) {
    const body = String(c?.body ?? "");
    const m = SELF_GATE_RETRY.exec(body);
    if (!m || m[2] !== head) continue;
    const j = SELF_GATE_FINDINGS_JSON.exec(body);
    if (!j) continue;
    try { const obj = JSON.parse(j[1]); if (Array.isArray(obj.findings)) found = obj.findings; } catch { /* 깨진 블록은 건너뛴다 */ }
  }
  return found;
}

/**
 * Feedback loop Task 3 — **이슈에 남은 모든 self-gate 차단.** `latestSelfGateFindings`는 재디스패치될
 * 빌더에게 "지금 이 head에서 무엇을 고쳐야 하나"를 주는 함수라 head 하나만 본다. 회고는 반대 질문을
 * 한다: "이 이슈가 결국 머지됐는데, 그 사이 self-gate가 무엇을 막았나." 머지된 이슈의 차단은 곧
 * **공장이 스스로 만든 라운드**이고, 그것이 결정적 게이트의 오차단이면 KTB가 고칠 발견이다
 * (데모 #39의 qa-manifest 오차단이 정확히 그것이었다). head별 `attempt`를 그대로 실어 둔다 —
 * 같은 원인이 몇 번 반복됐는지가 증거의 무게다. 깨진 JSON 블록은 조용히 건너뛴다.
 */
export function allSelfGateFindings(comments) {
  const out = [];
  for (const c of comments || []) {
    const body = String(c?.body ?? "");
    const m = SELF_GATE_RETRY.exec(body);
    if (!m) continue;
    const j = SELF_GATE_FINDINGS_JSON.exec(body);
    if (!j) continue;
    let obj;
    try { obj = JSON.parse(j[1]); } catch { continue; }
    if (!Array.isArray(obj?.findings)) continue;
    out.push({ head: m[2], attempt: Number(m[3]), at: c?.createdAt ?? null, findings: obj.findings });
  }
  return out;
}

/**
 * ADR-020 KTB-25 — **마지막 `… to=factory:queue` 전이 코멘트 이후**의 코멘트만 돌려준다(그런 전이가
 * 한 번도 없었으면 이력 전체).
 *
 * 라운드 번호는 에이전트의 자기 신고가 아니라 이슈에 남은 기록으로 센다(`run-stage.js`의 `reviewRounds`
 * — r1 SF2 이후로는 완료된 rework 전이다) — 그 자체는 옳다. 틀린 것은 **세는 범위**였다: 데모 #18은 `needs-human`에서
 * 재큐돼 triage부터 통째로 다시 돌았는데, 새 코드에 대한 **첫 리뷰**가 이전 주기의 review handoff
 * 2개를 물려받아 `round: 2`로 시작했다(K=3 중 2를 이미 쓴 채로). 재큐(`* → factory:queue`)는 새
 * 주기의 시작이다 — 그 앞의 라운드는 다른 코드에 대한 판정이므로 이번 예산에 세지 않는다.
 *
 * 코멘트는 시간순으로 온다고 가정한다(이 파일의 다른 판정들과 같은 가정).
 */
export function commentsSinceRequeue(comments) {
  const list = Array.isArray(comments) ? comments : [];
  let from = 0;
  list.forEach((c, i) => {
    const m = TRANSITION_TO.exec(String(c?.body ?? ""));
    if (m && m[2] === "factory:queue") from = i + 1;
  });
  return list.slice(from);
}

/**
 * ADR-020 KTB-29 r1(SF2) — 주어진 코멘트들 안에서 **`to=<label>`로 성공한 전이**의 개수.
 *
 * 리뷰 라운드를 세는 단위가 handoff에서 이것으로 바뀌었다: handoff 코멘트는 전이보다 **먼저** 나가므로
 * "handoff를 남기고 전이에서 죽은 런"이 라운드를 하나 태웠고, K에 이빨이 생긴 뒤로는 그 사고가
 * 멀쩡한 이슈를 needs-human으로 밀어냈다. `→ factory:rework` 전이는 **실제로 일어난 재작업 주기**이고,
 * 그것이 스펙 §3.2가 K로 세는 단위다. 거부 코멘트(`factory-transition-refused`)는 다른 마커라 세지 않는다.
 */
/**
 * r2 (리뷰 (c)) — 뒤따르는 `factory-transition-failed:v1 … to=<label>`은 **바로 앞의 세지 않은 전이
 * 하나를 취소한다.** SF2의 전제("전이 코멘트 = 실제로 일어난 재작업 주기")는 전이 코멘트가 스왑보다
 * 먼저 나가게 된 뒤로 한 가지 예외가 생겼다: 스왑이 4번의 CLI 시도 + REST까지 전부 실패하면 코멘트만
 * 남는다. K=3에서 그런 장애 두 번이면 멀쩡한 이슈가 라운드를 다 쓴다 — 그 창을 이 마커가 닫는다.
 */
export function countTransitionsTo(comments, to) {
  return countedTransitionIndices(comments, to).length;
}

/**
 * #174 — `countTransitionsTo`가 세는 **바로 그 전이들의 위치**(코멘트 배열의 인덱스, 오름차순). 규칙은 여기 하나다:
 * `countTransitionsTo`는 이것의 길이이고, K 재시작의 "쓰였는가"(`kRestartState`)도 이것을 읽는다 — 같은 TRANSITION_FAILED·
 * `reason=retry` 규칙을 두 벌 두지 않는다.
 *
 * `honourFailed: false`는 같은 규칙에서 **취소만 뺀** 셈이다(K 재시작의 천장, `kRestartState().attempts`). failed 마커도
 * factory 계정의 코멘트 본문이라 에이전트가 쓸 수 있다 — 취소를 따르는 셈은 코멘트 하나로 **줄어든다**. 천장은 코멘트가
 * 더해질수록 늘기만 하는 셈 위에 있어야 위조가 멈춤을 앞당길 뿐 늦추지 못한다. 대가: 진짜 라벨 스왑 실패도 천장의 한 칸을 쓴다.
 */
export function countedTransitionIndices(comments, to, { honourFailed = true } = {}) {
  const out = [];
  (Array.isArray(comments) ? comments : []).forEach((c, i) => {
    const body = String(c?.body ?? "");
    const f = TRANSITION_FAILED.exec(body);
    if (f) { if (honourFailed && f[2] === to && out.length > 0) out.pop(); return; }
    const m = TRANSITION_TO.exec(body);
    // ADR-020 KTB-32 — **사람의 재시도는 라운드가 아니다.** `reason=retry` 전이는 인프라가 끊은
    // 자리로 **이미 얻었던 라벨을 되돌리는** 것이지 새 재작업 주기가 아니다. 세면 `rework`로
    // 되돌아가는 재시도 한 번이 K 예산을 한 칸 태운다 — 재시도의 값어치가 그만큼 줄어든다.
    if (m && m[2] === to && m[4] !== "retry") out.push(i);
  });
  return out;
}

/**
 * ── #174 (ADR-033 둘째 결정) — K 소진 → **한 번**, 새 작성자 + diff 전용 브리프로 스스로 재시작 ─────────────────
 *
 * 리뷰 라운드 K를 다 쓴 이슈는 예전에는 곧장 `factory:needs-human`이었고, 운영 세션(사람)이 미결 findings를 diff 전용
 * 브리프로 적은 뒤 `--retry`로 K를 리셋했다(#149·#157·#170 — 하루 재시도 요청의 절반). 이제 공장이 그 일을 한 번 한다:
 * 브리프 코멘트(이 생산자)를 남기고 `factory:rework`로 보낸다. 두 번째 소진은 예전처럼 사람이다.
 *
 * **창은 바꾸지 않는다.** K의 창은 그대로 `commentsSinceRequeue`이고, 마커는 그 창을 자르지 않는다 — 에이전트도 factory
 * 계정으로 코멘트를 쓰므로(`gh.js`의 열린 `gh issue comment`) 작성자로는 엔진 마커와 위조를 가를 수 없고, 본문이 창을 자르면
 * K에 천장이 없어진다. 대신 예산이 고정이다: 한 창에 재시작은 **최대 한 번**이고, 그 위에 코멘트로 줄일 수 없는 천장(창의 rework
 * **시도** 수, `attempts`)이 2K에 있다.
 *
 * **쓰였다** = 마커 + 그 뒤에 살아남은(`TRANSITION_FAILED`로 취소되지 않은) **재시작 전이** — `by=factory:run-<id>`인
 * `→ factory:rework`(review의 보통 rework는 `by=script`다). 취소된 재시작 전이도 그 뒤에 `from=factory:rework` 전이(implement의
 * claim)가 따르면 쓰인 것이다 — 라벨이 rework에 닿았다는 기록이 failed 마커(위조일 수 있다)보다 강하다(#174 self-critique). 재시작 전이가 따르지 않은 마커(위조든, 전이에서 죽은 런의 것이든)는
 * 쓰인 재시작이 아니고 빌더에게 브리프로 가지도 않는다. 쓰인 브리프는 그 재시작 전이 **직전의 마지막 마커**다 — 엔진은 마커를
 * 게시하고 곧바로 전이하므로, 그 사이에 끼는 위조는 경쟁뿐이다. 그래서 `postKRestartBrief`는 창의 마지막 마커가 **지금 쓸
 * 브리프와 내용이 같을 때만** 다시 쓰지 않는다(전이에서 죽은 런의 재시도) — 다른 내용의 마커가 엔진의 브리프를 대신하지 못한다.
 */
export const K_RESTART = /<!-- factory-k-restart:v1 issue=(\d+) pr=(\S+) head=(\S+) -->/;
export const kRestartMarker = ({ issue, pr, head }) => `<!-- factory-k-restart:v1 issue=${issue} pr=${pr ?? "unknown"} head=${head ?? "unknown"} -->`;
/** 다음 작성자에게 실리는 범위 문장 — 브리프 코멘트와 `loaded.k_restart_brief`가 **이 문자열 그대로** 싣는다. */
export const K_RESTART_SCOPE = "목록 밖의 변경은 없어야 한다(새 파일·새 export·새 done_when 금지, 빼는 것만)";
/** 코멘트 한도(GitHub 65536자) 안에 머무는 상한: findings 40개 × (where 200 + claim 400). 넘치면 "N more omitted". */
export const K_RESTART_MAX_FINDINGS = 40;
/** 최종 본문(이스케이프·두 번 싣기 뒤)의 상한 — 넘치면 뒤쪽 findings를 "omitted"로 돌린다. GitHub 한도 65536보다 여유를 둔다. */
export const K_RESTART_MAX_CHARS = 60000;
const K_RESTART_WHERE_MAX = 200;
const K_RESTART_CLAIM_MAX = 400;
const K_RESTART_BRIEF_JSON = /```json\s*(\{[\s\S]*?"schema"\s*:\s*"factory\.k-restart-brief\.v1"[\s\S]*?\})\s*```/;

/**
 * finding의 글 한 조각을 코멘트에 실어도 안전하게 만든다: 한 줄로 접고, `<!--`(마커의 시작 — 브리프 안의 claim이 전이 마커로
 * 읽히면 K 카운터가 속는다)와 세 개 이상의 백틱(구조화 블록의 울타리)을 무력화하고, 길이를 자른다.
 */
function inert(text, max) {
  // control characters become spaces — JSON escapes each one to six characters, which would blow the size cap
  const s = String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/<!--/g, "&lt;!--").replace(/`{3,}/g, "`").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * finding의 `where`에서 저장소 경로만 뽑는다(`path[:line]` 모양만). `:12`·`:3-9`·`:3:9`·`#L4` 꼬리는 떼고, 백틱·따옴표·괄호는
 * 벗긴다. 경로가 아닌 것(`/reports` 같은 라우트, URL, 산문)은 아무 경로도 내지 않는다 — 추측으로 허용 목록을 넓히지 않는다.
 */
export function wherePaths(where) {
  const out = [];
  for (const raw of String(where ?? "").split(/[\s,;()[\]{}"'`<>]+/)) {
    if (!raw || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue;
    let tok = raw.replace(/[.,;:!?]+$/, "").replace(/#L\d+(?:-L?\d+)?$/i, "").replace(/(?::\d+(?:[-–:]\d+)*)+$/, "").replace(/^\.\//, "");
    if (!tok || tok.startsWith("/") || tok.split("/").includes("..")) continue;
    if (!/^[\w@.+-]+(?:\/[\w@.+-]+)*\/?$/.test(tok)) continue;
    // 파일만 — 마지막 조각에 확장자가 있어야 한다. 디렉터리(`factory/`, `factory/lib`)나 산문(`and/or`)은 허용 목록을 넓히지 않는다.
    if (tok.endsWith("/") || !/\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(tok)) continue;
    if (/^(?:e\.g|i\.e|etc)$/i.test(tok)) continue;
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

/**
 * 브리프 코멘트 한 통(생산자). 마커 + 사람이 읽는 문장(PR·미결 개수·범위 문장·각 finding의 where/claim) + 같은 findings를 담은
 * 구조화 블록(`factory.k-restart-brief.v1`). 읽는 쪽(`kRestartState` → `loaded.k_restart_brief`, self-gate)은 산문이 아니라 블록을 본다.
 */
export function kRestartComment({ issue, pr, head, findings = [] }) {
  const all = (Array.isArray(findings) ? findings : []).filter((f) => f && typeof f === "object");
  const norm = all.slice(0, K_RESTART_MAX_FINDINGS).map((f) => ({
    ...(f.id != null ? { id: inert(f.id, 80) } : {}),
    where: inert(f.where, K_RESTART_WHERE_MAX).replace(/`/g, ""),
    claim: inert(f.claim, K_RESTART_CLAIM_MAX),
  }));
  // 상한은 **최종 본문**에서 잰다: 각 finding은 산문과 JSON 블록에 두 번 실리고, JSON은 `"`·`\`를 두 배로 늘린다.
  for (let n = norm.length; ; n--) {
    const body = renderKRestart({ issue, pr, head, total: all.length, kept: norm.slice(0, n) });
    if (body.length <= K_RESTART_MAX_CHARS || n === 0) return body;
  }
}

function renderKRestart({ issue, pr, head, total, kept }) {
  const omitted = total - kept.length;
  const lines = kept.map((f, i) => `${i + 1}. \`${f.where || "(no where)"}\`${f.id ? ` (${f.id})` : ""} — ${f.claim}`);
  return [
    kRestartMarker({ issue, pr, head }),
    `**K 소진 — 새 작성자로 한 번 재시작합니다 (self-restart 1/1, ADR-033).** 미결 findings ${total}건 — 다음 작성자는 PR #${pr ?? "unknown"}의 diff를 출발점으로 이것만 고친다:`,
    "",
    `> ${K_RESTART_SCOPE}`,
    "",
    ...lines,
    ...(omitted > 0 ? [`- … ${omitted} more omitted (the review handoff carries the full list)`] : []),
    "",
    "```json",
    JSON.stringify({ schema: "factory.k-restart-brief.v1", issue, pr: pr ?? null, head: head ?? null, scope: K_RESTART_SCOPE, findings: kept, omitted }, null, 2),
    "```",
  ].join("\n");
}

/** 마커가 달린 코멘트 본문 → 빌더가 받는 브리프. 블록이 없거나 깨졌으면 `error`를 싣는다(읽는 쪽이 fail closed 한다). */
function briefOf(body, m) {
  const pr = /^\d+$/.test(m[2]) ? Number(m[2]) : null;
  const head = m[3] === "unknown" ? null : m[3];
  const j = K_RESTART_BRIEF_JSON.exec(body);
  let obj = null;
  try { obj = j ? JSON.parse(j[1]) : null; } catch { obj = null; }
  if (!obj || !Array.isArray(obj.findings)) return { pr, head, scope: K_RESTART_SCOPE, paths: [], findings: [], error: "the factory.k-restart-brief.v1 block is missing or unparsable" };
  const findings = obj.findings.filter((f) => f && typeof f === "object").map((f) => ({
    ...(f.id != null ? { id: String(f.id) } : {}),
    where: String(f.where ?? ""),
    claim: String(f.claim ?? ""),
  }));
  const paths = [...new Set(findings.flatMap((f) => wherePaths(f.where)))];
  return { pr, head, scope: K_RESTART_SCOPE, paths, findings };
}

/**
 * 창(호출자가 `commentsSinceRequeue`로 좁힌다) 안의 재시작 상태.
 *   - `used` — 재시작이 쓰였는가. 쓰인 마커는 마커 뒤에 **처음으로** 살아남은 재시작 전이(`by=factory:run-*` rework) 직전의 마지막 마커다.
 *   - `offset` — 그 재시작 전이까지(포함) 센 rework 수. 리뷰 라운드는 재시작 뒤 `prior + 1 - offset`부터 다시 1이다.
 *   - `brief` — 쓰인 마커의 브리프(`briefOf`). 쓰이지 않았으면 null.
 *   - `pending` — 쓰이지 않은 가장 최근 마커 `{ head, pr, brief }`(재시도된 런이 같은 브리프를 또 쓰지 않게).
 *   - `attempts` — 창의 rework **시도** 수(failed 마커로 취소되지 않는 셈) — 2K 천장이 재는 값.
 */
export function kRestartState(comments) {
  const list = Array.isArray(comments) ? comments : [];
  const attempts = countedTransitionIndices(list, "factory:rework", { honourFailed: false }).length;
  const markers = [];
  list.forEach((c, i) => { const body = String(c?.body ?? ""); const m = K_RESTART.exec(body); if (m) markers.push({ i, m, body }); });
  if (!markers.length) return { used: false, offset: 0, brief: null, pending: null, attempts };
  const reworks = countedTransitionIndices(list, "factory:rework");
  const tried = countedTransitionIndices(list, "factory:rework", { honourFailed: false });
  const transitionAt = (j) => TRANSITION_TO.exec(String(list[j]?.body ?? ""));
  const isRestart = (j) => /^factory:run-/.test(transitionAt(j)?.[3] ?? "");
  // 재시작 전이 **시도**들(마커 뒤, by=factory:run-*). 시도 하나가 쓰인 재시작인 것은 (a) 그것이 failed 마커에 취소되지 않고 살아남았거나
  // (b) 취소됐어도 그 뒤(다음 재시작 시도 전)에 `from=factory:rework` 전이가 있을 때다. (b)는 라벨이 실제로 rework에 닿았다는 엔진의 기록
  // (implement의 claim `rework → in-progress`)이다 — 진짜 스왑 실패는 라벨이 rework에 닿지 않았으므로 그런 전이가 뒤따를 수 없다. 그래서
  // 에이전트가 쓴 위조 failed 마커(factory 계정의 코멘트)는 이미 일어난 재시작을 되감지 못한다: 위조는 빌더나 다음 리뷰 세션 안에서만
  // 쓸 수 있고, 둘 다 그 claim 전이보다 뒤다. 위조 전이 코멘트를 더해도 (b)를 더 쉽게 참으로 만들 뿐이다 — 멈춤을 앞당길 뿐 늦추지 못한다.
  const restarts = tried.filter((j) => j > markers[0].i && isRestart(j));
  const leftRework = (from, to) => list.some((_, x) => x > from && x < to && transitionAt(x)?.[1] === "factory:rework");
  const j = restarts.find((r, n) => reworks.includes(r) || leftRework(r, restarts[n + 1] ?? Infinity));
  if (j === undefined) {
    const last = markers[markers.length - 1];
    return { used: false, offset: 0, brief: null, pending: { head: last.m[3], pr: last.m[2], brief: briefOf(last.body, last.m) }, attempts };
  }
  const restart = markers.filter((x) => x.i < j).pop();
  // offset = 재시작 전이까지(포함) 센 rework 수 — `prior`(=`reworks.length`)와 같은 셈이라 새 작성자의 라운드가 1부터 시작한다.
  return { used: true, offset: reworks.filter((x) => x <= j).length, brief: briefOf(restart.body, restart.m), pending: null, attempts };
}

/** 두 브리프가 같은 재시작인가(pr·head·findings) — `postKRestartBrief`의 "다시 쓰지 않는다" 판정. 산문은 보지 않는다. */
export function sameKRestartBrief(a, b) {
  if (!a || !b || a.error || b.error) return false;
  const key = (x) => JSON.stringify({ pr: x.pr ?? null, head: x.head ?? null, findings: x.findings ?? [] });
  return key(a) === key(b);
}

/** 생산자가 쓸 본문을 독자가 읽은 모양 — 같은 두 함수(`kRestartComment`·`briefOf`)를 지나므로 비교가 문자열 복사에 기대지 않는다. */
export function kRestartBriefOf(body) {
  const m = K_RESTART.exec(String(body ?? ""));
  return m ? briefOf(String(body), m) : null;
}

/**
 * 이슈에 남은 **가장 최근** 전이 코멘트(`factory-transition:v1`)를 `{from, to, by, reason, at}`로
 * 돌려준다(하나도 없으면 null). `reason`은 마커 다음 줄 `<from> → <to> — <사유>`의 `— ` 뒤 한 줄이다
 * (사유가 없으면 빈 문자열) — `lib/transition.js`가 쓰는 그 문법 그대로다.
 *
 * ADR-020 KTB-23 fix에서 sweeper의 needs-info 해제 팔이 "이 이슈가 **왜** 주차됐는가"를 이것으로 읽는다:
 * `factory:needs-info`는 두 가지 뜻을 겸한다(triage의 "이슈가 모호하다"와 하네스 대기). 그 둘을 가르는
 * 유일한 기록이 마지막 전이의 사유다. 코멘트는 시간순으로 온다고 가정한다(이 파일의 다른 판정들과 같다).
 */
/**
 * ADR-020 KTB-32 — **이 이슈가 멈춘 자리(resume point).** `factory:needs-human`에서 사람이
 * `:unstick`의 `retry`를 고를 때, 되돌아갈 수 있는 라벨은 **하나**뿐이다: 인프라가 런을 죽이기 직전에
 * 이슈가 갖고 있던 그 라벨. 그것을 추측하지 않고 기록에서 읽는다.
 *
 * 규칙: 전이 코멘트들 중 `to=`가 **정지 상태**(`blocked`·`needs-human`·`needs-info`)인 마지막 것의
 * `from=`. 단 `from=`도 정지 상태인 전이는 건너뛴다 — `blocked → needs-human`은 sweeper의
 * 에스컬레이션이지 "일이 멈춘 자리"가 아니다(라이브 KTB #3이 정확히 이 모양이다:
 * `awaiting-review → blocked` 뒤에 `blocked → needs-human`). 그래서 되돌아갈 자리는 `awaiting-review`다.
 *
 * KTB-36 라운드 확장: `needs-info`가 정지 상태에 들어온 것은 KTB-23의 **하네스 대기 주차**가 그
 * 라벨을 쓰기 때문이다(`in-progress → needs-info`). 그 자리는 blocked과 같은 뜻이다 — 일이 멈췄고,
 * 멈춘 이유는 이 이슈의 산출물이 아니다. triage가 세운 `queue → needs-info`도 같은 규칙에 걸리지만
 * `from=queue`라 `target: null`이 되어 재시도가 거부된다(그 이슈는 실제로 보강 후 재큐가 맞다).
 * `needs-info → queue`(sweeper의 주차 해제)는 `to`가 정지 상태가 아니므로 이 판정을 흔들지 않는다.
 *
 * 그 `from`을 목적 라벨로 옮긴다:
 *   - `ready`/`planned`/`rework`/`awaiting-review` → 그대로(전부 어느 스테이지의 진입 라벨이다).
 *   - `in-progress` → implement는 그 자리에서 **끝나지 않았다**. 이번 주기(마지막 재큐 이후)에
 *     implement handoff가 있으면 구현은 이미 한 번 완성됐다는 뜻이므로 `rework`로, 없으면 `planned`로
 *     이어간다(둘 다 implement의 정상 진입 라벨이고, implement가 그 자리에서 다시 시작한다).
 *   - 그 외(`queue` 등) → `target: null`. 재개할 자리를 모른다는 뜻이고, 호출자는 추측 대신 거부한다.
 *
 * 코멘트는 시간순으로 온다고 가정한다(이 파일의 다른 판정들과 같은 가정).
 */
export const STOP_STATES = new Set(["factory:blocked", "factory:needs-human", "factory:needs-info"]);
const RESUME_TARGET = {
  "factory:ready": "factory:ready",
  "factory:planned": "factory:planned",
  "factory:rework": "factory:rework",
  "factory:awaiting-review": "factory:awaiting-review",
  // 1.4.32 (L40, own-calendar #49) — merge 스테이지에서 멈춘 이슈(일시적 GitHub API 오류로 `gh pr ready` 실패 → blocked → 사람)는
  // 사람이 승인을 다시 만들 수 없으므로(KTB-15b) **blocked로 되돌아간다**: 전이가 origin 마커(from=factory:approved stage=merge
  // cause=human-retry)를 남기고, sweeper의 blocked 팔이 평소 경로대로 승인 요구조건을 다시 물어 merge를 재점화한다.
  "factory:approved": "factory:blocked",
};
const IMPLEMENT_HANDOFF = /<!--\s*factory-handoff:v1\s+stage=implement\s+issue=\d+\s*-->/;

export function resumePoint(comments) {
  const list = Array.isArray(comments) ? comments : [];
  let stop = null;
  for (const c of list) {
    const m = TRANSITION_TO.exec(String(c?.body ?? ""));
    if (!m) continue;
    const [, from, to] = m;
    if (!STOP_STATES.has(to) || STOP_STATES.has(from)) continue;
    stop = { stoppedAt: from, at: c?.createdAt ?? null };
  }
  if (!stop) return null;
  if (stop.stoppedAt === "factory:in-progress") {
    const implemented = commentsSinceRequeue(list).some((c) => IMPLEMENT_HANDOFF.test(String(c?.body ?? "")));
    return { ...stop, target: implemented ? "factory:rework" : "factory:planned" };
  }
  return { ...stop, target: RESUME_TARGET[stop.stoppedAt] ?? null };
}

/**
 * ADR-020 KTB-32 — 사람의 재시도가 인용하는 근거: 가장 최근 `human-decision:v1` 코멘트
 * (`:unstick`이 전이 **직전**에 남긴다). 없으면 null — 전이를 막지는 않는다(막으면 스킬 밖에서
 * 손으로 복구하는 길이 사라진다). 전이 코멘트가 그 사실을 그대로 적을 뿐이다.
 */
export const HUMAN_DECISION = /<!--\s*human-decision:v1\s+issue=(\d+)(?:\s+skill=(\S+))?\s*-->/;
export function lastHumanDecision(comments) {
  let found = null;
  for (const c of comments || []) {
    const m = HUMAN_DECISION.exec(String(c?.body ?? ""));
    if (m) found = { issue: Number(m[1]), skill: m[2] ?? null, at: c?.createdAt ?? null };
  }
  return found;
}

export function lastTransition(comments) {
  let found = null;
  for (const c of comments || []) {
    const body = String(c?.body ?? "");
    const m = TRANSITION_TO.exec(body);
    if (!m) continue;
    const rest = body.slice(m.index + m[0].length);
    const dash = rest.indexOf(" — ");
    found = { from: m[1], to: m[2], by: m[3], reason: dash === -1 ? "" : rest.slice(dash + 3).split("\n")[0].trim(), at: c?.createdAt ?? null };
  }
  return found;
}

export function extractNeedsHuman(issueNumber, comments, sinceMs = null) {
  const out = [];
  for (const c of comments || []) {
    const body = c?.body || "";
    if (!afterSince(c?.createdAt, sinceMs)) continue;

    const m = TRANSITION_TO.exec(body);
    if (m && m[2] === NEEDS_HUMAN_LABEL) {
      // r2 SF3: 요구사항 미달 거부도 이제 전이 마커를 단다(`reason=refused`) — 그 코멘트의 사유는
      // `— ` 뒤가 아니라 "**전이 거부** …: " 뒤에 있다. 마커가 어느 문법인지 말해 준다.
      let reason;
      if (m[4] === "refused") {
        const rm = REFUSAL_REASON.exec(body);
        reason = rm ? rm[1].trim() : "";
      } else {
        const rest = body.slice(m.index + m[0].length);
        const dash = rest.indexOf(" — ");
        reason = dash === -1 ? "" : rest.slice(dash + 3).split("\n")[0].trim();
      }
      out.push({ issue: issueNumber, reason, at: c.createdAt });
      continue;
    }

    const r = TRANSITION_REFUSED.exec(body);
    if (r && body.includes(ACTUALLY_MOVED_TO_NEEDS_HUMAN)) {
      const rm = REFUSAL_REASON.exec(body);
      out.push({ issue: issueNumber, reason: rm ? rm[1].trim() : "", at: c.createdAt });
    }
  }
  return out;
}

/**
 * ── #156 (ADR-032) — **새 엔진이 왔을 때 한 번** ─────────────────────────────────────────────────
 *
 * 엔진 결함(`undecidable`)으로 멈춘 `factory:needs-human`은 사람의 판단이 아니라 고친 엔진을 기다린다. sweeper의
 * `sweepRetryOnRelease`가 설치본 버전(`.factory/install-manifest.json`의 `ktb_version`)이 그 멈춤 당시의 버전과
 * 다르면 한 번 중단 지점으로 되돌린다. 세 조각의 문법이 여기 한 곳에 산다(쓰는 쪽 `transition.js`, 읽는 쪽 sweeper와
 * `commentsSinceCycleStart`):
 *   - `factory:release-<v>` — 그 전이의 `by=` 자기 신고(권한이 아니라 감사 기록 — `transition.js`가 엣지를 좁힌다).
 *   - `factory-retry-on-release version=<v>` — 그 전이 코멘트에 실리는 **러너의** 마커. 이슈당 릴리스당 1회의 dedupe이고,
 *     팩토리 계정이 쓴 것만 재시도 예산의 새 주기를 연다(본문의 `by=`만으로는 열지 않는다 — S1).
 *   - `factory-engine-version version=<v>` — sweeper가 needs-human 에스컬레이션 전이에 싣는 "그때의 엔진 버전".
 *
 * Scope change (#156): 이 파일은 plan의 `files_expected` 밖이다. dw6(재시도가 예산의 새 주기를 연다)는 plan dissent d8과
 * open_risks가 지목한 대로 창을 **여기서 한 번** 넓혀야 한다 — `commentsSinceCycleStart`를 blocked 팔·stalled 팔·self-gate
 * (`factory/bin/run-stage.js`, load-bearing)가 함께 읽으므로, 여기 말고 고치면 run-stage를 건드리거나 세 창 중 하나를 빠뜨린다.
 */
const versionToken = (v) => String(v ?? "").trim().replace(/[\s>]+/g, "-");
export const RELEASE_PRINCIPAL = /^factory:release-(\S+)$/;
export const releasePrincipal = (version) => `factory:release-${versionToken(version)}`;
export const RETRY_ON_RELEASE = /<!-- factory-retry-on-release version=(\S+) -->/;
export const retryOnReleaseMarker = (version) => `<!-- factory-retry-on-release version=${versionToken(version)} -->`;
export const ENGINE_VERSION = /<!-- factory-engine-version version=(\S+) -->/;
export const engineVersionMarker = (version) => `<!-- factory-engine-version version=${versionToken(version)} -->`;

/**
 * #156 dw6 — 이 코멘트가 **팩토리가 쓴 릴리스 재시도 전이**인가. 셋 다 참이어야 한다: 전이 마커가 `by=factory:release-<v>
 * reason=retry`이고, 같은 코멘트에 같은 `<v>`의 `factory-retry-on-release` 마커가 있고, 작성자가 팩토리 계정이다.
 * 팩토리 계정을 모르면 인정하지 않는다(닫힌 쪽) — 본문은 누구나 흉내 낼 수 있다.
 */
export function isFactoryReleaseRetry(comment, { factoryLogin = null } = {}) {
  const b = String(comment?.body ?? "");
  const m = TRANSITION_TO.exec(b);
  if (!m || m[4] !== "retry") return false;
  const p = RELEASE_PRINCIPAL.exec(m[3]);
  const r = RETRY_ON_RELEASE.exec(b);
  if (!p || !r || p[1] !== r[1]) return false;
  const author = typeof comment?.author === "string" ? comment.author.trim() : "";
  return Boolean(author && typeof factoryLogin === "string" && factoryLogin && author.toLowerCase() === factoryLogin.toLowerCase());
}

/**
 * 1.4.12 (own-calendar #9/#28/#29/#30) — **재점화 예산의 창**: 마지막 재큐(`to=factory:queue`) **또는** 사람의 전이
 * (`by=human`: retry·hold 해제) 이후. `commentsSinceRequeue`는 리뷰 라운드(K)의 창이라 사람의 retry로 리셋하면
 * K를 우회하게 되므로 그대로 두고, 이 창은 sweeper의 스톨 재점화 카운터에만 쓴다 — 사람이 되돌린 이슈는 새 주기이고,
 * 지난 주기의 재점화 마커 2개가 첫 스톨에서 곧장 `stalled restart limit`을 만드는 것은 사람의 결정을 무효로 만든다.
 */
export function commentsSinceCycleStart(comments, { factoryLogin = null } = {}) {
  const list = Array.isArray(comments) ? comments : [];
  let from = 0;
  list.forEach((c, i) => {
    const b = String(c?.body ?? "");
    const m = TRANSITION_TO.exec(b);
    if (!m) return;
    if (m[2] === "factory:queue") { from = i + 1; return; }          // 재큐는 누가 했든 새 주기다 — 라벨 그래프가 통제한다
    // #156 dw6 — 새 엔진이 온 뒤의 릴리스 재시도도 사람의 `--retry`처럼 새 주기다. 단 러너의 마커 + 팩토리 계정일 때만.
    if (isFactoryReleaseRetry(c, { factoryLogin })) { from = i + 1; return; }
    /**
     * 설계 2026-09-30 §8.1 (S1) — 사람의 전이인지는 **본문이 아니라 계정**으로 판정한다. 예전 `/\bby=human\b/`는 봇 계정이
     * 흉내 낸 코멘트에도 창을 리셋했다(sweeper의 stalled restart limit, self-gate backstop). 작성자를 모르는 코멘트는
     * 리셋하지 않고, 팩토리 계정이 쓴 것도 리셋하지 않는다. `factoryLogin`을 모르는 구형 호출자는 작성자가 있는 것만 인정한다.
     */
    if (m[3] !== "human") return;
    const author = typeof c?.author === "string" ? c.author.trim() : "";
    if (!author) return;
    if (typeof factoryLogin === "string" && factoryLogin && author.toLowerCase() === factoryLogin.toLowerCase()) return;
    from = i + 1;
  });
  return list.slice(from);
}
