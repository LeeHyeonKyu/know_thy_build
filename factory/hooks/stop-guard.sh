#!/usr/bin/env bash
# Stop 판정 훅. factory 작업 브랜치(claude/fq-*)에서 미커밋/미push 변경이 있으면 종료를 거부한다(exit 2).
# review/merge는 checkoutHead(R6)가 implement handoff의 head_sha에 detach해서 돈다 — 브랜치가 없으니
# push/upstream 개념도 없지만, 그 detached HEAD 위에서 트리를 건드렸는지는 여전히 봐야 한다.
input=$(cat) || true
branch=$(git branch --show-current 2>/dev/null) || exit 0
if [ -z "$branch" ]; then
  if [ -n "$(git status --porcelain -- ':(top)' ':(exclude,top).factory/out' 2>/dev/null)" ]; then
    echo "factory: detached HEAD with uncommitted changes — review/merge stages must not modify the tree" >&2; exit 2
  fi
  exit 0
fi
case "$branch" in claude/fq-*) ;; *) exit 0 ;; esac
# .factory/out/*는 팩토리 자신이 워크트리에 쓰는 산출물이다 — 더티 판정에서 제외한다(아니면 Stop이 항상 막힌다).
if [ -n "$(git status --porcelain -- ':(top)' ':(exclude,top).factory/out' 2>/dev/null)" ]; then
  echo "factory: uncommitted changes on $branch — commit and push before stopping" >&2; exit 2
fi
if ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  echo "factory: no upstream for $branch — push before stopping" >&2; exit 2
fi
if [ -n "$(git log '@{u}..HEAD' --oneline 2>/dev/null)" ]; then
  echo "factory: unpushed commits on $branch — push before stopping" >&2; exit 2
fi
exit 0
