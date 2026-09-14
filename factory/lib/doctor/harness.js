import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesAny } from "../glob.js";
import { probeEvidenceDir } from "../qa-evidence.js";
import { THRESHOLD_DEFAULTS } from "../config.js";
import { STAGES, parseStatusEntries } from "../../bin/run-stage.js";

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
 * "무엇도 검사하지 않고 항상 성공하는 명령"인가(감사 P1-7). 텍스트 판정이라 완전할 수 없다 — 의도적으로
 * 감추려는 사람(`node -e 'process.exit(0)'`)은 잡지 못한다. 목표는 그것이 아니라 **관성**이다: 린터를
 * 붙이기 전의 자리표시자가 그대로 배포되어 "lint GREEN"을 찍는 것을 막는 것.
 */
export function isNoopCommand(cmd) {
  const s = String(cmd ?? "").trim().replace(/\{file\}|\{files\}/g, "").trim();
  if (!s) return true;
  return [/^true$/, /^:$/, /^exit\s+0$/, /^node\s+-e\s+(['"])?0\1?$/, /^node\s+-e\s+(['"])\1$/, /^echo\b[^|&;]*$/].some((re) => re.test(s));
}

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
  const runnableLevels = LEVELS.slice(0, LEVELS.indexOf(maxLevel) + 1);
  /**
   * 감사 H2 — required는 레벨 목록보다 강해졌다(gates.js `recomputeStatus`): 어느 레벨이 뽑히든
   * required 게이트가 돌지 않았으면 MISCONFIGURED다. 그러니 "어느 한 레벨에라도 있으면 된다"는
   * 예전 기준으로는 부족하다 — **돌 수 있는 모든 레벨에** 있어야 그 하네스가 상시 MISCONFIGURED로
   * 멈추지 않는다. 증명 게이트(prove-test/new-test-repeat)도 이제 레벨 멤버라 예외가 없다.
   */
  const notInLevels = required.filter((g) => runnableLevels.some((l) => !(h.gates?.[l] || []).includes(g)));
  out.push(notInLevels.length
    ? c("gates.required-in-levels", "FAIL", `required gates absent from at least one level up to ${maxLevel} (they would never run there → MISCONFIGURED): ${notInLevels.join(", ")}`)
    : c("gates.required-in-levels", "PASS"));
  /**
   * 감사 H2 — **레벨이 전부 같으면 tier는 아무것도 정하지 않는다.** 실측 구성에서 fast/full/deep이
   * 글자 그대로 같았고, 그래서 load-bearing PR이 docs PR과 정확히 같은 게이트를 받았다. 레벨의 값은
   * "무거운 변경에는 더 많은 것이 돈다"이므로, full은 fast에 무언가를 더해야 하고 deep은 full을
   * 포함해야 한다. deep이 full과 같은 것은 **더 설정된 게이트가 없을 때만** 정상이다(M0 신규 저장소).
   */
  const fastSet = new Set(h.gates?.fast || []), fullSet = new Set(h.gates?.full || []), deepSet = new Set(h.gates?.deep || []);
  const configurable = ["integration", "e2e"].filter((g) => cmds[g]).concat(cmds.proof?.coverage ? ["diff_coverage"] : [], cmds.proof?.mutation ? ["mutation"] : []);
  const unlisted = configurable.filter((g) => !deepSet.has(g));
  const identical = [];
  if (![...fullSet].some((g) => !fastSet.has(g))) identical.push("full adds nothing to fast");
  if ([...fullSet].some((g) => !deepSet.has(g))) identical.push("deep is weaker than full (it must contain every full gate)");
  else if (![...deepSet].some((g) => !fullSet.has(g)) && unlisted.length) identical.push(`deep adds nothing to full though ${unlisted.join(", ")} is configured`);
  out.push(identical.length
    ? c("gates.levels-identical", "FAIL", `${identical.join("; ")} — tier then decides nothing (every PR gets the same gates)`)
    : c("gates.levels-identical", "PASS", deepSet.size === fullSet.size ? "deep == full (nothing more configured yet)" : ""));
  /**
   * 감사 H2 — M0의 `fast` 천장은 설계된 것이지만 **조용하면 안 된다**: full/deep에 적어 둔 게이트는
   * M0 동안 한 줄도 돌지 않는다(판정 파일의 `downgraded_from`이 그 사실을 남긴다).
   */
  const neverRun = [...new Set([...fullSet, ...deepSet])].filter((g) => !fastSet.has(g));
  out.push(h.harness?.maturity === "M0" && neverRun.length
    ? c("gates.m0-downgrade", "WARN", `maturity M0 caps every run at level fast — ${neverRun.join(", ")} never run until M1/M2 (each run records downgraded_from)`)
    : c("gates.m0-downgrade", "PASS"));
  /**
   * 감사 P1-7 — `lint = "node -e 0"`는 린트가 아니라 **항상 통과하는 게이트**다. required에 이름이
   * 올라 있으니 판정 파일에는 "lint GREEN"이 남고, 사람은 린트가 돌았다고 읽는다. 아무것도 검사하지
   * 않는 명령은 게이트가 아니므로 FAIL이다 — 린터를 붙이거나, 붙일 때까지 required에서 빼라.
   */
  const noop = [];
  for (const k of ["lint", "lint_file"]) {
    const cmd = cmds[k];
    if (cmd !== undefined && isNoopCommand(cmd)) noop.push(`[commands].${k} = ${JSON.stringify(cmd)} checks nothing`);
  }
  out.push(noop.length
    ? c("gates.lint-noop", "FAIL", `${noop.join("; ")} — a command that always exits 0 is not a gate; plug a real linter or drop lint from [gates].required`)
    : c("gates.lint-noop", "PASS"));
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
  // flaky_max·quarantine_max_effective는 0을 받는다 — "이 저장소에서는 아무것도 제외하지 않는다"는
  // 유효한(가장 엄격한) 설정이다. 음수·비수치만 잡는다.
  for (const k of ["flaky_max", "quarantine_max_effective"]) if (!(t[k] >= 0)) badT.push(`${k}=${t[k]} must be ≥ 0`);
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
  /**
   * ── 리뷰 batch-2 MF-2 — **run 기록 디렉터리는 러너의 것인가.** ───────────────────────────────
   * 머지 스테이지는 review handoff를 `docs/factory/runs/<n>.md`의 `review-evidence:` 줄과 대조한다.
   * 그 대조가 의미를 가지려면 그 파일이 **에이전트가 쓸 수 없는 것**이어야 하는데, 그 경로는
   * `[protected].factory`에 넣을 수 없다 — 러너가 매 스테이지 덧붙이고 사람 없이 머지돼야 한다.
   * 그 반쪽(쓰기 경계만)이 `[protected].runner_only`이고, 이 검사가 두 가지를 묻는다:
   *   ① `[project].runs_dir`가 실제로 그 목록에 덮이는가(아니면 훅/L2 deny가 그 디렉터리를 비운 채 생성된다),
   *   ② `runner_only`가 `[protected].factory`와 겹치지 않는가(겹치면 L1이 run 기록 PR을 사람에게 돌린다 —
   *      머지 경계와 쓰기 경계를 갈라 두려고 만든 키가 도로 붙어 버린다).
   * 판정은 FAIL이다: 이 목록이 비면 batch-2가 닫은 위조 경로가 그대로 다시 열린다.
   */
  const runnerOnly = h.protected?.runner_only || [];
  const runsDir = (h.project?.runs_dir || "docs/factory/runs").replace(/\/+$/, "");
  const runsProbe = `${runsDir}/7.md`;
  const overlap = runnerOnly.filter((g) => (h.protected?.factory || []).includes(g));
  out.push(
    !runnerOnly.length || !matchesAny(runnerOnly, runsProbe)
      ? c("protected.runner-only", "FAIL", `[protected].runner_only does not cover ${runsDir}/** — the run record is the review evidence the merge stage checks against, so an agent session that can write it can write its own verdict (add "${runsDir}/**" and run \`factory init --upgrade\`)`)
      : overlap.length
        ? c("protected.runner-only", "FAIL", `${overlap.join(", ")} is in both [protected].factory and [protected].runner_only — runner_only is the WRITE boundary only; listing it under factory makes every run-record PR a human merge`)
        : c("protected.runner-only", "PASS", runnerOnly.join(", "))
  );
  /**
   * 감사 H3의 나머지 절반 — **`[load_bearing].paths`가 아무 파일도 가리키지 않는 드리프트.**
   * 여기는 `[protected]`와 판정이 반대다(그쪽 와일드카드는 "미래의 경로 모양"을 막아 두는 것이라
   * 지금 매치가 없는 것이 정상이다): load-bearing 경로는 **지금 존재하는 코드**를 가리켜야 tier 바닥이
   * 선다. 매치가 0인 항목은 오타이거나, 파일이 옮겨졌거나, 레이아웃이 갈린 것이다 — 이 저장소의
   * 소스는 `factory/lib/…`인데 설치본은 `.factory/lib/…`이고, 한쪽만 적으면 목록은 그럴듯한데 그 경로를
   * 건드리는 PR이 조용히 load-bearing이 아니게 된다. 목록이 아예 비어 있으면 바닥은 영원히 standard다 —
   * 신규 저장소의 정상 상태이므로 FAIL이 아니라 WARN이다(§5.2.1의 하네스 스킬이 채운다).
   */
  const lbPaths = h.load_bearing?.paths || [];
  const lbUnmatched = lbPaths.filter((g) => !files.some((f) => matchesAny([g], f)));
  out.push(
    !lbPaths.length ? c("load-bearing.paths-exist", "WARN", "[load_bearing].paths is empty — every diff floors at standard; no PR can be load-bearing tier")
      : lbUnmatched.length ? c("load-bearing.paths-exist", "FAIL", `no file matches: ${lbUnmatched.join(", ")} — tier floor silently gone (installed layout is .factory/… , this repo's source is factory/…)`)
        : c("load-bearing.paths-exist", "PASS", `${lbPaths.length} path(s)`)
  );
  return out;
}

/**
 * ── ADR-020 KTB-39 — **`[runtime].setup`이 추적 파일을 다시 쓰는가.** ─────────────────────────
 * own-calendar #3(2026-09-14, 라이브): setup이 `flutter pub get`이라 스테이지가 시작하기도 전에
 * `client/pubspec.lock`·`client/<platform>/flutter/generated_plugin…`·`client/analysis_options.yaml`이 다시
 * 쓰였고, 쓰기 금지 스테이지(triage)의 클린 체크가 그 diff를 에이전트의 위반으로 읽어 이슈가
 * `factory:needs-human`으로 갔다. run-stage는 이제 그 기준선을 판정에서 빼지만(KTB-39), **그
 * 하네스는 여전히 고쳐야 할 것**이다: implement는 면제가 아니라 복원이라 setup 산출물이 매 라운드
 * 지워지고, 그중 빌드 입력이 있으면 게이트가 스스로 다시 만들어야 한다(setup은 잡당 한 번만 돈다).
 *
 * 판정은 **순수 함수**다 — `status`는 "이 저장소의 깨끗한 복제본에서 setup을 한 번 돌린 뒤의
 * `git status --porcelain`"이고, 그 표본을 만드는 것은 `runSetupProbe`(아래)다. 표본이 없으면
 * (오프라인·`--no-run`) 판정하지 않는다: 안 돌려 본 것을 PASS로도 WARN으로도 적지 않는다.
 */
/**
 * ── ADR-024 / KTB-42 — `qa.evidence-probe` ───────────────────────────────────────────────────
 * review 스테이지가 `claude -p` 전에 돌리는 것과 **같은 프로브**를 로컬에서도 한 번 돌린다
 * (`mkdir -p` + 쓰기 + 지우기). KTB #3에서 이 확인이 없어서 "qa가 증거를 남길 수 없다"는 사실이
 * 8라운드 뒤에야, 그것도 빌더를 가리키는 문장으로 드러났다 — doctor는 그 사실을 **사람이 손으로
 * 돌리는 자리**에서 먼저 말해야 한다.
 *
 * `--offline`/`--no-run`에서는 WARN이다: 프로브는 파일을 만들었다 지우므로 "아무것도 실행하지
 * 말라"는 요청을 무시할 수 없고, 안 돌려 본 것을 PASS로 적을 수도 없다.
 */
const QA_PROBE_ID = "qa.evidence-probe";
export function checkQaEvidenceProbe({ root, skipped = null, probe = probeEvidenceDir }) {
  if (skipped) return c(QA_PROBE_ID, "WARN", `not probed: ${skipped} — run \`factory doctor\` without it to check that .factory/out/qa/ is writable`);
  const r = probe({ root, issue: "probe" });
  return r.ok
    ? c(QA_PROBE_ID, "PASS", ".factory/out/qa/ is writable (the qa reviewer can record evidence)")
    : c(QA_PROBE_ID, "FAIL", `qa evidence dir not writable: ${r.reason} — the qa reviewer cannot record anything, and spec-conformance will read that as the builder's missing evidence (KTB-42)`);
}

export const SETUP_DIRTY_NOTE = "prefer setup commands that do not rewrite tracked files (pin toolchain versions; use lockfile-respecting installs)";
const SETUP_DIRTY_ID = "runtime.setup-dirties-tree";
export function checkSetupDirtiesTree({ harness: h, status = null, skipped = null, setupExit = 0 }) {
  const setup = h.runtime?.setup;
  if (!setup) return c(SETUP_DIRTY_ID, "PASS", "no [runtime].setup — nothing runs before the stage");
  if (skipped) return c(SETUP_DIRTY_ID, "PASS", `not probed: ${skipped}`);
  if (status == null) return c(SETUP_DIRTY_ID, "PASS", "not probed (offline or --no-run)");
  if (setupExit) return c(SETUP_DIRTY_ID, "WARN", `\`${setup}\` exited ${setupExit} in a scratch clone — cannot tell whether it rewrites tracked files`);
  const entries = parseStatusEntries(status);
  const tracked = [...new Set(entries.filter((e) => e.code !== "??").map((e) => e.path))];
  const untracked = [...new Set(entries.filter((e) => e.code === "??").map((e) => e.path))];
  if (!tracked.length && !untracked.length) return c(SETUP_DIRTY_ID, "PASS", `\`${setup}\` leaves the tree clean`);
  const shown = tracked.slice(0, 10).join(", ") + (tracked.length > 10 ? `, … (+${tracked.length - 10} more)` : "");
  const parts = [];
  if (tracked.length) parts.push(`${tracked.length} tracked path(s) rewritten by \`${setup}\`: ${shown}`);
  // 추적되지 않는 산출물도 무해하지 않다 — `.gitignore`에 없으니 빌더의 `git add -A`가 집는다.
  if (untracked.length) parts.push(`${untracked.length} untracked file(s) created (not gitignored — the builder's \`git add -A\` would commit them)`);
  return c(SETUP_DIRTY_ID, "WARN", `${parts.join("; ")} — ${SETUP_DIRTY_NOTE}`);
}

/**
 * 위 판정의 표본을 만든다(**부수 효과 있음**): 이 저장소를 임시 디렉터리에 로컬 복제하고, 거기서
 * `[runtime].setup`을 한 번 돌린 뒤 `git status`를 읽는다. 작업 트리에서 돌리지 않는 이유는 명백하다 —
 * doctor가 사람의 변경 위에 setup을 덮어쓰면 안 된다. 복제는 `--local`(하드링크 없음)이라
 * **커밋된 상태**만 담는다: 커밋되지 않은 하네스 수정은 이 프로브에 보이지 않는다(알려진 한계).
 */
export async function runSetupProbe({ run, cwd, harness: h, tmpRoot = tmpdir(), mkdtemp = mkdtempSync, rm = rmSync }) {
  const setup = h.runtime?.setup;
  if (!setup) return { skipped: "no [runtime].setup" };
  let dir;
  try { dir = mkdtemp(join(tmpRoot, "factory-setup-probe-")); }
  catch (e) { return { skipped: `scratch dir unavailable: ${e?.message || e}` }; }
  try {
    const cl = await run("git", ["clone", "--local", "--no-hardlinks", "--quiet", cwd, dir], { cwd });
    if (cl.code !== 0) return { skipped: `scratch clone failed: ${cl.stderr?.trim() || `exit ${cl.code}`}` };
    const s = await run("bash", ["-lc", setup], { cwd: dir });
    const st = await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir });
    if (st.code !== 0) return { skipped: `git status failed in the scratch clone: ${st.stderr?.trim() || `exit ${st.code}`}` };
    return { status: st.stdout, setupExit: s.code };
  } finally {
    try { rm(dir, { recursive: true, force: true }); } catch { /* best-effort — 임시 디렉터리다 */ }
  }
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
