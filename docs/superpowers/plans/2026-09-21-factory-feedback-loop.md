# Factory Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every factory run observable end-to-end and turn its evidence into routed improvement work — harness findings to the using repo, KTB findings to the KTB repo — so the factory improves from measured evidence instead of human memory.

**Architecture:** Stages write durable structured evidence (gate detail, per-role context manifest) to the records branch at run time. The merge-triggered retro classifies each finding by the owner of its causal file (install-manifest `owner: factory|user`), attaches a rich causal payload, dedupes by fingerprint, and routes: `harness` → the using repo's harness issue, `ktb` → a factory-improvement issue in the upstream repo, `ambiguous` → an owner note. A periodic health job aggregates paired behavioural signals and derives a human-readable report. A CLI runs the same engine manually.

**Tech Stack:** Node 22 ESM, vitest; `factory/bin/run-stage.js` (record writer `appendRunRecord`), `factory/bin/retro.js` + `factory/lib/retro/*`, `factory/lib/harness-request.js` (`ensureHarnessIssue`), `factory/cli/manifest.js` (`ownerOf`), `factory/lib/context.js` (`roleContextFor`), `factory/lib/gates.js`, `templates/factory/github/workflows/factory-retro.yml` (`pull_request: closed`).

**Spec:** `docs/superpowers/specs/2026-09-21-factory-feedback-loop-design.md`

## Global Constraints

- **Two targets never conflate.** Every finding carries explicit tags from `{harness, ktb, product, ambiguous}`, decided by the causal file's install-manifest owner; multi-tag allowed; `ambiguous` is never dropped or auto-routed.
- **Durable before ephemeral.** Anything the loop reads must be written to `factory/records` at run time; `gh run download` of 7-day artifacts is an optional enrichment, never a dependency.
- **GitHub-native.** T1 runs inside every stage job; T3 inside the existing merge-triggered retro job; T4 on a schedule; T5 from a laptop. No path requires a local machine.
- **Rich evidence on dogfood.** Owner-owned repos carry the full causal chain. Do not implement privacy trimming or content-free aggregation in this plan (spec §9).
- **Paired metrics only.** No behavioural finding is emitted from an unpaired signal (approve-rate without escaped defects, debate length without delta, cost without risk). Health signals open improvement issues; they never reduce reviewer coverage (ADR-026 owns that).
- **The loop opens issues; it never edits KTB or the harness itself.** Fixes go through the normal SDD/factory path.
- **Mirrors regenerated once by the controller; never `factory init --upgrade` inside a task** (it clobbers factory-appended additive sections — KTB-57). Writers copy touched files into `.factory/`.
- **Three transition locks hold.** No new field reaches `parseTransitionArgs`; producers are stages/retro only.
- **Every task pins a regression from this session's live runs** (named per task) and adds the guard test.
- **Fixtures must be produced by the real producer functions** (`selfGateRetryComment`, `transition.js`'s refusal marker, `gates.js` via `runGates` on a fake runner, `appendRunRecord`, `renderHandoff`), never hand-shaped — and a regression fixture for a real issue must use that issue's REAL comment/record text. T3's first round was green on shapes the producers cannot emit while routing was inverted; this constraint exists so T4/T5 cannot repeat it.
- **Judgments anchor only on runner-recorded, agent-unwritable facts.** Any rule that decides ownership (`harness`/`ktb`), attribution, a per-role verdict, a tier, or "who wrote this" must read: run-bound record lines (`review-evidence:`, `gates-detail:`, `self-gate-detail:` bound via heartbeat `knownRunsFor`/`isBoundLine`), runner-applied labels (`factory:tier-*`), comment `author` vs the factory logins (heartbeat authors + `FACTORY_BOT_LOGIN`; the viewer only under `GITHUB_ACTIONS`), and the install manifest's `ktb_version`. Never: handoff/comment JSON bodies, prose, `docs/factory/runs/**` in the working tree, or the `gh api user` viewer off-Actions. A signal with no runner anchor (currently dead-debate) is **report-only** and never routed upstream. T3 (agent-writable `human-decision`), T4 (verdicts from handoff bodies, agent `tier`), and T5 (viewer as bot, header-time binding) each failed a review round on exactly this; it is now a constraint, not a lesson.
- Commit trailers per the session's current attribution.

---

### Task 1: Durable run-time evidence — gate failure detail + per-role context manifest → run record

**Files:**
- Modify: `factory/lib/gates.js` (expose per-gate failure detail: failing test names + a bounded output snippet), `factory/bin/run-stage.js` (write it via `appendRunRecord`; write the per-role context manifest when `context.<role>.json` is produced), `factory/lib/context.js` (`roleContextFor` returns the manifest of fields it granted)
- Test: `factory/test/gates.test.js`, `factory/test/run-stage.test.js`, `factory/test/context.test.js`

**Interfaces:**
- Produces, in the run record for each stage-run: a `gates-detail:` block per failing gate `{ gate, failing: [test names], snippet }` (bounded, scrubbed via the existing artifact scrubber), and a `context-manifest:` line per role `{ role, cold_read, fields: [...] }`.
- Consumes: the gates result already computed by `runStageGates`; the role context already built by `roleContextFor`.

- [ ] **Step 1:** Failing tests — (a) a RED `unit` gate whose runner output names a failing test yields a `gates-detail` block naming that test with a snippet, in the run record; (b) a review roster of `[correctness, spec-conformance]` yields two `context-manifest` lines, the cold-read one listing only `DONE_WHEN_FIELDS`-filtered fields, the full-ctx one listing the full set.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3:** Implement detail capture in `gates.js` (do not change any gate verdict), manifest capture in `context.js`, both written through `appendRunRecord` in `run-stage.js` (no new writers; runner-only path unchanged).
- [ ] **Step 4:** Green. **Regression pinned:** this session's 7-day artifact loss — the root cause of a gate failure must be readable from the records branch alone with no Actions artifact present (test with the artifact absent).
- [ ] **Step 5:** Mirror; commit.

### Task 2: `classifyFinding()` — causal-file-owner rule, behavioural→ktb rule, payload, fingerprint

**Files:**
- Create: `factory/lib/feedback/classify.js` (`classifyFinding({ finding, ownerOf, ktbVersion }) → { tags, causal, payload, fingerprint, confidence }`), `factory/lib/feedback/fingerprint.js`
- Modify: none in this task (pure lib)
- Test: `factory/test/feedback-classify.test.js`

**Interfaces:**
- Consumes: a raw finding (from a run record / handoff / transition): `{ kind: "gate"|"self-gate"|"transition-refused"|"review-must_fix"|"rehearsal"|"behavioural", stage, round, causal_path?, reason, role?, extra }`; `ownerOf(dest)` from `factory/cli/manifest.js`.
- Produces: `tags` ⊆ `{harness, ktb, product, ambiguous}` (multi allowed); `causal { path, owner, command?, test?, snippet }`; `payload` per spec §6; `fingerprint` = stable hash of `tags + causal.path + normalizedReason` (numbers/shas/issue refs stripped).
- Rules: `owner: user` → `harness`; `owner: factory` → `ktb`; a finding whose reason names a KTB-shipped guidance/default that failed to prevent a harness mistake → add `ktb` alongside `harness`; `kind: "behavioural"` → `ktb` only when `paired === true` (caller asserts pairing); no resolvable causal path → `ambiguous` with both candidates listed; `product` for a must_fix whose causal path is in the using repo's `source_glob`/`test_glob` and not a harness file.

- [ ] **Step 1:** Failing tests, one per regression from this session: (a) **own-cal `test_one` quoting** (causal `.factory/harness.toml`, owner user, reason names the template's "do not add quotes" guidance) → tags `[harness, ktb]`; (b) **KTB #39 self-gate qa-manifest false-block** (causal `.factory/lib/self-gate.js`, owner factory) → `[ktb]`; (c) **KTB #39 `transition refused: plan roles … != roster []`** (causal `.factory/bin/run-stage.js`) → `[ktb]`; (d) **own-cal Flutter toolchain missing** (causal `harness.toml [runtime].setup`) → `[harness]`; (e) a must_fix on `src/app.js` → `[product]`; (f) a finding with no resolvable path → `[ambiguous]` with candidates; (g) same cause on two issue numbers → identical fingerprint; two distinct causes → different fingerprints.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3:** Implement `classifyFinding` + `fingerprint` as pure functions; `ownerOf` injected (real one from `manifest.js`).
- [ ] **Step 4:** Green. **Regression pinned:** (a)–(d) above are the four live findings of this session, each routed to the correct owner.
- [ ] **Step 5:** Mirror; commit.

### Task 3: Retro classify-and-route arm — harness→local, ktb→upstream, ambiguous→note; fingerprint dedupe

**Files:**
- Modify: `factory/bin/retro.js` (new arm), `factory/lib/retro/harvest.js` (extract raw findings from the run record/handoffs/transitions incl. Task 1's `gates-detail`/`context-manifest`), `factory/lib/harness-request.js` (reuse `ensureHarnessIssue` for `harness`), `factory/lib/gh.js` (cross-repo issue create/append), `templates/factory/factory/harness.toml` (`[factory].upstream`, documented), `factory/lib/config.js` (read it)
- Test: `factory/test/retro-route.test.js`, `factory/test/retro-harvest.test.js`, `factory/test/gh.test.js`

**Interfaces:**
- Consumes: the merged issue's run record + comments (+ optional `gh run download` enrichment, never required); `classifyFinding` (Task 2); `harness.factory.upstream` (string | undefined).
- Behaviour: per finding — `harness` → `ensureHarnessIssue({ gh, issue, entries })` in the using repo (existing dedupe); `ktb` → if `upstream` set, `gh.upstreamIssue({ repo: upstream, label: "factory-improvement", fingerprint, payload })` which **appends** to an existing issue carrying the same fingerprint marker (`<!-- factory-improvement fp=<hash> -->`) or opens a new one labelled `factory-improvement` + `backlog`; if `upstream` unset → a local comment on the source issue (no cross-repo write); `ambiguous` → a comment on the source issue listing both candidates + evidence; `product` → nothing (outcome counted by Task 10 metrics).
- Fail-safe: any gh error on the upstream write records an action line and continues (never fails the retro); never opens duplicates for the same fingerprint.

- [ ] **Step 1:** Failing tests — (a) a merged issue whose record has an `[harness]` finding → one harness issue in the using repo, none upstream; (b) a `[ktb]` finding with `upstream` set → one upstream issue with the fingerprint marker + label; a second issue with the same fingerprint → appended, not a new issue; (c) `upstream` unset → local comment only, no cross-repo call; (d) `[ambiguous]` → note with both candidates; (e) upstream gh throws → action error line, retro completes.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3:** Implement the arm + harvest extraction + `gh.upstreamIssue` + config key.
- [ ] **Step 4:** Green. **Regression pinned:** the two demo #39 self-gate defects (Task 2 cases b, c) would have opened ONE upstream factory-improvement issue each (or one combined by fingerprint) instead of being found by a person reading comments.
- [ ] **Step 5:** Mirror; commit.

### Task 4: Periodic health job — paired behavioural aggregates + derived report

**Files:**
- Create: `factory/bin/health.js` (`runHealth({ gh, root, since, N })`), `templates/factory/github/workflows/factory-health.yml` (weekly `schedule` + `workflow_dispatch`; same setup action; runner-only)
- Modify: `factory/lib/retro/harvest.js` (per-role verdict/must_fix/dissent extraction across issues), `factory/bin/retro.js` (reuse `accumulateStats` shapes)
- Test: `factory/test/health.test.js`, `factory/test/yml-lint.test.js`

**Interfaces:**
- Produces, over the last N (default 5, spec §10 Q3) merged issues: per role `{ approve_rate, must_fix_count, ever_rejects, flips }` **paired** with `escaped_defects` attributable downstream; plan `{ debate_delta: done_when added / dissent resolved by the skeptic }`; `{ cost_by_tier, cost_by_role, cost_vs_risk }` (risk from the diff's tier resolver); and behavioural findings `kind: "behavioural", paired: true` handed to `classifyFinding` → routed by Task 3's arm. Emits a derived `factory-health` report (issue/comment, markdown) — the human-readable "conversation."
- Never emits a behavioural finding from an unpaired signal or below N.

- [ ] **Step 1:** Failing tests — (a) a role with 100% approve over N issues AND ≥1 escaped defect attributable → a `[ktb]` behavioural finding (rubber-stamp); the same 100% approve with 0 escaped → NO finding; (b) a plan history where the skeptic never changes done_when → dead-debate finding; where it does → none; (c) a docs-tier diff run on the full panel with cost above the tier baseline → waste finding; (d) fewer than N issues → nothing emitted.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3:** Implement `health.js` + workflow (permissions minimal, no `inputs` in `run:`, scrub + 7-day artifact like the other jobs).
- [ ] **Step 4:** Green. **Regression pinned:** KTB #18 (docs issue on the standard 4-role panel, $80 review) registers as a `cost_vs_risk` waste finding; own-cal #3's 4 review rounds register in `rounds` without a false rubber-stamp finding (its reviewers rejected).
- [ ] **Step 5:** Mirror; commit.

### Task 5: `factory analyze` CLI — same engine, manual path

**Files:**
- Create: `factory/cli/analyze.js`; Modify: `factory/cli/index.js` (dispatch), README "Watching a run" section
- Test: `factory/test/analyze.test.js`, `factory/test/cli-index.test.js`

**Interfaces:**
- `factory analyze <issue>` prints the issue's structured timeline from the records branch (per stage-run: artifact, gates + detail, self-gate, verdicts/must_fix, transitions, cost) and the classified findings with tags; `factory analyze --health` runs Task 4's aggregation locally and prints the report; `--json` for scripts. Reads `gh` for records/comments; never requires Actions artifacts.

- [ ] **Step 1:** Failing test — on a fixture records branch + comments, `analyze 39` prints the self-gate reason, the transition-refused reason, the gates line and the `[ktb]` tags for #39's two defects.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement. **Step 4:** Green. **Regression pinned:** a person can reconstruct demo #39's failure cause from one command instead of 5–7 places. **Step 5:** Mirror; commit.

### Task 6: KTB side — `factory-improvement` label/template; entry into KTB's SDD

**Files:**
- Modify: `factory/lib/bootstrap.js` / label catalog (add `factory-improvement` label), `templates/factory/docs/factory/CHARTER.md` (an "improvement issues" paragraph), `docs/factory/DECISIONS.md` (ADR: the feedback loop, the two targets, the routing, deferred external transport), `.github/ISSUE_TEMPLATE/factory-improvement.md` (KTB repo)
- Test: `factory/test/bootstrap.test.js`, `factory/test/label-catalog.test.js`

**Interfaces:**
- The upstream issue lands as `backlog` + `factory-improvement` (spec §10 Q4: a human decides what the factory works on for itself), carrying the fingerprint marker and the evidence payload; the ADR documents the loop and its cautions (paired metrics, no coverage reduction, no self-modification).

- [ ] **Step 1:** Failing test — bootstrap's label plan includes `factory-improvement`; a fixture upstream issue body parses back to its fingerprint + tags. **Step 2:** FAIL. **Step 3:** Implement + ADR. **Step 4:** Green. **Step 5:** Mirror; commit.

---

## Execution notes

- **Order:** T1 (durable evidence — everything reads it) → T2 (pure classifier) → T3 (retro routing, the loop's core) → T6 (KTB side, so upstream issues have a home) → T4 (health job) → T5 (CLI). T1–T3+T6 is the minimum closed loop; T4/T5 add the behavioural signals and the manual path.
- **Build via subagent-driven-development**, sequential on an integration branch (T1/T3/T4 share `retro.js`/`harvest.js`/`run-stage.js`), worktree per task, task review after each, whole-branch review at the end. Writers `git merge` the integration branch first.
- **Dogfood the loop itself** after shipping: run 2–3 small issues on the demo, then verify the retro actually classified and routed (a deliberate harness misconfig → a harness issue in the demo; a deliberate KTB-side regression fixture → an upstream factory-improvement issue in KTB), and that `factory analyze` reconstructs a failure from one command. Critically review whether the classifications were right and the evidence sufficient to verify causality without reading comments — that is the acceptance test of the whole feature.
- **Ship as 1.4.0** (new capability). Do not bundle with the review-efficiency Phase 2 (gated) or the audit backlog.

## Self-review (author checklist, done)

- Spec coverage: §4 loop → T1 emit, T2 classify, T3 route, T4 health, T5 CLI, T6 KTB side. ✓
- The two targets are separated by a deterministic rule (install-manifest owner) with multi-tag and ambiguous preserved (Global Constraint). ✓
- No task depends on 7-day artifacts (T1 makes the records branch sufficient). ✓
- Paired-metrics constraint enforced in T4's tests (unpaired → no finding). ✓
- Every task pins a live finding from this session (self-gate A/B, own-cal test_one/Flutter, KTB #18 cost, 7-day loss). ✓
- Spec §10 open questions resolved at: Q1→T1 (names only), Q2→T2 (fingerprint normalization), Q3→T4 (N=5), Q4→T6 (backlog). ✓
