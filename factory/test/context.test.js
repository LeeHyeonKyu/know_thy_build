import { test, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildContext } from "../lib/context.js";
import { renderHandoff } from "../lib/handoff.js";

function root() {
  const r = mkdtempSync(join(tmpdir(), "ctx-"));
  mkdirSync(join(r, ".factory"), { recursive: true }); mkdirSync(join(r, "docs/factory"), { recursive: true });
  writeFileSync(join(r, ".factory/harness.toml"), `schema = 1\n[harness]\nmaturity = "M0"\n[factory]\norchestration = "workflow"\n[commands]\nunit = "npm test"\n[gates]\nrequired = ["unit"]\nfast = ["unit"]\nfull = ["unit"]\ndeep = ["unit"]\n`);
  writeFileSync(join(r, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: ready\ntier_default: standard\nroster:\n  docs: [correctness]\n  standard: [correctness, qa]\nplan_roles:\n  docs: [architect, skeptic]\n  default: [architect, skeptic, operator]\nplan_rounds: { docs: 2, default: 3 }\n---\n`);
  writeFileSync(join(r, ".factory/roles.toml"), `[review.correctness]\nagent = ".claude/agents/reviewer-correctness.md"\nlessons = ".factory/lessons/reviewer-correctness.md"\n[review.qa]\nagent = ".claude/agents/reviewer-qa.md"\n[plan.architect]\nagent = "a.md"\n[plan.skeptic]\nagent = "s.md"\n[plan.operator]\nagent = "o.md"\n[plan.synthesizer]\nagent = "syn.md"\n`);
  return r;
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
