import { parseHandoffs } from "./handoff.js";
import { parseReviewEvidenceAll, parseRecordSection, runIdOfRunner } from "./run-record.js";
import { knownRunsFor, isBoundLine, parseRecordEvidence } from "./feedback/harvest-findings.js";
import { parseHeartbeat } from "./heartbeat.js";
import { SELF_GATE_DETAIL_PREFIX } from "./self-gate.js";
import { validate } from "./schemas.js";
import { countedTransitionIndices } from "./retro/issue-comments.js";

/**
 * ── #195 — the "Factory evidence" section of a PR body, assembled by code ─────────────────────────────────────────────
 *
 * Right before an auto-merge (and right before a hand-off to a human) the runner writes one section at the end of the PR
 * body saying what the factory caught, what it proved and what it cost. Every row comes from something a program wrote:
 *   - **record** rows: runner-written run-record lines (`docs/factory/runs/<n>.md`) — and only lines bound to a run that a
 *     heartbeat comment names (`knownRunsFor`/`isBoundLine`, the same guard retro/feedback use). `docs/factory/runs/**` is a
 *     path an agent session could append to (`[protected].runner_only` is the write boundary; this is the read side), and
 *     heartbeat runner ids are public, so "names a known run" is not enough on its own. A line is a record only when (see
 *     `bindLines`): it carries BOTH its own `run_id` and `runner` and they agree; that runner's heartbeat is a stage that
 *     produces this kind of line (review-evidence ← review, self-gate-detail ← implement); and no other, different line of the
 *     same kind speaks for the same run (two stories for one run → neither). The `## stage · at · runner` header is never
 *     used to bind — anyone can put a header in front of a line. Everything else is counted in `data.unbound`, never shown.
 *   - **live** rows, values the caller passes in: this merge run's own gates result (+ whether it was the one re-run's) and the
 *     hand-off reason. Neither is a record line (the hand-off reason reaches the record only after the transition), so they
 *     are labelled `live`, never `record`. Record `FACTORY_GATES:` lines carry no run id, so they are never a source; every
 *     one is counted as not used.
 *   - the lifetime cost: the run-bound `budget: lifetime $X / $CAP over N run(s)` line (lib/budget.js `budgetLine`, written by
 *     run-stage first thing in every non-merge stage run). It carries no run id of its own, so its section's runner binds it
 *     — the one place the header is used, and said so on the row: the runner must be heartbeat-known, its heartbeat must name
 *     the section's stage, the stage must be one that writes the line (never merge), and one run has one `budget:` story (two
 *     different `budget:` lines for one run → neither counts). The latest bound line is shown, with the run it came from.
 *     `usage:` lines are never a cost source, and neither is the caller's budget check.
 *   - the new-test proof: the self-gate-detail line says `mutation` ran and nothing blocked, but a crashed check and a
 *     skipped test file are non-blocking and leave the line identical. So the proof also needs the `self-gate: … → ok` line
 *     run-stage writes right before it (same `record()` call) to say 0 advisory findings. The proven count is the plan's
 *     done_when test count (a claim) gated by that record — no per-test result is recorded (#195 non_goals).
 *   - **claim** rows: agent-written handoff comments (plan `done_when`, review `must_fix`) on the tracking issue, and the
 *     builder's `factory.rework-response.v1` on the PR (factory-builder.md has it posted with `gh pr comment <pr>`; the
 *     engine's other reader, context.js, reads it from the PR too). They are shown, and labelled as claims — the shared bot
 *     account can post them.
 *   - **who may supply a row**: heartbeat, handoff, rework-response and transition comments count only when their author is
 *     one of the factory's logins (`resolveFactoryLogins`, passed in as `factoryLogins`). A comment by anyone else adds no
 *     row, status, sha, run or queue time (transition comments are the runner's own: lib/transition.js posts them with the
 *     runner's token, `by=human` included). When the logins could not be resolved, nobody can be told apart, so this fails
 *     CLOSED: no comment is a source at all — no handoff row, no heartbeat (and so no heartbeat-bound record line), no rework
 *     response, no queue time — and a visible note says why (the caller also writes the record's FAIL line). Only the values
 *     the caller passes in (this run's gates, the hand-off reason) are shown then.
 * No prose is generated and nothing is summarised by a model. A source missing from the input drops its row: no empty
 * cell, no placeholder. `now` is injected — the same inputs give byte-identical output.
 *
 * Pure: no I/O. The PR-body edit and the issue comment are run-stage's (through lib/gh.js).
 */

export const EVIDENCE_START = "<!-- factory-evidence:v1 -->";
export const EVIDENCE_END = "<!-- /factory-evidence:v1 -->";
export const EVIDENCE_HEADING = "## Factory evidence";
/** GitHub's PR/issue body limit in characters (assumed 65,536 — see the #195 plan's open risks). */
export const PR_BODY_MAX_CHARS = 65536;
/** One agent-written cell is cut at this many characters — a cell is a pointer, the full text stays in the handoff. */
const CELL_MAX = 160;

/**
 * An agent string as inline table text: one line, no table separator, no HTML (so it can never spell either marker or
 * open a comment), no backtick fences. `## ` mid-line is plain text once the newlines are gone.
 */
export function escapeCell(v, { max = CELL_MAX } = {}) {
  let s = String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`/g, "'")
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1).replace(/\\$/, "")}…`;
  return s;
}

const GATES_LINE = /^FACTORY_GATES: /;
const SHA = /^[0-9a-f]{7,40}$/i;
/** Which heartbeat stage writes which record line (run-stage: review-evidence in review, self-gate-detail in implement). */
const PRODUCER_STAGES = { review: new Set(["review"]), self_gate: new Set(["implement"]) };
const REWORK_JSON = /```json\s*([\s\S]*?)```/g;

/** runner → the set of stages its heartbeats name (the runner's own channel; a stage run makes a new heartbeat comment). */
function heartbeatStages(comments) {
  const out = new Map();
  for (const c of comments) {
    const hb = parseHeartbeat(c?.body);
    if (!hb?.runner) continue;
    if (!out.has(hb.runner)) out.set(hb.runner, new Set());
    out.get(hb.runner).add(hb.stage);
  }
  return out;
}

/**
 * Lines of one kind → the ones that are record evidence, and how many are not. `idOf(l)` → `{ runner, run_id }` from the
 * line itself; `keyOf(l)` → the line's content (two equal copies are one story — a records-branch tail merge can repeat a line).
 */
function bindLines(lines, { known, stages, kind, idOf, keyOf }) {
  const candidates = [];
  let rejected = 0;
  for (const l of lines) {
    const { runner, run_id: runId } = idOf(l);
    const ok = runner != null && runId != null
      && String(runIdOfRunner(runner)) === String(runId)
      && isBoundLine({ runner, run_id: runId }, known)
      && [...(stages.get(String(runner)) ?? [])].some((s) => PRODUCER_STAGES[kind].has(s));
    if (ok) candidates.push({ l, run: String(runId), key: keyOf(l) }); else rejected += 1;
  }
  const keysOf = new Map();
  for (const c of candidates) { if (!keysOf.has(c.run)) keysOf.set(c.run, new Set()); keysOf.get(c.run).add(c.key); }
  const bound = [];
  const seen = new Set();
  for (const c of candidates) {
    if (keysOf.get(c.run).size > 1) { rejected += 1; continue; }        // two different stories for one run: neither is fact
    if (seen.has(c.run)) continue;                                      // the same line twice is one line
    seen.add(c.run);
    bound.push(c.l);
  }
  return { bound, rejected };
}

/** createdAt → ms, or null. */
const at = (c) => { const t = Date.parse(c?.createdAt ?? ""); return Number.isFinite(t) ? t : null; };

/** Valid `factory.rework-response.v1` objects for this issue, each with its comment's time. Invalid ones are skipped. */
function reworkResponses(comments, issue) {
  const out = [];
  for (const c of comments) {
    for (const m of String(c?.body ?? "").matchAll(REWORK_JSON)) {
      let obj;
      try { obj = JSON.parse(m[1]); } catch { continue; }
      if (obj?.schema !== "factory.rework-response.v1") continue;
      if (!validate("rework-response.v1", obj).ok) continue;
      if (issue != null && obj.issue !== issue) continue;
      out.push({ at: at(c), responses: obj.responses });
    }
  }
  return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

/**
 * `factoryLogins` (what `resolveFactoryLogins` returned) → `{ ok, logins: Set<lowercased login> }` or `{ ok:false, reason }`.
 * Anything that is not a resolved, non-empty login list is "not resolved" — fail closed, never "everyone".
 */
function loginsOf(factoryLogins) {
  if (factoryLogins?.ok === true && Array.isArray(factoryLogins.logins)) {
    const set = new Set(factoryLogins.logins.map((l) => String(l ?? "").trim().toLowerCase()).filter(Boolean));
    if (set.size) return { ok: true, set };
  }
  const reason = typeof factoryLogins?.reason === "string" && factoryLogins.reason.trim() ? factoryLogins.reason.trim() : "factory logins were not resolved";
  return { ok: false, reason };
}

const BUDGET_LIFETIME = /^budget: lifetime \$(\d+(?:\.\d+)?) \/ \$(\d+(?:\.\d+)?) over (\d+) run\(s\)(?: — REFUSED)?$/;
/** Stages whose run-stage run writes a `budget:` line (run-stage skips the budget check in merge). */
const BUDGET_STAGES = new Set(["triage", "plan", "implement", "review"]);

/**
 * The latest run-bound `budget: lifetime` line → `{ usd, cap, runs, run_id, stage }` or null, plus how many `budget:` lines
 * were not bound. See the module doc for the binding rule.
 */
function boundBudget(recordText, { known, stages }) {
  const lines = [];                                                     // { runner, stage, line } in record order
  let section = null;
  for (const raw of String(recordText ?? "").split("\n")) {
    const l = raw.trimEnd();
    const h = parseRecordSection(l);                                   // the writer's own grammar (run-record.js)
    if (h) { section = { stage: h.stage, runner: h.runnerId }; continue; }
    if (section && l.startsWith("budget:")) lines.push({ ...section, line: l });
  }
  let rejected = 0;
  const byRunner = new Map();
  for (const e of lines) {
    const ok = BUDGET_STAGES.has(e.stage)
      && isBoundLine({ runner: e.runner, run_id: runIdOfRunner(e.runner) }, known)
      && (stages.get(e.runner)?.has(e.stage) ?? false);
    if (!ok) { rejected += 1; continue; }
    if (!byRunner.has(e.runner)) byRunner.set(e.runner, []);
    byRunner.get(e.runner).push(e);
  }
  let latest = null;
  for (const e of lines) {
    const mine = byRunner.get(e.runner);
    if (!mine || !mine.includes(e)) continue;
    if (new Set(mine.map((x) => x.line)).size > 1) continue;           // two different budget stories for one run: neither
    const m = BUDGET_LIFETIME.exec(e.line);
    if (m) latest = { usd: Number(m[1]), cap: Number(m[2]), runs: Number(m[3]), run_id: String(runIdOfRunner(e.runner) ?? e.runner), stage: e.stage };
  }
  for (const mine of byRunner.values()) if (new Set(mine.map((x) => x.line)).size > 1) rejected += mine.length;
  return { cost: latest, rejected };
}

const fmtElapsed = (ms) => {
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return d ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
};
/** The `self-gate: <ran> → ok[ (N advisory)]` line run-stage writes right before a passing self-gate's detail line. */
const SELF_GATE_OK = /^self-gate: (\S+) → ok(?: \((\d+) advisory\))?$/;

/**
 * Advisory-finding count for the bound self-gate-detail line `sg`: read from the line in front of EVERY copy of it in the
 * record. All copies must be preceded by a matching ok line that agrees — otherwise null (the outcome is not recorded).
 */
function selfGateAdvisory(recordText, sg) {
  const want = JSON.stringify({ ...sg, section: undefined });
  const lines = String(recordText ?? "").split("\n").map((l) => l.trimEnd());
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(SELF_GATE_DETAIL_PREFIX)) continue;
    let o;
    try { o = JSON.parse(lines[i].slice(SELF_GATE_DETAIL_PREFIX.length)); } catch { continue; }
    if (JSON.stringify({ ...o, section: undefined }) !== want) continue;
    const m = i > 0 ? SELF_GATE_OK.exec(lines[i - 1]) : null;
    if (!m || m[1] !== ((Array.isArray(o.ran) && o.ran.length ? o.ran.join("+") : "none"))) return null;
    seen.add(m[2] == null ? 0 : Number(m[2]));
  }
  return seen.size === 1 ? [...seen][0] : null;
}

/** The proof's outcome as words (the headline and the contract fact say the same thing). */
function proofText(p) {
  if (p.blocked) return `mutation ${p.mutation}, blocked`;
  if (p.mutation !== "ran") return `mutation ${p.mutation}, not blocked`;
  if (p.advisory == null) return "mutation ran, outcome line missing — not proven";
  if (p.advisory > 0) return `mutation ran with ${p.advisory} advisory finding(s) (a crashed check and a skipped test file are non-blocking and land here) — not proven`;
  return "mutation ran, 0 advisory findings, not blocked";
}

const list = (a) => (Array.isArray(a) && a.length ? a.join(",") : "none");

/**
 * → `{ markdown, data }`. Inputs:
 *   recordText — the hydrated run record (`docs/factory/runs/<n>.md`), or null/"" when there is none;
 *   issueComments — the tracking issue's comments (`gh.comments(issue)`: `{ body, createdAt, author }`): heartbeats,
 *                   handoffs, transitions;
 *   prComments    — the PR's comments (`gh.comments(pr)`): where the builder posts its rework responses;
 *   factoryLogins — what `resolveFactoryLogins` returned (`{ ok:true, logins }` or `{ ok:false, reason }`), or null;
 *   gates      — this merge run's own `factory.gates.v1` result, or null when the merge stage had none yet;
 *   gatesRerun — true when that result is the one re-run's (#157);
 *   reason     — the hand-off / refusal reason the merge stage is about to transition with, or null;
 *   pr, now    — the PR number and the current time (ISO string or ms). `now` null → no elapsed row.
 */
export function buildEvidence({ recordText = null, issueComments = [], prComments = [], factoryLogins = null, gates = null, gatesRerun = false, reason = null, pr = null, now = null } = {}) {
  const issueAll = Array.isArray(issueComments) ? issueComments : [];
  const logins = loginsOf(factoryLogins);
  const byFactory = (c) => logins.set.has(String(c?.author ?? "").trim().toLowerCase());
  // Heartbeats, handoffs and transitions: only the factory's own comments. Without resolved logins nobody can be told apart,
  // so no comment is read at all (fail closed, never "everyone") — see the module doc.
  const cs = logins.ok ? issueAll.filter(byFactory) : [];
  const prFactory = logins.ok ? (Array.isArray(prComments) ? prComments : []).filter(byFactory) : [];
  const known = knownRunsFor(cs);
  const stages = heartbeatStages(cs);
  const handoffs = parseHandoffs(cs);
  const issueOf = handoffs.find((h) => Number.isInteger(h.issue))?.issue ?? null;
  const unbound = { review: 0, gates: 0, self_gate: 0, budget: 0 };

  // ── Contract (claim): the latest plan handoff's done_when. ──
  const plans = handoffs.filter((h) => h.stage === "plan").sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  const plan = plans.at(-1)?.data ?? null;
  const doneWhen = Array.isArray(plan?.done_when) ? plan.done_when.filter((w) => w && typeof w === "object") : null;
  const contract = (doneWhen ?? []).map((w) => {
    const kind = w.check?.kind ?? (w.verify ? "test" : null);
    const ref = w.check?.ref ?? w.verify ?? null;
    return { id: String(w.id ?? ""), test: ref == null ? null : String(ref), kind: kind == null ? null : String(kind), source: "claim" };
  });
  const doneWhenTests = doneWhen ? contract.filter((c) => c.kind === "test" && c.test).length : null;

  // ── Self-gate (record): the last bound self-gate-detail line. ──
  const { selfGateLines } = parseRecordEvidence(recordText ?? "");
  const self = bindLines(selfGateLines, {
    known, stages, kind: "self_gate",
    idOf: (l) => ({ runner: l.runner ?? null, run_id: l.run_id ?? null }),
    keyOf: (l) => JSON.stringify({ ...l, section: undefined }),
  });
  unbound.self_gate = self.rejected;
  const sg = self.bound.at(-1) ?? null;
  const selfGate = sg ? {
    run_id: sg.run_id == null ? (runIdOfRunner(sg.runner) ?? null) : String(sg.run_id),
    ran: Array.isArray(sg.ran) ? sg.ran.map(String) : [],
    skipped: Array.isArray(sg.skipped) ? sg.skipped.map((s) => ({ check: String(s?.check ?? ""), reason: String(s?.reason ?? "") })) : [],
    blocked: sg.blocked === true,
  } : null;

  // ── Review rounds (record): bound review-evidence lines. ──
  const rv = bindLines(parseReviewEvidenceAll(recordText ?? ""), {
    known, stages, kind: "review",
    idOf: (r) => ({ runner: r.runnerId, run_id: r.runId }),
    keyOf: (r) => JSON.stringify([r.headSha, r.round, r.decision, r.verdicts, r.qaManifest ?? null, r.qaClaims ?? null]),
  });
  unbound.review = rv.rejected;
  const review = [];
  for (const r of rv.bound) {
    review.push({ round: r.round, decision: r.decision, verdicts: r.verdicts ? r.verdicts.split(",") : [], run_id: r.runId, head: String(r.headSha).slice(0, 7), source: "record" });
  }

  // ── Must fix (claim): every must_fix of every valid review handoff. A rework response (PR comment) answers only the review
  // round it follows — the latest review handoff created before it, VALID OR NOT — because reviewers renumber ids (cf1,
  // cf2…) every round; within that round the first response naming the id answers it. A response whose round's handoff
  // fails validation answers nothing: binding it to the round before would put a later round's sha on an earlier row. ──
  const allReviews = handoffs.filter((h) => h.stage === "review")
    .map((h) => ({ h, since: Date.parse(h.createdAt ?? ""), valid: validate("review.v1", h.data).ok }))
    .sort((a, b) => (Number.isFinite(a.since) ? a.since : 0) - (Number.isFinite(b.since) ? b.since : 0));
  const reviews = allReviews.filter((r) => r.valid);
  const answersFor = new Map(reviews.map((r) => [r, []]));
  for (const resp of logins.ok ? reworkResponses(prFactory, issueOf) : []) {
    if (resp.at == null) continue;
    const own = allReviews.filter((r) => Number.isFinite(r.since) && r.since < resp.at).at(-1);
    if (own?.valid) answersFor.get(own).push(resp);
  }
  const mustFix = [];
  for (const r of reviews) {
    for (const v of r.h.data.verdicts) {
      for (const m of Array.isArray(v.must_fix) ? v.must_fix : []) {
        let status = null, commit = null;
        if (logins.ok) {
          const answer = answersFor.get(r).map((x) => x.responses.find((y) => y?.id === m.id)).find(Boolean);
          status = "unanswered";
          if (answer?.status === "fixed") { status = "fixed"; commit = SHA.test(answer.commit) ? answer.commit.slice(0, 7).toLowerCase() : null; }
          else if (answer?.status === "disputed") status = "disputed";
        }
        mustFix.push({ id: String(m.id), round: r.h.data.round, role: String(v.role), claim: String(m.claim ?? ""), status, commit, source: "claim" });
      }
    }
  }
  const mustFixCount = reviews.length ? mustFix.length : null;
  const split = logins.ok && mustFixCount != null
    ? { fixed: mustFix.filter((m) => m.status === "fixed").length, disputed: mustFix.filter((m) => m.status === "disputed").length, unanswered: mustFix.filter((m) => m.status === "unanswered").length }
    : null;

  // ── Gates (this run): the value passed in. Record FACTORY_GATES lines carry no run id: never rendered, all counted. ──
  for (const raw of String(recordText ?? "").split("\n")) if (GATES_LINE.test(raw.trimEnd())) unbound.gates += 1;
  const g = gates && typeof gates === "object" ? gates : null;
  const gatesRow = g ? {
    level: g.level ?? null, status: g.status ?? null, passed: g.passed ?? null, failed: g.failed ?? null,
    failing: Array.isArray(g.failing) ? g.failing.map(String) : [], rerun: gatesRerun === true,
  } : null;

  // ── Proof (record): the bound self-gate-detail line's `mutation` check — the PR-level "new tests fail when the code they
  // guard is mutated" check — plus the advisory count on the ok line in front of it. Ran, nothing blocked AND 0 advisory
  // findings → the plan's done_when tests count as proven (a claim count, gated by this record); anything else → 0. ──
  const mutationSkip = selfGate?.skipped.find((s) => s.check === "mutation") ?? null;
  const proof = selfGate ? {
    run_id: selfGate.run_id,
    mutation: selfGate.ran.includes("mutation") ? "ran" : mutationSkip ? `skipped (${mutationSkip.reason})` : "not run",
    blocked: selfGate.blocked,
    advisory: selfGateAdvisory(recordText, sg),
  } : null;
  if (proof) proof.proven = proof.mutation === "ran" && !proof.blocked && proof.advisory === 0;
  const provenTests = proof && doneWhenTests != null ? (proof.proven ? doneWhenTests : 0) : null;

  // ── Cost & time: the latest run-bound `budget: lifetime` line; queue → now from transition comments; runs = heartbeat-known
  // runners. ──
  const budgetBound = boundBudget(recordText, { known, stages });
  unbound.budget = budgetBound.rejected;
  const cost = budgetBound.cost;
  // Queue time: the earliest `→ factory:queue` transition that HAPPENED. lib/transition.js posts its transition comment before
  // the label swap and cancels it with a `factory-transition-failed:v1` comment when the swap fails, and
  // `countedTransitionIndices` is the engine's one reader of that rule (round counting uses it too). Comments are taken in
  // time order, because the failed marker cancels the transition right before it.
  const timed = cs.map((c, i) => ({ c, i, t: at(c) })).filter((x) => x.t != null).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.c);
  const queuedIdx = countedTransitionIndices(timed, "factory:queue", { honourFailed: true })[0];
  const queuedAt = queuedIdx == null ? null : at(timed[queuedIdx]);
  const nowMs = now == null ? null : (typeof now === "number" ? now : Date.parse(String(now)));
  const elapsedMs = queuedAt != null && Number.isFinite(nowMs) && nowMs >= queuedAt ? nowMs - queuedAt : null;
  // runs = the heartbeat-named runners, read through parseHeartbeat (heartbeatStages) — the same parser that binds every record row.
  const runs = stages.size ? stages.size : null;

  const rejected = typeof reason === "string" && reason.trim() ? reason.trim() : null;

  // ── Render. ──
  const out = [EVIDENCE_HEADING, "", "_Assembled by the factory runner from run records, handoff comments and this merge run's own gate result — no agent prose. **record** = a runner-written line bound to a heartbeat-known run; **live** = a value this merge run computed itself and passed in (its gate result, its hand-off reason); **claim** = taken from an agent-written handoff comment._"];
  const head = [];
  if (mustFixCount != null) head.push(`must_fix raised by review: ${mustFixCount} (claim — review handoffs${split ? `; fixed ${split.fixed}, disputed ${split.disputed}, unanswered ${split.unanswered}` : ""})`);
  if (doneWhenTests != null) head.push(`done_when tests: ${doneWhenTests} (claim — plan handoff)`);
  if (provenTests != null) head.push(`proven tests: ${provenTests} of ${doneWhenTests} (claim count — plan handoff; ${proof.proven ? "counted only because" : "0 because"} self-gate run ${escapeCell(proof.run_id ?? "?")} recorded: ${escapeCell(proofText(proof))} — no per-test result is recorded)`);
  if (head.length) out.push("", `**${head.join(" · ")}**`);

  const contractLines = [];
  if (contract.length) {
    contractLines.push("| done_when | check | source |", "| --- | --- | --- |");
    for (const c of contract) contractLines.push(`| ${escapeCell(c.id)} | ${escapeCell(c.test == null ? "" : c.kind && c.kind !== "test" ? `${c.test} (${c.kind})` : c.test)} | claim |`);
  }
  const contractFacts = [];
  if (proof) contractFacts.push(`- new-test proof (self-gate run ${escapeCell(proof.run_id ?? "?")}): ${escapeCell(proofText(proof))} — record`);
  if (selfGate) {
    const ran = selfGate.ran.length ? `ran ${selfGate.ran.map(escapeCell).join(", ")}` : "ran nothing";
    const skipped = selfGate.skipped.length ? `; skipped ${selfGate.skipped.map((s) => `${escapeCell(s.check)} (${escapeCell(s.reason)})`).join(", ")}` : "";
    contractFacts.push(`- self-gate (run ${escapeCell(selfGate.run_id ?? "?")}): ${ran}${skipped}; ${selfGate.blocked ? "blocked" : "not blocked"} — record`);
  }
  if (contractLines.length || contractFacts.length) out.push("", "### Contract", ...(contractLines.length ? ["", ...contractLines] : []), ...(contractFacts.length ? ["", ...contractFacts] : []));

  if (review.length) {
    out.push("", "### Review", "", "| round | decision | verdicts | run | source |", "| --- | --- | --- | --- | --- |");
    for (const r of review) out.push(`| ${r.round ?? "?"} | ${escapeCell(r.decision)} | ${r.verdicts.map(escapeCell).join(", ")} | ${escapeCell(r.run_id)} | record |`);
  }
  if (mustFix.length) {
    out.push("", "### Must fix", "", "| must_fix | round · role | response | source |", "| --- | --- | --- | --- |");
    for (const m of mustFix) {
      const resp = m.status === "fixed" ? (m.commit ? `fixed in \`${m.commit}\`` : "fixed (no commit sha)") : m.status;
      out.push(`| ${escapeCell(m.id)} | ${m.round} · ${escapeCell(m.role)} | ${resp} | claim |`);
    }
  }
  if (!logins.ok) {
    out.push("", `_Nothing from issue or PR comments is shown — no handoff, heartbeat, rework response or transition, and so no run-record line bound through a heartbeat: the factory's logins could not be resolved (${escapeCell(logins.reason, { max: 400 })}), so no comment can be attributed to the factory._`);
  }
  if (gatesRow) {
    out.push("", "### Gates (this merge run)", "",
      `- level=${escapeCell(gatesRow.level)} status=${escapeCell(gatesRow.status)} passed=${escapeCell(gatesRow.passed)} failed=${escapeCell(gatesRow.failed)} failing=${escapeCell(list(gatesRow.failing))} — rerun: ${gatesRow.rerun ? "yes (first run RED outside the PR diff, re-run once)" : "no"} — live (this merge run's gate result)`);
  }
  if (rejected) out.push("", "### Rejected / hand-off", "", `- ${escapeCell(rejected)} — live (this merge run's hand-off reason)`);
  const costRows = [];
  if (cost) costRows.push(`- lifetime cost: $${cost.usd.toFixed(2)} / $${cost.cap} cap over ${cost.runs} run(s) — record: budget: line of run ${escapeCell(cost.run_id)} (${escapeCell(cost.stage)}), bound by its section's heartbeat-known runner (one budget story per run)`);
  if (elapsedMs != null) costRows.push(`- queued → now: ${fmtElapsed(elapsedMs)} (transition comment timestamps)`);
  if (runs != null) costRows.push(`- runs (heartbeats): ${runs}`);
  if (costRows.length) out.push("", "### Cost & time", "", ...costRows);
  const ignored = unbound.review + unbound.self_gate + unbound.budget;
  if (ignored) out.push("", `_${ignored} run-record line(s) not bound to a heartbeat-known run were ignored._`);
  if (unbound.gates) out.push("", `_${unbound.gates} gate-verdict line(s) in the run record were not used — they carry no run id; the gates row is this merge run's own result._`);

  return {
    markdown: out.join("\n"),
    data: {
      pr: pr ?? null,
      headline: { must_fix: mustFixCount, done_when_tests: doneWhenTests, proven_tests: provenTests },
      must_fix_split: split,
      logins: logins.ok ? { ok: true } : { ok: false, reason: logins.reason },
      contract, proof, self_gate: selfGate, review, must_fix: mustFix,
      gates: gatesRow, rejected, cost: cost ? { usd: cost.usd, cap: cost.cap, runs: cost.runs, run_id: cost.run_id } : null, elapsed_ms: elapsedMs, runs, unbound,
    },
  };
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** One runner section: START … END with no other START inside (an orphan START is author text, not a boundary). */
const PAIR = new RegExp(`${reEsc(EVIDENCE_START)}(?:(?!${reEsc(EVIDENCE_START)})[\\s\\S])*?${reEsc(EVIDENCE_END)}`, "g");

/**
 * START + markdown + END, cut at a line boundary to fit `budget` characters, with a visible notice when cut. When not even
 * the markers and the notice fit (the author's own text already fills the body), there is no in-limit section to write:
 * → `{ section: null, overflow: true }` — never an over-limit section labelled "truncated".
 */
function wrapSection(markdown, budget, max) {
  const md = String(markdown ?? "");
  const full = `${EVIDENCE_START}\n${md}\n${EVIDENCE_END}`;
  if (full.length <= budget) return { section: full, truncated: false, overflow: false };
  const notice = (k) => `\n\n_Factory evidence truncated: showing ${k} of ${md.length} characters to fit GitHub's ${max}-character body limit._`;
  const fixed = EVIDENCE_START.length + EVIDENCE_END.length + 2 + notice(md.length).length;
  if (budget < fixed) return { section: null, truncated: false, overflow: true };
  const room = budget - fixed;
  let kept = md.slice(0, room);
  const nl = kept.lastIndexOf("\n");
  kept = room >= md.length ? md : (nl > 0 ? kept.slice(0, nl) : "");
  return { section: `${EVIDENCE_START}\n${kept}${notice(kept.length)}\n${EVIDENCE_END}`, truncated: true, overflow: false };
}

/**
 * The PR body with exactly one runner section. An existing marked section is replaced **in place** (text before and after
 * it stays byte-identical); any further marked sections are removed; with none, the section is appended after a blank
 * line. A bare `## Factory evidence` heading without the markers is author text and is left alone. The section is cut to
 * keep the whole body within `max` characters — deterministically and with a visible notice. → `{ body, truncated }`, or
 * `{ body: null, truncated: false, overflow: true }` when the text outside the section leaves no room for one (the caller
 * reports that as a failure; it does not write).
 */
export function applyEvidenceSection(body, markdown, { max = PR_BODY_MAX_CHARS } = {}) {
  const src = String(body ?? "");
  const found = [...src.matchAll(PAIR)];
  const insideLen = found.reduce((n, m) => n + m[0].length, 0);
  const sep = found.length || !src ? "" : (src.endsWith("\n\n") ? "" : src.endsWith("\n") ? "\n" : "\n\n");
  const { section, truncated, overflow } = wrapSection(markdown, max - (src.length - insideLen) - sep.length, max);
  if (overflow) return { body: null, truncated: false, overflow: true };
  if (!found.length) return { body: `${src}${sep}${section}`, truncated };
  let i = 0;
  return { body: src.replace(PAIR, () => (i++ === 0 ? section : "")), truncated };
}

/** The marked issue comment (posted once after a merge). */
export function evidenceComment(markdown, { max = PR_BODY_MAX_CHARS } = {}) {
  return applyEvidenceSection("", markdown, { max }).body;
}

/** Has the runner's marked evidence comment already been posted? (A bare heading is not the marker.) */
export function hasEvidenceComment(comments) {
  return (Array.isArray(comments) ? comments : []).some((c) => String(c?.body ?? "").startsWith(EVIDENCE_START));
}
