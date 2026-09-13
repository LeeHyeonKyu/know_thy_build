import { STATES } from "./labels.js";

/**
 * §13.3 `:status`의 계산 절반(읽기 전용 데이터 합성). GitHub 호출·파일 읽기는 전부 `cli/status.js`가
 * 하고, 이 파일은 이미 읽어온 값들을 조합해 사람이 볼 화면을 만들 뿐이다 — 그래서 순수 함수다:
 * 테스트가 gh/git 없이 buildStatus/renderStatus를 직접 검증할 수 있다.
 */

const NEEDS_HUMAN = "factory:needs-human";
const NEEDS_INFO = "factory:needs-info";
const IN_PROGRESS = "factory:in-progress";
const BLOCKED = "factory:blocked";
const MERGED = "factory:merged";
const AWAITING_REVIEW = "factory:awaiting-review";
const REWORK = "factory:rework";

// "진행 중"으로 보여줄 상태들 — 지금 어떤 스테이지가 돌고 있거나(in-progress·awaiting-review 동안
// review가 돈다·rework는 implement 재진입 직전) 자동 회수가 시도되는 중(blocked)인 상태 전부.
// blocked는 fix round 1(Critical #2)까지는 조회만 되고 화면 어디에도 안 떴다 — sweeper가 회수를
// 시도하는 중이라도 사람이 지금 뭘 기다리는지는 봐야 한다(다만 Needs You는 아니다 — 아직 사람 차례가
// 아니다. sweeper가 못 살리면 needs-human으로 에스컬레이션되고 그때 Needs You에 뜬다).
const LIVE_STATES = [IN_PROGRESS, BLOCKED, AWAITING_REVIEW, REWORK];
// "대기 중" — 아직 어떤 스테이지도 시작 안 한 상태.
const QUEUE_STATES = ["factory:queue", "factory:ready", "factory:planned", "factory:approved"];

const labelOf = (issue) => (issue.labels || []).find((l) => STATES.has(l)) || null;

function minutesBetween(fromIso, toIso) {
  const a = Date.parse(fromIso), b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 60000);
}

// heartbeat이 없을 때만 쓰는 fallback — 라벨 자체가 "지금 어느 스테이지를 기다리는지"를 말해주는
// 두 상태(awaiting-review → review가 돈다, rework → implement가 재진입한다)에만 적용된다.
// in-progress·blocked는 라벨만으로 어느 스테이지였는지 알 수 없다(in-progress는 claim 시점에 라벨이
// 이미 바뀌어 있고, blocked는 임의의 게이트 스테이지에서 올 수 있다) — heartbeat이 없으면 null.
function labelFallbackStage(state) {
  if (state === AWAITING_REVIEW) return "review";
  if (state === REWORK) return "implement";
  return null;
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
  /**
   * ADR-020 KTB-30 — factory 라벨은 달고 있는데 **상태 라벨이 하나도 없는** 열린 이슈. 라벨 스왑이
   * 중간에 실패한 흔적이고(데모 #2 08:52Z·#15 08:55Z), 그 이슈는 상태별 조회 어디에도 안 걸려
   * 이 화면에서 통째로 사라졌다 — 사람이 "아무 일도 안 일어나는 이슈"를 볼 창구가 필요하다.
   * sweeper가 대개 먼저 되살리므로 힌트는 사람이 할 일이 아니라 그 사실을 가리킨다.
   */
  for (const i of issues) {
    if (labelOf(i) !== null) continue;
    if (!(i.labels || []).some((l) => String(l).startsWith("factory:"))) continue;
    needsYou.push({ kind: "no-state-label", number: i.number, title: i.title, hint: "sweeper → label restore" });
  }
  for (const p of prs.retroProposal || []) {
    needsYou.push({ kind: "retro-proposal", number: p.number, title: p.title, hint: `:proposal ${p.number}` });
  }
  for (const p of prs.harness || []) {
    needsYou.push({ kind: "harness", number: p.number, title: p.title, hint: `:harness ${p.number}` });
  }

  const inProgress = [];
  for (const state of LIVE_STATES) {
    for (const i of issues) {
      if (labelOf(i) !== state) continue;
      const hb = heartbeats.get(i.number) || null;
      const age_min = hb?.last != null ? minutesBetween(hb.last, now) : null;
      const stage = hb?.stage ?? labelFallbackStage(state);
      inProgress.push({
        number: i.number,
        title: i.title,
        state,
        stage,
        age_min,
        stale: age_min != null && age_min >= staleMinutes,
        hint: state === BLOCKED ? "sweeper → needs-human" : null,
      });
    }
  }

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
  else for (const p of s.inProgress) {
    const stage = p.stage ?? "?";
    const suffix = [p.stale ? "STALE" : null, p.hint].filter(Boolean).join(" · ");
    lines.push(`- #${p.number} ${p.title} · ${p.state} · ${stage} · ${p.age_min ?? "?"}m${suffix ? " · " + suffix : ""}`);
  }
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
    if (s.usage.perIssue.length === 0) lines.push("(none)");
    else for (const p of s.usage.perIssue.slice(0, 10)) {
      lines.push(`- #${p.issue} $${p.cost_usd} · ${p.runs} runs · ${p.tokens.input} input(+cache) / ${p.tokens.output} output tokens`);
    }
    lines.push(`- window (since ${s.usage.window.since}): $${s.usage.window.cost_usd} / ${s.usage.window.runs} runs`);
    lines.push(`- total: $${s.usage.total.cost_usd} / ${s.usage.total.runs} runs`);
  } else {
    lines.push("(no data)");
  }

  return lines.join("\n");
}
