#!/usr/bin/env bash
# SubagentStart / SubagentStop 이벤트의 stdin JSON 전문을 한 줄로 append. 절대 실패하지 않는다.
input=$(cat) || true
dir="${CLAUDE_PROJECT_DIR:-.}/.factory/out"
mkdir -p "$dir" 2>/dev/null || true
printf '%s\n' "$input" >> "$dir/agents.jsonl" 2>/dev/null || true
exit 0
