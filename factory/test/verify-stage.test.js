import { test, expect } from "vitest";
import { verifyStage, hitApiError, apiErrorReason, deriveReworkPins } from "../lib/verify-stage.js";

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

/**
 * 감사 Task 9 — plan 검증기(P2, `docs/factory/dogfood/2026-09-14-plan-baseline.md`).
 * 세 규칙 전부 **스크립트 집행**이다: 산문 규칙은 #2에서 9라운드·$118을 막지 못했다.
 */
const planFix = (over = {}) => ({
  schema: "factory.plan.v1", issue: 7, tier: "standard", roles: ["synthesizer", "skeptic"], rounds: 2,
  done_when: [{ id: "dw1", text: "POST /notes returns 201 with the created id", verify: "test_7_create", level: "unit" }],
  files_expected: [], dissent_log: [], non_goals: [], open_risks: [], orchestration: "workflow", ...over,
});
const verifyPlan = (plan, extra = {}) => verifyStage({
  stage: "plan", out: out(plan), agentsLog: log(["plan-synthesizer", "plan-skeptic"]),
  roster: ["synthesizer", "skeptic"], rolePrefix: "plan-", expectedRounds: 2, orchestration: "workflow", ...extra,
});

test("plan validator: a medium-or-worse dissent no done_when covers is invalid", () => {
  const dissent = [{ id: "d1", role: "skeptic", severity: "high", objection: "npm start never touches pg", resolution: "unresolved — proceeding" }];
  const bad = verifyPlan(planFix({ dissent_log: dissent }));
  expect(bad.ok).toBe(false);
  expect(bad.reasons.join("; ")).toMatch(/dissent without done_when: d1/);

  const covered = verifyPlan(planFix({
    dissent_log: dissent,
    done_when: [{ id: "dw1", text: "npm start writes a row to pg", verify: "test_7_start", level: "integration", covers: ["d1"] }],
  }));
  expect(covered.ok).toBe(true);
});

/**
 * Task 9 (Structure H, KTB-51) — the plan validator's machine-checkable reasons ride out on their own
 * field `planRepair`, so run-stage can tell a repairable plan-contract defect from every other failure
 * (schema/roster/api). Named regression KTB #18 plan R1: dissents d2/d3 left uncovered.
 */
test("plan validator: planRepair carries the machine-checkable reasons (KTB #18 plan R1: d2/d3 uncovered)", () => {
  const dissent = [
    { id: "d2", role: "skeptic", severity: "high", objection: "the migration is not idempotent", resolution: "unresolved — proceeding" },
    { id: "d3", role: "architect", severity: "medium", objection: "no rollback path", resolution: "unresolved — proceeding" },
  ];
  const bad = verifyPlan(planFix({ dissent_log: dissent }));
  expect(bad.ok).toBe(false);
  expect(bad.planRepair).toHaveLength(1);
  expect(bad.planRepair[0]).toMatch(/^dissent without done_when: d2, d3 — give every dissent_log entry an "id" and a "severity"/);
  // the same strings are also in reasons, and here they are the ONLY reason — so run-stage sees a
  // purely machine-checkable failure it may repair (v.reasons.length === v.planRepair.length).
  expect(bad.reasons).toEqual(bad.planRepair);

  // a clean plan carries no planRepair — the field is null, not an empty array.
  const good = verifyPlan(planFix({
    dissent_log: dissent,
    done_when: [
      { id: "dw1", text: "the migration re-run is a no-op", verify: "test_7_idem", level: "unit", covers: ["d2"] },
      { id: "dw2", text: "a rollback restores the prior schema", verify: "test_7_rollback", level: "unit", covers: ["d3"] },
    ],
  }));
  expect(good.ok).toBe(true);
  expect(good.planRepair).toBeNull();
});

test("plan validator: dissent with no severity still needs a done_when; low severity does not", () => {
  const noSeverity = verifyPlan(planFix({ dissent_log: [{ role: "skeptic", objection: "o", resolution: "unresolved — proceeding" }] }));
  expect(noSeverity.reasons.join("; ")).toMatch(/dissent without done_when: d1/);   // id 없는 항목은 위치로 d<n>
  const low = verifyPlan(planFix({ dissent_log: [{ id: "d1", role: "skeptic", severity: "low", objection: "o", resolution: "wording" }] }));
  expect(low.ok).toBe(true);
});

test("plan validator: done_when is capped at charter plan.max_done_when (default 6)", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `dw${i + 1}`, text: `t${i + 1}`, verify: `test_7_t${i + 1}`, level: "unit" }));
  expect(verifyPlan(planFix({ done_when: many(6) })).ok).toBe(true);
  const over = verifyPlan(planFix({ done_when: many(7) }));
  expect(over.ok).toBe(false);
  expect(over.reasons.join("; ")).toMatch(/done_when has 7 items \(max 6\)/);
  // 상한은 CHARTER가 정한다 — 검증기는 그 값을 받아 쓴다.
  expect(verifyPlan(planFix({ done_when: many(3) }), { planLimits: { max_done_when: 2 } }).reasons.join("; ")).toMatch(/done_when has 3 items \(max 2\)/);
});

test("plan validator: guard-shaped done_when is invalid unless the issue asks for a guard", () => {
  const guardish = planFix({ done_when: [{ id: "dw4", text: "a test asserts every backticked path token is in the prefix whitelist", verify: "test_7_paths", level: "unit" }] });
  const bad = verifyPlan(guardish);
  expect(bad.ok).toBe(false);
  expect(bad.reasons.join("; ")).toMatch(/guard-shaped done_when: dw4/);

  // 이슈가 가드를 요구하면 통과한다 — 영어 "guard", 한국어 "가드", `[guard]` 마커 셋 다.
  expect(verifyPlan(guardish, { issueBody: "Add a guard test for README paths" }).ok).toBe(true);
  expect(verifyPlan(guardish, { issueBody: "README 경로 가드를 추가한다" }).ok).toBe(true);
  expect(verifyPlan(guardish, { issueBody: "[guard] README paths" }).ok).toBe(true);
});

test("plan validator: the other guard heuristics — ordering, regex-over-the-repo, repository-wide file lists", () => {
  const reasonFor = (text) => verifyPlan(planFix({ done_when: [{ id: "dw1", text, verify: "test_7_x", level: "unit" }] })).reasons.join("; ");
  expect(reasonFor("the test asserts the ordering of sections (a) → (b) → (c)")).toMatch(/guard-shaped done_when: dw1/);
  expect(reasonFor("a regex over the repository's markdown files")).toMatch(/guard-shaped done_when: dw1/);
  expect(reasonFor("only these files may change")).toMatch(/guard-shaped done_when: dw1/);
  expect(reasonFor("the string `TODO` must not appear anywhere")).toMatch(/guard-shaped done_when: dw1/);
  expect(reasonFor("the test walks every file in the repository and checks the header")).toMatch(/guard-shaped done_when: dw1/);
  // 사용자가 보는 행동을 관측하는 done_when은 걸리지 않는다.
  expect(reasonFor("GET /healthz responds 200 with Cache-Control: no-store")).not.toMatch(/guard-shaped/);
});

/**
 * 리뷰 효율 Task 1 (Structure A) — 수용 계약(acceptance contract). 모든 done_when은 그것이 **어떻게
 * 확인되는지**(`check {kind, ref}`)와 리뷰어가 적용할 **한 줄 기준**(`rubric`) 중 적어도 하나를 지녀야
 * 한다. 둘 다 없는 항목은 계약이 아니라 소망이다 — 구현자는 스스로 확인할 것이 없고(Task 3), 리뷰어는
 * 공유된 기준이 없다(Task 7). 검증기는 그런 항목을 `acceptance contract incomplete: <id>`로 거절한다.
 * `verify`(테스트 id)는 `check {kind:"test"}`의 옛 철자이므로, 그 하나만 있는 옛 핸드오프도 계약을 갖춘
 * 것으로 친다 — 새 요구를 집행하는 것은 파서가 아니라 이 검증기다(옛 핸드오프는 그대로 파싱된다).
 */
test("plan validator: a done_when with neither check nor rubric is an incomplete acceptance contract", () => {
  const bad = verifyPlan(planFix({ done_when: [{ id: "dw9", text: "the export streams to disk", level: "unit" }] }));
  expect(bad.ok).toBe(false);
  expect(bad.reasons.join("; ")).toMatch(/acceptance contract incomplete: dw9/);

  // 명시적 check을 실은 새 항목은 rubric도 함께 지녀야 완결이다. rubric만으로도(rubric-only 경로) 통과한다.
  const withCheck = verifyPlan(planFix({ done_when: [{ id: "dw9", text: "t", level: "unit", check: { kind: "test", ref: "test_7_export" }, rubric: "the reviewer confirms the stream is used" }] }));
  expect(withCheck.ok).toBe(true);
  const withRubric = verifyPlan(planFix({ done_when: [{ id: "dw9", text: "t", level: "unit", check: { kind: "rubric", ref: "" }, rubric: "the warning appears before the command block" }] }));
  expect(withRubric.ok).toBe(true);
});

/**
 * should_fix #1 — 새 항목(명시적 `check`)은 rubric도 반드시 지닌다. 검증기가 모든 핸드오프의 실제
 * 게이트이므로(재종합·수리 턴·손편집은 emission 스키마를 안 거친다), Task 7 리뷰어가 채점할 기준을
 * 여기서 보장한다. 옛 `verify`-only 항목은 rubric 없이 그대로 통과한다(back-compat).
 */
test("plan validator: a new-style item (explicit check) with an empty/absent rubric is rejected; legacy verify-only stays rubric-free", () => {
  const absent = verifyPlan(planFix({ done_when: [{ id: "dw5", text: "t", level: "unit", check: { kind: "test", ref: "test_7_x" } }] }));
  expect(absent.ok).toBe(false);
  expect(absent.reasons.join("; ")).toMatch(/acceptance contract incomplete: dw5 — check present but rubric missing/);

  const empty = verifyPlan(planFix({ done_when: [{ id: "dw5", text: "t", level: "unit", check: { kind: "gate", ref: "lint" }, rubric: "   " }] }));
  expect(empty.ok).toBe(false);
  expect(empty.reasons.join("; ")).toMatch(/acceptance contract incomplete: dw5 — check present but rubric missing/);

  // 옛 핸드오프: verify만, check/rubric 없음 — 그대로 통과한다.
  expect(verifyPlan(planFix({ done_when: [{ id: "dw5", text: "t", level: "unit", verify: "test_7_x" }] })).ok).toBe(true);
});

test("plan validator: a legacy verify (a test id) counts as the check — old handoffs without check/rubric still pass", () => {
  // planFix의 기본 done_when은 verify(test_7_create)만 있고 check/rubric은 없다 — 그래도 계약이 완결이다.
  expect(verifyPlan(planFix()).ok).toBe(true);
});

test("plan validator: a check.kind:test whose ref is empty or malformed is rejected (Task 3 must be able to run it)", () => {
  const empty = verifyPlan(planFix({ done_when: [{ id: "dw3", text: "t", level: "unit", check: { kind: "test", ref: "" }, rubric: "graded by the reviewer" }] }));
  expect(empty.ok).toBe(false);
  expect(empty.reasons.join("; ")).toMatch(/acceptance contract incomplete: dw3/);
  const malformed = verifyPlan(planFix({ done_when: [{ id: "dw3", text: "t", level: "unit", check: { kind: "test", ref: "run the export by hand" } }] }));
  expect(malformed.ok).toBe(false);
  expect(malformed.reasons.join("; ")).toMatch(/acceptance contract incomplete: dw3/);
});

/**
 * 회귀 핀(데모 #2 9라운드의 단일 원인, 감사 Task 9): 수용 계약 규칙을 **덧붙였지** 기존 규칙을 대체하지
 * 않았다. medium 이상 dissent를 done_when이 짚지 못하면, 그 done_when이 계약을 온전히 갖췄더라도
 * 여전히 `dissent without done_when`으로 실패한다.
 */
test("plan validator regression: a medium+ dissent left uncovered STILL fails with dissent without done_when (rule intact)", () => {
  const dissent = [{ id: "d1", role: "skeptic", severity: "high", objection: "npm start never touches pg", resolution: "unresolved — proceeding" }];
  const bad = verifyPlan(planFix({
    dissent_log: dissent,
    done_when: [{ id: "dw1", text: "the export streams to disk", level: "unit", check: { kind: "test", ref: "test_7_stream" }, rubric: "graded by the reviewer" }],
  }));
  expect(bad.ok).toBe(false);
  expect(bad.reasons.join("; ")).toMatch(/dissent without done_when: d1/);
});

/**
 * ── 리뷰 효율 Task 5 (Structure D) — 회귀 핀(regression pins) ────────────────────────────────
 * `→ rework`에서 리뷰어 must_fix 하나가 carried **pin** `{id, guard, text}`이 된다. guard는 **꾸며내지
 * 않는다**(spec §4.D / §9 Q5): 그 must_fix가 수용 계약(Task 1)의 done_when에 연결되고 그 done_when의
 * `check`이 **돌릴 수 있는 테스트**일 때만 guard = 그 check. 그 외에는 `guard:null` → advisory 산문 핀.
 */
test("Task 5: deriveReworkPins — a must_fix linked to a done_when whose contract check is a test carries that guard; a prose must_fix carries guard:null", () => {
  const doneWhen = [
    { id: "dw1", text: "POST /notes returns 201", level: "unit", check: { kind: "test", ref: "test_7_create" }, rubric: "creates a note" },
    { id: "dw2", text: "the page reads well", level: "unit", check: { kind: "rubric", ref: "" }, rubric: "reads well" },
  ];
  const mustFix = [
    { id: "dw1", where: "src/notes.js", claim: "create returns 500 on empty body", evidence: "", by: "correctness" },
    { id: "mf-prose", where: "README.md", claim: "the heading is misleading", evidence: "", by: "spec-conformance" },
  ];
  const pins = deriveReworkPins({ mustFix, doneWhen });
  const guarded = pins.find((p) => p.id === "dw1");
  expect(guarded.guard).toEqual({ kind: "test", ref: "test_7_create" });
  expect(guarded.text).toContain("create returns 500");
  // dw2 is rubric-only (reviewer-judged) — a must_fix under it is never a guard.
  const prose = pins.find((p) => p.id === "mf-prose");
  expect(prose.guard).toBeNull();
  expect(prose.text).toContain("heading is misleading");
});

test("Task 5: a guard links via done_when.covers and via a test name named in must_fix.where; legacy verify counts; rubric-only is never a guard", () => {
  const doneWhen = [
    { id: "dw3", text: "x", level: "unit", check: { kind: "test", ref: "test_7_stream" }, rubric: "r", covers: ["risk-1"] },
    { id: "dw4", text: "y", level: "unit", check: { kind: "rubric", ref: "" }, rubric: "r" },
    { id: "dw5", text: "z", level: "unit", verify: "test_7_legacy" },   // 옛 철자 — check{kind:test}과 같다
  ];
  // (1) covers link: the must_fix id is covered by dw3.
  expect(deriveReworkPins({ mustFix: [{ id: "risk-1", where: "w", claim: "c" }], doneWhen })[0].guard).toEqual({ kind: "test", ref: "test_7_stream" });
  // (2) the must_fix.where names the test name of a contract check.
  expect(deriveReworkPins({ mustFix: [{ id: "mfX", where: "regressed test_7_stream in src/s.js", claim: "c" }], doneWhen })[0].guard).toEqual({ kind: "test", ref: "test_7_stream" });
  // (3) legacy verify is the old spelling of check{kind:test} — id link picks it up.
  expect(deriveReworkPins({ mustFix: [{ id: "dw5", where: "w", claim: "c" }], doneWhen })[0].guard).toEqual({ kind: "test", ref: "test_7_legacy" });
  // (4) a rubric-only contract → no guard even when the id matches (do NOT fabricate a guard).
  expect(deriveReworkPins({ mustFix: [{ id: "dw4", where: "w", claim: "c" }], doneWhen })[0].guard).toBeNull();
  // (5) no acceptance contract at all → every pin is advisory (no fabricated guard).
  expect(deriveReworkPins({ mustFix: [{ id: "dw3", where: "w", claim: "c" }], doneWhen: [] })[0].guard).toBeNull();
  // (6) nit 1 — the where-names-ref link is a WHOLE-TOKEN match: a `test_7` ref must NOT link to a
  // `where` that only names the longer `test_7_create` (substring false-link).
  const prefix = [{ id: "dwP", text: "x", level: "unit", check: { kind: "test", ref: "test_7" }, rubric: "r" }];
  expect(deriveReworkPins({ mustFix: [{ id: "mfY", where: "broke test_7_create", claim: "c" }], doneWhen: prefix })[0].guard).toBeNull();
});

test("plan validator does not run for other stages", () => {
  const r = verifyStage({ stage: "review", out: out(review), agentsLog: log(["reviewer-correctness", "reviewer-qa"]), roster: ["correctness", "qa"], rolePrefix: "reviewer-", orchestration: "workflow", gates: { status: "GREEN", level: "full" }, planLimits: { max_done_when: 1 } });
  expect(r.ok).toBe(true);
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

// 1.4.21 (L24, own-calendar #31): dissent ids and done_when.covers are matched case-insensitively — `D1` vs `d1` is not a gap.
test("validatePlanHandoff: covers match dissent ids regardless of case and whitespace", async () => {
  const { validatePlanHandoff } = await import("../lib/verify-stage.js");
  const plan = {
    dissent_log: [{ id: "D1", severity: "medium", objection: "x" }, { id: "D2", severity: "low", objection: "y" }],
    done_when: [{ id: "dw1", text: "t", rubric: "r", check: { kind: "command", ref: "npm test" }, covers: [" d1 "] }],
  };
  expect(validatePlanHandoff(plan).filter((r) => /dissent without done_when/.test(r))).toEqual([]);
  const gap = { ...plan, done_when: [{ ...plan.done_when[0], covers: ["d9"] }] };
  expect(validatePlanHandoff(gap).some((r) => r.startsWith("dissent without done_when: D1"))).toBe(true);
});

// 1.4.30 (L37, own-calendar #90): the repair feedback shows what the validator saw — ids (or position names), severities,
// and the covers it found — so the planner can see why its covers did not match.
test("validatePlanHandoff: the uncovered-dissent reason lists what the validator saw", async () => {
  const { validatePlanHandoff } = await import("../lib/verify-stage.js");
  const plan = {
    dissent_log: [{ severity: "medium", objection: "x" }, { id: "D3", objection: "y" }],
    done_when: [{ id: "dw1", text: "t", rubric: "r", check: { kind: "command", ref: "npm test" }, covers: ["dissent-1"] }],
  };
  const r = validatePlanHandoff(plan).find((x) => x.startsWith("dissent without done_when"));
  expect(r).toMatch(/uncovered: d1 \(no id — named by position\): severity "medium"; D3: severity missing/);
  expect(r).toMatch(/done_when\.covers: dissent-1/);
});

// ── #170: the Workflow runner's own output file is a recovery candidate ──────────────────────────
// own-calendar #124 review (gha-37012863112): the reviewers finished, the Workflow wrote its verdicts,
// and the orchestrator spent 23 turns on `Read <scratchpad>/tasks/wf086hvld.output` and
// `jq -c '.result' … | head -c 30000` until it hit max turns. Every candidate in the transcript was a
// cut-off fragment, so verify said needs-human although the verdict already existed in that file.
// The fixtures below copy that structure: a background receipt with a Task ID, the runner's
// <task-notification> naming the <output-file> (its <result> cut the way KTB-17 recorded it), polling
// tool calls whose results are 30 000-char prefixes, a max-turns envelope, and a real file on disk in
// the KTB-17 shape — a single pretty-printed {summary, agentCount, logs, result} envelope over 30 KB.
import { mkdtempSync as mkdtemp170, mkdirSync as mkdir170, writeFileSync as write170, existsSync as exists170, readFileSync as read170 } from "node:fs";
import { tmpdir as tmpdir170 } from "node:os";
import { join as join170 } from "node:path";
import * as stageArtifact170 from "../lib/stage-artifact.js";

const TASK_170 = "wf086hvld";
const readFile170 = (p) => (exists170(p) ? read170(p, "utf8") : null);
const maxTurns170 = { is_error: true, subtype: "error_max_turns", terminal_reason: "max_turns", num_turns: 23, result: "Still waiting on the workflow output." };
const reviewArgs170 = { stage: "review", out: maxTurns170, agentsLog: log(["reviewer-correctness", "reviewer-qa"]), roster: ["correctness", "qa"], rolePrefix: "reviewer-", orchestration: "workflow", gates: { status: "GREEN", level: "full" } };
const implArgs170 = { stage: "implement", out: maxTurns170, agentsLog: log([]), roster: [], orchestration: "workflow", gates: { status: "GREEN", level: "full" } };
/** A review verdict long enough that `head -c 30000` cuts it (the #124 verdicts were). */
const longReview170 = (over = {}) => ({
  ...review,
  verdicts: review.verdicts.map((v) => ({ ...v, verified: Array.from({ length: 160 }, (_, i) => `${v.role}: checked factory/lib/stage-artifact.js:${i + 1} against the plan rubric and the house rules — ${"evidence ".repeat(12)}`) })),
  ...over,
});
const impl170 = { schema: "factory.implement.v1", issue: 7, head_sha: "b".repeat(40), pr: 9, gates: { status: "GREEN", level: "full" }, verifier: { verdict: "accepted", notes: Array.from({ length: 450 }, (_, i) => `dw${i % 6 + 1}: prove-test reverted the change and the test failed as expected (${i})`).join("\n") }, orchestration: "workflow", guarantee: "verified" };
/** The runner's file in the KTB-17 shape: one pretty-printed envelope, `logs` making it long. */
const envelopeFile170 = (result) => JSON.stringify({
  summary: "Dynamic workflow \"Review panel\" completed",
  agentCount: 3,
  logs: Array.from({ length: 400 }, (_, i) => `[agent ${i % 3}] step ${i}: ${"progress ".repeat(10)}`),
  result,
}, null, 2);
function scratch170() {
  const dir = mkdtemp170(join170(tmpdir170(), "ktb170-"));
  mkdir170(join170(dir, "tasks"), { recursive: true });
  return dir;
}
const outputPath170 = (dir, id = TASK_170) => join170(dir, "tasks", `${id}.output`);
const line170 = (o) => JSON.stringify(o);
const receipt170 = (id = TASK_170, toolId = "toolu_wf") => [
  line170({ type: "assistant", message: { content: [{ type: "tool_use", name: "Workflow", id: toolId, input: { name: "factory-review" } }] } }),
  line170({ type: "user", message: { content: [{ tool_use_id: toolId, type: "tool_result", content: `Workflow launched in background. Task ID: ${id}\nSummary: Review panel\nTranscript dir: /home/runner/.claude/projects/x/s/subagents/workflows/wf_1\nRun ID: wf_1\n\nYou will be notified when it completes.`, is_error: false }] } }),
];
const notification170 = (id, path, resultText, toolId = "toolu_wf") => line170({ type: "user", message: { content: `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>${toolId}</tool-use-id>\n<output-file>${path}</output-file>\n<status>completed</status>\n<summary>Dynamic workflow "Review panel" completed</summary>\n<result>${resultText.slice(0, 8179)}... (truncated ${Math.max(0, resultText.length - 8179)} chars, full result in ${path})</result>\n</task-notification>` } });
/** One polling turn: a Bash `jq … | head -c 30000` and its cut-off result. */
const poll170 = (n, path, fullText) => [
  line170({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: `toolu_poll_${n}`, input: { command: `jq -c '.result' ${path} | head -c 30000` } }] } }),
  line170({ type: "user", message: { content: [{ tool_use_id: `toolu_poll_${n}`, type: "tool_result", content: fullText.slice(0, 30000) }] } }),
];
/** The #124 transcript: receipt → notification → `polls` cut-off reads of the file. No handoff anywhere. */
function incident170({ dir, artifact, id = TASK_170, polls = 3, receipt = true, extra = [] }) {
  const path = outputPath170(dir, id);
  const full = JSON.stringify(artifact);
  const lines = [line170({ type: "user", message: { content: "/factory-review 124" } })];
  if (receipt) lines.push(...receipt170(id));
  lines.push(notification170(id, path, full));
  for (let i = 0; i < polls; i++) lines.push(...poll170(i, path, full));
  lines.push(...extra);
  return lines.join("\n") + "\n";
}

test("test_170_recovery_reads_the_workflow_output_file_untruncated", () => {
  // review.v1: the long verdict exists only in the file; every transcript copy is cut.
  const dir = scratch170();
  const verdict = longReview170();
  const file = envelopeFile170(verdict);
  write170(outputPath170(dir), file);
  expect(Buffer.byteLength(file)).toBeGreaterThan(30 * 1024);
  expect(JSON.stringify(verdict).length).toBeGreaterThan(30000);           // head -c 30000 really cut it
  const transcriptText = incident170({ dir, artifact: verdict });

  const before = verifyStage({ ...reviewArgs170, transcriptText });         // no readFile: today's needs-human
  expect(before.ok).toBe(false);
  const r = verifyStage({ ...reviewArgs170, transcriptText, readFile: readFile170 });
  expect(r.ok).toBe(true);
  expect(r.reasons).toEqual([]);
  expect(r.data.verdicts.map((v) => v.role)).toEqual(["correctness", "qa"]);
  expect(r.data.verdicts[0].verified).toHaveLength(160);                   // the whole verdict, not a prefix
  expect(r.source).toContain(outputPath170(dir));                          // provenance names the file

  // implement.v1: the same polling-out-of-turns on the implement orchestrator.
  const dirI = scratch170();
  const fileI = envelopeFile170(impl170);
  write170(outputPath170(dirI), fileI);
  expect(Buffer.byteLength(fileI)).toBeGreaterThan(30 * 1024);
  const ri = verifyStage({ ...implArgs170, transcriptText: incident170({ dir: dirI, artifact: impl170 }), readFile: readFile170 });
  expect(JSON.stringify(impl170).length).toBeGreaterThan(30000);
  expect(ri.ok).toBe(true);
  expect(ri.data.head_sha).toBe("b".repeat(40));
  expect(ri.source).toContain(outputPath170(dirI));

  // JSONL fallback: the LAST record's `.result` is the verdict — the first record never wins, whether it
  // fails the schema (a progress record) or is itself an older, schema-valid verdict.
  const dirJ = scratch170();
  const jsonl = [
    JSON.stringify({ type: "result", result: longReview170({ round: 1 }) }),
    JSON.stringify({ type: "progress", message: "reviewer-qa finished" }),
    JSON.stringify({ type: "result", result: longReview170({ round: 2 }) }),
  ].join("\n") + "\n";
  write170(outputPath170(dirJ), jsonl);
  expect(Buffer.byteLength(jsonl)).toBeGreaterThan(30 * 1024);
  const rj = verifyStage({ ...reviewArgs170, transcriptText: incident170({ dir: dirJ, artifact: longReview170({ round: 2 }) }), readFile: readFile170 });
  expect(rj.ok).toBe(true);
  expect(rj.data.round).toBe(2);
  expect(rj.source).toContain(outputPath170(dirJ));
  const dirK = scratch170();
  write170(outputPath170(dirK), [JSON.stringify({ type: "progress", message: "started" }), JSON.stringify({ type: "result", result: longReview170({ round: 3 }) })].join("\n"));
  const rk = verifyStage({ ...reviewArgs170, transcriptText: incident170({ dir: dirK, artifact: longReview170({ round: 3 }) }), readFile: readFile170 });
  expect(rk.ok).toBe(true);
  expect(rk.data.round).toBe(3);
});

test("test_170_output_file_of_another_task_is_not_a_verdict", () => {
  const dir = scratch170();
  const accept = longReview170();
  // X (this session's receipt) has no file; Y sits right next to it with a schema-valid accept.
  write170(outputPath170(dir, "wfOTHERyy"), envelopeFile170(accept));
  // Z is a background Bash task with a runner notification of its own — not a Workflow receipt.
  write170(outputPath170(dir, "bgZZZZ"), envelopeFile170(accept));
  const extra = [
    line170({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", id: "toolu_r1", input: { file_path: outputPath170(dir, "wfOTHERyy") } }] } }),
    line170({ type: "user", message: { content: [{ tool_use_id: "toolu_r1", type: "tool_result", content: "File content (412KB) exceeds maximum allowed size." }] } }),
    line170({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "toolu_b9", input: { command: `cat ${outputPath170(dir, "wfOTHERyy")} | head -c 30000` } }] } }),
    line170({ type: "user", message: { content: [{ tool_use_id: "toolu_b9", type: "tool_result", content: JSON.stringify(accept).slice(0, 30000) }] } }),
    notification170("bgZZZZ", outputPath170(dir, "bgZZZZ"), "{\"done\":true}", "toolu_bash_bg"),
  ];
  const transcriptText = incident170({ dir, artifact: accept, extra });
  const asked = [];
  const readFile = (p) => { asked.push(p); return readFile170(p); };
  const r = verifyStage({ ...reviewArgs170, transcriptText, readFile });
  expect(r.ok).toBe(false);
  expect(r.data).toBe(null);
  expect(r.reasons[0]).toBe("claude -p hit max turns (23)");
  expect(asked).toEqual([outputPath170(dir)]);                             // only X's file was ever opened
  expect(r.reasons.join(" ")).toContain(`workflow output file missing: ${outputPath170(dir)}`);

  // The same files with no Workflow receipt at all: nothing is eligible, nothing is read.
  const asked2 = [];
  const r2 = verifyStage({ ...reviewArgs170, transcriptText: incident170({ dir, artifact: accept, extra, receipt: false }), readFile: (p) => { asked2.push(p); return readFile170(p); } });
  expect(r2.ok).toBe(false);
  expect(asked2).toEqual([]);
});

test("test_170_truncated_candidate_is_named_as_truncated", () => {
  const dir = scratch170();
  const verdict = longReview170();
  // Eight cut-off polls plus three small schema-failing tool results: far more than six candidate lines.
  const noise = Array.from({ length: 3 }, (_, i) => [
    line170({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: `toolu_n${i}`, input: { command: "gh pr view 9 --json state" } }] } }),
    line170({ type: "user", message: { content: [{ tool_use_id: `toolu_n${i}`, type: "tool_result", content: JSON.stringify({ state: "OPEN", n: i }) }] } }),
  ]).flat();
  const transcriptText = incident170({ dir, artifact: verdict, polls: 8, extra: noise });

  const missing = verifyStage({ ...reviewArgs170, transcriptText, readFile: readFile170 });
  expect(missing.ok).toBe(false);
  const reason = missing.reasons.join("\n");
  expect(reason).toMatch(/truncated JSON candidate/);
  // the cut-off fragments are named as cut off, not as a schema cascade
  expect(reason).toMatch(/truncated JSON candidate[^|]*transcript tool result #\d+ \(30000 chars\)/);
  expect(reason).not.toMatch(/transcript tool result #\d+: round is required/);
  expect(reason).not.toMatch(/task-notification #\d+: [^|]*verdicts is required/);
  expect(reason).toContain(`workflow output file missing: ${outputPath170(dir)}`);
  // the schema-failing noise is there too (more than six candidates) — the truncation note survived the cap
  expect(reason).toMatch(/transcript tool result #\d+: issue is required/);

  // the untruncated file for the receipt's task wins over every fragment
  write170(outputPath170(dir), envelopeFile170(verdict));
  const won = verifyStage({ ...reviewArgs170, transcriptText, readFile: readFile170 });
  expect(won.ok).toBe(true);
  expect(won.source).toContain(outputPath170(dir));
  expect(won.data.verdicts[1].verified).toHaveLength(160);
});

test("test_170_invalid_or_missing_output_file_is_named_in_the_reason", () => {
  const CAP = 5 * 1024 * 1024;                                            // the cap the operator asked to be stated (~5 MB)
  const verdict = longReview170();
  const run = (fileText) => {
    const dir = scratch170();
    if (fileText !== null) write170(outputPath170(dir), fileText);
    const r = verifyStage({ ...reviewArgs170, transcriptText: incident170({ dir, artifact: verdict }), readFile: readFile170 });
    return { r, path: outputPath170(dir), text: r.reasons.join("\n") };
  };

  // present but the record fails the stage schema: the path and the schema errors
  const bad = run(envelopeFile170({ ...verdict, verdicts: undefined, round: undefined }));
  expect(bad.r.ok).toBe(false);
  expect(bad.r.reasons[0]).toBe("claude -p hit max turns (23)");
  expect(bad.text).toMatch(new RegExp(`workflow output file ${bad.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n|]*: round is required; verdicts is required`));

  // larger than the byte cap — even though its record is schema-valid: the path and the size
  const big = JSON.stringify({ summary: "s", agentCount: 3, logs: ["x".repeat(CAP)], result: verdict });
  const over = run(big);
  expect(over.r.ok).toBe(false);
  expect(over.r.reasons[0]).toBe("claude -p hit max turns (23)");
  expect(over.text).toContain(`workflow output file too large: ${over.path} (${Buffer.byteLength(big)} bytes > ${CAP})`);

  // not JSON at all: named, not a silent no-op
  const junk = run("workflow crashed before writing a result\n");
  expect(junk.r.ok).toBe(false);
  expect(junk.text).toContain(`workflow output file is not valid JSON: ${junk.path}`);

  // gone from the scratchpad
  const gone = run(null);
  expect(gone.r.ok).toBe(false);
  expect(gone.r.reasons[0]).toBe("claude -p hit max turns (23)");
  expect(gone.text).toContain(`workflow output file missing: ${gone.path}`);
  expect(stageArtifact170.WORKFLOW_OUTPUT_MAX_BYTES).toBe(CAP);

});

test("test_170_no_output_file_keeps_todays_behaviour", () => {
  const dir = scratch170();
  const verdict = longReview170();
  write170(outputPath170(dir), envelopeFile170(verdict));
  const transcriptText = incident170({ dir, artifact: verdict, polls: 2 });
  // Today's needs-human for this transcript, frozen byte for byte (computed on main before #170).
  const TODAY = [
    "claude -p hit max turns (23)",
    "no candidate matched the stage schema — transcript: the Workflow tool result is a background receipt, not a return value (1 call(s)) | no JSON object in result",
  ];
  // control: the very same files DO recover once the caller opts in — so the equalities below are not vacuous
  expect(verifyStage({ ...reviewArgs170, transcriptText, readFile: readFile170 }).ok).toBe(true);

  // (a) no readFile (the retro.js / implementHeadShaOf shape of call): exactly today's outcome
  const noReader = verifyStage({ ...reviewArgs170, transcriptText });
  expect(noReader.ok).toBe(false);
  expect(noReader.reasons).toEqual(TODAY);
  expect(noReader.source).toBe(null);

  // (b) readFile given, but the transcript holds no Workflow receipt: exactly today's outcome, nothing read
  const asked = [];
  const noReceipt = verifyStage({ ...reviewArgs170, transcriptText: incident170({ dir, artifact: verdict, polls: 2, receipt: false }), readFile: (p) => { asked.push(p); return readFile170(p); } });
  expect(noReceipt.ok).toBe(false);
  expect(noReceipt.reasons).toEqual(TODAY.map((l) => l.replace("transcript: the Workflow tool result is a background receipt, not a return value (1 call(s))", "transcript: no Workflow tool result found (transcript missing or shape changed)")));
  expect(noReceipt.reasons).toEqual(verifyStage({ ...reviewArgs170, transcriptText: incident170({ dir, artifact: verdict, polls: 2, receipt: false }) }).reasons);
  expect(asked).toEqual([]);

  // (c) a reader that throws does not take the stage down — it is a missing file, named as such
  const throwing = verifyStage({ ...reviewArgs170, transcriptText, readFile: () => { throw new Error("EACCES"); } });
  expect(throwing.ok).toBe(false);
  expect(throwing.reasons[0]).toBe("claude -p hit max turns (23)");
  expect(throwing.reasons.join(" ")).toContain(`workflow output file missing: ${outputPath170(dir)}`);
});
