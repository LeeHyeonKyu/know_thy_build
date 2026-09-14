import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadHarness, loadCharter, loadRoles, rosterFor, planRoundsFor } from "./config.js";
import { latestHandoff } from "./handoff.js";

const ROSTER_STAGE = { plan: "plan", review: "review" };

export async function buildContext({ root, gh, issue, stage }) {
  const harness = loadHarness(root), charter = loadCharter(root), roles = loadRoles(root);
  const it = await gh.issue(issue);
  const comments = await gh.comments(issue);
  const handoffs = {};
  for (const s of ["triage", "plan", "implement", "review"]) { const h = latestHandoff(comments, s); if (h) handoffs[s] = h.data; }
  const tier = handoffs.triage?.tier ?? charter.tier_default;
  const rs = ROSTER_STAGE[stage];
  const roster = rs ? rosterFor(charter, roles, rs, tier) : [];
  const role_agents = {}, lessons = {};
  for (const name of roster) { const def = roles[rs][name]; role_agents[name] = def.agent; if (def.lessons) lessons[name] = def.lessons; }
  const spec = /docs\/features\/\d+[\w-]*\.md/.exec(it.body || "");
  // 감사 Task 9: plan 스테이지만 모드를 안다. `rounds`는 숫자 하나로 남고(verify-stage의
  // expectedRounds 계약), 모드와 done_when 상한은 `plan` 블록으로 따로 실린다 — 워크플로는
  // `plan.mode`로 단일/토론을 가르고, verify-stage는 `plan.max_done_when`으로 핸드오프를 검사한다.
  const planning = stage === "plan" ? planRoundsFor(charter, tier) : null;
  const ctx = {
    issue: it, stage, tier, roster, role_agents, lessons,
    rounds: planning ? planning.rounds : undefined,
    plan: planning ? { mode: planning.mode, max_done_when: charter.plan.max_done_when } : undefined,
    limits: charter.limits, back_pressure: charter.back_pressure,
    orchestration: harness.factory?.orchestration ?? "workflow",
    spec_path: spec ? spec[0] : null,
    handoffs,
    harness: { maturity: harness.harness?.maturity, commands: harness.commands, gates: harness.gates },
  };
  mkdirSync(join(root, ".factory/out"), { recursive: true });
  writeFileSync(join(root, ".factory/out/context.json"), JSON.stringify(ctx, null, 2));
  return ctx;
}
