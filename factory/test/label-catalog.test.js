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
