# Audit response — Task 3: gates are gates (H2, P1-5/6/7, M3, M4)

> ADR-023 초안 텍스트. `DECISIONS.md`에는 이 파일이 합쳐질 때 옮긴다(계획 Task 3 요구 6).
> 대상 감사: `docs/factory/audit/2026-09-14-external-audit.md` (평가 커밋 `2ab390c`).

## Context

감사는 실측 한 줄로 게이트 계층 전체를 무효화했다:

```
status=GREEN misconfigured=prove-test,new-test-repeat,diff_coverage,mutation
```

네 개의 게이트가 "설정이 잘못돼 돌지 못했다"고 스스로 말하는데 판정은 GREEN이었다. 원인은 서로를
받쳐 주는 다섯 개였고, 다섯 개가 겹치면 **실효 게이트는 `unit` 하나**가 된다.

1. `recomputeStatus`가 `misconfigured`를 판정에 쓰지 않았다 — required가 아니면 무시.
2. `required`를 `names.includes(n)`으로 걸러, 레벨 목록에 없는 required 게이트는 "확인 대상 아님"이
   되었다(required 8개 중 다섯 개가 한 번도 돌지 않은 PR이 GREEN).
3. `prove-test`/`new-test-repeat`가 레벨 목록 밖에서 **사후 주입**돼, 애초에 required가 될 수 없었다.
4. `harness.toml`의 `fast`/`full`/`deep`이 글자 그대로 같았고 `lint = "node -e 0"`이었다 —
   tier→level이 아무것도 정하지 않고, lint는 항상 통과했다. **그 구성 그대로 템플릿이 배포됐다.**
5. `gates.test.js`의 단언들이 위 동작을 "정답"으로 고정하고 있었다.

여기에 격리·flaky 쪽 두 개가 더 붙는다: base 5/5 실패도 `flaky-existing`으로 불려 제외됐고(M3),
격리는 스테이지·PR을 가리지 않고 RED를 GREEN으로 뒤집었다(M4).

## Decision

**게이트는 fail-closed다. 모르면 GREEN이 아니다.** 일곱 개의 규칙으로 옮긴다.

### 1. `misconfigured`가 하나라도 있으면 `MISCONFIGURED` (H2, P1-5)
`recomputeStatus`: `misconfigured.length || requiredMissing.length → MISCONFIGURED`.
설정 오류는 "이 게이트가 무엇을 말하는지 모른다"는 뜻이고, 모르는 것은 통과가 아니다.
`bin/gates.js`는 그대로 exit 2, 커밋 상태는 `commitStatusState()` 한 함수로 모았다 —
**GREEN 하나만 `success`**이고 RED·MISCONFIGURED·BLOCKED·판정 없음은 전부 `failure`다.

### 2. `required`는 레벨 목록보다 강하다 (H2)
`names.includes(n)` 필터를 뺐다. required 게이트가 이번 레벨에서 돌지 않았으면 — 목록에 없어서든,
명령이 없어서든, SKIPPED로 남았든 — MISCONFIGURED다. **레벨을 가볍게 돌리고 싶으면 required에서
빼야 한다**: 빼는 것은 diff에 남지만, 무시되는 것은 아무 데도 남지 않는다.
doctor `gates.required-in-levels`가 짝을 맞춘다 — required는 **도는 모든 레벨**에 있어야 FAIL이 아니다.

### 3. 증명 게이트는 레벨의 정식 멤버다 (P1-6)
`prove-test`·`new-test-repeat`도 `diff_coverage`·`mutation`과 같은 `DEFERRED_GATES`다: 레벨 목록에
있으면 SKIPPED 자리를 먼저 잡고, 스테이지가 잰 뒤 그 자리를 채운다. 그래서 `required`가 이름을
부를 수 있고, **부를 수 있다는 말은 재지 못했을 때 MISCONFIGURED라는 뜻**이기도 하다
(예: review 스테이지는 prove-test를 돌리지 않는다 — 그것을 required로 선언한 하네스는 review에서 멈춘다).

### 4. 레벨은 서로 달라야 한다 (H2)
템플릿: `fast = [lint, unit]`, `full = fast + [prove-test, new-test-repeat]`, `deep = full`
(+ `integration`/`e2e`/`diff_coverage`/`mutation`은 설정되는 대로). doctor `gates.levels-identical`:
`full`이 `fast`에 아무것도 더하지 않으면 FAIL, `deep`이 `full`을 포함하지 않으면 FAIL,
`deep == full`인데 **설정은 되어 있으나 목록에 없는** 게이트가 있으면 FAIL. 신규 M0 저장소의
`deep == full`(더 설정된 것이 없음)은 PASS다 — 아무도 못 고치는 경고를 상시로 띄우지 않는다.

### 5. M0 강등은 조용하지 않다 (H2)
`MAX_LEVEL.M0 = "fast"`는 **유지한다**: 막 도입한 저장소가 아직 없는 도구를 요구받아 상시
MISCONFIGURED가 되면 아무도 M0을 지나가지 못한다. 대신 강등을 두 자리에 남긴다 — 판정 파일의
`downgraded_from`(이미 있던 필드)과 doctor `gates.m0-downgrade` WARN("full/deep에 적은 N개는
M1까지 한 줄도 돌지 않는다"). 설계된 강등과 조용한 강등의 차이가 이 한 줄이다.

### 6. no-op lint는 게이트가 아니다 (P1-7)
doctor `gates.lint-noop` FAIL: `node -e 0`, `node -e ""`, `true`, `:`, `exit 0`, 빈 문자열.
텍스트 판정이라 완전하지 않다(`node -e 'process.exit(0)'`는 못 잡는다) — 목표는 **관성**이다:
"린터 붙일 때까지"의 자리표시자가 그대로 배포돼 `lint GREEN`을 찍는 것을 막는 것.
KTB 자신의 lint는 `factory/bin/lint.js`로 교체했다(새 의존성 없음 — 이 저장소가 이미 가진 검사 셋):
`node --check`(바뀐 JS) + `factory/lib/yml-lint.js`(`.github/workflows/**`의 ADR-009/021 규칙)
+ `factory/lib/skill-md.js`(`templates/know-thy-build/*.md`). Workflow 툴 스크립트
(`**/claude/workflows/**`)는 최상위 `return`을 쓰는 함수 본문이라 `--check` 대상에서 뺀다
(그 계약은 `workflows.test.js`가 검사한다). 템플릿에는 "여기에 당신의 린터를 꽂아라"는 주석을 남겼다.

### 7. flaky와 격리에 상한과 경계를 준다 (M3, M4)
- **`broken-base`**: base 실행이 **전부** 실패하면 그것은 흔들림이 아니라 main이 빨간 것이다.
  `classify-failure.js`가 `introduced`/`broken-base`/`flaky-existing` 셋으로 나눈다. `broken-base`는
  제외 대상이 아니다 — 실패를 그대로 남겨 게이트를 RED로 두고, 게이트가 이유를 적는다
  (`main is red on <test>`), 판정에 `needs_human: true`와 `broken_base[]`가 붙고 verdict 줄에도 실린다.
  flaky 이슈는 열지 않는다(고칠 것은 이 PR이 아니라 main이다).
- **`flaky_max` (기본 2)**: 한 PR이 기존 테스트 셋·넷을 "원래 흔들리던 것"으로 밀어내며 통과한다면
  그건 격리가 아니라 판정 포기다. 넘으면 **하나도** 제외하지 않는다 — 부분 제외는 "어느 둘을
  봐준 것인가"라는 임의의 선택을 남긴다.
- **격리는 PR이 건드린 테스트를 뒤집지 못한다**: 실패한 테스트 파일이 diff에 있으면 격리 목록에
  있어도 제외하지 않는다(건드린 테스트를 자기가 면제하는 것은 자기 채점이다).
- **`quarantine_max_effective` (기본 3)**: 한 PR에서 격리가 RED→GREEN으로 뒤집을 수 있는 수의 상한.
- 제외든 거절이든 판정 파일에 남는다: `quarantine_applied[]`, `quarantine_refused[]`(사유 포함).

## Consequences (입양자에게 보이는 변화)

- **`required`에 적었으나 레벨 목록에 없던 게이트가 있던 하네스는 이제 MISCONFIGURED로 멈춘다.**
  이것이 이번 변경에서 가장 시끄러운 부분이고, 의도한 바다(그 게이트들은 원래 돌았어야 했다).
  고치는 길은 둘: 레벨 목록에 넣거나, required에서 빼거나. doctor가 `gates.required-in-levels`로
  머지 전에 알려 준다.
- `[gates.thresholds]`에 `flaky_max = 2`, `quarantine_max_effective = 3`이 추가된다(protected 섹션 —
  사람이 머지하는 PR로만 바뀐다). 기존 파일에 없으면 기본값이 적용된다.
- `[gates]` 레벨이 셋 다 같던 하네스는 doctor FAIL이 된다 — `full`에 증명 게이트를 더하는 것이
  가장 싼 해법이다(템플릿이 그렇게 한다).
- `lint`가 no-op인 하네스는 doctor FAIL이 된다.
- 판정 파일(`factory.gates.v1`)에 필드가 늘었다: `quarantine_applied[]`, `quarantine_refused[]`,
  그리고 해당될 때 `broken_base[]`/`broken_base_reason`/`flaky_over_cap`/`needs_human`.

## Evidence

감사가 고정했던 단언을 먼저 뒤집고(테스트가 빨개지는 것을 확인한 뒤) 코드를 고쳤다.
재현 → 수정으로 닫힌 항목: H2(①②③), P1-5, P1-6, P1-7, M3(broken-base·flaky 상한), M4(격리 두 규칙).
`factory/test/gates.test.js`, `classify-failure.test.js`, `doctor-harness.test.js`가 각각을 잡고 있다.

## Not done here

- `.factory/**` 미러(설치본)는 이 커밋에서 재생성하지 않았다 — `factory init --upgrade`가 별도로
  돌아야 `self-mirror` 테스트가 다시 초록이 된다(`factory/bin/lint.js`가 새 파일이다).
- 감사 H3/H4/H5(tier 자기 신고, cold_read, 테스트 변조)는 계획 Task 4·5의 몫이다.
