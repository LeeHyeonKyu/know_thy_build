import { test, expect } from "vitest";
import { blockedOrigin, extractNeedsHuman, lastTransition } from "../lib/retro/issue-comments.js";

// ── KTB-15b I2: factory-blocked-origin marker parsing ──────────────────────────────────────────
// lib/transition.js writes this marker at the moment a transition into factory:blocked succeeds —
// run-stage's entry guard (BLOCKED_RETRY) and the sweeper's blocked arm both read it back through
// this helper instead of re-deriving the fact from transition-comment history.

const marker = (from, stage, at) => ({ id: 1, body: `<!-- factory-transition:v1 from=${from} to=factory:blocked by=script -->\n${from} → factory:blocked — x\n<!-- factory-blocked-origin from=${from} stage=${stage} -->`, createdAt: at });

test("blockedOrigin returns null when no marker is present", () => {
  expect(blockedOrigin([])).toBeNull();
  expect(blockedOrigin([{ id: 1, body: "just a human note", createdAt: "x" }])).toBeNull();
});

test("blockedOrigin returns {from, stage, reason} from the marker", () => {
  const comments = [marker("factory:approved", "merge", "2026-09-11T00:00:00Z")];
  expect(blockedOrigin(comments)).toEqual({ from: "factory:approved", stage: "merge", reason: "x" });
});

test("blockedOrigin takes the LAST marker when an issue was blocked more than once", () => {
  const comments = [
    marker("factory:in-progress", "implement", "2026-09-11T00:00:00Z"),
    { id: 2, body: "<!-- factory-transition:v1 from=factory:blocked to=factory:planned by=script -->\nblocked → planned", createdAt: "2026-09-11T00:05:00Z" },
    marker("factory:approved", "merge", "2026-09-11T01:00:00Z"),
  ];
  expect(blockedOrigin(comments)).toEqual({ from: "factory:approved", stage: "merge", reason: "x" });
});

// ── KTB-22: the reason text (used by the sweeper to detect an api-error origin) ─────────────────

test("blockedOrigin: reason is '' when the marker was re-posted without a transition line (merge-stage's toBlocked self-retry)", () => {
  const comments = [{ id: 1, body: "<!-- factory-blocked-origin from=factory:approved stage=merge -->\n머지 재시도가 다시 판정 불가로 멈췄습니다. 사유: gates BLOCKED", createdAt: "x" }];
  expect(blockedOrigin(comments)).toEqual({ from: "factory:approved", stage: "merge", reason: "" });
});

test("blockedOrigin: reason carries the api-error provider message when that's why the transition landed on blocked", () => {
  const body = `<!-- factory-transition:v1 from=factory:planned to=factory:blocked by=script -->\nfactory:planned → factory:blocked — claude -p api error 429: You've hit your org's monthly spend limit\n<!-- factory-blocked-origin from=factory:planned stage=implement -->`;
  expect(blockedOrigin([{ id: 1, body, createdAt: "x" }])).toEqual({ from: "factory:planned", stage: "implement", reason: "claude -p api error 429: You've hit your org's monthly spend limit" });
});

test("extractNeedsHuman is unaffected by the presence of a blocked-origin marker on an unrelated comment", () => {
  const comments = [marker("factory:approved", "merge", "2026-09-11T00:00:00Z")];
  expect(extractNeedsHuman(7, comments)).toEqual([]);
});

// ── ADR-020 KTB-23 fix — sweeper의 하네스 주차 해제 팔은 "마지막 전이의 사유"로 판정한다 ────────
// `factory:needs-info`는 두 가지 뜻을 겸한다: triage의 "이슈가 모호하다"(사람이 보강해야 한다)와
// 하네스 대기. 전자를 자동으로 큐에 되돌리면 같은 모호함으로 triage를 다시 돌린다.
test("lastTransition returns the most recent transition comment with its reason", () => {
  const c = (from, to, reason, at) => ({ id: 1, body: `<!-- factory-transition:v1 from=${from} to=${to} by=script -->\n${from} → ${to}${reason ? ` — ${reason}` : ""}`, createdAt: at });
  expect(lastTransition([])).toBeNull();
  expect(lastTransition([{ id: 1, body: "사람이 쓴 코멘트", createdAt: "x" }])).toBeNull();
  expect(lastTransition([c("factory:in-progress", "factory:needs-info", "waiting for harness issue #31", "t1")])).toEqual({
    from: "factory:in-progress", to: "factory:needs-info", by: "script", reason: "waiting for harness issue #31", at: "t1",
  });
  // 마지막 것이 이긴다 — 주차 뒤에 사람이 움직였으면 그 사실이 최신이다
  const moved = lastTransition([
    c("factory:in-progress", "factory:needs-info", "waiting for harness issue #31", "t1"),
    c("factory:needs-info", "factory:queue", "human unstick", "t2"),
  ]);
  expect(moved.to).toBe("factory:queue");
  // 사유가 없는 전이는 빈 문자열이다(null이 아니다 — 호출자가 정규식을 그대로 걸 수 있어야 한다)
  expect(lastTransition([c("backlog", "factory:queue", "", "t")]).reason).toBe("");
});
