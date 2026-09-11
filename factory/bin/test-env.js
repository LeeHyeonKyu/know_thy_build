#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { loadHarness } from "../lib/config.js";
import { envUp, envDown } from "../lib/test-env.js";

export const PIDS = ".factory/out/test-env.pids";
async function main() {
  const [mode] = process.argv.slice(2);
  if (!["up", "down"].includes(mode)) { console.error("usage: test-env.js up|down"); process.exit(1); }
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const harness = loadHarness(root);
  const pidFile = join(root, PIDS);
  if (mode === "up") {
    const r = await envUp({ run, cwd: root, harness, log: (s) => console.error(s) });
    mkdirSync(join(root, ".factory/out"), { recursive: true });
    writeFileSync(pidFile, JSON.stringify(r.pids));
    if (!r.ok) { console.error(`test-env: BLOCKED — ${r.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`).join("; ")}`); process.exit(2); }
    process.exit(0);
  }
  const pids = existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, "utf8")) : [];
  const r = await envDown({ run, cwd: root, harness, pids, log: (s) => console.error(s) });
  rmSync(pidFile, { force: true });
  process.exit(r.ok ? 0 : 1);
}
const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
