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

/** 리뷰·머지도 게이트 파일을 요구한다 — 파일이 없으면 "확인 안 됨"이고, 확인 안 됨은 통과가 아니다. */
function gatesGate(ctx) {
  if (!ctx.gatesFile) return fail("gates file missing");
  if (ctx.gatesFile.status !== "GREEN") return fail(`gates file status is ${ctx.gatesFile.status}`);
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
    // 게이트 판정의 출처는 handoff가 아니라 러너가 쓴 파일이다 — 파일이 있으면 handoff의 자기 신고는 무시한다.
    const status = ctx.gatesFile ? ctx.gatesFile.status : h.data.gates.status;
    if (status !== "GREEN") return fail(ctx.gatesFile ? `gates file status is ${status}` : `gates status is ${status}`);
    if (ctx.headSha && h.data.head_sha !== ctx.headSha) return fail(`implement head_sha ${h.data.head_sha.slice(0, 7)} != branch head ${ctx.headSha.slice(0, 7)}`);
    if (h.data.verifier.verdict === "rejected") return fail("verifier rejected");
    return pass;
  },
  "factory:approved"(ctx) {
    const { h, err } = need(ctx, "review", "review.v1"); if (err) return err;
    const g = gatesGate(ctx); if (g) return g;
    if (ctx.prHeadSha && h.data.head_sha !== ctx.prHeadSha) return fail(`review head_sha ${h.data.head_sha.slice(0, 7)} != PR head ${ctx.prHeadSha.slice(0, 7)}`);
    if (ctx.rosterSize != null && h.data.verdicts.length !== ctx.rosterSize) return fail(`verdict count ${h.data.verdicts.length} != roster size ${ctx.rosterSize}`);
    if (!h.data.verdicts.every((v) => v.verdict === "approve")) return fail("not all approve");
    if (ctx.maxRounds != null && h.data.round > ctx.maxRounds) return fail(`round ${h.data.round} > K=${ctx.maxRounds}`);
    return pass;
  },
  "factory:merged"(ctx) {
    const { h, err } = need(ctx, "review", "review.v1"); if (err) return err;
    const g = gatesGate(ctx); if (g) return g;
    if (ctx.prHeadSha && h.data.head_sha !== ctx.prHeadSha) return fail(`approved handoff head_sha != PR head`);
    // 머지는 되돌릴 수 없다 — "확인하지 않았음"과 "확인해보니 RED"를 같게 취급한다(fail closed).
    if (ctx.checksGreen !== true) return fail("required checks not verified GREEN");
    if (ctx.integrityGreen !== true) return fail("integrity check not verified GREEN");
    return pass;
  },
};

export function requirementFor(toState) {
  return RULES[toState] || (() => pass);
}
