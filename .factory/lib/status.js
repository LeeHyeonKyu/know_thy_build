import { STATES } from "./labels.js";
import { UNFINISHED_RUN_STATUSES } from "./sweeper.js";

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

/**
 * #234 (gap P-8, B-2) — **Actions가 막혔는가.** 포함 분 소진·spending limit·GitHub 장애에서 스테이지도 sweeper도
 * 전부 워크플로라 함께 멈추고, 그 사실을 말해 줄 주체가 Actions 안에는 없다. 사람이 Actions 밖에서 돌리는 이
 * 화면이 맨 윗줄로 말한다. 입력은 `cli/status.js`가 읽어 온 최근 20개 런(+필요한 런만 잡·annotation)과
 * `factory:queue` 이슈의 라벨 시각이다.
 *
 * 무엇을 "시작하지 못한 런"으로 세는가(넷 중 하나):
 *   - 아직 러너를 기다리는 런(queued/pending/waiting/requested)이 생성 후 **24분 넘게** 지났다.
 *   - `startup_failure` — 데모(docs/factory/dogfood/2026-09-12-demo.md 라운드 9~11)의 장애 모양. billing 낱말은 어디에도 없다.
 *   - `failure`인데 잡이 **한 스텝도** 돌지 않았다(잡 0개 포함) — spending limit 차단의 모양. 평범한 테스트 실패(스텝이 돈
 *     잡)는 세지 않는다: 그것까지 세면 이 줄은 매일 켜져 있고 사람은 그것을 무시하는 법을 배운다.
 *   - `cancelled`인데 잡이 한 스텝도 돌지 않았고 **큐에 24분 넘게 앉아 있다가** 취소됐다. 시간 조건이 붙는 이유: 이
 *     저장소의 실제 런 목록에서 `cancelled`·jobs `[]`의 대부분은 concurrency 그룹이 **1초 안에** 밀어낸 대기 런이다
 *     (sweeper가 스테이지마다 뜬다) — 조건 없이 세면 이 줄은 늘 켜진다. 이슈의 문장도 "큐에 24분 이상 머물다 취소"다.
 *   - 그리고 실패한 잡의 annotation(gh가 billing 문구를 싣는 유일한 자리)이 `billing`/`spending limit`을 말하는 `failure`.
 * 그런 런이라도 **그보다 나중에 만들어진 런 하나가 실제로 돌았으면** 세지 않는다(plan s2): billing이 돌아와 Actions가
 * 다시 돌면 옛 런이 20개 창에서 밀려나기를 기다리지 않고 줄이 사라진다. "돌았다" = in_progress·success·스텝이 돈 잡.
 * `skipped`(잡의 `if:`가 거짓)나 1초 취소는 러너를 받은 증거가 아니므로 해제하지 않는다.
 *
 * `factory:queue` 라벨이 **10분 넘게** 서 있는데 그 뒤로 시작한 런이 하나도 없으면 같은 줄을 낸다 — triage는 그 라벨의
 * `labeled` 이벤트로 뜨므로 10분이면 이미 돌았어야 한다.
 *
 * `factory board`의 `zombie-queued`(ZOMBIE_QUEUED_MIN=10, lib/board.js)와 문턱이 다르다: 그것은 **이슈 하나의** 잡이
 * 하트비트 없이 큐에 앉은 것을 보고, 이것은 저장소 전체에서 Actions가 런을 시작시키지 못하는가를 본다. 24분은 이슈가
 * 정한 값이다(셀프호스트 러너 한 대가 바쁠 때 정상 대기가 10분을 넘는다 — plan open risk).
 */
export const ACTIONS_QUEUED_MIN = 24;
export const QUEUE_LABEL_MIN = 10;
export const ACTIONS_RUN_LIMIT = 20;
// 러너를 기다리는 상태 = sweeper의 "끝나지 않은 런" 목록에서 이미 러너를 받은 in_progress만 뺀 것(목록을 두 벌 두지 않는다).
const WAITING_RUN_STATUSES = new Set(UNFINISHED_RUN_STATUSES.filter((s) => s !== "in_progress"));
export const BILLING_RE = /billing|spending limit/i;

const minutesFloat = (fromIso, toIso) => {
  const a = Date.parse(fromIso ?? ""), b = Date.parse(toIso ?? "");
  return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / 60000 : null;
};
const jobStarted = (j) => Number(j?.steps) > 0 || j?.status === "in_progress";

/** 이 런의 잡을 읽어야 판정할 수 있는가 — `cli/status.js`가 그 런에만 `runJobs`를 부른다(호출 수를 묶는다). */
export function runNeedsJobs(r) {
  if (r?.status !== "completed") return false;
  if (r.conclusion === "failure") return true;
  return r.conclusion === "cancelled" && (minutesFloat(r.createdAt, r.updatedAt) ?? 0) > ACTIONS_QUEUED_MIN;
}

/** 이 런이 러너를 받아 실제로 돌았는가(나중의 이런 런 하나가 옛 차단을 해제한다). */
function runStarted(r) {
  if (r?.status === "in_progress") return true;
  if (r?.conclusion === "success") return true;
  return Array.isArray(r?.jobs) && r.jobs.some(jobStarted);
}

/** 시작하지 못한 런인가 — 이유 문자열, 아니면 null. */
function blockedReason(r, now) {
  if (WAITING_RUN_STATUSES.has(String(r?.status))) {
    const age = minutesFloat(r.createdAt, now);
    return age != null && age > ACTIONS_QUEUED_MIN ? "queued" : null;
  }
  if (r?.status !== "completed") return null;
  if (r.conclusion === "startup_failure") return "startup_failure";
  const jobsKnown = Array.isArray(r.jobs);
  const noneStarted = jobsKnown && !r.jobs.some(jobStarted);
  if (r.conclusion === "failure") {
    if (noneStarted) return "never-started";
    if (jobsKnown && r.jobs.some((j) => (j.annotations || []).some((m) => BILLING_RE.test(String(m))))) return "billing";
    return null;
  }
  if (r.conclusion === "cancelled" && noneStarted && (minutesFloat(r.createdAt, r.updatedAt) ?? 0) > ACTIONS_QUEUED_MIN) return "cancelled-before-start";
  return null;
}

/**
 * `{ runs, queued }` → `{ runs: n, run_ids, queue: [{number, age_min}] }` 또는 null(줄 없음). `actions`가 null이면(런 목록을
 * 못 읽었다) null — 못 읽은 것을 "막혔다"로도 "멀쩡하다"로도 그리지 않는다; 나머지 화면은 그대로다.
 */
export function actionsBlocked(actions, now) {
  if (!actions || !Array.isArray(actions.runs)) return null;
  const runs = actions.runs;
  const startedAfter = (iso) => {
    const t = Date.parse(iso ?? "");
    return runs.some((s) => runStarted(s) && Number.isFinite(t) && Date.parse(s.createdAt ?? "") > t);
  };
  const flagged = runs.filter((r) => blockedReason(r, now) && !startedAfter(r.createdAt));
  const queue = [];
  for (const q of actions.queued || []) {
    const age = minutesFloat(q.labeledAt, now);
    if (age == null || age <= QUEUE_LABEL_MIN) continue;
    const t = Date.parse(q.labeledAt);
    if (runs.some((s) => runStarted(s) && Date.parse(s.createdAt ?? "") >= t)) continue;
    queue.push({ number: q.number, age_min: Math.round(age) });
  }
  if (!flagged.length && !queue.length) return null;
  return { runs: flagged.length, run_ids: flagged.map((r) => r.id), reasons: flagged.map((r) => blockedReason(r, now)), queue };
}

export function actionsBlockedLine(b) {
  const head = `ACTIONS BLOCKED? ${b.runs} run(s) queued >${ACTIONS_QUEUED_MIN} min / cancelled before any step — check Actions billing`;
  if (!b.queue?.length) return head;
  return `${head} · factory:queue held >${QUEUE_LABEL_MIN} min with no run started: ${b.queue.map((q) => `#${q.number} (${q.age_min}m)`).join(", ")}`;
}

export function buildStatus({
  issues = [], prs = {}, heartbeats = new Map(), quarantine = { quarantined: [] },
  thresholds = {}, charter = {}, usage = null, overlap = null, now, staleMinutes = 30, actions = null,
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
  /**
   * r2 SF6 — **sweeper 8번 팔과 같은 집합을 본다.** 예전에는 `factory:*` 라벨이 남아 있는 이슈만
   * 셌는데, 그 팔은 라벨이 **하나도** 없는 이슈도 전이 이력으로 잡는다(`sweeper.js`) — triage가 tier
   * 라벨을 붙이기 전에 상태 라벨을 잃은 이슈가 정확히 그 모양이다(#2). 사람이 보는 창구가 복구 팔보다
   * 좁으면, 팔이 고치지 못한 바로 그 이슈가 화면에서도 사라진다. `factoryTransition`은 CLI가 코멘트를
   * 읽어 세워 주는 플래그다(순수 함수인 이 파일은 gh를 만지지 않는다).
   */
  for (const i of issues) {
    if (labelOf(i) !== null) continue;
    if (!(i.labels || []).some((l) => String(l).startsWith("factory:")) && i.factoryTransition !== true) continue;
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

  return { needsYou, queue, inProgress, recent, backPressure, usage, overlap, actionsBlocked: actionsBlocked(actions, now) };
}

/**
 * 외부 감사 2026-09-14 P2-13 — 리뷰어 겹침 한 줄. 이 화면은 "지금 무엇을 기다리는가"를 보여주지만,
 * 리뷰어 5명을 계속 띄울지 말지는 **겹침**이 답한다: 겹침이 1에 가까우면 다섯이 같은 것을 다섯 번
 * 찾고 있다는 뜻이고, 0에 가까우면 각 렌즈가 자기만 보는 것을 들고 온다는 뜻이다. 분모가 0인 창은
 * 비율을 만들지 않는다 — "겹치지 않았다"와 "판정할 finding이 없었다"는 다른 사실이다.
 */
export function overlapLine(o) {
  if (!o || !Number.isFinite(Number(o.findings_total))) return "- review overlap (30d): (no data)";
  const total = Number(o.findings_total) || 0;
  if (total === 0) return `- review overlap (30d): no findings in ${Number(o.review_runs) || 0} review run(s)`;
  const uniq = Object.entries(o.unique_findings_by_role || {});
  const uniqText = uniq.length ? uniq.map(([r, n]) => `${r} ${n}`).join(", ") : "none";
  return `- review overlap (30d): ${Number(o.overlap_ratio ?? 0).toFixed(2)} (${Number(o.overlapping_findings) || 0}/${total} findings raised by ≥2 roles, ${Number(o.review_runs) || 0} review run(s)) · unique: ${uniqText}`;
}

/** §13 `:status`와 같은 섹션 순서: Needs You → 진행 중 → 큐 → 역압 → 최근 머지 → 사용량. */
export function renderStatus(s) {
  const lines = [];

  // #234 — 맨 윗줄. Actions가 막혔으면 아래의 모든 섹션(진행 중·큐)이 "멈춘 이유"를 거짓으로 그린다.
  if (s.actionsBlocked) lines.push(actionsBlockedLine(s.actionsBlocked), "");

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
  lines.push(overlapLine(s.overlap));
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

  // ADR-022 Task B — 이 보고서는 **한 시점**이다. 스테이지가 8–35분을 도는 동안 무엇이 일어나는지는
  // 여기 없다(하트비트의 age_min 한 숫자뿐이다). 보드가 그 자리를 채운다는 사실을 사람이 알 수 있는
  // 곳은 사람이 이미 보고 있는 이 화면이다 — 그래서 마지막 한 줄로 남긴다.
  lines.push("", "board: npx know-thy-build factory board");

  return lines.join("\n");
}
