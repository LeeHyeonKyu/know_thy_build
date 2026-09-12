import { test, expect } from "vitest";
import { checkFiles, checkCharter, checkRoles, checkAgents, checkSkills, checkSettings, checkHooks, checkWorkflows, checkGitHub } from "../lib/doctor/factory.js";
import { ALL_SKILLS, DEFINE_SKILLS } from "../lib/skill-md.js";
import { makeFakeRun, run } from "../lib/exec.js";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as toml } from "smol-toml";
import { L0_CONTEXTS } from "../lib/bootstrap.js";
const by = (cs) => Object.fromEntries(cs.map((c) => [c.id, c]));
const REAL_HOOKS_DIR = new URL("../hooks/", import.meta.url).pathname;
const AGENT_TEMPLATES = new URL("../../templates/factory/claude/agents/", import.meta.url).pathname;
const ROLES_TEMPLATE = new URL("../../templates/factory/factory/roles.toml", import.meta.url).pathname;
const agentText = (name) => readFileSync(`${AGENT_TEMPLATES}${name}.md`, "utf8");

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

// KTB-11: .claude/settings.json은 manifest.js가 merge:"settings"로 표시한다 — init/upgrade가
// mergeSettings로 병합하는 파일이라, "stale"의 정의도 바이트 동등이 아니라 mergeSettings 자체여야 한다.
// 그렇지 않으면 사용자가 자기 deny/allow/훅을 정당하게 추가한 저장소가 영원히 files.stale WARN을 문다.
test("checkFiles: merge:'settings' entries are stale only when mergeSettings would change them, not on byte inequality (KTB-11)", () => {
  const template = JSON.stringify({
    permissions: { deny: ["Bash(rm -rf *)"], allow: ["Bash(npm test*)"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "block-dangerous.sh" }] }] },
  });
  const manifest = [{ src: "/p/settings.json", dest: ".claude/settings.json", owner: "factory", merge: "settings" }];
  const check = (installed) => {
    const files = { "/r/.claude/settings.json": installed, "/p/settings.json": template };
    return by(checkFiles({ manifest, root: "/r", exists: (p) => p in files, readFile: (p) => files[p], vars: {} }));
  };

  // 사용자가 템플릿 항목을 전부 갖고 있으면서 자기 것도 추가했다(바이트는 다르다) → PASS
  const customized = JSON.stringify({
    permissions: { deny: ["Bash(rm -rf *)", "Bash(sudo *)"], allow: ["Bash(npm test*)", "Bash(npm run build*)"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "block-dangerous.sh" }] }] },
  });
  expect(check(customized)["files.stale"].level).toBe("PASS");

  // 템플릿 훅 하나가 빠졌다 → mergeSettings가 그것을 덧붙이므로 병합 결과가 설치본과 달라진다 → WARN
  const missingHook = JSON.stringify({
    permissions: { deny: ["Bash(rm -rf *)"], allow: ["Bash(npm test*)"] },
    hooks: { PreToolUse: [] },
  });
  expect(check(missingHook)).toMatchObject({ "files.stale": { level: "WARN", detail: expect.stringContaining(".claude/settings.json") } });

  // 바이트 동일 → 그대로 PASS(회귀 방지)
  expect(check(template)["files.stale"].level).toBe("PASS");
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

// ── F5: retro는 Plan 4가 채운다 — 알려진·계획된 gap은 FAIL이 아니라 WARN이다 ────────────────
test("checkRoles: a missing retro agent file is WARN (Plan 4), a missing agent for any other stage is still FAIL", () => {
  const charter = { roster: {}, plan_roles: {} };
  const rolesRetroOnly = {
    triage: { agent: ".claude/agents/factory-triage.md" },
    review: { correctness: { agent: ".claude/agents/reviewer-correctness.md" } },
    retro: { analyst: { agent: ".claude/agents/factory-retro.md" } },
  };
  const present = (p) => !p.endsWith("factory-retro.md");
  const warn = by(checkRoles({ charter, roles: rolesRetroOnly, root: "/r", exists: present }));
  expect(warn["roles.agent-files"].level).toBe("PASS");
  expect(warn["roles.retro-agent-file"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("Plan 4") });
  expect(warn["roles.retro-agent-file"].detail).toContain("factory-retro.md");

  // 두 사실은 서로 다른 줄이다 — review 역할 파일이 없으면 FAIL이 나오고, retro WARN은 그것에 가려지지 않는다
  const bothMissing = by(checkRoles({ charter, roles: rolesRetroOnly, root: "/r", exists: (p) => p.endsWith("factory-triage.md") }));
  expect(bothMissing["roles.agent-files"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("reviewer-correctness.md") });
  expect(bothMissing["roles.agent-files"].detail).not.toContain("factory-retro.md");
  expect(bothMissing["roles.retro-agent-file"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("factory-retro.md") });

  // retro 블록이 없거나 파일이 있으면 PASS다 — 줄 자체는 항상 나온다
  expect(by(checkRoles({ charter, roles: rolesRetroOnly, root: "/r", exists: () => true }))["roles.retro-agent-file"].level).toBe("PASS");
});

test("checkRoles: everything present → all PASS", () => {
  const charter = { roster: { docs: ["correctness"] }, plan_roles: { default: ["architect"] } };
  const roles = { review: { correctness: { agent: ".claude/agents/reviewer-correctness.md", lessons: ".factory/lessons/reviewer-correctness.md" } }, plan: { architect: { agent: ".claude/agents/plan-architect.md" } }, triage: { agent: ".claude/agents/factory-triage.md" } };
  const c = by(checkRoles({ charter, roles, root: "/r", exists: () => true }));
  expect(c["roles.roster-defined"].level).toBe("PASS");
  expect(c["roles.agent-files"].level).toBe("PASS");
  expect(c["roles.lessons-files"].level).toBe("PASS");
});

test("checkAgents: lints every installed roles.toml agent, skips the ones that are not there, and covers factory-loader", () => {
  const files = {
    "/r/.claude/agents/reviewer-correctness.md": agentText("reviewer-correctness"),
    // 설치된 사본에서 ## Lens가 지워진 상태 — 템플릿은 멀쩡해도 repo의 사본이 어긋날 수 있다(그게 doctor의 일이다)
    "/r/.claude/agents/plan-architect.md": agentText("plan-architect").replace(/## Lens\n[\s\S]*?(?=\n## )/, ""),
    "/r/.claude/agents/factory-loader.md": agentText("factory-loader"),
  };
  const roles = {
    triage: { agent: ".claude/agents/factory-triage.md" }, // 설치 안 됨 → roles.agent-files의 몫, 여기선 건너뛴다
    plan: { architect: { agent: ".claude/agents/plan-architect.md" } },
    review: { correctness: { agent: ".claude/agents/reviewer-correctness.md" } },
  };
  const c = by(checkAgents({ roles, root: "/r", exists: (p) => p in files, readFile: (p) => files[p] }));
  expect(c["agents.reviewer-correctness"].level).toBe("PASS");
  expect(c["agents.plan-architect"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("## Lens") });
  expect(c["agents.plan-architect"].detail).toContain("section");
  expect(c["agents.factory-triage"]).toBeUndefined();          // 부재는 중복 보고하지 않는다
  expect(c["agents.factory-loader"].level).toBe("PASS");       // roles.toml에 없지만 설치되는 파일이다
});

test("checkAgents: a name that does not match its filename FAILs", () => {
  const files = { "/r/.claude/agents/reviewer-security.md": agentText("reviewer-correctness") };
  const roles = { review: { security: { agent: ".claude/agents/reviewer-security.md" } } };
  const c = by(checkAgents({ roles, root: "/r", exists: (p) => p in files, readFile: (p) => files[p] }));
  expect(c["agents.reviewer-security"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("name") });
});

test("checkAgents: the shipped roles.toml + agent templates are what an initialized repo would show — all PASS", () => {
  const roles = toml(readFileSync(ROLES_TEMPLATE, "utf8"));
  const asInstalled = (p) => p.replace("/r/.claude/agents/", AGENT_TEMPLATES);
  const checks = checkAgents({
    roles, root: "/r",
    exists: (p) => existsSync(asInstalled(p)),
    readFile: (p) => readFileSync(asInstalled(p), "utf8"),
  });
  for (const ch of checks) expect(ch.level, `${ch.id}: ${ch.detail}`).toBe("PASS");
  // 14 roles.toml 역할(triage 1 + plan 5 + implement 2 + review 5 + retro 1) + loader. merge에는 역할이
  // 아예 없고(ADR-015 R3 — F5에서 [merge.integrator] 삭제), retro.analyst는 Plan 4가 파일을 채웠다.
  expect(checks.map((ch) => ch.id).sort()).toEqual([
    "agents.factory-builder", "agents.factory-loader", "agents.factory-retro", "agents.factory-triage", "agents.factory-verifier",
    "agents.plan-architect", "agents.plan-operator", "agents.plan-product-advocate", "agents.plan-skeptic",
    "agents.plan-synthesizer", "agents.reviewer-architecture", "agents.reviewer-correctness", "agents.reviewer-qa",
    "agents.reviewer-security", "agents.reviewer-spec-conformance",
  ]);
});

// ── checkSkills (Task 1) ─────────────────────────────────────────────────────────────────────
const SKILL_OK = (opsExtra = "") => `---
description: Do the thing.
allowed-tools: [Read, Write]
---

# Skill

## Language

**All conversation MUST be in: English**

## Trigger

When needed.

## Reads

The relevant files.

## Does

Summarize, then act.${opsExtra}

## Produces

A result.

## Must not

Do the wrong thing.
`;

const OPS_EXTRA = [
  "",
  '\n2. `node .factory/bin/transition.js <issue> <label> --human --reason "..."`.',
  "\n3. Merging is never done here — `gh pr merge` is forbidden.",
  "\n4. Record a `human-decision:v1` comment.",
].join("");

const READONLY_EXTRA = "\n2. Merging is never done here — `gh pr merge` is forbidden.";

test("checkSkills: .claude/commands/know-thy-build/ absent → skills.installed PASS with the install hint", () => {
  const c = by(checkSkills({ root: "/r", exists: () => false, readFile: () => "", list: () => [] }));
  expect(c["skills.installed"]).toMatchObject({ level: "PASS", detail: expect.stringContaining("npx know-thy-build") });
  expect(Object.keys(c)).toEqual(["skills.installed"]);
});

test("checkSkills: installed dir with one clean ops skill and one clean Define skill → both PASS, skills.missing WARN lists the other 11", () => {
  const files = { "harness.md": SKILL_OK(OPS_EXTRA), "project.md": SKILL_OK() };
  const c = by(checkSkills({
    root: "/r",
    exists: (p) => p === "/r/.claude/commands/know-thy-build",
    readFile: (p) => files[p.split("/").pop()],
    list: () => Object.keys(files),
  }));
  expect(c["skills.harness"]).toMatchObject({ level: "PASS" });
  expect(c["skills.project"]).toMatchObject({ level: "PASS" });
  expect(c["skills.missing"].level).toBe("WARN");
  for (const n of ALL_SKILLS.filter((n) => !["harness", "project"].includes(n))) {
    expect(c["skills.missing"].detail, n).toContain(n);
  }
});

test("checkSkills: a broken skill file (missing ## Trigger) → skills.<name> FAIL naming the violation", () => {
  const broken = SKILL_OK().replace("## Trigger\n\nWhen needed.\n\n", "");
  const files = { "harness.md": broken };
  const c = by(checkSkills({ root: "/r", exists: () => true, readFile: () => broken, list: () => Object.keys(files) }));
  expect(c["skills.harness"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("Trigger") });
});

test("checkSkills: all 13 catalog names present and clean → skills.missing PASS", () => {
  const files = {};
  for (const n of ALL_SKILLS) {
    files[`${n}.md`] = SKILL_OK(DEFINE_SKILLS.includes(n) ? "" : (n === "digest" || n === "status" ? READONLY_EXTRA : OPS_EXTRA));
  }
  const c = by(checkSkills({
    root: "/r",
    exists: () => true,
    readFile: (p) => files[p.split("/").pop()],
    list: () => Object.keys(files),
  }));
  for (const n of ALL_SKILLS) expect(c[`skills.${n}`], n).toMatchObject({ level: "PASS" });
  expect(c["skills.missing"]).toMatchObject({ level: "PASS" });
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
  // ciTemplate이 없으면 그 검사 자체를 만들지 않는다 — "확인 안 함"을 PASS로 기록하지 않는다.
  expect(c["settings.ci-deny"]).toBeUndefined();
});

// ADR-019: 경로 deny는 `.factory/ci-settings.json`에만 산다 — doctor가 그 파일까지 봐야 L2가 검증된다.
test("checkSettings: ci-settings.json missing or short of the template deny list → settings.ci-deny FAIL", () => {
  const template = { permissions: { deny: ["A"] }, hooks: {} };
  const ciTemplate = { permissions: { deny: ["Edit(.factory/**)", "Write(package.json)"] } };
  const settings = { permissions: { deny: ["A"] }, hooks: {} };

  const missing = by(checkSettings({ settings, template, ciSettings: null, ciTemplate }));
  expect(missing["settings.ci-deny"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("ci-settings.json missing") });

  const short = by(checkSettings({ settings, template, ciSettings: { permissions: { deny: ["Edit(.factory/**)"] } }, ciTemplate }));
  expect(short["settings.ci-deny"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("Write(package.json)") });

  const full = by(checkSettings({ settings, template, ciSettings: { permissions: { deny: [...ciTemplate.permissions.deny, "Read(.env)"] } }, ciTemplate }));
  expect(full["settings.ci-deny"].level).toBe("PASS");
});

// ADR-019 이월: `mergeSettings`가 가산적이라 옛 경로 deny는 `--upgrade`로도 안 지워졌었다.
// 이제 설치기가 지우고, doctor는 아직 남아 있는 저장소에 WARN으로 알린다.
test("checkSettings: leftover moved denies in .claude/settings.json → settings.stale-deny WARN naming the fix", () => {
  const template = { permissions: { deny: ["Bash(gh pr merge*)"] }, hooks: {} };
  const stale = { permissions: { deny: ["Bash(gh pr merge*)", "Edit(.factory/**)", "Write(package.json)"] }, hooks: {} };
  const c = by(checkSettings({ settings: stale, template }));
  expect(c["settings.stale-deny"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("Edit(.factory/**)") });
  expect(c["settings.stale-deny"].detail).toContain("factory init --upgrade");
  expect(c["settings.deny"].level).toBe("PASS");    // deny 자체는 여전히 충족된다 — 별개의 문제다

  const clean = { permissions: { deny: ["Bash(gh pr merge*)", "Read(.env)"] }, hooks: {} };
  expect(by(checkSettings({ settings: clean, template }))["settings.stale-deny"].level).toBe("PASS");
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
  // 보호 규칙에 factory/gates만 있고 L0가 요구하는 factory/integrity는 없다 → protection WARN
  const gh = { listSecrets: async () => ["FACTORY_BOT_TOKEN"], getVariable: async () => null, listLabels: async () => ["backlog"], getBranchProtection: async () => ({ required_status_checks: { contexts: ["factory/gates"] } }) };
  const c = by(await checkGitHub({ gh, harness: { project: { default_branch: "main" }, factory: { required_checks: ["factory/gates", "factory/review", "factory/integrity"] } }, labels: [{ name: "backlog" }, { name: "factory:queue" }] }));
  expect(c["github.claude-secret"].level).toBe("FAIL");
  expect(c["github.bot-token"].level).toBe("PASS");
  expect(c["github.token-issued-at"].level).toBe("WARN");
  expect(c["github.labels"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("factory:queue") });
  expect(c["github.protection"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("factory/integrity") });
});

test("checkGitHub: protection is judged against L0_CONTEXTS only — required_checks is reported as L1's job, never as a missing rule", async () => {
  // 부트스트랩이 실제로 넣는 것(=L0_CONTEXTS)만 들어 있는 보호 규칙. harness는 세 체크를 요구하지만
  // 그건 머지 스테이지(L1)가 보는 목록이므로 protection은 PASS여야 한다 — 아니면 고칠 수 없는 WARN이 영원히 남는다.
  const gh = {
    listSecrets: async () => ["CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_BOT_TOKEN"],
    getVariable: async () => "2026-01-01T00:00:00Z",
    listLabels: async () => ["backlog"],
    getBranchProtection: async () => ({ required_status_checks: { contexts: [...L0_CONTEXTS] } }),
  };
  const required = ["factory/gates", "factory/review", "factory/integrity"];
  const c = by(await checkGitHub({ gh, harness: { project: { default_branch: "main" }, factory: { required_checks: required } }, labels: [{ name: "backlog" }] }));
  expect(c["github.protection"]).toMatchObject({ level: "PASS", detail: expect.stringContaining("factory/integrity") });
  expect(c["github.required-checks"]).toMatchObject({ level: "PASS", detail: "enforced by L1 at merge: factory/gates, factory/review, factory/integrity" });
});

test("checkGitHub: no branch protection at all → protection WARN naming the L0 contexts bootstrap would set", async () => {
  const gh = { listSecrets: async () => [], getVariable: async () => null, listLabels: async () => [], getBranchProtection: async () => null };
  const c = by(await checkGitHub({ gh, harness: { project: { default_branch: "main" }, factory: { required_checks: [] } }, labels: [] }));
  expect(c["github.protection"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("factory/integrity") });
  // L1 목록이 비어 있어도 줄은 나온다 — "설정되지 않았다"를 빈 문자열로 말하면 아무도 못 읽는다
  expect(c["github.required-checks"]).toMatchObject({ level: "PASS", detail: "enforced by L1 at merge: (none configured)" });
});

// ── fix round 2 (GitHub Free plan branch-protection 403) ────────────────────

const GH_FREE_403 = "gh api -X failed (1): gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)";

test("checkGitHub: getBranchProtection throws the GitHub-Free 403 → github.protection is WARN (not FAIL), with the plan-specific detail, and every other github.* check still runs", async () => {
  const gh = {
    listSecrets: async () => ["CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_BOT_TOKEN"],
    getVariable: async () => "2026-01-01T00:00:00Z",
    listLabels: async () => ["backlog", "factory:queue"],
    getBranchProtection: async () => { throw new Error(GH_FREE_403); },
  };
  const c = by(await checkGitHub({ gh, harness: { project: { default_branch: "main" }, factory: { required_checks: ["factory/gates"] } }, labels: [{ name: "backlog" }, { name: "factory:queue" }] }));
  expect(c["github.protection"]).toMatchObject({
    level: "WARN",
    detail: "branch protection unavailable on this plan (private repo on GitHub Free) — L0 off; make the repo public or upgrade",
  });
  // it must NOT fall through to the blanket "gh unavailable" branch — the rest of the checks are still valid.
  expect(c["github.unavailable"]).toBeUndefined();
  expect(c["github.claude-secret"].level).toBe("PASS");
  expect(c["github.bot-token"].level).toBe("PASS");
  expect(c["github.labels"].level).toBe("PASS");
  expect(c["github.required-checks"].level).toBe("PASS");
});

test("checkGitHub: a getBranchProtection failure that is NOT the GitHub-Free wording still falls through to github.unavailable (unchanged)", async () => {
  const gh = {
    listSecrets: async () => ["CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_BOT_TOKEN"],
    getVariable: async () => "2026-01-01T00:00:00Z",
    listLabels: async () => ["backlog"],
    getBranchProtection: async () => { throw new Error("gh: not authenticated"); },
  };
  const c = by(await checkGitHub({ gh, harness: { project: { default_branch: "main" }, factory: { required_checks: [] } }, labels: [] }));
  expect(Object.keys(c)).toEqual(["github.unavailable"]);
  expect(c["github.unavailable"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("not authenticated") });
});

test("checkGitHub: no branch protection yet (404 → null, no throw) is unaffected by the 403 handling — still the existing missing-L0-contexts WARN", async () => {
  const gh = { listSecrets: async () => [], getVariable: async () => null, listLabels: async () => [], getBranchProtection: async () => null };
  const c = by(await checkGitHub({ gh, harness: { project: { default_branch: "main" }, factory: { required_checks: [] } }, labels: [] }));
  expect(c["github.protection"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("factory/integrity") });
  expect(c["github.protection"].detail).not.toContain("GitHub Free");
});

test("checkGitHub: gh unavailable → single WARN, no other github.* checks", async () => {
  const gh = { listSecrets: async () => { throw new Error("not authenticated"); } };
  const c = by(await checkGitHub({ gh, harness: { project: { default_branch: "main" }, factory: { required_checks: [] } }, labels: [] }));
  expect(Object.keys(c)).toEqual(["github.unavailable"]);
  expect(c["github.unavailable"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("not authenticated") });
});

test("checkGitHub: all green → PASS across the board", async () => {
  const gh = { listSecrets: async () => ["CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_BOT_TOKEN"], getVariable: async () => "2026-01-01T00:00:00Z", listLabels: async () => ["backlog", "factory:queue"], getBranchProtection: async () => ({ required_status_checks: { contexts: [...L0_CONTEXTS, "factory/gates"] } }) };
  const c = by(await checkGitHub({ gh, harness: { project: { default_branch: "main" }, factory: { required_checks: ["factory/gates", "factory/review"] } }, labels: [{ name: "backlog" }, { name: "factory:queue" }] }));
  expect(c["github.claude-secret"].level).toBe("PASS");
  expect(c["github.bot-token"].level).toBe("PASS");
  expect(c["github.token-issued-at"].level).toBe("PASS");
  expect(c["github.labels"].level).toBe("PASS");
  expect(c["github.protection"].level).toBe("PASS");
});
