import { test, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { regenerateMirror, mirrorStep, mirrorMatchesHead, inMirrorFamily, MIRROR_FAMILIES } from "../lib/mirror.js";

/**
 * 설계 2026-09-30 §8.3 (S3, KTB #41) — 설치된 엔진(미러)은 러너가 소스에서 다시 만든다. 에이전트는 `.factory/**`에 쓸 수 없고
 * (옳다), 그래서 엔진 PR은 self-mirror 테스트에서 멈췄다. 네 가족만, 설치의 생성 함수 자체로, `init --upgrade` 없이.
 */
const stubRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-mirror-"));
  for (const d of ["factory/cli", "factory/lib", "factory/hooks", ".factory/lib"]) mkdirSync(join(root, d), { recursive: true });
  for (const f of ["manifest.js", "install.js", "init.js"]) writeFileSync(join(root, "factory/cli", f), "// stub\n");
  writeFileSync(join(root, "factory/lib/a.js"), "export const a = 2;\n");
  writeFileSync(join(root, ".factory/lib/a.js"), "export const a = 1;\n");                 // 낡은 설치본
  writeFileSync(join(root, "factory/hooks/h.sh"), "#!/bin/sh\necho new\n");
  return root;
};
const importer = (p) => {
  if (p.endsWith("manifest.js")) return { buildManifest: ({ pkgRoot }) => [
    { src: join(pkgRoot, "factory/lib/a.js"), dest: ".factory/lib/a.js", owner: "factory" },
    { src: join(pkgRoot, "factory/hooks/h.sh"), dest: ".claude/hooks/h.sh", owner: "factory" },
    { src: join(pkgRoot, "templates/x/agent.md"), dest: ".claude/agents/agent.md", owner: "factory" },   // 가족 밖 — 건드리지 않는다
  ] };
  if (p.endsWith("install.js")) return { freshContent: (e, { readFile }) => readFile(e.src) };
  if (p.endsWith("init.js")) return { projectVars: () => ({}) };
  throw new Error("unexpected " + p);
};
/** 1.4.44 — `git add`는 없는 pathspec에 실패하므로 mirrorStep은 디스크에 있는 가족만 올린다; 스텁 런으로 add 호출을 보려면 가족이 디스크에 있어야 한다. */
const famRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-fam-"));
  for (const f of MIRROR_FAMILIES) { if (f.endsWith("/")) mkdirSync(join(root, f), { recursive: true }); else writeFileSync(join(root, f), "{}\n"); }
  return root;
};

test("inMirrorFamily: exactly the four families self-mirror.test.js checks; agents and settings are not mirrored here", () => {
  expect(MIRROR_FAMILIES).toEqual([".factory/lib/", ".factory/bin/", ".factory/actions/", ".claude/hooks/", ".factory/install-manifest.json"]);
  // 1.4.39 — 설치 매니페스트도 생성물이다(트리의 항목 + package.json 버전). review의 overlay가 base의 것을 올리면 `install.test.js`가 RED다(#136).
  for (const d of [".factory/lib/x.js", ".factory/bin/run-stage.js", ".factory/actions/setup/action.yml", ".claude/hooks/block-dangerous.sh", ".factory/install-manifest.json"]) expect(inMirrorFamily(d), d).toBe(true);
  for (const d of [".claude/agents/reviewer-qa.md", ".claude/settings.json", ".claude/hooks/README.md", ".factory/harness.toml", ".factory/install-manifest.json.bak", "docs/factory/CHARTER.md"]) expect(inMirrorFamily(d), d).toBe(false);
});

test("regenerateMirror rewrites only stale family files from the sources, and reports what changed", async () => {
  const root = stubRoot();
  try {
    const dry = await regenerateMirror({ root, write: false, importer });
    expect(dry).toEqual({ ok: true, applicable: true, changed: [".claude/hooks/h.sh", ".factory/lib/a.js"] });
    expect(readFileSync(join(root, ".factory/lib/a.js"), "utf8")).toBe("export const a = 1;\n");   // dry run은 쓰지 않는다
    const r = await regenerateMirror({ root, importer });
    expect(r.changed).toEqual([".claude/hooks/h.sh", ".factory/lib/a.js"]);
    expect(readFileSync(join(root, ".factory/lib/a.js"), "utf8")).toBe("export const a = 2;\n");
    expect(readFileSync(join(root, ".claude/hooks/h.sh"), "utf8")).toBe("#!/bin/sh\necho new\n");
    expect(existsSync(join(root, ".claude/agents/agent.md"))).toBe(false);                      // 가족 밖
    expect(await regenerateMirror({ root, importer })).toEqual({ ok: true, applicable: true, changed: [] });   // 멱등
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("regenerateMirror is not applicable outside the KTB repo (no factory/cli sources) and never throws when a generator breaks", async () => {
  const adopter = mkdtempSync(join(tmpdir(), "ktb-adopter-"));
  try {
    mkdirSync(join(adopter, ".factory/lib"), { recursive: true });
    expect(await regenerateMirror({ root: adopter, importer })).toEqual({ ok: true, applicable: false, changed: [] });
  } finally { rmSync(adopter, { recursive: true, force: true }); }
  const root = stubRoot();
  try {
    const broken = (p) => (p.endsWith("install.js") ? { freshContent: () => { throw new Error("[protected] missing"); } } : importer(p));
    const r = await regenerateMirror({ root, importer: broken });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/\[protected\] missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const fakeRun = (script) => vi.fn(async (cmd, args) => {
  const key = `${cmd} ${args.slice(0, 2).join(" ")}`;
  for (const [k, v] of Object.entries(script)) if (key.startsWith(k)) return { code: 0, stdout: "", stderr: "", ...(typeof v === "function" ? v(args) : v) };
  return { code: 0, stdout: "", stderr: "" };
});

test("mirrorStep(commit): a changed mirror is committed and pushed as the runner, and the new head is returned", async () => {
  const run = fakeRun({ "git diff": { stdout: ".factory/lib/a.js\n" }, "git rev-parse": { stdout: "abc123\n" } });
  const root = famRoot();
  const r = await mirrorStep({ root, run, mode: "commit", headSha: "old", regenerate: async () => ({ ok: true, applicable: true, changed: [".factory/lib/a.js"] }) });
  rmSync(root, { recursive: true, force: true });
  expect(r).toEqual({ ok: true, applicable: true, changed: [".factory/lib/a.js"], sha: "abc123" });
  const calls = run.mock.calls.map(([c, a]) => `${c} ${a.join(" ")}`);
  expect(calls.some((c) => c.startsWith("git add -A -- .factory/lib .factory/bin .factory/actions .claude/hooks .factory/install-manifest.json"))).toBe(true);
  expect(calls.some((c) => /git -c user.name=factory-runner .* commit -q -m mirror: regenerate/.test(c))).toBe(true);
  expect(calls.some((c) => c.startsWith("git push -q origin HEAD"))).toBe(true);
});

test("mirrorStep(commit): nothing to regenerate means no commit, and the head stays", async () => {
  const run = fakeRun({});
  const r = await mirrorStep({ root: "/r", run, mode: "commit", headSha: "h1", regenerate: async () => ({ ok: true, applicable: true, changed: [] }) });
  expect(r).toEqual({ ok: true, applicable: true, changed: [], sha: "h1" });
  expect(run.mock.calls.some(([c, a]) => c === "git" && a[0] === "commit")).toBe(false);
});

test("mirrorStep(verify): the PR's installed engine must be what its sources generate — otherwise undecidable", async () => {
  const clean = fakeRun({});
  expect(await mirrorStep({ root: "/r", run: clean, mode: "verify", headSha: "h1", regenerate: async () => ({ ok: true, applicable: true, changed: [] }) })).toEqual({ ok: true, applicable: true, changed: [], sha: "h1" });
  const dirty = fakeRun({ "git diff": { stdout: ".factory/bin/run-stage.js\n" } });
  const r = await mirrorStep({ root: "/r", run: dirty, mode: "verify", headSha: "h1", regenerate: async () => ({ ok: true, applicable: true, changed: [".factory/bin/run-stage.js"] }) });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/not what its sources generate — \.factory\/bin\/run-stage\.js/);
  expect(dirty.mock.calls.some(([c, a]) => c === "git" && a[0] === "commit")).toBe(false);
});

test("mirrorStep: not applicable is a no-op for every mode", async () => {
  const run = fakeRun({});
  for (const mode of ["commit", "verify"]) expect(await mirrorStep({ root: "/r", run, mode, regenerate: async () => ({ ok: true, applicable: false, changed: [] }) })).toEqual({ ok: true, applicable: false, changed: [], sha: null });
  expect(run).not.toHaveBeenCalled();
});

test("mirrorMatchesHead compares the branch HEAD's mirror files with what the branch's sources generate", async () => {
  const root = stubRoot();
  try {
    const head = { ".factory/lib/a.js": "export const a = 2;\n", ".claude/hooks/h.sh": "#!/bin/sh\necho new\n" };
    const run = vi.fn(async (cmd, args) => (cmd === "git" && args[0] === "show" ? (head[args[1].replace(/^HEAD:/, "")] != null ? { code: 0, stdout: head[args[1].replace(/^HEAD:/, "")], stderr: "" } : { code: 128, stdout: "", stderr: "fatal" }) : { code: 0, stdout: "", stderr: "" }));
    expect(await mirrorMatchesHead({ root, run, importer })).toEqual({ ok: true, applicable: true, mismatched: [] });
    head[".factory/lib/a.js"] = "export const a = 999; // edited by hand\n";
    expect(await mirrorMatchesHead({ root, run, importer })).toEqual({ ok: false, applicable: true, mismatched: [".factory/lib/a.js"] });
    delete head[".claude/hooks/h.sh"];                                    // HEAD에 없는 파일도 불일치다
    expect((await mirrorMatchesHead({ root, run, importer })).mismatched).toEqual([".claude/hooks/h.sh", ".factory/lib/a.js"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
  const adopter = mkdtempSync(join(tmpdir(), "ktb-adopter-"));
  try { expect(await mirrorMatchesHead({ root: adopter, run: vi.fn(), importer })).toEqual({ ok: true, applicable: false, mismatched: [] }); }
  finally { rmSync(adopter, { recursive: true, force: true }); }
});

/**
 * 1.4.38 (KTB #136 실측) — overlay의 `git checkout <base> -- …`는 인덱스도 base로 바꾼다. 재생성 뒤 워크트리가 HEAD와 같아도 인덱스는
 * base이므로 `git status`는 staged 변경을 보고한다. 검증은 워크트리를 HEAD와 직접 비교해야 한다(`git diff HEAD`).
 */
test("mirrorStep(verify): stages the worktree over whatever the overlay left in the index, then compares that with HEAD", async () => {
  const seen = [];
  const run = vi.fn(async (cmd, args) => {
    if (cmd === "git" && args[0] === "status") throw new Error("must not consult the index the overlay staged — stage the worktree first");
    if (cmd === "git") seen.push(args.slice(0, 5).join(" "));
    return { code: 0, stdout: "", stderr: "" };
  });
  const root = famRoot();
  const r = await mirrorStep({ root, run, mode: "verify", headSha: "h1", regenerate: async () => ({ ok: true, applicable: true, changed: [".factory/lib/a.js"] }) });
  rmSync(root, { recursive: true, force: true });
  expect(r.ok).toBe(true);
  // 1.4.44: 순서가 곧 수정이다 — add -A가 diff --cached HEAD보다 먼저
  const addAt = seen.findIndex((c) => c.startsWith("add -A --"));
  expect(addAt).toBeGreaterThanOrEqual(0);
  expect(addAt).toBeLessThan(seen.indexOf("diff --cached --name-only HEAD --"));
});

/**
 * 1.4.44 (KTB #149 실측) — overlay는 PR이 새로 추가한 팩토리 소유 파일을 `git rm`으로 지운다(인덱스와 워크트리). 세션 뒤 재생성이
 * 워크트리에 그 파일을 다시 써도 인덱스에는 삭제가 남아, `git diff HEAD`는 그 경로를 삭제로 보고했다 — 소스가 만드는 것과 같은 설치본을
 * "다르다"고 읽어 리뷰어 다섯의 판정을 두 번 버렸다. 실제 git으로 그 순서를 그대로 밟는다.
 */
test("mirrorStep(verify): a mirror file the PR ADDED, git-rm'd by the overlay and regenerated after the session, is not a mismatch", async () => {
  const root = stubRoot();
  const { execFileSync } = await import("node:child_process");
  const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" });
  const run = async (cmd, args, { cwd } = {}) => {
    try { return { code: 0, stdout: execFileSync(cmd, args, { cwd: cwd || root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }; }
    catch (e) { return { code: e.status ?? 1, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") }; }
  };
  try {
    writeFileSync(join(root, ".factory/lib/a.js"), "export const a = 2;\n");                 // PR head: 설치본 = 소스
    writeFileSync(join(root, ".factory/harness.toml"), "# keeps .factory/ non-empty — git rm prunes empty dirs and mirrorApplicable needs the dir\n");
    mkdirSync(join(root, ".claude/hooks"), { recursive: true });
    writeFileSync(join(root, ".claude/hooks/h.sh"), "#!/bin/sh\necho new\n");
    git("init", "-q", "-b", "main"); git("add", "."); git("commit", "-q", "-m", "pr head: adds .factory/lib/a.js");
    git("rm", "-f", "--quiet", "--", ".factory/lib/a.js");                                   // overlay: base에 없던 파일을 지운다
    expect(existsSync(join(root, ".factory/lib/a.js"))).toBe(false);
    const r = await mirrorStep({ root, run, mode: "verify", headSha: "h1", regenerate: (o) => regenerateMirror({ ...o, importer }) });
    expect(r).toEqual({ ok: true, applicable: true, changed: [], sha: "h1" });
    expect(readFileSync(join(root, ".factory/lib/a.js"), "utf8")).toBe("export const a = 2;\n");
    // 반대로 설치본이 정말 소스와 다르면(손으로 고친 미러) 여전히 걸리고, 사유는 실제로 다른 경로를 적는다
    writeFileSync(join(root, "factory/lib/a.js"), "export const a = 3;\n");
    const bad = await mirrorStep({ root, run, mode: "verify", headSha: "h1", regenerate: (o) => regenerateMirror({ ...o, importer }) });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/not what its sources generate — \.factory\/lib\/a\.js/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60000);
