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
