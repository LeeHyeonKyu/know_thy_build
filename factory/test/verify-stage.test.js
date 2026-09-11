import { test, expect } from "vitest";
import { verifyStage, extractJson } from "../lib/verify-stage.js";

const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: "a".repeat(40), round: 1, orchestration: "workflow", guarantee: "verified",
  verdicts: [{ role: "correctness", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] }, { role: "qa", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] }] };
const out = (obj, extra = {}) => ({ is_error: false, result: "The workflow returned:\n```json\n" + JSON.stringify(obj) + "\n```", ...extra });
const log = (types) => ({ starts: [], stops: [], completed: types, orphans: [] });

test("passes when result parses, schema ok, roster covered, orchestration matches", () => {
  const r = verifyStage({ stage: "review", out: out(review), agentsLog: log(["reviewer-correctness", "reviewer-qa", "reviewer-correctness"]), roster: ["correctness", "qa"], rolePrefix: "reviewer-", orchestration: "workflow" });
  expect(r.ok).toBe(true);
  expect(r.data.verdicts).toHaveLength(2);
});

test("fails: is_error, no json in result, schema invalid", () => {
  expect(verifyStage({ stage: "review", out: { is_error: true, result: "x" }, agentsLog: log([]), roster: [], orchestration: "workflow" }).reasons).toContain("claude -p reported is_error");
  expect(verifyStage({ stage: "review", out: { is_error: false, result: "no json here" }, agentsLog: log([]), roster: [], orchestration: "workflow" }).reasons.join()).toMatch(/no JSON object in result/);
  expect(verifyStage({ stage: "review", out: out({ ...review, verdicts: [] }), agentsLog: log([]), roster: [], orchestration: "workflow" }).reasons.join()).toMatch(/schema/);
});

test("fails: roster role never completed; orchestration mismatch", () => {
  const r = verifyStage({ stage: "review", out: out(review), agentsLog: log(["reviewer-correctness"]), roster: ["correctness", "qa"], rolePrefix: "reviewer-", orchestration: "workflow" });
  expect(r.ok).toBe(false);
  expect(r.reasons.join()).toMatch(/roster role not completed: qa/);
  const r2 = verifyStage({ stage: "review", out: out(review), agentsLog: log(["reviewer-correctness", "reviewer-qa"]), roster: ["correctness", "qa"], rolePrefix: "reviewer-", orchestration: "agent" });
  expect(r2.reasons.join()).toMatch(/orchestration/);
});

test("plan checks rounds", () => {
  const plan = { schema: "factory.plan.v1", issue: 7, tier: "docs", roles: ["architect", "skeptic"], rounds: 2, done_when: [{ id: "d", text: "t", verify: "v", level: "unit" }], files_expected: [], dissent_log: [], non_goals: [], open_risks: [], orchestration: "workflow" };
  const ok = verifyStage({ stage: "plan", out: out(plan), agentsLog: log(["plan-architect", "plan-skeptic", "plan-synthesizer"]), roster: ["architect", "skeptic"], rolePrefix: "plan-", expectedRounds: 2, orchestration: "workflow" });
  expect(ok.ok).toBe(true);
  const bad = verifyStage({ stage: "plan", out: out({ ...plan, rounds: 3 }), agentsLog: log(["plan-architect", "plan-skeptic"]), roster: ["architect", "skeptic"], rolePrefix: "plan-", expectedRounds: 2, orchestration: "workflow" });
  expect(bad.reasons.join()).toMatch(/rounds/);
});

test("extractJson tolerates braces inside strings and invalid fences", () => {
  const obj = { schema: "x", note: "has a stray } and { inside", ok: true };
  expect(extractJson("prefix text " + JSON.stringify(obj) + " suffix")).toEqual(obj);
  expect(extractJson("```json\n{not json\n```\nlater: " + JSON.stringify({ a: 1 }))).toEqual({ a: 1 });
  expect(extractJson("no objects here")).toBe(null);
  expect(extractJson('{"esc":"quote \\" brace }"}')).toEqual({ esc: 'quote " brace }' });
});
