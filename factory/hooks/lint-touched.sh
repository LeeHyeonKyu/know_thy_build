#!/usr/bin/env bash
# PostToolUse(Edit|Write) 로깅형 훅: 건드린 파일에 lint_file을 돌려 결과를 stderr로 돌려준다. 절대 차단하지 않는다(exit 0).
input=$(cat) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
[ -n "$file" ] || exit 0
root="${CLAUDE_PROJECT_DIR:-.}"
cmd=$(grep -E '^\s*lint_file\s*=\s*"' "$root/.factory/harness.toml" 2>/dev/null | head -1 | sed -E 's/^[^"]*"(.*)"[[:space:]]*$/\1/') || exit 0
[ -n "$cmd" ] || exit 0
cmd=${cmd//\{file\}/$file}
out=$(cd "$root" && bash -lc "$cmd" 2>&1); code=$?
if [ $code -ne 0 ]; then printf 'factory lint (%s) exit %s:\n%s\n' "$file" "$code" "$(printf '%s' "$out" | tail -20)" >&2; fi
exit 0
