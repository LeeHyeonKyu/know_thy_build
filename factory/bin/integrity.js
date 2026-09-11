#!/usr/bin/env node
import { realpathSync, readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { loadHarness } from "../lib/config.js";
import { integrityCheck } from "../lib/integrity.js";
const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2); const bi = args.indexOf("--base");
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const base = bi >= 0 ? args[bi + 1] : (await run("git", ["merge-base", "origin/main", "HEAD"], { cwd: root })).stdout.trim();
  const r = await integrityCheck({ run, cwd: root, base, harness: loadHarness(root), readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null) });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
