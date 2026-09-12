import { test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { lintSkillMd } from "../lib/skill-md.js";
import { checkSkills } from "../lib/doctor/factory.js";

// Plan 5 최종 브랜치 리뷰의 수정 사항 — 스킬 본문이 "설치는 되지만 실행하면 틀리는" 지점들.
// 전부 실제 templates/know-thy-build/*.md를 읽는다(픽스처 아님).

const TEMPLATES_KTB = new URL("../../templates/know-thy-build/", import.meta.url);
const readTemplate = (name) => readFileSync(new URL(`${name}.md`, TEMPLATES_KTB), "utf8");
const ALL_TEMPLATES = readdirSync(TEMPLATES_KTB.pathname).filter((f) => f.endsWith(".md"));

// ── C2: 운영 스킬 8개는 factory가 없으면 아무것도 하기 전에 멈춘다 ─────────────────────────────
// 스킬이 설치되는 경로(`npx know-thy-build`)와 factory가 설치되는 경로(`factory init`)는 별개라,
// 스킬만 깔린 저장소에서 `:next`를 부르면 `node .factory/bin/transition.js`가 ENOENT로 죽는다 —
// 그 실패는 사람에게 "무엇을 해야 하는지"를 말해주지 않는다.

const OPS_SKILLS = ["harness", "next", "clarify", "unstick", "proposal", "role", "digest", "status"];

for (const name of OPS_SKILLS) {
  test(`init guard: templates/know-thy-build/${name}.md checks for .factory/bin/run-stage.js and names \`factory init\``, () => {
    const text = readTemplate(name);
    expect(text, name).toContain("run-stage.js");
    expect(text, name).toContain("factory init");
  });
}

// ── I2: :role의 이름 규약 — 파일에는 접두어가 붙고 TOML 키/CHARTER에는 안 붙는다 ──────────────

test("role.md: never writes an agent file without the reviewer-/plan- prefix", () => {
  const text = readTemplate("role");
  expect(text).not.toContain(".claude/agents/<name>.md");
  expect(text).not.toContain(".claude/agents/<role>.md");
  // 남아 있는 에이전트 경로 플레이스홀더는 전부 접두어가 붙은 형태여야 한다.
  for (const m of text.matchAll(/\.claude\/agents\/<[^>]+>\.md/g)) {
    expect(m[0], m[0]).toMatch(/\.claude\/agents\/(reviewer|plan)-<short>\.md/);
  }
});

test("role.md: defines <short> once and derives file/TOML/CHARTER names from it", () => {
  const text = readTemplate("role");
  expect(text).toContain("`<short>`");
  expect(text).toContain(".claude/agents/reviewer-<short>.md");
  expect(text).toContain(".claude/agents/plan-<short>.md");
  expect(text).toContain("[review.<short>]");
  expect(text).toContain("[plan.<short>]");
  expect(text).toContain('expectedName:"reviewer-<short>"');
  // CHARTER 목록에는 접두어 없는 <short>만 들어간다
  expect(text).toMatch(/\+\s+standard: \[.*, <short>\]/);
  expect(text).toMatch(/\+\s+default: \[.*, <short>\]/);
});

// ── I3: `claude -p --agent`는 경로가 아니라 이름을 받는다 ──────────────────────────────────────

for (const f of ALL_TEMPLATES) {
  test(`templates/know-thy-build/${f}: never passes a .md path to \`claude -p --agent\``, () => {
    const text = readFileSync(new URL(f, TEMPLATES_KTB), "utf8");
    expect(text, f).not.toMatch(/--agent\s+\S*\.md/);
  });
}

test("proposal.md: role-new/role-change dry runs check out the PR (the role exists only there) and return", () => {
  const text = readTemplate("proposal");
  expect(text).toContain("gh pr checkout");
  expect(text).toContain("git status --porcelain");
  expect(text).toContain("git switch -");
});

// ── I4: GNU `date -d`는 macOS에 없다 — 사람의 로컬 세션이 실행하는 명령이므로 치명적이다 ────────

for (const f of ALL_TEMPLATES) {
  test(`templates/know-thy-build/${f}: no GNU-only \`date -d\``, () => {
    const text = readFileSync(new URL(f, TEMPLATES_KTB), "utf8");
    expect(text, f).not.toContain("date -d");
    expect(text, f).not.toContain("date -u -d");
  });
}

test("digest.md: computes the 7-day window and the ISO week with node, matching isoWeek()", () => {
  const text = readTemplate("digest");
  expect(text).toContain("7*864e5");
  expect(text).toContain("toISOString().slice(0,10)");
  expect(text).toContain("getUTCDay()+6)%7)+3");   // 목요일 규칙 (proposals.js isoWeek와 동일)
});

// ── I5: 팩토리는 이슈 본문만 읽는다(context.js) — 보정은 본문에 들어가야 도달한다 ──────────────

test("issue.md: the test_NNN_ correction edits the issue BODY, not only a comment", () => {
  const text = readTemplate("issue");
  expect(text).toContain("gh issue edit");
  expect(text).toContain("test_NNN_");
  expect(text).toMatch(/gh issue edit [^\n]*--body-file/);
});

// ── I6: README 파이프라인 — 검증은 factory의 역할이 한다 ────────────────────────────────────

test("README: the per-feature pipeline no longer routes through manual :qa review/test steps", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  expect(readme).not.toContain(":qa review");
  expect(readme).not.toContain("complete ONLY when");
  expect(readme).not.toMatch(/know-thy-build:qa\s+Test the running product/);
  // Define/Operate 표는 그대로 있다
  expect(readme).toContain("/know-thy-build:status");
  expect(readme).toContain("/know-thy-build:project");
});

// ── I8: `--help`와 설치 후 배너가 같은 수를 말한다 ────────────────────────────────────────────

test("bin/cli.js: --help lists Define 5 + Operate 8 + 2 design helpers = 15 files, like the post-install banner", () => {
  const cli = readFileSync(new URL("../../bin/cli.js", import.meta.url), "utf8");
  const counts = [...cli.matchAll(/13 skills[^\n]*15 files/g)];
  expect(counts.length).toBe(2);   // 배너와 --help 둘 다
  expect([...cli.matchAll(/Define \(5\):/g)].length).toBe(2);
  expect([...cli.matchAll(/Operate \(8 — require/g)].length).toBe(2);
  expect([...cli.matchAll(/Design helpers \(invoked from :feature\):/g)].length).toBe(2);
  // 설치되는 파일 수와 실제 템플릿 수가 같다
  expect(ALL_TEMPLATES.length).toBe(15);
});

// ── minors ──────────────────────────────────────────────────────────────────────────────────

test("status.md: an empty `## 큐` is not an empty backlog — it points at :next", () => {
  const text = readTemplate("status");
  expect(text).toContain("QUEUE_STATES");
  expect(text).toContain("/know-thy-build:next");
  expect(text).not.toContain("backlog에 착수할 이슈가 없습니다");
});

test("technical.md: K/M/R and plan_rounds start at the CHARTER defaults and change only via :proposal", () => {
  const text = readTemplate("technical");
  expect(text).toContain("limits: { K, M, R }");
  expect(text).toContain("plan_rounds");
  expect(text).toMatch(/know-thy-build:proposal|`:proposal`/);
});

// ── linter/doctor 소소한 것 ─────────────────────────────────────────────────────────────────

test("lintSkillMd: an installed skill that still has {{LANG}} is a violation (installer missed the substitution)", () => {
  const template = readTemplate("status");
  const violations = lintSkillMd(template, { name: "status", installed: true });
  expect(violations.some((v) => v.rule === "language" && /\{\{LANG\}\}/.test(v.msg))).toBe(true);
  // 치환하면 깨끗하다
  expect(lintSkillMd(template.replaceAll("{{LANG}}", "English"), { name: "status", installed: true })).toEqual([]);
});

test("checkSkills: the skills.missing WARN tells the person how to fix it", () => {
  const c = checkSkills({ root: "/r", exists: () => true, readFile: () => "", list: () => [] });
  const missing = c.find((x) => x.id === "skills.missing");
  expect(missing.level).toBe("WARN");
  expect(missing.detail).toContain("run `npx know-thy-build` to (re)install");
});
