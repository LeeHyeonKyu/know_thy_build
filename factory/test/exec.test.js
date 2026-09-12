import { test, expect } from "vitest";
import { run, makeFakeRun, scrubEnv, scrubbedRunner, MERGE_CAPABLE_ENV } from "../lib/exec.js";

test("run executes a real command and captures stdout/code", async () => {
  const r = await run("node", ["-e", "process.stdout.write('hi'); process.exit(3)"]);
  expect(r.stdout).toBe("hi");
  expect(r.code).toBe(3);
}, 30000);

test("run passes stdin input", async () => {
  const r = await run("node", ["-e", "process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase()))"], { input: "abc" });
  expect(r.stdout).toBe("ABC");
  expect(r.code).toBe(0);
});

test("makeFakeRun matches by predicate and records calls", async () => {
  const fake = makeFakeRun([
    { match: (c, a) => c === "gh" && a[0] === "issue", result: { code: 0, stdout: '{"n":1}', stderr: "" } },
  ]);
  const r = await fake("gh", ["issue", "view", "1"]);
  expect(JSON.parse(r.stdout)).toEqual({ n: 1 });
  expect(fake.calls).toEqual([{ cmd: "gh", args: ["issue", "view", "1"], opts: {} }]);
  await expect(fake("git", ["status"])).rejects.toThrow(/unexpected command: git status/);
});

// ── ADR-020 fix round 1: 게이트 하위 프로세스는 머지 권한을 물려받지 않는다 ─────────
// 게이트 `[commands]`는 PR이 쓴 코드이고 merge 잡 안에서 돈다 — 토큰이 그 안에 있으면 게이트
// 스크립트 한 줄(`gh pr merge`)로 보호 경로 검사를 건너뛸 수 있다. L2 deny는 `claude -p` 세션의
// Bash에만 걸리지, 벤더 스크립트가 부르는 하위 프로세스에는 걸리지 않는다.

const SOURCE = { PATH: "/usr/bin", HOME: "/home/x", CI: "true", NODE_ENV: "test", GH_TOKEN: "ghp_x", GITHUB_TOKEN: "gh_y", FACTORY_BOT_TOKEN: "b", FACTORY_MERGE_TOKEN: "m", CLAUDE_CODE_OAUTH_TOKEN: "o", ANTHROPIC_API_KEY: "k" };

test("scrubEnv drops every merge-capable credential and keeps the rest (PATH/HOME/CI/NODE_ENV)", () => {
  const e = scrubEnv(SOURCE);
  for (const k of MERGE_CAPABLE_ENV) expect(e, k).not.toHaveProperty(k);
  expect(e).toEqual({ PATH: "/usr/bin", HOME: "/home/x", CI: "true", NODE_ENV: "test" });
});

test("scrubEnv takes extra names to drop, and never mutates the source", () => {
  const e = scrubEnv(SOURCE, ["NODE_ENV"]);
  expect(e).not.toHaveProperty("NODE_ENV");
  expect(e.PATH).toBe("/usr/bin");
  expect(SOURCE.GH_TOKEN).toBe("ghp_x");                 // 원본은 그대로다
});

test("scrubbedRunner passes replaceEnv:true with a scrubbed env, and lets opts.env layer on top", async () => {
  const fake = makeFakeRun([{ match: () => true, result: { code: 0, stdout: "", stderr: "" } }]);
  const runner = scrubbedRunner(fake, { source: SOURCE });
  await runner("bash", ["-lc", "npm test"], { cwd: "/repo", env: { EXTRA: "1" } });
  const { opts } = fake.calls[0];
  expect(opts.replaceEnv).toBe(true);
  expect(opts.cwd).toBe("/repo");
  for (const k of MERGE_CAPABLE_ENV) expect(opts.env, k).not.toHaveProperty(k);
  expect(opts.env.PATH).toBe("/usr/bin");
  expect(opts.env.EXTRA).toBe("1");
});

test("replaceEnv makes opts.env the WHOLE child env — process.env is not layered back on (real spawn)", async () => {
  const script = "process.stdout.write(JSON.stringify({tok: process.env.KTB_FAKE_TOKEN ?? null, path: !!process.env.PATH}))";
  const source = { ...process.env, KTB_FAKE_TOKEN: "secret" };
  // 스크럽 없이: 자식이 그 값을 본다
  const withTok = await run("node", ["-e", script], { env: { KTB_FAKE_TOKEN: "secret" } });
  expect(JSON.parse(withTok.stdout).tok).toBe("secret");
  // 스크럽 뒤: 같은 키가 사라지고 PATH는 남는다
  const runner = scrubbedRunner(run, { source, extra: ["KTB_FAKE_TOKEN"] });
  const scrubbed = await runner("node", ["-e", script]);
  expect(JSON.parse(scrubbed.stdout)).toEqual({ tok: null, path: true });
}, 30000);
