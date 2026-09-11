#!/usr/bin/env node
import { hostname } from "node:os";
import { run } from "../lib/exec.js";
import { claim, release } from "../lib/claim.js";
const [cmd, issueArg, stage] = process.argv.slice(2);
const issue = Number(issueArg);
if (!issue || (cmd !== "claim" && cmd !== "release") || (cmd === "claim" && !stage)) {
  console.error("usage: claim claim <issue> <stage> | claim release <issue>");
  process.exit(1);
}
const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
const runnerId = process.env.FACTORY_RUNNER_ID || `local/${hostname()}`;
const r = cmd === "claim"
  ? await claim({ run, cwd: root, issue, stage, runnerId })
  : { ok: await release({ run, cwd: root, issue }) };
console.log(JSON.stringify(r));
process.exit(r.ok ? 0 : 2);
