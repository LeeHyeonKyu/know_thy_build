#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { renderHandoff } from "../lib/handoff.js";
import { validate } from "../lib/schemas.js";
const [stage, issueArg, file] = process.argv.slice(2);
const issue = Number(issueArg);
if (!stage || !issue || !file) { console.error("usage: write-handoff <stage> <issue> <json-file>"); process.exit(1); }
let data;
try { data = JSON.parse(readFileSync(file, "utf8")); } catch (e) { console.error(`cannot read JSON from ${file}: ${e.message}`); process.exit(1); }
if (stage !== "merge") {                                   // merge 스테이지는 스키마가 없다
  const v = validate(`${stage}.v1`, data);
  if (!v.ok) { console.error(JSON.stringify({ ok: false, reason: `schema ${stage}.v1: ${v.errors.join("; ")}` })); process.exit(2); }
}
const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
const url = await makeGh({ run, repo }).comment(issue, renderHandoff({ stage, issue, summary: data.summary || `### ${stage} 완료`, data }));
console.log(JSON.stringify({ ok: true, stage, issue, url }));
process.exit(0);
