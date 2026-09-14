import { latestHandoff } from "./handoff.js";
import { validate } from "./schemas.js";
import { verifyReviewQuorum } from "./review-quorum.js";

const fail = (reason) => ({ ok: false, reason });
const pass = { ok: true };

/** ctx.issue가 주어지면 handoff 마커의 issue 번호까지 맞춘다 — 다른 이슈의 산출물이 게이트를 통과하지 못하게. */
function need(ctx, stage, schema) {
  const h = latestHandoff(ctx.comments, stage);
  if (!h) return { err: fail(`${stage} handoff missing`) };
  if (ctx.issue != null && h.issue !== Number(ctx.issue)) return { err: fail(`${stage} handoff issue mismatch: handoff issue ${h.issue} != ${ctx.issue}`) };
  const v = validate(schema, h.data);
  if (!v.ok) return { err: fail(`${stage} handoff invalid: ${v.errors.join("; ")}`) };
  return { h };
}
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/**
 * 게이트를 통과했다는 주장의 출처는 러너가 쓴 `.factory/out/gates.json` 하나뿐이다 — handoff의
 * 자기 신고는 대체재가 아니다(워크플로가 자기 성적표를 쓰는 것이므로). 파일을 읽지 않은 호출자
 * (`gatesChecked !== true`)는 "게이트가 GREEN이더라"를 주장할 자격이 없다 — 거부한다.
 *
 * 예외는 **선행 확인**(`ctx.prerequisite === true`)뿐이다: assertHandoff와 bin/assert-handoff는
 * "직전 스테이지가 산출물을 남겼는가"를 묻는 것이지 이번 런의 게이트를 묻는 게 아니다 — 그 시점엔
 * 이번 런의 게이트도 sha 바인딩도 존재하지 않는다(resetGates가 지운 직후다).
 */
/**
 * ADR-020 KTB-32 — **사람의 재시도(`transition.js --human --retry`)도 같은 종류의 "복구"다.**
 * 인프라가 끊은 자리로 되돌아가는 것이지 새 성취를 주장하는 것이 아니다: 사람의 노트북에는 이번
 * 런의 `.factory/out/gates.json`도 그 sha 바인딩도 존재할 수 없고(fresh checkout조차 아니다),
 * 실제 판정은 되돌아간 스테이지가 다시 돌며 만든다. 그래서 `prerequisite`와 **정확히 같은 것만**
 * 면제한다 — handoff의 존재·유효성·내용 검사(verifier 판정 등)는 그대로 물린다.
 */
const restoring = (ctx) => ctx.prerequisite === true || ctx.humanRetry === true;

export const GATES_UNVERIFIED = "gates not verified for this transition";
function gatesGate(ctx) {
  if (restoring(ctx)) return null;
  if (ctx.gatesChecked !== true) return fail(GATES_UNVERIFIED);
  if (!ctx.gatesFile) return fail("gates file missing");
  if (ctx.gatesFile.diagnostic === true) return fail("gates file is diagnostic output");
  if (ctx.gatesFile.status !== "GREEN") return fail(`gates file status is ${ctx.gatesFile.status}`);
  // 판정 파일이 **어떤 커밋**을 검사한 것인지까지 묶는다. 게이트가 돈 뒤에 커밋이 더 붙었으면
  // 그 GREEN은 지금 머지하려는 트리의 얘기가 아니다.
  const head = ctx.prHeadSha || ctx.headSha;
  const of = ctx.gatesFile.head_sha;
  if (head && of && of !== head) return fail(`gates file describes ${of.slice(0, 7)}, PR head is ${head.slice(0, 7)}`);
  return null;
}
const shaBound = (ctx) => !restoring(ctx);

/**
 * ── ADR-024 / KTB-42 — **qa 증거는 머지 조건이다(로스터에 qa가 있을 때).** ─────────────────────
 *
 * KTB #3은 이 규칙이 **산문으로만** 있었을 때 무슨 일이 일어나는지 보여 줬다: `reviewer-spec-conformance`가
 * 매 라운드 "증거 없음"으로 거부했지만, 그 거부는 스크립트의 판정이 아니라 한 리뷰어의 독해였고,
 * 정작 증거를 남길 수 없었던 진짜 원인(쓰기 권한)은 어디에도 기록되지 않았다. 이제 판정의 출처는
 * 파일 하나다: `.factory/out/qa/<issue>/manifest.json`(계약은 `lib/qa-evidence.js`).
 *
 * 두 자리가 **서로 다른 것**을 본다 — 볼 수 있는 것이 다르기 때문이다:
 *  - `factory:approved`(review 스테이지): 매니페스트 **파일**을 읽어 done_when 커버리지와 커밋 바인딩을
 *    검사한다(`ctx.qaEvidence`).
 *  - `factory:merged`(merge 스테이지): 그 파일을 볼 수 **없다**(`.factory/out/`는 gitignore, 머지는 별도
 *    잡의 새 체크아웃이다). 대신 review 런이 `factory/records`의 run 기록에 남긴 지문
 *    (`qa_manifest=<sha256>`, `ctx.qaManifestRecorded`)을 본다 — 러너만 쓸 수 있는 자리다.
 *
 * 로스터에 `qa`가 없으면 이 규칙은 **발화하지 않는다**: 부르지 않은 사람이 남기지 않은 증거는 결함이
 * 아니다(ADR-020 F3의 같은 문장, docs tier).
 */
export const QA_EVIDENCE_UNVERIFIED = "qa evidence manifest not verified for this transition";
export const QA_EVIDENCE_NOT_BOUND = "qa evidence not bound — the review run recorded no qa_manifest digest for this commit (the roster includes qa, so a valid manifest is required; see `node .factory/bin/qa-evidence.js finish`)";
function qaEvidenceGate(ctx, { merged = false } = {}) {
  if (restoring(ctx)) return null;
  const roster = Array.isArray(ctx.roster) ? ctx.roster : null;
  if (!roster || !roster.includes("qa")) return null;
  const ev = ctx.qaEvidence;
  const recorded = typeof ctx.qaManifestRecorded === "string" && ctx.qaManifestRecorded && ctx.qaManifestRecorded !== "none" ? ctx.qaManifestRecorded : null;
  if (merged) {
    if (!recorded) return fail(QA_EVIDENCE_NOT_BOUND);
    // 파일까지 읽을 수 있는 호출자(로컬 재현·테스트)라면 지문이 그때 그것인지도 본다.
    if (ev && ev.ok === false) return fail(`qa evidence manifest invalid: ${ev.reason || "unknown"}`);
    if (ev && ev.ok === true && ev.digest && ev.digest !== recorded) {
      return fail(`qa evidence manifest changed after the review run (record says ${recorded.slice(0, 12)}, the tree says ${String(ev.digest).slice(0, 12)})`);
    }
    return null;
  }
  if (!ev) return fail(QA_EVIDENCE_UNVERIFIED);
  if (ev.ok !== true) {
    const named = Array.isArray(ev.missing) && ev.missing.length ? `spec-evidence-missing: ${ev.missing.join(", ")}` : ev.reason || "unknown";
    return fail(`qa evidence manifest invalid — ${named}`);
  }
  const head = ctx.prHeadSha || ctx.headSha;
  if (head && ev.head_sha && ev.head_sha !== head) {
    return fail(`qa evidence manifest describes ${String(ev.head_sha).slice(0, 7)}, PR head is ${String(head).slice(0, 7)}`);
  }
  return null;
}

const RULES = {
  "factory:ready"(ctx) {
    const { h, err } = need(ctx, "triage", "triage.v1"); if (err) return err;
    if (h.data.disposition !== "ready") return fail(`triage disposition is ${h.data.disposition}, not ready`);
    return pass;
  },
  "factory:planned"(ctx) {
    const { h, err } = need(ctx, "plan", "plan.v1"); if (err) return err;
    if (ctx.roster && !sameSet(h.data.roles, ctx.roster)) return fail(`plan roles [${h.data.roles}] != roster [${ctx.roster}]`);
    if (ctx.expectedRounds != null && h.data.rounds !== ctx.expectedRounds) return fail(`plan rounds ${h.data.rounds} != expected ${ctx.expectedRounds}`);
    return pass;
  },
  "factory:awaiting-review"(ctx) {
    const { h, err } = need(ctx, "implement", "implement.v1"); if (err) return err;
    // 게이트 판정의 출처는 handoff가 아니라 러너가 쓴 파일이다 — handoff의 자기 신고는 대체재가 아니다.
    const g = gatesGate(ctx); if (g) return g;
    if (shaBound(ctx) && ctx.headSha && h.data.head_sha !== ctx.headSha) return fail(`implement head_sha ${h.data.head_sha.slice(0, 7)} != branch head ${ctx.headSha.slice(0, 7)}`);
    if (h.data.verifier.verdict === "rejected") return fail("verifier rejected");
    return pass;
  },
  "factory:approved"(ctx) {
    const { h, err } = need(ctx, "review", "review.v1"); if (err) return err;
    const g = gatesGate(ctx); if (g) return g;
    if (shaBound(ctx) && ctx.prHeadSha && h.data.head_sha !== ctx.prHeadSha) return fail(`review head_sha ${h.data.head_sha.slice(0, 7)} != PR head ${ctx.prHeadSha.slice(0, 7)}`);
    // 정족수·all-approve의 판정은 `lib/review-quorum.js` 한 곳이다(외부 감사 H1c) — handoff가 스스로
    // 적은 `decision`이 아니라 `must_fix`에서 aggregate로 다시 계산한다.
    // ADR-020 KTB-29 r1(SF1): **여기에 K 검사는 없다**(maxRounds를 넘기지 않는다). 예전에는 `round > K`면
    // approve까지 거부했다 — 그러면 라운드 4의 만장일치 통과가 그래프에서 튕기고, 이슈는
    // `awaiting-review`에 남아 stalled 팔에 두 번 재점화된 뒤 같은 사람에게 훨씬 느리고 시끄럽게
    // 올라간다. K는 **실패를 끊는 한도**이지 성공을 막는 한도가 아니다(스펙 §3.2의 엣지는
    // `rework → needs_human`이다) — 그 자리는 `nextState`다. 되돌릴 수 없는 `factory:merged`만 예외다(아래).
    const q = verifyReviewQuorum({ data: h.data, rosterSize: ctx.rosterSize ?? null, rosterRoles: ctx.roster || [] });
    if (!q.ok) return fail(q.reason);
    const qa = qaEvidenceGate(ctx); if (qa) return qa;
    return pass;
  },
  "factory:merged"(ctx) {
    const { h, err } = need(ctx, "review", "review.v1"); if (err) return err;
    const g = gatesGate(ctx); if (g) return g;
    if (shaBound(ctx) && ctx.prHeadSha && h.data.head_sha !== ctx.prHeadSha) return fail(`approved handoff head_sha != PR head`);
    /**
     * 외부 감사 2026-09-14 H1c — **정족수를 여기서 다시 묻는다.** 예전에는 이 규칙이 `need(review)`로
     * handoff의 존재·스키마만 보고, 정족수·all-approve는 `factory:approved`에만 있었다. 그런데
     * `factory:approved` 라벨은 라벨 편집 한 번(훅 우회 — H1a)으로도 붙고, `merge-stage.js`는
     * `mergePr`를 **이 규칙이 평가되기 전에** 부른다(:476 merge → :487 transition). 곧 이 규칙이
     * 리뷰를 다시 세지 않는 동안, "리뷰어가 한 번도 뜨지 않은 머지"의 마지막 방어선이 비어 있었다.
     *
     * 여기서는 K도 묻는다(`factory:approved`와 달리 — 위 참고). KTB-29 이후 `nextState`가 `round >= K`인
     * rework을 곧장 needs-human으로 보내므로 `round > K`인 approve는 정상 경로에서 만들어지지 않는다 —
     * 그런 handoff는 이 그래프를 거치지 않고 생긴 것이고, 되돌릴 수 없는 단계 앞에서 통과시킬 이유가 없다.
     */
    const q = verifyReviewQuorum({ data: h.data, rosterSize: ctx.rosterSize ?? null, rosterRoles: ctx.roster || [], maxRounds: ctx.maxRounds ?? null });
    if (!q.ok) return fail(q.reason);
    if (ctx.prerequisite === true) return pass;
    const qa = qaEvidenceGate(ctx, { merged: true }); if (qa) return qa;
    // 머지는 되돌릴 수 없다 — "확인하지 않았음"과 "확인해보니 RED"를 같게 취급한다(fail closed).
    if (ctx.checksGreen !== true) return fail("required checks not verified GREEN");
    if (ctx.integrityGreen !== true) return fail("integrity check not verified GREEN");
    return pass;
  },
};

export function requirementFor(toState) {
  return RULES[toState] || (() => pass);
}
