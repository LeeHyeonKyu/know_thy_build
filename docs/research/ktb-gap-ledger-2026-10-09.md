# KTB 허점 원장 — 구조 검토 중 발견한 것들

최초 작성: 2026-10-09 · 대상: `LeeHyeonKyu/know_thy_build` @ `8c25a8e` (main, 2026-10-06)
관련 문서: `ktb-evaluation.md`(9/14 평가 — 여러 항목이 이미 수정됨), `multi-agent-methods-study.md`
저장: 2026-10-11 소유자가 운영 세션에 붙여 준 원문을 그대로 둔다(/goal "모두 해소"). 진행 상태는 `docs/factory/DECISIONS.md`와 이슈가 든다.

이 문서는 hk가 생각하는 구조를 하나씩 repo와 대조하면서 나온 허점을 쌓아 두는 원장이다. 검토가 이어지는 동안 계속 추가한다.

**읽는 법**
- ID는 영역별로 붙인다: **E** 진입·심사, **T** 트리거·실행, **B** 요금·플랫폼, **M** 멀티에이전트 구조.
- **확인 수준**: `재현` = 함수나 파서를 직접 돌려 확인 / `코드` = 코드를 읽어 확인 / `기록` = 실행 기록·저장소 문서의 수치 / `추론` = 구조에서 추론, 미검증.
- **심각도**는 내 판단이다(높음·중·낮음). hk의 의도에 따라 달라질 수 있는 항목은 "의도 확인"으로 표시했다.
- 경로는 설치본(`.factory/…`) 기준으로 적었다. 실제 수정은 소스(`factory/…`)와 템플릿(`templates/factory/…`)에 한다.

---

## 0. 한눈에 보기

| ID | 한 줄 요약 | 심각도 | 확인 | 상태 |
|---|---|---|---|---|
| E-1 | `factory run triage` 로컬 진입이 큐 심사를 건너뜀 | 중 | 코드 | 열림 |
| E-2 | 회고의 승격 이슈가 큐 라벨을 단 채 생성됨 (리허설·심사 둘 다 없음) | 중 | 코드 | 열림 |
| E-3 | 사람이 라벨을 직접 붙이면 심사 없이 triage까지 감 | 낮음 | 코드 | 열림 |
| E-4 | NEVER_AUTOMATE 글롭이 한정어를 못 읽어 범위가 넓게 막힘 | 중 | 재현 | 의도 확인 |
| E-5 | 본문 마커만 적으면 "공장이 만든 이슈"로 판정됨 | 낮음 | 재현 | 열림 |
| E-6 | Impact paths: 스킬 템플릿은 백틱 없음, 파서는 백틱만 읽음 | 중 | 재현 | 열림 |
| E-7 | 이슈의 `done_when` 초안과 plan 계약의 대응을 스크립트가 보지 않음 | 높음 | 코드·기록 | 의도 확인 |
| E-8 | 심사와 triage 사이 대기 시간 동안 조건이 바뀌어도 재확인 없음 | 낮음 | 추론 | 열림 |
| E-9 | 큐 전이를 거친 이슈는 전부 "명시적 제출"로 읽혀 CHARTER의 triage 기본값이 거의 쓰이지 않음 | 중 | 코드 | 의도 확인 |
| T-1 | "다시 돌려"가 네 갈래이고 `factory retry`는 아직 없음 | 중 | 코드 | 기존 인지 |
| T-2 | 라벨 이벤트 하나에 워크플로 다섯 개가 뜨고 넷은 skip | 낮음 | 기록 | 기존 인지 |
| T-3 | 이슈 하나를 끝까지 로컬로 돌리는 진입점이 없음 | 중 | 코드·추론 | 의도 확인 |
| T-4 | 스테이지 디스패처가 LLM 세션이라 단순 전달에서 실패함 | 중 | 코드·기록 | 열림 |
| B-1 | Actions가 막히면 복구 주체(sweeper)도 같이 멈춤 | 높음(조건부) | 코드·문서 | 열림 |
| B-2 | Free 플랜 private 저장소에서 환경 시크릿·사람 게이트를 못 씀 | 중 | 문서 | 열림 |
| B-3 | self-hosted 러너 과금이 "연기" 상태 | 관찰 | 문서 | 관찰 |
| B-4 | 아티팩트 저장 용량 초과 | 낮음 | 기록 | 완화됨 |
| M-1 | 리뷰 로스터·K 축소 근거가 KTB 자체 기록과 반대 | 중 | 기록(집계) | 열림 |
| M-2 | 리뷰 R2 교차검토가 판정을 뒤집는지 잴 수 없음 | 중 | 코드 | 열림 |
| M-3 | KTB의 load-bearing plan 토론이 아직 3라운드 | 낮음 | 코드 | 열림 |
| M-4 | 운영 세션 비용이 공장 비용의 약 3배 | 높음 | 기록 | 기존 인지 |
| M-5 | 상호작용 레인 진입 명령(`factory review --pr`)이 없음 | 중 | 코드 | 기존 인지 |
| M-6 | plan 모드(단일/토론)가 triage 에이전트의 신고 tier로 정해짐 | 중 | 코드 | 열림 |
| M-7 | 토론 모드에서 서명 단계 미해소 반박이 검증 거부를 보장함 | 중 | 재현 | 열림 |
| M-8 | plan 수리 턴이 워크플로 전체를 처음부터 다시 돎 | 중 | 코드 | 열림 |
| M-9 | 단일 모드에서 skeptic 추가분을 상한 확인 없이 병합함 | 낮음 | 재현 | 열림 |

---

## 1. 진입·심사 (E)

배경: `factory:queue`로 가는 정식 경로는 `transition()` 하나이고, 그 안에서 리허설 확인과 admission 심사를 한다(`lib/transition.js:112-123`). 심사기를 안 넘기면 거부한다(fail-closed). 아래 E-1~E-3은 `transition()`을 부르지 않고 라벨을 직접 쓰는 경로다.

### E-1. 로컬 진입이 큐 심사를 건너뜀
- **무엇**: `factory run triage <n>`은 `backlog → factory:queue`를 `gh.setFactoryLabel`로 직접 쓴다. 리허설은 확인하지만 admission은 부르지 않는다.
- **근거**: `bin/run-stage.js`의 `makeLocalEntry`(3440~3463줄, 라벨 쓰기는 3461줄). 인자에 `rehearsal`만 있고 `admission`이 없다.
- **영향**: `done_when` 없는 이슈, 금지 경로 이슈, 큐 상한 초과가 로컬 진입으로는 통과한다. `admission.js` 주석의 "문은 하나여야 한다"와 어긋난다.
- **수정 방향**: E-3의 공통 수정으로 닫힌다.

### E-2. 회고의 승격 이슈가 큐 라벨을 단 채 생성됨
- **무엇**: 회고가 만드는 성숙도 승격(하네스) 이슈는 `createIssue({ labels: ["factory:queue", "factory:harness"] })`로 태어난다. 리허설도 admission도 거치지 않는다.
- **근거**: `bin/retro.js:844`. 같은 종류인 flaky 이슈(`lib/gates.js:592-596`)와 하네스 요청(`lib/harness-request.js:229-237`)은 backlog로 만든 뒤 `transition()`으로 큐에 넣는다. `gates.js` 주석은 flaky 경로를 고치며 "게이트를 비켜 가는 유일한 생산 경로였다"고 적었는데 이 경로가 남아 있다.
- **미확인**: 이슈 생성 시점에 붙은 라벨로도 `labeled` 이벤트가 떠서 triage가 실제로 시작되는지. 실행 기록에서 확인 가능.
- **수정 방향**: 다른 두 경로와 같이 backlog로 만들고 전이한다.

### E-3. 사람이 라벨을 직접 붙이는 경우
- **무엇**: GitHub UI나 API로 `factory:queue`를 붙이면 심사 없이 triage가 뜬다. 훅(`block-dangerous.sh`)은 에이전트 세션만 막는다.
- **근거**: triage 진입 가드(`run-stage.js`의 진입 라벨 확인)에서 admission을 다시 부르는 코드를 찾지 못했다.
- **수정 방향 (E-1·E-2·E-3·E-8 공통)**: triage 진입 가드에서 admission을 한 번 더 돌린다. 어느 경로로 큐에 왔든 한 자리에서 걸린다.

### E-4. NEVER_AUTOMATE 글롭이 한정어를 못 읽음 — 의도 확인
- **무엇**: CHARTER 본문의 NEVER_AUTOMATE 절에서 백틱 안에 `/`나 `*`가 든 토큰을 전부 금지 글롭으로 뽑는다. 문장의 한정어는 읽지 않는다.
- **재현**: KTB CHARTER에서 뽑히는 글롭은 `.github/workflows/publish.yml`, `factory/cli/bump-version.js`, `templates/factory/**`, `.env*` 넷이다.
  - CHARTER 문장은 "`templates/factory/**`의 게이트 판정 로직 변경"만 금지하는데, 스크립트는 그 아래 전체를 막는다.
  - `factory/cli/bump-version.js`는 금지 항목이 아니라 설명 문장에 나온 경로다.
- **근거**: `lib/config.js:76-89`(`neverAutomateGlobs`), `docs/factory/CHARTER.md:98-107`. 9월 캠페인의 L14와 같은 종류다. doctor의 `charter.never-automate-qualified`는 특정 한정어(breaking 등)만 경고한다.
- **hk에게 확인**: `templates/factory/**` 전체를 막는 것이 의도인가, 판정 로직만 막고 싶은가.

### E-5. 자기생성 판정에 본문 마커가 들어감
- **무엇**: 본문에 `Detected while implementing #N.`을 적으면 `isSelfGenerated`가 참이 되어 `done_when` 요구가 면제된다.
- **재현**: 마커만 있고 `done_when`이 없는 이슈가 통과했다.
- **영향**: 작다. 대신 자기생성 상한(열린 수 5, 세대 1)을 받는다. 다만 주석의 "제출자의 자기 신고가 아니다"와는 어긋난다.
- **근거**: `lib/admission.js:27-33`(`isSelfGenerated`).
- **수정 방향**: 마커 판정에 작성 계정 조건을 함께 건다.

### E-6. Impact paths 표기 불일치
- **무엇**: admission의 파서는 `## Impact paths` 절의 **백틱 안 토큰**만 경로로 읽는다. 그런데 `:issue` 스킬의 기본 본문 템플릿은 `- {{path_1}}`로 백틱이 없다.
- **재현**: 백틱 없는 목록은 빈 배열이 나온다. 제목이 `###`이거나 백틱 안에 공백이 섞여도 빈 배열이다.
- **영향**: 템플릿대로 쓴 이슈는 NEVER_AUTOMATE 조기 차단이 아무 경로도 못 본다. 절이 아예 없어도 같다. triage 뒤의 재대조(`verify-stage`가 triage의 `impact_paths`를 다시 봄)가 남은 방어선이다.
- **근거**: `lib/admission.js:46-57`(`impactPathsOf`), `templates/know-thy-build/issue.md:140-142`. 같은 파일의 문서 전용 예시(157줄 부근)는 백틱을 쓴다.
- **미확인**: 실제 이슈들이 백틱을 쓰는지(이 세션에서 이슈 본문을 읽을 수 없음).
- **수정 방향**: 템플릿에 백틱을 넣거나, 파서가 백틱 없는 목록 항목도 읽게 한다.

### E-7. 이슈의 `done_when`과 plan 계약 사이가 비어 있음 — 의도 확인
- **무엇**: admission은 `done_when` 제목이 있는지만 본다. 절이 비어 있어도 통과한다. 그 뒤 plan 스테이지가 계약용 `done_when`을 새로 쓰는데, 이슈의 초안과 맞는지는 스크립트가 보지 않는다.
- **근거**:
  - `lib/admission.js:22`(`DONE_WHEN_RE`는 제목만 매치).
  - plan 검증기(`lib/verify-stage.js`의 `validatePlanHandoff`)가 이슈 본문을 읽는 곳은 내가 본 범위에서 "가드를 요구했나" 하나뿐이다(262줄 부근).
  - 대응을 보는 것은 에이전트 셋의 판단이다: triage("완료 조건을 쓸 수 있나"), plan, spec-conformance 리뷰어("이슈 ↔ plan ↔ diff 대조").
  - KTB는 `triage.default: ready`라 애매하면 통과시킨다.
- **영향**: 초안이 비면 plan이 계약을 통째로 발명한다. 9월 베이스라인(`docs/factory/dogfood/2026-09-14-plan-baseline.md`)에서 must_fix 15건 중 5건이 plan이 발명한 `done_when`에서 나왔다.
- **hk에게 확인**: 이슈의 `done_when`은 "초안"인가 "계약의 원본"인가. 원본이라면 plan 계약이 이슈 항목을 빠짐없이 덮는지 스크립트로 확인하는 쪽으로 간다.

### E-8. 심사와 triage 사이의 시간 간격
- **무엇**: admission은 전이 순간에 한 번 돈다. 그 뒤 러너 대기(9월 캠페인에서 55~90분 대기 기록) 동안 큐 길이나 이슈 본문이 바뀌어도 다시 보지 않는다.
- **확인 수준**: 구조에서 추론. 실제로 문제를 일으킨 기록은 찾지 않았다.
- **수정 방향**: E-3의 공통 수정으로 닫힌다.

### E-9. "명시적 제출"이 triage 기본값을 덮음 — 의도 확인
- **무엇**: 큐 전이 마커(`factory-transition:v1 … to=factory:queue`)가 있는 이슈는 `explicit_submission: true`가 되고, triage는 이를 본문의 `[ready]`와 똑같이 읽어 `ready`로 보낸다. 정식 경로(`transition()`)와 로컬 진입은 전부 이 마커를 남기므로, CHARTER의 `triage.default`(애매하면 멈출지 통과시킬지)는 마커 없이 큐에 온 이슈에만 적용된다. 마커 없이 오는 경우는 E-2(라벨을 달고 태어난 이슈)와 E-3(손으로 붙인 라벨)뿐이다.
- **근거**: `lib/context.js`의 `explicitSubmission`(229~236줄), `.claude/workflows/factory-triage.js`의 프롬프트 조립, `.claude/agents/factory-triage.md`의 판정표. 설계 문서 2026-09-30 §8.1의 결정이다(#105가 `done_when`이 구체적인데도 `[ready]`가 없어 needs-info로 돌아간 사례).
- **영향**: 공장이 스스로 만든 이슈(flaky, 하네스 요청)도 "명시적 제출"이다. triage에 남는 실질 판정은 NEVER_AUTOMATE 해당 여부, "완료 조건을 쓸 수 있나", tier 셋이다. 그중 "완료 조건을 쓸 수 있나"가 E-7의 유일한 방어선이다.
- **hk에게 확인**: 도입 저장소의 기본값 `needs-info`가 사실상 발동하지 않는 것이 의도인가.

---

## 2. 트리거·실행 (T)

### T-1. "다시 돌려"가 네 갈래
- **무엇**: 라벨 전이, `factory run <stage>`, `factory run --remote`, sweeper가 각각 다른 카운터(K, R, 예산, 재시도 마커)를 건드린다.
- **근거**: `docs/research/factory-friction-2026-10.md` §2, ADR-037 4항이 `factory retry <n>` 하나로 합치기로 결정. `factory/cli/run.js`와 `factory/cli/`에는 아직 `retry` 명령이 없다.
- **상태**: 저장소가 이미 인지한 항목. 구현 대기.

### T-2. 라벨 이벤트 하나에 워크플로 다섯 개
- **무엇**: 스테이지 워크플로 다섯 개가 전부 `issues: labeled`를 받고, 잡의 `if:`에서 라벨 이름으로 거른다. 전이마다 넷은 skip으로 끝난다.
- **근거**: `.github/workflows/factory-*.yml`의 `on:`과 35줄 부근 `if:`. 9월 핸드오버 §3.4가 47시간에 런 300개를 기록했고 후보 D로 `workflow_dispatch` 단일 진입을 제안했다.
- **영향**: 러너 시간은 안 쓰지만 큐와 API 호출을 차지한다.

### T-3. 이슈 단위 로컬 실행이 없음 — 의도 확인
- **무엇**: `factory run`은 스테이지 하나만 로컬에서 돌린다(triage, plan, implement, review. merge는 로컬 금지). 스테이지가 끝나 라벨을 붙이면 다음 스테이지는 GitHub Actions가 받는다.
- **근거**: `factory/cli/run.js`(`STAGES`, merge 거부). 로컬이 먼저 락을 잡는 경로(`FACTORY_LOCAL_ENTRY`)는 triage의 큐 진입에만 있다.
- **추론**: plan부터는 앞 스테이지가 라벨을 붙이는 순간 CI 잡이 먼저 뜨므로, 뒤늦은 로컬 실행은 락 경합에서 물러난다. 실행 기록으로 확인하지 않았다.
- **hk에게 확인**: 로컬 실행은 디버깅용인가, 이슈 하나를 끝까지 돌리는 1급 경로인가. B-1의 대응책과 묶인다.

### T-4. 디스패처가 LLM 세션임
- **무엇**: 스테이지마다 `claude -p "/factory-<stage> <n>"`가 뜨고, 그 세션(LLM)이 하는 일은 `loaded.json`을 읽어 Workflow 도구에 그대로 넘기고 반환값을 그대로 출력하는 것뿐이다. 결정론적인 전달을 LLM이 맡는다. triage는 에이전트 한 번을 부르려고 디스패처 세션, 워크플로 런타임, 에이전트 세 겹을 거친다.
- **근거**: `.claude/commands/factory-triage.md`(허용 도구는 `Workflow(factory-triage)`와 `Read(.factory/out/loaded.json)` 둘). 명령 문서와 워크플로 주석에 실패 사례가 적혀 있다: 디스패처가 args를 JSON 문자열로 넘겨 14초 만에 종료(KTB #170), 출력 파일을 폴링하다 턴을 소진해 끝난 판정 3건 유실(own-calendar #124). 10월 마찰 조사는 needs-human 40회 중 5회를 "오케스트레이터가 핸드오프를 안 냄"으로 분류했다.
- **수정 방향**: 에이전트가 하나뿐인 스테이지(triage, retro)는 워크플로 없이 에이전트를 직접 호출하는 경로를 검토한다. `harness.toml`의 `[factory] orchestration = "workflow" | agent` 설정이 이미 있는데, `agent` 모드가 무엇을 하는지는 아직 읽지 않았다.

---

## 3. 요금·플랫폼 (B)

GitHub 공식 문서(2026-10-09 확인) 기준. 출처는 문서 끝.

### B-1. Actions가 막히면 복구 주체도 같이 멈춤
- **조건**: private 저장소 + GitHub 호스팅 러너에서 월 포함분(Free 2,000분, Pro·Team 3,000분)을 다 쓴 경우. 결제 수단이 없으면 즉시 차단되고, 있어도 예산에 "한도 도달 시 중지"가 켜져 있으면 차단된다. public 저장소의 표준 러너와 self-hosted 러너는 무료라 해당 없다.
- **막히는 것**:
  - 스테이지 연쇄: 라벨은 붙지만 잡이 안 뜬다.
  - sweeper: 복구 담당인데 그 자신이 Actions 워크플로다(`factory-sweeper.yml`). 멈춘 사실을 알려 줄 주체가 없다.
  - integrity, retro, health, rehearse: 전부 워크플로. 필수 체크 `factory/integrity`가 안 붙는다.
  - merge: 로컬 실행은 금지이고 `--remote`도 Actions다.
  - 큐 진입: 리허설이 워크플로라, 하네스나 CHARTER를 바꾼 뒤에는 다시 못 돌린다.
- **안 막히는 것**: `factory run triage/plan/implement/review`(로컬). `gh` API와 git만 쓴다.
- **노출**: KTB·데모는 public + 호스팅이라 무료. own-calendar는 self-hosted라 실행 시간은 무료(private 여부는 추정). 가장 크게 노출되는 것은 Free 플랜 private 저장소에 호스팅 러너로 도입하는 경우다.
- **수정 방향**:
  1. Actions 없는 모드: `factory run <issue>`로 triage부터 review까지 로컬 연쇄, integrity도 로컬 판정, merge는 사람(ADR-037 상호작용 레인과 같은 방향).
  2. 차단 감지를 Actions 밖에 둔다: `factory status`나 doctor가 로컬에서 최근 런을 읽어 "결제 문제로 시작되지 않음"을 알린다.
  3. doctor 점검: 저장소 공개 여부, 러너 종류, 플랜을 읽어 해당하면 경고.
  4. 도입 안내: private 저장소는 self-hosted 러너(`FACTORY_RUNNER`)를 기본 권장으로.

### B-2. Free 플랜 private 저장소의 기능 제한
- **무엇**:
  - 브랜치 보호: Free의 private 저장소에서 불가. doctor가 이미 WARN으로 처리한다(`lib/doctor/merge-authority.js:95`, "훅이 유일한 방어층").
  - 환경 시크릿: Free의 private 저장소에서 불가(Pro·Team 이상 필요). 두 배우 모드는 `FACTORY_MERGE_TOKEN`을 환경 시크릿으로 두라고 안내한다(README).
  - 환경 리뷰어(사람 게이트): Free·Pro·Team에서 public 저장소 전용. `bootstrap.js:76`이 `merge.human_gate`가 켜졌을 때 환경에 리뷰어를 넣는다.
- **미확인**: 이 경우들에서 `factory bootstrap`이 어떻게 실패하거나 강등되는지.

### B-3. self-hosted 러너 과금 — 관찰
- GitHub이 2025-12에 self-hosted에도 분당 $0.002를 2026-03-01부터 부과한다고 발표했다가 연기했다. 새 날짜는 없고 취소라고 하지 않았다. 시행되면 private + self-hosted 구성이 B-1과 같은 위험에 들어온다.

### B-4. 아티팩트 저장 용량 — 완화됨
- own-calendar에서 쿼터가 차서 모든 스테이지 잡이 failure로 끝난 적이 있다(1.4.33). 지금은 업로드가 `continue-on-error: true`이고 보존 3일이라 판정에는 영향이 없다. 남은 손실은 사후 조사용 기록이다.

### 요금은 아니지만 같은 증상
- cron은 부하가 높으면 지연되거나 누락된다. sweeper의 30분 cron이 하루 4~5번만 돈 기록이 이것이다(10-06 커밋이 `workflow_run` 트리거를 추가해 보완).
- public 저장소는 60일간 활동이 없으면 예약 워크플로가 자동으로 꺼진다.

---

## 4. 멀티에이전트 구조 (M)

구조 검토 전 상태 점검에서 나온 것들이다. hk의 구조 설명이 이 영역에 닿으면 다시 대조한다.

### M-1. 리뷰 로스터·K 축소 근거가 저장소마다 다름
- **무엇**: `docs/research/review-roster-evidence.md`는 own-calendar·데모 기록으로 "architecture 제거, K=2"를 채택했다(architecture 단독 거부 0/54, 3라운드 승인 1/8).
- **KTB 자체 기록 집계**(`factory/records` 브랜치의 `review-evidence:` 줄, 68라운드):

  | 역할 | 판정 | 거부 | 단독 거부 |
  |---|---|---|---|
  | correctness | 68 | 26 | 11 |
  | spec-conformance | 68 | 19 | 6 |
  | architecture | 68 | 15 | 4 |
  | security | 41 | 9 | 4 |
  | qa | 68 | 8 | 1 |

  3라운드 승인은 5/15다.
- **주의**: 단독 거부는 "그 역할이 없었으면 승인됐을 라운드"이지 실제 결함을 잡았다는 뜻은 아니다. 엔진 결함이 섞인 기간도 포함한다.
- **수정 방향**: KTB CHARTER(architecture 유지, K=3)는 그대로 두고, 앱 저장소용 템플릿 기본값만 줄인다. 로스터 결정은 저장소별 기록으로 한다.

### M-2. R2 교차검토의 효과를 잴 수 없음
- **무엇**: 리뷰에서 거부가 하나라도 나오면 전원이 서로의 판정을 보고 다시 답한다(R2 full). 그런데 handoff에 R1 판정이 남지 않아서(`factory-review.js:506`의 F7 주석) R2가 판정을 뒤집은 횟수를 셀 수 없다.
- **수정 방향**: R1 판정 요약 한 줄을 기록에 남긴다. 뒤집힘이 드물면 거부가 나온 라운드는 R2 없이 rework로 보낸다.

### M-3. KTB의 load-bearing plan 토론이 3라운드
- `docs/factory/CHARTER.md`의 `plan_rounds: { docs: 2, default: 3 }`. own-calendar는 2로 낮췄고 통과가 확인됐다(핸드오버 §4-4, L38 타임아웃).

### M-4. 운영 세션 비용
- 9월 캠페인에서 운영 세션 약 $1,800(정가 추정), 공장 $634. 원인은 긴 컨텍스트 위의 짧은 상태 확인 턴 반복이다(핸드오버 §3.5). 대응은 상태 카드와 감시 프로세스(ADR-037 3항, 핸드오버 후보 H).

### M-5. 상호작용 레인 진입 명령이 없음
- ADR-037이 `factory review --pr <n>`을 결정했지만 `factory/cli/`에서 찾지 못했다. 증거 블록(#208/#215)은 들어가 있다.

### M-6. plan 모드가 triage의 신고 tier에 달려 있음
- **무엇**: plan을 단일 패스로 돌릴지 4역할 토론으로 돌릴지는 tier가 `load-bearing`인가로 정해진다. 실효 tier는 "신고 tier와 diff로 계산한 바닥 중 높은 쪽"인데, plan 시점에는 diff가 없어서 바닥이 `docs`로 나온다. 결국 triage 에이전트(sonnet)가 신고한 tier가 그대로 쓰인다.
- **근거**: `lib/context.js:30-38`(`resolveTier`), `lib/gates.js:447-454`(`tierFloor`는 변경 파일 목록으로 계산), `lib/config.js:252-258`(`planRoundsFor`). triage 검증(`lib/verify-stage.js:393-402`)은 `impact_paths`를 NEVER_AUTOMATE에만 다시 대고, `[load_bearing].paths`에는 대지 않는다.
- **영향**: triage가 load-bearing 이슈를 `standard`로 신고하면 토론 없이 단일 패스로 계획한다. 9월 평가의 H3(자기 신고 tier)은 리뷰 로스터 쪽만 닫혔다(리뷰 시점에는 diff가 있음).
- **수정 방향**: triage 검증에서 `impact_paths`를 `[load_bearing].paths`에 다시 대어 tier를 올린다. NEVER_AUTOMATE 덮어쓰기와 같은 자리, 같은 방식이다.

### M-7. 서명 단계의 미해소 반박이 검증 거부를 보장함
- **무엇**: 토론 모드에서 서명 투표에 반박이 남으면 워크플로가 `dissent_log`에 `{ id: "signoff-<역할>", severity: "medium", resolution: "unresolved — proceeding" }`를 넣는다. 검증기는 중간 이상 위험이 어떤 `done_when`의 `covers`로도 덮이지 않으면 거부한다. 이 항목을 덮는 `done_when`은 있을 수 없으므로 반드시 거부된다.
- **재현**: `validatePlanHandoff`에 그 모양의 계획을 넣으면 `dissent without done_when: signoff-skeptic`으로 거부된다. 같은 워크플로가 넣는 성숙도 강등 메모(`severity: "low"`)는 통과한다.
- **근거**: `.claude/workflows/factory-plan.js`의 Sign-off 블록, `lib/verify-stage.js:231-247`. 강등 메모는 같은 문제(L39, own-calendar #90)를 겪고 `low`로 고쳐졌는데 서명 항목은 그대로다.
- **영향**: "미해소인 채 진행"이라고 적지만 실제로는 진행하지 못하고 수리 턴으로 간다(M-8).
- **수정 방향**: 서명 반박을 `done_when`으로 올리게 강제하거나, 덮을 수 없는 항목이면 `low`로 낮추고 사람에게 보이는 자리에 따로 적는다.

### M-8. plan 수리 턴이 전체를 다시 돎
- **무엇**: 검증기가 계획을 거부하면 수리 턴 한 번이 주어진다. 이 턴은 `claude -p`를 새로 띄워 워크플로를 처음부터 다시 돌린다. 토론 모드라면 입장 → 교차검토 → 종합 → 서명을 전부 다시 한다. 수리 지시문은 계획자(단일)나 종합자(토론)의 프롬프트에만 들어간다.
- **근거**: `bin/run-stage.js:988-1006`(수리 턴이 `d.claudeP`를 다시 호출), `factory-plan.js`의 `repairDirective`가 붙는 위치.
- **영향**: 형식 오류 하나를 고치려고 토론 전체 비용을 한 번 더 쓴다. 다시 돈 토론은 앞선 토론과 다른 계획을 낼 수 있다. 9월 핸드오버는 own-calendar의 실패 표식 중 "플랜 계약 실패 31"을 가장 많은 항목으로 기록했다.
- **수정 방향**: 수리 턴에는 직전 계획을 입력으로 넘기고 종합 단계만 다시 돌린다.

### M-9. skeptic 추가분을 상한 없이 병합
- **무엇**: 단일 모드에서 스크립트는 skeptic이 낸 `done_when`을 계획자의 목록 뒤에 그대로 붙인다. 상한(기본 6)은 프롬프트로만 알린다.
- **재현**: 계획자 6개 + skeptic 1개인 계획은 `done_when has 7 items (max 6)`로 거부된다.
- **근거**: `factory-plan.js`의 단일 모드 병합부(`done_when: [...plan.done_when, ...newDw]`).
- **영향**: 거부되면 수리 턴으로 가서 계획자와 skeptic을 둘 다 다시 돈다. 실제 발생 빈도는 확인하지 않았다.
- **수정 방향**: 병합할 때 남은 자리만큼만 받는다.

---

## 5. hk에게 확인할 것

| # | 질문 | 걸린 항목 |
|---|---|---|
| 1 | `templates/factory/**` 전체를 자동화 금지로 두는 것이 의도인가 | E-4 |
| 2 | 이슈의 `done_when`은 초안인가, 계약의 원본인가 | E-7 |
| 3 | 로컬 실행은 디버깅용인가, 이슈를 끝까지 돌리는 1급 경로인가 | T-3, B-1 |
| 4 | Actions 없는 모드를 계획에 넣는가 | B-1 |
| 5 | 큐 전이를 거친 이슈가 전부 `ready`로 읽히는 것이 의도인가 | E-9 |

## 6. 아직 확인하지 못한 것

- 이슈 생성 시점의 라벨로 `labeled` 이벤트가 뜨는지 (E-2)
- 실제 이슈 본문들이 Impact paths에 백틱을 쓰는지 (E-6)
- plan 이후 스테이지에서 로컬 실행과 CI 잡의 락 경합 결과 (T-3)
- own-calendar가 private 저장소인지 (B-1)
- Free·Pro·Team private 저장소에서 `factory bootstrap`의 동작 (B-2)
- 이 세션에서는 이슈·PR 본문과 own-calendar·데모 저장소를 읽지 않았다

## 7. 계획 후보 (허점에서 나온 것)

| # | 내용 | 닫는 항목 | 크기 |
|---|---|---|---|
| P-1 | triage 진입 가드에서 admission 재심사 | E-1, E-2, E-3, E-8 | 작음 |
| P-2 | 회고 승격 이슈를 backlog 생성 후 전이로 변경 | E-2 | 작음 |
| P-3 | Impact paths 템플릿·파서 표기 맞추기 | E-6 | 작음 |
| P-4 | NEVER_AUTOMATE 표기 규칙 정리 (금지 글롭을 명시 목록으로 분리) | E-4 | 작음, 의도 확인 후 |
| P-5 | 자기생성 판정에 작성 계정 조건 추가 | E-5 | 작음 |
| P-6 | 이슈 `done_when` ↔ plan 계약 대응 검증 | E-7 | 중, 의도 확인 후 |
| P-7 | Actions 없는 모드 (`factory run <issue>`, 로컬 integrity, 사람 merge) | T-3, B-1, M-5 | 큼 |
| P-8 | 차단 감지와 doctor 플랜 점검 | B-1, B-2 | 중 |
| P-9 | 리뷰 기록에 R1 판정 요약 남기기 | M-2 | 작음 |
| P-10 | 로스터 기본값을 KTB와 템플릿으로 분리 | M-1 | 작음 |
| P-11 | 단일 에이전트 스테이지의 디스패처 제거 검토 | T-4 | 중 |
| P-12 | triage 검증에서 `impact_paths`를 load-bearing 경로에 재대조 | M-6 | 작음 |
| P-13 | 서명 단계 반박의 처리 규칙 정리 | M-7 | 작음 |
| P-14 | plan 수리 턴을 종합 단계만 재실행하도록 변경 | M-8 | 중 |
| P-15 | skeptic 병합에 상한 적용 | M-9 | 작음 |

## 8. 변경 이력

- 2026-10-09: 최초 작성. E-1~E-8, T-1~T-3, B-1~B-4, M-1~M-5 등록.
- 2026-10-09: triage 스테이지 추적에서 E-9, T-4, P-11 추가.
- 2026-10-10: plan 스테이지 추적에서 M-6~M-9, P-12~P-15 추가.
- 2026-10-11: 운영 세션이 저장소에 저장, /goal로 채택.

---

## 출처 (요금·플랫폼)

- [GitHub Actions billing — GitHub Docs](https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions)
- [Actions limits — GitHub Docs](https://docs.github.com/en/actions/reference/limits)
- [Setting up budgets — GitHub Docs](https://docs.github.com/en/billing/how-tos/set-up-budgets)
- [Pricing changes for GitHub Actions — GitHub](https://github.com/resources/insights/2026-pricing-changes-for-github-actions)
- [Update to GitHub Actions pricing — GitHub Changelog](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/)
- [About protected branches — GitHub Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [Deployments and environments — GitHub Docs](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Events that trigger workflows — GitHub Docs](https://docs.github.com/actions/using-workflows/events-that-trigger-workflows)
