# Factory Plan 3 — Claude-side: Workflows, Role Agents, Review Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `claude -p "/factory-<stage> <issue>"`가 실제로 무언가를 하게 만든다 — 4개 Workflow 스크립트(triage/plan/implement/review), 역할 에이전트 13개 + loader 1개, 리뷰어 쓰기 금지 훅, 스테이지별 handoff 사람용 렌더링, `doctor`의 에이전트 파일 검사. 이 계획이 끝나면 Plan 2로 init된 repo에서 `factory:queue` → triage → plan → implement → review → merge가 **에이전트 실행까지 포함해** 한 바퀴 돈다(retro는 Plan 4).

**Architecture:** L1(Plan 1a/1b/2)은 손대지 않는다. 메인 세션은 디스패처(Plan 2 커맨드)이고, 절차·인원·라운드는 `.claude/workflows/factory-<stage>.js`(결정적 JS, fs 없음)가 정한다. workflow는 파일을 못 읽으므로 첫 스텝의 **loader 에이전트**가 `.factory/out/context.json`을 읽어 로스터·라운드·모델을 schema로 돌려주고, 이후 `agent({agentType, model, schema})`가 역할별 `.claude/agents/<name>.md`를 띄운다(§4.2.3). 역할 에이전트는 자기 `.md`·`context.json`·lessons·diff를 **직접 읽는다**(프롬프트에는 경로와 과업만). workflow가 `return`한 객체가 곧 handoff 데이터이며 `verify-stage`가 최상위 객체를 스테이지 schema로 검증한다(§4.2.1 step 6). workflow는 vitest에서 **`node:vm` 하네스로 실행**한다 — `agent()`를 스텁해 라운드·인원·분기를 결정적으로 검증한다.

**Tech Stack:** Claude Code Workflow 도구(`agent/parallel/pipeline/phase/log/args/budget`; `Date.now()`·fs·Node API 불가), `.claude/agents/*.md`(frontmatter `name/description/tools/model/hooks`), `node:vm`, vitest, bash 훅.

**Spec:** §4.2 (제어 계층·디스패처·각 층이 읽는 것·orchestration), §3.4 (handoff JSON), §5.2.2–5.2.4 (builder/verifier의 테스트 규약), §7.1–7.5 (레지스트리·역할 파일 구조·예시·소통 구조), §9 (run 기록), ADR-001 (훅은 workflow 서브에이전트에서도 발화; `agent_type` = frontmatter name), ADR-002 (`-p`에서 Workflow 실행, `--max-turns 5`), ADR-003 (schema null 0/20 — 재spawn은 보험), ADR-006 (건너뛰기는 감지), ADR-010 (게이트 파일 진실), ADR-011 (flaky 재분류는 implement만), ADR-015 (merge 스크립트 전용 — `factory-merge.js` 없음).

## Global Constraints

- Plan 1a/1b/2 제약 상속(Node ≥22 ESM, 런타임 의존성 `smol-toml`만, 외부 프로세스는 `run()` 주입, 테스트는 프로세스를 띄우지 않음 — 예외: 훅 bash). 커밋은 `spec/factory-1.0`, push 금지. TDD.
- **workflow 스크립트는 자급자족이다**: `import` 없음, 파일·네트워크·`Date.now()`·`Math.random()` 없음. 분기는 오직 `agent()`가 돌려준 schema 값으로. 첫 줄은 `export const meta = {…}` 순수 리터럴, `phases` 제목은 `phase()` 호출과 동일.
- **로스터는 L1이 정한다**: workflow는 `args.context`(경로)만 받고 loader가 `context.json`의 `roster`/`role_agents`/`rounds`/`tier`/`limits`/`orchestration`을 schema로 돌려준다. workflow는 로스터를 하드코딩하지 않는다(§7.1 "역할 추가 = 파일 1개 + roles.toml 한 블록 + CHARTER"). 로스터 이름 → `agentType`은 `role_agents[name]`의 파일 basename(`.claude/agents/reviewer-qa.md` → `reviewer-qa`)이다 — `verify-stage`가 훅 로그의 `agent_type`을 `rolePrefix + role`("reviewer-" + "qa")로 대조하므로 **파일명 = frontmatter `name` = `<prefix><role>`** 규약을 어기면 스테이지가 needs-human으로 떨어진다.
- **return 계약** — workflow의 `return` 객체는 스테이지 schema를 만족해야 한다: triage `triage.v1`(`issue, disposition, tier?, questions?`), plan `plan.v1`(`issue, tier, roles, rounds, done_when[{id,text,verify,level}], files_expected, dissent_log, non_goals, open_risks`), implement `implement.v1`(`issue, head_sha(40hex), pr, verifier{verdict}, orchestration, guarantee` — `gates`는 verify-stage가 파일에서 채운다), review `review.v1`(`issue, pr, head_sha, round, verdicts[{role, verdict, confidence, must_fix[{id,where,claim,evidence}], should_fix, verified}], orchestration, guarantee`). 추가 필드(`summary`, `debate`, `r1`, `rework_response`)는 허용된다. `orchestration: "workflow"`, `guarantee: "structural"` 고정.
- **cold read**(§7.1 `cold_read = true`): verifier와 reviewer(spec-conformance 제외)의 프롬프트에는 builder의 설명·PR description·다른 리뷰어의 R1 판정이 들어가지 않는다(R2에서만 타 리뷰어 판정 제공). 그들의 `.md`가 "찾아 읽지도 않는다"를 명시한다.
- **쓰기 금지 역할**: triage, plan-*, verifier, reviewer-* 의 frontmatter `hooks.PreToolUse`에 `.claude/hooks/deny-all-writes.sh`(matcher `Edit|Write|NotebookEdit`, exit 2). builder만 쓴다. `block-dangerous.sh`(settings.json)는 전역이라 그대로 겹친다.
- **모델**: `agent()`의 `model`은 loader가 돌려준 `roles.toml`의 값(`opus|sonnet`). 프롬프트는 한국어·영어 혼용 가능하되 **schema 필드명은 영어**(스펙 §3.4).
- 역할 `.md`의 필수 섹션(§7.2, `doctor`가 검사): frontmatter `name, description, tools, model` + `## Purpose`, `## You receive`, `## You must not`, `## Lens`, `## Output`, `## Examples`(좋은 발견 ≥2, 나쁜 발견 ≥2), `## Perspectives`(≥3), `## Lessons`(`.factory/lessons/<name>.md` 경로 + "체크리스트로 읽어라"). 어떤 역할도 `include` 문법에 의존하지 않는다.
- 스펙 §7.3의 `reviewer-correctness.md` 예시는 **그대로** 템플릿이 된다(훅 경로만 `.claude/hooks/deny-all-writes.sh`).

## Rulings baked into this plan

| # | 결정 | 근거 |
|---|---|---|
| P3-R1 | loader 에이전트(`factory-loader`, sonnet)가 로스터를 schema로 돌려준다; 역할 에이전트는 `context.json`을 직접 읽는다 | workflow는 파일을 못 읽는다(§4.2.3). 큰 JSON을 LLM이 verbatim 복사하게 하지 않는다 |
| P3-R2 | implement는 builder → verifier → (rejected면) builder 수정 1회 → verifier 재판정, 그래도 rejected면 그대로 return(implement.v1 `verifier.verdict = "rejected"` → requirements가 awaiting-review 전이를 거부 → needs-human) | §5.2.2 verifier `prove-test`; 무한 루프 금지 |
| P3-R3 | review R2는 §7.5 그대로: R1에 reject 있으면 전체 R2(`maintain|revise`), 만장일치 approve면 경량 R2(`missed[]`) → missed 있으면 그 리뷰어만 전체 R2. `verdicts[]`는 **R2 결과**(경량 R2에서 missed 없음 = R1 유지) | 집단사고 방지·다양성 보존 |
| P3-R4 | rework 시 builder는 `factory.rework-response.v1`을 **PR 코멘트로 직접** 남기고(`gh pr comment`) return에도 싣는다; 다음 review R1에서 `disputed` 항목은 그 must_fix를 낸 리뷰어가 `withdraw|uphold`로 판정(uphold = 해당 must_fix 유지 → reject) | §7.5 |
| P3-R5 | plan의 라운드 코멘트 3개(§7.5 주석 "run-stage.sh가 라운드별 코멘트 3개 + handoff 1개")는 **handoff 코멘트 하나의 사람용 본문**으로 합친다(R1 입장 요약·R2 반박 수·서명 결과·dissent). 코멘트 수를 늘리면 `parseHandoffs`가 아닌 별도 마커가 필요해진다 — 1.0에서는 불필요 | 단순성; 기계 블록은 하나 |
| P3-R6 | workflow 테스트는 `node:vm`으로 스크립트를 실제 실행한다(`export const meta`를 `const meta`로 치환, 본문을 async 함수로 감쌈, `agent()` 스텁 주입). 스텁은 `agentType`·`label`·`schema`·`model`을 기록해 인원·순서·분기를 단언한다 | 결정적 스크립트는 결정적으로 시험할 수 있다 |
| P3-R7 | `factory-merge.js`·`factory-integrator.md`는 만들지 않는다(ADR-015 R3); `factory-retro.md`·`factory-retro.js`는 Plan 4 | 범위 |
| P3-R8 | schema null(에이전트 사망/skip) 시 **1회 재spawn**(ADR-003 보험), 두 번째도 null이면 그 역할은 결과에서 빠지고 `verify-stage`의 로스터 대조가 needs-human으로 잡는다 — workflow가 역할을 지어내지 않는다 | §7.5 |

---

## File Structure

```
templates/factory/
├── claude/workflows/
│   ├── factory-triage.js
│   ├── factory-plan.js
│   ├── factory-implement.js
│   └── factory-review.js
├── claude/agents/
│   ├── factory-loader.md                # context.json → schema (sonnet)
│   ├── factory-triage.md
│   ├── plan-product-advocate.md · plan-architect.md · plan-skeptic.md · plan-operator.md · plan-synthesizer.md
│   ├── factory-builder.md · factory-verifier.md
│   └── reviewer-correctness.md · reviewer-security.md · reviewer-architecture.md · reviewer-spec-conformance.md · reviewer-qa.md
factory/
├── hooks/deny-all-writes.sh             # PreToolUse(Edit|Write|NotebookEdit) → exit 2 (frontmatter 훅)
├── lib/agent-md.js                      # parseAgentMd(text) → {frontmatter, sections}; REQUIRED_SECTIONS; lintAgentMd(text, {name}) → violations[]
├── lib/handoff.js                       # (수정) renderHandoff: 스테이지별 사람용 본문(plan/implement/review)
├── lib/doctor/factory.js                # (수정) checkAgents({roles, root, readFile, exists}) — 섹션·name·lessons 경로
├── cli/doctor.js                        # (수정) checkAgents 배선
└── test/
    ├── helpers/run-workflow.js          # runWorkflow(path, {agent, args}) — vm 하네스
    ├── workflows.test.js                # 4개 스크립트: meta·phases·인원·라운드·분기·return 계약(validate())
    ├── agent-md.test.js                 # 파서·린터 + 14개 템플릿 전수 검사
    ├── hooks.test.js                    # (추가) deny-all-writes
    ├── handoff.test.js                  # (추가) 렌더링
    └── doctor-factory.test.js           # (추가) checkAgents
docs/
├── superpowers/specs/…factory-design.md # (수정) §4.2.3 loader, §7.5 P3-R3/R4/R5 반영, §7.2 doctor 검사
└── factory/DECISIONS.md                 # ADR-016 Plan 3 판결
```

---

### Task 1: workflow 실행 하네스 + `deny-all-writes.sh` + `agent-md` 파서/린터

**Files:**
- Create: `factory/test/helpers/run-workflow.js`, `factory/hooks/deny-all-writes.sh`, `factory/lib/agent-md.js`
- Test: `factory/test/agent-md.test.js`, `factory/test/hooks.test.js`(추가), `factory/test/workflows.test.js`(하네스 자체 테스트 1개 — 스파이크 스크립트 형태의 인라인 워크플로가 돈다)

**Interfaces:**
- `runWorkflow(file, { agent, args = {}, log = () => {} }) → Promise<{ result, calls: [{prompt, opts}], phases: string[] }>` — `file` 텍스트에서 `^export const meta` → `const meta`로 치환, `(async () => { <body> })()`로 감싸 `vm.runInNewContext`; 컨텍스트 globals: `meta` 없음(스크립트가 선언), `agent(prompt, opts)`(주입 스텁 호출 + `calls` 기록), `parallel(thunks)`(`Promise.all`, throw→null), `pipeline(items, ...stages)`(항목별 순차, 단계 throw→null), `phase(t)`(`phases.push`), `log`, `args`, `budget = { total: null, spent: () => 0, remaining: () => Infinity }`, `JSON/Math/Array/Object/String/Number/Promise/Set/Map`. `Date`·`require`·`process`는 **없다**(스크립트가 쓰면 ReferenceError로 테스트가 죽는다 — 의도).
- `parseAgentMd(text) → { frontmatter: {name, description, tools:[…], model, hooks?}, sections: Map<title, body> }` (frontmatter는 `lib/frontmatter.js` 재사용; `tools: Read, Grep, Glob, Bash` 쉼표 분리; `## ` 헤더로 섹션 분리)
- `REQUIRED_SECTIONS = ["Purpose", "You receive", "You must not", "Lens", "Output", "Examples", "Perspectives", "Lessons"]`
- `lintAgentMd(text, { expectedName }) → [{ rule, msg }]` — 규칙: `frontmatter.name === expectedName`; `model ∈ {opus, sonnet, haiku}`; `tools` 비어있지 않음; 필수 섹션 전부 존재; `Examples`에 `### 좋은 발견` 아래 `- ` 항목 ≥2, `### 나쁜 발견` 아래 ≥2; `Perspectives` 항목 ≥3; `Lessons` 본문에 `.factory/lessons/<expectedName>.md` 문자열; 쓰기 금지 역할(`name`이 `reviewer-`·`plan-`로 시작하거나 `factory-triage`·`factory-verifier`)이면 `hooks.PreToolUse`에 `deny-all-writes.sh` 포함.
- `deny-all-writes.sh`: stdin JSON; `tool_name ∈ {Edit, Write, NotebookEdit}`이면 stderr `factory: this role must not write files (<tool_name> <file_path>)` + exit 2; 그 외 exit 0; jq 없으면 exit 2(fail closed, `block-dangerous.sh`와 동일).

- [ ] **Step 1: 실패하는 테스트** — `agent-md.test.js`: §7.3 예시 텍스트(훅 경로 치환)를 픽스처로 `parseAgentMd`가 frontmatter·8개 섹션을 돌려준다; `lintAgentMd` 통과; `name` 불일치/섹션 누락/Examples 1개/`Lessons` 경로 틀림/reviewer인데 훅 없음 각각 위반 1개. `hooks.test.js`: `deny-all-writes.sh`에 `{tool_name:"Edit", tool_input:{file_path:"src/a.js"}}` → 2 + 메시지, `{tool_name:"Read"}` → 0, `{tool_name:"Bash"}` → 0, `PATH=/nonexistent` → 2. `workflows.test.js`: 인라인 스크립트(`export const meta = {name:'t',description:'d',phases:[{title:'A'}]}\nphase('A')\nconst r = await parallel([() => agent('x',{agentType:'w', schema:{type:'object'}})])\nreturn { r }`)를 임시 파일로 써서 `runWorkflow` → `result.r[0]`가 스텁 반환값, `calls[0].opts.agentType === 'w'`, `phases` = `['A']`; `Date.now()`를 쓰는 스크립트는 reject된다.
- [ ] **Step 2: 실패 확인.** **Step 3: 구현.** **Step 4: 통과.** **Step 5: 커밋** `feat(factory): workflow vm harness, deny-all-writes hook, agent-md parser/linter`.

---

### Task 2: `factory-loader.md` + `factory-triage.md` + `factory-triage.js`

**Files:**
- Create: `templates/factory/claude/agents/factory-loader.md`, `templates/factory/claude/agents/factory-triage.md`, `templates/factory/claude/workflows/factory-triage.js`
- Test: `factory/test/workflows.test.js`(추가), `factory/test/agent-md.test.js`(템플릿 전수 검사는 Task 6에서 켠다 — 여기서는 두 파일 개별 lint)

**Interfaces:**
- LOADER schema(모든 workflow가 같은 리터럴을 갖는다):
```js
const LOADER = { type: 'object', required: ['issue', 'stage', 'tier', 'roster', 'orchestration'], properties: {
  issue: { type: 'number' }, stage: { type: 'string' }, tier: { type: 'string' },
  roster: { type: 'array', items: { type: 'object', required: ['name', 'agentType', 'model'], properties: { name: { type: 'string' }, agentType: { type: 'string' }, model: { type: 'string' }, lessons: { type: 'string' } } } },
  rounds: { type: 'number' }, limits: { type: 'object' }, spec_path: { type: 'string' }, pr: { type: 'number' }, head_sha: { type: 'string' },
  must_fix: { type: 'array', items: { type: 'object' } }, disputed: { type: 'array', items: { type: 'object' } }, orchestration: { type: 'string' } } }
```
  loader 프롬프트: "Read `<args.context>`. Return exactly: issue=`issue.number`, stage, tier, roster = for each name in `roster`: `{name, agentType: basename of role_agents[name] without .md, model: from `.factory/roles.toml` [<stage-section>.<name>].model (read the file), lessons: lessons[name]}`, rounds, limits, spec_path, orchestration; pr/head_sha from `handoffs.implement` if present; must_fix = union of `handoffs.review.verdicts[].must_fix` when `handoffs.review.decision === "rework"`; disputed = entries of the latest `factory.rework-response.v1` PR comment with status `disputed` (read via `gh pr view <pr> --comments` only if pr exists). Do not invent roles." (loader의 `tools: Read, Bash, Grep`; model sonnet; 쓰기 금지 훅.)
- `factory-triage.js`: `phase('Load')` loader → `phase('Triage')` `agent(prompt, { agentType: 'factory-triage', model: <roles.toml triage.model via loader roster? — triage는 로스터가 없으므로 loader가 `roster: [{name:'triage', agentType:'factory-triage', model}]`를 돌려준다>, schema: TRIAGE })` → null이면 1회 재spawn → `return { ...verdict, issue, orchestration: 'workflow', guarantee: 'structural' }`. TRIAGE schema: `disposition ∈ ready|needs-info|wont-do`, `tier ∈ docs|standard|load-bearing`(ready면 필수), `questions[]`(needs-info면 ≥1), `reason`, `summary`.
- `factory-triage.md`: Purpose(이슈가 factory가 다룰 수 있는 일인지·tier 판정), You receive(context.json, 이슈 본문, `docs/factory/CHARTER.md`의 NEVER_AUTOMATE·Tiers, `docs/features/<spec>`, `harness.toml [load_bearing]`), You must not(코드 수정, 구현 착수, 스펙 없는 이슈를 ready로), Lens(NEVER_AUTOMATE 매치 → wont-do; done_when을 쓸 수 있을 만큼 구체적인가 → 아니면 needs-info + 질문 ≤3; diff 예상 경로가 `docs/**`만이면 docs, `[load_bearing].paths` 건드리면 load-bearing, 아니면 standard; 재현 절차 없는 버그는 needs-info), Output(schema), Examples(좋은: "결제 제공자 교체 → wont-do, CHARTER NEVER_AUTOMATE 1항", "스펙 016.md에 done_when 후보 3개 → ready/standard" / 나쁜: "애매하지만 일단 ready", "tier를 항상 standard"), Perspectives(문지기, 범위 회의론자, 스펙 독자), Lessons(경로).

- [ ] **Step 1: 실패하는 테스트** — `workflows.test.js`: 스텁 `agent`가 `agentType`별로 `{factory-loader: LOADER_FIX, factory-triage: {disposition:'ready', tier:'standard', reason:'…', summary:'…'}}`를 돌려줄 때 `runWorkflow('templates/factory/claude/workflows/factory-triage.js', {args:{issue:7, context:'.factory/out/context.json'}})` → `calls` 순서 `[factory-loader, factory-triage]`, `result`가 `validate('triage.v1', result).ok`, `orchestration === 'workflow'`; triage 스텁이 첫 호출에 null → 두 번째 호출 발생(재spawn 1회), 두 번째도 null → `result.disposition` 없음(호출자인 verify-stage가 잡는다 — 테스트는 `calls.filter(agentType==='factory-triage').length === 2`); `phases` = `['Load','Triage']`. `agent-md.test.js`: 두 파일 lint 통과.
- [ ] **Step 2~5**: 구현 → 통과 → 커밋 `feat(factory): loader + triage agent and workflow`.

---

### Task 3: plan 토론 — `factory-plan.js` + 5개 plan 에이전트

**Files:**
- Create: `templates/factory/claude/workflows/factory-plan.js`, `templates/factory/claude/agents/plan-{product-advocate,architect,skeptic,operator,synthesizer}.md`
- Test: `factory/test/workflows.test.js`(추가)

**Interfaces:**
- 스펙 §7.5의 발췌 코드를 완성한다(P3-R1: `roles`는 loader의 `roster`; `context`는 문자열 안내 "Read `.factory/out/context.json` and the spec it points to"). schemas: `POS = {position, risks[], proposed_done_when[{id,text,verify,level}], files_expected[]}`, `XEX = {agreements[], objections[{to, claim, evidence}], concessions[]}`, `PLAN_V1`(plan.v1 필드 전부 + `summary`), `VOTE = {vote ∈ accept|object, reason}`. 라운드: R1 병렬(로스터 전원) → R2 병렬(전원, 타 역할 R1 제공) → R3 synthesizer(`agentType:'plan-synthesizer'`, model은 loader roster에 synthesizer가 없으므로 `opus` 고정 — roles.toml 값과 일치) → 서명 병렬 → object 있으면 R3 재실행 1회 → 그래도 object면 `dissent_log`에 추가. **`rounds`는 loader의 `rounds`(CHARTER plan_rounds)** — docs tier면 2(R1→R3, R2 생략), 그 외 3. `roles`는 로스터 이름 배열. return `{ ...plan, issue, tier, roles, rounds, orchestration:'workflow', guarantee:'structural', debate: { r1, r2, votes } }`. null 재spawn 1회 규칙은 각 `agent()` 호출을 감싸는 `once(fn)` 헬퍼로.
- 5개 `.md`(각 §7.2 구조, stance는 roles.toml의 문장을 Purpose 첫 줄에): product-advocate(사용자 가치·스펙 의도·범위 축소 저항; Lens: done_when이 사용자 관점 검증인가, 스펙의 "왜"가 살아있나, 비기능 요구), architect(경계·계약·데이터 모델; Lens: TECHNICAL.md/ADR 인용, 모듈 경계·의존 방향, 마이그레이션·호환, files_expected 최소성), skeptic(제안 공격·근본 결함·"만들지 않을 것"; Lens: 이 기능이 없어도 되는 이유, 숨은 경쟁 조건·비결정성(flaky 이슈면 제품 결함 여부 필수 질문 §5.2.5-④), 되돌림 비용, 테스트가 구현을 복사할 위험), operator(배포·장애·롤백·관측; Lens: 실패 시 무엇이 보이나, 롤백 경로, 리소스·타임아웃, 환경 변수·시크릿), synthesizer(합의안; You must not: 반박을 삭제해 합의를 위조, 테스트 없는 done_when; Lens: 각 done_when에 `verify` 테스트 id `test_<issue>_<slug>`와 `level`(현재 성숙도 이하), files_expected는 R1 합집합의 교집합 우선, non_goals 명시, dissent_log는 R2 objections 중 미해소 전부).

- [ ] **Step 1: 실패하는 테스트** — 스텁이 역할별 고정 응답을 돌려줄 때: (a) standard(rounds 3, 로스터 4) → `calls` 중 `R1:` 라벨 4, `R2:` 4, synthesizer 1, `sign:` 4; `result` `validate('plan.v1')` ok, `rounds===3`, `roles` = 로스터 이름; (b) 서명에서 skeptic이 object → synthesizer 2회, 두 번째 서명 accept → dissent_log 변화 없음; (c) 두 번 다 object → synthesizer 2회, `dissent_log`에 `resolution: 'unresolved — proceeding'` 항목 추가; (d) docs tier(rounds 2, 로스터 2) → `R2:` 호출 0; (e) 한 역할이 R1에서 두 번 null → 그 역할 없이 진행(R1 결과 3개), 테스트는 호출 수 5(4+재spawn 1)를 단언; (f) `phases` = `['Load','Positions','Cross-examination','Synthesis','Sign-off']`(docs면 Cross-examination도 선언되지만 호출 없음 — meta는 고정).
- [ ] **Step 2~5**: 구현 → 통과 → 커밋 `feat(factory): plan debate workflow (R1/R2/R3/sign-off) and five plan role agents`.

---

### Task 4: implement — `factory-implement.js` + builder + verifier

**Files:**
- Create: `templates/factory/claude/workflows/factory-implement.js`, `templates/factory/claude/agents/factory-builder.md`, `templates/factory/claude/agents/factory-verifier.md`
- Test: `factory/test/workflows.test.js`(추가)

**Interfaces:**
- workflow: loader → `phase('Build')` builder(`agentType:'factory-builder'`, schema `BUILD = {head_sha(40hex), pr(number), branch, summary, tests_added[], commits[], rework_response?{responses[{id,status,commit?,reason?}]}}`) → `phase('Verify')` verifier(`agentType:'factory-verifier'`, schema `VERDICT = {verdict ∈ accepted|accepted-with-reservations|rejected, findings[{where, claim, evidence}], prove_test_read: boolean}`) → rejected면 `phase('Fix')` builder 1회(findings 제공) → verifier 재판정 → return `{ issue, head_sha, pr, verifier: {verdict, findings}, summary, tests_added, rework_response, orchestration:'workflow', guarantee:'structural' }`(마지막 builder의 head_sha). `head_sha`가 40hex가 아니면 builder를 1회 재spawn("head_sha must be `git rev-parse HEAD` after push").
- builder 프롬프트 골자(workflow 안 문자열): "Read `.factory/out/context.json` (issue, spec_path, handoffs.plan.done_when, harness.commands) and `.factory/lessons/factory-builder.md`. Branch `claude/fq-<issue>` from `origin/<default>` (create or check out; if `must_fix` exists this is a rework — respond to every item). TDD: write the `verify` tests named in done_when first (RED), implement (GREEN), run `[commands].lint/unit` (and full level if available) yourself. Commit in logical units, push, open a draft PR with `gh pr create --draft` titled `#<issue>: <summary>` whose body links the issue (`Closes #<issue>`). On rework, post the rework-response JSON as a PR comment (` ```json ` fence, schema factory.rework-response.v1) and include it in your output. Never modify existing tests (tests_are_load_bearing). Return head_sha = `git rev-parse HEAD`."
- verifier 프롬프트: "Cold read. Read only: `.factory/out/context.json` (issue, done_when), the diff `git diff origin/<default>...HEAD`, the new/changed test files, `.factory/lessons/factory-verifier.md`. Do NOT read the PR description, commit messages, or any builder notes. For each done_when: does a test named by `verify` exist, and would it fail if the change were reverted? (run `node .factory/bin/prove-test.js` and read its output — set prove_test_read=true). Reject if any done_when lacks a real test, an existing test was modified, or a skip/ignore pragma was added." (tools `Read, Grep, Glob, Bash`; 쓰기 금지 훅.)
- `.md` 둘: §7.2 구조. builder Lens(테스트 먼저·이름 규약·기존 테스트 불변·`files_expected` 밖으로 나가면 사유 기록·환경 명령은 harness에서·시크릿 금지), Examples(좋은: "test_123_bad_cursor RED 확인 후 구현", 나쁜: "테스트 통과를 위해 mock이 항상 3건 반환"). verifier Lens(§7.3 correctness의 5번 "테스트 정직성"을 확장: 단언이 구현을 복사하나, mock이 결과를 고정하나, prove-test FAIL 기대 PASS 관측, done_when ↔ 테스트 1:1).

- [ ] **Step 1: 실패하는 테스트** — (a) 해피: `calls` = loader, builder, verifier; result `validate('implement.v1')` ok(단, `gates`는 verify-stage가 채우므로 테스트는 `{...result, gates:{status:'GREEN'}}`로 검증); (b) verifier rejected → builder 2회, verifier 2회, 두 번째 accepted → `verifier.verdict==='accepted'`, `head_sha`는 두 번째 builder 값; (c) 두 번째도 rejected → return의 verdict `rejected`, 호출은 더 없음; (d) builder가 `head_sha:'abc'` → builder 재spawn 1회; (e) rework(loader `must_fix` 비어있지 않음) → builder 프롬프트에 must_fix 항목 id가 포함되고 `rework_response`가 return에 실린다; (f) phases.
- [ ] **Step 2~5**: 구현 → 통과 → 커밋 `feat(factory): implement workflow (builder → verifier, one fix round) and both agents`.

---

### Task 5: review — `factory-review.js` + 5개 reviewer

**Files:**
- Create: `templates/factory/claude/workflows/factory-review.js`, `templates/factory/claude/agents/reviewer-{correctness,security,architecture,spec-conformance,qa}.md`
- Test: `factory/test/workflows.test.js`(추가)

**Interfaces:**
- schemas: `VERDICT_V1`(verdict.v1 + `role`), `R2_FULL = {verdict ∈ maintain|revise, must_fix[], should_fix[], verified[], on_others[{id, stance ∈ agree|disagree, reason}]}`, `R2_LIGHT = {missed: [{what, why}]}`, `DISPUTE = {rulings: [{id, ruling ∈ withdraw|uphold, reason}]}`.
- 흐름: loader → `phase('R1')` 로스터 병렬 cold read(spec-conformance만 "plan handoff를 읽어라" 지시; 나머지는 "handoffs.plan을 읽지 말라"). loader `disputed`가 비어있지 않으면 R1 **전에** `phase('Disputes')`: 각 disputed 항목의 `id` 접두(`cf1`→correctness 등 — must_fix id는 리뷰어가 `<role-abbrev><n>`으로 짓는다: correctness `cf`, security `sec`, architecture `arch`, spec-conformance `spec`, qa `qa`)로 담당 리뷰어를 찾아 DISPUTE를 받고, `uphold`된 항목은 그 리뷰어의 R1 must_fix에 강제 포함(프롬프트로 지시 + return에서 병합). → `phase('R2')`: R1에 reject가 있으면 전원 R2_FULL(타 리뷰어 R1 제공) → 최종 verdict = `revise`면 R2의 must_fix로 교체, `maintain`이면 R1 유지; 만장일치 approve면 전원 R2_LIGHT(타 리뷰어 `verified[]`만 제공) → `missed` 있는 리뷰어만 R2_FULL로 승격. → return `{ issue, pr, head_sha, round: 0 /* run-stage가 셈 */, verdicts: [...최종], r1, disputes, orchestration:'workflow', guarantee:'structural', summary }`. `must_fix` 각 항목은 `{id, where, claim, evidence, repro?}`.
- 5개 `.md`: correctness = 스펙 §7.3 **verbatim**(훅 경로만 교체). security(Lens: 입력 신뢰 경계, 인증·인가 경로 변경, 시크릿·로그 노출, 의존성 추가, SSRF/injection/path traversal, `[load_bearing]` 경로), architecture(Lens: 모듈 경계·의존 방향이 TECHNICAL.md와 일치, 중복 로직, 공개 API 변경, 마이그레이션 되돌림, `files_expected` 초과의 정당성 — 단 범위 판단은 spec-conformance 몫), spec-conformance(cold_read=false; Lens: done_when ↔ 테스트 ↔ 구현 1:1, `files_expected` 밖 diff → reject, non_goals 침범, 기존 테스트 수정은 `must_approve_explicitly` 사유 필수, 증거(`[evidence].qa_artifacts`) 존재 확인), qa(tools에 `mcp__playwright__*`; Lens: 앱을 띄워 done_when을 사용자로서 재현, 스크린샷·로그를 `.factory/out/qa/`에, hold-out 시나리오 `.factory/scenarios/*.md` 있으면 실행, Design Intent 대조 §10). 각각 Examples 좋은/나쁜 ≥2, Perspectives ≥3.

- [ ] **Step 1: 실패하는 테스트** — (a) 만장일치 approve, missed 없음 → R1 4 + R2_LIGHT 4, verdicts 전부 approve, `validate('review.v1')` ok; (b) correctness reject → R1 4 + R2_FULL 4; architecture가 `revise`로 must_fix 추가 → 최종 verdicts에 반영, correctness `maintain` → R1 must_fix 유지; (c) 경량 R2에서 qa가 `missed` 1건 → qa만 R2_FULL 1회 추가 호출(총 R2 호출 5); (d) disputed `cf1` → Disputes 단계에서 correctness 1회, `uphold` → 최종 correctness verdict reject에 `cf1` 포함; `withdraw` → 포함 안 됨; (e) 한 리뷰어 두 번 null → verdicts 3개(verify-stage가 incomplete로 잡는다); (f) spec-conformance 프롬프트에만 "handoffs.plan" 지시가 있고 나머지엔 "do NOT read handoffs.plan"; (g) phases.
- [ ] **Step 2~5**: 구현 → 통과 → 커밋 `feat(factory): review workflow (cold R1, exchange R2, disputes) and five reviewer agents`.

---

### Task 6: 템플릿 전수 lint + `doctor checkAgents` + handoff 렌더링

**Files:**
- Modify: `factory/test/agent-md.test.js`(14개 템플릿 전수), `factory/lib/doctor/factory.js`(`checkAgents`), `factory/cli/doctor.js`(배선), `factory/lib/handoff.js`(`renderHandoff` 스테이지별 본문), `factory/test/handoff.test.js`, `factory/test/doctor-factory.test.js`, `factory/test/templates.test.js`(workflows 4개 존재·`meta.name === 파일명`·`factory-merge.js` 없음)
- 참고: `factory/cli/manifest.js`는 `templates/factory/claude/**`를 자동 포함(`.claude/workflows/*.js`, `.claude/agents/*.md`) — 확인만.

**Interfaces:**
- `checkAgents({ roles, root, readFile, exists }) → Check[]`: roles.toml의 모든 agent 경로에 대해 `lintAgentMd(readFile(path), {expectedName: basename})` → 위반이 있으면 `agents.<name>` FAIL(위반 목록), 없으면 PASS; 파일 없음은 `roles.agent-files`가 이미 다루므로 건너뜀. `doctorCommand` factory 스코프에 추가.
- `renderHandoff({stage, issue, summary, data})`: 기존 마커+JSON 펜스는 유지하고, 사람용 본문을 스테이지별로: plan → `**done_when**` 번호 목록(`id · text · verify@level`), `**dissent**` 목록, `**토론**`(debate.r1 역할별 position 첫 문장, R2 objections 수, votes 요약); implement → PR 링크(`#<pr>`), `verifier: <verdict>`(findings 수), tests_added; review → 역할별 표 `| role | verdict | confidence | must_fix |`; triage → disposition/tier/questions. `summary`가 있으면 맨 위.

- [ ] **Step 1: 실패하는 테스트** — 14개 템플릿 lint 위반 0; `checkAgents`가 섹션 누락 파일을 FAIL로; `renderHandoff` 각 스테이지 스냅샷(문자열 포함 단언 — 표 헤더, done_when 줄, PR 번호), 그리고 `parseHandoffs(renderHandoff(...))`가 원본 data를 되돌린다(라운드트립).
- [ ] **Step 2~5**: 구현 → 통과 → 커밋 `feat(factory): agent template lint in doctor; stage-specific handoff rendering`.

---

### Task 7: 문서 동기화 — ADR-016 + 스펙

**Files:**
- Modify: `docs/factory/DECISIONS.md`(ADR-016), `docs/superpowers/specs/2026-09-10-factory-design.md`(§4.2.3 loader 확정 문장, §7.2 doctor 검사 = `lintAgentMd` 규칙, §7.5 P3-R2/R3/R4/R5 반영 — 라운드 코멘트 3개 → handoff 본문 통합, must_fix id 접두 규약, 서명 재실행 1회, implement 수정 1회, null 재spawn), `README.md`(에이전트·워크플로 파일 목록 1줄)

- [ ] **Step 1**: ADR-016 "Plan 3 판결 — loader·리뷰 프로토콜 세부·must_fix id 규약·implement 수정 1회" 작성(질문/관측/결정/영향). **Step 2**: 스펙 편집(각 자리에 `(Plan 3 실행 판결, ADR-016)`). **Step 3**: `npm test` 전체 GREEN, `node bin/cli.js factory init`을 임시 repo에 돌려 `.claude/workflows/*.js` 4개·`.claude/agents/*.md` 14개가 설치되는지 확인(결과를 리포트에). **Step 4**: 커밋 `docs(factory): ADR-016 and spec sync for Plan 3`.

---

## Self-Review

**Spec coverage.** §4.2.2 디스패처(Plan 2) ↔ §4.2.3 loader(Task 2) ↔ §4.2.4 orchestration 고정값(각 return) ✓. §7.1 레지스트리 → agent 파일 13개(Task 2–5) + loader ✓. §7.2 구조·doctor 검사(Task 1·6) ✓. §7.3 예시 verbatim(Task 5) ✓. §7.4 lessons(Plan 2 골격 유지; Lessons 섹션이 경로를 가리킨다) ✓. §7.5 plan 3라운드+서명(Task 3), review R1/R2/disputes/rework-response(Task 4·5) ✓. §5.2.2 builder TDD·verifier prove-test(Task 4) ✓. §5.2.7 hold-out은 qa Lens에 "있으면 실행"으로만(1.0 필수 아님) ✓. 갭: `.factory/scenarios/` Read 거부 훅(§5.2.7, 선택) — 이월; retro(Plan 4).

**Placeholder scan.** Task 2–5의 프롬프트 골자와 Lens 항목은 문장으로 고정했고 스키마는 리터럴로 적었다. 에이전트 `.md`의 Examples/Perspectives 본문은 구현자가 Lens에서 도출해 쓴다 — "≥2/≥2/≥3"과 형식은 린터가 강제한다.

**Type consistency.** `LOADER`(Task 2) ↔ Task 3·4·5의 `roster[].agentType/model` 사용; `VERDICT_V1`(Task 5) ↔ `schemas.js verdict.v1`; implement return ↔ `implement.v1`(gates는 verify-stage가 채움 — 테스트에서 명시); `renderHandoff` 입력 = 각 workflow return(Task 6) ✓.
