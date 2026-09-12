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

test("blockedOrigin returns {from, stage} from the marker", () => {
  const comments = [marker("factory:approved", "merge", "2026-09-11T00:00:00Z")];
  expect(blockedOrigin(comments)).toEqual({ from: "factory:approved", stage: "merge" });
});

test("blockedOrigin takes the LAST marker when an issue was blocked more than once", () => {
  const comments = [
    marker("factory:in-progress", "implement", "2026-09-11T00:00:00Z"),
    { id: 2, body: "<!-- factory-transition:v1 from=factory:blocked to=factory:planned by=script -->\nblocked → planned", createdAt: "2026-09-11T00:05:00Z" },
    marker("factory:approved", "merge", "2026-09-11T01:00:00Z"),
  ];
  expect(blockedOrigin(comments)).toEqual({ from: "factory:approved", stage: "merge" });
});

test("extractNeedsHuman is unaffected by the presence of a blocked-origin marker on an unrelated comment", () => {
  const comments = [marker("factory:approved", "merge", "2026-09-11T00:00:00Z")];
  expect(extractNeedsHuman(7, comments)).toEqual([]);
});
