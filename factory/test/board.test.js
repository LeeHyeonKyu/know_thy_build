import { test, expect } from "vitest";
import {
  FRESH_MIN, STALE_MIN, ZOMBIE_QUEUED_MIN, LANES, SIDE_LANES,
  freshness, laneOf, parseHeartbeatComment, latestHeartbeat, allTransitions,
  buildTimeline, matchRun, costOf, buildIssueCard, buildBoard,
} from "../lib/board.js";
import { progressMarker } from "../lib/progress.js";
import { renderHandoff } from "../lib/handoff.js";

const NOW = "2026-09-15T12:00:00Z";
const ago = (min) => new Date(Date.parse(NOW) - min * 60000).toISOString();

/** heartbeat.js가 실제로 쓰는 본문 그대로(첫 두 줄 + 마커). 모양이 바뀌면 이 테스트가 먼저 운다. */
function heartbeatBodyFor(issue, { stage = "implement", runner = "gha-42", started = ago(20), last = ago(2), progress = null }) {
  const head = `<!-- factory-heartbeat issue=${issue} -->\nstage: ${stage} · runner: ${runner} · started: ${started} · last: ${last}`;
  return progress ? `${head}\n${progressMarker(progress)}\nstep: …` : head;
}

function progressV1({ cost = 0.42, label = "R1:architecture" } = {}) {
  return {
    stage: "implement", issue: 7, runner: "gha-42", started: ago(20), updated: ago(2),
    step: { phase: "R1", label, since: ago(6) },
    agents: [
      { label: "orchestrator", kind: "orchestrator", status: "running", started: ago(20), ended: null, last_tool: "Read src/a.js", turns: 12, input_tokens: 1000, output_tokens: 200, cache_read_tokens: 50, cost_usd: 0.2 },
      { label, kind: "subagent", status: "running", started: ago(6), ended: null, last_tool: "Grep foo", turns: 3, input_tokens: 500, output_tokens: 100, cache_read_tokens: 0, cost_usd: 0.22 },
    ],
    totals: { turns: 15, input_tokens: 1500, output_tokens: 300, cache_read_tokens: 50, cost_usd: cost },
    files_touched: ["src/a.js", "src/b.js"],
  };
}

const transitionComment = (from, to, at, { by = "script", reason = "" } = {}) => ({
  id: Math.floor(Math.random() * 1e9),
  body: `<!-- factory-transition:v1 from=${from} to=${to} by=${by} -->\n${from} → ${to}${reason ? ` — ${reason}` : ""}`,
  createdAt: at,
});

const RECORD = `# issue #7

## implement · 2026-09-15T10:00Z · gha-41
usage: {"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":900} cost_usd: 1.5 num_turns: 9 terminal_reason: end_turn models: claude-opus-5=$1.5

## review · 2026-09-15T11:00Z · gha-40
usage: {"input_tokens":10,"output_tokens":5} cost_usd: 0.25 num_turns: 2 terminal_reason: end_turn models: claude-sonnet-4=$0.25
`;

// ── freshness · lanes ───────────────────────────────────────────────────────

test("freshness: <5min fresh, <30min stale, older dead, unparsable null", () => {
  expect(FRESH_MIN).toBe(5);
  expect(STALE_MIN).toBe(30);
  expect(freshness(ago(1), NOW)).toBe("fresh");
  expect(freshness(ago(4.9), NOW)).toBe("fresh");
  expect(freshness(ago(5), NOW)).toBe("stale");
  expect(freshness(ago(29), NOW)).toBe("stale");
  expect(freshness(ago(30), NOW)).toBe("dead");
  expect(freshness(ago(600), NOW)).toBe("dead");
  expect(freshness(null, NOW)).toBe(null);
  expect(freshness("not a date", NOW)).toBe(null);
});

test("laneOf: the seven graph lanes, three side lanes, rework folds into in-progress, the rest is 기타", () => {
  expect(LANES.map((l) => l.id)).toEqual(["queue", "ready", "planned", "in-progress", "awaiting-review", "approved", "merged"]);
  expect(SIDE_LANES.map((l) => l.id)).toEqual(["needs-human", "blocked", "needs-info"]);
  expect(laneOf("factory:queue")).toBe("queue");
  expect(laneOf("factory:rework")).toBe("in-progress");
  expect(laneOf("factory:needs-human")).toBe("needs-human");
  expect(laneOf("factory:wont-do")).toBe("other");
  expect(laneOf(null)).toBe("other");
});

// ── heartbeat · progress ────────────────────────────────────────────────────

test("parseHeartbeatComment reads the first line and the progress:v1 marker off the same body", () => {
  const p = progressV1();
  const hb = parseHeartbeatComment(heartbeatBodyFor(7, { progress: p }));
  expect(hb.stage).toBe("implement");
  expect(hb.runner).toBe("gha-42");
  expect(hb.last).toBe(ago(2));
  expect(hb.progress.totals.cost_usd).toBe(0.42);
  expect(hb.progress.step.label).toBe("R1:architecture");
});

test("parseHeartbeatComment tolerates the two-line fallback body (no marker) and refuses foreign comments", () => {
  const hb = parseHeartbeatComment(heartbeatBodyFor(7, {}));
  expect(hb.progress).toBe(null);
  expect(hb.stage).toBe("implement");
  expect(parseHeartbeatComment("just a human comment")).toBe(null);
});

test("latestHeartbeat picks the last comment carrying THIS issue's heartbeat marker", () => {
  const comments = [
    { id: 1, body: heartbeatBodyFor(7, { last: ago(40) }), createdAt: ago(40) },
    { id: 2, body: heartbeatBodyFor(9, { last: ago(1) }), createdAt: ago(1) },   // 다른 이슈의 하트비트
    { id: 3, body: heartbeatBodyFor(7, { last: ago(2), runner: "gha-99" }), createdAt: ago(30) },
  ];
  const hb = latestHeartbeat(comments, 7);
  expect(hb.runner).toBe("gha-99");
  expect(hb.commentId).toBe(3);
  expect(latestHeartbeat(comments, 11)).toBe(null);
});

// ── transitions · timeline ──────────────────────────────────────────────────

test("allTransitions reads every transition in order and drops the ones a transition-failed marker cancels", () => {
  const comments = [
    transitionComment("factory:queue", "factory:ready", ago(300), { by: "triage" }),
    transitionComment("factory:ready", "factory:planned", ago(240)),
    { id: 9, body: "<!-- factory-transition:v1 from=factory:planned to=factory:in-progress by=script -->", createdAt: ago(200) },
    { id: 10, body: "<!-- factory-transition-failed:v1 from=factory:planned to=factory:in-progress -->", createdAt: ago(199) },
    transitionComment("factory:planned", "factory:in-progress", ago(180)),
  ];
  const ts = allTransitions(comments);
  expect(ts.map((t) => t.to)).toEqual(["factory:ready", "factory:planned", "factory:in-progress"]);
  expect(ts[0].by).toBe("triage");
  expect(ts[2].at).toBe(ago(180));
});

test("buildTimeline turns transitions into contiguous segments whose durations close on now", () => {
  const ts = allTransitions([
    transitionComment("factory:queue", "factory:ready", ago(300)),
    transitionComment("factory:ready", "factory:planned", ago(240)),
    transitionComment("factory:planned", "factory:in-progress", ago(180)),
  ]);
  const tl = buildTimeline(ts, { createdAt: ago(360), now: NOW });
  expect(tl.map((s) => [s.state, s.duration_min])).toEqual([
    ["factory:queue", 60],
    ["factory:ready", 60],
    ["factory:planned", 60],
    ["factory:in-progress", 180],
  ]);
  expect(tl[3].open).toBe(true);      // 마지막 구간만 아직 닫히지 않았다
  expect(tl[0].open).toBe(false);
  expect(tl[3].stage).toBe("implement");
});

test("buildTimeline shows a retry as a second segment in the same state (it does not collapse them)", () => {
  const ts = allTransitions([
    transitionComment("factory:awaiting-review", "factory:blocked", ago(120)),
    transitionComment("factory:blocked", "factory:awaiting-review", ago(90)),
  ]);
  const tl = buildTimeline(ts, { createdAt: ago(200), now: NOW });
  expect(tl.map((s) => s.state)).toEqual(["factory:awaiting-review", "factory:blocked", "factory:awaiting-review"]);
  expect(tl.filter((s) => s.state === "factory:awaiting-review").length).toBe(2);
});

test("buildTimeline without createdAt starts at the first transition (no invented leading segment)", () => {
  const ts = allTransitions([transitionComment("factory:queue", "factory:ready", ago(60))]);
  const tl = buildTimeline(ts, { now: NOW });
  expect(tl.map((s) => s.state)).toEqual(["factory:ready"]);
  expect(tl[0].duration_min).toBe(60);
});

// ── runs ────────────────────────────────────────────────────────────────────

const runs = () => [
  { databaseId: 42, status: "in_progress", conclusion: null, workflowName: "factory-implement", displayTitle: "a thing", url: "https://gh/run/42", createdAt: ago(20), event: "issues" },
  { databaseId: 7, status: "queued", conclusion: null, workflowName: "factory-review", displayTitle: "other thing", url: "https://gh/run/7", createdAt: ago(15), event: "issues" },
  { databaseId: 5, status: "completed", conclusion: "success", workflowName: "factory-plan", displayTitle: "a thing", url: "https://gh/run/5", createdAt: ago(200), event: "issues" },
];

test("matchRun binds by runner id first — gha-<databaseId> is an exact identity, not a guess", () => {
  const r = matchRun(runs(), { runner: "gha-42", stage: "review", number: 7, title: "other thing" });
  expect(r.id).toBe(42);
  expect(r.matched_by).toBe("runner");
  expect(r.status).toBe("in_progress");
  expect(r.url).toBe("https://gh/run/42");
});

test("matchRun falls back to stage workflow + issue title/number, newest first, and says so", () => {
  const r = matchRun(runs(), { runner: null, stage: "plan", number: 3, title: "a thing" });
  expect(r.id).toBe(5);
  expect(r.matched_by).toBe("workflow");
  expect(matchRun(runs(), { runner: null, stage: "merge", number: 3, title: "a thing" })).toBe(null);
});

// ── cost ────────────────────────────────────────────────────────────────────

test("costOf sums the records-branch runs and adds the live run on top", () => {
  const c = costOf({ progress: progressV1({ cost: 0.42 }), recordText: RECORD, heartbeat: { runner: "gha-42", stage: "implement" } });
  expect(c.finished_usd).toBe(1.75);
  expect(c.runs).toBe(2);
  expect(c.live_usd).toBe(0.42);
  expect(c.total_usd).toBe(2.17);
});

test("costOf never counts a run twice — a finished record with the same runner+stage wins over its live marker", () => {
  const c = costOf({ progress: progressV1({ cost: 0.9 }), recordText: RECORD, heartbeat: { runner: "gha-41", stage: "implement" } });
  expect(c.live_usd).toBe(0);
  expect(c.total_usd).toBe(1.75);
});

test("costOf with no record and no progress is all zeros (not null — the card always has a number)", () => {
  expect(costOf({})).toEqual({ live_usd: 0, finished_usd: 0, total_usd: 0, runs: 0 });
});

// ── issue card ──────────────────────────────────────────────────────────────

function cardArgs(over = {}) {
  return {
    repo: "o/r",
    issue: { number: 7, title: "a thing", labels: ["factory:in-progress", "factory:tier-standard"], createdAt: ago(360), updatedAt: ago(2) },
    comments: [
      transitionComment("factory:queue", "factory:ready", ago(300)),
      transitionComment("factory:ready", "factory:planned", ago(240)),
      transitionComment("factory:planned", "factory:in-progress", ago(180)),
      { id: 50, body: renderHandoff({ stage: "plan", issue: 7, summary: "계획 완료 — done_when 3개", data: { done_when: [] } }), createdAt: ago(200) },
      { id: 60, body: heartbeatBodyFor(7, { progress: progressV1() }), createdAt: ago(20) },
    ],
    recordText: RECORD,
    runs: runs(),
    now: NOW,
    ...over,
  };
}

test("buildIssueCard carries state, tier, stage, freshness, live progress, handoff, run and cost on one object", () => {
  const c = buildIssueCard(cardArgs());
  expect(c.key).toBe("o/r#7");
  expect(c.repo).toBe("o/r");
  expect(c.url).toBe("https://github.com/o/r/issues/7");
  expect(c.state).toBe("factory:in-progress");
  expect(c.lane).toBe("in-progress");
  expect(c.tier).toBe("standard");
  expect(c.stage).toBe("implement");
  expect(c.since).toBe(ago(180));
  expect(c.since_min).toBe(180);
  expect(c.heartbeat.freshness).toBe("fresh");
  expect(c.heartbeat.age_min).toBe(2);
  expect(c.progress.step.label).toBe("R1:architecture");
  expect(c.progress_source).toBe("heartbeat");
  expect(c.agents.map((a) => a.label)).toEqual(["orchestrator", "R1:architecture"]);
  expect(c.files_touched).toEqual(["src/a.js", "src/b.js"]);
  expect(c.handoff).toMatchObject({ stage: "plan" });
  expect(c.handoff.summary).toContain("계획 완료");
  expect(c.run.id).toBe(42);
  expect(c.cost.total_usd).toBe(2.17);
  expect(c.timeline.length).toBe(4);
  expect(c.flags).toEqual([]);
});

test("buildIssueCard falls back to the last progress marker in the run record when no heartbeat is live", () => {
  const p = progressV1({ label: "V:verifier" });
  const record = `${RECORD}\n${progressMarker(p)}\n`;
  const c = buildIssueCard(cardArgs({ comments: [transitionComment("factory:planned", "factory:in-progress", ago(180))], recordText: record }));
  expect(c.heartbeat).toBe(null);
  expect(c.progress_source).toBe("record");
  expect(c.progress.step.label).toBe("V:verifier");
});

test("buildIssueCard with no state label raises no-state-label and lands in 기타", () => {
  const c = buildIssueCard(cardArgs({ issue: { number: 7, title: "orphan", labels: ["factory:tier-docs"], createdAt: ago(60) } }));
  expect(c.state).toBe(null);
  expect(c.lane).toBe("other");
  expect(c.flags.map((f) => f.kind)).toContain("no-state-label");
  expect(c.expected_stage).toBe(null);
});

test("buildIssueCard flags needs-human, and blocked carries the cause off the blocked-origin marker", () => {
  const nh = buildIssueCard(cardArgs({ issue: { number: 7, title: "x", labels: ["factory:needs-human"], createdAt: ago(60) } }));
  expect(nh.flags.map((f) => f.kind)).toEqual(["needs-human"]);

  const blocked = buildIssueCard(cardArgs({
    issue: { number: 7, title: "x", labels: ["factory:blocked"], createdAt: ago(60) },
    comments: [{ id: 1, body: "<!-- factory-transition:v1 from=factory:awaiting-review to=factory:blocked by=script -->\nfactory:awaiting-review → factory:blocked — API error 429\n<!-- factory-blocked-origin from=factory:awaiting-review stage=review cause=api-error -->", createdAt: ago(30) }],
  }));
  expect(blocked.flags).toEqual([{ kind: "blocked", detail: "api-error" }]);
});

test("zombie-queued: a run queued past the grace period with no heartbeat — and not flagged once one arrives", () => {
  const queuedRuns = [{ databaseId: 88, status: "queued", conclusion: null, workflowName: "factory-implement", displayTitle: "a thing", url: "https://gh/run/88", createdAt: ago(ZOMBIE_QUEUED_MIN + 5), event: "issues" }];
  const args = cardArgs({ comments: [transitionComment("factory:planned", "factory:in-progress", ago(30))], runs: queuedRuns, recordText: null });
  expect(buildIssueCard(args).flags.map((f) => f.kind)).toContain("zombie-queued");

  const fresh = [{ ...queuedRuns[0], createdAt: ago(ZOMBIE_QUEUED_MIN - 1) }];
  expect(buildIssueCard({ ...args, runs: fresh }).flags.map((f) => f.kind)).not.toContain("zombie-queued");

  const withHeartbeat = { ...args, comments: [...args.comments, { id: 70, body: heartbeatBodyFor(7, { last: ago(1) }), createdAt: ago(1) }] };
  expect(buildIssueCard(withHeartbeat).flags.map((f) => f.kind)).not.toContain("zombie-queued");
});

// ── board (multi-repo) ──────────────────────────────────────────────────────

test("buildBoard merges several repos into one lane model, sorted, with per-repo chips and errors kept", () => {
  const a = cardArgs();
  const b = {
    repo: "o/demo",
    issues: [
      { issue: { number: 3, title: "demo queue", labels: ["factory:queue"], createdAt: ago(30) }, comments: [transitionComment("backlog", "factory:queue", ago(30))], recordText: null },
      { issue: { number: 4, title: "demo stuck", labels: ["factory:needs-human"], createdAt: ago(90) }, comments: [transitionComment("factory:blocked", "factory:needs-human", ago(50))], recordText: null },
    ],
    runs: [],
  };
  const model = buildBoard({
    repos: [
      { repo: "o/r", issues: [{ issue: a.issue, comments: a.comments, recordText: a.recordText }], runs: a.runs },
      b,
      { repo: "o/broken", error: "gh issue list failed (1)" },
    ],
    now: NOW,
  });

  expect(model.generated_at).toBe(NOW);
  expect(model.repos.map((r) => r.repo)).toEqual(["o/r", "o/demo", "o/broken"]);
  expect(model.repos[2].error).toContain("gh issue list failed");
  expect(model.repos[0].issue_count).toBe(1);
  expect(model.issues.map((i) => i.key).sort()).toEqual(["o/demo#3", "o/demo#4", "o/r#7"]);
  expect(model.lanes.find((l) => l.id === "in-progress").issues).toEqual(["o/r#7"]);
  expect(model.lanes.find((l) => l.id === "queue").issues).toEqual(["o/demo#3"]);
  expect(model.side_lanes.find((l) => l.id === "needs-human").issues).toEqual(["o/demo#4"]);
  expect(model.totals.cost_usd).toBe(2.17);
  expect(model.totals.issues).toBe(3);
});

test("buildBoard keeps two issues of the same repo as two cards in the same lane (the owner runs several at once)", () => {
  const mk = (n) => ({
    issue: { number: n, title: `t${n}`, labels: ["factory:in-progress"], createdAt: ago(100) },
    comments: [transitionComment("factory:planned", "factory:in-progress", ago(10 * n)), { id: n, body: heartbeatBodyFor(n, { last: ago(1), runner: `gha-${n}` }), createdAt: ago(1) }],
    recordText: null,
  });
  const model = buildBoard({ repos: [{ repo: "o/r", issues: [mk(1), mk(2)], runs: [] }], now: NOW });
  expect(model.lanes.find((l) => l.id === "in-progress").issues).toEqual(["o/r#1", "o/r#2"]);
  expect(model.issues.map((i) => i.heartbeat.runner)).toEqual(["gha-1", "gha-2"]);
});
