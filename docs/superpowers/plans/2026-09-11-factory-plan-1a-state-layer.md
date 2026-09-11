# Factory Plan 1a — L1 State & Control Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** factory의 결정적 L1 계층 중 "상태와 제어" 부분 — 라벨 상태 머신, handoff 파싱·검증, 전이(handoff 없으면 거부), lock 기반 claim, context 작성, 스테이지 산출물 검증(verify-stage), 리뷰 집계, run 기록, 그리고 이를 잇는 `run-stage.js` — 를 테스트와 함께 구현한다. 게이트(gates.sh, prove-test, diff coverage, flaky 분류)는 Plan 1b.

**Architecture:** `know_thy_build/factory/` 아래 Node ESM 모듈(`lib/`)과 얇은 CLI(`bin/`), bash 훅(`hooks/`). 외부 세계(gh, git, claude)는 전부 `lib/exec.js`의 주입 가능한 `run()`을 통해서만 호출해 vitest에서 가짜 실행기로 검증한다. 모듈은 순수 함수 우선; I/O는 `bin/`과 `run-stage.js`에 모은다. Plan 2의 `factory init`이 이 디렉토리를 대상 프로젝트의 `.factory/`로 복사한다.

**Tech Stack:** Node ≥22 (ESM, `node:child_process`, `node:fs`), `smol-toml`(유일한 런타임 의존성), vitest(devDependency), bash + jq(훅), `gh` CLI, git.

**Spec:** `docs/superpowers/specs/2026-09-10-factory-design.md` — §3 (상태 머신·handoff), §4.2 (제어 계층, run-stage 골격, 디스패처, orchestration 모드, claim 순서), §4.4 (인증·소비 보고), §6 (강제 4겹), §7.1 (roles.toml), §7.5 (리뷰 집계), §9 (run 기록). 결정: `docs/factory/DECISIONS.md` ADR-001 (훅 필드), ADR-002 (stdout JSON), ADR-005 (소비 보고), ADR-006 (사후 검증), ADR-008 (trust 부트스트랩), ADR-009 (훅 exit 0).

## Global Constraints

- Node **≥22**, ESM only (`"type": "module"`). 런타임 의존성은 `smol-toml` 하나. 그 외는 `node:` 내장만.
- 외부 프로세스(gh, git, claude, 훅)는 `lib/exec.js`의 `run()`으로만 호출한다. 모든 모듈은 `run`을 인자로 받는다(테스트 주입).
- handoff의 기계 블록은 **JSON 코드 펜스**(````json`)다. 스펙 §3.4 예시의 YAML 블록은 이 계획으로 JSON으로 확정한다(YAML 파서 의존성 회피). 마커: `<!-- factory-handoff:v1 stage=<stage> issue=<n> -->`.
- 라벨은 스펙 §3.1의 이름을 그대로 쓴다: `backlog`, `factory:queue`, `factory:ready`, `factory:needs-info`, `factory:wont-do`, `factory:planned`, `factory:in-progress`, `factory:awaiting-review`, `factory:rework`, `factory:approved`, `factory:merged`, `factory:blocked`, `factory:needs-human`. `factory:*` 라벨은 이슈에 정확히 하나.
- CHARTER의 기계 판독 값은 `docs/factory/CHARTER.md`의 **frontmatter**에 둔다(본문 표는 사람용). frontmatter 파서는 `lib/frontmatter.js`의 YAML 부분집합(스칼라, 1단계 맵, 인라인 배열)만 지원한다.
- lock은 git ref `refs/heads/factory/lock-<issue>`에 **고유 커밋**을 push해 얻는다(first-push-wins). 라벨은 lock 이후에만 바꾼다(§4.2.5).
- 훅 스크립트는 stdin JSON을 읽고(`$TOOL_INPUT` 금지), 로깅 훅은 **항상 exit 0**(ADR-009), 판정 훅(`stop-guard.sh`, `block-dangerous.sh`)만 exit 2로 차단한다.
- trust 부트스트랩은 `$GITHUB_ACTIONS` 또는 `$FACTORY_RUNNER_ID`가 있을 때만 `~/.claude.json`을 건드린다(ADR-008, §4.2.1 step 0.5).
- `claude -p` 호출: `--permission-mode dontAsk --max-turns 5 --output-format json`, env `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`. `--max-budget-usd`는 CHARTER frontmatter `budget.usd_per_stage`가 있을 때만 붙인다(ADR-005).
- verify-stage는 `subagent_stats`를 쓰지 않는다(ADR-002). 훅이 남긴 `.factory/out/agents.jsonl`(SubagentStart/Stop 전문)로 로스터를 대조한다. `agent_type` 값 형식은 **Task 1에서 실측**한 뒤 확정한다.
- 테스트는 vitest, `npm test`로 실행. 각 모듈에 테스트 파일 1개. 외부 프로세스는 테스트에서 실행하지 않는다.
- 커밋은 `know_thy_build`의 `spec/factory-1.0` 브랜치에. push 금지.

---

## File Structure

```
know_thy_build/
├── package.json                      # + dependencies.smol-toml, devDependencies.vitest, scripts.test, files += factory/
├── vitest.config.js                  # include: factory/test/**/*.test.js
└── factory/
    ├── lib/
    │   ├── exec.js                   # run(cmd, args, opts) → {code, stdout, stderr}; 실제 구현 + 테스트용 fake 생성기
    │   ├── labels.js                 # 상태 목록, 전이 그래프, factoryLabelOf(), canTransition()
    │   ├── handoff.js                # parseHandoffs(), latestHandoff(), renderHandoff()
    │   ├── schemas.js                # validate(name, obj) — triage.v1, plan.v1, implement.v1, review.v1, verdict.v1
    │   ├── requirements.js           # requirementFor(toState)(ctx) → {ok, reason}  (§3.3 표)
    │   ├── frontmatter.js            # parseFrontmatter(markdown) → {data, body}
    │   ├── config.js                 # loadHarness(), loadCharter(), loadRoles(), rosterFor()
    │   ├── gh.js                     # issue(), comments(), comment(), setFactoryLabel(), addLabels(), removeLabel()
    │   ├── claim.js                  # claim(), release()
    │   ├── heartbeat.js              # start(), stop() — 코멘트 갱신 루프
    │   ├── agents-log.js             # readAgentsLog() — agents.jsonl → [{event, agent_id, agent_type, ...}]
    │   ├── verify-stage.js           # verifyStage() — 산출물·로스터·orchestration 대조
    │   ├── aggregate.js              # aggregateReview()
    │   ├── run-record.js             # appendRunRecord()
    │   ├── transition.js             # transition() — canTransition + requirement + gh
    │   └── context.js                # buildContext() — context.json 조립
    ├── bin/
    │   ├── transition.js             # CLI: transition <issue> <to> [--human --reason "..."]
    │   ├── assert-handoff.js         # CLI: assert-handoff <stage> <issue>
    │   ├── claim.js                  # CLI: claim <issue> <stage> | release <issue>
    │   ├── build-context.js          # CLI: build-context <stage> <issue>
    │   ├── verify-stage.js           # CLI: verify-stage <stage> <issue>
    │   ├── write-handoff.js          # CLI: write-handoff <stage> <issue>
    │   ├── trust-workspace.js        # CLI: CI에서만 ~/.claude.json 갱신
    │   └── run-stage.js              # CLI: run-stage <stage> <issue> — §4.2.1 골격
    ├── hooks/
    │   ├── record-agents.sh          # SubagentStart/Stop → .factory/out/agents.jsonl (항상 exit 0)
    │   ├── block-dangerous.sh        # PreToolUse(Bash): merge/force-push/protected 편집 차단 (exit 2)
    │   └── stop-guard.sh             # Stop: factory 브랜치에서 미커밋/미push면 exit 2
    └── test/
        ├── labels.test.js
        ├── handoff.test.js
        ├── schemas.test.js
        ├── requirements.test.js
        ├── frontmatter.test.js
        ├── config.test.js
        ├── gh.test.js
        ├── claim.test.js
        ├── agents-log.test.js
        ├── verify-stage.test.js
        ├── aggregate.test.js
        ├── run-record.test.js
        ├── transition.test.js
        ├── context.test.js
        ├── hooks.test.js             # bash 훅을 stdin JSON으로 실행해 exit code 확인
        └── run-stage.test.js         # fake run으로 전체 골격 순서 검증
```

---

### Task 1: Spike — `agent_type` 값 형식 실측 (ADR-001의 미확인 항목)

**목적:** verify-stage가 로스터를 대조하려면 SubagentStart 이벤트의 `agent_type` 값이 `.claude/agents/<name>.md`의 `name`과 같은 문자열인지 알아야 한다. 이전 spike는 키 이름만 로깅했다.

**Files:**
- Create (demo repo `~/workspace/know-thy-build-demo`): `.claude/hooks/record-agents.sh`, `.claude/settings.json`, `.claude/agents/spike-worker.md`, `.claude/workflows/spike-hooks.js`, `.claude/commands/spike-hooks-dispatch.md` (태그 `spikes-done`에서 복원), `.github/workflows/spike-9-agent-type.yml`
- Modify: `~/workspace/know_thy_build/docs/factory/DECISIONS.md` (ADR-001 미확인 항목 닫기)

- [ ] **Step 1: 태그에서 spike-hooks 세트 복원**

```bash
cd ~/workspace/know-thy-build-demo
git checkout spikes-done -- .claude/agents/spike-worker.md .claude/workflows/spike-hooks.js .claude/commands/spike-hooks-dispatch.md
```

- [ ] **Step 2: 값을 전문으로 남기는 훅**

`.claude/hooks/record-agents.sh`:
```bash
#!/usr/bin/env bash
# SubagentStart / SubagentStop 이벤트의 stdin JSON 전문을 한 줄로 append. 절대 실패하지 않는다.
input=$(cat) || true
dir="${CLAUDE_PROJECT_DIR:-.}/.factory/out"
mkdir -p "$dir" 2>/dev/null || true
printf '%s\n' "$input" >> "$dir/agents.jsonl" 2>/dev/null || true
exit 0
```
`chmod +x .claude/hooks/record-agents.sh`

`.claude/settings.json`:
```json
{
  "permissions": { "allow": ["Workflow(spike-hooks)", "Bash(*)", "Read(*)", "Write(*)"] },
  "hooks": {
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": ".claude/hooks/record-agents.sh" }] }],
    "SubagentStop":  [{ "hooks": [{ "type": "command", "command": ".claude/hooks/record-agents.sh" }] }]
  }
}
```

- [ ] **Step 3: 워크플로 (trusted)**

`.github/workflows/spike-9-agent-type.yml`:
```yaml
name: spike-9-agent-type
on: workflow_dispatch
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 15
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
          mkdir -p .factory/out
          claude -p "/spike-hooks-dispatch" --permission-mode dontAsk --max-turns 5 --output-format json > .factory/out/out.json || true
          echo "--- agents.jsonl ---"; cat .factory/out/agents.jsonl
          echo "--- distinct agent_type values ---"; jq -r '.agent_type' .factory/out/agents.jsonl | sort -u
          echo "--- distinct agent_id values ---"; jq -r '.agent_id' .factory/out/agents.jsonl | sort -u
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: spike-9
          path: .factory/out/
          include-hidden-files: true
```

- [ ] **Step 4: 실행·관측**

```bash
git add -A && git commit -m "spike-9: agent_type value format" && git push
gh workflow run spike-9-agent-type.yml && sleep 20
RUN=$(gh run list --workflow=spike-9-agent-type.yml --limit 1 --json databaseId -q '.[0].databaseId'); gh run watch $RUN --exit-status --interval 15
gh run view $RUN --log | grep -A3 'distinct agent_type'
```
기록: `agent_type`의 distinct 값. 기대는 `spike-worker`(frontmatter `name`). 다른 형식(예: 경로, `custom:spike-worker`, 표시명)이면 그 형식을 기록.

- [ ] **Step 5: ADR-001 갱신**

`~/workspace/know_thy_build/docs/factory/DECISIONS.md`의 ADR-001 "미확인 부분" 문단 아래에 추가:
```markdown
- 2026-09-XX 실측 (spike-9, run <id>): SubagentStart/Stop의 `agent_type` 값 = `<관측값>` (`.claude/agents/spike-worker.md`의 `name`과 동일|상이: <형식>). 같은 에이전트의 Start/Stop은 동일 `agent_id`를 공유함 = yes|no.
  → verify-stage는 `agent_type`(<형식 규칙>)으로 로스터를 대조한다.
```
커밋: `docs: ADR-001 agent_type value format measured (spike-9)`

**Interfaces:**
- Produces: `AGENT_TYPE_FORMAT` 결정 — Task 11(agents-log)·Task 12(verify-stage)가 이 규칙으로 `agent_type`을 정규화한다. 관측값이 `name`과 같으면 정규화는 항등 함수.

---

### Task 2: 패키지 설정과 `lib/exec.js`

**Files:**
- Modify: `package.json`
- Create: `vitest.config.js`, `factory/lib/exec.js`, `factory/test/exec.test.js`

**Interfaces:**
- Produces: `run(cmd, args, {cwd, input, env}) → Promise<{code, stdout, stderr}>`; `makeFakeRun(table)` — `table`은 `[{match: (cmd,args)=>bool, result: {code,stdout,stderr}}]` 또는 함수. 모든 후속 모듈은 `{ run }` 옵션으로 받는다.

- [ ] **Step 1: package.json 갱신**

```json
{
  "name": "know-thy-build",
  "version": "1.0.0-alpha.0",
  "description": "Define what to build, then let a dark factory build it — Socratic project definition + CI-driven multi-agent pipeline for Claude Code",
  "bin": { "know-thy-build": "./bin/cli.js" },
  "files": ["bin/", "templates/", "factory/lib/", "factory/bin/", "factory/hooks/"],
  "scripts": { "test": "vitest run" },
  "dependencies": { "smol-toml": "^1.3.1" },
  "devDependencies": { "vitest": "^3.2.0" },
  "keywords": ["claude-code", "project-definition", "multi-agent", "software-factory", "qa-framework", "socratic", "ai-agent", "code-review", "orchestration"],
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=22" }
}
```
`vitest.config.js`:
```js
export default { test: { include: ["factory/test/**/*.test.js"], environment: "node" } };
```
Run: `npm install` → `node_modules/smol-toml`, `node_modules/vitest` 존재.

- [ ] **Step 2: 실패하는 테스트**

`factory/test/exec.test.js`:
```js
import { test, expect } from "vitest";
import { run, makeFakeRun } from "../lib/exec.js";

test("run executes a real command and captures stdout/code", async () => {
  const r = await run("node", ["-e", "process.stdout.write('hi'); process.exit(3)"]);
  expect(r.stdout).toBe("hi");
  expect(r.code).toBe(3);
});

test("run passes stdin input", async () => {
  const r = await run("node", ["-e", "process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase()))"], { input: "abc" });
  expect(r.stdout).toBe("ABC");
  expect(r.code).toBe(0);
});

test("makeFakeRun matches by predicate and records calls", async () => {
  const fake = makeFakeRun([
    { match: (c, a) => c === "gh" && a[0] === "issue", result: { code: 0, stdout: '{"n":1}', stderr: "" } },
  ]);
  const r = await fake("gh", ["issue", "view", "1"]);
  expect(JSON.parse(r.stdout)).toEqual({ n: 1 });
  expect(fake.calls).toEqual([{ cmd: "gh", args: ["issue", "view", "1"], opts: {} }]);
  await expect(fake("git", ["status"])).rejects.toThrow(/unexpected command: git status/);
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run factory/test/exec.test.js`
Expected: FAIL — `Cannot find module '../lib/exec.js'`

- [ ] **Step 4: 구현**

`factory/lib/exec.js`:
```js
import { spawn } from "node:child_process";

/** 외부 프로세스 실행. 절대 throw하지 않고 {code, stdout, stderr}를 돌려준다 (spawn 실패는 code 127). */
export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: String(e) });
      return;
    }
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.input != null) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** 테스트용 가짜 실행기. table: [{match(cmd,args)→bool, result|fn(cmd,args,opts)→result}] */
export function makeFakeRun(table) {
  const fake = async (cmd, args = [], opts = {}) => {
    fake.calls.push({ cmd, args, opts });
    for (const entry of table) {
      if (entry.match(cmd, args, opts)) {
        return typeof entry.result === "function" ? entry.result(cmd, args, opts) : entry.result;
      }
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
  };
  fake.calls = [];
  return fake;
}
```

- [ ] **Step 5: 통과 확인·커밋**

Run: `npx vitest run factory/test/exec.test.js` → 3 passed.
```bash
git add package.json package-lock.json vitest.config.js factory/lib/exec.js factory/test/exec.test.js
git commit -m "feat(factory): package setup, exec wrapper with fake runner"
```

---

### Task 3: `lib/labels.js` — 상태 목록과 전이 그래프

**Interfaces:**
- Produces: `STATES` (Set of label strings), `TRANSITIONS` (Map from → Set to), `factoryLabelOf(labelNames) → string|null` (정확히 하나 아니면 throw), `canTransition(from, to) → bool`, `STAGE_OF_TARGET` (`{ "factory:ready": "triage", "factory:planned": "plan", "factory:awaiting-review": "implement", "factory:approved": "review", "factory:merged": "merge" }`).

- [ ] **Step 1: 실패하는 테스트**

`factory/test/labels.test.js`:
```js
import { test, expect } from "vitest";
import { STATES, canTransition, factoryLabelOf, STAGE_OF_TARGET } from "../lib/labels.js";

test("states are the spec's 13 labels", () => {
  expect([...STATES].sort()).toEqual([
    "backlog", "factory:approved", "factory:awaiting-review", "factory:blocked", "factory:in-progress",
    "factory:merged", "factory:needs-human", "factory:needs-info", "factory:planned", "factory:queue",
    "factory:ready", "factory:rework", "factory:wont-do",
  ]);
});

test("graph edges from §3.2", () => {
  expect(canTransition("backlog", "factory:queue")).toBe(true);
  expect(canTransition("factory:queue", "factory:ready")).toBe(true);
  expect(canTransition("factory:queue", "factory:needs-info")).toBe(true);
  expect(canTransition("factory:queue", "factory:wont-do")).toBe(true);
  expect(canTransition("factory:needs-info", "factory:queue")).toBe(true);
  expect(canTransition("factory:ready", "factory:planned")).toBe(true);
  expect(canTransition("factory:planned", "factory:in-progress")).toBe(true);
  expect(canTransition("factory:in-progress", "factory:awaiting-review")).toBe(true);
  expect(canTransition("factory:in-progress", "factory:blocked")).toBe(true);
  expect(canTransition("factory:in-progress", "factory:needs-human")).toBe(true);
  expect(canTransition("factory:awaiting-review", "factory:approved")).toBe(true);
  expect(canTransition("factory:awaiting-review", "factory:rework")).toBe(true);
  expect(canTransition("factory:rework", "factory:in-progress")).toBe(true);
  expect(canTransition("factory:rework", "factory:needs-human")).toBe(true);
  expect(canTransition("factory:approved", "factory:merged")).toBe(true);
  expect(canTransition("factory:blocked", "factory:needs-human")).toBe(true);
  expect(canTransition("factory:blocked", "factory:planned")).toBe(true);   // sweeper 재큐
  expect(canTransition("factory:needs-human", "factory:queue")).toBe(true);
});

test("non-edges are rejected", () => {
  expect(canTransition("backlog", "factory:approved")).toBe(false);
  expect(canTransition("factory:queue", "factory:planned")).toBe(false);
  expect(canTransition("factory:merged", "factory:queue")).toBe(false);
  expect(canTransition("nonsense", "factory:queue")).toBe(false);
});

test("factoryLabelOf picks the single factory:* label; backlog counts as a state", () => {
  expect(factoryLabelOf(["bug", "factory:ready"])).toBe("factory:ready");
  expect(factoryLabelOf(["backlog", "enhancement"])).toBe("backlog");
  expect(factoryLabelOf(["bug"])).toBe(null);
  expect(() => factoryLabelOf(["factory:ready", "factory:planned"])).toThrow(/exactly one/);
  expect(() => factoryLabelOf(["backlog", "factory:queue"])).toThrow(/exactly one/);
});

test("target state → stage that must have produced the handoff", () => {
  expect(STAGE_OF_TARGET["factory:planned"]).toBe("plan");
  expect(STAGE_OF_TARGET["factory:approved"]).toBe("review");
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run factory/test/labels.test.js` → module not found.

- [ ] **Step 3: 구현**

`factory/lib/labels.js`:
```js
export const STATES = new Set([
  "backlog", "factory:queue", "factory:ready", "factory:needs-info", "factory:wont-do", "factory:planned",
  "factory:in-progress", "factory:awaiting-review", "factory:rework", "factory:approved", "factory:merged",
  "factory:blocked", "factory:needs-human",
]);

/** §3.2 전이 그래프. 키: from, 값: 허용된 to. */
export const TRANSITIONS = new Map([
  ["backlog", new Set(["factory:queue"])],
  ["factory:queue", new Set(["factory:ready", "factory:needs-info", "factory:wont-do"])],
  ["factory:needs-info", new Set(["factory:queue"])],
  ["factory:ready", new Set(["factory:planned", "factory:needs-human"])],
  ["factory:planned", new Set(["factory:in-progress", "factory:needs-human"])],
  ["factory:in-progress", new Set(["factory:awaiting-review", "factory:blocked", "factory:needs-human"])],
  ["factory:awaiting-review", new Set(["factory:approved", "factory:rework", "factory:needs-human"])],
  ["factory:rework", new Set(["factory:in-progress", "factory:needs-human"])],
  ["factory:approved", new Set(["factory:merged", "factory:needs-human"])],
  ["factory:blocked", new Set(["factory:needs-human", "factory:planned"])],
  ["factory:needs-human", new Set(["factory:queue"])],
  ["factory:merged", new Set([])],
  ["factory:wont-do", new Set([])],
]);

/** 목적 상태에 도달하려면 어느 스테이지의 handoff가 있어야 하는가 (§3.3). */
export const STAGE_OF_TARGET = {
  "factory:ready": "triage",
  "factory:planned": "plan",
  "factory:awaiting-review": "implement",
  "factory:approved": "review",
  "factory:merged": "merge",
};

export function canTransition(from, to) {
  const tos = TRANSITIONS.get(from);
  return Boolean(tos && tos.has(to));
}

/** 이슈 라벨 배열에서 factory 상태 라벨 하나를 고른다. 0개면 null, 2개 이상이면 throw. */
export function factoryLabelOf(labelNames) {
  const found = labelNames.filter((l) => STATES.has(l));
  if (found.length === 0) return null;
  if (found.length > 1) throw new Error(`issue must carry exactly one factory state label, found: ${found.join(", ")}`);
  return found[0];
}
```

- [ ] **Step 4: 통과·커밋** — `npx vitest run factory/test/labels.test.js` → 5 passed.
```bash
git add factory/lib/labels.js factory/test/labels.test.js && git commit -m "feat(factory): label state machine"
```

---

### Task 4: `lib/handoff.js` — handoff 코멘트 파싱과 렌더링

**Interfaces:**
- Produces: `parseHandoffs(comments) → [{stage, issue, data, summary, createdAt, commentId}]` (comments: `[{id, body, createdAt}]`), `latestHandoff(comments, stage) → handoff|null`, `renderHandoff({stage, issue, summary, data}) → string`. 기계 블록은 ```` ```json ```` 펜스 안 JSON.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/handoff.test.js`:
```js
import { test, expect } from "vitest";
import { parseHandoffs, latestHandoff, renderHandoff } from "../lib/handoff.js";

const planBody = `<!-- factory-handoff:v1 stage=plan issue=123 -->
### Plan · round 3 합의

**접근**: 증분 동기화

\`\`\`json
{"schema":"factory.plan.v1","issue":123,"tier":"standard","done_when":[{"id":"dw1","text":"x","verify":"test_123_x","level":"unit"}]}
\`\`\`
`;

test("renderHandoff produces marker + summary + json fence, and parses back", () => {
  const body = renderHandoff({ stage: "plan", issue: 123, summary: "### Plan\n\n**접근**: 증분 동기화", data: { schema: "factory.plan.v1", issue: 123 } });
  expect(body.startsWith("<!-- factory-handoff:v1 stage=plan issue=123 -->")).toBe(true);
  expect(body).toContain("```json\n");
  const [h] = parseHandoffs([{ id: 1, body, createdAt: "2026-09-11T00:00:00Z" }]);
  expect(h.stage).toBe("plan");
  expect(h.issue).toBe(123);
  expect(h.data.schema).toBe("factory.plan.v1");
  expect(h.summary).toContain("**접근**");
});

test("parseHandoffs ignores non-handoff comments and malformed json", () => {
  const comments = [
    { id: 1, body: "just a comment", createdAt: "2026-09-11T00:00:00Z" },
    { id: 2, body: planBody, createdAt: "2026-09-11T00:01:00Z" },
    { id: 3, body: "<!-- factory-handoff:v1 stage=plan issue=123 -->\n```json\n{not json\n```", createdAt: "2026-09-11T00:02:00Z" },
  ];
  const hs = parseHandoffs(comments);
  expect(hs).toHaveLength(1);
  expect(hs[0].commentId).toBe(2);
});

test("latestHandoff returns the newest for a stage by createdAt", () => {
  const older = { id: 1, body: planBody.replace('"tier":"standard"', '"tier":"docs"'), createdAt: "2026-09-10T00:00:00Z" };
  const newer = { id: 2, body: planBody, createdAt: "2026-09-11T00:00:00Z" };
  expect(latestHandoff([newer, older], "plan").data.tier).toBe("standard");
  expect(latestHandoff([older], "review")).toBe(null);
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/handoff.js`:
```js
const MARKER = /<!--\s*factory-handoff:v1\s+stage=([a-z-]+)\s+issue=(\d+)\s*-->/;
const FENCE = /```json\s*\n([\s\S]*?)\n```/;

export function renderHandoff({ stage, issue, summary, data }) {
  const json = JSON.stringify(data, null, 2);
  return `<!-- factory-handoff:v1 stage=${stage} issue=${issue} -->\n${summary.trim()}\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

export function parseHandoffs(comments) {
  const out = [];
  for (const c of comments) {
    const m = MARKER.exec(c.body || "");
    if (!m) continue;
    const f = FENCE.exec(c.body);
    if (!f) continue;
    let data;
    try { data = JSON.parse(f[1]); } catch { continue; }
    const summary = c.body.slice(m.index + m[0].length, f.index).trim();
    out.push({ stage: m[1], issue: Number(m[2]), data, summary, createdAt: c.createdAt, commentId: c.id });
  }
  return out;
}

export function latestHandoff(comments, stage) {
  const hs = parseHandoffs(comments).filter((h) => h.stage === stage);
  if (hs.length === 0) return null;
  hs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return hs[0];
}
```

- [ ] **Step 4: 통과·커밋** — 3 passed. `git commit -m "feat(factory): handoff parse/render"`

---

### Task 5: `lib/schemas.js` — handoff·판정 schema 검증 (의존성 없는 수동 검증)

**Interfaces:**
- Produces: `validate(name, obj) → {ok: boolean, errors: string[]}`. 이름: `triage.v1`, `plan.v1`, `implement.v1`, `review.v1`, `verdict.v1`, `rework-response.v1`. 후속 Task(requirements, verify-stage, aggregate, write-handoff)가 사용.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/schemas.test.js`:
```js
import { test, expect } from "vitest";
import { validate } from "../lib/schemas.js";

test("triage.v1", () => {
  expect(validate("triage.v1", { schema: "factory.triage.v1", issue: 1, disposition: "ready", tier: "standard" }).ok).toBe(true);
  const r = validate("triage.v1", { schema: "factory.triage.v1", issue: 1, disposition: "maybe" });
  expect(r.ok).toBe(false);
  expect(r.errors.join(" ")).toMatch(/disposition/);
  expect(r.errors.join(" ")).toMatch(/tier/);
});

test("plan.v1 requires done_when with verify+level, files_expected, dissent_log, roles, rounds", () => {
  const good = { schema: "factory.plan.v1", issue: 1, tier: "standard", roles: ["a", "b"], rounds: 3,
    done_when: [{ id: "dw1", text: "t", verify: "test_1_t", level: "unit" }], files_expected: ["src/x.ts"], dissent_log: [], non_goals: [], open_risks: [] };
  expect(validate("plan.v1", good).ok).toBe(true);
  const bad = { ...good, done_when: [{ id: "dw1", text: "t" }] };
  const r = validate("plan.v1", bad);
  expect(r.ok).toBe(false);
  expect(r.errors.join(" ")).toMatch(/done_when\[0\]\.verify/);
  expect(validate("plan.v1", { ...good, done_when: [] }).ok).toBe(false);
});

test("implement.v1 requires gates GREEN fields, head_sha, verifier verdict, pr", () => {
  const good = { schema: "factory.implement.v1", issue: 1, head_sha: "a".repeat(40), pr: 5, gates: { status: "GREEN", level: "full" },
    verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" };
  expect(validate("implement.v1", good).ok).toBe(true);
  expect(validate("implement.v1", { ...good, head_sha: "short" }).ok).toBe(false);
  expect(validate("implement.v1", { ...good, gates: { status: "RED" } }).ok).toBe(true); // 상태 값 자체는 허용, 판단은 requirements가 한다
});

test("review.v1 and verdict.v1", () => {
  const verdict = { verdict: "reject", confidence: "high", must_fix: [{ id: "cf1", where: "a.ts:1", claim: "c", evidence: "e" }], should_fix: [], verified: [] };
  expect(validate("verdict.v1", verdict).ok).toBe(true);
  expect(validate("verdict.v1", { ...verdict, must_fix: [] }).ok).toBe(false);          // reject엔 must_fix ≥1
  expect(validate("verdict.v1", { ...verdict, verdict: "approve", must_fix: [] }).ok).toBe(true);
  const review = { schema: "factory.review.v1", issue: 1, pr: 5, head_sha: "b".repeat(40), round: 1,
    verdicts: [{ role: "correctness", ...verdict }], orchestration: "workflow", guarantee: "verified" };
  expect(validate("review.v1", review).ok).toBe(true);
  expect(validate("review.v1", { ...review, verdicts: [] }).ok).toBe(false);
});

test("rework-response.v1", () => {
  const ok = { schema: "factory.rework-response.v1", issue: 1, responses: [{ id: "cf1", status: "fixed", commit: "abc" }, { id: "cf2", status: "disputed", reason: "out of scope" }] };
  expect(validate("rework-response.v1", ok).ok).toBe(true);
  expect(validate("rework-response.v1", { ...ok, responses: [{ id: "cf1", status: "fixed" }] }).ok).toBe(false);      // fixed엔 commit
  expect(validate("rework-response.v1", { ...ok, responses: [{ id: "cf2", status: "disputed" }] }).ok).toBe(false);   // disputed엔 reason
});

test("unknown schema name", () => {
  expect(() => validate("nope", {})).toThrow(/unknown schema/);
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/schemas.js`:
```js
const SHA = /^[0-9a-f]{40}$/;

function req(errors, obj, key, type, path = "") {
  const v = obj?.[key];
  const p = path ? `${path}.${key}` : key;
  if (v === undefined || v === null) { errors.push(`${p} is required`); return undefined; }
  if (type === "array" ? !Array.isArray(v) : typeof v !== type) { errors.push(`${p} must be ${type}`); return undefined; }
  return v;
}
function oneOf(errors, obj, key, values, path = "") {
  const v = req(errors, obj, key, "string", path);
  if (v !== undefined && !values.includes(v)) errors.push(`${path ? path + "." : ""}${key} must be one of ${values.join("|")}`);
  return v;
}

function verdictChecks(errors, v, path) {
  const kind = oneOf(errors, v, "verdict", ["approve", "reject"], path);
  oneOf(errors, v, "confidence", ["high", "medium", "low"], path);
  const mf = req(errors, v, "must_fix", "array", path) || [];
  req(errors, v, "should_fix", "array", path);
  req(errors, v, "verified", "array", path);
  mf.forEach((m, i) => { for (const k of ["id", "where", "claim", "evidence"]) req(errors, m, k, "string", `${path}.must_fix[${i}]`); });
  if (kind === "reject" && mf.length === 0) errors.push(`${path}.must_fix must have ≥1 item when verdict is reject`);
}

const SCHEMAS = {
  "triage.v1"(o, e) {
    req(e, o, "issue", "number");
    const d = oneOf(e, o, "disposition", ["ready", "needs-info", "wont-do"]);
    if (d === "ready") oneOf(e, o, "tier", ["docs", "standard", "load-bearing"]);
    if (d === "needs-info") req(e, o, "questions", "array");
  },
  "plan.v1"(o, e) {
    req(e, o, "issue", "number");
    oneOf(e, o, "tier", ["docs", "standard", "load-bearing"]);
    const roles = req(e, o, "roles", "array"); if (roles && roles.length < 2) e.push("roles must have ≥2 entries");
    req(e, o, "rounds", "number");
    const dw = req(e, o, "done_when", "array") || [];
    if (dw.length === 0) e.push("done_when must have ≥1 item");
    dw.forEach((d, i) => { for (const k of ["id", "text", "verify"]) req(e, d, k, "string", `done_when[${i}]`); oneOf(e, d, "level", ["unit", "integration", "e2e"], `done_when[${i}]`); });
    req(e, o, "files_expected", "array");
    req(e, o, "dissent_log", "array");
    req(e, o, "non_goals", "array");
    req(e, o, "open_risks", "array");
  },
  "implement.v1"(o, e) {
    req(e, o, "issue", "number");
    const sha = req(e, o, "head_sha", "string"); if (sha && !SHA.test(sha)) e.push("head_sha must be a 40-hex sha");
    req(e, o, "pr", "number");
    const g = req(e, o, "gates", "object"); if (g) oneOf(e, g, "status", ["GREEN", "RED", "MISCONFIGURED"], "gates");
    const v = req(e, o, "verifier", "object"); if (v) oneOf(e, v, "verdict", ["accepted", "accepted-with-reservations", "rejected"], "verifier");
    oneOf(e, o, "orchestration", ["workflow", "agent"]);
    oneOf(e, o, "guarantee", ["structural", "verified"]);
  },
  "review.v1"(o, e) {
    req(e, o, "issue", "number"); req(e, o, "pr", "number");
    const sha = req(e, o, "head_sha", "string"); if (sha && !SHA.test(sha)) e.push("head_sha must be a 40-hex sha");
    req(e, o, "round", "number");
    const vs = req(e, o, "verdicts", "array") || [];
    if (vs.length === 0) e.push("verdicts must have ≥1 item");
    vs.forEach((v, i) => { req(e, v, "role", "string", `verdicts[${i}]`); verdictChecks(e, v, `verdicts[${i}]`); });
    oneOf(e, o, "orchestration", ["workflow", "agent"]);
    oneOf(e, o, "guarantee", ["structural", "verified"]);
  },
  "verdict.v1"(o, e) { verdictChecks(e, o, "verdict"); },
  "rework-response.v1"(o, e) {
    req(e, o, "issue", "number");
    const rs = req(e, o, "responses", "array") || [];
    rs.forEach((r, i) => {
      req(e, r, "id", "string", `responses[${i}]`);
      const s = oneOf(e, r, "status", ["fixed", "disputed"], `responses[${i}]`);
      if (s === "fixed") req(e, r, "commit", "string", `responses[${i}]`);
      if (s === "disputed") req(e, r, "reason", "string", `responses[${i}]`);
    });
  },
};

export function validate(name, obj) {
  const fn = SCHEMAS[name];
  if (!fn) throw new Error(`unknown schema: ${name}`);
  const errors = [];
  if (typeof obj !== "object" || obj === null) errors.push("value must be an object");
  else fn(obj, errors);
  return { ok: errors.length === 0, errors };
}
```
주의: `req(..., "object")`는 `typeof null === "object"`를 위에서 걸렀으므로 안전.

- [ ] **Step 4: 통과·커밋** — 6 passed. `git commit -m "feat(factory): handoff and verdict schemas"`

---

### Task 6: `lib/requirements.js` — 목적 상태별 handoff 요구 (§3.3)

**Interfaces:**
- Consumes: `validate` (Task 5), `latestHandoff` (Task 4), `STAGE_OF_TARGET` (Task 3).
- Produces: `requirementFor(toState) → (ctx) => {ok, reason}`; `ctx = { comments, headSha?, prHeadSha?, rosterSize?, roster?, maxRounds?, integrityGreen?, checksGreen? }`. 전이가 요구하지 않는 상태(`needs-info`, `in-progress` 등)는 `{ok:true}`.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/requirements.test.js`:
```js
import { test, expect } from "vitest";
import { requirementFor } from "../lib/requirements.js";
import { renderHandoff } from "../lib/handoff.js";

const sha = "c".repeat(40);
const c = (stage, data, at = "2026-09-11T00:00:00Z") => ({ id: Math.random(), createdAt: at, body: renderHandoff({ stage, issue: 7, summary: "s", data }) });

test("ready requires triage handoff with disposition=ready and tier", () => {
  const ok = requirementFor("factory:ready")({ comments: [c("triage", { schema: "factory.triage.v1", issue: 7, disposition: "ready", tier: "docs" })] });
  expect(ok.ok).toBe(true);
  const missing = requirementFor("factory:ready")({ comments: [] });
  expect(missing.ok).toBe(false); expect(missing.reason).toMatch(/triage handoff missing/);
  const wrong = requirementFor("factory:ready")({ comments: [c("triage", { schema: "factory.triage.v1", issue: 7, disposition: "needs-info", questions: [] })] });
  expect(wrong.ok).toBe(false); expect(wrong.reason).toMatch(/disposition/);
});

test("planned requires plan handoff whose roles == roster and rounds == expected", () => {
  const plan = { schema: "factory.plan.v1", issue: 7, tier: "standard", roles: ["architect", "skeptic"], rounds: 3,
    done_when: [{ id: "dw1", text: "t", verify: "test_7_t", level: "unit" }], files_expected: [], dissent_log: [], non_goals: [], open_risks: [] };
  const r = requirementFor("factory:planned");
  expect(r({ comments: [c("plan", plan)], roster: ["skeptic", "architect"], expectedRounds: 3 }).ok).toBe(true);
  expect(r({ comments: [c("plan", plan)], roster: ["skeptic", "architect", "operator"], expectedRounds: 3 }).reason).toMatch(/roles/);
  expect(r({ comments: [c("plan", plan)], roster: ["skeptic", "architect"], expectedRounds: 2 }).reason).toMatch(/rounds/);
});

test("awaiting-review requires implement handoff: GREEN, head_sha == branch head, verifier accepted, pr", () => {
  const impl = { schema: "factory.implement.v1", issue: 7, head_sha: sha, pr: 9, gates: { status: "GREEN", level: "full" }, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:awaiting-review");
  expect(r({ comments: [c("implement", impl)], headSha: sha }).ok).toBe(true);
  expect(r({ comments: [c("implement", impl)], headSha: "d".repeat(40) }).reason).toMatch(/head_sha/);
  expect(r({ comments: [c("implement", { ...impl, gates: { status: "RED", level: "full" } })], headSha: sha }).reason).toMatch(/gates/);
  expect(r({ comments: [c("implement", { ...impl, verifier: { verdict: "rejected" } })], headSha: sha }).reason).toMatch(/verifier/);
});

test("approved requires review handoff: sha == PR head, all approve, count == roster, round <= K", () => {
  const v = (role, verdict) => ({ role, verdict, confidence: "high", must_fix: verdict === "reject" ? [{ id: "x", where: "w", claim: "c", evidence: "e" }] : [], should_fix: [], verified: [] });
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 2, verdicts: [v("a", "approve"), v("b", "approve")], orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:approved");
  expect(r({ comments: [c("review", review)], prHeadSha: sha, rosterSize: 2, maxRounds: 3 }).ok).toBe(true);
  expect(r({ comments: [c("review", review)], prHeadSha: sha, rosterSize: 3, maxRounds: 3 }).reason).toMatch(/verdict count/);
  expect(r({ comments: [c("review", { ...review, verdicts: [v("a", "approve"), v("b", "reject")] })], prHeadSha: sha, rosterSize: 2, maxRounds: 3 }).reason).toMatch(/not all approve/);
  expect(r({ comments: [c("review", { ...review, round: 4 })], prHeadSha: sha, rosterSize: 2, maxRounds: 3 }).reason).toMatch(/round/);
  expect(r({ comments: [c("review", review)], prHeadSha: "e".repeat(40), rosterSize: 2, maxRounds: 3 }).reason).toMatch(/head_sha/);
});

test("merged requires checks + integrity GREEN and approved handoff sha == PR head", () => {
  const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: sha, round: 1, verdicts: [{ role: "a", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] }], orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:merged");
  expect(r({ comments: [c("review", review)], prHeadSha: sha, checksGreen: true, integrityGreen: true }).ok).toBe(true);
  expect(r({ comments: [c("review", review)], prHeadSha: sha, checksGreen: false, integrityGreen: true }).reason).toMatch(/checks/);
  expect(r({ comments: [c("review", review)], prHeadSha: sha, checksGreen: true, integrityGreen: false }).reason).toMatch(/integrity/);
});

test("states without a handoff requirement always pass", () => {
  for (const s of ["factory:queue", "factory:needs-info", "factory:wont-do", "factory:in-progress", "factory:rework", "factory:blocked", "factory:needs-human"]) {
    expect(requirementFor(s)({ comments: [] }).ok).toBe(true);
  }
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/requirements.js`:
```js
import { latestHandoff } from "./handoff.js";
import { validate } from "./schemas.js";

const fail = (reason) => ({ ok: false, reason });
const pass = { ok: true };

function need(comments, stage, schema) {
  const h = latestHandoff(comments, stage);
  if (!h) return { err: fail(`${stage} handoff missing`) };
  const v = validate(schema, h.data);
  if (!v.ok) return { err: fail(`${stage} handoff invalid: ${v.errors.join("; ")}`) };
  return { h };
}
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

const RULES = {
  "factory:ready"(ctx) {
    const { h, err } = need(ctx.comments, "triage", "triage.v1"); if (err) return err;
    if (h.data.disposition !== "ready") return fail(`triage disposition is ${h.data.disposition}, not ready`);
    return pass;
  },
  "factory:planned"(ctx) {
    const { h, err } = need(ctx.comments, "plan", "plan.v1"); if (err) return err;
    if (ctx.roster && !sameSet(h.data.roles, ctx.roster)) return fail(`plan roles [${h.data.roles}] != roster [${ctx.roster}]`);
    if (ctx.expectedRounds != null && h.data.rounds !== ctx.expectedRounds) return fail(`plan rounds ${h.data.rounds} != expected ${ctx.expectedRounds}`);
    return pass;
  },
  "factory:awaiting-review"(ctx) {
    const { h, err } = need(ctx.comments, "implement", "implement.v1"); if (err) return err;
    if (h.data.gates.status !== "GREEN") return fail(`gates status is ${h.data.gates.status}`);
    if (ctx.headSha && h.data.head_sha !== ctx.headSha) return fail(`implement head_sha ${h.data.head_sha.slice(0, 7)} != branch head ${ctx.headSha.slice(0, 7)}`);
    if (h.data.verifier.verdict === "rejected") return fail("verifier rejected");
    return pass;
  },
  "factory:approved"(ctx) {
    const { h, err } = need(ctx.comments, "review", "review.v1"); if (err) return err;
    if (ctx.prHeadSha && h.data.head_sha !== ctx.prHeadSha) return fail(`review head_sha ${h.data.head_sha.slice(0, 7)} != PR head ${ctx.prHeadSha.slice(0, 7)}`);
    if (ctx.rosterSize != null && h.data.verdicts.length !== ctx.rosterSize) return fail(`verdict count ${h.data.verdicts.length} != roster size ${ctx.rosterSize}`);
    if (!h.data.verdicts.every((v) => v.verdict === "approve")) return fail("not all approve");
    if (ctx.maxRounds != null && h.data.round > ctx.maxRounds) return fail(`round ${h.data.round} > K=${ctx.maxRounds}`);
    return pass;
  },
  "factory:merged"(ctx) {
    const { h, err } = need(ctx.comments, "review", "review.v1"); if (err) return err;
    if (ctx.prHeadSha && h.data.head_sha !== ctx.prHeadSha) return fail(`approved handoff head_sha != PR head`);
    if (ctx.checksGreen === false) return fail("required checks not GREEN");
    if (ctx.integrityGreen === false) return fail("integrity check not GREEN");
    return pass;
  },
};

export function requirementFor(toState) {
  return RULES[toState] || (() => pass);
}
```

- [ ] **Step 4: 통과·커밋** — 6 passed. `git commit -m "feat(factory): handoff requirements per target state"`

---

### Task 7: `lib/frontmatter.js` + `lib/config.js` — harness.toml, CHARTER frontmatter, roles.toml 로딩과 로스터 계산

**Interfaces:**
- Produces: `parseFrontmatter(md) → {data, body}`; `loadHarness(root) → object` (smol-toml); `loadCharter(root) → {status, tier_default, limits:{K,M,R}, roster:{docs:[..], standard:[..], "load-bearing":[..]}, plan_roles:{docs:[..], default:[..]}, plan_rounds:{docs:2, default:3}, budget:{usd_per_stage?}, ...}`; `loadRoles(root) → object`; `rosterFor(charter, roles, stage, tier) → string[]` (review: charter.roster[tier] ∩ roles.review 키; plan: charter.plan_roles).
- CHARTER frontmatter 형식(이 계획으로 확정; 스펙 §5.3 예시의 표는 사람용 그대로):

```yaml
---
schema: factory.charter.v1
status: ready
tier_default: standard
limits: { K: 3, M: 3, R: 2 }
roster:
  docs: [correctness, spec-conformance]
  standard: [correctness, architecture, spec-conformance, qa]
  load-bearing: [correctness, security, architecture, spec-conformance, qa]
plan_roles:
  docs: [architect, skeptic]
  default: [product-advocate, architect, skeptic, operator]
plan_rounds: { docs: 2, default: 3 }
back_pressure: { awaiting_review_max: 4, quarantine_max: 5 }
budget: {}
retro: { every_merges: { initial: 1, min: 1, max: 20 }, light_on_merge: true }
---
```

- [ ] **Step 1: 실패하는 테스트**

`factory/test/frontmatter.test.js`:
```js
import { test, expect } from "vitest";
import { parseFrontmatter } from "../lib/frontmatter.js";

test("scalars, inline maps, inline arrays, nested one-level maps", () => {
  const md = `---
schema: factory.charter.v1
status: ready
limits: { K: 3, M: 3, R: 2 }
roster:
  docs: [correctness, spec-conformance]
  load-bearing: [a, b, c]
plan_rounds: { docs: 2, default: 3 }
budget: {}
retro: { every_merges: { initial: 1, min: 1, max: 20 }, light_on_merge: true }
---
# Body
text`;
  const { data, body } = parseFrontmatter(md);
  expect(data.schema).toBe("factory.charter.v1");
  expect(data.status).toBe("ready");
  expect(data.limits).toEqual({ K: 3, M: 3, R: 2 });
  expect(data.roster).toEqual({ docs: ["correctness", "spec-conformance"], "load-bearing": ["a", "b", "c"] });
  expect(data.plan_rounds.default).toBe(3);
  expect(data.budget).toEqual({});
  expect(data.retro.every_merges.max).toBe(20);
  expect(data.retro.light_on_merge).toBe(true);
  expect(body.trim()).toBe("# Body\ntext");
});

test("no frontmatter → empty data, whole body", () => {
  expect(parseFrontmatter("# just md")).toEqual({ data: {}, body: "# just md" });
});
```

`factory/test/config.test.js`:
```js
import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHarness, loadCharter, loadRoles, rosterFor } from "../lib/config.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ktb-"));
  mkdirSync(join(root, ".factory"), { recursive: true });
  mkdirSync(join(root, "docs/factory"), { recursive: true });
  writeFileSync(join(root, ".factory/harness.toml"), `schema = 1\n[harness]\nmaturity = "M1"\n[factory]\norchestration = "workflow"\n[commands]\nlint = "npm run lint"\nunit = "npm test"\n[gates]\nrequired = ["lint","unit"]\nfast = ["lint","unit"]\nfull = ["lint","unit"]\ndeep = ["lint","unit"]\n`);
  writeFileSync(join(root, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: ready\ntier_default: standard\nlimits: { K: 3, M: 3, R: 2 }\nroster:\n  docs: [correctness, spec-conformance]\n  standard: [correctness, architecture, spec-conformance, qa]\n  load-bearing: [correctness, security, architecture, spec-conformance, qa]\nplan_roles:\n  docs: [architect, skeptic]\n  default: [product-advocate, architect, skeptic, operator]\nplan_rounds: { docs: 2, default: 3 }\nback_pressure: { awaiting_review_max: 4, quarantine_max: 5 }\nbudget: {}\n---\n# Charter\n`);
  writeFileSync(join(root, ".factory/roles.toml"), `schema = 1\n[review.correctness]\nagent = ".claude/agents/reviewer-correctness.md"\n[review.security]\nagent = ".claude/agents/reviewer-security.md"\n[review.architecture]\nagent = "x"\n[review.spec-conformance]\nagent = "x"\n[review.qa]\nagent = "x"\n[plan.architect]\nagent = "x"\n[plan.skeptic]\nagent = "x"\n[plan.product-advocate]\nagent = "x"\n[plan.operator]\nagent = "x"\n`);
  return root;
}

test("loads harness.toml, CHARTER frontmatter, roles.toml", () => {
  const root = fixture();
  expect(loadHarness(root).harness.maturity).toBe("M1");
  expect(loadHarness(root).factory.orchestration).toBe("workflow");
  const ch = loadCharter(root);
  expect(ch.status).toBe("ready");
  expect(ch.limits.K).toBe(3);
  expect(loadRoles(root).review.security.agent).toContain("security");
});

test("rosterFor: review roster by tier must exist in roles.toml; plan roster by tier", () => {
  const root = fixture();
  const ch = loadCharter(root), roles = loadRoles(root);
  expect(rosterFor(ch, roles, "review", "docs")).toEqual(["correctness", "spec-conformance"]);
  expect(rosterFor(ch, roles, "review", "load-bearing")).toHaveLength(5);
  expect(rosterFor(ch, roles, "plan", "docs")).toEqual(["architect", "skeptic"]);
  expect(rosterFor(ch, roles, "plan", "standard")).toEqual(["product-advocate", "architect", "skeptic", "operator"]);
  expect(() => rosterFor({ ...ch, roster: { docs: ["ghost"] } }, roles, "review", "docs")).toThrow(/not defined in roles.toml: ghost/);
});

test("loadCharter throws when status != ready is requested strictly", () => {
  const root = fixture();
  const ch = loadCharter(root);
  expect(ch.status).toBe("ready");
});
```

- [ ] **Step 2: 실패 확인** — module not found (둘 다).

- [ ] **Step 3: 구현**

`factory/lib/frontmatter.js`:
```js
/** YAML 부분집합 파서: 스칼라(string/number/bool), 인라인 맵 {a: 1, b: [x, y]}, 인라인 배열 [a, b], 2칸 들여쓰기 1단계 중첩 맵. */
export function parseFrontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  if (!m) return { data: {}, body: md };
  return { data: parseBlock(m[1].split("\n")), body: md.slice(m[0].length) };
}

function parseBlock(lines) {
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const kv = /^([^\s:][^:]*):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`frontmatter: cannot parse line: ${line}`);
    const key = kv[1].trim(); const rest = kv[2].trim();
    if (rest === "") {
      // nested block: collect indented lines
      const sub = [];
      i++;
      while (i < lines.length && /^\s{2,}\S/.test(lines[i])) { sub.push(lines[i].replace(/^\s{2}/, "")); i++; }
      data[key] = parseBlock(sub);
      continue;
    }
    data[key] = parseValue(rest);
    i++;
  }
  return data;
}

function parseValue(s) {
  s = s.trim();
  if (s.startsWith("{")) return parseInlineMap(s);
  if (s.startsWith("[")) return parseInlineArray(s);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s.replace(/^["']|["']$/g, "");
}

/** 중괄호/대괄호 깊이를 고려해 최상위 콤마로 분할 */
function splitTop(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
function parseInlineMap(s) {
  const inner = s.slice(1, s.lastIndexOf("}")).trim();
  const obj = {};
  if (!inner) return obj;
  for (const part of splitTop(inner)) {
    const idx = part.indexOf(":");
    obj[part.slice(0, idx).trim()] = parseValue(part.slice(idx + 1));
  }
  return obj;
}
function parseInlineArray(s) {
  const inner = s.slice(1, s.lastIndexOf("]")).trim();
  if (!inner) return [];
  return splitTop(inner).map(parseValue);
}
```

`factory/lib/config.js`:
```js
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseFrontmatter } from "./frontmatter.js";

export function loadHarness(root) {
  return parseToml(readFileSync(join(root, ".factory/harness.toml"), "utf8"));
}
export function loadRoles(root) {
  return parseToml(readFileSync(join(root, ".factory/roles.toml"), "utf8"));
}
export function loadCharter(root) {
  const { data } = parseFrontmatter(readFileSync(join(root, "docs/factory/CHARTER.md"), "utf8"));
  if (data.schema !== "factory.charter.v1") throw new Error("CHARTER.md frontmatter must declare schema: factory.charter.v1");
  return {
    status: data.status ?? "draft",
    tier_default: data.tier_default ?? "standard",
    limits: { K: 3, M: 3, R: 2, ...(data.limits || {}) },
    roster: data.roster || {},
    plan_roles: data.plan_roles || {},
    plan_rounds: { docs: 2, default: 3, ...(data.plan_rounds || {}) },
    back_pressure: { awaiting_review_max: 4, quarantine_max: 5, ...(data.back_pressure || {}) },
    budget: data.budget || {},
    retro: data.retro || { every_merges: { initial: 1, min: 1, max: 20 }, light_on_merge: true },
  };
}

/** stage: "review" | "plan". 반환은 roles.toml에 정의된 이름만 허용. */
export function rosterFor(charter, roles, stage, tier) {
  let names;
  if (stage === "review") names = charter.roster[tier];
  else if (stage === "plan") names = charter.plan_roles[tier] || charter.plan_roles.default;
  else throw new Error(`no roster for stage ${stage}`);
  if (!names) throw new Error(`no ${stage} roster for tier ${tier} in CHARTER`);
  const defined = Object.keys(roles[stage] || {});
  const missing = names.filter((n) => !defined.includes(n));
  if (missing.length) throw new Error(`roster names not defined in roles.toml: ${missing.join(", ")}`);
  return [...names];
}
export function planRoundsFor(charter, tier) {
  return charter.plan_rounds[tier] ?? charter.plan_rounds.default;
}
```

- [ ] **Step 4: 통과·커밋** — frontmatter 2 passed, config 3 passed.
```bash
git add factory/lib/frontmatter.js factory/lib/config.js factory/test/frontmatter.test.js factory/test/config.test.js
git commit -m "feat(factory): frontmatter parser, harness/charter/roles config, roster lookup"
```

---

### Task 8: `lib/gh.js` — GitHub 접근 (gh CLI 래퍼)

**Interfaces:**
- Consumes: `run` (Task 2).
- Produces: `makeGh({ run, repo }) → { issue(n), comments(n), comment(n, body), setFactoryLabel(n, label), addLabels(n, labels), removeLabel(n, label), prHeadSha(pr), branchHeadSha(branch), createDraftPr({...}) }`. `issue(n) → {number, title, body, labels: string[]}`; `comments(n) → [{id, body, createdAt}]`.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/gh.test.js`:
```js
import { test, expect } from "vitest";
import { makeGh } from "../lib/gh.js";
import { makeFakeRun } from "../lib/exec.js";

const repo = "o/r";
test("issue() maps gh json; comments() maps id/body/createdAt", async () => {
  const run = makeFakeRun([
    { match: (c, a) => a.includes("view") && a.includes("--json"), result: { code: 0, stdout: JSON.stringify({ number: 5, title: "T", body: "B", labels: [{ name: "backlog" }, { name: "bug" }] }), stderr: "" } },
    { match: (c, a) => a[0] === "api" && a[1].includes("/comments"), result: { code: 0, stdout: JSON.stringify([{ id: 11, body: "x", created_at: "2026-09-11T00:00:00Z" }]), stderr: "" } },
  ]);
  const gh = makeGh({ run, repo });
  const issue = await gh.issue(5);
  expect(issue).toEqual({ number: 5, title: "T", body: "B", labels: ["backlog", "bug"] });
  expect(await gh.comments(5)).toEqual([{ id: 11, body: "x", createdAt: "2026-09-11T00:00:00Z" }]);
});

test("setFactoryLabel removes other factory state labels and adds the new one", async () => {
  const run = makeFakeRun([
    { match: (c, a) => a.includes("view"), result: { code: 0, stdout: JSON.stringify({ number: 5, title: "", body: "", labels: [{ name: "factory:ready" }, { name: "bug" }] }), stderr: "" } },
    { match: (c, a) => a.includes("edit"), result: { code: 0, stdout: "", stderr: "" } },
  ]);
  const gh = makeGh({ run, repo });
  await gh.setFactoryLabel(5, "factory:planned");
  const edit = run.calls.find((c) => c.args.includes("edit"));
  expect(edit.args).toEqual(["issue", "edit", "5", "-R", repo, "--remove-label", "factory:ready", "--add-label", "factory:planned"]);
});

test("comment() posts body via --body-file from stdin", async () => {
  const run = makeFakeRun([{ match: (c, a) => a.includes("comment"), result: { code: 0, stdout: "https://x/1#issuecomment-99", stderr: "" } }]);
  const gh = makeGh({ run, repo });
  const url = await gh.comment(5, "hello");
  expect(url).toContain("issuecomment-99");
  const call = run.calls[0];
  expect(call.args).toEqual(["issue", "comment", "5", "-R", repo, "--body-file", "-"]);
  expect(call.opts.input).toBe("hello");
});

test("non-zero exit throws with stderr", async () => {
  const run = makeFakeRun([{ match: () => true, result: { code: 1, stdout: "", stderr: "boom" } }]);
  await expect(makeGh({ run, repo }).issue(1)).rejects.toThrow(/boom/);
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/gh.js`:
```js
import { STATES } from "./labels.js";

export function makeGh({ run, repo }) {
  async function gh(args, opts = {}) {
    const r = await run("gh", args, opts);
    if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout;
  }
  return {
    async issue(n) {
      const j = JSON.parse(await gh(["issue", "view", String(n), "-R", repo, "--json", "number,title,body,labels"]));
      return { number: j.number, title: j.title, body: j.body || "", labels: (j.labels || []).map((l) => l.name) };
    },
    async comments(n) {
      const j = JSON.parse(await gh(["api", `repos/${repo}/issues/${n}/comments?per_page=100`, "--paginate"]));
      return j.map((c) => ({ id: c.id, body: c.body || "", createdAt: c.created_at }));
    },
    async comment(n, body) {
      return (await gh(["issue", "comment", String(n), "-R", repo, "--body-file", "-"], { input: body })).trim();
    },
    async addLabels(n, labels) {
      await gh(["issue", "edit", String(n), "-R", repo, ...labels.flatMap((l) => ["--add-label", l])]);
    },
    async removeLabel(n, label) {
      await gh(["issue", "edit", String(n), "-R", repo, "--remove-label", label]);
    },
    /** factory 상태 라벨을 정확히 하나로 맞춘다. */
    async setFactoryLabel(n, label) {
      const current = (await this.issue(n)).labels.filter((l) => STATES.has(l) && l !== label);
      const args = ["issue", "edit", String(n), "-R", repo, ...current.flatMap((l) => ["--remove-label", l]), "--add-label", label];
      await gh(args);
    },
    async prHeadSha(pr) {
      return JSON.parse(await gh(["pr", "view", String(pr), "-R", repo, "--json", "headRefOid"])).headRefOid;
    },
    async branchHeadSha(branch) {
      return JSON.parse(await gh(["api", `repos/${repo}/git/ref/heads/${branch}`])).object.sha;
    },
    async createDraftPr({ head, base, title, body }) {
      const out = await gh(["pr", "create", "-R", repo, "--draft", "--head", head, "--base", base, "--title", title, "--body-file", "-"], { input: body });
      const m = /\/pull\/(\d+)/.exec(out); return m ? Number(m[1]) : null;
    },
  };
}
```

- [ ] **Step 4: 통과·커밋** — 4 passed. `git commit -m "feat(factory): gh wrapper"`

---

### Task 9: `lib/claim.js` — lock 브랜치로 first-push-wins

**Interfaces:**
- Consumes: `run`.
- Produces: `claim({ run, cwd, issue, stage, runnerId }) → {ok, holder?}`; `release({ run, cwd, issue })`. lock ref: `refs/heads/factory/lock-<issue>`. 고유 커밋: `git commit-tree <empty-tree> -m "lock issue=<n> stage=<s> runner=<id> at=<iso>"` → `git push origin <sha>:refs/heads/factory/lock-<n>`; 거부(non-fast-forward / already exists)면 실패.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/claim.test.js`:
```js
import { test, expect } from "vitest";
import { claim, release } from "../lib/claim.js";
import { makeFakeRun } from "../lib/exec.js";

const base = [
  { match: (c, a) => c === "git" && a[0] === "hash-object", result: { code: 0, stdout: "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n", stderr: "" } },
  { match: (c, a) => c === "git" && a[0] === "commit-tree", result: { code: 0, stdout: "deadbeef".repeat(5) + "\n", stderr: "" } },
];

test("claim succeeds when push creates the lock ref", async () => {
  const run = makeFakeRun([...base, { match: (c, a) => c === "git" && a[0] === "push", result: { code: 0, stdout: "", stderr: " * [new branch] deadbeef -> factory/lock-7" } }]);
  const r = await claim({ run, cwd: "/repo", issue: 7, stage: "implement", runnerId: "gha-1" });
  expect(r.ok).toBe(true);
  const push = run.calls.find((c) => c.args[0] === "push");
  expect(push.args).toEqual(["push", "origin", "deadbeef".repeat(5) + ":refs/heads/factory/lock-7"]);
  const ct = run.calls.find((c) => c.args[0] === "commit-tree");
  expect(ct.args.join(" ")).toMatch(/lock issue=7 stage=implement runner=gha-1/);
});

test("claim fails (ok:false, holder from remote message) when ref exists", async () => {
  const run = makeFakeRun([...base,
    { match: (c, a) => c === "git" && a[0] === "push", result: { code: 1, stdout: "", stderr: "! [rejected] deadbeef -> factory/lock-7 (fetch first)" } },
    { match: (c, a) => c === "git" && a[0] === "ls-remote", result: { code: 0, stdout: "cafebabe\trefs/heads/factory/lock-7\n", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "fetch", result: { code: 0, stdout: "", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "log", result: { code: 0, stdout: "lock issue=7 stage=implement runner=local/mac at=2026-09-11T00:00:00Z\n", stderr: "" } },
  ]);
  const r = await claim({ run, cwd: "/repo", issue: 7, stage: "implement", runnerId: "gha-2" });
  expect(r.ok).toBe(false);
  expect(r.holder).toMatch(/runner=local\/mac/);
});

test("release deletes the lock ref", async () => {
  const run = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "push", result: { code: 0, stdout: "", stderr: "" } }]);
  await release({ run, cwd: "/repo", issue: 7 });
  expect(run.calls[0].args).toEqual(["push", "origin", "--delete", "refs/heads/factory/lock-7"]);
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/claim.js`:
```js
export const lockRef = (issue) => `refs/heads/factory/lock-${issue}`;

export async function claim({ run, cwd, issue, stage, runnerId, now = new Date().toISOString() }) {
  const g = (args) => run("git", args, { cwd });
  const tree = (await g(["hash-object", "-t", "tree", "/dev/null"])).stdout.trim();       // empty tree
  const msg = `lock issue=${issue} stage=${stage} runner=${runnerId} at=${now}`;
  const commit = (await g(["commit-tree", tree, "-m", msg])).stdout.trim();
  const push = await g(["push", "origin", `${commit}:${lockRef(issue)}`]);
  if (push.code === 0) return { ok: true, commit };
  // someone else holds it — read who
  await g(["fetch", "origin", `${lockRef(issue)}:${lockRef(issue)}`]);
  const who = (await g(["log", "-1", "--format=%s", lockRef(issue)])).stdout.trim();
  return { ok: false, holder: who || "unknown", stderr: push.stderr };
}

export async function release({ run, cwd, issue }) {
  const r = await run("git", ["push", "origin", "--delete", lockRef(issue)], { cwd });
  return r.code === 0;
}
```
`ls-remote` 매처는 테스트가 허용할 뿐 구현이 호출하지 않아도 된다(테이블 순서상 무해).

- [ ] **Step 4: 통과·커밋** — 3 passed. `git commit -m "feat(factory): lock-branch claim (first-push-wins)"`

---

### Task 10: `lib/heartbeat.js` + `lib/run-record.js`

**Interfaces:**
- Produces: `startHeartbeat({ gh, issue, stage, runnerId, intervalMs, now }) → {stop()}` — 첫 호출에 코멘트 `<!-- factory-heartbeat issue=N -->` 작성, 이후 `intervalMs`마다 같은 코멘트를 갱신(gh api PATCH). `appendRunRecord({ root, issue, stage, runnerId, lines, now }) → path` — `docs/factory/runs/<issue>.md` 없으면 헤더 생성 후 섹션 append (§9 형식).

- [ ] **Step 1: 실패하는 테스트**

`factory/test/run-record.test.js`:
```js
import { test, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendRunRecord } from "../lib/run-record.js";

test("creates file with header then appends stage sections", () => {
  const root = mkdtempSync(join(tmpdir(), "rr-"));
  const p = appendRunRecord({ root, issue: 123, title: "incremental sync", stage: "triage", runnerId: "gha-1", now: "2026-09-08T09:02:00Z", lines: ["disposition: ready · tier: load-bearing"] });
  appendRunRecord({ root, issue: 123, stage: "plan", runnerId: "gha-2", now: "2026-09-08T09:21:00Z", lines: ["rounds: 3", "handoff: comment 3021"] });
  const txt = readFileSync(p, "utf8");
  expect(txt.startsWith("# Run · #123 incremental sync\n")).toBe(true);
  expect(txt).toContain("## triage · 2026-09-08T09:02Z · gha-1\ndisposition: ready · tier: load-bearing\n");
  expect(txt).toContain("## plan · 2026-09-08T09:21Z · gha-2\nrounds: 3\nhandoff: comment 3021\n");
  expect(p).toBe(join(root, "docs/factory/runs/123.md"));
});
```

`factory/test/heartbeat.test.js`:
```js
import { test, expect, vi } from "vitest";
import { startHeartbeat } from "../lib/heartbeat.js";

test("posts once, then patches on each tick; stop() clears the timer", async () => {
  vi.useFakeTimers();
  const gh = { comment: vi.fn(async () => "https://x/1#issuecomment-42"), patchComment: vi.fn(async () => {}) };
  const hb = await startHeartbeat({ gh, issue: 7, stage: "implement", runnerId: "gha-1", intervalMs: 1000, now: () => "T0" });
  expect(gh.comment).toHaveBeenCalledTimes(1);
  expect(gh.comment.mock.calls[0][1]).toMatch(/<!-- factory-heartbeat issue=7 -->/);
  expect(gh.comment.mock.calls[0][1]).toMatch(/runner: gha-1/);
  await vi.advanceTimersByTimeAsync(2500);
  expect(gh.patchComment).toHaveBeenCalledTimes(2);
  expect(gh.patchComment.mock.calls[0][0]).toBe(42);
  hb.stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(gh.patchComment).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
```

- [ ] **Step 2: 실패 확인** — module not found (둘 다).

- [ ] **Step 3: 구현**

`factory/lib/run-record.js`:
```js
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";

const short = (iso) => iso.replace(/:\d{2}(\.\d+)?Z$/, "Z"); // 2026-09-08T09:02:00Z → 2026-09-08T09:02Z

export function appendRunRecord({ root, issue, title = "", stage, runnerId, lines = [], now = new Date().toISOString() }) {
  const p = join(root, "docs/factory/runs", `${issue}.md`);
  mkdirSync(dirname(p), { recursive: true });
  if (!existsSync(p)) writeFileSync(p, `# Run · #${issue}${title ? " " + title : ""}\n`);
  appendFileSync(p, `\n## ${stage} · ${short(now)} · ${runnerId}\n${lines.join("\n")}\n`);
  return p;
}
```

`factory/lib/heartbeat.js`:
```js
export async function startHeartbeat({ gh, issue, stage, runnerId, intervalMs = 10 * 60 * 1000, now = () => new Date().toISOString() }) {
  const body = (n) => `<!-- factory-heartbeat issue=${issue} -->\nstage: ${stage} · runner: ${runnerId} · started: ${n.started} · last: ${n.last}`;
  const started = now();
  const url = await gh.comment(issue, body({ started, last: started }));
  const id = Number(/issuecomment-(\d+)/.exec(url)?.[1]);
  const timer = setInterval(() => { gh.patchComment(id, body({ started, last: now() })).catch(() => {}); }, intervalMs);
  return { commentId: id, stop: () => clearInterval(timer) };
}
```
그리고 `lib/gh.js`에 메서드 추가:
```js
    async patchComment(commentId, body) {
      await gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "-f", `body=${body}`]);
    },
```

- [ ] **Step 4: 통과·커밋** — run-record 1, heartbeat 1 passed.
```bash
git add factory/lib/run-record.js factory/lib/heartbeat.js factory/lib/gh.js factory/test/run-record.test.js factory/test/heartbeat.test.js
git commit -m "feat(factory): run record and heartbeat"
```

---

### Task 11: `lib/agents-log.js` — 훅이 남긴 agents.jsonl 읽기 (+ hooks/record-agents.sh)

**Interfaces:**
- Consumes: Task 1의 `AGENT_TYPE_FORMAT`.
- Produces: `readAgentsLog(path) → {starts: [{agent_id, agent_type, at?}], stops: [...], completed: string[] /*agent_type of agents with both start and stop*/, orphans: string[]}`; `normalizeAgentType(raw) → string` (Task 1 결과에 따라 항등 또는 변환). 파일 `factory/hooks/record-agents.sh` (Task 1의 것을 패키지로 이동).

- [ ] **Step 1: 실패하는 테스트**

`factory/test/agents-log.test.js`:
```js
import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readAgentsLog, normalizeAgentType } from "../lib/agents-log.js";

test("pairs starts and stops by agent_id and lists completed agent types", () => {
  const dir = mkdtempSync(join(tmpdir(), "al-"));
  const p = join(dir, "agents.jsonl");
  writeFileSync(p, [
    JSON.stringify({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "reviewer-correctness" }),
    JSON.stringify({ hook_event_name: "SubagentStart", agent_id: "a2", agent_type: "reviewer-qa" }),
    JSON.stringify({ hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "reviewer-correctness" }),
    "not json",
    "",
  ].join("\n"));
  const log = readAgentsLog(p);
  expect(log.starts).toHaveLength(2);
  expect(log.completed).toEqual(["reviewer-correctness"]);
  expect(log.orphans).toEqual(["reviewer-qa"]);
});

test("missing file → empty log", () => {
  expect(readAgentsLog("/nonexistent/agents.jsonl")).toEqual({ starts: [], stops: [], completed: [], orphans: [] });
});

test("normalizeAgentType is identity for plain names (adjust if spike-9 shows another format)", () => {
  expect(normalizeAgentType("reviewer-correctness")).toBe("reviewer-correctness");
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/agents-log.js`:
```js
import { existsSync, readFileSync } from "node:fs";

/** Task 1(spike-9)의 관측에 맞춰 조정한다. 관측값이 frontmatter name과 같으면 항등. */
export function normalizeAgentType(raw) {
  return String(raw ?? "").trim();
}

export function readAgentsLog(path) {
  const empty = { starts: [], stops: [], completed: [], orphans: [] };
  if (!existsSync(path)) return empty;
  const starts = [], stops = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const rec = { agent_id: j.agent_id, agent_type: normalizeAgentType(j.agent_type) };
    if (j.hook_event_name === "SubagentStart") starts.push(rec);
    else if (j.hook_event_name === "SubagentStop") stops.push(rec);
  }
  const stopped = new Set(stops.map((s) => s.agent_id));
  const completed = starts.filter((s) => stopped.has(s.agent_id)).map((s) => s.agent_type);
  const orphans = starts.filter((s) => !stopped.has(s.agent_id)).map((s) => s.agent_type);
  return { starts, stops, completed, orphans };
}
```

`factory/hooks/record-agents.sh` — Task 1 Step 2와 동일 내용, `.factory/out/agents.jsonl`에 기록, `chmod +x`.

- [ ] **Step 4: 통과·커밋** — 3 passed. `git add factory/lib/agents-log.js factory/hooks/record-agents.sh factory/test/agents-log.test.js && git commit -m "feat(factory): agents.jsonl reader + record-agents hook"`

---

### Task 12: `lib/verify-stage.js` — 스테이지 산출물 검증

**Interfaces:**
- Consumes: `readAgentsLog` (Task 11), `validate` (Task 5).
- Produces: `verifyStage({ stage, out, agentsLog, roster, expectedRounds, orchestration }) → {ok, reasons: string[], data}`. `out`은 `claude -p --output-format json`의 파싱 결과; `out.result`는 workflow가 돌려준 객체를 JSON 문자열로 담은 텍스트(디스패처가 verbatim 반환). 검사: (1) `out.is_error !== true`, `out.result`에서 JSON 추출 가능; (2) 추출 객체가 스테이지 schema를 만족(`plan.v1` / `implement.v1` / `review.v1` / `triage.v1`); (3) `agentsLog.completed`가 로스터의 각 역할을 **최소 1회** 포함(plan/review); (4) `data.orchestration === orchestration`; (5) plan은 `data.rounds === expectedRounds`.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/verify-stage.test.js`:
```js
import { test, expect } from "vitest";
import { verifyStage } from "../lib/verify-stage.js";

const review = { schema: "factory.review.v1", issue: 7, pr: 9, head_sha: "a".repeat(40), round: 1, orchestration: "workflow", guarantee: "verified",
  verdicts: [{ role: "correctness", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] }, { role: "qa", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] }] };
const out = (obj, extra = {}) => ({ is_error: false, result: "The workflow returned:\n```json\n" + JSON.stringify(obj) + "\n```", ...extra });
const log = (types) => ({ starts: [], stops: [], completed: types, orphans: [] });

test("passes when result parses, schema ok, roster covered, orchestration matches", () => {
  const r = verifyStage({ stage: "review", out: out(review), agentsLog: log(["reviewer-correctness", "reviewer-qa", "reviewer-correctness"]), roster: ["correctness", "qa"], rolePrefix: "reviewer-", orchestration: "workflow" });
  expect(r.ok).toBe(true);
  expect(r.data.verdicts).toHaveLength(2);
});

test("fails: is_error, no json in result, schema invalid", () => {
  expect(verifyStage({ stage: "review", out: { is_error: true, result: "x" }, agentsLog: log([]), roster: [], orchestration: "workflow" }).reasons).toContain("claude -p reported is_error");
  expect(verifyStage({ stage: "review", out: { is_error: false, result: "no json here" }, agentsLog: log([]), roster: [], orchestration: "workflow" }).reasons.join()).toMatch(/no JSON object in result/);
  expect(verifyStage({ stage: "review", out: out({ ...review, verdicts: [] }), agentsLog: log([]), roster: [], orchestration: "workflow" }).reasons.join()).toMatch(/schema/);
});

test("fails: roster role never completed; orchestration mismatch", () => {
  const r = verifyStage({ stage: "review", out: out(review), agentsLog: log(["reviewer-correctness"]), roster: ["correctness", "qa"], rolePrefix: "reviewer-", orchestration: "workflow" });
  expect(r.ok).toBe(false);
  expect(r.reasons.join()).toMatch(/roster role not completed: qa/);
  const r2 = verifyStage({ stage: "review", out: out(review), agentsLog: log(["reviewer-correctness", "reviewer-qa"]), roster: ["correctness", "qa"], rolePrefix: "reviewer-", orchestration: "agent" });
  expect(r2.reasons.join()).toMatch(/orchestration/);
});

test("plan checks rounds", () => {
  const plan = { schema: "factory.plan.v1", issue: 7, tier: "docs", roles: ["architect", "skeptic"], rounds: 2, done_when: [{ id: "d", text: "t", verify: "v", level: "unit" }], files_expected: [], dissent_log: [], non_goals: [], open_risks: [], orchestration: "workflow" };
  const ok = verifyStage({ stage: "plan", out: out(plan), agentsLog: log(["plan-architect", "plan-skeptic", "plan-synthesizer"]), roster: ["architect", "skeptic"], rolePrefix: "plan-", expectedRounds: 2, orchestration: "workflow" });
  expect(ok.ok).toBe(true);
  const bad = verifyStage({ stage: "plan", out: out({ ...plan, rounds: 3 }), agentsLog: log(["plan-architect", "plan-skeptic"]), roster: ["architect", "skeptic"], rolePrefix: "plan-", expectedRounds: 2, orchestration: "workflow" });
  expect(bad.reasons.join()).toMatch(/rounds/);
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/verify-stage.js`:
```js
import { validate } from "./schemas.js";

const SCHEMA_OF = { triage: "triage.v1", plan: "plan.v1", implement: "implement.v1", review: "review.v1" };

/** result 텍스트에서 첫 JSON 객체를 꺼낸다: ```json 펜스 우선, 없으면 첫 '{'부터 균형 잡힌 '}'까지. */
export function extractJson(text) {
  if (typeof text !== "string") return null;
  const fence = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  const candidates = fence ? [fence[1]] : [];
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      if (text[i] === "}") { depth--; if (depth === 0) { candidates.push(text.slice(start, i + 1)); break; } }
    }
  }
  for (const c of candidates) { try { return JSON.parse(c); } catch { /* try next */ } }
  return null;
}

export function verifyStage({ stage, out, agentsLog, roster = [], rolePrefix = "", expectedRounds, orchestration }) {
  const reasons = [];
  if (!out || out.is_error) reasons.push("claude -p reported is_error");
  const data = out ? extractJson(out.result) : null;
  if (!data) reasons.push("no JSON object in result");
  if (data && SCHEMA_OF[stage]) {
    const v = validate(SCHEMA_OF[stage], data);
    if (!v.ok) reasons.push(`schema ${SCHEMA_OF[stage]}: ${v.errors.join("; ")}`);
  }
  if (data && orchestration && data.orchestration !== orchestration) reasons.push(`orchestration ${data.orchestration} != configured ${orchestration}`);
  if (stage === "plan" && data && expectedRounds != null && data.rounds !== expectedRounds) reasons.push(`rounds ${data.rounds} != expected ${expectedRounds}`);
  for (const role of roster) {
    if (!agentsLog.completed.includes(rolePrefix + role)) reasons.push(`roster role not completed: ${role}`);
  }
  return { ok: reasons.length === 0, reasons, data };
}
```

- [ ] **Step 4: 통과·커밋** — 4 passed. `git commit -m "feat(factory): verify-stage (post-hoc artifact/roster check)"`

---

### Task 13: `lib/aggregate.js` — 리뷰 집계 (LLM 없음)

**Interfaces:**
- Produces: `aggregateReview({ verdicts, rosterSize, previousMustFix = [], responses = [], rulings = [] }) → {decision: "approved"|"rework"|"incomplete", must_fix: [...], missing_roles: [...]}`. 규칙(§7.5): 판정 수 < rosterSize → `incomplete`; 전원 approve → `approved`; 하나라도 reject → `rework` + must_fix 합집합(id 중복 제거). disputed 항목의 리뷰어 판정 `rulings: [{id, ruling: "withdraw"|"uphold"}]` — `uphold`면 그 항목이 이번 라운드 must_fix에 남고 decision은 `rework`.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/aggregate.test.js`:
```js
import { test, expect } from "vitest";
import { aggregateReview } from "../lib/aggregate.js";

const v = (role, verdict, ids = []) => ({ role, verdict, confidence: "high", must_fix: ids.map((id) => ({ id, where: "w", claim: "c", evidence: "e" })), should_fix: [], verified: [] });

test("all approve → approved", () => {
  expect(aggregateReview({ verdicts: [v("a", "approve"), v("b", "approve")], rosterSize: 2 })).toEqual({ decision: "approved", must_fix: [], missing_roles: [] });
});
test("any reject → rework with deduped must_fix union", () => {
  const r = aggregateReview({ verdicts: [v("a", "reject", ["cf1", "cf2"]), v("b", "reject", ["cf2", "qa1"])], rosterSize: 2 });
  expect(r.decision).toBe("rework");
  expect(r.must_fix.map((m) => m.id)).toEqual(["cf1", "cf2", "qa1"]);
});
test("fewer verdicts than roster → incomplete", () => {
  const r = aggregateReview({ verdicts: [v("a", "approve")], rosterSize: 2, rosterRoles: ["a", "b"] });
  expect(r.decision).toBe("incomplete");
  expect(r.missing_roles).toEqual(["b"]);
});
test("upheld disputes keep rework even when all new verdicts approve", () => {
  const r = aggregateReview({ verdicts: [v("a", "approve"), v("b", "approve")], rosterSize: 2, rulings: [{ id: "cf1", ruling: "uphold", by: "a" }] });
  expect(r.decision).toBe("rework");
  expect(r.must_fix.map((m) => m.id)).toEqual(["cf1"]);
  const w = aggregateReview({ verdicts: [v("a", "approve"), v("b", "approve")], rosterSize: 2, rulings: [{ id: "cf1", ruling: "withdraw", by: "a" }] });
  expect(w.decision).toBe("approved");
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/aggregate.js`:
```js
export function aggregateReview({ verdicts, rosterSize, rosterRoles = [], rulings = [] }) {
  const missing_roles = rosterRoles.filter((r) => !verdicts.some((v) => v.role === r));
  if (verdicts.length < rosterSize) return { decision: "incomplete", must_fix: [], missing_roles };
  const byId = new Map();
  for (const v of verdicts) if (v.verdict === "reject") for (const m of v.must_fix) if (!byId.has(m.id)) byId.set(m.id, { ...m, by: v.role });
  for (const r of rulings) if (r.ruling === "uphold" && !byId.has(r.id)) byId.set(r.id, { id: r.id, where: "-", claim: "disputed item upheld", evidence: `ruling by ${r.by}`, by: r.by });
  const must_fix = [...byId.values()];
  return { decision: must_fix.length === 0 ? "approved" : "rework", must_fix, missing_roles: [] };
}
```

- [ ] **Step 4: 통과·커밋** — 4 passed. `git commit -m "feat(factory): review aggregation"`

---

### Task 14: `lib/transition.js` — 전이 실행 (그래프 + 요구 + 라벨)

**Interfaces:**
- Consumes: `canTransition`, `factoryLabelOf` (Task 3), `requirementFor` (Task 6), `gh` (Task 8).
- Produces: `transition({ gh, issue, to, ctxExtra = {}, human = false, reason }) → {ok, from, to, reason?}`. 절차: 이슈 라벨 읽기 → `from` 결정 → `canTransition(from,to)` 아니면 `{ok:false}` (변경 없음) → `requirementFor(to)({comments, ...ctxExtra})` 실패면 **`factory:needs-human`으로 전이하고** 사유 코멘트(`<!-- factory-transition-refused -->`) 남김 → 통과면 `setFactoryLabel` + 전이 코멘트(`<!-- factory-transition:v1 from=.. to=.. by=script|human -->`). `human=true`면 그래프 검사는 유지하되 요구 검사 실패 시 needs-human 대신 `{ok:false, reason}`만 반환(사람에게 보고).

- [ ] **Step 1: 실패하는 테스트**

`factory/test/transition.test.js`:
```js
import { test, expect, vi } from "vitest";
import { transition } from "../lib/transition.js";
import { renderHandoff } from "../lib/handoff.js";

function fakeGh(labels, comments = []) {
  return { issue: vi.fn(async () => ({ number: 7, title: "t", body: "", labels })), comments: vi.fn(async () => comments),
    setFactoryLabel: vi.fn(async () => {}), comment: vi.fn(async () => "url#issuecomment-1") };
}

test("graph violation → ok:false, no label change", async () => {
  const gh = fakeGh(["backlog"]);
  const r = await transition({ gh, issue: 7, to: "factory:approved" });
  expect(r.ok).toBe(false); expect(r.reason).toMatch(/not allowed/);
  expect(gh.setFactoryLabel).not.toHaveBeenCalled();
});

test("requirement failure → moves to needs-human with refusal comment", async () => {
  const gh = fakeGh(["factory:ready"]);   // no plan handoff
  const r = await transition({ gh, issue: 7, to: "factory:planned" });
  expect(r.ok).toBe(false);
  expect(gh.setFactoryLabel).toHaveBeenCalledWith(7, "factory:needs-human");
  expect(gh.comment.mock.calls[0][1]).toMatch(/factory-transition-refused/);
  expect(gh.comment.mock.calls[0][1]).toMatch(/plan handoff missing/);
});

test("requirement pass → label set + transition comment", async () => {
  const triage = renderHandoff({ stage: "triage", issue: 7, summary: "s", data: { schema: "factory.triage.v1", issue: 7, disposition: "ready", tier: "docs" } });
  const gh = fakeGh(["factory:queue"], [{ id: 1, body: triage, createdAt: "2026-09-11T00:00:00Z" }]);
  const r = await transition({ gh, issue: 7, to: "factory:ready" });
  expect(r).toEqual({ ok: true, from: "factory:queue", to: "factory:ready" });
  expect(gh.setFactoryLabel).toHaveBeenCalledWith(7, "factory:ready");
  expect(gh.comment.mock.calls[0][1]).toMatch(/factory-transition:v1 from=factory:queue to=factory:ready by=script/);
});

test("human override: requirement failure returns reason, does not move to needs-human", async () => {
  const gh = fakeGh(["factory:ready"]);
  const r = await transition({ gh, issue: 7, to: "factory:planned", human: true, reason: "manual" });
  expect(r.ok).toBe(false); expect(r.reason).toMatch(/plan handoff missing/);
  expect(gh.setFactoryLabel).not.toHaveBeenCalled();
});

test("issue with no factory label is treated as from=null and rejected", async () => {
  const gh = fakeGh(["bug"]);
  const r = await transition({ gh, issue: 7, to: "factory:queue" });
  expect(r.ok).toBe(false); expect(r.reason).toMatch(/no factory state label/);
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/transition.js`:
```js
import { canTransition, factoryLabelOf } from "./labels.js";
import { requirementFor } from "./requirements.js";

export async function transition({ gh, issue, to, ctxExtra = {}, human = false, reason = "" }) {
  const it = await gh.issue(issue);
  const from = factoryLabelOf(it.labels);
  if (!from) return { ok: false, from, to, reason: "no factory state label on issue" };
  if (!canTransition(from, to)) return { ok: false, from, to, reason: `transition ${from} → ${to} not allowed` };
  const comments = await gh.comments(issue);
  const req = requirementFor(to)({ comments, ...ctxExtra });
  if (!req.ok) {
    if (human) return { ok: false, from, to, reason: req.reason };
    await gh.setFactoryLabel(issue, "factory:needs-human");
    await gh.comment(issue, `<!-- factory-transition-refused from=${from} to=${to} -->\n**전이 거부** ${from} → ${to}: ${req.reason}\n\n라벨을 \`factory:needs-human\`으로 옮겼습니다. 산출물을 보강한 뒤 \`:unstick\`으로 재개하세요.`);
    return { ok: false, from, to: "factory:needs-human", reason: req.reason };
  }
  await gh.setFactoryLabel(issue, to);
  await gh.comment(issue, `<!-- factory-transition:v1 from=${from} to=${to} by=${human ? "human" : "script"} -->\n${from} → ${to}${reason ? ` — ${reason}` : ""}`);
  return { ok: true, from, to };
}
```

- [ ] **Step 4: 통과·커밋** — 5 passed. `git commit -m "feat(factory): transition with handoff-gated refusal"`

---

### Task 15: `lib/context.js` — context.json 조립

**Interfaces:**
- Consumes: `loadHarness/loadCharter/loadRoles/rosterFor/planRoundsFor` (Task 7), `latestHandoff` (Task 4), gh.
- Produces: `buildContext({ root, gh, issue, stage }) → object` 및 파일 `.factory/out/context.json`. 내용: `{ issue: {number,title,body,labels}, stage, tier, roster: [..], role_agents: {name: agentPath}, lessons: {name: lessonsPath}, rounds, limits, back_pressure, orchestration, spec_path?, handoffs: { triage?, plan?, implement?, review? }, harness: {maturity, commands, gates} }`. tier는 triage handoff의 `tier`, 없으면 `charter.tier_default`. `spec_path`는 이슈 본문에서 `docs/features/NNN.md` 링크를 찾아 채운다.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/context.test.js`:
```js
import { test, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildContext } from "../lib/context.js";
import { renderHandoff } from "../lib/handoff.js";

function root() {
  const r = mkdtempSync(join(tmpdir(), "ctx-"));
  mkdirSync(join(r, ".factory"), { recursive: true }); mkdirSync(join(r, "docs/factory"), { recursive: true });
  writeFileSync(join(r, ".factory/harness.toml"), `schema = 1\n[harness]\nmaturity = "M0"\n[factory]\norchestration = "workflow"\n[commands]\nunit = "npm test"\n[gates]\nrequired = ["unit"]\nfast = ["unit"]\nfull = ["unit"]\ndeep = ["unit"]\n`);
  writeFileSync(join(r, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: ready\ntier_default: standard\nroster:\n  docs: [correctness]\n  standard: [correctness, qa]\nplan_roles:\n  docs: [architect, skeptic]\n  default: [architect, skeptic, operator]\nplan_rounds: { docs: 2, default: 3 }\n---\n`);
  writeFileSync(join(r, ".factory/roles.toml"), `[review.correctness]\nagent = ".claude/agents/reviewer-correctness.md"\nlessons = ".factory/lessons/reviewer-correctness.md"\n[review.qa]\nagent = ".claude/agents/reviewer-qa.md"\n[plan.architect]\nagent = "a.md"\n[plan.skeptic]\nagent = "s.md"\n[plan.operator]\nagent = "o.md"\n`);
  return r;
}

test("review context: tier from triage handoff, roster from charter, agents/lessons from roles, handoffs, spec_path from body", async () => {
  const r = root();
  const triage = renderHandoff({ stage: "triage", issue: 7, summary: "s", data: { schema: "factory.triage.v1", issue: 7, disposition: "ready", tier: "docs" } });
  const gh = { issue: vi.fn(async () => ({ number: 7, title: "T", body: "see docs/features/012.md", labels: ["factory:awaiting-review"] })), comments: vi.fn(async () => [{ id: 1, body: triage, createdAt: "2026-09-11T00:00:00Z" }]) };
  const ctx = await buildContext({ root: r, gh, issue: 7, stage: "review" });
  expect(ctx.tier).toBe("docs");
  expect(ctx.roster).toEqual(["correctness"]);
  expect(ctx.role_agents).toEqual({ correctness: ".claude/agents/reviewer-correctness.md" });
  expect(ctx.lessons).toEqual({ correctness: ".factory/lessons/reviewer-correctness.md" });
  expect(ctx.handoffs.triage.tier).toBe("docs");
  expect(ctx.spec_path).toBe("docs/features/012.md");
  expect(ctx.orchestration).toBe("workflow");
  expect(ctx.harness.maturity).toBe("M0");
  expect(existsSync(join(r, ".factory/out/context.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(r, ".factory/out/context.json"), "utf8")).issue.number).toBe(7);
});

test("plan context uses plan_roles and plan_rounds; tier falls back to default", async () => {
  const r = root();
  const gh = { issue: vi.fn(async () => ({ number: 8, title: "T", body: "", labels: ["factory:ready"] })), comments: vi.fn(async () => []) };
  const ctx = await buildContext({ root: r, gh, issue: 8, stage: "plan" });
  expect(ctx.tier).toBe("standard");
  expect(ctx.roster).toEqual(["architect", "skeptic", "operator"]);
  expect(ctx.rounds).toBe(3);
  expect(ctx.spec_path).toBe(null);
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/context.js`:
```js
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadHarness, loadCharter, loadRoles, rosterFor, planRoundsFor } from "./config.js";
import { latestHandoff } from "./handoff.js";

const ROSTER_STAGE = { plan: "plan", review: "review" };

export async function buildContext({ root, gh, issue, stage }) {
  const harness = loadHarness(root), charter = loadCharter(root), roles = loadRoles(root);
  const it = await gh.issue(issue);
  const comments = await gh.comments(issue);
  const handoffs = {};
  for (const s of ["triage", "plan", "implement", "review"]) { const h = latestHandoff(comments, s); if (h) handoffs[s] = h.data; }
  const tier = handoffs.triage?.tier ?? charter.tier_default;
  const rs = ROSTER_STAGE[stage];
  const roster = rs ? rosterFor(charter, roles, rs, tier) : [];
  const role_agents = {}, lessons = {};
  for (const name of roster) { const def = roles[rs][name]; role_agents[name] = def.agent; if (def.lessons) lessons[name] = def.lessons; }
  const spec = /docs\/features\/\d+[\w-]*\.md/.exec(it.body || "");
  const ctx = {
    issue: it, stage, tier, roster, role_agents, lessons,
    rounds: stage === "plan" ? planRoundsFor(charter, tier) : undefined,
    limits: charter.limits, back_pressure: charter.back_pressure,
    orchestration: harness.factory?.orchestration ?? "workflow",
    spec_path: spec ? spec[0] : null,
    handoffs,
    harness: { maturity: harness.harness?.maturity, commands: harness.commands, gates: harness.gates },
  };
  mkdirSync(join(root, ".factory/out"), { recursive: true });
  writeFileSync(join(root, ".factory/out/context.json"), JSON.stringify(ctx, null, 2));
  return ctx;
}
```

- [ ] **Step 4: 통과·커밋** — 2 passed. `git commit -m "feat(factory): context builder"`

---

### Task 16: 훅 스크립트 — `block-dangerous.sh`, `stop-guard.sh` + 테스트

**Interfaces:**
- Produces: `factory/hooks/block-dangerous.sh` (PreToolUse Bash; stdin JSON `.tool_input.command`가 `gh pr merge`, `git merge`, `git push --force|-f`, `git push origin --delete refs/heads/factory/lock`(자기 lock 외), 또는 `.factory/`, `.claude/`, `.github/workflows/factory-`, `docs/factory/CHARTER.md`에 대한 `sed -i|tee|>|>>` 쓰기를 포함하면 exit 2), `factory/hooks/stop-guard.sh` (Stop; 현재 브랜치가 `claude/fq-*`이고 미커밋 또는 미push면 exit 2). 로깅 훅과 달리 이 둘은 판정 훅이다.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/hooks.test.js`:
```js
import { test, expect } from "vitest";
import { run } from "../lib/exec.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const H = new URL("../hooks/", import.meta.url).pathname;
const bash = (script, input, cwd) => run("bash", [join(H, script)], { input: JSON.stringify(input), cwd });
const cmd = (c) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: c } });

test("block-dangerous: blocks merges, force pushes, protected writes; allows normal commands", async () => {
  for (const c of ["gh pr merge 5", "git merge feature", "git push --force origin x", "git push -f origin x", "git push origin --force-with-lease",
                   "echo x > .factory/harness.toml", "sed -i 's/a/b/' .claude/settings.json", "cat foo | tee docs/factory/CHARTER.md", "echo y >> .github/workflows/factory-implement.yml"]) {
    const r = await bash("block-dangerous.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: blocked/);
  }
  for (const c of ["git push origin HEAD", "git commit -m x", "npm test", "cat .factory/harness.toml", "gh pr view 5"]) {
    expect((await bash("block-dangerous.sh", cmd(c))).code, c).toBe(0);
  }
});

test("block-dangerous: non-Bash tools and malformed input pass through", async () => {
  expect((await bash("block-dangerous.sh", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: ".factory/x" } })).code).toBe(0);
  expect((await run("bash", [join(H, "block-dangerous.sh")], { input: "not json" })).code).toBe(0);
});

test("stop-guard: non-factory branch passes; factory branch with dirty tree blocks", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sg-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd });
  expect((await bash("stop-guard.sh", { hook_event_name: "Stop" }, cwd)).code).toBe(0);            // main
  await run("git", ["checkout", "-q", "-b", "claude/fq-7"], { cwd });
  await run("bash", ["-c", "echo x > f.txt"], { cwd });
  const r = await bash("stop-guard.sh", { hook_event_name: "Stop" }, cwd);
  expect(r.code).toBe(2); expect(r.stderr).toMatch(/uncommitted/);
  await run("git", ["add", "."], { cwd }); await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "w"], { cwd });
  const r2 = await bash("stop-guard.sh", { hook_event_name: "Stop" }, cwd);
  expect(r2.code).toBe(2); expect(r2.stderr).toMatch(/unpushed|no upstream/);
});
```

- [ ] **Step 2: 실패 확인** — `bash: .../block-dangerous.sh: No such file` → code 127 ≠ 2.

- [ ] **Step 3: 구현**

`factory/hooks/block-dangerous.sh`:
```bash
#!/usr/bin/env bash
# PreToolUse(Bash) 판정 훅. 위험 명령이면 exit 2(차단). 그 외 항상 exit 0. jq 실패 등 어떤 오류도 0으로 끝난다(ADR-009) — 단 명확히 매치된 위험 명령만 2.
input=$(cat) || exit 0
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
[ "$tool" = "Bash" ] || exit 0
c=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$c" ] || exit 0

block() { echo "factory: blocked — $1" >&2; exit 2; }

echo "$c" | grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+pr[[:space:]]+merge' && block "gh pr merge"
echo "$c" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+merge([[:space:]]|$)' && block "git merge"
echo "$c" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+push[^;&|]*[[:space:]](--force|-f|--force-with-lease)([[:space:]]|$)' && block "force push"
# protected paths written via shell redirection / sed -i / tee
prot='(\.factory/|\.claude/|\.github/workflows/factory-|docs/factory/CHARTER\.md)'
echo "$c" | grep -Eq "(>>?|tee[[:space:]]+(-a[[:space:]]+)?)[[:space:]]*[\"']?[^[:space:]\"']*$prot" && block "write to protected path"
echo "$c" | grep -Eq "sed[[:space:]]+(-[a-zA-Z]*i[a-zA-Z]*[[:space:]]+)[^;&|]*$prot" && block "sed -i on protected path"
exit 0
```

`factory/hooks/stop-guard.sh`:
```bash
#!/usr/bin/env bash
# Stop 판정 훅. factory 작업 브랜치(claude/fq-*)에서 미커밋/미push 변경이 있으면 종료를 거부한다(exit 2).
input=$(cat) || true
branch=$(git branch --show-current 2>/dev/null) || exit 0
case "$branch" in claude/fq-*) ;; *) exit 0 ;; esac
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "factory: uncommitted changes on $branch — commit and push before stopping" >&2; exit 2
fi
if ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  echo "factory: no upstream for $branch — push before stopping" >&2; exit 2
fi
if [ -n "$(git log '@{u}..HEAD' --oneline 2>/dev/null)" ]; then
  echo "factory: unpushed commits on $branch — push before stopping" >&2; exit 2
fi
exit 0
```
`chmod +x factory/hooks/*.sh`

- [ ] **Step 4: 통과·커밋** — 3 passed. `git commit -m "feat(factory): block-dangerous and stop-guard hooks"`

---

### Task 17: `bin/` CLI 래퍼 + `bin/trust-workspace.js` + `bin/run-stage.js`

**Interfaces:**
- Consumes: 모든 lib.
- Produces: 실행 파일들. 공통: `process.env.FACTORY_REPO`(`owner/name`; 없으면 `gh repo view --json nameWithOwner`), `FACTORY_RUNNER_ID`(없으면 `local/<hostname>`), root = `git rev-parse --show-toplevel`. exit code: 0 성공, 2 거부(전이·검증 실패), 1 오류.
- `run-stage.js <stage> <issue>`의 순서는 §4.2.1 그대로. 이 계획에서 5번(`gates.sh`)은 **Plan 1b 전까지 no-op**이며 `implement` 스테이지의 handoff `gates`는 workflow가 돌려준 값을 그대로 쓴다(Plan 1b가 `gates.json`으로 덮어쓴다).

- [ ] **Step 1: 실패하는 테스트 (run-stage 골격의 호출 순서를 fake로 검증)**

`factory/test/run-stage.test.js`:
```js
import { test, expect, vi } from "vitest";
import { runStage } from "../bin/run-stage.js";

test("run-stage executes the §4.2.1 skeleton in order and transitions on success", async () => {
  const calls = [];
  const deps = {
    charterReady: vi.fn(async () => { calls.push("charter"); return true; }),
    trustWorkspace: vi.fn(async () => calls.push("trust")),
    claim: vi.fn(async () => { calls.push("claim"); return { ok: true }; }),
    assertHandoff: vi.fn(async () => { calls.push("assert"); return { ok: true }; }),
    buildContext: vi.fn(async () => { calls.push("context"); return { roster: ["correctness"], rounds: undefined, orchestration: "workflow", limits: { K: 3 } }; }),
    heartbeat: vi.fn(async () => { calls.push("heartbeat"); return { stop: () => calls.push("heartbeat-stop") }; }),
    claudeP: vi.fn(async () => { calls.push("claude"); return { is_error: false, result: '{"schema":"factory.review.v1"}' }; }),
    gates: vi.fn(async () => { calls.push("gates"); return null; }),
    verifyStage: vi.fn(() => { calls.push("verify"); return { ok: true, reasons: [], data: { round: 1 } }; }),
    writeHandoff: vi.fn(async () => calls.push("handoff")),
    transition: vi.fn(async () => { calls.push("transition"); return { ok: true }; }),
    runRecord: vi.fn(() => calls.push("record")),
    release: vi.fn(async () => calls.push("release")),
  };
  const code = await runStage({ stage: "review", issue: 7, deps });
  expect(code).toBe(0);
  expect(calls).toEqual(["charter", "trust", "claim", "heartbeat", "assert", "context", "claude", "gates", "verify", "handoff", "transition", "record", "heartbeat-stop", "release"]);
});

test("claim failure exits 0 without doing work; verify failure → transition to needs-human, exit 2", async () => {
  const base = (over) => ({
    charterReady: async () => true, trustWorkspace: async () => {}, claim: async () => ({ ok: true }), assertHandoff: async () => ({ ok: true }),
    buildContext: async () => ({ roster: [], orchestration: "workflow", limits: {} }), heartbeat: async () => ({ stop() {} }),
    claudeP: async () => ({ is_error: false, result: "{}" }), gates: async () => null,
    verifyStage: () => ({ ok: true, reasons: [], data: {} }), writeHandoff: async () => {}, transition: vi.fn(async () => ({ ok: true })),
    runRecord: () => {}, release: async () => {}, ...over });
  const d1 = base({ claim: async () => ({ ok: false, holder: "other" }), claudeP: vi.fn() });
  expect(await runStage({ stage: "review", issue: 7, deps: d1 })).toBe(0);
  expect(d1.claudeP).not.toHaveBeenCalled();
  const d2 = base({ verifyStage: () => ({ ok: false, reasons: ["roster role not completed: qa"], data: {} }) });
  expect(await runStage({ stage: "review", issue: 7, deps: d2 })).toBe(2);
  expect(d2.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: expect.stringMatching(/stage artifact/) }));
});

test("charter not ready → exit 0 immediately", async () => {
  const deps = { charterReady: async () => false, claim: vi.fn() };
  expect(await runStage({ stage: "plan", issue: 1, deps })).toBe(0);
  expect(deps.claim).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현 — `bin/run-stage.js` (테스트 가능한 `runStage` + CLI 진입)**

`factory/bin/run-stage.js`:
```js
#!/usr/bin/env node
import { hostname } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { loadCharter, loadHarness } from "../lib/config.js";
import { claim, release } from "../lib/claim.js";
import { requirementFor } from "../lib/requirements.js";
import { STAGE_OF_TARGET } from "../lib/labels.js";
import { buildContext } from "../lib/context.js";
import { startHeartbeat } from "../lib/heartbeat.js";
import { readAgentsLog } from "../lib/agents-log.js";
import { verifyStage } from "../lib/verify-stage.js";
import { renderHandoff } from "../lib/handoff.js";
import { transition } from "../lib/transition.js";
import { appendRunRecord } from "../lib/run-record.js";
import { trustWorkspace } from "./trust-workspace.js";

/** 스테이지 → 성공 시 목적 상태, 요구 handoff를 만드는 직전 스테이지 */
export const NEXT_OF = { triage: null /* disposition에 따라 */, plan: "factory:planned", implement: "factory:awaiting-review", review: null /* aggregate에 따라 */, merge: "factory:merged" };
const ROLE_PREFIX = { plan: "plan-", review: "reviewer-" };

export async function runStage({ stage, issue, deps }) {
  const d = deps;
  if (!(await d.charterReady())) { console.error("factory: CHARTER not ready or doctor failing — dormant"); return 0; }
  await d.trustWorkspace();
  const c = await d.claim();
  if (!c.ok) { console.error(`factory: issue #${issue} already claimed by ${c.holder}`); return 0; }
  const hb = await d.heartbeat();
  try {
    const a = await d.assertHandoff();
    if (!a.ok) return 2;                                              // assertHandoff가 needs-human 전이와 코멘트를 이미 했다
    const ctx = await d.buildContext();
    const out = await d.claudeP(ctx);
    const gates = await d.gates(ctx);                                 // Plan 1b 전까지 null
    const v = d.verifyStage({ stage, out, ctx, gates });
    if (!v.ok) {
      await d.transition({ to: "factory:needs-human", reason: `stage artifact missing or invalid: ${v.reasons.join("; ")}` });
      d.runRecord(["verify: FAIL", ...v.reasons.map((r) => `- ${r}`)]);
      return 2;
    }
    await d.writeHandoff({ stage, data: v.data, gates });
    const t = await d.transition({ to: nextState(stage, v.data), data: v.data });
    d.runRecord([`verify: ok`, `transition: ${t.ok ? t.to : "refused — " + t.reason}`, `usage: ${JSON.stringify(out.usage || {})} cost_usd: ${out.total_cost_usd ?? "n/a"}`]);
    return t.ok ? 0 : 2;
  } finally {
    hb.stop();
    await d.release();
  }
}

export function nextState(stage, data) {
  if (stage === "triage") return { ready: "factory:ready", "needs-info": "factory:needs-info", "wont-do": "factory:wont-do" }[data.disposition];
  if (stage === "review") return data.decision === "approved" ? "factory:approved" : "factory:rework";
  return NEXT_OF[stage];
}

/** CLI 진입: 실제 의존성 조립 */
async function main() {
  const [stage, issueArg] = process.argv.slice(2);
  const issue = Number(issueArg);
  if (!stage || !issue) { console.error("usage: run-stage <stage> <issue>"); process.exit(1); }
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
  const runnerId = process.env.FACTORY_RUNNER_ID || `local/${hostname()}`;
  const gh = makeGh({ run, repo });
  const charter = loadCharter(root), harness = loadHarness(root);
  let ctxCache;
  const deps = {
    charterReady: async () => charter.status === "ready",
    trustWorkspace: () => trustWorkspace({ root }),
    claim: () => claim({ run, cwd: root, issue, stage, runnerId }),
    heartbeat: () => startHeartbeat({ gh, issue, stage, runnerId }),
    assertHandoff: async () => {
      const target = Object.entries(STAGE_OF_TARGET).find(([, s]) => s === prevStage(stage))?.[0];
      if (!target) return { ok: true };
      const req = requirementFor(target)({ comments: await gh.comments(issue) });
      if (!req.ok) { await transition({ gh, issue, to: "factory:needs-human", reason: `prerequisite handoff missing: ${req.reason}` }); }
      return req;
    },
    buildContext: async () => (ctxCache = await buildContext({ root, gh, issue, stage })),
    claudeP: async () => {
      const args = ["-p", `/factory-${stage} ${issue}`, "--permission-mode", "dontAsk", "--max-turns", "5", "--output-format", "json", "--settings", join(root, ".factory/ci-settings.json")];
      if (charter.budget?.usd_per_stage) args.push("--max-budget-usd", String(charter.budget.usd_per_stage));
      const r = await run("claude", args, { cwd: root, env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", CLAUDE_PROJECT_DIR: root } });
      try { return JSON.parse(r.stdout); } catch { return { is_error: true, result: r.stdout + r.stderr }; }
    },
    gates: async () => null,
    verifyStage: ({ out }) => verifyStage({ stage, out, agentsLog: readAgentsLog(join(root, ".factory/out/agents.jsonl")), roster: ctxCache.roster, rolePrefix: ROLE_PREFIX[stage] || "", expectedRounds: ctxCache.rounds, orchestration: ctxCache.orchestration }),
    writeHandoff: async ({ data }) => { await gh.comment(issue, renderHandoff({ stage, issue, summary: data.summary || `### ${stage} 완료`, data })); },
    transition: ({ to, reason, data }) => transition({ gh, issue, to, reason, ctxExtra: { roster: ctxCache?.roster, expectedRounds: ctxCache?.rounds, rosterSize: ctxCache?.roster?.length, maxRounds: charter.limits.K } }),
    runRecord: (lines) => appendRunRecord({ root, issue, stage, runnerId, lines }),
    release: () => release({ run, cwd: root, issue }),
  };
  process.exit(await runStage({ stage, issue, deps }));
}
const PREV = { plan: "triage", implement: "plan", review: "implement", merge: "review" };
function prevStage(stage) { return PREV[stage] || null; }

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
```

`factory/bin/trust-workspace.js`:
```js
#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** CI에서만 ~/.claude.json에 cwd를 trusted로 기록한다(ADR-008). 로컬에서는 아무것도 하지 않는다. */
export async function trustWorkspace({ root, home = homedir(), env = process.env }) {
  if (!env.GITHUB_ACTIONS && !env.FACTORY_RUNNER_ID) return false;
  const p = join(home, ".claude.json");
  let j = {}; if (existsSync(p)) { try { j = JSON.parse(readFileSync(p, "utf8")); } catch { j = {}; } }
  j.projects ??= {}; j.projects[root] = { ...(j.projects[root] || {}), hasTrustDialogAccepted: true };
  writeFileSync(p, JSON.stringify(j, null, 2));
  return true;
}
if (import.meta.url === `file://${process.argv[1]}`) trustWorkspace({ root: process.cwd() }).then((did) => console.log(did ? "trusted" : "skipped (not CI)"));
```

나머지 CLI(`transition.js`, `assert-handoff.js`, `claim.js`, `build-context.js`, `verify-stage.js`, `write-handoff.js`)는 `main()`의 해당 `deps` 항목을 그대로 호출하는 20줄 내외 래퍼로 작성한다. 예 — `factory/bin/transition.js`:
```js
#!/usr/bin/env node
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { transition } from "../lib/transition.js";
const [issue, to, ...rest] = process.argv.slice(2);
const human = rest.includes("--human");
const reason = rest[rest.indexOf("--reason") + 1] || "";
const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
const r = await transition({ gh: makeGh({ run, repo }), issue: Number(issue), to, human, reason });
console.log(JSON.stringify(r));
process.exit(r.ok ? 0 : 2);
```
각 래퍼는 `usage` 오류 시 exit 1.

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run` → 전체 통과(각 파일). `node factory/bin/run-stage.js` 인자 없이 → usage, exit 1.

- [ ] **Step 5: trust-workspace 단위 테스트 추가 후 커밋**

`factory/test/trust-workspace.test.js`:
```js
import { test, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trustWorkspace } from "../bin/trust-workspace.js";

test("does nothing outside CI; writes projects[root].hasTrustDialogAccepted in CI", async () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  expect(await trustWorkspace({ root: "/repo", home, env: {} })).toBe(false);
  expect(existsSync(join(home, ".claude.json"))).toBe(false);
  expect(await trustWorkspace({ root: "/repo", home, env: { GITHUB_ACTIONS: "true" } })).toBe(true);
  expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).projects["/repo"].hasTrustDialogAccepted).toBe(true);
});
```
```bash
git add factory/bin factory/test/run-stage.test.js factory/test/trust-workspace.test.js
git commit -m "feat(factory): run-stage skeleton, CLI wrappers, CI-only trust bootstrap"
```

---

### Task 18: 스펙 갱신 — 이 계획이 확정한 세부

**Files:**
- Modify: `docs/superpowers/specs/2026-09-10-factory-design.md`

- [ ] **Step 1: 다음 네 곳을 고친다**
1. §3.4 handoff 예시의 ````yaml```` 블록을 ````json````으로 바꾸고 "기계 블록은 JSON"이라고 명시(이유: 의존성 회피).
2. §5.3 CHARTER 예시 앞에 Task 7의 frontmatter 블록을 추가하고 "기계 판독 값은 frontmatter, 본문 표는 사람용"이라고 명시.
3. §4.2.1 골격에 lock 커밋 방식(`commit-tree` 빈 트리 + 고유 메시지)과 heartbeat 코멘트 마커를 한 줄씩 추가.
4. §3.3에 "요구 검사 실패 시 스크립트가 `factory:needs-human`으로 전이하고 `factory-transition-refused` 코멘트를 남긴다; 사람 실행(`--human`)은 전이하지 않고 사유만 반환"을 추가.

- [ ] **Step 2: 커밋** — `git commit -am "docs(spec): JSON handoff blocks, CHARTER frontmatter, lock/heartbeat details (plan 1a)"`

---

## Self-Review

**Spec coverage:** §3.1 라벨 → T3; §3.2 그래프 → T3; §3.3 요구 → T6, T14; §3.4 handoff → T4, T5; §4.2.1 골격 0~9 → T17(0 charter, 0.5 trust, 1 claim T9, 2 assert T6/T17, 3 context T15, 4 claude T17, 5 gates=Plan 1b, 6 verify T12, 7 handoff T4/T17, 8 transition T14, 9 record T10); §4.2.4 orchestration 필드 → T5/T12; §4.2.5 lock 먼저 → T9/T17(claim이 라벨 전이보다 앞); §4.4 소비 보고 → T17 runRecord usage; §6.3 훅 → T11, T16; §7.1 roles.toml → T7; §7.5 집계·dispute → T13; §9 run 기록 → T10; ADR-001 미확인 → T1; ADR-008 → T17 trust; ADR-009 → T11/T16(로깅 훅 exit 0). **Plan 1b로 넘긴 것:** gates.sh·prove-test·diff coverage·mutation·classify-failure·quarantine·lint-touched·verdict-format 훅·sweeper.

**Placeholder scan:** T1 Step 5의 `<관측값>`은 실측을 적는 자리이며 Step 4가 만든다. T17의 "나머지 CLI 래퍼는 같은 패턴"은 예시 코드(transition.js)를 제공했고 나머지 5개는 deps 항목 1:1 호출이라 반복을 생략 — 구현자가 예시를 복제한다.

**Type consistency:** `renderHandoff({stage, issue, summary, data})` (T4) ↔ T6/T14/T15/T17 사용 일치. `validate(name, obj)` 이름 `triage.v1`…(T5) ↔ T6/T12 일치. `requirementFor(to)(ctx)` ctx 키(`comments, headSha, prHeadSha, roster, expectedRounds, rosterSize, maxRounds, checksGreen, integrityGreen`) ↔ T14 `ctxExtra`, T17 `transition` 호출 일치. `readAgentsLog → {completed}` (T11) ↔ T12 사용 일치. `rosterFor(charter, roles, stage, tier)` (T7) ↔ T15 일치. `claim({run,cwd,issue,stage,runnerId})` (T9) ↔ T17 일치. `startHeartbeat` 반환 `{stop}` ↔ T17 일치; `gh.patchComment`는 T10에서 gh.js에 추가.

**Known unknowns:** T1 결과가 `agent_type`이 name과 다르면 `normalizeAgentType`(T11)과 `ROLE_PREFIX`(T17)를 그 형식에 맞춘다. `gh api --paginate`가 JSON 배열을 이어붙이는 형식(여러 배열 연속)이면 `comments()`의 파싱을 `--jq '.[]'` + 줄 단위로 바꾼다 — T8 구현 시 `gh api --paginate --slurp` 지원 여부를 확인.
