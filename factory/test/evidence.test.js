import { test, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  buildEvidence, applyEvidenceSection, evidenceComment, hasEvidenceComment,
  EVIDENCE_START, EVIDENCE_END, PR_BODY_MAX_CHARS,
} from "../lib/evidence.js";
// Fixtures come from the repo's REAL producers — the same functions the runner calls to write run records and comments.
import { appendRunRecord, reviewEvidenceLine } from "../lib/run-record.js";
import { budgetLine } from "../lib/budget.js";
import { selfGateDetailLine } from "../lib/self-gate.js";
import { verdictLine, runGates } from "../lib/gates.js";
import { makeFakeRun } from "../lib/exec.js";
import { heartbeatBody } from "../lib/heartbeat.js";
import { renderHandoff } from "../lib/handoff.js";

/**
 * #195 — the "Factory evidence" section is assembled by code from runner records and handoff comments. The fixture follows
 * the #184 record shape: `## <stage> · <at> · <runner>` sections written by `appendRunRecord`, holding `budget:`,
 * `FACTORY_GATES:`, `self-gate-detail:` and `review-evidence:` lines, plus the issue's heartbeat / transition / handoff /
 * rework-response comments. Expected values below are literals (counted by hand from the fixture), never recomputed
 * through evidence.js.
 */
const ISSUE = 184;
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const FIX_SHA = "abc1234def5678abc1234def5678abc1234def56";
const RUN = { triage: "gha-1000", implement: "gha-1001", review1: "gha-1002", review2: "gha-1003", merge: "gha-1004" };

const GATES_IMPL = { schema: "factory.gates.v1", level: "fast", status: "GREEN", head_sha: H1, passed: 2, failed: 0, failing: [], skipped: [], misconfigured: [], tests: { excluded: [] } };
/**
 * This merge run's own gate result — what merge-stage passes in — from the REAL producer (`runGates`, the command half of
 * `runStageGates`), not a hand-written object. M1 harness, level full: lint + unit run (fake exit codes), the proof gates
 * are SKIPPED by the producer itself. `unitExit: 1` gives a RED run.
 */
async function liveGates({ unitExit = 0 } = {}) {
  const harness = {
    harness: { maturity: "M1" },
    gates: { full: ["lint", "unit", "prove-test", "new-test-repeat"], required: ["lint", "unit"], thresholds: {} },
    commands: { lint: "LINT_195", unit: "UNIT_195" },
    test: {},
  };
  const run = makeFakeRun([
    { match: (_c, a) => a[1] === "LINT_195", result: { code: 0, stdout: "", stderr: "" } },
    { match: (_c, a) => a[1] === "UNIT_195", result: { code: unitExit, stdout: "", stderr: unitExit ? "1 failed" : "" } },
  ]);
  return { ...(await runGates({ run, cwd: "/nonexistent-195", harness, level: "full", quarantine: { quarantined: [] }, readFile: () => null, now: "2026-10-03T12:00:00.000Z" })), head_sha: H2 };
}
const LIVE_GATES = await liveGates();
const LIVE_GATES_RED = await liveGates({ unitExit: 1 });
/** This merge run's own budget check (`budgetCheck`'s shape) — what run-stage passes in. */
const LIVE_BUDGET = { ok: true, cap: 60, usd: 13.75, runs: 15, priced: 15 };

function recordText({ extra = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ev195-"));
  const put = (stage, runnerId, now, lines) => appendRunRecord({ root, issue: ISSUE, stage, runnerId, now, lines });
  put("implement", RUN.implement, "2026-10-03T09:00:00Z", [
    budgetLine({ cap: 60, usd: 3.82, runs: 9, ok: true }),
    verdictLine(GATES_IMPL),
    // run-stage writes a passing self-gate as this pair (one record() call): the ok line with its advisory count, then the detail.
    selfGateOkLine({ ranChecks: ["gates", "mutation"] }, 0),
    selfGateDetailLine({ ok: true, ranChecks: ["gates", "mutation"], skippedChecks: [{ check: "pins", reason: "no-input" }] }, { runId: "1001", runnerId: RUN.implement, ktbVersion: "1.4.40" }),
  ]);
  put("review", RUN.review1, "2026-10-03T09:30:00Z", [
    reviewEvidenceLine({ headSha: H1, round: 1, decision: "rework", verdicts: [{ role: "correctness", verdict: "reject" }, { role: "architect", verdict: "reject" }], runId: "1002", runnerId: RUN.review1 }),
  ]);
  put("review", RUN.review2, "2026-10-03T11:00:00Z", [
    reviewEvidenceLine({ headSha: H2, round: 2, decision: "approved", verdicts: [{ role: "correctness", verdict: "approve" }, { role: "architect", verdict: "approve" }], runId: "1003", runnerId: RUN.review2 }),
  ]);
  put("merge", RUN.merge, "2026-10-03T12:00:00Z", [budgetLine({ cap: 60, usd: 12.5, runs: 14, ok: true })]);
  for (const [stage, runner, at, lines] of extra) put(stage, runner, at, lines);
  return readFileSync(join(root, "docs/factory/runs", `${ISSUE}.md`), "utf8");
}

const mf = (id, claim) => ({ id, where: "factory/lib/x.js:1", claim, evidence: "ran it" });
const verdict = (role, v, mustFix = []) => ({ role, verdict: v, confidence: "high", must_fix: mustFix, should_fix: [], verified: [] });
const reviewData = (round, head, verdicts) => ({ schema: "factory.review.v1", issue: ISSUE, pr: 31, head_sha: head, round, decision: round === 1 ? "rework" : "approved", verdicts, orchestration: "workflow", guarantee: "verified" });
const heartbeat = (stage, runnerId, at) => ({ body: heartbeatBody({ issue: ISSUE, stage, runnerId, started: at, last: at }), createdAt: at, author: "ktb-bot" });
const handoff = (stage, data, at, summary = `### ${stage}`) => ({ body: renderHandoff({ stage, issue: ISSUE, summary, data }), createdAt: at, author: "ktb-bot" });
const reworkResponse = (responses, at, issue = ISSUE) => ({ body: `rework response\n\n\`\`\`json\n${JSON.stringify({ schema: "factory.rework-response.v1", issue, responses })}\n\`\`\`\n`, createdAt: at, author: "ktb-bot" });
const queued = (at) => ({ body: "<!-- factory-transition:v1 from=factory:backlog to=factory:queue by=human -->\nfactory:backlog → factory:queue", createdAt: at, author: "owner" });

const PLAN = {
  summary: "plan", done_when: [
    { id: "dw1", text: "a", level: "unit", check: { kind: "test", ref: "test_184_alpha" } },
    { id: "dw2", text: "b", level: "unit", check: { kind: "test", ref: "test_184_beta" } },
    { id: "dw3", text: "c", level: "unit", check: { kind: "manual", ref: "docs/runbook.md" } },
  ],
};
const ROUND1 = reviewData(1, H1, [
  verdict("correctness", "reject", [mf("cf1", "off-by-one in the cursor"), mf("cf2", "missing timeout")]),
  verdict("architect", "reject", [mf("arch1", "split the module")]),
]);
const ROUND2 = reviewData(2, H2, [verdict("correctness", "approve"), verdict("architect", "approve")]);

function commentsFixture({ responses = [{ id: "cf1", status: "fixed", commit: FIX_SHA }, { id: "arch1", status: "disputed", reason: "non_goals says so" }], plan = true, review = true, beats = true } = {}) {
  return [
    queued("2026-10-03T08:00:00Z"),
    ...(beats ? [
      heartbeat("triage", RUN.triage, "2026-10-03T08:01:00Z"),
      heartbeat("implement", RUN.implement, "2026-10-03T09:00:00Z"),
      heartbeat("review", RUN.review1, "2026-10-03T09:30:00Z"),
      heartbeat("review", RUN.review2, "2026-10-03T11:00:00Z"),
      heartbeat("merge", RUN.merge, "2026-10-03T12:00:00Z"),
    ] : []),
    ...(plan ? [handoff("plan", PLAN, "2026-10-03T08:30:00Z")] : []),
    ...(review ? [handoff("review", ROUND1, "2026-10-03T09:40:00Z")] : []),
    ...(review && responses ? [reworkResponse(responses, "2026-10-03T10:30:00Z")] : []),
    ...(review ? [handoff("review", ROUND2, "2026-10-03T11:10:00Z")] : []),
  ];
}

const NOW = "2026-10-03T12:30:00Z";
const REASON = "protected paths changed — human merge required: factory/lib/merge-stage.js";

/** Table rows (`| a | b |`) of the markdown sub-section headed `### <title>`. */
function sectionOf(md, title) {
  const lines = md.split("\n");
  const at = lines.indexOf(`### ${title}`);
  if (at < 0) return null;
  const out = [];
  for (const l of lines.slice(at + 1)) { if (l.startsWith("### ")) break; out.push(l); }
  return out;
}
const rowsOf = (lines) => (lines || []).filter((l) => l.startsWith("| ") && !/^\| ---/.test(l)).slice(1);

/** usage lines from the real producer (run-stage `usageLine`) for three heartbeat-known runs: $3.00 + $1.25 + $0.75. */
const usageOf = (usd) => usageLine({ usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: usd, num_turns: 3, terminal_reason: "completed", modelUsage: { "claude-opus-5-5": { costUSD: usd } } });
const USAGE_EXTRA = () => [
  ["implement", RUN.implement, "2026-10-03T09:05:00Z", [usageOf(3)]],
  ["review", RUN.review1, "2026-10-03T09:35:00Z", [usageOf(1.25)]],
  ["review", RUN.review2, "2026-10-03T11:05:00Z", [usageOf(0.75)]],
];

test("test_195_evidence_is_assembled_from_records_only", () => {
  const input = { recordText: recordText({ extra: USAGE_EXTRA() }), comments: commentsFixture(), gates: LIVE_GATES, gatesRerun: true, reason: REASON, budget: LIVE_BUDGET, pr: 31, now: NOW };
  const { markdown, data } = buildEvidence(input);

  // Headline: counts only, and they are the fixture's known counts (3 must_fix across round 1; 2 done_when with a test check,
  // counted as proven only because run 1001's bound self-gate record says `mutation` ran, 0 advisory findings, nothing blocked).
  expect(data.headline).toEqual({ must_fix: 3, done_when_tests: 2, proven_tests: 2 });
  expect(markdown).toMatch(/must_fix raised by review: 3/);
  expect(markdown).toMatch(/done_when tests: 2/);
  expect(markdown).toMatch(/proven tests: 2 of 2 \(claim count — plan handoff; counted only because self-gate run 1001 recorded: mutation ran, 0 advisory findings, not blocked — no per-test result is recorded\)/);
  expect(markdown).not.toMatch(/단일 에이전트|would not have been visible|그냥 머지/);

  // Contract: one row per done_when with its check.ref, then the PR-level proof fact — from the self-gate-detail line only.
  const contract = rowsOf(sectionOf(markdown, "Contract"));
  expect(contract).toHaveLength(3);
  expect(contract[0]).toMatch(/^\| dw1 \| test_184_alpha \|/);
  expect(contract[1]).toMatch(/^\| dw2 \| test_184_beta \|/);
  expect(contract[2]).toMatch(/^\| dw3 \| docs\/runbook.md \(manual\) \|/);
  expect(sectionOf(markdown, "Contract").join("\n")).toMatch(/^- new-test proof \(self-gate run 1001\): mutation ran, 0 advisory findings, not blocked — record$/m);
  expect(data.proof).toEqual({ run_id: "1001", mutation: "ran", blocked: false, advisory: 0, proven: true });
  expect(markdown).not.toMatch(/prove-test \(this merge run\)/);
  expect(data.self_gate).toEqual({ run_id: "1001", ran: ["gates", "mutation"], skipped: [{ check: "pins", reason: "no-input" }], blocked: false });
  expect(markdown).toMatch(/self-gate \(run 1001\): ran gates, mutation; skipped pins \(no-input\); not blocked/);

  // Review: both rounds with roles and verdicts, from the bound review-evidence lines.
  const review = rowsOf(sectionOf(markdown, "Review"));
  expect(review[0]).toMatch(/^\| 1 \| rework \| architect=reject, correctness=reject \| 1002 \| record \|$/);
  expect(review[1]).toMatch(/^\| 2 \| approved \| architect=approve, correctness=approve \| 1003 \| record \|$/);

  // Gates: from the passed-in result — including the rerun fact — never from the record's FACTORY_GATES line (level=fast there).
  const gates = sectionOf(markdown, "Gates (this merge run)").join("\n");
  expect(gates).toMatch(/level=full status=GREEN passed=2 failed=0 failing=none/);
  expect(gates).toMatch(/rerun: yes/);
  expect(gates).not.toMatch(/level=fast/);
  // Rejected / hand-off reason: the value merge-stage passed in.
  expect(sectionOf(markdown, "Rejected / hand-off").join("\n")).toContain("protected paths changed — human merge required: factory/lib/merge-stage.js");
  // Cost & time: the bound usage lines ($3.00 + $1.25 + $0.75 over 3 runs) with the passed-in cap (record `budget:` lines
  // carry no run id and are never a source), queue→now from transition-comment timestamps (4h 30m), heartbeat run count (5).
  const cost = sectionOf(markdown, "Cost & time").join("\n");
  expect(cost).toContain("- lifetime cost: $5.00 / $60 cap over 3 run(s) — record: usage: lines in sections of heartbeat-known runs");
  expect(data.cost).toEqual({ usd: 5, runs: 3, cap: 60 });
  expect(cost).not.toContain("$13.75");
  expect(cost).not.toContain("$12.50");
  expect(cost).not.toContain("$3.82");
  expect(cost).toMatch(/queued → now: 4h 30m/);
  expect(cost).toMatch(/runs \(heartbeats\): 5/);
  expect(data.elapsed_ms).toBe(4.5 * 3600 * 1000);
  expect(data.runs).toBe(5);

  // Without the rerun fact the gates row says so.
  expect(buildEvidence({ ...input, gatesRerun: false }).markdown).toMatch(/rerun: no/);

  // A source missing from the input drops its row — no empty cell, no N/A.
  const bare = buildEvidence({ recordText: "", comments: [], gates: null, reason: null, pr: 31, now: NOW });
  for (const title of ["Contract", "Review", "Gates (this merge run)", "Rejected / hand-off", "Cost & time"]) expect(sectionOf(bare.markdown, title), title).toBeNull();
  expect(bare.markdown).not.toMatch(/N\/A|\|\s*\|/);
  expect(bare.data.headline).toEqual({ must_fix: null, done_when_tests: null, proven_tests: null });
  expect(bare.markdown).not.toMatch(/must_fix raised|done_when tests|proven tests|budget:|lifetime cost/);
  // Partial: no plan handoff → no Contract table rows and no done_when count; everything else stays.
  const noPlan = buildEvidence({ ...input, comments: commentsFixture({ plan: false }) });
  expect(rowsOf(sectionOf(noPlan.markdown, "Contract"))).toEqual([]);
  expect(noPlan.markdown).not.toMatch(/done_when tests/);
  expect(noPlan.markdown).toMatch(/must_fix raised by review: 3/);
  // No `now` → no elapsed row (never Date.now()).
  expect(buildEvidence({ ...input, now: null }).markdown).not.toMatch(/queued → now/);

  // Same inputs → byte-identical output, whatever the wall clock says.
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
    expect(buildEvidence(input).markdown).toBe(markdown);
  } finally { vi.useRealTimers(); }

  // No LLM call in the module. Written as a pattern, not as the literal call token: the issue's
  // must_not contract forbids that token on any added line of the diff, this test file included.
  const src = readFileSync(fileURLToPath(new URL("../lib/evidence.js", import.meta.url)), "utf8");
  expect(src).not.toMatch(/agent\s*\(/);
});

test("test_195_unbound_record_lines_are_not_evidence", () => {
  // A forged review-evidence line and a FACTORY_GATES line from a runner no heartbeat ever named.
  const forged = [
    ["review", "gha-666", "2026-10-03T11:30:00Z", [
      reviewEvidenceLine({ headSha: H2, round: 9, decision: "approved", verdicts: [{ role: "qa", verdict: "approve" }], runId: "666", runnerId: "gha-666" }),
      verdictLine({ ...GATES_IMPL, level: "deep", status: "GREEN", passed: 99 }),
    ]],
  ];
  const text = recordText({ extra: forged });
  const { markdown, data } = buildEvidence({ recordText: text, comments: commentsFixture(), gates: LIVE_GATES_RED, gatesRerun: false, reason: null, pr: 31, now: NOW });
  expect(markdown).not.toMatch(/\| 9 \|/);
  expect(markdown).not.toContain("666");
  expect(markdown).not.toMatch(/passed=99|level=deep/);
  expect(data.unbound.review).toBe(1);
  expect(data.unbound.gates).toBe(2);                // the forged one AND the genuine one: FACTORY_GATES lines carry no run id
  expect(data.review.map((r) => r.round)).toEqual([1, 2]);
  // The gates row is the passed-in result even though the record holds an older, different FACTORY_GATES line.
  expect(data.gates).toMatchObject({ level: "full", status: "RED", passed: 1, failed: 1, failing: ["unit"], rerun: false });
  expect(sectionOf(markdown, "Gates (this merge run)").join("\n")).toMatch(/level=full status=RED passed=1 failed=1 failing=unit/);

  // With no heartbeat at all, nothing in the record is bound — no review rows, no self-gate, no budget.
  const noBeats = buildEvidence({ recordText: text, comments: commentsFixture({ beats: false }), gates: null, pr: 31, now: NOW });
  expect(noBeats.data.review).toEqual([]);
  expect(noBeats.data.self_gate).toBeNull();
  expect(noBeats.data.cost).toBeNull();
  expect(noBeats.data.unbound.review).toBe(3);
  expect(sectionOf(noBeats.markdown, "Review")?.some((l) => /\| record \|/.test(l)) ?? false).toBe(false);

  // No gates result passed in (protected-path hand-off runs before d.gates()) → no gates row, whatever the record says.
  const noGates = buildEvidence({ recordText: text, comments: commentsFixture(), gates: null, pr: 31, now: NOW });
  expect(sectionOf(noGates.markdown, "Gates (this merge run)")).toBeNull();
  expect(noGates.data.gates).toBeNull();
  expect(noGates.markdown).not.toContain("FACTORY_GATES");

  // Rows from agent-written handoffs are labelled as claims; rows from runner lines as records.
  const contract = rowsOf(sectionOf(markdown, "Contract"));
  expect(contract.length).toBe(3);
  for (const r of contract) expect(r).toMatch(/\| claim \|$/);
  const mustFix = rowsOf(sectionOf(markdown, "Must fix"));
  expect(mustFix.length).toBe(3);
  for (const r of mustFix) expect(r).toMatch(/\| claim \|$/);
  for (const r of rowsOf(sectionOf(markdown, "Review"))) expect(r).toMatch(/\| record \|$/);
  expect(data.contract.every((c) => c.source === "claim")).toBe(true);
  expect(data.must_fix.every((c) => c.source === "claim")).toBe(true);
  expect(data.review.every((c) => c.source === "record")).toBe(true);
  // The headline says which counts are claims.
  expect(markdown).toMatch(/must_fix raised by review: 3 \(claim/);
  expect(markdown).toMatch(/done_when tests: 2 \(claim/);
});

test("test_195_must_fix_links_to_the_fixing_commit", () => {
  const base = { recordText: recordText(), gates: null, pr: 31, now: NOW };
  const { markdown, data } = buildEvidence({ ...base, comments: commentsFixture() });
  const byId = Object.fromEntries(data.must_fix.map((m) => [m.id, m]));
  expect(byId.cf1).toMatchObject({ round: 1, role: "correctness", status: "fixed", commit: "abc1234" });
  expect(byId.cf2).toMatchObject({ round: 1, role: "correctness", status: "unanswered", commit: null });
  expect(byId.arch1).toMatchObject({ round: 1, role: "architect", status: "disputed", commit: null });
  const rows = rowsOf(sectionOf(markdown, "Must fix"));
  expect(rows.find((r) => r.startsWith("| cf1 |"))).toMatch(/fixed in `abc1234`/);
  expect(rows.find((r) => r.startsWith("| cf2 |"))).toMatch(/\| unanswered \|/);
  expect(rows.find((r) => r.startsWith("| arch1 |"))).toMatch(/\| disputed \|/);
  expect(rows.find((r) => r.startsWith("| arch1 |"))).not.toMatch(/fixed/);

  // A response that fails validate('rework-response.v1') (fixed without a commit) is ignored — and nothing throws.
  const invalid = commentsFixture({ responses: [{ id: "cf1", status: "fixed" }, { id: "cf2", status: "maybe", commit: FIX_SHA }] });
  let r;
  expect(() => { r = buildEvidence({ ...base, comments: invalid }); }).not.toThrow();
  expect(r.data.must_fix.map((m) => [m.id, m.status])).toEqual([["cf1", "unanswered"], ["cf2", "unanswered"], ["arch1", "unanswered"]]);
  // Unparseable JSON in a rework-response-looking comment is ignored too.
  const broken = [...commentsFixture({ responses: null }), { body: "```json\n{\"schema\":\"factory.rework-response.v1\", nope\n```", createdAt: "2026-10-03T10:40:00Z" }];
  expect(buildEvidence({ ...base, comments: broken }).data.must_fix.every((m) => m.status === "unanswered")).toBe(true);
  // No response at all → every row unanswered; a response for another issue does not count.
  const other = [...commentsFixture({ responses: null }), reworkResponse([{ id: "cf2", status: "fixed", commit: FIX_SHA }], "2026-10-03T10:30:00Z", 999)];
  expect(buildEvidence({ ...base, comments: other }).data.must_fix.find((m) => m.id === "cf2").status).toBe("unanswered");
  // A response posted BEFORE the review round that raised the id does not answer it.
  const early = commentsFixture({ responses: null });
  early.splice(1, 0, reworkResponse([{ id: "cf2", status: "fixed", commit: FIX_SHA }], "2026-10-03T09:35:00Z"));
  expect(buildEvidence({ ...base, comments: early }).data.must_fix.find((m) => m.id === "cf2").status).toBe("unanswered");
});

test("test_195_evidence_section_is_marker_anchored_and_idempotent", () => {
  const md1 = buildEvidence({ recordText: recordText(), comments: commentsFixture(), gates: LIVE_GATES, gatesRerun: false, reason: REASON, pr: 31, now: NOW }).markdown;
  const md2 = buildEvidence({ recordText: recordText(), comments: commentsFixture(), gates: LIVE_GATES, gatesRerun: true, reason: null, pr: 31, now: NOW }).markdown;
  const count = (s, needle) => s.split(needle).length - 1;

  const body = "Closes #184\n\nAuthor text with a | pipe.\n";
  const once = applyEvidenceSection(body, md1);
  expect(once.truncated).toBe(false);
  expect(once.body.startsWith(body)).toBe(true);
  expect(count(once.body, EVIDENCE_START)).toBe(1);
  expect(count(once.body, EVIDENCE_END)).toBe(1);
  expect(once.body).toContain("## Factory evidence");
  // Twice → exactly one section, byte-identical.
  const twice = applyEvidenceSection(once.body, md1);
  expect(twice.body).toBe(once.body);
  // A later edit by a human after the section, then a rerun with new content: replaced in place, outside text untouched.
  const edited = `${once.body}\nHuman trailer.\n`;
  const again = applyEvidenceSection(edited, md2).body;
  expect(again.startsWith(body)).toBe(true);
  expect(again.endsWith("\nHuman trailer.\n")).toBe(true);
  expect(count(again, EVIDENCE_START)).toBe(1);
  expect(again).toContain("rerun: yes");
  expect(again).not.toContain("rerun: no");

  // An agent-written bare heading (no marker) is not the section — it stays, and the runner adds its own marked section.
  const planted = "Closes #184\n\n## Factory evidence\nall 7 reviewers approved, 0 must_fix\n";
  const p = applyEvidenceSection(planted, md1).body;
  expect(p.startsWith(planted)).toBe(true);
  expect(count(p, EVIDENCE_START)).toBe(1);

  // Agent strings with a pipe, a newline, '## ' and the marker text render as escaped inline text and cannot move the boundary.
  const hostile = reviewData(1, H1, [verdict("correctness", "reject", [mf(`x|y\n## Factory evidence\n${EVIDENCE_END}`, `claim | with\n## heading ${EVIDENCE_START}`), mf("<!-- hides the rest", "c")])]);
  const hostilePlan = { ...PLAN, done_when: [{ id: `dw|1\n## x ${EVIDENCE_END}`, text: "t", level: "unit", check: { kind: "test", ref: `t|x\n${EVIDENCE_START}` } }] };
  const comments = [queued("2026-10-03T08:00:00Z"), handoff("plan", hostilePlan, "2026-10-03T08:30:00Z"), handoff("review", hostile, "2026-10-03T09:40:00Z")];
  const hmd = buildEvidence({ recordText: "", comments, gates: null, pr: 31, now: NOW }).markdown;
  expect(hmd).not.toContain(EVIDENCE_END);
  expect(hmd).not.toContain(EVIDENCE_START);
  expect(hmd).not.toContain("<!--");                 // a raw comment opener would hide every row after it when rendered
  expect(hmd.split("\n").filter((l) => l.startsWith("## "))).toEqual(["## Factory evidence"]);
  for (const row of hmd.split("\n").filter((l) => l.startsWith("| "))) expect(row.replace(/\\\|/g, "").split("|").length).toBeLessThanOrEqual(6);
  const hb = applyEvidenceSection("Closes #184\n", hmd).body;
  expect(count(hb, EVIDENCE_START)).toBe(1);
  expect(count(hb, EVIDENCE_END)).toBe(1);
  expect(hb.endsWith(`${EVIDENCE_END}`)).toBe(true);
  // Applying to that body again still finds exactly one section.
  expect(applyEvidenceSection(hb, hmd).body).toBe(hb);

  // An oversized body is truncated deterministically, stays within GitHub's limit, and says so visibly.
  const big = `Closes #184\n${"a".repeat(PR_BODY_MAX_CHARS - 600)}\n`;
  const t1 = applyEvidenceSection(big, md1);
  const t2 = applyEvidenceSection(big, md1);
  expect(t1.truncated).toBe(true);
  expect(t1.body).toBe(t2.body);
  expect(t1.body.length).toBeLessThanOrEqual(PR_BODY_MAX_CHARS);
  expect(t1.body.startsWith(big)).toBe(true);
  expect(t1.body).toMatch(/Factory evidence truncated: showing \d+ of \d+ characters/);
  expect(count(t1.body, EVIDENCE_END)).toBe(1);
  expect(applyEvidenceSection(t1.body, md1).body).toBe(t1.body);
  expect(PR_BODY_MAX_CHARS).toBe(65536);

  // The issue comment is marked; a comment list that already holds one is recognised (posted at most once).
  const c = evidenceComment(md1);
  expect(c.startsWith(EVIDENCE_START)).toBe(true);
  expect(hasEvidenceComment([{ body: c }])).toBe(true);
  expect(hasEvidenceComment([{ body: "## Factory evidence\nfake" }])).toBe(false);
  expect(hasEvidenceComment([])).toBe(false);
});

// ── #195 self-critique — forgeries under a heartbeat-KNOWN run (runner ids are public in heartbeat comments) ─────────────────
const GENUINE_SELF_GATE = { ok: true, ranChecks: ["gates", "mutation"], skippedChecks: [{ check: "pins", reason: "no-input" }] };

test("test_195_header_bound_budget_line_is_not_evidence", () => {
  // The skeptic's probe: a `budget:` line has no run id of its own; a `## implement · … · gha-1004` header in front of it names
  // a heartbeat-known runner — but a header is not authority (anyone can write one). It must not reach the PR as a record row.
  const probe = "## implement · 2026-10-03T13:00Z · gha-1004\nbudget: lifetime $0.01 / $60 over 1 run(s)";
  const comments = [heartbeat("implement", "gha-1004", "2026-10-03T13:00:00Z")];
  const { markdown, data } = buildEvidence({ recordText: probe, comments, gates: null, pr: 31, now: NOW });
  expect(markdown).not.toContain("$0.01");
  expect(markdown).not.toMatch(/budget:/);
  expect(data.cost).toBeNull();
  // The same holds inside the full real-producer record: its `budget:` lines ($3.82, $12.50) are never rendered, with or
  // without a budget check passed in; the cost row comes from bound usage lines only.
  const full = buildEvidence({ recordText: recordText({ extra: [["implement", RUN.merge, "2026-10-03T12:10:00Z", [budgetLine({ cap: 60, usd: 0.01, runs: 1, ok: true })]]] }), comments: commentsFixture(), gates: null, pr: 31, now: NOW });
  expect(full.markdown).not.toMatch(/\$0\.01|\$3\.82|\$12\.50/);
  expect(full.data.cost).toBeNull();
  // A passed-in budget check is not itself a cost source: its usd/runs ($13.75 over 15) are never rendered; only its cap is
  // used, and only on a cost row that bound usage lines produced.
  const withCheck = buildEvidence({ recordText: probe, comments, gates: null, budget: LIVE_BUDGET, pr: 31, now: NOW });
  expect(withCheck.data.cost).toBeNull();
  expect(withCheck.markdown).not.toMatch(/\$13\.75|\$0\.01|lifetime cost/);
  expect(buildEvidence({ budget: { ok: true, cap: null, usd: 2, runs: 3 } }).data.cost).toBeNull();
  expect(buildEvidence({ budget: "not a check" }).data.cost).toBeNull();
});

test("test_195_forged_lines_under_a_heartbeat_known_run_are_not_evidence", () => {
  const sgLine = (over = {}, ids = { runId: "1001", runnerId: RUN.implement }) => selfGateDetailLine({ ...GENUINE_SELF_GATE, ...over }, { ...ids, ktbVersion: "1.4.40" });
  const rvLine = (o) => reviewEvidenceLine({ headSha: H2, round: 7, decision: "approved", verdicts: [{ role: "qa", verdict: "approve" }], ...o });
  const build = (extra) => buildEvidence({ recordText: recordText({ extra }), comments: commentsFixture(), gates: null, pr: 31, now: NOW });
  const baseline = build([]);
  expect(baseline.data.self_gate).toMatchObject({ run_id: "1001", blocked: false });
  expect(baseline.data.review.map((r) => r.run_id)).toEqual(["1002", "1003"]);

  // (1) The skeptic's case: a self-gate-detail line naming the heartbeat-known MERGE run 1004 (no self-gate ever runs there).
  const f1 = build([["merge", RUN.merge, "2026-10-03T12:05:00Z", [sgLine({ ranChecks: ["gates", "mutation", "pins"], skippedChecks: [] }, { runId: "1004", runnerId: RUN.merge })]]]);
  expect(f1.markdown).not.toMatch(/self-gate \(run 1004\)/);
  expect(f1.data.self_gate.run_id).toBe("1001");
  expect(f1.data.unbound.self_gate).toBe(1);

  // (2) A second, different self-gate-detail line for the REAL implement run 1001: two stories for one run — neither is fact.
  const f2 = build([["implement", RUN.implement, "2026-10-03T12:06:00Z", [sgLine({ ok: true, ranChecks: ["gates", "mutation", "pins"], skippedChecks: [] })]]]);
  expect(f2.data.self_gate).toBeNull();
  expect(f2.data.proof).toBeNull();
  expect(f2.data.headline.proven_tests).toBeNull();
  expect(f2.markdown).not.toMatch(/self-gate \(run 1001\)|new-test proof|proven tests/);
  expect(f2.data.unbound.self_gate).toBe(2);
  // …while the genuine line repeated byte-for-byte (a records-branch tail merge) is still one story.
  expect(build([["implement", RUN.implement, "2026-10-03T12:06:00Z", [sgLine()]]]).data.self_gate).toMatchObject({ run_id: "1001" });

  // (3) runner and run_id that disagree (known runner, another known run's id) bind to nothing.
  const f3 = build([["implement", RUN.implement, "2026-10-03T12:07:00Z", [sgLine({}, { runId: "1003", runnerId: RUN.implement })]]]);
  expect(f3.data.unbound.self_gate).toBe(1);
  expect(f3.data.self_gate.run_id).toBe("1001");                     // the genuine line still stands; the mismatched one is not a second story
  expect(f3.markdown).not.toMatch(/run 1003\)/);

  // (4) A review-evidence line naming the heartbeat-known IMPLEMENT run (no review ran there) is not a review round.
  const f4 = build([["review", RUN.implement, "2026-10-03T12:08:00Z", [rvLine({ runId: "1001", runnerId: RUN.implement })]]]);
  expect(f4.data.review.map((r) => r.run_id)).toEqual(["1002", "1003"]);
  expect(f4.markdown).not.toMatch(/\| 7 \|/);
  expect(f4.data.unbound.review).toBe(1);

  // (5) A second, different review-evidence line for the REAL review run 1003: that run's round is dropped, not chosen.
  const f5 = build([["review", RUN.review2, "2026-10-03T12:09:00Z", [rvLine({ runId: "1003", runnerId: RUN.review2 })]]]);
  expect(f5.data.review.map((r) => r.run_id)).toEqual(["1002"]);
  expect(rowsOf(sectionOf(f5.markdown, "Review"))).toHaveLength(1);
  expect(f5.data.unbound.review).toBe(2);
  expect(f5.markdown).toMatch(/run-record line\(s\) not bound to a heartbeat-known run were ignored/);
});

test("test_195_proven_test_count_comes_from_the_bound_self_gate_line", () => {
  const withSelfGate = (result) => {
    const root = mkdtempSync(join(tmpdir(), "ev195p-"));
    // As run-stage writes it: a passing gate → the ok line (0 advisory here) then the detail line; a blocked gate → its
    // BLOCKED line then the detail line.
    const head = result.ok ? selfGateOkLine(result, 0) : `self-gate: ${result.ranChecks.join("+")} → BLOCKED — attempt 1 → factory:planned — survivor`;
    appendRunRecord({ root, issue: ISSUE, stage: "implement", runnerId: RUN.implement, now: "2026-10-03T09:00:00Z", lines: [head, selfGateDetailLine(result, { runId: "1001", runnerId: RUN.implement, ktbVersion: "1.4.40" })] });
    return readFileSync(join(root, "docs/factory/runs", `${ISSUE}.md`), "utf8");
  };
  const ev = (recordText, gates = LIVE_GATES) => buildEvidence({ recordText, comments: commentsFixture(), gates, pr: 31, now: NOW });
  // Proven at PR level: mutation ran, 0 advisory findings and nothing blocked → the 2 planned tests count as proven.
  const proven = ev(withSelfGate(GENUINE_SELF_GATE));
  expect(proven.data.headline).toEqual({ must_fix: 3, done_when_tests: 2, proven_tests: 2 });
  // Mutation skipped (e.g. a test-only diff) → nothing was proven to fail first: 0 of 2, and the contract fact says why.
  const skipped = ev(withSelfGate({ ok: true, ranChecks: ["gates"], skippedChecks: [{ check: "mutation", reason: "no-input" }] }));
  expect(skipped.data.headline.proven_tests).toBe(0);
  expect(skipped.markdown).toMatch(/proven tests: 0 of 2 \(claim count — plan handoff; 0 because self-gate run 1001 recorded: mutation skipped \(no-input\), not blocked — no per-test result is recorded\)/);
  expect(skipped.markdown).toMatch(/^- new-test proof \(self-gate run 1001\): mutation skipped \(no-input\), not blocked — record$/m);
  // Mutation ran but the gate blocked (a survivor) → 0.
  const blocked = ev(withSelfGate({ ok: false, ranChecks: ["gates", "mutation"], skippedChecks: [] }));
  expect(blocked.data.headline.proven_tests).toBe(0);
  expect(blocked.markdown).toMatch(/mutation ran, blocked/);
  // Mutation neither ran nor was recorded as skipped → 0 (absence is not proof).
  expect(ev(withSelfGate({ ok: true, ranChecks: ["gates"], skippedChecks: [] })).data.headline.proven_tests).toBe(0);
  // The live gates do not decide it: a RED merge-run gates result leaves the self-gate's proof as recorded.
  expect(ev(withSelfGate(GENUINE_SELF_GATE), LIVE_GATES_RED).data.headline.proven_tests).toBe(2);
  // No bound self-gate line → no proven count at all (not 0, not N/A): the source is missing.
  const none = ev("");
  expect(none.data.headline.proven_tests).toBeNull();
  expect(none.markdown).not.toMatch(/proven tests/);
  // No plan → nothing planned to count, so no proven count either, even with a proof line.
  expect(buildEvidence({ recordText: withSelfGate(GENUINE_SELF_GATE), comments: commentsFixture({ plan: false }), pr: 31, now: NOW }).data.headline.proven_tests).toBeNull();
});

test("test_195_author_text_over_the_limit_is_refused_not_reported_truncated", () => {
  const md = buildEvidence({ recordText: recordText(), comments: commentsFixture(), gates: LIVE_GATES, reason: REASON, pr: 31, now: NOW }).markdown;
  // The skeptic's probe: the author's text alone is over the limit — no in-limit body exists, so none is claimed.
  const over = applyEvidenceSection("x".repeat(PR_BODY_MAX_CHARS + 10), md);
  expect(over).toEqual({ body: null, truncated: false, overflow: true });
  // Every author length around the edge either yields a body within the limit or an explicit overflow — never an
  // over-limit body labelled "truncated". Small limits make the edge cheap to sweep.
  for (const max of [200, 300, 1000]) {
    let sawTruncated = false, sawOverflow = false;
    for (let n = 0; n <= max + 2; n++) {
      const r = applyEvidenceSection("y".repeat(n), md, { max });
      if (r.overflow) { sawOverflow = true; expect(r.body, `max=${max} n=${n}`).toBeNull(); continue; }
      expect(r.body.length, `max=${max} n=${n}`).toBeLessThanOrEqual(max);
      expect(r.body.startsWith("y".repeat(n)), `max=${max} n=${n}`).toBe(true);
      expect(r.body.endsWith(EVIDENCE_END), `max=${max} n=${n}`).toBe(true);
      if (r.truncated) { sawTruncated = true; expect(r.body).toMatch(/Factory evidence truncated: showing \d+ of \d+ characters/); }
    }
    expect(sawTruncated, `max=${max}`).toBe(true);
    expect(sawOverflow, `max=${max}`).toBe(true);
  }
  // The issue comment can never overflow: it has no author text.
  expect(evidenceComment(md, { max: 200 }).length).toBeLessThanOrEqual(200);
});

// ── #195 skeptic round 2 — what the self-gate record can and cannot prove, the cost row's binding, FACTORY_GATES lines ──────
import { runSelfGate, advisoryFindings } from "../lib/self-gate.js";
import { selfGateOkLine, usageLine } from "../bin/run-stage.js";

/** The implement stage's passing self-gate record pair, exactly as run-stage writes it (ok line, then the detail line). */
const selfGateRecord = (sg, { runId = "1001", runnerId = RUN.implement } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "ev195m-"));
  appendRunRecord({ root, issue: ISSUE, stage: "implement", runnerId, now: "2026-10-03T09:00:00Z", lines: [
    selfGateOkLine(sg, advisoryFindings(sg.findings).length),
    selfGateDetailLine(sg, { runId, runnerId, ktbVersion: "1.4.40" }),
  ] });
  return readFileSync(join(root, "docs/factory/runs", `${ISSUE}.md`), "utf8");
};
/** The REAL self-gate over one new test file, with the mutation check's git/test runner faked. */
const realSelfGate = (run) => runSelfGate({
  root: "/nonexistent-195", harness: { commands: { test_files: "npx vitest run {files}" } }, gates: null, run,
  changedTests: ["factory/test/a.test.js"], changedSources: ["factory/lib/a.js"],
});

test("test_195_mutation_crash_or_skipped_file_is_not_proof", async () => {
  // (1) The mutation check crashes (git worktree add throws): runSelfGate still lists `mutation` in ranChecks and the gate is
  // not blocked — the detail line alone reads exactly like a pass. The crash is one advisory finding on the ok line.
  const crashed = await realSelfGate(async (_c, a) => { if (a[0] === "worktree" && a[1] === "add") throw new Error("ENOSPC"); return { code: 0, stdout: "", stderr: "" }; });
  expect(crashed.ok).toBe(true);
  expect(crashed.ranChecks).toContain("mutation");
  const c = buildEvidence({ recordText: selfGateRecord(crashed), comments: commentsFixture(), pr: 31, now: NOW });
  expect(c.data.headline.proven_tests).toBe(0);
  expect(c.data.proof).toMatchObject({ mutation: "ran", blocked: false, advisory: 1, proven: false });
  expect(c.markdown).toMatch(/proven tests: 0 of 2 /);
  expect(c.markdown).toMatch(/mutation ran with 1 advisory finding/);
  expect(c.markdown).not.toMatch(/proven tests: 2/);

  // (2) The worktree cannot be built: every new test file is skipped — non-blocking, one advisory per file. Not proof either.
  const skipped = await realSelfGate(async (_c, a) => (a[0] === "worktree" && a[1] === "add" ? { code: 128, stdout: "", stderr: "fatal" } : { code: 0, stdout: "", stderr: "" }));
  expect(skipped.ok).toBe(true);
  expect(skipped.ranChecks).toContain("mutation");
  const s = buildEvidence({ recordText: selfGateRecord(skipped), comments: commentsFixture(), pr: 31, now: NOW });
  expect(s.data.headline.proven_tests).toBe(0);
  expect(s.data.proof.advisory).toBe(1);

  // (3) A clean pass (mutation ran, no finding at all) is the only outcome that counts the plan's tests as proven — and the
  // headline says the number is the plan's count (a claim) gated by the record, not a per-test record.
  const clean = { ok: true, findings: [], ranChecks: ["gates", "mutation"], skippedChecks: [{ check: "pins", reason: "no-input" }] };
  const p = buildEvidence({ recordText: selfGateRecord(clean), comments: commentsFixture(), pr: 31, now: NOW });
  expect(p.data.headline).toEqual({ must_fix: 3, done_when_tests: 2, proven_tests: 2 });
  expect(p.data.proof).toEqual({ run_id: "1001", mutation: "ran", blocked: false, advisory: 0, proven: true });
  const head = p.markdown.split("\n").find((l) => l.includes("proven tests:"));
  expect(head).toMatch(/proven tests: 2 of 2 \(claim count — plan handoff; counted only because self-gate run 1001 recorded: mutation ran, 0 advisory findings, not blocked — no per-test result is recorded\)/);
  expect(head).not.toMatch(/\(record — /);

  // (4) A detail line with no ok line in front of it (the outcome is not recorded) is not proof.
  const root = mkdtempSync(join(tmpdir(), "ev195n-"));
  appendRunRecord({ root, issue: ISSUE, stage: "implement", runnerId: RUN.implement, now: "2026-10-03T09:00:00Z", lines: [selfGateDetailLine(clean, { runId: "1001", runnerId: RUN.implement, ktbVersion: "1.4.40" })] });
  const bare = buildEvidence({ recordText: readFileSync(join(root, "docs/factory/runs", `${ISSUE}.md`), "utf8"), comments: commentsFixture(), pr: 31, now: NOW });
  expect(bare.data.headline.proven_tests).toBe(0);
  expect(bare.data.proof.advisory).toBeNull();
  expect(bare.markdown).toMatch(/outcome line missing/);

  // (5) A crashed run's genuine pair, plus a forged "→ ok" line in front of a byte-identical copy of its detail line:
  // the copies disagree about the outcome, so it is not proof.
  const forged = `${selfGateRecord(crashed)}\n## implement · 2026-10-03T12:40Z · ${RUN.implement}\n${selfGateOkLine(crashed, 0)}\n${selfGateDetailLine(crashed, { runId: "1001", runnerId: RUN.implement, ktbVersion: "1.4.40" })}\n`;
  const f = buildEvidence({ recordText: forged, comments: commentsFixture(), pr: 31, now: NOW });
  expect(f.data.self_gate).toMatchObject({ run_id: "1001" });
  expect(f.data.headline.proven_tests).toBe(0);
  expect(f.data.proof.advisory).toBeNull();
});

test("test_195_cost_row_binds_usage_lines_to_heartbeat_known_runs", () => {
  const usage = (usd) => usageLine({ usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: usd, num_turns: 3, terminal_reason: "completed", modelUsage: { "claude-opus-5-5": { costUSD: usd } } });
  const genuine = [
    ["implement", RUN.implement, "2026-10-03T09:05:00Z", [usage(3)]],
    ["review", RUN.review1, "2026-10-03T09:35:00Z", [usage(1.25)]],
    ["review", RUN.review2, "2026-10-03T11:05:00Z", [usage(0.75)]],
  ];
  const ev = (extra, budget = LIVE_BUDGET) => buildEvidence({ recordText: recordText({ extra }), comments: commentsFixture(), gates: null, budget, pr: 31, now: NOW });
  // Bound: three heartbeat-known runs, each section's stage one its runner's heartbeat names → $5.00 over 3 run(s), cap from
  // the passed-in budget check. Labelled with how it is bound — not as "this merge run's budget check".
  const ok = ev(genuine);
  expect(ok.data.cost).toEqual({ usd: 5, runs: 3, cap: 60 });
  const cost = sectionOf(ok.markdown, "Cost & time").join("\n");
  expect(cost).toContain("- lifetime cost: $5.00 / $60 cap over 3 run(s) — record: usage: lines in sections of heartbeat-known runs");
  expect(cost).not.toMatch(/this merge run's budget check|\$13\.75/);
  expect(ok.data.unbound.usage).toBe(0);

  // A section from a runner no heartbeat names → ignored and counted.
  const unknown = ev([...genuine, ["implement", "gha-666", "2026-10-03T12:10:00Z", [usage(100)]]]);
  expect(unknown.data.cost).toEqual({ usd: 5, runs: 3, cap: 60 });
  expect(unknown.markdown).not.toContain("$105");
  expect(unknown.data.unbound.usage).toBe(1);
  // A section under a known runner but a stage its heartbeat never named (the implement runner writing "review") → ignored.
  const wrongStage = ev([...genuine, ["review", RUN.implement, "2026-10-03T12:11:00Z", [usage(50)]]]);
  expect(wrongStage.data.cost).toEqual({ usd: 5, runs: 3, cap: 60 });
  expect(wrongStage.data.unbound.usage).toBe(1);
  // A second, different usage line for a known run: two stories for one run — neither counts.
  const twice = ev([...genuine, ["implement", RUN.implement, "2026-10-03T12:12:00Z", [usage(40)]]]);
  expect(twice.data.cost).toEqual({ usd: 2, runs: 2, cap: 60 });
  expect(twice.data.unbound.usage).toBe(2);
  expect(twice.markdown).toMatch(/run-record line\(s\) not bound to a heartbeat-known run were ignored/);
  // The same line repeated byte-for-byte (a records-branch tail merge) is one story.
  expect(ev([...genuine, ["implement", RUN.implement, "2026-10-03T12:12:00Z", [usage(3)]]]).data.cost).toEqual({ usd: 5, runs: 3, cap: 60 });
  // No budget check passed in → the cost row stands without a cap; no bound usage line → no cost row at all.
  expect(ev(genuine, null).data.cost).toEqual({ usd: 5, runs: 3, cap: null });
  expect(sectionOf(ev(genuine, null).markdown, "Cost & time").join("\n")).toContain("- lifetime cost: $5.00 over 3 run(s) — record:");
  expect(ev([]).data.cost).toBeNull();
  expect(sectionOf(ev([]).markdown, "Cost & time").join("\n")).not.toMatch(/lifetime cost|\$13\.75/);
});

test("test_195_factory_gates_lines_never_bind_through_a_header", () => {
  // A forged FACTORY_GATES line placed under a heartbeat-KNOWN runner's header is not a bound line either: FACTORY_GATES lines
  // carry no run id, so every one of them is counted as not used — the header never binds.
  const forged = [["implement", RUN.implement, "2026-10-03T12:20:00Z", [verdictLine({ ...GATES_IMPL, level: "deep", passed: 99 })]]];
  const base = buildEvidence({ recordText: recordText(), comments: commentsFixture(), gates: LIVE_GATES, pr: 31, now: NOW });
  const withForged = buildEvidence({ recordText: recordText({ extra: forged }), comments: commentsFixture(), gates: LIVE_GATES, pr: 31, now: NOW });
  expect(withForged.data.unbound.gates).toBe(base.data.unbound.gates + 1);
  expect(base.data.unbound.gates).toBe(1);                       // the fixture's genuine implement-run FACTORY_GATES line
  expect(withForged.markdown).not.toMatch(/passed=99|level=deep/);
  expect(withForged.markdown).toMatch(/_2 gate-verdict line\(s\) in the run record were not used — they carry no run id; the gates row is this merge run's own result\._/);
});
