import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkHarness, checkCommands } from "../lib/doctor/harness.js";
import { checkFiles, checkCharter, checkRoles, checkSettings, checkHooks, checkWorkflows, checkGitHub } from "../lib/doctor/factory.js";
import { loadHarness, loadRoles, loadCharter } from "../lib/config.js";
import { makeGh } from "../lib/gh.js";
import { envUp, envDown } from "../lib/test-env.js";
import { q } from "../lib/prove-test.js";
import { buildManifest } from "./manifest.js";
import { projectVars } from "./init.js";
import { renderReport, exitCode, summarize } from "../lib/doctor/report.js";

// factory/hooks/*.sh 전부 — checkHooks가 각각 실제로 실행해 종료 코드를 검사한다.
const DOCTOR_HOOKS = ["block-dangerous.sh", "lint-touched.sh", "record-agents.sh", "stop-guard.sh", "verdict-format.sh"];

// Task 10에서 lib/labels.js의 정식 카탈로그로 교체될 임시 목록.
export const DOCTOR_LABELS = [
  "backlog",
  "factory:queue",
  "factory:ready",
  "factory:needs-info",
  "factory:wont-do",
  "factory:planned",
  "factory:in-progress",
  "factory:awaiting-review",
  "factory:rework",
  "factory:approved",
  "factory:merged",
  "factory:blocked",
  "factory:needs-human",
].map((name) => ({ name }));

/**
 * harness 스코프는 항상 실행한다. `.factory/bin/run-stage.js`가 있을 때만 factory 스코프(파일·CHARTER·roles·
 * settings·hooks·workflows·GitHub) 전체를 돈다 — 없으면 아직 `factory init`을 하지 않은 저장소라 PASS-level
 * 안내만 낸다. smoke는 `--no-run`이 아니고 `[test].smoke`가 채워져 있을 때만 실행한다.
 */
export async function doctorCommand({ root, pkgRoot, argv = [], io, run, gh, deps = {} }) {
  const noRun = argv.includes("--no-run");
  const offline = argv.includes("--offline");
  const json = argv.includes("--json");

  const exists = deps.exists || existsSync;
  const readFile = deps.readFile || ((p) => readFileSync(p, "utf8"));
  const loadHarnessFn = deps.loadHarness || loadHarness;
  const loadRolesFn = deps.loadRoles || loadRoles;
  const loadCharterFn = deps.loadCharter || loadCharter;
  const checkGitHubFn = deps.checkGitHub || checkGitHub;
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

  const checks = [];

  // ── harness scope (always) ──────────────────────────────────────
  const lsFiles = await run("git", ["ls-files"], { cwd: root });
  const files = lsFiles.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  checks.push(...checkHarness({ harness, files }));
  checks.push(...(await checkCommands({ harness, run, cwd: root, skipRun: noRun })));

  // ── factory scope (only when installed) ─────────────────────────
  if (exists(join(root, ".factory/bin/run-stage.js"))) {
    const manifest = buildManifest({ pkgRoot });
    const vars = projectVars(root);
    checks.push(...checkFiles({ manifest, root, exists, readFile, vars }));
    checks.push(...checkCharter({ root, loadCharter: loadCharterFn }));

    try {
      const roles = loadRolesFn(root);
      let charter;
      try {
        charter = loadCharterFn(root);
      } catch {
        charter = { roster: {}, plan_roles: {} };
      }
      checks.push(...checkRoles({ charter, roles, exists, root }));
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
    if (template) checks.push(...checkSettings({ settings, template }));

    checks.push(...(await checkHooks({ run, root, exists, readFile, hooks: DOCTOR_HOOKS })));
    checks.push(...checkWorkflows({ root, exists, readFile }));

    if (!offline) {
      const ghClient = gh || makeGh({ run, repo: process.env.FACTORY_REPO || "" });
      checks.push(...(await checkGitHubFn({ gh: ghClient, harness, labels: DOCTOR_LABELS })));
    }
  } else {
    checks.push({ id: "factory.initialized", level: "PASS", detail: "not initialized — run factory init" });
  }

  // ── smoke ─────────────────────────────────────────────────────────
  const smoke = harness.test?.smoke || {};
  if (!noRun && Object.keys(smoke).length) {
    const envResult = await envUpFn({ run, cwd: root, harness });
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
    if (!envResult.ok) {
      await tearDown();
      const failed = envResult.steps.find((s) => !s.ok);
      checks.push({ id: "smoke.env", level: "FAIL", detail: failed?.detail || "env up failed" });
    } else {
      try {
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
      } finally {
        await tearDown();
      }
    }
  }

  return finish(checks);
}
