import { test, expect, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeFakeRun } from "../lib/exec.js";
import { openAndMergeLessonsPr, openProposalPr, withWorktree } from "../lib/retro/publish.js";
import { run as realRun } from "../lib/exec.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

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
/** worktree add 호출의 경로 인자 — 임시 디렉토리라 테스트가 미리 알 수 없다. */
const worktreeOf = (fake) => fake.calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add").args[3];
const is = (args, ...head) => head.every((h, i) => args[i] === h);

/** 기본 git 테이블: integrity가 깨끗한 diff를 보는 성공 경로. overrides가 앞에 붙는다. */
function gitTable(overrides = [], { nameStatus = `M\t${LESSONS_PATH}`, u0 = CLEAN_DIFF } = {}) {
  return [
    ...overrides,
    { match: (c, a) => c === "git" && is(a, "fetch", "origin"), result: ok() },
    { match: (c, a) => c === "git" && is(a, "worktree", "prune"), result: ok() },
    { match: (c, a) => c === "git" && is(a, "worktree", "add"), result: ok() },
    { match: (c, a) => c === "git" && is(a, "worktree", "remove"), result: ok() },
    { match: (c, a) => c === "git" && a[0] === "add", result: ok() },
    { match: (c, a) => c === "git" && a.includes("commit"), result: ok("[detached HEAD abc1234] retro\n") },
    { match: (c, a) => c === "git" && a[0] === "merge-base", result: ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n") },
    { match: (c, a) => c === "git" && a[0] === "diff" && a.includes("--name-status"), result: ok(`${nameStatus}\n`) },
    { match: (c, a) => c === "git" && a[0] === "diff" && a.includes("-U0"), result: ok(u0) },
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
  expect(argv[1]).toBe("git worktree prune");
  expect(argv[2]).toMatch(/^git worktree add --detach \S+ origin\/main$/);
  const commit = run.calls.find((c) => c.args.includes("commit"));
  expect(commit.args.slice(0, 5)).toEqual(["-c", "user.name=factory-bot", "-c", "user.email=factory-bot@users.noreply.github.com", "commit"]);
  expect(commit.args).toContain(`retro: lessons/examples ${DATE}`);
  expect(argv).toContain(`git push origin HEAD:refs/heads/factory/lessons-${DATE}`);
  // 러너의 체크아웃은 건드리지 않는다 — 파일을 쓰는 모든 git 명령은 임시 worktree 안에서 돈다.
  const wt = worktreeOf(run);
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
  expect(s.sleeps).toEqual([1000, 1000]);      // 마지막 회차 뒤에는 자지 않는다
  expect(gh.mergePr).not.toHaveBeenCalled();
  expect(gh.addLabels).toHaveBeenCalledWith(77, ["factory:needs-human"]);
});

test("local integrity RED opens no PR, pushes nothing, and still removes the worktree", async () => {
  const run = makeFakeRun(gitTable());
  const gh = fakeGh({ checks: [PASS] });
  const s = spies();
  const out = await openAndMergeLessonsPr(lessonsArgs(run, gh, s, { readFile: () => "lessons with no v1 header\n" }));
  expect(out).toMatchObject({ pr: null, merged: false });
  expect(out.reason).toMatch(/^integrity: /);
  expect(out.reason).toContain("lessons header missing");
  expect(gh.createPr).not.toHaveBeenCalled();
  expect(argvOf(run).some((a) => a.startsWith("git push"))).toBe(false);
  expect(argvOf(run)).toContain(`git worktree remove --force ${worktreeOf(run)}`);
  expect(s.rm).toHaveBeenCalled();
});

// KTB-5: integrity의 `ok`는 이제 보호 경로를 보지 않는다(변조만 본다) — 그래서 다크 PR이 보호
// 경로를 실어도 로컬 선검사가 GREEN일 수 있다. splitDarkFiles가 이미 경로를 제한하지만, 그
// 제한이 깨지면 팩토리가 사람 승인 없이 게이트 정의를 머지하게 된다 — 여기서 한 번 더 막는다.
test("KTB-5: a dark lessons PR carrying a protected path is refused locally — no push, no PR", async () => {
  const run = makeFakeRun(gitTable([], { nameStatus: `M\t${LESSONS_PATH}\nM\t.factory/harness.toml` }));
  const gh = fakeGh({ checks: [PASS] });
  const s = spies();
  const out = await openAndMergeLessonsPr(lessonsArgs(run, gh, s));
  expect(out).toMatchObject({ pr: null, merged: false });
  expect(out.reason).toMatch(/protected paths in a dark PR/);
  expect(out.reason).toContain(".factory/harness.toml");
  expect(gh.createPr).not.toHaveBeenCalled();
  expect(argvOf(run).some((a) => a.startsWith("git push"))).toBe(false);
  expect(argvOf(run)).toContain(`git worktree remove --force ${worktreeOf(run)}`);
});

// KTB-6: additive_only 위반도 `ok`를 내리지 않으므로(정책은 L1이 집행한다), 다크 PR의 로컬
// 선검사가 `policy`도 봐야 한다 — 이 PR이 사람 승인 없이 머지되는 근거가 "허용 섹션에 추가만"이다.
test("KTB-6: a dark PR that edits a role file outside the allowed sections is refused locally — no push, no PR", async () => {
  const AGENT = ".claude/agents/reviewer-correctness.md";
  const h = { protected: { factory: [".factory/**", ".claude/**"], except: [".factory/lessons/**"], additive_only: { ".claude/agents/*.md": ["## Examples", "## Perspectives"] } }, test: { test_glob: [] } };
  const badU0 = [`+++ b/${AGENT}`, "@@ -2,1 +2,1 @@", "-old lens", "+new lens", ""].join("\n");
  const run = makeFakeRun(gitTable([], { nameStatus: `M\t${AGENT}`, u0: badU0 }));
  const gh = fakeGh({ checks: [PASS] });
  const s = spies();
  const out = await openAndMergeLessonsPr(lessonsArgs(run, gh, s, { harness: h, readFile: () => "## Lens\nnew lens\n## Examples\n" }));
  expect(out).toMatchObject({ pr: null, merged: false });
  expect(out.reason).toMatch(/role sections edited outside the allowed sections in a dark PR/);
  expect(out.reason).toContain(AGENT);
  expect(gh.createPr).not.toHaveBeenCalled();
  expect(argvOf(run).some((a) => a.startsWith("git push"))).toBe(false);
  expect(argvOf(run)).toContain(`git worktree remove --force ${worktreeOf(run)}`);
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

test("a throwing mergePr still hands the open PR to a human", async () => {
  const gh = fakeGh({ checks: [PASS] });
  gh.mergePr = vi.fn(async () => { throw new Error("gh pr merge failed (1): not mergeable"); });
  const s = spies();
  const out = await openAndMergeLessonsPr(lessonsArgs(makeFakeRun(gitTable()), gh, s));
  expect(out).toMatchObject({ pr: 77, merged: false });
  expect(out.reason).toContain("not mergeable");
  expect(gh.addLabels).toHaveBeenCalledWith(77, ["factory:needs-human"]);
  expect(gh.comment.mock.calls[0][0]).toBe(77);
  expect(s.rm).toHaveBeenCalled();
});

test("a transient prChecks error is skipped, not treated as a verdict", async () => {
  const gh = fakeGh({ checks: [PASS] });
  let n = 0;
  gh.prChecks = vi.fn(async () => { n += 1; if (n === 1) throw new Error("API rate limit exceeded"); return PASS; });
  const s = spies();
  const out = await openAndMergeLessonsPr(lessonsArgs(makeFakeRun(gitTable()), gh, s));
  expect(out.merged).toBe(true);
  expect(gh.prChecks).toHaveBeenCalledTimes(2);
  expect(s.sleeps).toEqual([1000]);
  expect(gh.addLabels).not.toHaveBeenCalled();
});

test("prChecks that never succeeds falls through to timeout and hands off (fail closed)", async () => {
  const gh = fakeGh({ checks: [PASS] });
  gh.prChecks = vi.fn(async () => { throw new Error("API rate limit exceeded"); });
  const out = await openAndMergeLessonsPr(lessonsArgs(makeFakeRun(gitTable()), gh, spies(), { maxPolls: 2 }));
  expect(out).toMatchObject({ pr: 77, merged: false, reason: "timeout" });
  expect(gh.mergePr).not.toHaveBeenCalled();
  expect(gh.addLabels).toHaveBeenCalledWith(77, ["factory:needs-human"]);
});

test("an unparsed PR number stops before polling instead of guessing", async () => {
  const gh = fakeGh({ checks: [PASS] });
  gh.createPr = vi.fn(async () => null);
  const out = await openAndMergeLessonsPr(lessonsArgs(makeFakeRun(gitTable()), gh, spies()));
  expect(out).toMatchObject({ pr: null, merged: false, reason: "PR number not parsed" });
  expect(gh.prChecks).not.toHaveBeenCalled();
  expect(gh.mergePr).not.toHaveBeenCalled();
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

// ── #201 — retro keeps ONE standing lessons PR (and one proposal PR) and refreshes it in place ──────────────
// 이 저장소의 브랜치 보호 때문에 다크 머지는 한 번도 성공한 적이 없다 — retro마다 새 PR을 열면 같은 줄을
// 고치는 lessons PR이 쌓인다(#153·#164·#182·#190). 아래 테스트는 **진짜 git**(bare 원격 + 클론)을 쓴다:
// "브랜치에 무엇이 남았는가"는 git만 답할 수 있다. 케이스마다 넉넉한 timeout(records-branch.test.js와 같은 이유).
const BOT_ID = ["-c", "user.name=factory-bot", "-c", "user.email=factory-bot@users.noreply.github.com"];
const HUMAN_ID = ["-c", "user.name=Jane Maintainer", "-c", "user.email=jane@example.com"];
const LESSONS_HEADER = "<!-- factory-lessons:v1 role=reviewer-correctness max=30 -->\n";

async function g(cwd, ...args) {
  const r = await realRun("git", args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} (${r.code}): ${r.stderr}`);
  return r.stdout.trim();
}
const remoteHas = async (remote, ref) => (await realRun("git", ["rev-parse", "--verify", "-q", ref], { cwd: remote })).code === 0;
const isAncestor = async (remote, a, b) => (await realRun("git", ["merge-base", "--is-ancestor", a, b], { cwd: remote })).code === 0;

/** bare 원격 + origin이 그것을 가리키는 클론(main에 lessons 헤더만 있는 파일 하나). */
async function realRepo() {
  const remote = mkdtempSync(join(tmpdir(), "retro201-remote-"));
  await g(remote, "init", "-q", "--bare", "-b", "main");
  const cwd = mkdtempSync(join(tmpdir(), "retro201-clone-"));
  await g(cwd, "init", "-q", "-b", "main");
  mkdirSync(join(cwd, dirname(LESSONS_PATH)), { recursive: true });
  writeFileSync(join(cwd, LESSONS_PATH), LESSONS_HEADER);
  await g(cwd, "add", ".");
  await g(cwd, ...BOT_ID, "commit", "-q", "-m", "init");
  await g(cwd, "remote", "add", "origin", remote);
  await g(cwd, "push", "-q", "origin", "main");
  return { remote, cwd };
}

/** 다른 클론이 `branch`에 커밋 하나를 올린다(`from`에서 출발) → 그 커밋의 sha. 사람·다른 retro의 push 역할. */
async function pushToBranch(remote, branch, { author = BOT_ID, files, from = "main" }) {
  const c = mkdtempSync(join(tmpdir(), "retro201-other-"));
  await g(c, "clone", "-q", remote, ".");
  await g(c, "checkout", "-q", "-B", branch, `origin/${from}`);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(c, rel)), { recursive: true });
    writeFileSync(join(c, rel), text);
  }
  await g(c, "add", ".");
  await g(c, ...author, "commit", "-q", "-m", `edit ${branch}`);
  await g(c, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  return g(c, "rev-parse", "HEAD");
}

/** 진짜 git을 부르며 호출을 기록한다. `beforePush`가 있으면 첫 push 직전에 한 번 부른다(경합 재현). */
function recordingRun({ beforePush = null } = {}) {
  const calls = [];
  let raced = false;
  const r = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    if (beforePush && !raced && cmd === "git" && args[0] === "push") { raced = true; await beforePush(); }
    return realRun(cmd, args, opts);
  };
  r.calls = calls;
  return r;
}

/** fakeGh + 열린 PR 조회(head 접두사로 거른다)·PR 편집. */
function standingGh({ prs = [], checks = [PASS], pr = 77 } = {}) {
  return {
    ...fakeGh({ checks, pr }),
    openPrsByHeadPrefix: vi.fn(async (prefix) => prs.filter((p) => p.headRefName.startsWith(prefix))),
    editPr: vi.fn(async () => {}),
  };
}
const standingPr = (number, headRefName, headRefOid, title = "old title") => ({ number, title, headRefName, headRefOid });

test("test_201_lessons_pr_is_refreshed_in_place_when_one_is_open", async () => {
  const OLD = "factory/lessons-2026-09-05";
  const NEW = `factory/lessons-${DATE}`;

  // (a) 열린 lessons PR이 있다 → 새 PR 없이 그 브랜치를 base + 이번 lessons로 갈아 끼운다.
  {
    const { remote, cwd } = await realRepo();
    const oldSha = await pushToBranch(remote, OLD, { files: { [LESSONS_PATH]: `${LESSONS_HEADER}- [L-2026-09-05-01] old.\n` } });
    const run = recordingRun();
    const gh = standingGh({ prs: [standingPr(150, OLD, oldSha, "retro: lessons/examples 2026-09-05")] });
    const out = await openAndMergeLessonsPr(lessonsArgs(run, gh, spies(), { cwd }));

    expect(gh.createPr).not.toHaveBeenCalled();
    expect(out).toMatchObject({ pr: 150, merged: true, branch: OLD });
    expect(await remoteHas(remote, `refs/heads/${NEW}`)).toBe(false);
    expect(await g(remote, "show", `${OLD}:${LESSONS_PATH}`)).toBe(LESSONS_TEXT.trim());
    expect(await g(remote, "rev-parse", `${OLD}^`)).toBe(await g(remote, "rev-parse", "main"));
    const push = run.calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(push.args).toContain(`--force-with-lease=refs/heads/${OLD}:${oldSha}`);
    expect(push.args).not.toContain("--force");
    expect(push.args).not.toContain("-f");
    expect(push.args).not.toContain("--force-with-lease");
    expect(gh.editPr).toHaveBeenCalledTimes(1);
    const [n, edit] = gh.editPr.mock.calls[0];
    expect(n).toBe(150);
    expect(edit.title).toBe(`retro: lessons/examples ${DATE}`);
    expect(edit.body).toContain(LESSONS_PATH);
    expect(gh.comment.mock.calls.some(([p, b]) => p === 150 && b.includes(`retro(${DATE})가 이 PR을 갱신했다`))).toBe(true);
    expect(gh.prChecks).toHaveBeenCalledWith(150);
    expect(gh.mergePr).toHaveBeenCalledWith(150, expect.objectContaining({ method: "squash" }));
  }

  // (b) 리스는 **읽은 head**에 걸린다 — 읽은 뒤 누가 그 브랜치에 push하면 retro의 push가 거부되고 그 커밋이 이긴다.
  {
    const { remote, cwd } = await realRepo();
    const oldSha = await pushToBranch(remote, OLD, { files: { [LESSONS_PATH]: `${LESSONS_HEADER}- [L-2026-09-05-01] old.\n` } });
    let racer = null;
    const run = recordingRun({ beforePush: async () => { racer = await pushToBranch(remote, OLD, { from: OLD, files: { "racer.txt": "x\n" } }); } });
    const gh = standingGh({ prs: [standingPr(150, OLD, oldSha)] });
    const out = await openAndMergeLessonsPr(lessonsArgs(run, gh, spies(), { cwd }));
    expect(racer).toMatch(/^[0-9a-f]{40}$/);
    expect(await g(remote, "rev-parse", OLD)).toBe(racer);
    expect(out.merged).toBe(false);
    expect(gh.createPr).not.toHaveBeenCalled();
    expect(gh.mergePr).not.toHaveBeenCalled();
  }

  // (c) 열린 lessons PR이 없다 → 오늘처럼 새 브랜치·새 PR.
  {
    const { remote, cwd } = await realRepo();
    const gh = standingGh({ prs: [] });
    const out = await openAndMergeLessonsPr(lessonsArgs(recordingRun(), gh, spies(), { cwd }));
    expect(out).toMatchObject({ pr: 77, merged: true, branch: NEW });
    expect(gh.createPr).toHaveBeenCalledTimes(1);
    expect(gh.createPr.mock.calls[0][0]).toMatchObject({ head: NEW, base: "main", title: `retro: lessons/examples ${DATE}` });
    expect(gh.editPr).not.toHaveBeenCalled();
    expect(await g(remote, "show", `${NEW}:${LESSONS_PATH}`)).toBe(LESSONS_TEXT.trim());
  }
}, 120000);

test("test_201_human_commit_on_standing_lessons_pr_survives_refresh", async () => {
  const OLD = "factory/lessons-2026-09-05";
  const { remote, cwd } = await realRepo();
  await pushToBranch(remote, OLD, { files: { [LESSONS_PATH]: `${LESSONS_HEADER}- [L-2026-09-05-01] old.\n` } });
  const humanSha = await pushToBranch(remote, OLD, { author: HUMAN_ID, from: OLD, files: { [LESSONS_PATH]: `${LESSONS_HEADER}- [L-2026-09-05-01] fixed by a human.\n` } });
  const gh = standingGh({ prs: [standingPr(150, OLD, humanSha)] });
  const out = await openAndMergeLessonsPr(lessonsArgs(recordingRun(), gh, spies(), { cwd }));

  const head = await g(remote, "rev-parse", OLD);
  expect(await isAncestor(remote, humanSha, head)).toBe(true);
  expect(await g(remote, "show", `${OLD}:${LESSONS_PATH}`)).toContain("fixed by a human");
  expect(out.merged).toBe(false);
  expect(gh.mergePr).not.toHaveBeenCalled();
  for (const [, body] of gh.comment.mock.calls) expect(body).not.toContain("다시 손대지 않습니다");

  // handToHuman의 문구는 더 이상 "retro가 다시 손대지 않는다"고 약속하지 않는다 — retro는 매번 그 PR을 갱신한다.
  const gh2 = fakeGh({ checks: [FAIL] });
  await openAndMergeLessonsPr(lessonsArgs(makeFakeRun(gitTable()), gh2, spies()));
  const text = gh2.comment.mock.calls[0][1];
  expect(text).toContain("factory:needs-human");
  expect(text).not.toContain("다시 손대지 않습니다");
}, 60000);

test("test_201_proposal_pr_is_appended_when_one_is_open", async () => {
  const OLD = "factory/retro-proposal-2026-09-05";
  const OLD_FILE = "docs/factory/retro/2026-09-05.md";
  const NEW_FILE = `docs/factory/retro/${DATE}.md`;
  const title = "retro proposals 2026-09-01..2026-09-06";
  const body = "<!-- factory-retro:v1 period=2026-09-01..2026-09-06 -->\n";

  // (a) 열린 제안 PR이 있다 → 그 브랜치 위에 이번 파일을 더한다(이전 날짜 파일은 그대로), 제목 갱신, 새 PR 없음.
  {
    const { remote, cwd } = await realRepo();
    const oldSha = await pushToBranch(remote, OLD, { files: { [OLD_FILE]: "# old proposals\n" } });
    const gh = standingGh({ prs: [standingPr(140, OLD, oldSha, "retro proposals 2026-08-25..2026-08-31")] });
    const out = await openProposalPr({ run: recordingRun(), gh, cwd, defaultBranch: "main", files: { [NEW_FILE]: "# new proposals\n" }, title, body, date: DATE, ...spies() });

    expect(out).toMatchObject({ pr: 140, branch: OLD, reason: null });
    expect(gh.createPr).not.toHaveBeenCalled();
    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(await g(remote, "show", `${OLD}:${OLD_FILE}`)).toBe("# old proposals");
    expect(await g(remote, "show", `${OLD}:${NEW_FILE}`)).toBe("# new proposals");
    expect(await isAncestor(remote, oldSha, OLD)).toBe(true);
    expect(await remoteHas(remote, `refs/heads/factory/retro-proposal-${DATE}`)).toBe(false);
    expect(gh.editPr).toHaveBeenCalledWith(140, expect.objectContaining({ title }));
  }

  // (b) 열린 제안 PR이 없다 → 오늘처럼 라벨 붙은 새 PR.
  {
    const { remote, cwd } = await realRepo();
    const gh = standingGh({ prs: [], pr: 141 });
    const out = await openProposalPr({ run: recordingRun(), gh, cwd, defaultBranch: "main", files: { [NEW_FILE]: "# new proposals\n" }, title, body, date: DATE, ...spies() });
    expect(out).toMatchObject({ pr: 141, branch: `factory/retro-proposal-${DATE}`, reason: null });
    expect(gh.createPr).toHaveBeenCalledWith({ head: `factory/retro-proposal-${DATE}`, base: "main", title, body, labels: ["factory:retro-proposal"] });
    expect(gh.editPr).not.toHaveBeenCalled();
    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(await g(remote, "show", `factory/retro-proposal-${DATE}:${NEW_FILE}`)).toBe("# new proposals");
  }
}, 120000);

test("test_201_hand_to_human_translates_the_branch_policy_refusal", async () => {
  // 이 저장소의 retro PR들(#153·#164·#182·#190)이 머지 단계에서 받은 거부 문구의 형태.
  const POLICY = "gh pr merge failed (1): X Pull request o/r#190 is not mergeable: the base branch policy prohibits the merge.";
  const gh = fakeGh({ checks: [PASS] });
  gh.mergePr = vi.fn(async () => { throw new Error(POLICY); });
  const out = await openAndMergeLessonsPr(lessonsArgs(makeFakeRun(gitTable()), gh, spies()));
  expect(out).toMatchObject({ pr: 77, merged: false });
  const policyText = gh.comment.mock.calls[0][1];
  expect(policyText).toContain(POLICY);
  const translation = policyText.split("\n").find((l) => l.includes("factory/gates"));
  expect(translation).toBeTruthy();
  expect(translation).toContain("factory/review");
  expect(translation).toContain("admin");
  expect(translation).not.toContain(POLICY);

  const OTHER = "gh pr merge failed (1): X Pull request o/r#190 is not mergeable: the merge commit cannot be cleanly created.";
  const gh2 = fakeGh({ checks: [PASS] });
  gh2.mergePr = vi.fn(async () => { throw new Error(OTHER); });
  await openAndMergeLessonsPr(lessonsArgs(makeFakeRun(gitTable()), gh2, spies()));
  const otherText = gh2.comment.mock.calls[0][1];
  expect(otherText).toContain(OTHER);
  expect(otherText).not.toContain("factory/gates");
  expect(otherText).not.toContain("admin");
});
