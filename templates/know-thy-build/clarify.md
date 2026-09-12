---
description: Resolve `factory:needs-info` — read the triage handoff's questions, ask them one at a time, write the answers into the spec and issue body, then queue the issue again.
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion]
---

# Know Thy Build — Clarify

You are the person's voice when triage says an issue is too ambiguous to plan. Your only job here is to carry the person's answers into the spec and the issue — never to answer for them.

## Language

**All conversation, questions, and updated documents MUST be in: {{LANG}}**

Technical terms (e.g. API, schema, field names) stay in English. Everything else uses the specified language.

## Trigger

`factory:needs-info`

## Reads

triage handoff의 `questions[]`, 스펙, 이슈 코멘트

## Does

질문을 하나씩 소크라테스식으로 → 답을 스펙 본문과 이슈 본문에 반영 → 스펙 frontmatter 갱신 → `transition.js <n> factory:queue --human`

## Produces

갱신된 스펙·이슈, 라벨 전이

## Must not

질문에 스스로 답해 진행. 한 번에 질문을 하나 이상 던지기.

## 집행 규칙 (공통)

**Guard**: 무엇을 하기 전에 `.factory/bin/run-stage.js`가 있는지 먼저 본다 — 없으면 이 저장소에는 아직 factory가 없다. 그때는 "factory가 아직 없음 — `npx know-thy-build factory init`" 한 줄만 출력하고 즉시 멈춘다(아무것도 읽거나 쓰지 않는다).

라벨은 손으로 옮기지 않는다(`gh issue edit --add-label/--remove-label` 금지); 전이는 `node .factory/bin/transition.js <issue> <label> --human --reason "<why>"`; 거부되면 사유를 사람에게 보여주고 멈춘다; 머지는 `gh pr merge` 금지(GitHub UI 링크만); 결정은 이슈(또는 PR) 코멘트 `<!-- human-decision:v1 issue=<n> skill=<name> -->` + ```yaml 블록(`decision`, `reason`, `actions[]`)으로 `gh issue comment <n> --body-file <tmp>`(본문에 `>` 줄이 있을 수 있으므로 항상 `--body-file`); 모든 요약은 **먼저 읽고**(handoff·run 기록·gates.json·dissent) 한 화면(≤25줄)으로; 질문은 한 번에 하나, 선택지는 2~3개에 권장 표시.

---

## How You Operate — 3단계 (요약 → 선택지 → 실행)

### Step 1: 질문 읽기

triage가 이 이슈를 `needs-info`로 보낸 이유는 이슈 코멘트에 남긴 handoff에 있다 — 마커는 `<!-- factory-handoff:v1 stage=triage issue=<n> -->`, 그 뒤 사람이 읽을 요약, 그리고 ` ```json ` 펜스 안에 기계가 읽는 블록이 온다. 질문은 그 JSON의 `questions[]`에 있다.

```bash
gh issue view 52 --comments --json comments
```

반환된 코멘트들 중 `<!-- factory-handoff:v1 stage=triage issue=52 -->` 마커가 있는 것을 찾아 ` ```json ` 펜스를 파싱한다:

```json
{
  "disposition": "needs-info",
  "tier": null,
  "questions": [
    "이 기능은 기존 v1 API를 대체하나, 아니면 병행하나?",
    "결제 실패 시 재시도 횟수 상한이 있나?"
  ]
}
```

`questions[]`가 비어 있으면(=triage가 다른 이유로 needs-info를 붙였다면) 이슈 코멘트 전체를 사람에게 보여주고 무엇을 물어야 하는지 함께 정한다 — 추측해서 만들어내지 않는다.

관련 스펙이 있으면(이슈 본문의 `Spec: docs/features/NNN.md`) 함께 읽는다:

```bash
cat docs/features/NNN.md 2>/dev/null
```

### Step 2: 한 번에 하나씩, 소크라테스식으로

`questions[]`의 각 항목을 순서대로, **한 번에 하나만** 사람에게 묻는다. 질문을 그대로 복사해 던지지 않는다 — 왜 triage가 이걸 모호하다고 봤는지 한 문장 맥락을 붙이고, 가능하면 2~3개 선택지에 권장 표시를 단다:

```
❓ Q1 (triage가 모호하다고 본 지점) — 이 기능은 기존 v1 API를 대체하나, 아니면 병행하나?

맥락: 스펙 §Solution이 "v1을 개선"이라고만 써서, 대체/병행 여부가 diff 범위를 결정하지 못했습니다.

  1. 대체 — v1 엔드포인트를 제거 (스펙의 Scope.Excludes와 상충 가능성 확인 필요)
  2. 병행 — v1은 유지, v2를 신설 (권장: 스펙의 마이그레이션 언급 없음과 일치)

➡️ 어느 쪽인가요?
```

사람이 답하면 **바로 다음 질문으로 넘어가기 전에** 그 답을 스펙/이슈 본문에 반영할 위치를 확인한다(이 문서 Step 3). 다음 질문은 그 반영이 끝난 뒤에 던진다 — 답변이 쌓이는 동안 스펙이 오래된 상태로 남아 있지 않게 한다.

**절대 스스로 답하지 않는다.** 답이 코드나 문서에서 사실로 확인 가능해 보여도(예: "v1 엔드포인트가 코드에 아직 있다") 그것은 사실 확인일 뿐 결정이 아니다 — 사실을 제시하고 결정은 사람에게 묻는다.

### Step 3: 스펙과 이슈에 반영

답이 나오는 즉시 두 곳에 반영한다 — 둘 다 해야 한다, 하나만으로는 spec-conformance 리뷰어와 triage가 서로 다른 사실을 보게 된다:

1. **스펙 본문** — `Edit` 도구로 관련 섹션(Solution/Scope/Open Questions 등)을 갱신한다. 전체를 다시 쓰지 않는다.
2. **이슈 본문** — `gh issue edit`으로 `done_when`이나 설명이 바뀌었으면 반영한다:

```bash
gh issue edit 52 --body-file <tmp>
```

본문에 `>` 인용 줄이 있을 수 있으므로 항상 `--body-file`을 쓴다(인라인 `--body`는 셸이 깨뜨릴 수 있다).

스펙 frontmatter도 갱신한다(예: `depends_on`, `priority`가 답변으로 바뀌면) — `Edit`으로 해당 줄만 바꾼다.

모든 질문에 답이 나오고 반영이 끝나면 Step 4로 간다.

### Step 4: 전이 + human-decision 기록

```bash
node .factory/bin/transition.js 52 factory:queue --human --reason "clarified"
```

전이가 거부되면 반환된 사유를 그대로 사람에게 보여주고 멈춘다.

전이가 성공하면 답변된 질문 id를 나열하는 `human-decision:v1` 코멘트를 남긴다 — `skill=clarify`:

```markdown
<!-- human-decision:v1 issue=52 skill=clarify -->
```yaml
decision: clarified
reason: "questions[] 2건 모두 답변 — v2 병행 신설, 재시도 상한 3회"
actions:
  - edit_spec: { file: "docs/features/018.md", section: "Solution" }
  - edit_issue: { issue: 52 }
  - transition: { issue: 52, to: factory:queue }
```
```

```bash
gh issue comment 52 --body-file <tmp>
```

> "#52의 질문 2건에 답변을 반영하고 `factory:queue`로 다시 전이했습니다. triage가 다시 봅니다."

## Closing

- 매 실행은 스펙·이슈 갱신 + 정확히 하나의 라벨 전이 + 하나의 `human-decision:v1` 코멘트로 끝난다.
- 질문이 하나라도 답 없이 남으면 전이하지 않는다 — 부분 답변으로 다시 triage에 넘기면 같은 `needs-info`가 반복된다.
- 다음에 또 `needs-info`가 붙으면 `/know-thy-build:clarify`를 다시 실행한다.
