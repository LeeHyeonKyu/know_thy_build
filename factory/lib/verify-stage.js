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
/**
 * ```json 펜스가 있는데 그 안이 유효한 JSON이 아니면 파싱 오류 메시지. 펜스가 없거나 정상이면 null.
 * verifyStage가 폴백(균형 스캔)을 쓸지 말지를 이걸로 가른다 — 펜스는 에이전트가 선언한 계약이라,
 * 깨졌다는 사실 자체가 결과이지 "다른 객체를 찾아보라"는 신호가 아니다.
 */
export function fencedJsonError(text) {
  if (typeof text !== "string") return null;
  const fence = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (!fence) return null;
  try { JSON.parse(fence[1]); return null; } catch (e) { return e?.message || String(e); }
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

const GATED_STAGES = ["implement", "review", "merge"];
const listOf = (a) => (a && a.length ? a.join(",") : "none");

/**
 * gates: `.factory/out/gates.json`의 내용(없으면 null). 게이트 판정의 단일 출처는 이 파일이다 —
 * 워크플로가 handoff에 적은 gates는 파일과 **일치해야만** 인정되고, 비어 있으면 파일 값으로 채운다.
 * (그래서 schema 검증은 data.gates를 채운 뒤에 돈다.)
 */
export function verifyStage({ stage, out, agentsLog, roster = [], rolePrefix = "", expectedRounds, orchestration, gates }) {
  const reasons = [];
  if (!out || out.is_error) reasons.push("claude -p reported is_error");
  /*
   * 펜스가 깨졌으면 폴백을 쓰지 않는다. 폴백은 계획 **안의** 중첩 객체(done_when 한 항목 등)를
   * 집어 오고, 그러면 "issue is required; tier is required; …"라는 오진이 진짜 원인(에이전트가
   * JSON 안에 `/* … *​/` 주석이나 `…` 축약을 남겼다)을 가린다 — dogfood 데모 #2 plan에서 실제로 벌어졌다.
   */
  const fenceErr = out ? fencedJsonError(out.result) : null;
  const data = fenceErr ? null : out ? extractJson(out.result) : null;
  if (fenceErr) reasons.push(`\`\`\`json fence is not valid JSON: ${fenceErr}`);
  else if (!data) reasons.push("no JSON object in result");
  if (GATED_STAGES.includes(stage)) {
    if (!gates) reasons.push("gates file missing");
    // bin/gates.js가 남긴 로컬 진단 결과는 스테이지 판정이 아니다 — 사람이 손으로 만든 GREEN이 머지로 이어지면 안 된다.
    else if (gates.diagnostic === true) reasons.push("gates file is a local diagnostic run (diagnostic: true), not a stage verdict");
    else if (data) {
      if (data.gates && (data.gates.status !== gates.status || data.gates.level !== gates.level)) reasons.push(`handoff gates mismatch: handoff says ${data.gates.status}/${data.gates.level}, file says ${gates.status}/${gates.level}`);
      else data.gates = { status: gates.status, level: gates.level };
      if (stage === "implement" && gates.status !== "GREEN") {
        const mis = gates.status === "MISCONFIGURED" ? ` misconfigured=${listOf(gates.misconfigured)}` : "";
        reasons.push(`gates ${gates.status}: failing=${listOf(gates.failing)}${mis}`);
      }
    }
  }
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
