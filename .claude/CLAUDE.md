# Know Thy Build — Project Configuration

## Research-First Protocol (리서치 우선)

This project requires **primary-source research before significant decisions or unfamiliar work**. Do not rely on general knowledge or secondary summaries when primary sources exist.

### When to research

Launch a research agent automatically when any of these conditions occur:

| Trigger | Example |
|---------|---------|
| **Unfamiliar technology** | About to use a library, framework, or API pattern you haven't seen in this codebase |
| **Before deliberation** | A decision point is detected — research first, then feed evidence into the debate |
| **Implementation of new patterns** | Introducing a pattern (state management, auth flow, testing strategy) that doesn't exist in the codebase yet |
| **External dependency evaluation** | Choosing between libraries, services, or tools |
| **Conflicting information** | Your knowledge might be outdated or you find contradictory claims |

### How to research

Launch a background research agent using the Agent tool:

```
Research agent prompt:
"Investigate [topic] against PRIMARY SOURCES — official docs, source code, specs, first-party APIs.
Follow every claim back to the source that owns it.
Write findings to docs/research/[topic-slug].md with citations.
Focus on: [specific questions relevant to the decision]."
```

**Primary source hierarchy:**
1. Official documentation and specs
2. Source code of the library/framework itself
3. First-party blog posts and changelogs
4. RFCs and standards documents
5. Peer-reviewed papers or credible benchmarks

Secondary sources (blog posts, tutorials, Stack Overflow) are supplementary, never authoritative.

### Research → Deliberation pipeline

When both protocols trigger (most decisions), the flow is:

```
Decision point detected
  ↓
Launch research agent (background) — gathers primary-source evidence
  ↓
Research output saved to docs/research/[topic].md
  ↓
Launch /333 debate — each agent receives the research as input context
  ↓
Synthesize → Decide → Record
```

The research output becomes shared evidence for all debate agents, ensuring arguments are grounded in facts rather than general knowledge.

### Research output convention

Save research to `docs/research/` (create if needed). One file per topic. Format:

```markdown
# Research: [Topic]
Date: [date]
Question: [what we needed to know]

## Findings
[organized by sub-question, each claim citing its source]

## Sources
[numbered list of primary sources with URLs]
```

### When NOT to research

- The codebase already uses the technology and patterns are established
- The decision is about user preferences, not technical facts
- The topic is well within the agent's training data AND no primary source would add value
- Time-critical bug fixes where the root cause is clear

## Deliberation Protocol (삼각토론 기본 적용)

This project uses structured multi-perspective deliberation as the **default decision-making mechanism**. Do not present unvetted options or make significant design choices without running the deliberation process first.

### When to trigger

Invoke deliberation automatically — without the user asking — when any of these conditions occur:

| Trigger | Example |
|---------|---------|
| **Choice point** | About to present "Option A vs Option B" to the user |
| **Contentious issue** | A design or implementation question where reasonable engineers would disagree |
| **Implementation confusion** | Uncertain about the right approach; could justify multiple paths |
| **Architecture decision** | Any structural choice affecting more than one component |
| **Trade-off evaluation** | Performance vs readability, flexibility vs simplicity, etc. |

### How to invoke

**If you have the Skill tool available:** invoke `/333` (the Triangular Debate skill). This is the preferred method — it launches PRO/NEUTRAL/CON agents with web research and evidence-based arguments.

**If you do NOT have the Skill tool** (sub-agents, restricted skill contexts): run the **Embedded Debate Protocol** below using the Agent tool.

### Embedded Debate Protocol (for agents without Skill tool)

When the Skill tool is unavailable but the Agent tool is, launch 3 agents in parallel:

```
Agent 1 — PRO (찬성): Defend the proposed approach. Find real evidence. Be aggressive.
Agent 2 — NEUTRAL (중립): Analyze objectively. Compare alternatives with trade-offs.
Agent 3 — CON (반대): Attack the proposal. Find fundamental flaws. Propose a radically different alternative.
```

Each agent MUST:
- Search for real evidence (papers, frameworks, production examples)
- Make concrete arguments, not vague claims
- Be aggressive in their assigned role

After receiving all 3 perspectives:
1. Identify the strongest argument from each side
2. **Make a decision** — do NOT present "it depends"
3. Present a summary table showing which arguments survived rebuttal
4. Record the decision with rationale

### Partial Implementation as Evidence

When a debate would benefit from concrete evidence rather than speculation:
1. Create throwaway implementations of competing approaches (spike/prototype)
2. Run them, measure results, collect data
3. Feed the evidence into the debate as input
4. Delete the throwaway code after the decision

This is especially valuable for performance trade-offs, API design questions, and "will this actually work?" uncertainties.

### Sub-agent dispatch rules

When dispatching ANY sub-agent in this project:

1. **Fork sub-agents**: Inherit this protocol via context — no extra instructions needed
2. **Fresh sub-agents with Agent tool**: Include in their prompt:
   > "When you face a design choice or implementation uncertainty with multiple valid approaches, run a 3-agent debate (PRO/NEUTRAL/CON) before proceeding. Each agent must provide evidence-based arguments. Synthesize into a decision, not a menu of options."
3. **Fresh sub-agents without Agent tool**: Include in their prompt:
   > "When you face a design choice or implementation uncertainty, present your analysis as: (1) your recommendation with strongest evidence, (2) the best counter-argument against it, (3) what would have to be true for the counter-argument to win. Escalate to the orchestrator if the decision is structural."

### When NOT to trigger

- Trivial formatting, naming, or style choices with established conventions
- Following an existing pattern with no ambiguity
- The user has already made a clear decision and wants execution
- Pure fact-finding questions with one correct answer
- Bug fixes where the root cause is clear

## Active Design Contracts

Before implementing any feature, check if a design contract exists at `docs/features/NNN-contract.md`.
If one exists: read it, follow the approved structure, do not modify signature contract tests.
If none exists: run `/know-thy-build:architect` before implementing.

## 운영 머지 — 소유자는 서명 기계가 아니다 (2026-10-10, 소유자 결정, ADR-039)

소유자: "사람 역할 하는 agent를 하나 띄워서 나한테 PR 검토 받지 않고 merge하도록 해." 그래서:

1. **공장이 만든 PR**은 CHARTER `self_change.auto_merge_judge: true` — 만장일치 리뷰 + GREEN + 거부권 창 60분 + 차단기 닫힘이면 공장이 머지한다(ADR-033). 소유자에게 머지를 요청하지 않는다.
2. **운영 세션이 만든 PR**(`.github/**`·templates·CHARTER·`factory/**` 핫픽스 등 판정 경로 포함)은 운영 세션이 운영 door(`gh pr merge <n> --squash --admin`, CHARTER `operator_merge_judge: true`)로 직접 머지한다. 단, 머지 전에 **반드시**:
   - 전체 스위트(`GITHUB_ACTIONS=true npx vitest run`)와, 워크플로를 건드렸으면 `actionlint`가 clean이고 PR 체크가 GREEN이다.
   - **대역 리뷰어 에이전트**를 하나 띄운다(`Agent`, fresh `general-purpose`, 읽기 전용): PR diff·이슈·ADR을 cold read로 보고 `approve | reject(must_fix)`를 낸다. reject면 고치고 다시 띄운다. 이 에이전트는 작성자(운영 세션)와 다른 컨텍스트여야 한다 — 같은 세션의 자기 확인은 리뷰가 아니다.
   - PR 본문에 그 판정 요지(`Stand-in review: approve — …`)를 남긴다.
3. 소유자에게 남는 것은 **거부권**(revert·`factory:veto`·차단기 리셋)이다. 사람에게 무언가를 요청하는 것은 토큰·시크릿·계정처럼 **사람만 할 수 있는 것**뿐이다.

## SDD 비용 정책 (2026-09-21, 소유자 승인)

서브에이전트 주도 개발(SDD)로 이 저장소를 바꿀 때 지키는 규칙. 리뷰 깊이는 줄이지 않는다 — 실제 결함은 적대적 리뷰가 잡았다.

1. **리뷰어는 범위 스위트만 돌린다.** 전체 스위트는 컨트롤러가 병합 직전 **직렬로 1회**, 릴리스 PR 전에는 `GITHUB_ACTIONS=true`로 건드린 스위트를 한 번 더.
2. **수정 2라운드를 넘기면 작성자를 재개하지 않고 새 작성자**에게 diff 전용 브리프 + 장부의 미결 findings·판정을 준다. 범위 재리뷰는 계속한다.
3. **플랜 밖 인사이트는 이슈로 적고 다음 마이너 릴리스로.** 즉시 반영은 "스펙의 주장이 거짓이 되거나, 배포가 깨지거나, 데이터가 오염되는" 경우만. 이월한 이슈 번호를 장부와 릴리스 노트에 남긴다.
4. **예상 diff 2천 줄 초과 태스크는 플랜에서 분할**하고 Interfaces 블록으로 경계를 못 박는다.
5. **작성자·리뷰어 브리프 고정 문구 3종**: 판정은 러너 기록·에이전트 불가쓰기 사실에만 앵커 / 픽스처는 실제 생산자 함수로, 실제 이슈는 실제 텍스트로 / 환경 분기(`GITHUB_ACTIONS` 등)는 `env`를 명시 주입하고 두 경로를 모두 핀.
