import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";

const P = (root) => join(root, ".factory/quarantine.toml");
export function loadQuarantine(root) { return existsSync(P(root)) ? { quarantined: [], ...parse(readFileSync(P(root), "utf8")) } : { quarantined: [] }; }
export function saveQuarantine(root, q) { writeFileSync(P(root), stringify(q)); }
export const isQuarantined = (q, id) => q.quarantined.some((x) => x.id === id);
export function recordResult(q, id, passed) {
  return { quarantined: q.quarantined.map((x) => x.id === id ? { ...x, consecutive_passes: passed ? (x.consecutive_passes || 0) + 1 : 0 } : x) };
}
export function applyPolicy(q, { now, thresholds }) {
  const nowMs = Date.parse(now), ttlMs = thresholds.quarantine_ttl_days * 86400e3;
  const returned = q.quarantined.filter((x) => (x.consecutive_passes || 0) >= thresholds.quarantine_return_after).map((x) => x.id);
  const kept = q.quarantined.filter((x) => !returned.includes(x.id));
  const expired = kept.filter((x) => { const t = Date.parse(x.since); return Number.isNaN(t) || t + ttlMs < nowMs; }).map((x) => x.id);
  return { q: { quarantined: kept }, returned, expired };
}
export const overCap = (q, thresholds) => q.quarantined.length >= thresholds.quarantine_max;
