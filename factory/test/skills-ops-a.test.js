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

// ── O14 (dogfood): the guard test made the docs tier unreachable for `:issue` issues ─────────
// README-only issue #18 got a `test_NNN_<slug>` guard like every other issue, so its diff carried
// a test file — and CHARTER's docs tier is "diff is docs/**, *.md only", so triage tiered it
// `standard`. The skill must say: all-documentation Impact paths → no guard test, tier docs.
test("templates/know-thy-build/issue.md: docs-only impact paths draft done_when without a regression guard (O14)", () => {
  const text = readTemplate("issue");
  expect(text).toMatch(/docs-only/);
  // The rule names both halves of CHARTER's docs-tier condition, so a reader can check it.
  expect(text).toMatch(/docs\/\*\*/);
  expect(text).toMatch(/\*\.md/);
  // It says what NOT to draft, and it says the tier that follows.
  const idx = text.indexOf("### 문서만 고치는 이슈");
  expect(idx).toBeGreaterThan(-1);
  const section = text.slice(idx, text.indexOf("\n### ", idx + 1));   // 다음 h3까지 (본문 안에 예시 `## ` 헤딩이 있다)
  expect(section).toMatch(/test_NNN_<slug>/);            // names the thing it is suppressing
  expect(section).toMatch(/tier/);
  expect(section).toMatch(/docs/);
  // …and it stays an exception: a mixed diff keeps the guard.
  expect(section).toMatch(/섞이면|mixed/);
  // The default path is untouched — the guard is still the default for everything else.
  expect(text).toMatch(/버그면 회귀 가드 테스트 1개가 기본/);
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

// ── Fix round 1 (Important #1): the factory:harness label lives on the ISSUE only
// (factory/bin/retro.js's createIssue call) — the implementation PR that closes it carries no
// label (factory/lib/gh.js's createPr opens it `--draft`, branch `claude/fq-<issue>`). harness.md
// must find that PR by head branch, not by re-querying a PR label that doesn't exist. ───────────

test("templates/know-thy-build/harness.md: finds the promotion PR by head branch (claude/fq-<n>), not by a PR label", () => {
  const text = readTemplate("harness");
  expect(text).toContain("claude/fq-");
  expect(text).toContain("gh pr diff");
  expect(text).not.toContain("gh pr list --label factory:harness");
});

// ── Fix round 1 (Important #2): every doctor check id quoted in harness.md's table must be a
// real id from factory/lib/doctor/harness.js or factory/lib/doctor/factory.js — extracted by
// regex from the actual source, not typed by hand, so the table can't silently drift from the
// checks doctor really runs (e.g. the old table's "agents.*"/"hooks.*" were never real ids —
// the real ids are per-item: `agents.<role>`, `hooks.<hook>`, built via template literals). ─────

const DOCTOR_HARNESS_SRC = new URL("../lib/doctor/harness.js", import.meta.url);
const DOCTOR_FACTORY_SRC = new URL("../lib/doctor/factory.js", import.meta.url);
const DOCTOR_MERGE_AUTHORITY_SRC = new URL("../lib/doctor/merge-authority.js", import.meta.url);

function doctorSource() {
  // ADR-021 r1 — 머지 권한 판정은 `doctor/merge-authority.js`로 떨어져 나왔다(설치된 트리에서 CI가
  // 부를 수 있어야 하고, `doctor/factory.js`는 `cli/install.js`를 import해 거기서는 로드되지 않는다).
  // 체크 id의 출처가 세 파일이 됐으므로 이 표 검증도 셋을 다 읽어야 한다.
  return [DOCTOR_HARNESS_SRC, DOCTOR_FACTORY_SRC, DOCTOR_MERGE_AUTHORITY_SRC].map((f) => readFileSync(f, "utf8")).join("\n");
}

// Static ids: string-literal doctor ids, e.g. c("harness.schema", ...).
function staticDoctorIds(src) {
  const ids = new Set();
  for (const m of src.matchAll(/"([a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+)"/g)) ids.add(m[1]);
  return ids;
}

// Dynamic id prefixes: template-literal doctor ids built per item, e.g. `agents.${name}` →
// "agents.", `commands.run.${k}` → "commands.run.". The text before "${" is a literal substring
// of the source file regardless of what `name`/`k` evaluate to at runtime.
function dynamicDoctorIdPrefixes(src) {
  const prefixes = new Set();
  for (const m of src.matchAll(/`([a-z][a-zA-Z0-9_.-]*)\$\{/g)) prefixes.add(m[1]);
  return prefixes;
}

function idIsKnownDoctorCheck(id, { staticIds, dynamicPrefixes }) {
  const angle = id.indexOf("<");
  if (angle === -1) return staticIds.has(id);
  return dynamicPrefixes.has(id.slice(0, angle));
}

// Extract every backtick-quoted id-like token from the FIRST column only of harness.md's
// "| doctor id | ... |" table — the second column's prose also uses backticked terms (file
// paths, TOML keys) that aren't doctor ids and must not be checked against the doctor source.
function harnessTableIdTokens(text) {
  const startIdx = text.indexOf("| doctor id |");
  if (startIdx === -1) return [];
  const ids = [];
  for (const line of text.slice(startIdx).split("\n")) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|");
    if (cells.length < 2) continue;
    for (const m of cells[1].matchAll(/`([a-zA-Z][a-zA-Z0-9_.<>-]*)`/g)) ids.push(m[1]);
  }
  return ids;
}

test("templates/know-thy-build/harness.md: doctor-id table extraction finds real static and dynamic ids in the doctor source (sanity check on the extractor itself)", () => {
  const src = doctorSource();
  const staticIds = staticDoctorIds(src);
  const dynamicPrefixes = dynamicDoctorIdPrefixes(src);
  expect(staticIds.has("harness.schema")).toBe(true);
  expect(staticIds.has("roles.roster-defined")).toBe(true);
  expect(dynamicPrefixes.has("agents.")).toBe(true);
  expect(dynamicPrefixes.has("hooks.")).toBe(true);
  expect(dynamicPrefixes.has("skills.")).toBe(true);
  expect(dynamicPrefixes.has("commands.run.")).toBe(true);
});

test("templates/know-thy-build/harness.md: every doctor id in its table is a real check id from factory/lib/doctor/{harness,factory}.js", () => {
  const { staticIds, dynamicPrefixes } = { staticIds: staticDoctorIds(doctorSource()), dynamicPrefixes: dynamicDoctorIdPrefixes(doctorSource()) };
  const ids = harnessTableIdTokens(readTemplate("harness"));
  expect(ids.length).toBeGreaterThan(0);
  const unknown = ids.filter((id) => !idIsKnownDoctorCheck(id, { staticIds, dynamicPrefixes }));
  expect(unknown).toEqual([]);
});

test("templates/know-thy-build/harness.md: the doctor-id table no longer uses fake wildcard ids (agents.*, hooks.*, commands.*, etc.)", () => {
  const ids = harnessTableIdTokens(readTemplate("harness"));
  expect(ids.filter((id) => id.includes("*"))).toEqual([]);
});
