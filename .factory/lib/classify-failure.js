const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

export async function classifyFailures({ run, cwd, harness, failing, base, thresholds, addedTests = [], tmp = `${cwd}/.factory/out/classify-wt` }) {
  const out = [];
  const existing = [];
  for (const f of failing) {
    if (addedTests.includes(f.file)) out.push({ id: f.id, verdict: "red", evidence: { reason: "new test in this change" } });
    else existing.push(f);
  }
  if (!existing.length) return out;
  // 테스트 하나를 돌릴 방법이 없으면 "이 PR 탓인가"를 물을 수 없다 — red도 flaky도 아닌 blocked다.
  const cmd = harness.commands?.test_one;
  if (!cmd) {
    const error = "commands.test_one missing";
    for (const f of existing) out.push({ id: f.id, verdict: "blocked", evidence: { error } });
    return out;
  }
  // {file}과 마찬가지로 {name}도 여기서 따옴표를 붙인다 — 하네스 쪽에서 '{name}'으로 감싸면
  // 이름에 든 작은따옴표가 명령을 깨거나 주입 경로가 된다(§5.1 test_one 계약).
  const one = (f, dir) => run("bash", ["-lc", cmd.replace("{file}", q(f.file)).replace("{name}", q(f.name))], { cwd: dir });
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
      /**
       * 감사 M3 — base 실행이 **전부** 실패하면 그것은 흔들림이 아니다. flaky의 증거는 "같은 커밋에서
       * 같은 테스트가 어떤 때는 통과하고 어떤 때는 실패한다"이고, base 5/5 실패는 그 반대의 증거다 —
       * main에서 이미 깨져 있는 테스트다. 둘을 같은 이름으로 부르면 게이트가 그 실패를 제외하고
       * GREEN으로 넘어가, main이 빨간 채 자동 머지가 이어진다. 판정을 나눈다: `broken-base`는
       * 제외 대상이 아니라 사람이 볼 RED다(gates.js).
       */
      const verdict = baseRuns.every((c) => c === 0) ? "introduced"
        : baseRuns.every((c) => c !== 0) ? "broken-base"
          : "flaky-existing";
      out.push({ id: f.id, verdict, evidence: { pr_isolation, base: baseRuns } });
    }
  } finally {
    if (wtReady) await run("git", ["worktree", "remove", "--force", tmp], { cwd });
  }
  return out;
}
