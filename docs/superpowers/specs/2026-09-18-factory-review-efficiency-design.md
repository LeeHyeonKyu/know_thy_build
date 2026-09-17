# Factory Review Efficiency — Design

**Status:** design, ready for planning (not started)
**Author:** owner + Claude, 2026-09-18
**Related:** `docs/superpowers/specs/2026-09-10-factory-design.md` (§5 gates, §7 review, tiers/roster), `docs/superpowers/plans/2026-09-14-factory-audit-hardening.md` (Tasks 11/12 = KTB-47/48), `docs/factory/DECISIONS.md` (ADR-020, ADR-023, ADR-024, ADR-025)

## 1. Problem

Dogfooding 1.2–1.3 cost far more time and tokens than the work warranted. The owner asked whether the cause is agents carrying too little context, agents not knowing the rules, or a specific recurring failure path. Measurement answered it.

### 1.1 What it actually cost (measured, this session)

`KTB #18` was a **documentation issue** — edit `README.md` to match 1.3.0 — and it cost **~$143 across 12 stage-runs**:

| stage | runs | cost |
|---|---|---|
| review | 3 | $80.25 (56%) |
| implement | 4 | $49.68 |
| plan | 3 | $13.54 |

One review run alone was $19.35 / 417 turns; inside it `reviewer-correctness` took 89 turns/$6.33 and `reviewer-qa` 107 turns/$2.82 — on a README diff. Cache-read per stage was 7–27M tokens.

### 1.2 The "too little context" hypothesis is refuted

Agents carry **7–27M cache-read tokens per stage**. The cost is `turns × rounds`, not thin context. What agents lack is not volume but **the right structured context**: the critical checklist the reviewers apply, and the repo's own conventions (see §2).

### 1.3 Review rounds were almost never unnecessary

Every failing review round caught a real defect. Enumerated:

| issue | review rounds (reject role / cause) | nature |
|---|---|---|
| KTB #3 | R1 spec-conformance: qa evidence absent → R2 spec-conformance: **same** absent → R3 approved | both failures blocked by product defects (KTB-36/37/40); re-running the full panel to re-report "still missing" was waste |
| own-calendar #3 | R1 correctness (cf1 safety guard not fail-closed, mutation-proven; cf2 README→empty env doc) → R2 correctness (client cmd → **production API**; server won't boot, missing `prisma migrate`) + architecture (same line) → R3 spec-conformance (safety warning placed after the command vs done_when "before") → R4 approved | every round a distinct, serious real defect; review necessary; cost = implementer produced wrong docs 3× |
| KTB #18 | R1 qa (worked example mixes issue numbers) → R2 correctness+qa (doc still teaches retired claim; five lines from a clean checkout) → R3 correctness+qa (**same ids**: `finish()` exits 0 inside review — false, contradicts 13 lines above) | real defects; R3 was a **regression the implementer introduced while fixing R2**; whole issue is docs but ran the 4-role standard roster |
| KTB #20 | 0 (gates → needs-human → human merge) | protected-path CHARTER edit |

SDD improvement loop (my own subagents building KTB features):

| feature | rounds | why |
|---|---|---|
| KTB-42 | review 2 passes (R1 3 must_fix → fix → re-review 8 resolved + 1 new → fix) | each must_fix real |
| KTB-44 | review 2 passes (R1 5 must_fix → fix → re-review 18 resolved + 2 new → fix) | each must_fix real |
| KTB-46 | **5 writer rounds** + 2 review passes + whole-branch A/B (2+2 must_fix) | each adversarial pass found a new *class* of security bug in the sweeper |

**Conclusion:** cutting review would ship real bugs (production-DB writes, a safety guard that passes when the warning is deleted, a README teaching false commands). The cost is that the **implementer/writer needed 3–5 tries**, each triggering a full review, plus review over-provisioned on low-risk diffs.

## 2. Root cause

1. **Asymmetry.** The reviewer holds the acceptance bar (an adversarial rubric + permission to explore); the implementer holds only the task. It guesses the bar and misses. Every miss is a full review round.
2. **Review runs at full roster × rounds regardless of diff risk.** A README diff and a load-bearing code diff pay the same 4-reviewer panel. A required guard test in the diff even bumps a docs issue out of the `docs` tier into `standard` (KTB #18).
3. **Re-review while blocked.** When the last failure is a product/harness block, the same must_fix re-fires and the full panel re-confirms it (KTB #3 spec1×2).
4. **Deterministic failures escalate to a whole new round.** A plan-validator slip (dissent without done_when) or a false-RED gate spends a fresh stage/round instead of a one-turn repair.
5. **Regressions across fix rounds.** Fixing round N's must_fix introduces round N+1's (KTB #18 R3), because prior findings are not pinned as runnable guards.

## 3. Design principles

- **Reviewers stay maximally critical.** Nothing here weakens review depth or the adversarial stance. We move the *bar* left, we do not lower it.
- **Shift the bar left.** The implementer faces the same acceptance contract the reviewers grade against, before handoff, and actually runs the parts that are runnable.
- **Review scales to blast radius.** Roster, gate level, and re-review scope derive from the diff's risk, computed from files touched — not self-declared, not fixed.
- **Never re-review a block.** If the last failure was a product/harness block, do not spend an LLM review round until the block clears.
- **Deterministic self-repair before escalation.** A machine-checkable failure gets one feedback turn to the same agent before a person or a new round is spent.

## 4. The structures

Each names what it is, where it lives (conceptually), the observed failure it prevents, and its cost tradeoff.

### A. Acceptance contract — one artifact, three consumers
The plan stage emits, per `done_when` id: `level`, a **runnable check** (a test name / gate / `finish` criterion), and a one-line prose rubric. This single artifact is (1) the implementer's pre-handoff checklist, (2) the reviewer's grading rubric, (3) the merge gate's evidence contract. Kills the §2.1 asymmetry at the source. This is the foundation the rest sits on.

### B. Implement self-gate before handoff (tier-scaled)
Before `implement` hands off it must:
1. **Run the deterministic checks it can run locally** — gates, `finish()` against the acceptance contract, prove-test, and the new-test mutation check (D'). Red → fix or declare `harness_needed`. No "green-looking but failing" handoff.
2. **One adversarial self-critique pass** using this tier's reviewer rubric, framed as "find where this fails the rubric" (docs = 1 pass; load-bearing = a skeptic subagent).
Kills: own-cal R1 (fail-closed guard), KTB #18 R3 (`finish()` claim — running it locally shows exit 1), own-cal R2 (part). **Cost:** adds implementer turns (~$2–6 for a self-critique + near-free gates) to remove a review round (~$20 = 4 opus reviewers), and to avoid the K-exhaustion → human-merge cascade (§4, KTB-47) that both dogfood issues hit (13h stalls). Net win whenever it removes ≥1 round.

### C. Repo conventions digest handed to implement
A per-repo "house rules" digest assembled from CHARTER / CLAUDE.md / harness: build/run/test recipes and "what a correct change here must include" (e.g. *client commands use dev config, not prod*; *server bring-up needs `prisma migrate`*). Reviewers effectively hold this; the implementer does not. Kills: own-cal R2 cf1/cf2. This is the concrete answer to "does the agent carry enough context": it carries megabytes of *generic* context but not the *critical checklist* or the *conventions*.

### D. Regression pinning
On rework, each reviewer must_fix is captured as a runnable guard (a test where possible, a checklist line otherwise) carried into the next implement dispatch and into B's self-gate, so a fix cannot silently regress a prior finding. Kills: KTB #18 R3.

### D'. New-test mutation check
For each new assertion the implementer adds, confirm the test goes red when its asserted property is violated (a cheap local mutation), the dual of prove-test's "new test fails without the impl." Kills: own-cal R1 cf1 at implement time.

### E. Tier by blast radius (computed, not self-declared) + guard-test fix
Roster and gate level derive from the files a diff touches. `docs/**` / `*.md` **and the guard tests that assert on them** resolve to the `docs` roster; `load_bearing` paths force `full`+`deep`. Fixes the KTB #18 bump where a required guard test promoted a docs diff to `standard` (4 reviewers × 3 rounds = $80).

### F. Scoped re-review on rework
Round R>1 reviews only the **fix diff**, with reviewer set `{rejecting roles} ∪ {roles whose lens the delta touches}`, at `tier ≤ prior`. One cheap full-tree correctness sanity remains on the final pre-merge pass to catch cross-cutting regressions. This formalizes the scoped re-review packaging done by hand in the SDD loop this session.

### G. No re-review while blocked
If the last failure was a product/harness block (`harness_needed`, needs-info parked, a must_fix the implementer marked as a dependency), park and do not re-run the LLM review until the block clears. Kills: KTB #3 spec1×2.

### H. In-run repair for deterministic validator failures (= KTB-51)
Plan-validator failures (dissent without done_when) and false-RED gates feed the reason back to the same agent for one repair turn before spending a new stage/round or escalating to needs-human.

## 5. Unifying architecture

```
plan ──emits──▶ ACCEPTANCE CONTRACT (A)  ──┐
                 (done_when: level+check+rubric)
                                            ├──▶ implement: house rules (C) + contract as checklist
                                            │        │
                                            │        ├─ self-gate (B): gates/finish/prove/mutation(D') RED? → fix
                                            │        ├─ adversarial self-critique at tier depth
                                            │        └─ regression pins (D) from prior rounds
                                            │        ▼ handoff only when self-gate green
                                            │   review: roster+level by blast radius (E)
                                            │        ├─ round 1: full panel on full diff
                                            │        └─ round R>1: scoped delta review (F), no re-review while blocked (G)
                                            └──▶ merge: same contract as evidence
deterministic validator/gate failure ─────▶ one in-run repair turn (H) before a new round
```

The reviewer's stance is unchanged; the implementer now meets the reviewer's own bar before the reviewer is spent.

## 6. Decisions & non-goals

- **Non-goal: weaken review.** Depth, adversarial framing, and must_fix authority are unchanged. Round 1 remains a full panel at the diff's tier; only *re-review* is scoped, and a final full-tree sanity is kept.
- **Self-review must not be self-approval.** B's self-critique uses a fresh adversarial frame (the reviewer rubric) or a separate cheap skeptic — never "is this ok?". It is a gate the implementer must pass, not a self-grant.
- **Blast-radius tier is a floor, not a ceiling.** Triage/owner may raise a tier; the computed value only prevents *under*-provisioning a risky diff and *over*-provisioning a docs diff.
- **Cost model that justifies B:** a full standard review round ≈ $20 (measured); a self-gate ≈ deterministic gates (≈$0) + one critique agent (≈$2–6). Removing one round pays for the self-gate several times over, before counting the human-merge cascades avoided.
- **Deterministic before probabilistic, always.** Gates and the self-gate's runnable checks run before any LLM review; a red deterministic check never reaches a reviewer.

## 7. Backlog mapping

New:
- **KTB-53** — E (tier by blast radius + guard-test bump fix) + F (scoped re-review).
- **KTB-54** — A (acceptance contract) + B (self-gate) + C (house rules) + D/D' (regression pins, mutation check). The core lever.
- **KTB-55** — G (no re-review while blocked).

Existing (fold in):
- **KTB-51** — H (in-run repair). **KTB-47** — K-exhaustion → human-merge trap (Task 11 of the audit plan). **KTB-48** — human-merge door re-derivation (Task 12). **KTB-52** — harness-unpark re-queues from triage. **KTB-45** — adoption presets.

## 8. Open questions (resolve during planning)

1. Where does the acceptance contract's *runnable check* come from for a `done_when` id that has no natural test (a prose/UX criterion)? Options: qa `attach` evidence bound to the id (existing), or the rubric-only path graded by the reviewer (no self-runnable check). Decide the split.
2. B's self-critique subagent shares the stage's `claude -p` budget/turns. Does it run in-process as a final turn, or as a spawned skeptic? Turn-budget and `max_turns` implications (ADR-020 O25).
3. E's blast-radius computation must agree with the merge stage's tier resolution and with `verify-stage`'s `impact_paths` (audit M1) — one resolver, not two.
4. F's "roles whose lens the delta touches" needs a file→lens map; start coarse (any code → correctness; tests → qa; docs → spec-conformance; interfaces/load_bearing → architecture) and refine.
5. Regression pins (D) that cannot become a test (prose findings) — carried as checklist lines only; ensure the self-gate treats them as advisory, not a hard gate, to avoid unsatisfiable loops.
