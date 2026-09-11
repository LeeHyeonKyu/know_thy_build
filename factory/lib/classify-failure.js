const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

export async function classifyFailures({ run, cwd, harness, failing, base, thresholds, addedTests = [], tmp = `${cwd}/.factory/out/classify-wt` }) {
  const out = [];
  const existing = [];
  for (const f of failing) {
    if (addedTests.includes(f.file)) out.push({ id: f.id, verdict: "red", evidence: { reason: "new test in this change" } });
    else existing.push(f);
  }
  if (!existing.length) return out;
  const one = (f, dir) => run("bash", ["-lc", harness.commands.test_one.replace("{file}", q(f.file)).replace("{name}", f.name.replace(/'/g, "'\\''"))], { cwd: dir });
  let wtReady = false;
  try {
    for (let idx = 0; idx < existing.length; idx++) {
      const f = existing[idx];
      const pr_isolation = [];
      for (let i = 0; i < thresholds.flaky_isolation_runs; i++) pr_isolation.push((await one(f, cwd)).code);
      if (pr_isolation.some((c) => c !== 0)) { out.push({ id: f.id, verdict: "red", evidence: { pr_isolation } }); continue; }
      if (!wtReady) {
        const a = await run("git", ["worktree", "add", "--detach", tmp, base], { cwd });
        if (a.code !== 0) {
          // worktree add failed: we cannot tell "introduced" from "flaky-existing" without a base
          // run, so this and every remaining not-yet-processed test are "blocked", not "red" — a
          // red verdict would wrongly blame the PR for something we never got to check against base.
          const error = `worktree add failed: ${a.stderr}`;
          out.push({ id: f.id, verdict: "blocked", evidence: { pr_isolation, error } });
          for (let j = idx + 1; j < existing.length; j++) out.push({ id: existing[j].id, verdict: "blocked", evidence: { error } });
          return out;
        }
        wtReady = true;
      }
      const baseRuns = [];
      for (let i = 0; i < thresholds.flaky_base_runs; i++) baseRuns.push((await one(f, tmp)).code);
      out.push({ id: f.id, verdict: baseRuns.every((c) => c === 0) ? "introduced" : "flaky-existing", evidence: { pr_isolation, base: baseRuns } });
    }
  } finally {
    if (wtReady) await run("git", ["worktree", "remove", "--force", tmp], { cwd });
  }
  return out;
}
