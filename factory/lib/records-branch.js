import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * run 기록(§9, `docs/factory/runs/<issue>.md`)을 보호된 default 브랜치가 아니라 별도
 * `factory/records` 브랜치에 append한다(ADR-014) — required status checks가 걸린 브랜치는
 * 러너가 직접 push할 수 없다.
 *
 * plumbing만 쓴다(hash-object/read-tree/write-tree/commit-tree/push) — 워킹 트리·현재 인덱스·
 * 현재 브랜치(HEAD)를 전혀 건드리지 않는다. 그래서 review·merge 스테이지가 detach된 HEAD에서
 * 돌아도(Task 12) 안전하다: 이 모듈은 "현재 체크아웃이 무엇인가"를 한 번도 묻지 않는다 — 오직
 * `cwd`가 어떤 git 저장소 안에 있는지(및 그 저장소의 git-dir)만 알면 된다.
 *
 * fresh checkout 방어(fix round 1, Critical): 러너가 매번 새로 체크아웃하면 로컬에는 이슈의
 * run 기록이 없다 — `appendRunRecord`가 그 상태에서 파일을 만들면 "이번 스테이지 한 줄짜리" 파일이
 * 되고, syncRecords가 그걸 그대로 커밋하면 브랜치에 쌓여 있던 이전 스테이지들의 기록이 통째로
 * 사라진다. 그래서 `hydrateRecord`가 스테이지 시작 시 브랜치 내용을 로컬로 먼저 복원하고,
 * `syncRecords`는 그러고도 로컬이 브랜치보다 짧거나 다르면(hydrate가 실패했거나 안 됐거나) 그
 * 파일만 건너뛰어 브랜치 내용을 덮어쓰지 않는다 — 이중 방어.
 */

const REMOTE_REF = "refs/factory/records-remote";
const RETRYABLE = /rejected|fetch first|non-fast-forward|failed to push/i;

/** dir(예: docs/factory/runs) 아래의 *.md를 dir 기준 상대경로(posix)로, 정렬해서 돌려준다. */
function listMarkdownFiles(absDir) {
  if (!existsSync(absDir)) return [];
  const entries = readdirSync(absDir, { withFileTypes: true, recursive: true });
  const rels = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const parentAbs = e.parentPath ?? e.path ?? absDir;               // Dirent.parentPath (Node ≥20.12); .path는 구버전 별칭
    const abs = join(parentAbs, e.name);
    rels.push(relative(absDir, abs).split(sep).join("/"));
  }
  return rels.sort();
}

async function gitDir({ run, cwd }) {
  const r = await run("git", ["rev-parse", "--git-dir"], { cwd });
  if (r.code !== 0) return null;
  const gd = r.stdout.trim();
  return isAbsolute(gd) ? gd : join(cwd, gd);
}

/** 원격의 <branch> tip을 `refs/factory/records-remote`로 fetch한다. 브랜치가 없으면 null. */
async function fetchParent({ run, cwd, branch }) {
  const fetchR = await run("git", ["fetch", "origin", `refs/heads/${branch}:${REMOTE_REF}`], { cwd });
  if (fetchR.code !== 0) return null;
  const p = await run("git", ["rev-parse", REMOTE_REF], { cwd });
  return p.code === 0 && p.stdout.trim() ? p.stdout.trim() : null;
}

/**
 * fetch → (parent가 있으면) read-tree → dir의 *.md를 인덱스에 올림(단, parent가 이미 갖고 있고
 * 로컬 내용이 그 접두어가 아니면 건너뛴다 — 브랜치 내용을 덮어쓰지 않는다) → write-tree →
 * commit-tree → push. 한 번의 시도.
 */
async function attempt({ run, cwd, branch, dir, message, gitEnv, indexPath, files }) {
  const parent = await fetchParent({ run, cwd, branch });

  const idxEnv = { ...gitEnv, GIT_INDEX_FILE: indexPath };
  const rt = parent
    ? await run("git", ["read-tree", parent], { cwd, env: idxEnv })
    : await run("git", ["read-tree", "--empty"], { cwd, env: idxEnv });
  if (rt.code !== 0) return { ok: false, reason: `read-tree failed: ${rt.stderr.trim()}` };

  const absDir = join(cwd, dir);
  const skipped = [];
  for (const rel of files) {
    const idxPath = `${dir}/${rel}`;
    const localContent = readFileSync(join(absDir, rel), "utf8");
    if (parent) {
      const parentShow = await run("git", ["show", `${parent}:${idxPath}`], { cwd });
      // parentShow.code === 0 → 브랜치가 이미 이 경로를 갖고 있다. 로컬이 그 내용을 접두어로
      // 포함하지 않으면(hydrate가 안 됐거나 실패했다는 뜻) 덮어쓰지 않고 건너뛴다 — read-tree가
      // 이미 인덱스에 parent 버전을 올려뒀으므로 아무것도 하지 않는 것이 "브랜치 버전 유지"다.
      if (parentShow.code === 0 && !localContent.startsWith(parentShow.stdout)) {
        skipped.push(idxPath);
        continue;
      }
    }
    const ho = await run("git", ["hash-object", "-w", join(absDir, rel)], { cwd, env: idxEnv });
    if (ho.code !== 0) return { ok: false, reason: `hash-object failed: ${ho.stderr.trim()}` };
    const blob = ho.stdout.trim();
    const ui = await run("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${idxPath}`], { cwd, env: idxEnv });
    if (ui.code !== 0) return { ok: false, reason: `update-index failed: ${ui.stderr.trim()}` };
  }

  const wt = await run("git", ["write-tree"], { cwd, env: idxEnv });
  if (wt.code !== 0) return { ok: false, reason: `write-tree failed: ${wt.stderr.trim()}` };
  const tree = wt.stdout.trim();

  const ctArgs = ["commit-tree", tree];
  if (parent) ctArgs.push("-p", parent);
  ctArgs.push("-m", message);
  const ct = await run("git", ctArgs, { cwd, env: gitEnv });
  if (ct.code !== 0) return { ok: false, reason: `commit-tree failed: ${ct.stderr.trim()}`, skipped };
  const commit = ct.stdout.trim();

  const push = await run("git", ["push", "origin", `${commit}:refs/heads/${branch}`], { cwd });
  if (push.code !== 0) return { ok: false, reason: `push failed: ${push.stderr.trim()}`, pushStderr: push.stderr, skipped };
  return { ok: true, commit, skipped };
}

/**
 * run 기록을 `factory/records` 브랜치로 동기화한다. 절대 throw하지 않는다.
 * → { ok, commit?, reason?, retried, skipped? }
 */
export async function syncRecords({ run, cwd, branch = "factory/records", dir = "docs/factory/runs", message, env = {} }) {
  const files = listMarkdownFiles(join(cwd, dir));
  if (files.length === 0) return { ok: true, commit: null, reason: "nothing to sync", retried: false };

  const gd = await gitDir({ run, cwd });
  if (!gd) return { ok: false, reason: "git rev-parse --git-dir failed", retried: false };
  const indexPath = join(gd, "factory-records.index");
  const gitEnv = {
    GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME || "factory-bot",
    GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL || "factory-bot@users.noreply.github.com",
    GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME || "factory-bot",
    GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL || "factory-bot@users.noreply.github.com",
    ...env,
  };
  try {
    const r1 = await attempt({ run, cwd, branch, dir, message, gitEnv, indexPath, files });
    if (r1.ok) return { ok: true, commit: r1.commit, retried: false, skipped: r1.skipped };
    if (!r1.pushStderr || !RETRYABLE.test(r1.pushStderr)) return { ok: false, reason: r1.reason, retried: false, skipped: r1.skipped };
    // 다른 러너가 그 사이 먼저 push했다(non-fast-forward) — 처음부터 딱 한 번 다시 시도한다.
    const r2 = await attempt({ run, cwd, branch, dir, message, gitEnv, indexPath, files });
    if (r2.ok) return { ok: true, commit: r2.commit, retried: true, skipped: r2.skipped };
    return { ok: false, reason: r2.reason, retried: true, skipped: r2.skipped };
  } finally {
    try { rmSync(indexPath, { force: true }); } catch { /* best-effort cleanup */ }
  }
}

/**
 * 이번 스테이지가 append하기 전에, `factory/records` 브랜치에 쌓인 이슈의 run 기록을 로컬
 * `<dir>/<issue>.md`로 복원한다. fresh checkout(로컬에 파일이 없음)에서만 실제로 쓴다 — 로컬
 * 파일이 이미 브랜치 내용을 포함하면(접두어) 손대지 않고, 로컬이 브랜치와 어긋나 있으면(둘 다
 * 존재하는데 한쪽이 다른 쪽의 접두어가 아니면) 절대 조용히 병합하지 않고 진단만 돌려준다.
 * → { ok, hydrated, reason? }. 절대 throw하지 않는다.
 */
export async function hydrateRecord({ run, cwd, issue, branch = "factory/records", dir = "docs/factory/runs" }) {
  const parent = await fetchParent({ run, cwd, branch });
  if (!parent) return { ok: true, hydrated: false };                 // 브랜치가 아직 없다 — 복원할 것이 없다

  const path = `${dir}/${issue}.md`;
  const show = await run("git", ["show", `${parent}:${path}`], { cwd });
  if (show.code !== 0) return { ok: true, hydrated: false };         // 이 이슈는 브랜치에 아직 없다 — 이번이 첫 기록

  const branchContent = show.stdout;
  const absDir = join(cwd, dir);
  const localPath = join(absDir, `${issue}.md`);
  if (!existsSync(localPath)) {
    mkdirSync(absDir, { recursive: true });
    writeFileSync(localPath, branchContent);
    return { ok: true, hydrated: true };
  }
  const localContent = readFileSync(localPath, "utf8");
  if (localContent.startsWith(branchContent)) return { ok: true, hydrated: false };   // 이미 브랜치 내용을 포함한다
  return { ok: false, hydrated: false, reason: "local record diverged from branch" };
}

/** `factory/records` 브랜치에서 run 기록을 읽는다. → Map<issue, text>. 브랜치가 없으면 빈 Map. 절대 throw하지 않는다. */
export async function readRecords({ run, cwd, branch = "factory/records", dir = "docs/factory/runs" }) {
  const fetchR = await run("git", ["fetch", "origin", `refs/heads/${branch}:${REMOTE_REF}`], { cwd });
  if (fetchR.code !== 0) return new Map();
  const ls = await run("git", ["ls-tree", "-r", "--name-only", REMOTE_REF], { cwd });
  if (ls.code !== 0) return new Map();
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  const out = new Map();
  for (const path of ls.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (!path.startsWith(prefix) || !path.endsWith(".md")) continue;
    const rest = path.slice(prefix.length);
    if (rest.includes("/")) continue;                                 // dir 바로 아래 파일만 — 중첩 경로는 스킵
    const show = await run("git", ["show", `${REMOTE_REF}:${path}`], { cwd });
    if (show.code !== 0) continue;
    const issue = rest.slice(0, -3);
    out.set(issue, show.stdout);
  }
  return out;
}
