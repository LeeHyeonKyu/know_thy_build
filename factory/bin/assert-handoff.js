#!/usr/bin/env node
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { STAGE_OF_TARGET } from "../lib/labels.js";
import { requirementFor } from "../lib/requirements.js";
import { transition } from "../lib/transition.js";
import { prevStage } from "./run-stage.js";
const [stage, issueArg] = process.argv.slice(2);
const issue = Number(issueArg);
if (!stage || !issue) { console.error("usage: assert-handoff <stage> <issue>"); process.exit(1); }
const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
const gh = makeGh({ run, repo });
const target = Object.entries(STAGE_OF_TARGET).find(([, s]) => s === prevStage(stage))?.[0];
// ctx에 gatesChecked를 **일부러** 넣지 않는다: 이건 "직전 스테이지가 산출물을 남겼는가"를 묻는
// 선행 확인이지 이번 런의 게이트 판정이 아니다(게이트는 아직 돌지도 않았다).
const req = target ? requirementFor(target)({ comments: await gh.comments(issue), issue }) : { ok: true };
if (!req.ok) await transition({ gh, issue, to: "factory:needs-human", reason: `prerequisite handoff missing: ${req.reason}` });
console.log(JSON.stringify({ stage, issue, requires: target ?? null, ...req }));
process.exit(req.ok ? 0 : 2);
