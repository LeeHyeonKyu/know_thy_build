#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { loadCharter, loadHarness } from "../lib/config.js";
import { loadQuarantine, saveQuarantine as saveQuarantineTo } from "../lib/quarantine.js";
import { transition as transitionIssue } from "../lib/transition.js";
import { release as releaseLock } from "../lib/claim.js";
import { sweep } from "../lib/sweeper.js";

/** CLI 진입: 실제 의존성 조립 */
async function main() {
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
  const gh = makeGh({ run, repo });
  const charter = loadCharter(root);
  const thresholds = loadHarness(root).gates.thresholds;
  const quarantine = loadQuarantine(root);
  const saveQuarantine = (q) => saveQuarantineTo(root, q);
  const transition = ({ issue, to, reason }) => transitionIssue({ gh, issue, to, reason });
  const release = (issue) => releaseLock({ run, cwd: root, issue });
  const tokenIssuedAt = await gh.getVariable("FACTORY_TOKEN_ISSUED_AT");
  if (tokenIssuedAt == null) console.warn("factory: FACTORY_TOKEN_ISSUED_AT not set — token expiry check skipped");
  // 멈춘 스테이지의 재점화(KTB-8). 워크플로 파일 이름은 템플릿이 설치하는 그 이름이다 —
  // `factory-<stage>.yml`이 없으면 gh가 실패하고, sweeper는 그 이슈만 error로 적고 넘어간다.
  const dispatchStage = ({ stage, issue: n }) => gh.dispatchWorkflow(`factory-${stage}.yml`, { issue: n });
  const actions = await sweep({ gh, charter, thresholds, now: new Date().toISOString(), transition, release, quarantine, saveQuarantine, tokenIssuedAt, dispatchStage });
  console.log(JSON.stringify(actions, null, 2));
  process.exit(0);
}

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
