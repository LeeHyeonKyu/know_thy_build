import { existsSync, readdirSync, rmSync } from "node:fs";
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

/** fetch → (parent가 있으면) read-tree → dir의 *.md를 인덱스에 올림 → write-tree → commit-tree → push. 한 번의 시도. */
async function attempt({ run, cwd, branch, dir, message, gitEnv, indexPath }) {
  const fetchR = await run("git", ["fetch", "origin", `refs/heads/${branch}:${REMOTE_REF}`], { cwd });
  let parent = null;
  if (fetchR.code === 0) {
    const p = await run("git", ["rev-parse", REMOTE_REF], { cwd });   // fetch 실패 = 브랜치가 원격에 없음 → parent 없음
    if (p.code === 0 && p.stdout.trim()) parent = p.stdout.trim();
  }

  const idxEnv = { ...gitEnv, GIT_INDEX_FILE: indexPath };
  const rt = parent
    ? await run("git", ["read-tree", parent], { cwd, env: idxEnv })
    : await run("git", ["read-tree", "--empty"], { cwd, env: idxEnv });
  if (rt.code !== 0) return { ok: false, reason: `read-tree failed: ${rt.stderr.trim()}` };

  const absDir = join(cwd, dir);
  for (const rel of listMarkdownFiles(absDir)) {
    const ho = await run("git", ["hash-object", "-w", join(absDir, rel)], { cwd, env: idxEnv });
    if (ho.code !== 0) return { ok: false, reason: `hash-object failed: ${ho.stderr.trim()}` };
    const blob = ho.stdout.trim();
    const idxPath = `${dir}/${rel}`;
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
  if (ct.code !== 0) return { ok: false, reason: `commit-tree failed: ${ct.stderr.trim()}` };
  const commit = ct.stdout.trim();

  const push = await run("git", ["push", "origin", `${commit}:refs/heads/${branch}`], { cwd });
  if (push.code !== 0) return { ok: false, reason: `push failed: ${push.stderr.trim()}`, pushStderr: push.stderr };
  return { ok: true, commit };
}

/**
 * run 기록을 `factory/records` 브랜치로 동기화한다. 절대 throw하지 않는다.
 * → { ok, commit?, reason?, retried }
 */
export async function syncRecords({ run, cwd, branch = "factory/records", dir = "docs/factory/runs", message, env = {} }) {
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
    const r1 = await attempt({ run, cwd, branch, dir, message, gitEnv, indexPath });
    if (r1.ok) return { ok: true, commit: r1.commit, retried: false };
    if (!r1.pushStderr || !RETRYABLE.test(r1.pushStderr)) return { ok: false, reason: r1.reason, retried: false };
    // 다른 러너가 그 사이 먼저 push했다(non-fast-forward) — 처음부터 딱 한 번 다시 시도한다.
    const r2 = await attempt({ run, cwd, branch, dir, message, gitEnv, indexPath });
    if (r2.ok) return { ok: true, commit: r2.commit, retried: true };
    return { ok: false, reason: r2.reason, retried: true };
  } finally {
    try { rmSync(indexPath, { force: true }); } catch { /* best-effort cleanup */ }
  }
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
    const show = await run("git", ["show", `${REMOTE_REF}:${path}`], { cwd });
    if (show.code !== 0) continue;
    const issue = path.slice(prefix.length, -3);
    out.set(issue, show.stdout);
  }
  return out;
}
