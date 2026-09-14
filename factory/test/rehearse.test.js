import { test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FINGERPRINT_PATHS, REHEARSAL_STALE, REHEARSAL_STATUS_CONTEXT, REHEARSAL_VARIABLE, REHEARSAL_WORKFLOW,
  charterFrontmatter, checkRehearsalCurrent, fingerprintShaLocal, fingerprintShaRemote, firstTestName, makeRehearsalChecker,
  pickFile, recordRehearsal, recordedRehearsal, rehearsalArtifactName, rehearsalGate, rehearsalHash, rehearsalOk,
  rehearsalReport, renderRehearsalTable, runRehearsal,
} from "../lib/rehearsal.js";
import { REHEARSAL_UNWIRED, transition } from "../lib/transition.js";
import { checkRehearsal } from "../lib/doctor/factory.js";
import { lintWorkflow } from "../lib/yml-lint.js";
import { rehearseCommand } from "../cli/rehearse.js";

const repoRoot = new URL("../../", import.meta.url).pathname;

const HARNESS = {
  schema: 1,
  project: { default_branch: "main" },
  runtime: { setup: "npm ci" },
  commands: {
    lint: "node factory/bin/lint.js",
    unit: "npx vitest run",
    test_files: "npx vitest run {files}",
    test_one: "npx vitest run {file} -t {name}",
    lint_file: "node factory/bin/lint.js --file {file}",
  },
  test: { test_glob: ["factory/test/**/*.test.js"], source_glob: ["factory/**/*.js"] },
};
const FILES = ["factory/lib/labels.js", "factory/test/labels.test.js", "README.md"];
const TEST_FILE_TEXT = `import { test } from "vitest";\ntest("labels: the graph refuses a skip", () => {});\n`;

/** 모든 명령을 GREEN으로 돌려주는 실행기 — 테스트가 한 스텝만 빨갛게 바꾼다. */
function fakeRun(overrides = []) {
  const calls = [];
  const run = async (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    const line = [cmd, ...args].join(" ");
    for (const o of overrides) if (o.match(line)) return { code: o.code ?? 1, stdout: o.stdout ?? "", stderr: o.stderr ?? "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  run.calls = calls;
  return run;
}

const rehearse = (opts = {}) => runRehearsal({
  run: opts.run || fakeRun(),
  cwd: "/repo",
  harness: opts.harness || HARNESS,
  files: opts.files || FILES,
  runId: "9001",
  baseline: { ok: true, entries: [] },
  readFile: opts.readFile || (() => TEST_FILE_TEXT),
  qaProbe: opts.qaProbe || (async () => ({ ok: true, detail: ".factory/out/qa writable" })),
  cleanCheck: opts.cleanCheck || (async () => ({ ok: true, dirty: [] })),
  now: (() => { let t = 0; return () => (t += 1000); })(),
  ...(opts.extra || {}),
});

// ── hash ────────────────────────────────────────────────────────────────────
test("rehearsalHash: the fingerprint covers harness.toml and the CHARTER frontmatter, not the CHARTER prose", () => {
  const a = rehearsalHash({ harnessText: "schema = 1\n", charterText: "---\nstatus: ready\n---\n# body\n" });
  const sameProseChanged = rehearsalHash({ harnessText: "schema = 1\n", charterText: "---\nstatus: ready\n---\n# other body\n" });
  const harnessChanged = rehearsalHash({ harnessText: "schema = 2\n", charterText: "---\nstatus: ready\n---\n# body\n" });
  const charterChanged = rehearsalHash({ harnessText: "schema = 1\n", charterText: "---\nstatus: draft\n---\n# body\n" });
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(sameProseChanged).toBe(a);           // 산문은 게이트를 바꾸지 않는다
  expect(harnessChanged).not.toBe(a);
  expect(charterChanged).not.toBe(a);
});

test("rehearsalHash: the digest is pinned, and the module that computes it is text (never binary)", () => {
  // 리뷰 must_fix 1 — 구분자는 NUL 바이트였고, 그 두 바이트가 이 모듈을 git에게 **binary**로 보이게 해서
  // `git diff`가 내용을 영영 보여주지 않았다(게이트를 정의하는 파일이 리뷰 면제가 된다). 이스케이프로
  // 고쳤고, 해시되는 바이트는 같아야 한다 — 바뀌면 모든 채택 저장소의 기록된 리허설이 무효가 된다.
  expect(rehearsalHash({ harnessText: "schema = 1\n", charterText: "---\nstatus: ready\n---\n" }))
    .toBe("a644e30c67f0b57e6128263308dfc1dd4c7029adc1c3ba8e824ea6a8af8d6b1b");
  for (const f of ["factory/lib/rehearsal.js", "factory/bin/rehearse.js"]) {
    expect(readFileSync(join(repoRoot, f), "utf8").includes(String.fromCharCode(0)), f).toBe(false);
  }
});

test("charterFrontmatter: no frontmatter is an empty block, not a throw", () => {
  expect(charterFrontmatter("# just prose")).toBe("");
  expect(charterFrontmatter("---\na: 1\n---\nbody")).toBe("a: 1");
});

// ── step selection ──────────────────────────────────────────────────────────
test("pickFile / firstTestName: the rehearsal uses a real file and a real test name from the repo", () => {
  expect(pickFile(FILES, ["factory/test/**/*.test.js"])).toBe("factory/test/labels.test.js");
  expect(pickFile(FILES, ["nothing/**"])).toBe(null);
  expect(firstTestName(TEST_FILE_TEXT)).toBe("labels: the graph refuses a skip");
  expect(firstTestName(`it('a name', () => {})`)).toBe("a name");
  expect(firstTestName("no tests here")).toBe(null);
});

// ── runner ──────────────────────────────────────────────────────────────────
test("runRehearsal: every stage-shaped step runs on the runner, in order, and a clean repo is all GREEN", async () => {
  const run = fakeRun();
  const { steps } = await rehearse({ run });
  expect(steps.map((s) => s.name)).toEqual([
    "lint", "unit", "test_files", "test_one", "lint_file", "qa-evidence", "clean-check", "prove-test", "gh-auth", "gh-labels", "gh-push",
  ]);
  expect(steps.every((s) => s.status === "GREEN")).toBe(true);
  expect(rehearsalOk(steps)).toBe(true);
  // 명령은 하네스의 것 그대로 — 자리표시자가 실제 파일·테스트 이름으로 채워진다.
  const cmds = steps.map((s) => s.cmd).filter(Boolean).join("\n");
  expect(cmds).toMatch(/npx vitest run 'factory\/test\/labels\.test\.js'/);
  expect(cmds).toMatch(/-t 'labels: the graph refuses a skip'/);
  expect(cmds).toMatch(/node factory\/bin\/lint\.js --file 'factory\/lib\/labels\.js'/);
  expect(cmds).toMatch(/gh api user/);
  expect(cmds).toMatch(/gh label list/);
  expect(cmds).toMatch(/factory\/rehearsal-9001/);
  // 모든 명령에는 상한이 있다 — 러너에서 무한히 도는 게이트는 리허설이 아니라 새 사고다.
  for (const c of run.calls.filter((x) => x.cmd === "bash")) expect(c.args[1]).toMatch(/^timeout -k \d+ \d+ bash -lc /);
});

test("runRehearsal: a failing command is RED and carries only the first 3 lines of its output", async () => {
  const run = fakeRun([{ match: (l) => /bash -lc 'npx vitest run'$/.test(l), code: 1, stdout: "l1\nl2\nl3\nl4\nl5" }]);
  const { steps } = await rehearse({ run });
  const unit = steps.find((s) => s.name === "unit");
  expect(unit.status).toBe("RED");
  expect(unit.detail.split("\n")).toHaveLength(3);
  expect(unit.detail).toContain("l1");
  expect(unit.detail).not.toContain("l4");
  expect(rehearsalOk(steps)).toBe(false);
  // 첫 RED가 나머지를 삼키지 않는다 — 한 번의 리허설이 결함을 **전부** 보여줘야 라운드가 줄어든다.
  expect(steps.filter((s) => s.status === "GREEN").length).toBeGreaterThan(5);
});

test("runRehearsal: an exit 127 (the own-calendar `[runtime].setup` defect) is RED with the command in the row", async () => {
  const run = fakeRun([{ match: (l) => /'node factory\/bin\/lint\.js'$/.test(l), code: 127, stderr: "flutter: command not found" }]);
  const { steps } = await rehearse({ run });
  const lint = steps.find((s) => s.name === "lint");
  expect(lint.status).toBe("RED");
  expect(lint.detail).toMatch(/command not found/);
  expect(lint.cmd).toBe("node factory/bin/lint.js");
});

test("runRehearsal: a killed gate (exit 137) reads as a timeout, not as an ordinary failure", async () => {
  // 리뷰 should_fix 7 — `timeout -k 10`은 SIGTERM을 무시하는 명령을 SIGKILL로 올리고, 셸은 137로 보고한다.
  // 상한이 존재하는 이유인 "멈춘 게이트"가 가장 그렇게 끝난다.
  const run = fakeRun([{ match: (l) => /bash -lc 'npx vitest run'$/.test(l), code: 137, stderr: "" }]);
  const { steps } = await rehearse({ run });
  const unit = steps.find((s) => s.name === "unit");
  expect(unit.status).toBe("RED");
  expect(unit.detail).toMatch(/timed out after 1800s \(killed by signal 9\)/);

  const timedOut = fakeRun([{ match: (l) => /bash -lc 'npx vitest run'$/.test(l), code: 124 }]);
  expect((await rehearse({ run: timedOut })).steps.find((s) => s.name === "unit").detail).toMatch(/timed out after 1800s/);
});

test("runRehearsal: a missing test name or command is SKIPPED with a reason — never a silent GREEN", async () => {
  const { steps } = await rehearse({ readFile: () => "// a file with no tests" });
  const one = steps.find((s) => s.name === "test_one");
  expect(one.status).toBe("SKIPPED");
  expect(one.detail).toMatch(/no test name/i);

  const noLintFile = await rehearse({ harness: { ...HARNESS, commands: { ...HARNESS.commands, lint_file: undefined } } });
  const lf = noLintFile.steps.find((s) => s.name === "lint_file");
  expect(lf.status).toBe("SKIPPED");
  expect(lf.detail).toMatch(/lint_file/);

  const noTests = await rehearse({ files: ["README.md"] });
  expect(noTests.steps.find((s) => s.name === "test_files").status).toBe("SKIPPED");
  expect(noTests.steps.find((s) => s.name === "test_files").detail).toMatch(/test_glob/);
});

test("runRehearsal: the qa evidence probe and the no-write clean check are judged, not assumed", async () => {
  const { steps } = await rehearse({
    qaProbe: async () => ({ ok: false, detail: "EACCES: permission denied, mkdir '.factory/out/qa'" }),
    cleanCheck: async () => ({ ok: false, dirty: ["client/pubspec.lock"] }),
  });
  expect(steps.find((s) => s.name === "qa-evidence").status).toBe("RED");
  expect(steps.find((s) => s.name === "qa-evidence").detail).toMatch(/EACCES/);
  const clean = steps.find((s) => s.name === "clean-check");
  expect(clean.status).toBe("RED");
  expect(clean.detail).toMatch(/client\/pubspec\.lock/);
});

test("runRehearsal: prove-test smoke creates a base worktree, installs into it, and always removes it", async () => {
  const run = fakeRun();
  await rehearse({ run });
  const git = run.calls.filter((c) => c.cmd === "git").map((c) => c.args.join(" "));
  expect(git.some((g) => /^worktree add --detach/.test(g))).toBe(true);
  expect(git.some((g) => /^worktree remove --force/.test(g))).toBe(true);
  // 설치는 base 워크트리 안에서 돈다(감사 M2와 같은 계약) — 그 자리가 곧 prove-test가 도는 자리다.
  const install = run.calls.find((c) => c.cmd === "bash" && /npm ci/.test(c.args[1]));
  expect(install.opts.cwd).toMatch(/prove/);
});

test("runRehearsal: a worktree that cannot be created is RED, and the removal still runs", async () => {
  const run = fakeRun([{ match: (l) => l.startsWith("git worktree add"), code: 128, stderr: "fatal: not a git repository" }]);
  const { steps } = await rehearse({ run });
  const p = steps.find((s) => s.name === "prove-test");
  expect(p.status).toBe("RED");
  expect(p.detail).toMatch(/not a git repository/);
  expect(run.calls.some((c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "remove")).toBe(true);
});

test("runRehearsal: the prove-test worktree is removed even when the machinery throws", async () => {
  // 리뷰 should_fix 2 — 던지는 경로에서 정리를 건너뛰면 남은 워크트리가 **다음 런의 `worktree add`를 죽인다**.
  const run = fakeRun();
  const throwing = async (cmd, args, opts) => {
    if (cmd === "bash" && /npm ci/.test(args[1])) throw new Error("spawn ENOENT");
    return run(cmd, args, opts);
  };
  throwing.calls = run.calls;
  const { steps } = await rehearse({ run: throwing });
  const p = steps.find((s) => s.name === "prove-test");
  expect(p.status).toBe("RED");
  expect(p.detail).toMatch(/spawn ENOENT/);
  expect(run.calls.some((c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "remove")).toBe(true);
});

// ── report ──────────────────────────────────────────────────────────────────
test("renderRehearsalTable: one markdown row per step, and a failure's lines do not break the table", async () => {
  const { steps } = await rehearse({ qaProbe: async () => ({ ok: false, detail: "a | b\nsecond\nthird" }) });
  const md = renderRehearsalTable(steps);
  const rows = md.split("\n").filter((l) => l.startsWith("|"));
  expect(rows).toHaveLength(steps.length + 2);          // header + separator + one per step
  expect(md).toMatch(/\| lint \| GREEN \|/);
  expect(md).toMatch(/\| qa-evidence \| RED \|/);
  expect(md).toMatch(/a \\\| b<br>second<br>third/);    // 파이프는 이스케이프, 줄바꿈은 <br>
  expect(md).toMatch(/\d+\.\d+s/);
});

test("rehearsalReport: the artifact is machine-readable and carries the hash it was GREEN for", async () => {
  const { steps } = await rehearse();
  const r = rehearsalReport({ steps, hash: "a".repeat(64), runId: "9001", at: "2026-09-14T00:00:00Z", recorded: { via: "variable", variable: "ok", status: "not attempted", sha: null } });
  expect(r.schema).toBe("factory.rehearsal.v1");
  expect(r.ok).toBe(true);
  expect(r.steps_ok).toBe(true);
  expect(r.hash).toBe("a".repeat(64));
  expect(r.run_id).toBe("9001");
  expect(r.recorded.via).toBe("variable");
  expect(r.steps).toHaveLength(steps.length);
  expect(rehearsalArtifactName("9001")).toBe("factory-rehearsal-9001");
});

test("rehearsalReport: all-GREEN steps but a failed recording is NOT ok — the queue is shut and the artifact says so", async () => {
  // 리뷰 must_fix 5 — 예전에는 `ok`가 스텝만 봤다: 잡은 빨간데 아티팩트는 `ok: true`라
  // `factory rehearse`가 "the queue is open"을 찍고 0으로 끝났다.
  const { steps } = await rehearse();
  const r = rehearsalReport({ steps, hash: "a".repeat(64), runId: "9001", recorded: { via: null, variable: "error: 403", status: "error: no statuses: write", sha: null } });
  expect(r.steps_ok).toBe(true);
  expect(r.ok).toBe(false);
  expect(r.recorded.variable).toMatch(/403/);
  // 기록을 아예 시도하지 않은 런(로컬·RED)은 스텝만으로 판정한다.
  expect(rehearsalReport({ steps, hash: null, runId: "x" }).ok).toBe(true);
});

// ── the gate ───────────────────────────────────────────────
test("rehearsalGate: missing, stale and current — the refusal says the same sentence in every case", () => {
  const cur = "b".repeat(64);
  expect(rehearsalGate({ recorded: null, current: cur }).ok).toBe(false);
  expect(rehearsalGate({ recorded: null, current: cur }).reason).toContain(REHEARSAL_STALE);
  expect(rehearsalGate({ recorded: { variable: "a".repeat(64) }, current: cur }).ok).toBe(false);
  expect(rehearsalGate({ recorded: { variable: "a".repeat(64) }, current: cur }).reason).toContain(REHEARSAL_STALE);
  expect(rehearsalGate({ recorded: { variable: cur }, current: cur })).toMatchObject({ ok: true, source: "variable" });
  // 문자열 하나를 주던 예 호출자도 그대로 받는다.
  expect(rehearsalGate({ recorded: cur, current: cur }).ok).toBe(true);
  // 지금의 해시를 읽지 못하면 통과가 아니라 거부다(fail closed).
  expect(rehearsalGate({ recorded: { variable: cur }, current: null }).ok).toBe(false);
});

test("rehearsalGate: a stale variable does not shadow a fresh status — either source may open the queue", () => {
  const cur = "b".repeat(64);
  const stale = "a".repeat(64);
  // 한때 admin 토큰으로 변수를 썼다가 문서가 권하는 비-admin 봇 토큰으로 옴긴 저장소:
  // 변수는 얼어붙어 있고 새 기록은 status로만 온다. 변수를 무조건 우선하면 그 저장소는 큐를 다시 열 수 없었다.
  expect(rehearsalGate({ recorded: { variable: stale, status: cur }, current: cur })).toMatchObject({ ok: true, source: "status" });
  expect(rehearsalGate({ recorded: { variable: cur, status: stale }, current: cur })).toMatchObject({ ok: true, source: "variable" });
  // 여전히 fail closed: 둘 다 어긋나면 거부하고, 두 값을 모두 사유에 십는다.
  const r = rehearsalGate({ recorded: { variable: stale, status: "c".repeat(64) }, current: cur });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/variable aaaa/);
  expect(r.reason).toMatch(/status cccc/);
});

test("fingerprintSha: the status is bound to the commit that last touched harness.toml/CHARTER, not to the moving head", async () => {
  const run = async (cmd, args) => {
    expect(cmd).toBe("git");
    expect(args.slice(0, 3)).toEqual(["log", "-1", "--format=%H"]);
    expect(args.slice(4)).toEqual(FINGERPRINT_PATHS);
    return { code: 0, stdout: "abc123def456\n", stderr: "" };
  };
  expect(await fingerprintShaLocal({ run, cwd: "/repo" })).toBe("abc123def456");
  expect(await fingerprintShaLocal({ run: async () => ({ code: 128, stdout: "", stderr: "fatal" }), cwd: "/repo" })).toBe(null);

  const gh = {
    commitsForPath: vi.fn(async (branch, path) => (path === ".factory/harness.toml"
      ? [{ sha: "old111", date: "2026-09-01T00:00:00Z" }]
      : [{ sha: "new222", date: "2026-09-14T00:00:00Z" }])),
  };
  expect(await fingerprintShaRemote({ gh, branch: "trunk" })).toBe("new222");
  expect(gh.commitsForPath).toHaveBeenCalledTimes(2);
  const onlyOne = { commitsForPath: async (b, path) => { if (path !== ".factory/harness.toml") throw new Error("404"); return [{ sha: "only1", date: "2026-09-01T00:00:00Z" }]; } };
  expect(await fingerprintShaRemote({ gh: onlyOne })).toBe("only1");
  expect(await fingerprintShaRemote({ gh: { commitsForPath: async () => [] } })).toBe(null);
});

test("recordedRehearsal: both sources are read, and the status is read on the fingerprint commit", async () => {
  const hash = "c".repeat(64);
  const both = {
    getVariable: vi.fn(async () => `${hash}\n`),
    commitsForPath: vi.fn(async () => [{ sha: "fp1234", date: "2026-09-14T00:00:00Z" }]),
    commitStatuses: vi.fn(async () => [
      { context: "factory/gates", state: "success", description: "x" },
      { context: REHEARSAL_STATUS_CONTEXT, state: "success", description: `rehearsal GREEN ${hash}` },
    ]),
    branchHeadSha: vi.fn(),
  };
  expect(await recordedRehearsal({ gh: both, branch: "main" })).toEqual({ variable: hash, status: hash, sha: "fp1234", source: "variable+status" });
  // 브랜치 head는 아예 묻지 않는다 — 그것이 must_fix 2의 결함이었다.
  expect(both.branchHeadSha).not.toHaveBeenCalled();
  expect(both.commitStatuses).toHaveBeenCalledWith("fp1234");

  const statusOnly = { getVariable: async () => null, commitsForPath: async () => [{ sha: "fp1234", date: "2026-09-14T00:00:00Z" }], commitStatuses: async () => [{ context: REHEARSAL_STATUS_CONTEXT, state: "success", description: `rehearsal GREEN ${hash}` }] };
  expect(await recordedRehearsal({ gh: statusOnly })).toMatchObject({ variable: null, status: hash, source: "status" });

  const red = { getVariable: async () => null, commitsForPath: async () => [{ sha: "fp1234", date: "x" }], commitStatuses: async () => [{ context: REHEARSAL_STATUS_CONTEXT, state: "failure", description: `rehearsal RED ${hash}` }] };
  expect(await recordedRehearsal({ gh: red })).toMatchObject({ variable: null, status: null, source: null });

  const dead = { getVariable: async () => { throw new Error("offline"); }, commitsForPath: async () => { throw new Error("offline"); }, commitStatuses: async () => { throw new Error("offline"); } };
  expect(await recordedRehearsal({ gh: dead })).toMatchObject({ variable: null, status: null });
});

test("recordRehearsal: the variable is primary, the fallback status lands on the fingerprint commit, and both outcomes are reported", async () => {
  const hash = "d".repeat(64);
  const ok = { setVariable: vi.fn(async () => {}), commitsForPath: vi.fn(), setStatus: vi.fn() };
  expect(await recordRehearsal({ gh: ok, hash, branch: "main" })).toMatchObject({ via: "variable", variable: "ok" });
  expect(ok.setVariable).toHaveBeenCalledWith(REHEARSAL_VARIABLE, hash);
  expect(ok.setStatus).not.toHaveBeenCalled();

  const noAdmin = {
    setVariable: vi.fn(async () => { throw new Error("HTTP 403: Resource not accessible by integration"); }),
    commitsForPath: vi.fn(async () => [{ sha: "fp9999", date: "2026-09-14T00:00:00Z" }]),
    setStatus: vi.fn(async () => {}),
  };
  const r = await recordRehearsal({ gh: noAdmin, hash, branch: "main" });
  expect(r).toMatchObject({ via: "status", status: "ok", sha: "fp9999" });
  expect(r.variable).toMatch(/403/);
  expect(noAdmin.setStatus).toHaveBeenCalledWith(expect.objectContaining({ sha: "fp9999", context: REHEARSAL_STATUS_CONTEXT, state: "success" }));
  expect(noAdmin.setStatus.mock.calls[0][0].description).toContain(hash);
  const given = { setVariable: async () => { throw new Error("403"); }, commitsForPath: vi.fn(), setStatus: vi.fn(async () => {}) };
  expect(await recordRehearsal({ gh: given, hash, sha: "local77" })).toMatchObject({ via: "status", sha: "local77" });
  expect(given.commitsForPath).not.toHaveBeenCalled();

  const none = { setVariable: async () => { throw new Error("403"); }, commitsForPath: async () => [{ sha: "fp9999", date: "x" }], setStatus: async () => { throw new Error("no statuses: write"); } };
  const failed = await recordRehearsal({ gh: none, hash });
  expect(failed.via).toBe(null);
  expect(failed.status).toMatch(/no statuses: write/);
});

test("checkRehearsalCurrent: PASS when current, FAIL when stale, WARN when never rehearsed or unverifiable", () => {
  const cur = "e".repeat(64);
  expect(checkRehearsalCurrent({ recorded: cur, current: cur })).toMatchObject({ id: "rehearsal.current", level: "PASS" });
  expect(checkRehearsalCurrent({ recorded: "f".repeat(64), current: cur })).toMatchObject({ level: "FAIL" });
  expect(checkRehearsalCurrent({ recorded: "f".repeat(64), current: cur }).detail).toContain("factory rehearse");
  expect(checkRehearsalCurrent({ recorded: null, current: cur })).toMatchObject({ level: "WARN" });
  expect(checkRehearsalCurrent({ skipped: "--offline" })).toMatchObject({ level: "WARN" });
});

test("doctor's checkRehearsal: the fingerprint is computed locally, the record is read from the repo", async () => {
  const harnessText = "schema = 1\n";
  const charterText = "---\nstatus: ready\n---\n";
  const current = rehearsalHash({ harnessText, charterText });
  const readFile = (p) => {
    if (p.endsWith(".factory/harness.toml")) return harnessText;
    if (p.endsWith("docs/factory/CHARTER.md")) return charterText;
    throw new Error(`ENOENT ${p}`);
  };
  const harness = { project: { default_branch: "trunk" } };
  const noStatus = { commitsForPath: async () => [], commitStatuses: async () => [] };

  const green = { getVariable: vi.fn(async () => current), ...noStatus };
  expect(await checkRehearsal({ gh: green, root: "/repo", readFile, harness })).toEqual([expect.objectContaining({ id: "rehearsal.current", level: "PASS" })]);

  const stale = { getVariable: async () => "0".repeat(64), ...noStatus };
  expect(await checkRehearsal({ gh: stale, root: "/repo", readFile, harness })).toEqual([expect.objectContaining({ level: "FAIL" })]);

  // harness.toml을 못 읽으면 지문이 없다 — 그것은 FAIL이지 "확인 못 함"이 아니다(그 저장소에는 하네스가 없다).
  const noHarness = await checkRehearsal({ gh: green, root: "/repo", readFile: () => { throw new Error("ENOENT"); }, harness });
  expect(noHarness[0].level).toBe("FAIL");

  // CHARTER가 아직 없어도(그린필드) 판정은 선다 — 프론트매터가 빈 블록일 뿐이다.
  const onlyHarness = (p) => { if (p.endsWith(".factory/harness.toml")) return harnessText; throw new Error("ENOENT"); };
  const hashNoCharter = rehearsalHash({ harnessText, charterText: "" });
  const matching = { getVariable: async () => hashNoCharter, ...noStatus };
  expect((await checkRehearsal({ gh: matching, root: "/repo", readFile: onlyHarness, harness }))[0].level).toBe("PASS");

  // gh가 통째로 죽어도 doctor는 죽지 않는다 — recordedRehearsal이 삼키고 "기록 없음"으로 도착한다(WARN).
  const dead = { getVariable: async () => { throw new Error("offline"); }, commitsForPath: async () => { throw new Error("offline"); }, commitStatuses: async () => { throw new Error("offline"); } };
  expect((await checkRehearsal({ gh: dead, root: "/repo", readFile, harness }))[0].level).toBe("WARN");
});

// ── transition.js refuses to queue on a stale rehearsal ──────────────────────
function fakeGh(labels) {
  return { issue: vi.fn(async () => ({ number: 7, title: "t", body: "", labels })), comments: vi.fn(async () => []),
    setFactoryLabel: vi.fn(async () => {}), comment: vi.fn(async () => "url") };
}

test("transition: → factory:queue is refused when no GREEN rehearsal matches the current harness (script)", async () => {
  const gh = fakeGh(["backlog"]);
  const r = await transition({ gh, issue: 7, to: "factory:queue", rehearsal: { ok: false, reason: `${REHEARSAL_STALE} — recorded aaaa, current bbbb` } });
  expect(r.ok).toBe(false);
  expect(r.reason).toContain(REHEARSAL_STALE);
  expect(gh.setFactoryLabel).not.toHaveBeenCalled();
  expect(gh.issue).not.toHaveBeenCalled();               // 네트워크보다 먼저 끊는다
});

test("transition: the person's own shell is refused too — the rehearsal is about the runner, not the actor", async () => {
  const gh = fakeGh(["factory:needs-human"]);
  const r = await transition({ gh, issue: 7, to: "factory:queue", human: true, env: {}, rehearsal: { ok: false, reason: REHEARSAL_STALE } });
  expect(r.ok).toBe(false);
  expect(r.reason).toContain(REHEARSAL_STALE);
  expect(gh.setFactoryLabel).not.toHaveBeenCalled();
});

test("transition: a current rehearsal lets the queue transition through, and other targets never consult it", async () => {
  const gh = fakeGh(["backlog"]);
  const ok = await transition({ gh, issue: 7, to: "factory:queue", rehearsal: { ok: true } });
  expect(ok.ok).toBe(true);
  expect(gh.setFactoryLabel).toHaveBeenCalled();

  // 다른 목적 라벨은 리허설을 묻지 않는다 — 멈춘 이슈를 앞으로 미는 길을 막으면 안 된다(배선도 필요 없다).
  const gh2 = fakeGh(["factory:queue"]);
  const other = await transition({ gh: gh2, issue: 7, to: "factory:wont-do" });
  expect(other.ok).toBe(true);
});

test("transition: a queue transition with NO rehearsal wiring is refused — the gate is opt-out, not opt-in", async () => {
  // 리뷰 must_fix 3 — 예전에는 인자를 생략하는 것만으로 게이트가 꺼졌다. 그것은 이 함수 안에 세 번째
  // 자물쇠를 둔 이유(`node -e "import('…/lib/transition.js')…"`)를 그대로 되돌리는 모양이었다.
  const gh = fakeGh(["backlog"]);
  const r = await transition({ gh, issue: 7, to: "factory:queue" });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe(REHEARSAL_UNWIRED);
  expect(gh.issue).not.toHaveBeenCalled();
  expect(gh.setFactoryLabel).not.toHaveBeenCalled();

  // 검사기가 모양이 깨진 값을 돌려줘도 통과가 아니다(fail closed).
  const gh2 = fakeGh(["backlog"]);
  expect((await transition({ gh: gh2, issue: 7, to: "factory:queue", rehearsal: async () => ({}) })).ok).toBe(false);
  expect(gh2.setFactoryLabel).not.toHaveBeenCalled();

  // 면제는 **이름이 있는 결정**이다 — 테스트 전용이고, 코드에서 grep으로 찾을 수 있다.
  const gh3 = fakeGh(["backlog"]);
  expect((await transition({ gh: gh3, issue: 7, to: "factory:queue", skipRehearsal: true })).ok).toBe(true);
});

test("makeRehearsalChecker: one wiring for every production caller — local fingerprint, repo record", async () => {
  const harnessText = "schema = 1\n";
  const current = rehearsalHash({ harnessText, charterText: "" });
  const readFile = (p) => { if (p.endsWith(".factory/harness.toml")) return harnessText; throw new Error("ENOENT"); };
  const gh = { getVariable: async () => current, commitsForPath: async () => [], commitStatuses: async () => [] };
  const checker = makeRehearsalChecker({ gh, root: "/repo", branch: "main", readFile });
  expect(await checker()).toMatchObject({ ok: true });

  // 이 검사기를 그대로 `transition`에 물리면 큐가 열린다 — sweeper·merge·사람의 CLI가 쓰는 그 배선이다.
  const issueGh = fakeGh(["backlog"]);
  expect((await transition({ gh: issueGh, issue: 7, to: "factory:queue", rehearsal: checker })).ok).toBe(true);

  // 하네스를 읽지 못하면(체크아웃이 없다) 거부다 — 확인 못 한 것은 통과가 아니다.
  const blind = makeRehearsalChecker({ gh, root: "/repo", readFile: () => { throw new Error("ENOENT"); } });
  expect((await blind()).ok).toBe(false);
});

// ── the CLI ─────────────────────────────────────────────────
const cliGh = (runs, { existing = [] } = {}) => {
  const calls = { list: 0 };
  return {
    dispatchWorkflow: vi.fn(async () => {}),
    workflowRuns: vi.fn(async () => (calls.list++ === 0 ? existing : (typeof runs === "function" ? runs(calls.list) : runs))),
    downloadRunArtifact: vi.fn(async () => {}),
  };
};

test("factory rehearse: dispatches the workflow, waits for the run, prints the table and exits 0 on GREEN", async () => {
  const out = [];
  const io = { out: (s) => out.push(s), err: (s) => out.push(s) };
  const steps = (await rehearse()).steps;
  const gh = cliGh((n) => [{ databaseId: 42, status: n === 1 ? "in_progress" : "completed", conclusion: n === 1 ? null : "success", createdAt: "2026-09-14T01:00:00Z", event: "workflow_dispatch" }]);
  const code = await rehearseCommand({
    argv: [], io, gh,
    readFile: () => JSON.stringify(rehearsalReport({ steps, hash: "a".repeat(64), runId: "42", recorded: { via: "variable", variable: "ok", status: "not attempted", sha: null } })),
    sleep: async () => {},
  });
  expect(gh.dispatchWorkflow).toHaveBeenCalledWith(REHEARSAL_WORKFLOW, {});
  expect(gh.downloadRunArtifact).toHaveBeenCalledWith(42, "factory-rehearsal-42", expect.any(String));
  expect(code).toBe(0);
  expect(out.join("\n")).toMatch(/\| lint \| GREEN \|/);
  expect(out.join("\n")).toMatch(/queue is open/);
});

test("factory rehearse: the run it waits for is the one IT dispatched — not a run that finished moments earlier", async () => {
  // 리뷰 should_fix 5 — 시간 창으로 고르면 방금 끝난 옛 런이 뽑혀 그 표를 찍고 끝났다.
  const out = [];
  const io = { out: (s) => out.push(s), err: (s) => out.push(s) };
  const steps = (await rehearse()).steps;
  const older = { databaseId: 41, status: "completed", conclusion: "success", createdAt: "2026-09-14T00:59:30Z", event: "workflow_dispatch" };
  const gh = cliGh((n) => (n === 1
    ? [older]                                                        // dispatch 직후: 새 런은 아직 안 보인다
    : [{ databaseId: 42, status: "completed", conclusion: "success", createdAt: "2026-09-14T01:00:00Z", event: "workflow_dispatch" }, older]),
  { existing: [older] });
  const code = await rehearseCommand({
    argv: [], io, gh,
    readFile: () => JSON.stringify(rehearsalReport({ steps, hash: "a".repeat(64), runId: "42", recorded: { via: "status", variable: "error: 403", status: "ok", sha: "fp9999" } })),
    sleep: async () => {},
  });
  expect(code).toBe(0);
  expect(gh.downloadRunArtifact).toHaveBeenCalledWith(42, "factory-rehearsal-42", expect.any(String));
});

test("factory rehearse: exits non-zero on RED and says which step was red", async () => {
  const out = [];
  const io = { out: (s) => out.push(s), err: (s) => out.push(s) };
  const steps = (await rehearse({ qaProbe: async () => ({ ok: false, detail: "EACCES" }) })).steps;
  const gh = cliGh([{ databaseId: 43, status: "completed", conclusion: "failure", createdAt: "2026-09-14T01:00:00Z", event: "workflow_dispatch" }]);
  const code = await rehearseCommand({
    argv: [], io, gh,
    readFile: () => JSON.stringify(rehearsalReport({ steps, hash: "a".repeat(64), runId: "43" })),
    sleep: async () => {},
  });
  expect(code).toBe(1);
  expect(out.join("\n")).toMatch(/qa-evidence/);
});

test("factory rehearse: all-GREEN steps but nothing recorded → non-zero and 'the queue stays closed'", async () => {
  const out = [], err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s) };
  const steps = (await rehearse()).steps;
  const gh = cliGh([{ databaseId: 44, status: "completed", conclusion: "failure", createdAt: "2026-09-14T01:00:00Z", event: "workflow_dispatch" }]);
  const code = await rehearseCommand({
    argv: [], io, gh,
    readFile: () => JSON.stringify(rehearsalReport({ steps, hash: "a".repeat(64), runId: "44", recorded: { via: null, variable: "error: 403", status: "error: no statuses: write", sha: null } })),
    sleep: async () => {},
  });
  expect(code).toBe(1);
  expect(err.join("\n")).toMatch(/NOT RECORDED/);
  expect(err.join("\n")).toMatch(/queue stays closed/);
  expect(out.join("\n")).not.toMatch(/queue is open/);
});

// ── the workflow file ───────────────────────────────────────────────────────
test("the factory-rehearse workflow passes yml-lint and is installed next to the stage workflows", () => {
  const text = readFileSync(join(repoRoot, "templates/factory/github/workflows/factory-rehearse.yml"), "utf8");
  expect(lintWorkflow(text, { file: "factory-rehearse.yml", factoryOwned: true })).toEqual([]);
  expect(text).toMatch(/vars\.FACTORY_RUNNER \|\| 'ubuntu-latest'/);
  expect(text).toMatch(/uses: \.\/\.factory\/actions\/setup/);
  expect(text).toMatch(/node \.factory\/bin\/rehearse\.js/);
  expect(text).toMatch(/retention-days: 7/);
  expect(text).toMatch(/workflow_dispatch/);
  expect(text).toMatch(/\.factory\/harness\.toml/);      // push 트리거의 경로 필터
  // 리뷰 must_fix 4 — dispatch는 아무 ref로나 올 수 있다(레포 write면 누구나). 잡 자체가 기본 브랜치로
  // 묶여 있어야 하고, 체크아웃도 그 브랜치를 본다 — 아니면 브랜치의 `rehearse.js`가 main의 지문으로
  // GREEN을 적을 수 있다(게이트 명령을 한 줄도 돌리지 않고).
  expect(text).toMatch(/if: github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  expect(text).toMatch(/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  // 리뷰 should_fix 6 — 이 잡의 GITHUB_TOKEN은 아무 스텝도 쓰지 않는다. 최소 권한만 남는다.
  expect(text).toMatch(/permissions:\n  contents: read\n/);
  expect(text).not.toMatch(/^\s*contents: write/m);       // 주석에서의 언급은 괜찮다 — 지시어만 본다
  // 이 저장소 자신도 그 워크플로를 설치해 두었는가(self-dogfood).
  const installed = readFileSync(join(repoRoot, ".github/workflows/factory-rehearse.yml"), "utf8");
  expect(installed).toBe(text);
});

test("bin/rehearse.js refuses any ref but the harness default branch — the record is only meaningful there", () => {
  // 워크플로의 `if:`는 1차 방어이고 그 파일은 이 스크립트와 함께 움직이지 않는다(에이전트는 `.github/**`를
  // 못 만지지만 `.factory/**`는 브랜치 push로 바꿀 수 있다). 그래서 기록하는 쪽이 스스로 한 번 더 묻는다.
  const src = readFileSync(join(repoRoot, "factory/bin/rehearse.js"), "utf8");
  expect(src).toMatch(/GITHUB_REF_NAME/);
  expect(src).toMatch(/refName !== defaultBranch/);
  expect(src).toMatch(/process\.exit\(1\)/);
  // 기록은 그 가드 **뒤에** 있다 — 가드가 통과해야 recordRehearsal에 닿는다.
  expect(src.indexOf("GITHUB_REF_NAME")).toBeLessThan(src.indexOf("recordRehearsal("));
});

test("the stages substitute every placeholder, exactly like the rehearsal does", () => {
  // 리뷰 should_fix 8 — `replace`는 첫 자리표시자만 채운다. `{files}`가 두 번 나오는 하네스에서는
  // 두 번째가 리터럴로 셸에 남아 게이트가 "그런 파일 없음"으로 죽는다 — 그리고 리허설(replaceAll)과
  // 스테이지(replace)가 다르게 돌면 리허설이 증명하는 것은 스테이지가 아니다.
  for (const f of ["factory/lib/prove-test.js", "factory/lib/classify-failure.js", "factory/lib/mutation.js", "factory/cli/doctor.js"]) {
    const src = readFileSync(join(repoRoot, f), "utf8");
    expect(src.match(/\.replace\("\{(files|file|name)\}"/g), f).toBe(null);
    expect(src, f).toMatch(/\.replaceAll\("\{(files|file|name)\}"/);
  }
});
