import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { initCommand } from "../cli/init.js";
import { doctorCommand } from "../cli/doctor.js";
import { renderReport } from "../lib/doctor/report.js";
import { makeFakeRun } from "../lib/exec.js";
import { readdirRecursive } from "../cli/manifest.js";

const pkgRoot = new URL("../../", import.meta.url).pathname;
const io = () => { const o = { out: [], err: [] }; return { io: { out: (s) => o.out.push(s), err: (s) => o.err.push(s) }, o }; };

const allFiles = (root) => readdirRecursive(root).map((p) => relative(root, p).split(sep).join("/"));

/** git ls-files → 실제 tmp 저장소 파일 목록; bash -lc/훅 실행 → 0(verdict-format.sh만 2); docker → 0. */
function makeDoctorRun(root) {
  return makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "ls-files", result: () => ({ code: 0, stdout: allFiles(root).join("\n"), stderr: "" }) },
    { match: (c, a) => c === "bash" && a[0] && a[0].endsWith("verdict-format.sh"), result: { code: 2, stdout: "", stderr: "" } },
    { match: (c) => c === "bash", result: { code: 0, stdout: "", stderr: "" } },
    { match: (c) => c === "docker", result: { code: 0, stdout: "", stderr: "" } },
    { match: () => true, result: { code: 0, stdout: "", stderr: "" } },
  ]);
}

/**
 * makeDoctorRun + gh 자체 호출(secret list·variable get·label list·branch protection)까지 답한다 — `gh`가
 * doctorCommand에 주입되지 않는 케이스(KTB-4)를 실제 `makeGh`/`resolveRepo` 경로로 돌리기 위한 것.
 * `repoLookup`이 `{code:1,...}`이면 `gh repo view`가 실패해 resolveRepo가 throw하는 경로를 재현한다.
 */
function makeDoctorRunNoGhInjected(root, { repoLookup } = {}) {
  return makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "ls-files", result: () => ({ code: 0, stdout: allFiles(root).join("\n"), stderr: "" }) },
    { match: (c, a) => c === "gh" && a[0] === "repo" && a[1] === "view", result: repoLookup || { code: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" } },
    { match: (c, a) => c === "gh" && a[0] === "secret" && a[1] === "list", result: { code: 0, stdout: JSON.stringify([{ name: "CLAUDE_CODE_OAUTH_TOKEN" }, { name: "FACTORY_BOT_TOKEN" }]), stderr: "" } },
    { match: (c, a) => c === "gh" && a[0] === "variable" && a[1] === "get", result: { code: 0, stdout: "2026-01-01T00:00:00Z\n", stderr: "" } },
    { match: (c, a) => c === "gh" && a[0] === "label" && a[1] === "list", result: { code: 0, stdout: JSON.stringify([{ name: "backlog" }]), stderr: "" } },
    { match: (c, a) => c === "gh" && a[0] === "api" && /branches\/main\/protection/.test(a[1] || ""), result: { code: 0, stdout: JSON.stringify({ required_status_checks: { contexts: ["factory/gates", "factory/review", "factory/integrity"] } }), stderr: "" } },
    { match: (c, a) => c === "bash" && a[0] && a[0].endsWith("verdict-format.sh"), result: { code: 2, stdout: "", stderr: "" } },
    { match: (c) => c === "bash", result: { code: 0, stdout: "", stderr: "" } },
    { match: (c) => c === "docker", result: { code: 0, stdout: "", stderr: "" } },
    { match: () => true, result: { code: 0, stdout: "", stderr: "" } },
  ]);
}

/** makeDoctorRun과 동일하지만 smoke 명령(test_files에 test/smoke.test.js가 들어간 bash -lc 호출)만 reject한다. */
function makeDoctorRunSmokeThrows(root) {
  return makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "ls-files", result: () => ({ code: 0, stdout: allFiles(root).join("\n"), stderr: "" }) },
    { match: (c, a) => c === "bash" && a[0] === "-lc" && a[1].includes("test/smoke.test.js"), result: () => { throw new Error("spawn boom"); } },
    { match: (c, a) => c === "bash" && a[0] && a[0].endsWith("verdict-format.sh"), result: { code: 2, stdout: "", stderr: "" } },
    { match: (c) => c === "bash", result: { code: 0, stdout: "", stderr: "" } },
    { match: (c) => c === "docker", result: { code: 0, stdout: "", stderr: "" } },
    { match: () => true, result: { code: 0, stdout: "", stderr: "" } },
  ]);
}

const fakeGh = {
  listSecrets: async () => ["CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_BOT_TOKEN"],
  listEnvSecrets: async () => [],
  getVariable: async () => "2026-01-01T00:00:00Z",
  listLabels: async () => ["backlog"],
  getBranchProtection: async () => ({ required_status_checks: { contexts: ["factory/gates", "factory/review", "factory/integrity"] } }),
};

/**
 * initCommand로 설치 + test/smoke.test.js stub.
 * 역할 파일 stub은 더 이상 만들지 않는다(F5): `[merge.integrator]`는 roles.toml에서 사라졌고, 마지막까지
 * 비어 있던 `[retro.analyst]`도 Plan 4가 `factory-retro.md`를 설치하면서 채워졌다 —
 * `roles.retro-agent-file`은 이제 WARN이 아니라 PASS다. "갓 init한 저장소의 doctor는 exit 0"이 stub 없이
 * 성립한다. 이게 실제 사용자가 보는 상태다.
 */
async function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "ktb-doctor-cli-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo-app" }));
  const { io: i } = io();
  expect(await initCommand({ root, pkgRoot, argv: [], io: i })).toBe(0);
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "test/smoke.test.js"), "test('smoke', () => {});\n");
  return root;
}

test("(a) full doctor run against a freshly-initialized repo: exit 0, PASS summary present, charter is WARN (draft)", async () => {
  const root = await setupRepo();
  const run = makeDoctorRun(root);
  const { io: i, o } = io();
  const code = await doctorCommand({ root, pkgRoot, argv: [], io: i, run, gh: fakeGh });
  expect(code).toBe(0);
  expect(o.out.join("\n")).toContain("doctor: PASS");
  const { io: iJson, o: oJson } = io();
  await doctorCommand({ root, pkgRoot, argv: ["--json"], io: iJson, run, gh: fakeGh });
  const { checks } = JSON.parse(oJson.out.join(""));
  const charter = checks.find((c) => c.id === "charter");
  expect(charter).toMatchObject({ level: "WARN" });
  expect(checks.every((c) => c.level !== "FAIL")).toBe(true);
  // Plan 4가 retro 역할 파일을 설치하면서 마지막 "아직 안 온 것" WARN이 사라졌다.
  expect(checks.find((c) => c.id === "roles.retro-agent-file")).toMatchObject({ level: "PASS" });
});

test("(a2) the factory scope lints every installed agent file — an agent that loses a required section turns doctor red", async () => {
  const root = await setupRepo();
  const run = makeDoctorRun(root);

  const { io: iOk, o: oOk } = io();
  await doctorCommand({ root, pkgRoot, argv: ["--json", "--offline", "--no-run"], io: iOk, run, gh: fakeGh });
  const ok = JSON.parse(oOk.out.join("")).checks.filter((c) => c.id.startsWith("agents."));
  expect(ok.length).toBe(14);                                   // 14 roles.toml 역할(retro 포함) — stub은 더 이상 없고(F5), loader는 감사 M5로 사라졌다
  expect(ok.every((c) => c.level === "PASS")).toBe(true);
  expect(ok.some((c) => c.id === "agents.factory-loader")).toBe(false);  // 감사 M5 — 검사할 파일 자체가 없다

  const agent = join(root, ".claude/agents/reviewer-correctness.md");
  writeFileSync(agent, readFileSync(agent, "utf8").replace(/## Lens\n[\s\S]*?(?=\n## )/, ""));
  const { io: iBad, o: oBad } = io();
  const code = await doctorCommand({ root, pkgRoot, argv: ["--json", "--offline", "--no-run"], io: iBad, run, gh: fakeGh });
  const bad = JSON.parse(oBad.out.join("")).checks.find((c) => c.id === "agents.reviewer-correctness");
  expect(bad).toMatchObject({ level: "FAIL", detail: expect.stringContaining("## Lens") });
  expect(code).toBe(1);
});

test("(b) missing harness.toml → single FAIL, exit 1, message says harness.toml unreadable", async () => {
  const root = await setupRepo();
  rmSync(join(root, ".factory/harness.toml"));
  const run = makeDoctorRun(root);
  const { io: i, o } = io();
  const code = await doctorCommand({ root, pkgRoot, argv: [], io: i, run, gh: fakeGh });
  expect(code).toBe(1);
  expect(o.out.join("\n")).toContain("harness.toml unreadable");
});

// M2: doctor.js reads harness.toml twice — `loadHarness` (fills `[factory].max_turns` default 12) for
// everything else, and `loadHarnessRaw` (no defaults filled) just for this one WARN, because the
// normalized object can never tell "missing" from "explicitly 12". This test drives that wiring from
// the CLI entry point (doctorCommand), not from checkHarness directly (doctor-harness.test.js already
// covers checkHarness in isolation) — a fake `deps.loadHarnessRaw` stands in for the real file parse
// (same fake-deps pattern as the `readFile` test above), proving doctorCommand forwards its result into
// checkHarness's `raw` param end to end.
test("(b2) doctorCommand wires loadHarnessRaw into checkHarness — a harness.toml without [factory].max_turns yields the WARN through the CLI", async () => {
  const root = await setupRepo();
  const run = makeDoctorRun(root);
  const { io: i, o } = io();
  const loadHarnessRaw = () => ({ factory: {} }); // raw parse with no [factory].max_turns key at all
  const code = await doctorCommand({ root, pkgRoot, argv: ["--json", "--offline", "--no-run"], io: i, run, gh: fakeGh, deps: { loadHarnessRaw } });
  expect(typeof code).toBe("number"); // did not throw
  const { checks } = JSON.parse(o.out.join(""));
  expect(checks.find((c) => c.id === "factory.max_turns")).toMatchObject({
    level: "WARN",
    detail: expect.stringContaining("run `npx know-thy-build factory init --upgrade`"),
  });
});

test("(c) --json prints a parseable { checks, summary }", async () => {
  const root = await setupRepo();
  const run = makeDoctorRun(root);
  const { io: i, o } = io();
  await doctorCommand({ root, pkgRoot, argv: ["--json"], io: i, run, gh: fakeGh });
  const parsed = JSON.parse(o.out.join(""));
  expect(Array.isArray(parsed.checks)).toBe(true);
  expect(parsed.checks.length).toBeGreaterThan(0);
  const total = parsed.summary.PASS + parsed.summary.WARN + parsed.summary.FAIL;
  expect(total).toBe(parsed.checks.length);
});

test("(d) --no-run skips executing commands and smoke: commands.run is WARN, no smoke.* checks", async () => {
  const root = await setupRepo();
  const run = makeDoctorRun(root);
  const { io: i, o } = io();
  await doctorCommand({ root, pkgRoot, argv: ["--no-run", "--json"], io: i, run, gh: fakeGh });
  const { checks } = JSON.parse(o.out.join(""));
  expect(checks.find((c) => c.id === "commands.run")).toMatchObject({ level: "WARN" });
  expect(checks.some((c) => c.id.startsWith("smoke."))).toBe(false);
});

test("(e) renderReport sorts FAIL first, then WARN, then PASS, and ends with the summary line", () => {
  const checks = [
    { id: "z.pass", level: "PASS" },
    { id: "a.warn", level: "WARN", detail: "hmm" },
    { id: "m.fail", level: "FAIL", detail: "broken" },
  ];
  const out = renderReport(checks).split("\n");
  expect(out[0]).toContain("m.fail");
  expect(out[0]).toContain("✗");
  expect(out[1]).toContain("a.warn");
  expect(out[2]).toContain("z.pass");
  expect(out.at(-1)).toBe("doctor: PASS 1 · WARN 1 · FAIL 1");
});

test("KTB-4: gh not injected + FACTORY_REPO unset — doctor resolves the repo like status.js and calls branch protection with it, not repos//branches/... ", async () => {
  const prevRepo = process.env.FACTORY_REPO;
  delete process.env.FACTORY_REPO;
  try {
    const root = await setupRepo();
    const run = makeDoctorRunNoGhInjected(root);
    const { io: i, o } = io();
    // no `gh` passed — doctorCommand must build its own client via resolveRepo({ run }), same as status.js.
    const code = await doctorCommand({ root, pkgRoot, argv: ["--json"], io: i, run });
    const { checks } = JSON.parse(o.out.join(""));
    const protectionCall = run.calls.find((c) => c.cmd === "gh" && c.args[0] === "api" && /branches\/main\/protection/.test(c.args[1] || ""));
    expect(protectionCall).toBeDefined();
    expect(protectionCall.args).toEqual(["api", "repos/o/r/branches/main/protection"]); // resolved repo, not "repos//..."
    // contexts=["factory/integrity"] came back → real protection, not the misleading "missing L0 contexts".
    expect(checks.find((c) => c.id === "github.protection")).toMatchObject({ level: "PASS" });
    expect(checks.some((c) => c.id === "github.unavailable")).toBe(false);
    expect(typeof code).toBe("number");
  } finally {
    if (prevRepo === undefined) delete process.env.FACTORY_REPO; else process.env.FACTORY_REPO = prevRepo;
  }
});

test("KTB-4: repo resolution failure (offline / not logged in) → github.unavailable WARN, never a misleading missing-contexts report", async () => {
  const prevRepo = process.env.FACTORY_REPO;
  delete process.env.FACTORY_REPO;
  try {
    const root = await setupRepo();
    const run = makeDoctorRunNoGhInjected(root, { repoLookup: { code: 1, stdout: "", stderr: "gh: not logged in to any hosts" } });
    const { io: i, o } = io();
    const code = await doctorCommand({ root, pkgRoot, argv: ["--json"], io: i, run });
    const { checks } = JSON.parse(o.out.join(""));
    expect(checks.find((c) => c.id === "github.unavailable")).toMatchObject({ level: "WARN", detail: expect.stringContaining("not logged in") });
    expect(checks.some((c) => c.id === "github.protection")).toBe(false); // no fabricated protection verdict
    expect(checks.some((c) => c.id.startsWith("github.") && c.id !== "github.unavailable")).toBe(false); // rest of github.* skipped too, cleanly
    // never sent the broken "repos//..." path.
    expect(run.calls.some((c) => c.cmd === "gh" && c.args[0] === "api" && (c.args[1] || "").includes("repos//"))).toBe(false);
    expect(typeof code).toBe("number");
  } finally {
    if (prevRepo === undefined) delete process.env.FACTORY_REPO; else process.env.FACTORY_REPO = prevRepo;
  }
});

test("--offline skips GitHub checks entirely (no gh injected, no github.* checks)", async () => {
  const root = await setupRepo();
  const run = makeDoctorRun(root);
  const { io: i, o } = io();
  const code = await doctorCommand({ root, pkgRoot, argv: ["--offline", "--json"], io: i, run });
  expect(code).toBe(0);
  const { checks } = JSON.parse(o.out.join(""));
  expect(checks.some((c) => c.id.startsWith("github."))).toBe(false);
});

test("smoke command that throws is caught as smoke.<level> FAIL and the env is still torn down (fix round 1, Important #1)", async () => {
  const root = await setupRepo();
  const run = makeDoctorRunSmokeThrows(root);
  const envDownCalls = [];
  const spyEnvDown = async (args) => { envDownCalls.push(args); return { ok: true, steps: [] }; };
  const { io: i, o } = io();
  const code = await doctorCommand({ root, pkgRoot, argv: ["--json"], io: i, run, gh: fakeGh, deps: { envDown: spyEnvDown } });
  expect(typeof code).toBe("number"); // did not throw / propagate
  expect(envDownCalls).toHaveLength(1); // torn down exactly once despite the throw
  const { checks } = JSON.parse(o.out.join(""));
  const smokeUnit = checks.find((c) => c.id === "smoke.unit");
  expect(smokeUnit).toMatchObject({ level: "FAIL" });
  expect(smokeUnit.detail).toContain("threw");
});

test("envUp partial failure still tears down with the pids it started, and reports smoke.env FAIL (fix round 1, Important #2)", async () => {
  const root = await setupRepo();
  const run = makeDoctorRun(root); // smoke.<level> commands never run on this branch
  const envDownCalls = [];
  const spyEnvDown = async (args) => { envDownCalls.push(args); return { ok: true, steps: [] }; };
  const spyEnvUp = async () => ({ ok: false, steps: [{ name: "seed", ok: false, detail: "exit 1: seed failed" }], pids: [7] });
  const { io: i, o } = io();
  const code = await doctorCommand({ root, pkgRoot, argv: ["--json"], io: i, run, gh: fakeGh, deps: { envUp: spyEnvUp, envDown: spyEnvDown } });
  expect(typeof code).toBe("number");
  expect(envDownCalls).toHaveLength(1);
  expect(envDownCalls[0].pids).toEqual([7]); // the partially-started pids are torn down, not dropped
  const { checks } = JSON.parse(o.out.join(""));
  expect(checks.find((c) => c.id === "smoke.env")).toMatchObject({ level: "FAIL", detail: expect.stringContaining("seed failed") });
  expect(checks.some((c) => c.id.startsWith("smoke.") && c.id !== "smoke.env")).toBe(false); // levels never ran
});

test("envUp failure also skips [commands] — commands.run.<k> report FAIL with a skip reason instead of running, and envDown still runs (Task 3, doctor gates vs env-up)", async () => {
  const root = await setupRepo();
  const run = makeDoctorRun(root);
  const envDownCalls = [];
  const spyEnvDown = async (args) => { envDownCalls.push(args); return { ok: true, steps: [] }; };
  const spyEnvUp = async () => ({ ok: false, steps: [{ name: "seed", ok: false, detail: "exit 1: seed failed" }], pids: [7] });
  const { io: i, o } = io();
  const code = await doctorCommand({ root, pkgRoot, argv: ["--json"], io: i, run, gh: fakeGh, deps: { envUp: spyEnvUp, envDown: spyEnvDown } });
  expect(typeof code).toBe("number");
  expect(envDownCalls).toHaveLength(1); // teardown still runs despite the skip
  const { checks } = JSON.parse(o.out.join(""));
  const lint = checks.find((c) => c.id === "commands.run.lint");
  const unit = checks.find((c) => c.id === "commands.run.unit");
  expect(lint).toMatchObject({ level: "FAIL", detail: expect.stringContaining("skipped: test env not up") });
  expect(unit).toMatchObject({ level: "FAIL", detail: expect.stringContaining("skipped: test env not up") });
  expect(lint.detail).toContain("seed failed"); // carries the actual env-up failure reason
  // the underlying gate commands themselves were never executed (no npm run lint / vitest run call).
  expect(run.calls.some((c) => c.cmd === "bash" && c.args[0] === "-lc" && /npm run lint|vitest run/.test(c.args[1] || ""))).toBe(false);
});

test("envDown failure during teardown is non-fatal — smoke.env-down WARN, doctor still finishes (fix round 1, Important #2)", async () => {
  const root = await setupRepo();
  const run = makeDoctorRun(root);
  const spyEnvDown = async () => ({ ok: false, steps: [{ name: "compose-down", ok: false, detail: "exit 1" }] });
  const { io: i, o } = io();
  const code = await doctorCommand({ root, pkgRoot, argv: ["--json"], io: i, run, gh: fakeGh, deps: { envDown: spyEnvDown } });
  expect(typeof code).toBe("number");
  const { checks } = JSON.parse(o.out.join(""));
  expect(checks.find((c) => c.id === "smoke.env-down")).toMatchObject({ level: "WARN", detail: expect.stringContaining("compose-down") });
});

/**
 * CI는 스테이지를 돌리기 전에 `.factory/actions/setup`(test-env: true)으로 하네스 테스트 환경을 먼저 띄운다 —
 * 게이트 명령은 **그 환경 안에서** 판정된다. doctor가 `[commands]`를 환경 없이 실행하면, DB가 등장한
 * M1+ 저장소는 전부 `commands.run.unit`에서 "service db is not running"으로 상시 FAIL이 뜨고 그건
 * 어떤 픽스처 수정으로도 고칠 수 없다(= 사람이 doctor를 무시하게 되는 종류의 거짓 FAIL).
 */
test("harness test env wraps the command gates — envUp precedes [commands], envDown follows the smoke (Plan 6 Task 1)", async () => {
  const root = await setupRepo();
  const hp = join(root, ".factory/harness.toml");
  writeFileSync(hp, readFileSync(hp, "utf8").replace('# compose   = "docker-compose.test.yml"', 'compose   = "docker-compose.test.yml"'));
  const run = makeDoctorRun(root);
  const { io: i } = io();
  await doctorCommand({ root, pkgRoot, argv: ["--offline", "--json"], io: i, run, gh: fakeGh });

  const at = (pred) => run.calls.findIndex(pred);
  const up = at((c) => c.cmd === "docker" && c.args.includes("up"));
  const unit = at((c) => c.cmd === "bash" && c.args[0] === "-lc" && c.args[1].includes("--outputFile=.factory/out/unit.json"));
  const down = at((c) => c.cmd === "docker" && c.args.includes("down"));
  expect(up).toBeGreaterThanOrEqual(0);
  expect(unit).toBeGreaterThan(up);     // 명령은 환경이 올라온 뒤에 판정된다
  expect(down).toBeGreaterThan(unit);   // 환경은 명령과 스모크가 끝난 뒤에 내려간다
  // 컴포즈를 두 번 올렸다 내리면 스모크가 명령 게이트와 다른 환경에서 도는 것이고, 느리기까지 하다.
  expect(run.calls.filter((c) => c.cmd === "docker" && c.args.includes("up"))).toHaveLength(1);
});

test("settings template unreadable → settings.template FAIL instead of throwing (fix round 1, Minor #3)", async () => {
  const root = await setupRepo();
  const run = makeDoctorRun(root);
  const { io: i, o } = io();
  // checkFiles also reads this same source path once (to render/compare .claude/settings.json) — only the
  // *second* read (doctor.js's own template load for checkSettings) should fail, so checkFiles isn't disturbed.
  let templateReads = 0;
  const readFile = (p) => {
    if (p.endsWith("templates/factory/claude/settings.json") && ++templateReads === 2) throw new Error("ENOENT: no such file");
    return readFileSync(p, "utf8");
  };
  const code = await doctorCommand({ root, pkgRoot, argv: ["--json"], io: i, run, gh: fakeGh, deps: { readFile } });
  expect(typeof code).toBe("number"); // did not throw
  const { checks } = JSON.parse(o.out.join(""));
  expect(checks.find((c) => c.id === "settings.template")).toMatchObject({ level: "FAIL", detail: expect.stringContaining("ENOENT") });
  expect(checks.some((c) => c.id === "settings.deny")).toBe(false); // checkSettings itself skipped, not half-run
});

test("factory scope skipped when .factory/bin/run-stage.js is absent → factory.initialized PASS hint", async () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-doctor-uninit-"));
  mkdirSync(join(root, ".factory"), { recursive: true });
  const tmplHarness = readFileSync(join(pkgRoot, "templates/factory/factory/harness.toml"), "utf8").replace("{{PROJECT_NAME}}", "demo");
  writeFileSync(join(root, ".factory/harness.toml"), tmplHarness);
  const run = makeDoctorRun(root);
  const { io: i, o } = io();
  await doctorCommand({ root, pkgRoot, argv: ["--no-run", "--offline", "--json"], io: i, run });
  const { checks } = JSON.parse(o.out.join(""));
  // 최소 harness.toml만 있는 저장소라 harness-scope의 다른 정적 검사(예: protected.globs-match)는 FAIL일 수 있다 —
  // 이 테스트가 확인하는 건 factory 스코프가 건너뛰어지고 factory.initialized 안내가 뜨는 분기뿐이다.
  expect(checks.find((c) => c.id === "factory.initialized")).toMatchObject({ level: "PASS", detail: expect.stringContaining("not initialized — run factory init") });
  expect(checks.some((c) => c.id === "files.missing" || c.id === "charter" || c.id.startsWith("github."))).toBe(false);
});
