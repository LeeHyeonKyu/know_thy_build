import { validate } from "./schemas.js";

const SCHEMA_OF = { triage: "triage.v1", plan: "plan.v1", implement: "implement.v1", review: "review.v1" };

/** result 텍스트에서 첫 JSON 객체를 꺼낸다: ```json 펜스 우선, 없으면 첫 '{'부터 균형 잡힌 '}'까지. */
export function extractJson(text) {
  if (typeof text !== "string") return null;
  const fence = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  const candidates = fence ? [fence[1]] : [];
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      if (text[i] === "}") { depth--; if (depth === 0) { candidates.push(text.slice(start, i + 1)); break; } }
    }
  }
  for (const c of candidates) { try { return JSON.parse(c); } catch { /* try next */ } }
  return null;
}

export function verifyStage({ stage, out, agentsLog, roster = [], rolePrefix = "", expectedRounds, orchestration }) {
  const reasons = [];
  if (!out || out.is_error) reasons.push("claude -p reported is_error");
  const data = out ? extractJson(out.result) : null;
  if (!data) reasons.push("no JSON object in result");
  if (data && SCHEMA_OF[stage]) {
    const v = validate(SCHEMA_OF[stage], data);
    if (!v.ok) reasons.push(`schema ${SCHEMA_OF[stage]}: ${v.errors.join("; ")}`);
  }
  if (data && orchestration && data.orchestration !== orchestration) reasons.push(`orchestration ${data.orchestration} != configured ${orchestration}`);
  if (stage === "plan" && data && expectedRounds != null && data.rounds !== expectedRounds) reasons.push(`rounds ${data.rounds} != expected ${expectedRounds}`);
  for (const role of roster) {
    if (!agentsLog.completed.includes(rolePrefix + role)) reasons.push(`roster role not completed: ${role}`);
  }
  return { ok: reasons.length === 0, reasons, data };
}
