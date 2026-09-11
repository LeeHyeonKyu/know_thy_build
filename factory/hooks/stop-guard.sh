#!/usr/bin/env bash
# Stop 판정 훅. factory 작업 브랜치(claude/fq-*)에서 미커밋/미push 변경이 있으면 종료를 거부한다(exit 2).
input=$(cat) || true
branch=$(git branch --show-current 2>/dev/null) || exit 0
case "$branch" in claude/fq-*) ;; *) exit 0 ;; esac
# .factory/out/*는 팩토리 자신이 워크트리에 쓰는 산출물이다 — 더티 판정에서 제외한다(아니면 Stop이 항상 막힌다).
if [ -n "$(git status --porcelain -- . ':(exclude).factory/out' 2>/dev/null)" ]; then
  echo "factory: uncommitted changes on $branch — commit and push before stopping" >&2; exit 2
fi
if ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  echo "factory: no upstream for $branch — push before stopping" >&2; exit 2
fi
if [ -n "$(git log '@{u}..HEAD' --oneline 2>/dev/null)" ]; then
  echo "factory: unpushed commits on $branch — push before stopping" >&2; exit 2
fi
exit 0
