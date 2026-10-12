import { test, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { checkPlatform } from "../lib/doctor/platform.js";
import { makeGh } from "../lib/gh.js";
import { makeFakeRun } from "../lib/exec.js";
import { initCommand } from "../cli/init.js";
import { doctorCommand } from "../cli/doctor.js";
import { readdirRecursive } from "../cli/manifest.js";

/**
 * #234 (gap P-8, B-1·B-2) — **Actions가 막혀도 그 사실을 아는 주체가 Actions 밖에 있어야 한다.**
 * private 저장소 + GitHub 호스팅 러너는 월 포함분이 떨어지는 순간 모든 스테이지·sweeper·integrity가 함께
 * 멈춘다; Free 플랜 private은 브랜치 보호·환경 시크릿·환경 리뷰어가 없어 두 배우 모드가 조용히 훅으로
 * 강등된다. doctor가 그 둘을 WARN으로 말한다. 못 읽은 입력은 PASS가 아니라 "unverified" WARN이다.
 *
 * 픽스처는 `gh` CLI가 **실제로 내놓는 바이트**다(`makeGh` + 가짜 `run`): 어댑터의 파싱(변수 없음 vs
 * 못 읽음, 소유자 플랜을 누가 읽을 수 있는가)까지 같은 테스트가 지나간다.
 */

const HOSTED = "actions.hosted-minutes-metered";
const FREE = "plan.free-private";
const HOSTED_TEXT = "private repo on GitHub-hosted runners — the included minutes run out and every stage, the sweeper and integrity stop together; set FACTORY_RUNNER to a self-hosted label or make the repo public";
const FREE_TEXT = "branch protection, environment secrets and environment reviewers are unavailable — the two-actor mode degrades to the hook; FACTORY_MERGE_TOKEN cannot live in the factory-merge environment";

const ok = (o) => ({ code: 0, stdout: typeof o === "string" ? o : JSON.stringify(o), stderr: "" });
const fail = (stderr, code = 1) => ({ code, stdout: "", stderr });

/**
 * 한 저장소의 GitHub 쪽 사실을 gh CLI 응답으로 편다.
 *  - repo: `gh api repos/o/r`의 결과(객체면 성공, 문자열이면 그 stderr로 실패)
 *  - runner: `gh variable get FACTORY_RUNNER`(문자열 = 값, NOT_FOUND = 변수 없음, {fail} = 못 읽음)
 *  - viewer: `gh api user`, org: `gh api orgs/o`
 */
const NOT_FOUND = Symbol("not found");
function platformRun({ repo, runner, viewer, org }) {
  return makeFakeRun([
    { match: (c, a) => c === "gh" && a[0] === "api" && a[1] === "repos/o/r", result: () => (typeof repo === "string" ? fail(repo) : ok(repo)) },
    {
      match: (c, a) => c === "gh" && a[0] === "variable" && a[1] === "get" && a[2] === "FACTORY_RUNNER",
      result: () => (runner === NOT_FOUND ? fail("variable FACTORY_RUNNER was not found") : runner?.fail ? fail(runner.fail) : ok(`${runner}\n`)),
    },
    { match: (c, a) => c === "gh" && a[0] === "api" && a[1] === "user", result: () => (viewer ? ok(viewer) : fail("HTTP 403: Resource not accessible by integration (https://api.github.com/user)")) },
    { match: (c, a) => c === "gh" && a[0] === "api" && a[1] === "orgs/o", result: () => (org ? ok(org) : fail("HTTP 404: Not Found (https://api.github.com/orgs/o)")) },
  ]);
}

async function verdicts(facts) {
  const gh = makeGh({ run: platformRun(facts), repo: "o/r" });
  const checks = await checkPlatform({ gh, repo: "o/r" });
  const by = Object.fromEntries(checks.map((c) => [c.id, c]));
  expect(Object.keys(by).sort()).toEqual([HOSTED, FREE].sort());
  return by;
}

const PRIVATE = { full_name: "o/r", private: true, visibility: "private", owner: { login: "o", type: "User" } };
const PUBLIC = { full_name: "o/r", private: false, visibility: "public", owner: { login: "o", type: "User" } };
const OWNER_FREE = { login: "o", plan: { name: "free" } };
const OWNER_PRO = { login: "o", plan: { name: "pro" } };

test("test_234_doctor_warns_private_repo_on_hosted_runners_and_free_plan_limits", async () => {
  // private + FACTORY_RUNNER unset (workflows fall back to ubuntu-latest) → metered WARN with the issue's remediation text
  const unset = await verdicts({ repo: PRIVATE, runner: NOT_FOUND, viewer: OWNER_FREE });
  expect(unset[HOSTED].level).toBe("WARN");
  expect(unset[HOSTED].detail).toContain(HOSTED_TEXT);
  expect(unset[HOSTED].detail).not.toMatch(/unverified/i);
  // …and the same repo on the Free plan → plan.free-private WARN with its text
  expect(unset[FREE].level).toBe("WARN");
  expect(unset[FREE].detail).toContain(FREE_TEXT);
  expect(unset[FREE].detail).not.toMatch(/unverified/i);

  // private + an explicit GitHub-hosted label → still metered
  for (const label of ["ubuntu-latest", "ubuntu-24.04", "windows-2022", "macos-14"]) {
    const hosted = await verdicts({ repo: PRIVATE, runner: label, viewer: OWNER_PRO });
    expect(hosted[HOSTED], label).toMatchObject({ level: "WARN", detail: expect.stringContaining(HOSTED_TEXT) });
  }

  // private + a self-hosted label → PASS (minutes are not metered on self-hosted runners)
  const selfHosted = await verdicts({ repo: PRIVATE, runner: "ktb-box", viewer: OWNER_PRO });
  expect(selfHosted[HOSTED].level).toBe("PASS");
  expect(selfHosted[HOSTED].detail).toContain("ktb-box");
  // private + paid plan → plan.free-private PASS
  expect(selfHosted[FREE].level).toBe("PASS");

  // public → both PASS, whatever the runner and plan are
  const pub = await verdicts({ repo: PUBLIC, runner: NOT_FOUND, viewer: OWNER_FREE });
  expect(pub[HOSTED].level).toBe("PASS");
  expect(pub[FREE].level).toBe("PASS");

  // an organization owner's plan is read from orgs/<owner> when the viewer is somebody else
  const orgFree = await verdicts({ repo: { ...PRIVATE, owner: { login: "o", type: "Organization" } }, runner: "ktb-box", viewer: { login: "someone", plan: { name: "pro" } }, org: { login: "o", plan: { name: "free" } } });
  expect(orgFree[FREE]).toMatchObject({ level: "WARN", detail: expect.stringContaining(FREE_TEXT) });
  // …and the viewer's OWN plan is never mistaken for the owner's
  const notMine = await verdicts({ repo: PRIVATE, runner: "ktb-box", viewer: { login: "someone", plan: { name: "free" } } });
  expect(notMine[FREE].level).toBe("WARN");
  expect(notMine[FREE].detail).toMatch(/unverified/i);

  // ── unreadable inputs: WARN "unverified", never PASS and never FAIL ──
  // visibility unreadable → both checks unverified (even with a self-hosted runner and a paid plan)
  const noRepo = await verdicts({ repo: "HTTP 404: Not Found (https://api.github.com/repos/o/r)", runner: "ktb-box", viewer: OWNER_PRO });
  for (const id of [HOSTED, FREE]) {
    expect(noRepo[id].level, id).toBe("WARN");
    expect(noRepo[id].detail, id).toMatch(/unverified/i);
  }
  // the variable is unreadable (403 — NOT "was not found") → metered check unverified, not the unset verdict
  const noVar = await verdicts({ repo: PRIVATE, runner: { fail: "HTTP 403: Resource not accessible by integration" }, viewer: OWNER_PRO });
  expect(noVar[HOSTED].level).toBe("WARN");
  expect(noVar[HOSTED].detail).toMatch(/unverified/i);
  expect(noVar[HOSTED].detail).not.toContain(HOSTED_TEXT);
  // the plan is unreadable (GitHub App token: /user 403, orgs/o 404) → plan check unverified
  const noPlan = await verdicts({ repo: PRIVATE, runner: "ktb-box", viewer: null, org: null });
  expect(noPlan[FREE].level).toBe("WARN");
  expect(noPlan[FREE].detail).toMatch(/unverified/i);
  expect(noPlan[FREE].detail).not.toContain(FREE_TEXT);

  // a gh client that lacks the methods altogether (an older injected fake) still yields two unverified WARNs
  const bare = await checkPlatform({ gh: {}, repo: "o/r" });
  expect(bare.map((c) => [c.id, c.level])).toEqual([[HOSTED, "WARN"], [FREE, "WARN"]]);
  for (const c of bare) expect(c.detail).toMatch(/unverified/i);
  // no repo resolved → unverified, no call made
  const noRepoName = await checkPlatform({ gh: makeGh({ run: platformRun({ repo: PRIVATE, runner: NOT_FOUND, viewer: OWNER_FREE }), repo: "o/r" }), repo: null });
  for (const c of noRepoName) expect(c).toMatchObject({ level: "WARN", detail: expect.stringMatching(/unverified/i) });
});

// ── dw2 — the checks are wired into `factory doctor`, inside the gh guard ─────────────────────

const pkgRoot = new URL("../../", import.meta.url).pathname;
const io = () => { const o = { out: [], err: [] }; return { io: { out: (s) => o.out.push(s), err: (s) => o.err.push(s) }, o }; };
const allFiles = (root) => readdirRecursive(root).map((p) => relative(root, p).split(sep).join("/"));

async function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "ktb-doctor-platform-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo-app" }));
  const { io: i } = io();
  expect(await initCommand({ root, pkgRoot, argv: [], io: i })).toBe(0);
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "test/smoke.test.js"), "test('smoke', () => {});\n");
  return root;
}

function doctorRun(root, extra = []) {
  return makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "ls-files", result: () => ({ code: 0, stdout: allFiles(root).join("\n"), stderr: "" }) },
    ...extra,
    { match: (c, a) => c === "bash" && a[0] && a[0].endsWith("verdict-format.sh"), result: { code: 2, stdout: "", stderr: "" } },
    { match: () => true, result: { code: 0, stdout: "", stderr: "" } },
  ]);
}

function platformGh() {
  return {
    repo: "o/r",
    listSecrets: async () => ["CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_BOT_TOKEN"],
    listEnvSecrets: async () => [],
    getVariable: async () => "2026-01-01T00:00:00Z",
    listLabels: async () => ["backlog"],
    getBranchProtection: async () => ({ required_status_checks: { contexts: ["factory/gates", "factory/review", "factory/integrity"] } }),
    repoInfo: vi.fn(async () => ({ fullName: "o/r", private: true, permissions: null })),
    variableState: vi.fn(async () => ({ state: "unset" })),
    ownerPlan: vi.fn(async () => "free"),
  };
}

test("test_234_doctor_cli_reports_platform_checks_and_skips_them_offline", async () => {
  const root = await setupRepo();
  const run = doctorRun(root);

  // online, gh reachable → both checks in --json …
  const gh = platformGh();
  const { io: i, o } = io();
  await doctorCommand({ root, pkgRoot, argv: ["--json", "--no-run"], io: i, run, gh, deps: { env: {} } });
  const { checks } = JSON.parse(o.out.join(""));
  expect(checks.find((c) => c.id === HOSTED)).toMatchObject({ level: "WARN", detail: expect.stringContaining(HOSTED_TEXT) });
  expect(checks.find((c) => c.id === FREE)).toMatchObject({ level: "WARN", detail: expect.stringContaining(FREE_TEXT) });
  expect(gh.repoInfo).toHaveBeenCalledWith("o/r");
  expect(gh.variableState).toHaveBeenCalledWith("FACTORY_RUNNER");
  expect(gh.ownerPlan).toHaveBeenCalledWith("o");

  // … and in the human report
  const { io: iText, o: oText } = io();
  await doctorCommand({ root, pkgRoot, argv: ["--no-run"], io: iText, run, gh: platformGh(), deps: { env: {} } });
  const text = oText.out.join("\n");
  expect(text).toContain(HOSTED);
  expect(text).toContain(FREE);

  // --offline → no platform API call at all, no platform verdict, the rest of the report still comes out
  const offGh = platformGh();
  const { io: iOff, o: oOff } = io();
  await doctorCommand({ root, pkgRoot, argv: ["--json", "--no-run", "--offline"], io: iOff, run, gh: offGh });
  const off = JSON.parse(oOff.out.join(""));
  expect(off.checks.some((c) => c.id === HOSTED || c.id === FREE)).toBe(false);
  expect(offGh.repoInfo).not.toHaveBeenCalled();
  expect(offGh.variableState).not.toHaveBeenCalled();
  expect(offGh.ownerPlan).not.toHaveBeenCalled();
  expect(off.checks.some((c) => c.id === "charter")).toBe(true);
  expect(off.summary.PASS + off.summary.WARN + off.summary.FAIL).toBe(off.checks.length);

  // repo cannot be resolved (no gh injected, `gh repo view` fails) → no platform call, github.unavailable, report still out
  const prevRepo = process.env.FACTORY_REPO;
  delete process.env.FACTORY_REPO;
  try {
    const noRepoRun = doctorRun(root, [
      { match: (c, a) => c === "gh" && a[0] === "repo" && a[1] === "view", result: { code: 1, stdout: "", stderr: "gh: not logged in to any hosts" } },
    ]);
    const { io: iNo, o: oNo } = io();
    await doctorCommand({ root, pkgRoot, argv: ["--json", "--no-run"], io: iNo, run: noRepoRun, deps: { env: {} } });
    const no = JSON.parse(oNo.out.join(""));
    expect(no.checks.some((c) => c.id === HOSTED || c.id === FREE)).toBe(false);
    expect(no.checks.find((c) => c.id === "github.unavailable")).toMatchObject({ level: "WARN" });
    const ghCalls = noRepoRun.calls.filter((c) => c.cmd === "gh").map((c) => c.args.join(" "));
    expect(ghCalls).toEqual(["repo view --json nameWithOwner"]);
    expect(no.checks.some((c) => c.id === "charter")).toBe(true);
  } finally {
    if (prevRepo === undefined) delete process.env.FACTORY_REPO; else process.env.FACTORY_REPO = prevRepo;
  }
}, 120000);
