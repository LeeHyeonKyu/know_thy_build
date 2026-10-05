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
async function pollIntegrity({ gh, pr, pollMs, maxPolls, sleep, log, headSha = null }) {
  for (let i = 0; i < maxPolls; i += 1) {
    try {
      // #201 cf1 — `headSha`가 주어지면(제자리 갱신) PR head가 그 커밋이 될 때까지는 체크를 읽지 않는다: 이전 head의
      // green 체크가 남아 있고 `gh pr checks`는 그것이 어느 커밋의 것인지 말하지 않는다. 아직 옮겨지지 않았으면 pending이다.
      const live = headSha ? await gh.prHeadSha(pr) : null;
      if (headSha && live !== headSha) {
        log(`retro: PR #${pr} head is ${live ?? "unknown"}, not the pushed ${headSha} yet (${i + 1}/${maxPolls})`);
        if (i < maxPolls - 1) await sleep(pollMs);
        continue;
      }
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

// #201 — `gh pr merge`의 이 거부는 이 저장소의 브랜치 보호에서 온다: 보호 규칙이 `factory/gates`·`factory/review` 상태와
// 승인을 요구하는데 retro의 lessons PR에는 그 셋이 생길 수 없다(#153·#164·#182·#190 전부 같은 원문). 원문만 보면 사람이
// "무엇이 고장났나"를 찾아 나서게 되므로 사람 말 한 줄을 더한다. GitHub이 문구를 바꾸면 번역은 조용히 빠지고 원문만 남는다.
const BRANCH_POLICY_REFUSAL = /base branch policy prohibits the merge/i;
const BRANCH_POLICY_PLAIN = "왜 다크 머지가 안 됐나: 이 저장소의 브랜치 보호가 factory/gates·factory/review 상태와 승인을 요구하는데 retro PR에는 그것이 생길 수 없다 — 사람이 admin으로 머지한다.";

/**
 * 자동 머지를 포기할 때 — PR은 열어 둔 채 사람이 보도록 라벨과 이유를 남긴다. 여기서 실패해도 원래 이유를 잃지 않는다.
 * 원문(`reason`)은 언제나 그대로 싣고, 브랜치 보호 거부일 때만 그 위에 번역 한 줄을 둔다(#201).
 * "retro가 다시 손대지 않는다"고 약속하지 않는다: retro는 다음 회차에 이 PR을 제자리에서 갱신한다(#201) — 다만
 * 브랜치에 factory-bot이 아닌 커밋이 있으면 덮어쓰지 않는다(`openAndMergeLessonsPr`).
 */
async function handToHuman({ gh, pr, reason, log }) {
  // addLabels는 `gh issue edit`을 쓰지만 PR도 같은 번호 공간이라 그대로 붙는다(별도 prAddLabels 불필요).
  await quiet(() => gh.addLabels(pr, [NEEDS_HUMAN]));
  const lines = ["retro가 연 lessons PR의 자동 머지를 중단했습니다."];
  if (BRANCH_POLICY_REFUSAL.test(String(reason ?? ""))) lines.push("", BRANCH_POLICY_PLAIN);
  lines.push(
    "",
    `원문: ${reason}`,
    "",
    `\`${NEEDS_HUMAN}\`을 붙였습니다 — 사람이 diff를 보고 머지하거나 닫아 주세요. 다음 retro는 새 PR을 열지 않고 이 PR을 제자리에서 갱신합니다(브랜치에 ${BOT_NAME}가 아닌 커밋이 있으면 덮어쓰지 않습니다).`,
  );
  await quiet(() => gh.comment(pr, lines.join("\n")));
  log(`retro: lessons PR #${pr} handed to human — ${reason}`);
}

const LESSONS_PREFIX = "factory/lessons-";
const PROPOSAL_PREFIX = "factory/retro-proposal-";

/**
 * #201 — 이미 열린 retro PR(head가 `prefix`로 시작, fork 제외) 중 가장 최근 것, 없으면 null. 둘 이상 열려 있으면(이 변경
 * 이전에 쌓인 것) 가장 최근 것 하나만 갱신하고 나머지는 사람이 닫는다. 조회 실패는 판정이 아니다 — 오늘처럼 새 PR을
 * 여는 쪽으로 떨어진다(lessons는 다음 retro가 다시 계산하므로 잃는 것은 없고, 최악은 PR 하나가 더 생기는 것이다).
 */
async function findStanding({ gh, prefix, log }) {
  try {
    const prs = (await gh.openPrsByHeadPrefix(prefix)) || [];
    return prs.find((p) => p?.number != null && String(p.headRefName ?? "").startsWith(prefix)) ?? null;
  } catch (e) {
    log(`retro: could not list open ${prefix}* PRs — ${String(e?.message || e)}; opening a new PR instead`);
    return null;
  }
}

/** worktree 안에서 원격 브랜치 하나의 **지금** head를 가져온다 → sha. 이 sha가 곧 force-with-lease의 기대값이다. */
async function fetchBranchHead({ run, wt, branch }) {
  await git(run, ["fetch", "origin", `refs/heads/${branch}`], { cwd: wt });
  return (await git(run, ["rev-parse", "FETCH_HEAD"], { cwd: wt })).trim();
}

/** `origin/<default>..head`에서 factory-bot이 만들지 않은 커밋들(sha). 사람이 needs-human PR에 올린 수정이 여기 걸린다. */
async function foreignCommits({ run, wt, defaultBranch, head }) {
  const out = await git(run, ["log", "--format=%H%x09%an%x09%ae", `origin/${defaultBranch}..${head}`], { cwd: wt });
  return out.split("\n").filter(Boolean).map((l) => l.split("\t"))
    .filter(([, name, email]) => !(name === BOT_NAME && email === BOT_EMAIL))
    .map(([sha]) => sha);
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
 * #201: 열린 `factory/lessons-*` PR이 있으면 "push → PR"이 "그 브랜치로 리스 건 force push → 제목·본문 갱신 → 갱신
 * 코멘트"가 된다(그 브랜치에 factory-bot이 아닌 커밋이 있으면 아무것도 밀지 않고 멈춘다). 나머지 순서는 같다.
 * 선검사를 커밋 **뒤에** 두는 이유: `integrityCheck`는 `base...HEAD` diff를 보므로 커밋되지 않은
 * 워킹 트리 변경은 보이지 않는다(커밋 전에 부르면 항상 "변경 없음"이 되어 검사가 무의미해진다).
 * 커밋은 어차피 버려질 임시 worktree 안에서만 일어나고, RED면 push도 PR도 하지 않는다.
 */
export async function openAndMergeLessonsPr({
  run, gh, cwd, defaultBranch, files, date, harness,
  readFile = defaultReadFile, pollMs = 15000, maxPolls = 40, sleep = defaultSleep, log = () => {},
  mkdtemp = fsMkdtemp, rm = fsRm, writeFile = fsWriteFile, mkdir = fsMkdir,
}) {
  let branch = `${LESSONS_PREFIX}${date}`;
  const title = `retro: lessons/examples ${date}`;
  let pr = null;
  try {
    return await withWorktree({ run, cwd, defaultBranch, mkdtemp, rm }, async (wt) => {
      const paths = await stageAndCommit({ run, wt, files, message: title, writeFile, mkdir });

      // #201 — 이미 열린 lessons PR이 있으면 새 PR을 쌓지 않고 그 브랜치를 `origin/<default>` + 이번 `files`로 갈아 끼운다.
      // 파일 내용은 합치지 않는다(arch1): 채택·중복·상한·id는 lessons.js(`applyLessons`)가 정하고 여기서는 그 결과를 그대로
      // 싣는다 — 여기서 그 PR의 텍스트를 다시 합치면 상한이 결정된 곳 밖에서 깨진다.
      // 리스는 **방금 읽은 head**에 건다: worktree에는 그 브랜치의 원격 추적 ref가 없어 맨 `--force-with-lease`는
      // 아무것도 지키지 못한다.
      const standing = await findStanding({ gh, prefix: LESSONS_PREFIX, log });
      let lease = null;
      if (standing) {
        branch = standing.headRefName;
        lease = await fetchBranchHead({ run, wt, branch });
        // 리스는 읽은 뒤 몇 초만 지킨다. needs-human PR에 사람이 며칠 전에 올린 수정은 그 head에 이미 들어 있으므로
        // 리스로는 못 지킨다 — factory-bot이 아닌 커밋이 하나라도 있으면 아예 덮어쓰지 않는다.
        const foreign = await foreignCommits({ run, wt, defaultBranch, head: lease });
        if (foreign.length) {
          const shas = foreign.map((x) => x.slice(0, 7)).join(", ");
          const reason = `standing lessons PR #${standing.number} carries commits not made by ${BOT_NAME} (${shas}) — not refreshed`;
          await quiet(() => gh.comment(standing.number, `retro(${date})는 이 PR을 갱신하지 않았습니다 — 브랜치에 ${BOT_NAME}가 아닌 커밋(${shas})이 있어 덮어쓰지 않습니다. 이 PR을 머지하거나 닫으면 다음 retro가 새 PR을 엽니다.`));
          log(`retro: ${reason}`);
          return { pr: standing.number, merged: false, reason, branch };
        }
      }

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
      // KTB-6: `additive_only` 위반도 이제 `ok`를 내리지 않는다 — `policy`로 옮겼다. 이 PR이
      // 다크로 머지되는 근거가 바로 "허용 섹션에 **추가만** 했다"는 것이므로, 그 전제가 깨지면
      // 자동 머지할 자격이 없다. `applyRoleAdditions`가 이미 섹션 안에만 쓰지만, 그 불변식이
      // 깨졌을 때 조용히 머지되지 않도록 여기서 한 번 더 확인한다.
      if (integrity.policy?.length) {
        const files = [...new Set(integrity.policy.map((v) => v.file))].join(", ");
        const reason = `integrity: role sections edited outside the allowed sections in a dark PR (never auto-merged): ${files}`;
        log(`retro: lessons PR not opened — ${reason}`);
        return { pr: null, merged: false, reason, branch };
      }

      let pushed = null;
      if (standing) {
        await git(run, ["push", `--force-with-lease=refs/heads/${branch}:${lease}`, "origin", `HEAD:refs/heads/${branch}`], { cwd: wt });
        pushed = (await git(run, ["rev-parse", "HEAD"], { cwd: wt })).trim();
        pr = standing.number;
        await gh.editPr(pr, { title, body: lessonsBody(date, paths) });
        await quiet(() => gh.comment(pr, `retro(${date})가 이 PR을 갱신했다 — 브랜치를 \`origin/${defaultBranch}\` + 이번 회차의 lessons로 다시 만들었습니다(새 PR은 열지 않았습니다).`));
        log(`retro: lessons PR #${pr} refreshed in place`);
      } else {
        await git(run, ["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: wt });
        pr = await gh.createPr({ head: branch, base: defaultBranch, title, body: lessonsBody(date, paths) });
      }
      if (pr == null) {
        // 브랜치는 이미 밀렸고 PR도 열렸을 수 있는데 번호를 못 읽었다 — 라벨도 코멘트도 붙일 곳이
        // 없으니 머지를 시도하지 않고 사람이 볼 수 있게 이유만 남긴다(절대 추측해서 머지하지 않는다).
        const reason = "PR number not parsed";
        log(`retro: lessons PR opened but ${reason} — leaving it to a human`);
        return { pr: null, merged: false, reason, branch };
      }

      // 제자리 갱신이면 폴링과 머지를 방금 push한 커밋에 고정한다(#201 cf1) — 이전 head의 green 체크로 새 커밋이 머지되지 않는다.
      const poll = await pollIntegrity({ gh, pr, pollMs, maxPolls, sleep, log, headSha: pushed });
      if (poll.state === "pass") {
        await gh.mergePr(pr, pushed ? { method: "squash", deleteBranch: true, matchHeadCommit: pushed } : { method: "squash", deleteBranch: true });
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
 * #201: 열린 `factory/retro-proposal-*` PR이 있으면 새 PR 대신 그 브랜치에 이번 날짜 파일을 더하고 제목·본문을 갱신한다.
 * 라벨은 생성 시점에 붙는다. **머지하지 않는다** — 체크를 폴링하지도 않는다.
 */
export async function openProposalPr({
  run, gh, cwd, defaultBranch, files, title, body, date, log = () => {},
  mkdtemp = fsMkdtemp, rm = fsRm, writeFile = fsWriteFile, mkdir = fsMkdir,
}) {
  let branch = `${PROPOSAL_PREFIX}${date}`;
  try {
    return await withWorktree({ run, cwd, defaultBranch, mkdtemp, rm }, async (wt) => {
      // #201 — 이미 열린 제안 PR이 있으면 그 브랜치 **위에** 이번 날짜 파일을 더한다. 제안 파일은 날짜별 파일이라 충돌이
      // 없고, 그 브랜치에서 출발해 force 없이 push하므로 이전 날짜 파일도 누구의 커밋도 사라지지 않는다.
      const standing = await findStanding({ gh, prefix: PROPOSAL_PREFIX, log });
      if (standing) {
        branch = standing.headRefName;
        const head = await fetchBranchHead({ run, wt, branch });
        await git(run, ["checkout", "--detach", head], { cwd: wt });
        await stageAndCommit({ run, wt, files, message: `retro: proposals ${date}`, writeFile, mkdir });
        await git(run, ["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: wt });
        await gh.editPr(standing.number, { title, body });
        log(`retro: proposal PR #${standing.number} appended in place (human merges)`);
        return { pr: standing.number, branch, reason: null };
      }
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
