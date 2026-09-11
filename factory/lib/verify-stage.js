import { validate } from "./schemas.js";

const SCHEMA_OF = { triage: "triage.v1", plan: "plan.v1", implement: "implement.v1", review: "review.v1" };

/** result 텍스트에서 첫 유효 JSON 객체를 꺼낸다: ```json 펜스 우선, 없거나 무효면 모든 '{' 시작점에서 문자열·이스케이프를 인식하는 균형 스캔. */
export function extractJson(text) {
  if (typeof text !== "string") return null;
  const fence = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* fall through */ } }
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const end = matchBrace(text, start);
    if (end < 0) continue;
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* try next start */ }
  }
  return null;
}
/** start의 '{'에 대응하는 '}' 인덱스. 문자열 리터럴과 \" 이스케이프를 건너뛴다. 없으면 -1. */
function matchBrace(text, start) {
  let depth = 0, inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (ch === "\\") i++; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
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
