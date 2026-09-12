import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { lintSkillMd } from "../lib/skill-md.js";

// Task 6 (§13.3 structure, applied to the two non-catalog helpers) — `architect` and `designer`
// are not in ALL_SKILLS (they are Phase 1 design helpers invoked from `:feature`, not one of the
// 13 human-decision-point skills), but `checkSkills` (factory/lib/doctor/factory.js) lints EVERY
// `.md` under `.claude/commands/know-thy-build/`, so they still need the §13.3 six-section block
// right after `## Language`. This mirrors skills-phase1.test.js's approach for the Task 2 revisions,
// reading the real templates rather than synthetic fixtures.

const NAMES = ["architect", "designer"];
const TEMPLATES_KTB = new URL("../../templates/know-thy-build/", import.meta.url);

function readTemplate(name) {
  return readFileSync(new URL(`${name}.md`, TEMPLATES_KTB), "utf8");
}

// ── lint: both pass, template mode and installed mode ────────────────────────────────────────

for (const name of NAMES) {
  test(`lintSkillMd: templates/know-thy-build/${name}.md passes in template mode (installed:false)`, () => {
    expect(lintSkillMd(readTemplate(name), { name, installed: false })).toEqual([]);
  });

  test(`lintSkillMd: templates/know-thy-build/${name}.md passes in installed mode (installed:true, {{LANG}} substituted)`, () => {
    const installed = readTemplate(name).replaceAll("{{LANG}}", "English");
    expect(lintSkillMd(installed, { name, installed: true })).toEqual([]);
  });
}

// ── §13.3 6-section block (P5-R1): Language, then Trigger/Reads/Does/Produces/Must not, in
// order, before the pre-existing Socratic/operational body. Unlike the Task 2/3 revisions,
// architect.md and designer.md keep their bodies UNTOUCHED (brief item 4) — those bodies still
// say "worktree"/"sub-agent"/"finish" throughout (the old Phase-1 worktree+dispatch+finish flow),
// so this file does NOT run a whole-file FORBIDDEN scan like skills-phase1.test.js/skills-ops-*
// do. Instead it scopes the forbidden-string rule to exactly the new block this task adds — the
// ADR-018 ruling that the forbidden-string rule wins over verbatim §13.3 quoting when the banned
// word is the deleted section's own name.

function newBlockText(text) {
  const start = text.indexOf("## Trigger");
  const afterLanguage = text.indexOf("## ", text.indexOf("## Language") + 1);
  expect(start).toBe(afterLanguage);
  const end = text.indexOf("\n## ", text.indexOf("## Must not") + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

const FORBIDDEN = ["worktree", "finish", "sub-agent", "subagent", "check-merge-gate", "transition.sh", "--bug"];

for (const name of NAMES) {
  for (const term of FORBIDDEN) {
    test(`forbidden string: templates/know-thy-build/${name}.md's new §13.3 block does not contain "${term}" (case-insensitive)`, () => {
      expect(newBlockText(readTemplate(name)).toLowerCase()).not.toContain(term);
    });
  }
}

// ── content requirements from the brief: Must not says no label changes, has a `gh pr merge`
// prohibition on one line with a negation word (the same shape ops skills are lint-required to
// carry, even though architect/designer are non-catalog helpers and lintSkillMd does not enforce
// it for them), and says the skill never marks an issue done. ──────────────────────────────────

function mustNotSection(text) {
  const { sections } = (function parse() {
    // reuse the same ## split the linter uses, via lintSkillMd's sibling parseSkillMd would need
    // an import; simplest here is a local split since we only need one section's text.
    const idx = text.indexOf("## Must not");
    const rest = text.slice(idx);
    const end = rest.indexOf("\n## ", 1);
    return { sections: rest.slice(0, end === -1 ? undefined : end) };
  })();
  return sections;
}

for (const name of NAMES) {
  test(`templates/know-thy-build/${name}.md: ## Must not forbids label changes, gh pr merge, and marking the issue done`, () => {
    const must = mustNotSection(readTemplate(name));
    expect(must.toLowerCase()).toContain("label");
    expect(must.toLowerCase()).toContain("done");
    const ghLine = must.split("\n").find((l) => /gh pr merge/i.test(l));
    expect(ghLine).toBeTruthy();
    expect(/(never|must not|forbidden|prohibited|do not|don't|no\b)/i.test(ghLine)).toBe(true);
  });
}

// ── Produces matches the brief: architect → code stubs + signature tests in the spec;
// designer → `## Design` in the feature spec. ────────────────────────────────────────────────

test("templates/know-thy-build/architect.md: ## Produces mentions stubs and signature tests", () => {
  const text = readTemplate("architect");
  const idx = text.indexOf("## Produces");
  const section = text.slice(idx, text.indexOf("\n## ", idx + 1));
  expect(section.toLowerCase()).toContain("stub");
  expect(section.toLowerCase()).toContain("signature");
});

test("templates/know-thy-build/designer.md: ## Produces mentions `## Design` in the feature spec", () => {
  const text = readTemplate("designer");
  const idx = text.indexOf("## Produces");
  const section = text.slice(idx, text.indexOf("\n## ", idx + 1));
  expect(section).toContain("## Design");
});
