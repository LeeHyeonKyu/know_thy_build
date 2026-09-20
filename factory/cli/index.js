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
    factory rehearse [--json]           Run the harness once ON THE RUNNER before the first issue (ADR-025);
                                        prints the step table and exits non-zero on RED
    factory run <stage> <issue>         Run a stage locally with the same scripts CI uses (triage|plan|implement|review)
    factory run retro [--force]         Run the retro job locally (--force ignores the merge count N)
    factory status [--json]             Needs You / queue / in progress / recent merges / usage (read-only)
    factory analyze <issue> [--json]    One issue's whole timeline from the records branch + comments —
                                        gates and why they failed, self-gate, verdicts, transitions, cost per
                                        agent — plus the findings classified as the retro classifies them
    factory analyze --health [--json]   Aggregate the behavioural health signals and print the report
    factory board [--repo owner/name]…  Local viewer: lanes, timeline and live agent progress across repos
                [--port 4173] [--interval 60] [--once [--json]]
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
    // doctorCommand는 `run`에 기본값이 없다 — 모든 외부 프로세스를 주입받는 게 규칙이라(Plan 1a) 여기서
    // 실주입을 해야 한다. 빠뜨리면 첫 `run("git", ["ls-files"])`에서 TypeError로 죽는다.
    case "doctor": return (await import("./doctor.js")).doctorCommand({ root, pkgRoot, argv: rest, io, run: realRun });
    case "bootstrap": return (await import("./bootstrap.js")).bootstrapCommand({ root, argv: rest, io });
    // rehearse는 doctor처럼 실주입이 필요하다 — 이 명령의 일은 러너에 주문을 넣고 결과를 가져오는 것이다.
    case "rehearse": return (await import("./rehearse.js")).rehearseCommand({ argv: rest, io, run: realRun });
    case "run": return (await import("./run.js")).runCommand({ root, argv: rest, io });
    case "status": return (await import("./status.js")).statusCommand({ root, argv: rest, io });
    // analyze는 status처럼 읽기 전용이다 — `run`은 gh 호출(코멘트·records 브랜치 내용)에만 쓰이고,
    // `--health`는 Task 4의 집계를 **지연 import**한다(그 파일이 없는 설치에서도 이 명령은 산다).
    case "analyze": return (await import("./analyze.js")).analyzeCommand({ root, argv: rest, io, run: realRun });
    // board는 `pkgRoot`가 필요하다(ADR-022 Task B) — CLI가 내는 페이지와 `factory init`이 설치하는
    // 페이지는 **같은 파일**이어야 하고, 패키지 안의 그 원본은 pkgRoot 아래에만 있다.
    case "board": return (await import("./board.js")).boardCommand({ root, pkgRoot, argv: rest, io });
    default: io.err(`unknown factory command: ${sub}\n${HELP}`); return 1;
  }
}
