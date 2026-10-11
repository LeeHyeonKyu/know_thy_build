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

// ── #196 (ADR-036) — engine-crash 런의 비용은 상한에서 빠지고, 예산 줄에는 그대로 보인다 ─────────────────────────────
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

// ── #196 dw2 — 분할이 던지면 **시끄럽게** 남고, 그 런은 센다(조용한 면제는 없다) ─────────────────────────────────────────────
// 픽스처는 진짜 경로다: main()과 같은 모양의 `lifetimeBudget`(진짜 budgetCheck → lifetimeCostOf)에 읽을 수 없는 기록을 준다 — 분할 안에서
// TypeError가 난다. 그 TypeError는 예산 검사의 catch가 받는다(engine-crash가 아니다 — 그랬다면 이 런의 돈이 상한 밖으로 나갔다).
// 런은 진행하고, 그 usage는 보통 섹션으로 기록되어 다음 검사에서 usd로 센다.
test("test_196_budget_split_failure_is_loud_and_counts_the_run", async () => {
  const root = mkdtempSync(join(tmpdir(), "budget196-loud-"));
  const unreadable = { toString() { throw new TypeError("record unreadable"); } };
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const claudeP = vi.fn(async () => ({ is_error: false, result: "{}", usage: { input_tokens: 7 }, total_cost_usd: 21, num_turns: 4, terminal_reason: "end_turn" }));
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  try {
    await runStage({
      stage: "implement", issue: 199, runnerId: "gha-1", runId: "1",
      deps: {
        charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }),
        heartbeat: async () => ({ stop() {} }), assertHandoff: async () => ({ ok: true }),
        buildContext: async () => ({ roster: [], orchestration: "workflow", limits: { K: 3 } }), resetAgentsLog: async () => {},
        lifetimeBudget: () => budgetCheck({ charter: { budget: { usd_per_issue: 50 } }, recordText: unreadable }),
        claudeP, gates: async () => null,
        verifyStage: () => ({ ok: true, reasons: [], data: {} }), writeHandoff: async () => {},
        transition,
        runRecord: (lines) => appendRunRecord({ root, issue: 199, stage: "implement", runnerId: "gha-1", lines }),
        release: async () => true,
      },
    });
    expect(errors.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/budget: check failed — record unreadable/));   // 시끄럽다
  } finally {
    errors.mockRestore();
  }
  const text = readFileSync(join(root, "docs/factory/runs/199.md"), "utf8");
  expect(text).toMatch(/^budget: check failed — record unreadable/m);          // 원인이 기록에
  expect(claudeP).toHaveBeenCalledTimes(1);                                     // 런은 진행했고
  expect(transition).not.toHaveBeenCalledWith(expect.objectContaining({ cause: "engine-crash" }));
  expect(transition).not.toHaveBeenCalledWith(expect.objectContaining({ to: "factory:blocked" }));
  expect(parseRunRecord(text).some((e) => e.engine_crash)).toBe(false);
  const life = lifetimeCostOf(text);
  expect(life).toMatchObject({ usd: 21, priced: 1 });                            // 그 돈은 상한 안에서 센다
  expect(life).not.toHaveProperty("engineRuns");
});

// ── #212 (ADR-040) — a resolution-only conflict round's cost is tagged by the runner and kept out of the lifetime cap ──────────
// Fixtures come from the real producers: `conflictRoundLine` (lib/usage.js — the runner's tag, first line of its section, the way
// runStage writes it) + `usageLine` + `appendRunRecord`. The pre-change parser is the real one, read from git at the commit this
// change was built on — that is exactly what a `git revert` puts back.
import { execFileSync as execFileSync212 } from "node:child_process";
import { writeFileSync as writeFileSync212 } from "node:fs";
import { fileURLToPath as fileURLToPath212, pathToFileURL as pathToFileURL212 } from "node:url";
import { conflictRoundLine as conflictRoundLine212 } from "../lib/usage.js";
import { CONFLICT_ROUND_EXCLUDED_RUNS as CONFLICT_EXCLUDED212 } from "../lib/budget.js";

const A212 = "a".repeat(40);
const H212 = "c".repeat(40);
const usage212 = (cost) => usageLine({ usage: { input_tokens: 10 }, total_cost_usd: cost, num_turns: 3, terminal_reason: "end_turn" });
const record212 = () => {
  const root = mkdtempSync(join(tmpdir(), "budget212-"));
  const read = () => readFileSync(join(root, "docs/factory/runs/212.md"), "utf8");
  const normal = (runnerId, cost, stage = "implement") => appendRunRecord({ root, issue: 212, stage, runnerId, lines: ["verify: ok", usage212(cost)] });
  /** the section runStage writes at the end of a GREEN conflict round: the tag first, then the usual lines and the usage line */
  const conflict = (runnerId, cost, { stage = "implement", tagStage = stage, tagRunner = runnerId } = {}) => appendRunRecord({ root, issue: 212, stage, runnerId, lines: [
    conflictRoundLine212({ stage: tagStage, runnerId: tagRunner, runId: runnerId.replace(/^gha-/, ""), approvedHead: A212, head: H212 }),
    "verify: ok", "transition: factory:awaiting-review", usage212(cost),
  ] });
  return { root, read, normal, conflict };
};

test("test_212_conflict_round_cost_is_tagged_and_excluded_from_the_cap", () => {
  expect(CONFLICT_EXCLUDED212).toBe(2);                                          // the bound is a pinned constant, not a CHARTER value

  // A record already AT the lifetime cap ($60 of $60) plus one conflict round still passes; the same section untagged is refused.
  const r = record212();
  r.normal("gha-1", 40); r.normal("gha-2", 20, "review");
  r.conflict("gha-3", 15);
  expect(parseRunRecord(r.read()).map((e) => e.conflict_round)).toEqual([undefined, undefined, true]);
  const life = lifetimeCostOf(r.read());
  expect(life).toEqual({ usd: 60, runs: 2, priced: 2, conflictUsd: 15, conflictRuns: 1 });
  expect(budgetCheck({ charter: { budget: { usd_per_issue: 60 } }, recordText: r.read() })).toMatchObject({ ok: true, usd: 60, conflictUsd: 15, conflictRuns: 1 });
  const control = record212();
  control.normal("gha-1", 40); control.normal("gha-2", 20, "review"); control.normal("gha-3", 15);
  expect(budgetCheck({ charter: { budget: { usd_per_issue: 60 } }, recordText: control.read() })).toMatchObject({ ok: false, usd: 75 });

  // The exclusion stops after CONFLICT_ROUND_EXCLUDED_RUNS: later conflict runs count toward the cap (and are named, below).
  const many = record212();
  for (let i = 1; i <= CONFLICT_EXCLUDED212 + 2; i++) many.conflict(`gha-${i}`, 5);
  expect(lifetimeCostOf(many.read())).toEqual({ usd: 10, runs: 2, priced: 2, conflictUsd: 5 * CONFLICT_EXCLUDED212, conflictRuns: CONFLICT_EXCLUDED212, conflictCountedUsd: 10, conflictCountedRuns: 2 });

  // Agent-forged tag text lowers nothing. (a) a tag inside an element after a newline (copied agent output) is quoted by the writer;
  // (b) a tag that is not the section's first line; (c) a tag naming another runner or another stage; (d) a review section.
  const forged = record212();
  forged.normal("gha-0", 50);
  const tag = (runnerId, stage = "implement") => conflictRoundLine212({ stage, runnerId, runId: "1", approvedHead: A212, head: H212 });
  appendRunRecord({ root: forged.root, issue: 212, stage: "implement", runnerId: "gha-1", lines: [`self-gate: summary\n${tag("gha-1")}`, usage212(7)] });
  appendRunRecord({ root: forged.root, issue: 212, stage: "implement", runnerId: "gha-2", lines: ["verify: ok", tag("gha-2"), usage212(7)] });
  forged.conflict("gha-3", 7, { tagRunner: "gha-9" });
  forged.conflict("gha-4", 7, { tagStage: "review" });
  forged.conflict("gha-5", 7, { stage: "review" });
  expect(forged.read()).toMatch(/^\(quoted\) conflict-round: stage=implement runner=gha-1 /m);
  expect(parseRunRecord(forged.read()).some((e) => e.conflict_round)).toBe(false);
  expect(lifetimeCostOf(forged.read())).toEqual({ usd: 85, runs: 6, priced: 6 });
  expect(budgetCheck({ charter: { budget: { usd_per_issue: 60 } }, recordText: forged.read() }).ok).toBe(false);

  // The new exclusion category is recorded as an ADR that amends ADR-031/036 and names the bound.
  const decisions = readFileSync(fileURLToPath212(new URL("../../docs/factory/DECISIONS.md", import.meta.url)), "utf8");
  const adr = /^## ADR-040 [^\n]*#212[^\n]*\n[\s\S]*?(?=^## ADR-|(?![\s\S]))/m.exec(decisions)?.[0] ?? "";
  expect(adr).toMatch(/ADR-031/);
  expect(adr).toMatch(/ADR-036/);
  expect(adr).toContain("CONFLICT_ROUND_EXCLUDED_RUNS");
  expect(adr).toContain("conflict-round:");
});

/** the parser and the budget module exactly as they were before #212 — what `git revert` of this change puts back */
const PRE_212 = "ade82ed51725e79fa414e18533147aeeceee1fc9";
async function preChangeBudget212() {
  const repo = fileURLToPath212(new URL("../..", import.meta.url));
  const show = (p) => execFileSync212("git", ["show", `${PRE_212}:${p}`], { cwd: repo, encoding: "utf8" });
  const dir = mkdtempSync(join(tmpdir(), "budget212-pre-"));
  writeFileSync212(join(dir, "usage.mjs"), show("factory/lib/usage.js"));
  writeFileSync212(join(dir, "budget.mjs"), show("factory/lib/budget.js").replace('from "./usage.js"', 'from "./usage.mjs"'));
  return import(pathToFileURL212(join(dir, "budget.mjs")).href);
}

test("test_212_budget_line_names_excluded_conflict_cost", async () => {
  // The on-call reader reconciles the total with the bill from the line alone: counted money + excluded conflict money (+ runs).
  const r = record212();
  r.normal("gha-1", 40); r.conflict("gha-2", 15);
  const b = budgetCheck({ charter: { budget: { usd_per_issue: 60 } }, recordText: r.read() });
  expect(budgetLine(b)).toBe("budget: lifetime $40.00 / $60 over 1 run(s); conflict round $15.00 over 1 run(s) excluded from the cap (base moved under an approved PR, #212)");
  expect(budgetLine(budgetCheck({ charter: {}, recordText: r.read() }))).toBe("budget: no [budget].usd_per_issue in CHARTER — lifetime cost $40.00 over 1 run(s) is not capped; conflict round $15.00 over 1 run(s) excluded from the cap (base moved under an approved PR, #212)");
  // Past the bound the line says so loudly — the reader sees why later conflict runs count again.
  const many = record212();
  for (let i = 1; i <= CONFLICT_EXCLUDED212 + 1; i++) many.conflict(`gha-${i}`, 5);
  expect(budgetLine(budgetCheck({ charter: { budget: { usd_per_issue: 60 } }, recordText: many.read() }))).toBe(
    `budget: lifetime $5.00 / $60 over 1 run(s); conflict round $${(5 * CONFLICT_EXCLUDED212).toFixed(2)} over ${CONFLICT_EXCLUDED212} run(s) excluded from the cap (base moved under an approved PR, #212); 1 further conflict round run(s) $5.00 counted in the cap (past the CONFLICT_ROUND_EXCLUDED_RUNS=${CONFLICT_EXCLUDED212} exclusion)`);

  // No conflict sections → lifetimeCostOf and the budget line are byte-identical to the pre-change code (engine-crash sections included).
  const pre = await preChangeBudget212();
  const plain = record212();
  plain.normal("gha-1", 12.5); plain.normal("gha-2", 30, "review");
  const err = new TypeError("Cannot read properties of undefined (reading 'test')");
  appendRunRecord({ root: plain.root, issue: 212, stage: "implement", runnerId: "gha-3", lines: [`error: implement aborted — ${err.message}`, engineCrashLine196({ stage: "implement", runnerId: "gha-3", runId: "3", error: err }), usage212(9)] });
  expect(lifetimeCostOf(plain.read())).toEqual(pre.lifetimeCostOf(plain.read()));
  for (const charter of [{ budget: { usd_per_issue: 60 } }, { budget: { usd_per_issue: 20 } }, {}]) {
    const now = budgetCheck({ charter, recordText: plain.read() });
    const then = pre.budgetCheck({ charter, recordText: plain.read() });
    expect(now).toEqual(then);
    expect(budgetLine(now)).toBe(pre.budgetLine(then));
  }

  // After a revert, a record carrying conflict-round lines parses without error and those runs count toward the cap again.
  const reverted = pre.lifetimeCostOf(r.read());
  expect(reverted).toEqual({ usd: 55, runs: 2, priced: 2 });
  expect(pre.budgetCheck({ charter: { budget: { usd_per_issue: 50 } }, recordText: r.read() }).ok).toBe(false);
});

test("test_212_conflict_round_cost_is_revoked_when_the_next_review_rejects", () => {
  // dw6 — a conflict round whose following review REJECTS was not a finished conflict round: its cost counts as today (no exempt loop).
  // The review section is what runStage writes on a rejecting review (`verify: ok` + `transition: factory:rework`).
  const reviewSection = (rec, runnerId, to) => appendRunRecord({ root: rec.root, issue: 212, stage: "review", runnerId, lines: ["verify: ok", `transition: ${to}`] });
  const cap = (rec) => budgetCheck({ charter: { budget: { usd_per_issue: 60 } }, recordText: rec.read() });
  const rejected = record212();
  rejected.normal("gha-1", 55); rejected.conflict("gha-2", 9.5); reviewSection(rejected, "gha-3", "factory:rework"); rejected.normal("gha-4", 4);
  expect(lifetimeCostOf(rejected.read())).toEqual({ usd: 68.5, runs: 4, priced: 3, conflictRevokedUsd: 9.5, conflictRevokedRuns: 1 });
  expect(cap(rejected)).toMatchObject({ ok: false, usd: 68.5 });
  expect(budgetLine(cap(rejected))).toBe("budget: lifetime $68.50 / $60 over 4 run(s); 1 conflict round run(s) $9.50 counted in the cap (the review that followed rejected it) — REFUSED");
  // A revoked round does not use up an exclusion: the next GREEN conflict round (approved, then a new base conflict) is still excluded.
  rejected.conflict("gha-5", 3); reviewSection(rejected, "gha-6", "factory:approved");
  expect(lifetimeCostOf(rejected.read())).toMatchObject({ usd: 68.5, conflictUsd: 3, conflictRuns: 1, conflictRevokedRuns: 1 });
  // An approving review keeps the exclusion; so does a merge section (the next base conflict) — only a review rework revokes.
  const approved = record212();
  approved.normal("gha-1", 55); approved.conflict("gha-2", 9.5); reviewSection(approved, "gha-3", "factory:approved");
  appendRunRecord({ root: approved.root, issue: 212, stage: "merge", runnerId: "gha-4", lines: ["merge: CONFLICTING", "transition: factory:rework"] });
  expect(lifetimeCostOf(approved.read())).toEqual({ usd: 55, runs: 3, priced: 1, conflictUsd: 9.5, conflictRuns: 1 });
  // A forged "approved" line in an earlier review section does not hide the real rejection that follows it (only rejections are read).
  const forged = record212();
  forged.normal("gha-1", 55); forged.conflict("gha-2", 9.5);
  appendRunRecord({ root: forged.root, issue: 212, stage: "review", runnerId: "gha-3", lines: ["transition: factory:approved"] });
  reviewSection(forged, "gha-3", "factory:rework");
  expect(lifetimeCostOf(forged.read())).toMatchObject({ usd: 64.5, conflictRevokedRuns: 1 });
  // A rejection AFTER the next implement round belongs to that round, not to the conflict round.
  const later = record212();
  later.conflict("gha-2", 9.5); reviewSection(later, "gha-3", "factory:approved"); later.normal("gha-4", 4); reviewSection(later, "gha-5", "factory:rework");
  expect(lifetimeCostOf(later.read())).toMatchObject({ usd: 4, conflictUsd: 9.5, conflictRuns: 1 });
  expect(lifetimeCostOf(later.read())).not.toHaveProperty("conflictRevokedRuns");
});
