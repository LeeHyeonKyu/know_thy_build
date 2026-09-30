# Research: 핵심 흐름 정리 계획에 대한 삼각토론
Date: 2026-09-29
Question: `docs/superpowers/plans/2026-09-29-core-flow-slimming.md`(v1)를 실행하면 병목이 실제로 줄고 흐름이 매끄러워지는가.
근본적으로 잘못된 설계는 없는가.

고정 제약(소유자): plan·review의 다중 역할, verifier, triage 에이전트는 핵심이며 유지한다.

## Rounds
- **Round 1**: 초기 입장. 긴장은 "장치를 하나씩 내린다(PRO)" 대 "장치를 낳는 구조를 바꾼다(CON)". NEUTRAL이 기록을 재집계해
  리드타임의 구속 병목이 러너 포화(점유 93%)이고 계획의 현실적 효과가 리드타임 −20–30%, 공장 토큰 −15–20%라고 추정했다.
- **Round 2**: 양쪽이 핵심 주장을 철회했다. PRO는 Phase 1의 절감($118.60)이 과거 비용임을 인정하고 `enforce` 스위치를 버렸다.
  CON은 단일 프로세스 재작성이 토큰으로 회수되지 않음을 자기 산식으로 확인하고(회수까지 이슈 300–500건) 점진 경로로 돌아섰다.
  NEUTRAL이 반복 세션의 몫(56%, 캐시 읽기의 62.5%)과 재개의 손익분기(builder 약 41턴, R2 약 13턴)를 냈다.
- Round 3은 돌리지 않았다. 남은 이견이 스파이크로만 풀리는 것이었다.

## 쟁점과 판정

| 쟁점 | PRO | CON | NEUTRAL | 반박을 견뎠나 | 판정 |
|---|---|---|---|---|---|
| Phase 1의 절감 | R1 $118.60 → R2 철회 | 이미 수정된 결함 | 수정 뒤 멈춤 31건 중 1건. 미래는 미측정 | CON ✅ | 기대 효과에서 뺀다 |
| record-only 스위치 | R1 표준 관행 → R2 철회 | 코드·테스트 2배 | 범용 스위치 없이 직접 강등 | CON ✅ | 스위치 없음, 일몰 규칙 |
| stage-per-job 구조 | 체크포인트로 가치 | 부가 장치의 원인 | 락·하트비트·복구는 구조를 바꿔도 남음 | 둘 다 부분 ✅ | 구조 유지, rework 구간만 묶는 것을 종착점으로 |
| 전면 재작성 | 결함을 다시 쌓음 → "과장" 인정 | R2 철회 | 3–5주, 토큰 효과 0–8% | PRO ✅ | 하지 않는다 |
| 세션 재개 | 엔진에 없음을 인정 | builder 본전, R2 12% | builder 7–13%, R2 0–5% | 미결 | 스파이크로 결정 |
| 순서 | R2에서 컨트롤러를 2번으로 | 러너·WIP 먼저 | 컨트롤러 2번, WIP 4번, 러너 추가는 뒤 | NEUTRAL ✅ | 쿼터 우선이므로 NEUTRAL 순서 |
| 품질 기준선 | 인정 | 요구 | 전제 조건 | 전원 일치 | 1번 항목 |

## 각 입장에서 채택한 것
- **PRO**: 기존 `workflow_dispatch`·`dispatchStage` 재사용, 일몰 규칙, 로스터 근거 반영, 러너 변수 분리.
  L12–L40 가운데 구조 변경으로 사라지는 결함은 5건 안팎이라는 분류.
- **CON**: 스위치 철회, 발화 0 장치의 즉시 삭제, "약 40런"을 기대 효과에서 제외, implement → review → rework 묶기를 종착점으로 명시,
  Fix 루프와 R2가 새 세션을 띄운다는 코드 사실.
- **NEUTRAL**: 작업 순서, 반복 세션 실측, 재개 손익분기, 스파이크 2건, 러너 추가가 쿼터 소진을 앞당긴다는 경고.

## 확인하지 못한 것
- Max 구독 쿼터가 캐시 읽기·쓰기·출력을 어떤 가중치로 세는지.
- `claude -p --resume`이 잡 경계를 넘어 동작하는지, Workflow 없이 역할을 호출할 때 훅이 동작하는지(스파이크 대상).
- 재개 모델의 수치(종료 컨텍스트 71k, 손익분기 41턴)는 선형 증가 가정 위의 추정이다.
- 외부 출처 다수는 에이전트가 검색 요약으로만 확인했고 원문을 열지 않았다고 밝혔다.

## Sources
1. `docs/research/ancillary-device-inventory.md` Part B·C·D
2. own-calendar `origin/factory/records`의 run 기록(NEUTRAL 재집계)
3. `templates/factory/claude/workflows/factory-implement.js:568-595`, `factory-review.js:343,456-472`
4. GitHub Docs, Actions limits — https://docs.github.com/en/actions/reference/limits
5. Anthropic, "How we built our multi-agent research system", 2025-06-13 — https://www.anthropic.com/engineering/multi-agent-research-system
6. Anthropic, "Building effective agents", 2024-12 — https://www.anthropic.com/engineering/building-effective-agents
7. Claude 프롬프트 캐싱 문서 — https://platform.claude.com/docs/en/build-with-claude/prompt-caching
