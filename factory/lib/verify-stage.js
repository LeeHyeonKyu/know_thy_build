import { validate } from "./schemas.js";
import { extractStageArtifact, fencedJsonError } from "./stage-artifact.js";

export { fencedJsonError };

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

const GATED_STAGES = ["implement", "review", "merge"];
const listOf = (a) => (a && a.length ? a.join(",") : "none");

/**
 * `claude -p`가 **턴 한도**에서 잘렸는가(KTB-16). CLI는 이 사실을 두 자리에 적는다 —
 * `terminal_reason: "max_turns"`와 `subtype: "error_max_turns"`. 한쪽만 보면 CLI 버전에 따라
 * 조용히 놓친다. 이것은 설계 오류가 아니라 **재시도로 풀리는 일시 조건**이라, 등급도 사유 문구도
 * 다른 `is_error`와 달라야 한다(`run-stage.js`가 이 판정으로 needs-human 대신 blocked를 세운다).
 */
export function hitMaxTurns(out) {
  return out?.terminal_reason === "max_turns" || out?.subtype === "error_max_turns";
}
/** 턴 한도 실패의 run 기록/전이 사유 한 줄. 증상("no JSON object in result")이 아니라 원인을 적는다. */
export const maxTurnsReason = (out) => `claude -p hit max turns (${out?.num_turns ?? "n/a"})`;

/**
 * gates: `.factory/out/gates.json`의 내용(없으면 null). 게이트 판정의 단일 출처는 이 파일이다 —
 * 워크플로가 handoff에 적은 gates는 파일과 **일치해야만** 인정되고, 비어 있으면 파일 값으로 채운다.
 * (그래서 schema 검증은 data.gates를 채운 뒤에 돈다.)
 */
export function verifyStage({ stage, out, transcriptText, agentsLog, roster = [], rolePrefix = "", expectedRounds, orchestration, gates }) {
  const reasons = [];
  /*
   * 산출물은 디스패처의 최종 텍스트 하나만 믿지 않는다(KTB-7). 트랜스크립트의 Workflow 결과 →
   * result의 ```json 펜스 → 맨 JSON 순으로 훑고, **스키마를 통과하는 첫 후보**가 이긴다.
   * 스키마를 채점 기준으로 두는 게 핵심이다 — 파싱만 되는 후보(계획 안의 done_when 한 항목 등)가
   * 뽑혀 "issue is required; tier is required; …"라는 오진을 만들던 게 데모 #2 plan의 실패였다.
   *
   * gates는 스키마보다 먼저 채워 넣는다(implement.v1·review.v1이 요구한다) — 후보 채점 시점에는
   * 사본에만 채우고, 파일과의 일치 검사는 아래 기존 경로가 선택된 객체를 상대로 다시 한다.
   */
  const withGates = (o) => (GATED_STAGES.includes(stage) && gates && o && !o.gates
    ? { ...o, gates: { status: gates.status, level: gates.level } }
    : o);
  const schemaName = SCHEMA_OF[stage];
  const artifact = extractStageArtifact({
    envelopeResult: out?.result,
    transcriptText,
    validate: schemaName ? (o) => validate(schemaName, withGates(o)) : null,
  });
  const data = artifact.ok ? artifact.data : null;
  /*
   * `is_error`는 그 자체로 실패다 — 단 하나의 예외가 **턴 한도**다(KTB-16). `Workflow`는 백그라운드로
   * 돌고 디스패처는 그 결과를 받아 다시 출력하기만 하면 되는데, 그 마지막 턴이 모자라면 CLI는
   * `is_error: true, subtype: error_max_turns, terminal_reason: max_turns`로 끝난다 — **워크플로는
   * 이미 끝났고 산출물은 트랜스크립트 안에 있다**(데모 #2 plan 재실행: 30분·$12.05가 그렇게 증발했다).
   * 그래서 스키마를 통과하는 산출물을 실제로 복구했을 때만 이 예외가 열린다. 복구하지 못했으면
   * 사유는 "no JSON object in result"(증상)가 아니라 턴 한도(원인)로 적는다.
   */
  const maxTurns = hitMaxTurns(out);
  if ((!out || out.is_error) && !(maxTurns && artifact.ok)) reasons.push(maxTurns ? maxTurnsReason(out) : "claude -p reported is_error");
  if (!artifact.ok) reasons.push(artifact.reason);
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
