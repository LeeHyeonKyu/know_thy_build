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
