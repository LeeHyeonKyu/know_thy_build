export const lockRef = (issue) => `refs/heads/factory/lock-${issue}`;

export async function claim({ run, cwd, issue, stage, runnerId, now = new Date().toISOString() }) {
  const g = (args) => run("git", args, { cwd });
  const treeR = await g(["hash-object", "-t", "tree", "/dev/null"]);       // empty tree
  const tree = treeR.stdout.trim();
  if (treeR.code !== 0 || !tree) return { ok: false, holder: "unknown", error: "hash-object failed: " + treeR.stderr };
  const msg = `lock issue=${issue} stage=${stage} runner=${runnerId} at=${now}`;
  const commitR = await g(["commit-tree", tree, "-m", msg]);
  const commit = commitR.stdout.trim();
  if (commitR.code !== 0 || !commit) return { ok: false, holder: "unknown", error: "commit-tree failed: " + commitR.stderr };
  const push = await g(["push", "origin", `${commit}:${lockRef(issue)}`]);
  if (push.code === 0) return { ok: true, commit };
  // someone else holds it — read who via FETCH_HEAD (avoids stale-local-ref non-fast-forward)
  const fetch = await g(["fetch", "origin", lockRef(issue)]);
  if (fetch.code !== 0) return { ok: false, holder: "unknown", stderr: push.stderr };
  const who = (await g(["log", "-1", "--format=%s", "FETCH_HEAD"])).stdout.trim();
  return { ok: false, holder: who || "unknown", stderr: push.stderr };
}

export async function release({ run, cwd, issue }) {
  const r = await run("git", ["push", "origin", "--delete", lockRef(issue)], { cwd });
  return r.code === 0;
}

/** 락 커밋 제목(`lock issue=… stage=… runner=… at=…`)에서 소유자 러너 id. */
export const lockRunnerOf = (subject) => (/(?:^|\s)runner=(\S+)/.exec(String(subject ?? "")) || [])[1] ?? null;

/**
 * **지금 이 락을 누가 쥐고 있는가**(ADR-020 KTB-24 fix). `release()`는 소유자를 묻지 않고 지운다 —
 * 그것으로 충분한 자리(`runStage`의 finally: 이 프로세스가 방금 claim에 성공했으므로 락은 정의상
 * 우리 것이다)가 있고, 충분하지 않은 자리가 있다: `abortStage`는 **claim에 실패해 물러난 런에서도**
 * 돈다(취소·실패는 claim 이전에도 온다). 그 경로에서 `release()`를 부르면 지금 정상적으로 돌고 있는
 * 다른 러너의 락을 지워 같은 이슈에 두 스테이지가 동시에 들어갈 수 있다.
 *
 * 돌려주는 값:
 *   - `{present: false}` — 락 브랜치가 없다(이미 풀렸다). 지울 것도, 사람에게 시킬 것도 없다.
 *   - `{present: true, runner, subject}` — 있다. `runner`가 null이면 제목을 파싱하지 못한 것이다.
 *   - `{present: null, reason}` — 조회 자체가 실패했다(네트워크·자격증명). "없다"와 구별해야 한다.
 * 원격 ref가 없을 때 git은 exit≠0 + "couldn't find remote ref"를 낸다 — 그 문구가 유일한 구분점이다.
 */
export async function lockHolder({ run, cwd, issue }) {
  const fetch = await run("git", ["fetch", "origin", lockRef(issue)], { cwd });
  if (fetch.code !== 0) {
    const err = `${fetch.stderr || ""}${fetch.stdout || ""}`;
    if (/couldn't find remote ref|couldn't find remote branch|not found/i.test(err)) return { present: false };
    return { present: null, reason: err.trim() || `git fetch exit ${fetch.code}` };
  }
  const log = await run("git", ["log", "-1", "--format=%s", "FETCH_HEAD"], { cwd });
  if (log.code !== 0) return { present: null, reason: log.stderr.trim() || `git log exit ${log.code}` };
  const subject = log.stdout.trim();
  return { present: true, runner: lockRunnerOf(subject), subject };
}
