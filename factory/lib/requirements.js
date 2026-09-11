import { latestHandoff } from "./handoff.js";
import { validate } from "./schemas.js";

const fail = (reason) => ({ ok: false, reason });
const pass = { ok: true };

function need(comments, stage, schema) {
  const h = latestHandoff(comments, stage);
  if (!h) return { err: fail(`${stage} handoff missing`) };
  const v = validate(schema, h.data);
  if (!v.ok) return { err: fail(`${stage} handoff invalid: ${v.errors.join("; ")}`) };
  return { h };
}
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

const RULES = {
  "factory:ready"(ctx) {
    const { h, err } = need(ctx.comments, "triage", "triage.v1"); if (err) return err;
    if (h.data.disposition !== "ready") return fail(`triage disposition is ${h.data.disposition}, not ready`);
    return pass;
  },
  "factory:planned"(ctx) {
    const { h, err } = need(ctx.comments, "plan", "plan.v1"); if (err) return err;
    if (ctx.roster && !sameSet(h.data.roles, ctx.roster)) return fail(`plan roles [${h.data.roles}] != roster [${ctx.roster}]`);
    if (ctx.expectedRounds != null && h.data.rounds !== ctx.expectedRounds) return fail(`plan rounds ${h.data.rounds} != expected ${ctx.expectedRounds}`);
    return pass;
  },
  "factory:awaiting-review"(ctx) {
    const { h, err } = need(ctx.comments, "implement", "implement.v1"); if (err) return err;
    if (h.data.gates.status !== "GREEN") return fail(`gates status is ${h.data.gates.status}`);
    if (ctx.headSha && h.data.head_sha !== ctx.headSha) return fail(`implement head_sha ${h.data.head_sha.slice(0, 7)} != branch head ${ctx.headSha.slice(0, 7)}`);
    if (h.data.verifier.verdict === "rejected") return fail("verifier rejected");
    return pass;
  },
  "factory:approved"(ctx) {
    const { h, err } = need(ctx.comments, "review", "review.v1"); if (err) return err;
    if (ctx.prHeadSha && h.data.head_sha !== ctx.prHeadSha) return fail(`review head_sha ${h.data.head_sha.slice(0, 7)} != PR head ${ctx.prHeadSha.slice(0, 7)}`);
    if (ctx.rosterSize != null && h.data.verdicts.length !== ctx.rosterSize) return fail(`verdict count ${h.data.verdicts.length} != roster size ${ctx.rosterSize}`);
    if (!h.data.verdicts.every((v) => v.verdict === "approve")) return fail("not all approve");
    if (ctx.maxRounds != null && h.data.round > ctx.maxRounds) return fail(`round ${h.data.round} > K=${ctx.maxRounds}`);
    return pass;
  },
  "factory:merged"(ctx) {
    const { h, err } = need(ctx.comments, "review", "review.v1"); if (err) return err;
    if (ctx.prHeadSha && h.data.head_sha !== ctx.prHeadSha) return fail(`approved handoff head_sha != PR head`);
    if (ctx.checksGreen === false) return fail("required checks not GREEN");
    if (ctx.integrityGreen === false) return fail("integrity check not GREEN");
    return pass;
  },
};

export function requirementFor(toState) {
  return RULES[toState] || (() => pass);
}
