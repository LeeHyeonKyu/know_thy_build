import { test, expect } from "vitest";
import { claim, release, lockHolder, lockRunnerOf } from "../lib/claim.js";
import { makeFakeRun } from "../lib/exec.js";

const base = [
  { match: (c, a) => c === "git" && a[0] === "hash-object", result: { code: 0, stdout: "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n", stderr: "" } },
  { match: (c, a) => c === "git" && a[0] === "commit-tree", result: { code: 0, stdout: "deadbeef".repeat(5) + "\n", stderr: "" } },
];

test("claim succeeds when push creates the lock ref", async () => {
  const run = makeFakeRun([...base, { match: (c, a) => c === "git" && a[0] === "push", result: { code: 0, stdout: "", stderr: " * [new branch] deadbeef -> factory/lock-7" } }]);
  const r = await claim({ run, cwd: "/repo", issue: 7, stage: "implement", runnerId: "gha-1" });
  expect(r.ok).toBe(true);
  const push = run.calls.find((c) => c.args[0] === "push");
  expect(push.args).toEqual(["push", "origin", "deadbeef".repeat(5) + ":refs/heads/factory/lock-7"]);
  const ct = run.calls.find((c) => c.args[0] === "commit-tree");
  expect(ct.args.join(" ")).toMatch(/lock issue=7 stage=implement runner=gha-1/);
});

test("claim fails (ok:false, holder from remote message) when ref exists", async () => {
  const run = makeFakeRun([...base,
    { match: (c, a) => c === "git" && a[0] === "push", result: { code: 1, stdout: "", stderr: "! [rejected] deadbeef -> factory/lock-7 (fetch first)" } },
    { match: (c, a) => c === "git" && a[0] === "fetch", result: { code: 0, stdout: "", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "log", result: { code: 0, stdout: "lock issue=7 stage=implement runner=local/mac at=2026-09-11T00:00:00Z\n", stderr: "" } },
  ]);
  const r = await claim({ run, cwd: "/repo", issue: 7, stage: "implement", runnerId: "gha-2" });
  expect(r.ok).toBe(false);
  expect(r.holder).toMatch(/runner=local\/mac/);
  const fetch = run.calls.find((c) => c.args[0] === "fetch");
  expect(fetch.args).toEqual(["fetch", "origin", "refs/heads/factory/lock-7"]);
  const log = run.calls.find((c) => c.args[0] === "log");
  expect(log.args).toEqual(["log", "-1", "--format=%s", "FETCH_HEAD"]);
});

test("claim fails without pushing when commit-tree fails", async () => {
  const run = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "hash-object", result: { code: 0, stdout: "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "commit-tree", result: { code: 1, stdout: "", stderr: "fatal: bad tree" } },
  ]);
  const r = await claim({ run, cwd: "/repo", issue: 7, stage: "implement", runnerId: "gha-1" });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/commit-tree failed/);
  expect(run.calls.find((c) => c.args[0] === "push")).toBeUndefined();
});

test("claim names the right step when hash-object fails", async () => {
  const run = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "hash-object", result: { code: 1, stdout: "", stderr: "fatal: not a git repository" } }]);
  const r = await claim({ run, cwd: "/repo", issue: 7, stage: "implement", runnerId: "gha-1" });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/hash-object failed/);
  expect(run.calls.find((c) => c.args[0] === "commit-tree")).toBeUndefined();
});

test("release deletes the lock ref", async () => {
  const run = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "push", result: { code: 0, stdout: "", stderr: "" } }]);
  await release({ run, cwd: "/repo", issue: 7 });
  expect(run.calls[0].args).toEqual(["push", "origin", "--delete", "refs/heads/factory/lock-7"]);
});

// ── ADR-020 KTB-24 fix — 락을 지우기 전에 "누구 것인가"를 묻는다 ────────────────────────────────
// `abortStage`는 claim에 실패해 물러난 런에서도 돈다(취소·실패는 claim 이전에도 온다). 소유자를 묻지
// 않고 지우면 지금 정상적으로 돌고 있는 다른 러너의 락을 지우는 일이고, 그러면 같은 이슈에 두
// 스테이지가 동시에 들어간다 — 락이 막으려던 바로 그 사고를 정리 코드가 만든다.
test("lockHolder: absent ref → {present:false}; present → the runner from the commit subject", async () => {
  const gone = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "fetch", result: { code: 128, stdout: "", stderr: "fatal: couldn't find remote ref refs/heads/factory/lock-7" } }]);
  expect(await lockHolder({ run: gone, cwd: "/repo", issue: 7 })).toEqual({ present: false });
  expect(gone.calls[0].args).toEqual(["fetch", "origin", "refs/heads/factory/lock-7"]);
  expect(gone.calls.find((c) => c.args[0] === "log")).toBeUndefined();   // 없는 ref의 커밋을 읽지 않는다

  const held = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "fetch", result: { code: 0, stdout: "", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "log", result: { code: 0, stdout: "lock issue=7 stage=review runner=gha-4242 at=2026-09-13T03:54:03Z\n", stderr: "" } },
  ]);
  expect(await lockHolder({ run: held, cwd: "/repo", issue: 7 })).toEqual({
    present: true, runner: "gha-4242", subject: "lock issue=7 stage=review runner=gha-4242 at=2026-09-13T03:54:03Z",
  });
});

test("lockHolder: a failed lookup is {present:null} — 'unreadable' is not 'absent'", async () => {
  const down = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "fetch", result: { code: 128, stdout: "", stderr: "fatal: could not read from remote repository" } }]);
  expect(await lockHolder({ run: down, cwd: "/repo", issue: 7 })).toEqual({ present: null, reason: "fatal: could not read from remote repository" });

  const noLog = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "fetch", result: { code: 0, stdout: "", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "log", result: { code: 128, stdout: "", stderr: "fatal: bad object FETCH_HEAD" } },
  ]);
  expect((await lockHolder({ run: noLog, cwd: "/repo", issue: 7 })).present).toBeNull();
});

test("lockRunnerOf reads the runner= field of the lock commit subject, and only that", () => {
  expect(lockRunnerOf("lock issue=7 stage=review runner=gha-1 at=t")).toBe("gha-1");
  expect(lockRunnerOf("lock issue=7 stage=review runner=local/mac-air.local at=t")).toBe("local/mac-air.local");
  expect(lockRunnerOf("lock issue=7")).toBeNull();          // 제목을 못 읽으면 null — 호출자가 fail open 한다
  expect(lockRunnerOf(undefined)).toBeNull();
  // `runner=`가 다른 단어의 꼬리로 붙은 경우는 매치하지 않는다
  expect(lockRunnerOf("lock norunner=x")).toBeNull();
});
