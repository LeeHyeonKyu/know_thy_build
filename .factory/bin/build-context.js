#!/usr/bin/env node
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { buildContext } from "../lib/context.js";
import { loadHarness } from "../lib/config.js";
const [stage, issueArg] = process.argv.slice(2);
const issue = Number(issueArg);
if (!stage || !issue) { console.error("usage: build-context <stage> <issue>"); process.exit(1); }
const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
/**
 * 감사 H3 — tier 바닥은 diff가 정한다. merge-base를 못 구하면 **바닥 없이** 진행하지 않고, 그 사실을
 * 말한 뒤 신고 tier로 둔다(이 bin은 워크플로의 편의 진입점이고, 진짜 집행은 run-stage가 한다 —
 * 거기서는 게이트가 같은 merge-base로 BLOCKED를 올린다).
 */
const harness = loadHarness(root);
const branch = harness.project?.default_branch ?? "main";
const mb = await run("git", ["merge-base", `origin/${branch}`, "HEAD"], { cwd: root });
const base = mb.code === 0 ? mb.stdout.trim() : null;
if (!base) console.error(`build-context: merge-base against origin/${branch} unresolved — tier floor not computed`);
const ctx = await buildContext({ root, gh: makeGh({ run, repo }), issue, stage, run, base });   // .factory/out/context.json도 함께 쓴다
console.log(JSON.stringify(ctx, null, 2));
process.exit(0);
