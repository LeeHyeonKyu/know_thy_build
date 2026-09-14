import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { lintSkillMd } from "../lib/skill-md.js";

// Plan 5 / Task 4 (§13.3, "가장 중요") — the 2 most important operational skills: :unstick
// (factory:needs-human) and :proposal (factory:retro-proposal / factory:harness PRs). These
// tests read the real templates under templates/know-thy-build/, mirroring skills-ops-a.test.js's
// approach for Task 3.

const NAMES = ["unstick", "proposal"];
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

// ── forbidden strings (case-insensitive), whole-file ─────────────────────────────────────────
// worktree / finish / sub-agent(subagent) / transition.sh — neither skill dispatches worktrees
// or sub-agents, neither "finishes" a branch, and both must call the real CLI (transition.js),
// never the stale transition.sh name the spec prose still uses in §13.1's principle 2.

const FORBIDDEN = ["worktree", "finish", "sub-agent", "subagent", "transition.sh"];

for (const name of NAMES) {
  for (const term of FORBIDDEN) {
    test(`forbidden string: templates/know-thy-build/${name}.md does not contain "${term}" (case-insensitive)`, () => {
      expect(readTemplate(name).toLowerCase()).not.toContain(term);
    });
  }
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

// ── required strings per file (task-4-brief.md) ──────────────────────────────────────────────
// unstick: PR #131 is NOT expected here — the spec's :unstick example dialogue (lines 1533-1575)
// creates a new issue with `gh issue create #131 "오프라인 캐시 무효화" --label backlog`, it never
// says "PR #131". "PR #131" belongs to the :proposal example (line 1592) instead.

const REQUIRED = {
  unstick: [
    "/know-thy-build:unstick 118",
    "factory/records",
    "factory-transition-refused",
    "factory-handoff-invalidated",
    "gh issue close",
    "factory:wont-do",
    "human-decision:v1",
    "transition.js",
    'gh issue create #131 "오프라인 캐시 무효화" --label backlog',
  ],
  proposal: [
    "factory-retro:v1 period=",
    "factory:retro-proposal",
    "gh pr diff",
    "gh pr comment",
    "드라이런 불가",
    "claude/fq-",
    "factory:needs-human",
    "human-decision:v1",
    "transition.js",
    "PR #131",
  ],
};

for (const [name, terms] of Object.entries(REQUIRED)) {
  for (const term of terms) {
    test(`required string: templates/know-thy-build/${name}.md contains "${term}"`, () => {
      expect(readTemplate(name)).toContain(term);
    });
  }
}

// ── unstick must NOT claim "PR #131" (that's the :proposal example's PR, not :unstick's) ─────

test("templates/know-thy-build/unstick.md: does not contain the string \"PR #131\" (that belongs to :proposal's example)", () => {
  expect(readTemplate("unstick")).not.toContain("PR #131");
});

// ── the common enforcement paragraph (verbatim from next.md line 38 / task-3-brief.md) must
// appear byte-identical in both files ─────────────────────────────────────────────────────────

const NEXT_TEMPLATE = readFileSync(new URL("next.md", TEMPLATES_KTB), "utf8");
const COMMON_ENFORCEMENT = NEXT_TEMPLATE.split("\n").find((l) => l.startsWith("라벨은 손으로 옮기지 않는다"));

test("sanity: the common enforcement paragraph was actually extracted from next.md", () => {
  expect(COMMON_ENFORCEMENT).toBeTruthy();
  expect(COMMON_ENFORCEMENT).toContain("human-decision:v1 issue=<n> skill=<name>");
});

for (const name of NAMES) {
  test(`templates/know-thy-build/${name}.md: contains the common enforcement paragraph byte-identical to next.md's`, () => {
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

// ── :unstick-specific — the label graph fact: needs-human → queue is the ONLY allowed
// transition, and factory:wont-do is reached via issue-close + human-decision, never transition.

test("templates/know-thy-build/unstick.md: states wont-do is not reachable by transition (needs-human → queue only)", () => {
  const text = readTemplate("unstick");
  expect(text).toMatch(/needs-human\s*→\s*queue/);
  expect(text).not.toMatch(/transition\.js\s+<?n?>?\s*factory:wont-do/);
});

test("templates/know-thy-build/unstick.md: Must not section prohibits reasonless requeue and ad-hoc K/M changes", () => {
  const text = readTemplate("unstick");
  const mustNotIdx = text.indexOf("## Must not");
  const nextHeadingIdx = text.indexOf("\n## ", mustNotIdx + 1);
  const section = text.slice(mustNotIdx, nextHeadingIdx === -1 ? undefined : nextHeadingIdx);
  expect(section).toMatch(/사유\s*없는|사유 없이/);
  expect(section).toMatch(/K[·,\s]*M/);
});

// ── :proposal-specific — the dry-run-per-kind ruling (P5-R4) must name each concrete command,
// and the impossible-dry-run rule must say NOT to recommend approval.

test("templates/know-thy-build/proposal.md: names the per-kind dry-run commands (P5-R4)", () => {
  const text = readTemplate("proposal");
  expect(text).toContain("gh pr list --state merged");
  expect(text).toContain("claude -p");
});

test("templates/know-thy-build/proposal.md: an impossible dry run must not recommend approval", () => {
  const text = readTemplate("proposal");
  const idx = text.indexOf("드라이런 불가");
  expect(idx).toBeGreaterThanOrEqual(0);
  const window = text.slice(idx, idx + 400);
  expect(window).toMatch(/승인.*(권고|추천).*(않|말)|승인을 권고하지 않는다/);
});

test("templates/know-thy-build/proposal.md: mentions the factory:harness PR follows the same flow as :harness (c)", () => {
  const text = readTemplate("proposal");
  expect(text).toContain("factory:harness");
  expect(text).toContain("gh pr checks");
});

test("templates/know-thy-build/proposal.md: covers a needs-human-blocked lessons PR with rebase-or-close options", () => {
  const text = readTemplate("proposal");
  expect(text).toMatch(/rebase/i);
  expect(text).toContain("factory:needs-human");
});

// ── ADR-020 KTB-32 — `:unstick`의 여섯 번째 결정: `retry`(중단 지점으로 되돌리기) ───────────────
// 인프라가 멈춘 런은 "무엇을 다시 판단할 것"이 없다 — 잃은 것은 코드가 아니라 라벨 한 칸이다.
// 그 사실이 스킬 본문에 없으면 사람은 여전히 `queue`(= plan부터 ≈$40)밖에 고르지 못한다.
test("templates/know-thy-build/unstick.md: documents the retry decision and its exact command (KTB-32)", () => {
  const text = readTemplate("unstick");
  expect(text).toMatch(/decision:\s*retry/);
  expect(text).toContain("--human --retry");
  expect(text).toMatch(/transition\.js .*--human --retry/);
  // 언제 고르는가 — 인프라성 중단의 네 얼굴이 모두 이름으로 적혀 있어야 한다.
  for (const sign of ["429", "timeout", "cancel", "0 failing tests"]) expect(text.toLowerCase(), sign).toContain(sign.toLowerCase());
  // 어디에 착지하는가 — implement가 끝났으면 review만 다시 돈다(그것이 이 결정의 값어치다).
  expect(text).toMatch(/awaiting-review/);
  // 사람 전용 엣지라는 사실과, 목적지가 중단 지점 하나뿐이라는 사실.
  expect(text).toMatch(/사람 전용|human-only|by=human/);
});
