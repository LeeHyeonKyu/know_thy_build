// Task 10 (Phase-2 gate instrumentation) — the retro must make the gate MEASURABLE.
// harvest() emits, per merged issue and rolled up, `rounds_per_issue`, `escaped_defects`
// (+ detail) and `revert_rate`; accumulateStats rolls them into the cumulative total and
// statsTable renders them next to the frozen session baseline. The two escaped-defect
// exemplars (own-cal R2 production-API, KTB #18 R3 finish() regression) are pinned here —
// each must register under the definition, or a Phase-2 coverage cut could hide a regression.

import { test, expect } from "vitest";
import { harvest } from "../lib/retro/harvest.js";
import { accumulateStats, statsTable, QUALITY_BASELINE } from "../bin/retro.js";
import { renderHandoff } from "../lib/handoff.js";

const reviewHandoff = (issue, { round = 1, verdicts, at }) => ({ id: `c-review-${issue}-${round}`, createdAt: at, body: renderHandoff({
  stage: "review", issue,
  data: { schema: "factory.review.v1", issue, pr: issue, head_sha: "a".repeat(40), round, verdicts, orchestration: "workflow", guarantee: "verified" },
}) });
const rejectVerdict = (role, claim, id = "cf1") => ({ role, verdict: "reject", confidence: "high", must_fix: [{ id, where: "a.ts:1", claim, evidence: "e" }], should_fix: [], verified: [] });
const approveVerdict = (role) => ({ role, verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: ["t"] });
const implementHo = (issue, at) => ({ id: `c-impl-${issue}-${at}`, createdAt: at, body: renderHandoff({
  stage: "implement", issue,
  data: { schema: "factory.implement.v1", issue, pr: issue, head_sha: "b".repeat(40), branch: `claude/fq-${issue}`, gates: { status: "GREEN", level: "full" }, orchestration: "workflow", tests_added: ["t"] },
}) });
const planHo = (issue, at) => ({ id: `c-plan-${issue}-${at}`, createdAt: at, body: renderHandoff({
  stage: "plan", issue,
  data: { schema: "factory.plan.v1", issue, tier: "standard", roles: ["architect"], rounds: 3,
    done_when: [{ id: "dw1", text: "x", verify: "test_x", level: "unit" }], files_expected: [], dissent_log: [], non_goals: [], open_risks: [] },
}) });

test("rounds_per_issue: plan/implement counts and review max-round per merged issue, rolled up as merge-weighted averages", () => {
  const commentsByIssue = new Map([
    [100, [
      planHo(100, "2026-09-01T00:00:00Z"),
      implementHo(100, "2026-09-01T01:00:00Z"),
      reviewHandoff(100, { round: 1, at: "2026-09-01T02:00:00Z", verdicts: [rejectVerdict("correctness", "c1")] }),
      implementHo(100, "2026-09-01T03:00:00Z"),                                            // rework build
      reviewHandoff(100, { round: 2, at: "2026-09-01T04:00:00Z", verdicts: [approveVerdict("correctness")] }),
    ]],
    [101, [
      planHo(101, "2026-09-02T00:00:00Z"),
      implementHo(101, "2026-09-02T01:00:00Z"),
      reviewHandoff(101, { round: 1, at: "2026-09-02T02:00:00Z", verdicts: [approveVerdict("correctness")] }),
    ]],
  ]);
  const issues = [
    { number: 100, title: "a", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-01T05:00:00Z" },
    { number: 101, title: "b", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-02T03:00:00Z" },
  ];
  const { stats } = harvest({ records: new Map(), issues, commentsByIssue, since: null });
  expect(stats.rounds_per_issue).toEqual([
    { issue: 100, plan: 1, implement: 2, review: 2 },
    { issue: 101, plan: 1, implement: 1, review: 1 },
  ]);
  expect(stats.plan_rounds_avg).toBe(1);          // (1+1)/2
  expect(stats.implement_rounds_avg).toBe(1.5);   // (2+1)/2
  expect(stats.review_rounds_avg).toBe(1.5);      // (2+1)/2 — existing machinery
});

test("escaped_defects: a post-approval must_fix registers exactly one; a clean issue registers none", () => {
  const commentsByIssue = new Map([
    // #110 clean: reject then approve, no defect after the approval
    [110, [
      reviewHandoff(110, { round: 1, at: "2026-09-01T00:00:00Z", verdicts: [rejectVerdict("correctness", "c1")] }),
      reviewHandoff(110, { round: 2, at: "2026-09-01T01:00:00Z", verdicts: [approveVerdict("correctness")] }),
    ]],
    // #111 escaped: a role approves in R1, a new must_fix surfaces in R2
    [111, [
      reviewHandoff(111, { round: 1, at: "2026-09-02T00:00:00Z", verdicts: [approveVerdict("correctness")] }),
      reviewHandoff(111, { round: 2, at: "2026-09-02T01:00:00Z", verdicts: [rejectVerdict("qa", "regression", "cf7")] }),
      reviewHandoff(111, { round: 3, at: "2026-09-02T02:00:00Z", verdicts: [approveVerdict("qa")] }),
    ]],
  ]);
  const issues = [
    { number: 110, title: "a", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-01T02:00:00Z" },
    { number: 111, title: "b", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-02T03:00:00Z" },
  ];
  const { stats } = harvest({ records: new Map(), issues, commentsByIssue, since: null });
  expect(stats.escaped_defects).toBe(1);
  expect(stats.escaped_defects_detail).toEqual([{ issue: 111, count: 1 }]);
});

// Controller ruling: escaped_defects = a defect found AFTER an approval (the process said OK,
// then it wasn't). The two exemplars split across the gate's TWO signals:
//   - own-cal #3 was reject-heavy (R1 reject → R2 reject production-API → R3 reject → R4 approve):
//     its production-API defect was caught by review across reject rounds, NEVER after an approval,
//     so escaped_defects=0 is correct. Its cost lands on rounds_per_issue (4 review rounds).
//   - KTB #18 R3 is the real approve→reject flip (observation O21): a post-approval escaped defect.
test("regression pins: own-cal #3 (reject-heavy) scores escaped=0 with high rounds; KTB #18 R3 (approve→reject flip) registers escaped", () => {
  const commentsByIssue = new Map([
    // own-cal #3 — the REAL shape: four reject rounds then approve. No approval precedes the R2 production-API defect.
    [3, [
      reviewHandoff(3, { round: 1, at: "2026-09-14T00:00:00Z", verdicts: [rejectVerdict("correctness", "R1 finding", "c1")] }),
      reviewHandoff(3, { round: 2, at: "2026-09-14T01:00:00Z", verdicts: [rejectVerdict("correctness", "off", "c2"), rejectVerdict("architecture", "production API called from a test path", "prod-api")] }),
      reviewHandoff(3, { round: 3, at: "2026-09-14T02:00:00Z", verdicts: [rejectVerdict("spec-conformance", "spec drift", "s1")] }),
      reviewHandoff(3, { round: 4, at: "2026-09-14T03:00:00Z", verdicts: [approveVerdict("correctness"), approveVerdict("architecture"), approveVerdict("spec-conformance")] }),
    ]],
    // KTB #18 — R2 a partial-panel approve (qa), R3 full panel catches the finish() regression after that approval
    [18, [
      reviewHandoff(18, { round: 1, at: "2026-09-15T00:00:00Z", verdicts: [rejectVerdict("qa", "docs claim unverified", "d1")] }),
      reviewHandoff(18, { round: 2, at: "2026-09-15T01:00:00Z", verdicts: [approveVerdict("qa"), rejectVerdict("correctness", "still off", "c2")] }),
      reviewHandoff(18, { round: 3, at: "2026-09-15T02:00:00Z", verdicts: [rejectVerdict("correctness", "finish() now returns exit 0 on failure — regression", "fin")] }),
    ]],
  ]);
  const issues = [
    { number: 3, title: "own-cal", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-14T04:00:00Z" },
    { number: 18, title: "ktb", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-15T03:00:00Z" },
  ];
  const { stats } = harvest({ records: new Map(), issues, commentsByIssue, since: null });
  const escBy = Object.fromEntries(stats.escaped_defects_detail.map((d) => [d.issue, d.count]));
  const roundsBy = Object.fromEntries(stats.rounds_per_issue.map((r) => [r.issue, r]));
  // own-cal: caught in review, never after an approval → escaped 0; its cost shows as 4 review rounds
  expect(escBy[3]).toBeUndefined();
  expect(roundsBy[3].review).toBe(4);
  // KTB #18 R3: post-approval escaped defect registers
  expect(escBy[18]).toBeGreaterThanOrEqual(1);
});

test("revert_rate: a merged issue reverted by a revert issue counts; null when there are no merges to divide", () => {
  const commentsByIssue = new Map([
    [120, [reviewHandoff(120, { round: 1, at: "2026-09-01T00:00:00Z", verdicts: [approveVerdict("correctness")] })]],
    [121, [reviewHandoff(121, { round: 1, at: "2026-09-02T00:00:00Z", verdicts: [approveVerdict("correctness")] })]],
  ]);
  const issues = [
    { number: 120, title: "sync", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-01T01:00:00Z" },
    { number: 121, title: "export", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-02T01:00:00Z" },
    // a revert issue referencing #120 (label-based)
    { number: 130, title: "revert broken sync (#120)", labels: ["factory:revert"], state: "open" },
  ];
  const { stats } = harvest({ records: new Map(), issues, commentsByIssue, since: null });
  expect(stats.merged).toBe(2);
  expect(stats.reverts).toBe(1);
  expect(stats.revert_rate).toBe(0.5);
  // degrade gracefully: no merges in the window → nothing to divide → null (not a false 0.00)
  const empty = harvest({ records: new Map(), issues: [], commentsByIssue: new Map(), since: null }).stats;
  expect(empty.revert_rate).toBeNull();
  expect(empty.reverts).toBe(0);
});

test("revert_rate: a 'Revert \"...\"' git-style follow-up issue title is detected without a label", () => {
  const commentsByIssue = new Map([[140, [reviewHandoff(140, { round: 1, at: "2026-09-01T00:00:00Z", verdicts: [approveVerdict("correctness")] })]]]);
  const issues = [
    { number: 140, title: "add cache", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-01T01:00:00Z" },
    { number: 141, title: 'Revert "add cache" (#140)', labels: [], state: "closed", closedAt: "2026-09-02T00:00:00Z" },
  ];
  const { stats } = harvest({ records: new Map(), issues, commentsByIssue, since: null });
  expect(stats.reverts).toBe(1);
  expect(stats.revert_rate).toBe(1);
});

// ── roll-up + rendering ──────────────────────────────────────────────────────────────────

test("accumulateStats: escaped_defects sums, revert_rate re-derives from the reverted-issue union / merged, plan/implement rounds stay merge-weighted", () => {
  const w1 = { merged: 2, review_rounds_avg: 2, plan_rounds_avg: 1, implement_rounds_avg: 2, escaped_defects: 1, reverted_issues: [] };
  const t1 = accumulateStats(null, w1);
  expect(t1).toMatchObject({ escaped_defects: 1, reverts: 0, plan_rounds_avg: 1, implement_rounds_avg: 2 });
  expect(t1.revert_rate).toBe(0);                                       // 0/2

  const w2 = { merged: 6, review_rounds_avg: 1, plan_rounds_avg: 1, implement_rounds_avg: 1, escaped_defects: 2, reverted_issues: [55] };
  const t2 = accumulateStats(t1, w2);
  expect(t2.merged).toBe(8);
  expect(t2.escaped_defects).toBe(3);                                   // 1 + 2
  expect(t2.reverts).toBe(1);
  expect(t2.revert_rate).toBe(0.13);                                    // 1/8 re-derived, not an average of rates

  // the SAME revert re-observed in a later window's snapshot does not double-count (union by issue #)
  const t3 = accumulateStats(t2, { merged: 0, reverted_issues: [55] });
  expect(t3.reverts).toBe(1);
  expect(t2.implement_rounds_avg).toBe(1.25);                           // (2×2 + 1×6)/8 — merge-weighted
  expect(t2.plan_rounds_avg).toBe(1);

  // no merges in the window → cumulative revert_rate is null when nothing has ever merged
  expect(accumulateStats(null, { merged: 0 }).revert_rate).toBeNull();
});

test("revert lag: a revert observed in a later window lands against its original merge in the cumulative roll-up", () => {
  // Window A closed #200 (merged) with no revert yet, and the roll-up counted it.
  const windowA = { merged: 3, reverted_issues: [] };
  const totalAfterA = accumulateStats(null, windowA);
  expect(totalAfterA.merged).toBe(3);
  expect(totalAfterA.reverts).toBe(0);

  // Window B: #200 is no longer afterSince (not a window merge), but a revert issue #201 → #200 is now
  // observed. harvest reports it in reverted_issues even though the window has 0 merges of its own.
  const commentsByIssue = new Map([[200, [reviewHandoff(200, { round: 1, at: "2026-09-01T00:00:00Z", verdicts: [approveVerdict("correctness")] })]]]);
  const issues = [
    { number: 200, title: "cache", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-01T01:00:00Z" },
    { number: 201, title: "revert cache (#200)", labels: ["factory:revert"], state: "open" },
  ];
  const windowB = harvest({ records: new Map(), issues, commentsByIssue, since: "2026-09-05T00:00:00Z" }).stats;
  expect(windowB.merged).toBe(0);                       // #200 is outside this window
  expect(windowB.reverts).toBe(0);                      // ...so it is not a window-scoped revert
  expect(windowB.revert_rate).toBeNull();               // nothing to divide in the window
  expect(windowB.reverted_issues).toEqual([200]);       // ...but the lagging revert IS observed

  // rolled up: the revert lands against #200 (counted in cumulative merged back in window A)
  const totalAfterB = accumulateStats(totalAfterA, windowB);
  expect(totalAfterB.reverts).toBe(1);
  expect(totalAfterB.revert_rate).toBe(0.33);           // 1/3 cumulative
});

test("revert reference: a factory revert issue that names the reverted issue in its BODY (not title) still counts", () => {
  const commentsByIssue = new Map([[210, [reviewHandoff(210, { round: 1, at: "2026-09-01T00:00:00Z", verdicts: [approveVerdict("correctness")] })]]]);
  const issues = [
    { number: 210, title: "add worker", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-01T01:00:00Z" },
    { number: 211, title: "revert regression", labels: ["factory:revert"], body: "This reverts commit abc123.\n\nReverts #210 — the worker deadlocked.", state: "open" },
  ];
  const { stats } = harvest({ records: new Map(), issues, commentsByIssue, since: null });
  expect(stats.reverts).toBe(1);
  expect(stats.reverted_issues).toEqual([210]);
});

test("statsTable renders the rounds-per-issue, escaped-defect and revert-rate rows plus the frozen session baseline", () => {
  const window = {
    merged: 2, review_rounds_avg: 1.5, plan_rounds_avg: 1, implement_rounds_avg: 1.5,
    escaped_defects: 1, escaped_defects_detail: [{ issue: 111, count: 1 }], reverts: 1, revert_rate: 0.5,
    rounds_per_issue: [{ issue: 100, plan: 1, implement: 2, review: 2 }, { issue: 111, plan: 1, implement: 1, review: 3 }],
  };
  const total = { merged: 8, review_rounds_avg: 1.2, plan_rounds_avg: 1, implement_rounds_avg: 1.4, escaped_defects: 3, reverts: 1, revert_rate: 0.13 };
  const table = statsTable(window, total);
  expect(table).toContain("| rounds/issue (plan/impl/review) | 1 / 1.5 / 1.5 | 1 / 1.4 / 1.2 |");
  expect(table).toContain("| escaped defects | 1 (#111×1) | 3 |");
  expect(table).toContain("| revert rate | 0.50 (1/2) | 0.13 (1/8) |");
  // per-issue detail table
  expect(table).toContain("| #100 | 1 | 2 | 2 |");
  // the frozen baseline (this session) is recorded in the output: $/rounds note, numeric thresholds,
  // the rounds-per-issue exemplar (own-cal), and the escaped-defect exemplar (KTB #18 R3)
  expect(table).toContain(QUALITY_BASELINE.note);
  expect(table).toMatch(/escaped_defects ≤ 0, revert_rate ≤ 0\.00/);
  expect(table).toMatch(/own-cal #3 = 4 review rounds/);
  expect(table).toMatch(/KTB #18 R3 finish\(\) regression/);
  // a fresh factory (no merges) shows "없음" for the ratio-shaped rows, never a false 0.00
  expect(statsTable(null, null)).toContain("| revert rate | 없음 | 없음 |");
});
