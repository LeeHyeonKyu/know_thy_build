#!/usr/bin/env node
import { hostname } from "node:os";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { loadCharter, loadHarness } from "../lib/config.js";
import { claim, release } from "../lib/claim.js";
import { requirementFor } from "../lib/requirements.js";
import { STAGE_OF_TARGET } from "../lib/labels.js";
import { buildContext } from "../lib/context.js";
import { startHeartbeat } from "../lib/heartbeat.js";
import { readAgentsLog } from "../lib/agents-log.js";
import { verifyStage } from "../lib/verify-stage.js";
import { aggregateReview } from "../lib/aggregate.js";
import { renderHandoff } from "../lib/handoff.js";
import { transition } from "../lib/transition.js";
import { appendRunRecord } from "../lib/run-record.js";
import { trustWorkspace } from "./trust-workspace.js";

/** 스테이지 → 성공 시 목적 상태, 요구 handoff를 만드는 직전 스테이지 */
export const NEXT_OF = { triage: null /* disposition에 따라 */, plan: "factory:planned", implement: "factory:awaiting-review", review: null /* aggregate에 따라 */, merge: "factory:merged" };
export const ROLE_PREFIX = { plan: "plan-", review: "reviewer-" };

export async function runStage({ stage, issue, deps }) {
  const d = deps;
  if (!(await d.charterReady())) { console.error("factory: CHARTER not ready or doctor failing — dormant"); return 0; }
  await d.trustWorkspace();
  const c = await d.claim();
  if (!c.ok) { console.error(`factory: issue #${issue} already claimed by ${c.holder}`); return 0; }
  const hb = await d.heartbeat();
  try {
    const a = await d.assertHandoff();
    if (!a.ok) return 2;                                              // assertHandoff가 needs-human 전이와 코멘트를 이미 했다
    const ctx = await d.buildContext();
    const out = await d.claudeP(ctx);
    const gates = await d.gates(ctx);                                 // Plan 1b 전까지 null
    const v = d.verifyStage({ stage, out, ctx, gates });
    if (!v.ok) {
      await d.transition({ to: "factory:needs-human", reason: `stage artifact missing or invalid: ${v.reasons.join("; ")}` });
      d.runRecord(["verify: FAIL", ...v.reasons.map((r) => `- ${r}`)]);
      return 2;
    }
    // review handoff(review.v1)는 verdicts만 싣는다 — 집계 결정은 여기서 만들어 handoff·전이에 함께 실는다.
    if (stage === "review" && v.data && v.data.decision == null && Array.isArray(v.data.verdicts)) {
      const roster = ctx?.roster || [];
      const agg = aggregateReview({ verdicts: v.data.verdicts, rosterSize: roster.length, rosterRoles: roster });
      v.data.decision = agg.decision;
      v.data.must_fix = agg.must_fix;
    }
    await d.writeHandoff({ stage, data: v.data, gates });
    const t = await d.transition({ to: nextState(stage, v.data), data: v.data });
    d.runRecord([`verify: ok`, `transition: ${t.ok ? t.to : "refused — " + t.reason}`, `usage: ${JSON.stringify(out.usage || {})} cost_usd: ${out.total_cost_usd ?? "n/a"}`]);
    return t.ok ? 0 : 2;
  } finally {
    hb.stop();
    await d.release();
  }
}

export function nextState(stage, data) {
  if (stage === "triage") return { ready: "factory:ready", "needs-info": "factory:needs-info", "wont-do": "factory:wont-do" }[data.disposition];
  if (stage === "review") return data.decision === "approved" ? "factory:approved" : "factory:rework";
  return NEXT_OF[stage];
}

/** CLI 진입: 실제 의존성 조립 */
async function main() {
  const [stage, issueArg] = process.argv.slice(2);
  const issue = Number(issueArg);
  if (!stage || !issue) { console.error("usage: run-stage <stage> <issue>"); process.exit(1); }
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
  const runnerId = process.env.FACTORY_RUNNER_ID || `local/${hostname()}`;
  const gh = makeGh({ run, repo });
  const charter = loadCharter(root), harness = loadHarness(root);
  let ctxCache;
  const deps = {
    charterReady: async () => charter.status === "ready",
    trustWorkspace: () => trustWorkspace({ root }),
    claim: () => claim({ run, cwd: root, issue, stage, runnerId }),
    heartbeat: () => startHeartbeat({ gh, issue, stage, runnerId }),
    assertHandoff: async () => {
      const target = Object.entries(STAGE_OF_TARGET).find(([, s]) => s === prevStage(stage))?.[0];
      if (!target) return { ok: true };
      const req = requirementFor(target)({ comments: await gh.comments(issue) });
      if (!req.ok) { await transition({ gh, issue, to: "factory:needs-human", reason: `prerequisite handoff missing: ${req.reason}` }); }
      return req;
    },
    buildContext: async () => (ctxCache = await buildContext({ root, gh, issue, stage })),
    claudeP: async () => {
      const args = ["-p", `/factory-${stage} ${issue}`, "--permission-mode", "dontAsk", "--max-turns", "5", "--output-format", "json", "--settings", join(root, ".factory/ci-settings.json")];
      if (charter.budget?.usd_per_stage) args.push("--max-budget-usd", String(charter.budget.usd_per_stage));
      const r = await run("claude", args, { cwd: root, env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", CLAUDE_PROJECT_DIR: root } });
      try { return JSON.parse(r.stdout); } catch { return { is_error: true, result: r.stdout + r.stderr }; }
    },
    gates: async () => null,
    verifyStage: ({ out }) => verifyStage({ stage, out, agentsLog: readAgentsLog(join(root, ".factory/out/agents.jsonl")), roster: ctxCache.roster, rolePrefix: ROLE_PREFIX[stage] || "", expectedRounds: ctxCache.rounds, orchestration: ctxCache.orchestration }),
    writeHandoff: async ({ data }) => { await gh.comment(issue, renderHandoff({ stage, issue, summary: data.summary || `### ${stage} 완료`, data })); },
    transition: ({ to, reason, data }) => transition({ gh, issue, to, reason, ctxExtra: { roster: ctxCache?.roster, expectedRounds: ctxCache?.rounds, rosterSize: ctxCache?.roster?.length, maxRounds: charter.limits.K } }),
    runRecord: (lines) => appendRunRecord({ root, issue, stage, runnerId, lines }),
    release: () => release({ run, cwd: root, issue }),
  };
  process.exit(await runStage({ stage, issue, deps }));
}
export const PREV = { plan: "triage", implement: "plan", review: "implement", merge: "review" };
export function prevStage(stage) { return PREV[stage] || null; }

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
