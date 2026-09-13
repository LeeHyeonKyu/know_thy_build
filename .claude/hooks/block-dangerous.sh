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

# git의 **전역 옵션**은 동사 앞에 온다: `git -C <dir> rm …`, `git --git-dir=… merge …`,
# `git -c k=v push -f …`. 이것을 흡수하지 않으면 `git[[:space:]]+push`류 규칙이 통째로 우회된다 —
# 옵션 하나만 끼워 넣으면 그만이다. $G가 "git + 전역 옵션 0개 이상 + 공백"을 나타낸다.
G='git([[:space:]]+(-C[[:space:]]+[^[:space:]]+|--git-dir=[^[:space:]]+|--work-tree=[^[:space:]]+|-c[[:space:]]+[^[:space:]]+))*[[:space:]]+'

echo "$c" | grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+pr[[:space:]]+merge' && block "gh pr merge"
# REST 머지도 막는다 — gh api ... /pulls/<n>/merge (메서드 불문)
echo "$c" | grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+api[^;&|]*/pulls/[0-9]+/merge' && block "gh api pulls merge"
echo "$c" | grep -Eq "(^|[;&|[:space:]])${G}merge([[:space:]]|\$)" && block "git merge"
echo "$c" | grep -Eq "(^|[;&|[:space:]])${G}push[^;&|]*[[:space:]](--force|-f|--force-with-lease)([[:space:]=]|\$)" && block "force push"
# refspec 앞의 '+'도 force push다: git push origin +main:main
echo "$c" | grep -Eq "(^|[;&|[:space:]])${G}push[^;&|]*[[:space:]]\+[^[:space:]+]" && block "force push (leading + refspec)"
echo "$c" | grep -Eq "(^|[;&|[:space:]])${G}push[^;&|]*(--delete[^;&|]*factory/lock-|:refs/heads/factory/lock-)" && block "lock branch deletion"
# protected paths written via shell redirection / sed -i / tee / cp / mv / perl -i / python -c.
# 목록은 harness.toml `[protected].factory` · ci-settings.json deny와 같아야 한다(F9 / ADR-019 — 경로
# deny는 `.claude/settings.json`이 아니라 CI 전용 `.factory/ci-settings.json`에 산다) — 셋이 갈라지면
# Edit는 막히는데 `echo > package.json`은 통과하고, integrity가 사후에야 잡는다.
# 빌드 설정 파일(package.json·러너/린터 config)이 여기 있는 이유: gate 명령이 그 파일들을 통해
# 해석되므로, 그것을 고칠 수 있으면 게이트 자체를 고칠 수 있다.
prot='(\.factory/|\.claude/|\.github/workflows/factory-|docs/factory/CHARTER\.md|package\.json|package-lock\.json|vitest\.config\.|playwright\.config\.|tsconfig[a-zA-Z0-9._-]*\.json|\.eslintrc|eslint\.config\.)'

# KTB-20: `factory:harness` 이슈의 implement 스테이지만 `FACTORY_HARNESS_ISSUE=1`로 온다(run-stage.js가
# `claude -p`의 env에 넣는다 — 훅은 그 세션의 자식이라 그대로 물려받는다). 스펙 §5.2.1의 의도는
# "인프라 작업은 factory가 하고 **사람이 그 diff를 머지한다**"인데, 그때까지 이 훅과 ci-settings.json이
# `.factory/harness.toml`·러너 설정을 통째로 막아 승격 PR에 승격이 들어가지 못했다(도그푸딩 #15).
# 그래서 이 플래그가 서면 **승격이 실제로 건드리는 테스트 인프라·빌드 설정 파일만** 보호 목록에서 뺀다:
# `.factory/harness.toml` · `vitest.config.*` · `playwright.config.*` · `package.json` · `package-lock.json`
# (`docker-compose.test.yml`·`.env.test`는 애초에 이 목록에 없어 늘 쓸 수 있었다).
# `package.json`/락파일이 여기 들어온 것은 KTB-23이다: 데모 #2는 feature 001이 `pg` 패키지를 필요로 했는데
# builder가 매니페스트를 못 건드려 네 라운드(≈$67)가 "Harness change needed" → verifier reject →
# needs-human으로 끝났다. 그 요청은 이제 implement handoff의 `harness_needed`로 나가고 `factory:harness`
# 이슈가 되는데, **그 이슈의 builder도 매니페스트를 못 쓰면 같은 벽에 다시 부딪힌다** — 의존성 추가가
# 바로 그 이슈가 하려는 일이다. `.factory/package.json`(러너 자신의 매니페스트)만은 이름으로 다시 세워
# 계속 막는다: 그것을 열면 게이트를 돌리는 런타임 자체를 바꿀 수 있다.
# `.factory/`를 통짜로 여는 것이 아니라 나머지 하위 경로를 이름으로 다시 세운다 — `bin`·`lib`·`actions`·
# `lessons`·`out`(게이트 판정 파일과 agents.jsonl이 산다: 이것이 열리면 판정을 위조할 수 있다)·
# `ci-settings*`·`roles.toml`·`quarantine.toml`·`package.json`.
# `.claude/**`·워크플로·CHARTER·tsconfig·eslint는 한 글자도 열리지 않는다.
# 이 목록은 `ci-settings-harness.json`의 deny와 같아야 한다(F9와 같은 이유: 훅과 L2가 갈라지면 Edit는
# 막히는데 `echo >`는 통과한다). 플래그가 없으면(=평범한 이슈) 이 블록은 아무 일도 하지 않는다.
# **머지는 그대로 사람이다**: package.json은 `[protected].factory`에 남아 있어 L1이 자동 머지를 거부한다.
if [ "${FACTORY_HARNESS_ISSUE:-}" = "1" ]; then
  prot='(\.factory/(bin|lib|actions|lessons|out)/|\.factory/(ci-settings[a-zA-Z0-9._-]*\.json|roles\.toml|quarantine\.toml|package\.json)|\.claude/|\.github/workflows/factory-|docs/factory/CHARTER\.md|tsconfig[a-zA-Z0-9._-]*\.json|\.eslintrc|eslint\.config\.)'
fi

# `.factory/out/qa/**`는 qa 리뷰어의 증거 디렉터리다(harness.toml `[protected].except`, F3) — 거기 쓰는 것만
# 예외로 통과시킨다. 보호 경로 검사에만 쓰는 사본 `$p`에서 그 토큰을 지우는 방식이라 `.factory/`의 나머지는
# 그대로 막힌다. 단 `..`가 뒤따르면(`.factory/out/qa/../harness.toml`) 예외를 아예 적용하지 않는다 —
# 카브아웃으로 보호 경로를 빠져나갈 수 있으면 카브아웃이 아니라 구멍이다.
qa='\.factory/out/qa/[^[:space:]"]*'
p="$c"
printf '%s' "$c" | grep -Eq "$qa\.\." || p=$(printf '%s' "$c" | sed -E "s#(\./)?$qa##g")

echo "$p" | grep -Eq "(>>?|tee[[:space:]]+(-a[[:space:]]+)?)[[:space:]]*[\"']?[^[:space:]\"']*$prot" && block "write to protected path"
# KTB-15b: `-i`도 값을 붙여 받는다(`sed -i.bak …`) — deny-all-writes.sh의 같은 수정과 짝이다.
# `--in-place[=SUFFIX]`(GNU 긴 옵션)도 같이 잡는다.
echo "$p" | grep -Eq "sed[[:space:]]+(-[a-zA-Z]*i[^;&|[:space:]]*[[:space:]]+|--in-place(=[^;&|[:space:]]*)?[[:space:]]+)[^;&|]*$prot" && block "sed -i on protected path"
echo "$p" | grep -Eq "(^|[;&|[:space:]])(cp|mv)[[:space:]]+[^;&|]*[[:space:]]$prot" && block "cp/mv onto protected path"
echo "$p" | grep -Eq "(^|[;&|[:space:]])perl[[:space:]]+-[a-zA-Z]*i[^;&|]*$prot" && block "perl -i on protected path"
echo "$p" | grep -Eq "(^|[;&|[:space:]])python[0-9.]*[[:space:]]+-c[^;&|]*$prot" && block "python -c touching protected path"
# 보호 경로를 **옮기거나 지우는** 것도 편집이다(ADR-020 fix round 1). `git mv`로 보호 경로를 보호되지
# 않는 이름으로 옮기면 파일 내용은 한 글자도 안 바뀌고도 그 경로가 하는 일(예: required 체크를 만드는
# 워크플로)이 사라진다. `integrity`/L1은 diff에서 그 출발지를 잡지만, 훅이 먼저 막는 것이 싸다.
echo "$p" | grep -Eq "(^|[;&|[:space:]])${G}(rm|mv)[[:space:]]+[^;&|]*$prot" && block "git rm/mv on protected path"
# 셸의 rm/mv도 같다. 위의 cp|mv 규칙은 보호 경로가 **목적지**일 때만 걸린다 — `mv .factory/harness.toml /tmp/x`
# 처럼 보호 경로가 **출발지**면 빠져나갔다(fix round 2). rm에는 목적지가 아예 없으므로 더욱 그렇다.
# 알려진 오탐(N4): 경로 정규식은 파일명만 보므로 `rm -rf node_modules/foo/package.json`도 막힌다.
# 좁히려면 경로를 앵커해야 하는데, 그러면 `./package.json`·`$PWD/package.json` 같은 우회가 생긴다 —
# 지우지 못해 불편한 쪽이 조용히 지워지는 쪽보다 낫다고 보고 그대로 둔다(cp는 읽기라 계속 허용).
echo "$p" | grep -Eq "(^|[;&|[:space:]])(rm|mv)[[:space:]][^;&|]*$prot" && block "rm/mv touching protected path"

# ── KTB-13 r1: `Bash(*)`가 allow에 들어온 뒤에 도달 가능해진 쓰기 모양들 ──────────────────────────
# allow가 좁을 때는 `node`·`curl`·`wget`·`install`·`dd`가 애초에 allow 밖이라 이 훅까지 오지도 않았다.
# 이제 온다 — 그리고 넷 다 보호 경로에 파일을 쓸 수 있다. 위의 `sed -i`/`python -c` 줄들과 같은 모양이다.
# `node -e|-p|--eval|--print`의 스크립트 본문이 보호 경로를 말하면 막는다. 저장소 스크립트를 **실행**하는
# `node .factory/bin/gates.js full`은 그대로다(플래그가 없다) — 플래그 토큰은 공백 뒤에서만 매치를 시작하므로
# `node --version`도 걸리지 않는다.
echo "$p" | grep -Eq "(^|[;&|[:space:]])node[0-9.]*[[:space:]]+([^;&|]*[[:space:]])?(-[a-zA-Z]*[ep][a-zA-Z]*|--eval|--print)[^;&|]*$prot" && block "node inline script touching protected path"
echo "$p" | grep -Eq "(^|[;&|[:space:]])dd[[:space:]]+[^;&|]*of=[\"']?[^[:space:]\"']*$prot" && block "dd onto protected path"
echo "$p" | grep -Eq "(^|[;&|[:space:]])install[[:space:]]+[^;&|]*$prot" && block "install onto protected path"
# curl/wget은 세그먼트 안에 보호 경로가 보이면 막는다 — `-o`·`-O`·`--output`·`--output-document` 중
# 어느 철자인지 가리지 않는다(출력 플래그의 형태를 하나씩 쫓는 것보다 목적지를 보는 쪽이 튼튼하다).
echo "$p" | grep -Eq "(^|[;&|[:space:]])curl[[:space:]]+[^;&|]*$prot" && block "curl downloading onto protected path"
echo "$p" | grep -Eq "(^|[;&|[:space:]])wget[[:space:]]+[^;&|]*$prot" && block "wget downloading onto protected path"
# `git checkout <ref> -- <path>` · `git restore [--source=…] <path>`는 **다른 커밋의 내용으로 워킹 트리를
# 덮어쓴다** — 내용은 명령줄에 없고 경로만 보인다. 브랜치를 만들거나 옮기는 checkout(`-b`, `git checkout main`)과
# 인덱스만 되돌리는 `git restore --staged src/a.js`는 보호 경로를 말하지 않으므로 그대로 통과한다.
# 알려진 오탐: `git restore --staged package.json`(인덱스만)도 막힌다 — 워킹 트리를 덮는 형태와 명령줄에서
# 구별되지 않으므로 막는 쪽을 택한다.
echo "$p" | grep -Eq "(^|[;&|[:space:]])${G}(checkout|restore)[[:space:]]+[^;&|]*$prot" && block "git checkout/restore onto protected path"
# `git apply`/`git am`은 **패치 파일**이 쓰는 내용을 명령줄에 싣지 않는다 — 이 훅은 무엇이 쓰이는지 볼 수조차
# 없으므로 보호 경로만 골라 막을 방법이 없다. 판정 불능은 "안전"이 아니다(이 파일 맨 위의 jq 규칙과 같은 원칙):
# 전면 차단한다. builder는 손실이 없다 — KTB-13 이후 `Edit`/`Write`가 allow에 있어서 파일을 직접 쓴다.
# (데모 #8이 편집을 `git apply`에 실어 나른 것은 그때 Edit/Write가 거절됐기 때문이고, 그 우회로가 바로
#  여기서 닫힌다. L1은 PR에 도달한 diff만 본다 — 워크트리 안에서 끝나는 변조는 diff가 되지 않는다.)
echo "$c" | grep -Eq "(^|[;&|[:space:]])${G}(apply|am)([[:space:]]|$)" && block "git apply/am (patch contents are invisible to this hook — use Edit/Write)"

# 상태 라벨은 L1(`transition.js`)만 옮긴다 — 에이전트가 `factory:*` 라벨을 직접 붙이거나 떼면 라벨 그래프가
# 거부했어야 할 전이가 조용히 일어나고, 다음 스테이지 워크플로가 그 라벨 이벤트로 깨어난다(F13).
# 코멘트는 막지 않는다: handoff·rework-response는 코멘트로 나간다.
echo "$c" | grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+issue[[:space:]]+edit[^;&|]*--(add|remove)-label[^;&|]*factory:' && block "gh issue edit --add/remove-label factory:*"
echo "$c" | grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+api[^;&|]*/issues/[0-9]+/labels' && block "gh api issues labels"

# ── KTB-21: builder는 진행 중인 테스트 env를 무너뜨릴 수 없다 ─────────────────────────────────────
# 데모 #18: qa 리뷰어가 증거 수집 중 `docker compose down`으로 env를 내려, 28분 뒤 review 게이트가
# 죽은 env에 대고 돌아 4/4 승인인데도 `unit`이 `service "db" is not running`으로 RED였다. builder도
# 같은 실수를 할 수 있다 — `down`/`stop`/`rm`/`kill`/`restart`는 여기서도 막는다. `up`은 막지
# **않는다**: 멱등이고(`test-env.js up`이 gates 전에도 스스로 부른다), builder가 자기 작업 중 env를
# 다시 올리는 것은 정상 작업이다 — deny-all-writes.sh(읽기 전용 역할)만 `up`까지 막는다.
DOCKER_TEARDOWN_VERBS='(down|stop|rm|kill|restart)'
echo "$c" | grep -Eq "(^|[;&|[:space:]])(docker[[:space:]]+compose|docker-compose)([[:space:]]+[^;&|]*)?[[:space:]]${DOCKER_TEARDOWN_VERBS}([[:space:]]|\$)" && block "docker compose down/stop/rm/kill/restart tears down the test env"
echo "$c" | grep -Eq "(^|[;&|[:space:]])docker[[:space:]]+${DOCKER_TEARDOWN_VERBS}([[:space:]]|\$)" && block "docker stop/rm/kill/restart tears down the test env"
echo "$c" | grep -Eq "(^|[;&|[:space:]])docker[[:space:]]+container[[:space:]]+(stop|rm|kill)([[:space:]]|\$)" && block "docker container stop/rm/kill tears down the test env"
exit 0
