import { matchesAny } from "../glob.js";
import { THRESHOLD_DEFAULTS } from "../config.js";
import { STAGES } from "../../bin/run-stage.js";

const PROOF_GATES = { diff_coverage: ["coverage", "coverage_report"], mutation: ["mutation", "mutation_report"], "prove-test": [], "new-test-repeat": [] };
const TEMPLATED = { lint_file: ["{file}"], test_files: ["{files}"], test_one: ["{file}", "{name}"] };
const MAX_LEVEL = { M0: "fast", M1: "full", M2: "deep" };
const LEVELS = ["fast", "full", "deep"];
// `[factory.max_turns_by_stage]`가 받아 주는 키 — run-stage의 다섯 스테이지(STAGES) + retro
// (`bin/retro.js`의 `stageMaxTurns(harness, "retro")`, §8). sweep은 `claude -p`를 부르지 않으므로
// 여기 없다.
const MAX_TURNS_STAGE_KEYS = new Set([...STAGES, "retro"]);
const c = (id, level, detail = "") => ({ id, level, detail });

/**
 * harness.toml의 스키마·게이트·명령·임계값·보호 범위를 정적으로 검사한다 (프로세스 실행 없음).
 * `raw`(옵션, 기본값 `h`)는 `loadHarness`의 기본값 채움 **이전** 파스다 — `[factory].max_turns`가
 * 파일에 아예 없는지(WARN) vs 정상적으로 채워졌는지(PASS)는 정규화된 `h`만으로는 절대 구별할 수
 * 없다(`loadHarness`가 항상 12를 채운다). 단위 테스트가 직접 만든 객체를 넘길 때는 `h` 자체를
 * "raw"로 취급한다(기본값).
 */
export function checkHarness({ harness: h, files = [], raw = h }) {
  const out = [];
  out.push(h.schema === 1 ? c("harness.schema", "PASS") : c("harness.schema", "FAIL", `schema must be 1, got ${h.schema}`));
  out.push(h.project?.default_branch ? c("project.default_branch", "PASS", h.project.default_branch) : c("project.default_branch", "FAIL", "[project].default_branch missing"));
  out.push(MAX_LEVEL[h.harness?.maturity] ? c("harness.maturity", "PASS", h.harness.maturity) : c("harness.maturity", "FAIL", `[harness].maturity must be M0|M1|M2, got ${h.harness?.maturity}`));
  out.push(["workflow", "agent"].includes(h.factory?.orchestration) ? c("factory.orchestration", "PASS") : c("factory.orchestration", "FAIL", `[factory].orchestration must be workflow|agent`));
  out.push(Array.isArray(h.factory?.required_checks) && h.factory.required_checks.length ? c("factory.required_checks", "PASS", h.factory.required_checks.join(",")) : c("factory.required_checks", "FAIL", "[factory].required_checks must list at least one check"));
  // max_turns(KTB-16). 하한 3은 백그라운드 디스패처의 최소 턴(호출·알림·출력)이고, 상한 50은
  // "한 스테이지가 50턴을 쓰고 있다면 그건 한도 문제가 아니다"는 선이다 — 오타로 12가 120이 되면
  // 잘못된 프롬프트가 몇 시간·수백 달러를 태울 수 있으므로 doctor가 범위를 잡는다.
  const badTurns = [];
  const turns = (v, where) => { if (v !== undefined && !(Number.isInteger(v) && v >= 3 && v <= 50)) badTurns.push(`${where}=${v} must be an integer 3–50`); };
  turns(h.factory?.max_turns, "[factory].max_turns");
  for (const [stage, v] of Object.entries(h.factory?.max_turns_by_stage || {})) turns(v, `[factory.max_turns_by_stage].${stage}`);
  // `raw`는 loadHarness의 기본값(12) 채움 이전이다 — 정규화된 `h`는 파일에 키가 있었는지 없었는지
  // 절대 구별하지 못한다(둘 다 12로 보인다). "없음"은 raw로만 판정한다.
  out.push(badTurns.length ? c("factory.max_turns", "FAIL", badTurns.join("; "))
    : raw?.factory?.max_turns === undefined ? c("factory.max_turns", "WARN", "[factory].max_turns not set — the default 12 applies; run `npx know-thy-build factory init --upgrade`")
      : c("factory.max_turns", "PASS", String(h.factory.max_turns)));
  // M3: `max_turns_by_stage`는 알려진 스테이지 이름만 받는다 — 오타(`"pln"` 등)는 조용히 무시되고
  // (stageMaxTurns가 못 찾으면 공통 max_turns로 떨어진다) 아무 효과도 없다. FAIL이 아니라 WARN인
  // 이유: 오타여도 공장이 멈추지 않는다 — 그냥 의도한 오버라이드가 적용되지 않을 뿐이다.
  const unknownStages = Object.keys(h.factory?.max_turns_by_stage || {}).filter((s) => !MAX_TURNS_STAGE_KEYS.has(s));
  out.push(unknownStages.length
    ? c("factory.max_turns_by_stage.keys", "WARN", `unknown stage(s) in [factory.max_turns_by_stage], no effect: ${unknownStages.join(", ")} (known: ${[...MAX_TURNS_STAGE_KEYS].join(", ")})`)
    : c("factory.max_turns_by_stage.keys", "PASS"));
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
  // protected — 매치하지 않는 글롭이라고 다 같은 문제가 아니다.
  // 와일드카드(`playwright.config.*`, `tsconfig*.json`)는 **미래의 경로 모양**을 막아 두는 것이라, 지금
  // 그런 파일이 없는 것이 정상이다(그 파일이 생기는 순간부터 보호되는 게 목적). 그걸 WARN으로 올리면
  // 아무도 못 고치는 경고가 상시로 떠서 doctor의 WARN 전체가 무시당한다 → PASS + "(optional, no match)".
  // 반대로 와일드카드가 없는 **리터럴 경로**가 아무것도 매치하지 않으면 그건 오타이거나 지워진 파일이다 → WARN.
  const globs = h.protected?.factory || [];
  const unmatched = globs.filter((g) => !files.some((f) => matchesAny([g], f)));
  const literal = unmatched.filter((g) => !/[*?]/.test(g));
  const wildcard = unmatched.filter((g) => /[*?]/.test(g));
  out.push(
    !globs.length ? c("protected.globs-match", "FAIL", "[protected].factory is empty")
      : literal.length ? c("protected.globs-match", "WARN", `no file matches: ${literal.join(", ")}`)
        : c("protected.globs-match", "PASS", wildcard.length ? `(optional, no match): ${wildcard.join(", ")}` : "")
  );
  return out;
}

/**
 * [commands]의 비-템플릿 명령(및 proof 제외)을 실제로 실행해 종료 코드를 보고한다.
 * `skipReason`이 있으면(=doctor.js가 test env-up을 먼저 시도했다가 실패한 경우) 명령을 하나도 실행하지 않고
 * 각각 FAIL로 보고한다 — 환경 없이 돌리면 DB가 있는 저장소는 상시 거짓 FAIL이 나기 때문(harness.toml 주석,
 * §5.2.1). smoke 블록은 이미 `envResult.ok`로 이 게이팅을 하고 있었다 — commands도 대칭으로 맞춘다.
 */
export async function checkCommands({ harness: h, run, cwd, skipRun = false, skipReason = null }) {
  if (skipRun) return [c("commands.run", "WARN", "--no-run: commands not executed")];
  const out = [];
  for (const [k, cmd] of Object.entries(h.commands || {})) {
    if (k === "proof" || k in TEMPLATED) continue;
    if (skipReason) { out.push(c(`commands.run.${k}`, "FAIL", `skipped: test env not up (${skipReason})`)); continue; }
    const r = await run("bash", ["-lc", cmd], { cwd });
    out.push(r.code === 0 ? c(`commands.run.${k}`, "PASS", cmd) : c(`commands.run.${k}`, "FAIL", `${cmd} → exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`));
  }
  return out;
}
