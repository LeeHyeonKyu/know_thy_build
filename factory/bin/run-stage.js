#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { makeGh, allChecksGreen, resolveFactoryLogins } from "../lib/gh.js";
import { loadCharter, loadHarness, loadRoles } from "../lib/config.js";
import { loadQuarantine, saveQuarantine as writeQuarantine } from "../lib/quarantine.js";
import { backPressure } from "../lib/back-pressure.js";
import { runStageGates, verdictLine, commitStatusState, maxTier } from "../lib/gates.js";
import { isGitDiffError } from "../lib/changed-files.js";
import { MergeBaseError, MERGE_BASE_BLOCKED_REASON, MERGE_BASE_ERROR_CODE, isMergeBaseError, GIT_DIFF_BLOCKED_REASON } from "../lib/blocked-errors.js";
import { integrityCheck, protectedPaths, policyViolations } from "../lib/integrity.js";
import { needsDenyAllWritesHook } from "../lib/agent-md.js";
import { claim, release, lockHolder } from "../lib/claim.js";
import { requirementFor } from "../lib/requirements.js";
import { STAGE_OF_TARGET, ENTRY_LABELS, BLOCKED_RETRY, factoryLabelOf, STATES, TIERS, tierLabel } from "../lib/labels.js";
import { HARNESS_LABEL } from "../lib/label-catalog.js";
import { harnessNeeded, ensureHarnessIssue, parkedReason } from "../lib/harness-request.js";
import { makeRehearsalChecker } from "../lib/rehearsal.js";
import { REHEARSAL_UNWIRED } from "../lib/transition.js";
export { HARNESS_LABEL };   // 재수출 — retro.js와 이 값이 같은 소스에서 왔다는 것을 테스트가 import equality로 확인한다
import { buildContext, resolveTier } from "../lib/context.js";
import { resolveReviewRoster } from "../lib/review-roster.js";
import { startHeartbeat } from "../lib/heartbeat.js";
import { readProgress, progressMarker } from "../lib/progress.js";
import { readAgentsLog } from "../lib/agents-log.js";
import { verifyStage, hitMaxTurns, hitApiError, isNonTransientApiError, qaEvidenceUnusable } from "../lib/verify-stage.js";
import { readTranscript, extractStageArtifact } from "../lib/stage-artifact.js";
import { matchesAny } from "../lib/glob.js";
import { aggregateReview } from "../lib/aggregate.js";
import { renderHandoff, latestHandoff, parseHandoffs } from "../lib/handoff.js";
import { validate } from "../lib/schemas.js";
import { blockedOrigin, commentsSinceRequeue, countTransitionsTo, TRANSITION_TO } from "../lib/retro/issue-comments.js";
import { transition } from "../lib/transition.js";
import { appendRunRecord, reviewEvidenceLine, parseReviewEvidence, runIdOfRunner } from "../lib/run-record.js";
import { parseHeartbeatComment } from "../lib/board.js";
import { syncRecords, hydrateRecord, readRecordsDetailed } from "../lib/records-branch.js";
import { trustWorkspace } from "./trust-workspace.js";
import { runMergeStage } from "../lib/merge-stage.js";
import { HARNESS_OPENS } from "../lib/protected-paths.js";
import { claimCountsLabel, evidenceFor, probeEvidenceDir, qaDirRel, touchesDataPaths } from "../lib/qa-evidence.js";

/** 스테이지 → 성공 시 목적 상태, 요구 handoff를 만드는 직전 스테이지 */
export const NEXT_OF = { triage: null /* disposition에 따라 */, plan: "factory:planned", implement: "factory:awaiting-review", review: null /* aggregate에 따라 */, merge: "factory:merged" };
export const ROLE_PREFIX = { plan: "plan-", review: "reviewer-" };
export const STAGES = ["triage", "plan", "implement", "review", "merge"];

/**
 * KTB-20 — 보조 라벨 `factory:harness`(§5.2.1: 하네스 성숙도 승격 이슈)와 그 이슈의 builder가 싣는
 * 변형 L2 설정. 도그푸딩 #15가 드러낸 것: 승격 이슈의 builder는 `.factory/harness.toml`·러너 설정을
 * 하나도 못 건드려 "승격 PR"에 승격이 들어가지 못했다(ci-settings.json의 `Edit/Write(.factory/**)` +
 * block-dangerous.sh). 스펙의 의도는 그 반대다 — **인프라 작업은 factory가 하고 사람이 diff를 머지한다**
 * (L1의 보호 경로 거부는 그대로다: 승격 PR은 여전히 needs-human → 사람 머지).
 * 변형은 implement 스테이지에만 걸린다: triage·plan·review는 쓰기 금지 스테이지고, merge는 스크립트
 * 전용이라 `claude -p`를 아예 부르지 않는다.
 */
export const CI_SETTINGS = ".factory/ci-settings.json";
export const CI_SETTINGS_HARNESS = ".factory/ci-settings-harness.json";
export const ciSettingsFile = (harnessIssue = false) => (harnessIssue ? CI_SETTINGS_HARNESS : CI_SETTINGS);

/**
 * `claude -p` 인자/환경을 한 곳에서 만든다(retro.js의 `retroClaudeArgs`와 같은 모양) — 훅이 읽는
 * `FACTORY_HARNESS_ISSUE`와 `--settings`가 **같은 판단**에서 나와야 둘이 갈라지지 않는다.
 */
/**
 * 디스패처 슬래시 커맨드에 실리는 프롬프트 한 줄. implement만 **두 번째 토큰**을 받는다
 * (ADR-020 KTB-23 fix, KTB-27로 배선 수정): `.claude/commands/factory-implement.md`는 `$ARGUMENTS`
 * 하나로 이 줄 전체("<issue> <harness_issue>")를 받아 `raw`로 워크플로에 넘기고, 워크플로가 공백으로
 * split해 `harness_issue`를 얻어 builder 프롬프트의 PROTECTED 목록과 규칙 8을 그 값으로 가른다
 * (KTB-27: Claude Code는 명령 md 안의 위치 인자 `$1`/`$2`를 치환하지 않는다 — `claude -p
 * "/argtest 42 true"`로 실측 확인; `$ARGUMENTS`만 온전히 치환된다). 훅(`FACTORY_HARNESS_ISSUE`)·
 * L2(`--settings`)와 **같은 판단**에서 나와야 셋이 갈라지지 않는다: 그때까지 프롬프트만 이 판단을 못
 * 받아서, 하네스 이슈의 builder가 자기가 열려 있는 파일을 "보호 경로"로 읽고 `harness_needed`를 채운
 * 뒤 멈췄다 — 하네스 이슈가 또 하네스 이슈를 부르는 사슬이다. 값은 항상 싣는다(`true`/`false`) —
 * 빠진 두 번째 토큰은 워크플로 쪽에서 `false`로 떨어진다.
 */
export const stagePrompt = ({ stage, issue, harnessIssue = false }) =>
  stage === "implement" ? `/factory-implement ${issue} ${harnessIssue ? "true" : "false"}` : `/factory-${stage} ${issue}`;

export function stageClaudeArgs({ root, stage, issue, harness, charter, harnessIssue = false }) {
  const args = ["-p", stagePrompt({ stage, issue, harnessIssue }), "--permission-mode", "dontAsk", "--max-turns", String(stageMaxTurns(harness, stage)), "--output-format", "json", "--settings", join(root, ciSettingsFile(harnessIssue))];
  if (charter?.budget?.usd_per_stage) args.push("--max-budget-usd", String(charter.budget.usd_per_stage));
  return args;
}

export function stageClaudeEnv({ root, stage, harnessIssue = false }) {
  // ADR-023 Task 8b — **이 세션은 스테이지의 세션이다**를 훅에게 말하는 한 글자. `block-dangerous.sh`가
  // 이것으로 브랜치 이동(`git checkout <ref>`·`git switch`)을 막는다: 브랜치 체크아웃은 이제 스테이지의
  // 일이고(§makeCheckoutBranch), 세션 안에서 브랜치가 바뀌면 디스크의 훅 스크립트·settings·CLAUDE.md가
  // PR의 것으로 갈린다(훅 스크립트는 **호출마다** 디스크에서 읽힌다 — overlay가 세션 도중 무효가 된다).
  // 사람의 자기 세션에는 이 변수가 없으므로 평범한 `git switch -`는 그대로 열려 있다. 세션이 스스로
  // 지울 수 없다: 훅은 Claude Code가 **세션 env**로 띄우는 프로세스라 명령줄의 `VAR= git …` 접두사가 닿지 않는다.
  const env = { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", CLAUDE_PROJECT_DIR: root, FACTORY_STAGE: stage || "1" };
  // 훅은 `claude -p` 세션의 자식 프로세스라 이 변수를 그대로 물려받는다 — block-dangerous.sh가 이것으로
  // 보호 경로 목록을 좁힌다. 값이 정확히 "1"일 때만 선다(훅 쪽 계약).
  if (harnessIssue) env.FACTORY_HARNESS_ISSUE = "1";
  return env;
}

/** 게이트 파일이 판정을 만드는 스테이지. 여기서 gates가 null이면 판정은 워크플로의 자기 신고뿐이다. */
const GATED_STAGES = new Set(["implement", "review", "merge"]);
export const GATES_SELF_REPORTED = "gates: self-reported by workflow (no gates.json from this run — unverified)";
/**
 * 최종 리뷰 A-SF1 — qa 증거 부족을 이 라운드의 판정으로 접을 때 쓰는 **합성 must_fix의 id**.
 * 고정 id인 이유: 같은 부족이 두 번 접히지 않고(dedupe), rework 응답에서 사람과 builder가 그 항목을
 * 이름으로 부를 수 있어야 한다.
 */
export const QA_SHORTFALL_ID = "qa-evidence";

/**
 * ADR-020 KTB-35 — RED인 판정 안에서 **자기 사유를 들고 있는** 첫 게이트의 그 사유(없으면 null).
 * `reason`은 `lib/gates.js`가 단 한 경우에만 단다: 테스트 명령이 exit≠0인데 읽어낸 리포트의 실패
 * 테스트가 0개 — 즉 깨진 테스트가 없는 RED다. RED가 아닌 판정에서는 보지 않는다(GREEN으로 뒤집힌
 * 게이트의 잔여 사유가 스테이지를 blocked으로 만들면 안 된다).
 */
export function unhandledGateReason(gates) {
  if (gates?.status !== "RED") return null;
  for (const g of Object.values(gates.gates || {})) if (g?.status === "RED" && g.reason) return g.reason;
  return null;
}

// MergeBaseError/isMergeBaseError/MERGE_BASE_BLOCKED_REASON/GIT_DIFF_BLOCKED_REASON now live in
// lib/blocked-errors.js (merge-stage.js needs them too) — re-exported here for existing importers.
export { MergeBaseError, MERGE_BASE_BLOCKED_REASON, MERGE_BASE_ERROR_CODE, isMergeBaseError, GIT_DIFF_BLOCKED_REASON };

/** 파일이 없으면 null(예외 아님) — `readTranscript`가 기대하는 주입 모양이다. */
export const readFileOrNull = (p) => { try { return existsSync(p) ? readFileSync(p, "utf8") : null; } catch { return null; } };
/** 이 런의 세션 트랜스크립트 전문. 없으면 빈 문자열 — 읽기 실패가 스테이지를 죽이지 않는다. */
const transcriptTextFor = (root, out) =>
  readTranscript({ root, home: homedir(), sessionId: out?.session_id, readFile: readFileOrNull }) || "";

/**
 * `claude -p --max-turns`의 기본값(KTB-16). 5였고, 그 5가 데모 #2의 plan 재실행을 죽였다 —
 * 백그라운드 `Workflow`를 쓰는 디스패처가 쓰는 턴은 최소 ① Workflow 호출 ② 접수증 수신
 * ③ 완료 알림 수신 ④ 산출물 출력이고, 알림의 `<result>`가 잘려 output 파일을 `Read`로 읽어야
 * 하면 조각 수만큼 더 붙는다. 6턴째에 잘려 30분과 $12.05가 산출물 없이 증발했다.
 * 12는 그 관측(조각 4개 + 여유)에서 나온 값이지 이론값이 아니다 — 그래서 하네스에서 조정된다.
 */
export const DEFAULT_MAX_TURNS = 12;

/**
 * 이 스테이지에 쓸 `--max-turns`. `[factory].max_turns`가 공통값이고
 * `[factory].max_turns_by_stage.<stage>`가 스테이지별로 이긴다 — review는 로스터 크기만큼
 * 알림이 오고 triage는 워크플로를 아예 안 쓰는 등, 턴 수요가 스테이지마다 다르기 때문이다.
 * 값이 정수가 아니면(오타·문자열) 기본값으로 떨어진다 — doctor가 그 오타를 FAIL로 잡는다.
 */
export function stageMaxTurns(harness, stage) {
  const f = harness?.factory || {};
  for (const v of [f.max_turns_by_stage?.[stage], f.max_turns]) {
    if (Number.isInteger(v) && v >= 1) return v;
  }
  return DEFAULT_MAX_TURNS;
}

/**
 * claude -p 결과를 런 레코드 한 줄로. 무엇을 얼마나 태웠는지는 사후 감사의 1차 증거다.
 *
 * `progress`(ADR-022)를 주면 **둘째 줄로** 이번 런의 마지막 `progress:v1` 마커가 따라붙는다 —
 * 봉투의 `usage`는 런 전체의 합계만 말하고 "그 $12 중 어느 리뷰어가 얼마를 썼는지"는 말하지
 * 않는다. 그 분해가 남아야 로스터를 손볼 때 근거가 생긴다. 하트비트 코멘트와 **같은 마커**를
 * 쓰므로 뷰어(Task B)는 살아 있는 런과 끝난 런을 정규식 하나로 읽는다.
 */
export function usageLine(out, progress = null) {
  const models = Object.entries(out?.modelUsage || {})
    .map(([m, u]) => `${m}=$${u?.costUSD ?? "n/a"}`).join(", ");
  const line = `usage: ${JSON.stringify(out?.usage || {})} cost_usd: ${out?.total_cost_usd ?? "n/a"}`
    + ` num_turns: ${out?.num_turns ?? "n/a"} terminal_reason: ${out?.terminal_reason ?? "n/a"}`
    + ` models: ${models || "n/a"}`;
  return progress ? `${line}\n${progressMarker(progress)}` : line;
}

export async function runStage({ stage, issue, deps, runnerId = "unknown", runId = process.env.GITHUB_RUN_ID || runIdOfRunner(runnerId) }) {
  const d = deps;
  if (!(await d.charterReady())) { console.error("factory: CHARTER not ready or doctor failing — dormant"); return 0; }
  /** 거부된 전이는 절대 조용히 넘기지 않는다 — 런 레코드 한 줄로 남긴다. */
  const refusal = (t) => (t.ok ? [] : [`transition refused: ${t.reason}`]);
  const record = (lines) => { try { d.runRecord(lines); } catch (e) { console.error(`factory: run record write failed — ${e.message}`); } };
  /**
   * 체크 상태 게시는 부수 효과다 — 실패해도 런을 죽이지 않는다. sha가 없으면 애초에 게시할 대상이
   * 없으므로(어느 커밋 얘기인지 모름) 건너뛰고 흔적만 남긴다.
   */
  const postStatus = async ({ context, state, description, sha }) => {
    if (!d.reportStatus) return;
    if (!sha) { record([`status: ${context} skipped — no sha`]); return; }
    try { await d.reportStatus({ context, state, description, sha }); }
    catch (e) { record([`status: ${context} post failed — ${e?.message || e}`]); }
  };
  // fresh checkout이면 로컬에 이슈의 run 기록이 없다 — 이 스테이지가 **무엇이든 기록하기 전에**
  // factory/records 브랜치의 누적 내용을 먼저 복원한다(ADR-014 보강). 그래서 charterReady 직후,
  // back-pressure·claim·localEntry보다도 앞이다: 그 세 지점 모두 자기 몫의 record() 줄을 남기고
  // 물러날 수 있는데, 하이드레이트가 그보다 늦으면 그 줄들이 "한 줄짜리 새 파일"에 쓰여 브랜치에
  // 쌓여 있던 이전 스테이지 기록을 덮어쓸 뻔한 내용이 된다(syncRecords가 뒤에서 막지만, 그때는
  // 이번 줄이 버려진다). best-effort — 실패해도 흔적만 남기고 스테이지는 계속된다.
  try {
    const h = await d.hydrateRecord?.();
    if (h && !h.ok) record([`hydrate: ${h.reason || "failed"}`]);
  } catch (e) { record([`hydrate: aborted — ${e?.message || e}`]); }
  // 공장이 감당할 수 있는 만큼만 물린다. 거부는 실패가 아니다 — 라벨을 건드리지 않고 물러나
  // 다음 sweeper/이벤트에서 다시 시도한다. 그래서 락을 잡기도 전에 본다.
  if (stage === "implement" && d.backPressure) {
    try {
      const bp = await d.backPressure();
      if (!bp.ok) { console.error(`factory: back-pressure — ${bp.reasons.join("; ")}`); record([`back-pressure: refused — ${bp.reasons.join("; ")}`]); return 0; }
    } catch (e) {
      // 흐름 제어를 못 읽은 것이지 안전 게이트가 깨진 게 아니다 — 흔적을 남기고 진행한다.
      record([`back-pressure: check failed — ${e?.message || e}`]);
    }
  }
  // merge는 workspace를 신뢰 등록할 필요가 없다 — claude -p를 전혀 부르지 않는다(스크립트 전용).
  if (stage !== "merge") await d.trustWorkspace();
  /**
   * ADR-020 KTB-28 — **거부된 claim은 시끄럽다.** 예전에는 stderr 한 줄을 남기고 `exit 0`으로 물러났다:
   * run 기록도, 이슈 코멘트도, 잡 실패도 없었다. 데모 #15가 그 침묵 위에서 돌았다 — 04:39에 타임아웃으로
   * 죽은 review 런(정리 스텝 이전 배포본)의 `lock-15`가 고아로 남았고, 그 뒤의 모든 dispatch(sweeper
   * stalled ×4 + 수동)가 26~40초 만에 여기서 죽었는데 잡 결론은 전부 `success`였다. 바깥에서 보면
   * "디스패치가 잘 됐다"였고, 그래서 같은 벽에 네 번을 더 밀었다.
   *
   * 이제 셋을 한다: 누가 쥐고 있고 그 러너가 어떤 상태인지 run 기록 한 줄, 같은 내용의 짧은 이슈
   * 코멘트(사람이 이슈만 보고도 안다), 그리고 `exit 2` — 잡을 **실패로** 끝내 Actions 목록에서 빨갛게
   * 보이게 한다. 정말 남이 돌고 있는 정상적인 경쟁도 여기로 오지만(그때는 이 런이 없어지는 게 맞다),
   * 그 사실이 기록되는 편이 침묵보다 낫다. 락이 잔해였다면 `claim()`이 이미 회수했다(KTB-28 (a)).
   */
  const c = await d.claim();
  if (!c.ok) {
    const holder = c.runner || c.holder || "unknown";
    // r2 nit 7 — `c.status`는 원격 에러 문구를 그대로 실을 수 있다(`claim.js`의 `unreachable (<메시지>)`).
    // 그것이 닿는 곳은 run 기록만이 아니라 **공개 이슈 코멘트**다 — durable artifact 중 가장 공개적인
    // 자리이므로, r1 nit 8이 기록에 건 것과 같은 절단을 여기에도 건다(URL은 `<url>`로, 한 줄 120자).
    const status = truncateReason(c.status) || "unknown";
    const line = `claim refused: lock held by ${holder} (${status})`;
    console.error(`factory: issue #${issue} — ${line}`);
    record([line]);
    try {
      await d.comment?.(issue, `<!-- factory-claim-refused issue=${issue} stage=${stage} -->\n\`${stage}\` 스테이지가 락을 잡지 못했습니다 — ${holder}가 쥐고 있습니다(상태: ${status}). 그 러너가 이미 끝났다면 락은 잔해이고, 다음 sweep이 회수합니다(ADR-020 KTB-28).`);
    } catch (e) { record([`claim refused: comment failed — ${e?.message || e}`]); }
    return 2;
  }
  // 잔해 락을 회수하고 들어왔다면 그 사실이 기록의 1차 증거다 — 다음 조사가 이 줄로 grep한다.
  if (c.reclaimed) record([`lock: reclaimed from completed runner ${c.reclaimed.runner}`]);
  let hb = null;                                                      // 락을 잡은 뒤의 모든 실패는 finally를 거쳐야 한다
  let overlaidPaths = [];                                             // KTB-37 — 이 런의 overlay가 덮은 정확한 경로들(쓰기 금지 스테이지의 클린 체크 허용 목록)
  let stageBranchName = null;                                         // Task 8b — implement가 스테이지 스스로 체크아웃한 브랜치(세션 뒤 같은 자리인지 다시 묻는다)
  let driftRefusal = null;                                            // KTB-43 — 핸드오프 뒤의 커밋이 드리프트 경로 밖이었다(핸드오프를 쓴 뒤에 거부한다)
  let checkoutSha = null;                                             // review/merge가 실제로 게이트를 돌린 PR head — review는 아래에서 런 레코드 마지막 줄에, merge는 runMergeStage로 그대로 넘겨 기록한다
  try {
    // 로컬 진입(§4.2.5): backlog 이슈를 사람이 손으로 큐에 넣기 전에 로컬에서 먼저 락을 잡았을 때,
    // triage 스테이지가 스스로 backlog → factory:queue로 밀어 넣는다 — claim 직후(라벨 이동일 뿐
    // 기록과는 무관하다. 기록 하이드레이트는 이미 charterReady 직후에 끝났다).
    // best-effort — 실패해도 흔적만 남기고 스테이지는 계속된다.
    /**
     * 외부 감사 2026-09-14 M13 — **중복 실행.** 락은 *동시* 러너만 막는다(끝난 런의 락은 이미
     * 풀려 있다). concurrency 슬롯에서 풀려난 PENDING 런이나 sweeper의 재점화가 **같은 head**로
     * 같은 스테이지를 처음부터 다시 도는 경로가 그래서 열려 있었다: 라벨 가드는 라벨이 아직
     * 진입 상태로 남아 있을 때(전이가 실패했거나 review가 같은 라벨로 돌아올 때) 통과시키고,
     * 그 뒤는 전부 다시 돈다 — 같은 handoff가 두 번, 비용도 두 번.
     *
     * 판정 재료는 하나다: **마지막 재큐 이후, 이 스테이지의 handoff 중 head sha가 같은 것**이
     * 이미 있는가. 있으면 이 런이 할 일은 없다 — 전이도 코멘트도 claude -p도 없이 exit 0이다
     * (락은 finally가 놓는다). 조회가 실패하면 막지 않는다: 그건 중복 판정을 못 한 것일 뿐이고,
     * 진입 상태 가드와 전이 그래프는 그대로 남아 있다.
     */
    try {
      const dup = await d.duplicateRun?.();
      if (dup) {
        record([`duplicate-run: skipped — ${stage} already completed for head ${String(dup.head || "").slice(0, 12)} (handoff ${dup.at || "n/a"})`]);
        console.error(`factory: issue #${issue} — duplicate-run: skipped (${stage} already completed for this head)`);
        return 0;
      }
    } catch (e) { record([`duplicate-run: check failed — ${e?.message || e}`]); }
    try {
      const localMsg = await d.localEntry?.();
      if (localMsg) record([localMsg]);
    } catch (e) { record([`local entry: aborted — ${e?.message || e}`]); }
    // 진입 상태 가드(KTB-10). concurrency 그룹 하나당 GitHub은 **실행 1 + 대기 1**만 유지하므로,
    // sweeper의 재점화나 `--remote` dispatch가 같은 그룹에 PENDING으로 걸렸다가 **원래 런이 끝난 뒤에**
    // 풀려 같은 스테이지를 처음부터 다시 돌 수 있다. 그때 락은 이미 해제돼 있어 claim이 막지 못한다
    // (claim은 *동시* 러너만 막는다). 전이 그래프는 결국 거부하지만, 그건 plan 한 번에 ~$12를 태우고
    // handoff 코멘트를 중복으로 남긴 **뒤**다. 그래서 락을 잡은 직후 이슈의 현재 상태 라벨을 읽어
    // 이 스테이지의 진입 라벨이 아니면 아무것도 하지 않고 물러난다(전이 없음, handoff 없음, claude -p 없음).
    // localEntry **뒤**인 이유: 로컬 진입(§4.2.5)이 backlog → factory:queue를 바로 위에서 만든다.
    //
    // 외부 감사 2026-09-14 M13 — **라벨을 못 읽으면 멈춘다**(예전 규칙은 "막지 않고 흔적만"이었다).
    // 조회가 실패한 런은 자기가 어떤 상태에서 출발했는지 모르는 채로 claude -p를 띄우고, 뒤의 전이
    // 그래프는 "지금 라벨"만 볼 뿐 "돌기 전에 무엇이었는가"를 복원해 주지 않는다 — 곧 이미 끝난
    // 스테이지의 재점화가 조회 장애 한 번으로 통과했다(중복 handoff, plan 한 번 ~$12). 등급은
    // `factory:blocked` cause `api-error`(KTB-22와 같은 자리): 자격증명이 아니라 일시 장애이므로
    // sweeper의 blocked-origin 재시도가 그대로 다시 집는다. **읽은 라벨 자체가 무효**
    // (상태 라벨 2개 이상 — 사람이 손으로 `factory:approved` 같은 라벨을 backlog 위에 덧붙였을 때
    // 등)이면 얘기가 다르다(KTB-18): 예전에는 이 자리에서도 조용히 넘어갔고, 그러면 나중에
    // `d.transition`(내부의 `factoryLabelOf`)이 똑같은 이유로 **잡히지 않은 예외**를 던져 스테이지가
    // "aborted"로 죽었다 — 코멘트도, 전이도 없이. 상태가 모호하면 전이는 하지 않는 게 맞지만(어느
    // 라벨이 "진짜"인지 판단할 근거가 없다), 그 사실만은 사람에게 말해야 한다: 어떤 라벨들이 붙어
    // 있는지, 팩토리가 왜 이 스테이지를 실행하지 않는지, sweeper가 다음 sweep에서 정리한다는 것.
    let entryLabel;
    // KTB-20: 같은 라벨 조회에서 `factory:harness`도 읽는다 — implement 스테이지만, 그리고 라벨을
    // 실제로 읽었을 때만 선다(조회 실패 → false → 평범한 이슈로 취급: 더 좁은 쪽이 기본값이다).
    let harnessIssue = false;
    if (d.issueLabels) {
      const expected = ENTRY_LABELS[stage] || [];
      let labels = null;
      let lookupError = null;
      try { labels = await d.issueLabels(); }
      catch (e) { lookupError = e?.message || String(e); }
      // 감사 M13 — 던졌든(lookupError) 아무것도 안 돌려줬든(null/undefined/배열 아님) 결과는 같다:
      // 진입 상태를 확인하지 못했다. 라벨이 **없는** 이슈(빈 배열)는 이 경우가 아니다 — 그건 읽은
      // 사실이고, 아래 `expected`가 "할 일 없음"으로 정상 처리한다.
      if (lookupError || !Array.isArray(labels)) {
        const why = lookupError || `label lookup returned ${labels === null ? "null" : typeof labels}`;
        record([`entry state: unreadable — ${why}`]);
        const t = await d.transition({ to: "factory:blocked", reason: `entry state unreadable — ${why} (cannot confirm this stage has not already run)`, cause: "api-error" });
        console.error(`factory: stage ${stage} aborted — entry state unreadable: ${why}`);
        record([...refusal(t)]);
        return 2;
      }
      if (labels) {
        const found = labels.filter((l) => STATES.has(l));
        if (found.length > 1) {
          const marker = `<!-- factory-label-set-invalid labels=${found.join(",")} -->`;
          try {
            await d.comment?.(issue, `${marker}\n이 이슈에 factory 상태 라벨이 ${found.length}개(${found.join(", ")}) 붙어 있어 어느 상태인지 판단할 수 없습니다 — factory는 이 스테이지를 실행하지 않습니다. 다음 sweep에서 sweeper가 라벨을 \`factory:needs-human\`으로 정리합니다.`);
          } catch (e) { record([`label-set-invalid: comment failed — ${e?.message || e}`]); }
          console.error(`factory: stage ${stage} refused — issue must carry exactly one factory state label, found: ${found.join(", ")}`);
          record([`entry state: invalid — more than one factory state label: ${found.join(", ")}`]);
          return 1;
        }
        entryLabel = found[0];
        harnessIssue = stage === "implement" && labels.includes(HARNESS_LABEL);
        if (expected.length && !expected.includes(entryLabel)) {
          record([`entry state ${entryLabel ?? "none"} != expected ${expected.join("|")} — nothing to do`]);
          return 0;
        }
      }
    }
    // KTB-15b I2: 네 스테이지의 진입 라벨에 factory:blocked이 추가됐다(ENTRY_LABELS) — 하지만
    // 재시도할 것이 있는 건 그 blocked이 **그 스테이지 자신의 정상 진입 라벨에서** 왔을 때뿐이다
    // (BLOCKED_RETRY). `transition.js`가 blocked으로 갈 때 남긴 `factory-blocked-origin` 마커가
    // 유일한 출처다 — 다른 곳(예: implement가 아직 안 끝났는데 in-progress에서 온 blocked을
    // triage가 재시도하려는 경우)에서 온 blocked은 조용히 그래프를 속이지 않고, 전이 없이 거부한다
    // (사람은 여전히 sweeper의 needs-human 에스컬레이션으로 이 이슈를 보게 된다).
    //
    // merge만 예외다: origin이 확인돼도 여기서 라벨을 바로 되돌리지 않는다 — merge-stage.js가
    // 게이트를 이번 런에서 다시 GREEN으로 확인한 **뒤에야**(retryFromBlocked) approved로 되돌린다.
    // 다른 세 스테이지는 라벨을 되돌리는 것 자체가 "재시도한다"는 선언이라, 확인 즉시 되돌리고
    // 나머지 로직을 그 라벨에서 정상적으로 이어간다.
    const retryCfg = BLOCKED_RETRY[stage];
    let blockedOriginFrom = false;          // merge only (KTB-19 review I-2): the origin label itself, not just a boolean
    if (retryCfg && entryLabel === "factory:blocked") {
      const origin = await d.blockedOrigin?.();
      if (!origin || !retryCfg.origins.includes(origin.from)) {
        const short = (l) => (l ? l.replace(/^factory:/, "") : "unknown");
        record([`${stage}: blocked did not originate from ${retryCfg.origins.map(short).join("|")} — nothing to retry (origin=${short(origin?.from)})`]);
        return 2;
      }
      if (stage !== "merge") {
        // hop은 **이미 얻었던 라벨의 복구**이지 새 성취의 주장이 아니다 — 그래서 `prerequisite: true`로
        // 건다(ADR-020 KTB-24 fix). review의 hop(`factory:awaiting-review`)이 이것을 필요로 한다:
        // 그 목적 상태의 요구조건은 "이번 런의 GREEN 게이트 파일 + PR head 일치"인데, 여기는 런의
        // 맨 앞이라 게이트 파일이 아직 없고(resetGates 직전이며 fresh checkout이다) 그대로 걸면 hop이
        // 거부돼 이슈가 곧장 needs-human으로 밀린다 — 재시도 자체가 성립하지 않는다. 안전은 그대로다:
        // 이 hop은 blocked-origin 마커가 그 라벨을 증언할 때만 도달하고(그 마커는 **성공한** 전이가
        // 남긴다 — 즉 그때 요구조건을 이미 통과했다), 이번 런의 판정은 스테이지가 다시 돌며 만든다.
        const t = await d.transition({ to: retryCfg.hop, reason: `retry from blocked — origin ${origin.from} confirmed`, prerequisite: true });
        if (!t.ok) { record([`${stage}: blocked retry hop refused`, ...refusal(t)]); return 2; }
        record([`${stage}: blocked retry — hopped back to ${t.to}`]);
        entryLabel = t.to;
      } else {
        blockedOriginFrom = origin.from;
      }
    }
    /**
     * ADR-020 KTB-39 — **`[runtime].setup`이 이미 더럽힌 트리의 스냅샷.** setup은 run-stage보다 먼저,
     * 같은 잡의 자기 스텝에서 돈다(`.factory/actions/setup` → `bin/setup-env.js`) — `flutter pub get`
     * 류는 그때 추적 파일을 다시 쓴다. 여기가 그 사실을 찍는 유일한 자리다: 스테이지가 트리를 아직
     * 아무것도 건드리지 않은 시점(resetGates·브랜치 체크아웃·overlay **이전**)이라, 이 목록에 담기는
     * 것은 setup이 남긴 것뿐이다. 실패해도 스테이지는 계속된다 — 기준선이 없으면 아무 경로도
     * 면제되지 않는다(예전 동작 그대로, 더 엄격한 쪽).
     */
    let setupDirty = null;
    if (d.setupBaseline) {
      const snap = await d.setupBaseline();
      if (!snap?.ok) record([`setup baseline: unavailable — ${snap?.reason || "unknown"} (no path is exempt from the clean check)`]);
      else {
        setupDirty = snap;
        if (snap.entries?.length) record([setupDirtyLine(snap.entries)]);
        if (snap.statReason) record([`setup baseline: diff fingerprint unavailable — ${snap.statReason} (baseline paths compared by status only)`]);
      }
    }
    /**
     * KTB-39 — implement만은 **면제가 아니라 복원**이다: 빌더는 `git add -A`로 커밋하므로 setup이
     * 남긴 diff가 그대로 PR에 실린다. 브랜치 체크아웃보다도 먼저 하는 이유가 둘 있다 — ①
     * `git checkout -B <branch> origin/<branch>`는 충돌하는 로컬 수정이 있으면 거부한다(그 실패는
     * `factory:blocked`이었다), ② overlay는 트리가 팩토리 소유 경로를 base와 다르게 들고 있으면
     * implement의 빌더를 아예 띄우지 않는데(KTB-37), setup이 그 경로를 건드린 하네스에서는 그 판정이
     * 에이전트와 무관한 이유로 서게 된다. 복원 실패는 멈춤이 아니다(판정 불가가 아니라 커밋이
     * 지저분해지는 문제다) — 기록에 남기고 계속한다.
     */
    if (stage === "implement" && setupDirty?.entries?.length && d.restoreSetupDirty) {
      record([setupRestoreLine(await d.restoreSetupDirty(setupDirty))]);
    }
    await d.resetGates?.();                                           // 지난 런의 판정 파일이 이번 런의 전이를 대신하지 못하게 — in-progress 전이보다 먼저
    hb = await d.heartbeat();
    const a = await d.assertHandoff();
    if (!a.ok) { record([`assert: FAIL — ${a.reason}`]); return 2; }   // assertHandoff가 needs-human 전이와 코멘트를 이미 했다
    // review·merge는 implement handoff에 적힌 PR head에 게이트를 묶는다 — 그 사이 PR에 새 커밋이
    // 얹혀도(force-push, 추가 커밋) 검증하지 않은 코드를 검증한 것으로 착각하지 않도록 detach해서 고정한다.
    if ((stage === "review" || stage === "merge") && d.checkoutHead) {
      const co = await d.checkoutHead();
      if (!co.ok) {
        const t = await d.transition({ to: "factory:needs-human", reason: co.reason });
        record([`checkout: FAIL — ${co.reason}`, ...refusal(t)]);
        return 2;
      }
      checkoutSha = co.sha;
    }
    // ADR-023 Task 8b — implement의 브랜치 체크아웃은 **스테이지의 일이다**. 예전에는 빌더가 세션 안에서
    // 자기 브랜치를 체크아웃했고, 그 순간 디스크의 훅 스크립트·settings·CLAUDE.md가 PR의 것으로 갈렸다
    // (훅 스크립트는 호출마다 디스크에서 읽힌다 — overlay가 세션 도중 무효가 된다). 순서가 곧 수정이다:
    // 브랜치 체크아웃 → overlay(+drift) → 빌더. 실패는 진행이 아니라 정지다(원인은 대개 러너 쪽이다).
    if (stage === "implement" && d.checkoutBranch) {
      const cb = await d.checkoutBranch();
      if (!cb.ok) {
        // KTB-38 — 충돌한 머지는 "체크아웃 실패"가 아니라 **판정 불가**다: 트리는 abort로 되돌아갔고,
        // 사람이 리베이스해야 이 브랜치가 다시 돌 수 있다. cause를 명시해 sweeper의 재시도 등급이
        // 러너 장애(api-error)와 섞이지 않게 한다.
        const reason = cb.undecidable ? cb.reason : `branch checkout failed — ${cb.reason}`;
        const t = await d.transition({ to: "factory:blocked", reason, ...(cb.undecidable ? { cause: "undecidable" } : {}) });
        record([`branch: FAIL — ${cb.reason}`, ...refusal(t)]);
        return 2;
      }
      stageBranchName = cb.branch;
      record([branchLine(cb), ...(cb.merged ? [baseMergedLine(cb)] : [])]);
    }
    // KTB-37 — 체크아웃이 끝난 트리 위에 **팩토리 소유 설정만** 스테이지 자신의 커밋에서 덮는다
    // (§makeFactoryOverlay). review·merge는 방금 detach된 PR head 위에서, implement는 빌더가 돌기
    // 전에 한다. 실패는 진행이 아니라 정지다 — PR head의 훅·settings·리뷰어 프롬프트로 도는 스테이지는
    // 자기 자신을 검증하는 스테이지이고, 그건 검증이 아니다.
    if (OVERLAY_STAGES.has(stage) && d.overlayFactoryConfig) {
      // harness 이슈의 implement만 `HARNESS_OPENS`를 브랜치에 남긴다(§overlayPathspecs) — 그 이슈가
      // 하려는 일이 바로 그 파일들의 편집이고, `harnessIssue`는 implement에서만 선다(§316행).
      const ov = await d.overlayFactoryConfig(harnessIssue);
      if (!ov.ok) {
        // 판정 불가다(GREEN도 RED도 아니다) — 이 저장소의 그 자리는 언제나 factory:blocked이고,
        // 원인은 대개 러너 쪽이라 재시도로 풀린다.
        const t = await d.transition({ to: "factory:blocked", reason: `factory config overlay failed — ${ov.reason}` });
        record([`overlay: FAIL — ${ov.reason}`, ...refusal(t)]);
        return 2;
      }
      overlaidPaths = ov.paths || [];
      // implement는 **유일한 쓰기 스테이지**다: 여기서 overlay가 실제로 파일을 바꿨다는 것은 이 트리가
      // 팩토리 소유 경로를 base와 다르게 들고 있다는 뜻이고, 그 위에서 빌더가 `git add -A`로 커밋하면
      // overlay의 되돌림이 PR에 실려 나간다(= PR 자신의 변경이 말없이 사라진다). 그래서 덮을 것이 있으면
      // **빌더를 띄우지 않는다** — implement의 커밋이 팩토리 설정을 담을 수 있는 경로 자체가 사라진다.
      // Task 8b 이후 이 자리의 원인이 하나 늘었다: 스테이지가 체크아웃한 `claude/fq-<issue>` 브랜치가
      // 팩토리 소유 경로를 고쳐 들고 있는 경우다(예: `.claude/**`를 건드린 PR의 rework 라운드).
      // 그런 PR은 어차피 사람이 머지한다(`[protected]`) — 그 라운드도 사람에게 넘긴다. 세션을 PR의
      // 설정으로 돌리는 것과 PR의 작업을 말없이 되돌리는 것 중 어느 쪽도 스테이지가 고를 일이 아니다.
      if (stage === "implement" && overlaidPaths.length) {
        const reason = `the implement tree carries factory-owned paths that differ from the stage's own commit (${ov.sha.slice(0, 7)}) — the overlay would change ${overlaidPaths.length} path(s): ${overlaidPaths.slice(0, 10).join(", ")}`;
        const t = await d.transition({ to: "factory:blocked", reason });
        record([`overlay: FAIL — ${reason}`, ...refusal(t)]);
        return 2;
      }
      record([overlayLine(ov)]);
    }
    /**
     * ADR-024 / KTB-42 — **증거 디렉터리에 쓸 수 있는지는 리뷰 전에 묻는다.** 자리는 여기다:
     * overlay가 끝난 **직후**(디스크의 훅·settings가 이제 팩토리의 것이다)이고 `claude -p`보다 **앞**이다.
     * KTB #3에서는 이 확인이 없어서 "qa가 한 글자도 쓸 수 없다"가 리뷰가 끝난 뒤에야, 그것도
     * `spec1: qa evidence missing`이라는 **빌더를 가리키는 문장**으로 드러났다. 여덟 라운드가 그렇게 갔다.
     *
     * 실패는 리뷰의 reject가 **아니다** — GREEN도 RED도 아닌 판정 불가이고, 이 저장소에서 그 자리는
     * 언제나 `factory:blocked` + cause `undecidable`이다(sweeper의 재시도 등급도 그래야 맞다).
     */
    if (stage === "review" && d.qaEvidenceProbe) {
      const p = await d.qaEvidenceProbe();
      if (!p.ok) {
        const reason = `qa evidence dir not writable: ${p.reason}`;
        const t = await d.transition({ to: "factory:blocked", reason, cause: "undecidable" });
        record([`qa evidence probe: FAIL — ${p.reason}`, ...refusal(t)]);
        return 2;
      }
      if (p.line) record([p.line]);
    }
    // merge는 script-only다 — claudeP/buildContext/verifyStage/writeHandoff을 전혀 거치지 않고
    // PR head에서 곧장 머지 여부를 판단한다(§runMergeStage). checkoutSha를 그대로 넘겨 무엇을
    // 머지했는지 런 레코드에 남긴다. 여기서 끝낸다.
    if (stage === "merge") return await runMergeStage({ issue, defaultBranch: d.defaultBranch, headSha: checkoutSha, d, record, refusal, postStatus, retryFromBlocked: entryLabel === "factory:blocked" ? blockedOriginFrom : false });
    if (stage === "implement") {                                      // planned → in-progress: 작업 시작을 라벨로 알린다
      const ip = await d.transition({ to: "factory:in-progress", reason: `claimed by ${runnerId}` });
      if (!ip.ok) { record(refusal(ip)); return 2; }
    }
    // L2를 실을 파일이 없는 채로 에이전트를 띄우지 않는다(ADR-019). `claude -p --settings`가 가리키는
    // `.factory/ci-settings.json`이 없으면 경로 deny가 통째로 빠진 세션이 돌고, 그 세션은 harness.toml·
    // 게이트 설정을 고칠 수 있다 — "확인되지 않은 강제"는 강제가 아니므로 fail closed로 멈춘다.
    // merge는 여기까지 오지 않는다(script-only, 위에서 return).
    // KTB-20: `factory:harness` 이슈면 그 자리에 변형 파일이 온다 — 없으면 "그냥 좁은 쪽으로 돌자"가
    // 아니라 여기서 멈춘다. 조용히 fallback하면 도그푸딩 #15가 그대로 재현된다(승격 없는 승격 PR).
    const settingsFile = ciSettingsFile(harnessIssue);
    if (d.ciSettingsPresent && !(await d.ciSettingsPresent(harnessIssue))) {
      const reason = `${settingsFile} missing — the agent would run without the L2 path deny list; run \`npx know-thy-build factory init --upgrade\``;
      const t = await d.transition({ to: "factory:needs-human", reason });
      record([`ci-settings: FAIL — ${reason}`, ...refusal(t)]);
      return 2;
    }
    if (harnessIssue) record([`harness issue: builder runs with ${settingsFile} + FACTORY_HARNESS_ISSUE=1 (test-infra files writable; merge still needs a human)`]);
    // KTB-43 — 기준선(1.5)은 컨텍스트에도 실린다: 빌더 프롬프트의 "커밋하지 말 것" 목록이 그것이다.
    const ctx = await d.buildContext({ setupDirty });
    await d.resetAgentsLog?.();                                       // 지난 런의 agents.jsonl이 로스터 체크를 대신 만족시키지 못하게
    const out = await d.claudeP(ctx, { harnessIssue });
    // 마지막 진행 스냅샷은 claude가 끝난 **직후**에 찍는다 — 그때 트랜스크립트는 완성돼 있고
    // 하트비트는 아직 살아 있다. 실패해도 usage 줄은 그대로 나간다(관측이 기록을 막지 않는다).
    let finalProgress = null;
    try { finalProgress = d.progress?.() ?? null; } catch { /* best-effort */ }
    const usage = usageLine(out, finalProgress);
    // ADR-023 Task 8b — implement의 구조적 백스톱. 쓰기 스테이지라 클린 체크는 할 수 없지만(빌더가
    // 파일을 쓰는 것이 이 스테이지의 일이다) **두 가지**는 세션 뒤에도 참이어야 한다: HEAD가 아직
    // 스테이지가 체크아웃한 브랜치이고, 팩토리 소유 경로가 아직 스테이지 커밋의 바이트라는 것.
    // 어느 쪽이든 아니면 그 세션이 어떤 설정으로 무엇을 판단했는지 알 수 없다 = 판정 불가 =
    // `factory:blocked`(GREEN도 RED도 아니다). 산출물은 받지 않는다 — gates도 verify도 부르지 않는다.
    if (stage === "implement" && stageBranchName && d.assertStageBranch) {
      const b = await d.assertStageBranch(harnessIssue);
      if (!b.ok) {
        const reason = `undecidable — ${b.reason}`;
        const t = await d.transition({ to: "factory:blocked", reason });
        record([`branch: FAIL — ${b.reason}`, ...refusal(t), usage]);
        return 2;
      }
    }
    /**
     * ADR-020 KTB-43 — **핸드오프 뒤에 붙은 드리프트 커밋은 스테이지가 떨어뜨린다**(§makeDropPostHandoffDrift).
     * 게이트보다 **먼저**다: `gates.json`의 `head_sha`는 게이트가 돈 시점의 HEAD이고 전이 요구조건이
     * 그 값을 브랜치 head와 다시 묶으므로(`requirements.gatesGate`), 게이트 뒤에 되돌리면 한 거부를
     * 다른 거부로 바꿀 뿐이다. 거부는 여기서 곧장 내지 않는다 — 핸드오프를 쓴 **뒤에** 낸다(아래
     * §driftRefusal): 사람이 받는 이슈에는 이 라운드가 무엇을 했는지가 남아 있어야 한다.
     */
    if (stage === "implement" && stageBranchName && d.dropPostHandoffDrift) {
      const handoffSha = (await d.handoffHeadSha?.(out)) ?? null;
      const drift = await d.dropPostHandoffDrift({ handoffSha, baseline: setupDirty });
      if (!drift.ok) {
        driftRefusal = drift.reason;
        record([`drift: REFUSED — ${drift.reason}`]);
      } else if (drift.dropped?.length) {
        record([driftDroppedLine(drift)]);
        try {
          await d.comment?.(issue, `${driftDroppedMarker(drift)}\n빌더가 핸드오프(\`${drift.to.slice(0, 7)}\`)를 쓴 뒤에 붙인 커밋 ${drift.dropped.length}개는 setup/테스트가 다시 만드는 파일만 담고 있어 스테이지가 되돌렸습니다(${drift.files.length}개 파일). 브랜치는 다시 \`${drift.to.slice(0, 7)}\`입니다 — ADR-020 KTB-43.`);
        } catch (e) { record([`drift: comment failed — ${e?.message || e}`]); }
      }
    }
    // 쓰기 금지 스테이지(triage/plan/review)는 claude -p가 끝나자마자, 게이트·verify보다 먼저 워크트리를
    // 다시 묻는다(ADR-020 KTB-14). implement(유일한 쓰기 스테이지)는 건너뛴다 — merge는 여기 오지도
    // 않는다(위에서 이미 return). 훅이 놓친 모양으로 어떻게 건드렸든, 스크래치 경로(`.factory/out/**`·
    // `docs/factory/runs/**`) 밖의 diff가 하나라도 있으면 그 산출물은 애초에 받아들이지 않는다 —
    // verifyStage조차 부르지 않는다.
    if (isNoWriteStage(stage)) {
      // KTB-37 — overlay가 덮은 경로는 팩토리가 만든 diff다(에이전트가 아니라). 그 목록만 허용한다.
      // KTB-39 — 허용 목록은 둘이다: overlay가 덮은 경로(`overlaidPaths`, 팩토리가 만든 diff)와
      // 스테이지가 시작할 때 이미 있던 diff(`setupDirty`, `[runtime].setup`이 만든 것). 어느 쪽도
      // 에이전트가 쓴 것이 아니다 — 그리고 둘 다 "그때 그 모양 그대로일 때만" 면제다.
      const clean = d.assertCleanWorktree ? await d.assertCleanWorktree(overlaidPaths, setupDirty) : { ok: true };
      if (!clean.ok) {
        // 두 실패는 등급이 다르다(KTB-14 r1). **더러운 트리**는 사람이 볼 것이 있다 — 어떤 파일이
        // 어떻게 바뀌었는지 보고 판단해야 하므로 needs-human이다. **`git status` 자체가 실패한 것**은
        // GREEN도 RED도 아닌 **판정 불가**이고, 이 저장소에서 판정 불가의 자리는 언제나
        // `factory:blocked`다(merge-stage의 `undecidable()`, 게이트 BLOCKED과 같은 계약) — 사람이
        // 판단할 재료가 아직 없고, 원인은 대개 러너 쪽이라 재시도로 풀릴 수 있다. 어느 쪽이든
        // 산출물은 받지 않는다(verifyStage조차 부르지 않는다).
        const dirty = Boolean(clean.dirty?.length);
        const reason = dirty
          ? `worktree dirty after ${stage} (no-write stage): ${clean.dirty.join(", ")}`
          : `worktree check failed after ${stage} (no-write stage): ${clean.reason || "unknown"}`;
        const t = await d.transition({ to: dirty ? "factory:needs-human" : "factory:blocked", reason });
        record([`worktree: FAIL — ${reason}`, ...refusal(t), usage]);
        return 2;
      }
    }
    // claude -p가 실패를 보고했으면 게이트를 돌릴 이유가 없다 — 판정할 산출물이 없다.
    // 게이트는 건너뛰고 곧장 verify로 간다(verify가 is_error로 떨어뜨린다).
    //
    // 예외는 **턴 한도**(KTB-16/17)와 **API 쿼터/장애**(KTB-22)다: 두 경우 모두 백그라운드 워크플로는
    // 이미 끝났을 수 있고 산출물은 트랜스크립트 안에 있다 — 모자란 것은 디스패처가 그것을 다시 출력할
    // 턴뿐이었거나, claude -p 자신이 응답 도중 죽었을 뿐이다. 게이트를 건너뛰면 verifyStage가 복구한
    // 산출물을 "gates file missing"으로 되떨어뜨려, 복구가 아무 소용이 없어진다.
    let gates = null;
    if (!out?.is_error || hitMaxTurns(out) || hitApiError(out)) {
      try { gates = await d.gates(ctx); }                             // 게이트 없는 스테이지(triage/plan)는 null
      catch (e) {
        if (!isMergeBaseError(e) && !isGitDiffError(e)) throw e;
        const reason = isMergeBaseError(e) ? MERGE_BASE_BLOCKED_REASON : GIT_DIFF_BLOCKED_REASON;
        const t = await d.transition({ to: "factory:blocked", reason });
        record([`gates: BLOCKED — ${e.message}`, ...refusal(t), usage]);
        return 2;
      }
    }
    // KTB-21: `[factory.test.env].compose`가 있으면 게이트가 명령을 돌리기 전에 env를 한 번 더
    // re-up했다(멱등) — 성공/실패 둘 다 run 기록에 남긴다. `ran`이 없으면(=이 하네스는 compose를
    // 안 쓴다) 아무 줄도 붙지 않는다.
    const testEnvNote = gates?.test_env_reup?.ran
      ? [`test-env: re-up ${gates.test_env_reup.ok ? "ok" : `failed — ${gates.test_env_reup.detail}`}`]
      : [];
    const gatesNote = gates == null
      ? (GATED_STAGES.has(stage) ? [GATES_SELF_REPORTED] : [])
      : gates.schema === "factory.gates.v1" ? [verdictLine(gates), ...testEnvNote] : [];
    // BLOCKED은 "판정 불가"다 — GREEN도 RED도 아니므로 needs-human이 아니라 blocked로 세운다.
    if (gates?.status === "BLOCKED") {
      const t = await d.transition({ to: "factory:blocked", reason: gates.blocked_reason || "gates could not be decided" });
      record([`gates: BLOCKED — ${gates.blocked_reason || "unknown"}`, ...refusal(t), ...gatesNote, usage]);
      return 2;
    }
    // BLOCKED은 위에서 이미 return했다 — 여기 남은 gates는 GREEN 아니면 그 외(RED/MISCONFIGURED)뿐이다.
    // diagnostic(bin/gates.js가 손으로 남긴 로컬 진단 결과)은 스테이지 판정이 아니다 — verify-stage/requirements와
    // 같은 불변식: 사람이 손으로 만든 GREEN이 커밋 상태로 새어나가면 안 된다.
    if (GATED_STAGES.has(stage) && gates != null && gates.diagnostic !== true) {
      // GREEN 하나만 success다 — MISCONFIGURED·RED·그 밖은 전부 failure(gates.js commitStatusState, 감사 H2).
      await postStatus({ context: "factory/gates", state: commitStatusState(gates.status), description: verdictLine(gates), sha: gates.head_sha });
    }
    /**
     * ADR-020 KTB-35 — **테스트가 하나도 깨지지 않은 RED는 다른 사고다.** 게이트가 그 사실을 스스로
     * 적어 두었으면(`gates.js`의 `reason`) 그 문장을 그대로 전이에 싣는다 — 그러지 않으면 사람이
     * 받는 것은 `stage artifact missing or invalid: gates RED: failing=unit`이고, 그 문장은 없는
     * 제품 결함을 가리킨다. 등급도 needs-human이 아니라 **blocked(cause=`gates-unhandled`)**다:
     * 원인은 대개 테스트 밖의 일시적 인프라(포크된 워커의 stderr EPIPE)이므로, KTB-15b 경로가 같은
     * 스테이지를 한 번 다시 돌리고 그래도 같으면 sweeper가 사람에게 올린다.
     */
    const unhandled = unhandledGateReason(gates);
    if (unhandled) {
      const t = await d.transition({ to: "factory:blocked", reason: unhandled, cause: "gates-unhandled" });
      record([`gates: RED (unhandled) — ${unhandled}`, ...refusal(t), ...gatesNote, usage]);
      return 2;
    }
    const v = d.verifyStage({ stage, out, ctx, gates });
    // KTB-15b M1: 어느 후보가 산출물로 뽑혔는지(파일 재조립·task-notification·envelope 펜스 …)는
    // 사후 감사의 provenance다 — verifyStage가 계산해 둔 것을 그냥 흘려보내지 않고 한 줄 남긴다.
    if (v.source) record([`artifact: ${v.source}`]);
    if (!v.ok) {
      // 턴 한도(KTB-16)와 API 쿼터/장애(KTB-22)는 둘 다 설계 오류가 아니라 **재시도로 풀리는 일시
      // 조건**이다 — 사람이 판단할 것이 아직 없으므로 needs-human이 아니라 blocked다(gates BLOCKED·
      // 머지 API 실패와 같은 등급). 여기까지 왔다는 건 트랜스크립트에서도 산출물을 복구하지 못했다는
      // 뜻이다(KTB-17) — 복구했다면 verifyStage가 이미 통과시켰다. 사유의 첫 줄이 원인(턴 한도 또는
      // 프로바이더 메시지 원문)이고 스키마 진단은 그 뒤에 붙는다.
      //
      // KTB-22 r1: API 에러 중에서도 **비일시적 4xx**(400/401/403/404/422 — 자격증명·설정)는 재시도로
      // 풀리지 않는다. 프로바이더 메시지는 그대로 기록에 싣지만(`v.reasons`에 이미 있다), 등급은
      // needs-human이다 — 사람이 자격증명/설정을 고쳐야 다음 시도가 다르게 끝난다. 408/425/429와
      // 모든 5xx는 여전히 일시적이라 blocked(=sweeper의 ≤3회 재시도) 그대로다.
      //
      // ADR-024 / KTB-42(리뷰 라운드 1 MF-2): **qa 증거 경로의 고장도 같은 계열이다.** 매니페스트가
      // 없거나 지난 커밋의 것이면 그것은 에이전트 산출물의 결함이 아니라 판정 불가다 — 프로브 실패와
      // 같은 등급(`factory:blocked` + `undecidable`)이어야 하고, 그래야 ADR이 약속한 "업그레이드 직후
      // 한 라운드 더 돌면 매니페스트가 생긴다"가 실제로 성립한다(needs-human은 그 길을 막는다).
      const apiError = hitApiError(out);
      const qaPath = qaEvidenceUnusable(v.reasons);
      const blocked = hitMaxTurns(out) || qaPath || (apiError && !isNonTransientApiError(out));
      const to = blocked ? "factory:blocked" : "factory:needs-human";
      const reasonPrefix = qaPath ? "qa evidence path" : blocked ? "stage did not finish" : apiError ? "api error needs human (credentials/config)" : "stage artifact missing or invalid";
      const t = await d.transition({ to, reason: `${reasonPrefix}: ${v.reasons.join("; ")}`, ...(qaPath ? { cause: "undecidable" } : {}) });
      record(["verify: FAIL", ...v.reasons.map((r) => `- ${r}`), ...refusal(t), ...gatesNote, usage]);
      return 2;
    }
    // 감사 M1 — 스크립트가 에이전트의 판정을 덮었다면 그 사실이 run 기록의 1차 증거다(다음 조사가
    // 이 줄로 grep한다). handoff에도 `never_automate_hit`으로 같은 내용이 실린다.
    if (stage === "triage" && v.data?.never_automate_hit?.length) {
      record([`never_automate_hit: ${v.data.never_automate_hit.map((h) => `${h.path} (${h.glob})`).join(", ")} — disposition forced to wont-do by CHARTER NEVER_AUTOMATE`]);
    }
    // tier 라벨은 triage가 붙인다(스펙 §3.2, KTB-9). `label-catalog.js`가 세 라벨을 만들어 두는데
    // 붙이는 코드가 어디에도 없었고, tier는 handoff JSON 안에만 있어서 사람이 이슈 목록에서 볼 수
    // 없었다. **handoff가 검증된 뒤**에만 붙인다 — 검증 전의 tier는 에이전트의 자기 신고일 뿐이다.
    // 실패해도 스테이지를 죽이지 않는다(라벨은 사람에게 보이는 표식이지 판정의 재료가 아니다 —
    // 게이트·로스터는 계속 handoff의 tier를 읽는다).
    //
    // **전이보다 먼저여야 한다**: tier 라벨을 붙이는 것도 `issues: labeled` 이벤트라, 그 이벤트가
    // 만드는 5개짜리 런 물결(스테이지 워크플로 5개가 전부 뜬다 — GitHub은 라벨 이름 필터를 주지
    // 않는다)이 뒤에 오면 전이가 막 띄운 다음 스테이지의 PENDING 런을 concurrency 슬롯에서 밀어낸다
    // (KTB-8). 순서가 뒤집히면 다음 스테이지가 조용히 사라진다 — 데모 #2가 죽은 그 방식이다.
    if (stage === "triage" && d.setTierLabel && TIERS.includes(v.data?.tier)) {
      try { await d.setTierLabel(v.data.tier); record([`tier: ${tierLabel(v.data.tier)}`]); }
      catch (e) { record([`tier: ${tierLabel(v.data.tier)} label failed — ${e?.message || e}`]); }
    }
    /**
     * 라운드 번호는 에이전트의 자기 신고가 아니라 **이슈에 남은 기록**에서 센다 — K 한도가 실제로 물리게.
     *
     * r1 SF2 — 세는 것은 handoff가 아니라 **완료된 rework 전이**(`factory-transition:v1 … to=factory:rework`)다.
     * handoff 코멘트는 전이보다 **먼저** 나가므로, handoff를 남기고 전이에서 죽은 런(그래프·요구사항
     * 거부, 전이 직전의 잡 사망)이 라운드를 하나 태웠다. KTB-29로 그 카운터에 이빨이 생긴 뒤로는
     * 인프라 사고 두 번 + 진짜 reject 한 번이면 멀쩡한 이슈가 K=3을 다 쓰고 "review rounds exhausted"로
     * 사람에게 올라간다. rework 전이는 **실제로 일어난 재작업 주기**이고, 그것이 스펙 §3.2가 K로
     * 세는 바로 그 단위다(`rework --> needs_human: round > K`). 창은 그대로 마지막 재큐 이후다(KTB-25).
     */
    if (stage === "review" && v.data) {
      const prior = await d.reviewRounds?.();
      if (typeof prior === "number") v.data.round = prior + 1;
    }
    // review handoff(review.v1)는 verdicts만 싣는다 — 집계 결정은 여기서 만들어 handoff·전이에 함께 실는다.
    // A-SF1 — `v.qaShortfall`이 있으면 산출물이 스스로 적은 decision이 있더라도 집계를 다시 돈다:
    // 그러지 않으면 이 부족이 **조용히 사라진다**(= 누락으로 정해지는 등급, 이 수정이 없애려는 것).
    if (stage === "review" && v.data && (v.data.decision == null || v.qaShortfall) && Array.isArray(v.data.verdicts)) {
      const roster = ctx?.roster || [];
      const agg = aggregateReview({ verdicts: v.data.verdicts, rosterSize: roster.length, rosterRoles: roster });
      const reviewDescription = (decision) => {
        const k = v.data.verdicts.filter((x) => x.verdict === "approve").length;
        const n = roster.length || v.data.verdicts.length;               // 정족수는 로스터 크기다 — verdict 개수는 미완일 때 부족분을 감춘다
        return `review round ${v.data.round}: ${decision} (${k}/${n} approve)`;
      };
      /**
       * `factory/review`는 **우리가 실제로 체크아웃해 검증한 커밋**(checkoutSha, R6)에만 건다 —
       * handoff의 `head_sha`는 에이전트가 적어 넣은 값이라, 그 값을 그대로 sha로 쓰면 에이전트가
       * 임의의 커밋(예: 이미 머지된 default 브랜치 tip)에 GREEN 리뷰 상태를 붙일 수 있다.
       * 둘이 다르면 아예 게시하지 않는다 — 어느 쪽이 맞는지 여기서 판단하지 않고 흔적만 남긴다
       * (필수 체크가 비면 L1이 fail closed로 머지를 막는다 — ADR-015 보강 이후 L0는 integrity만 요구한다).
       */
      const postReviewStatus = async ({ state, decision }) => {
        if (v.data.head_sha !== checkoutSha) { record(["status: factory/review skipped — handoff head_sha differs from checked-out head"]); return; }
        await postStatus({ context: "factory/review", state, description: reviewDescription(decision), sha: checkoutSha });
      };
      if (agg.decision === "incomplete") {                            // 라운드가 덜 끝났다 — 자동 라우팅하지 않는다
        await postReviewStatus({ state: "error", decision: "incomplete" });
        const t = await d.transition({ to: "factory:needs-human", reason: `review incomplete — missing verdicts: ${agg.missing_roles.join(", ") || "unknown"}` });
        record(["verify: ok", `review: incomplete — missing verdicts: ${agg.missing_roles.join(", ") || "unknown"}`, ...refusal(t), ...gatesNote, usage]);
        return 2;
      }
      /**
       * ── 최종 리뷰 A-SF1 — **qa 증거 부족은 이 라운드의 reject다.** ─────────────────────────────
       *
       * `verify-stage`는 그것을 `reasons`가 아니라 `qaShortfall`로 내보낸다(거기 doc 참고). 여기서
       * 그것을 집계에 **합성 must_fix**로 접는다: 역할은 `qa`, 부족한 done_when id를 이름으로 부른다.
       * 그러면 아래의 세 소비처가 전부 같은 결정을 읽는다 — `factory/review` 상태(failure), run 기록의
       * `review-evidence:` 줄, 그리고 `nextState`(→ `factory:rework`, K를 넘겼으면 평소의 K 경로).
       *
       * 접기 전에는 이 부족이 스테이지 실패였고, 접두어는 다른 분기의 기본값(`stage artifact missing
       * or invalid`)이었으며, 등급은 **판단이 아니라 누락으로** `factory:needs-human`이었다. 한 라운드
       * 더 돌면 풀릴 일에 리뷰어 넷의 라운드를 버리고 사람을 부르던 자리다.
       */
      if (v.qaShortfall) {
        const ids = Array.isArray(v.qaShortfall.ids) ? v.qaShortfall.ids : [];
        if (!agg.must_fix.some((m) => m?.id === QA_SHORTFALL_ID)) {
          agg.must_fix.push({
            id: QA_SHORTFALL_ID,
            where: `${qaDirRel(issue)}/manifest.json`,
            claim: v.qaShortfall.reason,
            evidence: ids.length ? `done_when with no usable evidence: ${ids.join(", ")}` : "the qa evidence manifest does not satisfy the contract",
            by: "qa",
          });
        }
        agg.decision = "rework";
        record([v.qaShortfall.reason]);
      }
      v.data.decision = agg.decision;
      v.data.must_fix = agg.must_fix;
      /**
       * ── 리뷰 batch-1 MF-2 (H1b-b) — **이 판정에 출처를 남긴다.**
       * handoff 코멘트는 에이전트가 쥔 봇 계정으로 나가고 `gh issue comment`는 훅이 일부러 열어 둔
       * 문이라, 머지 스테이지가 handoff만 읽는 한 그 판정은 위조 가능하다. 이 한 줄은 **러너가**
       * `claude -p`가 끝난 뒤에 쓰고 `factory/records`로 나간다 — 그 브랜치로 가는 에이전트 세션의
       * push는 훅이 막는다. 머지 스테이지는 둘이 **같은 커밋·같은 verdict·같은 라운드**일 때만 머지한다.
       * sha는 handoff가 적어 넣은 값이 아니라 **우리가 실제로 체크아웃한 커밋**이다(checkoutSha, R6) —
       * 그래야 head_sha를 지어낸 handoff가 이 대조에서 걸린다.
       *
       * 리뷰 batch-2 MF-2 — 그리고 **이 런의 이름**을 같이 싣는다(`run_id`/`runner`). 그래야 머지
       * 스테이지가 "파일의 마지막 줄"이 아니라 "이 이슈의 review 하트비트가 지목하는 런이 쓴 줄"을
       * 고를 수 있다 — 위조하려면 아직 일어나지 않은 런의 id를 맞혀야 한다.
       */
      /**
       * ADR-024 / KTB-42 — 그 줄에 **qa 증거 매니페스트의 지문**을 같이 싣는다. 매니페스트 자신은
       * `.factory/out/`에 사는 스크래치라 커밋되지 않는다 — 머지 스테이지는 그 파일을 영영 볼 수 없고,
       * 볼 수 있는 것은 러너가 여기 남긴 이 한 줄뿐이다(에이전트 세션의 `factory/records` push는 훅이 막는다).
       * 곧 "이 커밋에 대해 유효한 증거가 실제로 있었다"의 유일한 증인이 이 값이다.
       */
      let qaDigest = null, qaClaims = null;
      if (d.qaEvidence) {
        try {
          const qa = await d.qaEvidence({ headSha: checkoutSha ?? v.data.head_sha });
          if (qa?.skipped) record([`qa evidence: ${qa.skipped}`]);
          else if (qa?.ok) { qaDigest = qa.digest; qaClaims = claimCountsLabel(qa.counts); record([`qa evidence: manifest ${String(qa.digest).slice(0, 12)} valid for ${String(qa.head_sha ?? "unknown").slice(0, 7)} (${qaClaims})`]); }
          else record([`qa evidence: INVALID — ${qa?.reason || "unknown"}`]);
        } catch (e) { record([`qa evidence: unreadable — ${e?.message || e}`]); }
      }
      record([reviewEvidenceLine({ runId, runnerId, headSha: checkoutSha ?? v.data.head_sha, round: v.data.round, decision: agg.decision, verdicts: v.data.verdicts, qaManifest: qaDigest, qaClaims })]);
      await postReviewStatus({ state: agg.decision === "approved" ? "success" : "failure", decision: agg.decision });
    }
    /**
     * ADR-020 KTB-29 / 관측 O21 — **같은 역할이 라운드 사이에 판정을 뒤집는 빈도**는 §12.4의 지표다
     * (데모 #18에서 approve → reject 두 건이 관측됐다: 코드가 그대로인데 판정이 흔들리면 K 예산이
     * 리뷰어의 분산에 쓰인다). 앞 라운드의 review handoff에 실린 역할별 verdict와 이번 것을 비교해
     * 한 줄 남긴다. 조회 실패는 흔적만 남기고 스테이지를 죽이지 않는다 — 지표이지 게이트가 아니다.
     */
    if (stage === "review" && Array.isArray(v.data?.verdicts) && d.priorReviewVerdicts) {
      try {
        const flips = reviewFlips(await d.priorReviewVerdicts(), v.data.verdicts);
        if (flips.length) record([`review flips: ${flips.join(", ")}`]);
      } catch (e) { record([`review flips: unreadable — ${e?.message || e}`]); }
    }
    /**
     * ADR-020 KTB-23 — builder가 "보호 경로를 고쳐야 끝낼 수 있다"고 말했다. 그 말은 이제 PR 본문의
     * 산문이 아니라 handoff의 필드(`harness_needed[]`)이고, 여기가 그것을 읽는 유일한 자리다.
     *
     * **verifier 판정보다 먼저 본다.** 데모 #2가 죽은 방식이 그것이다: 게이트는 GREEN인데 verifier가
     * "done_when에 대응하는 테스트가 없다"로 reject했고(맞는 판정이다 — `pg` 없이는 그 테스트를 쓸 수
     * 없었다), 등급은 needs-human이 됐고, 사람이 재큐하면 같은 일이 또 일어났다. 네 라운드, ≈$67,
     * 머지 0건. 막힌 원인이 코드가 아니라 **하네스**일 때 다음 걸음은 사람의 판단이 아니라 하네스
     * 이슈다 — 그래서 verifier가 무엇이라 했든 이 분기가 먼저다.
     *
     * handoff는 그대로 남긴다(이 라운드가 무엇을 했고 무엇이 막았는지는 기록이다). 이슈 생성이
     * 실패하면 주차하지 않는다 — 주차는 "누군가 저 이슈를 처리하면 돌아온다"는 약속인데, 그 이슈가
     * 없으면 이 이슈는 아무도 보지 않는 needs-info에 영원히 앉는다. 그때는 needs-human이다.
     */
    /**
     * **하네스 이슈 자신은 이 분기를 타지 않는다**(ADR-020 KTB-23 fix). 그 이슈의 builder는 열린
     * 파일(`.factory/harness.toml`·러너 설정·매니페스트)을 실제로 쓰라고 부른 것인데, 그것들이
     * 프롬프트에서는 여전히 "보호 경로"로 적혀 있어 builder가 `harness_needed`를 채우고 멈췄다.
     * 여기서 그 필드를 그대로 읽으면 **하네스 이슈가 또 하네스 이슈를 연다** — 사슬이고, 주차된
     * 피처는 그 사슬 끝까지 기다린다. 프롬프트 쪽은 `stagePrompt`/`factory-implement.js`가 고쳤고,
     * 이 가드는 그 프롬프트가 무엇을 내놓든 사슬이 생기지 않게 하는 구조적 백스톱이다: 요청은
     * 기록으로 남기고, 라우팅은 평소대로 verifier 판정(→ awaiting-review 또는 needs-human)에 맡긴다.
     */
    if (stage === "implement" && harnessIssue) {
      const needed = harnessNeeded(v.data);
      if (needed.length) record([`harness: this IS the harness issue — harness_needed recorded, no new issue (${needed.map((h) => h.file).join(", ")})`]);
    } else if (stage === "implement" && d.ensureHarnessIssue) {
      const needed = harnessNeeded(v.data);
      if (needed.length) {
        await d.writeHandoff({ stage, data: v.data, gates });
        let created;
        try { created = await d.ensureHarnessIssue({ entries: needed, pr: v.data.pr ?? null }); }
        catch (e) {
          const reason = `harness change needed but the factory:harness issue could not be created — ${e?.message || e}`;
          const t = await d.transition({ to: "factory:needs-human", reason });
          record([`harness: FAIL — ${reason}`, ...refusal(t), ...gatesNote, usage]);
          return 2;
        }
        const t = await d.transition({ to: "factory:needs-info", reason: parkedReason(created.issue) });
        record([
          "verify: ok",
          `harness: ${created.created ? "opened" : "reusing"} factory:harness issue #${created.issue} — ${needed.map((h) => h.file).join(", ")}`,
          ...(t.ok ? [`transition: ${t.to}`] : refusal(t)),
          ...gatesNote, usage,
        ]);
        return t.ok ? 0 : 2;
      }
    }
    await d.writeHandoff({ stage, data: v.data, gates });
    /**
     * ADR-020 KTB-43 — 브랜치가 핸드오프 sha보다 앞서 있는데 그 차이가 드리프트가 아니었다. 전이
     * 요구조건도 이것을 거부하지만(`implement head_sha … != branch head …`) 그 문장은 sha 두 개뿐이라
     * 사람이 무슨 일이 있었는지 알 수 없다 — **어떤 파일이** 걸렸는지를 실어 여기서 먼저 거부한다.
     * 핸드오프는 이미 위에서 나갔다: 이 라운드가 무엇을 했는지는 이슈에 남는다.
     */
    if (driftRefusal) {
      const t = await d.transition({ to: "factory:needs-human", reason: driftRefusal });
      record(["verify: ok", `drift: refused the transition — ${driftRefusal}`, ...refusal(t), ...gatesNote, usage]);
      return 2;
    }
    /**
     * ADR-020 KTB-29 — K 한도는 스펙 §3.2의 엣지(`rework → needs_human: round > K`)인데 코드에는
     * 없었다: `nextState`의 review 분기는 `decision === "approved"` 하나만 보고 나머지를 전부 rework으로
     * 보냈다. 데모 #18은 K=3인데 리뷰 라운드 4에서 또 rework으로 갔다 — 무한 루프의 상한이 사실상
     * 없었던 셈이다(`transition.js`의 `round ≤ K` 검사는 **approved 경로에만** 걸린다: 통과하는 리뷰는
     * 애초에 K를 넘길 이유가 없고, 넘기는 것은 언제나 실패하는 쪽이다).
     *
     * K는 CHARTER의 hard limit이고 컨텍스트로 실려 온다(`ctx.limits.K`). 값이 없으면(구형 배선·읽기
     * 실패) 예전 동작 그대로 rework이다 — 모르는 한도로 사람을 부르지 않는다.
     */
    const maxRounds = ctx?.limits?.K;
    const to = nextState(stage, v.data, { maxRounds });
    const exhausted = stage === "review" && to === "factory:needs-human";
    const t = await d.transition({ to, data: v.data, ...(exhausted ? { reason: reviewExhaustedReason(v.data, maxRounds) } : {}) });
    record(["verify: ok", ...(t.ok ? [`transition: ${t.to}`] : refusal(t)), ...(checkoutSha ? [`checkout: ${checkoutSha.slice(0, 7)}`] : []), ...gatesNote, usage]);
    return t.ok ? 0 : 2;
  } catch (e) {
    console.error(`factory: stage ${stage} aborted — ${e?.message || e}`);
    record([`error: ${stage} aborted — ${e?.message || e}`]);
    return 1;
  } finally {
    hb?.stop();
    const released = await d.release();
    if (released === false) {                                         // 락이 남으면 다음 런이 통째로 막힌다 — 조용히 지나치지 않는다
      console.error(`factory: lock release failed for issue ${issue}`);
      record([`lock: release failed for issue ${issue} — delete refs/heads/factory/lock-${issue} by hand`]);
    }
    // run 기록을 factory/records 브랜치로 push한다(ADR-014) — 락 해제 뒤, 부수 효과로. 실패해도
    // 이번 런의 결과(exit code)는 절대 바꾸지 않는다 — 다음 런이나 사람이 다시 밀어 넣을 수 있다.
    try {
      const s = await d.syncRecords?.();
      if (s && !s.ok) { console.error(`factory: run-record sync to factory/records failed — ${s.reason}`); record([`run-record sync: failed — ${s.reason}`]); }
      // ok:true여도 조용하면 안 되는 두 경우: 같은 이슈에 동시에 돈 다른 러너 때문에 로컬 꼬리가
      // 브랜치 tip 뒤로 병합됐거나(merged), 로컬이 브랜치보다 뒤처져 더할 게 없었거나(skipped).
      // 둘 다 "내가 쓴 줄이 내가 기대한 자리에 있지 않다"는 신호다 — 사후 감사에서 보여야 한다.
      if (s?.merged?.length) record([`run-record sync: merged onto the branch tip — ${s.merged.join(", ")}`]);
      if (s?.skipped?.length) record([`run-record sync: skipped (nothing new) — ${s.skipped.join(", ")}`]);
    } catch (e) { console.error(`factory: run-record sync to factory/records aborted — ${e?.message || e}`); record([`run-record sync: aborted — ${e?.message || e}`]); }
  }
}

/**
 * ADR-020 KTB-24 — 잡이 **취소되거나 실패로 끊겼을 때** 이 스테이지가 물고 있던 라벨.
 *
 * `runStage`의 `finally`(락 해제·기록 동기화)는 잡 타임아웃·취소에서는 **실행되지 않는다**: 프로세스가
 * SIGKILL로 사라진다. 데모 #15가 남긴 잔해가 정확히 그것이다 — `refs/heads/factory/lock-15`가 고아로
 * 남고, 이슈는 `factory:awaiting-review`에 전이·코멘트·run 기록 한 줄 없이 45분을 태운 채 앉아 있었다.
 *
 * 라벨이 **아직 이 값일 때만** blocked으로 세운다. 다른 라벨이면 스테이지는 이미 전이를 끝낸 뒤에
 * (예: 아티팩트 업로드 중에) 죽은 것이라 되돌릴 것이 없고, 그때 blocked으로 밀면 성공한 전이를
 * 취소하는 셈이 된다. merge는 이 표에 없다 — script-only라 정리는 락 해제와 기록뿐이다.
 */
export const IN_FLIGHT_LABEL = { triage: "factory:queue", plan: "factory:ready", implement: "factory:in-progress", review: "factory:awaiting-review" };
/** 기록 한 줄의 문구는 한 곳에서만 만든다 — 사후 조사가 이 문자열로 grep한다. */
export const abortedLine = (status) => `aborted: ${status} (job timeout or cancel)`;

/**
 * r1 nit 8 — run 기록은 `factory/records` 브랜치로 커밋되는 **영구적이고 공유되는** 산출물이다.
 * 원격 명령의 stderr를 그대로 실으면 그 안의 URL(토큰이 박힌 remote URL 포함)과 여러 줄짜리 덤프가
 * 그대로 남는다. 지금 배선(`actions/checkout`의 `http.extraheader`)에서는 토큰이 git 에러 문구에
 * 들어가지 않지만, 원격 에러 출력이 durable artifact에 닿는 자리는 여기 하나뿐이므로 그 하나를 막는다.
 */
export const truncateReason = (text, max = 120) =>
  String(text ?? "").replace(/https?:\/\/\S+/g, "<url>").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * ADR-020 O20 — **잡 상태 → blocked 원인 등급.** 이 스텝은 등급을 추측하지 않아도 된다: GitHub이
 * 방금 `job.status`로 말해 줬다(`--aborted <status>`). 사람이 누른 취소(`cancelled`)와 시간 초과
 * (`timed_out`)는 sweeper가 다르게 다뤄야 하고(전자는 R 예산을 쓰지 않는다), 에스컬레이션 문구도
 * 달라진다. 표에 없는 상태(`failure` 등)는 사유 문구에서 되짚게 둔다(`transition.js`).
 */
export const ABORT_CAUSE = { cancelled: "cancelled", timed_out: "timeout" };

/**
 * 취소·실패 정리 경로(`run-stage.js <stage> <issue> --aborted <job.status>`). **claude를 절대 띄우지
 * 않는다** — 여기서 하는 일은 셋뿐이다: `aborted:` 기록 한 줄, (해당하면) `factory:blocked` 전이,
 * 락 해제. 취소된 잡의 유예 시간은 짧으므로 조회도 최소다(라벨 한 번).
 *
 * 순서가 요점이다: 전이를 **먼저** 하고 락을 나중에 푼다. 반대로 하면 락이 풀린 직후 sweeper/dispatch가
 * 같은 이슈를 물고 들어와, 이 프로세스가 막 세우려던 blocked 라벨과 경쟁한다.
 */
export async function abortStage({ stage, issue, status = "cancelled", runnerId = "unknown", deps }) {
  const d = deps;
  const lines = [abortedLine(status)];
  /**
   * 소유자를 **먼저** 묻는다(ADR-020 KTB-28). KTB-28 (b)로 claim 거부가 `exit 2`가 된 뒤, 이 스텝은
   * "락을 못 잡아 물러난 런"에서 **반드시** 돈다(잡이 실패로 끝나므로). 그 런은 이 스테이지를 단 한
   * 걸음도 돌지 않았는데, 라벨은 지금 돌고 있는 **다른** 러너 때문에 in-flight 값 그대로다 — 소유자를
   * 묻지 않고 그 라벨을 `factory:blocked`로 밀면, 정리 코드가 남의 살아 있는 스테이지를 쏘는 셈이다
   * (락을 지우지 않는 것만으로는 부족했다). 락이 남의 것이면 전이도 하지 않고 기록만 남긴다.
   */
  let held = null;
  try { held = await d.lockHolder?.(); }
  catch (e) { lines.push(`lock: holder lookup failed — ${truncateReason(e?.message || e)}`); }
  /**
   * r1 MF2 — **증명된 것만 만진다(fail closed).** 예전에는 "남의 락임이 증명되면 물러난다"였다: 조회가
   * 실패했거나(`present:null`), 제목을 파싱하지 못했거나, 배선이 없으면 **우리 것으로 간주하고** 전이와
   * 해제를 그대로 했다. 그 fail-open은 "이 스텝에 오는 런은 거의 다 락의 주인이다"라는 전제 위에 서
   * 있었는데, KTB-28 (b)가 그 전제를 깼다: 이제 **claim에 실패한 런도** 잡을 실패로 끝내므로 이 스텝을
   * 반드시 돈다. 그 런은 락을 단 한 번도 쥔 적이 없다. 그 상태에서 `git fetch` 한 번이 흔들리면
   * (GitHub 장애·토큰 만료 — M4가 그것을 `present:null`로 정확히 분류한 바로 그 경우들) 정리 코드가
   * 남의 **살아 있는** 라벨을 blocked으로 밀고 남의 락을 지운다. 리뷰가 그린 사고: A의 27분짜리 review가
   * 버려지고, 락이 없어진 자리에 sweeper가 두 번째 review를 얹는다.
   *
   * 그래서 이제 전이도 해제도 `owned`(락이 **있고**, 그 `runner=`가 정확히 이 런)일 때만 한다. 모르면
   * 아무것도 하지 않고 그 사실만 적는다 — 고아 락은 sweeper의 회수 팔(KTB-28 c)이 소유자 런이 끝난
   * 것을 확인한 뒤 지운다. 남는 것은 사고가 아니라 한 사이클의 지연이다.
   */
  const owned = held?.present === true && Boolean(held.runner) && held.runner === runnerId;
  const foreign = held?.present === true && Boolean(held.runner) && held.runner !== runnerId;
  const unknown = !owned && !foreign;                               // 조회 실패·present:null·제목 파싱 실패·구형 배선
  const want = IN_FLIGHT_LABEL[stage];
  if (foreign) {
    lines.push(`aborted: lock is held by ${held.runner} — this run never owned the stage, no transition`);
  } else if (held?.present === false) {
    lines.push("aborted: there is no lock on this issue — this run cannot prove it owned the stage, no transition");
  } else if (unknown) {
    lines.push(`abort-skipped: holder unknown — no transition, no release${held?.present === null ? ` (${truncateReason(held.reason)})` : ""}`);
  } else if (!want) {
    lines.push(`aborted: ${stage} is script-only — lock release and record only`);
  } else {
    let labels = null;
    try { labels = await d.issueLabels(); }
    catch (e) { lines.push(`aborted: entry state unreadable — ${e?.message || e}`); }
    if (labels) {
      let current;
      try { current = factoryLabelOf(labels); }
      catch (e) { current = undefined; lines.push(`aborted: label set invalid — ${e?.message || e}`); }
      if (current === want) {
        // 사유는 사람이 읽는 한 줄이자 sweeper의 재료다 — `lib/transition.js`가 같은 코멘트에
        // `factory-blocked-origin from=<want> stage=<stage>` 마커를 함께 찍는다(KTB-15b I2).
        /**
         * r2 SF4(리뷰 finding 4) — **이 전이가 던져도 락 해제와 기록은 돈다.** KTB-30이 라벨 변경에
         * 재시도 + REST 폴백을 달면서 `transition()`은 이제 **던질 수 있는** 호출이 됐다(넷 다 실패하면
         * 원래 에러를 그대로 올린다). 그런데 `main()`은 `abortStage`를 맨몸으로 부르므로, 그 예외 하나가
         * 아래의 `release()`·`runRecord`·`syncRecords`를 통째로 건너뛴다 — "언제나 락을 풀고 언제나 한
         * 줄을 남긴다"가 계약의 전부인 스텝이 하필 API 장애 창에서 둘 다 건너뛰는 것이다(고아 락은
         * sweeper가 회수하지만 그건 한 사이클의 지연이고, 여기서는 try/catch 하나면 지연조차 없다).
         */
        try {
          const t = await d.transition({ to: "factory:blocked", reason: `job ${status} — retry via sweeper`, cause: ABORT_CAUSE[status] });
          lines.push(t.ok ? `aborted: ${want} → factory:blocked` : `transition refused: ${t.reason}`);
        } catch (e) {
          lines.push(`transition failed: ${want} → factory:blocked — ${truncateReason(e?.message || e)}`);
        }
      } else if (current !== undefined) {
        lines.push(`aborted: label is ${current ?? "none"}, not ${want} — the stage had already moved on, no transition`);
      }
    }
  }
  /**
   * ADR-020 KTB-24 fix — **남의 락은 건드리지 않는다.** 이 스텝은 `if: always() && job.status != 'success'`로
   * 도는데, 그 조건에는 이 런이 **claim에 실패해 exit 0으로 물러난 뒤 다른 이유로 실패한** 경우도 들어온다
   * (그리고 취소는 claim 이전에도 온다). 예전 코드는 소유자를 묻지 않고 `release()`를 불렀다 —
   * 지금 정상적으로 돌고 있는 다른 러너의 락을 지우는 일이고, 그러면 같은 이슈에 두 스테이지가 동시에
   * 들어간다(락이 막으려던 바로 그 사고를 정리 코드가 만든다).
   *
   * 그래서 넷으로 가른다: 없으면 할 일 없음(사람에게 "손으로 지우라"고 말하지도 않는다 — 지울 것이
   * 없다), 우리 것이면 지운다, 남의 것이면 그대로 두고 누구 것인지 적는다. 소유자를 **읽지 못했을**
   * 때(조회 실패·제목 파싱 실패·구형 배선)도 그대로 둔다(r1 MF2) — 예전에는 여기서 지웠지만, 그
   * fail-open은 claim에 실패한 런까지 이 스텝에 오게 된 뒤로는 "남의 살아 있는 락을 지운다"와 같은
   * 말이 됐다. 고아 락은 sweeper가 소유자 런의 종료를 **확인한 뒤** 리스를 걸고 지운다(KTB-28 c).
   *
   * 조회 자체는 위(전이 판단)에서 이미 했다 — 같은 런에서 두 번 묻지 않는다.
   */
  if (held?.present === false) {
    lines.push("lock: already released");
  } else if (foreign) {
    lines.push(`lock: held by ${held.runner} — left alone`);
  } else if (unknown) {
    lines.push("lock: holder unknown — left alone (the sweeper reclaims it once the owner run is done)");
  } else {
    const released = await d.release();
    if (released === false) {
      console.error(`factory: lock release failed for issue ${issue}`);
      lines.push(`lock: release failed for issue ${issue} — delete refs/heads/factory/lock-${issue} by hand`);
    } else {
      lines.push(`lock: released after abort`);
    }
  }
  try { d.runRecord(lines); } catch (e) { console.error(`factory: run record write failed — ${e.message}`); }
  try {
    const s = await d.syncRecords?.();
    if (s && !s.ok) console.error(`factory: run-record sync to factory/records failed — ${s.reason}`);
  } catch (e) { console.error(`factory: run-record sync to factory/records aborted — ${e?.message || e}`); }
  return 0;
}

/**
 * 지난 런이 남긴 "판정의 재료"까지 전부 지운다. gates.json만 지우고 unit.json·coverage·mutation
 * 리포트를 남겨두면, 이번 런에서 그 명령이 아예 돌지 않았을 때 낡은 리포트가 이번 판정의 근거로
 * 읽힌다(격리 제외·diff coverage·mutation score가 전부 옛 실행 얘기가 된다).
 * 레포 밖 경로는 건드리지 않는다 — 하네스가 절대 경로를 가리켜도 남의 파일을 지우지 않는다.
 */
export function gateOutputPaths({ root, harness = {} }) {
  const rel = [".factory/out/gates.json"];
  for (const name of ["unit", "integration", "e2e"]) rel.push(harness.test?.[`${name}_report`] || `.factory/out/${name}.json`);
  rel.push(harness.commands?.proof?.coverage_report, harness.commands?.proof?.mutation_report);
  const rootAbs = resolve(root);
  const under = (p) => p === rootAbs || p.startsWith(rootAbs + sep);
  const paths = rel.filter(Boolean).map((p) => resolve(isAbsolute(p) ? p : join(rootAbs, p))).filter(under);
  return [...new Set(paths)];
}
export function resetGateOutputs({ root, harness, rm = (p) => rmSync(p, { force: true }) }) {
  const paths = gateOutputPaths({ root, harness });
  for (const p of paths) rm(p);
  return paths;
}

/**
 * ADR-020 KTB-14 — 이 스테이지가 "쓰기 금지" 스테이지인가. `lib/agent-md.js`의 `needsDenyAllWritesHook`가
 * 이미 "이 역할은 아무것도 쓸 수 없어야 한다"의 단일 출처다 — 여기서 다시 정의하면 두 판정이 어긋날 수
 * 있으므로(KTB-13 r1의 교착 경고와 같은 이유) 같은 함수를 대표 이름으로 프로브한다: triage는 단일 역할
 * (`factory-triage`), plan·review는 로스터 프리픽스(`plan-*`·`reviewer-*`, `ROLE_PREFIX` 참고) — 대표
 * 이름 하나만 넣어도 `startsWith` 판정은 그대로 성립한다. implement(`factory-builder`)만 쓰기 스테이지이고,
 * merge는 에이전트를 아예 띄우지 않는다 — `runStage`가 그 전에 이미 `runMergeStage`로 return한다(위 §merge).
 */
const NO_WRITE_STAGE_PROBE = { triage: "factory-triage", plan: "plan-x", review: "reviewer-x" };
export function isNoWriteStage(stage) { return needsDenyAllWritesHook(NO_WRITE_STAGE_PROBE[stage]); }

/** ADR-020 KTB-14 — 쓰기 금지 스테이지가 워크트리에 남겨도 되는 유일한 두 스크래치 경로. */
export const NO_WRITE_SCRATCH_PREFIXES = [".factory/out/", "docs/factory/runs/"];
const isScratchPath = (p) => NO_WRITE_SCRATCH_PREFIXES.some((pre) => p === pre.slice(0, -1) || p.startsWith(pre));

/**
 * `git status --porcelain` 한 줄 = "XY PATH" 또는 rename/copy의 "XY OLD -> NEW"다 — 두 경우 모두
 * 경로는 세 번째 문자부터 시작한다. rename은 **양쪽** 경로를 낸다(KTB-5 N1과 같은 원칙 — 출발지를
 * 놓치면 보호 경로를 스크래치 밖 이름으로 옮기는 변경이 새 이름만 보고 통과할 수 있다).
 *
 * 알려진 한계(KTB-14 r1): `core.quotePath`가 켜진 기본 설정에서 git은 ASCII 밖·특수문자 경로를
 * **C 인용**으로 낸다(`"src/\355\225\234.js"`, `"a b -> c"`). 그 줄은 여기서 따옴표째 한 경로로
 * 읽히고, 안쪽의 ` -> `도 구분자로 오해될 수 있다. 이 체크의 **판정 방향에서는 안전한 쪽으로
 * 틀린다** — 인용된 경로는 스크래치 접두(`.factory/out/`·`docs/factory/runs/`)와 절대 일치하지
 * 않으므로 항상 "더러움"으로 센다(누락이 아니라 오탐). 정확한 파싱이 필요해지면
 * `-z`(NUL 구분 + 인용 없음)로 바꾸는 것이 정공법이다.
 */
function pathsOfStatusLine(line) {
  const rest = line.slice(3);
  const i = rest.indexOf(" -> ");
  return i === -1 ? [rest] : [rest.slice(0, i), rest.slice(i + 4)];
}

/**
 * `run-stage.js`가 claude -p 이후, verifyStage 이전에 묻는 구조적 백스톱(ADR-020 KTB-14 — KTB-13 r1
 * 잔여 위험 등록부 gap 3을 닫는다). `reviewer-*`·`plan-*`·`factory-triage`는 `tools:`에 Bash를 들고
 * 있고, 훅(`deny-all-writes.sh`)은 **명령 모양의 열거**일 뿐이라 훅이 모르는 모양이면 그냥 통과한다
 * (KTB-13 r1). 이 체크는 모양이 아니라 **결과**(워크트리 diff)만 본다 — 어떤 셸 모양으로 만들었든
 * 스크래치 경로 밖의 변화는 전부 위반이다. `git status` 자체가 실패하면 "깨끗하다"를 증명할 수
 * 없으므로 fail-closed(`ok:false`)다 — 이 저장소의 다른 "판정 불가" 계약(`integrityCheck`의
 * `cannotCompute`, `mergeGates`)과 같다.
 */
/** `git status --porcelain` 한 덩어리 → `{path, code}` 목록(rename은 양쪽 경로, 같은 상태 문자). */
export function parseStatusEntries(porcelain) {
  const out = [];
  for (const line of String(porcelain ?? "").split("\n").filter(Boolean)) {
    const code = line.slice(0, 2);
    for (const p of pathsOfStatusLine(line)) if (p) out.push({ path: p, code });
  }
  return out;
}

/** `??`는 추적되지 않는 파일이다 — 되돌리는 방법이 `git checkout`이 아니라 삭제인 유일한 경우. */
const isUntrackedCode = (code) => code === "??";

/**
 * 기준선의 경로별 **diff 지문**. `git diff HEAD --numstat`(스테이징 여부와 무관하게 HEAD 대비)
 * 한 번으로 `path → "<added>/<deleted>"`를 만든다. 경로 이름만으로 면제하면 "setup이 건드린
 * 파일이니 에이전트가 그 위에 무엇을 더 써도 통과"가 되므로, 그 구멍을 이 지문이 막는다.
 * **알려진 한계**: 추가·삭제 줄 수가 정확히 같은 재편집은 구별하지 못한다(그리고 추적되지 않는
 * 파일은 numstat에 아예 나오지 않아 경로+상태 문자만으로 비교된다). 완전한 내용 해시는 경로마다
 * 프로세스를 하나씩 띄워야 해서 이 자리의 값(스테이지 시작·종료 각 1회)과 맞지 않는다.
 */
async function diffFingerprint({ run, cwd, paths }) {
  if (!paths.length) return { ok: true, map: new Map() };
  const r = await run("git", ["diff", "HEAD", "--numstat", "--", ...paths], { cwd });
  if (r.code !== 0) return { ok: false, reason: `git diff --numstat failed: ${r.stderr?.trim() || `exit ${r.code}`}` };
  const map = new Map();
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const [added, deleted, ...rest] = line.split("\t");
    const p = rest.join("\t");
    if (p) map.set(p, `${added}/${deleted}`);
  }
  return { ok: true, map };
}

const statOf = (stat, p) => (stat instanceof Map ? stat.get(p) : stat?.[p]) ?? null;

/**
 * ADR-020 KTB-39 — **스테이지가 시작할 때 이미 더러웠던 것들.** `[runtime].setup`
 * (`.factory/actions/setup`의 자기 스텝, `bin/setup-env.js`)은 run-stage보다 **먼저** 돌고, 하네스에
 * 따라 추적 파일을 다시 쓴다: own-calendar의 `flutter pub get`이 `client/pubspec.lock`·
 * `client/<platform>/flutter/generated_plugin…`·`client/analysis_options.yaml`을 매번 고쳐 놓는다. 그 diff는
 * 에이전트의 것이 아닌데 쓰기 금지 스테이지의 클린 체크는 그것을 위반으로 읽었다(own-calendar #3,
 * 2026-09-14 — triage가 아무것도 쓰지 않았는데 `factory:needs-human`). 데모가 이 벽을 못 만난 것은
 * `npm ci`가 추적 파일을 건드리지 않기 때문이지 체크가 옳아서가 아니다.
 *
 * 스냅샷은 **스테이지가 트리를 건드리기 전**(overlay·브랜치 체크아웃·resetGates 이전)에 찍는다 —
 * 그래야 이 목록이 "setup이 남긴 것"만 담는다. 실패는 치명적이지 않다: 기준선이 없으면 아무 경로도
 * 면제되지 않는다(= 예전 동작, 더 엄격한 쪽).
 */
export async function snapshotSetupDirty({ run, cwd }) {
  const r = await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd });
  if (r.code !== 0) return { ok: false, entries: [], stat: new Map(), reason: `git status failed: ${r.stderr?.trim() || `exit ${r.code}`}` };
  // 스크래치 경로는 어차피 클린 체크의 대상이 아니다 — 기준선에 실어 봐야 바뀌는 것이 없고,
  // implement의 복원이 러너 자신의 산출물을 지우게 만들 뿐이다.
  const entries = parseStatusEntries(r.stdout).filter((e) => !isScratchPath(e.path));
  const tracked = [...new Set(entries.filter((e) => !isUntrackedCode(e.code)).map((e) => e.path))];
  const f = await diffFingerprint({ run, cwd, paths: tracked });
  // 지문을 못 읽는 것은 스냅샷의 실패가 아니다(경로+상태 문자 비교로 떨어진다) — 흔적만 남긴다.
  return { ok: true, entries, stat: f.ok ? f.map : new Map(), ...(f.ok ? {} : { statReason: f.reason }) };
}

/** run 기록 한 줄. 경로 목록은 잘라 싣는다 — 기록은 증거이지 덤프가 아니다. */
export const SETUP_DIRTY_CAP = 10;
export function setupDirtyLine(entries, cap = SETUP_DIRTY_CAP) {
  const paths = [...new Set((entries || []).map((e) => e.path))];
  const more = paths.length > cap ? `, … (+${paths.length - cap} more)` : "";
  return `setup dirtied: ${paths.length} path(s): ${paths.slice(0, cap).join(", ")}${more}`;
}
export const setupRestoreLine = (r) =>
  r?.ok
    ? `setup restore: ${r.tracked.length} tracked path(s) checked out, ${r.untracked.length} untracked path(s) removed before the builder`
    : `setup restore: FAILED — ${r?.reason || "unknown"} (the builder's \`git add -A\` may carry setup output into the commit)`;

/**
 * ADR-020 KTB-39 — implement는 **유일한 쓰기 스테이지**라 기준선을 면제 목록으로 쓸 수 없다: 빌더는
 * `git add -A`로 커밋하므로, setup이 남긴 diff가 그대로 PR에 실린다(own-calendar #3의 첫 PR에는
 * `pubspec.lock` 재생성이 들어 있었다). 그래서 여기서는 **면제 대신 복원**이다 — 추적 파일은
 * `git checkout -- <paths>`로 HEAD의 내용으로 돌리고, setup이 만든 추적되지 않는 파일은 지운다.
 * 빌더가 뜨기 전에 끝난다.
 *
 * **왜 삭제인가, 그리고 그 대가**: 추적되지 않는 setup 산출물은 `.gitignore`에 없으니(있었다면
 * `git status`에 나오지도 않는다) `git add -A`가 반드시 집는다. 대가는 게이트다 — `[runtime].setup`은
 * 잡에서 **한 번만** 돌고(`.factory/actions/setup`의 자기 스텝), 게이트는 같은 잡의 뒤 스텝에서
 * 돌므로 **다시 돌지 않는다**. 지워진 것이 빌드 입력이면 게이트 명령이 스스로 다시 만들어야 한다.
 * 그래서 하네스 템플릿의 권고는 "추적 파일을 다시 쓰지 않는 setup"이고, doctor의
 * `runtime.setup-dirties-tree`가 그 사실을 미리 말한다.
 *
 * 경로는 레포 밖으로 나가지 않는다(`core.quotePath`가 만든 인용 경로처럼 이상한 이름이 와도
 * 남의 파일을 지우지 않는다 — `gateOutputPaths`와 같은 계약).
 */
export function makeRestoreSetupDirty({ run, root, rm = (p) => rmSync(p, { force: true }) }) {
  return async (baseline) => {
    const entries = baseline?.entries || [];
    const tracked = [...new Set(entries.filter((e) => !isUntrackedCode(e.code)).map((e) => e.path))];
    const untrackedAll = [...new Set(entries.filter((e) => isUntrackedCode(e.code)).map((e) => e.path))];
    const rootAbs = resolve(root);
    const under = (p) => p === rootAbs || p.startsWith(rootAbs + sep);
    const untracked = untrackedAll.filter((p) => !isAbsolute(p) && under(resolve(rootAbs, p)));
    const failures = untrackedAll.filter((p) => !untracked.includes(p)).map((p) => `refused to remove ${p} (outside the repo root)`);
    if (tracked.length) {
      const r = await run("git", ["checkout", "--", ...tracked], { cwd: root });
      if (r.code !== 0) failures.push(`git checkout -- failed: ${r.stderr?.trim() || `exit ${r.code}`}`);
    }
    for (const p of untracked) {
      try { rm(resolve(rootAbs, p)); } catch (e) { failures.push(`rm ${p}: ${e?.message || e}`); }
    }
    return { ok: !failures.length, tracked, untracked, reason: failures.join("; ") || null };
  };
}

/**
 * ── ADR-020 KTB-43 — **핸드오프 뒤에 붙은 툴체인 재생성 커밋은 사람이 볼 사건이 아니다** ────────
 * own-calendar #3 implement(라이브, 2026-09-14 13:32Z): 빌더가 작업을 커밋하고(`bfff638`) 그 sha로
 * 핸드오프를 쓴 다음, 자기 검증(`flutter test`)이 툴체인 파일을 다시 만들었고 그것을
 * `f1909c6 "chore(3): reconcile flutter toolchain drift left by verification run"`으로 커밋했다 —
 * 건드린 파일(`client/analysis_options.yaml`·`client/{linux,windows}/flutter/generated_plugin*`·
 * `client/macos/Flutter/GeneratedPluginRegistrant.swift`)은 KTB-39의 `setup_dirty` 기준선 집합
 * **그대로**였다. `requirements.js`가 `implement head_sha bfff638 != branch head f1909c6`으로 전이를
 * 거부했고 이슈는 needs-human에 앉았다. fail-closed는 옳다 — 틀린 것은 복구가 자동이 아니었다는 것이다.
 *
 * 그래서 스테이지가 되돌린다. 조건은 둘 다 참일 때뿐이다: 브랜치 head가 핸드오프 sha의 **자손**이고,
 * 그 사이 커밋들이 건드린 파일이 **전부** 드리프트 경로일 것(KTB-39 기준선 ∪ `[runtime].setup_generated`
 * 글롭). 하나라도 벗어나면 되돌리지 않는다 — 그건 빌더가 실제로 한 작업이고, 스테이지가 남의 작업을
 * 말없이 지우는 자리는 이 저장소에 없다. 그때는 **파일 이름을 실어** 거부한다(예전에는 sha 두 개만
 * 보였다 — 사람이 무슨 일이 있었는지 알 수 없는 문장이었다).
 *
 * **왜 게이트보다 먼저인가**: `gates.json`의 `head_sha`는 게이트가 돈 시점의 로컬 HEAD이고, 전이
 * 요구조건은 그 값과 브랜치 head를 다시 묶는다(`requirements.gatesGate`). 게이트 뒤에 되돌리면
 * "게이트는 f1909c6을 봤는데 브랜치 head는 bfff638"이 되어, 한 거부를 다른 거부로 바꿀 뿐이다.
 *
 * **리스 없는 force는 없다.** `--force-with-lease=<branch>:<head>`의 `<head>`는 우리가 방금 읽은 그
 * 커밋이다 — 그 사이 누가 브랜치를 움직였으면 push는 거절되고, 그 거절은 실패가 아니라 **판정**이다
 * (되돌릴 대상이 우리가 본 그것이 아니다). 그 자리에서 `--force`로 바꾸지 않는다.
 */
export const driftRefusedReason = (files) => `post-handoff commits touch non-drift paths: ${files.join(", ")}`;

/** 기준선(KTB-39의 `setup_dirty`) ∪ `[runtime].setup_generated` 글롭 = 에이전트의 것이 아닌 경로. */
export function isDriftPath(path, { baseline = null, generated = [] } = {}) {
  const base = (baseline?.entries || []).some((e) => e.path === path);
  return base || (generated.length > 0 && matchesAny(generated, path));
}

export const DRIFT_FILE_CAP = 10;
/** run 기록 한 줄. 파일 목록은 잘라 싣는다 — 기록은 증거이지 덤프가 아니다(`setupDirtyLine`과 같은 계약). */
export function driftDroppedLine({ dropped = [], files = [], cap = DRIFT_FILE_CAP } = {}) {
  const more = files.length > cap ? `, … (+${files.length - cap} more)` : "";
  return `dropped post-handoff drift commit(s): ${dropped.map((s) => String(s).slice(0, 7)).join(", ")} (${files.length} files: ${files.slice(0, cap).join(", ")}${more})`;
}
/** 이슈에 남기는 한 줄짜리 마커 — 사후 조사가 `factory-drift-dropped`로 grep한다. */
export const driftDroppedMarker = ({ branch, from, to, dropped = [], files = [] } = {}) =>
  `<!-- factory-drift-dropped branch=${branch} from=${from} to=${to} commits=${dropped.join(",")} files=${files.length} -->`;

/**
 * 세션 산출물에서 빌더가 적은 `head_sha`를 **게이트보다 먼저** 읽는다. 후보 채점은 `verifyStage`와
 * 같은 방식이다(`withGates`): 이 시점에는 `gates.json`이 아직 없으므로 자리표시자를 채워 넣는다 —
 * `implement.v1`의 `gates`는 존재와 `status` 열거만 보므로(§schemas) 후보 선택 결과는 동일하다.
 * 읽지 못하면 `null`이고, 그때는 아무것도 되돌리지 않는다(전이 요구조건이 예전처럼 판단한다).
 */
export function implementHeadShaOf({ out, transcriptText = "" } = {}) {
  const placeholder = (o) => (o && !o.gates ? { ...o, gates: { status: "GREEN", level: "unit" } } : o);
  const a = extractStageArtifact({
    envelopeResult: out?.result,
    transcriptText,
    validate: (o) => validate("implement.v1", placeholder(o)),
  });
  const sha = a.ok ? a.data?.head_sha : null;
  return typeof sha === "string" && SHA40.test(sha) ? sha : null;
}

/**
 * 위 §KTB-43의 실행부. 반환은 셋 중 하나다:
 *   `{ok:true, dropped:[]}`           — 되돌릴 것이 없다(브랜치 head가 곧 핸드오프 sha다).
 *   `{ok:true, dropped:[sha…], …}`    — 드리프트만 얹혀 있었다: reset + 리스 push까지 끝났다.
 *   `{ok:false, reason, files?}`      — 되돌리지 않는다. 사유는 그대로 전이에 실린다.
 */
export function makeDropPostHandoffDrift({ run, root, issue }) {
  return async ({ handoffSha = null, baseline = null, generated = [] } = {}) => {
    const branch = stageBranch(issue);
    const rp = await run("git", ["rev-parse", "HEAD"], { cwd: root });
    if (rp.code !== 0) return { ok: false, reason: `git rev-parse HEAD failed: ${rp.stderr?.trim() || `exit ${rp.code}`}` };
    const head = rp.stdout.trim();
    // 핸드오프의 sha를 읽지 못했으면 비교할 것이 없다 — 예전 경로 그대로(전이 요구조건이 판단한다).
    if (!handoffSha || !head || handoffSha === head) return { ok: true, dropped: [] };
    const anc = await run("git", ["merge-base", "--is-ancestor", handoffSha, "HEAD"], { cwd: root });
    if (anc.code !== 0) {
      return { ok: false, reason: `branch head ${head.slice(0, 7)} does not descend from the implement handoff's head_sha ${handoffSha.slice(0, 7)} — the stage will not rewrite a branch it cannot explain` };
    }
    const names = await run("git", ["diff", "--name-only", `${handoffSha}..${head}`], { cwd: root });
    if (names.code !== 0) return { ok: false, reason: `git diff --name-only ${handoffSha.slice(0, 7)}..${head.slice(0, 7)} failed: ${names.stderr?.trim() || `exit ${names.code}`}` };
    const files = [...new Set(names.stdout.split("\n").map((s) => s.trim()).filter(Boolean))];
    const offBaseline = files.filter((f) => !isDriftPath(f, { baseline, generated }));
    if (offBaseline.length) return { ok: false, files: offBaseline, reason: driftRefusedReason(offBaseline) };
    const rl = await run("git", ["rev-list", `${handoffSha}..${head}`], { cwd: root });
    if (rl.code !== 0) return { ok: false, reason: `git rev-list ${handoffSha.slice(0, 7)}..${head.slice(0, 7)} failed: ${rl.stderr?.trim() || `exit ${rl.code}`}` };
    const dropped = rl.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    const rs = await run("git", ["reset", "--hard", handoffSha], { cwd: root });
    if (rs.code !== 0) return { ok: false, reason: `git reset --hard ${handoffSha.slice(0, 7)} failed: ${rs.stderr?.trim() || `exit ${rs.code}`}` };
    const push = await run("git", ["push", `--force-with-lease=${branch}:${head}`, "origin", branch], { cwd: root });
    if (push.code !== 0) {
      return { ok: false, reason: `git push --force-with-lease=${branch}:${head.slice(0, 7)} refused — ${truncateReason(push.stderr?.trim() || `exit ${push.code}`)} (the branch moved under the stage; it never force-pushes without a lease)` };
    }
    return { ok: true, dropped, files, branch, from: head, to: handoffSha };
  };
}

/**
 * `run-stage.js`가 claude -p 이후, verifyStage 이전에 묻는 구조적 백스톱(ADR-020 KTB-14 — KTB-13 r1
 * 잔여 위험 등록부 gap 3을 닫는다). `reviewer-*`·`plan-*`·`factory-triage`는 `tools:`에 Bash를 들고
 * 있고, 훅(`deny-all-writes.sh`)은 **명령 모양의 열거**일 뿐이라 훅이 모르는 모양이면 그냥 통과한다
 * (KTB-13 r1). 이 체크는 모양이 아니라 **결과**(워크트리 diff)만 본다 — 어떤 셸 모양으로 만들었든
 * 스크래치 경로 밖의 변화는 전부 위반이다. `git status` 자체가 실패하면 "깨끗하다"를 증명할 수
 * 없으므로 fail-closed(`ok:false`)다 — 이 저장소의 다른 "판정 불가" 계약(`integrityCheck`의
 * `cannotCompute`, `mergeGates`)과 같다.
 */
export async function assertNoWriteStageClean({ run, cwd, allow = [], baseline = null }) {
  const r = await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd });
  if (r.code !== 0) return { ok: false, dirty: [], reason: `git status failed: ${r.stderr.trim()}` };
  // KTB-37 — `allow`는 이 런의 **overlay가 덮은 정확한 경로들**이다(팩토리가 스스로 만든 diff이지
  // 에이전트가 만든 것이 아니다). 목록은 overlay 직후에 굳고, 그 경로들이 세션 중에 **또** 바뀌지
  // 않았다는 것은 `overlayDrift`가 sha와 직접 비교해 따로 증명한다 — 여기서 넓게 열어 주는 것은
  // `.claude/**`가 아니라 그 순간 덮인 파일 이름들뿐이다.
  const allowed = new Set(allow);
  // KTB-39 — `baseline`은 **스테이지가 시작할 때 이미 있던** diff다(= `[runtime].setup`이 만든 것).
  // 면제는 경로 이름이 아니라 **그 경로가 아직 그때 그 모양일 때**만 성립한다: 상태 문자가 바뀌었거나
  // (unstaged → staged) diff 지문이 움직였으면 세션이 그 위에 더 쓴 것이므로 다시 더럽다.
  const base = new Map((baseline?.entries || []).map((e) => [e.path, e.code]));
  let now = new Map();
  if (base.size) {
    const f = await diffFingerprint({ run, cwd, paths: [...base.keys()] });
    // 지문을 다시 읽지 못하면 "그대로다"를 증명할 수 없다 — 판정 불가는 깨끗함이 아니다(fail closed).
    if (!f.ok) return { ok: false, dirty: [], reason: f.reason };
    now = f.map;
  }
  const unchanged = (p, code) => base.get(p) === code && statOf(now, p) === statOf(baseline?.stat, p);
  const dirty = new Set();
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const code = line.slice(0, 2);
    for (const p of pathsOfStatusLine(line)) {
      if (!p || isScratchPath(p) || allowed.has(p)) continue;
      if (base.has(p) && unchanged(p, code)) continue;
      dirty.add(p);
    }
  }
  return { ok: dirty.size === 0, dirty: [...dirty] };
}

/**
 * ADR-020 KTB-29 — **리뷰 라운드 예산이 다 됐는가.** 셋이 모두 참일 때만 참이다: K가 실제 정수 한도이고,
 * 라운드 번호를 알고 있고(`reviewRounds`가 세어 준 값 — 에이전트의 자기 신고가 아니다), 그 라운드가
 * K에 **도달**했다. `>=`인 이유: 라운드 K의 리뷰가 또 reject이면 다음 rework은 라운드 K+1이 되고,
 * 그건 스펙 §3.2가 "round > K"로 금지한 바로 그 지점이다 — 예산을 다 쓴 것은 지금이다.
 */
export const reviewRoundsExhausted = (data, maxRounds) =>
  Number.isInteger(maxRounds) && maxRounds >= 1 && Number.isInteger(data?.round) && data.round >= maxRounds;
/**
 * 사람이 읽는 한 줄이자 전이 코멘트의 사유 — 남은 must_fix 개수가 "무엇이 안 끝났는가"의 요약이다.
 *
 * r1 nit 9: `must_fix`는 **이 런이 verdict를 집계했을 때만** 찬다(에이전트가 `decision`을 직접 실어
 * 보내면 비어 있다). 그때 "0 must_fix remain"은 "아무 문제도 없다"로 읽히는데 사람을 부르는 문장이다 —
 * 비어 있으면 개수 대신 **판정 자체**를 말한다.
 */
export const reviewExhaustedReason = (data, maxRounds) => {
  const n = (data?.must_fix || []).length;
  const tail = n ? `${n} must_fix remain` : `last verdict: ${data?.decision ?? "unknown"}`;
  return `review rounds exhausted (K=${maxRounds}): ${tail}`;
};

/**
 * ADR-020 KTB-29 / 관측 O21 — 앞 라운드의 역할별 verdict와 이번 것을 비교해 뒤집힌 것만 뽑는다
 * (`correctness approve→reject`). 앞 라운드에 없던 역할은 뒤집힘이 아니다(비교 대상이 없다).
 */
export function reviewFlips(prev, now) {
  const before = new Map((prev || []).filter((v) => v?.role).map((v) => [v.role, v.verdict]));
  return (now || [])
    .filter((v) => v?.role && before.has(v.role) && before.get(v.role) !== v.verdict)
    .map((v) => `${v.role} ${before.get(v.role)}→${v.verdict}`);
}

export function nextState(stage, data, { maxRounds = null } = {}) {
  if (stage === "triage") return { ready: "factory:ready", "needs-info": "factory:needs-info", "wont-do": "factory:wont-do" }[data.disposition];
  if (stage === "review") {
    if (data.decision === "approved") return "factory:approved";       // 통과하는 리뷰에 K는 걸리지 않는다
    return reviewRoundsExhausted(data, maxRounds) ? "factory:needs-human" : "factory:rework";
  }
  return NEXT_OF[stage];
}

/**
 * 전이 요구조건에 커밋/PR을 실제로 묶는다. 게이트는 "무엇을 검사했는가"를 알아야만 물린다.
 * gh 호출이 실패하면 sha 없이(undefined) 돌려주고 record()로 흔적을 남긴다 — 런을 죽이지 않는다.
 */
export async function buildCtxExtra({ gh, issue, to, data, ctx, record = () => {}, reviewRoster = null, maxRounds = null, qaEvidence = null, qaManifestRecorded = null }) {
  // K(`charter.limits.K`)는 `factory:approved`로는 오지 않는다(ADR-020 KTB-29 r1 SF1) — 전이 요구조건은
  // approve를 라운드로 막지 않고, K는 `nextState`가 rework 판정에서만 쓴다.
  //
  // 외부 감사 2026-09-14 H1c — **`factory:merged`만 예외다.** merge는 script-only라 `buildContext`를
  // 거치지 않으므로 `ctx`가 null이고, 그러면 `roster`/`rosterSize`가 undefined가 되어 정족수 검사가
  // 통째로 무음이 된다(규칙은 있는데 잴 자가 없다). 그래서 merge 경로에서는 호출자가 CHARTER에서
  // 직접 읽은 로스터와 K를 넘긴다 — 되돌릴 수 없는 전이가 그 둘을 실제로 묻게.
  const roster = ctx?.roster ?? reviewRoster ?? undefined;
  const ctxExtra = { issue, roster, expectedRounds: ctx?.rounds, rosterSize: roster?.length };
  if (to === "factory:merged" && Number.isInteger(maxRounds)) ctxExtra.maxRounds = maxRounds;
  try {
    if (to === "factory:awaiting-review") {
      ctxExtra.headSha = await gh.branchHeadSha(`claude/fq-${issue}`);
    } else if (to === "factory:approved" || to === "factory:merged") {
      const pr = latestHandoff(await gh.comments(issue), "implement")?.data?.pr ?? data?.pr;
      if (pr == null) record(`commit binding: no PR number in the implement handoff — prHeadSha unchecked for ${to}`);
      else { ctxExtra.pr = pr; ctxExtra.prHeadSha = await gh.prHeadSha(pr); }   // pr은 머지 게이트(checks)가 다시 쓴다
    }
  } catch (e) {
    record(`commit binding: lookup failed for ${to} — ${e?.message || e}`);
  }
  /**
   * ADR-024 / KTB-42 — 승인 앞에서는 **매니페스트 파일 자신**이 재료다(review 스테이지는 그것을 읽을 수
   * 있다). 머지 앞에서는 읽을 수 없으므로 run 기록의 지문을 그대로 싣는다 — 무엇을 실을 수 있는지가
   * 다르지 그 판정이 다른 게 아니다(`lib/requirements.js` qaEvidenceGate).
   */
  if (to === "factory:approved" && typeof qaEvidence === "function") {
    try { ctxExtra.qaEvidence = await qaEvidence({ headSha: ctxExtra.prHeadSha ?? ctxExtra.headSha ?? null }); }
    catch (e) { record(`qa evidence: lookup failed for ${to} — ${e?.message || e}`); }
  }
  if (qaManifestRecorded) ctxExtra.qaManifestRecorded = qaManifestRecorded;
  return ctxExtra;
}

/**
 * 머지 직전에만 묻는 두 가지: PR의 체크가 전부 통과했는가, 보호 경로 무결성이 지켜졌는가.
 * 조회 자체가 실패하면 플래그를 **세우지 않는다** — requirements가 "확인되지 않음"을 거부로 다룬다(fail closed).
 */
export async function mergeGates({ gh, root, harness, pr, prHeadSha, base, readFile, record = () => {}, runner = run, required = null }) {
  const out = {};
  try {
    if (pr == null) record("merge gate: no PR number in the implement handoff — checks unverified");
    else out.checksGreen = allChecksGreen(await gh.prChecks(pr), required);
  } catch (e) { record(`merge gate: gh pr checks failed — ${e?.message || e}`); }
  try {
    // 무결성은 **머지될 커밋**에 대한 주장이어야 한다. 로컬 워크트리가 PR head가 아니면
    // 여기서 통과시킨 GREEN은 다른 트리 얘기다 — 검사하지 않은 것으로 친다.
    const head = (await runner("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    if (!prHeadSha || head !== prHeadSha) {
      record(`integrity: local HEAD != PR head (local ${head.slice(0, 7) || "unknown"}, pr ${prHeadSha ? prHeadSha.slice(0, 7) : "unknown"})`);
      out.integrityGreen = false;
    } else {
      out.integrityGreen = (await integrityCheck({ run: runner, cwd: root, base, harness, readFile })).ok;
    }
  } catch (e) { record(`merge gate: integrity check failed — ${e?.message || e}`); }
  return out;
}

/**
 * review·merge가 게이트를 돌릴 커밋을 implement handoff의 head_sha에 고정한다. PR이 그 사이
 * 움직였으면(추가 커밋·force-push) 검증하지 않은 코드를 검증한 것으로 속지 않도록 거부한다.
 * detach checkout이라 로컬 브랜치를 건드리지 않는다 — mergeBase()는 이후 지연 계산되어 이 HEAD를 본다.
 */
/**
 * 외부 감사 2026-09-14 M13 — 이 스테이지가 **이번 차례에** 같은 head sha로 이미 handoff를 남겼는가.
 * 남겼다면 이 런은 중복이다(락은 *동시* 러너만 막는다 — 끝난 런의 락은 이미 풀려 있다).
 *
 * "이번 차례"의 경계가 이 함수의 전부다. 창은 두 번 잘린다:
 *  1. 마지막 재큐(`→ factory:queue`) — KTB-25와 같은 이유로, 되돌아온 이슈는 새 사이클이다.
 *  2. **이 스테이지의 진입 라벨로 들어온 마지막 전이** — 이것이 없으면 재작업이 통째로 죽는다:
 *     review가 rework를 띄우면 PR head는 아직 그대로이므로, 이전 implement handoff의 head sha가
 *     현재 head와 같아 "이미 끝났다"로 읽힌다. `→ factory:rework` 전이가 그 handoff보다 뒤에
 *     있으므로, 그 자리에서 창을 자르면 재작업은 정상적으로 돌고 **같은 차례의** 재점화만 걸린다.
 *
 * head sha가 없으면(그 스테이지가 head를 적지 않거나 PR이 아직 없으면) 비교할 것이 없으므로 null —
 * 없는 근거로 런을 지우지 않는다.
 */
export function completedForHead({ comments, stage, headSha, entryLabels = ENTRY_LABELS[stage] || [] }) {
  if (typeof headSha !== "string" || !headSha) return null;
  const since = commentsSinceRequeue(Array.isArray(comments) ? comments : []);
  let from = 0;
  since.forEach((c, i) => {
    const m = TRANSITION_TO.exec(String(c?.body ?? ""));
    if (m && entryLabels.includes(m[2])) from = i + 1;
  });
  const hs = parseHandoffs(since.slice(from)).filter((h) => h.stage === stage && h.data?.head_sha === headSha);
  if (!hs.length) return null;
  return { head: headSha, at: hs[hs.length - 1].createdAt ?? null };
}

export function makeCheckoutHead({ gh, run, root, issue }) {
  return async () => {
    const handoff = latestHandoff(await gh.comments(issue), "implement");
    if (!handoff?.data?.head_sha) return { ok: false, reason: "implement handoff missing" };
    const { head_sha, pr } = handoff.data;
    if (pr == null) return { ok: false, reason: "implement handoff has no PR number" };
    let currentSha;
    try { currentSha = await gh.prHeadSha(pr); }
    catch (e) { return { ok: false, reason: `gh pr view failed: ${e?.message || e}` }; }
    if (currentSha !== head_sha) {
      return { ok: false, reason: `PR head moved since implement handoff (${head_sha.slice(0, 7)} → ${currentSha.slice(0, 7)})` };
    }
    const fetch = await run("git", ["fetch", "origin", `claude/fq-${issue}`], { cwd: root });
    if (fetch.code !== 0) return { ok: false, reason: `git fetch failed: ${fetch.stderr.trim()}` };
    const checkout = await run("git", ["checkout", "--detach", head_sha], { cwd: root });
    if (checkout.code !== 0) return { ok: false, reason: `git checkout failed: ${checkout.stderr.trim()}` };
    return { ok: true, sha: head_sha, pr };
  };
}

/** implement가 쓰는 브랜치 이름. 이름을 한 군데서만 만든다 — 체크아웃·사후 확인·컨텍스트가 같은 문자열을 봐야 한다. */
export const stageBranch = (issue) => `claude/fq-${issue}`;

/**
 * ── ADR-023 Task 8b — **브랜치 체크아웃은 스테이지의 것이다** ─────────────────────────────────────
 * Task 8(KTB-37)은 스테이지 **시작** 시점의 팩토리 설정을 base로 고정했지만, implement의 rework
 * 라운드는 빌더가 `claude -p` 세션 **안에서** 자기 브랜치를 체크아웃했다 — 커맨드 템플릿이 규칙 1로
 * 그렇게 지시했다. `--settings`와 훅 **배선**은 세션 시작 시점의 것으로 굳지만 훅 **스크립트**는
 * 호출마다 디스크에서 읽히고, `.claude/settings*.json`·`CLAUDE.md`·`.factory/**`도 마찬가지로
 * 그 순간부터 PR의 것이 된다. 곧 overlay가 깔아 둔 base 설정이 세션 중간에 통째로 갈렸다.
 *
 * 그래서 체크아웃을 스테이지가 한다: 원격에 브랜치가 있으면 fetch 후 `checkout -B`(지난 라운드
 * 위에 정확히 선다), 없으면 스테이지 **자신의 커밋**에서 새로 만든다. 그다음이 overlay이고, 그다음이
 * 빌더다 — 이 순서가 이 Task의 전부다.
 *
 * **로컬에만 있는 브랜치는 건드리지 않는다**(fail closed): 원격에 없는데 로컬에 있다는 것은 지난
 * 라운드의 push가 실패했거나 사람이 뭔가 하고 있다는 뜻이고, `-B`는 그것을 말없이 지운다.
 */
export function makeCheckoutBranch({ run, root, issue, env = process.env, defaultBranch = () => "main" }) {
  return async () => {
    const branch = stageBranch(issue);
    const s = await resolveStageSha({ run, root, env, defaultBranch: typeof defaultBranch === "function" ? defaultBranch() : defaultBranch });
    if (!s.ok) return { ok: false, reason: s.reason };
    // "원격에 있는가"를 fetch의 종료 코드로 묻지 않는다 — 네트워크 실패와 "없는 브랜치"가 같은 코드로
    // 오고, 그 둘을 섞으면 rework 라운드가 조용히 새 브랜치로 시작해 지난 라운드의 작업을 버린다.
    const ls = await run("git", ["ls-remote", "--heads", "origin", branch], { cwd: root });
    if (ls.code !== 0) return { ok: false, reason: `git ls-remote failed for ${branch}: ${ls.stderr?.trim() || `exit ${ls.code}`}` };
    if (ls.stdout.trim()) {
      // refspec을 명시해 원격 추적 ref를 확실히 세운다(`FETCH_HEAD`만으로는 `-B`의 출발점이 모호하다).
      const f = await run("git", ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: root });
      if (f.code !== 0) return { ok: false, reason: `git fetch failed for ${branch}: ${f.stderr?.trim() || `exit ${f.code}`}` };
      const co = await run("git", ["checkout", "-B", branch, `origin/${branch}`], { cwd: root });
      if (co.code !== 0) return { ok: false, reason: `git checkout -B ${branch} failed: ${co.stderr?.trim() || `exit ${co.code}`}` };
      const m = await mergeBaseIntoBranch({ run, root, branch, sha: s.sha, source: s.source, env });
      if (!m.ok) return m;
      return { ok: true, branch, base: `origin/${branch}`, existed: true, merged: m.merged, source: s.source };
    }
    const local = await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root });
    if (local.code === 0) {
      return { ok: false, reason: `${branch} exists locally (${local.stdout.trim().slice(0, 7)}) but not on origin — refusing to reset a branch whose commits were never pushed` };
    }
    const co = await run("git", ["checkout", "-b", branch, s.sha], { cwd: root });
    if (co.code !== 0) return { ok: false, reason: `git checkout -b ${branch} ${s.sha.slice(0, 7)} failed: ${co.stderr?.trim() || `exit ${co.code}`}` };
    return { ok: true, branch, base: s.sha, source: s.source, existed: false };
  };
}

/**
 * ── KTB-38 — **낡은 PR 위에서 도는 rework는 base의 도구를 들고 돌아야 한다** ─────────────────────
 * 실측(KTB #3 R5, 2026-09-14): PR #4의 head는 1.2.0 **이전**이라 `factory/bin/lint.js`가 트리에 없었다.
 * 그런데 overlay가 깔아 준 base의 `.factory/harness.toml`은 바로 그 파일을 부르는 lint 명령을 들고 있다 —
 * 게이트가 통째로 RED였고, 빌더는 자기 diff와 무관한, 자기가 고칠 수도 없는 실패를 라운드마다 다시 봤다.
 * Task 8이 설정을 base로 고정한 순간부터 이것은 구조적 결과다: **설정은 base인데 트리는 낡은 PR**이면
 * 그 둘이 가리키는 파일 집합이 갈라진다.
 *
 * 그래서 rework 라운드 **전에** 스테이지가 base를 브랜치로 머지한다. 머지 대상은 `origin/<base>`가
 * **아니라 스테이지 자신의 커밋(`s.sha`)**이다 — overlay가 덮는 커밋과 같아야 하기 때문이다. 그 사이
 * main이 더 나갔다면 `origin/main`은 overlay의 sha보다 **앞서 있고**, 그것을 머지하면 트리의 팩토리
 * 경로가 overlay의 sha와 달라져 overlay가 그것을 되돌리고, 그 되돌림이 다시 "덮을 것이 있다 → blocked"이
 * 된다. 한 런 안에서 base는 하나다.
 *
 * 충돌은 스테이지가 풀 일이 아니다: `git merge --abort`으로 트리를 되돌리고 **판정 불가**로 멈춘다
 * (`factory:blocked` cause `undecidable`) — 사람이 리베이스한다. 머지 커밋은 팩토리의 것이고
 * (`user.name factory`), 빌더가 뜨기 **전에** push한다: 빌더가 아무것도 바꾸지 않는 라운드에도 PR head는
 * 그 머지를 반영해야 하고(그래야 review·merge가 같은 트리를 본다), 빌더의 push는 빌더의 커밋만 싣는다.
 */
export async function mergeBaseIntoBranch({ run, root, branch, sha, source = "base", env = process.env }) {
  // "이미 base를 들고 있는가"를 머지의 출력으로 묻지 않는다 — 물어보고 나서 머지하면 빈 머지 커밋도
  // push도 생기지 않는다(라운드마다 의미 없는 커밋이 쌓이는 것은 그 자체로 diff를 읽기 어렵게 한다).
  const anc = await run("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: root });
  if (anc.code === 0) return { ok: true, merged: null };
  // 1 = "조상이 아니다"(정상 답). 그 밖은 답이 아니라 고장이다 — 판정할 수 없으면 진행하지 않는다.
  if (anc.code !== 1) return { ok: false, reason: `cannot tell whether ${branch} already carries ${sha.slice(0, 7)} (${source}) — git merge-base --is-ancestor: ${anc.stderr?.trim() || `exit ${anc.code}`}` };
  const bot = (env?.FACTORY_BOT_LOGIN || "").trim();
  const ident = ["-c", "user.name=factory", "-c", `user.email=${bot ? `${bot}@users.noreply.github.com` : "factory-bot@users.noreply.github.com"}`];
  const mg = await run("git", [...ident, "merge", "--no-edit", "--no-ff", sha], { cwd: root });
  if (mg.code !== 0) {
    const ab = await run("git", ["merge", "--abort"], { cwd: root });
    return {
      ok: false,
      undecidable: true,
      reason: `stale PR conflicts with base — rebase by hand (merging ${sha.slice(0, 7)} (${source}) into ${branch} conflicted${ab.code === 0 ? ", merge aborted" : `; git merge --abort also failed: ${ab.stderr?.trim() || `exit ${ab.code}`}`})`,
    };
  }
  const push = await run("git", ["push", "origin", branch], { cwd: root });
  if (push.code !== 0) return { ok: false, reason: `git push origin ${branch} failed after merging base ${sha.slice(0, 7)} — ${push.stderr?.trim() || `exit ${push.code}`}` };
  return { ok: true, merged: sha };
}

/** run 기록의 한 줄 — 누가 어디에서 이 브랜치를 세웠는가. */
export const branchLine = (cb) =>
  `branch: ${cb.branch} checked out by the stage from ${cb.existed ? cb.base : `${String(cb.base).slice(0, 7)} (${cb.source || "base"}, new branch)`} — the builder never runs git checkout/switch`;

/** KTB-38 — 이 라운드가 어떤 base 위에서 돌았는지. 머지가 실제로 붙은 라운드에만 나온다. */
export const baseMergedLine = (cb) =>
  `base_merged: ${String(cb.merged).slice(0, 7)} (${cb.source || "base"}) merged into ${cb.branch} by the stage and pushed before the builder — the PR tree carries base's tooling`;

/**
 * ADR-023 Task 8b — 세션이 끝난 뒤에도 **여전히 그 브랜치 위인가**, 그리고 팩토리 설정은 여전히
 * 스테이지 커밋의 것인가. 훅이 브랜치 이동을 막지만 훅이 못 보는 철자는 언제나 남는다(런타임 조립) —
 * 이것은 그 뒤에 서는 구조적 백스톱이다. `git rev-parse --abbrev-ref HEAD` 자체가 실패하거나 HEAD가
 * detach면(`HEAD`) 증명할 수 없는 것이고, 이 저장소에서 판정 불가의 자리는 `factory:blocked`다.
 */
export async function assertStageBranch({ run, cwd, issue, sha, harnessIssue = false }) {
  const branch = stageBranch(issue);
  const r = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  if (r.code !== 0) return { ok: false, reason: `git rev-parse --abbrev-ref HEAD failed: ${r.stderr?.trim() || `exit ${r.code}`}` };
  const at = r.stdout.trim();
  if (at !== branch) return { ok: false, reason: `the session left ${branch} — HEAD is now ${at || "(empty)"}, so the factory config on disk was no longer the stage's from that moment on` };
  if (!sha) return { ok: true, branch: at };
  // harness 이슈는 overlay가 애초에 덮지 않은 경로(`HARNESS_OPENS`)를 세션 뒤에도 묻지 않는다 —
  // 빌더가 그 파일을 고치는 것이 그 이슈의 일이다(§overlayPathspecs).
  const drift = await overlayDrift({ run, cwd, sha, harnessIssue });
  if (!drift.ok) return { ok: false, reason: drift.reason || `factory config changed during the stage: ${drift.paths.join(", ")}` };
  return { ok: true, branch: at };
}

/**
 * ADR-020 KTB-37 — **스테이지는 PR의 코드를 돌지만, 팩토리 자신의 설정은 스테이지 자신의 커밋(base)의
 * 것이어야 한다.** 위 `makeCheckoutHead`가 워킹 트리를 PR head로 detach하고 나면, 그 트리에 있는
 * `.factory/ci-settings.json`(`claude -p --settings`가 읽는 L2 deny 목록) · `.claude/hooks/*`(PreToolUse
 * 훅) · `.claude/agents/*`(리뷰어 프롬프트) · `.claude/settings.json` · `docs/factory/CHARTER.md`는 전부
 * **PR의 것**이다. 결과는 두 가지였다(KTB #3 → harness #9, 2026-09-14):
 *   ① main의 하네스 수정(KTB-36의 deny 예외)보다 앞선 head를 가진 PR은 그 수정을 **영원히 못 받는다** —
 *      리뷰는 낡은 설정으로 돌고, 같은 실패를 반복한다.
 *   ② 에이전트 PR이 훅·settings·리뷰어 프롬프트·`.factory/lib/*`를 고치면 **자기 리뷰가 그 변조된
 *      설정으로 실행된다**(보호 경로는 *머지*를 사람 손에 맡길 뿐, 스테이지는 이미 돌아 버린 뒤다).
 * 그래서 체크아웃 직후 팩토리 소유 경로만 스테이지의 커밋에서 덮어쓴다 — 워크플로의 스크럽/정리 스텝이
 * 같은 이유로 이미 하고 있는 `git checkout ${{ github.sha }} -- .factory`의 일반화다. 스테이지 산출물
 * (`.factory/out/**`)은 제외한다: 그건 이 런이 지금 만들고 있는 것이지 설정이 아니다.
 * 실패하면 스테이지는 진행하지 않는다(fail closed) — "확인되지 않은 설정"은 설정이 아니다.
 */
/**
 * ── 리뷰 batch-1 MF-3 — **세션 설정은 이름이 아니라 기능으로 정해진다.** ─────────────────────────
 * `CLAUDE.md`·`.mcp.json`·`AGENTS.md`는 `OVERLAY_ROOTS` 밖이었고, `OVERLAY_PATHSPECS` 밖이라
 * `overlayDrift`도 보지 못했고, `[protected]`에도 없었다 — 곧 **PR head가 통째로 쥐고 있는** 파일인데
 * `claude -p` 세션은 cwd가 저장소 루트라 그것들을 프로젝트 지시문(CLAUDE.md)·프로젝트 MCP 서버
 * (.mcp.json)로 그대로 읽는다. PR 하나가 리뷰 세션에 "이 PR을 승인하라"를 적어 넣을 수 있었고, 그
 * 파일이 보호 경로가 아니라서 **그 PR은 자동 머지까지 됐다** — KTB-37이 닫으려던 그 구멍이 파일
 * 세 개만큼 열려 있었던 것이다. 이 저장소에는 아직 그 파일들이 없어서 아무 것도 깨지지 않았다(latent).
 * `.claude/settings.local.json`은 `.claude/` 아래라 이미 덮인다.
 */
/**
 * ── 리뷰 batch-2 MF-3 — **세션 설정 파일은 루트에만 있는 것이 아니다.** ──────────────────────────
 * batch-1은 그 셋을 루트 이름(`CLAUDE.md`)으로 적었다. 그런데 Claude Code는 세션이 건드리는 디렉터리의
 * `CLAUDE.md`/`AGENTS.md`를 함께 읽고(리뷰 세션은 정의상 소스 디렉터리를 건드린다), `CLAUDE.local.md`
 * 같은 변형도 읽는다. 재리뷰가 확인한 결과: `docs/CLAUDE.md`·`src/AGENTS.md`는 overlay 밖, drift 검사
 * 밖, `[protected]` 밖, `Write()` deny 밖이었고 tier는 `docs`로 떨어졌다 — 곧 주입 채널은 그대로
 * 열려 있었고, 그 PR은 가장 가벼운 심사를 받았다.
 * 그래서 세 이름을 **깊이에 무관한 글롭**으로 표현한다. git 쪽은 `:(glob)` pathspec(루트도 매치),
 * harness `[protected].factory`·`NEVER_DOCS_GLOBS`는 같은 뜻의 깊이 무관 글롭이다.
 */
export const SESSION_CONFIG_GLOBS = ["**/CLAUDE*.md", "**/AGENTS*.md", "**/.mcp*.json"];
export const SESSION_CONFIG_PATHSPECS = SESSION_CONFIG_GLOBS.map((g) => `:(glob)${g}`);
/** 같은 집합을 **경로 문자열**로 판정할 때(스테이지 커밋 스캔). git 글롭과 같은 의미다 — 루트 포함, 어느 깊이든. */
export const SESSION_CONFIG_RE = /(^|\/)(CLAUDE[^/]*\.md|AGENTS[^/]*\.md|\.mcp[^/]*\.json)$/;
export const OVERLAY_ROOTS = [".factory", ".claude", "docs/factory/CHARTER.md"];
export const OVERLAY_EXCLUDE = ":(exclude).factory/out";
export const OVERLAY_PATHSPECS = [".factory", OVERLAY_EXCLUDE, ".claude", "docs/factory/CHARTER.md", ...SESSION_CONFIG_PATHSPECS];
/**
 * ── ADR-023 Task 8b 후속 — **하네스 이슈의 rework는 자기 `harness.toml`을 지킨다** ───────────────
 * Task 8b가 체크아웃을 스테이지에게 준 뒤 하나가 뒤집혔다: `factory:harness` 이슈의 rework 라운드는
 * **정의상** `.factory/harness.toml`을 고친 브랜치 위에서 돈다(그 파일을 고치는 것이 그 이슈의 일이다).
 * overlay가 그것을 base로 되돌리면 `overlaidPaths`가 비지 않고, implement의 "덮을 것이 있으면 빌더를
 * 띄우지 않는다" 규칙이 **모든** 하네스 rework를 막는다 — 승격이 1라운드 안에 끝나지 못하면 영원히
 * 끝나지 못한다(그리고 하네스 승격은 게이트를 새로 세우는 일이라 대개 1라운드에 끝나지 않는다).
 *
 * 그래서 harness 모드에서는 overlay가 `HARNESS_OPENS`를 **덮지 않는다** — 열린 목록이 한 곳
 * (`protected-paths.js`)에서 나오므로 L2 deny(`ci-settings-harness.json`)·훅 `prot`·overlay가 같은
 * 문장을 말한다. 나머지는 그대로다: 훅 스크립트·settings·에이전트 프롬프트·ci-settings·CHARTER·세션
 * 설정(CLAUDE.md/AGENTS.md/.mcp.json)은 여전히 스테이지 자신의 커밋에서 덮인다.
 *
 * **무엇이 지키는가**: harness.toml 안의 위험한 섹션은 L1이 본다(Task 1의 섹션 검사 —
 * `[protected]`·`[gates.thresholds]`·`[load_bearing]`을 건드린 PR은 사람이 머지한다). 그리고 이
 * 스테이지가 자기 판정에 쓰는 harness는 이미 메모리에 있다(`charterReady`가 체크아웃 **전에**,
 * 곧 스테이지 자신의 커밋에서 읽었다) — 브랜치의 harness.toml이 이 런의 게이트 임계값이나 보호 목록을
 * 바꾸지는 못한다.
 */
export const harnessOpenExcludes = () => HARNESS_OPENS.map((g) => `:(exclude,glob)${g}`);
export const overlayPathspecs = (harnessIssue = false) => (harnessIssue ? [...OVERLAY_PATHSPECS, ...harnessOpenExcludes()] : OVERLAY_PATHSPECS);
export const OVERLAY_LABEL = `.factory/** (except .factory/out/**), .claude/**, docs/factory/CHARTER.md, ${SESSION_CONFIG_GLOBS.join(", ")}`;
/** overlay가 손대는 스테이지 — PR 콘텐츠가 워킹 트리에 올 수 있는 셋. triage·plan은 PR 이전이라 언제나 base 위에 있다. */
const OVERLAY_STAGES = new Set(["implement", "review", "merge"]);
const SHA40 = /^[0-9a-f]{40}$/;

/** 이 스테이지 **자신의** 커밋. CI는 `GITHUB_SHA`(이벤트 sha = 기본 브랜치 tip), 로컬은 `origin/<default>`. */
export async function resolveStageSha({ run, root, cwd = root, env = process.env, defaultBranch = "main" }) {
  const fromEnv = env?.GITHUB_SHA;
  // 40-hex가 아니면 거부한다 — ref 이름은 나중에 `git checkout <rev> -- <pathspec>`의 <rev> 자리에
  // 들어가고, 그 자리는 모호하면 안 된다(같은 이름의 파일이 있으면 git이 되묻는 자리다).
  if (fromEnv) return SHA40.test(fromEnv) ? { ok: true, sha: fromEnv, source: "GITHUB_SHA" } : { ok: false, reason: `GITHUB_SHA is not a 40-hex sha: ${fromEnv}` };
  const ref = `origin/${defaultBranch}`;
  const r = await run("git", ["rev-parse", ref], { cwd });
  const sha = r.stdout.trim();
  if (r.code !== 0 || !SHA40.test(sha)) return { ok: false, reason: `cannot resolve the stage sha (${ref}): ${r.stderr?.trim() || "no such ref"}` };
  return { ok: true, sha, source: ref };
}

/**
 * ── 리뷰 batch-1 잠정 tier 바닥(Task 4까지) ──────────────────────────────────────────────────────
 * 리뷰 로스터의 크기가 곧 정족수이고, 그 크기는 tier가 정한다. tier가 **triage 에이전트의 자기
 * 신고**에서만 나오면 낮춰 신고하는 것만으로 로스터와 정족수가 함께 줄어든다(감사 H3). `gates.js`는
 * 이미 `tier_effective = maxTier(declared, tierFloor(diff))`를 계산해 `.factory/out/gates.json`에
 * 적어 두는데 아무도 읽지 않았다 — 여기서 **최대치**를 취한다: 자기 신고는 tier를 올릴 수는 있어도
 * 내릴 수는 없다. 바닥이 없으면(게이트 파일이 없는 경로) 오늘의 동작 그대로 신고값이다.
 */
export const reviewTier = ({ claimed, floor }) => (floor ? maxTier(claimed, floor) : claimed);

export function makeFactoryOverlay({ run, root, env = process.env, defaultBranch = () => "main", harnessIssue = false }) {
  return async (harnessMode = harnessIssue) => {
    const branch = typeof defaultBranch === "function" ? defaultBranch() : defaultBranch;
    // harness 모드에서 열리는 경로는 **브랜치의 것으로 남는다**(§overlayPathspecs). 네 자리가 전부
    // 같은 목록을 써야 한다: 덮는 checkout, PR이 추가한 파일 스캔, 무엇이 덮였나 status, 그리고 drift.
    const specs = overlayPathspecs(harnessMode);
    const excludes = harnessMode ? harnessOpenExcludes() : [];
    const s = await resolveStageSha({ run, root, env, defaultBranch: branch });
    if (!s.ok) return { ok: false, reason: s.reason };
    // 이 커밋이 실제로 들고 있는 경로만 pathspec에 넣는다 — 없는 경로 하나가 `git checkout`을 통째로
    // 실패시키고(`error: pathspec … did not match`), 어댑터 레포는 `.claude/`가 없을 수 있다.
    const present = [];
    for (const p of OVERLAY_ROOTS) {
      const e = await run("git", ["cat-file", "-e", `${s.sha}:${p}`], { cwd: root });
      if (e.code === 0) present.push(p);
    }
    /**
     * 리뷰 batch-2 MF-3 — 세션 설정 파일은 **어느 깊이에나** 있을 수 있으므로 이름으로 물을 수 없다.
     * 스테이지 커밋의 트리를 한 번 훑어 실제 경로를 뽑는다(`git ls-tree`는 `:(glob)` 매직을 받지
     * 않는다 — 그래서 스캔은 여기서 하고, 아래 diff/status만 glob pathspec을 쓴다).
     * 스캔이 실패하면 진행하지 않는다(fail closed): 무엇을 덮어야 하는지 모르는 overlay는 overlay가 아니다.
     */
    const tree = await run("git", ["ls-tree", "-r", "--name-only", s.sha], { cwd: root });
    if (tree.code !== 0) return { ok: false, reason: `overlay session-config scan failed (${s.sha.slice(0, 7)} ${s.source}): ${tree.stderr?.trim() || `exit ${tree.code}`}` };
    const sessionConfig = tree.stdout.split("\n").map((l) => l.trim()).filter((l) => l && SESSION_CONFIG_RE.test(l));
    if (present.length === 0 && sessionConfig.length === 0) return { ok: false, reason: `the stage sha ${s.sha.slice(0, 7)} (${s.source}) carries none of ${OVERLAY_LABEL}` };
    const pathspecs = [...present.flatMap((p) => (p === ".factory" ? [p, OVERLAY_EXCLUDE] : [p])), ...sessionConfig, ...excludes];
    const co = await run("git", ["checkout", s.sha, "--", ...pathspecs], { cwd: root });
    if (co.code !== 0) return { ok: false, reason: `overlay checkout failed (${s.sha.slice(0, 7)} ${s.source}): ${co.stderr?.trim() || `exit ${co.code}`}` };
    /**
     * ── 리뷰 batch-1 MF-3 — **overlay는 "덮어쓰기"가 아니라 "그 커밋과 바이트 동일하게 만들기"다.**
     * `git checkout <sha> -- <pathspec>`은 그 커밋에 **있는** 경로만 되돌린다 — PR이 **새로 추가한**
     * 파일(`.claude/hooks/evil.sh`, `.claude/settings.local.json`, 또는 main에 없던 `CLAUDE.md`)은
     * 그대로 남는다. 재리뷰가 스크래치 저장소에서 실제로 확인한 결과다. 그 파일들은 나중에
     * `overlayDrift`에 잡히지만 **그때는 `claude -p`가 이미 그 설정으로 돌고 난 뒤**였다(세션 379행,
     * 클린 체크 390행) — 런은 멈추지만 리뷰의 판단은 주입된 설정 아래에서 형성된 뒤다.
     * 그래서 여기서 지운다. pathspec은 `present`가 아니라 **전체 목록**이다: 스테이지 커밋에 없는
     * 경로야말로 PR이 새로 들여온 경로이고, `present` 필터를 그대로 쓰면 정확히 그 구멍이 남는다.
     * `git diff`는 매치되지 않는 pathspec에 대해 실패하지 않는다(`checkout`과 다르다).
     * 지우지 못하면 **진행하지 않는다**(fail closed) — 확인되지 않은 설정은 설정이 아니다.
     */
    const added = await run("git", ["diff", "--name-only", "--diff-filter=A", s.sha, "--", ...specs], { cwd: root });
    if (added.code !== 0) return { ok: false, reason: `overlay added-file scan failed: ${added.stderr?.trim() || `exit ${added.code}`}` };
    const extras = added.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (extras.length) {
      const rm = await run("git", ["rm", "-f", "--quiet", "--", ...extras], { cwd: root });
      if (rm.code !== 0) return { ok: false, reason: `overlay could not remove ${extras.length} PR-added factory-owned path(s) (${extras.slice(0, 5).join(", ")}): ${rm.stderr?.trim() || `exit ${rm.code}`}` };
    }
    // 무엇이 실제로 덮였는가 — 한 줄 로그의 재료이자, 쓰기 금지 스테이지의 클린 체크에 넘길 허용 목록이다.
    const st = await run("git", ["status", "--porcelain", "--untracked-files=all", "--", ...specs], { cwd: root });
    if (st.code !== 0) return { ok: false, reason: `overlay status failed: ${st.stderr?.trim() || `exit ${st.code}`}` };
    const paths = new Set(extras);
    for (const line of st.stdout.split("\n").filter(Boolean)) for (const p of pathsOfStatusLine(line)) if (p) paths.add(p);
    /**
     * 리뷰 batch-1 MF-3 — drift 검사를 **`claude -p` 앞에서도** 한 번 돌린다. 지금까지 이 검사는
     * 세션이 끝난 뒤에만 돌았고(`assertCleanWorktree`), 그래서 overlay가 놓친 것이 있어도 세션은
     * 이미 그 설정으로 돌아 버렸다. 여기서 GREEN이라는 것은 "지금 트리의 팩토리 소유 경로가 스테이지
     * 커밋과 바이트 동일하다"는 뜻이고, 그것이 overlay가 약속한 전부다.
     */
    const drift = await overlayDrift({ run, cwd: root, sha: s.sha, harnessIssue: harnessMode });
    if (!drift.ok) return { ok: false, reason: drift.reason || `the overlay did not make the factory-owned paths identical to ${s.sha.slice(0, 7)}: ${drift.paths.join(", ")}` };
    return { ok: true, sha: s.sha, source: s.source, paths: [...paths], removed: extras, harnessIssue: harnessMode };
  };
}

/**
 * overlay가 깔아 둔 팩토리 설정이 세션 **뒤에도** 그 커밋의 것 그대로인가. 클린 체크에 넘기는 허용
 * 목록(overlay가 덮은 경로들)이 에이전트의 세션 중 수정까지 덮어 주면 안 되므로, 그 경로들만 sha와
 * 직접 비교한다. `git diff` 자체가 실패하면 "그대로다"를 증명할 수 없으므로 fail closed다.
 */
export async function overlayDrift({ run, cwd, sha, harnessIssue = false }) {
  const r = await run("git", ["diff", "--name-only", sha, "--", ...overlayPathspecs(harnessIssue)], { cwd });
  if (r.code !== 0) return { ok: false, paths: [], reason: `overlay drift check failed: ${r.stderr?.trim() || `exit ${r.code}`}` };
  const paths = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return paths.length === 0 ? { ok: true, paths: [] } : { ok: false, paths };
}

/** run 기록의 한 줄 — 무엇을, 어느 커밋에서 덮었는지. */
export const overlayLine = (ov) => {
  // harness 이슈에서는 무엇이 **열려 있었는지**도 같은 줄에 적는다 — 나중에 이 런을 읽는 사람이
  // "왜 저 파일은 base로 돌아가지 않았나"를 되짚을 자리가 여기뿐이다.
  const scope = `[${OVERLAY_LABEL}${ov.harnessIssue ? ` — harness issue: ${HARNESS_OPENS.join(", ")} left to the branch` : ""}]`;
  return ov.paths?.length
    ? `overlay: ${ov.paths.length} path(s) from ${ov.sha.slice(0, 7)} (${ov.source || "base"}) — ${ov.paths.slice(0, 10).join(", ")}${ov.paths.length > 10 ? ", …" : ""} ${scope}`
    : `overlay: clean — factory config already at ${ov.sha.slice(0, 7)} (${ov.source || "base"}) ${scope}`;
};

/**
 * 로컬 진입(§4.2.5): `factory run triage <issue>`가 락을 먼저 잡았을 때만 의미가 있다 — main()이
 * `FACTORY_LOCAL_ENTRY=1`을 심어야 켜진다(GitHub 이벤트로 뜬 triage 잡은 이 env가 없다). backlog
 * 라벨만 있고 아직 factory 상태 라벨이 없는 이슈에 한해 factory:queue로 스스로 밀어 넣고 전이
 * 마커 코멘트를 남긴다 — 락은 이미 이 프로세스가 쥐고 있으므로, 라벨 이벤트로 따라 뜨는 GitHub의
 * triage 잡은 claim에 실패해 exit 0으로 물러난다(의도된 설계, 중복 실행 방지).
 */
export function makeLocalEntry({ gh, issue, stage, env, rehearsal = null }) {
  return async () => {
    if (!env?.FACTORY_LOCAL_ENTRY || stage !== "triage") return null;
    const it = await gh.issue(issue);
    // "backlog" is itself a member of STATES (lib/labels.js) — factoryLabelOf(labels) never returns
    // null while "backlog" is present, it returns "backlog" itself. So this only fires when the
    // issue's current STATE is exactly "backlog" — an unlabeled issue (no STATES label at all,
    // factoryLabelOf → null) is deliberately NOT auto-queued (fix round 1 ruling: strict match, no
    // null disjunct). Two STATE labels at once (an invalid label combo) makes factoryLabelOf throw —
    // that's not swallowed here, the caller's best-effort catch (run-stage.js runStage) records it.
    if (factoryLabelOf(it.labels) === "backlog") {
      /**
       * KTB-44 / ADR-025 (리뷰 r2 nf-2) — **이 자리도 리허설을 지난다.** 여기는 `transition()`을 거치지
       * 않는 유일한 큐 진입이었고(라벨을 직접 쓴다), 그래서 `transition.js <n> factory:queue --human`은
       * 거부당하는데 `factory run triage <n>`은 통과하는 비대칭이 있었다 — 그 뒤로 plan·implement·review는
       * **러너에서** 한 번도 리허설하지 않은 하네스 위로 간다. 정확히 own-calendar의 실패다.
       * `transition()`으로 우회하지 않는 이유는 그 함수가 요구조건 검사와 두 번째 전이 코멘트를 더하기
       * 때문이다 — 같은 검사기를 부르고 같은 문장으로 거부하는 것으로 충분하다.
       */
      const r = await rehearsal?.();
      if (!r || r.ok !== true) return `local entry refused: ${r?.reason || REHEARSAL_UNWIRED}`;
      await gh.setFactoryLabel(issue, "factory:queue");
      await gh.comment(issue, "<!-- factory-transition:v1 from=backlog to=factory:queue by=local -->\nbacklog → factory:queue — claimed locally first (§4.2.5)");
      return "local entry: backlog → factory:queue";
    }
    return null;
  };
}

/** CLI 진입: 실제 의존성 조립 */
async function main() {
  const argv = process.argv.slice(2);
  const [stage, issueArg] = argv;
  const issue = Number(issueArg);
  // KTB-24 — `--aborted <job.status>`. 값이 빠지면(`--aborted`만) "cancelled"로 읽는다: 이 스텝은
  // 취소된 잡의 짧은 유예 안에서만 도는데, 인자 하나 때문에 usage로 죽으면 정리가 통째로 사라진다.
  const abortedAt = argv.indexOf("--aborted");
  const abortedStatus = abortedAt === -1 ? null : (argv[abortedAt + 1] || "cancelled");
  if (!stage || !issue || !STAGES.includes(stage)) { console.error(`usage: run-stage <${STAGES.join("|")}> <issue> [--aborted <job status>]`); process.exit(1); }
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
  const runnerId = process.env.FACTORY_RUNNER_ID || `local/${hostname()}`;
  const gh = makeGh({ run, repo });
  // 정리 경로는 CHARTER도 harness도 읽지 않는다 — 읽을 것이 하나라도 깨져 있으면 고아 락이 그대로
  // 남고, 이 스텝의 존재 이유가 사라진다(fail open이 옳은 유일한 자리다: 아무것도 판정하지 않는다).
  if (abortedStatus !== null) {
    process.exit(await abortStage({
      stage, issue, status: abortedStatus, runnerId,
      deps: {
        issueLabels: async () => (await gh.issue(issue)).labels,
        transition: ({ to, reason, cause }) => transition({ gh, issue, to, reason, cause, stage }),
        /** KTB-24 fix: 락을 지우기 전에 **누구 것인지** 묻는다 — 이 정리 스텝은 claim에 실패한 런에서도 돈다. */
        lockHolder: () => lockHolder({ run, cwd: root, issue }),
        release: () => release({ run, cwd: root, issue }),
        runRecord: (lines) => appendRunRecord({ root, issue, title: "", stage, runnerId, lines }),
        syncRecords: () => syncRecords({ run, cwd: root, message: `run-record: issue #${issue} ${stage} aborted (${runnerId})` }),
      },
    }));
  }
  let charter, harness, ctxCache;                                     // CHARTER는 dormancy 판정에서만 읽는다 — 없거나 깨져도 잠들 뿐 터지지 않는다
  const recordLine = (line) => { try { appendRunRecord({ root, issue, title: ctxCache?.issue?.title || "", stage, runnerId, lines: [line] }); } catch {} };
  const readFile = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const readJson = (p) => { try { const t = readFile(p); return t ? JSON.parse(t) : null; } catch { return null; } };
  const gatesPath = join(root, ".factory/out/gates.json");
  let baseSha = null;                                                 // 한 런 안에서 base는 하나다 — 두 번 물어보면 두 답이 나올 수 있다
  let overlaySha = null;                                              // KTB-37 — overlay가 설정을 가져온 커밋(세션 뒤 drift 비교의 기준)
  const mergeBase = async () => {
    if (baseSha) return baseSha;
    const branch = harness.project?.default_branch ?? "main";
    const r = await run("git", ["merge-base", `origin/${branch}`, "HEAD"], { cwd: root });
    const sha = r.stdout.trim();
    if (r.code !== 0 || !sha) throw new MergeBaseError(`origin/${branch}: exit ${r.code} ${r.stderr.trim()}`.trim());
    return (baseSha = sha);
  };
  const runStartedAt = new Date().toISOString();                      // 이 런의 시작 — progress:v1의 `started`
  /**
   * ADR-024 / KTB-42 — qa 증거 매니페스트의 요약. 재료는 **전부 러너가 이미 들고 있는 것**이다:
   * 계획의 `done_when`, 하네스의 성숙도, implement handoff의 커밋, triage의 영향 경로. 로스터에 qa가
   * 없으면 아무것도 요구하지 않는다(`skipped`) — 부르지 않은 사람이 남기지 않은 증거는 결함이 아니다.
   */
  const qaEvidenceSummary = ({ headSha = null } = {}) => {
    const roster = Array.isArray(ctxCache?.roster) ? ctxCache.roster : [];
    if (!roster.includes("qa")) return { ok: true, skipped: "roster has no qa — no manifest required", claimIds: [] };
    return evidenceFor({
      root, issue,
      doneWhen: ctxCache?.handoffs?.plan?.done_when ?? [],
      maturity: ctxCache?.harness?.maturity ?? "M0",
      touchesData: touchesDataPaths(ctxCache?.handoffs?.triage?.impact_paths ?? []),
      headSha: headSha ?? ctxCache?.handoffs?.implement?.head_sha ?? null,
    });
  };
  /**
   * KTB-44 / ADR-025 — **이 프로세스의 리허설 검사기는 하나다**(최종 리뷰 A-nit 2). 예전에는 같은
   * 리터럴이 네 자리(로컬 진입·flaky 수확·step 9 주차 해제·아래 `deps.transition`)에 따로 적혀 있었고,
   * 넷이 갈릴 수 있었다 — 갈리는 방향은 언제나 "한 자리만 배선을 잃는" 쪽이다(B-MF1이 정확히 그
   * 모양이었다: 네 번째 자리에 아무것도 없었다).
   */
  const rehearsal = makeRehearsalChecker({ gh, root, branch: () => harness?.project?.default_branch || "main" });   // 지연: harness는 charterReady에서 읽힌다
  const deps = {
    // 잠드는 건 정상 동작이지만 "왜" 잠들었는지는 반드시 말한다 — 조용한 dormancy가 가장 오래 걸리는 버그다.
    charterReady: async () => {
      try { charter = loadCharter(root); }
      catch (e) { console.error("factory: CHARTER.md unreadable — " + e.message); return false; }
      // 게이트가 하네스 없이 돌 수는 없다 — 판정할 수 없으면 진행하지 않고 잠든다.
      try { harness = loadHarness(root); }
      catch (e) { console.error("factory: .factory/harness.toml unreadable — " + e.message); return false; }
      if (charter.status !== "ready") { console.error(`factory: CHARTER status is ${charter.status} — dormant`); return false; }
      return true;
    },
    backPressure: () => backPressure({ gh, charter, quarantine: loadQuarantine(root), thresholds: harness.gates.thresholds }),
    trustWorkspace: () => trustWorkspace({ root }),
    claim: () => claim({ run, cwd: root, issue, stage, runnerId }),
    // KTB-44 (r2 nf-2): 로컬 진입도 다른 네 생산자와 **같은** 검사기를 지난다.
    localEntry: makeLocalEntry({ gh, issue, stage, env: process.env, rehearsal }),
    /** 진입 상태 가드(KTB-10)의 재료 — 지금 이 순간 이슈에 붙어 있는 라벨 이름들. */
    issueLabels: async () => (await gh.issue(issue)).labels,
    /** blocked 재시도 가드 전용(KTB-15b I2) — 지금의 factory:blocked이 마지막으로 어느 스테이지의
     * 어떤 라벨에서 왔는지(`{from, stage}`), `factory-blocked-origin` 마커에서 읽는다. */
    blockedOrigin: async () => blockedOrigin(await gh.comments(issue)),
    /**
     * ADR-022 — 하트비트가 이제 진행 신호를 싣는다. `progress`는 **함수로** 넘긴다: 매 틱 새로
     * 읽어야 하고(`readProgress`가 마지막으로 읽은 오프셋부터 이어 읽는다), 던져도 하트비트는
     * 죽지 않는다(`startHeartbeat`가 삼킨다 — 그 주기는 예전의 두 줄짜리 본문으로 나간다).
     */
    progress: () => readProgress({ root, stage, issue, runner: runnerId, started: runStartedAt }),
    heartbeat: () => startHeartbeat({ gh, issue, stage, runnerId, progress: () => deps.progress() }),
    assertHandoff: async () => {
      const target = Object.entries(STAGE_OF_TARGET).find(([, s]) => s === prevStage(stage))?.[0];
      if (!target) return { ok: true };
      // prerequisite:true — 선행 handoff 확인은 직전 스테이지의 산출물이 있는지만 본다. 이번 런의
      // 게이트도 sha 바인딩도 아직 존재하지 않는다(resetGates가 방금 지웠다). § requirements.gatesGate
      const req = requirementFor(target)({ issue, prerequisite: true, comments: await gh.comments(issue) });
      if (!req.ok) { await transition({ gh, issue, to: "factory:needs-human", reason: `prerequisite handoff missing: ${req.reason}` }); }
      return req;
    },
    /**
     * KTB-39 — 스테이지 시작 시점의 워크트리 스냅샷(= `[runtime].setup`이 남긴 것). 클린 체크의
     * 기준선이고, implement에서는 복원 목록이다.
     */
    setupBaseline: () => snapshotSetupDirty({ run, cwd: root }),
    restoreSetupDirty: makeRestoreSetupDirty({ run, root }),
    checkoutHead: makeCheckoutHead({ gh, run, root, issue }),
    /**
     * ADR-023 Task 8b — implement의 브랜치는 스테이지가 체크아웃한다(빌더가 아니라). `harness`는
     * charterReady에서 이미 로드됐다 — overlay와 같은 기본 브랜치를 늦게 읽는다.
     */
    checkoutBranch: async () => {
      const cb = await makeCheckoutBranch({ run, root, issue, env: process.env, defaultBranch: () => harness?.project?.default_branch ?? "main" })();
      return cb;
    },
    /** 세션 뒤: HEAD가 아직 그 브랜치이고 팩토리 설정이 아직 스테이지 커밋의 것인가(fail closed). */
    assertStageBranch: async (harnessIssue = false) => assertStageBranch({ run, cwd: root, issue, sha: overlaySha, harnessIssue }),
    /**
     * KTB-43 — 세션 산출물이 적은 `head_sha`. 게이트 **전에** 읽어야 하므로 `verifyStage`를 기다리지
     * 않고 같은 추출기를 한 번 더 돌린다(후보 채점은 동일하다 — §implementHeadShaOf).
     */
    handoffHeadSha: (out) => (stage === "implement" ? implementHeadShaOf({ out, transcriptText: transcriptTextFor(root, out) }) : null),
    /** KTB-43 — 핸드오프 뒤에 붙은 드리프트 전용 커밋을 떨어뜨린다(리스 없는 force는 없다). */
    dropPostHandoffDrift: async ({ handoffSha, baseline }) => makeDropPostHandoffDrift({ run, root, issue })({
      handoffSha, baseline,
      generated: Array.isArray(harness?.runtime?.setup_generated) ? harness.runtime.setup_generated : [],
    }),
    /**
     * ADR-020 KTB-37 — 체크아웃된 트리 위에 팩토리 소유 설정만 스테이지 자신의 커밋에서 덮는다.
     * `harness`는 charterReady에서 이미 로드됐다 — 기본 브랜치는 그때 굳은 값을 늦게 읽는다.
     */
    overlayFactoryConfig: async (harnessIssue = false) => {
      const ov = await makeFactoryOverlay({ run, root, env: process.env, defaultBranch: () => harness?.project?.default_branch ?? "main", harnessIssue })();
      if (ov.ok) overlaySha = ov.sha;
      return ov;
    },
    /**
     * ADR-020 KTB-14 — 쓰기 금지 스테이지의 구조적 백스톱. review는 checkoutHead가 이미 detach해 둔 PR head를 그대로 본다.
     * KTB-37: overlay가 덮은 경로(`allow`)는 팩토리가 만든 diff라 더러움으로 세지 않는다 — 대신 그
     * 경로들이 세션 중에 **또** 바뀌지 않았는지를 sha와 직접 비교해 확인한다(`overlayDrift`, fail closed).
     */
    assertCleanWorktree: async (allow = [], baseline = null) => {
      const clean = await assertNoWriteStageClean({ run, cwd: root, allow, baseline });
      if (!clean.ok || !overlaySha) return clean;
      const drift = await overlayDrift({ run, cwd: root, sha: overlaySha });
      return drift.ok ? clean : { ok: false, dirty: drift.paths, reason: drift.reason || `factory config changed during the stage: ${drift.paths.join(", ")}` };
    },
    /**
     * 감사 H3 — 컨텍스트는 `run`/`base`를 받아야 tier 바닥(diff)을 계산할 수 있다. base를 못 구하는
     * 것은 판정 불가이지 "바닥 없음"이 아니지만, **여기서** 스테이지를 죽이지는 않는다: 곧이어 도는
     * `gates` dep이 같은 `mergeBase()`로 MergeBaseError를 올려 `factory:blocked`로 보낸다(게이트가 없는
     * triage/plan은 애초에 diff를 판정 재료로 쓰지 않는다). 대신 그 사실을 런 레코드에 남긴다.
     */
    buildContext: async ({ setupDirty = null } = {}) => {
      let base = null;
      try { base = await mergeBase(); }
      catch (e) { if (!isMergeBaseError(e)) throw e; recordLine("tier: merge-base unresolved — tier floor not computed (gates will block)"); }
      return (ctxCache = await buildContext({ root, gh, issue, stage, run, base, setupDirty }));
    },
    /** 지난 런의 SubagentStart/Stop 기록이 이번 런의 로스터 체크를 대신 만족시키면 안 된다. */
    resetAgentsLog: async () => { rmSync(join(root, ".factory/out/agents.jsonl"), { force: true }); },
    /** 지난 런의 게이트 판정 파일과 그 재료(테스트·커버리지·mutation 리포트)도 마찬가지다 — 스테이지 첫 전이보다 먼저 지운다. */
    resetGates: async () => { resetGateOutputs({ root, harness }); },
    /**
     * **이번 주기에 실제로 끝난 rework 라운드 수**(r1 SF2). 두 가지가 범위를 정한다:
     *   - KTB-25: 마지막 재큐(`… to=factory:queue`) **이후**만 센다 — 재큐는 새 주기의 시작이고, 그 앞의
     *     라운드는 다른 코드에 대한 판정이라 이번 K 예산에 실리면 안 된다(데모 #18: 통째로 재실행된
     *     이슈의 첫 리뷰가 round 2로 시작해 K=3 중 2를 이미 쓴 상태였다).
     *   - r1 SF2: 세는 것은 **완료된 `→ factory:rework` 전이**다(handoff가 아니다). handoff는 전이보다
     *     먼저 나가므로, 전이가 실패한 런은 재작업을 한 적이 없는데도 예산을 쓰고 있었다.
     */
    reviewRounds: async () => countTransitionsTo(commentsSinceRequeue(await gh.comments(issue)), "factory:rework"),
    /**
     * KTB-29 / 관측 O21: 이번 주기(마지막 재큐 이후)의 **직전** review handoff가 실은 역할별 verdict.
     * `reviewRounds`와 같은 창을 본다 — 재큐 이전 라운드는 다른 코드에 대한 판정이라 "뒤집혔다"고
     * 셀 수 없다. 없으면 null(첫 라운드) — `reviewFlips`가 빈 배열로 받는다.
     */
    priorReviewVerdicts: async () => latestHandoff(commentsSinceRequeue(await gh.comments(issue)), "review")?.data?.verdicts ?? null,
    ciSettingsPresent: async (harnessIssue = false) => existsSync(join(root, ciSettingsFile(harnessIssue))),
    /** KTB-23 implement 전용: `harness_needed`가 차 있을 때 여는(또는 재사용하는) `factory:harness` 이슈. */
    ensureHarnessIssue: ({ entries, pr }) => ensureHarnessIssue({ gh, issue, entries, pr }),
    claudeP: async (_ctx, { harnessIssue = false } = {}) => {
      const args = stageClaudeArgs({ root, stage, issue, harness, charter, harnessIssue });
      const r = await run("claude", args, { cwd: root, env: stageClaudeEnv({ root, stage, harnessIssue }) });
      mkdirSync(join(root, ".factory/out"), { recursive: true });     // 파싱에 실패해도 원본 stdout은 남긴다
      writeFileSync(join(root, ".factory/out", `${stage}.json`), r.stdout);
      // envelope을 이름 붙여 한 벌 더 남긴다 — `<stage>.json`은 산출물 추출이 성공하면 그 객체로
      // 덮이지만(KTB-7), usage·cost는 envelope에만 있으므로 사후 조사에 둘 다 필요하다.
      writeFileSync(join(root, ".factory/out", `${stage}.envelope.json`), r.stdout);
      try { return JSON.parse(r.stdout); } catch { return { is_error: true, result: r.stdout + r.stderr }; }
    },
    /**
     * 게이트 판정은 여기서 딱 한 번 만들어 파일로 굳힌다 — handoff·전이·사람이 모두 같은 파일을 본다.
     * merge는 buildContext를 거치지 않으므로(script-only) ctx가 없다 — tier는 triage handoff의
     * 자기 신고에서 읽고, 그마저 없으면 CHARTER의 기본값으로 fail closed 대신 보수적으로 채운다.
     */
    gates: async (ctx) => {
      if (!GATED_STAGES.has(stage)) return null;
      const tier = stage === "merge" ? (latestHandoff(await gh.comments(issue), "triage")?.data?.tier ?? charter.tier_default) : ctx.tier;
      const result = await runStageGates({
        run, cwd: root, harness, stage, tier, base: await mergeBase(), quarantine: loadQuarantine(root), gh, issue, readFile,
        saveQuarantine: (q) => writeQuarantine(root, q),
        // KTB-44 / ADR-025 — 수확된 flaky 이슈는 `backlog`로 태어나 **게이트를 지나** 큐로 간다.
        transitionIssue: ({ issue: n, to, reason }) => transition({ gh, issue: n, to, reason, stage, rehearsal }),
      });
      mkdirSync(join(root, ".factory/out"), { recursive: true });
      writeFileSync(gatesPath, JSON.stringify(result, null, 2));
      console.log(verdictLine(result));
      return result;
    },
    /**
     * ADR-024 / KTB-42 — 리뷰가 시작되기 전에 "증거를 남길 수 있는가"를 **실물로** 확인한다.
     * 도구가 설치돼 있으면 그 도구를 부른다(리뷰어가 부를 바로 그 명령이라, 여기서 통과한 것은
     * 세션 안에서도 통과한다). 아직 `--upgrade`하지 않은 저장소를 위해 같은 확인을 in-process로도
     * 할 수 있게 해 둔다 — 도구가 없다는 이유로 리뷰를 blocked으로 세우는 것은 이 확인의 목적이 아니다.
     */
    qaEvidenceProbe: async () => {
      let roles = null;
      try { const r = await deps.reviewRoster(); if (r?.ok && Array.isArray(r.roles)) roles = r.roles; }
      catch { /* 로스터를 모르면 그냥 프로브한다 — 프로브는 싸고, 실패는 언제나 진짜 신호다 */ }
      if (roles && !roles.includes("qa")) return { ok: true, line: "qa evidence probe: skipped — this tier's roster has no qa" };
      /**
       * 리뷰 라운드 1 SF-4 — 도구는 **작업 트리가 아니라 이 스크립트 옆에서** 푼다. overlay가 보통
       * `.factory/**`를 스테이지 자신의 커밋으로 되돌리지만, `git checkout <base> -- .factory`는 PR head가
       * **새로 추가한** 파일을 지우지 않는다 — 그리고 그 "아직 업그레이드하지 않은" 상태가 이 코드가
       * 대비하는 바로 그 상태다. 그 자리에서 작업 트리의 경로를 실행하면 러너가 PR이 쓴 코드를
       * 러너의 환경으로 돌린다(KTB-37이 닫은 구멍의 다른 철자). `import.meta.url`은 지금 돌고 있는
       * run-stage 자신의 위치이고, 그 옆의 파일은 정의상 팩토리의 것이다.
       */
      // 재리뷰 MF — `fileURLToPath`이지 `.pathname`이 아니다(퍼센트 인코딩: `/sp ace/` → `/sp%20ace/`).
      // 그리고 **조용히 폴백하지 않는다**: 우리 자신의 디렉터리조차 없다고 나오면 그것은 "설치되지
      // 않았다"가 아니라 경로가 망가졌다는 뜻이고, 그 상태에서 in-process 프로브가 `ok`를 찍으면
      // "qa가 쓸 수 있는가"를 묻는 유일한 검사가 초록을 보고하는 동안 `record`는 죽어 있게 된다.
      const toolDir = dirname(fileURLToPath(import.meta.url));
      if (!existsSync(toolDir)) {
        return { ok: false, reason: `the factory's own bin directory does not resolve (${toolDir}) — refusing to fall back silently, because a mangled path would make this probe report ok while the tool cannot run` };
      }
      const tool = join(toolDir, "qa-evidence.js");
      if (!existsSync(tool)) {
        const p = probeEvidenceDir({ root, issue });
        return p.ok
          ? { ok: true, line: `qa evidence probe: ok (in-process — ${tool} is not installed; run \`npx know-thy-build factory init --upgrade\`)` }
          : { ok: false, reason: p.reason };
      }
      const res = await run("node", [tool, "probe", "--issue", String(issue)], { cwd: root });
      if (res.code !== 0) return { ok: false, reason: (res.stderr || res.stdout).trim().split("\n").filter(Boolean).pop() || `qa-evidence.js probe exited ${res.code}` };
      return { ok: true, line: `qa evidence probe: ok — ${qaDirRel(issue)} is writable` };
    },
    /** 매니페스트 요약(§qaEvidenceSummary) — review 스테이지의 기록과 `factory:approved` 요구조건이 함께 읽는다. */
    qaEvidence: async ({ headSha = null } = {}) => qaEvidenceSummary({ headSha }),
    verifyStage: ({ out, gates }) => {
      // 감사 M1 — NEVER_AUTOMATE의 글롭 항목은 CHARTER에서 그대로 온다(컨텍스트를 거치지 않는다:
      // 이 재확인의 요점은 에이전트가 본 것과 **독립적인** 출처라는 데 있다).
      const v = verifyStage({ stage, out, transcriptText: transcriptTextFor(root, out), agentsLog: readAgentsLog(join(root, ".factory/out/agents.jsonl")), roster: ctxCache.roster, rolePrefix: ROLE_PREFIX[stage] || "", expectedRounds: ctxCache.rounds, orchestration: ctxCache.orchestration, gates, planLimits: ctxCache.plan, issueBody: ctxCache.issue?.body, neverAutomate: charter.never_automate, qaManifest: stage === "review" ? qaEvidenceSummary() : null });
      // 추출에 성공했으면 `<stage>.json`을 **산출물**로 덮는다 — 사람과 다음 도구가 여는 파일이
      // 디스패처의 산문 섞인 envelope이 아니라 스테이지가 실제로 쓴 객체이도록(envelope은 옆에 남아 있다).
      if (v.ok && v.data) { try { writeFileSync(join(root, ".factory/out", `${stage}.json`), JSON.stringify(v.data, null, 2)); } catch { /* 기록 실패가 스테이지를 죽이지 않는다 */ } }
      return v;
    },
    /**
     * 감사 H3 — handoff에는 **러너가 계산한** 실효 tier를 함께 싣는다(`tier_effective`/`tier_source`).
     * 에이전트가 적는 `tier`는 자기 신고이고, 이 둘은 diff에서 나온 사실이다: 다음 스테이지와 사람이
     * 같은 코멘트에서 "무엇으로 채점됐는가"를 읽을 수 있어야 한다. 스키마는 추가 필드를 막지 않는다.
     */
    writeHandoff: async ({ data }) => {
      const d2 = ctxCache?.tier_effective ? { ...data, tier_effective: ctxCache.tier_effective, tier_source: ctxCache.tier_source } : data;
      await gh.comment(issue, renderHandoff({ stage, issue, summary: d2.summary || `### ${stage} 완료`, data: d2 }));
    },
    /** triage 전용(KTB-9): 판정된 tier를 라벨로 내보낸다 — 다른 `factory:tier-*`는 같은 호출에서 떨어진다. */
    setTierLabel: (tier) => gh.setTierLabel(issue, tierLabel(tier)),
    /** merge stage 전용: PR이 열려 있는지, 충돌은 없는지 — implement handoff에 적힌 PR을 조회한다. */
    prInfo: async () => {
      const h = latestHandoff(await gh.comments(issue), "implement");
      return h?.data?.pr == null ? null : gh.prView(h.data.pr);
    },
    /**
     * 감사 M13 — "이 스테이지가 **이 head로** 이미 끝났는가". head는 PR의 라이브 head다(핸드오프가
     * 적어 둔 값이 아니라): 재점화된 런이 보는 것과 같은 사실이어야 중복인지 아닌지가 갈린다.
     * PR이 없는 스테이지(triage·plan)는 비교할 head가 없어 이 가드가 돌지 않는다 — 그쪽은 진입
     * 라벨 가드가 같은 사고를 이미 막는다(전이가 라벨을 옮기므로).
     */
    duplicateRun: async () => {
      const comments = await gh.comments(issue);
      const impl = latestHandoff(comments, "implement");
      const pr = impl?.data?.pr ?? null;
      if (pr == null) return null;
      const head = await gh.prHeadSha(pr);
      return completedForHead({ comments, stage, headSha: head });
    },
    /**
     * merge stage 전용: 필수 체크 + 무결성. checkoutHead가 이미 로컬 HEAD를 implement handoff의
     * head_sha로 고정해뒀지만, 여기서도 PR head를 **다시** 라이브로 물어본다 — checkoutHead 이후
     * PR이 또 움직였으면(추가 커밋) 그 드리프트를 여기서 잡아 integrityGreen을 세우지 않는다.
     */
    mergeGates: async () => {
      const h = latestHandoff(await gh.comments(issue), "implement");
      const pr = h?.data?.pr ?? null;
      let prHeadSha;
      try { if (pr != null) prHeadSha = await gh.prHeadSha(pr); }
      catch (e) { recordLine(`merge gate: gh pr view failed — ${e?.message || e}`); }
      return mergeGates({ gh, root, harness, pr, prHeadSha, readFile, record: recordLine, base: await mergeBase(), required: harness?.factory?.required_checks ?? null });
    },
    /**
     * merge stage 전용(KTB-5): PR 범위(base...HEAD)에서 `[protected].factory` 경로를 센다 →
     * 하나라도 있으면 merge-stage가 자동 머지를 거부하고 `needs-human`으로 넘긴다.
     *
     * **base 브랜치의 코드로 계산된다.** `protectedPaths`는 이 프로세스가 시작될 때 — 즉
     * checkoutHead가 워킹 트리를 PR head로 옮기기 **전**, 워크플로의 기본 체크아웃(base 브랜치)
     * 상태에서 — import된 모듈이고, `harness`도 그 시점의 `charterReady`가 읽었다. 그래서 PR이
     * 자기 `.factory/lib/integrity.js`나 `harness.toml [protected]`를 고쳐도 이 판정은 바뀌지
     * 않는다. 같은 이유로 하위 프로세스(`node .factory/bin/integrity.js`)를 부르지 않는다 —
     * 그건 체크아웃된 트리, 곧 PR의 코드를 실행하는 일이다.
     *
     * 파일 내용은 읽지 않는다 — `git diff --name-status` 하나면 "어떤 경로가 바뀌었나"는 답이 나오고,
     * 그 답만이 사람 머지 여부를 가른다(PR head 트리의 내용은 판정 재료로 쓰지 않는다).
     */
    protectedPaths: async () => {
      try { return await protectedPaths({ run, cwd: root, base: await mergeBase(), harness }); }
      catch (e) { return { ok: false, files: [], reason: `${e?.message || e}` }; }
    },
    /**
     * merge stage 전용(KTB-6): `[protected].additive_only` 규칙(`.claude/agents/*.md`의 `## Examples`·
     * `## Perspectives`에 추가만)을 벗어난 역할 파일을 센다. 위의 `protectedPaths`와 같은 이유로 base
     * 브랜치의 코드·하네스로 계산하고, 섹션 판정에 필요한 파일 내용은 **워킹 트리가 아니라**
     * `git show <rev>:<file>`로 읽는다 — checkoutHead 뒤의 트리는 PR의 것이다.
     */
    policyViolations: async () => {
      /**
       * 감사 H5 — 기존 테스트의 수정·삭제도 이 dep이 실어 온다. 예외 표식(`tests_changed_allowed:`)은
       * **이슈 본문**에서만 읽는다: PR diff 안에 있으면 그 PR이 스스로를 허가하게 된다. 본문을 못 읽으면
       * 빈 문자열이고, 그때는 허가가 없는 것으로 친다(fail closed — 사람이 머지한다).
       */
      let issueBody = "";
      try { issueBody = (await gh.issue(issue))?.body ?? ""; }
      catch (e) { recordLine(`policy: issue body unreadable — tests_changed_allowed ignored (${e?.message || e})`); }
      try { return await policyViolations({ run, cwd: root, base: await mergeBase(), harness, issueBody }); }
      catch (e) { return { ok: false, files: [], reason: `${e?.message || e}` }; }
    },
    /** 이슈(또는 PR — 같은 번호 공간)에 코멘트를 남긴다. KTB-18의 라벨-무효 알림과 merge stage의
     * 거부 사유(사람이 머지 버튼을 누르는 PR)·blocked-origin 마커 재게시가 모두 이걸 쓴다. */
    comment: (number, body) => gh.comment(number, body),
    /** merge stage 전용(KTB-15): implement가 연 draft PR을 머지 직전에 ready로 뒤집는다. 멱등이다. */
    prReady: (pr) => gh.prReady(pr),
    /**
     * ADR-021 — 두 배우 모드의 표식. 워크플로(`factory-merge.yml`)가 `FACTORY_TWO_ACTOR`에
     * `${{ secrets.FACTORY_MERGE_TOKEN != '' }}`를 싣는다 — **토큰 값을 한 번 더 복사하지 않고**
     * "있느냐"만 옮기는 것이 요점이다(env에 놓인 시크릿 사본은 그 자체가 유출면이다). 그래도
     * `FACTORY_MERGE_TOKEN`이 직접 env에 있는 경우(로컬 `factory run merge`, 아직 업그레이드하지
     * 않은 워크플로)도 같은 뜻으로 받는다. merge는 `claude -p`를 아예 띄우지 않는 스크립트 전용
     * 스테이지라, 이 두 값 중 어느 것도 에이전트 세션이 보는 환경에 들어가지 않는다.
     */
    get twoActor() { return process.env.FACTORY_TWO_ACTOR === "true" || Boolean(process.env.FACTORY_MERGE_TOKEN); },
    /**
     * 외부 감사 2026-09-14 H1c/H1b — 머지 직전 리뷰 검증(`merge-stage.js` §(6b))의 재료.
     *
     * merge는 script-only라 `buildContext`를 거치지 않는다 — 곧 `ctxCache`가 null이고, 전이
     * 요구조건(`requirements.js`)에 실리는 `roster`/`rosterSize`/`maxRounds`도 비어 있었다. 그것이
     * 감사 H1c의 절반이다: `factory:merged` 규칙이 정족수를 물어도 **물을 재료가 없었다.** 그래서
     * 여기서 CHARTER와 roles.toml을 직접 읽어 로스터와 K를 만든다. tier는 `gates:` dep과 같은
     * 출처다(triage handoff의 자기 신고 → 없으면 CHARTER 기본값).
     */
    reviewEvidence: async () => {
      const h = latestHandoff(await gh.comments(issue), "review");
      if (!h) return { ok: false, reason: "no review handoff on this issue" };
      if (h.issue !== Number(issue)) return { ok: false, reason: `review handoff is for issue #${h.issue}, not #${issue}` };
      const v = validate("review.v1", h.data);
      if (!v.ok) return { ok: false, reason: `review handoff invalid: ${v.errors.join("; ")}` };
      return { ok: true, data: h.data };
    },
    /**
     * 감사 H3 — 정족수의 출처인 이 로스터도 **실효 tier**로 뽑는다. 예전에는 triage handoff의 자기
     * 신고를 그대로 읽었다: "docs"라고 적힌 이슈는 리뷰어 한 명만 있으면 정족수가 찼고, 그 diff가
     * 무엇을 건드렸는지는 아무도 묻지 않았다. `resolveTier`는 `lib/context.js`의 것과 같은 함수이고,
     * 같은 diff(`base...HEAD`)를 본다 — 리뷰 스테이지의 `context.json`과 머지 스테이지의 정족수가
     * 한 규칙에서 나온다. (리뷰 batch-1의 잠정 `reviewTier(claimed, gates.json)` 바닥은 이 canonical
     * 계산으로 대체됐다 — gates.json은 PR head에서 쓰이지만 이것은 base + diff에서 도출된다.)
     */
    reviewRoster: async () => {
      // KTB-46 r3: 해석은 `lib/review-roster.js` 하나다 — sweeper의 사람-머지 반영 팔이 같은 함수를
      // 부른다(판정이 두 벌이면 한쪽 문이 조용히 싸진다). 여기만이 diff로 tier를 올릴 수 있다.
      // 코멘트 조회의 실패도 예전과 같은 문장으로 접는다(그 조회는 helper 밖에서 일어난다).
      try {
        return await resolveReviewRoster({
          charter, roles: () => loadRoles(root), comments: await gh.comments(issue),
          effectiveTier: async (tier) => resolveTier({ run, cwd: root, base: await mergeBase(), harness, tier }),
        });
      } catch (e) { return { ok: false, reason: `review roster for this tier could not be resolved — ${e?.message || e}` }; }
    },
    /**
     * 리뷰 batch-1 MF-2 — 머지 직전 §(6b2)의 재료: `factory/records` 브랜치의 run 기록에 **러너가**
     * 쓴 `review-evidence:` 줄. 브랜치를 읽지 못하는 것은 "기록이 없다"가 아니라 **판정 불가**이므로
     * `readRecordsDetailed`의 `fetched`를 그대로 fail-closed 신호로 쓴다(`readRecords`는 그 둘을
     * 구별하지 못한다 — 네트워크 실패도 빈 Map으로 보인다).
     */
    reviewRecord: async ({ runId: want = null } = {}) => {
      let det;
      try { det = await readRecordsDetailed({ run, cwd: root }); }
      catch (e) { return { ok: false, reason: `the factory/records branch could not be read — ${e?.message || e}` }; }
      if (!det?.fetched) return { ok: false, reason: "the factory/records branch could not be fetched — the review evidence is unreachable, and an unverified review is not a passed review" };
      const text = det.records.get(String(issue));
      if (!text) return { ok: false, reason: `factory/records carries no run record for issue #${issue}` };
      const rec = parseReviewEvidence(text, { runId: want });
      if (!rec) return { ok: false, reason: `the run record for issue #${issue} on factory/records carries no review-evidence line written by run ${want ?? "(unknown)"} (a line from another run, a conflicting pair of lines claiming that run, or no line at all — none of those is evidence that this review ran)` };
      return { ok: true, record: rec };
    },
    /**
     * 리뷰 batch-2 MF-2 — **어느 런이 이 이슈의 리뷰를 돌렸는가**, 기록과 무관한 자리에서 읽는다.
     * 워크플로는 매 스테이지에 `FACTORY_RUNNER_ID: gha-${{ github.run_id }}`를 심고, 하트비트 코멘트의
     * 첫 두 줄이 그 값을 그대로 싣는다(ADR-022 결정 3: 이 모양은 바뀌지 않는 계약이다). 그래서 이 값은
     * run 기록과 **다른 채널**에서 온다 — 기록 쪽을 지어내도 이 값과 맞출 수 없다.
     * 리뷰 하트비트가 없으면 통과가 아니라 **판정 불능**이다(리뷰가 돌았다는 증거가 없다).
     */
    reviewRunId: async () => {
      let comments;
      try { comments = await gh.comments(issue); }
      catch (e) { return { ok: false, reason: `the issue's comments could not be read — ${e?.message || e}` }; }
      const beats = (Array.isArray(comments) ? comments : [])
        .map((c) => parseHeartbeatComment(c?.body))
        .filter((h) => h && h.issue === Number(issue) && h.stage === "review" && h.runner);
      if (!beats.length) return { ok: false, reason: `no review-stage heartbeat on issue #${issue} — there is no independent record of which factory run produced this review` };
      const runner = beats[beats.length - 1].runner;
      const runId = runIdOfRunner(runner);
      if (!runId) return { ok: false, reason: `the review heartbeat on issue #${issue} names no runner (got "${runner}")` };
      return { ok: true, runId, runnerId: runner };
    },
    get maxRounds() { return charter?.limits?.K ?? null; },
    /** CHARTER `merge.human_gate` — 머지 전이 텍스트가 사람의 서명 유무를 소리 내어 말한다(감사 H6). */
    get humanGate() { return charter?.merge?.human_gate; },
    prHeadShaLive: (pr) => gh.prHeadSha(pr),
    commitStatuses: (sha) => gh.commitStatuses(sha),
    /** 팩토리 자신의 계정 이름(값이 아니다) — 판정과 해석은 `lib/gh.js`의 `resolveFactoryLogins` 하나다(KTB-46). */
    factoryLogins: () => resolveFactoryLogins({ gh }),
    /** ADR-021 — 머지 배우의 승인 한 번(두 배우 모드에서만, 머지 직전). `GH_TOKEN`이 머지 토큰이다. */
    approvePr: (pr) => gh.approvePr(pr),
    mergePr: (pr) => gh.mergePr(pr, { method: "squash", deleteBranch: true }),
    closeIssue: (pr) => gh.closeIssue(issue, `merged via PR #${pr}`),
    /** merge 전용(KTB-23): 이 이슈의 본문 — `Blocks: #<n>`이 있으면 하네스 이슈였다는 뜻이다. */
    issueBody: async () => (await gh.issue(issue)).body,
    /**
     * merge 전용(KTB-23): **다른** 이슈의 전이(위 `transition`은 이 이슈에 묶여 있다).
     * KTB-44 / ADR-025 — 하네스 이슈가 머지된 뒤의 주차 해제(step 9)도 리허설 게이트를 지난다:
     * 방금 머지된 것이 **하네스**라면 지문이 바뀌었고, 그 하네스는 아직 러너에서 돌아 본 적이 없다.
     * 거부되면 그 이슈는 `factory:needs-info`에 남고 sweeper가 매 주기 다시 시도한다 — 사람이
     * `factory rehearse`를 돌리는 순간 통과한다(push 트리거가 보통 그보다 먼저 돈다).
     */
    transitionOther: ({ issue: n, to, reason }) => transition({ gh, issue: n, to, reason, stage, rehearsal }),
    get defaultBranch() { return harness?.project?.default_branch ?? "main"; },
    /** merge stage 전용(KTB-19): ready 플립 뒤 필수 체크가 더 이상 진행 중이 아닐 때까지 기다리는
     * 재료 — 원시 체크 목록, 대상 이름 필터, 상한(초). `config.js`가 기본값 600을 채운다. */
    prChecks: (pr) => gh.prChecks(pr),
    get requiredChecks() { return harness?.factory?.required_checks ?? null; },
    get mergeCheckWaitSec() { return harness?.factory?.merge_check_wait_sec; },
    /** merge stage 전용: mergeability UNKNOWN 재확인 전 대기. */
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    transition: async ({ to, reason, data, mergeGatesResult, prerequisite = false, cause, qaManifestRecorded = null }) => {
      // 감사 H1c — merge 경로에는 ctx가 없다(script-only). `factory:merged` 규칙이 정족수·K를 실제로
      // 물 수 있도록 CHARTER에서 읽은 로스터와 K를 여기서 채운다(조회 실패는 fail closed로 남긴다:
      // roster가 없으면 규칙이 "roster size" 대신 개수 검사만 건너뛰는 것이 아니라, 아래
      // merge-stage §(6b)가 이미 그 전에 판정 불가로 멈춘다).
      /**
       * 최종 리뷰 B-MF2 — **`factory:approved`도 로스터를 필요로 한다.** KTB-42가 그 목적 라벨에
       * `qaEvidenceGate`를 걸었고 그 게이트는 로스터를 못 구하면 fail closed다. merge 스테이지는
       * script-only라 `ctxCache`가 없어 `buildCtxExtra`가 `roster`를 채우지 못하는데, 그 스테이지가
       * `factory:approved`를 목표로 삼는 자리가 하나 있다: KTB-15b의 blocked 재시도 복귀
       * (`merge-stage.js` (4b), 게이트를 방금 GREEN으로 다시 확인한 직후). 로스터를 안 구하면 그 hop이
       * "review roster unresolved"로 거부되고, merge 잡의 인프라 사고 한 번이 R번의 게이트 재실행과
       * 사람 에스컬레이션으로 바뀐다. 덤으로 그 hop에서 `verifyReviewQuorum`이 실제로 잴 수 있게 된다.
       */
      let reviewRoster = null;
      if (stage === "merge" && (to === "factory:merged" || to === "factory:approved")) {
        try { const r = await deps.reviewRoster(); if (r?.ok) reviewRoster = r.roles; }
        catch (e) { recordLine(`merge: roster for the ${to} requirement unresolved — ${e?.message || e}`); }
      }
      const ctxExtra = await buildCtxExtra({ gh, issue, to, data, ctx: ctxCache, record: recordLine, reviewRoster, maxRounds: charter?.limits?.K ?? null, qaEvidence: deps.qaEvidence, qaManifestRecorded });
      // 전이 경로에서만 게이트를 묻는다 — gatesChecked가 그 표식이다(선행 handoff 확인은 세우지 않는다).
      ctxExtra.gatesChecked = true;
      // blocked에서의 hop-back만 `prerequisite`를 세운다(KTB-24 fix) — "직전 스테이지의 산출물이
      // 있는가"만 묻고 이번 런의 게이트·sha 바인딩은 묻지 않는다(아직 존재하지 않는다).
      if (prerequisite) ctxExtra.prerequisite = true;
      const gatesFile = readJson(gatesPath);
      if (gatesFile) ctxExtra.gatesFile = gatesFile;                   // 워크플로의 자기 신고가 아니라 이 파일이 판정이다
      // merge stage는 이미 mergeGates()를 한 번 돌렸다 — 여기서 다시 gh를 두 번 때리지 않고 그 결과를 그대로 쓴다.
      if (to === "factory:merged") Object.assign(ctxExtra, mergeGatesResult ?? await mergeGates({ gh, root, harness, pr: ctxExtra.pr, prHeadSha: ctxExtra.prHeadSha, readFile, record: recordLine, base: await mergeBase(), required: harness?.factory?.required_checks ?? null }));
      // stage: to===factory:blocked일 때만 lib/transition.js가 origin 마커에 쓴다(KTB-15b I2).
      // cause가 명시되지 않으면 transition이 사유 문구에서 되짚는다(§blockedCause) — 명시된 자리는
      // 문구가 아니라 **판단**이 등급을 정하는 자리다(KTB-38의 stale-PR 충돌).
      /**
       * 최종 리뷰 B-MF1 — **여섯 번째 프로덕션 호출자도 배선한다.** 모든 스테이지 전이가 이 한 자리로
       * 모이고, 그중 하나는 `factory:queue`를 겨눈다: triage의 blocked 재시도 hop
       * (`BLOCKED_RETRY.triage.hop`). `transition()`은 배선되지 않은 큐 전이를 fail closed로 거부하므로
       * (`REHEARSAL_UNWIRED`) 보안 구멍은 아니지만, 배선이 없으면 그 hop이 **영원히** 거부된다 —
       * 리허설을 새로 GREEN으로 돌려도 풀리지 않는다(값이 낡은 것이 아니라 인자가 없는 것이다).
       * 다른 목적 라벨에는 비용이 0이다: `transition()`은 `to === "factory:queue"`일 때만 검사기를 부른다.
       */
      return transition({ gh, issue, to, reason, ctxExtra, stage, cause, rehearsal });
    },
    runRecord: (lines) => appendRunRecord({ root, issue, title: ctxCache?.issue?.title || "", stage, runnerId, lines }),
    hydrateRecord: () => hydrateRecord({ run, cwd: root, issue }),
    release: () => release({ run, cwd: root, issue }),
    syncRecords: () => syncRecords({ run, cwd: root, message: `run-record: issue #${issue} ${stage} (${runnerId})` }),
    reportStatus: (s) => gh.setStatus({
      ...s,
      targetUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined,
    }),
  };
  process.exit(await runStage({ stage, issue, deps, runnerId }));
}
export const PREV = { plan: "triage", implement: "plan", review: "implement", merge: "review" };
export function prevStage(stage) { return PREV[stage] || null; }

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
