import { test, expect } from "vitest";
import { checkFiles, checkCharter, checkRoles, checkSettings, checkHooks, checkWorkflows, checkGitHub } from "../lib/doctor/factory.js";
import { makeFakeRun, run } from "../lib/exec.js";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const by = (cs) => Object.fromEntries(cs.map((c) => [c.id, c]));
const REAL_HOOKS_DIR = new URL("../hooks/", import.meta.url).pathname;

test("checkFiles: missing factory file FAIL, stale WARN, project file never compared", () => {
  const manifest = [{ src: "/p/a.js", dest: ".factory/lib/a.js", owner: "factory" }, { src: "/p/b.js", dest: ".factory/bin/b.js", owner: "factory" }, { src: "/p/h.toml", dest: ".factory/harness.toml", owner: "project" }];
  const files = { "/r/.factory/lib/a.js": "old", "/r/.factory/harness.toml": "x", "/p/a.js": "new", "/p/b.js": "b", "/p/h.toml": "t" };
  const c = by(checkFiles({ manifest, root: "/r", exists: (p) => p in files, readFile: (p) => files[p], vars: {} }));
  expect(c["files.missing"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining(".factory/bin/b.js") });
  expect(c["files.stale"]).toMatchObject({ level: "WARN", detail: expect.stringContaining(".factory/lib/a.js") });
  expect(c["files.stale"].detail).not.toContain("harness.toml");
});

test("checkFiles: all factory files present and identical → both PASS", () => {
  const manifest = [{ src: "/p/a.js", dest: ".factory/lib/a.js", owner: "factory" }];
  const files = { "/r/.factory/lib/a.js": "same", "/p/a.js": "same" };
  const c = by(checkFiles({ manifest, root: "/r", exists: (p) => p in files, readFile: (p) => files[p], vars: {} }));
  expect(c["files.missing"].level).toBe("PASS");
  expect(c["files.stale"].level).toBe("PASS");
});

test("checkCharter: absent WARN, draft WARN, ready PASS, broken FAIL", () => {
  expect(by(checkCharter({ root: "/r", loadCharter: () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } }))["charter"].level).toBe("WARN");
  expect(by(checkCharter({ root: "/r", loadCharter: () => ({ status: "draft" }) }))["charter"].level).toBe("WARN");
  expect(by(checkCharter({ root: "/r", loadCharter: () => ({ status: "ready" }) }))["charter"].level).toBe("PASS");
  expect(by(checkCharter({ root: "/r", loadCharter: () => { throw new Error("schema"); } }))["charter"].level).toBe("FAIL");
});

test("checkRoles: unknown roster name FAIL, missing agent file FAIL with Plan 3 hint, missing lessons WARN", () => {
  const charter = { roster: { docs: ["correctness", "ghost"] }, plan_roles: { default: ["architect"] } };
  const roles = { review: { correctness: { agent: ".claude/agents/reviewer-correctness.md", lessons: ".factory/lessons/reviewer-correctness.md" } }, plan: { architect: { agent: ".claude/agents/plan-architect.md" } }, triage: { agent: ".claude/agents/factory-triage.md" } };
  const c = by(checkRoles({ charter, roles, root: "/r", exists: (p) => p.endsWith("plan-architect.md") }));
  expect(c["roles.roster-defined"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("ghost") });
  expect(c["roles.agent-files"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("reviewer-correctness.md") });
  expect(c["roles.agent-files"].detail).toContain("Plan 3");
  expect(c["roles.lessons-files"].level).toBe("WARN");
});

test("checkRoles: roles.agent-files covers every defined role, even one absent from the CHARTER roster", () => {
  const charter = { roster: { docs: ["correctness"] }, plan_roles: { default: ["architect"] } };
  const roles = {
    review: { correctness: { agent: ".claude/agents/reviewer-correctness.md" } },
    plan: { architect: { agent: ".claude/agents/plan-architect.md" }, synthesizer: { agent: ".claude/agents/plan-synthesizer.md" } },
    triage: { agent: ".claude/agents/factory-triage.md" },
  };
  // synthesizer isn't named by any CHARTER tier, so roster-defined must stay clean; agent-files must still catch it.
  const c = by(checkRoles({ charter, roles, root: "/r", exists: (p) => !p.endsWith("plan-synthesizer.md") }));
  expect(c["roles.roster-defined"].level).toBe("PASS");
  expect(c["roles.agent-files"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("plan-synthesizer.md") });
});

test("checkRoles: everything present → all PASS", () => {
  const charter = { roster: { docs: ["correctness"] }, plan_roles: { default: ["architect"] } };
  const roles = { review: { correctness: { agent: ".claude/agents/reviewer-correctness.md", lessons: ".factory/lessons/reviewer-correctness.md" } }, plan: { architect: { agent: ".claude/agents/plan-architect.md" } }, triage: { agent: ".claude/agents/factory-triage.md" } };
  const c = by(checkRoles({ charter, roles, root: "/r", exists: () => true }));
  expect(c["roles.roster-defined"].level).toBe("PASS");
  expect(c["roles.agent-files"].level).toBe("PASS");
  expect(c["roles.lessons-files"].level).toBe("PASS");
});

test("checkSettings: deny subset and hook commands", () => {
  const template = { permissions: { deny: ["A", "B"] }, hooks: { Stop: [{ hooks: [{ command: ".claude/hooks/s.sh" }] }] } };
  const c = by(checkSettings({ settings: { permissions: { deny: ["A"] }, hooks: {} }, template }));
  expect(c["settings.deny"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("B") });
  expect(c["settings.hooks"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("s.sh") });
  expect(by(checkSettings({ settings: null, template }))["settings.present"].level).toBe("FAIL");
});

test("checkSettings: deny superset and all hook commands present → PASS", () => {
  const template = { permissions: { deny: ["A"] }, hooks: { Stop: [{ hooks: [{ command: ".claude/hooks/s.sh" }] }] } };
  const settings = { permissions: { deny: ["A", "B"] }, hooks: { Stop: [{ hooks: [{ command: ".claude/hooks/s.sh" }] }] } };
  const c = by(checkSettings({ settings, template }));
  expect(c["settings.present"].level).toBe("PASS");
  expect(c["settings.deny"].level).toBe("PASS");
  expect(c["settings.hooks"].level).toBe("PASS");
});

test("checkHooks: runs each hook with stdin JSON and checks exit code; verdict-format gets a real transcript file", async () => {
  const fakeRun = makeFakeRun([
    {
      match: (cmd, a) => a[0].endsWith("verdict-format.sh"),
      result: (cmd, a, opts) => {
        const payload = JSON.parse(opts.input);
        // 판정 훅은 fail-open이라(`[ -f "$path" ] || exit 0`) 실재하는 transcript가 없으면 exit 2를 못 낸다 —
        // checkHooks가 default mkTemp/writeFile로 실제 파일을 써 둔다는 것을 여기서 검증한다.
        if (!existsSync(payload.agent_transcript_path)) throw new Error("transcript fixture missing on disk at call time");
        return { code: 2, stdout: "", stderr: "" };
      },
    },
    { match: () => true, result: { code: 0, stdout: "", stderr: "" } },
  ]);
  const c = by(await checkHooks({ run: fakeRun, root: "/r", exists: () => true, readFile: () => "#!/bin/bash\nexit 0\n", hooks: ["record-agents.sh", "block-dangerous.sh", "verdict-format.sh"] }));
  expect(c["hooks.record-agents.sh"].level).toBe("PASS");   // 같은 transcript를 받아도 record-agents.sh는 신경 쓰지 않는다
  expect(c["hooks.block-dangerous.sh"].level).toBe("PASS");
  expect(c["hooks.verdict-format.sh"].level).toBe("PASS");   // 판정 훅은 SubagentStop 입력에 verdict가 없으면 exit 2가 정상
  expect(fakeRun.calls.every((x) => typeof x.opts.input === "string" && JSON.parse(x.opts.input).hook_event_name)).toBe(true);
  const vfCall = fakeRun.calls.find((x) => x.args[0].endsWith("verdict-format.sh"));
  const raCall = fakeRun.calls.find((x) => x.args[0].endsWith("record-agents.sh"));
  expect(JSON.parse(vfCall.opts.input).agent_transcript_path).toBe(JSON.parse(raCall.opts.input).agent_transcript_path); // shared fixture
});

test("checkHooks: real verdict-format.sh exits 2 without a verdict block; record-agents.sh exits 0 regardless of the transcript", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ktb-doctor-hooks-"));
  try {
    const c = by(await checkHooks({
      run, root: cwd, hooksDir: REAL_HOOKS_DIR,
      exists: existsSync, readFile: (p) => readFileSync(p, "utf8"),
      hooks: ["record-agents.sh", "verdict-format.sh"],
    }));
    expect(c["hooks.verdict-format.sh"].level).toBe("PASS");
    expect(c["hooks.record-agents.sh"].level).toBe("PASS");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 15000);

test("checkHooks: missing hook file FAILs without running it; logging hook missing exit 0 FAILs", async () => {
  const run = makeFakeRun([{ match: () => true, result: { code: 1, stdout: "", stderr: "" } }]);
  const c = by(await checkHooks({ run, root: "/r", exists: (p) => !p.endsWith("stop-guard.sh"), readFile: () => "#!/bin/bash\necho hi\n", hooks: ["stop-guard.sh", "lint-touched.sh"] }));
  expect(c["hooks.stop-guard.sh"].level).toBe("FAIL");
  expect(run.calls.length).toBe(1); // only lint-touched.sh ran
  expect(c["hooks.lint-touched.sh"].level).toBe("FAIL"); // exit 1 != 0, and missing trailing exit 0
});

test("checkWorkflows: all seven present and lint-clean", () => {
  const c = by(checkWorkflows({ root: "/r", exists: (p) => !p.endsWith("factory-merge.yml"), readFile: () => "with: { a: ${{ x }} }\n" }));
  expect(c["workflows.present"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("factory-merge.yml") });
  expect(c["workflows.lint"].level).toBe("FAIL");
});

test("checkWorkflows: all seven present and lint-clean → PASS", () => {
  const c = by(checkWorkflows({ root: "/r", exists: () => true, readFile: () => "on: push\n" }));
  expect(c["workflows.present"].level).toBe("PASS");
  expect(c["workflows.lint"].level).toBe("PASS");
});

test("checkGitHub: secrets, token date, labels, protection", async () => {
  const gh = { listSecrets: async () => ["FACTORY_BOT_TOKEN"], getVariable: async () => null, listLabels: async () => ["backlog"], getBranchProtection: async () => ({ required_status_checks: { contexts: ["factory/gates"] } }) };
  const c = by(await checkGitHub({ gh, harness: { project: { default_branch: "main" }, factory: { required_checks: ["factory/gates", "factory/review"] } }, labels: [{ name: "backlog" }, { name: "factory:queue" }] }));
  expect(c["github.claude-secret"].level).toBe("FAIL");
  expect(c["github.bot-token"].level).toBe("PASS");
  expect(c["github.token-issued-at"].level).toBe("WARN");
  expect(c["github.labels"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("factory:queue") });
  expect(c["github.protection"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("factory/review") });
});

test("checkGitHub: gh unavailable → single WARN, no other github.* checks", async () => {
  const gh = { listSecrets: async () => { throw new Error("not authenticated"); } };
  const c = by(await checkGitHub({ gh, harness: { project: { default_branch: "main" }, factory: { required_checks: [] } }, labels: [] }));
  expect(Object.keys(c)).toEqual(["github.unavailable"]);
  expect(c["github.unavailable"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("not authenticated") });
});

test("checkGitHub: all green → PASS across the board", async () => {
  const gh = { listSecrets: async () => ["CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_BOT_TOKEN"], getVariable: async () => "2026-01-01T00:00:00Z", listLabels: async () => ["backlog", "factory:queue"], getBranchProtection: async () => ({ required_status_checks: { contexts: ["factory/gates", "factory/review"] } }) };
  const c = by(await checkGitHub({ gh, harness: { project: { default_branch: "main" }, factory: { required_checks: ["factory/gates", "factory/review"] } }, labels: [{ name: "backlog" }, { name: "factory:queue" }] }));
  expect(c["github.claude-secret"].level).toBe("PASS");
  expect(c["github.bot-token"].level).toBe("PASS");
  expect(c["github.token-issued-at"].level).toBe("PASS");
  expect(c["github.labels"].level).toBe("PASS");
  expect(c["github.protection"].level).toBe("PASS");
});
