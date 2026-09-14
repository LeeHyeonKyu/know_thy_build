import { test, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendRunRecord, reviewEvidenceLine, parseReviewEvidence, normalizeVerdicts } from "../lib/run-record.js";
import { verifyReviewProvenance } from "../lib/review-quorum.js";

test("creates file with header then appends stage sections", () => {
  const root = mkdtempSync(join(tmpdir(), "rr-"));
  const p = appendRunRecord({ root, issue: 123, title: "incremental sync", stage: "triage", runnerId: "gha-1", now: "2026-09-08T09:02:00Z", lines: ["disposition: ready · tier: load-bearing"] });
  appendRunRecord({ root, issue: 123, stage: "plan", runnerId: "gha-2", now: "2026-09-08T09:21:00Z", lines: ["rounds: 3", "handoff: comment 3021"] });
  const txt = readFileSync(p, "utf8");
  expect(txt.startsWith("# Run · #123 incremental sync\n")).toBe(true);
  expect(txt).toContain("## triage · 2026-09-08T09:02Z · gha-1\ndisposition: ready · tier: load-bearing\n");
  expect(txt).toContain("## plan · 2026-09-08T09:21Z · gha-2\nrounds: 3\nhandoff: comment 3021\n");
  expect(p).toBe(join(root, "docs/factory/runs/123.md"));
});

test("short-form timestamp (no seconds) is left unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "rr-"));
  const p = appendRunRecord({ root, issue: 456, stage: "plan", runnerId: "gha-3", now: "2026-09-08T09:02Z", lines: ["x"] });
  const txt = readFileSync(p, "utf8");
  expect(txt).toContain("## plan · 2026-09-08T09:02Z · gha-3\nx\n");
});

// ── 리뷰 batch-1 MF-2 (H1b-b): 리뷰 판정의 **출처**는 러너가 쓰는 run 기록이다 ────────────────────
// handoff 코멘트는 모든 스테이지가 쥔 봇 계정으로 나가고 작성자조차 남지 않는다 — 그래서 정족수의
// 재료를 에이전트가 쓸 수 없는 자리(`factory/records`)에 한 줄 더 둔다.

const V = [{ role: "qa", verdict: "approve" }, { role: "correctness", verdict: "approve" }];

test("review evidence: the line round-trips through the run record and is order-independent", () => {
  const root = mkdtempSync(join(tmpdir(), "rr-"));
  const p = appendRunRecord({
    root, issue: 7, stage: "review", runnerId: "gha/1234", now: "2026-09-14T09:02Z",
    lines: ["verify: ok", reviewEvidenceLine({ headSha: "b".repeat(40), round: 2, decision: "approved", verdicts: V })],
  });
  const got = parseReviewEvidence(readFileSync(p, "utf8"));
  expect(got).toMatchObject({ stage: "review", runnerId: "gha/1234", headSha: "b".repeat(40), round: 2, decision: "approved" });
  // 역할 순서가 달라도 같은 문자열이다 — 두 자리(handoff·기록)가 같은 판정을 같은 모양으로 말해야 한다.
  expect(got.verdicts).toBe(normalizeVerdicts([{ role: "correctness", verdict: "approve" }, { role: "qa", verdict: "approve" }]));
});

test("review evidence: the LAST line wins — a later round supersedes the earlier one", () => {
  const root = mkdtempSync(join(tmpdir(), "rr-"));
  appendRunRecord({ root, issue: 8, stage: "review", runnerId: "gha/1", now: "2026-09-14T09:02Z", lines: [reviewEvidenceLine({ headSha: "a".repeat(40), round: 1, decision: "rework", verdicts: [{ role: "qa", verdict: "reject" }] })] });
  const p = appendRunRecord({ root, issue: 8, stage: "review", runnerId: "gha/2", now: "2026-09-14T10:02Z", lines: [reviewEvidenceLine({ headSha: "b".repeat(40), round: 2, decision: "approved", verdicts: V })] });
  const got = parseReviewEvidence(readFileSync(p, "utf8"));
  expect(got.round).toBe(2);
  expect(got.runnerId).toBe("gha/2");
  expect(got.decision).toBe("approved");
});

test("review evidence: a record with no evidence line parses to null, not to an empty pass", () => {
  const root = mkdtempSync(join(tmpdir(), "rr-"));
  const p = appendRunRecord({ root, issue: 9, stage: "review", runnerId: "gha/1", now: "2026-09-14T09:02Z", lines: ["verify: ok", "usage: $1.20"] });
  expect(parseReviewEvidence(readFileSync(p, "utf8"))).toBe(null);
  expect(parseReviewEvidence("")).toBe(null);
  expect(parseReviewEvidence(null)).toBe(null);
});

test("provenance: the handoff must match the run record — a forged all-approve handoff is refused", () => {
  const HEAD = "b".repeat(40);
  const record = parseReviewEvidence(`## review · 2026-09-14T09:02Z · gha/1\n${reviewEvidenceLine({ headSha: HEAD, round: 2, decision: "approved", verdicts: V })}\n`);
  const honest = { head_sha: HEAD, round: 2, verdicts: V };
  expect(verifyReviewProvenance({ handoff: honest, record, prHeadSha: HEAD })).toEqual({ ok: true });

  // 기록이 아예 없다 — handoff 하나만으로는 리뷰가 있었다는 것을 말할 수 없다.
  expect(verifyReviewProvenance({ handoff: honest, record: null, prHeadSha: HEAD }).reason).toMatch(/review evidence not bound to a factory run/);
  // 판정이 다르다(기록은 reject를 봤다).
  const forged = { head_sha: HEAD, round: 2, verdicts: [{ role: "qa", verdict: "approve" }, { role: "correctness", verdict: "approve" }] };
  const rejected = parseReviewEvidence(`## review · 2026-09-14T09:02Z · gha/1\n${reviewEvidenceLine({ headSha: HEAD, round: 2, decision: "rework", verdicts: [{ role: "qa", verdict: "reject" }, { role: "correctness", verdict: "approve" }] })}\n`);
  expect(verifyReviewProvenance({ handoff: forged, record: rejected, prHeadSha: HEAD }).reason).toMatch(/are not the ones the review run recorded/);
  // 커밋이 다르다 — 기록은 우리가 실제로 체크아웃한 sha를 싣는다.
  expect(verifyReviewProvenance({ handoff: { ...honest, head_sha: "f".repeat(40) }, record, prHeadSha: HEAD }).reason).toMatch(/the handoff claims/);
  expect(verifyReviewProvenance({ handoff: honest, record, prHeadSha: "9".repeat(40) }).reason).toMatch(/the review run checked out/);
  // review가 아닌 스테이지가 쓴 줄은 리뷰 증거가 아니다.
  expect(verifyReviewProvenance({ handoff: honest, record: { ...record, stage: "implement" }, prHeadSha: HEAD }).reason).toMatch(/written by the "implement" stage/);
});
