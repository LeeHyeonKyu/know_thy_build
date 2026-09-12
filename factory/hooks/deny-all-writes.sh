#!/usr/bin/env bash
# PreToolUse 훅. 쓰기 금지 역할(triage, plan-*, verifier, reviewer-*, loader)의 frontmatter에 매달려
# Edit/Write/NotebookEdit을 전부 막고, 매처가 Bash까지 포함할 때는 "파일을 만드는 bash"도 막는다.
# 그 외 도구는 항상 exit 0.
# 예외: jq가 없으면 판정할 수 없다 → fail CLOSED(exit 2). block-dangerous.sh와 동일한 원칙(ADR-009).
command -v jq >/dev/null 2>&1 || { echo "factory: jq missing — cannot evaluate tool, blocking" >&2; exit 2; }
input=$(cat) || exit 0
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0

# 쓰기가 허용되는 유일한 저장소 내 경로: qa 리뷰어의 증거 디렉터리(harness.toml `[protected].except`, F3).
# 그 밖에는 OS 임시 디렉터리만 허용한다 — prove-test가 워크트리를 거기에 만들고, 리뷰어가 중간 산출물을
# 둘 곳도 거기뿐이다.
QA_DIR=".factory/out/qa/"

case "$tool" in
  Edit|Write)
    file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
    # 훅 입력은 신뢰할 수 없다: `./` 한 겹만 벗겨낸 뒤 **정확한 접두** 비교를 하고, 경로에 `..`가 한 번이라도
    # 들어 있으면 예외를 적용하지 않는다(정규화 없이 탈출을 허용할 수는 없다).
    f=${file#./}
    case "$f" in
      *..*) ;;
      "$QA_DIR"?*|*"/$QA_DIR"?*) exit 0 ;;
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

tmp=${TMPDIR:-/tmp}; tmp=${tmp%/}
esc=$(printf '%s' "$tmp" | sed -E 's/[][^$.*+?(){}|\\]/\\&/g')
allow="(\./)?($esc/[^[:space:]\"]*|/tmp/[^[:space:]\"]*|/private/tmp/[^[:space:]\"]*|\\\$\{?TMPDIR\}?/[^[:space:]\"]*|$QA_DIR[^[:space:]\"]*|/dev/(null|stdout|stderr))"
# `..`가 허용 접두 뒤에 붙으면 카브아웃을 통째로 끈다(block-dangerous.sh와 같은 규칙).
w="$c"
printf '%s' "$c" | grep -Eq "($esc|/tmp|/private/tmp|$QA_DIR)[^[:space:]\"]*\.\." || w=$(printf '%s' "$c" | sed -E "s#$allow##g")

# 허용되지 않은 대상이 한 글자라도 남아 있는가. 앞의 `-`는 플래그이므로 대상이 아니다.
T='["]?[^-[:space:]"&|;<>]'
# 명령 위치(줄 시작 또는 `;`/`&`/`|` 뒤)에만 걸리는 접두사 — `grep -rn mkdir src/`의 인자 `mkdir`은 제외된다.
CMD='(^|[;&|][[:space:]]*)'
FLAGS='([[:space:]]+-[^[:space:];&|]+)*'

echo "$w" | grep -Eq "(^|[^-=<])>>?[[:space:]]*$T" && deny "redirection to a path outside /tmp, \$TMPDIR or $QA_DIR"
echo "$w" | grep -Eq "${CMD}tee$FLAGS[[:space:]]+$T" && deny "tee"
echo "$w" | grep -Eq "${CMD}(rm|rmdir|mkdir|touch|truncate|ln|chmod|chown|dd)$FLAGS[[:space:]]+$T" && deny "file mutation"
# cp/mv는 **목적지**(세그먼트의 마지막 토큰)만 본다 — 원본이 저장소 안이어도 목적지가 /tmp면 읽기에 가깝다.
if echo "$c" | grep -Eq "${CMD}(cp|mv)([[:space:]]|$)"; then
  echo "$c" | grep -Eq "${CMD}(cp|mv)[[:space:]][^;&|]*[[:space:]][\"']?$allow[[:space:]]*($|[;&|])" || deny "cp/mv"
fi
# 제자리 편집·파이썬 파일 열기는 대상이 어디든 막는다. 쓰기 금지 역할에게 정당한 제자리 편집은 없고,
# 임시 파일이 필요하면 /tmp로 리다이렉션하는 길이 이미 열려 있다.
echo "$c" | grep -Eq "${CMD}sed[[:space:]]+[^;&|]*-[a-zA-Z]*i[a-zA-Z]*([[:space:]]|$)" && deny "sed -i"
echo "$c" | grep -Eq "${CMD}perl[[:space:]]+-[a-zA-Z]*i[^;&|]*" && deny "perl -i"
echo "$c" | grep -Eq "${CMD}python[0-9.]*[[:space:]]+[^;&|]*-c[^;&|]*open\(" && deny "python -c open(...)"
# 트리·기록을 옮기는 git 서브커맨드. 읽기(diff/log/show/status/rev-parse/ls-files/blame/branch/merge-base)는 그대로.
echo "$c" | grep -Eq "${CMD}git[[:space:]]+(commit|push|add|apply|am|checkout|switch|restore|reset|rm|mv|stash|clean|cherry-pick|revert|rebase|merge|tag|init|config|worktree|update-ref|notes)([[:space:]]|$)" && deny "git write subcommand"
exit 0
