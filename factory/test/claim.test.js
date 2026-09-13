import { test, expect } from "vitest";
import { claim, release, releaseIfStale, lockHolder, lockRunnerOf, ghaRunIdOf, runnerState, leaseArg, STALE_LOCK_RACE } from "../lib/claim.js";
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
    { match: (c, a) => c === "git" && a[0] === "log", result: { code: 0, stdout: "f".repeat(40) + "\nlock issue=7 stage=implement runner=local/mac at=2026-09-11T00:00:00Z\n", stderr: "" } },
  ]);
  const r = await claim({ run, cwd: "/repo", issue: 7, stage: "implement", runnerId: "gha-2" });
  expect(r.ok).toBe(false);
  expect(r.holder).toMatch(/runner=local\/mac/);
  const fetch = run.calls.find((c) => c.args[0] === "fetch");
  expect(fetch.args).toEqual(["fetch", "origin", "refs/heads/factory/lock-7"]);
  // sha와 제목을 한 번에 읽는다 — sha는 회수에 걸 리스의 재료다(r1 MF1)
  const log = run.calls.find((c) => c.args[0] === "log");
  expect(log.args).toEqual(["log", "-1", "--format=%H%n%s", "FETCH_HEAD"]);
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
    { match: (c, a) => c === "git" && a[0] === "log", result: { code: 0, stdout: `${LOCK_SHA}\nlock issue=7 stage=review runner=gha-4242 at=2026-09-13T03:54:03Z\n`, stderr: "" } },
  ]);
  // sha까지 돌려준다 — 지우는 쪽이 그 값으로 리스를 건다(r1 MF1)
  expect(await lockHolder({ run: held, cwd: "/repo", issue: 7 })).toEqual({
    present: true, runner: "gha-4242", subject: "lock issue=7 stage=review runner=gha-4242 at=2026-09-13T03:54:03Z", sha: LOCK_SHA,
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
const LOCK_SHA = "a1b2c3d4".repeat(5);
const RECLAIM = (over = {}) => ({
  subject: "lock issue=7 stage=review runner=gha-34736609544 at=2026-09-13T03:54:03Z",
  sha: LOCK_SHA,
  status: "completed",
  ...over,
});
/** push는 처음엔 거부되고(락 존재), 리스를 건 두 번째 push(CAS)만 성공한다 — 회수의 실제 모양이다. */
function reclaimRun({ subject, sha, status, casCode = 0, ghCode = 0 } = RECLAIM()) {
  return makeFakeRun([...base,
    { match: (c, a) => c === "git" && a[0] === "push" && String(a[1]).startsWith("--force-with-lease"), result: { code: casCode, stdout: "", stderr: casCode ? "! [rejected] (stale info)" : "" } },
    { match: (c, a) => c === "git" && a[0] === "push", result: { code: 1, stdout: "", stderr: "! [rejected] (fetch first)" } },
    { match: (c, a) => c === "git" && a[0] === "fetch", result: { code: 0, stdout: "", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "log", result: { code: 0, stdout: `${sha}\n${subject}\n`, stderr: "" } },
    { match: (c, a) => c === "gh" && a[0] === "run", result: { code: ghCode, stdout: JSON.stringify({ status }), stderr: ghCode ? "could not find run" : "" } },
  ]);
}

test("KTB-28: a lock held by a COMPLETED workflow run is reclaimed, and says so", async () => {
  const run = reclaimRun(RECLAIM());
  const r = await claim({ run, cwd: "/repo", issue: 7, stage: "review", runnerId: "gha-99" });
  expect(r.ok).toBe(true);
  expect(r.reclaimed).toEqual({ runner: "gha-34736609544", status: "completed" });
  // 상태는 주입된 러너를 통해 묻는다 — `gh run view <id> --json status`
  expect(run.calls.find((c) => c.cmd === "gh").args).toEqual(["run", "view", "34736609544", "--json", "status"]);
});

// ── r1 MF1 — 읽은 락과 바꾸는 락이 같은 락인가 ────────────────────────────────────────────────────
// 리뷰가 그린 사고: ①sweeper/claim이 ref를 읽는다(runner=A) → ②A가 락을 풀고 끝난다 → ③`gh run view`가
// "completed"라고 (사실대로) 답한다 → ④같은 concurrency 그룹에 PENDING이던 C가 그 자리에서 새 락을
// 잡는다 → ⑤우리가 **C의 살아 있는 락**을 지운다. 읽기와 쓰기 사이가 네트워크 왕복만큼 벌어져 있으므로,
// 지우기·바꾸기는 읽은 sha에 리스를 걸어야 한다.
test("MF1: the reclaim is ONE compare-and-swap under a lease on the sha it read — no bare delete", async () => {
  const run = reclaimRun(RECLAIM());
  expect((await claim({ run, cwd: "/repo", issue: 7, stage: "review", runnerId: "gha-99" })).ok).toBe(true);
  const pushes = run.calls.filter((c) => c.args[0] === "push");
  expect(pushes).toHaveLength(2);                                     // 처음의 평범한 시도 + CAS 하나
  expect(pushes.some((c) => c.args.includes("--delete"))).toBe(false); // 삭제→재생성의 빈 창이 없다
  expect(pushes[1].args).toEqual(["push", leaseArg(7, LOCK_SHA), "origin", "deadbeef".repeat(5) + ":refs/heads/factory/lock-7"]);
});

test("MF1: a broken lease is never a reclaim — someone re-took the lock, so it is LIVE", async () => {
  const run = reclaimRun(RECLAIM({ casCode: 1 }));
  const r = await claim({ run, cwd: "/repo", issue: 7, stage: "review", runnerId: "gha-99" });
  expect(r.ok).toBe(false);
  expect(r.reclaimed).toBeUndefined();
  expect(r.race).toBe(true);
  expect(r.status).toContain(STALE_LOCK_RACE);
});

test("MF1: an unreadable lock sha refuses rather than deleting blind", async () => {
  const run = reclaimRun(RECLAIM({ sha: "" }));
  const r = await claim({ run, cwd: "/repo", issue: 7, stage: "review", runnerId: "gha-99" });
  expect(r.ok).toBe(false);
  expect(run.calls.filter((c) => c.args[0] === "push")).toHaveLength(1);   // CAS조차 시도하지 않는다
});

// ── r1 MF1 — sweeper 쪽 회수(`releaseIfStale`)도 같은 리스를 건다 ────────────────────────────────
// 이쪽이 더 위험했다: claim은 재생성에 실패하면 물러나기라도 했지만, sweeper는 지운 뒤 **새 런을 민다**.
const stale = ({ sha = LOCK_SHA, subject = "lock issue=7 stage=review runner=gha-4242 at=t", status = "completed", pushCode = 0, fetchCode = 0 } = {}) =>
  makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "fetch", result: { code: fetchCode, stdout: "", stderr: fetchCode ? "fatal: could not read from remote repository" : "" } },
    { match: (c, a) => c === "git" && a[0] === "log", result: { code: 0, stdout: `${sha}\n${subject}\n`, stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "push", result: { code: pushCode, stdout: "", stderr: pushCode ? "! [rejected] (stale info)" : "" } },
    { match: (c, a) => c === "gh" && a[0] === "run", result: { code: 0, stdout: JSON.stringify({ status }), stderr: "" } },
  ]);

test("MF1: releaseIfStale deletes a dead runner's lock under a lease, and reports it", async () => {
  const run = stale();
  const r = await releaseIfStale({ run, cwd: "/repo", issue: 7 });
  expect(r).toMatchObject({ released: true, live: false, runner: "gha-4242" });
  expect(run.calls.find((c) => c.args[0] === "push").args).toEqual(["push", leaseArg(7, LOCK_SHA), "origin", ":refs/heads/factory/lock-7"]);
});

test("MF1: a lease failure means the lock is LIVE — nothing deleted, stale-lock-race recorded", async () => {
  const run = stale({ pushCode: 1 });
  const r = await releaseIfStale({ run, cwd: "/repo", issue: 7 });
  expect(r.released).toBe(false);
  expect(r.live).toBe(true);
  expect(r.race).toBe(true);
  expect(r.why).toContain(STALE_LOCK_RACE);
});

test("MF1: releaseIfStale — a live runner is left alone (live:true), an absent/unreadable lock is not 'live'", async () => {
  const running = stale({ status: "in_progress" });
  const r1 = await releaseIfStale({ run: running, cwd: "/repo", issue: 7 });
  expect(r1).toMatchObject({ released: false, live: true });
  expect(running.calls.some((c) => c.args[0] === "push")).toBe(false);

  const gone = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "fetch", result: { code: 128, stdout: "", stderr: "fatal: couldn't find remote ref refs/heads/factory/lock-7" } }]);
  expect(await releaseIfStale({ run: gone, cwd: "/repo", issue: 7 })).toEqual({ released: false, live: false, state: "none", why: "no lock" });

  // 조회 실패는 "살아 있다"가 아니다 — 그렇게 읽으면 GitHub 장애 동안 복구 장치가 통째로 멎는다.
  // r2 MF1: 그렇다고 "잔해"도 아니다 — 세 번째 값 `unknown`이다(밀지도 지우지도 않고, 사람을 부른다).
  const down = stale({ fetchCode: 128 });
  const r3 = await releaseIfStale({ run: down, cwd: "/repo", issue: 7 });
  expect(r3).toMatchObject({ released: false, live: false, state: "unknown" });
  expect(r3.why).toMatch(/lock unreadable/);
});

/**
 * r2 MF1 — **"돌고 있다"와 "물어보지 못했다"는 다른 사실이다.** r1은 `completed:false` 하나로 둘을
 * 합쳤고, sweeper는 그 불리언으로 *삭제*가 아니라 *dispatch*를 결정했다: 로컬 러너가 남긴 락
 * (`runner=local/<host>` — §4.2.5의 지원 경로) 하나가 두 dispatch 팔을 영원히 조용히 세웠다.
 */
test("MF1 r2: runnerState/releaseIfStale are three-valued — live · stale · unknown", async () => {
  const cases = [
    [{ status: "in_progress" }, "live"],
    [{ status: "queued" }, "live"],
    [{ status: "completed" }, "stale"],
  ];
  for (const [over, want] of cases) {
    const run = stale(over);
    expect((await runnerState({ run, cwd: "/repo", runner: "gha-4242" })).state, JSON.stringify(over)).toBe(want);
  }
  // unknown 넷: 워크플로 런이 아님 · 조회 실패(exit≠0) · 조회가 던짐 · 상태 필드 없음
  expect((await runnerState({ run: makeFakeRun([]), cwd: "/repo", runner: "local/mac" })).state).toBe("unknown");
  const down = makeFakeRun([{ match: (c) => c === "gh", result: { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible (Actions: read)" } }]);
  expect((await runnerState({ run: down, cwd: "/repo", runner: "gha-1" })).state).toBe("unknown");
  const boom = makeFakeRun([{ match: (c) => c === "gh", result: () => { throw new Error("gh: network down"); } }]);
  expect((await runnerState({ run: boom, cwd: "/repo", runner: "gha-1" })).state).toBe("unknown");
  const empty = makeFakeRun([{ match: (c) => c === "gh", result: { code: 0, stdout: "{}", stderr: "" } }]);
  expect((await runnerState({ run: empty, cwd: "/repo", runner: "gha-1" })).state).toBe("unknown");

  // 로컬 러너가 쥔 락: 지우지 않고(fail closed), live도 아니다 — sweeper가 이것을 보고 사람을 부른다.
  const local = stale({ subject: "lock issue=7 stage=implement runner=local/hk-mac at=t" });
  const r = await releaseIfStale({ run: local, cwd: "/repo", issue: 7 });
  expect(r).toMatchObject({ released: false, live: false, state: "unknown" });
  expect(r.why).toMatch(/unknowable \(not-a-workflow-run\)/);
  expect(local.calls.some((c) => c.args[0] === "push")).toBe(false);
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

test("KTB-28: a reclaim that loses the race refuses — it never reports a lock it doesn't hold", async () => {
  const lostRace = reclaimRun(RECLAIM({ casCode: 1 }));
  const r = await claim({ run: lostRace, cwd: "/repo", issue: 7, stage: "review", runnerId: "gha-99" });
  expect(r.ok).toBe(false);
  expect(r.reclaimed).toBeUndefined();
});

test("KTB-28: ghaRunIdOf / runnerState — only `gha-<digits>` is a workflow run", async () => {
  expect(ghaRunIdOf("gha-34736609544")).toBe("34736609544");
  expect(ghaRunIdOf("local/mac-air.local")).toBeNull();
  expect(ghaRunIdOf("gha-abc")).toBeNull();
  expect(ghaRunIdOf(null)).toBeNull();
  // 로컬 러너는 조회 자체를 하지 않는다(회수하지 않는다 — r2 MF1 이후로는 `unknown`이다)
  const noGh = makeFakeRun([]);
  expect(await runnerState({ run: noGh, cwd: "/repo", runner: "local/mac" })).toEqual({ completed: false, state: "unknown", status: "not-a-workflow-run" });
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
