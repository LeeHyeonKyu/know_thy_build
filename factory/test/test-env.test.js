import { test, expect } from "vitest";
import { envUp, envDown, composeProjectName } from "../lib/test-env.js";
import { makeFakeRun } from "../lib/exec.js";

const harness = { test: { env: { compose: "dc.yml", env_file: ".env.test", seed: "npm run seed", app_start: "npm start", app_ready: "http://localhost:3000/healthz", ready_timeout_sec: 2 }, fakes: { gcal: "npm run fake:gcal" } } };
const okRun = () => makeFakeRun([{ match: () => true, result: { code: 0, stdout: "", stderr: "" } }]);

test("envUp runs compose → seed → fakes → app and polls readiness; returns pids", async () => {
  const run = okRun(); const spawned = []; let polls = 0;
  const spawnBg = (cmd) => { spawned.push(cmd); return { pid: 100 + spawned.length }; };
  const fetch = async () => ({ status: polls++ < 2 ? 503 : 200 });
  const r = await envUp({ run, cwd: "/r", harness, spawnBg, fetch, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 200); })() });
  expect(r.ok).toBe(true);
  expect(run.calls.map((c) => [c.cmd, ...c.args].join(" "))).toEqual(["docker compose -p factory-test-r -f dc.yml --env-file .env.test up -d --wait", "bash -lc npm run seed"]);
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
  expect(run.calls.map((c) => [c.cmd, ...c.args].join(" "))).toEqual(["docker compose -p factory-test-r -f dc.yml --env-file .env.test down -v"]);
});

// INCIDENT 2026-09-22 — the compose project name came from the directory (`server`), the same project the owner's
// production stack ran under on the self-hosted Mac, and `up` recreated the production postgres as the test container.
// The project name is now always explicit and never the directory's.
test("test-env compose always carries an explicit project name (-p) that cannot collide with the directory's own project", async () => {
  expect(composeProjectName({}, "/Users/x/own-calendar")).toBe("factory-test-own-calendar");
  expect(composeProjectName({ project_name: "My Test!" }, "/r")).toBe("my-test-");                 // sanitised to compose's charset
  expect(composeProjectName({}, "/srv/Own Cal.Prod")).toBe("factory-test-own-cal-prod");
  const run = okRun();
  await envUp({ run, cwd: "/r/server", harness: { test: { env: { compose: "docker-compose.test.yml" } } }, spawnBg: () => ({ pid: 1 }), fetch: async () => ({ status: 200 }), sleep: async () => {}, now: () => 0 });
  await envDown({ run, cwd: "/r/server", harness: { test: { env: { compose: "docker-compose.test.yml" } } }, kill: () => {} });
  const lines = run.calls.filter((c) => c.cmd === "docker").map((c) => c.args.join(" "));
  expect(lines).toEqual([
    "compose -p factory-test-server -f docker-compose.test.yml up -d --wait",
    "compose -p factory-test-server -f docker-compose.test.yml down -v",
  ]);
  // never the bare directory name — that is exactly what a production compose in the same directory would use
  for (const l of lines) expect(l).not.toMatch(/compose -p server /);
});

// 1.4.4 demo rehearsal: the adopter's own `docker compose -f … exec db` (no -p) could not find the service the factory
// had started under its explicit project. The project name is therefore ALSO exported as COMPOSE_PROJECT_NAME for
// everything the stage spawns afterwards.
test("envUp exports COMPOSE_PROJECT_NAME so an adopter's bare `docker compose` calls resolve the same project", async () => {
  const before = process.env.COMPOSE_PROJECT_NAME;
  try {
    delete process.env.COMPOSE_PROJECT_NAME;
    const run = okRun();
    const r = await envUp({ run, cwd: "/r/server", harness: { test: { env: { compose: "docker-compose.test.yml" } } }, spawnBg: () => ({ pid: 1 }), fetch: async () => ({ status: 200 }), sleep: async () => {}, now: () => 0 });
    expect(r.ok).toBe(true);
    expect(process.env.COMPOSE_PROJECT_NAME).toBe("factory-test-server");
    expect(r.steps[0]).toEqual({ name: "compose", ok: true, detail: "project factory-test-server" });
  } finally {
    if (before === undefined) delete process.env.COMPOSE_PROJECT_NAME; else process.env.COMPOSE_PROJECT_NAME = before;
  }
});
