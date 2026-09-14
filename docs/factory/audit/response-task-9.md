# 감사 대응 Task 9 — plan 기본값은 단일 패스다 (P2-10/11의 결과)

- **감사 항목**: P2 — "plan 기본값을 베이스라인 실험의 결과로 정한다" (`docs/superpowers/plans/2026-09-14-factory-audit-hardening.md` Task 9)
- **근거**: `docs/factory/dogfood/2026-09-14-plan-baseline.md` (Task 7이 만든 대조 실험, n=4)
- **결과물**: `factory/lib/config.js`(`plan` 블록·`planRoundsFor`·`rosterFor`), `factory/lib/context.js`,
  `factory/lib/verify-stage.js`(`validatePlanHandoff`), `factory/lib/schemas.js`(선택 필드),
  `templates/factory/claude/workflows/factory-plan.js`(단일 모드), 두 CHARTER.
- 이 문서가 이 변경의 ADR 텍스트다 (ADR-023 "감사 하드닝"의 Task 9 절로 읽는다).

## 1. 결정 규칙은 발화하지 않았다 — 그런데도 바꾼다

Task 7이 ADR에 미리 적어 둔 결정 규칙은 이것이었다:

> 베이스라인 `done_when` ⊇ `must_fix`가 4개 중 **3개 이상**이면 plan R2·서명 라운드를 기본에서 제거한다.

엄격하게 적용한 결과는 **2.5/4 — 미발화**다(#8 공허참 ✅, #15 ✅, #18 △, #2 ❌). 그런데도 기본값을
바꾼다. 규칙이 재지 못한 것이 두 가지 있었기 때문이다:

1. **비용**: 팩토리 plan은 1패스 기준 **5.4×**, 이슈 전체(재실행 포함) 기준 **33.7×** 비쌌다
   ($270.26 vs $8.01). #8은 plan에만 $7.78을 쓰고 must_fix 0건을 얻었는데, $1.58짜리 1패스가 같은
   결과에 도달한다. 커버리지가 동률일 때 33배는 동률이 아니다.
2. **자해**: must_fix 15건 중 **5건(33%)이 계획이 스스로 발명한 `done_when` 때문에** 생겼다
   (M15-1, M18-1, M18-3, M2-7 + #8의 should_fix 4건). 라운드를 더 돌릴수록 `done_when`이 정교해지고,
   정교해진 `done_when`이 새 결함 표면이 됐다. 결정 규칙은 "계획이 요구를 **덮는가**"만 셌지
   "계획이 요구를 **만드는가**"를 세지 않았다.

그리고 규칙이 실패한 한 건(#2)의 성격이 남은 설계를 정했다: #2는 표본에서 **유일한 load-bearing
이슈**(저장소 최초의 영속 쓰기 경로 + 처음 고정되는 공개 와이어 계약)였고, 토론이 베이스라인을 이긴
곳도 거기뿐이었다(0.44 vs 0.31). 그래서 토론을 **끄지 않고 그 tier로 좁힌다**.

## 2. 무엇이 바뀌었나

### (1) 기본 = 단일 opus 1패스 + skeptic 1패스

CHARTER에 `plan` 블록이 생겼다:

```yaml
plan: { mode: single, debate_tiers: [load-bearing], max_done_when: 6 }
```

- `planRoundsFor(charter, tier)`가 이제 숫자가 아니라 **`{mode, rounds}`**를 돌려준다.
  `mode`는 `plan.mode === "debate"`거나 tier가 `debate_tiers`에 있으면 `debate`, 아니면 `single`.
  `rounds`는 여전히 숫자 하나다 — `verify-stage`의 `expectedRounds` 계약과 `plan.v1` 핸드오프
  스키마는 **한 글자도 바뀌지 않는다**(다운스트림 스테이지가 바뀌지 않는 것이 요구였다).
- 단일 모드의 로스터는 `plan_roles`가 아니라 `["synthesizer", "skeptic"]`이다
  (`plan_roles.single`로 갈아끼울 수 있다. 두 이름 모두 `roles.toml`에 있어야 한다).
  `plan_roles`는 이제 토론 tier에서만 읽힌다.
- 워크플로(`factory-plan.js`)의 단일 경로: **계획자 1패스**(opus, `plan.v1` 전문을 한 번에) →
  **skeptic 1패스** → 종합은 계획자 자신의 최종본이다(합성 에이전트 호출 없음, 서명 라운드 없음).
  skeptic의 출력 스키마에는 **삭제·수정 필드가 없다** — `risks`, `done_when`, `dissent`뿐이다.
  같은 id의 `done_when`을 다시 보내도 계획자의 문장이 이긴다. "추가만 한다"가 프롬프트의 부탁이
  아니라 **타입**인 것이 핵심이다.
- `context.json`에 없는 `plan` 블록(업그레이드되지 않은 미러)은 `debate`로 떨어진다 — 옛 동작
  그대로다. 조용히 load-bearing 계획을 1패스로 깎는 것보다 낫다.

### (2) plan 검증기 — 스크립트 집행 (`factory/lib/verify-stage.js`)

`verifyStage`가 `plan` 스테이지에서 `validatePlanHandoff`를 돌린다. 위반한 핸드오프는 **오늘
스키마를 통과하지 못한 산출물과 똑같이** 취급된다(스테이지 GREEN 없음 → 사람). 산문 규칙이 아니다.

| 규칙 | 사유 문구 | 왜 |
|---|---|---|
| (a) `severity >= medium`이거나 severity가 없는 `dissent_log` 항목은 어떤 `done_when`의 `covers: [id]`가 짚어야 한다 | `dissent without done_when: <ids>` | #2의 단일 원인. 팩토리는 M2-1을 **알고도** `open_risks`에 두었고, 리뷰가 9라운드 동안 같은 것을 다시 말했다. 재실행 3회·plan $118을 쓰고서야 `dw1`이 됐다. 인식은 계약이 아니다 |
| (b) `done_when.length <= charter.plan.max_done_when` (기본 6) | `done_when has N items (max M)` | must_fix의 33%가 계획이 발명한 done_when에서 나왔다 |
| (c) 가드 모양의 `done_when`은 이슈가 가드를 요구하지 않는 한 무효 | `guard-shaped done_when: <ids> — …` | #18 dw2(순서)·dw4(접두사 화이트리스트), #15 dw1–dw3이 리뷰어가 3라운드를 태운 바로 그 대상이다 |

id가 없는 `dissent_log` 항목은 위치로 부른다(`d1`, `d2`, …) — 검증기가 id를 발명하는 게 아니라
사람이 셀 수 있는 이름을 준다. `done_when.covers`와 `dissent_log`의 `id`/`severity`는 스키마에서
**선택** 필드이고(옛 핸드오프는 그대로 통과한다), 요구하는 것은 검증기다.

### (3) 가드 휴리스틱은 **알려진 조잡한 필터다**

(c)의 판정은 `done_when.text`에 대한 문구 매칭이다. 현재 목록
(`GUARD_SHAPED_PATTERNS`, `factory/lib/verify-stage.js`):

```
whitelist | allowlist | 화이트리스트
must not appear | 등장하지 않는다 | 나타나지 않는다
only these files | 이 파일들만
regex over | 정규식으로 훑 | 정규식으로 검사
ordering of sections | 순서를 (강제|검사|요구)
line layout | 줄 배치
every file in the repo | all files in the repo | repository-wide | 저장소 전체의 파일
```

**거짓 양성과 거짓 음성이 둘 다 가능하다.** "ordering of sections"라고 썼지만 가드가 아닌 계획은
막히고, 같은 것을 다른 말로 쓴 계획은 통과한다. 이 목록은 실측(#15·#18에서 **실제로** must_fix를
만든 done_when)에서 뽑았을 뿐 분류기가 아니다. 그래서 탈출구를 사람의 판단이 아니라 **이슈 본문**에
뒀다: 본문에 `guard` / `가드` / `[guard]`가 있으면 규칙 전체가 면제된다 — 가드를 원한 이슈는 그 말을
쓰게 된다. 다음 표본에서 거짓 판정이 나오면 **목록을 고치지 규칙을 끄지 않는다**.

## 3. 재측정 조건 (n≥10)

이 판단의 표본은 **n=4, 그중 load-bearing 1건**이다. 베이스라인 문서가 스스로 적어 둔 한계가
그대로 남아 있다: must_fix는 계획이 아니라 **구현된** 것을 리뷰어가 판정한 결과이므로 "회피" 판정
4건은 계획 텍스트만이 근거이고, #2 스냅샷은 비대칭이며, 비용 비교는 실측 청구액 대 토큰 추정이다.

- **되돌림 조건**: load-bearing 이슈 **3건 이상**을 같은 프로토콜로 A/B하기 전까지 (1)의 토론 축소를
  되돌리지 않는다(현재 load-bearing n=1).
- **재측정 조건**: plan을 태운 이슈가 **n≥10** 쌓이면 같은 대조를 다시 돌린다. 볼 것 셋 —
  ① 단일 모드에서 리뷰 라운드 수가 늘었는가(토론이 사던 "인식"을 정말 잃었는가),
  ② 계획 유발 must_fix 비율이 33%에서 내려갔는가(상한 6과 가드 금지가 실제로 들었는가),
  ③ 검증기 (a)가 반려한 계획이 재실행에서 정말 더 나아졌는가, 아니면 반려가 라운드만 늘렸는가.
- ③이 "라운드만 늘렸다"로 나오면 (a)는 규칙이 아니라 경고로 내린다. ②가 안 내려가면 상한을
  6보다 낮춘다(값 자체는 CHARTER가 들고 있으므로 코드 변경이 아니다).

## 4. 남는 위험

- **단일 모드는 skeptic 한 번에 전부를 건다.** 그 패스가 죽으면(두 번 null) 계획은 계획자의 1패스
  그대로 나간다 — 토론 모드의 "역할 하나가 빠져도 나머지가 돈다"에 해당하는 완충이 없다. 대신
  실패가 조용하지 않다: `debate.skeptic_added: null`이 핸드오프에 남는다.
- **`synthesizer`가 `roles.toml`에 없는 채택 저장소**는 plan 스테이지에서
  `roster names not defined in roles.toml: synthesizer`로 즉시 죽는다(조용한 폴백 없음). 템플릿
  `roles.toml`에는 있으므로 `factory init`로 설치한 저장소는 해당 없다.
- **검증기는 `covers`의 **내용**을 읽지 않는다** — dissent id를 짚기만 하면 통과한다. "그 done_when이
  정말 그 위험을 막는가"는 여전히 spec-conformance 리뷰어의 몫이고, 스크립트가 살 수 있는 것은
  "짚었는가"까지다.
