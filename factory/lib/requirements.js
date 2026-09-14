import { latestHandoff } from "./handoff.js";
import { validate } from "./schemas.js";

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
    if (ctx.rosterSize != null && h.data.verdicts.length !== ctx.rosterSize) return fail(`verdict count ${h.data.verdicts.length} != roster size ${ctx.rosterSize}`);
    if (!h.data.verdicts.every((v) => v.verdict === "approve")) return fail("not all approve");
    // ADR-020 KTB-29 r1(SF1): **여기에 K 검사는 없다.** 예전에는 `round > K`면 approve까지 거부했다 —
    // 그러면 라운드 4의 만장일치 통과가 그래프에서 튕기고, 이슈는 `awaiting-review`에 남아 stalled 팔에
    // 두 번 재점화된 뒤 같은 사람에게 훨씬 느리고 시끄럽게 올라간다. K는 **실패를 끊는 한도**이지 성공을
    // 막는 한도가 아니다(스펙 §3.2의 엣지는 `rework → needs_human`이다) — 그 자리는 `nextState`다.
    return pass;
  },
  "factory:merged"(ctx) {
    const { h, err } = need(ctx, "review", "review.v1"); if (err) return err;
    const g = gatesGate(ctx); if (g) return g;
    if (shaBound(ctx) && ctx.prHeadSha && h.data.head_sha !== ctx.prHeadSha) return fail(`approved handoff head_sha != PR head`);
    if (ctx.prerequisite === true) return pass;
    // 머지는 되돌릴 수 없다 — "확인하지 않았음"과 "확인해보니 RED"를 같게 취급한다(fail closed).
    if (ctx.checksGreen !== true) return fail("required checks not verified GREEN");
    if (ctx.integrityGreen !== true) return fail("integrity check not verified GREEN");
    return pass;
  },
};

export function requirementFor(toState) {
  return RULES[toState] || (() => pass);
}
