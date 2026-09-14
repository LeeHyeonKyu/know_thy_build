import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { buildManifest } from "./manifest.js";
import { planInstall, applyInstall, ensureGitignore } from "./install.js";
import { run as realRun } from "../lib/exec.js";
import { parse as parseToml } from "smol-toml";

// run 기록은 `factory/records` 브랜치에 산다(ADR-014) — 작업 브랜치에서는 추적하지 않는다.
// 추적하면 hydrateRecord가 스테이지 시작에 복원한 파일이 그대로 "미커밋 변경"이 되어 stop-guard가
// 종료를 막는다(fix round 2, F1). 디렉터리는 appendRunRecord가 필요할 때 만든다 — .gitkeep을 두지 않는다.
// 테스트 산출물(`test-results/`·`coverage/`·`.nyc_output/`)도 무시한다: 게이트가 매 스테이지마다
// 커버리지·리포트를 만들고, 추적되면 그 파일들이 "미커밋 변경"으로 남아 stop-guard가 스테이지 종료를
// 막거나 PR diff에 러너의 산출물이 섞인다(F1과 같은 이유 — 판정의 재료는 커밋 대상이 아니다).
// `.factory/package-lock.json`은 `npm install --prefix .factory`(CI의 setup 액션과 `factory run`의
// preflight 3단계)가 로컬에 만드는 파일이다 — 커밋 대상이 아닌데 무시 목록에 없어서 매번 dirty로 잡혔고,
// 무결성 검사에는 `.factory/**`(보호 경로)로 보여 사람 머지 신호까지 만들었다.
export const GITIGNORE_ENTRIES = [".factory/out/", ".factory/node_modules/", ".factory/package-lock.json", "docs/factory/runs/", "test-results/", "coverage/", ".nyc_output/"];

/**
 * 설치 렌더링에 쓰이는 값들. `PROJECT_NAME`은 `{{PROJECT_NAME}}` 치환용 문자열이고, `PROTECTED`는
 * **생성기**가 읽는 harness.toml `[protected]` 섹션이다(외부 감사 M8 — 보호 목록의 단일 출처).
 * `render`는 객체 값을 치환하지 않으므로 `PROTECTED`가 템플릿 텍스트에 새어 들어갈 일은 없다.
 *
 * 최초 `factory init`에는 아직 `.factory/harness.toml`이 없다 — 그때는 **이번 설치가 깔 템플릿**이
 * 곧 그 프로젝트의 harness다. 그래서 프로젝트 파일이 없으면 패키지의 템플릿에서 읽는다.
 * 둘 다 못 읽으면 던지지 않고 `PROTECTED`를 비워 둔다 — `freshContent`가 그 자리에서 이유를 말하며
 * 실패한다(생성되지 않은 목록을 조용히 설치하는 것보다 낫다).
 */
export function projectVars(root, pkgRoot = null) {
  let name = basename(root);
  try { name = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name || name; } catch {}
  let PROTECTED = null;
  for (const p of [join(root, ".factory/harness.toml"), ...(pkgRoot ? [join(pkgRoot, "templates/factory/factory/harness.toml")] : [])]) {
    try { PROTECTED = parseToml(readFileSync(p, "utf8")).protected; } catch {}
    if (PROTECTED) break;
  }
  return { PROJECT_NAME: name, PROTECTED };
}

export async function initCommand({ root, pkgRoot, argv = [], io, run = realRun }) {
  const upgrade = argv.includes("--upgrade"), diff = argv.includes("--diff"), json = argv.includes("--json");
  const vars = projectVars(root, pkgRoot);
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
  io.out(`factory init${upgrade ? " --upgrade" : ""}: created ${counts.created} · replaced ${counts.replaced} · merged ${counts.merged} · skipped ${counts.skipped} · kept ${counts.kept} · pruned ${counts.pruned} · removed ${counts.removed}`);
  // 제거는 조용히 일어나면 안 된다 — 사람의 settings.json에서 줄이 사라진 것이므로 이유를 말한다.
  if (counts.pruned) io.out(`  pruned ${counts.pruned} stale entries from .claude/settings.json — path denies moved to .factory/ci-settings.json (ADR-019), and dead hooks (check-merge-gate.sh) are unwired (audit M6)`);
  if (counts.removed) io.out(`  removed ${counts.removed} dead hook file(s) — they never ran (they read $TOOL_INPUT, which Claude Code does not set) and a phantom gate is worse than no gate (audit M6)`);
  for (const a of actions) if (a.action !== "skip") io.out(`  ${a.action.padEnd(8)} ${a.dest}${a.owner !== "factory" ? `  (${a.owner}-owned)` : ""}`);
  io.out(`
Next:
  1. Edit .factory/harness.toml (or run /know-thy-build:project) and docs/factory/CHARTER.md (status: ready when done)
  2. npx know-thy-build factory doctor
  3. git add -A && git commit && git push    # push BEFORE bootstrap — branch protection blocks the first push
  4. gh secret set FACTORY_BOT_TOKEN         # a NON-ADMIN machine user's PAT (plain WRITE collaborator).
                                             # Scope \`repo\` ONLY — never \`workflow\`: that scope lets the agent push
                                             # .github/workflows/*.yml onto its own branch, and a workflow on a same-repo
                                             # branch is handed the repository secrets (ADR-021 r1 MF-2).
     gh secret set CLAUDE_CODE_OAUTH_TOKEN   # or ANTHROPIC_API_KEY
  5. npx know-thy-build factory bootstrap    # labels, branch protection, token issue date,
                                             # .github/CODEOWNERS, and the \`factory-merge\` environment.
                                             # Without FACTORY_MERGE_TOKEN it bootstraps SINGLE-ACTOR mode: merge power
                                             # stays reachable from agent stages and hooks are the only layer (doctor WARNs).
  6. Two-actor mode (recommended — ADR-021). An ADMIN account's PAT, a DIFFERENT account from the bot:
     gh secret set FACTORY_MERGE_TOKEN --env factory-merge   # an ENVIRONMENT secret, not a repo secret:
                                             # a repo secret is readable by a workflow on ANY same-repo branch.
     npx know-thy-build factory bootstrap    # re-run: adds \`1 code-owner approving review\` to the base branch
                                             # and writes .github/CODEOWNERS with \`* @<merge actor>\`.
     git add .github/CODEOWNERS && git commit && git push    # GitHub reads CODEOWNERS from the BASE branch
  7. npx know-thy-build factory board        # live viewer: lanes, timeline, per-agent progress and cost
                                             # (http://127.0.0.1:4173 — reads GitHub through YOUR gh CLI;
                                             # add --repo owner/name to watch other repos in the same board).
                                             # The same page is installed at docs/factory/board/index.html.
  8. npx know-thy-build factory doctor       # tokens.two-actor / protection.two-actor / protection.codeowners.
                                             # tokens.agent-is-admin, tokens.agent-workflow-scope and the CODEOWNERS
                                             # identity check are WARN "unverified until CI" locally — the sweeper's
                                             # \`Doctor (merge authority)\` step grades them under the bot token.
                                             # See docs §4.4 and ADR-021.
  9. npx know-thy-build factory rehearse     # runs the harness ONCE ON THE RUNNER before the first issue (ADR-025):
                                             # lint · unit · test_files · test_one · lint_file · qa evidence ·
                                             # the no-write clean check · prove-test machinery · gh auth/labels/push.
                                             # doctor is static and \`--run\` is your laptop — the defects that cost
                                             # own-calendar three dark rounds (exit 127, analyze on pre-existing infos,
                                             # repo-root-relative paths after \`cd\`) are only visible here.
                                             # \`→ factory:queue\` is refused until this is GREEN for this harness.`);
  return 0;
}
