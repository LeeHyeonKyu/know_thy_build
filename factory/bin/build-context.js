#!/usr/bin/env node
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { buildContext } from "../lib/context.js";
const [stage, issueArg] = process.argv.slice(2);
const issue = Number(issueArg);
if (!stage || !issue) { console.error("usage: build-context <stage> <issue>"); process.exit(1); }
const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
const ctx = await buildContext({ root, gh: makeGh({ run, repo }), issue, stage });   // .factory/out/context.json도 함께 쓴다
console.log(JSON.stringify(ctx, null, 2));
process.exit(0);
