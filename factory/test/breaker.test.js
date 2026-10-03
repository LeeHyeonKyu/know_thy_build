import { test, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { appendRunRecord } from "../lib/run-record.js";
import { readRecordsDetailed, syncRecords } from "../lib/records-branch.js";
import { selfMergeLine } from "../lib/merge-stage.js";
import { TRANSITION_TO } from "../lib/retro/issue-comments.js";
import { breakerThresholds, parseSelfChange } from "../lib/config.js";
import {
  evaluateBreaker, buildHistory, parseRevertLog, revertedPr, parseSelfMergeLines,
  readBreaker, readBreakerState, writeBreakerState, renderBreakerState,
  BREAKER_STATE_DIR, BREAKER_STATE_FILE, BREAKER_STATE_MARKER, BREAKER_RESET_COMMAND,
} from "../lib/breaker.js";
import { breakerCommand } from "../cli/breaker.js";

/**
 * #189 (S4c, ADR-033) — 자동 머지 회로차단기.
 *
 * 픽스처는 **실제 생산자**로 만든다: 자동 머지의 기록은 merge 스테이지가 run 기록에 남기는 줄(`selfMergeLine` →
 * `appendRunRecord`)이고, revert는 진짜 git이 만든 `git log --format=%cI%x09%s` 출력이다(`git revert`의 `Revert "…"`와
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
  return (await git(dir, ["log", "--format=%cI%x09%s"])).stdout;
}

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
  const reverts = parseRevertLog(log);
  expect(reverts.map((r) => r.pr).sort()).toEqual([11, 12]);

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

  // 사람 머지(기록은 by=script인 merged 전이 하나뿐)는 자동 머지가 아니다 — 그 PR이 revert되어도 닫힘.
  const humanMerged = "<!-- factory-transition:v1 from=factory:needs-human to=factory:merged by=script -->\n**전이** factory:needs-human → factory:merged\n";
  expect(TRANSITION_TO.test(humanMerged)).toBe(true);
  const human = new Map([["101", records.get("101")], ["102", `# Run · #102\n${humanMerged}`]]);
  expect(evaluateBreaker({ history: buildHistory({ records: human, reverts }), thresholds: T2 }).open).toBe(false);

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
  const r3 = evaluateBreaker({ history: buildHistory({ records: three, reverts: parseRevertLog(log3) }), thresholds: T3 });
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
  const lines = log.trim().split("\n");
  // 리셋 직후: 브레이커를 연 두 revert만 있는 같은 history.
  const beforeReset = parseRevertLog(lines.filter((l) => /#11|#12/.test(l)).join("\n"));
  const ab = new Map([
    ["101", mergeRecordText({ issue: 101, pr: 11, kind: "judge", at: "2026-10-01T01:00:00.000Z" })],
    ["102", mergeRecordText({ issue: 102, pr: 12, kind: "judge", at: "2026-10-01T02:00:00.000Z" })],
  ]);
  expect(evaluateBreaker({ history: buildHistory({ records: ab, reverts: beforeReset }), thresholds: T2 }).open).toBe(true);   // 대조군
  expect(evaluateBreaker({ history: buildHistory({ records: ab, reverts: beforeReset }), thresholds: T2, closedAt: T }).open).toBe(false);

  // T 뒤의 판정 자동 머지 revert 하나는 혼자서 다시 열지 못한다 — 연속은 T에서 다시 시작한다.
  const oneAfter = parseRevertLog(lines.filter((l) => /#11|#12|#13/.test(l)).join("\n"));
  const abc = new Map([...ab, ["103", mergeRecordText({ issue: 103, pr: 13, kind: "judge", at: "2026-10-02T01:00:00.000Z" })]]);
  expect(evaluateBreaker({ history: buildHistory({ records: abc, reverts: oneAfter }), thresholds: T2, closedAt: T }).open).toBe(false);

  // 두 번째가 다시 연다 — 사유는 T 뒤의 두 PR을 말한다.
  const abcd = new Map([...abc, ["104", mergeRecordText({ issue: 104, pr: 14, kind: "judge", at: "2026-10-02T02:00:00.000Z" })]]);
  const reopened = evaluateBreaker({ history: buildHistory({ records: abcd, reverts: parseRevertLog(log) }), thresholds: T2, closedAt: T });
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

  // 열려 있던 상태(스윕이 쓴 워터마크)를 사람이 닫는다.
  const opened = { version: 1, open: true, since: "2026-10-02T06:00:00.000Z", reason: "revert streak: PR #11, PR #12", closed_by: null, closed_at: null };
  expect((await writeBreakerState({ run, cwd, blob: null, message: "open", state: opened })).ok).toBe(true);
  const ok = io();
  expect(await breakerCommand({ root: cwd, argv, io: ok.io, run: personRun(), env: {}, now: NOW })).toBe(0);
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
