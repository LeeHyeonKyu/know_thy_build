# Retro State

- last retro: 2026-10-01T23:09:32.429Z
- merges since last retro: 0
- current N: 1

## History (last 5)

| at | yield | n_before | n_after | needs_human_since |
| --- | --- | --- | --- | --- |
| 2026-09-14T14:00:58.920Z | 0 | 1 | 1 | 6 |
| 2026-09-15T07:09:55.650Z | 2 | 1 | 1 | 2 |
| 2026-09-15T10:31:18.686Z | 0 | 1 | 2 | 1 |
| 2026-10-01T23:09:32.429Z | 0 | 2 | 1 | 13 |

## Stats

| metric | this window | cumulative |
| --- | --- | --- |
| merged | 2 | 5 |
| review rounds avg | 2.5 | 2.2 |
| rounds/issue (plan/impl/review) | 1 / 2.5 / 2.5 | 0.4 / 1 / 2.2 |
| escaped defects | 4 (#143×2, #136×2) | 4 |
| revert rate | 0.00 (0/2) | 0.00 (0/5) |
| needs-human | 13 | 22 |
| rejects by role | correctness 2, spec-conformance 2, qa 1, architecture 1 | spec-conformance 4, qa 4, correctness 4, architecture 1 |
| reviewer overlap | 0.67 (4/6, runs 5) | 0.38 (5/13, runs 11) |
| unique findings by role | qa 1, spec-conformance 1 | spec-conformance 3, qa 4, correctness 1 |
| qa na ratio | 0.24 (5/21 claims, na-heavy 1/3 approvals) | 0.24 (5/21 claims, na-heavy 1/3 approvals) |
| cost (usd) | 143.38 | 334.24 |
| tokens | input 6974347 / output 394684 | input 10336510 / output 706521 |
| retro cost (usd) | 0.94 | 5.12 |
| retro tokens | input 4 / output 2310 | input 10 / output 10925 |
| full retros | — | 4 |

### Rounds per issue (this window)

| issue | plan | implement | review | escaped |
| --- | --- | --- | --- | --- |
| #143 | 1 | 2 | 2 | 2 |
| #136 | 1 | 3 | 3 | 2 |

### Phase-2 gate baseline (this session)

- baseline: KTB #18 = $143 / 12 stage-runs; own-cal #3 = 4 review rounds
- frozen thresholds: escaped_defects ≤ 0, revert_rate ≤ 0.00
- rounds-per-issue exemplar: own-cal #3 = 4 review rounds (reject-heavy; caught in review, escaped_defects=0)
- must-not-recur escaped defects: KTB #18 R3 finish() regression (approve→reject flip — a post-approval escaped defect)
- gate (ADR-026): Phase 2 (plan Tasks 6, 7) starts only when, over ≥5 post-Phase-1 issues, escaped-defect rate AND revert rate are ≤ baseline while rounds-per-issue fell.

<!-- factory-retro-state:v1 -->
```json
{
  "cursor": {
    "last_retro_at": "2026-10-01T23:09:32.429Z",
    "last_record_offsets": {}
  },
  "merges_since": 0,
  "n": 1,
  "history": [
    {
      "at": "2026-09-14T14:00:58.920Z",
      "yield": 0,
      "needs_human_since": 6,
      "applied": [
        {
          "step": "role:plan-operator",
          "added": [],
          "deferred": [
            {
              "kind": "good",
              "text": "위치: #7 plan 라운드(`docs/factory/runs/7.md` · plan gha-34822164859) — 제목이 '— for #3'인 파생 harness 이슈. 주장: 'M0에서 (spec-conformance) 규칙 5의 두 번째 분기는 구조적으로 성립할 수 없다'는 결론이 #7 자신의 `.factory/out/context.json`만을 근거로 삼고 있으므로, 규칙이 오적용됐다는 판정은 실제 사건(#3의 review 라운드에서 나온 must_fix)에 대해 증명된 것이 아니라 #7의 현재 상태로부터 유추된 것이다. 근거: #7은 #3의 implement 스테이지가 연 이슈이고(runs/3.md의 `harness: opened factory:harness issue #7`, runs/7.md:1의 '— for #3'), 문제의 판정은 #3의 review에서 내려졌다 — 결론을 쓰려면 #3의 plan handoff와 #3 당시의 `harness.maturity`를 인용해야 한다. 요구: 파생 이슈에서 부모 이슈의 판정을 뒤집는 주장은 부모 이슈의 기록을 인용한 뒤에만 결론으로 쓴다.",
              "reason": "insufficient-evidence"
            },
            {
              "kind": "perspectives",
              "text": "**파생 이슈를 읽는 사람의 눈**: 이 이슈가 다른 이슈의 스테이지가 열어준 harness 이슈라면(제목 '— for #N'), 사실관계는 내 `context.json`이 아니라 `docs/factory/runs/N.md`와 그때의 `harness.maturity`에 있다 — 내 컨텍스트만 인용한 결론은 부모 이슈에 대해 아직 증명되지 않았다.",
              "reason": "insufficient-evidence"
            }
          ]
        }
      ],
      "n_before": 1,
      "n_after": 1
    },
    {
      "at": "2026-09-15T07:09:55.650Z",
      "yield": 2,
      "needs_human_since": 2,
      "applied": [
        {
          "step": "role:plan-skeptic",
          "added": [
            {
              "section": "### 좋은 발견",
              "text": "위치: #20 plan 라운드의 skeptic 반대(`docs/factory/runs/20.md` · plan gha-34880188521) — 제목이 '— for #18'인 파생 harness 이슈. 주장: 이 이슈의 done_when이 요구하는 `docs/factory/CHARTER.md` 편집은 `factory:harness` 이슈에서도 빌더에게 열리지 않으므로, 이대로면 빌더가 끝낼 수 없는 계획이다. 근거: 네 곳을 경로와 줄로 댔고 네 곳 모두 지금 확인된다 — `.factory/ci-settings-harness.js…"
            },
            {
              "section": "## Perspectives",
              "text": "**쓰기 경계를 먼저 보는 눈**: 이 계획의 `done_when`·`files_expected`가 가리키는 경로가 빌더의 쓰기 경계 안에 있는가 — `.factory/**`·`.claude/**`·`docs/factory/CHARTER.md`는 `factory:harness` 이슈에서도 열리지 않는다(`factory/lib/protected-paths.js`의 `HARNESS_OPENS`는 harness.toml·package.json·package-lock.json·vitest.config.*·playwright.config.…"
            }
          ],
          "skipped": [],
          "deferred": []
        },
        {
          "step": "publish-lessons",
          "pr": 22,
          "merged": true,
          "reason": null,
          "files": [
            ".claude/agents/plan-skeptic.md"
          ]
        }
      ],
      "n_before": 1,
      "n_after": 1
    },
    {
      "at": "2026-09-15T10:31:18.686Z",
      "yield": 0,
      "needs_human_since": 1,
      "applied": [
        {
          "step": "role:plan-skeptic",
          "added": [],
          "deferred": [
            {
              "kind": "good",
              "text": "위치: #18 plan 라운드의 skeptic 반대(`docs/factory/runs/18.md` · plan gha-34940472226) — README의 qa-evidence 예제 명령이 '진짜로 도는지'를 지키는 가드를 새로 만들자는 계획. 주장: 그 가드를 계획대로 만들면, 가드가 리뷰 스테이지에서 돌 때 **지금 수집 중인 qa 증거를 지운다** — 계획이 낳는 테스트가 자기 자신의 검증 근거를 파괴한다. 근거: `factory/bin/qa-evidence.js`의 `runCli`는 `--root`를 일부러 없애고 뿌리를 프로세스 cwd로 고정하며(:494-510, `const root = cwd`), `record/attach/na`는 `.factory/out/qa/&lt;issue&gt;/manifest.json`에 저장한다. `loadOrOpenManifest`는 head_sha가 다르면 *새* 매니페스트를 돌려주므로(:339-344) 리뷰어가 기록한 claim이 오류 한 줄 없이 사라진다. 게다가 리뷰는 같은 체크아웃에서 vitest를 돌리고 `new_test_repeats`가 새 파일을 여러 번 돌린다 — 기존 테스트가 전부 격리된 cwd를 주입하는 이유가 그것이다(`factory/test/qa-evidence.test.js`의 `cliOpts(root)`). 제안: done_when을 '격리된 임시 루트에서 예제 줄을 돌려 대조한다'로 좁히고, 저장소 루트에서 도는 형태는 `non_goals`로 봉인한다.",
              "reason": "insufficient-evidence"
            }
          ]
        },
        {
          "step": "role:reviewer-qa",
          "added": [],
          "deferred": [
            {
              "kind": "good",
              "text": "위치: README의 qa-evidence 워크스루(README.md:124-133, :155-156)와 그 마지막 줄 `node .factory/bin/qa-evidence.js finish --issue 42`. 주장: 문서가 보여 주는 다섯 줄을 **적힌 그대로** 따라 하면 두 상태 모두에서 문서가 가르치는 것과 다른 일이 일어난다 — (1) 리뷰가 도는 체크아웃에서는 `--issue 42`가 주변 컨텍스트의 done_when(이번 이슈 #18의 dw1..dw7)으로 채점돼 `spec-evidence-missing`이 뜨고, (2) 컨텍스트가 없는 갓 clone 상태에서는 '커버리지를 판정할 수 없다'는, 같은 절이 두 문단 위에서 '라운드가 거절되는 세 가지' 중 하나로 열거한 바로 그 문구로 exit 1한다. 근거: 두 상태를 각각 만들어 다섯 줄을 순서대로 실제로 돌린 로그를 라운드의 매니페스트에 claim으로 남겼다(`docs/factory/runs/18.md` review 라운드 2 · manifest a209a5e512ec, 11c/2na). 원인은 `factory/bin/qa-evidence.js`의 `stageContext`(:219-238)가 `.factory/out/context.qa.json`·`context.json`에서 done_when을 무조건 읽고, 그 파일의 이슈 번호가 `--issue`와 같은지 **한 번도 확인하지 않는** 데 있다 — 위험은 '42'에 한정되지 않는다. 문서의 예제를 읽고 그대로 치는 것이 독자의 첫 행동이므로, 이 차이는 사용자에게 실제로 일어나는 일이다.",
              "reason": "insufficient-evidence"
            },
            {
              "kind": "perspectives",
              "text": "**예제를 처음 따라 하는 사람의 눈**: 문서·README가 보여 주는 명령줄은 두 상태에서 각각 그대로 쳐 본다 — 문맥이 하나도 없는 갓 clone 상태와, 지금 리뷰가 도는 체크아웃. 두 곳의 출력·종료 코드가 다르면 그 문서는 둘 중 한 독자에게 거짓말하고 있고, 그 차이가 어디서 오는지(주변 `.factory/out/context*.json` 같은 암묵 입력)를 must_fix에 적는다.",
              "reason": "insufficient-evidence"
            }
          ]
        },
        {
          "step": "role:reviewer-correctness",
          "added": [],
          "deferred": [
            {
              "kind": "good",
              "text": "위치: README의 새 산문 한 문장 — '리뷰 스테이지 안에서는 같은 `finish --issue 42` 줄이 진짜 커버리지 표를 찍고 exit 0이다'. 주장: 코드는 그 자리에서 exit 1이고, 같은 절의 13줄 위(README.md:128-129)가 정확히 반대말을 적고 있다 — 이 PR의 목적이 'README가 거짓을 가르치지 않게 하는 것'인데 새로 들어온 문장이 그 거짓이다. 근거: 예제가 기록하는 세 claim(dw2 command, dw3 attach-screenshot, dw5 not_applicable)만으로는 어떤 done_when 집합에 맞춰 채점해도 `finish`가 0으로 끝날 수 없고, 문맥이 어긋난 채점 경로(`stageContext`가 `--issue`와 컨텍스트의 이슈 번호를 대조하지 않음, `factory/bin/qa-evidence.js:219-238)까지 겹친다. 산문이 종료 코드·출력 형식을 단언하면 그것은 코드에 대한 주장이고, 주장은 같은 문서 안의 이웃 문장과도 대조된다(`docs/factory/runs/18.md` review 라운드 2·3, correctness=reject).",
              "reason": "insufficient-evidence"
            },
            {
              "kind": "perspectives",
              "text": "**검출기의 눈**: 이번 변경이 추가한 가드가 무엇을 비교하는지 직접 읽는다 — 의미 주장을 구절 목록(금지 문구 N개)으로 대신하고 있지 않은가. 목록이면 그 가드의 스캔 대상 안에 있는 문서가 같은 주장을 다른 말로 가르쳐도 clean이 뜬다. 가드가 지킨다고 적힌 done_when을 실제로 깨뜨리는 문장을 하나 만들어 그 가드가 빨개지는지 묻는다.",
              "reason": "insufficient-evidence"
            }
          ]
        }
      ],
      "n_before": 1,
      "n_after": 2
    },
    {
      "at": "2026-10-01T23:09:32.429Z",
      "yield": 0,
      "needs_human_since": 13,
      "applied": [
        {
          "step": "feedback-route",
          "issues": [
            143,
            136
          ],
          "actions": [
            {
              "kind": "warning",
              "step": "feedback-route",
              "login": "LeeHyeonKyu",
              "current": "bot-hk",
              "reason": "current factory identity: bot-hk (machine user/app, viewer); older runs in this window ran under a shared identity (LeeHyeonKyu) — their human decisions are unverifiable, nothing to register"
            },
            {
              "kind": "product",
              "step": "feedback-route",
              "issue": 143,
              "count": 2
            },
            {
              "kind": "product",
              "step": "feedback-route",
              "issue": 136,
              "count": 1
            }
          ]
        },
        {
          "step": "lessons:factory-builder",
          "added": [
            "L-2026-10-01-01"
          ],
          "rejected": [],
          "evicted": [],
          "cited": []
        },
        {
          "step": "role:reviewer-qa",
          "added": [
            {
              "section": "### 좋은 발견",
              "text": "위치: 이번 diff가 새로 넣은 산문 중 엔진 동작을 단언하는 문장. #18에서는 README의 '리뷰 스테이지 안에서는 같은 `finish --issue 42` 줄이 커버리지 표를 찍고 exit 0이다', #143에서는 DECISIONS의 '병합 대기 중에는 가드가 미러 계열 경로를 세지 않는다'였다. 주장: 두 문장 모두 출하된 코드와 반대다. `finish`는 그 자리에서 exit 1이고, 가드는 `mirrorMatchesBranchHead`로 미러 경로를 비교한다. 근거: #18은 다섯 줄을 적힌 그대로 실제로 돌린 로그…"
            }
          ],
          "skipped": [],
          "deferred": []
        },
        {
          "step": "publish-lessons",
          "pr": 153,
          "merged": false,
          "reason": "gh pr merge failed (1): X Pull request LeeHyeonKyu/know_thy_build#153 is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.\nTo use administrator privileges to immediately merge the pull request, add the `--admin` flag.",
          "files": [
            ".factory/lessons/factory-builder.md",
            ".claude/agents/reviewer-qa.md"
          ]
        }
      ],
      "n_before": 2,
      "n_after": 1
    }
  ],
  "candidates": {
    "lessons": [
      {
        "role": "spec-conformance",
        "text": "이번 이슈의 tier(standard)·roster(['correctness','architecture','spec-conformance','qa'])에서 qa가 호출됐고 done_when에 사용자 가시적 텍스트 항목(dw4, dw5)이 있는데도, harness.toml이 못박은 qa 증거 경로 `.factory/out/qa/**`가 이번 라운드에 비어 있다 — qa의 round-1 verified[]가 인용한 증거는 전부 저장소 밖 `/tmp/qa-repro/repro.mjs`, `/tmp/qa-evidence-issue3/*.log`이고, 이 세션이 끝나면 사라진다.",
        "runs": [
          3
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "roster includes qa, dw4 is explicitly a user-visible-surface assertion ('사용자가 보는 텍스트 표면이 불변을 진다' — the stdout of `factory status`), and .factory/out/qa/** is empty at HEAD 867a521 while the qa reviewer's round-1 verdict asserts extensive hands-on verification of exactly that surface ('ran the fixed command... stdout showed only #8 row', 'built factory-old/... Pre-fix output literally contained the reported phantom row'). Per Lens rule 5 this is the literal reject condition: '파일이 없는데 확인함이라고 적힌 상태는 reject — 증거 없는 주장은 이 공장에서 통화가 아니다.' I traced this beyond a plausible-but-unconfirmed timing gap (which is as far as I went in round 1, spec-sf1) to a structural cause, and it is not resolving on its own.",
        "runs": [
          3
        ],
        "source": "must_fix"
      },
      {
        "role": "qa",
        "text": "The README's own worked qa-evidence example — copy-pasted verbatim, including the literal `--issue 42` — silently mixes another issue's real `done_when` ids into the `finish` coverage table with no warning, no mismatch error, and no way for the reader to notice. I ran the exact five README lines for real, from the repo root, with the ambient `.factory/out/context.json` that is present during any real review session (including this one, issue 18). `finish --issue 42` printed a coverage table for `dw1..dw7` — issue 18's done_when ids, not issue 42's (issue 42 does not exist locally at all) — and failed with `spec-evidence-missing: dw1, dw4, dw7`, a verdict that has nothing to do with the fictitious issue-42 claims actually recorded (dw2/dw3/dw5). `stageContext` (factory/bin/qa-evidence.js:219-238) reads `.factory/out/context.qa.json` / `.factory/out/context.json` for `done_when` unconditionally — it never checks that the file's own issue number matches the `--issue` flag the caller passed. dw3 claims every shown command 'is real' and dw2 claims the README documents the qa-evidence contract accurately; neither claim, nor any prose in the new section, discloses that the exact recipe shown will silently borrow whatever issue is mid-review in that checkout the moment a reader tries it verbatim (the single most likely first action for a reader of a worked example). The hazard is general, not specific to '42': the same corruption occurs for any `--issue N` that does not match the ambient context.json's issue.",
        "runs": [
          18
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "dw5 is not met: a doc inside the guard's own scan set still teaches the retired claim, and the new detector reports clean because it is a six-phrase list over a semantic claim. The file is the one README.md:89 sends the reader to (\"numbers in ADR-020\").",
        "runs": [
          18
        ],
        "source": "must_fix"
      },
      {
        "role": "qa",
        "text": "Followed exactly as shown — the five lines in order, using the demo's own placeholder issue 42, from a checkout with no live review context (no .factory/out/context.json or context.qa.json anywhere, e.g. right after `factory init` or a plain `git clone`, which is the ordinary way a reader first tries a worked CLI demo) — the walkthrough's own last line (`finish --issue 42`) deterministically prints `coverage: INCOMPLETE — done_when could not be resolved — coverage is undecidable` and `factory: qa evidence not acceptable — done_when could not be resolved …`, exiting 1. That is verbatim the exact language README.md:155-156 lists, two paragraphs earlier in the same subsection, as one of only three things that get 'a qa round rejected'. Nothing in the demo or its surrounding prose warns a first-time reader that trying the demo standalone (the single most natural way to learn the tool) is guaranteed to end on what reads as a rejection banner. The 42-is-a-placeholder caveat immediately after the demo (README.md:124-133) addresses a different failure mode entirely — silently grading against the wrong issue's context when one *does* exist on disk — and does not cover, or even gesture at, the far more common case of no context existing at all.",
        "runs": [
          18
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "새 산문이 `finish --issue 42`가 리뷰 스테이지 안에서 **exit 0**이라고 가르치는데, 코드는 그 자리에서 exit 1이다 — 그리고 같은 절의 13줄 위(README.md:128-129)가 정확히 반대말을 적고 있다. 이 PR의 목적이 'README가 거짓을 가르치지 않게 하는 것'인데, 새로 들어온 문장이 그 거짓이다.",
        "runs": [
          18
        ],
        "source": "must_fix"
      },
      {
        "role": "qa",
        "text": "README teaches an adopter that 'Inside a review stage ... the same [finish] line prints the real coverage table and exits 0.' This is false, not just in the mismatched-issue-number edge case cf1 also flags, but as the recipe's steady state: the demo's own three claims (a command claim for dw2, a screenshot-only claim for dw3 via attach, a not_applicable claim for dw5) can never make `finish` exit 0, even when graded against a done_when set that lines up exactly with those three ids.",
        "runs": [
          18
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "The generation fold applies transitively with no limit. A harness node always counts 0, and a flaky whose parent is a harness also counts 0. So the chain can keep alternating flaky→harness→flaky→harness→… and every issue in it has generation ≤ 1. depth_max never fires on this loop. Spec §8.2 line 109 counts one improvement→harness→flaky chain as a single generation; it does not say that repeating harness→flaky segments cost nothing. This is also a regression against main for issues that already pass the door. On main, a flaky harvested while implementing a harness issue opened for a flaky (F40 ← H30 ← F20 ← person #10) is refused as generation 3 > 1, because the gates.js flaky harvest already goes through admission. On this branch it is admitted, and so is every later link. dw6's rubric says 'the existing depth_max guarantee for other self-generated chains still holds', and that does not hold for this chain. open_max bounds only how many are open at once, not how long the chain gets.",
        "runs": [
          136
        ],
        "source": "must_fix"
      },
      {
        "role": "architecture",
        "text": "The diff damages four existing decision entries that have nothing to do with #136. In each one, a Korean character has been replaced with U+FFFD replacement bytes: `서버는` became `서버���`, `그대로` became `그대��`, `매처` became `매��`, and `락을` became `락��`. DECISIONS.md is this repo's architecture record, because docs/TECHNICAL.md only describes the bin/cli.js installer and says nothing about factory/. The record itself says those facts 'must be written here so they can be found with grep', and the damaged text breaks that for these entries, including the ADR-025 neighbour that this PR's S2b entry claims to supersede. A revert of the code would leave the corruption behind.",
        "runs": [
          136
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "Four existing decision entries unrelated to #136 were changed without a stated reason. In each hunk, a Korean character was replaced with U+FFFD. This is a change to existing content that the plan never approved. It is not a #136 deliverable, so it is out of scope. The file being in files_expected covers the S2b entry, not edits to other entries.",
        "runs": [
          136
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "When the builder commits conflict markers, the post-session check blocks only that one round. The marker commit is already on origin, and the sweeper's automatic retry then runs the next implement round on that tree with no merge check at all. The rule 'a marker-committed merge never reaches gates or handoff' holds for exactly one round.",
        "runs": [
          143
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "dw6 not met: the new DECISIONS entry contradicts the shipped engine. dw6's rubric requires that 'the decision log no longer contradicts the engine'.",
        "runs": [
          143
        ],
        "source": "must_fix"
      },
      {
        "role": "qa",
        "text": "dw6 is not met. The new DECISIONS entry says the guard does not count mirror-family paths during a pending merge. The shipped engine does count them: it compares them with mirrorMatchesBranchHead. I missed this in round 1, when I only checked that the entry supersedes KTB-38 and keeps the release-freeze rule. This finding is the same as spec1, and I confirmed it independently.",
        "runs": [
          143
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "A `backPressure()` that throws (or rejects) now aborts the repair after the label has been rewritten but before the repair comment is posted. The issue ends up on a single label with no `factory-label-set-repaired` marker, no comment, and no `label-set-repaired` action. Only a bare `error` action is left. Before this PR the comment was always posted right after `setFactoryLabel`. Because the rejected promise is cached in `bpCache`, every other implement-target repair (`factory:planned`/`factory:rework`) in the same sweep hits the same silent half-repair. Nothing on the issue records the repair or explains why no run was started.",
        "runs": [
          147
        ],
        "source": "must_fix"
      }
    ],
    "examples": [
      {
        "role": "operator",
        "kind": "good",
        "text": "M0에서 규칙 5의 두 번째 분기가 구조적으로 성립할 수 없다는 주장은 #7 자신의 context.json만 근거로 삼고 있는데, must_fix spec1을 낸 실제 사건은 #3의 review 라운드다. #3의 plan handoff나 #3 당시의 harness.maturity를 인용하지 않고서는 '규칙이 오적용됐다'는 결론이 #3에 대해 증명된 것이 아니라 #7의 현재 상태로부터 유추된 것이다.",
        "runs": [
          7
        ],
        "source": "dissent"
      },
      {
        "role": "skeptic",
        "kind": "good",
        "text": "The issue body claims the factory:harness label lets the builder write docs/factory/CHARTER.md. It does not, at four places: .factory/ci-settings-harness.json:56-57 lists Edit(docs/factory/CHARTER.md)/Write(docs/factory/CHARTER.md) in the deny array; .claude/hooks/block-dangerous.sh:225-226 keeps docs/factory/CHARTER\\.md inside `prot` on the FACTORY_HARNESS_ISSUE=1 branch; HARNESS_OPENS (factory/lib/protected-paths.js:71-73) is only harness.toml, package.json, package-lock.json, vitest.config.*, playwright.config.*; and .factory/bin/run-stage.js:1664/1685 keeps docs/factory/CHARTER.md in OVERLAY_PATHSPECS even in harness mode, so the stage restores it from its own commit and assertStageBranch → overlayDrift (1616-1619) fails the stage with 'factory config changed during the stage' if it was touched. A plan whose only done_when requires that write is a plan the builder cannot finish, and the likely outcomes are a RED gate that burns the M=3 budget or a harness_needed escalation that harness-request.js:115 routes back onto this very issue.",
        "runs": [
          20
        ],
        "source": "dissent"
      },
      {
        "role": "skeptic",
        "kind": "good",
        "text": "The obvious way to prove the shown lines are real destroys live evidence. runCli fixes `root = process.cwd()` and deliberately has no `--root` (factory/bin/qa-evidence.js:503-510); cmdRecord/cmdAttach/cmdNa then saveManifest into `.factory/out/qa/<issue>/manifest.json` (:396, :428, :444). A guard that spawns a shown line at the repo root with `--issue 18` appends a fabricated claim to this issue's manifest; worse, loadOrOpenManifest returns a *fresh* manifest whenever head_sha differs (:344), so the qa reviewer's recorded claims vanish with no error. `[gates].required = [lint, unit]` means review runs vitest in that same checkout, and new_test_repeats: 3 runs the new file four-plus times. Every existing test of this CLI injects an isolated cwd (cliOpts(root) throughout factory/test/qa-evidence.test.js).",
        "runs": [
          18
        ],
        "source": "dissent"
      },
      {
        "role": "skeptic",
        "kind": "good",
        "text": "dw3's second half ('no issue's manifest.json (issue 18's included) created, appended to, reset or left behind') is unsatisfiable in the environment where this guard will most often run. The qa reviewer's canonical path is `record --issue <n> --claim <done_when id> … -- <repro cmd>` (.claude/agents/reviewer-qa.md:39; templates/know-thy-build/qa.md:446 makes it the M0 pattern for every id, :625 gives the literal line), and cmdRecord's order is gate → ensureDir → spawn payload → loadOrOpenManifest → saveManifest (factory/bin/qa-evidence.js:371-396). The payload for issue 18 is `npx vitest run factory/test/readme-commands.test.js -t test_18_…`, i.e. the guard itself, executed at the repository root. From claim #2 onward the manifest is present and is 'left behind' by design. The previous round already implemented the fatal shape — the verifier's v4 evidence records 'per-issue manifest absence checks including issue 18' — so the suite would go RED inside the very command that collects this issue's evidence, and the qa reviewer would have no way to record a green claim without deleting evidence ADR-024 forbids it from writing by hand (factory/hooks/deny-all-writes.sh:115).",
        "runs": [
          18
        ],
        "source": "dissent"
      },
      {
        "role": "skeptic",
        "kind": "good",
        "text": "The mirror route (risks 1-2) cannot be turned into a done_when: a done_when cannot grant a write permission, and a guard over `.claude/agents/*.md` or a path whitelist is exactly the test shape rule 3 forbids. It is a precondition, owned by the controller: either the six `.factory/**` paths leave `files_expected` and the mirror commit is made outside the task, or the `factory init --upgrade` non_goal is explicitly lifted with the additive-section clobber accepted and reviewed.",
        "runs": [
          36
        ],
        "source": "dissent"
      },
      {
        "role": "skeptic",
        "kind": "good",
        "text": "Keeping `docs/**` (minus CHARTER and NEVER_DOCS_GLOBS) in the positive list adds risk and no benefit. classifyProtected only ever sees files that are already protected. The only protected files under docs/** are docs/factory/CHARTER.md and **/CLAUDE*.md, **/AGENTS*.md and **/.mcp*.json, and every one of them must stay judge. So the docs entry can never mark a single legitimate file non_judge. All it can do is let one of those injection-channel files through if the subtraction drifts. The same reasoning covers `templates/factory/docs/**`: it holds the adopter CHARTER and a board page that must stay a byte copy of board-static.js.",
        "runs": [
          149
        ],
        "source": "dissent"
      }
    ],
    "flaky": [],
    "needs_human": [
      {
        "issue": 3,
        "reason": "protected paths changed — human merge required: factory/cli/status.js, factory/test/status.test.js (see PR #4)",
        "at": "2026-09-14T13:57:47Z"
      },
      {
        "issue": 7,
        "reason": "resolved upstream in KTB (KTB-36); will be closed when 1.1.1 lands",
        "at": "2026-09-14T08:21:09Z"
      },
      {
        "issue": 9,
        "reason": "resolved upstream in KTB (KTB-37)",
        "at": "2026-09-14T09:00:46Z"
      },
      {
        "issue": 13,
        "reason": "resolved upstream in KTB (KTB-40)",
        "at": "2026-09-14T12:54:05Z"
      },
      {
        "issue": 20,
        "reason": "stage artifact missing or invalid: gates RED: failing=unit,new-test-repeat",
        "at": "2026-09-14T19:02:46Z"
      },
      {
        "issue": 18,
        "reason": "review rounds exhausted (K=3): 2 must_fix remain",
        "at": "2026-09-15T10:25:35Z"
      },
      {
        "issue": 36,
        "reason": "overlay check refuses any .factory/** change on a self-repo PR (KTB #41); the factory cannot finish this issue — owner reviews PR #39 out of band and merges by hand",
        "at": "2026-09-21T04:08:48Z"
      },
      {
        "issue": 130,
        "reason": "blocked (undecidable) — needs human",
        "at": "2026-09-30T08:12:12Z"
      },
      {
        "issue": 136,
        "reason": "protected paths changed — human merge required: .factory/bin/run-stage.js, .factory/lib/admission.js, .factory/lib/feedback/route.js, .factory/lib/gates.js, .factory/lib/harness-request.js, factory/bin/run-stage.js, factory/lib/admission.js, factory/lib/feedback/route.js, factory/lib/gates.js, factory/lib/harness-request.js, factory/test/admission.test.js, factory/test/harness-request.test.js, factory/test/retro-route.test.js, factory/test/run-stage.test.js (see PR #137)",
        "at": "2026-10-01T07:40:50Z"
      },
      {
        "issue": 143,
        "reason": "protected paths changed — human merge required: .factory/bin/run-stage.js, .factory/lib/context.js, factory/bin/run-stage.js, factory/lib/context.js, factory/test/context.test.js, factory/test/run-stage-branch.test.js (see PR #144)",
        "at": "2026-10-01T16:09:04Z"
      },
      {
        "issue": 149,
        "reason": "blocked (undecidable) — needs human",
        "at": "2026-10-01T18:33:27Z"
      },
      {
        "issue": 147,
        "reason": "protected paths changed — human merge required: .factory/lib/sweeper.js, factory/lib/sweeper.js, factory/test/sweeper.test.js (see PR #148)",
        "at": "2026-10-01T17:43:33Z"
      }
    ]
  },
  "stats": {
    "merged": 2,
    "review_rounds_avg": 2.5,
    "plan_rounds_avg": 1,
    "implement_rounds_avg": 2.5,
    "rounds_per_issue": [
      {
        "issue": 143,
        "plan": 1,
        "implement": 2,
        "review": 2
      },
      {
        "issue": 136,
        "plan": 1,
        "implement": 3,
        "review": 3
      }
    ],
    "escaped_defects": 4,
    "escaped_defects_detail": [
      {
        "issue": 143,
        "count": 2
      },
      {
        "issue": 136,
        "count": 2
      }
    ],
    "reverts": 0,
    "reverted_issues": [],
    "revert_rate": 0,
    "rejects_by_role": {
      "correctness": 2,
      "spec-conformance": 2,
      "qa": 1,
      "architecture": 1
    },
    "review_runs": 5,
    "findings_total": 6,
    "overlapping_findings": 4,
    "unique_findings_by_role": {
      "qa": 1,
      "spec-conformance": 1
    },
    "overlap_ratio": 0.67,
    "needs_human": 13,
    "qa_approvals": 3,
    "qa_claims_total": 16,
    "qa_na_total": 5,
    "qa_na_ratio": 0.24,
    "qa_na_heavy_approvals": 1,
    "usage": {
      "cost_usd": 143.376669,
      "tokens": {
        "input": 6974347,
        "output": 394684
      }
    },
    "retro_usage": {
      "cost_usd": 0.942467,
      "tokens": {
        "input": 4,
        "output": 2310
      }
    }
  },
  "stats_total": {
    "merged": 5,
    "review_rounds_avg": 2.2,
    "plan_rounds_avg": 0.4,
    "implement_rounds_avg": 1,
    "escaped_defects": 4,
    "reverts": 0,
    "reverted_issues": [],
    "revert_rate": 0,
    "rejects_by_role": {
      "spec-conformance": 4,
      "qa": 4,
      "correctness": 4,
      "architecture": 1
    },
    "review_runs": 11,
    "findings_total": 13,
    "overlapping_findings": 5,
    "unique_findings_by_role": {
      "spec-conformance": 3,
      "qa": 4,
      "correctness": 1
    },
    "overlap_ratio": 0.38,
    "needs_human": 22,
    "qa_approvals": 3,
    "qa_claims_total": 16,
    "qa_na_total": 5,
    "qa_na_ratio": 0.24,
    "qa_na_heavy_approvals": 1,
    "usage": {
      "cost_usd": 334.235435,
      "tokens": {
        "input": 10336510,
        "output": 706521
      }
    },
    "retro_usage": {
      "cost_usd": 5.115177,
      "tokens": {
        "input": 10,
        "output": 10925
      }
    },
    "retros": 4
  },
  "deferred_proposals": [],
  "deletion_candidates": []
}
```
