import { test, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { syncRecords, readRecords, hydrateRecord } from "../lib/records-branch.js";
import { appendRunRecord } from "../lib/run-record.js";

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
}, 30000);

test("(b) second sync links a parent (2 commits on factory/records) and updates the file", async () => {
  const remote = await makeRemote();
  const cwd = await makeClone(remote);

  writeRecord(cwd, 7, "v1\n");
  const r1 = await syncRecords({ run, cwd, message: "m1" });
  expect(r1.ok).toBe(true);

  // 실제 appendRunRecord처럼 기존 내용 위에 이어 쓴다 — 통째로 갈아치우지 않는다(그건
  // syncRecords의 divergence 가드가 "브랜치 내용을 잃을 뻔했다"로 보고 건너뛰어야 할 케이스다).
  writeRecord(cwd, 7, "v1\nv2\n");
  const r2 = await syncRecords({ run, cwd, message: "m2" });
  expect(r2.ok).toBe(true);
  expect(r2.skipped).toEqual([]);
  expect(r2.commit).not.toBe(r1.commit);

  const log = await run("git", ["log", "--format=%H", "factory/records"], { cwd: remote });
  expect(log.stdout.trim().split("\n")).toEqual([r2.commit, r1.commit]);
  const parent = await run("git", ["rev-parse", `${r2.commit}^`], { cwd: remote });
  expect(parent.stdout.trim()).toBe(r1.commit);

  const show = await run("git", ["show", "factory/records:docs/factory/runs/7.md"], { cwd: remote });
  expect(show.stdout).toBe("v1\nv2\n");
}, 30000);

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
}, 30000);

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
}, 30000);

test("(e) no origin remote configured — syncRecords never throws, returns ok:false", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "records-noorigin-"));
  await git(cwd, "init", "-q", "-b", "main");
  await git(cwd, "commit", "-q", "--allow-empty", "-m", "init");
  writeRecord(cwd, 7, "x\n");

  const r = await syncRecords({ run, cwd, message: "m" });
  expect(r.ok).toBe(false);
  expect(r.retried).toBe(false);
  expect(typeof r.reason).toBe("string");
}, 30000);

test("readRecords returns an empty Map when the branch doesn't exist on the remote", async () => {
  const remote = await makeRemote();
  const cwd = await makeClone(remote);
  const map = await readRecords({ run, cwd });
  expect(map.size).toBe(0);
  expect(map instanceof Map).toBe(true);
}, 30000);

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
}, 30000);

test("custom author/committer env overrides the factory-bot defaults", async () => {
  const remote = await makeRemote();
  const cwd = await makeClone(remote);
  writeRecord(cwd, 7, "x\n");
  const r = await syncRecords({ run, cwd, message: "m", env: { GIT_AUTHOR_NAME: "someone", GIT_AUTHOR_EMAIL: "someone@example.com" } });
  expect(r.ok).toBe(true);
  const show = await run("git", ["show", "-s", "--format=%an <%ae>", r.commit], { cwd: remote });
  expect(show.stdout.trim()).toBe("someone <someone@example.com>");
}, 30000);

test("default author/committer is factory-bot when env is not given", async () => {
  const remote = await makeRemote();
  const cwd = await makeClone(remote);
  writeRecord(cwd, 7, "x\n");
  const r = await syncRecords({ run, cwd, message: "m" });
  expect(r.ok).toBe(true);
  const show = await run("git", ["show", "-s", "--format=%an <%ae>", r.commit], { cwd: remote });
  expect(show.stdout.trim()).toBe("factory-bot <factory-bot@users.noreply.github.com>");
}, 30000);

// ── fix round 1: hydrateRecord — fresh checkout must not clobber the branch's accumulated record ──

test("hydrateRecord: a fresh clone restores the branch's record before this stage appends, so nothing is lost", async () => {
  const remote = await makeRemote();
  const cwd1 = await makeClone(remote, "writer");
  writeRecord(cwd1, 7, "# Run · #7\n\n## triage · t1\ndisposition: ready\n");
  const r1 = await syncRecords({ run, cwd: cwd1, message: "m1" });
  expect(r1.ok).toBe(true);

  // 다음 스테이지는 완전히 새로운(fresh) 체크아웃에서 돈다 — 로컬에 docs/factory/runs/7.md가 없다.
  const cwd2 = await makeClone(remote, "fresh");
  expect(existsSync(join(cwd2, "docs/factory/runs/7.md"))).toBe(false);
  const h = await hydrateRecord({ run, cwd: cwd2, issue: 7 });
  expect(h).toEqual({ ok: true, hydrated: true });
  expect(readFileSync(join(cwd2, "docs/factory/runs/7.md"), "utf8")).toBe("# Run · #7\n\n## triage · t1\ndisposition: ready\n");

  appendRunRecord({ root: cwd2, issue: 7, stage: "plan", runnerId: "gha-2", now: "2026-09-12T00:00Z", lines: ["rounds: 1"] });
  const r2 = await syncRecords({ run, cwd: cwd2, message: "m2" });
  expect(r2.ok).toBe(true);
  expect(r2.skipped).toEqual([]);

  const show = await run("git", ["show", "factory/records:docs/factory/runs/7.md"], { cwd: remote });
  expect(show.stdout).toContain("## triage · t1\ndisposition: ready\n");
  expect(show.stdout).toContain("## plan · 2026-09-12T00:00Z · gha-2\nrounds: 1\n");
}, 30000);

test("hydrateRecord: diverged local content is reported (never silently merged), and syncRecords appends only the local tail — the branch content survives", async () => {
  const remote = await makeRemote();
  const cwd1 = await makeClone(remote, "writer");
  writeRecord(cwd1, 7, "branch content\n");
  const r1 = await syncRecords({ run, cwd: cwd1, message: "m1" });
  expect(r1.ok).toBe(true);

  const cwd2 = await makeClone(remote, "diverged");
  writeRecord(cwd2, 7, "completely different local content\n");   // hydrate가 만든 게 아닌, 이미 다른 로컬 내용
  const h = await hydrateRecord({ run, cwd: cwd2, issue: 7 });
  expect(h).toEqual({ ok: false, hydrated: false, reason: "local record diverged from branch" });
  expect(readFileSync(join(cwd2, "docs/factory/runs/7.md"), "utf8")).toBe("completely different local content\n");   // 손대지 않았다

  const r2 = await syncRecords({ run, cwd: cwd2, message: "m2" });
  expect(r2.ok).toBe(true);
  expect(r2.skipped).toEqual([]);
  expect(r2.merged).toEqual(["docs/factory/runs/7.md"]);

  const show = await run("git", ["show", "factory/records:docs/factory/runs/7.md"], { cwd: remote });
  expect(show.stdout).toBe("branch content\ncompletely different local content\n");   // 브랜치 내용 뒤에 로컬 꼬리가 붙었다 — 어느 쪽도 잃지 않는다
}, 30000);

test("(f) same-issue race: two runners hydrate from the same tip and both stage sections survive (F6)", async () => {
  const remote = await makeRemote();
  const seed = await makeClone(remote, "seed");
  // P0 — triage가 이미 브랜치에 올려둔 기록
  appendRunRecord({ root: seed, issue: 7, title: "race", stage: "triage", runnerId: "gha-0", now: "2026-09-12T00:00Z", lines: ["disposition: ready"] });
  const P0 = readFileSync(join(seed, "docs/factory/runs/7.md"), "utf8");
  expect((await syncRecords({ run, cwd: seed, message: "m0" })).ok).toBe(true);

  // 두 러너가 같은 이슈에서 같은 tip(P0)을 하이드레이트한다
  const cwdA = await makeClone(remote, "race-a");
  const cwdB = await makeClone(remote, "race-b");
  expect(await hydrateRecord({ run, cwd: cwdA, issue: 7 })).toEqual({ ok: true, hydrated: true });
  expect(await hydrateRecord({ run, cwd: cwdB, issue: 7 })).toEqual({ ok: true, hydrated: true });
  appendRunRecord({ root: cwdA, issue: 7, stage: "plan", runnerId: "gha-a", now: "2026-09-12T01:00Z", lines: ["rounds: 1"] });
  appendRunRecord({ root: cwdB, issue: 7, stage: "review", runnerId: "gha-b", now: "2026-09-12T02:00Z", lines: ["decision: approved"] });
  const S1 = readFileSync(join(cwdA, "docs/factory/runs/7.md"), "utf8").slice(P0.length);
  const S2 = readFileSync(join(cwdB, "docs/factory/runs/7.md"), "utf8").slice(P0.length);

  // A가 먼저 밀고, B는 그사이 tip이 움직인 것을 발견하고 재시도한다
  const rA = await syncRecords({ run, cwd: cwdA, message: "mA" });
  expect(rA.ok).toBe(true);
  const rB = await syncRecords({ run, cwd: cwdB, message: "mB" });
  expect(rB.ok).toBe(true);
  expect(rB.merged).toEqual(["docs/factory/runs/7.md"]);

  const show = await run("git", ["show", "factory/records:docs/factory/runs/7.md"], { cwd: remote });
  expect(show.stdout).toBe(P0 + S1 + S2);           // P0 + A의 섹션 + B의 섹션 — 아무것도 덮어쓰지 않았다
  expect(show.stdout).toContain("## plan · 2026-09-12T01:00Z · gha-a\nrounds: 1\n");
  expect(show.stdout).toContain("## review · 2026-09-12T02:00Z · gha-b\ndecision: approved\n");
}, 30000);

test("(g) syncRecords still skips a file whose local content adds nothing new (local is a prefix of the branch tip)", async () => {
  const remote = await makeRemote();
  const cwd1 = await makeClone(remote, "ahead");
  writeRecord(cwd1, 7, "line1\nline2\n");
  expect((await syncRecords({ run, cwd: cwd1, message: "m1" })).ok).toBe(true);

  const cwd2 = await makeClone(remote, "behind");
  writeRecord(cwd2, 7, "line1\n");                 // 브랜치 tip의 접두어일 뿐 — 새로 더한 꼬리가 없다
  const r2 = await syncRecords({ run, cwd: cwd2, message: "m2" });
  expect(r2.ok).toBe(true);
  expect(r2.skipped).toEqual(["docs/factory/runs/7.md"]);
  expect(r2.merged).toEqual([]);

  const show = await run("git", ["show", "factory/records:docs/factory/runs/7.md"], { cwd: remote });
  expect(show.stdout).toBe("line1\nline2\n");
}, 30000);

test("hydrateRecord: no factory/records branch on the remote → {ok:true, hydrated:false}, no throw", async () => {
  const remote = await makeRemote();
  const cwd = await makeClone(remote);
  writeRecord(cwd, 7, "local only\n");
  const h = await hydrateRecord({ run, cwd, issue: 7 });
  expect(h).toEqual({ ok: true, hydrated: false });
  expect(readFileSync(join(cwd, "docs/factory/runs/7.md"), "utf8")).toBe("local only\n");   // 손대지 않았다
}, 30000);

test("hydrateRecord: branch exists but has no record for this issue yet → {ok:true, hydrated:false}", async () => {
  const remote = await makeRemote();
  const cwd1 = await makeClone(remote, "writer");
  writeRecord(cwd1, 7, "x\n");
  await syncRecords({ run, cwd: cwd1, message: "m" });

  const cwd2 = await makeClone(remote, "other-issue");
  const h = await hydrateRecord({ run, cwd: cwd2, issue: 8 });
  expect(h).toEqual({ ok: true, hydrated: false });
  expect(existsSync(join(cwd2, "docs/factory/runs/8.md"))).toBe(false);
}, 30000);

// ── fix round 1: syncRecords — nothing to sync ──────────────────────────────

test("syncRecords with no local *.md files returns ok:true without committing anything", async () => {
  const remote = await makeRemote();
  const cwd = await makeClone(remote);
  const r = await syncRecords({ run, cwd, message: "m" });
  expect(r).toEqual({ ok: true, commit: null, reason: "nothing to sync", retried: false });
  const branches = await run("git", ["branch", "-r"], { cwd: remote });
  expect(branches.stdout).not.toContain("factory/records");
}, 30000);

// ── fix round 1: readRecords — flat files only ──────────────────────────────

test("readRecords only reads <name>.md files directly under dir — nested paths are skipped", async () => {
  const remote = await makeRemote();
  const cwd = await makeClone(remote);
  writeRecord(cwd, 7, "flat\n");
  const nestedDir = join(cwd, "docs/factory/runs/nested");
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(join(nestedDir, "99.md"), "nested\n");
  const r = await syncRecords({ run, cwd, message: "m" });
  expect(r.ok).toBe(true);

  const map = await readRecords({ run, cwd });
  expect(map.size).toBe(1);
  expect(map.get("7")).toBe("flat\n");
  expect(map.has("nested/99")).toBe(false);
}, 30000);
