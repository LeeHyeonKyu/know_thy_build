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
- **wont-do — 라벨 그래프가 아니라 close+decision**. `factory/lib/labels.js`의 전이 그래프에는 `needs-human → wont-do`도 `factory:wont-do`도 없다(그래프는 파이프라인 진행/재시도만 표현한다). 그래서 `:unstick`이 사람의 wont-do 판단을 집행하는 방법은 라벨 전이가 아니라: 이슈에 `human-decision:v1` 코멘트(`decision: wont-do`, 사유)를 남기고 `gh issue close <n> --reason "not planned"`로 닫는다(`unstick.md`). 스펙 §13.3 `:unstick` Does 3단계의 `transition.sh --human`은 실재하지 않는 이름이었다 — 실제 스크립트는 `transition.js`이므로 이번 Task 6에서 정정하고, `wont-do 판단` 선택지에 "라벨 전이가 아니라 close + human-decision"이라는 실행 방식을 명시했다.
- **핸드오프 무효화 마커는 사람/회고를 위한 provenance일 뿐 — 소비하는 코드가 없다**. `:unstick`이 이슈를 분할한 뒤 남기는 `<!-- factory-handoff-invalidated stage=plan … -->`는 어떤 스크립트도 파싱하지 않는다. 재큐된 이슈는 triage부터 다시 돌고(스펙상 `queue`는 triage → plan 순서를 다시 밟는다), `handoff.js`의 `latestHandoff`는 단순히 타임스탬프가 가장 최신인 핸드오프를 고른다 — 무효화 마커가 있든 없든 최신이 이긴다. 그래서 이 마커의 유일한 소비자는 사람과 retro다(왜 이 핸드오프가 폐기됐는지의 기록).
- **"`factory:harness` PR"의 실체**. `:harness` Trigger (c)가 말하는 그 PR은 `factory:harness` **라벨이 붙은 이슈**의 파이프라인 PR이다 — 라벨은 PR에는 결코 붙지 않는다(이슈 라벨 그래프의 라벨이다). 찾는 절차: open `factory:harness` 이슈를 나열 → 각 이슈 번호로 `gh pr list --head claude/fq-<n>`(implement가 그 브랜치 이름으로 push한다) → 실패하면 `gh issue view <n> --json closedByPullRequestsReferences`로 대체.
- **`:role` Step 4는 역할 종류로 CHARTER 필드가 갈린다**. 리뷰어(이름이 `reviewer-`)는 CHARTER의 `roster:`에, plan 토론자(이름이 `plan-`)는 `plan_roles`에 등록된다 — `factory/lib/config.js`의 `rosterFor(charter, stage)`가 그 필드를 고른다. 등록될 필드가 없는 역할(예: 오타로 두 접두어 다 아닌 이름)은 `lintAgentMd`를 통과해도 `roles.toml`의 어떤 `[plan.*]`/`[review.*]`에도 없으므로 **결코 spawn되지 않는다** — lint가 깨끗해도 배선이 빠지면 죽은 코드다. §7.2의 쓰기 금지 목록은 `needsDenyAllWritesHook`(`factory/lib/agent-md.js`)이 실제로 검사하는 이름 집합보다 좁았다 — 코드는 이미 `factory-retro`를 포함하고 있었는데(P4-R4, retro는 근거만 내고 쓰지 않는다) §7.2의 문장이 나열에서 빠뜨렸다. 이번 Task 6에서 §7.2 문장에 `factory-retro`를 추가해 코드와 스펙을 맞췄다.
- **금지 문자열 규칙이 §13.3 원문 인용보다 우선한다**. `factory/test/skills-phase1.test.js`의 FORBIDDEN 검사(`worktree`·`check-merge-gate`·`finish`·`sub-agent`)는 대소문자 무시 전체 파일 스캔이다 — §13.3 문언을 그대로 인용하면 그 문언 자체가 금지어를 담을 수 있다(예: 삭제된 "Worktree Workflow" 섹션 이름을 한국어로 번역해 인용하면 원문은 "워크트리"라 영문 스캔을 피하지만, 영문 스킬 본문에서 그 섹션을 설명할 때는 "worktree"라는 단어를 쓰지 않고 다른 말로 풀어써야 한다). Task 2가 `project.md`를 개정할 때 이 규칙을 실제로 적용했다: 삭제된 "Worktree Workflow" 섹션을 가리켜야 하는 자리에서 그 단어를 쓰지 않고 풀어썼다. `architect`/`designer`에 추가한 새 6섹션 블록(이번 Task 6)도 같은 이유로 §13.3 문언을 그대로 옮기지 않고 새로 썼다 — 이 둘의 본문은 옛 worktree+sub-agent 흐름을 그대로 유지하므로(Task 6 지시: 본문은 손대지 않는다) 새 블록까지 그 단어를 쓰면 스캔이 걸릴 자리가 생긴다.
- **이월(carry-over) — Plan 4의 자체 머지 실패 lessons PR**. retro가 스스로 머지하지 못한 lessons PR(integrity RED, 폴링 timeout, `gh.mergePr` 예외)은 `factory:needs-human` 라벨을 달고 열린 채로 남는다(ADR-017 P4-R2). `:proposal`은 이런 PR도 다룬다 — 막힌 원인이 리베이스로 해결 가능하면(오래된 base) 리베이스 후 integrity 재실행을 권하고, 아니면 PR을 닫고 다음 정기 full retro가 같은 후보를 다시 모아 새 PR을 열게 한다(Plan 4에는 "재오픈 dedup"이 없다 — 닫힌 PR은 다시 열리지 않고, 후보가 남아있으면 다음 회차가 새로 연다).
- **§13.3 `## Produces`는 §10보다 좁은 요약이다 — 스킬은 §10을 따른다**. `:qa`의 §13.3 Produces는 `docs/QA.md`만 적지만 §10은 `harness.toml [test] [test.env] [test.fakes]`·`docker-compose.test.yml`·`.env.test`·스모크 테스트까지 요구한다(`qa.md`는 §10을 따라 이 전부를 만든다). `:technical`의 §13.3 Produces는 CHARTER 초안까지만 적지만, §10과 `technical.md`는 CHARTER의 `load_bearing`·`NEVER_AUTOMATE`·`tier_default`가 TDR에서 **도출**되는 경로까지 구현한다(코드가 직접 쓰는 파일은 여전히 TECHNICAL.md와 CHARTER.md 초안뿐이다). §13.3은 "사람 지점" 관점의 압축 요약이고 §10은 "무엇이 바뀌는가"의 상세 목록이라, 둘이 갈리면 후자를 구현이 따른다.

**결정**: 위 관측대로 P5-R1~R7과 세 가지 이번 Task 6 실행 판결(wont-do는 close+`human-decision`, §13.3 대 §10 우선순위는 §10, 금지 문자열 규칙이 원문 인용보다 우선)을 Plan 5의 확정 동작으로 채택한다. 13개 카탈로그 스킬 + `architect`/`designer`(비-카탈로그) 전부가 §13.3의 6섹션 구조를 갖추고, `doctor`가 그 전부를 이름과 무관하게 lint한다는 전제가 구현 전체에서 유지됐다.

**알려진 한계**: 스킬 본문은 LLM이 따르는 프로즈다 — `lintSkillMd`가 기계로 검사하는 것은 구조(frontmatter·섹션 존재·순서)와 몇 개의 고정 문자열(`transition.js`·`human-decision:v1`·`gh pr merge` 금지 문장)뿐이고, 그 문장이 실제로 서술하는 흐름이 옳은지·사람이 스킬을 그대로 따를지는 검사하지 않는다. `checkSkills`는 설치 디렉터리에 있는 낯선 `.md`(카탈로그도 helper도 아닌 파일)를 전부 FAIL로 보고한다 — 관용도가 없으므로 설치 디렉터리에 다른 스킬을 손으로 얹으면 doctor가 항상 빨갛다.

**영향**: §2.1(스킬 개수 12→13, Define 4→5), §7.2(쓰기 금지 목록에 `factory-retro` 추가), §10(표 아래에 `architect`/`designer`가 비-카탈로그로 계속 설치되고 §13.3 블록을 갖춘다는 문장), §13.3(`:unstick` Does 3단계 `transition.sh`→`transition.js`, `wont-do 판단`에 집행 방식 명시, `:digest` Must not의 `:feature --bug`→`:issue`), §13.4(`doctor`의 `skills.<name>`/`skills.missing` 보고 형식, 설치기가 `templates/know-thy-build/`만 복사하고 레거시 `finish.md`를 지운다는 문장), README(Define/Operate 표 갱신, helper 15개 설치 문장, 파이프라인 블록의 `factory` 단계·`sub-agents`→`agents`).
