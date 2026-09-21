# Retro State

- last retro: 2026-09-15T10:31:18.686Z
- merges since last retro: 0
- current N: 2

## History (last 5)

| at | yield | n_before | n_after | needs_human_since |
| --- | --- | --- | --- | --- |
| 2026-09-14T14:00:58.920Z | 0 | 1 | 1 | 6 |
| 2026-09-15T07:09:55.650Z | 2 | 1 | 1 | 2 |
| 2026-09-15T10:31:18.686Z | 0 | 1 | 2 | 1 |

## Stats

| metric | this window | cumulative |
| --- | --- | --- |
| merged | 0 | 3 |
| review rounds avg | 0 | 2 |
| rounds/issue (plan/impl/review) | 0 / 0 / 0 | 0 / 0 / 2 |
| escaped defects | 0 | 0 |
| revert rate | 없음 | 0.00 (0/3) |
| needs-human | 2 | 9 |
| rejects by role | 없음 | spec-conformance 2, qa 3, correctness 2 |
| reviewer overlap | 없음 | 0.14 (1/7, runs 6) |
| unique findings by role | 없음 | spec-conformance 2, qa 3, correctness 1 |
| qa na ratio | 없음 | 없음 |
| cost (usd) | 40.64 | 190.86 |
| tokens | input 216956 / output 20095 | input 3362163 / output 311837 |
| retro cost (usd) | 0.00 | 4.17 |
| retro tokens | input 0 / output 0 | input 6 / output 8615 |
| full retros | — | 3 |

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
    "last_retro_at": "2026-09-15T10:31:18.686Z",
    "last_record_offsets": {}
  },
  "merges_since": 0,
  "n": 2,
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
      }
    ]
  },
  "stats": {
    "merged": 0,
    "review_rounds_avg": 0,
    "plan_rounds_avg": 0,
    "implement_rounds_avg": 0,
    "rounds_per_issue": [],
    "escaped_defects": 0,
    "escaped_defects_detail": [],
    "reverts": 0,
    "reverted_issues": [],
    "revert_rate": null,
    "rejects_by_role": {},
    "review_runs": 0,
    "findings_total": 0,
    "overlapping_findings": 0,
    "unique_findings_by_role": {},
    "overlap_ratio": 0,
    "needs_human": 2,
    "qa_approvals": 0,
    "qa_claims_total": 0,
    "qa_na_total": 0,
    "qa_na_ratio": 0,
    "qa_na_heavy_approvals": 0,
    "usage": {
      "cost_usd": 40.640418,
      "tokens": {
        "input": 216956,
        "output": 20095
      }
    }
  },
  "stats_total": {
    "merged": 3,
    "review_rounds_avg": 2,
    "rejects_by_role": {
      "spec-conformance": 2,
      "qa": 3,
      "correctness": 2
    },
    "review_runs": 6,
    "findings_total": 7,
    "overlapping_findings": 1,
    "unique_findings_by_role": {
      "spec-conformance": 2,
      "qa": 3,
      "correctness": 1
    },
    "overlap_ratio": 0.14,
    "needs_human": 9,
    "qa_approvals": 0,
    "qa_claims_total": 0,
    "qa_na_total": 0,
    "qa_na_ratio": 0,
    "qa_na_heavy_approvals": 0,
    "usage": {
      "cost_usd": 190.858766,
      "tokens": {
        "input": 3362163,
        "output": 311837
      }
    },
    "retro_usage": {
      "cost_usd": 4.17271,
      "tokens": {
        "input": 6,
        "output": 8615
      }
    },
    "retros": 3
  },
  "deferred_proposals": [],
  "deletion_candidates": []
}
```
