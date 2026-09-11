import { test, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendRunRecord } from "../lib/run-record.js";
import { usageLine } from "../bin/run-stage.js";
import { parseRunRecord, summarizeUsage } from "../lib/usage.js";

function makeRecord(root, issue, stage, now, out, extraLines = []) {
  const lines = out ? [...extraLines, usageLine(out)] : extraLines;
  return appendRunRecord({ root, issue, title: "demo issue", stage, runnerId: "gha-1", now, lines });
}

test("parses a real appendRunRecord + usageLine fixture — one stage with usage, one without", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-"));
  const out = {
    usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 10, cache_creation_input_tokens: 3 },
    total_cost_usd: 0.1234,
    num_turns: 4,
    terminal_reason: "end_turn",
    modelUsage: { "claude-sonnet-4-5": { costUSD: 0.12 }, "claude-haiku-4-5": { costUSD: 0.0034 } },
  };
  const p = makeRecord(root, 42, "implement", "2026-09-08T09:02:00Z", out);
  makeRecord(root, 42, "review", "2026-09-08T09:30:00Z", null, ["verdict: GREEN"]);

  const text = readFileSync(p, "utf8");
  const entries = parseRunRecord(text);
  expect(entries).toHaveLength(2);

  const [implement, review] = entries;
  expect(implement.stage).toBe("implement");
  expect(implement.at).toBe("2026-09-08T09:02Z");
  expect(implement.runner).toBe("gha-1");
  expect(implement.cost_usd).toBeCloseTo(0.1234);
  expect(implement.input_tokens).toBe(120);
  expect(implement.output_tokens).toBe(45);
  expect(implement.cache_read_tokens).toBe(10);
  expect(implement.cache_creation_tokens).toBe(3);
  expect(implement.num_turns).toBe(4);
  expect(implement.models).toEqual({ "claude-sonnet-4-5": 0.12, "claude-haiku-4-5": 0.0034 });

  expect(review.stage).toBe("review");
  expect(review.at).toBe("2026-09-08T09:30Z");
  expect(review.runner).toBe("gha-1");
  expect(review.cost_usd).toBeNull();
  expect(review.input_tokens).toBeNull();
  expect(review.output_tokens).toBeNull();
  expect(review.cache_read_tokens).toBeNull();
  expect(review.cache_creation_tokens).toBeNull();
  expect(review.num_turns).toBeNull();
  expect(review.models).toBeNull();
});

test("parses n/a usage line (cost_usd/num_turns/models all n/a) into nulls/empty", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-"));
  const out = { usage: {}, total_cost_usd: null, num_turns: null, terminal_reason: "error", modelUsage: {} };
  const p = makeRecord(root, 7, "triage", "2026-09-08T09:02:00Z", out);
  const [entry] = parseRunRecord(readFileSync(p, "utf8"));
  expect(entry.cost_usd).toBeNull();
  expect(entry.num_turns).toBeNull();
  expect(entry.models).toEqual({});
  expect(entry.input_tokens).toBeNull();
});

test("7-day window boundary: now-8d excluded, now-7d (exact) included", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-"));
  const costAt = (now, cost) => makeRecord(root, 99, "implement", now, {
    usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: cost, num_turns: 1, terminal_reason: "end_turn", modelUsage: {},
  });
  costAt("2026-09-15T00:00:00Z", 1); // now
  costAt("2026-09-09T00:00:00Z", 2); // now-6d
  costAt("2026-09-08T00:00:00Z", 3); // now-7d, boundary — included
  costAt("2026-09-07T00:00:00Z", 4); // now-8d — excluded

  const text = readFileSync(join(root, "docs/factory/runs/99.md"), "utf8");
  const records = new Map([["99", text]]);
  const summary = summarizeUsage(records, { now: "2026-09-15T00:00:00Z", windowDays: 7 });

  expect(summary.total.runs).toBe(4);
  expect(summary.total.cost_usd).toBeCloseTo(10);
  expect(summary.window.runs).toBe(3);
  expect(summary.window.cost_usd).toBeCloseTo(6);
  expect(summary.window.since).toBe("2026-09-08T00:00:00.000Z");
});

test("perIssue sorted by cost desc; tokens sum input/output only", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-"));
  makeRecord(root, 1, "implement", "2026-09-10T00:00:00Z", { usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 999 }, total_cost_usd: 1, num_turns: 1, terminal_reason: "end_turn", modelUsage: {} });
  makeRecord(root, 2, "implement", "2026-09-10T00:00:00Z", { usage: { input_tokens: 50, output_tokens: 5 }, total_cost_usd: 5, num_turns: 1, terminal_reason: "end_turn", modelUsage: {} });

  const text1 = readFileSync(join(root, "docs/factory/runs/1.md"), "utf8");
  const text2 = readFileSync(join(root, "docs/factory/runs/2.md"), "utf8");
  const records = new Map([["1", text1], ["2", text2]]);
  const summary = summarizeUsage(records, { now: "2026-09-15T00:00:00Z" });

  expect(summary.perIssue.map((r) => r.issue)).toEqual(["2", "1"]);
  expect(summary.perIssue[0]).toEqual({ issue: "2", cost_usd: 5, runs: 1, tokens: { input: 50, output: 5 } });
  expect(summary.perIssue[1]).toEqual({ issue: "1", cost_usd: 1, runs: 1, tokens: { input: 100, output: 10 } });
});

test("a stray '## ' line inside a section body (e.g. a quoted markdown heading in a review comment) is not mistaken for a new section — only known stage names open one", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-"));
  const p = makeRecord(root, 3, "review", "2026-09-08T09:02:00Z", null, [
    "verdict: GREEN",
    "## Not a real stage header — quoted from a PR description",
    "more notes",
  ]);
  const entries = parseRunRecord(readFileSync(p, "utf8"));
  expect(entries).toHaveLength(1);
  expect(entries[0].stage).toBe("review");
});

test("mixed n/a cost sections are ignored in sums, never treated as 0-that-blocks-others", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-"));
  makeRecord(root, 5, "triage", "2026-09-10T00:00:00Z", { usage: {}, total_cost_usd: null, num_turns: null, terminal_reason: "error", modelUsage: {} });
  makeRecord(root, 5, "plan", "2026-09-10T01:00:00Z", { usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 2, num_turns: 1, terminal_reason: "end_turn", modelUsage: {} });
  const text = readFileSync(join(root, "docs/factory/runs/5.md"), "utf8");
  const summary = summarizeUsage(new Map([["5", text]]), { now: "2026-09-15T00:00:00Z" });
  expect(summary.perIssue[0]).toEqual({ issue: "5", cost_usd: 2, runs: 2, tokens: { input: 1, output: 1 } });
});
