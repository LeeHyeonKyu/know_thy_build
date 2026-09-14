import { test, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildContext, roleContextFor } from "../lib/context.js";
import { renderHandoff } from "../lib/handoff.js";

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

test("H4: spec-conformance (cold_read = false) gets the full file plus the issue's acceptance text", async () => {
  const { r, gh, issue } = reviewRoot();
  await buildContext({ root: r, gh, issue, stage: "review" });
  const rc = JSON.parse(readFileSync(join(r, ".factory/out/context.spec-conformance.json"), "utf8"));
  expect(rc.cold_read).toBe(false);
  expect(rc.handoffs.plan.files_expected).toEqual(["src/export/csv.js"]);
  expect(rc.acceptance).toBe("- CSV에 헤더 줄이 있다");
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
