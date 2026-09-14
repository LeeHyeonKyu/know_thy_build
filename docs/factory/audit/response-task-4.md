# 감사 대응 Task 4 — 테스트 변조와 자기 채점 tier (H5, H3, M12)

- **감사 항목**: H5(테스트 변조 방어가 사실상 없다), H3(tier가 자기 신고이고 자기 채점자를 고른다),
  M12(docs tier가 리뷰어 프롬프트 변경을 포함한다) — `docs/factory/audit/2026-09-14-external-audit.md`
- **계획**: `docs/superpowers/plans/2026-09-14-factory-audit-hardening.md` Task 4
- **결과물**: `factory/lib/integrity.js`, `factory/lib/context.js`, `factory/lib/gates.js`,
  `factory/lib/merge-stage.js`, `factory/lib/doctor/harness.js`, `factory/bin/run-stage.js`,
  `factory/bin/build-context.js`, `factory/bin/integrity.js`, `.factory/harness.toml`,
  `templates/factory/factory/harness.toml`, `templates/factory/claude/workflows/factory-implement.js`
- 이 문서가 이 변경의 ADR 텍스트다 (ADR-023 "감사 하드닝"의 Task 4 절로 읽는다).

## 1. H5 — 기존 테스트를 고치는 것은 "무엇이 통과인가"를 고치는 것이다

**있던 구멍.** `integrity.js`의 테스트 방어는 `test_glob` 파일에 **추가된** 줄의 skip/ignore pragma
하나뿐이었다(`removedLines`는 `additive_only` 글롭에만 쓰였다). 그래서

- `expect(rows).toHaveLength(3)` → `(2)` 로 바꾸는 diff
- 테스트 파일 하나를 통째로 지우는 diff

는 위반 0으로 통과했고, 게이트가 GREEN이므로 그대로 자동 머지됐다. `[protected].tests_are_load_bearing
= true`가 이미 "테스트는 하중을 받는다"고 적어 두고 있었지만 그것을 **집행하는 코드가 없었다**.

**판정.** `test_glob`에 매치하는 **기존** 파일에서 삭제된 줄이 하나라도 있거나(수정은 diff에서
삭제+추가로 나타난다) 테스트 파일이 삭제되면 `policy` 위반이다:

```
tests-modified — 3 line(s) removed from an existing test — human merge required
tests-modified — existing test file deleted — human merge required
```

**변조(`violations`)가 아니라 정책(`policy`)인 이유**는 protected/additive_only와 같다:
`factory/integrity`는 branch protection의 유일한 required context라, 여기서 RED를 만들면 **사람도**
그 PR을 머지할 수 없다(KTB-5/KTB-6가 그렇게 죽었다). 스펙이 바뀌어 기존 단언이 실제로 틀리는 일은
정상적으로 있고, 그때 필요한 것은 "머지 금지"가 아니라 "사람이 읽고 머지"다. L0(`integrityCheck`)는
GREEN을 유지하며 목록만 싣고, **L1(`merge-stage`)이 자동 머지를 거부**한다 — 기존 정책 거부 제목
옆에 네 번째 제목("기존 테스트의 수정·삭제")이 선다.

**추가만 있는 diff는 통과한다.** 새 테스트를 쓰는 것이 이 공장의 정상 업무다.

**예외는 이슈 본문의 표식 하나뿐이다.**

```
tests_changed_allowed:
- test/exporter.test.js
```

표식이 **어디 사는지**가 요점이다: 이슈 본문은 사람이 쓰고(또는 사람이 읽고 `factory:ready`를 붙이고)
PR diff는 에이전트가 쓴다 — 허가가 diff 안에 있으면 그 PR이 스스로를 허가한다. 그래서 파서는 오직
`ctx`로 넘어온 이슈 본문만 읽고(L1은 `gh.issue(issue).body`), 본문을 못 읽으면 허가가 없는 것으로
친다(fail closed). 허용된 파일은 위반이 아니라 **기록**으로 남는다(`tests_allowed`,
`tests-modified (allowed by issue)`) — "이 라운드에서 어떤 테스트가 왜 바뀌었나"를 사람이 그 자리에서
읽을 수 있어야 하기 때문이다.

L0와 L1은 `testsPolicy()` **한 몸**을 쓴다(additive-only와 같은 이유: 둘이 갈라지면 체크가 알리는
것과 머지가 막는 것이 달라진다). L1은 살아 있는 테스트 파일 전체에 `git diff -U0`를 **한 번만**
부른다. `tests_are_load_bearing = false`인 하네스에서는 규칙이 아예 돌지 않는다.

빌더 프롬프트(`factory-implement.js` rule 3)도 같은 말을 한다 — 이제 "부탁"이 아니라 "집행되는 규칙"
이라고, 그리고 예외가 이슈 본문에 있다고 적는다.

## 2. H3 — tier는 자기 신고였고, 그 신고가 자기 채점자를 골랐다

**있던 구멍.** `context.js`의 `tier = handoffs.triage?.tier ?? charter.tier_default` 한 줄이 리뷰
로스터와 계획 라운드를 정했다. 그 값을 적는 것은 triage 에이전트이고, 틀리는 방향은 언제나 **가벼운
쪽**이다. `tierFloor`(diff가 정하는 바닥)는 이미 있었지만 게이트 **레벨** 하나만 올렸고,
`tier_effective`를 읽는 소비처가 0곳이었다.

**판정.** `resolveTier()`가 단일 출처다:

```js
tier_effective = maxTier(triage tier, tierFloor(base...HEAD diff))
tier_source    = "triage" | "floor"      // 둘이 갈렸다는 사실 자체가 기록이다
```

이것을 읽는 곳: `rosterFor`(리뷰·계획 로스터), `planRoundsFor`(Task 9의 `mode`와 라운드 수),
`context.json`, 스테이지 handoff(`tier_effective`/`tier_source`를 러너가 덧쓴다 — 에이전트가 적은
`tier`는 자기 신고이고 이 둘은 diff에서 나온 사실이다), 그리고 **merge 스테이지의 `reviewRoster`**
(= 정족수의 출처). 신고값 `tier`는 지우지 않는다 — 신고와 실효가 갈린 이슈는 retro가 볼 신호다.

**diff를 못 읽으면 바닥은 `standard`다.** 판정 불가가 docs로 내려앉으면 감사가 지적한 구멍이 그대로
다시 열린다. `run`/`base`가 아예 주입되지 않은 호출은 "바닥을 묻지 않은 것"이라 신고 그대로이고
`tier_floor: null`이다 — 생산 경로는 둘 다 넘긴다(`bin/run-stage.js`, `bin/build-context.js`).
run-stage에서 merge-base를 못 구하면 런 레코드에 한 줄 남기고 진행하되, 곧이어 `gates` dep이 같은
`mergeBase()`로 `factory:blocked`를 올린다(스테이지를 두 번 죽이지 않는다).

**동시 작업과의 관계 — 머지할 때 지울 것.** 다른 작업이 run-stage/merge-stage에
`maxTier(triageTier, gates.json.tier_effective)`를 **임시로** 넣고 있다. 그 임시 계산은 이 브랜치를
머지할 때 **삭제해도 된다(삭제해야 한다)**: `reviewRoster`가 이제 `resolveTier`로 같은 값을 직접
계산하고, 그 값은 `gates.json`(= PR head가 만든 파일)이 아니라 base와 diff에서 나온다.

## 3. M12 — `docs` tier는 문서에만 적용된다

`DOC_GLOBS = ["docs/**", "*.md"]`는 `docs/factory/CHARTER.md`(판정 기준 그 자체)를 문서로 읽었다.
이제 `tierFloor`는 두 목록을 더 본다:

- `NEVER_DOCS_GLOBS = [".claude/**", "templates/**", ".factory/**", ".github/**", "factory/**"]`
  — 설정·프롬프트·워크플로·템플릿·팩토리 소스. `.md`여도 문서가 아니다.
- `[protected].factory` 글롭 — 저장소마다 다른 "사람이 머지해야 하는 경로"는 정의상 docs tier가
  아니다(그 diff는 사람이 읽어야 하는 diff다). `docs/factory/CHARTER.md`가 여기서 걸린다.

둘 다 **바닥을 올리기만** 한다. 진짜 문서(`docs/features/…`, `README.md`,
`docs/factory/audit/…`)는 그대로 docs다.

## 4. `[load_bearing].paths` — 설치된 레이아웃을 가리켜야 한다

감사가 짚은 드리프트: 이 저장소의 소스는 `factory/lib/…`인데 스테이지가 실행하는 설치본은
`.factory/lib/…`다. 한쪽만 적으면 목록은 그럴듯한데 매치가 0이고, 그러면 tier 바닥이 **조용히**
사라진다. 오타·파일 이동·레이아웃 드리프트가 전부 같은 모양으로 나타난다.

doctor에 `load-bearing.paths-exist`가 생겼다:

| 상태 | 등급 | 뜻 |
| --- | --- | --- |
| 매치가 0인 경로가 있다 | **FAIL** | 그 경로를 건드리는 PR이 load-bearing이 아니게 된다 |
| 목록이 비어 있다 | **WARN** | 어떤 PR도 load-bearing이 될 수 없다(신규 저장소의 정상 상태) |
| 전부 매치한다 | PASS | |

`[protected]`의 글롭 판정과 **반대**인 것이 의도다: 보호 경로의 와일드카드는 "미래의 경로 모양"을
막아 두는 것이라 지금 매치가 없어도 정상이지만, load-bearing 경로는 **지금 존재하는 코드**를 가리켜야
바닥이 선다.

- **KTB 자신**: 소스 4개 + 설치본 4개(`.factory/lib/{integrity,merge-stage,labels}.js`,
  `.factory/bin/run-stage.js`)를 모두 적는다. 미러만 고치는 diff도 load-bearing이다.
- **템플릿**: `paths = []` 그대로 두되(채택 저장소의 하중 경로는 그 저장소의 코드다 —
  `/know-thy-build:harness`가 채운다), 주석이 "**설치된 레이아웃 그대로** 적어라, 남의 레이아웃을
  베끼면 매치가 0이 된다"고 말한다. 빈 목록은 이제 WARN으로 소리를 낸다.

## 5. 알려진 한계 / 후속

1. **미러가 낡았다.** 이 브랜치는 `factory/lib/**`·`templates/**`를 고쳤지만 속도 규칙에 따라
   `factory init --upgrade`를 돌리지 않았다 — 통합 시점에 미러를 재생성해야 한다
   (`self-mirror.test.js`가 그것을 요구한다).
2. **워크플로 프롬프트는 아직 신고 tier를 보여 준다.** `factory-review.js`/`factory-plan.js`의
   `loaded.tier`는 declared 값이라, 로스터는 4명인데 프롬프트에는 "tier docs"라고 적힐 수 있다.
   Task 5가 `factory-loader`를 걷어내며 `context.json`을 직접 읽게 되므로, 그때 `tier_effective`로
   바꾸는 것이 자연스럽다(판정에는 영향이 없다 — 로스터·라운드는 이미 실효 tier로 뽑힌다).
3. **`tier_source` 어휘가 두 벌이다.** `gates.json`은 `declared`/`promoted-by-diff`,
   `context.json`/handoff는 `triage`/`floor`를 쓴다. 둘을 한 어휘로 합치는 것은 판정 파일 스키마를
   건드리는 일이라 이 Task의 범위 밖으로 둔다.
4. **`tests_changed_allowed:`는 글롭을 받는다.** `test/**/*.test.js` 한 줄로 모든 테스트를 열어 줄 수
   있다 — 사람이 이슈에 그렇게 적으면 그것이 사람의 결정이다. 다만 표식이 그렇게 넓으면 리뷰에서
   보이도록 `tests_allowed` 기록에 파일별로 남는다.
