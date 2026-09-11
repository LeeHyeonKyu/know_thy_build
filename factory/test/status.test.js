import { test, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatus, renderStatus } from "../lib/status.js";
import { statusCommand } from "../cli/status.js";

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
    heartbeats: new Map([[3, minutesAgo(5)], [4, minutesAgo(35)]]),
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

test("inProgress marks a 35-minute-old heartbeat stale, a 5-minute-old one not", () => {
  const s = buildStatus(baseArgs());
  const byNumber = Object.fromEntries(s.inProgress.map((p) => [p.number, p]));
  expect(byNumber[3].stale).toBe(false);
  expect(byNumber[3].age_min).toBe(5);
  expect(byNumber[4].stale).toBe(true);
  expect(byNumber[4].age_min).toBe(35);
  expect(byNumber[3].state).toBe("factory:in-progress");
});

test("backPressure computes awaiting-review count and reads caps from charter/thresholds", () => {
  const s = buildStatus(baseArgs());
  expect(s.backPressure).toEqual({ awaiting_review: 2, max: 4, quarantined: 2, quarantine_max: 5 });
});

test("queue holds the waiting-state issues (not in-progress, not needs-you, not merged)", () => {
  const s = buildStatus(baseArgs());
  const numbers = s.queue.map((q) => q.number).sort((a, b) => a - b);
  expect(numbers).toEqual([5, 6, 7]);
  expect(s.queue.find((q) => q.number === 5)).toEqual({ number: 5, title: "waiting triage", state: "factory:queue" });
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

// ── statusCommand ────────────────────────────────────────────────

function io() {
  const o = { out: [], err: [] };
  return { io: { out: (s) => o.out.push(s), err: (s) => o.err.push(s) }, o };
}

/** mutating methods throw — a read-only command must never call them. */
function fakeGh() {
  const throwing = (name) => vi.fn(async () => { throw new Error(`mutator called: ${name}`); });
  return {
    issueList: vi.fn(async ({ labels }) => {
      const label = labels[0];
      return baseIssues().filter((i) => i.labels.includes(label));
    }),
    prList: vi.fn(async ({ label }) => {
      if (label === "factory:retro-proposal") return basePrs().retroProposal;
      if (label === "factory:harness") return basePrs().harness;
      return [];
    }),
    comments: vi.fn(async (n) => {
      if (n === 3) return [{ id: 1, body: `<!-- factory-heartbeat issue=3 -->\nstage: implement · runner: gha-1 · started: x · last: ${minutesAgo(5)}`, createdAt: NOW }];
      if (n === 4) return [{ id: 2, body: `<!-- factory-heartbeat issue=4 -->\nstage: implement · runner: gha-1 · started: x · last: ${minutesAgo(35)}`, createdAt: NOW }];
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

test("statusCommand --json exits 0, emits buildStatus JSON, and never calls a mutating gh method", async () => {
  const root = mkdtempSync(join(tmpdir(), "status-cli-"));
  const gh = fakeGh();
  const { io: i, o } = io();
  const readRecords = vi.fn(async () => new Map());
  const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "not a git repo" }));

  const code = await statusCommand({ root, argv: ["--json"], io: i, gh, run, now: () => NOW, readRecords });

  expect(code).toBe(0);
  expect(o.out).toHaveLength(1);
  const parsed = JSON.parse(o.out[0]);
  expect(parsed.needsYou.map((n) => n.kind)).toEqual(["needs-human", "needs-info", "retro-proposal", "harness"]);
  expect(parsed.backPressure.awaiting_review).toBe(2);
  expect(parsed.recent).toHaveLength(2);
  expect(parsed.usage).toBeTruthy();

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
