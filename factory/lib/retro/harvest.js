// 경량 수확(§8.1/§8.4 "경량 추출") — 결정적, LLM 없음. 매 머지마다 돌아 review handoff의
// must_fix(reject) 주장·plan handoff의 미해결 dissent·`factory:needs-human`으로 간 전이 코멘트·
// `factory:flaky` 라벨을 후보로 축적하고, 병합 통계(리뷰 라운드 평균·리뷰어별 reject·사용량)를 낸다.
// 채택 여부·N 조정·PR/이슈 생성은 전부 L1(bin/retro.js, 이 파일 밖) 몫이다(P4-R4) — 여기는 순수 함수,
// fs를 만지지 않는다.

import { parseHandoffs } from "../handoff.js";
import { summarizeUsage } from "../usage.js";
import { afterSince, extractNeedsHuman, flakyIdFromTitle, TRANSITION_TO } from "./issue-comments.js";

const FLAKY_LABEL = "factory:flaky";
const MERGED_LABEL = "factory:merged";

// (role,text) 합성 키의 구분자 — role/claim/objection 텍스트에 나타날 수 없는, 화면에 보이지 않는
// 코드 31("unit separator")짜리 한 글자. 공백은 역할 이름에 공백이 있을 가능성을 배제할 수 없어
// 부적합했다. 소스 파일 자체에는 이 글자를 리터럴 바이트로도, escape 리터럴로도 박아두지 않는다 —
// 코드로 조립한다. 그래서 소스는 항상 순수 텍스트로 남고 git이 정상적인 diff를 보여준다(리터럴
// 바이트를 그대로 박아두면 git이 파일을 binary로 판정해 diff·리뷰가 깨진다).
const KEY_SEP = String.fromCharCode(31);
const roleTextKey = (role, text) => `${role}${KEY_SEP}${text}`;

const labelName = (l) => (typeof l === "string" ? l : l?.name);
const hasLabel = (issue, name) => Array.isArray(issue?.labels) && issue.labels.some((l) => labelName(l) === name);

/**
 * lesson 후보: review handoff의 reject 판정 must_fix 항목 하나당 하나(role=그 리뷰어, text=claim 원문 —
 * 일반화는 에이전트 몫). example 후보: plan handoff의 미해결(dissent_log[].resolution이 "unresolved"/
 * "deferred"를 담은) dissent 하나당 하나. 둘 다 `since` 이후 handoff만 본다 — 이전 retro가 이미 본
 * claim/dissent를 매번 다시 후보로 올리지 않는다.
 */
function extractLessonsAndExamples(issueNumber, handoffs, sinceMs) {
  const lessons = [];
  const examples = [];
  for (const h of handoffs) {
    if (!afterSince(h.createdAt, sinceMs)) continue;
    if (h.stage === "review") {
      for (const v of Array.isArray(h.data?.verdicts) ? h.data.verdicts : []) {
        if (v?.verdict !== "reject") continue;
        for (const mf of Array.isArray(v.must_fix) ? v.must_fix : []) {
          if (!mf?.claim) continue;
          lessons.push({ role: v.role, text: mf.claim, runs: [issueNumber], source: "must_fix" });
        }
      }
    }
    if (h.stage === "plan") {
      for (const d of Array.isArray(h.data?.dissent_log) ? h.data.dissent_log : []) {
        if (!/unresolved|deferred/i.test(String(d?.resolution ?? ""))) continue;
        examples.push({ role: d.role, kind: "good", text: d.objection, runs: [issueNumber], source: "dissent" });
      }
    }
  }
  return { lessons, examples };
}

function isMerged(issue, comments) {
  if (hasLabel(issue, MERGED_LABEL)) return true;
  if (issue?.state !== "closed") return false;
  return comments.some((c) => {
    const m = TRANSITION_TO.exec(c?.body || "");
    return m && m[2] === MERGED_LABEL;
  });
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * (role,text) 키로 합치며 `runs`를 유니온한다 — 같은 claim/objection이 다른 이슈에서 또 나오면 누적.
 * 키는 항상 **원문 그대로의 텍스트 일치**다(정규화 없음 — 대소문자·표현을 통일하거나 같은 뜻의 다른
 * 문장을 하나로 묶는 일은 하지 않는다). 그건 결정적 스크립트의 일이 아니라 retro 에이전트(analyst)가
 * 후보를 보고 판단할 몫이다(§8.4 "일반화는 에이전트 몫") — 여기서 뭉치면 그 판단 기회를 지워버린다.
 */
function foldByRoleText(list, item) {
  const key = roleTextKey(item.role, item.text);
  const existing = list.find((x) => x.__key === key);
  if (existing) {
    for (const r of item.runs) if (!existing.runs.includes(r)) existing.runs.push(r);
    return list;
  }
  list.push({ ...item, runs: [...item.runs], __key: key });
  return list;
}
const dropKey = ({ __key, ...rest }) => rest;

/**
 * `harvest({records, issues, commentsByIssue, since}) → {candidates, stats}` — §8.1/§8.4 경량 수확.
 *   - records: Map<issue,text>(run 기록 전문, `_retro`는 retro 자신의 기록이라 건너뛴다).
 *   - issues: [{number,title,labels,state,closedAt}].
 *   - commentsByIssue: Map<issue, comments[]>(raw — `{id,body,createdAt}`). handoff·전이 둘 다 이
 *     코멘트에서 결정적으로 파싱한다(parseHandoffs 재사용) — 사전 파싱 산출물을 받지 않는 이유는
 *     needs_human이 handoff가 아니라 전이 코멘트(`factory-transition(-refused)?:v1`)에서만 나오기 때문.
 *   - since: ISO|null — null이면 이력 전체.
 */
export function harvest({ records, issues, commentsByIssue, since = null } = {}) {
  const sinceMs = since == null ? null : Date.parse(since);
  const recs = records instanceof Map ? records : new Map(Object.entries(records || {}));
  const byIssue = commentsByIssue instanceof Map ? commentsByIssue : new Map(Object.entries(commentsByIssue || {}));

  let lessons = [];
  let examples = [];
  const flaky = [];
  let needsHuman = [];

  let mergedCount = 0;
  let reviewRoundsSum = 0;
  const rejectsByRole = {};

  for (const issue of issues || []) {
    const comments = byIssue.get(issue.number) || [];
    const handoffs = parseHandoffs(comments);

    if (hasLabel(issue, FLAKY_LABEL)) flaky.push({ id: flakyIdFromTitle(issue.title), issue: issue.number });

    const { lessons: ls, examples: ex } = extractLessonsAndExamples(issue.number, handoffs, sinceMs);
    for (const l of ls) lessons = foldByRoleText(lessons, l);
    for (const x of ex) examples = foldByRoleText(examples, x);

    needsHuman = needsHuman.concat(extractNeedsHuman(issue.number, comments, sinceMs));

    // 통계 스코프 결정(리뷰 컨트롤러 재확인): 병합된 이슈 각각을 "그 이슈의 closedAt이 since를
    // 지날 때" 정확히 한 번만 센다 — 그때 그 이슈의 리뷰 handoff 전체 이력(since 이전 라운드 포함)을
    // 쓴다. delta는 이슈 단위다: 한 이슈의 리뷰 라운드는 그 이슈가 병합되는 순간에 전부 세는 것이지
    // retro 사이를 걸쳐 나눠 세지 않는다(같은 라운드가 두 retro에 걸쳐 다시 세어질 일도, 어느 retro
    // 에도 안 세어질 일도 없다 — 이슈가 병합되는 순간은 항상 정확히 한 번이다).
    if (isMerged(issue, comments) && afterSince(issue.closedAt, sinceMs)) {
      mergedCount += 1;
      const reviewHandoffs = handoffs.filter((h) => h.stage === "review");
      const maxRound = reviewHandoffs.reduce((mx, h) => (typeof h.data?.round === "number" ? Math.max(mx, h.data.round) : mx), 0);
      reviewRoundsSum += maxRound;
      for (const h of reviewHandoffs) {
        for (const v of Array.isArray(h.data?.verdicts) ? h.data.verdicts : []) {
          if (v?.verdict === "reject") rejectsByRole[v.role] = (rejectsByRole[v.role] || 0) + 1;
        }
      }
    }
  }

  const usageRecords = new Map([...recs].filter(([k]) => k !== "_retro"));
  // summarizeUsage는 "지금부터 windowDays"의 창을 요구하지만 여기서 쓰는 건 window가 아니라 `.total`
  // (레코드 전체 합)뿐이다 — now는 유효한 날짜이기만 하면 결과에 영향이 없다(new Date(NaN) 방지용).
  const usage = summarizeUsage(usageRecords, { now: since ?? new Date(0).toISOString(), windowDays: 1 });
  const tokens = usage.perIssue.reduce(
    (acc, r) => ({ input: acc.input + (r.tokens.input || 0), output: acc.output + (r.tokens.output || 0) }),
    { input: 0, output: 0 },
  );

  return {
    candidates: {
      lessons: lessons.map(dropKey),
      examples: examples.map(dropKey),
      flaky,
      needs_human: needsHuman,
    },
    stats: {
      merged: mergedCount,
      review_rounds_avg: mergedCount ? round2(reviewRoundsSum / mergedCount) : 0,
      rejects_by_role: rejectsByRole,
      needs_human: needsHuman.length,
      usage: { cost_usd: usage.total.cost_usd, tokens },
    },
  };
}

const keyOf = {
  lessons: (x) => roleTextKey(x.role, x.text),
  examples: (x) => roleTextKey(x.role, x.text),
  flaky: (x) => x.id,
  needs_human: (x) => String(x.issue),
};

function mergeList(kind, existingList, freshList) {
  const key = keyOf[kind];
  const order = [];
  const byKey = new Map();
  for (const item of existingList || []) {
    const k = key(item);
    if (!byKey.has(k)) order.push(k);
    byKey.set(k, { ...item, runs: Array.isArray(item.runs) ? [...item.runs] : undefined });
  }
  for (const item of freshList || []) {
    const k = key(item);
    const cur = byKey.get(k);
    if (!cur) {
      order.push(k);
      byKey.set(k, { ...item, runs: Array.isArray(item.runs) ? [...item.runs] : undefined });
      continue;
    }
    if (Array.isArray(cur.runs) && Array.isArray(item.runs)) {
      for (const r of item.runs) if (!cur.runs.includes(r)) cur.runs.push(r);
    } else {
      // runs가 없는 종류(flaky/needs_human) — fresh가 새 사건이므로 최신 필드로 갱신한다.
      byKey.set(k, { ...cur, ...item });
    }
  }
  return order.map((k) => byKey.get(k));
}

/**
 * `_retro.md`에 쌓인 기존 후보(existing)와 이번 경량 수확(fresh)을 합친다 — (role,text)/(id)/(issue)로
 * 유니온하고 `runs`는 합집합. 근거가 아직 최소 창(§8.4)에 못 미치는 후보를 다음 retro가 또 보는 경로다.
 */
export function mergeCandidates(existing, fresh) {
  const e = existing || {};
  const f = fresh || {};
  return {
    lessons: mergeList("lessons", e.lessons, f.lessons),
    examples: mergeList("examples", e.examples, f.examples),
    flaky: mergeList("flaky", e.flaky, f.flaky),
    needs_human: mergeList("needs_human", e.needs_human, f.needs_human),
  };
}
