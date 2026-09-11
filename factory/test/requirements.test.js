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

test("awaiting-review requires implement handoff: GREEN, head_sha == branch head, verifier accepted, pr", () => {
  const impl = { schema: "factory.implement.v1", issue: 7, head_sha: sha, pr: 9, gates: { status: "GREEN", level: "full" }, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:awaiting-review");
  expect(r({ comments: [c("implement", impl)], headSha: sha }).ok).toBe(true);
  expect(r({ comments: [c("implement", impl)], headSha: "d".repeat(40) }).reason).toMatch(/head_sha/);
  expect(r({ comments: [c("implement", { ...impl, gates: { status: "RED", level: "full" } })], headSha: sha }).reason).toMatch(/gates/);
  expect(r({ comments: [c("implement", { ...impl, verifier: { verdict: "rejected" } })], headSha: sha }).reason).toMatch(/verifier/);
});

test("awaiting-review trusts the gates file over the handoff", () => {
  const impl = { schema: "factory.implement.v1", issue: 7, head_sha: sha, pr: 9, gates: { status: "GREEN", level: "full" }, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:awaiting-review");
  expect(r({ comments: [c("implement", impl)], headSha: sha, gatesFile: { status: "RED" } }).reason).toMatch(/gates file/);
  expect(r({ comments: [c("implement", impl)], headSha: sha, gatesFile: { status: "GREEN" } }).ok).toBe(true);
});

const GREEN = { status: "GREEN", level: "full" };

test("approved requires review handoff: sha == PR head, all approve, count == roster, round <= K", () => {
  const v = (role, verdict) => ({ role, verdict, confidence: "high", must_fix: verdict === "reject" ? [{ id: "x", where: "w", claim: "c", evidence: "e" }] : [], should_fix: [], verified: [] });
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 2, verdicts: [v("a", "approve"), v("b", "approve")], orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:approved");
  expect(r({ comments: [c("review", review)], prHeadSha: sha, rosterSize: 2, maxRounds: 3, gatesFile: GREEN }).ok).toBe(true);
  expect(r({ comments: [c("review", review)], prHeadSha: sha, rosterSize: 3, maxRounds: 3, gatesFile: GREEN }).reason).toMatch(/verdict count/);
  expect(r({ comments: [c("review", { ...review, verdicts: [v("a", "approve"), v("b", "reject")] })], prHeadSha: sha, rosterSize: 2, maxRounds: 3, gatesFile: GREEN }).reason).toMatch(/not all approve/);
  expect(r({ comments: [c("review", { ...review, round: 4 })], prHeadSha: sha, rosterSize: 2, maxRounds: 3, gatesFile: GREEN }).reason).toMatch(/round/);
  expect(r({ comments: [c("review", review)], prHeadSha: "e".repeat(40), rosterSize: 2, maxRounds: 3, gatesFile: GREEN }).reason).toMatch(/head_sha/);
});

test("merged requires checks + integrity GREEN and approved handoff sha == PR head", () => {
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 1, verdicts: [{ role: "a", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] }], orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:merged");
  const base = { comments: [c("review", review)], prHeadSha: sha, gatesFile: GREEN };
  expect(r({ ...base, checksGreen: true, integrityGreen: true }).ok).toBe(true);
  expect(r({ ...base, checksGreen: false, integrityGreen: true }).reason).toMatch(/checks/);
  expect(r({ ...base, checksGreen: true, integrityGreen: false }).reason).toMatch(/integrity/);
  // 확인하지 않았으면(플래그 부재) 통과가 아니라 거부다
  expect(r(base).ok).toBe(false);
  expect(r(base).reason).toMatch(/not verified GREEN/);
  expect(r({ ...base, checksGreen: true }).reason).toMatch(/integrity check not verified GREEN/);
});

test("approved/merged도 게이트 파일을 요구한다 — 없으면 missing, GREEN이 아니면 거부", () => {
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 1, verdicts: [{ role: "a", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] }], orchestration: "workflow", guarantee: "verified" };
  const ctx = { comments: [c("review", review)], prHeadSha: sha, rosterSize: 1, maxRounds: 3, checksGreen: true, integrityGreen: true };
  for (const to of ["factory:approved", "factory:merged"]) {
    const r = requirementFor(to);
    expect(r(ctx).reason, to).toMatch(/gates file missing/);
    expect(r({ ...ctx, gatesFile: { status: "RED", level: "full" } }).reason, to).toMatch(/gates file status is RED/);
    expect(r({ ...ctx, gatesFile: GREEN }).ok, to).toBe(true);
  }
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
