import { checkNewTestsFailOnMutation, isWrongReasonRed } from "./mutation-check.js";
import { q } from "./prove-test.js";

/**
 * ── Structure B (review-efficiency plan Task 3 / design §4.B) ──────────────────────────────────
 *
 * `runSelfGate({ root, harness, contract, roster, tier, gates, run, changedTests, changedSources,
 *   qaEvidence, mutation }) → { ok, findings, ranChecks }`
 *
 * The implementer's pre-handoff self-gate. It composes **exactly the checks the review will run
 * DETERMINISTICALLY**, BEFORE the stage transitions to `factory:awaiting-review`, so a diff the
 * reviewer's runnable checks would reject never spends a full multi-reviewer round. The bugs it
 * kills are the two this session pinned:
 *   - own-cal R1 cf1 — a new guard test that asserts nothing (deleting the safety warning still
 *     passed 5/5). The mutation check (Task 4) catches it as a `survivor`.
 *   - KTB #18 R3 — a `finish()`/qa-evidence contract left uncovered by the manifest (exit 1),
 *     which the reviewer would reject as `spec-evidence-missing`.
 *
 * **Deterministic ONLY in this task.** The adversarial self-critique (the LLM half of Structure B)
 * lives in the builder prompt/workflow, not here — this function never calls an LLM. That is the
 * whole point of the cost note: reusing the already-computed `gates`, the already-graded qa
 * manifest, and a structural mutation on the new tests is far cheaper than a review round.
 *
 * **Composed checks:**
 *   1. `gates` — the result the stage ALREADY computed for this run (never re-run). A non-GREEN
 *      verdict is exactly what the reviewer's first deterministic pass would see.
 *   2. `finish()` / qa-evidence against the acceptance contract — graded only when the review WOULD
 *      grade it: the tier roster carries `qa`, OR the contract itself declares a `finish`/`gate`
 *      kind check. A rubric-only contract with no qa is reviewer-judged, not self-runnable
 *      (design §4.B), so the self-gate does not fabricate a check for it. A red / spec-evidence-
 *      missing result blocks and NAMES the uncovered done_when ids.
 *   3. `checkNewTestsFailOnMutation` (Task 4) on the new tests — a `survivor` (a test green under a
 *      cleanly-run mutation) blocks and names the assertion. `misconfigured` (the harness cannot
 *      run a single test) is a harness-class blocking finding the builder cannot fix; `skipped`
 *      tests are advisory (the check deliberately under-fires — never fail-closed on an unjudgeable
 *      test).
 *
 * **Findings** are `{ check, blocking, detail, harness?, ids? }`. `ok` is false iff any finding is
 * blocking. Non-blocking (advisory) findings are attached to the handoff so the reviewer starts
 * ahead. `ranChecks` records which of the three composed checks actually ran (for the run record).
 */

const CONTRACT_KINDS = new Set(["finish", "gate"]);

/**
 * ── Structure D (review-efficiency Task 5) — regression pins carried across rework ──────────────
 *
 * On `→ rework`, each reviewer must_fix is carried as a **pin** `{ id, guard: {kind,ref}|null, text }`
 * (derived in verify-stage.js `deriveReworkPins`). Here the next self-gate RE-RUNS each guardable pin's
 * test BEFORE the handoff, so a fix that silently regressed a prior finding never reaches another full
 * review round (KTB #18 R3: fixing round R's must_fix reintroduced a defect under the SAME id).
 *
 * **A guardable pin (a runnable test) is a HARD gate; a prose pin is advisory only** (spec §9 Q5). The
 * split is exactly `deriveReworkPins`' guard-vs-null, so a prose finding can NEVER create an unsatisfiable
 * loop — there is nothing to run, so nothing can stay red forever.
 *
 * **A red guard blocks ONLY when the red is a real assertion failure.** A guard that cannot even run in
 * this tree (module/parse error, or no test matched the name) is `undecidable`, not a regression — it is
 * surfaced as advisory, never blocking. Fail-closing on a guard we cannot run would resurrect the very
 * unsatisfiable loop the prose/guard split is designed to avoid.
 */
const PIN_CANNOT_RUN = /no test(?:s| files)?\s+(?:found|matched)|does not match|passWithNoTests/i;

/** The command that re-runs a pin's guard test BY NAME (the acceptance contract's `check.ref`, not a
 * file). We hold the test name, not its file, so we filter by name via the harness's per-file test
 * runner — for vitest/jest that is `-t <name>`. No `test_files` command → we cannot run it (advisory). */
function pinGuardCommand(harness, name) {
  const base = harness?.commands?.test_files;
  if (typeof base !== "string" || !base) return null;
  return base.replaceAll("{files}", `-t ${q(name)}`);
}

/**
 * Evaluate carried pins. Guardable pins run their guard test; a real assertion-red is a blocking
 * regression naming the pin id. Prose pins (and un-runnable guards) are advisory only. Returns
 * `{ findings, ran }` — `ran` is true iff at least one guard test was actually executed.
 */
export async function evaluatePins({ pins = [], run, harness, root, cwd = root } = {}) {
  const findings = [];
  let ran = false;
  for (const p of Array.isArray(pins) ? pins : []) {
    if (!p || typeof p !== "object") continue;
    const id = p.id != null ? String(p.id) : "";
    const text = typeof p.text === "string" ? p.text : "";
    const guard = p.guard && typeof p.guard === "object" ? p.guard : null;
    if (!(guard && guard.kind === "test" && typeof guard.ref === "string" && guard.ref.trim())) {
      // Advisory prose pin — surfaced to the builder, never a hard gate (no unsatisfiable loop).
      findings.push({ check: "pin", blocking: false, ids: [id], detail: `checklist pin ${id}: ${text}` });
      continue;
    }
    const ref = guard.ref.trim();
    const cmd = pinGuardCommand(harness, ref);
    if (!cmd || typeof run !== "function") {
      findings.push({ check: "pin", blocking: false, ids: [id], detail: `pin ${id}: guard ${ref} not runnable (no per-file test command) — advisory: ${text}` });
      continue;
    }
    ran = true;
    let r;
    try { r = await run("bash", ["-lc", cmd], { cwd }); }
    catch (e) { findings.push({ check: "pin", blocking: false, ids: [id], detail: `pin ${id}: guard ${ref} could not run — ${e?.message || e}` }); continue; }
    const out = `${r?.stdout || ""}\n${r?.stderr || ""}`;
    if (r?.code === 0) continue;                                       // green — the pinned property still holds
    if (isWrongReasonRed(out) || PIN_CANNOT_RUN.test(out)) {
      // red for the WRONG reason (did not load / no test matched) — undecidable, never a regression.
      findings.push({ check: "pin", blocking: false, ids: [id], detail: `pin ${id}: guard ${ref} could not be evaluated (did not run) — advisory: ${text}` });
      continue;
    }
    findings.push({ check: "pin", blocking: true, ids: [id], detail: `regression: pin ${id} guard ${ref} is red — a prior fix regressed: ${text}` });
  }
  return { findings, ran };
}

/** A compact one-line summary for the run record (`self-gate: <findings>`). */
export const summarizeFindings = (findings = []) =>
  findings.length
    ? findings.map((f) => `${f.blocking ? "" : "(advisory) "}${f.check}: ${f.detail}`).join("; ")
    : "no findings";

/** The advisory (non-blocking) findings — attached to the handoff so the reviewer starts ahead. */
export const advisoryFindings = (findings = []) => findings.filter((f) => !f.blocking);

/** True iff a blocking finding needs a protected-path / harness change the builder cannot make. */
export const harnessFinding = (findings = []) => findings.some((f) => f.blocking && f.harness);

export async function runSelfGate({
  root, harness, contract = [], roster = [], tier = null,
  gates = null, run, changedTests = [], changedSources = [],
  qaEvidence = null,       // function → evidence summary (deferred), or the summary object
  mutation = {},           // fs/tmp passthrough for checkNewTestsFailOnMutation (tests inject doubles)
  pins = [],               // Task 5 — regression pins carried from the prior rework round
} = {}) {
  const findings = [];
  const ranChecks = [];

  // (1) Gates — reuse the already-computed result. Only a schema'd verdict is decisive; a null
  // (unrun / self-reported) gates result is not a finding here — the stage's own gate handling
  // owns that path, and the self-gate never re-runs gates (the cost note).
  if (gates != null && gates.schema === "factory.gates.v1") {
    ranChecks.push("gates");
    if (gates.status !== "GREEN") {
      findings.push({
        check: "gates", blocking: true,
        detail: `gates ${gates.status}${gates.reason ? ` — ${gates.reason}` : ""}`,
      });
    }
  }

  // (2) finish()/qa-evidence against the acceptance contract — only when the review would grade it.
  const rosterHasQa = Array.isArray(roster) && roster.includes("qa");
  const contractHasFinishGate = Array.isArray(contract)
    && contract.some((w) => CONTRACT_KINDS.has(w?.check?.kind));
  if (rosterHasQa || contractHasFinishGate) {
    ranChecks.push("contract");
    let ev;
    try { ev = typeof qaEvidence === "function" ? await qaEvidence() : qaEvidence; }
    catch (e) { ev = { ok: false, reason: `qa evidence unreadable — ${e?.message || e}`, missing: [] }; }
    // `skipped` means the roster genuinely required nothing — not a finding. Anything else that is
    // not ok is the reviewer's `spec-evidence-missing`, named by the uncovered done_when ids.
    if (ev && !ev.ok && !ev.skipped) {
      const ids = Array.isArray(ev.missing) ? ev.missing.filter(Boolean) : [];
      findings.push({
        check: "contract", blocking: true, ids,
        detail: `spec-evidence-missing: ${ev.reason || "acceptance contract not covered by evidence"}`
          + (ids.length ? ` (${ids.join(", ")})` : ""),
      });
    }
  }

  // (3) New-test mutation check (Task 4). Deterministic, no LLM.
  if (Array.isArray(changedTests) && changedTests.length) {
    ranChecks.push("mutation");
    let mut = null;
    try {
      mut = await checkNewTestsFailOnMutation({
        root, newTests: changedTests, changedSources, run, harness, ...mutation,
      });
    } catch (e) {
      // A crash in the check itself is not a builder defect — advisory, never fail-closed.
      findings.push({ check: "mutation", blocking: false, detail: `mutation check could not run — ${e?.message || e}` });
    }
    if (mut) {
      if (mut.misconfigured) {
        // Harness-level: the check cannot run (no per-file test command / base install failed). The
        // builder cannot fix this — flag `harness` so the caller escalates to a human.
        findings.push({
          check: "mutation", blocking: true, harness: true,
          detail: `mutation check misconfigured — ${mut.detail || "the harness cannot run a single test"}`,
        });
      } else {
        for (const s of mut.survivors || []) {
          findings.push({
            check: "mutation", blocking: true,
            detail: `survivor: ${s.file} asserts nothing under mutation (${s.mutation} in ${s.target})`,
          });
        }
        // Skips are informational — the check deliberately under-fires (structural, not semantic).
        for (const sk of mut.skipped || []) {
          findings.push({ check: "mutation", blocking: false, detail: `mutation check skipped ${sk.file}: ${sk.reason}` });
        }
      }
    }
  }

  // (4) Regression pins (Task 5). Guardable pins re-run their guard test; a red guard is a blocking
  // regression naming the pin id. Prose pins are advisory only — no unsatisfiable loop (spec §9 Q5).
  if (Array.isArray(pins) && pins.length) {
    ranChecks.push("pins");
    const { findings: pinFindings } = await evaluatePins({ pins, run, harness, root });
    findings.push(...pinFindings);
  }

  return { ok: !findings.some((f) => f.blocking), findings, ranChecks };
}
