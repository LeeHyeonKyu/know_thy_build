import { checkNewTestsFailOnMutation, isWrongReasonRed } from "./mutation-check.js";
import { q } from "./prove-test.js";

/**
 * ── Structure B (review-efficiency plan Task 3 / design §4.B) ──────────────────────────────────
 *
 * `runSelfGate({ root, harness, gates, run, changedTests, changedSources, mutation, pins })
 *   → { ok, findings, ranChecks }`
 *
 * The implementer's pre-handoff self-gate. It composes **the BUILDER-satisfiable checks the review
 * will run DETERMINISTICALLY**, BEFORE the stage transitions to `factory:awaiting-review`, so a diff
 * the reviewer's runnable checks would reject never spends a full multi-reviewer round. The bug it
 * kills at first implement is:
 *   - own-cal R1 cf1 — a new guard test that asserts nothing (deleting the safety warning still
 *     passed 5/5). The mutation check (Task 4) catches it as a `survivor`.
 * plus, on a rework round, KTB #18 R3 (a fix that regressed a prior finding under the SAME id) —
 * caught here only via a carried Task 5 regression pin whose guard test is re-run. #18 R3 itself is
 * caught by REVIEW; the self-gate does not re-derive it.
 *
 * **Scope: builder-satisfiable checks only (Defect A).** qa evidence is NOT graded here. The qa
 * manifest (`.factory/out/qa/<issue>/manifest.json`, `lib/qa-evidence.js`) is written by the qa
 * REVIEWER during the review stage — never by the builder at implement time — so at implement it
 * cannot exist and its absence is EXPECTED, not a defect. Grading it here blocked every standard-tier
 * issue (roster has qa) with `spec-evidence-missing`. qa evidence stays enforced where it belongs:
 * the qa reviewer at review and `qaEvidenceGate` at `factory:approved` (both unchanged).
 *
 * **Deterministic ONLY in this task.** The adversarial self-critique (the LLM half of Structure B)
 * lives in the builder prompt/workflow, not here — this function never calls an LLM. That is the
 * whole point of the cost note: reusing the already-computed `gates` and a structural mutation on the
 * new tests is far cheaper than a review round.
 *
 * **Composed checks:**
 *   1. `gates` — the result the stage ALREADY computed for this run (never re-run). A non-GREEN
 *      verdict is exactly what the reviewer's first deterministic pass would see.
 *   2. `checkNewTestsFailOnMutation` (Task 4) on the new tests — a `survivor` (a test green under a
 *      cleanly-run mutation) blocks and names the assertion. `misconfigured` (the harness cannot
 *      run a single test) is a harness-class blocking finding the builder cannot fix; `skipped`
 *      tests are advisory (the check deliberately under-fires — never fail-closed on an unjudgeable
 *      test).
 *   3. Regression pins (Task 5) — a carried guardable pin whose guard test is re-run; a real red is
 *      a blocking regression, prose pins are advisory only (no unsatisfiable loop, spec §9 Q5).
 *
 * **Findings** are `{ check, blocking, detail, harness?, ids? }`. `ok` is false iff any finding is
 * blocking. Non-blocking (advisory) findings are attached to the handoff so the reviewer starts
 * ahead. `ranChecks` records which of the composed checks actually ran (for the run record).
 */

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
 * this tree (module/parse error, no test matched the name, or a runner that rejected the command) is
 * `undecidable`, not a regression — it is surfaced as advisory, never blocking. Fail-closing on a guard
 * we cannot run would resurrect the very unsatisfiable loop the prose/guard split is designed to avoid.
 *
 * **The guard runs through the harness's OWN named-test contract (`commands.test_one`), not a hardcoded
 * flag.** A pin carries a test NAME (the contract `check.ref`), and `test_one`'s `{file}`+`{name}`
 * placeholders already encode each ecosystem's name-filter (vitest `-t`, Flutter `--plain-name`, pytest
 * `-k`). `{file}` is resolved from the self-gate's changed-test set (the PR's tests, added vs. merge-base,
 * so a prior round's guard test is in it) or the harness `[test].test_glob`. Degrade to ADVISORY when
 * `test_one` is absent, the file can't be resolved, or the command lacks its placeholders. Only when
 * `test_one` is absent AND `test_files` is a recognizably vitest/jest command do we fall back to `-t`
 * (a JS name-filter) — never fabricate `-t` on an unknown runner (own-cal Flutter: `flutter test -t …`
 * → "Could not find an option named -t", which would otherwise mis-score as a real regression).
 */
const PIN_CANNOT_RUN = /no tests?\s+(?:found|matched|ran|to run)|does not match|passwithnotests|could not find an option|unrecognized (?:option|argument)|unknown option|no such option|invalid option|unexpected argument|^usage:/im;
/** A `test_files` command whose runner takes a `-t` name pattern (vitest/jest). Only these may take the
 * `-t` fallback when the portable `test_one` is absent. */
const JS_NAME_FILTER_RUNNER = /\bvitest\b|\bjest\b/i;

/** Quoted `{file}` argument for `test_one`: prefer the PR's changed test files (real paths, added vs.
 * merge-base — includes prior rounds' guard tests), else the harness `[test].test_glob`. null → the
 * guard cannot be located and the caller degrades to advisory. */
function guardFileArg(harness, changedTests) {
  const files = (Array.isArray(changedTests) ? changedTests : [])
    .map((e) => (typeof e === "string" ? e : e?.file))
    .filter((f) => typeof f === "string" && f);
  if (files.length) return files.map(q).join(" ");
  const globs = (harness?.test?.test_glob || []).filter((g) => typeof g === "string" && g);
  if (globs.length) return globs.map(q).join(" ");
  return null;
}

/** The command that re-runs a pin's guard test by NAME through the harness's own contract. Returns null
 * (→ advisory) when no portable path exists — never a fabricated flag on an unknown runner. */
function pinGuardCommand(harness, name, fileArg) {
  const one = harness?.commands?.test_one;
  if (typeof one === "string" && one.includes("{file}") && one.includes("{name}") && fileArg) {
    return one.replaceAll("{file}", fileArg).replaceAll("{name}", q(name));
  }
  // Fall back to `-t` ONLY when there is no test_one AND test_files is a recognizably vitest/jest runner.
  const files = harness?.commands?.test_files;
  if (!one && typeof files === "string" && files.includes("{files}") && JS_NAME_FILTER_RUNNER.test(files)) {
    return files.replaceAll("{files}", `-t ${q(name)}`);
  }
  return null;
}

/**
 * Evaluate carried pins. Guardable pins run their guard test through the harness's named-test contract;
 * a real assertion-red is a blocking regression naming the pin id. Prose pins, un-locatable guards, and
 * runners that cannot express a name filter are advisory only (never blocking → no unsatisfiable loop).
 * Returns `{ findings, ran }` — `ran` is true iff at least one guard test was actually executed.
 */
export async function evaluatePins({ pins = [], run, harness, root, cwd = root, changedTests = [] } = {}) {
  const findings = [];
  let ran = false;
  const fileArg = guardFileArg(harness, changedTests);
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
    const cmd = pinGuardCommand(harness, ref, fileArg);
    if (!cmd || typeof run !== "function") {
      // No portable way to run one named test on this harness (no test_one, non-JS test_files, or the
      // guard file could not be located) → advisory, NEVER a false regression on an unknown runner.
      findings.push({ check: "pin", blocking: false, ids: [id], detail: `pin ${id}: guard ${ref} not runnable on this harness (no named-test command) — advisory: ${text}` });
      continue;
    }
    ran = true;
    let r;
    try { r = await run("bash", ["-lc", cmd], { cwd }); }
    catch (e) { findings.push({ check: "pin", blocking: false, ids: [id], detail: `pin ${id}: guard ${ref} could not run — ${e?.message || e}` }); continue; }
    const out = `${r?.stdout || ""}\n${r?.stderr || ""}`;
    if (r?.code === 0) continue;                                       // green — the pinned property still holds
    if (isWrongReasonRed(out) || PIN_CANNOT_RUN.test(out)) {
      // red for the WRONG reason (did not load / no test matched / the runner rejected the command) —
      // undecidable, never a regression. A malformed/unrecognized runner error lands here, not blocking.
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

/**
 * ── Feedback loop (T3 re-review NEW-MF-1) — **"not run" is a fact, and it has a reason** ─────────
 *
 * `ranChecks` was the only thing the record line carried, so a check's *absence* from a later run
 * was indistinguishable between two opposite situations:
 *   · KTB **withdrew** the check (a new version stopped grading it — that is evidence the check
 *     itself was wrong, and the feedback loop may route the earlier block to KTB), and
 *   · the check simply **had no input** this round (no added tests ⇒ no mutation check; no rework
 *     handoff ⇒ no pins; no schema'd gates result ⇒ no gates check).
 * The second is the cheap adversarial case: a builder blocked by `survivor: test/x.test.js asserts
 * nothing` **deletes that test**, which empties `addedTests`, which drops `mutation` from the next
 * line — and the block it escaped would be relabelled a KTB engine defect. So every check that did
 * not run now says **why**, and the loop treats `no-input` as *not* evidence.
 */
export const SKIP_REASONS = Object.freeze({
  NO_INPUT: "no-input",                 // 이 라운드에 그 검사가 볼 것이 없었다(추가된 테스트 없음 등)
});

export async function runSelfGate({
  root, harness,
  gates = null, run, changedTests = [], changedSources = [],
  mutation = {},           // fs/tmp passthrough for checkNewTestsFailOnMutation (tests inject doubles)
  pins = [],               // Task 5 — regression pins carried from the prior rework round
} = {}) {
  const findings = [];
  const ranChecks = [];
  const skippedChecks = [];
  const skip = (check, why, reason = SKIP_REASONS.NO_INPUT) => skippedChecks.push({ check, reason, detail: why });

  // (1) Gates — reuse the already-computed result. Only a schema'd verdict is decisive; a null
  // (unrun / self-reported) gates result is not a finding here — the stage's own gate handling
  // owns that path, and the self-gate never re-runs gates (the cost note).
  if (gates == null || gates.schema !== "factory.gates.v1") skip("gates", "no schema'd gates verdict in this run");
  if (gates != null && gates.schema === "factory.gates.v1") {
    ranChecks.push("gates");
    if (gates.status !== "GREEN") {
      findings.push({
        check: "gates", blocking: true,
        detail: `gates ${gates.status}${gates.reason ? ` — ${gates.reason}` : ""}`,
      });
    }
  }

  // (2) qa-evidence against the acceptance contract is NOT graded here (Defect A). The qa manifest is
  // written by the qa REVIEWER at the review stage — never by the builder at implement time — so at
  // this point it cannot exist and its absence is expected, not a defect. Enforcing it here blocked
  // every standard-tier issue (roster has qa) with `spec-evidence-missing`. qa evidence remains
  // enforced where it belongs: the qa reviewer at review and `qaEvidenceGate` at `factory:approved`.

  // (3) New-test mutation check (Task 4). Deterministic, no LLM.
  if (!(Array.isArray(changedTests) && changedTests.length)) skip("mutation", "this round added no tests to mutate");
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
  if (!(Array.isArray(pins) && pins.length)) skip("pins", "no regression pins carried into this round");
  if (Array.isArray(pins) && pins.length) {
    ranChecks.push("pins");
    const { findings: pinFindings } = await evaluatePins({ pins, run, harness, root, changedTests });
    findings.push(...pinFindings);
  }

  return { ok: !findings.some((f) => f.blocking), findings, ranChecks, skippedChecks };
}

/**
 * ── Feedback loop (T3 re-review NEW-MF-1) — self-gate 관측의 **기계 계약** ────────────────────────
 *
 * 사람이 읽는 `self-gate: …` 한 줄은 그대로 두고(그 문구는 사람의 것이다), 그 옆에 한 줄 JSON을
 * 더 쓴다 — `gates-detail:`/`context-manifest:`와 같은 모양, 같은 이유다:
 *
 *   `self-gate-detail: {"run_id":…,"runner":…,"ktb_version":…,"blocked":…,"harness":…,
 *                       "ran":[…],"skipped":[{"check":…,"reason":"no-input"}]}`
 *
 * 세 필드가 피드백 루프의 판정 재료다:
 *   · `ran` / `skipped` — "돌지 않았다"와 "**왜** 돌지 않았다"를 가른다(위 `SKIP_REASONS`).
 *   · `ktb_version` — **러너가** 설치 매니페스트(`.factory/install-manifest.json`, 에이전트가 못 쓴다)
 *     에서 읽은 그 런의 팩토리 버전. 검사가 거둬들여졌다는 유일하게 건전한 신호가 이것이다:
 *     빌더는 테스트를 지울 수는 있어도 KTB 버전을 올릴 수는 없다.
 *   · `run_id`/`runner` — 다른 두 줄과 같은 provenance 계약(`docs/factory/runs/**`는 에이전트가
 *     덧붙일 수 있는 경로다). 묶이지 않은 줄은 증거가 아니다.
 */
export const SELF_GATE_DETAIL_PREFIX = "self-gate-detail: ";
export function selfGateDetailLine(result, { runId = null, runnerId = null, ktbVersion = null, harnessBlock = false } = {}) {
  try {
    return SELF_GATE_DETAIL_PREFIX + JSON.stringify({
      run_id: runId ?? null,
      runner: runnerId ?? null,
      ktb_version: ktbVersion ?? null,
      blocked: result?.ok === false,
      harness: Boolean(harnessBlock),
      ran: Array.isArray(result?.ranChecks) ? [...result.ranChecks] : [],
      skipped: (Array.isArray(result?.skippedChecks) ? result.skippedChecks : []).map((s) => ({ check: s.check, reason: s.reason })),
    });
  } catch (e) {
    return `${SELF_GATE_DETAIL_PREFIX}unavailable — ${e?.message || e}`;
  }
}
