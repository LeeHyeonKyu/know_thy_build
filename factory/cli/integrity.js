import { run as realRun } from "../lib/exec.js";
import { makeGh, resolveRepo } from "../lib/gh.js";
import { loadHarness as realLoadHarness } from "../lib/config.js";
import { integrityCheck } from "../lib/integrity.js";
import { LOCAL_INTEGRITY_CONTEXT, localIntegrityDescription } from "../lib/merge-stage.js";

/**
 * #236 (ADR-044, 허점 원장 B-1 P-7b) — `factory integrity <pr>`: Actions가 막힌 저장소에서 `factory-integrity.yml` 잡이 하는 판정을
 * 운영 세션이 로컬에서 **같은 함수**(`lib/integrity.js`의 `integrityCheck`, CI bin `bin/integrity.js`가 부르는 그것)로 돌리고,
 * 결과를 PR head에 `factory/integrity` commit status로 올린다. 설명은 `local:<login>` — CI의 check run과 구별되고, 로컬 머지
 * door(run-stage `makeOperatorMergeDeps`)가 그 로그인을 생성자와 대조한다. 이 파일은 그 door가 믿는 홉이라 DOOR_FILES에 있다.
 *
 * 판정 대상은 **PR head sha**다, 운영자의 작업 트리가 아니다: diff는 `<merge-base>...<head sha>`이고 파일 내용은 `git show
 * <sha>:<path>`로 읽는다. 그 커밋이 로컬 객체 저장소에 없으면 판정하지 않는다(가져오라고 말한다). 판정에 이르지 못하면
 * (로그인·PR head·merge-base 미해결) 아무것도 올리지 않는다. 판정 자체가 "계산 불가"면 CI bin과 같이 failure다. success는
 * 판정한 그 sha에만 올라간다.
 *
 * 러너(`GITHUB_ACTIONS`)에서는 거부한다 — 스테이지는 자기 상태를 올리지 않는다(H1b). `env`·`run`·`gh`는 주입받는다(이 함수는
 * process.env를 직접 읽지 않는다; 호출자 `cli/index.js`가 넘긴다).
 */
export const INTEGRITY_USAGE = "usage: factory integrity <pr>   # operator session only: post the CI integrity verdict for the PR head as factory/integrity (local:<login>)";

export async function integrityCommand({ root, argv = [], io, run = realRun, env = process.env, gh = null, loadHarness = realLoadHarness }) {
  if (env?.GITHUB_ACTIONS) {
    io.err("factory integrity refused — GITHUB_ACTIONS is set, so this is a CI runner: a stage never posts its own factory/integrity (H1b); the CI job posts the check there. Nothing was posted.");
    return 2;
  }
  const arg = argv.find((a) => !String(a).startsWith("-"));
  const pr = Number(arg);
  if (!/^[0-9]+$/.test(String(arg ?? "")) || !Number.isInteger(pr) || pr <= 0) { io.err(INTEGRITY_USAGE); return 1; }

  let client = gh;
  if (!client) {
    try { client = makeGh({ run, repo: await resolveRepo({ run }) }); }
    catch (e) { io.err(`factory integrity: could not resolve the repository — ${e?.message || e}. Nothing was posted.`); return 1; }
  }

  let login = "";
  try { login = String((await client.viewerLogin()) ?? "").trim(); } catch { login = ""; }
  if (!login || /[\s:]/.test(login)) {
    io.err("factory integrity: could not resolve your GitHub login (gh api user) — the status names who posted it (local:<login>), so an anonymous verdict is not posted. Run `gh auth login` and retry. Nothing was posted.");
    return 1;
  }

  let view;
  try { view = await client.prView(pr); } catch (e) { io.err(`factory integrity: gh pr view ${pr} failed — ${e?.message || e}. Nothing was posted.`); return 1; }
  const sha = String(view?.headRefOid ?? "");
  if (!/^[0-9a-f]{40}$/.test(sha)) { io.err(`factory integrity: PR #${pr} has no readable head sha (${JSON.stringify(view?.headRefOid ?? null)}). Nothing was posted.`); return 1; }

  // 판정할 커밋이 여기 있어야 한다 — 작업 트리로 대신하지 않는다.
  const has = await run("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root });
  if (has.code !== 0) {
    io.err(`factory integrity: PR #${pr} head ${sha.slice(0, 7)} is not in this clone — fetch it first (\`git fetch origin pull/${pr}/head\`) and retry. The PR head is judged, never the working tree. Nothing was posted.`);
    return 1;
  }

  const harness = loadHarness(root);
  const branch = harness?.project?.default_branch ?? "main";
  const mb = await run("git", ["merge-base", `origin/${branch}`, sha], { cwd: root });
  const base = String(mb.stdout ?? "").trim();
  if (mb.code !== 0 || !base) {
    io.err(`factory integrity: cannot compute merge-base of origin/${branch} and ${sha.slice(0, 7)} (exit ${mb.code} ${String(mb.stderr ?? "").trim()}) — no verdict, nothing posted. Fetch origin/${branch} and retry.`);
    return 2;
  }

  // 내용은 PR head 커밋에서 읽는다(`integrityCheck`의 readFile은 동기라 미리 읽어 둔다). 없는 경로는 null — CI bin과 같은 의미다.
  const contents = new Map();
  const names = await run("git", ["diff", "--no-renames", "--name-only", `${base}...${sha}`], { cwd: root });
  if (names.code === 0) {
    for (const f of String(names.stdout).split("\n").filter(Boolean)) {
      const shown = await run("git", ["show", `${sha}:${f}`], { cwd: root });
      if (shown.code === 0) contents.set(`${root}/${f}`, shown.stdout);
    }
  }
  const verdict = await integrityCheck({ run, cwd: root, base, head: sha, harness, readFile: (p) => (contents.has(p) ? contents.get(p) : null) });
  const state = verdict?.ok === true ? "success" : "failure";
  io.out(JSON.stringify(verdict, null, 2));
  for (const v of verdict?.violations || []) io.out(`integrity: ${v.file}: ${v.rule}`);

  try {
    await client.setStatus({ sha, context: LOCAL_INTEGRITY_CONTEXT, state, description: localIntegrityDescription(login) });
  } catch (e) {
    io.err(`factory integrity: posting ${LOCAL_INTEGRITY_CONTEXT}=${state} on ${sha.slice(0, 7)} failed — ${e?.message || e}`);
    return 1;
  }
  io.out(`posted ${LOCAL_INTEGRITY_CONTEXT}=${state} on PR #${pr} head ${sha.slice(0, 7)} as ${localIntegrityDescription(login)}`);
  return state === "success" ? 0 : 1;
}
