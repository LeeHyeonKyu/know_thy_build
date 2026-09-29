# Research: 부가 장치 목록과 실측
Date: 2026-09-29
Question: KTB 팩토리 엔진에서 핵심 흐름(이슈 → 다역할 플랜 → 구현 → 검증자 → 다역할 리뷰 → 게이트 → 머지)이 아닌 **부가 장치**는 무엇이 있고,
각 장치는 얼마를 썼으며 실제로 무엇을 잡았는가? 소유자 원칙 P1(되돌릴 수 있는 것은 실패한 테스트와 must_fix뿐)·P2(흐름 안 부가 장치는
LLM 세션을 쓰지 않는다)·P3(되돌림은 처음부터 다시 시작하지 않는다)에 비추어 각 장치를 어떻게 분류해야 하는가?

읽는 법
- `oc#N` = own-calendar 이슈 N, `demo#N` = know-thy-build-demo 이슈 N.
- "스테이지 런" = 한 이슈 기록 파일에서 `(stage, runner-id)`가 같은 섹션 전체. 비용은 그 런의 `usage:` 줄 `cost_usd`.
- "캠페인 창" = 2026-09-26T15:40Z ~ 2026-09-28T14:04Z (핸드오버 문서가 쓴 46시간).
- 소유자 결정(2026-09-29, 작업 중 전달): **검증자(factory-verifier)는 핵심이다.** 이 문서는 검증자를 CORE로 두고, 변경 자체에 대한
  검증자 거부는 리뷰어 must_fix와 같은 "core" 원인으로 센다. 검증자에 붙은 장치(prove-test CLI 등)는 따로 부가 장치로 적는다.

## Findings

### 0. 한 장 요약

| 항목 | 값 | 출처 |
|---|---|---|
| 기록된 스테이지 런 | 383 (own-calendar 187, 데모 196), $1,381.94 | [1][2], 부록 스크립트 |
| 전진한 런 | 221 (57.7%), $702.59 | 〃 |
| 핵심이 멈춘 런 (리뷰 rework 32 · K 소진 8 · 검증자 거부 7 · 변경이 깨뜨린 테스트 5) | 52, $377.93 | 〃 |
| **부가 장치·환경이 멈춘 런** | **110 (28.7%), $301.42** — 그중 75개는 LLM 세션을 이미 쓴 뒤에 멈췄다 | 〃 |
| 캠페인 창만 | 243런 $634.03 = 전진 146 / 핵심 33 ($172.81) / 장치·환경 64 ($163.42) | 〃 |
| 장치가 멈춘 110런 중 **변경의 실제 결함**으로 확인된 것 | 3 (+ 혼합 1, 이슈 정의 결함 2) | Part C |
| own-calendar `needs-human` 전이 | 38회, 그중 핵심 원인 4 / 장치·환경 34; 사람 전이(`by=human`) 58회 | [6] |
| own-calendar Actions 런(캠페인 창) | 1,889개. 스테이지 워크플로 1,540 중 1,281(83.2%)이 `skipped`, 101이 `cancelled` | [5] |
| own-calendar 러너 점유(캠페인 창 2,785분 중 2,603분 사용) | 스테이지 잡 2,395분(92.0%), retro 157분(6.0%), integrity 38분, sweeper 6분, rehearse 5분, health 1분 | [5] |
| 큐 대기 중앙값(런 생성 → 잡 시작) | implement 46.2분, review 47.5분, plan 21.9분, integrity 45.5분 | [5] |

핵심 관찰 셋.
1. **장치가 멈춘 런의 대부분은 장치·하네스·환경의 결함이었다.** prove-test 13회 중 확인된 변경 결함 0, 뮤테이션 검사 13회 중 0,
   워크트리 클린 검사 5회 중 0, 플랜 계약 검증기 4회 중 0.
2. **되돌림은 전부 새 GitHub Actions 잡이다.** 되돌린 뒤 다음 잡이 러너를 잡기까지 own-calendar에서 중앙값 46분을 기다렸다(P3 위반의 실측 단가).
3. **별도 워크플로는 러너 시간보다 큐 자리를 먹는다.** integrity는 237번 떠서 38분만 썼지만 108번이 취소됐고, 라벨 이벤트 하나가
   워크플로 다섯 개를 띄워 1,281개가 `skipped`로 끝났다.

---

### Part A — 장치 목록

열 설명: **멈춤** = 전이를 막거나 `needs-human`/`blocked`/`needs-info`/`planned`로 보낼 수 있는가. **LLM** = 세션을 쓰는가.
**위치** = 스테이지 잡 안(잡) / 별도 Actions 런(별도). **실측** = Part B의 멈춘 런 수와 그 비용, 또는 기록에 남은 발화 횟수.
경로는 `/Users/hk/workspace/know_thy_build/` 기준.

#### A-1. 세션 시작 전 (run-stage.js가 `claude -p`를 띄우기 전)

| # | 장치 | 구현 | 막으려는 것 · 출처 | 멈춤 | LLM | 위치 | 실측 |
|---|---|---|---|---|---|---|---|
| 1 | CHARTER/harness 준비 확인(dormancy) | `factory/bin/run-stage.js:184`, `:2353-2361` | CHARTER `status != ready`이거나 harness.toml을 못 읽으면 조용히 exit 0 | 멈춤(기록 없음) | 없음 | 잡 | 기록에 남지 않음 |
| 2 | run 기록 하이드레이트·records 브랜치 동기화 | `run-stage.js:204-207`, `:1216-1226`; `factory/lib/records-branch.js:174`, `:214` | 보호된 기본 브랜치에 기록을 못 씀 — ADR-014 | 기록만 | 없음 | 잡 | 실패 줄 0 |
| 3 | 이슈 평생 예산 | `factory/lib/budget.js:33`; `run-stage.js:214-228` | 재큐를 가로지른 비용 폭주 — ADR-031, L19 | 멈춤 → needs-human | 없음 | 잡 | 1런 (oc#90), $0 |
| 4 | back-pressure | `factory/lib/back-pressure.js:2`; `run-stage.js:231-239` | awaiting-review 적체·격리 초과 시 implement 보류 | 물러남(exit 0, 라벨 그대로) | 없음 | 잡 | 기록 0줄 |
| 5 | workspace 신뢰 등록 | `factory/bin/trust-workspace.js`; `run-stage.js:241` | 신뢰되지 않은 workspace의 allow/deny — ADR-008 | 아님 | 없음 | 잡 | — |
| 6 | claim 락(락 브랜치) | `factory/lib/claim.js:75`; `run-stage.js:254-270` | 같은 이슈에 두 러너 — ADR-020 KTB-28 | 멈춤(exit 2) | 없음 | 잡 | 1런 (oc#28), $0 |
| 7 | 중복 실행 가드 | `run-stage.js:293-300`, `completedForHead` `:1906` | 같은 head로 스테이지 재실행 — 감사 M13 | 멈춤(exit 0) | 없음 | 잡 | 기록 0줄 |
| 8 | 진입 상태 가드 | `run-stage.js:325-371` | 끝난 스테이지의 재점화, 상태 라벨 2개 — KTB-10·KTB-18·M13 | 멈춤 | 없음 | 잡 | 10런, $0 |
| 9 | blocked 재시도 hop·origin 확인 | `run-stage.js:383-407` | blocked에서 잘못된 스테이지가 재시도 — KTB-15b·KTB-24 | 멈춤(origin 불일치) | 없음 | 잡 | hop 9회, 멈춤 0 |
| 10 | 하네스 의존 주차(review 진입) | `run-stage.js:431-443`; `factory/lib/harness-request.js:182` | 하네스에 막힌 이슈가 리뷰 라운드를 태움 — 리뷰 효율 Task 8 | 보냄 → needs-info | 없음 | 잡 | 0 |
| 11 | setup 기준선 스냅샷·복원 | `run-stage.js:452-473`, `:1569`, `:1610` | `[runtime].setup`이 더럽힌 트리가 PR·클린 검사에 섞임 — KTB-39 | 아님(복원) | 없음 | 잡 | `setup dirtied` 177줄, 복원 67회 |
| 12 | 게이트 산출물·agents 로그 초기화 | `run-stage.js:474`, `:610`, `:1465` | 지난 런의 판정 파일이 이번 전이를 대신함 | 아님 | 없음 | 잡 | — |
| 13 | 하트비트·progress 마커 | `factory/lib/heartbeat.js:136`; `factory/lib/progress.js:265`; `run-stage.js:475` | 진행 신호, sweeper의 정지 판정 재료 — ADR-022 | 기록만(이슈 코멘트) | 없음 | 잡 | 마커 있는 런 250 |
| 14 | 선행 handoff 확인 | `run-stage.js:476-477`, `:2384-2392` | 직전 스테이지 산출물 없이 시작 | 멈춤 → needs-human | 없음 | 잡 | 1런 (demo#14), $0 |
| 15 | PR head 고정 체크아웃(review/merge) | `run-stage.js:480-490`, `:1919` | 검증하지 않은 커밋을 검증한 것으로 착각 (R6) | 멈춤 → needs-human | 없음 | 잡 | 0 |
| 16 | 스테이지 브랜치 체크아웃 + base 병합 | `run-stage.js:495-508`, `:1957`, `:2005` | 세션 도중 브랜치 이동, 낡은 PR — ADR-023 Task 8b, KTB-38 | 멈춤 → blocked | 없음 | 잡 | 4런, $0; `base_merged` 45회 |
| 17 | 팩토리 설정 overlay + 드리프트 재확인 | `run-stage.js:513-542`, `:2150`, `:2220`; `assertStageBranch` `:623-631`, `:2045` | PR head의 훅·프롬프트로 스테이지가 자기 검증 — KTB-37, ADR-023 Task 8 | 멈춤 → blocked | 없음 | 잡 | 2런 $2.56; overlay 188회 |
| 18 | qa 증거 디렉터리 프로브 | `run-stage.js:552-561`, `:2528-2559` | qa가 증거를 쓸 수 없는 채로 리뷰 — ADR-024/KTB-42 | 멈춤 → blocked | 없음 | 잡 | 프로브 55회, 멈춤 0 |
| 19 | ci-settings(L2 deny 목록) 존재 확인 | `run-stage.js:578-584` | 경로 deny 없는 세션 — ADR-019 | 멈춤 → needs-human | 없음 | 잡 | 0 |
| 20 | 컨텍스트 조립·context manifest | `factory/lib/context.js:220`, `:184`; `run-stage.js:587-609` | 역할이 무엇을 받았는지 사후 추적 — 피드백 루프 Task 1 | 기록만 | 없음 | 잡 | 574줄 |
| 21 | tier 해석(자기 신고 + diff 바닥) · tier 라벨 | `context.js:30`; `factory/lib/gates.js:446`; `run-stage.js:881` | 자기 신고 docs로 가벼운 심사 — 감사 H3·M12, KTB-9 | 아님(레벨·로스터를 바꿈) | 없음 | 잡 | tier 줄 52 |
| 22 | 리허설 게이트(큐 진입) | `factory/lib/transition.js:72-76`; `factory/lib/rehearsal.js:395` | 리허설 안 된 하네스 위에서 첫 이슈 — ADR-025 | 멈춤(큐 전이 거부) | 없음 | 전이 호출자 | run 기록에 없음(원장 [4] 09-27 "Queue refused …") |

#### A-2. 세션과 세션 안의 장치

| # | 장치 | 구현 | 막으려는 것 · 출처 | 멈춤 | LLM | 위치 | 실측 |
|---|---|---|---|---|---|---|---|
| 23 | 스테이지 오케스트레이터 세션(`claude -p` 디스패처) | `run-stage.js:83-90`, `:612`, `:2493-2502`; max-turns `:149-163` | 저장 Workflow를 `-p`로 실행 — ADR-002, KTB-16 | 멈춤(턴 한도·산출물 미복구) | **런당 1세션**(플랜 수리 시 +1) | 잡 | 4런 $59.01 |
| 24 | 산출물 추출·스키마 검증 | `factory/lib/stage-artifact.js:284`; `factory/lib/verify-stage.js:345-386` | 디스패처 최종 텍스트만 믿음 — KTB-7·KTB-17 | 멈춤 | 없음 | 잡 | #23에 포함 |
| 25 | 로스터 완료 검사 | `verify-stage.js:413-415`; `factory/hooks/record-agents.sh` | 역할이 돌지 않았는데 판정이 나옴 | 멈춤 | 없음 | 잡 | 1런 (demo#15) $0.32 |
| 26 | 훅: block-dangerous | `factory/hooks/block-dangerous.sh` (418줄); `templates/factory/claude/settings.json:26-32` | 위험 명령·보호 경로·브랜치 이동 — ADR-009, ADR-023 H1a | 도구 호출 차단 | 없음 | 세션 안 | run 기록에 없음 |
| 27 | 훅: deny-all-writes | `factory/hooks/deny-all-writes.sh` (194줄) | 쓰기 금지 역할의 파일 쓰기 | 도구 호출 차단 | 없음 | 세션 안 | 〃 |
| 28 | 훅: stop-guard | `factory/hooks/stop-guard.sh` | 미커밋·미push로 세션 종료 | 종료 거부 | 없음 | 세션 안 | 〃 |
| 29 | 훅: verdict-format | `factory/hooks/verdict-format.sh` | verdict JSON 없는 리뷰어·검증자 종료 | 종료 거부 | 없음 | 세션 안 | 〃 |
| 30 | 훅: lint-touched · record-agents | `factory/hooks/lint-touched.sh`, `record-agents.sh` | 건드린 파일 lint 로깅, 서브에이전트 시작/종료 기록 | 기록만 | 없음 | 세션 안 | 〃 |
| 31 | lessons 파일(역할 프롬프트에 실림) | `templates/factory/factory/lessons/*.md`; `factory-implement.js:531` 등 | retro가 쌓은 교훈을 체크리스트로 | 아님 | 세션 토큰 | 세션 안 | 토큰 비용 분리 불가 |
| 32 | triage 에이전트 | `templates/factory/claude/workflows/factory-triage.js:112` | 만들 것인가·tier — 스펙 §3.2 | 멈춤 → needs-info / wont-do | **1세션 + 오케스트레이터** | 잡 | 10런 $3.20 (triage 전체 67런 $19.13) |
| 33 | NEVER_AUTOMATE 스크립트 덮어쓰기 | `verify-stage.js:309`, `:393-403`; `run-stage.js:868-870` | 에이전트가 목록을 못 봄 — 감사 M1, L14 | 멈춤 → wont-do | 없음 | 잡 | 2런 $0.64 |
| 34 | 플랜 성숙도 상한(워크플로 주입 note) | `templates/factory/claude/workflows/factory-plan.js:171-193` | 성숙도를 넘는 done_when 레벨 — L39 | 아님(플랜을 고침) | 없음 | 세션 안 | L39의 원인 |
| 35 | load-bearing self-critique(skeptic) | `templates/factory/claude/workflows/factory-implement.js:484-522` | 되돌리기 어려운 변경의 사전 공격 — 리뷰 효율 Task 3 | 아님(빌더에 되먹임) | **+1~2세션** | 세션 안 | 세션 수 분리 불가(라벨이 agentType) |
| 36 | 리뷰 R2 교차 심문(full/light) | `templates/factory/claude/workflows/factory-review.js:393-476` | 독립 R1의 맹점 | 판정을 바꿈 | **로스터 수만큼 +세션** | 세션 안 | own-calendar 리뷰 36런에서 리뷰어 세션 338개(런당 8–12) |
| 37 | dispute 판정 | `factory-review.js:209-290` | 빌더가 반박한 must_fix — §7.5, P3-R4 | 판정을 바꿈 | **반박당한 역할마다 +1** | 세션 안 | 2×로스터를 넘는 런 own-calendar 16/36 (dispute와 재시도를 구분 못 함) |

#### A-3. 세션 뒤, 전이 전

| # | 장치 | 구현 | 막으려는 것 · 출처 | 멈춤 | LLM | 위치 | 실측 |
|---|---|---|---|---|---|---|---|
| 38 | 핸드오프 뒤 드리프트 커밋 제거 | `run-stage.js:641-653`, `:1695` | setup이 다시 만든 파일만 담은 커밋 — KTB-43 | 드리프트 밖이면 멈춤 → needs-human | 없음 | 잡 | 제거 64회, 멈춤 0 |
| 39 | head_sha 바인딩(handoff sha = 브랜치 head) | `factory/lib/requirements.js:47-66`(`gatesGate`), implement 요구조건 | 검증 뒤 붙은 커밋 | 멈춤 → needs-human | 없음 | 잡 | 1런 (oc#3) $2.73 |
| 40 | 워크트리 클린 검사(쓰기 금지 스테이지) | `run-stage.js:659-680`, `:1734` | triage/plan/review가 파일을 씀 — KTB-14 | 멈춤 → needs-human, **산출물 폐기** | 없음 | 잡 | 5런 $24.79 |
| 41 | test-env re-up | `gates.js:466`, `:489-502` | 죽은 env에 대고 게이트 — KTB-21 | 멈춤 → blocked | 없음 | 잡 | 2런 $5.19 |
| 42 | 명령 게이트(lint/unit/integration/e2e) | `gates.js:322` | 테스트 실패 — **핵심 게이트의 진실** | 멈춤 | 없음 | 잡 | Part B "test gate" 10런 |
| 43 | flaky 분류·격리·flaky 이슈 생성 | `factory/lib/classify-failure.js:3`; `gates.js:526-614`; `factory/lib/quarantine.js` | 기존 flaky가 변경 탓이 됨 — ADR-011, 감사 M3·M4, L34 | BLOCKED 가능, 이슈 생성 | 없음 | 잡 | `FACTORY_GATES` 200줄 전부 `excluded=none` — 한 번도 제외하지 못함 |
| 44 | 테스트 없는 RED 재분류 | `run-stage.js:126-130`, `:735-740` | 테스트 밖 인프라 오류를 제품 결함으로 읽음 — KTB-35 | 멈춤 → blocked | 없음 | 잡 | 0 |
| 45 | `must_not:` 계약 게이트 | `gates.js:616-635`; `factory/lib/integrity.js:186` | 금지가 리뷰 산문에만 있음 — ADR-029, L11 | 멈춤(게이트 RED) | 없음 | 잡 | 0 |
| 46 | prove-test 게이트(특성화 모드·자기참조 검사·fixes_tests 포함) | `factory/lib/prove-test.js:118`, `:101`, `:217`; `gates.js:636-676` | 되돌려도 통과하는 테스트 — §5.2.2; L7·L12·L13·L18·L25·L36, ADR-030 | 멈춤 → needs-human | 없음 | 잡 | **13런 $39.60** |
| 47 | new-test-repeat | `prove-test.js:187`; `gates.js:677-678` | 비결정적 새 테스트 — L17 | 멈춤 | 없음 | 잡 | 단독 멈춤 0 (명령 게이트와 함께 RED 6런) |
| 48 | 증명 게이트 diff_coverage · mutation(stryker) | `gates.js:682-690`; `factory/lib/diff-coverage.js:17`; `factory/lib/mutation.js:6` | 커버리지·뮤테이션 점수 | 멈춤(설정 시) | 없음 | 잡 | 0 (도그푸드 하네스에서 RED 없음) |
| 49 | gates-detail 줄 · `factory/gates` 커밋 상태 | `gates.js:232`; `run-stage.js:723-726` | RED의 뿌리가 아티팩트에만 남음 — 피드백 루프 Task 1 | 기록만 | 없음 | 잡 | 31줄; 게시 실패 2 |
| 50 | 게이트 RED 유계 재시도 | `run-stage.js:845-859` | 빌더가 고칠 RED가 곧장 사람에게 — L26 | 보냄 → planned(**새 잡**) | 없음 | 잡 | 5회 |
| 51 | 플랜 계약 검증기(dissent covers · max_done_when · 가드 모양 · 수용 계약) | `verify-stage.js:231-296` | 위험을 알고도 계약에 안 넣음 — 감사 Task 9; L24·L29·L37·L39 | 멈춤 → needs-human | 없음 | 잡 | **4런 $29.07** |
| 52 | 플랜 수리 턴 | `run-stage.js:768-819` | 기계 판정 결함에 사람 호출 — KTB-51 | 되먹임(같은 잡, **새 세션**) | **플랜 워크플로 전체 재실행** | 잡 | 10런에서 발화: 해소 5, 여전히 RED 4, 타임아웃 1 |
| 53 | 플랜 rounds·orchestration 일치 검사 | `verify-stage.js:404-405` | 설정과 다른 방식으로 돈 플랜 | 멈춤 | 없음 | 잡 | 1런(demo#2, #23에 포함) |
| 54 | 하네스 요청 주차(`harness_needed`) | `run-stage.js:1032-1056`; `harness-request.js:146` | 하네스가 막은 이슈를 사람에게 반복 — KTB-23 | 보냄 → needs-info + 이슈 생성 | 없음 | 잡 | 1런 (oc#31) $9.24 |
| 55 | self-gate: 게이트 재사용 | `factory/lib/self-gate.js:197-206` | 리뷰가 어차피 거부할 diff | 멈춤 | 없음 | 잡 | 0 (게이트 RED는 verify가 먼저 잡는다) |
| 56 | self-gate: 새 테스트 뮤테이션 검사 | `self-gate.js:214-255`; `factory/lib/mutation-check.js:169` | 아무것도 단언하지 않는 테스트 — 리뷰 효율 Task 4; L31 | 보냄 → planned / needs-human | 없음 | 잡 | **13런 $34.40** (실행 35회: 통과 22, 멈춤 13) |
| 57 | self-gate: 회귀 핀 | `self-gate.js:114`; `verify-stage.js:198`; `run-stage.js:963-965` | 고친 must_fix의 재발 — 리뷰 효율 Task 5 | 보냄 → planned | 없음 | 잡 | 실행 17회, 멈춤 0 |
| 58 | self-gate: qa 계약(제거됨) | 당시 `self-gate.js`; 현재 제거(`self-gate.js:20-25` 주석) | — (Defect A) | 멈췄음 | 없음 | 잡 | 1런 (demo#39) $2.91 |
| 59 | self-gate 재시도 카운터·백스톱 | `run-stage.js:1123-1141`, `:2597-2608` | 무한 ping-pong — SF-A; L30 | 보냄 → needs-human | 없음 | 잡 | "not converging" 2회(oc#45, [6]) |
| 60 | qa 증거 매니페스트·부족 합성 must_fix·인용 검사 | `factory/lib/qa-evidence.js:132`, `:283`; `verify-stage.js:423-470`; `run-stage.js:939-952`, `:985-993` | 증거 없는 qa 판정 — ADR-024/KTB-42 | rework·blocked·needs-human 가능 | 없음(도구는 qa 세션이 부름) | 잡 | 유효 매니페스트 50, INVALID 0, 부족 0 |
| 61 | review-evidence 줄(출처)·review flips | `factory/lib/run-record.js:93`; `run-stage.js:994`, `:1003-1008` | handoff 위조, 판정 뒤집힘 관측 — ADR-023 H1b, KTB-29 | 기록만 | 없음 | 잡 | 55줄 / flips 20줄 |
| 62 | 리뷰 집계·정족수·K 한도 | `factory/lib/aggregate.js:1`; `run-stage.js:1185-1188`, `:1798` | 무한 rework — KTB-29 | 보냄 → needs-human | 없음 | 잡 | 핵심에 붙음: K 소진 8런 |
| 63 | 리뷰 스테이지 게이트 재실행(approved는 GREEN 요구) | `requirements.js:47-66`; `gates.js:522-526` | 리뷰 중 붙은 커밋의 미검증 — ADR-010·ADR-011 | 멈춤 → needs-human | 없음 | 잡 | 2런 $15.55 |
| 64 | 전이 그래프·요구조건 | `factory/lib/labels.js:69`; `transition.js:55`; `requirements.js:223` | 자격 없는 전이 | 멈춤(거부 → needs-human) | 없음 | 잡 | 거부 줄 10 |
| 65 | stage-settled 표식·Aborted cleanup | `run-stage.js:1209`, `:1326-1448`; `templates/factory/github/workflows/factory-implement.yml:144-152` | SIGKILL된 잡의 고아 락 — KTB-24, KTB #36 | 보냄 → blocked | 없음 | 잡(스텝) | `post-verdict cleanup` 425줄, `aborted:` 54줄 |

#### A-4. 검증자(CORE)에 붙은 장치

| # | 장치 | 구현 | 멈춤 | LLM | 실측 |
|---|---|---|---|---|---|
| 66 | 검증자가 읽는 prove-test CLI | `factory/bin/prove-test.js`; 프롬프트 `factory-implement.js:541-549` | 검증자 판정의 근거가 됨 | 없음(검증자 세션이 부름) | **3런 $14.61** — CLI가 특성화 모드를 몰라 생긴 거부(L16) |
| 67 | 워크플로 안 Fix 루프(빌더 수정 1회 + verify:2) | `factory-implement.js:568-595` | 되먹임(**같은 세션**, P3 부합) | +2세션 | own-calendar 12런·데모 10런에서 발화; 그 뒤 전진 3런·2런 |
| 68 | 검증자 거부의 유계 재시도 라우팅 | `run-stage.js:1174-1184` | 보냄 → planned(**새 잡**) / needs-human | 없음 | 거부 10회 중 6회(1.4.9 이후 전부)가 이 경로, 앞의 4회는 곧장 needs-human |
| 69 | cold-read 컨텍스트·lessons·verdict-format 훅 | `context.js:106`; `templates/factory/claude/agents/factory-verifier.md` | — | 세션 토큰 | — |

검증자와 겹치는 곳(프롬프트 원문 기준, `templates/factory/claude/agents/factory-verifier.md` Lens 1–8):
- Lens 2(prove-test·new_test_repeat)는 **#46·#47 게이트가 같은 런에서 결정적으로 한 번 더 돈다**(`gates.js:649-678`).
- Lens 1(done_when ↔ 테스트 1:1)·Lens 7(files_expected 이탈)은 `reviewer-spec-conformance.md` Lens 1·2와 같은 질문이다.
- Lens 5(기존 테스트 수정)·Lens 6(skip 프라그마)는 `integrity.js`의 `tests_are_load_bearing` 정책·`SKIP_PRAGMAS`(`integrity.js:3`, `:107`)가 스크립트로 본다.

#### A-5. merge 스테이지(스크립트 전용, LLM 없음)

| # | 장치 | 구현 | 막으려는 것 · 출처 | 멈춤 | 실측 |
|---|---|---|---|---|---|
| 70 | 보호 경로 → 사람 머지 | `factory/lib/merge-stage.js:297-312`; `integrity.js:431` | 게이트 정의·워크플로·CHARTER 자동 머지 — ADR-020 KTB-5 | → needs-human | 0 |
| 71 | 정책 위반(additive_only·lessons 삭제·harness 동결 섹션·기존 테스트 수정) | `merge-stage.js:319-399`; `integrity.js:345` | 합격선 변조 — KTB-6·KTB-10, 감사 H5·M9 | → needs-human | 1런 (demo#45) |
| 72 | merge 게이트 재실행 | `merge-stage.js:407-443` | 머지될 커밋의 미검증 | → needs-human / blocked | `merge: gates GREEN` 27회, RED 0 |
| 73 | mergeGates(필수 체크 + integrity) | `merge-stage.js:459-476`; `run-stage.js:1867` | L0 체크 미통과 | → needs-human | 1런 (demo#8, integrity 대기) |
| 74 | draft 해제 + 체크 정착 대기 | `merge-stage.js:503-574` | draft PR 머지 실패 | → blocked | 2런 (demo#8 draft, oc#49 GraphQL 오류) |
| 75 | 리뷰 정족수·K 재검증 | `merge-stage.js:637`; `factory/lib/review-quorum.js:112` | 위조·불완전한 승인 — ADR-023 H1c | → needs-human | 1런 (oc#3) |
| 76 | 리뷰 증거 출처 바인딩(records 브랜치) | `merge-stage.js:660`; `review-quorum.js:44` | handoff 위조 — ADR-023 H1b | → needs-human | 바인딩 22회, 멈춤 0 |
| 77 | qa 매니페스트 지문 바인딩 | `merge-stage.js:674-678`; `requirements.js:98-99` | 증거 없는 승인 — ADR-024 | → needs-human | 바인딩 21회, 멈춤 0 |
| 78 | 팩토리 상태 게시자 검증 | `merge-stage.js:698`, `:58` | 제3자가 올린 GREEN 상태 | → needs-human | 0 |
| 79 | 두 배우 머지(merge actor 승인) | `merge-stage.js:718-730` | 에이전트 토큰으로 base 머지 — ADR-021 | → needs-human | 승인 21회, 멈춤 0 |

#### A-6. 별도 워크플로·러너 큐

own-calendar 캠페인 창의 Actions API 실측 [5]. "러너 분" = 잡 `started_at`→`completed_at`, 러너 `hk-mac`.

| # | 장치 | 구현 | 멈춤 | LLM | 런 수 | 러너 분 |
|---|---|---|---|---|---|---|
| 80 | 라벨 fan-out(라벨 이벤트 하나 → 스테이지 워크플로 5개) | `templates/factory/github/workflows/factory-*.yml`의 `on: issues: [labeled]` + 잡 `if:`(예: `factory-implement.yml:2-4`, `:35`) | 아님 | 없음 | 1,540 중 skipped 1,281 · cancelled 101 · 실제 실행 159 | skipped는 0 |
| 81 | factory-integrity 워크플로(필수 체크) | `factory-integrity.yml`; `factory/bin/integrity.js`; `integrity.js:23` | **머지를 막음**(필수 상태 체크) — ADR-015, L21 | 없음 | 237 (success 129, cancelled 108) | 38분, 큐 대기 중앙값 45.5분·최대 255.5분 |
| 82 | sweeper(cron 30분 + 스테이지 잡 끝의 Sweep 스텝) | `factory-sweeper.yml:4`; `factory/bin/sweep.js`; `factory/lib/sweeper.js:1222`; `factory-implement.yml:161-166` | **needs-human으로 보냄**(stalled restart limit, retries exhausted, blocked 에스컬레이션) | 없음 | cron 11 (46시간에 기대치 92) | 6분 |
| 83 | retro | `factory-retro.yml`(PR closed마다); `factory/bin/retro.js:1156`; `factory-retro.js:185` | 아님 | **full retro 1세션** | 48 (failure 34, cancelled 14) | **157분(6.0%)**; retro 비용 own-calendar $14.69 · 데모 $10.50, full retro 각 9회 [1][2] |
| 84 | lessons PR·proposal | `factory/lib/retro/publish.js`, `proposals.js` | 아님 | retro 세션 산출 | — | — |
| 85 | 업스트림 피드백 이슈 | `factory/lib/feedback/route.js:127`, `upstream-issue.js:153` — ADR-027 | 아님 | 없음 | KTB #102·#103(오라우팅, L33), #122–124 | — |
| 86 | 건강 잡 | `factory-health.yml:10`(주 1회); `factory/bin/health.js:642` — ADR-028 | 아님 | **없음**(`claude` 호출이 없다 — `run("claude"`는 `retro.js`와 `run-stage.js`뿐) | 1 | 1분 |
| 87 | rehearse 워크플로 | `factory-rehearse.yml`; `factory/bin/rehearse.js`; `rehearsal.js:161` — ADR-025 | 큐 진입을 막음(#22) | 없음 | 16 (skipped 10) | 5분 |
| 88 | doctor-ci(merge authority) | `factory-sweeper.yml:45-51`; `factory/bin/doctor-ci.js` | 아님 | 없음 | sweeper에 포함 | — |
| 89 | 기본 브랜치 갱신 스텝 | `factory-implement.yml:60-68` — L20 | 아님 | 없음 | 모든 스테이지 잡 | — |
| 90 | 아티팩트 스크럽·업로드 | `factory/bin/scrub-artifacts.js`; `factory-implement.yml:104-131` | **잡을 실패로 만듦** | 없음 | own-calendar 스테이지 잡 159개 **전부** `Upload run outputs` 실패 → 잡 결론 failure → #65 정리 스텝 실행 | — |
| 91 | setup 액션·test-env | `.factory/actions/setup`; `factory/bin/setup-env.js`, `test-env.js` | 잡 실패 | 없음 | 모든 잡 | — |

스테이지 잡 안의 시간 배분(own-calendar 캠페인 창, progress 마커가 있는 잡) [1][5]:

| 스테이지 | 잡 | 잡 분 | 세션 전 | 세션 | 세션 뒤(게이트·증명·뮤테이션·업로드·sweep) |
|---|---|---|---|---|---|
| implement | 63 | 1,208 | 18 | 1,005 | 180 (14.9%) |
| review | 32 | 570 | 10 | 509 | 52 (9.0%) |
| plan | 23 | 535 | 6 | 437 | 15 (2.8%) |
| triage | 24 | 46 | 7 | 22 | 17 (36.6%) |
| merge | 17 | 36 | — | — | 전부 스크립트 |

결정적 장치 자체의 실행 시간은 작다. 비용은 **장치가 멈춘 뒤 버려지는 세션과 새 잡의 큐 대기**에서 나온다.

---

### Part B — 전진하지 못한 스테이지 런의 분류

방법: 부록의 `classify.py`. 런마다 기록 줄을 위에서 아래로 읽어 첫 번째로 맞는 원인 하나에 귀속한다. `budget:` 줄은 `REFUSED`가 붙은
경우만 원인이다. 명령 게이트 RED 10런과 검증자 거부 3런은 한 줄로 판정할 수 없어 스크립트 안의 표(`OVERRIDE`, `VERIFIER_TOOL`)에 근거와
함께 손으로 적었다.

#### B-1. 전체(두 저장소, 기록 전 기간)

| 원인 | 런 | cost_usd | usage 줄 없음 | 이슈 |
|---|---|---|---|---|
| **core: 리뷰어 must_fix → rework** | 32 | 264.23 | 0 | demo#2×6, demo#7×2, demo#15×2, demo#18×6, demo#76×2, demo#87×2, oc#3×2, oc#9×2, oc#31×2, oc#45, oc#46, oc#48, oc#49×2, oc#90 |
| **core: K 한도에서 must_fix → needs-human** | 8 | 65.36 | 0 | demo#2, demo#7, demo#15, demo#18, demo#76, demo#87, oc#3, oc#9 |
| **core: 검증자 거부(변경에 대한 것)** | 7 | 40.94 | 0 | demo#2, demo#15×3, oc#28, oc#29×2 |
| **core: 변경이 깨뜨린 테스트** | 5 | 7.38 | 0 | demo#7×5 |
| prove-test 게이트 | 13 | 39.60 | 0 | demo#2, demo#15, demo#45, demo#57, demo#58, oc#9, oc#21, oc#30, oc#31×2, oc#51×2, oc#52 |
| self-gate: 뮤테이션 검사 | 13 | 34.40 | 0 | demo#76, oc#43×2, oc#44×2, oc#45×3, oc#46, oc#47×2, oc#48×2 |
| LLM API 오류·사용량 한도 | 12 | 30.31 | 0 | demo#2×5, demo#15, demo#18×6 |
| triage 판정(needs-info) | 10 | 3.20 | 0 | demo#60, oc#3, oc#9×2, oc#43, oc#44, oc#45×2, oc#60, oc#66 |
| 진입 상태 가드(중복 dispatch) | 8 | 0.00 | 8 | demo#18, oc#3, oc#9×2, oc#28, oc#29, oc#30, oc#49 |
| 워크트리 클린 검사 | 5 | 24.79 | 0 | oc#3, oc#9×2, oc#28, oc#44 |
| 오케스트레이터 세션(턴 한도·산출물 추출) | 4 | 59.01 | 0 | demo#2×2, demo#15×2 |
| 플랜 계약 검증기 | 4 | 29.07 | 0 | oc#31, oc#46, oc#90×2 |
| 스테이지 브랜치 체크아웃 + base 병합 | 4 | 0.00 | 4 | demo#7×2, demo#15×2 |
| 테스트 게이트 RED — 원인 미확정 | 3 | 13.20 | 0 | oc#3, oc#52, oc#90 |
| 검증자가 읽은 prove-test CLI(L16) + 낡은 엔진(L20) | 3 | 14.61 | 0 | oc#28, oc#29, oc#31 |
| 잡 타임아웃·취소 | 3 | 0.00 | 3 | demo#18×2, oc#91 |
| GitHub API 실패(라벨 편집) | 3 | 0.00 | 3 | demo#2×2, demo#15 |
| 리뷰 스테이지 게이트 재실행 | 2 | 15.55 | 0 | demo#18, oc#49 |
| 테스트 게이트 RED — 기존 flaky 테스트 | 2 | 5.45 | 0 | oc#45, oc#50 |
| test-env re-up | 2 | 5.19 | 0 | oc#9×2 |
| overlay·팩토리 설정 드리프트 | 2 | 2.56 | 1 | demo#15×2 |
| NEVER_AUTOMATE 덮어쓰기 | 2 | 0.64 | 0 | demo#76, oc#20 |
| 진입 상태 가드(라벨 셋 무효) | 2 | 0.00 | 2 | demo#5, demo#14 |
| 하네스 요청 주차 | 1 | 9.24 | 0 | oc#31 |
| 러너 툴체인(게이트 명령 없음) | 1 | 8.65 | 0 | oc#9 |
| self-gate: qa 계약(제거됨) | 1 | 2.91 | 0 | demo#39 |
| head_sha 바인딩 | 1 | 2.73 | 0 | oc#3 |
| 로스터 완료 검사(역할 세션이 돌지 않음) | 1 | 0.32 | 0 | demo#15 |
| merge: 리뷰 K 재검증 | 1 | 0.00 | 1 | oc#3 |
| claim 락 | 1 | 0.00 | 1 | oc#28 |
| GitHub API 실패(`gh pr ready`) | 1 | 0.00 | 1 | oc#49 |
| 평생 예산 | 1 | 0.00 | 1 | oc#90 |
| merge 스테이지 결함(draft 미해제) | 1 | 0.00 | 1 | demo#8 |
| integrity 워크플로(필수 체크 대기) | 1 | 0.00 | 1 | demo#8 |
| 선행 handoff 확인 | 1 | 0.00 | 1 | demo#14 |
| 정책: 기존 테스트 수정 → 사람 머지 | 1 | 0.00 | 1 | demo#45 |
| **합계: 전진 221 · 핵심 52 · 장치·환경 110** | 383 | 1,381.94 | | |

#### B-2. 캠페인 창만 (243런, $634.03)

| 원인 | 런 | cost_usd | 이슈 |
|---|---|---|---|
| core: 리뷰어 must_fix → rework | 18 | 114.17 | demo#7×2, demo#15×2, demo#76×2, demo#87×2, oc#9×2, oc#31×2, oc#45, oc#46, oc#48, oc#49×2, oc#90 |
| core: K 한도 → needs-human | 5 | 30.40 | demo#7, demo#15, demo#76, demo#87, oc#9 |
| core: 검증자 거부 | 5 | 20.86 | demo#15×2, oc#28, oc#29×2 |
| core: 변경이 깨뜨린 테스트 | 5 | 7.38 | demo#7×5 |
| self-gate: 뮤테이션 검사 | 13 | 34.40 | demo#76, oc#43×2, oc#44×2, oc#45×3, oc#46, oc#47×2, oc#48×2 |
| prove-test 게이트 | 9 | 21.32 | demo#15, demo#57, demo#58, oc#30, oc#31×2, oc#51×2, oc#52 |
| triage 판정(needs-info) | 7 | 2.43 | demo#60, oc#43, oc#44, oc#45×2, oc#60, oc#66 |
| 진입 상태 가드(중복 dispatch) | 5 | 0.00 | oc#9, oc#28, oc#29, oc#30, oc#49 |
| 플랜 계약 검증기 | 4 | 29.07 | oc#31, oc#46, oc#90×2 |
| 워크트리 클린 검사 | 4 | 24.57 | oc#9×2, oc#28, oc#44 |
| 스테이지 브랜치 체크아웃 + base 병합 | 4 | 0.00 | demo#7×2, demo#15×2 |
| 검증자가 읽은 prove-test CLI + 낡은 엔진 | 3 | 14.61 | oc#28, oc#29, oc#31 |
| 테스트 게이트 RED — 원인 미확정 | 2 | 10.05 | oc#52, oc#90 |
| 테스트 게이트 RED — 기존 flaky | 2 | 5.45 | oc#45, oc#50 |
| overlay·팩토리 설정 드리프트 | 2 | 2.56 | demo#15×2 |
| 하네스 요청 주차 | 1 | 9.24 | oc#31 |
| 리뷰 스테이지 게이트 재실행 | 1 | 6.89 | oc#49 |
| test-env re-up | 1 | 2.65 | oc#9 |
| NEVER_AUTOMATE 덮어쓰기 | 1 | 0.18 | demo#76 |
| claim 락 · `gh pr ready` 실패 · 평생 예산 · 잡 타임아웃 · 라벨 셋 무효 | 각 1 | 0.00 | oc#28 · oc#49 · oc#90 · oc#91 · demo#5 |
| **합계: 전진 146 · 핵심 33 ($172.81) · 장치·환경 64 ($163.42)** | 243 | 634.03 | |

#### B-3. run 기록에 없는 멈춤 — 이슈 코멘트의 전이 마커 [6]

sweeper는 run 기록을 쓰지 않는다. `factory-transition:v1` 코멘트에서 `needs-human`·`blocked`로 간 전이를 셌다.

| 저장소 | needs-human | blocked | 사람 전이(`by=human`) |
|---|---|---|---|
| own-calendar | 38 | 4 | 58 |
| 데모 | 32 | 19 | 34 |

own-calendar `needs-human` 38회의 사유: prove-test 8(RED 5 + MISCONFIGURED 3) · **sweeper "stalled restart limit" 5**(oc#9, oc#28, oc#29, oc#30) ·
워크트리 더티 5 · 플랜 dissent 4 · 전이 거부 4(검증자 2, head_sha 1, 리뷰 게이트 RED 1) · blocked 에스컬레이션 3 · K 소진 2 ·
self-gate "not converging" 2 · 게이트 RED(lint 등) 2 · merge K 재검증 1 · 예산 1 · 사람이 건 HOLD 1.
핵심 원인(K 소진 2 + 검증자 2)은 4회, 나머지 34회는 장치·환경이다. own-calendar retro 상태의 `needs-human 38`과 일치한다 [1].

#### B-4. 손 검증

무작위 16런(전진 못 한 런 12 + 전진한 런 4, `random.seed(20260929)`)의 원문 줄을 읽어 스크립트 판정과 대조했다.
- 15건 일치.
- **오분류 1건**: demo#15 review `gha-34751598421`. 스크립트는 "오케스트레이터 세션(산출물 추출)"로 분류했으나 기록은
  `roster role not completed` 4줄 + `verdicts must have ≥1 item`, `terminal_reason: completed`, 비용 $0.32다 — 리뷰어가 한 명도 돌지 않았고
  **왜 안 돌았는지는 기록에 없다.** 규칙을 고쳐 "로스터 완료 검사(원인 미기록)"로 옮겼다. 위 표는 고친 뒤의 숫자다.
- 추가로, 판정 줄이 하나도 안 보이던 13런(demo#7×2, demo#14×2, demo#15×4, demo#18, demo#39, oc#28, oc#31, oc#90, oc#91)은 원문 전체를 읽었다.
  이 과정에서 oc#90 `gha-36421498639`가 `budget: … — REFUSED`였고, oc#91 plan `gha-36372333164`는 **플랜 수리 턴이 도는 도중**에
  잡이 취소된 것임을 확인했다.
- 교차 검증: own-calendar 기록 전체 비용 합 $562.14는 retro 상태의 `cost (usd) cumulative 562.14`와 일치한다 [1].
  캠페인 창의 159런/$479.33, 84런/$154.70은 핸드오버 §1과 일치한다 [3].

---

### Part C — 장치가 멈춘 런은 진짜였나

"변경의 결함" = 작업 중인 변경(diff) 자체의 실제 결함. "장치·하네스" = 엔진·하네스·프롬프트 결함 또는 오탐. 근거는 핸드오버 L표 [3],
원장 [4], DECISIONS.md [7], 기록의 `self-gate-detail` `ktb_version` [1][2].

| 장치 | 멈춘 런 | 변경의 결함 | 장치·하네스·환경 | 미확정 | 근거 |
|---|---|---|---|---|---|
| prove-test 게이트 | 13 | **0** (혼합 1) | 10 | 2 | oc#9 = 하네스 이슈에서 브랜치 harness를 다시 안 읽음(KTB #50, `run-stage.js:2409-2412`); oc#21 = L18/ADR-030; oc#30 = L7; oc#31 `gha-36292822674` = L25; oc#51×2·oc#52 = L36(+L35); demo#15 = L7 보완(1.4.10); demo#57 = L3; demo#58 = L4. 혼합: oc#31 `gha-36266835309` = L12(엔진) + L13(빌더의 자기참조 테스트). 미확정: demo#2(09-12, gates-detail 없음), demo#45 |
| self-gate 뮤테이션 검사 | 13 | **0** | 12 | 1 | own-calendar 12건 전부 `ktb_version` 1.4.22–1.4.27(1.4.28 이전), 서로 다른 6개 이슈·테스트 파일에서 **같은 문장**("boolean in server/src/app.ts") = L31. 미확정: demo#76(`test/fixtures/notes.js` 뮤테이션) |
| 검증자(CORE) | 7 + 도구 유발 3 | 4 확인 · 2 내용상 변경에 관한 것 | 3 (도구 유발) | 1 | 확인: oc#28·oc#29 첫 거부(원장 "REJECTED (correct)"), oc#29 `gha-36260883125`(dw3 위반 지속), demo#2(`run-stage.js:1013-1016` "맞는 판정"). 변경에 관한 것이나 독립 확인 불가: demo#15 09-26 ×2. 도구 유발: oc#28·oc#29·oc#31의 1.4.12 런 = L16·L20(+L17). 미확정: demo#15 09-12 |
| 워크트리 클린 검사 | 5 | **0** | 5 | 0 | oc#3 = setup이 더럽힌 파일(KTB-39); oc#9×2 = L22, L22 r2; oc#28 = L23; oc#44 = L27 |
| 플랜 계약 검증기 | 4 (+수리 중 타임아웃 1) | **0** | 4 | 0 | oc#31 = L24; oc#46 = L29; oc#90×2 = L37, L39. 멈추지 않고 수리로 해소된 5런(oc#31, oc#49, oc#52, demo#7, demo#76)의 가치는 판정 불가 |
| triage(needs-info) | 10 | 이슈 정의 결함 2 | 정책 기본값 3, 팩토리가 만든 이슈 2 | 3 | 옳았음: oc#45 두 번째(원장 "triage was right"), demo#60(원장 "correct"). 정책: oc#43·oc#44·oc#45 첫 번째 = `[ready]` 표식 없음. 팩토리 생성: oc#60(L16 부산물로 닫힘), oc#66. 미확정: oc#3, oc#9×2 |
| 진입 상태 가드(중복 dispatch) | 8 | 0 | 8 (가드는 옳게 동작; 원인은 상류) | 0 | oc#9·oc#28·oc#29·oc#30(09-26 19:21–19:43) = sweeper의 거짓 에스컬레이션 L9·L10 뒤에 풀린 대기 런; oc#49 = L40; oc#3·demo#18 = 경합 |
| LLM API 오류·한도 | 12 | 0 | 12 (환경) | 0 | 09-12 20:20Z 월 한도, 09-13 세션 한도 429 |
| 오케스트레이터 세션 | 4 | 0 | 4 | 0 | demo#2 plan ×2, demo#15 plan ×2($17.28, $17.73 — 턴 한도 13) = KTB-7·KTB-16·KTB-17 |
| 브랜치 체크아웃 + base 병합 | 4 | 1 | 3 | 0 | demo#7 = 실제 병합 충돌(#87과 같은 자리); 두 번째는 같은 상태의 hop 재시도. demo#15×2 = 낡은 브랜치 + 그래프 엣지 누락(L6) |
| 테스트 게이트 RED(핵심 제외분) | 5 | 0 | 2 (기존 flaky) | 3 | oc#45·oc#50 = `tests/family.test.ts`(L28, flaky 수정 이슈 oc#90); oc#52(401 vs 500)·oc#90(200 vs 201)·oc#3 = 미확정 |
| 리뷰 스테이지 게이트 재실행 | 2 | 0 | 1 | 1 | oc#49 = 리뷰어 5명 승인 뒤 `events.test.ts` ETIMEDOUT(L34); demo#18(09-12) 미확정 |
| overlay·설정 드리프트 | 2 | 1 | 1 | 0 | demo#15 = 빌더가 `CLAUDE.md`를 고침(원장 "Principle correct"); 두 번째는 같은 브랜치 상태의 재시도 |
| test-env re-up | 2 | 0 | 2 (환경) | 0 | 포트 5433 점유(INCIDENT #2, L1·L2) |
| NEVER_AUTOMATE | 2 | 0 | 1 | 1 | demo#76 = L14; oc#20 미확정 |
| 하네스 요청 주차 | 1 | 0 | 1 | 0 | oc#31 → 하네스 이슈 oc#60, L16 부산물로 not-planned 종료 |
| 기존 테스트 수정 → 사람 머지 | 1 | 1 (정책 적중) | 0 | 수정이 정당했는지 미확정 | demo#45 `test/smoke.test.js` |
| self-gate qa 계약 | 1 | 0 | 1 | 0 | Defect A, 장치 제거됨 |
| head_sha 바인딩 · merge K 재검증 · draft 미해제 · integrity 대기 · 러너 툴체인 | 각 1 | 0 | 5 | 0 | oc#3(KTB-43 이전 드리프트), oc#3(사람 재시도 뒤 round 4 > K), demo#8×2, oc#9(`flutter: command not found`) |
| GitHub API 실패 | 4 | 0 | 4 (환경) | 0 | GraphQL "Something went wrong", EOF |
| 평생 예산 | 1 | 0 | 설계대로 동작; 지출은 결함 루프가 만들었다 | 0 | oc#90 $60.58 — L37·L38·L39 (원장 09-28 12:45Z) |
| 잡 타임아웃·취소 | 3 | 0 | 1 | 2 | oc#91 = L38(수리 턴 포함 76분); demo#18×2 취소 사유 미기록 |
| 선행 handoff · 라벨 셋 무효 | 3 | 0 | 3 (운영자 조작) | 0 | demo#5 = 원장 "my operator error"; demo#14 |
| claim 락 · 로스터 완료 검사 | 2 | 0 | 0 | 2 | oc#28은 락 보유자가 **자기 자신**으로 기록됨; demo#15는 원인 미기록 |
| sweeper "stalled restart limit" [6] | 5 (전이) | 0 | 5 | 0 | L9(대기 중인 런을 정지로 읽음), L10(재시작 예산 창) |
| **합계(장치·환경 110런, sweeper 행 제외)** | 110 | **3** (+혼합 1, 이슈 정의 2) | 89 | 15 | |

검증자 수치 요약(CORE, 참고용):
- 세션: own-calendar implement 67런에서 79세션, 데모 37런에서 47세션(마커 있는 런만).
- 런을 멈춘 거부 10회, $55.56. 변경 결함 확인 4 · 변경에 관한 것이나 미확인 2 · 미확정 1 · **도구(prove-test CLI) 유발 오탐 3**.
- 세션 안에서 거부 → 빌더 수정 → 재판정이 돈 런: own-calendar 12, 데모 10. 그중 그 런에서 전진까지 간 것 3, 2.

---

### Part D — 분류 제안

#### D-1. 목록

| 장치 (#) | 제안 | 한 줄 근거 |
|---|---|---|
| 검증자 | **CORE (유지)** | 소유자 결정. 거부 10회 중 변경 결함 확인 4; 오탐 3은 전부 붙은 도구(#66) 탓 |
| 명령 게이트 (42) | KEEP IN FLOW | P1의 "실패한 테스트" 그 자체 |
| test-env re-up (41) | KEEP IN FLOW | 게이트의 진실에 필요. 2회 멈춤은 환경 사고 |
| flaky 분류·격리 (43) | KEEP IN FLOW | 게이트가 변경 탓이 아닌 RED를 내지 않게 하는 유일한 장치. 단 200번의 판정에서 제외 0회 — 지금은 일하지 않는다 |
| flaky 이슈 자동 생성 (43의 일부) | MOVE OUT OF FLOW | 판정과 무관한 부수 작업 |
| new-test-repeat (47) | KEEP IN FLOW | 결정적이고 단독 오탐 0 |
| `must_not:` 게이트 (45) | KEEP IN FLOW | 결정적 계약, 발화 0 — 판단 근거 부족 |
| diff_coverage · stryker (48) | DEMOTE TO RECORD-ONLY | 발화 기록 없음. P1의 두 사유에 해당하지 않음 |
| **prove-test 게이트 (46)** | **DEMOTE TO RECORD-ONLY** ★ | 13회 멈춤, 변경 결함 확인 0, 엔진 결함 10. 검증자가 같은 도구를 이미 읽는다 |
| **self-gate 뮤테이션 검사 (56)** | **DEMOTE TO RECORD-ONLY** ★ | 13회 멈춤, 변경 결함 확인 0, L31 오탐 12 |
| self-gate 회귀 핀 (57) | DEMOTE TO RECORD-ONLY | 17회 실행, 멈춤 0. guard 테스트는 명령 게이트가 이미 돌린다 |
| self-gate 게이트 재사용 (55) | REMOVE | 멈춤 0 — verify가 같은 RED를 먼저 잡는다 |
| self-gate 재시도 카운터 (59) | KEEP IN FLOW | 핵심 되돌림의 루프 상한. L30 오발 2회는 창 계산 결함 |
| **플랜 계약 검증기 (51) + 수리 턴 (52)** | **DEMOTE TO RECORD-ONLY** ★ | 4회 멈춤 + 타임아웃 1, 변경 결함 0, $29.07. 수리 턴은 플랜 워크플로 전체를 새 세션으로 다시 돌린다(P2·P3 위반) |
| 플랜 rounds·스키마 검사 (24·53) | KEEP IN FLOW | 산출물이 읽혀야 다음 단계가 있다 |
| 플랜 성숙도 상한 (34) | KEEP IN FLOW | 결정적. L39는 검증기(51)와의 충돌이었다 |
| **워크트리 클린 검사 (40)** | **DEMOTE TO RECORD-ONLY** ★ (복원 후 기록) | 5회 멈춤, 변경 결함 0, 리뷰 세션 $24.79 폐기 |
| overlay + 드리프트 재확인 (17) | KEEP IN FLOW | 스테이지가 자기 설정으로 도는지는 게이트의 전제. 실제 `CLAUDE.md` 편집 1건 적중 |
| setup 기준선·복원 (11) · 드리프트 제거 (38) | KEEP IN FLOW | 멈추지 않는 수리 장치. 제거 64회 |
| head_sha 바인딩 (39) | KEEP IN FLOW | 게이트 판정을 커밋에 묶는다 |
| 진입 상태 가드 (8) · claim 락 (6) · 중복 실행 가드 (7) | KEEP IN FLOW | 결정적, $0. 11회 전부 세션 시작 전에 멈춰 이중 지출을 막았다 |
| 평생 예산 (3) | KEEP IN FLOW ★ | 세션 전, $0. P1의 예외로 소유자가 명시 승인한 상한(ADR-031) |
| back-pressure (4) | KEEP IN FLOW | 라벨을 안 바꾸는 보류. 발화 기록 0 — 판단 근거 부족 |
| blocked 재시도 hop (9) | KEEP IN FLOW | 복구 경로 |
| 하네스 의존 주차 (10) · 하네스 요청 주차 (54) | DEMOTE TO RECORD-ONLY | 1회 멈춤이 오탐($9.24). 요청은 handoff에 적고 흐름은 계속 |
| qa 증거 프로브 (18) | KEEP IN FLOW | 세션 전, 55회 중 멈춤 0 |
| qa 증거 매니페스트·바인딩 (60·77) | KEEP IN FLOW | qa 리뷰(핵심)의 증거. 멈춤 0 |
| qa 부족 합성 must_fix (60의 일부) | DEMOTE TO RECORD-ONLY | 리뷰어가 아니라 장치가 만든 must_fix. 발화 0 |
| 컨텍스트 매니페스트 (20) · review-evidence·flips (61) · gates-detail (49) · 하트비트 (13) · records 브랜치 (2) · stage-settled (65) | KEEP IN FLOW (기록 전용) | 이미 멈추지 않는다 |
| tier 해석 (21) | KEEP IN FLOW | 결정적. 게이트 레벨과 로스터를 정한다 |
| **triage 에이전트 (32)** | **MOVE OUT OF FLOW** ★ | 흐름 안 LLM 세션(P2). needs-info 10회 중 옳았다고 확인된 것 2 |
| NEVER_AUTOMATE 덮어쓰기 (33) | KEEP IN FLOW | 결정적. 2회 중 1회 오탐(L14, 수정됨) |
| **오케스트레이터 세션 (23)** | **REMOVE** ★ (결정적 디스패처로 대체) | 런마다 LLM 1세션, 4런 $59.01이 산출물 없이 증발 |
| 로스터 완료 검사 (25) | KEEP IN FLOW | 모든 역할이 돌았는지는 핵심의 전제 |
| 훅 (26–30) | KEEP IN FLOW | 세션 안 결정적 경계. run 기록으로 효과를 잴 수 없다 |
| 검증자의 prove-test CLI (66) | KEEP IN FLOW | 검증자의 도구. 게이트와 같은 규칙 하나를 써야 한다(L16) |
| 워크플로 안 Fix 루프 (67) | KEEP IN FLOW | 같은 세션 안 되돌림 — P3에 맞는 유일한 기존 경로 |
| 검증자 거부 재시도 라우팅 (68) | KEEP IN FLOW | 핵심의 되돌림. 단 새 잡을 만든다(P3) |
| load-bearing self-critique (35) | REMOVE | 흐름 안 부가 LLM 세션(P2). 효과를 잴 기록이 없다 |
| **리뷰 R2 (36)** | KEEP IN FLOW(full) / 경량 R2는 판단 보류 ★ | R1→R2 변화가 기록에 없어 가치를 잴 수 없다 |
| dispute 판정 (37) | KEEP IN FLOW | must_fix 되돌림의 일부 |
| K 한도·집계 (62) | KEEP IN FLOW | 핵심의 상한 |
| 리뷰 스테이지 게이트 재실행 (63) | KEEP IN FLOW | 리뷰된 커밋의 테스트 통과는 게이트의 진실. 2회 중 1회는 flaky(L34) |
| **merge 게이트 재실행 (72)** | **REMOVE** ★ (head·base가 같으면 재사용) | 27회 전부 GREEN, RED 0 |
| 보호 경로·정책 위반 (70·71) | KEEP IN FLOW | 머지 권한 경계. 1회 적중 |
| 리뷰 정족수·출처 바인딩·상태 게시자 검증·두 배우 머지 (75·76·78·79) | KEEP IN FLOW | 결정적, 멈춤 1(oc#3, 엔진 쪽 K 창). 리뷰가 실제로 있었음을 증명 |
| draft 해제·체크 대기 (74) | KEEP IN FLOW | 머지의 기계적 전제 |
| **라벨 fan-out (80)** | **REMOVE** | 1,540런 중 1,281 skipped, 101 cancelled |
| **integrity 워크플로 (81)** | KEEP IN FLOW — 단 **스테이지 잡 안의 스텝으로** | 237런·취소 108·큐 대기 중앙값 45.5분에 실행은 38분 |
| sweeper의 에스컬레이션 팔 (82) | DEMOTE TO RECORD-ONLY | "stalled restart limit" 5회 전부 오탐(L9·L10) |
| sweeper의 락 회수·blocked 재점화 (82) | KEEP IN FLOW | 복구 경로 |
| **retro·lessons PR·업스트림 이슈 (83–85)** | **MOVE OUT OF FLOW** | LLM 세션. 같은 러너에서 48런 157분 |
| 건강 잡 (86) | MOVE OUT OF FLOW | 주 1회, 결정적 |
| rehearse 워크플로 (87) · 리허설 게이트 (22) | MOVE OUT OF FLOW / DEMOTE TO RECORD-ONLY | 큐 진입을 막는다(P1). 적중 기록 없음 |
| 아티팩트 업로드 (90) | DEMOTE TO RECORD-ONLY | own-calendar 159/159 실패가 잡을 전부 failure로 만들었다 |
| Aborted cleanup (65) · 기본 브랜치 갱신 (89) · setup (91) | KEEP IN FLOW | 복구·전제 |

★ = 아래 D-2에서 반론과 함께 다룬다.

#### D-2. 다툼이 있는 분류

**prove-test 게이트 → DEMOTE TO RECORD-ONLY**
1. 권고와 근거: 13런을 멈춰 $39.60을 버렸고 변경의 결함으로 확인된 것은 0건이다. 10건은 엔진 결함(L3·L4·L7·L18·L25·L36, KTB #50)이고
   고칠 때마다 릴리스가 필요했다. 같은 도구를 검증자(CORE)가 읽고 판정에 쓴다.
2. 최선의 반론: prove-test는 "되돌려도 통과하는 테스트"를 잡는 **결정적** 검사이고, 이것을 기록으로 내리면 판단이 LLM(검증자) 하나에
   남는다. 혼합 1건(oc#31)은 빌더가 자기 파일을 단언하는 테스트로 게이트를 속이려 한 실제 사례다.
3. 반론이 이기려면: 검증자가 accept했는데 prove-test만 RED로 잡은 무가치한 테스트가 기록에 있어야 한다. 지금 기록에는 없고,
   verify FAIL 런의 검증자 판정이 run 기록에 남지 않아 확인할 수도 없다.

**self-gate 뮤테이션 검사 → DEMOTE TO RECORD-ONLY**
1. 권고와 근거: 35회 실행 중 13회 멈춤, 그중 12회가 L31 오탐, 확인된 적중 0. L31 수정(1.4.28) 뒤로는 `ktb_version`이 기록된 런에서 이 검사가 돈 적이 없다(0회) — 수정 뒤의 성능은 실측이 없다.
2. 최선의 반론: L31은 고쳐졌고, 이 검사가 노리는 결함(own-cal R1 cf1 — 아무것도 단언하지 않는 가드 테스트)은 리뷰 라운드 $6–13보다
   싸게 잡힌다.
3. 반론이 이기려면: 1.4.28 이후 소스 변경이 있는 diff에서 survivor가 실제 빈 단언을 잡은 기록이 필요하다. 실행 자체가 0건이다.

**플랜 계약 검증기 + 수리 턴 → DEMOTE TO RECORD-ONLY**
1. 권고와 근거: 멈춘 4런 모두 표기·주입 note·되먹임 문구 문제였다(L24·L29·L37·L39). oc#90은 이 루프로 $25.70을 쓰고 평생 예산에 걸렸다.
   수리 턴은 oc#91에서 75분 타임아웃을 넘겼다.
2. 최선의 반론: 이 검증기는 데모 #2의 9라운드·$118(위험을 알고도 계약에 넣지 않음)에서 나왔다 [7]. 수리 턴은 5런에서 사람 없이 해소했다.
3. 반론이 이기려면: 검증기를 통과한 플랜과 통과하지 못한 플랜의 리뷰 라운드 수 차이가 측정돼야 한다. 기록으로는 비교할 표본이 없다.

**워크트리 클린 검사 → DEMOTE TO RECORD-ONLY(복원 후 기록)**
1. 권고와 근거: 5회 전부 setup·overlay·도구 cwd·툴 캐시가 만든 diff였다. 멈출 때마다 이미 끝난 리뷰 세션을 통째로 버렸다.
2. 최선의 반론: 쓰기 금지 스테이지가 제품 파일을 고쳤다면 그 판정은 자기가 고친 트리에 대한 것이다(KTB-14). 훅이 놓친 쓰기의 마지막 방어선이다.
3. 반론이 이기려면: 에이전트가 실제로 추적 파일을 고친 사례가 있어야 한다. 5건 중 0건.

**평생 예산 → KEEP IN FLOW**
1. 권고와 근거: 세션 시작 전에 $0로 멈춘다. 1회 발동(oc#90)은 설계대로였다.
2. 최선의 반론: P1은 되돌림 사유를 둘로 한정한다. 예산은 테스트도 must_fix도 아니며, oc#90의 지출은 결함 루프가 만든 것이라
   예산이 막은 것은 증상이다.
3. 반론이 이기려면: 장치가 멈춘 런이 사라진 뒤에도 이슈당 비용이 상한에 닿지 않아야 한다. 캠페인 창 own-calendar 비용의 32.4%($155.17 / $479.33, 51런)가 장치·환경이
   멈춘 런이었으므로 그 뒤에 다시 재 볼 수 있다.

**triage 에이전트 → MOVE OUT OF FLOW**
1. 권고와 근거: 67런 $19.13, 런마다 세션 2개(오케스트레이터 + triage)를 쓰고, needs-info 10회 중 옳았다고 확인된 것은 2회다. 핵심 흐름 1번은 이슈가
   스킬로 잘 정의돼 들어온다고 전제한다.
2. 최선의 반론: 비용이 런당 $0.29로 가장 싸고, 옳았던 2회는 뒤 단계의 $10 이상을 아꼈다. tier가 로스터와 게이트 레벨을 정한다.
3. 반론이 이기려면: 이슈 작성 스킬이 같은 질문을 놓친다는 증거. tier는 diff 바닥(#21)이 결정적으로 보정하므로 에이전트 없이도 남는다.

**오케스트레이터 세션 → REMOVE**
1. 권고와 근거: 모든 스테이지 런이 워크플로를 띄우기 위해 LLM 세션 하나를 쓴다. 4런 $59.01이 턴 한도·산출물 미복구로 사라졌다.
2. 최선의 반론: ADR-002가 `-p`에서 저장 Workflow를 실행하는 방식을 고른 이유가 있고, 결정적 디스패처가 가능한지는 이 조사 범위 밖이다.
3. 반론이 이기려면: Workflow를 세션 없이 실행할 수단이 없어야 한다. **확인하지 못했다.**

**리뷰 R2 → 판단 보류**
1. 권고와 근거: full R2(거부가 하나라도 있을 때)는 유지. 경량 R2(전원 승인)는 가치를 잴 수 없어 제거도 유지도 권하지 않는다.
   리뷰어 세션의 절반이 R2다.
2. 최선의 반론: own-calendar oc#49는 r2에서 qa가 승인 → 거부로 바뀌었다. 단 이것은 라운드 사이의 변화이고 R1→R2 변화가 아니다.
3. 반론이 이기려면: R1과 R2 판정이 둘 다 기록돼야 한다. 지금 handoff는 R1을 싣지 않는다(`factory-review.js:501-503`).

**merge 게이트 재실행 → REMOVE(조건부 재사용)**
1. 권고와 근거: 27회 전부 GREEN. 리뷰 스테이지가 같은 head에서 이미 돌렸고 `factory/gates` 상태가 커밋에 붙어 있다.
2. 최선의 반론: 리뷰와 머지 사이에 base가 움직이면 같은 head라도 병합 결과가 다르다.
3. 반론이 이기려면: base가 움직인 뒤 merge에서 RED가 난 사례. 기록에 0건.

---

## 확인하지 못한 것

1. **R1→R2에서 판정이 바뀐 비율.** handoff와 run 기록 모두 R1을 싣지 않는다.
2. **dispute·self-critique 세션 수.** progress 마커의 라벨이 agentType이라 같은 역할의 R1·R2·dispute·재시도를 구분할 수 없다.
3. **플랜 수리 턴이 돈 10런의 첫 패스 비용.** `usage:` 줄은 마지막 `claude -p` 봉투만 적는다(`run-stage.js:794-796`). 이 10런의 비용은 하한이다.
4. **SIGKILL된 런의 비용.** oc#91 plan(76분), demo#18 implement ×2는 `usage:` 줄이 없다.
5. **훅이 막은 도구 호출 수.** run 기록에 남지 않는다.
6. **결정적 게이트 각각의 실행 시간.** `gates.json`의 `duration_ms`는 3일 보존 아티팩트에만 있다. 세션 뒤 구간 합만 쟀다.
7. **데모 저장소의 러너 분·큐 대기.** 잡 API는 own-calendar 캠페인 창만 조회했다. 데모 창의 런 수는 898개다.
8. Part C의 미확정 15런 — 특히 oc#52·oc#90의 integration RED가 변경 탓인지, demo#76의 뮤테이션 survivor가 진짜였는지.
9. **back-pressure·중복 실행 가드**는 기록에 한 줄도 없다. 발화하지 않은 것인지 기록 이전에 물러난 것인지 구분할 수 없다.
10. **결정적 디스패처의 기술적 가능성**(오케스트레이터 세션 제거).
11. own-calendar 스테이지 잡 159개 전부에서 `Upload run outputs`가 실패한 **원인**. 원장은 계정 아티팩트 쿼터를 말하지만 [4] 스텝 로그는 읽지 않았다.
12. ADR-022 이전 런(데모 106런)은 progress 마커가 없어 세션 수 집계에서 빠졌다.

핸드오버 문서 [3]에서 재현되지 않은 숫자:
- §3.4 "own-calendar에 런 300개" → Actions API `total_count` **1,889**.
- §3.4 "무결성 런 33개 중 19개 취소" → **237개 중 108개**.
- §3.3 "게이트 RED 28 · 플랜 계약 실패 31" → own-calendar 기록에서 `FACTORY_GATES … status=RED` 13줄(창 안 9), 플랜 계약으로 멈춘 런 4,
  `plan repair` 15줄, `dissent without done_when` 12줄. 어떤 셈법으로도 28·31은 나오지 않았다.
- §3.2 역할별 비용은 progress 마커 합이다(과대 계상되는 값). 세션 수는 위 Part A·C의 값과 일치한다.
- 일치한 것: 159런/$479, 84런/$155, self-gate 12, 검증자 6, 워크트리 5.

## Sources

1. `LeeHyeonKyu/own-calendar` `origin/factory/records` (f66d8de, 2026-09-28 23:22 +0900) `docs/factory/runs/*.md`, `_retro.md`
2. `LeeHyeonKyu/know-thy-build-demo` `origin/factory/records` (02c8519, 2026-09-28 11:57Z) 같은 경로
3. `docs/factory/handover/2026-09-29-factory-efficiency.md` — L12–L40 표(§7). 숫자는 전부 다시 셌다
4. `.superpowers/sdd/2026-09-27-own-cal-campaign/progress.md` — 캠페인 원장
5. GitHub Actions API(읽기 전용): `repos/LeeHyeonKyu/own-calendar/actions/runs?created=2026-09-26T15:40:00Z..2026-09-28T14:05:00Z`(1,889런),
   비-skipped 562런의 `/jobs`; 데모는 같은 창의 `total_count`
6. GitHub Issues API(읽기 전용): 두 저장소의 `issues/comments` 중 `factory-transition:v1` 마커
7. `docs/factory/DECISIONS.md` — ADR-002·008·009·010·011·014·015·017·019·020(KTB-5~51)·021·022·023·024·025·027·028·029·030·031
8. 엔진 소스: `factory/bin/run-stage.js`, `factory/lib/{verify-stage,gates,self-gate,mutation-check,prove-test,merge-stage,transition,requirements,sweeper,claim,budget,back-pressure,integrity,qa-evidence,review-quorum,context,heartbeat,records-branch,rehearsal}.js`, `factory/hooks/*.sh`
9. 워크플로·프롬프트: `templates/factory/claude/workflows/factory-{triage,plan,implement,review,retro}.js`, `templates/factory/claude/agents/{factory-verifier,reviewer-spec-conformance}.md`, `templates/factory/github/workflows/*.yml`, `templates/factory/claude/settings.json`

## 부록 - 스크립트

기록 내보내기(작업 트리를 건드리지 않는다 — `git show`만 쓴다):

```sh
OUT=/tmp/ktb-rec
for repo in own-calendar know-thy-build-demo; do
  mkdir -p "$OUT/$repo"
  for f in $(git -C "/Users/hk/workspace/$repo" ls-tree --name-only origin/factory/records docs/factory/runs/); do
    git -C "/Users/hk/workspace/$repo" show "origin/factory/records:$f" > "$OUT/$repo/$(basename "$f")"
  done
done
python3 classify.py "$OUT" own-calendar know-thy-build-demo   # 표를 출력하고 $OUT/classified.json을 쓴다
```

`classify.py`:

```python
#!/usr/bin/env python3
"""Classify every stage run in factory/records run records.
usage: classify.py <dir-with-exported-records>/<repo>/<n>.md ...   (see export step in the report)
A stage run = all sections of one issue file sharing (stage, runner-id)."""
import re, sys, os, glob, json, collections
HDR = re.compile(r'^## (\S+) · (\S+) · (\S+)\s*$')
FWD = {'triage': 'factory:ready', 'plan': 'factory:planned', 'implement': 'factory:awaiting-review',
       'review': 'factory:approved', 'merge': 'factory:merged'}
COMMAND_GATES = {'lint', 'typecheck', 'build', 'unit', 'integration', 'e2e'}

def runs(root, repo):
    out = []
    files = [f for f in glob.glob(f'{root}/{repo}/*.md') if re.search(r'/\d+\.md$', f)]
    for f in sorted(files, key=lambda p: int(os.path.basename(p)[:-3])):
        issue = int(os.path.basename(f)[:-3]); cur = None; order = []; by = {}
        for line in open(f, encoding='utf-8'):
            line = line.rstrip('\n'); m = HDR.match(line)
            if m:
                key = (m.group(1), m.group(3))
                if key not in by:
                    by[key] = dict(repo=repo, issue=issue, stage=m.group(1), runner=m.group(3), ts=m.group(2), lines=[])
                    order.append(key)
                cur = by[key]; continue
            if cur is not None and line.strip(): cur['lines'].append(line)
        out += [by[k] for k in order]
    return out

def cost_of(r):
    c = 0.0; n = 0
    for l in r['lines']:
        if l.startswith('usage:'):
            m = re.search(r'cost_usd: ([0-9.eE+-]+)', l)
            if m: c += float(m.group(1)); n += 1
    return c, n

# Hand overrides for command-gate RED runs: whether the red test belongs to the change cannot be read
# from one record line, so each entry cites its evidence (gates-detail failing ids + campaign ledger).
OVERRIDE = {
    # demo #7: the builder's 5 s cache broke 4 existing integration tests (gates-detail failing ids; ledger 09-27 "demo #7 (004)")
    'gha-36299260232': 'core: failing test of the change', 'gha-36303016403': 'core: failing test of the change',
    'gha-36304286104': 'core: failing test of the change', 'gha-36306727191': 'core: failing test of the change',
    'gha-36307267782': 'core: failing test of the change',
    # own-calendar #45 / #50: tests/family.test.ts — an existing test the (test-only) change did not touch; ledger L28, flaky issue own-cal #90
    'gha-36308486399': 'test gate RED: pre-existing flaky test (not the change)',
    'gha-36349358790': 'test gate RED: pre-existing flaky test (not the change)',
    # own-calendar #52 (import.test.ts test_48, 401 vs 500), #90 (auth.test.ts register 200 vs 201), #3 (lint,new-test-repeat, no gates-detail)
    'gha-36368153198': 'test gate RED: cause undetermined', 'gha-36415669773': 'test gate RED: cause undetermined',
    'gha-34846505911': 'test gate RED: cause undetermined',
}

# Verifier rejections whose finding was produced by the verifier's tool, not by the change: the prove-test CLI
# did not know characterization mode (L16) and the queued run executed a stale engine (L20) — self-gate-detail
# ktb_version 1.4.12 on all three; ledger 09-26 "L16", "L20", "#29 rejected again".
VERIFIER_TOOL = {'gha-36268782105', 'gha-36268790640', 'gha-36268772577'}

def classify(r):
    k, d, w = _classify(r)
    if r['runner'] in OVERRIDE and d.startswith('test gate RED'): return (k, OVERRIDE[r['runner']], d + ' | ' + w)
    if r['runner'] in VERIFIER_TOOL and d == 'core: verifier rejection':
        return (k, 'prove-test CLI read by the verifier (L16) on a stale queued engine (L20)', w)
    return (k, d, w)

def _classify(r):
    L = r['lines']; st = r['stage']
    has = lambda p: next((l for l in L if l.startswith(p)), None)
    anyre = lambda rx: next((l for l in L if re.search(rx, l)), None)
    trans = [l.split()[1] for l in L if l.startswith('transition: ')]
    if FWD[st] in trans: return ('ADVANCED', 'advanced', '')
    # --- pre-session stops (no LLM session started) ---
    l = anyre(r'^budget: .*REFUSED')
    if l: return ('STOP', 'budget(lifetime usd_per_issue)', l)
    l = has('claim refused:')
    if l: return ('STOP', 'claim lock', l)
    l = anyre(r'^entry state .*nothing to do')
    if l: return ('STOP', 'entry-state guard (redundant dispatch)', l)
    l = anyre(r'^entry state: (invalid|unreadable)')
    if l: return ('STOP', 'entry-state guard (label set invalid)', l)
    l = has('assert: FAIL')
    if l: return ('STOP', 'assertHandoff (prerequisite handoff)', l)
    l = anyre(r'^branch: FAIL — stale PR conflicts with base')
    if l: return ('STOP', 'stage branch checkout + base merge', l)
    l = has('overlay: FAIL')
    if l: return ('STOP', 'overlay / factory-config drift', l)
    l = anyre(r'^branch: FAIL — factory config changed')
    if l: return ('STOP', 'overlay / factory-config drift', l)
    l = has('checkout: FAIL')
    if l: return ('STOP', 'checkoutHead', l)
    l = has('qa evidence probe: FAIL')
    if l: return ('STOP', 'qa evidence probe', l)
    # --- post-session structural checks ---
    l = has('worktree: FAIL')
    if l: return ('STOP', 'worktree-clean check (no-write stage)', l)
    l = anyre(r'^gates: BLOCKED — test-env')
    if l: return ('STOP', 'test-env re-up', l)
    l = has('gates: BLOCKED')
    if l: return ('STOP', 'gates BLOCKED (undecidable)', l)
    l = anyre(r'^error: .*gh issue edit failed')
    if l: return ('STOP', 'GitHub API failure (label edit)', l)
    # --- verify FAIL family ---
    if has('verify: FAIL'):
        reasons = [x[2:] for x in L if x.startswith('- ')]
        joined = ' || '.join(reasons)
        term = None
        u = has('usage:')
        if u:
            m = re.search(r'terminal_reason: (\S+)', u); term = m.group(1) if m else None
        if re.search(r'api error \d+', joined) or term == 'api_error':
            return ('STOP', 'LLM API error / usage limit', joined[:200])
        if 'hit max turns' in joined or term == 'max_turns':
            return ('STOP', 'orchestrator session (max-turns / artifact extraction)', joined[:200])
        if 'roster role not completed' in joined and 'claude -p' not in joined:
            return ('STOP', 'roster completion check (no role session ran; cause not recorded)', joined[:200])
        if 'claude -p reported is_error' in joined or 'no candidate matched' in joined or re.search(r'schema \w+\.v1', joined):
            return ('STOP', 'orchestrator session (max-turns / artifact extraction)', joined[:200])
        if re.search(r'dissent without done_when|done_when has \d+ items|guard-shaped done_when|acceptance contract incomplete', joined):
            return ('STOP', 'plan contract validator', joined[:200])
        m = re.search(r'gates (RED|MISCONFIGURED): failing=(\S+)(?: misconfigured=(\S+))?', joined)
        if m:
            failing = set(x for x in m.group(2).split(',') if x != 'none')
            mis = set(x for x in (m.group(3) or '').split(',') if x and x != 'none')
            allg = failing | mis
            details = [x for x in L if x.startswith('gates-detail:')]
            if any('"code":127' in d or 'command not found' in d for d in details):
                return ('STOP', 'runner toolchain (gate command not found)', joined[:200])
            if allg & COMMAND_GATES:
                return ('STOP', 'test gate RED (command gate: ' + ','.join(sorted(allg & COMMAND_GATES)) + ')', joined[:200])
            if 'prove-test' in allg:
                d = next((x for x in details if '"gate":"prove-test"' in x), '')
                sn = re.search(r'"snippet":"(.{0,110})', d)
                return ('STOP', 'prove-test', (m.group(1) + ': ' + (sn.group(1) if sn else 'no gates-detail recorded')))
            if 'new-test-repeat' in allg: return ('STOP', 'new-test-repeat', joined[:200])
            if 'must-not' in allg: return ('STOP', 'must_not contract gate', joined[:200])
            return ('STOP', 'proof gate (' + ','.join(sorted(allg)) + ')', joined[:200])
        if 'roster role not completed' in joined:
            return ('STOP', 'roster completion check', joined[:200])
        return ('STOP', 'verify FAIL (other)', joined[:200])
    l = anyre(r'^self-gate: .*BLOCKED')
    if l:
        if 'mutation:' in l: return ('STOP', 'self-gate: mutation check', l[:220])
        if 'contract:' in l: return ('STOP', 'self-gate: qa contract (removed, Defect A)', l[:220])
        if 'pin' in l: return ('STOP', 'self-gate: regression pins', l[:220])
        return ('STOP', 'self-gate (other)', l[:220])
    l = anyre(r'^(verifier: rejected|transition refused: verifier rejected)')
    if l: return ('STOP', 'core: verifier rejection', l[:220])
    l = anyre(r'^transition refused: implement head_sha')
    if l: return ('STOP', 'head_sha binding (post-handoff drift)', l)
    l = anyre(r'^transition refused: gates file status is')
    if l: return ('STOP', 'review-stage gate re-run (approved requires GREEN)', l)
    l = has('aborted: cancelled') or has('aborted: timed_out')
    if l and not has('stage-settled'): return ('STOP', 'job timeout / cancel', l)
    # --- merge stage ---
    if st == 'merge':
        for rx, dev in [(r'review verification failed — review round', 'merge: review quorum/K re-check'),
                        (r'review verification failed', 'merge: review-evidence binding'),
                        (r'prReady FAIL', 'GitHub API failure (merge: gh pr ready)'),
                        (r'mergePr FAIL .*still a draft', 'merge-stage defect (draft not flipped)'),
                        (r'mergePr FAIL .*Required status check', 'integrity workflow (required check queued)'),
                        (r'existing tests modified or deleted', 'policy: tests_are_load_bearing (human merge)'),
                        (r'protected paths changed', 'protected paths (human merge)'),
                        (r'merge: gates (RED|MISCONFIGURED)', 'test gate RED (merge-stage re-run)'),
                        (r'mergeGates — ', 'integrity / required checks')]:
            l = anyre(rx)
            if l: return ('STOP', dev, l[:220])
    # --- transitions that are not forward ---
    if st == 'review' and 'factory:rework' in trans:
        q = anyre(r'^qa evidence incomplete')
        return ('REWORK', 'core: reviewer must_fix -> rework' + (' (+qa-evidence shortfall)' if q else ''), '')
    if st == 'review' and 'factory:needs-human' in trans:
        return ('STOP', 'core: reviewer must_fix at K limit -> needs-human', '')
    if st == 'triage' and 'factory:wont-do' in trans:
        return ('STOP', 'NEVER_AUTOMATE (script override)' if has('never_automate_hit') else 'triage disposition', '')
    if st == 'triage' and 'factory:needs-info' in trans:
        return ('STOP', 'triage disposition (needs-info)', '')
    if st == 'implement' and 'factory:needs-info' in trans and anyre(r'^harness: (opened|reusing)'):
        return ('STOP', 'harness-request parking', has('harness:'))
    l = anyre(r'^transition refused:')
    if l: return ('STOP', 'transition requirement (other)', l)
    l = has('aborted:')
    if l: return ('STOP', 'job timeout / cancel', l)
    return ('STOP', 'UNKNOWN', ' | '.join(x[:60] for x in L[:4]))

if __name__ == '__main__':
    root = sys.argv[1]; repos = sys.argv[2:]
    allrows = []
    for repo in repos:
        for r in runs(root, repo):
            kind, dev, why = classify(r); c, n = cost_of(r)
            allrows.append(dict(repo=repo, issue=r['issue'], stage=r['stage'], runner=r['runner'], ts=r['ts'], kind=kind, device=dev, why=why, cost=c, has_usage=n > 0))
    json.dump(allrows, open(os.path.join(root, 'classified.json'), 'w'), ensure_ascii=False, indent=1)
    for repo in repos + ['ALL']:
        rows = [x for x in allrows if repo == 'ALL' or x['repo'] == repo]
        print(f'\n##### {repo}: runs={len(rows)} cost=${sum(x["cost"] for x in rows):.2f}')
        bystage = collections.defaultdict(lambda: [0, 0.0, 0])
        for x in rows:
            b = bystage[x['stage']]; b[0] += 1; b[1] += x['cost']; b[2] += x['kind'] == 'ADVANCED'
        for s, b in bystage.items(): print(f'  stage {s}: runs={b[0]} advanced={b[2]} cost=${b[1]:.2f}')
        agg = collections.defaultdict(lambda: [0, 0.0, [], 0])
        for x in rows:
            a = agg[(x['kind'], x['device'])]; a[0] += 1; a[1] += x['cost']; a[2].append(x['issue']); a[3] += (not x['has_usage'])
        for (k, d), a in sorted(agg.items(), key=lambda kv: (kv[0][0], -kv[1][0])):
            iss = ','.join(f'#{i}' + (f'x{a[2].count(i)}' if a[2].count(i) > 1 else '') for i in sorted(set(a[2])))
            print(f'  {k:8} | {d:62} | runs={a[0]:3} | ${a[1]:7.2f} | no-usage-line={a[3]:2} | {iss}')
```
