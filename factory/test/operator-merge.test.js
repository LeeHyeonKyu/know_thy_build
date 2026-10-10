import { test, expect } from "vitest";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, chmodSync, symlinkSync, rmSync, realpathSync } from "node:fs";
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

// ── ADR-039 (2026-10-10, 소유자 결정): 운영 door는 CHARTER `self_change.operator_merge_judge`가 켜지면 판정 경로도 지난다 ──────
test("test_adr039_operator_door_passes_judge_paths_only_when_the_charter_switch_is_on", () => {
  const mixed = pr({ files: [{ path: "docs/research/x.md" }, { path: "factory/lib/gh.js" }, { path: ".github/workflows/factory-merge.yml" }] });
  // 꺼짐(기본): 오늘과 같다 — 판정 경로가 사유에 이름 붙어 거부된다
  const off = operatorMergeVerdict(mixed);
  expect(off.ok).toBe(false); expect(off.judge).toEqual(["factory/lib/gh.js", ".github/workflows/factory-merge.yml"]); expect(off.reasons[0]).toMatch(/judge path/);
  // 켜짐: 판정 경로는 거부 사유가 아니지만 목록은 그대로 돌아온다(호출자가 소리내어 적는다)
  const on = operatorMergeVerdict(mixed, { judgeAllowed: true });
  expect(on).toEqual({ ok: true, reasons: [], judge: ["factory/lib/gh.js", ".github/workflows/factory-merge.yml"] });
  // 나머지 자물쇠는 스위치와 무관하다 — draft·충돌·다른 base·빨간 체크는 켜져 있어도 거부
  expect(operatorMergeVerdict(pr({ files: [{ path: "factory/lib/gh.js" }], isDraft: true }), { judgeAllowed: true }).reasons.join()).toMatch(/draft/);
  expect(operatorMergeVerdict(pr({ files: [{ path: "factory/lib/gh.js" }], mergeable: "CONFLICTING" }), { judgeAllowed: true }).ok).toBe(false);
  expect(operatorMergeVerdict(pr({ files: [{ path: "factory/lib/gh.js" }], statusCheckRollup: [{ name: "factory/integrity", conclusion: "FAILURE" }] }), { judgeAllowed: true }).ok).toBe(false);
  expect(operatorMergeVerdict(pr({ files: [] }), { judgeAllowed: true }).ok).toBe(false);
});

test("test_adr039_the_door_cannot_open_itself", async () => {
  const { DOOR_FILES, isDoorFile } = await import("../lib/operator-merge.js");
  // door를 이루는 파일(판정 코드·양의 목록·bin·훅, 설치본 포함)은 스위치가 켜져도 사람이 머지한다
  for (const f of DOOR_FILES) {
    const v = operatorMergeVerdict(pr({ files: [{ path: "docs/x.md" }, { path: f }] }), { judgeAllowed: true, engine: true });
    expect(v.ok, f).toBe(false); expect(v.reasons.join(), f).toMatch(/the door cannot open itself/);
  }
  expect(isDoorFile("./factory/lib/operator-merge.js")).toBe(true);
  expect(isDoorFile("factory/lib/operator-merge.test.js")).toBe(false);
  // 스위치가 꺼져 있으면 사유는 오늘의 "judge path" 하나다(door 문장은 켜졌을 때의 것)
  expect(operatorMergeVerdict(pr({ files: [{ path: "factory/bin/operator-merge-check.js" }] })).reasons.join()).not.toMatch(/door cannot/);
});

test("test_adr039_operator_merge_check_bin_reads_the_charter_switch", () => {
  // 설치된 bin을 엔진 체크아웃 모양의 임시 루트에서 돌린다 — CHARTER의 스위치만 바꿔 가며 같은 판정 경로 PR을 묻는다.
  const repo = new URL("../../", import.meta.url).pathname;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omc-adr039-")));
  for (const d of [".factory/bin", ".factory/lib", "docs/factory", "fakebin"]) mkdirSync(join(root, d), { recursive: true });
  copyFileSync(join(repo, "factory/bin/operator-merge-check.js"), join(root, ".factory/bin/operator-merge-check.js"));
  for (const f of ["operator-merge.js", "non-judge-paths.js", "glob.js", "config.js", "frontmatter.js"]) copyFileSync(join(repo, "factory/lib", f), join(root, ".factory/lib", f));
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));   // config.js의 smol-toml
  writeFileSync(join(root, ".factory/harness.toml"), '[project]\nname           = "know-thy-build"\ndefault_branch = "main"\n');
  for (const m of ENGINE_MARKERS) { mkdirSync(dirname(join(root, m)), { recursive: true }); writeFileSync(join(root, m), ""); }
  writeFileSync(join(root, "fakebin/gh"), "#!/bin/sh\ncat \"$(dirname \"$0\")/pr.json\"\n");
  chmodSync(join(root, "fakebin/gh"), 0o755);
  const charter = (selfChange) => writeFileSync(join(root, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: ready\n${selfChange}---\n# CHARTER\n`);
  const ask = (files) => {
    writeFileSync(join(root, "fakebin/pr.json"), JSON.stringify(pr({ files })));
    return spawnSync(process.execPath, [join(root, ".factory/bin/operator-merge-check.js"), "12"], {
      cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${join(root, "fakebin")}:${process.env.PATH}`, GITHUB_ACTIONS: "" },
    });
  };
  const judgePr = [{ path: "docs/x.md" }, { path: ".github/workflows/factory-merge.yml" }];
  // 꺼짐(키 없음): 오늘과 같다
  charter(""); let r = ask(judgePr);
  expect(r.status, r.stderr).toBe(2); expect(r.stderr).toMatch(/judge path\(s\) in the PR — a person merges these/);
  // 켜짐: 같은 PR이 허용되고, 허용한 판정 경로를 소리내어 적는다
  charter("self_change: { operator_merge_judge: true }\n"); r = ask(judgePr);
  expect(r.status, r.stderr).toBe(0); expect(r.stdout).toMatch(/1 judge path\(s\) allowed by CHARTER self_change\.operator_merge_judge \(\.github\/workflows\/factory-merge\.yml\)/);
  // 켜져도 door 자신은 안 열린다
  r = ask([{ path: "factory/bin/operator-merge-check.js" }]);
  expect(r.status, r.stderr).toBe(2); expect(r.stderr).toMatch(/the door cannot open itself/);
  // CHARTER가 깨졌으면 꺼진 것으로 보고(fail closed) 그 사실을 stderr에 말한다
  charter("self_change: { operator_merge_judge: \"yes\" }\n"); r = ask(judgePr);
  expect(r.status, r.stderr).toBe(2); expect(r.stderr).toMatch(/CHARTER self_change could not be read .* treating operator_merge_judge as off/);
  // CHARTER 파일이 없어도 같다
  rmSync(join(root, "docs/factory/CHARTER.md")); r = ask(judgePr);
  expect(r.status, r.stderr).toBe(2); expect(r.stderr).toMatch(/treating operator_merge_judge as off/);
}, 60000);

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
