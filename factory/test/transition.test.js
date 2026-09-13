import { test, expect, vi } from "vitest";
import { transition } from "../lib/transition.js";
import { renderHandoff } from "../lib/handoff.js";
import { TRANSITION_TO, blockedOrigin, commentsSinceRequeue, countTransitionsTo, extractNeedsHuman, lastTransition } from "../lib/retro/issue-comments.js";

function fakeGh(labels, comments = []) {
  return { issue: vi.fn(async () => ({ number: 7, title: "t", body: "", labels })), comments: vi.fn(async () => comments),
    setFactoryLabel: vi.fn(async () => {}), comment: vi.fn(async () => "url#issuecomment-1") };
}

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
  const r = await transition({ gh, issue: 7, to: "factory:approved", human: true });
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
  const r = await transition({ gh, issue: 7, to: "factory:planned", human: true, reason: "manual" });
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
  await transition({ gh: gh5, issue: 7, to: "factory:queue", human: true, reason: "unstick" });
  expect(commentsSinceRequeue(b5)).toEqual([]);                 // 재큐 코멘트 자신까지가 경계다
});
