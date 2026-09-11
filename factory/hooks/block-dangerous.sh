#!/usr/bin/env bash
# PreToolUse(Bash) 판정 훅. 위험 명령이면 exit 2(차단). 그 외 항상 exit 0. 깨진 stdin 등은 0으로 끝난다(ADR-009) — 단 명확히 매치된 위험 명령만 2.
# 예외: jq가 없으면 명령을 판정할 수 없다 → fail CLOSED(exit 2). 판정 불능은 "안전"이 아니다.
command -v jq >/dev/null 2>&1 || { echo "factory: jq missing — cannot evaluate command, blocking" >&2; exit 2; }
input=$(cat) || exit 0
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
[ "$tool" = "Bash" ] || exit 0
c=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$c" ] || exit 0

block() { echo "factory: blocked — $1" >&2; exit 2; }

echo "$c" | grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+pr[[:space:]]+merge' && block "gh pr merge"
# REST 머지도 막는다 — gh api ... /pulls/<n>/merge (메서드 불문)
echo "$c" | grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+api[^;&|]*/pulls/[0-9]+/merge' && block "gh api pulls merge"
echo "$c" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+merge([[:space:]]|$)' && block "git merge"
echo "$c" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+push[^;&|]*[[:space:]](--force|-f|--force-with-lease)([[:space:]=]|$)' && block "force push"
# refspec 앞의 '+'도 force push다: git push origin +main:main
echo "$c" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+push[^;&|]*[[:space:]]\+[^[:space:]+]' && block "force push (leading + refspec)"
echo "$c" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+push[^;&|]*(--delete[^;&|]*factory/lock-|:refs/heads/factory/lock-)' && block "lock branch deletion"
# protected paths written via shell redirection / sed -i / tee / cp / mv / perl -i / python -c.
# 목록은 harness.toml `[protected].factory` · settings.json deny와 같아야 한다(F9) — 셋이 갈라지면
# Edit는 막히는데 `echo > package.json`은 통과하고, integrity가 사후에야 잡는다.
# 빌드 설정 파일(package.json·러너/린터 config)이 여기 있는 이유: gate 명령이 그 파일들을 통해
# 해석되므로, 그것을 고칠 수 있으면 게이트 자체를 고칠 수 있다.
prot='(\.factory/|\.claude/|\.github/workflows/factory-|docs/factory/CHARTER\.md|package\.json|package-lock\.json|vitest\.config\.|playwright\.config\.|tsconfig[a-zA-Z0-9._-]*\.json|\.eslintrc|eslint\.config\.)'
echo "$c" | grep -Eq "(>>?|tee[[:space:]]+(-a[[:space:]]+)?)[[:space:]]*[\"']?[^[:space:]\"']*$prot" && block "write to protected path"
echo "$c" | grep -Eq "sed[[:space:]]+(-[a-zA-Z]*i[a-zA-Z]*[[:space:]]+)[^;&|]*$prot" && block "sed -i on protected path"
echo "$c" | grep -Eq "(^|[;&|[:space:]])(cp|mv)[[:space:]]+[^;&|]*[[:space:]]$prot" && block "cp/mv onto protected path"
echo "$c" | grep -Eq "(^|[;&|[:space:]])perl[[:space:]]+-[a-zA-Z]*i[^;&|]*$prot" && block "perl -i on protected path"
echo "$c" | grep -Eq "(^|[;&|[:space:]])python[0-9.]*[[:space:]]+-c[^;&|]*$prot" && block "python -c touching protected path"
exit 0
