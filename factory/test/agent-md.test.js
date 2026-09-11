import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseAgentMd, lintAgentMd, REQUIRED_SECTIONS } from "../lib/agent-md.js";

const AGENTS = new URL("../../templates/factory/claude/agents/", import.meta.url).pathname;
const readAgent = (name) => readFileSync(`${AGENTS}${name}.md`, "utf8");

// spec §7.3 reviewer-correctness.md — 훅 명령은 이미 .claude/hooks/deny-all-writes.sh다.
const FIXTURE = `---
name: reviewer-correctness
description: PR diff가 실제로 올바른지 — 논리, 경계, 동시성, 실패 경로 — 를 cold read로 판정한다
tools: Read, Grep, Glob, Bash
model: opus
hooks:
  PreToolUse:
    - matcher: Edit|Write
      hooks: [{ type: command, command: .claude/hooks/deny-all-writes.sh }]
---

## Purpose
이 변경이 **의도한 대로 동작하고, 의도하지 않은 것을 깨뜨리지 않는지** 판정한다. 스타일·구조·스펙 일치는 다른 리뷰어의 몫이다. 당신은 "이 코드가 틀릴 수 있는 모든 방법"을 찾는다.

## You receive
- PR diff (base..head)
- 이슈 원문 (스펙 링크 포함)
- \`gates.json\` (테스트 결과 원본)
- 저장소 전체 (읽기 전용)

## You do NOT receive — 그리고 찾아 읽지도 않는다
- 구현자(builder)의 설명, 커밋 메시지 본문, PR description
- 다른 리뷰어의 판정 (라운드 2에서만 제공됨)
이유: 설명은 설득이다. 당신은 코드만 본다.

## You must not
- 파일을 수정한다 (훅이 막는다)
- "테스트가 통과하므로 맞다"고 추론한다 — 테스트가 무엇을 증명하는지 직접 읽는다
- 불확실할 때 approve한다 — **불확실하면 reject**하고 무엇을 확인해야 하는지 쓴다

## Lens
1. 경계값: 빈 입력, 0, 음수, 최대치, 유니코드, 타임존 경계(자정, DST)
2. 실패 경로: 예외가 삼켜지는가, 부분 실패 후 상태가 일관적인가
3. 동시성: 같은 리소스를 두 요청이 건드리면
4. 계약: 호출부가 기대하는 타입·null·순서가 바뀌었는가
5. 테스트 정직성: 새 테스트가 변경을 되돌리면 실패하는가 (\`prove-test\` 결과를 읽는다). 테스트가 구현을 복사하고 있지 않은가
6. 되돌림: 이 변경을 revert하면 무엇이 남는가 (마이그레이션, 캐시, 스케줄)

## Output — schema \`factory.verdict.v1\`
\`\`\`yaml
verdict: approve | reject
confidence: high | medium | low
must_fix:               # reject일 때 ≥1. 각 항목은 재현 가능해야 한다
  - id: cf1
    where: "src/sync/service.ts:88"
    claim: "since 커서가 UTC가 아닌 로컬 시각으로 비교됨"
    evidence: "line 88 \`new Date(since)\`는 로컬 파싱. DB는 UTC 저장 (prisma schema line 41)"
    repro: "since=2026-03-29T01:30 (DST 전환) → 1시간 누락"
should_fix: []          # 머지를 막지 않는 지적
verified: ["dw2: test_sync_full 통과 확인, 테스트 본문이 응답 스키마를 실제로 비교함"]
\`\`\`

## Examples

### 좋은 발견
- "\`retry()\`가 idempotent하지 않은 \`POST /charge\`를 감싼다. 네트워크 타임아웃 시 이중 청구. repro: 응답 지연 > 30s." — 위치·주장·근거·재현이 모두 있다.
- "새 테스트 \`test_123_incremental_sync\`는 mock이 항상 3건을 돌려주므로 \`since\` 필터가 동작하지 않아도 통과한다. prove-test가 이를 확인함(FAIL 기대, PASS 관측)." — 테스트 정직성.

### 나쁜 발견 (이렇게 쓰지 않는다)
- "에러 처리를 개선하면 좋겠습니다." — 위치도 재현도 없다. should_fix로도 부족하다.
- "이 접근보다 이벤트 소싱이 낫습니다." — 정확성이 아니라 설계. architecture 리뷰어의 몫이며, plan 단계에서 끝났어야 할 논쟁이다.

## Perspectives
- **되돌리는 사람의 눈**: 이 PR을 새벽 3시에 revert해야 한다면 무엇이 막는가
- **경계 사냥꾼**: 모든 비교 연산자 옆에 '같을 때'를 적어 본다
- **테스트 회의론자**: 테스트는 통과했다는 사실이 아니라 무엇을 단언했는지로 평가한다

## Lessons
Before reviewing, read \`.factory/lessons/reviewer-correctness.md\` (path is also given in your prompt)
and treat each entry as a checklist item.
`;

test("parseAgentMd: frontmatter (tools split, hooks list-of-maps) + all required sections present", () => {
  const { frontmatter, sections } = parseAgentMd(FIXTURE);
  expect(frontmatter.name).toBe("reviewer-correctness");
  expect(frontmatter.model).toBe("opus");
  expect(frontmatter.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
  expect(frontmatter.hooks).toEqual({
    PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: ".claude/hooks/deny-all-writes.sh" }] }],
  });
  for (const name of REQUIRED_SECTIONS) {
    const hit = [...sections.keys()].some((k) => k === name || k.startsWith(`${name} `));
    expect(hit, `expected a section for "${name}"`).toBe(true);
  }
});

test("lintAgentMd: the §7.3 fixture (as reviewer-correctness) passes with no violations", () => {
  expect(lintAgentMd(FIXTURE, { expectedName: "reviewer-correctness" })).toEqual([]);
});

test("lintAgentMd: name mismatch → exactly one violation", () => {
  // expectedName은 그대로 두어 Lessons 경로 검사는 통과시키고, frontmatter.name만 어긋나게 한다.
  const wrongName = FIXTURE.replace("name: reviewer-correctness\n", "name: reviewer-correctness-typo\n");
  const violations = lintAgentMd(wrongName, { expectedName: "reviewer-correctness" });
  expect(violations).toEqual([{ rule: "name", msg: expect.any(String) }]);
});

test("lintAgentMd: missing required section (Lens removed) → exactly one violation", () => {
  const withoutLens = FIXTURE.replace(/## Lens\n[\s\S]*?(?=\n## )/, "");
  const violations = lintAgentMd(withoutLens, { expectedName: "reviewer-correctness" });
  expect(violations).toEqual([{ rule: "section", msg: expect.stringContaining("Lens") }]);
});

test("lintAgentMd: Examples/좋은 발견 down to 1 bullet → exactly one violation", () => {
  const oneGoodExample = FIXTURE.replace(
    '- "새 테스트 `test_123_incremental_sync`는 mock이 항상 3건을 돌려주므로 `since` 필터가 동작하지 않아도 통과한다. prove-test가 이를 확인함(FAIL 기대, PASS 관측)." — 테스트 정직성.\n',
    ""
  );
  const violations = lintAgentMd(oneGoodExample, { expectedName: "reviewer-correctness" });
  expect(violations).toEqual([{ rule: "examples-good", msg: expect.any(String) }]);
});

test("lintAgentMd: wrong Lessons path → exactly one violation", () => {
  const wrongLessons = FIXTURE.replace(".factory/lessons/reviewer-correctness.md", ".factory/lessons/somewhere-else.md");
  const violations = lintAgentMd(wrongLessons, { expectedName: "reviewer-correctness" });
  expect(violations).toEqual([{ rule: "lessons-path", msg: expect.any(String) }]);
});

test("lintAgentMd: reviewer role without deny-all-writes hook → exactly one violation", () => {
  const noHook = FIXTURE.replace(
    `hooks:
  PreToolUse:
    - matcher: Edit|Write
      hooks: [{ type: command, command: .claude/hooks/deny-all-writes.sh }]
`,
    ""
  );
  const violations = lintAgentMd(noHook, { expectedName: "reviewer-correctness" });
  expect(violations).toEqual([{ rule: "deny-hook", msg: expect.any(String) }]);
});

// Task 2: factory-loader.md / factory-triage.md templates (full suite lint is switched on in Task 6).
test("lintAgentMd: templates/factory/claude/agents/factory-loader.md passes with no violations", () => {
  const text = readAgent("factory-loader");
  expect(lintAgentMd(text, { expectedName: "factory-loader" })).toEqual([]);
});

test("lintAgentMd: templates/factory/claude/agents/factory-triage.md passes with no violations", () => {
  const text = readAgent("factory-triage");
  expect(lintAgentMd(text, { expectedName: "factory-triage" })).toEqual([]);
});

test("parseAgentMd: factory-loader.md frontmatter — sonnet model, read-only tools, deny-all-writes hook", () => {
  const { frontmatter } = parseAgentMd(readAgent("factory-loader"));
  expect(frontmatter.name).toBe("factory-loader");
  expect(frontmatter.model).toBe("sonnet");
  expect(frontmatter.tools).toEqual(["Read", "Bash", "Grep"]);
  expect(frontmatter.hooks.PreToolUse[0].hooks[0].command).toContain("deny-all-writes.sh");
});

// Task 3: the five plan debate agents.
const PLAN_AGENTS = ["plan-product-advocate", "plan-architect", "plan-skeptic", "plan-operator", "plan-synthesizer"];

for (const name of PLAN_AGENTS) {
  test(`lintAgentMd: templates/factory/claude/agents/${name}.md passes with no violations`, () => {
    expect(lintAgentMd(readAgent(name), { expectedName: name })).toEqual([]);
  });
}

test("plan agents: read-only tools and the roles.toml model, every one behind deny-all-writes", () => {
  const models = { "plan-product-advocate": "opus", "plan-architect": "opus", "plan-skeptic": "opus", "plan-operator": "sonnet", "plan-synthesizer": "opus" };
  for (const name of PLAN_AGENTS) {
    const { frontmatter } = parseAgentMd(readAgent(name));
    expect(frontmatter.name, name).toBe(name);
    expect(frontmatter.model, name).toBe(models[name]);
    expect(frontmatter.tools, name).toEqual(["Read", "Grep", "Glob"]);
    expect(frontmatter.hooks.PreToolUse[0].matcher, name).toBe("Edit|Write|NotebookEdit");
    expect(frontmatter.hooks.PreToolUse[0].hooks[0].command, name).toContain("deny-all-writes.sh");
  }
});

test("plan-skeptic.md carries the §5.2.5-④ mandatory question for flaky issues", () => {
  const { sections } = parseAgentMd(readAgent("plan-skeptic"));
  const lens = [...sections.entries()].find(([k]) => k.startsWith("Lens"))[1];
  expect(lens).toContain("테스트 문제인가 제품의 경쟁 조건인가");
});

test("plan-synthesizer.md forbids forging consensus and done_when without a test id", () => {
  const { sections } = parseAgentMd(readAgent("plan-synthesizer"));
  const mustNot = [...sections.entries()].find(([k]) => k.startsWith("You must not"))[1];
  expect(mustNot).toMatch(/dissent_log|objection|반박/);
  expect(mustNot).toContain("test_<issue>_<slug>");
});

// Task 4: the implement pair — factory-builder (the only role that writes) and factory-verifier (cold read).
for (const name of ["factory-builder", "factory-verifier"]) {
  test(`lintAgentMd: templates/factory/claude/agents/${name}.md passes with no violations`, () => {
    expect(lintAgentMd(readAgent(name), { expectedName: name })).toEqual([]);
  });
}

test("factory-builder.md: opus, may write, and is NOT behind deny-all-writes — it is the only role that edits", () => {
  const { frontmatter } = parseAgentMd(readAgent("factory-builder"));
  expect(frontmatter.name).toBe("factory-builder");
  expect(frontmatter.model).toBe("opus");
  for (const t of ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]) expect(frontmatter.tools, t).toContain(t);
  expect(frontmatter.hooks?.PreToolUse).toBeUndefined();
});

test("factory-builder.md: the protected build-config paths are off-limits in both You must not and Lens, with the harness-change escape hatch", () => {
  const text = readAgent("factory-builder");
  const { sections } = parseAgentMd(text);
  const find = (k) => [...sections.entries()].find(([key]) => key.startsWith(k))[1];
  const mustNot = find("You must not");
  const lens = find("Lens");
  for (const p of ["package.json", "package-lock.json", "vitest.config.*", "playwright.config.*", "tsconfig*.json", ".eslintrc*", "eslint.config.*", ".factory/**", ".claude/**", ".github/workflows/factory-*.yml", "docs/factory/CHARTER.md"]) {
    expect(mustNot, p).toContain(p);
  }
  expect(mustNot).toMatch(/integrity/);
  expect(lens).toContain("Harness change needed");
  expect(lens).toMatch(/factory:harness/);
  expect(lens).toMatch(/npm install/);
  // §5.2.4 tests_are_load_bearing
  expect(mustNot).toMatch(/tests_are_load_bearing|기존 테스트/);
});

test("factory-verifier.md: opus, read-only tools, deny-all-writes, and an explicit cold-read refusal list", () => {
  const { frontmatter, sections } = parseAgentMd(readAgent("factory-verifier"));
  expect(frontmatter.name).toBe("factory-verifier");
  expect(frontmatter.model).toBe("opus");
  expect(frontmatter.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
  expect(frontmatter.hooks.PreToolUse[0].matcher).toBe("Edit|Write|NotebookEdit");
  expect(frontmatter.hooks.PreToolUse[0].hooks[0].command).toContain("deny-all-writes.sh");

  // §7.3 structure: the refusal list is its own section, and it names the builder's channels by name
  const refusesEntry = [...sections.entries()].find(([k]) => k.startsWith("You do NOT receive"));
  const refuses = refusesEntry[1];
  const lens = [...sections.entries()].find(([k]) => k.startsWith("Lens"))[1];
  expect(refusesEntry[0]).toMatch(/찾아 읽지도 않는다/);
  expect(refuses).toMatch(/PR description/);
  expect(refuses).toMatch(/커밋 메시지|commit message/);
  expect(refuses).toMatch(/head sha|head_sha/);
  expect(lens).toContain("prove-test");
  expect(lens).toMatch(/done_when/);
});
