import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { lintSkillMd } from "../lib/skill-md.js";

// Plan 5 / Task 5 (§13.3) — the last 3 catalog skills: :role (Operate, full — transition.js +
// human-decision:v1 required), :digest and :status (Operate, read-only — exempt from
// transition.js/human-decision but still must ban `gh pr merge`). These tests read the real
// templates under templates/know-thy-build/, mirroring skills-ops-a.test.js/skills-ops-b.test.js's
// approach for Tasks 3/4.

const NAMES = ["role", "digest", "status"];
const TEMPLATES_KTB = new URL("../../templates/know-thy-build/", import.meta.url);

function readTemplate(name) {
  return readFileSync(new URL(`${name}.md`, TEMPLATES_KTB), "utf8");
}

// ── lint: all 3 pass, template mode and installed mode ───────────────────────────────────────

for (const name of NAMES) {
  test(`lintSkillMd: templates/know-thy-build/${name}.md passes in template mode (installed:false)`, () => {
    expect(lintSkillMd(readTemplate(name), { name, installed: false })).toEqual([]);
  });

  test(`lintSkillMd: templates/know-thy-build/${name}.md passes in installed mode (installed:true, {{LANG}} substituted)`, () => {
    const installed = readTemplate(name).replaceAll("{{LANG}}", "English");
    expect(lintSkillMd(installed, { name, installed: true })).toEqual([]);
  });
}

// ── forbidden strings (case-insensitive), whole-file ─────────────────────────────────────────
// worktree / finish / sub-agent(subagent) / transition.sh / --bug — none of these 3 skills
// dispatch worktrees or sub-agents, none "finish" a branch, :role calls the real CLI
// (transition.js, never the stale transition.sh name), and the --bug path moved to :issue.

const FORBIDDEN = ["worktree", "finish", "sub-agent", "subagent", "transition.sh", "--bug"];

for (const name of NAMES) {
  for (const term of FORBIDDEN) {
    test(`forbidden string: templates/know-thy-build/${name}.md does not contain "${term}" (case-insensitive)`, () => {
      expect(readTemplate(name).toLowerCase()).not.toContain(term);
    });
  }
}

// ── only {{LANG}} may appear as a `{{` placeholder ───────────────────────────────────────────

for (const name of NAMES) {
  test(`templates/know-thy-build/${name}.md: every {{ placeholder is {{LANG}}`, () => {
    const text = readTemplate(name);
    const placeholders = text.match(/\{\{[^}]*\}\}/g) || [];
    expect(placeholders.every((p) => p === "{{LANG}}")).toBe(true);
  });
}

// ── "gh pr merge" may appear ONLY on a line that also carries a negation word ────────────────

function ghPrMergeLinesWithoutNegation(text) {
  const negation = /(never|must not|forbidden|prohibited|do not|don't|no\b|금지)/i;
  return text.split("\n").filter((line) => /gh pr merge/i.test(line) && !negation.test(line));
}

for (const name of NAMES) {
  test(`templates/know-thy-build/${name}.md: every "gh pr merge" mention is on a line with a negation word`, () => {
    expect(ghPrMergeLinesWithoutNegation(readTemplate(name))).toEqual([]);
  });

  test(`templates/know-thy-build/${name}.md: the "gh pr merge" prohibition line actually exists`, () => {
    expect(readTemplate(name)).toMatch(/gh pr merge/i);
  });
}

// ── required strings per file (task-5-brief.md) ──────────────────────────────────────────────

const REQUIRED = {
  role: [
    ".claude/agents/",
    "lintAgentMd",
    "roles.toml",
    "spawn_on",
    "claude -p --agent",
    "factory/role-",
    "factory:retro-proposal",
    "human-decision:v1",
    "transition.js",
    "좋은 발견",
    "나쁜 발견",
    "Perspectives",
  ],
  digest: [
    "docs/factory/digests/",
    "gh pr list --state merged",
    "factory-handoff:v1 stage=plan",
    "open_risks",
    "dissent_log",
    "_retro.md",
    "PROJECT.md",
    "/know-thy-build:issue",
  ],
  status: [
    "npx know-thy-build factory status",
    "/know-thy-build:unstick",
    "/know-thy-build:clarify",
    "/know-thy-build:proposal",
    "/know-thy-build:harness",
    "/know-thy-build:next",
  ],
};

for (const [name, terms] of Object.entries(REQUIRED)) {
  for (const term of terms) {
    test(`required string: templates/know-thy-build/${name}.md contains "${term}"`, () => {
      expect(readTemplate(name)).toContain(term);
    });
  }
}

// ── :role must mention human-decision:v1 (explicit per task-5-brief.md, beyond the ops-rule
// check that lintSkillMd already does via the common paragraph) ─────────────────────────────

test("templates/know-thy-build/role.md: mentions human-decision:v1", () => {
  expect(readTemplate("role")).toContain("human-decision:v1");
});

// ── the common enforcement paragraph (verbatim from next.md line 38) must appear byte-identical
// in role.md. digest.md/status.md are read-only and carry a SHORTER paragraph instead — they
// must NOT be held to the full common paragraph (task-5-brief.md: they're exempt from
// transition.js/human-decision, so their paragraph is intentionally different). ────────────────

const NEXT_TEMPLATE = readFileSync(new URL("next.md", TEMPLATES_KTB), "utf8");
const COMMON_ENFORCEMENT = NEXT_TEMPLATE.split("\n").find((l) => l.startsWith("라벨은 손으로 옮기지 않는다"));

test("sanity: the common enforcement paragraph was actually extracted from next.md", () => {
  expect(COMMON_ENFORCEMENT).toBeTruthy();
  expect(COMMON_ENFORCEMENT).toContain("human-decision:v1 issue=<n> skill=<name>");
});

test("templates/know-thy-build/role.md: contains the common enforcement paragraph byte-identical to next.md's", () => {
  expect(readTemplate("role")).toContain(COMMON_ENFORCEMENT);
});

test("templates/know-thy-build/digest.md: does NOT carry the full common enforcement paragraph (read-only skill, exempt from transition.js/human-decision)", () => {
  expect(readTemplate("digest")).not.toContain(COMMON_ENFORCEMENT);
});

test("templates/know-thy-build/status.md: does NOT carry the full common enforcement paragraph (read-only skill, exempt from transition.js/human-decision)", () => {
  expect(readTemplate("status")).not.toContain(COMMON_ENFORCEMENT);
});

// ── read-only skills state they never change labels/issues/PRs/files other than (digest)
// docs/factory/digests/YYYY-Wnn.md ────────────────────────────────────────────────────────────

test("templates/know-thy-build/digest.md: states it changes nothing but its own digest file", () => {
  const text = readTemplate("digest");
  expect(text).toMatch(/이슈나 PR을 만들거나 편집하지 않으며/);
  expect(text).toContain("docs/factory/digests/YYYY-Wnn.md");
});

test("templates/know-thy-build/status.md: states it changes nothing (fully read-only, no output file)", () => {
  const text = readTemplate("status");
  expect(text).toMatch(/라벨을 전이하지 않고, 이슈나 PR을 만들거나 편집하지 않으며/);
});

// ── §13.3 5-section summary block appears immediately after ## Language ─────────────────────

for (const name of NAMES) {
  test(`templates/know-thy-build/${name}.md: §13.3 summary sections appear immediately after ## Language`, () => {
    const text = readTemplate(name);
    const languageIdx = text.indexOf("## Language");
    const triggerIdx = text.indexOf("## Trigger");
    const readsIdx = text.indexOf("## Reads");
    const doesIdx = text.indexOf("## Does");
    const producesIdx = text.indexOf("## Produces");
    const mustNotIdx = text.indexOf("## Must not");
    expect(languageIdx).toBeGreaterThanOrEqual(0);
    expect(triggerIdx).toBeGreaterThan(languageIdx);
    expect(readsIdx).toBeGreaterThan(triggerIdx);
    expect(doesIdx).toBeGreaterThan(readsIdx);
    expect(producesIdx).toBeGreaterThan(doesIdx);
    expect(mustNotIdx).toBeGreaterThan(producesIdx);
  });
}

// ── `#### <n><letter>.` sub-headings must number-match their enclosing `### Step <n>` ───────
// Same regression guard as skills-phase1.test.js's/skills-ops-a.test.js's/skills-ops-b.test.js's
// helper, reused here for the 3 new files (none of the 3 actually use this sub-heading pattern,
// so this is a vacuous pass today — it stays as a guard against future drift).

function stepSubheadingMismatches(text) {
  const mismatches = [];
  let currentStep = null;
  for (const line of text.split("\n")) {
    const step = /^###\s+Step\s+(\d+)\b/.exec(line);
    if (step) { currentStep = Number(step[1]); continue; }
    const sub = /^####\s+(\d+)[a-z]\.\s/.exec(line);
    if (sub) {
      const subStep = Number(sub[1]);
      if (currentStep === null || subStep !== currentStep) {
        mismatches.push({ line, subStep, currentStep });
      }
    }
  }
  return mismatches;
}

for (const name of NAMES) {
  test(`templates/know-thy-build/${name}.md: every #### <n><letter>. sub-heading matches its enclosing ### Step <n>`, () => {
    expect(stepSubheadingMismatches(readTemplate(name))).toEqual([]);
  });
}

// ── :role-specific: the structure-validation one-liner must call lintAgentMd with expectedName,
// and must reference the two example agent files it copies frontmatter shape from. ─────────────

test("templates/know-thy-build/role.md: gives the exact lintAgentMd structure-validation one-liner", () => {
  const text = readTemplate("role");
  expect(text).toContain("m.lintAgentMd(require(\"fs\").readFileSync(\".claude/agents/<name>.md\",\"utf8\"),{expectedName:\"<name>\"})");
});

test("templates/know-thy-build/role.md: shows a reviewer roles.toml block ([review.<name>]) and a plan debater block ([plan.<name>])", () => {
  const text = readTemplate("role");
  expect(text).toContain("[review.<name>]");
  expect(text).toContain("[plan.<name>]");
});

test("templates/know-thy-build/role.md: the trial run tells the user the token cost BEFORE running and asks for confirmation", () => {
  const text = readTemplate("role");
  const idx = text.indexOf("Step 5");
  expect(idx).toBeGreaterThanOrEqual(0);
  const window = text.slice(idx, idx + 1500);
  expect(window).toMatch(/진행할까요|확인/);
  expect(window).toContain("gh pr list --state merged --limit 5");
});

test("templates/know-thy-build/role.md: Must not covers both silently editing an existing Lens and registering without a trial run", () => {
  const text = readTemplate("role");
  const mustNotIdx = text.indexOf("## Must not");
  const nextHeadingIdx = text.indexOf("\n## ", mustNotIdx + 1);
  const section = text.slice(mustNotIdx, nextHeadingIdx === -1 ? undefined : nextHeadingIdx);
  expect(section).toContain("조용히 수정");
  expect(section).toContain("시험 실행 없이 등록");
});

// ── :digest-specific: the plan handoff explanation explicitly says there is NO `approach`
// field (P5 task-5-brief.md correction) — a wrong assumption here would misdirect the reader
// straight into a KeyError against the real schema (factory/lib/schemas.js "plan.v1"). ────────

test("templates/know-thy-build/digest.md: explicitly says the plan handoff JSON has no approach field", () => {
  const text = readTemplate("digest");
  expect(text).toMatch(/approach.*없다|없다.*approach/);
});

test("templates/know-thy-build/digest.md: describes the review-round dispute trail (fixed|disputed + uphold|withdraw) as the R2 반박 source", () => {
  const text = readTemplate("digest");
  expect(text).toContain("disputed");
  expect(text).toMatch(/uphold/);
});

// ── :status-specific: every Needs-You kind maps to its own next command, and the CLI's
// section order/wording is not reinvented by this skill (P5-R3 — CLI is the single source). ───

test("templates/know-thy-build/status.md: maps every needsYou kind (needs-human/needs-info/retro-proposal/harness) to its own slash command", () => {
  const text = readTemplate("status");
  expect(text).toMatch(/needs-human[\s\S]{0,40}\/know-thy-build:unstick/);
  expect(text).toMatch(/needs-info[\s\S]{0,40}\/know-thy-build:clarify/);
  expect(text).toMatch(/retro-proposal[\s\S]{0,40}\/know-thy-build:proposal/);
  expect(text).toMatch(/harness[\s\S]{0,40}\/know-thy-build:harness/);
});

test("templates/know-thy-build/status.md: never re-implements the status computation — defers to the CLI as the single source", () => {
  const text = readTemplate("status");
  expect(text).toMatch(/다시 구현하지 않는다|다시 만들지 않는다/);
});
