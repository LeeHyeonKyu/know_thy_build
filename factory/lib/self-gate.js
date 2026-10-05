import { checkNewTestsFailOnMutation, isWrongReasonRed } from "./mutation-check.js";
import { q } from "./prove-test.js";
import { matchesAny } from "./glob.js";
import { inMirrorFamily } from "./mirror.js";

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
  restartBrief = null,     // #174 — { paths, newFiles, error? } computed by run-stage (`restartBriefInput`); null = no restart
  scope = null,            // #200 — { issue, plan, filesExpected, changes, error? } computed by run-stage (`scopeInput`); null = not wired
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
  // 1.4.28 (L31, own-calendar #43–#47) — **테스트만 바뀐 diff(특성화)에는 지킬 변경이 없다.** 새 supertest 파일은 `../src/app`을
  // 임포트하므로 구조 뮤테이션은 app.ts의 불리언(cors credentials, rate-limit 플래그)을 뒤집었고, 라우트 특성화 테스트는 그것을
  // 볼 수 없어 매번 "survivor"였다 — 서버 테스트 이슈 다섯 개가 전부 첫 구현 턴을 그렇게 잃었다. prove-test가 이미 test-only
  // diff를 특성화로 판정하듯, 뮤테이션 검사도 소스 변경이 없으면 볼 것이 없다(no-input) — 새 테스트가 지키는 것은 이 변경이 아니라
  // 기존 동작이고, 그 검증은 base에서 통과한다는 사실(prove-test)로 이미 끝났다.
  const testOnly = Array.isArray(changedTests) && changedTests.length && !(Array.isArray(changedSources) && changedSources.length);
  if (testOnly) skip("mutation", "test-only diff (characterization): no source change for the new tests to guard — a structural mutation of an imported module proves nothing about tests that pin existing behaviour");
  if (Array.isArray(changedTests) && changedTests.length && !testOnly) {
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

  // (5) #174 — the K self-restart brief. Runs ONLY when a brief is loaded (no brief → nothing here changes, not even a skip
  // entry: the result is the same object as before this check existed). A new file — added vs. merge-base AND absent from the
  // restart head's tree, as run-stage measured it — outside the brief's `where` paths is RED and named. Edits, deletions,
  // files the PR had already added before the restart, and new files the brief names pass. An unreadable restart head or an
  // unparsable brief fails CLOSED (blocking), never "everything allowed".
  if (restartBrief != null) {
    ranChecks.push("restart-brief");
    if (restartBrief.error) {
      findings.push({ check: "restart-brief", blocking: true, detail: `restart brief unusable — ${restartBrief.error} (fail closed: new files cannot be checked against it)` });
    } else {
      const allowed = (Array.isArray(restartBrief.paths) ? restartBrief.paths : []).filter((p) => typeof p === "string" && p);
      // exact paths only — a directory or a prose token in the allow-list must never admit every file under it
      const inBrief = (f) => allowed.includes(f);
      for (const f of Array.isArray(restartBrief.newFiles) ? restartBrief.newFiles : []) {
        if (!inBrief(f)) findings.push({ check: "restart-brief", blocking: true, detail: `new file outside the restart brief: ${f}` });
      }
    }
  }

  // (6) #200 — `scope`: every changed path outside the plan's files_expected carries a `Scope change (#<issue>)` line in the
  // diff. No scope input (null) → nothing here changes, not even a skip entry. No plan / unusable files_expected → skipped,
  // visibly (a quality aid, fail open). A git read failure → a non-blocking finding, never a pass and never BLOCKED.
  if (scope != null) {
    const why = scopeSkipReason(scope);
    if (why) skip("scope", why);
    else {
      ranChecks.push("scope");
      if (scope.error) findings.push({ check: "scope", blocking: false, detail: `scope check could not run — ${scope.error}` });
      else findings.push(...judgeScope(scope));
    }
  }

  return { ok: !findings.some((f) => f.blocking), findings, ranChecks, skippedChecks };
}

/**
 * ── #200 — `scope`: a path outside `files_expected` must carry a "Scope change (#<issue>)" line in the diff ───────────────
 *
 * spec-conformance rejected #149·#156·#157·#170·#178 for exactly this, one whole review round each; the check costs one git
 * read. run-stage (`scopeInput`) reads `git diff --no-renames <merge-base>...HEAD` and hands over every changed path with its
 * status and ONLY the lines that diff added — removed and context lines never arrive, and a line that reached HEAD by merging
 * the base branch is not in `<merge-base>...HEAD` at all. This function only judges.
 *
 * A path P passes when it is
 *   · in scope: `glob.js` `matchesAny(files_expected, P)`, or under an entry ending in `/` (a directory prefix — local to
 *     this check, glob.js is unchanged), or
 *   · runner-written: `mirror.js` `inMirrorFamily(P)` (the same rule, `.claude/hooks/*.sh` special case included) or under
 *     `docs/factory/runs/`, or
 *   · justified in its own added lines: one contains `Scope change (#<issue>)`, or
 *   · named elsewhere: some added line in the diff contains both the token and P as a whole path (`foo.js.bak` does not name
 *     `foo.js`). The issue scoped this route to deleted files; the plan widened it to every outside path, because a JSON
 *     fixture, a lockfile or a binary cannot carry a comment line in its own content.
 * Anything else is one blocking finding per path, naming the path, the exact line and where it may go.
 */
const RUN_RECORDS_PREFIX = "docs/factory/runs/";

/** Why the scope check cannot judge this round, or null when it can. One reader for the dep (which then skips the git
 * read) and the judge (which records the skip) — the reason text is what the run record's `self-gate-detail` line carries.
 * Scope change (#200): dw4 names three fail-open cases (no plan, non-array, empty); two more skip the same visible way —
 * no issue number (dw5: a finding is never said under `#undefined`) and a files_expected entry glob.js cannot match in
 * bounded time (round-1 must_fix cf1/sec1/spec1/qa1: it hung the self-gate). Each names itself in the skip detail, so the
 * run record still tells "not checked (and why)" apart from "nothing out of scope". */
export function scopeSkipReason({ issue, plan, filesExpected } = {}) {
  if (!plan) return "skipped — no plan handoff in this run's context, so there is no files_expected to check against";
  if (!Array.isArray(filesExpected)) return "skipped — files_expected is not an array in the plan handoff";
  if (!filesExpected.some((e) => typeof e === "string" && e.trim())) return "skipped — files_expected is empty in the plan handoff";
  if (!(Number.isInteger(issue) && issue > 0)) return "skipped — this run carries no issue number to look for";
  // A malformed entry skips the whole check, visibly (dropping just that entry would turn the paths it meant to cover into
  // blocking false positives). A skip, not a finding: non-blocking findings are copied into the reviewer handoff (plan
  // non_goals), and the plan's typo is not the builder's defect.
  for (const e of filesExpected.filter((x) => typeof x === "string" && x)) {
    const why = unsafeEntryReason(e);
    if (why) return `skipped — files_expected entry ${JSON.stringify(e)} ${why}, which glob.js cannot match in bounded time`;
  }
  return null;
}

/** `Scope change (#<issue>)` — the exact token. `(#200)` never matches `(#2000)` or `(#199)`: the closing paren is part of it. */
export const scopeChangeToken = (issue) => `Scope change (#${issue})`;

/** Is `files_expected` covering `path`? Its globs through glob.js, plus a trailing-`/` entry as a directory prefix. */
export function inFilesExpected(filesExpected, path) {
  const entries = (Array.isArray(filesExpected) ? filesExpected : []).filter((e) => typeof e === "string" && e);
  if (matchesAny(entries, path)) return true;
  return entries.some((e) => e.endsWith("/") && path.startsWith(e));
}

/** Why glob.js cannot match this plan-authored `files_expected` entry in bounded time, or null when it can (#200 cf1).
 * Before #200 globToRegex only saw operator/contract globs; plan entries are LLM- or comment-authored, and glob.js loops
 * forever on an unclosed `{`, passes a `*`/`?` inside `{…}` to RegExp raw (a SyntaxError for `{*}`, a backtracking quantifier
 * for `{a*a*}`), and backtracks catastrophically on a run of 3+ `*` or on more than MAX_STAR_RUNS `*` runs (four runs
 * against a 250-char path already take ~1 s). Decided here WITHOUT calling glob.js, so a bad entry never reaches it. */
const MAX_STAR_RUNS = 3;
function unsafeEntryReason(entry) {
  let open = false, runs = 0;
  for (let i = 0; i < entry.length; i++) {
    const ch = entry[i];
    if (ch === "{" && !open) open = true;
    else if (ch === "}" && open) open = false;
    else if (open && (ch === "*" || ch === "?")) return `has a \`${ch}\` inside \`{…}\``;
    else if (ch === "*") {
      let n = 1; while (entry[i + n] === "*") n++;
      if (n > 2) return `has a run of ${n} \`*\``;
      runs++; i += n - 1;
    }
  }
  if (open) return "has a `{` with no closing `}`";
  if (runs > MAX_STAR_RUNS) return `has ${runs} \`*\` runs (at most ${MAX_STAR_RUNS})`;
  return null;
}

/** A path the runner wrote, never the builder — the mirror families and the run records. */
export const runnerWrittenPath = (path) => inMirrorFamily(path) || path.startsWith(RUN_RECORDS_PREFIX);

const PATH_CHAR = /[A-Za-z0-9_\-/~]/;
/** Is `path` at `line[i]` delimited as a whole path? */
function wholeAt(line, i, path) {
  const before = i > 0 ? line[i - 1] : "";
  const after = line[i + path.length] ?? "";
  const next = line[i + path.length + 1] ?? "";
  if (before && (PATH_CHAR.test(before) || before === ".")) return false;
  if (after && PATH_CHAR.test(after)) return false;
  if (after === "." && next && (PATH_CHAR.test(next) || next === ".")) return false;
  return true;
}
/** Does `line` name `path` as a whole path? The neighbours must not continue a path: `x/foo.js`, `foo.js.bak` and `foo.jsx`
 * do not name `foo.js`; a sentence's final `.` (end of line or before a space/punctuation) does not count as a continuation.
 * A space ends a path here, so `others` (the other changed paths) resolve a path with a space: where a longer one of them
 * is named at the same spot (`docs/my notes.md`), its space-delimited prefix (`docs/my`) is not. */
export function namesPath(line, path, others = []) {
  if (!path) return false;
  const longer = (Array.isArray(others) ? others : []).filter((q) => typeof q === "string" && q.length > path.length && q.startsWith(path));
  for (let i = line.indexOf(path); i !== -1; i = line.indexOf(path, i + 1)) {
    if (!wholeAt(line, i, path)) continue;
    if (longer.some((q) => line.startsWith(q, i) && wholeAt(line, i, q))) continue;
    return true;
  }
  return false;
}

/** The judgement. `changes`: `[{ path, status, added: string[] }]`. Returns blocking findings, one per unjustified path.
 * Precondition: `scopeSkipReason` returned null for this input (runSelfGate checks it) — that is what keeps a malformed
 * plan entry out of glob.js. */
export function judgeScope({ issue, filesExpected, changes } = {}) {
  const token = scopeChangeToken(issue);
  const rows = (Array.isArray(changes) ? changes : []).filter((c) => c && typeof c.path === "string" && c.path);
  const paths = rows.map((c) => c.path);
  const names = (l, p) => namesPath(l, p, paths);
  const addedOf = (c) => (Array.isArray(c.added) ? c.added : []).filter((l) => typeof l === "string");
  const tokenLines = rows.flatMap((c) => addedOf(c).filter((l) => l.includes(token)));
  // An own token line justifies its host, whatever other path it also names (dw1) — so the finding below, "carries no … line",
  // is only ever said of a path whose own added lines truly carry none (review cf1/spec1/qa1).
  // dw1 over dw2 here, deliberately: dw2's "a reason for one file never silently covers a different file" governs the
  // named-elsewhere route (a line in file X clears Y only by naming Y). A line in P's OWN diff is not silent about P — it sits
  // in P's hunk, where spec-conformance reads it; whether its reason holds is that reviewer's call (plan non_goals: "checks
  // that a line is present, not that the reason holds"). Narrowing it was the round-2 defect cf1/spec1/qa1 rejected.
  const findings = [];
  for (const c of rows) {
    const p = c.path;
    if (runnerWrittenPath(p) || inFilesExpected(filesExpected, p)) continue;
    if (addedOf(c).some((l) => l.includes(token))) continue;
    if (tokenLines.some((l) => names(l, p))) continue;
    findings.push({
      check: "scope", blocking: true,
      // The check name is the summary's prefix (`summarizeFindings` → `scope: <P> is outside …`), so the detail starts at P.
      detail: `${p} is outside files_expected and carries no "${token}" line — add a line containing "${token}: <why — the done_when, non_goal or must_fix it serves>" to ${p}${c.status === "D" ? " (it is deleted: put the line, naming this path, in another changed file)" : ", or put that line naming this exact path in another changed file (for a deleted, JSON or binary file)"}`,
    });
  }
  return findings;
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
      // #200 — a `scope` skip also carries its `detail` (which of no plan / empty / non-array files_expected it was): `reason`
      // alone ("no-input") cannot tell those apart in the record. Other checks keep their two-field entries (readers and the
      // exact-equality tests on them are unchanged); readers ignore unknown fields.
      skipped: (Array.isArray(result?.skippedChecks) ? result.skippedChecks : []).map((s) => ({ check: s.check, reason: s.reason, ...(s.check === "scope" && typeof s.detail === "string" ? { detail: s.detail } : {}) })),
    });
  } catch (e) {
    return `${SELF_GATE_DETAIL_PREFIX}unavailable — ${e?.message || e}`;
  }
}
