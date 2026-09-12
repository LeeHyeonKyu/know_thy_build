// flaky 이슈 → 격리 등록, TTL 만료 → 재작성 이슈, 재작성 이슈 반복 실패 → 삭제 후보(§5.2.5-④⑤).
// 순수 함수 — fs·gh를 만지지 않는다. quarantine.toml의 실제 저장은 L1(retro.js) 몫이다(P4-R3: retro가
// 유일하게 이슈 이력을 읽으므로 등록도 retro가 한다 — sweeper는 만료·복귀만 본다).

import { isQuarantined } from "../quarantine.js";

const FLAKY_LABEL = "factory:flaky";
const NEEDS_HUMAN_LABEL = "factory:needs-human";

const TRANSITION_TO = /<!-- factory-transition:v1 from=(\S+) to=(\S+) by=(\S+) -->/;
const TRANSITION_REFUSED = /<!-- factory-transition-refused from=(\S+) to=(\S+) -->/;
const REFUSAL_REASON = /\*\*전이 거부\*\*.*?: ([^\n]+)/;
const ACTUALLY_MOVED_TO_NEEDS_HUMAN = "라벨을 `factory:needs-human`으로 옮겼습니다";

const labelName = (l) => (typeof l === "string" ? l : l?.name);
const hasLabel = (issue, name) => Array.isArray(issue?.labels) && issue.labels.some((l) => labelName(l) === name);
const asMap = (m) => (m instanceof Map ? m : new Map(Object.entries(m || {})));

/**
 * 이슈 제목에서 flaky 테스트 id를 뽑는다 — `flaky: <id>`(최초 격리) 또는
 * `rewrite flaky test at another level: <id>`(TTL 만료 후 재작성) 둘 다 받는다(harvest.js와 동일 규약).
 */
function flakyIdFromTitle(title) {
  const m = /^(?:flaky|rewrite flaky test at another level):\s*(.+)$/.exec(String(title ?? "").trim());
  return m ? m[1].trim() : String(title ?? "").trim();
}

/**
 * 이 이슈가 `factory:needs-human`으로 실제로 라벨이 옮겨진 사건들(전이 코멘트에서 결정적으로 파싱,
 * harvest.js의 extractNeedsHuman과 동일 규칙) — 명시적 전이든, 실제로 라벨을 옮긴 거부든.
 */
function needsHumanEvents(comments) {
  const out = [];
  for (const c of comments || []) {
    const body = c?.body || "";
    const m = TRANSITION_TO.exec(body);
    if (m && m[2] === NEEDS_HUMAN_LABEL) {
      const rest = body.slice(m.index + m[0].length);
      const dash = rest.indexOf(" — ");
      out.push({ reason: dash === -1 ? "" : rest.slice(dash + 3).split("\n")[0].trim(), at: c.createdAt });
      continue;
    }
    const r = TRANSITION_REFUSED.exec(body);
    if (r && body.includes(ACTUALLY_MOVED_TO_NEEDS_HUMAN)) {
      const rm = REFUSAL_REASON.exec(body);
      out.push({ reason: rm ? rm[1].trim() : "", at: c.createdAt });
    }
  }
  return out;
}

/**
 * registerFromFlakyIssues({ issues, commentsByIssue, quarantine, now, K = 3 }) → { q, registered }
 *
 * open + `factory:flaky` + `factory:needs-human` 라벨을 모두 가진 이슈 중, 그 이슈가
 * `factory:needs-human`으로 옮겨간 사건이 **K회 이상**(자가 수정 K회 실패, §5.2.5-⑤)이고 아직
 * quarantine에 없는 것만 등록한다. reason은 가장 최근 전이의 사유, 없으면 'self-fix exhausted'.
 * evidence는 그 이슈 자신에 대한 `#<n>` 참조 하나.
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

    const events = needsHumanEvents(byIssue.get(issue.number));
    if (events.length < K) continue;

    const reason = events[events.length - 1]?.reason || "self-fix exhausted";
    q = { quarantined: [...q.quarantined, { id, since: now, reason, evidence: [`#${issue.number}`], consecutive_passes: 0 }] };
    registered.push({ id, issue: issue.number });
  }

  return { q, registered };
}

/**
 * rewriteIssuesForExpired({ expired: [id], openIssues }) → [{title, body, labels}]
 * TTL 만료된 격리 id마다 "다른 레벨에서 다시 쓰라"는 이슈를 만든다(§5.2.5-⑤). 이미 같은 제목의
 * open 이슈가 있으면(재실행 시 중복 방지) 건너뛴다.
 */
export function rewriteIssuesForExpired({ expired = [], openIssues = [] } = {}) {
  const existingTitles = new Set(openIssues.map((i) => i.title));
  const out = [];
  for (const id of expired) {
    const title = `rewrite flaky test at another level: ${id}`;
    if (existingTitles.has(title)) continue;
    out.push({
      title,
      body: `격리된 테스트 \`${id}\`가 TTL(quarantine_ttl_days)을 넘겼습니다. 이 테스트가 지키던 동작을 다른 테스트 레벨에서 다시 검증하는 테스트를 작성하세요(§5.2.5-⑤). 다시 K회 실패하면 그 동작은 삭제 후보가 되고, 삭제는 사람이 머지하는 제안 PR로만 일어납니다.`,
      labels: ["backlog", "factory:flaky"],
    });
  }
  return out;
}

/**
 * deletionCandidates({ issues, commentsByIssue, K = 3 }) → [{id, issue}]
 * 재작성 이슈(`rewrite flaky test at another level: <id>`) 중 open이고 `factory:needs-human`에
 * 다시 K회 이상 도달한 것 — 삭제는 여기서 하지 않는다(호출자가 `_retro.md` 후보로 기록하고
 * `DECISIONS.md` append는 사람 머지 제안 PR로 낸다, §5.2.5-⑤ "조용히 일어나지 않는다").
 */
export function deletionCandidates({ issues = [], commentsByIssue, K = 3 } = {}) {
  const byIssue = asMap(commentsByIssue);
  const out = [];
  for (const issue of issues) {
    const m = /^rewrite flaky test at another level:\s*(.+)$/.exec(String(issue?.title ?? "").trim());
    if (!m) continue;
    if (issue?.state !== "open" || !hasLabel(issue, NEEDS_HUMAN_LABEL)) continue;
    const events = needsHumanEvents(byIssue.get(issue.number));
    if (events.length >= K) out.push({ id: m[1].trim(), issue: issue.number });
  }
  return out;
}
