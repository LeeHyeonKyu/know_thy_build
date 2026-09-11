export async function startHeartbeat({ gh, issue, stage, runnerId, intervalMs = 10 * 60 * 1000, now = () => new Date().toISOString() }) {
  const body = (n) => `<!-- factory-heartbeat issue=${issue} -->\nstage: ${stage} · runner: ${runnerId} · started: ${n.started} · last: ${n.last}`;
  const started = now();
  const url = await gh.comment(issue, body({ started, last: started }));
  const id = Number(/issuecomment-(\d+)/.exec(url)?.[1]);
  if (!Number.isFinite(id)) {
    console.warn("factory: heartbeat comment id unparseable; heartbeat disabled");
    return { commentId: null, stop() {} };
  }
  const timer = setInterval(() => { gh.patchComment(id, body({ started, last: now() })).catch(() => {}); }, intervalMs);
  return { commentId: id, stop: () => clearInterval(timer) };
}
