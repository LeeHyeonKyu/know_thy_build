#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { makeGh, allChecksGreen } from "../lib/gh.js";
import { loadCharter, loadHarness, loadRoles, rosterFor } from "../lib/config.js";
import { loadQuarantine, saveQuarantine as writeQuarantine } from "../lib/quarantine.js";
import { backPressure } from "../lib/back-pressure.js";
import { runStageGates, verdictLine, commitStatusState } from "../lib/gates.js";
import { isGitDiffError } from "../lib/changed-files.js";
import { MergeBaseError, MERGE_BASE_BLOCKED_REASON, MERGE_BASE_ERROR_CODE, isMergeBaseError, GIT_DIFF_BLOCKED_REASON } from "../lib/blocked-errors.js";
import { integrityCheck, protectedPaths, policyViolations } from "../lib/integrity.js";
import { needsDenyAllWritesHook } from "../lib/agent-md.js";
import { claim, release, lockHolder } from "../lib/claim.js";
import { requirementFor } from "../lib/requirements.js";
import { STAGE_OF_TARGET, ENTRY_LABELS, BLOCKED_RETRY, factoryLabelOf, STATES, TIERS, tierLabel } from "../lib/labels.js";
import { HARNESS_LABEL } from "../lib/label-catalog.js";
import { harnessNeeded, ensureHarnessIssue, parkedReason } from "../lib/harness-request.js";
export { HARNESS_LABEL };   // 재수출 — retro.js와 이 값이 같은 소스에서 왔다는 것을 테스트가 import equality로 확인한다
import { buildContext } from "../lib/context.js";
import { startHeartbeat } from "../lib/heartbeat.js";
import { readProgress, progressMarker } from "../lib/progress.js";
import { readAgentsLog } from "../lib/agents-log.js";
import { verifyStage, hitMaxTurns, hitApiError, isNonTransientApiError } from "../lib/verify-stage.js";
import { readTranscript } from "../lib/stage-artifact.js";
import { aggregateReview } from "../lib/aggregate.js";
import { renderHandoff, latestHandoff } from "../lib/handoff.js";
import { validate } from "../lib/schemas.js";
import { blockedOrigin, commentsSinceRequeue, countTransitionsTo } from "../lib/retro/issue-comments.js";
import { transition } from "../lib/transition.js";
import { appendRunRecord } from "../lib/run-record.js";
import { syncRecords, hydrateRecord } from "../lib/records-branch.js";
import { trustWorkspace } from "./trust-workspace.js";
import { runMergeStage } from "../lib/merge-stage.js";

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

export function stageClaudeEnv({ root, harnessIssue = false }) {
  const env = { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", CLAUDE_PROJECT_DIR: root };
  // 훅은 `claude -p` 세션의 자식 프로세스라 이 변수를 그대로 물려받는다 — block-dangerous.sh가 이것으로
  // 보호 경로 목록을 좁힌다. 값이 정확히 "1"일 때만 선다(훅 쪽 계약).
  if (harnessIssue) env.FACTORY_HARNESS_ISSUE = "1";
  return env;
}

/** 게이트 파일이 판정을 만드는 스테이지. 여기서 gates가 null이면 판정은 워크플로의 자기 신고뿐이다. */
const GATED_STAGES = new Set(["implement", "review", "merge"]);
export const GATES_SELF_REPORTED = "gates: self-reported by workflow (no gates.json from this run — unverified)";

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

export async function runStage({ stage, issue, deps, runnerId = "unknown" }) {
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
  let checkoutSha = null;                                             // review/merge가 실제로 게이트를 돌린 PR head — review는 아래에서 런 레코드 마지막 줄에, merge는 runMergeStage로 그대로 넘겨 기록한다
  try {
    // 로컬 진입(§4.2.5): backlog 이슈를 사람이 손으로 큐에 넣기 전에 로컬에서 먼저 락을 잡았을 때,
    // triage 스테이지가 스스로 backlog → factory:queue로 밀어 넣는다 — claim 직후(라벨 이동일 뿐
    // 기록과는 무관하다. 기록 하이드레이트는 이미 charterReady 직후에 끝났다).
    // best-effort — 실패해도 흔적만 남기고 스테이지는 계속된다.
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
    // 라벨을 못 읽은 것(조회 실패)은 막지 않고 흔적만 남긴다 — 가드는 비용 방어이지 안전 게이트가
    // 아니고, 실제 안전은 뒤의 전이 그래프가 그대로 쥐고 있다. 하지만 **읽은 라벨 자체가 무효**
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
      try { labels = await d.issueLabels(); }
      catch (e) { record([`entry state: unreadable — ${e?.message || e}`]); }
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
    // KTB-37 — 체크아웃이 끝난 트리 위에 **팩토리 소유 설정만** 스테이지 자신의 커밋에서 덮는다
    // (§makeFactoryOverlay). review·merge는 방금 detach된 PR head 위에서, implement는 빌더가 돌기
    // 전에 한다. 실패는 진행이 아니라 정지다 — PR head의 훅·settings·리뷰어 프롬프트로 도는 스테이지는
    // 자기 자신을 검증하는 스테이지이고, 그건 검증이 아니다.
    if (OVERLAY_STAGES.has(stage) && d.overlayFactoryConfig) {
      const ov = await d.overlayFactoryConfig();
      if (!ov.ok) {
        // 판정 불가다(GREEN도 RED도 아니다) — 이 저장소의 그 자리는 언제나 factory:blocked이고,
        // 원인은 대개 러너 쪽이라 재시도로 풀린다.
        const t = await d.transition({ to: "factory:blocked", reason: `factory config overlay failed — ${ov.reason}` });
        record([`overlay: FAIL — ${ov.reason}`, ...refusal(t)]);
        return 2;
      }
      overlaidPaths = ov.paths || [];
      // implement는 **유일한 쓰기 스테이지**다: 여기서 overlay가 실제로 파일을 바꿨다는 것은 워크플로가
      // 준 트리가 스테이지 자신의 커밋이 아니었다는 뜻이고, 그 트리 위에서 빌더가 `git add -A`로 커밋하면
      // overlay가 PR에 실려 나간다. 그래서 덮을 것이 있으면 **빌더를 띄우지 않는다** — implement의 커밋이
      // 팩토리 설정을 담을 수 있는 경로 자체가 사라진다(정상 경로에서 이 overlay는 언제나 no-op이다).
      if (stage === "implement" && overlaidPaths.length) {
        const reason = `the implement tree is not the stage's own commit (${ov.sha.slice(0, 7)}) — the overlay would change ${overlaidPaths.length} factory-owned path(s): ${overlaidPaths.slice(0, 10).join(", ")}`;
        const t = await d.transition({ to: "factory:blocked", reason });
        record([`overlay: FAIL — ${reason}`, ...refusal(t)]);
        return 2;
      }
      record([overlayLine(ov)]);
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
    const ctx = await d.buildContext();
    await d.resetAgentsLog?.();                                       // 지난 런의 agents.jsonl이 로스터 체크를 대신 만족시키지 못하게
    const out = await d.claudeP(ctx, { harnessIssue });
    // 마지막 진행 스냅샷은 claude가 끝난 **직후**에 찍는다 — 그때 트랜스크립트는 완성돼 있고
    // 하트비트는 아직 살아 있다. 실패해도 usage 줄은 그대로 나간다(관측이 기록을 막지 않는다).
    let finalProgress = null;
    try { finalProgress = d.progress?.() ?? null; } catch { /* best-effort */ }
    const usage = usageLine(out, finalProgress);
    // 쓰기 금지 스테이지(triage/plan/review)는 claude -p가 끝나자마자, 게이트·verify보다 먼저 워크트리를
    // 다시 묻는다(ADR-020 KTB-14). implement(유일한 쓰기 스테이지)는 건너뛴다 — merge는 여기 오지도
    // 않는다(위에서 이미 return). 훅이 놓친 모양으로 어떻게 건드렸든, 스크래치 경로(`.factory/out/**`·
    // `docs/factory/runs/**`) 밖의 diff가 하나라도 있으면 그 산출물은 애초에 받아들이지 않는다 —
    // verifyStage조차 부르지 않는다.
    if (isNoWriteStage(stage)) {
      // KTB-37 — overlay가 덮은 경로는 팩토리가 만든 diff다(에이전트가 아니라). 그 목록만 허용한다.
      const clean = d.assertCleanWorktree ? await d.assertCleanWorktree(overlaidPaths) : { ok: true };
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
      const apiError = hitApiError(out);
      const blocked = hitMaxTurns(out) || (apiError && !isNonTransientApiError(out));
      const to = blocked ? "factory:blocked" : "factory:needs-human";
      const reasonPrefix = blocked ? "stage did not finish" : apiError ? "api error needs human (credentials/config)" : "stage artifact missing or invalid";
      const t = await d.transition({ to, reason: `${reasonPrefix}: ${v.reasons.join("; ")}` });
      record(["verify: FAIL", ...v.reasons.map((r) => `- ${r}`), ...refusal(t), ...gatesNote, usage]);
      return 2;
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
    if (stage === "review" && v.data && v.data.decision == null && Array.isArray(v.data.verdicts)) {
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
      v.data.decision = agg.decision;
      v.data.must_fix = agg.must_fix;
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
export async function assertNoWriteStageClean({ run, cwd, allow = [] }) {
  const r = await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd });
  if (r.code !== 0) return { ok: false, dirty: [], reason: `git status failed: ${r.stderr.trim()}` };
  // KTB-37 — `allow`는 이 런의 **overlay가 덮은 정확한 경로들**이다(팩토리가 스스로 만든 diff이지
  // 에이전트가 만든 것이 아니다). 목록은 overlay 직후에 굳고, 그 경로들이 세션 중에 **또** 바뀌지
  // 않았다는 것은 `overlayDrift`가 sha와 직접 비교해 따로 증명한다 — 여기서 넓게 열어 주는 것은
  // `.claude/**`가 아니라 그 순간 덮인 파일 이름들뿐이다.
  const allowed = new Set(allow);
  const dirty = new Set();
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    for (const p of pathsOfStatusLine(line)) if (p && !isScratchPath(p) && !allowed.has(p)) dirty.add(p);
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
export async function buildCtxExtra({ gh, issue, to, data, ctx, record = () => {}, reviewRoster = null, maxRounds = null }) {
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
export const OVERLAY_ROOTS = [".factory", ".claude", "docs/factory/CHARTER.md"];
export const OVERLAY_EXCLUDE = ":(exclude).factory/out";
export const OVERLAY_PATHSPECS = [".factory", OVERLAY_EXCLUDE, ".claude", "docs/factory/CHARTER.md"];
export const OVERLAY_LABEL = ".factory/** (except .factory/out/**), .claude/**, docs/factory/CHARTER.md";
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

export function makeFactoryOverlay({ run, root, env = process.env, defaultBranch = () => "main" }) {
  return async () => {
    const branch = typeof defaultBranch === "function" ? defaultBranch() : defaultBranch;
    const s = await resolveStageSha({ run, root, env, defaultBranch: branch });
    if (!s.ok) return { ok: false, reason: s.reason };
    // 이 커밋이 실제로 들고 있는 경로만 pathspec에 넣는다 — 없는 경로 하나가 `git checkout`을 통째로
    // 실패시키고(`error: pathspec … did not match`), 어댑터 레포는 `.claude/`가 없을 수 있다.
    const present = [];
    for (const p of OVERLAY_ROOTS) {
      const e = await run("git", ["cat-file", "-e", `${s.sha}:${p}`], { cwd: root });
      if (e.code === 0) present.push(p);
    }
    if (present.length === 0) return { ok: false, reason: `the stage sha ${s.sha.slice(0, 7)} (${s.source}) carries none of ${OVERLAY_LABEL}` };
    const pathspecs = present.flatMap((p) => (p === ".factory" ? [p, OVERLAY_EXCLUDE] : [p]));
    const co = await run("git", ["checkout", s.sha, "--", ...pathspecs], { cwd: root });
    if (co.code !== 0) return { ok: false, reason: `overlay checkout failed (${s.sha.slice(0, 7)} ${s.source}): ${co.stderr?.trim() || `exit ${co.code}`}` };
    // 무엇이 실제로 덮였는가 — 한 줄 로그의 재료이자, 쓰기 금지 스테이지의 클린 체크에 넘길 허용 목록이다.
    const st = await run("git", ["status", "--porcelain", "--untracked-files=all", "--", ...pathspecs], { cwd: root });
    if (st.code !== 0) return { ok: false, reason: `overlay status failed: ${st.stderr?.trim() || `exit ${st.code}`}` };
    const paths = new Set();
    for (const line of st.stdout.split("\n").filter(Boolean)) for (const p of pathsOfStatusLine(line)) if (p) paths.add(p);
    return { ok: true, sha: s.sha, source: s.source, paths: [...paths] };
  };
}

/**
 * overlay가 깔아 둔 팩토리 설정이 세션 **뒤에도** 그 커밋의 것 그대로인가. 클린 체크에 넘기는 허용
 * 목록(overlay가 덮은 경로들)이 에이전트의 세션 중 수정까지 덮어 주면 안 되므로, 그 경로들만 sha와
 * 직접 비교한다. `git diff` 자체가 실패하면 "그대로다"를 증명할 수 없으므로 fail closed다.
 */
export async function overlayDrift({ run, cwd, sha }) {
  const r = await run("git", ["diff", "--name-only", sha, "--", ...OVERLAY_PATHSPECS], { cwd });
  if (r.code !== 0) return { ok: false, paths: [], reason: `overlay drift check failed: ${r.stderr?.trim() || `exit ${r.code}`}` };
  const paths = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return paths.length === 0 ? { ok: true, paths: [] } : { ok: false, paths };
}

/** run 기록의 한 줄 — 무엇을, 어느 커밋에서 덮었는지. */
export const overlayLine = (ov) =>
  ov.paths?.length
    ? `overlay: ${ov.paths.length} path(s) from ${ov.sha.slice(0, 7)} (${ov.source || "base"}) — ${ov.paths.slice(0, 10).join(", ")}${ov.paths.length > 10 ? ", …" : ""} [${OVERLAY_LABEL}]`
    : `overlay: clean — factory config already at ${ov.sha.slice(0, 7)} (${ov.source || "base"}) [${OVERLAY_LABEL}]`;

/**
 * 로컬 진입(§4.2.5): `factory run triage <issue>`가 락을 먼저 잡았을 때만 의미가 있다 — main()이
 * `FACTORY_LOCAL_ENTRY=1`을 심어야 켜진다(GitHub 이벤트로 뜬 triage 잡은 이 env가 없다). backlog
 * 라벨만 있고 아직 factory 상태 라벨이 없는 이슈에 한해 factory:queue로 스스로 밀어 넣고 전이
 * 마커 코멘트를 남긴다 — 락은 이미 이 프로세스가 쥐고 있으므로, 라벨 이벤트로 따라 뜨는 GitHub의
 * triage 잡은 claim에 실패해 exit 0으로 물러난다(의도된 설계, 중복 실행 방지).
 */
export function makeLocalEntry({ gh, issue, stage, env }) {
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
    localEntry: makeLocalEntry({ gh, issue, stage, env: process.env }),
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
    checkoutHead: makeCheckoutHead({ gh, run, root, issue }),
    /**
     * ADR-020 KTB-37 — 체크아웃된 트리 위에 팩토리 소유 설정만 스테이지 자신의 커밋에서 덮는다.
     * `harness`는 charterReady에서 이미 로드됐다 — 기본 브랜치는 그때 굳은 값을 늦게 읽는다.
     */
    overlayFactoryConfig: async () => {
      const ov = await makeFactoryOverlay({ run, root, env: process.env, defaultBranch: () => harness?.project?.default_branch ?? "main" })();
      if (ov.ok) overlaySha = ov.sha;
      return ov;
    },
    /**
     * ADR-020 KTB-14 — 쓰기 금지 스테이지의 구조적 백스톱. review는 checkoutHead가 이미 detach해 둔 PR head를 그대로 본다.
     * KTB-37: overlay가 덮은 경로(`allow`)는 팩토리가 만든 diff라 더러움으로 세지 않는다 — 대신 그
     * 경로들이 세션 중에 **또** 바뀌지 않았는지를 sha와 직접 비교해 확인한다(`overlayDrift`, fail closed).
     */
    assertCleanWorktree: async (allow = []) => {
      const clean = await assertNoWriteStageClean({ run, cwd: root, allow });
      if (!clean.ok || !overlaySha) return clean;
      const drift = await overlayDrift({ run, cwd: root, sha: overlaySha });
      return drift.ok ? clean : { ok: false, dirty: drift.paths, reason: drift.reason || `factory config changed during the stage: ${drift.paths.join(", ")}` };
    },
    buildContext: async () => (ctxCache = await buildContext({ root, gh, issue, stage })),
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
      const r = await run("claude", args, { cwd: root, env: stageClaudeEnv({ root, harnessIssue }) });
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
      const result = await runStageGates({ run, cwd: root, harness, stage, tier, base: await mergeBase(), quarantine: loadQuarantine(root), gh, issue, readFile, saveQuarantine: (q) => writeQuarantine(root, q) });
      mkdirSync(join(root, ".factory/out"), { recursive: true });
      writeFileSync(gatesPath, JSON.stringify(result, null, 2));
      console.log(verdictLine(result));
      return result;
    },
    verifyStage: ({ out, gates }) => {
      const v = verifyStage({ stage, out, transcriptText: transcriptTextFor(root, out), agentsLog: readAgentsLog(join(root, ".factory/out/agents.jsonl")), roster: ctxCache.roster, rolePrefix: ROLE_PREFIX[stage] || "", expectedRounds: ctxCache.rounds, orchestration: ctxCache.orchestration, gates });
      // 추출에 성공했으면 `<stage>.json`을 **산출물**로 덮는다 — 사람과 다음 도구가 여는 파일이
      // 디스패처의 산문 섞인 envelope이 아니라 스테이지가 실제로 쓴 객체이도록(envelope은 옆에 남아 있다).
      if (v.ok && v.data) { try { writeFileSync(join(root, ".factory/out", `${stage}.json`), JSON.stringify(v.data, null, 2)); } catch { /* 기록 실패가 스테이지를 죽이지 않는다 */ } }
      return v;
    },
    writeHandoff: async ({ data }) => { await gh.comment(issue, renderHandoff({ stage, issue, summary: data.summary || `### ${stage} 완료`, data })); },
    /** triage 전용(KTB-9): 판정된 tier를 라벨로 내보낸다 — 다른 `factory:tier-*`는 같은 호출에서 떨어진다. */
    setTierLabel: (tier) => gh.setTierLabel(issue, tierLabel(tier)),
    /** merge stage 전용: PR이 열려 있는지, 충돌은 없는지 — implement handoff에 적힌 PR을 조회한다. */
    prInfo: async () => {
      const h = latestHandoff(await gh.comments(issue), "implement");
      return h?.data?.pr == null ? null : gh.prView(h.data.pr);
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
      try { return await policyViolations({ run, cwd: root, base: await mergeBase(), harness }); }
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
    reviewRoster: async () => {
      try {
        const tier = latestHandoff(await gh.comments(issue), "triage")?.data?.tier ?? charter.tier_default;
        return { ok: true, roles: rosterFor(charter, loadRoles(root), "review", tier), tier };
      } catch (e) { return { ok: false, reason: `review roster for this tier could not be resolved — ${e?.message || e}` }; }
    },
    get maxRounds() { return charter?.limits?.K ?? null; },
    /** CHARTER `merge.human_gate` — 머지 전이 텍스트가 사람의 서명 유무를 소리 내어 말한다(감사 H6). */
    get humanGate() { return charter?.merge?.human_gate; },
    prHeadShaLive: (pr) => gh.prHeadSha(pr),
    commitStatuses: (sha) => gh.commitStatuses(sha),
    /**
     * 팩토리 자신의 계정 **이름**(값이 아니다). 두 배우 모드에서 이 잡의 `GH_TOKEN`은 머지 배우이지만
     * `factory/review` 상태를 올린 것은 **에이전트 배우**다 — 그래서 둘 다 받는다. 봇 로그인은
     * 워크플로가 `FACTORY_BOT_LOGIN`으로 넘긴다(이름은 비밀이 아니라 env로 옮겨도 사본이 늘지 않는다).
     * 잡 토큰의 로그인조차 해석되지 않으면 `ok:false` — 머지 스테이지가 fail closed로 멈춘다.
     */
    factoryLogins: async () => {
      const logins = [];
      const bot = (process.env.FACTORY_BOT_LOGIN || "").trim();
      if (bot) logins.push(bot);
      try { logins.push(await gh.viewerLogin()); }
      catch (e) { return { ok: false, reason: `gh api user failed — ${e?.message || e}` }; }
      return { ok: true, logins: [...new Set(logins.filter(Boolean))] };
    },
    /** ADR-021 — 머지 배우의 승인 한 번(두 배우 모드에서만, 머지 직전). `GH_TOKEN`이 머지 토큰이다. */
    approvePr: (pr) => gh.approvePr(pr),
    mergePr: (pr) => gh.mergePr(pr, { method: "squash", deleteBranch: true }),
    closeIssue: (pr) => gh.closeIssue(issue, `merged via PR #${pr}`),
    /** merge 전용(KTB-23): 이 이슈의 본문 — `Blocks: #<n>`이 있으면 하네스 이슈였다는 뜻이다. */
    issueBody: async () => (await gh.issue(issue)).body,
    /** merge 전용(KTB-23): **다른** 이슈의 전이(위 `transition`은 이 이슈에 묶여 있다). */
    transitionOther: ({ issue: n, to, reason }) => transition({ gh, issue: n, to, reason, stage }),
    get defaultBranch() { return harness?.project?.default_branch ?? "main"; },
    /** merge stage 전용(KTB-19): ready 플립 뒤 필수 체크가 더 이상 진행 중이 아닐 때까지 기다리는
     * 재료 — 원시 체크 목록, 대상 이름 필터, 상한(초). `config.js`가 기본값 600을 채운다. */
    prChecks: (pr) => gh.prChecks(pr),
    get requiredChecks() { return harness?.factory?.required_checks ?? null; },
    get mergeCheckWaitSec() { return harness?.factory?.merge_check_wait_sec; },
    /** merge stage 전용: mergeability UNKNOWN 재확인 전 대기. */
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    transition: async ({ to, reason, data, mergeGatesResult, prerequisite = false }) => {
      // 감사 H1c — merge 경로에는 ctx가 없다(script-only). `factory:merged` 규칙이 정족수·K를 실제로
      // 물 수 있도록 CHARTER에서 읽은 로스터와 K를 여기서 채운다(조회 실패는 fail closed로 남긴다:
      // roster가 없으면 규칙이 "roster size" 대신 개수 검사만 건너뛰는 것이 아니라, 아래
      // merge-stage §(6b)가 이미 그 전에 판정 불가로 멈춘다).
      let reviewRoster = null;
      if (stage === "merge" && to === "factory:merged") {
        try { const r = await deps.reviewRoster(); if (r?.ok) reviewRoster = r.roles; }
        catch (e) { recordLine(`merge: roster for the merged requirement unresolved — ${e?.message || e}`); }
      }
      const ctxExtra = await buildCtxExtra({ gh, issue, to, data, ctx: ctxCache, record: recordLine, reviewRoster, maxRounds: charter?.limits?.K ?? null });
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
      return transition({ gh, issue, to, reason, ctxExtra, stage });
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
