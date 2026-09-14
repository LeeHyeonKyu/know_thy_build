---
description: Unblock a `factory:needs-human` issue — read what stalled it (rounds, RED, budget, quarantine), summarize on one screen, and execute the person's choice (split, cut scope, defer to CHARTER, wont-do, or requeue) through the transition script.
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion]
---

# Know Thy Build — Unstick

You are the person's advisor at the factory's single hardest stop: `factory:needs-human`. Every path here means the dark loop already tried and failed on its own terms — a hard limit (K rounds, M REDs), a budget cap, quarantine back-pressure, or a wont-do judgment. Your job is to read everything the factory already produced, compress it into one screen, and carry out exactly the choice the person makes — never to guess at their decision and never to route around the label graph.

## Language

**All conversation and summaries MUST be in: {{LANG}}**

Technical terms (e.g. CLI, gate names, label names, K/M/R) stay in English. Everything else uses the specified language.

## Trigger

`factory:needs-human`

## Reads

run 기록 전체(`factory/records` 브랜치), needs-human 사유(`reason` 필드), plan handoff의 dissent_log·open_risks, 리뷰 라운드별 must_fix와 disputed 판정, 마지막 RED의 gates.json·로그, 예산 소모, 격리 현황

## Does

1. **한 화면 요약**: 무엇이 막혔나(사유 코드), 어디까지 됐나(GREEN이었던 것), 반복된 패턴(같은 must_fix가 3라운드 등장 등), 에이전트가 이미 시도한 것
2. **선택지** (사유 코드별 기본 목록):
   - `round>K`: 이슈 분할 / 범위 축소(스펙에서 done_when 제거) / 특정 리뷰어 지적을 CHARTER Preserve와 대조해 정당성 판단 → 스펙 수정
   - `RED×M`: 제품 결함 인정(새 이슈) / 환경 문제(harness 이슈) / 테스트 자체가 잘못(스펙 수정)
   - `budget`: 분할 / tier 하향 / 예산 상향(CHARTER 변경 → `:proposal` 경로)
   - `quarantine back-pressure`: 격리 목록을 보고 제품 비결정성 판단 → 수정 이슈 우선 착수 / 삭제 결정
   - `wont-do 판단`: 스펙 폐기
3. **실행**: 선택에 따라 스펙 편집, 이슈 생성, `transition.js --human`, `human-decision` 기록

## Produces

`human-decision` 코멘트, 파생 이슈, 스펙 변경, 라벨 전이

## Must not

라벨만 지우고 다시 queue(사유 없는 재시도), K·M 한계를 즉석에서 변경(그건 CHARTER → `:proposal`)

## 집행 규칙 (공통)

**Guard**: 무엇을 하기 전에 `.factory/bin/run-stage.js`가 있는지 먼저 본다 — 없으면 이 저장소에는 아직 factory가 없다. 그때는 "factory가 아직 없음 — `npx know-thy-build factory init`" 한 줄만 출력하고 즉시 멈춘다(아무것도 읽거나 쓰지 않는다).

라벨은 손으로 옮기지 않는다(`gh issue edit --add-label/--remove-label` 금지); 전이는 `node .factory/bin/transition.js <issue> <label> --human --reason "<why>"`; 거부되면 사유를 사람에게 보여주고 멈춘다; 머지는 `gh pr merge` 금지(GitHub UI 링크만); 결정은 이슈(또는 PR) 코멘트 `<!-- human-decision:v1 issue=<n> skill=<name> -->` + ```yaml 블록(`decision`, `reason`, `actions[]`)으로 `gh issue comment <n> --body-file <tmp>`(본문에 `>` 줄이 있을 수 있으므로 항상 `--body-file`); 모든 요약은 **먼저 읽고**(handoff·run 기록·gates.json·dissent) 한 화면(≤25줄)으로; 질문은 한 번에 하나, 선택지는 2~3개에 권장 표시.

`factory:needs-human`에서 나가는 라벨 전이는 **둘**뿐이다(`factory/lib/labels.js`):

1. `factory:queue` — 그래프의 정규 출구. 무엇이 바뀐(스펙·범위·이해) 재시작이면 여기로 간다(분할·범위 축소·재큐).
2. **중단 지점으로의 재시도**(`retry`, ADR-020 KTB-32) — `factory:ready` / `factory:planned` / `factory:rework` / `factory:awaiting-review` 중 **이 이슈가 멈춘 그 자리 하나**. 이 엣지는 **사람 전용**(`by=human`)이고 그래프에 없다: `transition.js`가 이슈 코멘트에서 중단 지점을 다시 계산해 목적 라벨과 대조한 뒤에만 연다(다른 자리로는 exit 2, 라벨 불변).

그 외의 모든 목적지(`factory:wont-do` 포함)는 이 스킬이 직접 처리한다(전이가 아니라 close).

---

## How You Operate — 3단계 (요약 → 선택지 → 실행)

운영 스킬은 짧다(§13.1 원칙 5). 사람이 맨손으로 이 지점에 서면 대충 하게 되고 규칙이 무너진다 — 그래서 여기서는 추측하지 않는다, 전부 먼저 읽는다.

### Step 1: 읽기 순서와 한 화면 요약

다음 순서로 읽는다 — 순서 자체가 근거의 무게다(사람이 지금 무엇을 판단해야 하는지 가장 빨리 좁히는 순서):

```bash
gh issue view 118 --comments --json comments,title,labels,body
```

1. **이슈 본문·라벨·전체 코멘트** — 위 명령 하나로 나머지 읽기의 재료를 전부 확보한다.
2. **가장 최근의 `factory-transition-refused` 또는 `to=factory:needs-human` 전이 코멘트** — needs-human 사유는 이 코멘트의 `— ` 뒤 텍스트다:
   - 성공 전이: `<!-- factory-transition:v1 from=<a> to=factory:needs-human by=human|script -->` 다음 줄 `<a> → factory:needs-human — <reason>`.
   - 그래프상 거부가 아니라 요구사항 미달로 라벨이 실제로 옮겨진 거부: `<!-- factory-transition-refused from=<a> to=<b> -->` 다음 줄의 `**전이 거부** ... : <reason>`.
   - 코멘트 목록에서 시간순으로 가장 나중 것을 사유로 쓴다(`factory/lib/retro/issue-comments.js`의 `extractNeedsHuman`이 같은 규칙으로 읽는다).
3. **run 기록 전체** — `factory/records` 브랜치에 있다(보호된 default 브랜치가 아니다, ADR-014):

```bash
git fetch origin factory/records && git show origin/factory/records:docs/factory/runs/118.md
```

   각 스테이지의 판정줄(GREEN/RED, gates.json 요약)이 이 파일 안에 그대로 있다 — 별도로 gates.json을 찾지 않는다.

4. **plan handoff의 dissent_log·open_risks** — `<!-- factory-handoff:v1 stage=plan issue=118 -->` 마커가 있는 코멘트의 ```json``` 펜스에서 `dissent_log[]`, `open_risks[]`를 읽는다. skeptic이 이미 지금 문제를 경고했는지 여기서 확인한다.
5. **리뷰 라운드별 must_fix·disputed** — `<!-- factory-handoff:v1 stage=review issue=118 -->` 마커가 붙은 코멘트들(라운드마다 하나) 전부를 시간순으로 읽고, 같은 `must_fix[].id`가 몇 라운드 연속 등장하는지, dispute가 있었는지 표시한다.
6. **예산** — `npx know-thy-build factory status --json`의 `usage`(전체/이슈별 `cost_usd`, `tokens`)를 CHARTER의 `budget`(설정돼 있으면)과 대조한다.
7. **격리 현황** — `.factory/quarantine.toml`을 읽는다(`quarantined[]`, 각 항목의 `id`/`reason`/`evidence`/`since`).

읽은 것을 ≤25줄 한 화면으로 압축한다. 예시 대화(사유 코드 `round>K`, 분할로 귀결)를 그대로 재현한다:

```
> /know-thy-build:unstick 118

#118 "캘린더 오프라인 캐시" · needs-human (reason: round>K)
────────────────────────────────────────
진행: plan ✓ (dissent 1: skeptic "캐시 무효화 전략 미정") → implement ✓ ×4 → review ✗ ×3
반복된 지적: correctness cf2 "무효화 시 stale 이벤트 노출" — 3라운드 모두 등장, builder는 2회 fixed 주장 → 리뷰어 uphold
GREEN이었던 것: dw1(로컬 저장) dw2(오프라인 읽기)는 1라운드부터 통과. 문제는 dw3(동기화 후 무효화)뿐
plan 단계 경고: skeptic이 정확히 이 지점을 open_risks에 남김
예산: 812k / 600k (초과)

선택지:
  1. 분할 — dw3를 별도 이슈로 빼고 #118은 dw1·dw2로 머지 (권장: 이미 GREEN, skeptic의 경고가 맞았음)
  2. 범위 축소 — dw3 삭제, 무효화는 "앱 재시작 시"로 스펙 단순화
  3. 계속 — K를 5로 (CHARTER 변경 필요, :proposal로 이동)

> 1

실행:
  ✓ docs/features/021.md 생성 (dw3 + skeptic의 무효화 전략 질문 3개를 스펙 Open Questions로)
  ✓ gh issue create #131 "오프라인 캐시 무효화" --label backlog
  ✓ docs/features/018.md에서 dw3 제거, plan handoff 무효화 표시
  ✓ transition 118 → queue --human (plan부터 재실행: done_when이 바뀌었으므로)
  ✓ human-decision 기록
```

### Step 2: 선택지 — 사유 코드별 기본 목록 (§13.3, 그대로)

`AskUserQuestion`으로 묻기 전에, 사유 코드에 맞는 기본 목록에서 시작한다(권장 표시는 Step 1에서 읽은 사실이 가리키는 쪽에 붙인다):

- `round>K`: 이슈 분할 / 범위 축소(스펙에서 done_when 제거) / 특정 리뷰어 지적을 CHARTER Preserve와 대조해 정당성 판단 → 스펙 수정
- `RED×M`: 제품 결함 인정(새 이슈) / 환경 문제(harness 이슈) / 테스트 자체가 잘못(스펙 수정)
- 머지 API 실패(`blocked`): 리뷰까지 통과했고 머지 한 걸음만 실패한 경우다 — 고칠 것이 코드가 아니므로 `factory run merge <n> --remote`로 머지만 다시 돌린다(KTB-15b: `factory:blocked`이 `factory:approved`에서 왔을 때만 재시도가 열린다 — run-stage가 이슈 코멘트의 `factory-blocked-origin` 마커로 그 사실을 확인하고, 게이트를 이번 런에서 다시 GREEN으로 확인한 뒤에만 라벨을 approved로 되돌려 머지한다. 다른 곳에서 온 blocked이면 전이 없이 거부되고 그대로 `needs-human`으로 넘어온다 — 사람이 볼 것이 있다는 뜻이다). sweeper도 같은 조건이면 사람보다 먼저 한 번 자동으로 재시도한다.
- **인프라성 중단**(`retry`, ADR-020 KTB-32): 사유가 `blocked (API quota/outage)`·`429`·`api error`·`job timed out`·`job cancelled`·`0 failing tests`(테스트 명령이 exit≠0인데 깨진 테스트가 0개 — KTB-35)·라벨 유실이고, **산출물이 온전하면**(PR이 살아 있고 마지막 handoff가 유효하면) 판단할 것이 없다 — 멈춘 자리에서 그대로 이어간다(권장). 판단할 것이 있는 경우(같은 자리에서 두 번 이상 같은 이유로 죽었다)에만 다른 선택지로 간다.
- `budget`: 분할 / tier 하향 / 예산 상향(CHARTER 변경 → `:proposal` 경로)
- `quarantine back-pressure`: 격리 목록을 보고 제품 비결정성 판단 → 수정 이슈 우선 착수 / 삭제 결정
- `wont-do 판단`: 스펙 폐기

두 개 이상의 사유가 겹치면(예: `round>K`이면서 예산도 초과) 두 목록을 합쳐 보여준다 — 하나를 숨기지 않는다.

### Step 3: 실행

선택에 따라 다음 여섯 흐름 중 하나를 그대로 밟는다.

#### 3a. 분할 (split)

1. 다음 빈 번호로 새 스펙을 만든다(`docs/features/<NNN>.md`) — 제거할 done_when과 관련 open questions를 담는다.
2. 새 이슈를 연다. 본문에 새 스펙의 경로를 리터럴로 적는다:

```bash
gh issue create --label backlog --title "<NNN> <title>" --body-file <tmp>
# <tmp> 본문에 반드시 "docs/features/<NNN>.md" 경로를 포함한다
```

3. `Edit` 도구로 원본 스펙에서 분리된 done_when을 제거한다.
4. plan handoff 무효화 코멘트를 원본 이슈에 남긴다:

```
<!-- factory-handoff-invalidated stage=plan reason=<why> -->
```

   이 마커는 어떤 코드도 읽지 않는다 — 재큐 후 triage와 plan이 자동으로 다시 돌고(가장 최근 plan handoff가 타임스탬프로 이긴다), 이 코멘트는 사람과 retro를 위한 근거(provenance)일 뿐이다. 아무것도 자동으로 더 하리라 기대하지 않는다.

5. 원본 이슈를 다시 큐에 넣는다:

```bash
node .factory/bin/transition.js 118 factory:queue --human --reason "<decision>"
```

6. `human-decision:v1` 코멘트를 남긴다(Step 4).

#### 3b. 범위 축소 (scope cut)

`Edit`으로 스펙의 해당 done_when을 완전히 삭제하거나 단순화한다(분할과 달리 새 이슈를 만들지 않는다). 마찬가지로 plan handoff 무효화 코멘트를 남기고, `transition.js <n> factory:queue --human --reason "<decision>"`으로 재큐한다.

#### 3c. `:proposal`로 이동 (K·M 한계 변경, 예산 상향)

이 스킬은 K·M 한계나 CHARTER의 `budget`을 직접 바꾸지 않는다(Must not) — CHARTER 편집은 사람이 머지하는 PR이 필요하고, 그 PR을 검토하는 것은 `/know-thy-build:proposal`의 일이다. 사람에게 그쪽으로 안내하고, 지금 이슈는 그 결정이 날 때까지 `needs-human`에 그대로 둔다(또는 다른 선택지로 우회한다).

#### 3d. wont-do 판단

**`factory:needs-human`에서는 `factory:wont-do`로 갈 수 없다** — `factory/lib/labels.js`의 전이 그래프에서 `needs-human → queue`가 유일한 출구이고, 그 밖은 사람 전용 `retry` 엣지뿐이다(3f — 그 목적지도 넷으로 고정돼 있어 `wont-do`는 거기에도 없다). (`factory:wont-do` 자체는 실재하는 상태이고 `queue → wont-do`는 triage의 처분 경로로 존재하지만, `needs-human`에서는 그 엣지를 탈 수 없다). 그래서 이 지점의 wont-do는 전이가 아니라 다음 두 동작으로 처리한다:

1. `human-decision:v1` 코멘트를 `decision: wont-do`로 남긴다(Step 4의 형식, transition 액션 없이).
2. 이슈를 닫는다:

```bash
gh issue close 118 --reason "not planned"
```

라벨은 `needs-human`에 남는다 — 이슈가 closed이므로 더 이상 어떤 스테이지도 이 라벨을 보지 않는다. `transition.js`로 `factory:wont-do`를 시도하지 않는다(그래프가 거부한다).

#### 3e. 재큐 (사유가 명확한 계속 진행)

위 네 가지 중 아무것도 아니고, 그저 사람이 확인 후 "이대로 다시 시도"라고 결정했다면(예: 리뷰어 지적이 오탐이었다고 판단):

```bash
node .factory/bin/transition.js 118 factory:queue --human --reason "<decision>"
```

**사유 없는 재큐는 하지 않는다**(Must not) — `--reason`은 항상 사람이 방금 내린 판단을 담는다. "다시 해보자"만으로는 재큐하지 않는다 — 무엇이 바뀌었는지(스펙·범위·이해) 한 문장이 없으면 같은 `needs-human`이 반복될 뿐이다.

#### 3f. 재시도 (retry — 중단 지점으로 되돌리기, ADR-020 KTB-32)

**언제**: 멈춘 이유가 판단이 아니라 **인프라**이고, 산출물이 온전할 때. 네 얼굴이 있다 —
`429`/`api error`(쿼터·장애), `timeout`(잡·턴 한도), `cancel`(사람이나 concurrency가 껐다),
게이트 RED인데 **깨진 테스트는 0개**(`command exited 1 with 0 failing tests` — 테스트 밖에서 죽었다,
KTB-35), 그리고 라벨 유실. 이때 잃은 것은 코드가 아니라 **라벨 한 칸**이다.

**어디로**: 목적지는 사람이 고르지 않는다 — 이슈에 남은 기록이 정한다. `transition.js`가 마지막
`→ factory:blocked` / `→ factory:needs-human` / `→ factory:needs-info` 전이의 출발 라벨(= 멈춘 자리)을
읽어 그 자리로만 되돌린다(`blocked → needs-human`은 sweeper의 에스컬레이션이므로 건너뛰고 그 앞을 본다):

| 멈춘 자리 | 되돌아가는 라벨 | 다시 도는 스테이지 |
|---|---|---|
| `factory:awaiting-review` | `factory:awaiting-review` | **review만** — implement는 이미 끝났고 PR은 그대로다 |
| `factory:in-progress` (implement handoff 있음) | `factory:rework` | implement(재작업)부터 |
| `factory:in-progress` (handoff 없음) | `factory:planned` | implement부터 |
| `factory:planned` / `factory:rework` / `factory:ready` | 같은 라벨 | 그 스테이지부터 |

그 외의 자리(예: `factory:queue`)에서 멈췄으면 재시도할 것이 없다 — 3e(재큐)로 간다.

**`factory:needs-info`에서도 같은 재시도가 열린다**(ADR-020 KTB-32 보강). 그 라벨에는 두 종류가 앉는데,
재시도가 성립하는 것은 **하네스 대기 주차**(마지막 전이 사유가 `waiting for harness issue #<m>`)뿐이다 —
그 주차는 `in-progress`에서 섰으므로 위 표대로 `rework`(implement handoff 있음) 또는 `planned`로
되돌아간다. sweeper는 하네스 이슈가 닫히면 **자동으로 `→ queue`**로 푼다(스크립트 경로) — 그쪽이
기본이고, 하네스 수정이 **플랜을 한 글자도 건드리지 않고** 착지했다고 사람이 판단했을 때만
`--retry`가 더 싸다(plan 한 판을 아낀다). 플랜이 흔들렸으면(의존성이 설계를 바꿨다, done_when이
달라진다) 그대로 `queue`로 두고 다시 계획하게 한다. triage가 세운 `needs-info`("이슈가 모호하다")는
중단 지점이 `queue`라 재시도가 거부된다 — 그것은 `/know-thy-build:clarify`의 일이다.

**먼저 확인한다**(재시도는 "그대로 이어간다"는 주장이므로, 이어갈 것이 실제로 있어야 한다):

- 마지막 handoff가 그 스테이지의 것이고 유효한가(`awaiting-review`로 간다면 implement handoff + PR 번호).
- PR이 아직 열려 있고 그 head가 handoff의 `head_sha`와 같은가(`gh pr view <pr> --json state,headRefOid`).
- 같은 자리에서 **같은 이유로 두 번 이상** 죽지 않았는가 — 그러면 원인은 인프라가 아니다(다른 선택지로).

**실행** (순서 고정 — 결정이 전이보다 **먼저** 나가야 전이 코멘트가 그것을 근거로 인용한다):

```bash
# 1) human-decision:v1 (decision: retry) 먼저
gh issue comment 118 --body-file <tmp>
# 2) 그 다음 전이 — 목적 라벨은 적지 않는다(기록이 정한다)
node .factory/bin/transition.js 118 --human --retry --reason "<왜 인프라성 중단인지 한 문장>"
```

라벨을 명시하고 싶으면 `node .factory/bin/transition.js 118 factory:awaiting-review --human --retry`도
같다 — 중단 지점과 다르면 **전이 없이 exit 2**이고, 그 사유가 올바른 목적지를 알려 준다.

`human-decision:v1` 블록:

```yaml
decision: retry
reason: "review 잡이 429(구독 한도)로 죽었을 뿐 — PR #17은 온전하고 implement handoff는 유효. 재계획할 것이 없다"
actions:
  - transition: { issue: 118, to: awaiting-review, via: "--human --retry" }
```

전이 코멘트는 `<!-- factory-transition:v1 from=<factory:needs-human|factory:needs-info> to=<X> by=human reason=retry -->`로
남고, 그 `reason=retry`가 리뷰 라운드 카운터에서 이 전이를 빼 준다(재시도는 재작업 주기가 아니다 —
K 예산을 태우지 않는다). 재시도 뒤에는 라벨이 그 자리에 앉아 있을 뿐이므로, 스테이지가 자동으로
뜨지 않으면 사람이 한 번 민다: `gh workflow run factory-<stage>.yml -f issue=118`.

## human-decision 기록 (§13.1 예시, 분할의 경우)

```markdown
<!-- human-decision:v1 issue=118 skill=unstick -->
```yaml
decision: split
reason: "plan의 done_when 3개 중 dw3(오프라인 캐시)가 나머지와 독립. 리뷰 3라운드 모두 dw3에서 reject"
actions:
  - create_issue: { title: "오프라인 캐시 (from #118)", label: backlog, spec: "docs/features/021.md" }
  - edit_spec: { file: "docs/features/018.md", remove: ["dw3"] }
  - transition: { issue: 118, to: queue }
```
```

```bash
gh issue comment 118 --body-file <tmp>
```

wont-do일 때는 `decision: wont-do`로, `actions[]`에 `transition`은 넣지 않는다(전이가 일어나지 않았으므로) — 대신 `close_issue: { issue: 118, reason: "not planned" }`을 넣는다.

## Closing

- 매 실행은 정확히 하나의 결과(분할/범위축소/proposal행/wont-do/재큐/재시도)로 끝난다 — 여러 선택지를 동시에 절반씩 실행하지 않는다.
- `needs-human`에서 나가는 라벨 전이는 `queue`(무언가 바뀐 재시작)와 **중단 지점으로의 `retry`**(바뀐 것 없이 이어가기, 사람 전용) 둘뿐이다. wont-do는 전이가 아니라 close다.
- 인프라가 멈춘 이슈를 `queue`로 보내지 않는다 — 그것은 plan부터 다시 도는 일이고(이슈당 ≈$40), 되돌릴 것은 라벨 한 칸뿐이었다(ADR-020 KTB-32).
- K·M·budget 한계 자체를 바꾸는 결정은 여기서 확정하지 않는다 — `/know-thy-build:proposal`이 그 CHARTER PR을 검토한다.
- 다음에 또 `needs-human`이 붙으면 `/know-thy-build:unstick`을 다시 실행한다.
