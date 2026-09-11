import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { run as realRun } from "../lib/exec.js";

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

/**
 * factory의 설치·검사 대상은 **repo 루트**다 — 하위 디렉터리에서 `factory init`을 부르면
 * `.factory/`·`.claude/`·`.github/`가 거기에 생겨 워크플로도 훅도 아무것도 찾지 못한다.
 * git repo가 아니면(그린필드 디렉터리) cwd로 떨어진다 — 그때는 여기가 곧 루트다.
 */
export async function repoRoot({ run = realRun, cwd = process.cwd() } = {}) {
  const r = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
  const top = r.code === 0 ? r.stdout.trim() : "";
  return top || cwd;
}

export async function main(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") { io.out(HELP); return 0; }
  const root = await repoRoot();
  switch (sub) {
    case "init": return (await import("./init.js")).initCommand({ root, pkgRoot, argv: rest, io });
    case "doctor": return (await import("./doctor.js")).doctorCommand({ root, pkgRoot, argv: rest, io });
    case "bootstrap": return (await import("./bootstrap.js")).bootstrapCommand({ root, argv: rest, io });
    case "run": return (await import("./run.js")).runCommand({ root, argv: rest, io });
    case "status": return (await import("./status.js")).statusCommand({ root, argv: rest, io });
    default: io.err(`unknown factory command: ${sub}\n${HELP}`); return 1;
  }
}
