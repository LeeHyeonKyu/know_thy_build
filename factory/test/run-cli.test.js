import { test, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../cli/run.js";
import { makeFakeRun } from "../lib/exec.js";

const io = () => { const o = { out: [], err: [] }; return { io: { out: (s) => o.out.push(s), err: (s) => o.err.push(s) }, o }; };

/** tmp repo root — with or without .factory/bin/run-stage.js and the smol-toml install marker. */
function makeRoot({ initialized = true, depsInstalled = true } = {}) {
  const root = mktemp();
  if (initialized) {
    mkdirSync(join(root, ".factory/bin"), { recursive: true });
    writeFileSync(join(root, ".factory/bin/run-stage.js"), "// stub\n");
    writeFileSync(join(root, ".factory/bin/retro.js"), "// stub\n");
  }
  if (depsInstalled) {
    mkdirSync(join(root, ".factory/node_modules/smol-toml"), { recursive: true });
    writeFileSync(join(root, ".factory/node_modules/smol-toml/package.json"), "{}\n");
  }
  return root;
}
function mktemp() { return mkdtempSync(join(tmpdir(), "factory-run-cli-")); }

/** run() that always succeeds (npm install ok, gh auth ok) unless overridden. */
function makeOkRun(overrides = []) {
  return makeFakeRun([
    ...overrides,
    { match: (c, a) => c === "npm" && a[0] === "install", result: { code: 0, stdout: "", stderr: "" } },
    { match: (c, a) => c === "gh" && a[0] === "auth", result: { code: 0, stdout: "Logged in\n", stderr: "" } },
  ]);
}

// ── step 1: stage validation ─────────────────────────────────────────────

test("stage merge → error, runs only in CI, exit 1, no side effects", async () => {
  const root = makeRoot();
  const { io: i, o } = io();
  const run = vi.fn();
  const spawnInherit = vi.fn();
  const code = await runCommand({ root, argv: ["merge", "5"], io: i, run, spawnInherit });
  expect(code).toBe(1);
  expect(o.err.join("\n")).toContain("merge runs only in CI (branch protection)");
  expect(run).not.toHaveBeenCalled();
  expect(spawnInherit).not.toHaveBeenCalled();
});

test("retro spawns .factory/bin/retro.js with no issue argument (Plan 4)", async () => {
  const root = makeRoot();
  const { io: i, o } = io();
  const spawnInherit = vi.fn(() => 0);
  const code = await runCommand({ root, argv: ["retro"], io: i, run: makeOkRun(), spawnInherit });
  expect(code).toBe(0);
  expect(o.err).toEqual([]);
  expect(spawnInherit.mock.calls[0][1]).toEqual([".factory/bin/retro.js"]);
});

test("retro --force passes --force through; a stray issue argument is ignored (retro has no issue)", async () => {
  const root = makeRoot();
  const { io: i } = io();
  const spawnInherit = vi.fn(() => 7);
  expect(await runCommand({ root, argv: ["retro", "--force"], io: i, run: makeOkRun(), spawnInherit })).toBe(7);
  expect(spawnInherit.mock.calls[0][1]).toEqual([".factory/bin/retro.js", "--force"]);
  const spawn2 = vi.fn(() => 0);
  expect(await runCommand({ root, argv: ["retro", "5"], io: i, run: makeOkRun(), spawnInherit: spawn2 })).toBe(0);
  expect(spawn2.mock.calls[0][1]).toEqual([".factory/bin/retro.js"]);
});

test("retro still runs the full preflight — missing retro.js is 'not initialized', bad gh auth refuses", async () => {
  const bare = mktemp();
  mkdirSync(join(bare, ".factory/bin"), { recursive: true });
  writeFileSync(join(bare, ".factory/bin/run-stage.js"), "// stub\n");     // 스테이지는 설치됐지만 retro.js는 없다
  const { io: i, o } = io();
  const spawnInherit = vi.fn();
  expect(await runCommand({ root: bare, argv: ["retro"], io: i, run: vi.fn(), spawnInherit })).toBe(1);
  expect(o.err.join("\n")).toContain("factory not initialized");
  expect(spawnInherit).not.toHaveBeenCalled();

  const root = makeRoot();
  const { io: i2, o: o2 } = io();
  const run = makeFakeRun([{ match: (c, a) => c === "gh" && a[0] === "auth", result: { code: 1, stdout: "", stderr: "no" } }]);
  expect(await runCommand({ root, argv: ["retro"], io: i2, run, spawnInherit: vi.fn() })).toBe(1);
  expect(o2.err.join("\n")).toMatch(/gh/i);
});

test("unknown stage → usage error, exit 1", async () => {
  const root = makeRoot();
  const { io: i, o } = io();
  const code = await runCommand({ root, argv: ["bogus", "5"], io: i, run: vi.fn(), spawnInherit: vi.fn() });
  expect(code).toBe(1);
  expect(o.err.join("\n")).toMatch(/usage/i);
});

for (const stage of ["triage", "plan", "implement", "review"]) {
  test(`stage ${stage} is a valid stage (passes step 1)`, async () => {
    const root = makeRoot();
    const { io: i } = io();
    const spawnInherit = vi.fn(() => 0);
    const code = await runCommand({ root, argv: [stage, "5"], io: i, run: makeOkRun(), spawnInherit });
    expect(code).toBe(0);
    expect(spawnInherit).toHaveBeenCalled();
  });
}

test("non-integer or non-positive issue → usage error, exit 1", async () => {
  const root = makeRoot();
  for (const bad of ["abc", "0", "-3", "1.5", ""]) {
    const { io: i, o } = io();
    const code = await runCommand({ root, argv: ["triage", bad], io: i, run: vi.fn(), spawnInherit: vi.fn() });
    expect(code).toBe(1);
    expect(o.err.join("\n")).toMatch(/usage/i);
  }
});

// ── step 2: factory initialized? ─────────────────────────────────────────

test("missing .factory/bin/run-stage.js → 'factory not initialized', exit 1", async () => {
  const root = makeRoot({ initialized: false });
  const { io: i, o } = io();
  const run = vi.fn();
  const code = await runCommand({ root, argv: ["triage", "5"], io: i, run, spawnInherit: vi.fn() });
  expect(code).toBe(1);
  expect(o.err.join("\n")).toContain("factory not initialized — run factory init");
  expect(run).not.toHaveBeenCalled();
});

// ── step 3: .factory deps installed? ─────────────────────────────────────

test("missing .factory/node_modules/smol-toml → runs npm install --prefix .factory", async () => {
  const root = makeRoot({ depsInstalled: false });
  const { io: i } = io();
  const run = makeOkRun();
  const spawnInherit = vi.fn(() => 0);
  const code = await runCommand({ root, argv: ["triage", "5"], io: i, run, spawnInherit });
  expect(code).toBe(0);
  expect(run.calls).toContainEqual({ cmd: "npm", args: ["install", "--prefix", ".factory", "--no-audit", "--no-fund"], opts: { cwd: root } });
});

test("smol-toml already installed → npm install is skipped", async () => {
  const root = makeRoot({ depsInstalled: true });
  const { io: i } = io();
  const run = makeOkRun();
  const spawnInherit = vi.fn(() => 0);
  await runCommand({ root, argv: ["triage", "5"], io: i, run, spawnInherit });
  expect(run.calls.some((c) => c.cmd === "npm")).toBe(false);
});

test("npm install failure → exit 1, no gh check, no spawn", async () => {
  const root = makeRoot({ depsInstalled: false });
  const { io: i, o } = io();
  const run = makeFakeRun([
    { match: (c, a) => c === "npm" && a[0] === "install", result: { code: 1, stdout: "", stderr: "boom" } },
    { match: (c, a) => c === "gh", result: { code: 0, stdout: "", stderr: "" } },
  ]);
  const spawnInherit = vi.fn();
  const code = await runCommand({ root, argv: ["triage", "5"], io: i, run, spawnInherit });
  expect(code).toBe(1);
  expect(spawnInherit).not.toHaveBeenCalled();
  expect(o.err.join("\n")).toBeTruthy();
});

// ── step 4: gh auth ────────────────────────────────────────────────────

test("gh auth status failure → error with hint, exit 1, no spawn", async () => {
  const root = makeRoot();
  const { io: i, o } = io();
  const run = makeFakeRun([
    { match: (c, a) => c === "gh" && a[0] === "auth", result: { code: 1, stdout: "", stderr: "not logged in" } },
  ]);
  const spawnInherit = vi.fn();
  const code = await runCommand({ root, argv: ["triage", "5"], io: i, run, spawnInherit });
  expect(code).toBe(1);
  expect(o.err.join("\n")).toMatch(/gh/i);
  expect(spawnInherit).not.toHaveBeenCalled();
});

// ── step 5: spawn run-stage.js with FACTORY_LOCAL_ENTRY ─────────────────

test("success path spawns node .factory/bin/run-stage.js <stage> <issue> with FACTORY_LOCAL_ENTRY=1 and returns its exit code", async () => {
  const root = makeRoot();
  const { io: i } = io();
  const run = makeOkRun();
  const spawnInherit = vi.fn(() => 3);
  const env = { PATH: "/usr/bin", SOME_VAR: "x" };
  const code = await runCommand({ root, argv: ["review", "42"], io: i, run, spawnInherit, env });
  expect(code).toBe(3);
  expect(spawnInherit).toHaveBeenCalledTimes(1);
  const [cmd, args, opts] = spawnInherit.mock.calls[0];
  expect(cmd).toBe("node");
  expect(args).toEqual([".factory/bin/run-stage.js", "review", "42"]);
  expect(opts.cwd).toBe(root);
  expect(opts.env).toEqual(expect.objectContaining({ PATH: "/usr/bin", SOME_VAR: "x", FACTORY_LOCAL_ENTRY: "1" }));
});

// ── KTB-8: --remote는 아무것도 로컬에서 돌리지 않고 CI 워크플로만 띄운다 ──
// 라벨이 이미 목적 상태에 있으면 `labeled` 이벤트를 다시 만들 수 없다 — sweeper가 30분마다 하는
// 재점화를 사람·컨트롤러가 지금 하는 손잡이다.

test("--remote dispatches factory-<stage>.yml with the issue input and never spawns anything locally", async () => {
  const root = mktemp();                                  // init 여부·.factory 의존성을 보지 않는다
  const { io: i, o } = io();
  const run = makeFakeRun([
    { match: (c, a) => c === "gh" && a[0] === "auth", result: { code: 0, stdout: "ok", stderr: "" } },
    { match: (c, a) => c === "gh" && a[0] === "workflow", result: { code: 0, stdout: "", stderr: "" } },
  ]);
  const spawnInherit = vi.fn();
  const code = await runCommand({ root, argv: ["plan", "2", "--remote"], io: i, run, spawnInherit });
  expect(code).toBe(0);
  expect(spawnInherit).not.toHaveBeenCalled();
  expect(run.calls.find((c) => c.args[0] === "workflow").args).toEqual(["workflow", "run", "factory-plan.yml", "-f", "issue=2"]);
  expect(o.out.join("\n")).toContain("dispatched factory-plan.yml for issue #2");
});

test("--remote accepts merge (branch protection blocks the LOCAL run, not the CI dispatch); a failing dispatch exits 1", async () => {
  const okRun = makeFakeRun([
    { match: (c, a) => c === "gh" && a[0] === "auth", result: { code: 0, stdout: "ok", stderr: "" } },
    { match: (c, a) => c === "gh" && a[0] === "workflow", result: { code: 0, stdout: "", stderr: "" } },
  ]);
  const a = io();
  expect(await runCommand({ root: mktemp(), argv: ["merge", "7", "--remote"], io: a.io, run: okRun, spawnInherit: vi.fn() })).toBe(0);
  expect(okRun.calls.find((c) => c.args[0] === "workflow").args).toContain("factory-merge.yml");

  const badRun = makeFakeRun([
    { match: (c, x) => c === "gh" && x[0] === "auth", result: { code: 0, stdout: "ok", stderr: "" } },
    { match: (c, x) => c === "gh" && x[0] === "workflow", result: { code: 1, stdout: "", stderr: "could not find any workflows named factory-plan.yml" } },
  ]);
  const b = io();
  expect(await runCommand({ root: mktemp(), argv: ["plan", "2", "--remote"], io: b.io, run: badRun, spawnInherit: vi.fn() })).toBe(1);
  expect(b.o.err.join("\n")).toContain("could not find any workflows");
});

test("--remote refuses retro and a bad issue number without calling gh workflow run", async () => {
  const run = makeFakeRun([{ match: (c) => c === "gh", result: { code: 0, stdout: "ok", stderr: "" } }]);
  const a = io();
  expect(await runCommand({ root: mktemp(), argv: ["retro", "--remote"], io: a.io, run, spawnInherit: vi.fn() })).toBe(1);
  expect(a.o.err.join("\n")).toMatch(/retro is merge-triggered/);
  const b = io();
  expect(await runCommand({ root: mktemp(), argv: ["plan", "zero", "--remote"], io: b.io, run, spawnInherit: vi.fn() })).toBe(1);
  expect(run.calls.some((c) => c.args[0] === "workflow")).toBe(false);
});

test("default spawnInherit and run are used when not injected (smoke — routes through real deps)", async () => {
  // not exercised end-to-end here (would spawn real processes); just confirm the export shape.
  const mod = await import("../cli/run.js");
  expect(typeof mod.runCommand).toBe("function");
});
