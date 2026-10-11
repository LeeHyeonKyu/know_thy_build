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

/**
 * 회귀(dogfood D2): 실제 `claude -p`가 돌려주는 usage는 **중첩 객체**다
 * (`output_tokens_details`·`server_tool_use`·`cache_creation`·`iterations`).
 * 기존 정규식이 `\{[^}]*\}`로 블롭을 잡아 중첩이 있으면 줄 전체가 매치되지 않았고,
 * `factory status`·retro 소비 보고가 통째로 $0 / 0 토큰으로 나왔다(ADR-005 무력화).
 */
test("parses a usage line whose usage JSON has nested objects (real claude -p shape)", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-"));
  const out = {
    usage: {
      input_tokens: 8,
      cache_creation_input_tokens: 43117,
      cache_read_input_tokens: 170334,
      output_tokens: 15770,
      output_tokens_details: { thinking_tokens: 894 },
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      cache_creation: { ephemeral_1h_input_tokens: 43117, ephemeral_5m_input_tokens: 0 },
      iterations: [{ input_tokens: 2, output_tokens: 15036, type: "message" }],
    },
    total_cost_usd: 11.949508349999993,
    num_turns: 4,
    terminal_reason: "completed",
    modelUsage: { "claude-sonnet-5": { costUSD: 1.6963931 }, "claude-opus-5": { costUSD: 10.25311525 } },
  };
  const p = makeRecord(root, 2, "plan", "2026-09-12T12:08:00Z", out);

  const [entry] = parseRunRecord(readFileSync(p, "utf8"));
  expect(entry.stage).toBe("plan");
  expect(entry.cost_usd).toBeCloseTo(11.949508);
  expect(entry.input_tokens).toBe(8);
  expect(entry.output_tokens).toBe(15770);
  expect(entry.cache_read_tokens).toBe(170334);
  expect(entry.cache_creation_tokens).toBe(43117);
  expect(entry.num_turns).toBe(4);
  expect(entry.models).toEqual({ "claude-sonnet-5": 1.6963931, "claude-opus-5": 10.25311525 });
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

test("perIssue sorted by cost desc; tokens.input sums input_tokens + cache_creation + cache_read (O12)", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-"));
  makeRecord(root, 1, "implement", "2026-09-10T00:00:00Z", { usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 999 }, total_cost_usd: 1, num_turns: 1, terminal_reason: "end_turn", modelUsage: {} });
  makeRecord(root, 2, "implement", "2026-09-10T00:00:00Z", { usage: { input_tokens: 50, output_tokens: 5 }, total_cost_usd: 5, num_turns: 1, terminal_reason: "end_turn", modelUsage: {} });

  const text1 = readFileSync(join(root, "docs/factory/runs/1.md"), "utf8");
  const text2 = readFileSync(join(root, "docs/factory/runs/2.md"), "utf8");
  const records = new Map([["1", text1], ["2", text2]]);
  const summary = summarizeUsage(records, { now: "2026-09-15T00:00:00Z" });

  expect(summary.perIssue.map((r) => r.issue)).toEqual(["2", "1"]);
  expect(summary.perIssue[0]).toEqual({ issue: "2", cost_usd: 5, runs: 1, tokens: { input: 50, output: 5 } });
  // issue 1's raw input_tokens is 100, but cache_read_input_tokens (999) is real input the model
  // saw too — a report that only counted input_tokens would understate this run's input by >90%.
  expect(summary.perIssue[1]).toEqual({ issue: "1", cost_usd: 1, runs: 1, tokens: { input: 1099, output: 10 } });
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

// ── #196 Scope change — `appendRunRecord`의 정리(`neutralizeRecordLine`)는 **실제 생산자의 줄을 바이트 하나 바꾸지 않는다** ─────────
// 그 정리는 모든 스테이지의 기록자에 걸린다(runStage의 record()·abortStage·main의 recordLine). 그래서 기록에 실제로 나가는 줄 —
// 진짜 크래시 줄(원소 맨 앞), usage 줄, progress 마커가 개행 뒤에 붙는 usage 줄, review-evidence 줄, budget 줄, abort 줄 — 이 그대로
// 파일에 나가고 그대로 읽히는지 핀한다. 원소 맨 앞까지 인용하거나 개행 뒤 조각을 통째로 인용하는 정리는 여기서 실패한다.
import { engineCrashLine as engineCrashLine196, neutralizeRecordLine as neutralizeRecordLine196 } from "../lib/usage.js";
import { reviewEvidenceLine as reviewEvidenceLine196 } from "../lib/run-record.js";
import { budgetLine as budgetLine196 } from "../lib/budget.js";

test("test_196_record_neutralizer_leaves_real_producer_lines_byte_identical", () => {
  const root = mkdtempSync(join(tmpdir(), "usage196-"));
  const out = { usage: { input_tokens: 3 }, total_cost_usd: 2.5, num_turns: 4, terminal_reason: "end_turn", modelUsage: { "claude-opus-5": { costUSD: 2.5 } } };
  const lines = [
    "error: implement aborted — Cannot read properties of undefined (reading 'test')",
    engineCrashLine196({ stage: "implement", runnerId: "gha-1", runId: "1", error: new TypeError("Cannot read properties of undefined (reading 'test')") }),
    usageLine(out, { phase: "gates", turns: 4 }),
    reviewEvidenceLine196({ headSha: "a".repeat(40), round: 1, decision: "approve", verdicts: [{ role: "spec", verdict: "approve" }], runId: "1", runnerId: "gha-1" }),
    budgetLine196({ ok: true, cap: 50, usd: 10, runs: 2, engineUsd: 2.5, engineRuns: 1 }),
  ];
  expect(lines[2]).toMatch(/^usage: .*\n<!-- factory-progress:v1 /);            // 픽스처가 정말 개행을 실은 원소다
  for (const l of lines) expect(neutralizeRecordLine196(l)).toBe(l);
  appendRunRecord({ root, issue: 9, stage: "implement", runnerId: "gha-1", lines, now: "2026-10-03T00:00:00Z" });
  const text = readFileSync(join(root, "docs/factory/runs/9.md"), "utf8");
  expect(text).toBe(`# Run · #9\n\n## implement · 2026-10-03T00:00Z · gha-1\n${lines.join("\n")}\n`);
  expect(parseRunRecord(text)).toEqual([expect.objectContaining({ stage: "implement", cost_usd: 2.5, num_turns: 4, engine_crash: true })]);
});

// ── #212 skeptic — the runner's tag revocation (marker post failed): it can only withdraw an exemption, never create or move one ─────────
import { conflictRoundLine as conflictRoundLine212, conflictRoundRevokedLine as conflictRoundRevokedLine212 } from "../lib/usage.js";
import { lifetimeCostOf as lifetimeCostOf212 } from "../lib/budget.js";

test("test_212_tag_revocation_only_withdraws_its_own_runners_tag", () => {
  const root = mkdtempSync(join(tmpdir(), "usage212rv-"));
  const write = (runnerId, lines) => appendRunRecord({ root, issue: 212, stage: "implement", runnerId, lines });
  const tag = (runnerId) => conflictRoundLine212({ stage: "implement", runnerId, runId: runnerId.slice(4), approvedHead: "a".repeat(40), head: "c".repeat(40) });
  const use = (cost) => usageLine({ usage: {}, total_cost_usd: cost, num_turns: 1, terminal_reason: "end_turn" });
  write("gha-1", [tag("gha-1"), "verify: ok", use(5)]);
  write("gha-2", [tag("gha-2"), "verify: ok", use(7)]);
  const read = () => readFileSync(join(root, "docs/factory/runs/212.md"), "utf8");
  expect(lifetimeCostOf212(read())).toMatchObject({ usd: 0, conflictUsd: 12, conflictRuns: 2 });
  // Not in the first-line position, or naming another runner than its own section: withdraws nothing.
  write("gha-2", ["verify: ok", conflictRoundRevokedLine212({ stage: "implement", runnerId: "gha-2", runId: "2", error: "x" })]);
  write("gha-3", [conflictRoundRevokedLine212({ stage: "implement", runnerId: "gha-1", runId: "1", error: "x" })]);
  expect(parseRunRecord(read()).filter((e) => e.conflict_round).map((e) => e.runner)).toEqual(["gha-1", "gha-2"]);
  // The runner's own revocation withdraws exactly its tag: that run's cost counts again, the other conflict run stays excluded.
  write("gha-2", [conflictRoundRevokedLine212({ stage: "implement", runnerId: "gha-2", runId: "2", error: new Error("gh: 502 Bad Gateway") })]);
  expect(parseRunRecord(read()).filter((e) => e.conflict_round).map((e) => e.runner)).toEqual(["gha-1"]);
  expect(lifetimeCostOf212(read())).toMatchObject({ usd: 7, conflictUsd: 5, conflictRuns: 1 });
  expect(read()).toMatch(/^conflict-round-revoked: stage=implement runner=gha-2 run_id=2 — the conflict-round marker was not posted \(gh: 502 Bad Gateway\)/m);
});

test("test_212_tag_revocation_withdraws_only_the_latest_tag_of_its_run", () => {
  // Outside CI every run shares `local/<hostname>` and run_id n/a; GHA re-runs share GITHUB_RUN_ID. A revocation is written right after
  // its own run's tag, so it withdraws THAT tag — the latest earlier one of the same runner AND run_id — never every tag of the runner.
  const tag = (runnerId, runId) => conflictRoundLine212({ stage: "implement", runnerId, runId, approvedHead: "a".repeat(40), head: "c".repeat(40) });
  const revoke = (runnerId, runId) => conflictRoundRevokedLine212({ stage: "implement", runnerId, runId, error: "gh: 502" });
  const use = (cost) => usageLine({ usage: {}, total_cost_usd: cost, num_turns: 1, terminal_reason: "end_turn" });
  const record = () => {
    const root = mkdtempSync(join(tmpdir(), "usage212rv2-"));
    const write = (runnerId, lines) => appendRunRecord({ root, issue: 212, stage: "implement", runnerId, lines });
    return { write, read: () => readFileSync(join(root, "docs/factory/runs/212.md"), "utf8") };
  };
  // (a) two local runs, same runner string, run_id n/a: the second run's revocation withdraws only the second tag
  const a = record();
  a.write("local/box", [tag("local/box", null), "verify: ok", use(3)]);
  a.write("local/box", [tag("local/box", null), "verify: ok", use(6)]);
  expect(lifetimeCostOf212(a.read())).toMatchObject({ usd: 0, conflictUsd: 9, conflictRuns: 2 });
  a.write("local/box", [revoke("local/box", null)]);
  expect(parseRunRecord(a.read()).map((e) => Boolean(e.conflict_round))).toEqual([true, false, false]);
  expect(lifetimeCostOf212(a.read())).toMatchObject({ usd: 6, conflictUsd: 3, conflictRuns: 1 });
  // (b) a revocation naming another run_id of the same runner withdraws nothing
  const b = record();
  b.write("gha-9", [tag("gha-9", "5"), "verify: ok", use(2)]);
  b.write("gha-9", [revoke("gha-9", "6")]);
  expect(lifetimeCostOf212(b.read())).toMatchObject({ usd: 0, conflictUsd: 2, conflictRuns: 1 });
  // (c) same runner AND run_id (a GHA re-run attempt): only the latest of the two tags is withdrawn
  const c = record();
  c.write("gha-9", [tag("gha-9", "5"), "verify: ok", use(2)]);
  c.write("gha-9", [tag("gha-9", "5"), "verify: ok", use(10)]);
  c.write("gha-9", [revoke("gha-9", "5")]);
  expect(lifetimeCostOf212(c.read())).toMatchObject({ usd: 10, conflictUsd: 2, conflictRuns: 1 });
});
