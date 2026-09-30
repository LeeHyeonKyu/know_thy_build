import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 설계 2026-09-30 §8.3 (S3, KTB #41) — **설치된 엔진(미러)은 러너가 만든다, 에이전트가 아니라.**
 *
 * KTB 자기 저장소에서 엔진 PR은 `factory/**`(소스)를 고친다. 설치본 `.factory/**`·`.claude/hooks/*.sh`는 소스에서
 * 생성되는 파일인데 에이전트는 거기 쓸 수 없다(훅·deny — 옳다: 판정에 쓰이는 엔진을 판정 대상이 고치면 안 된다).
 * 그래서 첫 엔진 이슈(#36)는 `self-mirror.test.js`에서 RED로 멈췄고 사람이 일곱 파일을 손으로 복사했다.
 *
 * 이 모듈은 `factory init --upgrade`가 아니라 **그 설치의 생성 함수 자체**(`buildManifest`+`freshContent`)로 네 가족만 다시
 * 만든다 — `.claude/agents/*.md` 같은 additive 섹션이 있는 파일은 건드리지 않는다(`init --upgrade`가 그것을 덮는 것을
 * 이번 세션에서 실측했다). 네 가족은 `self-mirror.test.js`가 바이트 동일을 요구하는 바로 그 넷이다.
 *
 * 적용 조건: 소스 트리에 `factory/cli/manifest.js`가 있는 저장소(= KTB 자신). 채택자 저장소에는 `factory/cli/**`가 설치되지
 * 않으므로 이 단계는 `applicable: false`로 조용히 빠진다.
 */
export const MIRROR_FAMILIES = [".factory/lib/", ".factory/bin/", ".factory/actions/", ".claude/hooks/"];

export const inMirrorFamily = (dest) => MIRROR_FAMILIES.some((f) => (f === ".claude/hooks/" ? dest.startsWith(f) && dest.endsWith(".sh") : dest.startsWith(f)));

/**
 * 네 가족을 소스에서 다시 만들어 트리에 쓴다. 순수하지 않지만 결정적이다: 같은 소스면 같은 바이트.
 * @returns {{ok:boolean, applicable:boolean, changed:string[], reason?:string}}
 */
export async function regenerateMirror({ root, write = true, importer = (p) => import(pathToFileURL(p).href) } = {}) {
  const manifestJs = join(root, "factory/cli/manifest.js");
  const installJs = join(root, "factory/cli/install.js");
  const initJs = join(root, "factory/cli/init.js");
  if (!existsSync(manifestJs) || !existsSync(installJs) || !existsSync(join(root, ".factory"))) return { ok: true, applicable: false, changed: [] };
  let buildManifest, freshContent, projectVars;
  try {
    ({ buildManifest } = await importer(manifestJs));
    ({ freshContent } = await importer(installJs));
    ({ projectVars } = await importer(initJs));
  } catch (e) {
    return { ok: false, applicable: true, changed: [], reason: `mirror generators could not be loaded — ${e?.message || e}` };
  }
  let entries, vars;
  try {
    vars = projectVars(root, root);
    entries = buildManifest({ pkgRoot: root }).filter((e) => inMirrorFamily(e.dest));
  } catch (e) {
    return { ok: false, applicable: true, changed: [], reason: `mirror manifest could not be built — ${e?.message || e}` };
  }
  const changed = [];
  for (const e of entries) {
    let fresh;
    try { fresh = freshContent(e, { readFile: (p) => readFileSync(p, "utf8"), vars }); }
    catch (err) { return { ok: false, applicable: true, changed, reason: `${e.dest}: ${err?.message || err}` }; }
    const dest = join(root, ...e.dest.split("/"));
    const current = existsSync(dest) ? readFileSync(dest, "utf8") : null;
    if (current === fresh) continue;
    changed.push(e.dest);
    if (write) { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, fresh); }
  }
  return { ok: true, applicable: true, changed: changed.sort() };
}

/**
 * 스테이지 안의 미러 단계. 세션 뒤·게이트 전에 돈다.
 *   - implement(`mode: "commit"`): 재생성한 결과가 HEAD와 다르면 **러너 이름으로** 커밋하고 push한다. 되돌려준 `sha`가 새 head다.
 *     빌더가 그 경로에 직접 쓴 것은 overlay·drift 검사가 이미 막았으므로, 여기서 생기는 diff는 전부 소스에서 생성된 것이다.
 *   - review/merge(`mode: "verify"`): 재생성한 결과가 PR head와 달라야 할 이유가 없다 — 다르면 "PR의 설치본은 그 소스가 만드는 것이
 *     아니다"이고 판정 불가(needs-human)다. 같으면 트리는 이제 PR head와 같고, 게이트(self-mirror 테스트)는 진실을 본다.
 *   어느 모드든 `applicable: false`면 아무것도 하지 않는다.
 */
export async function mirrorStep({ root, run, mode, headSha = null, regenerate = regenerateMirror, message = "mirror: regenerate the installed engine from factory/** (runner-owned, S3)" }) {
  const r = await regenerate({ root });
  if (!r.applicable) return { ok: true, applicable: false, changed: [], sha: null };
  if (!r.ok) return { ok: false, applicable: true, changed: r.changed, sha: null, reason: r.reason };
  const families = MIRROR_FAMILIES.map((f) => f.replace(/\/$/, ""));
  const diff = await run("git", ["status", "--porcelain", "--", ...families], { cwd: root });
  if (diff.code !== 0) return { ok: false, applicable: true, changed: r.changed, sha: null, reason: `mirror diff could not be read: ${diff.stderr?.trim() || `exit ${diff.code}`}` };
  const dirty = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (mode === "verify") {
    if (dirty.length) return { ok: false, applicable: true, changed: r.changed, sha: headSha, reason: `the installed engine in this PR is not what its sources generate — ${r.changed.slice(0, 8).join(", ")}${r.changed.length > 8 ? ", …" : ""} (regenerate with the runner's mirror step, never by hand)` };
    return { ok: true, applicable: true, changed: [], sha: headSha };
  }
  if (!dirty.length) return { ok: true, applicable: true, changed: [], sha: headSha };
  const add = await run("git", ["add", "--", ...families], { cwd: root });
  if (add.code !== 0) return { ok: false, applicable: true, changed: r.changed, sha: null, reason: `mirror add failed: ${add.stderr?.trim() || `exit ${add.code}`}` };
  const commit = await run("git", ["-c", "user.name=factory-runner", "-c", "user.email=factory-runner@users.noreply.github.com", "commit", "-q", "-m", `${message}\n\n${r.changed.join("\n")}`], { cwd: root });
  if (commit.code !== 0) return { ok: false, applicable: true, changed: r.changed, sha: null, reason: `mirror commit failed: ${commit.stderr?.trim() || `exit ${commit.code}`}` };
  const sha = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const push = await run("git", ["push", "-q", "origin", "HEAD"], { cwd: root });
  if (push.code !== 0) return { ok: false, applicable: true, changed: r.changed, sha, reason: `mirror push failed: ${push.stderr?.trim() || `exit ${push.code}`}` };
  return { ok: true, applicable: true, changed: r.changed, sha };
}
