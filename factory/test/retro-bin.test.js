import { test, expect, vi } from "vitest";
import { distinctRuns, gapTitle, roleFileMap, runRetro, stampOf, statsTable, todayOf } from "../bin/retro.js";
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

const HARVEST = () => ({
  candidates: { lessons: [{ role: "correctness", text: "raw claim", runs: [11] }], examples: [], flaky: [{ id: "t1", issue: 21 }], needs_human: [] },
  stats: { merged: 2, review_rounds_avg: 1.5, rejects_by_role: { correctness: 2 }, needs_human: 0, usage: { cost_usd: 1.5, tokens: { input: 10, output: 20 } } },
  issues: ISSUES,
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
    hydrate: vi.fn(async () => ({ records: new Map([["11", "# run 11"]]) })),
    readState: vi.fn(async () => state),
    writeState: vi.fn(async (s, opts) => { written.push({ state: JSON.parse(JSON.stringify(s)), opts }); }),
    harvest: vi.fn(async () => HARVEST()),
    shouldRunFull: vi.fn(({ state: s, force }) => (force || s.merges_since + 1 >= s.n ? { full: true, reason: "n" } : { full: false, reason: "n" })),
    claudeP: vi.fn(async () => ({ result: JSON.stringify(AGENT_OUT()) })),
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
    publishProposal: vi.fn(async () => ({ pr: 88, reason: null })),
    sync: vi.fn(async () => ({ ok: true })),
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

test("distinctRuns normalizes to strings; statsTable renders the §8.3 numbers", () => {
  expect(distinctRuns([1, "1", 2])).toBe(2);
  expect(distinctRuns(undefined)).toBe(0);
  const t = statsTable(HARVEST().stats);
  expect(t).toContain("| merged | 2 |");
  expect(t).toContain("| needs-human | 0 |");
  expect(t).toContain("correctness 2");
  expect(t).toContain("| cost (usd) | 1.50 |");
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

test("light: merges_since += 1, candidates merged, state written and synced, no claude -p", async () => {
  const state = freshState({ merges_since: 0, n: 3 });
  const { deps, recorded, last } = makeDeps({ state });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(deps.claudeP).not.toHaveBeenCalled();
  expect(deps.hydrate).toHaveBeenCalled();
  expect(deps.harvest).toHaveBeenCalledWith(expect.objectContaining({ since: CURSOR }));
  expect(recorded).toContain("retro: light (merges_since=1/3)");
  const s = last();
  expect(s.merges_since).toBe(1);
  expect(s.cursor.last_retro_at).toBe(CURSOR);                            // 커서는 full에서만 전진한다
  expect(s.candidates.lessons).toEqual([{ role: "correctness", text: "raw claim", runs: [11] }]);
  expect(s.candidates.flaky).toEqual([{ id: "t1", issue: 21 }]);
  expect(s.stats.merged).toBe(2);
  expect(deps.sync).toHaveBeenCalled();
  // 사람이 먼저 읽는 통계 표가 같이 나간다
  expect(deps.writeState.mock.calls[0][1].statsTable).toContain("| merged | 2 |");
});

test("light: a failing harvest does not stop the run — the merge is still counted and the state still synced", async () => {
  const state = freshState({ merges_since: 0, n: 5 });
  const { deps, recorded, last } = makeDeps({ state, overrides: { harvest: vi.fn(async () => { throw new Error("gh down"); }) } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(last().merges_since).toBe(1);
  expect(recorded.join("\n")).toContain("harvest failed — gh down");
  expect(deps.sync).toHaveBeenCalled();
});

test("force: merges_since is NOT incremented and the full path runs even below N", async () => {
  const state = freshState({ merges_since: 0, n: 9 });
  const { deps, last } = makeDeps({ state });
  expect(await runRetro({ deps, force: true, now: NOW })).toBe(0);
  expect(deps.shouldRunFull).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  expect(deps.claudeP).toHaveBeenCalled();
  expect(last().merges_since).toBe(0);                                    // full이 끝나며 0으로 리셋된다(올린 적이 없다)
});

test("n guard: a non-finite or sub-1 N is reset to 1 and recorded, never silently used", async () => {
  for (const bad of [null, 0, -3, "many"]) {
    const state = freshState({ merges_since: 0, n: bad });
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

// ── 전체 경로 ────────────────────────────────────────────────────────────

test("full: every enforcement step runs, and the candidates file carries period/candidates/stats/history", async () => {
  const state = freshState({ merges_since: 2, n: 3, history: [{ at: "2026-09-05T00:00:00Z", yield: 1, n_before: 3, n_after: 3 }] });
  const { deps, last } = makeDeps({ state });
  expect(await runRetro({ deps, now: NOW })).toBe(0);

  // ⓵ claude -p 입력
  const arg = deps.claudeP.mock.calls[0][0];
  expect(arg.period).toEqual({ from: CURSOR, to: NOW });
  expect(arg.stats.merged).toBe(2);
  expect(arg.history).toHaveLength(1);
  expect(arg.candidates.flaky).toEqual([{ id: "t1", issue: 21 }]);

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
  expect(deps.registerQuarantine).toHaveBeenCalledWith(expect.objectContaining({ issues: ISSUES, now: NOW }));
  expect(deps.expiredIds).toHaveBeenCalledWith(expect.objectContaining({ since: CURSOR }));
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
  harvest: vi.fn(async () => ({ ...HARVEST(), issues: [ISSUES[0]] })),          // 재작성 이슈가 없으니 삭제 후보도 없다
  expiredIds: vi.fn(async () => []),
  registerQuarantine: vi.fn(async () => ({ registered: [] })),
  ...over,
});

test("full: yield 0 stretches N; the clamp is honoured", async () => {
  const state = freshState({ merges_since: 3, n: 4 });
  const { deps, last } = makeDeps({ state, overrides: barren() });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(deps.publishLessons).not.toHaveBeenCalled();                     // 바뀐 파일이 없으면 PR도 없다
  expect(deps.publishProposal).not.toHaveBeenCalled();
  expect(last().history.at(-1)).toMatchObject({ yield: 0, n_before: 4, n_after: 6 });
  expect(last().n).toBe(6);
});

test("full: needs-human ≥2 since the last retro halves N even when the yield is small", async () => {
  const state = freshState({ merges_since: 7, n: 8 });
  const { deps, last } = makeDeps({ state, overrides: barren({
    harvest: vi.fn(async () => ({ ...HARVEST(), issues: [ISSUES[0]], stats: { ...HARVEST().stats, needs_human: 2 } })),
  }) });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(last().history.at(-1)).toMatchObject({ yield: 0, needs_human_since: 2, n_after: 4 });
});

test("full: a harness gap whose issue title is already open is deduped, not created twice", async () => {
  const title = "harness: promote to M1 — DB schema files present";
  const state = freshState();
  const { deps, last } = makeDeps({ state, overrides: {
    harvest: vi.fn(async () => ({ ...HARVEST(), issues: [...ISSUES, { number: 44, title, labels: ["factory:harness"], state: "open" }] })),
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
    harvest: vi.fn(async () => ({ ...HARVEST(), issues: [...ISSUES, { number: 45, title: "rewrite flaky test at another level: t2", labels: ["factory:flaky"], state: "open" }] })),
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

test("full: a lessons PR that could not be merged still counts its additions but is recorded as unmerged", async () => {
  const state = freshState();
  const { deps, last } = makeDeps({ state, overrides: { publishLessons: vi.fn(async () => ({ pr: 79, merged: false, reason: "integrity: .factory/lessons/x.md: additive_only" })) } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  const h = last().history.at(-1);
  expect(h.applied).toEqual(expect.arrayContaining([expect.objectContaining({ step: "publish-lessons", pr: 79, merged: false, reason: expect.stringContaining("additive_only") })]));
});

test("full: a proposal PR that never got a number does not count toward the yield", async () => {
  const state = freshState();
  const { deps, last } = makeDeps({ state, overrides: { publishProposal: vi.fn(async () => ({ pr: null, reason: "push failed" })) } });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(last().history.at(-1).yield).toBe(4);
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
    expect(s.merges_since).toBe(3);                                       // 리셋하지 않는다 — 다음 머지가 다시 시도한다
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

test("an unexpected abort is exit 1 and still tries to persist what it knows", async () => {
  const state = freshState();
  const { deps, recorded } = makeDeps({ state, overrides: { shouldRunFull: vi.fn(() => { throw new Error("boom"); }) } });
  expect(await runRetro({ deps, now: NOW })).toBe(1);
  expect(recorded.join("\n")).toContain("aborted — boom");
  expect(deps.writeState).toHaveBeenCalled();
});

test("ymdOf reduces a cursor timestamp to the date the proposal PR needs", async () => {
  const { ymdOf } = await import("../bin/retro.js");
  expect(ymdOf("2026-09-05T00:00:00Z")).toBe("2026-09-05");
  expect(ymdOf("2026-09-05")).toBe("2026-09-05");
  expect(ymdOf(undefined)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
