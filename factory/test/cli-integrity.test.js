import { test, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { run as realRun } from "../lib/exec.js";
import { integrityCheck } from "../lib/integrity.js";
import { integrityCommand } from "../cli/integrity.js";
import { loadHarness as realLoadHarness } from "../lib/config.js";
import { main as cliMain } from "../cli/index.js";

/**
 * #236 — `factory integrity <pr>`. The fixtures are a real git repository and the real `integrityCheck` producer: the CI
 * verdict is computed the way `factory/bin/integrity.js` computes it on the runner (PR head checked out, files read from the
 * working tree), and the CLI is then run from an operator checkout that sits somewhere else.
 *
 * Both sides load the harness with the real `loadHarness` from the tree being judged: the CI bin reads the checked-out PR head's
 * `.factory/harness.toml`, so the CLI must read the PR head's too — never the operator checkout's.
 *
 * The skip pragma in the "violating" fixture is assembled at run time so this test file's own added lines carry no pragma.
 */
const SKIP_CALL = `test.${"sk"}${"ip"}("later", () => {});\n`;
const HARNESS_TOML = "[project]\ndefault_branch = \"main\"\n\n[protected]\nfactory = [\".factory/**\"]\n\n[test]\ntest_glob = [\"test/**/*.test.js\"]\n";
/** A looser harness: no protected globs, no test globs — a skip pragma in a test file is no violation under it. */
const LOOSE_HARNESS_TOML = "[project]\ndefault_branch = \"main\"\n\n[test]\ntest_glob = []\n";

const git = async (cwd, ...args) => {
  const r = await realRun("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

/** base on main (= origin/main), then one branch per PR fixture; the checkout is left on main, clean. */
async function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "factory-236-integrity-"));
  await git(root, "init", "-q", "-b", "main");
  put(root, "src/a.js", "export const a = 1;\n");
  put(root, "test/a.test.js", "test(\"a\", () => {});\n");
  put(root, ".factory/harness.toml", HARNESS_TOML);
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "base");
  await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  const branch = async (name, files) => {
    await git(root, "checkout", "-q", "-b", name, "main");
    for (const [rel, text] of Object.entries(files)) put(root, rel, text);
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", name);
    const sha = await git(root, "rev-parse", "HEAD");
    await git(root, "checkout", "-q", "main");
    return sha;
  };
  const shas = {
    clean: await branch("pr-clean", { "src/a.js": "export const a = 2;\n" }),
    violating: await branch("pr-violating", { "test/a.test.js": `test("a", () => {});\n${SKIP_CALL}` }),
    lessons: await branch("pr-lessons", { ".factory/lessons/reviewer-x.md": "# no header, no entries\n" }),
    protectedOnly: await branch("pr-protected", { ".factory/notes.md": "informational protected path\n" }),
  };
  return { root, shas };
}

/** The CI bin's verdict for a PR head: that head checked out, its harness and files read from disk (factory/bin/integrity.js). */
async function ciVerdict(root, sha) {
  await git(root, "checkout", "-q", "--detach", sha);
  try {
    const base = await git(root, "merge-base", "origin/main", "HEAD");
    return await integrityCheck({ run: realRun, cwd: root, base, harness: realLoadHarness(root), readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null) });
  } finally { await git(root, "checkout", "-q", "main"); }
}

const io = () => { const o = { out: [], err: [] }; return { io: { out: (s) => o.out.push(String(s)), err: (s) => o.err.push(String(s)) }, o }; };
const fakeGh = ({ sha, login = "alice" } = {}) => ({
  viewerLogin: vi.fn(async () => login),
  prView: vi.fn(async (n) => ({ number: Number(n), state: "OPEN", headRefOid: sha, baseRefName: "main" })),
  setStatus: vi.fn(async () => {}),
});
const integrity = ({ root, gh, env = {}, argv = ["17"], run = realRun, loadHarness = realLoadHarness }) => {
  const { io: i, o } = io();
  return integrityCommand({ root, argv, io: i, run, env, gh, loadHarness }).then((code) => ({ code, o }));
};

test("test_236_local_integrity_posts_the_same_verdict_as_ci_and_refuses_on_a_runner", async () => {
  const { root, shas } = await fixtureRepo();

  // Off a runner: one factory/integrity status on the PR head, with the state CI's integrityCheck gives that head.
  const expected = { clean: "success", violating: "failure", lessons: "failure", protectedOnly: "success" };
  for (const [kind, sha] of Object.entries(shas)) {
    const ci = await ciVerdict(root, sha);
    const gh = fakeGh({ sha });
    const { code, o } = await integrity({ root, gh, env: {} });
    expect(gh.setStatus, kind).toHaveBeenCalledTimes(1);
    const posted = gh.setStatus.mock.calls[0][0];
    expect(posted.sha, kind).toBe(sha);
    expect(posted.context, kind).toBe("factory/integrity");
    expect(posted.state, kind).toBe(ci.ok ? "success" : "failure");   // the same verdict as the CI bin
    expect(posted.state, kind).toBe(expected[kind]);                    // …and that verdict is what the fixture is
    expect(posted.description, kind).toMatch(/^local:alice\b/);
    expect(code, kind).toBe(posted.state === "success" ? 0 : 1);
    if (posted.state === "failure") expect(o.out.join("\n"), kind).toContain(ci.violations[0].rule);
  }

  // On a runner: refused before anything is asked or posted, and the reason is on stderr.
  for (const env of [{ GITHUB_ACTIONS: "true" }, { GITHUB_ACTIONS: "1", FACTORY_OPERATOR_MERGE: "1" }]) {
    const gh = fakeGh({ sha: shas.clean });
    const { code, o } = await integrity({ root, gh, env });
    expect(code).not.toBe(0);
    expect(o.err.join("\n")).toMatch(/GITHUB_ACTIONS/);
    expect(gh.setStatus).not.toHaveBeenCalled();
    expect(gh.viewerLogin).not.toHaveBeenCalled();
  }

  // The login cannot be resolved (throws, empty, not a login): nothing is posted, the CLI says why.
  for (const viewerLogin of [vi.fn(async () => { throw new Error("gh api user: HTTP 401"); }), vi.fn(async () => ""), vi.fn(async () => "two words")]) {
    const gh = { ...fakeGh({ sha: shas.clean }), viewerLogin };
    const { code, o } = await integrity({ root, gh, env: {} });
    expect(code).not.toBe(0);
    expect(o.err.join("\n")).toMatch(/login/);
    expect(gh.setStatus).not.toHaveBeenCalled();
  }

  // Not a PR number → usage, nothing posted.
  const gh = fakeGh({ sha: shas.clean });
  expect((await integrity({ root, gh, env: {}, argv: ["abc"] })).code).toBe(1);
  expect(gh.setStatus).not.toHaveBeenCalled();
});

test("test_236_local_integrity_judges_the_pr_head_sha_not_the_worktree", async () => {
  const { root, shas } = await fixtureRepo();
  const states = (gh) => gh.setStatus.mock.calls.map((c) => c[0].state);

  // The PR head carries the violation; the operator's checkout is main, clean → failure on the PR head, never success.
  {
    const gh = fakeGh({ sha: shas.violating });
    const { code } = await integrity({ root, gh });
    expect(code).not.toBe(0);
    expect(gh.setStatus.mock.calls.map((c) => c[0])).toEqual([expect.objectContaining({ sha: shas.violating, state: "failure" })]);
  }
  // Same, with the checkout sitting on the CLEAN PR's head (a clean tree that is not the PR's): still the PR head's verdict.
  await git(root, "checkout", "-q", "pr-clean");
  {
    const gh = fakeGh({ sha: shas.violating });
    await integrity({ root, gh });
    expect(states(gh)).toEqual(["failure"]);
  }
  // …and a working tree that itself carries a violation does not leak into a clean PR head's verdict.
  put(root, "test/a.test.js", `test("a", () => {});\n${SKIP_CALL}`);
  {
    const gh = fakeGh({ sha: shas.clean });
    await integrity({ root, gh });
    expect(states(gh)).toEqual(["success"]);
  }
  await git(root, "checkout", "-q", "-f", "main");

  // The PR head is not in the local object store → refused, nothing posted (it cannot be judged here).
  {
    const gh = fakeGh({ sha: "c".repeat(40) });
    const { code, o } = await integrity({ root, gh });
    expect(code).not.toBe(0);
    expect(o.err.join("\n")).toMatch(/fetch/);
    expect(gh.setStatus).not.toHaveBeenCalled();
  }
  // merge-base cannot be computed (no origin/main) → nothing posted.
  {
    await git(root, "update-ref", "-d", "refs/remotes/origin/main");
    const gh = fakeGh({ sha: shas.clean });
    const { code, o } = await integrity({ root, gh });
    expect(code).not.toBe(0);
    expect(o.err.join("\n")).toMatch(/merge-base/);
    expect(gh.setStatus).not.toHaveBeenCalled();
    await git(root, "update-ref", "refs/remotes/origin/main", "main");
  }
  // No verdict is reached (the diff itself fails inside integrityCheck) → failure or nothing, never success.
  {
    const failingDiff = (cmd, args, opts) => (cmd === "git" && args.includes("--name-status")
      ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: bad object" })
      : realRun(cmd, args, opts));
    const gh = fakeGh({ sha: shas.clean });
    const { code } = await integrity({ root, gh, run: failingDiff });
    expect(code).not.toBe(0);
    expect(states(gh)).not.toContain("success");
  }
  // The PR view gives no usable head sha → nothing posted.
  {
    const gh = { ...fakeGh({ sha: shas.clean }), prView: vi.fn(async () => ({ number: 17, state: "OPEN", headRefOid: "" })) };
    const { code } = await integrity({ root, gh });
    expect(code).not.toBe(0);
    expect(gh.setStatus).not.toHaveBeenCalled();
  }
});

// ── skeptic self-critique (#236): the harness, the content reads and the env are the PR head's / injected, or nothing is posted ──

test("test_236_local_integrity_reads_the_harness_from_the_pr_head_not_the_checkout", async () => {
  const { root, shas } = await fixtureRepo();
  // The CI bin's verdict on the violating head, with the head's own harness (computed before the checkout is touched).
  const ci = await ciVerdict(root, shas.violating);
  expect(ci.ok).toBe(false);

  // The operator's checkout carries a looser harness (no test globs) — under it the skip pragma would be no violation.
  put(root, ".factory/harness.toml", LOOSE_HARNESS_TOML);
  expect(realLoadHarness(root).test.test_glob).toEqual([]);
  const loadHarness = vi.fn(realLoadHarness);
  const gh = fakeGh({ sha: shas.violating });
  const { code } = await integrity({ root, gh, loadHarness });
  expect(code).not.toBe(0);
  expect(gh.setStatus.mock.calls.map((c) => c[0])).toEqual([expect.objectContaining({ sha: shas.violating, state: "failure" })]);
  // …and the harness that judged it was never the checkout's.
  expect(loadHarness).toHaveBeenCalled();
  for (const [r] of loadHarness.mock.calls) expect(r).not.toBe(root);
  await git(root, "checkout", "-q", "-f", "main");

  // A PR head with no .factory/harness.toml cannot be judged the way CI judges it → refused, nothing posted.
  await git(root, "checkout", "-q", "-b", "pr-noharness", "main");
  await git(root, "rm", "-q", ".factory/harness.toml");
  await git(root, "commit", "-q", "-m", "drop harness");
  const noHarness = await git(root, "rev-parse", "HEAD");
  await git(root, "checkout", "-q", "main");
  {
    const gh2 = fakeGh({ sha: noHarness });
    const r = await integrity({ root, gh: gh2 });
    expect(r.code).not.toBe(0);
    expect(r.o.err.join("\n")).toMatch(/harness\.toml/);
    expect(gh2.setStatus).not.toHaveBeenCalled();
  }
});

test("test_236_local_integrity_never_posts_success_when_pr_head_content_is_unread", async () => {
  const { root, shas } = await fixtureRepo();
  const states = (gh) => gh.setStatus.mock.calls.map((c) => c[0].state);
  // Sanity: with every read working, the lessons head is a failure (its format rule fires on the content).
  {
    const gh = fakeGh({ sha: shas.lessons });
    await integrity({ root, gh });
    expect(states(gh)).toEqual(["failure"]);
  }
  // The CLI's own file listing fails while integrityCheck's --name-status works → never success.
  {
    const run = (cmd, args, opts) => (cmd === "git" && args[0] === "diff" && args.includes("--name-only")
      ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: bad revision" })
      : realRun(cmd, args, opts));
    const gh = fakeGh({ sha: shas.lessons });
    const { code } = await integrity({ root, gh, run });
    expect(code).not.toBe(0);
    expect(states(gh)).not.toContain("success");
  }
  // Reading the lessons file at the PR head fails → never success (an unread file is not a deleted file).
  {
    const run = (cmd, args, opts) => (cmd === "git" && args[0] === "show" && String(args[1]).startsWith(`${shas.lessons}:.factory/lessons/`)
      ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: unable to read" })
      : realRun(cmd, args, opts));
    const gh = fakeGh({ sha: shas.lessons });
    const { code } = await integrity({ root, gh, run });
    expect(code).not.toBe(0);
    expect(states(gh)).not.toContain("success");
  }
  // The listing "succeeds" but names nothing, while integrityCheck sees the lessons file → integrityCheck asks for a file the
  // CLI never read from the head; that is not "the file is gone" → never success.
  {
    const run = (cmd, args, opts) => (cmd === "git" && args[0] === "diff" && args.includes("--name-only")
      ? Promise.resolve({ code: 0, stdout: "", stderr: "" })
      : realRun(cmd, args, opts));
    const gh = fakeGh({ sha: shas.lessons });
    const { code } = await integrity({ root, gh, run });
    expect(code).not.toBe(0);
    expect(states(gh)).not.toContain("success");
  }
});

test("test_236_local_integrity_env_is_injected_not_read_from_process_env", async () => {
  const { root, shas } = await fixtureRepo();
  const saved = process.env.GITHUB_ACTIONS;
  try {
    // A caller that forgets `env` is refused even when the ambient process looks like an operator shell.
    delete process.env.GITHUB_ACTIONS;
    const gh = fakeGh({ sha: shas.clean });
    const { io: i, o } = io();
    const code = await integrityCommand({ root, argv: ["17"], io: i, run: realRun, gh, loadHarness: realLoadHarness });
    expect(code).not.toBe(0);
    expect(o.err.join("\n")).toMatch(/env/);
    expect(gh.viewerLogin).not.toHaveBeenCalled();
    expect(gh.setStatus).not.toHaveBeenCalled();

    // The CLI entry passes the real env: on a runner, `factory integrity 17` is refused for being on a runner.
    process.env.GITHUB_ACTIONS = "true";
    const errs = [];
    const spy = vi.spyOn(console, "error").mockImplementation((s) => { errs.push(String(s)); });
    try {
      expect(await cliMain(["integrity", "17"])).not.toBe(0);
    } finally { spy.mockRestore(); }
    expect(errs.join("\n")).toMatch(/GITHUB_ACTIONS is set/);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = saved;
  }
});

test("test_236_local_integrity_refuses_a_runner_whose_github_actions_is_blank", async () => {
  // dw1, the runner half: a runner is GITHUB_ACTIONS *present* in env, even blank — the same rule as `factory run merge`
  // and run-stage's isOperatorMerge (sec1). `GITHUB_ACTIONS= factory integrity <pr>` on a runner must post nothing.
  const { root, shas } = await fixtureRepo();
  for (const env of [{ GITHUB_ACTIONS: "" }, { GITHUB_ACTIONS: "", FACTORY_OPERATOR_MERGE: "1" }, { GITHUB_ACTIONS: "false" }]) {
    const gh = fakeGh({ sha: shas.clean });
    const { code, o } = await integrity({ root, gh, env });
    expect(code, JSON.stringify(env)).not.toBe(0);
    expect(o.err.join("\n"), JSON.stringify(env)).toMatch(/GITHUB_ACTIONS/);
    expect(gh.setStatus, JSON.stringify(env)).not.toHaveBeenCalled();
    expect(gh.viewerLogin, JSON.stringify(env)).not.toHaveBeenCalled();
  }
  // The other env path: GITHUB_ACTIONS absent — the operator session posts the verdict.
  const gh = fakeGh({ sha: shas.clean });
  expect((await integrity({ root, gh, env: {} })).code).toBe(0);
  expect(gh.setStatus).toHaveBeenCalledTimes(1);
});
