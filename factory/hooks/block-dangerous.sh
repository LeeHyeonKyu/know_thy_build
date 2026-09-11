#!/usr/bin/env bash
# PreToolUse(Bash) 판정 훅. 위험 명령이면 exit 2(차단). 그 외 항상 exit 0. jq 실패 등 어떤 오류도 0으로 끝난다(ADR-009) — 단 명확히 매치된 위험 명령만 2.
input=$(cat) || exit 0
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
[ "$tool" = "Bash" ] || exit 0
c=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$c" ] || exit 0

block() { echo "factory: blocked — $1" >&2; exit 2; }

echo "$c" | grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+pr[[:space:]]+merge' && block "gh pr merge"
echo "$c" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+merge([[:space:]]|$)' && block "git merge"
echo "$c" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+push[^;&|]*[[:space:]](--force|-f|--force-with-lease)([[:space:]]|$)' && block "force push"
# protected paths written via shell redirection / sed -i / tee
prot='(\.factory/|\.claude/|\.github/workflows/factory-|docs/factory/CHARTER\.md)'
echo "$c" | grep -Eq "(>>?|tee[[:space:]]+(-a[[:space:]]+)?)[[:space:]]*[\"']?[^[:space:]\"']*$prot" && block "write to protected path"
echo "$c" | grep -Eq "sed[[:space:]]+(-[a-zA-Z]*i[a-zA-Z]*[[:space:]]+)[^;&|]*$prot" && block "sed -i on protected path"
exit 0
