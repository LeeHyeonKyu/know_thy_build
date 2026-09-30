# Research: 명시적 제출과 엔진 자기 변경 설계 초안에 대한 삼각토론
Date: 2026-09-30
Question: `docs/superpowers/specs/2026-09-30-explicit-submission-and-self-change.md` v1의 안전망·상한·귀속·순서가 타당한가.
고정 방향(소유자): 누구나 명시적 job을 제출할 수 있고, 공장이 자기 엔진 변경을 스스로 배포하며, 나중에 self-improving을 올린다.

## Rounds
- **Round 1**만 돌렸다. 세 입장의 지적이 서로 다른 조항을 겨눴고 반박 없이도 판정이 가능했다.

## 쟁점과 판정
| 쟁점 | PRO | CON | NEUTRAL | 판정 |
|---|---|---|---|---|
| 귀속 앵커 | 작성 계정·런 ID는 위조 불가 | 소유자 세션의 Claude가 사람으로, 스테이지 빌더가 공장으로 읽힘 | 훅만 막는 열거식 방어로 회귀 | CON. `by=`는 감사 기록으로 강등, 상한은 기원 마커에 앵커 |
| 루프 상한 | 자율 진입 ≤ 2×사람 머지 | flaky·하네스 사슬, 저장소 간 이동, 회로차단기 리셋 | 실측 증식률 0.25로 이미 수렴 | 개수 상한 채택 + 구멍 보완 |
| 주간 예산 $150 | 엔진 머지 ≤10/주 | 실측 이틀치 1/3 | 사람의 정상 작업을 첫날 막음 | 자기생성 전용 예산으로 |
| 카나리 | Argo 분석과 동형 | GREEN인데 틀린 엔진을 못 잡음(DGM 사례) | 자기 수정 후보 55%가 회귀(arXiv 2609.24130) | CON. 거부 시드 카나리 도입, 판정자 경로는 사람 머지 유지 |
| 거부권 창 | 클릭보다 정보량 많음 | 타이머일 뿐 | fail-open, 비공개 저장소 불가 | 엔진 내부 타이머, 비판정 경로에만 |
| 엔진 경로 범위 | `.claude/**` 제외 필요 | 미러가 소스 쓰기를 정직하게 배포 | 훅·판정 경로 무방비 | 판정자/비판정 경로 분리 |
| 순서 | S1→S6 | S6은 검출기 전 금지 | D2 우선 | S4 축소, S6에 선행 조건 |

## 각 입장에서 채택한 것
- PRO: 큐가 코드상 이미 열려 있다는 사실(`labels.js:70`, `requirements.js:223`), 엔진 경로에서 `.claude/**` 제외, 회로차단기 원천을 Actions API로, 주간 예산을 스테이지 시작에도 적용.
- CON: 귀속 앵커 붕괴, 거부 시드 카나리, 판정자 분리, 시드 은닉, 주체별 GitHub App(S7로).
- NEUTRAL: 증식률 실측, 위협 모델 표(판정자 약화는 어느 통제도 못 막음), `queue_max`, 회로차단기에 사후 건강 신호, GitHub 환경 규칙의 플랜 제약.

## 확인하지 못한 것
- 거부 시드 카나리가 실제 판정 회귀를 잡는 비율. 시드 3건이 충분한지.
- 에이전트가 자기 하네스를 고쳐 난 공개 사고 사례(논문 통계만).
- `overlayDrift`가 러너 미러 커밋에 어떻게 반응하는지(미실행).

## Sources
1. GitHub Docs — Manage environments (wait timer 1–43,200분, 승인 불요, Free/Pro/Team은 공개 저장소만) https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
2. GitHub Docs — Copilot cloud agent risks and mitigations https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations
3. Kubernetes — Resource Quotas https://kubernetes.io/docs/concepts/policy/resource-quotas/
4. Argo Rollouts — Analysis https://argo-rollouts.readthedocs.io/en/stable/features/analysis/
5. Zhang et al., Darwin Gödel Machine, arXiv:2505.22954 (2025-05); Sakana AI 블로그 https://sakana.ai/dgm/
6. Self-Healing Harness, arXiv:2609.24130 (2026-09-21) — 자기 수정 후보 383건 중 211건 회귀
7. Clinejection 사고 보고(2026-02) https://labs.cloudsecurityalliance.org
8. `docs/research/autonomous-queue-and-self-change.md`, `docs/research/review-roster-evidence.md`, `docs/research/simulation-105.md`
