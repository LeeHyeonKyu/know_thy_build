import { STATES } from "./labels.js";

/**
 * §13.3 `:status`의 계산 절반(읽기 전용 데이터 합성). GitHub 호출·파일 읽기는 전부 `cli/status.js`가
 * 하고, 이 파일은 이미 읽어온 값들을 조합해 사람이 볼 화면을 만들 뿐이다 — 그래서 순수 함수다:
 * 테스트가 gh/git 없이 buildStatus/renderStatus를 직접 검증할 수 있다.
 */

const NEEDS_HUMAN = "factory:needs-human";
const NEEDS_INFO = "factory:needs-info";
const IN_PROGRESS = "factory:in-progress";
const MERGED = "factory:merged";
const AWAITING_REVIEW = "factory:awaiting-review";

// "대기 중"으로 보여줄 상태들, 파이프라인 순서. in-progress(별도 섹션)·merged(별도 섹션)·
// needs-human/needs-info(Needs You로 흡수)·blocked(sweeper가 자동 회수를 시도하는 중이라
// 사람이 지금 볼 필요는 없다 — needs-human으로 에스컬레이션되면 그때 Needs You에 뜬다)는 뺀다.
const QUEUE_STATES = ["factory:queue", "factory:ready", "factory:planned", AWAITING_REVIEW, "factory:rework", "factory:approved"];

const labelOf = (issue) => (issue.labels || []).find((l) => STATES.has(l)) || null;

function minutesBetween(fromIso, toIso) {
  const a = Date.parse(fromIso), b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 60000);
}

export function buildStatus({
  issues = [], prs = {}, heartbeats = new Map(), quarantine = { quarantined: [] },
  thresholds = {}, charter = {}, usage = null, now, staleMinutes = 30,
} = {}) {
  const needsYou = [];
  for (const i of issues) {
    if (labelOf(i) === NEEDS_HUMAN) needsYou.push({ kind: "needs-human", number: i.number, title: i.title, hint: `:unstick ${i.number}` });
  }
  for (const i of issues) {
    if (labelOf(i) === NEEDS_INFO) needsYou.push({ kind: "needs-info", number: i.number, title: i.title, hint: `:clarify ${i.number}` });
  }
  for (const p of prs.retroProposal || []) {
    needsYou.push({ kind: "retro-proposal", number: p.number, title: p.title, hint: `:proposal ${p.number}` });
  }
  for (const p of prs.harness || []) {
    needsYou.push({ kind: "harness", number: p.number, title: p.title, hint: `:harness ${p.number}` });
  }

  const inProgress = issues
    .filter((i) => labelOf(i) === IN_PROGRESS)
    .map((i) => {
      const last = heartbeats.get(i.number);
      const age_min = last != null ? minutesBetween(last, now) : null;
      return { number: i.number, title: i.title, state: IN_PROGRESS, stage: "implement", age_min, stale: age_min != null && age_min > staleMinutes };
    });

  const queue = [];
  for (const state of QUEUE_STATES) {
    for (const i of issues) {
      if (labelOf(i) === state) queue.push({ number: i.number, title: i.title, state });
    }
  }

  const recent = issues
    .filter((i) => labelOf(i) === MERGED)
    .slice()
    .sort((a, b) => Date.parse(b.closedAt || 0) - Date.parse(a.closedAt || 0))
    .slice(0, 10)
    .map((i) => ({ number: i.number, title: i.title, mergedAt: i.closedAt }));

  const backPressure = {
    awaiting_review: issues.filter((i) => labelOf(i) === AWAITING_REVIEW).length,
    max: charter?.back_pressure?.awaiting_review_max,
    quarantined: (quarantine.quarantined || []).length,
    quarantine_max: thresholds.quarantine_max,
  };

  return { needsYou, queue, inProgress, recent, backPressure, usage };
}

/** §13 `:status`와 같은 섹션 순서: Needs You → 진행 중 → 큐 → 역압 → 최근 머지 → 사용량. */
export function renderStatus(s) {
  const lines = [];

  lines.push("## Needs You");
  if (s.needsYou.length === 0) lines.push("(none)");
  else for (const n of s.needsYou) lines.push(`- [${n.kind}] #${n.number} ${n.title} — ${n.hint}`);
  lines.push("");

  lines.push("## 진행 중");
  if (s.inProgress.length === 0) lines.push("(none)");
  else for (const p of s.inProgress) lines.push(`- #${p.number} ${p.title} · ${p.stage} · ${p.age_min ?? "?"}m${p.stale ? " · STALE" : ""}`);
  lines.push("");

  lines.push("## 큐");
  if (s.queue.length === 0) lines.push("(none)");
  else for (const q of s.queue) lines.push(`- #${q.number} ${q.title} · ${q.state}`);
  lines.push("");

  lines.push("## 역압");
  lines.push(`- awaiting-review: ${s.backPressure.awaiting_review}/${s.backPressure.max}`);
  lines.push(`- quarantined: ${s.backPressure.quarantined}/${s.backPressure.quarantine_max}`);
  lines.push("");

  lines.push("## 최근 머지");
  if (s.recent.length === 0) lines.push("(none)");
  else for (const r of s.recent) lines.push(`- #${r.number} ${r.title} · ${r.mergedAt}`);
  lines.push("");

  lines.push("## 사용량");
  if (s.usage) {
    lines.push(`- window (since ${s.usage.window.since}): $${s.usage.window.cost_usd} / ${s.usage.window.runs} runs`);
    lines.push(`- total: $${s.usage.total.cost_usd} / ${s.usage.total.runs} runs`);
  } else {
    lines.push("(no data)");
  }

  return lines.join("\n");
}
