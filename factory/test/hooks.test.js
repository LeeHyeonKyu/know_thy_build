import { test, expect } from "vitest";
import { run } from "../lib/exec.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

test("block-dangerous: non-Bash tools and malformed input pass through", async () => {
  expect((await bash("block-dangerous.sh", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: ".factory/x" } })).code).toBe(0);
  expect((await run("bash", [join(H, "block-dangerous.sh")], { input: "not json" })).code).toBe(0);
});

test("block-dangerous: without jq the hook fails CLOSED (exit 2)", async () => {
  const r = await run("/bin/bash", [join(H, "block-dangerous.sh")], { input: JSON.stringify(cmd("echo hi")), env: { PATH: "/nonexistent" } });
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/jq missing/);
});

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
});

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
});

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
});

test("lint-touched: runs lint_file for the touched file, never blocks", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lt-")); mkdirSync(join(cwd, ".factory"));
  writeFileSync(join(cwd, ".factory/harness.toml"), `[commands]\nlint_file = "bash -c 'echo LINT {file}; exit 1'"\n`);
  const r = await run("bash", [join(H, "lint-touched.sh")], { input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "src/a.js" } }), cwd, env: { CLAUDE_PROJECT_DIR: cwd } });
  expect(r.code).toBe(0); expect(r.stderr).toMatch(/LINT src\/a\.js/);
});
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
});
