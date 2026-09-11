import { test, expect, vi } from "vitest";
import { startHeartbeat } from "../lib/heartbeat.js";

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
