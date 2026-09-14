import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadHarness, loadCharter, loadRoles, rosterFor, planRoundsFor } from "./config.js";
import { latestHandoff } from "./handoff.js";
import { tierFloor, maxTier, normalizeTier } from "./gates.js";
import { changedFiles } from "./changed-files.js";

const ROSTER_STAGE = { plan: "plan", review: "review" };

/**
 * ── 외부 감사 H3: **tier는 자기 신고였고, 그 신고가 자기 채점자를 골랐다** ──────────────────
 *
 * `tier = handoffs.triage?.tier ?? charter.tier_default` 한 줄이 리뷰 로스터와 계획 라운드를 정했다.
 * 그 값을 적는 것은 triage 에이전트이고, 틀리는 방향은 언제나 **가벼운 쪽**이다(docs로 적으면
 * 리뷰어 한 명, 계획은 단일 패스). `tierFloor`(diff가 정하는 바닥)는 이미 있었지만 게이트 **레벨**
 * 하나만 올렸고 `tier_effective`를 읽는 소비처가 0곳이었다.
 *
 * 이제 `tier_effective = max(신고, 바닥)`이 **단일 출처**다: 로스터(`rosterFor`)·계획 모드와
 * 라운드(`planRoundsFor`)·핸드오프·merge 스테이지의 정족수가 전부 이것을 읽는다. 신고(`tier`)는
 * 지우지 않고 나란히 남긴다 — 둘이 갈렸다는 사실(`tier_source: "floor"`)이 곧 "triage가 과소 평가했다"는
 * 신호이고, 그것은 사람과 retro가 읽어야 할 기록이다.
 *
 * **diff를 못 읽으면 바닥은 `standard`다.** 판정 불가가 docs로 내려앉으면 정확히 감사가 지적한 구멍이
 * 다시 열린다 — 모르면 약한 쪽이 아니라 기본 쪽으로 간다. `run`/`base`가 아예 주입되지 않은 호출은
 * "바닥을 묻지 않은 것"이라 신고 그대로다(`tier_floor: null`) — 생산 경로(run-stage·bin/build-context)는
 * 둘 다 넘긴다.
 */
export async function resolveTier({ run, cwd, base, harness, tier }) {
  const declared = normalizeTier(tier);
  if (!run || !base) return { tier_effective: declared, tier_source: "triage", tier_floor: null };
  let floor;
  try { floor = tierFloor({ changed: await changedFiles({ run, cwd, base, harness }), harness }); }
  catch { floor = "standard"; }
  const eff = maxTier(declared, floor);
  return { tier_effective: eff, tier_source: eff === declared ? "triage" : "floor", tier_floor: floor };
}

export async function buildContext({ root, gh, issue, stage, run = null, base = null }) {
  const harness = loadHarness(root), charter = loadCharter(root), roles = loadRoles(root);
  const it = await gh.issue(issue);
  const comments = await gh.comments(issue);
  const handoffs = {};
  for (const s of ["triage", "plan", "implement", "review"]) { const h = latestHandoff(comments, s); if (h) handoffs[s] = h.data; }
  const tier = handoffs.triage?.tier ?? charter.tier_default;
  // 감사 H3 — 로스터·계획은 **신고가 아니라 실효 tier**를 읽는다.
  const { tier_effective, tier_source, tier_floor } = await resolveTier({ run, cwd: root, base, harness, tier });
  const rs = ROSTER_STAGE[stage];
  const roster = rs ? rosterFor(charter, roles, rs, tier_effective) : [];
  const role_agents = {}, lessons = {};
  for (const name of roster) { const def = roles[rs][name]; role_agents[name] = def.agent; if (def.lessons) lessons[name] = def.lessons; }
  const spec = /docs\/features\/\d+[\w-]*\.md/.exec(it.body || "");
  // 감사 Task 9: plan 스테이지만 모드를 안다. `rounds`는 숫자 하나로 남고(verify-stage의
  // expectedRounds 계약), 모드와 done_when 상한은 `plan` 블록으로 따로 실린다 — 워크플로는
  // `plan.mode`로 단일/토론을 가르고, verify-stage는 `plan.max_done_when`으로 핸드오프를 검사한다.
  const planning = stage === "plan" ? planRoundsFor(charter, tier_effective) : null;
  const ctx = {
    issue: it, stage, tier, tier_effective, tier_source, tier_floor, roster, role_agents, lessons,
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
