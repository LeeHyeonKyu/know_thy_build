import { spawnBackground } from "./exec.js";

import { basename, resolve } from "node:path";

/**
 * INCIDENT 2026-09-22 (own-calendar #9 on a self-hosted Mac): `docker compose -f server/docker-compose.test.yml up`
 * took the compose **project name from the directory** (`server`) — the same project the owner's PRODUCTION
 * stack (`server/docker-compose.yml`: tailscale/postgres/api/web) was running under on that machine — and
 * **recreated the production `server-postgres-1` as the throwaway test container**. The test env must never be
 * able to share a project with anything else on the host, so the project name is always explicit:
 * `[test.env].project_name` if the adopter sets one, else `factory-test-<repo dir>`. Same name for `up`
 * and `down -v`, so `down` can only remove what `up` created.
 */
export const composeProjectName = (env, cwd) =>
  String(env?.project_name || `factory-test-${basename(resolve(cwd || "."))}`).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "") || "factory-test";
const composeArgs = (env, cwd) => ["compose", "-p", composeProjectName(env, cwd), "-f", env.compose, ...(env.env_file ? ["--env-file", env.env_file] : [])];

export async function envUp({ run, cwd, harness, spawnBg = spawnBackground, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = () => {} }) {
  const env = harness.test?.env || {}, fakes = harness.test?.fakes || {};
  const steps = [], pids = [];
  const fail = (name, detail) => { steps.push({ name, ok: false, detail }); log(`test-env: ${name} FAILED — ${detail}`); return { ok: false, steps, pids }; };
  const ok = (name, detail = "") => { steps.push({ name, ok: true, detail }); log(`test-env: ${name} ok`); };
  if (env.compose) {
    // 1.4.5 — 채택자의 테스트가 `docker compose -f <same file> exec db …`를 **프로젝트 이름 없이** 직접 부르는 경우
    // (demo `test/integration/db.test.js`)가 있다. `-p`만 쓰면 그 호출은 디렉터리 기본 프로젝트를 보고
    // "service db is not running"이 된다(1.4.4 데모 리허설). 그래서 같은 이름을 `COMPOSE_PROJECT_NAME`으로도
    // 이 프로세스의 환경에 올린다 — 게이트·테스트 명령은 이 프로세스의 자식이라 그대로 물려받는다.
    process.env.COMPOSE_PROJECT_NAME = composeProjectName(env, cwd);
    const r = await run("docker", [...composeArgs(env, cwd), "up", "-d", "--wait"], { cwd });
    if (r.code !== 0) return fail("compose", `exit ${r.code}: ${(r.stderr || r.stdout).trim()}`);
    ok("compose", `project ${process.env.COMPOSE_PROJECT_NAME}`);
  }
  if (env.seed) {
    const r = await run("bash", ["-lc", env.seed], { cwd });
    if (r.code !== 0) return fail("seed", `exit ${r.code}: ${(r.stderr || r.stdout).trim()}`);
    ok("seed");
  }
  for (const [name, cmd] of Object.entries(fakes)) {
    try { pids.push(spawnBg(cmd, { cwd }).pid); ok(`fake:${name}`); } catch (e) { return fail(`fake:${name}`, e.message); }
  }
  if (env.app_start) {
    try { pids.push(spawnBg(env.app_start, { cwd }).pid); ok("app_start"); } catch (e) { return fail("app_start", e.message); }
    if (env.app_ready) {
      const deadline = now() + (env.ready_timeout_sec ?? 90) * 1000;
      let last = "";
      while (now() < deadline) {
        try { const r = await fetch(env.app_ready); if (r.status === 200) { ok("app_ready"); return { ok: true, steps, pids }; } last = `status ${r.status}`; }
        catch (e) { last = e.message; }
        await sleep(500);
      }
      return fail("app_ready", `timeout after ${env.ready_timeout_sec ?? 90}s waiting for ${env.app_ready} (${last})`);
    }
  }
  return { ok: true, steps, pids };
}

export async function envDown({ run, cwd, harness, pids = [], kill = process.kill, log = () => {} }) {
  const env = harness.test?.env || {};
  const steps = [];
  for (const pid of pids) { try { kill(-pid, "SIGTERM"); } catch { try { kill(pid, "SIGTERM"); } catch (e) { if (e.code !== "ESRCH") steps.push({ name: `kill:${pid}`, ok: false, detail: e.message }); } } }
  if (env.compose) {
    const r = await run("docker", [...composeArgs(env, cwd), "down", "-v"], { cwd });
    steps.push({ name: "compose-down", ok: r.code === 0, detail: r.code === 0 ? "" : (r.stderr || r.stdout).trim() });
  }
  const ok = steps.every((s) => s.ok);
  log(`test-env: down ${ok ? "ok" : "with errors"}`);
  return { ok, steps };
}
