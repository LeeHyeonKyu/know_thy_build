import { test, expect } from "vitest";
import { harvest, mergeCandidates, overlapFrom } from "../lib/retro/harvest.js";
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

// ── 외부 감사 2026-09-14 M11: `lesson:<id>` 인용을 역할별로 센다 ─────────────────────────

test("citations: a verdict citing lesson:<id> counts for that reviewer; an implement handoff counts for the builder", () => {
  const implementHandoff = (issue, at, summary) => ({ id: `c-impl-${issue}`, createdAt: at, body: renderHandoff({
    stage: "implement", issue, summary,
    data: { schema: "factory.implement.v1", issue, pr: issue, head_sha: "b".repeat(40), branch: `claude/fq-${issue}`, gates: { status: "GREEN", level: "full" }, orchestration: "workflow", tests_added: ["t"], notes: "used lesson:L-2026-09-01-02" },
  }) });
  const cite = (role, claim) => ({ role, verdict: "reject", confidence: "high", must_fix: [{ id: "cf1", where: "a.ts:1", claim, evidence: "e" }], should_fix: [], verified: [] });
  const commentsByIssue = new Map([
    [10, [
      reviewHandoff(10, { round: 1, at: "2026-09-02T00:00:00Z", verdicts: [
        cite("correctness", "lesson:L-2026-09-01-01 타임존 기본값을 확인하지 않았다"),
        cite("qa", "경계값 누락"),                                     // 인용 없음 — 세지 않는다
      ] }),
      implementHandoff(10, "2026-09-02T01:00:00Z", "구현 완료"),
    ]],
    [11, [reviewHandoff(11, { round: 1, at: "2026-09-03T00:00:00Z", verdicts: [cite("correctness", "또 lesson:L-2026-09-01-01")] })]],
  ]);
  const issues = [{ number: 10, title: "a", labels: [], state: "open" }, { number: 11, title: "b", labels: [], state: "open" }];
  const { citations } = harvest({ records: new Map(), issues, commentsByIssue, since: null });
  expect(citations).toEqual({
    correctness: { "L-2026-09-01-01": 2 },
    builder: { "L-2026-09-01-02": 1 },
  });
});

test("citations: handoffs older than the cursor are not counted again", () => {
  const cite = (role) => ({ role, verdict: "reject", confidence: "high", must_fix: [{ id: "cf1", where: "a:1", claim: "lesson:L-2026-09-01-01 again", evidence: "e" }], should_fix: [], verified: [] });
  const commentsByIssue = new Map([[10, [reviewHandoff(10, { at: "2026-09-01T00:00:00Z", verdicts: [cite("correctness")] })]]]);
  const issues = [{ number: 10, title: "a", labels: [], state: "open" }];
  expect(harvest({ records: new Map(), issues, commentsByIssue, since: "2026-09-05T00:00:00Z" }).citations).toEqual({});
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
  expect(stats.overlap_ratio).toBe(0);
  expect(stats.unique_findings_by_role).toEqual({});
});

// ── 감사 P2-13: R2의 `on_others`를 드디어 소비한다 ──────────────────────────────────────────────

const finding = (id) => ({ id, where: "a.ts:1", claim: `${id} claim`, evidence: `${id} evidence` });
const V = (role, ids, onOthers = []) => ({
  role,
  verdict: ids.length ? "reject" : "approve",
  confidence: "high",
  must_fix: ids.map(finding),
  should_fix: [],
  verified: [],
  on_others: onOthers,
});

/**
 * 네 벌의 verdict set — 겹침이 다 다르다.
 *   run 1: cf1을 security·architecture가 agree → 3역할이 제기(겹침). qa1은 qa 혼자.
 *   run 2: 전원 approve, 아무 finding 없음 → 이 런은 분모에 아무것도 더하지 않는다.
 *   run 3: 각자 자기 것만 — 겹침 0, 고유 2.
 *   run 4: disagree는 "제기"가 아니다. 아무도 적지 않은 id(zz9)에 대한 agree도 세지 않는다.
 */
const VERDICT_SETS = [
  [
    V("correctness", ["cf1"]),
    V("security", [], [{ id: "cf1", stance: "agree", reason: "같은 줄에서 확인" }]),
    V("architecture", [], [{ id: "cf1", stance: "agree", reason: "경계가 깨진다" }]),
    V("qa", ["qa1"], [{ id: "cf1", stance: "disagree", reason: "재현되지 않는다" }]),
  ],
  [V("correctness", []), V("security", []), V("qa", [])],
  [V("correctness", ["cf2"]), V("security", ["sec1"])],
  [
    V("correctness", ["cf3"], [{ id: "zz9", stance: "agree", reason: "없는 id" }]),
    V("security", ["sec2"], [{ id: "cf3", stance: "disagree", reason: "동의하지 않는다" }]),
  ],
];

test("overlapFrom: a finding raised by ≥2 roles is overlap; agree promotes, disagree does not, and an unowned id is ignored", () => {
  const o = overlapFrom(VERDICT_SETS);
  // findings: cf1, qa1 (run1) · cf2, sec1 (run3) · cf3, sec2 (run4) = 6. 전원 approve인 run2는 런으로도 세지 않는다.
  expect(o.review_runs).toBe(4);
  expect(o.findings_total).toBe(6);
  expect(o.overlapping_findings).toBe(1);              // cf1만 correctness + security + architecture
  expect(o.overlap_ratio).toBe(0.17);
  expect(o.unique_findings_by_role).toEqual({ qa: 1, correctness: 2, security: 2 });
});

test("overlapFrom: no findings at all is ratio 0, not a division by zero", () => {
  expect(overlapFrom([[V("correctness", []), V("qa", [])]])).toMatchObject({ findings_total: 0, overlap_ratio: 0, unique_findings_by_role: {} });
  expect(overlapFrom([])).toMatchObject({ review_runs: 0, findings_total: 0, overlap_ratio: 0 });
});

test("harvest: overlap stats come from the merged issues' review handoffs in the window", () => {
  const commentsByIssue = new Map([
    [40, [reviewHandoff(40, { round: 1, at: "2026-09-10T00:00:00Z", verdicts: VERDICT_SETS[0] })]],
    [41, [reviewHandoff(41, { round: 1, at: "2026-09-10T00:00:00Z", verdicts: VERDICT_SETS[2] })]],
  ]);
  const issues = [
    { number: 40, title: "a", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-11T00:00:00Z" },
    { number: 41, title: "b", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-11T00:00:00Z" },
  ];
  const { stats } = harvest({ records: new Map(), issues, commentsByIssue, since: "2026-09-01T00:00:00Z" });
  expect(stats.review_runs).toBe(2);
  expect(stats.findings_total).toBe(4);
  expect(stats.overlapping_findings).toBe(1);
  expect(stats.overlap_ratio).toBe(0.25);
  expect(stats.unique_findings_by_role).toEqual({ qa: 1, correctness: 1, security: 1 });
});


/**
 * ── 최종 리뷰 A-SF6 — **`qa_claims=`에 드디어 독자가 생겼다.** ────────────────────────────────
 *
 * ADR-024 / KTB-42 SF-3은 그 필드를 "retro가 '전부 na에 가까운 승인'을 셀 수 있게" 남기기로 했는데,
 * `factory/lib/retro/**`·`factory/cli/**` 어디에도 그것을 읽는 코드가 없었다 — 기록만 하고 아무도
 * 보지 않는 필드는 계약이 아니라 잔해다. 계약이 **막는** 것은 전부 `na`인 매니페스트 하나뿐이고,
 * 계약이 **허용하지만 눈여겨봐야 할** 상태(절반 이상이 `na`인 승인)는 기록에만 남는다.
 */
import { reviewEvidenceLine } from "../lib/run-record.js";

const evidenceRecord = ({ dir, issue, at, decision, qaClaims }) => appendRunRecord({
  root: dir, issue, stage: "review", runnerId: "gha-1", now: at,
  lines: [reviewEvidenceLine({ runId: `r-${issue}`, runnerId: "gha-1", headSha: "a".repeat(40), round: 1, decision, verdicts: [], qaManifest: "f".repeat(64), qaClaims })],
});

test("A-SF6: stats count the qa claim mix — qa_na_ratio and the na-heavy approvals", () => {
  const dir = mkdtempSync(join(tmpdir(), "retro-qa-claims-"));
  evidenceRecord({ dir, issue: 70, at: "2026-09-10T00:00:00Z", decision: "approved", qaClaims: "3c/1na" });   // 25% na
  evidenceRecord({ dir, issue: 71, at: "2026-09-10T01:00:00Z", decision: "approved", qaClaims: "1c/3na" });   // 75% na — na-heavy
  evidenceRecord({ dir, issue: 72, at: "2026-09-10T02:00:00Z", decision: "rework", qaClaims: "0c/4na" });     // 승인이 아니다 — 세지 않는다
  evidenceRecord({ dir, issue: 73, at: "2026-09-10T03:00:00Z", decision: "approved", qaClaims: null });       // 필드 없음(구형·qa 없는 로스터) — 분모에서도 빠진다
  const records = new Map([70, 71, 72, 73].map((n) => [n, readFileSync(join(dir, `docs/factory/runs/${n}.md`), "utf8")]));
  const issues = [70, 71, 72, 73].map((number) => ({ number, title: "x", labels: [], state: "open" }));

  const { stats } = harvest({ records, issues, commentsByIssue: new Map(), since: null });
  expect(stats.qa_approvals).toBe(2);
  expect(stats.qa_claims_total).toBe(4);
  expect(stats.qa_na_total).toBe(4);
  expect(stats.qa_na_ratio).toBe(0.5);
  expect(stats.qa_na_heavy_approvals).toBe(1);

  // 창 밖의 승인은 세지 않는다 — 나머지 통계와 같은 delta 규약이다.
  const windowed = harvest({ records, issues, commentsByIssue: new Map(), since: "2026-09-10T00:30:00Z" }).stats;
  expect(windowed.qa_approvals).toBe(1);
  expect(windowed.qa_na_ratio).toBe(0.75);
  expect(windowed.qa_na_heavy_approvals).toBe(1);

  // qa 기록이 아예 없는 공장에서는 0이고, 표는 그것을 "없음"으로 읽는다(비율 0.00과 구별된다).
  const none = harvest({ records: new Map(), issues: [], commentsByIssue: new Map(), since: null }).stats;
  expect(none).toMatchObject({ qa_approvals: 0, qa_na_ratio: 0, qa_na_heavy_approvals: 0 });
});

test("A-SF6: accumulateStats sums the qa claim counts and re-derives the ratio (not an average of ratios)", async () => {
  const { accumulateStats, statsTable } = await import("../bin/retro.js");
  const total = accumulateStats(
    { qa_approvals: 1, qa_claims_total: 3, qa_na_total: 1, qa_na_ratio: 0.25, qa_na_heavy_approvals: 0 },
    { qa_approvals: 1, qa_claims_total: 1, qa_na_total: 3, qa_na_ratio: 0.75, qa_na_heavy_approvals: 1 },
  );
  expect(total.qa_approvals).toBe(2);
  expect(total.qa_claims_total).toBe(4);
  expect(total.qa_na_total).toBe(4);
  expect(total.qa_na_ratio).toBe(0.5);                  // 0.25와 0.75의 평균이 아니라 4/8에서 다시 나온 값
  expect(total.qa_na_heavy_approvals).toBe(1);
  expect([statsTable({ qa_approvals: 1, qa_claims_total: 1, qa_na_total: 3, qa_na_ratio: 0.75, qa_na_heavy_approvals: 1 }, total)].flat().join("\n"))
    .toMatch(/qa na ratio \| 0\.75 \(3\/4 claims, na-heavy 1\/1 approvals\) \| 0\.50 \(4\/8 claims, na-heavy 1\/2 approvals\)/);
});

// ── Feedback loop Task 3 — 원시 발견(raw finding) 수확 ─────────────────────────────────────────
// **모든 픽스처는 진짜 생산자가 만든다**(T3 리뷰의 근본 교훈): `gates-detail:` 줄은 `runGates` →
// `gatesDetailLines`가, self-gate 코멘트는 `selfGateRetryComment`가, 전이 거부는 `transition.js`의
// 문구가, 하트비트는 `heartbeatBody`가 만든다. 손으로 적으면 생산자가 낼 수 없는 조합이 생기고,
// 그러면 테스트는 초록인 채 라우팅만 틀린다(1차 구현이 정확히 그랬다).
test("harvestFindings: 소스 네 갈래와 런 바인딩", async () => {
  const { harvestFindings, knownRunsFor } = await import("../lib/feedback/harvest-findings.js");
  const { realGatesDetail, recordOf, heartbeat, gatesHarness, vitestReport, RUNNER } = await import("./helpers/feedback-fixtures.js");
  const hb = heartbeat(8, "review");
  expect([...knownRunsFor([hb])].sort()).toEqual(["99001", RUNNER]);

  // unit: 리포트를 읽은 진짜 실패(발견 아님) / lint: 툴이 없다(하네스)
  const { lines } = await realGatesDetail({
    harness: gatesHarness(),
    outcomes: {
      unit: { code: 1, stdout: " ❯ test/a.test.js (1)\n   × math > adds\n\n Test Files  1 failed" },
      lint: { code: 127, stderr: "bash: line 1: eslint: command not found" },
    },
    report: vitestReport({ passed: 2, failures: ["math > adds"] }),
  });
  const record = recordOf(8, "x", [
    { stage: "implement", at: "2026-09-20T10:05Z", lines },
    { stage: "review", at: "2026-09-20T11:00Z", lines: [
      `context-manifest: ${JSON.stringify({ role: "correctness", cold_read: false, run_id: "99001", runner: RUNNER, round: 1, fields: ["diff", "done_when"] })}`,
    ] },
  ]);

  const comments = [
    hb,
    reviewHandoff(8, { round: 1, at: "2026-09-20T11:05:00Z", verdicts: [
      { role: "correctness", verdict: "reject", must_fix: [
        { id: "mf1", where: ".factory/lib/gates.js:12", claim: "the gate swallows a non-zero exit", evidence: "log" },
        { id: "mf2", where: "the plan's done_when", claim: "done_when 3 is unverifiable", evidence: "-" },
      ], on_others: [] },
    ] }),
  ];

  const found = harvestFindings({ issue: 8, repo: "o/r", record, comments });
  const gates = found.filter((f) => f.kind === "gate");
  // 리포트를 읽은 unit RED는 발견이 아니다; 툴이 없는 lint RED는 `[runtime].setup`을 가리킨다
  expect(gates).toHaveLength(1);
  expect(gates[0].causal_path).toBe(".factory/harness.toml [runtime].setup");
  // 경로를 댄 must_fix만 발견이 된다(산문 `where`는 이미 lesson 후보다)
  const mf = found.filter((f) => f.kind === "review-must_fix");
  expect(mf).toHaveLength(1);
  expect(mf[0].causal_path).toBe(".factory/lib/gates.js:12");
  expect(mf[0].role).toBe("correctness");
  // 같은 런의 그 역할 매니페스트가 붙는다(context adequacy 신호, spec §5)
  expect(mf[0].context_manifest).toEqual(["diff", "done_when"]);
});

/**
 * T3 리뷰 MF-3의 표 — 여섯 행 전부를 **실제 `runGates` 출력**으로 돌린다. 예전 규칙은 `reason`에만
 * 걸려 있었고 `reason`은 리포트를 읽은 테스트 게이트에만 붙으므로, 채택자의 진짜 하네스 RED(A·B·C)는
 * 경로 없는 `ambiguous` 노트가 되고 평범한 lint RED(F)는 머지마다 노트가 됐다 — 정확히 거꾸로였다.
 */
test("gate 판정표: own-cal의 진짜 RED 셋은 harness, 평범한 RED 둘은 발견이 아니다", async () => {
  const { harvestFindings } = await import("../lib/feedback/harvest-findings.js");
  const { realGatesDetail, recordOf, heartbeat, gatesHarness, vitestReport } = await import("./helpers/feedback-fixtures.js");
  const of = async (cfg) => {
    const { lines } = await realGatesDetail({ harness: gatesHarness(), ...cfg });
    const record = recordOf(7, "x", [{ stage: "implement", at: "2026-09-20T10:05Z", lines }]);
    return harvestFindings({ issue: 7, repo: "o/r", record, comments: [heartbeat(7, "implement")] })
      .filter((f) => f.kind === "gate").map((f) => f.causal_path);
  };

  // A · own-cal: Flutter 툴체인이 러너에 없다(exit 127) → 툴체인을 까는 자리는 `[runtime].setup`이다
  expect(await of({ outcomes: { unit: { code: 127, stderr: "/usr/bin/bash: line 1: flutter: command not found" } } }))
    .toEqual([".factory/harness.toml [runtime].setup"]);
  // B · own-cal: `flutter analyze`가 info를 치명으로 친다 — error 급 진단이 하나도 없는데 RED다
  expect(await of({ outcomes: { lint: { code: 1, stdout: "Analyzing own_cal...\n\n   info • Unused import: 'dart:io' • lib/main.dart:3:8 • unused_import\n\n1 issue found. (ran in 3.2s)" } } }))
    .toEqual([".factory/harness.toml [commands].lint"]);
  // C · own-cal: `test_one`의 `-t`를 flutter가 모른다 — 명령 문자열이 틀렸다
  expect(await of({ outcomes: { unit: { code: 64, stderr: 'Could not find an option named "t".\n\nUsage: flutter test [arguments]' } } }))
    .toEqual([".factory/harness.toml [commands].unit"]);
  // D · 진짜 테스트 실패(리포트를 읽었다) → 공장이 제 일을 했다
  expect(await of({ outcomes: { unit: { code: 1, stdout: "   × math > adds" } }, report: vitestReport({ passed: 2, failures: ["math > adds"] }) }))
    .toEqual([]);
  // E · KTB-35: 리포트는 읽었는데 실패가 0인데 명령이 죽었다 → 명령 자리(harness)
  expect(await of({ outcomes: { unit: { code: 1, stderr: "Error: write EPIPE" } }, report: vitestReport({ passed: 5, failures: [] }) }))
    .toEqual([".factory/harness.toml [commands].unit"]);
  // F · 제품 코드에 대한 평범한 lint RED(error 급 진단이 있다) → 발견이 아니다
  expect(await of({ outcomes: { lint: { code: 1, stdout: "/r/src/app.js\n  12:1  error  'x' is never used  no-unused-vars\n\n1 problem" } } }))
    .toEqual([]);
});

/**
 * T3 리뷰 MF-1 — self-gate/전이 거부가 `ktb`가 되려면 **검사 자신이 틀렸다는 증거**가 있어야 한다.
 * 증거가 없는 차단은 공장이 제 일을 한 것이고, 그 결함은 빌더의 테스트/코드다(`product`, 라우팅 없음).
 */
test("attribution: 증거 없는 self-gate 차단은 product, 세 증거는 각각 제 주인으로 간다", async () => {
  const { harvestFindings } = await import("../lib/feedback/harvest-findings.js");
  const { classifyFinding } = await import("../lib/feedback/classify.js");
  const { ownerOf, buildManifest } = await import("../cli/manifest.js");
  const { fileURLToPath } = await import("node:url");
  const { heartbeat, selfGateComment, recordOf, selfGateDetail, humanDecisionComment } = await import("./helpers/feedback-fixtures.js");
  const LOGINS = ["factory-bot"];
  const dests = new Set(buildManifest({ pkgRoot: fileURLToPath(new URL("../..", import.meta.url)) }).map((e) => e.dest));
  const harness = { test: { source_glob: ["src/**/*.js"], test_glob: ["test/**/*.test.js"] } };
  const tagsOf = (f) => classifyFinding({ finding: f, ownerOf, isInstalled: dests, ktbVersion: "1.3.2", harness });

  const block = (findings, extraComments = [], record = "") => harvestFindings({
    issue: 9, repo: "o/r", record, factoryLogins: LOGINS,
    comments: [heartbeat(9, "implement"), selfGateComment({ issue: 9, head: "abc1234", attempt: 1, at: "2026-09-20T10:00:00Z", findings }), ...extraComments],
  }).filter((f) => f.kind === "self-gate");

  // 증거 없음 — mutation survivor는 빌더가 아무것도 주장하지 않는 테스트를 쓴 것이다
  const survivor = block([{ check: "mutation", blocking: true, detail: "survivor: test/date.test.js asserts nothing under mutation (return null in src/date.js)" }]);
  expect(survivor[0].causal_path).toBe("test/date.test.js");
  expect(tagsOf(survivor[0])).toMatchObject({ tags: ["product"], disposition: "outcome" });

  // 증거 없음 — pin 회귀도 마찬가지(빌더가 고정된 가드를 되돌렸다)
  const pin = block([{ check: "pin", blocking: true, ids: ["P-3"], detail: "regression: pin P-3 guard test/tz.test.js is red — a prior fix regressed: DST boundary" }]);
  expect(tagsOf(pin[0])).toMatchObject({ tags: ["product"], disposition: "outcome" });

  // (a) 인프라급 — 검사가 **못 돌았다**. 채택자의 하네스가 단일 테스트를 못 돌린다 → harness
  const misc = block([{ check: "mutation", blocking: true, harness: true, detail: "mutation check misconfigured — the harness cannot run a single test" }]);
  expect(misc[0].causal_path).toBe(".factory/harness.toml");
  expect(tagsOf(misc[0])).toMatchObject({ tags: ["harness"], disposition: "routed" });

  // (b) 사람이 **구조화된 필드**로 공장 탓을 선언했다 → ktb (산문은 증거가 아니다 — 재리뷰 NEW-MF-2)
  const humanDecision = humanDecisionComment({ issue: 9, author: "LeeHyeonKyu", cause: "factory-defect", ktbFix: "1.3.2", reason: "the implement self-gate demanded a qa manifest only review produces", at: "2026-09-20T10:56:00Z" });
  const blamed = block([{ check: "contract", blocking: true, detail: "spec-evidence-missing: no qa evidence manifest" }], [humanDecision]);
  expect(blamed[0].causal_path).toBe(".factory/lib/self-gate.js");
  expect(blamed[0].extra.attribution).toEqual(["human-decision"]);
  expect(tagsOf(blamed[0])).toMatchObject({ tags: ["ktb"], disposition: "routed" });

  // (c) **버전이 오른** 나중 런에서 그 검사가 ran에도 skipped에도 없다 → 거둬들여졌다 → ktb
  const withdrawn = recordOf(9, "x", [
    { stage: "implement", at: "2026-09-20T10:08Z", lines: [selfGateDetail({ ran: ["gates", "contract"], blocked: true, ktbVersion: "1.3.1" })] },
    { stage: "implement", at: "2026-09-20T11:02Z", lines: [selfGateDetail({ ran: ["gates"], skipped: ["mutation", "pins"], ktbVersion: "1.3.2" })] },
  ]);
  const later = block([{ check: "contract", blocking: true, detail: "spec-evidence-missing: no qa evidence manifest" }], [], withdrawn);
  expect(later[0].extra.attribution).toEqual(["check-withdrawn"]);
  expect(tagsOf(later[0])).toMatchObject({ tags: ["ktb"], disposition: "routed" });

  // 같은 검사가 나중에도 계속 돌면 거둬들여진 것이 아니다 — 증거가 아니다
  const stillBlocking = recordOf(9, "x", [
    { stage: "implement", at: "2026-09-20T10:08Z", lines: [selfGateDetail({ ran: ["gates", "mutation"], blocked: true, ktbVersion: "1.3.1" })] },
    { stage: "implement", at: "2026-09-20T11:02Z", lines: [selfGateDetail({ ran: ["gates", "mutation"], blocked: true, ktbVersion: "1.3.2" })] },
  ]);
  const still = block([{ check: "mutation", blocking: true, detail: "survivor: test/date.test.js asserts nothing under mutation (x)" }], [], stillBlocking);
  expect(tagsOf(still[0])).toMatchObject({ tags: ["product"], disposition: "outcome" });
});

// SF-1 — 하네스급 self-gate 차단은 재시도 코멘트를 **남기지 않는다**(`run-stage.js`가 곧장
// needs-human으로 간다). 그 경우의 유일한 durable 증거는 run 기록의 `self-gate: … (harness) …` 줄이다.
test("harness급 self-gate 차단은 run 기록 줄에서 수확된다(코멘트가 없어도)", async () => {
  const { harvestFindings } = await import("../lib/feedback/harvest-findings.js");
  const { heartbeat, recordOf, selfGateDetail } = await import("./helpers/feedback-fixtures.js");
  const record = recordOf(9, "x", [{ stage: "implement", at: "2026-09-20T10:08Z", lines: [
    "verify: ok",
    "self-gate: gates+mutation → BLOCKED (harness) — mutation: mutation check misconfigured — the harness cannot run a single test",
    selfGateDetail({ ran: ["gates", "mutation"], blocked: true, harness: true, ktbVersion: "1.3.2" }),
  ] }]);
  const found = harvestFindings({ issue: 9, repo: "o/r", record, comments: [heartbeat(9, "implement")] });
  expect(found.filter((f) => f.kind === "self-gate")).toHaveLength(1);
  expect(found[0].causal_path).toBe(".factory/harness.toml");
  // 줄이 지목한 런이 이 이슈의 런이 아니면 그 줄도 증거가 아니다(바인딩은 여기에도 걸린다)
  expect(harvestFindings({ issue: 9, repo: "o/r", record, comments: [] })).toEqual([]);
});

// ── Task 4 — 역할별 행동 신호와 escaped 결함의 **귀속** ────────────────────────────────────────
// 픽스처는 전부 진짜 생산자(`renderHandoff`)가 만든다 — `reviewHandoffComment`/`planHandoffComment`.

const approve = (role) => ({ role, verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] });
const rejectN = (role, ids = ["mf1"]) =>
  ({ role, verdict: "reject", confidence: "high", must_fix: ids.map((id) => ({ id, where: "src/a.js:1", claim: `${id} broken`, evidence: "e" })), should_fix: [], verified: [] });

test("escaped 결함은 **그 결함보다 먼저 승인해 둔** 역할에게만 귀속된다", async () => {
  const { roleSignalsFor } = await import("../lib/retro/harvest.js");
  const { reviewHandoffComment } = await import("./helpers/feedback-fixtures.js");
  const { parseHandoffs } = await import("../lib/handoff.js");

  // R1: stamp가 승인, guard도 승인. R2: guard가 결함 둘을 찾아 reject.
  const comments = [
    reviewHandoffComment(1, { round: 1, at: "2026-09-01T00:00:00Z", verdicts: [approve("stamp"), approve("guard")] }),
    reviewHandoffComment(1, { round: 2, at: "2026-09-02T00:00:00Z", verdicts: [approve("stamp"), rejectN("guard", ["mf1", "mf2"])] }),
  ];
  const s = roleSignalsFor(parseHandoffs(comments));
  // stamp는 R1에 승인해 두고 R2의 결함을 놓쳤다 — 둘 다 그에게 귀속된다.
  expect(s.roles.stamp.escaped).toBe(2);
  // guard는 **자기가 찾아낸** 결함으로 벌받지 않는다(그 라운드의 reject 당사자는 blame에서 빠진다).
  expect(s.roles.guard.escaped).toBe(0);
  expect(s.roles.guard.flips).toBe(1);          // approve → reject
  expect(s.roles.stamp.flips).toBe(0);
  expect(s.roles.guard.must_fix).toBe(2);
  expect(s.escaped_total).toBe(2);
});

test("같은 라운드의 must_fix는 아무에게도 귀속되지 않는다 — 정의는 '승인에 뒤이은 결함'이다", async () => {
  const { roleSignalsFor } = await import("../lib/retro/harvest.js");
  const { reviewHandoffComment } = await import("./helpers/feedback-fixtures.js");
  const { parseHandoffs } = await import("../lib/handoff.js");
  const comments = [reviewHandoffComment(2, { round: 1, at: "2026-09-01T00:00:00Z", verdicts: [approve("stamp"), rejectN("guard")] })];
  const s = roleSignalsFor(parseHandoffs(comments));
  expect(s.escaped_total).toBe(0);
  expect(s.roles.stamp.escaped).toBe(0);
});

test("reject는 승인을 **철회한다** — 철회한 뒤의 결함은 그 역할에게 귀속되지 않는다", async () => {
  const { roleSignalsFor } = await import("../lib/retro/harvest.js");
  const { reviewHandoffComment } = await import("./helpers/feedback-fixtures.js");
  const { parseHandoffs } = await import("../lib/handoff.js");
  const comments = [
    reviewHandoffComment(3, { round: 1, at: "2026-09-01T00:00:00Z", verdicts: [approve("a"), approve("b")] }),
    reviewHandoffComment(3, { round: 2, at: "2026-09-02T00:00:00Z", verdicts: [rejectN("a"), approve("b")] }),
    reviewHandoffComment(3, { round: 3, at: "2026-09-03T00:00:00Z", verdicts: [rejectN("c", ["late"])] }),
  ];
  const s = roleSignalsFor(parseHandoffs(comments));
  // a는 R1에 승인해 두었지만 R2에서 **스스로 그 결함을 찾아** 뒤집었다 — 규칙 ③. 늦게라도 제 판정을
  // 고친 리뷰어가 가장 크게 벌받으면 그 규칙은 정확히 반대 행동을 보상한다.
  expect(s.roles.a.escaped).toBe(0);
  // 그리고 R2의 reject는 승인을 **철회한다** — R3에서 c가 찾은 결함도 a의 것이 아니다.
  expect(s.roles.b.escaped).toBe(2);   // b는 R1·R2 모두 승인했다 — R2와 R3의 결함 둘 다 b에게 간다
  expect(s.roles.a.flips).toBe(1);
});

test("aggregateRoleSignals — approve_rate는 정수 비율로 판정하고(반올림 아님) ever_rejects를 함께 낸다", async () => {
  const { aggregateRoleSignals } = await import("../lib/retro/harvest.js");
  const agg = aggregateRoleSignals([
    { roles: { stamp: { verdicts: 3, approves: 3, rejects: 0, must_fix: 0, flips: 0, escaped: 1 } }, escaped_total: 1 },
    { roles: { stamp: { verdicts: 2, approves: 2, rejects: 0, must_fix: 0, flips: 0, escaped: 0 } }, escaped_total: 0 },
  ]);
  expect(agg.stamp).toMatchObject({ verdicts: 5, approves: 5, approve_rate: 1, ever_rejects: false, escaped_defects: 1, issues: 2 });
  // 199/200은 반올림하면 1.00이지만 **100% 승인이 아니다** — 규칙은 정수로 판정한다.
  const near = aggregateRoleSignals([{ roles: { r: { verdicts: 200, approves: 199, rejects: 1, must_fix: 0, flips: 0, escaped: 3 } } }]);
  expect(near.r.approves).not.toBe(near.r.verdicts);
  expect(near.r.ever_rejects).toBe(true);
});

test("planDebateDelta — 해소된 dissent는 변화이고, unresolved/deferred는 변화가 아니다", async () => {
  const { planDebateDelta } = await import("../lib/retro/harvest.js");
  const { planHandoffComment } = await import("./helpers/feedback-fixtures.js");
  const { parseHandoffs } = await import("../lib/handoff.js");

  const dead = parseHandoffs([planHandoffComment(4, { at: "2026-09-01T00:00:00Z",
    done_when: [{ id: "dw1", text: "x", verify: "t", level: "unit" }],
    dissent_log: [{ role: "skeptic", objection: "이 설계는 위험하다", resolution: "unresolved" }] })]);
  expect(planDebateDelta(dead)).toMatchObject({ changed: false, dissent_resolved: 0 });

  const live = parseHandoffs([planHandoffComment(5, { at: "2026-09-01T00:00:00Z",
    done_when: [{ id: "dw1", text: "x", verify: "t", level: "unit" }],
    dissent_log: [{ role: "skeptic", objection: "done_when이 검증 불가다", resolution: "accepted — done_when dw2를 추가했다" }] })]);
  expect(planDebateDelta(live)).toMatchObject({ changed: true, dissent_resolved: 1 });

  // 여러 plan 핸드오프(재계획)에서 done_when이 늘어난 것도 변화다.
  const grew = parseHandoffs([
    planHandoffComment(6, { round: 1, at: "2026-09-01T00:00:00Z", done_when: [{ id: "dw1", text: "x", verify: "t", level: "unit" }] }),
    planHandoffComment(6, { round: 2, at: "2026-09-02T00:00:00Z", done_when: [{ id: "dw1", text: "x", verify: "t", level: "unit" }, { id: "dw2", text: "y", verify: "u", level: "unit" }] }),
  ]);
  expect(planDebateDelta(grew)).toMatchObject({ changed: true, done_when_added: 1 });

  // 토론 자체가 없으면 바꾼 것도 없다.
  expect(planDebateDelta([])).toMatchObject({ changed: false, plan_handoffs: 0 });
});
