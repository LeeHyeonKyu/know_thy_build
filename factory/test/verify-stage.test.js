import { test, expect } from "vitest";
import { verifyStage, hitApiError, apiErrorReason } from "../lib/verify-stage.js";

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

// 최종 리뷰 nit 3 — `extractJson`/`matchBrace`는 KTB-7 이후 프로덕션 호출자가 없는 죽은 사본이었다
// (정본은 `lib/stage-artifact.js`). 이 테스트가 그 사본을 살려 두는 유일한 이유였으므로 함께 지운다 —
// 같은 계약은 `stage-artifact.test.js`가 정본에 대고 고정한다.
test("the brace scanner lives only in stage-artifact.js — verify-stage re-exports nothing (nit 3)", async () => {
  const m = await import("../lib/verify-stage.js");
  expect(m.extractJson).toBeUndefined();
  expect(m.fencedJsonError).toBeUndefined();
});

// ── KTB-7(재리뷰): 트랜스크립트가 붙은 end-to-end 한 건 ────────────────────
// `run-stage.js`·`bin/verify-stage.js`가 실제로 넘기는 모양 그대로 — 봉투는 디스패처가 요약해
// 망가뜨렸고(펜스가 유효한 JSON이 아니다) 산출물은 트랜스크립트의 `Workflow` tool_result에만 있다.

test("end-to-end: a broken fence in the envelope is rescued by transcriptText, and the source is named", () => {
  const transcript = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Workflow", id: "tu1" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: JSON.stringify(review) }] } }),
  ].join("\n");
  const broken = { is_error: false, result: '```json\n{ "verdicts": [ /* 전체 생략 */ ] }\n```' };
  const args = { stage: "review", out: broken, agentsLog: log(["reviewer-correctness", "reviewer-qa"]), roster: ["correctness", "qa"], rolePrefix: "reviewer-", orchestration: "workflow", gates: { status: "GREEN", level: "full" } };

  const without = verifyStage(args);
  expect(without.ok).toBe(false);
  expect(without.reasons.join(" ")).toMatch(/fence is not valid JSON/);

  const with_ = verifyStage({ ...args, transcriptText: transcript });
  expect(with_.ok).toBe(true);
  expect(with_.data.verdicts).toHaveLength(2);
  // KTB-15b M1: verifyStage surfaces which candidate won — provenance for post-hoc audit.
  expect(with_.source).toMatch(/transcript tool result/);
});

// ── KTB-15b M1: verifyStage forwards extractStageArtifact's `source` (provenance) ──────────────
test("verifyStage returns source on success, and null when nothing verified (no artifact to name)", () => {
  const r = verifyStage({ stage: "review", out: out(review), agentsLog: log(["reviewer-correctness", "reviewer-qa"]), roster: ["correctness", "qa"], rolePrefix: "reviewer-", orchestration: "workflow", gates: { status: "GREEN", level: "full" } });
  expect(r.ok).toBe(true);
  expect(r.source).toMatch(/```json fence/);

  const fail = verifyStage({ stage: "review", out: { is_error: false, result: "no json here" }, agentsLog: log([]), roster: [], orchestration: "workflow" });
  expect(fail.ok).toBe(false);
  expect(fail.source).toBeNull();
});

// ── KTB-16: 턴 한도만은 다른 is_error다 ───────────────────────────────────
// 봉투는 실패라고 말하지만 백그라운드 워크플로는 이미 끝났고 산출물은 트랜스크립트 안에 있다 —
// 모자란 것은 디스패처가 그것을 **다시 출력할** 턴 하나뿐이었다(데모 #2: 30분·$12.05).

test("max_turns + a recovered artifact is a pass; max_turns without one names the turn limit, not 'no JSON object'", () => {
  const transcript = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Workflow", id: "tu1" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "Workflow launched in background. Task ID: abc" }] } }),
    JSON.stringify({ type: "user", message: { content: `<task-notification>\n<status>completed</status>\n<result>${JSON.stringify(review)}</result>\n</task-notification>` } }),
  ].join("\n");
  const cut = { is_error: true, subtype: "error_max_turns", terminal_reason: "max_turns", num_turns: 6, result: "I ran out of turns." };
  const args = { stage: "review", out: cut, agentsLog: log(["reviewer-correctness", "reviewer-qa"]), roster: ["correctness", "qa"], rolePrefix: "reviewer-", orchestration: "workflow", gates: { status: "GREEN", level: "full" } };

  const rescued = verifyStage({ ...args, transcriptText: transcript });
  expect(rescued.ok).toBe(true);
  expect(rescued.data.verdicts).toHaveLength(2);

  const receiptOnly = verifyStage({ ...args, transcriptText: transcript.split("\n").slice(0, 2).join("\n") });
  expect(receiptOnly.ok).toBe(false);
  expect(receiptOnly.reasons[0]).toBe("claude -p hit max turns (6)");
  expect(receiptOnly.reasons.join(" ")).not.toMatch(/reported is_error/);

  // 턴 한도가 아닌 is_error는 산출물을 복구해도 그대로 실패다 — 그 런은 실제로 무언가 터진 것이다.
  const other = verifyStage({ ...args, out: { ...cut, subtype: "error_during_execution", terminal_reason: "error" }, transcriptText: transcript });
  expect(other.ok).toBe(false);
  expect(other.reasons).toContain("claude -p reported is_error");
});

// ── KTB-22: API 쿼터/장애도 턴 한도와 같은 자리다 ──────────────────────────
// 2026-09-12 20:20Z 데모: claude -p 자신이 429(조직 월 지출 한도)로 죽었다 — 에이전트나 프롬프트의
// 잘못이 아니라 환경 조건이다. 산출물을 복구했으면 성공, 못 했으면 사유는 프로바이더 메시지 원문.

test("hitApiError: structural signals (terminal_reason, numeric 4xx/5xx status) fire on their own", () => {
  expect(hitApiError({ terminal_reason: "api_error" })).toBe(true);
  expect(hitApiError({ api_error_status: 429 })).toBe(true);
  expect(hitApiError({ api_error_status: 529 })).toBe(true);
  expect(hitApiError({ api_error_status: 500 })).toBe(true);
  expect(hitApiError({})).toBe(false);
  expect(hitApiError({ api_error_status: 200 })).toBe(false);
  expect(hitApiError({ api_error_status: "429" })).toBe(false);          // 문자열은 세지 않는다(오타 방지)
  expect(hitApiError(null)).toBe(false);
});

// ── KTB-22 r1: 자유 텍스트 폴백은 혼자 서지 못한다 — corroboration이 있어야 한다 ────────────────
// is_error===true AND trim한 result의 맨 앞에서 매치 AND (num_turns<=2 OR duration_ms<5000).
// 구조적 신호(terminal_reason/api_error_status)가 없을 때만 이 폴백이 관여한다.

test("hitApiError r1: a corroborated free-text result (is_error, anchored at start, few turns/fast) is an api error", () => {
  expect(hitApiError({ is_error: true, num_turns: 1, duration_ms: 299, result: "spend limit exceeded · ask your admin to raise it" })).toBe(true);
  expect(hitApiError({ is_error: true, num_turns: 2, result: "Overloaded, please retry" })).toBe(true);
  expect(hitApiError({ is_error: true, duration_ms: 4000, num_turns: 9, result: "429 Too Many Requests" })).toBe(true);
});

test("hitApiError r1: an error_during_execution envelope that merely mentions '429' mid-sentence is NOT an api error — falls to the generic is_error path", () => {
  const out = { is_error: true, subtype: "error_during_execution", terminal_reason: "error", num_turns: 6, result: "I implemented the retry handler so it will return 429 when throttled, then committed the change." };
  expect(hitApiError(out)).toBe(false);
});

test("hitApiError r1: 'rate limit' mentioned in the middle of a long result, with no structural signal, is NOT an api error", () => {
  const out = { is_error: true, num_turns: 1, duration_ms: 100, result: "After investigating the failure for a while, the root cause turned out to be a rate limit on an internal dependency, which we worked around." };
  expect(hitApiError(out)).toBe(false);
});

test("hitApiError r1: corroboration requires is_error===true — a success envelope that narrates a quota phrase is not an api error", () => {
  expect(hitApiError({ is_error: false, num_turns: 1, duration_ms: 100, result: "spend limit reached" })).toBe(false);
});

test("hitApiError r1: corroboration requires either few turns or a fast duration — neither present fails even when anchored and is_error", () => {
  expect(hitApiError({ is_error: true, num_turns: 6, duration_ms: 9000, result: "overloaded" })).toBe(false);
});

test("apiErrorReason: verbatim provider message, first line only, truncated to 200 chars", () => {
  const out = { api_error_status: 429, result: "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/admin-settings/usage · your session limit resets 8:30pm (UTC)" };
  expect(apiErrorReason(out)).toBe(`claude -p api error 429: ${out.result}`);
  const multiline = { api_error_status: 529, result: "overloaded\nsecond line ignored" };
  expect(apiErrorReason(multiline)).toBe("claude -p api error 529: overloaded");
  const long = { api_error_status: 429, result: "x".repeat(250) };
  expect(apiErrorReason(long)).toBe(`claude -p api error 429: ${"x".repeat(200)}`);
  expect(apiErrorReason({})).toBe("claude -p api error n/a: ");
});

test("KTB-22: a 429 quota envelope with no transcript recovery fails with the api-error reason, not 'no JSON object'", () => {
  const quota = { is_error: true, subtype: "success", terminal_reason: "api_error", api_error_status: 429, num_turns: 1, duration_ms: 299, result: "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/admin-settings/usage · your session limit resets 8:30pm (UTC)" };
  const r = verifyStage({ stage: "review", out: quota, agentsLog: log([]), roster: [], orchestration: "workflow" });
  expect(r.ok).toBe(false);
  expect(r.reasons[0]).toBe(`claude -p api error 429: ${quota.result}`);
  expect(r.reasons.join(" ")).not.toMatch(/reported is_error/);
});

test("KTB-22: a recovered artifact behind a quota envelope is a pass", () => {
  const transcript = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Workflow", id: "tu1" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "Workflow launched in background. Task ID: abc" }] } }),
    JSON.stringify({ type: "user", message: { content: `<task-notification>\n<status>completed</status>\n<result>${JSON.stringify(review)}</result>\n</task-notification>` } }),
  ].join("\n");
  const quota = { is_error: true, terminal_reason: "api_error", api_error_status: 429, num_turns: 1, result: "monthly spend limit" };
  const r = verifyStage({ stage: "review", out: quota, transcriptText: transcript, agentsLog: log(["reviewer-correctness", "reviewer-qa"]), roster: ["correctness", "qa"], rolePrefix: "reviewer-", orchestration: "workflow", gates: { status: "GREEN", level: "full" } });
  expect(r.ok).toBe(true);
  expect(r.data.verdicts).toHaveLength(2);
});

test("KTB-22 r1: an error_during_execution envelope that only mentions '429' mid-sentence is NOT an api error — falls to the generic is_error path (needs-human, not blocked)", () => {
  const out = { is_error: true, subtype: "error_during_execution", terminal_reason: "error", num_turns: 6, result: "I implemented the retry handler so it will return 429 when throttled, then committed the change." };
  const r = verifyStage({ stage: "review", out, agentsLog: log([]), roster: [], orchestration: "workflow" });
  expect(r.ok).toBe(false);
  expect(r.reasons).toContain("claude -p reported is_error");
});
