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
/**
 * 1.4.6 — 프로젝트 이름은 **프로세스 경계를 넘어** 전달돼야 한다: `test-env up`은 setup 액션의 별도 스텝이고,
 * 게이트·리허설 명령은 나중에 다른 프로세스가 띄운다(1.4.5는 `process.env`만 올려 그 프로세스와 함께 사라졌다 —
 * 데모 리허설 "service db is not running" 재발). 그래서 (a) 명령을 띄우는 쪽(gates·rehearsal)이 같은 함수로
 * 이름을 다시 계산해 `env`로 넣고, (b) CLI `up`은 `GITHUB_ENV`에도 적어 뒤 스텝이 물려받는다.
 */
export const composeEnv = (harness, cwd) => (harness?.test?.env?.compose ? { COMPOSE_PROJECT_NAME: composeProjectName(harness.test.env, cwd) } : {});

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
    // 1.4.7 — 우리 프로젝트의 잔여물(이전 런이 down을 못 한 컨테이너·고아)은 먼저 치운다. 다른 프로젝트는 건드리지 않는다.
    await run("docker", [...composeArgs(env, cwd), "down", "-v", "--remove-orphans"], { cwd });
    const r = await run("docker", [...composeArgs(env, cwd), "up", "-d", "--wait"], { cwd });
    if (r.code !== 0) {
      let detail = `exit ${r.code}: ${(r.stderr || r.stdout).trim()}`;
      // 포트를 쥔 것이 **누구**인지 이름을 댄다 — 2026-09-27: 4일 된 잔여 컨테이너(`factory-test-postgres-21`)가 :5433을 쥐고 있었고,
      // "port is already allocated"만으로는 사람이 그것을 찾는 데 한 라운드가 갔다.
      const port = /Bind for [\d.:]*:(\d+) failed/.exec(detail)?.[1];
      if (port) {
        const ps = await run("docker", ["ps", "--format", "{{.Names}}\t{{.Ports}}"], { cwd });
        const holder = String(ps.stdout || "").split("\n").find((l) => l.includes(`:${port}->`));
        if (holder) detail += `\nport ${port} is held by container ${holder.split("\t")[0]} (not this project) — remove it or change the compose port`;
      }
      return fail("compose", detail);
    }
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
