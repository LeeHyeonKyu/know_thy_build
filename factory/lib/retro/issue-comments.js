// 이슈 코멘트에서 전이 사실을 뽑는 결정적 파서 — harvest.js(경량 수확 통계)와 quarantine-ops.js
// (flaky 격리 등록의 사유 문구)가 정확히 같은 규칙으로 같은 사실을 읽어야 한다. 같은 전이 문법을
// 두 곳에서 다르게 파싱하면 harvest의 needs-human 통계와 quarantine 등록의 판단이 어긋난다 — 그래서
// 마커 정규식·사유 추출·flaky id 파싱을 여기 한 곳에 둔다. 순수 함수, fs를 만지지 않는다.

export const NEEDS_HUMAN_LABEL = "factory:needs-human";

export const TRANSITION_TO = /<!-- factory-transition:v1 from=(\S+) to=(\S+) by=(\S+) -->/;
export const TRANSITION_REFUSED = /<!-- factory-transition-refused from=(\S+) to=(\S+) -->/;
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
 *   - `other` — 나머지(환경·크리덴셜). 예전의 유일한 문구가 이것이었다.
 */
export const BLOCKED_CAUSES = ["api-error", "timeout", "cancelled", "gates", "undecidable", "other"];
const CAUSE_RULES = [
  ["api-error", /api error|rate ?limit|quota|overloaded|\b429\b|HTTP [45]\d\d|something went wrong/i],
  ["cancelled", /cancell?ed/i],
  ["timeout", /tim(?:e|ed)[ _-]?out|timeout|max turns|turn limit/i],
  ["undecidable", /cannot compute|undecidable|unreadable|unparsable|merge-base|판정 불가/i],
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
export function countTransitionsTo(comments, to) {
  let n = 0;
  for (const c of comments || []) {
    const m = TRANSITION_TO.exec(String(c?.body ?? ""));
    if (m && m[2] === to) n += 1;
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
      const rest = body.slice(m.index + m[0].length);
      const dash = rest.indexOf(" — ");
      const reason = dash === -1 ? "" : rest.slice(dash + 3).split("\n")[0].trim();
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
