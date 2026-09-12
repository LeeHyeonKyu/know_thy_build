import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { lintSkillMd } from "../lib/skill-md.js";

// Plan 5 / Task 3 (§13.3) — the 4 newly-created skills: :issue (Define), :harness/:next/:clarify
// (Operate). These tests read the real templates under templates/know-thy-build/, mirroring
// skills-phase1.test.js's approach for the Task 2 revisions.

const NAMES = ["issue", "harness", "next", "clarify"];
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

// ── forbidden strings (case-insensitive), whole-file ─────────────────────────────────────────
// worktree / finish / sub-agent(subagent) — none of these 4 skills dispatch worktrees or
// sub-agents, and none of them "finish" a branch (that used to be :finish, now gone per §13).

const FORBIDDEN = ["worktree", "finish", "sub-agent", "subagent"];

for (const name of NAMES) {
  for (const term of FORBIDDEN) {
    test(`forbidden string: templates/know-thy-build/${name}.md does not contain "${term}" (case-insensitive)`, () => {
      expect(readTemplate(name).toLowerCase()).not.toContain(term);
    });
  }
}

// ── "gh pr merge" may appear ONLY on a line that also carries a negation word ────────────────
// (mirrors skill-md.js's hasGhPrMergeProhibition, but checks EVERY occurrence, not just "at
// least one" — a stray unguarded mention elsewhere in the file would still be a spec violation).

function ghPrMergeLinesWithoutNegation(text) {
  const negation = /(never|must not|forbidden|prohibited|do not|don't|no\b|금지)/i;
  return text.split("\n").filter((line) => /gh pr merge/i.test(line) && !negation.test(line));
}

for (const name of NAMES) {
  test(`templates/know-thy-build/${name}.md: every "gh pr merge" mention is on a line with a negation word`, () => {
    expect(ghPrMergeLinesWithoutNegation(readTemplate(name))).toEqual([]);
  });
}

// ── required strings per file (task-3-brief.md) ──────────────────────────────────────────────

const REQUIRED = {
  issue: ["transition.js", "--label backlog", "factory status --json", "test_NNN_"],
  harness: ["transition.js", "factory doctor", "factory:harness", "human-decision:v1"],
  next: ["transition.js", "factory status --json", "--label backlog", "human-decision:v1"],
  clarify: ["transition.js", "factory-handoff:v1 stage=triage", "gh issue edit", "human-decision:v1"],
};

for (const [name, terms] of Object.entries(REQUIRED)) {
  for (const term of terms) {
    test(`required string: templates/know-thy-build/${name}.md contains "${term}"`, () => {
      expect(readTemplate(name)).toContain(term);
    });
  }
}

// ── the common enforcement paragraph (task-3-brief.md) must appear verbatim in all 4 files ───

const COMMON_ENFORCEMENT =
  '라벨은 손으로 옮기지 않는다(`gh issue edit --add-label/--remove-label` 금지); 전이는 `node .factory/bin/transition.js <issue> <label> --human --reason "<why>"`; 거부되면 사유를 사람에게 보여주고 멈춘다; 머지는 `gh pr merge` 금지(GitHub UI 링크만); 결정은 이슈(또는 PR) 코멘트 `<!-- human-decision:v1 issue=<n> skill=<name> -->` + ```yaml 블록(`decision`, `reason`, `actions[]`)으로 `gh issue comment <n> --body-file <tmp>`(본문에 `>` 줄이 있을 수 있으므로 항상 `--body-file`); 모든 요약은 **먼저 읽고**(handoff·run 기록·gates.json·dissent) 한 화면(≤25줄)으로; 질문은 한 번에 하나, 선택지는 2~3개에 권장 표시.';

for (const name of NAMES) {
  test(`templates/know-thy-build/${name}.md: contains the common enforcement paragraph verbatim`, () => {
    expect(readTemplate(name)).toContain(COMMON_ENFORCEMENT);
  });
}

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
// Same regression guard as skills-phase1.test.js's helper, reused here for the 4 new files.

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

// ── :issue-specific: the test_NNN_ placeholder is corrected to the real issue number after
// `gh issue create` returns — must describe a correction comment, not just the placeholder. ──

test("templates/know-thy-build/issue.md: describes posting a correction comment with the real issue number after gh issue create", () => {
  const text = readTemplate("issue");
  expect(text).toContain("gh issue create");
  expect(text).toMatch(/gh issue comment/);
});

// ── :harness-specific: Must not section names both prohibitions (never merge, never shrink
// [protected]/[load_bearing] paths) — not just the common paragraph's generic merge ban. ──────

test("templates/know-thy-build/harness.md: Must not section mentions [protected] and [load_bearing]", () => {
  const text = readTemplate("harness");
  const mustNotIdx = text.indexOf("## Must not");
  const nextHeadingIdx = text.indexOf("\n## ", mustNotIdx + 1);
  const section = text.slice(mustNotIdx, nextHeadingIdx === -1 ? undefined : nextHeadingIdx);
  expect(section).toContain("[protected]");
  expect(section).toContain("[load_bearing]");
});

// ── :next-specific: records the decision on the CHOSEN issue with skill=next, decision: queue.

test("templates/know-thy-build/next.md: human-decision example uses skill=next and decision: queue", () => {
  const text = readTemplate("next");
  expect(text).toMatch(/skill=next/);
  expect(text).toMatch(/decision:\s*queue/);
});

// ── :clarify-specific: never answers the question itself; one question per turn. ─────────────

test("templates/know-thy-build/clarify.md: Must not section prohibits answering questions itself", () => {
  const text = readTemplate("clarify");
  const mustNotIdx = text.indexOf("## Must not");
  const nextHeadingIdx = text.indexOf("\n## ", mustNotIdx + 1);
  const section = text.slice(mustNotIdx, nextHeadingIdx === -1 ? undefined : nextHeadingIdx);
  expect(section).toMatch(/스스로 답/);
});
