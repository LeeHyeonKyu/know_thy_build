---
schema: factory.charter.v1
status: draft
tier_default: standard
limits: { K: 3, M: 3, R: 2 }
roster:
  docs: [correctness, spec-conformance]
  standard: [correctness, architecture, spec-conformance, qa]
  load-bearing: [correctness, security, architecture, spec-conformance, qa]
plan_roles:
  docs: [architect, skeptic]
  default: [product-advocate, architect, skeptic, operator]
plan_rounds: { docs: 2, default: 3 }
back_pressure: { awaiting_review_max: 4 }   # quarantine 상한은 두지 않는다 — harness.toml [gates.thresholds].quarantine_max가 유일한 출처(§5.1, Plan 1b 실행 판결)
budget: {}
retro: { every_merges: { initial: 1, min: 1, max: 20 }, light_on_merge: true }
---

# Charter — {{PROJECT_NAME}}

## Tiers
| tier | 판정 기준 | 리뷰 로스터 | gate 레벨 | 예산(토큰/이슈) — 참고값, 기본 미적용 |
|---|---|---|---|---|
| docs | diff가 `docs/**`, `*.md`만 | correctness, spec-conformance | fast | 100k |
| standard | 기본 | correctness, architecture, spec-conformance, qa | full | 600k |
| load-bearing | `harness.toml [load_bearing]` 경로 포함 | correctness, security, architecture, spec-conformance, qa | deep | 1.2M |

## Plan 토론 로스터
| tier | 토론자 | 라운드 |
|---|---|---|
| docs | architect, skeptic | 2 (입장 → synthesizer 종합; 교차검토 생략) |
| standard / load-bearing | product-advocate, architect, skeptic, operator | 3 + 서명 |

## Hard limits
- review rounds K = 3
- same gate RED M = 3
- runner retries R = 2
- review 대기(awaiting-review) 이슈가 4개 이상이면 implement는 새 claim을 하지 않는다 (back-pressure)
- budget_tokens_per_issue: unset   # 선택·기본 off (ADR-005). 켜면 초과 시 **새 claim만** 거부하고 진행 중 스테이지는 죽이지 않는다. 기본 동작은 보고만(§4.4)

## 머지 권한 (ADR-021 — 두 배우)
팩토리의 PR을 base 브랜치에 넣을 수 있는 것은 **누구인가**. 이 절은 설정이 아니라 사실의 기록이다 —
실제 모드는 `factory bootstrap`이 저장소 시크릿에서 관측하고, `factory doctor`가 매번 다시 말한다.

| 배우 | 시크릿 | 계정 | 쓰이는 곳 |
|---|---|---|---|
| 에이전트 배우 | `FACTORY_BOT_TOKEN` | **admin이 아닌** 머신 유저 — 저장소의 평범한 **write 협력자**. PAT 스코프는 **`repo` 하나** (`workflow`를 주지 않는다) | 체크아웃 · 코멘트 · 라벨 · 락 브랜치 · PR 생성 · `claude/*`·`factory/*` push. `claude -p`가 도는 모든 스테이지 |
| 머지 배우 | `FACTORY_MERGE_TOKEN` | admin/owner (에이전트 배우와 **반드시 다른 계정**). `.github/CODEOWNERS`의 유일한 코드 오너 | 머지 스테이지(스크립트 전용 — `claude`를 띄우지 않는다)와 그 잡의 자격증명 스크럽 스텝. 그 외 어디에도 없다. 값은 **`factory-merge` 환경 시크릿**으로 둔다(저장소 시크릿이 아니다) |

- **두 배우 모드**(두 시크릿 모두 설정): base 브랜치가 **코드 오너의** 승인 1건을 요구한다
  (`require_code_owner_reviews` + `.github/CODEOWNERS`의 `* @<머지 배우>`). 그래서 에이전트 배우가 쥔
  토큰으로는 **어떤 PR도** 머지할 수 없다 — 자기가 연 PR은 GitHub이 자기-승인을 거부해서, 남이 연 PR은
  승인이 머지 배우의 것이어야 해서. 수만 세는 규칙(`required_approving_review_count`만)으로는 후자가
  열려 있었다(ADR-021 r1 MF-1). 훅은 그 위의 한 겹으로 남는다.
- **에이전트 PAT에 `workflow` 스코프를 주지 않는다**(r1 MF-2): 주면 에이전트가 자기 브랜치에 워크플로
  한 장을 올려 저장소 시크릿을 읽어 갈 수 있다(같은 저장소 브랜치의 워크플로에는 시크릿이 주어진다).
  `.github/**`는 `[protected].factory`라 그 경로를 건드리는 PR은 언제나 사람이 머지한다.
- **단일 배우 모드**(`FACTORY_MERGE_TOKEN` 없음): 승인 요건을 걸지 않는다 — 걸면 승인해 줄 두 번째
  계정이 없어 다크 머지가 불가능해진다. 머지 권한이 에이전트 스테이지에서 도달 가능한 채로 남고,
  훅이 유일한 층이다. `factory doctor`의 `tokens.single-actor` WARN이 그 사실을 매번 말한다.
  branch protection 자체가 불가능한 저장소(GitHub Free의 private repo)는 항상 이 모드다.
- **사람의 머지 경로는 달라지지 않는다**: 보호 경로·역할 섹션 정책에 걸린 PR은 그대로 `needs-human`이고,
  admin 권한의 사람이 diff를 읽고 GitHub에서 머지한다.

## NEVER_AUTOMATE (triage가 wont-do로 보냄)
- (fill in)
- (fill in)
- 공개 API(`src/api/public/**`)의 breaking change
- `.env*`, 시크릿, 배포 스크립트(`scripts/deploy.sh`)

## Definition of Done (모든 tier 공통)
- plan handoff의 done_when 전항목이 verify 테스트로 증명됨
- gates GREEN (tier의 레벨)
- 새 테스트가 변경 없이 실패함 (prove-test)
- 기존 테스트 미수정
- diff가 files_expected 밖으로 나가지 않음 (초과 시 spec-conformance가 reject)
- run 기록 존재

## Preserve (바꾸면 안 되는 동작)
- (fill in)
- (fill in)

## Retro
every_merges: { initial: 1, min: 1, max: 20 }   # N은 수확량에 따라 자가 조정 (§8.4)
light_on_merge: true
