# Retro State

- last retro: 2026-09-14T14:00:58.920Z
- merges since last retro: 0
- current N: 1

## History (last 5)

| at | yield | n_before | n_after | needs_human_since |
| --- | --- | --- | --- | --- |
| 2026-09-14T14:00:58.920Z | 0 | 1 | 1 | 6 |

## Stats

| metric | this window | cumulative |
| --- | --- | --- |
| merged | 1 | 1 |
| review rounds avg | 3 | 3 |
| needs-human | 6 | 6 |
| rejects by role | spec-conformance 2 | spec-conformance 2 |
| reviewer overlap | 0.00 (0/2, runs 3) | 0.00 (0/2, runs 3) |
| unique findings by role | spec-conformance 2 | spec-conformance 2 |
| cost (usd) | 96.07 | 96.07 |
| tokens | input 1732420 / output 175679 | input 1732420 / output 175679 |
| retro cost (usd) | 0.90 | 0.90 |
| retro tokens | input 2 / output 2419 | input 2 / output 2419 |
| full retros | — | 1 |

<!-- factory-retro-state:v1 -->
```json
{
  "cursor": {
    "last_retro_at": "2026-09-14T14:00:58.920Z",
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
      }
    ]
  },
  "stats": {
    "merged": 1,
    "review_rounds_avg": 3,
    "rejects_by_role": {
      "spec-conformance": 2
    },
    "review_runs": 3,
    "findings_total": 2,
    "overlapping_findings": 0,
    "unique_findings_by_role": {
      "spec-conformance": 2
    },
    "overlap_ratio": 0,
    "needs_human": 6,
    "usage": {
      "cost_usd": 96.068543,
      "tokens": {
        "input": 1732420,
        "output": 175679
      }
    },
    "retro_usage": {
      "cost_usd": 0.900202,
      "tokens": {
        "input": 2,
        "output": 2419
      }
    }
  },
  "stats_total": {
    "merged": 1,
    "review_rounds_avg": 3,
    "rejects_by_role": {
      "spec-conformance": 2
    },
    "review_runs": 3,
    "findings_total": 2,
    "overlapping_findings": 0,
    "unique_findings_by_role": {
      "spec-conformance": 2
    },
    "overlap_ratio": 0,
    "needs_human": 6,
    "usage": {
      "cost_usd": 96.068543,
      "tokens": {
        "input": 1732420,
        "output": 175679
      }
    },
    "retro_usage": {
      "cost_usd": 0.900202,
      "tokens": {
        "input": 2,
        "output": 2419
      }
    },
    "retros": 1
  },
  "deferred_proposals": [],
  "deletion_candidates": []
}
```
