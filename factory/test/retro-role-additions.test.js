import { test, expect } from "vitest";
import { applyRoleAdditions } from "../lib/retro/role-additions.js";

const SAMPLE = `---
name: reviewer-correctness
description: PR diff가 실제로 올바른지 판정한다
tools: Read, Grep, Glob, Bash
model: opus
---

## Purpose
이 변경이 의도한 대로 동작하는지 판정한다.

## Examples

### 좋은 발견
- "retry()가 idempotent하지 않은 POST /charge를 감싼다." — 위치·주장·근거·재현이 모두 있다.
- "새 테스트가 mock으로 항상 통과한다." — 테스트 정직성.

### 나쁜 발견 (이렇게 쓰지 않는다)
- "에러 처리를 개선하면 좋겠습니다." — 위치도 재현도 없다.
- "이벤트 소싱이 낫습니다." — 설계 논쟁.

## Perspectives
- **되돌리는 사람의 눈**: revert 시 무엇이 막는가
- **경계 사냥꾼**: 모든 비교 연산자 옆에 '같을 때'를 적어 본다
- **테스트 회의론자**: 테스트가 무엇을 단언했는지로 평가한다

## Lessons
Before reviewing, read \`.factory/lessons/reviewer-correctness.md\`.
`;

test("appends one bullet at the end of each target subsection/section, nothing else changes", () => {
  const { text, added, skipped } = applyRoleAdditions({
    text: SAMPLE,
    examples: [{ kind: "good", text: "새 좋은 발견" }, { kind: "bad", text: "새 나쁜 발견" }],
    perspectives: [{ text: "새 관점" }],
  });
  expect(skipped).toEqual([]);
  expect(added).toEqual([
    { section: "### 좋은 발견", text: "새 좋은 발견" },
    { section: "### 나쁜 발견", text: "새 나쁜 발견" },
    { section: "## Perspectives", text: "새 관점" },
  ]);
  expect(text).toContain('- "새 테스트가 mock으로 항상 통과한다." — 테스트 정직성.\n- 새 좋은 발견\n');
  expect(text).toContain('- "이벤트 소싱이 낫습니다." — 설계 논쟁.\n- 새 나쁜 발견\n');
  expect(text).toContain("- **테스트 회의론자**: 테스트가 무엇을 단언했는지로 평가한다\n- 새 관점\n");

  // removing exactly the added lines restores the original bytes
  const withoutAdded = text
    .split("\n")
    .filter((l) => l !== "- 새 좋은 발견" && l !== "- 새 나쁜 발견" && l !== "- 새 관점")
    .join("\n");
  expect(withoutAdded).toBe(SAMPLE);
});

test("never adds headers: a role file missing '## Perspectives' entirely skips with reason missing-section", () => {
  const noPerspectives = SAMPLE.replace(/## Perspectives[\s\S]*?\n\n## Lessons/, "## Lessons");
  const { text, added, skipped } = applyRoleAdditions({ text: noPerspectives, perspectives: [{ text: "x" }] });
  expect(added).toEqual([]);
  expect(skipped).toEqual([{ text: "x", reason: "missing-section" }]);
  expect(text).toBe(noPerspectives);
  expect(text).not.toContain("## Perspectives");
});

test("duplicate text (exact trim) is skipped, including a duplicate within the same batch", () => {
  const { added, skipped } = applyRoleAdditions({
    text: SAMPLE,
    examples: [
      { kind: "good", text: '  "retry()가 idempotent하지 않은 POST /charge를 감싼다." — 위치·주장·근거·재현이 모두 있다.  ' },
      { kind: "good", text: "새 항목" },
      { kind: "good", text: "새 항목" },
    ],
  });
  expect(added).toEqual([{ section: "### 좋은 발견", text: "새 항목" }]);
  expect(skipped).toEqual([
    { text: '  "retry()가 idempotent하지 않은 POST /charge를 감싼다." — 위치·주장·근거·재현이 모두 있다.  ', reason: "duplicate" },
    { text: "새 항목", reason: "duplicate" },
  ]);
});

test("caps overflow: once a subsection reaches its cap, further additions are skipped with reason max", () => {
  const { added, skipped } = applyRoleAdditions({
    text: SAMPLE,
    examples: [
      { kind: "good", text: "g1" }, { kind: "good", text: "g2" }, { kind: "good", text: "g3" },
      { kind: "good", text: "g4" }, { kind: "good", text: "g5" }, { kind: "good", text: "g6" },
    ],
    caps: { good: 4 }, // 2 existing + 2 more fit, rest overflow
  });
  expect(added.map((a) => a.text)).toEqual(["g1", "g2"]);
  expect(skipped).toEqual([
    { text: "g3", reason: "max" }, { text: "g4", reason: "max" }, { text: "g5", reason: "max" }, { text: "g6", reason: "max" },
  ]);
});

test("unknown kind is skipped with reason invalid-kind and never touches the file", () => {
  const { text, added, skipped } = applyRoleAdditions({ text: SAMPLE, examples: [{ kind: "ugly", text: "x" }] });
  expect(added).toEqual([]);
  expect(skipped).toEqual([{ text: "x", reason: "invalid-kind" }]);
  expect(text).toBe(SAMPLE);
});

test("no additions at all → output is byte-identical to input", () => {
  const { text, added, skipped } = applyRoleAdditions({ text: SAMPLE, examples: [], perspectives: [] });
  expect(text).toBe(SAMPLE);
  expect(added).toEqual([]);
  expect(skipped).toEqual([]);
});

test("regression: a decorated top-level '## ' header does not match — integrity's additive_only allowlist is literal, so top headers must match exactly", () => {
  const decorated = SAMPLE.replace("## Perspectives\n", "## Perspectives — 관점\n");
  const { text, added, skipped } = applyRoleAdditions({ text: decorated, perspectives: [{ text: "x" }] });
  expect(added).toEqual([]);
  expect(skipped).toEqual([{ text: "x", reason: "missing-section" }]);
  expect(text).toBe(decorated);
});

test("default caps match spec §8.1 (Examples 8/8, Perspectives 6) when caps is omitted", () => {
  const many = (n, kind) => Array.from({ length: n }, (_, i) => ({ kind, text: `item-${kind}-${i}` }));
  const { added, skipped } = applyRoleAdditions({ text: SAMPLE, examples: many(10, "good") });
  // 2 existing + 6 new fit to reach 8; 4 remaining overflow
  expect(added).toHaveLength(6);
  expect(skipped).toHaveLength(4);
  expect(skipped.every((s) => s.reason === "max")).toBe(true);
});

// ── F4(최종 리뷰): 에이전트 텍스트 정규화 ────────────────────────────────
// 항목은 `- <문장>` 한 줄이다. 개행이 섞이면 그 줄이 새 `## `/`### ` 헤더가 될 수 있고, integrity의
// additive_only는 "추가된 헤더"를 그 자체로 위반으로 본다 — 통과할 수 없는 diff를 만드는 셈이다.

const headers = (t) => t.split("\n").filter((l) => /^#{2,3} /.test(l));

test("an example text containing a markdown header collapses to one line — no new section header appears", () => {
  const evil = "좋은 발견의 예\n## Lens\n- 새 렌즈를 심는다";
  const { text, added, skipped } = applyRoleAdditions({ text: SAMPLE, examples: [{ kind: "good", text: evil }] });
  expect(skipped).toEqual([]);
  expect(added).toEqual([{ section: "### 좋은 발견", text: "좋은 발견의 예 ## Lens - 새 렌즈를 심는다" }]);
  // 추가된 줄은 정확히 하나이고 헤더 목록은 그대로다(additive_only의 "header added"가 걸리지 않는다)
  const before = SAMPLE.split("\n");
  const after = text.split("\n");
  expect(after).toHaveLength(before.length + 1);
  expect(headers(text)).toEqual(headers(SAMPLE));
  expect(text).toContain("- 좋은 발견의 예 ## Lens - 새 렌즈를 심는다\n");
});

test("text is capped at 300 chars with '…'; empty text is skipped, not appended as a bare bullet", () => {
  const { added } = applyRoleAdditions({ text: SAMPLE, perspectives: [{ text: "관".repeat(400) }] });
  expect(added[0].text).toHaveLength(300);
  expect(added[0].text.endsWith("…")).toBe(true);
  const { text, added: none, skipped } = applyRoleAdditions({ text: SAMPLE, examples: [{ kind: "bad", text: "\n \t\n" }], perspectives: [{ text: "" }] });
  expect(none).toEqual([]);
  expect(skipped).toEqual([{ text: "\n \t\n", reason: "empty" }, { text: "", reason: "empty" }]);
  expect(text).toBe(SAMPLE);
});
