#!/usr/bin/env bash
# SubagentStop 판정형 훅: 리뷰어/검증자는 마지막 메시지에 verdict JSON 블록이 있어야 멈출 수 있다.
input=$(cat) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
type=$(printf '%s' "$input" | jq -r '.agent_type // empty' 2>/dev/null) || exit 0
case "$type" in reviewer-*|factory-verifier) ;; *) exit 0 ;; esac
path=$(printf '%s' "$input" | jq -r '.agent_transcript_path // empty' 2>/dev/null) || exit 0
[ -f "$path" ] || exit 0
last=$(jq -rs '[.[] | select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text] | last // ""' "$path" 2>/dev/null | tail -c 20000)
# 리뷰 워크플로는 같은 reviewer-* 에이전트를 세 가지 schema로 띄운다(F1):
#   R1/R2_FULL → `verdict`, R2_LIGHT → `missed`, dispute 판정 → `rulings`.
# `verdict`만 요구하면 경량 R2와 dispute 라운드가 매번 exit 2로 막혀 리뷰가 needs-human으로 떨어진다.
if printf '%s' "$last" | grep -q '```json' && printf '%s' "$last" | grep -Eq '"(verdict|missed|rulings)"'; then exit 0; fi
echo "factory: reply with the verdict JSON block (\`\`\`json … \"verdict\": approve|reject … \`\`\`, or \"missed\"/\"rulings\" for the round-2 and dispute schemas) before stopping" >&2
exit 2
