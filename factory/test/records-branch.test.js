import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { syncRecords, readRecords } from "../lib/records-branch.js";

const git = (cwd, ...args) => run("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });

/** bare 원격 하나. */
async function makeRemote() {
  const remote = mkdtempSync(join(tmpdir(), "records-remote-"));
  await run("git", ["init", "-q", "--bare", "-b", "main", remote]);
  return remote;
}

/** origin이 remote를 가리키는 작업 저장소(비어있지 않음 — 커밋 하나 있는 main). */
async function makeClone(remote, name = "clone") {
  const cwd = mkdtempSync(join(tmpdir(), `records-${name}-`));
  await git(cwd, "init", "-q", "-b", "main");
  writeFileSync(join(cwd, ".gitignore"), "docs/factory/runs/\n");   // factory init이 만드는 실제 저장소와 같은 상태 — run 기록은 default 브랜치에서 추적되지 않는다(ADR-014)
  await git(cwd, "add", ".gitignore");
  await git(cwd, "commit", "-q", "-m", "init");
  await git(cwd, "remote", "add", "origin", remote);
  return cwd;
}

function writeRecord(cwd, issue, text, dir = "docs/factory/runs") {
  const d = join(cwd, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${issue}.md`), text);
}

test("(a) first sync creates the factory/records branch on the remote; working tree and current branch are untouched", async () => {
  const remote = await makeRemote();
  const cwd = await makeClone(remote);
  writeRecord(cwd, 7, "# Run · #7\n\n## triage\nx\n");

  const r = await syncRecords({ run, cwd, message: "run-record: issue #7 triage" });
  expect(r.ok).toBe(true);
  expect(r.retried).toBe(false);
  expect(r.commit).toMatch(/^[0-9a-f]{40}$/);

  const show = await run("git", ["show", "factory/records:docs/factory/runs/7.md"], { cwd: remote });
  expect(show.code).toBe(0);
  expect(show.stdout).toBe("# Run · #7\n\n## triage\nx\n");

  const status = await git(cwd, "status", "--porcelain");
  expect(status.stdout.trim()).toBe("");
  const branch = await git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  expect(branch.stdout.trim()).toBe("main");
}, 20000);

test("(b) second sync links a parent (2 commits on factory/records) and updates the file", async () => {
  const remote = await makeRemote();
  const cwd = await makeClone(remote);

  writeRecord(cwd, 7, "v1\n");
  const r1 = await syncRecords({ run, cwd, message: "m1" });
  expect(r1.ok).toBe(true);

  writeRecord(cwd, 7, "v2\n");
  const r2 = await syncRecords({ run, cwd, message: "m2" });
  expect(r2.ok).toBe(true);
  expect(r2.commit).not.toBe(r1.commit);

  const log = await run("git", ["log", "--format=%H", "factory/records"], { cwd: remote });
  expect(log.stdout.trim().split("\n")).toEqual([r2.commit, r1.commit]);
  const parent = await run("git", ["rev-parse", `${r2.commit}^`], { cwd: remote });
  expect(parent.stdout.trim()).toBe(r1.commit);

  const show = await run("git", ["show", "factory/records:docs/factory/runs/7.md"], { cwd: remote });
  expect(show.stdout).toBe("v2\n");
}, 20000);

test("(c) a race — another sync pushes first, forcing a retry; both files survive", async () => {
  const remote = await makeRemote();
  const cwdA = await makeClone(remote, "a");
  const cwdB = await makeClone(remote, "b");
  writeRecord(cwdA, 7, "from-a\n");
  writeRecord(cwdB, 8, "from-b\n");

  // A의 첫 fetch(원격에 브랜치가 아직 없다는 것을 확인하는 시점) 직후, B가 완전한 sync를 끝내
  // A가 build하는 커밋의 parent보다 원격이 앞서가게 만든다 — A의 push는 non-fast-forward로 거부돼야 한다.
  let recordsFetchCount = 0;
  const racingRun = async (cmd, args, opts) => {
    const res = await run(cmd, args, opts);
    if (cmd === "git" && args[0] === "fetch" && String(args[2] || "").includes("records-remote")) {
      recordsFetchCount += 1;
      if (recordsFetchCount === 1) {
        const rb = await syncRecords({ run, cwd: cwdB, message: "b" });
        expect(rb.ok).toBe(true);
      }
    }
    return res;
  };

  const ra = await syncRecords({ run: racingRun, cwd: cwdA, message: "a" });
  expect(ra.ok).toBe(true);
  expect(ra.retried).toBe(true);
  expect(recordsFetchCount).toBe(2);   // 1차 시도 fetch + 재시도 fetch

  const showA = await run("git", ["show", "factory/records:docs/factory/runs/7.md"], { cwd: remote });
  expect(showA.stdout).toBe("from-a\n");
  const showB = await run("git", ["show", "factory/records:docs/factory/runs/8.md"], { cwd: remote });
  expect(showB.stdout).toBe("from-b\n");
}, 20000);

test("(d) readRecords round-trips what syncRecords wrote", async () => {
  const remote = await makeRemote();
  const cwd = await makeClone(remote);
  writeRecord(cwd, 7, "seven\n");
  writeRecord(cwd, 42, "forty-two\n");
  const r = await syncRecords({ run, cwd, message: "m" });
  expect(r.ok).toBe(true);

  const map = await readRecords({ run, cwd });
  expect(map.size).toBe(2);
  expect(map.get("7")).toBe("seven\n");
  expect(map.get("42")).toBe("forty-two\n");
}, 20000);

test("(e) no origin remote configured — syncRecords never throws, returns ok:false", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "records-noorigin-"));
  await git(cwd, "init", "-q", "-b", "main");
  await git(cwd, "commit", "-q", "--allow-empty", "-m", "init");
  writeRecord(cwd, 7, "x\n");

  const r = await syncRecords({ run, cwd, message: "m" });
  expect(r.ok).toBe(false);
  expect(r.retried).toBe(false);
  expect(typeof r.reason).toBe("string");
});

test("readRecords returns an empty Map when the branch doesn't exist on the remote", async () => {
  const remote = await makeRemote();
  const cwd = await makeClone(remote);
  const map = await readRecords({ run, cwd });
  expect(map.size).toBe(0);
  expect(map instanceof Map).toBe(true);
});

test("detached HEAD (review/merge stages run detached, Task 12) — sync works and never moves HEAD", async () => {
  const remote = await makeRemote();
  const cwd = await makeClone(remote);
  const sha = (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
  await git(cwd, "checkout", "-q", "--detach", sha);
  writeRecord(cwd, 99, "detached\n");

  const r = await syncRecords({ run, cwd, message: "run-record: issue #99 review" });
  expect(r.ok).toBe(true);

  const headAfter = (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
  expect(headAfter).toBe(sha);
  const symbolic = await git(cwd, "symbolic-ref", "-q", "HEAD");
  expect(symbolic.code).not.toBe(0);   // 여전히 detached — sync가 브랜치를 새로 만들지 않았다
  const status = await git(cwd, "status", "--porcelain");
  expect(status.stdout.trim()).toBe("");

  const show = await run("git", ["show", "factory/records:docs/factory/runs/99.md"], { cwd: remote });
  expect(show.stdout).toBe("detached\n");
}, 20000);

test("custom author/committer env overrides the factory-bot defaults", async () => {
  const remote = await makeRemote();
  const cwd = await makeClone(remote);
  writeRecord(cwd, 7, "x\n");
  const r = await syncRecords({ run, cwd, message: "m", env: { GIT_AUTHOR_NAME: "someone", GIT_AUTHOR_EMAIL: "someone@example.com" } });
  expect(r.ok).toBe(true);
  const show = await run("git", ["show", "-s", "--format=%an <%ae>", r.commit], { cwd: remote });
  expect(show.stdout.trim()).toBe("someone <someone@example.com>");
});

test("default author/committer is factory-bot when env is not given", async () => {
  const remote = await makeRemote();
  const cwd = await makeClone(remote);
  writeRecord(cwd, 7, "x\n");
  const r = await syncRecords({ run, cwd, message: "m" });
  expect(r.ok).toBe(true);
  const show = await run("git", ["show", "-s", "--format=%an <%ae>", r.commit], { cwd: remote });
  expect(show.stdout.trim()).toBe("factory-bot <factory-bot@users.noreply.github.com>");
});
