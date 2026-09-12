import { test, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as toml } from "smol-toml";
import { parseFrontmatter } from "../lib/frontmatter.js";

const T = new URL("../../templates/factory/", import.meta.url).pathname;
const read = (p) => readFileSync(join(T, p), "utf8");

test("harness.toml template parses and is an M0 fast-only harness", () => {
  const h = toml(read("factory/harness.toml"));
  expect(h.schema).toBe(1);
  expect(h.project.name).toBe("{{PROJECT_NAME}}");
  expect(h.project.default_branch).toBe("main");
  expect(h.harness.maturity).toBe("M0");
  expect(h.factory.orchestration).toBe("workflow");
  expect(h.factory.required_checks).toEqual(["factory/gates", "factory/review", "factory/integrity"]);
  for (const g of h.gates.required) expect(h.gates.fast).toContain(g);
  for (const c of ["lint", "unit", "test_files", "test_one", "lint_file"]) expect(typeof h.commands[c]).toBe("string");
  expect(h.commands.test_files).toContain("{files}");
  expect(h.commands.test_one).toContain("{file}"); expect(h.commands.test_one).toContain("{name}");
  expect(h.commands.lint_file).toContain("{file}");
  expect(h.protected.factory).toContain(".factory/**");
  expect(h.test.test_glob.length).toBeGreaterThan(0);
});

test("harness.toml template protects the build-config files the gate commands resolve through (F9)", () => {
  const h = toml(read("factory/harness.toml"));
  for (const g of ["package.json", "package-lock.json", "vitest.config.*", "playwright.config.*", "tsconfig*.json", ".eslintrc*", "eslint.config.*"]) {
    expect(h.protected.factory, g).toContain(g);
  }
  // 기존 보호 대상은 그대로다
  for (const g of [".factory/**", ".claude/**", ".github/workflows/factory-*.yml", "docs/factory/CHARTER.md"]) {
    expect(h.protected.factory, g).toContain(g);
  }
  expect(h.protected.except).toContain(".factory/lessons/**");
});

test("roles.toml template defines every role the CHARTER template names", () => {
  const roles = toml(read("factory/roles.toml"));
  const { data: charter } = parseFrontmatter(read("docs/factory/CHARTER.md"));
  for (const names of Object.values(charter.roster)) for (const n of names) expect(roles.review[n], `review.${n}`).toBeDefined();
  for (const names of Object.values(charter.plan_roles)) for (const n of names) expect(roles.plan[n], `plan.${n}`).toBeDefined();
  expect(roles.triage.agent).toBe(".claude/agents/factory-triage.md");
  expect(roles.implement.builder.agent).toBe(".claude/agents/factory-builder.md");
  for (const [stage, block] of Object.entries(roles)) {
    if (stage === "schema") continue;
    const entries = block.agent ? { _: block } : block;
    for (const [n, def] of Object.entries(entries)) {
      expect(def.agent, `${stage}.${n}`).toMatch(/^\.claude\/agents\/[\w-]+\.md$/);
      if (def.lessons) expect(existsSync(join(T, "factory/lessons", def.lessons.replace(".factory/lessons/", ""))), def.lessons).toBe(true);
    }
  }
});

test("CHARTER template is a draft with the §5.3 frontmatter", () => {
  const { data } = parseFrontmatter(read("docs/factory/CHARTER.md"));
  expect(data.schema).toBe("factory.charter.v1");
  expect(data.status).toBe("draft");
  expect(data.limits).toEqual({ K: 3, M: 3, R: 2 });
  expect(data.retro.every_merges).toEqual({ initial: 1, min: 1, max: 20 });
});

test("lessons skeletons carry the integrity header", () => {
  const files = readdirSync(join(T, "factory/lessons"));
  expect(files.length).toBe(14);
  for (const f of files) {
    const role = f.replace(/\.md$/, "");
    expect(read(`factory/lessons/${f}`)).toMatch(new RegExp(`<!--\\s*factory-lessons:v1\\s+role=${role}\\s+max=\\d+\\s*-->`));
  }
});

test("settings.json template has the §6.3 deny list, all four hook events, and record-agents on Subagent*", () => {
  const s = JSON.parse(read("claude/settings.json"));
  for (const d of ["Bash(gh pr merge*)", "Bash(git push --force*)", "Edit(.factory/**)", "Write(.claude/**)", "Edit(docs/factory/CHARTER.md)"]) expect(s.permissions.deny).toContain(d);
  const cmds = (ev) => s.hooks[ev].flatMap((e) => e.hooks.map((h) => h.command));
  expect(cmds("PreToolUse")).toContain(".claude/hooks/block-dangerous.sh");
  expect(cmds("PostToolUse")).toContain(".claude/hooks/lint-touched.sh");
  expect(cmds("Stop")).toContain(".claude/hooks/stop-guard.sh");
  expect(cmds("SubagentStart")).toContain(".claude/hooks/record-agents.sh");
  expect(cmds("SubagentStop")).toEqual(expect.arrayContaining([".claude/hooks/record-agents.sh", ".claude/hooks/verdict-format.sh"]));
  const hooksDir = new URL("../hooks/", import.meta.url).pathname;
  for (const ev of Object.keys(s.hooks)) for (const c of cmds(ev)) expect(existsSync(join(hooksDir, c.replace(".claude/hooks/", ""))), c).toBe(true);
});

test("settings.json allows the gh surface the builder needs, including `gh pr edit` for --body-file bodies", () => {
  const s = JSON.parse(read("claude/settings.json"));
  for (const a of ["Bash(gh pr view*)", "Bash(gh pr comment*)", "Bash(gh pr create*)", "Bash(gh pr edit*)"]) {
    expect(s.permissions.allow, a).toContain(a);
  }
  // 머지는 여전히 builder의 일이 아니다 — allow가 넓어져도 deny가 이긴다.
  expect(s.permissions.deny).toContain("Bash(gh pr merge*)");
});

test("settings.json deny covers the build-config files, matching [protected].factory (F9)", () => {
  const s = JSON.parse(read("claude/settings.json"));
  const h = toml(read("factory/harness.toml"));
  for (const g of ["package.json", "package-lock.json", "vitest.config.*", "playwright.config.*", "tsconfig*.json", ".eslintrc*", "eslint.config.*"]) {
    expect(s.permissions.deny, `Edit(${g})`).toContain(`Edit(${g})`);
    expect(s.permissions.deny, `Write(${g})`).toContain(`Write(${g})`);
    expect(h.protected.factory, g).toContain(g);   // 두 목록이 갈라지면 L2가 막는 것과 L1 integrity가 보는 것이 달라진다
  }
});

test("dispatcher commands exist for the four LLM stages only and name their workflow", () => {
  for (const s of ["triage", "plan", "implement", "review"]) {
    const t = read(`claude/commands/factory-${s}.md`);
    expect(t).toMatch(new RegExp(`allowed-tools: Workflow\\(factory-${s}\\)`));
    expect(t).toContain("`factory-" + s + "`");
    expect(t).toContain(".factory/out/context.json");
  }
  expect(existsSync(join(T, "claude/commands/factory-merge.md"))).toBe(false);
});

// ── Task 6: the Claude-side templates the four stages actually load ──────────────────────────
// ADR-015 / P3-R7: there is no merge workflow (merge is a script) and retro is Plan 4.
const WORKFLOW_STAGES = ["triage", "plan", "implement", "review"];

test("the four stage workflows exist, each meta.name is its own basename, and there is no factory-merge.js", () => {
  const dir = join(T, "claude/workflows");
  expect(readdirSync(dir).sort()).toEqual(WORKFLOW_STAGES.map((s) => `factory-${s}.js`).sort());
  for (const s of WORKFLOW_STAGES) {
    const src = read(`claude/workflows/factory-${s}.js`);
    // `agentType`/`Workflow(factory-<s>)` 배선이 파일명을 그대로 쓴다 — meta.name이 어긋나면 디스패처가 못 찾는다.
    const m = /^\s*name:\s*['"]([^'"]+)['"]/m.exec(src);
    expect(m && m[1], `factory-${s}.js meta.name`).toBe(`factory-${s}`);
    expect(src.startsWith("export const meta = {"), `factory-${s}.js first line`).toBe(true);
  }
  expect(existsSync(join(dir, "factory-merge.js"))).toBe(false);
});

test("every roles.toml agent path Plan 3 owns resolves to a real agent template", () => {
  const roles = toml(read("factory/roles.toml"));
  const agentPath = (p) => join(T, "claude", p.replace(".claude/", ""));
  // triage/plan/implement/review의 모든 역할 파일은 실재해야 한다 — roles.toml의 경로가 곧 설치 대상이다.
  const entries = [["triage", roles.triage]];
  for (const stage of ["plan", "implement", "review"]) {
    for (const [name, def] of Object.entries(roles[stage])) entries.push([`${stage}.${name}`, def]);
  }
  for (const [id, def] of entries) expect(existsSync(agentPath(def.agent)), `${id} → ${def.agent}`).toBe(true);
  // loader는 roles.toml에 없다(로스터 역할이 아니라 workflow의 첫 스텝이다) — 그래도 설치는 된다.
  expect(existsSync(agentPath(".claude/agents/factory-loader.md"))).toBe(true);
  // merge.integrator / retro.analyst는 의도적으로 없다(ADR-015 R3, retro는 Plan 4).
  for (const def of [roles.merge.integrator, roles.retro.analyst]) expect(existsSync(agentPath(def.agent)), def.agent).toBe(false);
});

test("ci-settings, package.json, quarantine templates parse", () => {
  expect(JSON.parse(read("factory/ci-settings.json")).permissions.deny.length).toBeGreaterThan(0);
  const p = JSON.parse(read("factory/package.json"));
  expect(p.type).toBe("module"); expect(p.private).toBe(true); expect(p.dependencies["smol-toml"]).toMatch(/^\d+\.\d+\.\d+$/);
  expect(toml(read("factory/quarantine.toml"))).toEqual({ quarantined: [] });
});
