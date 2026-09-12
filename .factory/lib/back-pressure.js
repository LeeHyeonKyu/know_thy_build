import { overCap } from "./quarantine.js";
export async function backPressure({ gh, charter, quarantine, thresholds }) {
  const reasons = [];
  const waiting = await gh.searchIssues("factory:awaiting-review");
  if (waiting.length >= charter.back_pressure.awaiting_review_max) reasons.push(`awaiting-review ${waiting.length} ≥ ${charter.back_pressure.awaiting_review_max}`);
  if (overCap(quarantine, thresholds)) reasons.push(`quarantine ${quarantine.quarantined.length} ≥ ${thresholds.quarantine_max}`);
  return { ok: reasons.length === 0, reasons };
}
