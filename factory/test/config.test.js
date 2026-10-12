import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHarness, loadCharter, loadRoles, rosterFor, planRoundsFor, PLAN_DEFAULTS, PLAN_SINGLE_ROLES } from "../lib/config.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ktb-"));
  mkdirSync(join(root, ".factory"), { recursive: true });
  mkdirSync(join(root, "docs/factory"), { recursive: true });
  writeFileSync(join(root, ".factory/harness.toml"), `schema = 1\n[harness]\nmaturity = "M1"\n[factory]\norchestration = "workflow"\n[commands]\nlint = "npm run lint"\nunit = "npm test"\n[gates]\nrequired = ["lint","unit"]\nfast = ["lint","unit"]\nfull = ["lint","unit"]\ndeep = ["lint","unit"]\n`);
  writeFileSync(join(root, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: ready\ntier_default: standard\nlimits: { K: 3, M: 3, R: 2 }\nroster:\n  docs: [correctness, spec-conformance]\n  standard: [correctness, architecture, spec-conformance, qa]\n  load-bearing: [correctness, security, architecture, spec-conformance, qa]\nplan_roles:\n  docs: [architect, skeptic]\n  default: [product-advocate, architect, skeptic, operator]\nplan_rounds: { docs: 2, default: 3 }\nback_pressure: { awaiting_review_max: 4 }\nbudget: {}\n---\n# Charter\n`);
  writeFileSync(join(root, ".factory/roles.toml"), `schema = 1\n[review.correctness]\nagent = ".claude/agents/reviewer-correctness.md"\n[review.security]\nagent = ".claude/agents/reviewer-security.md"\n[review.architecture]\nagent = "x"\n[review.spec-conformance]\nagent = "x"\n[review.qa]\nagent = "x"\n[plan.architect]\nagent = "x"\n[plan.skeptic]\nagent = "x"\n[plan.product-advocate]\nagent = "x"\n[plan.operator]\nagent = "x"\n[plan.synthesizer]\nagent = "x"\n`);
  return root;
}

test("loads harness.toml, CHARTER frontmatter, roles.toml", () => {
  const root = fixture();
  expect(loadHarness(root).harness.maturity).toBe("M1");
  expect(loadHarness(root).factory.orchestration).toBe("workflow");
  const ch = loadCharter(root);
  expect(ch.status).toBe("ready");
  expect(ch.limits.K).toBe(3);
  expect(ch.back_pressure).toEqual({ awaiting_review_max: 4 });          // quarantine 캡은 harness thresholds가 단일 출처
  expect(loadRoles(root).review.security.agent).toContain("security");
});

test("rosterFor: review roster by tier must exist in roles.toml; plan roster by tier", () => {
  const root = fixture();
  const ch = loadCharter(root), roles = loadRoles(root);
  expect(rosterFor(ch, roles, "review", "docs")).toEqual(["correctness", "spec-conformance"]);
  expect(rosterFor(ch, roles, "review", "load-bearing")).toHaveLength(5);
  // 감사 Task 9: plan 기본은 단일 패스다 — docs/standard의 plan 로스터는 `plan_roles`가 아니라
  // 단일 모드 로스터(계획자 + skeptic)다. `plan_roles`는 토론 tier에서만 읽힌다.
  expect(rosterFor(ch, roles, "plan", "docs")).toEqual(["synthesizer", "skeptic"]);
  expect(rosterFor(ch, roles, "plan", "standard")).toEqual(["synthesizer", "skeptic"]);
  expect(rosterFor(ch, roles, "plan", "load-bearing")).toEqual(["product-advocate", "architect", "skeptic", "operator"]);
  expect(() => rosterFor({ ...ch, roster: { docs: ["ghost"] } }, roles, "review", "docs")).toThrow(/not defined in roles.toml: ghost/);
});

// --- 감사 Task 9 (P2, 2026-09-14 plan 베이스라인): plan 기본 = 단일 opus 1패스 + skeptic 1패스 ---

test("charter.plan defaults: mode single, debate_tiers [load-bearing], max_done_when 6", () => {
  const ch = loadCharter(fixture());
  expect(ch.plan).toEqual({ mode: "single", debate_tiers: ["load-bearing"], max_done_when: 6 });
  expect(PLAN_DEFAULTS.mode).toBe("single");
  expect(PLAN_SINGLE_ROLES).toEqual(["synthesizer", "skeptic"]);
});

test("charter.plan takes partial overrides — missing keys keep the defaults", () => {
  const root = fixture();
  writeFileSync(join(root, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: ready\nplan: { max_done_when: 4 }\n---\n`);
  expect(loadCharter(root).plan).toEqual({ mode: "single", debate_tiers: ["load-bearing"], max_done_when: 4 });
});

test("planRoundsFor returns {mode, rounds}: single (2) by default, debate on a debate tier", () => {
  const ch = loadCharter(fixture());
  expect(planRoundsFor(ch, "docs")).toEqual({ mode: "single", rounds: 2 });
  expect(planRoundsFor(ch, "standard")).toEqual({ mode: "single", rounds: 2 });
  // load-bearing만 4역할 토론을 산다 — plan_rounds가 그 라운드 수의 출처로 남는다.
  expect(planRoundsFor(ch, "load-bearing")).toEqual({ mode: "debate", rounds: 3 });
});

test("plan.mode debate forces the 4-role debate on every tier; debate_tiers [] never debates", () => {
  const ch = loadCharter(fixture());
  const always = { ...ch, plan: { ...ch.plan, mode: "debate" } };
  expect(planRoundsFor(always, "docs")).toEqual({ mode: "debate", rounds: 2 });
  expect(planRoundsFor(always, "standard")).toEqual({ mode: "debate", rounds: 3 });
  const never = { ...ch, plan: { ...ch.plan, debate_tiers: [] } };
  expect(planRoundsFor(never, "load-bearing")).toEqual({ mode: "single", rounds: 2 });
});

test("loadCharter reports status verbatim (dormancy는 호출자가 판단한다)", () => {
  const root = fixture();
  expect(loadCharter(root).status).toBe("ready");
  writeFileSync(join(root, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: draft\n---\n`);
  expect(loadCharter(root).status).toBe("draft");
  writeFileSync(join(root, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\n---\n`);
  expect(loadCharter(root).status).toBe("draft");                       // 기본값
  writeFileSync(join(root, "docs/factory/CHARTER.md"), `---\nschema: nope.v1\n---\n`);
  expect(() => loadCharter(root)).toThrow(/factory.charter.v1/);
});

test("limits는 부분 오버라이드를 받는다 — 빠진 키는 기본값으로 채운다", () => {
  const root = fixture();
  writeFileSync(join(root, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: ready\nlimits: { K: 5 }\n---\n`);
  expect(loadCharter(root).limits).toEqual({ K: 5, M: 3, R: 2 });
});

test("loadHarness fills gates.thresholds / test / commands.proof defaults and keeps overrides", () => {
  const root = fixture();
  const h = loadHarness(root);
  // flaky_max / quarantine_max_effective: 감사 M3·M4 — PR당 제외 상한(ADR-023).
  expect(h.gates.thresholds).toEqual({ diff_coverage_pct: 90, mutation_score_pct: 70, new_test_repeats: 3, flaky_isolation_runs: 3, flaky_base_runs: 5, flaky_max: 2, quarantine_max: 5, quarantine_max_effective: 3, quarantine_ttl_days: 28, quarantine_return_after: 30 });
  expect(h.test.unit_report).toBe(".factory/out/unit.json");
  expect(h.test.test_glob).toEqual([]);
  expect(h.commands.proof).toEqual({});
  writeFileSync(join(root, ".factory/harness.toml"), readFileSync(join(root, ".factory/harness.toml"), "utf8") + `\n[gates.thresholds]\ndiff_coverage_pct = 80\n[test]\ntest_glob = ["test/**/*.test.js"]\n`);
  const h2 = loadHarness(root);
  expect(h2.gates.thresholds.diff_coverage_pct).toBe(80);
  expect(h2.gates.thresholds.mutation_score_pct).toBe(70);
  expect(h2.test.test_glob).toEqual(["test/**/*.test.js"]);
});

test("loadHarness fills factory.{orchestration,required_checks,max_turns,merge_check_wait_sec} defaults and keeps overrides", () => {
  const root = fixture();
  const h = loadHarness(root); // fixture already declares [factory] orchestration = "workflow"
  expect(h.factory).toEqual({ orchestration: "workflow", required_checks: ["factory/gates", "factory/review", "factory/integrity"], max_turns: 12, merge_check_wait_sec: 600 });

  const bare = mkdtempSync(join(tmpdir(), "ktb-"));
  mkdirSync(join(bare, ".factory"), { recursive: true });
  writeFileSync(join(bare, ".factory/harness.toml"), `schema = 1\n[harness]\nmaturity = "M1"\n[commands]\nlint = "npm run lint"\nunit = "npm test"\n[gates]\nrequired = ["lint"]\nfast = ["lint"]\nfull = ["lint"]\ndeep = ["lint"]\n`);
  expect(loadHarness(bare).factory).toEqual({ orchestration: "workflow", required_checks: ["factory/gates", "factory/review", "factory/integrity"], max_turns: 12, merge_check_wait_sec: 600 }); // no [factory] section at all

  writeFileSync(join(root, ".factory/harness.toml"), `schema = 1\n[harness]\nmaturity = "M1"\n[factory]\norchestration = "workflow"\nrequired_checks = ["factory/gates"]\n[commands]\nlint = "npm run lint"\nunit = "npm test"\n[gates]\nrequired = ["lint","unit"]\nfast = ["lint","unit"]\nfull = ["lint","unit"]\ndeep = ["lint","unit"]\n`);
  expect(loadHarness(root).factory.required_checks).toEqual(["factory/gates"]);
  expect(loadHarness(root).factory.orchestration).toBe("workflow");
});

// ── Feedback loop Task 3 — `[factory].upstream` (spec §7) ──────────────────────────────────────
// 기본값이 없는 키다: 없는 것과 빈 것은 둘 다 "아무도 고른 적이 없다"이고, 그때 루프는 교차 저장소
// 호출을 한 번도 하지 않는다. 모양이 틀린 값은 `null`로 떨어뜨린다 — 그대로 `gh -R`에 실리면 매
// 머지마다 조용히 실패하고, fail-safe 때문에 그 실패는 액션 한 줄로만 남아 아무도 보지 않는다.
test("upstreamRepoOf: owner/repo만 통과하고, 없거나 모양이 틀리면 null(= 로컬 코멘트 경로)", async () => {
  const { upstreamRepoOf, loadHarness: load } = await import("../lib/config.js");
  expect(upstreamRepoOf({ factory: { upstream: "LeeHyeonKyu/know_thy_build" } })).toBe("LeeHyeonKyu/know_thy_build");
  expect(upstreamRepoOf({ factory: { upstream: "  o/r  " } })).toBe("o/r");
  expect(upstreamRepoOf({ factory: {} })).toBeNull();
  expect(upstreamRepoOf({})).toBeNull();
  expect(upstreamRepoOf(undefined)).toBeNull();
  for (const bad of ["", "   ", "https://github.com/o/r", "o/r/x", "just-a-name", "o /r", 42, ["o/r"]]) {
    expect(upstreamRepoOf({ factory: { upstream: bad } })).toBeNull();
  }
  // loadHarness는 이 키에 기본값을 채우지 않는다(있으면 그대로 실려 온다)
  const root = fixture();
  expect(load(root).factory.upstream).toBeUndefined();
  expect(upstreamRepoOf(load(root))).toBeNull();
  writeFileSync(join(root, ".factory/harness.toml"), readFileSync(join(root, ".factory/harness.toml"), "utf8").replace("[factory]\n", "[factory]\nupstream = \"o/up\"\n"));
  expect(upstreamRepoOf(load(root))).toBe("o/up");
});

// ── #178 (S4a-1) — CHARTER `self_change`: 없으면 꺼짐(오늘의 동작), 모양이 틀리면 설정 오류 ─────────────────
test("test_178_self_change_config_defaults_and_validation", async () => {
  const { SELF_CHANGE_DEFAULTS } = await import("../lib/config.js");
  const root = fixture();
  const charterPath = join(root, "docs/factory/CHARTER.md");
  const base = readFileSync(charterPath, "utf8");
  const withBlock = (block) => writeFileSync(charterPath, base.replace("budget: {}\n", `budget: {}\n${block}`));

  // 없음 → 기본값 { false, false, 60 }. 실제 CHARTER 경로로 읽힌다.
  expect(SELF_CHANGE_DEFAULTS).toEqual({ auto_merge_non_judge: false, auto_merge_judge: false, operator_merge_judge: false, veto_minutes: 60 });
  expect(loadCharter(root).self_change).toEqual({ auto_merge_non_judge: false, auto_merge_judge: false, operator_merge_judge: false, veto_minutes: 60 });

  // 올바른 덮어쓰기(블록 맵) — 쓴 키만 바뀌고 나머지는 기본값.
  withBlock("self_change:\n  auto_merge_non_judge: true\n  veto_minutes: 20\n");
  expect(loadCharter(root).self_change).toEqual({ auto_merge_non_judge: true, auto_merge_judge: false, operator_merge_judge: false, veto_minutes: 20 });
  withBlock("self_change: { auto_merge_judge: true }\n");
  expect(loadCharter(root).self_change).toEqual({ auto_merge_non_judge: false, auto_merge_judge: true, operator_merge_judge: false, veto_minutes: 60 });
  // ADR-039 — 운영 door의 판정 경로 스위치. 기본 꺼짐, 불리언만.
  withBlock("self_change: { operator_merge_judge: true }\n");
  expect(loadCharter(root).self_change.operator_merge_judge).toBe(true);
  withBlock("self_change:\n  operator_merge_judge: \"true\"\n");
  expect(() => loadCharter(root)).toThrow(/self_change\.operator_merge_judge/);

  // 불리언이 아닌 스위치 → 설정 오류(어느 키인지 말한다). 기본값으로 조용히 접지 않는다.
  withBlock("self_change:\n  auto_merge_non_judge: yes-please\n");
  expect(() => loadCharter(root)).toThrow(/self_change\.auto_merge_non_judge/);
  withBlock("self_change:\n  auto_merge_judge: 1\n");
  expect(() => loadCharter(root)).toThrow(/self_change\.auto_merge_judge/);
  // veto_minutes: 음수
  withBlock("self_change:\n  veto_minutes: -5\n");
  expect(() => loadCharter(root)).toThrow(/self_change\.veto_minutes/);
  // veto_minutes: 0
  withBlock("self_change:\n  veto_minutes: 0\n");
  expect(() => loadCharter(root)).toThrow(/self_change\.veto_minutes/);
  // veto_minutes: 정수가 아님
  withBlock("self_change:\n  veto_minutes: 1.5\n");
  expect(() => loadCharter(root)).toThrow(/self_change\.veto_minutes/);
  withBlock("self_change:\n  veto_minutes: soon\n");
  expect(() => loadCharter(root)).toThrow(/self_change\.veto_minutes/);
});

test("test_178_self_change_config_defaults_and_validation — parseSelfChange rejects every malformed shape", async () => {
  const { parseSelfChange } = await import("../lib/config.js");
  expect(parseSelfChange(undefined)).toEqual({ auto_merge_non_judge: false, auto_merge_judge: false, operator_merge_judge: false, veto_minutes: 60 });
  expect(parseSelfChange({ auto_merge_non_judge: false, auto_merge_judge: true, veto_minutes: 1 })).toEqual({ auto_merge_non_judge: false, auto_merge_judge: true, operator_merge_judge: false, veto_minutes: 1 });
  for (const [raw, key] of [
    [{ auto_merge_non_judge: "true" }, "auto_merge_non_judge"], [{ auto_merge_non_judge: null }, "auto_merge_non_judge"],
    [{ auto_merge_judge: 0 }, "auto_merge_judge"],
    [{ veto_minutes: -1 }, "veto_minutes"], [{ veto_minutes: 0 }, "veto_minutes"], [{ veto_minutes: 2.5 }, "veto_minutes"],
    [{ veto_minutes: "60" }, "veto_minutes"], [{ veto_minutes: null }, "veto_minutes"],
    [{ veto_minute: 30 }, "veto_minute"], [true, "self_change"], [[1], "self_change"], [null, "self_change"], ["on", "self_change"],
  ]) {
    expect(() => parseSelfChange(raw), JSON.stringify(raw)).toThrow(new RegExp(key.replace(/[.]/g, "\\.")));
  }
});

// ── #189 (S4c) — CHARTER `self_change.breaker`: 키는 revert_streak 하나, 없으면 기본값 2, 그 밖은 설정 오류 ──────────────
test("test_189_breaker_opens_on_two_consecutive_reverts_of_judge_automerges — self_change.breaker config", async () => {
  const { parseSelfChange, breakerThresholds, BREAKER_DEFAULTS } = await import("../lib/config.js");
  const root = fixture();
  const charterPath = join(root, "docs/factory/CHARTER.md");
  const base = readFileSync(charterPath, "utf8");
  const withBlock = (block) => writeFileSync(charterPath, base.replace("budget: {}\n", `budget: {}\n${block}`));

  expect(BREAKER_DEFAULTS).toEqual({ revert_streak: 2 });
  // 키를 빼면 기본값(실제 CHARTER 경로로 읽힌다).
  expect(breakerThresholds(loadCharter(root).self_change)).toEqual({ revert_streak: 2 });
  withBlock("self_change:\n  auto_merge_judge: true\n");
  expect(breakerThresholds(loadCharter(root).self_change)).toEqual({ revert_streak: 2 });
  withBlock("self_change:\n  breaker:\n    revert_streak: 3\n");
  expect(loadCharter(root).self_change.breaker).toEqual({ revert_streak: 3 });
  expect(breakerThresholds(loadCharter(root).self_change)).toEqual({ revert_streak: 3 });
  // 이슈 초안의 다른 키(쿨다운·bad-ratio 창)는 이 엔진이 구현하지 않으므로 조용히 받지 않고 던진다.
  for (const key of ["cooldown_hours: 6", "window: 5", "bad_ratio: 0.4"]) {
    withBlock(`self_change:\n  breaker:\n    revert_streak: 2\n    ${key}\n`);
    expect(() => loadCharter(root), key).toThrow(new RegExp(`self_change\\.breaker.*${key.split(":")[0]}`));
  }
  // 모양이 틀린 값 → 설정 오류(기본값으로 접지 않는다).
  for (const [raw, re] of [
    [{ breaker: { revert_streak: 0 } }, /self_change\.breaker\.revert_streak/],
    [{ breaker: { revert_streak: -1 } }, /self_change\.breaker\.revert_streak/],
    [{ breaker: { revert_streak: 1.5 } }, /self_change\.breaker\.revert_streak/],
    [{ breaker: { revert_streak: "2" } }, /self_change\.breaker\.revert_streak/],
    [{ breaker: { revert_streak: null } }, /self_change\.breaker\.revert_streak/],
    [{ breaker: true }, /self_change\.breaker/],
    [{ breaker: [2] }, /self_change\.breaker/],
    [{ breaker: null }, /self_change\.breaker/],
  ]) {
    expect(() => parseSelfChange(raw), JSON.stringify(raw)).toThrow(re);
  }
  // 빈 맵은 "쓰지 않은 키는 기본값".
  expect(parseSelfChange({ breaker: {} }).breaker).toEqual({ revert_streak: 2 });
  // 기본값 객체는 공유되지 않는다(한 호출의 변경이 다음 호출로 새지 않는다).
  const a = breakerThresholds(undefined);
  a.revert_streak = 99;
  expect(breakerThresholds(undefined)).toEqual({ revert_streak: 2 });
  expect(Object.isFrozen(BREAKER_DEFAULTS)).toBe(true);
});
