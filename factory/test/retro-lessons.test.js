import { test, expect } from "vitest";
import { applyLessons } from "../lib/retro/lessons.js";
import { lessonsFormat } from "../lib/integrity.js";

const HEADER = (role, max) => `<!-- factory-lessons:v1 role=${role} max=${max} -->\n<!-- retro 잡이 다크로 append한다. -->\n`;

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

test("cited entries (인용 > 0) are never evicted — max overflow with no evictable entry rejects with reason 'max'", () => {
  const text = `${HEADER("r", 1)}- [L-2026-09-01-01] cited\n  근거: runs/1.md, runs/2.md. 인용: 3회.\n`;
  const { text: out, added, evicted, rejected } = applyLessons({
    text, today: "2026-09-12",
    adopted: [{ text: "cannot fit", evidence_runs: [5, 6] }],
  });
  expect(evicted).toEqual([]);
  expect(added).toEqual([]);
  expect(rejected).toEqual([{ text: "cannot fit", reason: "max" }]);
  expect(out).toBe(text);
});

test("once eviction capacity is exhausted, later adoptions in the same batch also reject with 'max'", () => {
  const text = `${HEADER("r", 1)}- [L-2026-09-01-01] cited\n  근거: runs/1.md, runs/2.md. 인용: 2회.\n`;
  const { added, rejected } = applyLessons({
    text, today: "2026-09-12",
    adopted: [
      { text: "first new", evidence_runs: [5, 6] },
      { text: "second new", evidence_runs: [7, 8] },
    ],
  });
  expect(added).toEqual([]);
  expect(rejected).toEqual([
    { text: "first new", reason: "max" },
    { text: "second new", reason: "max" },
  ]);
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
