import { test, expect } from "vitest";
import { announceFailure, errorAnnotation, stepSummary } from "../lib/gha.js";

/**
 * #36 item 5 — **한 번의 실패는 한 줄의 주석이다.**
 *
 * 1.4.0 도그푸드에서 `announceFailure`의 호출자(`bin/retro.js`)는 실패 하나와 **운영 안내** 한 줄을
 * 같은 `reasons` 배열에 담았다. 그러면 러너의 잡 페이지에는 빨간 `::error::`가 **둘** 뜨고(사람은
 * 고장이 두 개라고 읽는다), 스텝 요약에는 안내가 `- **failed:**`로 적힌다 — "run `factory doctor`"가
 * 실패로 렌더링된다. 안내는 실패가 아니라 **다음 할 일**이다.
 */
const captured = () => {
  const out = [];
  const summary = [];
  return {
    out, summary,
    sink: { env: { GITHUB_STEP_SUMMARY: "/tmp/does-not-matter" }, out: (l) => out.push(l), append: (_p, t) => summary.push(t), log: () => {} },
    md: () => summary.join(""),
  };
};

test("test_36_record_and_annotation_wording: one failure + operator guidance is one ::error:: line, and the guidance is not rendered as a failure (gha wording)", () => {
  const c = captured();
  const n = announceFailure({
    title: "factory-retro",
    heading: "factory-retro — feedback routing",
    reasons: ["upstream route failed — HTTP 403 Resource not accessible by integration (#45)"],
    guidance: "the retro itself is unaffected (fail-safe); run `factory doctor` and check `factory.upstream` — the factory token needs `issues:write` on the upstream repo",
    ...c.sink,
  });

  // ① 실패 하나 = 주석 **한 줄**. 안내는 그 줄에 붙지, 두 번째 빨간 줄을 만들지 않는다.
  expect(n).toBe(1);
  const errors = c.out.filter((l) => l.startsWith("::error"));
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("HTTP 403");
  // 안내는 **새 주석을 만들지 않는다** — 첫 주석에 붙어 나가고, 워크플로 명령은 한 줄로 남는다.
  expect(errors[0]).toContain("factory doctor");
  expect(errors[0]).not.toMatch(/\r?\n/);

  // ② 요약에서 실패로 렌더링되는 것은 실패뿐이다 — 안내는 실리되 다른 이름으로 실린다.
  const md = c.md();
  expect(md).toContain("- **failed:** upstream route failed — HTTP 403 Resource not accessible by integration (#45)");
  expect(md).toContain("factory doctor");
  expect(md.split("\n").filter((l) => l.includes("**failed:**"))).toHaveLength(1);
  expect(md.split("\n").find((l) => l.includes("factory doctor"))).not.toContain("**failed:**");
});

test("test_36_record_and_annotation_wording: guidance alone announces nothing (gha wording)", () => {
  const c = captured();
  expect(announceFailure({ title: "factory-health", reasons: [], guidance: "run `factory doctor`", ...c.sink })).toBe(0);
  expect(c.out).toEqual([]);
  expect(c.summary).toEqual([]);
});

test("test_36_record_and_annotation_wording: no guidance keeps the old shape exactly (gha wording)", () => {
  const c = captured();
  expect(announceFailure({ title: "t", reasons: ["a", "b"], ...c.sink })).toBe(2);
  expect(c.out).toEqual([errorAnnotation("t", "a", { out: () => {} }), errorAnnotation("t", "b", { out: () => {} })]);
  expect(c.md()).toBe("## t\n\n- **failed:** a\n- **failed:** b\n");
});

test("test_36_record_and_annotation_wording: stepSummary stays a no-op off the runner (gha wording)", () => {
  expect(stepSummary("x", { env: {}, append: () => { throw new Error("must not be called"); } })).toBe(false);
});
