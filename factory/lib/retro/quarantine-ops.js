// flaky 이슈 → 격리 등록, TTL 만료 → 재작성 이슈, 재작성 이슈 반복 실패 → 삭제 후보(§5.2.5-④⑤).
// 순수 함수 — fs·gh를 만지지 않는다. quarantine.toml의 실제 저장은 L1(retro.js) 몫이다(P4-R3: retro가
// 유일하게 이슈 이력을 읽으므로 등록도 retro가 한다 — sweeper는 만료·복귀만 본다).
//
// 마커 정규식·전이 사유 추출·flaky id 파싱은 harvest.js와 공유한다(issue-comments.js) — 같은 전이
// 문법을 두 곳에서 다르게 읽으면 harvest의 통계와 여기의 판단이 어긋난다.

import { isQuarantined } from "../quarantine.js";
import { afterSince, extractNeedsHuman, flakyIdFromTitle } from "./issue-comments.js";

const FLAKY_LABEL = "factory:flaky";
const NEEDS_HUMAN_LABEL = "factory:needs-human";

/**
 * 격리 사건은 `quarantine.toml`이 아니라 **flaky 이슈의 코멘트**에 남는다 — `quarantine.toml`은
 * "지금 격리된 것"만 담는 현재 상태고(복귀·만료된 항목은 그 자리에서 사라진다), "무엇이 언제 왜
 * 격리됐다가 어떻게 끝났는가"는 이력이라 사람이 보는 이슈에 남아야 한다(§5.2.5-⑤ "격리 등록/복귀/
 * 만료는 모두 해당 flaky 이슈에 코멘트를 남긴다"). 그래서 이 마커는 두 잡이 공유한다:
 *   - sweeper(lib/sweeper.js)가 `returned`·`expired`를 쓴다(TTL·연속 통과 판정은 sweeper의 몫).
 *   - retro(bin/retro.js)가 `registered`를 쓰고, sweeper가 남긴 `expired`를 **읽어** "다른 레벨에서
 *     다시 쓰라"는 이슈를 만든다(P4-R3: 이슈 이력을 읽는 잡은 retro뿐이다).
 * 문법이 한 곳에 있어야 쓰는 쪽과 읽는 쪽이 어긋나지 않는다.
 */
export const QUARANTINE_KINDS = ["registered", "returned", "expired"];
export const quarantineComment = (kind, id) => `<!-- factory-quarantine ${kind} id=${id} -->`;
const QUARANTINE_EVENT = /<!--\s*factory-quarantine (registered|returned|expired) id=(\S+)\s*-->/;

const labelName = (l) => (typeof l === "string" ? l : l?.name);
const hasLabel = (issue, name) => Array.isArray(issue?.labels) && issue.labels.some((l) => labelName(l) === name);
const asMap = (m) => (m instanceof Map ? m : new Map(Object.entries(m || {})));

/** 가장 최근 needs-human 전이의 사유, 없으면 fallback. */
function latestNeedsHumanReason(issueNumber, comments) {
  const events = extractNeedsHuman(issueNumber, comments || [], null);
  return events[events.length - 1]?.reason || "self-fix exhausted";
}

/**
 * registerFromFlakyIssues({ issues, commentsByIssue, quarantine, now, K }) → { q, registered }
 *
 * 게이트는 라벨뿐이다: open + `factory:flaky` + `factory:needs-human`을 모두 가진 이슈이고 아직
 * quarantine에 없으면 등록한다. **needs-human 전이 횟수를 세지 않는다** — `factory:flaky` 이슈가
 * `factory:needs-human`에 도달한 사실 자체가 이미 "자가 수정 K회 실패"를 뜻한다(그 카운팅은
 * lib/transition.js의 K회 rework 한도가 이미 수행했다 — 여기서 다시 세면 이중 판정이고, 라벨이
 * 붙는 순간과 실제 등록 사이에 불필요한 지연을 만든다).
 *
 * `K`는 이 인터페이스 계약의 일부로만 남아 있는 예약 파라미터다 — 현재는 아무 효과가 없다
 * (컨트롤러 판정, round 1: "arrival at factory:needs-human on a factory:flaky issue already means
 * K self-fix rounds failed"). reason은 가장 최근 needs-human 전이의 사유, 없으면
 * 'self-fix exhausted'. evidence는 그 이슈 자신에 대한 `#<n>` 참조 하나.
 */
export function registerFromFlakyIssues({ issues = [], commentsByIssue, quarantine, now, K = 3 } = {}) {
  const byIssue = asMap(commentsByIssue);
  let q = quarantine && Array.isArray(quarantine.quarantined) ? quarantine : { quarantined: [] };
  const registered = [];

  for (const issue of issues) {
    if (issue?.state !== "open") continue;
    if (!hasLabel(issue, FLAKY_LABEL) || !hasLabel(issue, NEEDS_HUMAN_LABEL)) continue;

    const id = flakyIdFromTitle(issue.title);
    if (isQuarantined(q, id)) continue;

    const reason = latestNeedsHumanReason(issue.number, byIssue.get(issue.number));
    q = { quarantined: [...q.quarantined, { id, since: now, reason, evidence: [`#${issue.number}`], consecutive_passes: 0 }] };
    registered.push({ id, issue: issue.number });
  }

  return { q, registered };
}

/**
 * rewriteIssuesForExpired({ expired: [id], openIssues }) → [{title, body, labels}]
 * TTL 만료된 격리 id마다 "다른 레벨에서 다시 쓰라"는 이슈를 만든다(§5.2.5-⑤). 이미 같은 제목의
 * open 이슈가 있으면(재실행 시 중복 방지) 건너뛰고, 이번 호출에서 만들어진 초안끼리도 제목이
 * 겹치면(같은 id가 `expired`에 중복으로 들어온 경우) 두 번째부터는 건너뛴다 — `existingTitles`를
 * 초안을 만들 때마다 갱신한다.
 */
export function rewriteIssuesForExpired({ expired = [], openIssues = [] } = {}) {
  const existingTitles = new Set(openIssues.map((i) => i.title));
  const out = [];
  for (const id of expired) {
    const title = `rewrite flaky test at another level: ${id}`;
    if (existingTitles.has(title)) continue;
    out.push({
      title,
      body: `격리된 테스트 \`${id}\`가 TTL(quarantine_ttl_days)을 넘겼습니다. 이 테스트가 지키던 동작을 다른 테스트 레벨에서 다시 검증하는 테스트를 작성하세요(§5.2.5-⑤). 다시 needs-human에 도달하면 그 동작은 삭제 후보가 되고, 삭제는 사람이 머지하는 제안 PR로만 일어납니다.`,
      labels: ["backlog", "factory:flaky"],
    });
    existingTitles.add(title);
  }
  return out;
}

/**
 * quarantineEvents({ issues, commentsByIssue, since }) → [{kind, id, issue, at}]
 * 이슈 코멘트에 남은 격리 사건을 시간순(이슈 순서 × 코멘트 순서)으로 읽는다. `since`(ISO|null)
 * 이후만 본다 — retro는 delta만 처리하므로(§8.4) 지난 retro가 이미 처리한 만료를 다시 보지 않는다.
 */
export function quarantineEvents({ issues = [], commentsByIssue, since = null } = {}) {
  const byIssue = asMap(commentsByIssue);
  const sinceMs = since == null ? null : Date.parse(since);
  const out = [];
  for (const issue of issues) {
    for (const c of byIssue.get(issue?.number) || []) {
      if (!afterSince(c?.createdAt, sinceMs)) continue;
      const m = QUARANTINE_EVENT.exec(c?.body || "");
      if (m) out.push({ kind: m[1], id: m[2], issue: issue.number, at: c.createdAt });
    }
  }
  return out;
}

/**
 * `since` 이후 sweeper가 만료(`expired`) 코멘트를 남긴 격리 id들 — 등장 순서대로, 중복 제거.
 * 이 목록이 `rewriteIssuesForExpired`의 입력이다. 같은 id가 만료된 뒤 다시 등록·만료될 수 있으므로
 * "한 번 만료됐으면 영원히 만료"로 보지 않고 창(`since`) 안의 사건만 센다 — 그래도 재작성 이슈는
 * 제목으로 dedup되므로 같은 이슈가 두 번 생기지는 않는다.
 */
export function expiredFromComments(args) {
  const ids = [];
  for (const e of quarantineEvents(args)) if (e.kind === "expired" && !ids.includes(e.id)) ids.push(e.id);
  return ids;
}

/**
 * deletionCandidates({ issues, commentsByIssue, K }) → [{id, issue}]
 * 재작성 이슈(`rewrite flaky test at another level: <id>`) 중 open이고 다시 `factory:needs-human`에
 * 도달한 것 — registerFromFlakyIssues와 같은 판정: 라벨 도달 자체가 곧 "다시 실패"다, 전이 횟수를
 * 세지 않는다. `K`는 예약 파라미터(현재 효과 없음). 삭제는 여기서 하지 않는다(호출자가 `_retro.md`
 * 후보로 기록하고 `DECISIONS.md` append는 사람 머지 제안 PR로 낸다, §5.2.5-⑤ "조용히 일어나지 않는다").
 */
export function deletionCandidates({ issues = [], commentsByIssue, K = 3 } = {}) {
  const out = [];
  for (const issue of issues) {
    const m = /^rewrite flaky test at another level:\s*(.+)$/.exec(String(issue?.title ?? "").trim());
    if (!m) continue;
    if (issue?.state !== "open" || !hasLabel(issue, NEEDS_HUMAN_LABEL)) continue;
    out.push({ id: m[1].trim(), issue: issue.number });
  }
  return out;
}
