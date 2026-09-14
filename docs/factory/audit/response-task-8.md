# Task 8 — 스테이지는 PR의 코드를 돌고, 팩토리 자신의 설정은 base의 것을 쓴다 (KTB-37)

> 감사 계획: `docs/superpowers/plans/2026-09-14-factory-audit-hardening.md` Task 8 (P0).
> 발견 경로: 도그푸딩 KTB #3 → 하네스 이슈 #9, 2026-09-14 08:58Z.

## 1. 증거 — 무엇이 관측됐나

`factory/bin/run-stage.js`의 `makeCheckoutHead`는 review·merge 스테이지가 게이트를 돌릴 커밋을
implement handoff의 `head_sha`에 고정하려고 `git checkout --detach <head_sha>`를 한다. 그 다음
`claude -p`가 뜬다. 그런데 `claude -p`가 읽는 것들은 전부 **워킹 트리**에서 온다:

- `--settings .factory/ci-settings.json`(L2 경로 deny 목록)
- `.claude/hooks/*`(PreToolUse 훅 — 보호 경로 거부, 위험 명령 차단)
- `.claude/settings.json`(훅 배선)
- `.claude/agents/*.md`(리뷰어·플래너 프롬프트)
- `docs/factory/CHARTER.md`(예산·한계)

detach 뒤의 워킹 트리는 **PR의 것**이므로, 이 다섯 가지도 PR의 것이었다. 결과는 둘이다.

**(1) 하네스 수정이 열린 PR에 영원히 닿지 않는다.** KTB #3의 PR head는 KTB-36(CI deny 목록이
`.factory/out/qa`를 qa 증거용으로 열어 두는 수정)보다 앞선다. main에 그 수정이 들어간 뒤에도 #3의
review는 **낡은 deny 목록**으로 돌았고, 같은 자리에서 같은 이유로 다시 막혔다. 고칠 방법이 없었다 —
수정을 받으려면 PR이 main을 리베이스해야 하는데, 그 리베이스를 하려면 PR이 한 라운드 더 돌아야 하고,
그 라운드가 또 낡은 설정으로 돈다.

**(2) 보안: 에이전트 PR이 자기 리뷰의 심판을 고를 수 있다.** `.claude/hooks/*` · `.claude/settings.json` ·
`.factory/ci-settings*.json` · `.claude/agents/*.md`(리뷰어 프롬프트) · `.factory/lib/*`를 바꾼 PR은
**자기 자신의 review·implement 스테이지를 그 변조된 설정으로 실행시킨다**. 보호 경로(`[protected]`)는
그런 PR의 **머지**를 사람 손에 맡기지만, 스테이지는 그 전에 이미 돌아 버린 뒤다 — 사람이 보는 것은
"리뷰가 승인한 PR"이고, 그 리뷰는 PR이 써 준 프롬프트와 훅으로 돌았다.

두 결과 모두 이미 알려진 문제의 일반형이다: 워크플로의 스크럽·정리·sweep 스텝은 같은 이유로
`git checkout ${{ github.sha }} -- .factory || true`를 앞세우고 있었다(스펙 §4.1 주석). 즉 "정리 코드만은
언제나 base의 것"이라는 규칙은 이미 있었고, **스테이지 자신에게는 적용되지 않았다.**

## 2. 무엇이 바뀌었나

`factory/bin/run-stage.js`:

- `resolveStageSha({ run, root, env, defaultBranch })` — 이 스테이지 **자신의** 커밋. CI는 `GITHUB_SHA`
  (이벤트 sha = 기본 브랜치 tip), 로컬은 `origin/<default_branch>`. 40-hex가 아닌 `GITHUB_SHA`는 거부한다
  (ref 이름은 `git checkout <rev> -- <pathspec>`의 `<rev>` 자리에서 모호해질 수 있다).
- `makeFactoryOverlay({ run, root, env, defaultBranch })` — 그 커밋에서 팩토리 소유 경로만 덮어쓴다:

  ```
  git checkout <stage sha> -- .factory ':(exclude).factory/out' .claude docs/factory/CHARTER.md
  ```

  `.factory/out/**`은 제외한다 — 그건 설정이 아니라 **이 런이 지금 만들고 있는 산출물**이다
  (`gates.json`, `context.json`, 스테이지 출력, qa 증거). 커밋이 들고 있지 않은 경로는 pathspec에서
  빼고 넘긴다(어댑터 레포에 `.claude/`가 없을 수 있다; 없는 경로 하나가 `git checkout`을 통째로
  실패시킨다). 덮은 뒤 `git status --porcelain -- <pathspec>`으로 **실제로 무엇이 덮였는지** 읽어
  돌려준다.
- `runStage`: `checkoutHead`(review·merge의 detach) **직후**, implement는 빌더를 띄우기 전에 overlay를
  돌린다. 런 기록에 한 줄이 남는다:

  ```
  overlay: 2 path(s) from 1a2b3c4 (GITHUB_SHA) — .factory/ci-settings.json, .claude/hooks/block-dangerous.sh [.factory/** (except .factory/out/**), .claude/**, docs/factory/CHARTER.md]
  ```

  덮을 것이 없으면 `overlay: clean — factory config already at 1a2b3c4 (…)`.
- **fail closed.** sha를 못 구하거나, 커밋이 팩토리 경로를 하나도 안 들고 있거나, `git checkout`/`git status`가
  실패하면 스테이지는 진행하지 않는다 — `factory:blocked`(GREEN도 RED도 아닌 "판정 불가"의 자리)로 전이하고
  `overlay: FAIL — <사유>`를 기록한 뒤 exit 2. PR head 설정으로 도는 스테이지는 없다.
- **implement 커밋은 overlay를 실을 수 없다.** implement는 유일한 쓰기 스테이지이고, 커밋은 빌더가
  세션 안에서 직접 한다(`git add -A`일 수 있다 — 팩토리가 가로챌 수 있는 자리가 아니다). 그래서 규칙을
  뒤집었다: implement에서 overlay가 **실제로 파일을 바꿨다면** 그것은 워크플로가 준 트리가 스테이지
  자신의 커밋이 아니었다는 뜻이고, 그때는 빌더를 **띄우지 않는다**(blocked). 정상 경로에서 이 overlay는
  언제나 no-op이다 — `factory-implement.yml`의 `actions/checkout`은 이벤트 sha(= base)를 체크아웃하고,
  overlay는 그 트리를 자기 자신으로 덮기 때문이다. 덮을 것이 없으면 커밋에 실릴 것도 없다.
- **쓰기 금지 스테이지의 클린 체크와의 관계.** review는 `claude -p` 뒤에 워크트리가 깨끗한지 다시
  묻는다(KTB-14). overlay가 덮은 경로는 팩토리가 만든 diff이므로 더러움으로 세면 안 된다 — 그래서
  `assertNoWriteStageClean({ …, allow })`에 **그 순간 덮인 정확한 파일 이름들**만 허용 목록으로 넘긴다
  (`.claude/**`를 통째로 여는 것이 아니다). 그 파일들이 세션 **중에** 또 바뀌지 않았다는 것은
  `overlayDrift`가 sha와 직접 비교해 따로 증명한다(`git diff --name-only <sha> -- <overlay 경로>`,
  diff 자체가 실패하면 fail closed). 이 두 겹이 없으면 `.claude/**`를 정당하게 고치는 PR(하네스 승격
  PR 등)이 review 단계에서 전부 needs-human으로 떨어져 **리뷰조차 받지 못한다.**

무결성·보호 경로 판정은 **영향이 없다**: `integrity.js`/`protectedPaths`/`policyViolations`는 워킹 트리를
읽지 않고 `git diff --name-status <base>..HEAD`와 `git show <base>:<file>`로 판정한다(그 자체가 KTB-6/KTB-14의
설계다). overlay는 워킹 트리만 바꾸고 HEAD도 base도 건드리지 않는다 — 테스트에 이 불변식을 명시했다.

## 3. 왜 PR head 설정이 구멍이었나 — 한 문장

스테이지는 **PR의 코드를 심판하는 자리**인데, 그 심판의 규칙·훅·프롬프트·예산을 **피심판자가 들고
왔다**. 보호 경로는 그 PR의 머지를 사람에게 넘기지만, 사람이 보는 판결문은 이미 변조된 규칙으로 쓰인
뒤였다.

## 4. 어댑터 영향

- **동작 변화:** review·merge·implement 스테이지가 시작할 때 `.factory/**`(단 `out/**` 제외) ·
  `.claude/**` · `docs/factory/CHARTER.md`가 base의 것으로 되돌아간다. PR이 이 경로들을 고쳤더라도
  **그 변경으로 스테이지가 돌지 않는다**(머지 뒤 base에 들어간 다음 런부터 적용된다). 이것이 하네스
  승격 PR의 정상 흐름이다: PR은 diff를 만들고, 사람이 머지하고, **그 다음** 런이 새 설정으로 돈다.
- **새로 막히는 경로:** 워크플로를 고쳐 PR head를 체크아웃하도록 바꾼 어댑터의 implement 잡은 이제
  `factory:blocked`로 선다(overlay가 덮을 것이 생기므로). 의도된 거부다 — 그 배선에서는 빌더의 커밋이
  팩토리 설정을 PR에 실어 나른다.
- **로컬 실행:** `factory run <stage> <issue>`는 `GITHUB_SHA`가 없으므로 `origin/<default_branch>`를
  쓴다. `origin`이 없는 체크아웃(예: 아카이브에서 푼 트리)에서는 스테이지가 blocked로 선다 —
  `git fetch origin` 한 번이면 풀린다.
- **필요한 조치:** 없음. `npx know-thy-build factory init --upgrade`로 `.factory/bin/run-stage.js`
  미러를 갱신하면 된다.

## 5. 테스트

`factory/test/run-stage-overlay.test.js` (17):

- overlay가 스테이지 sha에서 경로를 복원하고 `.factory/out/**`은 건드리지 않는다(pathspec에 `:(exclude)`).
- 커밋이 안 들고 있는 경로는 조용히 빠진다(어댑터 레포에 `.claude/`가 없는 경우).
- fail closed 네 갈래: checkout 실패 · sha 해석 실패 · `GITHUB_SHA`가 sha 모양이 아님 · 커밋이 팩토리
  경로를 하나도 안 들고 있음.
- base sha의 로컬 해석(`origin/<default_branch>`)과 CI 해석(`GITHUB_SHA`).
- `overlayDrift`: 세션 중 덮인 파일을 다시 고치면 잡힌다 / `git diff` 실패는 fail closed.
- `assertNoWriteStageClean`: overlay가 덮은 경로만 허용되고 그 밖은 여전히 더럽다.
- 배선: review는 detach → overlay → `claude -p` 순서로 돌고 무엇을 덮었는지 한 줄을 남긴다 · overlay
  실패는 `claude -p`를 띄우지 않고 blocked · 덮인 경로가 클린 체크로 넘어간다 · merge도 detach된 트리
  위에서 overlay를 돈다 · implement는 clean overlay면 진행하고, 덮을 것이 있으면 빌더를 띄우지 않는다
  (= implement 커밋이 `.claude/**`·`.factory/**`를 실을 수 없다).

## 6. 남은 위험

- **rework 라운드의 세션 내 체크아웃.** implement 빌더는 세션 **안에서** 자기 브랜치를 체크아웃한다
  (`claude/fq-<issue>`, 빌더 규칙 1). 그 브랜치가 `.claude/hooks/*`를 변조해 들고 있으면, 세션 도중에
  디스크의 훅 스크립트가 PR의 것으로 바뀔 수 있다(`--settings`와 훅 배선은 세션 시작 시점의 것이지만,
  훅 **스크립트**는 호출마다 디스크에서 읽힌다). 완전한 봉쇄는 스테이지가 브랜치 체크아웃을 직접
  소유해야 가능하다 — 이 Task의 범위 밖이고, 후속으로 남긴다. 지금의 방어선은 (a) 세션 **시작** 설정이
  언제나 base의 것이고, (b) 그런 PR은 보호 경로 때문에 사람이 머지하며, (c) review 스테이지는 detach된
  트리 위에서 overlay를 다시 받는다는 것이다.
- triage·plan은 overlay를 돌지 않는다 — PR 이전 스테이지라 워킹 트리가 언제나 base다. 그 전제가
  깨지는 배선(PR ref를 체크아웃하는 커스텀 워크플로)에서는 이 Task가 막아 주지 않는다.
