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
