import { test, expect } from "vitest";
import { applyLessons, citedLessonIds, LESSON_CITATION_RE } from "../lib/retro/lessons.js";
import { lessonsFormat } from "../lib/integrity.js";

const HEADER = (role, max) => `<!-- factory-lessons:v1 role=${role} max=${max} -->\n<!-- retro 잡이 다크로 append한다. -->\n`;

// ── 외부 감사 2026-09-14 M11: 인용 카운터가 한 번도 올라간 적이 없었다 ────────────────────

test("citedLessonIds reads the `lesson:<id>` marker out of a verdict, once per id", () => {
  expect(citedLessonIds("must_fix: lesson:L-2026-09-12-01 says check the parser's default timezone")).toEqual(["L-2026-09-12-01"]);
  expect(citedLessonIds("lesson:L-2026-09-12-01 … and again lesson:L-2026-09-12-01, plus lesson:L-2026-09-11-07"))
    .toEqual(["L-2026-09-12-01", "L-2026-09-11-07"]);
  expect(citedLessonIds("no marker here")).toEqual([]);
  expect(citedLessonIds("lesson:L-2026-13-99")).toEqual([]);           // id 형식이 아니면 인용이 아니다
  expect(citedLessonIds(null)).toEqual([]);
  expect(LESSON_CITATION_RE.source).toContain("lesson:");
});

test("citations bump 인용 in place, leave everything else byte-identical, and stay integrity-clean", () => {
  const text = `${HEADER("reviewer-correctness", 30)}- [L-2026-09-11-01] 첫째\n  근거: runs/1.md, runs/2.md. 인용: 2회.\n- [L-2026-09-11-02] 둘째\n  근거: runs/3.md, runs/4.md. 인용: 0회.\n`;
  const r = applyLessons({ text, today: "2026-09-12", citations: { "L-2026-09-11-01": 3, "L-2026-09-99-99": 5 } });
  expect(r.cited).toEqual([{ id: "L-2026-09-11-01", from: 2, to: 5 }]);
  expect(r.text).toContain("- [L-2026-09-11-01] 첫째\n  근거: runs/1.md, runs/2.md. 인용: 5회.");
  expect(r.text).toContain("- [L-2026-09-11-02] 둘째\n  근거: runs/3.md, runs/4.md. 인용: 0회.");
  expect(lessonsFormat("f.md", r.text)).toEqual([]);
});

test("no citations and no adoptions → the file comes back byte-for-byte", () => {
  const text = `${HEADER("r", 30)}- [L-2026-09-11-01] 첫째\n  근거: runs/1.md, runs/2.md. 인용: 0회.\n`;
  const r = applyLessons({ text, today: "2026-09-12", citations: { "L-9999-01-01-01": 4 } });
  expect(r.text).toBe(text);
  expect(r.cited).toEqual([]);
});

test("an entry with no 인용 counter gets one rather than being silently skipped", () => {
  const text = `${HEADER("r", 30)}- [L-2026-09-11-01] 첫째\n  근거: runs/1.md, runs/2.md.\n`;
  const r = applyLessons({ text, today: "2026-09-12", citations: { "L-2026-09-11-01": 1 } });
  expect(r.cited).toEqual([{ id: "L-2026-09-11-01", from: 0, to: 1 }]);
  expect(r.text).toContain("근거: runs/1.md, runs/2.md. 인용: 1회.");
  expect(lessonsFormat("f.md", r.text)).toEqual([]);
});

test("retirement order: never-cited first (oldest of those), and a cited lesson only when nothing else is left", () => {
  const entry = (id, cites) => `- [${id}] ${id}\n  근거: runs/1.md, runs/2.md. 인용: ${cites}회.\n`;
  // max 3: 가장 오래된 것은 -01(인용 4회), 인용 0회인 것은 그보다 새로운 -02다.
  const text = `${HEADER("r", 3)}${entry("L-2026-09-01-01", 4)}${entry("L-2026-09-02-01", 0)}${entry("L-2026-09-03-01", 1)}`;
  const r = applyLessons({ text, today: "2026-09-12", adopted: [{ text: "new", evidence_runs: [9, 10] }] });
  expect(r.evicted).toEqual(["L-2026-09-02-01"]);                      // 나이가 아니라 **인용 0회**가 먼저다
  // 인용 0회가 하나도 없으면 그때서야 가장 오래된 인용 항목이 나간다 — 자리는 유한하다.
  const text2 = `${HEADER("r", 2)}${entry("L-2026-09-01-01", 4)}${entry("L-2026-09-03-01", 1)}`;
  const r2 = applyLessons({ text: text2, today: "2026-09-12", adopted: [{ text: "new", evidence_runs: [9, 10] }] });
  expect(r2.evicted).toEqual(["L-2026-09-01-01"]);
  expect(r2.added).toHaveLength(1);
});

test("citations counted this round protect a lesson from being retired in the same round", () => {
  const entry = (id, cites) => `- [${id}] ${id}\n  근거: runs/1.md, runs/2.md. 인용: ${cites}회.\n`;
  const text = `${HEADER("r", 2)}${entry("L-2026-09-01-01", 0)}${entry("L-2026-09-02-01", 0)}`;
  const r = applyLessons({ text, today: "2026-09-12", adopted: [{ text: "new", evidence_runs: [9, 10] }], citations: { "L-2026-09-01-01": 1 } });
  expect(r.evicted).toEqual(["L-2026-09-02-01"]);                      // 방금 인용된 것은 살아남는다
  expect(r.cited).toEqual([{ id: "L-2026-09-01-01", from: 0, to: 1 }]);
});

test("adopts a candidate with >=2 distinct evidence runs; entry passes integrity's lessonsFormat", () => {
  const text = HEADER("reviewer-correctness", 30);
  const { text: out, added, rejected, evicted } = applyLessons({
    text, today: "2026-09-12",
    adopted: [{ text: "타임존 비교는 파싱 함수의 기본 타임존을 확인한다.", evidence_runs: [97, 104] }],
  });
  expect(added).toEqual([{ id: "L-2026-09-12-01", text: "타임존 비교는 파싱 함수의 기본 타임존을 확인한다." }]);
  expect(rejected).toEqual([]);
  expect(evicted).toEqual([]);
  expect(out).toContain("- [L-2026-09-12-01] 타임존 비교는 파싱 함수의 기본 타임존을 확인한다.\n  근거: runs/97.md, runs/104.md. 인용: 0회.");
  expect(lessonsFormat("f.md", out)).toEqual([]);
});

test("id numbering continues after the highest existing NN for today, independent of other dates", () => {
  const text = `${HEADER("r", 30)}- [L-2026-09-11-05] old day\n  근거: runs/1.md, runs/2.md. 인용: 1회.\n- [L-2026-09-12-01] today one\n  근거: runs/3.md, runs/4.md. 인용: 0회.\n`;
  const { added } = applyLessons({
    text, today: "2026-09-12",
    adopted: [{ text: "new one", evidence_runs: [5, 6] }, { text: "new two", evidence_runs: [7, 8] }],
  });
  expect(added.map((a) => a.id)).toEqual(["L-2026-09-12-02", "L-2026-09-12-03"]);
});

test("rejects adoption with fewer than minEvidence distinct issue numbers (duplicate issue numbers do not count twice)", () => {
  const text = HEADER("r", 30);
  const { added, rejected } = applyLessons({
    text, today: "2026-09-12",
    adopted: [{ text: "one run only", evidence_runs: [1, 1, 1] }],
  });
  expect(added).toEqual([]);
  expect(rejected).toEqual([{ text: "one run only", reason: "insufficient-evidence" }]);
});

test("custom minEvidence is honored", () => {
  const text = HEADER("r", 30);
  const { added, rejected } = applyLessons({
    text, today: "2026-09-12", minEvidence: 3,
    adopted: [{ text: "needs three", evidence_runs: [1, 2] }],
  });
  expect(rejected).toEqual([{ text: "needs three", reason: "insufficient-evidence" }]);
  expect(added).toEqual([]);
});

test("rejects exact-trimmed duplicate text against an existing entry", () => {
  const text = `${HEADER("r", 30)}- [L-2026-09-01-01] 이미 있는 항목\n  근거: runs/1.md, runs/2.md. 인용: 0회.\n`;
  const { added, rejected } = applyLessons({
    text, today: "2026-09-12",
    adopted: [{ text: "  이미 있는 항목  ", evidence_runs: [3, 4] }],
  });
  expect(added).toEqual([]);
  expect(rejected).toEqual([{ text: "  이미 있는 항목  ", reason: "duplicate" }]);
});

test("rejects a duplicate within the same batch (second occurrence)", () => {
  const text = HEADER("r", 30);
  const { added, rejected } = applyLessons({
    text, today: "2026-09-12",
    adopted: [
      { text: "같은 문장", evidence_runs: [1, 2] },
      { text: "같은 문장", evidence_runs: [3, 4] },
    ],
  });
  expect(added).toHaveLength(1);
  expect(rejected).toEqual([{ text: "같은 문장", reason: "duplicate" }]);
});

test("evicts the oldest zero-citation entry to make room when over max, and records the eviction", () => {
  const text = `${HEADER("r", 2)}- [L-2026-09-01-01] old zero cite\n  근거: runs/1.md, runs/2.md. 인용: 0회.\n- [L-2026-09-05-02] newer zero cite\n  근거: runs/3.md, runs/4.md. 인용: 0회.\n`;
  const { text: out, added, evicted, rejected } = applyLessons({
    text, today: "2026-09-12",
    adopted: [{ text: "new adoption", evidence_runs: [5, 6] }],
  });
  expect(evicted).toEqual(["L-2026-09-01-01"]);
  expect(added).toEqual([{ id: "L-2026-09-12-01", text: "new adoption" }]);
  expect(rejected).toEqual([]);
  expect(out).not.toContain("old zero cite");
  expect(out).toContain("newer zero cite");
  expect(out).toContain("new adoption");
  expect(lessonsFormat("f.md", out)).toEqual([]);
  const entryLines = out.split("\n").filter((l) => l.startsWith("- "));
  expect(entryLines).toHaveLength(2);
});

/**
 * 감사 M11 — **이 판정은 뒤집혔다.** 예전 규칙은 "인용된 항목은 절대 evict하지 않는다"였고, 그래서
 * 상한에 닿은 파일은 새 교훈을 영원히 받지 못했다(전부 'max' 거부). 인용 카운터가 한 번도 오르지
 * 않던 동안에는 이 규칙이 실제로 발동한 적이 없어 그 동결이 보이지 않았다. 이제 순서는
 * "인용 0회 먼저, 그 다음 나이"이고, 인용된 항목도 **마지막 순서로** 은퇴한다.
 */
test("a cited entry retires only when nothing uncited is left — the file never freezes at max", () => {
  const text = `${HEADER("r", 1)}- [L-2026-09-01-01] cited\n  근거: runs/1.md, runs/2.md. 인용: 3회.\n`;
  const { text: out, added, evicted, rejected } = applyLessons({
    text, today: "2026-09-12",
    adopted: [{ text: "the newer lesson", evidence_runs: [5, 6] }],
  });
  expect(evicted).toEqual(["L-2026-09-01-01"]);
  expect(added).toEqual([{ id: "L-2026-09-12-01", text: "the newer lesson" }]);
  expect(rejected).toEqual([]);
  expect(out).toContain("the newer lesson");
  expect(lessonsFormat("f.md", out)).toEqual([]);
});

test("once eviction capacity is exhausted, later adoptions in the same batch still reject with 'max'", () => {
  const text = `${HEADER("r", 1)}- [L-2026-09-01-01] cited\n  근거: runs/1.md, runs/2.md. 인용: 2회.\n`;
  const { added, rejected, evicted } = applyLessons({
    text, today: "2026-09-12",
    adopted: [
      { text: "first new", evidence_runs: [5, 6] },
      { text: "second new", evidence_runs: [7, 8] },
    ],
  });
  // 첫 채택이 유일한 자리를 쓰고 나면, 남은 것은 이번 호출에서 추가된 항목뿐이라 evict 대상이 없다.
  expect(added).toEqual([{ id: "L-2026-09-12-01", text: "first new" }]);
  expect(evicted).toEqual(["L-2026-09-01-01"]);
  expect(rejected).toEqual([{ text: "second new", reason: "max" }]);
});

test("no adoptions and nothing evicted → text is returned byte-identical to the input", () => {
  const text = `${HEADER("r", 30)}- [L-2026-09-01-01] entry\n  근거: runs/1.md, runs/2.md. 인용: 1회.\n`;
  const { text: out, added, rejected, evicted } = applyLessons({ text, today: "2026-09-12", adopted: [] });
  expect(out).toBe(text);
  expect(added).toEqual([]);
  expect(rejected).toEqual([]);
  expect(evicted).toEqual([]);
});

test("appending to a header-only file (no entries yet) produces a valid lessons file", () => {
  const text = "<!-- factory-lessons:v1 role=r max=5 -->";
  const { text: out } = applyLessons({ text, today: "2026-09-12", adopted: [{ text: "first entry", evidence_runs: [1, 2] }] });
  expect(out).toBe("<!-- factory-lessons:v1 role=r max=5 -->\n- [L-2026-09-12-01] first entry\n  근거: runs/1.md, runs/2.md. 인용: 0회.\n");
  expect(lessonsFormat("f.md", out)).toEqual([]);
});

test("regression: an entry added earlier in this same call is never evicted to make room for a later one in the same call", () => {
  const text = HEADER("r", 1); // max=1, no pre-existing entries
  const { text: out, added, rejected, evicted } = applyLessons({
    text, today: "2026-09-12",
    adopted: [
      { text: "first adoption", evidence_runs: [1, 2] },
      { text: "second adoption", evidence_runs: [3, 4] },
    ],
  });
  // the first adoption fills the only slot; the second must be rejected with 'max', NOT evict the first.
  expect(added).toEqual([{ id: "L-2026-09-12-01", text: "first adoption" }]);
  expect(rejected).toEqual([{ text: "second adoption", reason: "max" }]);
  expect(evicted).toEqual([]);
  expect(out).toContain("first adoption");
  expect(out).not.toContain("second adoption");
  expect(lessonsFormat("f.md", out)).toEqual([]);
});

test("regression: eviction is atomic — if not enough evictable entries exist to make room, NOTHING is evicted (no partial eviction before the reject)", () => {
  /*
   * 감사 M11 이후 evict 불가인 것은 **이번 호출에서 추가된 항목**뿐이다(인용 여부는 순서만 정한다).
   * 그래서 원자성을 재려면 자리가 그 항목들로 차 있어야 한다: max=2, 기존 항목 1개, 채택 3건 —
   * 첫 둘이 자리를 채우고(하나는 evict), 셋째는 evict할 대상이 isNew뿐이라 'max'로 거부된다.
   * 그때 evict는 **추가로 일어나지 않는다**(부분 evict 후 거부는 자리를 버리는 짓이다).
   */
  const text = `${HEADER("r", 2)}- [L-2026-08-01-01] old one\n  근거: runs/1.md, runs/2.md. 인용: 0회.\n`;
  const { text: out, added, rejected, evicted } = applyLessons({
    text, today: "2026-09-12",
    adopted: [
      { text: "first new", evidence_runs: [3, 4] },
      { text: "second new", evidence_runs: [5, 6] },
      { text: "third new", evidence_runs: [7, 8] },
    ],
  });
  expect(added.map((a) => a.text)).toEqual(["first new", "second new"]);
  expect(evicted).toEqual(["L-2026-08-01-01"]);                        // 두 번째 채택이 쓴 자리 하나뿐
  expect(rejected).toEqual([{ text: "third new", reason: "max" }]);
  expect(out).not.toContain("third new");
  expect(out).not.toContain("old one");
  expect(lessonsFormat("f.md", out)).toEqual([]);
});

test("regression: NN would exceed 99 for today → rejected with 'id-space', no invalid id is ever emitted", () => {
  const text = `${HEADER("r", 200)}- [L-2026-09-12-99] filler\n  근거: runs/1.md, runs/2.md. 인용: 0회.\n`;
  const { text: out, added, rejected, evicted } = applyLessons({
    text, today: "2026-09-12",
    adopted: [{ text: "one hundredth entry today", evidence_runs: [3, 4] }],
  });
  expect(added).toEqual([]);
  expect(evicted).toEqual([]);
  expect(rejected).toEqual([{ text: "one hundredth entry today", reason: "id-space" }]);
  expect(out).toBe(text);
  expect(out).not.toMatch(/L-2026-09-12-100/);
});

test("added[] always matches exactly what landed in the returned text, across a mixed batch (duplicate + insufficient + eviction + success)", () => {
  const text = `${HEADER("r", 2)}- [L-2026-08-01-01] old zero cite\n  근거: runs/1.md, runs/2.md. 인용: 0회.\n- [L-2026-08-05-02] cited\n  근거: runs/3.md, runs/4.md. 인용: 1회.\n`;
  const { text: out, added, rejected, evicted } = applyLessons({
    text, today: "2026-09-12",
    adopted: [
      { text: "cited", evidence_runs: [5, 6] }, // duplicate of existing text
      { text: "not enough evidence", evidence_runs: [7] }, // insufficient-evidence
      { text: "brand new lesson", evidence_runs: [8, 9] }, // needs eviction of the old zero-cite entry
    ],
  });
  expect(rejected).toEqual([
    { text: "cited", reason: "duplicate" },
    { text: "not enough evidence", reason: "insufficient-evidence" },
  ]);
  expect(evicted).toEqual(["L-2026-08-01-01"]);
  expect(added).toEqual([{ id: "L-2026-09-12-01", text: "brand new lesson" }]);
  const entryLines = out.split("\n").filter((l) => l.startsWith("- "));
  expect(entryLines).toEqual(["- [L-2026-08-05-02] cited", "- [L-2026-09-12-01] brand new lesson"]);
  for (const a of added) expect(out).toContain(`- [${a.id}] ${a.text}`);
  expect(lessonsFormat("f.md", out)).toEqual([]);
});

// ── F4(최종 리뷰): 에이전트 텍스트 정규화 ────────────────────────────────
// `retro.v1`의 `text`는 그냥 문자열이라 에이전트가 여러 줄을 담을 수 있다. 그 줄바꿈이 그대로 파일에
// 들어가면 항목이 `- [L-…] <문장>` + `근거:` 형식을 깨고(§7.4) integrity가 PR을 RED로 만들어 다크
// 머지가 영원히 실패한다 — 형식은 이 모듈이 보장한다.

test("a multi-line lesson becomes one well-formed line that passes lessonsFormat", () => {
  const text = HEADER("r", 30);
  const multi = "Promise.all의 부분 실패를 본다:\n\n  - 하나가 reject하면 나머지 결과가 버려진다\n\t확인: allSettled로 바꾸고 각 결과를 검사한다";
  const { text: out, added, rejected } = applyLessons({ text, today: "2026-09-12", adopted: [{ text: multi, evidence_runs: [1, 2] }] });
  expect(rejected).toEqual([]);
  expect(added).toEqual([{ id: "L-2026-09-12-01", text: "Promise.all의 부분 실패를 본다: - 하나가 reject하면 나머지 결과가 버려진다 확인: allSettled로 바꾸고 각 결과를 검사한다" }]);
  // 항목 줄은 정확히 하나고, 그 다음 줄이 근거다
  const lines = out.split("\n");
  const idx = lines.findIndex((l) => l.startsWith("- [L-2026-09-12-01]"));
  expect(lines[idx + 1]).toBe("  근거: runs/1.md, runs/2.md. 인용: 0회.");
  expect(lines.filter((l) => l.startsWith("- ["))).toHaveLength(1);
  expect(lessonsFormat("f.md", out)).toEqual([]);
});

test("text is capped at 300 chars with a single '…', and the cap is deterministic (same input → same duplicate verdict)", () => {
  const text = HEADER("r", 30);
  const long = `${"가".repeat(400)}`;
  const { text: out, added } = applyLessons({ text, today: "2026-09-12", adopted: [{ text: long, evidence_runs: [1, 2] }] });
  expect(added[0].text).toHaveLength(300);
  expect(added[0].text.endsWith("…")).toBe(true);
  expect(lessonsFormat("f.md", out)).toEqual([]);
  // 자르기가 결정적이므로, 같은 긴 텍스트를 다시 제안하면 중복으로 거부된다
  const second = applyLessons({ text: out, today: "2026-09-12", adopted: [{ text: long, evidence_runs: [3, 4] }] });
  expect(second.added).toEqual([]);
  expect(second.rejected).toEqual([{ text: long, reason: "duplicate" }]);
});

test("empty or whitespace-only text is rejected, never written as a headless entry", () => {
  const text = HEADER("r", 30);
  const { text: out, added, rejected } = applyLessons({ text, today: "2026-09-12", adopted: [{ text: "  \n\t ", evidence_runs: [1, 2] }, { text: undefined, evidence_runs: [3, 4] }] });
  expect(added).toEqual([]);
  expect(rejected).toEqual([{ text: "  \n\t ", reason: "empty" }, { text: undefined, reason: "empty" }]);
  expect(out).toBe(text);
});

test("eviction removes the *normalised* text from the duplicate set — an evicted lesson can be re-adopted in the same batch", () => {
  // 파일에 이미 있던 항목의 문장은 정규화 이전에 쓰였을 수 있다(이중 공백) — 집합에는 정규화된 형태가
  // 들어 있으므로 evict할 때도 정규화된 형태로 지워야 한다. 원문으로 지우면 evict된 문장이 집합에 남아
  // 같은 배치의 재채택이 엉뚱하게 'duplicate'로 거부된다.
  const text = `${HEADER("r", 2)}- [L-2026-08-01-01] dup  text\n  근거: runs/1.md, runs/2.md. 인용: 0회.\n- [L-2026-08-02-01] filler\n  근거: runs/3.md, runs/4.md. 인용: 0회.\n`;
  const { text: out, added, rejected, evicted } = applyLessons({
    text, today: "2026-09-12",
    adopted: [{ text: "fresh", evidence_runs: [5, 6] }, { text: "dup text", evidence_runs: [7, 8] }],
  });
  expect(rejected).toEqual([]);
  expect(evicted).toEqual(["L-2026-08-01-01", "L-2026-08-02-01"]);
  expect(added).toEqual([{ id: "L-2026-09-12-01", text: "fresh" }, { id: "L-2026-09-12-02", text: "dup text" }]);
  expect(out.split("\n").filter((l) => l.startsWith("- ["))).toEqual(["- [L-2026-09-12-01] fresh", "- [L-2026-09-12-02] dup text"]);
  expect(lessonsFormat("f.md", out)).toEqual([]);
});
