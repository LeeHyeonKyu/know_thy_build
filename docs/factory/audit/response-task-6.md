# 감사 대응 Task 6 — 기본값이 아니라 선택, 증명이 아니라 판정 불가 (M1 · M2 · M13 · M10/M11)

- **감사 항목**: M1(triage default-allow) · M2(prove-test가 base exit≠0만 본다) · M13(중복 스테이지
  실행 + 라벨 조회 실패 시 통과) · M10/M11(lessons 15개 전부 헤더뿐, `evidence_runs` 길이만 검사,
  인용 카운터 미증가) — `docs/factory/audit/2026-09-14-external-audit.md`
- **계획**: `docs/superpowers/plans/2026-09-14-factory-audit-hardening.md` Task 6
- **결과물**: `factory/lib/config.js` · `factory/lib/doctor/factory.js` · `factory/lib/verify-stage.js` ·
  `factory/lib/context.js` · `factory/lib/schemas.js` · `factory/lib/prove-test.js` ·
  `factory/lib/gates.js` · `factory/bin/run-stage.js` · `factory/bin/retro.js` ·
  `factory/lib/retro/{lessons,harvest,proposals}.js` · 두 CHARTER · triage/리뷰어/빌더 프롬프트 ·
  스펙 §3.1·§4.2·§5.2.4·§5.3·§7.4.

네 항목의 공통점 하나가 이 문서의 제목이다: **아무도 고른 적 없는 것이 조용히 통과로 읽혔다.**
애매한 이슈는 `ready`였고, 아무것도 증명하지 못한 base 실행은 "증명됨"이었고, 읽지 못한 라벨은
"진행해도 좋다"였고, 실재하지 않는 run 번호 두 개는 "근거 2건"이었다.

## 1. M1 — triage의 기본 판정은 CHARTER가 적는다

감사가 짚은 자리(`factory-triage.md:31-37`)의 규칙은 "NEVER_AUTOMATE도 아니고 done_when도 쓸 수
있으면 `ready`"였다. 판단이 서지 않는 이슈의 기본값이 **통과**였고, 그것을 고른 저장소는 없었다.

- CHARTER 프론트매터에 `triage: { default: needs-info | ready }`가 생겼다. `loadCharter`는
  **기본값을 채우지 않는다**(`merge.human_gate`와 같은 이유): 없는 것과 고른 것은 다른 사실이다.
- `factory doctor`: `needs-info` → PASS, `ready` → WARN `triage.default-allow`(매 실행 소리 내어
  말한다), 없거나 두 값이 아님 → **FAIL `charter.triage-default-unset`**.
- 템플릿 CHARTER는 `needs-info`다 — 남의 저장소에 default-allow를 심지 않는다. KTB의 CHARTER는
  `ready`를 **이유와 함께** 적는다(다크 루프를 측정하는 것이 이 저장소의 산출물이다).
- 판정표가 프롬프트에 명시됐다: NEVER_AUTOMATE → `wont-do`, done_when 불가 → `needs-info`,
  이슈 본문의 `[ready]` 표식 → `ready`, 그 밖 전부 → 차터 기본값. 에이전트는 기본값을
  `loaded.triage.default`로 **받는다**(빌드 컨텍스트가 CHARTER에서 싣는다).

### 스크립트가 다시 세는 벽

프롬프트는 에이전트가 읽는 것이고, 그 판정은 LLM의 것이다. 그래서 NEVER_AUTOMATE 중 **경로 글롭으로
적힌 항목**(`auth/**`, `billing/**`, `.env*`)은 `verify-stage`가 triage handoff의 새 선택 필드
`impact_paths`에 다시 댄다 — 걸리면 에이전트가 무엇이라 판정했든 `wont-do`로 덮고
`never_automate_hit`으로 handoff·run 기록에 남긴다. 뽑는 기준은 백틱 안에 `/`나 `*`가 있는 토큰
하나뿐이다: `package.json` 같은 비글롭을 글롭으로 읽으면 그 파일을 스치는 모든 PR이 wont-do가 된다.

**남는 위험**: `impact_paths`는 에이전트가 적는다. 비워 두면 재확인이 볼 대상이 없다(그 사실을
프롬프트가 말한다). 이 층은 "에이전트가 목록을 못 봤다"를 막지, "에이전트가 경로를 숨겼다"를 막지
않는다 — 후자는 diff가 실제로 생긴 뒤 `[protected]` 경로 정책이 잡는 자리다.

## 2. M2 — base 워크트리에 의존성이 없으면 그 실행은 증명이 아니다

`git worktree add --detach`가 만드는 것은 소스뿐이다. 그 위에서 새 테스트를 돌리면 거의 언제나
`Cannot find module 'vitest'`로 죽고, 예전 코드는 그 exit≠0을 그대로 "base에서 실패했다 = 증명됐다"로
읽었다(`prove-test.js:22-24`). 곧 **아무것도 증명하지 않는 테스트도 이 게이트를 통과**했다.

- base 워크트리에 의존성을 깐다: 하네스 `[runtime].setup`이 있으면 그것이 정본(pnpm·yarn 저장소는
  npm을 모른다), 없으면 lockfile 유무에 따라 `npm ci` / `npm install --no-audit`, 둘 다 없으면 설치
  없음(Node 저장소가 아닐 수 있다).
- 설치가 실패하면 fail closed — `misconfigured`. "설치가 실패했으니 테스트도 실패했고 그러니
  증명됐다"가 정확히 이 게이트가 죽었던 방식이다.
- base 실행이 모듈 해석/import 오류로 죽으면 **판정 불가**(`inconclusive`)다: 게이트는 GREEN도 RED도
  아닌 `MISCONFIGURED`가 되고, `recomputeStatus`의 required 규칙(감사 H2)이 그 PR을 GREEN에서
  막는다. 판정 불가 목록은 `prove_test.inconclusive[]`로 게이트 결과에 남는다.
- 판정 불가로 **세지 않는 것**이 요점이다: `does not provide an export named 'x'`와
  `lib.parseX is not a function`은 정직한 증명의 모습 그대로다(base에는 그 export가 없다).
  `is not a function`은 주어가 `undefined`일 때만 판정 불가로 센다.

## 3. M13 — 모르면 멈춘다 (라벨 조회 실패 · 중복 실행)

- **라벨 조회 실패**: 예전 규칙은 "막지 않고 흔적만 남긴다 — 가드는 비용 방어이고 안전은 전이
  그래프가 쥔다"였다. 그 전제가 틀렸다: 조회에 실패한 런은 **자기가 어떤 상태에서 출발했는지 모르는
  채로** `claude -p`를 띄우고, 전이 그래프는 "지금 라벨"만 볼 뿐 "돌기 전에 무엇이었는가"를 복원해
  주지 않는다. 이제 던졌든(예외) 아무것도 안 돌려줬든(null/비배열) `factory:blocked`
  (cause `api-error`)로 멈춘다 — 일시 장애 등급이라 sweeper의 blocked-origin 재시도가 다시 집는다.
  라벨이 **없는** 이슈(빈 배열)는 이 경우가 아니다: 그건 읽은 사실이고 "할 일 없음"으로 간다.
- **중복 실행**: 락은 *동시* 러너만 막는다(끝난 런의 락은 이미 풀려 있다). **이번 차례**(마지막
  재큐 이후, 그리고 이 스테이지의 진입 라벨로 들어온 마지막 전이 이후)에 이 스테이지의 handoff 중
  **head sha가 같은 것**이 있으면 이 런이 할 일은 없다: 전이도 코멘트도 `claude -p`도 없이
  `duplicate-run: skipped`로 exit 0이다(락만 놓는다). 진입 라벨 전이에서 창을 한 번 더 자르는 것이
  이 가드의 안전장치다 — 자르지 않으면 rework 시점의 PR head가 아직 이전 implement handoff의
  head와 같아 **재작업이 통째로 중복으로 읽힌다**.
  판정 조회가 실패하면 막지 않는다: 중복인지 모를 뿐이고, 진입 라벨 가드와 전이 그래프는 그대로다.

**남는 위험**: head sha가 없는 스테이지(triage·plan은 PR 이전이다)에는 이 가드가 돌지 않는다.
그쪽의 중복은 진입 라벨 가드가 막는다(전이가 라벨을 옮기므로 재진입이 걸린다).

## 4. M10/M11 — 근거는 실재하고, 인용은 세어진다

- **근거 실재**(M10): `retro.js:540,544`는 `evidence_runs`의 **길이**만 셌다. `[1, 2]`라고 적으면 그
  이슈가 존재하든 말든 창이 찼다 — "근거 2건 이상"은 숫자 두 개를 타이핑했다는 뜻이었다. 이제
  records 브랜치(`docs/factory/runs/<issue>.md`)에 실재하는 run id만 근거로 센다. 없는 번호를 든
  lesson·예시·관점·제안은 `unknown-evidence-run: <ids>` 사유로 거부·보류된다(버리지 않는다 — 다음
  retro가 진짜 근거와 함께 다시 본다). 기록이 하나도 없는 저장소의 첫 retro에서는 검사를 걸지
  않는다: 그때의 "근거 없음"은 지어냄이 아니라 이 저장소에 아직 run 기록이 없다는 사실이다.
  `test-delete` 제안은 예외다 — 그것이 인용하는 것은 run 기록이 아니라 재작성 이슈 번호이고,
  삭제는 언제나 사람이 본다.
- **인용 카운터**(M11): `인용: N회`는 §7.4가 정한 필드인데 올리는 코드가 없었다(`lessons.js:116`).
  15개 전 항목이 영원히 0회였고, 그래서 은퇴 규칙("인용 0회부터")은 사실상 "오래된 것부터"였다.
  이제 판정문 안의 마커 `lesson:<id>`가 유일한 입력이다: 리뷰어는 그 교훈이 만든 발견의 `claim`
  안에, 빌더는 implement handoff의 `notes`에 적고(다섯 리뷰어 + 빌더 프롬프트가 그렇게 지시한다),
  retro가 창 안의 handoff에서 **역할별로** 센다(같은 id가 역할마다 있으므로 역할을 잃으면 엉뚱한
  파일의 숫자가 오른다). 채택이 하나도 없는 역할도 인용이 있으면 파일이 열리고 다크 PR에 실린다 —
  실리지 않으면 카운터는 영원히 0이다.
- **은퇴 순서**: "인용 0회 먼저, 그 다음 나이". 인용 **횟수**로 줄을 세우지 않는다(그건 인기
  투표다). 그리고 **인용된 항목도 마지막 순서로 은퇴한다** — 예전 규칙(인용 항목은 evict 불가)은
  파일이 상한에 닿는 순간 새 교훈을 영원히 받지 못하게 만들었고(전부 `max` 거부), 카운터가 한 번도
  오르지 않던 동안에는 그 동결이 보이지 않았다.

**남는 위험**: 인용은 에이전트의 자기 신고다. 적지 않으면 세어지지 않고, 세어지지 않은 교훈은 먼저
은퇴한다 — 이것은 버그가 아니라 설계다(관측되지 않은 유용함은 유용함의 증거가 아니다). 반대 방향의
남용(쓰지도 않은 교훈을 인용해 살려두기)은 프롬프트가 금지하지만 스크립트가 막지는 못한다.

## 5. 뒤집힌 판정 두 개

이 Task는 기존 테스트가 적어 둔 결정 두 개를 **의도적으로** 뒤집었다. 둘 다 그 자리의 테스트를
새 결정과 그 이유로 다시 썼다(조용한 삭제가 아니다):

1. `run-stage.test.js` "an unreadable label set never blocks the stage" → 이제 멈춘다(§3).
2. `retro-lessons.test.js` "cited entries are never evicted" → 이제 마지막 순서로 은퇴한다(§4).

## 6. 검증

새 테스트 파일 `factory/test/charter.test.js`(M1: 차터 파싱·doctor·글롭 재확인·컨텍스트 전달)와,
`prove-test.test.js`(M2: 설치 명령 선택·판정 불가 분류·게이트 합산), `run-stage.test.js`(M13: 라벨
조회 실패 중단·중복 실행 스킵), `retro-lessons.test.js`·`retro-harvest.test.js`·
`retro-proposals.test.js`·`retro-bin.test.js`(M10/M11: 인용 파싱·카운터·은퇴 순서·근거 실재)에
추가된 테스트가 각 판정을 고정한다.
