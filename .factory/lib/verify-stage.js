import { validate } from "./schemas.js";
import { extractStageArtifact } from "./stage-artifact.js";

/**
 * 최종 리뷰 nit 3 — `extractJson`/`matchBrace`와 `export { fencedJsonError }`가 여기서 사라졌다.
 * KTB-7이 산출물 추출을 트랜스크립트 우선(`lib/stage-artifact.js`)으로 올린 뒤 **프로덕션 호출자가
 * 하나도 남지 않았고**(`lib`·`bin`·`cli`·`templates` 전수 확인), 그런데도 같은 브레이스 스캐너가
 * 두 파일에 두 벌 살아 있었다. 죽은 사본은 언젠가 원본과 어긋나고(그 어긋남은 테스트가 잡지 못한다 —
 * 죽은 쪽에만 테스트가 있었다), 다음 독자에게는 "추출 경로가 둘"이라고 거짓말한다. 정본은
 * `stage-artifact.js`의 `extractStageArtifact`·`fencedJsonError` 하나다.
 */
const SCHEMA_OF = { triage: "triage.v1", plan: "plan.v1", implement: "implement.v1", review: "review.v1" };

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
 * `claude -p`가 **API 쿼터/장애**에서 잘렸는가(KTB-22, r1 KTB-22 r1). 2026-09-12 20:20Z, 데모 세
 * 스테이지(구현 둘·계획 하나)가 동시에 이 봉투로 죽었다 — `is_error:true, terminal_reason:"api_error",
 * api_error_status:429, result:"You've hit your org's monthly spend limit …"`. `hitMaxTurns`와
 * 같은 자리다: 설계 오류가 아니라 **환경/쿼터 조건**이라 재시도(사람 없이, sweeper의 blocked-origin
 * 재시도)로 풀린다.
 *
 * **구조적 신호는 그 자체로 판정한다** — `terminal_reason === "api_error"` 또는 `api_error_status`가
 * 4xx/5xx 정수. 이 둘은 CLI/게이트웨이가 실제로 API 에러를 구조화해 실은 것이라 그대로 믿는다.
 *
 * **자유 텍스트 폴백(`result`가 쿼터/장애 문구에 매치)은 그 두 필드를 못 채우는 옛/다른 CLI 경로를
 * 위한 안전망일 뿐이라 혼자 서지 못한다(r1)** — 대신 세 가지로 뒷받침돼야 한다:
 *   1. `is_error === true` — 성공 응답 안의 서술("429 응답을 반환하도록 구현했다" 같은)은 대상이
 *      아니다.
 *   2. 매치가 trim한 `result`의 **맨 앞**에서 시작한다 — 프로바이더 에러 텍스트가 **결과 전체**일
 *      때만 신뢰한다. 긴 서술 중간에 "rate limit"이 언급되거나(에이전트가 그 말을 인용·설명한
 *      것일 뿐일 수 있다), `error_during_execution` 봉투의 결과가 "429를 반환하도록…"처럼 중간에
 *      숫자만 스친 경우를 걸러낸다.
 *   3. `num_turns <= 2` 이거나 `duration_ms < 5000` — 실제 API 에러는 거의 즉시(적은 턴·짧은 시간)
 *      죽는다. 6턴짜리 정상 실행 끝에 나온 결과는(무엇을 말하든) API 에러가 아니라 에이전트가
 *      실제로 실행한 무언가의 산물이다.
 */
const API_ERROR_RESULT_RE = /spend limit|rate limit|usage limit|overloaded|529|429/i;
function corroboratedApiErrorText(out) {
  if (out.is_error !== true || typeof out.result !== "string") return false;
  const trimmed = out.result.trim();
  const m = API_ERROR_RESULT_RE.exec(trimmed);
  if (!m || m.index !== 0) return false;
  return (Number.isFinite(out.num_turns) && out.num_turns <= 2) || (Number.isFinite(out.duration_ms) && out.duration_ms < 5000);
}
export function hitApiError(out) {
  if (!out) return false;
  if (out.terminal_reason === "api_error") return true;
  if (Number.isInteger(out.api_error_status) && out.api_error_status >= 400 && out.api_error_status < 600) return true;
  return corroboratedApiErrorText(out);
}

/**
 * **비일시적(non-transient) 4xx**(KTB-22 r1) — {400, 401, 403, 404, 422}는 자격증명·요청 형식 같은
 * *설정* 문제라 재시도로 풀리지 않는다(같은 자격증명으로 다시 불러도 같은 자리에서 또 죽는다).
 * 408(요청 타임아웃)·425(Too Early)·429(rate limit)와 5xx는 여전히 **일시적**이다 — sweeper의
 * ≤3회 blocked-origin 재시도가 그 자리를 그대로 지킨다. `run-stage.js`가 이 판정으로 등급을
 * 가른다: 비일시적이면 `factory:needs-human`(사람이 자격증명/설정을 고쳐야 한다), 그 외(일시적
 * 4xx·5xx, 또는 구조적 신호 없이 텍스트로만 잡힌 경우)는 `factory:blocked`.
 */
const NON_TRANSIENT_API_ERROR_STATUS = new Set([400, 401, 403, 404, 422]);
export function isNonTransientApiError(out) {
  return Number.isInteger(out?.api_error_status) && NON_TRANSIENT_API_ERROR_STATUS.has(out.api_error_status);
}
/**
 * API 에러 실패의 run 기록/전이 사유 한 줄. 프로바이더 메시지를 **원문 그대로**(요약·재해석 없이)
 * 첫 줄만, 200자로 잘라 싣는다 — "claude -p reported is_error"는 사람에게 아무것도 말해주지 않지만,
 * 이 문장은 사람(과 sweeper의 재시도 판단)이 그대로 읽을 수 있다.
 */
export const apiErrorReason = (out) => {
  const status = Number.isInteger(out?.api_error_status) ? out.api_error_status : "n/a";
  const firstLine = String(out?.result ?? "").split("\n")[0].trim().slice(0, 200);
  return `claude -p api error ${status}: ${firstLine}`;
};

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
   *
   * 두 번째 예외가 **API 쿼터/장애**다(KTB-22, `hitApiError`) — claude -p 자신이 5xx/429/쿼터
   * 소진으로 죽은 것이지 에이전트나 프롬프트의 잘못이 아니다. 같은 규칙: 트랜스크립트에서 산출물을
   * 복구했으면 성공, 못 했으면 사유는 프로바이더 메시지 원문(`apiErrorReason`)이다.
   */
  const maxTurns = hitMaxTurns(out);
  const apiError = !maxTurns && hitApiError(out);
  const recovered = (maxTurns || apiError) && artifact.ok;
  if ((!out || out.is_error) && !recovered) {
    reasons.push(maxTurns ? maxTurnsReason(out) : apiError ? apiErrorReason(out) : "claude -p reported is_error");
  }
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
  // KTB-15b M1: 어느 후보가 이겼는지(트랜스크립트 파일 읽기냐, task-notification이냐, envelope 펜스냐)는
  // 사후 감사의 provenance다 — `extractStageArtifact`는 이미 계산해 뒀는데(ok일 때만 `source`가 있다)
  // 지금까지 여기서 버려졌다. run-stage가 이 값을 run 기록 한 줄로 남긴다(§run-stage.js `artifact:`).
  return { ok: reasons.length === 0, reasons, data, source: artifact.source ?? null };
}
