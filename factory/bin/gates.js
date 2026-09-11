#!/usr/bin/env node
/**
 * 로컬 진단용 게이트 러너 — run-stage의 `d.gates`와 같은 본체(lib/gates.js runStageGates)를 부른다.
 * usage: gates.js [fast|full|deep] [--tier <docs|standard|load-bearing>] [--stage <implement|review|merge>] [--base <sha>]
 * exit: 0 GREEN / 1 RED / 2 그 밖(MISCONFIGURED·BLOCKED)
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { loadHarness } from "../lib/config.js";
import { loadQuarantine } from "../lib/quarantine.js";
import { runStageGates, verdictLine } from "../lib/gates.js";

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const usage = "usage: gates.js [fast|full|deep] [--tier <docs|standard|load-bearing>] [--stage <implement|review|merge>] [--base <sha>]";
  if (args.includes("-h") || args.includes("--help")) { console.log(usage); process.exit(0); }
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const level = args.find((a) => ["fast", "full", "deep"].includes(a)) || null;
  const tier = flag("--tier") || "standard";
  const stage = flag("--stage") || "implement";
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  let harness;
  try { harness = loadHarness(root); } catch (e) { console.error(`gates: .factory/harness.toml unreadable — ${e.message}`); process.exit(2); }
  const base = flag("--base") || (await run("git", ["merge-base", `origin/${harness.project?.default_branch || "main"}`, "HEAD"], { cwd: root })).stdout.trim();
  const readFile = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  // gh는 넘기지 않는다 — 로컬 진단이 flaky 이슈를 열어서는 안 된다.
  const result = await runStageGates({ run, cwd: root, harness, stage, tier, level, base, quarantine: loadQuarantine(root), readFile });
  mkdirSync(join(root, ".factory/out"), { recursive: true });
  writeFileSync(join(root, ".factory/out/gates.json"), JSON.stringify(result, null, 2));
  console.log(verdictLine(result));
  process.exit(result.status === "GREEN" ? 0 : result.status === "RED" ? 1 : 2);
}
