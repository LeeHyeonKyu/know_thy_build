import { test, expect, vi } from "vitest";
import { startHeartbeat } from "../lib/heartbeat.js";
import { sweep } from "../lib/sweeper.js";

test("posts once, then patches on each tick; stop() clears the timer", async () => {
  vi.useFakeTimers();
  const gh = { comment: vi.fn(async () => "https://x/1#issuecomment-42"), patchComment: vi.fn(async () => {}) };
  const hb = await startHeartbeat({ gh, issue: 7, stage: "implement", runnerId: "gha-1", intervalMs: 1000, now: () => "T0" });
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
