#!/usr/bin/env bash
# 사람이 자기 셸에서 실행하는 단계들. 에이전트 세션은 머지와 --human 전이를 할 수 없다(훅 + CLI 자체 검사).
# usage: bash person-steps.sh <KTB_PR> <own-calendar 이슈 번호...>
#   예: bash person-steps.sh 129 107
# 하는 일: KTB PR 머지 → npm 배포 대기 → own-calendar 업그레이드 PR 생성·머지 → 이슈를 큐에 투입
#
# 다시 돌리기(#196, ADR-035) — 호출자마다 명령 하나:
#   에이전트 세션·CI·누구나 (재큐, 처음부터):   node .factory/bin/transition.js <n> factory:queue
#   사람의 셸만 (중단 지점 재개):                node .factory/bin/transition.js <n> --human --retry
set -euo pipefail
KTB_PR="$1"; shift
KTB=LeeHyeonKyu/know_thy_build; OC=LeeHyeonKyu/own-calendar
CLONE="$(cd "$(dirname "$0")/.." && pwd)/own-calendar"

echo "== 1. KTB #$KTB_PR 머지"
gh pr merge "$KTB_PR" -R "$KTB" --squash --admin
V=$(gh api "repos/$KTB/contents/package.json?ref=main" --jq .content | base64 -d | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')
echo "== 2. npm $V 배포 대기"
for i in $(seq 1 60); do [ "$(npm view "know-thy-build@$V" version 2>/dev/null)" = "$V" ] && break; sleep 15; done
[ "$(npm view "know-thy-build@$V" version 2>/dev/null)" = "$V" ] || { echo "npm에 $V가 아직 없습니다 — publish 워크플로를 확인하세요"; exit 1; }

echo "== 3. own-calendar 업그레이드 PR"
cd "$CLONE"
git checkout -q main && git pull -q
git branch -D "chore/ktb-$V" >/dev/null 2>&1 || true
git checkout -q -b "chore/ktb-$V"
npx -y "know-thy-build@$V" factory init --upgrade | grep "factory init --upgrade:"
git add -A && git commit -q -m "chore(factory): upgrade to know-thy-build $V"
git push -q -u origin "chore/ktb-$V"
url=$(gh pr create -R "$OC" --base main --head "chore/ktb-$V" --title "chore(factory): upgrade to know-thy-build $V" --body "Upgrade to know-thy-build $V (L43–L47).")
echo "$url"; sleep 45
gh pr merge "${url##*/}" -R "$OC" --squash --admin
git checkout -q main && git pull -q
npm install --prefix .factory --no-audit --no-fund >/dev/null

echo "== 4. 큐 투입"
for n in "$@"; do
  node .factory/bin/transition.js "$n" factory:queue --human --reason "owner: run through the factory"
done
