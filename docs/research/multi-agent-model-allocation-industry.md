# Research: Multi-Agent 소프트웨어 개발 시스템에서의 모델 할당 방법론

Date: 2026-09-06
Question: Multi-agent 개발 시스템에서 오케스트레이터, 코딩 에이전트, 리뷰 에이전트 각각에 어떤 tier의 모델을 할당하는 것이 최적인가?

---

## 1. 업계 컨센서스: 역할별 모델 할당

### 1.1 핵심 원칙 — "하나의 모델로 모든 역할"은 양방향 실패

단일 모델을 모든 에이전트 역할에 할당하면 두 가지 동시 실패가 발생한다:
- **Over-provisioning**: 단순 작업에 비싼 모델을 쓰면 비용 낭비 + 불필요한 latency
- **Under-provisioning**: 복잡한 작업에 저렴한 모델을 쓰면 품질 저하 → 재작업 비용 발생

Augment Code의 분석에 따르면, 3-tier 라우팅(Opus/Sonnet/Haiku)은 uniform Opus 대비 **51% 비용 절감**을 달성한다. [1]

### 1.2 역할별 권장 모델 Tier

| 역할 | 권장 Tier | 근거 | 출처 |
|------|-----------|------|------|
| **Orchestrator** (작업 분해, 조율) | **상위 모델** (Opus급) | 전략적 판단, 의존성 분석, 에이전트 간 조율에 deep reasoning 필요. MCP Atlas에서 Sonnet 대비 15-19점 우위 | [1][2] |
| **Implementor** (코드 생성) | **중간 모델** (Sonnet급) | SWE-bench 79.6% 달성, Sonnet 4.0 대비 21% 적은 tool call로 동등 품질. 속도-품질-비용 최적 균형 | [1][3] |
| **Code Reviewer** | **중간~상위 모델** | 철저한 분석을 위한 exhaustive tool use 필요. 단, fine-tuned된 소형 모델도 특정 리뷰 작업에서 대형 모델 능가 가능 | [1][6] |
| **Explorer/Navigator** | **하위 모델** (Haiku급) | grep, 디렉토리 탐색, 보일러플레이트 생성 등 단순 작업. Sonnet 대비 3배 저렴 | [1][4] |

### 1.3 Anthropic의 자체 검증 — Multi-Agent Research System

Anthropic은 자사 multi-agent 리서치 시스템에서 이 패턴을 직접 검증했다:

- **Lead Researcher** (오케스트레이터): Claude Opus 4
- **Sub-agents** (실행자): Claude Sonnet 4
- **결과**: 단일 Opus 에이전트 대비 **90.2% 성능 향상** [2]

성능 분산의 95%를 설명하는 3가지 요인:
1. **Token 사용량** (80%): 더 많은 토큰 = 더 많은 추론 용량
2. **Tool calls**: 병렬 실행이 breadth-first 탐색 가능하게 함
3. **모델 선택**: Sonnet 4 업그레이드가 Sonnet 3.7의 토큰 예산 2배 증가보다 더 큰 성능 향상

> "Sonnet 4로의 업그레이드가 Sonnet 3.7의 토큰 예산을 2배로 늘리는 것보다 더 큰 성능 향상을 가져온다." — Anthropic [2]

---

## 2. 핵심 연구 발견

### 2.1 검증은 생성보다 쉽다 (Verification < Generation)

이것은 모델 할당 전략의 이론적 기반이 되는 핵심 비대칭이다:

- 검증은 **판별적**(discriminative) 작업: "이것이 맞는가?"
- 생성은 **창조적**(creative) 작업: "이것은 무엇이어야 하는가?"
- GPT-4o 기준, verifier는 평균 **193 tokens**, generator는 평균 **483 tokens** 소비 → **2.5배 토큰 절감** [5]
- 7B 파라미터급 소형 모델도 k개 생성 중 최적 응답 선택에서 강력한 수학적 능력 시현 [5]

**실무적 함의**: 리뷰/검증 에이전트는 코딩 에이전트보다 작은 모델을 써도 된다 — 단, 작업 범위가 명확히 정의되어 있을 때.

### 2.2 Budget Reallocation — "약한 생성기 + 강한 검증기"

"The Larger the Better?" 논문 (Hassid et al., 2024)의 핵심 발견:

- 동일 compute budget에서, **13B 모델 5회 생성 + unit-test 선택** > **70B 모델 1회 생성**
- 최대 **15% 개선** (5개 과제 전반)
- **핵심 조건**: unit-test 같은 검증 메커니즘이 있어야 함. 없으면 소형 모델의 ranking 기반 선택은 대형 모델 단일 출력에 미치지 못함 [7]

**Multi-Agent 시사점**: 저렴한 모델로 여러 후보를 생성하고, 테스트/검증으로 필터링하는 전략이 유효. 단, 자동화된 검증 파이프라인이 전제조건.

### 2.3 Multi-Agent Verification (MAV) — 검증자 수 스케일링

"Multi-Agent Verification: Scaling Test-Time Compute with Multiple Verifiers" (2025):

- **Aspect Verifiers (AVs)**: 서로 다른 측면을 검증하는 LLM 에이전트들을 조합
- **BoN-MAV**: Best-of-N 샘플링 + 다중 검증자 = self-consistency와 reward model 검증보다 강한 스케일링
- **Weak-to-Strong generalization**: 동일 base model로 생성과 검증 모두 수행해도 성능 향상 가능 [8]

### 2.4 Fine-tuned 소형 모델의 코드 리뷰 성능

NVIDIA의 연구 (2025):

- Llama 3 8B + LoRA fine-tuning → 코드 리뷰 severity 예측에서 **18% 정확도 향상**
- **Llama 3 70B 및 Nemotron 4 340B를 능가** [6]
- Teacher-student 패러다임: 대형 모델이 합성 학습 데이터 생성 → 소형 모델 fine-tune

**시사점**: 특화된 리뷰 도메인에서는 fine-tuned 소형 모델이 범용 대형 모델보다 우수할 수 있다.

---

## 3. 주요 프레임워크별 접근법

### 3.1 Claude Code

Claude Code는 smart model switching을 내장:
- **Haiku 4.5**: 파일 읽기, 빠른 수정, 간단한 질문, 보일러플레이트 생성, 단순 리팩토링
- **Sonnet**: 대부분의 전문 작업, SaaS 제품, 개발 도구, 에이전트 워크플로우의 기본 모델
- **Opus**: 가장 어려운 코드, 긴 에이전트 체인, 아키텍처 결정
- Sub-agent별 `model` override 지원: 에이전트 정의에서 per-agent 모델 설정 가능 [4]

### 3.2 Anthropic "Building Effective Agents"

핵심 패턴들:
- **Routing**: 쉬운 질문 → Haiku, 어려운 질문 → Sonnet/Opus
- **Orchestrator-Workers**: 중앙 LLM이 동적으로 작업 분해/위임/합성
- **Evaluator-Optimizer**: 하나의 LLM이 생성, 다른 LLM이 평가+피드백 반복
- **핵심 교훈**: "잘 설계된 단일 에이전트가 많은 개발자가 기대하는 것보다 훨씬 더 많은 것을 달성할 수 있다" [3][9]

### 3.3 CrewAI / AutoGen

- **CrewAI**: 역할 기반 에이전트 (researcher → writer → reviewer) — 역할별 다른 모델 할당 가능
- **AutoGen**: 대화형 다중 에이전트 — 에이전트별 모델 선택 가능
- 두 프레임워크 모두 역할 분화가 도메인별 최적화를 가능하게 함 [10]

### 3.4 Augment Code의 Multi-Agent Workspace

6가지 패턴 프레임워크:
1. Spec 기반 분해 → 테스트 가능한 작은 작업으로 분할
2. Git worktree 격리 → 에이전트별 독립 작업 디렉토리
3. Coordinator/Specialist/Verifier 역할 분리
4. **작업 유형별 모델 라우팅** → 위험 프로파일에 맞춘 모델 매칭
5. Quality gate → merge 전 자동화된 검증
6. Sequential merge → 하나씩 순서대로 통합

**실무 교훈**: "강한 모델로 시작하고, 평가를 통해 역방향 최적화" — 먼저 기준선을 세운 뒤, 허용 가능한 품질을 유지하는 선에서 저렴한 모델로 교체 [11]

---

## 4. 비용 분석

### 4.1 Token 소비 규모

Anthropic의 관측 기준:
- **Chat 상호작용** = baseline
- **단일 에이전트** = chat 대비 ~4배 토큰
- **Multi-agent 시스템** = chat 대비 ~15배 토큰 [2]

→ Multi-agent는 15배 토큰 오버헤드를 정당화할 만큼 가치 있는 작업에만 사용해야 한다.

### 4.2 3-Tier 라우팅 비용 모델 (Augment Code 기준)

일반적인 세션: ~104K input tokens, ~60K output tokens, 200 API calls

| 작업 유형 | 모델 | 비용 |
|-----------|------|------|
| 아키텍처 계획 | Opus | $0.140 |
| 복잡한 구현 x3 | Sonnet | $0.468 |
| 빠른 수정 x8 | Haiku | $0.084 |
| 코드 리뷰 x4 | Haiku | $0.060 |
| 테스트 생성 x4 | Sonnet | $0.228 |
| **합계** | 3-tier | **$0.98** |
| **비교** | uniform Opus | **$2.02** |

**절감**: 51% (실무에서는 40-60% 범위) [1]

### 4.3 "토큰 당 비용" vs "검증된 결과 당 비용"

Arize AI의 핵심 통찰:

> "더 저렴한 모델이 자동으로 더 저렴한 시스템을 의미하지는 않는다. 유용한 단위는 토큰 당 비용이 아니라 **검증된 결과 당 비용**(cost per validated outcome)이다." [12]

Haiku 출력이 20% 이상의 빈도로 수정을 요구하면, re-prompting 오버헤드로 인해 비용 이점이 사라진다. [1]

---

## 5. 안티패턴과 함정

### 5.1 Multi-agent를 과도하게 적용하는 경우

Anthropic의 경고:
> "많은 팀이 몇 달을 투자해 정교한 multi-agent 아키텍처를 구축한 뒤, 단일 에이전트의 개선된 프롬프팅이 동등한 결과를 달성한다는 것을 발견한다." [9]

**Multi-agent가 필요한 신호**:
- Context pollution: 한 하위 작업의 무관한 정보가 후속 작업 성능 저하
- 병렬화 기회: 독립적인 리서치 경로나 분리된 컴포넌트
- 전문화가 성능을 향상시키는 경우: 서로 다른 tool set, 도메인 전문성

### 5.2 문제 중심 vs 컨텍스트 중심 분해

**잘못된 분해** (문제 중심): Planning → Implementation → Testing을 별도 에이전트로 분리
- 매 핸드오프마다 컨텍스트 손실
- 지속적인 조율 오버헤드

**올바른 분해** (컨텍스트 중심): 기능을 다루는 에이전트가 해당 기능의 테스트도 함께 처리
- 이미 보유한 컨텍스트를 활용
- 핸드오프 최소화

### 5.3 라우터의 한계

LLMRouterBench (ACL 2026 Findings) 결과:
- 10가지 라우팅 방법을 재평가한 결과, OpenRouter를 포함한 여러 상용 라우터가 **해당 워크로드에 가장 적합한 단일 모델을 쓰는 것보다 안정적으로 낫지 못함** [12]
- 동적 라우팅보다 **역할 기반 정적 할당**이 더 예측 가능하고 안정적

---

## 6. know-thy-build 프로젝트에 대한 적용 권장사항

### 6.1 현재 아키텍처 분석

know-thy-build는 이미 multi-agent 패턴을 사용하고 있다:
- **Orchestrator**: `/know-thy-build:architect`가 sub-agent를 조율하여 구현
- **Feature 설계**: 소크라테스식 대화 에이전트
- **QA**: `know-thy-build:qa`로 행동 테스트 축 정의
- **삼각토론**: `/333`으로 설계 결정에 PRO/NEUTRAL/CON 3-agent 토론

### 6.2 권장 모델 할당 가이드

```
┌─────────────────────────────────────────────────────────────┐
│                    MODEL ALLOCATION GUIDE                     │
├─────────────────┬───────────────┬────────────────────────────┤
│ 역할             │ 모델 Tier     │ 근거                        │
├─────────────────┼───────────────┼────────────────────────────┤
│ Orchestrator    │ Opus (상위)    │ 작업 분해, 의존성 분석,       │
│ (architect,     │               │ 에이전트 간 조율에 deep       │
│  project)       │               │ reasoning 필수              │
├─────────────────┼───────────────┼────────────────────────────┤
│ Deliberation    │ Opus (상위)    │ /333 토론은 전략적 판단.      │
│ (/333 agents)   │               │ 약한 모델은 피상적 논증       │
├─────────────────┼───────────────┼────────────────────────────┤
│ Implementor     │ Sonnet (중간)  │ 코드 생성의 속도-품질-비용    │
│ (coding agents) │               │ 최적 균형점. SWE-bench       │
│                 │               │ 79.6% 달성                  │
├─────────────────┼───────────────┼────────────────────────────┤
│ Reviewer / QA   │ Sonnet (중간)  │ 검증은 생성보다 쉬우나,       │
│                 │               │ 코드 리뷰의 exhaustive       │
│                 │               │ analysis에는 중간급 이상 필요  │
├─────────────────┼───────────────┼────────────────────────────┤
│ Research agent  │ Sonnet (중간)  │ Web search + 정보 합성.      │
│                 │               │ 토큰 효율이 중요             │
├─────────────────┼───────────────┼────────────────────────────┤
│ Explorer /      │ Haiku (하위)   │ 파일 탐색, grep, 단순 읽기.   │
│ Navigator       │               │ 15배 저렴, 동등 품질          │
├─────────────────┼───────────────┼────────────────────────────┤
│ Formatter /     │ Haiku (하위)   │ 보일러플레이트, 포맷 변환,    │
│ Boilerplate     │               │ 단순 변환 작업               │
└─────────────────┴───────────────┴────────────────────────────┘
```

### 6.3 구현 전략: "강한 것으로 시작, 역방향 최적화"

1. **Phase 1**: 모든 에이전트를 상위 모델로 시작 → 품질 기준선 수립
2. **Phase 2**: 에이전트별 출력 품질 측정 (수정 빈도, 재작업률)
3. **Phase 3**: 20% 이상 수정이 필요하지 않은 역할부터 하위 모델로 교체
4. **Phase 4**: 비용-품질 트레이드오프 모니터링 및 지속적 조정

### 6.4 에이전트 정의 파일에 모델 지정하는 방법

Claude Code의 `.claude/agents/*.md` frontmatter에서:

```yaml
---
model: sonnet  # 또는 opus, haiku, fable
---
```

이를 통해 역할별 정적 모델 할당을 선언적으로 관리할 수 있다.

---

## 7. 종합 결론

### 업계 컨센서스

1. **Orchestrator는 상위 모델**: 작업 분해와 조율의 품질이 전체 시스템 성능의 병목
2. **Implementor는 중간 모델**: 코드 생성은 속도-품질-비용의 균형이 핵심
3. **Reviewer/QA는 중간 모델**: 검증은 생성보다 쉽지만, 철저한 분석에는 중간급 이상 필요
4. **Explorer/Navigator는 하위 모델**: 단순 탐색 작업은 저렴한 모델로 충분
5. **동적 라우팅보다 정적 역할 기반 할당이 안정적**: LLMRouterBench 결과가 이를 뒷받침
6. **"토큰 당 비용"이 아니라 "검증된 결과 당 비용"으로 측정**: 저렴한 모델의 재작업 비용을 반영해야

### 핵심 숫자들

- 3-tier 라우팅 → **51% 비용 절감** (vs uniform Opus)
- Opus orchestrator + Sonnet worker → **90.2% 성능 향상** (vs 단일 Opus)
- Multi-agent 시스템 → **~15배 토큰 소비** (vs chat baseline)
- 검증 토큰 vs 생성 토큰 → **2.5배 절감**
- Haiku vs Opus → **15배 저렴**

---

## Sources

1. [Best AI Model for Coding Agents in 2026: A Routing Guide — Augment Code](https://www.augmentcode.com/guides/ai-model-routing-guide)
2. [How we built our multi-agent research system — Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
3. [Building Effective AI Agents — Anthropic](https://www.anthropic.com/engineering/building-effective-agents)
4. [Claude Code Model Selection — ClaudeFast](https://claudefa.st/blog/models/model-selection)
5. [Multi-Agent Verification: Scaling Test-Time Compute with Multiple Verifiers — arXiv:2502.20379](https://arxiv.org/abs/2502.20379)
6. [Fine-Tuning Small Language Models to Optimize Code Review Accuracy — NVIDIA Technical Blog](https://developer.nvidia.com/blog/fine-tuning-small-language-models-to-optimize-code-review-accuracy/)
7. [The Larger the Better? Improved LLM Code-Generation via Budget Reallocation — arXiv:2404.00725](https://arxiv.org/abs/2404.00725)
8. [Variation in Verification: Understanding Verification Dynamics in Large Language Models — arXiv:2509.17995](https://arxiv.org/abs/2509.17995)
9. [When to use multi-agent systems (and when not to) — Claude Blog](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)
10. [CrewAI vs LangGraph vs AutoGen: Choosing the Right Multi-Agent AI Framework — DataCamp](https://www.datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen)
11. [How to Run a Multi-Agent Coding Workspace — Augment Code](https://www.augmentcode.com/guides/how-to-run-a-multi-agent-coding-workspace)
12. [How cheap models changed multi-agent economics — Arize AI](https://arize.com/blog/how-cheap-models-changed-multi-agent-economics/)
13. [Bigger Isn't Always Better: A Comparative Evaluation of LLMs for Automated Code Review — arXiv:2606.15689](https://arxiv.org/abs/2606.15689)
14. [Claude Code Sub-agents Documentation](https://code.claude.com/docs/en/sub-agents)
15. [Claude Benchmarks (2026) — MorphLLM](https://www.morphllm.com/claude-benchmarks)
