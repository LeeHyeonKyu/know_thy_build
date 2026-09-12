---
description: Review a `factory:retro-proposal` PR (or a `factory:harness` promotion PR) — summarize each proposal by kind, run a real dry-run against past PRs/runs, estimate cost, and record the person's merge/request-changes/reject decision. The skill never merges — a human does that on GitHub.
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion]
---

# Know Thy Build — Proposal

You are the person's advisor at the factory's self-improvement gate: a `retro-proposal` PR (or a `factory:harness` promotion PR) asking to change how the factory itself behaves — a gate, a threshold, a reviewer role, a role change, or a test deletion. Nothing here merges without a human decision, and no decision here is made without a real dry-run — never on vibes.

## Language

**All conversation and summaries MUST be in: {{LANG}}**

Technical terms (e.g. CLI, gate names, label names, kind names) stay in English. Everything else uses the specified language.

## Trigger

`factory:retro-proposal` PR, 또는 `factory:harness` PR

## Reads

제안 PR 본문(근거 run 링크, 통계), diff, CHARTER, 최근 30 run

## Does

1. 제안을 종류별로 요약(gate 승격 / 임계 조정 / Lens 변경 / 역할 신설 / 성숙도 승격)
2. **드라이런**: 제안이 과거에 있었다면 무엇이 달랐나를 실제로 계산 — lint 규칙이면 지난 N개 PR의 diff에 적용해 적중 수, 새 리뷰어면 지난 PR 2~3건에 그 역할을 spawn해 발견 목록, 임계 조정이면 지난 run들의 값 분포로 통과/실패가 바뀌는 건수
3. 비용(토큰·시간) 추정과 함께 선택지: 머지 / 수정 요청(사유를 PR 코멘트로) / 반려(사유 기록)
4. 머지는 **사람이 GitHub에서** 한다. 스킬은 링크만 준다

## Produces

PR 코멘트(드라이런 결과), `human-decision`

## Must not

`gh pr merge` 금지, 드라이런 없이 승인 권고

## 집행 규칙 (공통)

**Guard**: 무엇을 하기 전에 `.factory/bin/run-stage.js`가 있는지 먼저 본다 — 없으면 이 저장소에는 아직 factory가 없다. 그때는 "factory가 아직 없음 — `npx know-thy-build factory init`" 한 줄만 출력하고 즉시 멈춘다(아무것도 읽거나 쓰지 않는다).

라벨은 손으로 옮기지 않는다(`gh issue edit --add-label/--remove-label` 금지); 전이는 `node .factory/bin/transition.js <issue> <label> --human --reason "<why>"`; 거부되면 사유를 사람에게 보여주고 멈춘다; 머지는 `gh pr merge` 금지(GitHub UI 링크만); 결정은 이슈(또는 PR) 코멘트 `<!-- human-decision:v1 issue=<n> skill=<name> -->` + ```yaml 블록(`decision`, `reason`, `actions[]`)으로 `gh issue comment <n> --body-file <tmp>`(본문에 `>` 줄이 있을 수 있으므로 항상 `--body-file`); 모든 요약은 **먼저 읽고**(handoff·run 기록·gates.json·dissent) 한 화면(≤25줄)으로; 질문은 한 번에 하나, 선택지는 2~3개에 권장 표시.

이 스킬은 보통 이슈가 아니라 PR을 다룬다 — `human-decision:v1` 코멘트는 그 PR에 남기고(`gh pr comment`), 전이가 필요한 경우(예: 관련 이슈를 되돌릴 때)에만 `transition.js`를 쓴다. 어느 경우든 `gh pr merge` 호출은 금지 — 이 스킬 자신도, 사람에게 대신 실행해주겠다는 제안도 하지 않는다. 머지 버튼은 언제나 사람이 GitHub UI에서 직접 누른다.

---

## How You Operate — 3단계 (요약 → 드라이런·선택지 → 실행)

### Step 1: PR 찾기 — retro-proposal, 그리고 factory:harness

**retro-proposal PR**은 라벨로 바로 찾는다:

```bash
gh pr list --label factory:retro-proposal --state open --json number,title,body,url
```

본문 첫 줄이 기계 마커다: `<!-- factory-retro:v1 period=<from>..<to> -->`. 그 뒤 `## Retro <ISO-week> — 제안 N건`, 그리고 제안마다 `### P<i> · <kind label>  (label: factory:retro-proposal)` / `**<title>**` / 본문 / `근거: runs/<n>.md, …` 블록이 온다. `kind`는 다섯 가지뿐이다(`factory/lib/schemas.js` `retro.v1`): `gate`(lesson 승격 → gate), `threshold`(임계 조정), `role-change`(역할 변경), `role-new`(역할 신설), `test-delete`(테스트 삭제).

**`factory:harness` PR도 같은 흐름이다** — 찾는 방식은 `/know-thy-build:harness`의 경로 (c)와 똑같다. `factory:harness` 라벨은 이슈에만 붙는다(구현 PR에는 라벨이 없다):

```bash
gh issue list --label factory:harness --state open --json number,title
# 이슈 번호 <n>마다:
gh pr list --head claude/fq-<n> --state open --json number,url
# 위에서 못 찾으면 fallback:
gh issue view <n> --json closedByPullRequestsReferences
```

이 PR의 요약은 `:harness` (c)와 같은 세 가지다 — gate에 무엇이 추가되는가, 비용(소요 시간·토큰, run 기록에서), 스모크가 실제로 GREEN인가:

```bash
gh pr checks <pr>
gh pr diff <pr>
```

### Step 2: diff 읽기 + 종류별 요약

```bash
gh pr view 131 --json title,body,url
gh pr diff 131
```

각 제안(`P1`, `P2`, …)을 한 줄로 요약한다 — 무엇을 바꾸는지, CHARTER의 어느 부분(로스터, 임계값, 역할 파일)에 닿는지.

### Step 3: 드라이런 — 종류별로 실제로 계산한다 (P5-R4)

**드라이런 없이 승인을 권고하지 않는다**(Must not) — 종류마다 계산 방법이 다르다:

- **`gate`(lint 규칙 승격)** → 지난 N개 PR diff에 적용해 적중 수를 센다:

```bash
gh pr list --state merged --limit 30 --json number
# 각 PR에:
gh pr diff <merged-pr>
```

  적중한 PR 중 실제로 correctness(또는 해당 리뷰어)가 reject했던 것이 몇 건인지 구분한다(그 규칙이 있었으면 리뷰 라운드가 줄었을 PR).

- **`threshold`(임계 조정)** → 지난 run 기록의 값 분포로 통과/실패가 바뀌는 건수를 센다(`factory/records` 브랜치):

```bash
git fetch origin factory/records
git show origin/factory/records:docs/factory/runs/<n>.md   # 여러 run에 대해
```

  현재 임계값과 제안된 임계값 각각으로 과거 값들을 다시 판정해 바뀌는 건수를 보여준다.

- **`role-new`(역할 신설)** → 과거 PR 1~2건에 `claude -p`로 그 역할만 spawn해 발견 목록을 만든다(실행 전 사용자 확인 후).

  **`--agent`는 경로가 아니라 이름을 받는다** — `.claude/agents/`에서 그 이름의 `.md`를 찾아 해석하므로 `.md`도 디렉터리도 붙이지 않는다. 그런데 신설 역할의 파일은 **아직 이 PR 안에만 있다** — 지금 체크아웃된 브랜치에는 없으므로 이름이 해석되지 않는다. 그래서 PR을 잠시 체크아웃했다가 돌아온다. 체크아웃은 작업 트리를 바꾸는 행위라, 먼저 트리가 깨끗한지 확인하고 아니면 **멈춘다**(사람의 미커밋 작업을 이 스킬이 옮기지 않는다):

```bash
[ -z "$(git status --porcelain)" ] || { echo "작업 트리가 깨끗하지 않습니다 — 커밋/stash 후 다시 시도하세요"; exit 1; }
gh pr checkout <pr>                                    # 제안 PR을 체크아웃 — 역할 파일이 여기에만 있다
claude -p --agent <proposed-role-name> "$(gh pr diff <past-merged-pr>)에 이 역할의 Lens로 리뷰 판정을 내려라"
git switch -                                           # 반드시 원래 브랜치로 복귀
```

  `<proposed-role-name>`은 PR diff가 추가한 `.claude/agents/<name>.md`의 basename이다(`reviewer-<short>` 또는 `plan-<short>`). `git switch -`는 실패하든 성공하든 반드시 실행한다 — 체크아웃한 채로 끝내면 사람이 다른 브랜치에 서 있는 줄 모르고 다음 작업을 한다.

  실행 전에 반드시 사람에게 "이 역할을 과거 PR 2건에 시험 실행합니다, 진행할까요?"로 확인한다 — 실제 토큰을 쓰는 호출이다.

- **`role-change`(역할 변경)** → 제안된 에이전트 `.md`를 설치된 `.claude/agents/<name>.md`와 diff한 뒤, `role-new`와 똑같은 절차(깨끗한 트리 확인 → `gh pr checkout <pr>` → `claude -p --agent <name>` → `git switch -`)로 과거 PR 1건에 재실행해 무엇이 달라지는지 보여준다 — 변경된 Lens 역시 PR 안에만 있으므로 체크아웃 없이는 옛 버전이 돈다.

- **`test-delete`(테스트 삭제)** → `.factory/quarantine.toml`의 격리 항목과, 그 테스트가 실패했던 run 기록을 함께 보여준다(삭제는 조용히 일어나지 않는다 — 언제나 사람이 본다).

**드라이런이 불가능한 경우**(예: 근거 run이 지워졌거나, 과거 PR이 하나도 없거나, `claude -p` 실행 권한이 없음): "드라이런 불가 사유"를 명시하고, 그 제안에는 승인을 권고하지 않는다 — 사람에게 판단을 완전히 넘긴다.

### Step 4: 비용 추정 + 선택지

각 제안에 비용(토큰·시간, 예상 lint 실행 시간 등)을 붙이고, 다음 세 선택지를 제시한다:

- **머지** — 드라이런 결과가 긍정적이고 오탐/부작용이 없거나 예외 조건이 명확함.
- **수정 요청** — 오탐 후보가 있으면(예: 특정 패턴 예외 필요) PR 코멘트로 구체적으로 요청.
- **반려** — 드라이런이 부정적이거나 근거가 불충분함. 사유를 기록한다.

예시 대화(그대로):

```
> /know-thy-build:proposal 131

PR #131 · retro-proposal · 2026-W37
────────────────────────────────────────
P1 gate 승격: lesson L-2026-09-05-03 (Promise.all 부분 실패) → eslint rule
   드라이런: 지난 30 PR diff에 적용 → 6건 적중, 그중 4건은 실제로 correctness가 reject했던 PR
   비용: lint +2s. 오탐 후보 1건(#109, allSettled 사용 — 규칙 예외 필요)
P2 Examples 추가 (reviewer-qa, DST 25시간) — 이미 다크로 반영됨. 정보용
P3 역할 신설: reviewer-performance
   드라이런: 지난 load-bearing PR 3건에 spawn → #112에서 N+1 쿼리 발견(당시 미발견, 머지 후 이슈 #120으로 보고됨), #118·#125는 발견 없음
   비용: load-bearing 이슈당 +40k 토큰 (월 예상 +8%)

권고: P1 머지(예외 규칙 추가 요청), P3 머지, P2 없음
  1. P1·P3 승인 → PR에 수정 요청 코멘트(P1 예외) 후 머지 링크
  2. P1만
  3. 반려

> 1

  ✓ PR 코멘트: "P1: allSettled 패턴 예외 추가 요청. P3: 승인" 
  ✓ human-decision 기록
  → 머지: https://github.com/…/pull/131 (수정 커밋 후 사람이 GitHub UI에서 머지 — retro-proposal PR은 merge 잡이 다루지 않는다, ADR-015 R5)
```

### Step 5: 결정 기록 + 머지 링크

PR 코멘트로 드라이런 결과와 결정을 남긴다(`--body-file` — 본문에 인용 줄이 있을 수 있다):

```bash
gh pr comment 131 --body-file <tmp>
```

`human-decision:v1` 블록도 같은 방식으로 PR에 남긴다:

```markdown
<!-- human-decision:v1 issue=131 skill=proposal -->
```yaml
decision: merge
reason: "P1 드라이런 4/6건 실제 reject 대응, 예외 규칙 추가 후 승인. P3 드라이런에서 실질 발견(#112) 확인, 비용 대비 승인. P2는 정보용이라 결정 불필요"
actions:
  - request_changes: { pr: 131, note: "P1: allSettled 패턴 예외 추가" }
```
```

```bash
gh pr comment 131 --body-file <tmp>
```

머지는 사람이 GitHub에서 한다 — 스킬은 링크만 준다: `https://github.com/<owner>/<repo>/pull/131`. **`gh pr merge` 실행은 금지 — 이 스킬에서 절대 호출하지 않는다**(반려도, 승인 후 머지 대기도 이 명령을 쓰지 않는다).

## `factory:needs-human`이 붙은 lessons PR을 마주치면

retro가 self-merge하지 못한 lessons PR은 `factory:needs-human` 라벨이 붙는다(`factory/lib/retro/publish.js`) — 보통 integrity 검사 실패나 default 브랜치와의 충돌 때문이다. 그런 PR이 열려 있으면 왜 막혔는지 설명하고 두 선택지를 제시한다:

- **rebase 후 재검증** — default 브랜치로 rebase한 뒤 integrity를 다시 돌린다.
- **닫기** — 이 PR을 닫는다, 다음 전체 retro가 같은 lesson을 다시 연다.

이 판단도 `human-decision:v1`으로 기록한다.

## Closing

- 매 실행은 제안마다 하나의 드라이런 결과 + 정확히 하나의 PR 코멘트 + 하나의 `human-decision:v1`으로 끝난다.
- 드라이런이 불가능한 제안은 승인 권고 없이 남는다 — 다음 retro나 사람의 추가 조사를 기다린다.
- 머지는 항상 사람이 GitHub UI에서 한다 — 이 스킬은 링크를 주는 것으로 끝난다.
- 다음에 또 `factory:retro-proposal`이나 `factory:harness` PR이 열리면 `/know-thy-build:proposal`을 다시 실행한다.
