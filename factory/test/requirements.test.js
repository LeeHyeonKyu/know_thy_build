import { test, expect } from "vitest";
import { requirementFor } from "../lib/requirements.js";
import { renderHandoff } from "../lib/handoff.js";

const sha = "c".repeat(40);
const c = (stage, data, at = "2026-09-11T00:00:00Z") => ({ id: Math.random(), createdAt: at, body: renderHandoff({ stage, issue: 7, summary: "s", data }) });

test("ready requires triage handoff with disposition=ready and tier", () => {
  const ok = requirementFor("factory:ready")({ comments: [c("triage", { schema: "factory.triage.v1", issue: 7, disposition: "ready", tier: "docs" })] });
  expect(ok.ok).toBe(true);
  const missing = requirementFor("factory:ready")({ comments: [] });
  expect(missing.ok).toBe(false); expect(missing.reason).toMatch(/triage handoff missing/);
  const wrong = requirementFor("factory:ready")({ comments: [c("triage", { schema: "factory.triage.v1", issue: 7, disposition: "needs-info", questions: [] })] });
  expect(wrong.ok).toBe(false); expect(wrong.reason).toMatch(/disposition/);
});

test("planned requires plan handoff whose roles == roster and rounds == expected", () => {
  const plan = { schema: "factory.plan.v1", issue: 7, tier: "standard", roles: ["architect", "skeptic"], rounds: 3,
    done_when: [{ id: "dw1", text: "t", verify: "test_7_t", level: "unit" }], files_expected: [], dissent_log: [], non_goals: [], open_risks: [] };
  const r = requirementFor("factory:planned");
  expect(r({ comments: [c("plan", plan)], roster: ["skeptic", "architect"], expectedRounds: 3 }).ok).toBe(true);
  expect(r({ comments: [c("plan", plan)], roster: ["skeptic", "architect", "operator"], expectedRounds: 3 }).reason).toMatch(/roles/);
  expect(r({ comments: [c("plan", plan)], roster: ["skeptic", "architect"], expectedRounds: 2 }).reason).toMatch(/rounds/);
});

const GREEN = { status: "GREEN", level: "full" };
/** 전이 경로의 최소 ctx: 게이트 파일을 실제로 읽었다는 표식(gatesChecked) + 그 파일 */
const checked = (over = {}) => ({ gatesChecked: true, gatesFile: GREEN, ...over });

test("awaiting-review requires implement handoff: GREEN, head_sha == branch head, verifier accepted, pr", () => {
  const impl = { schema: "factory.implement.v1", issue: 7, head_sha: sha, pr: 9, gates: { status: "GREEN", level: "full" }, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:awaiting-review");
  expect(r(checked({ comments: [c("implement", impl)], headSha: sha })).ok).toBe(true);
  expect(r(checked({ comments: [c("implement", impl)], headSha: "d".repeat(40) })).reason).toMatch(/head_sha/);
  expect(r(checked({ comments: [c("implement", impl)], headSha: sha, gatesFile: { status: "RED" } })).reason).toMatch(/gates/);
  expect(r(checked({ comments: [c("implement", { ...impl, verifier: { verdict: "rejected" } })], headSha: sha })).reason).toMatch(/verifier/);
});

test("F4: awaiting-review의 판정 출처는 게이트 파일뿐 — handoff의 자기 신고는 대체재가 아니다", () => {
  const impl = { schema: "factory.implement.v1", issue: 7, head_sha: sha, pr: 9, gates: { status: "GREEN", level: "full" }, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:awaiting-review");
  const comments = [c("implement", impl)];
  // handoff는 GREEN이라고 말하지만 파일을 읽지 않았다 → 확인 안 됨
  expect(r({ comments, headSha: sha }).reason).toMatch(/gates not verified for this transition/);
  expect(r({ comments, headSha: sha, gatesChecked: true }).reason).toMatch(/gates file missing/);
  expect(r({ comments, headSha: sha, gatesChecked: true, gatesFile: { ...GREEN, diagnostic: true } }).reason).toMatch(/diagnostic/);
  expect(r({ comments, headSha: sha, gatesChecked: true, gatesFile: { status: "RED" } }).reason).toMatch(/gates file status is RED/);
  expect(r(checked({ comments, headSha: sha })).ok).toBe(true);
});

test("F6: 게이트 파일이 다른 커밋을 잰 것이면 거부한다", () => {
  const impl = { schema: "factory.implement.v1", issue: 7, head_sha: sha, pr: 9, gates: GREEN, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" };
  const other = "9".repeat(40);
  const ar = requirementFor("factory:awaiting-review")(checked({ comments: [c("implement", impl)], headSha: sha, gatesFile: { ...GREEN, head_sha: other } }));
  expect(ar.ok).toBe(false);
  expect(ar.reason).toBe(`gates file describes ${other.slice(0, 7)}, PR head is ${sha.slice(0, 7)}`);
  expect(requirementFor("factory:awaiting-review")(checked({ comments: [c("implement", impl)], headSha: sha, gatesFile: { ...GREEN, head_sha: sha } })).ok).toBe(true);

  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 1, verdicts: [{ role: "a", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] }], orchestration: "workflow", guarantee: "verified" };
  const ap = requirementFor("factory:approved")(checked({ comments: [c("review", review)], prHeadSha: sha, gatesFile: { ...GREEN, head_sha: other } }));
  expect(ap.reason).toMatch(/gates file describes/);
});

test("approved requires review handoff: sha == PR head, all approve, count == roster", () => {
  const v = (role, verdict) => ({ role, verdict, confidence: "high", must_fix: verdict === "reject" ? [{ id: "x", where: "w", claim: "c", evidence: "e" }] : [], should_fix: [], verified: [] });
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 2, verdicts: [v("a", "approve"), v("b", "approve")], orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:approved");
  expect(r(checked({ comments: [c("review", review)], prHeadSha: sha, rosterSize: 2 })).ok).toBe(true);
  expect(r(checked({ comments: [c("review", review)], prHeadSha: sha, rosterSize: 3 })).reason).toMatch(/verdict count/);
  expect(r(checked({ comments: [c("review", { ...review, verdicts: [v("a", "approve"), v("b", "reject")] })], prHeadSha: sha, rosterSize: 2 })).reason).toMatch(/not all approve/);
  expect(r(checked({ comments: [c("review", review)], prHeadSha: "e".repeat(40), rosterSize: 2 })).reason).toMatch(/head_sha/);
});

/**
 * ADR-020 KTB-29 r1(SF1) — **K는 approve를 막지 않는다.** 여기에 `round > K` 검사가 있는 동안 ADR의
 * "approve는 어느 라운드에서든 통과한다"는 조립된 시스템에서 거짓이었다: 라운드 4의 만장일치 통과가
 * 그래프에서 튕기고(run-stage는 `transition refused: round 4 > K=3`을 적고 exit 2), 이슈는
 * `awaiting-review`에 남아 stalled 팔에 두 번 재점화된 뒤 같은 사람에게 훨씬 느리게 올라갔다.
 * K가 무는 자리는 `nextState`의 rework 판정 하나뿐이다.
 */
test("SF1: an approve passes at ANY round — K is the limit on failing rounds, not on success", () => {
  const v = (role) => ({ role, verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] });
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, verdicts: [v("a")], orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:approved");
  for (const round of [1, 3, 4, 99]) {
    expect(r(checked({ comments: [c("review", { ...review, round })], prHeadSha: sha, rosterSize: 1, maxRounds: 3 })).ok, `round ${round}`).toBe(true);
  }
});

test("merged requires checks + integrity GREEN and approved handoff sha == PR head", () => {
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 1, verdicts: [{ role: "a", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] }], orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:merged");
  const base = checked({ comments: [c("review", review)], prHeadSha: sha });
  expect(r({ ...base, checksGreen: true, integrityGreen: true }).ok).toBe(true);
  expect(r({ ...base, checksGreen: false, integrityGreen: true }).reason).toMatch(/checks/);
  expect(r({ ...base, checksGreen: true, integrityGreen: false }).reason).toMatch(/integrity/);
  // 확인하지 않았으면(플래그 부재) 통과가 아니라 거부다
  expect(r(base).ok).toBe(false);
  expect(r(base).reason).toMatch(/not verified GREEN/);
  expect(r({ ...base, checksGreen: true }).reason).toMatch(/integrity check not verified GREEN/);
});

test("approved/merged도 게이트 파일을 요구한다 — 없으면 missing, GREEN이 아니면 거부 (전이 경로에서만)", () => {
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 1, verdicts: [{ role: "a", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] }], orchestration: "workflow", guarantee: "verified" };
  const ctx = { comments: [c("review", review)], prHeadSha: sha, rosterSize: 1, maxRounds: 3, checksGreen: true, integrityGreen: true, gatesChecked: true };
  for (const to of ["factory:approved", "factory:merged"]) {
    const r = requirementFor(to);
    expect(r(ctx).reason, to).toMatch(/gates file missing/);
    expect(r({ ...ctx, gatesFile: { status: "RED", level: "full" } }).reason, to).toMatch(/gates file status is RED/);
    expect(r({ ...ctx, gatesFile: { ...GREEN, diagnostic: true } }).reason, to).toMatch(/diagnostic/);
    expect(r({ ...ctx, gatesFile: GREEN }).ok, to).toBe(true);
    // F4: 파일을 읽지 않은 호출자는 "GREEN이더라"를 주장할 수 없다 — 자기 신고로 넘어가지 않는다
    expect(r({ ...ctx, gatesChecked: undefined }).reason, to).toMatch(/gates not verified for this transition/);
  }
});

test("F4: prerequisite 확인은 게이트·sha를 전부 건너뛴다 — handoff의 존재와 유효성만 본다", () => {
  const v = { role: "a", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] };
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 1, verdicts: [v], orchestration: "workflow", guarantee: "verified" };
  const impl = { schema: "factory.implement.v1", issue: 7, head_sha: sha, pr: 9, gates: { status: "RED", level: "full" }, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" };
  const other = "e".repeat(40);
  // 게이트 파일도 없고 sha도 어긋나지만, 선행 확인은 "직전 스테이지가 산출물을 남겼는가"만 묻는다
  expect(requirementFor("factory:awaiting-review")({ comments: [c("implement", impl)], headSha: other, prerequisite: true }).ok).toBe(true);
  for (const to of ["factory:approved", "factory:merged"]) {
    const r = requirementFor(to);
    expect(r({ comments: [c("review", review)], prHeadSha: other, rosterSize: 1, maxRounds: 3, prerequisite: true }).ok, to).toBe(true);
    // handoff 자체가 없으면 선행 확인도 실패한다
    expect(r({ comments: [], prerequisite: true }).reason, to).toMatch(/review handoff missing/);
  }
  // verdict/라운드 같은 handoff 내용 검사는 선행 확인에서도 그대로 물린다
  expect(requirementFor("factory:approved")({ comments: [c("review", { ...review, verdicts: [{ ...v, verdict: "reject", must_fix: [{ id: "x", where: "w", claim: "c", evidence: "e" }] }] })], prerequisite: true }).reason).toMatch(/not all approve/);
});

test("need(): a handoff for another issue does not satisfy the gate", () => {
  const triage = { schema: "factory.triage.v1", issue: 7, disposition: "ready", tier: "docs" };
  const r = requirementFor("factory:ready");
  expect(r({ comments: [c("triage", triage)], issue: 7 }).ok).toBe(true);
  const wrongIssue = r({ comments: [c("triage", triage)], issue: 8 });
  expect(wrongIssue.ok).toBe(false);
  expect(wrongIssue.reason).toMatch(/handoff issue mismatch/);
  expect(r({ comments: [c("triage", triage)] }).ok).toBe(true);            // ctx.issue가 없으면 종전대로
});

test("states without a handoff requirement always pass", () => {
  for (const s of ["factory:queue", "factory:needs-info", "factory:wont-do", "factory:in-progress", "factory:rework", "factory:blocked", "factory:needs-human"]) {
    expect(requirementFor(s)({ comments: [] }).ok).toBe(true);
  }
});
