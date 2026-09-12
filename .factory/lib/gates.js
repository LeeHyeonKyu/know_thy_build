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

const LEVELS = ["fast", "full", "deep"];
const MAX_LEVEL = { M0: "fast", M1: "full", M2: "deep" };
const PROOF_GATES = new Set(["diff_coverage", "mutation"]);          // Task 7/8가 채움
const TEST_GATES = new Set(["unit", "integration", "e2e"]);

/**
 * result.gates 맵으로부터 failing/skipped/misconfigured/passed/failed/status를 재계산해
 * result에 반영하고 그대로 돌려준다 (순수 함수: gates 맵만 보고 판정; 호출자가 gates를
 * 직접 수정한 뒤에도 다시 불러 일관된 판정을 얻을 수 있다).
 */
export const EMPTY_LEVEL = "<level list empty>";

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
  // required는 "선택된 레벨 안에서, 돌아서 GREEN이었는가"를 묻는다(§6.2). 레벨 목록에 아예 없는
  // required 게이트는 "이 레벨에서 확인 대상이 아님"이지 실패가 아니다 — required는 레벨의 상위집합일 수
  // 있다(예: required=8, fast=3). 목록 **안에** 있는데 설정 오류이거나 SKIPPED로 남은 것만 실패다.
  const requiredMissing = (harness.gates.required || []).filter((n) => names.includes(n) && (misconfigured.includes(n) || skipped.includes(n)));
  const passed = Object.values(gates).filter((g) => g.status === "GREEN").length;
  const status = emptyLevel || requiredMissing.length ? "MISCONFIGURED" : failing.length ? "RED" : "GREEN";
  result.failing = failing;
  result.skipped = skipped;
  result.misconfigured = misconfigured;
  result.required_missing = requiredMissing;
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
    // SKIPPED·MISCONFIGURED도 다른 게이트와 같은 모양을 갖는다 — 읽는 쪽이 없는 필드를 추측하지 않게.
    if (PROOF_GATES.has(name)) { gates[name] = entry("SKIPPED", "proof gate — measured after the command gates"); continue; }
    const cmd = harness.commands[name];
    if (!cmd) { gates[name] = entry("MISCONFIGURED", `commands.${name} missing`); continue; }
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
        // 반대 방향도 막는다: 리포트가 격리 대상이 아닌 실패를 보여주는데 명령이 exit 0이면
        // (리포터가 삼켰거나 `|| true`가 붙었거나) 그건 통과가 아니다 — 리포트가 이긴다.
        if (status === "GREEN" && remaining.length > 0) status = "RED";
      }
    }
    gates[name] = { status, code: r.code, duration_ms: Date.now() - t0, log: (r.stderr + r.stdout).slice(-2000) };
    if (TEST_GATES.has(name)) { gates[name].parsed = reportParsed; gates[name].failing_ids = failing_ids || []; }
  }
  const result = { schema: "factory.gates.v1", level, requested_level, downgraded_from: level === requested_level ? null : requested_level, status: null, gates, passed: 0, failed: 0, failing: [], skipped: [], misconfigured: [], tests, ran_at: now };
  return recomputeStatus(result, harness);
}

/** 명령을 돌리지 않은 게이트 엔트리 — 이유는 log에 싣는다. */
const entry = (status, log) => ({ status, code: null, duration_ms: 0, log });

/** CHARTER tier → 게이트 레벨. 모르는 tier는 standard처럼 취급한다(약한 쪽으로 기울지 않는다). */
const LEVEL_OF_TIER = { docs: "fast", standard: "full", "load-bearing": "deep" };
export const levelForTier = (tier) => LEVEL_OF_TIER[tier] || "full";

const TIER_ORDER = ["docs", "standard", "load-bearing"];
/** 모르는 tier는 standard로 정규화한다 — levelForTier와 같은 보수성이다. */
const normalizeTier = (t) => (TIER_ORDER.includes(t) ? t : "standard");
const maxTier = (a, b) => TIER_ORDER[Math.max(TIER_ORDER.indexOf(a), TIER_ORDER.indexOf(b))];
const DOC_GLOBS = ["docs/**", "*.md"];

/**
 * diff가 정하는 tier의 **바닥**. tier는 triage 에이전트의 자기 신고이고, 자기 신고는 게이트 레벨을
 * 낮추는 방향으로 틀릴 수 있다 — 코드를 건드린 PR이 "docs"라고 말해도 docs 레벨로 통과시키지 않는다.
 */
export function tierFloor({ changed, harness }) {
  const files = changed?.all || [];
  const lb = harness.load_bearing?.paths || [];
  if (files.some((f) => matchesAny(lb, f))) return "load-bearing";
  if (files.some((f) => !matchesAny(DOC_GLOBS, f))) return "standard";
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
export async function runStageGates({ run: injectedRun, cwd, harness, stage, tier, level: levelArg, base, quarantine = { quarantined: [] }, gh, issue, readFile = defaultReadFile, now, saveQuarantine }) {
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
      gates: {}, passed: 0, failed: 0, failing: [], skipped: [], misconfigured: [], tests: null,
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
  const result = await runGates({ run, cwd, harness, level, quarantine, readFile, ...(now ? { now } : {}) });
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
    // 케이스도 base에서는 실패해야 한다. 면제는 **실효 tier**로 판단한다(자기 신고 docs로 빠져나갈 수 없게).
    if (effectiveTier !== "docs") {
      const pt = await proveTest({ run, cwd, harness, base, addedTests: ch.tests });
      result.gates["prove-test"] = { status: pt.misconfigured ? "MISCONFIGURED" : pt.ok ? "GREEN" : "RED", code: null, duration_ms: 0, log: pt.detail };
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
  return `FACTORY_GATES: level=${r.level} status=${r.status} passed=${r.passed} failed=${r.failed} failing=${list(r.failing)} skipped=${list(r.skipped)} misconfigured=${list(r.misconfigured)} excluded=${list(r.tests?.excluded)}`;
}
