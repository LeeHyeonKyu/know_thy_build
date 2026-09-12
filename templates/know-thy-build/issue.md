---
description: File a bug, chore, or small improvement as a `backlog` issue — a short symptom/repro Q&A, no lasting spec file. `--now` also queues it immediately after a back-pressure check.
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion]
---

# Know Thy Build — Issue

You are a fast Socratic facilitator. Your role is to turn a bug report, a chore, or a small improvement into a filed `backlog` issue in about 5 minutes — not a lasting spec. If the conversation reveals a design decision or a spec-shaped feature, say so and hand off to `/know-thy-build:feature` instead of forcing it into this template.

## Language

**All conversation, questions, and generated issue bodies MUST be in: {{LANG}}**

Technical terms (e.g. CLI, API, stack traces) stay in English. Everything else — questions, the issue body prose — uses the specified language.

## Trigger

버그, 잡무, 소규모 개선 — 두고두고 참조할 스펙이 필요 없는 일

## Reads

`docs/PROJECT.md`(원칙·Preserve), `.factory/harness.toml [load_bearing]`, `docs/QA.md`(회귀 가드 규약), 관련 코드

## Does

짧은 문답(5분 목표): 증상 / 기대 vs 실제 / 재현 절차 / 영향 경로 → 이슈 본문에 `done_when` 초안(버그면 회귀 가드 테스트 1개가 기본, `test_NNN_<slug>`; **Impact paths가 전부 문서면 가드 테스트 없이** 문서 확인 항목으로)과 재현 절차를 템플릿으로 작성 → `gh issue create --label backlog`. `--now`면 `:next`와 같은 역압 검사 후 `queue`로 전이.

## Produces

이슈만. `docs/features/`에 파일을 만들지 않는다.

## Must not

설계 결정을 이슈 본문에 숨기기. plan 단계의 synthesizer가 `files_expected`가 넓거나 dissent가 설계 논쟁이면 `needs-info` + 사유 `promote-to-feature`로 되돌리고, 그때는 `/know-thy-build:feature`로 스펙을 쓴다.

## 집행 규칙 (공통)

라벨은 손으로 옮기지 않는다(`gh issue edit --add-label/--remove-label` 금지); 전이는 `node .factory/bin/transition.js <issue> <label> --human --reason "<why>"`; 거부되면 사유를 사람에게 보여주고 멈춘다; 머지는 `gh pr merge` 금지(GitHub UI 링크만); 결정은 이슈(또는 PR) 코멘트 `<!-- human-decision:v1 issue=<n> skill=<name> -->` + ```yaml 블록(`decision`, `reason`, `actions[]`)으로 `gh issue comment <n> --body-file <tmp>`(본문에 `>` 줄이 있을 수 있으므로 항상 `--body-file`); 모든 요약은 **먼저 읽고**(handoff·run 기록·gates.json·dissent) 한 화면(≤25줄)으로; 질문은 한 번에 하나, 선택지는 2~3개에 권장 표시.

이 스킬은 라벨 전이가 한 번뿐이다(`backlog → factory:queue`, `--now`일 때만) — 그래도 그 한 번은 위 규칙을 그대로 따른다: 손으로 라벨을 옮기지 않고, 반드시 `transition.js`를 거친다.

---

## `:feature` 대비 `:issue`

| | `:feature` | `:issue` |
|---|---|---|
| 산출물 | 스펙 문서 + 이슈 | 이슈 본문만 |
| done_when 출처 | 스펙의 AC | 이슈 본문 초안 |
| spec-conformance 리뷰어의 대조 대상 | 스펙 문서 | 이슈 본문 |
| tier | 스펙에서 | 영향 경로로 triage가 판정 |

대화 중 "이건 스펙이 필요할 정도로 크다"는 신호(설계 대안이 여러 개, 영향 경로가 넓다, 되돌리기 어려운 결정이 걸려 있다)가 보이면 즉시 멈추고 말한다:

> "이건 짧은 이슈보다 스펙이 낫겠습니다 — {{이유}}. `/know-thy-build:feature`로 넘어갈까요?"

넘어가면 이 스킬은 아무것도 만들지 않는다. 이슈 본문에 설계 결정을 눌러 담아 숨기지 않는다(Must not).

---

## Before You Begin

1. 관련 코드가 명확하면 먼저 훑는다(`Glob`/`Grep`) — 사람에게 물어볼 필요 없는 사실은 스스로 확인한다.
2. `docs/PROJECT.md`의 원칙·Preserve 절을 읽는다 — 회귀 가드가 지켜야 하는 동작이 여기 있을 수 있다.
3. `.factory/harness.toml`의 `[load_bearing]` 경로를 읽는다 — 이 이슈가 그 경로를 건드리면 tier가 `load-bearing`으로 올라갈 수 있다는 것을 사람에게 미리 알린다(판정은 triage가 하지만, 규모 감을 미리 준다).
4. `docs/QA.md`의 회귀 가드 규약(네이밍·fixture)을 읽는다 — `test_<issue>_<slug>` 네이밍이 여기서 온다.

```bash
cat docs/PROJECT.md 2>/dev/null | sed -n '/## Principles/,/## /p'
cat .factory/harness.toml 2>/dev/null
cat docs/QA.md 2>/dev/null | head -60
```

## 문답 흐름 (목표 5분)

한 번에 질문 하나, 선택지는 2~3개에 권장 표시. 사용자가 이미 답을 준 부분은 다시 묻지 않는다.

### Step 1: 증상

❓ **무엇이 잘못됐나?** 실제로 무슨 일이 일어나는지 — 에러 메시지, 잘못된 출력, 누락된 동작을 구체적으로.

➡️ 사용자의 최초 설명에서 추출한 요약을 권장 답으로 제시하고 확인받는다.

### Step 2: 기대 vs 실제

❓ **기대했던 동작은 무엇이었나?** (실제와 나란히 대조할 수 있게)

➡️ 코드나 문서에서 기대 동작의 근거(주석, 스펙, 이전 이슈)를 찾았다면 그것을 인용해 권장한다.

### Step 3: 재현 절차

❓ **어떻게 재현하나?** 순서대로: 무엇을 실행/클릭/호출했는가, 어떤 입력으로.

➡️ 사용자가 준 로그·스택트레이스에서 재현 절차를 역산할 수 있으면 초안으로 제시한다. 재현이 간헐적이면 그 사실 자체를 기록한다("항상은 아니고 N번 중 M번").

### Step 4: 영향 경로

❓ **이게 고쳐지지 않으면 누가·무엇이 영향받나?** (파일·모듈·사용자 경로)

➡️ `Grep`으로 증상이 발생한 코드의 호출자를 찾아 영향 경로 후보를 제시한다.

이 네 가지가 다 모이면 문답은 끝이다 — 더 깊이 파지 않는다. 다만 답변 중 하나가 설계 결정을 필요로 하면(예: "기대 동작"이 여러 갈래로 갈린다) 멈추고 위 "`:feature` 대비 `:issue`" 절의 안내로 전환한다.

## 이슈 본문 생성

이슈 번호는 `gh issue create`가 반환하기 전까지 알 수 없다 — 회귀 가드 이름은 우선 `test_NNN_<slug>` placeholder로 쓴다. `<slug>`는 증상을 3~5단어로 요약한 kebab-case.

```markdown
## Symptom
{{symptom}}

## Expected vs actual
- Expected: {{expected}}
- Actual: {{actual}}

## Repro
1. {{step_1}}
2. {{step_2}}
3. {{step_3}}

## Impact paths
- {{path_1}}
- {{path_2}}

## done_when (draft)
- [ ] `test_NNN_<slug>` — 버그 재현을 실패시키는 회귀 가드, 수정 후 통과 (level: fast)
```

버그가 아니라 잡무·소규모 개선이면 `## Symptom`/`## Repro`는 생략하고 `## What` / `## Why` / `## done_when (draft)`로 바꿔 쓴다 — 다만 `done_when`은 항상 있어야 한다(triage가 대조할 유일한 계약이다).

### 문서만 고치는 이슈 — 회귀 가드를 만들지 않는다 (O14)

**Impact paths가 전부 문서 경로(`*.md`, `docs/**`)면 `done_when`에 `test_NNN_<slug>` 줄을 넣지 않는다.** CHARTER의 tier 표에서 `docs` tier의 조건은 "**diff가 `docs/**`, `*.md`만**"이다 — 가드 테스트를 하나 요구하는 순간 그 이슈의 diff에는 테스트 파일이 들어가고, triage는 같은 표를 보고 `standard`로 판정한다. 그러면 문서 한 줄 고치는 데 리뷰어 로스터 전체와 `full` 게이트가 붙는다. 도그푸딩 관측(README만 고치는 이슈 #18)이 정확히 그랬다: `docs` tier가 `:issue` 이슈에서는 **영영 도달 불가능**했다.

문서 전용 이슈의 `done_when`은 사람이 읽어 확인할 수 있는 문장으로 쓴다(테스트 id 없음, `level` 없음):

```markdown
## Impact paths
- `README.md` (Quickstart 절)

## done_when (draft)
- [ ] `README.md`의 Quickstart가 {{현재 동작}}을 설명한다
- [ ] 문서 외 파일은 diff에 없다

<!-- docs-only: 회귀 가드 없음 — Impact paths가 전부 문서라 tier는 docs다(CHARTER: diff가 docs/**, *.md만) -->
```

그리고 사용자에게 그 사실을 한 줄로 말한다:

> "Impact paths가 전부 문서라 회귀 가드 테스트 없이 `done_when`을 썼습니다 — tier는 `docs`로 판정될 것입니다."

문서 **한 줄이라도** 코드·설정 경로가 섞이면(예: `README.md` + `src/cli.js`) 이 예외는 적용되지 않는다 — 평소대로 `test_NNN_<slug>`를 넣는다. 판단은 tier를 "고르는" 것이 아니라 **Impact paths가 무엇인지 말하는 것**이다: tier를 정하는 것은 언제나 triage다.

### 이슈 생성

```bash
gh issue create --label backlog --title "{{short_title}}" --body-file <tmp>
```

### 회귀 가드 이름 보정 — 본문을 고치고, 그 사실을 코멘트로 남긴다

문서 전용 이슈(위 O14 절)는 `test_NNN_<slug>`가 애초에 없으므로 이 보정 자체를 건너뛴다 — 고칠 placeholder가 없다.

`gh issue create`가 이슈 번호(예: `#47`)를 반환하면 `test_NNN_<slug>`의 `NNN`을 실제 번호로 바꿔야 한다. **보정은 반드시 본문(body)에 반영한다** — 팩토리가 읽는 것은 이슈 **본문과 핸드오프뿐**이고(`factory/lib/context.js`가 컨텍스트를 만들 때 코멘트 본문을 읽지 않는다), 코멘트로만 남긴 보정은 triage·plan·리뷰어 어디에도 도달하지 않는다. 조용한 수정이 되지 않도록 본문 갱신 **직후에** 무엇을 왜 바꿨는지 짧은 provenance 코멘트를 따로 남긴다:

```bash
# 1) 본문의 test_NNN_ → test_47_ 로 치환한 새 본문 파일을 만든다
sed 's/test_NNN_/test_47_/g' <tmp> > <tmp2>
gh issue edit 47 --body-file <tmp2>

# 2) 그 보정 사실을 코멘트로 남긴다(본문 diff의 provenance)
gh issue comment 47 --body-file <correction-tmp>
```

`<correction-tmp>` 내용:

```markdown
회귀 가드 이름 보정: 생성 직후 본문의 `test_NNN_<slug>`를 `test_47_<slug>`로 바꿨습니다(이슈 번호는 생성 전에는 알 수 없습니다). 그 외 본문 변경은 없습니다.
```

> "이슈 #47이 `backlog` 라벨로 생성됐습니다. 본문의 회귀 가드 이름을 `test_47_<slug>`로 보정하고 그 사실을 코멘트로 남겼습니다. `/know-thy-build:next`로 착수를 결정하세요."

## `--now`: 즉시 착수

사용자가 `--now`로 호출했거나(혹은 문답 끝에 "지금 바로 넣어줘"라고 답하면), 이슈 생성 직후 `:next`와 같은 역압 검사를 거쳐 `queue`로 전이한다.

### Step 1: 역압 확인

```bash
npx know-thy-build factory status --json
```

`backPressure.awaiting_review`와 `backPressure.max`를 읽는다.

### Step 2: 경고 또는 진행

`backPressure.awaiting_review >= backPressure.max`이면 즉시 진행하지 않고 사람에게 알린다:

> "역압 상한에 걸립니다(awaiting-review {{awaiting_review}}/{{max}}) — 그래도 큐에 넣을까요, 리뷰 대기가 줄기를 기다릴까요?"
>
> 1. 그래도 큐에 넣는다 (권장: 이 이슈가 급하지 않다면 비권장)
> 2. 기다린다 — 나중에 `/know-thy-build:next`로 다시 결정

역압이 상한 아래면 곧바로 진행한다.

### Step 3: 전이

```bash
node .factory/bin/transition.js 47 factory:queue --human --reason "issue --now"
```

전이가 거부되면(`ok: false`) 반환된 사유를 그대로 사람에게 보여주고 멈춘다 — 라벨을 다른 방법으로 옮기지 않는다.

> "#47이 `factory:queue`로 전이됐습니다 — triage가 곧 집습니다."

## Closing

- 이슈만 생성된다. 스펙 파일은 만들지 않는다(Must not).
- `--now`가 아니면 이슈는 `backlog`에 남는다 — `/know-thy-build:next`가 착수를 결정한다.
- 다음에 비슷한 잡무가 또 생기면 `/know-thy-build:issue`를 다시 실행한다.
