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
  return h;
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
