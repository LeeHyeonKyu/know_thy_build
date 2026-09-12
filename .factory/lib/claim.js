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
