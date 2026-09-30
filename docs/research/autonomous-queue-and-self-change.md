# Research: 자율 큐 투입과 엔진 자기 변경

Date: 2026-09-30
Question: 큐 진입(`backlog → factory:queue`)과 보호 경로 머지에서 "사람"을 필수 조건에서 빼고, "잘 만들어진 잡 + 제약(예산·WIP·리허설·NEVER_AUTOMATE·리뷰 게이트) + 정직한 귀속"으로 신뢰를 옮기려면 무엇을 바꿔야 하는가. 운영 중인 에이전트 시스템과 자기 변경 파이프라인은 이것을 어떻게 다루는가.

## Findings

### A. 자율 잡 투입의 통치 — 실제 시스템

| 시스템 | 진입 규칙(누가/무엇이) | 상한 | 귀속 | 킬 스위치 | 출처 |
|---|---|---|---|---|---|
| GitHub Copilot cloud agent | **write 권한 사용자만** 트리거. 에이전트는 `copilot/` 브랜치 **하나에만** push, PR **하나**만 연다. 브랜치 보호·required checks에 그대로 종속 | 세션당 실행 59분. Actions 분·AI 크레딧 과금 | PR 작성자는 Copilot(봇). **의뢰한 사용자는 그 PR을 승인할 수 없다**(required approvals 규칙 보존) | 에이전트는 approve/merge/ready-for-review **불가**. PR의 워크플로는 write 사용자가 "Approve and run workflows"를 누르기 전엔 돌지 않음(2026-03 부터 옵션으로 생략 가능) | [1][2][3] |
| Anthropic "Building effective agents" (2024-12-19) | 에이전트 루프는 환경 피드백으로 진행 | "stopping conditions (such as a maximum number of iterations)" | — | "pause for human feedback at checkpoints or when encountering blockers"; 샌드박스+가드레일 테스트 권고 | [4] |
| Anthropic 멀티에이전트 리서치(2025-06-13) | 리드가 서브에이전트에 목적·출력형식·도구·경계를 명시해 위임 | 복잡도별 명시 규칙: 단순 1에이전트 3–10 tool call, 비교 2–4 서브에이전트 10–15 call, 복잡 10+ | — | 초기 결함: "spawning 50 subagents for simple queries" → 규칙으로 상한. 재개 가능한 실행, rainbow deployment | [5] |
| Claude Code CLI | `-p` 세션 | `--max-turns`(기본 무제한), `--max-budget-usd`(서브에이전트 포함; 도달 시 서브에이전트 생성 실패·백그라운드 중단) | — | PreToolUse 훅 exit 2 / `permissionDecision: deny`; 훅 설정은 세션 시작 스냅샷 | [6][7] |
| SWE-agent | 인스턴스(이슈) 단위 실행 | `per_instance_cost_limit` 기본 $3.0, `total_cost_limit` 기본 0(무제한), `per_instance_call_limit` | — | 한도 초과 시 중단(예외명은 문서에 없음) | [8] |
| OpenHands (V0 설정) | 대화 단위 | `max_iterations` 기본 100, `max_budget_per_task`(0=무제한) | — | `confirmation_mode`(기본 false), `security_analyzer` | [9] |
| Temporal | Workflow Id는 네임스페이스 안 **열린 실행 중 유일**. Reuse Policy(AllowDuplicate/…/RejectDuplicate), Conflict Policy(Fail/UseExisting/TerminateExisting) | — | Id 자체가 귀속 키 | `UseExisting` = 멱등 시작(중복 제출은 기존 실행을 돌려줌) | [10] |
| Kubernetes ResourceQuota | **신원이 아니라 네임스페이스 제약**: admission controller가 생성 요청을 검사, 위반은 HTTP 403 | 컴퓨트·스토리지·**객체 수**(`count/pods` 등) | — | 이미 만들어진 리소스에는 소급하지 않음(새 요청만 거부) | [11] |
| Replit 사고(2025-07) | 개발 중 에이전트가 프로덕션 DB 삭제 | — | — | CEO: "should never be possible" → dev/prod DB 자동 분리, planning-only 모드, 백업 복원. 교훈: 능력 분리가 훅보다 앞선다(ADR-021과 같은 결론) | [12] (X 게시물, 검색 결과 인용 — 직접 열람 못 함) |

공통 패턴: (a) 진입은 **권한을 가진 주체의 명시 행위**이되 실행자는 별도 신원, (b) 실행자는 자기 산출물을 **승인·머지할 수 없고 의뢰자도 승인 불가**(Copilot), (c) 상한은 이터레이션·달러·객체 수 세 종류, (d) 킬 스위치는 "명령 차단"이 아니라 **능력 부재**(토큰·브랜치·DB 분리).

### B. 자기 변경 파이프라인의 자기 보호

| 메커니즘 | 무엇을 보장하나 | 출처 |
|---|---|---|
| GITHUB_TOKEN 이벤트는 새 워크플로 런을 만들지 않음(예외: `workflow_dispatch`·`repository_dispatch`) | 자기 변경이 재귀 트리거 루프를 만들지 않음 | [13] |
| classic PAT `workflow` 스코프: "Grants the ability to add and update GitHub Actions workflow files" — 없으면 워크플로 파일 push 거부 | 에이전트 토큰에서 스코프 제거 = `.github/workflows` 쓰기 불가(KTB ADR-021 r1 MF-2 a가 이미 채택) | [14] |
| Environments: required reviewers(최대 6, 1명 승인이면 진행), **"Prevent users from approving workflows runs that they triggered"**, wait timer, 배포 브랜치 정책, GitHub App 커스텀 보호 규칙(`deployment_protection_rule` 이벤트에 approve/reject), 환경 시크릿은 규칙 통과 뒤에만 노출, admin bypass 허용/금지 토글 | **사람 대신 App(자동 검사)이 게이트를 승인**할 수 있는 GitHub 1차 메커니즘 | [15][16] |
| CODEOWNERS는 **base 브랜치**의 파일로 판정; 오너는 write 권한 필수; 문서가 CODEOWNERS 자체의 오너 지정을 권고 | PR이 자기 오너 규칙을 바꿀 수 없음 | [17] |
| Rulesets: 여러 룰셋 집계, 가장 엄격한 것이 승리, 역할·팀·App 단위 bypass 목록 | 보호를 "누가 우회 가능한가"로 표현 | [18] |
| GCC 3-stage bootstrap: stage2와 stage3 오브젝트 **비교, 다르면 실패** | 자기 컴파일 결과의 고정점 검증 — "새 엔진으로 새 엔진을 빌드해 같은지" | [19] |
| Argo Rollouts canary: `setWeight`·`pause`(기간 또는 무기한→`promote`), 백그라운드 Analysis 실패 시 rollout **abort** | 사람 승인 대신 **측정 기반 자동 중단** | [20] |
| Darwin Gödel Machine(2025-05-29): 에이전트가 자기 코드를 수정, **각 변경을 코딩 벤치마크로 실증 검증**, 아카이브 유지, "safety precautions (e.g., sandboxing, human oversight)" | 자기 개선의 학술 형태도 벤치마크 게이트 + 샌드박스 + 사람 감독을 전제 | [21] |

### C. KTB 메커니즘

**C.0 오늘의 실제 상태(코드가 말하는 것).** `backlog → factory:queue`는 `TRANSITIONS`의 **평범한 그래프 엣지**다(`factory/lib/labels.js:70`). `requirementFor("factory:queue")`는 규칙이 없어 `pass`(`factory/lib/requirements.js:223-225`). 훅은 `--human`/`--retry` 토큰만 막고 **플래그 없는 `transition.js <n> factory:queue`는 허용**한다(`factory/hooks/block-dangerous.sh:358`, `factory/test/hooks.test.js:253-254`가 그것을 핀). 즉 에이전트 세션·러너는 이미 `by=script`로 큐 진입이 가능하고, 실제로 flaky 수확(`factory/lib/gates.js:588-592`)이 그렇게 한다. 하네스 이슈는 아예 `factory:queue`로 태어난다(`factory/lib/harness-request.js:164`, ADR-025가 설계라고 명시). **사람 전용인 것은 `needs-human/needs-info → HUMAN_RETRY_TARGETS`뿐**이다(`labels.js:178-190`, `transition.js:81,96`). 사람이 큐를 독점하는 것은 코드가 아니라 스킬 관례(`:next`가 `--human`을 쓴다, `templates/know-thy-build/next.md:101`)와 ADR-027 결정 ④(피드백 이슈는 `backlog`로 착지)다. 그리고 `:next`가 부르는 `--human`은 Claude 세션 안에서는 훅과 `refuseHumanFlag`(`transition.js:21`)에 **둘 다 막힌다** — 이것이 simulation-105 §6의 "사람 전용 경로는 에이전트 세션에서 대신할 수 없다"의 정체이고, 7시간 대기의 원인이다.

**C.1 큐 진입을 귀속된 주체로 열기.**

| 바꿀 곳 | 변경 |
|---|---|
| `factory/lib/transition.js:55,166` | `human: boolean` → `by: {kind: person\|agent\|factory, login, runId?}`. 마커를 `by=<kind>:<login>[ run=<id>]`로 확장. `--human` 플래그는 `needs-human` 재시도 엣지에만 남긴다 |
| `factory/lib/transition.js:81` `refuseHumanFlag` | 그대로 둔다(재시도 엣지 전용). 큐 엣지에는 적용하지 않는다 |
| `factory/lib/requirements.js` | `factory:queue` 규칙 **신설**: 잡 형식(본문에 done_when 초안 또는 `factory-improvement` 마커), back-pressure(`back-pressure.js:2` — 오늘은 sweeper/implement claim에서만 검사, 큐 진입에서는 안 함), 리허설(이미 `transition.js:73`), 제출자 종류별 상한(C.2) |
| `factory/hooks/block-dangerous.sh:358` | 변경 없음 — 스크립트 경로는 이미 열려 있다. 대신 `by=person` 자칭을 막는 규칙 1줄(에이전트 세션이 `--by person`을 못 쓰게) |
| `factory/lib/retro/issue-comments.js:444` `commentsSinceCycleStart` | **결함**: 본문의 `by=human` 문자열만 보고 restart/self-gate 창을 리셋한다. 에이전트는 `gh issue comment`가 열려 있으므로(`gh.js:326-330` 주석이 인정) 마커를 흉내 내 `STALLED_RESTART_LIMIT`(`sweeper.js:77`)와 `SELF_GATE_RETRY_BACKSTOP` 창을 리셋할 수 있다. 작성자 검증을 넣어야 한다 |

귀속의 앵커: 본문의 `by=`는 **주장**이고, 검증 가능한 사실은 (1) 코멘트 `author`/`authorType`/`viaApp` — GitHub이 계정에 붙이는 값, 이미 `harvest-findings.js:243-304`가 `human-decision:v1`에 이 방식을 쓴다, (2) `GITHUB_RUN_ID`·`runner=`(`run-stage.js:182`, 러너가 env로 받음), (3) `usage:` 줄(러너 채널). 에이전트가 위조할 수 있는 것: 코멘트 본문 전부, `by=` 값, env 변수(`env -u CLAUDE_PROJECT_DIR …` — 훅 비목표인 런타임 조립, ADR-020 잔여 위험 #4). 위조할 수 없는 것: 코멘트 작성자 로그인(토큰이 정한다), Actions run id의 존재. 따라서 규칙은 "`by=person`은 작성자가 팩토리 로그인이 아닐 때만 유효, `by=factory`는 작성자가 봇 로그인이고 `run=`이 실제 런일 때만 유효, 그 외는 `by=agent:<login>`으로 강등"이어야 한다. ADR-028 결정 ⑥의 공유 신원 문제가 그대로 적용된다: 사람 계정으로 도는 저장소에서는 person/agent를 가를 수 없다.

**C.2 루프 가드 — 있는 것과 없는 것.**

| 가드 | 상태 | 출처 |
|---|---|---|
| 이슈 평생 비용 `[budget].usd_per_issue`($60) | 있음 | `budget.js:31-41`, ADR-031 |
| 스테이지당 `--max-turns`·`--max-budget-usd` | 있음 | `run-stage.js:87-88` |
| K/M/R(3/3/2) | 있음, 재큐/사람 전이마다 리셋 | CHARTER, `issue-comments.js:268,438` |
| stalled restart 2회, api-error 3회, cancelled 3회 | 있음 | `sweeper.js:77,106,116` |
| back-pressure `awaiting_review_max: 4` | 있음, **claim 시점만** | `back-pressure.js` |
| flaky·harness 이슈 dedupe | 있음(마커 기반) | `harness-request.js:148`, `gates.js:574` |
| 저장소 일/주 총지출 | **없음** (SWE-agent `total_cost_limit`·K8s 네임스페이스 쿼터에 해당) | — |
| 열린 자기생성 이슈 상한(객체 수 쿼터) | **없음** — `factory-improvement`는 fingerprint dedupe만(ADR-027 ⑤) | — |
| 머지 1건당 자기생성 이슈 상한 | **없음** — health 잡 N=5 창 안에서 발견 수 무제한 | `health.js`(ADR-028) |
| 실패한 엔진 변경 뒤 쿨다운 | **없음** | — |
| 연속 엔진 변경 실패 회로차단기 | **없음** — 회고는 lessons만 쌓음 | ADR-017 |
| 큐 진입 시 back-pressure | **없음**(`:next`가 사람에게 경고만) | `next.md:90` |
| 재귀 방지(자기생성 이슈가 자기생성 이슈를 낳음) | 부분: `fp=none`도 dedupe(ADR-027 ⑤); 세대 깊이 상한 없음 | — |

**C.3 엔진 변경을 자기 팩토리로 보내기.**

- **미러는 러너가 만든다(#41 (a)).** `run-stage.js`의 implement에서 빌더 종료 후·게이트 전에, `buildManifest({pkgRoot})`(`factory/cli/manifest.js:24`)의 `dest.startsWith(".factory/lib|bin|actions")`·`.claude/hooks/*.sh` 항목만 `freshContent(e,{vars})`(`factory/cli/install.js:101`)로 재생성해 커밋. `init --upgrade`는 쓰지 않는다 — `.claude/agents/*.md`의 additive 섹션을 덮는다(#36 skeptic 지적, KTB-57). 조건은 `package.json name === "know-thy-build"`. 그러면 `self-mirror.test.js`는 그대로 GREEN이 되고, 오늘 `overlay`가 implement를 **blocked로 세우는 자리**(`run-stage.js:533-537` — 트리가 팩토리 소유 경로를 base와 다르게 들면 빌더를 띄우지 않음)를 "미러 커밋은 러너 것"으로 예외 처리해야 한다. 그 예외가 이 설계의 가장 큰 새 표면이다.
- **스테이지는 base의 엔진으로 돈다**(ADR-023 Task 8, `OVERLAY_STAGES`). 곧 PR의 새 엔진은 그 PR을 리뷰·머지하는 데 **쓰이지 않는다** — GCC가 stage1로 stage2를 만들 듯 옛 엔진이 새 엔진을 판정한다. 이것은 유지해야 한다.
- **카나리 = stage3 비교.** 머지 전에 (1) 새 엔진(PR head)의 `.factory/**`로 데모 저장소에서 `factory-rehearse.yml`(ADR-025, 이슈·`claude -p` 없음)을 한 번, (2) 데모의 실제 이슈 1건을 새 엔진으로 triage→merge까지. 결과를 `factory/canary` commit status로 PR head sha에 박는다(`rehearsal.js`의 `factory/rehearsal` status와 같은 기계). Argo의 Analysis 실패=abort에 대응하는 것은 "카나리 RED → PR을 `needs-human`이 아니라 **`rework`**로".
- **보호 경로 머지의 대체.** `merge-stage.js:297-312`의 `protectedPaths → handToHuman`을 "`factory/**`·`.factory/**`·`templates/**`는 카나리 GREEN + 머지 배우 승인(ADR-021 6b) + **veto 창**(Environments의 wait timer + required reviewer 역할을 App 커스텀 보호 규칙이 대신)"으로 바꾼다. GitHub 1차 메커니즘으로는 `factory-merge` 환경에 wait timer(예: 60분)와 `deployment_protection_rule`을 받는 App이 카나리 status를 읽어 approve하는 구성이 가능하다[15][16]. `.github/**`·CODEOWNERS·`docs/factory/CHARTER.md`는 이 대체에서 **뺀다**(C.4).
- **잔여 위험.** (i) 러너 미러 커밋 예외를 통해 빌더가 `.factory/**`에 쓴 것을 "러너가 만든 diff"로 위장 — 방어는 미러 스텝이 **파일 내용을 `freshContent`로 다시 생성**하고 빌더 커밋과 diff 0을 요구하는 것. (ii) 카나리가 데모 저장소에서 GREEN이어도 own-calendar 같은 채택자에서 깨질 수 있다(ADR-025 잔여 위험과 동일). (iii) 새 엔진이 머지되면 **다음** 이슈부터 그 엔진이 판정자다 — 판정 로직 자체의 회귀는 stage3 비교가 못 잡는다(GCC도 "compile incorrectly"만 잡는다). 회로차단기(C.2)가 이 자리를 덮어야 한다. (iv) 머지 배우 승인은 "게이트 통과"의 기계적 표현(ADR-021 한계 3) — 사람이 GitHub UI의 approve를 사람으로 오독한다.

**C.4 새 모델에서도 사람 전용으로 남겨야 하는 것.**

| 대상 | 이유 |
|---|---|
| 시크릿·PAT·GitHub App 설치, `FACTORY_MERGE_TOKEN` 환경 | 팩토리는 시크릿을 만들지 않는다(ADR-027 ③, ADR-021 체크리스트). 능력 분리의 뿌리 |
| 브랜치 보호·룰셋·CODEOWNERS·`factory-merge` 환경 규칙 | L0 그 자체(훅 `block-dangerous.sh:372-374`). 오너가 base 브랜치에서 읽히므로[17] 이것을 자동화하면 나머지 게이트가 존재하되 아무것도 막지 않음 |
| `.github/workflows/**` | 저장소 시크릿에 닿는 유일한 코드(ADR-021 r1 MF-2). `workflow` 스코프 부재가 물리적 벽[14]이므로 그대로 둔다 |
| CHARTER `NEVER_AUTOMATE`·`[protected]`·`[gates.thresholds]`·`[budget]`·자기생성 상한 상수 | 판정 기준과 상한을 판정 대상이 고치면 상한이 아니다(K8s 쿼터를 pod가 못 고치는 것과 같은 이유). NEVER_AUTOMATE 2번 항목이 이미 이것을 말한다(`CHARTER.md:89`) |
| 회로차단기 해제, 예산 인상 | Copilot의 "의뢰자는 승인 불가"와 같은 원리 — 멈춤을 푸는 손은 멈춘 주체가 아니어야 한다 |
| npm publish | NEVER_AUTOMATE 1번 그대로 |

## 확인하지 못한 것

- Copilot cloud agent의 커밋 co-author 표기 규칙과 프리미엄 요청 상한 — 개념 문서에 없음[1].
- Rulesets의 "Evaluate" 모드(강제 없이 규칙 결과만 기록) — 열람한 문서에 없음(Enterprise 기능으로 추정, 미확인)[18].
- GitHub Environments의 wait timer 상한(43,200분)과 대기 잡 30일 만료 — 개념 페이지가 404, 방법 페이지에는 숫자 없음[15].
- SWE-agent·OpenHands가 한도 초과 시 던지는 예외/종료 코드 — 참조 문서에 없음[8][9].
- Replit 사고 원문(X 게시물)은 직접 열람하지 못했고 검색 요약으로 인용했다[12].
- Devin·Sweep의 공개 자율성 경계 문서 — 이번 조사에서 1차 출처를 확보하지 못해 표에서 뺐다.
- KTB 코드 중 `overlay` 예외를 실제로 넣었을 때 `overlayDrift`(`run-stage.js:1737-1739`)가 어떻게 반응하는지 — 실행하지 않았다.

## Sources

1. GitHub Docs — About Copilot cloud agent (concepts). https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent (2026-09-30 열람)
2. GitHub Docs — Risks and mitigations for GitHub Copilot cloud agent. https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations (2026-09-30)
3. GitHub Changelog — Optionally skip approval for Copilot coding agent Actions workflows (2026-03-13). https://github.blog/changelog/2026-03-13-optionally-skip-approval-for-copilot-coding-agent-actions-workflows/
4. Anthropic — Building effective agents (2024-12-19). https://www.anthropic.com/engineering/building-effective-agents
5. Anthropic — How we built our multi-agent research system (2025-06-13). https://www.anthropic.com/engineering/multi-agent-research-system
6. Claude Code Docs — Hooks reference. https://code.claude.com/docs/en/hooks (2026-09-30)
7. Claude Code Docs — CLI reference (`--max-turns`, `--max-budget-usd`). https://code.claude.com/docs/en/cli-reference (2026-09-30)
8. SWE-agent Docs — Model config reference. https://swe-agent.com/latest/reference/model_config/ (2026-09-30)
9. OpenHands Docs — Configuration options (V0). https://docs.openhands.dev/openhands/usage/v0/advanced/V0_configuration-options (2026-09-30)
10. Temporal Docs — Workflow Id and Run Id (Reuse/Conflict Policy). https://docs.temporal.io/workflow-execution/workflowid-runid (2026-09-30)
11. Kubernetes Docs — Resource Quotas. https://kubernetes.io/docs/concepts/policy/resource-quotas/ (2026-09-30)
12. Amjad Masad (Replit CEO), X 게시물 2025-07-20. https://x.com/amasad/status/1946986468586721478 (검색 결과 인용, 직접 열람 안 됨)
13. GitHub Docs — GITHUB_TOKEN (events triggered by GITHUB_TOKEN do not create new runs). https://docs.github.com/en/actions/concepts/security/github_token (2026-09-30)
14. GitHub Docs — Scopes for OAuth apps (`workflow` scope). https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps (2026-09-30)
15. GitHub Docs — Manage environments (required reviewers, prevent self-approval, wait timer, custom rules, admin bypass). https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments (2026-09-30)
16. GitHub Docs — Create custom deployment protection rules. https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/create-custom-protection-rules (2026-09-30)
17. GitHub Docs — About code owners. https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners (2026-09-30)
18. GitHub Docs — About rulesets. https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets (2026-09-30)
19. GCC — Installing GCC: Building (3-stage bootstrap, stage2/stage3 comparison). https://gcc.gnu.org/install/build.html (2026-09-30)
20. Argo Rollouts — Canary Deployment Strategy. https://argo-rollouts.readthedocs.io/en/stable/features/canary/ (2026-09-30)
21. Zhang, Hu, Lu, Lange, Clune — Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents, arXiv:2505.22954 (2025-05-29). https://arxiv.org/abs/2505.22954
22. KTB 저장소 — `docs/factory/DECISIONS.md` ADR-020 KTB-32(1300–1383행), ADR-021(2144–2227행), ADR-025(3228–3343행), ADR-027(3406–3491행), ADR-028(3493–3568행), ADR-031(3617–3631행); `factory/lib/labels.js`; `factory/lib/transition.js`; `factory/bin/transition.js`; `factory/hooks/block-dangerous.sh`; `factory/test/hooks.test.js`; `factory/lib/requirements.js`; `factory/lib/retro/issue-comments.js`; `factory/lib/feedback/harvest-findings.js`; `factory/lib/gh.js`; `factory/lib/budget.js`; `factory/lib/back-pressure.js`; `factory/lib/sweeper.js`; `factory/lib/gates.js`; `factory/lib/harness-request.js`; `factory/lib/merge-stage.js`; `factory/lib/protected-paths.js`; `factory/bin/run-stage.js`; `factory/cli/install.js`; `factory/cli/manifest.js`; `factory/test/self-mirror.test.js`; `.factory/harness.toml`; `docs/factory/CHARTER.md`; `templates/know-thy-build/next.md`; `docs/research/simulation-105.md`
23. GitHub 이슈 LeeHyeonKyu/know_thy_build #41 (2026-09-21), #36 (2026-09-21, 코멘트 타임라인 포함)
