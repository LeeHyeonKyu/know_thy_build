import { test, expect, vi } from "vitest";
import { startHeartbeat, heartbeatBody, HEARTBEAT_INTERVAL_MS, MAX_COMMENT_BYTES } from "../lib/heartbeat.js";
import { parseProgressMarker } from "../lib/progress.js";
import { sweep } from "../lib/sweeper.js";

/**
 * ADR-022로 하트비트는 **본문이 바뀌었을 때만** PATCH한다. 실제 러너에서 `now()`는 매 틱 다른
 * 값을 주므로 `last:` 한 줄만으로도 본문은 항상 달라지고 — 그래서 sweeper가 읽는 liveness는
 * 예전 그대로다. 이 테스트의 `now`가 매 틱 움직이는 이유가 그것이다(예전에는 "T0"에 얼어
 * 있었는데, 그 시계로는 "틱마다 PATCH"라는 이 테스트의 의도 자체가 표현되지 않는다).
 */
test("posts once, then patches on each tick; stop() clears the timer", async () => {
  vi.useFakeTimers();
  const gh = { comment: vi.fn(async () => "https://x/1#issuecomment-42"), patchComment: vi.fn(async () => {}) };
  let t = 0;
  const hb = await startHeartbeat({ gh, issue: 7, stage: "implement", runnerId: "gha-1", intervalMs: 1000, now: () => `T${t++}` });
  expect(gh.comment).toHaveBeenCalledTimes(1);
  expect(gh.comment.mock.calls[0][1]).toMatch(/<!-- factory-heartbeat issue=7 -->/);
  expect(gh.comment.mock.calls[0][1]).toMatch(/runner: gha-1/);
  await vi.advanceTimersByTimeAsync(2500);
  expect(gh.patchComment).toHaveBeenCalledTimes(2);
  expect(gh.patchComment.mock.calls[0][0]).toBe(42);
  hb.stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(gh.patchComment).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

test("unparseable comment id disables heartbeat (no timer, no patches)", async () => {
  vi.useFakeTimers();
  const gh = { comment: vi.fn(async () => "https://x/1"), patchComment: vi.fn(async () => {}) };
  const hb = await startHeartbeat({ gh, issue: 7, stage: "implement", runnerId: "gha-1", intervalMs: 1000, now: () => "T0" });
  expect(hb.commentId).toBe(null);
  await vi.advanceTimersByTimeAsync(5000);
  expect(gh.patchComment).not.toHaveBeenCalled();
  hb.stop();
  vi.useRealTimers();
});

/**
 * ADR-020 최종 리뷰 SF-4 — **하트비트를 쓰는 쪽과 읽는 쪽을 처음으로 한 줄에 세운다.**
 *
 * `lib/heartbeat.js`가 `… last: <iso>`를 템플릿 리터럴로 쓰고, `lib/sweeper.js`는 그것을 독립된
 * 정규식(`HB`)으로 읽는다. 지금까지 `startHeartbeat`의 출력을 `sweep`에 먹이는 테스트가 **하나도**
 * 없었다 — `last:`를 `updated:`로 바꾸면 양쪽 테스트가 다 초록인 채로 모든 in-progress 이슈의
 * 좀비 감시가 조용히 꺼진다(그 팔은 "하트비트 없음"으로 읽고 곧장 재큐/에스컬레이션으로 간다).
 * 그래서 여기서는 손으로 지은 본문을 한 글자도 쓰지 않는다: writer가 만든 코멘트를 그대로 sweep에 준다.
 */
test("SF-4 round-trip: the body startHeartbeat writes is what sweep's staleness check reads", async () => {
  const posted = [];
  const gh = {
    comment: vi.fn(async (n, body) => { posted.push({ id: 1, body, createdAt: "2026-09-11T00:55:00Z" }); return "https://x/1#issuecomment-42"; }),
    patchComment: vi.fn(async () => {}),
  };
  // 싱싱한 하트비트(5분 전) — 이 문자열을 sweep이 읽어야 "살아 있다"가 된다
  await startHeartbeat({ gh, issue: 7, stage: "implement", runnerId: "gha-1", intervalMs: 10 * 60e3, now: () => "2026-09-11T00:55:00Z" })
    .then((hb) => hb.stop());

  const sweepArgs = (comments) => ({
    gh: { searchIssues: async (l) => (l === "factory:in-progress" ? [{ number: 7 }] : []), comments: async () => comments, comment: vi.fn(async () => "u"), patchComment: vi.fn(), issueList: async () => [] },
    charter: { limits: { R: 2, K: 3 } }, thresholds: { quarantine_return_after: 3, quarantine_ttl_days: 7, quarantine_max: 5 },
    now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(async ({ to }) => ({ ok: true, to })), release: vi.fn(),
    quarantine: { quarantined: [] }, saveQuarantine: () => {}, quick: true,
  });

  const fresh = sweepArgs(posted);
  expect(await sweep(fresh)).toEqual([{ kind: "quick-sweep", skipped: ["quarantine", "token-expiry"] }]);
  expect(fresh.transition).not.toHaveBeenCalled();               // 파서가 `last:`를 읽었다 = 살아 있다
  expect(fresh.release).not.toHaveBeenCalled();

  // 같은 writer가 만든, 45분 된 하트비트 — 같은 파서가 그것을 "늦었다"로 읽어야 재큐가 선다
  const stalePosted = [];
  const gh2 = { comment: vi.fn(async (n, body) => { stalePosted.push({ id: 1, body, createdAt: "2026-09-11T00:15:00Z" }); return "https://x/1#issuecomment-42"; }), patchComment: vi.fn(async () => {}) };
  await startHeartbeat({ gh: gh2, issue: 7, stage: "implement", runnerId: "gha-1", intervalMs: 10 * 60e3, now: () => "2026-09-11T00:15:00Z" })
    .then((hb) => hb.stop());
  const stale = sweepArgs(stalePosted);
  const actions = await sweep(stale);
  expect(actions).toContainEqual({ kind: "requeue", issue: 7, count: 1 });
  expect(stale.transition).toHaveBeenCalledWith(expect.objectContaining({ issue: 7, to: "factory:planned" }));
  // 그리고 재큐 코멘트는 파서가 읽어 낸 **그 타임스탬프**를 사람에게 되돌려 준다 — 두 쪽이 같은 값을 본다
  expect(stale.gh.comment.mock.calls[0][1]).toContain("heartbeat stale (2026-09-11T00:15:00Z)");
});

// ── ADR-022 · 진행 신호 ──────────────────────────────────────────────────────

/** Task A가 만드는 progress:v1 스냅샷 하나. 렌더러가 이것만 보고 표를 짓는다. */
const snap = (over = {}) => ({
  stage: "review", issue: 7, runner: "gha-1",
  started: "2026-09-14T10:00:00Z", updated: "2026-09-14T10:03:00Z",
  step: { phase: "R1", label: "R1:architecture", since: "2026-09-14T10:00:00Z" },
  agents: [
    { label: "R1:correctness", kind: "subagent", status: "done", started: "2026-09-14T09:58:00Z", ended: "2026-09-14T10:00:00Z", last_tool: null, turns: 4, input_tokens: 12100, output_tokens: 1900, cache_read_tokens: 0, cost_usd: 0.11 },
    { label: "R1:architecture", kind: "subagent", status: "running", started: "2026-09-14T10:00:00Z", ended: null, last_tool: "Read factory/cli/status.js", turns: 2, input_tokens: 8000, output_tokens: 600, cache_read_tokens: 0, cost_usd: 0.06 },
  ],
  totals: { turns: 6, input_tokens: 41200, output_tokens: 6800, cache_read_tokens: 0, cost_usd: 0.41 },
  files_touched: [],
  ...over,
});

test("the body carries the machine marker AND the human table derived from it", () => {
  const body = heartbeatBody({ issue: 7, stage: "review", runnerId: "gha-1", started: "2026-09-14T10:00:00Z", last: "2026-09-14T10:03:00Z", progress: snap() });
  const lines = body.split("\n");
  expect(lines[0]).toBe("<!-- factory-heartbeat issue=7 -->");
  expect(lines[1]).toBe("stage: review · runner: gha-1 · started: 2026-09-14T10:00:00Z · last: 2026-09-14T10:03:00Z");
  // 마커가 계약이다 — 표는 그 JSON에서 파생될 뿐이다
  expect(parseProgressMarker(body).totals.input_tokens).toBe(41200);
  expect(body).toContain("step: R1 · R1:architecture (3 min) · tokens 41.2k in / 6.8k out · $0.41");
  expect(body).toContain("| agent | status | last tool | in | out |");
  expect(body).toContain("| R1:correctness | ✓ done 2m | — | 12.1k | 1.9k |");
  // 1000 미만은 k를 붙이지 않는다 — "0.6k"는 600보다 덜 정확하면서 더 길다
  expect(body).toContain("| R1:architecture | ● running | Read factory/cli/status.js | 8.0k | 600 |");
});

test("no progress function → exactly the old two-line body (sweeper's parser is untouched)", () => {
  const body = heartbeatBody({ issue: 7, stage: "implement", runnerId: "gha-1", started: "T0", last: "T1" });
  expect(body).toBe("<!-- factory-heartbeat issue=7 -->\nstage: implement · runner: gha-1 · started: T0 · last: T1");
});

test("a failing progress read never breaks the heartbeat — it falls back to the two-line body", async () => {
  vi.useFakeTimers();
  const gh = { comment: vi.fn(async () => "https://x/1#issuecomment-42"), patchComment: vi.fn(async () => {}) };
  let t = 0;
  const hb = await startHeartbeat({
    gh, issue: 7, stage: "review", runnerId: "gha-1", intervalMs: 1000,
    now: () => `T${t}`, progress: () => { throw new Error("agents.jsonl vanished"); },
  });
  expect(gh.comment.mock.calls[0][1]).toBe("<!-- factory-heartbeat issue=7 -->\nstage: review · runner: gha-1 · started: T0 · last: T0");
  t = 1;
  await vi.advanceTimersByTimeAsync(1000);
  expect(gh.patchComment).toHaveBeenCalledTimes(1);
  expect(gh.patchComment.mock.calls[0][1]).not.toContain("factory-progress");
  hb.stop();
  vi.useRealTimers();
});

test("edits are skipped when nothing changed, and resume when it does", async () => {
  vi.useFakeTimers();
  const gh = { comment: vi.fn(async () => "https://x/1#issuecomment-42"), patchComment: vi.fn(async () => {}) };
  let p = snap();
  // `last:`를 고정한다 — 그러면 본문이 바뀌는 유일한 이유가 progress다
  const hb = await startHeartbeat({ gh, issue: 7, stage: "review", runnerId: "gha-1", intervalMs: 1000, now: () => "T0", progress: () => p });
  await vi.advanceTimersByTimeAsync(3000);
  expect(gh.patchComment).not.toHaveBeenCalled();                       // 세 번 깨어났지만 바뀐 게 없다
  p = snap({ totals: { turns: 9, input_tokens: 60000, output_tokens: 9000, cache_read_tokens: 0, cost_usd: 0.7 } });
  await vi.advanceTimersByTimeAsync(1000);
  expect(gh.patchComment).toHaveBeenCalledTimes(1);
  expect(gh.patchComment.mock.calls[0][1]).toContain("60.0k in / 9.0k out");
  hb.stop();
  vi.useRealTimers();
});

test("the default cadence is 2 minutes — a stage is 8–35 min long and 10 min showed almost nothing", async () => {
  expect(HEARTBEAT_INTERVAL_MS).toBe(2 * 60 * 1000);
  vi.useFakeTimers();
  const gh = { comment: vi.fn(async () => "https://x/1#issuecomment-42"), patchComment: vi.fn(async () => {}) };
  let n = 0;
  const hb = await startHeartbeat({ gh, issue: 7, stage: "review", runnerId: "gha-1", now: () => `T${n++}` });
  await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
  expect(gh.patchComment).toHaveBeenCalledTimes(3);
  hb.stop();
  vi.useRealTimers();
});

test("the body stays under the GitHub comment limit; the agent table is truncated and says so", () => {
  const agents = Array.from({ length: 120 }, (_, i) => ({
    label: `R1:role${i}`, kind: "subagent", status: "done", started: "2026-09-14T09:58:00Z", ended: "2026-09-14T10:00:00Z",
    last_tool: "Read " + "deep/path/".repeat(40) + i, turns: 3, input_tokens: 1000, output_tokens: 100, cache_read_tokens: 0, cost_usd: 0.01,
  }));
  const body = heartbeatBody({ issue: 7, stage: "review", runnerId: "gha-1", started: "S", last: "L", progress: snap({ agents, files_touched: Array.from({ length: 30 }, (_, i) => "x".repeat(400) + i) }) });
  expect(Buffer.byteLength(body, "utf8")).toBeLessThan(MAX_COMMENT_BYTES);
  expect(MAX_COMMENT_BYTES).toBe(64 * 1024);
  expect(body).toMatch(/…and \d+ more agents/);
  expect(parseProgressMarker(body).totals.turns).toBe(6);               // 잘려도 합계는 그대로다
});

test("a pipe in a tool argument cannot break the markdown table", () => {
  const body = heartbeatBody({ issue: 7, stage: "review", runnerId: "gha-1", started: "S", last: "L", progress: snap({
    agents: [{ label: "R1:qa", kind: "subagent", status: "running", started: "S", ended: null, last_tool: "Bash grep -n x file | wc -l", turns: 1, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cost_usd: 0 }],
  }) });
  const row = body.split("\n").find((l) => l.startsWith("| R1:qa "));   // 마커 줄에도 "R1:qa"가 있다 — 표의 행만 본다
  expect(row.split(/(?<!\\)\|/)).toHaveLength(7);                       // | label | status | tool | in | out | → 앞뒤 빈 칸 포함 7조각
  expect(row).toContain("\\|");
});
