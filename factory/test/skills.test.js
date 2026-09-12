import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillMd, lintSkillMd, SKILL_SECTIONS } from "../lib/skill-md.js";

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────
// TEMPLATE_OK is what a template under templates/know-thy-build/ looks like (installed:false,
// still carries {{LANG}}). INSTALLED_OK is the same file after `npx know-thy-build` substitutes it.
const TEMPLATE_OK = `---
description: Do the thing.
allowed-tools: [Read, Write]
---

# Skill

## Language

**All conversation MUST be in: {{LANG}}**

## Trigger

When needed.

## Reads

The relevant files.

## Does

Summarize, then act.

## Produces

A result.

## Must not

Do the wrong thing.
`;

const INSTALLED_OK = TEMPLATE_OK.replace("{{LANG}}", "English");

// An operational skill (not digest/status) must additionally carry transition.js, a gh pr merge
// prohibition sentence, and human-decision:v1 — all three live inside ## Does here, which is fine:
// the linter scans the whole document for these, not just one section.
const OPS_OK = INSTALLED_OK.replace(
  "Summarize, then act.",
  [
    "1. Summarize, then act.",
    '2. Transition with `node .factory/bin/transition.js <issue> <label> --human --reason "..."`.',
    "3. Merging is never done here — `gh pr merge` is forbidden; only a GitHub UI link.",
    "4. Record the decision as a `human-decision:v1` comment.",
  ].join("\n")
);

// digest/status are read-only: they still must ban `gh pr merge`, but need neither transition.js
// nor human-decision:v1.
const OPS_READONLY_OK = INSTALLED_OK.replace(
  "Summarize, then act.",
  "1. Summarize.\n2. Merging is never done here — `gh pr merge` is forbidden."
);

const CLI = new URL("../../bin/cli.js", import.meta.url).pathname;
const TEMPLATES_KTB = new URL("../../templates/know-thy-build/", import.meta.url).pathname;

function runInstaller(cwd) {
  return spawnSync(process.execPath, [CLI, "--lang", "ko"], {
    cwd,
    env: { ...process.env, HOME: cwd },
    encoding: "utf8",
  });
}

// ── parseSkillMd ─────────────────────────────────────────────────────────────────────────────

test("parseSkillMd: frontmatter (allowed-tools inline array) + the 6 sections in order", () => {
  const { frontmatter, sections } = parseSkillMd(TEMPLATE_OK);
  expect(frontmatter.description).toBe("Do the thing.");
  expect(frontmatter["allowed-tools"]).toEqual(["Read", "Write"]);
  expect([...sections.keys()]).toEqual(SKILL_SECTIONS);
  expect(sections.get("Trigger")).toBe("When needed.");
});

// ── lintSkillMd: base fixtures pass ──────────────────────────────────────────────────────────

test("lintSkillMd: a well-formed template (installed:false) passes", () => {
  expect(lintSkillMd(TEMPLATE_OK, { name: "project", installed: false })).toEqual([]);
});

test("lintSkillMd: a well-formed installed skill (installed:true) passes", () => {
  expect(lintSkillMd(INSTALLED_OK, { name: "project", installed: true })).toEqual([]);
});

// ── rule: description ────────────────────────────────────────────────────────────────────────

test("lintSkillMd: empty description → description violation", () => {
  const bad = INSTALLED_OK.replace("description: Do the thing.", "description:");
  expect(lintSkillMd(bad, { name: "project", installed: true })).toEqual([
    { rule: "description", msg: expect.any(String) },
  ]);
});

test("lintSkillMd: non-empty description passes", () => {
  expect(lintSkillMd(INSTALLED_OK, { name: "project", installed: true })).toEqual([]);
});

// ── rule: allowed-tools ──────────────────────────────────────────────────────────────────────

test("lintSkillMd: empty allowed-tools array → allowed-tools violation", () => {
  const bad = INSTALLED_OK.replace("allowed-tools: [Read, Write]", "allowed-tools: []");
  expect(lintSkillMd(bad, { name: "project", installed: true })).toEqual([
    { rule: "allowed-tools", msg: expect.any(String) },
  ]);
});

test("lintSkillMd: allowed-tools with >=1 entries passes", () => {
  expect(lintSkillMd(INSTALLED_OK, { name: "project", installed: true })).toEqual([]);
});

// ── rule: language ───────────────────────────────────────────────────────────────────────────

test("lintSkillMd: template missing {{LANG}} → language violation", () => {
  const bad = TEMPLATE_OK.replace("{{LANG}}", "English");
  expect(lintSkillMd(bad, { name: "project", installed: false })).toEqual([
    { rule: "language", msg: expect.any(String) },
  ]);
});

test("lintSkillMd: template with {{LANG}} passes", () => {
  expect(lintSkillMd(TEMPLATE_OK, { name: "project", installed: false })).toEqual([]);
});

test("lintSkillMd: installed skill missing the ## Language section → language violation", () => {
  const bad = INSTALLED_OK.replace(/## Language\n\n\*\*All conversation MUST be in: English\*\*\n\n/, "");
  const violations = lintSkillMd(bad, { name: "project", installed: true });
  expect(violations.some((v) => v.rule === "language")).toBe(true);
});

test("lintSkillMd: installed skill with ## Language present passes", () => {
  expect(lintSkillMd(INSTALLED_OK, { name: "project", installed: true })).toEqual([]);
});

// ── rule: section (missing) ──────────────────────────────────────────────────────────────────

test("lintSkillMd: missing ## Trigger section → section violation", () => {
  const bad = INSTALLED_OK.replace("## Trigger\n\nWhen needed.\n\n", "");
  const violations = lintSkillMd(bad, { name: "project", installed: true });
  expect(violations).toContainEqual({ rule: "section", msg: expect.stringContaining("Trigger") });
});

test("lintSkillMd: all 6 sections present passes", () => {
  expect(lintSkillMd(INSTALLED_OK, { name: "project", installed: true })).toEqual([]);
});

// ── rule: section-empty ──────────────────────────────────────────────────────────────────────

test("lintSkillMd: ## Trigger present but empty → section-empty violation", () => {
  const bad = INSTALLED_OK.replace("## Trigger\n\nWhen needed.\n\n", "## Trigger\n\n");
  const violations = lintSkillMd(bad, { name: "project", installed: true });
  expect(violations).toContainEqual({ rule: "section-empty", msg: expect.stringContaining("Trigger") });
});

test("lintSkillMd: every section non-empty passes", () => {
  expect(lintSkillMd(INSTALLED_OK, { name: "project", installed: true })).toEqual([]);
});

// ── rule: section-order ──────────────────────────────────────────────────────────────────────

test("lintSkillMd: ## Does moved before ## Reads → section-order violation", () => {
  const bad = INSTALLED_OK
    .replace("## Reads\n\nThe relevant files.\n\n## Does\n\nSummarize, then act.\n\n", "## Does\n\nSummarize, then act.\n\n## Reads\n\nThe relevant files.\n\n");
  const violations = lintSkillMd(bad, { name: "project", installed: true });
  expect(violations).toContainEqual({ rule: "section-order", msg: expect.any(String) });
});

test("lintSkillMd: sections in the canonical order passes", () => {
  expect(lintSkillMd(INSTALLED_OK, { name: "project", installed: true })).toEqual([]);
});

// ── ops rules: transition.js / gh pr merge / human-decision:v1 ──────────────────────────────

test("lintSkillMd: operational skill (harness) without transition.js → ops-transition violation", () => {
  const bad = OPS_OK.replace(/2\. Transition.*\n/, "");
  const violations = lintSkillMd(bad, { name: "harness", installed: true });
  expect(violations).toContainEqual({ rule: "ops-transition", msg: expect.any(String) });
});

test("lintSkillMd: operational skill (harness) with transition.js passes", () => {
  expect(lintSkillMd(OPS_OK, { name: "harness", installed: true })).toEqual([]);
});

test("lintSkillMd: operational skill (harness) without a gh pr merge prohibition sentence → ops-gh-pr-merge violation", () => {
  const bad = OPS_OK.replace(/3\. Merging.*\n/, "");
  const violations = lintSkillMd(bad, { name: "harness", installed: true });
  expect(violations).toContainEqual({ rule: "ops-gh-pr-merge", msg: expect.any(String) });
});

test("lintSkillMd: operational skill (harness) with the prohibition sentence passes", () => {
  expect(lintSkillMd(OPS_OK, { name: "harness", installed: true })).toEqual([]);
});

test("lintSkillMd: operational skill (harness) without human-decision:v1 → ops-human-decision violation", () => {
  const bad = OPS_OK.replace(/4\. Record.*\n/, "");
  const violations = lintSkillMd(bad, { name: "harness", installed: true });
  expect(violations).toContainEqual({ rule: "ops-human-decision", msg: expect.any(String) });
});

test("lintSkillMd: operational skill (harness) with human-decision:v1 passes", () => {
  expect(lintSkillMd(OPS_OK, { name: "harness", installed: true })).toEqual([]);
});

test("lintSkillMd: :status is read-only — no transition.js/human-decision required, but gh pr merge ban still is", () => {
  expect(lintSkillMd(OPS_READONLY_OK, { name: "status", installed: true })).toEqual([]);
  const noBan = OPS_READONLY_OK.replace("2. Merging is never done here — `gh pr merge` is forbidden.", "");
  const violations = lintSkillMd(noBan, { name: "status", installed: true });
  expect(violations).toContainEqual({ rule: "ops-gh-pr-merge", msg: expect.any(String) });
});

test("lintSkillMd: :digest is exempt from transition.js and human-decision but not from the merge ban", () => {
  expect(lintSkillMd(OPS_READONLY_OK, { name: "digest", installed: true })).toEqual([]);
});

test("lintSkillMd: a Define skill (project) is never held to the ops rules even without any of the three phrases", () => {
  expect(lintSkillMd(INSTALLED_OK, { name: "project", installed: true })).toEqual([]);
});

// ── installer integration (spawns bin/cli.js against a tmp HOME/cwd) ────────────────────────

test("installer: installs exactly templates/know-thy-build/*.md, substitutes {{LANG}}, and installs nothing under .claude/commands/factory/", () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-install-"));
  const result = runInstaller(root);
  expect(result.status, result.stderr).toBe(0);

  const dest = join(root, ".claude/commands/know-thy-build");
  const installed = readdirSync(dest).filter((f) => f.endsWith(".md")).sort();
  const templates = readdirSync(TEMPLATES_KTB).filter((f) => f.endsWith(".md")).sort();
  expect(installed).toEqual(templates);
  expect(installed).not.toContain("finish.md");

  for (const f of installed) {
    expect(readFileSync(join(dest, f), "utf8")).not.toContain("{{LANG}}");
  }

  expect(existsSync(join(root, ".claude/commands/factory"))).toBe(false);
}, 30_000);

test("installer: removes a pre-existing know-thy-build/finish.md legacy file", () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-install-finish-"));
  const dir = join(root, ".claude/commands/know-thy-build");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "finish.md"), "legacy :finish skill\n");

  const result = runInstaller(root);
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(dir, "finish.md"))).toBe(false);
}, 30_000);
