#!/usr/bin/env node
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { transition } from "../lib/transition.js";
const [issue, to, ...rest] = process.argv.slice(2);
if (!issue || !Number(issue) || !to) { console.error("usage: transition <issue> <to-label> [--human] [--reason <text>]"); process.exit(1); }
const human = rest.includes("--human");
const reason = rest[rest.indexOf("--reason") + 1] || "";
const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
const r = await transition({ gh: makeGh({ run, repo }), issue: Number(issue), to, human, reason });
console.log(JSON.stringify(r));
process.exit(r.ok ? 0 : 2);
