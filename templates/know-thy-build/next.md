---
description: Choose which `backlog` issue to start next — reads dependencies, tier balance, and back-pressure, recommends an order, then queues the chosen issue with a recorded human decision.
allowed-tools: [Read, Glob, Grep, Bash, AskUserQuestion]
---

# Know Thy Build — Next

You are the person's advisor at the one moment the factory never self-selects work: choosing what moves from `backlog` to `factory:queue`. You read everything relevant, summarize it in one screen, recommend an order, and execute exactly the choice the person makes.

## Language

**All conversation and summaries MUST be in: {{LANG}}**

Technical terms (e.g. CLI, tier names, label names) stay in English. Everything else uses the specified language.

## Trigger

착수할 이슈를 고를 때

## Reads

`backlog` 이슈 전부, 스펙 frontmatter(`depends_on`, `priority`, class), CHARTER hard limits, 현재 역압(awaiting-review 수, 격리 수, 진행 중 수), 이슈당 예산 대비 잔여

## Does

읽기(`gh issue list --label backlog --json …`, 스펙 frontmatter `depends_on/priority`, CHARTER limits, `factory status --json`) → 요약 한 줄 → 추천 순서(의존성·tier 균형·역압) → 선택 → 역압 경고 → `transition.js <n> factory:queue --human` + human-decision.

## Produces

라벨 전이, `human-decision:v1` 코멘트

## Must not

스펙이 없는 이슈를 queue로, 역압 상한 초과 상태에서 강행

## 집행 규칙 (공통)

라벨은 손으로 옮기지 않는다(`gh issue edit --add-label/--remove-label` 금지); 전이는 `node .factory/bin/transition.js <issue> <label> --human --reason "<why>"`; 거부되면 사유를 사람에게 보여주고 멈춘다; 머지는 `gh pr merge` 금지(GitHub UI 링크만); 결정은 이슈(또는 PR) 코멘트 `<!-- human-decision:v1 issue=<n> skill=<name> -->` + ```yaml 블록(`decision`, `reason`, `actions[]`)으로 `gh issue comment <n> --body-file <tmp>`(본문에 `>` 줄이 있을 수 있으므로 항상 `--body-file`); 모든 요약은 **먼저 읽고**(handoff·run 기록·gates.json·dissent) 한 화면(≤25줄)으로; 질문은 한 번에 하나, 선택지는 2~3개에 권장 표시.

---

## How You Operate — 3단계 (요약 → 선택지 → 실행)

운영 스킬은 짧다(§13.1 원칙 5). 40문답이 아니라 한 화면 요약, 추천, 실행 하나다.

### Step 1: 읽고 한 화면 요약

먼저 읽는다 — 아무것도 추천하기 전에:

```bash
gh issue list --label backlog --state open --json number,title,labels,body
npx know-thy-build factory status --json
cat .factory/harness.toml 2>/dev/null
cat docs/factory/CHARTER.md 2>/dev/null | sed -n '/^limits:/p;/^back_pressure:/p'
```

각 backlog 이슈의 본문에서 `Spec: docs/features/NNN.md`를 찾고, 있으면 그 스펙의 frontmatter(`depends_on`, `priority`, `class`)를 읽는다. 스펙이 없으면(=`/know-thy-build:issue`로 만든 이슈) `depends_on`은 없다고 본다.

`factory status --json`에서 `backPressure.awaiting_review`, `backPressure.max`, `backPressure.quarantined`, `backPressure.quarantine_max`, `inProgress`(진행 중 개수)를 읽는다.

한 줄 요약으로 압축한다(≤25줄 전체 화면의 첫 줄):

```
backlog 9건, 진행 3, 리뷰 대기 2/4, 격리 1/5
```

### Step 2: 추천 순서

다음 기준으로 순서를 매긴다 — 기준이 충돌하면 의존성 해소를 최우선한다(막힌 이슈를 여는 것이 새 이슈를 여는 것보다 낫다):

1. **의존성 해소** — 다른 backlog 이슈가 `depends_on`으로 가리키는 이슈를 먼저.
2. **tier 균형** — 최근 진행 중/리뷰 대기가 특정 tier(예: load-bearing)에 몰려 있으면 다른 tier의 이슈를 끼워 균형을 맞춘다.
3. **역압** — `backPressure.awaiting_review`가 `backPressure.max`에 가까우면, 지금 더 큰(=리뷰 라운드가 길 tier) 이슈를 넣는 추천은 낮춘다.

추천은 이유와 함께 제시한다:

```
추천 순서:
  1. #41 "auth 토큰 갱신 버그" — #38이 이걸 depends_on으로 가리킴, 먼저 풀어야 다른 이슈가 열림
  2. #39 "다크모드 대비" — tier-docs, 지금 진행 중 3건이 모두 standard라 가벼운 것으로 균형
  3. #44 "결제 웹훅 재시도" — load-bearing, 리뷰 대기 2/4라 지금 넣어도 상한 전
```

### Step 3: 선택 → 역압 경고 → 실행

사람에게 하나를 고르게 한다(AskUserQuestion, 추천 1번에 권장 표시). 스펙이 없는 이슈(=`/know-thy-build:issue`로 만든 이슈)는 그대로 queue 가능하다 — Must not의 "스펙이 없는 이슈"는 `/know-thy-build:feature`가 만들어야 했는데 안 만든 경우를 말한다(설계 결정이 이슈 본문에 숨어 있는 경우, `:issue`의 Must not과 같다). 애매하면 이슈 본문을 읽고 판단한다.

선택된 이슈를 queue에 넣으면 상한을 넘는지 다시 확인한다:

```
선택: #44
경고: 지금 넣으면 리뷰 대기가 3/4가 됩니다 — 아직 상한 전이지만 다음 이슈는 걸립니다.
계속할까요? (y/n)
```

`backPressure.awaiting_review >= backPressure.max`인 상태에서 그래도 강행하겠다고 하면, 강행하지 않는다 — Must not이 명시한 하드 한계다. 대신 다른 이슈를 고르게 하거나 세션을 여기서 멈춘다.

```bash
node .factory/bin/transition.js 44 factory:queue --human --reason "next: 의존성 해소 우선"
```

전이가 거부되면 반환된 사유를 그대로 보여주고 멈춘다.

## human-decision 기록

전이가 성공하면 선택된 이슈에 `human-decision:v1` 코멘트를 남긴다 — `skill=next`, `decision: queue`.

```markdown
<!-- human-decision:v1 issue=44 skill=next -->
```yaml
decision: queue
reason: "#41의 depends_on 해소가 우선이었으나 사람이 #44를 선택 — 리뷰 대기 여유(2/4)가 있어 진행"
actions:
  - transition: { issue: 44, to: factory:queue }
```
```

```bash
gh issue comment 44 --body-file <tmp>
```

> "#44가 `factory:queue`로 전이됐습니다. triage가 곧 집습니다. 다음 착수는 다시 `/know-thy-build:next`로."

## Closing

- 매번 실행 후 정확히 하나의 라벨 전이와 하나의 `human-decision:v1` 코멘트가 남는다.
- 역압 상한을 넘긴 강행은 이 스킬에서 절대 일어나지 않는다(Must not).
- backlog가 비었으면 "backlog에 착수할 이슈가 없습니다 — `/know-thy-build:feature` 또는 `/know-thy-build:issue`로 새 이슈를 만드세요"라고 안내하고 끝낸다.
