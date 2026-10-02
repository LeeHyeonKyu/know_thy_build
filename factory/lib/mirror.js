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
export const MIRROR_FAMILIES = [".factory/lib/", ".factory/bin/", ".factory/actions/", ".claude/hooks/", ".factory/install-manifest.json"];

/**
 * 1.4.39 (KTB #136 실측) — `.factory/install-manifest.json`도 생성물이다(`generate: "install-manifest"`, 트리의 항목과 `package.json`
 * 버전에서 나온다). 가족에 없어서 review의 overlay가 base(1.4.38)의 매니페스트를 1.4.37 PR 트리에 올렸고 `install.test.js`가 RED였다.
 */
export const inMirrorFamily = (dest) => MIRROR_FAMILIES.some((f) => (f.endsWith("/") ? (f === ".claude/hooks/" ? dest.startsWith(f) && dest.endsWith(".sh") : dest.startsWith(f)) : dest === f));

/**
 * 1.4.39 — **추가 전용 파일은 합집합으로 병합한다.** `docs/factory/DECISIONS.md`는 모든 변경이 파일 끝에 덧붙이므로 브랜치와 base가
 * 함께 움직이면 반드시 충돌한다(#130·#136 둘 다). 양쪽이 덧붙인 것을 모두 남기는 것이 언제나 옳은 답이다(`git merge-file --union`).
 */
export const UNION_MERGE_PATHS = ["docs/factory/DECISIONS.md"];
export const isUnionMergePath = (p) => UNION_MERGE_PATHS.includes(p);

/**
 * 네 가족을 소스에서 다시 만들어 트리에 쓴다. 순수하지 않지만 결정적이다: 같은 소스면 같은 바이트.
 * @returns {{ok:boolean, applicable:boolean, changed:string[], reason?:string}}
 */
/** 이 저장소에서 미러 단계가 성립하는가 — 소스 `factory/cli/**`와 설치본 `.factory/`가 함께 있을 때(= KTB 자신). */
export const mirrorApplicable = (root) => existsSync(join(root, "factory/cli/manifest.js")) && existsSync(join(root, "factory/cli/install.js")) && existsSync(join(root, ".factory"));

/** 생성기와 가족 항목을 읽는다. 실패는 `{reason}`으로 돌려준다 — 호출자 둘(재생성·HEAD 대조)이 같은 실패 문장을 낸다. */
async function loadMirrorGenerators({ root, importer }) {
  let buildManifest, freshContent, projectVars;
  try {
    ({ buildManifest } = await importer(join(root, "factory/cli/manifest.js")));
    ({ freshContent } = await importer(join(root, "factory/cli/install.js")));
    ({ projectVars } = await importer(join(root, "factory/cli/init.js")));
  } catch (e) { return { reason: `mirror generators could not be loaded — ${e?.message || e}` }; }
  try {
    const vars = projectVars(root, root);
    const entries = buildManifest({ pkgRoot: root }).filter((e) => inMirrorFamily(e.dest));
    return { entries, fresh: (e) => freshContent(e, { readFile: (p) => readFileSync(p, "utf8"), vars }) };
  } catch (e) { return { reason: `mirror manifest could not be built — ${e?.message || e}` }; }
}

export async function regenerateMirror({ root, write = true, importer = (p) => import(pathToFileURL(p).href) } = {}) {
  if (!mirrorApplicable(root)) return { ok: true, applicable: false, changed: [] };
  const g = await loadMirrorGenerators({ root, importer });
  if (g.reason) return { ok: false, applicable: true, changed: [], reason: g.reason };
  const changed = [];
  for (const e of g.entries) {
    let fresh;
    try { fresh = g.fresh(e); }
    catch (err) { return { ok: false, applicable: true, changed, reason: `${e.dest}: ${err?.message || err}` }; }
    const dest = join(root, ...e.dest.split("/"));
    const current = existsSync(dest) ? readFileSync(dest, "utf8") : null;
    if (current === fresh) continue;
    changed.push(e.dest);
    if (write) { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, fresh); }
  }
  return { ok: true, applicable: true, changed: changed.sort(), entries: g.entries.map((e) => e.dest) };
}

/**
 * **HEAD(브랜치)의 미러가 그 브랜치의 소스에서 생성되는 것과 같은가.** implement의 재시도 런에서 overlay가 "브랜치가 팩토리 소유
 * 경로를 바꿨다"고 볼 때, 그 경로가 전부 미러 가족이고 이 대조가 참이면 그것은 빌더의 변경이 아니라 러너의 생성물이다(KTB #130 실측:
 * 첫 런의 미러 커밋이 두 번째 런에서 거부됐다). 워크트리가 아니라 `git show HEAD:<path>`와 대조한다 — overlay가 워크트리를 이미
 * base로 되돌린 뒤에도 옳은 답을 내야 한다.
 * @returns {{ok:boolean, applicable:boolean, mismatched:string[], reason?:string}}
 */
export async function mirrorMatchesHead({ root, run, importer = (p) => import(pathToFileURL(p).href) } = {}) {
  if (!mirrorApplicable(root)) return { ok: true, applicable: false, mismatched: [] };
  const g = await loadMirrorGenerators({ root, importer });
  if (g.reason) return { ok: false, applicable: true, mismatched: [], reason: g.reason };
  const mismatched = [];
  for (const e of g.entries) {
    let fresh;
    try { fresh = g.fresh(e); } catch (err) { return { ok: false, applicable: true, mismatched, reason: `${e.dest}: ${err?.message || err}` }; }
    const at = await run("git", ["show", `HEAD:${e.dest}`], { cwd: root });
    if (at.code !== 0 || at.stdout !== fresh) mismatched.push(e.dest);
  }
  return { ok: mismatched.length === 0, applicable: true, mismatched: mismatched.sort() };
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
  r.entries = Array.isArray(r.entries) ? r.entries : [];     // 옛 regenerate 더블(테스트)은 entries를 주지 않는다 — HEAD의 것만 판정한다
  const families = MIRROR_FAMILIES.map((f) => f.replace(/\/$/, ""));
  /**
   * 1.4.38 (KTB #136 실측) — **워크트리를 HEAD와 직접 비교한다, 인덱스가 아니라.** review·merge의 overlay는 `git checkout <base> -- …`로
   * 미러 경로를 base로 되돌리는데 그 명령은 **인덱스도** base로 바꾼다. 재생성 뒤 워크트리는 PR head와 같아졌지만 인덱스는 base라
   * `git status`가 "staged" 변경을 보고했고, 검증은 소스와 같은 설치본을 "다르다"고 읽었다 — 리뷰어 5명의 판정을 두 번 버렸다.
   * `git diff HEAD`는 인덱스를 거치지 않는다.
   */
  /**
   * 1.4.44 (KTB #149 실측, 같은 과의 여덟째) — **인덱스를 워크트리로 먼저 맞춘다, 그다음 HEAD와 비교한다.** `git diff HEAD`도 인덱스를
   * 완전히 비켜 가지는 못한다: overlay는 PR이 **새로 추가한** 팩토리 소유 파일을 `git rm`으로 지우는데(인덱스와 워크트리 모두), 세션 뒤
   * 재생성이 그 파일을 워크트리에 다시 써도 인덱스에는 "삭제"가 남아 `git diff HEAD`는 그 경로를 삭제된 것으로 보고한다. #149가 처음으로
   * 미러 가족에 파일 하나(`.factory/lib/non-judge-paths.js`)를 **추가**했고, 리뷰어 다섯의 판정을 두 번 버렸다. `git add -A -- <families>`로
   * 워크트리의 사실을 인덱스에 올리면(overlay가 base로 되돌린 것도, 지운 것도 전부 덮인다) `git diff --cached HEAD`가 "워크트리 ≠ HEAD"를
   * 정확히 말한다. verify에서 스테이징은 무해하다 — review·merge는 detached HEAD이고 커밋하지 않는다. commit 모드는 어차피 add가 필요했다.
   * 실패 사유에는 재생성이 바꾼 목록이 아니라 **실제로 HEAD와 다른 경로**를 적는다(#149의 사유는 overlay가 되돌린 일곱을 적어 원인을 가렸다).
   */
  // `git add`는 아무것도 매치하지 않는 pathspec에 실패한다(`diff`와 다르다) — 디스크에 있는 가족만 올린다. 통째로 사라진 가족은
  // 어차피 아래 diff가 HEAD와의 차이로 보고한다.
  const present = families.filter((f) => existsSync(join(root, ...f.split("/"))));
  const add = present.length ? await run("git", ["add", "-A", "--", ...present], { cwd: root }) : { code: 0 };
  if (add.code !== 0) return { ok: false, applicable: true, changed: r.changed, sha: null, reason: `mirror add failed: ${add.stderr?.trim() || `exit ${add.code}`}` };
  const diff = await run("git", ["diff", "--cached", "--name-only", "HEAD", "--", ...families], { cwd: root });
  if (diff.code !== 0) return { ok: false, applicable: true, changed: r.changed, sha: null, reason: `mirror diff could not be read: ${diff.stderr?.trim() || `exit ${diff.code}`}` };
  /**
   * 1.4.45 (KTB #156 실측, 같은 과의 아홉째) — **base가 그 사이 추가한 미러 파일은 이 PR의 것이 아니다.** #155가 main에 새 엔진 파일 둘
   * (`operator-merge.js`·`operator-merge-check.js`와 그 미러)을 더하는 동안 #156은 그 전의 main에서 갈라져 있었다. review의 overlay는
   * base의 `.factory/**`를 워크트리와 인덱스에 올리므로 그 두 미러 파일이 "HEAD에 없는데 인덱스에 있는" 상태가 되고, 위의 add -A가
   * 그 사실을 그대로 둬 `diff --cached HEAD`가 둘을 "추가됨"으로 보고했다 — PR의 소스에는 그 파일이 없으니 재생성은 손대지 않는다.
   * 판정 대상은 **HEAD에 있는 미러 경로 ∪ 이 PR의 소스가 만드는 경로**뿐이다. 그 밖의 경로는 overlay가 base에서 가져온 것이고,
   * 머지 뒤 main에 그대로 있을 파일이다. (base가 그 사이 **바꾼** 파일은 HEAD에 있으므로 여전히 대조된다 — 그것은 S3b의 base 병합이
   * 브랜치에 들여온 뒤 재생성된 것이어야 한다.)
   */
  const inHead = await run("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", ...families], { cwd: root });
  if (inHead.code !== 0) return { ok: false, applicable: true, changed: r.changed, sha: null, reason: `mirror HEAD listing could not be read: ${inHead.stderr?.trim() || `exit ${inHead.code}`}` };
  const owned = new Set([...inHead.stdout.split("\n").map((l) => l.trim()).filter(Boolean), ...r.entries]);
  const dirty = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean).filter((p) => owned.has(p));
  if (mode === "verify") {
    if (dirty.length) return { ok: false, applicable: true, changed: r.changed, sha: headSha, reason: `the installed engine in this PR is not what its sources generate — ${dirty.slice(0, 8).join(", ")}${dirty.length > 8 ? ", …" : ""} (regenerate with the runner's mirror step, never by hand)` };
    return { ok: true, applicable: true, changed: [], sha: headSha };
  }
  if (!dirty.length) return { ok: true, applicable: true, changed: [], sha: headSha };
  const commit = await run("git", ["-c", "user.name=factory-runner", "-c", "user.email=factory-runner@users.noreply.github.com", "commit", "-q", "-m", `${message}\n\n${r.changed.join("\n")}`], { cwd: root });
  if (commit.code !== 0) return { ok: false, applicable: true, changed: r.changed, sha: null, reason: `mirror commit failed: ${commit.stderr?.trim() || `exit ${commit.code}`}` };
  const sha = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const push = await run("git", ["push", "-q", "origin", "HEAD"], { cwd: root });
  if (push.code !== 0) return { ok: false, applicable: true, changed: r.changed, sha, reason: `mirror push failed: ${push.stderr?.trim() || `exit ${push.code}`}` };
  return { ok: true, applicable: true, changed: r.changed, sha };
}
