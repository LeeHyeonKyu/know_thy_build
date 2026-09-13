import { test, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatus, renderStatus } from "../lib/status.js";
import { statusCommand } from "../cli/status.js";
import { THRESHOLD_DEFAULTS } from "../lib/config.js";

const NOW = "2026-09-15T12:00:00Z";
const minutesAgo = (n) => new Date(Date.parse(NOW) - n * 60000).toISOString();

function baseIssues() {
  return [
    { number: 1, title: "stuck thing", labels: ["factory:needs-human"], updatedAt: NOW, closedAt: null },
    { number: 2, title: "vague spec", labels: ["factory:needs-info"], updatedAt: NOW, closedAt: null },
    { number: 3, title: "fresh implement", labels: ["factory:in-progress"], updatedAt: NOW, closedAt: null },
    { number: 4, title: "stale implement", labels: ["factory:in-progress"], updatedAt: NOW, closedAt: null },
    { number: 5, title: "waiting triage", labels: ["factory:queue"], updatedAt: NOW, closedAt: null },
    { number: 6, title: "waiting review 1", labels: ["factory:awaiting-review"], updatedAt: NOW, closedAt: null },
    { number: 7, title: "waiting review 2", labels: ["factory:awaiting-review"], updatedAt: NOW, closedAt: null },
    { number: 8, title: "merged a", labels: ["factory:merged"], updatedAt: NOW, closedAt: "2026-09-14T00:00:00Z" },
    { number: 9, title: "merged b", labels: ["factory:merged"], updatedAt: NOW, closedAt: "2026-09-13T00:00:00Z" },
    { number: 10, title: "blocked thing", labels: ["factory:blocked"], updatedAt: NOW, closedAt: null },
    { number: 11, title: "rework thing", labels: ["factory:rework"], updatedAt: NOW, closedAt: null },
  ];
}

function basePrs() {
  return {
    retroProposal: [{ number: 101, title: "promote lint rule" }],
    harness: [{ number: 102, title: "M1 promotion" }],
  };
}

function baseArgs() {
  return {
    issues: baseIssues(),
    prs: basePrs(),
    heartbeats: new Map([
      [3, { last: minutesAgo(5), stage: "implement", runner: "gha-1" }],
      [4, { last: minutesAgo(35), stage: "implement", runner: "gha-1" }],
      [6, { last: minutesAgo(2), stage: "review", runner: "gha-2" }],
      // 7 (awaiting-review), 10 (blocked), 11 (rework) — no heartbeat on purpose.
    ]),
    quarantine: { quarantined: [{ id: "flaky-a" }, { id: "flaky-b" }] },
    thresholds: { quarantine_max: 5 },
    charter: { back_pressure: { awaiting_review_max: 4 } },
    usage: { perIssue: [], window: { since: "x", cost_usd: 0, runs: 0 }, total: { cost_usd: 0, runs: 0 } },
    now: NOW,
  };
}

test("needsYou carries needs-human, needs-info, retro-proposal PR, harness PR with the right hints, in that order", () => {
  const s = buildStatus(baseArgs());
  expect(s.needsYou).toEqual([
    { kind: "needs-human", number: 1, title: "stuck thing", hint: ":unstick 1" },
    { kind: "needs-info", number: 2, title: "vague spec", hint: ":clarify 2" },
    { kind: "retro-proposal", number: 101, title: "promote lint rule", hint: ":proposal 101" },
    { kind: "harness", number: 102, title: "M1 promotion", hint: ":harness 102" },
  ]);
});

// ── ADR-020 KTB-30 — 상태 라벨이 0개인 이슈는 Needs You에 뜬다 ─────────────────────────────────
// 그 이슈는 어떤 상태 조회에도 걸리지 않으므로, 화면에서도 **없는 것처럼** 보였다. sweeper가 대개
// 먼저 고치지만(같은 KTB-30), 고치기 전/고치지 못한 순간에 사람이 볼 창구가 있어야 한다.
test("an open factory issue with no state label lands in Needs You as [no-state-label]", () => {
  const args = baseArgs();
  args.issues = [...args.issues, { number: 20, title: "label swap died", labels: ["factory:tier-standard"], updatedAt: NOW, closedAt: null }];
  const s = buildStatus(args);
  expect(s.needsYou).toContainEqual({ kind: "no-state-label", number: 20, title: "label swap died", hint: "sweeper → label restore" });
  expect(s.inProgress.some((p) => p.number === 20)).toBe(false);
  expect(s.queue.some((q) => q.number === 20)).toBe(false);
  expect(renderStatus(s)).toContain("- [no-state-label] #20 label swap died — sweeper → label restore");
});

test("an issue with no factory label at all is not reported as no-state-label", () => {
  const args = baseArgs();
  args.issues = [...args.issues, { number: 21, title: "plain bug", labels: ["bug"], updatedAt: NOW, closedAt: null }];
  expect(buildStatus(args).needsYou.some((n) => n.number === 21)).toBe(false);
});

test("inProgress marks a 35-minute-old heartbeat stale, a 5-minute-old one not", () => {
  const s = buildStatus(baseArgs());
  const byNumber = Object.fromEntries(s.inProgress.map((p) => [p.number, p]));
  expect(byNumber[3].stale).toBe(false);
  expect(byNumber[3].age_min).toBe(5);
  expect(byNumber[4].stale).toBe(true);
  expect(byNumber[4].age_min).toBe(35);
  expect(byNumber[3].state).toBe("factory:in-progress");
});

test("stale boundary is inclusive: exactly staleMinutes (default 30) counts as stale", () => {
  const args = baseArgs();
  args.heartbeats.set(3, { last: minutesAgo(30), stage: "implement", runner: "gha-1" });
  const s = buildStatus(args);
  const three = s.inProgress.find((p) => p.number === 3);
  expect(three.age_min).toBe(30);
  expect(three.stale).toBe(true);
});

test("blocked issues show in 진행 중 (not Needs You) with a sweeper hint; stage null without a heartbeat", () => {
  const s = buildStatus(baseArgs());
  expect(s.needsYou.some((n) => n.number === 10)).toBe(false);
  const blocked = s.inProgress.find((p) => p.number === 10);
  expect(blocked).toBeTruthy();
  expect(blocked.state).toBe("factory:blocked");
  expect(blocked.hint).toBe("sweeper → needs-human");
  expect(blocked.stage).toBeNull();
});

test("inProgress[].stage comes from the heartbeat body's stage: field when present", () => {
  const s = buildStatus(baseArgs());
  const six = s.inProgress.find((p) => p.number === 6);
  expect(six.state).toBe("factory:awaiting-review");
  expect(six.stage).toBe("review");
});

test("inProgress[].stage falls back to a label-derived guess when there's no heartbeat: awaiting-review → review, rework → implement", () => {
  const s = buildStatus(baseArgs());
  const seven = s.inProgress.find((p) => p.number === 7);
  expect(seven.stage).toBe("review");
  const eleven = s.inProgress.find((p) => p.number === 11);
  expect(eleven.stage).toBe("implement");
});

test("backPressure computes awaiting-review count and reads caps from charter/thresholds", () => {
  const s = buildStatus(baseArgs());
  expect(s.backPressure).toEqual({ awaiting_review: 2, max: 4, quarantined: 2, quarantine_max: 5 });
});

test("queue only holds genuinely-waiting states — awaiting-review/rework/blocked/in-progress live in 진행 중 instead", () => {
  const s = buildStatus(baseArgs());
  const numbers = s.queue.map((q) => q.number).sort((a, b) => a - b);
  expect(numbers).toEqual([5]);
  expect(s.queue[0]).toEqual({ number: 5, title: "waiting triage", state: "factory:queue" });
});

test("recent = last 10 factory:merged issues by closedAt desc", () => {
  const s = buildStatus(baseArgs());
  expect(s.recent).toEqual([
    { number: 8, title: "merged a", mergedAt: "2026-09-14T00:00:00Z" },
    { number: 9, title: "merged b", mergedAt: "2026-09-13T00:00:00Z" },
  ]);
});

test("usage passes through untouched", () => {
  const args = baseArgs();
  const s = buildStatus(args);
  expect(s.usage).toBe(args.usage);
});

test("renderStatus keeps section order: Needs You → 진행 중 → 큐 → 역압 → 최근 머지 → 사용량", () => {
  const s = buildStatus(baseArgs());
  const text = renderStatus(s);
  const order = ["Needs You", "진행 중", "큐", "역압", "최근 머지", "사용량"];
  const positions = order.map((h) => text.indexOf(h));
  expect(positions.every((p) => p !== -1)).toBe(true);
  for (let i = 1; i < positions.length; i++) expect(positions[i]).toBeGreaterThan(positions[i - 1]);
});

test("renderStatus's 사용량 section lists top per-issue usage (by cost) before window/total", () => {
  const args = baseArgs();
  args.usage = {
    perIssue: [
      { issue: "3", cost_usd: 5, runs: 2, tokens: { input: 100, output: 20 } },
      { issue: "6", cost_usd: 1.5, runs: 1, tokens: { input: 10, output: 2 } },
    ],
    window: { since: "2026-09-08T12:00:00.000Z", cost_usd: 6.5, runs: 3 },
    total: { cost_usd: 6.5, runs: 3 },
  };
  const s = buildStatus(args);
  const text = renderStatus(s);
  const section = text.slice(text.indexOf("## 사용량"));
  expect(section).toContain("#3 $5 · 2 runs · 100 input(+cache) / 20 output tokens");
  expect(section).toContain("#6 $1.5 · 1 runs · 10 input(+cache) / 2 output tokens");
  expect(section.indexOf("#3")).toBeLessThan(section.indexOf("window (since"));
  expect(section).toContain("window (since 2026-09-08T12:00:00.000Z): $6.5 / 3 runs");
  expect(section).toContain("total: $6.5 / 3 runs");
});

test("empty repo: every section renders a (none) placeholder", () => {
  const s = buildStatus({
    issues: [], prs: {}, heartbeats: new Map(),
    quarantine: { quarantined: [] }, thresholds: { quarantine_max: 5 },
    charter: { back_pressure: { awaiting_review_max: 4 } },
    usage: { perIssue: [], window: { since: "2026-09-08T00:00:00.000Z", cost_usd: 0, runs: 0 }, total: { cost_usd: 0, runs: 0 } },
    now: NOW,
  });
  expect(s.needsYou).toEqual([]);
  expect(s.inProgress).toEqual([]);
  expect(s.queue).toEqual([]);
  expect(s.recent).toEqual([]);
  const text = renderStatus(s);
  // one "(none)" per empty list section (Needs You, 진행 중, 큐, 최근 머지) + one for empty perIssue.
  expect(text.match(/\(none\)/g)).toHaveLength(5);
});

// ── statusCommand ────────────────────────────────────────────────

function io() {
  const o = { out: [], err: [] };
  return { io: { out: (s) => o.out.push(s), err: (s) => o.err.push(s) }, o };
}

/** mutating methods throw — a read-only command must never call them. */
function fakeGh() {
  const throwing = (name) => vi.fn(async () => { throw new Error(`mutator called: ${name}`); });
  return {
    // KTB-30: 라벨 없는 조회(`{state:"open"}`)는 열린 이슈 전체다 — 상태 라벨이 0개인 이슈를 찾는
    // 유일한 길이다(라벨로는 조회할 수 없다).
    issueList: vi.fn(async ({ labels, state }) => {
      const open = [...baseIssues(), { number: 20, title: "label swap died", labels: ["factory:tier-standard"], updatedAt: NOW, closedAt: null }, { number: 21, title: "plain bug", labels: ["bug"], updatedAt: NOW, closedAt: null }]
        .filter((i) => (state === "closed" ? i.labels.includes("factory:merged") : !i.labels.includes("factory:merged")));
      if (!labels) return open;
      return baseIssues().filter((i) => i.labels.includes(labels[0]));
    }),
    prList: vi.fn(async ({ label }) => {
      if (label === "factory:retro-proposal") return basePrs().retroProposal;
      if (label === "factory:harness") return basePrs().harness;
      return [];
    }),
    comments: vi.fn(async (n) => {
      if (n === 3) return [{ id: 1, body: `<!-- factory-heartbeat issue=3 -->\nstage: implement · runner: gha-1 · started: x · last: ${minutesAgo(5)}`, createdAt: NOW }];
      if (n === 4) return [{ id: 2, body: `<!-- factory-heartbeat issue=4 -->\nstage: implement · runner: gha-1 · started: x · last: ${minutesAgo(35)}`, createdAt: NOW }];
      if (n === 6) return [{ id: 3, body: `<!-- factory-heartbeat issue=6 -->\nstage: review · runner: gha-2 · started: x · last: ${minutesAgo(2)}`, createdAt: NOW }];
      return [];
    }),
    comment: throwing("comment"),
    patchComment: throwing("patchComment"),
    addLabels: throwing("addLabels"),
    removeLabel: throwing("removeLabel"),
    setFactoryLabel: throwing("setFactoryLabel"),
    createDraftPr: throwing("createDraftPr"),
    createIssue: throwing("createIssue"),
    closeIssue: throwing("closeIssue"),
    mergePr: throwing("mergePr"),
    setStatus: throwing("setStatus"),
    createLabel: throwing("createLabel"),
    putBranchProtection: throwing("putBranchProtection"),
    setVariable: throwing("setVariable"),
  };
}

test("statusCommand --json exits 0, emits buildStatus JSON (incl. blocked issues in inProgress), and never calls a mutating gh method", async () => {
  const root = mkdtempSync(join(tmpdir(), "status-cli-"));
  const gh = fakeGh();
  const { io: i, o } = io();
  const readRecords = vi.fn(async () => new Map());
  const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "not a git repo" }));

  const code = await statusCommand({ root, argv: ["--json"], io: i, gh, run, now: () => NOW, readRecords });

  expect(code).toBe(0);
  expect(o.out).toHaveLength(1);
  const parsed = JSON.parse(o.out[0]);
  expect(parsed.needsYou.map((n) => n.kind)).toEqual(["needs-human", "needs-info", "no-state-label", "retro-proposal", "harness"]);
  expect(parsed.backPressure.awaiting_review).toBe(2);
  expect(parsed.recent).toHaveLength(2);
  expect(parsed.usage).toBeTruthy();
  const blocked = parsed.inProgress.find((p) => p.number === 10);
  expect(blocked.state).toBe("factory:blocked");
  expect(blocked.hint).toBe("sweeper → needs-human");
  const six = parsed.inProgress.find((p) => p.number === 6);
  expect(six.stage).toBe("review");
  // KTB-30: 상태 라벨이 0개인 #20은 어떤 라벨 조회에도 안 걸린다 — 열린 이슈 전체 조회가 그것을 줍는다
  expect(parsed.needsYou).toContainEqual({ kind: "no-state-label", number: 20, title: "label swap died", hint: "sweeper → label restore" });
  expect(parsed.needsYou.some((n) => n.number === 21)).toBe(false);

  for (const mutator of ["comment", "patchComment", "addLabels", "removeLabel", "setFactoryLabel", "createDraftPr", "createIssue", "closeIssue", "mergePr", "setStatus", "createLabel", "putBranchProtection", "setVariable"]) {
    expect(gh[mutator]).not.toHaveBeenCalled();
  }
});

test("statusCommand falls back to local docs/factory/runs when readRecords returns empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "status-cli-local-"));
  mkdirSync(join(root, "docs/factory/runs"), { recursive: true });
  writeFileSync(join(root, "docs/factory/runs/3.md"), "# Run · #3\n\n## implement · 2026-09-15T00:00Z · gha-1\nusage: {\"input_tokens\":5,\"output_tokens\":1} cost_usd: 0.5 num_turns: 1 terminal_reason: end_turn models: m=$0.5\n");
  const gh = fakeGh();
  const { io: i, o } = io();
  const readRecords = vi.fn(async () => new Map());

  const code = await statusCommand({ root, argv: ["--json"], io: i, gh, run: vi.fn(), now: () => NOW, readRecords });
  expect(code).toBe(0);
  const parsed = JSON.parse(o.out[0]);
  expect(parsed.usage.total.runs).toBe(1);
  expect(parsed.usage.total.cost_usd).toBeCloseTo(0.5);
});

test("statusCommand renders text (non-json) with section headers by default", async () => {
  const root = mkdtempSync(join(tmpdir(), "status-cli-text-"));
  const gh = fakeGh();
  const { io: i, o } = io();
  const readRecords = vi.fn(async () => new Map());
  const code = await statusCommand({ root, argv: [], io: i, gh, run: vi.fn(), now: () => NOW, readRecords });
  expect(code).toBe(0);
  expect(o.out[0]).toContain("Needs You");
  expect(o.out[0]).toContain("사용량");
});

test("statusCommand on an empty repo: no issues/PRs anywhere still exits 0 and renders (none) placeholders", async () => {
  const root = mkdtempSync(join(tmpdir(), "status-cli-empty-"));
  const gh = { issueList: vi.fn(async () => []), prList: vi.fn(async () => []), comments: vi.fn(async () => []) };
  const { io: i, o } = io();
  const readRecords = vi.fn(async () => new Map());
  const code = await statusCommand({ root, argv: [], io: i, gh, run: vi.fn(), now: () => NOW, readRecords });
  expect(code).toBe(0);
  expect(o.out[0]).toContain("(none)");
});

test("statusCommand falls back to canonical caps (awaiting_review_max: 4, quarantine_max from THRESHOLD_DEFAULTS) when CHARTER.md/harness.toml are unreadable", async () => {
  const root = mkdtempSync(join(tmpdir(), "status-cli-nocharter-"));
  const gh = { issueList: vi.fn(async () => []), prList: vi.fn(async () => []), comments: vi.fn(async () => []) };
  const { io: i, o } = io();
  const readRecords = vi.fn(async () => new Map());
  const code = await statusCommand({ root, argv: ["--json"], io: i, gh, run: vi.fn(), now: () => NOW, readRecords });
  expect(code).toBe(0);
  const parsed = JSON.parse(o.out[0]);
  expect(parsed.backPressure.max).toBe(4);
  expect(parsed.backPressure.quarantine_max).toBe(THRESHOLD_DEFAULTS.quarantine_max);
});
