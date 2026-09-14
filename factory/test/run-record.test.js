import { test, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendRunRecord, reviewEvidenceLine, parseReviewEvidence, normalizeVerdicts, runIdOfRunner } from "../lib/run-record.js";
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
//
// ── 리뷰 batch-2 MF-2: 그리고 그 줄은 **어느 런의 것인지** 말한다 ────────────────────────────────
// batch-1의 파서는 "파일의 마지막 줄"을 골랐는데, 그 파일은 에이전트 세션이 덧붙일 수 있는 자리였다
// (재리뷰가 rc=0으로 실행해 확인했고, 위조 섹션으로 `verifyReviewProvenance → {ok:true}`를 재현했다).
// 이제 고르는 기준은 순서가 아니라 신원이다: 머지 스테이지가 이슈의 review 하트비트에서 따로 읽은 런 id.

const V = [{ role: "qa", verdict: "approve" }, { role: "correctness", verdict: "approve" }];
const RUN = "34809992796";

test("review evidence: the line names the run, round-trips through the run record, and is order-independent", () => {
  const root = mkdtempSync(join(tmpdir(), "rr-"));
  const p = appendRunRecord({
    root, issue: 7, stage: "review", runnerId: `gha-${RUN}`, now: "2026-09-14T09:02Z",
    lines: ["verify: ok", reviewEvidenceLine({ runId: RUN, runnerId: `gha-${RUN}`, headSha: "b".repeat(40), round: 2, decision: "approved", verdicts: V })],
  });
  const got = parseReviewEvidence(readFileSync(p, "utf8"), { runId: RUN });
  expect(got).toMatchObject({ stage: "review", runId: RUN, runnerId: `gha-${RUN}`, headSha: "b".repeat(40), round: 2, decision: "approved" });
  // 역할 순서가 달라도 같은 문자열이다 — 두 자리(handoff·기록)가 같은 판정을 같은 모양으로 말해야 한다.
  expect(got.verdicts).toBe(normalizeVerdicts([{ role: "correctness", verdict: "approve" }, { role: "qa", verdict: "approve" }]));
});

test("review evidence: the parser picks the EXPECTED run's line, never the last one (review batch-2 MF-2)", () => {
  const root = mkdtempSync(join(tmpdir(), "rr-"));
  appendRunRecord({ root, issue: 8, stage: "review", runnerId: "gha-1", now: "2026-09-14T09:02Z", lines: [reviewEvidenceLine({ runId: "1", runnerId: "gha-1", headSha: "a".repeat(40), round: 1, decision: "rework", verdicts: [{ role: "qa", verdict: "reject" }] })] });
  const p = appendRunRecord({ root, issue: 8, stage: "review", runnerId: "gha-2", now: "2026-09-14T10:02Z", lines: [reviewEvidenceLine({ runId: "2", runnerId: "gha-2", headSha: "b".repeat(40), round: 2, decision: "approved", verdicts: V })] });
  const txt = readFileSync(p, "utf8");
  // 마지막 줄은 run 2의 것이지만, 기대값이 run 1이면 run 1의 줄이 나온다.
  expect(parseReviewEvidence(txt, { runId: "1" })).toMatchObject({ runId: "1", round: 1, decision: "rework" });
  expect(parseReviewEvidence(txt, { runId: "2" })).toMatchObject({ runId: "2", round: 2, decision: "approved" });
  // 돌지 않은 런의 증거는 없다.
  expect(parseReviewEvidence(txt, { runId: "3" })).toBe(null);
});

test("review evidence: a forged section written by another stage is not the evidence (review batch-2 MF-2)", () => {
  const root = mkdtempSync(join(tmpdir(), "rr-"));
  // 진짜 리뷰 런(=하트비트가 지목하는 런).
  appendRunRecord({ root, issue: 9, stage: "review", runnerId: `gha-${RUN}`, now: "2026-09-14T09:02Z", lines: [reviewEvidenceLine({ runId: RUN, runnerId: `gha-${RUN}`, headSha: "b".repeat(40), round: 2, decision: "rework", verdicts: [{ role: "qa", verdict: "reject" }, { role: "correctness", verdict: "approve" }] })] });
  // implement 에이전트가 자기 세션에서 파일 끝에 심은 "## review" 섹션 — 다른 런 id를 말할 수밖에 없다
  // (아직 일어나지 않은 머지 스테이지가 어떤 런을 기대할지 모른다).
  const p = appendRunRecord({ root, issue: 9, stage: "review", runnerId: "gha-999", now: "2026-09-14T11:00Z", lines: [reviewEvidenceLine({ runId: "999", runnerId: "gha-999", headSha: "b".repeat(40), round: 2, decision: "approved", verdicts: V })] });
  const txt = readFileSync(p, "utf8");
  const honest = { head_sha: "b".repeat(40), round: 2, verdicts: V };
  // 마지막 줄(위조)은 기대하는 런의 것이 아니다 → 기록 없음 → 거부.
  expect(parseReviewEvidence(txt, { runId: RUN }).decision).toBe("rework");
  expect(verifyReviewProvenance({ handoff: honest, record: parseReviewEvidence(txt, { runId: RUN }), prHeadSha: "b".repeat(40), expectedRunId: RUN }).ok).toBe(false);
  // 그리고 위조한 줄을 직접 넘겨도 런 id가 달라 거부된다.
  const forgedRecord = parseReviewEvidence(txt, { runId: "999" });
  expect(verifyReviewProvenance({ handoff: honest, record: forgedRecord, prHeadSha: "b".repeat(40), expectedRunId: RUN }))
    .toMatchObject({ ok: false, reason: expect.stringMatching(/was written by run 999, but the review stage on this issue ran as 34809992796/) });
});

test("review evidence: two conflicting lines claiming the same run are not evidence (review batch-2 MF-2)", () => {
  const root = mkdtempSync(join(tmpdir(), "rr-"));
  appendRunRecord({ root, issue: 10, stage: "review", runnerId: `gha-${RUN}`, now: "2026-09-14T09:02Z", lines: [reviewEvidenceLine({ runId: RUN, runnerId: `gha-${RUN}`, headSha: "b".repeat(40), round: 2, decision: "rework", verdicts: [{ role: "qa", verdict: "reject" }] })] });
  const p = appendRunRecord({ root, issue: 10, stage: "review", runnerId: `gha-${RUN}`, now: "2026-09-14T09:30Z", lines: [reviewEvidenceLine({ runId: RUN, runnerId: `gha-${RUN}`, headSha: "b".repeat(40), round: 2, decision: "approved", verdicts: V })] });
  expect(parseReviewEvidence(readFileSync(p, "utf8"), { runId: RUN })).toBe(null);
});

test("review evidence: no run id to expect, an old-format line, or no line at all all parse to null", () => {
  const root = mkdtempSync(join(tmpdir(), "rr-"));
  const p = appendRunRecord({ root, issue: 11, stage: "review", runnerId: "gha-1", now: "2026-09-14T09:02Z", lines: ["verify: ok", "usage: $1.20"] });
  expect(parseReviewEvidence(readFileSync(p, "utf8"), { runId: RUN })).toBe(null);
  expect(parseReviewEvidence("", { runId: RUN })).toBe(null);
  expect(parseReviewEvidence(null, { runId: RUN })).toBe(null);
  // 기대값이 없으면 "아무 줄이나"가 아니라 **아무것도** 아니다(판정 불능은 통과가 아니다).
  const line = reviewEvidenceLine({ runId: RUN, runnerId: `gha-${RUN}`, headSha: "b".repeat(40), round: 2, decision: "approved", verdicts: V });
  const text = `## review · 2026-09-14T09:02Z · gha-${RUN}\n${line}\n`;
  expect(parseReviewEvidence(text)).toBe(null);
  expect(parseReviewEvidence(text, { runId: null })).toBe(null);
  expect(parseReviewEvidence(text, { runId: "none" })).toBe(null);
  // batch-1의 모양(run_id 없는 줄)은 더 이상 증거가 아니다 — 형식이 바뀐 것이 아니라 바인딩이 생긴 것이다.
  expect(parseReviewEvidence(`## review · 2026-09-14T09:02Z · gha-1\nreview-evidence: head_sha=${"b".repeat(40)} round=2 decision=approved verdicts=correctness=approve,qa=approve\n`, { runId: RUN })).toBe(null);
});

test("runIdOfRunner: `gha-<run id>` is the CI identity; anything else is its own identity", () => {
  expect(runIdOfRunner("gha-34809992796")).toBe("34809992796");
  expect(runIdOfRunner("local/mac-1")).toBe("local/mac-1");
  expect(runIdOfRunner("")).toBe(null);
  expect(runIdOfRunner(null)).toBe(null);
  expect(runIdOfRunner("unknown")).toBe(null);
});

test("provenance: the handoff must match the run record — a forged all-approve handoff is refused", () => {
  const HEAD = "b".repeat(40);
  const rec = (over = {}) => parseReviewEvidence(`## review · 2026-09-14T09:02Z · gha-${RUN}\n${reviewEvidenceLine({ runId: RUN, runnerId: `gha-${RUN}`, headSha: HEAD, round: 2, decision: "approved", verdicts: V, ...over })}\n`, { runId: RUN });
  const record = rec();
  const honest = { head_sha: HEAD, round: 2, verdicts: V };
  expect(verifyReviewProvenance({ handoff: honest, record, prHeadSha: HEAD, expectedRunId: RUN })).toEqual({ ok: true });

  // 기록이 아예 없다 — handoff 하나만으로는 리뷰가 있었다는 것을 말할 수 없다.
  expect(verifyReviewProvenance({ handoff: honest, record: null, prHeadSha: HEAD, expectedRunId: RUN }).reason).toMatch(/review evidence not bound to a factory run/);
  // 기대하는 런 id 자체를 모르면 판정 불능이다(하트비트가 없는 이슈) — 통과가 아니다.
  expect(verifyReviewProvenance({ handoff: honest, record, prHeadSha: HEAD }).reason).toMatch(/could not be named/);
  expect(verifyReviewProvenance({ handoff: honest, record, prHeadSha: HEAD, expectedRunId: "" }).reason).toMatch(/could not be named/);
  // 판정이 다르다(기록은 reject를 봤다).
  const forged = { head_sha: HEAD, round: 2, verdicts: [{ role: "qa", verdict: "approve" }, { role: "correctness", verdict: "approve" }] };
  const rejected = rec({ decision: "rework", verdicts: [{ role: "qa", verdict: "reject" }, { role: "correctness", verdict: "approve" }] });
  expect(verifyReviewProvenance({ handoff: forged, record: rejected, prHeadSha: HEAD, expectedRunId: RUN }).reason).toMatch(/are not the ones the review run recorded/);
  // 커밋이 다르다 — 기록은 우리가 실제로 체크아웃한 sha를 싣는다.
  expect(verifyReviewProvenance({ handoff: { ...honest, head_sha: "f".repeat(40) }, record, prHeadSha: HEAD, expectedRunId: RUN }).reason).toMatch(/the handoff claims/);
  expect(verifyReviewProvenance({ handoff: honest, record, prHeadSha: "9".repeat(40), expectedRunId: RUN }).reason).toMatch(/the review run checked out/);
  // review가 아닌 스테이지가 쓴 줄은 리뷰 증거가 아니다.
  expect(verifyReviewProvenance({ handoff: honest, record: { ...record, stage: "implement" }, prHeadSha: HEAD, expectedRunId: RUN }).reason).toMatch(/written by the "implement" stage/);
  // 런을 지목하지 않는 줄도 증거가 아니다.
  expect(verifyReviewProvenance({ handoff: honest, record: { ...record, runId: "none" }, prHeadSha: HEAD, expectedRunId: RUN }).reason).toMatch(/names no factory run/);
});

/**
 * ADR-024 / KTB-42 — `qa_manifest=<sha256>`는 이 줄의 **선택** 필드다. 매니페스트 파일은 커밋되지
 * 않으므로(`.factory/out/`는 gitignore) 머지 스테이지가 볼 수 있는 유일한 증인이 이 값이고, 동시에
 * 이 기능 이전의 기록과 qa 없는 tier의 기록은 그 필드 없이 그대로 읽혀야 한다.
 */
test("KTB-42: the review-evidence line carries the qa manifest digest, and an old line without it still parses", () => {
  const digest = "a".repeat(64);
  const line = reviewEvidenceLine({ runId: "7", runnerId: "gha-7", headSha: "b".repeat(40), round: 1, decision: "approved", verdicts: [{ role: "qa", verdict: "approve" }], qaManifest: digest });
  expect(line).toContain(`qa_manifest=${digest}`);
  expect(parseReviewEvidence(`## review · 2026-09-14T09:02Z · gha-7\n${line}\n`, { runId: "7" }).qaManifest).toBe(digest);

  // 지문 없이 쓴 줄(로스터에 qa가 없는 tier)은 `none`으로 나가고 null로 읽힌다.
  const bare = reviewEvidenceLine({ runId: "7", runnerId: "gha-7", headSha: "b".repeat(40), round: 1, decision: "approved", verdicts: [] });
  expect(parseReviewEvidence(`## review · 2026-09-14T09:02Z · gha-7\n${bare}\n`, { runId: "7" }).qaManifest).toBe(null);

  // KTB-42 이전에 쓰인 줄(필드 자체가 없다)도 계속 읽힌다 — append-only 로그는 뒤를 부정하지 않는다.
  const legacy = "review-evidence: run_id=7 runner=gha-7 head_sha=" + "b".repeat(40) + " round=1 decision=approved verdicts=qa=approve";
  const parsed = parseReviewEvidence(`## review · 2026-09-14T09:02Z · gha-7\n${legacy}\n`, { runId: "7" });
  expect(parsed.qaManifest).toBe(null);
  expect(parsed.verdicts).toBe("qa=approve");
});
