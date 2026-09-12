import { test, expect } from "vitest";
import { harvest, mergeCandidates } from "../lib/retro/harvest.js";
import { renderHandoff } from "../lib/handoff.js";
import { appendRunRecord } from "../lib/run-record.js";
import { usageLine } from "../bin/run-stage.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const reviewHandoff = (issue, { round = 1, verdicts, at }) =>
  ({ id: `c-review-${issue}-${round}`, createdAt: at, body: renderHandoff({
    stage: "review", issue,
    summary: `round ${round}`,
    data: { schema: "factory.review.v1", issue, pr: issue, head_sha: "a".repeat(40), round, verdicts, orchestration: "workflow", guarantee: "verified" },
  }) });

const planHandoff = (issue, { dissent_log = [], at }) =>
  ({ id: `c-plan-${issue}`, createdAt: at, body: renderHandoff({
    stage: "plan", issue,
    summary: "### Plan",
    data: { schema: "factory.plan.v1", issue, tier: "standard", roles: ["architect", "skeptic"], rounds: 3,
      done_when: [{ id: "dw1", text: "x", verify: "test_x", level: "unit" }],
      files_expected: [], dissent_log, non_goals: [], open_risks: [] },
  }) });

const transitionTo = ({ from, to, by = "script", reason, at }) =>
  ({ id: `t-${from}-${to}`, createdAt: at, body: `<!-- factory-transition:v1 from=${from} to=${to} by=${by} -->\n${from} → ${to}${reason ? ` — ${reason}` : ""}` });

const transitionRefusedToNeedsHuman = ({ from, to, reason, at }) =>
  ({ id: `refused-${from}-${to}`, createdAt: at, body: `<!-- factory-transition-refused from=${from} to=${to} -->\n**전이 거부** ${from} → ${to}: ${reason}\n\n라벨을 \`factory:needs-human\`으로 옮겼습니다. 산출물을 보강한 뒤 \`:unstick\`으로 재개하세요.` });

const transitionRefusedGraph = ({ from, to, at }) =>
  ({ id: `refused-graph-${from}-${to}`, createdAt: at, body: `<!-- factory-transition-refused from=${from} to=${to} -->\n**전이 거부** ${from} → ${to}: transition ${from} → ${to} not allowed` });

const rejectVerdict = (role, claim, id = "cf1") =>
  ({ role, verdict: "reject", confidence: "high", must_fix: [{ id, where: "a.ts:1", claim, evidence: "e" }], should_fix: [], verified: [] });

test("must_fix(reject) claims become lesson candidates; identical claim across different issues accumulates runs", () => {
  const commentsByIssue = new Map([
    [10, [reviewHandoff(10, { round: 1, at: "2026-09-01T00:00:00Z", verdicts: [rejectVerdict("correctness", "에러 처리 누락")] })]],
    [11, [reviewHandoff(11, { round: 1, at: "2026-09-02T00:00:00Z", verdicts: [rejectVerdict("correctness", "에러 처리 누락", "cf9")] })]],
  ]);
  const issues = [
    { number: 10, title: "sync incremental", labels: [], state: "open" },
    { number: 11, title: "csv export", labels: [], state: "open" },
  ];
  const { candidates } = harvest({ records: new Map(), issues, commentsByIssue, since: null });
  expect(candidates.lessons).toHaveLength(1);
  expect(candidates.lessons[0]).toEqual({ role: "correctness", text: "에러 처리 누락", runs: [10, 11], source: "must_fix" });
});

test("approve verdicts and non-reject must_fix are never harvested as lessons", () => {
  const approve = { role: "correctness", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: ["t1"] };
  const commentsByIssue = new Map([[20, [reviewHandoff(20, { at: "2026-09-01T00:00:00Z", verdicts: [approve] })]]]);
  const issues = [{ number: 20, title: "x", labels: [], state: "open" }];
  const { candidates } = harvest({ records: new Map(), issues, commentsByIssue, since: null });
  expect(candidates.lessons).toEqual([]);
});

test("unresolved/deferred dissent becomes an example candidate; resolved dissent does not", () => {
  const commentsByIssue = new Map([
    [30, [planHandoff(30, { at: "2026-09-01T00:00:00Z", dissent_log: [
      { role: "skeptic", objection: "타임스탬프 커서 기본 타임존 불확실", resolution: "unresolved — 다음 이슈로 이연" },
      { role: "architect", objection: "동기 내보내기는 타임아웃이 난다", resolution: "10k행 이하로 제한" }, // resolved — 제외
    ] })]],
  ]);
  const issues = [{ number: 30, title: "x", labels: [], state: "open" }];
  const { candidates } = harvest({ records: new Map(), issues, commentsByIssue, since: null });
  expect(candidates.examples).toEqual([
    { role: "skeptic", kind: "good", text: "타임스탬프 커서 기본 타임존 불확실", runs: [30], source: "dissent" },
  ]);
});

test("needs-human: explicit v1 transition to factory:needs-human carries reason after the em dash", () => {
  const commentsByIssue = new Map([
    [40, [transitionTo({ from: "factory:in-progress", to: "factory:needs-human", reason: "예산 초과", at: "2026-09-03T00:00:00Z" })]],
  ]);
  const issues = [{ number: 40, title: "x", labels: [], state: "open" }];
  const { candidates } = harvest({ records: new Map(), issues, commentsByIssue, since: null });
  expect(candidates.needs_human).toEqual([{ issue: 40, reason: "예산 초과", at: "2026-09-03T00:00:00Z" }]);
});

test("needs-human: requirement-refused transition that actually moves the label also counts; a plain graph-refusal does not", () => {
  const commentsByIssue = new Map([
    [41, [
      transitionRefusedToNeedsHuman({ from: "factory:approved", to: "factory:merged", reason: "handoff missing head_sha", at: "2026-09-03T01:00:00Z" }),
      transitionRefusedGraph({ from: "factory:merged", to: "factory:needs-human", at: "2026-09-03T02:00:00Z" }),
    ]],
  ]);
  const issues = [{ number: 41, title: "x", labels: [], state: "open" }];
  const { candidates } = harvest({ records: new Map(), issues, commentsByIssue, since: null });
  expect(candidates.needs_human).toEqual([{ issue: 41, reason: "handoff missing head_sha", at: "2026-09-03T01:00:00Z" }]);
});

test("factory:flaky labeled issues become flaky candidates, id parsed from the 'flaky: <id>' title", () => {
  const issues = [
    { number: 50, title: "flaky: test_123_incremental_sync", labels: ["factory:flaky", "factory:queue"], state: "open" },
    { number: 51, title: "unrelated", labels: [], state: "open" },
  ];
  const { candidates } = harvest({ records: new Map(), issues, commentsByIssue: new Map(), since: null });
  expect(candidates.flaky).toEqual([{ id: "test_123_incremental_sync", issue: 50 }]);
});

test("flaky: a TTL-rewrite issue ('rewrite flaky test at another level: <id>', Plan 4 Task 3) is parsed by the same id", () => {
  const issues = [
    { number: 52, title: "rewrite flaky test at another level: test_123_incremental_sync", labels: ["factory:flaky", "backlog"], state: "open" },
  ];
  const { candidates } = harvest({ records: new Map(), issues, commentsByIssue: new Map(), since: null });
  expect(candidates.flaky).toEqual([{ id: "test_123_incremental_sync", issue: 52 }]);
});

test("since filters must_fix/dissent/needs-human by comment createdAt — null means everything", () => {
  const commentsByIssue = new Map([
    [60, [
      reviewHandoff(60, { at: "2026-09-01T00:00:00Z", verdicts: [rejectVerdict("correctness", "old claim")] }),
      reviewHandoff(60, { round: 2, at: "2026-09-10T00:00:00Z", verdicts: [rejectVerdict("correctness", "new claim")] }),
    ]],
  ]);
  const issues = [{ number: 60, title: "x", labels: [], state: "open" }];

  const all = harvest({ records: new Map(), issues, commentsByIssue, since: null });
  expect(all.candidates.lessons.map((l) => l.text).sort()).toEqual(["new claim", "old claim"]);

  const delta = harvest({ records: new Map(), issues, commentsByIssue, since: "2026-09-05T00:00:00Z" });
  expect(delta.candidates.lessons.map((l) => l.text)).toEqual(["new claim"]);
});

test("stats: merged count (label or closed+transition-to-merged), review_rounds_avg from max round per merged issue, rejects_by_role, needs_human count", () => {
  const commentsByIssue = new Map([
    // #70: merged via label, review rounds 1 then 2 (reject in round1, approve in round2)
    [70, [
      reviewHandoff(70, { round: 1, at: "2026-09-01T00:00:00Z", verdicts: [rejectVerdict("correctness", "c1")] }),
      reviewHandoff(70, { round: 2, at: "2026-09-02T00:00:00Z", verdicts: [{ role: "correctness", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: ["t"] }] }),
    ]],
    // #71: merged via closed + transition comment, single round, one reject from a different role
    [71, [
      reviewHandoff(71, { round: 1, at: "2026-09-03T00:00:00Z", verdicts: [rejectVerdict("spec-conformance", "c2")] }),
      transitionTo({ from: "factory:approved", to: "factory:merged", at: "2026-09-04T00:00:00Z" }),
    ]],
    // #72: not merged — its reject must not count toward rejects_by_role
    [72, [reviewHandoff(72, { round: 1, at: "2026-09-01T00:00:00Z", verdicts: [rejectVerdict("correctness", "c3")] })]],
    // needs-human event, unrelated to merge
    [73, [transitionTo({ from: "factory:in-progress", to: "factory:needs-human", reason: "예산 초과", at: "2026-09-05T00:00:00Z" })]],
  ]);
  const issues = [
    { number: 70, title: "a", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-02T01:00:00Z" },
    { number: 71, title: "b", labels: [], state: "closed", closedAt: "2026-09-04T01:00:00Z" },
    { number: 72, title: "c", labels: [], state: "open" },
    { number: 73, title: "d", labels: [], state: "open" },
  ];
  const { stats } = harvest({ records: new Map(), issues, commentsByIssue, since: null });
  expect(stats.merged).toBe(2);
  expect(stats.review_rounds_avg).toBe(1.5); // (2 + 1) / 2
  expect(stats.rejects_by_role).toEqual({ correctness: 1, "spec-conformance": 1 }); // #72's reject excluded (not merged)
  expect(stats.needs_human).toBe(1);
});

test("stats: merged issues are filtered by closedAt > since", () => {
  const issues = [
    { number: 80, title: "a", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-01T00:00:00Z" },
    { number: 81, title: "b", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-10T00:00:00Z" },
  ];
  const { stats } = harvest({ records: new Map(), issues, commentsByIssue: new Map(), since: "2026-09-05T00:00:00Z" });
  expect(stats.merged).toBe(1);
});

test("stats.usage is window-scoped — only run-record entries after `since` count (F2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "retro-harvest-window-"));
  const line = (cost, input, output) => usageLine({ usage: { input_tokens: input, output_tokens: output }, total_cost_usd: cost, num_turns: 1, terminal_reason: "end_turn", modelUsage: { "claude-x": { costUSD: cost } } });
  // 같은 이슈의 두 스테이지: 하나는 창 밖(지난 retro가 이미 센 비용), 하나는 창 안
  appendRunRecord({ root: dir, issue: 91, stage: "plan", runnerId: "gha-1", now: "2026-09-01T00:00:00Z", lines: [line(0.5, 100, 20)] });
  appendRunRecord({ root: dir, issue: 91, stage: "review", runnerId: "gha-1", now: "2026-09-10T00:00:00Z", lines: [line(0.25, 8, 4)] });
  const records = new Map([[91, readFileSync(join(dir, "docs/factory/runs/91.md"), "utf8")]]);
  const issues = [{ number: 91, title: "x", labels: [], state: "open" }];

  const windowed = harvest({ records, issues, commentsByIssue: new Map(), since: "2026-09-05T00:00:00Z" }).stats;
  expect(windowed.usage.cost_usd).toBe(0.25);
  expect(windowed.usage.tokens).toEqual({ input: 8, output: 4 });

  // since=null은 "이력 전체" — 두 스테이지가 모두 들어온다(첫 retro의 창은 전체다)
  const all = harvest({ records, issues, commentsByIssue: new Map(), since: null }).stats;
  expect(all.usage.cost_usd).toBe(0.75);
  expect(all.usage.tokens).toEqual({ input: 108, output: 24 });
});

test("stats.usage sums the run records and skips the '_retro' key", () => {
  const dir = mkdtempSync(join(tmpdir(), "retro-harvest-"));
  appendRunRecord({ root: dir, issue: 90, stage: "review", runnerId: "gha-1", now: "2026-09-01T00:00:00Z",
    lines: [usageLine({ usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: 0.5, num_turns: 3, terminal_reason: "end_turn", modelUsage: { "claude-x": { costUSD: 0.5 } } })] });
  const text90 = readFileSync(join(dir, "docs/factory/runs/90.md"), "utf8");
  const records = new Map([[90, text90], ["_retro", "## retro · 2026-09-05T00:00Z · gha-9\nusage: {} cost_usd: 999 num_turns: 1 terminal_reason: end_turn models: n/a"]]);
  const issues = [{ number: 90, title: "x", labels: [], state: "open" }];
  const { stats } = harvest({ records, issues, commentsByIssue: new Map(), since: null });
  expect(stats.usage.cost_usd).toBe(0.5);
  expect(stats.usage.tokens).toEqual({ input: 100, output: 20 });
});

// O12: `input_tokens` alone understates real input for prompt-caching sessions — most of the
// context lands in `cache_creation_input_tokens`/`cache_read_input_tokens` instead.
test("stats.usage.tokens.input includes cache_creation + cache_read tokens, not just input_tokens (O12)", () => {
  const dir = mkdtempSync(join(tmpdir(), "retro-harvest-cache-"));
  appendRunRecord({
    root: dir, issue: 92, stage: "plan", runnerId: "gha-1", now: "2026-09-01T00:00:00Z",
    lines: [usageLine({
      usage: { input_tokens: 8, cache_creation_input_tokens: 43117, cache_read_input_tokens: 170334, output_tokens: 15770 },
      total_cost_usd: 11.95, num_turns: 4, terminal_reason: "completed", modelUsage: { "claude-x": { costUSD: 11.95 } },
    })],
  });
  const records = new Map([[92, readFileSync(join(dir, "docs/factory/runs/92.md"), "utf8")]]);
  const issues = [{ number: 92, title: "x", labels: [], state: "open" }];
  const { stats } = harvest({ records, issues, commentsByIssue: new Map(), since: null });
  expect(stats.usage.tokens).toEqual({ input: 8 + 43117 + 170334, output: 15770 });
});

test("mergeCandidates unions lessons/examples by (role,text) merging runs, flaky by id, needs_human by issue (fresh wins)", () => {
  const existing = {
    lessons: [{ role: "correctness", text: "c1", runs: [1], source: "must_fix" }],
    examples: [],
    flaky: [{ id: "t1", issue: 5 }],
    needs_human: [{ issue: 6, reason: "old reason", at: "2026-09-01T00:00:00Z" }],
  };
  const fresh = {
    lessons: [{ role: "correctness", text: "c1", runs: [2], source: "must_fix" }, { role: "correctness", text: "c2", runs: [3], source: "must_fix" }],
    examples: [],
    flaky: [{ id: "t1", issue: 5 }],
    needs_human: [{ issue: 6, reason: "new reason", at: "2026-09-10T00:00:00Z" }],
  };
  const merged = mergeCandidates(existing, fresh);
  expect(merged.lessons).toEqual([
    { role: "correctness", text: "c1", runs: [1, 2], source: "must_fix" },
    { role: "correctness", text: "c2", runs: [3], source: "must_fix" },
  ]);
  expect(merged.flaky).toEqual([{ id: "t1", issue: 5 }]);
  expect(merged.needs_human).toEqual([{ issue: 6, reason: "new reason", at: "2026-09-10T00:00:00Z" }]);
});

test("harvest defaults: missing collections behave like empty ones", () => {
  const { candidates, stats } = harvest({ issues: [], since: null });
  expect(candidates).toEqual({ lessons: [], examples: [], flaky: [], needs_human: [] });
  expect(stats.merged).toBe(0);
  expect(stats.review_rounds_avg).toBe(0);
  expect(stats.usage).toEqual({ cost_usd: 0, tokens: { input: 0, output: 0 } });
});
