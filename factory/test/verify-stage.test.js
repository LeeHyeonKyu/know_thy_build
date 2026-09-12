import { test, expect } from "vitest";
import { verifyStage, extractJson } from "../lib/verify-stage.js";

const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: "a".repeat(40), round: 1, orchestration: "workflow", guarantee: "verified",
  verdicts: [{ role: "correctness", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] }, { role: "qa", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] }] };
const out = (obj, extra = {}) => ({ is_error: false, result: "The workflow returned:\n```json\n" + JSON.stringify(obj) + "\n```", ...extra });
const log = (types) => ({ starts: [], stops: [], completed: types, orphans: [] });

test("passes when result parses, schema ok, roster covered, orchestration matches", () => {
  const r = verifyStage({ stage: "review", out: out(review), agentsLog: log(["reviewer-correctness", "reviewer-qa", "reviewer-correctness"]), roster: ["correctness", "qa"], rolePrefix: "reviewer-", orchestration: "workflow", gates: { status: "GREEN", level: "full" } });
  expect(r.ok).toBe(true);
  expect(r.data.verdicts).toHaveLength(2);
});

test("fails: is_error, no json in result, schema invalid", () => {
  expect(verifyStage({ stage: "review", out: { is_error: true, result: "x" }, agentsLog: log([]), roster: [], orchestration: "workflow" }).reasons).toContain("claude -p reported is_error");
  expect(verifyStage({ stage: "review", out: { is_error: false, result: "no json here" }, agentsLog: log([]), roster: [], orchestration: "workflow" }).reasons.join()).toMatch(/no JSON object in result/);
  expect(verifyStage({ stage: "review", out: out({ ...review, verdicts: [] }), agentsLog: log([]), roster: [], orchestration: "workflow" }).reasons.join()).toMatch(/schema/);
});

/**
 * 회귀(dogfood D3): plan 에이전트가 ```json 펜스 안에 JS 주석(`/* … *​/`)을 남겨 펜스가 깨지면
 * 균형 스캔 폴백이 계획 **안의** 중첩 객체(done_when 한 항목 등)를 집어 왔고, 검증 결과가
 * "issue is required; tier is required; …"로 나와 진짜 원인(펜스가 유효한 JSON이 아님)을 가렸다.
 * 펜스가 선언된 계약이므로, 펜스가 깨지면 폴백을 쓰지 않고 파싱 오류를 그대로 보고한다.
 */
test("fails with the fence parse error — not a misleading schema cascade — when ```json is present but invalid", () => {
  const broken = '```json\n{\n  "issue": 2,\n  "dissent_log": [ /* full R1 positions */ ],\n  "done_when": [{"id":"dw1","text":"t","verify":"unit","level":"fast"}]\n}\n```';
  const r = verifyStage({ stage: "plan", out: { is_error: false, result: broken }, agentsLog: log([]), roster: [], orchestration: "workflow" });
  expect(r.ok).toBe(false);
  const reason = r.reasons.join("; ");
  expect(reason).toMatch(/json fence is not valid JSON/);
  // 스키마 미달은 이제 **후보별 진단**으로만 나온다 — 헤드라인이 아니다.
  expect(reason.indexOf("fence is not valid JSON")).toBeLessThan(reason.indexOf("issue is required"));
  expect(reason).toMatch(/result bare JSON: issue is required/);
  expect(r.data).toBe(null);
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

test("implement/review/merge require a gates file; handoff gates must match the file", () => {
  const impl = { schema: "factory.implement.v1", issue: 7, head_sha: "a".repeat(40), pr: 9, gates: { status: "GREEN", level: "full" }, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" };
  const noFile = verifyStage({ stage: "implement", out: out(impl), agentsLog: log([]), roster: [], orchestration: "workflow", gates: null });
  expect(noFile.reasons).toContain("gates file missing");
  const mismatch = verifyStage({ stage: "implement", out: out(impl), agentsLog: log([]), roster: [], orchestration: "workflow", gates: { status: "RED", level: "full" } });
  expect(mismatch.reasons.join()).toMatch(/gates mismatch/);
  const filled = verifyStage({ stage: "implement", out: out({ ...impl, gates: undefined }), agentsLog: log([]), roster: [], orchestration: "workflow", gates: { status: "GREEN", level: "full" } });
  expect(filled.ok).toBe(true); expect(filled.data.gates).toEqual({ status: "GREEN", level: "full" });
});

test("MISCONFIGURED 사유는 어떤 게이트가 빠졌는지 말하고, 진단용 파일은 판정으로 인정하지 않는다", () => {
  const impl = { schema: "factory.implement.v1", issue: 7, head_sha: "a".repeat(40), pr: 9, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" };
  const mis = verifyStage({ stage: "implement", out: out(impl), agentsLog: log([]), roster: [], orchestration: "workflow", gates: { status: "MISCONFIGURED", level: "full", failing: [], misconfigured: ["mutation", "e2e"] } });
  expect(mis.reasons.join()).toMatch(/gates MISCONFIGURED: failing=none misconfigured=mutation,e2e/);
  const diag = verifyStage({ stage: "implement", out: out(impl), agentsLog: log([]), roster: [], orchestration: "workflow", gates: { status: "GREEN", level: "full", diagnostic: true } });
  expect(diag.ok).toBe(false);
  expect(diag.reasons.join()).toMatch(/diagnostic/);
});

test("extractJson tolerates braces inside strings and invalid fences", () => {
  const obj = { schema: "x", note: "has a stray } and { inside", ok: true };
  expect(extractJson("prefix text " + JSON.stringify(obj) + " suffix")).toEqual(obj);
  expect(extractJson("```json\n{not json\n```\nlater: " + JSON.stringify({ a: 1 }))).toEqual({ a: 1 });
  expect(extractJson("no objects here")).toBe(null);
  expect(extractJson('{"esc":"quote \\" brace }"}')).toEqual({ esc: 'quote " brace }' });
});
