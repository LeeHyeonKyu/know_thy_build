# Research: S4 플랜 삼각토론 (2026-10-02)

Date: 2026-10-02
Question: `docs/superpowers/plans/2026-10-02-s4-autonomous-engine-merge.md` 초안의 열린 질문 4개 — (1) 거부권 창 재진입, (2) 회로차단기 신호,
(3) 시드 위치, (4) 3분할 — 과 근본 결함. 1라운드, 에이전트 3(PRO/NEUTRAL/CON, sonnet, 읽기 전용).

## Findings

| 쟁점 | PRO | NEUTRAL | CON | 반박 생존 | 결정 |
|---|---|---|---|---|---|
| 판정자/비판정 **분류 방식** | 기존 fail-closed 패턴 재사용이면 된다 | (직접 다루지 않음) | **글롭 허용목록이 샌다**: `gh.js`(`resolveFactoryLogins` → `verifyFactoryStatuses`의 `known`), `config.js`(CHARTER 파서 → `d.selfChange`), `sweeper.js`(재진입)가 목록에 없다 — 판정의 **입력**을 만드는 비목록 파일이 자동 머지된다 | ✅ CON | **방향을 뒤집는다.** 판정자 경로를 열거하지 않고 **비판정 경로를 양의 목록으로** 적는다(기본값 = 사람). 목록은 관측·문서 모듈뿐. 그리고 **import-closure 테스트**: 판정 모듈(merge-stage·integrity·gates·requirements·self-gate·admission·transition·labels·run-stage)의 import 닫힘에 양의 목록 파일이 하나라도 들어오면 테스트 RED |
| (1) 거부권 창 재진입 | stalled 팔 재사용 — dedupe 관용구 있음 | **`STALLED_RESTART_LIMIT = 2`(sweeper.js:77)와 60분/30분 cron이 정확히 겹친다** — 정상 대기가 "진짜 정지"로 오판·예산 소진 | 비판정 파일(`sweeper.js`)에 재진입을 맡기면 조용히 죽는다(sweeper.js:956-965 자기 경고) | ✅ NEUTRAL·CON | **merge 잡 안에서 기다린다.** KTB는 호스티드 러너(공개 저장소, 무료)라 점유 비용이 없다. `factory-merge.yml`의 `timeout-minutes`를 merge에 한해 90으로(사람 머지 1회). 5분 간격으로 `factory:veto` 라벨 폴링. 창의 시작은 status `created_at`(러너 기록) |
| (2) 회로차단기 신호 | 전이 비율은 이미 러너 기록 — 집계만 | 오늘 계산 가능한 것은 전이 비율뿐(revert 탐지·채택 저장소 health는 인프라 없음) | N=5는 통계적으로 무의미, 사후 경보일 뿐 | ✅ 부분(CON) | 전이 비율로 시작하되 **2차 방어선**으로 격하. 창 표본 < 3이면 평가 보류(PRO의 고정). 1차 방어선은 양의 목록 + 잡 내 거부권 + 시드 카나리 |
| (3) 시드 위치 | 저장소 안 + NEVER_AUTOMATE + 프롬프트 미게재 | 별도 비공개 저장소가 싸고 격리가 물리적 | 위치가 아니라 **자기 채점**이 문제 — PR head의 새 엔진으로 시드를 판정 | ✅ CON(자기 채점) | 저장소 안(`factory/seeds/**`, NEVER_AUTOMATE). 자기 채점 문제는 양의 목록이 집행 코드(integrity·gates·policy)를 **아예 비판정에서 제외**하므로 카나리의 역할이 "집행 코드의 간접 파손 감지"로 좁아져 수용. 별도 저장소는 S7(App 귀속)과 함께 재검토 — dissent 기록 |
| (4) 3분할·행동 보존 | 300–600줄은 실증된 리뷰 크기, 바이트 동일성은 리뷰 관용구 | 분할이 맞다(#143 전례), 단 S4 자신은 자동 머지 혜택 없음 | 세 PR로 나누면 합성 공격면을 아무도 한 번에 못 본다 | ✅ 부분(CON) | 분할 유지. 합성 공격면은 **S4a의 import-closure 테스트 + 양의 목록이 작다**는 두 가지로 기계적으로 닫는다 — 리뷰어의 눈에 기대지 않는다 |
| 급진 대안: 섀도 머지 | — | — | 비판정 PR을 `factory/shadow`에만 머지, 다음 실제 이슈가 그 위에서 통과하면 ff | ❌ | 기각. 스테이지는 base 엔진으로 돈다(ADR-023) — shadow를 base로 삼으면 판정받는 엔진이 자기를 판정하는 바로 그 문제가 되고, 엔진 이슈가 없으면 머지가 무기한 밀리며 채택 저장소는 main에서만 릴리스를 받는다 |

## 결정 요약
1. `factory/lib/judge-paths.js` → **`non-judge-paths.js`**: `NON_JUDGE_GLOBS`(양의 목록) = `docs/**`(단 `docs/factory/CHARTER.md` 제외), `docs/factory/ops/**`, `templates/factory/docs/**`,
   `factory/lib/{board,board-static,progress,usage,heartbeat,agents-log,status,aggregate}.js`, `factory/bin/{board,scrub-artifacts,timeline}.js`와 그 `.factory/` 미러, `factory/test/` 중 위 모듈의 테스트.
   `classifyProtected(files, {engine}) → { non_judge, judge }`; 목록 밖은 전부 judge. `engine=false`면 전부 judge.
2. import-closure 테스트(S4a done_when): 판정 모듈 집합의 정적 import 닫힘 ∩ 양의 목록 = ∅.
3. 거부권 창은 merge 잡 안에서 대기(최대 `veto_minutes`, 기본 60; 5분 폴링). sweeper에 의존하지 않는다. `factory-merge.yml` timeout은 사람이 올린다.
4. 회로차단기는 2차 방어선, 표본 하한 3.
5. 시드는 저장소 안, NEVER_AUTOMATE, 프롬프트 미게재. dissent: NEUTRAL(별도 저장소).
6. 3분할 유지: S4a(양의 목록 + closure 테스트 + 잡 내 거부권 + CHARTER 스위치 off) → S4b(시드 카나리) → S4c(차단기 + 리셋 CLI).

## Rounds
- Round 1만. 핵심 긴장: "경로 글롭 분류가 안전 경계인가"(CON) vs "기존 장치 재사용"(PRO). CON의 `gh.js`·`config.js` 누락과 NEUTRAL의 `STALLED_RESTART_LIMIT` 충돌은 코드 줄로 확인되는 사실이라 추가 라운드 없이 결정.

## Sources
1. `factory/lib/merge-stage.js:58-77, 275-310` — `verifyFactoryStatuses`, `handToHuman`
2. `factory/lib/sweeper.js:77, 350-408, 956-965` — `STALLED_RESTART_LIMIT`, `sweepStalled`, `sweepHumanMerged` 자기 경고
3. `factory/lib/gh.js:105` — `resolveFactoryLogins`
4. `docs/superpowers/specs/2026-09-30-explicit-submission-and-self-change.md` §8.2–8.4
5. `docs/factory/DECISIONS.md` 1.4.36–1.4.42
