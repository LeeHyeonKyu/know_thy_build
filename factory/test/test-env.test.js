import { test, expect } from "vitest";
import { envUp, envDown } from "../lib/test-env.js";
import { makeFakeRun } from "../lib/exec.js";

const harness = { test: { env: { compose: "dc.yml", env_file: ".env.test", seed: "npm run seed", app_start: "npm start", app_ready: "http://localhost:3000/healthz", ready_timeout_sec: 2 }, fakes: { gcal: "npm run fake:gcal" } } };
const okRun = () => makeFakeRun([{ match: () => true, result: { code: 0, stdout: "", stderr: "" } }]);

test("envUp runs compose → seed → fakes → app and polls readiness; returns pids", async () => {
  const run = okRun(); const spawned = []; let polls = 0;
  const spawnBg = (cmd) => { spawned.push(cmd); return { pid: 100 + spawned.length }; };
  const fetch = async () => ({ status: polls++ < 2 ? 503 : 200 });
  const r = await envUp({ run, cwd: "/r", harness, spawnBg, fetch, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 200); })() });
  expect(r.ok).toBe(true);
  expect(run.calls.map((c) => [c.cmd, ...c.args].join(" "))).toEqual(["docker compose -f dc.yml --env-file .env.test up -d --wait", "bash -lc npm run seed"]);
  expect(spawned).toEqual(["npm run fake:gcal", "npm start"]);
  expect(r.pids).toEqual([101, 102]);
  expect(r.steps.map((s) => s.name)).toEqual(["compose", "seed", "fake:gcal", "app_start", "app_ready"]);
});

test("envUp fails closed when compose fails, and skips later steps", async () => {
  const run = makeFakeRun([{ match: (c) => c === "docker", result: { code: 1, stdout: "", stderr: "boom" } }]);
  const r = await envUp({ run, cwd: "/r", harness, spawnBg: () => { throw new Error("must not spawn"); }, fetch: async () => ({ status: 200 }), sleep: async () => {}, now: () => 0 });
  expect(r.ok).toBe(false);
  expect(r.steps).toEqual([{ name: "compose", ok: false, detail: expect.stringContaining("boom") }]);
});

test("envUp times out on readiness", async () => {
  const run = okRun(); let t = 0;
  const r = await envUp({ run, cwd: "/r", harness, spawnBg: () => ({ pid: 1 }), fetch: async () => { throw new Error("ECONNREFUSED"); }, sleep: async () => {}, now: () => (t += 1000) });
  expect(r.ok).toBe(false);
  expect(r.steps.at(-1)).toMatchObject({ name: "app_ready", ok: false, detail: expect.stringContaining("timeout") });
});

test("envUp with an empty [test.env] is a no-op success", async () => {
  const r = await envUp({ run: okRun(), cwd: "/r", harness: { test: { env: { ready_timeout_sec: 90 } } }, spawnBg: () => ({ pid: 1 }), fetch: async () => ({ status: 200 }), sleep: async () => {}, now: () => 0 });
  expect(r).toEqual({ ok: true, steps: [], pids: [] });
});

test("envDown kills pids and brings compose down; ignores ESRCH", async () => {
  const run = okRun(); const killed = [];
  const r = await envDown({ run, cwd: "/r", harness, pids: [5, 6], kill: (pid) => { killed.push(pid); if (pid === 6) { const e = new Error("gone"); e.code = "ESRCH"; throw e; } } });
  expect(r.ok).toBe(true);
  // Controller ruling: envDown group-kills first (kill(-pid, "SIGTERM")), falling back to
  // kill(pid, "SIGTERM") only if the group kill throws; ESRCH is ignored either way. The fake
  // kill above records the raw pid it was called with (negative for the group-kill attempt),
  // so assert on the absolute values rather than the brief's literal [5, 6].
  expect(killed.map(Math.abs)).toEqual([5, 6]);
  expect(run.calls.map((c) => [c.cmd, ...c.args].join(" "))).toEqual(["docker compose -f dc.yml --env-file .env.test down -v"]);
});
