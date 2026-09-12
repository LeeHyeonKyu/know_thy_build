import { test, expect } from "vitest";
import { parseRetroState, renderRetroState, nextN, shouldRunFull, RETRO_STATE_MARKER } from "../lib/retro/state.js";

const defaultState = (n) => ({
  cursor: { last_retro_at: null, last_record_offsets: {} },
  merges_since: 0,
  n,
  history: [],
  candidates: { lessons: [], examples: [], flaky: [], needs_human: [] },
  stats: {},
});

test("parseRetroState: null/empty/markerless md → default state with charter initial N", () => {
  expect(parseRetroState(null, { initial: 3 })).toEqual(defaultState(3));
  expect(parseRetroState("", { initial: 3 })).toEqual(defaultState(3));
  expect(parseRetroState("# 아무 마크다운\n\n그냥 텍스트", { initial: 3 })).toEqual(defaultState(3));
  // initial 생략 시에도 안전하게 기본값을 쓴다
  expect(parseRetroState(undefined)).toEqual(defaultState(1));
});

test("renderRetroState → parseRetroState round-trips the full state", () => {
  const state = {
    cursor: { last_retro_at: "2026-09-08T00:00:00Z", last_record_offsets: { "123": 42 } },
    merges_since: 2,
    n: 5,
    history: [
      { at: "2026-08-01T00:00:00Z", yield: 0, n_before: 1, n_after: 2, needs_human_since: 0 },
      { at: "2026-09-08T00:00:00Z", yield: 1, n_before: 2, n_after: 2, needs_human_since: 1 },
    ],
    candidates: {
      lessons: [{ role: "reviewer-qa", text: "예시", evidence: ["runs/1.md", "runs/2.md"] }],
      examples: [],
      flaky: ["t::a"],
      needs_human: ["예산 초과"],
    },
    stats: { merged: 12, avg_review_rounds: 1.6 },
  };

  const md = renderRetroState(state, { statsTable: "| a | b |\n| --- | --- |\n| 1 | 2 |" });

  expect(md).toContain(RETRO_STATE_MARKER);
  expect(md).toContain("```json");
  expect(parseRetroState(md)).toEqual(state);
});

test("renderRetroState round-trips the default state too (n=1 first render before any retro)", () => {
  const state = defaultState(1);
  const md = renderRetroState(state);
  expect(parseRetroState(md)).toEqual(state);
});

test("parseRetroState: marker present but JSON fence is corrupt → throws (never silently resets history)", () => {
  const md = `# Retro State\n\n${RETRO_STATE_MARKER}\n\`\`\`json\n{ not valid json\n\`\`\`\n`;
  expect(() => parseRetroState(md)).toThrow();
});

test("parseRetroState: marker present but no json fence at all → throws", () => {
  const md = `# Retro State\n\n${RETRO_STATE_MARKER}\n(fence missing)\n`;
  expect(() => parseRetroState(md)).toThrow();
});

test("nextN: yield 0 → n*1.5 rounded", () => {
  expect(nextN(3, { yield: 0 }, { min: 1, max: 20 })).toBe(5); // round(4.5) = 5
  expect(nextN(4, { yield: 0 }, { min: 1, max: 20 })).toBe(6);
});

test("nextN: yield 1 or 2 → n unchanged", () => {
  expect(nextN(5, { yield: 1 }, { min: 1, max: 20 })).toBe(5);
  expect(nextN(5, { yield: 2 }, { min: 1, max: 20 })).toBe(5);
});

test("nextN: yield >= 3 → n*0.5 rounded", () => {
  expect(nextN(3, { yield: 3 }, { min: 1, max: 20 })).toBe(2); // round(1.5) = 2
  expect(nextN(9, { yield: 5 }, { min: 1, max: 20 })).toBe(5); // round(4.5) = 5
});

test("nextN: needsHumanSince >= 2 halves n even when yield is 1~2", () => {
  expect(nextN(9, { yield: 1, needsHumanSince: 2 }, { min: 1, max: 20 })).toBe(5);
  expect(nextN(9, { yield: 2, needsHumanSince: 3 }, { min: 1, max: 20 })).toBe(5);
});

test("nextN: clamps to [min, max]", () => {
  expect(nextN(15, { yield: 0 }, { min: 1, max: 20 })).toBe(20); // round(22.5)=23 clamped to 20
  expect(nextN(1, { yield: 3 }, { min: 1, max: 20 })).toBe(1); // round(0.5)=1(no lower than 1 anyway) but check min holds
  expect(nextN(2, { yield: 3 }, { min: 2, max: 20 })).toBe(2); // round(1)=1, clamped up to min 2
});

test("nextN: never drops below 1 even without an explicit min", () => {
  expect(nextN(1, { yield: 3 }, { max: 20 })).toBeGreaterThanOrEqual(1);
  expect(nextN(1, { yield: 3 }, {})).toBeGreaterThanOrEqual(1);
});

test("shouldRunFull: initial n=1 → the first merge is always full", () => {
  const state = defaultState(1);
  const { full, reason } = shouldRunFull({ state, retro: { every_merges: { initial: 1, min: 1, max: 20 } } });
  expect(full).toBe(true);
  expect(reason).toBe("merges_since+1 >= n");
});

test("shouldRunFull: n=3, merges_since=1 → light (not yet enough merges)", () => {
  const state = { ...defaultState(3), merges_since: 1 };
  const { full, reason } = shouldRunFull({ state, retro: { every_merges: { initial: 1, min: 1, max: 20 } } });
  expect(full).toBe(false);
  expect(reason).toBeTruthy();
});

test("shouldRunFull: force ignores merges_since/n entirely", () => {
  const state = { ...defaultState(20), merges_since: 0 };
  const { full, reason } = shouldRunFull({ state, retro: {}, force: true });
  expect(full).toBe(true);
  expect(reason).toBe("forced");
});
