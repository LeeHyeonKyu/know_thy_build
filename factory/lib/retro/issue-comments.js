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
  let n = 0;
  for (const c of comments || []) {
    const body = String(c?.body ?? "");
    const f = TRANSITION_FAILED.exec(body);
    if (f) { if (f[2] === to && n > 0) n -= 1; continue; }
    const m = TRANSITION_TO.exec(body);
    // ADR-020 KTB-32 — **사람의 재시도는 라운드가 아니다.** `reason=retry` 전이는 인프라가 끊은
    // 자리로 **이미 얻었던 라벨을 되돌리는** 것이지 새 재작업 주기가 아니다. 세면 `rework`로
    // 되돌아가는 재시도 한 번이 K 예산을 한 칸 태운다 — 재시도의 값어치가 그만큼 줄어든다.
    if (m && m[2] === to && m[4] !== "retry") n += 1;
  }
  return n;
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
