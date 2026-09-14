import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseFrontmatter } from "./frontmatter.js";

/**
 * CHARTER `plan:` 블록의 기본값 (감사 Task 9 — `docs/factory/audit/response-task-9.md`).
 * `mode`는 기본 단일 패스, `debate_tiers`에 이름이 있는 tier만 4역할 토론, `max_done_when`은
 * 계획이 스스로 만드는 결함 표면의 상한이다(베이스라인: must_fix의 33%가 계획이 발명한 done_when).
 */
export const PLAN_DEFAULTS = { mode: "single", debate_tiers: ["load-bearing"], max_done_when: 6 };
/** 단일 모드의 두 자리: 계획자(plan.v1을 내놓는 opus 역할)와 그것을 치는 반박자. */
export const PLAN_SINGLE_ROLES = ["synthesizer", "skeptic"];

// flaky_max(감사 M3)·quarantine_max_effective(감사 M4): 한 PR이 "원래 흔들리던 것"으로 밀어낼 수 있는
// 기존 테스트 수와, 격리 목록으로 RED를 뒤집을 수 있는 테스트 수의 상한. 상한이 없으면 목록이 긴
// 저장소에서 "빨간 테스트가 전부 목록에 있어서 GREEN"이 성립한다.
export const THRESHOLD_DEFAULTS = { diff_coverage_pct: 90, mutation_score_pct: 70, new_test_repeats: 3, flaky_isolation_runs: 3, flaky_base_runs: 5, flaky_max: 2, quarantine_max: 5, quarantine_max_effective: 3, quarantine_ttl_days: 28, quarantine_return_after: 30 };
export function loadHarness(root) {
  const h = parseToml(readFileSync(join(root, ".factory/harness.toml"), "utf8"));
  h.gates ??= {}; h.gates.thresholds = { ...THRESHOLD_DEFAULTS, ...(h.gates.thresholds || {}) };
  h.test = { test_glob: [], source_glob: [], unit_report: ".factory/out/unit.json", ...(h.test || {}) };
  h.commands ??= {}; h.commands.proof = { ...(h.commands.proof || {}) };
  // max_turns(KTB-16): `claude -p --max-turns`. 기본 12 — 5는 백그라운드 Workflow 디스패처의
  // 최소 턴 수(호출·접수증·완료 알림·출력 + output 파일 읽기 조각)를 감당하지 못했다.
  // merge_check_wait_sec(KTB-19): ready로 뒤집은 뒤 필수 체크가 queued/pending/in_progress에서
  // 벗어날 때까지 기다리는 상한(초). 15초 간격으로 폴링한다(merge-stage.js MERGE_CHECK_POLL_INTERVAL_MS).
  h.factory = { orchestration: "workflow", required_checks: ["factory/gates", "factory/review", "factory/integrity"], max_turns: 12, merge_check_wait_sec: 600, ...(h.factory || {}) };
  return h;
}
/**
 * `loadHarness`가 채우는 기본값(특히 `[factory].max_turns: 12`) 없이, harness.toml을 있는 그대로
 * 파싱한다. doctor의 "키가 아예 없다"는 판정(`init --upgrade` 안내)은 정규화된 객체로는 절대
 * 성립하지 않는다 — `loadHarness`가 항상 먼저 12를 채워 넣기 때문이다. 그 판정만을 위한 두 번째
 * 파스.
 */
export function loadHarnessRaw(root) {
  return parseToml(readFileSync(join(root, ".factory/harness.toml"), "utf8"));
}
export function loadRoles(root) {
  return parseToml(readFileSync(join(root, ".factory/roles.toml"), "utf8"));
}
export function loadCharter(root) {
  const { data } = parseFrontmatter(readFileSync(join(root, "docs/factory/CHARTER.md"), "utf8"));
  if (data.schema !== "factory.charter.v1") throw new Error("CHARTER.md frontmatter must declare schema: factory.charter.v1");
  return {
    status: data.status ?? "draft",
    tier_default: data.tier_default ?? "standard",
    limits: { K: 3, M: 3, R: 2, ...(data.limits || {}) },
    roster: data.roster || {},
    plan_roles: data.plan_roles || {},
    plan_rounds: { docs: 2, default: 3, ...(data.plan_rounds || {}) },
    plan: { ...PLAN_DEFAULTS, ...(data.plan || {}) },
    // quarantine 캡의 단일 출처는 harness [gates.thresholds].quarantine_max다 — 여기엔 두지 않는다.
    back_pressure: { awaiting_review_max: 4, ...(data.back_pressure || {}) },
    /**
     * 외부 감사 2026-09-14 H6 — `merge.human_gate`. **기본값을 여기서 채우지 않는다**(다른 필드와
     * 다른 점이다): 없는 것과 false는 다른 사실이기 때문이다. false는 "소유자가 다크 머지를 골랐다"는
     * 선언이고, 없는 것은 "아무도 고른 적이 없다"이다 — doctor가 전자는 WARN(`merge.dark`),
     * 후자는 FAIL(`charter.merge-human-gate-unset`)로 가른다. 기본값을 채우면 그 구분이 사라진다.
     */
    merge: { ...(data.merge || {}) },
    budget: data.budget || {},
    retro: data.retro || { every_merges: { initial: 1, min: 1, max: 20 }, light_on_merge: true },
  };
}

/** stage: "review" | "plan". 반환은 roles.toml에 정의된 이름만 허용. */
export function rosterFor(charter, roles, stage, tier) {
  let names;
  if (stage === "review") names = charter.roster[tier];
  // plan 로스터는 **모드가 정한다**(감사 Task 9). 단일 모드는 `plan_roles`를 아예 읽지 않는다 —
  // 그 목록은 4역할 토론의 로스터이고, 단일 모드에는 계획자 하나와 반박자 하나만 있다.
  // `plan_roles.single`로 그 둘을 갈아끼울 수 있게 열어 둔다(이름은 여전히 roles.toml에 있어야 한다).
  else if (stage === "plan") {
    names = planRoundsFor(charter, tier).mode === "single"
      ? (charter.plan_roles.single || PLAN_SINGLE_ROLES)
      : (charter.plan_roles[tier] || charter.plan_roles.default);
  }
  else throw new Error(`no roster for stage ${stage}`);
  if (!names) throw new Error(`no ${stage} roster for tier ${tier} in CHARTER`);
  const defined = Object.keys(roles[stage] || {});
  const missing = names.filter((n) => !defined.includes(n));
  if (missing.length) throw new Error(`roster names not defined in roles.toml: ${missing.join(", ")}`);
  return [...names];
}
/**
 * plan 스테이지가 **어떻게** 도는가 — `{mode, rounds}` (감사 Task 9, P2).
 *
 * 2026-09-14 베이스라인 대조(`docs/factory/dogfood/2026-09-14-plan-baseline.md`)가 기본값을 뒤집었다:
 * 4역할 토론(R1→R2→종합→서명)은 이슈당 5.4×–33.7×를 쓰고도 #15(1.00 vs 0.67)·#18(1.00 vs 0.33)에서
 * 단일 패스보다 **못했고**, must_fix 15건 중 5건은 토론이 스스로 발명한 done_when 때문에 생겼다.
 * 토론이 실제로 값을 산 곳은 표본에서 유일한 load-bearing 이슈 하나(#2)뿐이다.
 *
 * 그래서 기본은 `single`(opus 계획 1패스 + skeptic 1패스 = 2콜)이고, 토론은 `plan.debate_tiers`에
 * 이름이 있는 tier에서만 돈다. `plan.mode = "debate"`는 tier와 무관하게 언제나 토론이다(되돌리는 스위치).
 *
 * `rounds`는 **숫자 하나로 남는다** — verify-stage의 `expectedRounds`가 그 계약이고, 핸드오프 스키마는
 * 한 글자도 바뀌지 않는다. 단일 모드의 라운드 수는 2다(계획 → 반박).
 */
export const PLAN_SINGLE_ROUNDS = 2;
export function planRoundsFor(charter, tier) {
  const plan = charter.plan || PLAN_DEFAULTS;
  const debateTiers = Array.isArray(plan.debate_tiers) ? plan.debate_tiers : [];
  const mode = plan.mode === "debate" || debateTiers.includes(tier) ? "debate" : "single";
  const rounds = mode === "debate" ? (charter.plan_rounds[tier] ?? charter.plan_rounds.default) : PLAN_SINGLE_ROUNDS;
  return { mode, rounds };
}
