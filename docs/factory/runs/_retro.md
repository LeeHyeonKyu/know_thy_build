# Retro State

- last retro: 2026-10-03T14:31:31.999Z
- merges since last retro: 0
- current N: 1

## History (last 5)

| at | yield | n_before | n_after | needs_human_since |
| --- | --- | --- | --- | --- |
| 2026-09-15T10:31:18.686Z | 0 | 1 | 2 | 1 |
| 2026-10-01T23:09:32.429Z | 0 | 2 | 1 | 13 |
| 2026-10-02T05:21:19.380Z | 0 | 1 | 1 | 3 |
| 2026-10-03T10:55:51.477Z | 1 | 1 | 1 | 16 |
| 2026-10-03T14:31:31.999Z | 1 | 1 | 1 | 10 |

## Stats

| metric | this window | cumulative |
| --- | --- | --- |
| merged | 0 | 12 |
| review rounds avg | 0 | 2.08 |
| rounds/issue (plan/impl/review) | 0 / 0 / 0 | 1 / 2.08 / 2.08 |
| escaped defects | 0 | 16 |
| revert rate | 없음 | 0.00 (0/12) |
| needs-human | 4 | 51 |
| rejects by role | 없음 | spec-conformance 7, qa 4, correctness 10, architecture 6 |
| reviewer overlap | 없음 | 0.53 (16/30, runs 31) |
| unique findings by role | 없음 | spec-conformance 3, qa 4, correctness 4, architecture 3 |
| qa na ratio | 0.33 (5/15 claims, na-heavy 0/2 approvals) | 0.21 (20/97 claims, na-heavy 3/13 approvals) |
| cost (usd) | 176.91 | 624.92 |
| tokens | input 2711591 / output 249728 | input 17203431 / output 1312904 |
| retro cost (usd) | 0.00 | 8.45 |
| retro tokens | input 0 / output 0 | input 22 / output 21249 |
| full retros | — | 7 |

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
    "last_retro_at": "2026-10-03T14:31:31.999Z",
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
    },
    {
      "at": "2026-10-02T05:21:19.380Z",
      "yield": 0,
      "needs_human_since": 3,
      "applied": [
        {
          "step": "feedback-route",
          "issues": [
            147
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
              "issue": 147,
              "count": 1
            }
          ]
        },
        {
          "step": "lessons:factory-builder",
          "added": [
            "L-2026-10-02-01",
            "L-2026-10-02-02"
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
              "text": "위치: 이번 diff가 새로 넣은 산문 가운데 엔진 동작을 단언하는 문장. #18에서는 README의 '리뷰 스테이지 안에서는 같은 `finish --issue 42` 줄이 커버리지 표를 찍고 exit 0이다', #143에서는 DECISIONS의 '병합 대기 중에는 가드가 미러 계열 경로를 세지 않는다'였다. 주장: 두 문장 모두 출하된 코드와 반대다. `finish`는 그 자리에서 exit 1로 끝나고, 가드는 `mirrorMatchesBranchHead`로 미러 경로를 비교한다. 근거: #18은 README의 다섯 줄을 적힌 …"
            }
          ],
          "skipped": [],
          "deferred": []
        },
        {
          "step": "publish-lessons",
          "pr": 164,
          "merged": false,
          "reason": "gh pr merge failed (1): X Pull request LeeHyeonKyu/know_thy_build#164 is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.\nTo use administrator privileges to immediately merge the pull request, add the `--admin` flag.",
          "files": [
            ".factory/lessons/factory-builder.md",
            ".claude/agents/reviewer-qa.md"
          ]
        }
      ],
      "n_before": 1,
      "n_after": 1
    },
    {
      "at": "2026-10-03T10:55:51.477Z",
      "yield": 1,
      "needs_human_since": 16,
      "applied": [
        {
          "step": "feedback-route",
          "issues": [
            174,
            156
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
              "issue": 156,
              "count": 1
            }
          ]
        },
        {
          "step": "lessons:factory-builder",
          "added": [
            "L-2026-10-03-01",
            "L-2026-10-03-02",
            "L-2026-10-03-03",
            "L-2026-10-03-04"
          ],
          "rejected": [],
          "evicted": [],
          "cited": []
        },
        {
          "step": "publish-lessons",
          "pr": 182,
          "merged": false,
          "reason": "gh pr merge failed (1): X Pull request LeeHyeonKyu/know_thy_build#182 is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.\nTo use administrator privileges to immediately merge the pull request, add the `--admin` flag.",
          "files": [
            ".factory/lessons/factory-builder.md"
          ]
        },
        {
          "step": "proposals",
          "deferred": [
            {
              "kind": "role-change",
              "title": "builder Lens 5·implement 프롬프트의 'Scope change는 PR 본문에'를 spec-conformance Lens 2('diff 자체에, PR 본문 아님')와 일치시킨다",
              "reason": "insufficient-evidence: 4 distinct runs < 10 (role-change)"
            }
          ]
        },
        {
          "step": "publish-proposal",
          "pr": 183,
          "reason": null,
          "proposals": [
            "gate"
          ]
        }
      ],
      "n_before": 1,
      "n_after": 1
    },
    {
      "at": "2026-10-03T14:31:31.999Z",
      "yield": 1,
      "needs_human_since": 10,
      "applied": [
        {
          "step": "feedback-route",
          "issues": [
            184,
            178,
            176,
            168
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
              "issue": 178,
              "count": 8
            },
            {
              "kind": "product",
              "step": "feedback-route",
              "issue": 168,
              "count": 1
            }
          ]
        },
        {
          "step": "lessons:factory-builder",
          "added": [
            "L-2026-10-03-01",
            "L-2026-10-03-02",
            "L-2026-10-03-03"
          ],
          "rejected": [],
          "evicted": [],
          "cited": []
        },
        {
          "step": "role:reviewer-correctness",
          "added": [
            {
              "section": "## Perspectives",
              "text": "**기록을 코드처럼 읽는 눈**: diff가 DECISIONS/ADR/README/주석에 엔진 동작을 단언하는 문장을 넣었다면 그 문장을 단언문으로 다룬다 — 그 동작을 지키는 테스트 id를 찾고, 없으면 문장이 말하는 경로(설정 분기·실패 1회·파일 부재)를 코드에서 직접 따라가 문장과 대조한다. 거짓인 결정 기록은 다음 이슈의 plan이 근거로 인용한다."
            }
          ],
          "skipped": [],
          "deferred": []
        },
        {
          "step": "publish-lessons",
          "pr": 190,
          "merged": false,
          "reason": "gh pr merge failed (1): X Pull request LeeHyeonKyu/know_thy_build#190 is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.\nTo use administrator privileges to immediately merge the pull request, add the `--admin` flag.",
          "files": [
            ".factory/lessons/factory-builder.md",
            ".claude/agents/reviewer-correctness.md"
          ]
        },
        {
          "step": "publish-proposal",
          "pr": 191,
          "reason": null,
          "proposals": [
            "gate"
          ]
        }
      ],
      "n_before": 1,
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
      },
      {
        "role": "spec-conformance",
        "text": "A change to an existing shared test helper sits outside plan files_expected. The Scope change reason in the diff is not tied to issue #157's scope, and the diff does not record it as a scope change.",
        "runs": [
          157
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "The new recovery path ignores the runner notification's <status>. A failed, killed or cancelled Workflow's output file can therefore become the stage handoff that decides the merge. That contradicts the rule this same function states and applies to path (1): 'completed만 본다 — failed/cancelled 알림의 <result>는 산출물이 아니다'. The same runner bytes are refused when they arrive inline but accepted when read from disk.",
        "runs": [
          170
        ],
        "source": "must_fix"
      },
      {
        "role": "security",
        "text": "A reviewer subagent can make an arbitrary file it wrote into the stage verdict. It does this by putting a forged `<\\task-notification>` inside its own output text. That text reaches the runner's genuine user-turn notification through `<result>`. The parser matches the forged block and reads its `<output-file>` path. The only binding is task-id equality. The path is never bound to that task id: nothing requires it to be `<scratchpad>/tasks/<taskId>.output`. Nothing stops a second notification block from being carved out of the `<result>` body of a real one. Before this diff, reviewer-controlled text inside `<result>` could at most break candidate (1). It could never name a file to be trusted. This breaks dw2's own rubric: \"A file the model merely mentions or wrote never decides a merge.\"",
        "runs": [
          170
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "dw2 says a file the model merely mentions or wrote never decides a merge, and the implementation does not hold that. The path is bound only to the task id, never to the runner's own scratchpad file for that task. In addition, the notification's status is ignored, which contradicts the 'completed only' rule that path (1) applies at line 429.",
        "runs": [
          170
        ],
        "source": "must_fix"
      },
      {
        "role": "security",
        "text": "Candidate (1b) treats the bytes at the receipt-bound path as the runner's verdict. That path is under /tmp, and the write-deny hook explicitly lets every reviewer write there. Any reviewer subagent in the review Workflow can therefore replace the whole review.v1 handoff: all roles approve, must_fix empty, overriding the reject that another reviewer actually returned. Before this diff, a reviewer controlled only its own verdict, plus whatever text the model passed on to the dispatcher. The binding work (receipt Task ID, user-turn header, tool-use-id) proves that the runner named the path. It does not prove the file still holds the runner's bytes when verify reads it. That breaks CLAUDE.md SDD rule 5: verdicts must be anchored only to runner records or facts that agents cannot write.",
        "runs": [
          170
        ],
        "source": "must_fix"
      },
      {
        "role": "architecture",
        "text": "The diff adds a second parser for the same runner `<\\task-notification>` message, and it already disagrees with the first one on both format and trust. The old path was left in place. The new parser reads the real Claude Code 2.1.287 attachment form (`type:\"attachment\"`, `attachment.type:\"queued_command\"`, `commandMode:\"task-notification\"`). It accepts only user/attachment lines and parses only the header, because its own comments say assistant-authored text and forged `<\\/task-notification>` blocks inside `<result>` are not the runner's. The old parser still feeds candidate (1), which runs first and wins whenever it validates. It reads only `o.message.content`, so it never sees an attachment-line notification. It accepts any role and regex-scans whole blocks. So the repo now has two answers to 'what is a runner notification', and the format change has already reached only one of them. That is the 'second copy, one side fixed' future, and it has already started.",
        "runs": [
          170
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "The diff adds a file-time freshness check (kernel ctime must not be later than the notification timestamp plus 1000 ms). plan non_goals lists this exact thing.",
        "runs": [
          170
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "A file is recoverable only through a runner notification with a timestamp. A receipt alone names no file. This contradicts dw1/dw2, which make the receipt's Task ID the anchor.",
        "runs": [
          170
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "A new file outside files_expected was added. The diff has no 'Scope change' reason.",
        "runs": [
          170
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "A file outside files_expected was added with no Scope change reason in the diff.",
        "runs": [
          170
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "The output file is rejected when its ctime is later than the runner notification timestamp. That is a file-time freshness check, which the plan lists as a non-goal. The correctness reviewer's cf-s1 also shows this check is the only gate on the production path and was not observed for a Workflow task.",
        "runs": [
          170
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "A receipt alone no longer makes a file eligible, and dw1's wording requires that it does.",
        "runs": [
          170
        ],
        "source": "must_fix"
      },
      {
        "role": "architecture",
        "text": "The new `blockedRetryPendingRun` builds a third hand-copied parser regex for the blocked-retry marker. The grammar is written in one place (`blockedRetryComment`, line 97), but it is now read by three separate regex literals that must change together. The role lens treats a third copy as an automatic must_fix.",
        "runs": [
          168
        ],
        "source": "must_fix"
      },
      {
        "role": "architecture",
        "text": "`scrubId` is another copy of the scrub-and-cap rule for public test names. gates.js already has that rule as the private `secretsFrom` + `scrubOne` (gates.js:100-101). This diff copies it inline instead of exporting the one that exists. The copy also hardcodes `process.env`, while gates.js can take an injected `env`. So the run-record test ids and the gates-detail names now come from two separate implementations of what is supposed to be one rule.",
        "runs": [
          157
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "The diff changes gates.js code and adds a new field to the factory.gates.v1 gate entries. Plan non_goals forbid both: 'Changing the factory.gates.v1 schema' and 'Moving the re-run policy into gates.js (gates.js gets comment edits only)'. dw6 also says 'with no code change in gates.js'.",
        "runs": [
          157
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "Three paths are outside plan files_expected and are not named in the diff's 'Scope change' sentence: changed-files.js (the new `touched` field and a `paths` field on each row), parsers.test.js, and the design spec §5.2.5 edit.",
        "runs": [
          157
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "The re-run reads the first run's stale test report when the re-run's test command does not write one. That stale report then counts as a second RED on the same id set, so the stage writes the 'PR 밖의 테스트가 두 번 RED — flaky 후보' reason and a `factory-flaky-candidate` RED marker for a test that never ran the second time. This breaks dw2's rubric, which allows the wording and marker only when the identical id set fails twice. It also puts false evidence into the durable run record.",
        "runs": [
          157
        ],
        "source": "must_fix"
      },
      {
        "role": "qa",
        "text": "The re-run reads the first run's stale test report. If the re-run's test command writes no report, the stale report is parsed again, the same id set looks RED twice, and the stage writes the flaky-candidate wording and marker for a test that did not run the second time. This is the same defect as cf1. I re-checked the code in round 2 and it holds.",
        "runs": [
          157
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "The arm decides whether \"a release happened since\" by checking that two versions are unequal. Both versions come from whatever checkout ran the sweep, and the quick sweeps at the end of stage jobs read an out-of-date `.factory/install-manifest.json`. A stale reader is treated as a new release. The arm then retries an issue on the same engine that just failed it, which is the waste this issue exists to stop. dw3 only rules out treating an *unknown* version as different. A stale version (older than main) gets through.",
        "runs": [
          156
        ],
        "source": "must_fix"
      },
      {
        "role": "architecture",
        "text": "The new `sweepRetryOnRelease` adds a third copy of the per-sweep back-pressure cache helper (`let bpCache; const parked = async () => { ... bpCache ??= ...backPressure() ... }`). The copies have already drifted apart, so the next fix to one copy will miss the others. The role rule says a third copy is an automatic must_fix.",
        "runs": [
          156
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "A file outside files_expected changed with no 'Scope change' rationale in the diff.",
        "runs": [
          156
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "A test file outside files_expected was changed, with no Scope change rationale.",
        "runs": [
          156
        ],
        "source": "must_fix"
      },
      {
        "role": "security",
        "text": "The agent actor can forge the `factory/veto-window` status for its own head sha. If it sets `closes=` to a time in the past, the merge stage takes the 'reuse' branch: it never posts the auto-merge notice, polls once, and merges. The owner is never told and gets no window to veto in. This breaks the security premise of dw4/dw5 ('the owner is told when and how to stop the merge').",
        "runs": [
          149
        ],
        "source": "must_fix"
      },
      {
        "role": "security",
        "text": "With the switch on, the engine repo's merge job runs PR-authored code (the non-judge test files and the modules they import) for the first time, and it does so while the parent process holds GH_TOKEN=FACTORY_MERGE_TOKEN. That hands the merge actor's credential (ADR-021) to code the agent wrote.",
        "runs": [
          149
        ],
        "source": "must_fix"
      },
      {
        "role": "architecture",
        "text": "The diff adds a second and third copy of the check \"is this commit status posted by a factory login\", and the copies already disagree. The repo's own rule for that check, written into verifyFactoryStatuses, is that it must live in one function. Under this lens a third copy is an automatic must_fix.",
        "runs": [
          149
        ],
        "source": "must_fix"
      },
      {
        "role": "architecture",
        "text": "This diff adds a second positive list of 'non-judge' paths. The merge-base already has one (`OPERATOR_MERGE_GLOBS` in lib/operator-merge.js), and the diff neither merges the two nor records why they stay apart. The two lists already disagree about the same files. The base code and ADR-032 both promise that the lists become one when #149 lands, so after this merge that promise is false and the repo has two contradicting answers to 'is this path judge?'.",
        "runs": [
          149
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "Files outside plan files_expected were changed with no 'Scope change' notice in the diff. requirements.js gains a new gate-evidence branch (STATUS_GATES_UNVERIFIED, gatesFromStatuses) that changes how factory:merged is decided. The only explanation is a prose paragraph in DECISIONS.md, which is not labelled as a scope change.",
        "runs": [
          149
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "The review-evidence record format and its parser were changed (new optional gates= field, parseReviewEvidenceAll and shape comparison). This is outside files_expected, outside the issue and outside every done_when. It extends a shared record contract that other stages parse.",
        "runs": [
          149
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "Tests for the unplanned gate-evidence mechanism are filed under done_when verify ids. test_149_veto_window_opens_waits_and_closes (dw4) is made to cover a requirements.js gate rule, review-line gates= recording and forged-status handling. dw4's text does not mention any of these. This stretches the 1:1 id-to-assertion mapping so that out-of-scope behaviour looks like it belongs to dw4.",
        "runs": [
          149
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "dw3 says that after a successful restart the new author gets a full K review rounds. That breaks after a single genuine label-swap failure anywhere in the requeue window. The failure path is not forged; it is the `factory-transition-failed` case that dw3 itself pins. The 2K ceiling counts attempts with `honourFailed:false`, so the failed transition counts as a used slot, and the new author is stopped at round K-1 with reason '2K ceiling'. The ADR text says the new author loses a round only with 'two or more' failures in a window ('한 창에 둘 이상이면 새 작성자가 라운드를 잃는다'). That is wrong: one failure is enough. So both the spec claim (dw3) and the recorded decision are false on a path the tests cover.",
        "runs": [
          174
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "The new escalation for 'dispatched run never started' calls transition() without `engineVersion`. The default escalation path just below (lines 1659-1661, added by #156 and kept by merge a6f9c79) attaches it. For an issue with cause=undecidable, engineCausedNeedsHuman() still treats this needs-human as engine-caused, because the reason starts with 'blocked (' and the origin cause is undecidable. But it reads thenVersion=null. sweepRetryOnRelease then skips it every time with 'no recorded engine version for the needs-human transition'. So the ADR-032 self-retry on a new engine never happens for any blocked issue that reaches needs-human through the ceiling.",
        "runs": [
          168
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "The cf1 stale-report guard does not work when a test report path is outside the repo root. In that case a re-run that writes no report is labelled 'RED twice / flaky candidate' instead of 'inconclusive'. ADR-034 says the opposite: lines 34-35 state that a re-run which wrote no report is inconclusive because resetGates deletes the first report, and the code comment at merge-stage.js:647-652 makes the same claim. For this supported configuration both are false.",
        "runs": [
          157
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "The operator-merge door drops the engine distinction, so in every adopter repo it now allows operator-session merges of the adopter's protected installed engine files with no human. isNonJudgePath takes no engine argument, and operator-merge-check passes none. An adopter's operator session can therefore merge a PR touching .factory/lib/status.js or .factory/lib/board-static.js, and the adopter's own factory/lib/status.js and factory/lib/board-static.js, when checks are green. The same module's classifyProtected says these are judge in a non-engine repo (engine !== true makes everything judge, because in an adopter 'factory/** is not the engine'). Before this diff, the adopter door allowed only docs/** and templates/factory/docs/**. This contradicts the issue's statement 'this issue changes no repository's merge behaviour' and the adopter L1 rule that a PR touching a protected path is merged by a person.",
        "runs": [
          178
        ],
        "source": "must_fix"
      },
      {
        "role": "architecture",
        "text": "The diff defines two classifiers for one list, and they give different answers. `classifyProtected(files, {engine})` applies the module's own rule: unless engine is true (an adopter repo), every path is judge. `isNonJudgePath` has no engine gate. The one live consumer, `operatorMergeVerdict`, which `.factory/bin/operator-merge-check.js` calls from the `gh pr merge` hook, uses the ungated one. This PR widened the list to include installed engine files. As a result, in every adopter repo a PR that edits `.factory/lib/status.js` or `.factory/lib/board-static.js` now passes the operator-merge door with no person merging it. That contradicts `.factory/**` being in `[protected].factory`, the human-merge boundary. In this repo, the same path lets a hand-edited runner-owned mirror through. 'The list is one' holds for the globs, but the semantics have split.",
        "runs": [
          178
        ],
        "source": "must_fix"
      },
      {
        "role": "architecture",
        "text": "One run of the door now gets repository identity from two places. `gh pr view` (line 21, no `cwd` option) and the harness default_branch read (line 28, relative path `.factory/harness.toml`) both follow the process cwd. The new engine decision (lines 35-38) follows the bin's own location, `root = new URL(\"../../\", import.meta.url)`. So the engine/adopter switch can be computed for a different repository than the one whose PR is being classified. In the direction that matters, it widens. With the bin in the engine checkout (the hook runs `$CLAUDE_PROJECT_DIR/.factory/bin/...`) and the session cwd inside an adopter clone, the adopter's PR is judged with engine=true. Its `.factory/lib/status.js` or `.factory/lib/board-static.js` changes (the adopter's installed engine, which is `[protected].factory` and merged by a person) then classify as non-judge and the operator is allowed to merge them.",
        "runs": [
          178
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "The door fails open on PRs with more than 100 changed files. gh 2.101.0 fetches `files(first: 100)` and asks for no pageInfo, so it never paginates. Any judge path after the 100th entry is never classified, and the bin reports 'all non-judge paths' and exits 0. This breaks the guarantee the door exists for, in both adopter and engine mode, and this PR rewrites that bin and its stated contract.",
        "runs": [
          178
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "Renames hide the source path from the door. GitHub's PullRequestChangedFile gives only the new `path`, with changeType RENAMED and no previous path. A rename that moves a judge file to a non-judge name is classified only by its destination. So the door lets an operator session remove docs/factory/CHARTER.md, or a judge module such as factory/lib/gates.js, without a person.",
        "runs": [
          178
        ],
        "source": "must_fix"
      },
      {
        "role": "architecture",
        "text": "`NON_JUDGE_EXCLUDES` holds a third hand-copied, unpinned list of the session-instruction globs (`**/CLAUDE*.md`, `**/AGENTS*.md`, `**/.mcp*.json`). This list now decides whether the operator-merge door lets a session-injection file through. If a new instruction-file name is added to the canonical set and not to this copy, `docs/<NewName>.md` becomes operator-mergeable without anything going RED.",
        "runs": [
          178
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "A file outside files_expected was changed with no Scope change reason in the diff, and the change alters the operator-merge door's behaviour, which the issue and non_goals forbid.",
        "runs": [
          178
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "The operator-merge verdict gained new refusal rules and an engine-context split that no done_when or files_expected entry promises. isOperatorMergePath is no longer the same answer as the list.",
        "runs": [
          178
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "The bin is outside plan files_expected and the diff carries no Scope change reason for it. The prior ruling was uphold and is still open.",
        "runs": [
          178
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "The new tamper refusal in (1b) is silently overridden. When the runner's inline <result> is truncated and the output file was rewritten after the notification, (1b) rejects the file as 'changed after the runner's notification' and removes only its own candidates. If the dispatcher then reads the same tampered file in full (an unpaged `Read`, or `jq -c .result <path>` / `cat`), path (2) or the tool-result loop pushes those exact bytes. They are skipped only when `isFragment(text)` is true, and the final loop returns them with ok:true and empty reasons. A forged verdict therefore wins, and the refusal line is thrown away. This breaks the PR's own rework-sec1 property (stage-artifact.js:283 and run-stage.js:153: the bytes must still be the runner's). It also breaks dw4's rubric 'No refusal falls back silently'. On main the same full read was accepted too, so this is not a regression against main. But this PR is what claims the file is now bound, and it already holds the runner's inline prefix that contradicts the forged candidate.",
        "runs": [
          170
        ],
        "source": "must_fix"
      },
      {
        "role": "security",
        "text": "In the case this change exists to recover (a review.v1 result too long for the runner's inline <result>, so the inline copy is truncated), everything after the inlined prefix becomes the stage verdict. That tail is checked only by ctime <= notification timestamp + 1000 ms. The file lives in /tmp/claude-<uid>/<cwd-slug>/<session>/tasks/<id>.output. Every reviewer agent runs as the same uid, has Bash, and deny-all-writes.sh explicitly lets Bash write anywhere under /tmp. So a reviewer (for example one prompt-injected by the PR diff it is reviewing) can start a background shell loop. The loop waits for the .output file to appear, keeps the prefix, and rewrites the tail, for example turning a later reviewer's \"verdict\":\"reject\" into \"approve\". It finishes within the window, which passes both checks. This is new. On main, the review dispatcher cannot read that file at all (.claude/commands/factory-review.md allowed-tools: `Workflow(factory-review), Read(.factory/out/loaded.json)`), so a truncated review result always failed closed to needs-human. I said otherwise in round 1, and that was wrong for the review stage. The diff turns that fail-closed case into an accepted verdict whose decisive bytes a reviewed agent can write.",
        "runs": [
          170
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "A revert made with GitHub's own Revert button is skipped without any message whenever the revert PR's squash commit takes the PR title. In that case the breaker never opens, which is the fail-open this issue is meant to prevent. The squash commit takes the PR title when the repo's squash_merge_commit_title is PR_TITLE, or when it is COMMIT_OR_PR_TITLE and the revert PR has more than one commit. The engine ships to other repos through install-manifest, so the result depends on a repo setting the code never checks. The ADR's 'remaining risk' covers hand-written and edited titles. This case is neither: it is GitHub's default Revert flow, unedited.",
        "runs": [
          189
        ],
        "source": "must_fix"
      },
      {
        "role": "security",
        "text": "The breaker state file can be planted by an agent session and is then pushed by the runner. A planted state with a future closed_at keeps the breaker closed for good, so dw3/dw4's claim that only a person closes it is false. Two gaps combine. (a) Write side: syncRecords at the end of every stage uses the default dir docs/factory/runs and walks it recursively. Any docs/factory/runs/state/breaker.md in the runner's worktree is uploaded with the run records. If the branch has no such file yet, the file is hashed verbatim (attempt() tail-merges only when the parent already has the path). The branch has no such file until the first sweep-open or the first reset. The only barrier is the runner_only hook/L2 deny. The hook prot regex matches the literal substring `docs/factory/runs/` and has no cd handling. (b) Read side: closed_at is checked only with isIso (Date.parse finite). Nothing compares it to the current time or to the newest revert. Every revert with t <= closed_at is dropped, and readBreaker returns ok:true, open:false with no error. The project already reproduced this exact channel for review evidence and judged the write boundary alone insufficient: an implement agent planted a fake run-record section and syncRecords pushed it (review-quorum.js:31-37). The fix there was to bind the line to the run id. The breaker state has no equivalent binding.",
        "runs": [
          189
        ],
        "source": "must_fix"
      },
      {
        "role": "security",
        "text": "This upgrades my round-1 sec-s1 from should_fix. In round 1 I said I found no reachable channel to forge a self-merge line. That was wrong: I traced only the merge-stage record() calls and missed the agent-planted local file. The same sec1 channel lets an agent append a forged `## merge · …` section with `factory-self-merge:v1` lines to any issue record. Its own record is hydrated locally at stage start. Another issue's record gets tail-merged after the common prefix. The parser accepts the line from any `## merge` header, with no run id, runner or stage-run binding. buildHistory keeps the earliest line per PR, so a forged line `{pr:<real judge PR>, kind:\"non_judge\", at:<earlier than the real merge>}` takes that PR out of the judge streak. A forged unreverted judge merge dated between two reverted ones breaks the streak. Either way the breaker fails open. review-evidence lines are bound to run_id for exactly this reason (review-quorum.js:31-37), and self-merge lines are not.",
        "runs": [
          189
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "No test checks the production wiring that keeps gh client failures out of engine-crash. If `dependencyClient(...)` is removed from main(), every test still passes, and a gh error-shaped response that throws TypeError inside gh.js (e.g. `.object.sha` on `{\"message\":\"Not Found\"}`) gets classified as engine-crash. That run's cost then leaves the lifetime budget and the issue escalates as an 'engine defect'. This is the dw1 rubric's 'never from a dependency/infra Error' failing silently.",
        "runs": [
          196
        ],
        "source": "must_fix"
      },
      {
        "role": "security",
        "text": "The new engine_crash flag removes a run's cost from the lifetime budget cap. Text an agent controls can still forge it, which breaks the issue's own invariant that agents get no self-report and engine-crash comes only from code paths. Both forgery guards fail. Guard 1, the writer-side quoting, only handles `[ \\t]*` before `engine-crash:`. The parser later calls `.trim()` on every line, which also strips NBSP, \\v, \\f, \\r and U+2028, so `\\n engine-crash:` is not quoted but still parses as a crash line. Guard 2, the position plus same-runner check, compares the crash line against the section header. That header is also forgeable from the same text, because HEADER_RE is `^...$` with /m and agent text with embedded newlines lands verbatim in appendRunRecord. The forged section then includes the runner's real `usage:` line that follows it in the same record() call, so that run's real cost moves into engineUsd.",
        "runs": [
          196
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "A triage-stage engine crash is never escalated. The engine-crash retry loop has no bound for triage, and with this diff every loop's cost is also excluded from the lifetime budget cap. So nothing ever stops the loop. This contradicts the diff's own contract: the sweeper.js doc comment says ENGINE_CRASH_MAX_RETRIES is 'the only brake', and ADR-035 says the same.",
        "runs": [
          196
        ],
        "source": "must_fix"
      },
      {
        "role": "security",
        "text": "The builder agent's own implement handoff can raise a TypeError in engine code. isEngineCrash then labels that run an engine crash, and the implement run's full cost moves out of the lifetime budget cap. Before this diff, that run's cost counted against the cap. The ADR-035 premise that a TypeError, ReferenceError or RangeError not raised by a dependency is an engine bug does not hold: LLM output (and issue text that prompt-injects the builder) can choose to fail this way. No error raised while handling agent artifacts gets the dependency mark.",
        "runs": [
          196
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "In production every must_fix row will say 'unanswered', even when the builder answered it. The factory posts rework responses as comments on the PR, but the evidence dependency reads only the tracking issue's comments. That puts a false statement into the PR body, which breaks dw3 ('fixed' + sha on the matching row) and the issue's own goal.",
        "runs": [
          195
        ],
        "source": "must_fix"
      },
      {
        "role": "architecture",
        "text": "The new `editComment(id, body, { signal })` is a second gh-adapter method for an operation the adapter already has. `patchComment(commentId, body)` at gh.js:454 runs the same PATCH. The two copies have already diverged: only the new one takes an AbortSignal. The PATCH path now has two truths. A later fix to error handling, timeout or retry will land in one copy and not the other. Every fake gh in the tests (heartbeat, sweeper and status suites use `patchComment`) now has to guess which name the code under test calls.",
        "runs": [
          195
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "exec.js is changed outside files_expected and the diff carries no 'Scope change' reason.",
        "runs": [
          195
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "dw3 ('fixed' + sha on the matching must_fix row) is not met in production. The test passes, but the wiring reads rework responses only from the issue's comments.",
        "runs": [
          195
        ],
        "source": "must_fix"
      },
      {
        "role": "architecture",
        "text": "`RECORD_SECTION` is a third copy of the run-record section-header grammar (`## <stage> · <at> · <runner>`), and it already differs from the other two. It is also the one place the header is used to bind evidence, for the budget/cost row in `boundBudget`, lines 161-168.",
        "runs": [
          195
        ],
        "source": "must_fix"
      },
      {
        "role": "architecture",
        "text": "The run count re-inlines the heartbeat head regex in the same file that already imports `parseHeartbeat`. The heartbeat module documents that the writer and the reader of this format stay in one file.",
        "runs": [
          195
        ],
        "source": "must_fix"
      },
      {
        "role": "architecture",
        "text": "makePrEvidenceDeps rebuilds the run-record path from a literal: `join(root, \"docs/factory/runs\", `${issue}.md`)`. This is the fourth independent copy of the writer's path rule. The comment two lines above (2173-2174) says the path \"is the writer's … and cannot drift to another one\", and that is not true. Nothing ties this copy to `recordPath` in run-record.js. If the writer's path changes, this reader gets `existsSync` false and returns null. buildEvidence treats null as \"no source\", so every record row (review rounds, self-gate, proof, cost) drops out with no FAIL line. The section is still published and looks valid.",
        "runs": [
          195
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "A file outside files_expected was changed, and the diff gives no Scope change reason.",
        "runs": [
          195
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "A non_goal was crossed. Evidence is now published on needs-human routes that bypass handToHuman.",
        "runs": [
          195
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "dw5 says publishing happens 'exactly once per merge run', but on the veto route evidence is published twice. The test was written around that.",
        "runs": [
          195
        ],
        "source": "must_fix"
      },
      {
        "role": "security",
        "text": "A builder can choose a PR title that stops the breaker from counting a revert. `parseRevertCommits` trusts any `(#N)` inside the quoted part of a revert subject first (via \"subject\"). It never reaches the body evidence from GitHub (`This reverts commit <sha>` / `Reverts owner/repo#N`). In the GitHub Revert-button flow with a PR_TITLE squash subject, the quoted part is the builder-written PR title, not the squash subject. So a `(#K)` in that title sends the revert to the wrong PR K. The reverted judge auto-merge then looks unreverted and on main, and it breaks the streak. The breaker stays closed and judge-path auto-merge goes on.",
        "runs": [
          189
        ],
        "source": "must_fix"
      },
      {
        "role": "spec-conformance",
        "text": "The diff changes factory/bin/retro.js, which is not in files_expected. It also adds a records-upload guard (makeRecordsUploadGuard, makeMergeAbortVouch, syncRunRecords) that rewires the stage-end and abort syncs in run-stage.js and the retro sync. No done_when covers this work and the diff carries no explicit 'Scope change' statement.",
        "runs": [
          189
        ],
        "source": "must_fix"
      },
      {
        "role": "correctness",
        "text": "The breaker fails open when the post-merge evidence is lost. A judge-path auto-merge records itself in exactly one place: the local run record. That record reaches factory/records through one stage-end syncRecords push, which has a single internal retry. If that push fails or throws, run-stage only logs it with console.error, and it also writes a 'run-record sync: failed' line into the same local file that never got uploaded. On the ephemeral runner that file is then gone. Nothing retries, and no later stage for that issue re-uploads it, because the issue is closed. When the PR is reverted later, the breaker never counts it: parseRevertCommits does attribute the revert to PR #N, but buildHistory has no auto-merge event for #N, and evaluateBreaker only builds windows from known judge merges. The revert is not even listed in readBreaker's detail, because the 'not attributable' count only covers reverts that could not be tied to any PR, and this one was tied to a PR. Two real consecutive judge reverts can leave the breaker reporting {ok:true, open:false}. The same thing happens on the abort path. There the guard has an empty trust set, so a line survives only if makeMergeAbortVouch's gh.prView confirms MERGED/headRefOid. A prView failure drops the line, and the merge disappears from the evidence. The core property (open after revert_streak judge reverts) therefore rests on a best-effort push whose failure is never surfaced. dw5 treats unreadable state as not-closed, but missing evidence is read as 'no merge happened'.",
        "runs": [
          189
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
      },
      {
        "role": "skeptic",
        "kind": "good",
        "text": "Listing 'running classifyFailures at merge' as a non-goal throws out the cheapest and strongest alternative without weighing it. The repo already has a runner-only flaky classifier, and review adopted it for exactly this incident class: own-calendar #49, an approved PR that went RED on an unrelated intermittent test. That classifier runs isolation reruns (flaky_isolation_runs=3) and base reruns (flaky_base_runs=5). It is capped by flaky_max=2, and it files a `factory:flaky` issue on the first detection, which the existing harvester reads. Turning it on for merge would deliver both halves of the issue's Why, unblocking the merge and harvesting the flake, without a new directory heuristic, a new marker vocabulary with no reader, a second d.gates() call, or a stale-status problem. The only recorded reason merge was excluded is that merge 'doesn't call agents'. classifyFailures doesn't call agents either, so that reason does not hold. Required change: the plan must either adopt this approach (one condition in gates.js plus a gates test), or record in non_goals/open_risks why one blind rerun is better than 3 isolation runs plus 5 base runs.",
        "runs": [
          157
        ],
        "source": "dissent"
      },
      {
        "role": "skeptic",
        "kind": "good",
        "text": "dw1 and dw2 lock in the issue's false premise that 'merge는 한 런뿐이라 영원히 모이지 않는다' and that a new marker is how the harvest gets fed. The existing flaky path does not need multiple runs. It opens a `factory:flaky` issue on the first classification. A marker with no reader, which the product-advocate admits is the case, means that six months from now a real DB race in own-calendar (`test_49_event_visibility` is about event visibility, which may be a product race rather than a test bug) gets auto-merged past again and again, and nobody gets a ticket. That is this plan's most expensive failure: a product race condition, hidden by green-after-rerun, with no issue filed. It must go into open_risks, and the green-after-rerun path must produce something a person or the harvester will actually see.",
        "runs": [
          157
        ],
        "source": "dissent"
      },
      {
        "role": "operator",
        "kind": "good",
        "text": "Having the 'has this cycle used its restart' check accept a marker from any author is not purely fail-safe once a mistaken needs-human costs a human request. And the cycle boundary 'since last requeue' alone ignores a human --retry. The operator's --retry produces a by=human transition without a requeue, so the restart budget would not come back and the factory would go straight to needs-human right after the human acted. Product-advocate's dw4 (budget restored after a human retry) is needed and the architect's boundary is missing it.",
        "runs": [
          174
        ],
        "source": "dissent"
      },
      {
        "role": "product-advocate",
        "kind": "good",
        "text": "dw4 ('a human --retry restores the self-restart') — product-advocate's R1 position that the restart budget belongs to a cycle reset by a human --retry or requeue; architect and skeptic objected in R2 and product-advocate did not concede it.",
        "runs": [
          174
        ],
        "source": "dissent"
      },
      {
        "role": "synthesizer",
        "kind": "good",
        "text": "The re-read narrows the race but does not close it. A label change between `gh.issue(n)` and `transition()` (milliseconds instead of the index's 7+ seconds) can still escalate a rework issue.",
        "runs": [
          176
        ],
        "source": "dissent"
      },
      {
        "role": "skeptic",
        "kind": "good",
        "text": "The ceiling's reason text says 'dispatched run never started'. A run that did start (in_progress) and is still going past 2 x staleMinutes would be escalated with a false reason.",
        "runs": [
          168
        ],
        "source": "dissent"
      },
      {
        "role": "skeptic",
        "kind": "good",
        "text": "The retry-and-dispatch branch (sweeper.js:1548-1585) does not get the wait. For api-error (up to API_ERROR_MAX_RETRIES), a sweep that runs while attempt N is queued dispatches attempt N+1. That spends retry budget on runner occupancy and can displace the pending run in the per-issue concurrency group. On that path the #111 race moves but does not go away.",
        "runs": [
          168
        ],
        "source": "dissent"
      },
      {
        "role": "skeptic",
        "kind": "good",
        "text": "Nobody has shown that the motivating own-calendar #124 transcript contains a completed runner notification for wf086hvld in either form, yet that is now a precondition for recovery. The only real transcript evidence for a notification is a different repo and a different stage, so it cannot stand for #124.",
        "runs": [
          170
        ],
        "source": "dissent"
      },
      {
        "role": "skeptic",
        "kind": "good",
        "text": "This position and the other two leave out the most expensive failure. 'Outside the diff' is decided by where the test file lives. It does not tell you whether the PR caused the failure. Suppose a PR changes only src/ and that change plants a race condition in a test file the PR never touched. The race fails some of the time, the single re-run passes by luck, and the PR merges. A merge cannot be undone. The re-run turns 'the PR introduced nondeterminism' into an automatic merge.",
        "runs": [
          184
        ],
        "source": "dissent"
      },
      {
        "role": "skeptic",
        "kind": "good",
        "text": "The re-read narrows the race but does not close it. There are two remaining gaps. gh.setFactoryLabel adds the new label before it removes the old one (gh.js:381-384), so a read taken during the swap can see both labels. Also, comments(), releaseIfStale and engineVersionNow all run between the read and transition(), and transition.js:112 re-reads labels but has no expected-from check.",
        "runs": [
          176
        ],
        "source": "dissent"
      },
      {
        "role": "skeptic",
        "kind": "good",
        "text": "You list the unproven #124 notification as a risk but offer no step to close it, so dissent d-sk-124-notification stays 'unresolved — proceeding' a third time. The fix may ship and never fire for the incident that motivated it, and nobody owns finding out. A clearer needs-human reason is not the outcome the issue asked for ('판정이 이미 있는데 사람에게 가는 경우를 없앤다'). Smaller step I propose: the release notes and the ledger state that recovery is unproven for own-calendar #124. The controller must also either pull the #124 orchestrator transcript and check it for a completed wf086hvld notification before release, or record that the first live max-turns run's dw4 reason line will be read by a person. If neither happens, the issue should not be closed as fixed.",
        "runs": [
          170
        ],
        "source": "dissent"
      },
      {
        "role": "skeptic",
        "kind": "good",
        "text": "The judge-path switch ships with no circuit breaker, and making an in-code refusal a non-goal turns ADR-033's precondition into prose only. Once this merges, judge-path auto-merge with no breaker is one CHARTER edit away, and those merges cannot be undone. That is the most expensive failure of this plan, and it is not in any role's open_risks as something to be closed in code. My alternative: in this issue, `auto_merge_judge: true` hands to a human with the reason 'judge auto-merge requires the circuit breaker (S4c) — human merge required' while no breaker dep is wired. Or narrow the issue to non_judge only and move the judge branch to S4c.",
        "runs": [
          179
        ],
        "source": "dissent"
      },
      {
        "role": "operator",
        "kind": "good",
        "text": "Recording the job-budget gap only as a DECISIONS.md note leaves the switched-on path in a permanent blocked/re-dispatch loop. The default veto_minutes is 60 and the merge job has a 30-minute timeout, so every run blocks. Blocked-retry will then re-dispatch it indefinitely. A note is not a stop. The block must be a distinct, terminal reason that names `timeout-minutes: 30` and `veto_minutes`, and a test must show the blocked-retry arm does not re-dispatch on this specific reason. (Also to product-advocate: dw6 'missing dependency → blocked' recreates the loop and needs a no-redispatch condition.)",
        "runs": [
          179
        ],
        "source": "dissent"
      },
      {
        "role": "product-advocate",
        "kind": "good",
        "text": "The fix for single-actor forgery (count a window as open only if the merge runner recorded it in factory/records) must not require editing factory/lib/run-record.js, which is must_not. It must also pin that a forged or stale status costs the owner at most one extra window, not a duplicate announcement on every run. If each restarted run reopens and recomments, the owner gets repeated 'closes at' comments with different times, and operator's resume path (dw2) contradicts skeptic's dw2.",
        "runs": [
          179
        ],
        "source": "dissent"
      },
      {
        "role": "operator",
        "kind": "good",
        "text": "Keeping the `--retry` refusal and only improving its message is a sound fallback, but it does not deliver the issue's 'single verb resolved by caller'. Making it the whole of part (2) leaves the stated acceptance unmet.",
        "runs": [
          196
        ],
        "source": "dissent"
      },
      {
        "role": "skeptic",
        "kind": "good",
        "text": "Making PR comments the source of rework responses is the wrong fix. The engine already puts the rework response in a runner-posted record on the tracking issue: the implement handoff. Switching to PR comments forces an author filter (sec-s1), adds a resolveFactoryLogins call at merge time and a new failure mode that empties every row, and adds a second input contract (issueComments/prComments). None of that is needed if evidence.js reads data.rework_response from the implement handoff it already parses. (.claude/workflows/factory-implement.js:624-625,645; factory/bin/run-stage.js:3384,3395-3397; factory-builder.md:123 'PR 코멘트로도 남긴다'. Would accept instead: a check against #189's real implement handoffs showing they lack data.rework_response.) A companion objection to product-advocate says amendment (1) pins the secondary source, and that PR comments have no round anchor (context.js:205-217).",
        "runs": [
          195
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
        "reason": "lifetime cost $63.40 over 104 run(s) exceeds [budget].usd_per_issue $60 — a person raises the budget (`:proposal`), splits the issue, or closes it (wont-do); the counter spans re-queues and human retries on purpose",
        "at": "2026-10-03T07:19:11Z"
      },
      {
        "issue": 147,
        "reason": "protected paths changed — human merge required: .factory/lib/sweeper.js, factory/lib/sweeper.js, factory/test/sweeper.test.js (see PR #148)",
        "at": "2026-10-01T17:43:33Z"
      },
      {
        "issue": 157,
        "reason": "lifetime cost $60.01 over 172 run(s) exceeds [budget].usd_per_issue $60 — a person raises the budget (`:proposal`), splits the issue, or closes it (wont-do); the counter spans re-queues and human retries on purpose",
        "at": "2026-10-03T11:11:33Z"
      },
      {
        "issue": 156,
        "reason": "protected paths changed — human merge required: .factory/bin/sweep.js, .factory/lib/retro/issue-comments.js, .factory/lib/sweeper.js, .factory/lib/transition.js, factory/bin/sweep.js, factory/lib/retro/issue-comments.js, factory/lib/sweeper.js, factory/lib/transition.js, factory/test/sweep-bin.test.js, factory/test/sweeper.test.js, factory/test/transition.test.js (see PR #158)",
        "at": "2026-10-02T10:23:52Z"
      },
      {
        "issue": 170,
        "reason": "lifetime cost $60.99 over 154 run(s) exceeds [budget].usd_per_issue $60 — a person raises the budget (`:proposal`), splits the issue, or closes it (wont-do); the counter spans re-queues and human retries on purpose",
        "at": "2026-10-03T12:17:39Z"
      },
      {
        "issue": 168,
        "reason": "protected paths changed — human merge required: .factory/bin/sweep.js, .factory/lib/sweeper.js, factory/bin/sweep.js, factory/lib/sweeper.js, factory/test/sweep-bin.test.js, factory/test/sweeper.test.js (see PR #169)",
        "at": "2026-10-03T07:29:59Z"
      },
      {
        "issue": 174,
        "reason": "protected paths changed — human merge required: .factory/bin/run-stage.js, .factory/lib/context.js, .factory/lib/retro/issue-comments.js, .factory/lib/self-gate.js, factory/bin/run-stage.js, factory/lib/context.js, factory/lib/retro/issue-comments.js, factory/lib/self-gate.js, factory/test/context.test.js, factory/test/issue-comments.test.js, factory/test/run-stage.test.js, factory/test/self-gate.test.js (see PR #175)",
        "at": "2026-10-03T06:52:22Z"
      },
      {
        "issue": 176,
        "reason": "protected paths changed — human merge required: .factory/lib/sweeper.js, factory/lib/sweeper.js, factory/test/sweeper.test.js (see PR #177)",
        "at": "2026-10-03T11:14:50Z"
      },
      {
        "issue": 178,
        "reason": "protected paths changed — human merge required: .factory/bin/operator-merge-check.js, .factory/install-manifest.json, .factory/lib/config.js, .factory/lib/label-catalog.js, .factory/lib/non-judge-paths.js, .factory/lib/operator-merge.js, factory/bin/operator-merge-check.js, factory/lib/config.js, factory/lib/label-catalog.js, factory/lib/non-judge-paths.js, factory/lib/operator-merge.js, factory/test/config.test.js, factory/test/label-catalog.test.js, factory/test/non-judge-paths.test.js, factory/test/operator-merge.test.js (see PR #180)",
        "at": "2026-10-03T13:00:14Z"
      },
      {
        "issue": 184,
        "reason": "protected paths changed — human merge required: .factory/bin/run-stage.js, .factory/lib/gates.js, .factory/lib/merge-stage.js, factory/bin/run-stage.js, factory/lib/gates.js, factory/lib/merge-stage.js, factory/test/merge-stage.test.js, factory/test/run-stage.test.js (see PR #185)",
        "at": "2026-10-03T12:05:05Z"
      },
      {
        "issue": 179,
        "reason": "protected paths changed — human merge required: .factory/bin/run-stage.js, .factory/lib/gh.js, .factory/lib/merge-stage.js, factory/bin/run-stage.js, factory/lib/gh.js, factory/lib/merge-stage.js, factory/test/gh.test.js, factory/test/merge-stage.test.js, factory/test/run-stage.test.js (see PR #188)",
        "at": "2026-10-03T14:00:03Z"
      },
      {
        "issue": 196,
        "reason": "protected paths changed — human merge required: .factory/bin/run-stage.js, .factory/bin/transition.js, .factory/lib/budget.js, .factory/lib/retro/issue-comments.js, .factory/lib/run-record.js, .factory/lib/sweeper.js, .factory/lib/transition.js, .factory/lib/usage.js, factory/bin/run-stage.js, factory/bin/transition.js, factory/lib/budget.js, factory/lib/retro/issue-comments.js, factory/lib/run-record.js, factory/lib/sweeper.js, factory/lib/transition.js, factory/lib/usage.js, factory/test/budget.test.js, factory/test/issue-comments.test.js, factory/test/run-stage.test.js, factory/test/sweeper.test.js, factory/test/transition.test.js, factory/test/usage.test.js (see PR #204)",
        "at": "2026-10-03T18:55:57Z"
      },
      {
        "issue": 195,
        "reason": "lifetime cost $61.40 over 108 run(s) exceeds [budget].usd_per_issue $60 — a person raises the budget (`:proposal`), splits the issue, or closes it (wont-do); the counter spans re-queues and human retries on purpose",
        "at": "2026-10-03T19:49:23Z"
      },
      {
        "issue": 189,
        "reason": "protected paths changed — human merge required: .factory/bin/retro.js, .factory/bin/run-stage.js, .factory/bin/sweep.js, .factory/install-manifest.json, .factory/lib/breaker.js, .factory/lib/config.js, .factory/lib/merge-stage.js, .factory/lib/sweeper.js, factory/bin/retro.js, factory/bin/run-stage.js, factory/bin/sweep.js, factory/cli/breaker.js, factory/cli/index.js, factory/lib/breaker.js, factory/lib/config.js, factory/lib/merge-stage.js, factory/lib/sweeper.js, factory/test/breaker.test.js, factory/test/config.test.js, factory/test/merge-stage.test.js, factory/test/sweeper.test.js (see PR #193)",
        "at": "2026-10-03T18:05:11Z"
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
    "needs_human": 4,
    "qa_approvals": 2,
    "qa_claims_total": 10,
    "qa_na_total": 5,
    "qa_na_ratio": 0.33,
    "qa_na_heavy_approvals": 0,
    "usage": {
      "cost_usd": 176.90978,
      "tokens": {
        "input": 2711591,
        "output": 249728
      }
    }
  },
  "stats_total": {
    "merged": 12,
    "review_rounds_avg": 2.08,
    "plan_rounds_avg": 1,
    "implement_rounds_avg": 2.08,
    "escaped_defects": 16,
    "reverts": 0,
    "reverted_issues": [],
    "revert_rate": 0,
    "rejects_by_role": {
      "spec-conformance": 7,
      "qa": 4,
      "correctness": 10,
      "architecture": 6
    },
    "review_runs": 31,
    "findings_total": 30,
    "overlapping_findings": 16,
    "unique_findings_by_role": {
      "spec-conformance": 3,
      "qa": 4,
      "correctness": 4,
      "architecture": 3
    },
    "overlap_ratio": 0.53,
    "needs_human": 51,
    "qa_approvals": 13,
    "qa_claims_total": 77,
    "qa_na_total": 20,
    "qa_na_ratio": 0.21,
    "qa_na_heavy_approvals": 3,
    "usage": {
      "cost_usd": 624.922939,
      "tokens": {
        "input": 17203431,
        "output": 1312904
      }
    },
    "retro_usage": {
      "cost_usd": 8.45224,
      "tokens": {
        "input": 22,
        "output": 21249
      }
    },
    "retros": 7
  },
  "deferred_proposals": [],
  "deletion_candidates": []
}
```
