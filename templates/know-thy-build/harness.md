---
description: Diagnose and fix `factory doctor` failures, draft a brownfield harness.toml, and review a harness/maturity-promotion PR's diff before a human merges it on GitHub.
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash]
---

# Know Thy Build — Harness

You are the operator's co-pilot at the harness boundary. Three situations bring you here: `factory doctor` is failing, a brownfield repo needs its first `harness.toml`, or a `factory:harness` PR is open and needs a human-readable review before a human merges it.

## Language

**All conversation, summaries, and generated harness.toml comments MUST be in: {{LANG}}**

Technical terms (e.g. CI, lint, coverage, TOML keys) stay in English. Everything else uses the specified language.

## Trigger

(a) `doctor` 실패 (b) 브라운필드 adopt (c) `factory:harness` 이슈의 PR이 열림

## Reads

doctor 출력, harness.toml, 코드(매니페스트·스키마·라우트), 승격 PR diff

## Does

(a) 실패 항목별로 원인 설명 → 함께 수정 → 재실행. (b) 코드에서 명령·성숙도·load_bearing 후보를 도출해 harness.toml 초안 → doctor. (c) 승격 PR의 diff를 "무엇이 gate에 추가되는가, 비용(소요 시간·토큰), 스모크가 실제로 GREEN인가"로 요약 → 사람이 머지하도록 GitHub 링크 제시.

## Produces

harness.toml, doctor PASS, PR 검토 요약 코멘트

## Must not

승격 PR을 머지, `[protected]`를 좁히기, `[load_bearing] paths`를 줄이기, `[harness] maturity`를 손으로 위로 올리기(승격은 factory가 여는 PR을 사람이 머지하는 경로로만 일어난다).

## 집행 규칙 (공통)

라벨은 손으로 옮기지 않는다(`gh issue edit --add-label/--remove-label` 금지); 전이는 `node .factory/bin/transition.js <issue> <label> --human --reason "<why>"`; 거부되면 사유를 사람에게 보여주고 멈춘다; 머지는 `gh pr merge` 금지(GitHub UI 링크만); 결정은 이슈(또는 PR) 코멘트 `<!-- human-decision:v1 issue=<n> skill=<name> -->` + ```yaml 블록(`decision`, `reason`, `actions[]`)으로 `gh issue comment <n> --body-file <tmp>`(본문에 `>` 줄이 있을 수 있으므로 항상 `--body-file`); 모든 요약은 **먼저 읽고**(handoff·run 기록·gates.json·dissent) 한 화면(≤25줄)으로; 질문은 한 번에 하나, 선택지는 2~3개에 권장 표시.

이 스킬은 그 자체로 라벨을 잘 옮기지 않는다 — (a)/(b)에서 하네스를 고치는 동안은 아무 전이도 없고, (c)에서도 전이는 이미 factory가 한 것이다. 그럼에도 `transition.js` 경유 원칙은 그대로 적용된다: 승격 이슈를 사람이 지금 바로 다른 스테이지로 밀고 싶다고 하면(예: 잘못 라벨링된 이슈를 되돌린다), 손으로 라벨을 바꾸지 않고 이 스크립트를 쓴다.

---

## 세 가지 진입점

먼저 어느 경로로 왔는지 확인한다 — 사람이 명시하지 않았다면 사실로 판단한다:

```bash
npx know-thy-build factory doctor --json 2>/dev/null | head -c 2000
gh issue list --label factory:harness --state open --json number,title,labels
ls .factory/harness.toml docs/PROJECT.md 2>/dev/null
```

- doctor가 FAIL을 하나라도 보고한다 → **경로 (a)**.
- `factory:harness` 이슈가 있고, 그 이슈의 구현 PR이 이미 열려 있다(PR은 라벨이 아니라 head 브랜치로 찾는다 — 경로 (c)의 Step 1) → **경로 (c)**.
- `.factory/harness.toml`이 아직 project-specific 값 없이 스켈레톤이고, 코드에 실제 구현이 있다(브라운필드) → **경로 (b)**.

둘 이상이 동시에 참이면 (c) 먼저, 그다음 (a), 그다음 (b) 순서로 다룬다 — 열려 있는 PR을 사람이 기다리는 시간이 가장 비싸다.

## 경로 (a): doctor 실패 항목별 원인·수정 루프

`factory doctor`의 각 FAIL은 `factory/lib/doctor/harness.js`(스키마·게이트·명령·임계값·protected 정적 검사)와 `factory/lib/doctor/factory.js`(파일·CHARTER·roles·skills·settings·hooks·workflows·GitHub 연동)의 체크 id로 나온다. 흔한 id와 원인:

| doctor id | 흔한 원인 |
|---|---|
| `harness.schema`, `harness.maturity` | `harness.toml`이 손상됐거나 `[harness].maturity`가 M0/M1/M2가 아님 |
| `project.default_branch` | `[project].default_branch`가 없음 |
| `factory.orchestration`, `factory.required_checks` | `[factory].orchestration`이 workflow/agent가 아니거나 `required_checks`가 비어 있음 |
| `commands.placeholders`, `commands.<key>`, `commands.run`, `commands.run.<key>` | `[commands]`에 필수 템플릿 placeholder가 빠짐, 명령 자체가 정의 안 됨, 또는(`--no-run`이 아닐 때) 실제 실행이 실패함 |
| `gates.required-in-commands`, `gates.required-in-levels`, `gates.levels-vs-maturity` | `[gates.required]`에 `[commands]`나 증명 세트에 없는 이름이 있음, 또는 성숙도가 그 gate를 지원하지 않음 |
| `proof.commands` | 활성 gate가 요구하는 `[commands.proof]` 항목이 없음 |
| `thresholds.range` | `[gates.thresholds]` 값이 허용 범위 밖 |
| `test.test_glob`, `test.smoke` | `[test].test_glob`이 비어 있음, 또는 `[test].smoke`가 가리키는 파일이 실제로 없음 |
| `protected.globs-match` | `[protected].factory`의 리터럴 경로가 지금 저장소에 없음(오타 또는 지워진 파일) |
| `files.missing`, `files.stale` | `factory init`이 설치할 파일이 없음, 또는 템플릿보다 오래됨(`factory init --upgrade` 필요) |
| `roles.roster-defined`, `roles.agent-files`, `roles.retro-agent-file`, `roles.lessons-files` | CHARTER 로스터가 `roles.toml`에 없는 이름을 가리킴, 또는 역할 `.md`/lessons 파일이 없음 |
| `agents.<role>` | 그 역할의 `.claude/agents/<role>.md`가 §7.2 구조를 안 지킴 |
| `skills.installed`, `skills.<name>`, `skills.missing` | `.claude/commands/know-thy-build/*.md`가 §13.3 구조를 안 지킴, 또는 13개 카탈로그 중 일부가 안 설치됨 |
| `settings.present`, `settings.deny`, `settings.hooks` | `.claude/settings.json`이 없거나 템플릿의 Bash deny/hook과 안 맞음 |
| `settings.ci-deny` | `.factory/ci-settings.json`이 없거나 경로 deny가 빠짐 — CI 에이전트가 빌드 설정을 고칠 수 있게 된다(ADR-019) |
| `hooks.<hook>` | 그 훅(`.claude/hooks/<hook>`)이 없거나 실행 결과가 기대와 다름 |
| `workflows.present`, `workflows.lint` | `.github/workflows/factory-*.yml`이 없거나 lint 위반 |
| `github.claude-secret`, `github.bot-token`, `github.token-issued-at`, `github.labels`, `github.protection`, `github.required-checks`, `github.unavailable` | secret 미설정, 라벨 미부트스트랩, branch protection 미설정(대부분 WARN — `factory bootstrap` 재실행으로 해결), 또는 `gh` 자체가 오프라인(WARN) |

### Step 1: 한 화면 요약

```bash
npx know-thy-build factory doctor
```

FAIL만 골라 원인 후보와 함께 보여준다(≤25줄):

```
✗ commands.run.lint — npm run lint → exit 1: ...
✗ test.smoke — smoke files missing: test/smoke.test.js
```

### Step 2: 함께 수정

FAIL 하나씩, 원인을 설명하고 고친다. `harness.toml`은 `[protected]` 밖의 project-owned 절(`[project]`, `[runtime]`, `[commands]`, `[test]`)만 이 스킬이 직접 `Edit`한다 — `[protected]`로 표시된 절(`[gates.thresholds]`, `[protected]` 자체)은 여기서 고치지 않는다(다른 이유로 바꿔야 한다면 `factory:harness` 이슈를 새로 만들어 사람이 PR을 머지하게 한다).

### Step 3: 재실행

```bash
npx know-thy-build factory doctor
```

FAIL이 남아 있으면 Step 1로 돌아간다. WARN은 남아도 괜찮다(예: `github.protection`은 `factory bootstrap`이 따로 처리) — 다만 왜 WARN인지는 사람에게 설명한다.

## 경로 (b): 브라운필드 adopt

코드가 이미 있는데 `harness.toml`이 아직 스켈레톤이면, 매니페스트·스키마·라우트에서 사실을 뽑아 초안을 만든다.

### Step 1: 명령 후보 도출

```bash
cat package.json 2>/dev/null | head -60
cat .eslintrc* .prettierrc* 2>/dev/null
ls .github/workflows/*.yml 2>/dev/null
```

`scripts`에서 lint/test/build에 해당하는 명령을 찾는다. CI 워크플로우가 이미 실제로 돌리는 명령이 있다면 그것을 우선한다 — CI가 검증한 명령이 로컬 추측보다 신뢰도가 높다.

### Step 2: 성숙도 후보 판단

`factory/lib/retro/maturity.js`가 쓰는 것과 같은 신호를 손으로 본다:
- `prisma/schema.prisma`, `**/migrations/**`, `**/*.sql` 등 DB 스키마 파일이 있다 → 최소 M1.
- `**/routes/**`, `**/api/**`, 또는 express/fastify/hono/koa/next 의존성이 있다 → 최소 M2.
- 둘 다 없다 → M0으로 시작(가장 흔한 정직한 출발점).

낙관적으로 잡지 않는다 — M0에서 시작해 나중에 `factory:harness` 이슈로 승격하는 것이 실제로 안 도는 M2 하네스보다 낫다.

### Step 3: load_bearing 후보 도출

되돌리기 어려운 경로(스키마, 공개 API, 결제/인증)를 코드에서 찾아 `[load_bearing] paths` 후보로 제시한다. 확신이 없으면 사람에게 확인한다 — 이 목록은 tier 판정(`load-bearing` 리뷰 로스터)에 직결되므로 과소 추정이 더 위험하다.

### Step 4: harness.toml 초안

`Edit`로 `[project]`, `[runtime]`, `[commands]`, `[harness].maturity`, `[load_bearing].paths`를 채운다. `[protected].factory`, `[gates.thresholds]`는 템플릿 기본값을 유지한다(이미 protected — 브라운필드라는 이유로 넓히지 않는다).

### Step 5: doctor로 검증

```bash
npx know-thy-build factory doctor --no-run   # 먼저 계약만
npx know-thy-build factory doctor            # 그다음 실제 실행
```

## 경로 (c): 승격 PR 검토

`factory:harness` 라벨은 **이슈에만** 붙는다 — retro(`factory/bin/retro.js`)가 `createIssue`로 그 이슈를 열 때 `[factory:queue, factory:harness]`를 준다. 그 이슈가 일반 파이프라인(plan→implement→review)을 타면서 열리는 구현 PR에는 라벨이 없다: `gh pr create --draft`로 열리고(`factory/lib/gh.js`의 `createPr`), 브랜치는 `claude/fq-<issue>`, 본문에 `Closes #<issue>`가 있다. 그래서 PR은 라벨로 찾지 않고 **head 브랜치로** 찾는다. 찾은 PR이 `harness.toml`(또는 다른 `[protected]` 경로)을 건드리므로 integrity가 자동 머지를 막는다 — 사람이 GitHub UI에서 머지해야 한다. 이 스킬은 그 diff를 사람이 5분 안에 판단할 수 있는 요약으로 바꾼다.

### Step 1: 이슈 → PR 찾기

```bash
gh issue list --label factory:harness --state open --json number,title,labels
# 이슈 번호 <n>마다:
gh pr list --head claude/fq-<n> --state open --json number,url,headRefOid
# 위에서 못 찾으면(브랜치가 이미 지워졌거나 이름이 달라짐) fallback:
gh issue view <n> --json closedByPullRequestsReferences
```

이제부터 `<pr>`은 위에서 찾은 PR 번호다. 어느 쪽도 PR을 못 찾으면 이슈가 아직 plan/implement 단계에 있다는 뜻이다 — 경로 (c)가 아니라 그냥 기다린다: "#<n>은 아직 PR이 없습니다, implement가 진행 중일 수 있습니다."

### Step 2: diff를 세 가지로 요약

```bash
gh pr view <pr> --json title,body,url
gh pr diff <pr>
```

1. **무엇이 gate에 추가되는가** — `[gates.required]`에 새 항목이 생겼나, 새 명령(`[commands]`)이 생겼나, `[harness].maturity`가 올라갔나.
2. **비용** — CI 로그나 PR의 run 기록에서 소요 시간·토큰을 찾는다(`docs/factory/runs/<n>.md`).
3. **스모크가 실제로 GREEN인가** — PR의 체크 상태를 본다:

```bash
gh pr checks <pr>
```

### Step 3: 한 화면 요약 + GitHub 링크 제시

```
PR #<pr> (이슈 #<n> · factory:harness) · <title>
────────────────────────────────────────
gate 추가: [gates.required]에 "coverage" 추가, [harness].maturity M0 → M1
비용: run #<n> — 42분, 380k 토큰
스모크: factory/gates ✓ · factory/review ✓ · factory/integrity ✓ (모두 GREEN)

머지는 사람이 GitHub에서: https://github.com/<owner>/<repo>/pull/<pr>
```

### Step 4: 리뷰 요약 코멘트

```bash
gh pr comment <pr> --body-file <tmp>
```

이 코멘트는 판단을 대신하지 않는다 — 사람이 머지 버튼을 누르기 전에 볼 사실만 모은다. `gh pr merge` 실행은 금지 — 어떤 스킬도 이 명령을 호출하지 않는다.

## Closing

- (a)/(b): `factory doctor` PASS가 이 경로의 완료 기준이다.
- (c): 리뷰 요약 코멘트와 GitHub 링크까지가 이 스킬의 끝이다. 머지는 사람의 몫이다.
- 세 경로 모두 `[protected]`·`[load_bearing]`을 좁히는 방향의 변경은 만들지 않는다(Must not).
