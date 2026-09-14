# Retro State

- last retro: 없음
- merges since last retro: 0
- current N: 1

## History (last 5)

_이력 없음_

## Stats

| metric | this window | cumulative |
| --- | --- | --- |
| merged | 0 | 0 |
| review rounds avg | 0 | 0 |
| needs-human | 1 | 0 |
| rejects by role | 없음 | 없음 |
| cost (usd) | 26.21 | 0.00 |
| tokens | input 456915 / output 62257 | input 0 / output 0 |
| retro cost (usd) | 0.00 | 0.00 |
| retro tokens | input 0 / output 0 | input 0 / output 0 |
| full retros | — | 0 |

<!-- factory-retro-state:v1 -->
```json
{
  "cursor": {
    "last_retro_at": null,
    "last_record_offsets": {}
  },
  "merges_since": 0,
  "n": 1,
  "history": [],
  "candidates": {
    "lessons": [
      {
        "role": "spec-conformance",
        "text": "이번 이슈의 tier(standard)·roster(['correctness','architecture','spec-conformance','qa'])에서 qa가 호출됐고 done_when에 사용자 가시적 텍스트 항목(dw4, dw5)이 있는데도, harness.toml이 못박은 qa 증거 경로 `.factory/out/qa/**`가 이번 라운드에 비어 있다 — qa의 round-1 verified[]가 인용한 증거는 전부 저장소 밖 `/tmp/qa-repro/repro.mjs`, `/tmp/qa-evidence-issue3/*.log`이고, 이 세션이 끝나면 사라진다.",
        "runs": [
          3
        ],
        "source": "must_fix"
      }
    ],
    "examples": [],
    "flaky": [],
    "needs_human": [
      {
        "issue": 3,
        "reason": "stage artifact missing or invalid: gates RED: failing=unit",
        "at": "2026-09-14T05:43:12Z"
      }
    ]
  },
  "stats": {
    "merged": 0,
    "review_rounds_avg": 0,
    "rejects_by_role": {},
    "needs_human": 1,
    "usage": {
      "cost_usd": 26.212316,
      "tokens": {
        "input": 456915,
        "output": 62257
      }
    }
  }
}
```
