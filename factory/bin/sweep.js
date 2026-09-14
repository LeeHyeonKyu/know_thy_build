#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { makeGh, resolveFactoryLogins } from "../lib/gh.js";
import { loadCharter, loadHarness, loadRoles } from "../lib/config.js";
import { resolveReviewRoster, tierFromReviewHandoff } from "../lib/review-roster.js";
import { loadQuarantine, saveQuarantine as saveQuarantineTo } from "../lib/quarantine.js";
import { transition as transitionIssue } from "../lib/transition.js";
import { makeRehearsalChecker } from "../lib/rehearsal.js";
import { release as releaseLock, releaseIfStale as releaseIfStaleLock } from "../lib/claim.js";
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
  const harness = loadHarness(root);
  const thresholds = harness.gates.thresholds;
  const quarantine = loadQuarantine(root);
  const saveQuarantine = (q) => saveQuarantineTo(root, q);
  /**
   * KTB-44 / ADR-025 (리뷰 must_fix 3 · should_fix 4) — sweeper의 하네스 주차 해제도 **게이트를 지난다**.
   * 예전에는 인자를 생략하는 것만으로 면제였고, 그러면 사람은 `:unstick`에서 "리허설이 낡았다"고
   * 거부당하는데 로봇은 같은 이슈를 조용히 큐에 넣었다. 거부된 재큐는 사고가 아니다 — 이 팔은 매
   * sweep마다 다시 시도하고(이미 실패 편향이다), 그 사이에 사람이 `factory rehearse`를 돌린다.
   */
  const rehearsal = makeRehearsalChecker({ gh, root, branch: harness.project?.default_branch || "main" });
  // KTB-46: `ctxExtra`를 그대로 흘려보낸다. sweeper의 팔 대부분은 주지 않지만(그때는 `{}`),
  // 사람 머지 반영 팔은 PR head sha를 실어 `requirements.js`의 `factory:merged` 증거 검사가
  // review handoff를 그 커밋에 묶게 한다 — 여기서 떨어뜨리면 그 검사는 묶을 대상을 잃는다.
  const transition = ({ issue, to, reason, ctxExtra }) => transitionIssue({ gh, issue, to, reason, ctxExtra, rehearsal });
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
   * ADR-020 KTB-28 (c) — "이 이슈의 락이 **잔해**면 지워라"(판정과 리스 삭제는 `lib/claim.js`에 있다 —
   * 여기서는 이 저장소의 `run`/`root`만 묶는다. r1 MF1: 그래야 그 판정에 테스트가 붙는다).
   */
  const releaseIfStale = (n) => releaseIfStaleLock({ run, cwd: root, issue: n });
  /**
   * KTB-46 — 사람 머지 반영 팔의 게이트 증거는 그 커밋에 붙은 `factory/gates`·`factory/review` 상태이고,
   * 그 상태가 **팩토리 계정의 것인지**를 대조할 기준이 이 이름들이다(외부 감사 H1b). `run-stage.js`의
   * merge deps가 쓰는 바로 그 해석기를 그대로 쓴다 — `gh api user`가 두 벌이 되면 갈라진다.
   */
  const factoryLogins = () => resolveFactoryLogins({ gh });
  /**
   * KTB-46 r3 must_fix 1 — **정족수를 잴 자.** 이것을 넘기지 않으면 `verifyReviewQuorum`은 로스터
   * 크기·빠진 역할·K를 전부 건너뛰고 "있는 verdict가 전부 approve인가"만 본다 — 4명짜리 로스터의
   * 이슈가 1명의 approve로 `factory:merged`에 도달했다. 해석은 merge 스테이지의 `reviewRoster` dep과
   * **같은 함수**다(`lib/review-roster.js`). 실효 tier(H3)도 같은 주입점으로 간다 — 다만 여기서는
   * diff를 다시 내지 않는다(머지 뒤에는 `claude/fq-<n>`이 없다): **review 런이 계산해 handoff에
   * 실어 둔 `tier_effective`**를 팔이 읽어 넘기고, `maxTier(선언, handoff)`로 합친다(r4).
   * 그 필드가 없는 1.2 이전 기록에서는 선언 tier로 내려가고, 팔이 그 사실을 한 줄로 말한다.
   */
  const reviewRoster = (comments, handoffTier = null) => resolveReviewRoster({
    // r5 nit 6: 함수로 넘겨 `roles.toml` 읽기까지 lib의 catch 안에서 일어나게 한다 — 그래야 깨진
    // 파일이 merge 스테이지와 **같은 문장**으로 접힌다.
    charter, roles: () => loadRoles(root), comments,
    effectiveTier: handoffTier ? tierFromReviewHandoff(handoffTier) : null,
  });
  /** KTB-46 r3 must_fix 4 — 머지된 PR의 필수 체크도 확인한다(merge 스테이지와 같은 목록·같은 판정 함수). */
  const requiredChecks = harness?.factory?.required_checks ?? null;
  const actions = await sweep({ gh, charter, thresholds, now: new Date().toISOString(), transition, release, quarantine, saveQuarantine, tokenIssuedAt, dispatchStage, backPressure: backPressureFn, harnessSettled, factoryLogins, reviewRoster, requiredChecks, releaseIfStale, quick });
  console.log(JSON.stringify(actions, null, 2));
  process.exit(0);
}

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
