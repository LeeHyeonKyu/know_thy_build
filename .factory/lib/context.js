import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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

/**
 * 외부 감사 2026-09-14 H4 — **cold read를 구조로 만든다.**
 *
 * 지금까지 `cold_read = true`는 `roles.toml`에 적힌 선언일 뿐이었다: 그것을 읽는 JS가 하나도 없었고,
 * `context.json`은 모든 handoff(= verifier 판정·builder의 PR 설명·tests_added)를 담은 채 모든
 * 리뷰어에게 같은 경로로 주어졌다. 프롬프트가 "plan handoff는 읽지 마라"라고 말했지만 훅은 **읽기를
 * 막지 않는다** — 지시는 강제가 아니다.
 *
 * 그래서 강제를 파일 경계로 옮긴다: 로스터의 역할마다 `context.<role>.json`을 따로 쓰고, cold read
 * 역할의 파일에는 handoff가 **한 글자도 들어 있지 않다**. 리뷰어가 읽지 않기로 약속할 필요가 없다 —
 * 읽을 것이 거기 없다.
 */
const DONE_WHEN_FIELDS = ["id", "text", "verify", "level"];
const pick = (o, keys) => {
  const out = {};
  for (const k of keys) if (o != null && o[k] !== undefined) out[k] = o[k];
  return out;
};

/** `.claude/agents/reviewer-qa.md` → `reviewer-qa` (= agent_type = frontmatter name, Global Constraints). */
const agentTypeOf = (p) => basename(String(p ?? ""), ".md");

/**
 * 이슈 본문의 "acceptance"(인수/수락 기준) 절 — spec-conformance만 추가로 받는다. 그 역할의 임무가
 * 계약 대조라, 계약이 이슈 본문 안에 있으면 그것을 이름으로 집어 준다(찾아 헤매지 않도록).
 */
const ACCEPTANCE_HEADING = /^#{1,6}[^\n]*(acceptance|인수\s*기준|수락\s*기준)[^\n]*$/im;
export function acceptanceOf(body) {
  const text = String(body ?? "");
  const m = ACCEPTANCE_HEADING.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = /^#{1,6}\s+/m.exec(rest);
  const section = (next ? rest.slice(0, next.index) : rest).trim();
  return section === "" ? null : section;
}

/**
 * 한 역할이 받을 문맥(H4). `cold_read !== true`면 전체 파일 그대로 — spec-conformance가 그 한 역할이고
 * (`roles.toml [review.spec-conformance] cold_read = false`), 계약 전체를 보는 것이 그 임무다.
 *
 * cold read 역할이 받는 것은 **이슈·tier·로스터·자기 lessons·PR 번호/head sha·게이트 요약·계획의
 * `done_when`(id/text/verify/level)** 뿐이다. 받지 않는 것: plan 산문·dissent_log·`files_expected`·
 * implement handoff(verifier 판정·tests_added·PR 설명)·다른 리뷰어의 판정. `handoffs` 키 자체가 없다.
 * PR 번호와 head sha는 예외다 — 그것은 builder의 **설명**이 아니라 "무엇을 판정하는가"의 좌표다.
 *
 * tier는 **쌍으로** 간다(H3): 신고(`tier`)와 실효(`tier_effective`/`tier_source`). cold read 역할이
 * 신고만 받으면 "docs 이슈니까 가볍게 본다"를 triage의 과소 평가 위에서 판단하게 된다 — 그를 부른
 * 근거는 신고가 아니라 diff가 정한 바닥이었는데도. cold_read가 아닌 역할은 전체 ctx를 받으므로
 * 같은 세 필드를 이미 들고 있다.
 */
export function roleContextFor(ctx, role) {
  const def = ctx.roles?.[role] ?? {};
  const extra = role === "spec-conformance" ? { acceptance: acceptanceOf(ctx.issue?.body) } : {};
  if (def.cold_read !== true) return { ...ctx, role, cold_read: false, ...extra };
  const impl = ctx.handoffs?.implement ?? {};
  const doneWhen = (Array.isArray(ctx.handoffs?.plan?.done_when) ? ctx.handoffs.plan.done_when : [])
    .map((w) => pick(w, DONE_WHEN_FIELDS));
  return {
    role,
    cold_read: true,
    issue: ctx.issue,
    stage: ctx.stage,
    tier: ctx.tier,
    tier_effective: ctx.tier_effective,
    tier_source: ctx.tier_source,
    roster: ctx.roster,
    lessons: def.lessons ?? null,
    spec_path: ctx.spec_path,
    limits: ctx.limits,
    pr: typeof impl.pr === "number" ? impl.pr : null,
    head_sha: typeof impl.head_sha === "string" ? impl.head_sha : null,
    gates: ctx.harness?.gates ?? null,
    maturity: ctx.harness?.maturity ?? null,
    done_when: doneWhen,
    ...extra,
  };
}

/**
 * 감사 M5 — `factory-loader`(sonnet LLM 호출)가 스테이지마다 하던 추출을 Node가 결정적으로 한다.
 * 로더는 `context.json` + `roles.toml`을 읽어 JSON을 JSON으로 옮겨 적었을 뿐인데, 그 한 번의 복사에
 * 스테이지당 LLM 호출 하나가 들었고 그 복사는 틀릴 수 있었다. 여기서 만드는 객체가 그 산출물의
 * 대체물이고, `.factory/out/loaded.json`으로도 따로 떨어진다 — 디스패처는 그 작은 파일 하나를 그대로
 * Workflow의 `args.loaded`로 넘긴다(워크플로 스크립트는 파일을 읽을 수 없다, §4.2.3).
 */
const REWORK_JSON = /```json\s*([\s\S]*?)```/g;
export function disputedFrom(comments) {
  let latest = null;
  for (const c of comments ?? []) {
    for (const m of String(c?.body ?? "").matchAll(REWORK_JSON)) {
      let obj;
      try { obj = JSON.parse(m[1]); } catch { continue; }
      if (obj?.schema !== "factory.rework-response.v1") continue;
      const at = Date.parse(c?.createdAt ?? "") || 0;
      if (latest === null || at >= latest.at) latest = { at, obj };
    }
  }
  if (latest === null) return [];
  return (Array.isArray(latest.obj.responses) ? latest.obj.responses : []).filter((r) => r?.status === "disputed");
}

export async function buildContext({ root, gh, issue, stage, run = null, base = null, setupDirty = null }) {
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
  /**
   * 감사 H4/M5 — `roles[<name>]`는 이 스테이지가 실제로 띄우는 역할의 **완전한 정의**다:
   * agent 경로, agent_type, `model`(로더가 `roles.toml`을 다시 읽던 유일한 이유), lessons, 그리고
   * `cold_read`. 로스터가 없는 스테이지(triage·implement)의 고정 역할도 같은 모양으로 싣는다.
   */
  const roleDefs = {};
  if (rs) for (const name of roster) roleDefs[name] = roles[rs][name];
  else if (stage === "triage") roleDefs.triage = roles.triage ?? {};
  else if (stage === "implement") { roleDefs.builder = roles.implement?.builder ?? {}; roleDefs.verifier = roles.implement?.verifier ?? {}; }
  const roleBlock = {};
  for (const [name, def] of Object.entries(roleDefs)) {
    roleBlock[name] = {
      agent: def.agent ?? null,
      agentType: agentTypeOf(def.agent),
      model: def.model ?? null,
      lessons: def.lessons ?? null,
      cold_read: def.cold_read === true,
      context: `.factory/out/context.${name}.json`,
    };
  }
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
    /**
     * 감사 M1 — triage 스테이지에만 실린다: 이 저장소가 **애매한 이슈를 어떻게 하기로 했는가**
     * (`charter.triage.default`)와, 스크립트가 다시 대는 NEVER_AUTOMATE 글롭. 프롬프트는 전자를
     * 읽어 판정하고, `verify-stage`는 후자로 그 판정을 덮어쓴다 — 둘은 같은 CHARTER에서 온다.
     */
    ...(stage === "triage" ? { triage: { default: charter.triage?.default ?? null, never_automate: charter.never_automate ?? [] } } : {}),
    orchestration: harness.factory?.orchestration ?? "workflow",
    spec_path: spec ? spec[0] : null,
    handoffs,
    harness: { maturity: harness.harness?.maturity, commands: harness.commands, gates: harness.gates },
    roles: roleBlock,
    /**
     * ADR-020 KTB-43 — **`[runtime].setup`이 이 런에서 이미 다시 쓴 경로들**(KTB-39의 기준선,
     * `run-stage.js`가 스테이지 맨 앞에서 찍는다). 빌더에게 "이 파일들은 커밋하지 마라"를 말하려면
     * 그 목록이 프롬프트에 있어야 하는데, 워크플로 스크립트는 파일을 읽을 수 없다(§4.2.3) — 그래서
     * `loaded.json`을 타고 간다. 비어 있는 것이 정상이다(대부분의 하네스는 트리를 더럽히지 않는다).
     */
    setup_dirty: [...new Set((setupDirty?.entries || []).map((e) => e.path))],
  };
  ctx.loaded = await loadedFor({ ctx, roleBlock, gh });
  mkdirSync(join(root, ".factory/out"), { recursive: true });
  writeFileSync(join(root, ".factory/out/context.json"), JSON.stringify(ctx, null, 2));
  // 역할별 파일(H4). 오케스트레이터만 `context.json`(전체)을 보고, 역할은 자기 이름이 붙은 파일만 본다.
  for (const name of Object.keys(roleBlock)) {
    writeFileSync(join(root, `.factory/out/context.${name}.json`), JSON.stringify(roleContextFor(ctx, name), null, 2));
  }
  // 디스패처가 Workflow의 `args.loaded`로 그대로 넘기는 작은 파일(M5) — 로더 에이전트의 대체물.
  writeFileSync(join(root, ".factory/out/loaded.json"), JSON.stringify(ctx.loaded, null, 2));
  return ctx;
}

/**
 * 로더가 돌려주던 것과 **같은 모양**의 객체를, LLM 없이. triage의 로스터는 context.json에서 비어 있으므로
 * (단일 명명 역할이지 토론 로스터가 아니다) 로더의 특례와 똑같이 `[{name:'triage', …}]`로 채운다.
 */
async function loadedFor({ ctx, roleBlock, gh }) {
  const impl = ctx.handoffs?.implement ?? {};
  const pr = typeof impl.pr === "number" ? impl.pr : undefined;
  const review = ctx.handoffs?.review ?? null;
  const mustFix = review?.decision === "rework"
    ? (Array.isArray(review.verdicts) ? review.verdicts : []).flatMap((v) => (Array.isArray(v?.must_fix) ? v.must_fix.filter(Boolean) : []))
    : [];
  let disputed = [];
  // PR 코멘트 조회가 실패해도 스테이지를 죽이지 않는다 — 분쟁 목록이 비면 그 라운드에 분쟁이 없었던
  // 것과 같은 경로를 타고, 살아남은 must_fix는 아래 `must_fix`가 그대로 들고 간다(fail-safe, not fail-open:
  // 항목이 사라지는 것이 아니라 "빌더가 이의를 제기하지 않았다"로 취급된다).
  if (pr !== undefined) { try { disputed = disputedFrom(await gh.comments(pr)); } catch { disputed = []; } }
  const roster = ctx.stage === "triage"
    ? [{ name: "triage", agentType: roleBlock.triage?.agentType ?? "factory-triage", model: roleBlock.triage?.model ?? null, ...(roleBlock.triage?.lessons ? { lessons: roleBlock.triage.lessons } : {}) }]
    : ctx.roster.map((name) => ({
      name,
      agentType: roleBlock[name].agentType,
      model: roleBlock[name].model,
      ...(roleBlock[name].lessons ? { lessons: roleBlock[name].lessons } : {}),
      context: roleBlock[name].context,
    }));
  const contexts = {};
  for (const [name, def] of Object.entries(roleBlock)) contexts[name] = def.context;
  return {
    issue: ctx.issue.number,
    stage: ctx.stage,
    // 로더 페이로드의 `tier`는 **실효 tier**다(H3: max(신고, diff가 정한 바닥)). 이 파일은 그대로
    // Workflow의 `args.loaded`가 되므로, 여기서 신고를 그대로 실으면 로스터·계획 라운드가 이미
    // 바닥으로 올라간 뒤에도 워크플로만 triage의 과소 평가를 계속 읽게 된다 — 실효 tier가 단일
    // 출처라는 말이 그 순간 거짓이 된다. 신고와 갈렸다는 사실은 `tier_source`로 함께 싣는다.
    tier: ctx.tier_effective,
    tier_effective: ctx.tier_effective,
    tier_source: ctx.tier_source,
    roster,
    contexts,
    ...(ctx.rounds === undefined ? {} : { rounds: ctx.rounds }),
    ...(ctx.plan === undefined ? {} : { plan: ctx.plan }),
    // 감사 M1 — 디스패처가 `args.loaded`로 그대로 넘기는 파일이라, triage 프롬프트가 읽는 기본값은
    // 여기에 있어야 한다(워크플로 스크립트는 파일을 읽을 수 없다, §4.2.3).
    ...(ctx.triage === undefined ? {} : { triage: ctx.triage }),
    limits: ctx.limits,
    spec_path: ctx.spec_path,
    maturity: ctx.harness?.maturity ?? null,
    orchestration: ctx.orchestration,
    ...(pr === undefined ? {} : { pr }),
    ...(typeof impl.head_sha === "string" ? { head_sha: impl.head_sha } : {}),
    // KTB-43 — 빌더 프롬프트가 "커밋하지 말 것" 목록으로 읽는다(§buildContext setup_dirty).
    setup_dirty: ctx.setup_dirty ?? [],
    must_fix: mustFix,
    disputed,
  };
}
