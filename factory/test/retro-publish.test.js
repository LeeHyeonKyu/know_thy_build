import { test, expect, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeFakeRun } from "../lib/exec.js";
import { openAndMergeLessonsPr, openProposalPr, withWorktree } from "../lib/retro/publish.js";

const DATE = "2026-09-12";
const LESSONS_PATH = ".factory/lessons/reviewer-correctness.md";
const LESSONS_TEXT = [
  "<!-- factory-lessons:v1 role=reviewer-correctness max=30 -->",
  "- [L-2026-09-12-01] 타임존 비교는 파싱 함수의 기본 타임존을 확인한다.",
  "  근거: runs/97.md, runs/104.md. 인용: 0회.",
  "",
].join("\n");

const HARNESS = { protected: { factory: [".factory/**"], except: [".factory/lessons/**"], additive_only: {} }, test: { test_glob: [] } };

const CLEAN_DIFF = [
  `diff --git a/${LESSONS_PATH} b/${LESSONS_PATH}`,
  `--- a/${LESSONS_PATH}`,
  `+++ b/${LESSONS_PATH}`,
  "@@ -1,0 +2,2 @@",
  "+- [L-2026-09-12-01] 타임존 비교는 파싱 함수의 기본 타임존을 확인한다.",
  "+  근거: runs/97.md, runs/104.md. 인용: 0회.",
  "",
].join("\n");

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const argvOf = (fake) => fake.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
const is = (args, ...head) => head.every((h, i) => args[i] === h);

/** 기본 git 테이블: integrity가 깨끗한 diff를 보는 성공 경로. overrides가 앞에 붙는다. */
function gitTable(overrides = [], { nameStatus = `M\t${LESSONS_PATH}`, u0 = CLEAN_DIFF } = {}) {
  return [
    ...overrides,
    { match: (c, a) => c === "git" && is(a, "fetch", "origin"), result: ok() },
    { match: (c, a) => c === "git" && is(a, "worktree", "add"), result: ok() },
    { match: (c, a) => c === "git" && is(a, "worktree", "remove"), result: ok() },
    { match: (c, a) => c === "git" && a[0] === "add", result: ok() },
    { match: (c, a) => c === "git" && a.includes("commit"), result: ok("[detached HEAD abc1234] retro\n") },
    { match: (c, a) => c === "git" && a[0] === "merge-base", result: ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n") },
    { match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--name-status", result: ok(`${nameStatus}\n`) },
    { match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "-U0", result: ok(u0) },
    { match: (c, a) => c === "git" && a[0] === "push", result: ok() },
  ];
}

function fakeGh({ checks = [], pr = 77 } = {}) {
  const queue = [...checks];
  return {
    createPr: vi.fn(async () => pr),
    prChecks: vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0] ?? [])),
    mergePr: vi.fn(async () => {}),
    addLabels: vi.fn(async () => {}),
    comment: vi.fn(async () => "https://example/comment"),
  };
}

function spies() {
  const rmSpy = vi.fn(async (p, o) => rm(p, o));
  const mkdtempSpy = vi.fn(async (p) => mkdtemp(p));
  const sleeps = [];
  return { rm: rmSpy, mkdtemp: mkdtempSpy, sleeps, sleep: async (ms) => { sleeps.push(ms); } };
}

const PASS = [{ name: "factory/integrity", state: "SUCCESS", bucket: "pass" }];
const PENDING = [{ name: "factory/integrity", state: "PENDING", bucket: "pending" }];
const FAIL = [{ name: "factory/integrity", state: "FAILURE", bucket: "fail" }];

const lessonsArgs = (run, gh, s, extra = {}) => ({
  run, gh, cwd: "/repo", defaultBranch: "main", files: { [LESSONS_PATH]: LESSONS_TEXT },
  date: DATE, harness: HARNESS, pollMs: 1000, maxPolls: 5, ...s, ...extra,
});

test("green integrity + green check: fetch, worktree, bot commit, push refspec, PR, merge", async () => {
  const run = makeFakeRun(gitTable());
  const gh = fakeGh({ checks: [PASS] });
  const s = spies();

  const out = await openAndMergeLessonsPr(lessonsArgs(run, gh, s));

  expect(out).toMatchObject({ pr: 77, merged: true, branch: `factory/lessons-${DATE}` });
  const argv = argvOf(run);
  expect(argv[0]).toBe("git fetch origin main");
  expect(argv[1]).toMatch(/^git worktree add --detach \S+ origin\/main$/);
  const commit = run.calls.find((c) => c.args.includes("commit"));
  expect(commit.args.slice(0, 5)).toEqual(["-c", "user.name=factory-bot", "-c", "user.email=factory-bot@users.noreply.github.com", "commit"]);
  expect(commit.args).toContain(`retro: lessons/examples ${DATE}`);
  expect(argv).toContain(`git push origin HEAD:refs/heads/factory/lessons-${DATE}`);
  // 러너의 체크아웃은 건드리지 않는다 — 파일을 쓰는 모든 git 명령은 임시 worktree 안에서 돈다.
  const wt = run.calls[1].args[3];
  for (const c of run.calls) {
    if (["add", "commit", "push", "merge-base", "diff"].includes(c.args[0]) || c.args[4] === "commit") expect(c.opts.cwd).toBe(wt);
  }

  expect(gh.createPr).toHaveBeenCalledTimes(1);
  const pr = gh.createPr.mock.calls[0][0];
  expect(pr).toMatchObject({ head: `factory/lessons-${DATE}`, base: "main", title: `retro: lessons/examples ${DATE}` });
  expect(pr.body).toContain(LESSONS_PATH);
  expect(gh.mergePr).toHaveBeenCalledWith(77, { method: "squash", deleteBranch: true });
  expect(gh.addLabels).not.toHaveBeenCalled();
  expect(s.rm).toHaveBeenCalled();
  expect(existsSync(s.rm.mock.calls[0][0])).toBe(false);
});

test("the file content actually lands in the worktree before the commit", async () => {
  let seen = null;
  const run = makeFakeRun(gitTable([{
    match: (c, a) => c === "git" && a[0] === "add",
    result: async (c, a, o) => { seen = await readFile(join(o.cwd, LESSONS_PATH), "utf8"); return ok(); },
  }]));
  await openAndMergeLessonsPr(lessonsArgs(run, fakeGh({ checks: [PASS] }), spies()));
  expect(seen).toBe(LESSONS_TEXT);
});

test("pending checks are polled with pollMs until they pass", async () => {
  const run = makeFakeRun(gitTable());
  const gh = fakeGh({ checks: [PENDING, PENDING, PASS] });
  const s = spies();
  const out = await openAndMergeLessonsPr(lessonsArgs(run, gh, s));
  expect(out.merged).toBe(true);
  expect(gh.prChecks).toHaveBeenCalledTimes(3);
  expect(s.sleeps).toEqual([1000, 1000]);
});

test("a check with no factory/integrity entry yet counts as pending, not as pass", async () => {
  const gh = fakeGh({ checks: [[{ name: "other", state: "SUCCESS", bucket: "pass" }], PASS] });
  const out = await openAndMergeLessonsPr(lessonsArgs(makeFakeRun(gitTable()), gh, spies()));
  expect(gh.prChecks).toHaveBeenCalledTimes(2);
  expect(out.merged).toBe(true);
});

test("a failing factory/integrity check labels needs-human and comments, and never merges", async () => {
  const gh = fakeGh({ checks: [FAIL] });
  const out = await openAndMergeLessonsPr(lessonsArgs(makeFakeRun(gitTable()), gh, spies()));
  expect(out).toMatchObject({ pr: 77, merged: false });
  expect(out.reason).toContain("factory/integrity");
  expect(gh.mergePr).not.toHaveBeenCalled();
  expect(gh.addLabels).toHaveBeenCalledWith(77, ["factory:needs-human"]);
  expect(gh.comment.mock.calls[0][0]).toBe(77);
  expect(gh.comment.mock.calls[0][1]).toContain("factory:needs-human");
});

test("polls exhausted → timeout: label + comment, PR left open, no merge", async () => {
  const gh = fakeGh({ checks: [PENDING] });
  const s = spies();
  const out = await openAndMergeLessonsPr(lessonsArgs(makeFakeRun(gitTable()), gh, s, { maxPolls: 3 }));
  expect(out).toMatchObject({ pr: 77, merged: false, reason: "timeout" });
  expect(gh.prChecks).toHaveBeenCalledTimes(3);
  expect(s.sleeps).toEqual([1000, 1000, 1000]);
  expect(gh.mergePr).not.toHaveBeenCalled();
  expect(gh.addLabels).toHaveBeenCalledWith(77, ["factory:needs-human"]);
});

test("local integrity RED opens no PR, pushes nothing, and still removes the worktree", async () => {
  const run = makeFakeRun(gitTable([], { nameStatus: "M\t.factory/bin/run-stage.js" }));
  const gh = fakeGh({ checks: [PASS] });
  const s = spies();
  const out = await openAndMergeLessonsPr(lessonsArgs(run, gh, s));
  expect(out).toMatchObject({ pr: null, merged: false });
  expect(out.reason).toMatch(/^integrity: /);
  expect(out.reason).toContain("protected path changed");
  expect(gh.createPr).not.toHaveBeenCalled();
  expect(argvOf(run).some((a) => a.startsWith("git push"))).toBe(false);
  expect(argvOf(run)).toContain(`git worktree remove --force ${run.calls[1].args[3]}`);
  expect(s.rm).toHaveBeenCalled();
});

test("a git failure is reported as a reason and the worktree is still removed", async () => {
  const run = makeFakeRun(gitTable([{ match: (c, a) => c === "git" && a[0] === "push", result: { code: 1, stdout: "", stderr: "remote rejected" } }]));
  const gh = fakeGh({ checks: [PASS] });
  const s = spies();
  const out = await openAndMergeLessonsPr(lessonsArgs(run, gh, s));
  expect(out.merged).toBe(false);
  expect(out.reason).toContain("remote rejected");
  expect(gh.createPr).not.toHaveBeenCalled();
  expect(s.rm).toHaveBeenCalled();
  expect(existsSync(s.rm.mock.calls[0][0])).toBe(false);
});

test("a throwing gh call is reported as a reason and the worktree is still removed", async () => {
  const gh = fakeGh({ checks: [PASS] });
  gh.createPr = vi.fn(async () => { throw new Error("gh pr create failed (1): no auth"); });
  const s = spies();
  const out = await openAndMergeLessonsPr(lessonsArgs(makeFakeRun(gitTable()), gh, s));
  expect(out).toMatchObject({ merged: false, pr: null });
  expect(out.reason).toContain("no auth");
  expect(s.rm).toHaveBeenCalled();
});

test("openProposalPr labels the PR and never merges it", async () => {
  const run = makeFakeRun(gitTable([], { nameStatus: "M\tdocs/factory/retro/2026-09-12.md" }));
  const gh = fakeGh({ pr: 131 });
  const s = spies();
  const out = await openProposalPr({
    run, gh, cwd: "/repo", defaultBranch: "main",
    files: { "docs/factory/retro/2026-09-12.md": "# 제안\n" },
    title: "retro proposals 2026-09-01..2026-09-06", body: "<!-- factory-retro:v1 -->\n", date: DATE, ...s,
  });

  expect(out).toMatchObject({ pr: 131, branch: `factory/retro-proposal-${DATE}` });
  expect(argvOf(run)).toContain(`git push origin HEAD:refs/heads/factory/retro-proposal-${DATE}`);
  expect(gh.createPr).toHaveBeenCalledWith({
    head: `factory/retro-proposal-${DATE}`, base: "main",
    title: "retro proposals 2026-09-01..2026-09-06", body: "<!-- factory-retro:v1 -->\n",
    labels: ["factory:retro-proposal"],
  });
  expect(gh.mergePr).not.toHaveBeenCalled();
  expect(gh.prChecks).not.toHaveBeenCalled();
  expect(s.rm).toHaveBeenCalled();
});

test("withWorktree removes the temp dir even when the body throws", async () => {
  const run = makeFakeRun(gitTable());
  const s = spies();
  let inner = null;
  await expect(withWorktree({ run, cwd: "/repo", defaultBranch: "main", mkdtemp: s.mkdtemp, rm: s.rm }, async (wt) => {
    inner = wt;
    throw new Error("boom");
  })).rejects.toThrow("boom");
  expect(inner).toBeTruthy();
  expect(s.rm).toHaveBeenCalled();
  expect(existsSync(s.rm.mock.calls[0][0])).toBe(false);
});
