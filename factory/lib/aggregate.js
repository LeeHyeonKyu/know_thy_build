export function aggregateReview({ verdicts, rosterSize, rosterRoles = [], rulings = [] }) {
  const missing_roles = rosterRoles.filter((r) => !verdicts.some((v) => v.role === r));
  if (verdicts.length < rosterSize) return { decision: "incomplete", must_fix: [], missing_roles };
  const byId = new Map();
  for (const v of verdicts) if (v.verdict === "reject") for (const m of v.must_fix) if (!byId.has(m.id)) byId.set(m.id, { ...m, by: v.role });
  for (const r of rulings) if (r.ruling === "uphold" && !byId.has(r.id)) byId.set(r.id, { id: r.id, where: "-", claim: "disputed item upheld", evidence: `ruling by ${r.by}`, by: r.by });
  const must_fix = [...byId.values()];
  return { decision: must_fix.length === 0 ? "approved" : "rework", must_fix, missing_roles: [] };
}
