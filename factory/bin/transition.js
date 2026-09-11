#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { transition } from "../lib/transition.js";

const USAGE = [
  "usage: transition <issue> <to-label> [--human] [--reason <text>]",
  "",
  "  --human   전이 거부를 needs-human으로 옮기지 않고 이유만 돌려준다.",
  "            게이트 파일(.factory/out/gates.json) 요구는 --human으로도 건너뛸 수 없다 —",
  "            사람이 실행해도 awaiting-review/approved/merged는 이번 런의 GREEN 판정 파일을 요구한다.",
].join("\n");

const [issue, to, ...rest] = process.argv.slice(2);
if (!issue || !Number(issue) || !to) { console.error(USAGE); process.exit(1); }
const human = rest.includes("--human");
const i = rest.indexOf("--reason");
const reason = i >= 0 ? (rest[i + 1] || "") : "";
const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
// 전이 경로다 — 게이트 판정 파일을 읽어서 넘긴다(gatesChecked). 파일이 없으면 없는 대로 넘기고
// requirements가 "확인 안 됨"으로 거부한다. 사람이 실행해도 판정 파일을 대신 써주지는 않는다.
const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
const gatesPath = join(root, ".factory/out/gates.json");
let gatesFile = null;
if (existsSync(gatesPath)) {
  try { gatesFile = JSON.parse(readFileSync(gatesPath, "utf8")); }
  catch (e) { console.error(`transition: ${gatesPath} unreadable — ${e.message}`); }
}
const ctxExtra = { gatesChecked: true, ...(gatesFile ? { gatesFile } : {}) };
const r = await transition({ gh: makeGh({ run, repo }), issue: Number(issue), to, human, reason, ctxExtra });
console.log(JSON.stringify(r));
process.exit(r.ok ? 0 : 2);
