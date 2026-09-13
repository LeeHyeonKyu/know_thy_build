import { test, expect } from "vitest";
import { claim, release, lockHolder, lockRunnerOf, ghaRunIdOf, runnerState } from "../lib/claim.js";
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

// ── ADR-020 KTB-28 — 끝난 러너가 쥔 락은 회수한다 ───────────────────────────────────────────────
// 데모 #15: 04:39에 타임아웃으로 죽은 review 런(정리 스텝 이전 버전)의 `lock-15`가 그대로 남아, 그 뒤의
// 모든 dispatch(sweeper stalled ×4 + 수동)가 26~40초 만에 claim에서 죽었다 — exit 0, 기록 없음,
// 코멘트 없음, 잡 결론 success. "디스패치가 됐다"로 보였다.
const RECLAIM = (over = {}) => ({
  subject: "lock issue=7 stage=review runner=gha-34736609544 at=2026-09-13T03:54:03Z",
  status: "completed",
  ...over,
});
/** push는 처음엔 거부되고(락 존재), 삭제 뒤의 두 번째 push만 성공한다 — 회수의 실제 모양이다. */
function reclaimRun({ subject, status, deleteCode = 0, secondPushCode = 0, ghCode = 0 } = RECLAIM()) {
  let pushes = 0;
  return makeFakeRun([...base,
    { match: (c, a) => c === "git" && a[0] === "push" && a[1] === "origin" && a[2] === "--delete", result: { code: deleteCode, stdout: "", stderr: deleteCode ? "remote rejected" : "" } },
    { match: (c, a) => c === "git" && a[0] === "push", result: () => (++pushes === 1 ? { code: 1, stdout: "", stderr: "! [rejected] (fetch first)" } : { code: secondPushCode, stdout: "", stderr: secondPushCode ? "! [rejected]" : "" }) },
    { match: (c, a) => c === "git" && a[0] === "fetch", result: { code: 0, stdout: "", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "log", result: { code: 0, stdout: subject + "\n", stderr: "" } },
    { match: (c, a) => c === "gh" && a[0] === "run", result: { code: ghCode, stdout: JSON.stringify({ status }), stderr: ghCode ? "could not find run" : "" } },
  ]);
}

test("KTB-28: a lock held by a COMPLETED workflow run is reclaimed (delete + create), and says so", async () => {
  const run = reclaimRun(RECLAIM());
  const r = await claim({ run, cwd: "/repo", issue: 7, stage: "review", runnerId: "gha-99" });
  expect(r.ok).toBe(true);
  expect(r.reclaimed).toEqual({ runner: "gha-34736609544", status: "completed" });
  // 상태는 주입된 러너를 통해 묻는다 — `gh run view <id> --json status`
  expect(run.calls.find((c) => c.cmd === "gh").args).toEqual(["run", "view", "34736609544", "--json", "status"]);
  // 삭제가 재생성보다 먼저다
  const seq = run.calls.filter((c) => c.args[0] === "push").map((c) => (c.args[2] === "--delete" ? "delete" : "create"));
  expect(seq).toEqual(["create", "delete", "create"]);
});

test("KTB-28: a lock whose runner is still in_progress is NOT reclaimed — the refusal carries runner + status", async () => {
  const run = reclaimRun(RECLAIM({ status: "in_progress" }));
  const r = await claim({ run, cwd: "/repo", issue: 7, stage: "review", runnerId: "gha-99" });
  expect(r.ok).toBe(false);
  expect(r.runner).toBe("gha-34736609544");
  expect(r.status).toBe("in_progress");
  expect(run.calls.some((c) => c.args[0] === "push" && c.args[2] === "--delete")).toBe(false);
});

test("KTB-28: an unreachable/unknown runner is treated as LIVE — fail closed, never reclaimed", async () => {
  for (const over of [{ ghCode: 1 }, { status: undefined }, { subject: "lock issue=7 stage=review runner=local/mac at=t" }]) {
    const run = reclaimRun(RECLAIM(over));
    const r = await claim({ run, cwd: "/repo", issue: 7, stage: "review", runnerId: "gha-99" });
    expect(r.ok, JSON.stringify(over)).toBe(false);
    expect(run.calls.some((c) => c.args[0] === "push" && c.args[2] === "--delete")).toBe(false);
  }
});

test("KTB-28: a reclaim that loses the race (delete or re-push fails) refuses — it never reports a lock it doesn't hold", async () => {
  const noDelete = reclaimRun(RECLAIM({ deleteCode: 1 }));
  expect((await claim({ run: noDelete, cwd: "/repo", issue: 7, stage: "review", runnerId: "gha-99" })).ok).toBe(false);
  const lostRace = reclaimRun(RECLAIM({ secondPushCode: 1 }));
  const r = await claim({ run: lostRace, cwd: "/repo", issue: 7, stage: "review", runnerId: "gha-99" });
  expect(r.ok).toBe(false);
  expect(r.reclaimed).toBeUndefined();
});

test("KTB-28: ghaRunIdOf / runnerState — only `gha-<digits>` is a workflow run", async () => {
  expect(ghaRunIdOf("gha-34736609544")).toBe("34736609544");
  expect(ghaRunIdOf("local/mac-air.local")).toBeNull();
  expect(ghaRunIdOf("gha-abc")).toBeNull();
  expect(ghaRunIdOf(null)).toBeNull();
  // 로컬 러너는 조회 자체를 하지 않는다(살아 있는 것으로 본다)
  const noGh = makeFakeRun([]);
  expect(await runnerState({ run: noGh, cwd: "/repo", runner: "local/mac" })).toEqual({ completed: false, status: "not-a-workflow-run" });
  expect(noGh.calls).toEqual([]);
  // `gh`가 던져도 살아 있는 것으로 본다
  const boom = makeFakeRun([{ match: (c) => c === "gh", result: () => { throw new Error("gh: network down"); } }]);
  expect((await runnerState({ run: boom, cwd: "/repo", runner: "gha-1" })).completed).toBe(false);
});

// M4(r1 재리뷰): "not found"는 **없는 ref**의 표식이 아니다 — `gh`/`git`이 레포 자체를 못 찾을 때도
// ("Repository not found") 같은 문구가 난다. 그것을 "락이 없다"로 읽으면 정리 코드가 남의 락을 지운다.
test("M4: lockHolder does not read 'Repository not found' as an absent lock", async () => {
  const denied = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "fetch", result: { code: 128, stdout: "", stderr: "remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found" } }]);
  expect((await lockHolder({ run: denied, cwd: "/repo", issue: 7 })).present).toBeNull();
});

test("lockRunnerOf reads the runner= field of the lock commit subject, and only that", () => {
  expect(lockRunnerOf("lock issue=7 stage=review runner=gha-1 at=t")).toBe("gha-1");
  expect(lockRunnerOf("lock issue=7 stage=review runner=local/mac-air.local at=t")).toBe("local/mac-air.local");
  expect(lockRunnerOf("lock issue=7")).toBeNull();          // 제목을 못 읽으면 null — 호출자가 fail open 한다
  expect(lockRunnerOf(undefined)).toBeNull();
  // `runner=`가 다른 단어의 꼬리로 붙은 경우는 매치하지 않는다
  expect(lockRunnerOf("lock norunner=x")).toBeNull();
});
