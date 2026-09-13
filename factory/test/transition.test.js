import { test, expect, vi } from "vitest";
import { transition } from "../lib/transition.js";
import { renderHandoff } from "../lib/handoff.js";

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
