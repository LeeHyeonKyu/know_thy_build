import { test, expect, vi } from "vitest";
import {
  accumulateStats, applyMutation, collectIssues, distinctRuns, earliestRecordAt, emptyCandidates, gapTitle,
  retireCandidates, retroUsageOf, roleFileMap, runRetro, splitDarkFiles, stampOf, statsTable, todayOf, ymdOf,
} from "../bin/retro.js";
import { validate } from "../lib/schemas.js";

const NOW = "2026-09-12T13:45:30Z";
const CURSOR = "2026-09-05T00:00:00Z";

/** 에이전트 출력(`factory.retro.v1`) — 스키마를 실제로 통과하는 값이어야 한다(아래 테스트가 확인한다). */
const AGENT_OUT = () => ({
  period: { from: CURSOR, to: NOW },
  lessons: [
    { role: "correctness", text: "타임존 비교는 파서의 기본 타임존을 확인한다", evidence_runs: [11, 12] },
    { role: "qa", text: "경계값 렌더링을 본다", evidence_runs: [13, 14] },
  ],
  examples: [
    { role: "qa", kind: "good", text: "DST 경계 25시간 렌더링", evidence_runs: [11, 12] },
    { role: "qa", kind: "bad", text: "근거 하나짜리 예시", evidence_runs: [15] },          // 근거 1건 → L1이 미룬다
  ],
  perspectives: [{ role: "correctness", text: "부분 실패를 먼저 묻는다", evidence_runs: [17, 18] }],
  harness: [{ target: "M1", reason: "prisma 스키마가 있는데 하네스는 M0이다" }],
  proposals: [
    { kind: "gate", title: "Promise.all 부분 실패를 lint로", body: "eslint 규칙", evidence_runs: [11, 12, 13] },   // ≥3 → 채택
    { kind: "threshold", title: "diff coverage 95로", body: "표본", evidence_runs: [11, 12] },                      // <20 → 미룸
  ],
  summary: "이번 창 요약",
});

const ISSUES = [
  { number: 11, title: "feat: a", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-10T00:00:00Z" },
  { number: 21, title: "flaky: t1", labels: ["factory:flaky", "factory:needs-human"], state: "open" },
  { number: 22, title: "flaky: t2", labels: ["factory:flaky"], state: "open" },
  { number: 33, title: "rewrite flaky test at another level: t3", labels: ["factory:flaky", "factory:needs-human"], state: "open" },
];

const FLAKY_ISSUES = ISSUES.filter((i) => i.labels.includes("factory:flaky"));

const HARVEST = () => ({
  candidates: { lessons: [{ role: "correctness", text: "raw claim", runs: [11] }], examples: [], flaky: [{ id: "t1", issue: 21 }], needs_human: [] },
  stats: { merged: 3, review_rounds_avg: 1.5, rejects_by_role: { correctness: 2 }, needs_human: 0, usage: { cost_usd: 1.5, tokens: { input: 10, output: 20 } } },
  issues: ISSUES,
  flakyIssues: FLAKY_ISSUES,
  flakyAll: FLAKY_ISSUES,
  harnessTitles: [],
  commentsByIssue: new Map(),
  first: "2026-08-01T00:00:00Z",
});

const LESSONS_PATH = ".factory/lessons/reviewer-correctness.md";
const QA_AGENT_PATH = ".claude/agents/reviewer-qa.md";
const C_AGENT_PATH = ".claude/agents/reviewer-correctness.md";

/**
 * 모든 deps를 주입한 가짜 공장. `state`는 호출자가 넘긴 객체를 그대로 쓰고(runRetro가 제자리에서
 * 갱신한다), `writeState`는 마지막으로 쓰인 상태를 기록한다 — 실제 렌더링은 retro-state 테스트의 몫이다.
 */
function makeDeps({ state, overrides = {} } = {}) {
  const written = [];
  const recorded = [];
  let issueSeq = 100;
  const deps = {
    now: NOW,
    record: (line) => recorded.push(line),
    hydrate: vi.fn(async () => ({ records: new Map([["11", "# run 11"]]), fetched: true, exists: true, stateBlob: "b10b", stateFailed: false })),
    readState: vi.fn(async () => state),
    writeState: vi.fn(async (s, opts) => { written.push({ state: JSON.parse(JSON.stringify(s)), opts }); }),
    harvest: vi.fn(async () => HARVEST()),
    shouldRunFull: vi.fn(({ state: s, force }) => (force || s.merges_since + 1 >= s.n ? { full: true, reason: "n" } : { full: false, reason: "n" })),
    // `claude -p --output-format json`의 봉투 — 결과 텍스트만이 아니라 이 회차가 쓴 비용도 들어 있다
    claudeP: vi.fn(async () => ({ result: JSON.stringify(AGENT_OUT()), total_cost_usd: 0.42, usage: { input_tokens: 1200, output_tokens: 300 } })),
    applyLessons: vi.fn(async ({ role }) => (role === "correctness"
      ? { path: LESSONS_PATH, text: "LESSONS-C", added: [{ id: "L-2026-09-12-01", text: "타임존" }], rejected: [], evicted: [] }
      : { path: ".factory/lessons/reviewer-qa.md", text: "LESSONS-Q", added: [], rejected: [{ text: "경계값", reason: "duplicate" }], evicted: [] })),
    applyRoleAdditions: vi.fn(async ({ role }) => (role === "qa"
      ? { path: QA_AGENT_PATH, text: "AGENT-Q", added: [{ section: "### 좋은 발견", text: "DST" }], skipped: [] }
      : { path: C_AGENT_PATH, text: "AGENT-C", added: [{ section: "## Perspectives", text: "부분 실패" }], skipped: [] })),
    publishLessons: vi.fn(async () => ({ pr: 77, merged: true, reason: null })),
    maturityGaps: vi.fn(async () => [{ target: "M1", rule: "db-schema-at-m0", reason: "DB schema files present" }]),
    createIssue: vi.fn(async () => (issueSeq += 1)),
    registerQuarantine: vi.fn(async () => ({ registered: [{ id: "t1", issue: 21 }] })),
    expiredIds: vi.fn(async () => ["t2"]),
    listProposalPrs: vi.fn(async () => []),
    publishProposal: vi.fn(async () => ({ pr: 88, reason: null })),
    sync: vi.fn(async () => ({ ok: true })),
    lightOnMerge: true,
    nBounds: { min: 1, max: 20 },
    ...overrides,
  };
  return { deps, written, recorded, last: () => written.at(-1)?.state };
}

const freshState = (over = {}) => ({
  cursor: { last_retro_at: CURSOR, last_record_offsets: {} },
  merges_since: 2,
  n: 3,
  history: [],
  candidates: { lessons: [], examples: [], flaky: [], needs_human: [] },
  stats: {},
  ...over,
});

// ── 형식 헬퍼 ────────────────────────────────────────────────────────────

test("the agent fixture really satisfies factory.retro.v1 (otherwise the full path below proves nothing)", () => {
  expect(validate("retro.v1", AGENT_OUT())).toEqual({ ok: true, errors: [] });
});

test("stampOf/todayOf are UTC and stable; gapTitle is the dedup key", () => {
  expect(stampOf(NOW)).toBe("2026-09-12-1345");
  expect(todayOf(NOW)).toBe("2026-09-12");
  expect(stampOf("nonsense")).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}$/);        // 파싱 실패도 형식은 지킨다
  expect(gapTitle({ target: "M2", rule: "http-at-m1", reason: "HTTP routes" })).toBe("harness: promote to M2 — HTTP routes");
  // target이 null인 규칙은 승격이 아니다 — "promote to null"을 만들지 않는다.
  expect(gapTitle({ target: null, rule: "sdk-without-fake", reason: "stripe" })).toBe("harness: sdk-without-fake — stripe");
  expect(gapTitle({ target: "M1", rule: "r", reason: "x".repeat(500) }).length).toBe(240);
});

test("distinctRuns normalizes to strings; statsTable shows the window next to the cumulative total", () => {
  expect(distinctRuns([1, "1", 2])).toBe(2);
  expect(distinctRuns(undefined)).toBe(0);
  const total = { merged: 9, review_rounds_avg: 1.2, needs_human: 3, rejects_by_role: { qa: 4 }, usage: { cost_usd: 12.5, tokens: { input: 99, output: 88 } }, retros: 4 };
  const t = statsTable(HARVEST().stats, total);
  expect(t).toContain("| metric | this window | cumulative |");
  expect(t).toContain("| merged | 3 | 9 |");
  expect(t).toContain("| needs-human | 0 | 3 |");
  expect(t).toContain("| rejects by role | correctness 2 | qa 4 |");
  expect(t).toContain("| cost (usd) | 1.50 | 12.50 |");
  expect(t).toContain("| full retros | — | 4 |");
  // 누적이 아직 없으면(첫 실행) 0으로 렌더링한다 — 빈 칸을 남기지 않는다
  expect(statsTable(null, null)).toContain("| merged | 0 | 0 |");
});

test("accumulateStats sums the window into the total and keeps review_rounds_avg a merge-weighted mean", () => {
  const w1 = { merged: 2, review_rounds_avg: 2, needs_human: 1, rejects_by_role: { qa: 1 }, usage: { cost_usd: 1.5, tokens: { input: 10, output: 20 } } };
  const t1 = accumulateStats(null, w1);
  expect(t1).toMatchObject({ merged: 2, review_rounds_avg: 2, needs_human: 1, rejects_by_role: { qa: 1 }, retros: 1 });
  expect(t1.usage).toEqual({ cost_usd: 1.5, tokens: { input: 10, output: 20 } });
  const w2 = { merged: 6, review_rounds_avg: 1, needs_human: 0, rejects_by_role: { qa: 2, security: 1 }, usage: { cost_usd: 0.75, tokens: { input: 1, output: 2 } } };
  const t2 = accumulateStats(t1, w2);
  expect(t2.merged).toBe(8);
  expect(t2.review_rounds_avg).toBe(1.25);                                // (2×2 + 1×6) / 8 — 평균의 평균(1.5)이 아니다
  expect(t2.rejects_by_role).toEqual({ qa: 3, security: 1 });
  expect(t2.usage.cost_usd).toBe(2.25);
  expect(t2.usage.tokens).toEqual({ input: 11, output: 22 });
  expect(t2.retros).toBe(2);
  // 머지가 0인 창은 평균을 흔들지 않는다
  expect(accumulateStats(t2, { merged: 0, review_rounds_avg: 0 }).review_rounds_avg).toBe(1.25);
});

test("earliestRecordAt reads the oldest run-record section timestamp and skips _retro", () => {
  const records = new Map([
    ["11", "# Run · #11\n\n## triage · 2026-09-03T10:00Z · gha-1\nx\n\n## plan · 2026-09-04T10:00Z · gha-2\ny\n"],
    ["12", "# Run · #12\n\n## implement · 2026-09-01T08:30Z · gha-3\nz\n"],
    ["_retro", "# Retro State\n\n## history · 1999-01-01T00:00Z · x\n"],
  ]);
  expect(earliestRecordAt(records)).toBe("2026-09-01T08:30Z");
  expect(earliestRecordAt(new Map())).toBeNull();
  expect(earliestRecordAt({ 5: "no sections here" })).toBeNull();
});

test("retireCandidates drops exactly the texts that made it into a file, and keeps the rest", () => {
  const c = { lessons: [{ role: "a", text: "adopted" }, { role: "a", text: "still waiting" }], examples: [{ role: "b", text: " adopted example " }], flaky: [{ id: "x" }], needs_human: [{ issue: 1 }] };
  const out = retireCandidates(c, ["adopted", "adopted example"]);
  expect(out.lessons).toEqual([{ role: "a", text: "still waiting" }]);
  expect(out.examples).toEqual([]);
  expect(out.flaky).toEqual([{ id: "x" }]);                               // flaky·needs_human은 채택의 대상이 아니다
  expect(retireCandidates(c, [])).toBe(c);
  expect(emptyCandidates()).not.toBe(emptyCandidates());                  // 공유 상수가 아니다 — 실행 간 누출 금지
});

test("roleFileMap resolves both the roster name and the agent basename", () => {
  const map = roleFileMap({
    schema: 1,
    triage: { agent: ".claude/agents/factory-triage.md", lessons: ".factory/lessons/factory-triage.md" },
    review: { correctness: { agent: C_AGENT_PATH, lessons: LESSONS_PATH } },
  });
  expect(map.get("correctness")).toEqual({ agent: C_AGENT_PATH, lessons: LESSONS_PATH });
  expect(map.get("reviewer-correctness")).toEqual({ agent: C_AGENT_PATH, lessons: LESSONS_PATH });
  expect(map.get("triage").agent).toBe(".claude/agents/factory-triage.md");
  expect(map.get("nope")).toBeUndefined();
});

// ── 경량 경로 ────────────────────────────────────────────────────────────

test("light: merges_since comes from the records (deterministic), candidates merged, state written and synced, no claude -p", async () => {
  const state = freshState({ merges_since: 7, n: 5 });                    // 옛 카운터 값은 기록에서 센 값으로 교체된다
  const { deps, recorded, last } = makeDeps({ state });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(deps.claudeP).not.toHaveBeenCalled();
  expect(deps.hydrate).toHaveBeenCalled();
  expect(deps.harvest).toHaveBeenCalledWith(expect.objectContaining({ since: CURSOR }));
  // 기록의 머지 2건 — 잡이 몇 번 돌았는지가 아니라 무엇이 머지됐는지로 센다
  expect(recorded).toContain("retro: light (merges_since=3/5)");
  // 판정에는 1을 뺀 값이 간다 — shouldRunFull이 "이번 머지"를 스스로 +1 하기 때문(이중 계산 금지)
  expect(deps.shouldRunFull).toHaveBeenCalledWith(expect.objectContaining({ state: expect.objectContaining({ merges_since: 2 }) }));
  const s = last();
  expect(s.merges_since).toBe(3);
  expect(s.cursor.last_retro_at).toBe(CURSOR);                            // 커서는 full에서만 전진한다
  expect(s.candidates.lessons).toEqual([{ role: "correctness", text: "raw claim", runs: [11] }]);
  expect(s.candidates.flaky).toEqual([{ id: "t1", issue: 21 }]);
  expect(s.stats.merged).toBe(3);
  expect(s.stats_total).toBeUndefined();                                  // 누적은 full에서만 움직인다
  expect(deps.sync).toHaveBeenCalledWith(expect.objectContaining({ expectBlob: { "_retro.md": "b10b" } }));
  // 사람이 먼저 읽는 통계 표가 같이 나간다
  expect(deps.writeState.mock.calls[0][1].statsTable).toContain("| merged | 3 | 0 |");
});

test("light: a failing harvest falls back to counting this job run, and the state is still synced", async () => {
  const state = freshState({ merges_since: 0, n: 5 });
  const { deps, recorded, last } = makeDeps({ state, overrides: { harvest: vi.fn(async () => { throw new Error("gh down"); }) } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(last().merges_since).toBe(1);                                    // 셀 수 없으면 실행 횟수로 +1
  expect(last().stats).toEqual({});                                       // 실패한 수확은 통계를 바꾸지 않는다
  expect(recorded.join("\n")).toContain("harvest failed — gh down");
  expect(deps.sync).toHaveBeenCalled();
});

test("light_on_merge: false skips the harvest on a light run but still counts the merge", async () => {
  const state = freshState({ merges_since: 1, n: 5 });
  const { deps, recorded, last } = makeDeps({ state, overrides: { lightOnMerge: false } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(deps.harvest).not.toHaveBeenCalled();
  expect(last().merges_since).toBe(2);
  expect(recorded).toContain("retro: light (merges_since=2/5)");
  expect(recorded).toContain("retro: harvest skipped — light_on_merge is false");
});

test("light_on_merge: false still harvests when the count says this is a full run", async () => {
  const state = freshState({ merges_since: 2, n: 3 });
  const { deps } = makeDeps({ state, overrides: { lightOnMerge: false } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(deps.harvest).toHaveBeenCalledTimes(1);                          // full은 후보 없이 돌 수 없다
  expect(deps.claudeP).toHaveBeenCalled();
});

test("force: the full path runs even below N", async () => {
  const state = freshState({ merges_since: 0, n: 9 });
  const { deps, last } = makeDeps({ state });
  expect(await runRetro({ deps, force: true, now: NOW })).toBe(0);
  expect(deps.shouldRunFull).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  expect(deps.claudeP).toHaveBeenCalled();
  expect(last().merges_since).toBe(0);                                    // full이 끝나며 0으로 리셋된다(올린 적이 없다)
});

test("n guard: a non-finite or sub-1 N is reset to 1 and recorded, never silently used", async () => {
  for (const bad of [null, 0, -3, "many"]) {
    const state = freshState({ merges_since: 5, n: bad });
    const { deps, recorded, last } = makeDeps({ state });
    expect(await runRetro({ deps, now: NOW })).toBe(0);
    expect(recorded.join("\n")).toContain("reset to 1");
    expect(last().n_before ?? last().history.at(-1).n_before).toBe(1);
  }
});

test("a corrupted _retro.md is exit 2 and nothing is written — the history is never silently reset", async () => {
  const { deps, written } = makeDeps({ state: null, overrides: { readState: vi.fn(async () => { throw new Error("json fence corrupted"); }) } });
  expect(await runRetro({ deps, now: NOW })).toBe(2);
  expect(written).toEqual([]);
  expect(deps.sync).not.toHaveBeenCalled();
  expect(deps.claudeP).not.toHaveBeenCalled();
});

// ── 하이드레이트 출처(fix round 1, Critical) ──────────────────────────────
// `readRecords`는 절대 던지지 않는다 — 그래서 fetch 실패가 "기록 없음"처럼 보이고, 그 기본 상태를
// 교체 동기화가 브랜치의 진짜 상태 위에 밀어버린다. 확정하지 못한 회차는 아무것도 쓰지 않는다.

const unprovenHydrate = {
  "a failed fetch": { records: new Map(), fetched: false, exists: null, stateBlob: null, stateFailed: false },
  "a branch we could not list": { records: new Map(), fetched: false, exists: true, stateBlob: null, stateFailed: false },
  "_retro.md present on the branch but unreadable": { records: new Map(), fetched: true, exists: true, stateBlob: "b10b", stateFailed: true },
};

for (const [name, value] of Object.entries(unprovenHydrate)) {
  test(`hydrate provenance: ${name} → exit 2, nothing written, no claude -p`, async () => {
    const state = freshState();
    const { deps, written } = makeDeps({ state, overrides: { hydrate: vi.fn(async () => value) } });
    expect(await runRetro({ deps, now: NOW })).toBe(2);
    expect(written).toEqual([]);
    expect(deps.sync).not.toHaveBeenCalled();
    expect(deps.claudeP).not.toHaveBeenCalled();
    expect(deps.readState).not.toHaveBeenCalled();
  });
}

test("hydrate provenance: a hydrate that throws is also exit 2 — we do not know what the branch holds", async () => {
  const state = freshState();
  const { deps, written, recorded } = makeDeps({ state, overrides: { hydrate: vi.fn(async () => { throw new Error("network"); }) } });
  expect(await runRetro({ deps, now: NOW })).toBe(2);
  expect(written).toEqual([]);
  expect(recorded.join("\n")).toContain("refusing to write state");
});

test("hydrate provenance: a branch with no _retro.md at all is a first run — proceed with the default state", async () => {
  const state = freshState({ cursor: { last_retro_at: null }, merges_since: 0, n: 5, history: [] });
  const { deps, last } = makeDeps({ state, overrides: {
    hydrate: vi.fn(async () => ({ records: new Map(), fetched: true, exists: false, stateBlob: null, stateFailed: false })),
  } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(last()).toBeTruthy();
  // 교체가 아니라 생성이다 — expectBlob은 "그때 브랜치에 없었다"를 뜻하는 null이다
  expect(deps.sync).toHaveBeenCalledWith({ expectBlob: { "_retro.md": null } });
});

// ── 교체 동기화의 경합(no clobber) ───────────────────────────────────────

test("state moved between hydrate and sync → re-hydrate once, re-apply the same mutation on the fresh base, and land", async () => {
  const base = freshState({ merges_since: 0, n: 5, history: [] });
  // 그 사이 다른 retro가 이력을 하나 남기고 커서를 옮겼다
  const fresher = freshState({ merges_since: 0, n: 4, history: [{ at: "2026-09-11T00:00:00Z", yield: 2, n_before: 5, n_after: 4 }] });
  let hydrateCalls = 0;
  let syncCalls = 0;
  const { deps, written } = makeDeps({ state: base, overrides: {
    hydrate: vi.fn(async () => {
      hydrateCalls += 1;
      return { records: new Map(), fetched: true, exists: true, stateBlob: hydrateCalls === 1 ? "old" : "new", stateFailed: false };
    }),
    readState: vi.fn(async () => (hydrateCalls === 1 ? base : fresher)),
    sync: vi.fn(async ({ expectBlob }) => {
      syncCalls += 1;
      return expectBlob["_retro.md"] === "old" ? { ok: false, moved: true, reason: "state moved: …" } : { ok: true };
    }),
  } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(hydrateCalls).toBe(2);
  expect(syncCalls).toBe(2);
  // 두 번째 쓰기는 **새 base 위에** 같은 변이를 얹었다 — 남의 이력이 살아 있다
  const finalState = written.at(-1).state;
  expect(finalState.history).toHaveLength(1);
  expect(finalState.history[0].at).toBe("2026-09-11T00:00:00Z");
  expect(finalState.merges_since).toBe(3);
  expect(finalState.n).toBe(4);
});

test("state still moved after one retry → exit 1, no clobber", async () => {
  const state = freshState({ merges_since: 0, n: 5 });
  const { deps, recorded } = makeDeps({ state, overrides: {
    sync: vi.fn(async () => ({ ok: false, moved: true, reason: "state moved: docs/factory/runs/_retro.md" })),
  } });
  expect(await runRetro({ deps, now: NOW })).toBe(1);
  expect(deps.sync).toHaveBeenCalledTimes(2);
  expect(recorded.join("\n")).toContain("refusing to overwrite");
});

test("a re-hydrate that cannot prove the branch content is exit 1 — never a blind overwrite", async () => {
  const state = freshState({ merges_since: 0, n: 5 });
  let calls = 0;
  const { deps } = makeDeps({ state, overrides: {
    hydrate: vi.fn(async () => {
      calls += 1;
      return { records: new Map(), fetched: calls === 1, exists: true, stateBlob: "old", stateFailed: false };
    }),
    sync: vi.fn(async () => ({ ok: false, moved: true, reason: "state moved" })),
  } });
  expect(await runRetro({ deps, now: NOW })).toBe(1);
  expect(deps.sync).toHaveBeenCalledTimes(1);
});

test("an ordinary (non-moved) sync failure is recorded but does not change the exit code", async () => {
  const state = freshState({ merges_since: 0, n: 5 });
  const { deps, recorded } = makeDeps({ state, overrides: { sync: vi.fn(async () => ({ ok: false, reason: "push failed: no upstream" })) } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(deps.sync).toHaveBeenCalledTimes(1);
  expect(recorded.join("\n")).toContain("records sync failed — push failed");
});

// ── 전체 경로 ────────────────────────────────────────────────────────────

test("full: every enforcement step runs, and the candidates file carries period/candidates/stats/history/maturity_gaps", async () => {
  const state = freshState({ merges_since: 2, n: 3, history: [{ at: "2026-09-05T00:00:00Z", yield: 1, n_before: 3, n_after: 3 }] });
  const { deps, last } = makeDeps({ state });
  expect(await runRetro({ deps, now: NOW })).toBe(0);

  // ⓵ claude -p 입력 — 성숙도 격차는 **분석 전에** 결정적으로 판정해 후보 파일에 실린다
  const arg = deps.claudeP.mock.calls[0][0];
  expect(arg.period).toEqual({ from: CURSOR, to: NOW });
  expect(arg.stats.merged).toBe(3);
  expect(arg.history).toHaveLength(1);
  expect(arg.candidates.flaky).toEqual([{ id: "t1", issue: 21 }]);
  expect(arg.maturity_gaps).toEqual([{ target: "M1", rule: "db-schema-at-m0", reason: "DB schema files present" }]);
  expect(deps.maturityGaps.mock.invocationCallOrder[0]).toBeLessThan(deps.claudeP.mock.invocationCallOrder[0]);

  // ⓶ lessons — 역할별로 한 번, 근거 창은 applyLessons에 넘어간다
  expect(deps.applyLessons).toHaveBeenCalledTimes(2);
  expect(deps.applyLessons).toHaveBeenCalledWith(expect.objectContaining({
    role: "correctness", today: "2026-09-12", minEvidence: 2,
    adopted: [{ text: "타임존 비교는 파서의 기본 타임존을 확인한다", evidence_runs: [11, 12] }],
  }));

  // ⓷ 역할 예시·관점 — 근거 1건짜리 bad 예시는 넘어가지 않는다(L1이 센다)
  const qaCall = deps.applyRoleAdditions.mock.calls.find((c) => c[0].role === "qa")[0];
  expect(qaCall.examples).toEqual([{ kind: "good", text: "DST 경계 25시간 렌더링" }]);
  expect(qaCall.perspectives).toEqual([]);
  const cCall = deps.applyRoleAdditions.mock.calls.find((c) => c[0].role === "correctness")[0];
  expect(cCall.perspectives).toEqual([{ text: "부분 실패를 먼저 묻는다" }]);

  // ⓸ 다크 PR — 실제로 바뀐 파일만
  expect(deps.publishLessons).toHaveBeenCalledTimes(1);
  const pub = deps.publishLessons.mock.calls[0][0];
  expect(Object.keys(pub.files).sort()).toEqual([QA_AGENT_PATH, C_AGENT_PATH, LESSONS_PATH].sort());
  expect(pub.files[LESSONS_PATH]).toBe("LESSONS-C");
  expect(pub.date).toBe("2026-09-12-1345");

  // ⓹ 성숙도 이슈 — 결정적 판정 + 에이전트의 이유 문장
  expect(deps.createIssue).toHaveBeenCalledWith(expect.objectContaining({
    title: "harness: promote to M1 — DB schema files present",
    labels: ["factory:queue", "factory:harness"],
    body: expect.stringContaining("prisma 스키마가 있는데 하네스는 M0이다"),
  }));

  // ⓺ 격리 등록 + ⓻ 만료 → 재작성 이슈
  // 격리 판정은 라벨로 좁힌 목록을 쓴다(최근 200개 일반 스냅샷이 아니라)
  expect(deps.registerQuarantine).toHaveBeenCalledWith(expect.objectContaining({ issues: FLAKY_ISSUES, now: NOW }));
  // 만료 코멘트는 닫힌 flaky 이슈에도 달릴 수 있으므로 두 목록의 합집합에서 읽는다
  expect(deps.expiredIds).toHaveBeenCalledWith(expect.objectContaining({ since: CURSOR, issues: expect.arrayContaining(ISSUES) }));
  expect(deps.createIssue).toHaveBeenCalledWith(expect.objectContaining({
    title: "rewrite flaky test at another level: t2",
    labels: ["backlog", "factory:flaky"],
  }));

  // ⓼ 제안 PR — gate(근거 3) + 삭제 후보(항상 사람), threshold(근거 2)는 미룬다
  expect(deps.publishProposal).toHaveBeenCalledTimes(1);
  const prop = deps.publishProposal.mock.calls[0][0];
  // 기간은 날짜로 — 그래야 §8.3의 ISO 주(`2026-W36`)가 계산되고 제목이 사람이 읽는 문장이 된다.
  expect(prop.title).toBe("retro proposals 2026-09-05..2026-09-12");
  expect(prop.body).toContain("## Retro 2026-W36");
  expect(prop.body).toContain("Promise.all 부분 실패를 lint로");
  expect(prop.body).toContain("test-delete: t3");
  expect(prop.body).not.toContain("diff coverage 95로");
  expect(Object.keys(prop.files)).toEqual(["docs/factory/retro/2026-09-12-1345.md"]);

  // ⓽ 상태 — yield / nextN / 이력 / 커서 / 미룬 후보
  const s = last();
  expect(s.history).toHaveLength(2);
  const h = s.history.at(-1);
  expect(h).toMatchObject({ at: NOW, yield: 5, n_before: 3, n_after: 2, needs_human_since: 0 });   // 1 lesson + 2 role items + 1 harness + 1 PR
  expect(s.n).toBe(2);
  expect(s.merges_since).toBe(0);
  expect(s.cursor.last_retro_at).toBe(NOW);
  // 누적 통계는 full에서만 창을 더한다
  expect(s.stats_total).toMatchObject({ merged: 3, review_rounds_avg: 1.5, needs_human: 0, retros: 1 });
  // 채택된 텍스트는 후보에서 내려간다(미달 후보는 남는다)
  expect(s.candidates.lessons).toEqual([{ role: "correctness", text: "raw claim", runs: [11] }]);
  expect(s.deferred_proposals).toEqual([expect.objectContaining({ kind: "threshold" })]);
  expect(s.deletion_candidates).toEqual([{ id: "t3", issue: 33 }]);
  expect(s.last_full_failed).toBeUndefined();
  // 집행 내역은 이력에 남는다 — 사후 감사의 1차 증거다
  expect(h.applied).toEqual(expect.arrayContaining([
    expect.objectContaining({ step: "lessons:correctness", added: ["L-2026-09-12-01"] }),
    expect.objectContaining({ step: "publish-lessons", pr: 77, merged: true }),
    expect.objectContaining({ step: "quarantine-register", registered: [{ id: "t1", issue: 21 }] }),
  ]));
});

/** 수확이 0인 창: 에이전트가 아무것도 내놓지 못하고, 성숙도 격차도 삭제 후보도 없다. */
const barren = (over = {}) => ({
  claudeP: vi.fn(async () => ({ result: JSON.stringify({ ...AGENT_OUT(), lessons: [], examples: [], perspectives: [], harness: [], proposals: [] }) })),
  maturityGaps: vi.fn(async () => []),
  harvest: vi.fn(async () => ({ ...HARVEST(), issues: [ISSUES[0]], flakyIssues: [] })),   // 재작성 이슈가 없으니 삭제 후보도 없다
  expiredIds: vi.fn(async () => []),
  registerQuarantine: vi.fn(async () => ({ registered: [] })),
  ...over,
});

test("full: yield 0 stretches N; the clamp is honoured", async () => {
  const state = freshState({ merges_since: 3, n: 3 });
  const { deps, last } = makeDeps({ state, overrides: barren() });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(deps.publishLessons).not.toHaveBeenCalled();                     // 바뀐 파일이 없으면 PR도 없다
  expect(deps.publishProposal).not.toHaveBeenCalled();
  expect(last().history.at(-1)).toMatchObject({ yield: 0, n_before: 3, n_after: 5 });   // round(3 × 1.5)
  expect(last().n).toBe(5);
});

test("full: needs-human ≥2 since the last retro halves N even when the yield is small", async () => {
  const state = freshState({ merges_since: 3, n: 3 });
  const { deps, last } = makeDeps({ state, overrides: barren({
    harvest: vi.fn(async () => ({ ...HARVEST(), issues: [ISSUES[0]], flakyIssues: [], stats: { ...HARVEST().stats, needs_human: 2 } })),
  }) });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(last().history.at(-1)).toMatchObject({ yield: 0, needs_human_since: 2, n_before: 3, n_after: 2 });
});

test("full: a harness gap whose issue title is already open is deduped, not created twice", async () => {
  const title = "harness: promote to M1 — DB schema files present";
  const state = freshState();
  const { deps, last } = makeDeps({ state, overrides: {
    harvest: vi.fn(async () => ({ ...HARVEST(), harnessTitles: [title] })),
    // 같은 격차를 두 번 돌려준다 — 같은 실행 안에서도 두 번 만들지 않아야 한다
    maturityGaps: vi.fn(async () => [{ target: "M1", rule: "db-schema-at-m0", reason: "DB schema files present" }]),
  } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(deps.createIssue.mock.calls.map((c) => c[0].title)).not.toContain(title);
  const h = last().history.at(-1);
  expect(h.applied).toEqual(expect.arrayContaining([expect.objectContaining({ step: "harness", skipped: "duplicate" })]));
  expect(h.yield).toBe(4);                                                // harness 이슈가 빠진 만큼만 줄어든다
});

test("full: an already open rewrite issue for the same expired id is not created again", async () => {
  const state = freshState();
  const { deps } = makeDeps({ state, overrides: {
    harvest: vi.fn(async () => ({ ...HARVEST(), flakyIssues: [...FLAKY_ISSUES, { number: 45, title: "rewrite flaky test at another level: t2", labels: ["factory:flaky"], state: "open" }] })),
  } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(deps.createIssue.mock.calls.map((c) => c[0].title)).not.toContain("rewrite flaky test at another level: t2");
});

// ── 격리: 단계별 실패 ────────────────────────────────────────────────────

test("full: each enforcement step is isolated — one failure never blocks the others, and exit stays 0", async () => {
  const state = freshState();
  const { deps, recorded, last } = makeDeps({ state, overrides: {
    applyLessons: vi.fn(async () => { throw new Error("lessons boom"); }),
    maturityGaps: vi.fn(async () => { throw new Error("ls-files boom"); }),
    registerQuarantine: vi.fn(async () => { throw new Error("toml boom"); }),
    publishProposal: vi.fn(async () => { throw new Error("pr boom"); }),
  } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(deps.applyRoleAdditions).toHaveBeenCalledTimes(2);               // lessons가 죽어도 역할 추가는 돈다
  expect(deps.publishLessons).toHaveBeenCalledTimes(1);                   // 역할 파일만으로도 PR은 열린다
  expect(Object.keys(deps.publishLessons.mock.calls[0][0].files).sort()).toEqual([QA_AGENT_PATH, C_AGENT_PATH].sort());
  expect(deps.expiredIds).toHaveBeenCalled();                            // 격리 등록이 죽어도 만료 처리는 돈다
  const h = last().history.at(-1);
  expect(h.applied).toEqual(expect.arrayContaining([
    expect.objectContaining({ step: "lessons:correctness", error: expect.stringContaining("lessons boom") }),
    expect.objectContaining({ step: "maturity", error: expect.stringContaining("ls-files boom") }),
    expect.objectContaining({ step: "quarantine-register", error: expect.stringContaining("toml boom") }),
    expect.objectContaining({ step: "publish-proposal", error: expect.stringContaining("pr boom") }),
  ]));
  expect(h.yield).toBe(2);                                                // 역할 추가 2건만 남는다 — 실패한 단계는 세지 않는다
  expect(recorded.join("\n")).toContain("yield=2");
  expect(deps.sync).toHaveBeenCalled();
});

// ── F3(최종 리뷰): 머지된 PR만이 채택이다 ────────────────────────────────
// 다크 PR이 머지되지 않으면 그 텍스트는 파일에 **없다**. 그래도 후보에서 내리면 다음 retro가 다시 볼
// 수 없어 영원히 사라지고, yield에 세면 "수확이 있었다"며 N을 줄여 토큰만 더 쓴다 — 둘 다 관측되지
// 않은 성공을 기록하는 셈이다.

const unmergedLessonsPr = {
  "RED / timeout / human close": { publishLessons: vi.fn(async () => ({ pr: 79, merged: false, reason: "integrity: .factory/lessons/x.md: additive_only" })) },
  "no PR at all (publish threw)": { publishLessons: vi.fn(async () => { throw new Error("push failed"); }) },
};

for (const [name, overrides] of Object.entries(unmergedLessonsPr)) {
  test(`full: an unmerged lessons PR (${name}) keeps the candidates and is excluded from the yield`, async () => {
    const state = freshState();
    const { deps, recorded, last } = makeDeps({ state, overrides });
    expect(await runRetro({ deps, now: NOW })).toBe(0);
    const s = last();
    const h = s.history.at(-1);
    // yield: lesson 1 + 역할 2를 빼고 harness 1 + 제안 PR 1만 남는다
    expect(h.yield).toBe(2);
    expect(s.n).toBe(3);                                                  // yield 1~2 → N 유지(줄이지 않는다)
    // 후보는 그대로 — 다음 retro가 같은 것을 다시 본다
    expect(s.candidates.lessons).toEqual([{ role: "correctness", text: "raw claim", runs: [11] }]);
    expect(recorded.join("\n")).toContain("lessons PR not merged");
  });
}

test("full: a merged lessons PR is what retires the candidates — the adopted text leaves the list", async () => {
  const state = freshState({ candidates: { lessons: [{ role: "correctness", text: "타임존", runs: [11, 12] }], examples: [], flaky: [], needs_human: [] } });
  const { deps, last } = makeDeps({ state });                             // 기본 publishLessons는 merged:true다
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  const s = last();
  expect(s.history.at(-1).yield).toBe(5);
  expect(s.candidates.lessons.map((l) => l.text)).not.toContain("타임존");
  expect(s.history.at(-1).applied).toEqual(expect.arrayContaining([expect.objectContaining({ step: "publish-lessons", pr: 77, merged: true })]));
});

// ── F6(최종 리뷰): 다크 PR 경로 허용 목록 ────────────────────────────────
// 자체 머지의 안전성은 integrity의 lessons/additive_only 규칙이 그 **두 경로**에만 걸려 있다는 사실에
// 기댄다. roles.toml이 엉뚱한 경로를 가리키면 retro는 "자체 머지되는 임의 파일 쓰기"가 된다.

test("splitDarkFiles admits only .factory/lessons/<f>.md and .claude/agents/<f>.md — no subdirs, no escapes", () => {
  const { allowed, rejected } = splitDarkFiles({
    ".factory/lessons/reviewer-qa.md": "a",
    ".claude/agents/reviewer-qa.md": "b",
    ".factory/lessons/nested/x.md": "c",
    ".claude/agents/../../etc/passwd": "d",
    "docs/factory/DECISIONS.md": "e",
    ".factory/harness.toml": "f",
  });
  expect(Object.keys(allowed)).toEqual([".factory/lessons/reviewer-qa.md", ".claude/agents/reviewer-qa.md"]);
  expect(rejected).toEqual([".factory/lessons/nested/x.md", ".claude/agents/../../etc/passwd", "docs/factory/DECISIONS.md", ".factory/harness.toml"]);
});

test("full: a file outside the dark allowlist never reaches the PR — it is recorded as rejected", async () => {
  const state = freshState();
  const { deps, recorded, last } = makeDeps({ state, overrides: {
    // roles.toml이 엉뚱한 경로를 가리키는 상황 — lessons 쓰기는 성공했다고 주장한다
    applyLessons: vi.fn(async () => ({ path: "docs/factory/DECISIONS.md", text: "EVIL", added: [{ id: "L-2026-09-12-01", text: "x" }], rejected: [], evicted: [] })),
  } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  const files = deps.publishLessons.mock.calls[0][0].files;
  expect(Object.keys(files).sort()).toEqual([QA_AGENT_PATH, C_AGENT_PATH].sort());
  expect(files["docs/factory/DECISIONS.md"]).toBeUndefined();
  expect(last().history.at(-1).applied).toEqual(expect.arrayContaining([
    expect.objectContaining({ step: "publish-lessons", rejected: ["docs/factory/DECISIONS.md"] }),
  ]));
  expect(recorded.join("\n")).toContain("outside the dark allowlist");
});

test("full: when every changed file is rejected there is no PR at all, and nothing counts as landed", async () => {
  const state = freshState();
  const { deps, last } = makeDeps({ state, overrides: {
    applyLessons: vi.fn(async () => ({ path: "../../etc/passwd", text: "EVIL", added: [{ id: "L-2026-09-12-01", text: "x" }], rejected: [], evicted: [] })),
    applyRoleAdditions: vi.fn(async () => ({ path: "scripts/deploy.sh", text: "EVIL", added: [{ section: "## Perspectives", text: "y" }], skipped: [] })),
  } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(deps.publishLessons).not.toHaveBeenCalled();
  expect(last().history.at(-1).yield).toBe(2);                            // harness 1 + 제안 PR 1 — 착지하지 않은 텍스트는 0
});

test("full: a proposal PR that never got a number does not count toward the yield", async () => {
  const state = freshState();
  const { deps, last } = makeDeps({ state, overrides: { publishProposal: vi.fn(async () => ({ pr: null, reason: "push failed" })) } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(last().history.at(-1).yield).toBe(4);
});

// ── F8(최종 리뷰): 만료 스캔만 state:"all" ──────────────────────────────
// sweeper는 **닫힌** flaky 이슈에도 만료 코멘트를 남긴다(사람이 이슈를 닫아도 격리는 남는 부채다).
// 열린 목록만 보면 그 만료는 영영 읽히지 않고 "다른 레벨에서 다시 쓰라"는 이슈도 생기지 않는다.
// 반대로 등록·dedup은 열린 이슈만 봐야 한다 — 사람이 닫은 이슈에 새 격리를 걸지 않는다.

test("collectIssues: flaky is listed twice — open for registration/dedup, all for the expired scan", async () => {
  const closedFlaky = { number: 22, title: "flaky: t2", labels: ["factory:flaky"], closedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
  const openFlaky = { number: 21, title: "flaky: t1", labels: ["factory:flaky"], closedAt: null, updatedAt: "2026-09-11T00:00:00Z" };
  const calls = [];
  const gh = {
    issueList: vi.fn(async (args) => {
      calls.push(args);
      if (args.labels?.[0] === "factory:flaky") return args.state === "open" ? [openFlaky] : [openFlaky, closedFlaky];
      if (args.labels?.[0] === "factory:harness") return [{ number: 5, title: "harness: promote to M1 — x" }];
      return [{ number: 11, title: "feat", labels: [], closedAt: null, updatedAt: "2026-09-01T00:00:00Z" }];   // 창 밖 — 코멘트를 읽지 않는다
    }),
    comments: vi.fn(async () => []),
  };
  const snap = await collectIssues({ gh, since: CURSOR });

  expect(calls).toContainEqual({ labels: ["factory:flaky"], state: "open" });
  expect(calls).toContainEqual({ labels: ["factory:flaky"], state: "all" });
  expect(snap.flakyIssues.map((i) => i.number)).toEqual([21]);
  expect(snap.flakyAll.map((i) => i.number)).toEqual([21, 22]);
  expect(snap.flakyAll.find((i) => i.number === 22).state).toBe("closed");
  expect(snap.harnessTitles).toEqual(["harness: promote to M1 — x"]);
  // 닫힌 flaky 이슈의 코멘트도 읽는다 — 만료 마커가 거기에만 남아 있을 수 있다
  expect([...snap.commentsByIssue.keys()].sort()).toEqual([21, 22]);
});

test("full: the expired scan sees closed flaky issues; registration still only sees the open ones", async () => {
  const closed = { number: 22, title: "flaky: t2", labels: ["factory:flaky"], state: "closed", closedAt: "2026-09-01T00:00:00Z" };
  const open = ISSUES[1];
  const { deps } = makeDeps({ state: freshState(), overrides: {
    harvest: vi.fn(async () => ({ ...HARVEST(), flakyIssues: [open], flakyAll: [open, closed] })),
  } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  const scanned = deps.expiredIds.mock.calls[0][0].issues;
  expect(scanned.map((i) => i.number)).toContain(22);
  expect(deps.registerQuarantine.mock.calls[0][0].issues).toEqual([open]);
});

// ── F9(최종 리뷰): 제안 PR dedup ─────────────────────────────────────────
// 제안 PR은 사람이 머지한다 — 며칠 열려 있는 것이 정상이고 그 사이 retro는 여러 번 돈다. 같은 창의
// 제안을 또 열면 사람이 읽을 것만 늘고(어느 쪽이 최신인지도 알 수 없다) yield까지 부풀린다.

test("full: an open proposal PR carrying the same period marker suppresses a second one", async () => {
  const marker = "<!-- factory-retro:v1 period=2026-09-05..2026-09-12 -->";
  const { deps, recorded, last } = makeDeps({ state: freshState(), overrides: {
    listProposalPrs: vi.fn(async () => [{ number: 66, title: "retro proposals (다른 제목)", body: `${marker}\n## Retro …` }]),
  } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(deps.listProposalPrs).toHaveBeenCalled();
  expect(deps.publishProposal).not.toHaveBeenCalled();
  expect(recorded.join("\n")).toContain("retro: proposal skipped (duplicate #66)");
  const h = last().history.at(-1);
  expect(h.applied).toEqual(expect.arrayContaining([expect.objectContaining({ step: "publish-proposal", skipped: "duplicate #66" })]));
  expect(h.yield).toBe(4);                                                // 열리지 않은 PR은 세지 않는다
});

test("full: the same title also counts as a duplicate; a different period does not", async () => {
  const sameTitle = makeDeps({ state: freshState(), overrides: {
    listProposalPrs: vi.fn(async () => [{ number: 67, title: "retro proposals 2026-09-05..2026-09-12", body: "본문이 비어도 제목이 같으면 같은 제안이다" }]),
  } });
  expect(await runRetro({ deps: sameTitle.deps, now: NOW })).toBe(0);
  expect(sameTitle.deps.publishProposal).not.toHaveBeenCalled();

  const otherPeriod = makeDeps({ state: freshState(), overrides: {
    listProposalPrs: vi.fn(async () => [{ number: 68, title: "retro proposals 2026-08-01..2026-08-07", body: "<!-- factory-retro:v1 period=2026-08-01..2026-08-07 -->" }]),
  } });
  expect(await runRetro({ deps: otherPeriod.deps, now: NOW })).toBe(0);
  expect(otherPeriod.deps.publishProposal).toHaveBeenCalledTimes(1);
});

test("full: a failing dedup lookup does not swallow the proposal — the PR is still opened", async () => {
  const { deps, last } = makeDeps({ state: freshState(), overrides: {
    listProposalPrs: vi.fn(async () => { throw new Error("gh pr list boom"); }),
  } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(deps.publishProposal).toHaveBeenCalledTimes(1);
  expect(last().history.at(-1).applied).toEqual(expect.arrayContaining([
    expect.objectContaining({ step: "proposal-dedup", error: expect.stringContaining("gh pr list boom") }),
  ]));
});

// ── F10(최종 리뷰): retro 자신의 비용 ───────────────────────────────────
// retro는 스테이지가 아니라 run 기록에 usage 줄을 남기지 않는다 — 여기서 걷지 않으면 "공장이 자기를
// 돌아보는 데 든 비용"이 어디에도 남지 않는다.

test("retroUsageOf reads the claude -p envelope and degrades to zeros, never to nulls", () => {
  expect(retroUsageOf({ total_cost_usd: 0.4212345678, usage: { input_tokens: 12, output_tokens: 3 } }))
    .toEqual({ cost_usd: 0.421235, tokens: { input: 12, output: 3 } });
  expect(retroUsageOf(null)).toEqual({ cost_usd: 0, tokens: { input: 0, output: 0 } });
  expect(retroUsageOf({ is_error: true, result: "usage limit" })).toEqual({ cost_usd: 0, tokens: { input: 0, output: 0 } });
});

test("full: the retro's own cost lands in stats.retro_usage, accumulates into stats_total, and shows in the table", async () => {
  const state = freshState({ stats_total: { merged: 1, retro_usage: { cost_usd: 1, tokens: { input: 100, output: 50 } }, retros: 1 } });
  const { deps, last, written } = makeDeps({ state });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  const s = last();
  expect(s.stats.retro_usage).toEqual({ cost_usd: 0.42, tokens: { input: 1200, output: 300 } });
  expect(s.stats_total.retro_usage).toEqual({ cost_usd: 1.42, tokens: { input: 1300, output: 350 } });
  // 스테이지 비용과 섞이지 않는다 — 창의 usage는 harvest가 준 값 그대로다
  expect(s.stats.usage).toEqual({ cost_usd: 1.5, tokens: { input: 10, output: 20 } });
  const table = written.at(-1).opts.statsTable;
  expect(table).toContain("| retro cost (usd) | 0.42 | 1.42 |");
  expect(table).toContain("| retro tokens | input 1200 / output 300 | input 1300 / output 350 |");
});

test("statsTable renders the retro rows even when nothing has been recorded yet", () => {
  const t = statsTable(null, null);
  expect(t).toContain("| retro cost (usd) | 0.00 | 0.00 |");
  expect(t).toContain("| retro tokens | input 0 / output 0 | input 0 / output 0 |");
});

test("a failed full analysis still records what it spent", async () => {
  const { deps, last } = makeDeps({ state: freshState({ merges_since: 2, n: 3 }), overrides: {
    claudeP: vi.fn(async () => ({ is_error: true, result: "usage limit", total_cost_usd: 0.05, usage: { input_tokens: 900, output_tokens: 10 } })),
  } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(last().stats.retro_usage).toEqual({ cost_usd: 0.05, tokens: { input: 900, output: 10 } });
});

// ── F11(최종 리뷰): full 경로에서 상태를 못 쓰면 시끄럽게 실패한다 ───────
// 여기까지 왔으면 부수 효과는 이미 일어났다(PR·이슈·quarantine.toml). 그 사실을 적은 상태를 쓰지
// 못한 채 exit 0으로 물러나면 다음 회차가 같은 창을 다시 보고 같은 일을 또 한다.

const stateWriteFailures = {
  "writeState throws": { writeState: vi.fn(async () => { throw new Error("disk full"); }) },
  "sync throws": { sync: vi.fn(async () => { throw new Error("git push exploded"); }) },
  "sync returns ok:false (not moved)": { sync: vi.fn(async () => ({ ok: false, reason: "push failed: no upstream" })) },
};

for (const [name, overrides] of Object.entries(stateWriteFailures)) {
  test(`full: ${name} → exit 1 (the side effects already happened)`, async () => {
    const state = freshState({ merges_since: 2, n: 3 });
    const { deps, recorded } = makeDeps({ state, overrides });
    expect(await runRetro({ deps, now: NOW })).toBe(1);
    expect(deps.publishLessons).toHaveBeenCalled();                       // 부수 효과는 실제로 일어났다
    expect(recorded.join("\n")).toMatch(/write failed|sync aborted|sync failed/);
  });

  test(`light: ${name} → still exit 0, recorded (nothing was applied, the next merge retries)`, async () => {
    const state = freshState({ merges_since: 0, n: 9 });
    const { deps, recorded } = makeDeps({ state, overrides });
    expect(await runRetro({ deps, now: NOW })).toBe(0);
    expect(deps.claudeP).not.toHaveBeenCalled();
    expect(recorded.join("\n")).toMatch(/write failed|sync aborted|sync failed/);
  });
}

// ── 이월 #2: 재하이드레이트에서 브랜치의 상태 파일이 사라졌을 때 ─────────

test("re-hydrate: a _retro.md that vanished from the branch restarts from the empty state, not from our own local write", async () => {
  const base = freshState({ merges_since: 0, n: 5, history: [{ at: "2026-09-01T00:00:00Z", yield: 1, n_before: 5, n_after: 5 }] });
  let hydrateCalls = 0;
  const { deps, written } = makeDeps({ state: base, overrides: {
    hydrate: vi.fn(async () => {
      hydrateCalls += 1;
      // 두 번째 하이드레이트: 브랜치에 `_retro.md`가 더 이상 없다(누군가 지웠다)
      return { records: new Map(), fetched: true, exists: hydrateCalls === 1, stateBlob: hydrateCalls === 1 ? "old" : null, stateFailed: false };
    }),
    sync: vi.fn(async ({ expectBlob }) => (expectBlob["_retro.md"] === "old" ? { ok: false, moved: true, reason: "state moved" } : { ok: true })),
  } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(hydrateCalls).toBe(2);
  // 로컬 파일(= 방금 우리가 쓴 변이본)을 다시 읽지 않는다 — 그랬다면 같은 변이가 두 번 얹힌다
  expect(deps.readState).toHaveBeenCalledTimes(1);
  const finalState = written.at(-1).state;
  expect(finalState.history).toEqual([]);                                 // 지워진 이력을 되살려 내지 않는다
  expect(finalState.merges_since).toBe(3);                                // 이번 창의 변이만 얹는다
  expect(deps.sync).toHaveBeenLastCalledWith({ expectBlob: { "_retro.md": null } });
});

// ── 분석 실패 경로 ───────────────────────────────────────────────────────

const failures = {
  "is_error": { claudeP: vi.fn(async () => ({ is_error: true, result: "usage limit" })) },
  "no JSON at all": { claudeP: vi.fn(async () => ({ result: "I could not do it." })) },
  "JSON that breaks the schema": { claudeP: vi.fn(async () => ({ result: JSON.stringify({ lessons: [] }) })) },
  "a thrown claude -p": { claudeP: vi.fn(async () => { throw new Error("claude not installed"); }) },
};

for (const [name, overrides] of Object.entries(failures)) {
  test(`full analysis failure (${name}) → last_full_failed, exit 0, merges_since kept for the next merge`, async () => {
    const state = freshState({ merges_since: 2, n: 3 });
    const { deps, recorded, last } = makeDeps({ state, overrides });
    expect(await runRetro({ deps, now: NOW })).toBe(0);
    const s = last();
    expect(s.last_full_failed.at).toBe(NOW);
    expect(s.last_full_failed.reason).toBeTruthy();
    expect(s.merges_since).toBe(3);                                       // 기록에서 센 값 그대로 — 리셋하지 않는다(다음 머지가 다시 시도한다)
    expect(s.cursor.last_retro_at).toBe(CURSOR);                          // 커서도 움직이지 않는다
    expect(s.history).toEqual([]);                                        // 돌지 않은 retro는 이력에 남지 않는다
    expect(deps.applyLessons).not.toHaveBeenCalled();
    expect(deps.publishLessons).not.toHaveBeenCalled();
    expect(deps.createIssue).not.toHaveBeenCalled();
    expect(deps.registerQuarantine).not.toHaveBeenCalled();
    expect(deps.sync).toHaveBeenCalled();
    expect(recorded.join("\n")).toContain("full analysis failed");
  });
}

test("a successful full run clears a previous last_full_failed", async () => {
  const state = freshState({ last_full_failed: { at: "2026-09-06T00:00:00Z", reason: "old" } });
  const { deps, last } = makeDeps({ state });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(last().last_full_failed).toBeUndefined();
});

test("period.from falls back to the first observed activity when there has never been a retro", async () => {
  const state = freshState({ cursor: { last_retro_at: null, last_record_offsets: {} }, merges_since: 0, n: 1 });
  const { deps } = makeDeps({ state });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(deps.harvest).toHaveBeenCalledWith(expect.objectContaining({ since: null }));
  expect(deps.claudeP.mock.calls[0][0].period).toEqual({ from: "2026-08-01T00:00:00Z", to: NOW });
});

test("an unexpected abort is exit 1 and writes nothing — a run that decided nothing has nothing to write", async () => {
  const state = freshState();
  const { deps, recorded, written } = makeDeps({ state, overrides: { shouldRunFull: vi.fn(() => { throw new Error("boom"); }) } });
  expect(await runRetro({ deps, now: NOW })).toBe(1);
  expect(recorded.join("\n")).toContain("aborted — boom");
  expect(written).toEqual([]);
  expect(deps.sync).not.toHaveBeenCalled();
});

test("applyMutation is pure and re-appliable — the same mutation on a fresher base yields the fresher n/history", () => {
  const mutation = { mergesSince: 4, stats: { merged: 4 }, full: { at: NOW, yield: 0, needsHumanSince: 0, bounds: { min: 1, max: 20 }, retire: [], entry: { at: NOW, yield: 0 }, deferredProposals: [], deletionCandidates: [] } };
  const a = applyMutation({ n: 4, merges_since: 1, history: [], candidates: emptyCandidates() }, mutation);
  expect(a).toMatchObject({ n: 6, merges_since: 0 });
  expect(a.history.at(-1)).toMatchObject({ n_before: 4, n_after: 6 });
  const b = applyMutation({ n: 2, merges_since: 9, history: [{ at: "x" }], candidates: emptyCandidates() }, mutation);
  expect(b.n).toBe(3);
  expect(b.history.map((x) => x.at)).toEqual(["x", NOW]);
  // 같은 mutation을 두 번 적용해도 base가 같으면 결과가 같다(재시도가 이력을 두 번 쌓지 않는다)
  expect(applyMutation({ n: 4, merges_since: 1, history: [], candidates: emptyCandidates() }, mutation)).toEqual(a);
});

test("ymdOf reduces a cursor timestamp to the date the proposal PR needs", async () => {
  const { ymdOf } = await import("../bin/retro.js");
  expect(ymdOf("2026-09-05T00:00:00Z")).toBe("2026-09-05");
  expect(ymdOf("2026-09-05")).toBe("2026-09-05");
  expect(ymdOf(undefined)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
