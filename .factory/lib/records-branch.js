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
 * 사라진다. 그래서 `hydrateRecord`가 스테이지 **시작 시**(charterReady 직후) 브랜치 내용을 로컬로
 * 먼저 복원한다.
 *
 * 같은 이슈 경합(fix round 2, F6): 그러고도 로컬이 브랜치 tip의 연장이 아닐 수 있다 — 두 러너가
 * 같은 tip을 하이드레이트한 뒤 서로 다른 섹션을 붙이면, 나중에 미는 쪽의 로컬은 이미 움직인 tip의
 * 접두어가 아니다. 이때 건너뛰면(과거 동작) 그 스테이지의 기록이 영영 사라지므로, 대신 **공통
 * 접두어(줄 경계) 이후의 로컬 꼬리만 브랜치 tip 뒤에 이어 붙인다**(결과 `merged: [path]`).
 * 건너뛰는 경우는 딱 하나 — 더할 꼬리가 없을 때(로컬이 브랜치보다 뒤처져 있을 뿐, `skipped: [path]`).
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

/**
 * a와 b의 공통 접두어 길이 — 단, **줄 경계**까지만 인정하고, 접두어 끝의 빈 줄은 꼬리에 돌려준다.
 * run 기록은 줄 단위 append 로그(섹션 사이 빈 줄 + `## <stage> …` 헤더)라 두 러너의 꼬리가
 * "\n\n## " 같은 시작을 공유하는 것이 보통이다: 문자 단위 LCP를 그대로 쓰면 이어 붙인 꼬리의 첫
 * 줄이 "## "를 잃고 반토막 나고, 줄 경계까지만 물러나면 꼬리가 섹션 구분용 빈 줄을 뺏긴다.
 * 둘 다 되돌려야 "브랜치 tip + 내 섹션"이 원래 모양 그대로 이어진다.
 */
export function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  if (i === a.length || i === b.length) return i;                     // 한쪽이 다른 쪽의 접두어다 — 자를 필요가 없다
  const nl = a.lastIndexOf("\n", i - 1);
  let cut = nl === -1 ? 0 : nl + 1;                                   // 다른 글자가 나온 그 줄의 시작으로
  while (cut > 0 && a[cut - 1] === "\n" && (cut < 2 || a[cut - 2] === "\n")) cut -= 1;   // 접두어 끝의 빈 줄은 꼬리의 구분자다
  return cut;
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
 * 로컬이 그 연장이 아니면 공통 접두어 이후의 로컬 꼬리만 tip 뒤에 이어 붙인다 — 어느 쪽도
 * 덮어쓰지 않는다) → write-tree → commit-tree → push. 한 번의 시도.
 */
async function attempt({ run, cwd, branch, dir, message, gitEnv, indexPath, files, overwrite, expectBlob }) {
  const parent = await fetchParent({ run, cwd, branch });

  // 교체(overwrite) 대상은 "내가 읽은 그 버전을 교체한다"는 주장이다 — push 전에 브랜치의 그 경로가
  // 정말 내가 읽은 blob인지 확인한다. 움직였다면(그 사이 다른 retro가 상태를 밀었다) **아무것도 하지
  // 않고** moved로 돌려준다: 교체는 병합이 아니라 덮어쓰기라 여기서 밀면 남의 상태가 조용히 사라진다.
  for (const [rel, want] of Object.entries(expectBlob || {})) {
    if (!files.includes(rel)) continue;
    const idxPath = `${dir}/${rel}`;
    const rp = parent ? await run("git", ["rev-parse", `${parent}:${idxPath}`], { cwd }) : { code: 1, stdout: "" };
    const have = rp.code === 0 && rp.stdout.trim() ? rp.stdout.trim() : null;
    const expected = want ?? null;
    if (have !== expected) {
      return { ok: false, moved: true, reason: `state moved: ${idxPath} (hydrated ${expected ?? "absent"}, branch ${have ?? "absent"})` };
    }
  }

  const idxEnv = { ...gitEnv, GIT_INDEX_FILE: indexPath };
  const rt = parent
    ? await run("git", ["read-tree", parent], { cwd, env: idxEnv })
    : await run("git", ["read-tree", "--empty"], { cwd, env: idxEnv });
  if (rt.code !== 0) return { ok: false, reason: `read-tree failed: ${rt.stderr.trim()}` };

  const absDir = join(cwd, dir);
  const skipped = [];
  const merged = [];
  for (const rel of files) {
    const idxPath = `${dir}/${rel}`;
    let content = readFileSync(join(absDir, rel), "utf8");
    let blobFrom = join(absDir, rel);                                 // 그대로 올릴 수 있는 경우엔 파일을 바로 해시한다
    if (parent && !overwrite.has(rel)) {
      const parentShow = await run("git", ["show", `${parent}:${idxPath}`], { cwd });
      // parentShow.code === 0 → 브랜치가 이미 이 경로를 갖고 있다.
      if (parentShow.code === 0 && !content.startsWith(parentShow.stdout)) {
        // 로컬이 브랜치 tip의 연장이 아니다 — 같은 이슈에 동시에 돈 다른 러너가 그 사이 자기
        // 섹션을 먼저 밀었다는 뜻이다(둘 다 같은 P0을 하이드레이트했고 서로 다른 꼬리를 붙였다).
        // 어느 쪽도 버리지 않는다: 공통 접두어 이후의 로컬 꼬리만 브랜치 tip 뒤에 이어 붙인다.
        // 공통 접두어는 줄 경계까지만 인정한다 — 두 꼬리가 "## " 같은 머리글자를 공유하면
        // 문자 단위 LCP가 섹션 헤더를 반토막 내기 때문이다.
        const tail = content.slice(commonPrefixLength(content, parentShow.stdout));
        if (!tail) { skipped.push(idxPath); continue; }               // 더할 게 없다 — 로컬이 브랜치보다 뒤처져 있을 뿐
        content = parentShow.stdout + tail;
        blobFrom = null;
        merged.push(idxPath);
      }
    }
    const ho = blobFrom
      ? await run("git", ["hash-object", "-w", blobFrom], { cwd, env: idxEnv })
      : await run("git", ["hash-object", "-w", "--stdin"], { cwd, env: idxEnv, input: content });
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
  if (ct.code !== 0) return { ok: false, reason: `commit-tree failed: ${ct.stderr.trim()}`, skipped, merged };
  const commit = ct.stdout.trim();

  const push = await run("git", ["push", "origin", `${commit}:refs/heads/${branch}`], { cwd });
  if (push.code !== 0) return { ok: false, reason: `push failed: ${push.stderr.trim()}`, pushStderr: push.stderr, skipped, merged };
  return { ok: true, commit, skipped, merged };
}

/**
 * run 기록을 `factory/records` 브랜치로 동기화한다. 절대 throw하지 않는다.
 * → { ok, commit?, reason?, retried, skipped?, merged? }
 *   merged: 브랜치 tip 뒤로 로컬 꼬리를 이어 붙인 경로들(같은 이슈 경합)
 *   skipped: 로컬이 더할 게 없어 건드리지 않은 경로들
 *
 * `overwrite`: dir 기준 상대 경로 목록 — 이 파일들은 꼬리 병합 없이 **로컬 내용으로 교체**한다.
 * 꼬리 병합은 run 기록이 append-only 로그라는 전제에서만 옳다: 브랜치 tip이 로컬의 접두어가 아니면
 * "다른 러너가 자기 섹션을 먼저 밀었다"는 뜻이므로 양쪽을 이어 붙이는 게 맞다. 그러나 retro의
 * `_retro.md`는 **매번 통째로 다시 렌더링되는 상태 파일**이다(`renderRetroState`) — 새 렌더는 옛
 * 렌더의 접두어가 절대 아니므로 병합 규칙에 걸리면 옛 파일 뒤에 새 파일의 꼬리가 붙어, 마커·JSON
 * 펜스가 두 개인 파일이 된다. 그러면 다음 retro의 파서는 **옛 상태**(첫 펜스)를 읽고 상태가 영원히
 * 전진하지 않는다. `_retro.md`는 `concurrency: factory-retro`로 직렬화된 단일 작성자(retro)만 쓰므로
 * 교체가 안전하고, 교체가 유일하게 옳다.
 *
 * `expectBlob`: `{ "<dir 기준 상대경로>": "<blob sha>" | null }` — 교체 전에 브랜치의 그 경로가 정말
 * 내가 하이드레이트한 blob인지 확인한다(null = "그때 브랜치에 없었다"). 다르면 **아무것도 밀지 않고**
 * `{ok:false, moved:true, reason:'state moved: …'}`로 돌려준다: 직렬화가 어떤 이유로든 깨졌을 때
 * (수동 실행, 잡 재시도, 다른 러너) 교체가 남의 상태를 조용히 지우는 것을 막는 유일한 장치다.
 * 호출자는 다시 하이드레이트해 새 상태 위에 자기 변경을 얹고 한 번 더 시도할 수 있다.
 */
export async function syncRecords({ run, cwd, branch = "factory/records", dir = "docs/factory/runs", message, env = {}, overwrite = [], expectBlob = null }) {
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
  const over = new Set(overwrite);
  try {
    const r1 = await attempt({ run, cwd, branch, dir, message, gitEnv, indexPath, files, overwrite: over, expectBlob });
    if (r1.ok) return { ok: true, commit: r1.commit, retried: false, skipped: r1.skipped, merged: r1.merged };
    // 교체 대상이 움직였다 — 재시도는 의미가 없다(다시 시도해도 같은 blob을 만난다). 호출자가 새
    // 상태를 다시 읽고 자기 변경을 얹어야 한다.
    if (r1.moved) return { ok: false, moved: true, reason: r1.reason, retried: false };
    if (!r1.pushStderr || !RETRYABLE.test(r1.pushStderr)) return { ok: false, reason: r1.reason, retried: false, skipped: r1.skipped, merged: r1.merged };
    // 다른 러너가 그 사이 먼저 push했다(non-fast-forward) — 처음부터 딱 한 번 다시 시도한다.
    // 재시도의 fetch가 새 tip을 가져오므로, 같은 파일을 건드린 경우 두 번째 attempt가 꼬리를 병합한다.
    const r2 = await attempt({ run, cwd, branch, dir, message, gitEnv, indexPath, files, overwrite: over, expectBlob });
    if (r2.ok) return { ok: true, commit: r2.commit, retried: true, skipped: r2.skipped, merged: r2.merged };
    if (r2.moved) return { ok: false, moved: true, reason: r2.reason, retried: true };
    return { ok: false, reason: r2.reason, retried: true, skipped: r2.skipped, merged: r2.merged };
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

/**
 * 원격에 <branch>가 실제로 있는지 묻는다(fetch 실패의 두 원인을 가른다).
 * `git ls-remote --exit-code`는 찾으면 0, **없으면 2**, 그 외 오류면 다른 코드다.
 * → "yes" | "no" | "unknown". 절대 throw하지 않는다.
 */
async function remoteBranchExists({ run, cwd, branch }) {
  const r = await run("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], { cwd });
  if (r.code === 0) return "yes";
  if (r.code === 2) return "no";
  return "unknown";
}

/**
 * `factory/records`의 run 기록을 **출처와 함께** 읽는다(fix round 1, Critical).
 * → `{ records: Map<issue,text>, blobs: Map<issue,sha>, fetched, exists, failures: [path], parent }`
 *
 * `readRecords`는 빈 Map과 "정말 비어 있다"를 구별하지 못한다 — 절대 throw하지 않는 설계라서, 네트워크
 * 실패도 "기록 없음"으로 보인다. 기록을 **append**하는 스테이지에는 그 구별이 필요 없었지만(빈 로컬에
 * 자기 섹션을 붙여도 syncRecords의 꼬리 병합이 브랜치를 지키니까), 상태 파일을 **교체**하는 retro에는
 * 치명적이다: fetch가 실패한 회차가 기본 상태를 만들어 브랜치의 진짜 상태 위에 밀어버린다.
 *   - `fetched: true`  — 브랜치 내용을 확정했다(브랜치가 아직 없다는 확정도 포함, `exists: false`).
 *   - `fetched: false` — 확정하지 못했다(fetch도 ls-remote도 실패, 또는 ls-tree 실패). 이때 `records`가
 *     비어 있는 것은 "없다"가 아니라 "모른다"다.
 *   - `failures` — 트리에는 있는데 내용을 읽지 못한 경로들(부분 실패도 조용히 지나가지 않는다).
 *   - `blobs` — 각 기록의 blob sha. 교체 동기화의 `expectBlob`이 이 값을 그대로 쓴다.
 */
export async function readRecordsDetailed({ run, cwd, branch = "factory/records", dir = "docs/factory/runs" }) {
  const empty = { records: new Map(), blobs: new Map(), failures: [], parent: null };
  const parent = await fetchParent({ run, cwd, branch });
  if (!parent) {
    const exists = await remoteBranchExists({ run, cwd, branch });
    if (exists === "no") return { ...empty, fetched: true, exists: false };
    return { ...empty, fetched: false, exists: exists === "yes" ? true : null };
  }
  const ls = await run("git", ["ls-tree", "-r", REMOTE_REF], { cwd });
  if (ls.code !== 0) return { ...empty, fetched: false, exists: true, parent };

  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  const records = new Map();
  const blobs = new Map();
  const failures = [];
  for (const line of ls.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    // `<mode> <type> <sha>\t<path>` — --name-only를 쓰지 않는 이유는 sha가 필요해서다(expectBlob).
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/.exec(line);
    if (!m || m[2] !== "blob") continue;
    const [, , , sha, path] = m;
    if (!path.startsWith(prefix) || !path.endsWith(".md")) continue;
    const rest = path.slice(prefix.length);
    if (rest.includes("/")) continue;                                 // dir 바로 아래 파일만 — 중첩 경로는 스킵
    const show = await run("git", ["show", `${REMOTE_REF}:${path}`], { cwd });
    if (show.code !== 0) { failures.push(path); continue; }
    const issue = rest.slice(0, -3);
    records.set(issue, show.stdout);
    blobs.set(issue, sha);
  }
  return { records, blobs, fetched: true, exists: true, failures, parent };
}

/** `factory/records` 브랜치에서 run 기록을 읽는다. → Map<issue, text>. 브랜치가 없거나 못 읽으면 빈 Map. 절대 throw하지 않는다. */
export async function readRecords(args) {
  return (await readRecordsDetailed(args)).records;
}
