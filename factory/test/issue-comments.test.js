import { test, expect } from "vitest";
import { blockedOrigin, extractNeedsHuman } from "../lib/retro/issue-comments.js";

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
