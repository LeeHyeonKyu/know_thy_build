---
description: Create or revise a factory role — a `.claude/agents/<name>.md` reviewer or plan debater — through a structured interview (purpose, inputs, prohibitions, lens), register it in `roles.toml` and the CHARTER roster, trial-run it on past merged PRs before it ever judges a real one, then open a protected-path PR for a human to merge.
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion]
---

# Know Thy Build — Role

You are the person's collaborator when the factory needs a new judge, or an existing one needs to change. A role is a `.claude/agents/<name>.md` file that spawns as a reviewer or a plan debater — it will judge real PRs and real proposals the moment it's registered, so nothing here goes live without a real trial run and a human's merge. This skill usually starts from a `:proposal` dry-run (`role-new`/`role-change` kind) that already made the case; it can also start from a person just asking.

## Language

**All conversation and generated files MUST be in: {{LANG}}**

Technical terms (e.g. frontmatter keys, schema names, tool names, TOML keys) stay in English. Everything else uses the specified language.

## Trigger

역할 신설·수정(보통 `:proposal`에서 파생), 또는 사람이 직접

## Reads

§7.2 필수 구조, 기존 역할 파일들(`.claude/agents/*.md`), 해당 역할의 `.factory/lessons/<name>.md`, `.factory/roles.toml`, `docs/factory/CHARTER.md` 로스터

## Does

목적·입력·금지·Lens를 문답으로 구체화 → 파일 생성(구조 검증은 `lintAgentMd`) → `roles.toml` 등록·`spawn_on` 결정 → CHARTER 로스터 diff 제안 → **시험 실행**: 과거 PR 1~2건에 이 역할만 spawn해 출력을 보여줌 → 조정 → PR 생성(protected이므로 사람 머지)

## Produces

`.claude/agents/<role>.md`, `roles.toml` diff, PR

## Must not

기존 역할의 Lens를 조용히 수정(diff를 명시), 시험 실행 없이 등록

## 집행 규칙 (공통)

라벨은 손으로 옮기지 않는다(`gh issue edit --add-label/--remove-label` 금지); 전이는 `node .factory/bin/transition.js <issue> <label> --human --reason "<why>"`; 거부되면 사유를 사람에게 보여주고 멈춘다; 머지는 `gh pr merge` 금지(GitHub UI 링크만); 결정은 이슈(또는 PR) 코멘트 `<!-- human-decision:v1 issue=<n> skill=<name> -->` + ```yaml 블록(`decision`, `reason`, `actions[]`)으로 `gh issue comment <n> --body-file <tmp>`(본문에 `>` 줄이 있을 수 있으므로 항상 `--body-file`); 모든 요약은 **먼저 읽고**(handoff·run 기록·gates.json·dissent) 한 화면(≤25줄)으로; 질문은 한 번에 하나, 선택지는 2~3개에 권장 표시.

이 스킬은 이슈보다 PR을 더 자주 다룬다(자신이 여는 `factory/role-<name>` PR) — `human-decision:v1`은 그 PR에 남긴다(`gh pr comment <pr> --body-file <tmp>`). 관련 이슈(예: 이 역할 신설을 요청한 `:proposal` 근거 이슈)를 전이해야 할 때만 `transition.js`를 쓴다. 어느 경우든 `gh pr merge` 실행은 금지다 — `.factory/roles.toml`과 `.claude/agents/**`는 protected build-config 경로라 integrity가 자동 머지를 막고, 머지 버튼은 언제나 사람이 GitHub UI에서 누른다.

Must not도 하나 더: **이번 세션에서 만들지 않은 역할**의 `roles.toml` 블록을 diff 없이 편집하지 않는다 — 그 역할을 원래 등록한 사람의 의도를 이 세션이 대신 판단하지 않는다.

---

## How You Operate — 6단계 (문답 → 파일·등록 → 시험 → PR)

### Step 1: 목적·입력·금지·Lens를 문답으로 (§7.2)

`.claude/agents/*.md`는 8개 섹션이 필수다(`Purpose`/`You receive`/`You must not`/`Lens`/`Output`/`Examples`/`Perspectives`/`Lessons`) — `factory/lib/agent-md.js`의 `lintAgentMd`가 이 구조를 그대로 검사한다. 신설이면 문답으로 각 섹션을 구체화한다:

1. **Purpose** — 이 역할이 무엇을 판정하는가, 한 문단. 다른 역할과 겹치지 않는 질문 하나로 좁힌다("이 diff 이후 공격자가 무엇을 더 할 수 있는가"처럼).
2. **You receive** — 무엇을 읽는가(diff, context.json, harness.toml, lessons, 저장소 전체). `cold_read`이면 "받지 않는 것"도 함께 명시한다(다른 리뷰어 판정, builder 설명, PR 코멘트 등).
3. **You must not** — 금지 행동(파일 수정, 불확실할 때 approve, 재현 없는 발견 등).
4. **Lens** — 이 역할만의 체크리스트, **최소 5개** 항목을 권장한다(각 항목은 무엇을 보고 무엇을 묻는지 구체적으로).
5. **Output** — schema 이름(리뷰어는 `factory.verdict.v1`, plan 토론자는 `factory.plan.position.v1`/`crossexam.v1`/`vote.v1`)과 필드.
6. **Examples** — `### 좋은 발견`/`### 나쁜 발견` 각 **≥2개** 불릿. 위치·근거·재현이 있는 예와, 그것 없이 뭉뚱그린 예를 대조한다.
7. **Perspectives** — 이 역할이 세상을 보는 렌즈, **≥3개** 불릿.
8. **Lessons** — `.factory/lessons/<name>.md` 경로를 리터럴로 적고 "체크리스트로 읽어라"를 지시한다.

수정이면(기존 Lens 변경) 새 문항을 처음부터 다시 묻지 않는다 — 바꾸려는 지점만 사람에게 확인하고 나머지는 그대로 둔다.

### Step 2: 파일 생성/수정 + 구조 검증

frontmatter는 `name`(파일 basename과 정확히 일치), `description`, `tools`, `model`(opus|sonnet|haiku), 그리고 쓰기 금지 역할(이름이 `reviewer-`/`plan-`로 시작하거나 `factory-triage`/`factory-verifier`/`factory-loader`)이면 `hooks.PreToolUse`를 `deny-all-writes.sh`에 배선한다. 리뷰어 예시(`templates/factory/claude/agents/reviewer-security.md`의 frontmatter를 그대로 가져온 모양):

```yaml
---
name: reviewer-security
description: 이 diff가 신뢰 경계·인증/인가·시크릿·의존성 측면에서 공격 가능한 표면을 넓혔는지를 cold read로 판정한다
tools: Read, Grep, Glob, Bash
model: opus
hooks:
  PreToolUse:
    - matcher: Edit|Write|NotebookEdit|Bash
      hooks: [{ type: command, command: .claude/hooks/deny-all-writes.sh }]
---
```

plan 토론자 예시(`templates/factory/claude/agents/plan-skeptic.md`의 frontmatter):

```yaml
---
name: plan-skeptic
description: plan 토론에서 제안을 공격하고 근본 결함·급진적 대안·'만들지 않을 것'을 주장한다
tools: Read, Grep, Glob
model: opus
hooks:
  PreToolUse:
    - matcher: Edit|Write|NotebookEdit|Bash
      hooks: [{ type: command, command: .claude/hooks/deny-all-writes.sh }]
---
```

`matcher`는 반드시 `Bash`까지 덮는다 — 전역 `block-dangerous.sh`는 보호 경로만 보므로, `Bash`가 빠진 matcher는 쓰기 금지 역할이 `echo x > src/a.js`로 소스 트리를 고치는 것을 막지 못한다.

`Write`(신설) 또는 `Edit`(수정)로 `.claude/agents/<name>.md`를 만든 뒤, 구조를 검증한다:

```bash
node -e 'import("./.factory/lib/agent-md.js").then(m=>console.log(JSON.stringify(m.lintAgentMd(require("fs").readFileSync(".claude/agents/<name>.md","utf8"),{expectedName:"<name>"}))))'
```

`[]`가 나올 때까지 고친다 — 위반이 있으면 배열 각 항목의 `rule`/`msg`가 정확히 무엇이 빠졌는지 말해준다.

### Step 3: `roles.toml` 등록 — 블록 + `spawn_on`/`model`

`.factory/roles.toml`(`templates/factory/factory/roles.toml`이 원본 모양이다)에 블록을 추가한다. 리뷰어는 `[review.<name>]`, plan 토론자는 `[plan.<name>]`. 기존 블록을 그대로 예시로 복사해서 값만 바꾼다:

```toml
[review.<name>]
agent    = ".claude/agents/reviewer-<name>.md"
model    = "opus"
lessons  = ".factory/lessons/reviewer-<name>.md"
spawn_on = ["tier:load-bearing", "path:src/auth/**"]
cold_read = true
output   = "factory.verdict.v1"
```

```toml
[plan.<name>]
agent   = ".claude/agents/plan-<name>.md"
model   = "opus"
lessons = ".factory/lessons/plan-<name>.md"
stance  = "<이 역할이 토론에서 대변하는 입장, 한 문장>"
```

`model`은 `docs/research/multi-agent-model-guidance-for-repo.md`의 balanced 프로파일을 기본으로 한다(리뷰어·plan 토론자는 보통 `opus`). `spawn_on`은 리뷰어에만 있다(`tier:docs`/`tier:standard`/`tier:load-bearing`, `path:<glob>`) — 이 역할이 어느 tier·경로에서 소집되는지 결정한다. 신설이면 CHARTER 로스터에 아직 없으므로 아무 tier에도 소집되지 않는다는 것을 사람에게 말하고 Step 4로 넘어간다.

### Step 4: CHARTER 로스터 diff 제안 — 조용히 적용하지 않는다

`docs/factory/CHARTER.md` frontmatter `roster:`(`docs: [...]`, `standard: [...]`, `load-bearing: [...]`)에 새 이름을 추가하는 diff를 만들되, **적용하기 전에 diff를 그대로 보여준다**:

```diff
 roster:
   docs: [correctness, spec-conformance]
-  standard: [correctness, architecture, spec-conformance, qa]
+  standard: [correctness, architecture, spec-conformance, qa, <name>]
   load-bearing: [correctness, security, architecture, spec-conformance, qa]
```

사람이 승인하면 `Edit`으로 반영한다. 기존 역할의 로스터 자리를 빼거나 옮기는 변경이면 왜 그런지 한 문장을 diff와 함께 남긴다.

### Step 5: 시험 실행 (P5-R5) — 진행 전 토큰 비용을 반드시 고지

**실제 토큰을 쓰는 호출이다.** 실행 전에 반드시 사람에게 확인을 받는다 — 몇 건을 시험할지, 대략 어느 정도 비용(diff 길이 기준 추정)이 드는지 먼저 말하고 나서 실행한다:

```
"reviewer-<name>을 과거 merged PR 2건에 시험 실행합니다 — PR당 1회 opus 호출, 대략 <추정> 토큰입니다. 진행할까요?"
```

과거 merged PR을 고른다:

```bash
gh pr list --state merged --limit 5 --json number,title
```

사람이 승인하면 그중 1~2건으로 diff를 담아 그 역할만 spawn한다:

```bash
gh pr diff <merged-pr>
claude -p --agent <name> "<위 diff와 필요한 컨텍스트를 담은 프롬프트>"
```

출력(발견 목록, verdict)을 그대로 보여준다 — 실제 발견이 있는가, 오탐인가, Lens가 놓치는 게 있는가를 사람과 함께 판단하고, 필요하면 Step 1~4로 돌아가 Lens/`spawn_on`을 조정한다. **시험 실행 없이 등록하지 않는다**(Must not) — 조정이 끝나 만족스러울 때만 Step 6으로 간다.

### Step 6: PR 생성 — protected 경로이므로 사람이 머지

```bash
git checkout -b factory/role-<name>
git add .claude/agents/<name>.md .factory/roles.toml docs/factory/CHARTER.md
git commit -m "feat(factory): add role <name>"
git push -u origin factory/role-<name>
gh pr create --label factory:retro-proposal --title "role: <신설|변경> <name>" --body-file <tmp>
```

PR 본문에는 목적·Lens 요약·시험 실행 결과(적중/오탐)·CHARTER 로스터 diff를 담는다. `.factory/roles.toml`과 `.claude/agents/**`는 protected build-config 경로라 integrity가 자동 머지를 막는다 — 사람이 GitHub UI에서 직접 머지한다. **`gh pr merge` 실행은 금지 — 이 스킬은 어떤 경우에도 호출하지 않는다.**

## human-decision 기록

PR이 열리면 그 PR에 남긴다 — `skill=role`:

```markdown
<!-- human-decision:v1 issue=<pr> skill=role -->
```yaml
decision: propose
reason: "reviewer-<name> 시험 실행: PR #<a>에서 실질 발견 1건, PR #<b>는 발견 없음(false negative 없음 확인). CHARTER standard 로스터에 추가 제안"
actions:
  - create_role: { name: "<name>", agent: ".claude/agents/<name>.md" }
  - register_roles_toml: { block: "[review.<name>]" }
  - propose_charter_roster: { tier: "standard", add: "<name>" }
```
```

```bash
gh pr comment <pr> --body-file <tmp>
```

> "역할 `<name>`이 PR #<pr>로 제안됐습니다 — 시험 실행 결과와 CHARTER 로스터 diff가 코멘트에 있습니다. 사람이 GitHub UI에서 머지하면 다음 실행부터 이 역할이 소집됩니다."

## Closing

- 매 실행은 정확히 하나의 파일(신설/수정) + `roles.toml` diff + 시험 실행 결과 + 하나의 PR + 하나의 `human-decision:v1`으로 끝난다.
- 시험 실행 없는 등록, 조용한 Lens 수정, 이번 세션에서 만들지 않은 역할의 `roles.toml` diff-없는 편집은 이 스킬에서 절대 일어나지 않는다(Must not).
- 머지는 항상 사람이 GitHub UI에서 한다 — 이 스킬은 PR과 근거를 주는 것으로 끝난다.
- 다음에 또 새 역할이 필요하면(보통 `:proposal`의 `role-new`/`role-change` 드라이런에서 시작) `/know-thy-build:role`을 다시 실행한다.
