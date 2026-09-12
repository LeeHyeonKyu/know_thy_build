import { test, expect } from "vitest";
import { run } from "../lib/exec.js";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const H = new URL("../hooks/", import.meta.url).pathname;
const bash = (script, input, cwd) => run("bash", [join(H, script)], { input: JSON.stringify(input), cwd });
const cmd = (c) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: c } });

test("block-dangerous: blocks merges, force pushes, protected writes; allows normal commands", async () => {
  const blocked = ["gh pr merge 5", "git merge feature", "git push --force origin x", "git push -f origin x", "git push origin --force-with-lease",
                   "echo x > .factory/harness.toml", "sed -i 's/a/b/' .claude/settings.json", "cat foo | tee docs/factory/CHARTER.md", "echo y >> .github/workflows/factory-implement.yml",
                   "git push origin --force-with-lease=refs/heads/main:abc", "git push origin --delete refs/heads/factory/lock-7", "git push origin --delete factory/lock-7", "git push origin :refs/heads/factory/lock-7",
                   "git push origin +main:main", "git push origin +refs/heads/claude/fq-7:refs/heads/main",
                   "gh api -X PUT repos/o/r/pulls/9/merge", "gh api repos/o/r/pulls/9/merge --method PUT",
                   "cp /tmp/evil .factory/harness.toml", "mv /tmp/evil docs/factory/CHARTER.md",
                   "perl -i -pe 's/a/b/' .claude/settings.json", "perl -pi -e 's/a/b/' .factory/harness.toml",
                   "python3 -c \"open('.factory/harness.toml','w').write('x')\""];
  const allowed = ["git push origin HEAD", "git commit -m x", "npm test", "cat .factory/harness.toml", "gh pr view 5",
                   "git push origin HEAD:refs/heads/claude/fq-7", "git push origin --delete claude/fq-7",
                   "cp .factory/harness.toml /tmp/backup", "python3 -c \"print(1)\""];
  await Promise.all(blocked.map(async (c) => {
    const r = await bash("block-dangerous.sh", cmd(c));
    expect(r.code, c).toBe(2);
    expect(r.stderr, c).toMatch(/factory: blocked/);
  }));
  await Promise.all(allowed.map(async (c) => expect((await bash("block-dangerous.sh", cmd(c))).code, c).toBe(0)));
}, 30000);   // 30여 개의 bash 프로세스를 띄운다 — 기본 5s 타임아웃으로는 모자란다

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

test("block-dangerous: non-Bash tools and malformed input pass through", async () => {
  expect((await bash("block-dangerous.sh", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: ".factory/x" } })).code).toBe(0);
  expect((await run("bash", [join(H, "block-dangerous.sh")], { input: "not json" })).code).toBe(0);
}, 30000);

test("block-dangerous: without jq the hook fails CLOSED (exit 2)", async () => {
  const r = await run("/bin/bash", [join(H, "block-dangerous.sh")], { input: JSON.stringify(cmd("echo hi")), env: { PATH: "/nonexistent" } });
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/jq missing/);
}, 30000);

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
  // 예외는 저장소 상대 경로에만 준다 — 절대 경로는 이 저장소 안인지 훅이 알 수 없다
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
