---
schema: factory.charter.v1
status: ready
tier_default: standard
limits: { K: 3, M: 3, R: 2 }
roster:
  docs: [correctness, spec-conformance]
  standard: [correctness, architecture, spec-conformance, qa]
  load-bearing: [correctness, security, architecture, spec-conformance, qa]
plan_roles:
  docs: [architect, skeptic]
  default: [product-advocate, architect, skeptic, operator]
plan_rounds: { docs: 2, default: 3 }        # 토론 tier에서만 쓰인다 (아래 plan.mode)
plan: { mode: single, debate_tiers: [load-bearing], max_done_when: 6 }   # 감사 Task 9 — 기본은 단일 opus 1패스 + skeptic 1패스
back_pressure: { awaiting_review_max: 4 }   # quarantine 상한은 두지 않는다 — harness.toml [gates.thresholds].quarantine_max가 유일한 출처(§5.1, Plan 1b 실행 판결)
merge: { human_gate: false }                # 소유자 결정: 이 저장소는 다크 루프를 증명하는 것이 목적이다 (아래 "머지 권한 — 사람 게이트" 참고)
triage: { default: ready }                  # 소유자 결정: 같은 이유 — 아래 "triage 기본 판정" 참고 (감사 M1). 채택 저장소의 기본값은 needs-info다
budget: {}
retro: { every_merges: { initial: 1, min: 1, max: 20 }, light_on_merge: true }
---

# Charter — know-thy-build

## Tiers
| tier | 판정 기준 | 리뷰 로스터 | gate 레벨 | 예산(토큰/이슈) — 참고값, 기본 미적용 |
|---|---|---|---|---|
| docs | diff가 `docs/**`, `*.md`만 | correctness, spec-conformance | fast | 100k |
| standard | 기본 | correctness, architecture, spec-conformance, qa | full | 600k |
| load-bearing | `harness.toml [load_bearing]` 경로 포함 | correctness, security, architecture, spec-conformance, qa | deep | 1.2M |

## Plan 로스터 (감사 Task 9 — 기본은 토론이 아니다)
| tier | 모드 | 역할 | 라운드 |
|---|---|---|---|
| docs / standard | single | synthesizer(계획자, opus) + skeptic | 2 (계획 1패스 → 반박 1패스; 반박은 **추가만** 한다) |
| load-bearing | debate | product-advocate, architect, skeptic, operator | 3 + 서명 (`plan_rounds`) |

근거: `docs/factory/dogfood/2026-09-14-plan-baseline.md` · `docs/factory/audit/response-task-9.md`.
4역할 토론은 이슈당 5.4×–33.7×를 쓰고도 #15·#18에서 단일 패스보다 못했고, must_fix 15건 중 5건이
토론이 스스로 발명한 done_when 때문에 생겼다. 토론이 값을 산 곳은 표본에서 유일한 load-bearing
이슈(#2) 하나다. `plan.mode: debate`로 언제든 전부 토론으로 되돌릴 수 있다.

## Hard limits
- review rounds K = 3
- same gate RED M = 3
- runner retries R = 2
- review 대기(awaiting-review) 이슈가 4개 이상이면 implement는 새 claim을 하지 않는다 (back-pressure)
- budget_tokens_per_issue: unset   # 선택·기본 off (ADR-005). 켜면 초과 시 **새 claim만** 거부하고 진행 중 스테이지는 죽이지 않는다. 기본 동작은 보고만(§4.4)

## 머지 권한 — 사람 게이트 (`merge.human_gate: false`, 외부 감사 2026-09-14 H6)
이 저장소는 **다크 루프를 증명하는 것 자체가 산출물**이다: 이슈 하나가 사람의 개입 없이 triage → plan →
implement → review → merge를 통과할 수 있는가를 재는 것이 도그푸딩의 전부이고, 머지 잡마다 사람의 클릭을
요구하면 그 측정이 성립하지 않는다(측정 대상이 곧 사라진다). 그래서 소유자 결정으로 `merge.human_gate:
false`다 — 기본값이 아니라 **명시적 선택**이고, `factory doctor`가 매 실행에서
`merge.dark — no per-PR human signature (merge.human_gate=false)`를 WARN으로 남긴다.

대가는 정확히 이것이다: 이 저장소에서 사람의 서명은 **토큰을 한 번 등록한 것**뿐이다. 그 대가를 감당할 수
있는 이유는 되돌릴 수 있어서다 — 저장소 하나, 소유자 한 명, 모든 머지가 squash라 `git revert` 한 번이다.
**채택 저장소의 기본값은 반대다**(`templates/factory/docs/factory/CHARTER.md`는 `true`): 남의 코드베이스에
다크 머지를 기본으로 심지 않는다.

사람이 여전히 머지하는 경로는 그대로다 — 보호 경로·역할 섹션 정책·무결성 위반에 걸린 PR은
`factory:needs-human`이고 사람이 diff를 읽고 GitHub에서 머지한다. 머지한 뒤에는 손댈 것이 없다:
sweeper가 한 회차(≤30분) 안에 그 이슈를 `factory:merged`로 옮기고 닫는다(KTB-46). 그 전이도 자동
머지와 똑같은 증거 검사를 지나므로, 리뷰를 거치지 않은 PR을 머지했다면 이슈는 `needs-human`에
그대로 남는다 — 사람의 머지가 예외이지 증거가 예외인 것이 아니다.

## triage 기본 판정 (`triage.default: ready`, 외부 감사 2026-09-14 M1)
`merge.human_gate: false`와 **같은 이유의 같은 선택**이다: 이 저장소에서 재는 것은 "이슈 하나가 사람의
개입 없이 triage → merge를 통과할 수 있는가"이고, 애매한 이슈마다 `needs-info`로 멈추면 그 측정이
성립하지 않는다. 그래서 소유자 결정으로 `ready`이고, `factory doctor`가 매 실행에서
`triage.default-allow`를 WARN으로 남긴다.

대가는 이것이다: NEVER_AUTOMATE에도 안 걸리고 done_when도 쓸 수 있는 이슈는 사람을 거치지 않고
plan으로 간다. 감당할 수 있는 이유는 뒤의 층이 남아 있어서다 — 글롭으로 적힌 NEVER_AUTOMATE 항목은
`verify-stage`가 `impact_paths`로 다시 세고(에이전트 판정을 덮어쓴다), 보호 경로에 걸린 PR은 여전히
`factory:needs-human`이다. **채택 저장소의 기본값은 반대다**(`templates/…/CHARTER.md`는 `needs-info`).

## NEVER_AUTOMATE (triage가 wont-do로 보냄)
경로 글롭으로 적은 항목은 `verify-stage`가 triage handoff의 `impact_paths`에 다시 대고, 걸리면
에이전트의 판정과 무관하게 `wont-do`로 덮어쓴다(`never_automate_hit`, 감사 M1).
- npm에 publish하는 모든 것(`.github/workflows/publish.yml`의 트리거·`package.json`의 `version` 필드) — 배포는 사람이 태그를 찍고 사람이 승인한다
- `harness.toml [protected]` 또는 `harness.toml [gates.thresholds]`를 바꾸는 변경 — 판정 기준 자체를 건드리는 diff는 항상 사람 머지(§5.1)
- `templates/factory/**`의 게이트 판정 로직(semantics) 변경 — L0/L1/L2가 무엇을 막는지가 바뀌면 이 템플릿을 설치한 모든 채택 저장소의 동작이 함께 바뀐다(항상 사람 리뷰·ADR-020)
- `.env*`, 시크릿, `.github/workflows/publish.yml`(npm 배포 경로 — 첫 항목과 같은 대상이지만 워크플로 파일 자체를 짚는다)

## Definition of Done (모든 tier 공통)
- plan handoff의 done_when 전항목이 verify 테스트로 증명됨
- gates GREEN (tier의 레벨)
- 새 테스트가 변경 없이 실패함 (prove-test)
- 기존 테스트 미수정
- diff가 files_expected 밖으로 나가지 않음 (초과 시 spec-conformance가 reject)
- run 기록 존재

## Preserve (바꾸면 안 되는 동작)
- every stage transition goes through transition.js
- tests are load-bearing (no skips)

## Retro
every_merges: { initial: 1, min: 1, max: 20 }   # N은 수확량에 따라 자가 조정 (§8.4)
light_on_merge: true
