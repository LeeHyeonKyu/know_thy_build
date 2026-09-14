import { test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REHEARSAL_STALE, REHEARSAL_STATUS_CONTEXT, REHEARSAL_VARIABLE, REHEARSAL_WORKFLOW,
  charterFrontmatter, checkRehearsalCurrent, firstTestName, pickFile, recordRehearsal, recordedRehearsal,
  rehearsalArtifactName, rehearsalGate, rehearsalHash, rehearsalOk, rehearsalReport, renderRehearsalTable, runRehearsal,
} from "../lib/rehearsal.js";
import { transition } from "../lib/transition.js";
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
  const r = rehearsalReport({ steps, hash: "a".repeat(64), runId: "9001", at: "2026-09-14T00:00:00Z" });
  expect(r.schema).toBe("factory.rehearsal.v1");
  expect(r.ok).toBe(true);
  expect(r.hash).toBe("a".repeat(64));
  expect(r.run_id).toBe("9001");
  expect(r.steps).toHaveLength(steps.length);
  expect(rehearsalArtifactName("9001")).toBe("factory-rehearsal-9001");
});

// ── the gate ────────────────────────────────────────────────────────────────
test("rehearsalGate: missing, stale and current — the refusal says the same sentence in every case", () => {
  const cur = "b".repeat(64);
  expect(rehearsalGate({ recorded: null, current: cur }).ok).toBe(false);
  expect(rehearsalGate({ recorded: null, current: cur }).reason).toContain(REHEARSAL_STALE);
  expect(rehearsalGate({ recorded: "a".repeat(64), current: cur }).ok).toBe(false);
  expect(rehearsalGate({ recorded: "a".repeat(64), current: cur }).reason).toContain(REHEARSAL_STALE);
  expect(rehearsalGate({ recorded: cur, current: cur })).toEqual({ ok: true });
  // 지금의 해시를 읽지 못하면 통과가 아니라 거부다(fail closed).
  expect(rehearsalGate({ recorded: cur, current: null }).ok).toBe(false);
});

test("recordedRehearsal: the repo variable is the first source, the commit status the fallback", async () => {
  const hash = "c".repeat(64);
  const withVar = { getVariable: vi.fn(async () => `${hash}\n`), branchHeadSha: vi.fn(), commitStatuses: vi.fn() };
  expect(await recordedRehearsal({ gh: withVar, branch: "main" })).toEqual({ hash, source: "variable" });
  expect(withVar.commitStatuses).not.toHaveBeenCalled();

  const withStatus = {
    getVariable: vi.fn(async () => null),
    branchHeadSha: vi.fn(async () => "deadbee"),
    commitStatuses: vi.fn(async () => [
      { context: "factory/gates", state: "success", description: "x" },
      { context: REHEARSAL_STATUS_CONTEXT, state: "success", description: `rehearsal GREEN ${hash}` },
    ]),
  };
  expect(await recordedRehearsal({ gh: withStatus, branch: "main" })).toEqual({ hash, source: "status" });

  // 실패한 리허설의 상태는 기록이 아니다.
  const red = { getVariable: async () => null, branchHeadSha: async () => "deadbee", commitStatuses: async () => [{ context: REHEARSAL_STATUS_CONTEXT, state: "failure", description: `rehearsal RED ${hash}` }] };
  expect((await recordedRehearsal({ gh: red, branch: "main" })).hash).toBe(null);

  // gh가 통째로 말을 안 해도 throw하지 않는다 — 호출자가 "확인 못 함"으로 fail closed 한다.
  const dead = { getVariable: async () => { throw new Error("offline"); }, branchHeadSha: async () => { throw new Error("offline"); }, commitStatuses: async () => [] };
  expect((await recordedRehearsal({ gh: dead, branch: "main" })).hash).toBe(null);
});

test("recordRehearsal: writes the repo variable, and falls back to a commit status when variables need admin", async () => {
  const hash = "d".repeat(64);
  const ok = { setVariable: vi.fn(async () => {}), branchHeadSha: vi.fn(), setStatus: vi.fn() };
  expect(await recordRehearsal({ gh: ok, hash, branch: "main" })).toMatchObject({ via: "variable" });
  expect(ok.setVariable).toHaveBeenCalledWith(REHEARSAL_VARIABLE, hash);
  expect(ok.setStatus).not.toHaveBeenCalled();

  const noAdmin = {
    setVariable: vi.fn(async () => { throw new Error("HTTP 403: Resource not accessible by integration"); }),
    branchHeadSha: vi.fn(async () => "beefbee"),
    setStatus: vi.fn(async () => {}),
  };
  const r = await recordRehearsal({ gh: noAdmin, hash, branch: "main" });
  expect(r.via).toBe("status");
  expect(noAdmin.setStatus).toHaveBeenCalledWith(expect.objectContaining({ sha: "beefbee", context: REHEARSAL_STATUS_CONTEXT, state: "success" }));
  expect(noAdmin.setStatus.mock.calls[0][0].description).toContain(hash);
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

  const green = { getVariable: vi.fn(async () => current), branchHeadSha: vi.fn(), commitStatuses: vi.fn() };
  expect(await checkRehearsal({ gh: green, root: "/repo", readFile, harness })).toEqual([expect.objectContaining({ id: "rehearsal.current", level: "PASS" })]);

  const stale = { getVariable: async () => "0".repeat(64), branchHeadSha: async () => "sha", commitStatuses: async () => [] };
  expect(await checkRehearsal({ gh: stale, root: "/repo", readFile, harness })).toEqual([expect.objectContaining({ level: "FAIL" })]);

  // harness.toml을 못 읽으면 지문이 없다 — 그것은 FAIL이지 "확인 못 함"이 아니다(그 저장소에는 하네스가 없다).
  const noHarness = await checkRehearsal({ gh: green, root: "/repo", readFile: () => { throw new Error("ENOENT"); }, harness });
  expect(noHarness[0].level).toBe("FAIL");

  // CHARTER가 아직 없어도(그린필드) 판정은 선다 — 프론트매터가 빈 블록일 뿐이다.
  const onlyHarness = (p) => { if (p.endsWith(".factory/harness.toml")) return harnessText; throw new Error("ENOENT"); };
  const hashNoCharter = rehearsalHash({ harnessText, charterText: "" });
  const matching = { getVariable: async () => hashNoCharter, branchHeadSha: async () => "sha", commitStatuses: async () => [] };
  expect((await checkRehearsal({ gh: matching, root: "/repo", readFile: onlyHarness, harness }))[0].level).toBe("PASS");
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

  // 다른 목적 라벨은 리허설을 묻지 않는다 — 멈춘 이슈를 앞으로 미는 길을 막으면 안 된다.
  const gh2 = fakeGh(["factory:queue"]);
  const other = await transition({ gh: gh2, issue: 7, to: "factory:wont-do", rehearsal: { ok: false, reason: REHEARSAL_STALE } });
  expect(other.ok).toBe(true);
});

// ── the CLI ─────────────────────────────────────────────────────────────────
test("factory rehearse: dispatches the workflow, waits for the run, prints the table and exits 0 on GREEN", async () => {
  const out = [];
  const io = { out: (s) => out.push(s), err: (s) => out.push(s) };
  const steps = (await rehearse()).steps;
  const gh = {
    dispatchWorkflow: vi.fn(async () => {}),
    workflowRuns: vi.fn()
      .mockResolvedValueOnce([{ databaseId: 42, status: "in_progress", conclusion: null, createdAt: "2026-09-14T01:00:00Z" }])
      .mockResolvedValue([{ databaseId: 42, status: "completed", conclusion: "success", createdAt: "2026-09-14T01:00:00Z" }]),
    downloadRunArtifact: vi.fn(async () => {}),
  };
  const code = await rehearseCommand({
    root: "/repo", argv: [], io, gh,
    readFile: () => JSON.stringify(rehearsalReport({ steps, hash: "a".repeat(64), runId: "42" })),
    sleep: async () => {}, since: () => new Date("2026-09-14T00:59:00Z"),
  });
  expect(gh.dispatchWorkflow).toHaveBeenCalledWith(REHEARSAL_WORKFLOW, expect.anything());
  expect(gh.downloadRunArtifact).toHaveBeenCalledWith(42, "factory-rehearsal-42", expect.any(String));
  expect(code).toBe(0);
  expect(out.join("\n")).toMatch(/\| lint \| GREEN \|/);
});

test("factory rehearse: exits non-zero on RED and says which step was red", async () => {
  const out = [];
  const io = { out: (s) => out.push(s), err: (s) => out.push(s) };
  const steps = (await rehearse({ qaProbe: async () => ({ ok: false, detail: "EACCES" }) })).steps;
  const gh = {
    dispatchWorkflow: vi.fn(async () => {}),
    workflowRuns: vi.fn(async () => [{ databaseId: 43, status: "completed", conclusion: "failure", createdAt: "2026-09-14T01:00:00Z" }]),
    downloadRunArtifact: vi.fn(async () => {}),
  };
  const code = await rehearseCommand({
    root: "/repo", argv: [], io, gh,
    readFile: () => JSON.stringify(rehearsalReport({ steps, hash: "a".repeat(64), runId: "43" })),
    sleep: async () => {}, since: () => new Date("2026-09-14T00:59:00Z"),
  });
  expect(code).toBe(1);
  expect(out.join("\n")).toMatch(/qa-evidence/);
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
  // 이 저장소 자신도 그 워크플로를 설치해 두었는가(self-dogfood).
  const installed = readFileSync(join(repoRoot, ".github/workflows/factory-rehearse.yml"), "utf8");
  expect(installed).toBe(text);
});
