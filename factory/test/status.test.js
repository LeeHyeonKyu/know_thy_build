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

/**
 * r2 SF6 — sweeper 8번 팔은 라벨이 **하나도** 없어도 전이 이력이 있으면 그 이슈를 잡는다(상태 라벨이
 * 유일한 factory 라벨이었던 경우 — triage가 tier를 붙이기 전, 데모 #2의 모양). 사람이 보는 창구가 그
 * 팔보다 좁으면, 팔이 고치지 못한 바로 그 이슈가 화면에서도 사라진다.
 */
test("SF6: an issue with NO factory label but a transition history is reported too", () => {
  const args = baseArgs();
  args.issues = [...args.issues, { number: 22, title: "lost its only factory label", labels: ["bug"], updatedAt: NOW, closedAt: null, factoryTransition: true }];
  expect(buildStatus(args).needsYou).toContainEqual({ kind: "no-state-label", number: 22, title: "lost its only factory label", hint: "sweeper → label restore" });
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

/**
 * ADR-022 Task B — `status`는 **한 시점의 텍스트**다. "지금 무엇이 돌고 있는가"를 계속 보려면 보드가
 * 있어야 하고, 그 사실을 알 수 있는 자리는 사람이 이미 보고 있는 이 화면의 마지막 줄뿐이다.
 */
test("renderStatus ends with the board hint — the one line that says a live viewer exists", () => {
  const text = renderStatus(buildStatus(baseArgs()));
  expect(text).toContain("board: npx know-thy-build factory board");
  expect(text.trimEnd().split("\n").pop()).toContain("board:");
});

/**
 * 외부 감사 2026-09-14 P2-13 — 리뷰어 겹침 한 줄. 사람이 "리뷰어를 다섯 계속 띄울까"를 판단할 유일한
 * 숫자이고, 분모가 0인 창에서는 비율을 만들지 않는다.
 */
test("renderStatus prints the last-30-day reviewer overlap line under 최근 머지", () => {
  const s = buildStatus({ ...baseArgs(), overlap: { review_runs: 4, findings_total: 6, overlapping_findings: 1, unique_findings_by_role: { correctness: 2, qa: 1 }, overlap_ratio: 0.17 } });
  const text = renderStatus(s);
  expect(text).toContain("- review overlap (30d): 0.17 (1/6 findings raised by ≥2 roles, 4 review run(s)) · unique: correctness 2, qa 1");
  expect(text.indexOf("review overlap")).toBeGreaterThan(text.indexOf("## 최근 머지"));
  expect(text.indexOf("review overlap")).toBeLessThan(text.indexOf("## 사용량"));
});

test("renderStatus overlap line: no findings and no data are different sentences", () => {
  expect(renderStatus(buildStatus({ ...baseArgs(), overlap: { review_runs: 2, findings_total: 0, overlapping_findings: 0, unique_findings_by_role: {}, overlap_ratio: 0 } })))
    .toContain("- review overlap (30d): no findings in 2 review run(s)");
  expect(renderStatus(buildStatus(baseArgs()))).toContain("- review overlap (30d): (no data)");
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
      const open = [...baseIssues(), { number: 20, title: "label swap died", labels: ["factory:tier-standard"], updatedAt: NOW, closedAt: null }, { number: 21, title: "plain bug", labels: ["bug"], updatedAt: NOW, closedAt: null }, { number: 22, title: "lost its only factory label", labels: ["bug"], updatedAt: NOW, closedAt: null }, { number: 23, title: "old plain bug", labels: ["bug"], updatedAt: "2026-09-01T00:00:00Z", closedAt: null }]
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
      // r2 SF6: #22는 factory 라벨이 하나도 없지만 전이 이력이 있다 — 8번 팔이 보는 그 집합이다
      if (n === 22) return [{ id: 4, body: "<!-- factory-transition:v1 from=factory:queue to=factory:ready by=script -->\nfactory:queue → factory:ready", createdAt: NOW }];
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
  expect(parsed.needsYou.map((n) => n.kind)).toEqual(["needs-human", "needs-info", "no-state-label", "no-state-label", "retro-proposal", "harness"]);
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
  // r2 SF6: 라벨이 하나도 없어도 전이 이력이 있으면 sweeper 8번 팔과 같은 집합에 든다(#22).
  // 24시간 창 밖의 평범한 이슈(#23)에는 코멘트 조회조차 나가지 않는다.
  expect(parsed.needsYou).toContainEqual({ kind: "no-state-label", number: 22, title: "lost its only factory label", hint: "sweeper → label restore" });
  expect(gh.comments).not.toHaveBeenCalledWith(23);

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

// ── #3 — `docs/factory/runs/` holds state files as well as issue records ───────────────────────
// `_retro.md`(lib/retro/state.js renderRetroState)는 records 브랜치의 **상태 파일**이지 이슈 기록이
// 아니다(ADR-020 O5). readRecords(lib/records-branch.js:286)도 localRecords(cli/status.js:24-33)도
// 디렉터리의 모든 `*.md`를 그대로 키로 만들므로, 사용량 표는 그것을 `#_retro`라는 없는 이슈 번호로
// 보고했다. 규칙은 이름(`_retro`)이 아니라 모양(`/^\d+$/`)이어야 하므로 아래 픽스처는 전부
// **두 번째 비숫자 키**를 함께 싣는다 — 이름 특수 케이스 구현이 반드시 빨간불이 되도록.

/** 숫자 이슈 기록 하나 — 스테이지 헤더 1개, cost 0.5. */
const REC_8 = [
  "# Run · #8",
  "",
  "## implement · 2026-09-15T00:00Z · gha-1",
  'usage: {"input_tokens":5,"output_tokens":1} cost_usd: 0.5 num_turns: 1 terminal_reason: end_turn models: m=$0.5',
  "",
].join("\n");

/** 오늘의 `_retro.md` 모양(renderRetroState) — usage.js HEADER_RE에 걸리는 섹션이 없다. */
const REC_RETRO = ["# Retro State", "", "## History (last 5)", "- 2026-09-08 · window 1", "", "## Stats", "- runs: 3", ""].join("\n");

/** 두 번째 비숫자 키 — `=== "_retro"` denylist 구현을 죽인다. */
const REC_NOTES = ["# scratch", "", "someone left a note under docs/factory/runs/", ""].join("\n");

test("test_3_branch_records_skip_non_numeric: branch-path records whose key is not an issue number never become usage rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "status-cli-3-branch-"));
  const gh = fakeGh();
  const { io: i, o } = io();
  // 이슈가 적은 실제 repro: factory/records 브랜치에 _retro.md가 있는 저장소 → readRecords가
  // non-empty Map을 돌려주므로 localRecords fallback은 아예 실행되지 않는다.
  const readRecords = vi.fn(async () => new Map([["8", REC_8], ["_retro", REC_RETRO], ["notes", REC_NOTES]]));

  const code = await statusCommand({ root, argv: ["--json"], io: i, gh, run: vi.fn(), now: () => NOW, readRecords });

  expect(code).toBe(0);
  expect(readRecords).toHaveBeenCalled();
  const parsed = JSON.parse(o.out[0]);
  expect(parsed.usage.perIssue).toHaveLength(1);
  expect(parsed.usage.perIssue[0].issue).toBe("8");
  expect(parsed.usage.perIssue[0].runs).toBe(1);
  expect(o.out.join("\n")).not.toContain("_retro");
  expect(o.out.join("\n")).not.toContain("notes");
});

test("test_3_non_numeric_excluded_from_totals: a non-numeric record carrying a real stage header is excluded from window/total, not just from the row list", async () => {
  const root = mkdtempSync(join(tmpdir(), "status-cli-3-totals-"));
  const gh = fakeGh();
  const { io: i, o } = io();
  // 적대적 픽스처: 비숫자 기록이 usage.js HEADER_RE가 **실제로 인정하는** 헤더(`## retro · …`)와
  // cost 9짜리 usage 줄을 싣는다. 행만 거르고 합계에 남기는 구현은 여기서 죽는다.
  const hostile = [
    "# Retro State",
    "",
    "## retro · 2026-09-15T00:00Z · gha-1",
    'usage: {"input_tokens":100,"output_tokens":20} cost_usd: 9 num_turns: 4 terminal_reason: end_turn models: m=$9',
    "",
  ].join("\n");
  const readRecords = vi.fn(async () => new Map([["8", REC_8], ["_retro", hostile], ["notes", hostile]]));

  const code = await statusCommand({ root, argv: ["--json"], io: i, gh, run: vi.fn(), now: () => NOW, readRecords });

  expect(code).toBe(0);
  const parsed = JSON.parse(o.out[0]);
  expect(parsed.usage.perIssue.map((p) => p.issue)).toEqual(["8"]);
  expect(parsed.usage.total.cost_usd).toBe(0.5);
  expect(parsed.usage.total.runs).toBe(1);
  expect(parsed.usage.window.runs).toBe(1);
  expect(parsed.usage.window.cost_usd).toBe(0.5);
});

test("test_3_local_fallback_matches_branch_path: the local docs/factory/runs fallback reaches the same usage object as the branch path", async () => {
  const gh1 = fakeGh();
  const { io: i1, o: o1 } = io();
  const branchRoot = mkdtempSync(join(tmpdir(), "status-cli-3-eq-branch-"));
  await statusCommand({
    root: branchRoot, argv: ["--json"], io: i1, gh: gh1, run: vi.fn(), now: () => NOW,
    readRecords: vi.fn(async () => new Map([["8", REC_8], ["_retro", REC_RETRO], ["notes", REC_NOTES]])),
  });

  const localRoot = mkdtempSync(join(tmpdir(), "status-cli-3-eq-local-"));
  mkdirSync(join(localRoot, "docs/factory/runs"), { recursive: true });
  writeFileSync(join(localRoot, "docs/factory/runs/8.md"), REC_8);
  writeFileSync(join(localRoot, "docs/factory/runs/_retro.md"), REC_RETRO);
  writeFileSync(join(localRoot, "docs/factory/runs/notes.md"), REC_NOTES);
  const gh2 = fakeGh();
  const { io: i2, o: o2 } = io();
  const code = await statusCommand({
    root: localRoot, argv: ["--json"], io: i2, gh: gh2, run: vi.fn(), now: () => NOW,
    readRecords: vi.fn(async () => new Map()),
  });

  expect(code).toBe(0);
  // 같은 리터럴을 두 번 단언하는 대신 두 출처의 결과를 서로 비교한다 — 수정이 한쪽 경로에만
  // 떨어지면(cli/status.js:24-33 vs :109-113) 이 단언이 깨진다.
  expect(JSON.parse(o2.out[0]).usage).toEqual(JSON.parse(o1.out[0]).usage);
  expect(JSON.parse(o2.out[0]).usage.perIssue.map((p) => p.issue)).toEqual(["8"]);
});

test("test_3_rendered_usage_rows_all_numeric_and_silent: every rendered 사용량 row is a numeric issue and skipped records produce no warning line", async () => {
  const root = mkdtempSync(join(tmpdir(), "status-cli-3-render-"));
  const gh = fakeGh();
  const { io: i, o } = io();
  const readRecords = vi.fn(async () => new Map([["8", REC_8], ["_retro", REC_RETRO], ["notes", REC_NOTES]]));

  const code = await statusCommand({ root, argv: [], io: i, gh, run: vi.fn(), now: () => NOW, readRecords });

  expect(code).toBe(0);
  const text = o.out.join("\n");
  const section = text.slice(text.indexOf("## 사용량"));
  const rows = [...section.matchAll(/^- #(\S+) /gm)].map((m) => m[1]);
  expect(rows).toHaveLength(1);
  for (const r of rows) expect(r).toMatch(/^\d+$/);
  // "skipped silently" — 건너뛴 기록에 대한 새 줄은 stdout에도 stderr에도 없다.
  expect(o.err).toEqual([]);
  expect(text).not.toMatch(/_retro|notes|skip/i);
});

test("test_3_status_usage_none_when_only_retro: a branch holding only _retro still reports (none) instead of falling through to local records", async () => {
  const root = mkdtempSync(join(tmpdir(), "status-cli-3-onlyretro-"));
  // gitignore된 로컬 상태(.gitignore: docs/factory/runs/)가 남아 있는 흔한 저장소 모양 — 필터를
  // `records.size === 0` 판정 **앞**에 두면 여기로 조용히 떨어진다.
  mkdirSync(join(root, "docs/factory/runs"), { recursive: true });
  writeFileSync(join(root, "docs/factory/runs/99.md"), REC_8.replace("#8", "#99"));
  const readRecords = () => vi.fn(async () => new Map([["_retro", REC_RETRO]]));

  const { io: iJson, o: oJson } = io();
  const jsonCode = await statusCommand({ root, argv: ["--json"], io: iJson, gh: fakeGh(), run: vi.fn(), now: () => NOW, readRecords: readRecords() });
  expect(jsonCode).toBe(0);
  expect(JSON.parse(oJson.out[0]).usage.perIssue).toEqual([]);

  const { io: iText, o: oText } = io();
  const textCode = await statusCommand({ root, argv: [], io: iText, gh: fakeGh(), run: vi.fn(), now: () => NOW, readRecords: readRecords() });
  expect(textCode).toBe(0);
  const section = oText.out.join("\n").slice(oText.out.join("\n").indexOf("## 사용량"));
  expect(section).toContain("(none)");
  expect(section).toContain(": $0 / 0 runs");
  expect(section).toContain("- total: $0 / 0 runs");
  expect(oText.err).toEqual([]);
});
