import { test, expect } from "vitest";
import { validate } from "../lib/schemas.js";

test("triage.v1", () => {
  expect(validate("triage.v1", { schema: "factory.triage.v1", issue: 1, disposition: "ready", tier: "standard" }).ok).toBe(true);
  const r = validate("triage.v1", { schema: "factory.triage.v1", issue: 1, disposition: "maybe" });
  expect(r.ok).toBe(false);
  expect(r.errors.join(" ")).toMatch(/disposition/);
  expect(r.errors.join(" ")).toMatch(/tier/);
  expect(validate("triage.v1", { schema: "factory.triage.v1", issue: 1, disposition: "wont-do" }).ok).toBe(true);
  expect(validate("triage.v1", { schema: "factory.triage.v1", issue: 1, disposition: "needs-info", questions: ["q"] }).ok).toBe(true);
});

test("plan.v1 requires done_when with id/text/level (verify optional), files_expected, dissent_log, roles, rounds", () => {
  const good = { schema: "factory.plan.v1", issue: 1, tier: "standard", roles: ["a", "b"], rounds: 3,
    done_when: [{ id: "dw1", text: "t", verify: "test_1_t", level: "unit" }], files_expected: ["src/x.ts"], dissent_log: [], non_goals: [], open_risks: [] };
  expect(validate("plan.v1", good).ok).toBe(true);
  // 리뷰 효율 Task 1: `verify`는 `check`로 일반화됐다 — 이제 선택 필드다. 필수는 id/text/level.
  const bad = { ...good, done_when: [{ id: "dw1", text: "t" }] };
  const r = validate("plan.v1", bad);
  expect(r.ok).toBe(false);
  expect(r.errors.join(" ")).toMatch(/done_when\[0\]\.level/);
  // verify 없이 check+rubric만 있어도 파싱된다 — 파서는 계약 완결을 게이트하지 않는다(verify-stage 검증기의 몫).
  expect(validate("plan.v1", { ...good, done_when: [{ id: "dw1", text: "t", level: "unit", check: { kind: "rubric", ref: "" }, rubric: "graded" }] }).ok).toBe(true);
  expect(validate("plan.v1", { ...good, done_when: [] }).ok).toBe(false);
});

/**
 * 리뷰 효율 Task 1 — done_when의 `check {kind, ref}`와 `rubric`은 **선택**이지만 모양은 검사한다:
 * `check.kind`는 test|gate|finish|rubric enum, `check.ref`·`rubric`은 문자열. 완결 요구는 verify-stage 검증기가 집행한다.
 */
test("plan.v1: done_when.check and rubric are optional but shape-checked", () => {
  const base = { schema: "factory.plan.v1", issue: 1, tier: "standard", roles: ["a", "b"], rounds: 2,
    files_expected: [], dissent_log: [], non_goals: [], open_risks: [] };
  const withContract = { ...base, done_when: [{ id: "dw1", text: "t", level: "unit", check: { kind: "test", ref: "test_1_t" }, rubric: "the reviewer confirms X" }] };
  expect(validate("plan.v1", withContract).ok).toBe(true);
  const badKind = { ...base, done_when: [{ id: "dw1", text: "t", level: "unit", check: { kind: "smell", ref: "x" } }] };
  expect(validate("plan.v1", badKind).errors.join(" ")).toMatch(/done_when\[0\]\.check\.kind must be one of/);
  const badRubric = { ...base, done_when: [{ id: "dw1", text: "t", level: "unit", verify: "test_1_t", rubric: 3 }] };
  expect(validate("plan.v1", badRubric).errors.join(" ")).toMatch(/done_when\[0\]\.rubric must be string/);
});

/**
 * 감사 Task 9: 핸드오프의 **모양**은 그대로다(다운스트림 스테이지는 한 글자도 바뀌지 않는다).
 * 새로 생긴 것은 선택 필드 둘 — done_when의 `covers`(그 항목이 막는 dissent id)와 dissent_log의
 * `id`/`severity`다. 있으면 모양을 검사하고, 없으면 예전 핸드오프 그대로 통과한다.
 * 두 필드를 **요구**하는 것은 스키마가 아니라 verify-stage의 plan 검증기다.
 */
test("plan.v1: done_when.covers and dissent_log id/severity are optional but shape-checked", () => {
  const good = { schema: "factory.plan.v1", issue: 1, tier: "standard", roles: ["a", "b"], rounds: 2,
    done_when: [{ id: "dw1", text: "t", verify: "test_1_t", level: "unit", covers: ["d1"] }], files_expected: [],
    dissent_log: [{ id: "d1", role: "skeptic", objection: "o", resolution: "r", severity: "high" }], non_goals: [], open_risks: [] };
  expect(validate("plan.v1", good).ok).toBe(true);

  const badCovers = { ...good, done_when: [{ ...good.done_when[0], covers: "d1" }] };
  expect(validate("plan.v1", badCovers).errors.join(" ")).toMatch(/done_when\[0\]\.covers must be array/);
  const badSeverity = { ...good, dissent_log: [{ ...good.dissent_log[0], severity: "catastrophic" }] };
  expect(validate("plan.v1", badSeverity).errors.join(" ")).toMatch(/dissent_log\[0\]\.severity must be one of/);
});

test("implement.v1 requires gates GREEN fields, head_sha, verifier verdict, pr", () => {
  const good = { schema: "factory.implement.v1", issue: 1, head_sha: "a".repeat(40), pr: 5, gates: { status: "GREEN", level: "full" },
    verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" };
  expect(validate("implement.v1", good).ok).toBe(true);
  expect(validate("implement.v1", { ...good, head_sha: "short" }).ok).toBe(false);
  expect(validate("implement.v1", { ...good, gates: { status: "RED" } }).ok).toBe(true); // 상태 값 자체는 허용, 판단은 requirements가 한다
});

test("review.v1 and verdict.v1", () => {
  const verdict = { verdict: "reject", confidence: "high", must_fix: [{ id: "cf1", where: "a.ts:1", claim: "c", evidence: "e" }], should_fix: [], verified: [] };
  expect(validate("verdict.v1", verdict).ok).toBe(true);
  expect(validate("verdict.v1", { ...verdict, must_fix: [] }).ok).toBe(false);          // reject엔 must_fix ≥1
  expect(validate("verdict.v1", { ...verdict, verdict: "approve", must_fix: [] }).ok).toBe(true);
  const review = { schema: "factory.review.v1", issue: 1, pr: 5, head_sha: "b".repeat(40), round: 1,
    verdicts: [{ role: "correctness", ...verdict }], orchestration: "workflow", guarantee: "verified" };
  expect(validate("review.v1", review).ok).toBe(true);
  expect(validate("review.v1", { ...review, verdicts: [] }).ok).toBe(false);
});

test("rework-response.v1", () => {
  const ok = { schema: "factory.rework-response.v1", issue: 1, responses: [{ id: "cf1", status: "fixed", commit: "abc" }, { id: "cf2", status: "disputed", reason: "out of scope" }] };
  expect(validate("rework-response.v1", ok).ok).toBe(true);
  expect(validate("rework-response.v1", { ...ok, responses: [{ id: "cf1", status: "fixed" }] }).ok).toBe(false);      // fixed엔 commit
  expect(validate("rework-response.v1", { ...ok, responses: [{ id: "cf2", status: "disputed" }] }).ok).toBe(false);   // disputed엔 reason
});

test("retro.v1: arrays may be empty, but a present item needs role/text/kind + evidence_runs≥1", () => {
  const empty = { period: { from: "2026-09-01", to: "2026-09-08" }, lessons: [], examples: [], perspectives: [], harness: [], proposals: [], summary: "no candidates cleared the evidence bar" };
  expect(validate("retro.v1", empty).ok).toBe(true);

  const full = {
    period: { from: "2026-09-01", to: "2026-09-08" },
    lessons: [{ role: "correctness", text: "Promise.all 부분 실패 처리 확인", evidence_runs: [110, 112] }],
    examples: [{ role: "reviewer-qa", kind: "good", text: "DST 경계 25시간 렌더링 발견", evidence_runs: [104] }],
    perspectives: [{ role: "architect", text: "동기 내보내기는 타임아웃이 난다", evidence_runs: [30, 42] }],
    harness: [{ target: "M1", reason: "prisma/schema.prisma가 있는데 M0" }],
    proposals: [{ kind: "gate", title: "no-multiple-resolved eslint rule", body: "L-2026-09-05-03 4회 인용", evidence_runs: [110, 112, 118, 121] }],
    summary: "제안 3건",
  };
  expect(validate("retro.v1", full).ok).toBe(true);

  const r1 = validate("retro.v1", { ...full, lessons: [{ role: "correctness", text: "x", evidence_runs: [] }] });
  expect(r1.ok).toBe(false);
  expect(r1.errors.join(" ")).toMatch(/lessons\[0\]\.evidence_runs/);

  const r2 = validate("retro.v1", { ...full, examples: [{ role: "reviewer-qa", kind: "meh", text: "x", evidence_runs: [1] }] });
  expect(r2.ok).toBe(false);
  expect(r2.errors.join(" ")).toMatch(/examples\[0\]\.kind/);

  const r3 = validate("retro.v1", { ...full, proposals: [{ kind: "nope", title: "t", body: "b", evidence_runs: [1] }] });
  expect(r3.ok).toBe(false);
  expect(r3.errors.join(" ")).toMatch(/proposals\[0\]\.kind/);

  const r4 = validate("retro.v1", { ...full, harness: [{ target: "M1" }] });
  expect(r4.ok).toBe(false);
  expect(r4.errors.join(" ")).toMatch(/harness\[0\]\.reason/);

  const r5 = validate("retro.v1", { ...full, period: undefined });
  expect(r5.ok).toBe(false);
  expect(r5.errors.join(" ")).toMatch(/^period is required/);
});

test("unknown schema name", () => {
  expect(() => validate("nope", {})).toThrow(/unknown schema/);
});
