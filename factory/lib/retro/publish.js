// retro의 두 가지 PR 발행(§8.1/§8.3): lessons·역할 예시/관점은 **다크**(integrity GREEN이면 스스로
// 머지, P4-R2), 그 외 제안은 `factory:retro-proposal` 라벨 PR(사람이 머지 — merge 스테이지는 이 PR을
// 보지 않는다, ADR-015 R5).
//
// 외부 접촉은 전부 주입(`run`/`gh`)이고, **러너의 체크아웃은 절대 건드리지 않는다**: 파일을 쓰고
// 커밋하는 모든 일은 `mkdtemp` 아래의 임시 git worktree 안에서만 일어나고 finally에서 지운다.
// retro 잡은 다른 스테이지와 같은 체크아웃에서 돌 수 있고, records 동기화(ADR-014)처럼 현재 HEAD·
// 인덱스·워킹 트리에 손을 대면 그 스테이지의 상태를 망가뜨린다.

import { mkdtemp as fsMkdtemp, mkdir as fsMkdir, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { integrityCheck } from "../integrity.js";

const BOT_NAME = "factory-bot";
const BOT_EMAIL = "factory-bot@users.noreply.github.com";
const INTEGRITY_CHECK = "factory/integrity";
const NEEDS_HUMAN = "factory:needs-human";
const PROPOSAL_LABEL = "factory:retro-proposal";

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defaultReadFile = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

/** run()은 throw하지 않는다 — git의 비정상 종료를 여기서 이유 있는 예외로 바꾼다. */
async function git(run, args, opts) {
  const r = await run("git", args, opts);
  if (r.code !== 0) {
    const what = args[0] === "-c" ? args.find((a) => !a.startsWith("-") && !a.includes("=")) : args[0];
    throw new Error(`git ${what} failed (${r.code}): ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
  }
  return r.stdout;
}

const quiet = async (fn) => { try { return await fn(); } catch { return null; } };

/**
 * `withWorktree({run, cwd, defaultBranch, mkdtemp, rm}, fn)` — `origin/<default>`에 detach된 임시
 * worktree를 만들어 `fn(worktreePath)`를 부르고, **성공하든 던지든** worktree와 임시 디렉토리를
 * 지운다. worktree 경로는 mkdtemp가 만든 디렉토리의 하위(`<tmp>/wt`)다 — `git worktree add`는
 * 이미 존재하는 경로를 거부하므로 mkdtemp의 디렉토리 자체를 쓸 수 없다.
 */
export async function withWorktree({ run, cwd, defaultBranch, mkdtemp = fsMkdtemp, rm = fsRm, prefix = "factory-retro-" }, fn) {
  await git(run, ["fetch", "origin", defaultBranch], { cwd });
  const base = await mkdtemp(join(tmpdir(), prefix));
  const wt = join(base, "wt");
  try {
    // 앞선 retro가 프로세스째 죽으면 worktree 관리 정보만 남고 디렉토리는 사라진다(임시 경로라
    // OS가 치운다). prune으로 그 유령 항목을 먼저 털어낸다 — best-effort다.
    await quiet(() => run("git", ["worktree", "prune"], { cwd }));
    await git(run, ["worktree", "add", "--detach", wt, `origin/${defaultBranch}`], { cwd });
    return await fn(wt);
  } finally {
    await quiet(() => run("git", ["worktree", "remove", "--force", wt], { cwd }));
    await quiet(() => rm(base, { recursive: true, force: true }));
  }
}

async function writeFiles({ wt, files, writeFile, mkdir }) {
  const paths = Object.keys(files || {});
  if (!paths.length) throw new Error("no files to publish");
  for (const rel of paths) {
    const abs = join(wt, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, files[rel]);
  }
  return paths;
}

/** worktree 안에서 파일을 쓰고 factory-bot 이름으로 커밋한다 → 커밋된 상대경로 목록. */
async function stageAndCommit({ run, wt, files, message, writeFile, mkdir }) {
  const paths = await writeFiles({ wt, files, writeFile, mkdir });
  await git(run, ["add", "--", ...paths], { cwd: wt });
  await git(run, ["-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`, "commit", "-m", message], { cwd: wt });
  return paths;
}

const isPass = (c) => (c.bucket ? c.bucket === "pass" : c.state === "SUCCESS");
const FAIL_BUCKETS = new Set(["fail", "cancel", "skipping"]);
const FAIL_STATES = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);
const isFail = (c) => (c.bucket ? FAIL_BUCKETS.has(c.bucket) : FAIL_STATES.has(c.state));

/**
 * PR의 `factory/integrity` 체크를 폴링한다 → `{state:'pass'|'fail'|'timeout', reason?}`.
 * 체크가 아직 **없는** 것은 pass가 아니라 pending이다(fail closed — 머지는 되돌릴 수 없다).
 * 같은 이름의 체크가 여러 개면 전부 pass여야 pass, 하나라도 fail이면 fail이다(gh.js의 `allChecksGreen`과 같은 규칙).
 * `cancel`·`skipping`도 fail로 본다 — 영영 pass가 되지 않을 상태를 타임아웃까지 기다릴 이유가 없고,
 * "검사가 돌지 않았다"는 "통과했다"가 아니다.
 *
 * 한 번의 `gh pr checks` 실패(네트워크·레이트리밋)는 판정이 아니다 — 그 회차만 건너뛰고 계속
 * 폴링한다. 끝내 판정을 못 얻으면 timeout으로 떨어지므로 여전히 fail closed다.
 * 마지막 회차 뒤에는 자지 않는다(누구도 기다리지 않을 잠이다).
 */
async function pollIntegrity({ gh, pr, pollMs, maxPolls, sleep, log }) {
  for (let i = 0; i < maxPolls; i += 1) {
    try {
      const checks = (await gh.prChecks(pr)) || [];
      const mine = checks.filter((c) => c?.name === INTEGRITY_CHECK);
      if (mine.some(isFail)) {
        const c = mine.find(isFail);
        return { state: "fail", reason: `${INTEGRITY_CHECK} check failed (bucket=${c.bucket ?? "-"}, state=${c.state ?? "-"})` };
      }
      if (mine.length && mine.every(isPass)) return { state: "pass" };
      log(`retro: waiting for ${INTEGRITY_CHECK} on PR #${pr} (${i + 1}/${maxPolls})`);
    } catch (e) {
      log(`retro: gh pr checks failed on PR #${pr} (${i + 1}/${maxPolls}) — ${String(e?.message || e)}`);
    }
    if (i < maxPolls - 1) await sleep(pollMs);
  }
  return { state: "timeout", reason: "timeout" };
}

/** 자동 머지를 포기할 때 — PR은 열어 둔 채 사람이 보도록 라벨과 이유를 남긴다. 여기서 실패해도 원래 이유를 잃지 않는다. */
async function handToHuman({ gh, pr, reason, log }) {
  // addLabels는 `gh issue edit`을 쓰지만 PR도 같은 번호 공간이라 그대로 붙는다(별도 prAddLabels 불필요).
  await quiet(() => gh.addLabels(pr, [NEEDS_HUMAN]));
  await quiet(() => gh.comment(pr, [
    `retro가 연 lessons PR의 자동 머지를 중단했습니다: ${reason}.`,
    "",
    `\`${NEEDS_HUMAN}\`을 붙였습니다 — 사람이 diff를 보고 머지하거나 닫아 주세요(retro는 다시 손대지 않습니다).`,
  ].join("\n")));
  log(`retro: lessons PR #${pr} handed to human — ${reason}`);
}

const lessonsBody = (date, paths) => [
  `retro(${date})가 다크로 append한 lesson·역할 예시/관점입니다(§8.1).`,
  `\`${INTEGRITY_CHECK}\`가 GREEN이면 retro가 스스로 머지하고, 아니면 \`${NEEDS_HUMAN}\`을 붙이고 사람에게 넘깁니다.`,
  "",
  "변경 파일:",
  ...paths.map((p) => `- \`${p}\``),
  "",
].join("\n");

/**
 * `openAndMergeLessonsPr(...) → { pr, merged, reason, branch }` — 다크 경로(P4-R2).
 *
 * 순서: worktree → 파일 쓰기 → **커밋** → `integrityCheck` 로컬 선검사 → push → PR → 체크 폴링 → 머지.
 * 선검사를 커밋 **뒤에** 두는 이유: `integrityCheck`는 `base...HEAD` diff를 보므로 커밋되지 않은
 * 워킹 트리 변경은 보이지 않는다(커밋 전에 부르면 항상 "변경 없음"이 되어 검사가 무의미해진다).
 * 커밋은 어차피 버려질 임시 worktree 안에서만 일어나고, RED면 push도 PR도 하지 않는다.
 */
export async function openAndMergeLessonsPr({
  run, gh, cwd, defaultBranch, files, date, harness,
  readFile = defaultReadFile, pollMs = 15000, maxPolls = 40, sleep = defaultSleep, log = () => {},
  mkdtemp = fsMkdtemp, rm = fsRm, writeFile = fsWriteFile, mkdir = fsMkdir,
}) {
  const branch = `factory/lessons-${date}`;
  const title = `retro: lessons/examples ${date}`;
  let pr = null;
  try {
    return await withWorktree({ run, cwd, defaultBranch, mkdtemp, rm }, async (wt) => {
      const paths = await stageAndCommit({ run, wt, files, message: title, writeFile, mkdir });

      const base = (await git(run, ["merge-base", "HEAD", `origin/${defaultBranch}`], { cwd: wt })).trim();
      const integrity = await integrityCheck({ run, cwd: wt, base, harness, readFile });
      if (!integrity.ok) {
        const reason = `integrity: ${integrity.violations.map((v) => `${v.file}: ${v.rule}`).join("; ")}`;
        log(`retro: lessons PR not opened — ${reason}`);
        return { pr: null, merged: false, reason, branch };
      }
      // KTB-5: `integrity.ok`는 이제 변조만 본다 — 보호 경로 변경은 GREEN을 내리지 않는다. 다크
      // PR은 정의상 사람 승인 없이 머지되므로, 보호 경로를 싣고는 절대 안 된다. `splitDarkFiles`가
      // 이미 경로를 제한하지만 그 제한이 깨지면 팩토리가 게이트 정의를 스스로 머지하게 된다 —
      // 값싼 assert 하나로 두 번째 문을 둔다(push도 PR도 하지 않는다).
      if (integrity.protected?.length) {
        const reason = `integrity: protected paths in a dark PR (never auto-merged): ${integrity.protected.join(", ")}`;
        log(`retro: lessons PR not opened — ${reason}`);
        return { pr: null, merged: false, reason, branch };
      }

      await git(run, ["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: wt });
      pr = await gh.createPr({ head: branch, base: defaultBranch, title, body: lessonsBody(date, paths) });
      if (pr == null) {
        // 브랜치는 이미 밀렸고 PR도 열렸을 수 있는데 번호를 못 읽었다 — 라벨도 코멘트도 붙일 곳이
        // 없으니 머지를 시도하지 않고 사람이 볼 수 있게 이유만 남긴다(절대 추측해서 머지하지 않는다).
        const reason = "PR number not parsed";
        log(`retro: lessons PR opened but ${reason} — leaving it to a human`);
        return { pr: null, merged: false, reason, branch };
      }

      const poll = await pollIntegrity({ gh, pr, pollMs, maxPolls, sleep, log });
      if (poll.state === "pass") {
        await gh.mergePr(pr, { method: "squash", deleteBranch: true });
        log(`retro: lessons PR #${pr} merged (dark)`);
        return { pr, merged: true, reason: null, branch };
      }
      await handToHuman({ gh, pr, reason: poll.reason, log });
      return { pr, merged: false, reason: poll.reason, branch };
    });
  } catch (e) {
    const reason = String(e?.message || e);
    log(`retro: lessons PR failed — ${reason}`);
    // PR이 이미 열렸다면(머지 호출이 던졌든, 폴링 밖에서 무엇이 터졌든) 그 PR을 고아로 남기지
    // 않는다 — 열린 채 라벨 없는 PR은 아무도 보지 않는다. 항상 사람에게 넘긴다.
    if (pr != null) await handToHuman({ gh, pr, reason, log });
    return { pr, merged: false, reason, branch };
  }
}

/**
 * `openProposalPr(...) → { pr, branch, reason }` — 사람이 머지하는 제안 PR(§8.3).
 * 라벨은 생성 시점에 붙는다. **머지하지 않는다** — 체크를 폴링하지도 않는다.
 */
export async function openProposalPr({
  run, gh, cwd, defaultBranch, files, title, body, date, log = () => {},
  mkdtemp = fsMkdtemp, rm = fsRm, writeFile = fsWriteFile, mkdir = fsMkdir,
}) {
  const branch = `factory/retro-proposal-${date}`;
  try {
    return await withWorktree({ run, cwd, defaultBranch, mkdtemp, rm }, async (wt) => {
      await stageAndCommit({ run, wt, files, message: `retro: proposals ${date}`, writeFile, mkdir });
      await git(run, ["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: wt });
      const pr = await gh.createPr({ head: branch, base: defaultBranch, title, body, labels: [PROPOSAL_LABEL] });
      log(`retro: proposal PR #${pr} opened (human merges)`);
      return { pr, branch, reason: null };
    });
  } catch (e) {
    const reason = String(e?.message || e);
    log(`retro: proposal PR failed — ${reason}`);
    return { pr: null, branch, reason };
  }
}
