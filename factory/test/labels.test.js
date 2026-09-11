import { test, expect } from "vitest";
import { STATES, canTransition, factoryLabelOf, STAGE_OF_TARGET } from "../lib/labels.js";

test("states are the spec's 13 labels", () => {
  expect([...STATES].sort()).toEqual([
    "backlog", "factory:approved", "factory:awaiting-review", "factory:blocked", "factory:in-progress",
    "factory:merged", "factory:needs-human", "factory:needs-info", "factory:planned", "factory:queue",
    "factory:ready", "factory:rework", "factory:wont-do",
  ]);
});

test("graph edges from §3.2", () => {
  expect(canTransition("backlog", "factory:queue")).toBe(true);
  expect(canTransition("factory:queue", "factory:ready")).toBe(true);
  expect(canTransition("factory:queue", "factory:needs-info")).toBe(true);
  expect(canTransition("factory:queue", "factory:wont-do")).toBe(true);
  expect(canTransition("factory:queue", "factory:needs-human")).toBe(true);
  expect(canTransition("factory:needs-info", "factory:queue")).toBe(true);
  expect(canTransition("factory:ready", "factory:planned")).toBe(true);
  expect(canTransition("factory:planned", "factory:in-progress")).toBe(true);
  expect(canTransition("factory:in-progress", "factory:awaiting-review")).toBe(true);
  expect(canTransition("factory:in-progress", "factory:blocked")).toBe(true);
  expect(canTransition("factory:in-progress", "factory:needs-human")).toBe(true);
  expect(canTransition("factory:awaiting-review", "factory:approved")).toBe(true);
  expect(canTransition("factory:awaiting-review", "factory:rework")).toBe(true);
  expect(canTransition("factory:rework", "factory:in-progress")).toBe(true);
  expect(canTransition("factory:rework", "factory:needs-human")).toBe(true);
  expect(canTransition("factory:approved", "factory:merged")).toBe(true);
  expect(canTransition("factory:blocked", "factory:needs-human")).toBe(true);
  expect(canTransition("factory:blocked", "factory:planned")).toBe(true);   // sweeper 재큐
  expect(canTransition("factory:needs-human", "factory:queue")).toBe(true);
});

test("non-edges are rejected", () => {
  expect(canTransition("backlog", "factory:approved")).toBe(false);
  expect(canTransition("factory:queue", "factory:planned")).toBe(false);
  expect(canTransition("factory:merged", "factory:queue")).toBe(false);
  expect(canTransition("nonsense", "factory:queue")).toBe(false);
});

test("factoryLabelOf picks the single factory:* label; backlog counts as a state", () => {
  expect(factoryLabelOf(["bug", "factory:ready"])).toBe("factory:ready");
  expect(factoryLabelOf(["backlog", "enhancement"])).toBe("backlog");
  expect(factoryLabelOf(["bug"])).toBe(null);
  expect(() => factoryLabelOf(["factory:ready", "factory:planned"])).toThrow(/exactly one/);
  expect(() => factoryLabelOf(["backlog", "factory:queue"])).toThrow(/exactly one/);
});

test("target state → stage that must have produced the handoff", () => {
  expect(STAGE_OF_TARGET["factory:planned"]).toBe("plan");
  expect(STAGE_OF_TARGET["factory:approved"]).toBe("review");
});
