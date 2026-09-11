#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { run } from "../lib/exec.js";
import { loadHarness } from "../lib/config.js";

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) {
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const setup = loadHarness(root).runtime?.setup;
  if (!setup) { console.log("setup-env: no [runtime].setup — nothing to do"); process.exit(0); }
  console.log(`setup-env: ${setup}`);
  const r = spawnSync("bash", ["-lc", setup], { cwd: root, stdio: "inherit" });   // 출력을 잡 로그에 그대로 흘린다
  process.exit(r.status ?? 1);
}
