# Handover — 팩토리 효율화 (병목·시간·토큰 절감) — 2026-09-29

이 문서는 2026-09-26 ~ 09-28 도그푸드 캠페인(own-calendar 18건, 데모 10건 머지, KTB 1.4.13 → 1.4.32)에서 얻은 사실을
다음 작업 — **팩토리 자체의 병목과 과도한 시간·토큰 사용을 줄이는 일** — 에 넘기기 위해 쓴다. 숫자는 전부 러너가 기록한
`usage:` 줄(`factory/records` 브랜치)과 GitHub API에서 뽑았고, 컨트롤러 비용만 트랜스크립트 토큰 수로 추정했다.

## 1. 한 장 요약

| 항목 | 값 |
|---|---|
| 기간 | 46시간(09-26 15:40Z → 09-28 14:04Z) |
| 머지 | own-calendar 18(공장 16 + 사람 2), 데모 10 |
| 공장 비용 | own-calendar $479 / 159 스테이지 런, 데모 $155 / 84 런 → 28건에 $634, own-calendar 건당 $20 |
| 컨트롤러(운영 세션) | 1,463턴, 출력 1.9M·캐시 읽기 881M 토큰 ≈ $1,800(정가 추정) — 공장의 약 3배 |
| 이슈 리드타임 | own-calendar 13–38시간(단일 self-hosted 러너, 직렬), 데모 4–9시간(hosted, 병렬) |
| KTB 변경 | 수정 PR 22 + 릴리스 20, 엔진 +749/−66, 테스트 +740, 한계 L12–L40 |

가장 큰 낭비 셋: **(1) 단일 러너 직렬화**(시간), **(2) 결함 루프 — 결함 하나가 영향받는 이슈마다 스테이지 런 1–3개를 태운 뒤에야
수정이 배포됨**(토큰), **(3) 리뷰 라운드 단가 $6–13 × 4–5명 리뷰어**(토큰). 컨트롤러 쪽은 **짧은 상태 확인 턴의 반복**이
캐시 읽기 비용을 만들었다.

## 2. 지금 상태 (2026-09-29 04:00Z)

- npm `know-thy-build@1.4.32`; own-calendar·데모 모두 1.4.32. 프로덕션 own-calendar postgres는 이 Mac의 compose 프로젝트
  `server`로 상주(2일째 정상) — **테스트 compose와 절대 섞지 말 것**(`[[own-calendar-prod-on-this-mac]]`).
- 열려 있는 것: KTB #41(self-dogfood 설계), **#122·#123·#124**(건강 잡: architecture·correctness·security 리뷰어가 승인만 하고
  결함은 뒤 라운드에서 잡힘 — 로스터 축소의 실측 근거), own-calendar #66(#9 회고가 만든 하네스 요청, M2 머지로 해소된 듯 —
  확인 후 닫기), 데모 #98(캐시 후속, 백로그).
- 소유자 결정(09-28): build.yml은 태그·수동만; 아티팩트 3일 보존; flaky 테스트는 공장이 고침(둘 다 머지됨); 데모 유지.
- 운영 제약: 러너 `hk-mac`(launchd, `kickstart` 필요, busy=false일 때만 재시작); 옵저버는 런을 취소하지 않는다; 시크릿은
  사용자만 등록; 머신 유저 `bot-hk` = 팩토리 신원, `FACTORY_MERGE_TOKEN` 두 배우; 계정 아티팩트 쿼터가 가끔 차서 업로드가
  실패하지만 판정에는 영향 없음; 데모는 공개 저장소라 hosted 러너 무료.

## 3. 어디에 시간과 돈이 갔나

### 3.1 스테이지별(own-calendar, 46 h)

| 스테이지 | 런 | 비용 | 런당 |
|---|---|---|---|
| implement | 63 | $200 | $3.2 |
| review | 32 | $182 | $5.7 |
| plan | 23 | $90 | $3.9 |
| triage | 24 | $8 | $0.3 |
| merge | 17 | $0 | 스크립트 전용 |

데모(19.5 h): review 18런 $95, implement 35런 $49, plan $8, triage $2.

### 3.2 역할별(하트비트 progress 마커 합, 상대 비교용 — usage 줄 합계와 정확히 맞지 않음)

own-calendar: builder $328(88세션, 세션당 69턴) > reviewer-architecture $127 > verifier $113 > reviewer-correctness $106 >
reviewer-qa $85 > plan-skeptic $69 > reviewer-spec-conformance $57 > plan-architect $46 > plan-synthesizer $38.
데모: builder $132, reviewer-qa $99(세션당 81턴 — 증거 수집이 길다), correctness $67, architecture $52, spec-conformance $50.

### 3.3 실패 표식(own-calendar run 기록)

게이트 RED 28 · 플랜 계약 실패 31 · self-gate 차단 12 · 검증자 거부 6 · 워크트리 더티 5 · 낡은 엔진 실행 4.
비싼 이슈: #90 $61/8런(플랜 루프 L37–L39 + 75분 타임아웃 L38), #31 $58/16런(L12·L13·L16·L17 연쇄), #9 $44/10런(리뷰
3라운드 $33), #49 $43/11런(리뷰 라운드의 flaky L34, API 장애 L40), #45 $30/13런(L26·L28·L30·L31).

### 3.4 러너

47시간 동안 own-calendar에 런 300개가 생성됐다. 라벨 이벤트 하나가 스테이지 워크플로 다섯 개를 전부 띄우므로(GitHub이
라벨 이름 필터를 주지 않음) 전이마다 런 5개 중 4개는 `skipped`로 끝난다 — 러너 시간은 안 쓰지만 큐와 API 호출을 차지한다.
무결성 런 33개 중 19개가 취소(L21 이후 낡은 head 취소). 큐는 최대 20개, 리뷰 런이 55–90분 대기한 적이 있고, 대기한 런은
생성 시점 main의 엔진으로 돌았다(L20, 1.4.19에서 시작 시 갱신).

### 3.5 컨트롤러

1,463턴 중 Bash 871회. 출력 토큰(1.9M)보다 **캐시 읽기 881M**이 비용을 결정했다 — 긴 컨텍스트 위에서 짧은 상태 확인 턴을
반복한 결과다. 릴리스 체인 20회 × 약 15분 ≈ 5시간, 부하 타임아웃으로 체인 재시작 3회.

## 4. 병목 진단 (근거 포함)

1. **단일 self-hosted 러너의 직렬화** — $20짜리 이슈가 하루 넘게 걸린 직접 원인. 스테이지 런 159개가 한 줄로 섰고, 무결성·
   회고·리허설·스위퍼 런이 같은 줄에 섞였다. 효과: 리드타임, 그리고 낡은 엔진 실행(L20)으로 결함 수정의 효과가 한 바퀴 지연.
2. **결함 루프의 단가** — 결함 하나 = 영향 이슈당 $8–13 스테이지 런 1–3개. 뮤테이션 오탐(L31) 하나가 서버 이슈 5건의 첫
   구현 턴을 잃게 했고, 플랜 계약 루프(L37·L39)는 #90에 $35를 태웠다. 결함 자체보다 **결함이 드러나는 데 든 런**이 비용이다.
3. **리뷰 단가** — 리뷰어 4–5명 × 라운드, 라운드당 $6–13. K=3 소진 5건(#76 #87 #7 #9 #49) 전부 사람 결정으로 끝났다.
   건강 잡의 KTB #122–124가 "승인만 하는 리뷰어" 셋을 실측으로 짚었다 → 로스터 축소의 근거.
4. **플랜 단가** — load-bearing 등급은 역할 5 × 라운드 3이 75분 타임아웃에 걸렸다(L38). own-calendar는 CHARTER
   `plan_rounds.default`를 2로 낮췄다(효과 확인됨: #91·#100 플랜 통과).
5. **컨트롤러 폴링** — 위 3.5.

## 5. 개선 후보 (예상 절감 순, 구체 메커니즘)

| # | 후보 | 예상 효과 | 어디를 고치나 | 위험 |
|---|---|---|---|---|
| A | **리뷰 로스터·라운드 축소**: standard 등급은 correctness + qa(+spec-conformance) 셋으로, architecture·security는 load-bearing에서만; light round 2 유지, K=2 | 리뷰 비용 30–40%(own-calendar $182 → ~$110) | CHARTER `roster`(도그푸드 저장소), 템플릿 CHARTER 기본값, `docs/factory/DECISIONS.md` ADR | 결함 누락 — KTB #122–124의 "승인만 하는 역할"부터 빼면 위험이 낮다 |
| B | **플랜 단가**: `plan_rounds.default` 2를 템플릿 기본으로; docs/테스트 전용 이슈는 `single` 모드(플래너 1 + 스켑틱 1) | 플랜 비용 40%(+타임아웃 제거) | 템플릿 CHARTER, `factory-plan.js`의 mode 선택(test-only diff·docs tier → single) | 계획 품질 — 테스트 전용 이슈에는 충분 |
| C | **결함 노출 비용 절감**: (1) 스테이지 시작 전 `factory rehearse`급 사전 점검을 넓혀 `[test.env]`·리포트·툴체인 락을 리허설 표에 넣기, (2) 자기 게이트/검증자 판정을 **같은 런 안에서** 한 번 더 돌리는 "저비용 재시도"(새 세션 대신 같은 세션에 finding을 되먹임) | 결함당 낭비 런 1–3 → 0–1 | `factory/lib/rehearsal.js`, `run-stage.js`의 self-gate retry 경로 | 같은 세션 재시도는 컨텍스트 오염 — 상한 1회 |
| D | **러너 처리량**: (1) 무결성 런을 push마다가 아니라 빌더 handoff 뒤 한 번만(스테이지 안에서 이미 무결성을 검사함 — 워크플로 트리거를 `pull_request: ready_for_review`/handoff 마커로), (2) 회고·건강·스위퍼를 hosted(공개 저장소) 또는 별도 러너 라벨로, (3) 라벨 fan-out 5개 중 4개를 `workflow_dispatch` 단일 진입점으로 대체(sweeper/transition이 스테이지 워크플로를 직접 dispatch — 이미 `dispatchStage`가 있음) | 큐 길이 절반 이하, 리드타임 30–50% | 워크플로 템플릿 5개의 `on:`, `transition.js`가 dispatch, `factory-integrity.yml` 트리거 | 이벤트 기반 자동 시작을 잃음 — dispatch 실패 시 sweeper가 잡아야 함 |
| E | **빌더 세션 길이**: 세션당 69턴·$3.7. 컨텍스트에 실리는 lessons·QA.md·TECHNICAL.md 전문을 요약본으로; `must_not`·`fixes_tests` 같은 기계 계약을 앞세워 탐색 턴을 줄이기; test_files 실행을 파일 단위로 제한(전체 스위트는 게이트가 돈다) | 구현 비용 20–30% | `factory-implement.js` 프롬프트·컨텍스트 조립(`context.js`) | 정보 부족으로 인한 재작업 |
| F | **qa 리뷰어 증거 수집**(데모 세션당 81턴) — 증거 매니페스트를 빌더의 self-gate 산출물에서 재사용, qa는 검증만 | qa 비용 절반 | `qa-evidence.js`, reviewer-qa 프롬프트 | 증거 위조 경계(ADR-024) 유지 필요 |
| G | **릴리스 리듬**: 수정 여러 건을 한 릴리스로(체인 15분), 스위트에서 hooks 제외는 이미 함; CI 스위트의 타임아웃 취약 테스트 정리 | 컨트롤러 시간 수 시간 | `release-ktb.sh`(스크래치), 테스트 타임아웃 | 결함 수정이 늦게 배포되면 낭비 런 증가 — 배치 크기 2–3 |
| H | **컨트롤러 폴링**: 이슈 상태 스냅샷을 턴마다 찍지 말고 감시 프로세스 하나가 종료 상태 변화만 알리게(현재 `watch-issues.sh`는 110분 창 + 정지 상태에서 즉시 종료); 스냅샷은 마무리 보고 때만 | 컨트롤러 캐시 읽기 절반 이하 | 운영 스크립트 | 없음 |
| I | **이슈 평생 예산**을 등급별로(`usd_per_issue` docs 20 / standard 60 / load-bearing 100) + **스테이지 단가 상한** `usd_per_stage`(이미 있음, 미설정) | 폭주 조기 차단 | CHARTER, `lib/budget.js` | 정상 작업의 조기 차단 — 현재 실측 건당 $20 기준으로 여유 있음 |

권장 순서: **A·B(설정만으로 즉시, 저위험) → H·G(운영) → D(러너) → C·E·F(엔진)**. A·B는 own-calendar CHARTER를 먼저 바꾸고
한 배치(3–4 이슈) 돌려 리뷰/플랜 비용과 must_fix 누락률을 비교한 뒤 템플릿 기본값으로 올린다.

## 6. 측정 방법 (다음 작업의 전/후 비교)

- 스테이지·이슈별 비용: `factory/records` 브랜치의 `docs/factory/runs/<n>.md` → `parseRunRecord`(`factory/lib/usage.js`).
  캠페인용 집계 스크립트: `.superpowers/sdd/2026-09-27-own-cal-campaign/{retro.mjs,roles.mjs}`(스크래치 사본; 이 문서의 3.1–3.3).
- 역할별: run 기록의 마지막 `factory-progress:v1` 마커 `agents[]`.
- 실패 표식: 기록의 `gates-detail:`(RED·MISCONFIGURED 모두, 1.4.29부터), `self-gate-detail:`, `verify: FAIL`, `worktree: FAIL`.
- 러너: `gh run list --json workflowName,createdAt,updatedAt,conclusion`(startedAt은 비어 있음 — job 단위 `gh run view`가 필요).
- 컨트롤러: 세션 트랜스크립트 jsonl의 `message.usage`(입력/출력/캐시 토큰) 합.
- 건강 잡 보고서(own-calendar #17, 데모 #44, KTB #31): 리뷰어별 승인/누락 신호, 재큐 횟수.

## 7. 이번 캠페인에서 고친 한계 (L12–L40)와 비용 흔적

| L | 증상 | 수정(버전) |
|---|---|---|
| L12 | prove 워크트리에 새 테스트를 미추적으로 복사 → `git ls-files` 판정 불일치 | intent-to-add + Dart/Python 판정불가 패턴 (1.4.13) |
| L13/L25 | 빌더가 자기 파일을 단언하는 테스트로 "base 실패"를 제조; 주석 속 파일명까지 오탐 | 자기참조 검사, 주석 제외·파일/git 호출 줄만 (1.4.13/1.4.22) |
| L14 | NEVER_AUTOMATE 글롭이 "breaking change" 한정어를 무시 | doctor `charter.never-automate-qualified` + 템플릿 (1.4.13) |
| L11 | "do NOT" 산문이 계약이 아님 | 이슈 본문 `must_not:` 기계 검사, ADR-029 (1.4.14) |
| L16 | 검증자가 읽는 prove-test CLI가 특성화 모드를 모름 | `proveModeFor` 단일 규칙 + `mode` 출력 (1.4.14) |
| L17 | flutter 동시 실행(반복 게이트) → 둘 다 실패 | 락 툴체인은 순차 (1.4.15) |
| L18 | 기존 빨간 테스트 수정을 증명할 길 없음 | `fixes_tests:` + `proveFixedTests`, ADR-030 (1.4.15) |
| L19 | 이슈 평생 예산 없음 | `[budget].usd_per_issue`, ADR-031 (1.4.16) — #90에서 실제 발동 |
| L20 | 큐 대기 런이 생성 시점 엔진 실행 | 워크플로가 시작 시 origin/main으로 갱신 (1.4.19) |
| L21 | 낡은 head의 무결성 런이 큐를 막음 | PR 단위 concurrency 취소 (1.4.20) |
| L22 | 하네스 이슈 리뷰가 overlay/드리프트로 더티 | review에 하네스 모드 + 드리프트 재확인 (1.4.21/1.4.22) |
| L23 | qa 증거 도구가 cwd 기준으로 씀 | git 최상위 기준 (1.4.21) |
| L24/L29/L37/L39 | 플랜 dissent 계약: 대소문자, 되먹임 문구, 검증기가 본 사실, 워크플로 주입 note | (1.4.21/1.4.26/1.4.30/1.4.31) |
| L26 | 빌더 커밋 뒤 게이트 RED가 곧장 사람 | 유계 재시도 1회 (1.4.23) |
| L27 | node_modules 툴 캐시가 리뷰를 더티로 | 클린 검사 제외 (1.4.24) |
| L28 | integration 게이트에 리포트 없음 → 실패 이름 없음 | doctor WARN + 템플릿; own-calendar 하네스 리포트 (1.4.25) |
| L30 | 사람 재시도 뒤에도 옛 self-gate 마커가 backstop을 채움 | 창을 마지막 사람 전이부터 (1.4.27) |
| L31 | 테스트 전용 diff에 뮤테이션 검사 → 항상 생존자 | 특성화 diff는 생략 (1.4.28) |
| L33/L34/L35 | 게이트 RED를 엔진 결함으로 오라우팅; 리뷰 라운드 flaky 미재분류; MISCONFIGURED 사유 미기록 | (1.4.29) |
| L36 | 새 모듈 임포트 오류를 판정불가로 | 확장자 없는 stem 매치 (1.4.30) |
| L38 | 플랜 75분 타임아웃(역할 5×라운드 3) | own-calendar `plan_rounds` 2 |
| L40 | merge 단계 정지는 사람 재시도로 재개 불가 | blocked(origin=approved)로 되돌려 sweeper가 merge 재점화 (1.4.32) |

## 8. 운영 절차와 스크립트

- 릴리스 체인: 스크래치 `release-ktb.sh <fix-pr> <branch> <version> "<subject>" "<title>" "<note>"` → admin 머지 → 릴리스 브랜치
  (`npm version`, 매니페스트 재생성) → publish 대기 → 태그 → `upgrade-repos.sh <version>`(스크래치 클론 `upgrade-<repo>`에서
  `factory init --upgrade` → PR → admin 머지). 체인이 도는 동안 KTB 작업 트리를 건드리지 말 것. 함정: `npm view`가 보여도
  tarball은 몇 분 뒤에 열린다(`npm pack`으로 확인); 실패한 시도가 남긴 로컬 `chore/ktb-<V>` 브랜치는 지우고 시작.
  자세한 것은 메모리 `[[ktb-release-chain]]`.
- 사람 재시도: `node .factory/bin/transition.js <n> --human --retry --reason …`(스크래치 클론에서), 앞에
  `<!-- human-decision:v1 … -->` YAML 코멘트. wont-do·approved에서는 relabel/hand-merge가 필요했음(L40 이후 approved는 재시도 가능).
- 감시: `.superpowers/sdd/2026-09-27-own-cal-campaign/watch-issues.sh <repo> <min> <issues…>`.
- 정본 기록: `.superpowers/sdd/2026-09-27-own-cal-campaign/progress.md`(시간순 원장), `retro.md`(수치), `docs/factory/DECISIONS.md`
  ADR-029~031 + 1.4.13~1.4.32 노트, 메모리 `campaign-retro-2026-09`, `sdd-cost-policy`, `self-hosted-runner-own-calendar`.
EOF
echo written