# 명시적 제출과 엔진 자기 변경 — 설계 초안 (ADR-032 후보)

Date: 2026-09-30
Status: **v2 — 삼각토론(1라운드) 뒤 개정.** §8이 §2.2·§3·§4·§6을 덮어쓴다. 토론 기록 `docs/research/explicit-submission-debate.md`. 소유자 방향(2026-09-30): "큐에 넣는 것은 명시적으로 설계된 job의 제출이고, 제출자는 사람이
아니어도 된다 — 다른 에이전트도, 공장 자신도. 엔진 변경도 공장이 스스로 한다. 그 위에 self-improving을 올린다."
근거: `docs/research/autonomous-queue-and-self-change.md`(이하 R), `docs/research/simulation-105.md`.

## 1. 바꾸는 것과 바꾸지 않는 것

| | 지금 | 이 설계 |
|---|---|---|
| 큐 진입 | 코드상 평범한 엣지지만 스킬이 `--human`을 요구해 사실상 사람 전용 (R C.0) | **귀속된 주체의 명시적 제출.** `by=person:<login>` / `agent:<login>` / `factory:<job>` |
| 통제의 근거 | 주체가 사람인가 | job의 **형식** + **상한**(예산·동시 작업·리허설·자동화 금지) |
| `needs-human` 재시도 | 사람 전용 | **그대로 사람 전용.** 멈춘 것을 푸는 손은 멈춘 주체가 아니어야 한다 (R C.4) |
| 보호 경로 머지 | 사람 | 엔진 경로(`factory/**`, `.factory/**`, `templates/**`, `.claude/**`)는 **카나리 GREEN + 머지 배우 + 거부권 창**. 나머지 보호 경로는 그대로 사람 |
| 사람의 역할 | 매 결정의 실행자 | 상한을 정하는 사람, 거부권, 멈춤 해제 |

## 2. 제출(submission)

### 2.1 job의 형식 — 무엇이 "명시적으로 설계된" 것인가
큐 진입 요구조건(`requirements.js`에 `factory:queue` 규칙 신설, 지금은 규칙 없음 R C.1):
1. 본문에 `## done_when` 초안이 있거나 `factory-improvement`/`factory:harness` 마커가 있다.
2. Impact paths가 CHARTER NEVER_AUTOMATE 글롭에 걸리지 않는다 (지금은 triage 뒤에야 검사 — 앞으로 당긴다, L47과 같은 방향).
3. 리허설 GREEN (지금 그대로, `transition.js:73`).
4. back-pressure: `awaiting_review < max` (지금은 claim 시점만 — 큐 진입에도 건다).
5. 제출자 종류별 상한(§3)을 넘지 않는다.

### 2.2 귀속 — `by=`는 주장이고 계정이 사실이다
- 전이 마커: `<!-- factory-transition:v1 from=backlog to=factory:queue by=<kind>:<login> run=<id> -->`.
- 검증 가능한 앵커는 코멘트의 `author`/`authorType`/`viaApp`(GitHub이 계정에 붙이는 값)과 러너의 `run=`이다.
  `person`은 코멘트 작성 계정이 팩토리 계정이 아닐 때만 인정(1.4.35 L43의 `queuedByPerson`과 같은 규칙).
  `factory`는 작성 계정이 팩토리 계정이고 `run=`이 실재하는 런일 때. 그 외는 전부 `agent`.
- **결함 수정(R C.1):** `commentsSinceCycleStart`(`issue-comments.js:444`)가 본문의 `by=human` 문자열만으로 재시작 창을
  리셋한다 — 작성 계정 검증을 넣는다. 에이전트가 코멘트로 회로를 리셋할 수 있는 구멍이다.
- triage는 `person`·`agent`·`factory` 모두를 "명시적 제출"로 읽는다(`[ready]`와 같음). 1.4.35 L43(사람만)을 이것으로 일반화한다.

## 3. 상한 — 없는 것을 만든다 (R C.2)

| 상한 | 값(초기) | 어디에 | 넘으면 |
|---|---|---|---|
| 저장소 주간 총지출 `[budget].usd_per_week` | own-calendar 150 / 데모 60 / KTB 100 | harness.toml `[budget]` (보호 경로) | 큐 진입 거부, 진행 중 스테이지는 살림 |
| 열린 자기생성 이슈 `self_generated.open_max` | 5 | CHARTER | 새 자기생성 이슈는 `backlog`에만(큐 진입 거부) |
| 머지 1건당 자기생성 이슈 `self_generated.per_merge_max` | 2 | CHARTER | 초과분은 코멘트로만 |
| 자기생성 세대 깊이 `self_generated.depth_max` | 1 | CHARTER | 자기생성 이슈가 낳은 이슈는 큐 진입 거부 |
| 엔진 변경 연속 실패 회로차단기 `engine.circuit_breaker` | 연속 2회 카나리 RED | records 브랜치 상태 파일 | 엔진 경로 이슈 큐 진입 거부. **해제는 사람만** |
| 실패한 엔진 변경 뒤 쿨다운 `engine.cooldown_hours` | 6 | 〃 | 〃 |
| 큐 진입 시 back-pressure | `awaiting_review_max`(4) | 기존 값 재사용 | 큐 진입 거부 |

상한 상수와 회로차단기 해제, 예산 인상은 사람만 바꾼다(R C.4): 판정 대상이 상한을 고치면 상한이 아니다.

## 4. 엔진 자기 변경 (R C.3, KTB #41)

1. **미러는 러너가 만든다.** implement 스테이지에서 빌더 종료 후·게이트 전에 `run-stage.js`가 `buildManifest` + `freshContent`로
   `.factory/{lib,bin,actions}/**`·`.claude/hooks/*.sh`만 재생성해 러너 이름으로 커밋한다. `init --upgrade`는 쓰지 않는다
   (`.claude/agents/*.md`의 additive 섹션을 덮는다 — 이번 세션에서 실측). 빌더 커밋에 그 경로가 들어 있으면 diff 0을 요구하고
   아니면 거부 — 러너 커밋 예외로 빌더 쓰기를 밀어 넣는 것을 막는다(R 잔여 위험 i).
2. **판정은 base의 엔진이 한다**(ADR-023 `OVERLAY_STAGES` 그대로). 새 엔진은 자기 PR을 리뷰·머지하는 데 쓰이지 않는다.
3. **카나리 = 배포 전 실전 1회.** PR head의 `.factory/**`로 데모 저장소에서 (a) `factory-rehearse`, (b) 실제 이슈 1건을
   triage→merge까지. 결과를 PR head sha에 `factory/canary` commit status로 박는다(`factory/rehearsal` status와 같은 기계).
4. **보호 경로 머지의 대체.** 엔진 경로에 한해 `merge-stage.js:297-312`의 `handToHuman`을
   "카나리 GREEN + 머지 배우 승인(ADR-021) + **거부권 창**"으로 바꾼다. 거부권 창은 `factory-merge` 환경의 wait timer(초기 60분)로
   구현하고, 그 사이 사람이 `factory:veto` 라벨을 붙이면 머지하지 않는다. 사람의 클릭이 **없어도** 진행된다 — 지금과 반대다.
5. **release·upgrade의 자동화.** main 머지 → publish(지금 그대로) → 배포 워크플로가 채택 저장소(도그푸드)에 업그레이드 PR을 열고,
   "KTB 배포 파이프라인이 만든 업그레이드 PR"에 한해 머지 배우가 거부권 창 뒤 머지한다.

## 5. 사람 전용으로 남는 것 (R C.4)
시크릿·PAT·App 설치, 브랜치 보호·룰셋·CODEOWNERS·환경 규칙, `.github/workflows/**`(agent PAT에 `workflow` 스코프 없음 — 물리적 벽),
CHARTER의 NEVER_AUTOMATE·`[protected]`·`[gates.thresholds]`·`[budget]`·자기생성 상한, 회로차단기 해제와 예산 인상, npm publish,
`needs-human`/`needs-info` 재시도.

## 6. 단계

| 단계 | 내용 | 산출물 |
|---|---|---|
| S1 | 귀속 `by=<kind>:<login>`, `commentsSinceCycleStart` 작성자 검증, triage가 모든 명시적 제출을 인정, `:issue`/`:next` 스킬이 `--human` 대신 플래그 없는 제출을 쓰게 | KTB PR (엔진 + 스킬) |
| S2 | 큐 진입 규칙(§2.1)과 상한(§3) | KTB PR + CHARTER/harness 키 (채택 저장소는 사람 머지) |
| S3 | 러너 미러 스텝 + 엔진 경로 PR이 KTB 자기 공장을 통과(#41 해소) | KTB PR, KTB 이슈 1건으로 실증 |
| S4 | 카나리 status + 거부권 창 + 엔진 경로 머지 대체 | KTB PR + `factory-merge` 환경 설정(사람) |
| S5 | release → upgrade PR 자동화 | KTB 워크플로(사람 머지) |
| S6 | self-improving: 회고·건강 잡의 `factory-improvement` 이슈가 §3 상한 안에서 스스로 큐에 들어감 | CHARTER 스위치 `self_generated.auto_queue: true` |

S1–S2는 사람의 개입 횟수를 즉시 줄인다. S3–S5는 엔진 변경의 사람 머지를 없앤다. S6은 그 둘이 한 배치 이상 안정된 뒤에만 켠다.

## 7. 잔여 위험 (R C.3)
- 카나리가 데모에서 GREEN이어도 채택자에서 깨질 수 있다 → 채택자 업그레이드도 거부권 창을 거친다(§4.5).
- 새 엔진이 머지되면 다음 이슈부터 판정자다. 판정 로직의 회귀는 카나리가 못 잡는다 → 회로차단기(§3)가 마지막 방어.
- 머지 배우 승인이 GitHub UI에서 사람 승인처럼 보인다(ADR-021 한계 3) → PR 본문에 `factory/canary` 링크와 "사람 승인 아님" 문구.
- 공유 계정 저장소에서는 person/agent를 구분할 수 없다(ADR-028 ⑥) → 그런 저장소는 `agent`로 읽는다(보수적).

## 8. v2 — 토론 뒤 개정 (2026-09-30)

### 8.1 귀속은 감사 기록이지 권한의 근거가 아니다 (§2.2 대체)
코멘트 작성 계정은 사람과 에이전트를 가르지 못한다: 소유자의 Claude 세션은 소유자 계정으로 쓰고, 스테이지의 빌더는 봇 계정과
실재하는 런 ID를 갖는다(CON 1, NEUTRAL 위협 모델). 그래서:
- `by=`는 제출자의 **자기 신고**다. CLI가 환경으로 채운다: `GITHUB_ACTIONS`+`GITHUB_RUN_ID` → `factory:run-<id>`,
  `CLAUDE_PROJECT_DIR` → `agent:<login>`, 둘 다 없음 → `person:<login>`. 위조로 얻는 권한이 없으므로(누구나 제출 가능) 위조 유인이 없다.
- 상한이 앵커하는 것은 `by=`가 아니라 **러너가 쓴 기원 마커**(`factory-improvement fp=… from=…`, 하네스·flaky 마커)와 이슈 작성 계정
  (봇 계정이면 자기생성)이다.
- `needs-human`/`needs-info` 재시도와 상한 변경은 그대로 사람 전용(훅 + CLI 자체 검사 + 사람의 셸).
- `commentsSinceCycleStart`의 `by=human` 문자열 리셋은 작성 계정 검증으로 막는다(구멍은 실재한다). 다만 그것도 소유자 세션의
  에이전트는 못 막는다 — 그 세션은 훅이 막는다. 주체별 GitHub App(CON 대안 ①)은 S7로 미룬다.

### 8.2 상한 (§3 대체)
| 상한 | 값(초기) | 비고 |
|---|---|---|
| 자기생성 주간 예산 `self_generated.usd_per_week` | 100 | 저장소 전체 예산이 아니다. 캠페인 실측은 46 h에 $479 — 저장소 주간 상한을 두려면 ≥ $1,000 |
| 열린 자기생성 이슈 `self_generated.open_max` | 5 | flaky·하네스 이슈도 센다(지금은 태어날 때 큐에 들어감 — 같은 규칙을 지나게) |
| 머지 1건당 `self_generated.per_merge_max` | 2 | |
| 세대 깊이 `self_generated.depth_max` | 1 | 개선→하네스→flaky 사슬을 한 세대로 센다 |
| 큐 길이 `back_pressure.queue_max` | 8 | 외부 에이전트의 큐 홍수. `awaiting_review_max`는 큐 길이가 아니다(NEUTRAL) |
| 회로차단기 | 카나리 RED 연속 2 **또는** 엔진 머지 뒤 N=5 창의 누락 결함·승인 편향 악화 | 원천은 Actions API 런 결과와 health 잡 출력. 해제는 사람만 |
| 쿨다운 | 6 h | |
예산의 출처는 CHARTER 프론트매터 하나다(ADR-031). 카나리 비용은 그 엔진 이슈의 평생 예산에 더한다. 실측 증식률(캠페인 28머지 →
자기생성 7 = 0.25/머지)에서 루프는 이미 수렴한다 — 개수 상한은 지문 드리프트 같은 결함에 대한 보험이다.

### 8.3 엔진 자기 변경 (§4 대체)
- **판정자 경로와 비판정 경로를 가른다.** 판정자 경로 = `.claude/agents/*.md`, `.claude/hooks/*.sh`, `.github/workflows/**`,
  `factory/lib/{requirements,gates,self-gate,merge-stage,transition,labels,protected-paths,review-quorum,integrity}.js`와 그 미러,
  `factory/test/**` 중 그것들의 테스트. 나머지 엔진 파일이 비판정 경로다.
- **지금 넣는 것(S3)**: 러너 미러 스텝(`buildManifest`+`freshContent`, diff 0 검사), base 엔진 판정(ADR-023 유지), 카나리 status
  (데모 리허설 + 데모 실전 1건) — 정보로만.
- **자동 머지(S4)는 비판정 경로에만**: 카나리 GREEN + **거부 시드 카나리** GREEN(테스트 삭제·훅 약화·`must_not` 위반의 알려진 결함 PR
  3건을 새 엔진이 전부 거부) + 엔진 내부 거부권 타이머(merge-stage가 status 생성 뒤 60분과 `factory:veto` 라벨 부재를 판정 — GitHub
  환경 타이머는 비공개 저장소에서 불가) + 머지 배우.
- **판정자 경로는 사람 머지 유지.** 해제 조건: 판정 회귀 검출기(거부 시드 + 사후 건강 신호)가 실제 회귀를 **한 번 이상 잡은 기록**.
- 시드 PR은 주기적으로 갱신하고 목록을 에이전트 컨텍스트에 싣지 않는다(시드도 학습 표적이 된다 — CON).

### 8.4 단계 (§6 대체)
| 단계 | 내용 | 선행 조건 |
|---|---|---|
| S1 | `by=<kind>:<login>` 자기 신고, `commentsSinceCycleStart` 작성자 검증, triage가 모든 명시적 제출을 인정(L43 일반화), 스킬이 플래그 없는 제출 사용 | — |
| S2 | 큐 진입 규칙(형식·NEVER_AUTOMATE·리허설·`queue_max`) + §8.2 상한 | S1 |
| S3 | 러너 미러 스텝, 카나리 status(정보), KTB 이슈 1건으로 #41 실증 | S2 |
| S4 | 비판정 경로 자동 머지 + 거부 시드 카나리 + 내부 거부권 타이머 + 회로차단기 | S3, 시드 PR 3건 |
| S5 | release → 채택자 업그레이드 PR 자동 생성(머지는 거부권 타이머 뒤 머지 배우, 워크플로 변경이 포함되면 사람) | S4 |
| S6 | 자기생성 이슈 자동 큐 | 판정 회귀 검출기가 회귀를 잡은 기록 |
| S7 | 주체별 GitHub App 귀속 | 소유자가 App 설치(사람 전용) |

## 8.5 v3 — 판정 경로의 자동 머지 (2026-10-03, 소유자 결정 — ADR-033)

§8.3의 "판정자 경로는 사람 머지 유지(해제 조건: 판정 회귀 검출기가 실제 회귀를 잡은 기록)"를 **바꾼다**. 2026-10-02의 실측: 사람에게 간 머지
요청은 전부 판정 경로 엔진 PR이었고(#158·#169·#172·#161), 그 PR들 안에 바로 "사람 요청을 없애는 수정"이 들어 있어 사람이 머지하기 전까지
효과가 없는 순환이었다. 검출기(S4b)는 S4a 뒤이고, 그 전까지 판정 PR마다 사람 머지가 계속된다.

**새 규칙.** 공장이 만든 PR은 경로가 판정이든 비판정이든 다음 조건을 **전부** 만족하면 공장이 머지한다:
1. 리뷰 **만장일치**(로스터 전원 approve — 판정 경로는 로스터가 load-bearing 5인) + 게이트 GREEN. 비판정 경로는 기존 정족수로 충분하다.
2. 거부권 창(`veto_minutes`, 기본 60) — merge 잡 안에서 기다리며 `factory:veto` 라벨을 폴링한다(S4a).
3. 회로차단기(S4c)가 닫혀 있다 — **판정 경로 자동 머지 뒤 revert가 연속 2회**면 열리고, 사람만 닫는다. 차단기가 없는 동안(S4c 전)은
   판정 경로 스위치를 켜지 않는다(CHARTER `self_change.auto_merge_judge: false`가 기본).
4. CHARTER 스위치: `self_change.auto_merge_non_judge`(S4a)·`self_change.auto_merge_judge`(S4c 뒤 소유자가 켠다).

**대가(소유자 수용).** 판정 코드의 회귀는 사후에 사람이 revert로 잡는다 — 모든 머지가 squash라 revert 1번이다. 시드 카나리(S4b)는 그대로
만든다 — 자동 머지의 조건이 아니라 차단기의 입력(§8.2)이 된다.

**바뀌는 것.** §8.3의 "판정자 경로는 사람 머지 유지" 문장과 §8.4 S4 행. S4a(#149)의 `classifyProtected`는 그대로 쓴다 — 판정/비판정이
머지 여부가 아니라 **요구 정족수(만장일치 vs 정족수)**를 가른다.
