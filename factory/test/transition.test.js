import { test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { transition, parseTransitionArgs, refuseHumanFlag } from "../lib/transition.js";
import { renderHandoff } from "../lib/handoff.js";
import { TRANSITION_TO, blockedOrigin, commentsSinceRequeue, countTransitionsTo, extractNeedsHuman, lastTransition, resumePoint } from "../lib/retro/issue-comments.js";

function fakeGh(labels, comments = []) {
  return { issue: vi.fn(async () => ({ number: 7, title: "t", body: "", labels })), comments: vi.fn(async () => comments),
    setFactoryLabel: vi.fn(async () => {}), comment: vi.fn(async () => "url#issuecomment-1") };
}

// 리뷰 aab3db8 — 세 번째 자물쇠: 라이브러리 함수 자신이 에이전트/러너 env에서 --human/--retry를 거절한다.
// (`node -e "import('lib/transition.js')…"`는 훅의 `--human` 토큰도, CLI 래퍼의 검사도 지나치기 때문.)
test("human/retry from an agent or runner env is refused inside transition() before any gh call", async () => {
  for (const env of [{ CLAUDE_PROJECT_DIR: "/w" }, { GITHUB_ACTIONS: "true" }]) {
    const gh = fakeGh(["factory:needs-human"]);
    const r = await transition({ gh, issue: 7, to: null, human: true, env: {}, retry: true, env });
    expect(r.ok).toBe(false); expect(r.reason).toMatch(/agent\/runner session/);
    expect(gh.issue).not.toHaveBeenCalled(); expect(gh.setFactoryLabel).not.toHaveBeenCalled();
  }
  // 사람의 셸(둘 다 없음)에서는 이 자물쇠가 열려 다음 검사(resume point)로 간다.
  const gh = fakeGh(["factory:needs-human"]);
  const r = await transition({ gh, issue: 7, to: null, human: true, retry: true, env: {} });
  expect(gh.issue).toHaveBeenCalled(); expect(r.reason).not.toMatch(/agent\/runner session/);
});

test("graph violation → ok:false, no label change", async () => {
  const gh = fakeGh(["backlog"]);
  const r = await transition({ gh, issue: 7, to: "factory:approved" });
  expect(r.ok).toBe(false); expect(r.reason).toMatch(/not allowed/);
  expect(gh.setFactoryLabel).not.toHaveBeenCalled();
});

test("graph violation → refusal comment posted (visible), no label change", async () => {
  const gh = fakeGh(["backlog"]);
  const r = await transition({ gh, issue: 7, to: "factory:approved" });
  expect(r.ok).toBe(false); expect(r.reason).toMatch(/not allowed/);
  expect(gh.setFactoryLabel).not.toHaveBeenCalled();
  expect(gh.comment).toHaveBeenCalledTimes(1);
  expect(gh.comment.mock.calls[0][1]).toMatch(/factory-transition-refused from=backlog to=factory:approved/);
  expect(gh.comment.mock.calls[0][1]).toMatch(/not allowed/);
});

test("graph violation with human:true → no comment, no label change", async () => {
  const gh = fakeGh(["backlog"]);
  const r = await transition({ gh, issue: 7, to: "factory:approved", human: true, env: {} });
  expect(r.ok).toBe(false);
  expect(gh.comment).not.toHaveBeenCalled();
  expect(gh.setFactoryLabel).not.toHaveBeenCalled();
});

test("requirement failure → moves to needs-human with refusal comment", async () => {
  const gh = fakeGh(["factory:ready"]);   // no plan handoff
  const r = await transition({ gh, issue: 7, to: "factory:planned" });
  expect(r.ok).toBe(false);
  expect(gh.setFactoryLabel).toHaveBeenCalledWith(7, "factory:needs-human");
  expect(gh.comment.mock.calls[0][1]).toMatch(/factory-transition-refused/);
  expect(gh.comment.mock.calls[0][1]).toMatch(/plan handoff missing/);
});

test("requirement pass → label set + transition comment", async () => {
  const triage = renderHandoff({ stage: "triage", issue: 7, summary: "s", data: { schema: "factory.triage.v1", issue: 7, disposition: "ready", tier: "docs" } });
  const gh = fakeGh(["factory:queue"], [{ id: 1, body: triage, createdAt: "2026-09-11T00:00:00Z" }]);
  const r = await transition({ gh, issue: 7, to: "factory:ready" });
  expect(r).toEqual({ ok: true, from: "factory:queue", to: "factory:ready" });
  expect(gh.setFactoryLabel).toHaveBeenCalledWith(7, "factory:ready");
  expect(gh.comment.mock.calls[0][1]).toMatch(/factory-transition:v1 from=factory:queue to=factory:ready by=script/);
});

test("human override: requirement failure returns reason, does not move to needs-human", async () => {
  const gh = fakeGh(["factory:ready"]);
  const r = await transition({ gh, issue: 7, to: "factory:planned", human: true, env: {}, reason: "manual" });
  expect(r.ok).toBe(false); expect(r.reason).toMatch(/plan handoff missing/);
  expect(gh.setFactoryLabel).not.toHaveBeenCalled();
});

test("issue with no factory label is treated as from=null and rejected", async () => {
  const gh = fakeGh(["bug"]);
  const r = await transition({ gh, issue: 7, to: "factory:queue" });
  expect(r.ok).toBe(false); expect(r.reason).toMatch(/no factory state label/);
});

// ── KTB-15b I2: a successful transition into factory:blocked leaves an origin marker ───────────
test("a successful transition into factory:blocked leaves a factory-blocked-origin marker naming the stage", async () => {
  const gh = fakeGh(["factory:approved"]);
  const r = await transition({ gh, issue: 7, to: "factory:blocked", reason: "merge API failed", stage: "merge" });
  expect(r).toEqual({ ok: true, from: "factory:approved", to: "factory:blocked" });
  expect(gh.comment.mock.calls[0][1]).toMatch(/<!-- factory-blocked-origin from=factory:approved stage=merge cause=other -->/);
});

test("the origin marker falls back to stage=unknown when the caller didn't pass one", async () => {
  const gh = fakeGh(["factory:in-progress"]);
  await transition({ gh, issue: 7, to: "factory:blocked", reason: "x" });
  expect(gh.comment.mock.calls[0][1]).toMatch(/<!-- factory-blocked-origin from=factory:in-progress stage=unknown cause=other -->/);
});

// ── ADR-020 O20 — blocked으로 가는 전이는 **원인 등급**을 마커에 싣는다 ─────────────────────────
test("the origin marker derives the cause class from the reason when the caller passes none", async () => {
  const gh = fakeGh(["factory:awaiting-review"]);
  await transition({ gh, issue: 7, to: "factory:blocked", reason: "job cancelled — retry via sweeper", stage: "review" });
  expect(gh.comment.mock.calls[0][1]).toMatch(/<!-- factory-blocked-origin from=factory:awaiting-review stage=review cause=cancelled -->/);
});

test("an explicit cause wins over the derived one (abortStage knows the job status first-hand)", async () => {
  const gh = fakeGh(["factory:awaiting-review"]);
  await transition({ gh, issue: 7, to: "factory:blocked", reason: "job failure — retry via sweeper", stage: "review", cause: "timeout" });
  expect(gh.comment.mock.calls[0][1]).toMatch(/cause=timeout -->/);
});

// ── ADR-020 KTB-30 — 쓴 뒤 확인에서 되살린 라벨은 이슈 이력에 한 줄로 남는다 ─────────────────────
test("a repaired label verify is recorded in its own comment and in the result", async () => {
  const gh = fakeGh(["factory:in-progress"]);
  gh.setFactoryLabel = vi.fn(async () => ({ label: "factory:blocked", removed: ["factory:in-progress"], verify: "repaired" }));
  const r = await transition({ gh, issue: 7, to: "factory:blocked", reason: "x", stage: "implement" });
  expect(r).toEqual({ ok: true, from: "factory:in-progress", to: "factory:blocked", labelVerify: "repaired" });
  // 전이 코멘트는 스왑보다 **먼저** 나가므로(아래 KTB-30 r1) 복구 사실은 그 뒤의 별도 코멘트다.
  expect(gh.comment.mock.calls[1][1]).toMatch(/label verify: repaired/);
  // 그 코멘트는 전이 마커를 들고 있지 않다 — `lastTransition`이 이것을 "최신 전이"로 읽으면 안 된다
  expect(gh.comment.mock.calls[1][1]).not.toMatch(/factory-transition:v1/);
});

/**
 * ADR-020 KTB-30 r1(VERIFY) — **전이 코멘트가 라벨 스왑보다 먼저 나가야 한다.**
 *
 * KTB-30은 라벨 스왑을 add-first로 뒤집었고(부분 실패 = "상태 라벨 2개"), sweeper의 복구 팔은 그 둘 중
 * 어느 쪽이 진짜인지를 **가장 최근 전이 코멘트의 `to`**로 판단한다. 코멘트가 스왑 뒤에 나가면, 스왑이
 * 중간에 끊긴 바로 그 순간의 이슈에는 새 전이 코멘트가 아직 없다 — 최신 전이는 **이전** 전이이고 그
 * `to`는 옛 라벨이다. 복구는 그 옛 라벨로 이슈를 정리하면서 방금 성공한 전이를 조용히 되돌린다.
 */
test("transition comment precedes label mutation", async () => {
  const order = [];
  const triage = renderHandoff({ stage: "triage", issue: 7, summary: "s", data: { schema: "factory.triage.v1", issue: 7, disposition: "ready", tier: "docs" } });
  const gh = fakeGh(["factory:queue"], [{ id: 1, body: triage, createdAt: "2026-09-11T00:00:00Z" }]);
  gh.comment = vi.fn(async (n, body) => { order.push(/factory-transition:v1/.test(body) ? "transition-comment" : "other-comment"); return "u"; });
  gh.setFactoryLabel = vi.fn(async () => { order.push("label"); return { label: "factory:ready", removed: [], verify: "ok" } });
  expect((await transition({ gh, issue: 7, to: "factory:ready", stage: "triage" })).ok).toBe(true);
  expect(order).toEqual(["transition-comment", "label"]);

  // 스왑이 통째로 실패해도 라벨은 하나(옛 것) 그대로다 — 복구 팔은 2개·0개에만 반응하므로 조용하다.
  // 실패는 삼키지 않는다: 호출자가 보고 기록한다.
  const boom = fakeGh(["factory:queue"], [{ id: 1, body: triage, createdAt: "2026-09-11T00:00:00Z" }]);
  boom.setFactoryLabel = vi.fn(async () => { throw new Error("gh api 502"); });
  await expect(transition({ gh: boom, issue: 7, to: "factory:ready", stage: "triage" })).rejects.toThrow(/502/);
});

test("a transition NOT into blocked never carries the origin marker", async () => {
  const triage = renderHandoff({ stage: "triage", issue: 7, summary: "s", data: { schema: "factory.triage.v1", issue: 7, disposition: "ready", tier: "docs" } });
  const gh = fakeGh(["factory:queue"], [{ id: 1, body: triage, createdAt: "2026-09-11T00:00:00Z" }]);
  await transition({ gh, issue: 7, to: "factory:ready", stage: "triage" });
  expect(gh.comment.mock.calls[0][1]).not.toMatch(/factory-blocked-origin/);
});

/**
 * ADR-020 r2 SF3(리뷰 finding 3) — **요구사항 미달 거부도 앞으로 복구돼야 한다.** r1은 성공 경로의
 * 순서만 뒤집었고 이 경로는 스왑 → 코멘트 그대로였다. 그 순서에서 add는 되고 remove가 실패하면
 * (KTB-30의 add-first) 라벨은 `{옛 것, needs-human}`인데 코멘트는 아직 없다 — 라벨-셋 복구 팔이
 * "최신 전이의 `to`"로 **옛 라벨**을 골라 방금 세운 에스컬레이션을 조용히 되돌린다.
 */
test("SF3: the requirement-refusal path comments BEFORE the swap and carries a transition:v1 marker", async () => {
  const order = [];
  const gh = fakeGh(["factory:ready"]);                              // plan handoff 없음 → 요구사항 미달
  gh.comment = vi.fn(async (n, body) => { order.push(/factory-transition:v1/.test(body) ? "transition-comment" : "other-comment"); return "u"; });
  gh.setFactoryLabel = vi.fn(async () => { order.push("label"); return { label: "factory:needs-human", removed: ["factory:ready"], verify: "ok" }; });
  const r = await transition({ gh, issue: 7, to: "factory:planned" });
  expect(r).toMatchObject({ ok: false, to: "factory:needs-human" });
  expect(order).toEqual(["transition-comment", "label"]);
  const body = gh.comment.mock.calls[0][1];
  expect(body).toMatch(/<!-- factory-transition:v1 from=factory:ready to=factory:needs-human by=script reason=refused -->/);
  expect(body).toMatch(/factory-transition-refused from=factory:ready to=factory:planned/);   // 옛 마커도 그대로
  expect(lastTransition([{ body, createdAt: "t" }])).toMatchObject({ from: "factory:ready", to: "factory:needs-human" });
  // 그 코멘트 하나로 수확 통계의 사유도 그대로 읽힌다(두 번 세지 않는다)
  expect(extractNeedsHuman(7, [{ body, createdAt: "t" }])).toEqual([{ issue: 7, reason: expect.stringContaining("plan handoff missing"), at: "t" }]);
});

/**
 * ADR-020 r2 (리뷰 (c)) — 코멘트가 먼저 나가는 이상, 스왑이 통째로 실패하면 **일어나지 않은 전이의
 * 코멘트**가 남는다. 그 거짓말을 같은 자리에서 취소한다.
 */
test("(c): a swap that throws leaves a factory-transition-failed marker — and still throws", async () => {
  const triage = renderHandoff({ stage: "triage", issue: 7, summary: "s", data: { schema: "factory.triage.v1", issue: 7, disposition: "ready", tier: "docs" } });
  const gh = fakeGh(["factory:queue"], [{ id: 1, body: triage, createdAt: "2026-09-11T00:00:00Z" }]);
  gh.setFactoryLabel = vi.fn(async () => { throw new Error("gh api 502\nsecond line"); });
  await expect(transition({ gh, issue: 7, to: "factory:ready", stage: "triage" })).rejects.toThrow(/502/);
  expect(gh.comment.mock.calls[1][1]).toMatch(/<!-- factory-transition-failed:v1 from=factory:queue to=factory:ready -->/);
  expect(gh.comment.mock.calls[1][1]).toMatch(/gh api 502/);
  expect(gh.comment.mock.calls[1][1]).not.toMatch(/second line/);     // 한 줄만 싣는다

  // 그 마커 코멘트 자체가 실패해도 원래 예외가 그대로 올라간다(기록의 실패가 원인을 가리지 않는다)
  const mute = fakeGh(["factory:queue"], [{ id: 1, body: triage, createdAt: "2026-09-11T00:00:00Z" }]);
  mute.setFactoryLabel = vi.fn(async () => { throw new Error("gh api 502"); });
  mute.comment = vi.fn(async (n, body) => { if (/failed/.test(body)) throw new Error("comment down"); return "u"; });
  await expect(transition({ gh: mute, issue: 7, to: "factory:ready", stage: "triage" })).rejects.toThrow(/502/);
});

/**
 * ADR-020 최종 리뷰 SF-4 — **마커 문법은 쓰는 쪽과 읽는 쪽이 서로를 붙들어야 한다.**
 *
 * 전이 코멘트는 `lib/transition.js`가 템플릿 리터럴로 조립하고(렌더러 export가 없다),
 * `retro/issue-comments.js`의 `TRANSITION_TO`·`lastTransition`·`blockedOrigin`·`countTransitionsTo`가
 * **독립된 정규식**으로 읽는다. 그런데 열 곳이 넘는 테스트가 본문을 손으로 다시 지어 쓰고 있어서
 * (writer 쪽 테스트도 같은 리터럴에 대고 단언한다), 필드 하나를 넣거나 순서를 바꾸면 **양쪽 다 초록인
 * 채로** 프로덕션의 sweeper 팔 전부가 깨진다. 이 테스트만은 writer의 **실제 출력**을 parser에 그대로
 * 먹인다 — 손으로 지은 본문은 한 글자도 쓰지 않는다.
 */
test("SF-4 round-trip: every transition marker the writer emits is read back by the parsers", async () => {
  const triage = renderHandoff({ stage: "triage", issue: 7, summary: "s", data: { schema: "factory.triage.v1", issue: 7, disposition: "ready", tier: "docs" } });
  const bodies = [];
  const gh = fakeGh(["factory:queue"], [{ id: 1, body: triage, createdAt: "2026-09-11T00:00:00Z" }]);
  gh.comment = vi.fn(async (n, body) => { bodies.push({ id: bodies.length + 1, body, createdAt: "2026-09-11T01:00:00Z" }); return "u#issuecomment-1"; });

  // ① 평범한 성공 전이 — from/to/by/reason이 전부 되읽힌다
  const ok = await transition({ gh, issue: 7, to: "factory:ready", reason: "triage ready" });
  expect(ok.ok).toBe(true);
  expect(lastTransition(bodies)).toMatchObject({ from: "factory:queue", to: "factory:ready", by: "script", reason: "triage ready" });
  expect(TRANSITION_TO.exec(bodies.at(-1).body)[2]).toBe("factory:ready");

  // ② blocked 전이 — 같은 코멘트가 origin 마커(+ cause)까지 싣고, blockedOrigin이 셋 다 되읽는다
  const gh2 = fakeGh(["factory:queue"], []);
  const b2 = [];
  gh2.comment = vi.fn(async (n, body) => { b2.push({ id: b2.length + 1, body, createdAt: "2026-09-11T01:00:00Z" }); return "u#issuecomment-1"; });
  await transition({ gh: gh2, issue: 7, to: "factory:blocked", stage: "triage", reason: "claude -p api error 429: spend limit" });
  expect(blockedOrigin(b2)).toEqual({ from: "factory:queue", stage: "triage", reason: "claude -p api error 429: spend limit", cause: "api-error" });

  // ③ 실패 마커 — `countTransitionsTo`가 그것으로 앞의 전이 하나를 되돌린다(K 예산의 계약)
  const gh3 = fakeGh(["factory:awaiting-review"], []);
  const b3 = [];
  gh3.comment = vi.fn(async (n, body) => { b3.push({ id: b3.length + 1, body, createdAt: "2026-09-11T01:00:00Z" }); return "u#issuecomment-1"; });
  gh3.setFactoryLabel = vi.fn(async () => { throw new Error("gh api 502"); });
  await expect(transition({ gh: gh3, issue: 7, to: "factory:rework", reason: "must_fix remain" })).rejects.toThrow(/502/);
  expect(b3).toHaveLength(2);                                   // 전이 코멘트 + 실패 마커
  expect(countTransitionsTo(b3, "factory:rework")).toBe(0);     // 실패 마커가 앞의 전이를 무효로 만든다

  // ④ 요구사항 미달 거부(`reason=refused`) — 그것도 완료된 전이이므로 같은 파서가 읽는다
  const gh4 = fakeGh(["factory:ready"], []);
  const b4 = [];
  gh4.comment = vi.fn(async (n, body) => { b4.push({ id: b4.length + 1, body, createdAt: "2026-09-11T01:00:00Z" }); return "u#issuecomment-1"; });
  await transition({ gh: gh4, issue: 7, to: "factory:planned" });
  expect(lastTransition(b4)).toMatchObject({ from: "factory:ready", to: "factory:needs-human" });
  expect(extractNeedsHuman(7, b4)).toEqual([{ issue: 7, reason: expect.stringContaining("plan handoff missing"), at: "2026-09-11T01:00:00Z" }]);

  // ⑤ 재큐(`to=factory:queue`)는 라운드 창의 경계다 — `commentsSinceRequeue`가 writer의 출력에서 그것을 찾는다
  const gh5 = fakeGh(["factory:needs-human"], []);
  const b5 = [{ id: 0, body: "이전 주기의 코멘트", createdAt: "2026-09-11T00:00:00Z" }];
  gh5.comment = vi.fn(async (n, body) => { b5.push({ id: b5.length + 1, body, createdAt: "2026-09-11T01:00:00Z" }); return "u#issuecomment-1"; });
  await transition({ gh: gh5, issue: 7, to: "factory:queue", human: true, env: {}, reason: "unstick" });
  expect(commentsSinceRequeue(b5)).toEqual([]);                 // 재큐 코멘트 자신까지가 경계다
});

// ── ADR-020 KTB-32 — `needs-human`에서 **중단 지점으로** 되돌아가는 사람 전용 재시도 ────────────
//
// 라운드 10의 #2는 implement가 끝나 PR이 온전한 채 review에서 429로 죽었는데, `needs-human`의 유일한
// 출구가 `queue`라 사람이 할 수 있는 결정은 "plan부터 다시"(≈$40)뿐이었다. 이 엣지는 그 한 칸을
// 되돌린다 — **사람만**, 그리고 **중단 지점으로만**.

/** 전이 코멘트 하나(파서가 읽는 그 문법 그대로 — writer와의 계약은 위 SF-4 라운드트립이 지킨다). */
const tcomment = (from, to, { by = "script", at = "2026-09-13T10:00:00Z", reason = "", marker = "" } = {}) => ({
  id: Math.floor(Math.random() * 1e6),
  body: `<!-- factory-transition:v1 from=${from} to=${to} by=${by}${marker} -->\n${from} → ${to}${reason ? ` — ${reason}` : ""}`,
  createdAt: at,
});
const implementHandoff = (issue = 7) => renderHandoff({
  stage: "implement", issue, summary: "done",
  data: { schema: "factory.implement.v1", issue, head_sha: "a".repeat(40), pr: 9, gates: { status: "GREEN" }, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" },
});
/** 라운드 10의 #2·KTB #3이 실제로 남긴 모양: review가 죽어 blocked → sweeper가 needs-human으로 올림. */
const stoppedInReview = (issue = 7) => [
  { id: 1, body: implementHandoff(issue), createdAt: "2026-09-13T09:00:00Z" },
  tcomment("factory:in-progress", "factory:awaiting-review", { at: "2026-09-13T09:10:00Z" }),
  tcomment("factory:awaiting-review", "factory:blocked", { at: "2026-09-13T10:22:00Z", reason: "claude -p api error 429" }),
  tcomment("factory:blocked", "factory:needs-human", { at: "2026-09-13T10:38:00Z", reason: "blocked (API quota/outage) — needs human" }),
];

test("KTB-32: a script may not take the retry edge — needs-human → awaiting-review is refused, no label change", async () => {
  const gh = fakeGh(["factory:needs-human"], stoppedInReview());
  const r = await transition({ gh, issue: 7, to: "factory:awaiting-review" });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/not allowed/);
  expect(gh.setFactoryLabel).not.toHaveBeenCalled();
  // 평소의 그래프 거부와 똑같이 보인다 — 사람이 이슈에서 그 시도를 볼 수 있다.
  expect(gh.comment.mock.calls[0][1]).toMatch(/factory-transition-refused from=factory:needs-human to=factory:awaiting-review/);
});

test("KTB-32: `--retry` without `--human` is refused (by=script never resumes)", async () => {
  const gh = fakeGh(["factory:needs-human"], stoppedInReview());
  const r = await transition({ gh, issue: 7, retry: true });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/human/);
  expect(gh.setFactoryLabel).not.toHaveBeenCalled();
});

test("KTB-32: a human retry to a target that is not the resume point is refused (exit 2, no label change)", async () => {
  const gh = fakeGh(["factory:needs-human"], stoppedInReview());
  const r = await transition({ gh, issue: 7, to: "factory:planned", human: true, env: {}, reason: "just re-plan it" });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/factory:planned/);
  expect(r.reason).toMatch(/factory:awaiting-review/);            // 어디로 가야 하는지 사유가 말한다
  expect(gh.setFactoryLabel).not.toHaveBeenCalled();
});

test("KTB-32: a human retry to the resume point moves the label and marks the comment by=human reason=retry", async () => {
  const comments = [...stoppedInReview(), { id: 9, body: "<!-- human-decision:v1 issue=7 skill=unstick -->\n```yaml\ndecision: retry\n```", createdAt: "2026-09-14T00:00:00Z" }];
  const gh = fakeGh(["factory:needs-human"], comments);
  const r = await transition({ gh, issue: 7, to: "factory:awaiting-review", human: true, env: {}, retry: true, reason: "429 was infrastructural; PR #17 intact" });
  expect(r).toMatchObject({ ok: true, from: "factory:needs-human", to: "factory:awaiting-review" });
  expect(gh.setFactoryLabel).toHaveBeenCalledWith(7, "factory:awaiting-review");
  const body = gh.comment.mock.calls[0][1];
  expect(body).toMatch(/<!-- factory-transition:v1 from=factory:needs-human to=factory:awaiting-review by=human reason=retry -->/);
  expect(body).toMatch(/429 was infrastructural/);
  expect(body).toMatch(/human-decision:v1/);                      // 사람의 결정이 근거로 인용된다
  expect(body).toMatch(/unstick/);
});

test("KTB-32: `--retry` with no explicit label resolves the resume point from the comments", async () => {
  const gh = fakeGh(["factory:needs-human"], stoppedInReview());
  const r = await transition({ gh, issue: 7, human: true, env: {}, retry: true, reason: "infra" });
  expect(r).toMatchObject({ ok: true, to: "factory:awaiting-review" });
  expect(gh.setFactoryLabel).toHaveBeenCalledWith(7, "factory:awaiting-review");
});

test("KTB-32: resumePoint reads past the blocked → needs-human escalation to where the work actually stopped", () => {
  expect(resumePoint(stoppedInReview())).toMatchObject({ stoppedAt: "factory:awaiting-review", target: "factory:awaiting-review" });
});

test("KTB-32: resumePoint maps every origin — in-progress splits on whether implement finished", () => {
  const stop = (from) => [tcomment(from, "factory:blocked", { reason: "job cancelled" })];
  expect(resumePoint(stop("factory:ready"))).toMatchObject({ target: "factory:ready" });
  expect(resumePoint(stop("factory:planned"))).toMatchObject({ target: "factory:planned" });
  expect(resumePoint(stop("factory:rework"))).toMatchObject({ target: "factory:rework" });
  expect(resumePoint(stop("factory:awaiting-review"))).toMatchObject({ target: "factory:awaiting-review" });
  // in-progress: implement handoff이 (마지막 재큐 이후에) 있으면 구현은 끝났다 → rework로 이어간다.
  expect(resumePoint(stop("factory:in-progress"))).toMatchObject({ target: "factory:planned" });
  expect(resumePoint([{ id: 1, body: implementHandoff(), createdAt: "2026-09-13T09:00:00Z" }, ...stop("factory:in-progress")]))
    .toMatchObject({ target: "factory:rework" });
  // 재큐 **이전**의 implement handoff는 다른 주기의 것이다 — 이번 주기는 아직 구현하지 않았다.
  expect(resumePoint([
    { id: 1, body: implementHandoff(), createdAt: "2026-09-13T08:00:00Z" },
    tcomment("factory:needs-human", "factory:queue", { by: "human", at: "2026-09-13T08:30:00Z" }),
    ...stop("factory:in-progress"),
  ])).toMatchObject({ target: "factory:planned" });
  // 이력이 없거나 재개할 수 없는 자리(queue)에서 멈췄으면 목적지가 없다 — 추측하지 않는다.
  expect(resumePoint([])).toBe(null);
  expect(resumePoint(stop("factory:queue"))).toMatchObject({ stoppedAt: "factory:queue", target: null });
});

test("KTB-32: an unresolvable resume point refuses the retry instead of guessing", async () => {
  const gh = fakeGh(["factory:needs-human"], [tcomment("factory:queue", "factory:needs-human", { reason: "triage artifact invalid" })]);
  const r = await transition({ gh, issue: 7, human: true, env: {}, retry: true, reason: "x" });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/resume point/);
  expect(gh.setFactoryLabel).not.toHaveBeenCalled();
});

/**
 * 재시도는 **재큐가 아니다** — 라운드 창(`commentsSinceRequeue`)을 열지 않고, 이미 일어난 재작업
 * 주기를 다시 세지도 않는다(`reason=retry` 마커는 `countTransitionsTo`에서 빠진다). 그러지 않으면
 * rework로 되돌아가는 재시도 한 번이 K 예산을 한 칸 태운다.
 */
test("KTB-32: a retry neither resets nor burns the review round counter", async () => {
  const before = [
    tcomment("factory:needs-human", "factory:queue", { by: "human", at: "2026-09-13T07:00:00Z" }),
    { id: 2, body: implementHandoff(), createdAt: "2026-09-13T08:00:00Z" },
    tcomment("factory:awaiting-review", "factory:rework", { at: "2026-09-13T09:00:00Z", reason: "must_fix" }),
    tcomment("factory:rework", "factory:blocked", { at: "2026-09-13T09:30:00Z", reason: "job cancelled" }),
    tcomment("factory:blocked", "factory:needs-human", { at: "2026-09-13T09:40:00Z" }),
  ];
  expect(countTransitionsTo(commentsSinceRequeue(before), "factory:rework")).toBe(1);
  const after = [];
  const gh = fakeGh(["factory:needs-human"], before);
  gh.comment = vi.fn(async (n, body) => { after.push({ id: 99, body, createdAt: "2026-09-14T00:00:00Z" }); return "u"; });
  const r = await transition({ gh, issue: 7, human: true, env: {}, retry: true, reason: "cancel was infrastructural" });
  expect(r).toMatchObject({ ok: true, to: "factory:rework" });
  const all = [...before, ...after];
  expect(commentsSinceRequeue(all)).toHaveLength(before.length - 1 + after.length);   // 창은 그대로(재큐가 아니다)
  expect(countTransitionsTo(commentsSinceRequeue(all), "factory:rework")).toBe(1);    // 라운드는 그대로
});

// ── KTB-32 확장: `factory:needs-info`(하네스 대기 주차)에서도 같은 재시도가 열린다 ──────────────
//
// KTB-23의 주차는 implement 한가운데서 일어난다: builder가 `harness_needed`를 채우면 L1이 하네스
// 이슈를 하나 열고 이 이슈를 `in-progress → needs-info`로 세운다. 그 하네스 이슈를 **사람이** 손으로
// 고쳐 머지한 뒤 돌아올 자리는 `queue` 하나뿐이었다(§3.2) — 플랜은 한 글자도 바뀌지 않았는데 plan을
// 처음부터 다시 돈다. 사람이 `--retry`를 고르면 중단 지점(`needs-info`의 `from=`)으로 되돌린다.
// sweeper의 자동 해제는 그대로 `→ queue`다(스크립트가 이 엣지를 밟을 수 없는 것이 그 이유다).

const planHandoff = (issue = 7) => renderHandoff({
  stage: "plan", issue, summary: "plan",
  data: {
    schema: "factory.plan.v1", issue, tier: "standard", roles: ["product-advocate", "architect"], rounds: 3,
    done_when: [{ id: "dw1", text: "x", verify: `test_${issue}_x`, level: "unit" }],
    files_expected: ["src/a.js"], dissent_log: [], non_goals: [], open_risks: [],
  },
});
/** 라이브 모양: plan → implement 중 harness_needed → 주차. 이번 주기에 implement handoff가 없다. */
const parkedOnHarness = (issue = 7) => [
  { id: 1, body: planHandoff(issue), createdAt: "2026-09-13T07:50:00Z" },
  tcomment("factory:ready", "factory:planned", { at: "2026-09-13T08:00:00Z" }),
  tcomment("factory:planned", "factory:in-progress", { at: "2026-09-13T08:30:00Z" }),
  tcomment("factory:in-progress", "factory:needs-info", { at: "2026-09-13T09:00:00Z", reason: "waiting for harness issue #12" }),
];

test("KTB-32: resumePoint treats needs-info as a stop state — a harness park resolves to planned (or rework once implement finished)", () => {
  expect(resumePoint(parkedOnHarness())).toMatchObject({ stoppedAt: "factory:in-progress", target: "factory:planned" });
  // 이번 주기에 implement handoff가 이미 있었으면(부분 구현 뒤 주차) 재작업으로 이어간다.
  expect(resumePoint([
    tcomment("factory:planned", "factory:in-progress", { at: "2026-09-13T08:30:00Z" }),
    { id: 2, body: implementHandoff(), createdAt: "2026-09-13T08:45:00Z" },
    tcomment("factory:in-progress", "factory:needs-info", { at: "2026-09-13T09:00:00Z", reason: "waiting for harness issue #12" }),
  ])).toMatchObject({ target: "factory:rework" });
  // triage의 needs-info(`queue`에서 왔다)는 재개할 자리가 아니다 — 사람이 이슈를 보강해 재큐해야 한다.
  expect(resumePoint([tcomment("factory:queue", "factory:needs-info", { reason: "ambiguous" })]))
    .toMatchObject({ stoppedAt: "factory:queue", target: null });
  // `needs-info → queue`(sweeper 해제)는 정지 전이가 아니다 — 그 뒤에도 중단 지점은 그대로 읽힌다.
  expect(resumePoint([...parkedOnHarness(), tcomment("factory:needs-info", "factory:queue", { at: "2026-09-13T11:00:00Z", reason: "harness issue #12 closed" })]))
    .toMatchObject({ stoppedAt: "factory:in-progress", target: "factory:planned" });
});

test("KTB-32: a human retry from needs-info resumes the stop point; a script may not take that edge", async () => {
  const script = fakeGh(["factory:needs-info"], parkedOnHarness());
  const s = await transition({ gh: script, issue: 7, to: "factory:planned" });
  expect(s.ok).toBe(false);
  expect(s.reason).toMatch(/not allowed/);
  expect(script.setFactoryLabel).not.toHaveBeenCalled();

  const gh = fakeGh(["factory:needs-info"], [...parkedOnHarness(),
    { id: 9, body: "<!-- human-decision:v1 issue=7 skill=unstick -->\n```yaml\ndecision: retry\n```", createdAt: "2026-09-14T00:00:00Z" }]);
  const r = await transition({ gh, issue: 7, human: true, env: {}, retry: true, reason: "harness #12 merged by hand; the plan is unchanged" });
  expect(r).toMatchObject({ ok: true, from: "factory:needs-info", to: "factory:planned" });
  expect(gh.setFactoryLabel).toHaveBeenCalledWith(7, "factory:planned");
  const body = gh.comment.mock.calls[0][1];
  expect(body).toMatch(/<!-- factory-transition:v1 from=factory:needs-info to=factory:planned by=human reason=retry -->/);
  expect(body).toMatch(/harness #12 merged by hand/);
  expect(body).toMatch(/human-decision:v1/);
});

test("KTB-32: from needs-info the wrong target is refused, and a triage needs-info has no resume point at all", async () => {
  const wrong = fakeGh(["factory:needs-info"], parkedOnHarness());
  const w = await transition({ gh: wrong, issue: 7, to: "factory:awaiting-review", human: true, env: {}, reason: "skip ahead" });
  expect(w.ok).toBe(false);
  expect(w.reason).toMatch(/factory:planned/);
  expect(wrong.setFactoryLabel).not.toHaveBeenCalled();

  const triage = fakeGh(["factory:needs-info"], [tcomment("factory:queue", "factory:needs-info", { reason: "ambiguous" })]);
  const t = await transition({ gh: triage, issue: 7, human: true, env: {}, retry: true, reason: "x" });
  expect(t.ok).toBe(false);
  expect(t.reason).toMatch(/resume point/);
  expect(triage.setFactoryLabel).not.toHaveBeenCalled();

  // 세 자물쇠는 그대로다: 에이전트/러너 env는 `needs-info`에서도 거절된다.
  const agent = fakeGh(["factory:needs-info"], parkedOnHarness());
  const a = await transition({ gh: agent, issue: 7, human: true, retry: true, env: { GITHUB_ACTIONS: "true" } });
  expect(a.ok).toBe(false);
  expect(a.reason).toMatch(/agent\/runner session/);
  expect(agent.issue).not.toHaveBeenCalled();
});

// ── bin/transition.js의 인자 파싱(그 파일은 즉시 실행되므로 파서만 lib에 산다) ────────────────
test("KTB-32: parseTransitionArgs — label, --human, --reason, and --retry in any order", () => {
  expect(parseTransitionArgs(["7", "factory:queue", "--human", "--reason", "why"]))
    .toEqual({ issue: 7, to: "factory:queue", human: true, retry: false, reason: "why" });
  expect(parseTransitionArgs(["3", "--human", "--retry"]))
    .toEqual({ issue: 3, to: null, human: true, retry: true, reason: "" });
  expect(parseTransitionArgs(["3", "--retry", "--human", "--reason", "infra"]))
    .toEqual({ issue: 3, to: null, human: true, retry: true, reason: "infra" });
  expect(parseTransitionArgs(["3", "factory:awaiting-review", "--human", "--retry"]))
    .toEqual({ issue: 3, to: "factory:awaiting-review", human: true, retry: true, reason: "" });
  // --retry는 사람 전용이다 — 여기서 이미 막는다(lib도 한 번 더 막는다).
  expect(parseTransitionArgs(["3", "--retry"]).error).toMatch(/--human/);
  expect(parseTransitionArgs(["3"]).error).toMatch(/usage|label/i);
  expect(parseTransitionArgs([]).error).toMatch(/usage|issue/i);
  expect(parseTransitionArgs(["x", "factory:queue"]).error).toMatch(/usage|issue/i);
});

/**
 * KTB-46 r2 — **`humanMerged`/`statusesVerified`는 프로세스 밖에서 도착할 수 없다.** 그 두 플래그는
 * `requirements.js`의 게이트 검사를 "러너의 로컬 파일" 대신 "그 커밋에 붙은 팩토리 상태"로 바꾸는
 * 문이다 — CLI가 임의의 플래그를 `ctxExtra`로 흘려보낸다면 사람의 셸 한 줄이 그 문을 대신 열 수 있다.
 * 두 가지를 고정한다: ① 파서가 모르는 옵션을 **거절**한다(통과시키지 않는다), ② `bin/transition.js`가
 * 만드는 `ctxExtra`는 `gatesChecked`·`gatesFile`만 담은 **닫힌 리터럴**이다(인자에서 유도되지 않는다).
 * 유일한 생산자는 `lib/sweeper.js`의 `sweepHumanMerged`다.
 */
test("KTB-46: the transition CLI cannot inject humanMerged/statusesVerified into ctxExtra", () => {
  for (const flag of ["--human-merged", "--humanMerged", "--statuses-verified", "--ctx-extra", "--gates-checked"]) {
    expect(parseTransitionArgs(["7", "factory:merged", flag]).error, flag).toMatch(/unknown option/);
  }
  // 파싱 결과에는 ctxExtra로 흘러갈 수 있는 열린 통로가 없다 — 필드는 이 다섯뿐이다.
  expect(Object.keys(parseTransitionArgs(["7", "factory:merged"])).sort())
    .toEqual(["human", "issue", "reason", "retry", "to"]);

  // r3 nit 2: 소스 텍스트를 통째로 정규식에 거는 단언은 무해한 서식 변경에 깨지면서 정작 성질은
  // 증명하지 못한다. 증명하는 것은 위의 두 단언과, "이 이름이 그 파일에 등장하지도 않는다"이다.
  const src = readFileSync(new URL("../bin/transition.js", import.meta.url), "utf8");
  expect(src).not.toMatch(/humanMerged|statusesVerified/);
});

// ── 리뷰 review-3c63672 MF-2: refuseHumanFlag (bin/transition.js's own env refusal, the second lock) ──
// 첫 번째 자물쇠는 `hooks/block-dangerous.sh`(셸 경계, hooks.test.js). `refuseHumanFlag`는 그 훅을
// 뚫고 온 호출을 위한 방어선의 판정부다 — 순수 함수로 뺀 것은 "env가 서 있으면 false를 반환한다"를
// 프로세스를 띄우지 않고 고정하기 위해서다(CI가 아닌 로컬에서도 결정적이다).
test("refuseHumanFlag: CLAUDE_PROJECT_DIR or GITHUB_ACTIONS marks the caller as not-a-person; neither set is a person's shell (review 3c63672 MF-2)", () => {
  expect(refuseHumanFlag({ CLAUDE_PROJECT_DIR: "/repo" })).toBe(true);
  expect(refuseHumanFlag({ GITHUB_ACTIONS: "true" })).toBe(true);
  expect(refuseHumanFlag({ CLAUDE_PROJECT_DIR: "/repo", GITHUB_ACTIONS: "true" })).toBe(true);
  expect(refuseHumanFlag({})).toBe(false);
  expect(refuseHumanFlag({ FACTORY_REPO: "o/r" })).toBe(false);
});

// bin/transition.js가 이 판정을 실제로 물어 `gh`를 부르기 **전에** exit 2로 거절하는지는 실행해서
// 고정한다 — 거절이 네트워크 호출보다 먼저이므로 gh 인증이 없는 샌드박스에서도 안전하게 돈다.
test("bin/transition.js refuses --human/--retry before any gh call when CLAUDE_PROJECT_DIR or GITHUB_ACTIONS is set (review 3c63672 MF-2)", async () => {
  const { run } = await import("../lib/exec.js");
  const bin = new URL("../bin/transition.js", import.meta.url).pathname;
  for (const extraEnv of [{ CLAUDE_PROJECT_DIR: "/repo" }, { GITHUB_ACTIONS: "true" }]) {
    const r = await run("node", [bin, "3", "--human", "--retry"], { env: extraEnv });
    expect(r.code, JSON.stringify(extraEnv)).toBe(2);
    expect(r.stderr, JSON.stringify(extraEnv)).toMatch(/--human\/--retry refused/);
  }
}, 30000);
