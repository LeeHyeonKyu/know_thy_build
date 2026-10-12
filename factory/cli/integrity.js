import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 * <sha>:<path>`로 읽는다. **하네스도** PR head의 `.factory/harness.toml`이다(CI bin은 PR 쪽 체크아웃의 하네스로 판정한다) —
 * 그것을 임시 루트에 풀어 같은 `loadHarness`로 읽는다; 운영자 체크아웃의 하네스(더 느슨할 수 있다)는 판정에 쓰지 않는다.
 * 그 커밋이 로컬 객체 저장소에 없으면 판정하지 않는다(가져오라고 말한다). 판정에 이르지 못하면(로그인·PR head·merge-base·
 * 하네스·파일 목록·파일 내용 중 하나라도 미해결) 아무것도 올리지 않는다 — 읽지 못한 파일을 "사라진 파일"로 넘기지 않는다
 * (`integrityCheck`는 null을 삭제로 읽어 내용 규칙을 건너뛴다). 판정 자체가 "계산 불가"면 CI bin과 같이 failure다. success는
 * 판정한 그 sha에만 올라간다.
 *
 * 러너(`GITHUB_ACTIONS`)에서는 거부한다 — 스테이지는 자기 상태를 올리지 않는다(H1b). `env`·`run`·`gh`는 주입받는다. `env`에는
 * 기본값이 없다: 빠뜨린 호출자는 거부된다(process.env로 조용히 떨어지지 않는다; 호출자 `cli/index.js`가 넘긴다).
 */
export const INTEGRITY_USAGE = "usage: factory integrity <pr>   # operator session only: post the CI integrity verdict for the PR head as factory/integrity (local:<login>)";

export async function integrityCommand({ root, argv = [], io, run = realRun, env, gh = null, loadHarness = realLoadHarness }) {
  if (!env || typeof env !== "object") {
    io.err("factory integrity refused — no env was injected, so this cannot tell an operator session from a CI runner (it never reads process.env on its own). Nothing was posted.");
    return 2;
  }
  if (env.GITHUB_ACTIONS) {
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

  // 하네스는 PR head의 것이다(CI bin이 PR 쪽 체크아웃의 `.factory/harness.toml`로 판정하는 것과 같다).
  const shownHarness = await run("git", ["show", `${sha}:.factory/harness.toml`], { cwd: root });
  if (shownHarness.code !== 0) {
    io.err(`factory integrity: PR #${pr} head ${sha.slice(0, 7)} has no readable .factory/harness.toml (exit ${shownHarness.code} ${String(shownHarness.stderr ?? "").trim()}) — the verdict needs the PR head's own harness, never this checkout's. No verdict, nothing posted.`);
    return 2;
  }
  let harness;
  const harnessRoot = mkdtempSync(join(tmpdir(), "factory-integrity-harness-"));
  try {
    mkdirSync(join(harnessRoot, ".factory"), { recursive: true });
    writeFileSync(join(harnessRoot, ".factory/harness.toml"), String(shownHarness.stdout ?? ""));
    harness = loadHarness(harnessRoot);
  } catch (e) {
    io.err(`factory integrity: PR #${pr} head ${sha.slice(0, 7)}'s .factory/harness.toml could not be loaded — ${e?.message || e}. No verdict, nothing posted.`);
    return 2;
  } finally { rmSync(harnessRoot, { recursive: true, force: true }); }
  const branch = harness?.project?.default_branch ?? "main";
  const mb = await run("git", ["merge-base", `origin/${branch}`, sha], { cwd: root });
  const base = String(mb.stdout ?? "").trim();
  if (mb.code !== 0 || !base) {
    io.err(`factory integrity: cannot compute merge-base of origin/${branch} and ${sha.slice(0, 7)} (exit ${mb.code} ${String(mb.stderr ?? "").trim()}) — no verdict, nothing posted. Fetch origin/${branch} and retry.`);
    return 2;
  }

  // 내용은 PR head 커밋에서 읽는다(`integrityCheck`의 readFile은 동기라 미리 읽어 둔다). 삭제되지 않은 경로(`--diff-filter=d`)는
  // 전부 읽혀야 한다 — 하나라도 못 읽으면 판정하지 않는다. 미리 읽지 않은 경로를 integrityCheck가 물으면 null("사라짐")이 아니라
  // 예외다: 목록과 판정이 갈라진 것이므로 판정이 없고, 아무것도 올리지 않는다.
  const noVerdict = (why) => { io.err(`factory integrity: ${why} — no verdict, nothing posted.`); return 2; };
  const names = await run("git", ["diff", "--no-renames", "--diff-filter=d", "--name-only", `${base}...${sha}`], { cwd: root });
  if (names.code !== 0) return noVerdict(`git diff --name-only ${base.slice(0, 7)}...${sha.slice(0, 7)} failed (exit ${names.code} ${String(names.stderr ?? "").trim()})`);
  const contents = new Map();
  for (const f of String(names.stdout ?? "").split("\n").filter(Boolean)) {
    const shown = await run("git", ["show", `${sha}:${f}`], { cwd: root });
    if (shown.code !== 0) return noVerdict(`${f} could not be read at ${sha.slice(0, 7)} (exit ${shown.code} ${String(shown.stderr ?? "").trim()})`);
    contents.set(`${root}/${f}`, shown.stdout);
  }
  const readFile = (p) => {
    if (contents.has(p)) return contents.get(p);
    throw new Error(`${p} was not read from the PR head`);
  };
  let verdict;
  try { verdict = await integrityCheck({ run, cwd: root, base, head: sha, harness, readFile }); }
  catch (e) { return noVerdict(`the verdict could not be computed — ${e?.message || e}`); }
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
