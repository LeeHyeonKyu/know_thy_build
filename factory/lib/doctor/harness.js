import { matchesAny } from "../glob.js";
import { THRESHOLD_DEFAULTS } from "../config.js";

const PROOF_GATES = { diff_coverage: ["coverage", "coverage_report"], mutation: ["mutation", "mutation_report"], "prove-test": [], "new-test-repeat": [] };
const TEMPLATED = { lint_file: ["{file}"], test_files: ["{files}"], test_one: ["{file}", "{name}"] };
const MAX_LEVEL = { M0: "fast", M1: "full", M2: "deep" };
const LEVELS = ["fast", "full", "deep"];
const c = (id, level, detail = "") => ({ id, level, detail });

/** harness.toml의 스키마·게이트·명령·임계값·보호 범위를 정적으로 검사한다 (프로세스 실행 없음). */
export function checkHarness({ harness: h, files = [] }) {
  const out = [];
  out.push(h.schema === 1 ? c("harness.schema", "PASS") : c("harness.schema", "FAIL", `schema must be 1, got ${h.schema}`));
  out.push(h.project?.default_branch ? c("project.default_branch", "PASS", h.project.default_branch) : c("project.default_branch", "FAIL", "[project].default_branch missing"));
  out.push(MAX_LEVEL[h.harness?.maturity] ? c("harness.maturity", "PASS", h.harness.maturity) : c("harness.maturity", "FAIL", `[harness].maturity must be M0|M1|M2, got ${h.harness?.maturity}`));
  out.push(["workflow", "agent"].includes(h.factory?.orchestration) ? c("factory.orchestration", "PASS") : c("factory.orchestration", "FAIL", `[factory].orchestration must be workflow|agent`));
  out.push(Array.isArray(h.factory?.required_checks) && h.factory.required_checks.length ? c("factory.required_checks", "PASS", h.factory.required_checks.join(",")) : c("factory.required_checks", "FAIL", "[factory].required_checks must list at least one check"));
  // commands
  const cmds = h.commands || {};
  const badPh = Object.entries(TEMPLATED).filter(([k, phs]) => cmds[k] && phs.some((p) => !cmds[k].includes(p))).map(([k, phs]) => `${k} must contain ${phs.join(" and ")}`);
  out.push(badPh.length ? c("commands.placeholders", "FAIL", badPh.join("; ")) : c("commands.placeholders", "PASS"));
  for (const k of ["lint", "unit", "test_files"]) out.push(cmds[k] ? c(`commands.${k}`, "PASS") : c(`commands.${k}`, "FAIL", `[commands].${k} is required at M0`));
  // gates
  const required = h.gates?.required || [];
  const known = (g) => g in cmds || g in PROOF_GATES;
  const unknown = required.filter((g) => !known(g));
  out.push(unknown.length ? c("gates.required-in-commands", "FAIL", `required gates not in [commands] or proof set: ${unknown.join(", ")}`) : c("gates.required-in-commands", "PASS"));
  const maxLevel = MAX_LEVEL[h.harness?.maturity] || "fast";
  const allowed = new Set(LEVELS.slice(0, LEVELS.indexOf(maxLevel) + 1).flatMap((l) => h.gates?.[l] || []));
  const notInLevels = required.filter((g) => !allowed.has(g) && !["prove-test", "new-test-repeat"].includes(g));
  out.push(notInLevels.length ? c("gates.required-in-levels", "FAIL", `required gates absent from every level up to ${maxLevel}: ${notInLevels.join(", ")}`) : c("gates.required-in-levels", "PASS"));
  const beyond = LEVELS.slice(LEVELS.indexOf(maxLevel) + 1).filter((l) => (h.gates?.[l] || []).some((g) => !(h.gates?.[maxLevel] || []).includes(g)));
  out.push(beyond.length ? c("gates.levels-vs-maturity", "WARN", `${beyond.join(",")} list gates beyond maturity ${h.harness?.maturity}; they will be downgraded to ${maxLevel}`) : c("gates.levels-vs-maturity", "PASS"));
  // 모든 레벨을 훑는다 — 의도적이다: 증명 도구는 그 레벨이 활성화되기 전, 게이트를 도입하는
  // 성숙도에서부터 이미 갖춰져 있어야 한다 (§5.2.1).
  const proofMissing = [];
  for (const l of LEVELS) for (const g of h.gates?.[l] || []) for (const k of PROOF_GATES[g] || []) if (!cmds.proof?.[k]) proofMissing.push(`${g} needs [commands.proof].${k}`);
  out.push(proofMissing.length ? c("proof.commands", "FAIL", [...new Set(proofMissing)].join("; ")) : c("proof.commands", "PASS"));
  // thresholds
  const t = { ...THRESHOLD_DEFAULTS, ...(h.gates?.thresholds || {}) };
  const badT = [];
  for (const k of ["diff_coverage_pct", "mutation_score_pct"]) if (!(t[k] >= 0 && t[k] <= 100)) badT.push(`${k}=${t[k]} out of 0..100`);
  if (!(t.new_test_repeats >= 2)) badT.push(`new_test_repeats=${t.new_test_repeats} must be ≥ 2`);
  for (const k of ["flaky_isolation_runs", "flaky_base_runs", "quarantine_max", "quarantine_ttl_days", "quarantine_return_after"]) if (!(t[k] >= 1)) badT.push(`${k}=${t[k]} must be ≥ 1`);
  out.push(badT.length ? c("thresholds.range", "FAIL", badT.join("; ")) : c("thresholds.range", "PASS"));
  // test
  out.push((h.test?.test_glob || []).length ? c("test.test_glob", "PASS") : c("test.test_glob", "FAIL", "[test].test_glob must not be empty"));
  const smoke = Object.values(h.test?.smoke || {});
  const smokeMissing = smoke.filter((f) => !files.includes(f));
  out.push(!smoke.length ? c("test.smoke", "FAIL", "[test].smoke must name at least the unit smoke test") : smokeMissing.length ? c("test.smoke", "FAIL", `smoke files missing: ${smokeMissing.join(", ")}`) : c("test.smoke", "PASS"));
  // protected
  const globs = h.protected?.factory || [];
  const unmatched = globs.filter((g) => !files.some((f) => matchesAny([g], f)));
  out.push(!globs.length ? c("protected.globs-match", "FAIL", "[protected].factory is empty") : unmatched.length ? c("protected.globs-match", "WARN", `no file matches: ${unmatched.join(", ")}`) : c("protected.globs-match", "PASS"));
  return out;
}

/** [commands]의 비-템플릿 명령(및 proof 제외)을 실제로 실행해 종료 코드를 보고한다. */
export async function checkCommands({ harness: h, run, cwd, skipRun = false }) {
  if (skipRun) return [c("commands.run", "WARN", "--no-run: commands not executed")];
  const out = [];
  for (const [k, cmd] of Object.entries(h.commands || {})) {
    if (k === "proof" || k in TEMPLATED) continue;
    const r = await run("bash", ["-lc", cmd], { cwd });
    out.push(r.code === 0 ? c(`commands.run.${k}`, "PASS", cmd) : c(`commands.run.${k}`, "FAIL", `${cmd} → exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`));
  }
  return out;
}
