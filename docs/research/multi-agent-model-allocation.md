# Research: 멀티 에이전트 개발에서의 모델 티어 배분 전략

Date: 2026-09-06
Question: 멀티 에이전트 코딩 시스템에서 오케스트레이터, 구현 에이전트, 리뷰어에 각각 어떤 모델 티어를 배치하는 것이 최적인가?

---

## 1. 현재 모델 티어별 성능 비교 (2026년 9월 기준)

### 1.1 SWE-bench Verified 결과

| Model | SWE-bench Verified | SWE-bench Pro | 비고 |
|-------|-------------------|---------------|------|
| Claude Fable 5 | 95.0% | — | 현 1위, adaptive thinking 상시 활성 |
| Claude Opus 4.8 | 88.6% | — | |
| Claude Opus 4.6 | 80.8% | — | |
| Claude Sonnet 4.6 | 79.2% | — | Opus 4.6 대비 1.6pp 차이 |
| GPT-5.4 xhigh | 78.2% | — | |
| Claude Haiku 4.5 | 73.3% | — | Opus 4.6 대비 7.5pp 차이 |

**중요 맥락**: OpenAI 내부 감사 결과, 모든 주요 프론티어 모델이 SWE-bench Verified 태스크의 gold patch를 verbatim으로 재현할 수 있는 것으로 밝혀졌다. 500개 Python 태스크가 모델 학습 데이터에 포함되어 있었기 때문. Opus 4.5 기준 Verified 80.9% → Pro 45.9%로 35pp 하락. OpenAI는 2026년 초부터 Verified 점수 보고를 중단하고 SWE-bench Pro를 권장 [1].

### 1.2 Aider Polyglot 벤치마크

| Model | Score | Cost/Run | 비고 |
|-------|-------|----------|------|
| GPT-5 (high reasoning) | 88.0% | $29.08 | 최고 성능, 최고 비용 |
| DeepSeek V3.2 | 74.2% | $1.30 | GPT-5의 84% 성능을 4.5% 비용으로 |

핵심: DeepSeek V3.2가 GPT-5 성능의 84%를 4.5%의 비용으로 달성 — "충분히 좋은" 모델의 경제성 입증 [2].

### 1.3 실제 작업 완료율 (Databricks merged PR benchmark)

| Model | Task Completion | Cost/Task | 비고 |
|-------|----------------|-----------|------|
| Opus 4.8 | 87% | $1.94 | |
| GLM 5.2 | ~87% (통계적 동등) | $1.28 | Opus와 동등 성능, 34% 저렴 |
| Sonnet 5 | 81% | $2.09 | Opus보다 비싸면서 성능은 낮음 |
| Fable 5 | 최고 | ~$12.00 | 7.2M tokens/task 소비 |

**놀라운 발견**: Sonnet 5가 토큰당 가격은 Opus보다 1.7배 저렴하지만, 같은 작업에 1.9배 더 많은 토큰을 소비하여 **작업당 비용은 오히려 Opus보다 높았다** [3].

---

## 2. 모델 가격 비교 (2026년 9월)

### 2.1 Claude 모델 패밀리

| Model | Input/MTok | Output/MTok | Input 배수 (vs Haiku) | Output 배수 (vs Haiku) |
|-------|------------|-------------|---------------------|----------------------|
| Haiku 4.5 | $1.00 | $5.00 | 1x | 1x |
| Sonnet 5 | $2.00 | $10.00 | 2x | 2x |
| Opus 5 | $5.00 | $25.00 | 5x | 5x |
| Opus 4.8 | $5.00 | $25.00 | 5x | 5x |
| Fable 5 | $10.00 | $50.00 | 10x | 10x |

### 2.2 비용 절감 옵션

- **Batch API**: 모든 모델에서 50% 할인 (비동기 처리)
- **Prompt Caching**: 캐시 히트 시 입력 비용 90% 절감. Fable 5.1 cache hit = $0.25/MTok
- **Fast Mode (Opus)**: $10/$50 per MTok (속도 2.5배, 비용 2배)

### 2.3 Cross-Provider 비교

| Model | Input/MTok | Output/MTok | 용도 |
|-------|------------|-------------|------|
| GPT-5.2 | $1.75 | $14.00 | 코드 리뷰에 강점 |
| DeepSeek V3.2 | ~$0.07 | ~$0.28 | 가성비 실행 에이전트 |

---

## 3. "저렴한 모델 × 여러 시도" vs "비싼 모델 × 한 번" 트레이드오프

### 3.1 Self-Repair 연구 결과 ("How Many Tries Does It Take?", 2026.04)

HumanEval 기준 self-repair (에러 피드백 → 재시도) 결과:

| Model | 1회 시도 | 5회 self-repair | 개선폭 |
|-------|---------|----------------|--------|
| Llama 3.1 8B | 67.1% | 76.8% | +9.8pp |
| Llama 3.3 70B | 82.9% | 93.3% | +10.4pp |
| Gemini 2.5 Flash | 86.6% | 96.3% | +9.8pp |
| Gemini 2.5 Pro | 73.2% | 90.2% | +17.1pp |

**핵심 발견**:
- 8B 모델의 5회 self-repair(76.8%)가 70B 모델의 1회 시도(82.9%)에 **근접하지만 도달하지 못함**
- Self-repair는 항상 independent resampling보다 **토큰 효율적** (11~54% 절감)
- **수확 체감**: 첫 2라운드에서 전체 개선의 76~95%가 발생 [4]

### 3.2 에러 유형별 수리 성공률

| Error Type | Repair Success |
|------------|---------------|
| Name errors | ~77% |
| Syntax errors | ~66% |
| Assertion errors (논리 오류) | ~45% |

논리적 오류는 self-repair로 해결하기 가장 어려움 → **복잡한 로직은 처음부터 강한 모델이 필요**.

### 3.3 결론

> **"모델 능력 수준이 초기 성능과 수리 성능 모두에 근본적으로 영향을 미친다."**
> — 저렴한 모델의 다수 시도가 비싼 모델의 단일 시도에 근접할 수 있지만, **완전히 대체하지는 못한다**. 특히 논리적 추론이 필요한 복잡한 작업에서는 프론티어 모델이 여전히 우위.

---

## 4. 역할별 모델 배치 — 업계 공통 패턴

### 4.1 일반적 3-Tier 구조

```
┌──────────────────────────────────────┐
│  ORCHESTRATOR (프론티어 모델)          │
│  역할: 태스크 분해, 위임, 종합, 판단    │
│  모델: Opus 5 / Fable 5              │
│  비중: 전체 토큰의 ~10-20%            │
├──────────────────────────────────────┤
│  EXECUTOR (중간급 모델)               │
│  역할: 코드 생성, 테스트 작성, 검색     │
│  모델: Sonnet 5 / GPT-5.2            │
│  비중: 전체 토큰의 ~60-70%            │
├──────────────────────────────────────┤
│  UTILITY (경량 모델)                  │
│  역할: 파일 탐색, 분류, 보일러플레이트   │
│  모델: Haiku 4.5 / DeepSeek          │
│  비중: 전체 토큰의 ~10-20%            │
└──────────────────────────────────────┘
```

### 4.2 역할별 권장 모델 (Augment Code 가이드, 2026)

| 역할 | 모델 | 근거 |
|------|------|------|
| Orchestrator/Coordinator | Claude Opus 4.6+ | MCP Atlas 59.5% (Sonnet 대비 15-19pp 우위), 깊은 추론 |
| Implementation | Claude Sonnet 4.6+ | SWE-bench 79.6%, 도구 호출 21% 감소, 파일시스템 작업 70% 토큰 효율 |
| File Navigation/Quick | Claude Haiku 4.5 | SWE-bench 73.3%, 입력 토큰 Opus 대비 5배 저렴 |
| Code Review | GPT-5.2 | DryRun Security: 취약점 최소(8개 vs 11-13개), 비동기 리뷰에 적합 |

### 4.3 비용 절감 효과

**3-Tier 라우팅 vs Opus 균일 배포** (Augment Code 측정):

- 일반적 멀티 에이전트 세션: ~104K input tokens / ~60K output tokens
- 3-Tier 비용: **$0.98/세션**
- Opus 균일 비용: **$2.02/세션**
- **절감률: 51%** [5]

**MindStudio 사례**:
- 잘 설계된 워크플로우에서 전체 토큰의 80~90%가 저가 모델로 이동
- 총 토큰 비용 5~10배 절감
- Auth 모듈 리팩토링 예시: Opus 2,000~3,000 토큰 + Haiku/DeepSeek 15,000~25,000 토큰 [6]

### 4.4 Cross-Provider 리뷰의 중요성

**같은 모델 패밀리로 작성 + 리뷰 = blind spot 공유**

> "Claude가 작성한 코드를 Claude가 리뷰하면 같은 학습 편향으로 인해 동일한 사각지대를 가진다. 다른 모델 패밀리의 리뷰어가 보안 이슈와 논리 오류를 유의미하게 더 많이 발견한다." [7]

| 패턴 | 효과 |
|------|------|
| Claude 작성 → GPT 리뷰 | 보안 취약점, dtype coercion 버그 발견 우위 |
| GPT 작성 → Claude 리뷰 | manifest drift, 스펙 불일치 발견 우위 |
| 동일 패밀리 리뷰 | blind spot 공유로 검출률 하락 |

---

## 5. 주요 연구 및 사례

### 5.1 AORCHESTRA (2026.02)

모든 서브에이전트를 4-tuple `(INSTRUCTION, CONTEXT, TOOLS, MODEL)`로 정의하고 오케스트레이터가 온디맨드 스폰. GAIA, SWE-Bench, Terminal-Bench에서 최강 베이스라인 대비 **+16.28% 상대 개선**. Gemini-3-Flash 사용 [8].

### 5.2 AdaptOrch

동적 토폴로지 라우팅으로 정적 단일 토폴로지 대비 **+12~23% 개선**. 핵심: 개선의 원인은 피어 협업이 아니라 **토폴로지 라우팅 자체** [8].

### 5.3 MinionS (Stanford, 2025.02)

Fable 5 + Sonnet 5 조합: GPT-4o 품질의 **97.9%**를 **5.7배 적은 클라우드 비용**으로 달성. BrowseComp에서 all-Fable 팀 점수의 **96%를 46% 비용**으로 유지 [3].

### 5.4 LLMRouterBench (ACL 2026 Findings)

10개 라우팅 방법 재평가 결과: OpenRouter 포함 여러 상용 라우터가 **"워크로드에 최적의 단일 모델을 그냥 쓰는 것"을 안정적으로 이기지 못함** [8].

> ⚠️ **주의**: 동적 라우팅이 항상 이득은 아니다. 500 calls/day 미만이면 라우팅 오버헤드(50-200ms/결정)가 비용 절감을 상쇄한다 [5].

---

## 6. 실용적 가이드라인

### 6.1 오케스트레이터에 절대 아끼지 말 것

> "저렴한 실행자를 쓸 수 있다고 오케스트레이터도 저렴하게 할 수 있는 건 아니다. 작업 분해, 위임, 결과 판단은 정확히 성능의 하한선이 존재하는 능력이다." [8]

### 6.2 토큰당 비용이 아닌 작업당 비용으로 측정

Sonnet 5가 Opus보다 토큰당 저렴하지만, 작업당 비용은 오히려 높을 수 있다 (1.9배 더 많은 토큰 소비). 올바른 측정 공식:

```
Cost per accepted unit = Total spend / Accepted results
(실패한 시도, 재시도, 도구 호출 오버헤드, 리뷰 시간 포함)
```

### 6.3 리뷰는 Cross-Provider로

2026년 기준 dual-model cross-review가 업계 표준. 비용 부담이 적으므로 반드시 다른 모델 패밀리로 리뷰 [7].

### 6.4 Self-Repair 전략

- 첫 2라운드에서 개선의 76~95% 발생 → **최대 3회 재시도로 충분**
- 논리 오류(assertion error)는 self-repair 성공률 45% → **복잡한 로직은 처음부터 강한 모델**
- Self-repair가 independent resampling보다 항상 토큰 효율적 [4]

### 6.5 정적 라우팅 우선

LLMRouterBench 결과에 따르면, 동적 라우터보다 **역할별 정적 배분**이 더 안정적. 동적 라우팅은 500+ calls/day 이상에서만 경제적 [5][8].

---

## 7. know-thy-build 프로젝트 적용 권장안

현재 know-thy-build repo는 멀티 에이전트 기반의 개발 프레임워크이며, 각 역할(architect, designer, QA, feature)에 서브에이전트를 사용한다. 리서치 결과를 바탕으로 한 권장 모델 배분:

### 7.1 역할별 모델 매핑

| Role | Recommended Tier | Rationale |
|------|-----------------|-----------|
| Orchestrator (메인 세션) | Opus 5 / Fable 5 | 태스크 분해, 판단, 종합은 최고 성능 필요 |
| Architect (설계) | Opus 5 | 구조적 결정, 깊은 추론 필요 |
| Feature Spec / Designer | Sonnet 5 | 사용자 대화, 스펙 작성은 중간급으로 충분 |
| Implementation (코딩) | Sonnet 5 | 대부분의 코딩 작업에 충분, 토큰 효율 우수 |
| QA / Testing | Sonnet 5 | 테스트 케이스 생성, 실행 |
| Code Review | Cross-Provider (GPT-5.2 등) | blind spot 방지를 위해 다른 모델 패밀리 |
| File ops / Search | Haiku 4.5 | 단순 탐색, 분류, 보일러플레이트 |

### 7.2 예상 비용 절감

균일 Opus 배포 대비 **40-60% 비용 절감** (Augment Code 측정치 기반).

### 7.3 구현 시 주의사항

1. **오케스트레이터에 아끼지 말 것** — 전체 비용의 10-20%만 차지하면서 결과 품질을 결정
2. **작업당 비용 추적** — `model, accepted/rejected, retry_count, review_minutes` 로깅
3. **Self-repair 최대 3회** — 그 이상은 수확 체감
4. **리뷰는 반드시 cross-provider** — 같은 모델 패밀리의 리뷰는 blind spot 공유

---

## Sources

1. [SWE-bench Leaderboard 2026 — CodeAnt AI](https://codeant.ai/blogs/swe-bench-scores)
2. [Aider LLM Leaderboards](https://aider.chat/docs/leaderboards/)
3. [How Cheap Models Changed Multi-Agent Economics — Arize AI](https://arize.com/blog/how-cheap-models-changed-multi-agent-economics/)
4. [How Many Tries Does It Take? Iterative Self-Repair in LLM Code Generation — arXiv 2604.10508](https://arxiv.org/html/2604.10508v1)
5. [Best AI Model for Coding Agents: A Routing Guide — Augment Code](https://www.augmentcode.com/guides/ai-model-routing-guide)
6. [How to Use a Smart Orchestrator Model to Direct Cheaper Sub-Agent Models — MindStudio](https://www.mindstudio.ai/blog/smart-orchestrator-cheaper-sub-agent-models-claude-code)
7. [Cross-Vendor AI Agent Review — MindStudio](https://www.mindstudio.ai/blog/cross-vendor-ai-agent-review-claude-codex)
8. [Multi-Agent AI Systems in 2026 — FlowHunt](https://www.flowhunt.io/blog/multi-agent-ai-system/)
9. [Claude API Pricing — BenchLM.ai](https://benchlm.ai/anthropic/api-pricing)
10. [Claude Benchmarks 2026 — MorphLLM](https://www.morphllm.com/claude-benchmarks)
11. [6 Multi-Agent Orchestration Patterns for Production — Beam AI](https://beam.ai/agentic-insights/multi-agent-orchestration-patterns-production)
12. [AI Model Orchestration — MindStudio](https://www.mindstudio.ai/blog/ai-model-orchestration-smart-model-cheaper-sub-agents)
13. [Claude Fable 5 Pricing — Finout](https://www.finout.io/blog/claude-fable-5-mythos-5-pricing-benchmarks)
14. [LLMRouterBench — ACL 2026 Findings (referenced in FlowHunt)](https://www.flowhunt.io/blog/multi-agent-ai-system/)
