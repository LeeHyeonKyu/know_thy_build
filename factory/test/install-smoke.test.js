import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Task 6 install smoke — end to end, against the real `bin/cli.js` and `factory` CLI, in an
// isolated tmp HOME/cwd (never the real repo). Mirrors the manual sequence in the task brief:
//   git init -q && node bin/cli.js --lang ko                       → 15 skill files, no {{LANG}}
//   node bin/cli.js factory init                                   → .factory/.claude/.github/docs/factory
//   node bin/cli.js factory doctor --no-run --offline               → skills.<name> all PASS
// `factory init` turned out not to require a prior commit (git init alone gives it a branch to
// read via `git symbolic-ref`/`rev-parse`), but we commit anyway — cheap, and it keeps the repo
// state closer to a real greenfield `git init && ... && git add -A && git commit` flow instead of
// relying on that as an implementation detail of `factory init`.

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const CLI = join(REPO_ROOT, "bin/cli.js");
const TIMEOUT_MS = 60_000;

function sh(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: TIMEOUT_MS, stdio: "pipe" });
  return r;
}

test("install smoke: npx know-thy-build --lang ko → factory init → factory doctor --no-run --offline", () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-smoke-"));
  try {
    // ── git init ──────────────────────────────────────────────────────────────────────────
    let r = sh("git", ["init", "-q"], root, { HOME: root });
    expect(r.status, r.stderr).toBe(0);
    sh("git", ["config", "user.email", "smoke@example.com"], root, { HOME: root });
    sh("git", ["config", "user.name", "smoke"], root, { HOME: root });

    // ── node bin/cli.js --lang ko ─────────────────────────────────────────────────────────
    r = sh(process.execPath, [CLI, "--lang", "ko"], root, { HOME: root });
    expect(r.status, r.stderr).toBe(0);

    const skillsDir = join(root, ".claude/commands/know-thy-build");
    const installed = readdirSync(skillsDir).filter((f) => f.endsWith(".md")).sort();
    expect(installed.length).toBe(15);
    for (const f of installed) {
      expect(readFileSync(join(skillsDir, f), "utf8")).not.toContain("{{LANG}}");
    }

    // ── initial commit (cheap, keeps state close to a real greenfield repo) ──────────────
    r = sh("git", ["add", "-A"], root, { HOME: root });
    expect(r.status, r.stderr).toBe(0);
    r = sh("git", ["commit", "-q", "-m", "init"], root, { HOME: root });
    expect(r.status, r.stderr).toBe(0);

    // ── node bin/cli.js factory init ──────────────────────────────────────────────────────
    r = sh(process.execPath, [CLI, "factory", "init"], root, { HOME: root });
    expect(r.status, r.stderr).toBe(0);

    // ── node bin/cli.js factory doctor --no-run --offline ─────────────────────────────────
    r = sh(process.execPath, [CLI, "factory", "doctor", "--no-run", "--offline"], root, { HOME: root });
    // doctor's own exit code is not asserted here — an empty greenfield repo legitimately FAILs
    // other checks (e.g. missing test/smoke.test.js); we assert only the skills.* lines (brief).
    const lines = r.stdout.split("\n");
    const skillLine = (name) => lines.find((l) => l.includes(`skills.${name}`));

    const NAMES = [
      "project", "technical", "qa", "feature", "issue",
      "harness", "next", "clarify", "unstick", "proposal", "role", "digest", "status",
      "architect", "designer",
    ];
    expect(NAMES.length).toBe(15);

    for (const name of NAMES) {
      const line = skillLine(name);
      expect(line, `no doctor line for skills.${name}\n---\n${r.stdout}\n${r.stderr}`).toBeTruthy();
      expect(line.startsWith("✓"), `expected PASS, got: ${line}`).toBe(true);
    }

    const missingLine = lines.find((l) => l.includes("skills.missing"));
    expect(missingLine, `no doctor line for skills.missing\n---\n${r.stdout}`).toBeTruthy();
    expect(missingLine.startsWith("✓"), `expected PASS, got: ${missingLine}`).toBe(true);

    // KTB-12: a fresh `git init` repo has no .gitignore rules at all, so every installed manifest
    // file must come back tracked — files.tracked must PASS here (regression guard for the KTB
    // defect where `.claude/commands/` in .gitignore hid the factory-*.md dispatchers from CI).
    const trackedLine = lines.find((l) => l.includes("files.tracked"));
    expect(trackedLine, `no doctor line for files.tracked\n---\n${r.stdout}\n${r.stderr}`).toBeTruthy();
    expect(trackedLine.startsWith("✓"), `expected PASS, got: ${trackedLine}`).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, TIMEOUT_MS + 10_000);
