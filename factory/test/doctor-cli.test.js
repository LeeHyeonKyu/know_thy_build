import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { initCommand } from "../cli/init.js";
import { doctorCommand } from "../cli/doctor.js";
import { renderReport } from "../lib/doctor/report.js";
import { makeFakeRun } from "../lib/exec.js";
import { readdirRecursive } from "../cli/manifest.js";

const pkgRoot = new URL("../../", import.meta.url).pathname;
const io = () => { const o = { out: [], err: [] }; return { io: { out: (s) => o.out.push(s), err: (s) => o.err.push(s) }, o }; };

/** roles.toml 안에서 agent = "..." 로 나오는 모든 경로를 찾는다 (triage/plan/implement/review/merge/retro 전부). */
function collectAgentPaths(node) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.agent === "string") out.push(n.agent);
    for (const v of Object.values(n)) if (v && typeof v === "object") walk(v);
  };
  walk(node);
  return out;
}

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
  getVariable: async () => "2026-01-01T00:00:00Z",
  listLabels: async () => ["backlog"],
  getBranchProtection: async () => ({ required_status_checks: { contexts: ["factory/gates", "factory/review", "factory/integrity"] } }),
};

/** initCommand로 설치 + roles.toml에 정의된 모든 agent 파일 stub + test/smoke.test.js stub. */
async function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "ktb-doctor-cli-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo-app" }));
  const { io: i } = io();
  expect(await initCommand({ root, pkgRoot, argv: [], io: i })).toBe(0);

  const roles = parseToml(readFileSync(join(root, ".factory/roles.toml"), "utf8"));
  for (const p of collectAgentPaths(roles)) {
    const full = join(root, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "# stub agent\n");
  }
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
