export function aggregateReview({ verdicts, rosterSize, rosterRoles = [], rulings = [] }) {
  const missing_roles = rosterRoles.filter((r) => !verdicts.some((v) => v.role === r));
  // 개수가 맞아도 역할이 비면 미완이다 — 한 역할이 두 번 낸 verdict가 정족수를 채우는 걸 막는다.
  if (verdicts.length < rosterSize || missing_roles.length > 0) return { decision: "incomplete", must_fix: [], missing_roles };
  const byId = new Map();
  for (const v of verdicts) if (v.verdict === "reject") for (const m of v.must_fix) if (!byId.has(m.id)) byId.set(m.id, { ...m, by: v.role });
  for (const r of rulings) if (r.ruling === "uphold" && !byId.has(r.id)) byId.set(r.id, { id: r.id, where: "-", claim: "disputed item upheld", evidence: `ruling by ${r.by}`, by: r.by });
  const must_fix = [...byId.values()];
  return { decision: must_fix.length === 0 ? "approved" : "rework", must_fix, missing_roles: [] };
}
