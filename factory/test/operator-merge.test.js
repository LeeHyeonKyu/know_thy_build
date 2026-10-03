import { test, expect } from "vitest";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { operatorMergeVerdict, isOperatorMergePath, OPERATOR_MERGE_GLOBS, OPERATOR_MERGE_EXCLUDES } from "../lib/operator-merge.js";
import { NON_JUDGE_GLOBS, NON_JUDGE_EXCLUDES, ANY_REPO_NON_JUDGE_GLOBS, classifyProtected, ENGINE_MARKERS, isEngineCheckout } from "../lib/non-judge-paths.js";
import { matchesAny } from "../lib/glob.js";

/** 2026-10-02 — 운영 세션의 비판정 머지 판정. 양의 목록이고, 목록 밖은 전부 판정 경로다. */
const pr = (over = {}) => ({
  number: 12, isDraft: false, mergeable: "MERGEABLE", baseRefName: "main",
  files: [{ path: "docs/research/x.md" }, { path: "docs/factory/ops/watch-issue.sh" }],
  statusCheckRollup: [{ name: "factory/integrity", conclusion: "SUCCESS" }],
  ...over,
});

test("non-judge paths are a positive list: docs, research, ops scripts, the board page, engine modules outside the judge closure — nothing under .claude/, .github/", () => {
  for (const p of ["docs/research/x.md", "docs/factory/ops/board-proxy.mjs", "docs/superpowers/plans/p.md", "docs/factory/board/index.html", "templates/factory/docs/factory/board/index.html", "docs/factory/DECISIONS.md"]) {
    expect(isOperatorMergePath(p), p).toBe(true);
  }
  for (const p of ["docs/factory/CHARTER.md", "docs/factory/runs/149.md", "templates/factory/docs/factory/CHARTER.md", "factory/lib/merge-stage.js", "factory/lib/board.js", ".factory/lib/x.js", ".claude/hooks/block-dangerous.sh", ".github/workflows/publish.yml", "package.json", "README.md", "bin/cli.js", "templates/factory/claude/agents/plan-skeptic.md"]) {
    expect(isOperatorMergePath(p), p).toBe(false);
  }
  // #178: 목록은 non-judge-paths.js의 하나다 — 엔진 모듈은 판정 import 닫힘 밖의 것만(board-static·status), .claude/.github은 없다.
  expect(OPERATOR_MERGE_GLOBS.some((g) => g.startsWith(".claude") || g.startsWith(".github"))).toBe(false);
  expect(OPERATOR_MERGE_GLOBS.filter((g) => g.startsWith("factory/lib/") || g.startsWith(".factory/")).every((g) => /(^|\/)lib\/(board-static|status)\.js$/.test(g))).toBe(true);
});

test("test_178_operator_merge_list_is_the_non_judge_list", () => {
  // 같은 객체다 — NON_JUDGE_GLOBS를 바꾸면 운영 세션의 답이 바뀐다(목록이 둘이 될 수 없다).
  expect(OPERATOR_MERGE_GLOBS).toBe(NON_JUDGE_GLOBS);
  expect(OPERATOR_MERGE_EXCLUDES).toBe(NON_JUDGE_EXCLUDES);
  // operator-merge.js는 자체 글롭 상수를 선언하지 않는다 — 경로 리터럴·`Object.freeze([`가 없고, non-judge-paths.js에서 가져온다.
  const src = readFileSync(new URL("../lib/operator-merge.js", import.meta.url), "utf8");
  expect(src).not.toMatch(/Object\.freeze\(\[/);
  expect(src).not.toMatch(/["'`](?:docs|templates|factory|\.factory)\//);
  expect(src).not.toMatch(/["'`][^"'`\n]*\*\*[^"'`\n]*["'`]/);
  expect(src).toMatch(/from\s+["']\.\/non-judge-paths\.js["']/);
  // 표본 경로마다 같은 답 — 엔진 저장소 분류(classifyProtected)와 운영 세션 판정(isOperatorMergePath)이 갈라지지 않는다.
  const samples = [
    "docs/research/x.md", "docs/factory/DECISIONS.md", "docs/factory/ops/watch-issue.sh", "templates/factory/docs/factory/board/index.html",
    "factory/lib/board-static.js", ".factory/lib/status.js", "factory/test/status.test.js",
    "docs/factory/CHARTER.md", "docs/factory/runs/149.md", "templates/factory/docs/factory/CHARTER.md", "docs/CLAUDE.md",
    "factory/lib/aggregate.js", "factory/lib/board.js", "factory/lib/heartbeat.js", "factory/lib/gh.js", "factory/test/aggregate.test.js",
    ".claude/hooks/block-dangerous.sh", "package.json", "README.md", "docs/../factory/lib/gh.js",
  ];
  for (const p of samples) {
    const nonJudge = classifyProtected([p], { engine: true }).non_judge.length === 1;
    expect(isOperatorMergePath(p, { engine: true }), p).toBe(nonJudge);
  }
  // 합쳐진 목록이 엔진 저장소의 운영 세션에 새로 연 것과, 여전히 사람에게 가는 것.
  expect(isOperatorMergePath("factory/lib/status.js", { engine: true })).toBe(true);
  expect(isOperatorMergePath("factory/lib/aggregate.js", { engine: true })).toBe(false);
  // CHARTER 둘은 여전히 판정 경로다 — operatorMergeVerdict가 그 PR을 사람에게 보낸다.
  for (const p of ["docs/factory/CHARTER.md", "templates/factory/docs/factory/CHARTER.md"]) {
    const v = operatorMergeVerdict(pr({ files: [{ path: "docs/research/x.md" }, { path: p }] }));
    expect(v.ok, p).toBe(false);
    expect(v.judge, p).toEqual([p]);
  }
  // 운영 세션 범위가 넓어진 자리(엔진 저장소에서만): 판정 닫힘 밖의 엔진 모듈만 바꾼 GREEN PR은 허용된다.
  expect(operatorMergeVerdict(pr({ files: [{ path: "factory/lib/status.js" }, { path: "factory/test/status.test.js" }] }), { engine: true })).toEqual({ ok: true, reasons: [], judge: [] });
});

test("a docs-only, green, non-draft PR against the default branch is allowed; each failed lock names itself", () => {
  expect(operatorMergeVerdict(pr())).toEqual({ ok: true, reasons: [], judge: [] });
  const judge = operatorMergeVerdict(pr({ files: [{ path: "docs/research/x.md" }, { path: "factory/lib/gh.js" }] }));
  expect(judge.ok).toBe(false); expect(judge.judge).toEqual(["factory/lib/gh.js"]); expect(judge.reasons[0]).toMatch(/judge path/);
  expect(operatorMergeVerdict(pr({ isDraft: true })).reasons.join()).toMatch(/draft/);
  expect(operatorMergeVerdict(pr({ mergeable: "CONFLICTING" })).reasons.join()).toMatch(/not mergeable \(CONFLICTING\)/);
  expect(operatorMergeVerdict(pr({ baseRefName: "release/1.4.42" })).reasons.join()).toMatch(/targets release\/1\.4\.42, not main/);
  expect(operatorMergeVerdict(pr({ statusCheckRollup: [{ name: "factory/integrity", conclusion: "FAILURE" }] })).reasons.join()).toMatch(/factory\/integrity=FAILURE/);
  expect(operatorMergeVerdict(pr({ statusCheckRollup: [{ context: "ci", state: "PENDING" }] })).reasons.join()).toMatch(/ci=PENDING/);
  expect(operatorMergeVerdict(pr({ files: [] })).reasons.join()).toMatch(/no changed files/);
  // 체크가 하나도 없는 저장소(채택 저장소)는 체크 조건을 통과한다 — 경로·draft·mergeable이 문이다
  expect(operatorMergeVerdict(pr({ statusCheckRollup: [] })).ok).toBe(true);
  // 기본 브랜치는 호출자가 준다
  expect(operatorMergeVerdict(pr({ baseRefName: "trunk" }), { defaultBranch: "trunk" }).ok).toBe(true);
});

// ── #178 rework (cf1·arch1): 운영 세션의 문은 엔진 저장소에서만 엔진 파일을 연다 ─────────────────────────────────────

/** #178 이전의 운영 세션 목록 — 채택자 저장소의 문은 이것과 같은 답을 내야 한다(이 이슈는 어느 저장소의 머지 동작도 바꾸지 않는다). */
const preIssueDoor = (p) => matchesAny(["docs/**", "templates/factory/docs/**"], p)
  && !matchesAny(["docs/factory/CHARTER.md", "docs/factory/runs/**", "templates/factory/docs/factory/CHARTER.md"], p);

test("test_178_operator_merge_door_is_engine_gated", () => {
  // 채택자 저장소(engine 미지정·false·truthy 비불리언)에서 설치된 엔진 파일과 채택자의 factory/** 는 판정 경로다 — 사람이 머지한다.
  const engineFiles = [".factory/lib/status.js", ".factory/lib/board-static.js", "factory/lib/status.js", "factory/lib/board-static.js", "factory/test/status.test.js", "factory/test/board-page.test.js"];
  for (const opts of [undefined, {}, { engine: false }, { engine: "true" }, { engine: 1 }]) {
    for (const p of engineFiles) {
      expect(isOperatorMergePath(p, opts), `${p} ${JSON.stringify(opts)}`).toBe(false);
      // 같은 파일을 엔진 맥락의 classifyProtected도 엔진 밖에서는 judge라 한다 — 두 분류가 갈라지지 않는다.
      expect(classifyProtected([p], opts).judge, p).toEqual([p]);
    }
    const v = operatorMergeVerdict(pr({ files: [{ path: "docs/research/x.md" }, { path: ".factory/lib/status.js" }] }), opts);
    expect(v.ok, JSON.stringify(opts)).toBe(false);
    expect(v.judge).toEqual([".factory/lib/status.js"]);
    expect(v.reasons[0]).toMatch(/judge path/);
    expect(operatorMergeVerdict(pr({ files: [{ path: ".factory/lib/board-static.js" }] }), opts).ok).toBe(false);
    expect(operatorMergeVerdict(pr({ files: [{ path: "factory/lib/status.js" }, { path: "factory/test/status.test.js" }] }), opts).ok).toBe(false);
    // 문서 PR은 채택자 저장소에서도 예전처럼 열린다
    expect(operatorMergeVerdict(pr(), opts).ok).toBe(true);
  }
  // 채택자 저장소의 문은 #178 이전 목록과 표본마다 같은 답이다
  const samples = [
    "docs/research/x.md", "docs/factory/DECISIONS.md", "docs/factory/ops/watch-issue.sh", "templates/factory/docs/factory/board/index.html",
    "docs/factory/CHARTER.md", "docs/factory/runs/149.md", "templates/factory/docs/factory/CHARTER.md",
    ...engineFiles, "factory/lib/gh.js", ".factory/lib/merge-stage.js", ".claude/hooks/block-dangerous.sh", "package.json", "README.md",
  ];
  for (const p of samples) expect(isOperatorMergePath(p), p).toBe(preIssueDoor(p));
  // 채택자 쪽 단면은 하나의 목록의 부분집합이다(목록이 둘이 되지 않는다)
  expect(ANY_REPO_NON_JUDGE_GLOBS.length).toBeGreaterThan(0);
  expect(ANY_REPO_NON_JUDGE_GLOBS.every((g) => NON_JUDGE_GLOBS.includes(g))).toBe(true);
  // 엔진 저장소에서만 판정 닫힘 밖의 엔진 모듈이 열린다
  for (const p of engineFiles) expect(isOperatorMergePath(p, { engine: true }), p).toBe(true);
  expect(operatorMergeVerdict(pr({ files: [{ path: ".factory/lib/status.js" }] }), { engine: true }).ok).toBe(true);
});

test("test_178_operator_merge_check_knows_the_engine", () => {
  // 순수 판정: 프로젝트 이름과 엔진 표지 파일이 **모두** 있어야 엔진 저장소다. 하나라도 빠지면 채택자(닫힌 쪽).
  const all = () => true;
  expect(ENGINE_MARKERS.length).toBeGreaterThan(0);
  expect(isEngineCheckout({ projectName: "know-thy-build", exists: all })).toBe(true);
  expect(isEngineCheckout({ projectName: "my-app", exists: all })).toBe(false);
  expect(isEngineCheckout({ projectName: undefined, exists: all })).toBe(false);
  for (const missing of ENGINE_MARKERS) {
    expect(isEngineCheckout({ projectName: "know-thy-build", exists: (p) => p !== missing }), missing).toBe(false);
  }
  expect(isEngineCheckout({})).toBe(false);
  // 이 체크아웃은 엔진이다 — 표지가 실제로 있다
  const repo = new URL("../../", import.meta.url).pathname;
  expect(ENGINE_MARKERS.every((m) => existsSync(join(repo, m)))).toBe(true);
});

test("test_178_operator_merge_check_bin_refuses_engine_files_in_an_adopter", () => {
  // 설치된 bin을 채택자 저장소 모양의 임시 루트에서 돌린다 — gh는 PATH의 가짜(이 PR이 .factory/lib/status.js만 바꿨다고 답한다).
  const repo = new URL("../../", import.meta.url).pathname;
  const root = mkdtempSync(join(tmpdir(), "omc-bin-"));
  for (const d of [".factory/bin", ".factory/lib", "fakebin"]) mkdirSync(join(root, d), { recursive: true });
  copyFileSync(join(repo, "factory/bin/operator-merge-check.js"), join(root, ".factory/bin/operator-merge-check.js"));
  for (const f of ["operator-merge.js", "non-judge-paths.js", "glob.js"]) copyFileSync(join(repo, "factory/lib", f), join(root, ".factory/lib", f));
  writeFileSync(join(root, "fakebin/pr.json"), JSON.stringify(pr({ files: [{ path: ".factory/lib/status.js" }] })));
  writeFileSync(join(root, "fakebin/gh"), "#!/bin/sh\ncat \"$(dirname \"$0\")/pr.json\"\n");
  chmodSync(join(root, "fakebin/gh"), 0o755);
  const run = () => spawnSync(process.execPath, [join(root, ".factory/bin/operator-merge-check.js"), "12"], {
    cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${join(root, "fakebin")}:${process.env.PATH}`, GITHUB_ACTIONS: "" },
  });
  // 채택자: harness의 이름이 다르고 엔진 표지가 없다 → 거부, 사유는 판정 경로
  writeFileSync(join(root, ".factory/harness.toml"), '[project]\nname           = "my-app"\ndefault_branch = "main"\n');
  let r = run();
  expect(r.status, r.stderr).toBe(2);
  expect(r.stderr).toMatch(/judge path\(s\) in the PR — a person merges these: \.factory\/lib\/status\.js/);
  // 이름만 엔진과 같아도(표지 없음) 여전히 거부
  writeFileSync(join(root, ".factory/harness.toml"), '[project]\nname           = "know-thy-build"\ndefault_branch = "main"\n');
  r = run();
  expect(r.status, r.stderr).toBe(2);
  // 엔진 체크아웃(이름 + 표지 전부) → 같은 PR이 허용된다
  for (const m of ENGINE_MARKERS) { mkdirSync(dirname(join(root, m)), { recursive: true }); writeFileSync(join(root, m), ""); }
  r = run();
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toMatch(/the operator may merge/);
}, 60000);
