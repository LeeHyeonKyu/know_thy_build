import { test, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildContext, roleContextFor, contextManifestsFor, contextManifestLines, CONTEXT_MANIFEST_PREFIX } from "../lib/context.js";
import { renderHandoff } from "../lib/handoff.js";
import { validateManifest } from "../lib/qa-evidence.js";

function root() {
  const r = mkdtempSync(join(tmpdir(), "ctx-"));
  mkdirSync(join(r, ".factory"), { recursive: true }); mkdirSync(join(r, "docs/factory"), { recursive: true });
  writeFileSync(join(r, ".factory/harness.toml"), `schema = 1\n[harness]\nmaturity = "M0"\n[factory]\norchestration = "workflow"\n[commands]\nunit = "npm test"\n[gates]\nrequired = ["unit"]\nfast = ["unit"]\nfull = ["unit"]\ndeep = ["unit"]\n`);
  writeFileSync(join(r, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: ready\ntier_default: standard\nroster:\n  docs: [correctness]\n  standard: [correctness, qa, spec-conformance]\nplan_roles:\n  docs: [architect, skeptic]\n  default: [architect, skeptic, operator]\nplan_rounds: { docs: 2, default: 3 }\n---\n`);
  writeFileSync(join(r, ".factory/roles.toml"), `[triage]\nagent = ".claude/agents/factory-triage.md"\nmodel = "sonnet"\n[review.correctness]\nagent = ".claude/agents/reviewer-correctness.md"\nmodel = "opus"\nlessons = ".factory/lessons/reviewer-correctness.md"\ncold_read = true\n[review.qa]\nagent = ".claude/agents/reviewer-qa.md"\nmodel = "sonnet"\ncold_read = true\n[review.spec-conformance]\nagent = ".claude/agents/reviewer-spec-conformance.md"\nmodel = "sonnet"\ncold_read = false\n[plan.architect]\nagent = "a.md"\nmodel = "opus"\n[plan.skeptic]\nagent = "s.md"\nmodel = "opus"\n[plan.operator]\nagent = "o.md"\nmodel = "sonnet"\n[plan.synthesizer]\nagent = "syn.md"\nmodel = "opus"\n`);
  return r;
}

/** 객체 어디에든 이 이름의 키가 있는가 — cold read 문맥에서 "없다"를 구조적으로 확인하는 데 쓴다. */
function keysDeep(value, found = new Set()) {
  if (Array.isArray(value)) { for (const v of value) keysDeep(v, found); return found; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) { found.add(k); keysDeep(v, found); }
  }
  return found;
}

test("review context: tier from triage handoff, roster from charter, agents/lessons from roles, handoffs, spec_path from body", async () => {
  const r = root();
  const triage = renderHandoff({ stage: "triage", issue: 7, summary: "s", data: { schema: "factory.triage.v1", issue: 7, disposition: "ready", tier: "docs" } });
  const gh = { issue: vi.fn(async () => ({ number: 7, title: "T", body: "see docs/features/012.md", labels: ["factory:awaiting-review"] })), comments: vi.fn(async () => [{ id: 1, body: triage, createdAt: "2026-09-11T00:00:00Z" }]) };
  const ctx = await buildContext({ root: r, gh, issue: 7, stage: "review" });
  expect(ctx.tier).toBe("docs");
  expect(ctx.roster).toEqual(["correctness"]);
  expect(ctx.role_agents).toEqual({ correctness: ".claude/agents/reviewer-correctness.md" });
  expect(ctx.lessons).toEqual({ correctness: ".factory/lessons/reviewer-correctness.md" });
  expect(ctx.handoffs.triage.tier).toBe("docs");
  expect(ctx.spec_path).toBe("docs/features/012.md");
  expect(ctx.orchestration).toBe("workflow");
  expect(ctx.harness.maturity).toBe("M0");
  expect(existsSync(join(r, ".factory/out/context.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(r, ".factory/out/context.json"), "utf8")).issue.number).toBe(7);
});

/**
 * Structure D (리뷰 효율 Task 5) — rework 핸드오프가 실은 회귀 핀이 재디스패치된 빌더의 컨텍스트
 * (loaded.json.rework_pins)로 그대로 전달된다. guard가 붙은 핀은 다음 self-gate의 하드 게이트라
 * 빌더가 먼저 알아야 하고, 산문 핀은 체크리스트다. rework가 아닌 리뷰 핸드오프는 핀을 나르지 않는다.
 */
test("Task 5: a rework review handoff carries regression pins into the re-dispatched builder's loaded context", async () => {
  const r = root();
  const review = renderHandoff({ stage: "review", issue: 30, summary: "s", data: {
    schema: "factory.review.v1", issue: 30, pr: 3, head_sha: "a".repeat(40), round: 1, orchestration: "workflow",
    decision: "rework", verdicts: [{ role: "correctness", verdict: "reject", confidence: "high", must_fix: [{ id: "dw1", where: "x", claim: "c", evidence: "e" }], should_fix: [], verified: [] }],
    pins: [{ id: "dw1", guard: { kind: "test", ref: "test_30_create" }, text: "create returns 201" }, { id: "mf-prose", guard: null, text: "heading is misleading" }],
  } });
  const gh = { issue: vi.fn(async () => ({ number: 30, title: "T", body: "", labels: ["factory:rework"] })), comments: vi.fn(async () => [{ id: 1, body: review, createdAt: "2026-09-11T00:00:00Z" }]) };
  await buildContext({ root: r, gh, issue: 30, stage: "implement" });
  const loaded = JSON.parse(readFileSync(join(r, ".factory/out/loaded.json"), "utf8"));
  expect(loaded.rework_pins).toEqual([
    { id: "dw1", guard: { kind: "test", ref: "test_30_create" }, text: "create returns 201" },
    { id: "mf-prose", guard: null, text: "heading is misleading" },
  ]);
});

/**
 * 감사 Task 9: standard tier의 plan은 **단일 패스**다 — 계획자 1 + skeptic 1. `rounds`는 여전히
 * 숫자 하나로 남고(verify-stage의 expectedRounds가 그 계약이다), 모드와 done_when 상한은
 * 새 `plan` 블록으로 실린다.
 */
test("plan context (default tier): single mode roster, rounds 2, plan block carries mode + max_done_when", async () => {
  const r = root();
  const gh = { issue: vi.fn(async () => ({ number: 8, title: "T", body: "", labels: ["factory:ready"] })), comments: vi.fn(async () => []) };
  const ctx = await buildContext({ root: r, gh, issue: 8, stage: "plan" });
  expect(ctx.tier).toBe("standard");
  expect(ctx.roster).toEqual(["synthesizer", "skeptic"]);
  expect(ctx.rounds).toBe(2);
  expect(ctx.plan).toEqual({ mode: "single", max_done_when: 6 });
  expect(ctx.spec_path).toBe(null);
  expect(JSON.parse(readFileSync(join(r, ".factory/out/context.json"), "utf8")).plan).toEqual({ mode: "single", max_done_when: 6 });
});

/**
 * Task 9 (Structure H, KTB-51) — the repair turn's validator reasons reach the planner the same way
 * Task 5's pins reach the builder: buildContext({ planRepair }) surfaces them into loaded.json as
 * `plan_repair` (and onto ctx). Present ONLY on the one repair turn; a normal plan build carries none.
 */
test("Task 9: buildContext({ planRepair }) surfaces the validator reasons into loaded.plan_repair and ctx (plan stage only)", async () => {
  const r = root();
  const gh = { issue: vi.fn(async () => ({ number: 18, title: "T", body: "", labels: ["factory:ready"] })), comments: vi.fn(async () => []) };
  const reasons = ["dissent without done_when: d2, d3"];
  const ctx = await buildContext({ root: r, gh, issue: 18, stage: "plan", planRepair: reasons });
  expect(ctx.plan_repair).toEqual(reasons);
  const loaded = JSON.parse(readFileSync(join(r, ".factory/out/loaded.json"), "utf8"));
  expect(loaded.plan_repair).toEqual(reasons);

  // a normal plan build (no planRepair) carries no plan_repair, on ctx or in loaded.json.
  const clean = root();
  const ctx2 = await buildContext({ root: clean, gh, issue: 18, stage: "plan" });
  expect(ctx2.plan_repair).toBeUndefined();
  expect(JSON.parse(readFileSync(join(clean, ".factory/out/loaded.json"), "utf8")).plan_repair).toBeUndefined();

  // it is a plan-stage fact: a review build ignores planRepair entirely.
  const rev = root();
  await buildContext({ root: rev, gh, issue: 18, stage: "review", planRepair: reasons });
  expect(JSON.parse(readFileSync(join(rev, ".factory/out/loaded.json"), "utf8")).plan_repair).toBeUndefined();
});

test("plan context (load-bearing tier): the 4-role debate survives — plan_roles + plan_rounds", async () => {
  const r = root();
  const triage = renderHandoff({ stage: "triage", issue: 9, summary: "s", data: { schema: "factory.triage.v1", issue: 9, disposition: "ready", tier: "load-bearing" } });
  const gh = { issue: vi.fn(async () => ({ number: 9, title: "T", body: "", labels: ["factory:ready"] })), comments: vi.fn(async () => [{ id: 1, body: triage, createdAt: "2026-09-14T00:00:00Z" }]) };
  const ctx = await buildContext({ root: r, gh, issue: 9, stage: "plan" });
  expect(ctx.tier).toBe("load-bearing");
  expect(ctx.roster).toEqual(["architect", "skeptic", "operator"]);
  expect(ctx.rounds).toBe(3);
  expect(ctx.plan).toEqual({ mode: "debate", max_done_when: 6 });
});

test("review context carries no plan block — the mode is a plan-stage fact", async () => {
  const r = root();
  const gh = { issue: vi.fn(async () => ({ number: 10, title: "T", body: "", labels: [] })), comments: vi.fn(async () => []) };
  const ctx = await buildContext({ root: r, gh, issue: 10, stage: "review" });
  expect(ctx.plan).toBeUndefined();
  expect(ctx.rounds).toBeUndefined();
});

// ADR-020 KTB-23 fix — spec-conformance 리뷰어는 `factory:harness` 이슈에서 빌드/러너 설정 변경을
// "보호 경로 위반"으로 reject하면 안 된다(그것이 그 이슈가 하는 일이다). 그 판단의 유일한 재료는
// context.json의 `issue.labels`다 — 리뷰어 역할 파일이 그 경로를 이름으로 가리키므로 여기서 고정한다.
test("context.json carries the issue's labels — the reviewers' only view of factory:harness", async () => {
  const r = root();
  const labels = ["factory:awaiting-review", "factory:harness", "factory:tier-standard"];
  const gh = { issue: vi.fn(async () => ({ number: 15, title: "harness: promote to M2", body: "", labels })), comments: vi.fn(async () => []) };
  const ctx = await buildContext({ root: r, gh, issue: 15, stage: "review" });
  expect(ctx.issue.labels).toEqual(labels);
  const onDisk = JSON.parse(readFileSync(join(r, ".factory/out/context.json"), "utf8"));
  expect(onDisk.issue.labels).toEqual(labels);
});

// ── 외부 감사 H3: tier는 자기 신고였고, 그 신고가 자기 채점자(로스터)를 골랐다 ─────────────
// `tierFloor`(diff가 정하는 바닥)는 게이트 **레벨**만 올렸고 소비처가 0곳이었다 — triage가 "docs"라고
// 적으면 리뷰어 한 명, 계획 라운드도 docs의 것이었다. 이제 `tier_effective = max(신고, 바닥)`이고
// 로스터·계획 모드/라운드가 전부 그것을 읽는다. `tier`(신고)는 기록으로 남는다 — 둘이 갈린 사실
// 자체가 사람이 읽어야 할 신호이기 때문이다(`tier_source`).
import { makeFakeRun } from "../lib/exec.js";

const tierRoot = () => {
  const r = mkdtempSync(join(tmpdir(), "ctx-tier-"));
  mkdirSync(join(r, ".factory"), { recursive: true }); mkdirSync(join(r, "docs/factory"), { recursive: true });
  writeFileSync(join(r, ".factory/harness.toml"), `schema = 1\n[harness]\nmaturity = "M0"\n[factory]\norchestration = "workflow"\n[commands]\nunit = "npm test"\n[gates]\nrequired = ["unit"]\nfast = ["unit"]\nfull = ["unit"]\ndeep = ["unit"]\n[load_bearing]\npaths = []\n`);
  writeFileSync(join(r, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: ready\ntier_default: standard\nroster:\n  docs: [correctness]\n  standard: [correctness, qa, security, architecture]\n  load-bearing: [correctness, qa, security, architecture]\nplan_roles:\n  docs: [architect, skeptic]\n  default: [architect, skeptic, operator]\nplan_rounds: { docs: 2, default: 3 }\nplan:\n  debate_tiers: [standard, load-bearing]\n---\n`);
  writeFileSync(join(r, ".factory/roles.toml"), `[review.correctness]\nagent = "c.md"\n[review.qa]\nagent = "q.md"\n[review.security]\nagent = "s.md"\n[review.architecture]\nagent = "ar.md"\n[plan.architect]\nagent = "a.md"\n[plan.skeptic]\nagent = "sk.md"\n[plan.operator]\nagent = "o.md"\n[plan.synthesizer]\nagent = "syn.md"\n`);
  return r;
};
const diffRun = (nameStatus) => makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "diff", result: { code: 0, stdout: nameStatus, stderr: "" } }]);
const triageOf = (issue, tier) => ({ id: 1, body: renderHandoff({ stage: "triage", issue, summary: "s", data: { schema: "factory.triage.v1", issue, disposition: "ready", tier } }), createdAt: "2026-09-14T00:00:00Z" });

test("H3: docs로 신고된 이슈라도 diff가 코드를 건드리면 로스터는 standard의 4명이다", async () => {
  const r = tierRoot();
  const gh = { issue: vi.fn(async () => ({ number: 21, title: "T", body: "", labels: [] })), comments: vi.fn(async () => [triageOf(21, "docs")]) };
  const ctx = await buildContext({ root: r, gh, issue: 21, stage: "review", run: diffRun("M\tfactory/lib/merge-stage.js\n"), base: "b" });
  expect(ctx.tier).toBe("docs");                       // 신고는 기록으로 남는다
  expect(ctx.tier_effective).toBe("standard");
  expect(ctx.tier_source).toBe("floor");
  expect(ctx.roster).toEqual(["correctness", "qa", "security", "architecture"]);
  expect(JSON.parse(readFileSync(join(r, ".factory/out/context.json"), "utf8")).tier_effective).toBe("standard");
});

// H3 × M5 — 로더 페이로드는 워크플로가 읽는 유일한 tier다. 신고가 아니라 실효 tier가 실려야
// 로스터를 고른 값과 워크플로가 읽는 값이 같다(갈린 사실은 `tier_source`로 남는다).
test("H3×M5: loaded.json의 tier는 실효 tier다 — 신고가 낮아도 워크플로는 올라간 쪽을 읽는다", async () => {
  const r = tierRoot();
  const gh = { issue: vi.fn(async () => ({ number: 27, title: "T", body: "", labels: [] })), comments: vi.fn(async () => [triageOf(27, "docs")]) };
  await buildContext({ root: r, gh, issue: 27, stage: "review", run: diffRun("M\tfactory/lib/merge-stage.js\n"), base: "b" });
  const loaded = JSON.parse(readFileSync(join(r, ".factory/out/loaded.json"), "utf8"));
  expect([loaded.tier, loaded.tier_effective, loaded.tier_source]).toEqual(["standard", "standard", "floor"]);
  expect(loaded.roster.map((x) => x.name)).toEqual(["correctness", "qa", "security", "architecture"]);
});

test("H3: 계획 모드·라운드도 tier_effective를 따른다 — docs 신고가 토론을 피해 가지 못한다", async () => {
  const r = tierRoot();
  const gh = { issue: vi.fn(async () => ({ number: 22, title: "T", body: "", labels: [] })), comments: vi.fn(async () => [triageOf(22, "docs")]) };
  const ctx = await buildContext({ root: r, gh, issue: 22, stage: "plan", run: diffRun("M\tfactory/lib/merge-stage.js\n"), base: "b" });
  expect(ctx.tier_effective).toBe("standard");
  expect(ctx.plan.mode).toBe("debate");
  expect(ctx.rounds).toBe(3);
  expect(ctx.roster).toEqual(["architect", "skeptic", "operator"]);
});

test("H3: 문서만 바뀐 docs 이슈는 그대로 docs다 — 바닥은 올리기만 하고 내리지 않는다", async () => {
  const r = tierRoot();
  const gh = { issue: vi.fn(async () => ({ number: 23, title: "T", body: "", labels: [] })), comments: vi.fn(async () => [triageOf(23, "docs")]) };
  const ctx = await buildContext({ root: r, gh, issue: 23, stage: "review", run: diffRun("M\tdocs/a.md\n"), base: "b" });
  expect([ctx.tier_effective, ctx.tier_source]).toEqual(["docs", "triage"]);
  expect(ctx.roster).toEqual(["correctness"]);
});

test("H3: diff를 못 읽으면 바닥은 standard다 — 판정 불가가 docs로 내려앉지 않는다", async () => {
  const r = tierRoot();
  const failing = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "diff", result: { code: 128, stdout: "", stderr: "fatal: bad revision" } }]);
  const gh = { issue: vi.fn(async () => ({ number: 24, title: "T", body: "", labels: [] })), comments: vi.fn(async () => [triageOf(24, "docs")]) };
  const ctx = await buildContext({ root: r, gh, issue: 24, stage: "review", run: failing, base: "b" });
  expect([ctx.tier_effective, ctx.tier_source]).toEqual(["standard", "floor"]);
});

test("H3: load_bearing 경로를 건드리면 standard 신고도 load-bearing으로 올라간다", async () => {
  const r = tierRoot();
  writeFileSync(join(r, ".factory/harness.toml"), readFileSync(join(r, ".factory/harness.toml"), "utf8").replace("paths = []", 'paths = ["factory/lib/integrity.js"]'));
  const gh = { issue: vi.fn(async () => ({ number: 25, title: "T", body: "", labels: [] })), comments: vi.fn(async () => [triageOf(25, "standard")]) };
  const ctx = await buildContext({ root: r, gh, issue: 25, stage: "review", run: diffRun("M\tfactory/lib/integrity.js\n"), base: "b" });
  expect([ctx.tier_effective, ctx.tier_source]).toEqual(["load-bearing", "floor"]);
});

// diff를 아예 물어보지 않은 호출자(run/base 미주입)는 바닥을 계산하지 않는다 — 그때 tier_effective는
// 신고 그대로이고 `tier_floor`는 null이다. 생산 경로(run-stage·bin/build-context)는 둘 다 넘긴다.
test("H3: run/base가 없으면 바닥 계산은 없다 — tier_floor는 null, tier_effective는 신고 그대로", async () => {
  const r = tierRoot();
  const gh = { issue: vi.fn(async () => ({ number: 26, title: "T", body: "", labels: [] })), comments: vi.fn(async () => [triageOf(26, "docs")]) };
  const ctx = await buildContext({ root: r, gh, issue: 26, stage: "review" });
  expect([ctx.tier_effective, ctx.tier_source, ctx.tier_floor]).toEqual(["docs", "triage", null]);
});

// ── 감사 H4: cold read는 프롬프트의 약속이 아니라 파일 경계다 ──────────────────────────────────

const planHandoff = (issue) => renderHandoff({
  stage: "plan", issue, summary: "s",
  data: {
    schema: "factory.plan.v1", issue, tier: "standard", summary: "export CSV",
    done_when: [{ id: "dw1", text: "header row", verify: "test_h", level: "unit", rationale: "계획의 산문" }],
    files_expected: ["src/export/csv.js"], non_goals: ["streaming"],
    dissent_log: [{ role: "skeptic", objection: "이건 만들지 말자", resolution: "unresolved" }],
  },
});
const implementHandoff = (issue) => renderHandoff({
  stage: "implement", issue, summary: "s",
  data: {
    schema: "factory.implement.v1", issue, pr: 31, head_sha: "a".repeat(40),
    verifier: { verdict: "approve", confidence: "high", findings: [] },
    tests_added: ["test/export.test.js"], summary: "builder가 스스로 설명한 말",
  },
});

function reviewRoot() {
  const r = root();
  const issue = 7;
  const gh = {
    issue: vi.fn(async () => ({ number: issue, title: "T", body: "see docs/features/012.md\n\n## Acceptance\n- CSV에 헤더 줄이 있다\n\n## Notes\nn/a" })),
    comments: vi.fn(async () => [
      { id: 1, body: renderHandoff({ stage: "triage", issue, summary: "s", data: { schema: "factory.triage.v1", issue, disposition: "ready", tier: "standard" } }), createdAt: "2026-09-11T00:00:00Z" },
      { id: 2, body: planHandoff(issue), createdAt: "2026-09-12T00:00:00Z" },
      { id: 3, body: implementHandoff(issue), createdAt: "2026-09-13T00:00:00Z" },
    ]),
  };
  return { r, gh, issue };
}

test("H4: buildContext writes context.json (full) AND one context.<role>.json per roster role", async () => {
  const { r, gh, issue } = reviewRoot();
  await buildContext({ root: r, gh, issue, stage: "review" });
  expect(existsSync(join(r, ".factory/out/context.json"))).toBe(true);
  for (const role of ["correctness", "qa", "spec-conformance"]) {
    expect(existsSync(join(r, `.factory/out/context.${role}.json`)), role).toBe(true);
  }
  // 오케스트레이터의 파일은 여전히 전부를 담는다 — 걷어내는 것은 역할이 받는 사본뿐이다.
  expect(JSON.parse(readFileSync(join(r, ".factory/out/context.json"), "utf8")).handoffs.implement.verifier.verdict).toBe("approve");
});

test("H4: no cold-read reviewer context contains handoffs.implement / the verifier verdict — the file simply does not have them", async () => {
  const { r, gh, issue } = reviewRoot();
  await buildContext({ root: r, gh, issue, stage: "review" });
  for (const role of ["correctness", "qa"]) {
    const rc = JSON.parse(readFileSync(join(r, `.factory/out/context.${role}.json`), "utf8"));
    expect(rc.cold_read, role).toBe(true);
    const keys = keysDeep(rc);
    for (const forbidden of ["handoffs", "implement", "verifier", "tests_added", "dissent_log", "files_expected", "non_goals", "verdicts"]) {
      expect(keys.has(forbidden), `${role} must not carry ${forbidden}`).toBe(false);
    }
    // 받는 것: 이슈·tier·로스터·자기 lessons·PR 번호/head sha·게이트 요약·done_when(4필드)뿐.
    expect(rc.issue.number).toBe(issue);
    // tier는 쌍으로 간다(H3) — 신고와 실효를 함께, 갈렸는지까지.
    expect([rc.tier, rc.tier_effective, rc.tier_source]).toEqual(["standard", "standard", "triage"]);
    expect(rc.roster).toEqual(["correctness", "qa", "spec-conformance"]);
    expect(rc.pr).toBe(31);
    expect(rc.head_sha).toBe("a".repeat(40));
    expect(rc.gates.required).toEqual(["unit"]);
    expect(rc.done_when).toEqual([{ id: "dw1", text: "header row", verify: "test_h", level: "unit" }]);
  }
  expect(JSON.parse(readFileSync(join(r, ".factory/out/context.correctness.json"), "utf8")).lessons)
    .toBe(".factory/lessons/reviewer-correctness.md");
});

/**
 * 리뷰 효율 Task 1 (`ui`의 A-MF1과 같은 부류) — 수용 계약(`check`+`rubric`)이 cold-read 투영본을
 * 살아서 통과해야 Task 3/7이 그것을 읽는다. `DONE_WHEN_FIELDS`에서 빠지면 새 계획은 id/text/level만
 * 남아(새 계획엔 `verify`도 없다) 리뷰어가 채점할 계약이 닿지 않는다.
 */
test("Task 1: the qa/correctness cold-read context keeps check and rubric for a done_when item", async () => {
  const r = root();
  const issue = 7;
  const contractPlan = renderHandoff({
    stage: "plan", issue, summary: "s",
    data: {
      schema: "factory.plan.v1", issue, tier: "standard", summary: "export CSV",
      done_when: [{ id: "dw1", text: "header row", level: "unit", check: { kind: "test", ref: "test_7_header" }, rubric: "the reviewer confirms a header row is present", rationale: "계획의 산문" }],
      files_expected: ["src/export/csv.js"], non_goals: [], dissent_log: [],
    },
  });
  const gh = {
    issue: vi.fn(async () => ({ number: issue, title: "T", body: "n/a" })),
    comments: vi.fn(async () => [
      { id: 1, body: renderHandoff({ stage: "triage", issue, summary: "s", data: { schema: "factory.triage.v1", issue, disposition: "ready", tier: "standard" } }), createdAt: "2026-09-11T00:00:00Z" },
      { id: 2, body: contractPlan, createdAt: "2026-09-12T00:00:00Z" },
      { id: 3, body: implementHandoff(issue), createdAt: "2026-09-13T00:00:00Z" },
    ]),
  };
  await buildContext({ root: r, gh, issue, stage: "review" });
  for (const role of ["correctness", "qa"]) {
    const rc = JSON.parse(readFileSync(join(r, `.factory/out/context.${role}.json`), "utf8"));
    expect(rc.done_when, role).toEqual([{ id: "dw1", text: "header row", level: "unit", check: { kind: "test", ref: "test_7_header" }, rubric: "the reviewer confirms a header row is present" }]);
  }
});

test("H4: spec-conformance (cold_read = false) gets the full file plus the issue's acceptance text", async () => {
  const { r, gh, issue } = reviewRoot();
  await buildContext({ root: r, gh, issue, stage: "review" });
  const rc = JSON.parse(readFileSync(join(r, ".factory/out/context.spec-conformance.json"), "utf8"));
  expect(rc.cold_read).toBe(false);
  expect(rc.handoffs.plan.files_expected).toEqual(["src/export/csv.js"]);
  expect(rc.acceptance).toBe("- CSV에 헤더 줄이 있다");
});

/**
 * ── Feedback loop Task 1 — the per-role context manifest (spec §5 context adequacy, §10 Q1) ────
 *
 * 컨텍스트 적정성 신호는 "역할이 **보지 못한** 필드와 그 역할이 놓친 결함을 나중에 상관"시킨다.
 * 그러려면 무엇을 보여줬는지가 런 시점에 durable하게 남아야 한다 — cold-read 투영본은 런이 끝나면
 * `.factory/out/`과 함께 사라진다. 남기는 것은 **필드 이름뿐**이다(§10 Q1: 값도, 해시도 아니다).
 */
test("Task 1: a [correctness, spec-conformance] roster yields two context manifests — names only (§10 Q1)", async () => {
  const { r, gh, issue } = reviewRoot();
  writeFileSync(join(r, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: ready\ntier_default: standard\nroster:\n  docs: [correctness]\n  standard: [correctness, spec-conformance]\nplan_roles:\n  docs: [architect, skeptic]\n  default: [architect, skeptic, operator]\nplan_rounds: { docs: 2, default: 3 }\n---\n`);
  const ctx = await buildContext({ root: r, gh, issue, stage: "review" });
  expect(ctx.roster).toEqual(["correctness", "spec-conformance"]);
  const manifests = ctx.context_manifests;
  expect(manifests.map((m) => m.role)).toEqual(["correctness", "spec-conformance"]);

  const cold = manifests[0], full = manifests[1];
  expect(cold.cold_read).toBe(true);
  expect(full.cold_read).toBe(false);
  // 매니페스트는 실제로 쓰인 `context.<role>.json`의 최상위 키와 정확히 같다(+ done_when 하위 필드).
  const fileKeys = (role) => Object.keys(JSON.parse(readFileSync(join(r, `.factory/out/context.${role}.json`), "utf8"))).sort();
  expect(cold.fields.filter((f) => !f.startsWith("done_when."))).toEqual(fileKeys("correctness"));
  expect(full.fields.filter((f) => !f.startsWith("done_when."))).toEqual(fileKeys("spec-conformance"));
  // cold read가 받은 done_when은 `DONE_WHEN_FIELDS`로 걸러진 것뿐이다 — `rationale`은 못 봤다.
  expect(cold.fields.filter((f) => f.startsWith("done_when."))).toEqual(["done_when.id", "done_when.level", "done_when.text", "done_when.verify"]);
  expect(cold.fields).not.toContain("handoffs");
  // 전체 ctx를 받은 역할은 계획 산문까지 본 것이고, 매니페스트가 그것을 말한다.
  expect(full.fields).toContain("handoffs");
  expect(full.fields).toContain("done_when.rationale");
  // 값은 한 글자도 싣지 않는다(§10 Q1: 이름만).
  const dumped = JSON.stringify(manifests);
  expect(dumped).not.toContain("header row");
  expect(dumped).not.toContain("계획의 산문");

  // 런 레코드가 받는 줄: prefix + 한 줄 JSON(Task 3의 harvester가 정규식으로 읽는다).
  const lines = contextManifestLines(ctx);
  expect(lines).toHaveLength(2);
  expect(lines[0].startsWith(CONTEXT_MANIFEST_PREFIX)).toBe(true);
  expect(lines[0]).not.toContain("\n");
  expect(JSON.parse(lines[0].slice(CONTEXT_MANIFEST_PREFIX.length)))
    .toEqual({ ...cold, run_id: null, runner: null });
});

/**
 * 리뷰 provenance — `docs/factory/runs/**`는 에이전트가 덧붙일 수 있고 harvester는 첫 매치를 집는다.
 * 줄이 자기를 쓴 런을 지목해야 T3가 어느 런에도 묶이지 않는 줄을 무시할 수 있다.
 */
test("리뷰 provenance: the manifest line names the run that wrote it (and the round when known)", () => {
  const ctx = { roles: { correctness: { cold_read: true } }, issue: { number: 7 }, stage: "review", handoffs: {} };
  const parsed = JSON.parse(contextManifestLines(ctx, { runId: "1234", runnerId: "gha-1234", round: 3 })[0].slice(CONTEXT_MANIFEST_PREFIX.length));
  expect(parsed).toMatchObject({ role: "correctness", cold_read: true, run_id: "1234", runner: "gha-1234", round: 3 });
  const bare = JSON.parse(contextManifestLines(ctx)[0].slice(CONTEXT_MANIFEST_PREFIX.length));
  expect([bare.run_id, bare.runner, "round" in bare]).toEqual([null, null, false]);
});

test("Task 1: the manifest can be derived from a context alone, and never throws", () => {
  const ctx = {
    roles: { correctness: { cold_read: true }, "spec-conformance": { cold_read: false } },
    issue: { number: 7, body: "" }, stage: "review", roster: ["correctness", "spec-conformance"],
    handoffs: { plan: { done_when: [{ id: "dw1", text: "t", guard: null }] } },
  };
  const derived = contextManifestsFor(ctx);
  expect(derived.map((m) => m.role)).toEqual(["correctness", "spec-conformance"]);
  expect(derived[0].fields).toContain("done_when.id");
  expect(derived[0].fields).not.toContain("done_when.guard");   // cold read는 guard를 못 본다
  expect(derived[1].fields).toContain("done_when.guard");
  expect(contextManifestsFor(null)).toEqual([]);
  expect(contextManifestLines(undefined)).toEqual([]);
});

test("H4: roleContextFor is a pure function of the context and the role's cold_read flag", async () => {
  const { r, gh, issue } = reviewRoot();
  const ctx = await buildContext({ root: r, gh, issue, stage: "review" });
  expect(roleContextFor(ctx, "qa").handoffs).toBeUndefined();
  expect(roleContextFor(ctx, "spec-conformance").handoffs.implement.pr).toBe(31);
});

// ── 감사 M5: 로더가 돌려주던 것을 Node가 결정적으로 만든다 ─────────────────────────────────────

test("M5: context.json carries roles[<name>].model + cold_read, and .factory/out/loaded.json is the loader's payload", async () => {
  const { r, gh, issue } = reviewRoot();
  const ctx = await buildContext({ root: r, gh, issue, stage: "review" });
  expect(ctx.roles.correctness).toEqual({
    agent: ".claude/agents/reviewer-correctness.md", agentType: "reviewer-correctness", model: "opus",
    lessons: ".factory/lessons/reviewer-correctness.md", cold_read: true, context: ".factory/out/context.correctness.json",
  });
  expect(ctx.roles["spec-conformance"].cold_read).toBe(false);

  const loaded = JSON.parse(readFileSync(join(r, ".factory/out/loaded.json"), "utf8"));
  expect(loaded.issue).toBe(issue);
  expect(loaded.stage).toBe("review");
  expect(loaded.tier).toBe("standard");
  expect(loaded.maturity).toBe("M0");
  expect(loaded.orchestration).toBe("workflow");
  expect(loaded.pr).toBe(31);
  expect(loaded.head_sha).toBe("a".repeat(40));
  expect(loaded.roster.map((x) => [x.name, x.agentType, x.model])).toEqual([
    ["correctness", "reviewer-correctness", "opus"],
    ["qa", "reviewer-qa", "sonnet"],
    ["spec-conformance", "reviewer-spec-conformance", "sonnet"],
  ]);
  expect(loaded.contexts.qa).toBe(".factory/out/context.qa.json");
});

/**
 * ADR-020 KTB-43 — 빌더에게 "이 파일들은 커밋하지 마라"를 말하려면 그 목록이 프롬프트에 있어야
 * 하는데, 워크플로 스크립트는 파일을 읽을 수 없다(§4.2.3). 그래서 스테이지가 찍은 KTB-39 기준선이
 * `loaded.json`을 타고 간다 — 없으면 빈 배열이지 `undefined`가 아니다(워크플로가 그대로 filter한다).
 */
test("KTB-43: the stage's setup_dirty baseline reaches context.json and the loaded payload", async () => {
  const { r, gh, issue } = reviewRoot();
  const setupDirty = { ok: true, entries: [{ path: "client/analysis_options.yaml", code: " M" }, { path: "client/analysis_options.yaml", code: " M" }, { path: "client/gen/x.dart", code: "??" }] };
  const ctx = await buildContext({ root: r, gh, issue, stage: "review", setupDirty });
  expect(ctx.setup_dirty).toEqual(["client/analysis_options.yaml", "client/gen/x.dart"]);   // 중복은 접힌다
  expect(JSON.parse(readFileSync(join(r, ".factory/out/loaded.json"), "utf8")).setup_dirty)
    .toEqual(["client/analysis_options.yaml", "client/gen/x.dart"]);

  const clean = reviewRoot();
  await buildContext({ root: clean.r, gh: clean.gh, issue: clean.issue, stage: "review" });
  expect(JSON.parse(readFileSync(join(clean.r, ".factory/out/loaded.json"), "utf8")).setup_dirty).toEqual([]);
});

test("M5: triage's loaded roster is the single named role, with its model from roles.toml", async () => {
  const r = root();
  const gh = { issue: vi.fn(async () => ({ number: 12, title: "T", body: "" })), comments: vi.fn(async () => []) };
  await buildContext({ root: r, gh, issue: 12, stage: "triage" });
  const loaded = JSON.parse(readFileSync(join(r, ".factory/out/loaded.json"), "utf8"));
  expect(loaded.roster).toEqual([{ name: "triage", agentType: "factory-triage", model: "sonnet" }]);
  expect(loaded.must_fix).toEqual([]);
  expect(loaded.disputed).toEqual([]);
});

test("M5: must_fix is the union of the rework round's verdicts, and disputed comes from the latest rework-response PR comment", async () => {
  const r = root();
  const issue = 8;
  const reviewH = renderHandoff({
    stage: "review", issue, summary: "s",
    data: {
      schema: "factory.review.v1", issue, round: 1, decision: "rework",
      verdicts: [
        { role: "correctness", verdict: "reject", confidence: "high", must_fix: [{ id: "cf1", where: "a.js:1", claim: "c", evidence: "e" }], should_fix: [], verified: [] },
        { role: "qa", verdict: "reject", confidence: "high", must_fix: [{ id: "qa1", where: "b.js:2", claim: "c", evidence: "e" }], should_fix: [], verified: [] },
      ],
    },
  });
  const rework = "```json\n" + JSON.stringify({ schema: "factory.rework-response.v1", issue, responses: [{ id: "cf1", status: "fixed", commit: "abc" }, { id: "qa1", status: "disputed", reason: "out of scope" }] }) + "\n```";
  const gh = {
    issue: vi.fn(async () => ({ number: issue, title: "T", body: "" })),
    comments: vi.fn(async (n) => (n === 31
      ? [{ id: 9, body: rework, createdAt: "2026-09-13T02:00:00Z" }]
      : [
        { id: 1, body: renderHandoff({ stage: "implement", issue, summary: "s", data: { schema: "factory.implement.v1", issue, pr: 31, head_sha: "b".repeat(40) } }), createdAt: "2026-09-13T00:00:00Z" },
        { id: 2, body: reviewH, createdAt: "2026-09-13T01:00:00Z" },
      ])),
  };
  await buildContext({ root: r, gh, issue, stage: "implement" });
  const loaded = JSON.parse(readFileSync(join(r, ".factory/out/loaded.json"), "utf8"));
  expect(loaded.must_fix.map((m) => m.id)).toEqual(["cf1", "qa1"]);
  expect(loaded.disputed).toEqual([{ id: "qa1", status: "disputed", reason: "out of scope" }]);
  expect(loaded.pr).toBe(31);
});


/**
 * ── 최종 리뷰 A-MF1 — **도구와 러너가 같은 `done_when`을 읽고 같은 답을 내야 한다.** ────────────
 *
 * `qa`는 `cold_read = true`라 도구(`bin/qa-evidence.js`)는 `context.qa.json`의 투영된 `done_when`을
 * 읽고, 러너(`run-stage.js`의 `qaEvidenceSummary()`)는 plan handoff의 **원본**을 읽는다. `ui`가
 * `DONE_WHEN_FIELDS`에서 빠져 있던 동안 M2에서 그 둘이 갈렸다: 도구는 "coverage: complete"(exit 0),
 * 러너는 `missing: ["dw1"]`. 곧 qa 리뷰어가 프롬프트가 시키는 대로 `finish`를 돌려 표를 읽고 승인했는데
 * `verify-stage`가 그 라운드를 죽였다 — 도구가 없다고 말한 부족을 이유로. KTB #3의 모양 그대로다.
 *
 * 이 테스트는 그 이음매를 고정한다: 같은 매니페스트를 두 `done_when`으로 검사해 **같은 판정**이 나와야 한다.
 */
test("A-MF1: the qa cold-read context and the plan handoff yield the same M2 verdict for a `ui: true` id", async () => {
  const r = root();
  const doneWhen = [{ id: "dw1", text: "t", verify: "v", level: "integration", ui: true }];
  const plan = renderHandoff({ stage: "plan", issue: 7, summary: "s", data: { schema: "factory.plan.v1", issue: 7, done_when: doneWhen } });
  const gh = {
    issue: vi.fn(async () => ({ number: 7, title: "T", body: "", labels: ["factory:awaiting-review"] })),
    comments: vi.fn(async () => [{ id: 1, body: plan, createdAt: "2026-09-11T00:00:00Z" }]),
  };
  const ctx = await buildContext({ root: r, gh, issue: 7, stage: "review" });
  const qaCtx = roleContextFor(ctx, "qa");
  expect(qaCtx.cold_read).toBe(true);
  expect(qaCtx.done_when).toEqual(doneWhen);                      // `ui`가 투영본에 살아 있다

  // 도구가 보는 것(투영본)과 러너가 보는 것(원본)을 같은 계약에 먹인다.
  const manifest = {
    schema: "factory.qa-evidence.v1", issue: 7, head_sha: null, maturity: "M2",
    claims: [{ id: "dw1", kind: "command", summary: "ran it", file: "dw1-1.log", cmd: "npm test", exit: 0 }],
    created_at: "2026-09-11T00:00:00Z", tool_version: 1,
  };
  const opts = { maturity: "M2", fileExists: () => true };
  const tool = validateManifest(manifest, { ...opts, doneWhen: qaCtx.done_when });
  const runner = validateManifest(manifest, { ...opts, doneWhen: ctx.handoffs.plan.done_when });
  expect(tool).toEqual(runner);
  expect(tool.ok).toBe(false);                                    // M2 + ui:true면 스크린샷이 필요하다
  expect(tool.missing).toEqual(["dw1"]);

  // 그리고 그 요구는 M2에서만 뜬다(계약이 없는 규칙을 발명하지 않는다).
  expect(validateManifest(manifest, { doneWhen: qaCtx.done_when, maturity: "M1", fileExists: () => true }).ok).toBe(true);
});

/**
 * 1.4.35 (L43, own-calendar #105) → 설계 2026-09-30 §8.1 (S1) — **명시적으로 제출된 이슈는 이미 누군가가 본 이슈다.**
 *
 * `triage.default: needs-info`인 저장소의 triage는 본문에 `[ready]`가 없으면 멈췄다. 그런데 큐 진입은 언제나 전이 CLI를 지나
 * 마커를 남기고, 그 마커는 "누군가 이 이슈를 명시적으로 큐에 넣었다"는 기록이다 — 사람이든 에이전트든 공장 자신이든.
 * #105는 done_when이 구체적이라고 triage가 스스로 말하면서도 `[ready]`가 없다는 이유로 1분 만에 needs-info로 돌아갔다.
 * 제출자 종류는 감사용으로 실리고(`submitted_by`), 판정에는 마커의 존재만 쓴다. 마커가 없는 이슈(라벨로 태어난 것)는 예전 그대로다.
 */
const queueMarker = (by, author, at = "2026-09-29T16:58:51Z") => ({ id: 1, body: `<!-- factory-transition:v1 from=backlog to=factory:queue by=${by} -->\nbacklog → factory:queue — go`, createdAt: at, author, authorType: "User", viaApp: null });
const triageCtx = async ({ comments }) => {
  const gh = {
    issue: vi.fn(async () => ({ number: 105, title: "T", body: "## done_when\n- [ ] test_105_x", labels: ["factory:queue"] })),
    comments: vi.fn(async () => comments),
  };
  return buildContext({ root: root(), gh, issue: 105, stage: "triage" });
};

test("triage context records an explicit submission — by a person, an agent session, or the factory — and who submitted", async () => {
  for (const [by, author] of [["person:LeeHyeonKyu", "LeeHyeonKyu"], ["agent:LeeHyeonKyu", "LeeHyeonKyu"], ["factory:run-9", "bot-hk"], ["script", "bot-hk"], ["human", "LeeHyeonKyu"]]) {
    const ctx = await triageCtx({ comments: [queueMarker(by, author)] });
    expect(ctx.triage.explicit_submission, by).toBe(true);
    expect(ctx.triage.submitted_by, by).toBe(by);
    expect(ctx.loaded.triage.explicit_submission, by).toBe(true);
  }
});

test("an issue with no queue marker (born with the label) is not an explicit submission", async () => {
  const ctx = await triageCtx({ comments: [] });
  expect(ctx.triage.explicit_submission).toBe(false);
  expect(ctx.triage.submitted_by).toBe(null);
});

test("only the LATEST queue entry counts", async () => {
  const comments = [queueMarker("person:LeeHyeonKyu", "LeeHyeonKyu", "2026-09-29T10:00:00Z"), { ...queueMarker("factory:run-1", "bot-hk", "2026-09-29T12:00:00Z"), id: 2 }];
  expect((await triageCtx({ comments })).triage.submitted_by).toBe("factory:run-1");
});

test("the triage prompt and the agent's decision table both name the explicit submission next to [ready]", () => {
  const pkg = join(import.meta.dirname, "..", "..");
  const wf = readFileSync(join(pkg, "templates/factory/claude/workflows/factory-triage.js"), "utf8");
  const md = readFileSync(join(pkg, "templates/factory/claude/agents/factory-triage.md"), "utf8");
  expect(wf).toMatch(/loaded\.triage\?\.explicit_submission === true/);
  expect(wf).toMatch(/explicitly submitted/);
  expect(md).toMatch(/\| .*`loaded\.triage\.explicit_submission` is `true`.*\| → `ready`/);
  // 질문은 저장소를 읽어서 답할 수 없는 것만 (#105: 버튼의 위젯 종류를 물었다 — 파일에 적혀 있다)
  expect(md).toMatch(/answer.*by reading the repository/i);
});

/**
 * #143 (S3b) — 스테이지가 base 병합의 소스 충돌을 빌더에게 넘긴 라운드에서, 빌더는 그 경로 목록을 `loaded.merge_conflicts`로 받는다
 * (워크플로 스크립트는 파일을 읽을 수 없다 — `setup_dirty`와 같은 통로). 넘긴 것이 없으면 키 자체가 없다(`[]`가 아니다): 다른
 * 스테이지와 평소 라운드는 아무것도 달라지지 않는다.
 */
test("test_143_builder_context_lists_merge_conflicts", async () => {
  const loadedOf = (r) => JSON.parse(readFileSync(join(r, ".factory/out/loaded.json"), "utf8"));
  const conflicts = ["factory/lib/x.js", "factory/bin/y.js"];
  const a = reviewRoot();
  const ctx = await buildContext({ root: a.r, gh: a.gh, issue: a.issue, stage: "implement", mergeConflicts: conflicts });
  expect(ctx.loaded.merge_conflicts).toEqual(conflicts);
  expect(loadedOf(a.r).merge_conflicts).toEqual(conflicts);
  // 평소 implement 라운드: 키가 없다.
  const b = reviewRoot();
  await buildContext({ root: b.r, gh: b.gh, issue: b.issue, stage: "implement" });
  expect(Object.keys(loadedOf(b.r))).not.toContain("merge_conflicts");
  const e = reviewRoot();
  await buildContext({ root: e.r, gh: e.gh, issue: e.issue, stage: "implement", mergeConflicts: [] });
  expect(Object.keys(loadedOf(e.r))).not.toContain("merge_conflicts");
  // 다른 스테이지에는 실리지 않는다 — 병합을 이어 받을 쓰기 세션은 implement뿐이다.
  const c = reviewRoot();
  await buildContext({ root: c.r, gh: c.gh, issue: c.issue, stage: "review", mergeConflicts: conflicts });
  expect(Object.keys(loadedOf(c.r))).not.toContain("merge_conflicts");
});

/**
 * #143 (S3b, 셀프 비판 f1) — 위 테스트는 생산자만 본다. 이것은 **배선**을 본다: runStage가 체크아웃이 돌려준 충돌 목록을 컨텍스트
 * dep에 넘기고, main()이 쓰는 그 dep(`makeBuildContextDep`)이 실제 `buildContext`까지 넘겨, 빌더가 읽는 `loaded.json`에 실린다.
 * 어느 한 고리라도 목록을 떨어뜨리면 빌더는 무엇을 풀어야 하는지 모른 채 돈다.
 */
import { runStage, makeBuildContextDep } from "../bin/run-stage.js";
test("test_143_runstage_hands_the_conflict_list_to_the_builder_context", async () => {
  const conflicts = ["factory/lib/x.js", "factory/bin/y.js"];
  const roundWith = async (checkout) => {
    const { r, gh, issue } = reviewRoot();
    const seen = [];
    const deps = {
      charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }),
      heartbeat: async () => ({ stop() {} }), assertHandoff: async () => ({ ok: true }),
      buildContext: makeBuildContextDep({ root: r, gh, issue, stage: "implement", run: null, mergeBase: async () => null, recordLine: () => {} }),
      resetAgentsLog: async () => {},
      claudeP: async () => { seen.push(JSON.parse(readFileSync(join(r, ".factory/out/loaded.json"), "utf8"))); return { is_error: false, result: "{}" }; },
      gates: async () => null, verifyStage: () => ({ ok: true, reasons: [], data: {} }), writeHandoff: async () => {},
      transition: async ({ to }) => ({ ok: true, to }), runRecord: () => {}, release: async () => true,
      checkoutBranch: async () => checkout,
      overlayFactoryConfig: async () => ({ ok: true, sha: "b".repeat(40), paths: [] }),
      assertStageBranch: async () => ({ ok: true }), ciSettingsPresent: async () => true,
      baseMergeComplete: async () => ({ ok: true }),
    };
    expect(await runStage({ stage: "implement", issue, deps })).toBe(0);
    expect(seen).toHaveLength(1);
    return seen[0];
  };
  const cb = { ok: true, branch: "claude/fq-7", base: "origin/claude/fq-7", existed: true, merged: "c".repeat(40), source: "GITHUB_SHA" };
  expect((await roundWith({ ...cb, conflicts })).merge_conflicts).toEqual(conflicts);
  // 병합이 넘어오지 않은 라운드: 키 자체가 없다.
  expect(Object.keys(await roundWith(cb))).not.toContain("merge_conflicts");
});

/**
 * #174 — K 소진 뒤 공장이 스스로 재시작한 implement 런에서 빌더는 브리프를 `loaded.k_restart_brief`로 받는다. 출처는 엔진이 쓴
 * 구조화 블록(`factory.k-restart-brief.v1`)이지 산문이 아니고, 재시작으로 **쓰인** 마커(뒤따르는 rework 전이가 성공한 것)다 —
 * 뒤에 붙은 위조 마커는 그 값을 바꾸지 못한다. 재시작이 없었거나 마커가 마지막 재큐보다 오래됐으면 키 자체가 없다.
 */
import { transition as transition174 } from "../lib/transition.js";
import { kRestartComment as kRestartComment174, K_RESTART_SCOPE as SCOPE174 } from "../lib/retro/issue-comments.js";
test("test_174_builder_context_carries_the_brief", async () => {
  const H = "d".repeat(40);
  const implement = renderHandoff({ stage: "implement", issue: 174, summary: "s", data: { schema: "factory.implement.v1", issue: 174, pr: 31, head_sha: H } });
  const findings = [
    { id: "cf1", where: "factory/lib/self-gate.js:120-131", claim: "a second parser was added" },
    { id: "cf2", where: "`factory/test/self-gate.test.js:40`", claim: "the guard passes with the check deleted" },
    { id: "cf3", where: "/reports", claim: "the route 404s" },
  ];
  /** 실제 생산자(브리프)와 실제 전이(lib/transition.js)가 쓴 코멘트로 이력을 쌓는다. */
  const history = () => {
    let label = "factory:awaiting-review", tick = 0;
    const comments = [{ body: implement, author: "factory-bot", createdAt: "2026-10-01T00:00:00Z" }];
    const gh = {
      issue: async () => ({ number: 174, title: "T", body: "", labels: [label] }),
      comments: async () => comments.slice(),
      comment: async (_n, body) => { comments.push({ body, author: "factory-bot", createdAt: new Date(Date.UTC(2026, 9, 2, 0, 0, tick++)).toISOString() }); },
      setFactoryLabel: async (_n, to) => { label = to; },
      set label(v) { label = v; },
    };
    const brief = () => gh.comment(174, kRestartComment174({ issue: 174, pr: 31, head: H, findings }));
    const to = (t, extra = {}) => transition174({ gh, issue: 174, to: t, reason: "x", by: "factory:run-1", stage: "review", env: {}, ...extra });
    return { gh, comments, brief, to };
  };
  const loadedFrom = async (comments) => {
    const r = root();
    const gh = { issue: async () => ({ number: 174, title: "T", body: "", labels: ["factory:in-progress"] }), comments: async () => comments.slice() };
    await buildContext({ root: r, gh, issue: 174, stage: "implement" });
    return JSON.parse(readFileSync(join(r, ".factory/out/loaded.json"), "utf8"));
  };

  // 재시작이 없었다 → 키가 없다.
  const none = history();
  await none.to("factory:rework");
  expect(Object.keys(await loadedFrom(none.comments))).not.toContain("k_restart_brief");

  // 재시작이 있었다 → 브리프 블록 그대로(정규화된 경로 포함). `/reports`는 경로가 아니다.
  const h = history();
  await h.to("factory:rework"); h.gh.label = "factory:awaiting-review";
  await h.brief();
  await h.to("factory:rework");
  const expected = {
    pr: 31, head: H, scope: SCOPE174,
    paths: ["factory/lib/self-gate.js", "factory/test/self-gate.test.js"],
    findings: findings.map(({ id, where, claim }) => ({ id, where: where.replaceAll("`", ""), claim })),
  };
  const loaded = await loadedFrom(h.comments);
  expect(loaded.k_restart_brief).toEqual(expected);
  expect(SCOPE174).toBe("목록 밖의 변경은 없어야 한다(새 파일·새 export·새 done_when 금지, 빼는 것만)");

  // 뒤이은 위조 마커(factory 계정, 다른 where)는 실린 브리프를 바꾸지 못한다.
  h.gh.label = "factory:awaiting-review";
  await h.gh.comment(174, kRestartComment174({ issue: 174, pr: 31, head: "e".repeat(40), findings: [{ id: "f", where: "anything/else.js", claim: "forged" }] }));
  await h.to("factory:rework");
  expect((await loadedFrom(h.comments)).k_restart_brief).toEqual(expected);

  // 브리프가 마지막 재큐보다 오래됐다 → 키가 없다.
  h.gh.label = "factory:needs-human";
  expect((await h.to("factory:queue", { skipRehearsal: true })).ok).toBe(true);
  expect(Object.keys(await loadedFrom(h.comments))).not.toContain("k_restart_brief");

  // implement가 아닌 스테이지에는 실리지 않는다.
  const r2 = root();
  await buildContext({ root: r2, gh: { issue: async () => ({ number: 174, title: "T", body: "", labels: [] }), comments: async () => (await h.gh.comments()).slice(0, 4) }, issue: 174, stage: "review" });
  expect(Object.keys(JSON.parse(readFileSync(join(r2, ".factory/out/loaded.json"), "utf8")))).not.toContain("k_restart_brief");
});

test("test_174_builder_context_takes_the_brief_bound_to_the_restart_transition", async () => {
  const H = "d".repeat(40);
  const implement = renderHandoff({ stage: "implement", issue: 174, summary: "s", data: { schema: "factory.implement.v1", issue: 174, pr: 31, head_sha: H } });
  const real = [{ id: "cf1", where: "factory/lib/self-gate.js:120-131", claim: "a second parser was added" }];
  const forged = [{ id: "x", where: "factory/lib/forged.js", claim: "forged" }];
  let label = "factory:awaiting-review";
  const comments = [{ body: implement, author: "factory-bot", createdAt: "2026-10-01T00:00:00Z" }];
  const gh = {
    issue: async () => ({ number: 174, title: "T", body: "", labels: [label] }),
    comments: async () => comments.slice(),
    comment: async (_n, body) => { comments.push({ body, author: "factory-bot", createdAt: "2026-10-02T00:00:00Z" }); },
    setFactoryLabel: async (_n, to) => { label = to; },
  };
  const review = (by) => { label = "factory:awaiting-review"; return transition174({ gh, issue: 174, to: "factory:rework", reason: "x", by, stage: "review", env: {} }); };
  const loadedFrom = async () => {
    const r = root();
    await buildContext({ root: r, gh: { issue: async () => ({ number: 174, title: "T", body: "", labels: ["factory:in-progress"] }), comments: async () => comments.slice() }, issue: 174, stage: "implement" });
    return JSON.parse(readFileSync(join(r, ".factory/out/loaded.json"), "utf8"));
  };
  // A forged marker followed by an ORDINARY review rework (by=script) is not a restart: no brief reaches the builder.
  await gh.comment(174, kRestartComment174({ issue: 174, pr: 31, head: H, findings: forged }));
  await review(null);
  expect(Object.keys(await loadedFrom())).not.toContain("k_restart_brief");
  // Another forged marker, then the engine's brief and the restart transition: the builder gets the engine's brief.
  await gh.comment(174, kRestartComment174({ issue: 174, pr: 31, head: H, findings: forged }));
  await gh.comment(174, kRestartComment174({ issue: 174, pr: 31, head: H, findings: real }));
  await review("factory:run-77");
  const loaded = await loadedFrom();
  expect(loaded.k_restart_brief.findings).toEqual(real);
  expect(loaded.k_restart_brief.paths).toEqual(["factory/lib/self-gate.js"]);
});
