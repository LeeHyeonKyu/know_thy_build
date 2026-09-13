import { test, expect } from "vitest";
import { run } from "../lib/exec.js";
import { needsDenyAllWritesHook } from "../lib/agent-md.js";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const H = new URL("../hooks/", import.meta.url).pathname;
const bash = (script, input, cwd, env) => run("bash", [join(H, script)], { input: JSON.stringify(input), cwd, env });
const cmd = (c) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: c } });

test("block-dangerous: blocks merges, force pushes, protected writes; allows normal commands", async () => {
  const blocked = ["gh pr merge 5", "git merge feature", "git push --force origin x", "git push -f origin x", "git push origin --force-with-lease",
                   "echo x > .factory/harness.toml", "sed -i 's/a/b/' .claude/settings.json", "cat foo | tee docs/factory/CHARTER.md", "echo y >> .github/workflows/factory-implement.yml",
                   "git push origin --force-with-lease=refs/heads/main:abc", "git push origin --delete refs/heads/factory/lock-7", "git push origin --delete factory/lock-7", "git push origin :refs/heads/factory/lock-7",
                   "git push origin +main:main", "git push origin +refs/heads/claude/fq-7:refs/heads/main",
                   "gh api -X PUT repos/o/r/pulls/9/merge", "gh api repos/o/r/pulls/9/merge --method PUT",
                   "cp /tmp/evil .factory/harness.toml", "mv /tmp/evil docs/factory/CHARTER.md",
                   "perl -i -pe 's/a/b/' .claude/settings.json", "perl -pi -e 's/a/b/' .factory/harness.toml",
                   "python3 -c \"open('.factory/harness.toml','w').write('x')\"",
                   // ADR-020 fix round 1: 옮기거나 지우는 것도 편집이다 — `git mv`로 required 체크를 만드는
                   // 워크플로를 보호되지 않는 이름으로 옮기면 내용 변경 없이 그 체크가 사라진다.
                   "git mv .github/workflows/factory-integrity.yml ci-integrity.yml",
                   "git rm .github/workflows/factory-merge.yml", "git rm -r .factory/lib",
                   "git mv docs/factory/CHARTER.md docs/charter.md", "git rm package.json",
                   // fix round 2: git의 **전역 옵션**이 동사 앞에 끼어들어도 규칙이 걸려야 한다 —
                   // `git -C <dir> rm ...`는 `git rm ...`와 똑같은 일을 하고, 앵커가 없으면 통째로 빠져나간다.
                   "git -C /repo rm .factory/harness.toml", "git --git-dir=.git merge x",
                   "git -C . push --force origin x", "git -c user.name=x push -f origin main",
                   "git --work-tree=/repo mv docs/factory/CHARTER.md docs/x.md",
                   "git -C /repo -c core.pager=cat rm -r .claude/agents",
                   // 그리고 보호 경로를 **출발지**로 삼는 평범한 mv/rm도 막는다(기존 cp|mv 규칙은 목적지만 봤다)
                   "mv .factory/harness.toml /tmp/x", "rm .factory/harness.toml", "rm -rf .claude/agents",
                   "rm -f docs/factory/CHARTER.md", "mv package.json package.json.bak"];
  const allowed = ["git push origin HEAD", "git commit -m x", "npm test", "cat .factory/harness.toml", "gh pr view 5",
                   "git push origin HEAD:refs/heads/claude/fq-7", "git push origin --delete claude/fq-7",
                   "cp .factory/harness.toml /tmp/backup", "python3 -c \"print(1)\"",
                   "git rm src/old.js", "git mv src/a.js src/b.js",   // 보호 경로가 아닌 곳의 rm/mv는 정상 작업이다
                   "git -C /repo status", "git -c user.name=x commit -m x", "git -C /repo push origin HEAD",
                   "rm -rf dist", "mv src/a.js src/b.js", "rm /tmp/scratch"];
  await Promise.all(blocked.map(async (c) => {
    const r = await bash("block-dangerous.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: blocked/);
  }));
  await Promise.all(allowed.map(async (c) => expect((await bash("block-dangerous.sh", cmd(c))).code, c).toBe(0)));
}, 30000);   // 30여 개의 bash 프로세스를 띄운다 — 기본 5s 타임아웃으로는 모자란다

// ── KTB-13 r1: `Bash(*)`가 allow에 들어온 뒤 이 훅이 유일한 셸 경계다 ────────────────────────────
// allow가 좁을 때는 `node`·`curl`·`wget`·`install`이 애초에 allow에 없어 도달하지 못했다. 이제 도달한다 —
// 그리고 넷 다 보호 경로에 **파일을 쓸 수 있는 명령**이다. `git checkout/restore`는 다른 커밋의 내용으로
// 워킹 트리를 덮어쓰고, `git apply`는 패치 내용이 명령줄에 없어서 훅이 무엇을 쓰는지 **볼 수조차 없다**.
test("block-dangerous: node -e/dd/install/curl/wget/git checkout|restore|apply on protected paths (KTB-13 r1)", async () => {
  const blocked = [
    "node -e \"require('fs').writeFileSync('package.json','{}')\"",
    "node --eval \"fs.writeFileSync('.factory/harness.toml','x')\"",
    "node -pe \"require('fs').writeFileSync('.claude/settings.json','x')\"",
    "dd if=/tmp/x of=package.json",
    "dd if=/tmp/x of=.factory/harness.toml bs=1",
    "install -m 644 /tmp/x .factory/harness.toml",
    "install /tmp/x docs/factory/CHARTER.md",
    "curl -o package.json https://e/x",
    "curl -sLo .factory/harness.toml https://e/x",
    "wget -O docs/factory/CHARTER.md https://e/x",
    "wget --output-document=.claude/settings.json https://e/x",
    // 다른 커밋의 내용으로 워킹 트리를 덮는다 — 내용은 diff에만 남고 명령줄에는 보호 경로만 보인다.
    "git checkout HEAD~1 -- package.json",
    "git checkout origin/main -- .factory/harness.toml",
    "git restore --source=HEAD~1 -- .claude/settings.json",
    "git restore package.json",
    // 패치는 명령줄에 없다: 훅은 이 명령이 무엇을 쓰는지 알 수 없다 → 전면 차단(fail closed).
    "git apply /tmp/patch.diff", "git apply --3way p.diff", "git am /tmp/x.patch",
    "git -C /repo apply p.diff",
  ];
  const allowed = [
    // 브랜치를 만들거나 옮기는 checkout, 인덱스만 건드리는 restore는 그대로다.
    "git checkout -b claude/fq-7", "git checkout main", "git restore --staged src/a.js",
    "git checkout HEAD~1 -- src/a.js", "git restore src/a.js",
    // 보호 경로를 언급하지 않는 inline node·다운로드·dd·install은 이 훅의 관심사가 아니다.
    "node -e \"console.log(1)\"", "node .factory/bin/gates.js full", "node --version",
    "curl -s https://api.example.com/x", "wget https://example.com/x.tar.gz",
    "dd if=/dev/zero of=/tmp/x bs=1", "install -m 755 /tmp/a /tmp/b",
  ];
  await Promise.all(blocked.map(async (c) => {
    const r = await bash("block-dangerous.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: blocked/);
  }));
  await Promise.all(allowed.map(async (c) => expect((await bash("block-dangerous.sh", cmd(c))).code, c).toBe(0)));
}, 30000);

// F9 carry-over: `[protected].factory`와 settings.json deny는 이미 빌드 설정 파일을 덮는다(templates.test.js).
// 훅도 같은 목록을 덮어야 한다 — 그렇지 않으면 Edit는 막히는데 `echo > package.json`은 통과한다.
test("block-dangerous: shell writes to the protected build-config files are blocked too; reading them is not", async () => {
  const blocked = ["echo '{}' > package.json", "echo x >> package-lock.json",
                   "sed -i 's/a/b/' vitest.config.js", "sed -i '' 's/a/b/' playwright.config.ts",
                   "cat foo | tee tsconfig.json", "cat foo | tee -a tsconfig.build.json",
                   "cp /tmp/evil .eslintrc.json", "mv /tmp/evil eslint.config.js",
                   "perl -i -pe 's/a/b/' package.json",
                   "python3 -c \"open('package.json','w').write('{}')\"",
                   "npm pkg set scripts.test=true > package.json"];
  const allowed = ["cat package.json", "npm test", "npx vitest run", "git diff package.json",
                   "cp package.json /tmp/backup", "node -e \"1\" > /tmp/out.json",
                   "grep -n vitest package.json", "cat vitest.config.js | head -5"];
  await Promise.all(blocked.map(async (c) => {
    const r = await bash("block-dangerous.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: blocked/);
  }));
  await Promise.all(allowed.map(async (c) => expect((await bash("block-dangerous.sh", cmd(c))).code, c).toBe(0)));
}, 30000);

// ── F3(b): qa의 증거 디렉터리만 카브아웃 ────────────────────────────────────────────────────
test("block-dangerous: .factory/out/qa/ is writable (qa evidence); the rest of .factory/ is not", async () => {
  const allowed = ["echo x > .factory/out/qa/7.log", "cat foo | tee .factory/out/qa/7-server.log",
                   "cp /tmp/shot.png .factory/out/qa/7-shot.png", "mv /tmp/shot.png ./.factory/out/qa/7-shot.png",
                   "mkdir -p .factory/out/qa", "echo x >> .factory/out/qa/7.log"];
  const blocked = ["echo x > .factory/out/gates.json", "echo x > .factory/harness.toml",
                   "echo x > .factory/out/qa/../harness.toml", "cp /tmp/e .factory/out/qa/../../harness.toml",
                   "echo x > .claude/settings.json"];
  await Promise.all(allowed.map(async (c) => expect((await bash("block-dangerous.sh", cmd(c))).code, c).toBe(0)));
  await Promise.all(blocked.map(async (c) => {
    const r = await bash("block-dangerous.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: blocked/);
  }));
}, 30000);

// ── KTB-20: `factory:harness` 이슈의 builder만 테스트 인프라 파일을 셸로 쓸 수 있다 ──────────────
// 도그푸딩 #15("promote to M2")에서 builder는 `.factory/harness.toml`·컴포즈·e2e 설정을 하나도 건드릴
// 수 없어 승격 PR에 승격이 들어가지 못했다. 스펙 §5.2.1의 의도는 그 반대다 — factory가 인프라를 만들고
// 사람이 그 diff를 머지한다(L1은 보호 경로 PR의 자동 머지를 계속 거부한다). run-stage.js가 그 이슈의
// implement에서만 `FACTORY_HARNESS_ISSUE=1`을 세우고, 이 훅은 그때만 목록을 좁힌다.
test("block-dangerous: FACTORY_HARNESS_ISSUE=1 opens the test-infra files — and only those (KTB-20)", async () => {
  const harness = { FACTORY_HARNESS_ISSUE: "1" };
  // 플래그가 서면 통과하는 것: 승격이 실제로 건드리는 파일들
  const opened = ["echo x > .factory/harness.toml", "sed -i 's/M1/M2/' .factory/harness.toml",
                  "cp /tmp/h.toml .factory/harness.toml", "mv /tmp/h.toml .factory/harness.toml",
                  "python3 -c \"open('.factory/harness.toml','w').write('x')\"",
                  "cat t | tee vitest.config.js", "sed -i '' 's/a/b/' playwright.config.ts",
                  "echo x > playwright.config.js", "git checkout HEAD~1 -- .factory/harness.toml",
                  // KTB-23: 의존성 추가가 바로 하네스 이슈가 하려는 일이다 — 매니페스트를 못 쓰면
                  // 데모 #2의 벽에 다시 부딪힌다(머지는 여전히 사람이다 — L1이 자동 머지를 거부한다).
                  "npm pkg set dependencies.pg=^8 > package.json", "echo '{}' > package.json",
                  "sed -i 's/1.0.0/1.0.1/' package-lock.json", "cp /tmp/lock package-lock.json"];
  for (const c of opened) {
    expect((await bash("block-dangerous.sh", cmd(c), undefined, harness)).code, `with flag: ${c}`).toBe(0);
    expect((await bash("block-dangerous.sh", cmd(c))).code, `without flag: ${c}`).toBe(2);   // 평범한 이슈는 그대로 막힌다
  }
  // 플래그가 서도 막히는 것: 팩토리 자신의 코드·판정·프롬프트·워크플로·빌드 설정
  const stillBlocked = ["echo x > .factory/lib/gates.js", "echo x > .factory/bin/run-stage.js",
                        "echo x > .factory/out/gates.json", "echo x > .factory/out/agents.jsonl",
                        "echo x > .factory/ci-settings.json", "echo x > .factory/ci-settings-harness.json",
                        "echo x > .factory/roles.toml", "echo x > .factory/quarantine.toml",
                        "echo x > .factory/lessons/factory-builder.md", "echo x > .factory/package.json",
                        // KTB-23 fix: 러너 자신의 **락파일**도 같다 — 실제로 설치되는 코드를 정하는 것은 락이다.
                        "echo x > .factory/package-lock.json", "sed -i 's/a/b/' .factory/package-lock.json",
                        "echo x > .factory/actions/setup/action.yml",
                        "echo x > .claude/settings.json", "rm -rf .claude/agents",
                        "echo y >> .github/workflows/factory-implement.yml",
                        "cat foo | tee docs/factory/CHARTER.md",
                        "cat foo | tee tsconfig.json", "mv /tmp/evil eslint.config.js",
                        "gh pr merge 5", "git push --force origin x",
                        "gh issue edit 7 --add-label factory:approved"];
  for (const c of stillBlocked) {
    const r = await bash("block-dangerous.sh", cmd(c), undefined, harness);
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: blocked/);
  }
  // 플래그는 정확히 "1"일 때만 선다 — 빈 문자열·0·다른 값은 평범한 이슈와 같다(fail closed).
  for (const v of ["", "0", "true", "yes"]) {
    const r = await bash("block-dangerous.sh", cmd("echo x > .factory/harness.toml"), undefined, { FACTORY_HARNESS_ISSUE: v });
    expect(r.code, `FACTORY_HARNESS_ISSUE=${JSON.stringify(v)}`).toBe(2);
  }
}, 60000);

// ── KTB-21: 진행 중인 테스트 env를 무너뜨리면 나중 게이트가 죽은 env에 대고 돈다(데모 #18) ────────
// builder는 여전히 `up`(멱등)을 쓸 수 있다 — 막는 것은 서비스를 멈추는 동사뿐이다.
test("block-dangerous: docker compose/docker teardown verbs are blocked; ps/logs/exec/version/up are not", async () => {
  const blocked = [
    "docker compose -f x.yml down", "docker compose down 2>&1 | tee /tmp/log", "docker-compose down",
    "docker compose stop", "docker compose -f x.yml rm -f", "docker compose kill", "docker-compose restart",
    "docker stop db", "docker rm -f db", "docker kill db", "docker restart db",
    "docker container stop db", "docker container rm -f db", "docker container kill db",
  ];
  const allowed = [
    "docker compose ps -a", "docker compose logs db", "docker compose -f x.yml exec -T db psql -U u -d d -c 'select 1'",
    "docker --version", "docker compose version", "docker compose up -d", "docker compose -f x.yml up",
  ];
  await Promise.all(blocked.map(async (c) => {
    const r = await bash("block-dangerous.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: blocked/);
  }));
  await Promise.all(allowed.map(async (c) => expect((await bash("block-dangerous.sh", cmd(c))).code, c).toBe(0)));
}, 30000);

// ── F13: 상태 라벨은 L1(transition.js)만 옮긴다 ─────────────────────────────────────────────
test("block-dangerous: gh label edits on factory:* are blocked; gh issue comment is not", async () => {
  const blocked = ["gh issue edit 7 --add-label factory:approved", "gh issue edit 7 --remove-label factory:queue",
                   "gh issue edit 7 --add-label=factory:blocked",
                   "gh api -X POST repos/o/r/issues/7/labels -f labels=factory:approved",
                   "gh api repos/o/r/issues/7/labels --method DELETE"];
  const allowed = ["gh issue comment 7 --body-file /tmp/b.md", "gh issue view 7 --comments", "gh pr comment 7 --body-file /tmp/b.md",
                   "gh issue edit 7 --title x"];
  await Promise.all(blocked.map(async (c) => {
    const r = await bash("block-dangerous.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: blocked/);
  }));
  await Promise.all(allowed.map(async (c) => expect((await bash("block-dangerous.sh", cmd(c))).code, c).toBe(0)));
}, 30000);

// ── ADR-020 최종 리뷰 MF-3: 위험한 동사는 **토큰 경계**에서 잡힌다 ──────────────────────────────
// r1까지의 앵커는 `(^|[;&|[:space:]])`였다 — `(`도 백틱도 `=`도 없어서, 동사가 눈앞에 그대로 있는
// `out=$(gh pr merge 5 --squash)`가 **어떤 규칙에도 걸리지 않았다**. `.claude/settings.json`의
// `Bash(gh pr merge*)` deny는 접두 매칭이라 같은 명령을 스치지도 않는다: 훅이 유일한 방벽인데
// 그 훅이 비어 있었다. 표는 리뷰가 실제로 실행해 통과시킨 우회들을 그대로 싣는다.
const EVASIONS = (verb) => [
  `out=$(${verb})`,          // 명령 치환 + 할당 — 리뷰가 실증한 모양
  `$(${verb})`,              // 할당 없는 명령 치환
  "`" + verb + "`",          // 백틱
  `echo start; ${verb}`,     // `;` 체인
  `true && ${verb}`,         // `&&` 체인
  `false || ${verb}`,        // `||` 체인
  `{ ${verb}; }`,            // 그룹
  `echo x | xargs -I{} ${verb}`,   // 파이프 뒤
];
test("block-dangerous: the dangerous verb is anchored at a token boundary, not at line start (MF-3)", async () => {
  const verbs = [
    // 머지 — 리뷰되지 않은 자기 PR을 builder가 스스로 머지하는 경로(L1이 통째로 건너뛰어진다)
    "gh pr merge $PR --squash --delete-branch",
    "gh api -X PUT repos/o/r/pulls/9/merge",
    "git merge main",
    // 락 브랜치 삭제 — 이슈 단위 상호배제의 유일한 근거
    "git push origin --delete factory/lock-7",
    "git push origin :refs/heads/factory/lock-7",
    "git push origin :factory/lock-7",
    // 라벨 그래프 우회
    "gh issue edit 7 --add-label factory:approved",
    "gh api -X DELETE /repos/o/r/issues/7/labels/factory:approved",
    // 브랜치 보호·룰셋 = L0 자체 (SF-2: 철자를 가리지 않는다)
    "gh api -X PUT /repos/o/r/branches/main/protection",
    "gh api --method PUT /repos/o/r/branches/main/protection -f x=1",
    "gh api -X DELETE /repos/o/r/branches/main/protection",
    "gh api --method POST /repos/o/r/rulesets -f x=1",
    "gh ruleset delete 3",
    // 보호 경로 · 테스트 env
    "rm -rf .factory/lib",
    "ln -sf /tmp/evil .claude/settings.json",
    "chmod -x .factory/bin/gates.js",
    "docker compose down",
    "git apply /tmp/p.diff",
    "git push --force origin main",
  ];
  const cases = verbs.flatMap((v) => [v, ...EVASIONS(v)]);
  await Promise.all(cases.map(async (c) => {
    const r = await bash("block-dangerous.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: blocked/);
  }));
}, 120000);

// 넓힌 경계가 정상 작업을 잡아먹지 않는지 — 같은 글자들이 무해한 자리에 있을 때는 조용하다.
test("block-dangerous: the widened token boundary does not swallow normal commands (MF-3)", async () => {
  const allowed = [
    "out=$(git status --porcelain)", "sha=$(git rev-parse HEAD)", "echo `git log -1 --format=%H`",
    "npm test && git commit -m x", "git push origin HEAD || echo failed",
    "{ npm run lint; npm test; }", "gh pr view 5 --json mergeable",
    "gh api repos/o/r/pulls/9 --jq .head.sha",        // /merge가 아닌 PR 조회
    "gh issue comment 7 --body-file /tmp/b.md",
    "chmod +x scripts/run.sh", "ln -s ../shared src/shared",   // 보호 경로가 아니면 그대로다
    "PR=$(gh pr list --json number --jq '.[0].number')",
    "docker compose up -d",                            // up은 막지 않는다(KTB-21)
  ];
  await Promise.all(allowed.map(async (c) => expect((await bash("block-dangerous.sh", cmd(c))).code, c).toBe(0)));
}, 60000);

// deny-all-writes의 `$CMD`도 같은 결함을 갖고 있었다 — 두 훅은 한 우회에 같이 열려 있었다.
test("deny-all-writes: write verbs inside $( ), backticks, chains and groups are caught too (MF-3)", async () => {
  const verbs = ["rm -rf src", "mkdir build", "touch src/a.js", "chmod 777 src/a.js", "ln -s /tmp/x src/y",
                 "tee src/a.js", "git commit -m x", "git push origin HEAD", "wget https://e/x",
                 "curl -o src/a.js https://e/x", "sed -i s/a/b/ src/a.js", "docker compose down"];
  const cases = verbs.flatMap((v) => [v, `out=$(${v})`, "`" + v + "`", `echo x; ${v}`, `true && ${v}`, `{ ${v}; }`]);
  await Promise.all(cases.map(async (c) => {
    const r = await bash("deny-all-writes.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: this role must not write/);
  }));
}, 120000);

test("deny-all-writes: the widened token boundary still lets read-only work through (MF-3)", async () => {
  const allowed = ["out=$(git status --porcelain)", "n=$(ls src | wc -l)", "echo `git rev-parse HEAD`",
                   "npm test && npm run lint", "{ npm test; git diff; }", "grep -rn mkdir src/",
                   "cat src/a.js | head -5", "node .factory/bin/gates.js full"];
  await Promise.all(allowed.map(async (c) => expect((await bash("deny-all-writes.sh", cmd(c))).code, c).toBe(0)));
}, 60000);

test("block-dangerous: non-Bash tools and malformed input pass through", async () => {
  expect((await bash("block-dangerous.sh", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: ".factory/x" } })).code).toBe(0);
  expect((await run("bash", [join(H, "block-dangerous.sh")], { input: "not json" })).code).toBe(0);
}, 30000);

test("block-dangerous: without jq the hook fails CLOSED (exit 2)", async () => {
  const r = await run("/bin/bash", [join(H, "block-dangerous.sh")], { input: JSON.stringify(cmd("echo hi")), env: { PATH: "/nonexistent" } });
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/jq missing/);
}, 30000);

// KTB-13 이후 이 테스트가 지는 무게가 달라졌다. `.claude/settings.json`의 allow가 이제 `Edit`/`Write`/
// `Bash(*)`를 **전역으로** 부여하므로(그러지 않으면 `dontAsk`가 builder의 쓰기까지 거절한다), 쓰기 금지
// 역할을 막는 것은 permission 규칙이 아니라 **오직 이 훅**이다. 순서가 이것을 가능하게 한다:
// PreToolUse 훅은 permission 판정보다 **먼저** 돌고 exit 2는 도구 호출 자체를 차단한다 — allow에 있든
// 없든 관계없다. 그래서 "allow가 넓어졌다"가 "리뷰어가 쓸 수 있다"를 뜻하지 않는다(ADR-020 KTB-13).
test("deny-all-writes: blocks Edit/Write/NotebookEdit with a message, allows everything else, fails closed without jq", async () => {
  const r1 = await bash("deny-all-writes.sh", { tool_name: "Edit", tool_input: { file_path: "src/a.js" } });
  expect(r1.code).toBe(2);
  expect(r1.stderr).toMatch(/factory: this role must not write files \(Edit src\/a\.js\)/);

  const r2 = await bash("deny-all-writes.sh", { tool_name: "Write", tool_input: { file_path: "b.md" } });
  expect(r2.code).toBe(2);
  expect(r2.stderr).toMatch(/factory: this role must not write files \(Write b\.md\)/);

  const r3 = await bash("deny-all-writes.sh", { tool_name: "NotebookEdit", tool_input: { file_path: "n.ipynb" } });
  expect(r3.code).toBe(2);

  expect((await bash("deny-all-writes.sh", { tool_name: "Read", tool_input: { file_path: "src/a.js" } })).code).toBe(0);
  expect((await bash("deny-all-writes.sh", { tool_name: "Bash", tool_input: { command: "ls" } })).code).toBe(0);

  const noJq = await run("/bin/bash", [join(H, "deny-all-writes.sh")], { input: JSON.stringify({ tool_name: "Edit" }), env: { PATH: "/nonexistent" } });
  expect(noJq.code).toBe(2);
  expect(noJq.stderr).toMatch(/jq missing/);
}, 30000);

test("deny-all-writes: malformed stdin passes through (exit 0), same as block-dangerous", async () => {
  expect((await run("bash", [join(H, "deny-all-writes.sh")], { input: "not json" })).code).toBe(0);
}, 30000);

// ── F3(c): qa만 .factory/out/qa/ 아래에 증거를 쓴다 ──────────────────────────────────────────
test("deny-all-writes: Write/Edit into .factory/out/qa/ is allowed; anything else (and any ..) is not", async () => {
  const write = (file_path, tool = "Write") => bash("deny-all-writes.sh", { tool_name: tool, tool_input: { file_path } });
  for (const p of [".factory/out/qa/7-shot.png", "./.factory/out/qa/7-server.log", ".factory/out/qa/deep/7.log"]) {
    expect((await write(p)).code, p).toBe(0);
    expect((await write(p, "Edit")).code, p).toBe(0);
  }
  // 절대 경로는 `$CLAUDE_PROJECT_DIR`를 모르는 한 거절한다 — 이 저장소 안인지 판단할 근거가 없다
  for (const p of [".factory/out/qa/../gates.json", "src/.factory/out/qa/../../a.js", ".factory/out/gates.json",
                   ".factory/out/qa", "x.factory/out/qa/7.log", "src/a.js", "",
                   "/repo/.factory/out/qa/7.log", "/tmp/evil/.factory/out/qa/7.log"]) {
    const r = await write(p);
    expect(r.code, p).toBe(2);
    expect(r.stderr, p).toMatch(/must not write files/);
  }
  // NotebookEdit은 예외가 없다 — 증거는 파일이지 노트북이 아니다
  expect((await write(".factory/out/qa/7.ipynb", "NotebookEdit")).code).toBe(2);
}, 30000);

// run-stage가 `claude -p`에 넘기는 CLAUDE_PROJECT_DIR가 있으면, 도구가 주는 **절대** file_path도 받는다 —
// 그것이 없으면 실제 실행에서 qa는 증거를 한 줄도 남길 수 없다(도구는 보통 절대 경로를 준다).
test("deny-all-writes: an absolute qa path is accepted only under $CLAUDE_PROJECT_DIR", async () => {
  const proj = "/repo";
  const write = (file_path, env, tool = "Write") =>
    run("bash", [join(H, "deny-all-writes.sh")], { input: JSON.stringify({ tool_name: tool, tool_input: { file_path } }), env: { ...process.env, ...env } });

  for (const p of ["/repo/.factory/out/qa/7.png", "/repo/.factory/out/qa/deep/7.log"]) {
    expect((await write(p, { CLAUDE_PROJECT_DIR: proj })).code, p).toBe(0);
    expect((await write(p, { CLAUDE_PROJECT_DIR: `${proj}/` })).code, `${p} (trailing slash)`).toBe(0);
    expect((await write(p, { CLAUDE_PROJECT_DIR: proj }, "Edit")).code, `${p} Edit`).toBe(0);
  }
  // 프로젝트 밖 · 프로젝트 안이지만 qa 디렉터리가 아님 · 트래버설 · 루트를 모를 때 → 전부 거절
  for (const [p, env] of [
    ["/tmp/evil/.factory/out/qa/7.png", { CLAUDE_PROJECT_DIR: proj }],
    ["/elsewhere/.factory/out/qa/7.png", { CLAUDE_PROJECT_DIR: proj }],
    ["/repo/sub/.factory/out/qa/7.png", { CLAUDE_PROJECT_DIR: proj }],
    ["/repo/.factory/out/qa/../harness.toml", { CLAUDE_PROJECT_DIR: proj }],
    ["/repo/../evil/.factory/out/qa/7.png", { CLAUDE_PROJECT_DIR: proj }],
    ["/repo/src/a.js", { CLAUDE_PROJECT_DIR: proj }],
    ["/repo/.factory/out/qa/7.png", { CLAUDE_PROJECT_DIR: "" }],
  ]) {
    const r = await write(p, env);
    expect(r.code, `${p} @ ${env.CLAUDE_PROJECT_DIR || "<unset>"}`).toBe(2);
    expect(r.stderr, p).toMatch(/must not write files/);
  }
  // 상대 경로는 CLAUDE_PROJECT_DIR와 무관하게 그대로 통과한다
  expect((await write(".factory/out/qa/7.png", { CLAUDE_PROJECT_DIR: "" })).code).toBe(0);
}, 30000);

test("deny-all-writes: the Bash arm accepts the same absolute qa target under $CLAUDE_PROJECT_DIR", async () => {
  const sh = (command, env) =>
    run("bash", [join(H, "deny-all-writes.sh")], { input: JSON.stringify(cmd(command)), env: { ...process.env, ...env } });
  const proj = { CLAUDE_PROJECT_DIR: "/repo" };

  for (const c of ["echo x > /repo/.factory/out/qa/7.log",
                   "npx playwright test --output /repo/.factory/out/qa/pw 2>&1",
                   "cp /tmp/shot.png /repo/.factory/out/qa/7-shot.png"]) {
    expect((await sh(c, proj)).code, c).toBe(0);
  }
  for (const [c, env] of [
    ["echo x > /repo/.factory/out/qa/7.log", { CLAUDE_PROJECT_DIR: "" }],
    ["echo x > /elsewhere/.factory/out/qa/7.log", proj],
    ["echo x > /repo/src/a.js", proj],
  ]) {
    const r = await sh(c, env);
    expect(r.code, `${c} @ ${env.CLAUDE_PROJECT_DIR || "<unset>"}`).toBe(2);
    expect(r.stderr, c).toMatch(/factory: this role must not write \(bash: /);
  }
}, 30000);

// ── F6(a): 쓰기 금지 역할의 Bash arm ─────────────────────────────────────────────────────────
// 전역 block-dangerous.sh는 *보호 경로*만 본다 — `echo x > src/a.js`는 아무도 막지 않았다.
test("deny-all-writes: a Bash command that writes outside /tmp, $TMPDIR or .factory/out/qa/ is blocked", async () => {
  const blocked = ["echo x > src/a.js", "echo x >> package.json", "echo x >| src/a.js", "cat a | tee out.txt", "cat a | tee -a out.txt",
                   "cp /tmp/evil src/a.js", "mv a.js b.js", "sed -i 's/a/b/' src/a.js", "sed -i '' 's/a/b/' src/a.js",
                   "perl -i -pe 's/a/b/' src/a.js", "python3 -c \"open('src/a.js','w').write('x')\"",
                   "git commit -m x", "git push origin HEAD", "git checkout -- src/a.js", "git add .",
                   "git config user.name x", "git config core.hooksPath /tmp/h",
                   "touch newfile", "mkdir newdir", "rm -rf src", "echo x > .factory/out/qa/../harness.toml"];
  const allowed = ["git diff origin/main...HEAD", "git log --oneline -5", "git show HEAD:src/a.js", "git status --porcelain",
                   "git merge-base origin/main HEAD", "npx vitest run test/a.test.js", "npm test", "cat src/a.js",
                   "grep -rn mkdir src/", "node .factory/bin/prove-test.js --file test/a.test.js --name test_7_x",
                   "echo hi > /tmp/out.txt", "echo hi >| /tmp/out.txt", "cat x 2>/dev/null", "rm -rf /tmp/scratch", "cp src/a.js /tmp/a.js",
                   "git config --get user.name", "git config --list", "git config --get-regexp '^remote'", "git config -l",
                   "mkdir -p .factory/out/qa/7", "echo y > .factory/out/qa/7-log.txt", "npx playwright test 2>&1"];
  await Promise.all(blocked.map(async (c) => {
    const r = await bash("deny-all-writes.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: this role must not write \(bash: /);
  }));
  await Promise.all(allowed.map(async (c) => expect((await bash("deny-all-writes.sh", cmd(c))).code, c).toBe(0)));
}, 30000);

// ── KTB-13 r1: 쓰기 금지 역할에게도 `Bash(*)`가 열렸다 ───────────────────────────────────────────
// 이 역할들은 `sed -i`·리다이렉션만으로 쓰지 않는다 — `node -e`로 fs를 부르고, `curl -o`/`wget`으로 파일을
// 내려받고, `install`로 복사할 수 있다. 판정 방향은 이 훅의 나머지와 같다: /tmp·$TMPDIR·.factory/out/qa/가
// **아니면** 막는다. inline 스크립트·다운로드는 대상이 어디든 막는다(sed -i·perl -i·python -c와 같은 원칙) —
// 쓰기 금지 역할에게 정당한 inline fs 호출은 없고, 임시 파일이 필요하면 리다이렉션 길이 이미 열려 있다.
test("deny-all-writes: node -e / curl -o / wget / install / cp -t are writes too (KTB-13 r1)", async () => {
  const blocked = [
    "node -e \"require('fs').writeFileSync('src/a.js','x')\"",
    "node --eval \"fs.writeFileSync('a','x')\"",
    "node -p \"require('fs').readdirSync('.')\"",
    "node -pe \"1\"", "node --print \"1\"",
    "curl -o src/a.js https://e/x", "curl -sLo src/a.js https://e/x", "curl -O https://e/x.js",
    "curl --output src/a.js https://e/x", "curl --remote-name https://e/x.js",
    // wget은 플래그가 없어도 **cwd에 파일을 만든다** — 그래서 통째로 막는다.
    "wget https://e/x.js", "wget -O src/a.js https://e/x", "wget --output-document=src/a.js https://e/x",
    "install /tmp/x src/a.js", "install -m 755 /tmp/x src/a.js",
    // `-t`/`--target-directory`는 목적지를 **마지막 토큰이 아닌 곳**에 둔다 — 목적지만 보는 cp/mv 규칙의 구멍이었다.
    "cp -t src /tmp/a.js", "cp --target-directory=src /tmp/a.js", "mv -t src /tmp/a.js",
  ];
  const allowed = [
    // 저장소 스크립트를 node로 **실행**하는 것은 verifier의 정상 작업이다 — 막는 것은 inline 스크립트뿐이다.
    "node .factory/bin/prove-test.js --file test/a.test.js", "node --version", "node scripts/check.js",
    "node -r ts-node/register app.js", "node --experimental-vm-modules x.js",
    // 출력 플래그 없는 curl은 stdout으로 간다 — 읽기다.
    "curl -s https://api.example.com/x", "curl -sS -H 'x: y' https://e/x", "curl --connect-timeout 5 https://e/x",
    // 기존 카브아웃은 그대로다(F3 증거 디렉터리 · /tmp).
    "cp src/a.js /tmp/a.js", "cp /tmp/shot.png .factory/out/qa/7.png",
  ];
  await Promise.all(blocked.map(async (c) => {
    const r = await bash("deny-all-writes.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: this role must not write \(bash: /);
  }));
  await Promise.all(allowed.map(async (c) => expect((await bash("deny-all-writes.sh", cmd(c))).code, c).toBe(0)));
}, 30000);

// ── KTB-13 r2: 짧은 옵션에 값이 **붙어** 오면 규칙이 통째로 빠져나갔다 ────────────────────────
// r1의 curl·cp/mv 규칙은 플래그 뭉치 뒤에 공백이나 `=`를 요구했다. 그런데 짧은 옵션은 값을 붙여
// 쓸 수 있다 — `curl -o.factory/harness.toml u`, `cp -tsrc/sub a`. 셸이 그대로 한 토큰으로 넘기고
// 도구는 정상 동작하는데, 훅만 못 본다(exit 0). 플래그 글자가 뭉치 안에 **있다는 사실**로 충분하다.
test("deny-all-writes: attached short-option values do not escape the curl/cp/mv rules (KTB-13 r2)", async () => {
  const blocked = [
    "curl -o.factory/harness.toml https://e/x", "curl -osrc/a.js https://e/x", "curl -sLosrc/a.js https://e/x",
    "curl -sLOhttps://e/x.js", "curl --output-dir=src https://e/x",
    "cp -tsrc/sub /tmp/a.js", "cp -rtsrc /tmp/a.js", "mv -tdir /tmp/a.js",
  ];
  const allowed = [
    // 붙은 값을 허용하게 넓혔다고 해서 출력 플래그가 없는 curl까지 걸리면 안 된다.
    "curl -sSL https://e/x", "curl -H 'x: y' https://e/x", "curl --location https://e/x", "curl -X POST -d @/tmp/b https://e/x",
    "cp -a src/a.js /tmp/a.js", "mv /tmp/a.js /tmp/b.js", "cp -r src /tmp/backup",
  ];
  await Promise.all(blocked.map(async (c) => {
    const r = await bash("deny-all-writes.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: this role must not write \(bash: /);
  }));
  await Promise.all(allowed.map(async (c) => expect((await bash("deny-all-writes.sh", cmd(c))).code, c).toBe(0)));
}, 30000);

test("block-dangerous: attached short-option values do not escape the curl rule on protected paths (KTB-13 r2)", async () => {
  const blocked = ["curl -o.factory/harness.toml https://e/x", "curl -sLopackage.json https://e/x", "curl -Odocs/factory/CHARTER.md https://e/x"];
  const allowed = ["curl -sSL https://e/x", "curl -o/tmp/x https://e/x"];
  await Promise.all(blocked.map(async (c) => {
    const r = await bash("block-dangerous.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: blocked/);
  }));
  await Promise.all(allowed.map(async (c) => expect((await bash("block-dangerous.sh", cmd(c))).code, c).toBe(0)));
}, 30000);

// ── KTB-15b: sed/node also had an attached-argument hole — `sed -i.bak`/`--in-place=` and
// `node -e"…"`/`-p"…"` never separated the flag from its value with a space or `=`, so r1/r2's
// boundary requirement (`([[:space:]=]|$)`) never fired. Same fix family as curl/cp/mv (KTB-13 r2):
// flag-glyph presence is enough, wherever the value is attached.
test("deny-all-writes: sed -i.bak / --in-place= and node -e\"…\"/-p\"…\" (attached, no separator) are writes too (KTB-15b)", async () => {
  const blocked = [
    "sed -i.bak s/a/b/ f", "sed -i.bak 's/a/b/' src/a.js", "sed --in-place=.bak s/a/b/ f", "sed --in-place s/a/b/ f",
    "node -e\"1\"", "node -p\"1\"", "node -e\"require('fs').writeFileSync('src/a.js','x')\"",
  ];
  const allowed = ["sed -n 1p f", "sed 's/a/b/' f", "node script.js", "node --version"];
  await Promise.all(blocked.map(async (c) => {
    const r = await bash("deny-all-writes.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: this role must not write \(bash: /);
  }));
  await Promise.all(allowed.map(async (c) => expect((await bash("deny-all-writes.sh", cmd(c))).code, c).toBe(0)));
}, 30000);

test("block-dangerous: sed -i.bak / --in-place= and attached node -e\"…\" on protected paths are blocked too (KTB-15b, mirrors deny-all-writes)", async () => {
  const blocked = [
    "sed -i.bak s/a/b/ package.json", "sed --in-place=.bak s/a/b/ .factory/harness.toml",
    "node -e\"require('fs').writeFileSync('.claude/settings.json','x')\"",
  ];
  const allowed = ["sed -n 1p package.json", "node script.js"];
  await Promise.all(blocked.map(async (c) => {
    const r = await bash("block-dangerous.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: blocked/);
  }));
  await Promise.all(allowed.map(async (c) => expect((await bash("block-dangerous.sh", cmd(c))).code, c).toBe(0)));
}, 30000);

// MultiEdit은 Edit/Write와 같은 도구다 — allow가 그것도 부여하므로(KTB-13) case에서 빠지면 그 한 도구로
// 쓰기 금지가 통째로 무너진다. 매처도 같이 넓혀야 훅이 애초에 발화한다(agent-md.test.js가 고정).
test("deny-all-writes: MultiEdit is blocked exactly like Edit/Write, with the same qa carve-out (KTB-13 r1)", async () => {
  const r = await bash("deny-all-writes.sh", { tool_name: "MultiEdit", tool_input: { file_path: "src/a.js" } });
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/factory: this role must not write files \(MultiEdit src\/a\.js\)/);
  expect((await bash("deny-all-writes.sh", { tool_name: "MultiEdit", tool_input: { file_path: ".factory/out/qa/7.md" } })).code).toBe(0);
  expect((await bash("deny-all-writes.sh", { tool_name: "MultiEdit", tool_input: { file_path: ".factory/out/qa/../harness.toml" } })).code).toBe(2);
}, 30000);

// ── KTB-21: 읽기 전용 역할은 env를 점검할 수는 있어도(ps/logs/exec) 시작·중지할 수는 없다 ─────────
// qa 리뷰어가 증거 수집 중 `docker compose down`으로 env를 내린 것(데모 #18)이 이 규칙의 근거다.
// 여기서는 builder(block-dangerous.sh)와 달리 `up`도 막는다 — env를 세우는 것은 이 역할의 일이 아니다.
test("deny-all-writes: docker compose/docker teardown AND up are blocked; ps/logs/exec/version are not (KTB-21)", async () => {
  const blocked = [
    "docker compose -f x.yml down", "docker compose down 2>&1 | tee /tmp/log", "docker-compose down",
    "docker compose stop", "docker compose -f x.yml rm -f", "docker compose kill", "docker-compose restart",
    "docker stop db", "docker rm -f db", "docker kill db", "docker restart db",
    "docker container stop db", "docker container rm -f db", "docker container kill db",
    "docker compose up -d", "docker compose -f x.yml up", "docker-compose up",
  ];
  const allowed = [
    "docker compose ps -a", "docker compose logs db", "docker compose -f x.yml exec -T db psql -U u -d d -c 'select 1'",
    "docker --version", "docker compose version",
  ];
  await Promise.all(blocked.map(async (c) => {
    const r = await bash("deny-all-writes.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: this role must not write \(bash: /);
  }));
  await Promise.all(allowed.map(async (c) => expect((await bash("deny-all-writes.sh", cmd(c))).code, c).toBe(0)));
}, 30000);

test("deny-all-writes: $TMPDIR is honoured as a write target, and prove-test's own worktree dir is not blocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dw-tmpdir-"));
  const r = await run("bash", [join(H, "deny-all-writes.sh")], {
    input: JSON.stringify(cmd(`echo x > ${join(dir, "note.txt")}`)),
    env: { ...process.env, TMPDIR: tmpdir() },
  });
  expect(r.code).toBe(0);
  // 리터럴 `$TMPDIR`도 같은 대접을 받는다 (훅은 확장 전의 명령 문자열을 본다)
  expect((await bash("deny-all-writes.sh", cmd("echo x > $TMPDIR/note.txt"))).code).toBe(0);
}, 30000);

test("stop-guard: non-factory branch passes; factory branch with dirty tree blocks", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sg-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd });
  expect((await bash("stop-guard.sh", { hook_event_name: "Stop" }, cwd)).code).toBe(0);            // main
  await run("git", ["checkout", "-q", "-b", "claude/fq-7"], { cwd });
  await run("bash", ["-c", "echo x > f.txt"], { cwd });
  const r = await bash("stop-guard.sh", { hook_event_name: "Stop" }, cwd);
  expect(r.code).toBe(2); expect(r.stderr).toMatch(/uncommitted/);
  await run("git", ["add", "."], { cwd }); await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "w"], { cwd });
  const r2 = await bash("stop-guard.sh", { hook_event_name: "Stop" }, cwd);
  expect(r2.code).toBe(2); expect(r2.stderr).toMatch(/unpushed|no upstream/);
}, 30000);

test("stop-guard: .factory/out artifacts are not 'dirty' — pushed branch with only those passes", async () => {
  const remote = mkdtempSync(join(tmpdir(), "sg-remote-"));
  await run("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const cwd = mkdtempSync(join(tmpdir(), "sg-work-"));
  const git = (...a) => run("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd });
  await git("init", "-q", "-b", "main");
  await git("commit", "-q", "--allow-empty", "-m", "init");
  await git("checkout", "-q", "-b", "claude/fq-7");
  await git("remote", "add", "origin", remote);
  await git("push", "-q", "-u", "origin", "claude/fq-7");
  await run("bash", ["-c", "mkdir -p .factory/out && echo x > .factory/out/x"], { cwd });
  const r = await bash("stop-guard.sh", { hook_event_name: "Stop" }, cwd);
  expect(r.stderr + r.stdout, "stop-guard should ignore .factory/out").toBe("");
  expect(r.code).toBe(0);
  // 같은 브랜치에서 .factory/out 밖의 변경은 여전히 막는다
  await run("bash", ["-c", "echo y > src.txt"], { cwd });
  expect((await bash("stop-guard.sh", { hook_event_name: "Stop" }, cwd)).code).toBe(2);
}, 30000);

test("stop-guard: dirty file at repo root is still caught when the hook runs from a subdirectory", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sg-sub-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd });
  await run("git", ["checkout", "-q", "-b", "claude/fq-7"], { cwd });
  // dirty file at root, hook run from a subdirectory → still blocked
  await run("bash", ["-c", "mkdir -p sub && echo y > root-dirty.txt"], { cwd });
  const r3 = await run("bash", [join(H, "stop-guard.sh")], { input: "{}", cwd: join(cwd, "sub") });
  expect(r3.code).toBe(2);
  expect(r3.stderr).toMatch(/uncommitted/);   // upstream이 없어도 exit 2가 나오므로, 이유가 "uncommitted"인지까지 확인한다
}, 30000);

test("stop-guard: a detached HEAD (review/merge checkoutHead) still refuses a dirty tree, but skips the push checks", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sg-detached-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd });
  const sha = (await run("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  await run("git", ["checkout", "-q", "--detach", sha], { cwd });
  expect((await bash("stop-guard.sh", { hook_event_name: "Stop" }, cwd)).code).toBe(0);           // clean detached HEAD, no upstream, still passes
  await run("bash", ["-c", "echo x > f.txt"], { cwd });
  const r = await bash("stop-guard.sh", { hook_event_name: "Stop" }, cwd);
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/detached HEAD with uncommitted changes/);
  // .factory/out is excluded on a detached HEAD too — same pathspec as the branch case
  await run("bash", ["-c", "rm f.txt && mkdir -p .factory/out && echo y > .factory/out/x"], { cwd });
  expect((await bash("stop-guard.sh", { hook_event_name: "Stop" }, cwd)).code).toBe(0);
}, 30000);

// ── fix round 2 (F1): the hydrated run record / quarantine writes must not trip the stop guard ──

test("stop-guard: an untracked run record (docs/factory/runs/) never blocks — detached HEAD or claude/fq-* branch", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sg-runs-"));
  const git = (...a) => run("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd });
  await git("init", "-q", "-b", "main");
  await git("commit", "-q", "--allow-empty", "-m", "init");
  const sha = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("checkout", "-q", "--detach", sha);
  // review/merge run detached and hydrateRecord writes docs/factory/runs/<issue>.md before anything else
  await run("bash", ["-c", "mkdir -p docs/factory/runs && echo '# Run · #7' > docs/factory/runs/7.md"], { cwd });
  const r = await bash("stop-guard.sh", { hook_event_name: "Stop" }, cwd);
  expect(r.stderr + r.stdout, "stop-guard should ignore docs/factory/runs").toBe("");
  expect(r.code).toBe(0);
  // same on a pushed factory work branch — the run record alone is not "uncommitted work"
  const remote = mkdtempSync(join(tmpdir(), "sg-runs-remote-"));
  await run("git", ["init", "-q", "--bare", "-b", "main", remote]);
  await git("checkout", "-q", "-b", "claude/fq-7");
  await git("remote", "add", "origin", remote);
  await git("push", "-q", "-u", "origin", "claude/fq-7");
  const r2 = await bash("stop-guard.sh", { hook_event_name: "Stop" }, cwd);
  expect(r2.stderr + r2.stdout).toBe("");
  expect(r2.code).toBe(0);
}, 30000);

test("stop-guard: a modified tracked .factory/quarantine.toml (script-owned) never blocks on a detached HEAD", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sg-quar-"));
  const git = (...a) => run("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd });
  await git("init", "-q", "-b", "main");
  await run("bash", ["-c", "mkdir -p .factory && printf 'schema = 1\\n' > .factory/quarantine.toml"], { cwd });
  await git("add", ".factory/quarantine.toml");
  await git("commit", "-q", "-m", "quarantine");
  const sha = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("checkout", "-q", "--detach", sha);
  await run("bash", ["-c", "printf '[entries]\\n' >> .factory/quarantine.toml"], { cwd });
  const r = await bash("stop-guard.sh", { hook_event_name: "Stop" }, cwd);
  expect(r.stderr + r.stdout, "stop-guard should ignore .factory/quarantine.toml").toBe("");
  expect(r.code).toBe(0);
  // a change outside the exclusions is still caught on the same detached HEAD
  await run("bash", ["-c", "echo y > src.txt"], { cwd });
  expect((await bash("stop-guard.sh", { hook_event_name: "Stop" }, cwd)).code).toBe(2);
}, 30000);

// ── stop-guard on SubagentStop: 쓰기 금지 역할은 면제된다 ─────────────────────────────────────
// 리뷰어는 playwright `test-results/`·`coverage/` 같은 untracked 산출물을 남기지만 그것을 지울 권한이
// 없다(deny-all-writes가 막는다). 가드가 그들에게도 걸리면 서브에이전트가 영원히 멈추지 못한다.
test("stop-guard: a write-forbidden role's SubagentStop is exempt; the builder's and the main session's are not", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sg-subagent-"));
  const git = (...a) => run("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd });
  await git("init", "-q", "-b", "main");
  await git("commit", "-q", "--allow-empty", "-m", "init");
  const sha = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("checkout", "-q", "--detach", sha);
  await run("bash", ["-c", "mkdir -p test-results && echo x > test-results/trace.zip"], { cwd });

  // detached HEAD + 더티 트리 — 원래라면 exit 2다
  expect((await bash("stop-guard.sh", { hook_event_name: "Stop" }, cwd)).code, "main session").toBe(2);
  for (const agent_type of ["reviewer-qa", "reviewer-correctness", "plan-skeptic", "factory-loader", "factory-triage", "factory-verifier"]) {
    const r = await bash("stop-guard.sh", { hook_event_name: "SubagentStop", agent_type }, cwd);
    expect(r.code, agent_type).toBe(0);
    expect(r.stderr + r.stdout, agent_type).toBe("");
  }
  // builder는 면제 대상이 아니다 — 커밋+push가 그의 일이다
  await git("checkout", "-q", "-b", "claude/fq-7");
  const builder = await bash("stop-guard.sh", { hook_event_name: "SubagentStop", agent_type: "factory-builder" }, cwd);
  expect(builder.code).toBe(2);
  expect(builder.stderr).toMatch(/uncommitted/);
}, 30000);

// ── F5(최종 리뷰): 면제 목록 == 쓰기 금지 역할 집합 ────────────────────────
// 두 파일이 같은 사실을 말한다: `agent-md.js`의 `needsDenyAllWritesHook`(에이전트 파일에 deny 훅을
// 요구한다)와 `stop-guard.sh`의 case 목록(그 역할의 SubagentStop을 면제한다). 어긋나면 교착이다 —
// 쓰기가 막힌 역할이 러너의 untracked 산출물을 지우지 못한 채 가드에 걸려 영원히 멈추지 못한다.
// 목록을 눈으로 맞추지 않고, **실제 역할 이름마다 셸 프로브를 돌려** 두 판정이 같은지 확인한다.
test("stop-guard: the skip list is exactly agent-md's write-free set — one probe per role", async () => {
  const roster = readdirSync(new URL("../../templates/factory/claude/agents/", import.meta.url).pathname)
    .filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
  expect(roster, "the roster must contain the retro analyst — the role this test was added for").toContain("factory-retro");
  expect(roster.some((n) => !needsDenyAllWritesHook(n)), "the roster must contain a writing role too, or the probe proves nothing").toBe(true);

  const cwd = mkdtempSync(join(tmpdir(), "sg-skiplist-"));
  const git = (...a) => run("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd });
  await git("init", "-q", "-b", "main");
  await git("commit", "-q", "--allow-empty", "-m", "init");
  await git("checkout", "-q", "-b", "claude/fq-7");
  // 더티 트리 — 면제되지 않은 역할은 반드시 exit 2다(그래야 프로브가 두 답을 가른다)
  await run("bash", ["-c", "mkdir -p test-results && echo x > test-results/trace.zip"], { cwd });

  for (const agent_type of [...roster, "main-session", "factory-builder"]) {
    const r = await bash("stop-guard.sh", { hook_event_name: "SubagentStop", agent_type }, cwd);
    expect(r.code === 0, `${agent_type}: stop-guard skip=${r.code === 0} vs needsDenyAllWritesHook=${needsDenyAllWritesHook(agent_type)}`)
      .toBe(needsDenyAllWritesHook(agent_type));
  }
}, 30000);

test("lint-touched: runs lint_file for the touched file, never blocks", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lt-")); mkdirSync(join(cwd, ".factory"));
  writeFileSync(join(cwd, ".factory/harness.toml"), `[commands]\nlint_file = "bash -c 'echo LINT {file}; exit 1'"\n`);
  const r = await run("bash", [join(H, "lint-touched.sh")], { input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "src/a.js" } }), cwd, env: { CLAUDE_PROJECT_DIR: cwd } });
  expect(r.code).toBe(0); expect(r.stderr).toMatch(/LINT src\/a\.js/);
}, 30000);
test("verdict-format: reviewer stop without verdict json → exit 2; with → 0; non-reviewer → 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-"));
  const t = join(dir, "t.jsonl");
  const msg = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  writeFileSync(t, msg("thinking...") + "\n" + msg("Here is my verdict:\n```json\n{\"verdict\":\"approve\",\"confidence\":\"high\",\"must_fix\":[],\"should_fix\":[],\"verified\":[]}\n```") + "\n");
  const ok = await run("bash", [join(H, "verdict-format.sh")], { input: JSON.stringify({ hook_event_name: "SubagentStop", agent_type: "reviewer-qa", agent_transcript_path: t }) });
  expect(ok.code).toBe(0);
  writeFileSync(t, msg("I approve, looks fine.") + "\n");
  const bad = await run("bash", [join(H, "verdict-format.sh")], { input: JSON.stringify({ hook_event_name: "SubagentStop", agent_type: "reviewer-qa", agent_transcript_path: t }) });
  expect(bad.code).toBe(2); expect(bad.stderr).toMatch(/verdict JSON/);
  const other = await run("bash", [join(H, "verdict-format.sh")], { input: JSON.stringify({ hook_event_name: "SubagentStop", agent_type: "factory-builder", agent_transcript_path: t }) });
  expect(other.code).toBe(0);
}, 30000);

// ── F1: the review workflow spawns reviewer-* with three schemas, not one ────────────────────
// R1/R2_FULL answer `verdict`, the unanimous-approve R2 answers `missed`, the dispute round answers
// `rulings`. A hook that only knows `verdict` blocks two of the three rounds at SubagentStop.
test("verdict-format: a reviewer may stop on any of the three review schemas (verdict | missed | rulings)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-schemas-"));
  const t = join(dir, "t.jsonl");
  const msg = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  const fenced = (json) => msg("Here it is:\n```json\n" + json + "\n```");
  const stop = (agent_type = "reviewer-qa") =>
    run("bash", [join(H, "verdict-format.sh")], { input: JSON.stringify({ hook_event_name: "SubagentStop", agent_type, agent_transcript_path: t }) });

  const bodies = {
    "verdict (R1 / R2 full)": `{"role":"qa","verdict":"approve","confidence":"high","must_fix":[],"should_fix":[],"verified":[]}`,
    "missed (R2 light)": `{"missed":[{"what":"빈 목록 경로","why":"아무도 열어보지 않았다"}]}`,
    "rulings (dispute)": `{"rulings":[{"id":"qa1","ruling":"uphold","reason":"non_goals에 없다"}]}`,
  };
  for (const [label, body] of Object.entries(bodies)) {
    writeFileSync(t, fenced(body) + "\n");
    expect((await stop()).code, label).toBe(0);
    // 판정형 훅은 verifier에도 걸린다 — 같은 관용이 적용된다
    expect((await stop("factory-verifier")).code, label).toBe(0);
  }

  // 펜스가 없으면 여전히 exit 2다 — 관용은 schema 이름에만 적용되고 "산문으로 대답하기"에는 적용되지 않는다
  for (const prose of ["I approve, looks fine.", "missed nothing, rulings all fine, verdict approve"]) {
    writeFileSync(t, msg(prose) + "\n");
    const bad = await stop();
    expect(bad.code, prose).toBe(2);
    expect(bad.stderr, prose).toMatch(/verdict JSON/);
  }
}, 30000);

test("lint-touched: shell-escapes file_path — no command injection via Edit/Write", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lt-inj-")); mkdirSync(join(cwd, ".factory"));
  const pwnDir = mkdtempSync(join(tmpdir(), "lt-pwn-"));
  writeFileSync(join(cwd, ".factory/harness.toml"), `[commands]\nlint_file = "echo LINT {file}"\n`);
  const evil = `x.js; touch ${pwnDir}/PWNED #`;
  const r = await run("bash", [join(H, "lint-touched.sh")], { input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: evil } }), cwd, env: { CLAUDE_PROJECT_DIR: cwd } });
  expect(r.code).toBe(0);
  expect(existsSync(join(pwnDir, "PWNED"))).toBe(false);
}, 30000);

test("lint-touched: enforces a timeout on the lint command (no system `timeout` on macOS)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lt-to-")); mkdirSync(join(cwd, ".factory"));
  writeFileSync(join(cwd, ".factory/harness.toml"), `[commands]\nlint_file = "sleep 5; echo late {file}"\n`);
  const start = Date.now();
  const r = await run("bash", [join(H, "lint-touched.sh")], { input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "src/a.js" } }), cwd, env: { CLAUDE_PROJECT_DIR: cwd, FACTORY_LINT_TIMEOUT_MS: "500" } });
  expect(Date.now() - start).toBeLessThan(3000);
  expect(r.code).toBe(0);
  expect(r.stderr).toMatch(/exit 124/);
}, 30000);

test("lint-touched: 쓰레기 FACTORY_LINT_TIMEOUT_MS는 기본 60s로 떨어진다 (NaN 타임아웃 금지)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lt-nan-")); mkdirSync(join(cwd, ".factory"));
  writeFileSync(join(cwd, ".factory/harness.toml"), `[commands]\nlint_file = "bash -c 'echo LINT {file}; exit 3'"\n`);
  for (const bad of ["abc", "", "0", "-1"]) {
    const r = await run("bash", [join(H, "lint-touched.sh")], { input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "src/a.js" } }), cwd, env: { CLAUDE_PROJECT_DIR: cwd, FACTORY_LINT_TIMEOUT_MS: bad } });
    expect(r.code, bad).toBe(0);
    expect(r.stderr, bad).toMatch(/exit 3/);            // 124(즉시 kill)가 아니라 실제 lint 결과가 온다
    expect(r.stderr, bad).toMatch(/LINT src\/a\.js/);
  }
}, 30000);

test("verdict-format: only the LAST assistant text message counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-last-"));
  const t = join(dir, "t.jsonl");
  const msg = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  writeFileSync(t, msg("```json\n{\"verdict\":\"approve\"}\n```") + "\n" + msg("changed my mind") + "\n");
  const r = await run("bash", [join(H, "verdict-format.sh")], { input: JSON.stringify({ hook_event_name: "SubagentStop", agent_type: "reviewer-qa", agent_transcript_path: t }) });
  expect(r.code).toBe(2);
  writeFileSync(t, msg("changed my mind") + "\n" + msg("```json\n{\"verdict\":\"approve\"}\n```") + "\n");
  const r2 = await run("bash", [join(H, "verdict-format.sh")], { input: JSON.stringify({ hook_event_name: "SubagentStop", agent_type: "reviewer-qa", agent_transcript_path: t }) });
  expect(r2.code).toBe(0);
}, 30000);
