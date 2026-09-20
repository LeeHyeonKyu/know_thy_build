import { validate } from "./schemas.js";
import { extractStageArtifact } from "./stage-artifact.js";
import { matchesAny } from "./glob.js";
import { citedClaimIds, ALL_NA_PREFIX } from "./qa-evidence.js";

/**
 * 최종 리뷰 nit 3 — `extractJson`/`matchBrace`와 `export { fencedJsonError }`가 여기서 사라졌다.
 * KTB-7이 산출물 추출을 트랜스크립트 우선(`lib/stage-artifact.js`)으로 올린 뒤 **프로덕션 호출자가
 * 하나도 남지 않았고**(`lib`·`bin`·`cli`·`templates` 전수 확인), 그런데도 같은 브레이스 스캐너가
 * 두 파일에 두 벌 살아 있었다. 죽은 사본은 언젠가 원본과 어긋나고(그 어긋남은 테스트가 잡지 못한다 —
 * 죽은 쪽에만 테스트가 있었다), 다음 독자에게는 "추출 경로가 둘"이라고 거짓말한다. 정본은
 * `stage-artifact.js`의 `extractStageArtifact`·`fencedJsonError` 하나다.
 */
const SCHEMA_OF = { triage: "triage.v1", plan: "plan.v1", implement: "implement.v1", review: "review.v1" };

/**
 * ADR-024 / KTB-42(리뷰 라운드 1 MF-2) — qa **증거 경로**의 고장을 부르는 사유 접두사. run-stage가
 * 이 문자열로 등급을 가른다: 이것은 에이전트의 산출물 결함이 아니라 판정 불가이므로 `needs-human`이
 * 아니라 `factory:blocked` + cause `undecidable`이다(프로브 실패와 같은 등급).
 */
export const QA_EVIDENCE_UNUSABLE = "qa evidence manifest unusable";
export const qaEvidenceUnusable = (reasons = []) => reasons.some((r) => String(r).startsWith(QA_EVIDENCE_UNUSABLE));

/**
 * 최종 리뷰 A-SF1 — qa **리뷰어 자신의** 증거 부족을 부르는 접두사. 위의 것과 반대편이다: 경로는
 * 멀쩡하고 산출물도 멀쩡하며, 비어 있는 것은 커버리지다. 그래서 이 문장은 스테이지 실패가 아니라
 * 이 라운드의 **reject**로 배달된다(합성 must_fix → `factory:rework`).
 */
export const QA_EVIDENCE_INCOMPLETE = "qa evidence incomplete:";

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
 * ── 수용 계약 (리뷰 효율 Task 1, Structure A) ──────────────────────────────────
 * done_when 각 항목은 **어떻게 확인되는지**(`check {kind, ref}`)와 리뷰어가 적용할 **한 줄 기준**
 * (`rubric`) 중 적어도 하나를 지녀야 한다. 이 하나의 계약이 세 곳에서 쓰인다: 구현자의 핸드오프 전
 * 자가 점검(Task 3), 리뷰어의 채점 기준(Task 7), 머지의 증거. `check.kind`는 test|gate|finish|rubric —
 * `test`는 Task 3가 돌릴 테스트 이름, `gate`는 게이트 이름, `finish`는 qa 매니페스트가 채점, `rubric`은
 * 돌릴 것이 없는 리뷰어 판정 전용이다. `verify`(테스트 id)는 `check {kind:"test"}`의 옛 철자라, 그 하나만
 * 든 옛 핸드오프도 계약을 갖춘 것으로 친다 — 새 요구를 집행하는 것은 파서가 아니라 이 검증기다.
 */
const CHECK_KINDS = new Set(["test", "gate", "finish", "rubric"]);
/** `check.kind:"test"`의 ref는 Task 3가 vitest에 넘길 테스트 이름이다: `test_<...>` 형태, 공백 없음. */
const TEST_REF_RE = /^test_[A-Za-z0-9][\w-]*$/;
const isRunnableTestRef = (ref) => typeof ref === "string" && TEST_REF_RE.test(ref.trim());
/**
 * 스스로 확인 가능한 check을 지녔는가. 명시적 `check`이 있으면 그 kind로 판정하고(rubric kind는 돌릴
 * 것이 없어 rubric 문자열에 기댄다), 없으면 옛 `verify`(테스트 id)를 check으로 친다.
 */
function hasUsableCheck(item, check) {
  if (check && CHECK_KINDS.has(check.kind)) {
    if (check.kind === "rubric") return false;                       // 리뷰어 판정 전용 — 돌릴 check이 없다
    if (check.kind === "test") return isRunnableTestRef(check.ref);
    return typeof check.ref === "string" && check.ref.trim() !== ""; // gate/finish는 이름 하나면 된다
  }
  return typeof item?.verify === "string" && item.verify.trim() !== ""; // 옛 철자
}

/**
 * ── 회귀 핀 (리뷰 효율 Task 5, Structure D / design §4.D) ──────────────────────────────────────
 * `→ rework`에서 리뷰어 must_fix 하나하나가 carried **pin** `{ id, guard: {kind, ref} | null, text }`이
 * 된다. 돌릴 수 있는 테스트가 guard로 붙은 핀은 다음 self-gate의 **하드 게이트**이고, guard가 없는
 * 산문 핀은 advisory 체크리스트 줄일 뿐이다(spec §9 Q5 — 불가능한 루프를 만들지 않는다). KTB #18 R3를
 * 죽인다: R라운드의 must_fix를 고치다 **같은 id** 아래 새 결함을 낳았을 때, guard 테스트를 self-gate에서
 * 다시 돌리면 또 한 번의 전면 리뷰 라운드 전에 그 회귀를 잡는다.
 *
 * **guard는 꾸며내지 않는다.** 리뷰어 must_fix는 대개 산문이다. guard는 **연결이 있을 때만** 뽑는다:
 *   (1) must_fix의 `id`가 어떤 done_when의 id와 같거나,
 *   (2) 어떤 done_when의 `covers`가 그 id를 짚거나,
 *   (3) must_fix의 `where`가 어떤 done_when 계약 check의 테스트 이름을 그대로 담고 있을 때.
 * 그 done_when의 수용 계약 `check {kind:"test", ref}`(또는 옛 철자 `verify`)이 **돌릴 수 있는 테스트
 * 이름**이면 그것이 guard가 된다. 그 외에는 `guard: null` → advisory 산문 핀뿐이다(불가능한 self-gate
 * 루프를 절대 만들지 않는다).
 */
function testGuardOf(dw) {
  if (!dw || typeof dw !== "object") return null;
  const c = dw.check;
  if (c && typeof c === "object" && c.kind === "test" && isRunnableTestRef(c.ref)) return { kind: "test", ref: c.ref.trim() };
  // 옛 핸드오프: `verify`(테스트 id)는 `check {kind:"test"}`의 옛 철자다(이 파일의 다른 판정과 같은 계약).
  if (typeof dw.verify === "string" && isRunnableTestRef(dw.verify)) return { kind: "test", ref: dw.verify.trim() };
  return null;
}
const RE_META = /[.*+?^${}()|[\]\\]/g;
/** `ref` as a whole-token match — a test name is bounded by non-`[\w-]` on both sides, so `test_7`
 * never links a `where` that only names `test_7_create` (nit 1: substring match false-linked prefixes). */
const namesTestRef = (where, ref) => new RegExp(`(?<![\\w-])${ref.replace(RE_META, "\\$&")}(?![\\w-])`).test(where);
export function deriveReworkPins({ mustFix = [], doneWhen = [] } = {}) {
  const dw = (Array.isArray(doneWhen) ? doneWhen : []).filter((d) => d && typeof d === "object");
  // First-in-array wins for both maps — done_when ids are meant to be unique, but if two entries collide
  // (or two `covers` the same dissent id) the earlier one is the deterministic pick (nit 2).
  const byId = new Map();
  for (const d of dw) if (typeof d.id === "string" && d.id && !byId.has(d.id)) byId.set(d.id, d);
  const byCovered = new Map();
  for (const d of dw) if (Array.isArray(d.covers)) for (const c of d.covers) if (!byCovered.has(String(c))) byCovered.set(String(c), d);
  const findLinked = (m) => {
    const id = m?.id != null ? String(m.id) : "";
    if (id && byId.has(id)) return byId.get(id);
    if (id && byCovered.has(id)) return byCovered.get(id);
    const where = typeof m?.where === "string" ? m.where : "";
    if (where) {
      for (const d of dw) {
        const g = testGuardOf(d);
        if (g && namesTestRef(where, g.ref)) return d;
      }
    }
    return null;
  };
  return (Array.isArray(mustFix) ? mustFix : []).filter(Boolean).map((m) => {
    const id = m.id != null ? String(m.id) : "";
    const text = typeof m.claim === "string" && m.claim.trim() ? m.claim
      : typeof m.where === "string" && m.where.trim() ? m.where : id;
    return { id, guard: testGuardOf(findLinked(m)), text };
  });
}

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

  // (d) 수용 계약(Task 1) — 위 (a)~(c)를 **덧붙인다**, 대체하지 않는다. 계약을 못 갖춘 done_when은
  //     dissent를 짚었든 아니든 그 자체로 실패다.
  doneWhen.forEach((d, i) => {
    const id = typeof d?.id === "string" && d.id ? d.id : `dw${i + 1}`;
    const check = d && typeof d.check === "object" && d.check ? d.check : null;
    const hasRubric = typeof d?.rubric === "string" && d.rubric.trim() !== "";
    if (check) {
      // 새 항목(명시적 `check`을 실은 것)은 계약을 온전히 갖춘다 — check과 rubric 둘 다. 이 검증기가
      // 모든 핸드오프의 실제 게이트이므로(재종합·수리 턴·손편집은 emission 스키마를 통과하지 않는다),
      // Task 7 리뷰어의 채점 기준(rubric)을 여기서 보장한다.
      // `check.kind:"test"`의 ref는 Task 3가 실제로 돌릴 수 있어야 한다 — 비었거나 테스트 이름 모양이
      // 아니면 돌릴 수 없는 계약이라 미완이다.
      if (check.kind === "test" && !isRunnableTestRef(check.ref)) {
        reasons.push(`acceptance contract incomplete: ${id}`);
      } else if (!hasRubric) {
        reasons.push(`acceptance contract incomplete: ${id} — check present but rubric missing`);
      }
      return;
    }
    // 옛 항목: 명시적 check이 없다. `verify`(check {kind:"test"}의 옛 철자)나 rubric 중 하나면 계약이
    // 완결이다 — 옛 핸드오프는 rubric 없이 verify만으로 통과한다(back-compat).
    if (!hasUsableCheck(d, null) && !hasRubric) reasons.push(`acceptance contract incomplete: ${id}`);
  });

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
  /** A-SF1 — qa 리뷰어 자신의 증거 부족. 스테이지 실패가 아니라 **이 라운드의 판정 재료**로 나간다. */
  let qaShortfall = null;
  /**
   * Task 9 (Structure H, KTB-51) — the plan validator's **machine-checkable** reasons, carried out
   * separately so run-stage can tell a deterministic plan-contract defect (repairable in one turn)
   * apart from every other failure (schema/roster/api/turn/gate — never repaired). Null unless the
   * plan validator actually found something; the same strings are also pushed to `reasons`.
   */
  let planRepair = null;
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
  // Task 9(KTB-51): 이 검증기의 사유는 결정적·기계 판정이라 한 번의 수리 턴으로 되먹일 수 있다 —
  // `planRepair`로 따로 실어 run-stage가 "순수 계획-계약 결함"만 골라 수리하게 한다.
  if (stage === "plan" && data) {
    const pr = validatePlanHandoff(data, { maxDoneWhen: planLimits?.max_done_when ?? 6, issueBody });
    if (pr.length) { reasons.push(...pr); planRepair = pr; }
  }
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
    /**
     * 리뷰 라운드 1 MF-2 — **두 상태를 가른다.** 예전에는 매니페스트가 아예 없거나 지난 커밋의
     * 것이어도 이 규칙이 그대로 발화해서 `claimIds`가 비었고, 결과 문구는 "qa가 아무것도 인용하지
     * 않았다"였다 — 곧 **증거 경로의 고장을 리뷰어의 인용 습관 탓으로** 돌렸다. 그것은 ADR-024가
     * 없애려던 바로 그 문장(`spec1: qa evidence missing`)의 다른 철자다. 게다가 그 사유는 run-stage에서
     * `needs-human`으로 등급이 매겨져, "한 라운드 더 돌면 매니페스트가 생긴다"는 ADR의 업그레이드
     * 경로를 스스로 막았다.
     */
    /**
     * 재리뷰 SF-1b — **누구의 부족인가로 한 번 더 가른다.** 1라운드의 분기는 `ok !== true` 전부를
     * "증거 경로의 고장"으로 불렀는데, `evidenceFor`의 실패에는 **qa 리뷰어 자신의 부족**도 들어 있다:
     * 커버리지가 빈 id들(`missing`)과 전부 `not_applicable`인 매니페스트. 그 둘을 인프라로 부르면
     * ① "빌더의 일이 아니다"라는 문장이 사실과 어긋나고(그 상태는 **qa**의 일이다),
     * ② `undecidable`로 등급이 매겨져 sweeper가 같은 부족을 상대로 리뷰 스테이지를 세 번 다시 돌리고,
     * ③ SF-3이 막 만든 거절("that is a report, not a review")이 "무시해도 되는 인프라" 채널로 배달된다.
     * 그래서 여기서는 **id를 부르는 거절**로 내보낸다 — 등급은 평범한 산출물 실패(사람에게 간다)다.
     */
    /**
     * 최종 리뷰 A-SF1 — **그 부족은 스테이지의 실패가 아니라 이 라운드의 판정이다.** r2는 "누구의
     * 부족인가"까지 갈랐지만 배달 채널은 그대로 `reasons`였다: `v.ok`가 거짓이 되고, run-stage는 그
     * 사유에 기본 접두어(`stage artifact missing or invalid`)를 붙여 `factory:needs-human`으로 보냈다.
     * 두 번 틀린다 — ① `review.v1` 산출물은 멀쩡한데 산출물 탓을 하고(ADR-024가 없애려던 바로 그
     * 문장 계열), ② 리뷰어 넷이 돈 라운드가 통째로 버려지고 **한 라운드 더 돌면 풀릴 일**이 사람에게
     * 올라간다 — 등급이 판단이 아니라 누락(다른 분기의 기본값)으로 정해진 자리였다.
     *
     * 그래서 `reasons`가 아니라 `qaShortfall`로 내보낸다. run-stage가 그것을 이 라운드의 집계에
     * **합성 must_fix**(role qa, id를 부른다)로 접어 넣어 `factory:rework`(또는 K 한도의 평소 경로)로
     * 보낸다. 접두어도 자기 것을 쓴다(`qa evidence incomplete:`).
     */
    const reviewerSide = (qaManifest.missing?.length ?? 0) > 0
      || (qaManifest.reasons || []).some((r) => String(r).startsWith(ALL_NA_PREFIX));
    if (qaManifest.ok !== true && reviewerSide) {
      const named = qaManifest.missing?.length ? `spec-evidence-missing: ${qaManifest.missing.join(", ")}` : (qaManifest.reasons || [])[0];
      qaShortfall = {
        ids: [...(qaManifest.missing || [])],
        reason: `${QA_EVIDENCE_INCOMPLETE} ${named}; the qa reviewer records it with \`node .factory/bin/qa-evidence.js record|attach|na\` and checks it with \`finish\``,
      };
    } else if (qaManifest.ok !== true) {
      reasons.push(`${QA_EVIDENCE_UNUSABLE}: ${qaManifest.reason || "unknown"} — this is the evidence path, not the builder's work (ADR-024); .factory/out/qa/<issue>/manifest.json is written by \`node .factory/bin/qa-evidence.js\``);
    } else {
      const v = (Array.isArray(data.verdicts) ? data.verdicts : []).find((x) => x?.role === "qa");
      const ids = Array.isArray(qaManifest.claimIds) ? qaManifest.claimIds : [];
      if (v && citedClaimIds(v, ids).length === 0) {
        reasons.push(`qa verdict cites no qa evidence claim id (manifest claims: ${ids.join(", ") || "none"}) — evidence lives in .factory/out/qa/<issue>/ and is written by \`node .factory/bin/qa-evidence.js\``);
      }
    }
  }
  // KTB-15b M1: 어느 후보가 이겼는지(트랜스크립트 파일 읽기냐, task-notification이냐, envelope 펜스냐)는
  // 사후 감사의 provenance다 — `extractStageArtifact`는 이미 계산해 뒀는데(ok일 때만 `source`가 있다)
  // 지금까지 여기서 버려졌다. run-stage가 이 값을 run 기록 한 줄로 남긴다(§run-stage.js `artifact:`).
  return { ok: reasons.length === 0, reasons, data, source: artifact.source ?? null, qaShortfall, planRepair };
}
