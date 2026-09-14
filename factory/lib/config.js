import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseFrontmatter } from "./frontmatter.js";

export const THRESHOLD_DEFAULTS = { diff_coverage_pct: 90, mutation_score_pct: 70, new_test_repeats: 3, flaky_isolation_runs: 3, flaky_base_runs: 5, quarantine_max: 5, quarantine_ttl_days: 28, quarantine_return_after: 30 };
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
  else if (stage === "plan") names = charter.plan_roles[tier] || charter.plan_roles.default;
  else throw new Error(`no roster for stage ${stage}`);
  if (!names) throw new Error(`no ${stage} roster for tier ${tier} in CHARTER`);
  const defined = Object.keys(roles[stage] || {});
  const missing = names.filter((n) => !defined.includes(n));
  if (missing.length) throw new Error(`roster names not defined in roles.toml: ${missing.join(", ")}`);
  return [...names];
}
export function planRoundsFor(charter, tier) {
  return charter.plan_rounds[tier] ?? charter.plan_rounds.default;
}
