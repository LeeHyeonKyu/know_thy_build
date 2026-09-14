import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseVitestJson } from "./parsers/vitest-json.js";
import { isQuarantined, recordResult } from "./quarantine.js";
import { changedFiles } from "./changed-files.js";
import { matchesAny } from "./glob.js";
import { classifyFailures } from "./classify-failure.js";
import { proveTest, repeatNewTests } from "./prove-test.js";
import { runDiffCoverage } from "./diff-coverage.js";
import { mutationGate } from "./mutation.js";
import { scrubbedRunner } from "./exec.js";
import { SECRET_ENV, scrubText } from "../bin/scrub-artifacts.js";

const LEVELS = ["fast", "full", "deep"];
/**
 * 성숙도별 레벨 상한(§5.2.1). M0은 `fast`가 천장이다 — 막 도입한 저장소가 아직 없는 도구(커버리지·
 * mutation·e2e)를 요구받아 상시 MISCONFIGURED가 되지 않게 하는 장치다. 대신 그 강등은 **조용하지
 * 않다**: 판정 파일에 `downgraded_from`이 남고(아래 runGates), doctor가 `gates.m0-downgrade`로 WARN한다
 * (감사 H2 — 강등이 보이지 않으면 "full/deep에 적어 둔 게이트가 도는 중"이라고 착각하게 된다).
 */
const MAX_LEVEL = { M0: "fast", M1: "full", M2: "deep" };
/**
 * 명령 게이트가 아니라 **명령 게이트 뒤에** 재는 게이트들. 감사 H2: 예전에는 prove-test와
 * new-test-repeat가 레벨 목록 밖에서 사후 주입됐고, 그래서 `required`가 그 이름을 부를 수 없었다.
 * 이제 넷 다 레벨 목록의 정식 멤버다 — 목록에 있으면 SKIPPED 자리를 먼저 잡고, 스테이지가 실제로
 * 잰 뒤 그 자리를 채운다. 재지 못한 required 증명 게이트는 SKIPPED로 남아 MISCONFIGURED가 된다.
 */
const DEFERRED_GATES = new Set(["diff_coverage", "mutation", "prove-test", "new-test-repeat"]);
const TEST_GATES = new Set(["unit", "integration", "e2e"]);
/** 한 PR에서 격리가 RED→GREEN으로 뒤집을 수 있는 테스트 수의 상한(감사 M4). */
export const QUARANTINE_MAX_EFFECTIVE = 3;
/** 한 PR에서 `flaky-existing`으로 제외할 수 있는 기존 테스트 수의 상한(감사 M3). */
export const FLAKY_MAX = 2;
/**
 * 게이트 판정 → 커밋 상태. GREEN 하나만 success다 — RED도, MISCONFIGURED도, BLOCKED도, 판정이
 * 아예 없는 것도 success가 아니다(감사 H2: fail-closed의 마지막 한 칸은 "상태를 뭐라고 게시하는가"다).
 */
export const commitStatusState = (status) => (status === "GREEN" ? "success" : "failure");

/**
 * result.gates 맵으로부터 failing/skipped/misconfigured/passed/failed/status를 재계산해
 * result에 반영하고 그대로 돌려준다 (순수 함수: gates 맵만 보고 판정; 호출자가 gates를
 * 직접 수정한 뒤에도 다시 불러 일관된 판정을 얻을 수 있다).
 */
export const EMPTY_LEVEL = "<level list empty>";

/**
 * ADR-020 KTB-35 — **exit≠0인데 깨진 테스트는 0개.** 라이브(KTB #3 implement R2, run 34809992796):
 * `unit`이 code 1로 RED인데 `unit.json`은 1715/1715 통과였다. 그 전 publish CI에서는 vitest가 포크된
 * 워커의 `console.error`에서 `Error: write EPIPE`로 죽었다 — 테스트는 전부 끝난 뒤였다.
 *
 * 판정은 **그대로 RED다**(fail closed — 무엇이 죽였는지 모르는 채 GREEN으로 부르지 않는다). 바뀌는
 * 것은 사람이 받는 문장이다: `gates RED: failing=unit`은 "테스트가 깨졌다"로 읽히는데 깨진 테스트는
 * 없었고, 그 오독은 사람을 제품 코드로 보낸다. 그래서 이 게이트는 **왜 RED인지**를 스스로 적고
 * (`reason`), 원인이 실제로 있는 자리(명령의 stderr 꼬리)를 `log`에 싣는다.
 */
export const UNHANDLED_TAIL_LINES = 20;
export const unhandledReason = (code) => `command exited ${code} with 0 failing tests — unhandled error outside tests (see gate log)`;
/** stderr(비면 stdout)의 마지막 N줄 — 크리덴셜은 지우고(`scrub-artifacts.js`가 유일한 규칙 출처다). */
export function unhandledGateLog(stderr, stdout, { env = process.env } = {}) {
  const text = String(stderr || "").trim() || String(stdout || "");
  const tail = text.split("\n").slice(-UNHANDLED_TAIL_LINES).join("\n");
  const secrets = SECRET_ENV.map((n) => env?.[n]).filter((v) => typeof v === "string" && v.length > 0);
  return scrubText(tail, { secrets }).text.slice(-2000);
}

export function recomputeStatus(result, harness) {
  const gates = result.gates;
  const failing = [], skipped = [], misconfigured = [];
  for (const [name, g] of Object.entries(gates)) {
    if (g.status === "RED") failing.push(name);
    else if (g.status === "SKIPPED") skipped.push(name);
    else if (g.status === "MISCONFIGURED") misconfigured.push(name);
  }
  // 레벨 목록이 비어 있으면 "전부 통과"가 아니라 "아무것도 물리지 않았다"다 — GREEN으로 부르지 않는다.
  const names = harness.gates?.[result.level] || [];
  const emptyLevel = !names.length;
  if (emptyLevel) misconfigured.push(EMPTY_LEVEL);
  /**
   * 감사 H2 — **required는 레벨 목록보다 강하다.** 예전 규칙은 `names.includes(n)`으로 걸러서,
   * required에 적혀 있지만 이 레벨 목록에 없는 게이트를 "이 레벨의 확인 대상이 아님"으로 읽었다.
   * 실측 결과가 그 규칙의 값이다: required 8개 중 다섯 개가 한 번도 돌지 않은 PR이 GREEN이었다.
   * required는 "이 저장소에서 무엇이 통과해야 머지인가"의 선언이지 레벨별 취향이 아니다 — 적어
   * 두었으면 어느 레벨이 뽑히든 **돌아서 GREEN이어야** 하고, 돌지 않았으면(목록에 없어서든,
   * 설정 오류든, SKIPPED로 남았든) 그건 통과가 아니라 MISCONFIGURED다. 레벨을 가볍게 돌리고
   * 싶으면 required에서 빼야 한다 — 빼는 것은 diff에 남고, 무시되는 것은 아무 데도 남지 않는다.
   */
  const requiredMissing = (harness.gates.required || []).filter((n) => misconfigured.includes(n) || skipped.includes(n) || !(n in gates));
  const passed = Object.values(gates).filter((g) => g.status === "GREEN").length;
  /**
   * 감사 H2 — **설정 오류는 통과가 아니다.** 예전에는 `misconfigured`가 차 있어도 required가 아니면
   * 판정에 영향이 없었다(실측: `status=GREEN misconfigured=prove-test,new-test-repeat,diff_coverage,
   * mutation`). 설정 오류는 "이 게이트가 무엇을 말하는지 모른다"는 뜻이고, 모르는 것은 GREEN도
   * RED도 아니다 — 사람이 하네스를 고쳐야 하는 MISCONFIGURED다(exit 2, 커밋 상태는 failure).
   */
  const status = misconfigured.length || requiredMissing.length ? "MISCONFIGURED" : failing.length ? "RED" : "GREEN";
  result.failing = failing;
  result.skipped = skipped;
  result.misconfigured = misconfigured;
  result.required_missing = requiredMissing;
  result.passed = passed;
  result.failed = failing.length;
  result.status = status;
  return result;
}

export async function runGates({ run, cwd, harness, level, quarantine, touchedFiles = [], readFile = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null), now = new Date().toISOString() }) {
  const requested_level = level;
  const max = MAX_LEVEL[harness.harness?.maturity] || "deep";
  if (LEVELS.indexOf(level) > LEVELS.indexOf(max)) level = max;
  const names = harness.gates[level] || [];
  const gates = {};
  let tests = null;
  /**
   * 감사 M4 — 격리는 "실행은 하되 판정에서만 제외"다. 그 제외에 두 개의 문이 필요하다.
   * ① **PR이 그 테스트 파일을 건드렸으면 뒤집지 않는다.** 건드린 테스트를 자기가 면제하는 것은
   *    격리가 아니라 자기 채점이다(격리 목록은 `.factory/quarantine.toml` — PR이 함께 고칠 수 있다).
   * ② **한 PR에서 뒤집는 개수에 상한이 있다.** 상한이 없으면 격리 목록이 긴 저장소에서 "빨간 테스트가
   *    전부 목록에 있어서 GREEN"이 성립한다. 상한을 넘긴 시도는 버리는 게 아니라 기록한다.
   */
  const touched = new Set(touchedFiles);
  const maxEffective = harness.gates?.thresholds?.quarantine_max_effective ?? QUARANTINE_MAX_EFFECTIVE;
  const quarantineApplied = [], quarantineRefused = [];
  for (const name of names) {
    // SKIPPED·MISCONFIGURED도 다른 게이트와 같은 모양을 갖는다 — 읽는 쪽이 없는 필드를 추측하지 않게.
    if (DEFERRED_GATES.has(name)) { gates[name] = entry("SKIPPED", "proof gate — measured after the command gates"); continue; }
    const cmd = harness.commands[name];
    if (!cmd) { gates[name] = entry("MISCONFIGURED", `commands.${name} missing`); continue; }
    const t0 = Date.now();
    const r = await run("bash", ["-lc", cmd], { cwd });
    let status = r.code === 0 ? "GREEN" : "RED";
    // parsed/failing_ids: 이 게이트의 RED가 "어떤 테스트 때문인지" 아는가. 리포트를 못 읽었으면
    // (parsed:false) 그 RED의 이유를 모르는 것이고, 나중에 어떤 근거로도 GREEN으로 뒤집으면 안 된다.
    let reportParsed = false, failing_ids = null, unhandled = false;
    if (TEST_GATES.has(name)) {
      const rep = harness.test[`${name}_report`] || `.factory/out/${name}.json`;
      const reportPath = isAbsolute(rep) ? rep : join(cwd, rep);
      const report = readFile(reportPath);
      if (report) {
        const parsed = parseVitestJson(report, cwd);
        reportParsed = !parsed.error;
        failing_ids = parsed.failing.map((f) => f.id);
        const excluded = [];
        for (const f of parsed.failing) {
          if (!isQuarantined(quarantine, f.id)) continue;
          if (touched.has(f.file)) { quarantineRefused.push({ id: f.id, gate: name, reason: "test file is in this PR's diff" }); continue; }
          if (quarantineApplied.length >= maxEffective) { quarantineRefused.push({ id: f.id, gate: name, reason: `quarantine cap ${maxEffective} reached for this PR` }); continue; }
          quarantineApplied.push({ id: f.id, gate: name });
          excluded.push(f.id);
        }
        const remaining = parsed.failing.filter((f) => !excluded.includes(f.id));
        tests = { ...(tests || { total: 0, passed: 0, failed: 0, failing: [], excluded: [] }) };
        tests.total += parsed.total; tests.passed += parsed.passed; tests.failed += remaining.length;
        tests.failing.push(...remaining); tests.excluded.push(...excluded);
        if (status === "RED" && remaining.length === 0 && parsed.failed > 0) status = "GREEN";   // 실패가 전부 격리 대상
        // 반대 방향도 막는다: 리포트가 격리 대상이 아닌 실패를 보여주는데 명령이 exit 0이면
        // (리포터가 삼켰거나 `|| true`가 붙었거나) 그건 통과가 아니다 — 리포트가 이긴다.
        if (status === "GREEN" && remaining.length > 0) status = "RED";
        // KTB-35: 리포트를 **실제로 읽었고**(parsed) 그 안의 실패가 0인데 명령이 실패했다 —
        // 테스트 밖에서 무언가 죽었다는 뜻이다. 리포트를 못 읽은 RED는 이 경로가 아니다(그 RED의
        // 이유는 "모른다"이지 "테스트 밖 오류"가 아니다 — 아는 것만 말한다).
        if (status === "RED" && reportParsed && r.code !== 0 && parsed.failed === 0 && parsed.failing.length === 0) unhandled = true;
      }
    }
    gates[name] = {
      status, code: r.code, duration_ms: Date.now() - t0,
      log: unhandled ? unhandledGateLog(r.stderr, r.stdout) : (r.stderr + r.stdout).slice(-2000),
    };
    if (unhandled) gates[name].reason = unhandledReason(r.code);
    if (TEST_GATES.has(name)) { gates[name].parsed = reportParsed; gates[name].failing_ids = failing_ids || []; }
  }
  const result = { schema: "factory.gates.v1", level, requested_level, downgraded_from: level === requested_level ? null : requested_level, status: null, gates, passed: 0, failed: 0, failing: [], skipped: [], misconfigured: [], tests, quarantine_applied: quarantineApplied, quarantine_refused: quarantineRefused, ran_at: now };
  return recomputeStatus(result, harness);
}

/** 명령을 돌리지 않은 게이트 엔트리 — 이유는 log에 싣는다. */
const entry = (status, log) => ({ status, code: null, duration_ms: 0, log });

/** CHARTER tier → 게이트 레벨. 모르는 tier는 standard처럼 취급한다(약한 쪽으로 기울지 않는다). */
const LEVEL_OF_TIER = { docs: "fast", standard: "full", "load-bearing": "deep" };
export const levelForTier = (tier) => LEVEL_OF_TIER[tier] || "full";

export const TIER_ORDER = ["docs", "standard", "load-bearing"];
/** 모르는 tier는 standard로 정규화한다 — levelForTier와 같은 보수성이다. */
export const normalizeTier = (t) => (TIER_ORDER.includes(t) ? t : "standard");
/**
 * 두 tier 중 **높은 쪽**. 모르는 값은 `normalizeTier`의 보수성으로 "standard"다 — 모르는 값을
 * 만났을 때 docs(=가장 약한 레벨)로 기우는 것은 자기 신고를 그대로 믿는 것과 같다.
 * (감사 H3 / Task 4: `lib/context.js`의 `resolveTier`와 `run-stage.js`의 `reviewRoster()`가
 * triage 자기 신고와 diff 바닥을 이 함수로 합친다 — export된 이유가 그것이다.)
 */
export const maxTier = (a, b) => TIER_ORDER[Math.max(TIER_ORDER.indexOf(normalizeTier(a)), TIER_ORDER.indexOf(normalizeTier(b)))];
const DOC_GLOBS = ["docs/**", "*.md"];
/**
 * 외부 감사 M12 — **문서처럼 생겼지만 문서가 아닌 것들.** `DOC_GLOBS`만으로 판정하던 시절
 * `docs/factory/CHARTER.md`(판정 기준 그 자체)와 `.claude/agents/reviewer-*.md`(리뷰어 프롬프트)의
 * 변경이 `docs` tier로 떨어졌다 — 그 PR은 fast 레벨에 리뷰어 한 명을 받는다. 곧 "무엇이 통과인가"와
 * "누가 채점하는가"를 고치는 diff가 가장 가벼운 심사를 받았다.
 *
 * 이 목록은 **경로의 모양**으로 그것을 막는다(설정·프롬프트·워크플로·템플릿·팩토리 소스). 여기에
 * `[protected].factory` 글롭이 더해진다 — 저장소마다 다른 "사람이 머지해야 하는 경로"는 정의상
 * docs tier가 아니다(그 diff는 사람이 읽어야 하는 diff다). 둘 다 **바닥을 올리기만** 한다.
 *
 * 리뷰 batch-2 MF-3 — 깊이 무관 글롭(CLAUDE*.md·AGENTS*.md·.mcp*.json)이 여기 들어온 이유: 그것들은
 * "문서처럼 생긴" 정도가 아니라 **다음 세션의 지시문**이다. `docs/CLAUDE.md` 한 장이 tier `docs`로
 * 떨어지면 가장 작은 로스터가 그 PR을 본다 — 리뷰 세션에게 무엇을 승인하라고 적어 놓은 그 파일을.
 * `[protected].factory`에도 같은 글롭이 있지만 그쪽은 저장소마다 다르다: 이 목록은 **모든 채택자**에게
 * 같은 바닥을 준다.
 */
export const NEVER_DOCS_GLOBS = [".claude/**", "templates/**", ".factory/**", ".github/**", "factory/**",
  "**/CLAUDE*.md", "**/AGENTS*.md", "**/.mcp*.json"];

/**
 * diff가 정하는 tier의 **바닥**. tier는 triage 에이전트의 자기 신고이고, 자기 신고는 게이트 레벨을
 * 낮추는 방향으로 틀릴 수 있다 — 코드를 건드린 PR이 "docs"라고 말해도 docs 레벨로 통과시키지 않는다.
 * (감사 H3: 이 바닥은 게이트 레벨뿐 아니라 **로스터·계획 라운드**의 출처이기도 하다 — `lib/context.js`.)
 */
export function tierFloor({ changed, harness }) {
  const files = changed?.all || [];
  const lb = harness.load_bearing?.paths || [];
  if (files.some((f) => matchesAny(lb, f))) return "load-bearing";
  const prot = harness.protected?.factory || [];
  if (files.some((f) => !matchesAny(DOC_GLOBS, f) || matchesAny(NEVER_DOCS_GLOBS, f) || matchesAny(prot, f))) return "standard";
  return "docs";
}

const defaultReadFile = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

/**
 * KTB-21 — 데모 #18: qa 리뷰어가 증거 수집 중 `docker compose down`으로 test env를 내렸다(훅이 이제
 * 막는다 — `hooks/deny-all-writes.sh`). 그런데 리뷰 스테이지의 게이트는 그로부터 28분 뒤 도는데,
 * 훅은 **그 세션 안의** 명령만 본다 — 다른 경로로(사람이, 이전 잡의 잔해가, 재시작 사이 간극에) env가
 * 내려가 있어도 훅은 그것을 모른다. 그래서 `[commands]`를 돌리기 **직전**, 여기서 한 번 더 방어한다:
 * `.factory/bin/test-env.js up`은 멱등이다(docker compose의 `up -d --wait`는 이미 떠 있으면 그대로
 * 확인만 한다) — 매 게이트 실행 전에 불러도 대가가 없다. `harness.test.env.compose`가 없으면(=이
 * 하네스가 compose를 쓰지 않으면) 아무 일도 하지 않는다.
 */
export async function reUpTestEnv({ run, cwd, harness }) {
  if (!harness.test?.env?.compose) return { ran: false, ok: true };
  const r = await run("node", [".factory/bin/test-env.js", "up"], { cwd });
  return { ran: true, ok: r.code === 0, detail: r.code === 0 ? "" : (r.stderr || r.stdout || "").trim().slice(0, 2000) };
}

/**
 * 한 스테이지의 게이트 전체(명령 게이트 + 실패 분류 + prove-test/반복 + 증명 게이트)를 한 번에 돌려
 * `factory.gates.v1` 결과 하나로 합산한다. run-stage의 `d.gates`와 `bin/gates.js`가 공유하는 유일한 본체.
 *
 * - 분류(classifyFailures)는 **implement에서만** 한다. review/merge는 재분류 없이 RED가 RED다.
 * - `blocked`(base 워크트리를 못 만들어 "PR이 깨뜨렸다"를 판정할 수 없음)가 하나라도 있으면
 *   status를 BLOCKED로 올린다 — GREEN도 RED도 아닌, 사람이 봐야 하는 상태다.
 */
export async function runStageGates({ run: injectedRun, cwd, harness, stage, tier, level: levelArg, base, quarantine = { quarantined: [] }, gh, issue, readFile = defaultReadFile, now, saveQuarantine, transitionIssue = null }) {
  // 이 아래의 **모든** 하위 프로세스는 자격증명 없는 환경에서 돈다(ADR-020 fix round 1). 게이트·
  // 증명 게이트·분류는 전부 `harness.commands`, 곧 PR이 쓴 코드를 bash로 실행한다 — merge 잡의
  // 토큰이 그 안에 있으면 게이트 스크립트 한 줄이 4b 검사를 건너뛰고 스스로 머지할 수 있다.
  // 한 자리에서 감싸는 이유: proveTest·classifyFailures·diff-coverage·mutation이 전부 이 `run`을
  // 그대로 넘겨받는다(각자 감싸면 새 호출자가 생길 때마다 빠뜨린다). git 호출도 함께 스크럽되지만
  // git은 이 토큰들을 쓰지 않는다(체크아웃 자격증명은 `.git/config`에 산다).
  const run = scrubbedRunner(injectedRun);

  // KTB-21: [commands]를 돌리기 전에 re-up을 시도한다 — 실패하면 이 뒤로는 무엇을 돌려도 "죽은 env에
  // 대고 돈 결과"이므로 아예 돌리지 않는다. GREEN도 RED도 아닌 판정 불가이니 BLOCKED다(merge-stage의
  // `undecidable()`, 워크트리 판정 불가(KTB-14 r1)와 같은 등급 — 사람이 아니라 재시도가 우선이다).
  const testEnvReup = await reUpTestEnv({ run, cwd, harness });
  if (!testEnvReup.ok) {
    return {
      schema: "factory.gates.v1", level: levelArg ?? null, requested_level: levelArg ?? null, downgraded_from: null,
      status: "BLOCKED", blocked_reason: `test-env re-up failed: ${testEnvReup.detail}`, test_env_reup: testEnvReup,
      gates: {}, passed: 0, failed: 0, failing: [], skipped: [], misconfigured: [], tests: null, quarantine_applied: [], quarantine_refused: [],
      ran_at: now ?? new Date().toISOString(),
      tier_declared: tier ?? null, tier_effective: null, tier_source: null, base: base ?? null,
      head_sha: (await run("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim() || null,
    };
  }

  let changed = null;
  const changedOnce = async () => (changed ||= await changedFiles({ run, cwd, base, harness }));

  // tier는 diff보다 먼저 정해진다 — 그래서 diff로 바닥을 깔고 둘 중 강한 쪽을 쓴다.
  const declaredTier = normalizeTier(tier);
  const effectiveTier = maxTier(declaredTier, tierFloor({ changed: await changedOnce(), harness }));
  const level = levelArg || levelForTier(effectiveTier);
  // 격리 판정은 diff를 알아야 한다(M4) — 이 PR이 건드린 테스트 파일은 뒤집지 않는다.
  const result = await runGates({ run, cwd, harness, level, quarantine, touchedFiles: (await changedOnce()).all, readFile, ...(now ? { now } : {}) });
  result.tier_declared = tier ?? null;
  result.tier_effective = effectiveTier;
  result.tier_source = effectiveTier === declaredTier ? "declared" : "promoted-by-diff";
  result.test_env_reup = testEnvReup;
  // 이 판정이 **어떤 커밋을, 무엇과 비교해** 내린 것인지 파일 안에 남긴다 — 나중에 다른 head의
  // 판정이 이 자리에 놓이면 requirements가 잡아낸다(§3.3).
  result.head_sha = (await run("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim() || null;
  result.base = base ?? null;

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
    /**
     * 감사 M3 — **base가 매번 실패하는 테스트는 흔들림이 아니다.** classify-failure가 `broken-base`로
     * 판정한 것(격리 실행은 통과, base는 5/5 실패)은 이 PR의 잘못이 아니지만 **제외해서도 안 된다**:
     * 제외하면 main이 빨간 채로 자동 머지가 계속된다. 실패는 그대로 남겨 게이트를 RED로 두고, 왜
     * RED인지를 게이트가 스스로 적는다("main is red on …") — 사람이 읽고 main을 먼저 고쳐야 한다.
     */
    const brokenBase = cls.filter((c) => c.verdict === "broken-base");
    if (brokenBase.length) {
      result.broken_base = brokenBase.map((c) => c.id);
      result.needs_human = true;
      const reason = `main is red on ${result.broken_base.join(", ")}`;
      result.broken_base_reason = reason;
      for (const g of Object.values(result.gates)) {
        if (g.status === "RED" && (g.failing_ids || []).some((id) => result.broken_base.includes(id))) g.reason = reason;
      }
    }
    /**
     * 감사 M3 — `flaky-existing` 제외에도 상한이 있다. 한 PR이 기존 테스트 세 개, 네 개를 "원래
     * 흔들리던 것"으로 밀어내며 통과한다면 그것은 격리가 아니라 판정 포기다. 상한을 넘으면 **하나도**
     * 제외하지 않는다(부분 제외는 "어느 두 개를 봐준 것인가"라는 임의의 선택을 남긴다).
     */
    const flakyAll = cls.filter((c) => c.verdict === "flaky-existing");
    const flakyMax = harness.gates.thresholds?.flaky_max ?? FLAKY_MAX;
    const flaky = flakyAll.length > flakyMax ? [] : flakyAll;
    if (flakyAll.length > flakyMax) {
      result.flaky_over_cap = { count: flakyAll.length, max: flakyMax };
      result.needs_human = true;
    }
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
        /**
         * 격리 이슈를 못 만들어도 판정은 계속한다 — gh 실패로 스테이지를 죽이지 않는다.
         *
         * KTB-44 / ADR-025 (리뷰 should_fix 3) — 이슈는 **`backlog`로 태어나고**, 큐로 가는 한 걸음은
         * 다른 모든 큐 전이와 같은 게이트를 지난다. 예전에는 `labels: ["factory:queue", …]`로 바로
         * 태어나서, 리허설한 적 없는 하네스 위에서도 triage 런이 시작됐다 — 게이트를 통째로 비켜 가는
         * 유일한 생산 경로였다. 거부되면 이슈는 `backlog`에 남고(사람의 `:next`가 집는다) 그 이유를
         * 코멘트로 적는다. `harness-request.js`의 하네스 이슈는 여전히 바로 큐로 간다(그건 설계다 —
         * 리허설이 낡았을 때 그것을 고치는 이슈까지 막으면 저장소가 잠긴다).
         */
        try {
          const n = await gh?.createIssue({ title, body: `Detected while implementing #${issue}. evidence: ${JSON.stringify(c.evidence)}`, labels: ["backlog", "factory:flaky"] });
          result.flaky_issues.push(n);
          if (n != null) {
            const t = transitionIssue
              ? await transitionIssue({ issue: n, to: "factory:queue", reason: `flaky test harvested while implementing #${issue}` })
              : { ok: false, reason: "no transition wiring in this gate run — the issue stays in backlog" };
            if (!t?.ok) {
              (result.flaky_issues_backlogged ??= []).push({ issue: n, reason: t?.reason || "unknown" });
              try { await gh?.comment(n, `<!-- factory-flaky-not-queued issue=${n} -->\n이 이슈는 \`backlog\`에 머물러 있습니다 — 큐 전이가 거부됐습니다: ${t?.reason || "unknown"}\n\n하네스를 러너에서 한 번 돌린 뒤(\`factory rehearse\`) \`/know-thy-build:next\`로 큐에 넣으세요(ADR-025).`); }
              catch { /* 기록의 실패가 수확의 실패는 아니다 */ }
            }
          }
        } catch (e) { result.flaky_issues.push(`error: ${e?.message || e}`); }
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
    // 케이스도 base에서는 실패해야 한다. 면제는 **실효 tier**로 판단한다(자기 신고 docs로 빠져나갈 수 없게).
    if (effectiveTier !== "docs") {
      const pt = await proveTest({ run, cwd, harness, base, addedTests: ch.tests });
      result.gates["prove-test"] = { status: pt.misconfigured ? "MISCONFIGURED" : pt.ok ? "GREEN" : "RED", code: null, duration_ms: 0, log: pt.detail };
      /*
       * 감사 M2 — **판정 불가는 판정 결과와 따로 기록된다.** base에서 테스트가 아예 돌지 못한 것은
       * GREEN(증명됨)도 RED(증명 실패)도 아니라 "이 게이트가 무엇을 말하는지 모른다"이고,
       * `proveTest`가 그것을 `misconfigured`로 돌려주므로 위 줄에서 이미 MISCONFIGURED다 —
       * 곧 `recomputeStatus`의 required 규칙에 걸려 이 PR은 절대 GREEN이 되지 않는다.
       * 여기 남기는 `prove_test.inconclusive[]`는 사람이 "어느 테스트가 그랬는가"를 읽는 자리다.
       */
      if (pt.inconclusive?.length) result.prove_test = { inconclusive: [...pt.inconclusive] };
    }
    const rp = await repeatNewTests({ run, cwd, harness, addedTests: ch.tests, times: harness.gates.thresholds.new_test_repeats });
    result.gates["new-test-repeat"] = { status: rp.misconfigured ? "MISCONFIGURED" : rp.ok ? "GREEN" : "RED", code: null, duration_ms: 0, log: rp.detail };
  }
  // 증명 게이트는 implement뿐 아니라 review·merge에서도 돈다. 리뷰 라운드 사이에 커밋이 더 붙으므로
  // implement 런의 커버리지·mutation 점수는 머지될 커밋의 얘기가 아니다 — 매번 다시 잰다(최적화보다 단순함).
  if (result.skipped.includes("diff_coverage")) {
    const dc = await runDiffCoverage({ run, cwd, harness, base, readFile });
    result.gates.diff_coverage = { status: dc.misconfigured ? "MISCONFIGURED" : dc.ok ? "GREEN" : "RED", code: null, duration_ms: 0, log: `pct=${dc.pct} threshold=${dc.threshold} ${dc.detail || ""} uncovered=${JSON.stringify(dc.uncovered || []).slice(0, 500)}` };
  }
  if (result.skipped.includes("mutation")) {
    const ch = await changedOnce();
    const mu = await mutationGate({ run, cwd, harness, changedSources: ch.sources, readFile });
    result.gates.mutation = { status: mu.misconfigured ? "MISCONFIGURED" : mu.ok ? "GREEN" : "RED", code: null, duration_ms: 0, log: `score=${mu.score} threshold=${mu.threshold} ${mu.detail || ""}` };
  }
  await updateQuarantine({ result, quarantine, stage, saveQuarantine });
  return recomputeStatus(result, harness);
}

/**
 * 격리 항목의 복귀 경로. 격리된 테스트는 "계속 실행하되 판정에서만 제외"되므로, 그 실행 결과가
 * 어딘가에 쌓이지 않으면 `consecutive_passes`는 영원히 0이고 자동 복귀(§5.2.5-⑤)는 죽은 규칙이 된다.
 * 리포트를 하나도 못 읽었으면 갱신하지 않는다 — 안 돌린 것을 "통과"로 세지 않는다.
 */
async function updateQuarantine({ result, quarantine, stage, saveQuarantine }) {
  if (!saveQuarantine || !["implement", "review"].includes(stage)) return;
  const ids = (quarantine?.quarantined || []).map((x) => x.id);
  if (!ids.length) return;
  const parsedGates = Object.values(result.gates).filter((g) => g.parsed === true);
  if (!parsedGates.length) return;
  const failed = new Set(parsedGates.flatMap((g) => g.failing_ids || []));
  let q = quarantine;
  const updates = [];
  for (const id of ids) {
    const passed = !failed.has(id);
    q = recordResult(q, id, passed);
    updates.push({ id, passed, consecutive_passes: q.quarantined.find((x) => x.id === id)?.consecutive_passes ?? 0 });
  }
  await saveQuarantine(q);
  result.quarantine_updates = updates;
}

const list = (a) => (a && a.length ? a.join(",") : "none");
export function verdictLine(r) {
  // broken_base는 있을 때만 붙인다 — "main이 빨갛다"는 이 PR의 결함과 다른 사고이고, 사람이 받는
  // 한 줄에서 그 구분이 사라지면 리뷰어가 없는 제품 결함을 찾으러 간다(감사 M3).
  const brokenBase = r.broken_base?.length ? ` broken_base=${list(r.broken_base)}` : "";
  return `FACTORY_GATES: level=${r.level} status=${r.status} passed=${r.passed} failed=${r.failed} failing=${list(r.failing)} skipped=${list(r.skipped)} misconfigured=${list(r.misconfigured)} excluded=${list(r.tests?.excluded)}${brokenBase}`;
}
