import { test, expect, vi } from "vitest";
import { backPressure } from "../lib/back-pressure.js";
import { sweep } from "../lib/sweeper.js";
import { canTransition } from "../lib/labels.js";

const charter = { limits: { K: 3, M: 3, R: 2 }, back_pressure: { awaiting_review_max: 2 } };
const T = { quarantine_max: 5, quarantine_ttl_days: 28, quarantine_return_after: 30 };

test("backPressure refuses when awaiting-review ≥ max or quarantine over cap", async () => {
  const gh = { searchIssues: vi.fn(async (label) => (label === "factory:awaiting-review" ? [{ number: 1 }, { number: 2 }] : [])) };
  const r = await backPressure({ gh, charter, quarantine: { quarantined: [] }, thresholds: T });
  expect(r.ok).toBe(false); expect(r.reasons[0]).toMatch(/awaiting-review 2 ≥ 2/);
  const r2 = await backPressure({ gh: { searchIssues: async () => [] }, charter, quarantine: { quarantined: new Array(5).fill({}) }, thresholds: T });
  expect(r2.ok).toBe(false); expect(r2.reasons[0]).toMatch(/quarantine/);
});

test("graph gained the sweeper re-queue edge", () => { expect(canTransition("factory:in-progress", "factory:planned")).toBe(true); });

test("sweep: stale heartbeat → release + retry comment + planned; retries exhausted → needs-human; blocked → needs-human", async () => {
  const hb = (last) => ({ id: 9, body: `<!-- factory-heartbeat issue=7 -->\nstage: implement · runner: gha-1 · started: x · last: ${last}`, createdAt: last });
  const gh = {
    searchIssues: vi.fn(async (label) => label === "factory:in-progress" ? [{ number: 7 }, { number: 8 }] : label === "factory:blocked" ? [{ number: 9 }] : []),
    comments: vi.fn(async (n) => n === 7 ? [hb("2026-09-11T00:00:00Z")] : n === 8 ? [hb("2026-09-11T00:00:00Z"), { id: 10, body: "<!-- factory-retry issue=8 count=2 -->", createdAt: "x" }] : []),
    comment: vi.fn(async () => "u#issuecomment-1"), patchComment: vi.fn(async () => {}),
  };
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const release = vi.fn(async () => true);
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition, release, quarantine: { quarantined: [] }, saveQuarantine: () => {} });
  expect(release).toHaveBeenCalledTimes(2);
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ issue: 7, to: "factory:planned" }));
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ issue: 8, to: "factory:needs-human" }));
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ issue: 9, to: "factory:needs-human" }));
  expect(actions.map((a) => a.kind)).toEqual(expect.arrayContaining(["requeue", "retries-exhausted", "blocked-escalated"]));
});

test("sweep: fresh heartbeat is left alone", async () => {
  const gh = { searchIssues: async (l) => (l === "factory:in-progress" ? [{ number: 7 }] : []), comments: async () => [{ id: 1, body: "<!-- factory-heartbeat issue=7 -->\nlast: 2026-09-11T00:50:00Z", createdAt: "x" }], comment: vi.fn(), patchComment: vi.fn() };
  const transition = vi.fn();
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition, release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {} });
  expect(transition).not.toHaveBeenCalled(); expect(actions).toEqual([]);
});

test("sweep: a failing issue is isolated — error recorded, other issues still processed", async () => {
  const hb = (n, last) => ({ id: n, body: `<!-- factory-heartbeat issue=${n} -->\nlast: ${last}`, createdAt: last });
  const gh = {
    searchIssues: vi.fn(async (l) => (l === "factory:in-progress" ? [{ number: 7 }, { number: 8 }] : [])),
    comments: vi.fn(async (n) => [hb(n, "2026-09-11T00:00:00Z")]),
    comment: vi.fn(async () => "u#issuecomment-1"), patchComment: vi.fn(async () => {}),
  };
  const transition = vi.fn(async ({ issue, to }) => { if (issue === 7) throw new Error("gh transition boom"); return { ok: true, to }; });
  const release = vi.fn(async () => true);
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition, release, quarantine: { quarantined: [] }, saveQuarantine: () => {} });
  expect(release).toHaveBeenCalledTimes(2);
  expect(actions).toContainEqual(expect.objectContaining({ kind: "error", issue: 7, error: expect.stringContaining("gh transition boom") }));
  expect(actions).toContainEqual(expect.objectContaining({ kind: "requeue", issue: 8 }));
});

test("sweep: quarantine policy returns entries past consecutive_passes threshold — saveQuarantine called with post-policy state", async () => {
  const gh = { searchIssues: async () => [], comment: vi.fn(), patchComment: vi.fn() };
  const quarantine = { quarantined: [{ id: "x1", consecutive_passes: 30, since: "2026-01-01T00:00:00Z" }] };
  const saveQuarantine = vi.fn();
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), quarantine, saveQuarantine });
  expect(saveQuarantine).toHaveBeenCalledWith({ quarantined: [] });
  expect(actions).toContainEqual({ kind: "quarantine", returned: ["x1"], expired: [] });
});

test("sweep: token issued 400 days ago and no open renewal issue → createIssue titled '토큰 갱신' with factory:needs-human label", async () => {
  const now = "2026-09-11T01:00:00Z";
  const tokenIssuedAt = new Date(Date.parse(now) - 400 * 86400e3).toISOString();
  const gh = {
    searchIssues: vi.fn(async (l) => (l === "factory:needs-human" ? [] : [])),
    comment: vi.fn(), patchComment: vi.fn(),
    createIssue: vi.fn(async ({ title }) => { expect(title).toMatch(/토큰 갱신/); return 101; }),
  };
  const actions = await sweep({ gh, charter, thresholds: T, now, staleMinutes: 30, transition: vi.fn(), release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {}, tokenIssuedAt });
  expect(gh.createIssue).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/토큰 갱신/), labels: expect.arrayContaining(["factory:needs-human"]) }));
  expect(actions).toContainEqual({ kind: "token-expiry", issue: 101 });
});

test("sweep: token expiry is deduped when an open renewal issue already exists", async () => {
  const now = "2026-09-11T01:00:00Z";
  const tokenIssuedAt = new Date(Date.parse(now) - 400 * 86400e3).toISOString();
  const gh = {
    searchIssues: vi.fn(async (l) => (l === "factory:needs-human" ? [{ number: 55, title: "factory: 토큰 갱신 필요 (11개월 경과)" }] : [])),
    comment: vi.fn(), patchComment: vi.fn(),
    createIssue: vi.fn(),
  };
  const actions = await sweep({ gh, charter, thresholds: T, now, staleMinutes: 30, transition: vi.fn(), release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {}, tokenIssuedAt });
  expect(gh.createIssue).not.toHaveBeenCalled();
  expect(actions.some((a) => a.kind === "token-expiry")).toBe(false);
});
