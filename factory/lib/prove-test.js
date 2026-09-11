import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

export async function proveTest({ run, cwd, harness, base, addedTests, tmp = `${cwd}/.factory/out/prove-wt` }) {
  if (!addedTests?.length) return { ok: false, detail: "no new tests in this change (done_when must be backed by new tests)" };
  const g = (args) => run("git", args, { cwd });
  const add = await g(["worktree", "add", "--detach", tmp, base]);
  if (add.code !== 0) return { ok: false, detail: `worktree add failed: ${add.stderr}` };
  try {
    for (const f of addedTests) {
      mkdirSync(dirname(join(tmp, f)), { recursive: true });
      const cp = await run("cp", [`${cwd}/${f}`, `${tmp}/${f}`]);
      if (cp.code !== 0) return { ok: false, detail: `copy failed for ${f}: ${cp.stderr}` };
    }
    const cmd = harness.commands.test_files.replace("{files}", addedTests.map(q).join(" "));
    const r = await run("bash", ["-lc", cmd], { cwd: tmp });
    if (r.code === 0) return { ok: false, detail: `new tests passed on base ${base.slice(0, 7)} — they do not prove the change` };
    return { ok: true, detail: `new tests fail on base (exit ${r.code})` };
  } finally {
    await g(["worktree", "remove", "--force", tmp]);
  }
}

export async function repeatNewTests({ run, cwd, harness, addedTests, times, fullSuiteCmd = harness.commands.unit }) {
  if (!addedTests?.length) return { ok: true, runs: [], detail: "no new tests" };
  const cmd = harness.commands.test_files.replace("{files}", addedTests.map(q).join(" "));
  const runs = [];
  for (let i = 0; i < times; i++) {
    const noisy = i === 0 && fullSuiteCmd ? run("bash", ["-lc", fullSuiteCmd], { cwd }) : null;
    const r = await run("bash", ["-lc", cmd], { cwd });
    if (noisy) await noisy;
    runs.push({ code: r.code });
  }
  const ok = runs.every((r) => r.code === 0);
  const quietNote = fullSuiteCmd ? "" : " (quiet: no full-suite command configured)";
  return { ok, runs, detail: (ok ? `${times}/${times} passes` : `non-deterministic: exit codes ${runs.map((r) => r.code).join(",")}`) + quietNote };
}
