import { test, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lifetimeCostOf, budgetCheck, budgetPerIssue, budgetLine } from "../lib/budget.js";
import { appendRunRecord } from "../lib/run-record.js";
import { usageLine } from "../bin/run-stage.js";
import { checkBudgetPerIssue } from "../lib/doctor/factory.js";

// 1.4.16 (KTB #44, demo #18: 38 runs / $212 across a re-queue). The lifetime cost is the sum of the runner-written
// `usage:` lines on the issue's run record — across re-queues and human retries. Fixtures come from the real producers.
const recordWith = (costs) => {
  const root = mkdtempSync(join(tmpdir(), "budget-"));
  costs.forEach((c, i) => appendRunRecord({ root, issue: 18, stage: i % 2 ? "review" : "implement", runnerId: `gha-${i}`, lines: [usageLine({ usage: { input_tokens: 10 }, total_cost_usd: c, num_turns: 3, terminal_reason: "end_turn" })] }));
  // a human re-queue between runs does not reset anything — the record simply keeps growing
  appendRunRecord({ root, issue: 18, stage: "sweep", runnerId: "gha-x", lines: ["requeued by human"] });
  return readFileSync(join(root, "docs/factory/runs/18.md"), "utf8");
};

test("lifetimeCostOf sums every priced run on the record; unpriced sections count as runs but add nothing", () => {
  const text = recordWith([12.5, 7.25, 30.001]);
  expect(lifetimeCostOf(text)).toEqual({ usd: 49.75, runs: 4, priced: 3 });
  expect(lifetimeCostOf(null)).toEqual({ usd: 0, runs: 0, priced: 0 });
});

test("budgetCheck: unset cap never refuses; a cap refuses once the lifetime cost exceeds it, with a human-readable reason", () => {
  const text = recordWith([40, 25]);
  expect(budgetPerIssue({ budget: {} })).toBeNull();
  expect(budgetPerIssue({ budget: { usd_per_issue: "60" } })).toBe(60);
  expect(budgetPerIssue({ budget: { usd_per_issue: 0 } })).toBeNull();
  expect(budgetCheck({ charter: { budget: {} }, recordText: text })).toMatchObject({ ok: true, cap: null, usd: 65 });
  expect(budgetCheck({ charter: { budget: { usd_per_issue: 100 } }, recordText: text })).toMatchObject({ ok: true, cap: 100, usd: 65 });
  const over = budgetCheck({ charter: { budget: { usd_per_issue: 60 } }, recordText: text });
  expect(over.ok).toBe(false);
  expect(over.reason).toMatch(/lifetime cost \$65\.00 over 3 run\(s\) exceeds \[budget\]\.usd_per_issue \$60/);
  expect(budgetLine(over)).toBe("budget: lifetime $65.00 / $60 over 3 run(s) — REFUSED");
  expect(budgetLine(budgetCheck({ charter: {}, recordText: text }))).toMatch(/not capped/);
});

test("doctor: budget.usd_per_issue unset is a WARN (lifetime cost unbounded), set is a PASS naming the cap", () => {
  const by = (cs) => Object.fromEntries(cs.map((c) => [c.id, c]));
  expect(by(checkBudgetPerIssue({ budget: {} }))["charter.budget-per-issue-unset"].level).toBe("WARN");
  const pass = by(checkBudgetPerIssue({ budget: { usd_per_issue: 60 } }))["charter.budget-per-issue"];
  expect(pass.level).toBe("PASS");
  expect(pass.detail).toContain("$60");
});
