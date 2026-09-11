import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, mkdtempSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { buildManifest } from "./manifest.js";
import { planInstall, applyInstall, ensureGitignore, render } from "./install.js";
import { run as realRun } from "../lib/exec.js";

export const GITIGNORE_ENTRIES = [".factory/out/", ".factory/node_modules/"];

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
    const stale = actions.filter((a) => a.action === "replace" || a.action === "merge");
    if (!stale.length) { io.out("factory init --diff: everything up to date"); return 0; }
    const tmp = mkdtempSync(join(tmpdir(), "ktb-diff-"));
    for (const a of stale) {
      const fresh = join(tmp, a.dest.replace(/\//g, "__"));
      writeFileSync(fresh, a.content);
      const r = await run("git", ["diff", "--no-index", "--color=never", join(root, a.dest), fresh]);
      io.out(`# ${a.dest} (${a.action})\n${r.stdout}`);
    }
    return 1;
  }
  const counts = applyInstall({ actions, root, writeFile: writeFileSync, mkdir: (d) => mkdirSync(d, { recursive: true }), chmod: chmodSync });
  mkdirSync(join(root, "docs/factory/runs"), { recursive: true });
  const keep = join(root, "docs/factory/runs/.gitkeep");
  if (!existsSync(keep)) writeFileSync(keep, "");
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
  3. npx know-thy-build factory bootstrap   # labels, branch protection, token issue date
  4. gh secret set FACTORY_BOT_TOKEN; gh secret set CLAUDE_CODE_OAUTH_TOKEN   # see docs §4.4
  5. git add -A && git commit && git push`);
  return 0;
}
