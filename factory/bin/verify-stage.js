#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { readAgentsLog } from "../lib/agents-log.js";
import { verifyStage } from "../lib/verify-stage.js";
import { ROLE_PREFIX } from "./run-stage.js";
const [stage, issueArg] = process.argv.slice(2);
const issue = Number(issueArg);
if (!stage || !issue) { console.error("usage: verify-stage <stage> <issue>"); process.exit(1); }
const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const raw = readJson(join(root, `.factory/out/${stage}.json`));
// 파일은 claude -p 출력({is_error,result}) 또는 스테이지 산출 JSON 그 자체일 수 있다 — 후자는 감싼다.
const out = raw && (typeof raw.result === "string" || "is_error" in raw) ? raw : { is_error: raw === null, result: JSON.stringify(raw) };
const ctx = readJson(join(root, ".factory/out/context.json")) || {};
const r = verifyStage({
  stage, out,
  agentsLog: readAgentsLog(join(root, ".factory/out/agents.jsonl")),
  roster: ctx.roster || [], rolePrefix: ROLE_PREFIX[stage] || "",
  expectedRounds: ctx.rounds, orchestration: ctx.orchestration,
});
console.log(JSON.stringify({ ok: r.ok, reasons: r.reasons }));
process.exit(r.ok ? 0 : 2);
