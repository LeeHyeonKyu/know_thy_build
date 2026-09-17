# Factory Review Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut factory time/tokens by raising implementer first-draft quality (so review passes in fewer rounds) and scaling review to each diff's blast radius — without weakening the reviewers.

**Architecture:** The plan stage emits one *acceptance contract* (done_when → level + runnable check + rubric) consumed by implement (as a pre-handoff self-gate), review (as its rubric), and merge (as evidence). Review roster/level and re-review scope derive from the diff's blast radius. Deterministic failures get one in-run repair before a new round; a blocked issue is never re-reviewed until it clears.

**Tech Stack:** Node 22 ESM, vitest; factory libs under `factory/lib/**`, stage entry `factory/bin/run-stage.js`, workflows `templates/factory/claude/workflows/*.js`, agent prompts `templates/factory/claude/agents/*.md`, `.factory`/`.claude` are generated mirrors.

**Spec:** `docs/superpowers/specs/2026-09-18-factory-review-efficiency-design.md`

## Global Constraints

- **Reviewers are never weakened.** Round-1 review remains a full panel at the diff's tier; adversarial framing, must_fix authority, and depth are unchanged. Only *re-review* is scoped, and a final full-tree correctness sanity is always kept before merge (spec §6).
- **Deterministic before probabilistic.** Gates and the self-gate's runnable checks run before any LLM review; a red deterministic check never reaches a reviewer.
- **Mirrors are generated once by the controller.** Do NOT run `factory init --upgrade` inside a task; copy touched `factory/lib`/`factory/bin`/`templates` files into `.factory`/`.claude` so `self-mirror.test.js` stays green, and let the controller regenerate once at integration (see `[[integration-merge-discipline]]`).
- **Three transition locks hold.** No new field (contract, tier, self-gate verdict) may arrive from the CLI `parseTransitionArgs`; producers are the stages only (audit ADR-023 §1).
- **Blast-radius tier is a floor, not a ceiling** — triage/owner may raise it; the computed value only prevents under-provisioning risk and over-provisioning docs.
- **Every task pins a regression** from the 2026-09-14/15 dogfood: name it in the task and add the guard test.
- Commit trailers per the session's current attribution. One resolver for tier/blast-radius shared by triage, verify-stage, and merge — never two.

---

### Task 1: Acceptance contract in the plan handoff (Structure A)

**Files:**
- Modify: `factory/lib/handoff.js` (plan.v1 schema) — add `done_when[].check` and `done_when[].rubric`
- Modify: `templates/factory/claude/workflows/factory-plan.js` (emit them) and `templates/factory/claude/agents/*plan*` prompt
- Modify: `factory/lib/verify-stage.js` (plan validator: contract completeness)
- Test: `factory/test/verify-stage.test.js`, `factory/test/handoff.test.js`

**Interfaces:**
- Produces: each `done_when` item becomes `{ id, level, ui?, covers?, check: { kind: "test"|"gate"|"finish"|"rubric", ref: string }, rubric: string }`. `check.kind:"test"` → `ref` is a test name; `"gate"` → a gate name; `"finish"` → graded by the qa manifest; `"rubric"` → no self-runnable check, reviewer-judged only.
- Consumes (later tasks): implement reads `check`+`rubric` (Task 3), review grades against `rubric` (Task 7), merge already reads the qa manifest (ADR-024).

- [ ] **Step 1:** Write the failing test — a plan handoff whose `done_when` item has no `check` and no `rubric` fails the plan validator with `acceptance contract incomplete: <id>`.
- [ ] **Step 2:** Run it; expect FAIL (rule not present).
- [ ] **Step 3:** Extend the plan.v1 schema and the validator: every `done_when` id must carry a `check` and a `rubric`; a `check.kind:"test"` ref must name a test that Task 3 can run.
- [ ] **Step 4:** Update `factory-plan.js` to emit the contract and the planner prompt to write it (one line: "each done_when carries how it is checked and the one-line bar a reviewer applies").
- [ ] **Step 5:** Run the suite; green. **Regression pinned:** a plan that names a risk but no gate for it (demo #2 nine-round cause; audit Task 9) still fails — extend, don't replace, the existing `dissent without done_when` rule.
- [ ] **Step 6:** Mirror touched files; commit.

### Task 2: Repo conventions digest for implement (Structure C)

**Files:**
- Create: `factory/lib/house-rules.js` (`buildHouseRules({ root, charter, harness }) → string`)
- Modify: `factory/bin/run-stage.js` (implement context assembly), `templates/factory/claude/agents/factory-builder.md`
- Test: `factory/test/house-rules.test.js`

**Interfaces:**
- Produces: a bounded digest (build/run/test recipes from `[commands]`/`[runtime]`, `[load_bearing]` paths, and a "correct change here must…" list mined from CHARTER `## Preserve`/NEVER_AUTOMATE and any `CLAUDE.md`). Handed to the builder in its cold-read context, role-filtered like `context.<role>.json`.

- [ ] **Step 1:** Failing test — `buildHouseRules` on a fixture harness with `[load_bearing]` + a CHARTER `## Preserve` returns a digest naming the run recipe and each load-bearing path.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3:** Implement `buildHouseRules`; bound its size (truncate with a pointer, like the cold-read loader).
- [ ] **Step 4:** Wire into the implement stage's context and reference it in the builder prompt ("before writing, read the house rules; a change that breaks a Preserve/load-bearing invariant is a defect").
- [ ] **Step 5:** Green. **Regression pinned:** own-calendar R2 cf1/cf2 — a fixture where the recipe omits a required step (a migrate-like command) surfaces in the digest.
- [ ] **Step 6:** Mirror; commit.

### Task 3: Implement self-gate before handoff (Structure B)

**Files:**
- Create: `factory/lib/self-gate.js` (`runSelfGate({ root, harness, contract, roster, tier, run }) → { ok, findings, ranChecks }`)
- Modify: `factory/bin/run-stage.js` (implement path: gate before `awaiting-review` transition), `templates/factory/claude/agents/factory-builder.md`, `templates/factory/claude/workflows/factory-implement.js`
- Test: `factory/test/self-gate.test.js`, `factory/test/run-stage.test.js`

**Interfaces:**
- Consumes: the acceptance contract (Task 1), house rules (Task 2), regression pins (Task 5).
- Behaviour: run the deterministic half (gates for the tier, `finish()` against the contract, prove-test, mutation check from Task 4). If any red → the stage does not transition to `awaiting-review`; it either loops the builder once (H, Task 9) or declares `harness_needed`. Then one adversarial self-critique pass using the tier's reviewer rubric (docs = in-process final turn; load-bearing = a spawned skeptic within `max_turns`, ADR-020 O25). Findings the builder cannot resolve are attached to the handoff so the reviewer starts ahead.

- [ ] **Step 1:** Failing test — implement produces a handoff whose new guard test is not fail-closed; `runSelfGate` (with the mutation check) returns `ok:false` naming the assertion, and the stage does not reach `awaiting-review`.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3:** Implement `runSelfGate` deterministic half + wire the pre-handoff block in `run-stage.js`.
- [ ] **Step 4:** Add the adversarial self-critique pass (rubric-framed), tier-scaled; keep it inside the stage turn budget.
- [ ] **Step 5:** Green. **Regressions pinned:** own-cal R1 cf1 (fail-closed guard), KTB #18 R3 (`finish()` exit-0 — self-gate runs `finish()` and sees exit 1). Cost note in the test file: a self-gate run must be cheaper than a review round.
- [ ] **Step 6:** Mirror; commit.

### Task 4: New-test mutation check (Structure D')

**Files:**
- Create: `factory/lib/mutation-check.js` (`checkNewTestsFailOnMutation({ root, newTests, run }) → { ok, survivors }`)
- Modify: `factory/lib/self-gate.js` (call it), `templates/factory/factory/harness.toml` comment
- Test: `factory/test/mutation-check.test.js`

**Interfaces:**
- Consumes: the set of new/changed test files (from the diff since BASE).
- Behaviour: for each new assertion, apply a cheap structural mutation to its asserted target and confirm the test goes red; a test that stays green under mutation is a `survivor` (a test that asserts nothing). Deterministic, no LLM.

- [ ] **Step 1:** Failing test — a guard test that passes whether or not the property holds is reported as a survivor.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3:** Implement the mutation check (reuse prove-test's worktree machinery; this is its dual — "test fails when the property is violated" vs "test fails without the impl").
- [ ] **Step 4:** Green. **Regression pinned:** own-cal R1 cf1 (deleting the warning still passed 5/5). Document the limits (structural, under-fires) in the harness comment.
- [ ] **Step 5:** Mirror; commit.

### Task 5: Regression pinning across rework (Structure D)

**Files:**
- Modify: `factory/lib/verify-stage.js` (rework handoff carries must_fix as pins), `factory/bin/run-stage.js` (implement dispatch context), `factory/lib/self-gate.js` (treat pins)
- Test: `factory/test/verify-stage.test.js`, `factory/test/self-gate.test.js`

**Interfaces:**
- Produces: on `→ rework`, each must_fix becomes a `{ id, guard: { kind, ref } | null, text }` carried in the rework handoff and re-checked by the next self-gate. Guardable findings (a test) are a hard gate; prose findings are advisory checklist lines (spec §8 Q5).

- [ ] **Step 1:** Failing test — after a rework carrying must_fix `X` with a test guard, the next implement handoff is blocked by the self-gate if `X`'s guard is red (i.e. it regressed).
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3:** Implement pin capture in the rework handoff and pin evaluation in the self-gate; advisory-only for non-guardable pins (no unsatisfiable loop).
- [ ] **Step 4:** Green. **Regression pinned:** KTB #18 R3 (fixing R2 introduced a new false statement under the same ids).
- [ ] **Step 5:** Mirror; commit.

### Task 6: Tier by blast radius + guard-test bump fix (Structure E)

**Files:**
- Modify: `factory/lib/resolve-tier.js` (or wherever `resolveTier`/`tier_effective` lives), `factory/lib/verify-stage.js` (`impact_paths` must agree), `factory/lib/merge-stage.js` (same resolver), `templates/factory/docs/factory/CHARTER.md` (roster note)
- Test: `factory/test/resolve-tier.test.js`, `factory/test/merge-stage.test.js`

**Interfaces:**
- Produces: `tierFromDiff(files, charter) → tier`, one resolver shared by triage, verify-stage, and merge. Rule: files all in `docs/**`/`*.md` **or guard tests that assert only on such files** → `docs`; any `load_bearing` path → force `full`+`deep`; else `standard`. Triage/owner may raise, never lower below the computed floor.

- [ ] **Step 1:** Failing test — a diff of `README.md` + `factory/test/readme-commands.test.js` resolves to `docs`, not `standard`.
- [ ] **Step 2:** Run; FAIL (today it is `standard` — KTB #18 paid $80 for it).
- [ ] **Step 3:** Implement `tierFromDiff`; classify a guard test by what it asserts on (its target files), not by its own path.
- [ ] **Step 4:** Point triage, verify-stage, and merge at the one resolver; assert byte-identical behaviour on non-docs diffs.
- [ ] **Step 5:** Green. **Regression pinned:** KTB #18 (docs issue → docs roster); a diff touching a `load_bearing` path still forces full+deep.
- [ ] **Step 6:** Mirror; commit.

### Task 7: Scoped re-review on rework (Structure F)

**Files:**
- Modify: `factory/lib/review-roster.js` / review roster selection, `factory/bin/run-stage.js` (review path), `factory/lib/verify-stage.js`
- Test: `factory/test/review-roster.test.js`, `factory/test/run-stage.test.js`

**Interfaces:**
- Behaviour: round 1 = full panel at the diff's tier on the full diff. Round R>1 = reviewer set `{rejecting roles} ∪ {roles whose lens the fix delta touches}` on the **fix diff only**, at `tier ≤ prior`. A cheap full-tree correctness sanity runs on the final pre-merge pass regardless. File→lens map (coarse, spec §8 Q4): code→correctness, tests→qa, docs→spec-conformance, interfaces/load_bearing→architecture.

- [ ] **Step 1:** Failing test — a round-2 review where only `qa` rejected runs `qa` (+ the final-pass sanity) on the fix diff, not the 4-role panel on the whole tree.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3:** Implement scoped selection + the file→lens map + the retained final-pass sanity.
- [ ] **Step 4:** Green. **Regression pinned:** own-cal R2 (correctness cf1 and architecture arch1 flagged the same line — the delta-lens map still runs architecture only when the delta touches an architecture-lens path); cross-cutting regression still caught by the final sanity.
- [ ] **Step 5:** Mirror; commit.

### Task 8: No re-review while blocked (Structure G)

**Files:**
- Modify: `factory/bin/run-stage.js` / `factory/lib/sweeper.js` (review guard)
- Test: `factory/test/sweeper.test.js`, `factory/test/run-stage.test.js`

**Interfaces:**
- Behaviour: if the last failure was a product/harness block (`harness_needed`, needs-info parked on a harness issue, or a must_fix marked as a dependency), do not dispatch an LLM review round until the block clears; keep the issue parked and say so.

- [ ] **Step 1:** Failing test — an issue whose last review failed on an unmet harness dependency does not trigger a new review dispatch on the next sweep.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3:** Implement the guard.
- [ ] **Step 4:** Green. **Regression pinned:** KTB #3 spec1×2 (the same "qa evidence absent" re-confirmed by the full panel while blocked on KTB-36/37/40).
- [ ] **Step 5:** Mirror; commit.

### Task 9: In-run repair for deterministic validator failures (Structure H = KTB-51)

**Files:**
- Modify: `factory/bin/run-stage.js` (plan/gates path), `factory/lib/verify-stage.js` (plan validator returns a repair-able reason)
- Test: `factory/test/run-stage.test.js`, `factory/test/verify-stage.test.js`

**Interfaces:**
- Behaviour: a machine-checkable failure (plan validator: dissent without done_when / acceptance contract incomplete; gates false-RED) feeds its reason back to the same agent for exactly one repair turn before a new stage/round or a needs-human escalation. Bounded to one repair to avoid loops.

- [ ] **Step 1:** Failing test — a plan whose only defect is an uncovered dissent gets one repair turn (reason fed back) and, if fixed, proceeds without a needs-human hop.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3:** Implement the one-shot in-run repair; cap at one; escalate as today if still red.
- [ ] **Step 4:** Green. **Regression pinned:** KTB #18 plan R1 (dissent d2/d3 → needs-human → owner retry, all avoidable by one feedback turn).
- [ ] **Step 5:** Mirror; commit.

---

## Execution notes

- **Order:** Task 1 (contract) is the foundation; then 2/4 (inputs to the self-gate), then 3 (self-gate) and 5 (pins); then the review side 6→7→8; then 9. Tasks 1–5 raise draft quality (fewer rounds); 6–8 cut per-round cost; 9 removes an escalation.
- **Build via subagent-driven-development**, worktree per task, task review after each, whole-branch review at the end. Reviewers get the acceptance contract + the named regression as their lens.
- **Do not bundle with KTB-47/48/52/45** — those are separate audit-plan tasks (11/12) and adoption work; this plan is the review-efficiency slice. Ship as its own minor (1.3.1 or 1.4.0).
- **Measure the win:** re-run a docs-shaped issue and a code-shaped issue after landing and compare rounds and $ against this session's baseline (KTB #18 = $143 / 12 stage-runs; own-cal #3 = 4 review rounds). Record in an ADR.

## Self-review (author checklist, done)

- Spec coverage: every structure A–H maps to a task (A→1, B→3, C→2, D→5, D'→4, E→6, F→7, G→8, H→9). ✓
- Each task pins a concrete regression from this session. ✓
- No task weakens round-1 review or removes the final full-tree sanity (Global Constraints). ✓
- One tier/blast-radius resolver shared across stages (Task 6), not two. ✓
- Open questions from spec §8 are surfaced at the tasks that must resolve them (Q1→Task 1, Q2→Task 3, Q3→Task 6, Q4→Task 7, Q5→Task 5). ✓
