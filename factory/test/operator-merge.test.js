import { test, expect } from "vitest";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, chmodSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { operatorMergeVerdict, isOperatorMergePath, OPERATOR_MERGE_GLOBS, OPERATOR_MERGE_EXCLUDES } from "../lib/operator-merge.js";
import { NON_JUDGE_GLOBS, NON_JUDGE_EXCLUDES, ANY_REPO_NON_JUDGE_GLOBS, classifyProtected, ENGINE_MARKERS, isEngineCheckout } from "../lib/non-judge-paths.js";
import { matchesAny } from "../lib/glob.js";

/** 2026-10-02 — 운영 세션의 비판정 머지 판정. 양의 목록이고, 목록 밖은 전부 판정 경로다. */
// #178 rework cf2·cf3: 픽스처는 실제 `gh pr view --json …,changedFiles,files`의 모양이다 — 파일마다 changeType, PR에 changedFiles.
const pr = (over = {}) => {
  const out = {
    number: 12, isDraft: false, mergeable: "MERGEABLE", baseRefName: "main",
    files: [{ path: "docs/research/x.md" }, { path: "docs/factory/ops/watch-issue.sh" }],
    statusCheckRollup: [{ name: "factory/integrity", conclusion: "SUCCESS" }],
    ...over,
  };
  return { changedFiles: out.files.length, ...out, files: out.files.map((f) => ({ changeType: "MODIFIED", ...f })) };
};

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

test("test_178_operator_merge_check_one_root_for_every_read", () => {
  // #178 rework arch1: gh pr view, default_branch, 엔진 판정 — 셋 다 bin이 놓인 체크아웃 하나에서 읽는다.
  // 세션 cwd가 다른 저장소(채택자 클론)여도 PR 조회·기본 브랜치·엔진 여부가 서로 다른 저장소에서 섞이지 않는다.
  const repo = new URL("../../", import.meta.url).pathname;
  const mk = (tag) => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), `omc-${tag}-`)));
    mkdirSync(join(d, ".factory/bin"), { recursive: true });
    mkdirSync(join(d, ".factory/lib"), { recursive: true });
    return d;
  };
  const install = (d) => {
    copyFileSync(join(repo, "factory/bin/operator-merge-check.js"), join(d, ".factory/bin/operator-merge-check.js"));
    for (const f of ["operator-merge.js", "non-judge-paths.js", "glob.js"]) copyFileSync(join(repo, "factory/lib", f), join(d, ".factory/lib", f));
  };
  const asEngine = (d, branch) => {
    writeFileSync(join(d, ".factory/harness.toml"), `[project]\nname           = "know-thy-build"\ndefault_branch = "${branch}"\n`);
    for (const m of ENGINE_MARKERS) { mkdirSync(dirname(join(d, m)), { recursive: true }); writeFileSync(join(d, m), ""); }
  };
  const asAdopter = (d, branch) => writeFileSync(join(d, ".factory/harness.toml"), `[project]\nname           = "my-app"\ndefault_branch = "${branch}"\n`);
  // 가짜 gh: 자기가 돈 cwd를 기록하고, 그 cwd 저장소의 pr.json으로 답한다(없으면 실패) — PR은 cwd가 가리키는 저장소의 것이다.
  const fakebin = realpathSync(mkdtempSync(join(tmpdir(), "omc-fakebin-")));
  writeFileSync(join(fakebin, "gh"), `#!/bin/sh\npwd > "${fakebin}/gh-cwd"\ncat "$PWD/pr.json"\n`);
  chmodSync(join(fakebin, "gh"), 0o755);
  const run = (binRoot, cwd) => spawnSync(process.execPath, [join(binRoot, ".factory/bin/operator-merge-check.js"), "12"], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: `${fakebin}:${process.env.PATH}`, GITHUB_ACTIONS: "" },
  });
  const ghCwd = () => readFileSync(join(fakebin, "gh-cwd"), "utf8").trim();

  // (a) bin = 엔진 체크아웃(기본 브랜치 main), 세션 cwd = 채택자 클론(기본 브랜치 trunk, PR 데이터 없음).
  //     PR은 엔진 저장소에서 조회되고, 기본 브랜치도 엔진의 main이다 → 엔진 모듈 PR이 허용된다.
  const engine = mk("engine"); install(engine); asEngine(engine, "main");
  const adopter = mk("adopter"); asAdopter(adopter, "trunk");
  writeFileSync(join(engine, "pr.json"), JSON.stringify(pr({ baseRefName: "main", files: [{ path: ".factory/lib/status.js" }] })));
  let r = run(engine, adopter);
  expect(ghCwd()).toBe(engine);
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toMatch(/the operator may merge/);

  // (b) bin = 채택자 체크아웃, 세션 cwd = 엔진처럼 보이는 디렉터리(이름 + 표지 + 엔진 파일만 바꾼 PR 데이터).
  //     PR은 채택자 저장소에서 조회되고, 판정도 채택자다 → 채택자의 .factory/lib/status.js 변경은 판정 경로라 거부.
  const adopter2 = mk("adopter2"); install(adopter2); asAdopter(adopter2, "main");
  const engineCwd = mk("enginecwd"); asEngine(engineCwd, "main");
  writeFileSync(join(engineCwd, "pr.json"), JSON.stringify(pr({ files: [{ path: "docs/research/x.md" }] })));
  writeFileSync(join(adopter2, "pr.json"), JSON.stringify(pr({ files: [{ path: ".factory/lib/status.js" }] })));
  r = run(adopter2, engineCwd);
  expect(ghCwd()).toBe(adopter2);
  expect(r.status, r.stderr).toBe(2);
  expect(r.stderr).toMatch(/judge path\(s\) in the PR — a person merges these: \.factory\/lib\/status\.js/);

  // (c) 기본 브랜치는 bin 쪽 harness에서: 엔진 bin의 default_branch가 trunk면, cwd 쪽이 main이어도 main 대상 PR은 거부.
  asEngine(engine, "trunk"); asAdopter(adopter, "main");
  r = run(engine, adopter);
  expect(ghCwd()).toBe(engine);
  expect(r.status, r.stderr).toBe(2);
}, 60000);

test("test_178_operator_merge_refuses_truncated_file_list", () => {
  // #178 rework cf2: gh는 `files(first: 100)`만 읽고 페이지를 넘기지 않는다. 목록이 PR의 changedFiles보다 짧으면 안 본 파일이 있다 — 문은 닫힌다.
  const docs = Array.from({ length: 100 }, (_, i) => ({ path: `docs/a${String(i).padStart(3, "0")}.md` }));
  for (const engine of [false, true]) {
    // 101번째 factory/lib/gates.js는 gh 목록에 없다 — changedFiles만이 그것을 안다
    const cut = operatorMergeVerdict(pr({ files: docs, changedFiles: 101 }), { engine });
    expect(cut.ok, `engine=${engine}`).toBe(false);
    expect(cut.reasons.join("; ")).toMatch(/lists 100 of 101 changed files/);
    // changedFiles가 없거나 음이 아닌 정수가 아니면 목록이 완전한지 알 수 없다 — 거부
    for (const changedFiles of [undefined, null, "100", 100.5, -1]) {
      const v = operatorMergeVerdict({ ...pr({ files: docs }), changedFiles }, { engine });
      expect(v.ok, `changedFiles=${JSON.stringify(changedFiles)}`).toBe(false);
      expect(v.reasons.join("; ")).toMatch(/changedFiles/);
    }
    // 목록이 changedFiles보다 길어도(중복·다른 PR의 데이터) 거부
    expect(operatorMergeVerdict(pr({ files: docs.slice(0, 3), changedFiles: 2 }), { engine }).ok).toBe(false);
    // 완전한 목록(100 = 100)은 그대로 열린다 — 문은 큰 문서 PR을 이유 없이 막지 않는다
    expect(operatorMergeVerdict(pr({ files: docs, changedFiles: 100 }), { engine })).toEqual({ ok: true, reasons: [], judge: [] });
  }
});

test("test_178_operator_merge_refuses_renames_and_copies", () => {
  // #178 rework cf3: GitHub의 PullRequestChangedFile은 새 path만 준다 — RENAMED/COPIED의 원래 경로는 보이지 않는다.
  // CHARTER를 문서 이름으로 옮긴 PR이 도착지만으로 분류되면 CHARTER가 사람 없이 사라진다.
  for (const engine of [false, true]) {
    for (const changeType of ["RENAMED", "COPIED", "renamed"]) {
      for (const path of ["docs/factory/CHARTER-old.md", "docs/x.js", "docs/research/x.md"]) {
        const v = operatorMergeVerdict(pr({ files: [{ path, changeType }] }), { engine });
        expect(v.ok, `${changeType} ${path} engine=${engine}`).toBe(false);
        expect(v.reasons.join("; ")).toMatch(new RegExp(`${changeType.toUpperCase()}.*${path.replace(/[.]/g, "\\.")}`));
      }
    }
    // changeType이 없거나 모르는 값이거나 경로 문자열뿐이면 원래 경로를 알 수 없다 — 닫힌 쪽
    for (const files of [[{ path: "docs/research/x.md" }], [{ path: "docs/research/x.md", changeType: "WEIRD" }], ["docs/research/x.md"]]) {
      const v = operatorMergeVerdict({ ...pr(), files, changedFiles: 1 }, { engine });
      expect(v.ok, JSON.stringify(files)).toBe(false);
      expect(v.reasons.join("; ")).toMatch(/change type/);
    }
    // 경로가 하나뿐인 변경(추가·수정·삭제·타입 변경)은 그 경로로 분류된다
    for (const changeType of ["ADDED", "MODIFIED", "DELETED", "CHANGED"]) {
      expect(operatorMergeVerdict(pr({ files: [{ path: "docs/research/x.md", changeType }] }), { engine }).ok, changeType).toBe(true);
    }
    // 판정 경로의 삭제는 여전히 판정 경로다
    const del = operatorMergeVerdict(pr({ files: [{ path: "docs/factory/CHARTER.md", changeType: "DELETED" }] }), { engine });
    expect(del.ok).toBe(false);
    expect(del.judge).toEqual(["docs/factory/CHARTER.md"]);
  }
});

test("test_178_operator_merge_check_bin_reads_changed_files_and_change_type", () => {
  // bin이 gh에 changedFiles를 요청하는가 — 가짜 gh는 진짜처럼 `--json`으로 요청된 필드만 내보낸다.
  const repo = new URL("../../", import.meta.url).pathname;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omc-cf2-")));
  for (const d of [".factory/bin", ".factory/lib", "fakebin"]) mkdirSync(join(root, d), { recursive: true });
  copyFileSync(join(repo, "factory/bin/operator-merge-check.js"), join(root, ".factory/bin/operator-merge-check.js"));
  for (const f of ["operator-merge.js", "non-judge-paths.js", "glob.js"]) copyFileSync(join(repo, "factory/lib", f), join(root, ".factory/lib", f));
  writeFileSync(join(root, ".factory/harness.toml"), '[project]\nname           = "my-app"\ndefault_branch = "main"\n');
  const fakeGh = [
    `#!${process.execPath}`,
    `const fs = require("fs"), path = require("path");`,
    `const a = process.argv.slice(2), want = a[a.indexOf("--json") + 1].split(",");`,
    `const all = JSON.parse(fs.readFileSync(path.join(__dirname, "pr.json"), "utf8"));`,
    `process.stdout.write(JSON.stringify(Object.fromEntries(want.filter((k) => k in all).map((k) => [k, all[k]]))));`,
  ].join("\n");
  writeFileSync(join(root, "fakebin/gh"), fakeGh);
  chmodSync(join(root, "fakebin/gh"), 0o755);
  const run = (data) => {
    writeFileSync(join(root, "fakebin/pr.json"), JSON.stringify(data));
    return spawnSync(process.execPath, [join(root, ".factory/bin/operator-merge-check.js"), "12"], {
      cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${join(root, "fakebin")}:${process.env.PATH}`, GITHUB_ACTIONS: "" },
    });
  };
  // 완전한 문서 PR — bin이 changedFiles를 요청해야만 열린다
  let r = run(pr());
  expect(r.status, r.stderr).toBe(0);
  // gh가 100개에서 끊은 PR(실제 101개) — 거부
  const docs = Array.from({ length: 100 }, (_, i) => ({ path: `docs/a${i}.md` }));
  r = run(pr({ files: docs, changedFiles: 101 }));
  expect(r.status, r.stderr).toBe(2);
  expect(r.stderr).toMatch(/lists 100 of 101 changed files/);
  // CHARTER를 문서 이름으로 옮긴 PR — 거부
  r = run(pr({ files: [{ path: "docs/factory/CHARTER-old.md", changeType: "RENAMED" }] }));
  expect(r.status, r.stderr).toBe(2);
  expect(r.stderr).toMatch(/RENAMED/);
}, 60000);
