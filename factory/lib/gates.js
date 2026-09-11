import { parseVitestJson } from "./parsers/vitest-json.js";
import { isQuarantined } from "./quarantine.js";

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

export async function runGates({ run, cwd, harness, level, quarantine, readFile, now = new Date().toISOString() }) {
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
    if (TEST_GATES.has(name)) {
      const report = readFile(`${cwd}/${harness.test[`${name}_report`] || `.factory/out/${name}.json`}`);
      if (report) {
        const parsed = parseVitestJson(report, cwd);
        const excluded = parsed.failing.filter((f) => isQuarantined(quarantine, f.id)).map((f) => f.id);
        const remaining = parsed.failing.filter((f) => !excluded.includes(f.id));
        tests = { ...(tests || { total: 0, passed: 0, failed: 0, failing: [], excluded: [] }) };
        tests.total += parsed.total; tests.passed += parsed.passed; tests.failed += remaining.length;
        tests.failing.push(...remaining); tests.excluded.push(...excluded);
        if (status === "RED" && remaining.length === 0 && parsed.failed > 0) status = "GREEN";   // 실패가 전부 격리 대상
      }
    }
    gates[name] = { status, code: r.code, duration_ms: Date.now() - t0, log: (r.stderr + r.stdout).slice(-2000) };
  }
  const result = { schema: "factory.gates.v1", level, requested_level, downgraded_from: level === requested_level ? null : requested_level, status: null, gates, passed: 0, failed: 0, failing: [], skipped: [], misconfigured: [], tests, ran_at: now };
  return recomputeStatus(result, harness);
}

const list = (a) => (a && a.length ? a.join(",") : "none");
export function verdictLine(r) {
  return `FACTORY_GATES: level=${r.level} status=${r.status} passed=${r.passed} failed=${r.failed} failing=${list(r.failing)} skipped=${list(r.skipped)} misconfigured=${list(r.misconfigured)} excluded=${list(r.tests?.excluded)}`;
}
