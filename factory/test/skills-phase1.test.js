import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { lintSkillMd } from "../lib/skill-md.js";

// Task 2 (§10, P5-R7) — revises the 4 Phase 1 templates: project, technical, qa, feature.
// These tests read the real templates under templates/know-thy-build/, not synthetic fixtures —
// skills.test.js (Task 1) already covers lintSkillMd/parseSkillMd/the installer against fixtures.

const NAMES = ["project", "technical", "qa", "feature"];
const TEMPLATES_KTB = new URL("../../templates/know-thy-build/", import.meta.url);

function readTemplate(name) {
  return readFileSync(new URL(`${name}.md`, TEMPLATES_KTB), "utf8");
}

// ── lint: all 4 pass, template mode and installed mode ──────────────────────────────────────

for (const name of NAMES) {
  test(`lintSkillMd: templates/know-thy-build/${name}.md passes in template mode (installed:false)`, () => {
    expect(lintSkillMd(readTemplate(name), { name, installed: false })).toEqual([]);
  });

  test(`lintSkillMd: templates/know-thy-build/${name}.md passes in installed mode (installed:true, {{LANG}} substituted)`, () => {
    const installed = readTemplate(name).replaceAll("{{LANG}}", "English");
    expect(lintSkillMd(installed, { name, installed: true })).toEqual([]);
  });
}

// ── forbidden strings (case-insensitive), whole-file, across all 4 templates ────────────────
// worktree / check-merge-gate / finish / sub-agent(subagent) — the old Phase-1 worktree+
// sub-agent-dispatch+finish flow is gone (§10); nothing in these 4 files should still say so,
// including generic prose uses of "finish"/"sub-agent" as ordinary English words.

const FORBIDDEN = ["worktree", "check-merge-gate", "finish", "sub-agent", "subagent"];

for (const name of NAMES) {
  for (const term of FORBIDDEN) {
    test(`forbidden string: templates/know-thy-build/${name}.md does not contain "${term}" (case-insensitive)`, () => {
      expect(readTemplate(name).toLowerCase()).not.toContain(term);
    });
  }
}

// ── forbidden string, scoped: feature.md's spec frontmatter template block must not carry a
// `gate:` field. This is scoped (not whole-file) — feature.md's prose is allowed to explain
// *that* there's no more gate: field, using the substring "gate:" while doing so. ────────────

function frontmatterBlocks(text) {
  // Every fenced ```yaml ... ``` block that opens a `docs/features/{{NNN}}.md` frontmatter
  // (both the CREATE `status: complete` block and the `status: drafting` block start with `id:`).
  const blocks = [];
  const re = /```yaml\n---\n([\s\S]*?)\n---\n```/g;
  let m;
  while ((m = re.exec(text))) if (/^id:/m.test(m[1])) blocks.push(m[1]);
  return blocks;
}

test("feature.md: has the two docs/features/NNN.md frontmatter template blocks (CREATE + drafting)", () => {
  expect(frontmatterBlocks(readTemplate("feature")).length).toBeGreaterThanOrEqual(2);
});

test('feature.md: neither docs/features/NNN.md frontmatter template block contains a `gate:` field', () => {
  for (const block of frontmatterBlocks(readTemplate("feature"))) {
    expect(block).not.toMatch(/^gate:/m);
  }
});

test("feature.md: the frontmatter template does carry an `issue:` field (replaces `gate:`)", () => {
  const blocks = frontmatterBlocks(readTemplate("feature"));
  expect(blocks.some((b) => /^issue:/m.test(b))).toBe(true);
});

// ── required strings per file (§10 change list) ──────────────────────────────────────────────

const REQUIRED = {
  project: ["harness.toml", "factory doctor"],
  technical: ["CHARTER.md", "status: draft"],
  qa: ["harness.toml", "factory doctor"],
  feature: ["gh issue create", "--label backlog", "issue:"],
};

for (const [name, terms] of Object.entries(REQUIRED)) {
  for (const term of terms) {
    test(`required string: templates/know-thy-build/${name}.md contains "${term}"`, () => {
      expect(readTemplate(name)).toContain(term);
    });
  }
}

// ── §13.3 5-section summary block (P5-R1): Trigger/Reads/Does/Produces/Must not appear right
// after ## Language and before the existing Socratic body, for all 4 templates ─────────────

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
