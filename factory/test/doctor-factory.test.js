import { test, expect } from "vitest";
import { checkFiles, checkFilesTracked, checkCharter, checkRoles, checkAgents, checkSkills, checkSettings, checkHooks, checkWorkflows, checkGitHub, checkProtectedParity, checkRecordsProtection } from "../lib/doctor/factory.js";
import { protBlock, ciDenyEntries, writeGlobs } from "../lib/protected-paths.js";
import { ALL_SKILLS, DEFINE_SKILLS } from "../lib/skill-md.js";
import { makeFakeRun, run } from "../lib/exec.js";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as toml } from "smol-toml";
import { L0_CONTEXTS, MERGE_ENVIRONMENT } from "../lib/bootstrap.js";
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

// KTB-12: `factory init`이 디스크에 쓴 파일이 `.gitignore`에 가려 untracked면 CI 체크아웃엔 그 파일이
// 없다 — KTB 자신의 `.claude/commands/factory-*.md` 디스패처가 이렇게 조용히 사라졌다.
test("checkFilesTracked: an installed file matched by .gitignore FAILs naming it with the un-ignore hint", async () => {
  const manifest = [{ src: "/p/a.md", dest: ".claude/commands/factory-plan.md", owner: "factory" }, { src: "/p/b.js", dest: ".factory/lib/b.js", owner: "factory" }];
  const files = new Set(["/r/.claude/commands/factory-plan.md", "/r/.factory/lib/b.js"]);
  const fakeRun = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "check-ignore", result: (cmd, args, opts) => ({ code: 0, stdout: opts.input.includes("factory-plan.md") ? ".claude/commands/factory-plan.md\n" : "", stderr: "" }) },
  ]);
  const c = by(await checkFilesTracked({ manifest, root: "/r", exists: (p) => files.has(p), run: fakeRun }));
  expect(c["files.tracked"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining(".claude/commands/factory-plan.md") });
  expect(c["files.tracked"].detail).toContain("un-ignore in .gitignore");
  expect(c["files.tracked"].detail).not.toContain(".factory/lib/b.js");
});

test("checkFilesTracked: nothing ignored → PASS; missing-on-disk and gitignored-by-design entries are never even asked about", async () => {
  const manifest = [
    { src: "/p/a.md", dest: ".claude/commands/factory-plan.md", owner: "factory" },
    { src: "/p/c.js", dest: ".factory/lib/missing.js", owner: "factory" },
    { src: "/p/d.js", dest: ".factory/out/built.js", owner: "factory" },
  ];
  const files = new Set(["/r/.claude/commands/factory-plan.md", "/r/.factory/out/built.js"]);
  const fakeRun = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "check-ignore", result: (cmd, args, opts) => {
        expect(opts.input).toContain("factory-plan.md");
        expect(opts.input).not.toContain("missing.js");
        expect(opts.input).not.toContain("built.js");
        return { code: 1, stdout: "", stderr: "" };
      } },
  ]);
  const c = by(await checkFilesTracked({ manifest, root: "/r", exists: (p) => files.has(p), run: fakeRun }));
  expect(c["files.tracked"].level).toBe("PASS");
});

test("checkFilesTracked: not a git repo (or git unavailable) → PASS-info, never FAIL", async () => {
  const manifest = [{ src: "/p/a.md", dest: ".claude/commands/factory-plan.md", owner: "factory" }];
  const files = new Set(["/r/.claude/commands/factory-plan.md"]);
  const notARepo = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "check-ignore", result: { code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git" } }]);
  expect(by(await checkFilesTracked({ manifest, root: "/r", exists: (p) => files.has(p), run: notARepo }))["files.tracked"]).toMatchObject({ level: "PASS", detail: "not a git repo" });

  const gitMissing = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "check-ignore", result: { code: 127, stdout: "", stderr: "spawn git ENOENT" } }]);
  expect(by(await checkFilesTracked({ manifest, root: "/r", exists: (p) => files.has(p), run: gitMissing }))["files.tracked"]).toMatchObject({ level: "PASS", detail: "not a git repo" });
});

test("checkFilesTracked: no installed files on disk at all → PASS without calling git", async () => {
  const fakeRun = makeFakeRun([{ match: () => true, result: () => { throw new Error("should not be called"); } }]);
  const c = by(await checkFilesTracked({ manifest: [{ src: "/p/a.md", dest: ".claude/commands/factory-plan.md", owner: "factory" }], root: "/r", exists: () => false, run: fakeRun }));
  expect(c["files.tracked"].level).toBe("PASS");
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

test("checkAgents: lints every installed roles.toml agent and skips the ones that are not there", () => {
  const files = {
    "/r/.claude/agents/reviewer-correctness.md": agentText("reviewer-correctness"),
    // 설치된 사본에서 ## Lens가 지워진 상태 — 템플릿은 멀쩡해도 repo의 사본이 어긋날 수 있다(그게 doctor의 일이다)
    "/r/.claude/agents/plan-architect.md": agentText("plan-architect").replace(/## Lens\n[\s\S]*?(?=\n## )/, ""),
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
  expect(c["agents.factory-loader"]).toBeUndefined();          // 감사 M5 — 로더는 없어졌다
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
  // 14 roles.toml 역할(triage 1 + plan 5 + implement 2 + review 5 + retro 1). 감사 M5로 loader는 사라졌다. merge에는 역할이
  // 아예 없고(ADR-015 R3 — F5에서 [merge.integrator] 삭제), retro.analyst는 Plan 4가 파일을 채웠다.
  expect(checks.map((ch) => ch.id).sort()).toEqual([
    "agents.factory-builder", "agents.factory-retro", "agents.factory-triage", "agents.factory-verifier",
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
  // KTB-13 r1: deny도 allow와 같은 고치는 법을 말한다 — 두 FAIL이 나란히 뜰 때 한쪽만 안내하면 안 된다.
  expect(c["settings.deny"].detail).toContain("factory init --upgrade");
  expect(c["settings.hooks"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("s.sh") });
  expect(by(checkSettings({ settings: null, template }))["settings.present"].level).toBe("FAIL");
});

// KTB-13: allow는 "편의 목록"이 아니라 **도구 부여 목록**이다 — `--permission-mode dontAsk`는 allow에
// 걸리지 않는 도구 호출을 묻지 않고 **거절**한다. 그래서 deny와 똑같이 "템플릿 항목이 빠지면 FAIL"이다.
test("checkSettings: allow list short of the template → settings.allow FAIL naming the missing entries (KTB-13)", () => {
  const template = { permissions: { deny: ["A"], allow: ["Read", "Edit", "Write", "Bash(*)"] }, hooks: {} };

  const short = by(checkSettings({ settings: { permissions: { deny: ["A"], allow: ["Read", "Bash(*)"] }, hooks: {} }, template }));
  expect(short["settings.allow"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("Edit") });
  expect(short["settings.allow"].detail).toContain("Write");
  expect(short["settings.deny"].level).toBe("PASS");   // deny는 별개의 문제다

  // 사람이 자기 항목을 더해 둔 상위집합은 PASS다(브라운필드, KTB-11과 같은 원칙).
  const superset = { permissions: { deny: ["A"], allow: [...template.permissions.allow, "Bash(docker *)"] }, hooks: {} };
  expect(by(checkSettings({ settings: superset, template }))["settings.allow"].level).toBe("PASS");

  // allow가 통째로 없으면(옛 설치) 전부 빠진 것이다 — 조용한 PASS가 아니라 FAIL.
  const none = by(checkSettings({ settings: { permissions: { deny: ["A"] }, hooks: {} }, template }));
  expect(none["settings.allow"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("Read") });
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

// KTB-20: `factory:harness` 이슈의 implement가 `--settings`로 싣는 변형 파일. 없으면 그 이슈는
// needs-human에서 멈춘다(run-stage가 조용히 좁은 쪽으로 fallback하지 않는다) — 그래서 FAIL이다.
test("checkSettings: ci-settings-harness.json missing or short of its template → settings.ci-harness FAIL (KTB-20)", () => {
  const template = { permissions: { deny: ["A"] }, hooks: {} };
  const settings = { permissions: { deny: ["A"] }, hooks: {} };
  const ciHarnessTemplate = { permissions: { deny: ["Edit(.factory/lib/**)", "Write(package.json)"] } };

  // 템플릿을 주지 않으면 검사 자체를 만들지 않는다 — "확인 안 함"은 PASS가 아니다(ci-deny와 같은 규칙).
  expect(by(checkSettings({ settings, template }))["settings.ci-harness"]).toBeUndefined();

  const missing = by(checkSettings({ settings, template, ciHarness: null, ciHarnessTemplate }));
  expect(missing["settings.ci-harness"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("ci-settings-harness.json missing") });
  expect(missing["settings.ci-harness"].detail).toContain("factory:harness");

  const short = by(checkSettings({ settings, template, ciHarness: { permissions: { deny: ["Edit(.factory/lib/**)"] } }, ciHarnessTemplate }));
  expect(short["settings.ci-harness"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("Write(package.json)") });

  const full = by(checkSettings({ settings, template, ciHarness: { permissions: { deny: [...ciHarnessTemplate.permissions.deny] } }, ciHarnessTemplate }));
  expect(full["settings.ci-harness"].level).toBe("PASS");
});

/**
 * KTB-36 — `settings.ci-deny`는 **템플릿의 상위집합**만 본다. 통짜 `.factory/**` 하나를 열거 스물몇
 * 줄로 바꾸면 옛 설치본은 그 줄들을 하나도 갖고 있지 않으므로 FAIL이어야 하고(그것이 "`--upgrade`를
 * 돌려라"의 신호다), 새 열거를 그대로 담은 설치본은 PASS여야 한다. 옛 통짜 줄이 **남아 있어도**
 * PASS다 — 그 줄이 있으면 qa 카브아웃이 죽지만 그 판정은 doctor가 아니라 아래 install 테스트가
 * 고정하는 `--upgrade`의 통째 교체가 책임진다(이 파일은 팩토리 소유다).
 */
test("checkSettings: the enumerated .factory deny set is what ci-deny now requires (KTB-36)", () => {
  const template = { permissions: { deny: ["A"] }, hooks: {} };
  const settings = { permissions: { deny: ["A"] }, hooks: {} };
  const enumerated = ["Edit(.factory/bin/**)", "Edit(.factory/out/*)", "Edit(.factory/harness.toml)"];
  const ciTemplate = { permissions: { deny: enumerated } };

  // 옛 설치본: 통짜 한 줄만 들고 있다 → 열거가 전부 빠졌다고 말해야 한다.
  const old = by(checkSettings({ settings, template, ciSettings: { permissions: { deny: ["Edit(.factory/**)"] } }, ciTemplate }));
  expect(old["settings.ci-deny"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("Edit(.factory/out/*)") });

  const upgraded = by(checkSettings({ settings, template, ciSettings: { permissions: { deny: enumerated } }, ciTemplate }));
  expect(upgraded["settings.ci-deny"].level).toBe("PASS");
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

// ADR-021 r1 MF-2 d — 린트의 넓이가 **목록의 길이**였던 문제. 팩토리의 일곱 이름만 돌던 시절에는
// 다른 이름의 워크플로가 머지 토큰을 통째로 실어도 규칙이 쳐다보지 않았다.
test("checkWorkflows (r1 MF-2 d): every .yml in .github/workflows is linted, not just the seven factory names", () => {
  const files = { "factory-triage.yml": "on: push\n", "ci.yml": "on: pull_request\nenv:\n  T: ${{ secrets.FACTORY_MERGE_TOKEN }}\n" };
  const c = by(checkWorkflows({
    root: "/r",
    exists: () => true,
    readFile: (p) => files[p.split("/").pop()] ?? "on: push\n",
    list: () => ["factory-triage.yml", "ci.yml", "notes.md"],
  }));
  expect(c["workflows.present"].level).toBe("PASS");
  expect(c["workflows.lint"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("ci.yml") });
  expect(c["workflows.lint"].detail).toContain("merge-token-scope");
});

// KTB-34 own-calendar (2026-09-14) — MF-2 d widened *which files* merge-token-scope can see, but the fix
// didn't split scope, so factory-shaped rules (artifact-retention, no-expression-in-run, …) rode along
// onto the adopter's own `build.yml` (an app build that uploads artifacts, no `retention-days` needed by
// the factory's own rules). checkWorkflows must now judge those rules only on factory-*.yml files.
test("checkWorkflows (KTB-34): an adopter's own build.yml is not held to factory-shaped rules — only merge-token-scope reaches it", () => {
  const files = {
    "factory-triage.yml": "on: push\n",
    "build.yml": [
      "on:",
      "  push:",
      "jobs:",
      "  build:",
      "    steps:",
      "      - run: echo ${{ github.event.head_commit.message }}",   // would trip no-expression-in-run if scoped as factory
      "      - uses: actions/upload-artifact@v4",
      "        with:",
      "          name: dist",
      "          path: dist/",                                        // no retention-days — would trip artifact-retention if scoped as factory
      "",
    ].join("\n"),
  };
  const c = by(checkWorkflows({
    root: "/r",
    exists: () => true,
    readFile: (p) => files[p.split("/").pop()] ?? "on: push\n",
    list: () => ["factory-triage.yml", "build.yml"],
  }));
  expect(c["workflows.lint"].level).toBe("PASS");
});

test("checkWorkflows (KTB-34): merge-token-scope still reaches build.yml — the merge token must not leak into ANY agent step", () => {
  const files = {
    "factory-triage.yml": "on: push\n",
    "build.yml": [
      "jobs:",
      "  build:",
      "    steps:",
      "      - name: Agent",
      "        env:",
      "          FACTORY_MERGE_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN }}",
      "          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
      "        run: claude -p go",
      "",
    ].join("\n"),
  };
  const c = by(checkWorkflows({
    root: "/r",
    exists: () => true,
    readFile: (p) => files[p.split("/").pop()] ?? "on: push\n",
    list: () => ["factory-triage.yml", "build.yml"],
  }));
  expect(c["workflows.lint"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("build.yml") });
  expect(c["workflows.lint"].detail).toContain("merge-token-scope");
});

test("checkWorkflows (r1): an unreadable workflows directory falls back to the seven known names — the missing-file FAIL already says it", () => {
  const c = by(checkWorkflows({
    root: "/r", exists: () => true, readFile: () => "on: push\n",
    list: () => { throw new Error("ENOENT"); },
  }));
  expect(c["workflows.present"].level).toBe("PASS");
  expect(c["workflows.lint"].level).toBe("PASS");
});

test("checkGitHub: secrets, token date, labels, protection", async () => {
  // 보호 규칙에 factory/gates만 있고 L0가 요구하는 factory/integrity는 없다 → protection WARN
  const gh = { listSecrets: async () => ["FACTORY_BOT_TOKEN"], listEnvSecrets: async () => [], getVariable: async () => null, listLabels: async () => ["backlog"], getBranchProtection: async () => ({ required_status_checks: { contexts: ["factory/gates"] } }) };
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
    listEnvSecrets: async () => [],
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
  const gh = { listSecrets: async () => [], listEnvSecrets: async () => [], getVariable: async () => null, listLabels: async () => [], getBranchProtection: async () => null };
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
    listEnvSecrets: async () => [],
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
  const gh = { listSecrets: async () => [], listEnvSecrets: async () => [], getVariable: async () => null, listLabels: async () => [], getBranchProtection: async () => null };
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
  const gh = { listSecrets: async () => ["CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_BOT_TOKEN"], listEnvSecrets: async () => [], getVariable: async () => "2026-01-01T00:00:00Z", listLabels: async () => ["backlog", "factory:queue"], getBranchProtection: async () => ({ required_status_checks: { contexts: [...L0_CONTEXTS, "factory/gates"] } }) };
  const c = by(await checkGitHub({ gh, harness: { project: { default_branch: "main" }, factory: { required_checks: ["factory/gates", "factory/review"] } }, labels: [{ name: "backlog" }, { name: "factory:queue" }] }));
  expect(c["github.claude-secret"].level).toBe("PASS");
  expect(c["github.bot-token"].level).toBe("PASS");
  expect(c["github.token-issued-at"].level).toBe("PASS");
  expect(c["github.labels"].level).toBe("PASS");
  expect(c["github.protection"].level).toBe("PASS");
});

// ── ADR-021 two-actor merge authority ───────────────────────────────────────

const ghFor = ({ secrets, envSecrets = [], protection, login = "factory-bot", permission = "write", scopes = ["repo"] }) => ({
  viewerScopes: async () => scopes,
  listSecrets: async () => secrets,
  listEnvSecrets: async () => envSecrets,
  getVariable: async () => "2026-01-01",
  listLabels: async () => ["backlog"],
  getBranchProtection: async () => protection,
  viewerLogin: async () => login,
  collaboratorPermission: async () => permission,
});
const HARNESS_MAIN = { project: { default_branch: "main" }, factory: { required_checks: [] } };
const L0_ONLY = { required_status_checks: { contexts: [...L0_CONTEXTS] } };
// ADR-021 r1 MF-1 — 승인 요건은 수 + **신원**이다. `require_code_owner_reviews`가 없는 모양은 이제
// "두 배우 모드인데 아무나 승인해도 되는 상태"라 FAIL이다(아래 전용 테스트).
const withReview = { required_status_checks: { contexts: [...L0_CONTEXTS] }, required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_code_owner_reviews: true } };
const withCountOnly = { required_status_checks: { contexts: [...L0_CONTEXTS] }, required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true } };
const CODEOWNERS_OK = "* @owner-human\n";
/** CODEOWNERS는 디스크의 파일이다 — checkGitHub는 root/exists/readFile을 통해서만 그것을 본다. */
async function authority(gh, env = {}, codeowners = CODEOWNERS_OK) {
  return by(await checkGitHub({
    gh, harness: HARNESS_MAIN, labels: [{ name: "backlog" }], env,
    root: "/repo", exists: (p) => codeowners !== null && p === "/repo/.github/CODEOWNERS", readFile: () => codeowners,
  }));
}

test("checkGitHub (ADR-021): no FACTORY_MERGE_TOKEN → tokens.single-actor WARN naming what is left standing", async () => {
  const c = await authority(ghFor({ secrets: ["FACTORY_BOT_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"], protection: L0_ONLY }));
  expect(c["tokens.single-actor"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("merge power is reachable from agent stages; hooks are the only layer") });
  expect(c["tokens.single-actor"].detail).toContain("FACTORY_MERGE_TOKEN");
  expect(c["tokens.two-actor"]).toBeUndefined();
  // 단일 배우 모드에서 승인 요건이 없는 것은 설계대로다 — 없으면 다크 머지가 불가능하다.
  expect(c["protection.two-actor"]).toMatchObject({ level: "PASS", detail: expect.stringContaining("single-actor") });
});

test("checkGitHub (ADR-021): FACTORY_MERGE_TOKEN + review requirement → tokens.two-actor PASS and protection.two-actor PASS", async () => {
  const c = await authority(ghFor({ secrets: ["FACTORY_BOT_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_MERGE_TOKEN"], protection: withReview }));
  expect(c["tokens.two-actor"].level).toBe("PASS");
  expect(c["tokens.single-actor"]).toBeUndefined();
  expect(c["protection.two-actor"]).toMatchObject({ level: "PASS", detail: expect.stringContaining("dismiss_stale_reviews=true") });
  expect(c["protection.two-actor"].detail).toContain("code-owner approving review required");
});

test("checkGitHub (ADR-021 r1 MF-1): one approval but NO require_code_owner_reviews → protection.two-actor FAIL — counting approvals only asks for \"not the author\"", async () => {
  const c = await authority(ghFor({ secrets: ["FACTORY_BOT_TOKEN", "FACTORY_MERGE_TOKEN"], protection: withCountOnly }));
  expect(c["protection.two-actor"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("require_code_owner_reviews") });
  expect(c["protection.two-actor"].detail).toMatch(/any PR it did not author/);
});

test("checkGitHub (ADR-021): merge token set but the base branch requires no review → protection.two-actor FAIL (two-actor mode in name only)", async () => {
  const c = await authority(ghFor({ secrets: ["FACTORY_BOT_TOKEN", "FACTORY_MERGE_TOKEN"], protection: L0_ONLY }));
  expect(c["protection.two-actor"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("factory bootstrap") });
  expect(c["protection.two-actor"].detail).toMatch(/can still merge its own PR/);
});

test("checkGitHub (ADR-021): review required but no merge token → WARN, because nobody can approve the agent's own PR", async () => {
  const c = await authority(ghFor({ secrets: ["FACTORY_BOT_TOKEN"], protection: withReview }));
  expect(c["protection.two-actor"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("dark merge is impossible") });
});

test("checkGitHub (ADR-021): no protection / plan without protection → protection.two-actor WARN, never a false PASS", async () => {
  const none = await authority(ghFor({ secrets: ["FACTORY_BOT_TOKEN", "FACTORY_MERGE_TOKEN"], protection: null }));
  expect(none["protection.two-actor"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("run factory bootstrap") });

  const free = await authority({ ...ghFor({ secrets: ["FACTORY_BOT_TOKEN"], protection: null }), getBranchProtection: async () => { throw new Error(GH_FREE_403); } });
  expect(free["protection.two-actor"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("hooks are the only layer") });
});

test("checkGitHub (ADR-021): locally (no CI token) the agent-permission check is skipped with a note, and gh is never asked", async () => {
  const gh = ghFor({ secrets: ["FACTORY_BOT_TOKEN", "FACTORY_MERGE_TOKEN"], protection: withReview });
  let asked = false;
  gh.viewerLogin = async () => { asked = true; return "someone"; };
  const c = await authority(gh, {});                       // CI 아님
  // ADR-021 r1 finding 2 — 건너뛴 판정은 **PASS가 아니라 WARN**이다. 한 번도 평가된 적 없는 불변식이
  // 매 로컬 실행에서 초록이면, 그것을 부르는 CI 잡이 아예 없다는 사실이 아무에게도 보이지 않는다
  // (4fa2c7f가 정확히 그 상태였다: `tokens.agent-is-admin`에 호출자가 없었다).
  expect(c["tokens.agent-is-admin"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("unverified until CI") });
  expect(c["tokens.agent-workflow-scope"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("unverified until CI") });
  expect(asked).toBe(false);                               // 사람의 로컬 gh는 사람 자신이다 — 물으면 늘 admin이라 늘 오보다
});

test("checkGitHub (ADR-021): in CI, an admin agent actor is a FAIL in two-actor mode and a WARN in single-actor mode", async () => {
  const env = { CI: "true", GH_TOKEN: "x" };
  const two = await authority(ghFor({ secrets: ["FACTORY_BOT_TOKEN", "FACTORY_MERGE_TOKEN"], protection: withReview, permission: "admin" }), env);
  expect(two["tokens.agent-is-admin"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("plain write collaborator") });
  expect(two["tokens.agent-is-admin"].detail).toContain("factory-bot");
  expect(two["tokens.agent-is-admin"].detail).not.toContain("x");   // 토큰 값은 어디에도 찍히지 않는다

  const maintain = await authority(ghFor({ secrets: ["FACTORY_BOT_TOKEN", "FACTORY_MERGE_TOKEN"], protection: withReview, permission: "maintain" }), env);
  expect(maintain["tokens.agent-is-admin"].level).toBe("FAIL");

  const single = await authority(ghFor({ secrets: ["FACTORY_BOT_TOKEN"], protection: L0_ONLY, permission: "admin" }), env);
  expect(single["tokens.agent-is-admin"].level).toBe("WARN");
});

test("checkGitHub (ADR-021): in CI, a plain write agent actor passes; an unreadable permission is WARN, not a silent PASS", async () => {
  const env = { CI: "true", FACTORY_BOT_TOKEN: "x" };
  const ok = await authority(ghFor({ secrets: ["FACTORY_BOT_TOKEN", "FACTORY_MERGE_TOKEN"], protection: withReview, permission: "write" }), env);
  expect(ok["tokens.agent-is-admin"]).toMatchObject({ level: "PASS", detail: "factory-bot: write" });

  const gh = ghFor({ secrets: ["FACTORY_BOT_TOKEN", "FACTORY_MERGE_TOKEN"], protection: withReview });
  gh.collaboratorPermission = async () => { throw new Error("gh api failed (1): Not Found"); };
  const unknown = await authority(gh, env);
  expect(unknown["tokens.agent-is-admin"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("Not Found") });
});

// ── ADR-021 fix round r2 (KTB-33 finding MF-A) — the factory-merge environment secret ───────

test("checkGitHub (r2): FACTORY_MERGE_TOKEN present ONLY in the factory-merge environment still yields tokens.two-actor PASS, end to end", async () => {
  const c = await authority(ghFor({ secrets: ["FACTORY_BOT_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"], envSecrets: ["FACTORY_MERGE_TOKEN"], protection: withReview }));
  expect(c["tokens.two-actor"].level).toBe("PASS");
  expect(c["tokens.single-actor"]).toBeUndefined();
  expect(c["tokens.merge-token-repo-level"]).toBeUndefined(); // not a repo secret — nothing to warn about
});

test("checkGitHub (r2): FACTORY_MERGE_TOKEN left over as a repo secret (also in the environment) → tokens.merge-token-repo-level WARN", async () => {
  const c = await authority(ghFor({ secrets: ["FACTORY_BOT_TOKEN", "FACTORY_MERGE_TOKEN"], envSecrets: ["FACTORY_MERGE_TOKEN"], protection: withReview }));
  expect(c["tokens.two-actor"].level).toBe("PASS");
  expect(c["tokens.merge-token-repo-level"]).toMatchObject({ level: "WARN", detail: expect.stringContaining(MERGE_ENVIRONMENT) });
});

// ── 2026-09-14 외부 감사 M8 / ADR-023: protected.parity ────────────────────────────────────────
// 보호 목록 세 곳(harness `[protected].factory` · ci-settings의 경로 deny · 훅의 `prot`)이 한 출처에서
// 나왔는가. 감사 시점에는 셋이 손으로 유지됐고 실제로 갈라져 있었다 — 드리프트는 "Edit는 막히는데
// `echo > x`는 통과한다"를 만들므로 WARN이 아니라 FAIL이다.
const parityProt = { factory: [".factory/**", ".claude/**", "docs/factory/CHARTER.md"], except: [".factory/out/qa/**"], agent_writable: [] };
function parityFiles(over = {}) {
  const hook = ["#!/usr/bin/env bash", protBlock(parityProt), "exit 0"].join("\n");
  const ci = (harnessMode) => JSON.stringify({ permissions: { deny: ["Bash(gh secret*)", ...ciDenyEntries(writeGlobs(parityProt, { harnessMode, enumerateFactory: true }))] } });
  return {
    "/r/.claude/hooks/block-dangerous.sh": hook,
    "/r/.factory/ci-settings.json": ci(false),
    "/r/.factory/ci-settings-harness.json": ci(true),
    ...over,
  };
}
const parityRun = (files, prot = parityProt) =>
  checkProtectedParity({ root: "/r", exists: (p) => p in files, readFile: (p) => files[p], harness: { protected: prot } })[0];

test("protected.parity: generated hook + ci-settings that match harness [protected] → PASS", () => {
  expect(parityRun(parityFiles())).toMatchObject({ id: "protected.parity", level: "PASS" });
});

test("protected.parity: a hand-edited `prot` in the hook is FAIL (M8's actual drift: .github/workflows/factory- vs .github/**)", () => {
  const f = parityFiles();
  f["/r/.claude/hooks/block-dangerous.sh"] = f["/r/.claude/hooks/block-dangerous.sh"].replace("\\.claude/", "\\.github/workflows/factory-");
  expect(parityRun(f)).toMatchObject({ level: "FAIL" });
  expect(parityRun(f).detail).toMatch(/prot` list differs/);
});

test("protected.parity: a hook with no generated block at all is FAIL (that IS the hand-maintained list)", () => {
  expect(parityRun(parityFiles({ "/r/.claude/hooks/block-dangerous.sh": "#!/usr/bin/env bash\nprot='(\\.factory/)'\nexit 0\n" })).detail).toMatch(/no `factory:protected` generated block/);
});

test("protected.parity: adding a glob to harness without re-running --upgrade is FAIL on both ci-settings files", () => {
  const prot = { ...parityProt, factory: [...parityProt.factory, "Makefile"] };
  const r = parityRun(parityFiles(), prot);
  expect(r.level).toBe("FAIL");
  expect(r.detail).toMatch(/ci-settings\.json deny missing: Edit\(Makefile\), Write\(Makefile\)/);
  expect(r.detail).toMatch(/ci-settings-harness\.json deny missing/);
});

test("protected.parity: a deny entry that no harness glob derives is FAIL too (drift is symmetric)", () => {
  const f = parityFiles();
  const j = JSON.parse(f["/r/.factory/ci-settings.json"]);
  j.permissions.deny.push("Edit(src/**)");
  f["/r/.factory/ci-settings.json"] = JSON.stringify(j);
  expect(parityRun(f).detail).toMatch(/not derived from harness\.toml \[protected\]: Edit\(src\/\*\*\)/);
});

test("protected.parity: unreadable or missing inputs are FAIL, never PASS (an unchecked list is not a safe list)", () => {
  expect(parityRun({}).level).toBe("FAIL");
  expect(parityRun(parityFiles(), { factory: [] }).detail).toMatch(/missing or empty/);
  expect(parityRun(parityFiles({ "/r/.factory/ci-settings.json": "{oops" })).detail).toMatch(/unreadable/);
});

test("protected.parity: agent_writable leaves the merge boundary alone but drops out of the write boundary", () => {
  const prot = { ...parityProt, factory: [...parityProt.factory, "factory/**"], agent_writable: ["factory/**"] };
  const files = {
    "/r/.claude/hooks/block-dangerous.sh": protBlock(prot),
    "/r/.factory/ci-settings.json": JSON.stringify({ permissions: { deny: ciDenyEntries(writeGlobs(prot, { enumerateFactory: true })) } }),
    "/r/.factory/ci-settings-harness.json": JSON.stringify({ permissions: { deny: ciDenyEntries(writeGlobs(prot, { harnessMode: true, enumerateFactory: true })) } }),
  };
  expect(parityRun(files, prot).level).toBe("PASS");
  expect(files["/r/.factory/ci-settings.json"]).not.toContain("Edit(factory/**)");
});

// ── 리뷰 batch-1 MF-2 — `protection.records` ─────────────────────────────────────────────────────
// 머지 스테이지가 리뷰 handoff를 대조하는 상대는 `factory/records`의 run 기록이다. 그 브랜치가
// force push/삭제로 다시 쓰일 수 있으면 대조는 아무것도 증명하지 않는다 — 그 사실은 매 실행에서
// 소리 내어 말한다(못 거는 플랜이 정당하게 존재하므로 FAIL이 아니라 WARN이다).
test("protection.records: an unprotected records branch is a WARN that names what is holding the line", async () => {
  const none = await checkRecordsProtection({ gh: { getBranchProtection: async () => null } });
  expect(none[0].id).toBe("protection.records");
  expect(none[0].level).toBe("WARN");
  expect(none[0].detail).toContain("records branch unprotected — evidence relies on hooks");

  const forceAllowed = await checkRecordsProtection({ gh: { getBranchProtection: async () => ({ allow_force_pushes: { enabled: true }, allow_deletions: { enabled: false } }) } });
  expect(forceAllowed[0].level).toBe("WARN");
  expect(forceAllowed[0].detail).toContain("force pushes");

  // 못 읽는 것도 PASS가 아니다.
  const unreadable = await checkRecordsProtection({ gh: { getBranchProtection: async () => { throw new Error("HTTP 403"); } } });
  expect(unreadable[0].level).toBe("WARN");
  expect(unreadable[0].detail).toContain("HTTP 403");

  const ok = await checkRecordsProtection({ gh: { getBranchProtection: async () => ({ allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } }) } });
  expect(ok[0].level).toBe("PASS");
  expect(ok[0].detail).toContain("append-only");
  // 단일 자격증명 잔여 위험은 PASS 줄에서도 말한다 — 초록이 "분리됐다"를 뜻하지 않는다.
  expect(ok[0].detail).toContain("single-credential");
});
