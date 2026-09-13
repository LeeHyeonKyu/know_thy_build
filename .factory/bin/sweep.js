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
import { backPressure } from "../lib/back-pressure.js";

/** CLI 진입: 실제 의존성 조립 */
async function main() {
  // KTB-26 — `--quick`: 스테이지 워크플로의 마지막 스텝이 부르는 모양이다. 빠른 세 팔(in-progress
  // 하트비트 재큐 · blocked 처리 · 멈춘 스테이지 재점화 · 라벨-셋 복구)만 돌고, 시간에 묶인 팔
  // (격리 TTL·토큰 만료)은 30분 cron에 그대로 남는다 — 그 둘은 스테이지가 끝난 그 순간에 다시
  // 볼 이유가 없고, 매 스테이지마다 `quarantine.toml`을 쓰면 커밋 경쟁만 늘어난다.
  const quick = process.argv.slice(2).includes("--quick");
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
  const gh = makeGh({ run, repo });
  const charter = loadCharter(root);
  const thresholds = loadHarness(root).gates.thresholds;
  const quarantine = loadQuarantine(root);
  const saveQuarantine = (q) => saveQuarantineTo(root, q);
  const transition = ({ issue, to, reason }) => transitionIssue({ gh, issue, to, reason });
  const release = (issue) => releaseLock({ run, cwd: root, issue });
  // quick sweep은 토큰 만료 팔을 돌지 않으므로 그 조회도 하지 않는다(스테이지마다 gh를 한 번 덜 때린다).
  const tokenIssuedAt = quick ? null : await gh.getVariable("FACTORY_TOKEN_ISSUED_AT");
  if (!quick && tokenIssuedAt == null) console.warn("factory: FACTORY_TOKEN_ISSUED_AT not set — token expiry check skipped");
  // 멈춘 스테이지의 재점화(KTB-8). 워크플로 파일 이름은 템플릿이 설치하는 그 이름이다 —
  // `factory-<stage>.yml`이 없으면 gh가 실패하고, sweeper는 그 이슈만 error로 적고 넘어간다.
  const dispatchStage = ({ stage, issue: n }) => gh.dispatchWorkflow(`factory-${stage}.yml`, { issue: n });
  // 흐름 제어로 **일부러** 세워 둔 `factory:planned`를 "멈췄다"로 읽지 않기 위한 것이다(KTB-10 M5) —
  // run-stage의 implement가 보는 바로 그 판정을 같은 헬퍼로 묻는다.
  const backPressureFn = () => backPressure({ gh, charter, quarantine, thresholds });
  const actions = await sweep({ gh, charter, thresholds, now: new Date().toISOString(), transition, release, quarantine, saveQuarantine, tokenIssuedAt, dispatchStage, backPressure: backPressureFn, quick });
  console.log(JSON.stringify(actions, null, 2));
  process.exit(0);
}

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
