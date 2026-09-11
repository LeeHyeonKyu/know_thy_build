# Factory Plan 2 — CLI · Templates · CI Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan 1a/1b의 L1 계층을 **대상 프로젝트에 설치하고 CI에 배선**한다 — `npx know-thy-build factory init | doctor | bootstrap | run | status`, 템플릿 세트(`harness.toml`·`CHARTER.md`·`roles.toml`·`settings.json`·디스패처 커맨드·lessons 골격·yml 7개·composite setup action), `test-env`, merge 스테이지의 스크립트 전용화, 체크 상태 보고, run 기록 브랜치, 사용량 보고. 이 계획이 끝나면 그린필드 repo에서 `init → doctor → bootstrap → git push` 뒤 `factory:queue` 라벨로 triage 잡이 실제로 뜬다(에이전트·workflow 파일은 Plan 3).

**Architecture:** 패키지의 `factory/lib`·`factory/bin`·`factory/hooks`를 대상 repo의 `.factory/lib`·`.factory/bin`·`.claude/hooks`로 **복사**한다(러너는 checkout만 본다 — §4.5). 템플릿은 `templates/factory/**`에 두고 `factory/cli/manifest.js`가 src→dest·소유권(factory/project/script)을 선언한다. CLI 로직은 `factory/cli/*.js`(얇은 진입) + `factory/lib/**`(순수 로직, `run()`·`gh`·`io` 주입)로 나눠 vitest로 검증한다. 대상 repo의 런타임 의존성은 `.factory/package.json`(smol-toml 고정) + `npm install --prefix .factory`로 해결한다.

**Tech Stack:** Node ≥22 ESM, `smol-toml`, vitest, git plumbing(`hash-object`/`update-index`/`commit-tree`), `gh` CLI, GitHub Actions composite action.

**Spec:** `docs/superpowers/specs/2026-09-10-factory-design.md` — §2.1 CLI, §2.2 `factory run`, §3.1 라벨, §4.1 워크플로 파일, §4.2.1 골격(step 0·0.5·9), §4.2.5 claim이 라벨보다 먼저, §4.3 sweeper yml, §4.4 인증·소비 보고, §5.1 `harness.toml`·`doctor`, §5.2.6 `test-env`, §5.3 CHARTER, §6.1 L0(required checks·토큰), §6.3 settings.json, §7.1 `roles.toml`, §9 run 기록, §11 그린필드 흐름, §13.4 설치. ADR-005(보고만), ADR-008(trust), ADR-009(yml 관례), ADR-010(게이트 파일 진실).

## Global Constraints

- Plan 1a·1b 제약 전부 상속: Node ≥22 ESM, 런타임 의존성 `smol-toml`만, 외부 프로세스는 `lib/exec.js`의 `run()`으로만(테스트 주입), 테스트에서 실제 프로세스를 띄우지 않음(예외: git 테스트의 임시 repo, 훅 테스트의 bash). 커밋은 `spec/factory-1.0`에, push 금지. TDD, 모듈당 테스트 파일 1개.
- **소유권 3종.** `factory`(패키지가 소유, `init --upgrade`가 교체), `project`(프로젝트가 소유 — `.factory/harness.toml`, `docs/factory/CHARTER.md`, `.factory/lessons/*.md` — **절대 덮어쓰지 않음**), `script`(스크립트만 씀 — `.factory/quarantine.toml`, `docs/factory/runs/`). `init`은 어떤 소유권의 파일도 기존 파일을 덮어쓰지 않는다(§2.1). 예외는 `.claude/settings.json` 하나 — **결정적 병합**(deny 합집합, 훅 항목은 `command`가 없을 때만 append).
- yml 템플릿 규칙(ADR-009): `${{ }}`를 쓰는 `with:`/`env:`는 **블록 매핑만**; dot-경로 아티팩트는 `include-hidden-files: true` 필수; 이슈 트리거 잡은 `concurrency.group: factory-issue-<n>`, `cancel-in-progress: false`, `timeout-minutes`는 §4.1 표 값. 모든 yml은 `lib/yml-lint.js`를 통과해야 한다(템플릿 테스트가 강제).
- **토큰.** 모든 잡은 `GH_TOKEN: ${{ secrets.FACTORY_BOT_TOKEN }}`(PAT)이고 checkout도 같은 토큰으로 한다 — `GITHUB_TOKEN`이 만든 라벨·push 이벤트는 다음 워크플로를 깨우지 않는다(GitHub 규칙). merge 잡만 `${{ secrets.FACTORY_MERGE_TOKEN || secrets.FACTORY_BOT_TOKEN }}`. 스크립트는 인증 방식을 참조하지 않는다(§4.4).
- **체크 이름은 고정**: `factory/gates`, `factory/review`(run-stage가 PR head sha에 commit status로 게시), `factory/integrity`(integrity yml의 job `name`). `harness.toml [factory].required_checks`가 이 세 개를 기본값으로 갖고, branch protection과 머지 게이트 필터가 같은 목록을 쓴다.
- **run 기록은 `factory/records` 브랜치**에 쌓인다(ADR-014, Task 14). 보호된 default 브랜치에는 직접 push할 수 없으므로 `docs/factory/runs/*.md`는 로컬에 쓴 뒤 plumbing 커밋으로 그 브랜치에 append한다. 읽는 쪽(`status`, Plan 4 retro)은 그 브랜치를 fetch한다.
- CLI 함수는 `process.exit`를 직접 부르지 않고 exit code를 **반환**한다. 출력은 `io.out/io.err` 주입. `bin/cli.js`와 `factory/cli/index.js`만 `process.exit`.
- doctor 판정 레벨: `PASS | WARN | FAIL`. FAIL이 하나라도 있으면 exit 1. CHARTER `status != ready`는 **WARN**(§11: `/project`가 CHARTER 전에 doctor를 통과해야 한다).
- 사용량은 **제한하지 않고 보고**한다(ADR-005). `status`는 이슈별·7일 합계를 보여줄 뿐 어떤 판단도 하지 않는다.

## Rulings baked into this plan (스펙과 다른 점 — 실행자는 따르고, 문서 반영은 Task 17)

| # | 결정 | 근거 |
|---|---|---|
| R1 | `factory-review.yml`은 `pull_request` 이벤트가 아니라 **`issues: labeled` (`factory:awaiting-review`)** 로 뜬다 | PR→이슈 매핑이 필요 없고, implement가 라벨을 옮기는 순간이 곧 "리뷰 가능" 시점. PR head는 handoff `head_sha`로 이미 묶여 있다 |
| R2 | 단일 PAT `FACTORY_BOT_TOKEN`. `FACTORY_MERGE_TOKEN`은 선택(있으면 merge 잡만 사용) | `GITHUB_TOKEN` 이벤트는 워크플로를 깨우지 않는다. 머지 보호는 required checks(L0) + 스크립트 전용 merge(L1) + deny(L2)로 성립 |
| R3 | merge 스테이지는 **스크립트 전용**(`claude -p` 호출 없음). PR이 `CONFLICTING`이면 `factory:approved → factory:rework`(사유 "merge conflict — rebase onto <default>") | §4.2.1의 이연 결정 실행. integrator 에이전트 spawn 대신 implement 재진입이 같은 일을 한다 |
| R4 | `factory-retro.yml`·lessons 본문·`.claude/agents/*.md`·`.claude/workflows/*.js`는 **이 계획에 없다**(Plan 3·4). `roles.toml`·디스패처 커맨드·lessons **골격**(헤더만)은 이 계획이 설치한다 | run-stage의 `buildContext`가 roles.toml을 요구하고 integrity가 lessons 헤더를 요구한다 |
| R5 | `retro-proposal` PR의 "required reviewer 1명" 규칙은 branch protection으로 표현하지 않는다(라벨 조건부 규칙 불가). merge 스테이지가 `claude/fq-*` PR만 머지하므로 그 PR은 사람만 머지한다 | GitHub 제약 |
| R6 | review·merge 스테이지는 게이트 전에 **PR head를 detach checkout**한다(최신 implement handoff의 `head_sha`; PR head와 다르면 needs-human "PR head moved") | 게이트는 워킹 트리에서 명령을 돌린다 — default 브랜치 트리에서 돌린 GREEN은 PR 얘기가 아니다 |
| R7 | `factory run triage <n>`은 `backlog` 이슈에 대해 **claim 뒤에** `backlog → factory:queue`를 옮긴다(§2.2·§4.2.5). 다른 스테이지는 라벨을 옮기지 않는다(assert가 처리). `factory run merge`는 거부 | 스펙 §2.2의 "queue → ready"는 triage를 건너뛰므로 채택하지 않는다 |
| R8 | `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4` 고정 | Plan 0에서 실측한 버전 |

---

## File Structure

```
know_thy_build/
├── bin/cli.js                              # (수정) `factory <sub>` → factory/cli/index.js 위임, --help 갱신
├── package.json                            # (수정) files += factory/cli/, templates/factory/
├── templates/factory/                      # 템플릿 루트. 경로 접두 → 대상: factory/→.factory/, claude/→.claude/, github/→.github/, docs/→docs/
│   ├── factory/harness.toml                # project 소유, M0 골격
│   ├── factory/roles.toml                  # §7.1 verbatim
│   ├── factory/ci-settings.json
│   ├── factory/package.json                # smol-toml 고정 + "type":"module"
│   ├── factory/quarantine.toml             # script 소유
│   ├── factory/lessons/<role>.md ×11       # 헤더만 (project 소유)
│   ├── factory/actions/setup/action.yml    # composite: node22 · jq · npm --prefix .factory · runtime.setup · claude · test-env
│   ├── claude/settings.json                # §6.3 + record-agents(SubagentStart/Stop)
│   ├── claude/commands/factory-{triage,plan,implement,review}.md
│   ├── docs/factory/CHARTER.md             # §5.3, status: draft
│   └── github/workflows/factory-{triage,plan,implement,review,merge,sweeper,integrity}.yml
├── factory/
│   ├── cli/
│   │   ├── index.js                        # 서브커맨드 디스패치 (process.exit 허용)
│   │   ├── manifest.js                     # buildManifest({pkgRoot}) → [{src, dest, owner, mode, merge}]
│   │   ├── install.js                      # planInstall / applyInstall / mergeSettings / ensureGitignore / render
│   │   ├── init.js                         # initCommand({root, pkgRoot, argv, io, run})
│   │   ├── doctor.js                       # doctorCommand({root, pkgRoot, argv, io, run, gh})
│   │   ├── bootstrap.js                    # bootstrapCommand({root, argv, io, gh, today})
│   │   ├── run.js                          # runCommand({root, argv, io, run, spawnInherit, env})
│   │   └── status.js                       # statusCommand({root, argv, io, gh, run, now})
│   ├── lib/
│   │   ├── yml-lint.js                     # lintWorkflow(text) / lintLoggingHook(text)
│   │   ├── test-env.js                     # envUp / envDown
│   │   ├── doctor/harness.js               # checkHarness / checkCommands
│   │   ├── doctor/factory.js               # checkFiles / checkCharter / checkRoles / checkSettings / checkHooks / checkWorkflows / checkGitHub
│   │   ├── doctor/report.js                # renderReport / exitCode
│   │   ├── label-catalog.js                # LABELS
│   │   ├── bootstrap.js                    # bootstrapPlan / applyBootstrap
│   │   ├── merge-stage.js                  # runMergeStage
│   │   ├── records-branch.js               # syncRecords / readRecords
│   │   ├── usage.js                        # parseRunRecord / summarizeUsage
│   │   ├── status.js                       # buildStatus / renderStatus
│   │   ├── gh.js                           # (수정) setStatus, listSecrets, listLabels, createLabel, getBranchProtection, putBranchProtection, setVariable, prView, mergePr, closeIssue, issueList, prList
│   │   ├── config.js                       # (수정) factory.required_checks 기본값
│   │   ├── labels.js                       # (수정) approved → rework 엣지
│   │   └── exec.js                         # (수정) spawnBackground
│   ├── bin/
│   │   ├── run-stage.js                    # (수정) reportStatus · checkoutHead · merge 분기 · localEntry · syncRecords
│   │   ├── test-env.js                     # up | down
│   │   └── setup-env.js                    # [runtime].setup 실행
│   └── test/ (모듈당 1개: templates, manifest, install, init, yml-lint, test-env, doctor-harness, doctor-factory, doctor-cli, gh(수정), bootstrap, run-stage(수정), merge-stage, records-branch, usage, status, run-cli)
└── docs/
    ├── factory/DECISIONS.md                # (수정) ADR-014, ADR-015
    └── superpowers/specs/…factory-design.md # (수정) §3.2, §4.1, §4.2.1 step 9, §6.1
```

---

### Task 1: 템플릿 세트 (yml 제외)

**Files:**
- Create: `templates/factory/factory/harness.toml`, `templates/factory/factory/roles.toml`, `templates/factory/factory/ci-settings.json`, `templates/factory/factory/package.json`, `templates/factory/factory/quarantine.toml`, `templates/factory/factory/lessons/{plan-product-advocate,plan-architect,plan-skeptic,plan-operator,factory-builder,factory-verifier,reviewer-correctness,reviewer-security,reviewer-architecture,reviewer-spec-conformance,reviewer-qa}.md`, `templates/factory/claude/settings.json`, `templates/factory/claude/commands/factory-{triage,plan,implement,review}.md`, `templates/factory/docs/factory/CHARTER.md`
- Test: `factory/test/templates.test.js`

**Interfaces:**
- Produces: 템플릿 파일. 플레이스홀더는 `{{PROJECT_NAME}}` 하나뿐(Task 2 `render`가 치환).

- [ ] **Step 1: 실패하는 테스트**

```js
// factory/test/templates.test.js
import { test, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as toml } from "smol-toml";
import { parseFrontmatter } from "../lib/frontmatter.js";

const T = new URL("../../templates/factory/", import.meta.url).pathname;
const read = (p) => readFileSync(join(T, p), "utf8");

test("harness.toml template parses and is an M0 fast-only harness", () => {
  const h = toml(read("factory/harness.toml"));
  expect(h.schema).toBe(1);
  expect(h.project.name).toBe("{{PROJECT_NAME}}");
  expect(h.project.default_branch).toBe("main");
  expect(h.harness.maturity).toBe("M0");
  expect(h.factory.orchestration).toBe("workflow");
  expect(h.factory.required_checks).toEqual(["factory/gates", "factory/review", "factory/integrity"]);
  for (const g of h.gates.required) expect(h.gates.fast).toContain(g);
  for (const c of ["lint", "unit", "test_files", "test_one", "lint_file"]) expect(typeof h.commands[c]).toBe("string");
  expect(h.commands.test_files).toContain("{files}");
  expect(h.commands.test_one).toContain("{file}"); expect(h.commands.test_one).toContain("{name}");
  expect(h.commands.lint_file).toContain("{file}");
  expect(h.protected.factory).toContain(".factory/**");
  expect(h.test.test_glob.length).toBeGreaterThan(0);
});

test("roles.toml template defines every role the CHARTER template names", () => {
  const roles = toml(read("factory/roles.toml"));
  const { data: charter } = parseFrontmatter(read("docs/factory/CHARTER.md"));
  for (const names of Object.values(charter.roster)) for (const n of names) expect(roles.review[n], `review.${n}`).toBeDefined();
  for (const names of Object.values(charter.plan_roles)) for (const n of names) expect(roles.plan[n], `plan.${n}`).toBeDefined();
  expect(roles.triage.agent).toBe(".claude/agents/factory-triage.md");
  expect(roles.implement.builder.agent).toBe(".claude/agents/factory-builder.md");
  for (const [stage, block] of Object.entries(roles)) {
    if (stage === "schema") continue;
    const entries = block.agent ? { _: block } : block;
    for (const [n, def] of Object.entries(entries)) {
      expect(def.agent, `${stage}.${n}`).toMatch(/^\.claude\/agents\/[\w-]+\.md$/);
      if (def.lessons) expect(existsSync(join(T, "factory/lessons", def.lessons.replace(".factory/lessons/", ""))), def.lessons).toBe(true);
    }
  }
});

test("CHARTER template is a draft with the §5.3 frontmatter", () => {
  const { data } = parseFrontmatter(read("docs/factory/CHARTER.md"));
  expect(data.schema).toBe("factory.charter.v1");
  expect(data.status).toBe("draft");
  expect(data.limits).toEqual({ K: 3, M: 3, R: 2 });
  expect(data.retro.every_merges).toEqual({ initial: 1, min: 1, max: 20 });
});

test("lessons skeletons carry the integrity header", () => {
  const files = readdirSync(join(T, "factory/lessons"));
  expect(files.length).toBe(11);
  for (const f of files) {
    const role = f.replace(/\.md$/, "");
    expect(read(`factory/lessons/${f}`)).toMatch(new RegExp(`<!--\\s*factory-lessons:v1\\s+role=${role}\\s+max=\\d+\\s*-->`));
  }
});

test("settings.json template has the §6.3 deny list, all four hook events, and record-agents on Subagent*", () => {
  const s = JSON.parse(read("claude/settings.json"));
  for (const d of ["Bash(gh pr merge*)", "Bash(git push --force*)", "Edit(.factory/**)", "Write(.claude/**)", "Edit(docs/factory/CHARTER.md)"]) expect(s.permissions.deny).toContain(d);
  const cmds = (ev) => s.hooks[ev].flatMap((e) => e.hooks.map((h) => h.command));
  expect(cmds("PreToolUse")).toContain(".claude/hooks/block-dangerous.sh");
  expect(cmds("PostToolUse")).toContain(".claude/hooks/lint-touched.sh");
  expect(cmds("Stop")).toContain(".claude/hooks/stop-guard.sh");
  expect(cmds("SubagentStart")).toContain(".claude/hooks/record-agents.sh");
  expect(cmds("SubagentStop")).toEqual(expect.arrayContaining([".claude/hooks/record-agents.sh", ".claude/hooks/verdict-format.sh"]));
  const hooksDir = new URL("../hooks/", import.meta.url).pathname;
  for (const ev of Object.keys(s.hooks)) for (const c of cmds(ev)) expect(existsSync(join(hooksDir, c.replace(".claude/hooks/", ""))), c).toBe(true);
});

test("dispatcher commands exist for the four LLM stages only and name their workflow", () => {
  for (const s of ["triage", "plan", "implement", "review"]) {
    const t = read(`claude/commands/factory-${s}.md`);
    expect(t).toMatch(new RegExp(`allowed-tools: Workflow\\(factory-${s}\\)`));
    expect(t).toContain("`factory-" + s + "`");
    expect(t).toContain(".factory/out/context.json");
  }
  expect(existsSync(join(T, "claude/commands/factory-merge.md"))).toBe(false);
});

test("ci-settings, package.json, quarantine templates parse", () => {
  expect(JSON.parse(read("factory/ci-settings.json")).permissions.deny.length).toBeGreaterThan(0);
  const p = JSON.parse(read("factory/package.json"));
  expect(p.type).toBe("module"); expect(p.private).toBe(true); expect(p.dependencies["smol-toml"]).toMatch(/^\d+\.\d+\.\d+$/);
  expect(toml(read("factory/quarantine.toml"))).toEqual({ quarantined: [] });
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run factory/test/templates.test.js` → ENOENT.

- [ ] **Step 3: 템플릿 작성**

`templates/factory/factory/harness.toml`:
```toml
schema = 1

# know-thy-build factory harness — M0 skeleton. /project fills [commands]; /qa SETUP fills [test.*].
# Sections marked (protected) can only change through a human-merged PR (integrity blocks agents).

[project]
name           = "{{PROJECT_NAME}}"
spec_dir       = "docs/features"
runs_dir       = "docs/factory/runs"
default_branch = "main"

[runtime]
setup = "npm ci"
node  = "22"

[commands]                       # all judged by exit code
lint       = "npm run lint"
unit       = "npx vitest run --reporter=json --outputFile=.factory/out/unit.json"
test_files = "npx vitest run {files}"            # prove-test / new-test-repeat
test_one   = "npx vitest run {file} -t {name}"   # classify-failure. Scripts quote {file}/{name} — do not add quotes here
lint_file  = "npx eslint {file}"                 # lint-touched.sh (logging only)

[harness]
maturity = "M0"                  # M0 | M1 | M2 — promotion is a factory:harness issue + human merge

[factory]
orchestration   = "workflow"     # workflow | agent
required_checks = ["factory/gates", "factory/review", "factory/integrity"]

[commands.proof]                 # fill when maturity >= M1
# coverage        = "npx vitest run --coverage --coverage.reporter=json"
# coverage_report = ".factory/out/coverage/coverage-final.json"
# mutation        = "npx stryker run --incremental"
# mutation_report = "reports/mutation/mutation.json"

[gates]
required = ["lint", "unit"]
fast     = ["lint", "unit"]
full     = ["lint", "unit"]
deep     = ["lint", "unit"]

[gates.thresholds]               # (protected)
diff_coverage_pct       = 90
mutation_score_pct      = 70
new_test_repeats        = 3
flaky_isolation_runs    = 3
flaky_base_runs         = 5
quarantine_max          = 5
quarantine_ttl_days     = 28
quarantine_return_after = 30

[test]
guide       = "docs/QA.md"
naming      = "test_{issue}_{slug}"
smoke       = { unit = "test/smoke.test.js" }
runtime_budget_min = 12
test_glob   = ["test/**/*.test.js"]
source_glob = ["src/**/*.js"]
unit_report = ".factory/out/unit.json"

[test.env]
# compose   = "docker-compose.test.yml"
# env_file  = ".env.test"
# seed      = ""
# app_start = ""
# app_ready = "http://localhost:3000/healthz"
ready_timeout_sec = 90

[test.fakes]

[protected]                      # (protected)
factory       = [".factory/**", ".claude/**", ".github/workflows/factory-*.yml", "docs/factory/CHARTER.md"]
except        = [".factory/lessons/**", "docs/factory/runs/**"]
additive_only = { ".claude/agents/*.md" = ["## Examples", "## Perspectives"] }
tests_are_load_bearing = true

[load_bearing]
paths = []

[evidence]
qa_artifacts = ".factory/out/qa/**"
```

`templates/factory/factory/roles.toml`: 스펙 §7.1의 toml 블록을 **한 글자도 바꾸지 말고** 그대로(`schema = 1`부터 `[retro.analyst]` 블록 끝까지, 주석 포함).

`templates/factory/factory/ci-settings.json`:
```json
{
  "permissions": {
    "deny": [
      "Bash(gh secret*)", "Bash(gh variable set*)", "Bash(gh api -X DELETE*)", "Bash(gh api --method DELETE*)",
      "Read(.env)", "Read(.env.*)", "Read(**/.env)", "Read(**/.env.*)"
    ]
  }
}
```

`templates/factory/factory/package.json`:
```json
{
  "name": "factory-runtime",
  "private": true,
  "type": "module",
  "description": "Runtime dependencies for .factory/bin and .factory/lib (installed by know-thy-build factory init). Do not edit.",
  "dependencies": { "smol-toml": "1.3.1" }
}
```

`templates/factory/factory/quarantine.toml`:
```toml
# Written by factory scripts only (§5.2.5-⑤). Do not edit by hand.
quarantined = []
```

lessons 골격 ×11 — 파일마다 `<role>`만 다르다(예 `reviewer-correctness.md`):
```markdown
<!-- factory-lessons:v1 role=reviewer-correctness max=12 -->
# Lessons — reviewer-correctness

Read this file as a checklist before you start. Entries are appended by the retro job only
(`- [L-YYYY-MM-DD-NN] <check sentence> — 근거: <run links>`); integrity rejects other edits.
```
역할 목록: `plan-product-advocate`, `plan-architect`, `plan-skeptic`, `plan-operator`, `factory-builder`, `factory-verifier`, `reviewer-correctness`, `reviewer-security`, `reviewer-architecture`, `reviewer-spec-conformance`, `reviewer-qa`.

`templates/factory/claude/settings.json`:
```json
{
  "permissions": {
    "deny": [
      "Bash(gh pr merge*)", "Bash(git merge*)", "Bash(git push --force*)", "Bash(git push -f*)",
      "Bash(gh api -X PUT /repos/*/branches/*/protection*)",
      "Edit(.factory/**)", "Write(.factory/**)",
      "Edit(.claude/**)", "Write(.claude/**)",
      "Edit(.github/workflows/factory-*)", "Write(.github/workflows/factory-*)",
      "Edit(docs/factory/CHARTER.md)", "Write(docs/factory/CHARTER.md)"
    ],
    "allow": ["Bash(git *)", "Bash(gh issue *)", "Bash(gh pr view*)", "Bash(gh pr comment*)", "Bash(gh pr create*)", "Bash(npm *)", "Bash(npx *)"]
  },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": ".claude/hooks/block-dangerous.sh" }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": ".claude/hooks/lint-touched.sh" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": ".claude/hooks/stop-guard.sh" }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": ".claude/hooks/record-agents.sh" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": ".claude/hooks/record-agents.sh" }, { "type": "command", "command": ".claude/hooks/verdict-format.sh" }] }
    ]
  }
}
```

디스패처 ×4 (`templates/factory/claude/commands/factory-<stage>.md`, `<stage>`만 치환):
```markdown
---
description: factory <stage> stage dispatcher
allowed-tools: Workflow(factory-<stage>)
---
You are a dispatcher. Do exactly one thing:

Call the Workflow tool with name `factory-<stage>` and args
`{ "issue": $ARGUMENTS, "context": ".factory/out/context.json" }`.

Return the workflow's result verbatim as your final message. Do not read files,
run commands, edit anything, or add commentary. If the workflow fails, return its
error verbatim.
```

`templates/factory/docs/factory/CHARTER.md`: 스펙 §5.3의 예시를 그대로 쓰되 frontmatter `status: draft`, 제목 `# Charter — {{PROJECT_NAME}}`, `## NEVER_AUTOMATE`·`## Preserve`·`## Tiers`의 own-calendar 고유 항목(결제·prisma·`GET /sync`·타임존)은 `- (fill in)` 한 줄로 대체. 표의 `load_bearing` 설명은 `harness.toml [load_bearing]`으로 유지.

- [ ] **Step 4: 통과 확인** — `npx vitest run factory/test/templates.test.js` → PASS.

- [ ] **Step 5: 커밋**
```bash
git add templates/factory factory/test/templates.test.js
git commit -m "feat(factory): template set — harness/roles/CHARTER/settings/dispatchers/lessons skeletons"
```

---

### Task 2: manifest + install 엔진

**Files:**
- Create: `factory/cli/manifest.js`, `factory/cli/install.js`
- Test: `factory/test/manifest.test.js`, `factory/test/install.test.js`

**Interfaces:**
- Produces:
  - `buildManifest({ pkgRoot, list = readdirRecursive }) → Entry[]`, `Entry = { src /*abs*/, dest /*rel to root*/, owner: "factory"|"project"|"script", mode?: 0o755, merge?: "settings" }`
  - `ownerOf(dest) → owner`
  - `render(text, vars) → text` (`{{KEY}}` 치환, 미정의 키는 그대로)
  - `planInstall({ manifest, root, mode: "init"|"upgrade", vars, exists, readFile }) → Action[]`, `Action = { dest, owner, action: "create"|"skip"|"replace"|"merge"|"keep", content?, mode? }`
  - `applyInstall({ actions, root, writeFile, mkdir, chmod }) → { created, replaced, merged, skipped, kept }`
  - `mergeSettings(existing /*obj|null*/, template /*obj*/) → obj`
  - `ensureGitignore(text /*string|null*/, entries) → string`

- [ ] **Step 1: 실패하는 테스트**

```js
// factory/test/manifest.test.js
import { test, expect } from "vitest";
import { existsSync } from "node:fs";
import { buildManifest, ownerOf } from "../cli/manifest.js";

const pkgRoot = new URL("../../", import.meta.url).pathname;

test("manifest maps package dirs and templates to their destinations with owners", () => {
  const m = buildManifest({ pkgRoot });
  const by = Object.fromEntries(m.map((e) => [e.dest, e]));
  expect(by[".factory/bin/run-stage.js"].owner).toBe("factory");
  expect(by[".factory/lib/gates.js"].owner).toBe("factory");
  expect(by[".factory/lib/parsers/vitest-json.js"].owner).toBe("factory");
  expect(by[".claude/hooks/block-dangerous.sh"].mode).toBe(0o755);
  expect(by[".factory/harness.toml"].owner).toBe("project");
  expect(by["docs/factory/CHARTER.md"].owner).toBe("project");
  expect(by[".factory/lessons/reviewer-qa.md"].owner).toBe("project");
  expect(by[".factory/quarantine.toml"].owner).toBe("script");
  expect(by[".claude/settings.json"].merge).toBe("settings");
  expect(by[".github/workflows/factory-implement.yml"]?.owner ?? "factory").toBe("factory");   // yml은 Task 3에서 추가된다
  expect(by[".claude/commands/factory-triage.md"].owner).toBe("factory");
  for (const e of m) expect(existsSync(e.src), e.src).toBe(true);
  expect(m.some((e) => e.dest.includes("/test/"))).toBe(false);          // 테스트는 설치하지 않는다
  expect(new Set(m.map((e) => e.dest)).size).toBe(m.length);              // dest 중복 없음
});

test("ownerOf", () => {
  expect(ownerOf(".factory/harness.toml")).toBe("project");
  expect(ownerOf(".factory/lessons/x.md")).toBe("project");
  expect(ownerOf(".factory/quarantine.toml")).toBe("script");
  expect(ownerOf(".factory/roles.toml")).toBe("factory");
});
```

```js
// factory/test/install.test.js
import { test, expect } from "vitest";
import { render, planInstall, applyInstall, mergeSettings, ensureGitignore } from "../cli/install.js";

const manifest = [
  { src: "/pkg/templates/factory/factory/harness.toml", dest: ".factory/harness.toml", owner: "project" },
  { src: "/pkg/factory/lib/gates.js", dest: ".factory/lib/gates.js", owner: "factory" },
  { src: "/pkg/factory/hooks/x.sh", dest: ".claude/hooks/x.sh", owner: "factory", mode: 0o755 },
  { src: "/pkg/templates/factory/claude/settings.json", dest: ".claude/settings.json", owner: "factory", merge: "settings" },
  { src: "/pkg/templates/factory/factory/quarantine.toml", dest: ".factory/quarantine.toml", owner: "script" },
];
const srcs = {
  "/pkg/templates/factory/factory/harness.toml": 'name = "{{PROJECT_NAME}}"\n',
  "/pkg/factory/lib/gates.js": "export const v = 2;\n",
  "/pkg/factory/hooks/x.sh": "#!/bin/bash\nexit 0\n",
  "/pkg/templates/factory/claude/settings.json": JSON.stringify({ permissions: { deny: ["A", "B"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: ".claude/hooks/x.sh" }] }] } }),
  "/pkg/templates/factory/factory/quarantine.toml": "quarantined = []\n",
};
const fsOf = (files) => ({ exists: (p) => p in files, readFile: (p) => files[p] ?? srcs[p] ?? null });

test("render substitutes known vars only", () => {
  expect(render("a {{X}} {{Y}}", { X: "1" })).toBe("a 1 {{Y}}");
});

test("init creates everything missing and skips everything present, whatever the owner", () => {
  const files = { "/r/.factory/lib/gates.js": "old", "/r/.factory/harness.toml": "mine" };
  const actions = planInstall({ manifest, root: "/r", mode: "init", vars: { PROJECT_NAME: "demo" }, ...fsOf(files) });
  const by = Object.fromEntries(actions.map((a) => [a.dest, a]));
  expect(by[".factory/lib/gates.js"].action).toBe("skip");
  expect(by[".factory/harness.toml"].action).toBe("skip");
  expect(by[".claude/hooks/x.sh"]).toMatchObject({ action: "create", mode: 0o755 });
  expect(by[".claude/settings.json"].action).toBe("create");
  expect(by[".factory/quarantine.toml"].action).toBe("create");
});

test("init renders vars into created files", () => {
  const actions = planInstall({ manifest, root: "/r", mode: "init", vars: { PROJECT_NAME: "demo" }, ...fsOf({}) });
  expect(actions.find((a) => a.dest === ".factory/harness.toml").content).toBe('name = "demo"\n');
});

test("upgrade replaces stale factory-owned files, merges settings, keeps project/script files", () => {
  const files = {
    "/r/.factory/lib/gates.js": "old",
    "/r/.factory/harness.toml": "mine",
    "/r/.factory/quarantine.toml": "[[quarantined]]\nid='x'\n",
    "/r/.claude/settings.json": JSON.stringify({ permissions: { deny: ["B", "C"], allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "mine.sh" }] }] }, other: 1 }),
    "/r/.claude/hooks/x.sh": "#!/bin/bash\nexit 0\n",
  };
  const actions = planInstall({ manifest, root: "/r", mode: "upgrade", vars: {}, ...fsOf(files) });
  const by = Object.fromEntries(actions.map((a) => [a.dest, a]));
  expect(by[".factory/lib/gates.js"]).toMatchObject({ action: "replace", content: "export const v = 2;\n" });
  expect(by[".claude/hooks/x.sh"].action).toBe("skip");                    // 동일 내용 → 손대지 않음
  expect(by[".factory/harness.toml"].action).toBe("keep");
  expect(by[".factory/quarantine.toml"].action).toBe("keep");
  expect(by[".claude/settings.json"].action).toBe("merge");
  const merged = JSON.parse(by[".claude/settings.json"].content);
  expect(merged.permissions.deny).toEqual(["B", "C", "A"]);
  expect(merged.permissions.allow).toEqual(["Bash(ls)"]);
  expect(merged.hooks.Stop.map((e) => e.hooks[0].command)).toEqual(["mine.sh", ".claude/hooks/x.sh"]);
  expect(merged.other).toBe(1);
});

test("mergeSettings is idempotent and does not duplicate hook entries", () => {
  const t = JSON.parse(srcs["/pkg/templates/factory/claude/settings.json"]);
  const once = mergeSettings(null, t);
  expect(mergeSettings(once, t)).toEqual(once);
});

test("mergeSettings with unparseable existing settings throws", () => {
  expect(() => planInstall({ manifest, root: "/r", mode: "upgrade", vars: {}, exists: () => true, readFile: (p) => (p.endsWith("settings.json") ? "{not json" : srcs[p] ?? "x") }))
    .toThrow(/settings\.json is not valid JSON/);
});

test("applyInstall writes, chmods and reports counts", () => {
  const written = {}, modes = {}, dirs = [];
  const actions = planInstall({ manifest, root: "/r", mode: "init", vars: { PROJECT_NAME: "d" }, ...fsOf({}) });
  const r = applyInstall({ actions, root: "/r", writeFile: (p, c) => (written[p] = c), mkdir: (d) => dirs.push(d), chmod: (p, m) => (modes[p] = m) });
  expect(r.created).toBe(5);
  expect(written["/r/.factory/lib/gates.js"]).toBe("export const v = 2;\n");
  expect(modes["/r/.claude/hooks/x.sh"]).toBe(0o755);
  expect(dirs).toContain("/r/.factory/lib");
});

test("ensureGitignore appends missing entries under a factory header once", () => {
  const out = ensureGitignore("node_modules/\n", [".factory/out/", ".factory/node_modules/"]);
  expect(out).toBe("node_modules/\n\n# know-thy-build factory\n.factory/out/\n.factory/node_modules/\n");
  expect(ensureGitignore(out, [".factory/out/", ".factory/node_modules/"])).toBe(out);
  expect(ensureGitignore(null, [".factory/out/"])).toBe("# know-thy-build factory\n.factory/out/\n");
});
```

- [ ] **Step 2: 실패 확인** — 두 파일 실행, import 오류.

- [ ] **Step 3: 구현**

```js
// factory/cli/manifest.js
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const PREFIX = { factory: ".factory", claude: ".claude", github: ".github", docs: "docs" };
const PROJECT_OWNED = [/^\.factory\/harness\.toml$/, /^docs\/factory\/CHARTER\.md$/, /^\.factory\/lessons\/[\w-]+\.md$/];
const SCRIPT_OWNED = [/^\.factory\/quarantine\.toml$/];

export function ownerOf(dest) {
  if (PROJECT_OWNED.some((r) => r.test(dest))) return "project";
  if (SCRIPT_OWNED.some((r) => r.test(dest))) return "script";
  return "factory";
}

export function readdirRecursive(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...readdirRecursive(p)); else out.push(p);
  }
  return out;
}

/** 설치 대상 목록. 테스트 파일·픽스처는 제외. dest는 항상 "/" 구분자. */
export function buildManifest({ pkgRoot, list = readdirRecursive }) {
  const rel = (from, p) => relative(from, p).split(sep).join("/");
  const entries = [];
  for (const p of list(join(pkgRoot, "factory/lib"))) if (p.endsWith(".js")) entries.push({ src: p, dest: `.factory/lib/${rel(join(pkgRoot, "factory/lib"), p)}`, owner: "factory" });
  for (const p of list(join(pkgRoot, "factory/bin"))) if (p.endsWith(".js")) entries.push({ src: p, dest: `.factory/bin/${rel(join(pkgRoot, "factory/bin"), p)}`, owner: "factory" });
  for (const p of list(join(pkgRoot, "factory/hooks"))) if (p.endsWith(".sh")) entries.push({ src: p, dest: `.claude/hooks/${rel(join(pkgRoot, "factory/hooks"), p)}`, owner: "factory", mode: 0o755 });
  const tRoot = join(pkgRoot, "templates/factory");
  for (const p of list(tRoot)) {
    const r = rel(tRoot, p);
    const [head, ...rest] = r.split("/");
    if (!PREFIX[head]) throw new Error(`template path outside known prefixes: ${r}`);
    const dest = [PREFIX[head], ...rest].join("/");
    const e = { src: p, dest, owner: ownerOf(dest) };
    if (dest === ".claude/settings.json") e.merge = "settings";
    entries.push(e);
  }
  const seen = new Set();
  for (const e of entries) { if (seen.has(e.dest)) throw new Error(`duplicate manifest dest: ${e.dest}`); seen.add(e.dest); }
  return entries;
}
```

```js
// factory/cli/install.js
import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";

export const render = (text, vars = {}) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

const uniq = (arr) => [...new Set(arr)];
/** 결정적 병합: deny/allow는 합집합(기존 순서 유지), 훅은 command가 없을 때만 append, 그 외 키는 기존 값 유지. */
export function mergeSettings(existing, template) {
  const out = existing ? structuredClone(existing) : {};
  out.permissions ??= {};
  for (const k of ["deny", "allow"]) if (template.permissions?.[k]) out.permissions[k] = uniq([...(out.permissions[k] || []), ...template.permissions[k]]);
  out.hooks ??= {};
  for (const [ev, entries] of Object.entries(template.hooks || {})) {
    out.hooks[ev] ??= [];
    const have = new Set(out.hooks[ev].flatMap((e) => (e.hooks || []).map((h) => h.command)));
    for (const entry of entries) {
      const missing = entry.hooks.filter((h) => !have.has(h.command));
      if (missing.length) { out.hooks[ev].push({ ...entry, hooks: missing }); missing.forEach((h) => have.add(h.command)); }
    }
  }
  return out;
}

export function ensureGitignore(text, entries) {
  const lines = (text || "").split("\n");
  const missing = entries.filter((e) => !lines.includes(e));
  if (!missing.length) return text;
  const base = text == null || text === "" ? "" : text.endsWith("\n") ? text + "\n" : text + "\n\n";
  return `${base}# know-thy-build factory\n${missing.join("\n")}\n`;
}

const stripTrailingSlash = (s) => s;

export function planInstall({ manifest, root, mode, vars = {}, exists = existsSync, readFile = (p) => readFileSync(p, "utf8") }) {
  const actions = [];
  for (const e of manifest) {
    const target = join(root, e.dest);
    const fresh = e.owner === "factory" || e.owner === "project" ? render(readFile(e.src), vars) : readFile(e.src);
    const present = exists(target);
    const base = { dest: e.dest, owner: e.owner, mode: e.mode };
    if (!present) { actions.push({ ...base, action: "create", content: fresh }); continue; }
    if (mode === "init") { actions.push({ ...base, action: "skip" }); continue; }
    // upgrade
    if (e.owner !== "factory") { actions.push({ ...base, action: "keep" }); continue; }
    const current = readFile(target);
    if (e.merge === "settings") {
      let cur; try { cur = JSON.parse(current); } catch (err) { throw new Error(`${e.dest}: existing settings.json is not valid JSON — ${err.message}`); }
      const merged = JSON.stringify(mergeSettings(cur, JSON.parse(fresh)), null, 2) + "\n";
      actions.push({ ...base, action: merged === current ? "skip" : "merge", content: merged });
      continue;
    }
    actions.push(current === fresh ? { ...base, action: "skip" } : { ...base, action: "replace", content: fresh });
  }
  return actions;
}

export function applyInstall({ actions, root, writeFile = writeFileSync, mkdir = (d) => mkdirSync(d, { recursive: true }), chmod = chmodSync }) {
  const counts = { created: 0, replaced: 0, merged: 0, skipped: 0, kept: 0 };
  for (const a of actions) {
    const target = join(root, a.dest);
    if (a.action === "create" || a.action === "replace" || a.action === "merge") {
      mkdir(dirname(target));
      writeFile(target, a.content);
      if (a.mode) chmod(target, a.mode);
    }
    counts[{ create: "created", replace: "replaced", merge: "merged", skip: "skipped", keep: "kept" }[a.action]]++;
  }
  return counts;
}
```
(`stripTrailingSlash`는 쓰지 않으면 지운다 — 남기지 말 것.)

- [ ] **Step 4: 통과 확인** — `npx vitest run factory/test/manifest.test.js factory/test/install.test.js`.

- [ ] **Step 5: 커밋**
```bash
git add factory/cli/manifest.js factory/cli/install.js factory/test/manifest.test.js factory/test/install.test.js
git commit -m "feat(factory): install manifest with ownership + deterministic install/upgrade planner"
```

---

### Task 3: yml 템플릿 7개 + composite setup action + yml-lint

**Files:**
- Create: `factory/lib/yml-lint.js`, `templates/factory/github/workflows/factory-{triage,plan,implement,review,merge,sweeper,integrity}.yml`, `templates/factory/factory/actions/setup/action.yml`
- Test: `factory/test/yml-lint.test.js` (lint 규칙 + 템플릿 전수 검사)

**Interfaces:**
- Produces: `lintWorkflow(text) → [{ line, rule: "flow-interpolation"|"hidden-artifact", msg }]`, `lintLoggingHook(text) → [{ line, rule: "exit0", msg }]`
- Consumes: `.factory/bin/run-stage.js <stage> <issue>`, `.factory/bin/sweep.js`, `.factory/bin/integrity.js`, `.factory/bin/setup-env.js`(Task 5), `.factory/bin/test-env.js up`(Task 5)

- [ ] **Step 1: 실패하는 테스트**

```js
// factory/test/yml-lint.test.js
import { test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lintWorkflow, lintLoggingHook } from "../lib/yml-lint.js";

test("flow mapping with ${{ }} is a violation; block mapping is not", () => {
  expect(lintWorkflow("with: { name: x-${{ matrix.y }}, path: .spike/ }\n")).toEqual([expect.objectContaining({ line: 1, rule: "flow-interpolation" })]);
  expect(lintWorkflow("with:\n  name: x-${{ matrix.y }}\n")).toEqual([]);
  expect(lintWorkflow("if: contains(fromJSON('[\"a\"]'), github.event.label.name)\n")).toEqual([]);   // fromJSON의 {}는 문자열 안
});

test("upload-artifact with a dot path needs include-hidden-files", () => {
  const bad = "steps:\n  - uses: actions/upload-artifact@v4\n    with:\n      name: r\n      path: .factory/out/\n  - run: echo\n";
  expect(lintWorkflow(bad)).toEqual([expect.objectContaining({ rule: "hidden-artifact" })]);
  const ok = bad.replace("path: .factory/out/\n", "path: .factory/out/\n      include-hidden-files: true\n");
  expect(lintWorkflow(ok)).toEqual([]);
  const multi = "  - uses: actions/upload-artifact@v4\n    with:\n      path: |\n        docs/x/\n        .factory/out/\n      include-hidden-files: true\n";
  expect(lintWorkflow(multi)).toEqual([]);
  expect(lintWorkflow(multi.replace("      include-hidden-files: true\n", ""))).toHaveLength(1);
});

test("logging hooks must end with exit 0", () => {
  expect(lintLoggingHook("#!/bin/bash\necho hi || true\nexit 0\n")).toEqual([]);
  expect(lintLoggingHook("#!/bin/bash\necho hi\n")).toEqual([expect.objectContaining({ rule: "exit0" })]);
});

const W = new URL("../../templates/factory/github/workflows/", import.meta.url).pathname;
const files = readdirSync(W).filter((f) => f.endsWith(".yml"));
const STAGE = { "factory-triage.yml": ["triage", 15, '"factory:queue"'], "factory-plan.yml": ["plan", 45, '"factory:ready"'], "factory-implement.yml": ["implement", 90, '"factory:planned","factory:rework"'], "factory-review.yml": ["review", 45, '"factory:awaiting-review"'], "factory-merge.yml": ["merge", 20, '"factory:approved"'] };

test("all seven workflow templates exist and pass lint", () => {
  expect(files.sort()).toEqual(["factory-implement.yml", "factory-integrity.yml", "factory-merge.yml", "factory-plan.yml", "factory-review.yml", "factory-sweeper.yml", "factory-triage.yml"]);
  for (const f of files) expect(lintWorkflow(readFileSync(join(W, f), "utf8")), f).toEqual([]);
});

test("stage workflows follow the §4.1 table and the token/concurrency rules", () => {
  for (const [f, [stage, timeout, labels]] of Object.entries(STAGE)) {
    const y = readFileSync(join(W, f), "utf8");
    expect(y, f).toContain(`run: node .factory/bin/run-stage.js ${stage} \${{ github.event.issue.number }}`);
    expect(y, f).toContain(`timeout-minutes: ${timeout}`);
    expect(y, f).toContain(`if: contains(fromJSON('[${labels}]'), github.event.label.name)`);
    expect(y, f).toContain("group: factory-issue-${{ github.event.issue.number }}");
    expect(y, f).toContain("cancel-in-progress: false");
    expect(y, f).toContain("FACTORY_RUNNER_ID: gha-${{ github.run_id }}");
    expect(y, f).toContain("include-hidden-files: true");
    expect(y, f).toContain("token: ${{ secrets.FACTORY_BOT_TOKEN }}");
    expect(y, f).toContain("uses: ./.factory/actions/setup");
    expect(y, f).toContain("fetch-depth: 0");
    if (stage === "merge") { expect(y).toContain("GH_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN || secrets.FACTORY_BOT_TOKEN }}"); expect(y).toContain('claude: "false"'); }
    else { expect(y).toContain("GH_TOKEN: ${{ secrets.FACTORY_BOT_TOKEN }}"); expect(y).toContain("CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"); }
    expect(y, f).toContain(["implement", "review", "merge"].includes(stage) ? 'test-env: "true"' : 'test-env: "false"');
  }
});

test("sweeper and integrity workflows", () => {
  const s = readFileSync(join(W, "factory-sweeper.yml"), "utf8");
  expect(s).toContain("cron: '*/30 * * * *'"); expect(s).toContain("workflow_dispatch:"); expect(s).toContain("run: node .factory/bin/sweep.js"); expect(s).toContain("timeout-minutes: 5");
  const i = readFileSync(join(W, "factory-integrity.yml"), "utf8");
  expect(i).toContain("name: factory/integrity"); expect(i).toContain("pull_request:"); expect(i).toContain("run: node .factory/bin/integrity.js"); expect(i).toContain("timeout-minutes: 5");
});

test("composite setup action", () => {
  const a = readFileSync(new URL("../../templates/factory/factory/actions/setup/action.yml", import.meta.url).pathname, "utf8");
  expect(a).toContain("using: composite");
  expect(a).toContain("node-version: 22");
  expect(a).toContain("npm install --prefix .factory --no-audit --no-fund");
  expect(a).toContain("npm i -g @anthropic-ai/claude-code");
  expect(a).toContain("node .factory/bin/setup-env.js");
  expect(a).toContain("node .factory/bin/test-env.js up");
  expect(a).toContain("command -v jq");
  expect(a).toContain("git config user.name");
  expect(lintWorkflow(a)).toEqual([]);
});
```

- [ ] **Step 2: 실패 확인**.

- [ ] **Step 3: 구현**

```js
// factory/lib/yml-lint.js
/** ADR-009 규칙을 텍스트 수준에서 검사한다. YAML 파서 없이 — 의존성 추가 금지. */
export function lintWorkflow(text) {
  const out = [];
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    // 1) flow mapping 안의 ${{ }}: 같은 줄에서 여는 '{' (단, '${{'의 일부가 아님) 뒤에 '${{'가 온다
    const stripped = l.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    if (/(^|[^$])\{[^}\n]*\$\{\{/.test(stripped)) out.push({ line: i + 1, rule: "flow-interpolation", msg: "${{ }} inside a flow mapping breaks the workflow file — use a block mapping" });
  });
  // 2) upload-artifact 스텝: 스텝 블록(다음 '- '까지) 안에 dot-경로가 있으면 include-hidden-files: true 필수
  for (let i = 0; i < lines.length; i++) {
    if (!/uses:\s*actions\/upload-artifact@/.test(lines[i])) continue;
    const indent = lines[i].search(/\S/);
    let j = i + 1; const block = [];
    while (j < lines.length && (lines[j].trim() === "" || lines[j].search(/\S/) > indent || (lines[j].search(/\S/) === indent && !lines[j].trim().startsWith("- ")))) {
      if (lines[j].search(/\S/) === indent && lines[j].trim().startsWith("- ")) break;
      block.push(lines[j]); j++;
    }
    const hidden = block.some((b) => /(^|\s|\|)\.[\w-]+\//.test(b.replace(/#.*/, "")) && !/include-hidden-files/.test(b));
    const has = block.some((b) => /include-hidden-files:\s*true/.test(b));
    if (hidden && !has) out.push({ line: i + 1, rule: "hidden-artifact", msg: "upload-artifact with a dot-directory path needs include-hidden-files: true" });
  }
  return out;
}

export function lintLoggingHook(text) {
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  return last === "exit 0" ? [] : [{ line: text.split("\n").length, rule: "exit0", msg: "logging hooks must end with `exit 0`" }];
}
```

스테이지 yml 공통 골격 — `factory-implement.yml`(다른 스테이지는 `name`·`if`·`timeout-minutes`·`claude`·`test-env`·run 인자만 다름; 표는 아래):
```yaml
name: factory-implement
on:
  issues:
    types: [labeled]
permissions:
  contents: write
  issues: write
  pull-requests: write
  statuses: write
concurrency:
  group: factory-issue-${{ github.event.issue.number }}
  cancel-in-progress: false
jobs:
  implement:
    if: contains(fromJSON('["factory:planned","factory:rework"]'), github.event.label.name)
    runs-on: ${{ vars.FACTORY_RUNNER || 'ubuntu-latest' }}
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.FACTORY_BOT_TOKEN }}
      - uses: ./.factory/actions/setup
        with:
          claude: "true"
          test-env: "true"
      - name: Run stage
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ secrets.FACTORY_BOT_TOKEN }}
          FACTORY_RUNNER_ID: gha-${{ github.run_id }}
          CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0"
        run: node .factory/bin/run-stage.js implement ${{ github.event.issue.number }}
      - name: Upload run outputs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: factory-implement-${{ github.event.issue.number }}-${{ github.run_id }}
          path: |
            docs/factory/runs/
            .factory/out/
          include-hidden-files: true
```

| 파일 | job id | `if` 라벨 | timeout | claude | test-env |
|---|---|---|---|---|---|
| factory-triage.yml | triage | `"factory:queue"` | 15 | true | false |
| factory-plan.yml | plan | `"factory:ready"` | 45 | true | false |
| factory-implement.yml | implement | `"factory:planned","factory:rework"` | 90 | true | true |
| factory-review.yml | review | `"factory:awaiting-review"` | 45 | true | true |
| factory-merge.yml | merge | `"factory:approved"` | 20 | **false** | true |

merge yml의 env는 `GH_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN || secrets.FACTORY_BOT_TOKEN }}`, `FACTORY_RUNNER_ID`만(클로드 토큰 없음).

`factory-sweeper.yml`:
```yaml
name: factory-sweeper
on:
  schedule:
    - cron: '*/30 * * * *'
  workflow_dispatch:
permissions:
  contents: write
  issues: write
concurrency:
  group: factory-sweeper
  cancel-in-progress: false
jobs:
  sweep:
    runs-on: ${{ vars.FACTORY_RUNNER || 'ubuntu-latest' }}
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.FACTORY_BOT_TOKEN }}
      - uses: ./.factory/actions/setup
        with:
          claude: "false"
          test-env: "false"
      - name: Sweep
        env:
          GH_TOKEN: ${{ secrets.FACTORY_BOT_TOKEN }}
        run: node .factory/bin/sweep.js
```

`factory-integrity.yml`:
```yaml
name: factory-integrity
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
jobs:
  integrity:
    name: factory/integrity
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: ./.factory/actions/setup
        with:
          claude: "false"
          test-env: "false"
      - name: Integrity
        run: node .factory/bin/integrity.js
```

`templates/factory/factory/actions/setup/action.yml`:
```yaml
name: factory-setup
description: Node 22, jq, .factory runtime deps, project runtime setup, optional Claude Code + test environment
inputs:
  claude:
    description: install Claude Code CLI
    default: "true"
  test-env:
    description: bring up the harness test environment (.factory/bin/test-env.js up)
    default: "false"
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: 22
    - shell: bash
      run: |
        command -v jq >/dev/null || { echo "factory: jq is required on the runner" >&2; exit 2; }
        git config user.name "factory-bot"
        git config user.email "factory-bot@users.noreply.github.com"
        npm install --prefix .factory --no-audit --no-fund
        node .factory/bin/setup-env.js
    - if: inputs.claude == 'true'
      shell: bash
      run: |
        npm i -g @anthropic-ai/claude-code
        claude --version
    - if: inputs.test-env == 'true'
      shell: bash
      run: node .factory/bin/test-env.js up
```

- [ ] **Step 4: 통과 확인** — `npx vitest run factory/test/yml-lint.test.js factory/test/manifest.test.js`(manifest에 yml·action이 자동 편입된다).

- [ ] **Step 5: 커밋**
```bash
git add factory/lib/yml-lint.js factory/test/yml-lint.test.js templates/factory/github templates/factory/factory/actions
git commit -m "feat(factory): workflow templates (7) + composite setup action + ADR-009 yml lint"
```

---

### Task 4: `bin/cli.js` 라우팅 + `factory init`

**Files:**
- Modify: `bin/cli.js` (최상단 라우팅 + help), `package.json` (`files` += `factory/cli/`, `templates/`는 이미 포함)
- Create: `factory/cli/index.js`, `factory/cli/init.js`
- Test: `factory/test/init.test.js`

**Interfaces:**
- Produces: `initCommand({ root, pkgRoot, argv, io, run }) → Promise<number>`; 옵션 `--diff`, `--upgrade`, `--json`. `factory/cli/index.js` `main(argv) → Promise<number>`.
- Consumes: Task 2 `buildManifest/planInstall/applyInstall/ensureGitignore`.

- [ ] **Step 1: 실패하는 테스트**

```js
// factory/test/init.test.js
import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand } from "../cli/init.js";
import { makeFakeRun } from "../lib/exec.js";

const pkgRoot = new URL("../../", import.meta.url).pathname;
const io = () => { const o = { out: [], err: [] }; return { io: { out: (s) => o.out.push(s), err: (s) => o.err.push(s) }, o }; };
const fresh = () => { const r = mkdtempSync(join(tmpdir(), "ktb-init-")); writeFileSync(join(r, "package.json"), JSON.stringify({ name: "demo-app" })); return r; };

test("init installs the full manifest into an empty repo and renders the project name", async () => {
  const root = fresh(); const { io: i, o } = io();
  expect(await initCommand({ root, pkgRoot, argv: [], io: i })).toBe(0);
  for (const p of [".factory/bin/run-stage.js", ".factory/lib/gates.js", ".factory/harness.toml", ".factory/roles.toml", ".factory/package.json", ".factory/lessons/reviewer-qa.md", ".claude/settings.json", ".claude/hooks/block-dangerous.sh", ".claude/commands/factory-triage.md", ".github/workflows/factory-implement.yml", ".factory/actions/setup/action.yml", "docs/factory/CHARTER.md", "docs/factory/runs/.gitkeep"]) expect(existsSync(join(root, p)), p).toBe(true);
  expect(readFileSync(join(root, ".factory/harness.toml"), "utf8")).toContain('name           = "demo-app"');
  expect(statSync(join(root, ".claude/hooks/block-dangerous.sh")).mode & 0o111).not.toBe(0);
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".factory/out/");
  expect(o.out.join("\n")).toMatch(/created\s+\d+/);
});

test("init never overwrites; second run reports skips and changes nothing", async () => {
  const root = fresh(); const { io: i } = io();
  await initCommand({ root, pkgRoot, argv: [], io: i });
  writeFileSync(join(root, ".factory/harness.toml"), "mine");
  writeFileSync(join(root, ".factory/lib/gates.js"), "stale");
  const { io: i2, o } = io();
  expect(await initCommand({ root, pkgRoot, argv: [], io: i2 })).toBe(0);
  expect(readFileSync(join(root, ".factory/harness.toml"), "utf8")).toBe("mine");
  expect(readFileSync(join(root, ".factory/lib/gates.js"), "utf8")).toBe("stale");
  expect(o.out.join("\n")).toMatch(/skipped/);
});

test("init --upgrade replaces factory-owned files only and merges settings", async () => {
  const root = fresh(); const { io: i } = io();
  await initCommand({ root, pkgRoot, argv: [], io: i });
  writeFileSync(join(root, ".factory/harness.toml"), "mine");
  writeFileSync(join(root, ".factory/lib/gates.js"), "stale");
  writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm -rf /)"] }, hooks: {} }));
  const { io: i2, o } = io();
  expect(await initCommand({ root, pkgRoot, argv: ["--upgrade"], io: i2 })).toBe(0);
  expect(readFileSync(join(root, ".factory/harness.toml"), "utf8")).toBe("mine");
  expect(readFileSync(join(root, ".factory/lib/gates.js"), "utf8")).toBe(readFileSync(join(pkgRoot, "factory/lib/gates.js"), "utf8"));
  const s = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  expect(s.permissions.deny[0]).toBe("Bash(rm -rf /)"); expect(s.permissions.deny).toContain("Bash(gh pr merge*)"); expect(s.hooks.Stop).toHaveLength(1);
  expect(o.out.join("\n")).toMatch(/replaced\s+1/);
});

test("init --diff prints git diff --no-index for stale factory-owned files and touches nothing", async () => {
  const root = fresh(); const { io: i } = io();
  await initCommand({ root, pkgRoot, argv: [], io: i });
  writeFileSync(join(root, ".factory/lib/gates.js"), "stale");
  const run = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--no-index", result: { code: 1, stdout: "--- a\n+++ b\n-stale\n", stderr: "" } }]);
  const { io: i2, o } = io();
  expect(await initCommand({ root, pkgRoot, argv: ["--diff"], io: i2, run })).toBe(1);   // 차이 있음 = exit 1 (CI에서 stale 감지용)
  expect(o.out.join("\n")).toContain("-stale");
  expect(readFileSync(join(root, ".factory/lib/gates.js"), "utf8")).toBe("stale");
  expect(run.calls.filter((c) => c.args[0] === "diff")).toHaveLength(1);
});

test("init refuses a root that is not a git repo root marker-less dir? no — it only needs a directory; missing package.json falls back to basename", async () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-init-noname-")); const { io: i } = io();
  expect(await initCommand({ root, pkgRoot, argv: [], io: i })).toBe(0);
  expect(readFileSync(join(root, ".factory/harness.toml"), "utf8")).toContain(`name           = "${root.split("/").at(-1)}"`);
});
```

- [ ] **Step 2: 실패 확인**.

- [ ] **Step 3: 구현**

```js
// factory/cli/init.js
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, mkdtempSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { buildManifest } from "./manifest.js";
import { planInstall, applyInstall, ensureGitignore, render } from "./install.js";
import { run as realRun } from "../lib/exec.js";

export const GITIGNORE_ENTRIES = [".factory/out/", ".factory/node_modules/"];

export function projectVars(root) {
  let name = basename(root);
  try { name = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name || name; } catch {}
  return { PROJECT_NAME: name };
}

export async function initCommand({ root, pkgRoot, argv = [], io, run = realRun }) {
  const upgrade = argv.includes("--upgrade"), diff = argv.includes("--diff"), json = argv.includes("--json");
  const vars = projectVars(root);
  const manifest = buildManifest({ pkgRoot });
  const actions = planInstall({ manifest, root, mode: upgrade || diff ? "upgrade" : "init", vars });
  if (diff) {
    const stale = actions.filter((a) => a.action === "replace" || a.action === "merge");
    if (!stale.length) { io.out("factory init --diff: everything up to date"); return 0; }
    const tmp = mkdtempSync(join(tmpdir(), "ktb-diff-"));
    for (const a of stale) {
      const fresh = join(tmp, a.dest.replace(/\//g, "__"));
      writeFileSync(fresh, a.content);
      const r = await run("git", ["diff", "--no-index", "--color=never", join(root, a.dest), fresh]);
      io.out(`# ${a.dest} (${a.action})\n${r.stdout}`);
    }
    return 1;
  }
  const counts = applyInstall({ actions, root, writeFile: writeFileSync, mkdir: (d) => mkdirSync(d, { recursive: true }), chmod: chmodSync });
  mkdirSync(join(root, "docs/factory/runs"), { recursive: true });
  const keep = join(root, "docs/factory/runs/.gitkeep");
  if (!existsSync(keep)) writeFileSync(keep, "");
  const gi = join(root, ".gitignore");
  const before = existsSync(gi) ? readFileSync(gi, "utf8") : null;
  const after = ensureGitignore(before, GITIGNORE_ENTRIES);
  if (after !== before) writeFileSync(gi, after);
  if (json) { io.out(JSON.stringify({ counts, actions: actions.map(({ content, ...a }) => a) }, null, 2)); return 0; }
  io.out(`factory init${upgrade ? " --upgrade" : ""}: created ${counts.created} · replaced ${counts.replaced} · merged ${counts.merged} · skipped ${counts.skipped} · kept ${counts.kept}`);
  for (const a of actions) if (a.action !== "skip") io.out(`  ${a.action.padEnd(8)} ${a.dest}${a.owner !== "factory" ? `  (${a.owner}-owned)` : ""}`);
  io.out(`
Next:
  1. Edit .factory/harness.toml (or run /know-thy-build:project) and docs/factory/CHARTER.md (status: ready when done)
  2. npx know-thy-build factory doctor
  3. npx know-thy-build factory bootstrap   # labels, branch protection, token issue date
  4. gh secret set FACTORY_BOT_TOKEN; gh secret set CLAUDE_CODE_OAUTH_TOKEN   # see docs §4.4
  5. git add -A && git commit && git push`);
  return 0;
}
```

```js
// factory/cli/index.js
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const io = { out: (s) => console.log(s), err: (s) => console.error(s) };

export const HELP = `
  know-thy-build factory — Phase 2 (dark factory) commands

    factory init [--upgrade|--diff]     Install .factory/ .claude/ .github/ docs/factory/ (never overwrites; --upgrade replaces factory-owned files)
    factory doctor [--no-run] [--offline] [--json]
                                        Verify the harness contract (exit 1 on any FAIL)
    factory bootstrap [--dry-run]       Labels, branch protection, required checks, FACTORY_TOKEN_ISSUED_AT (repo admin)
    factory run <stage> <issue>         Run a stage locally with the same scripts CI uses (triage|plan|implement|review)
    factory status [--json]             Needs You / queue / in progress / recent merges / usage (read-only)
`;

export async function main(argv) {
  const [sub, ...rest] = argv;
  const root = process.cwd();
  if (!sub || sub === "--help" || sub === "-h") { io.out(HELP); return 0; }
  switch (sub) {
    case "init": return (await import("./init.js")).initCommand({ root, pkgRoot, argv: rest, io });
    case "doctor": return (await import("./doctor.js")).doctorCommand({ root, pkgRoot, argv: rest, io });
    case "bootstrap": return (await import("./bootstrap.js")).bootstrapCommand({ root, argv: rest, io });
    case "run": return (await import("./run.js")).runCommand({ root, argv: rest, io });
    case "status": return (await import("./status.js")).statusCommand({ root, argv: rest, io });
    default: io.err(`unknown factory command: ${sub}\n${HELP}`); return 1;
  }
}
```
(`doctor.js`·`bootstrap.js`·`run.js`·`status.js`는 뒤 Task에서 만든다 — 동적 import라 이 시점에 없어도 `init`은 동작한다.)

`bin/cli.js` — `const args = process.argv.slice(2);` 바로 아래에:
```js
if (args[0] === "factory") {
  const { main } = await import("../factory/cli/index.js");
  process.exit(await main(args.slice(1)));
}
```
(`bin/cli.js`는 ESM이므로 top-level await 가능.) `--help` 텍스트의 `Usage:` 블록에 `npx know-thy-build factory <init|doctor|bootstrap|run|status>   Phase 2 — see \`factory --help\`` 한 줄 추가. `package.json` `files`에 `"factory/cli/"` 추가.

- [ ] **Step 4: 통과 확인** — `npx vitest run factory/test/init.test.js` + `node bin/cli.js factory --help`.

- [ ] **Step 5: 커밋**
```bash
git add bin/cli.js package.json factory/cli/index.js factory/cli/init.js factory/test/init.test.js
git commit -m "feat(factory): factory init CLI (never overwrites; --upgrade/--diff) and cli routing"
```

---

### Task 5: `test-env` + `setup-env`

**Files:**
- Modify: `factory/lib/exec.js` (`spawnBackground`)
- Create: `factory/lib/test-env.js`, `factory/bin/test-env.js`, `factory/bin/setup-env.js`
- Test: `factory/test/test-env.test.js`

**Interfaces:**
- Produces:
  - `spawnBackground(cmd /*shell string*/, { cwd, env }) → { pid }` (detached, stdio ignore, unref)
  - `envUp({ run, cwd, harness, spawnBg = spawnBackground, fetch = globalThis.fetch, sleep, now, log }) → { ok, steps: [{ name, ok, detail }], pids: number[] }`
  - `envDown({ run, cwd, harness, pids, kill = process.kill, log }) → { ok, steps }`
  - `bin/test-env.js up|down` — up은 pid를 `.factory/out/test-env.pids`(JSON 배열)에 쓰고 실패 시 exit 2; down은 pid 파일을 읽어 kill + compose down.
  - `bin/setup-env.js` — `harness.runtime.setup`가 있으면 `bash -lc`로 실행, exit code 그대로.

- [ ] **Step 1: 실패하는 테스트**

```js
// factory/test/test-env.test.js
import { test, expect } from "vitest";
import { envUp, envDown } from "../lib/test-env.js";
import { makeFakeRun } from "../lib/exec.js";

const harness = { test: { env: { compose: "dc.yml", env_file: ".env.test", seed: "npm run seed", app_start: "npm start", app_ready: "http://localhost:3000/healthz", ready_timeout_sec: 2 }, fakes: { gcal: "npm run fake:gcal" } } };
const okRun = () => makeFakeRun([{ match: () => true, result: { code: 0, stdout: "", stderr: "" } }]);

test("envUp runs compose → seed → fakes → app and polls readiness; returns pids", async () => {
  const run = okRun(); const spawned = []; let polls = 0;
  const spawnBg = (cmd) => { spawned.push(cmd); return { pid: 100 + spawned.length }; };
  const fetch = async () => ({ status: polls++ < 2 ? 503 : 200 });
  const r = await envUp({ run, cwd: "/r", harness, spawnBg, fetch, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 200); })() });
  expect(r.ok).toBe(true);
  expect(run.calls.map((c) => [c.cmd, ...c.args].join(" "))).toEqual(["docker compose -f dc.yml --env-file .env.test up -d --wait", "bash -lc npm run seed"]);
  expect(spawned).toEqual(["npm run fake:gcal", "npm start"]);
  expect(r.pids).toEqual([101, 102]);
  expect(r.steps.map((s) => s.name)).toEqual(["compose", "seed", "fake:gcal", "app_start", "app_ready"]);
});

test("envUp fails closed when compose fails, and skips later steps", async () => {
  const run = makeFakeRun([{ match: (c) => c === "docker", result: { code: 1, stdout: "", stderr: "boom" } }]);
  const r = await envUp({ run, cwd: "/r", harness, spawnBg: () => { throw new Error("must not spawn"); }, fetch: async () => ({ status: 200 }), sleep: async () => {}, now: () => 0 });
  expect(r.ok).toBe(false);
  expect(r.steps).toEqual([{ name: "compose", ok: false, detail: expect.stringContaining("boom") }]);
});

test("envUp times out on readiness", async () => {
  const run = okRun(); let t = 0;
  const r = await envUp({ run, cwd: "/r", harness, spawnBg: () => ({ pid: 1 }), fetch: async () => { throw new Error("ECONNREFUSED"); }, sleep: async () => {}, now: () => (t += 1000) });
  expect(r.ok).toBe(false);
  expect(r.steps.at(-1)).toMatchObject({ name: "app_ready", ok: false, detail: expect.stringContaining("timeout") });
});

test("envUp with an empty [test.env] is a no-op success", async () => {
  const r = await envUp({ run: okRun(), cwd: "/r", harness: { test: { env: { ready_timeout_sec: 90 } } }, spawnBg: () => ({ pid: 1 }), fetch: async () => ({ status: 200 }), sleep: async () => {}, now: () => 0 });
  expect(r).toEqual({ ok: true, steps: [], pids: [] });
});

test("envDown kills pids and brings compose down; ignores ESRCH", async () => {
  const run = okRun(); const killed = [];
  const r = await envDown({ run, cwd: "/r", harness, pids: [5, 6], kill: (pid) => { killed.push(pid); if (pid === 6) { const e = new Error("gone"); e.code = "ESRCH"; throw e; } } });
  expect(r.ok).toBe(true); expect(killed).toEqual([5, 6]);
  expect(run.calls.map((c) => [c.cmd, ...c.args].join(" "))).toEqual(["docker compose -f dc.yml --env-file .env.test down -v"]);
});
```

- [ ] **Step 2: 실패 확인**.

- [ ] **Step 3: 구현**

`factory/lib/exec.js`에 추가:
```js
/** 백그라운드 셸 명령. 부모가 끝나도 살아 있어야 하므로 detached + unref. */
export function spawnBackground(cmd, { cwd, env } = {}) {
  const child = spawn("bash", ["-lc", cmd], { cwd, env: { ...process.env, ...(env || {}) }, detached: true, stdio: "ignore" });
  child.unref();
  return { pid: child.pid };
}
```

```js
// factory/lib/test-env.js
import { spawnBackground } from "./exec.js";

const composeArgs = (env) => ["compose", "-f", env.compose, ...(env.env_file ? ["--env-file", env.env_file] : [])];

export async function envUp({ run, cwd, harness, spawnBg = spawnBackground, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = () => {} }) {
  const env = harness.test?.env || {}, fakes = harness.test?.fakes || {};
  const steps = [], pids = [];
  const fail = (name, detail) => { steps.push({ name, ok: false, detail }); log(`test-env: ${name} FAILED — ${detail}`); return { ok: false, steps, pids }; };
  const ok = (name, detail = "") => { steps.push({ name, ok: true, detail }); log(`test-env: ${name} ok`); };
  if (env.compose) {
    const r = await run("docker", [...composeArgs(env), "up", "-d", "--wait"], { cwd });
    if (r.code !== 0) return fail("compose", `exit ${r.code}: ${(r.stderr || r.stdout).trim()}`);
    ok("compose");
  }
  if (env.seed) {
    const r = await run("bash", ["-lc", env.seed], { cwd });
    if (r.code !== 0) return fail("seed", `exit ${r.code}: ${(r.stderr || r.stdout).trim()}`);
    ok("seed");
  }
  for (const [name, cmd] of Object.entries(fakes)) {
    try { pids.push(spawnBg(cmd, { cwd }).pid); ok(`fake:${name}`); } catch (e) { return fail(`fake:${name}`, e.message); }
  }
  if (env.app_start) {
    try { pids.push(spawnBg(env.app_start, { cwd }).pid); ok("app_start"); } catch (e) { return fail("app_start", e.message); }
    if (env.app_ready) {
      const deadline = now() + (env.ready_timeout_sec ?? 90) * 1000;
      let last = "";
      while (now() < deadline) {
        try { const r = await fetch(env.app_ready); if (r.status === 200) { ok("app_ready"); return { ok: true, steps, pids }; } last = `status ${r.status}`; }
        catch (e) { last = e.message; }
        await sleep(500);
      }
      return fail("app_ready", `timeout after ${env.ready_timeout_sec ?? 90}s waiting for ${env.app_ready} (${last})`);
    }
  }
  return { ok: true, steps, pids };
}

export async function envDown({ run, cwd, harness, pids = [], kill = process.kill, log = () => {} }) {
  const env = harness.test?.env || {};
  const steps = [];
  for (const pid of pids) { try { kill(-pid, "SIGTERM"); } catch { try { kill(pid, "SIGTERM"); } catch (e) { if (e.code !== "ESRCH") steps.push({ name: `kill:${pid}`, ok: false, detail: e.message }); } } }
  if (env.compose) {
    const r = await run("docker", [...composeArgs(env), "down", "-v"], { cwd });
    steps.push({ name: "compose-down", ok: r.code === 0, detail: r.code === 0 ? "" : (r.stderr || r.stdout).trim() });
  }
  const ok = steps.every((s) => s.ok);
  log(`test-env: down ${ok ? "ok" : "with errors"}`);
  return { ok, steps };
}
```
(테스트의 `kill` 주입은 `-pid` 호출을 먼저 받는다 — 첫 호출이 성공하면 두 번째는 부르지 않는다. 테스트가 `killed`에 pid를 양수로 기대하므로 구현은 `kill(-pid)`가 throw하면 `kill(pid)`로 재시도한다; 테스트의 fake는 `-pid`에서 throw하지 않으므로 `killed`에는 `-5, -6`이 남는다 → **테스트를 `expect(killed.map(Math.abs)).toEqual([5, 6])`로 쓴다.** 그룹 kill이 우선인 이유: `bash -lc`가 띄운 자식까지 함께 끝내야 포트가 풀린다.)

```js
// factory/bin/test-env.js
#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { loadHarness } from "../lib/config.js";
import { envUp, envDown } from "../lib/test-env.js";

export const PIDS = ".factory/out/test-env.pids";
async function main() {
  const [mode] = process.argv.slice(2);
  if (!["up", "down"].includes(mode)) { console.error("usage: test-env.js up|down"); process.exit(1); }
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const harness = loadHarness(root);
  const pidFile = join(root, PIDS);
  if (mode === "up") {
    const r = await envUp({ run, cwd: root, harness, log: (s) => console.error(s) });
    mkdirSync(join(root, ".factory/out"), { recursive: true });
    writeFileSync(pidFile, JSON.stringify(r.pids));
    if (!r.ok) { console.error(`test-env: BLOCKED — ${r.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`).join("; ")}`); process.exit(2); }
    process.exit(0);
  }
  const pids = existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, "utf8")) : [];
  const r = await envDown({ run, cwd: root, harness, pids, log: (s) => console.error(s) });
  rmSync(pidFile, { force: true });
  process.exit(r.ok ? 0 : 1);
}
const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
```

```js
// factory/bin/setup-env.js
#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { run } from "../lib/exec.js";
import { loadHarness } from "../lib/config.js";

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) {
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const setup = loadHarness(root).runtime?.setup;
  if (!setup) { console.log("setup-env: no [runtime].setup — nothing to do"); process.exit(0); }
  console.log(`setup-env: ${setup}`);
  const r = spawnSync("bash", ["-lc", setup], { cwd: root, stdio: "inherit" });   // 출력을 잡 로그에 그대로 흘린다
  process.exit(r.status ?? 1);
}
```

- [ ] **Step 4: 통과 확인**.

- [ ] **Step 5: 커밋**
```bash
git add factory/lib/exec.js factory/lib/test-env.js factory/bin/test-env.js factory/bin/setup-env.js factory/test/test-env.test.js
git commit -m "feat(factory): test-env up/down (§5.2.6) and setup-env for the composite action"
```

---

### Task 6: doctor — 하네스 스코프 검사

**Files:**
- Create: `factory/lib/doctor/harness.js`
- Test: `factory/test/doctor-harness.test.js`

**Interfaces:**
- Produces: `Check = { id, level: "PASS"|"WARN"|"FAIL", detail }`;
  `checkHarness({ harness /*loadHarness 결과*/, files /*repo 파일 목록*/ }) → Check[]`;
  `checkCommands({ harness, run, cwd, skipRun }) → Promise<Check[]>`
- Consumes: `lib/glob.js matchesAny`, `THRESHOLD_DEFAULTS`.

- [ ] **Step 1: 실패하는 테스트**

```js
// factory/test/doctor-harness.test.js
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse as toml } from "smol-toml";
import { checkHarness, checkCommands } from "../lib/doctor/harness.js";
import { loadHarness } from "../lib/config.js";
import { makeFakeRun } from "../lib/exec.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T = new URL("../../templates/factory/factory/harness.toml", import.meta.url).pathname;
const tmpl = () => { const r = mkdtempSync(join(tmpdir(), "ktb-h-")); mkdirSync(join(r, ".factory"), { recursive: true }); writeFileSync(join(r, ".factory/harness.toml"), readFileSync(T, "utf8").replace("{{PROJECT_NAME}}", "d")); return loadHarness(r); };
const files = [".factory/harness.toml", ".claude/settings.json", ".github/workflows/factory-plan.yml", "docs/factory/CHARTER.md", "test/smoke.test.js", "src/a.js"];
const by = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

test("template harness passes every static check", () => {
  const c = by(checkHarness({ harness: tmpl(), files }));
  for (const [id, ch] of Object.entries(c)) expect(ch.level, `${id}: ${ch.detail}`).not.toBe("FAIL");
  expect(c["harness.schema"].level).toBe("PASS");
  expect(c["gates.required-in-commands"].level).toBe("PASS");
  expect(c["protected.globs-match"].level).toBe("PASS");
  expect(c["commands.placeholders"].level).toBe("PASS");
});

test("required gate not in [commands] nor proof → FAIL; not in its own level → FAIL", () => {
  const h = tmpl(); h.gates.required = ["lint", "unit", "e2e"];
  expect(by(checkHarness({ harness: h, files }))["gates.required-in-commands"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("e2e") });
  const h2 = tmpl(); h2.gates.required = ["lint", "unit", "diff_coverage"]; h2.commands.proof = { coverage: "x", coverage_report: "y" };
  expect(by(checkHarness({ harness: h2, files }))["gates.required-in-levels"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("diff_coverage") });
});

test("maturity / thresholds / orchestration / required_checks / placeholders / protected globs", () => {
  const h = tmpl();
  h.harness.maturity = "M9"; h.gates.thresholds.new_test_repeats = 1; h.gates.thresholds.diff_coverage_pct = 120; h.factory.orchestration = "auto"; h.factory.required_checks = []; h.commands.test_one = "vitest {file}"; h.protected.factory.push("nope/**");
  const c = by(checkHarness({ harness: h, files }));
  expect(c["harness.maturity"].level).toBe("FAIL");
  expect(c["thresholds.range"]).toMatchObject({ level: "FAIL", detail: expect.stringMatching(/new_test_repeats.*diff_coverage_pct|diff_coverage_pct.*new_test_repeats/) });
  expect(c["factory.orchestration"].level).toBe("FAIL");
  expect(c["factory.required_checks"].level).toBe("FAIL");
  expect(c["commands.placeholders"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("test_one") });
  expect(c["protected.globs-match"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("nope/**") });
});

test("maturity-level mismatch: deep listed but M0 → WARN; proof gates listed without proof commands → FAIL", () => {
  const h = tmpl(); h.gates.deep = ["lint", "unit", "e2e"]; h.commands.e2e = "x";
  expect(by(checkHarness({ harness: h, files }))["gates.levels-vs-maturity"].level).toBe("WARN");
  const h2 = tmpl(); h2.gates.full = ["lint", "unit", "diff_coverage"];
  expect(by(checkHarness({ harness: h2, files }))["proof.commands"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("coverage") });
});

test("checkCommands runs each non-templated command and reports exit codes; skipRun marks WARN", async () => {
  const h = tmpl();
  const run = makeFakeRun([{ match: (c, a) => a[1].startsWith("npm run lint"), result: { code: 0, stdout: "", stderr: "" } }, { match: () => true, result: { code: 1, stdout: "", stderr: "no tests" } }]);
  const c = by(await checkCommands({ harness: h, run, cwd: "/r" }));
  expect(c["commands.run.lint"].level).toBe("PASS");
  expect(c["commands.run.unit"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("no tests") });
  expect(c["commands.run.test_files"]).toBeUndefined();   // 템플릿 명령은 실행하지 않는다
  expect(run.calls.every((x) => x.cmd === "bash" && x.args[0] === "-lc")).toBe(true);
  const skipped = by(await checkCommands({ harness: h, run, cwd: "/r", skipRun: true }));
  expect(skipped["commands.run"].level).toBe("WARN");
});
```

- [ ] **Step 2: 실패 확인**.

- [ ] **Step 3: 구현**

```js
// factory/lib/doctor/harness.js
import { matchesAny } from "../glob.js";
import { THRESHOLD_DEFAULTS } from "../config.js";

const PROOF_GATES = { diff_coverage: ["coverage", "coverage_report"], mutation: ["mutation", "mutation_report"], "prove-test": [], "new-test-repeat": [] };
const TEMPLATED = { lint_file: ["{file}"], test_files: ["{files}"], test_one: ["{file}", "{name}"] };
const MAX_LEVEL = { M0: "fast", M1: "full", M2: "deep" };
const LEVELS = ["fast", "full", "deep"];
const c = (id, level, detail = "") => ({ id, level, detail });

export function checkHarness({ harness: h, files = [] }) {
  const out = [];
  out.push(h.schema === 1 ? c("harness.schema", "PASS") : c("harness.schema", "FAIL", `schema must be 1, got ${h.schema}`));
  out.push(h.project?.default_branch ? c("project.default_branch", "PASS", h.project.default_branch) : c("project.default_branch", "FAIL", "[project].default_branch missing"));
  out.push(MAX_LEVEL[h.harness?.maturity] ? c("harness.maturity", "PASS", h.harness.maturity) : c("harness.maturity", "FAIL", `[harness].maturity must be M0|M1|M2, got ${h.harness?.maturity}`));
  out.push(["workflow", "agent"].includes(h.factory?.orchestration) ? c("factory.orchestration", "PASS") : c("factory.orchestration", "FAIL", `[factory].orchestration must be workflow|agent`));
  out.push(Array.isArray(h.factory?.required_checks) && h.factory.required_checks.length ? c("factory.required_checks", "PASS", h.factory.required_checks.join(",")) : c("factory.required_checks", "FAIL", "[factory].required_checks must list at least one check"));
  // commands
  const cmds = h.commands || {};
  const badPh = Object.entries(TEMPLATED).filter(([k, phs]) => cmds[k] && phs.some((p) => !cmds[k].includes(p))).map(([k, phs]) => `${k} must contain ${phs.join(" and ")}`);
  out.push(badPh.length ? c("commands.placeholders", "FAIL", badPh.join("; ")) : c("commands.placeholders", "PASS"));
  for (const k of ["lint", "unit", "test_files"]) if (!cmds[k]) out.push(c(`commands.${k}`, "FAIL", `[commands].${k} is required at M0`));
  // gates
  const required = h.gates?.required || [];
  const known = (g) => g in cmds || g in PROOF_GATES;
  const unknown = required.filter((g) => !known(g));
  out.push(unknown.length ? c("gates.required-in-commands", "FAIL", `required gates not in [commands] or proof set: ${unknown.join(", ")}`) : c("gates.required-in-commands", "PASS"));
  const maxLevel = MAX_LEVEL[h.harness?.maturity] || "fast";
  const allowed = new Set(LEVELS.slice(0, LEVELS.indexOf(maxLevel) + 1).flatMap((l) => h.gates?.[l] || []));
  const notInLevels = required.filter((g) => !allowed.has(g) && !["prove-test", "new-test-repeat"].includes(g));
  out.push(notInLevels.length ? c("gates.required-in-levels", "FAIL", `required gates absent from every level up to ${maxLevel}: ${notInLevels.join(", ")}`) : c("gates.required-in-levels", "PASS"));
  const beyond = LEVELS.slice(LEVELS.indexOf(maxLevel) + 1).filter((l) => (h.gates?.[l] || []).some((g) => !(h.gates?.[maxLevel] || []).includes(g)));
  out.push(beyond.length ? c("gates.levels-vs-maturity", "WARN", `${beyond.join(",")} list gates beyond maturity ${h.harness?.maturity}; they will be downgraded to ${maxLevel}`) : c("gates.levels-vs-maturity", "PASS"));
  const proofMissing = [];
  for (const l of LEVELS) for (const g of h.gates?.[l] || []) for (const k of PROOF_GATES[g] || []) if (!cmds.proof?.[k]) proofMissing.push(`${g} needs [commands.proof].${k}`);
  out.push(proofMissing.length ? c("proof.commands", "FAIL", [...new Set(proofMissing)].join("; ")) : c("proof.commands", "PASS"));
  // thresholds
  const t = { ...THRESHOLD_DEFAULTS, ...(h.gates?.thresholds || {}) };
  const badT = [];
  for (const k of ["diff_coverage_pct", "mutation_score_pct"]) if (!(t[k] >= 0 && t[k] <= 100)) badT.push(`${k}=${t[k]} out of 0..100`);
  if (!(t.new_test_repeats >= 2)) badT.push(`new_test_repeats=${t.new_test_repeats} must be ≥ 2`);
  for (const k of ["flaky_isolation_runs", "flaky_base_runs", "quarantine_max", "quarantine_ttl_days", "quarantine_return_after"]) if (!(t[k] >= 1)) badT.push(`${k}=${t[k]} must be ≥ 1`);
  out.push(badT.length ? c("thresholds.range", "FAIL", badT.join("; ")) : c("thresholds.range", "PASS"));
  // test
  out.push((h.test?.test_glob || []).length ? c("test.test_glob", "PASS") : c("test.test_glob", "FAIL", "[test].test_glob must not be empty"));
  const smoke = Object.values(h.test?.smoke || {});
  const smokeMissing = smoke.filter((f) => !files.includes(f));
  out.push(!smoke.length ? c("test.smoke", "FAIL", "[test].smoke must name at least the unit smoke test") : smokeMissing.length ? c("test.smoke", "FAIL", `smoke files missing: ${smokeMissing.join(", ")}`) : c("test.smoke", "PASS"));
  // protected
  const globs = h.protected?.factory || [];
  const unmatched = globs.filter((g) => !files.some((f) => matchesAny([g], f)));
  out.push(!globs.length ? c("protected.globs-match", "FAIL", "[protected].factory is empty") : unmatched.length ? c("protected.globs-match", "WARN", `no file matches: ${unmatched.join(", ")}`) : c("protected.globs-match", "PASS"));
  return out;
}

export async function checkCommands({ harness: h, run, cwd, skipRun = false }) {
  if (skipRun) return [c("commands.run", "WARN", "--no-run: commands not executed")];
  const out = [];
  for (const [k, cmd] of Object.entries(h.commands || {})) {
    if (k === "proof" || k in TEMPLATED) continue;
    const r = await run("bash", ["-lc", cmd], { cwd });
    out.push(r.code === 0 ? c(`commands.run.${k}`, "PASS", cmd) : c(`commands.run.${k}`, "FAIL", `${cmd} → exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`));
  }
  return out;
}
```

- [ ] **Step 4: 통과 확인**. **Step 5: 커밋** `feat(factory): doctor harness-scope checks`.

---

### Task 7: doctor — factory 스코프 검사 (파일·CHARTER·roles·settings·훅·yml·GitHub)

**Files:**
- Create: `factory/lib/doctor/factory.js`
- Test: `factory/test/doctor-factory.test.js`

**Interfaces:**
- Produces (모두 `Check[]` 또는 `Promise<Check[]>`):
  - `checkFiles({ manifest, root, exists, readFile, render, vars })` — factory-owned 파일 부재 → FAIL(`files.missing`), 내용 상이 → WARN(`files.stale`, "run init --upgrade")
  - `checkCharter({ root, loadCharter })` — 없음 → WARN, 파싱 실패 → FAIL, `status!=ready` → WARN
  - `checkRoles({ charter, roles, exists, root })` — 로스터 이름 ∈ roles.toml(FAIL), `agent` 파일 존재(FAIL, "Plan 3 installs agents" 힌트), `lessons` 파일 존재(WARN)
  - `checkSettings({ settings, template })` — deny ⊇ template.deny(FAIL), 각 훅 command 존재(FAIL)
  - `checkHooks({ run, root, hooks: ["block-dangerous.sh", …] })` — 실행 가능, `{}` stdin으로 실행 시 로깅 훅 exit 0·`lintLoggingHook` 통과, `block-dangerous.sh`에 benign 명령 → exit 0
  - `checkWorkflows({ root, readFile, list })` — 7개 존재(FAIL) + `lintWorkflow` 위반(FAIL)
  - `checkGitHub({ gh, harness, labels /*label-catalog*/ })` — 시크릿(`CLAUDE_CODE_OAUTH_TOKEN`|`ANTHROPIC_API_KEY` 중 하나 FAIL; `FACTORY_BOT_TOKEN` FAIL), 변수 `FACTORY_TOKEN_ISSUED_AT`(WARN), 라벨 전부 존재(WARN "run bootstrap"), branch protection required contexts ⊇ `required_checks`(WARN "run bootstrap")
- Consumes: Task 3 `lintWorkflow/lintLoggingHook`, Task 9 `gh.listSecrets/listLabels/getVariable/getBranchProtection`(이 Task에서는 주입된 fake gh만 쓰므로 Task 9보다 먼저 작성 가능 — 인터페이스: `listSecrets() → string[]`, `listLabels() → string[]`, `getVariable(name) → string|null`, `getBranchProtection(branch) → { required_status_checks: { contexts: string[] } } | null`), Task 10 `LABELS`(테스트에서는 인라인 배열).

- [ ] **Step 1: 실패하는 테스트** — 각 함수에 1~2 케이스. 예:

```js
// factory/test/doctor-factory.test.js
import { test, expect } from "vitest";
import { checkFiles, checkCharter, checkRoles, checkSettings, checkHooks, checkWorkflows, checkGitHub } from "../lib/doctor/factory.js";
import { makeFakeRun } from "../lib/exec.js";
const by = (cs) => Object.fromEntries(cs.map((c) => [c.id, c]));

test("checkFiles: missing factory file FAIL, stale WARN, project file never compared", () => {
  const manifest = [{ src: "/p/a.js", dest: ".factory/lib/a.js", owner: "factory" }, { src: "/p/b.js", dest: ".factory/bin/b.js", owner: "factory" }, { src: "/p/h.toml", dest: ".factory/harness.toml", owner: "project" }];
  const files = { "/r/.factory/lib/a.js": "old", "/r/.factory/harness.toml": "x", "/p/a.js": "new", "/p/b.js": "b", "/p/h.toml": "t" };
  const c = by(checkFiles({ manifest, root: "/r", exists: (p) => p in files, readFile: (p) => files[p], vars: {} }));
  expect(c["files.missing"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining(".factory/bin/b.js") });
  expect(c["files.stale"]).toMatchObject({ level: "WARN", detail: expect.stringContaining(".factory/lib/a.js") });
  expect(c["files.stale"].detail).not.toContain("harness.toml");
});

test("checkCharter: absent WARN, draft WARN, ready PASS, broken FAIL", () => {
  expect(by(checkCharter({ root: "/r", loadCharter: () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } }))["charter"].level).toBe("WARN");
  expect(by(checkCharter({ root: "/r", loadCharter: () => ({ status: "draft" }) }))["charter"].level).toBe("WARN");
  expect(by(checkCharter({ root: "/r", loadCharter: () => ({ status: "ready" }) }))["charter"].level).toBe("PASS");
  expect(by(checkCharter({ root: "/r", loadCharter: () => { throw new Error("schema"); } }))["charter"].level).toBe("FAIL");
});

test("checkRoles: unknown roster name FAIL, missing agent file FAIL with Plan 3 hint, missing lessons WARN", () => {
  const charter = { roster: { docs: ["correctness", "ghost"] }, plan_roles: { default: ["architect"] } };
  const roles = { review: { correctness: { agent: ".claude/agents/reviewer-correctness.md", lessons: ".factory/lessons/reviewer-correctness.md" } }, plan: { architect: { agent: ".claude/agents/plan-architect.md" } }, triage: { agent: ".claude/agents/factory-triage.md" } };
  const c = by(checkRoles({ charter, roles, root: "/r", exists: (p) => p.endsWith("plan-architect.md") }));
  expect(c["roles.roster-defined"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("ghost") });
  expect(c["roles.agent-files"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("reviewer-correctness.md") });
  expect(c["roles.agent-files"].detail).toContain("Plan 3");
  expect(c["roles.lessons-files"].level).toBe("WARN");
});

test("checkSettings: deny subset and hook commands", () => {
  const template = { permissions: { deny: ["A", "B"] }, hooks: { Stop: [{ hooks: [{ command: ".claude/hooks/s.sh" }] }] } };
  const c = by(checkSettings({ settings: { permissions: { deny: ["A"] }, hooks: {} }, template }));
  expect(c["settings.deny"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("B") });
  expect(c["settings.hooks"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("s.sh") });
  expect(by(checkSettings({ settings: null, template }))["settings.present"].level).toBe("FAIL");
});

test("checkHooks: runs each hook with stdin JSON and checks exit code", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0].endsWith("verdict-format.sh"), result: { code: 2, stdout: "", stderr: "" } }, { match: () => true, result: { code: 0, stdout: "", stderr: "" } }]);
  const c = by(await checkHooks({ run, root: "/r", exists: () => true, readFile: () => "#!/bin/bash\nexit 0\n", hooks: ["record-agents.sh", "block-dangerous.sh", "verdict-format.sh"] }));
  expect(c["hooks.record-agents.sh"].level).toBe("PASS");
  expect(c["hooks.block-dangerous.sh"].level).toBe("PASS");
  expect(c["hooks.verdict-format.sh"].level).toBe("PASS");   // 판정 훅은 SubagentStop 입력에 verdict가 없으면 exit 2가 정상
  expect(run.calls.every((x) => typeof x.opts.input === "string" && JSON.parse(x.opts.input).hook_event_name)).toBe(true);
});

test("checkWorkflows: all seven present and lint-clean", () => {
  const c = by(checkWorkflows({ root: "/r", exists: (p) => !p.endsWith("factory-merge.yml"), readFile: () => "with: { a: ${{ x }} }\n" }));
  expect(c["workflows.present"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("factory-merge.yml") });
  expect(c["workflows.lint"].level).toBe("FAIL");
});

test("checkGitHub: secrets, token date, labels, protection", async () => {
  const gh = { listSecrets: async () => ["FACTORY_BOT_TOKEN"], getVariable: async () => null, listLabels: async () => ["backlog"], getBranchProtection: async () => ({ required_status_checks: { contexts: ["factory/gates"] } }) };
  const c = by(await checkGitHub({ gh, harness: { project: { default_branch: "main" }, factory: { required_checks: ["factory/gates", "factory/review"] } }, labels: [{ name: "backlog" }, { name: "factory:queue" }] }));
  expect(c["github.claude-secret"].level).toBe("FAIL");
  expect(c["github.bot-token"].level).toBe("PASS");
  expect(c["github.token-issued-at"].level).toBe("WARN");
  expect(c["github.labels"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("factory:queue") });
  expect(c["github.protection"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("factory/review") });
});
```

- [ ] **Step 2: 실패 확인**. **Step 3: 구현** — 위 인터페이스대로. 훅 입력은 `record-agents.sh`·`verdict-format.sh`에 `{hook_event_name:"SubagentStop", agent_type:"x", agent_transcript_path:"/nonexistent"}`, `block-dangerous.sh`에 `{hook_event_name:"PreToolUse", tool_name:"Bash", tool_input:{command:"echo doctor"}}`, `lint-touched.sh`에 `{hook_event_name:"PostToolUse", tool_name:"Edit", tool_input:{file_path:"/nonexistent"}}`, `stop-guard.sh`에 `{hook_event_name:"Stop"}`; 기대 exit: `verdict-format.sh`는 `agent_type`이 reviewer-*가 아니면 0 → 입력에 `agent_type:"reviewer-doctor"`를 넣고 2를 기대(판정 훅이 판정한다는 증거), 나머지는 0. 로깅 훅(`record-agents.sh`, `lint-touched.sh`)은 추가로 `lintLoggingHook(readFile(path))` 통과. `checkGitHub`는 gh 호출이 throw하면 `github.*` 하나로 WARN "gh unavailable — <msg>"(오프라인 허용).

- [ ] **Step 4: 통과 확인**. **Step 5: 커밋** `feat(factory): doctor factory-scope checks (files/charter/roles/settings/hooks/workflows/github)`.

---

### Task 8: doctor 러너 + CLI (`report.js`, smoke, exit code)

**Files:**
- Create: `factory/lib/doctor/report.js`, `factory/cli/doctor.js`
- Test: `factory/test/doctor-cli.test.js`

**Interfaces:**
- Produces: `renderReport(checks) → string`(레벨별 정렬, `✓ ✗ !` 표식, 요약 줄 `doctor: PASS n · WARN n · FAIL n`), `exitCode(checks) → 0|1`, `doctorCommand({ root, pkgRoot, argv, io, run, gh, deps? }) → Promise<number>`; 옵션 `--no-run`(명령·smoke 미실행), `--offline`(GitHub 검사 생략), `--json`.
- 흐름: (1) harness 스코프 — `loadHarness` 실패 → 단일 FAIL 후 exit 1. `files = git ls-files`. `checkHarness` + `checkCommands`. (2) `.factory/bin/run-stage.js`가 있으면 factory 스코프 전부(`checkFiles`·`checkCharter`·`checkRoles`(roles.toml 없으면 FAIL)·`checkSettings`·`checkHooks`·`checkWorkflows`·`checkGitHub`(offline 아니면)), 없으면 `factory.initialized` INFO(PASS, "not initialized — run factory init"). (3) smoke: `--no-run`이 아니고 `[test].smoke`가 있으면 `envUp` → `[commands].test_files`에 smoke 파일들을 넣어 실행 → `envDown`; 각 레벨 PASS/FAIL(`smoke.<level>`); envUp 실패는 `smoke.env` FAIL.

- [ ] **Step 1: 실패하는 테스트** — `doctorCommand`에 fake `run`(git ls-files → 파일 목록, bash -lc → 0, docker → 0)과 fake `gh`를 주입해 (a) 템플릿 init된 tmp repo(Task 4의 `initCommand`로 준비) + stub agent 파일 생성 → exit 0이며 출력에 `doctor: PASS`, `charter`가 WARN(draft); (b) `harness.toml` 삭제 → exit 1, 출력에 `harness.toml unreadable`; (c) `--json` → 파싱 가능한 `{ checks, summary }`; (d) `--no-run` → `commands.run` WARN, `smoke.*` 없음; (e) `renderReport`가 FAIL을 먼저 보여준다.

- [ ] **Step 2: 실패 확인**. **Step 3: 구현** — `report.js`:
```js
const ORDER = { FAIL: 0, WARN: 1, PASS: 2 }, MARK = { FAIL: "✗", WARN: "!", PASS: "✓" };
export const exitCode = (checks) => (checks.some((c) => c.level === "FAIL") ? 1 : 0);
export function renderReport(checks) {
  const sorted = [...checks].sort((a, b) => ORDER[a.level] - ORDER[b.level] || a.id.localeCompare(b.id));
  const n = (l) => checks.filter((c) => c.level === l).length;
  return [...sorted.map((c) => `${MARK[c.level]} ${c.id}${c.detail ? ` — ${c.detail}` : ""}`), "", `doctor: PASS ${n("PASS")} · WARN ${n("WARN")} · FAIL ${n("FAIL")}`].join("\n");
}
```
`doctor.js`는 위 흐름을 그대로 조립한다(`deps`로 각 check 함수를 덮어쓸 수 있게 해 테스트에서 GitHub·smoke를 대체). smoke 실행 명령: `harness.commands.test_files.replace("{files}", smokeFiles.map(q).join(" "))` — `q`는 `lib/prove-test.js`의 `q()`를 export해 재사용(없으면 `JSON.stringify` 대신 작은따옴표 이스케이프 함수 추가).

- [ ] **Step 4: 통과 확인** + `node bin/cli.js factory doctor --no-run --offline`를 **KTB repo 자신**에서 실행해 "not initialized"가 아닌 harness 없음 FAIL이 나오는지 눈으로 확인(KTB에는 `.factory/harness.toml`이 없다 — Plan 6 dogfood 대상). **Step 5: 커밋** `feat(factory): factory doctor CLI with report, smoke run, exit codes`.

---

### Task 9: `gh.js` 확장 + `required_checks` 필터

**Files:**
- Modify: `factory/lib/gh.js`, `factory/lib/config.js`, `factory/bin/run-stage.js`(`mergeGates`에 `required` 전달)
- Test: `factory/test/gh.test.js`(추가), `factory/test/config.test.js`(추가), `factory/test/run-stage.test.js`(mergeGates 케이스 추가)

**Interfaces:**
- Produces (`makeGh` 메서드):
  - `setStatus({ sha, context, state /*success|failure|pending|error*/, description, targetUrl })` → `gh api -X POST repos/{r}/statuses/{sha} --input -` (description은 140자로 자른다)
  - `listSecrets() → string[]` (`gh secret list --json name`), `listLabels() → string[]` (`gh label list --json name --limit 200`), `createLabel({ name, color, description })` (`gh label create <name> --color --description --force`)
  - `getBranchProtection(branch) → obj|null` (404 → null), `putBranchProtection(branch, body)` (`gh api -X PUT … --input -`)
  - `setVariable(name, value)` (`gh variable set <name> --body <value>`)
  - `prView(pr) → { number, state, mergeable, headRefName, headRefOid, baseRefName, labels }`
  - `mergePr(pr, { method = "squash", deleteBranch = true })`, `closeIssue(n, comment)`
  - `issueList({ labels = [], state = "open", limit = 200 }) → [{ number, title, labels, updatedAt, closedAt }]`, `prList({ label, state = "open" }) → [{ number, title, headRefName, updatedAt }]`
  - `allChecksGreen(checks, required = null)` — `required`가 있으면 그 이름들이 **모두 존재하고 모두 pass**일 때만 true(없는 이름 → false); `required`가 null이면 기존 동작.
  - `loadHarness`: `h.factory = { orchestration: "workflow", required_checks: ["factory/gates","factory/review","factory/integrity"], ...(h.factory||{}) }`.
  - `mergeGates({ …, required })`가 `allChecksGreen(checks, required)`를 쓰고, `run-stage main`이 `harness.factory.required_checks`를 넘긴다.

- [ ] **Step 1: 실패하는 테스트** — 각 메서드가 만드는 `gh` 인자 배열을 `makeFakeRun`으로 검사(기존 `gh.test.js` 스타일). `allChecksGreen([{name:"factory/gates",bucket:"pass"},{name:"lint",bucket:"fail"}], ["factory/gates"])` → true; `required`에 없는 이름 → false; `required=null`이면 기존 규칙. `mergeGates`에 `required` 전달 케이스.

- [ ] **Step 2~5**: 구현 → 통과 → 커밋 `feat(factory): gh surface for bootstrap/status/merge; required_checks filter for merge gate`.

---

### Task 10: `bootstrap` (라벨·branch protection·토큰 발급일)

**Files:**
- Create: `factory/lib/label-catalog.js`, `factory/lib/bootstrap.js`, `factory/cli/bootstrap.js`
- Test: `factory/test/bootstrap.test.js`

**Interfaces:**
- Produces:
  - `LABELS: [{ name, color, description }]` — `backlog`(#c5def5), 13개 `factory:*` 상태(§3.1; queue #0e8a16, ready #1d76db, needs-info #fbca04, wont-do #cccccc, planned #5319e7, in-progress #0052cc, awaiting-review #d4c5f9, rework #e99695, approved #0e8a16, merged #6f42c1, blocked #b60205, needs-human #b60205), 보조 `factory:tier-docs/-standard/-load-bearing`(#bfdadc), `factory:retro-proposal`(#f9d0c4), `factory:flaky`(#fef2c0), `factory:harness`(#c2e0c6). 설명은 §3.1 "의미" 열.
  - `bootstrapPlan({ harness, today, existing: { labels, variables, secrets } }) → Op[]`, `Op = { kind: "label"|"protection"|"variable"|"note", … }`. 라벨: 카탈로그 전부(`--force`로 색·설명 갱신 — 있어도 포함, `existing`은 보고용). protection body:
    ```js
    { required_status_checks: { strict: true, contexts: harness.factory.required_checks }, enforce_admins: true, required_pull_request_reviews: null, restrictions: null, required_linear_history: true, allow_force_pushes: false, allow_deletions: false, required_conversation_resolution: false }
    ```
    variable: `FACTORY_TOKEN_ISSUED_AT`가 없을 때만 `today`(YYYY-MM-DD), 있으면 `note`. secrets: `FACTORY_BOT_TOKEN`, (`CLAUDE_CODE_OAUTH_TOKEN`|`ANTHROPIC_API_KEY`) 부재 시 `note`("gh secret set … — bootstrap never writes secret values").
  - `applyBootstrap({ gh, ops, harness, log }) → { applied, notes }`
  - `bootstrapCommand({ root, argv, io, gh, today }) → number`; `--dry-run`은 ops를 출력만; `--token-issued-at YYYY-MM-DD`로 변수를 강제 갱신.

- [ ] **Step 1: 실패하는 테스트** — `LABELS`가 §3.1 상태 13개 + backlog + 보조 6개 = 20개, 이름 유일; `bootstrapPlan`의 protection body가 위와 같고 `contexts`가 harness에서 옴; 변수 있으면 note; `applyBootstrap`이 fake gh에 `createLabel` 20회·`putBranchProtection(default_branch, body)` 1회·`setVariable` 1회를 부른다; `--dry-run`은 gh를 부르지 않는다.

- [ ] **Step 2~5**: 구현 → 통과 → 커밋 `feat(factory): bootstrap — labels, branch protection with required checks, token issue date`.

---

### Task 11: run-stage — 체크 상태 게시 (`factory/gates`, `factory/review`)

**Files:**
- Modify: `factory/bin/run-stage.js`
- Test: `factory/test/run-stage.test.js`(추가)

**Interfaces:**
- `deps.reportStatus?({ context, state, description, sha })` — best-effort: throw해도 런을 죽이지 않고 `record(["status: <context> post failed — …"])`.
- 게시 시점: (a) implement·review·merge에서 `gates`가 null이 아니면 `factory/gates` — `state = gates.status === "GREEN" ? "success" : "failure"`, `description = verdictLine(gates)`, `sha = gates.head_sha`. (b) review에서 aggregate 뒤 `factory/review` — `approved → success`, `rework → failure`, `incomplete → error`, `sha = v.data.head_sha`, `description = "review round <n>: <decision> (<k>/<n> approve)"`.
- `main`의 실제 구현: `gh.setStatus({ sha, context, state, description })`.

- [ ] **Step 1: 실패하는 테스트** — deps에 `reportStatus: vi.fn()`을 넣고 (a) implement GREEN → `factory/gates success` 1회, (b) review approved → `factory/gates` + `factory/review success`, (c) review rework → `factory/review failure`, (d) `reportStatus`가 throw → 런은 계속되고 record에 "post failed" 줄, (e) plan 스테이지는 아무것도 게시하지 않는다.

- [ ] **Step 2~5**: 구현 → 통과 → 커밋 `feat(factory): post factory/gates and factory/review commit statuses from run-stage`.

---

### Task 12: run-stage — review·merge의 PR head checkout (R6)

**Files:**
- Modify: `factory/bin/run-stage.js`
- Test: `factory/test/run-stage.test.js`(추가)

**Interfaces:**
- `deps.checkoutHead?() → { ok, sha?, pr?, reason? }` — review·merge에서 `assertHandoff` 직후·in-progress 전이 자리에서 호출. `!ok` → `transition(needs-human, reason)` + record + return 2.
- `main` 구현: 최신 implement handoff의 `head_sha`·`pr`; `gh.prHeadSha(pr)`가 다르면 `{ ok:false, reason: "PR head moved since implement handoff (<a> → <b>)" }`; `git fetch origin claude/fq-<issue>` → `git checkout --detach <sha>`; git 실패 → `{ ok:false, reason }`. 그 다음 `mergeBase()`는 detach된 HEAD 기준으로 계산되므로 순서상 checkout이 먼저여야 한다(테스트로 고정: `calls` 순서에 `checkout`이 `gates`보다 앞).

- [ ] **Step 1~5**: 테스트(순서·실패 경로·implement에는 호출 없음) → 구현 → 커밋 `feat(factory): review/merge stages run gates on the PR head (detached checkout bound to the implement handoff)`.

---

### Task 13: merge 스테이지 스크립트 전용화 (R3)

**Files:**
- Create: `factory/lib/merge-stage.js`
- Modify: `factory/bin/run-stage.js`(merge 분기), `factory/lib/labels.js`(`factory:approved → factory:rework` 엣지)
- Test: `factory/test/merge-stage.test.js`, `factory/test/labels.test.js`(엣지), `factory/test/run-stage.test.js`(merge가 claudeP를 부르지 않음)

**Interfaces:**
- `runMergeStage({ issue, defaultBranch, d, record, refusal }) → Promise<0|2>` — `d`: `prInfo() → { pr, state, mergeable, headRefOid }`, `gates()`, `mergeGates() → { checksGreen, integrityGreen }`, `mergePr(pr)`, `transition({ to, reason })`, `closeIssue(pr)`, `reportStatus?`.
  흐름: (1) `prInfo` — `pr`가 없거나 `state !== "OPEN"` → needs-human. (2) `mergeable === "CONFLICTING"` → `transition({ to: "factory:rework", reason: "merge conflict — rebase onto <default>" })` → 2. (3) `gates()` → `BLOCKED` → blocked; `!GREEN` → needs-human("gates <status> at merge"). (4) `mergeGates()` → 둘 다 true가 아니면 needs-human(사유에 어느 쪽인지). (5) `mergePr(pr)` 실패 → blocked("merge API failed: …"). (6) `transition({ to: "factory:merged" })` — 거부되면 record만(이미 머지됨 — 되돌릴 수 없으므로 needs-human 코멘트는 transition이 남긴다). (7) `closeIssue`. 반환 0.
- `runStage`: `stage === "merge"`이면 `claim → resetGates → heartbeat → assertHandoff → checkoutHead → runMergeStage`(claudeP·buildContext·verifyStage·writeHandoff 없음; `trustWorkspace`도 호출하지 않음). `main`: `prInfo = () => gh.prView(latestHandoff(comments,"implement").data.pr)`, `mergePr = (pr) => gh.mergePr(pr, { method: "squash", deleteBranch: true })`, `closeIssue = (pr) => gh.closeIssue(issue, \`merged via PR #${pr}\`)`. gates는 기존 `d.gates(ctx)`를 `tier`만 넘겨 재사용(ctx 대신 `{ tier: handoffs.triage?.tier ?? charter.tier_default }`).
- `NEXT_OF.merge`·`STAGES`는 유지. `.claude/commands/factory-merge.md`는 없다(Task 1에서 이미 미설치).

- [ ] **Step 1~5**: 위 7단계 각각의 테스트(순서 고정, 각 실패 경로의 전이·record) → 구현 → 커밋 `feat(factory): merge stage is script-only — gates on PR head, required checks, squash merge, conflict → rework`.

---

### Task 14: run 기록 브랜치 `factory/records` (ADR-014)

**Files:**
- Create: `factory/lib/records-branch.js`
- Modify: `factory/bin/run-stage.js`(finally에서 `d.syncRecords?.()`), `docs/factory/DECISIONS.md`(ADR-014)
- Test: `factory/test/records-branch.test.js`(실제 임시 git repo + bare remote)

**Interfaces:**
- `syncRecords({ run, cwd, branch = "factory/records", dir = "docs/factory/runs", message, env = {} }) → { ok, commit?, reason?, retried }` — plumbing만 사용, 워킹 트리·인덱스·현재 브랜치를 건드리지 않는다:
  1. `git fetch origin refs/heads/<branch>:refs/factory/records-remote` (실패 = 브랜치 없음 → parent 없음)
  2. 임시 `GIT_INDEX_FILE`(`.git/factory-records.index`, 끝나면 삭제): parent가 있으면 `read-tree <parent>`, 없으면 빈 인덱스
  3. `dir` 아래 `*.md` 각각 `hash-object -w` → `update-index --add --cacheinfo 100644,<blob>,<path>`
  4. `write-tree` → `commit-tree <tree> [-p <parent>] -m <message>` → `git push origin <commit>:refs/heads/<branch>`
  5. push가 non-fast-forward로 거부되면 1~4를 **한 번** 재시도(`retried: true`), 그래도 실패면 `{ ok:false, reason }`
- `readRecords({ run, cwd, branch, dir }) → Map<issue, text>` — fetch 후 `ls-tree -r --name-only` + `show <ref>:<path>`; 브랜치 없으면 빈 Map.
- run-stage: finally 블록의 `release` 뒤에 `try { const s = await d.syncRecords?.(); if (s && !s.ok) console.error(…) } catch {}` — 기록 동기화 실패는 런 결과를 바꾸지 않는다.

- [ ] **Step 1: 실패하는 테스트** — `mkdtemp` 두 개: bare remote + clone. (a) 첫 sync: 브랜치 생성, `git -C remote show factory/records:docs/factory/runs/7.md`가 내용과 같음; 워킹 트리 `git status --porcelain`이 비어 있고 현재 브랜치 불변. (b) 두 번째 sync: parent 연결(커밋 2개), 파일 갱신. (c) 경쟁: 두 번째 클론이 먼저 push한 뒤 첫 클론이 sync → `retried: true`, 양쪽 파일 모두 존재. (d) `readRecords` 라운드트립. (e) remote 없음 → `{ ok:false }`, throw 없음.

- [ ] **Step 2~4**: 구현 → 통과. **Step 5**: ADR-014 작성(제목 "run 기록은 `factory/records` 브랜치 — 보호된 default 브랜치에는 직접 push할 수 없다", 관측: required status checks가 있는 브랜치는 직접 push가 거부됨, 결정: plumbing append + 재시도 1회, 영향: §4.2.1 step 9·§9·status·retro) → 커밋 `feat(factory): append run records to the factory/records branch (ADR-014)`.

---

### Task 15: 사용량 파싱 + `factory status`

**Files:**
- Create: `factory/lib/usage.js`, `factory/lib/status.js`, `factory/cli/status.js`
- Test: `factory/test/usage.test.js`, `factory/test/status.test.js`

**Interfaces:**
- `parseRunRecord(text) → [{ stage, at /*ISO*/, runner, cost_usd: number|null, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, num_turns, models: { [model]: costUSD } }]` — `## <stage> · <ts> · <runner>` 헤더로 섹션을 나누고 각 섹션의 `usage: {…} cost_usd: X num_turns: N terminal_reason: … models: a=$1.2, b=$0.3` 줄을 파싱(없으면 usage 필드 null). `usage` JSON의 키는 Claude Code `-p` 출력의 `usage`(`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`)를 그대로 읽는다.
- `summarizeUsage(records /*Map<issue,text>*/, { now, windowDays = 7 }) → { perIssue: [{ issue, cost_usd, runs, tokens: { input, output } }], window: { since, cost_usd, runs }, total: { cost_usd, runs } }` — 이슈별은 cost 내림차순.
- `buildStatus({ issues /*gh.issueList 결과 전체(open+closed 최근)*/, prs, heartbeats /*Map<issue, lastISO>*/, quarantine, thresholds, charter, usage, now }) → { needsYou: [{ kind, number, title, hint }], queue, inProgress: [{ number, title, state, stage, age_min, stale }], recent: [{ number, title, mergedAt }], backPressure: { awaiting_review: n, max: charter.back_pressure.awaiting_review_max, quarantined: n, quarantine_max }, usage }` — `needsYou.hint`는 `:unstick <n>`·`:clarify <n>`·`:proposal <pr>`·`:harness <pr>`.
- `renderStatus(s) → string` (Needs You → 진행 중 → 큐 → 역압 → 최근 머지 → 사용량 순, §13 `:status`와 같은 순서).
- `statusCommand({ root, argv, io, gh, run, now }) → number` — `gh.issueList`로 각 상태 라벨 조회(open) + `factory:merged` closed 최근 10, `gh.prList({label:"factory:retro-proposal"})`·`gh.prList({label:"factory:harness"})`, heartbeat는 in-progress 이슈의 코멘트에서 `<!-- factory-heartbeat issue=<n> -->` 마지막 `last:` 값을 읽는다, 기록은 `readRecords`(실패 시 로컬 `docs/factory/runs` fallback). `--json`은 `buildStatus` 결과 그대로.

- [ ] **Step 1: 실패하는 테스트** — `appendRunRecord` + `usageLine`으로 만든 실제 형식의 기록을 파싱(2 스테이지, 하나는 usage 없음); 7일 창 경계(now-8d는 제외); `buildStatus`가 needs-human·needs-info·retro-proposal PR을 Needs You로, 35분 지난 heartbeat를 `stale:true`로, awaiting-review 수/역압 상한을 계산; `renderStatus`가 섹션 순서를 지킨다; `statusCommand --json`이 fake gh로 exit 0.

- [ ] **Step 2~5**: 구현 → 통과 → 커밋 `feat(factory): usage parsing from run records and factory status (read-only)`.

---

### Task 16: `factory run <stage> <issue>` (로컬 실행, R7)

**Files:**
- Create: `factory/cli/run.js`
- Modify: `factory/bin/run-stage.js`(`d.localEntry`)
- Test: `factory/test/run-cli.test.js`, `factory/test/run-stage.test.js`(localEntry 케이스)

**Interfaces:**
- `runCommand({ root, argv, io, run, spawnInherit, env = process.env }) → Promise<number>`:
  1. `stage ∈ {triage, plan, implement, review}`; `merge` → err "merge runs only in CI (branch protection)" exit 1; `retro` → err "retro arrives with Plan 4" exit 1; 그 외 usage exit 1.
  2. `.factory/bin/run-stage.js` 없음 → err "factory not initialized — run factory init" exit 1.
  3. `.factory/node_modules/smol-toml/package.json` 없음 → `run("npm", ["install", "--prefix", ".factory", "--no-audit", "--no-fund"], { cwd: root })`; 실패 → exit 1.
  4. `run("gh", ["auth", "status"])` 실패 → exit 1 with hint.
  5. `spawnInherit("node", [".factory/bin/run-stage.js", stage, issue], { cwd: root, env: { ...env, FACTORY_LOCAL_ENTRY: "1" } }) → exitCode`를 그대로 반환. `spawnInherit` 기본 구현은 `spawnSync(..., { stdio: "inherit" })`.
- run-stage `d.localEntry?()`: claim 직후·resetGates 전에 호출. `main` 구현: `process.env.FACTORY_LOCAL_ENTRY && stage === "triage"`이고 이슈의 factory 라벨이 없으면서 `backlog`를 갖고 있으면 `gh.setFactoryLabel(issue, "factory:queue")` + 코멘트 `<!-- factory-transition:v1 from=backlog to=factory:queue by=local -->`(§4.2.5 — lock을 이미 잡았으므로 GitHub 잡은 claim에 실패한다). 그 외에는 no-op. 반환값은 record 한 줄(`local entry: backlog → factory:queue`).

- [ ] **Step 1: 실패하는 테스트** — 위 1~5 각각(fake run·spawnInherit 캡처, env에 `FACTORY_LOCAL_ENTRY`); run-stage에 `localEntry: vi.fn()`을 넣고 claim 뒤·resetGates 앞에 호출됨을 `calls` 순서로 확인, claim 실패 시 호출되지 않음.

- [ ] **Step 2~5**: 구현 → 통과 → 커밋 `feat(factory): factory run — local stage execution with the CI scripts; triage on backlog claims first then queues`.

---

### Task 17: 문서 동기화 + 패키징 마무리

**Files:**
- Modify: `docs/factory/DECISIONS.md`(ADR-015), `docs/superpowers/specs/2026-09-10-factory-design.md`(§3.2 전이도에 `approved --> rework: merge conflict`, §4.1 표의 review 트리거·merge "스크립트 전용"·retro 행에 "(Plan 4)"·checkout/setup-node/upload-artifact `@v4`, §4.2.1 step 4에 "merge는 호출하지 않음"·step 9 "`factory/records` 브랜치", §6.1 토큰 문단(R2)·required checks 게시 주체(R3 상태), §2.2 "backlog 이슈에 `factory run triage`"), `bin/cli.js`(help 최종), `package.json`(`files` 확인), `README.md`(있으면 "Phase 2" 절 5줄: init/doctor/bootstrap/run/status)
- Test: 기존 전체 `npm test` GREEN; `node bin/cli.js factory --help`; `npm pack --dry-run`에 `factory/cli/`·`templates/factory/`·`factory/lib/parsers/`가 포함되고 `factory/test/`가 없음.

- [ ] **Step 1: ADR-015 작성** — 제목 "Plan 2 배선 판결 — 리뷰 트리거·단일 PAT·체크 상태·merge 스크립트 전용". 본문은 이 문서의 R1·R2·R3·R5·R6·R7을 관측(GitHub 규칙: `GITHUB_TOKEN` 이벤트는 워크플로를 깨우지 않음; 라벨 조건부 required reviewer 불가; 게이트는 워킹 트리에서 돈다)·결정·영향(§ 번호)으로 옮긴다.
- [ ] **Step 2: 스펙 편집** — 위 목록. 각 편집 자리에 `(Plan 2 실행 판결, ADR-015)` 또는 `(ADR-014)`를 남긴다.
- [ ] **Step 3: `npm test` + `npm pack --dry-run`** — 결과를 원장에 붙인다.
- [ ] **Step 4: 커밋** `docs(factory): ADR-014/015 and spec sync for Plan 2 wiring; packaging check`.

---

## Self-Review

**Spec coverage.** §2.1 CLI 5개 — Task 4·8·10·16·15. §2.2 `factory run` — Task 16(R7). §4.1 yml 8개 중 7개 — Task 3(retro는 Plan 4, R4). §4.2.1 step 0(charterReady 기존)·0.5(trustWorkspace 기존, merge 제외)·9(records 브랜치) — Task 14. §4.2.5 — Task 16. §4.3 sweeper yml — Task 3. §4.4 시크릿 확인(doctor)·토큰 발급일(bootstrap)·소비 보고(status) — Task 7·10·15. §4.5 `.factory/` 커밋 — Task 2·4. §5.1 `harness.toml` 템플릿 + doctor 검사 목록(명령 실행, required ⊆ commands, protected glob 매치, 훅 stdin, test.env + smoke) — Task 1·6·7·8. §5.2.6 `test-env` + composite action — Task 5·3. §5.3 CHARTER 템플릿 — Task 1. §6.1 required checks 3개·branch protection(linear history, no force-push, enforce_admins) — Task 9·10·11. §6.3 settings.json — Task 1·2(병합). §7.1 roles.toml — Task 1. §9 run 기록 — Task 14·15. §11 그린필드 흐름의 `init → doctor → bootstrap` — Task 4·8·10. §13.4 — 스킬 설치는 Plan 5; `factory status`는 Task 15. 갭: `doctor`의 "스킬 파일 섹션 존재 검사"(§13.3)는 Plan 5로 이월(스킬이 아직 없다).

**Placeholder scan.** Task 7·8·9·10·11·12·13·15·16의 Step 3은 인터페이스·흐름·예외 경로를 문장으로 고정했고 코드는 Task 1~6 수준의 완전한 본문이 아니다 — 실행자는 Step 1의 테스트가 요구하는 시그니처를 그대로 구현한다. "적절히 처리" 류의 문구는 없다.

**Type consistency.** `Check = {id, level, detail}`(Task 6·7·8 공통), `Action.action ∈ create|skip|replace|merge|keep`(Task 2·4), `gh.setStatus({sha, context, state, description})`(Task 9·11·13), `allChecksGreen(checks, required)`(Task 9·13), `syncRecords/readRecords`(Task 14·15), `envUp/envDown` 반환 `{ok, steps, pids}`(Task 5·8), `runMergeStage` deps 이름(Task 13) ↔ `gh.prView/mergePr/closeIssue`(Task 9).
