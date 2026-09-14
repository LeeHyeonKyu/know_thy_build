#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { parseTransitionArgs, transition } from "../lib/transition.js";

const USAGE = [
  "usage: transition <issue> [<to-label>] [--human] [--retry] [--reason <text>]",
  "",
  "  --human   전이 거부를 needs-human으로 옮기지 않고 이유만 돌려준다.",
  "            게이트 파일(.factory/out/gates.json) 요구는 --human으로도 건너뛸 수 없다 —",
  "            사람이 실행해도 awaiting-review/approved/merged는 이번 런의 GREEN 판정 파일을 요구한다.",
  "  --retry   (--human 전용, ADR-020 KTB-32) factory:needs-human에서 **중단 지점**으로 되돌린다.",
  "            목적 라벨은 이슈에 남은 기록이 정한다 — 마지막으로 blocked/needs-human으로 간 전이의",
  "            출발 라벨(awaiting-review면 review만 다시 돈다). 라벨을 명시해도 같은 검사를 지난다:",
  "            중단 지점이 아닌 자리로는 전이하지 않는다(exit 2, 라벨 불변).",
].join("\n");

const args = parseTransitionArgs(process.argv.slice(2));
if (args.error) { console.error(`transition: ${args.error}\n\n${USAGE}`); process.exit(1); }
const { issue, to, human, retry, reason } = args;
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
const r = await transition({ gh: makeGh({ run, repo }), issue, to, human, retry, reason, ctxExtra });
console.log(JSON.stringify(r));
process.exit(r.ok ? 0 : 2);
