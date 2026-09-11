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
  const harness = loadHarness(root);
  const branch = harness.project?.default_branch ?? "main";
  let base = bi >= 0 ? args[bi + 1] : null;
  if (base == null) {
    // merge-base를 못 구하면 검사 자체가 성립하지 않는다 — 빈 base로 "위반 없음"을 만들지 않는다(shallow clone 등).
    const mb = await run("git", ["merge-base", `origin/${branch}`, "HEAD"], { cwd: root });
    base = mb.stdout.trim();
    if (mb.code !== 0 || !base) { console.error(`integrity: cannot compute merge-base against origin/${branch} (shallow clone?) — exit ${mb.code} ${mb.stderr.trim()}`); process.exit(2); }
  }
  const r = await integrityCheck({ run, cwd: root, base, harness, readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null) });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
