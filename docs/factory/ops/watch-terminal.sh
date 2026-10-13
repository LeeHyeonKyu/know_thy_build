#!/usr/bin/env bash
# watch-terminal.sh <issue> [<issue>…] — 운영 세션의 저비용 감시(2026-10-13 /333 결정 A2).
# 종료 상태(merged / needs-human / blocked / wont-do / CLOSED)에 닿은 이슈만 한 줄씩 출력하고, 전부 닿으면 끝난다.
# 라벨이 바뀔 때마다 깨우지 않는다 — 운영 세션이 매번 전체 컨텍스트를 다시 읽는 것이 2026-10-11~13 캐시 읽기 439M의 뿌리였다.
# 간격은 INTERVAL(기본 900초). 예: Monitor 도구에서 `bash docs/factory/ops/watch-terminal.sh 288 236`.
set -u
interval="${INTERVAL:-900}"
declare -A done=()
total=$#
[ "$total" -gt 0 ] || { echo "usage: watch-terminal.sh <issue> [<issue>…]" >&2; exit 2; }
while true; do
  out=""
  for n in "$@"; do
    [ -n "${done[$n]:-}" ] && continue
    a=$(gh issue view "$n" --json labels,state --jq '.state + " " + ([.labels[].name]|map(select(startswith("factory:")))|join(","))' 2>/dev/null) || continue
    case "$a" in
      *needs-human*|*blocked*|*wont-do*|*merged*|CLOSED*) out="$out #$n $a |"; done[$n]=1 ;;
    esac
  done
  [ -n "$out" ] && echo "TERMINAL:$out"
  [ "${#done[@]}" -ge "$total" ] && exit 0
  sleep "$interval"
done
