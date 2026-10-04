import { test, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { appendRunRecord } from "../lib/run-record.js";
import { readRecordsDetailed, syncRecords } from "../lib/records-branch.js";
import { selfMergeLine, runMergeStage } from "../lib/merge-stage.js";
import { breakerThresholds, parseSelfChange } from "../lib/config.js";
import {
  evaluateBreaker, buildHistory, parseRevertCommits, REVERT_LOG_FORMAT, revertedPr, parseSelfMergeLines,
  readBreaker, readBreakerState, writeBreakerState, renderBreakerState,
  BREAKER_STATE_DIR, BREAKER_STATE_FILE, BREAKER_STATE_MARKER, BREAKER_RESET_COMMAND,
} from "../lib/breaker.js";
import { breakerCommand } from "../cli/breaker.js";
import { makeRecordsUploadGuard, makeMergeAbortVouch } from "../lib/breaker.js";
import { syncRunRecords, stageBranch } from "../bin/run-stage.js";
import { retroRecordsSync } from "../bin/retro.js";

/**
 * #189 (S4c, ADR-033) — 자동 머지 회로차단기.
 *
 * 픽스처는 **실제 생산자**로 만든다: 자동 머지의 기록은 merge 스테이지가 run 기록에 남기는 줄(`selfMergeLine` →
 * `appendRunRecord`)이고, revert는 진짜 git이 만든 `git log --format=${REVERT_LOG_FORMAT}` 출력을 **프로덕션 파서**
 * (`parseRevertCommits` — `readBreaker`가 부르는 그것)로 읽은 것이다(`git revert`의 `Revert "…"`와
 * GitHub이 revert PR을 squash 머지한 `Revert "… (#N)" (#M)` 두 모양). 손으로 쓴 history 배열은 쓰지 않는다.
 */

const git = (cwd, args, env = {}) => run("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, env });

/** merge 스테이지가 남기는 run 기록 한 섹션(실제 생산자 두 개로). */
function mergeRecordText({ issue, pr, kind, at, sha = "a".repeat(40) }) {
  const root = mkdtempSync(join(tmpdir(), "ktb-189-rec-"));
  const p = appendRunRecord({
    root, issue, title: "x", stage: "merge", runnerId: "gha-1", now: at,
    lines: [`merge: merged ${sha.slice(0, 7)} via PR #${pr}`, selfMergeLine({ issue, pr, kind, sha, at })],
  });
  return readFileSync(p, "utf8");
}

/**
 * 보호 경로 PR을 머지 스테이지가 사람에게 넘길 때 남기는 run 기록(실제 생산자: `runMergeStage`의 handToHuman → `appendRunRecord`).
 * 보호 경로 판정은 게이트보다 먼저라 그 앞의 dep(prInfo·protectedPaths·comment·transition)만 있으면 된다.
 */
async function humanHandedRecord({ issue, pr }) {
  const lines = [];
  const d = {
    prInfo: vi.fn(async () => ({ number: pr, state: "OPEN", mergeable: "MERGEABLE" })),
    protectedPaths: vi.fn(async () => ({ ok: true, files: ["factory/lib/merge-stage.js"] })),
    comment: vi.fn(async () => {}),
    transition: vi.fn(async ({ to }) => ({ ok: true, from: "factory:approved", to })),
    mergePr: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
  };
  const code = await runMergeStage({ issue, defaultBranch: "main", headSha: "b".repeat(40), d, record: (ls) => lines.push(...ls), refusal: (t) => (t.ok ? [] : [`transition refused: ${t.reason}`]), postStatus: vi.fn(async () => {}) });
  expect(code).toBe(2);
  expect(d.mergePr).not.toHaveBeenCalled();
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human" }));
  const root = mkdtempSync(join(tmpdir(), "ktb-189-human-"));
  return readFileSync(appendRunRecord({ root, issue, title: "x", stage: "merge", runnerId: "gha-1", now: "2026-10-01T02:00:00.000Z", lines }), "utf8");
}

/**
 * 진짜 git 저장소에 커밋과 revert를 시각을 박아 쌓고 `git log --format=%cI%x09%s`를 돌려준다.
 * steps: `{ subject, at }`(커밋), `{ revert: <subject>, at }`(`git revert --no-edit`), `{ raw: <subject>, at }`(그 제목 그대로의 커밋 —
 * GitHub이 revert PR을 squash 머지한 모양).
 */
async function realLog(steps, cwd = null) {
  const dir = cwd ?? mkdtempSync(join(tmpdir(), "ktb-189-log-"));
  if (!cwd) await git(dir, ["init", "-q", "-b", "main"]);
  const shas = {};
  let i = 0;
  for (const s of steps) {
    const env = { GIT_AUTHOR_DATE: s.at, GIT_COMMITTER_DATE: s.at };
    if (s.revert) {
      const r = await git(dir, ["revert", "--no-edit", shas[s.revert]], env);
      expect(r.code, r.stderr).toBe(0);
    } else {
      const subject = s.subject ?? s.raw;
      writeFileSync(join(dir, `f${i++}.txt`), subject);
      await git(dir, ["add", "."]);
      const c = await git(dir, ["commit", "-q", "-m", subject], env);
      expect(c.code, c.stderr).toBe(0);
      shas[subject] = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    }
  }
  return (await git(dir, ["log", `--format=${REVERT_LOG_FORMAT}`])).stdout;
}
/** 프로덕션 읽기(`readBreaker`)와 같은 파서로 revert를 뽑는다 — 테스트 전용 파서는 없다(self-critique f1). */
const revertsOf = (log) => parseRevertCommits(log).reverts;
/** git log 레코드 중 정규식에 맞는 것만(제목 기준) — "리셋 직후의 같은 history" 같은 부분 history용. */
const pickRecords = (log, re) => String(log).split("\x1e").filter((r) => r.trim() && re.test(r.split("\x1f")[0])).map((r) => `\x1e${r}`).join("");

const T2 = breakerThresholds(parseSelfChange(undefined));          // CHARTER에 키가 없을 때의 실제 값
const iso = (s) => new Date(s).toISOString();

// ── dw1 ───────────────────────────────────────────────────────────────────────────────────────────

test("test_189_breaker_opens_on_two_consecutive_reverts_of_judge_automerges", async () => {
  expect(T2).toEqual({ revert_streak: 2 });

  // 실제 revert 제목 두 모양: `git revert`가 만든 것과, revert PR이 squash 머지된 것(바깥 (#20)이 아니라 안쪽 (#12)를 센다).
  const log = await realLog([
    { subject: "feat a (#11)", at: "2026-10-01T01:00:00Z" },
    { subject: "feat b (#12)", at: "2026-10-01T02:00:00Z" },
    { revert: "feat a (#11)", at: "2026-10-01T05:00:00Z" },
    { raw: 'Revert "feat b (#12)" (#20)', at: "2026-10-01T06:00:00Z" },
  ]);
  expect(log).toContain('Revert "feat a (#11)"');
  expect(revertedPr('Revert "feat a (#11)"')).toBe(11);
  expect(revertedPr('Revert "feat b (#12)" (#20)')).toBe(12);
  expect(revertedPr("feat b (#12)")).toBeNull();
  expect(revertedPr('Revert "no pr number here"')).toBeNull();
  const reverts = revertsOf(log);
  expect(reverts.map((r) => r.pr).sort()).toEqual([11, 12]);
  // 본문이 없는 squash 모양(`Revert "feat b (#12)" (#20)`)은 제목 말고는 단서가 없다 — 제목 귀속이 꺼지면 여기서 사라진다.
  expect(parseRevertCommits(pickRecords(log, /Revert "feat b/)).reverts).toEqual([expect.objectContaining({ pr: 12, at: iso("2026-10-01T06:00:00Z") })]);
  expect(parseRevertCommits(pickRecords(log, /Revert "feat b/)).unattributed).toEqual([]);

  const records = new Map([
    ["101", mergeRecordText({ issue: 101, pr: 11, kind: "judge", at: "2026-10-01T01:00:00.000Z" })],
    ["102", mergeRecordText({ issue: 102, pr: 12, kind: "judge", at: "2026-10-01T02:00:00.000Z" })],
  ]);
  const open = evaluateBreaker({ history: buildHistory({ records, reverts }), thresholds: T2 });
  expect(open.open).toBe(true);
  expect(open.reason).toMatch(/#11\b/);
  expect(open.reason).toMatch(/#12\b/);
  expect(open.since).toBe(iso("2026-10-01T06:00:00Z"));            // 두 번째 revert가 연속을 채운 순간

  // 비판정 자동 머지의 revert는 세지 않는다: 판정 하나 + 비판정 하나가 revert되어도 닫힘.
  const nonJudge = new Map([
    ["101", records.get("101")],
    ["102", mergeRecordText({ issue: 102, pr: 12, kind: "non_judge", at: "2026-10-01T02:00:00.000Z" })],
  ]);
  expect(evaluateBreaker({ history: buildHistory({ records: nonJudge, reverts }), thresholds: T2 }).open).toBe(false);

  // 사람 머지는 자동 머지가 아니다 — 그 PR이 revert되어도 닫힘. 기록은 실제 생산자로 만든다: 머지 스테이지가 보호 경로 PR을 사람에게
  // 넘기며(handToHuman) 쓴 `## merge` 섹션(runMergeStage → appendRunRecord). 사람이 머지한 뒤 sweeper의 반영(by=script 전이)은
  // 이슈 코멘트이고 run 기록에는 아무것도 더하지 않는다. (일반 자동 머지·사람 머지 둘 다의 끝에서 끝까지는 merge-stage.test.js
  // `test_189_human_and_plain_merge_records_never_count_toward_the_streak`.)
  const handed = await humanHandedRecord({ issue: 102, pr: 12 });
  expect(handed).toMatch(/^## merge/m);
  expect(handed).toMatch(/protected paths changed/);
  const human = new Map([["101", records.get("101")], ["102", handed]]);
  expect(evaluateBreaker({ history: buildHistory({ records: human, reverts }), thresholds: T2 }).open).toBe(false);
  // 대조군: 같은 자리에 판정 경로 자동 머지 기록이면 열린다.
  expect(evaluateBreaker({ history: buildHistory({ records: new Map([["101", records.get("101")], ["102", records.get("102")]]), reverts }), thresholds: T2 }).open).toBe(true);

  // 두 revert 사이에 revert 없는 판정 자동 머지(#14)가 끼면 연속이 아니다.
  const gap = new Map([...records, ["104", mergeRecordText({ issue: 104, pr: 14, kind: "judge", at: "2026-10-01T01:30:00.000Z" })]]);
  expect(evaluateBreaker({ history: buildHistory({ records: gap, reverts }), thresholds: T2 }).open).toBe(false);
  // 비판정 자동 머지는 연속을 끊지도 잇지도 않는다(판정 경로의 연속만 센다).
  const between = new Map([...records, ["103", mergeRecordText({ issue: 103, pr: 13, kind: "non_judge", at: "2026-10-01T01:30:00.000Z" })]]);
  expect(evaluateBreaker({ history: buildHistory({ records: between, reverts }), thresholds: T2 }).open).toBe(true);

  // 연속 길이는 CHARTER `self_change.breaker.revert_streak`에서 온다.
  const T3 = breakerThresholds(parseSelfChange({ breaker: { revert_streak: 3 } }));
  expect(T3).toEqual({ revert_streak: 3 });
  expect(evaluateBreaker({ history: buildHistory({ records, reverts }), thresholds: T3 }).open).toBe(false);
  const log3 = await realLog([
    { subject: "feat a (#11)", at: "2026-10-01T01:00:00Z" },
    { subject: "feat b (#12)", at: "2026-10-01T02:00:00Z" },
    { subject: "feat c (#13)", at: "2026-10-01T03:00:00Z" },
    { revert: "feat a (#11)", at: "2026-10-01T05:00:00Z" },
    { revert: "feat b (#12)", at: "2026-10-01T06:00:00Z" },
    { raw: 'Revert "feat c (#13)" (#21)', at: "2026-10-01T07:00:00Z" },
  ]);
  const three = new Map([...records, ["103", mergeRecordText({ issue: 103, pr: 13, kind: "judge", at: "2026-10-01T03:00:00.000Z" })]]);
  const r3 = evaluateBreaker({ history: buildHistory({ records: three, reverts: revertsOf(log3) }), thresholds: T3 });
  expect(r3.open).toBe(true);
  expect(r3.since).toBe(iso("2026-10-01T07:00:00Z"));

  // 기록 줄의 판정 비트는 merge 스테이지가 그 순간 쓴 것 그대로 읽힌다(모르는 버전은 무시).
  const parsed = parseSelfMergeLines(records.get("101"));
  expect(parsed).toEqual([expect.objectContaining({ issue: 101, pr: 11, judge: true })]);
  expect(parseSelfMergeLines(records.get("101").replace("factory-self-merge:v1", "factory-self-merge:v9"))).toEqual([]);
}, 120000);

// ── dw2 ───────────────────────────────────────────────────────────────────────────────────────────

test("test_189_reset_scopes_evaluation_to_events_after_closed_at", async () => {
  const T = "2026-10-02T00:00:00.000Z";                             // 사람이 리셋한 시각(closed_at)
  const log = await realLog([
    { subject: "feat a (#11)", at: "2026-10-01T01:00:00Z" },
    { subject: "feat b (#12)", at: "2026-10-01T02:00:00Z" },
    { revert: "feat a (#11)", at: "2026-10-01T05:00:00Z" },
    { revert: "feat b (#12)", at: "2026-10-01T06:00:00Z" },
    { subject: "feat c (#13)", at: "2026-10-02T01:00:00Z" },
    { subject: "feat d (#14)", at: "2026-10-02T02:00:00Z" },
    { raw: 'Revert "feat c (#13)" (#30)', at: "2026-10-02T05:00:00Z" },
    { revert: "feat d (#14)", at: "2026-10-02T06:00:00Z" },
  ]);
  // 리셋 직후: 브레이커를 연 두 revert만 있는 같은 history.
  const beforeReset = revertsOf(pickRecords(log, /#11|#12/));
  expect(beforeReset.map((r) => r.pr).sort()).toEqual([11, 12]);
  const ab = new Map([
    ["101", mergeRecordText({ issue: 101, pr: 11, kind: "judge", at: "2026-10-01T01:00:00.000Z" })],
    ["102", mergeRecordText({ issue: 102, pr: 12, kind: "judge", at: "2026-10-01T02:00:00.000Z" })],
  ]);
  expect(evaluateBreaker({ history: buildHistory({ records: ab, reverts: beforeReset }), thresholds: T2 }).open).toBe(true);   // 대조군
  expect(evaluateBreaker({ history: buildHistory({ records: ab, reverts: beforeReset }), thresholds: T2, closedAt: T }).open).toBe(false);

  // T 뒤의 판정 자동 머지 revert 하나는 혼자서 다시 열지 못한다 — 연속은 T에서 다시 시작한다.
  const oneAfter = revertsOf(pickRecords(log, /#11|#12|#13/));
  expect(oneAfter.map((r) => r.pr).sort()).toEqual([11, 12, 13]);
  const abc = new Map([...ab, ["103", mergeRecordText({ issue: 103, pr: 13, kind: "judge", at: "2026-10-02T01:00:00.000Z" })]]);
  expect(evaluateBreaker({ history: buildHistory({ records: abc, reverts: oneAfter }), thresholds: T2, closedAt: T }).open).toBe(false);

  // 두 번째가 다시 연다 — 사유는 T 뒤의 두 PR을 말한다.
  const abcd = new Map([...abc, ["104", mergeRecordText({ issue: 104, pr: 14, kind: "judge", at: "2026-10-02T02:00:00.000Z" })]]);
  const reopened = evaluateBreaker({ history: buildHistory({ records: abcd, reverts: revertsOf(log) }), thresholds: T2, closedAt: T });
  expect(reopened.open).toBe(true);
  expect(reopened.reason).toMatch(/#13\b/);
  expect(reopened.reason).toMatch(/#14\b/);
  expect(reopened.reason).not.toMatch(/#11\b/);
  expect(reopened.since).toBe(iso("2026-10-02T06:00:00Z"));
}, 120000);

// ── dw5 / dw4 공용: bare 원격 + 클론 ──────────────────────────────────────────────────────────────

async function makeRepo() {
  const remote = mkdtempSync(join(tmpdir(), "ktb-189-remote-"));
  await run("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const cwd = mkdtempSync(join(tmpdir(), "ktb-189-clone-"));
  await git(cwd, ["init", "-q", "-b", "main"]);
  writeFileSync(join(cwd, ".gitignore"), "docs/factory/runs/\n");
  await git(cwd, ["add", ".gitignore"]);
  await git(cwd, ["commit", "-q", "-m", "init"], { GIT_AUTHOR_DATE: "2026-09-30T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-30T00:00:00Z" });
  await git(cwd, ["remote", "add", "origin", remote]);
  await git(cwd, ["push", "-q", "origin", "main"]);
  return { remote, cwd };
}
const stateOnBranch = async (remote) => run("git", ["show", `factory/records:${BREAKER_STATE_DIR}/${BREAKER_STATE_FILE}`], { cwd: remote });
const localState = (cwd) => join(cwd, BREAKER_STATE_DIR, BREAKER_STATE_FILE);
/** 상태 파일을 손으로(러너가 아닌 무엇이 쓴 것처럼) 브랜치에 올린다 — 손상·모르는 버전 픽스처용. */
async function pushRawState(cwd, text) {
  const cur = await readRecordsDetailed({ run, cwd, dir: BREAKER_STATE_DIR });
  mkdirSync(join(cwd, BREAKER_STATE_DIR), { recursive: true });
  writeFileSync(localState(cwd), text);
  const r = await syncRecords({ run, cwd, dir: BREAKER_STATE_DIR, message: "raw", overwrite: [BREAKER_STATE_FILE], expectBlob: { [BREAKER_STATE_FILE]: cur.blobs.get("breaker") ?? null } });
  expect(r.ok, r.reason).toBe(true);
}

// ── dw5 ───────────────────────────────────────────────────────────────────────────────────────────

test("test_189_unreadable_breaker_state_is_not_closed", async () => {
  const { remote, cwd } = await makeRepo();
  const read = (over = {}) => readBreaker({ run, cwd, defaultBranch: "main", thresholds: T2, ...over });

  // records 브랜치가 아직 없다(확정) + revert 없는 건강한 history → 닫힘, 오류가 아니다. 센 수가 detail에 남는다.
  const empty = await read();
  expect(empty).toEqual(expect.objectContaining({ ok: true, open: false }));
  expect(empty.detail).toMatch(/0 revert/);

  // 브랜치는 있는데 상태 파일이 없다 → 닫힘.
  mkdirSync(join(cwd, "docs/factory/runs"), { recursive: true });
  writeFileSync(join(cwd, "docs/factory/runs/101.md"), mergeRecordText({ issue: 101, pr: 11, kind: "judge", at: "2026-10-01T01:00:00.000Z" }));
  expect((await syncRecords({ run, cwd, message: "rec 101" })).ok).toBe(true);
  expect(await read()).toEqual(expect.objectContaining({ ok: true, open: false }));

  // 상태 파일은 state/ 아래에 쓰이고, 로컬 체크아웃에는 남지 않으며, 기본 dir 읽기(status·retro·harvest)에는 보이지 않는다.
  const st = await readBreakerState({ run, cwd });
  expect(st).toEqual({ ok: true, state: null, blob: null });
  const w = await writeBreakerState({ run, cwd, blob: st.blob, message: "t", state: { version: 1, open: false, since: null, reason: "x", closed_by: "person:a", closed_at: "2026-10-01T00:00:00.000Z" } });
  expect(w.ok, w.reason).toBe(true);
  expect(existsSync(localState(cwd))).toBe(false);
  expect((await stateOnBranch(remote)).stdout).toContain(BREAKER_STATE_MARKER);
  const def = await readRecordsDetailed({ run, cwd });
  expect([...def.records.keys()].sort()).toEqual(["101"]);
  const inState = await readRecordsDetailed({ run, cwd, dir: BREAKER_STATE_DIR });
  expect([...inState.records.keys()]).toEqual(["breaker"]);
  expect(await read()).toEqual(expect.objectContaining({ ok: true, open: false }));

  // 실제 revert 두 건 + 실제 머지 기록 두 건 → 열림(끝에서 끝까지, 진짜 git).
  writeFileSync(join(cwd, "docs/factory/runs/102.md"), mergeRecordText({ issue: 102, pr: 12, kind: "judge", at: "2026-10-01T02:00:00.000Z" }));
  expect((await syncRecords({ run, cwd, message: "rec 102" })).ok).toBe(true);
  await realLog([
    { subject: "feat a (#11)", at: "2026-10-01T01:00:00Z" },
    { subject: "feat b (#12)", at: "2026-10-01T02:00:00Z" },
    { revert: "feat a (#11)", at: "2026-10-01T05:00:00Z" },
    { raw: 'Revert "feat b (#12)" (#20)', at: "2026-10-01T06:00:00Z" },
  ], cwd);
  await git(cwd, ["push", "-q", "origin", "main"]);
  const opened = await read();
  expect(opened).toEqual(expect.objectContaining({ ok: true, open: true, since: iso("2026-10-01T06:00:00Z") }));
  expect(opened.reason).toMatch(/#11\b.*#12\b/);

  // 손상된 JSON 블록 → ok:false(닫힘이 아니다).
  await pushRawState(cwd, `# Breaker\n\n${BREAKER_STATE_MARKER}\n\`\`\`json\n{ not json\n\`\`\`\n`);
  expect((await read()).ok).toBe(false);
  // 마커가 없는 파일 → ok:false.
  await pushRawState(cwd, "# Breaker\n\nhello\n");
  expect((await read()).ok).toBe(false);
  // 모르는 버전 → ok:false.
  await pushRawState(cwd, renderBreakerState({ version: 2, open: false, since: null, reason: null, closed_by: null, closed_at: null }));
  const v2 = await read();
  expect(v2.ok).toBe(false);
  expect(v2.reason).toMatch(/version/);
  // 알려진 버전으로 되돌리면 다시 읽힌다(위 ok:false가 우연이 아니다).
  await pushRawState(cwd, renderBreakerState({ version: 1, open: false, since: null, reason: null, closed_by: null, closed_at: null }));
  expect((await read()).ok).toBe(true);

  // git log 실패(기본 브랜치가 원격에 없다) → ok:false.
  expect((await read({ defaultBranch: "no-such-branch" })).ok).toBe(false);

  // 한 단계만 실패시키는 run 래퍼 — 나머지는 진짜 git이다. 대조군: 래퍼가 아무것도 실패시키지 않으면 ok:true(위와 같은 상태).
  const calls = [];
  const failOn = (pred) => vi.fn(async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    return cmd === "git" && pred(args) ? { code: 128, stdout: "", stderr: "fatal: simulated failure" } : run(cmd, args, opts);
  });
  expect(await read({ run: failOn(() => false) })).toEqual(expect.objectContaining({ ok: true, open: true }));
  // 차단기의 읽기는 gh를 부르지 않는다(상태·기록·revert 모두 git) — 그래서 dw5의 "gh 읽기 실패"는 이 읽기에 생길 자리가 없다.
  expect(calls.filter(([cmd]) => cmd !== "git")).toEqual([]);
  // fetch는 성공하고 git log만 실패한다 → ok:false(빈 stdout을 "revert 없음 = 닫힘"으로 읽지 않는다).
  const logRun = failOn((a) => a[0] === "log");
  const logFails = await read({ run: logRun });
  expect(logFails).toEqual({ ok: false, reason: expect.stringMatching(/^git log origin\/main failed/) });
  expect(logRun).toHaveBeenCalledWith("git", expect.arrayContaining(["fetch", "+refs/heads/main:refs/remotes/origin/main"]), expect.anything());
  // 브랜치의 상태 파일이 읽히지 않는다(git show 실패 — readRecordsDetailed의 failures) → ok:false.
  const stateUnreadable = await read({ run: failOn((a) => a[0] === "show" && String(a[1]).endsWith(`${BREAKER_STATE_DIR}/${BREAKER_STATE_FILE}`)) });
  expect(stateUnreadable).toEqual({ ok: false, reason: expect.stringMatching(/unreadable state file/) });
  // run 기록 하나가 읽히지 않는다 → ok:false(그 기록이 연속의 한 칸일 수 있다).
  const recordUnreadable = await read({ run: failOn((a) => a[0] === "show" && String(a[1]).endsWith("docs/factory/runs/102.md")) });
  expect(recordUnreadable).toEqual({ ok: false, reason: expect.stringMatching(/unreadable run records: .*102\.md/) });

  // records 브랜치를 가져오지 못했다(fetched:false) → ok:false.
  const lost = mkdtempSync(join(tmpdir(), "ktb-189-lost-"));
  await git(lost, ["init", "-q", "-b", "main"]);
  await git(lost, ["remote", "add", "origin", join(tmpdir(), "ktb-189-does-not-exist")]);
  const unreachable = await readBreaker({ run, cwd: lost, defaultBranch: "main", thresholds: T2 });
  expect(unreachable.ok).toBe(false);
  expect(await readBreakerState({ run, cwd: lost })).toEqual(expect.objectContaining({ ok: false }));
}, 240000);

// ── dw4 ───────────────────────────────────────────────────────────────────────────────────────────

const io = () => {
  const out = [], err = [];
  return { out, err, io: { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) } };
};
/** 사람의 노트북: `gh api user`는 로그인을 말하고 git은 진짜다. */
const personRun = (login = "LeeHyeonKyu", hook = null) => vi.fn(async (cmd, args, opts) => {
  if (cmd === "gh") return login ? { code: 0, stdout: `${login}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "gh: not logged in" };
  if (hook) await hook(cmd, args);
  return run(cmd, args, opts);
});
const NOW = () => Date.parse("2026-10-03T12:00:00.000Z");

test("test_189_breaker_reset_is_person_only_and_recorded", async () => {
  const { remote, cwd } = await makeRepo();
  const argv = ["--reset", "--reason", "reverted twice by mistake — checked"];
  const branchExists = async () => (await run("git", ["ls-remote", "--exit-code", remote, "refs/heads/factory/records"])).code === 0;

  // 에이전트 세션·CI는 거부된다: 0이 아닌 종료, 이유를 말하는 stderr, 아무것도 쓰지 않는다(네트워크 호출 전).
  for (const env of [{ CLAUDE_PROJECT_DIR: "/w" }, { CLAUDECODE: "1" }, { GITHUB_ACTIONS: "true" }]) {
    const r = personRun();
    const o = io();
    const code = await breakerCommand({ root: cwd, argv, io: o.io, run: r, env, now: NOW });
    expect(code, JSON.stringify(env)).not.toBe(0);
    expect(o.err.join("\n"), JSON.stringify(env)).toMatch(/person/i);
    expect(o.err.join("\n"), JSON.stringify(env)).toMatch(/agent session|CI/);
    expect(r, JSON.stringify(env)).not.toHaveBeenCalled();
    expect(await branchExists()).toBe(false);
  }
  // --reason 없음 → 실패, 아무것도 쓰지 않는다.
  for (const bad of [["--reset"], ["--reset", "--reason"], ["--reset", "--reason", "   "]]) {
    const o = io();
    expect(await breakerCommand({ root: cwd, argv: bad, io: o.io, run: personRun(), env: {}, now: NOW }), bad.join(" ")).not.toBe(0);
    expect(o.err.join("\n")).toMatch(/--reason/);
  }
  expect(await branchExists()).toBe(false);
  // 로그인을 알 수 없다 → 실패(익명 리셋 없음).
  const anon = io();
  expect(await breakerCommand({ root: cwd, argv, io: anon.io, run: personRun(null), env: {}, now: NOW })).not.toBe(0);
  expect(anon.err.join("\n")).toMatch(/login/);
  expect(await branchExists()).toBe(false);

  // 열려 있던 상태(스윕이 쓴 워터마크)를 사람이 닫는다. 브랜치에는 run 기록(실제 생산자)도 있다 — 리셋은 그것들을 건드리지 않는다.
  mkdirSync(join(cwd, "docs/factory/runs"), { recursive: true });
  writeFileSync(join(cwd, "docs/factory/runs/101.md"), mergeRecordText({ issue: 101, pr: 11, kind: "judge", at: "2026-10-01T01:00:00.000Z" }));
  writeFileSync(join(cwd, "docs/factory/runs/102.md"), mergeRecordText({ issue: 102, pr: 12, kind: "judge", at: "2026-10-01T02:00:00.000Z" }));
  expect((await syncRecords({ run, cwd, message: "records" })).ok).toBe(true);
  const opened = { version: 1, open: true, since: "2026-10-02T06:00:00.000Z", reason: "revert streak: PR #11, PR #12", closed_by: null, closed_at: null };
  expect((await writeBreakerState({ run, cwd, blob: null, message: "open", state: opened })).ok).toBe(true);
  const tree = async () => new Map((await run("git", ["ls-tree", "-r", "factory/records"], { cwd: remote })).stdout.trim().split("\n").map((l) => { const [meta, path] = l.split("\t"); return [path, meta.split(" ")[2]]; }));
  const tipOf = async () => (await run("git", ["rev-parse", "refs/heads/factory/records"], { cwd: remote })).stdout.trim();
  const treeBefore = await tree();
  const tipBefore = await tipOf();
  const read0 = await readBreakerState({ run, cwd });
  expect(read0.blob).toMatch(/^[0-9a-f]{40}$/);
  const writeState = vi.fn(writeBreakerState);
  const ok = io();
  expect(await breakerCommand({ root: cwd, argv, io: ok.io, run: personRun(), env: {}, now: NOW, writeState })).toBe(0);
  // 쓰기는 상태 파일 하나의 교체이고, 읽은 그 blob에 묶인다(expectBlob = 읽은 blob sha).
  expect(writeState).toHaveBeenCalledTimes(1);
  expect(writeState.mock.calls[0][0]).toEqual(expect.objectContaining({ blob: read0.blob, cwd }));
  const treeAfter = await tree();
  expect([...treeAfter.keys()].sort()).toEqual([...treeBefore.keys()].sort());
  const changed = [...treeAfter.keys()].filter((k) => treeAfter.get(k) !== treeBefore.get(k));
  expect(changed).toEqual([`${BREAKER_STATE_DIR}/${BREAKER_STATE_FILE}`]);
  expect((await run("git", ["diff", "--name-only", tipBefore, await tipOf()], { cwd: remote })).stdout.trim().split("\n")).toEqual([`${BREAKER_STATE_DIR}/${BREAKER_STATE_FILE}`]);
  for (const f of ["101", "102"]) expect((await run("git", ["show", `factory/records:docs/factory/runs/${f}.md`], { cwd: remote })).stdout).toBe(readFileSync(join(cwd, `docs/factory/runs/${f}.md`), "utf8"));
  const after = await readBreakerState({ run, cwd });
  expect(after.ok).toBe(true);
  expect(after.state).toEqual(expect.objectContaining({ open: false, closed_by: "person:LeeHyeonKyu", closed_at: "2026-10-03T12:00:00.000Z", reason: "reverted twice by mistake — checked" }));
  expect(existsSync(localState(cwd))).toBe(false);
  expect(ok.out.join("\n")).toMatch(/person:LeeHyeonKyu/);

  // 그 사이 상태가 움직였으면(동시 쓰기) 아무것도 밀지 않고, 다시 돌리라고 말하며 실패한다.
  const other = mkdtempSync(join(tmpdir(), "ktb-189-other-"));
  await git(other, ["init", "-q", "-b", "main"]);
  await git(other, ["remote", "add", "origin", remote]);
  const concurrent = { ...opened, since: "2026-10-04T00:00:00.000Z", reason: "someone else" };
  let fetches = 0;
  const racing = personRun("LeeHyeonKyu", async (cmd, args) => {
    // 첫 fetch는 리셋이 상태를 읽는 것, 두 번째는 쓰기 직전의 것 — 그 사이에 다른 작성자가 민다.
    if (cmd === "git" && args[0] === "fetch" && ++fetches === 2) {
      const cur = await readBreakerState({ run, cwd: other });
      expect((await writeBreakerState({ run, cwd: other, blob: cur.blob, message: "race", state: concurrent })).ok).toBe(true);
    }
  });
  const raced = io();
  expect(await breakerCommand({ root: cwd, argv, io: raced.io, run: racing, env: {}, now: NOW })).not.toBe(0);
  expect(raced.err.join("\n")).toMatch(/re-run/);
  expect((await readBreakerState({ run, cwd })).state).toEqual(concurrent);
  expect(existsSync(localState(cwd))).toBe(false);
  expect(BREAKER_RESET_COMMAND).toBe("factory breaker --reset --reason <text>");
}, 240000);

// ── rework r2 — cf1: GitHub Revert 버튼 + PR_TITLE squash(안쪽 (#N) 없는 제목) ─────────────────────────────────────────

/**
 * 진짜 git에 GitHub의 Revert 버튼 흐름이 main에 남기는 squash 커밋을 쌓는다. 모양은 vercel/next.js #98715의 실제 텍스트 그대로다:
 * 원래 PR의 squash `<title> (#N)`, revert PR의 squash 제목은 PR 제목 `Revert "<title>"` + ` (#M)`, 본문은 저장소의
 * squash_merge_commit_message 설정에 따라 PR 본문(`Reverts owner/repo#N`)·커밋 메시지(`This reverts commit <sha>.`)·빈 것.
 */
async function revertButtonRepo(cwd, body, { titleDrift = false } = {}) {
  const at = (h) => ({ GIT_AUTHOR_DATE: `2026-10-01T0${h}:00:00Z`, GIT_COMMITTER_DATE: `2026-10-01T0${h}:00:00Z` });
  const commit = async (subject, env, extra = null) => {
    writeFileSync(join(cwd, `${subject.length}-${env.GIT_COMMITTER_DATE}.txt`), subject);
    await git(cwd, ["add", "."]);
    const c = await git(cwd, ["commit", "-q", "-m", subject, ...(extra ? ["-m", extra] : [])], env);
    expect(c.code, c.stderr).toBe(0);
    return (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  };
  const a = await commit("Fix App Router locale path matching with Pages i18n (#11)", at(1));
  // titleDrift: COMMIT_OR_PR_TITLE에서 커밋 하나짜리 PR은 main에 **커밋 메시지**로 들어가고(`fix: b (#12)`), Revert 버튼의 PR 제목은
  // **PR 제목**(`Revert "feat b"`)을 쓴다 — 둘이 다르면 제목으로는 짝을 못 찾고 본문만 남는다.
  const b = await commit(titleDrift ? "fix: b (#12)" : "feat b (#12)", at(2));
  await commit('Revert "Fix App Router locale path matching with Pages i18n" (#20)', at(5), body(a, 11));
  await commit('Revert "feat b" (#21)', at(6), body(b, 12));
}

test("test_189_revert_button_squash_with_pr_title_is_attributed", async () => {
  const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
  for (const [shape, body, opts] of [
    ["PR_BODY", (_sha, n) => `Reverts LeeHyeonKyu/know_thy_build#${n}`, { titleDrift: true }],
    ["COMMIT_MESSAGES", (sha) => `* Revert "x"\n\nThis reverts commit ${sha}.`, { titleDrift: true }],
    ["BLANK", () => null, {}],
  ]) {
    const { cwd } = await makeRepo();
    mkdirSync(join(cwd, "docs/factory/runs"), { recursive: true });
    writeFileSync(join(cwd, "docs/factory/runs/101.md"), mergeRecordText({ issue: 101, pr: 11, kind: "judge", at: "2026-10-01T01:00:00.000Z" }));
    writeFileSync(join(cwd, "docs/factory/runs/102.md"), mergeRecordText({ issue: 102, pr: 12, kind: "judge", at: "2026-10-01T02:00:00.000Z" }));
    expect((await syncRecords({ run, cwd, message: "records" })).ok).toBe(true);
    await revertButtonRepo(cwd, body, opts);
    await git(cwd, ["push", "-q", "origin", "main"]);
    const log = (await git(cwd, ["log", "--format=%s"])).stdout;
    expect(log).toContain('Revert "feat b" (#21)');                      // 안쪽 (#N)이 없는 PR_TITLE 모양 — 제목만으로는 PR을 모른다
    expect(revertedPr('Revert "feat b" (#21)')).toBeNull();

    const r = await readBreaker({ run, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
    expect(r, shape).toEqual(expect.objectContaining({ ok: true, open: true, since: iso("2026-10-01T06:00:00Z") }));
    expect(r.reason, shape).toMatch(/#11\b.*#12\b/);
    expect(r.reason, shape).not.toMatch(/#2[01]\b/);                    // 바깥 (#M)은 revert PR 자신이다
  }

  // 아무 PR에도 묶이지 않는 revert 모양의 커밋은 조용히 사라지지 않는다 — detail이 센다.
  const { cwd } = await makeRepo();
  const env = { GIT_AUTHOR_DATE: "2026-10-01T05:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T05:00:00Z" };
  writeFileSync(join(cwd, "x.txt"), "x");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-q", "-m", 'Revert "something nobody merged" (#30)'], env);
  await git(cwd, ["push", "-q", "origin", "main"]);
  const lone = await readBreaker({ run, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
  expect(lone).toEqual(expect.objectContaining({ ok: true, open: false }));
  expect(lone.detail).toMatch(/1 revert-shaped commit\(s\) not attributable/);
}, 240000);

// ── rework r2 — sec1: 심어진 상태 파일은 차단기를 닫지 못한다 ──────────────────────────────────────────────────────────

/** 판정 경로 자동 머지 #11·#12가 둘 다 revert된 저장소(실제 생산자 + 진짜 git) — 상태 파일이 없으면 열림이다. */
async function openedRepo() {
  const r = await makeRepo();
  mkdirSync(join(r.cwd, "docs/factory/runs"), { recursive: true });
  writeFileSync(join(r.cwd, "docs/factory/runs/101.md"), mergeRecordText({ issue: 101, pr: 11, kind: "judge", at: "2026-10-01T01:00:00.000Z" }));
  writeFileSync(join(r.cwd, "docs/factory/runs/102.md"), mergeRecordText({ issue: 102, pr: 12, kind: "judge", at: "2026-10-01T02:00:00.000Z" }));
  expect((await syncRecords({ run, cwd: r.cwd, message: "records" })).ok).toBe(true);
  await realLog([
    { subject: "feat a (#11)", at: "2026-10-01T01:00:00Z" },
    { subject: "feat b (#12)", at: "2026-10-01T02:00:00Z" },
    { revert: "feat a (#11)", at: "2026-10-01T05:00:00Z" },
    { raw: 'Revert "feat b (#12)" (#20)', at: "2026-10-01T06:00:00Z" },
  ], r.cwd);
  await git(r.cwd, ["push", "-q", "origin", "main"]);
  return r;
}

test("test_189_planted_breaker_state_never_closes_the_breaker", async () => {
  const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
  const { remote, cwd } = await openedRepo();
  const read = () => readBreaker({ run, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
  expect(await read()).toEqual(expect.objectContaining({ ok: true, open: true }));
  const planted = renderBreakerState({ version: 1, open: false, since: null, reason: "x", closed_by: "person:owner", closed_at: "2099-01-01T00:00:00.000Z" });

  // (읽기 쪽) 스테이지 끝의 기본 dir 동기화가 그 파일을 밀어 버렸다(가드가 없던 경로) — 그 상태는 사람의 리셋이 아니다: ok:false.
  mkdirSync(join(cwd, BREAKER_STATE_DIR), { recursive: true });
  writeFileSync(localState(cwd), planted);
  expect((await syncRecords({ run, cwd, message: "run-record: issue #103 implement (gha-9)" })).ok).toBe(true);
  rmSync(join(cwd, BREAKER_STATE_DIR), { recursive: true, force: true });
  expect((await stateOnBranch(remote)).stdout).toContain("2099-01-01");
  const viaStageSync = await read();
  expect(viaStageSync.ok).toBe(false);
  expect(viaStageSync.reason).toMatch(/run-record:/);
  // 그 손상은 사람의 리셋이 덮어쓸 수 있다(corrupt + blob).
  const st = await readBreakerState({ run, cwd });
  expect(st).toEqual(expect.objectContaining({ ok: false, corrupt: true, blob: expect.stringMatching(/^[0-9a-f]{40}$/) }));

  // 러너가 아닌 다른 쓰기라도: 미래의 closed_at은 리셋이 아니다.
  const put = async (state, message = "breaker: reset by person:owner") => {
    const cur = await readRecordsDetailed({ run, cwd, dir: BREAKER_STATE_DIR });
    expect((await writeBreakerState({ run, cwd, blob: cur.blobs.get("breaker") ?? null, message, state })).ok).toBe(true);
  };
  await put({ version: 1, open: false, since: null, reason: "pushed by hand", closed_by: "person:owner", closed_at: "2099-01-01T00:00:00.000Z" });
  const future = await read();
  expect(future.ok).toBe(false);
  expect(future.reason).toMatch(/future/);
  // closed_at이 있는데 닫은 이가 사람이 아니다 → ok:false.
  await put({ version: 1, open: false, since: null, reason: "x", closed_by: "factory:run-7", closed_at: "2026-10-02T00:00:00.000Z" });
  const notPerson = await read();
  expect(notPerson.ok).toBe(false);
  expect(notPerson.reason).toMatch(/person/);
  // 대조군: 사람이 과거 시각에 닫은 상태는 그대로 닫힘이다(위 셋의 ok:false는 우연이 아니다).
  await put({ version: 1, open: false, since: null, reason: "x", closed_by: "person:owner", closed_at: "2026-10-02T00:00:00.000Z" });
  expect(await read()).toEqual(expect.objectContaining({ ok: true, open: false }));

  // (쓰기 쪽) 러너의 스테이지 끝 동기화(run-stage `syncRunRecords` + 가드)는 로컬의 상태 파일을 밀지 않는다.
  const fresh = await openedRepo();
  mkdirSync(join(fresh.cwd, BREAKER_STATE_DIR), { recursive: true });
  writeFileSync(localState(fresh.cwd), planted);
  writeFileSync(join(fresh.cwd, "docs/factory/runs/103.md"), "# Run record — issue #103\n\n## implement · 2026-10-03T00:00:00Z · gha-9\nimplement: ok\n");
  const s = await syncRunRecords({ run, root: fresh.cwd, message: "run-record: issue #103 implement (gha-9)", guard: makeRecordsUploadGuard({ run, cwd: fresh.cwd }) });
  expect(s.ok, s.reason).toBe(true);
  expect(existsSync(localState(fresh.cwd))).toBe(false);
  expect((await stateOnBranch(fresh.remote)).code).not.toBe(0);
  expect((await run("git", ["show", "factory/records:docs/factory/runs/103.md"], { cwd: fresh.remote })).stdout).toContain("implement: ok");
  expect(await readBreaker({ run, cwd: fresh.cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS })).toEqual(expect.objectContaining({ ok: true, open: true }));
}, 240000);

// ── rework r2 — sec2: 위조된 자동 머지 줄은 차단기를 약하게 만들지 못한다 ─────────────────────────────────────────────

const forgedSection = (obj) => `\n## merge · 2020-01-01T00:00:00Z · x\n${selfMergeLine(obj)}\n`;

test("test_189_forged_self_merge_lines_never_weaken_the_breaker", async () => {
  const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
  // 위조 둘: 진짜 판정 머지 #11을 더 이른 비판정 머지로(처음 것이 이기던 자리), 그리고 #11과 #12 사이의 revert 없는 판정 머지 #13.
  const nonJudge11 = forgedSection({ issue: 101, pr: 11, kind: "non_judge", sha: "0".repeat(40), at: "2020-01-01T00:00:00.000Z" });
  const gap13 = forgedSection({ issue: 103, pr: 13, kind: "judge", sha: "1".repeat(40), at: "2026-10-01T01:30:00.000Z" });

  // (읽기 쪽) 가드를 우회해 브랜치에 실린 위조 줄 — 같은 history는 여전히 열림이다.
  const { cwd } = await openedRepo();
  const read = (c = cwd) => readBreaker({ run, cwd: c, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
  writeFileSync(join(cwd, "docs/factory/runs/101.md"), readFileSync(join(cwd, "docs/factory/runs/101.md"), "utf8") + nonJudge11);
  writeFileSync(join(cwd, "docs/factory/runs/103.md"), `# Run record — issue #103\n${gap13}`);
  expect((await syncRecords({ run, cwd, message: "run-record: issue #103 implement (gha-9)" })).ok).toBe(true);
  const forged = await read();
  expect(forged).toEqual(expect.objectContaining({ ok: true, open: true }));
  expect(forged.reason).toMatch(/#11\b.*#12\b/);
  // 대조군: #13이 main에 정말 머지된 PR이면(revert 없음) 그 판정 머지는 연속을 끊는다 — dw1의 규칙은 그대로다.
  await realLog([{ subject: "feat c (#13)", at: "2026-10-01T01:30:00Z" }], cwd);
  await git(cwd, ["push", "-q", "origin", "main"]);
  expect(await read()).toEqual(expect.objectContaining({ ok: true, open: false }));

  // revert된 판정 머지는 main에서 확인되지 않아도(`mainPrs`에 없어도) 센다 — 확인은 "연속을 끊을 자격"에만 걸린다.
  const recs = new Map([
    ["101", mergeRecordText({ issue: 101, pr: 11, kind: "judge", at: "2026-10-01T01:00:00.000Z" })],
    ["102", mergeRecordText({ issue: 102, pr: 12, kind: "judge", at: "2026-10-01T02:00:00.000Z" })],
  ]);
  const revs = revertsOf(await realLog([
    { subject: "feat a (#11)", at: "2026-10-01T01:00:00Z" }, { subject: "feat b (#12)", at: "2026-10-01T02:00:00Z" },
    { revert: "feat a (#11)", at: "2026-10-01T05:00:00Z" }, { revert: "feat b (#12)", at: "2026-10-01T06:00:00Z" },
  ]));
  expect(evaluateBreaker({ history: buildHistory({ records: recs, reverts: revs, mainPrs: new Set() }), thresholds: T2 }).open).toBe(true);

  // (쓰기 쪽) 러너의 스테이지 끝 동기화는 이 런이 쓰지 않았고 브랜치에도 없는 자동 머지 줄을 밀지 않는다 — 자기 기록에도, 남의 기록에도.
  const fresh = await openedRepo();
  const branch101 = (await run("git", ["show", "factory/records:docs/factory/runs/101.md"], { cwd: fresh.remote })).stdout;
  writeFileSync(join(fresh.cwd, "docs/factory/runs/101.md"), branch101 + nonJudge11);
  writeFileSync(join(fresh.cwd, "docs/factory/runs/103.md"), `# Run record — issue #103\n${gap13}\n## implement · 2026-10-03T00:00:00Z · gha-9\nimplement: ok\n`);
  // 이 런(merge 스테이지)이 정말로 쓴 줄은 믿는다.
  const guard = makeRecordsUploadGuard({ run, cwd: fresh.cwd });
  const mine = selfMergeLine({ issue: 104, pr: 14, kind: "judge", sha: "2".repeat(40), at: "2026-10-03T00:00:00.000Z" });
  guard.trust([mine]);
  // 같은 파일에 위조 줄도 섞여 있다 — 믿는 줄은 남고 위조 줄만 빠진다.
  writeFileSync(join(fresh.cwd, "docs/factory/runs/104.md"), `# Run record — issue #104\n${gap13}\n## merge · 2026-10-03T00:00:00Z · gha-1\n${mine}\n`);
  const s = await syncRunRecords({ run, root: fresh.cwd, message: "run-record: issue #103 implement (gha-9)", guard });
  expect(s.ok, s.reason).toBe(true);
  const onBranch = async (n) => (await run("git", ["show", `factory/records:docs/factory/runs/${n}.md`], { cwd: fresh.remote })).stdout;
  expect((await onBranch(101)).startsWith(branch101)).toBe(true);
  expect(await onBranch(101)).not.toContain('"kind":"non_judge"');
  expect(await onBranch(103)).toContain("implement: ok");
  expect(await onBranch(103)).not.toContain("factory-self-merge:");
  expect(await onBranch(104)).toContain(mine);
  expect(await onBranch(104)).not.toContain('"pr":13');
  // 브랜치에 이미 있던 진짜 줄은 손대지 않는다(하이드레이트된 접두어).
  expect(parseSelfMergeLines(await onBranch(101))).toEqual([expect.objectContaining({ pr: 11, kind: "judge" })]);
  expect(await read(fresh.cwd)).toEqual(expect.objectContaining({ ok: true, open: true }));

  // abort 정리 스텝(trust를 모르는 다른 프로세스): 상태 파일은 어느 스테이지든 지우고, 로컬 자동 머지 줄은 **어느 스테이지에서도**
  // 그냥 믿지 않는다 — merge의 워크트리는 PR head 체크아웃(에이전트가 쓴 내용)이다. merge의 abort는 GitHub이 보증하는 줄만 남긴다.
  writeFileSync(join(fresh.cwd, "docs/factory/runs/105.md"), `# Run record — issue #105\n${gap13}`);
  mkdirSync(join(fresh.cwd, BREAKER_STATE_DIR), { recursive: true });
  writeFileSync(localState(fresh.cwd), "x");
  const prView = vi.fn(async (pr) => ({ number: pr, state: "MERGED", headRefName: stageBranch(103), headRefOid: "1".repeat(40) }));
  const asMerge = await makeRecordsUploadGuard({ run, cwd: fresh.cwd }).scrub({ vouch: makeMergeAbortVouch({ issue: 105, headBranch: stageBranch(105), prView }) });
  expect(asMerge.removed).toEqual([`${BREAKER_STATE_DIR}/${BREAKER_STATE_FILE}`]);
  expect(asMerge.dropped.map((x) => x.file)).toEqual(["docs/factory/runs/105.md"]);
  expect(readFileSync(join(fresh.cwd, "docs/factory/runs/105.md"), "utf8")).not.toContain("factory-self-merge:");
  writeFileSync(join(fresh.cwd, "docs/factory/runs/105.md"), `# Run record — issue #105\n${gap13}`);
  const asImplement = await makeRecordsUploadGuard({ run, cwd: fresh.cwd }).scrub();
  expect(asImplement.dropped.map((x) => x.file)).toEqual(["docs/factory/runs/105.md"]);
  expect(readFileSync(join(fresh.cwd, "docs/factory/runs/105.md"), "utf8")).not.toContain("factory-self-merge:");

  // main()의 두 동기화 자리가 가드를 탄다(소스로 고정 — main()은 프로세스를 띄워야만 돈다).
  const src = readFileSync(new URL("../bin/run-stage.js", import.meta.url), "utf8");
  expect(src).toMatch(/runRecord: \(lines\) => \{ recordsGuard\.trust\(lines\);/);
  expect(src).toMatch(/syncRecords: \(\) => syncRunRecords\(\{ run, root, message: `run-record: issue #\$\{issue\} \$\{stage\} \(\$\{runnerId\}\)`, guard: recordsGuard \}\)/);
  expect(src).toMatch(/syncRecords: \(\) => syncRunRecords\(\{ run, root, message: `run-record: issue #\$\{issue\} \$\{stage\} aborted \(\$\{runnerId\}\)`, guard: makeRecordsUploadGuard\(\{ run, cwd: root \}\), vouch: stage === "merge" \? makeMergeAbortVouch\(\{ issue, headBranch: stageBranch\(issue\), prView: \(pr\) => gh\.prView\(pr\) \}\) : null \}\)/);
  expect(src).not.toMatch(/syncRecords: \(\) => syncRecords\(/);
  expect(src).not.toMatch(/trustLocal/);
}, 240000);

// ── self-critique f3 — merge abort의 로컬 줄은 GitHub이 보증할 때만 믿는다(PR head 체크아웃은 에이전트가 쓴 내용이다) ────────

test("test_189_merge_abort_sync_keeps_only_self_merge_lines_github_vouches_for", async () => {
  const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
  const fresh = await openedRepo();
  const HEAD55 = "5".repeat(40);
  // merge 프로세스가 머지 직후 쓰고(실제 생산자 selfMergeLine + appendRunRecord) 동기화 전에 죽었다 — abort가 이 줄을 살려야 한다.
  const real = selfMergeLine({ issue: 105, pr: 55, kind: "judge", sha: HEAD55, at: "2026-10-03T00:00:00.000Z" });
  // PR head가 실어 온(gitignore를 뚫고 force-add한) 위조 줄들 — 각각 보증의 한 조건만 어긴다.
  const otherPr = selfMergeLine({ issue: 105, pr: 13, kind: "judge", sha: "1".repeat(40), at: "2026-10-01T01:30:00.000Z" });   // 다른 이슈 브랜치의 PR
  const wrongSha = selfMergeLine({ issue: 105, pr: 55, kind: "non_judge", sha: "6".repeat(40), at: "2026-10-01T01:30:00.000Z" }); // head가 아니다
  const otherIssue = selfMergeLine({ issue: 104, pr: 55, kind: "judge", sha: HEAD55, at: "2026-10-01T01:30:00.000Z" });           // 이 이슈가 아니다
  const rec105 = readFileSync(appendRunRecord({ root: fresh.cwd, issue: 105, title: "x", stage: "merge", runnerId: "gha-1", now: "2026-10-03T00:00:00.000Z", lines: ["merge: merged 5555555 via PR #55", real, otherPr, wrongSha, otherIssue] }), "utf8");
  expect(rec105).toContain(real);
  // 남의 기록 파일에 실린 같은 줄(issue·pr·sha가 다 맞아도) — 이 abort의 기록이 아니다.
  writeFileSync(join(fresh.cwd, "docs/factory/runs/106.md"), `# Run record — issue #106\n\n## merge · 2026-10-03T00:00:00Z · gha-1\n${real}\n`);
  const facts = new Map([
    [55, { number: 55, state: "MERGED", headRefName: stageBranch(105), headRefOid: HEAD55 }],
    [13, { number: 13, state: "MERGED", headRefName: stageBranch(103), headRefOid: "1".repeat(40) }],
  ]);
  const prView = vi.fn(async (pr) => { if (!facts.has(pr)) throw new Error(`no PR ${pr}`); return facts.get(pr); });
  const vouch = makeMergeAbortVouch({ issue: 105, headBranch: stageBranch(105), prView });
  const s = await syncRunRecords({ run, root: fresh.cwd, message: "run-record: issue #105 merge aborted (gha-1)", guard: makeRecordsUploadGuard({ run, cwd: fresh.cwd }), vouch });
  expect(s.ok, s.reason).toBe(true);
  const onBranch = async (n) => (await run("git", ["show", `factory/records:docs/factory/runs/${n}.md`], { cwd: fresh.remote })).stdout;
  expect(parseSelfMergeLines(await onBranch(105))).toEqual([expect.objectContaining({ issue: 105, pr: 55, kind: "judge", sha: HEAD55 })]);
  expect(await onBranch(105)).toContain("merge: merged 5555555 via PR #55");
  expect(await onBranch(106)).not.toContain("factory-self-merge:");

  // GitHub이 "머지되지 않았다"고 하거나 읽히지 않으면 그 줄은 보증되지 않는다(던지지 않고 빠진다).
  for (const fact of [{ ...facts.get(55), state: "OPEN" }, { ...facts.get(55), headRefName: "feature/x" }, null]) {
    const r = await openedRepo();
    writeFileSync(join(r.cwd, "docs/factory/runs/105.md"), `# Run record — issue #105\n\n## merge · 2026-10-03T00:00:00Z · gha-1\n${real}\n`);
    const v = makeMergeAbortVouch({ issue: 105, headBranch: stageBranch(105), prView: async () => { if (!fact) throw new Error("gh: HTTP 502"); return fact; } });
    const g = await makeRecordsUploadGuard({ run, cwd: r.cwd }).scrub({ vouch: v });
    expect(g.dropped.map((x) => x.line), JSON.stringify(fact)).toEqual([real]);
  }
  // 보증 함수 자신이 던져도 보증이 아니다 — 줄은 빠지고 가드는 끝까지 돈다.
  const thrower = await openedRepo();
  writeFileSync(join(thrower.cwd, "docs/factory/runs/105.md"), `# Run record — issue #105\n\n## merge · 2026-10-03T00:00:00Z · gha-1\n${real}\n`);
  const tg = await makeRecordsUploadGuard({ run, cwd: thrower.cwd }).scrub({ vouch: async () => { throw new Error("boom"); } });
  expect(tg.dropped.map((x) => x.line)).toEqual([real]);

  // 끝에서 끝까지: abort가 살린 진짜 판정 머지 #55(revert 없음, main에 있음)는 #11·#12의 연속을 끊지 않는다(#12 뒤의 머지다) — 열림 그대로.
  expect(await readBreaker({ run, cwd: fresh.cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS })).toEqual(expect.objectContaining({ ok: true, open: true }));
}, 240000);

// ── self-critique f2 — 기본 dir 동기화는 전부 가드를 탄다(retro 포함: retro도 같은 워크트리에서 `claude -p`를 부른다) ───────────

test("test_189_retro_records_sync_never_uploads_planted_breaker_evidence", async () => {
  const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
  const { remote, cwd } = await openedRepo();
  const nonJudge11 = forgedSection({ issue: 101, pr: 11, kind: "non_judge", sha: "0".repeat(40), at: "2020-01-01T00:00:00.000Z" });
  const gap13 = forgedSection({ issue: 103, pr: 13, kind: "judge", sha: "1".repeat(40), at: "2026-10-01T01:30:00.000Z" });
  // retro 세션(에이전트)이 워크트리에 남긴 것들: 심은 상태 파일, 남의 기록에 덧붙인 위조 줄, 새 기록 파일의 위조 줄.
  const branch101 = (await run("git", ["show", "factory/records:docs/factory/runs/101.md"], { cwd: remote })).stdout;
  writeFileSync(join(cwd, "docs/factory/runs/101.md"), branch101 + nonJudge11);
  writeFileSync(join(cwd, "docs/factory/runs/103.md"), `# Run record — issue #103\n${gap13}`);
  mkdirSync(join(cwd, BREAKER_STATE_DIR), { recursive: true });
  writeFileSync(localState(cwd), renderBreakerState({ version: 1, open: false, since: null, reason: "x", closed_by: "person:owner", closed_at: "2026-10-02T00:00:00.000Z" }));
  // retro 자신의 상태 파일(이 동기화의 본래 목적)은 그대로 올라간다.
  writeFileSync(join(cwd, "docs/factory/runs/_retro.md"), "# Retro state\n\nn: 1\n");
  // #13이 main에 정말 머지된 PR이다 — 가드가 없으면 위조 gap13 줄이 연속을 끊는다(dw1 forged 테스트의 대조군과 같은 자리).
  await realLog([{ subject: "feat c (#13)", at: "2026-10-01T01:30:00Z" }], cwd);
  await git(cwd, ["push", "-q", "origin", "main"]);

  const r = await retroRecordsSync({ run, root: cwd, runnerId: "gha-r", expectBlob: { "_retro.md": null } });
  expect(r.ok, r.reason).toBe(true);
  const onBranch = async (n) => run("git", ["show", `factory/records:docs/factory/runs/${n}`], { cwd: remote });
  expect((await onBranch("_retro.md")).stdout).toContain("n: 1");
  expect((await stateOnBranch(remote)).code).not.toBe(0);
  expect((await onBranch("101.md")).stdout.startsWith(branch101)).toBe(true);
  expect(parseSelfMergeLines((await onBranch("101.md")).stdout)).toEqual([expect.objectContaining({ pr: 11, kind: "judge" })]);
  expect((await onBranch("103.md")).stdout).not.toContain("factory-self-merge:");
  expect(existsSync(localState(cwd))).toBe(false);
  expect(await readBreaker({ run, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS })).toEqual(expect.objectContaining({ ok: true, open: true }));

  // 엔진의 모든 기본 dir `syncRecords` 호출은 가드를 거친다 — 남은 직접 호출은 가드 자신(syncRunRecords)과 상태 파일 전용(dir 지정)뿐.
  const { readdirSync } = await import("node:fs");
  const calls = [];
  for (const sub of ["bin", "lib", "cli"]) {
    const base = new URL(`../${sub}/`, import.meta.url);
    for (const e of readdirSync(base, { recursive: true, withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(".js")) continue;
      const rel = join(e.parentPath ?? e.path, e.name);
      for (const line of readFileSync(rel, "utf8").split("\n")) {
        if (/\bsyncRecords\(\{/.test(line) && !/^\s*export async function syncRecords/.test(line)) calls.push(`${rel.split("/factory/").at(-1)}: ${line.trim()}`);
      }
    }
  }
  expect(calls).toEqual([
    expect.stringMatching(/^bin\/run-stage\.js: return syncRecords\(\{ run, cwd: root, message, overwrite, expectBlob \}\);$/),
    expect.stringMatching(/^lib\/breaker\.js: return await syncRecords\(\{ run, cwd, branch, dir: BREAKER_STATE_DIR, /),
  ]);
}, 240000);

// ── rework r3 — sec1: 작성자가 쓴 PR 제목 안의 (#K)는 GitHub이 쓴 본문 증거를 이기지 못한다 ──────────────────────────────────

/**
 * 리뷰 sec1의 재현 그대로: 판정 자동 머지 #303이 `git revert`로 되돌려지고, 작성자가 다음 PR 제목을 `#301: tidy merge gate (#150)`로
 * 써서 main에 `#301: tidy merge gate (#150) (#302)`로 들어간 뒤 사람이 Revert 버튼을 누른다. revert PR의 squash 제목(PR_TITLE)은
 * `Revert "#301: tidy merge gate (#150)" (#304)` — 따옴표 안은 작성자가 쓴 글이다. 본문은 squash_merge_commit_message 설정에 따라
 * `Reverts o/r#302`(PR_BODY)·`This reverts commit <302의 sha>.`(COMMIT_MESSAGES)·빈 것(BLANK, main의 `<T> (#302)`만 남는다).
 * 어느 모양이든 그 revert는 #302의 것이고 차단기는 열려야 한다.
 */
test("test_189_builder_written_pr_ref_in_title_never_misattributes_a_revert", async () => {
  const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
  const TITLE = "#301: tidy merge gate (#150)";                           // 작성자가 고른 PR 제목 — 안에 (#150)이 있다
  for (const [shape, body] of [
    ["PR_BODY", () => "Reverts LeeHyeonKyu/know_thy_build#302"],
    ["COMMIT_MESSAGES", (sha) => `* Revert "${TITLE}"\n\nThis reverts commit ${sha}.`],
    ["BLANK", () => null],
  ]) {
    const { cwd } = await makeRepo();
    mkdirSync(join(cwd, "docs/factory/runs"), { recursive: true });
    writeFileSync(join(cwd, "docs/factory/runs/300.md"), mergeRecordText({ issue: 300, pr: 303, kind: "judge", at: "2026-10-01T01:00:00.000Z" }));
    writeFileSync(join(cwd, "docs/factory/runs/301.md"), mergeRecordText({ issue: 301, pr: 302, kind: "judge", at: "2026-10-01T02:00:00.000Z" }));
    expect((await syncRecords({ run, cwd, message: "records" })).ok).toBe(true);
    const at = (h) => ({ GIT_AUTHOR_DATE: `2026-10-01T0${h}:00:00Z`, GIT_COMMITTER_DATE: `2026-10-01T0${h}:00:00Z` });
    const commit = async (subject, env, extra = null) => {
      writeFileSync(join(cwd, `c-${env.GIT_COMMITTER_DATE}.txt`), subject);
      await git(cwd, ["add", "."]);
      const c = await git(cwd, ["commit", "-q", "-m", subject, ...(extra ? ["-m", extra] : [])], env);
      expect(c.code, c.stderr).toBe(0);
      return (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
    };
    const a = await commit("#300: harden x (#303)", at(1));
    const b = await commit(`${TITLE} (#302)`, at(2));
    const rv = await git(cwd, ["revert", "--no-edit", a], at(5));
    expect(rv.code, rv.stderr).toBe(0);
    await commit(`Revert "${TITLE}" (#304)`, at(6), body(b));
    await git(cwd, ["push", "-q", "origin", "main"]);

    const log = (await git(cwd, ["log", `--format=${REVERT_LOG_FORMAT}`])).stdout;
    const parsed = parseRevertCommits(log);
    expect(parsed.reverts.map((r) => r.pr).sort(), shape).toEqual([302, 303]);
    expect(parsed.reverts.map((r) => r.pr), shape).not.toContain(150);   // 작성자가 쓴 (#150)은 PR 증거가 아니다

    const r = await readBreaker({ run, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
    expect(r, shape).toEqual(expect.objectContaining({ ok: true, open: true, since: iso("2026-10-01T06:00:00Z") }));
    expect(r.reason, shape).toMatch(/#302\b/);
    expect(r.reason, shape).toMatch(/#303\b/);
    expect(r.reason, shape).not.toMatch(/#150\b/);
  }
}, 240000);

// ── rework r3 self-critique — 작성자가 쓴 글만 남은 revert는 한 PR을 조용히 고르지 않는다 ─────────────────────────────────

/**
 * 진짜 git 저장소에 main 히스토리를 쌓는 작은 도우미. `file`에 `content`를 써서 커밋하므로 revert가 실제로 그 변경을 되돌린다
 * (Revert 버튼의 squash가 main에 남기는 트리 그대로). `revertOf`를 주면 그 커밋을 `git revert --no-commit`으로 되돌린 트리를
 * 주어진 제목·본문으로 커밋한다 — GitHub이 revert PR을 squash 머지할 때의 모양이다.
 */
async function mainHistory(cwd) {
  const at = (h) => ({ GIT_AUTHOR_DATE: `2026-10-01T${String(h).padStart(2, "0")}:00:00Z`, GIT_COMMITTER_DATE: `2026-10-01T${String(h).padStart(2, "0")}:00:00Z` });
  const sha = async () => (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  return {
    commit: async (subject, h, { file, content }) => {
      writeFileSync(join(cwd, file), content);
      await git(cwd, ["add", "."]);
      const c = await git(cwd, ["commit", "-q", "-m", subject], at(h));
      expect(c.code, c.stderr).toBe(0);
      return sha();
    },
    revertAs: async (target, subject, h, body = null) => {
      const r = await git(cwd, ["revert", "--no-commit", target], at(h));
      expect(r.code, r.stderr).toBe(0);
      const c = await git(cwd, ["commit", "-q", "-m", subject, ...(body ? ["-m", body] : [])], at(h));
      expect(c.code, c.stderr).toBe(0);
      return sha();
    },
    gitRevert: async (target, h) => {
      const r = await git(cwd, ["revert", "--no-edit", target], at(h));
      expect(r.code, r.stderr).toBe(0);
      return sha();
    },
  };
}

async function judgeRecords(cwd, merges) {
  mkdirSync(join(cwd, "docs/factory/runs"), { recursive: true });
  for (const { issue, pr, at, kind = "judge" } of merges) {
    writeFileSync(join(cwd, `docs/factory/runs/${issue}.md`), mergeRecordText({ issue, pr, kind, at }));
  }
  expect((await syncRecords({ run, cwd, message: "records" })).ok).toBe(true);
}

/**
 * skeptic 1 — 작성자가 main에 이미 있는 제목을 PR 제목으로 다시 쓰면(`#301: tidy merge gate (#150)`이 옛 커밋의 제목 그대로),
 * BLANK squash의 Revert 버튼 revert는 정확히-같은-제목 조회로 옛 #150에 붙어 #302의 revert가 사라졌다.
 * skeptic 2a — 나중 PR이 앞선 판정 PR의 제목을 다시 쓰면 last-wins 제목 맵이 앞선 PR의 revert를 나중 PR에 붙였다.
 * 둘 다 작성자의 글만으로 PR을 고른 것이다 — 그런 revert는 **후보 모두**에 센다(넘치게 세는 쪽은 사람이 리셋하면 되지만,
 * 덜 세는 쪽은 차단기를 닫힌 채로 둔다 — plan open_risks: "miscounted (it blocks without need)"는 받아들인 위험이다).
 */
test("test_189_title_collision_revert_counts_every_candidate_pr", async () => {
  const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
  const TITLE = "#301: tidy merge gate (#150)";

  // (1) 정확히-같은-제목 충돌: 옛 커밋의 제목이 작성자의 PR 제목과 똑같다.
  {
    const { cwd } = await makeRepo();
    await judgeRecords(cwd, [
      { issue: 300, pr: 303, at: "2026-10-01T02:00:00.000Z" },
      { issue: 301, pr: 302, at: "2026-10-01T03:00:00.000Z" },
    ]);
    const h = await mainHistory(cwd);
    await h.commit(TITLE, 1, { file: "old.txt", content: "old\n" });            // 옛 #150의 `git revert` 모양 제목 그대로
    const a = await h.commit("#300: harden x (#303)", 2, { file: "a.txt", content: "a\n" });
    const b = await h.commit(`${TITLE} (#302)`, 3, { file: "b.txt", content: "b\n" });
    await h.gitRevert(a, 5);
    await h.revertAs(b, `Revert "${TITLE}" (#304)`, 6);                         // BLANK — 본문이 없다
    await git(cwd, ["push", "-q", "origin", "main"]);

    const parsed = parseRevertCommits((await git(cwd, ["log", `--format=${REVERT_LOG_FORMAT}`])).stdout);
    expect(parsed.reverts.map((r) => r.pr)).toContain(302);
    expect(parsed.reverts.map((r) => r.pr)).toContain(303);
    const r = await readBreaker({ run, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
    expect(r).toEqual(expect.objectContaining({ ok: true, open: true, since: iso("2026-10-01T06:00:00Z") }));
    expect(r.reason).toMatch(/#303\b.*#302\b|#302\b.*#303\b/);
  }

  // (2) 중복 PR 제목: 나중 PR #405가 앞선 판정 PR #402의 제목을 다시 쓴다. #402의 BLANK revert는 #402에도 센다.
  {
    const { cwd } = await makeRepo();
    await judgeRecords(cwd, [
      { issue: 400, pr: 401, at: "2026-10-01T01:00:00.000Z" },
      { issue: 402, pr: 402, at: "2026-10-01T02:00:00.000Z" },
      { issue: 405, pr: 405, at: "2026-10-01T03:00:00.000Z", kind: "non_judge" },
    ]);
    const h = await mainHistory(cwd);
    const a = await h.commit("feat: first (#401)", 1, { file: "a.txt", content: "a\n" });
    const b = await h.commit("feat: shared title (#402)", 2, { file: "b.txt", content: "b\n" });
    await h.commit("feat: shared title (#405)", 3, { file: "c.txt", content: "c\n" });
    await h.gitRevert(a, 5);
    await h.revertAs(b, 'Revert "feat: shared title" (#406)', 6);
    await git(cwd, ["push", "-q", "origin", "main"]);

    const parsed = parseRevertCommits((await git(cwd, ["log", `--format=${REVERT_LOG_FORMAT}`])).stdout);
    expect(parsed.reverts.map((r) => r.pr)).toContain(402);
    const r = await readBreaker({ run, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
    expect(r).toEqual(expect.objectContaining({ ok: true, open: true, since: iso("2026-10-01T06:00:00Z") }));
    expect(r.reason).toMatch(/#401\b.*#402\b/);
  }
}, 240000);

/**
 * skeptic 2b — COMMIT_OR_PR_TITLE의 커밋 하나짜리 PR은 main에 **커밋 메시지**(`fix: tidy gate (#302)`)로 들어가고, Revert 버튼은
 * **PR 제목**(`#301: x (#150)`)을 따옴표 안에 쓴다. 본문이 BLANK면 main 제목과도 짝이 없고 남는 것은 작성자의 (#150)뿐이다.
 * 그때 차단기는 git이 쓴 증거를 본다: 그 revert의 diff가 main의 어느 판정 자동 머지 squash 커밋을 정확히 되돌리는가.
 * 반대쪽도 못 박는다: diff가 어느 판정 머지와도 맞지 않는 revert(무관한 파일을 되돌린 것)는 판정 머지에 붙지 않는다.
 */
test("test_189_title_drift_blank_revert_is_attributed_by_the_reverted_diff", async () => {
  const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
  for (const [shape, subject] of [
    ["inner ref in the builder's title", 'Revert "#301: x (#150)" (#304)'],
    ["no ref at all (r2 titleDrift + BLANK)", 'Revert "#301: tidy the gate" (#304)'],
  ]) {
    const { cwd } = await makeRepo();
    await judgeRecords(cwd, [
      { issue: 300, pr: 303, at: "2026-10-01T02:00:00.000Z" },
      { issue: 301, pr: 302, at: "2026-10-01T03:00:00.000Z" },
    ]);
    const h = await mainHistory(cwd);
    await h.commit("chore: unrelated (#150)", 1, { file: "old.txt", content: "old\n" });
    const a = await h.commit("#300: harden x (#303)", 2, { file: "a.txt", content: "a\n" });
    const b = await h.commit("fix: tidy gate (#302)", 3, { file: "b.txt", content: "b\nmore\n" });
    await h.gitRevert(a, 5);
    await h.revertAs(b, subject, 6);
    await git(cwd, ["push", "-q", "origin", "main"]);

    const r = await readBreaker({ run, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
    expect(r, shape).toEqual(expect.objectContaining({ ok: true, open: true, since: iso("2026-10-01T06:00:00Z") }));
    expect(r.reason, shape).toMatch(/#303\b.*#302\b|#302\b.*#303\b/);
    expect(r.detail, shape).not.toMatch(/not attributable/);              // diff로 묶인 revert는 "못 묶음"으로 보고되지 않는다
  }

  // 반대쪽: 작성자의 글만 있고 diff가 판정 머지 어느 것과도 맞지 않는 revert는 판정 머지를 지어내지 않는다.
  const { cwd } = await makeRepo();
  await judgeRecords(cwd, [
    { issue: 300, pr: 303, at: "2026-10-01T02:00:00.000Z" },
    { issue: 301, pr: 302, at: "2026-10-01T03:00:00.000Z" },
  ]);
  const h = await mainHistory(cwd);
  const o = await h.commit("chore: unrelated (#150)", 1, { file: "old.txt", content: "old\n" });
  const a = await h.commit("#300: harden x (#303)", 2, { file: "a.txt", content: "a\n" });
  await h.commit("fix: tidy gate (#302)", 3, { file: "b.txt", content: "b\nmore\n" });
  await h.gitRevert(a, 5);
  await h.revertAs(o, 'Revert "#301: x" (#304)', 6);                           // #150의 파일을 되돌렸다 — #302가 아니다
  await git(cwd, ["push", "-q", "origin", "main"]);
  const r = await readBreaker({ run, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
  expect(r).toEqual(expect.objectContaining({ ok: true, open: false }));
}, 240000);

/**
 * skeptic 2b의 반대쪽 경계 — diff 짝은 **그 revert보다 앞서 머지된** 판정 머지만 본다. revert 뒤에 같은 변경을 다시 올린 판정 PR(#305,
 * 재상륙)은 그 revert의 대상이 아니다: #302(revert) · #305(revert 없음) · #306(revert)이면 #305가 연속을 끊어 차단기는 닫혀 있다.
 */
test("test_189_diff_attribution_never_credits_a_merge_landed_after_the_revert", async () => {
  const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
  const { cwd } = await makeRepo();
  await judgeRecords(cwd, [
    { issue: 301, pr: 302, at: "2026-10-01T03:00:00.000Z" },
    { issue: 304, pr: 305, at: "2026-10-01T07:00:00.000Z" },
    { issue: 306, pr: 306, at: "2026-10-01T08:00:00.000Z" },
  ]);
  const h = await mainHistory(cwd);
  const b = await h.commit("fix: tidy gate (#302)", 3, { file: "b.txt", content: "b\nmore\n" });
  await h.revertAs(b, 'Revert "#301: tidy the gate" (#303)', 6);                // BLANK, 제목 짝 없음 — diff로만 #302에 묶인다
  await h.commit("fix: tidy gate again (#305)", 7, { file: "b.txt", content: "b\nmore\n" });  // 같은 변경의 재상륙
  const d = await h.commit("feat: d (#306)", 8, { file: "d.txt", content: "d\n" });
  await h.gitRevert(d, 9);
  await git(cwd, ["push", "-q", "origin", "main"]);
  const r = await readBreaker({ run, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
  expect(r).toEqual(expect.objectContaining({ ok: true, open: false }));
  expect(r.detail).toMatch(/3 self-merge record\(s\) \(3 judge\), 2 revert\(s\)/);
}, 240000);

/**
 * diff 짝의 정규화 경계 — revert와 대상 사이에 같은 파일의 다른 곳을 바꾼 커밋이 있으면 blob sha(`index` 줄)와 hunk 줄 번호가
 * 달라진다. 그래도 같은 변경이므로 짝이다. 그리고 빈 diff끼리는 짝이 아니다(빈 revert가 빈 판정 머지를 지어내지 않는다).
 */
test("test_189_diff_attribution_survives_intervening_edits_and_ignores_empty_diffs", async () => {
  const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const { cwd } = await makeRepo();
  await judgeRecords(cwd, [
    { issue: 300, pr: 303, at: "2026-10-01T02:00:00.000Z" },
    { issue: 301, pr: 302, at: "2026-10-01T03:00:00.000Z" },
  ]);
  const h = await mainHistory(cwd);
  await h.commit("chore: seed (#100)", 1, { file: "shared.txt", content: `${lines.join("\n")}\n` });
  const a = await h.commit("#300: harden x (#303)", 2, { file: "a.txt", content: "a\n" });
  const changed = lines.map((l, i) => (i === 24 ? "line 25 tidied" : l));
  const b = await h.commit("fix: tidy gate (#302)", 3, { file: "shared.txt", content: `${changed.join("\n")}\n` });
  const shifted = [...changed.slice(0, 5), "inserted 1", "inserted 2", "inserted 3", ...changed.slice(5)];
  await h.commit("docs: unrelated edit (#160)", 4, { file: "shared.txt", content: `${shifted.join("\n")}\n` });
  await h.gitRevert(a, 5);
  await h.revertAs(b, 'Revert "#301: x (#150)" (#304)', 6);
  await git(cwd, ["push", "-q", "origin", "main"]);
  const r = await readBreaker({ run, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
  expect(r).toEqual(expect.objectContaining({ ok: true, open: true, since: iso("2026-10-01T06:00:00Z") }));
  expect(r.reason).toMatch(/#303\b.*#302\b/);

  // 빈 diff: 판정 머지 #312가 빈 squash 커밋이고, 작성자의 글만 있는 빈 revert가 뒤따른다 — 짝이 아니다.
  const e = await makeRepo();
  await judgeRecords(e.cwd, [
    { issue: 310, pr: 311, at: "2026-10-01T02:00:00.000Z" },
    { issue: 312, pr: 312, at: "2026-10-01T03:00:00.000Z" },
  ]);
  const he = await mainHistory(e.cwd);
  const ea = await he.commit("feat: e (#311)", 2, { file: "e.txt", content: "e\n" });
  const empty = (subject, hh) => git(e.cwd, ["commit", "-q", "--allow-empty", "-m", subject], { GIT_AUTHOR_DATE: `2026-10-01T0${hh}:00:00Z`, GIT_COMMITTER_DATE: `2026-10-01T0${hh}:00:00Z` });
  expect((await empty("chore: empty (#312)", 3)).code).toBe(0);
  await he.gitRevert(ea, 5);
  expect((await empty('Revert "#312: nothing" (#313)', 6)).code).toBe(0);
  await git(e.cwd, ["push", "-q", "origin", "main"]);
  const re = await readBreaker({ run, cwd: e.cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
  expect(re).toEqual(expect.objectContaining({ ok: true, open: false }));
}, 240000);

/**
 * diff 짝의 어댑터 경계 — (1) `git show`가 실패하면 그 revert의 대상은 모르는 것이고, 모르는 것은 닫힘이 아니다(ok:false).
 * (2) 사람의 리셋(closed_at) 앞의 revert는 어차피 세지 않으므로 diff를 읽지도 않는다(merge 스테이지가 체크마다 부르는 읽기의 비용 경계).
 */
test("test_189_diff_attribution_failure_is_not_closed_and_skips_reverts_before_the_reset", async () => {
  const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
  const { cwd } = await makeRepo();
  await judgeRecords(cwd, [
    { issue: 300, pr: 303, at: "2026-10-01T02:00:00.000Z" },
    { issue: 301, pr: 302, at: "2026-10-01T03:00:00.000Z" },
  ]);
  const h = await mainHistory(cwd);
  const a = await h.commit("#300: harden x (#303)", 2, { file: "a.txt", content: "a\n" });
  const b = await h.commit("fix: tidy gate (#302)", 3, { file: "b.txt", content: "b\n" });
  await h.gitRevert(a, 5);
  await h.revertAs(b, 'Revert "#301: x (#150)" (#304)', 6);
  await git(cwd, ["push", "-q", "origin", "main"]);

  const shows = [];
  const failingShow = async (cmd, args, opts) => {
    if (cmd === "git" && args[0] === "show" && args.includes("--no-prefix")) { shows.push(args.at(-1)); return { code: 128, stdout: "", stderr: "fatal: bad object" }; }
    return run(cmd, args, opts);
  };
  const broken = await readBreaker({ run: failingShow, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
  expect(broken.ok).toBe(false);
  expect(broken.reason).toMatch(/git show .* failed/);
  expect(shows.length).toBeGreaterThan(0);

  // 리셋이 두 revert 뒤에 있다 → 닫힘이고, diff는 한 번도 읽지 않는다(실패하는 git show가 있어도 ok:true).
  const st = await readBreakerState({ run, cwd });
  expect((await writeBreakerState({ run, cwd, blob: st.blob, message: "reset", state: { version: 1, open: false, since: null, reason: "checked", closed_by: "person:a", closed_at: "2026-10-02T00:00:00.000Z" } })).ok).toBe(true);
  shows.length = 0;
  const after = await readBreaker({ run: failingShow, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
  expect(after).toEqual(expect.objectContaining({ ok: true, open: false }));
  expect(shows).toEqual([]);
}, 240000);

// ── #189 skeptic f2 — 상태는 읽혔는데 run 기록이 안 읽혔다(fetched:false) → ok:false, 빈 history의 "닫힘"이 아니다 ───────────────

test("test_189_records_unreadable_after_state_read_is_not_closed", async () => {
  const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
  const { cwd } = await openedRepo();
  const read = (r) => readBreaker({ run: r, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
  const isRecordsFetch = (a) => a[0] === "fetch" && a.some((x) => String(x).startsWith("refs/heads/factory/records:"));
  const isRecordsProbe = (a) => a[0] === "ls-remote" && a.includes("refs/heads/factory/records");
  /** 첫 records 읽기(상태 파일)는 진짜로 성공시키고, 그 뒤의 records 읽기에서만 `pred`가 고른 git 호출을 실패시킨다. */
  const secondReadFails = (pred) => {
    let fetches = 0;
    const seen = [];
    const fn = vi.fn(async (cmd, args, opts) => {
      if (cmd === "git" && isRecordsFetch(args)) fetches += 1;
      if (cmd === "git" && fetches >= 2 && pred(args)) { seen.push(args[0]); return { code: 128, stdout: "", stderr: "fatal: simulated transient failure" }; }
      return run(cmd, args, opts);
    });
    return { fn, seen, fetches: () => fetches };
  };

  // 대조군: 아무것도 실패시키지 않으면 열림(두 번의 records fetch — 상태, 기록).
  const ctl = secondReadFails(() => false);
  expect(await read(ctl.fn)).toEqual(expect.objectContaining({ ok: true, open: true }));
  expect(ctl.fetches()).toBe(2);

  // (a) 두 번째 fetch와 존재 확인이 모두 실패 → readRecordsDetailed는 fetched:false + 빈 Map. 그 빈 Map을 "자동 머지 없음 = 닫힘"으로 읽지 않는다.
  const a = secondReadFails((args) => isRecordsFetch(args) || isRecordsProbe(args));
  const ra = await read(a.fn);
  expect(a.seen).toEqual(["fetch", "ls-remote"]);
  expect(ra).toEqual({ ok: false, reason: expect.stringMatching(/factory\/records could not be fetched — the factory's auto-merge records are unknown/) });

  // (b) 두 번째 fetch는 됐는데 ls-tree가 실패 → 역시 fetched:false → ok:false.
  const b = secondReadFails((args) => args[0] === "ls-tree");
  const rb = await read(b.fn);
  expect(b.seen).toEqual(["ls-tree"]);
  expect(rb).toEqual({ ok: false, reason: expect.stringMatching(/auto-merge records are unknown/) });
}, 240000);

// ── #189 skeptic f3 — 판정이 이긴다: 위조된 비판정 줄이 **먼저 읽히는 파일**에 있어도 판정 머지를 연속에서 빼지 못한다 ──────────────

test("test_189_forged_non_judge_line_read_first_never_demotes_a_judge_merge", async () => {
  const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
  const forgedNonJudge11 = `# Run record — issue #100\n${forgedSection({ issue: 100, pr: 11, kind: "non_judge", sha: "0".repeat(40), at: "2020-01-01T00:00:00.000Z" })}`;
  const real101 = mergeRecordText({ issue: 101, pr: 11, kind: "judge", at: "2026-10-01T01:00:00.000Z" });
  const real102 = mergeRecordText({ issue: 102, pr: 12, kind: "judge", at: "2026-10-01T02:00:00.000Z" });
  const reverts = revertsOf(await realLog([
    { subject: "feat a (#11)", at: "2026-10-01T01:00:00Z" }, { subject: "feat b (#12)", at: "2026-10-01T02:00:00Z" },
    { revert: "feat a (#11)", at: "2026-10-01T05:00:00Z" }, { raw: 'Revert "feat b (#12)" (#20)', at: "2026-10-01T06:00:00Z" },
  ]));

  // 순수: 위조 줄이 먼저 읽히는 순서(100 → 101 → 102). 그래도 #11은 판정 머지이고 연속은 열린다.
  const ordered = new Map([["100", forgedNonJudge11], ["101", real101], ["102", real102]]);
  expect([...ordered.keys()]).toEqual(["100", "101", "102"]);
  const h = buildHistory({ records: ordered, reverts });
  expect(h.filter((e) => e.kind === "auto-merge" && e.pr === 11)).toEqual([expect.objectContaining({ judge: true, issue: 101 })]);
  const ev = evaluateBreaker({ history: h, thresholds: T2 });
  expect(ev.open).toBe(true);
  expect(ev.reason).toMatch(/#11\b.*#12\b/);

  // 끝에서 끝까지: 브랜치의 100.md(ls-tree 순서로 101.md보다 먼저)에 실린 위조 줄 — readBreaker는 여전히 열림.
  const { cwd } = await openedRepo();
  writeFileSync(join(cwd, "docs/factory/runs/100.md"), forgedNonJudge11);
  expect((await syncRecords({ run, cwd, message: "run-record: issue #100 implement (gha-9)" })).ok).toBe(true);
  const det = await readRecordsDetailed({ run, cwd });
  expect([...det.records.keys()].slice(0, 2)).toEqual(["100", "101"]);
  const r = await readBreaker({ run, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
  expect(r).toEqual(expect.objectContaining({ ok: true, open: true }));
  expect(r.reason).toMatch(/#11\b.*#12\b/);
}, 240000);

// ── #189 skeptic f4 — merge 섹션 밖의 자동 머지 줄은 자동 머지가 아니다 ──────────────────────────────────────────────────────

test("test_189_self_merge_line_outside_merge_section_is_not_an_automerge", async () => {
  // 실제 생산자로 같은 줄을 두 스테이지에 쓴다: merge 섹션(진짜)과 implement 섹션(사유 문구 등 아무 텍스트나 실리는 자리).
  const line13 = selfMergeLine({ issue: 103, pr: 13, kind: "judge", sha: "1".repeat(40), at: "2026-10-01T01:30:00.000Z" });
  const write = (stage, extra = []) => {
    const root = mkdtempSync(join(tmpdir(), "ktb-189-sec-"));
    return readFileSync(appendRunRecord({ root, issue: 103, title: "x", stage, runnerId: "gha-1", now: "2026-10-01T01:30:00.000Z", lines: [...extra, line13] }), "utf8");
  };
  const inMerge = write("merge", ["merge: merged 1111111 via PR #13"]);
  const inImplement = write("implement", ["implement: ok"]);
  expect(inImplement).toMatch(/^## implement /m);
  expect(inImplement).toContain(line13);
  expect(parseSelfMergeLines(inMerge)).toEqual([expect.objectContaining({ pr: 13, judge: true })]);
  expect(parseSelfMergeLines(inImplement)).toEqual([]);
  // 섹션 헤더 앞(파일 머리)의 줄도, merge 섹션 뒤에 다른 섹션이 열린 다음의 줄도 세지 않는다.
  expect(parseSelfMergeLines(`${line13}\n`)).toEqual([]);
  expect(parseSelfMergeLines(`${inMerge}\n## review · 2026-10-01T01:31:00Z · gha-1\n${selfMergeLine({ issue: 104, pr: 14, kind: "judge", at: "2026-10-01T01:31:00.000Z" })}\n`).map((m) => m.pr)).toEqual([13]);

  // 판정에 미치는 효과: #13은 main에 정말 머지됐고 revert되지 않았다. 그 줄이 merge 섹션에 있으면 #11·#12 사이의 연속을 끊고(닫힘),
  // implement 섹션에 있으면 아무것도 아니다(열림).
  const parsed = parseRevertCommits(await realLog([
    { subject: "feat a (#11)", at: "2026-10-01T01:00:00Z" }, { subject: "feat c (#13)", at: "2026-10-01T01:30:00Z" },
    { subject: "feat b (#12)", at: "2026-10-01T02:00:00Z" },
    { revert: "feat a (#11)", at: "2026-10-01T05:00:00Z" }, { revert: "feat b (#12)", at: "2026-10-01T06:00:00Z" },
  ]));
  expect(parsed.mainPrs.has(13)).toBe(true);
  const base = [
    ["101", mergeRecordText({ issue: 101, pr: 11, kind: "judge", at: "2026-10-01T01:00:00.000Z" })],
    ["102", mergeRecordText({ issue: 102, pr: 12, kind: "judge", at: "2026-10-01T02:00:00.000Z" })],
  ];
  const evalWith = (t103) => evaluateBreaker({ history: buildHistory({ records: new Map([...base, ["103", t103]]), reverts: parsed.reverts, mainPrs: parsed.mainPrs }), thresholds: T2 });
  expect(evalWith(inMerge).open).toBe(false);                      // 대조군: 진짜 merge 섹션의 줄은 연속을 끊는다
  const forged = evalWith(inImplement);
  expect(forged.open).toBe(true);
  expect(forged.reason).toMatch(/#11\b.*#12\b/);
}, 120000);

// ── rework r5 cf1 — 스테이지 끝 동기화를 잃어도 판정 자동 머지는 차단기의 증거에서 사라지지 않는다 ─────────────────────────────
import { persistSelfMergeEvidence } from "../lib/breaker.js";

test("test_189_lost_stage_end_sync_never_hides_a_judge_automerge_from_the_breaker", async () => {
  const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
  const { remote, cwd } = await makeRepo();
  const runsDir = join(cwd, "docs/factory/runs");
  const failPush = async (cmd, args, o) => (cmd === "git" && args.includes("push") ? { code: 1, stdout: "", stderr: "fatal: unable to access 'https://github.com/x/y/': The requested URL returned error: 503" } : run(cmd, args, o));
  const onBranch = async (n) => (await run("git", ["show", `factory/records:docs/factory/runs/${n}.md`], { cwd: remote }));

  // 두 merge 런(#11, #12). 각 런은 merge 스테이지가 하듯 줄을 run 기록에 쓰고(실제 생산자 selfMergeLine + appendRunRecord, 가드가 trust),
  // 머지 **전에** 프로덕션 persist로 factory/records에 올린다. #12의 런은 그 뒤 스테이지 끝 동기화가 실패하고, 러너가 사라진다(로컬 기록도 함께).
  for (const { issue, pr, at, stageEndFails } of [
    { issue: 101, pr: 11, at: "2026-10-01T01:00:00.000Z", stageEndFails: false },
    { issue: 102, pr: 12, at: "2026-10-01T02:00:00.000Z", stageEndFails: true },
  ]) {
    const guard = makeRecordsUploadGuard({ run, cwd });
    const line = selfMergeLine({ issue, pr, kind: "judge", sha: String(pr % 10).repeat(40), at });
    guard.trust([line]);
    appendRunRecord({ root: cwd, issue, title: "x", stage: "merge", runnerId: `gha-${pr}`, now: at, lines: [line] });
    const p = await persistSelfMergeEvidence({ run, cwd, issue, line, sync: () => syncRunRecords({ run, root: cwd, message: `run-record: issue #${issue} merge self-merge evidence (gha-${pr})`, guard }) });
    expect(p, `#${pr}`).toEqual(expect.objectContaining({ ok: true }));
    appendRunRecord({ root: cwd, issue, title: "x", stage: "merge", runnerId: `gha-${pr}`, now: at, lines: [`merge: merged via PR #${pr}`] });
    const end = await syncRunRecords({ run: stageEndFails ? failPush : run, root: cwd, message: `run-record: issue #${issue} merge (gha-${pr})`, guard });
    expect(end.ok, `#${pr} stage-end sync`).toBe(!stageEndFails);
    rmSync(runsDir, { recursive: true, force: true });             // 일회용 러너 — 올라가지 못한 것은 사라진다
  }
  // 스테이지 끝의 줄(#12의 "merged via")은 잃었지만, 자동 머지의 증거는 머지 전에 이미 브랜치에 있었다.
  expect((await onBranch(102)).stdout).not.toContain("merge: merged via PR #12");
  expect(parseSelfMergeLines((await onBranch(102)).stdout)).toEqual([expect.objectContaining({ issue: 102, pr: 12, judge: true })]);
  expect(parseSelfMergeLines((await onBranch(101)).stdout)).toEqual([expect.objectContaining({ issue: 101, pr: 11, judge: true })]);

  // 그 두 판정 머지가 main에서 연속으로 revert된다 → 열린다(리뷰어의 재현: 이전에는 {ok:true, open:false}였다).
  await realLog([
    { subject: "feat a (#11)", at: "2026-10-01T01:00:00Z" },
    { subject: "feat b (#12)", at: "2026-10-01T02:00:00Z" },
    { revert: "feat a (#11)", at: "2026-10-01T05:00:00Z" },
    { revert: "feat b (#12)", at: "2026-10-01T06:00:00Z" },
  ], cwd);
  await git(cwd, ["push", "-q", "origin", "main"]);
  const b = await readBreaker({ run, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
  expect(b).toEqual(expect.objectContaining({ ok: true, open: true }));
  expect(b.reason).toMatch(/PR #11, PR #12/);

  // persist가 증거를 브랜치에 올리지 못하면 ok:false다 — 그때 merge 스테이지는 머지하지 않는다(merge-stage.test.js의 같은 id 계열).
  const fresh = await makeRepo();
  const line13 = selfMergeLine({ issue: 103, pr: 13, kind: "judge", sha: "3".repeat(40), at: "2026-10-01T03:00:00.000Z" });
  const g13 = makeRecordsUploadGuard({ run, cwd: fresh.cwd });
  g13.trust([line13]);
  appendRunRecord({ root: fresh.cwd, issue: 103, title: "x", stage: "merge", runnerId: "gha-13", now: "2026-10-01T03:00:00.000Z", lines: [line13] });
  // (a) push 실패(syncRecords의 재시도까지 실패).
  const pushFailed = await persistSelfMergeEvidence({ run, cwd: fresh.cwd, issue: 103, line: line13, sync: () => syncRunRecords({ run: failPush, root: fresh.cwd, message: "run-record: issue #103 merge self-merge evidence (gha-13)", guard: g13 }) });
  expect(pushFailed.ok).toBe(false);
  expect(pushFailed.reason).toMatch(/503/);
  // (b) 동기화가 ok라고 말했지만 브랜치에 그 줄이 없다 — 말이 아니라 브랜치를 믿는다.
  const lied = await persistSelfMergeEvidence({ run, cwd: fresh.cwd, issue: 103, line: line13, sync: async () => ({ ok: true }) });
  expect(lied.ok).toBe(false);
  expect(lied.reason).toMatch(/factory\/records/);
  // (c) 동기화가 던진다.
  const threw = await persistSelfMergeEvidence({ run, cwd: fresh.cwd, issue: 103, line: line13, sync: async () => { throw new Error("guard exploded"); } });
  expect(threw).toEqual(expect.objectContaining({ ok: false, reason: expect.stringMatching(/guard exploded/) }));
  // (d) 브랜치를 다시 읽지 못한다(올린 뒤의 확인이 실패) — 확인되지 않은 증거는 증거가 아니다.
  const failRead = async (cmd, args, o) => (cmd === "git" && args[0] === "fetch" ? { code: 1, stdout: "", stderr: "fatal: HTTP 502" } : (cmd === "git" && args[0] === "ls-remote" ? { code: 2, stdout: "", stderr: "fatal: HTTP 502" } : run(cmd, args, o)));
  const unread = await persistSelfMergeEvidence({ run: failRead, cwd: fresh.cwd, issue: 103, line: line13, sync: async () => ({ ok: true }) });
  expect(unread.ok).toBe(false);
  // 대조군: 같은 줄이 정말 올라가면 ok다 — 위의 실패는 픽스처 탓이 아니다.
  const good = await persistSelfMergeEvidence({ run, cwd: fresh.cwd, issue: 103, line: line13, sync: () => syncRunRecords({ run, root: fresh.cwd, message: "run-record: issue #103 merge self-merge evidence (gha-13)", guard: g13 }) });
  expect(good.ok, good.reason).toBe(true);
  // 다른 이슈의 기록에 같은 줄이 있어도 이 이슈의 증거가 아니다.
  const elsewhere = await persistSelfMergeEvidence({ run, cwd: fresh.cwd, issue: 104, line: line13, sync: async () => ({ ok: true }) });
  expect(elsewhere.ok).toBe(false);

  // main()은 merge 스테이지의 persistSelfMerge를 이 가드(같은 trust) 위의 persist로 싣는다(소스로 고정 — main()은 프로세스를 띄워야만 돈다).
  const src = readFileSync(new URL("../bin/run-stage.js", import.meta.url), "utf8");
  expect(src).toMatch(/persistSelfMerge: \(\{ line \}\) => persistSelfMergeEvidence\(\{ run, cwd: root, issue, line, sync: \(\) => syncRunRecords\(\{ run, root, message: `run-record: issue #\$\{issue\} merge self-merge evidence \(\$\{runnerId\}\)`, guard: recordsGuard \}\) \}\),/);
}, 240000);

import { selfMergeVoidLine } from "../lib/breaker.js";

// ── #189 skeptic (r5) f2 — 얕은 클론의 git log는 잘린 history다: 닫힘이 아니라 ok:false ──────────────────────────────────
test("test_189_shallow_clone_history_is_not_closed", async () => {
  const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
  const { remote, cwd } = await makeRepo();
  // 기록 두 건(실제 생산자) + main의 두 판정 머지와 그 revert(진짜 git) → 완전한 클론에서는 열린다.
  mkdirSync(join(cwd, "docs/factory/runs"), { recursive: true });
  writeFileSync(join(cwd, "docs/factory/runs/101.md"), mergeRecordText({ issue: 101, pr: 11, kind: "judge", at: "2026-10-01T01:00:00.000Z" }));
  writeFileSync(join(cwd, "docs/factory/runs/102.md"), mergeRecordText({ issue: 102, pr: 12, kind: "judge", at: "2026-10-01T02:00:00.000Z" }));
  expect((await syncRecords({ run, cwd, message: "rec" })).ok).toBe(true);
  await realLog([
    { subject: "feat a (#11)", at: "2026-10-01T01:00:00Z" },
    { subject: "feat b (#12)", at: "2026-10-01T02:00:00Z" },
    { revert: "feat a (#11)", at: "2026-10-01T05:00:00Z" },
    { revert: "feat b (#12)", at: "2026-10-01T06:00:00Z" },
    { subject: "later work", at: "2026-10-01T07:00:00Z" },
  ], cwd);
  await git(cwd, ["push", "-q", "origin", "main"]);
  const full = await readBreaker({ run, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
  expect(full).toEqual(expect.objectContaining({ ok: true, open: true }));

  // actions/checkout의 기본값(fetch-depth: 1) 같은 얕은 클론: fetch는 얕은 경계에서 멈추고 log는 오류 없이 revert를 빠뜨린다.
  const shallow = mkdtempSync(join(tmpdir(), "ktb-189-shallow-"));
  const cl = await run("git", ["clone", "-q", "--depth", "1", `file://${remote}`, shallow]);
  expect(cl.code, cl.stderr).toBe(0);
  expect((await git(shallow, ["rev-parse", "--is-shallow-repository"])).stdout.trim()).toBe("true");
  const r = await readBreaker({ run, cwd: shallow, defaultBranch: "main", thresholds: T2, now: () => NOW_MS });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/shallow/);
  // 얕음을 확인하지 못하면(rev-parse 실패) 그것도 모르는 것이다 — 닫힘이 아니다.
  const noProbe = async (cmd, args, o) => (cmd === "git" && args.includes("--is-shallow-repository") ? { code: 128, stdout: "", stderr: "fatal: simulated" } : run(cmd, args, o));
  expect((await readBreaker({ run: noProbe, cwd, defaultBranch: "main", thresholds: T2, now: () => NOW_MS })).ok).toBe(false);
  // 얕은 클론을 완전하게 만들면 다시 읽힌다(위의 ok:false가 클론의 다른 탓이 아니다).
  expect((await git(shallow, ["fetch", "-q", "--unshallow", "origin"])).code).toBe(0);
  expect(await readBreaker({ run, cwd: shallow, defaultBranch: "main", thresholds: T2, now: () => NOW_MS })).toEqual(expect.objectContaining({ ok: true, open: true }));
}, 240000);

// ── #189 skeptic (r5) f1 — 무효 줄은 자기가 가리킨 그 자동 머지 줄 하나만 지운다(위조·재시도에 대해) ─────────────────────────
test("test_189_self_merge_void_cancels_only_the_line_it_names", async () => {
  const at11 = "2026-10-01T01:00:00.000Z", at12 = "2026-10-01T02:00:00.000Z", retry12 = "2026-10-01T03:00:00.000Z";
  const sha = "c".repeat(40);
  const reverts = revertsOf(await realLog([
    { subject: "feat a (#11)", at: "2026-10-01T01:00:00Z" },
    { subject: "feat b (#12)", at: "2026-10-01T03:00:00Z" },
    { revert: "feat a (#11)", at: "2026-10-01T05:00:00Z" },
    { revert: "feat b (#12)", at: "2026-10-01T06:00:00Z" },
  ]));
  const sec = (issue, lines, at = at12) => readFileSync(appendRunRecord({ root: mkdtempSync(join(tmpdir(), "ktb-189-void-")), issue, title: "x", stage: "merge", runnerId: "gha-1", now: at, lines }), "utf8");
  const line12 = selfMergeLine({ issue: 102, pr: 12, kind: "judge", sha, at: at12 });
  const void12 = selfMergeVoidLine({ issue: 102, pr: 12, sha, at: "2026-10-01T02:05:00.000Z", voids: at12 });
  const r11 = mergeRecordText({ issue: 101, pr: 11, kind: "judge", at: at11 });
  const ev = (records) => evaluateBreaker({ history: buildHistory({ records: new Map(records), reverts }), thresholds: T2 });

  // 대조군: 무효 줄 없이는 열린다.
  expect(ev([["101", r11], ["102", sec(102, [line12])]]).open).toBe(true);
  // 무효 줄이 그 줄을 지운다 → 닫힘. 무효 줄 자체는 자동 머지가 아니다(파서가 내놓지 않는다).
  expect(ev([["101", r11], ["102", sec(102, [line12, void12])]]).open).toBe(false);
  expect(parseSelfMergeLines(sec(102, [line12, void12]))).toHaveLength(1);
  // blocked 뒤의 재시도가 진짜로 머지했다(새 at의 새 줄) — 앞선 런의 무효 줄은 그 줄을 지우지 못한다 → 열린다.
  const line12b = selfMergeLine({ issue: 102, pr: 12, kind: "judge", sha, at: retry12 });
  expect(ev([["101", r11], ["102", sec(102, [line12, void12, line12b])]]).open).toBe(true);
  // 다른 이슈·다른 PR·다른 sha의 무효 줄은 아무것도 지우지 못한다.
  for (const other of [
    selfMergeVoidLine({ issue: 999, pr: 12, sha, at: at12, voids: at12 }),
    selfMergeVoidLine({ issue: 102, pr: 13, sha, at: at12, voids: at12 }),
    selfMergeVoidLine({ issue: 102, pr: 12, sha: "d".repeat(40), at: at12, voids: at12 }),
  ]) expect(ev([["101", r11], ["102", sec(102, [line12])], ["999", sec(999, [other])], ["103", sec(103, [other])]]).open, other).toBe(true);
  // merge 섹션 밖의 무효 줄은 무효 줄이 아니다.
  const outside = `## implement · x · y\n${void12}\n`;
  expect(ev([["101", r11], ["102", `${sec(102, [line12])}\n${outside}`]]).open).toBe(true);

  // 업로드 가드: 이 프로세스가 쓰지 않은 무효 줄(에이전트가 run 기록에 심은 것)은 올라가지 않는다 — 진짜 판정 머지를 지울 수 없다.
  const { cwd, remote } = await makeRepo();
  const runs = join(cwd, "docs/factory/runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, "102.md"), sec(102, [line12]));
  const g1 = makeRecordsUploadGuard({ run, cwd });
  g1.trust([line12]);
  expect((await syncRunRecords({ run, root: cwd, message: "rec 102", guard: g1 })).ok).toBe(true);
  writeFileSync(join(runs, "102.md"), `${readFileSync(join(runs, "102.md"), "utf8")}\n${sec(102, [void12]).split("\n").filter((l) => !l.startsWith("# ")).join("\n")}`);
  expect((await syncRunRecords({ run, root: cwd, message: "planted", guard: makeRecordsUploadGuard({ run, cwd }) })).ok).toBe(true);
  const onBranch = String((await run("git", ["show", "factory/records:docs/factory/runs/102.md"], { cwd: remote })).stdout);
  expect(onBranch).toContain(line12);
  expect(onBranch).not.toContain(void12);
  // merge abort 정리의 보증도 무효 줄은 보증하지 않는다(GitHub의 MERGED는 무효의 근거가 아니다).
  const vouch = makeMergeAbortVouch({ issue: 102, headBranch: stageBranch(102), prView: async () => ({ state: "OPEN", headRefName: stageBranch(102), headRefOid: sha }) });
  expect(await vouch({ file: "102.md", line: void12 })).toBe(false);
  // persist는 무효 줄도 브랜치에서 다시 읽어 확인한다(같은 파서) — 올라가지 않았으면 ok:false.
  expect((await persistSelfMergeEvidence({ run, cwd, issue: 102, line: void12, sync: async () => ({ ok: true }) })).ok).toBe(false);
  const g2 = makeRecordsUploadGuard({ run, cwd });
  rmSync(runs, { recursive: true, force: true });
  appendRunRecord({ root: cwd, issue: 102, title: "x", stage: "merge", runnerId: "gha-2", now: at12, lines: [void12] });
  g2.trust([void12]);
  const okVoid = await persistSelfMergeEvidence({ run, cwd, issue: 102, line: void12, sync: () => syncRunRecords({ run, root: cwd, message: "void", guard: g2 }) });
  expect(okVoid.ok, okVoid.reason).toBe(true);
}, 240000);
