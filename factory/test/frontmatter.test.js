import { test, expect } from "vitest";
import { parseFrontmatter } from "../lib/frontmatter.js";

test("scalars, inline maps, inline arrays, nested one-level maps", () => {
  const md = `---
schema: factory.charter.v1
status: ready
limits: { K: 3, M: 3, R: 2 }
roster:
  docs: [correctness, spec-conformance]
  load-bearing: [a, b, c]
plan_rounds: { docs: 2, default: 3 }
budget: {}
retro: { every_merges: { initial: 1, min: 1, max: 20 }, light_on_merge: true }
---
# Body
text`;
  const { data, body } = parseFrontmatter(md);
  expect(data.schema).toBe("factory.charter.v1");
  expect(data.status).toBe("ready");
  expect(data.limits).toEqual({ K: 3, M: 3, R: 2 });
  expect(data.roster).toEqual({ docs: ["correctness", "spec-conformance"], "load-bearing": ["a", "b", "c"] });
  expect(data.plan_rounds.default).toBe(3);
  expect(data.budget).toEqual({});
  expect(data.retro.every_merges.max).toBe(20);
  expect(data.retro.light_on_merge).toBe(true);
  expect(body.trim()).toBe("# Body\ntext");
});

test("no frontmatter → empty data, whole body", () => {
  expect(parseFrontmatter("# just md")).toEqual({ data: {}, body: "# just md" });
});

test("inline ' #' comments are stripped outside quotes; '#' inside quotes survives", () => {
  const { data } = parseFrontmatter(`---
schema: factory.charter.v1
status: ready   # 사람이 이 줄을 손으로 고친다
limits: { K: 3 }  # note
tier_default: standard # trailing
note: "a # b"
tag: 'x#y'
roster:   # 주석만 달린 중첩 블록 머리
  docs: [correctness, spec-conformance]   # docs tier
---
`);
  expect(data.status).toBe("ready");
  expect(data.limits).toEqual({ K: 3 });
  expect(data.tier_default).toBe("standard");
  expect(data.note).toBe("a # b");
  expect(data.tag).toBe("x#y");
  expect(data.roster).toEqual({ docs: ["correctness", "spec-conformance"] });
});

test("4-space nested blocks parse (common indent is stripped, not exactly 2)", () => {
  const { data } = parseFrontmatter(`---
schema: factory.charter.v1
roster:
    docs: [correctness, spec-conformance]
    standard: [correctness, qa]
plan_roles:
    default: [architect, skeptic]
retro:
    every_merges:
        initial: 1
        max: 20
---
`);
  expect(data.roster).toEqual({ docs: ["correctness", "spec-conformance"], standard: ["correctness", "qa"] });
  expect(data.plan_roles.default).toEqual(["architect", "skeptic"]);
  expect(data.retro.every_merges).toEqual({ initial: 1, max: 20 });
});
