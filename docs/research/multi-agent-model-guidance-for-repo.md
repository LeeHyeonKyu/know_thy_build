# Research: know-thy-build 모델 배분 가이드

Date: 2026-09-06
Question: know-thy-build 프레임워크의 각 역할(orchestrator, architect, designer, QA, implementer, reviewer)에 어떤 모델 티어를 배치하고, 어떻게 가이드해야 하는가?

**선행 리서치**: [multi-agent-model-allocation.md](./multi-agent-model-allocation.md) — 일반 방법론, 벤치마크 데이터, 업계 패턴

---

## 1. 현재 상태 분석

### 1.1 know-thy-build의 역할 구조

know-thy-build는 5개의 핵심 역할(skill)로 구성된 멀티 에이전트 개발 프레임워크:

| Skill | 역할 | 인지 복잡도 | 토큰 사용 패턴 |
|-------|------|------------|---------------|
| `project` | Socratic 탐색으로 프로젝트 정의 | **높음** — 다각적 질문, 원칙 수립, 위험 평가 | 적음 (대화 중심) |
| `technical` | 기술 의사결정 + TDR 작성 | **높음** — 대안 비교, 적대적 검토, 위험 평가 | 적음 (대화 중심) |
| `feature` | 기능 스펙 + 수락 기준 정의 | **중간** — Socratic 탐색, 스코프 설정 | 적음 (대화 중심) |
| `architect` | 스캐폴드 설계 + 서브에이전트 오케스트레이션 | **최고** — CRC 설계, 적대적 리뷰, 수직 슬라이스 판단, 서브에이전트 조율 | 중간 (코드 생성 + 오케스트레이션) |
| `designer` | UX 흐름 분석 + 디자인 의도 체인 | **높음** — 마이크로스텝 분해, 닐슨 휴리스틱, 인지 워크스루 | 중간 (문서 생성 + 프로토타입) |
| `qa` | 행위 축 테스트 + 실증 기반 검증 | **중간~높음** — 테스트 프로파일 설계, 증거 수집, 실패 주입 | 많음 (실행 + 캡처) |
| `finish` | 게이트 체크 + 병합 | **낮음** — 선형 체크리스트 실행 | 적음 |

### 1.2 현재 모델 구성

**현재 know-thy-build는 모델 배분에 대한 어떠한 가이드도 없다.**

- `.claude/agents/` 디렉토리: 존재하지 않음
- skill 정의(templates/*.md): `model` frontmatter 없음
- CLAUDE.md: 모델 선택 관련 지침 없음
- 모든 역할이 사용자 세션의 현재 모델을 그대로 상속

### 1.3 비교: GSD의 모델 프로파일 시스템

GSD는 이미 성숙한 모델 배분 체계를 구축함:

| Agent | quality | balanced | budget | inherit |
|-------|---------|----------|--------|---------|
| gsd-planner | opus | opus | sonnet | inherit |
| gsd-roadmapper | opus | sonnet | sonnet | inherit |
| gsd-executor | opus | sonnet | sonnet | inherit |
| gsd-phase-researcher | opus | sonnet | haiku | inherit |
| gsd-codebase-mapper | sonnet | haiku | haiku | inherit |
| gsd-verifier | sonnet | sonnet | haiku | inherit |
| gsd-plan-checker | sonnet | sonnet | haiku | inherit |

**GSD의 설계 철학**:
- **Opus는 planning에만** — 아키텍처 결정이 발생하는 곳에 집중
- **Sonnet은 execution에** — 명시적 PLAN.md 지시를 따르는 작업
- **Haiku는 read-only에** — 탐색, 패턴 추출, 구조화된 출력
- **`inherit`** — Opus 티어 에이전트에 사용 → 세션 모델을 따르므로 조직 정책 충돌 방지

---

## 2. 업계 Best Practice 종합 (선행 리서치 기반)

### 2.1 핵심 원칙

1. **오케스트레이터에 절대 아끼지 말 것**
   - 전체 토큰의 10-20%만 차지하지만 결과 품질을 결정
   - Arize AI: "저렴한 실행자를 쓸 수 있다고 오케스트레이터도 저렴하게 할 수 있는 건 아니다"
   - Writer Inc: 위임 능력은 최강 2개 모델에서만 안정적 (0.85), 하위 티어에서 불안정 (0.45)

2. **토큰당 비용이 아닌 작업당 비용으로 측정**
   - Databricks: Sonnet 5가 토큰당은 Opus보다 1.7배 저렴하지만, 1.9배 더 많은 토큰 소비 → 작업당 비용 역전
   - 올바른 공식: `Cost = Total spend / Accepted results`

3. **리뷰는 Cross-Provider로**
   - Claude 작성 → Claude 리뷰 = blind spot 공유
   - 2026년 업계 표준: dual-model cross-review

4. **정적 라우팅이 동적 라우팅보다 안정적**
   - LLMRouterBench (ACL 2026): 동적 라우터가 최적 단일 모델을 안정적으로 이기지 못함
   - 동적 라우팅은 500+ calls/day 이상에서만 경제적

5. **Self-repair 최대 3회**
   - 첫 2라운드에서 전체 개선의 76~95% 발생
   - 논리 오류(assertion error) self-repair 성공률 45% → 복잡한 로직은 처음부터 강한 모델

### 2.2 Anthropic 자체 사례

Anthropic의 Research 시스템:
- Lead agent(Opus 4) + Subagents(Sonnet 4)
- 단일 에이전트 Opus 4 대비 **90.2% 성능 향상**
- "Sonnet으로의 업그레이드가 토큰 예산을 2배로 늘리는 것보다 더 큰 성능 개선"

### 2.3 비용 절감 실측치

| Source | Pattern | Savings |
|--------|---------|---------|
| Augment Code | 3-Tier (Opus+Sonnet+Haiku) vs all-Opus | **51%** ($0.98 vs $2.02/session) |
| MindStudio | 80-90% 토큰을 저가 모델로 이동 | **5-10x** |
| Arize AI / MinionS | Fable + Sonnet 조합 | **46% cost, 96% quality** |
| RouteLLM | 14-26% 만 frontier로 라우팅 | **75-85%** |

---

## 3. know-thy-build 권장 모델 프로파일

### 3.1 프로파일 정의

GSD의 검증된 3-profile + inherit 체계를 차용하되, know-thy-build의 역할 특성에 맞게 조정:

| Role (Skill) | quality | balanced | budget | inherit |
|-------------|---------|----------|--------|---------|
| **Orchestrator** (메인 세션, feature dispatch) | opus | opus | sonnet | inherit |
| **architect** (설계 + 서브에이전트 오케스트레이션) | opus | opus | sonnet | inherit |
| **architect → implementer** (서브에이전트) | opus | sonnet | sonnet | inherit |
| **project** (프로젝트 정의) | opus | sonnet | sonnet | inherit |
| **technical** (기술 의사결정) | opus | opus | sonnet | inherit |
| **designer** (UX 분석 + 프로토타입) | opus | sonnet | sonnet | inherit |
| **feature** (기능 스펙) | opus | sonnet | sonnet | inherit |
| **qa** REVIEW (테스트 케이스 설계) | opus | sonnet | sonnet | inherit |
| **qa** TEST (실행 + 증거 수집) | sonnet | sonnet | haiku | inherit |
| **finish** (게이트 체크) | sonnet | haiku | haiku | inherit |
| **Explore / File search** | haiku | haiku | haiku | inherit |
| **Code Review** (별도 리뷰) | cross-provider¹ | cross-provider¹ | sonnet | inherit |

¹ Cross-provider 리뷰: GPT-5.2 또는 다른 모델 패밀리 권장 (blind spot 방지)

### 3.2 배치 근거 (Design Rationale)

#### Opus가 필요한 역할 (balanced 이상)

**Orchestrator + Architect + Technical:**
- 이유: 아키텍처 결정, CRC 카드 설계, 적대적 리뷰, 수직 슬라이스 판단 → 깊은 추론 필수
- 근거: MCP Atlas에서 Opus가 Sonnet 대비 15-19pp 우위 (orchestration 능력)
- 비용 영향: 전체 토큰의 ~15-25%만 차지 → 비용 대비 품질 영향 극대화

#### Sonnet이 적합한 역할 (balanced)

**Project + Feature + Designer + QA Review + Implementer:**
- 이유: 명시적 프로토콜(Design Tree, Frontier Questions)을 따르는 구조화된 작업
- 근거: SWE-bench 79.6%, 도구 호출 21% 감소, 파일시스템 작업 70% 토큰 효율
- 핵심: 프로토콜이 충분히 명시적이면 추론 깊이보다 지시 따르기 능력이 중요

#### Haiku가 적합한 역할

**QA Test 실행 + Finish + Explore:**
- 이유: 선형 체크리스트 실행, 파일 탐색, 단순 검증 → 추론 불필요
- 근거: QA test 실행은 이미 정의된 테스트 케이스를 따라가는 것이므로 판단 최소
- 주의: Haiku 보정률 20% 초과 시 비용 이점 소멸 → 모니터링 필요

### 3.3 프로파일 선택 가이드

| Profile | 사용 시점 | 예상 비용 (vs all-Opus) |
|---------|----------|----------------------|
| **quality** | 핵심 아키텍처 작업, 초기 프로젝트 정의, 고위험 결정 | ~80% |
| **balanced** (기본값) | 일반 개발, 대부분의 기능 구현 | ~50% |
| **budget** | 프로토타이핑, 반복적 작업, 비용 민감한 환경 | ~30% |
| **inherit** | OpenRouter/로컬 모델 사용, 런타임 모델 전환 필요 시 | 가변 |

---

## 4. 구현 권장 사항

### 4.1 Phase 1: CLAUDE.md에 모델 가이드 추가

CLAUDE.md에 모델 배분 원칙 섹션 추가:

```markdown
## Model Allocation (모델 배분 원칙)

### 핵심 규칙
1. **오케스트레이터와 설계 역할에 아끼지 말 것** — architect, technical 은 항상 최고 티어
2. **실행 역할은 중간 티어** — implementation, feature spec, designer 는 Sonnet 이상
3. **단순 작업은 경량 모델** — finish, explore, file search 는 Haiku
4. **리뷰는 Cross-Provider** — 같은 모델 패밀리의 리뷰는 blind spot 공유

### 프로파일
- `quality`: 핵심 아키텍처, 초기 프로젝트 정의, 고위험 결정
- `balanced` (기본): 일반 개발, 대부분의 기능 구현
- `budget`: 프로토타이핑, 반복, 비용 민감
- `inherit`: OpenRouter/로컬 모델

### 비용 최적화
- 토큰당 비용이 아닌 **작업당 비용**으로 측정
- Self-repair는 **최대 3회** — 그 이상은 수확 체감
- Haiku 보정률 20% 초과 시 Sonnet으로 업그레이드
```

### 4.2 Phase 2: Skill frontmatter에 model 힌트 추가

각 skill의 frontmatter에 권장 모델 힌트를 추가하여, agent 시스템이 자동으로 참조할 수 있게:

```yaml
---
description: ...
allowed-tools: [...]
model-hint:
  quality: opus
  balanced: opus   # architect는 balanced에서도 opus
  budget: sonnet
---
```

### 4.3 Phase 3: 서브에이전트 디스패치 시 모델 명시

architect가 서브에이전트를 디스패치할 때 model을 명시하도록 프로토콜 보강:

현재 architect.md의 서브에이전트 디스패치는 model을 지정하지 않음. 추가 가이드:

```markdown
### Sub-Agent Model Selection

When dispatching implementation sub-agents, use the model appropriate to the task:
- **Implementation (fill stubs)**: Sonnet — follows explicit PRE/POST contracts
- **Complex logic (deep reasoning required)**: Opus — when PRE/POST alone isn't enough
- **Boilerplate/config**: Haiku — deterministic, single-file tasks
```

### 4.4 Phase 4: 리뷰 역할 독립화

현재 architect review, designer review, QA test가 모두 같은 모델 세션에서 실행됨. 
리뷰 효과를 극대화하려면:

1. **최소한 QA TEST 는 별도 서브에이전트로** — 테스트 실행에 Sonnet/Haiku 배분
2. **Code Review 는 별도 skill로 분리 가능** — cross-provider 리뷰를 위한 진입점
3. **기존 `/code-review` skill 활용** — 이미 존재하는 skill에 cross-provider 가이드 추가

---

## 5. 주의사항 및 한계

### 5.1 know-thy-build 특수 상황

1. **대화형 역할 (project, feature)은 토큰 소비가 적다**
   - 사용자와의 대화가 중심이므로, 여기에 Opus를 쓰는 비용 증가는 미미
   - 하지만 판단 품질이 프로젝트 방향을 좌우하므로, balanced에서도 Sonnet 권장

2. **architect는 오케스트레이터이자 설계자**
   - GSD에서 planner와 executor가 분리된 것과 달리, architect가 설계 + 오케스트레이션을 모두 담당
   - 따라서 architect는 balanced에서도 opus 유지

3. **QA의 이중 성격**
   - REVIEW 모드: 테스트 케이스 **설계** → 판단력 필요 → Sonnet 이상
   - TEST 모드: 테스트 케이스 **실행** → 프로토콜 따르기 → Haiku 가능
   - 단, 탐색적 테스트(autonomous exploration)는 Sonnet 필요

### 5.2 측정하지 않으면 최적화하지 말 것

모델 배분 전에 먼저 측정 인프라를 구축해야 함:
- 역할별 토큰 소비량
- 역할별 작업 완료율 (accepted/rejected)
- 서브에이전트 재시도 횟수
- 전체 기능 라이프사이클 비용

### 5.3 이 가이드의 유효 기간

모델 성능과 가격은 빠르게 변화함. 이 가이드는 **2026년 9월** 기준이며, 다음 조건에서 재검토 필요:
- 새로운 주요 모델 출시 시
- 가격 변경 시
- 실측 데이터가 권장과 크게 다를 때

---

## 6. 참조 프레임워크 비교

### 6.1 GSD vs know-thy-build 역할 매핑

| GSD Agent | know-thy-build 대응 역할 | 모델 근거 공유 |
|-----------|------------------------|--------------|
| gsd-planner | architect | Opus — 구조적 결정 |
| gsd-roadmapper | project | Sonnet — 구조화된 탐색 |
| gsd-executor | architect → implementer (sub) | Sonnet — 명시적 지시 따르기 |
| gsd-phase-researcher | (research agent in CLAUDE.md) | Sonnet — 정보 수집 |
| gsd-verifier | qa (TEST mode) | Sonnet/Haiku — 체크리스트 실행 |
| gsd-codebase-mapper | (Explore agent) | Haiku — read-only 탐색 |

### 6.2 CrewAI / AutoGen 방식과의 차이

- **CrewAI**: 역할(role) 기반이지만 모델 배분 표준은 없음 → 사용자가 직접 지정
- **AutoGen**: 대화 패턴 기반, 모델은 에이전트 정의 시 지정 → 역할별 최적화 없음
- **GSD**: 검증된 profile 시스템 → know-thy-build가 채택 가능한 가장 성숙한 모델

know-thy-build는 GSD의 profile 체계를 참조하되, 역할 특성에 맞게 조정하는 것이 최선.

---

## Sources

### 선행 리서치 (업계 전반)
→ [multi-agent-model-allocation.md](./multi-agent-model-allocation.md) 참조

### 추가 출처 (이 문서 작성 시 참조)
1. [Model Routing for Coding Agents — Unblocked](https://getunblocked.com/blog/model-routing-coding-agents/)
2. [How Cheap Models Changed Multi-Agent Economics — Arize AI](https://arize.com/blog/how-cheap-models-changed-multi-agent-economics/)
3. [AI Orchestrator Architecture Guide — MindStudio](https://www.mindstudio.ai/blog/ai-orchestrator-cheaper-sub-agent-models)
4. [Claude Code Model Routing for Subagents — jsmanifest](https://jsmanifest.com/claude-model-routing-subagents)
5. [Best AI Model for Coding Agents: A Routing Guide — Augment Code](https://www.augmentcode.com/guides/ai-model-routing-guide)
6. [How We Built Our Multi-Agent Research System — Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
7. [GSD Model Profiles — ~/.claude/get-shit-done/references/model-profiles.md](local)
8. [GSD Model Profile Resolution — ~/.claude/get-shit-done/references/model-profile-resolution.md](local)
