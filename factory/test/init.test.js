import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { initCommand } from "../cli/init.js";
import { makeFakeRun } from "../lib/exec.js";

const pkgRoot = new URL("../../", import.meta.url).pathname;
const io = () => { const o = { out: [], err: [] }; return { io: { out: (s) => o.out.push(s), err: (s) => o.err.push(s) }, o }; };
const fresh = () => { const r = mkdtempSync(join(tmpdir(), "ktb-init-")); writeFileSync(join(r, "package.json"), JSON.stringify({ name: "demo-app" })); return r; };

test("init installs the full manifest into an empty repo and renders the project name", async () => {
  const root = fresh(); const { io: i, o } = io();
  expect(await initCommand({ root, pkgRoot, argv: [], io: i })).toBe(0);
  for (const p of [".factory/bin/run-stage.js", ".factory/bin/retro.js", ".factory/lib/gates.js", ".factory/lib/retro/state.js", ".factory/harness.toml", ".factory/roles.toml", ".factory/package.json", ".factory/lessons/reviewer-qa.md", ".claude/settings.json", ".claude/hooks/block-dangerous.sh", ".claude/commands/factory-triage.md", ".github/workflows/factory-implement.yml", ".github/workflows/factory-retro.yml", ".factory/actions/setup/action.yml", "docs/factory/CHARTER.md"]) expect(existsSync(join(root, p)), p).toBe(true);
  expect(readFileSync(join(root, ".factory/harness.toml"), "utf8")).toContain('name           = "demo-app"');
  expect(statSync(join(root, ".claude/hooks/block-dangerous.sh")).mode & 0o111).not.toBe(0);
  const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
  expect(gitignore).toContain(".factory/out/");
  // run 기록은 factory/records 브랜치에 산다(ADR-014) — 작업 브랜치에서는 추적하지 않는다(F1)
  expect(gitignore).toContain("docs/factory/runs/");
  // 게이트가 만드는 테스트 산출물도 추적하지 않는다 — 추적되면 stop-guard가 "미커밋 변경"으로 막는다.
  for (const e of ["test-results/", "coverage/", ".nyc_output/"]) expect(gitignore, e).toContain(e);
  // `npm install --prefix .factory`(setup 액션·`factory run` preflight)가 로컬에 만드는 파일 —
  // 추적되면 매번 dirty이고, `.factory/**`라 무결성 검사에는 사람 머지 신호로 보인다.
  expect(gitignore).toContain(".factory/node_modules/");
  expect(gitignore).toContain(".factory/package-lock.json");
  expect(existsSync(join(root, "docs/factory/runs/.gitkeep")), "no .gitkeep — the directory is created on demand by appendRunRecord").toBe(false);
  expect(o.out.join("\n")).toMatch(/created\s+\d+/);
});

test("init never overwrites; second run reports skips and changes nothing", async () => {
  const root = fresh(); const { io: i } = io();
  await initCommand({ root, pkgRoot, argv: [], io: i });
  writeFileSync(join(root, ".factory/harness.toml"), "mine");
  writeFileSync(join(root, ".factory/lib/gates.js"), "stale");
  const { io: i2, o } = io();
  expect(await initCommand({ root, pkgRoot, argv: [], io: i2 })).toBe(0);
  expect(readFileSync(join(root, ".factory/harness.toml"), "utf8")).toBe("mine");
  expect(readFileSync(join(root, ".factory/lib/gates.js"), "utf8")).toBe("stale");
  expect(o.out.join("\n")).toMatch(/skipped/);
});

test("init --upgrade replaces factory-owned files only and merges settings", async () => {
  const root = fresh(); const { io: i } = io();
  await initCommand({ root, pkgRoot, argv: [], io: i });
  writeFileSync(join(root, ".factory/harness.toml"), "mine");
  writeFileSync(join(root, ".factory/lib/gates.js"), "stale");
  writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm -rf /)"] }, hooks: {} }));
  const { io: i2, o } = io();
  expect(await initCommand({ root, pkgRoot, argv: ["--upgrade"], io: i2 })).toBe(0);
  expect(readFileSync(join(root, ".factory/harness.toml"), "utf8")).toBe("mine");
  expect(readFileSync(join(root, ".factory/lib/gates.js"), "utf8")).toBe(readFileSync(join(pkgRoot, "factory/lib/gates.js"), "utf8"));
  const s = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  expect(s.permissions.deny[0]).toBe("Bash(rm -rf /)"); expect(s.permissions.deny).toContain("Bash(gh pr merge*)"); expect(s.hooks.Stop).toHaveLength(1);
  expect(o.out.join("\n")).toMatch(/replaced\s+1/);
});

test("init --diff prints git diff --no-index for stale factory-owned files and touches nothing", async () => {
  const root = fresh(); const { io: i } = io();
  await initCommand({ root, pkgRoot, argv: [], io: i });
  writeFileSync(join(root, ".factory/lib/gates.js"), "stale");
  const run = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--no-index", result: { code: 1, stdout: "--- a\n+++ b\n-stale\n", stderr: "" } }]);
  const { io: i2, o } = io();
  expect(await initCommand({ root, pkgRoot, argv: ["--diff"], io: i2, run })).toBe(1);   // 차이 있음 = exit 1 (CI에서 stale 감지용)
  expect(o.out.join("\n")).toContain("-stale");
  expect(readFileSync(join(root, ".factory/lib/gates.js"), "utf8")).toBe("stale");
  expect(run.calls.filter((c) => c.args[0] === "diff")).toHaveLength(1);
});

test("init --diff reports a missing factory-owned file as create and cleans up its temp dir", async () => {
  const root = fresh(); const { io: i } = io();
  await initCommand({ root, pkgRoot, argv: [], io: i });
  rmSync(join(root, ".factory/lib/gates.js"));
  const run = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--no-index", result: { code: 1, stdout: "+export const v = 1;\n", stderr: "" } }]);
  const { io: i2, o } = io();
  expect(await initCommand({ root, pkgRoot, argv: ["--diff"], io: i2, run })).toBe(1);
  expect(o.out.join("\n")).toContain("gates.js");
  expect(o.out.join("\n")).toContain("(create");
  const freshPath = run.calls.at(-1).args.at(-1);
  expect(existsSync(dirname(freshPath))).toBe(false);
});

test("init --diff --json prints a JSON summary of stale actions instead of git diff text", async () => {
  const root = fresh(); const { io: i } = io();
  await initCommand({ root, pkgRoot, argv: [], io: i });
  writeFileSync(join(root, ".factory/lib/gates.js"), "stale");
  const { io: i2, o } = io();
  expect(await initCommand({ root, pkgRoot, argv: ["--diff", "--json"], io: i2 })).toBe(1);
  const parsed = JSON.parse(o.out.join(""));
  expect(parsed.stale.some((a) => a.dest === ".factory/lib/gates.js" && a.action === "replace")).toBe(true);
});

test("init falls back to the directory basename when package.json is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-init-noname-")); const { io: i } = io();
  expect(await initCommand({ root, pkgRoot, argv: [], io: i })).toBe(0);
  expect(readFileSync(join(root, ".factory/harness.toml"), "utf8")).toContain(`name           = "${root.split("/").at(-1)}"`);
});
