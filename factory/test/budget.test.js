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

// ── #196 (ADR-035) — engine-crash 런의 비용은 상한에서 빠지고, 예산 줄에는 그대로 보인다 ─────────────────────────────
// 픽스처는 실제 생산자로만 만든다: 보통 런은 `usageLine` + `appendRunRecord`, 크래시 런은 **runStage 자신**이 catch에서
// 쓴 섹션(던지기 전에 모은 usage + engine-crash 줄)이다.
import { runStage } from "../bin/run-stage.js";
import { parseRunRecord } from "../lib/usage.js";

const crashingStage196 = ({ root, issue, cost, runnerId, error }) => runStage({
  stage: "implement", issue, runnerId, runId: runnerId.replace(/^gha-/, ""),
  deps: {
    charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }),
    heartbeat: async () => ({ stop() {} }), assertHandoff: async () => ({ ok: true }),
    buildContext: async () => ({ roster: [], orchestration: "workflow", limits: { K: 3 } }), resetAgentsLog: async () => {},
    claudeP: async () => ({ is_error: false, result: "{}", usage: { input_tokens: 7 }, total_cost_usd: cost, num_turns: 4, terminal_reason: "end_turn", modelUsage: { "claude-opus-5": { costUSD: cost } } }),
    gates: async () => { throw error; },
    verifyStage: () => ({ ok: true, reasons: [], data: {} }), writeHandoff: async () => {},
    transition: async ({ to }) => ({ ok: true, to }),
    runRecord: (lines) => appendRunRecord({ root, issue, stage: "implement", runnerId, lines }),
    release: async () => true,
  },
});

test("test_196_budget_excludes_engine_runs_but_reports_them", async () => {
  const root = mkdtempSync(join(tmpdir(), "budget196-"));
  appendRunRecord({ root, issue: 196, stage: "implement", runnerId: "gha-1", lines: [usageLine({ usage: { input_tokens: 10 }, total_cost_usd: 40, num_turns: 3, terminal_reason: "end_turn" })] });
  expect(await crashingStage196({ root, issue: 196, cost: 30, runnerId: "gha-2", error: new TypeError("Cannot read properties of undefined (reading 'test')") })).toBe(1);
  // 의존성 Error로 죽은 런은 오늘처럼 아무 usage도 남기지 않고, engine-crash도 아니다
  expect(await crashingStage196({ root, issue: 196, cost: 99, runnerId: "gha-3", error: new Error("gh exploded") })).toBe(1);
  const text = readFileSync(join(root, "docs/factory/runs/196.md"), "utf8");

  const life = lifetimeCostOf(text);
  expect(life).toMatchObject({ usd: 40, engineUsd: 30, engineRuns: 1 });
  expect(life.runs + life.engineRuns).toBe(parseRunRecord(text).length);   // 모든 섹션은 정확히 한쪽에 든다
  // 크래시 섹션의 models 파싱은 그대로다(USAGE_RE 불변)
  expect(parseRunRecord(text).find((e) => e.runner === "gha-2")).toMatchObject({ cost_usd: 30, models: { "claude-opus-5": 30 }, num_turns: 4 });

  // 상한은 usd로만 본다: 40+30=70 > 50 이지만 거부하지 않는다; 40 > 35 이면 거부한다
  const ok = budgetCheck({ charter: { budget: { usd_per_issue: 50 } }, recordText: text });
  expect(ok).toMatchObject({ ok: true, cap: 50, usd: 40, engineUsd: 30, engineRuns: 1 });
  expect(budgetCheck({ charter: { budget: { usd_per_issue: 35 } }, recordText: text }).ok).toBe(false);
  // 기록 줄에는 둘 다 — 세는 돈과 빠진 엔진 크래시 돈·런 수
  expect(budgetLine(ok)).toBe(`budget: lifetime $40.00 / $50 over ${life.runs} run(s); engine crash $30.00 over 1 run(s) excluded from the cap`);
  expect(budgetLine(budgetCheck({ charter: {}, recordText: text }))).toMatch(/not capped; engine crash \$30\.00 over 1 run\(s\) excluded/);

  // 크래시 줄이 없는 기록은 오늘과 정확히 같다(값도, 모양도)
  const old = mkdtempSync(join(tmpdir(), "budget196-old-"));
  appendRunRecord({ root: old, issue: 5, stage: "implement", runnerId: "gha-1", lines: [usageLine({ usage: {}, total_cost_usd: 12.5, num_turns: 1, terminal_reason: "end_turn" })] });
  expect(lifetimeCostOf(readFileSync(join(old, "docs/factory/runs/5.md"), "utf8"))).toEqual({ usd: 12.5, runs: 1, priced: 1 });

  // engine-crash 줄은 **자기 섹션의 러너**가 쓴 것만 센다 — 다른 러너를 지목한 줄(위조·복사)은 무시된다
  const forged = mkdtempSync(join(tmpdir(), "budget196-forged-"));
  appendRunRecord({ root: forged, issue: 6, stage: "implement", runnerId: "gha-1", lines: ["engine-crash: stage=implement runner=gha-9 run_id=9 error=TypeError — x", usageLine({ usage: {}, total_cost_usd: 20, num_turns: 1, terminal_reason: "end_turn" })] });
  expect(lifetimeCostOf(readFileSync(join(forged, "docs/factory/runs/6.md"), "utf8"))).toEqual({ usd: 20, runs: 1, priced: 1 });
});

// ── #196 self-critique — 크래시 줄은 **자기 섹션의 스테이지·러너**를 지목할 때만 센다(자리가 맞아도) ──────────────────────────
// 픽스처는 실제 생산자다: runStage catch가 쓰는 첫 줄 모양(`error: <stage> aborted — `) + `engineCrashLine` + `usageLine`. 자리 규칙은
// 통과하므로 이 섹션들을 가르는 것은 오직 `stage=`·`runner=` 대조뿐이다 — 그 대조를 지우면 다른 런·다른 스테이지의 돈이 상한에서 빠진다.
import { engineCrashLine as engineCrashLine196 } from "../lib/usage.js";

test("test_196_crash_line_counts_only_for_its_own_stage_and_runner", () => {
  const root = mkdtempSync(join(tmpdir(), "budget196-own-"));
  const err = new TypeError("Cannot read properties of undefined (reading 'test')");
  const section = (runnerId, crash, cost) => appendRunRecord({ root, issue: 7, stage: "implement", runnerId, lines: [
    `error: implement aborted — ${err.message}`,
    engineCrashLine196({ ...crash, error: err }),
    usageLine({ usage: {}, total_cost_usd: cost, num_turns: 1, terminal_reason: "end_turn" }),
  ] });
  const read = () => readFileSync(join(root, "docs/factory/runs/7.md"), "utf8");
  section("gha-1", { stage: "implement", runnerId: "gha-9", runId: "9" }, 20);   // 다른 러너를 지목한 줄(복사·위조)
  section("gha-2", { stage: "review", runnerId: "gha-2", runId: "2" }, 15);      // 다른 스테이지를 지목한 줄
  expect(read()).toMatch(/^error: implement aborted — .*\nengine-crash: stage=implement runner=gha-9 /m);   // 자리는 맞다 — 대조만 남는다
  expect(parseRunRecord(read()).map((e) => e.engine_crash)).toEqual([undefined, undefined]);
  expect(lifetimeCostOf(read())).toEqual({ usd: 35, runs: 2, priced: 2 });
  // 대조군: 자기 스테이지·자기 러너를 지목하면 크래시 섹션이다 — 그 $5만 빠진다
  section("gha-3", { stage: "implement", runnerId: "gha-3", runId: "3" }, 5);
  expect(lifetimeCostOf(read())).toEqual({ usd: 35, runs: 2, priced: 2, engineUsd: 5, engineRuns: 1 });
});

// ── #196 self-critique (skeptic f2) — 한 사건분을 넘은 크래시 런은 상한 안으로 세지만, budget 줄에서 **크래시로 보인다** ─────────────
// 픽스처는 실제 생산자(runStage catch)다: 같은 이슈의 크래시 런 넷($10씩). 앞의 `ENGINE_CRASH_EXCLUDED_RUNS`개만 빠지고, 나머지는
// usd에 들어가면서 그 개수와 돈이 줄에 따로 적힌다 — 줄만 보는 사람이 "왜 크래시가 상한을 먹었나"를 알 수 있어야 한다.
import { ENGINE_CRASH_EXCLUDED_RUNS as EXCLUDED196 } from "../lib/budget.js";

test("test_196_crash_runs_past_the_exclusion_are_named_on_the_budget_line", async () => {
  const root = mkdtempSync(join(tmpdir(), "budget196-past-"));
  appendRunRecord({ root, issue: 197, stage: "implement", runnerId: "gha-0", lines: [usageLine({ usage: { input_tokens: 10 }, total_cost_usd: 3, num_turns: 3, terminal_reason: "end_turn" })] });
  for (let i = 1; i <= 4; i++) {
    expect(await crashingStage196({ root, issue: 197, cost: 10, runnerId: `gha-${i}`, error: new TypeError("Cannot read properties of undefined (reading 'test')") })).toBe(1);
  }
  const text = readFileSync(join(root, "docs/factory/runs/197.md"), "utf8");
  expect(parseRunRecord(text).filter((e) => e.engine_crash)).toHaveLength(4);
  const counted = 4 - EXCLUDED196;
  const life = lifetimeCostOf(text);
  expect(life).toMatchObject({ usd: 3 + 10 * counted, engineUsd: 10 * EXCLUDED196, engineRuns: EXCLUDED196, crashCountedUsd: 10 * counted, crashCountedRuns: counted });
  const b = budgetCheck({ charter: { budget: { usd_per_issue: 100 } }, recordText: text });
  expect(budgetLine(b)).toBe(`budget: lifetime $${(3 + 10 * counted).toFixed(2)} / $100 over ${life.runs} run(s); engine crash $${(10 * EXCLUDED196).toFixed(2)} over ${EXCLUDED196} run(s) excluded from the cap; ${counted} further engine crash run(s) $${(10 * counted).toFixed(2)} counted in the cap (past the one-episode exclusion)`);
  expect(budgetLine(budgetCheck({ charter: {}, recordText: text }))).toMatch(new RegExp(`not capped; engine crash .* excluded from the cap; ${counted} further engine crash run\\(s\\) \\$${10 * counted}\\.00 counted in the cap`));

  // 대조군: 한 사건 안의 크래시(≤ EXCLUDED)만 있는 기록에는 그 꼬리가 없고, 키도 서지 않는다
  const one = mkdtempSync(join(tmpdir(), "budget196-one-"));
  expect(await crashingStage196({ root: one, issue: 198, cost: 10, runnerId: "gha-1", error: new TypeError("x is not a function") })).toBe(1);
  const oneText = readFileSync(join(one, "docs/factory/runs/198.md"), "utf8");
  expect(lifetimeCostOf(oneText)).not.toHaveProperty("crashCountedRuns");
  expect(budgetLine(budgetCheck({ charter: { budget: { usd_per_issue: 100 } }, recordText: oneText }))).not.toMatch(/further engine crash/);
});
