#!/usr/bin/env bash
# usage: watch.sh <owner/repo> <issue> <max_minutes> <out.log>
# 상태가 바뀔 때만 한 줄을 쓴다. 종료 상태(merged/needs-human/needs-info/blocked/wont-do/closed)에서 끝난다. LLM 호출 없음.
R=$1; N=$2; MAX=$3; OUT=$4; end=$(( $(date +%s) + MAX*60 )); prev=""
term='factory:(merged|needs-human|needs-info|wont-do)'
while :; do
  st=$(gh issue view "$N" -R "$R" --json state,labels --jq '.state + " " + ([.labels[].name | select(startswith("factory:"))] | sort | join(","))' 2>/dev/null)
  if [ -n "$st" ] && [ "$st" != "$prev" ]; then echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $st" >> "$OUT"; prev=$st; fi
  echo "$st" | grep -qE "$term|^CLOSED" && break
  [ "$(date +%s)" -gt "$end" ] && { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) TIMEOUT" >> "$OUT"; break; }
  sleep 45
done
echo "--- final: $prev"; cat "$OUT"
