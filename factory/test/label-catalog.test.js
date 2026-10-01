import { test, expect } from "vitest";
import { LABELS, HARNESS_LABEL, IMPROVEMENT_LABEL } from "../lib/label-catalog.js";
import { STATES, TIER_LABELS, TRANSITIONS, ENTRY_LABELS, canTransition } from "../lib/labels.js";
import { bootstrapPlan } from "../lib/bootstrap.js";

const HARNESS = { project: { default_branch: "main" }, factory: { required_checks: ["factory/gates"] } };
const byName = (name) => LABELS.find((l) => l.name === name);

test("IMPROVEMENT_LABEL: `factory-improvement`이 카탈로그에 있고 색·설명을 갖는다", () => {
  expect(IMPROVEMENT_LABEL).toBe("factory-improvement");
  const l = byName(IMPROVEMENT_LABEL);
  expect(l).toBeTruthy();
  expect(l.color).toMatch(/^[0-9a-f]{6}$/);
  expect(l.description.length).toBeGreaterThan(0);
});

test("bootstrap의 라벨 계획이 `factory-improvement`를 포함한다(사람이 손으로 만들 필요가 없다)", () => {
  const ops = bootstrapPlan({ harness: HARNESS, today: "2026-09-21", existing: { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: "2026-01-01" }, secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY"] } });
  const l = byName(IMPROVEMENT_LABEL);
  expect(ops.filter((o) => o.kind === "label")).toContainEqual({ kind: "label", name: IMPROVEMENT_LABEL, color: l.color, description: l.description });
});

test("`factory-improvement`는 상태 라벨이 아니다 — 전이 그래프가 이 라벨을 전혀 모른다", () => {
  expect(STATES.has(IMPROVEMENT_LABEL)).toBe(false);
  expect(TIER_LABELS.has(IMPROVEMENT_LABEL)).toBe(false);
  expect(TRANSITIONS.has(IMPROVEMENT_LABEL)).toBe(false);
  for (const to of TRANSITIONS.values()) expect(to.has(IMPROVEMENT_LABEL)).toBe(false);
  for (const entry of Object.values(ENTRY_LABELS)) expect(entry).not.toContain(IMPROVEMENT_LABEL);
  expect(canTransition("backlog", IMPROVEMENT_LABEL)).toBe(false);
  expect(canTransition(IMPROVEMENT_LABEL, "factory:queue")).toBe(false);
});

test("분류 라벨 계열(harness/flaky/improvement)은 `factory:` 상태 12개와 겹치지 않는다", () => {
  for (const n of [HARNESS_LABEL, "factory:flaky", IMPROVEMENT_LABEL]) expect(STATES.has(n)).toBe(false);
});

test("전이 그래프는 이 작업으로 바뀌지 않았다 — 상태 13개, 엣지 목록 고정", () => {
  expect(STATES.size).toBe(13);
  expect([...TRANSITIONS.keys()].length).toBe(13);
});

// ── #149 (S4a) — 거부권 라벨은 누군가 필요로 하기 전에 이미 있다 ──────────────────────────────────
test("test_149_self_change_config_defaults_and_validation — `factory:veto` is in the catalog, a non-state label", async () => {
  const { VETO_LABEL, VETO_LABEL_SPEC } = await import("../lib/label-catalog.js");
  expect(VETO_LABEL).toBe("factory:veto");
  const l = VETO_LABEL_SPEC;
  expect(l.name).toBe(VETO_LABEL);
  expect(l.color).toMatch(/^[0-9a-f]{6}$/);
  expect(l.description.length).toBeGreaterThan(0);
  // 상태 라벨이 아니다 — 전이 그래프가 모르고, tier 라벨도 아니다.
  expect(STATES.has(VETO_LABEL)).toBe(false);
  expect(TIER_LABELS.has(VETO_LABEL)).toBe(false);
  expect(TRANSITIONS.has(VETO_LABEL)).toBe(false);
  for (const to of TRANSITIONS.values()) expect(to.has(VETO_LABEL)).toBe(false);
  // bootstrap의 21개(`bootstrap.test.js`가 못 박은 수)는 그대로다 — 라벨은 merge 스테이지가 창을 열기 전에 만든다
  // (merge-stage.test.js·run-stage.test.js의 test_149_veto_window_opens_waits_and_closes).
  expect(byName(VETO_LABEL)).toBeUndefined();
  expect(LABELS).toHaveLength(21);
});

test("test_149_self_change_config_defaults_and_validation — a state transition never strips `factory:veto`", async () => {
  const { VETO_LABEL } = await import("../lib/label-catalog.js");
  const { makeGh } = await import("../lib/gh.js");
  const { makeFakeRun } = await import("../lib/exec.js");
  expect(VETO_LABEL).toBe("factory:veto");
  const view = (names) => ({ code: 0, stdout: JSON.stringify({ number: 7, title: "", body: "", labels: names.map((name) => ({ name })) }), stderr: "" });
  const snaps = [view(["factory:approved", VETO_LABEL]), view(["factory:needs-human", VETO_LABEL])];
  const run = makeFakeRun([
    { match: (c, a) => a.includes("view"), result: () => (snaps.length > 1 ? snaps.shift() : snaps[0]) },
    { match: (c, a) => a.includes("edit"), result: { code: 0, stdout: "", stderr: "" } },
  ]);
  const gh = makeGh({ run, repo: "o/r", sleep: async () => {} });
  const r = await gh.setFactoryLabel(7, "factory:needs-human");
  expect(r.removed).toEqual(["factory:approved"]);
  expect(run.calls.some((c) => c.args.includes("--remove-label") && c.args.includes(VETO_LABEL))).toBe(false);
});
