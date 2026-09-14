#!/usr/bin/env bash
# PreToolUse(Bash) 판정 훅. 위험 명령이면 exit 2(차단). 그 외 항상 exit 0. 깨진 stdin 등은 0으로 끝난다(ADR-009) — 단 명확히 매치된 위험 명령만 2.
# 예외: jq가 없으면 명령을 판정할 수 없다 → fail CLOSED(exit 2). 판정 불능은 "안전"이 아니다.
command -v jq >/dev/null 2>&1 || { echo "factory: jq missing — cannot evaluate command, blocking" >&2; exit 2; }
input=$(cat) || exit 0
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
[ "$tool" = "Bash" ] || exit 0
c=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$c" ] || exit 0

# ── 2026-09-14 외부 감사 H1a: 판정 **전에** 명령을 한 문자열로 정규화한다 ─────────────────────
# 모든 규칙이 `echo "$c" | grep -E`, 곧 **줄 단위**였다. 셸에서 `\` + 개행은 토큰을 잇는 이음줄이라
# `gh pr \⏎merge 5 --squash`는 한 문장 그대로 `gh pr merge 5 --squash`를 실행하는데, 훅이 보는 "줄"은
# `gh pr \`와 `merge 5 --squash` 둘로 쪼개져 **어느 쪽도 규칙에 맞지 않았다**. 감사가 직접 실행해
# 확인한 여섯 케이스가 전부 exit 0이었다(`gh pr merge`, `git push --force`, `gh issue edit --add-label
# factory:approved` 포함) — 그리고 `permissions.deny`의 접두 매칭도 같은 이유로 동시에 빗나간다.
# 런타임 조립이 아니다: 동사가 명령줄에 그대로 있는데 규칙이 한 글자에 빗나갔다(MF-3·재리뷰 #1과
# 같은 계열의 고장이 앵커가 아니라 **입력 모양**에서 반복된 것이다).
#
# 정규화는 셸의 문법을 그대로 따른다:
#   1. `\` + 개행 → 공백 하나. 이음줄은 토큰을 잇는다.
#   2. 남은 개행 → `;`. 개행은 이음줄이 아닐 때 **명령 구분자**이고, 아래 규칙들의 `[^;&|]*`·경계
#      클래스가 이미 `;`를 그렇게 다룬다. 공백으로 바꾸면 서로 다른 두 문장이 한 문장으로 이어져
#      `echo git⏎merge x`가 없던 `git merge` 매치를 만든다 — 오탐을 새로 만드는 정규화는 정규화가 아니다.
#   3. 탭 → 공백, 공백 런 → 하나. `gh⇥⇥pr   merge`처럼 섞이면 `[[:space:]]+`를 쓰는 규칙은 통과해도
#      `[^;&|]*` 구간을 끼고 있는 규칙들의 모양이 흐트러진다.
# 이 뒤로 `$c`는 **한 줄**이다 — 그래서 `^`/`$` 앵커도 문자열 전체에 대한 앵커가 된다.
c=${c//$'\r'/}
c=${c//\\$'\n'/ }
c=${c//$'\n'/;}
c=${c//$'\t'/ }
while [ "$c" != "${c//  / }" ]; do c=${c//  / }; done

block() { echo "factory: blocked — $1" >&2; exit 2; }

# git의 **전역 옵션**은 동사 앞에 온다: `git -C <dir> rm …`, `git --git-dir=… merge …`,
# `git -c k=v push -f …`. 이것을 흡수하지 않으면 `git[[:space:]]+push`류 규칙이 통째로 우회된다 —
# 옵션 하나만 끼워 넣으면 그만이다. $G가 "git + 전역 옵션 0개 이상 + 공백"을 나타낸다.
G='git([[:space:]]+(-C[[:space:]]+[^[:space:]]+|--git-dir=[^[:space:]]+|--work-tree=[^[:space:]]+|-c[[:space:]]+[^[:space:]]+))*[[:space:]]+'

# ADR-020 최종 리뷰 MF-3 — **동사 앞의 경계는 "줄 시작"이 아니라 "토큰 경계"다.**
# r1까지의 앵커 `(^|[;&|[:space:]])`에는 `(`도 백틱도 `=`도 없었다. 그래서 `out=$(gh pr merge 5 --squash)`는
# `gh` 바로 앞 글자가 `(`라 **어떤 규칙에도 걸리지 않았다** — 동사가 눈앞에 그대로 있는데 규칙이 빗나간다
# (읽어서가 아니라 훅을 실제로 실행해서 확인된 결함이다). ADR-020의 잔여 위험 등록부는 이 자리를
# "차단"이라고 적고 있었고, 알려진 우회는 *경로* 난독화(`P=pack; echo x > "$P"age.json`)뿐이라고 했다 —
# 코드가 등록부를 반증했다. 같은 구멍이 락 브랜치 삭제·`factory:*` 라벨 조작·docker teardown에도 났다.
#
# 그래서 경계 문자를 명령 치환·논리 연산자·할당·그룹까지 넓힌다:
#   줄 시작 · 공백 · `(`(→ `$(…)`의 여는 괄호) · 백틱 · `;` · `&`(→ `&&`) · `|`(→ `||`, 파이프) · `=` · `{`.
# 단일 인용부호 안이므로 백틱은 리터럴이고, 이 값을 큰따옴표 안에서 `${A}`로 펼칠 때도 bash는 확장
# 결과를 다시 파싱하지 않는다(명령 치환이 일어나지 않는다).
#
# **왜 이것이 진짜 방벽인가**: Claude Code의 `permissions.deny` `Bash(...)` 매처는 **접두 매칭**이다 —
# `Bash(gh pr merge*)`는 명령이 그 문자열로 **시작할 때만** 맞는다. `out=$(gh pr merge …)`도,
# `x && gh pr merge …`도 그 deny를 스치지 않는다. L2는 실수를 줄이는 안내판이고, 실제 경계는 이 훅이다.
#
# 0452b5b **재리뷰 #1** — 경계 문자 뒤의 **백슬래시**도 흡수한다. `\gh pr merge 5`는 bash에서 alias
# 확장만 끄고 `gh`를 그대로 실행한다(치환도, 런타임 조립도 없다 — 동사가 눈앞에 그대로 있다). 그런데
# `\`가 클래스에 없어 `\gh pr merge`·`\git push --force`·`\rm -rf .factory/lib`가 한 글자로 모든
# 규칙을 걸어 나갔다 — MF-3과 **정확히 같은 고장**이 한 단계 좁은 자리에서 반복된 것이다.
# 따옴표(`"`·`'`)는 클래스에 **넣지 않는다**: `grep -rn "git merge" docs/`·`git log --grep="git merge"`가
# 정상 작업으로 고정돼 있어 그 순간 오탐이 된다. 따옴표 뒤의 동사는 아래 **래퍼 패스**가 따로 다룬다.
A='(^|[;&|(`={[:space:]])\\?'
# 그리고 **뒤쪽** 경계도 같은 이유로 넓어져야 한다. `$(docker compose down)`의 `down` 뒤는 공백도 줄
# 끝도 아닌 `)`다 — 앞 경계만 고치면 앵커 하나를 고치고 다른 앵커에 같은 구멍을 남긴다.
# `$ZE`는 값이 `=`로 붙는 플래그(`--force-with-lease=…`)까지 받는 변형이다.
Z='([;&|)`}[:space:]]|$)'
ZE='([;&|)`}=[:space:]]|$)'

# 모든 규칙은 **하나의 함수** 안에 있다. 이유는 아래 래퍼 패스(재리뷰 #4)다 — 같은 규칙 표를 원본
# 명령과 "따옴표를 벗긴 사본"에 대해 **두 번** 돌린다. 표를 두 벌 유지하면 반드시 한쪽이 뒤처진다.
# `$1`이 판정 대상 문자열이고, 전역 `$A`가 그 패스의 경계 클래스다.
scan() {
  local c="$1" prot qa p ep API_CLIENT API_WRITE

echo "$c" | grep -Eq "${A}gh[[:space:]]+pr[[:space:]]+merge" && block "gh pr merge"
# REST 머지도 막는다 — gh api ... /pulls/<n>/merge (메서드 불문)
echo "$c" | grep -Eq "${A}gh[[:space:]]+api[^;&|]*/pulls/[0-9]+/merge" && block "gh api pulls merge"
# ── 2026-09-14 외부 감사 H1b: 에이전트는 자기 리뷰 판정을 게시할 수 없다 ─────────────────────
# `mergeGates`가 리뷰의 증거로 보는 것은 required check의 **상태**뿐이다(`run-stage.js` → `allChecksGreen`).
# 그 함수는 체크가 green인지만 묻고 **누가 올렸는지는 묻지 않는다**. 모든 스테이지의 env에는
# `GH_TOKEN=FACTORY_BOT_TOKEN`이 있고 그 PAT는 `repo` 스코프라 commit status를 쓸 수 있다 — 그래서
# `gh api -X POST /repos/o/r/statuses/<sha> -f state=success -f context=factory/review` 한 줄이면
# 리뷰어가 한 번도 뜨지 않은 채 머지 게이트가 열린다(감사가 재현한 H1 체인의 두 번째 고리).
# check-run은 같은 일을 하는 다른 이름이고, `gh pr review --approve`는 **머지 배우의** 권한이다.
# 메서드 철자도 호스트 접두도 가리지 않는다(브랜치 보호 규칙과 같은 이유 — 철자를 쫓는 것은 진 싸움이다).
# 읽기(GET)까지 막히는 오탐은 손실이 없다: 체크 상태를 읽어야 하는 역할이 없고, `gh pr checks`는 열려 있다.
# **이것이 전부가 아니다**: 상태의 **게시자 검증**은 머지 스테이지의 일이고(Task 2), 이 훅은 그 앞의
# 값싼 문 하나다. 런타임에 조립되는 동사(`node -e "execSync(...)"` 등)는 여전히 비목표다(ADR-020 잔여 위험 #4).
echo "$c" | grep -Eq "${A}gh[[:space:]]+api[^;&|]*/statuses/" && block "gh api commit statuses (a stage must never post its own required check — the merge gate reads status STATE, not author)"
echo "$c" | grep -Eq "${A}gh[[:space:]]+api[^;&|]*/check-runs" && block "gh api check-runs (same power as a commit status under a different name)"
echo "$c" | grep -Eq "${A}gh[[:space:]]+api[^;&|]*/commits?/[^;&|]*/(status|check-runs)" && block "gh api commit status/check-runs"
echo "$c" | grep -Eq "${A}gh[[:space:]]+pr[[:space:]]+review[^;&|]*--approve" && block "gh pr review --approve (approval belongs to the merge actor, not to a stage)"
echo "$c" | grep -Eq "${A}gh[[:space:]]+api[^;&|]*/pulls/[0-9]+/reviews" && block "gh api pull request reviews (the REST spelling of --approve)"

# ── 리뷰 batch-1 MF-1 (H1b-a): 권한 엔드포인트의 앵커는 **클라이언트가 아니라 경로다** ───────────
# 위의 H1b 규칙은 전부 리터럴 `gh`에 앵커돼 있었다. 그런데 모든 스테이지의 env에는 `GH_TOKEN`이 있고
#   curl -sX POST -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/repos/o/r/statuses/<sha> -d @-
# 는 같은 일(=리뷰 상태 위조)을 하면서 `gh`라는 글자를 한 번도 쓰지 않는다. 재리뷰가 실제로 실행해
# 확인한 rc=0 목록이 그것이다: statuses · check-runs · pulls/N/reviews · pulls/N/merge · issues/N/labels ·
# git/refs(락 삭제) · branches/*/protection — **전부 curl/wget으로 열려 있었다**. 동사도 메서드도
# 엔드포인트도 명령줄에 그대로 있는데 규칙이 클라이언트 이름 한 글자에 빗나간 것이다(H1a·MF-3과
# 같은 계열의 고장이 한 단계 옆에서 반복됐다). 이 저장소의 `deny-all-writes.sh`는 이미 curl/wget을
# 쓰기의 1급 철자로 다루고 있었으므로 선례도 있었다.
#
# 그래서 앵커를 엔드포인트로 옮긴다: **권한을 바꾸는 GitHub API 경로**가 보이고, 같은 명령이 HTTP
# 클라이언트를 부르며, **쓰기 모양**(메서드 플래그 또는 본문 플래그)을 하고 있으면 클라이언트가
# 무엇이든 막는다. 클라이언트 이름을 하나씩 쫓는 것은 진 싸움이지만(http·xh·node -e fetch·저장소에
# 체크인된 헬퍼 스크립트…) **쓰기 모양**은 HTTP 자체의 문법이라 철자가 유한하다 — 그래서 목록은
# 클라이언트 쪽을 넓게, 판정은 쓰기 모양 쪽에 건다.
# `api.github.com`에 앵커하지 않는 이유: GHES 호스트에서는 그 문자열이 없다. 경로가 durable하다.
#
# **읽기(GET)는 통과한다.** 위의 `gh api …` 규칙들은 메서드 불문 그대로 남지만(그 자리에서 읽어야
# 하는 역할이 없다), 이 클라이언트 무관 패스는 쓰기 모양이 있을 때만 문다 — `curl …/statuses/<sha>`,
# `gh api repos/o/r/pulls/5` 같은 평범한 조회는 오늘과 똑같이 열려 있다.
API_CLIENT="${A}(gh[[:space:]]+api|curl|wget|http|xh|fetch|node[0-9.]*|deno|bun|python[0-9.]*|ruby|perl)([[:space:]]|\()"
# 쓰기 모양. `.{0,3}`는 따옴표·백슬래시 이스케이프를 흡수한다(`-X "POST"`, JSON 본문의 `method:\"POST\"`).
# 마지막 갈래는 httpie/xh의 **맨몸 동사** 문법(`http POST <url> k=v`)이다 — 플래그가 아예 없다.
API_WRITE='(-X[[:space:]]*.{0,3}(POST|PUT|PATCH|DELETE)|--method[[:space:]=]+.{0,3}(POST|PUT|PATCH|DELETE)|method[[:space:]]*[:=][[:space:]]*.{0,3}(POST|PUT|PATCH|DELETE)|--request|[[:space:]]-d([[:space:]@]|$)|--data|[[:space:]]-f[[:space:]]|[[:space:]]-F[[:space:]]|--field|--raw-field|--input|--post-data|--post-file|--body|--json|[[:space:]]-T[[:space:]]|[[:space:]](POST|PUT|PATCH|DELETE)[[:space:]])'
for ep in '/statuses/' '/check-runs' '/commits?/[^;&|]*/(status|check-runs)' \
          '/pulls/[0-9]+/(reviews|merge)' '/issues/[0-9]+/labels' '/labels/' \
          '/git/refs' '/branches/[^;&|]*/protection' '/rulesets' '/environments/'; do
  echo "$c" | grep -Eiq "$ep" || continue
  echo "$c" | grep -Eiq "$API_CLIENT" || continue
  echo "$c" | grep -Eiq "$API_WRITE" || continue
  block "GitHub authority endpoint ($ep) written through an HTTP client — no client spelling is exempt (curl/wget/http/xh/node fetch are the same power as \`gh api\`; plain GETs stay allowed)"
done
# GraphQL은 같은 권한의 **세 번째 철자**다: `gh api graphql -f query='mutation { addPullRequestReview(…) }'`에는
# 위의 REST 경로가 한 조각도 없다. 뮤테이션 **이름**으로 문다 — 이름은 GitHub 스키마가 정한 것이라
# 우리가 바꿀 수 없고, 그래서 경로만큼 durable하다. `graphql`/`mutation`이라는 말이 같이 있을 때만
# 보는 이유는 문서 grep(`grep -rn mergePullRequest docs/`)을 오탐으로 만들지 않기 위해서다.
if echo "$c" | grep -Eiq "(graphql|mutation)"; then
  echo "$c" | grep -Eq "(addPullRequestReview|mergePullRequest|addLabelsToLabelable|removeLabelsFromLabelable|deleteRef|createCommitStatus|createCheckRun|updateBranchProtectionRule|createRef)" \
    && block "GraphQL mutation is the third spelling of approve/merge/status/label/ref — it carries no REST path, so the endpoint rules above cannot see it"
fi

echo "$c" | grep -Eq "${A}${G}merge${Z}" && block "git merge"
echo "$c" | grep -Eq "${A}${G}push[^;&|]*[[:space:]](--force|-f|--force-with-lease)${ZE}" && block "force push"
# refspec 앞의 '+'도 force push다: git push origin +main:main
echo "$c" | grep -Eq "${A}${G}push[^;&|]*[[:space:]]\+[^[:space:]+]" && block "force push (leading + refspec)"
# 락 브랜치 삭제의 세 철자를 다 본다(MF-3): `--delete … factory/lock-N` · `:refs/heads/factory/lock-N` ·
# 짧은 colon refspec `:factory/lock-N`(git이 똑같이 받는다). 하나라도 빠지면 락 브랜치 — 이슈 단위
# 상호배제의 **유일한** 근거 — 를 에이전트가 지울 수 있고, 그러면 같은 이슈에 두 스테이지가 겹친다.
echo "$c" | grep -Eq "${A}${G}push[^;&|]*(--delete[^;&|]*factory/lock-|:(refs/heads/)?factory/lock-)" && block "lock branch deletion"
# 재리뷰 #2 — **네 번째 철자는 git이 아니라 REST다**: `gh api -X DELETE /repos/o/r/git/refs/heads/factory/lock-7`.
# 위 세 철자는 전부 `git push`를 가정했는데, 같은 브랜치를 지우는 문은 하나 더 있었다. L2의
# `Bash(gh api -X DELETE*)` deny는 접두 매칭이라 `out=$( … )` 안에서는 아무것도 맞히지 못한다 —
# 여기가 유일한 방벽이다. 브랜치 보호 규칙과 같은 이유로 **메서드 철자를 가리지 않는다**(-X/--method/
# -XDELETE/대소문자를 하나씩 쫓는 것은 진 싸움이다), 호스트 접두(`https://api.github.com/…`)도, 앞의
# `/` 유무도 가리지 않는다. 읽기(GET)까지 막히는 오탐은 손실이 없다: 락 상태는 `git ls-remote`로 본다.
echo "$c" | grep -Eq "${A}gh[[:space:]]+api[^;&|]*/git/refs/heads/factory/lock" && block "gh api lock ref deletion (the lock branch is the only basis of per-issue mutual exclusion)"
# ── 리뷰 batch-1 MF-2 (H1b-b): `factory/records`는 **리뷰 증거의 출처다** ─────────────────────────
# 머지 스테이지는 이제 리뷰 handoff를 `factory/records`의 run 기록(`docs/factory/runs/<n>.md`)에 적힌
# review 런과 대조한다(review-quorum.js `verifyReviewProvenance`). 그 대조가 의미를 가지려면 기록이
# **에이전트가 쓸 수 없는 것**이어야 하는데, 감사 전에는 `git push origin HEAD:factory/records`가
# 훅에서 rc=0이었다(막힌 것은 `+refspec` force 형태뿐이었다) — 곧 에이전트가 자기 handoff에 맞는
# 가짜 review 런 기록을 먼저 밀어 넣으면 대조가 그대로 통과한다.
# 그래서 이 두 ref로 가는 **모든 push**를 막는다(삭제·force만이 아니라 append도): 러너의
# `syncRecords`/`claim`은 Node 프로세스에서 직접 git을 부르므로 이 훅을 한 번도 거치지 않는다 —
# 이 규칙이 막는 것은 오직 **에이전트 세션의 Bash**다. 짧은 ref 이름(`factory/records`)이든
# 완전한 refspec(`HEAD:refs/heads/factory/records`)이든 같은 문자열을 지난다.
# **잔여 위험(단일 자격증명)**: 러너와 에이전트가 같은 PAT을 쓰는 한, 훅을 피하는 철자(런타임 조립)나
# 훅 밖의 경로에서는 여전히 같은 push가 가능하다 — ADR-023에 그대로 적어 둔다.
echo "$c" | grep -Eq "${A}${G}push[^;&|]*factory/(records|lock)" && block "push to factory/records / factory/lock* (the records branch is the review evidence the merge stage checks against, and the lock branch is per-issue mutual exclusion — both belong to the runner, not to a stage session)"
echo "$c" | grep -Eq "${A}gh[[:space:]]+api[^;&|]*/git/refs[^;&|]*factory/(records|lock)" && block "gh api git/refs on factory/records|factory/lock* (the REST spelling of the push above)"
# protected paths written via shell redirection / sed -i / tee / cp / mv / perl -i / python -c.
# 빌드 설정 파일(package.json·러너/린터 config)이 여기 있는 이유: gate 명령이 그 파일들을 통해
# 해석되므로, 그것을 고칠 수 있으면 게이트 자체를 고칠 수 있다.
#
# ── 2026-09-14 외부 감사 M8: 이 목록은 이제 **생성물이다** ─────────────────────────────────────
# 같은 목록이 세 곳에 손으로 적혀 있었고(harness.toml `[protected].factory` · `.factory/ci-settings*.json`
# 의 Edit/Write deny · 여기 `prot`) 감사가 확인한 대로 셋이 갈라져 있었다: 이 훅은
# `.github/workflows/factory-`만 막는데 harness는 `.github/**` 전부를 보호했고(다른 이름의 워크플로
# 한 장이 그대로 지나갔다), harness 변형은 `(bin|lib|actions|lessons|out)`만 열거하는데 ci-settings는
# `scenarios`·`node_modules`까지 막았다. 갈라진 목록은 "Edit는 막히는데 `echo > x`는 통과한다"를
# 만들고, 어느 쪽이 맞는지는 아무도 모른다.
# 이제 출처는 `harness.toml [protected]` 하나이고, 아래 블록은 `factory init`/`--upgrade`가
# `factory/lib/protected-paths.js`로 다시 쓴다. doctor의 `protected.parity`가 드리프트를 FAIL로 잡는다.
# **손으로 고치지 말 것** — 고쳐야 한다면 harness.toml을 고치고 `factory init --upgrade`를 돌린다.
# (블록 안의 값은 이 패키지의 템플릿 harness.toml로 생성돼 있다 = 새 채택자가 받는 목록.)
# KTB-20: `factory:harness` 이슈의 implement 스테이지만 `FACTORY_HARNESS_ISSUE=1`로 온다(run-stage.js가
# `claude -p`의 env에 넣는다 — 훅은 그 세션의 자식이라 그대로 물려받는다). 스펙 §5.2.1의 의도는
# "인프라 작업은 factory가 하고 **사람이 그 diff를 머지한다**"인데, 그때까지 이 훅과 ci-settings.json이
# `.factory/harness.toml`·러너 설정을 통째로 막아 승격 PR에 승격이 들어가지 못했다(도그푸딩 #15).
# 그래서 이 플래그가 서면 **승격이 실제로 건드리는 테스트 인프라·빌드 설정 파일만** 보호 목록에서 뺀다:
# `.factory/harness.toml` · `vitest.config.*` · `playwright.config.*` · `package.json` · `package-lock.json`
# (`docker-compose.test.yml`·`.env.test`는 애초에 이 목록에 없어 늘 쓸 수 있었다).
# `package.json`/락파일이 여기 들어온 것은 KTB-23이다: 데모 #2는 feature 001이 `pg` 패키지를 필요로 했는데
# builder가 매니페스트를 못 건드려 네 라운드(≈$67)가 "Harness change needed" → verifier reject →
# needs-human으로 끝났다. 그 요청은 이제 implement handoff의 `harness_needed`로 나가고 `factory:harness`
# 이슈가 되는데, **그 이슈의 builder도 매니페스트를 못 쓰면 같은 벽에 다시 부딪힌다** — 의존성 추가가
# 바로 그 이슈가 하려는 일이다. `.factory/package.json`(러너 자신의 매니페스트)**과 그 락파일**만은
# 이름으로 다시 세워 계속 막는다: 그것을 열면 게이트를 돌리는 런타임 자체를 바꿀 수 있다(락파일도
# 같다 — 실제로 설치되는 코드를 정하는 것은 락이고, KTB-23 fix 전에는 그것이 목록에서 빠져 있었다).
# `.factory/`를 통짜로 여는 것이 아니라 나머지 하위 경로를 이름으로 다시 세운다 — `bin`·`lib`·`actions`·
# `lessons`·`out`(게이트 판정 파일과 agents.jsonl이 산다: 이것이 열리면 판정을 위조할 수 있다)·
# `ci-settings*`·`roles.toml`·`quarantine.toml`·`package.json`·`package-lock.json`.
# `.claude/**`·워크플로·CHARTER·tsconfig·eslint는 한 글자도 열리지 않는다.
# 이 목록은 `ci-settings-harness.json`의 deny와 같아야 한다(F9와 같은 이유: 훅과 L2가 갈라지면 Edit는
# 막히는데 `echo >`는 통과한다). 두 설정 파일은 KTB-36에서 `.factory/out/**`를 `out/*` + `out/`의
# qa 아닌 하위 디렉터리 열거로 바꿨다 — 아래 `qa` 카브아웃이 이 훅에서 하는 일을 L2에서도 하게
# 만드는 유일한 방법이다(Claude Code에서 **deny가 allow를 이기므로** allow로는 뺄 수 없다).
# 여기 `prot`의 `out/`는 그 카브아웃이 이미 `$p`에서 qa 토큰을 지운 뒤에 적용되므로 그대로 둔다.
# 플래그가 없으면(=평범한 이슈) 이 블록은 아무 일도 하지 않는다.
# **머지는 그대로 사람이다**: package.json은 `[protected].factory`에 남아 있어 L1이 자동 머지를 거부한다.

# >>> factory:protected — generated by `factory init` from harness.toml [protected] (audit M8) — do not edit by hand
prot='(\.factory/|\.claude/|\.github/|docs/factory/CHARTER\.md|package\.json|package-lock\.json|vitest\.config\.|playwright\.config\.|tsconfig[a-zA-Z0-9._-]*\.json|\.eslintrc|eslint\.config\.)'
if [ "${FACTORY_HARNESS_ISSUE:-}" = "1" ]; then
  prot='(\.factory/bin/|\.factory/lib/|\.factory/actions/|\.factory/lessons/|\.factory/scenarios/|\.factory/node_modules/|\.factory/out/|\.factory/out/coverage/|\.factory/out/prove-wt/|\.factory/out/classify-wt/|\.factory/ci-settings[a-zA-Z0-9._-]*\.json|\.factory/roles\.toml|\.factory/quarantine\.toml|\.factory/package\.json|\.factory/package-lock\.json|\.claude/|\.github/|docs/factory/CHARTER\.md|tsconfig[a-zA-Z0-9._-]*\.json|\.eslintrc|eslint\.config\.)'
fi
# <<< factory:protected

# `.factory/out/qa/**`는 qa 리뷰어의 증거 디렉터리다(harness.toml `[protected].except`, F3) — 거기 쓰는 것만
# 예외로 통과시킨다. 보호 경로 검사에만 쓰는 사본 `$p`에서 그 토큰을 지우는 방식이라 `.factory/`의 나머지는
# 그대로 막힌다. 단 `..`가 뒤따르면(`.factory/out/qa/../harness.toml`) 예외를 아예 적용하지 않는다 —
# 카브아웃으로 보호 경로를 빠져나갈 수 있으면 카브아웃이 아니라 구멍이다.
qa='\.factory/out/qa/[^[:space:]"]*'
p="$c"
printf '%s' "$c" | grep -Eq "$qa\.\." || p=$(printf '%s' "$c" | sed -E "s#(\./)?$qa##g")

echo "$p" | grep -Eq "(>>?|tee[[:space:]]+(-a[[:space:]]+)?)[[:space:]]*[\"']?[^[:space:]\"']*$prot" && block "write to protected path"
# KTB-15b: `-i`도 값을 붙여 받는다(`sed -i.bak …`) — deny-all-writes.sh의 같은 수정과 짝이다.
# `--in-place[=SUFFIX]`(GNU 긴 옵션)도 같이 잡는다.
echo "$p" | grep -Eq "sed[[:space:]]+(-[a-zA-Z]*i[^;&|[:space:]]*[[:space:]]+|--in-place(=[^;&|[:space:]]*)?[[:space:]]+)[^;&|]*$prot" && block "sed -i on protected path"
echo "$p" | grep -Eq "${A}(cp|mv)[[:space:]]+[^;&|]*[[:space:]]$prot" && block "cp/mv onto protected path"
echo "$p" | grep -Eq "${A}perl[[:space:]]+-[a-zA-Z]*i[^;&|]*$prot" && block "perl -i on protected path"
echo "$p" | grep -Eq "${A}python[0-9.]*[[:space:]]+-c[^;&|]*$prot" && block "python -c touching protected path"
# 보호 경로를 **옮기거나 지우는** 것도 편집이다(ADR-020 fix round 1). `git mv`로 보호 경로를 보호되지
# 않는 이름으로 옮기면 파일 내용은 한 글자도 안 바뀌고도 그 경로가 하는 일(예: required 체크를 만드는
# 워크플로)이 사라진다. `integrity`/L1은 diff에서 그 출발지를 잡지만, 훅이 먼저 막는 것이 싸다.
echo "$p" | grep -Eq "${A}${G}(rm|mv)[[:space:]]+[^;&|]*$prot" && block "git rm/mv on protected path"
# 셸의 rm/mv도 같다. 위의 cp|mv 규칙은 보호 경로가 **목적지**일 때만 걸린다 — `mv .factory/harness.toml /tmp/x`
# 처럼 보호 경로가 **출발지**면 빠져나갔다(fix round 2). rm에는 목적지가 아예 없으므로 더욱 그렇다.
# 알려진 오탐(N4): 경로 정규식은 파일명만 보므로 `rm -rf node_modules/foo/package.json`도 막힌다.
# 좁히려면 경로를 앵커해야 하는데, 그러면 `./package.json`·`$PWD/package.json` 같은 우회가 생긴다 —
# 지우지 못해 불편한 쪽이 조용히 지워지는 쪽보다 낫다고 보고 그대로 둔다(cp는 읽기라 계속 허용).
echo "$p" | grep -Eq "${A}(rm|mv)[[:space:]][^;&|]*$prot" && block "rm/mv touching protected path"
# 최종 리뷰 SF-3 — 등록부(`DECISIONS.md`)는 `ln`·`chmod`도 builder에게 "보호 경로만 차단"이라고 적어
# 두었는데 규칙이 없었다. 둘 다 파일을 **쓰지 않고** 그 파일이 하는 일을 바꾼다:
# `ln -sf /tmp/evil .claude/settings.json`은 내용 한 글자 안 건드리고 L2 전체를 갈아 끼우고,
# `chmod -x .factory/bin/gates.js`는 게이트를 "없는 것"으로 만든다 — 어느 쪽도 워크트리 diff로는
# 눈에 띄지 않는 종류의 변경이다(KTB-14의 백스톱은 내용 diff를 본다).
# `mkdir`·`touch`는 넣지 않는다: 기존 파일의 내용도 동작도 바꾸지 못한다(등록부 표를 그 사실에 맞췄다).
echo "$p" | grep -Eq "${A}(ln|chmod)[[:space:]][^;&|]*$prot" && block "ln/chmod touching protected path"

# ── KTB-13 r1: `Bash(*)`가 allow에 들어온 뒤에 도달 가능해진 쓰기 모양들 ──────────────────────────
# allow가 좁을 때는 `node`·`curl`·`wget`·`install`·`dd`가 애초에 allow 밖이라 이 훅까지 오지도 않았다.
# 이제 온다 — 그리고 넷 다 보호 경로에 파일을 쓸 수 있다. 위의 `sed -i`/`python -c` 줄들과 같은 모양이다.
# `node -e|-p|--eval|--print`의 스크립트 본문이 보호 경로를 말하면 막는다. 저장소 스크립트를 **실행**하는
# `node .factory/bin/gates.js full`은 그대로다(플래그가 없다) — 플래그 토큰은 공백 뒤에서만 매치를 시작하므로
# `node --version`도 걸리지 않는다.
echo "$p" | grep -Eq "${A}node[0-9.]*[[:space:]]+([^;&|]*[[:space:]])?(-[a-zA-Z]*[ep][a-zA-Z]*|--eval|--print)[^;&|]*$prot" && block "node inline script touching protected path"
echo "$p" | grep -Eq "${A}dd[[:space:]]+[^;&|]*of=[\"']?[^[:space:]\"']*$prot" && block "dd onto protected path"
echo "$p" | grep -Eq "${A}install[[:space:]]+[^;&|]*$prot" && block "install onto protected path"
# curl/wget은 세그먼트 안에 보호 경로가 보이면 막는다 — `-o`·`-O`·`--output`·`--output-document` 중
# 어느 철자인지 가리지 않는다(출력 플래그의 형태를 하나씩 쫓는 것보다 목적지를 보는 쪽이 튼튼하다).
echo "$p" | grep -Eq "${A}curl[[:space:]]+[^;&|]*$prot" && block "curl downloading onto protected path"
echo "$p" | grep -Eq "${A}wget[[:space:]]+[^;&|]*$prot" && block "wget downloading onto protected path"
# `git checkout <ref> -- <path>` · `git restore [--source=…] <path>`는 **다른 커밋의 내용으로 워킹 트리를
# 덮어쓴다** — 내용은 명령줄에 없고 경로만 보인다. 브랜치를 만들거나 옮기는 checkout(`-b`, `git checkout main`)과
# 인덱스만 되돌리는 `git restore --staged src/a.js`는 보호 경로를 말하지 않으므로 그대로 통과한다.
# 알려진 오탐: `git restore --staged package.json`(인덱스만)도 막힌다 — 워킹 트리를 덮는 형태와 명령줄에서
# 구별되지 않으므로 막는 쪽을 택한다.
echo "$p" | grep -Eq "${A}${G}(checkout|restore)[[:space:]]+[^;&|]*$prot" && block "git checkout/restore onto protected path"
# `git apply`/`git am`은 **패치 파일**이 쓰는 내용을 명령줄에 싣지 않는다 — 이 훅은 무엇이 쓰이는지 볼 수조차
# 없으므로 보호 경로만 골라 막을 방법이 없다. 판정 불능은 "안전"이 아니다(이 파일 맨 위의 jq 규칙과 같은 원칙):
# 전면 차단한다. builder는 손실이 없다 — KTB-13 이후 `Edit`/`Write`가 allow에 있어서 파일을 직접 쓴다.
# (데모 #8이 편집을 `git apply`에 실어 나른 것은 그때 Edit/Write가 거절됐기 때문이고, 그 우회로가 바로
#  여기서 닫힌다. L1은 PR에 도달한 diff만 본다 — 워크트리 안에서 끝나는 변조는 diff가 되지 않는다.)
echo "$c" | grep -Eq "${A}${G}(apply|am)${Z}" && block "git apply/am (patch contents are invisible to this hook — use Edit/Write)"

# 상태 라벨은 L1(`transition.js`)만 옮긴다 — 에이전트가 `factory:*` 라벨을 직접 붙이거나 떼면 라벨 그래프가
# 거부했어야 할 전이가 조용히 일어나고, 다음 스테이지 워크플로가 그 라벨 이벤트로 깨어난다(F13).
# 코멘트는 막지 않는다: handoff·rework-response는 코멘트로 나간다.
echo "$c" | grep -Eq "${A}gh[[:space:]]+issue[[:space:]]+edit[^;&|]*--(add|remove)-label[^;&|]*factory:" && block "gh issue edit --add/remove-label factory:*"
echo "$c" | grep -Eq "${A}gh[[:space:]]+api[^;&|]*/issues/[0-9]+/labels" && block "gh api issues labels"
# 재리뷰 #3 — 위 두 규칙은 **이슈 한 건**의 라벨만 본다. 라벨은 저장소 자원이기도 하다:
# `gh label delete factory:approved --yes`는 그 라벨을 **모든 이슈에서 한 번에** 떼어 내고,
# `gh label edit factory:queue --name x`는 그래프의 이름을 바꿔 스테이지 워크플로를 통째로 재운다.
# 이슈 단위 우회보다 **더 큰** 우회인데 규칙이 없었다. REST 짝(`/repos/{o}/{r}/labels/factory:*`,
# 그리고 `POST /labels`의 본문에 `factory:`가 보이는 경우)도 같이 막는다 — 메서드 철자는 가리지 않는다.
# `gh label list`·`--search`는 읽기라 그대로 통과한다. `clone`은 다른 저장소의 라벨 집합을 통째로
# 덮어쓰므로(=`factory:*`를 이름으로 지목하지 않고도 갈아 끼운다) 대상을 가리지 않고 막는다.
echo "$c" | grep -Eq "${A}gh[[:space:]]+label[[:space:]]+(create|edit|delete)[^;&|]*factory:" && block "gh label create/edit/delete on factory:* (the label graph is L1's, not the agent's)"
echo "$c" | grep -Eq "${A}gh[[:space:]]+label[[:space:]]+clone${Z}" && block "gh label clone (it replaces the repo's label set wholesale)"
echo "$c" | grep -Eq "${A}gh[[:space:]]+api[^;&|]*/labels[^;&|]*factory:" && block "gh api repo label endpoint on factory:*"

# ── 리뷰 review-3c63672 MF-2 — `transition.js --human`/`--retry`는 **사람의** 엣지다(ADR-020 KTB-32) ──
# `--human`은 `canTransition(from, to, {human:true})`을 열어 `needs-human → {ready, planned, rework,
# awaiting-review}`로 되돌아가는, 그래프 나머지와 달리 `TRANSITIONS`에 없는 엣지다. `human:true`는
# 호출자의 신원을 증명하지 않는다 — **누가** 그 플래그를 세웠는지는 이 CLI가 모른다. `Bash(*)`가
# 허용된 채로 그 사실이 아무 데서도 강제되지 않으면 에이전트가 스스로를 "사람"이라 자칭해 리뷰
# 게이트를 건너뛴 채 이슈를 되돌릴 수 있다(라벨 그래프의 정규 검사 전부를 우회하는 것과 같은 급이다).
# 이 훅이 첫 번째 자물쇠다 — 두 번째는 `bin/transition.js` 자신의 `CLAUDE_PROJECT_DIR`/`GITHUB_ACTIONS`
# 검사(에이전트 세션·CI 러너에서는 그 값이 서 있다 — `run-stage.js`가 매 스테이지의 `claude -p` env에
# `CLAUDE_PROJECT_DIR`를 심는다). 목적 라벨 유무·플래그 순서를 가리지 않는다: `--human` 하나만 있어도
# `RETRY_SCRIPT_REFUSED`로 거절되는 것이 아니라 그대로 `human:true`가 넘어가 그래프가 열리기 때문이다.
echo "$c" | grep -Eq "${A}[^;&|]*transition\.js[^;&|]*[[:space:]]--(human|retry)${Z}" \
  && block "transition.js --human/--retry is the person's edge (ADR-020 KTB-32) — stages transition in-process, not through this CLI"

# ── 최종 리뷰 MF-3 / SF-2: 브랜치 보호·룰셋은 **L0 그 자체다** ────────────────────────────────────
# 모든 스테이지의 env에 `GH_TOKEN=FACTORY_BOT_TOKEN`이 있다. 그 토큰으로 `required_status_checks`나
# `enforce_admins`를 한 번 끄면 `factory/integrity`와 리뷰 게이트는 **존재하되 아무것도 막지 않는** 상태가
# 되고, 아무도 그 사실을 알아채지 못한다(라벨도 코멘트도 나지 않는다). L2 deny는 철자 하나만 덮고 있었다
# (`Bash(gh api -X PUT /repos/*/branches/*/protection*)`) — `gh api --method PUT …`은 아무것도 맞히지
# 못하고, 애초에 그 매처는 접두 매칭이라 `$( … )` 안에서는 통째로 무력하다.
#
# 그래서 **메서드를 가리지 않고** 이 엔드포인트들을 막는다: 철자를 하나씩 쫓는 것(-X / --method /
# -XPUT / 대소문자)은 진 싸움이고, 읽기(GET)까지 막히는 오탐은 이 저장소의 에이전트에게 손실이 없다
# (보호 설정을 읽어야 하는 역할이 없다). 룰셋(`gh ruleset`, `/repos/{o}/{r}/rulesets`)은 같은 일을 하는
# **다른 이름**이라 함께 막는다 — 하나만 막으면 다른 문으로 걸어 들어가면 그만이다.
echo "$c" | grep -Eq "${A}gh[[:space:]]+api[^;&|]*/branches/[^;&|]*/protection" && block "gh api branch protection (L0 is the branch protection — it is not the factory's to edit)"
echo "$c" | grep -Eq "${A}gh[[:space:]]+api[^;&|]*/rulesets" && block "gh api rulesets (same power as branch protection, different name)"
echo "$c" | grep -Eq "${A}gh[[:space:]]+ruleset${Z}" && block "gh ruleset"

# ── KTB-21: builder는 진행 중인 테스트 env를 무너뜨릴 수 없다 ─────────────────────────────────────
# 데모 #18: qa 리뷰어가 증거 수집 중 `docker compose down`으로 env를 내려, 28분 뒤 review 게이트가
# 죽은 env에 대고 돌아 4/4 승인인데도 `unit`이 `service "db" is not running`으로 RED였다. builder도
# 같은 실수를 할 수 있다 — `down`/`stop`/`rm`/`kill`/`restart`는 여기서도 막는다. `up`은 막지
# **않는다**: 멱등이고(`test-env.js up`이 gates 전에도 스스로 부른다), builder가 자기 작업 중 env를
# 다시 올리는 것은 정상 작업이다 — deny-all-writes.sh(읽기 전용 역할)만 `up`까지 막는다.
DOCKER_TEARDOWN_VERBS='(down|stop|rm|kill|restart)'
echo "$c" | grep -Eq "${A}(docker[[:space:]]+compose|docker-compose)([[:space:]]+[^;&|]*)?[[:space:]]${DOCKER_TEARDOWN_VERBS}${Z}" && block "docker compose down/stop/rm/kill/restart tears down the test env"
echo "$c" | grep -Eq "${A}docker[[:space:]]+${DOCKER_TEARDOWN_VERBS}${Z}" && block "docker stop/rm/kill/restart tears down the test env"
echo "$c" | grep -Eq "${A}docker[[:space:]]+container[[:space:]]+(stop|rm|kill)${Z}" && block "docker container stop/rm/kill tears down the test env"
}

scan "$c"

# ── 0452b5b 재리뷰 #4: 인터프리터 래퍼와 ANSI-C 인용 ────────────────────────────────────────────
# `sh -c "gh pr merge 5"` · `bash -c '…'` · `eval "…"` · `$'gh' pr merge 5`는 **동사가 명령줄에 그대로
# 있는데도** 전부 통과했다. 동사 앞 글자가 `"`/`'`라서다. 재리뷰가 확인한 대로 이 저장소의 allow는
# `Bash(*)`이고 deny에 `sh`/`bash`/`eval`이 없다 — "래퍼는 allow가 막는다"는 전제는 **거짓**이고
# 이 훅이 유일한 층이다.
# 고치는 방법은 `"`/`'`를 경계 클래스에 넣는 것이 **아니다**: 그러면 `grep -rn "git merge" docs/`가
# 그 자리에서 오탐이 된다(고정된 정상 작업이다). 대신 **래퍼가 보일 때만** 따옴표를 지운 사본에 대고
# 같은 규칙 표를 한 번 더 돌린다 — 따옴표가 사라지면 페이로드 안의 동사는 평범한 토큰이 되고,
# `$'gh'` → `$gh`가 되므로 이 패스의 경계 클래스에만 `$`를 더한다.
# **비목표(등록부에 기록)**: 런타임에 조립되는 동사 — `x=$(printf "gh pr merge"); $x` ·
# `"$(printf gh) pr merge"` · `python3 -c "os.system('…')"` · `node -e "execSync('…')"` — 는 문자열에
# 동사가 **연속으로 나타나지 않으므로** 이 훅이 볼 수 없다. 쫓지 않는다(ADR-020 잔여 위험 #4).
# (`echo "gh pr merge 5" | bash`는 페이로드가 문자열에 그대로 있어 **부수적으로** 걸린다 — 런타임
#  조립을 막는다는 뜻이 아니다.)
WRAPPERS='((ba|z|da|k)?sh|eval|exec|source|\.)'
wrap=0
echo "$c" | grep -Eq "${A}${WRAPPERS}${Z}" && wrap=1
case "$c" in *\$\'*|*\$\"*) wrap=1 ;; esac        # ANSI-C / 로케일 인용: $'gh' · $"gh"
if [ "$wrap" = 1 ]; then
  A='(^|[$;&|(`={[:space:]])\\?'
  # `$'merge'`처럼 동사 **뒤** 토큰이 ANSI-C 인용이면 따옴표만 지운 뒤 `$merge`가 남아 인접 검사가 깨진다 —
  # 따옴표 앞의 `$`를 먼저 지운다(재리뷰 #5).
  scan "$(printf '%s' "$c" | sed -E "s/\\\$([\"'])/\\1/g" | tr -d "\"'")"
fi
exit 0
