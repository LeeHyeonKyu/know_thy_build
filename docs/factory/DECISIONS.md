# Factory Decisions

형식: **ADR-NNN · 날짜 · 질문 · 관측(수치) · 결정 · 영향 받는 스펙 절**

ADR-001~008은 Plan 0(spikes)에서 실제 GitHub Actions 러너(`ubuntu-latest`, repo `LeeHyeonKyu/know-thy-build-demo`)로 측정한 결과다. 관측 칸의 수치는 전부 실측이며 추정치에는 그렇다고 표시한다. ADR-009는 스파이크가 아니라 Plan 0 실행 중 발견한 러너/yml 관례다.

공통 실행 조건: `claude -p` · `--permission-mode dontAsk` · `--max-turns 5` · `--output-format json` · CLI는 잡마다 `npm i -g @anthropic-ai/claude-code`로 설치.

| ADR | 주제 | 결과 |
|---|---|---|
| 001 | settings.json 훅의 Workflow 서브에이전트 적용 | PASS |
| 002 | `-p`에서 저장 Workflow 실행 | PASS |
| 003 | StructuredOutput schema 신뢰도 | PASS |
| 004 | 러너 자원 | PASS |
| 005 | 구독 토큰 usage limit 소모 | PASS (소모함 — 보고하고 제한하지 않는다) |
| 006 | 메인 세션만 도구 제한 | FAIL → 사후 검증 |
| 007 | idle ceiling | MOOT |
| 008 | 신뢰되지 않은 워크스페이스의 allow/deny | PASS (CI 필수 조치 도출) |
| 009 | 러너/yml 관례 | (스파이크 아님 — 실행 중 발견) |

---

## ADR-001 settings.json 훅의 Workflow 서브에이전트 적용 — 2026-09-11

**질문**: `.claude/settings.json`의 훅이 Workflow `agent()`로 뜬 서브에이전트 안에서도 발화하는가. 안 되면 L2를 에이전트 frontmatter 훅 + 사후 검사로 옮겨야 한다(§12.1-1).

**관측** (spike-1-hooks, run [34573737960](https://github.com/LeeHyeonKyu/know-thy-build-demo/actions/runs/34573737960), 워커 2명):

| 이벤트 | 발화 | 식별 필드 |
|---|---|---|
| `PreToolUse` (Bash) | 8줄 | `agent_id`, `agent_type` 포함 |
| `PreToolUse` (Write/Read) | 발화 | `agent_id`, `agent_type` 포함 |
| `SubagentStart` | 2줄 (워커 2명과 정확히 일치) | `["agent_id","agent_type","cwd","hook_event_name","prompt_id","session_id","transcript_path"]` |
| `SubagentStop` | 2줄 | 위 + `agent_transcript_path`, `background_tasks`, `effort`, `permission_mode`, `session_crons`, `stop_hook_active` |
| `Stop` (메인 세션) | 2줄 | `agent_id` **없음** → 메인/서브에이전트 구분 가능 |

- `PreToolUse(Bash)` 8줄은 워커가 지시받은 `echo SPIKE_WORKER_BASH_<n>` 2건 + 워크플로/디스패처 경로의 부수 Bash(mkdir/ls/touch 등)를 합친 수다.
- `test -f .spike/worker-1.txt && test -f .spike/worker-2.txt` 통과 — 워커가 Write 툴로 실제 파일을 만들었음을 확인.
- 이 러너에서도 `.claude/settings.json`의 `permissions.allow` 7개가 "workspace has not been trusted"로 무시됐으나(→ ADR-008), `dontAsk`가 모든 툴 호출을 승인해 훅 발화 자체에는 영향이 없었다.

**결정**: L2 훅은 **`.claude/settings.json`에 둔다**(§6.3 설계 유지). 네 이벤트(`PreToolUse`/`SubagentStart`/`SubagentStop`/`Stop`)가 모두 workflow 서브에이전트 안에서 발화하고, stdin JSON의 `agent_id`/`agent_type`으로 메인 세션 호출과 서브에이전트 호출을 분리할 수 있으므로 에이전트 frontmatter 훅으로의 대체는 불필요하다. 부수 효과로 **`verify-stage.sh`의 로스터·라운드 검증 근거를 훅 기록으로 삼는다**: `SubagentStart`/`SubagentStop` 라인의 `agent_type`을 세면 "누가 몇 명 떴는가"가 나온다(→ ADR-002의 `subagent_stats` 불가 사유와 짝).

**이 결정의 미확인 부분 — `agent_type`의 값 형식.** 스파이크의 로깅 훅은 stdin JSON을 `jq -c 'keys'`로만 남겼으므로 **확인된 것은 `agent_id`·`agent_type`이 존재한다는 사실뿐**이고, `agent_type`의 **값**이 등록된 역할 이름(`.claude/agents/<role>`의 파일명/`name`)과 같은 문자열인지는 관측하지 않았다. 인원 수를 세는 용도(`SubagentStart` 라인 수 == 로스터 크기)는 값 형식과 무관하게 성립하지만, **"누가"를 로스터와 문자열 대조하는 부분은 근거가 없다.** Plan 1은 `verify-stage.sh`를 쓰기 전에 이 값을 먼저 실측하고(훅에서 `keys`가 아니라 값을 찍는다), 형식이 다르면 매핑 테이블을 끼우거나 `label` 등 다른 필드로 대조 축을 바꾼다.

**영향**: §6.3(L2 배치 확정 · 훅 로그를 verify 입력으로), §4.2.1 step 6, Plan 1(`verify-stage.sh` 설계), Plan 3(훅 배치).

---

## ADR-002 `-p`에서 저장 Workflow 실행 — 2026-09-11

**질문**: Actions 무인 환경의 `claude -p "/factory-<stage> <issue>"`가 저장된 `.claude/workflows/<name>.js`를 실제로 실행하고 결과를 회수하는가. 필요한 권한 규칙은 무엇인가(§12.1-2).

**관측** (spike-2-p-workflow, run [34573640589](https://github.com/LeeHyeonKyu/know-thy-build-demo/actions/runs/34573640589)):

- 결과 **PASS**: `-p "/spike-dispatch 7"` → 커맨드 파일 확장 → `Workflow(spike-basic)` 호출 → 서브에이전트 2명 병렬 → stdout JSON의 `result`에 `SPIKE_BASIC_OK`, `alpha-7`, `beta-7`이 verbatim 회수.
- **턴 수 1 · 소요 12s · 비용 $0.08908150000000001** (`--max-turns 5` 예산 대비 여유 큼).
- 서브에이전트 CLAUDE.md 주입: **yes** — agent `a`/`b` 모두 `claude_md_marker: "yes"`(CLAUDE.md의 `MARKER_CLAUDE_MD_LOADED=yes`를 정확히 보고).
- 권한 규칙 `Workflow(spike-basic)`: **무의미했다** — `.claude/settings.json`의 `permissions.allow` 7개 전부가 `Ignoring 7 permissions.allow entries from .claude/settings.json: this workspace has not been trusted`와 함께 무시됐다(→ ADR-008). 그럼에도 `--permission-mode dontAsk` 단독으로 모든 툴 호출이 프롬프트 없이 통과, `permission_denials: []`.
- **`subagent_stats.spawned: 0`** — 워크플로 서브에이전트 2명이 실제로 떴는데도 0이었다. **`-p` stdout JSON의 `subagent_stats`는 Workflow `agent()` 서브에이전트를 세지 않는다.** (출처: 이 run의 잡 로그 — spike-2의 yml이 `out.json` 전문을 그대로 출력한다. ADR-002 초안에는 없고 컨트롤러가 원본 로그에서 확인한 항목이다.)
- `-p` 출력 JSON이 함께 싣는 필드: `permission_denials`, `modelUsage`, `terminal_reason`, `num_turns`, `total_cost_usd`, `usage`. 전부 §9 run 기록에 그대로 옮길 수 있다. (출처: 같은 로그의 `out.json` 전문.)

**결정**: **orchestration 기본값 `workflow` 유지**(후퇴 없음 — 아래 "후퇴 결정" 참조). 단 두 가지를 확정한다:
1. `verify-stage.sh`는 **`subagent_stats`를 쓰지 않는다.** 로스터·인원·라운드 검증은 훅 기록(`SubagentStart`/`SubagentStop`의 `agent_id`/`agent_type`, ADR-001)으로 한다 — 단 `agent_type` **값**이 역할 이름과 같은지는 미확인이므로 Plan 1이 먼저 실측한다(ADR-001 참조).
2. run 기록(§9)에 `permission_denials`, `modelUsage`, `terminal_reason`, `num_turns`, `total_cost_usd`를 싣는다 — 무료로 얻는 감사 자료다.

**영향**: §4.2.1 step 4·6, §4.2.4(모드 기본값 유지), §6.3, §9(run 기록 필드), Plan 1(`verify-stage.sh`).

---

## ADR-003 StructuredOutput schema 신뢰도 — 2026-09-11

**질문**: `agent({schema})`가 null(스키마 파싱 실패)을 얼마나 자주 내는가. 높으면 §7.5의 "리뷰어 재spawn 1회" 규칙으로 흡수해야 한다(§12.1-3).

**관측** (spike-3-schema, run [34574561593](https://github.com/LeeHyeonKyu/know-thy-build-demo/actions/runs/34574561593), 20 agent 1회 실행):

| 항목 | 값 |
|---|---|
| null | **0/20** (opus 0/10, sonnet 0/10) |
| reject 판정(정답) | **20/20** (opus 10/10, sonnet 10/10 — 스니펫의 타임존 버그를 전원 정확히 지적, approve 0건) |
| 비용 | **$1.5526413500000003** |
| 턴 수 / 소요 | `num_turns: 2` / `duration_ms: 85092` (≈85초) |
| 스키마 복잡도 | 중첩 배열 `must_fix[]` + object required 필드 + enum 3종 — 모든 항목에서 스키마대로 채워짐 |

인덱스 짝수=opus / 홀수=sonnet 매핑으로 모델별 귀속까지 1회 실행으로 확인했다.

**결정**: §7.5의 **"null 시 해당 리뷰어 1회 재spawn" 규칙은 유지하되, 그 성격은 '보험'이다.** 이번 표본에서 null은 0건이라 재시도 경로가 한 번도 발동하지 않았고 따라서 **검증된 적이 없다**. 표본이 20회 1세트뿐이라 신뢰구간이 넓으므로 제거하지 않는다. 부수 결정: **모델 고정은 불필요**(opus/sonnet 둘 다 100% 파싱·100% 정답), **스키마 복잡도를 낮출 이유도 없음**.

**영향**: §7.5(재spawn 규칙을 보험으로 명시), §12.2(`aggregate-review.sh`의 schema 불일치 경로는 테스트로만 커버됨).

---

## ADR-004 러너 자원 — 2026-09-11

**질문**: 표준 `ubuntu-latest`에서 compose(postgres) + 앱 + headless playwright + playwright MCP를 동시에 돌릴 수 있는가. `full` 레벨 소요 시간은(§12.1-4).

**관측** (spike-4-resources):

1차 시도 run [34576307302](https://github.com/LeeHyeonKyu/know-thy-build-demo/actions/runs/34576307302) — **실패**. `env up`은 정상(`env_up=60s`, `Mem: total 7937 / used 1466 / free 2280 / available 6471` MB)이었으나 `npm test`(vitest)가 기본 glob으로 `e2e/smoke.spec.js`까지 집어 `Error: Playwright Test did not expect test() to be called here`로 죽었다(vitest 자체 테스트 2개는 통과). `vitest.config.js`에 `test.exclude: ["e2e/**"]`를 추가해 1회 재실행.

2차 시도 run [34576571041](https://github.com/LeeHyeonKyu/know-thy-build-demo/actions/runs/34576571041) — **전 스텝 성공**, 잡 총 소요 **1m14s**.

| 항목 | 값 |
|---|---|
| env_up (docker compose + chromium 설치 포함) | **36s** |
| full (unit+integration) | **2s** |
| e2e (deep) | **2s** |
| 메모리 (env up 직후, `free -m`) | total 7938MB · used 1224MB · free 2454MB · **available 6714MB** |
| 메모리 (e2e 직후) | total 7938MB · used 1385MB · free 2252MB · **available 6553MB** |
| playwright MCP headless | `.result` = `"{\"ok\":true}"` — claude가 MCP로 브라우저를 몰아 healthz 본문을 그대로 회신 |
| `.mcp.json` 승인 | **문제 없었음** — `trust-workspace`를 MCP 스텝 이전에 실행해두면 `enableAllProjectMcpServers` **없이** project scope MCP 서버가 그대로 로드된다 |

**결정**:
- M2 시나리오(compose + 앱 + chromium + playwright MCP 동시 실행)는 **표준 러너로 가능**. 전체 7.9GB 중 가용 6.5~6.7GB를 유지했고 CPU/시간 경합 징후 없음. **대형 러너는 불필요**.
- **`runtime_budget_min` 기본값은 12분 그대로 유지한다.** 스파이크 초안은 10분을 제안했으나 이번 측정(full 2s, e2e 2s)은 **매우 가벼운 데모 앱** 기준이라 실제 앱 규모를 대표하지 않는다. 실측으로 기본값을 내리는 것은 **dogfood(§12.3) 이후**로 미룬다 — 이번 데이터는 "표준 러너가 자원 때문에 막히지는 않는다"만 증명한다.
- `.mcp.json` project scope 서버는 **trust 부트스트랩(ADR-008)이 선행되면 `enableAllProjectMcpServers` 없이 로드**된다. §4.5의 MCP 행은 이 조건을 함께 적는다.
- 후속 조치: `factory init`이 만드는 스캐폴드에 **`vitest.config.js`의 `test.exclude: ["e2e/**"]`**(또는 등가의 러너 분리)를 포함시킨다. 하네스 `[test]`가 unit/e2e를 분리해 선언해도 러너 도구가 글롭으로 서로를 집어먹으면 `full`이 통째로 빨간색이 된다.
- 재검토 조건: e2e가 다수 브라우저 컨텍스트를 병렬로 띄우거나 postgres에 대량 fixture를 싣는 워크로드로 커져 `available`이 관측치 대비 크게 줄면 대형 러너를 다시 본다.

**영향**: §4.5(자원 행·MCP 행), §5.1 `runtime_budget_min`(값 유지), §5.2.6(환경), §12.3(dogfood에서 재측정).

---

## ADR-005 구독 토큰 usage limit 소모 — 2026-09-11

**질문**: `CLAUDE_CODE_OAUTH_TOKEN`(구독 `claude setup-token`)으로 CI를 돌리면 **개인 구독의 usage limit을 소모하는가**. 공식 문서에 명시가 없다(§4.4, §12.1-5).

**관측**:
- **사람 판독 (`/usage`, 구독 7일 창)**: 스파이크 시작 시점 **92%** → 스파이크 0~8 종료 후(부하 잡 실행 전) **94%**. 즉 **구독 창을 소모한다 — 답은 yes.**
- 단 이 **+2%p는 상한**이다: 같은 기간 사람의 인터랙티브 로컬 세션(Plan 0 오케스트레이션)이 같은 7일 창을 공유하며 돌고 있었다. CI 단독 귀속분을 분리 측정한 값이 아니다.
- **CI 측 실측 합계** (stdout에 `usage`/`total_cost_usd`를 남긴 3개 run, `gh run view --log`로 확인):

| run | workflow | input | output | cache_creation | cache_read | total_cost_usd |
|---|---|---:|---:|---:|---:|---:|
| [34573333760](https://github.com/LeeHyeonKyu/know-thy-build-demo/actions/runs/34573333760) | spike-0-auth | 2 | 144 | 9,214 | 18,531 | 0.0429652 |
| [34573640589](https://github.com/LeeHyeonKyu/know-thy-build-demo/actions/runs/34573640589) | spike-2-p-workflow | 2 | 134 | 1,045 | 28,790 | 0.0890815 |
| [34574561593](https://github.com/LeeHyeonKyu/know-thy-build-demo/actions/runs/34574561593) | spike-3-schema | 4 | 12,673 | 31,051 | 62,492 | 1.5526414 |
| **합계** | | **8** | **12,951** | **41,310** | **109,813** | **$1.6846881** |

- 이 $1.68은 **부분 합**이다: 나머지 9개 run(스파이크 1·4·6·6b·7·7b·8)의 yml이 `.result`·타이밍만 `jq`로 찍고 `usage`/`total_cost_usd`를 stdout에 남기지 않아 로그만으로 복원할 수 없다. 실제 CI 귀속분은 이보다 크다.
- 전용 burn 잡(`spike-5-usage.yml`, `/spike-schema-dispatch` 3회 ≈ $1.55×3)은 **의도적으로 돌리지 않았다** — run [34577204905](https://github.com/LeeHyeonKyu/know-thy-build-demo/actions/runs/34577204905)는 7일 창이 94%에 도달한 것을 보고 사람이 **직접 취소**(08:02:18Z 시작 → 08:03:39Z cancelled, 약 1m21s). `.spike/usage-*.json`·`.spike/total-tokens`는 생성되지 않았다. 남은 한도를 지키는 쪽이 정확한 분모보다 중요했고, 위 7일 창 판독만으로 질문(소모하는가)의 답은 이미 나왔다.

**결정**: **구독 토큰(`CLAUDE_CODE_OAUTH_TOKEN`)이 factory의 기본 운영 모드다.** CI 소비는 사람의 개인 7일 창에 그대로 반영된다. 이에 대한 factory의 대응은 **제한이 아니라 보고**다:
- 잡마다 `-p` stdout JSON의 `usage`, `total_cost_usd`, `modelUsage`를 run 기록(§9)에 남긴다(ADR-002가 이 필드들의 존재를 확인).
- 이슈별 합계와 주간 합계를 `factory status`, retro, `:digest`가 표시한다.
- **한도 관리와 토큰 교체는 사람이 한다.** factory가 한도를 근거로 스스로 멈추지 않는다.
- `ANTHROPIC_API_KEY`는 여전히 동작하지만 **권고가 아니다**(§4.4의 "스크립트는 인증 방식을 참조하지 않는다"는 규칙은 그대로 유지되므로 전환은 시크릿 교체만으로 가능하다).
- 파생: CHARTER의 이슈당 토큰 예산은 **옵션이고 기본은 꺼둔다**(§5.3). 켰을 때의 효과도 "새 claim 거부"까지이며 진행 중인 스테이지를 죽이지 않는다.
- 후속 조치: **모든 factory 워크플로가 `usage`·`total_cost_usd`를 표준 아티팩트 경로에 항상 남긴다.** 이번에 12개 run 중 3개만 stdout에 남겨 사후 합산이 부분 합에 그쳤다 — 보고가 정책인 이상 그 원천 데이터의 수집은 선택이 아니다.

**영향**: §4.4(구독이 기본 · 보고 정책), §5.3(hard limits — 토큰 예산 기본 off), §9(run 기록에 usage/비용), §12.1-5.

---

## ADR-006 메인 세션만 도구 제한 — 2026-09-11

**질문**: 커맨드 frontmatter `allowed-tools: Workflow(name)`(또는 CLI 플래그)가 **메인 세션만** 제한하고 workflow 안 서브에이전트에는 영향이 없는가. 그러면 스테이지 건너뛰기가 "감지"가 아니라 **"불가능"**이 된다(§4.2.2, §12.1-6).

**관측** (spike-6b-allowed-tools-trusted, run [34576277839](https://github.com/LeeHyeonKyu/know-thy-build-demo/actions/runs/34576277839), **trusted** 워크스페이스, 3레그 전부 success):

| mode | elapsed | main_bash(자기보고) | main Bash in `permission_denials` | `MAIN_SESSION_BASH_RAN` 훅 라인 | worker files | `SPIKE_WORKER_BASH` 훅 라인 | `Ignoring` 경고 |
|---|---|---|---|---|---|---|---|
| frontmatter `allowed-tools: Workflow(spike-hooks)` | 9s | ran | 0 | 1 | 2/2 | 0 | 없음 |
| cli `--allowedTools Workflow(spike-hooks)` | 11s | ran | 0 | 1 | 2/2 | 2 | 없음 |
| cli `--disallowedTools Bash` | 20s | **denied** | 0 | **0** | 2/2 (단 `done:false` 2/2) | **0** | 없음 |

- **`permission_denials`는 세 레그 모두 빈 배열 `[]`** — 이 CLI 버전에서 단 한 번도 채워지지 않았다. 사후 판정 근거로 쓸 수 없다.
- frontmatter `allowed-tools`: 메인 세션 Bash를 **전혀 막지 못했다**(grant 힌트일 뿐 restrict가 아님).
- `--allowedTools`: `dontAsk` 아래에서 화이트리스트가 게이트로 작동하지 않았다(메인·워커 모두 자유).
- `--disallowedTools Bash`: 메인 세션 Bash는 확실히 막혔지만(훅 라인조차 안 찍힘 = 발화 전 거부) **서브에이전트 Bash도 함께 막혔다**(`SPIKE_WORKER_BASH` 0줄, 워커 `done:false` 2/2). `.spike/worker-*.txt` 2개가 존재하는 것은 1단계 `Write`가 영향을 안 받았기 때문이지 "워커가 자유롭다"는 증거가 아니다.
- 선행 측정(untrusted, run 34574564725 / 34574709197)은 **무효**다 — allow가 무시되고 deny가 과잉 차단되는 조건이었다(ADR-008). 위 표가 대체값이다.

**결정**: 메인 세션만 선택적으로 잠그는 수단은 **없다**. 따라서 §12.1-6의 답은 **"건너뛰기는 감지(detect)이지 불가능(impossible)이 아니다"**이고, 그 감지 메커니즘은 **`verify-stage.sh`의 사후 검증**이다 — 워크플로 산출물의 존재, 로스터·라운드·판정 수 일치, 훅 로그의 `agent_id` 유무로 메인 세션 호출과 서브에이전트 호출을 구분(ADR-001). §4.2.2의 조건절("…되면 불가능이 된다 — spike 6")은 **삭제하고 단정문으로 바꾼다**. 또한 `permission_denials`를 건너뛰기 판정의 1순위 근거로 쓰려던 안은 폐기한다(항상 비어 있음 — 단, ADR-008의 untrusted/deny 조건에서는 채워지므로 run 기록용으로는 계속 싣는다).

**영향**: §4.2.2(마지막 문단 단정문화), §4.2.1 step 6, §12.1-6, Plan 1(`verify-stage.sh`가 유일한 방어선).

---

## ADR-007 idle ceiling — 2026-09-11

**질문**: `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`의 "idle"이 무활동 시간인지 총 대기인지, 0으로 두면 어떻게 되는지. 걸리면 메인 세션이 workflow 결과 없이 끝나 L1이 `blocked`로 잡아야 한다(§12.1-7).

**관측** (spike-7b-idle-markers, run [34576298708](https://github.com/LeeHyeonKyu/know-thy-build-demo/actions/runs/34576298708), trusted, 2레그 모두 exit 0):

| leg | elapsed | exit | mark-0 | mark-1 | mark-2 | result에 DONE |
|---|---|---|---|---|---|---|
| default | 36s | 0 | `1789113064` (존재) | absent | absent | 아니오 |
| `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` | 55s | 0 | `1789113069` (존재) | absent | absent | 아니오 |

두 레그 모두 `date +%s > .spike/mark-0`까지는 실행했지만 두 번째 명령 `sleep 570 && date +%s > .spike/mark-1`에서 **Bash 툴 자체가 호출을 거부**했다(동일 문구):

> `Blocked: standalone sleep 570 ... Do not chain shorter sleeps to work around this block.`

에이전트는 단독 `sleep 570`도 시도해 동일하게 차단됐고, **DONE을 위조하지 않고 정직하게 미완료를 보고**했다(선행 spike-7 run [34574812726](https://github.com/LeeHyeonKyu/know-thy-build-demo/actions/runs/34574812726)에서는 sleeper가 `sleep 720`을 백그라운드화하고 완료를 거짓 보고 — 그 run은 무효). `default`와 `0`의 **차이는 전혀 관측되지 않았다**(동일 실패 지점·동일 거부 메시지). 즉 이 방법론으로는 ceiling 값을 측정할 수 없다.

**결정**: **질문 자체가 moot다.** 근거 세 가지의 결합 — 1·2의 성격에 주의: **이 스파이크가 잰 값이 아니라 CLI 자체의 동작이며, 컨트롤러 판단(ruling)으로 채택했다.** 스파이크 7b가 실측한 것은 2의 차단이 실제로 발생한다는 사실(거부 메시지 verbatim)뿐이고, 10분이라는 수치는 측정되지 않았다.
1. **단일 Bash 툴 호출은 10분 상한**이 걸려 있다(CLI 동작 · 컨트롤러 ruling) — 하나의 도구 호출이 ceiling을 넘겨 침묵할 수 없다.
2. **foreground `sleep`(및 우회로서의 chained 짧은 sleep)은 Bash 툴이 하드 차단**한다 — 이것만 위에서 실측했다. 에이전트가 인위적으로 오래 침묵하는 경로 자체가 봉쇄돼 있다.
3. 실제 작업을 하는 workflow 에이전트는 도구 이벤트를 연속적으로 뱉는다. 따라서 **workflow 에이전트가 기본 ceiling보다 오래 무활동일 수 없다 — 구성상(by construction)**.

운영 규칙: `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`은 **방어적으로 계속 설정**하고(비용 0, 위 추론이 틀렸을 때의 보험), **진짜 상한은 잡의 `timeout-minutes`**로 건다. 두 장치 모두 원안 그대로 유지된다. 파생 규칙: 앞으로 "에이전트가 실제로 N분을 기다렸는가"를 검증해야 하면 **에이전트에게 `sleep`을 시키지 않고 오케스트레이션 레이어(yml 스텝의 sleep/polling)에서 대기를 만들고 에이전트는 마커로 사후 검증만** 한다.

**영향**: §4.2.1 step 4의 env 주석(유지 사유 명시), §4.1 `timeout-minutes`(실질 상한), §12.1-7(MOOT로 종결).

---

## ADR-008 신뢰되지 않은 워크스페이스의 allow/deny — 2026-09-11

**질문**(계획에 없던 스파이크 — ADR-002/ADR-001의 "Ignoring 7 permissions.allow entries" 경고에서 파생): CI의 fresh checkout은 **untrusted 워크스페이스**다. 그 상태에서 §6.3의 L2(`permissions.deny`)가 실제로 강제되는가.

**관측** (spike-8-trust-deny, run [34574810230](https://github.com/LeeHyeonKyu/know-thy-build-demo/actions/runs/34574810230), 3레그):

| 모드 | echo(deny 비매칭) | force_push(deny 매칭) | `Ignoring …allow` 경고 | `permission_denials` | num_turns |
|---|---|---|---|---|---|
| project-only (`.claude/settings.json`만) | **denied** | denied | 출력됨 | Bash 2건 기록 | 3 |
| cli-settings (`--settings .factory-ci-settings.json` 추가) | **denied** | denied | 출력됨 | Bash 2건 기록 | 3 |
| **trusted** (`~/.claude.json` → `projects[cwd].hasTrustDialogAccepted: true`) | **ran** | denied | **0건(사라짐)** | force_push 1건만 | 5 |

- `git ls-remote --heads origin deny-probe-should-never-exist`가 3레그 모두 빈 출력 — **원격 브랜치 미생성 = deny가 force-push를 3/3 실제로 막았다.**
- `--settings`는 project `.claude/settings.json`을 **대체하지 않고 병합**한다(cli-settings 레그에서도 `Ignoring` 경고가 그대로 출력됨).
- untrusted + deny 조건에서 **deny에 걸리지 않는 평범한 `echo`까지 전면 차단**되는 현상이 `/spike-deny` 커맨드에서 관측됐다. 단 같은 untrusted 상태의 다른 커맨드(ADR-006 선행 run 34574564725/34574709197)에서는 반대로 통과했다 — **원인 미상의 상충**이며 일반 규칙으로 단정하지 않는다. trusted 모드에서는 이 모호성이 아예 사라진다.

**결정**: **모든 factory CI 워크플로는 `claude -p` 전에 trust 부트스트랩을 거친다.** `~/.claude.json`의 `projects[$GITHUB_WORKSPACE].hasTrustDialogAccepted = true`를 쓰는 스텝을 공통 setup에 넣는다(데모의 `.github/actions/trust-workspace/action.yml`이 구현 예 — node 한 줄로 기존 JSON을 읽어 머지 후 재기록). 근거: trusted는 이번 관측에서 유일하게 **"allow 정상 작동 + deny만 선택적으로 적용"**이 상충 없이 확인된 모드다(1/3 레그). 범위를 정확히 해둔다 — **deny 자체는 trust와 무관하게 3/3 유효했으므로 L2가 성립하기 위해 trust가 필요한 것은 아니다.** trust가 사는 것은 (a) allow 규칙의 작동, (b) `.mcp.json` project 서버 로딩(ADR-004), (c) 비대상 명령까지 막히는 과잉 차단의 제거다. `--settings .factory/ci-settings.json`은 병합이므로 필수가 아니며, 워크플로별 deny 확장이 필요할 때의 보조 수단으로만 남긴다.

이 결정은 ADR-004(trusted면 `.mcp.json`이 `enableAllProjectMcpServers` 없이 로드)와 ADR-006(trusted 재측정)의 전제이기도 하다 — **trust 부트스트랩은 다른 모든 CI 관측의 선행 조건**이다.

**영향**: §4.2.1(step 0.5 신설), §6.3(L2가 유효하기 위한 전제), §4.5(MCP), §12.1-8(신규 항목), Plan 2(`ci-settings.json`·yml 공통 setup).

---

## ADR-009 러너/yml 관례 — 2026-09-11

**출처**: 스파이크가 아니라 **Plan 0 실행 중 실제로 잡을 깨뜨린** 두 건. Plan 2의 yml 템플릿이 그대로 답습할 위험이 있어 ADR로 남긴다.

**관측**:
1. **flow mapping 안의 `${{ }}`는 워크플로 파일을 통째로 무효화한다.** `with: { name: x-${{ matrix.y }}, path: .spike/ }` 형태에서 `}}`가 flow mapping을 조기 종료시켜 파싱이 깨진다. 증상: 잡이 실행조차 안 되고 run 목록에 워크플로 이름 대신 **경로 문자열**(`.github/workflows/spike-8-trust-deny.yml`)이 뜨며 즉시 failure — 실제로 3개 run(34574545130, 34574544207, 34574407539)이 이 사유로 죽었고 커밋 `fd90f80`으로 고쳤다.
2. **`actions/upload-artifact@v4`는 dot-디렉토리를 기본적으로 빼먹는다.** D1 스파이크의 `path: .spike/` 아티팩트가 **전부 비어 있었고**(데이터는 잡 로그에서 회수), `include-hidden-files: true`를 붙인 이후 run부터 정상 수집됐다.
3. **로깅 훅이 죽으면 관측이 통째로 사라진다.** 스파이크의 `log-hook.sh`가 `set -e` + `jq` 치환으로 짜여 있어, `jq` 실패나 경로 문제가 나면 훅이 비정상 종료하고 그 시점부터 기록이 조용히 끊긴다(D1의 deferred minor로 기록됨). `PreToolUse`에서 **exit 2만** 도구 호출을 차단하므로 다른 실패는 잡을 막지는 않지만, 사후 검증(ADR-001·ADR-006)의 유일한 근거가 없어진다.

**결정** (factory yml·훅 템플릿 규칙):
- yml에서 `${{ }}`를 쓰는 `with:`/`env:`는 **항상 블록 매핑**으로 쓴다. flow mapping(`{ … }`)은 보간이 전혀 없는 짧은 값에만 허용한다.
- 아티팩트 경로에 dot-디렉토리(`.factory/out/`, `.spike/` 등)가 하나라도 있으면 **`include-hidden-files: true`를 필수로 붙인다.** factory 산출물은 대부분 `.factory/` 아래이므로 사실상 전 워크플로에 해당한다.
- **로깅 훅은 어떤 경우에도 exit 0으로 끝난다** — 실패할 수 있는 모든 구문에 `|| true`를 붙이고 마지막 줄에 `exit 0`을 둔다. 판정하는 훅(`stop-guard.sh` 등)만 의도적으로 exit 2를 낸다. 관측용 훅이 잡을 막거나 스스로 침묵해서는 안 된다.
- 세 규칙 모두 `doctor`의 린트 후보다(Plan 2에서 판단).

**영향**: §4.1(워크플로 파일 예시), §6.3(훅 작성 규칙), Plan 2(yml 템플릿 전부), Plan 3(훅 구현).

---

## 후퇴 결정 (해당 시)

**후퇴는 없었다.** `harness.toml [factory] orchestration`의 기본값은 **`workflow`로 유지**한다(ADR-002).

- 근거: 저장된 Workflow가 Actions 무인 실행(`-p` + `dontAsk`)에서 1턴·12초·$0.089로 완결됐고, 서브에이전트 2명이 실제로 병렬로 떴으며 CLAUDE.md까지 주입됐다(ADR-002). 훅도 그 안에서 발화한다(ADR-001). 스키마 강제도 0/20 null로 안정적이다(ADR-003). `agent` 모드로 물러설 이유가 관측되지 않았다.
- 따라서 §4.2.4가 예고한 "후퇴 시 잃는 것 = 구조적 보장(`structural`) → 사후 감지(`verified`)"는 **이번에 발생하지 않았다.** handoff·run 기록의 `guarantee` 값은 `structural`로 나간다.
- 다만 **건너뛰기 방지의 성격은 후퇴했다**(ADR-006): 메인 세션을 구조적으로 잠그는 수단이 없으므로, "workflow를 호출하지 않고 스테이지를 위조"하는 시도는 **금지가 아니라 탐지**로 막힌다. 유일한 방어선은 `verify-stage.sh`의 사후 검증(+ADR-001의 훅 기록)이며, 이는 §4.2.2가 원래 요구하던 것과 동일하다 — 설계는 바뀌지 않고 "보너스로 기대했던 불가능성"만 사라졌다.
- 런타임에 Workflow 호출이 실패하면 §4.2.4의 규칙대로 `blocked` + `orchestration-unavailable`로 끝난다. **자동 모드 전환은 여전히 없다.**
