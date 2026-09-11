#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { makeGh, allChecksGreen } from "../lib/gh.js";
import { loadCharter, loadHarness } from "../lib/config.js";
import { loadQuarantine, saveQuarantine as writeQuarantine } from "../lib/quarantine.js";
import { backPressure } from "../lib/back-pressure.js";
import { runStageGates, verdictLine } from "../lib/gates.js";
import { isGitDiffError } from "../lib/changed-files.js";
import { MergeBaseError, MERGE_BASE_BLOCKED_REASON, MERGE_BASE_ERROR_CODE, isMergeBaseError, GIT_DIFF_BLOCKED_REASON } from "../lib/blocked-errors.js";
import { integrityCheck } from "../lib/integrity.js";
import { claim, release } from "../lib/claim.js";
import { requirementFor } from "../lib/requirements.js";
import { STAGE_OF_TARGET, factoryLabelOf } from "../lib/labels.js";
import { buildContext } from "../lib/context.js";
import { startHeartbeat } from "../lib/heartbeat.js";
import { readAgentsLog } from "../lib/agents-log.js";
import { verifyStage } from "../lib/verify-stage.js";
import { aggregateReview } from "../lib/aggregate.js";
import { renderHandoff, latestHandoff, parseHandoffs } from "../lib/handoff.js";
import { transition } from "../lib/transition.js";
import { appendRunRecord } from "../lib/run-record.js";
import { syncRecords, hydrateRecord } from "../lib/records-branch.js";
import { trustWorkspace } from "./trust-workspace.js";
import { runMergeStage } from "../lib/merge-stage.js";

/** 스테이지 → 성공 시 목적 상태, 요구 handoff를 만드는 직전 스테이지 */
export const NEXT_OF = { triage: null /* disposition에 따라 */, plan: "factory:planned", implement: "factory:awaiting-review", review: null /* aggregate에 따라 */, merge: "factory:merged" };
export const ROLE_PREFIX = { plan: "plan-", review: "reviewer-" };
export const STAGES = ["triage", "plan", "implement", "review", "merge"];

/** 게이트 파일이 판정을 만드는 스테이지. 여기서 gates가 null이면 판정은 워크플로의 자기 신고뿐이다. */
const GATED_STAGES = new Set(["implement", "review", "merge"]);
export const GATES_SELF_REPORTED = "gates: self-reported by workflow (no gates.json from this run — unverified)";

// MergeBaseError/isMergeBaseError/MERGE_BASE_BLOCKED_REASON/GIT_DIFF_BLOCKED_REASON now live in
// lib/blocked-errors.js (merge-stage.js needs them too) — re-exported here for existing importers.
export { MergeBaseError, MERGE_BASE_BLOCKED_REASON, MERGE_BASE_ERROR_CODE, isMergeBaseError, GIT_DIFF_BLOCKED_REASON };

/** claude -p 결과를 런 레코드 한 줄로. 무엇을 얼마나 태웠는지는 사후 감사의 1차 증거다. */
export function usageLine(out) {
  const models = Object.entries(out?.modelUsage || {})
    .map(([m, u]) => `${m}=$${u?.costUSD ?? "n/a"}`).join(", ");
  return `usage: ${JSON.stringify(out?.usage || {})} cost_usd: ${out?.total_cost_usd ?? "n/a"}`
    + ` num_turns: ${out?.num_turns ?? "n/a"} terminal_reason: ${out?.terminal_reason ?? "n/a"}`
    + ` models: ${models || "n/a"}`;
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
  const c = await d.claim();
  if (!c.ok) { console.error(`factory: issue #${issue} already claimed by ${c.holder}`); return 0; }
  let hb = null;                                                      // 락을 잡은 뒤의 모든 실패는 finally를 거쳐야 한다
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
    // merge는 script-only다 — claudeP/buildContext/verifyStage/writeHandoff을 전혀 거치지 않고
    // PR head에서 곧장 머지 여부를 판단한다(§runMergeStage). checkoutSha를 그대로 넘겨 무엇을
    // 머지했는지 런 레코드에 남긴다. 여기서 끝낸다.
    if (stage === "merge") return await runMergeStage({ issue, defaultBranch: d.defaultBranch, headSha: checkoutSha, d, record, refusal, postStatus });
    if (stage === "implement") {                                      // planned → in-progress: 작업 시작을 라벨로 알린다
      const ip = await d.transition({ to: "factory:in-progress", reason: `claimed by ${runnerId}` });
      if (!ip.ok) { record(refusal(ip)); return 2; }
    }
    const ctx = await d.buildContext();
    await d.resetAgentsLog?.();                                       // 지난 런의 agents.jsonl이 로스터 체크를 대신 만족시키지 못하게
    const out = await d.claudeP(ctx);
    const usage = usageLine(out);
    // claude -p가 실패를 보고했으면 게이트를 돌릴 이유가 없다 — 판정할 산출물이 없다.
    // 게이트는 건너뛰고 곧장 verify로 간다(verify가 is_error로 떨어뜨린다).
    let gates = null;
    if (!out?.is_error) {
      try { gates = await d.gates(ctx); }                             // 게이트 없는 스테이지(triage/plan)는 null
      catch (e) {
        if (!isMergeBaseError(e) && !isGitDiffError(e)) throw e;
        const reason = isMergeBaseError(e) ? MERGE_BASE_BLOCKED_REASON : GIT_DIFF_BLOCKED_REASON;
        const t = await d.transition({ to: "factory:blocked", reason });
        record([`gates: BLOCKED — ${e.message}`, ...refusal(t), usage]);
        return 2;
      }
    }
    const gatesNote = gates == null
      ? (GATED_STAGES.has(stage) ? [GATES_SELF_REPORTED] : [])
      : gates.schema === "factory.gates.v1" ? [verdictLine(gates)] : [];
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
      await postStatus({ context: "factory/gates", state: gates.status === "GREEN" ? "success" : "failure", description: verdictLine(gates), sha: gates.head_sha });
    }
    const v = d.verifyStage({ stage, out, ctx, gates });
    if (!v.ok) {
      const t = await d.transition({ to: "factory:needs-human", reason: `stage artifact missing or invalid: ${v.reasons.join("; ")}` });
      record(["verify: FAIL", ...v.reasons.map((r) => `- ${r}`), ...refusal(t), ...gatesNote, usage]);
      return 2;
    }
    // 라운드 번호는 에이전트의 자기 신고가 아니라 이슈에 남은 review handoff 개수에서 센다 — K 한도가 실제로 물리게.
    if (stage === "review" && v.data) {
      const prior = await d.countHandoffs?.("review");
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
    await d.writeHandoff({ stage, data: v.data, gates });
    const t = await d.transition({ to: nextState(stage, v.data), data: v.data });
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

export function nextState(stage, data) {
  if (stage === "triage") return { ready: "factory:ready", "needs-info": "factory:needs-info", "wont-do": "factory:wont-do" }[data.disposition];
  if (stage === "review") return data.decision === "approved" ? "factory:approved" : "factory:rework";
  return NEXT_OF[stage];
}

/**
 * 전이 요구조건에 커밋/PR을 실제로 묶는다. 게이트는 "무엇을 검사했는가"를 알아야만 물린다.
 * gh 호출이 실패하면 sha 없이(undefined) 돌려주고 record()로 흔적을 남긴다 — 런을 죽이지 않는다.
 */
export async function buildCtxExtra({ gh, issue, to, data, ctx, charter, record = () => {} }) {
  const ctxExtra = { issue, roster: ctx?.roster, expectedRounds: ctx?.rounds, rosterSize: ctx?.roster?.length, maxRounds: charter?.limits?.K };
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
  const [stage, issueArg] = process.argv.slice(2);
  const issue = Number(issueArg);
  if (!stage || !issue || !STAGES.includes(stage)) { console.error(`usage: run-stage <${STAGES.join("|")}> <issue>`); process.exit(1); }
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
  const runnerId = process.env.FACTORY_RUNNER_ID || `local/${hostname()}`;
  const gh = makeGh({ run, repo });
  let charter, harness, ctxCache;                                     // CHARTER는 dormancy 판정에서만 읽는다 — 없거나 깨져도 잠들 뿐 터지지 않는다
  const recordLine = (line) => { try { appendRunRecord({ root, issue, title: ctxCache?.issue?.title || "", stage, runnerId, lines: [line] }); } catch {} };
  const readFile = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const readJson = (p) => { try { const t = readFile(p); return t ? JSON.parse(t) : null; } catch { return null; } };
  const gatesPath = join(root, ".factory/out/gates.json");
  let baseSha = null;                                                 // 한 런 안에서 base는 하나다 — 두 번 물어보면 두 답이 나올 수 있다
  const mergeBase = async () => {
    if (baseSha) return baseSha;
    const branch = harness.project?.default_branch ?? "main";
    const r = await run("git", ["merge-base", `origin/${branch}`, "HEAD"], { cwd: root });
    const sha = r.stdout.trim();
    if (r.code !== 0 || !sha) throw new MergeBaseError(`origin/${branch}: exit ${r.code} ${r.stderr.trim()}`.trim());
    return (baseSha = sha);
  };
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
    heartbeat: () => startHeartbeat({ gh, issue, stage, runnerId }),
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
    buildContext: async () => (ctxCache = await buildContext({ root, gh, issue, stage })),
    /** 지난 런의 SubagentStart/Stop 기록이 이번 런의 로스터 체크를 대신 만족시키면 안 된다. */
    resetAgentsLog: async () => { rmSync(join(root, ".factory/out/agents.jsonl"), { force: true }); },
    /** 지난 런의 게이트 판정 파일과 그 재료(테스트·커버리지·mutation 리포트)도 마찬가지다 — 스테이지 첫 전이보다 먼저 지운다. */
    resetGates: async () => { resetGateOutputs({ root, harness }); },
    countHandoffs: async (s) => parseHandoffs(await gh.comments(issue)).filter((h) => h.stage === s && h.issue === issue).length,
    claudeP: async () => {
      const args = ["-p", `/factory-${stage} ${issue}`, "--permission-mode", "dontAsk", "--max-turns", "5", "--output-format", "json", "--settings", join(root, ".factory/ci-settings.json")];
      if (charter?.budget?.usd_per_stage) args.push("--max-budget-usd", String(charter.budget.usd_per_stage));
      const r = await run("claude", args, { cwd: root, env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", CLAUDE_PROJECT_DIR: root } });
      mkdirSync(join(root, ".factory/out"), { recursive: true });     // 파싱에 실패해도 원본 stdout은 남긴다
      writeFileSync(join(root, ".factory/out", `${stage}.json`), r.stdout);
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
    verifyStage: ({ out, gates }) => verifyStage({ stage, out, agentsLog: readAgentsLog(join(root, ".factory/out/agents.jsonl")), roster: ctxCache.roster, rolePrefix: ROLE_PREFIX[stage] || "", expectedRounds: ctxCache.rounds, orchestration: ctxCache.orchestration, gates }),
    writeHandoff: async ({ data }) => { await gh.comment(issue, renderHandoff({ stage, issue, summary: data.summary || `### ${stage} 완료`, data })); },
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
    mergePr: (pr) => gh.mergePr(pr, { method: "squash", deleteBranch: true }),
    closeIssue: (pr) => gh.closeIssue(issue, `merged via PR #${pr}`),
    get defaultBranch() { return harness?.project?.default_branch ?? "main"; },
    /** merge stage 전용: mergeability UNKNOWN 재확인 전 대기. */
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    transition: async ({ to, reason, data, mergeGatesResult }) => {
      const ctxExtra = await buildCtxExtra({ gh, issue, to, data, ctx: ctxCache, charter, record: recordLine });
      // 전이 경로에서만 게이트를 묻는다 — gatesChecked가 그 표식이다(선행 handoff 확인은 세우지 않는다).
      ctxExtra.gatesChecked = true;
      const gatesFile = readJson(gatesPath);
      if (gatesFile) ctxExtra.gatesFile = gatesFile;                   // 워크플로의 자기 신고가 아니라 이 파일이 판정이다
      // merge stage는 이미 mergeGates()를 한 번 돌렸다 — 여기서 다시 gh를 두 번 때리지 않고 그 결과를 그대로 쓴다.
      if (to === "factory:merged") Object.assign(ctxExtra, mergeGatesResult ?? await mergeGates({ gh, root, harness, pr: ctxExtra.pr, prHeadSha: ctxExtra.prHeadSha, readFile, record: recordLine, base: await mergeBase(), required: harness?.factory?.required_checks ?? null }));
      return transition({ gh, issue, to, reason, ctxExtra });
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
