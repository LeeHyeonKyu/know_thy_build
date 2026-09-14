import { test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { parseAgentMd, lintAgentMd, REQUIRED_SECTIONS } from "../lib/agent-md.js";

const AGENTS = new URL("../../templates/factory/claude/agents/", import.meta.url).pathname;
const readAgent = (name) => readFileSync(`${AGENTS}${name}.md`, "utf8");
const agentFiles = () => readdirSync(AGENTS).filter((f) => f.endsWith(".md")).sort();

// spec §7.3 reviewer-correctness.md — 훅 명령은 이미 .claude/hooks/deny-all-writes.sh다.
// 픽스처는 템플릿의 전사(transcription)다. 스펙 원문에 대해 두 줄이 다르고, 둘 다 스펙 쪽도 같이 고쳤다:
//  · `gates.json` 항목(F2) — §7.3은 리뷰 스테이지에 그 파일이 **없다**는 사실을 말하지 않았다.
//    run-stage.js가 `claude -p` 앞에서 `.factory/out/`을 지우고, 게이트는 workflow가 return한 뒤에야 돈다.
//  · `matcher`(F6) — `Edit|Write` → `Edit|Write|MultiEdit|NotebookEdit|Bash`. NotebookEdit을 놓치는 deny는 deny가
//    아니고, Bash를 놓치면 `echo x > src/a.js`를 아무도 막지 않는다. 스펙 §7.3의 같은 줄에는 판결 출처를
//    인라인 주석으로 달아 두었다(그 주석만 템플릿에 없다).
const FIXTURE = `---
name: reviewer-correctness
description: PR diff가 실제로 올바른지 — 논리, 경계, 동시성, 실패 경로 — 를 cold read로 판정한다
tools: Read, Grep, Glob, Bash
model: opus
hooks:
  PreToolUse:
    - matcher: Edit|Write|MultiEdit|NotebookEdit|Bash
      hooks: [{ type: command, command: .claude/hooks/deny-all-writes.sh }]
---

## Purpose
이 변경이 **의도한 대로 동작하고, 의도하지 않은 것을 깨뜨리지 않는지** 판정한다. 스타일·구조·스펙 일치는 다른 리뷰어의 몫이다. 당신은 "이 코드가 틀릴 수 있는 모든 방법"을 찾는다.

## You receive
- PR diff (base..head)
- 이슈 원문 (스펙 링크 포함)
- \`.factory/out/gates.json\` **if present** — in the review stage the gates for this commit run after you, so it is normally absent; judge the diff and the tests themselves
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
When an entry actually shapes a finding, **cite it inside that finding's own \`claim\`** with the marker
\`lesson:<id>\` (e.g. \`lesson:L-2026-09-01-03\`). That marker is the only record that the lesson did any
work: retro counts it into the entry's \`인용\`, and a lesson nobody ever cites is the first one retired.
Never cite a lesson you did not use — the count is evidence, not courtesy.
`;

test("parseAgentMd: frontmatter (tools split, hooks list-of-maps) + all required sections present", () => {
  const { frontmatter, sections } = parseAgentMd(FIXTURE);
  expect(frontmatter.name).toBe("reviewer-correctness");
  expect(frontmatter.model).toBe("opus");
  expect(frontmatter.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
  expect(frontmatter.hooks).toEqual({
    PreToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash", hooks: [{ type: "command", command: ".claude/hooks/deny-all-writes.sh" }] }],
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

test("lintAgentMd: a decorated header is the section, a different word is not", () => {
  const swap = (header) => lintAgentMd(FIXTURE.replace("## Lens\n", `${header}\n`), { expectedName: "reviewer-correctness" });
  // ` —`, `:` and ` (` are decoration on the same section name
  for (const header of ["## Lens", "## Lens — 무엇을 보는가", "## Lens:", "## Lens (deprecated)"]) {
    expect(swap(header), header).toEqual([]);
  }
  // a different word is a different section — it must not satisfy `## Lens`
  for (const header of ["## Lenses", "## Lens of the reviewer"]) {
    expect(swap(header), header).toEqual([{ rule: "section", msg: expect.stringContaining("## Lens") }]);
  }
});

test("lintAgentMd: reviewer role without deny-all-writes hook → exactly one violation", () => {
  const noHook = FIXTURE.replace(
    `hooks:
  PreToolUse:
    - matcher: Edit|Write|MultiEdit|NotebookEdit|Bash
      hooks: [{ type: command, command: .claude/hooks/deny-all-writes.sh }]
`,
    ""
  );
  const violations = lintAgentMd(noHook, { expectedName: "reviewer-correctness" });
  expect(violations).toEqual([{ rule: "deny-hook", msg: expect.any(String) }]);
});

// ── F6: matcher가 Bash를 덮지 않으면 deny가 반쪽이다 ─────────────────────────────────────────
// 훅 스크립트는 Bash 명령도 판정하지만(쓰기 리다이렉션·cp/mv·git commit …), 매처가 Edit/Write만 걸면 그
// 판정은 절대 발화하지 않는다. 전역 block-dangerous.sh는 보호 경로만 보므로 `echo x > src/a.js`는 그냥 통과한다.
// KTB-13 r1: 매처는 **쓰기 도구 전부**를 덮어야 한다. allow가 `Edit`·`Write`·`MultiEdit`·`NotebookEdit`을
// 전역으로 부여하므로(KTB-13), 매처에서 빠진 도구 하나가 곧 그 역할의 쓰기 금지를 통째로 여는 구멍이다.
test("lintAgentMd: a deny-all-writes hook whose matcher omits any write tool → exactly one deny-hook violation", () => {
  const narrow = (matcher) => lintAgentMd(
    FIXTURE.replace("- matcher: Edit|Write|MultiEdit|NotebookEdit|Bash\n", `- matcher: ${matcher}\n`),
    { expectedName: "reviewer-correctness" },
  );
  for (const [m, missing] of [
    ["Edit|Write|MultiEdit|NotebookEdit", "Bash"],
    ["Edit|Write|NotebookEdit|Bash", "MultiEdit"],
    ["Edit|Write|MultiEdit|Bash", "NotebookEdit"],
    ["Edit|Write", "MultiEdit"],
    ["Edit", "Write"],
  ]) {
    expect(narrow(m), m).toEqual([{ rule: "deny-hook", msg: expect.stringContaining(missing) }]);
  }
  // 순서와 공백은 상관없다 — 다섯 이름이 대안으로 들어 있기만 하면 된다
  for (const m of ["Bash|Edit|Write|MultiEdit|NotebookEdit", "Edit | Write | MultiEdit | NotebookEdit | Bash",
    "Edit|Write|MultiEdit|NotebookEdit|Bash|Task"]) {
    expect(narrow(m), m).toEqual([]);
  }
  // 이름을 **포함하는 다른 단어**는 그 도구가 아니다
  expect(narrow("Edit|Write|MultiEdit|NotebookEdit|BashTool")).toEqual([{ rule: "deny-hook", msg: expect.stringContaining("Bash") }]);
});

// Task 2: factory-triage.md 템플릿(전체 lint는 Task 6에서 켜진다). factory-loader.md는 외부 감사
// 2026-09-14 M5로 삭제됐다 — workflow의 첫 스텝은 LLM 호출이 아니라 `factory/lib/context.js`가 쓰는
// `.factory/out/loaded.json`이다.
/**
 * ── ADR-024 / KTB-42 — 증거를 다루는 두 역할은 도구를 **이름으로** 안다 ────────────────────────
 * qa는 그 도구로만 쓰고, spec-conformance는 그 도구가 만든 매니페스트로 판정한다. 프롬프트가 그
 * 이름을 잃어버리면 둘은 즉흥 리다이렉션과 "디렉터리가 비었다"로 돌아간다 — KTB #3의 8라운드.
 */
test("KTB-42: reviewer-qa and reviewer-spec-conformance must name the evidence tool, others need not", () => {
  for (const name of ["reviewer-qa", "reviewer-spec-conformance"]) {
    const text = readAgent(name);
    expect(text, name).toContain(".factory/bin/qa-evidence.js");
    expect(lintAgentMd(text, { expectedName: name }), name).toEqual([]);
    const stripped = text.split(".factory/bin/qa-evidence.js").join(".factory/out/qa/");
    expect(lintAgentMd(stripped, { expectedName: name })).toEqual([{ rule: "qa-evidence-tool", msg: expect.stringContaining("qa-evidence.js") }]);
  }
  // 다른 역할에는 이 규칙이 걸리지 않는다 — 증거를 쓰지도 읽지도 않는다.
  expect(lintAgentMd(FIXTURE, { expectedName: "reviewer-correctness" })).toEqual([]);
});

test("KTB-42: reviewer-qa spells the four subcommands and the maturity minimums; spec-conformance rejects by id", () => {
  const qa = readAgent("reviewer-qa");
  for (const sub of ["record", "attach", "na ", "finish"]) expect(qa, sub).toContain(sub);
  for (const m of ["M0", "M1", "M2"]) expect(qa, m).toContain(m);
  expect(qa).toMatch(/claim:dw/);                          // 판정이 claim id를 인용하는 모양

  const spec = readAgent("reviewer-spec-conformance");
  expect(spec).toContain("spec-evidence-missing");
  expect(spec).toMatch(/디렉터리가 비었다|directory is empty/);   // 그 문구를 **쓰지 말라**고 말한다
});

test("lintAgentMd: templates/factory/claude/agents/factory-triage.md passes with no violations", () => {
  const text = readAgent("factory-triage");
  expect(lintAgentMd(text, { expectedName: "factory-triage" })).toEqual([]);
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
    expect(frontmatter.hooks.PreToolUse[0].matcher, name).toBe("Edit|Write|MultiEdit|NotebookEdit|Bash");
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
  // 프롬프트는 이 금지를 **실제로 집행하는 것**의 이름을 대야 한다. ADR-020 이후 그것은 integrity
  // 체크(변조만 RED)가 아니라 merge 스테이지다 — "integrity가 PR을 거절한다"는 이제 틀린 문장이고,
  // 틀린 위협은 에이전트가 한 번 부딪혀 보면 거짓으로 드러나 나머지 금지까지 함께 약해진다.
  expect(mustNot).toMatch(/merge 스테이지가 자동 머지를 거부/);
  expect(mustNot).not.toMatch(/integrity가 PR을 거절/);
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
  expect(frontmatter.hooks.PreToolUse[0].matcher).toBe("Edit|Write|MultiEdit|NotebookEdit|Bash");
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

// Task 5: the five review roles (roles.toml [review.*]).
const REVIEW_AGENTS = ["reviewer-correctness", "reviewer-security", "reviewer-architecture", "reviewer-spec-conformance", "reviewer-qa"];

for (const name of REVIEW_AGENTS) {
  test(`lintAgentMd: templates/factory/claude/agents/${name}.md passes with no violations`, () => {
    expect(lintAgentMd(readAgent(name), { expectedName: name })).toEqual([]);
  });
}

/**
 * 외부 감사 2026-09-14 M11 — 인용 카운터(`인용: N회`)를 올릴 수 있는 유일한 입력은 판정문 안의
 * `lesson:<id>` 마커다. 그 마커를 내놓으라고 말하는 곳이 프롬프트뿐이므로, 말하지 않으면 카운터는
 * 영원히 0이고 은퇴 규칙("인용 0회부터")은 그냥 "오래된 것부터"가 된다.
 */
test("M11: every role that reads lessons is told to cite `lesson:<id>` when it used one", () => {
  for (const name of [...REVIEW_AGENTS, "factory-builder"]) {
    const md = readAgent(name);
    expect(md, name).toMatch(/lesson:<id>/);
    expect(md, name).toMatch(/lesson:L-\d{4}-\d{2}-\d{2}-\d{2}/);      // 형식을 예시로 보여 준다
    expect(md, name).toMatch(/인용/);
  }
});

test("reviewer agents: roles.toml models and tools, every one behind deny-all-writes", () => {
  const models = {
    "reviewer-correctness": "opus", "reviewer-security": "opus", "reviewer-architecture": "opus",
    "reviewer-spec-conformance": "sonnet", "reviewer-qa": "sonnet",
  };
  for (const name of REVIEW_AGENTS) {
    const { frontmatter } = parseAgentMd(readAgent(name));
    expect(frontmatter.name, name).toBe(name);
    expect(frontmatter.model, name).toBe(models[name]);
    expect(frontmatter.hooks.PreToolUse[0].matcher, name).toBe("Edit|Write|MultiEdit|NotebookEdit|Bash");
    expect(frontmatter.hooks.PreToolUse[0].hooks[0].command, name).toContain("deny-all-writes.sh");
    expect(frontmatter.tools, name).toContain("Read");
  }
  // qa is the only reviewer that drives a browser — but through Bash (`npx playwright`), not an MCP server:
  // 1.0 installs no MCP, so `mcp__playwright__*` would name a tool that is never there (F3).
  expect(parseAgentMd(readAgent("reviewer-qa")).frontmatter.tools).toEqual(["Bash", "Read", "Grep", "Glob"]);
});

test("reviewer-correctness.md is the spec §7.3 exemplar verbatim (the fixture is that exemplar, F2/F6 lines included)", () => {
  // §7.3 is the template (Plan 3 Global Constraints), and the spec text carries the same two corrected
  // lines the fixture does — so this is now a straight identity check, not a patch-and-compare.
  expect(readAgent("reviewer-correctness")).toBe(FIXTURE);
});

test("reviewer agents: each Output section pins the must_fix id prefix its ids must use", () => {
  const prefixes = {
    "reviewer-correctness": "cf", "reviewer-security": "sec", "reviewer-architecture": "arch",
    "reviewer-spec-conformance": "spec", "reviewer-qa": "qa",
  };
  for (const [name, prefix] of Object.entries(prefixes)) {
    const { sections } = parseAgentMd(readAgent(name));
    const out = [...sections.entries()].find(([k]) => k.startsWith("Output"))[1];
    expect(out, name).toContain(`${prefix}1`);
  }
});

test("reviewer agents: the cold-read four refuse the builder's channels by name; the contract is not one of them", () => {
  const receivesOf = (name) => [...parseAgentMd(readAgent(name)).sections.entries()].find(([k]) => k.startsWith("You receive"))[1];

  for (const name of ["reviewer-correctness", "reviewer-security", "reviewer-architecture", "reviewer-qa"]) {
    const { sections } = parseAgentMd(readAgent(name));
    const entry = [...sections.entries()].find(([k]) => k.startsWith("You do NOT receive"));
    expect(entry, name).toBeDefined();
    expect(entry[0], name).toMatch(/찾아 읽지도 않는다/);
    expect(entry[1], name).toMatch(/PR description/);
  }
  // cold_read excludes what the builder wrote, not the plan: correctness/security/architecture judge the
  // code and are handed none of it; spec-conformance judges the contract; qa reproduces its done_when.
  for (const name of ["reviewer-correctness", "reviewer-security", "reviewer-architecture"]) {
    expect(receivesOf(name), name).not.toContain("handoffs.plan");
    expect(receivesOf(name), name).not.toContain("done_when");
  }

  const spec = parseAgentMd(readAgent("reviewer-spec-conformance"));
  const specReceives = [...spec.sections.entries()].find(([k]) => k.startsWith("You receive"))[1];
  expect(specReceives).toContain("handoffs.plan");
  expect(specReceives).toContain("done_when");
  expect(specReceives).toContain("files_expected");
  expect([...spec.sections.keys()].some((k) => k.startsWith("You do NOT receive"))).toBe(false);

  // §5.2.3: qa receives done_when, docs/TECHNICAL.md §Testing Strategy and the [test].smoke files — and
  // nothing of the plan beyond done_when, because scope is spec-conformance's call.
  const qaReceives = receivesOf("reviewer-qa");
  expect(qaReceives).toContain("handoffs.plan.done_when");
  expect(qaReceives).toContain("docs/TECHNICAL.md");
  expect(qaReceives).toContain("[test].smoke");
  expect(qaReceives).toContain("spec-conformance");
  const qaRefuses = [...parseAgentMd(readAgent("reviewer-qa")).sections.entries()].find(([k]) => k.startsWith("You do NOT receive"))[1];
  expect(qaRefuses).not.toContain("plan handoff");
});

test("reviewer-spec-conformance.md: defers structural justification to architecture and keeps round 1 independent", () => {
  const mustNot = [...parseAgentMd(readAgent("reviewer-spec-conformance")).sections.entries()].find(([k]) => k.startsWith("You must not"))[1];
  expect(mustNot).toContain("architecture");
  expect(mustNot).toContain("files_expected");
  expect(mustNot).toMatch(/라운드 1|R1/);
  expect(mustNot).toContain("다른 리뷰어의 판정");
});

// Task 6: the sweep. The per-task tests above pin what each role file says; this one is the gate that no
// agent template can be added (or edited) past §7.2 — `doctor checkAgents` runs exactly this lint on the
// installed copies, so a template that fails here fails the installed repo's doctor too.
test("every templates/factory/claude/agents/*.md lints clean, and the set is the 14 roles Plan 3+4 install (감사 M5로 loader는 빠졌다)", () => {
  const files = agentFiles();
  expect(files).toEqual([
    "factory-builder.md", "factory-retro.md", "factory-triage.md", "factory-verifier.md",
    "plan-architect.md", "plan-operator.md", "plan-product-advocate.md", "plan-skeptic.md", "plan-synthesizer.md",
    "reviewer-architecture.md", "reviewer-correctness.md", "reviewer-qa.md", "reviewer-security.md",
    "reviewer-spec-conformance.md",
  ]);
  for (const f of files) {
    const name = f.replace(/\.md$/, "");
    expect(lintAgentMd(readAgent(name), { expectedName: name }), f).toEqual([]);
  }
});

test("reviewer-security.md / reviewer-architecture.md / reviewer-spec-conformance.md / reviewer-qa.md carry their own Lens", () => {
  const lens = (name) => [...parseAgentMd(readAgent(name)).sections.entries()].find(([k]) => k.startsWith("Lens"))[1];
  const sec = lens("reviewer-security");
  for (const s of ["신뢰 경계", "인가", "시크릿", "SSRF", "traversal", "load_bearing"]) expect(sec, s).toContain(s);
  const arch = lens("reviewer-architecture");
  for (const s of ["TECHNICAL.md", "중복", "공개 API", "마이그레이션", "files_expected"]) expect(arch, s).toContain(s);
  // scope is spec-conformance's call, not architecture's
  expect(arch).toContain("spec-conformance");
  const conf = lens("reviewer-spec-conformance");
  // KTB-42 — 증거의 이름이 바뀌었다: `[evidence].qa_artifacts`(디렉터리)에서 매니페스트(계약)로.
  for (const s of ["done_when", "files_expected", "non_goals", "must_approve_explicitly", "manifest.json"]) expect(conf, s).toContain(s);
  const qa = lens("reviewer-qa");
  for (const s of [".factory/out/qa/", ".factory/scenarios/", "Design Intent"]) expect(qa, s).toContain(s);
  // F3: MCP 없이 Bash로 브라우저를 몬다는 사실과, app_start가 비어 있을 때의 대체 경로를 렌즈가 말한다
  expect(qa).toContain("npx playwright");
  expect(qa).toContain("[test.env].app_start");
});

// ── F3: 증거 디렉터리는 qa만 쓴다 ────────────────────────────────────────────────────────────
test("reviewer-qa.md says .factory/out/qa/ is the one writable path, and spec-conformance scopes the evidence rule to a roster with qa", () => {
  const receives = (name) => [...parseAgentMd(readAgent(name)).sections.entries()].find(([k]) => k.startsWith("You receive"))[1];
  const qaReceives = receives("reviewer-qa");
  expect(qaReceives).toContain(".factory/out/qa/");
  expect(qaReceives).toMatch(/쓸 수 있|writable/);

  // "증거가 없으면 발견" 규칙은 유지하되, qa가 로스터에 있을 때로 한정한다 — docs tier에는 qa가 없다.
  const conf = [...parseAgentMd(readAgent("reviewer-spec-conformance")).sections.entries()].find(([k]) => k.startsWith("Lens"))[1];
  expect(conf).toContain("manifest.json");      // KTB-42: 판정의 대상은 디렉터리가 아니라 매니페스트다
  expect(conf).toContain("reject");             // 규칙 자체는 그대로다
  expect(conf).toMatch(/로스터/);                // 다만 tier 로스터에 qa가 있을 때만
  expect(conf).toContain("spec-evidence-missing");   // 그리고 거부는 **id를 부른다**
});

// ── Plan 4 Task 5: factory-retro — 쓰기 금지 역할이 하나 늘었다 ────────────────────────────────
test("factory-retro.md: opus, read-only tools, deny-all-writes hook covering Bash", () => {
  const { frontmatter } = parseAgentMd(readAgent("factory-retro"));
  expect(frontmatter.name).toBe("factory-retro");
  expect(frontmatter.model).toBe("opus");
  expect(frontmatter.tools).toEqual(["Read", "Grep", "Glob"]);
  expect(frontmatter.hooks.PreToolUse[0].matcher).toBe("Edit|Write|MultiEdit|NotebookEdit|Bash");
  expect(frontmatter.hooks.PreToolUse[0].hooks[0].command).toContain("deny-all-writes.sh");
});

// retro는 lessons·예시·제안을 *제안*할 뿐 아무것도 쓰지 않는다(P4-R4) — 훅 규칙 목록에 들어 있지 않으면
// 언젠가 누가 훅을 지워도 lint가 통과한다.
test("lintAgentMd: factory-retro is a write-forbidden role — dropping its hook is a deny-hook violation", () => {
  const text = readAgent("factory-retro");
  expect(lintAgentMd(text, { expectedName: "factory-retro" })).toEqual([]);
  const noHook = text.replace(/hooks:\n  PreToolUse:\n[\s\S]*?deny-all-writes\.sh \}\]\n/, "");
  expect(noHook).not.toContain("deny-all-writes.sh");
  expect(lintAgentMd(noHook, { expectedName: "factory-retro" })).toEqual([{ rule: "deny-hook", msg: expect.any(String) }]);
});

test("factory-retro.md Lens carries the adoption rules L1 will later count (§8.4 minimum evidence windows)", () => {
  const { sections } = parseAgentMd(readAgent("factory-retro"));
  const lens = [...sections.entries()].find(([k]) => k.startsWith("Lens"))[1];
  const bullets = lens.split("\n").filter((l) => /^\s*(\d+\.|-)\s/.test(l));
  expect(bullets.length).toBeGreaterThanOrEqual(6);
  for (const s of ["evidence_runs", "gate", "role-new", "20", "삭제"]) expect(lens, s).toContain(s);
  // "무엇이 이걸 더 일찍 잡았겠는가" + "어느 층(prompt → lesson → gate)" — §8.2가 retro에 요구하는 두 질문
  expect(lens).toMatch(/더 일찍|earlier/);
  expect(lens).toMatch(/prompt → lesson → gate/);

  const mustNot = [...sections.entries()].find(([k]) => k.startsWith("You must not"))[1];
  expect(mustNot).toMatch(/지어낸|지어내|invent/);
  expect(mustNot).toMatch(/Lens/);          // Lens 수정 제안은 lesson이 아니라 제안 PR이다
  expect(mustNot).toMatch(/코드|code/);      // 코드는 건드리지 않는다

  const output = [...sections.entries()].find(([k]) => k.startsWith("Output"))[1];
  for (const f of ["period", "lessons", "examples", "perspectives", "harness", "proposals", "summary"]) {
    expect(output, f).toContain(f);
  }
});
