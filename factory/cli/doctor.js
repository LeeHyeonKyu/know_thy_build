import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkHarness, checkCommands, checkSetupDirtiesTree, checkQaEvidenceProbe, runSetupProbe } from "../lib/doctor/harness.js";
import { checkFiles, checkFilesTracked, checkCharter, checkRoles, checkAgents, checkSkills, checkSettings, checkHooks, checkWorkflows, checkGitHub, checkProtectedParity } from "../lib/doctor/factory.js";
import { loadHarness, loadHarnessRaw, loadRoles, loadCharter } from "../lib/config.js";
import { makeGh, resolveRepo } from "../lib/gh.js";
import { LABELS } from "../lib/label-catalog.js";
import { envUp, envDown } from "../lib/test-env.js";
import { q } from "../lib/prove-test.js";
import { buildManifest } from "./manifest.js";
import { projectVars } from "./init.js";
import { renderReport, exitCode, summarize } from "../lib/doctor/report.js";

// factory/hooks/*.sh 전부 — checkHooks가 각각 실제로 실행해 종료 코드를 검사한다.
const DOCTOR_HOOKS = ["block-dangerous.sh", "lint-touched.sh", "record-agents.sh", "stop-guard.sh", "verdict-format.sh"];

/**
 * harness 스코프는 항상 실행한다. `.factory/bin/run-stage.js`가 있을 때만 factory 스코프(파일·CHARTER·roles·
 * settings·hooks·workflows·GitHub) 전체를 돈다 — 없으면 아직 `factory init`을 하지 않은 저장소라 PASS-level
 * 안내만 낸다. smoke는 `--no-run`이 아니고 `[test].smoke`가 채워져 있을 때만 실행한다.
 *
 * 명령 실행(`[commands]`)과 smoke는 **하나의 테스트 환경 사이클 안에서** 돈다. CI가 스테이지 전에
 * `.factory/actions/setup`(test-env: true)으로 환경을 띄우고 그 안에서 게이트를 판정하기 때문이다 —
 * doctor가 환경 없이 명령을 돌리면 DB가 있는 M1+ 저장소는 `commands.run.unit`이 항상 FAIL이고,
 * 그 FAIL은 픽스처로 고칠 수 없다(§5.2.1, Plan 6 Task 1 dogfood).
 */
export async function doctorCommand({ root, pkgRoot, argv = [], io, run, gh, deps = {} }) {
  const noRun = argv.includes("--no-run");
  const offline = argv.includes("--offline");
  const json = argv.includes("--json");

  const exists = deps.exists || existsSync;
  const readFile = deps.readFile || ((p) => readFileSync(p, "utf8"));
  const loadHarnessFn = deps.loadHarness || loadHarness;
  const loadHarnessRawFn = deps.loadHarnessRaw || loadHarnessRaw;
  const loadRolesFn = deps.loadRoles || loadRoles;
  const loadCharterFn = deps.loadCharter || loadCharter;
  const checkGitHubFn = deps.checkGitHub || checkGitHub;
  const resolveRepoFn = deps.resolveRepo || resolveRepo;
  const envUpFn = deps.envUp || envUp;
  const envDownFn = deps.envDown || envDown;

  const finish = (checks) => {
    if (json) {
      io.out(JSON.stringify({ checks, summary: summarize(checks) }));
    } else {
      io.out(renderReport(checks));
    }
    return exitCode(checks);
  };

  let harness;
  try {
    harness = loadHarnessFn(root);
  } catch (e) {
    return finish([{ id: "harness", level: "FAIL", detail: `harness.toml unreadable: ${e.message}` }]);
  }
  // M2: `loadHarnessFn`이 이미 `[factory].max_turns`에 기본값 12를 채워 뒀다 — "키가 아예 없다"는
  // 판정은 그 채움 이전의 파스에서만 가능하다. 이 두 번째 파스가 실패해도(권한, 경합) 전체 doctor를
  // 죽이지 않는다 — `raw`를 `harness`로 되돌려 그 한 WARN 판정만 조용히 못 하게 둔다.
  let harnessRaw;
  try {
    harnessRaw = loadHarnessRawFn(root);
  } catch {
    harnessRaw = harness;
  }

  const checks = [];

  // ── harness scope (always) ──────────────────────────────────────
  const lsFiles = await run("git", ["ls-files"], { cwd: root });
  const files = lsFiles.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  checks.push(...checkHarness({ harness, files, raw: harnessRaw }));
  // KTB-39 — `[runtime].setup`이 추적 파일을 다시 쓰는가. 판정은 순수 함수이고, 표본은 **깨끗한
  // 스크래치 복제본**에서 setup을 한 번 돌려 얻는다(작업 트리를 건드리지 않는다). `--no-run`·
  // `--offline`에서는 돌리지 않고 "안 돌려 봤다"로 남긴다 — setup은 몇 분이 걸릴 수 있다.
  const setupProbeFn = deps.runSetupProbe || runSetupProbe;
  const probe = noRun || offline
    ? { skipped: noRun ? "--no-run" : "--offline" }
    : await setupProbeFn({ run, cwd: root, harness }).catch((e) => ({ skipped: `probe failed: ${e?.message || e}` }));
  checks.push(checkSetupDirtiesTree({ harness, ...probe }));
  // ADR-024 / KTB-42 — review 스테이지가 `claude -p` 전에 돌리는 것과 **같은 프로브**를 여기서도.
  // 파일을 하나 만들었다 지우므로 `--no-run`/`--offline`에서는 WARN으로만 남긴다.
  checks.push(checkQaEvidenceProbe({ root, skipped: noRun ? "--no-run" : offline ? "--offline" : null }));

  // ── test env up (wraps the command gates and the smoke) ─────────
  const smoke = harness.test?.smoke || {};
  // `--no-run`이 아니면 항상 한 사이클 돈다 — envUp/envDown은 `[test.env]`가 비어 있으면 스스로 no-op이다.
  const wantsEnv = !noRun;
  let envResult = { ok: true, steps: [], pids: [] };
  let envFailReason = null;
  // envUp이 partial로 뭔가를 띄워놓고 실패했을 수도 있으니(compose up 성공 → seed 실패 등) 성공 여부와 무관하게
  // envDown은 항상 부른다. envDown 자체가 실패해도 doctor 전체를 죽이지 않고 WARN으로만 남긴다(teardown은 best-effort).
  const tearDown = async () => {
    try {
      const r = await envDownFn({ run, cwd: root, harness, pids: envResult.pids });
      if (!r.ok) {
        const detail = (r.steps || []).filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`).join("; ") || "env down reported failure";
        checks.push({ id: "smoke.env-down", level: "WARN", detail });
      }
    } catch (e) {
      checks.push({ id: "smoke.env-down", level: "WARN", detail: e.message });
    }
  };
  if (wantsEnv) {
    envResult = await envUpFn({ run, cwd: root, harness });
    if (!envResult.ok) {
      const failed = envResult.steps.find((s) => !s.ok);
      envFailReason = failed?.detail || "env up failed";
      checks.push({ id: "smoke.env", level: "FAIL", detail: envFailReason });
    }
  }

  try {
    // env-up이 실패했으면 [commands]도 smoke와 대칭으로 건너뛴다(둘 다 같은 test env 사이클 안에서 돈다) —
    // 환경 없이 돌리면 DB가 있는 저장소는 고칠 수 없는 거짓 FAIL이 상시로 뜬다(harness.toml 주석 참조).
    checks.push(...(await checkCommands({ harness, run, cwd: root, skipRun: noRun, skipReason: envFailReason })));

    // ── factory scope (only when installed) ─────────────────────────
    if (exists(join(root, ".factory/bin/run-stage.js"))) {
      const manifest = buildManifest({ pkgRoot });
      const vars = projectVars(root, pkgRoot);
      checks.push(...checkFiles({ manifest, root, exists, readFile, vars }));
      checks.push(...(await checkFilesTracked({ manifest, root, exists, run })));
      checks.push(...checkCharter({ root, loadCharter: loadCharterFn }));
      checks.push(...checkSkills({ root, exists, readFile }));

      try {
        const roles = loadRolesFn(root);
        let charter;
        try {
          charter = loadCharterFn(root);
        } catch {
          charter = { roster: {}, plan_roles: {} };
        }
        checks.push(...checkRoles({ charter, roles, exists, root }));
        // 파일이 있느냐(checkRoles)와 그 파일이 §7.2를 지키느냐(checkAgents)는 다른 질문이다 —
        // 섹션이 빠진 역할 파일은 실행은 되지만 판정 품질이 조용히 무너진다.
        checks.push(...checkAgents({ roles, root, readFile, exists }));
      } catch (e) {
        checks.push({ id: "roles", level: "FAIL", detail: `roles.toml unreadable: ${e.message}` });
      }

      let settings = null;
      try {
        settings = JSON.parse(readFile(join(root, ".claude/settings.json")));
      } catch {}
      let template;
      try {
        template = JSON.parse(readFile(join(pkgRoot, "templates/factory/claude/settings.json")));
      } catch (e) {
        checks.push({ id: "settings.template", level: "FAIL", detail: `settings template unreadable: ${e.message}` });
      }
      // 경로 deny는 CI 전용 파일에 산다(ADR-019) — 템플릿과 설치본을 같은 방식으로 읽어 둘 다 검사한다.
      let ciSettings = null;
      try {
        ciSettings = JSON.parse(readFile(join(root, ".factory/ci-settings.json")));
      } catch {}
      let ciTemplate;
      try {
        ciTemplate = JSON.parse(readFile(join(pkgRoot, "templates/factory/factory/ci-settings.json")));
      } catch (e) {
        checks.push({ id: "settings.ci-template", level: "FAIL", detail: `ci-settings template unreadable: ${e.message}` });
      }
      // KTB-20: `factory:harness` 이슈의 implement가 싣는 변형(§5.2.1). 같은 방식으로 설치본+템플릿을 본다.
      let ciHarness = null;
      try {
        ciHarness = JSON.parse(readFile(join(root, ".factory/ci-settings-harness.json")));
      } catch {}
      let ciHarnessTemplate;
      try {
        ciHarnessTemplate = JSON.parse(readFile(join(pkgRoot, "templates/factory/factory/ci-settings-harness.json")));
      } catch (e) {
        checks.push({ id: "settings.ci-harness-template", level: "FAIL", detail: `ci-settings-harness template unreadable: ${e.message}` });
      }
      if (template) checks.push(...checkSettings({ settings, template, ciSettings, ciTemplate, ciHarness, ciHarnessTemplate }));

      // M8 — 훅의 `prot`와 CI 경로 deny가 harness.toml [protected]에서 나왔는가(생성 후 손댔거나 harness만 고쳤으면 FAIL).
      checks.push(...checkProtectedParity({ root, exists, readFile, harness }));
      checks.push(...(await checkHooks({ run, root, exists, readFile, hooks: DOCTOR_HOOKS })));
      checks.push(...checkWorkflows({ root, exists, readFile }));

      if (!offline) {
        // gh가 이미 주입돼 있으면(테스트, 향후 다른 호출자) repo 해석은 필요 없다 — 그 gh는 이미 repo를 안다.
        // 주입이 없으면 status.js와 같은 방식으로 repo를 해석한다(KTB-4) — FACTORY_REPO가 비어 있어도
        // `gh api repos//branches/main/protection`처럼 깨진 경로로 호출해 거짓 "보호 없음"을 보고하지 않도록.
        // 해석 자체가 실패하면(로그인 안 됨·git repo 아님) github.* 전체를 건너뛰고 오프라인 허용 WARN 하나로 남긴다.
        if (gh) {
          checks.push(...(await checkGitHubFn({ gh, harness, labels: LABELS, root, exists, readFile })));
        } else {
          let repo;
          try {
            repo = await resolveRepoFn({ run });
          } catch (e) {
            checks.push({ id: "github.unavailable", level: "WARN", detail: `could not resolve repo — ${e.message}` });
          }
          if (repo) {
            const ghClient = makeGh({ run, repo });
            checks.push(...(await checkGitHubFn({ gh: ghClient, harness, labels: LABELS, root, exists, readFile })));
          }
        }
      }
    } else {
      checks.push({ id: "factory.initialized", level: "PASS", detail: "not initialized — run factory init" });
    }

    // ── smoke ───────────────────────────────────────────────────────
    // 환경이 올라오지 못했으면 smoke는 돌리지 않는다 — 환경 없이 난 실패는 스모크의 실패가 아니다.
    if (!noRun && Object.keys(smoke).length && envResult.ok) {
      for (const [level, val] of Object.entries(smoke)) {
        const smokeFiles = Array.isArray(val) ? val : [val];
        const cmd = harness.commands.test_files.replaceAll("{files}", smokeFiles.map(q).join(" "));
        try {
          const r = await run("bash", ["-lc", cmd], { cwd: root });
          checks.push({ id: `smoke.${level}`, level: r.code === 0 ? "PASS" : "FAIL", detail: r.code === 0 ? "" : `${cmd} → exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 400)}` });
        } catch (e) {
          checks.push({ id: `smoke.${level}`, level: "FAIL", detail: `${cmd} → threw: ${e.message}` });
        }
      }
    }
  } finally {
    if (wantsEnv) await tearDown();
  }

  return finish(checks);
}
