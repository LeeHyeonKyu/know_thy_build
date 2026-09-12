#!/usr/bin/env bash
# Stop 판정 훅. factory 작업 브랜치(claude/fq-*)에서 미커밋/미push 변경이 있으면 종료를 거부한다(exit 2).
# review/merge는 checkoutHead(R6)가 implement handoff의 head_sha에 detach해서 돈다 — 브랜치가 없으니
# push/upstream 개념도 없지만, 그 detached HEAD 위에서 트리를 건드렸는지는 여전히 봐야 한다.
# 더티 판정에서 빼는 경로(브랜치·detached 양쪽 동일):
#   .factory/out         — 팩토리가 워크트리에 쓰는 산출물(게이트 리포트·claude 원본 출력)
#   docs/factory/runs    — run 기록. hydrateRecord가 스테이지 시작에 복원하고 매 스테이지 append한다.
#                          실제 저장소는 factory/records 브랜치다(ADR-014) — 작업 브랜치에 커밋되지 않는다.
#   .factory/quarantine.toml — 게이트가 직접 갱신하는 script 소유 파일
# 셋 다 "에이전트가 코드를 고쳐놓고 커밋하지 않았다"는 신호가 아니다 — 여기서 걸리면 Stop이 영구히 막힌다.
input=$(cat) || true

# SubagentStop에서 **쓰기 금지 역할은 이 가드를 건너뛴다**. 그들은 deny-all-writes.sh가 Edit/Write와
# "쓰는 모양의 Bash"를 모두 막아 둔 역할이라 커밋하지 않은 *자기* 변경을 만들 수 없다. 그런데 그들이 돌리는
# 러너는 untracked 산출물을 남긴다(playwright `test-results/`, `coverage/`) — 지우려면 쓰기가 필요하고,
# 쓰기는 막혀 있다. 여기서 exit 2를 주면 그 서브에이전트는 영원히 멈추지 못한다(교착).
# 이 가드는 원래 builder(커밋+push해야 한다)와 메인 세션(트리를 깨끗이 두어야 한다)을 위한 것이다.
agent=""
if command -v jq >/dev/null 2>&1; then
  agent=$(printf '%s' "$input" | jq -r '.agent_type // empty' 2>/dev/null) || agent=""
fi
# jq가 없어도 판정은 해야 한다(이 훅은 fail-open이 기본이다) — 원문에서 직접 읽는다.
[ -n "$agent" ] || agent=$(printf '%s' "$input" | sed -n 's/.*"agent_type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
case "$agent" in
  reviewer-*|plan-*|factory-loader|factory-triage|factory-verifier) exit 0 ;;
esac

branch=$(git branch --show-current 2>/dev/null) || exit 0
if [ -z "$branch" ]; then
  if [ -n "$(git status --porcelain -- ':(top)' ':(exclude,top).factory/out' ':(exclude,top)docs/factory/runs' ':(exclude,top).factory/quarantine.toml' 2>/dev/null)" ]; then
    echo "factory: detached HEAD with uncommitted changes — review/merge stages must not modify the tree" >&2; exit 2
  fi
  exit 0
fi
case "$branch" in claude/fq-*) ;; *) exit 0 ;; esac
# 위 주석의 제외 목록과 동일하다 — 브랜치 위에서도 팩토리 자신의 산출물은 더티가 아니다(아니면 Stop이 항상 막힌다).
if [ -n "$(git status --porcelain -- ':(top)' ':(exclude,top).factory/out' ':(exclude,top)docs/factory/runs' ':(exclude,top).factory/quarantine.toml' 2>/dev/null)" ]; then
  echo "factory: uncommitted changes on $branch — commit and push before stopping" >&2; exit 2
fi
if ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  echo "factory: no upstream for $branch — push before stopping" >&2; exit 2
fi
if [ -n "$(git log '@{u}..HEAD' --oneline 2>/dev/null)" ]; then
  echo "factory: unpushed commits on $branch — push before stopping" >&2; exit 2
fi
exit 0
