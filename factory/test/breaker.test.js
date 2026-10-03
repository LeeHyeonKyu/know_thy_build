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
