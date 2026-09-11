# Factory Plan 0 — Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설계 스펙 §12.1의 spike 7개를 실제 GitHub Actions 러너에서 실행해 사실을 확정하고, 그 결과를 ADR로 남겨 Plan 1~3의 미결 설계(orchestration 모드, 훅 적용 범위, 건너뛰기 차단 방식)를 닫는다.

**Architecture:** 별도의 일회용 데모 저장소(`know-thy-build-demo`, private)에 최소 Node 프로젝트를 만들고, spike마다 GitHub Actions 워크플로 하나 + 결과를 아티팩트/로그로 남기는 스크립트를 둔다. 각 spike는 "질문 → 실험 코드 → 관측 → ADR 한 줄"로 끝난다. 여기서 만든 코드는 전부 throwaway이며 know-thy-build 본체에 들어가지 않는다. 결정만 `know_thy_build/docs/factory/DECISIONS.md`에 커밋한다.

**Tech Stack:** GitHub Actions (ubuntu-latest), Node 22, `@anthropic-ai/claude-code` CLI (`-p` 모드, 저장 Workflow, 커맨드 frontmatter), `gh` CLI, docker compose, playwright, vitest, jq.

**Spec:** `docs/superpowers/specs/2026-09-10-factory-design.md` — §4.2 (제어 계층), §4.4 (인증), §4.5 (러너 환경), §12.1 (spike 목록)

## Global Constraints

- Node **22 이상** (Claude Code v2.1.198+ 요구). 워크플로에 `actions/setup-node@v4` + `node-version: 22`.
- 인증은 구독 토큰 `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`, 1년 유효). 데모 repo secret으로 등록.
- 러너에 Claude Code 없음 → 잡마다 `npm i -g @anthropic-ai/claude-code`.
- `--bare` 절대 사용 금지 (훅·스킬·에이전트·CLAUDE.md가 꺼짐).
- 실제 외부 서비스 호출 없음. 데모 앱은 localhost만.
- spike 코드는 throwaway. 본체 repo(`know_thy_build`)에는 `docs/factory/DECISIONS.md`만 커밋.
- 모든 spike 워크플로는 `workflow_dispatch`로 수동 실행 (이벤트 트리거는 Plan 2에서).
- 모든 잡에 `timeout-minutes` 명시 (기본 20).

---

## File Structure (데모 repo `know-thy-build-demo`)

```
know-thy-build-demo/
├── package.json                      # vitest 스모크 + express 헬스 앱
├── src/app.js                        # GET /healthz → 200 (spike 4)
├── test/smoke.test.js                # expect(true)
├── e2e/smoke.spec.js                 # playwright: /healthz 200
├── playwright.config.js
├── docker-compose.test.yml           # postgres:16 (spike 4)
├── CLAUDE.md                         # "spike repo" 한 줄 (CLAUDE.md 주입 확인용 마커 포함)
├── .claude/
│   ├── settings.json                 # hooks: PreToolUse/SubagentStart/SubagentStop 로거, permissions.allow
│   ├── hooks/log-hook.sh             # stdin JSON → .spike/hooks.log 한 줄 append
│   ├── commands/
│   │   ├── spike-dispatch.md         # allowed-tools: Workflow(spike-basic) 디스패처 (spike 2, 6)
│   │   └── spike-restricted.md       # allowed-tools: Workflow(spike-hooks) — 서브에이전트가 Bash 쓰는지 (spike 6)
│   ├── agents/
│   │   └── spike-worker.md           # tools: Bash, Read, Write — 파일 하나 쓰고 Bash 한 번 실행
│   └── workflows/
│       ├── spike-basic.js            # agent 2개 parallel, schema, 결과 return (spike 2)
│       ├── spike-hooks.js            # agentType: spike-worker 로 Bash 실행 (spike 1, 6)
│       ├── spike-schema.js           # agent 20개 schema 강제, null 수 집계 (spike 3)
│       └── spike-idle.js             # agent 1개가 Bash sleep 720 (spike 7)
├── .spike/                           # 실행 중 생성. 아티팩트로 업로드
└── .github/workflows/
    ├── spike-2-p-workflow.yml
    ├── spike-1-hooks.yml
    ├── spike-6-allowed-tools.yml
    ├── spike-3-schema.yml
    ├── spike-4-resources.yml
    ├── spike-7-idle.yml
    └── spike-5-usage.yml             # 사용량 실측은 수동 관찰 + 기록 템플릿
```

본체 repo에 추가되는 파일:
```
know_thy_build/docs/factory/DECISIONS.md   # ADR-001 ~ ADR-007
```

---

### Task 1: 데모 저장소와 최소 프로젝트

**Files:**
- Create: `~/workspace/know-thy-build-demo/package.json`
- Create: `~/workspace/know-thy-build-demo/src/app.js`
- Create: `~/workspace/know-thy-build-demo/test/smoke.test.js`
- Create: `~/workspace/know-thy-build-demo/CLAUDE.md`
- Create: `~/workspace/know-thy-build-demo/.gitignore`

**Interfaces:**
- Produces: GitHub private repo `LeeHyeonKyu/know-thy-build-demo`, `npm test` GREEN, `node src/app.js`가 `:3000/healthz`에 200. 이후 모든 Task가 이 repo에서 작업한다.

- [ ] **Step 1: 저장소 생성**

```bash
mkdir -p ~/workspace/know-thy-build-demo && cd ~/workspace/know-thy-build-demo
git init -b main
gh repo create LeeHyeonKyu/know-thy-build-demo --private --source=. --remote=origin
```

- [ ] **Step 2: package.json 작성**

```json
{
  "name": "know-thy-build-demo",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "start": "node src/app.js",
    "e2e": "playwright test"
  },
  "devDependencies": {
    "vitest": "^3.2.0",
    "@playwright/test": "^1.55.0"
  },
  "dependencies": {
    "express": "^5.1.0"
  }
}
```

- [ ] **Step 3: 앱과 스모크 테스트**

`src/app.js`:
```js
import express from "express";
const app = express();
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
const port = process.env.PORT ?? 3000;
app.listen(port, () => console.log(`listening on ${port}`));
```

`test/smoke.test.js`:
```js
import { test, expect } from "vitest";
test("smoke", () => { expect(true).toBe(true); });
```

`CLAUDE.md`:
```markdown
# know-thy-build-demo
This is a throwaway spike repository. MARKER_CLAUDE_MD_LOADED=yes
```

`.gitignore`:
```
node_modules/
.spike/
test-results/
```

- [ ] **Step 4: 로컬에서 GREEN 확인**

Run: `npm install && npm test`
Expected: `1 passed`

Run: `node src/app.js & sleep 1 && curl -s localhost:3000/healthz; kill %1`
Expected: `{"ok":true}`

- [ ] **Step 5: 커밋·push**

```bash
git add -A && git commit -m "chore: minimal spike project" && git push -u origin main
```

---

### Task 2: 인증 시크릿과 공통 워크플로 조각

**Files:**
- Create: `.github/workflows/_setup.yml` 없음 — GitHub은 재사용 워크플로 대신 composite action을 씀
- Create: `.github/actions/setup-claude/action.yml`

**Interfaces:**
- Produces: composite action `./.github/actions/setup-claude` — Node 22 + Claude Code 설치. 모든 spike yml이 `uses: ./.github/actions/setup-claude`로 사용.
- 시크릿 `CLAUDE_CODE_OAUTH_TOKEN` 등록됨.

- [ ] **Step 1: 구독 토큰 발급 (사람이 직접, 대화형)**

터미널에서 `! claude setup-token`을 실행하면 브라우저 로그인 후 토큰이 출력된다. 출력된 토큰을 복사한다. (토큰은 채팅에 붙여넣지 말 것.)

- [ ] **Step 2: 시크릿 등록**

```bash
cd ~/workspace/know-thy-build-demo
gh secret set CLAUDE_CODE_OAUTH_TOKEN   # 프롬프트에 토큰 붙여넣기
gh secret list
```
Expected: `CLAUDE_CODE_OAUTH_TOKEN` 한 줄.

- [ ] **Step 3: composite action 작성**

`.github/actions/setup-claude/action.yml`:
```yaml
name: setup-claude
description: Node 22 + Claude Code CLI
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: 22
    - shell: bash
      run: |
        npm i -g @anthropic-ai/claude-code
        claude --version
        npm ci
```

- [ ] **Step 4: 인증 스모크 워크플로**

`.github/workflows/spike-0-auth.yml`:
```yaml
name: spike-0-auth
on: workflow_dispatch
jobs:
  auth:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-claude
      - name: claude -p hello
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          claude -p "Reply with exactly: PONG" --output-format json > out.json
          cat out.json
          jq -e '.result | test("PONG")' out.json
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: spike-0, path: out.json }
```

- [ ] **Step 5: 실행·확인**

```bash
git add -A && git commit -m "spike-0: auth smoke" && git push
gh workflow run spike-0-auth.yml && sleep 90 && gh run list --workflow=spike-0-auth.yml --limit 1
gh run view --log $(gh run list --workflow=spike-0-auth.yml --limit 1 --json databaseId -q '.[0].databaseId') | grep -E "PONG|claude-code|error" | head
```
Expected: 잡 success, 로그에 `PONG`. 실패면 토큰·Node 버전부터 확인.

---

### Task 3: Spike 2 — `-p`에서 저장 Workflow 실행 + 디스패처 커맨드

**질문:** `claude -p "/spike-dispatch 1"`이 커맨드 파일을 확장해 저장된 Workflow `spike-basic`을 호출하고, agent 2개를 병렬로 돌린 결과가 stdout JSON `result`에 들어오는가? `--permission-mode dontAsk`에서 `Workflow(spike-basic)` allow 규칙으로 충분한가?

**Files:**
- Create: `.claude/settings.json`
- Create: `.claude/commands/spike-dispatch.md`
- Create: `.claude/workflows/spike-basic.js`
- Create: `.github/workflows/spike-2-p-workflow.yml`

**Interfaces:**
- Produces: `spike-basic` workflow — `return { agents: [{label, answer}], marker }`. Task 6(spike 6)이 같은 디스패처 패턴을 재사용.

- [ ] **Step 1: settings.json (허용 규칙만, 훅은 Task 4에서 추가)**

```json
{
  "permissions": {
    "allow": [
      "Workflow(spike-basic)",
      "Workflow(spike-hooks)",
      "Workflow(spike-schema)",
      "Workflow(spike-idle)",
      "Bash(*)",
      "Read(*)",
      "Write(*)"
    ]
  }
}
```

- [ ] **Step 2: 디스패처 커맨드**

`.claude/commands/spike-dispatch.md`:
```markdown
---
description: spike dispatcher
allowed-tools: Workflow(spike-basic)
---
You are a dispatcher. Do exactly one thing: call the Workflow tool with name `spike-basic` and args `{ "n": $ARGUMENTS }`. Return the workflow's result verbatim as your final message, as JSON. Do not read files, run commands, or add commentary.
```

- [ ] **Step 3: workflow 스크립트**

`.claude/workflows/spike-basic.js`:
```js
export const meta = {
  name: 'spike-basic',
  description: 'Two parallel agents with schema; proves -p can run a saved workflow',
  phases: [{ title: 'Answer' }],
}

const ANSWER = {
  type: 'object',
  required: ['answer', 'claude_md_marker'],
  properties: {
    answer: { type: 'string' },
    claude_md_marker: { type: 'string', description: 'value of MARKER_CLAUDE_MD_LOADED from CLAUDE.md, or "absent"' },
  },
}

phase('Answer')
const results = await parallel([
  () => agent(`Reply with answer "alpha-${args.n}". Also report the MARKER_CLAUDE_MD_LOADED value if you see it in your context.`, { label: 'a', schema: ANSWER }),
  () => agent(`Reply with answer "beta-${args.n}". Also report the MARKER_CLAUDE_MD_LOADED value if you see it in your context.`, { label: 'b', schema: ANSWER }),
])

return { marker: 'SPIKE_BASIC_OK', n: args.n, agents: results }
```

- [ ] **Step 4: 워크플로 yml**

`.github/workflows/spike-2-p-workflow.yml`:
```yaml
name: spike-2-p-workflow
on: workflow_dispatch
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-claude
      - name: dispatch
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0"
        run: |
          mkdir -p .spike
          start=$(date +%s)
          claude -p "/spike-dispatch 7" \
            --permission-mode dontAsk --max-turns 5 \
            --output-format json > .spike/out.json || echo "exit=$?" > .spike/exit
          echo "elapsed=$(( $(date +%s) - start ))s" | tee .spike/elapsed
          cat .spike/out.json
      - name: assert
        run: |
          jq -e '.result | test("SPIKE_BASIC_OK")' .spike/out.json
          jq -e '.result | test("alpha-7") and test("beta-7")' .spike/out.json
          jq '.num_turns, .total_cost_usd, .usage' .spike/out.json
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: spike-2, path: .spike/ }
```

- [ ] **Step 5: 실행·관측**

```bash
git add -A && git commit -m "spike-2: -p runs saved workflow via dispatcher" && git push
gh workflow run spike-2-p-workflow.yml
```
90초 뒤 `gh run watch` 또는 `gh run view --log`. 기록할 것:
- assert 통과 여부
- `num_turns` (디스패처가 몇 턴 썼나 — 5 이하여야 함)
- `elapsed`
- 두 agent의 `claude_md_marker` — 서브에이전트에 CLAUDE.md가 주입되는지
- 실패 시 원인: 권한 거부(→ allow 규칙 형식), 커맨드 미확장(→ `/name` 문법), Workflow 미완료(→ idle ceiling)

- [ ] **Step 6: ADR-002 초안을 `.spike/adr-002.md`에 기록** (본체 커밋은 Task 10)

```markdown
# ADR-002 `-p`에서 저장 Workflow 실행
- 결과: PASS|FAIL
- 디스패처 턴 수: N · 소요: Ns · 비용: $N
- 서브에이전트 CLAUDE.md 주입: yes|no
- 필요한 권한 규칙: `Workflow(spike-basic)` (dontAsk에서 충분|불충분 — 대안: ...)
- 결정: orchestration 기본값 workflow 유지 | agent로 후퇴 (사유)
```

---

### Task 4: Spike 1 — settings.json 훅이 Workflow `agent()` 서브에이전트에 적용되는가

**질문:** `PreToolUse`·`SubagentStart`·`SubagentStop` 훅이 (a) 메인 세션 (b) Workflow가 spawn한 서브에이전트의 Bash 호출에 발화하는가? 훅 stdin JSON에 서브에이전트를 식별할 필드가 있는가?

**Files:**
- Create: `.claude/hooks/log-hook.sh`
- Modify: `.claude/settings.json` (hooks 추가)
- Create: `.claude/agents/spike-worker.md`
- Create: `.claude/workflows/spike-hooks.js`
- Create: `.claude/commands/spike-hooks-dispatch.md`
- Create: `.github/workflows/spike-1-hooks.yml`

**Interfaces:**
- Produces: `.spike/hooks.log` — 한 줄에 하나의 훅 발화. 형식: `<event>\t<tool>\t<keys>` . Task 6이 같은 로그를 읽는다.

- [ ] **Step 1: 훅 스크립트 (stdin JSON을 읽는다 — `$TOOL_INPUT` 아님)**

`.claude/hooks/log-hook.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
input=$(cat)
mkdir -p "${CLAUDE_PROJECT_DIR:-.}/.spike"
printf '%s\t%s\t%s\t%s\n' \
  "$(jq -r '.hook_event_name // "?"' <<<"$input")" \
  "$(jq -r '.tool_name // "-"' <<<"$input")" \
  "$(jq -r '(.tool_input.command // .tool_input.file_path // "-") | tostring | .[0:60]' <<<"$input")" \
  "$(jq -c 'keys' <<<"$input")" \
  >> "${CLAUDE_PROJECT_DIR:-.}/.spike/hooks.log"
exit 0
```
`chmod +x .claude/hooks/log-hook.sh`

- [ ] **Step 2: settings.json에 훅 추가**

```json
{
  "permissions": {
    "allow": ["Workflow(spike-basic)", "Workflow(spike-hooks)", "Workflow(spike-schema)", "Workflow(spike-idle)", "Bash(*)", "Read(*)", "Write(*)"]
  },
  "hooks": {
    "PreToolUse":   [{ "matcher": "Bash|Write|Read", "hooks": [{ "type": "command", "command": ".claude/hooks/log-hook.sh" }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": ".claude/hooks/log-hook.sh" }] }],
    "SubagentStop":  [{ "hooks": [{ "type": "command", "command": ".claude/hooks/log-hook.sh" }] }],
    "Stop":          [{ "hooks": [{ "type": "command", "command": ".claude/hooks/log-hook.sh" }] }]
  }
}
```

- [ ] **Step 3: 워커 에이전트 정의**

`.claude/agents/spike-worker.md`:
```markdown
---
name: spike-worker
description: writes one file and runs one bash command, then reports
tools: Bash, Read, Write
model: sonnet
---
Do exactly these three things, in order:
1. Write the file `.spike/worker-<n>.txt` containing the single line `worker <n> was here` where <n> is the number in your prompt.
2. Run the bash command `echo SPIKE_WORKER_BASH_<n>` .
3. Reply with the JSON `{"n": <n>, "done": true}`.
```

- [ ] **Step 4: workflow와 디스패처**

`.claude/workflows/spike-hooks.js`:
```js
export const meta = {
  name: 'spike-hooks',
  description: 'Spawn spike-worker agents that use Bash/Write; used to observe hook firing inside workflow agents',
  phases: [{ title: 'Work' }],
}
const OUT = { type: 'object', required: ['n', 'done'], properties: { n: { type: 'number' }, done: { type: 'boolean' } } }
phase('Work')
const r = await parallel([
  () => agent('Your number is 1.', { agentType: 'spike-worker', label: 'w1', schema: OUT }),
  () => agent('Your number is 2.', { agentType: 'spike-worker', label: 'w2', schema: OUT }),
])
return { marker: 'SPIKE_HOOKS_OK', workers: r }
```

`.claude/commands/spike-hooks-dispatch.md`:
```markdown
---
description: spike hooks dispatcher
allowed-tools: Workflow(spike-hooks)
---
Call the Workflow tool with name `spike-hooks` and args `{}`. Return its result verbatim as JSON. Do nothing else.
```

- [ ] **Step 5: 워크플로 yml**

`.github/workflows/spike-1-hooks.yml`:
```yaml
name: spike-1-hooks
on: workflow_dispatch
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-claude
      - name: dispatch
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0"
          CLAUDE_PROJECT_DIR: ${{ github.workspace }}
        run: |
          mkdir -p .spike
          claude -p "/spike-hooks-dispatch" --permission-mode dontAsk --max-turns 5 --output-format json > .spike/out.json || true
          echo "--- hooks.log ---"; cat .spike/hooks.log || echo "(no hooks.log)"
          echo "--- worker files ---"; ls .spike/
      - name: assert
        run: |
          jq -e '.result | test("SPIKE_HOOKS_OK")' .spike/out.json
          test -f .spike/worker-1.txt && test -f .spike/worker-2.txt
          echo "PreToolUse Bash lines: $(grep -c $'^PreToolUse\tBash' .spike/hooks.log || true)"
          echo "SubagentStart lines:   $(grep -c '^SubagentStart' .spike/hooks.log || true)"
          echo "SubagentStop lines:    $(grep -c '^SubagentStop' .spike/hooks.log || true)"
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: spike-1, path: .spike/ }
```

- [ ] **Step 6: 실행·관측**

```bash
git add -A && git commit -m "spike-1: hooks inside workflow agents" && git push
gh workflow run spike-1-hooks.yml
```
기록할 것:
- `PreToolUse Bash` 라인 수 ≥ 2 이면 **서브에이전트 Bash에 훅 적용됨** (워커 2명이 각 1회). 0이면 미적용.
- `SubagentStart/Stop` 발화 여부와 그 라인의 `keys` — `agent_id`·`agent_type` 같은 식별 필드가 있는지 (Task 6의 판단 재료).
- Stop 훅이 메인 세션 종료 시 발화하는지.

- [ ] **Step 7: ADR-001 초안 `.spike/adr-001.md`**

```markdown
# ADR-001 settings.json 훅의 Workflow 서브에이전트 적용
- PreToolUse(Bash) in workflow agents: yes|no (라인 수 N)
- SubagentStart/Stop: yes|no · 식별 필드: [...]
- 결정: L2 훅을 settings.json에 둔다 | 에이전트 frontmatter hooks + verify-stage 사후 검증으로 대체
```

---

### Task 5: Spike 3 — StructuredOutput schema 신뢰도

**질문:** `agent(..., {schema})` 20회 중 `null`(5회 재시도 실패)이 몇 번 나오는가? 복잡한 schema(중첩 배열·enum)에서 차이가 있는가?

**Files:**
- Create: `.claude/workflows/spike-schema.js`
- Create: `.claude/commands/spike-schema-dispatch.md`
- Create: `.github/workflows/spike-3-schema.yml`

- [ ] **Step 1: 스펙의 verdict.v1과 같은 복잡도의 schema로 20회**

`.claude/workflows/spike-schema.js`:
```js
export const meta = {
  name: 'spike-schema',
  description: 'Measure StructuredOutput reliability: 20 agents with a verdict-like schema',
  phases: [{ title: 'Verdicts' }],
}
const VERDICT = {
  type: 'object',
  required: ['verdict', 'confidence', 'must_fix', 'verified'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['approve', 'reject'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    must_fix: {
      type: 'array',
      items: {
        type: 'object', required: ['id', 'where', 'claim', 'evidence'], additionalProperties: false,
        properties: { id: { type: 'string' }, where: { type: 'string' }, claim: { type: 'string' }, evidence: { type: 'string' } },
      },
    },
    verified: { type: 'array', items: { type: 'string' } },
  },
}
const SNIPPET = `
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
export function isWeekend(d) { return [0, 6].includes(new Date(d).getDay()); }
`
phase('Verdicts')
const items = Array.from({ length: 20 }, (_, i) => i)
const out = await pipeline(items, i =>
  agent(`You are a correctness reviewer. Review this snippet and produce a verdict. Case ${i}.\n${SNIPPET}\nIf you find a timezone issue, reject with one must_fix item; otherwise approve.`, { label: `v${i}`, schema: VERDICT, model: i % 2 ? 'sonnet' : 'opus' }))
const nulls = out.filter(x => x === null).length
return { marker: 'SPIKE_SCHEMA_OK', total: 20, nulls, rejects: out.filter(x => x && x.verdict === 'reject').length, sample: out[0] }
```

`.claude/commands/spike-schema-dispatch.md`:
```markdown
---
description: spike schema dispatcher
allowed-tools: Workflow(spike-schema)
---
Call the Workflow tool with name `spike-schema` and args `{}`. Return its result verbatim as JSON. Do nothing else.
```

- [ ] **Step 2: yml**

`.github/workflows/spike-3-schema.yml`:
```yaml
name: spike-3-schema
on: workflow_dispatch
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-claude
      - name: dispatch
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0"
        run: |
          mkdir -p .spike
          claude -p "/spike-schema-dispatch" --permission-mode dontAsk --max-turns 5 --output-format json > .spike/out.json || true
          jq '.result' .spike/out.json
          jq '.total_cost_usd, .usage' .spike/out.json
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: spike-3, path: .spike/ }
```

- [ ] **Step 3: 실행·관측·ADR-003 초안**

```bash
git add -A && git commit -m "spike-3: schema reliability" && git push
gh workflow run spike-3-schema.yml
```
기록: `nulls/20`, 모델별 차이(짝수 opus/홀수 sonnet — 결과에서 label로 구분하려면 sample 대신 전체 out을 return하도록 바꿔 재실행), 20 agent 비용.

```markdown
# ADR-003 schema 신뢰도
- nulls: N/20 (opus N, sonnet N) · 비용 $N
- 결정: null 시 해당 리뷰어 1회 재spawn (스펙 §7.5) 유지 | 재시도 상향 | 모델 고정
```

---

### Task 6: Spike 6 — 커맨드 `allowed-tools`가 메인 세션만 제한하는가

**질문:** `allowed-tools: Workflow(spike-hooks)`인 커맨드로 시작한 메인 세션이 (a) Bash를 직접 호출하면 거부되고 (b) workflow 안 `spike-worker`(frontmatter `tools: Bash, Read, Write`)는 Bash를 쓸 수 있는가?

**Files:**
- Create: `.claude/commands/spike-restricted.md`
- Create: `.github/workflows/spike-6-allowed-tools.yml`

- [ ] **Step 1: 메인 세션이 규칙을 어기도록 유도하는 커맨드**

`.claude/commands/spike-restricted.md`:
```markdown
---
description: restricted dispatcher that is tempted to use Bash
allowed-tools: Workflow(spike-hooks)
---
First, try to run the bash command `echo MAIN_SESSION_BASH_RAN` and note whether it succeeded or was denied.
Then call the Workflow tool with name `spike-hooks` and args `{}`.
Return JSON: {"main_bash": "ran"|"denied", "workflow": <workflow result>}.
```

- [ ] **Step 2: yml — 메인 세션의 Bash는 hooks.log에 `MAIN_SESSION_BASH_RAN`으로, 워커의 Bash는 `SPIKE_WORKER_BASH_`로 구분된다**

`.github/workflows/spike-6-allowed-tools.yml`:
```yaml
name: spike-6-allowed-tools
on: workflow_dispatch
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-claude
      - name: dispatch
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0"
          CLAUDE_PROJECT_DIR: ${{ github.workspace }}
        run: |
          mkdir -p .spike
          claude -p "/spike-restricted" --permission-mode dontAsk --max-turns 8 --output-format json > .spike/out.json || true
          jq '.result' .spike/out.json
          echo "--- hooks.log ---"; cat .spike/hooks.log || true
      - name: observe
        run: |
          echo "main bash attempted (hook saw it): $(grep -c 'MAIN_SESSION_BASH_RAN' .spike/hooks.log || true)"
          echo "worker bash ran (files):            $(ls .spike/worker-*.txt 2>/dev/null | wc -l)"
          echo "worker bash hook lines:             $(grep -c 'SPIKE_WORKER_BASH' .spike/hooks.log || true)"
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: spike-6, path: .spike/ }
```

- [ ] **Step 3: 실행·관측·ADR-006 초안**

```bash
git add -A && git commit -m "spike-6: allowed-tools scope" && git push
gh workflow run spike-6-allowed-tools.yml
```
해석표:

| main_bash | worker 파일 2개 | 결론 |
|---|---|---|
| denied | 있음 | **최선** — 메인 세션만 제한. 건너뛰기 불가능 |
| denied | 없음 | allowed-tools가 서브에이전트까지 제한. 커맨드 제한 대신 `verify-stage.sh` 사후 검증 |
| ran | 있음 | allowed-tools가 무력(권한 모드 우선?). `--allowedTools` 플래그로 재실험 후 결정 |

```markdown
# ADR-006 메인 세션 도구 제한
- main Bash: ran|denied · worker Bash: ran|denied
- 결정: 커맨드 allowed-tools로 메인 세션 잠금 | verify-stage 사후 검증만
```

---

### Task 7: Spike 7 — idle ceiling의 의미

**질문:** 서브에이전트가 `sleep 720`(12분) 동안 아무 출력 없이 조용할 때, 기본 설정에서 `claude -p`가 workflow 결과 없이 종료하는가? `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`이면 끝까지 기다리는가?

**Files:**
- Create: `.claude/workflows/spike-idle.js`
- Create: `.claude/commands/spike-idle-dispatch.md`
- Create: `.github/workflows/spike-7-idle.yml`

- [ ] **Step 1: 12분 조용한 workflow**

`.claude/workflows/spike-idle.js`:
```js
export const meta = { name: 'spike-idle', description: 'One agent sleeps 12 minutes silently', phases: [{ title: 'Sleep' }] }
phase('Sleep')
const r = await agent('Run exactly this bash command and nothing else, then reply "SLEPT": sleep 720', { label: 'sleeper', model: 'sonnet' })
return { marker: 'SPIKE_IDLE_OK', r }
```

`.claude/commands/spike-idle-dispatch.md`:
```markdown
---
description: spike idle dispatcher
allowed-tools: Workflow(spike-idle)
---
Call the Workflow tool with name `spike-idle` and args `{}`. Return its result verbatim. Do nothing else.
```

- [ ] **Step 2: yml — 두 잡을 매트릭스로 (기본 ceiling / 0)**

`.github/workflows/spike-7-idle.yml`:
```yaml
name: spike-7-idle
on: workflow_dispatch
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    strategy:
      fail-fast: false
      matrix:
        ceiling: ["default", "0"]
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-claude
      - name: dispatch
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          mkdir -p .spike
          if [ "${{ matrix.ceiling }}" != "default" ]; then export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=${{ matrix.ceiling }}; fi
          start=$(date +%s)
          claude -p "/spike-idle-dispatch" --permission-mode dontAsk --max-turns 5 --output-format json > .spike/out.json; echo "exit=$?" > .spike/exit
          echo "elapsed=$(( $(date +%s) - start ))s" | tee .spike/elapsed
          cat .spike/exit; jq '.result' .spike/out.json || true
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: spike-7-${{ matrix.ceiling }}, path: .spike/ }
```

- [ ] **Step 3: 실행·관측·ADR-007 초안**

```bash
git add -A && git commit -m "spike-7: idle ceiling" && git push
gh workflow run spike-7-idle.yml
```
기록: 매트릭스별 `elapsed`, exit code, `result`에 `SPIKE_IDLE_OK` 유무.
- default에서 ~10분에 종료 + result 없음 → "idle = 무활동 시간"이고 상한이 실재. `0`에서 ~12분 후 OK → 0이 무제한.
- default에서도 OK → ceiling이 이 경로에 적용되지 않음(그래도 0 유지).

```markdown
# ADR-007 idle ceiling
- default: elapsed Ns, exit N, result yes|no · 0: elapsed Ns, exit N, result yes|no
- 결정: CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 고정, 상한은 timeout-minutes
```

---

### Task 8: Spike 4 — 러너 자원: compose + 앱 + playwright 동시 실행

**질문:** 표준 러너에서 postgres compose + express 앱 + playwright chromium이 함께 돌 때 `full`(unit+integration)과 `deep`(+e2e) 소요 시간과 메모리 여유는?

**Files:**
- Create: `docker-compose.test.yml`
- Create: `test/integration/db.test.js`
- Create: `e2e/smoke.spec.js`, `playwright.config.js`
- Create: `.github/workflows/spike-4-resources.yml`

- [ ] **Step 1: compose와 통합 테스트**

`docker-compose.test.yml`:
```yaml
services:
  db:
    image: postgres:16-alpine
    environment: { POSTGRES_PASSWORD: test, POSTGRES_DB: demo }
    ports: ["5432:5432"]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"], interval: 2s, retries: 15 }
```

`test/integration/db.test.js`:
```js
import { test, expect } from "vitest";
import { execSync } from "node:child_process";
test("postgres reachable via docker", () => {
  const out = execSync(`docker compose -f docker-compose.test.yml exec -T db psql -U postgres -d demo -tAc "select 1"`).toString().trim();
  expect(out).toBe("1");
});
```

- [ ] **Step 2: playwright**

`playwright.config.js`:
```js
export default {
  testDir: "e2e",
  use: { baseURL: "http://localhost:3000", headless: true },
  webServer: { command: "node src/app.js", url: "http://localhost:3000/healthz", timeout: 30_000 },
  reporter: [["json", { outputFile: ".spike/e2e.json" }]],
};
```

`e2e/smoke.spec.js`:
```js
import { test, expect } from "@playwright/test";
test("healthz", async ({ request }) => {
  const r = await request.get("/healthz");
  expect(r.status()).toBe(200);
});
test("browser loads", async ({ page }) => {
  await page.goto("/healthz");
  await expect(page.locator("body")).toContainText("ok");
});
```

- [ ] **Step 3: yml — 단계별 시간과 free -m 기록. 그리고 같은 러너에서 claude -p가 playwright MCP로 페이지를 여는지**

`.github/workflows/spike-4-resources.yml`:
```yaml
name: spike-4-resources
on: workflow_dispatch
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-claude
      - name: env up
        run: |
          mkdir -p .spike
          t0=$(date +%s)
          docker compose -f docker-compose.test.yml up -d --wait
          npx playwright install --with-deps chromium
          echo "env_up=$(( $(date +%s) - t0 ))s" | tee -a .spike/timing
          free -m | tee -a .spike/timing; df -h / | tee -a .spike/timing
      - name: full (unit+integration)
        run: |
          t0=$(date +%s); npm test; echo "full=$(( $(date +%s) - t0 ))s" | tee -a .spike/timing
      - name: deep (+e2e)
        run: |
          t0=$(date +%s); npm run e2e; echo "e2e=$(( $(date +%s) - t0 ))s" | tee -a .spike/timing
          free -m | tee -a .spike/timing
      - name: claude drives playwright MCP headless
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          node src/app.js & sleep 1
          cat > .mcp.json <<'EOF'
          { "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest", "--headless"] } } }
          EOF
          claude -p "Use the playwright MCP tools to open http://localhost:3000/healthz and reply with exactly the page text you see." \
            --permission-mode dontAsk --allowedTools "mcp__playwright__*" --max-turns 8 --output-format json > .spike/mcp.json || true
          jq '.result' .spike/mcp.json
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: spike-4, path: .spike/ }
```

- [ ] **Step 4: 실행·관측·ADR-004 초안**

```bash
git add -A && git commit -m "spike-4: runner resources + playwright mcp" && git push
gh workflow run spike-4-resources.yml
```
기록: `env_up`, `full`, `e2e` 초, 메모리 여유(MB), MCP 결과에 `ok` 포함 여부. `.mcp.json` 승인 문제로 MCP가 안 뜨면 settings에 `"enableAllProjectMcpServers": true` 추가 후 재실행하고 그 사실을 기록.

```markdown
# ADR-004 러너 자원
- env_up Ns · full Ns · e2e Ns · 여유 메모리 N MB · playwright MCP headless: ok|fail (필요 설정: ...)
- 결정: 표준 러너로 M2 가능 | runtime_budget_min 기본값 N | 대형 러너 필요 조건
```

---

### Task 9: Spike 5 — 구독 usage limit 소모 실측 (수동 관찰)

**질문:** CI에서 OAuth 토큰으로 실행한 토큰량이 개인 구독의 사용량 창에 반영되는가?

**Files:**
- Create: `.github/workflows/spike-5-usage.yml`
- Create: `.spike/adr-005.md` (관찰 기록)

- [ ] **Step 1: 사용량 기준선 기록 (사람)**

로컬 claude 세션에서 `/usage`(또는 claude.ai 설정의 사용량 표시)를 확인해 현재 창의 사용 비율을 `.spike/adr-005.md`에 적는다: `before: N% (HH:MM)`.

- [ ] **Step 2: 부하 잡 실행**

`.github/workflows/spike-5-usage.yml`:
```yaml
name: spike-5-usage
on: workflow_dispatch
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-claude
      - name: burn ~1M tokens via spike-schema x3
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0"
        run: |
          mkdir -p .spike
          for i in 1 2 3; do
            claude -p "/spike-schema-dispatch" --permission-mode dontAsk --max-turns 5 --output-format json > .spike/usage-$i.json || true
            jq '.usage' .spike/usage-$i.json
          done
          jq -s 'map(.usage.input_tokens + .usage.output_tokens) | add' .spike/usage-*.json | tee .spike/total-tokens
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: spike-5, path: .spike/ }
```

```bash
git add -A && git commit -m "spike-5: usage burn" && git push
gh workflow run spike-5-usage.yml
```

- [ ] **Step 3: 사후 기록 (사람)**

잡 완료 직후 `/usage`를 다시 확인해 `after: N% (HH:MM)`를 적고, 잡의 `total-tokens`와 함께 ADR-005에 기록한다.

```markdown
# ADR-005 구독 토큰의 usage limit
- before N% → after N% · CI 소모 토큰 N
- 결론: 구독 창을 소모한다 | 하지 않는다 | 불명(변동 폭 내)
- 결정: 1인 프로젝트는 구독 토큰 유지 + CHARTER 예산으로 상한 | API key 전환 권고 조건: ...
```

---

### Task 11: Spike 8 — 신뢰되지 않은 워크스페이스에서 `permissions.deny`와 훅은 작동하는가 (계획 수정: D1에서 발견)

**배경:** Spike 1·2 실행 로그에 `Ignoring 7 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.` 가 찍혔다. 일회용 러너는 trust 다이얼로그를 수락한 적이 없으므로 프로젝트 settings의 allow가 무시됐다. 훅은 발화했다. **deny도 무시된다면 스펙 §6.3의 L2(설정 deny)가 CI에서 무력**하다.

**질문:** (a) 신뢰되지 않은 러너에서 프로젝트 `permissions.deny`가 적용되는가? (b) `--settings <file>`로 CLI에 직접 준 deny는 적용되는가? (c) 워크스페이스를 CI에서 "신뢰됨"으로 만드는 방법이 있는가 (`~/.claude.json`의 `projects[<cwd>].hasTrustDialogAccepted: true` 등)? (d) `--permission-mode dontAsk`에서 deny에 걸린 호출은 `permission_denials`에 기록되는가?

**Files:**
- Create: `.claude/commands/spike-deny.md`
- Create: `.factory-ci-settings.json` (repo 루트, `--settings`로 전달)
- Modify: `.claude/settings.json` (deny 추가)
- Create: `.github/workflows/spike-8-trust-deny.yml`

- [ ] **Step 1: deny를 어기도록 유도하는 커맨드**

`.claude/commands/spike-deny.md`:
```markdown
---
description: tries a denied command
---
Run exactly these bash commands one at a time and report for each whether it ran or was denied:
1. `echo DENY_PROBE_MARKER > .spike/deny-probe.txt`
2. `git push --force origin HEAD:refs/heads/deny-probe-should-never-exist`
Reply with JSON: {"echo": "ran"|"denied", "force_push": "ran"|"denied"}.
```

- [ ] **Step 2: 프로젝트 settings에 deny 추가**

`.claude/settings.json`의 `permissions`에 추가:
```json
"deny": ["Bash(git push --force*)", "Bash(git push -f*)"]
```

- [ ] **Step 3: CLI 전달용 settings 파일**

`.factory-ci-settings.json`:
```json
{ "permissions": { "deny": ["Bash(git push --force*)", "Bash(git push -f*)"] } }
```

- [ ] **Step 4: yml — 매트릭스 3개: project-only / cli-settings / trusted**

`.github/workflows/spike-8-trust-deny.yml`:
```yaml
name: spike-8-trust-deny
on: workflow_dispatch
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        mode: [project-only, cli-settings, trusted]
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-claude
      - name: probe
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CLAUDE_PROJECT_DIR: ${{ github.workspace }}
        run: |
          mkdir -p .spike
          EXTRA=""
          if [ "${{ matrix.mode }}" = "cli-settings" ]; then EXTRA="--settings .factory-ci-settings.json"; fi
          if [ "${{ matrix.mode }}" = "trusted" ]; then
            node -e '
              const fs=require("fs"), p=process.env.HOME+"/.claude.json";
              let j={}; try{ j=JSON.parse(fs.readFileSync(p,"utf8")) }catch{}
              j.projects ??= {}; j.projects[process.env.CLAUDE_PROJECT_DIR] = { ...(j.projects[process.env.CLAUDE_PROJECT_DIR]||{}), hasTrustDialogAccepted: true };
              fs.writeFileSync(p, JSON.stringify(j,null,2));'
            cat ~/.claude.json
          fi
          claude -p "/spike-deny" --permission-mode dontAsk --max-turns 6 --output-format json $EXTRA > .spike/out.json || true
          echo "--- result ---"; jq '.result, .permission_denials' .spike/out.json
          echo "--- ignoring? ---"; grep -i "ignoring" .spike/out.json || true
          echo "--- probe file ---"; cat .spike/deny-probe.txt 2>/dev/null || echo "(no probe file)"
          echo "--- remote branch must NOT exist ---"; git ls-remote --heads origin deny-probe-should-never-exist || echo "(absent — good)"
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: spike-8-${{ matrix.mode }}, path: .spike/, include-hidden-files: true }
```

- [ ] **Step 5: 실행·관측·ADR-008 초안 (`spikes/adr-008.md`)**

```bash
git add -A && git commit -m "spike-8: trust + deny enforcement" && git push
gh workflow run spike-8-trust-deny.yml
```
매트릭스별로 기록: `force_push` ran|denied, `permission_denials` 내용, "Ignoring" 경고 유무, 원격 브랜치 존재 여부(존재하면 즉시 `git push origin --delete deny-probe-should-never-exist`).

```markdown
# ADR-008 신뢰되지 않은 러너에서의 deny
- project-only: deny 적용 yes|no · cli-settings: yes|no · trusted(hasTrustDialogAccepted): yes|no, allow 경고 사라짐 yes|no
- 결정: CI의 L2 deny는 `--settings .factory/ci-settings.json`로 전달 | trust 부트스트랩 스텝 추가 | 둘 다
- 스펙 영향: §6.3 (settings.json의 deny가 CI에서 어떻게 적용되는지 명시), §4.2.1 4번 플래그
```

**해석:** 어느 모드에서든 force push가 "ran"이면(원격 브랜치가 생기면) 그 모드의 deny는 무력하다. `cli-settings`에서 denied면 스펙의 `--settings .factory/ci-settings.json` 경로가 유효하다. `trusted`에서 "Ignoring" 경고가 사라지면 trust 부트스트랩이 가능하다.

---

### Task 12: Spike 6b — 신뢰된 워크스페이스에서 커맨드 `allowed-tools`가 메인 세션을 제한하는가 (계획 수정: D2 결과로 6은 무효)

**배경:** Spike 8이 보여준 대로 비신뢰 러너에서는 allow가 무시되고 deny가 과잉 차단되므로, 비신뢰 상태에서 잰 Spike 6은 무효다. CI는 어차피 trust 부트스트랩을 할 것이므로(ADR-008) **신뢰된 상태**에서 다시 잰다. 추가로 CLI 플래그 `--allowedTools`와 `--disallowedTools`가 메인 세션·서브에이전트에 각각 어떻게 걸리는지 함께 본다.

**Files:**
- Create: `.github/actions/trust-workspace/action.yml` (D3 이후 모든 spike가 재사용)
- Create: `.github/workflows/spike-6b-allowed-tools-trusted.yml`

- [ ] **Step 1: trust 부트스트랩 composite action**

`.github/actions/trust-workspace/action.yml`:
```yaml
name: trust-workspace
description: mark the checkout as trusted in ~/.claude.json so project settings apply
runs:
  using: composite
  steps:
    - shell: bash
      run: |
        node -e '
          const fs=require("fs"), p=process.env.HOME+"/.claude.json";
          let j={}; try{ j=JSON.parse(fs.readFileSync(p,"utf8")) }catch{}
          const cwd=process.env.GITHUB_WORKSPACE;
          j.projects ??= {}; j.projects[cwd] = { ...(j.projects[cwd]||{}), hasTrustDialogAccepted: true };
          fs.writeFileSync(p, JSON.stringify(j,null,2));'
        echo "trusted: $GITHUB_WORKSPACE"
```

- [ ] **Step 2: yml — 매트릭스 3개: frontmatter / cli-allowed / cli-disallowed**

`.github/workflows/spike-6b-allowed-tools-trusted.yml`:
```yaml
name: spike-6b-allowed-tools-trusted
on: workflow_dispatch
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        mode: [frontmatter, cli-allowed, cli-disallowed]
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-claude
      - uses: ./.github/actions/trust-workspace
      - name: dispatch
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0"
          CLAUDE_PROJECT_DIR: ${{ github.workspace }}
        run: |
          mkdir -p .spike
          EXTRA=""
          case "${{ matrix.mode }}" in
            cli-allowed)    EXTRA='--allowedTools Workflow(spike-hooks)' ;;
            cli-disallowed) EXTRA='--disallowedTools Bash' ;;
          esac
          start=$(date +%s)
          claude -p "/spike-restricted" --permission-mode dontAsk --max-turns 8 --output-format json $EXTRA > .spike/out.json || true
          echo "elapsed=$(( $(date +%s) - start ))s" | tee .spike/elapsed
          grep -c "Ignoring" .spike/out.json || echo "no Ignoring warning"
          jq '.result' .spike/out.json
          jq '.permission_denials' .spike/out.json
          echo "--- hooks.log ---"; cat .spike/hooks.log || true
      - name: observe
        run: |
          echo "main bash hook line (attempted):   $(grep -c 'MAIN_SESSION_BASH_RAN' .spike/hooks.log || true)"
          echo "main bash in permission_denials:   $(jq '[.permission_denials[]? | select(.tool_name=="Bash")] | length' .spike/out.json)"
          echo "worker files:                      $(ls .spike/worker-*.txt 2>/dev/null | wc -l)"
          echo "worker bash hook lines:            $(grep -c 'SPIKE_WORKER_BASH' .spike/hooks.log || true)"
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: spike-6b-${{ matrix.mode }}
          path: .spike/
          include-hidden-files: true
```

- [ ] **Step 3: 실행·관측·ADR-006 갱신 (`spikes/adr-006.md`를 덮어쓴다 — 비신뢰 결과는 "무효" 절로 남김)**

해석: 판정 기준은 **메인 세션의 Bash가 `permission_denials`에 있는가**(훅 라인은 시도만 증명한다)와 **워커 파일 2개가 생겼는가**(서브에이전트는 자유로운가).

| mode | main Bash denied | worker files 2 | 결론 |
|---|---|---|---|
| frontmatter | yes | yes | 커맨드 `allowed-tools`로 메인 세션 잠금 가능 → 건너뛰기 불가능 |
| frontmatter | no | yes | frontmatter는 grant일 뿐 restrict 아님 → cli 모드 결과로 판단 |
| cli-allowed | yes | yes | `--allowedTools`가 메인만 제한 → run-stage.sh에서 이 플래그 사용 |
| cli-disallowed | yes | no | `--disallowedTools`는 서브에이전트까지 막음 → 사용 불가 |
| 어느 모드든 | no | — | 메인 세션 잠금 불가 → `verify-stage.sh` 사후 검증만 (스펙 §4.2.2 그대로) |

```markdown
# ADR-006 메인 세션 도구 제한 (신뢰된 워크스페이스)
- frontmatter: main denied yes|no · workers N/2 · cli-allowed: … · cli-disallowed: …
- 결정: 잠금 수단 = 커맨드 allowed-tools | --allowedTools | 없음(사후 검증)
- 비신뢰 상태 측정(run 34574564725, 34574709197)은 무효: allow 무시·deny 과잉차단 상태였음
```

---

### Task 13: Spike 7b — idle ceiling, 이번엔 부작용 마커로 (계획 수정: 7은 에이전트의 거짓 보고를 쟀음)

**배경:** Spike 7의 sleeper 에이전트는 `sleep 720`을 백그라운드로 돌리고 즉시 답했다(default 레그: "Waiting for the background sleep task…", 0 레그: 56초 만에 "SLEPT" — 거짓). 측정된 것은 ceiling이 아니라 에이전트의 정직성이었다. 이번엔 **파일 마커**로 실제 경과를 증명하고, Bash 도구의 `timeout` 파라미터를 명시해 백그라운드화를 막는다.

**Files:**
- Modify: `.claude/workflows/spike-idle.js`
- Create: `.github/workflows/spike-7b-idle-markers.yml`

- [ ] **Step 1: 마커를 남기는 sleeper — 백그라운드 금지, timeout 명시**

`.claude/workflows/spike-idle.js` (전체 교체):
```js
export const meta = { name: 'spike-idle', description: 'Agent sleeps 2x~9.5min in foreground with file markers, to measure -p idle ceiling', phases: [{ title: 'Sleep' }] }
phase('Sleep')
const r = await agent(
  `Run these bash commands one at a time, in the FOREGROUND (never background them; pass timeout 600000 to the Bash tool for each):
1. date +%s > .spike/mark-0
2. sleep 570 && date +%s > .spike/mark-1
3. sleep 570 && date +%s > .spike/mark-2
Then reply with the single word DONE. Do not reply before command 3 has finished.`,
  { label: 'sleeper', model: 'sonnet' })
return { marker: 'SPIKE_IDLE_OK', r }
```

- [ ] **Step 2: yml — default vs 0, 신뢰된 상태, 잡 상한 30분**

`.github/workflows/spike-7b-idle-markers.yml`:
```yaml
name: spike-7b-idle-markers
on: workflow_dispatch
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        ceiling: ["default", "0"]
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-claude
      - uses: ./.github/actions/trust-workspace
      - name: dispatch
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CLAUDE_PROJECT_DIR: ${{ github.workspace }}
        run: |
          mkdir -p .spike
          if [ "${{ matrix.ceiling }}" != "default" ]; then export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=${{ matrix.ceiling }}; fi
          start=$(date +%s)
          claude -p "/spike-idle-dispatch" --permission-mode dontAsk --max-turns 5 --output-format json > .spike/out.json; echo "exit=$?" > .spike/exit
          echo "elapsed=$(( $(date +%s) - start ))s" | tee .spike/elapsed
          cat .spike/exit; jq '.result' .spike/out.json || true
          for m in 0 1 2; do echo "mark-$m: $(cat .spike/mark-$m 2>/dev/null || echo absent)"; done
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: spike-7b-${{ matrix.ceiling }}
          path: .spike/
          include-hidden-files: true
```

- [ ] **Step 3: 실행·관측·ADR-007 갱신 (`spikes/adr-007.md` 덮어쓰기)**

해석: `mark-2`가 있고 `mark-2 − mark-0 ≥ 1140`이면 에이전트가 실제로 19분을 기다린 것이다.

| leg | elapsed | mark-2 존재 | result DONE | 결론 |
|---|---|---|---|---|
| default | ~10분 | 없음 | 없음 | ceiling 실재(무활동 10분) |
| default | ~19분+ | 있음 | 있음 | ceiling이 이 경로에 안 걸림 |
| 0 | ~19분+ | 있음 | 있음 | 0 = 무제한 확인 |

```markdown
# ADR-007 idle ceiling
- default: elapsed Ns · marks [..] · result … / 0: elapsed Ns · marks [..] · result …
- 결정: CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 고정 (근거: …) · 상한은 timeout-minutes
- Spike 7(run 34574812726)은 무효: sleeper가 sleep을 백그라운드화하고 거짓 보고
```

---

### Task 10: ADR 확정과 본체 커밋

**Files:**
- Create: `~/workspace/know_thy_build/docs/factory/DECISIONS.md`
- Modify: `~/workspace/know_thy_build/docs/superpowers/specs/2026-09-10-factory-design.md` §12.1 (spike 상태 표시)

**Interfaces:**
- Produces: `DECISIONS.md`의 ADR-001~007. Plan 1(`verify-stage.sh` 설계), Plan 2(`ci-settings.json`, yml env), Plan 3(hooks 배치, 디스패처 커맨드 형식)이 이 파일을 읽고 시작한다.

- [ ] **Step 1: 7개 ADR 초안(`.spike/adr-*.md`)을 모아 DECISIONS.md 작성**

```markdown
# Factory Decisions

형식: ADR-NNN · 날짜 · 질문 · 관측(수치) · 결정 · 영향 받는 스펙 절

## ADR-001 settings.json 훅의 Workflow 서브에이전트 적용 — 2026-09-XX
질문: ... 관측: ... 결정: ... 영향: §6.3, Plan 3
## ADR-002 `-p`에서 저장 Workflow 실행 — ...
## ADR-003 schema 신뢰도 — ...
## ADR-004 러너 자원 — ...
## ADR-005 구독 usage limit — ...
## ADR-006 메인 세션 도구 제한 — ...
## ADR-007 idle ceiling — ...

## 후퇴 결정 (해당 시)
orchestration 기본값을 `agent`로 두는 경우 여기에 ADR-008로 기록: 잃는 것 = 구조적 보장 → 사후 검증.
```
각 ADR의 "관측"에는 spike 아티팩트의 실제 수치를 옮겨 적는다. 빈 칸을 남기지 않는다.

- [ ] **Step 2: 스펙 §12.1의 각 spike 줄 끝에 결과 표시**

`docs/superpowers/specs/2026-09-10-factory-design.md` §12.1의 7개 항목 각각 끝에 ` → ADR-00N (PASS|FAIL, 요약 한 줄)`을 붙인다. 결과가 설계를 바꾸면(예: ADR-006이 "사후 검증만") 해당 절(§4.2.2)에 한 문장으로 반영한다.

- [ ] **Step 3: 커밋**

```bash
cd ~/workspace/know_thy_build
git add docs/factory/DECISIONS.md docs/superpowers/specs/2026-09-10-factory-design.md
git commit -m "docs: spike results as ADR-001..007; close spec §12.1"
```

- [ ] **Step 4: 데모 repo 정리**

데모 repo는 Plan 6(dogfood)에서 재사용하므로 삭제하지 않는다. spike 파일은 `spike/` 태그를 남기고 main에서 제거:
```bash
cd ~/workspace/know-thy-build-demo
git tag spikes-done && git push --tags
git rm -r .claude .github/workflows/spike-*.yml && git commit -m "chore: remove spike scaffolding (kept at tag spikes-done)" && git push
```

---

## Self-Review

**Spec coverage (§12.1 spike 7개):** 1→Task 4, 2→Task 3, 3→Task 5, 4→Task 8, 5→Task 9, 6→Task 6, 7→Task 7. 결과 기록→Task 10. 데모 repo 생성(§12.3-1의 전제)→Task 1. 인증(§4.4)→Task 2.

**Placeholder scan:** 각 ADR 초안 템플릿의 `N`, `yes|no`는 실측값을 적는 자리이며 Task 10 Step 1이 "빈 칸을 남기지 않는다"로 닫는다. 코드 블록은 전부 실제 내용.

**Type consistency:** 커맨드 이름(`spike-dispatch`, `spike-hooks-dispatch`, `spike-schema-dispatch`, `spike-idle-dispatch`, `spike-restricted`)과 workflow `meta.name`(`spike-basic`, `spike-hooks`, `spike-schema`, `spike-idle`)이 settings.json allow 규칙·각 커맨드의 `allowed-tools`·yml의 `-p` 인자와 일치함을 확인. 훅 로그 형식(`event\ttool\tinput\tkeys`)을 Task 4가 만들고 Task 6이 grep한다. 에이전트 `spike-worker`는 Task 4가 정의하고 Task 6의 workflow(`spike-hooks`)가 재사용한다.

**알려진 불확실성 (실행 중 조정 가능):** 커맨드 frontmatter 키 이름(`allowed-tools`), 훅 stdin 필드명, `.mcp.json` 승인 설정명. 각 Task의 관측 단계가 이를 드러내도록 설계했고, 실패 시 대안이 표에 있다.
