# Factory Feedback Loop — Design (Run observability + improvement loop-back)

**Status:** design, approved for planning (2026-09-21)
**Author:** owner + Claude
**Related:** `2026-09-18-factory-review-efficiency-design.md` (ADR-026 gate, Task 10 metrics), `2026-09-10-factory-design.md` (§7 review, §12 dogfood), ADR-020 (records branch), ADR-022 (board), ADR-024 (qa evidence)

## 1. Problem

The owner cannot gain confidence that the factory is operating correctly. A single prompted agent is one transcript — fully visible. The factory spreads one issue's execution across five stages, many agents, several runners, issue comments, a records branch and 7-day Actions artifacts. Two consequences:

1. **Per-run confidence is low.** "Is this run doing real work? Which gate passed, which failed and why, what was patched?" is answerable only by reading 5–7 places by hand. The existing board (ADR-022) shows the transition-graph position plus the live heartbeat — little more than the label already says.
2. **The factory cannot improve itself from evidence.** Weak agents (a reviewer that rubber-stamps), dead debate (a skeptic that never changes the plan), starved context (a role that keeps missing what it was never shown), wasteful tiers (a docs diff paying for the full panel) — none of these are measured, aggregated, or routed anywhere. This session found every one of KTB-42…57 by hand.

Measured evidence that the raw data already exists: the run record on `factory/records` for demo #39 already carried the self-gate reason, the transition-refused reason (`plan roles [synthesizer,skeptic] != roster []` — the exact root cause of a live defect), gate counts, and per-agent cost/tokens/files. What is missing is not data — it is **durability, structure, classification, routing, and aggregation.**

## 2. The two improvement targets (must never be conflated)

"Improving the factory" means two different things with different owners:

| target | what it is | who fixes it | where the fix lands |
|---|---|---|---|
| **`harness`** | the using project's own factory config: `harness.toml`, `CHARTER.md`, `scripts/*`, its protected list, maturity | the adopter | a **harness issue in the using repo** (`ensureHarnessIssue`, exists) |
| **`ktb`** | what know-thy-build ships: `.factory/**` engine code, `.claude/agents/*.md` prompts, templates/defaults, skills, tier/roster policy | KTB | a **factory-improvement issue in the KTB repo** (new) |

A third class, **`product`** (a real defect in the using project's code), is the factory's normal work and is not routed by this loop — it is only counted as an *outcome* signal (escaped defects). A fourth, **`ambiguous`**, is never dropped: it surfaces to the owner with both candidates and the evidence.

**The classification is deterministic, by the owner of the causal file.** The install manifest (`factory/cli/manifest.js`, `ownerOf(dest)`) already tags every installed file `owner: factory | user`. A finding whose causal file is `owner: user` is `harness`; `owner: factory` is `ktb`. Behavioural findings (rubber-stamp, dead debate, token waste) have no single file but their causes — prompts, tiers, rosters — are all `owner: factory`, so they are `ktb` by nature, provided the paired evidence (§5) exists over ≥ N issues. A finding may carry **more than one tag** (own-cal's `test_one` quoting was `harness` — the adopter wrote quotes — *and* `ktb` — the template's "do not add quotes" guidance was too weak to prevent it).

## 3. Principles

- **Local stays local; only `ktb` goes upstream.** Harness findings must never flood KTB with things KTB cannot act on.
- **Rich causal evidence, not aggregates** — for now. Every dogfood repo is owner-owned, so the loop carries the full causal chain (file:line, command, test name, error snippet, KTB version, the role's context manifest, the verdict/transition chain, cost). External-adopter transport (content-free aggregates, opt-in, privacy trimming) is **deferred** until the signals have proven useful on dogfood.
- **GitHub-native, not local-only.** The loop runs on the normal paths: at stage run time (Actions), at retro (merge-triggered Actions), on a periodic health job, and equally from a CLI for a person. Nothing depends on a laptop.
- **Durable before ephemeral.** Anything the loop needs must be written to the records branch at run time; 7-day Actions artifacts are a convenience, never the source of truth.
- **Paired metrics only** (Goodhart). Approve-rate is interpretable only with escaped defects; debate quality only as an outcome delta; waste only as cost against diff risk. Health signals are **improvement triggers**, never grounds to reduce reviewer coverage (that is ADR-026's separate job).
- **Ambiguous is surfaced, never mis-routed or dropped.**

## 4. The loop

```
stage run (Actions) ──emit──▶ run record (records branch): gate detail + role context manifest + verdicts + cost   [T1]
        │
        ▼ on merge (retro, Actions)                              ▼ periodic (health job)         ▼ manual (CLI)
  classify each finding by causal-file owner  [T2]      aggregate behavioural signals   [T4]    factory analyze [T5]
        │                                                       (≥N issues, paired)
        ├─ harness  → harness issue in the using repo (exists)
        ├─ ktb      → factory-improvement issue in the KTB repo (cross-repo, deduped by fingerprint)  [T3]
        ├─ product  → outcome signal only
        └─ ambiguous→ owner note with both candidates
        ▼
  KTB repo: factory-improvement issue is a normal KTB issue → KTB's own SDD/factory fixes it → new version →
  adopters `init --upgrade` → the loop re-measures.                                              [T6]
```

## 5. Signals (what the loop measures)

| concern | signal | pairing required |
|---|---|---|
| agent effectiveness / rubber-stamp | per-role approve/reject rate, must_fix contribution, "ever rejects", verdict flips | **× escaped defects downstream** (100% approve alone is undecidable) |
| debate quality (plan) | did the skeptic/debate **change** the plan (done_when added, dissent substance) | outcome delta, not length |
| context adequacy | a role's misses correlated with fields it was **not shown** (cold-read manifest vs what full-ctx spec-conformance caught) | needs the per-role context manifest [T1] |
| tier / token waste | cost per issue/role/tier; cost vs diff risk (docs diff on the full panel); rounds | cost × risk, not cost alone |
| correctness outcome | rounds_per_issue, escaped_defects, revert_rate (Task 10 / ADR-026) | already paired |

## 6. Evidence payload (per finding)

`{ issue, repo, stage, round, ktb_version, tags: ["harness"|"ktb"|"product"|"ambiguous"], causal: { path, line?, owner, command?, test?, snippet }, role?: { name, context_manifest: [fields] }, chain: [verdict/transition events], cost: { usd, tokens }, fingerprint }`. The `fingerprint` (stable hash of tags + causal path + normalized reason) dedupes: the same cause across issues appends evidence to one upstream issue rather than opening many.

## 7. Routing & configuration

- `harness` → `ensureHarnessIssue` in the using repo (existing mechanism, existing dedupe by `for=<issue>` marker).
- `ktb` → open/append a `factory-improvement`-labelled issue in the repo named by `harness.toml [factory].upstream` (e.g. `LeeHyeonKyu/know_thy_build`). Cross-repo write uses the runner's `FACTORY_BOT_TOKEN`, which the owner grants `issues:write` on the upstream repo. **If `upstream` is unset, `ktb` findings stay as a local comment** — routing is opt-in by config, on by default for owner-owned repos. The owner registers the permission (secrets are never set by the factory).
- `ambiguous` → a note on the source issue naming both candidates and the evidence.
- The periodic health job also emits a **derived, human-readable factory-health report** (an issue/comment) — the "conversation" the owner reads is derived from the structured record, never the raw dump.

## 8. Components

| id | name | fills |
|---|---|---|
| T1 | durable run-time evidence: gate failure detail + per-role context manifest → run record | 7-day artifact loss; context-adequacy signal |
| T2 | `classifyFinding()`: causal-file-owner rule + behavioural→ktb rule; multi-tag; ambiguous preserved; payload + fingerprint | the two-target separation |
| T3 | retro classify-and-route arm: harness→local, ktb→upstream (cross-repo, deduped), ambiguous→note | the loop's routing |
| T4 | periodic health job: paired behavioural aggregates + derived report | agent/debate/context/tier signals |
| T5 | `factory analyze` CLI: same engine, manual path | works for a person |
| T6 | KTB side: `factory-improvement` label/template; entry into KTB's SDD | closes the loop |

## 9. Non-goals / deferred

External-adopter transport, content-free aggregation, privacy trimming, opt-in consent UX — all deferred until dogfood proves the signals. No change to reviewer depth or roster (Global Constraint of the review-efficiency plan). No automatic self-modification of KTB by the loop: it opens issues; humans/SDD fix.

## 10. Open questions (resolve in planning/execution)

1. Context manifest granularity: field names only, or field names + a content hash (to detect a stale copy)? Start with names.
2. Fingerprint normalization: how to normalize reasons so "same cause, different issue number" collides without over-merging distinct causes. Start with tags + causal path + reason with numbers/shas stripped.
3. The behavioural N: how many issues before a rubber-stamp/dead-debate finding is emitted? Start N=5 (matches ADR-026's sample size).
4. Where `factory-improvement` issues enter KTB's own pipeline: labelled `factory:queue` automatically, or `backlog` for owner triage? Start `backlog` (a human decides what the factory works on for itself).
