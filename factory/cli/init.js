import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { buildManifest } from "./manifest.js";
import { planInstall, applyInstall, ensureGitignore } from "./install.js";
import { run as realRun } from "../lib/exec.js";

// run 기록은 `factory/records` 브랜치에 산다(ADR-014) — 작업 브랜치에서는 추적하지 않는다.
// 추적하면 hydrateRecord가 스테이지 시작에 복원한 파일이 그대로 "미커밋 변경"이 되어 stop-guard가
// 종료를 막는다(fix round 2, F1). 디렉터리는 appendRunRecord가 필요할 때 만든다 — .gitkeep을 두지 않는다.
export const GITIGNORE_ENTRIES = [".factory/out/", ".factory/node_modules/", "docs/factory/runs/"];

export function projectVars(root) {
  let name = basename(root);
  try { name = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name || name; } catch {}
  return { PROJECT_NAME: name };
}

export async function initCommand({ root, pkgRoot, argv = [], io, run = realRun }) {
  const upgrade = argv.includes("--upgrade"), diff = argv.includes("--diff"), json = argv.includes("--json");
  const vars = projectVars(root);
  const manifest = buildManifest({ pkgRoot });
  const actions = planInstall({ manifest, root, mode: upgrade || diff ? "upgrade" : "init", vars });
  if (diff) {
    const stale = actions.filter((a) => a.action === "replace" || a.action === "merge" || (a.action === "create" && a.owner === "factory"));
    if (json) { io.out(JSON.stringify({ stale: stale.map(({ content, ...a }) => a) })); return stale.length ? 1 : 0; }
    if (!stale.length) { io.out("factory init --diff: everything up to date"); return 0; }
    const tmp = mkdtempSync(join(tmpdir(), "ktb-diff-"));
    try {
      for (const a of stale) {
        const fresh = join(tmp, a.dest.replace(/\//g, "__"));
        writeFileSync(fresh, a.content);
        const missing = a.action === "create";
        const before = missing ? "/dev/null" : join(root, a.dest);
        const r = await run("git", ["diff", "--no-index", "--color=never", before, fresh]);
        io.out(`# ${a.dest} (${missing ? "create — missing" : a.action})\n${r.stdout}`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return 1;
  }
  const counts = applyInstall({ actions, root, writeFile: writeFileSync, mkdir: (d) => mkdirSync(d, { recursive: true }), chmod: chmodSync });
  const gi = join(root, ".gitignore");
  const before = existsSync(gi) ? readFileSync(gi, "utf8") : null;
  const after = ensureGitignore(before, GITIGNORE_ENTRIES);
  if (after !== before) writeFileSync(gi, after);
  if (json) { io.out(JSON.stringify({ counts, actions: actions.map(({ content, ...a }) => a) }, null, 2)); return 0; }
  io.out(`factory init${upgrade ? " --upgrade" : ""}: created ${counts.created} · replaced ${counts.replaced} · merged ${counts.merged} · skipped ${counts.skipped} · kept ${counts.kept}`);
  for (const a of actions) if (a.action !== "skip") io.out(`  ${a.action.padEnd(8)} ${a.dest}${a.owner !== "factory" ? `  (${a.owner}-owned)` : ""}`);
  io.out(`
Next:
  1. Edit .factory/harness.toml (or run /know-thy-build:project) and docs/factory/CHARTER.md (status: ready when done)
  2. npx know-thy-build factory doctor
  3. git add -A && git commit && git push    # push BEFORE bootstrap — branch protection blocks the first push
  4. npx know-thy-build factory bootstrap    # labels, branch protection, token issue date
  5. gh secret set FACTORY_BOT_TOKEN; gh secret set CLAUDE_CODE_OAUTH_TOKEN   # see docs §4.4`);
  return 0;
}
