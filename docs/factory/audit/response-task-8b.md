# 감사 대응 Task 8b — 브랜치 체크아웃은 스테이지의 것이다 (KTB-37의 잔여, 원 감사 항목 없음)

- **출처**: ADR-023 Task 8의 "알려진 한계" + "남은 것"의 Task 8b — `docs/factory/DECISIONS.md`
- **결과물**: `factory/bin/run-stage.js` · `factory/hooks/block-dangerous.sh` ·
  `templates/factory/claude/workflows/factory-implement.js` ·
  `templates/factory/claude/agents/factory-builder.md` · 스펙 §4.2.1 step 2.3·step 4 ·
  `factory/test/run-stage-branch.test.js`(신규) · `factory/test/hooks.test.js`
- **현재 텍스트**: ADR-023, "Task 8 — 스테이지는 자기 자신의 설정으로 돈다" 절의 **Task 8b** 문단.

## 구멍

KTB-37(Task 8)은 스테이지 **시작** 시점에 팩토리 소유 경로를 스테이지 자신의 커밋으로 고정했다.
그런데 implement 빌더는 `claude -p` 세션 **안에서** 자기 브랜치를 체크아웃했다 — 커맨드 템플릿의
규칙 1이 "create it if it does not exist, otherwise check it out"이라고 지시했기 때문이다.

`--settings`가 가리키는 파일과 훅 **배선**은 세션이 뜰 때 굳는다. 그러나 훅 **스크립트**는
`PreToolUse`가 걸릴 때마다 디스크에서 읽히고, `.claude/settings.local.json`·`CLAUDE.md`·`.factory/**`도
그 순간의 디스크가 전부다. 곧 rework 라운드에서 체크아웃이 일어나는 그 순간부터, 세션의 나머지는
**PR이 쓴 훅**으로 판정된다. overlay가 세션 시작 시점에 무엇을 깔아 두었든 상관이 없다 — 세션 도중에
갈렸고, 그 사실은 세션이 끝난 뒤의 drift 검사에서야 드러난다(그때는 이미 늦다).

## 수정 — 순서가 전부다

**브랜치 체크아웃 → overlay(+PR 추가 파일 제거 + drift) → 빌더.**

1. `makeCheckoutBranch`(§`run-stage.js`): 원격에 `claude/fq-<issue>`가 있으면
   `git fetch origin +refs/heads/<b>:refs/remotes/origin/<b>` 후 `git checkout -B <b> origin/<b>`,
   없으면 스테이지 자신의 커밋(`GITHUB_SHA` / `origin/<default_branch>`)에서 `git checkout -b`.
   "원격에 있는가"를 **fetch의 종료 코드로 묻지 않는다**(`ls-remote`로 따로 묻는다): 네트워크 실패와
   "없는 브랜치"가 같은 코드로 오고, 그 둘을 섞으면 rework 라운드가 조용히 새 브랜치에서 시작해 지난
   라운드를 통째로 버린다. 원격에 없는데 **로컬에만** 있으면 진행하지 않는다 — `-B`는 push되지 않은
   커밋을 말없이 지운다. 모든 실패는 `factory:blocked`(원인은 대개 러너 쪽이라 재시도로 풀린다).
2. 빌더 프롬프트에서 체크아웃 지시가 사라졌다. 그 자리에는 사실이 들어간다: **"You are ALREADY on
   the branch"**, 그리고 "`git checkout`·`git switch`·`git fetch`·`git reset --hard`·`git stash`를
   쓰지 말 것 — 훅이 막는다". `factory-builder.md`의 "You must not"에도 같은 항목이 생겼다.
3. 훅(`block-dangerous.sh`)이 그 문장을 강제한다. 두 층이다.
   - **스테이지 세션에서만**(`FACTORY_STAGE`): `git switch` 전부, 그리고 `--` pathspec이 없는
     `git checkout <ref>` 전부. `git checkout -- src/x.js`(파일 복원)는 그대로 열려 있다.
     `FACTORY_STAGE`는 `run-stage.js`가 `claude -p`의 env에 심고, 세션은 그것을 지울 수 없다 —
     훅은 Claude Code가 **세션 env**로 띄우는 프로세스라 명령줄의 `VAR= git …` 접두사가 닿지 않는다.
     사람의 자기 세션에는 이 변수가 없다: `know-thy-build` 스킬들이 사람에게 `gh pr checkout <pr>` →
     `git switch -`를 시키고, 그 흐름은 이 계약과 아무 상관이 없으므로 건드리지 않는다.
   - **세션 여부와 무관하게**: overlay 뿌리(`.factory/`·`.claude/`·`CLAUDE*.md`·`AGENTS*.md`·
     `.mcp*.json`·`docs/factory/CHARTER.md`)를 다른 커밋의 것으로 덮는 `git checkout <ref> -- <path>`·
     `git restore --source=<ref> <path>`, 그리고 트리 전체를 갈아 끼우는 `git reset --hard`와
     `git stash`(맨몸 push·`pop`·`apply`·`save`·`branch`). `git stash list|show|drop`,
     `git reset --soft|<pathspec>`은 워킹 트리를 건드리지 않으므로 통과한다.
     이 뿌리는 `factory:harness` 이슈에서도 **열리지 않는다** — KTB-20의 카브아웃이 여는 것은 파일
     *편집*이지, 세션 설정을 다른 커밋의 것으로 바꾸는 일이 아니다.
   표 테스트는 이 저장소의 프레임워크가 이미 덮는 우회를 그대로 다시 돈다: 래퍼(`sh -c`, `eval`),
   `\`+개행 이음줄, git 전역 옵션(`-C`, `--git-dir=`, `-c k=v`), 명령 치환(`out=$( … )`),
   백슬래시 이스케이프(`\git`), ANSI-C 인용(`$'git'`).
4. **세션 뒤**: `git rev-parse --abbrev-ref HEAD`가 아직 그 브랜치인가(detach = `HEAD`도 실패다),
   그리고 팩토리 소유 경로가 아직 스테이지 커밋과 바이트 동일한가(`overlayDrift` 재실행). 어느 쪽이든
   아니면 그 세션이 무슨 설정으로 무엇을 판단했는지 알 수 없다 — **판정 불가**이므로 `factory:blocked`,
   그리고 게이트도 verify도 돌지 않는다(산출물을 받지 않는다). 훅이 못 보는 철자(런타임 조립,
   ADR-020 잔여 위험 #4)가 남아 있는 한 이 백스톱이 마지막 층이다.

## 남는 판정 하나 (의도된 거부)

스테이지가 체크아웃한 브랜치가 팩토리 소유 경로를 base와 다르게 들고 있으면 — `.claude/**`를 고친
PR의 rework 라운드, 또는 `factory:harness` 이슈의 두 번째 라운드 — overlay가 실제로 파일을 바꾸고,
그 자리의 규칙은 KTB-37 그대로다: **빌더를 띄우지 않는다**(`factory:blocked`). 대안이 둘뿐이기
때문이다. 세션을 PR의 설정으로 돌리거나(이 Task가 닫으려는 바로 그것), 빌더의 `git add -A`가
overlay의 되돌림을 PR에 실어 PR 자신의 변경을 말없이 지우거나. 어느 쪽도 스테이지가 고를 일이
아니다 — 그런 PR은 `[protected]` 때문에 어차피 사람이 머지하므로, 그 라운드도 사람에게 넘긴다.

**비용**: 하네스 이슈의 rework 라운드는 이제 사람 손을 한 번 거친다. **얻는 것**: PR이 쓴 훅으로
자기 자신을 심판하는 세션이 이 저장소에 더는 존재하지 않는다.

---

## 후속 ① — 하네스 이슈의 rework가 자기 `harness.toml`을 잃지 않는다 (회귀)

위 "남는 판정 하나"를 그대로 두면 `factory:harness` 이슈는 **한 라운드 이상 갈 수 없다**. 그 이슈의
rework 라운드는 **정의상** `.factory/harness.toml`을 고친 브랜치 위에서 돈다(그 파일을 고치는 것이 그
이슈의 일이다). 스테이지가 체크아웃을 가져간 지금, overlay는 그 편집을 base로 되돌리고 —
`overlaidPaths`가 비지 않으니 — implement는 빌더를 띄우지 않는다. 하네스 승격은 게이트를 새로 세우는
일이라 1라운드에 끝나는 쪽이 예외이므로, 이 규칙은 사실상 승격 기능 자체를 막는다. 비용을
"사람 손 한 번"으로 적었지만 실제 비용은 "그 기능은 못 쓴다"였다.

**수정**: `FACTORY_HARNESS_ISSUE=1`인 implement에서 overlay가 **`HARNESS_OPENS`를 제외한다**.

- 목록의 출처는 하나다 — `factory/lib/protected-paths.js`의 `HARNESS_OPENS`. L2 deny
  (`ci-settings-harness.json`)·훅의 `prot`·overlay가 같은 문장을 말한다(갈라진 목록이 M8이었다).
- 제외는 **네 자리 전부**에 들어간다: 덮는 `git checkout <sha> -- …`, PR이 추가한 파일 스캔
  (`diff --diff-filter=A`), 무엇이 덮였나(`status`), 그리고 `overlayDrift`(세션 **전**과 **후** 양쪽).
  하나라도 빠지면 그 자리가 다시 빌더를 막거나(전) 라운드를 판정 불가로 떨어뜨린다(후).
- 나머지는 그대로 base의 것이다: 훅 스크립트 · `.claude/settings*` · 에이전트 프롬프트 ·
  `ci-settings*.json` · `docs/factory/CHARTER.md` · `CLAUDE*.md`/`AGENTS*.md`/`.mcp*.json`.
  `.claude/hooks/x.sh`를 고친 하네스 브랜치는 **예전 그대로 blocked**이다 — 카브아웃은 정확히
  `HARNESS_OPENS`까지다.

**무엇이 남아 지키는가**: ① `harness.toml`의 위험한 섹션은 L1의 섹션 검사(Task 1 — `[protected]`·
`[gates.thresholds]`·`[load_bearing]` 편집 → 사람 머지)가 본다. ② 이 런이 자기 판정에 쓰는 harness는
체크아웃 **전에** `charterReady`가 읽어 메모리에 있다 — 브랜치의 파일이 이번 런의 임계값이나 보호
목록을 바꾸지 못한다. ③ 그 PR의 머지는 어차피 사람이다(`[protected]`).

## 후속 ② — KTB-38: 낡은 PR 위에서 도는 rework는 base의 도구를 들고 돌아야 한다

**실측**(KTB #3 R5, 2026-09-14): PR #4의 head는 1.2.0 **이전**이라 트리에 `factory/bin/lint.js`가
없었다. 그런데 overlay가 깔아 준 base의 `.factory/harness.toml`은 바로 그 파일을 부르는 lint 명령을
들고 있었다 — 게이트가 통째로 RED였고, 빌더는 자기 diff와 무관한, 자기가 고칠 수도 없는 실패를
라운드마다 다시 봤다. Task 8이 **설정을 base로 고정한 순간부터 이것은 구조적 결과다**: 설정은 base인데
트리는 낡은 PR이면 그 둘이 가리키는 파일 집합이 갈라진다.

**수정**: `makeCheckoutBranch`가 **기존 브랜치**를 체크아웃한 직후 base를 얹는다.

1. `git merge-base --is-ancestor <stage sha> HEAD`로 먼저 묻는다 — 이미 들고 있으면 아무것도 하지
   않는다(빈 머지 커밋을 라운드마다 쌓지 않는다). 0/1이 아닌 종료 코드는 답이 아니라 고장이라
   진행하지 않는다.
2. `git -c user.name=factory -c user.email=<FACTORY_BOT_LOGIN 또는 factory-bot>@users.noreply.github.com
   merge --no-edit --no-ff <stage sha>`.
3. 성공하면 **빌더가 뜨기 전에** `git push origin claude/fq-<n>`. 빌더가 아무것도 바꾸지 않는
   라운드에도 PR head가 이 머지를 반영해야 review·merge가 같은 트리를 본다 — 빌더의 push는 빌더의
   커밋만 싣는다.
4. 충돌하면 `git merge --abort`으로 트리를 되돌리고 `factory:blocked` cause `undecidable`,
   사유 `stale PR conflicts with base — rebase by hand`. 스테이지가 남의 충돌을 풀지 않는다.

**머지 대상이 `origin/<default_branch>`가 아니라 2.4 overlay와 같은 sha인 이유**: 그 사이 main이 더
나갔다면 `origin/main`은 overlay의 sha보다 앞서 있고, 그것을 머지하면 트리의 팩토리 경로가 overlay의
sha와 달라진다 → overlay가 되돌린다 → "덮을 것이 있다" → blocked. **한 런 안에서 base는 하나다.**

새 브랜치 라운드는 애초에 base에서 만들어지므로 머지하지 않는다. 런 기록에
`base_merged: <sha> … pushed before the builder` 한 줄이 남는다.
