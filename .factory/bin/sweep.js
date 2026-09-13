#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { loadCharter, loadHarness } from "../lib/config.js";
import { loadQuarantine, saveQuarantine as saveQuarantineTo } from "../lib/quarantine.js";
import { transition as transitionIssue } from "../lib/transition.js";
import { release as releaseLock, lockHolder, runnerState } from "../lib/claim.js";
import { sweep } from "../lib/sweeper.js";
import { backPressure } from "../lib/back-pressure.js";

/** CLI 진입: 실제 의존성 조립 */
async function main() {
  // KTB-26 — `--quick`: 스테이지 워크플로의 마지막 스텝이 부르는 모양이다. 상태 복구 팔(in-progress
  // 하트비트 재큐 · blocked 처리 · 멈춘 스테이지 재점화 · 하네스 주차 해제 · 라벨-셋 복구)만 돌고, 시간에 묶인 팔
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
  /**
   * ADR-020 KTB-23 fix — "이 하네스 이슈는 끝났는가". 두 신호를 본다:
   *   ① 이슈가 닫혔다 — builder가 PR 본문에 `Closes #<n>`을 넣으므로(implement 규칙 6) 사람이
   *      머지 버튼을 누르는 순간 GitHub이 닫는다. 이것이 정상 경로다.
   *   ② 그 이슈의 브랜치(`claude/fq-<n>`)에서 PR이 머지됐다 — 사람이 `Closes` 줄을 지웠거나
   *      본문을 갈아엎은 경우의 폴백. 하네스는 들어왔는데 이슈만 열려 있는 상태다.
   * 조회가 실패하면 done을 세우지 않는다(fail closed) — 잘못 푸는 것보다 다음 sweep이 낫다.
   */
  const harnessSettled = async (n) => {
    let state = null;
    try { state = await gh.issueState(n); }
    catch (e) { return { done: false, why: `state unreadable — ${e?.message || e}` }; }
    if (state?.state === "CLOSED") return { done: true, why: "이슈가 닫혔습니다" };
    try {
      const pr = await gh.mergedPrForBranch(`claude/fq-${n}`);
      if (pr != null) return { done: true, why: `PR #${pr}이 머지됐습니다` };
    } catch (e) { return { done: false, why: `merged-PR lookup failed — ${e?.message || e}` }; }
    return { done: false, why: "아직 열려 있습니다" };
  };
  /**
   * ADR-020 KTB-28 (c) — "이 이슈의 락이 **잔해**면 지워라". 두 팔(멈춘 스테이지 재점화, blocked 재시도)이
   * dispatch 직전에 부른다: dispatch는 락을 보지 않으므로, 고아 락 위로 민 런은 `claim()`에서 곧장
   * 죽는다(데모 #15: 네 번). 지우는 조건은 하나뿐이다 — 락 커밋 제목의 `runner=gha-<run_id>`가 가리키는
   * 워크플로 런이 **완료**됐다. 조회가 실패하거나 로컬 러너면 살아 있는 것으로 보고 손대지 않는다
   * (fail closed: 틀린 회수는 같은 이슈에 두 스테이지를 동시에 넣는다).
   */
  const releaseIfStale = async (n) => {
    const held = await lockHolder({ run, cwd: root, issue: n });
    if (held?.present !== true) return { released: false, why: held?.present === false ? "no lock" : `lock unreadable — ${held?.reason}` };
    const state = await runnerState({ run, cwd: root, runner: held.runner });
    if (!state.completed) return { released: false, why: `held by ${held.runner ?? "unknown"} (${state.status})` };
    const ok = await releaseLock({ run, cwd: root, issue: n });
    return { released: ok, runner: held.runner, why: ok ? `stale lock from ${held.runner} released` : "release failed" };
  };
  const actions = await sweep({ gh, charter, thresholds, now: new Date().toISOString(), transition, release, quarantine, saveQuarantine, tokenIssuedAt, dispatchStage, backPressure: backPressureFn, harnessSettled, releaseIfStale, quick });
  console.log(JSON.stringify(actions, null, 2));
  process.exit(0);
}

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
