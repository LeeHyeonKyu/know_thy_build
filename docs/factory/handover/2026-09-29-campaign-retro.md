# Campaign retro — 2026-09-26T15:40Z → 2026-09-28T14:04Z (46 h wall clock)

## Size
| Repo | Merged PRs | Diff | Notes |
|---|---|---|---|
| own-calendar | 33 (18 issue PRs + 20 KTB upgrades + hand fixes) | +3,789 / −122, 82 files | 18 issues merged (16 factory, 2 human) |
| know-thy-build-demo | 17 | +3,400 / −62, 63 files | 10 issues merged |
| know_thy_build | 42 commits (22 fix PRs + 20 releases 1.4.13→1.4.32) | engine +749/−66 (33 files), tests +740, DECISIONS +165; total +2,403 / −176, 91 files | L12–L40 + 8 backlog items |

## Cost (runner-recorded usage lines) and controller
| | stage-runs | cost | per stage |
|---|---|---|---|
| own-calendar | 159 | $479 | implement 63 runs $200 · review 32 $182 · plan 23 $90 · triage 24 $8 |
| demo | 84 | $155 | review 18 runs $95 · implement 35 $49 · plan 11 $8 · triage 14 $2 |
| controller (this session) | 1,463 assistant turns; 871 Bash calls | ≈$1,800 at Opus list price (1.88M output, 19M cache-write, 881M cache-read tokens) | dominated by cache reads of a long context on every poll/snapshot turn |

Factory total ≈ $634 for 28 merged issues (mean $20/issue own-cal, $8.6/issue demo). Controller ≈ 3× the factory.

## Where the turns went (own-calendar)
Failure markers in run records: gates RED 28, plan-contract failures 31 (incl. verify FAIL), self-gate blocked 12, verifier rejected 6, worktree dirty 5, stale-engine runs 4.
Top issues: #90 $61/8 runs (plan loops L37–L39 + 75-min timeout L38), #31 $58/16 runs (L12/L13/L16/L17 chain), #9 $44/10 (M2 harness, 3 review rounds), #49 $43/11 (flaky test at review L34, API outage L40), #45 $30/13 (L26/L28/L30/L31).

## Bottlenecks, ranked
1. Single self-hosted runner: every stage serial; issue lifetimes 13–38 h for ~$20 of compute; queue up to 20 runs, 13 of them stale integrity checks (L21); runs waited 50–90 min and executed the engine of the main they were created at (L20).
2. Factory-defect loops: each defect burned 1–3 stage runs (~$8–13 each) per affected issue before its fix shipped; five server issues lost their first implement turn to the same mutation false positive (L31); #31 and #90 each burned >$55 across defect chains.
3. Review rounds: $6–13 per round with 4–5 reviewers; K=3 exhausted on #76, #87, #7, #9, #49 → human decisions; health job now flags three reviewer roles that never withhold approval (KTB #122–#124).
4. Controller polling and release cadence: 20 release chains (~15 min each ≈ 5 h), 3 chain restarts on load-timeout flakes, and ~1,400 turns of which a large share were status polls — the cache-read volume, not the output, is the controller's cost driver.
