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
