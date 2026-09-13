#!/usr/bin/env bash
# PreToolUse 훅. 쓰기 금지 역할(triage, plan-*, verifier, reviewer-*, loader)의 frontmatter에 매달려
# Edit/Write/MultiEdit/NotebookEdit을 전부 막고, 매처가 Bash까지 포함할 때는 "파일을 만드는 bash"도 막는다.
# 그 외 도구는 항상 exit 0.
# 예외: jq가 없으면 판정할 수 없다 → fail CLOSED(exit 2). block-dangerous.sh와 동일한 원칙(ADR-009).
command -v jq >/dev/null 2>&1 || { echo "factory: jq missing — cannot evaluate tool, blocking" >&2; exit 2; }
input=$(cat) || exit 0
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0

# 쓰기가 허용되는 유일한 저장소 내 경로: qa 리뷰어의 증거 디렉터리(harness.toml `[protected].except`, F3).
# 그 밖에는 OS 임시 디렉터리만 허용한다 — prove-test가 워크트리를 거기에 만들고, 리뷰어가 중간 산출물을
# 둘 곳도 거기뿐이다.
QA_DIR=".factory/out/qa/"
# 저장소 루트. run-stage.js가 `claude -p`에 넘겨 주는 값이고, 도구가 절대 경로를 줄 때 그것이 **이 저장소
# 안인지** 판단할 수 있는 유일한 근거다. 비어 있으면 절대 경로는 전부 거절한다(모르면 막는다).
PROJ=${CLAUDE_PROJECT_DIR%/}

case "$tool" in
  Edit|Write|MultiEdit)
    file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
    # 훅 입력은 신뢰할 수 없다: `./`와 — `$CLAUDE_PROJECT_DIR`가 있을 때만 — 프로젝트 루트 접두를 한 겹씩
    # 벗겨낸 뒤 **정확한 접두** 비교를 한다. 경로에 `..`가 한 번이라도 들어 있으면(벗겨낸 뒤에도) 예외를
    # 적용하지 않는다 — 정규화 없이 탈출을 허용할 수는 없다. 프로젝트 밖의 절대 경로는
    # (`/tmp/evil/.factory/out/qa/x`) 여전히 거절한다.
    f=${file#./}
    if [ -n "$PROJ" ]; then
      case "$f" in "$PROJ"/*) f=${f#"$PROJ"/} ;; esac
    fi
    case "$f" in
      *..*|/*) ;;
      "$QA_DIR"?*) exit 0 ;;
    esac
    echo "factory: this role must not write files ($tool $file)" >&2
    exit 2
    ;;
  NotebookEdit)
    file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
    echo "factory: this role must not write files ($tool $file)" >&2
    exit 2
    ;;
  Bash) ;;
  *) exit 0 ;;
esac

# ── Bash arm (F6) ────────────────────────────────────────────────────────────────────────────
# 이 훅은 역할 frontmatter에 매달린다 — 전역 `block-dangerous.sh`는 *보호 경로*만 보므로, 쓰기 금지 역할이
# `echo x > src/a.js`로 소스 트리를 고치는 것은 아무도 막지 않았다. 여기서 막는다.
# 판정 방향은 block-dangerous.sh의 `prot` 관용과 **정반대**다: 대상이 /tmp·$TMPDIR·.factory/out/qa/가
# **아니면** 막는다. 구현은 같은 방식이다 — 허용 대상을 지운 사본에 대고 "쓰는 모양"을 찾는다.
c=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$c" ] || exit 0

deny() { echo "factory: this role must not write (bash: $1)" >&2; exit 2; }

ere() { printf '%s' "$1" | sed -E 's/[][^$.*+?(){}|\\]/\\&/g'; }
tmp=${TMPDIR:-/tmp}; tmp=${tmp%/}
esc=$(ere "$tmp")
QA_RE='\.factory/out/qa/'
# 절대 경로로 주어진 qa 증거 경로(`$CLAUDE_PROJECT_DIR/.factory/out/qa/…`)도 같은 대접을 받는다 —
# `--output` 인자나 도구가 만든 경로는 절대 경로로 오기 때문이다. 프로젝트 루트를 모르면 이 대안은 없다.
projqa=""
[ -n "$PROJ" ] && projqa="$(ere "$PROJ")/$QA_RE[^[:space:]\"]*|"
allow="(\./)?($projqa$esc/[^[:space:]\"]*|/tmp/[^[:space:]\"]*|/private/tmp/[^[:space:]\"]*|\\\$\{?TMPDIR\}?/[^[:space:]\"]*|$QA_RE[^[:space:]\"]*|/dev/(null|stdout|stderr))"

# 허용되지 않은 대상이 한 글자라도 남아 있는가. 앞의 `-`는 플래그이므로 대상이 아니다.
T='["]?[^-[:space:]"&|;<>]'
# 명령 위치에만 걸리는 접두사 — `grep -rn mkdir src/`의 인자 `mkdir`은 제외된다.
#
# ADR-020 최종 리뷰 MF-3 — "명령 위치"는 줄 시작과 `;`/`&`/`|` 뒤만이 아니다. **명령 치환**(`$(…)`,
# 백틱), **할당**(`out=$(…)`), **그룹**(`{ … }`) 안도 전부 명령 위치다. r1의 클래스에는 `(`도 백틱도
# 없어서 `x=$(rm -rf src)`·`` `git push` ``가 이 훅의 **모든** 규칙을 그대로 걸어 나갔다
# (block-dangerous.sh의 같은 결함과 한 몸이다 — 둘은 같은 우회에 같이 열려 있었다).
# `[[:space:]]*`는 그대로 둔다: `; rm x`처럼 구분자 뒤 공백을 흡수해야 한다.
# 0452b5b **재리뷰 #1**: 경계 뒤의 **백슬래시**(`\rm -rf src`, `\git push origin HEAD`)도 흡수한다 —
# bash는 alias 확장만 끄고 동사를 그대로 실행하는데 `\`가 클래스에 없어 한 글자로 빠져나갔다.
# 따옴표는 넣지 않는다(`grep -rn mkdir src/`류 오탐) — 따옴표 뒤의 동사는 아래 래퍼 패스가 맡는다.
CMD='(^|[;&|(`={][[:space:]]*)\\?'
# **뒤쪽** 경계도 같이 넓어져야 한다: `$(docker compose down)`의 `down` 뒤는 공백도 줄 끝도 아닌 `)`다.
# 앞만 고치면 앵커 하나를 고치고 다른 앵커에 같은 구멍을 남긴다. `$ZE`는 값이 `=`로 붙는 플래그까지 받는다.
Z='([;&|)`}[:space:]]|$)'
ZE='([;&|)`}=[:space:]]|$)'
FLAGS='([[:space:]]+-[^[:space:];&|]+)*'
# 짧은 옵션은 값을 **붙여** 받는다: `curl -osrc/a.js`, `curl -sLosrc/a.js`, `cp -tsrc/sub`.
# r1의 규칙들은 플래그 뭉치 뒤에 공백이나 `=`를 요구해서 이 모양을 통째로 놓쳤다(KTB-13 r2).
# 뭉치 뒤에 이걸 붙이면 "플래그 글자가 뭉치 안에 있다"만으로 판정이 선다 — 값이 붙어 있든 아니든.
ATTACHED='[a-zA-Z]*[^[:space:];&|]*'

# 규칙 표는 **하나의 함수** 안에 있다 — 아래 래퍼 패스(재리뷰 #4)가 같은 표를 원본 명령과 "따옴표를
# 벗긴 사본"에 두 번 돌린다. 표를 두 벌 유지하면 반드시 한쪽이 뒤처진다. `$1`이 판정 대상이고,
# 전역 `$CMD`가 그 패스의 명령 위치 클래스다.
scan() {
  local c="$1" w
# `..`가 허용 접두 뒤에 붙으면 카브아웃을 통째로 끈다(block-dangerous.sh와 같은 규칙).
w="$c"
printf '%s' "$c" | grep -Eq "($esc|/tmp|/private/tmp|$QA_RE)[^[:space:]\"]*\.\." || w=$(printf '%s' "$c" | sed -E "s#$allow##g")

# `>|`는 noclobber를 무시하는 리다이렉션이다 — `>`/`>>`와 같은 쓰기이므로 같이 잡는다.
echo "$w" | grep -Eq "(^|[^-=<])>>?\|?[[:space:]]*$T" && deny "redirection to a path outside /tmp, \$TMPDIR or $QA_DIR"
echo "$w" | grep -Eq "${CMD}tee$FLAGS[[:space:]]+$T" && deny "tee"
# `install`은 cp + chmod다(KTB-13 r1) — 같은 목록에 넣는다. `npm install`은 여기 걸리지 않는다:
# $CMD가 **명령 위치**만 보므로 `npm`의 인자인 `install`은 대상이 아니다.
echo "$w" | grep -Eq "${CMD}(rm|rmdir|mkdir|touch|truncate|ln|chmod|chown|dd|install)$FLAGS[[:space:]]+$T" && deny "file mutation"
# cp/mv는 **목적지**(세그먼트의 마지막 토큰)만 본다 — 원본이 저장소 안이어도 목적지가 /tmp면 읽기에 가깝다.
if echo "$c" | grep -Eq "${CMD}(cp|mv)${Z}"; then
  echo "$c" | grep -Eq "${CMD}(cp|mv)[[:space:]][^;&|]*[[:space:]][\"']?$allow[[:space:]]*($|[;&|])" || deny "cp/mv"
  # `-t`/`--target-directory`는 목적지를 마지막 토큰이 **아닌** 곳에 둔다 — 위 규칙은 `cp -t src /tmp/a.js`를
  # "목적지가 /tmp"로 읽고 통과시켰다(KTB-13 r1). 이 플래그가 보이면 목적지를 신뢰할 수 없으므로 그냥 막는다.
  # 짧은 옵션은 값을 **붙여** 쓸 수 있다(`cp -tsrc/sub a`) — 그래서 뭉치 뒤에 공백/`=`를 요구하지 않고
  # 플래그 글자가 뭉치 안에 있다는 사실로 판정한다(`$ATTACHED`, KTB-13 r2).
  echo "$c" | grep -Eq "${CMD}(cp|mv)([[:space:]]+[^;&|]*)?[[:space:]](-[a-zA-Z]*t$ATTACHED|--target-directory)${ZE}" && deny "cp/mv --target-directory"
fi
# `node -e`/`-p`/`--eval`/`--print`는 fs를 직접 부를 수 있는 **인라인 스크립트**다 — sed -i·perl -i·python -c와
# 같은 대접을 한다(대상이 어디든 차단). 저장소 스크립트를 **실행**하는 `node .factory/bin/gates.js`는 그대로다:
# 플래그가 아니라 파일을 받는 형태는 여기 걸리지 않는다. 플래그 토큰은 반드시 공백 뒤에서 시작해야 하므로
# `node --version`·`node --experimental-vm-modules x.js`도 걸리지 않는다(첫 `-`에서만 매치를 시작한다).
# KTB-15b: 짧은 옵션은 값을 **붙여** 받는다(`node -e"1"`, `node -p"1"`) — r2가 curl/cp/mv에 이미 준
# 관용(플래그 글자가 있다는 사실로 충분하다)을 여기도 준다. 뒤에 붙는 내용은 `[^[:space:];&|]*`로
# 흡수하고, 그 뒤에 공백/끝이 오는지만 본다(그래야 `--experimental-vm-modules`처럼 우연히 `-e`를
# 품은 긴 플래그가 오탐되지 않는다 — 그 부분 문자열 앞에 필수 공백이 없으므로 애초에 매치가
# 시작될 수 없다).
echo "$c" | grep -Eq "${CMD}node[0-9.]*[[:space:]]+([^;&|]*[[:space:]])?(-[a-zA-Z]*[ep][a-zA-Z]*[^[:space:];&|]*|--eval[^[:space:];&|]*|--print[^[:space:];&|]*)${Z}" && deny "node inline script (-e/-p/--eval/--print)"
# 다운로드는 쓰기다. curl은 출력 플래그가 있을 때만(플래그가 없으면 stdout — 읽기다), wget은 **언제나**:
# wget은 플래그가 없어도 URL의 마지막 세그먼트로 cwd에 파일을 만든다.
echo "$c" | grep -Eq "${CMD}curl([[:space:]]+[^;&|]*)?[[:space:]](-[a-zA-Z]*[oO]$ATTACHED|--output|--output-dir|--remote-name)${ZE}" && deny "curl writing a file (-o/-O/--output)"
echo "$c" | grep -Eq "${CMD}wget${Z}" && deny "wget (it writes into the cwd even without -O)"
# 제자리 편집·파이썬 파일 열기는 대상이 어디든 막는다. 쓰기 금지 역할에게 정당한 제자리 편집은 없고,
# 임시 파일이 필요하면 /tmp로 리다이렉션하는 길이 이미 열려 있다.
# KTB-15b: `-i`도 값을 붙여 받는다(`sed -i.bak …`, BSD/GNU 공통) — 뒤에 붙는 접미사가 문자가
# 아니어도(`.bak`) 플래그 글자 'i'가 뭉치 안에 있다는 사실로 충분하다. GNU의 긴 옵션
# `--in-place[=SUFFIX]`도 같은 일을 하므로 같이 잡는다.
echo "$c" | grep -Eq "${CMD}sed[[:space:]]+[^;&|]*(-[a-zA-Z]*i[^[:space:];&|]*|--in-place(=[^[:space:];&|]*)?)${Z}" && deny "sed -i"
echo "$c" | grep -Eq "${CMD}perl[[:space:]]+-[a-zA-Z]*i[^;&|]*" && deny "perl -i"
echo "$c" | grep -Eq "${CMD}python[0-9.]*[[:space:]]+[^;&|]*-c[^;&|]*open\(" && deny "python -c open(...)"
# 트리·기록을 옮기는 git 서브커맨드. 읽기(diff/log/show/status/rev-parse/ls-files/blame/branch/merge-base)는 그대로.
echo "$c" | grep -Eq "${CMD}git[[:space:]]+(commit|push|add|apply|am|checkout|switch|restore|reset|rm|mv|stash|clean|cherry-pick|revert|rebase|merge|tag|init|worktree|update-ref|notes)${Z}" && deny "git write subcommand"
# `git config`는 읽기(--get*/--list/-l)만 허용한다 — 설정을 **쓰면** hooksPath·user·alias로 다른 훅을 우회할 수 있다.
echo "$c" | grep -Eq "${CMD}git[[:space:]]+config${Z}" &&
  ! echo "$c" | grep -Eq "${CMD}git[[:space:]]+config[^;&|]*(--get[a-z-]*|--list|-l)${ZE}" &&
  deny "git config write"

# ── KTB-21: 읽기 전용 역할은 테스트 env를 세우거나 무너뜨릴 수 없다 ──────────────────────────────
# 데모 #18: qa 리뷰어가 증거를 모으는 중 `docker compose down`으로 env를 내렸다 — 28분 뒤 review
# 스테이지의 게이트가 죽은 env에 대고 돌아 4/4 승인인데도 `unit`이 `service "db" is not running`으로
# RED였다. 읽기 전용 역할에게 env 상태를 바꿀 이유는 없다: `ps`·`logs`·`exec … psql` 같은 **점검**만
# 정당하고, **시작(`up`)도 중지(`down`/`stop`/`rm`/`kill`/`restart`)도** 이 역할의 일이 아니다
# (env를 세우는 것은 gates가 스스로 하는 일이다 — 아래 `gates.js` 재기동 참조).
DOCKER_TEARDOWN_VERBS='(down|stop|rm|kill|restart)'
echo "$c" | grep -Eq "${CMD}(docker[[:space:]]+compose|docker-compose)([[:space:]]+[^;&|]*)?[[:space:]]${DOCKER_TEARDOWN_VERBS}${Z}" && deny "docker compose down/stop/rm/kill/restart (read-only role must not change test-env state)"
echo "$c" | grep -Eq "${CMD}(docker[[:space:]]+compose|docker-compose)([[:space:]]+[^;&|]*)?[[:space:]]up${Z}" && deny "docker compose up (read-only role must not change test-env state)"
echo "$c" | grep -Eq "${CMD}docker[[:space:]]+${DOCKER_TEARDOWN_VERBS}${Z}" && deny "docker stop/rm/kill/restart (read-only role must not change test-env state)"
echo "$c" | grep -Eq "${CMD}docker[[:space:]]+container[[:space:]]+(stop|rm|kill)${Z}" && deny "docker container stop/rm/kill (read-only role must not change test-env state)"
}

scan "$c"

# ── 0452b5b 재리뷰 #4: 인터프리터 래퍼와 ANSI-C 인용 ────────────────────────────────────────────
# `sh -c "rm -rf src"` · `eval "touch a"` · `$'rm' -rf src`는 동사가 명령줄에 그대로 있는데도 통과했다 —
# 동사 앞 글자가 `"`/`'`라서다. 이 저장소의 allow는 `Bash(*)`이고 deny에 `sh`/`bash`/`eval`이 없으므로
# (재리뷰가 확인했다) 이 훅이 유일한 층이다. `"`/`'`를 클래스에 넣는 대신 — 그러면 `grep -rn mkdir src/`
# 류가 오탐이 된다 — **래퍼가 보일 때만** 따옴표를 지운 사본에 같은 표를 한 번 더 돌린다. 그 패스에서는
# 페이로드 안의 동사가 평범한 토큰이 되므로 명령 위치 클래스에 **공백**과 (`$'rm'`→`$rm` 때문에) `$`를
# 더한다. 런타임에 조립되는 동사(`x=$(printf "rm -rf src"); $x`)는 여전히 볼 수 없다 — 비목표다.
WRAPPERS='((ba|z|da|k)?sh|eval|exec|source|\.)'
wrap=0
echo "$c" | grep -Eq "${CMD}${WRAPPERS}${Z}" && wrap=1
case "$c" in *\$\'*|*\$\"*) wrap=1 ;; esac        # ANSI-C / 로케일 인용: $'rm' · $"rm"
if [ "$wrap" = 1 ]; then
  CMD='(^|[$;&|(`={[:space:]][[:space:]]*)\\?'
  scan "$(printf '%s' "$c" | tr -d "\"'")"
fi
exit 0
