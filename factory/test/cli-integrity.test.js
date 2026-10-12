import { test, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { run as realRun } from "../lib/exec.js";
import { integrityCheck } from "../lib/integrity.js";
import { integrityCommand } from "../cli/integrity.js";

/**
 * #236 — `factory integrity <pr>`. The fixtures are a real git repository and the real `integrityCheck` producer: the CI
 * verdict is computed the way `factory/bin/integrity.js` computes it on the runner (PR head checked out, files read from the
 * working tree), and the CLI is then run from an operator checkout that sits somewhere else.
 *
 * The skip pragma in the "violating" fixture is assembled at run time so this test file's own added lines carry no pragma.
 */
const SKIP_CALL = `test.${"sk"}${"ip"}("later", () => {});\n`;
const HARNESS = { project: { default_branch: "main" }, protected: { factory: [".factory/**"] }, test: { test_glob: ["test/**/*.test.js"] } };

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

/** The CI bin's verdict for a PR head: that head checked out, the working tree read from disk (factory/bin/integrity.js). */
async function ciVerdict(root, sha) {
  await git(root, "checkout", "-q", "--detach", sha);
  try {
    const base = await git(root, "merge-base", "origin/main", "HEAD");
    return await integrityCheck({ run: realRun, cwd: root, base, harness: HARNESS, readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null) });
  } finally { await git(root, "checkout", "-q", "main"); }
}

const io = () => { const o = { out: [], err: [] }; return { io: { out: (s) => o.out.push(String(s)), err: (s) => o.err.push(String(s)) }, o }; };
const fakeGh = ({ sha, login = "alice" } = {}) => ({
  viewerLogin: vi.fn(async () => login),
  prView: vi.fn(async (n) => ({ number: Number(n), state: "OPEN", headRefOid: sha, baseRefName: "main" })),
  setStatus: vi.fn(async () => {}),
});
const integrity = ({ root, gh, env = {}, argv = ["17"], run = realRun }) => {
  const { io: i, o } = io();
  return integrityCommand({ root, argv, io: i, run, env, gh, loadHarness: () => HARNESS }).then((code) => ({ code, o }));
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
