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
  // upstream(피드백 루프 Task 3): **기본값을 채우지 않는다.** 없는 것과 빈 문자열은 둘 다 "아무도
  // 고른 적이 없다"이고, 그때 `ktb` 발견은 교차 저장소 호출 없이 원래 이슈의 코멘트로만 남는다(spec §7).
  h.factory = { orchestration: "workflow", required_checks: ["factory/gates", "factory/review", "factory/integrity"], max_turns: 12, merge_check_wait_sec: 600, ...(h.factory || {}) };
  return h;
}

/**
 * ── Feedback loop Task 3 — `[factory].upstream`의 **유일한 독자** (spec §7) ──────────────────────
 *
 * `ktb` 발견(= KTB가 배포한 파일이 원인인 발견)이 갈 상류 저장소 `owner/repo`. 없으면 `null`이고,
 * 그때 루프는 **교차 저장소 호출을 한 번도 하지 않는다** — 라우팅은 설정으로 여는 옵트인이다.
 *
 * 모양을 여기서 검사하는 이유: 이 값은 그대로 `gh … -R <repo>`의 인자가 된다. 사람이 URL 전체
 * (`https://github.com/o/r`)나 공백이 섞인 값을 적어 두면 gh 호출이 매 머지마다 실패하고, 그 실패는
 * fail-safe 때문에 액션 한 줄로만 남아 아무도 보지 않는다. 모양이 아니면 `null` — "설정 안 됨"과
 * 같은 자리로 떨어뜨려 로컬 코멘트 경로를 타게 한다(조용한 반복 실패보다 낫다).
 */
export function upstreamRepoOf(harness) {
  const v = harness?.factory?.upstream;
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^[\w.-]+\/[\w.-]+$/.test(s) ? s : null;
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
/** CHARTER `triage.default`이 가질 수 있는 값. 세 번째 값은 없다 — `wont-do`는 판정이지 기본값이 아니다. */
export const TRIAGE_DEFAULT_VALUES = ["needs-info", "ready"];

/**
 * 외부 감사 2026-09-14 M1 — NEVER_AUTOMATE 항목 중 **경로 글롭으로 적힌 것**만 뽑는다.
 *
 * 그 목록은 사람이 읽는 산문이고 대부분은 글롭으로 표현되지 않는다("배포는 사람이 태그를 찍는다").
 * 하지만 `auth/**`·`billing/**`처럼 **경로 하나로 끝나는** 항목은 에이전트의 판단을 기다릴 이유가
 * 없다 — 스크립트가 그대로 다시 셀 수 있고(`neverAutomateHits`), 그래야 "triage가 못 봤다"가
 * 통하지 않는다. 뽑는 기준은 백틱 안의 토큰 중 `/`나 `*`를 든 것 하나뿐이다: `package.json`·
 * `version`처럼 글롭이 아닌 것을 글롭으로 읽으면 그 파일을 스치는 모든 PR이 wont-do가 된다.
 * 섹션 밖(Definition of Done 등)의 경로는 보지 않는다 — 이 목록의 권위는 그 제목에서 나온다.
 */
export function neverAutomateGlobs(body) {
  const m = /^##\s+NEVER_AUTOMATE.*$/m.exec(body || "");
  if (!m) return [];
  const rest = String(body).slice(m.index + m[0].length);
  const section = rest.split(/^##\s+/m)[0];
  const out = [];
  for (const tok of section.matchAll(/`([^`]+)`/g)) {
    const g = tok[1].trim();
    if (!/^[\w.*/@{}!,[\]-]+$/.test(g)) continue;                     // 공백이 섞이면 산문이지 경로가 아니다
    if (!/[/*]/.test(g)) continue;                                    // 글롭으로 표현 가능한 것만 (§5.3)
    if (!out.includes(g)) out.push(g);
  }
  return out;
}

export function loadCharter(root) {
  const { data, body } = parseFrontmatter(readFileSync(join(root, "docs/factory/CHARTER.md"), "utf8"));
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
    /**
     * 외부 감사 2026-09-14 M1 — `triage.default`. `merge.human_gate`와 **같은 이유로 기본값을
     * 채우지 않는다**: 애매한 이슈를 멈춰 세울 것인가(`needs-info`) 통과시킬 것인가(`ready`)는
     * 기본값이 아니라 소유자의 선언이고, 없는 것은 "아무도 고른 적이 없다"이다 — doctor가
     * `charter.triage-default-unset`(FAIL)로 그 침묵을 깬다. 채우면 그 구분이 사라지고, 감사가
     * 지적한 default-allow가 조용히 돌아온다.
     */
    triage: { ...(data.triage || {}) },
    /** 프론트매터가 아니라 **본문**에서 온다 — NEVER_AUTOMATE는 사람이 읽는 목록이 정본이다. */
    never_automate: neverAutomateGlobs(body),
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
