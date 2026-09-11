import { test, expect } from "vitest";
import { aggregateReview } from "../lib/aggregate.js";

const v = (role, verdict, ids = []) => ({ role, verdict, confidence: "high", must_fix: ids.map((id) => ({ id, where: "w", claim: "c", evidence: "e" })), should_fix: [], verified: [] });

test("all approve → approved", () => {
  expect(aggregateReview({ verdicts: [v("a", "approve"), v("b", "approve")], rosterSize: 2 })).toEqual({ decision: "approved", must_fix: [], missing_roles: [] });
});
test("any reject → rework with deduped must_fix union", () => {
  const r = aggregateReview({ verdicts: [v("a", "reject", ["cf1", "cf2"]), v("b", "reject", ["cf2", "qa1"])], rosterSize: 2 });
  expect(r.decision).toBe("rework");
  expect(r.must_fix.map((m) => m.id)).toEqual(["cf1", "cf2", "qa1"]);
});
test("fewer verdicts than roster → incomplete", () => {
  const r = aggregateReview({ verdicts: [v("a", "approve")], rosterSize: 2, rosterRoles: ["a", "b"] });
  expect(r.decision).toBe("incomplete");
  expect(r.missing_roles).toEqual(["b"]);
});
test("upheld disputes keep rework even when all new verdicts approve", () => {
  const r = aggregateReview({ verdicts: [v("a", "approve"), v("b", "approve")], rosterSize: 2, rulings: [{ id: "cf1", ruling: "uphold", by: "a" }] });
  expect(r.decision).toBe("rework");
  expect(r.must_fix.map((m) => m.id)).toEqual(["cf1"]);
  const w = aggregateReview({ verdicts: [v("a", "approve"), v("b", "approve")], rosterSize: 2, rulings: [{ id: "cf1", ruling: "withdraw", by: "a" }] });
  expect(w.decision).toBe("approved");
});
