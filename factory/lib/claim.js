export const lockRef = (issue) => `refs/heads/factory/lock-${issue}`;

export async function claim({ run, cwd, issue, stage, runnerId, now = new Date().toISOString() }) {
  const g = (args) => run("git", args, { cwd });
  const tree = (await g(["hash-object", "-t", "tree", "/dev/null"])).stdout.trim();       // empty tree
  const msg = `lock issue=${issue} stage=${stage} runner=${runnerId} at=${now}`;
  const commit = (await g(["commit-tree", tree, "-m", msg])).stdout.trim();
  const push = await g(["push", "origin", `${commit}:${lockRef(issue)}`]);
  if (push.code === 0) return { ok: true, commit };
  // someone else holds it — read who
  await g(["fetch", "origin", `${lockRef(issue)}:${lockRef(issue)}`]);
  const who = (await g(["log", "-1", "--format=%s", lockRef(issue)])).stdout.trim();
  return { ok: false, holder: who || "unknown", stderr: push.stderr };
}

export async function release({ run, cwd, issue }) {
  const r = await run("git", ["push", "origin", "--delete", lockRef(issue)], { cwd });
  return r.code === 0;
}
