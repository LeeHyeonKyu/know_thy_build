import { test, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendRunRecord } from "../lib/run-record.js";

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
