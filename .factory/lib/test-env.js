import { spawnBackground } from "./exec.js";

const composeArgs = (env) => ["compose", "-f", env.compose, ...(env.env_file ? ["--env-file", env.env_file] : [])];

export async function envUp({ run, cwd, harness, spawnBg = spawnBackground, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = () => {} }) {
  const env = harness.test?.env || {}, fakes = harness.test?.fakes || {};
  const steps = [], pids = [];
  const fail = (name, detail) => { steps.push({ name, ok: false, detail }); log(`test-env: ${name} FAILED — ${detail}`); return { ok: false, steps, pids }; };
  const ok = (name, detail = "") => { steps.push({ name, ok: true, detail }); log(`test-env: ${name} ok`); };
  if (env.compose) {
    const r = await run("docker", [...composeArgs(env), "up", "-d", "--wait"], { cwd });
    if (r.code !== 0) return fail("compose", `exit ${r.code}: ${(r.stderr || r.stdout).trim()}`);
    ok("compose");
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
    const r = await run("docker", [...composeArgs(env), "down", "-v"], { cwd });
    steps.push({ name: "compose-down", ok: r.code === 0, detail: r.code === 0 ? "" : (r.stderr || r.stdout).trim() });
  }
  const ok = steps.every((s) => s.ok);
  log(`test-env: down ${ok ? "ok" : "with errors"}`);
  return { ok, steps };
}
