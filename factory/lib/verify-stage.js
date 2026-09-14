import { validate } from "./schemas.js";
import { extractStageArtifact } from "./stage-artifact.js";
import { matchesAny } from "./glob.js";
import { citedClaimIds } from "./qa-evidence.js";

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
 * ── plan 검증기 (감사 Task 9, P2) ─────────────────────────────────────────────
 *
 * 세 규칙 전부 **스크립트 집행**이다. 산문으로 적힌 같은 규칙은 데모 #2에서 9라운드·$118을 막지
 * 못했다(`docs/factory/dogfood/2026-09-14-plan-baseline.md`). 위반한 계획 핸드오프는 "스키마를
 * 통과하지 못한 산출물"과 똑같이 취급된다 — 스테이지는 GREEN이 되지 않고 사람에게 간다.
 *
 * (a) **dissent without done_when** — `dissent_log`에 남긴 위험 중 `severity`가 medium 이상이거나
 *     아예 없는 항목은, 그것을 막는 `done_when` 항목이 `covers: [<dissent id>]`로 짚어야 한다.
 *     #2의 단일 원인이 이것이다: 팩토리는 M2-1("npm start가 pg를 건드리지 않는다")을 **알고도**
 *     open_risk에 두었고, 그 뒤 리뷰 9라운드가 같은 것을 다시 말했다. 인식은 계약이 아니다.
 * (b) **done_when 상한** — `charter.plan.max_done_when`(기본 6). must_fix 15건 중 5건이 계획이
 *     스스로 발명한 done_when에서 나왔다. 라운드를 돌릴수록 done_when이 정교해지고, 정교해진
 *     done_when이 새 결함 표면이 됐다.
 * (c) **가드 모양의 done_when** — 화이트리스트·등장 금지·순서·저장소 전수 정규식으로 문서를
 *     검증하는 done_when(#18 dw2·dw4, #15 dw1–dw3)은 그 자체가 결함 표면이다. 이슈가 실제로
 *     가드를 요구하면(본문에 "guard"/"가드"/`[guard]`) 예외다.
 */
const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };
/**
 * **알려진 조잡한 필터다**(ADR 텍스트에 그대로 기록한다 — `docs/factory/audit/response-task-9.md`).
 * 문구 매칭이라 거짓 양성(가드가 아닌데 "ordering of sections"라고 쓴 계획)과 거짓 음성(같은 것을
 * 다른 말로 쓴 계획)이 둘 다 가능하다. 그래서 탈출구를 사람이 아니라 **이슈 본문**에 뒀다: 가드를
 * 원한 이슈는 그 말을 쓰게 된다. 이 목록은 실측(#15·#18에서 실제로 must_fix를 만든 done_when)에서
 * 뽑았고, 다음 표본에서 거짓 판정이 나오면 목록을 고치지 규칙을 끄지 않는다.
 */
export const GUARD_SHAPED_PATTERNS = [
  /whitelist|allowlist|화이트리스트/i,
  /must not appear|등장하지 않는다|나타나지 않는다/i,
  /only these files|이 파일들만/i,
  /regex over|정규식으로 훑|정규식으로 검사/i,
  /ordering of sections|순서를 (강제|검사|요구)/i,
  /line layout|줄 배치/i,
  // 저장소 전수 파일 목록 위에서 단언하는 모양 — #18 dw4가 정확히 이것이었다.
  /every file in the repo|all files in the repo|repository-wide|저장소 전체의? 파일/i,
];
const GUARD_REQUESTED = /\bguard\b|가드|\[guard\]/i;

/**
 * `plan.v1` 핸드오프를 CHARTER의 plan 규칙으로 검사한다. 반환은 사유 문자열 배열(빈 배열 = 유효).
 * 스키마 검사와 별개다 — 스키마는 "모양", 이것은 "계약".
 */
export function validatePlanHandoff(plan, { maxDoneWhen = 6, issueBody = "" } = {}) {
  const reasons = [];
  if (!plan || typeof plan !== "object") return reasons;
  const doneWhen = Array.isArray(plan.done_when) ? plan.done_when : [];
  const dissent = Array.isArray(plan.dissent_log) ? plan.dissent_log : [];

  // (a) 위험은 risks가 아니라 done_when으로 나온다.
  const covered = new Set();
  for (const d of doneWhen) if (Array.isArray(d?.covers)) for (const c of d.covers) covered.add(String(c));
  const uncovered = dissent
    // id가 없는 항목은 위치로 부른다 — 검증기가 id를 발명하는 게 아니라, 사람이 셀 수 있는 이름을 준다.
    .map((d, i) => ({ id: typeof d?.id === "string" && d.id ? d.id : `d${i + 1}`, severity: d?.severity }))
    .filter(({ severity }) => !(typeof severity === "string" && SEVERITY_RANK[severity] < SEVERITY_RANK.medium))
    .filter(({ id }) => !covered.has(id))
    .map(({ id }) => id);
  if (uncovered.length) reasons.push(`dissent without done_when: ${uncovered.join(", ")}`);

  // (b) 계획이 만드는 결함 표면의 상한.
  if (doneWhen.length > maxDoneWhen) reasons.push(`done_when has ${doneWhen.length} items (max ${maxDoneWhen})`);

  // (c) 가드의 가드 금지 — 이슈가 가드를 요구했으면 통과.
  if (!GUARD_REQUESTED.test(String(issueBody || ""))) {
    const guardish = doneWhen
      .filter((d) => GUARD_SHAPED_PATTERNS.some((re) => re.test(String(d?.text ?? ""))))
      .map((d, i) => (typeof d?.id === "string" && d.id ? d.id : `dw${i + 1}`));
    if (guardish.length) {
      reasons.push(`guard-shaped done_when: ${guardish.join(", ")} — done_when observes user-visible behaviour; say "guard" in the issue if a guard is what you want`);
    }
  }
  return reasons;
}

/**
 * gates: `.factory/out/gates.json`의 내용(없으면 null). 게이트 판정의 단일 출처는 이 파일이다 —
 * 워크플로가 handoff에 적은 gates는 파일과 **일치해야만** 인정되고, 비어 있으면 파일 값으로 채운다.
 * (그래서 schema 검증은 data.gates를 채운 뒤에 돈다.)
 */
/**
 * 외부 감사 2026-09-14 M1 — CHARTER의 NEVER_AUTOMATE 중 **글롭으로 적힌 항목**을 이슈의 영향 경로에
 * 다시 댄다. triage 에이전트도 같은 목록을 읽지만, 그 판정은 LLM의 것이고 이 판정은 스크립트의
 * 것이다: "에이전트가 목록을 못 봤다"가 통하지 않아야 그 목록이 실제로 벽이다.
 * → `[{path, glob}]`. 글롭이 없거나 경로가 없으면 빈 배열(없는 규칙을 발명하지 않는다).
 */
export function neverAutomateHits(paths, globs) {
  const gs = (Array.isArray(globs) ? globs : []).filter((g) => typeof g === "string" && g);
  if (!gs.length) return [];
  const hits = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== "string" || !p) continue;
    const g = gs.find((x) => matchesAny([x], p));
    if (g) hits.push({ path: p, glob: g });
  }
  return hits;
}

export function verifyStage({ stage, out, transcriptText, agentsLog, roster = [], rolePrefix = "", expectedRounds, orchestration, gates, planLimits, issueBody, neverAutomate = [], qaManifest = null }) {
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
  /*
   * 감사 M1 — 글롭으로 적힌 NEVER_AUTOMATE 항목은 **에이전트의 판정을 덮어쓴다**. 실패가 아니라
   * 판정의 교정이라 `reasons`에 넣지 않는다: 이 이슈는 `factory:wont-do`로 정상 종료해야 하고,
   * 여기서 verify를 FAIL시키면 CHARTER가 이미 답을 정해 둔 이슈가 사람에게 올라간다.
   * 무엇이 덮었는지는 `never_automate_hit`으로 handoff·run 기록에 그대로 남는다.
   */
  if (stage === "triage" && data) {
    const hits = neverAutomateHits(data.impact_paths, neverAutomate);
    if (hits.length) {
      const where = hits.map((h) => `${h.path} (${h.glob})`).join(", ");
      data.never_automate_hit = hits;
      if (data.disposition !== "wont-do") {
        data.disposition = "wont-do";
        data.reason = `CHARTER NEVER_AUTOMATE matches this issue's impact paths — ${where}. (script override of the triage verdict; audit M1)`;
      }
    }
  }
  if (data && orchestration && data.orchestration !== orchestration) reasons.push(`orchestration ${data.orchestration} != configured ${orchestration}`);
  if (stage === "plan" && data && expectedRounds != null && data.rounds !== expectedRounds) reasons.push(`rounds ${data.rounds} != expected ${expectedRounds}`);
  // CHARTER의 plan 규칙(감사 Task 9). 상한이 안 넘어오면 기본 6 — 규칙이 조용히 꺼지지는 않는다.
  if (stage === "plan" && data) reasons.push(...validatePlanHandoff(data, { maxDoneWhen: planLimits?.max_done_when ?? 6, issueBody }));
  for (const role of roster) {
    if (!agentsLog.completed.includes(rolePrefix + role)) reasons.push(`roster role not completed: ${role}`);
  }
  /**
   * ADR-024 / KTB-42 — **qa의 판정은 자기 증거를 부른다.** 매니페스트가 있고 로스터에 qa가 있으면,
   * qa의 verdict는 그 매니페스트 안에 실재하는 claim id를 **최소 하나** 인용해야 한다. 인용 없는
   * 판정은 증거와 판정이 서로를 모르는 상태이고, KTB #3에서 정확히 그 상태가 여덟 라운드 동안
   * "증거가 없다"와 "증거를 남겼다"를 동시에 참으로 만들었다. 도구가 만든 id 말고는 인용할 것이
   * 없으므로, 이 규칙은 리뷰어를 도구 쪽으로 민다(산문 대신 계약).
   */
  if (stage === "review" && data && qaManifest && roster.includes("qa")) {
    const v = (Array.isArray(data.verdicts) ? data.verdicts : []).find((x) => x?.role === "qa");
    const ids = Array.isArray(qaManifest.claimIds) ? qaManifest.claimIds : [];
    if (v && citedClaimIds(v, ids).length === 0) {
      reasons.push(`qa verdict cites no qa evidence claim id (manifest claims: ${ids.join(", ") || "none"}) — evidence lives in .factory/out/qa/<issue>/ and is written by \`node .factory/bin/qa-evidence.js\``);
    }
  }
  // KTB-15b M1: 어느 후보가 이겼는지(트랜스크립트 파일 읽기냐, task-notification이냐, envelope 펜스냐)는
  // 사후 감사의 provenance다 — `extractStageArtifact`는 이미 계산해 뒀는데(ok일 때만 `source`가 있다)
  // 지금까지 여기서 버려졌다. run-stage가 이 값을 run 기록 한 줄로 남긴다(§run-stage.js `artifact:`).
  return { ok: reasons.length === 0, reasons, data, source: artifact.source ?? null };
}
