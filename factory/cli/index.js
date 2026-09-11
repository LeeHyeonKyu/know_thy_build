import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const io = { out: (s) => console.log(s), err: (s) => console.error(s) };

export const HELP = `
  know-thy-build factory — Phase 2 (dark factory) commands

    factory init [--upgrade|--diff]     Install .factory/ .claude/ .github/ docs/factory/ (never overwrites; --upgrade replaces factory-owned files)
    factory doctor [--no-run] [--offline] [--json]
                                        Verify the harness contract (exit 1 on any FAIL)
    factory bootstrap [--dry-run]       Labels, branch protection, required checks, FACTORY_TOKEN_ISSUED_AT (repo admin)
    factory run <stage> <issue>         Run a stage locally with the same scripts CI uses (triage|plan|implement|review)
    factory status [--json]             Needs You / queue / in progress / recent merges / usage (read-only)
`;

export async function main(argv) {
  const [sub, ...rest] = argv;
  const root = process.cwd();
  if (!sub || sub === "--help" || sub === "-h") { io.out(HELP); return 0; }
  switch (sub) {
    case "init": return (await import("./init.js")).initCommand({ root, pkgRoot, argv: rest, io });
    case "doctor": return (await import("./doctor.js")).doctorCommand({ root, pkgRoot, argv: rest, io });
    case "bootstrap": return (await import("./bootstrap.js")).bootstrapCommand({ root, argv: rest, io });
    case "run": return (await import("./run.js")).runCommand({ root, argv: rest, io });
    case "status": return (await import("./status.js")).statusCommand({ root, argv: rest, io });
    default: io.err(`unknown factory command: ${sub}\n${HELP}`); return 1;
  }
}
