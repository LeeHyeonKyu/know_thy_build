#!/usr/bin/env bash
# PreToolUse(Bash) 판정 훅. 위험 명령이면 exit 2(차단). 그 외 항상 exit 0. 깨진 stdin 등은 0으로 끝난다(ADR-009) — 단 명확히 매치된 위험 명령만 2.
# 예외: jq가 없으면 명령을 판정할 수 없다 → fail CLOSED(exit 2). 판정 불능은 "안전"이 아니다.
command -v jq >/dev/null 2>&1 || { echo "factory: jq missing — cannot evaluate command, blocking" >&2; exit 2; }
input=$(cat) || exit 0
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
[ "$tool" = "Bash" ] || exit 0
c=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$c" ] || exit 0

block() { echo "factory: blocked — $1" >&2; exit 2; }

echo "$c" | grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+pr[[:space:]]+merge' && block "gh pr merge"
# REST 머지도 막는다 — gh api ... /pulls/<n>/merge (메서드 불문)
echo "$c" | grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+api[^;&|]*/pulls/[0-9]+/merge' && block "gh api pulls merge"
echo "$c" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+merge([[:space:]]|$)' && block "git merge"
echo "$c" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+push[^;&|]*[[:space:]](--force|-f|--force-with-lease)([[:space:]=]|$)' && block "force push"
# refspec 앞의 '+'도 force push다: git push origin +main:main
echo "$c" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+push[^;&|]*[[:space:]]\+[^[:space:]+]' && block "force push (leading + refspec)"
echo "$c" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+push[^;&|]*(--delete[^;&|]*factory/lock-|:refs/heads/factory/lock-)' && block "lock branch deletion"
# protected paths written via shell redirection / sed -i / tee / cp / mv / perl -i / python -c.
# 목록은 harness.toml `[protected].factory` · ci-settings.json deny와 같아야 한다(F9 / ADR-019 — 경로
# deny는 `.claude/settings.json`이 아니라 CI 전용 `.factory/ci-settings.json`에 산다) — 셋이 갈라지면
# Edit는 막히는데 `echo > package.json`은 통과하고, integrity가 사후에야 잡는다.
# 빌드 설정 파일(package.json·러너/린터 config)이 여기 있는 이유: gate 명령이 그 파일들을 통해
# 해석되므로, 그것을 고칠 수 있으면 게이트 자체를 고칠 수 있다.
prot='(\.factory/|\.claude/|\.github/workflows/factory-|docs/factory/CHARTER\.md|package\.json|package-lock\.json|vitest\.config\.|playwright\.config\.|tsconfig[a-zA-Z0-9._-]*\.json|\.eslintrc|eslint\.config\.)'

# `.factory/out/qa/**`는 qa 리뷰어의 증거 디렉터리다(harness.toml `[protected].except`, F3) — 거기 쓰는 것만
# 예외로 통과시킨다. 보호 경로 검사에만 쓰는 사본 `$p`에서 그 토큰을 지우는 방식이라 `.factory/`의 나머지는
# 그대로 막힌다. 단 `..`가 뒤따르면(`.factory/out/qa/../harness.toml`) 예외를 아예 적용하지 않는다 —
# 카브아웃으로 보호 경로를 빠져나갈 수 있으면 카브아웃이 아니라 구멍이다.
qa='\.factory/out/qa/[^[:space:]"]*'
p="$c"
printf '%s' "$c" | grep -Eq "$qa\.\." || p=$(printf '%s' "$c" | sed -E "s#(\./)?$qa##g")

echo "$p" | grep -Eq "(>>?|tee[[:space:]]+(-a[[:space:]]+)?)[[:space:]]*[\"']?[^[:space:]\"']*$prot" && block "write to protected path"
echo "$p" | grep -Eq "sed[[:space:]]+(-[a-zA-Z]*i[a-zA-Z]*[[:space:]]+)[^;&|]*$prot" && block "sed -i on protected path"
echo "$p" | grep -Eq "(^|[;&|[:space:]])(cp|mv)[[:space:]]+[^;&|]*[[:space:]]$prot" && block "cp/mv onto protected path"
echo "$p" | grep -Eq "(^|[;&|[:space:]])perl[[:space:]]+-[a-zA-Z]*i[^;&|]*$prot" && block "perl -i on protected path"
echo "$p" | grep -Eq "(^|[;&|[:space:]])python[0-9.]*[[:space:]]+-c[^;&|]*$prot" && block "python -c touching protected path"
# 보호 경로를 **옮기거나 지우는** 것도 편집이다(ADR-020 fix round 1). `git mv`로 보호 경로를 보호되지
# 않는 이름으로 옮기면 파일 내용은 한 글자도 안 바뀌고도 그 경로가 하는 일(예: required 체크를 만드는
# 워크플로)이 사라진다. `integrity`/L1은 diff에서 그 출발지를 잡지만, 훅이 먼저 막는 것이 싸다.
echo "$p" | grep -Eq "(^|[;&|[:space:]])git[[:space:]]+(rm|mv)[[:space:]]+[^;&|]*$prot" && block "git rm/mv on protected path"

# 상태 라벨은 L1(`transition.js`)만 옮긴다 — 에이전트가 `factory:*` 라벨을 직접 붙이거나 떼면 라벨 그래프가
# 거부했어야 할 전이가 조용히 일어나고, 다음 스테이지 워크플로가 그 라벨 이벤트로 깨어난다(F13).
# 코멘트는 막지 않는다: handoff·rework-response는 코멘트로 나간다.
echo "$c" | grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+issue[[:space:]]+edit[^;&|]*--(add|remove)-label[^;&|]*factory:' && block "gh issue edit --add/remove-label factory:*"
echo "$c" | grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+api[^;&|]*/issues/[0-9]+/labels' && block "gh api issues labels"
exit 0
