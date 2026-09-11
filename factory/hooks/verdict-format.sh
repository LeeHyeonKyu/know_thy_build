#!/usr/bin/env bash
# SubagentStop 판정형 훅: 리뷰어/검증자는 마지막 메시지에 verdict JSON 블록이 있어야 멈출 수 있다.
input=$(cat) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
type=$(printf '%s' "$input" | jq -r '.agent_type // empty' 2>/dev/null) || exit 0
case "$type" in reviewer-*|factory-verifier) ;; *) exit 0 ;; esac
path=$(printf '%s' "$input" | jq -r '.agent_transcript_path // empty' 2>/dev/null) || exit 0
[ -f "$path" ] || exit 0
last=$(jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' "$path" 2>/dev/null | tail -c 20000)
if printf '%s' "$last" | grep -q '```json' && printf '%s' "$last" | grep -q '"verdict"'; then exit 0; fi
echo "factory: reply with the verdict JSON block (\`\`\`json … \"verdict\": approve|reject … \`\`\`) before stopping" >&2
exit 2
