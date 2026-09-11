#!/usr/bin/env bash
# PreToolUse 훅. 쓰기 금지 역할(triage, plan-*, verifier, reviewer-*, loader)의 frontmatter에 매달려
# Edit/Write/NotebookEdit을 전부 막는다. 그 외 도구는 항상 exit 0.
# 예외: jq가 없으면 판정할 수 없다 → fail CLOSED(exit 2). block-dangerous.sh와 동일한 원칙(ADR-009).
command -v jq >/dev/null 2>&1 || { echo "factory: jq missing — cannot evaluate tool, blocking" >&2; exit 2; }
input=$(cat) || exit 0
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
case "$tool" in
  Edit|Write|NotebookEdit) ;;
  *) exit 0 ;;
esac
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
echo "factory: this role must not write files ($tool $file)" >&2
exit 2
