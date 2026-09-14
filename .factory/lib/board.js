/**
 * §4.2 factory board — **뷰어의 모델** (ADR-022 Task B).
 *
 * **문제.** Task A가 진행 신호를 만들었다: 도는 스테이지는 2분마다 하트비트 코멘트에
 * `<!-- factory-progress:v1 {…} -->`를 싣고, 끝난 런은 같은 마커를 `docs/factory/runs/<n>.md`에
 * 남긴다. 그러나 그 신호는 **이슈마다 흩어져 있다** — 소유자가 묻는 것은 "이슈 #7이 어디쯤인가"가
 * 아니라 "지금 **모든** 이슈가 어디에 있고, 어느 스텝이 돌고 있고, 어떤 에이전트가 무엇을 하고,
 * 토큰을 얼마나 태웠는가"이고, 그것도 KTB를 설치한 **모든 저장소**에 대해서다.
 *
 * 이 파일은 그 질문에 답하는 **하나의 객체**를 만든다. 순수 함수다 — gh도 fs도 시계도 만지지 않는다
 * (`now`는 인자다). 조회는 전부 `cli/board.js`가 하고 여기에는 이미 읽어온 값만 들어온다. 그래서
 * 테스트가 픽스처 코멘트·런 기록·`gh run list` JSON만으로 모델 전체를 고정할 수 있다.
 *
 * **읽는 것은 이미 있는 기록뿐이다** — 새 신호를 하나도 만들지 않는다:
 *   - 상태 = 라벨(`lib/labels.js` STATES).
 *   - 언제 그 상태가 됐나 = 전이 코멘트(`<!-- factory-transition:v1 … -->`, `lib/retro/issue-comments.js`).
 *   - 지금 살아 있나 = 하트비트 코멘트 첫 줄(`stage · runner · started · last`).
 *   - 지금 무엇을 하나 = 그 코멘트의 `progress:v1` 마커(`lib/progress.js`).
 *   - 얼마를 태웠나 = 기록 브랜치의 `usage:` 줄(`lib/usage.js`) + 도는 런의 `totals`.
 *   - 어느 잡이 도나 = `gh run list`의 `databaseId`와 러너 id `gha-<runId>`.
 *
 * 파서를 여기서 새로 쓰지 않는 것이 이 파일의 규칙이다: 정규식도 가격표도 전부 원래 주인에게서
 * 가져다 쓴다(`PROGRESS_MARKER_RE`·`TRANSITION_TO`·`BLOCKED_ORIGIN`·`parseRunRecord`·`parseHandoffs`).
 * 뷰어가 자기 사본을 들면 "보드가 말하는 사실"과 "공장이 아는 사실"이 조용히 갈라진다.
 */

import { STATES, TIER_LABELS, factoryLabelOf } from "./labels.js";
import { PROGRESS_MARKER_RE, parseProgressMarker } from "./progress.js";
import { TRANSITION_TO, TRANSITION_FAILED, BLOCKED_ORIGIN, blockedCause } from "./retro/issue-comments.js";
import { parseRunRecord } from "./usage.js";
import { parseHandoffs } from "./handoff.js";

// ── 신선도 ──────────────────────────────────────────────────────────────────

/**
 * 하트비트 주기는 2분이다(ADR-022 결정 2). 그래서 **5분**은 "한 번쯤 놓쳤다"이고 아직 정상이다.
 * **30분**은 우연이 아니라 sweeper의 stale 임계와 **같은 숫자**다(`lib/sweeper.js`) — 보드가 "죽었다"고
 * 부르는 순간과 공장이 그 런을 좀비로 판정하는 순간이 어긋나면, 사람은 화면에서 빨간 카드를 보면서
 * 공장은 아직 아무 일도 하지 않는(또는 그 반대의) 구간이 생긴다.
 */
export const FRESH_MIN = 5;
export const STALE_MIN = 30;
/**
 * 큐에 걸린 잡을 좀비로 보기까지의 유예. GitHub Actions가 러너를 붙이는 데 보통 수십 초, 혼잡할 때
 * 몇 분이 걸린다 — 10분은 그 정상 범위를 넉넉히 덮으면서, 동시성 한도에 영원히 걸린 잡(그 잡은
 * 하트비트를 **한 번도** 쓰지 못한다)을 사람이 알아차릴 만큼은 짧다.
 */
export const ZOMBIE_QUEUED_MIN = 10;

const minutesBetween = (fromIso, toIso) => {
  const a = Date.parse(fromIso ?? ""), b = Date.parse(toIso ?? "");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 60000;
};

/** 마지막 하트비트로부터 지난 시간 → `fresh`|`stale`|`dead`. 읽을 수 없으면 null("모른다"). */
export function freshness(lastIso, now) {
  const min = minutesBetween(lastIso, now);
  if (min == null) return null;
  if (min < FRESH_MIN) return "fresh";
  if (min < STALE_MIN) return "stale";
  return "dead";
}

// ── 레인 ────────────────────────────────────────────────────────────────────

/**
 * 보드의 열 = §3.2 전이 그래프를 **왼쪽에서 오른쪽으로 편 것**이다. 순서는 임의가 아니라 이슈가
 * 실제로 지나가는 순서이고, 그래서 카드가 오른쪽으로 움직이는 것 자체가 진척이다.
 *
 * `factory:rework`만 자기 열이 없다 — 재작업은 **implement의 재진입**이지 새 단계가 아니다
 * (`ENTRY_LABELS.implement`가 `planned`와 `rework`를 같은 스테이지의 진입 라벨로 묶는다). 카드에는
 * 진짜 상태 라벨 칩이 그대로 붙으므로 열을 합쳐도 숨겨지는 사실은 없다.
 *
 * 옆 레인 셋은 **사람 차례**이거나(needs-human·needs-info) 공장이 회수를 시도하는 중(blocked)이라
 * 파이프라인의 흐름에서 빠져 있다 — 같은 줄에 두면 "왼쪽에서 오른쪽"이라는 읽기가 깨진다.
 */
export const LANES = [
  { id: "queue", label: "큐", states: ["factory:queue"] },
  { id: "ready", label: "계획 대기", states: ["factory:ready"] },
  { id: "planned", label: "구현 대기", states: ["factory:planned"] },
  { id: "in-progress", label: "구현 중", states: ["factory:in-progress", "factory:rework"] },
  { id: "awaiting-review", label: "리뷰 중", states: ["factory:awaiting-review"] },
  { id: "approved", label: "머지 대기", states: ["factory:approved"] },
  { id: "merged", label: "머지됨", states: ["factory:merged"] },
];
export const SIDE_LANES = [
  { id: "needs-human", label: "사람 필요", states: ["factory:needs-human"] },
  { id: "blocked", label: "막힘", states: ["factory:blocked"] },
  { id: "needs-info", label: "정보 필요", states: ["factory:needs-info"] },
];
/** 그래프 밖(백로그·wont-do)과 **상태 라벨이 없는 이슈**. 후자가 이 레인의 존재 이유다(ADR-020 KTB-30). */
export const OTHER_LANE = { id: "other", label: "기타", states: ["backlog", "factory:wont-do"] };

const LANE_BY_STATE = new Map();
for (const lane of [...LANES, ...SIDE_LANES, OTHER_LANE]) for (const s of lane.states) LANE_BY_STATE.set(s, lane.id);

export const laneOf = (state) => LANE_BY_STATE.get(state) ?? OTHER_LANE.id;

/**
 * 이 상태에서 **다음에 돌 스테이지**. 하트비트가 없을 때 카드가 "무엇을 기다리는가"를 말하는 값이고,
 * 하트비트가 있으면 그쪽이 이긴다(그건 추측이 아니라 지금 실제로 도는 스테이지다).
 *
 * `lib/status.js`의 `labelFallbackStage`보다 넓다 — 그 함수는 "진행 중" 보고라서 확실한 둘만 채웠지만,
 * 보드의 열은 이미 상태별로 갈라져 있어서 "queue 열의 카드가 triage를 기다린다"는 것이 오독될 여지가
 * 없다. 그래서 카드에는 `stage`(사실)와 `expected_stage`(기대)를 **따로** 싣는다.
 */
export const STAGE_BY_STATE = {
  "factory:queue": "triage",
  "factory:ready": "plan",
  "factory:planned": "implement",
  "factory:in-progress": "implement",
  "factory:rework": "implement",
  "factory:awaiting-review": "review",
  "factory:approved": "merge",
};

// ── 하트비트 코멘트 ─────────────────────────────────────────────────────────

/**
 * `lib/heartbeat.js`가 쓰는 본문의 첫 두 줄. 이 모양은 ADR-022 결정 3이 "절대 바뀌지 않는다"고
 * 못 박은 계약이고, sweeper의 좀비 감시와 `cli/status.js`도 같은 줄을 읽는다.
 */
const HEARTBEAT_MARKER = /<!--\s*factory-heartbeat issue=(\d+)\s*-->/;
const HB_FIELD = (name) => new RegExp(`${name}:\\s*(\\S+)`);
const HB_STAGE = HB_FIELD("stage"), HB_RUNNER = HB_FIELD("runner"), HB_STARTED = HB_FIELD("started"), HB_LAST = HB_FIELD("last");

/**
 * 하트비트 코멘트 하나 → `{issue, stage, runner, started, last, progress}`. 하트비트가 아니면 null.
 * `progress`는 같은 본문의 `progress:v1` 마커다 — 없으면(폴백 본문) null이고, 그건 오류가 아니라
 * "이 주기에는 진행 읽기가 실패했다"는 사실 그대로다(ADR-022 결정 3).
 */
export function parseHeartbeatComment(body) {
  const text = String(body ?? "");
  const m = HEARTBEAT_MARKER.exec(text);
  if (!m) return null;
  const head = text.split("\n").slice(0, 2).join("\n");
  const pick = (re) => re.exec(head)?.[1] ?? null;
  return {
    issue: Number(m[1]),
    stage: pick(HB_STAGE),
    runner: pick(HB_RUNNER),
    started: pick(HB_STARTED),
    last: pick(HB_LAST),
    progress: parseProgressMarker(text),
  };
}

/**
 * 이 이슈의 **마지막** 하트비트. 하트비트는 언제나 같은 코멘트를 PATCH하므로 보통 하나뿐이지만,
 * 재큐된 이슈는 주기마다 새 런이 새 코멘트를 만든다 — 최신 것이 지금의 사실이다.
 *
 * `issue=` 값을 확인하는 이유: 이슈 본문·다른 코멘트가 남의 하트비트를 인용할 수 있고(디버깅 붙여넣기),
 * 그걸 이 이슈의 생존 신호로 읽으면 죽은 런이 살아 있는 것으로 보인다.
 */
export function latestHeartbeat(comments, issue) {
  let found = null;
  for (const c of comments || []) {
    const hb = parseHeartbeatComment(c?.body);
    if (!hb || hb.issue !== Number(issue)) continue;
    found = { ...hb, commentId: c.id ?? null, at: c.createdAt ?? null };
  }
  return found;
}

// ── 전이 · 타임라인 ─────────────────────────────────────────────────────────

/**
 * 이슈 코멘트 전체 → 시간순 전이 목록. `lastTransition`(하나만)의 복수형이고, 사유 추출 규칙도
 * 그 함수와 **글자 그대로 같다**(마커 뒤 ` — `부터 줄 끝까지).
 *
 * `factory-transition-failed:v1`은 **뒤따르는 취소표**다(ADR-020 r2): 전이 코멘트가 라벨 스왑보다
 * 먼저 나가므로, 스왑이 통째로 실패하면 일어나지 않은 전이의 코멘트가 이슈에 남는다. 그 코멘트를
 * 타임라인에 그리면 카드가 실제와 다른 열에 있던 구간을 보여 준다 — `countTransitionsTo`가 라운드
 * 계산에서 같은 취소를 적용하는 것과 정확히 같은 규칙으로 지운다.
 */
export function allTransitions(comments) {
  const out = [];
  for (const c of comments || []) {
    const body = String(c?.body ?? "");
    const failed = TRANSITION_FAILED.exec(body);
    if (failed) {
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].to === failed[2]) { out.splice(i, 1); break; }
      }
      continue;
    }
    const m = TRANSITION_TO.exec(body);
    if (!m) continue;
    const rest = body.slice(m.index + m[0].length);
    const dash = rest.indexOf(" — ");
    out.push({
      from: m[1], to: m[2], by: m[3], reason: dash === -1 ? "" : rest.slice(dash + 3).split("\n")[0].trim(),
      at: c?.createdAt ?? null,
    });
  }
  return out;
}

const round = (n, digits = 6) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * 전이 목록 → **연속된 구간들**. 구간 하나 = "이 이슈가 이 상태에 머문 시간"이고, 그것이 타임라인
 * 뷰의 막대 하나다. 마지막 구간만 `now`에서 닫히고 `open: true`다 — 지금 흐르고 있는 시간이다.
 *
 * 같은 상태가 두 번 나오면 **구간도 두 개다**(합치지 않는다). 재시도는 정확히 그 모양으로 보인다:
 * `awaiting-review → blocked → awaiting-review`는 리뷰 막대 하나가 아니라 둘이고, 그 사이의
 * blocked 막대가 잃은 시간이다. 합쳐 버리면 화면에서 재시도가 사라진다.
 *
 * `createdAt`을 주면 **첫 전이 앞**에 첫 전이의 `from` 상태 구간을 하나 더 만든다(이슈가 열린 뒤
 * triage를 기다린 시간). 없으면 만들지 않는다 — 시작 시각을 모르면서 막대를 그리면 거짓말이다.
 */
export function buildTimeline(transitions, { createdAt = null, now } = {}) {
  const ts = (transitions || []).filter((t) => Number.isFinite(Date.parse(t?.at ?? "")));
  const segments = [];
  if (createdAt && ts.length && Number.isFinite(Date.parse(createdAt))) {
    segments.push({ state: ts[0].from, from: createdAt, to: ts[0].at, by: null, reason: "" });
  }
  for (let i = 0; i < ts.length; i++) {
    segments.push({ state: ts[i].to, from: ts[i].at, to: i + 1 < ts.length ? ts[i + 1].at : now, by: ts[i].by, reason: ts[i].reason });
  }
  return segments.map((s, i) => ({
    ...s,
    stage: STAGE_BY_STATE[s.state] ?? null,
    lane: laneOf(s.state),
    duration_min: round(minutesBetween(s.from, s.to) ?? 0, 2),
    open: i === segments.length - 1,
  }));
}

// ── Actions 런 ──────────────────────────────────────────────────────────────

/**
 * 이 이슈의 **지금 도는(또는 방금 끝난) 잡**. 두 단계로 찾는다:
 *
 *   1. **러너 id.** 워크플로가 `FACTORY_RUNNER_ID: gha-${{ github.run_id }}`를 넘기고 하트비트가 그
 *      값을 그대로 싣는다 — 즉 `gha-<databaseId>`는 추측이 아니라 **신원**이다. 하트비트가 있으면
 *      언제나 이 경로로 붙는다.
 *   2. **스테이지 워크플로 + 이슈.** 하트비트가 아직(또는 영영) 없는 런에는 1번이 쓸 수 없다 —
 *      큐에 걸린 잡이 정확히 그 경우이고, 그 잡이야말로 사람이 봐야 하는 것이다(`zombie-queued`).
 *      `gh run list`는 워크플로 입력을 싣지 않으므로 `displayTitle`(라벨 이벤트에서는 이슈 제목)과
 *      `#<번호>` 언급으로 맞춘다 — **best-effort이고 모델이 그렇게 말한다**(`matched_by`).
 */
export function matchRun(runs, { runner = null, stage = null, number = null, title = null } = {}) {
  const list = (runs || []).filter((r) => r && r.databaseId != null);
  const shape = (r, matched_by) => ({
    id: Number(r.databaseId), status: r.status ?? null, conclusion: r.conclusion ?? null,
    workflow: r.workflowName ?? null, url: r.url ?? null, created_at: r.createdAt ?? null,
    event: r.event ?? null, matched_by,
  });
  if (runner) {
    const m = /^gha-(\d+)$/.exec(String(runner));
    const hit = m && list.find((r) => String(r.databaseId) === m[1]);
    if (hit) return shape(hit, "runner");
  }
  if (!stage) return null;
  const workflow = `factory-${stage}`;
  const t = String(title ?? "").trim();
  const candidates = list
    .filter((r) => r.workflowName === workflow)
    .filter((r) => (t && String(r.displayTitle ?? "").includes(t)) || (number != null && String(r.displayTitle ?? "").includes(`#${number}`)))
    .sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0));
  return candidates.length ? shape(candidates[0], "workflow") : null;
}

// ── 비용 ────────────────────────────────────────────────────────────────────

/**
 * 이 이슈가 지금까지 태운 돈. 두 출처를 더하고, **절대 두 번 세지 않는다**:
 *   - `finished_usd` — 기록 브랜치의 `usage:` 줄들(`parseRunRecord`). 끝난 런의 진짜 청구액이다.
 *   - `live_usd` — 도는 런의 `progress.totals.cost_usd`(가격표는 `lib/usage.js` 한 벌뿐이다 — ADR-022 결정 5).
 *
 * 겹침 판정: 같은 `runner`와 `stage`를 가진 기록 섹션이 이미 있으면 **그 런은 끝났고 기록이 진실이다**.
 * 하트비트 코멘트는 런이 끝나도 이슈에 그대로 남아 있으므로(마지막 PATCH 내용 그대로), 이 검사가 없으면
 * 끝난 런 하나가 기록과 하트비트 양쪽에서 두 번 더해진다. 러너를 모르면(로컬 실행 등) 그 판정을 할 수
 * 없으므로 더하는 쪽을 고른다 — 빠뜨리는 것보다 낫고, `progress_source`가 출처를 밝힌다.
 */
export function costOf({ progress = null, recordText = null, heartbeat = null } = {}) {
  const entries = recordText ? parseRunRecord(recordText) : [];
  let finished = 0;
  for (const e of entries) if (e.cost_usd != null) finished += e.cost_usd;

  const liveRaw = Number(progress?.totals?.cost_usd);
  const runner = heartbeat?.runner ?? progress?.runner ?? null;
  const stage = heartbeat?.stage ?? progress?.stage ?? null;
  const alreadyRecorded = Boolean(runner) && entries.some((e) => e.runner === runner && (!stage || e.stage === stage));
  const live = Number.isFinite(liveRaw) && !alreadyRecorded ? liveRaw : 0;

  return { live_usd: round(live), finished_usd: round(finished), total_usd: round(finished + live), runs: entries.length };
}

// ── 카드 ────────────────────────────────────────────────────────────────────

/** 런 기록 안의 **마지막** `progress:v1` 마커(끝난 런의 진행 스냅샷). 전역 플래그만 다시 붙여 쓴다. */
const PROGRESS_MARKER_G = new RegExp(PROGRESS_MARKER_RE.source, "g");
function lastProgressIn(text) {
  let found = null;
  for (const m of String(text ?? "").matchAll(PROGRESS_MARKER_G)) {
    try { found = JSON.parse(m[1]); } catch { /* 깨진 마커는 없는 것으로 — 이건 보고서지 판정이 아니다 */ }
  }
  return found;
}

const tierOf = (labels) => {
  const l = (labels || []).find((x) => TIER_LABELS.has(x));
  return l ? l.slice("factory:tier-".length) : null;
};

/** 상태 라벨이 둘 이상인 이슈도 화면에서 사라지면 안 된다 — 첫 번째를 쓰고 `two-state-labels`로 고발한다. */
function stateOf(labels) {
  try { return { state: factoryLabelOf(labels || []), conflict: false }; }
  catch { return { state: (labels || []).find((l) => STATES.has(l)) ?? null, conflict: true }; }
}

/**
 * 이슈 하나 → 카드 하나. 화면의 카드·타임라인 행·상세 패널이 **전부 이 객체 하나**에서 그려진다:
 * 같은 사실이 세 곳에서 따로 계산되면 어느 화면이 옳은지 알 수 없게 된다.
 */
export function buildIssueCard({ repo, issue, comments = [], recordText = null, runs = [], now }) {
  const labels = issue?.labels || [];
  const { state, conflict } = stateOf(labels);
  const number = Number(issue?.number);

  const transitions = allTransitions(comments);
  const last = transitions[transitions.length - 1] || null;
  const heartbeat = latestHeartbeat(comments, number);
  const hbFreshness = heartbeat ? freshness(heartbeat.last, now) : null;
  // 죽은 하트비트는 "지금 도는 런"이 아니다 — 마지막 PATCH가 그대로 남아 있는 것뿐이라, 그 진행
  // 내용을 라이브로 그리면 몇 시간 전의 스텝이 현재로 보인다. 그때는 기록 쪽 마커로 떨어진다.
  const liveProgress = heartbeat && hbFreshness !== "dead" ? heartbeat.progress : null;
  const recordProgress = lastProgressIn(recordText);
  const progress = liveProgress ?? recordProgress ?? null;
  const progress_source = liveProgress ? "heartbeat" : (recordProgress ? "record" : null);

  const handoffs = parseHandoffs(comments);
  const lastHandoff = handoffs[handoffs.length - 1] || null;

  const run = matchRun(runs, { runner: heartbeat?.runner ?? null, stage: heartbeat?.stage ?? STAGE_BY_STATE[state] ?? null, number, title: issue?.title });

  const flags = [];
  if (state === "factory:needs-human") flags.push({ kind: "needs-human" });
  if (state === "factory:blocked") {
    let origin = null;
    for (const c of comments || []) { const m = BLOCKED_ORIGIN.exec(String(c?.body ?? "")); if (m) origin = m; }
    const reason = last?.to === "factory:blocked" ? last.reason : "";
    flags.push({ kind: "blocked", detail: origin?.[3] ?? blockedCause(reason) });
  }
  if (state === null) flags.push({ kind: "no-state-label" });
  if (conflict) flags.push({ kind: "two-state-labels", detail: labels.filter((l) => STATES.has(l)).join(", ") });
  // 좀비 큐: 잡은 큐에 앉아 있는데(러너를 못 받았다) 하트비트는 **한 줄도** 없다. 살아 있는
  // 하트비트가 하나라도 있으면 그 런은 시작한 것이므로 이 깃발은 붙지 않는다.
  const queuedMin = run?.status === "queued" ? minutesBetween(run.created_at, now) : null;
  if (queuedMin != null && queuedMin > ZOMBIE_QUEUED_MIN && (!heartbeat || hbFreshness === "dead")) {
    flags.push({ kind: "zombie-queued", detail: `${Math.round(queuedMin)}m` });
  }

  return {
    key: `${repo}#${number}`,
    repo, number,
    title: issue?.title ?? "",
    url: `https://github.com/${repo}/issues/${number}`,
    state,
    lane: laneOf(state),
    tier: tierOf(labels),
    labels,
    stage: heartbeat?.stage ?? null,
    expected_stage: STAGE_BY_STATE[state] ?? null,
    since: last?.at ?? null,
    since_min: last?.at ? round(minutesBetween(last.at, now) ?? 0, 2) : null,
    updated_at: issue?.updatedAt ?? null,
    heartbeat: heartbeat
      ? { runner: heartbeat.runner, stage: heartbeat.stage, started: heartbeat.started, last: heartbeat.last, age_min: round(minutesBetween(heartbeat.last, now) ?? 0, 2), freshness: hbFreshness, comment_id: heartbeat.commentId }
      : null,
    progress, progress_source,
    step: progress?.step ?? null,
    agents: progress?.agents ?? [],
    totals: progress?.totals ?? null,
    files_touched: progress?.files_touched ?? [],
    handoff: lastHandoff ? { stage: lastHandoff.stage, summary: (lastHandoff.summary || "").split("\n")[0].trim(), at: lastHandoff.createdAt ?? null } : null,
    run,
    timeline: buildTimeline(transitions, { createdAt: issue?.createdAt ?? null, now }),
    transitions,
    cost: costOf({ progress, recordText, heartbeat }),
    flags,
  };
}

// ── 보드 ────────────────────────────────────────────────────────────────────

/**
 * 저장소 여러 개 → 화면 하나. 레인 목록을 **모델이 싣는다**(페이지가 자기 목록을 들지 않는다) —
 * 열 순서와 한글 이름이 두 곳에 있으면 한쪽만 바뀌는 날이 온다.
 *
 * 조회에 실패한 저장소는 **빠지지 않는다**: `repos[]`에 `error`와 함께 남는다. 조용히 사라지면
 * "그 저장소에 일이 없다"와 구별할 수 없고, 그 구별이야말로 사람이 알아야 하는 것이다.
 */
export function buildBoard({ repos = [], now } = {}) {
  const issues = [];
  const repoRows = [];
  for (const r of repos) {
    if (r?.error) { repoRows.push({ repo: r.repo, error: String(r.error), issue_count: 0 }); continue; }
    const cards = (r.issues || [])
      .map((entry) => buildIssueCard({ repo: r.repo, issue: entry.issue, comments: entry.comments, recordText: entry.recordText, runs: r.runs || [], now }))
      .sort((a, b) => a.number - b.number);
    issues.push(...cards);
    repoRows.push({ repo: r.repo, error: null, issue_count: cards.length, fetched_at: r.fetchedAt ?? null });
  }

  const withIssues = (lane) => ({ ...lane, issues: issues.filter((i) => i.lane === lane.id).map((i) => i.key) });
  const totals = issues.reduce(
    (acc, i) => ({
      issues: acc.issues + 1,
      cost_usd: round(acc.cost_usd + i.cost.total_usd),
      live: acc.live + (i.heartbeat?.freshness === "fresh" || i.heartbeat?.freshness === "stale" ? 1 : 0),
      needs_you: acc.needs_you + (i.flags.some((f) => f.kind === "needs-human" || f.kind === "no-state-label") ? 1 : 0),
    }),
    { issues: 0, cost_usd: 0, live: 0, needs_you: 0 },
  );

  return {
    version: 1,
    generated_at: now,
    repos: repoRows,
    lanes: LANES.map(withIssues),
    side_lanes: SIDE_LANES.map(withIssues),
    other_lane: withIssues(OTHER_LANE),
    issues,
    totals,
  };
}
