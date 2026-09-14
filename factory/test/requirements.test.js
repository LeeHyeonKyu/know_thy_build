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
  expect(r(checked({ comments: [c("review", review)], prHeadSha: sha, rosterSize: 2, roster: ["a", "b"] })).ok).toBe(true);
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
    expect(r(checked({ comments: [c("review", { ...review, round })], prHeadSha: sha, rosterSize: 1, roster: ["a"], maxRounds: 3 })).ok, `round ${round}`).toBe(true);
  }
});

test("merged requires checks + integrity GREEN and approved handoff sha == PR head", () => {
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 1, verdicts: [{ role: "a", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] }], orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:merged");
  const base = checked({ comments: [c("review", review)], prHeadSha: sha, roster: ["a"] });
  expect(r({ ...base, checksGreen: true, integrityGreen: true }).ok).toBe(true);
  expect(r({ ...base, checksGreen: false, integrityGreen: true }).reason).toMatch(/checks/);
  expect(r({ ...base, checksGreen: true, integrityGreen: false }).reason).toMatch(/integrity/);
  // 확인하지 않았으면(플래그 부재) 통과가 아니라 거부다
  expect(r(base).ok).toBe(false);
  expect(r(base).reason).toMatch(/not verified GREEN/);
  expect(r({ ...base, checksGreen: true }).reason).toMatch(/integrity check not verified GREEN/);
});

/**
 * 외부 감사 2026-09-14 H1c — **`factory:merged` 규칙이 정족수를 다시 센다.**
 *
 * 감사 시점의 규칙은 `need(review)` + 게이트 + sha 바인딩 + checks/integrity뿐이었다: review handoff가
 * "있고 스키마에 맞으면" 통과였고, 정족수·all-approve는 `factory:approved`에만 있었다. 그런데
 * `factory:approved` 라벨은 훅 우회(H1a)로도 붙고, `merge-stage.js`는 `mergePr`를 이 규칙보다 **먼저**
 * 부른다 — 곧 되돌릴 수 없는 단계의 마지막 방어선이 리뷰를 세지 않고 있었다.
 */
test("H1c: factory:merged re-checks quorum, all-approve (recomputed from must_fix) and K — not only that a review handoff exists", () => {
  const v = (role, verdict = "approve") => ({ role, verdict, confidence: "high", must_fix: verdict === "reject" ? [{ id: `${role}1`, where: "w", claim: "c", evidence: "e" }] : [], should_fix: [], verified: [] });
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 2, verdicts: [v("a"), v("b")], orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:merged");
  const ctx = (over = {}) => checked({ comments: [c("review", over.review ?? review)], prHeadSha: sha, rosterSize: 2, roster: ["a", "b"], maxRounds: 3, checksGreen: true, integrityGreen: true, ...over });

  expect(r(ctx()).ok).toBe(true);
  // 정족수 미달
  expect(r(ctx({ review: { ...review, verdicts: [v("a")] } })).reason).toMatch(/verdict count 1 != roster size 2/);
  // 한 역할이 두 번 — 개수는 맞지만 로스터가 비었다
  expect(r(ctx({ review: { ...review, verdicts: [v("a"), v("a")] } })).reason).toMatch(/review incomplete — b/);
  // 자기 신고 decision은 무시한다 — verdict가 판정이다
  expect(r(ctx({ review: { ...review, decision: "approved", verdicts: [v("a"), v("b", "reject")] } })).reason).toMatch(/not all approve/);
  // 모두 approve여도 must_fix에서 다시 계산한다 — uphold된 ruling이 rework을 되살린다
  expect(r(ctx({ review: { ...review, decision: "approved", rulings: [{ id: "cf1", ruling: "uphold", by: "a" }] } })).reason).toMatch(/recomputed from must_fix is "rework"/);
  // K 초과 — approved와 달리 되돌릴 수 없는 이 전이에서는 막는다
  expect(r(ctx({ review: { ...review, round: 4 } })).reason).toMatch(/round 4 > K=3/);
  // K를 모르면(구형 배선) 라운드는 묻지 않는다 — 정족수는 그대로 문다
  expect(r(ctx({ review: { ...review, round: 4 }, maxRounds: undefined })).ok).toBe(true);
});

test("approved/merged도 게이트 파일을 요구한다 — 없으면 missing, GREEN이 아니면 거부 (전이 경로에서만)", () => {
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 1, verdicts: [{ role: "a", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] }], orchestration: "workflow", guarantee: "verified" };
  // KTB-42 SF-5 — 로스터는 이제 **명시돼야 한다**: "모르겠다"는 qa 요구조건의 면제가 아니다.
  const ctx = { comments: [c("review", review)], prHeadSha: sha, rosterSize: 1, roster: ["a"], maxRounds: 3, checksGreen: true, integrityGreen: true, gatesChecked: true };
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

/**
 * ADR-020 KTB-32 — **사람의 재시도가 착지하는 자리도 같은 종류의 "복구"다.** `--human --retry`는
 * 이미 얻었던 라벨을 되돌리는 것이지 새 성취를 주장하는 것이 아니다: 사람의 노트북에는 이번 런의
 * `.factory/out/gates.json`도, 그 sha 바인딩도 존재할 수 없다(그 판정은 스테이지가 다시 돌면서
 * 만든다). 그래서 `humanRetry`는 `prerequisite`와 **같은 것만** 건너뛴다 — handoff의 존재와 유효성
 * (= implement handoff + PR 번호)은 그대로 물린다. 그것이 "PR이 온전하다"의 증거이기 때문이다.
 */
test("KTB-32: humanRetry lands on awaiting-review with only the implement handoff — gates/sha are the re-run's job", () => {
  const impl = { schema: "factory.implement.v1", issue: 7, head_sha: sha, pr: 9, gates: { status: "GREEN", level: "full" }, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:awaiting-review");
  expect(r({ comments: [c("implement", impl)], headSha: "f".repeat(40), humanRetry: true }).ok).toBe(true);
  // handoff가 아예 없으면(= 구현이 끝난 적이 없으면) 재시도도 여기 착지하지 못한다
  expect(r({ comments: [], humanRetry: true }).reason).toMatch(/implement handoff missing/);
  // handoff는 있지만 verifier가 거절했으면 그대로 거부된다 — 재시도가 판정을 덮지 않는다
  expect(r({ comments: [c("implement", { ...impl, verifier: { verdict: "rejected" } })], humanRetry: true }).reason).toMatch(/verifier rejected/);
  // rework에는 애초에 규칙이 없다(그래서 재시도가 그대로 통과한다). ready·planned는 각자의
  // handoff를 계속 요구한다 — 재시도는 게이트/sha만 면제하지 산출물의 존재를 면제하지 않는다.
  expect(requirementFor("factory:rework")({ comments: [], humanRetry: true }).ok).toBe(true);
  expect(requirementFor("factory:planned")({ comments: [], humanRetry: true }).reason).toMatch(/plan handoff missing/);
  expect(requirementFor("factory:ready")({ comments: [], humanRetry: true }).reason).toMatch(/triage handoff missing/);
});

/**
 * ── ADR-024 / KTB-42 — **qa 증거는 계약이고, 계약은 전이에서 물린다.** ─────────────────────────
 * 규칙은 로스터에 `qa`가 있을 때만 발화한다(부르지 않은 사람이 남기지 않은 증거는 결함이 아니다 —
 * ADR-020 F3의 그 문장). 그리고 두 자리가 **서로 다른 재료**를 본다: 승인은 매니페스트 파일
 * (`ctx.qaEvidence`), 머지는 review 런이 run 기록에 남긴 지문(`ctx.qaManifestRecorded`) — 머지 잡의
 * 새 체크아웃에 `.factory/out/`는 존재하지 않기 때문이다.
 */
test("KTB-42: approved needs a valid qa manifest for the PR head when the roster includes qa", () => {
  const v = (role) => ({ role, verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] });
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 1, verdicts: [v("correctness"), v("qa")], orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:approved");
  const ctx = (over) => checked({ comments: [c("review", review)], prHeadSha: sha, rosterSize: 2, roster: ["correctness", "qa"], ...over });

  expect(r(ctx({ qaEvidence: { ok: true, digest: "a".repeat(64), head_sha: sha } })).ok).toBe(true);
  // 확인하지 않은 것은 통과가 아니다(fail closed) — 게이트 파일과 같은 원칙.
  expect(r(ctx({})).reason).toMatch(/qa evidence manifest not verified/);
  // 거부 문구는 **id를 부른다** — "디렉터리가 비었다"가 KTB #3의 8라운드를 만든 문장이다.
  expect(r(ctx({ qaEvidence: { ok: false, missing: ["dw2", "dw4"], reason: "incomplete" } })).reason).toMatch(/spec-evidence-missing: dw2, dw4/);
  // 지난 라운드의 증거는 이 트리의 얘기가 아니다.
  expect(r(ctx({ qaEvidence: { ok: true, digest: "a".repeat(64), head_sha: "e".repeat(40) } })).reason).toMatch(/qa evidence manifest describes/);
  // 로스터에 qa가 없으면 규칙 자체가 발화하지 않는다.
  const noQa = checked({ comments: [c("review", { ...review, verdicts: [v("correctness")] })], prHeadSha: sha, rosterSize: 1, roster: ["correctness"] });
  expect(r(noQa).ok).toBe(true);
});

test("KTB-42: merged needs the review run's recorded qa_manifest digest — the file itself is unreadable there", () => {
  const v = (role) => ({ role, verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] });
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 1, verdicts: [v("correctness"), v("qa")], orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:merged");
  const ctx = (over) => checked({ comments: [c("review", review)], prHeadSha: sha, rosterSize: 2, roster: ["correctness", "qa"], checksGreen: true, integrityGreen: true, ...over });

  expect(r(ctx({ qaManifestRecorded: "b".repeat(64) })).ok).toBe(true);
  expect(r(ctx({})).reason).toMatch(/qa evidence not bound/);
  expect(r(ctx({ qaManifestRecorded: "none" })).reason).toMatch(/qa evidence not bound/);
  // 파일까지 읽을 수 있는 호출자라면 지문이 그때 그것인지도 본다.
  expect(r(ctx({ qaManifestRecorded: "b".repeat(64), qaEvidence: { ok: true, digest: "c".repeat(64) } })).reason).toMatch(/changed after the review run/);
  // 복구 경로(blocked hop-back)는 게이트와 같은 취급을 받는다 — 그 자리엔 아직 이번 런의 증거가 없다.
  expect(r(ctx({ prerequisite: true })).ok).toBe(true);
});

/**
 * 리뷰 라운드 1 SF-5 — **로스터를 모르면 면제가 아니다.** 예전에는 `ctx.roster`가 비어 있으면
 * (조회 실패로 `buildCtxExtra`가 비워 둔 경우 포함) qa 요구조건이 조용히 꺼졌다. 이 파일의 나머지가
 * 전부 "확인되지 않은 것은 거부"인데 여기만 반대 방향이었다.
 */
test("KTB-42/SF-5: an unresolved roster refuses — it does not silently disable the qa requirement", () => {
  const v = (role) => ({ role, verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] });
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 1, verdicts: [v("correctness")], orchestration: "workflow", guarantee: "verified" };
  const base = { comments: [c("review", review)], prHeadSha: sha, rosterSize: 1, checksGreen: true, integrityGreen: true };
  for (const to of ["factory:approved", "factory:merged"]) {
    expect(requirementFor(to)(checked({ ...base })).reason, to).toMatch(/review roster unresolved/);
    // 로스터를 **알고** qa가 없으면 그대로 통과한다 — 규칙은 무지가 아니라 사실에 반응한다.
    expect(requirementFor(to)(checked({ ...base, roster: ["correctness"] })).ok, to).toBe(true);
  }
});
