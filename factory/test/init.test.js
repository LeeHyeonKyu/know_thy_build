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
  for (const p of [".factory/bin/run-stage.js", ".factory/lib/gates.js", ".factory/harness.toml", ".factory/roles.toml", ".factory/package.json", ".factory/lessons/reviewer-qa.md", ".claude/settings.json", ".claude/hooks/block-dangerous.sh", ".claude/commands/factory-triage.md", ".github/workflows/factory-implement.yml", ".factory/actions/setup/action.yml", "docs/factory/CHARTER.md", "docs/factory/runs/.gitkeep"]) expect(existsSync(join(root, p)), p).toBe(true);
  expect(readFileSync(join(root, ".factory/harness.toml"), "utf8")).toContain('name           = "demo-app"');
  expect(statSync(join(root, ".claude/hooks/block-dangerous.sh")).mode & 0o111).not.toBe(0);
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".factory/out/");
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
