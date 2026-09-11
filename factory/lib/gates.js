import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseVitestJson } from "./parsers/vitest-json.js";
import { isQuarantined } from "./quarantine.js";
import { changedFiles } from "./changed-files.js";
import { classifyFailures } from "./classify-failure.js";
import { proveTest, repeatNewTests } from "./prove-test.js";
import { runDiffCoverage } from "./diff-coverage.js";
import { mutationGate } from "./mutation.js";

const LEVELS = ["fast", "full", "deep"];
const MAX_LEVEL = { M0: "fast", M1: "full", M2: "deep" };
const PROOF_GATES = new Set(["diff_coverage", "mutation"]);          // Task 7/8가 채움
const TEST_GATES = new Set(["unit", "integration", "e2e"]);

/**
 * result.gates 맵으로부터 failing/skipped/misconfigured/passed/failed/status를 재계산해
 * result에 반영하고 그대로 돌려준다 (순수 함수: gates 맵만 보고 판정; 호출자가 gates를
 * 직접 수정한 뒤에도 다시 불러 일관된 판정을 얻을 수 있다).
 */
export function recomputeStatus(result, harness) {
  const gates = result.gates;
  const failing = [], skipped = [], misconfigured = [];
  for (const [name, g] of Object.entries(gates)) {
    if (g.status === "RED") failing.push(name);
    else if (g.status === "SKIPPED") skipped.push(name);
    else if (g.status === "MISCONFIGURED") misconfigured.push(name);
  }
  const requiredMissing = (harness.gates.required || []).filter((n) => misconfigured.includes(n));
  const passed = Object.values(gates).filter((g) => g.status === "GREEN").length;
  const status = requiredMissing.length ? "MISCONFIGURED" : failing.length ? "RED" : "GREEN";
  result.failing = failing;
  result.skipped = skipped;
  result.misconfigured = misconfigured;
  result.passed = passed;
  result.failed = failing.length;
  result.status = status;
  return result;
}

export async function runGates({ run, cwd, harness, level, quarantine, readFile = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null), now = new Date().toISOString() }) {
  const requested_level = level;
  const max = MAX_LEVEL[harness.harness?.maturity] || "deep";
  if (LEVELS.indexOf(level) > LEVELS.indexOf(max)) level = max;
  const names = harness.gates[level] || [];
  const gates = {};
  let tests = null;
  for (const name of names) {
    if (PROOF_GATES.has(name)) { gates[name] = { status: "SKIPPED" }; continue; }
    const cmd = harness.commands[name];
    if (!cmd) { gates[name] = { status: "MISCONFIGURED" }; continue; }
    const t0 = Date.now();
    const r = await run("bash", ["-lc", cmd], { cwd });
    let status = r.code === 0 ? "GREEN" : "RED";
    // parsed/failing_ids: 이 게이트의 RED가 "어떤 테스트 때문인지" 아는가. 리포트를 못 읽었으면
    // (parsed:false) 그 RED의 이유를 모르는 것이고, 나중에 어떤 근거로도 GREEN으로 뒤집으면 안 된다.
    let reportParsed = false, failing_ids = null;
    if (TEST_GATES.has(name)) {
      const rep = harness.test[`${name}_report`] || `.factory/out/${name}.json`;
      const reportPath = isAbsolute(rep) ? rep : join(cwd, rep);
      const report = readFile(reportPath);
      if (report) {
        const parsed = parseVitestJson(report, cwd);
        reportParsed = !parsed.error;
        failing_ids = parsed.failing.map((f) => f.id);
        const excluded = parsed.failing.filter((f) => isQuarantined(quarantine, f.id)).map((f) => f.id);
        const remaining = parsed.failing.filter((f) => !excluded.includes(f.id));
        tests = { ...(tests || { total: 0, passed: 0, failed: 0, failing: [], excluded: [] }) };
        tests.total += parsed.total; tests.passed += parsed.passed; tests.failed += remaining.length;
        tests.failing.push(...remaining); tests.excluded.push(...excluded);
        if (status === "RED" && remaining.length === 0 && parsed.failed > 0) status = "GREEN";   // 실패가 전부 격리 대상
      }
    }
    gates[name] = { status, code: r.code, duration_ms: Date.now() - t0, log: (r.stderr + r.stdout).slice(-2000) };
    if (TEST_GATES.has(name)) { gates[name].parsed = reportParsed; gates[name].failing_ids = failing_ids || []; }
  }
  const result = { schema: "factory.gates.v1", level, requested_level, downgraded_from: level === requested_level ? null : requested_level, status: null, gates, passed: 0, failed: 0, failing: [], skipped: [], misconfigured: [], tests, ran_at: now };
  return recomputeStatus(result, harness);
}

/** CHARTER tier → 게이트 레벨. 모르는 tier는 standard처럼 취급한다(약한 쪽으로 기울지 않는다). */
const LEVEL_OF_TIER = { docs: "fast", standard: "full", "load-bearing": "deep" };
export const levelForTier = (tier) => LEVEL_OF_TIER[tier] || "full";

const defaultReadFile = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

/**
 * 한 스테이지의 게이트 전체(명령 게이트 + 실패 분류 + prove-test/반복 + 증명 게이트)를 한 번에 돌려
 * `factory.gates.v1` 결과 하나로 합산한다. run-stage의 `d.gates`와 `bin/gates.js`가 공유하는 유일한 본체.
 *
 * - 분류(classifyFailures)는 **implement에서만** 한다. review/merge는 재분류 없이 RED가 RED다.
 * - `blocked`(base 워크트리를 못 만들어 "PR이 깨뜨렸다"를 판정할 수 없음)가 하나라도 있으면
 *   status를 BLOCKED로 올린다 — GREEN도 RED도 아닌, 사람이 봐야 하는 상태다.
 */
export async function runStageGates({ run, cwd, harness, stage, tier, level: levelArg, base, quarantine = { quarantined: [] }, gh, issue, readFile = defaultReadFile, now }) {
  const level = levelArg || levelForTier(tier);
  const result = await runGates({ run, cwd, harness, level, quarantine, readFile, ...(now ? { now } : {}) });
  let changed = null;
  const changedOnce = async () => (changed ||= await changedFiles({ run, cwd, base, harness }));

  if (stage === "implement" && result.tests?.failing?.length) {
    const { addedTests } = await changedOnce();
    const cls = await classifyFailures({ run, cwd, harness, failing: result.tests.failing, base, thresholds: harness.gates.thresholds, addedTests });
    result.classification = cls;
    const blocked = cls.filter((c) => c.verdict === "blocked");
    if (blocked.length) {
      recomputeStatus(result, harness);
      result.status = "BLOCKED";
      result.blocked_reason = `cannot classify ${blocked.length} failing test(s): ${blocked[0].evidence?.error || "unknown"}`;
      return result;
    }
    const flaky = cls.filter((c) => c.verdict === "flaky-existing");
    if (flaky.length) {
      result.flaky_issues = [];
      // 같은 테스트로 런마다 새 이슈를 열지 않는다 — 이미 열려 있으면 그 번호를 그대로 쓴다.
      let open = [];
      try { open = (await gh?.searchIssues("factory:flaky")) || []; }
      catch (e) { result.flaky_issue_lookup_error = e?.message || String(e); }
      for (const c of flaky) {
        result.tests.excluded.push(c.id);
        result.tests.failing = result.tests.failing.filter((f) => f.id !== c.id);
        const title = `flaky: ${c.id}`;
        const existing = open.find((i) => i.title === title);
        if (existing) { result.flaky_issues.push(existing.number); continue; }
        // 격리 이슈를 못 만들어도 판정은 계속한다 — gh 실패로 스테이지를 죽이지 않는다.
        try { result.flaky_issues.push(await gh?.createIssue({ title, body: `Detected while implementing #${issue}. evidence: ${JSON.stringify(c.evidence)}`, labels: ["factory:queue", "factory:flaky"] })); }
        catch (e) { result.flaky_issues.push(`error: ${e?.message || e}`); }
      }
      result.tests.failed = result.tests.failing.length;
    }
    // 남은 실패가 없으면(전부 기존 flaky) 테스트 게이트의 RED는 이 변경의 책임이 아니다 —
    // 단 **그 게이트의 리포트를 실제로 읽었고**, 그 게이트의 실패가 전부 제외 목록에 들어간 경우에만.
    // 리포트 없이 RED인 게이트(e2e 등)는 이유를 모르므로 절대 뒤집지 않는다.
    if (result.tests.failing.length === 0) {
      for (const [n, g] of Object.entries(result.gates)) {
        if (g.status !== "RED" || !TEST_GATES.has(n) || g.parsed !== true) continue;
        if ((g.failing_ids || []).length && g.failing_ids.every((id) => result.tests.excluded.includes(id))) g.status = "GREEN";
      }
    }
  }

  if (stage === "implement") {
    const ch = await changedOnce();
    // 새로 추가된 테스트만이 아니라 **수정된 테스트 파일**도 증명 대상이다 — 기존 파일에 추가된
    // 케이스도 base에서는 실패해야 한다.
    if (tier !== "docs") {
      const pt = await proveTest({ run, cwd, harness, base, addedTests: ch.tests });
      result.gates["prove-test"] = { status: pt.ok ? "GREEN" : "RED", log: pt.detail };
    }
    const rp = await repeatNewTests({ run, cwd, harness, addedTests: ch.tests, times: harness.gates.thresholds.new_test_repeats });
    result.gates["new-test-repeat"] = { status: rp.misconfigured ? "MISCONFIGURED" : rp.ok ? "GREEN" : "RED", log: rp.detail };
    if (result.skipped.includes("diff_coverage")) {
      const dc = await runDiffCoverage({ run, cwd, harness, base, readFile });
      result.gates.diff_coverage = { status: dc.misconfigured ? "MISCONFIGURED" : dc.ok ? "GREEN" : "RED", log: `pct=${dc.pct} threshold=${dc.threshold} uncovered=${JSON.stringify(dc.uncovered || []).slice(0, 500)}` };
    }
    if (result.skipped.includes("mutation")) {
      const mu = await mutationGate({ run, cwd, harness, changedSources: ch.sources, readFile });
      result.gates.mutation = { status: mu.misconfigured ? "MISCONFIGURED" : mu.ok ? "GREEN" : "RED", log: `score=${mu.score} threshold=${mu.threshold} ${mu.detail || ""}` };
    }
  }
  return recomputeStatus(result, harness);
}

const list = (a) => (a && a.length ? a.join(",") : "none");
export function verdictLine(r) {
  return `FACTORY_GATES: level=${r.level} status=${r.status} passed=${r.passed} failed=${r.failed} failing=${list(r.failing)} skipped=${list(r.skipped)} misconfigured=${list(r.misconfigured)} excluded=${list(r.tests?.excluded)}`;
}
