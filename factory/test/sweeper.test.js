import { test, expect, vi } from "vitest";
import { backPressure } from "../lib/back-pressure.js";
import { sweep, restartComment, blockedRetryComment, harnessUnparkedComment, humanMergedComment, humanMergeRefusedComment, HUMAN_MERGE_REFUSED_MARKER, lockOwnerUnknownComment, API_ERROR_MAX_RETRIES, STALL_NO_HEARTBEAT_MIN, BLOCKED_ESCALATION_REASON } from "../lib/sweeper.js";
import { canTransition } from "../lib/labels.js";
import { BLOCKED_CAUSES, transitionRefusedMarker } from "../lib/retro/issue-comments.js";
import { requirementFor } from "../lib/requirements.js";
import { renderHandoff } from "../lib/handoff.js";
import { resolveReviewRoster, tierFromReviewHandoff } from "../lib/review-roster.js";

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

/**
 * 최종 리뷰 B-nit 1 — 사람-머지 팔은 dep이 하나라도 없으면 **소리를 내고** 건너뛴다(구형 더블이
 * 정확히 그 상태다). 이 파일의 다른 팔들을 보는 단언에서는 그 한 줄을 걷어낸다.
 */
const withoutWiringSkip = (actions) => actions.filter((a) => !String(a?.reason ?? "").startsWith("wiring incomplete:"));

test("sweep: fresh heartbeat is left alone", async () => {
  const gh = { searchIssues: async (l) => (l === "factory:in-progress" ? [{ number: 7 }] : []), comments: async () => [{ id: 1, body: "<!-- factory-heartbeat issue=7 -->\nlast: 2026-09-11T00:50:00Z", createdAt: "x" }], comment: vi.fn(), patchComment: vi.fn() };
  const transition = vi.fn();
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition, release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {} });
  expect(transition).not.toHaveBeenCalled(); expect(withoutWiringSkip(actions)).toEqual([]);
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
  const gh = { searchIssues: async () => [], issueList: async () => [], comment: vi.fn(), patchComment: vi.fn() };
  const quarantine = { quarantined: [{ id: "x1", consecutive_passes: 30, since: "2026-01-01T00:00:00Z" }] };
  const saveQuarantine = vi.fn();
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), quarantine, saveQuarantine });
  expect(saveQuarantine).toHaveBeenCalledWith({ quarantined: [] });
  expect(actions).toContainEqual({ kind: "quarantine", returned: ["x1"], expired: [] });
});

// ── KTB-8: 런 없이 멈춘 스테이지의 재점화 ────────────────────────────────
// 데모 #2는 `factory:ready`에서 하트비트도 blocked 라벨도 없이 영구 정지했다 — 앞의 두 팔 모두에게
// 보이지 않는 상태다. 라벨을 다시 붙여 되살릴 수도 없으므로(같은 라벨은 `labeled` 이벤트를 만들지
// 않는다) 재점화 경로는 `workflow_dispatch` 하나뿐이다.

const TRANSITION = (to, at) => ({ id: 1, body: `<!-- factory-transition:v1 from=factory:queue to=${to} by=script -->\nqueue → ${to}`, createdAt: at });
const stalledArgs = (over = {}) => ({ charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {}, ...over });

test("sweep: an issue stuck on factory:ready past staleMinutes is dispatched to plan exactly once", async () => {
  const posted = [];
  const gh = {
    searchIssues: vi.fn(async (l) => (l === "factory:ready" ? [{ number: 2 }] : [])),
    comments: vi.fn(async () => [TRANSITION("factory:ready", "2026-09-11T00:10:00Z"), ...posted]),
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u#issuecomment-1"; }),
    patchComment: vi.fn(),
  };
  const dispatchStage = vi.fn(async () => {});
  const actions = await sweep(stalledArgs({ gh, dispatchStage }));
  expect(dispatchStage).toHaveBeenCalledWith({ stage: "plan", issue: 2 });
  expect(gh.comment).toHaveBeenCalledWith(2, expect.stringContaining("<!-- factory-sweeper restarted stage=plan issue=2 -->"));
  expect(actions).toContainEqual({ kind: "stalled-restart", issue: 2, stage: "plan", label: "factory:ready" });

  // 같은 창 안의 두 번째 sweep은 마커를 보고 침묵한다 — 30분마다 같은 스테이지를 또 밀지 않는다
  const second = await sweep(stalledArgs({ gh, dispatchStage }));
  expect(dispatchStage).toHaveBeenCalledTimes(1);
  expect(second.some((a) => a.kind === "stalled-restart")).toBe(false);
});

// Task 8 (Structure G) — KTB #3 spec1×2 regression at the sweeper's review re-dispatch. A stalled
// awaiting-review issue whose feature is blocked on an OPEN factory:harness issue must NOT be
// re-dispatched to review: that round would just re-confirm the identical must_fix, because the block is
// in the harness, not the deliverable. (The run-stage review guard would park it anyway; suppressing here
// saves the wasted workflow run.) Detection is the single source of truth used by run-stage too: an open
// factory:harness issue whose body marker `for=<feature>` points at this issue.
test("sweep: a stalled awaiting-review issue blocked on an open harness issue is not re-dispatched to review", async () => {
  const posted = [];
  const gh = {
    searchIssues: vi.fn(async (l) => (l === "factory:awaiting-review" ? [{ number: 3 }] : [])),
    comments: vi.fn(async () => [TRANSITION("factory:awaiting-review", "2026-09-11T00:10:00Z"), ...posted]),
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
    patchComment: vi.fn(),
    issueList: vi.fn(async ({ labels, state }) => (labels?.[0] === "factory:harness" && state === "open"
      ? [{ number: 36, body: "<!-- factory-harness-request for=3 -->\nBlocks: #3" }] : [])),
  };
  const dispatchStage = vi.fn(async () => {});
  const actions = await sweep(stalledArgs({ gh, dispatchStage }));
  expect(dispatchStage).not.toHaveBeenCalled();
  expect(gh.comment).not.toHaveBeenCalled();             // no restart marker spent either
  expect(actions).toContainEqual({ kind: "stalled-restart-skipped", issue: 3, stage: "review", label: "factory:awaiting-review", reason: "blocked on harness issue #36" });
});

// The block-clears / fail-safe direction: with no open harness issue for this feature (e.g. the human
// merged and closed the harness PR) the stalled review is re-dispatched as usual — a missed suppression
// costs one review round, a wrong one strands a reviewable issue, so we only suppress when we are sure.
test("sweep: a stalled awaiting-review issue with no open harness dependency is dispatched to review", async () => {
  const posted = [];
  const gh = {
    searchIssues: vi.fn(async (l) => (l === "factory:awaiting-review" ? [{ number: 3 }] : [])),
    comments: vi.fn(async () => [TRANSITION("factory:awaiting-review", "2026-09-11T00:10:00Z"), ...posted]),
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
    patchComment: vi.fn(),
    issueList: vi.fn(async () => []),                     // harness issue closed → nothing open for #3
  };
  const dispatchStage = vi.fn(async () => {});
  const actions = await sweep(stalledArgs({ gh, dispatchStage }));
  expect(dispatchStage).toHaveBeenCalledWith({ stage: "review", issue: 3 });
  expect(actions).toContainEqual({ kind: "stalled-restart", issue: 3, stage: "review", label: "factory:awaiting-review" });
});

test("sweep: a fresh factory:ready transition, and one whose stage is alive (fresh heartbeat), are left alone", async () => {
  const fresh = {
    searchIssues: async (l) => (l === "factory:ready" ? [{ number: 2 }] : []),
    comments: async () => [TRANSITION("factory:ready", "2026-09-11T00:50:00Z")],
    comment: vi.fn(), patchComment: vi.fn(),
  };
  const d1 = vi.fn();
  expect(withoutWiringSkip(await sweep(stalledArgs({ gh: fresh, dispatchStage: d1 })))).toEqual([]);
  expect(d1).not.toHaveBeenCalled();

  // 전이는 오래됐지만 스테이지가 살아 있다(plan은 37분 동안 `factory:ready`에 머문다) — 하트비트가 증거다
  const alive = {
    searchIssues: async (l) => (l === "factory:ready" ? [{ number: 2 }] : []),
    comments: async () => [
      TRANSITION("factory:ready", "2026-09-11T00:10:00Z"),
      { id: 2, body: "<!-- factory-heartbeat issue=2 -->\nstage: plan · last: 2026-09-11T00:55:00Z", createdAt: "2026-09-11T00:55:00Z" },
    ],
    comment: vi.fn(), patchComment: vi.fn(),
  };
  const d2 = vi.fn();
  expect(withoutWiringSkip(await sweep(stalledArgs({ gh: alive, dispatchStage: d2 })))).toEqual([]);
  expect(d2).not.toHaveBeenCalled();
});

test("sweep: each waiting label maps to its own stage; a failing dispatch is isolated and never commented", async () => {
  const seen = [];
  const gh = {
    searchIssues: vi.fn(async (l) => ({ "factory:planned": [{ number: 3 }], "factory:awaiting-review": [{ number: 4 }], "factory:approved": [{ number: 5 }] }[l] || [])),
    comments: vi.fn(async () => [TRANSITION("x", "2026-09-11T00:00:00Z")]),
    comment: vi.fn(async (n) => { seen.push(n); return "u"; }),
    patchComment: vi.fn(),
  };
  const dispatchStage = vi.fn(async ({ issue }) => { if (issue === 4) throw new Error("gh workflow run boom"); });
  const actions = await sweep(stalledArgs({ gh, dispatchStage }));
  expect(dispatchStage.mock.calls.map((c) => c[0])).toEqual([
    { stage: "implement", issue: 3 }, { stage: "review", issue: 4 }, { stage: "merge", issue: 5 },
  ]);
  expect(actions).toContainEqual({ kind: "error", step: "stalled-restart", issue: 4, error: expect.stringContaining("gh workflow run boom") });
  // 마커는 dispatch **전에** 남는다(KTB-10 M4) — 그래서 dispatch가 실패한 4에도 마커가 있고, 다음
  // sweep은 같은 창 안에서 다시 밀지 않는다. 실패는 "덜 재시작하는 쪽"으로 기운다(재점화는 비싸고,
  // 놓친 재점화는 사람이 `--remote`로 되살릴 수 있다).
  expect(seen).toEqual([3, 4, 5]);
  expect(actions.filter((a) => a.kind === "stalled-restart").map((a) => a.issue)).toEqual([3, 5]);
});

// KTB-10 M4: 순서가 뒤집혀 있으면(dispatch → 코멘트) 코멘트 실패가 dedupe의 유일한 근거를 지운다 —
// 그러면 sweeper가 30분마다 같은 스테이지를 계속 민다(plan 한 번 ~$12).
test("sweep: the restart marker is posted BEFORE the dispatch — a failing comment means no dispatch at all", async () => {
  const order = [];
  const gh = {
    searchIssues: async (l) => (l === "factory:ready" ? [{ number: 2 }] : []),
    comments: async () => [TRANSITION("factory:ready", "2026-09-11T00:10:00Z")],
    comment: vi.fn(async () => { order.push("comment"); return "u"; }),
    patchComment: vi.fn(),
  };
  const dispatchStage = vi.fn(async () => { order.push("dispatch"); });
  await sweep(stalledArgs({ gh, dispatchStage }));
  expect(order).toEqual(["comment", "dispatch"]);

  const boom = { ...gh, comment: vi.fn(async () => { throw new Error("comment API 502"); }) };
  const d2 = vi.fn();
  const actions = await sweep(stalledArgs({ gh: boom, dispatchStage: d2 }));
  expect(d2).not.toHaveBeenCalled();                  // 마커를 못 남겼으면 밀지 않는다
  expect(actions).toContainEqual({ kind: "error", step: "stalled-restart", issue: 2, error: expect.stringContaining("comment API 502") });
});

// KTB-10 M5: `factory:planned`는 implement가 흐름 제어에 걸려 **라벨을 건드리지 않고** 물러났을 때도
// 그대로 남는다 — 멈춘 것이 아니라 일부러 세워 둔 것이다. 밀어 봐야 새 런이 같은 이유로 물러나고
// "다시 띄웠습니다" 코멘트만 30분마다 쌓인다.
test("sweep: an issue parked at factory:planned by back-pressure is skipped — no dispatch, no comment", async () => {
  const gh = {
    searchIssues: async (l) => (l === "factory:planned" ? [{ number: 3 }] : []),
    comments: async () => [TRANSITION("factory:planned", "2026-09-11T00:00:00Z")],
    comment: vi.fn(), patchComment: vi.fn(),
  };
  const dispatchStage = vi.fn();
  const backPressure = vi.fn(async () => ({ ok: false, reasons: ["awaiting-review 4 ≥ 4"] }));
  const actions = await sweep(stalledArgs({ gh, dispatchStage, backPressure }));
  expect(dispatchStage).not.toHaveBeenCalled();
  expect(gh.comment).not.toHaveBeenCalled();
  expect(actions).toContainEqual({ kind: "stalled-restart-skipped", issue: 3, stage: "implement", label: "factory:planned", reason: "back-pressure — awaiting-review 4 ≥ 4" });
  expect(actions.some((a) => a.kind === "stalled-restart")).toBe(false);
});

test("sweep: back-pressure gates only the implement arm, and is asked at most once per sweep", async () => {
  const gh = {
    searchIssues: async (l) => ({ "factory:planned": [{ number: 3 }, { number: 6 }], "factory:awaiting-review": [{ number: 4 }] }[l] || []),
    comments: async () => [TRANSITION("x", "2026-09-11T00:00:00Z")],
    comment: vi.fn(async () => "u"), patchComment: vi.fn(),
  };
  const dispatchStage = vi.fn(async () => {});
  const backPressure = vi.fn(async () => ({ ok: false, reasons: ["quarantine 5 ≥ 5"] }));
  await sweep(stalledArgs({ gh, dispatchStage, backPressure }));
  expect(backPressure).toHaveBeenCalledTimes(1);                  // 이슈마다 다시 묻지 않는다
  expect(dispatchStage.mock.calls.map((c) => c[0])).toEqual([{ stage: "review", issue: 4 }]);

  // 흐름 제어가 열려 있으면 implement도 평소대로 밀린다
  const open = vi.fn(async () => ({ ok: true, reasons: [] }));
  const d2 = vi.fn(async () => {});
  await sweep(stalledArgs({ gh, dispatchStage: d2, backPressure: open }));
  expect(d2.mock.calls.map((c) => c[0])).toEqual([
    { stage: "implement", issue: 3 }, { stage: "implement", issue: 6 }, { stage: "review", issue: 4 },
  ]);
});

test("sweep: no transition comment at all → nothing is dispatched (age unknown is not 'stale')", async () => {
  const gh = {
    searchIssues: async (l) => (l === "factory:ready" ? [{ number: 2 }] : []),
    comments: async () => [{ id: 1, body: "just a human note", createdAt: "2026-01-01T00:00:00Z" }],
    comment: vi.fn(), patchComment: vi.fn(),
  };
  const dispatchStage = vi.fn();
  expect(withoutWiringSkip(await sweep(stalledArgs({ gh, dispatchStage })))).toEqual([]);
  expect(dispatchStage).not.toHaveBeenCalled();
});

test("sweep: with no dispatchStage wired the third arm is inert — waiting labels are not even listed", async () => {
  const gh = { searchIssues: vi.fn(async () => []), comments: vi.fn(), comment: vi.fn(), patchComment: vi.fn() };
  await sweep(stalledArgs({ gh }));
  expect(gh.searchIssues.mock.calls.map((c) => c[0])).toEqual(["factory:in-progress", "factory:blocked"]);
});

// ── KTB-15b: the blocked arm retries the ORIGIN stage once (from the factory-blocked-origin
// marker), then escalates on the next sweep if still blocked ─────────────────────────────────
const BLOCKED_ORIGIN = (from, at) => ({ id: 1, body: `<!-- factory-transition:v1 from=${from} to=factory:blocked by=script -->\n${from} → factory:blocked — x\n<!-- factory-blocked-origin from=${from} stage=x -->`, createdAt: at });

test.each([
  ["factory:approved", "merge"],
  ["factory:ready", "plan"],
  ["factory:queue", "triage"],
  // 최종 리뷰 nit 1: `factory:planned`는 이 표에서 빠졌다 — `planned → blocked` 엣지가 없어
  // 그 origin 마커는 애초에 생길 수 없다(아래 회귀 테스트가 그 사실을 고정한다).
  ["factory:in-progress", "implement"],
])("sweep: blocked from %s dispatches %s once, then escalates on the next sweep if still blocked", async (from, stage) => {
  const posted = [];
  const gh = {
    searchIssues: vi.fn(async (label) => (label === "factory:blocked" ? [{ number: 9 }] : [])),
    comments: vi.fn(async (n) => (n === 9 ? [BLOCKED_ORIGIN(from, "2026-09-11T00:00:00Z"), ...posted] : [])),
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u#issuecomment-1"; }),
    patchComment: vi.fn(),
  };
  const dispatchStage = vi.fn(async () => {});
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const args = { gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition, release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {}, dispatchStage };

  const first = await sweep(args);
  expect(dispatchStage).toHaveBeenCalledWith({ stage, issue: 9 });
  // KTB-19 review I-1: the blocked arm's dedupe marker is its own — NOT the stalled arm's
  // `restartComment` — so a stalled-dispatch-then-blocked episode still gets its one free retry.
  expect(gh.comment).toHaveBeenCalledWith(9, expect.stringContaining(`<!-- factory-sweeper blocked-retry stage=${stage} issue=9 -->`));
  expect(transition).not.toHaveBeenCalledWith(expect.objectContaining({ issue: 9 }));
  expect(first).toContainEqual({ kind: "blocked-retry", issue: 9, stage, cause: "other" });

  // still blocked next sweep — the restart marker is already there, so this time it escalates
  const second = await sweep(args);
  expect(dispatchStage).toHaveBeenCalledTimes(1);
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ issue: 9, to: "factory:needs-human" }));
  expect(second).toContainEqual({ kind: "blocked-escalated", issue: 9, cause: "other" });
});

// KTB-19 review I-1: the canonical failure the fix targets — the stalled arm dispatches merge
// (leaving its OWN `restartComment` marker) for an issue stuck at `factory:approved`, that run
// fails and falls to `factory:blocked` (origin=approved), and the blocked arm should still get its
// one free retry on the next sweep — it must not mistake the stalled arm's marker for its own.
test("sweep: a stalled-arm restart marker for the same stage does not block the blocked arm's own one-time retry", async () => {
  const gh = {
    searchIssues: vi.fn(async (label) => (label === "factory:blocked" ? [{ number: 9 }] : [])),
    comments: vi.fn(async (n) => (n === 9 ? [
      { id: 50, body: `${restartComment("merge", 9)}\n\`factory:approved\`에서 30분 넘게 런 없이 멈춰 있었습니다 — 다시 띄웁니다(KTB-8).`, createdAt: "2026-09-11T00:00:00Z" },
      BLOCKED_ORIGIN("factory:approved", "2026-09-11T00:05:00Z"),
    ] : [])),
    comment: vi.fn(async () => "u#issuecomment-1"),
    patchComment: vi.fn(),
  };
  const dispatchStage = vi.fn(async () => {});
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition, release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {}, dispatchStage });
  expect(dispatchStage).toHaveBeenCalledWith({ stage: "merge", issue: 9 });
  expect(actions).toContainEqual({ kind: "blocked-retry", issue: 9, stage: "merge", cause: "other" });
  expect(transition).not.toHaveBeenCalledWith(expect.objectContaining({ issue: 9 }));
});

// ── KTB-22: an api-error origin gets 3 free retries (spaced by the sweep interval), not 1 ────────
// The origin marker's reason line is what tells sweep this blocked came from a quota/outage
// condition (`claude -p api error …`) rather than the usual "one free retry" case.

const API_ERROR_ORIGIN = (from, stage, at) => ({
  id: 1,
  body: `<!-- factory-transition:v1 from=${from} to=factory:blocked by=script -->\n${from} → factory:blocked — claude -p api error 429: You've hit your org's monthly spend limit\n<!-- factory-blocked-origin from=${from} stage=${stage} -->`,
  createdAt: at,
});

test("sweep: an api-error blocked origin retries 3 times (attempt-numbered markers), then escalates on the 4th sweep", async () => {
  const posted = [];
  const gh = {
    searchIssues: vi.fn(async (label) => (label === "factory:blocked" ? [{ number: 9 }] : [])),
    comments: vi.fn(async (n) => (n === 9 ? [API_ERROR_ORIGIN("factory:in-progress", "implement", "2026-09-12T20:20:00Z"), ...posted] : [])),
    comment: vi.fn(async (n, body) => { posted.push({ id: 99 + posted.length, body, createdAt: "2026-09-12T21:00:00Z" }); return "u#issuecomment-1"; }),
    patchComment: vi.fn(),
  };
  const dispatchStage = vi.fn(async () => {});
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const args = { gh, charter, thresholds: T, now: "2026-09-12T21:00:00Z", staleMinutes: 30, transition, release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {}, dispatchStage };

  for (let attempt = 1; attempt <= API_ERROR_MAX_RETRIES; attempt++) {
    const actions = await sweep(args);
    expect(dispatchStage).toHaveBeenNthCalledWith(attempt, { stage: "implement", issue: 9 });
    expect(gh.comment).toHaveBeenNthCalledWith(attempt, 9, expect.stringContaining(blockedRetryComment("implement", 9, attempt)));
    expect(actions).toContainEqual({ kind: "blocked-retry", issue: 9, stage: "implement", attempt, cause: "api-error" });
    expect(transition).not.toHaveBeenCalledWith(expect.objectContaining({ issue: 9 }));
  }

  // 4th sweep: 3 attempts already on record — escalate, no further dispatch
  const fourth = await sweep(args);
  expect(dispatchStage).toHaveBeenCalledTimes(API_ERROR_MAX_RETRIES);
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ issue: 9, to: "factory:needs-human" }));
  expect(fourth).toContainEqual({ kind: "blocked-escalated", issue: 9, cause: "api-error" });
});

test("sweep: a non-api-error blocked origin still gets exactly one free retry (KTB-15b behaviour unchanged)", async () => {
  const posted = [];
  const gh = {
    searchIssues: vi.fn(async (label) => (label === "factory:blocked" ? [{ number: 9 }] : [])),
    comments: vi.fn(async (n) => (n === 9 ? [BLOCKED_ORIGIN("factory:in-progress", "2026-09-12T20:20:00Z"), ...posted] : [])),
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-12T21:00:00Z" }); return "u#issuecomment-1"; }),
    patchComment: vi.fn(),
  };
  const dispatchStage = vi.fn(async () => {});
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const args = { gh, charter, thresholds: T, now: "2026-09-12T21:00:00Z", staleMinutes: 30, transition, release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {}, dispatchStage };

  await sweep(args);
  expect(dispatchStage).toHaveBeenCalledTimes(1);
  const second = await sweep(args);
  expect(dispatchStage).toHaveBeenCalledTimes(1);
  expect(second).toContainEqual({ kind: "blocked-escalated", issue: 9, cause: "other" });
});

test("sweep: blocked with no factory-blocked-origin marker at all escalates immediately (no dispatch)", async () => {
  const gh = {
    searchIssues: vi.fn(async (label) => (label === "factory:blocked" ? [{ number: 10 }] : [])),
    comments: vi.fn(async () => [{ id: 1, body: "a human note, no marker", createdAt: "x" }]),
    comment: vi.fn(), patchComment: vi.fn(),
  };
  const dispatchStage = vi.fn();
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition, release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {}, dispatchStage });
  expect(dispatchStage).not.toHaveBeenCalled();
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ issue: 10, to: "factory:needs-human" }));
  expect(actions).toContainEqual({ kind: "blocked-escalated", issue: 10, cause: null });
});

// ── 격리 이탈 코멘트(Plan 1b 이월) ────────────────────────────────────────
// `quarantine.toml`은 "지금 격리된 것"만 담으므로 복귀·만료는 그 순간 어디에도 남지 않는다 — 이력은
// 사람이 보는 flaky 이슈에 남아야 하고, retro는 그 `expired` 코멘트만으로 만료를 안다(P4-R3).

test("sweep: returned/expired ids get a marker comment on their flaky issue — closed issues included", async () => {
  const gh = {
    searchIssues: vi.fn(async () => []),
    // 라벨로 좁힌 목록 + state:"all" — 사람이 닫아 둔 flaky 이슈에도 만료 사실을 남긴다
    issueList: vi.fn(async ({ labels, state }) => (labels?.[0] === "factory:flaky" && state === "all"
      ? [{ number: 21, title: "flaky: test/a.test.js > sorts", state: "OPEN" }, { number: 22, title: "flaky: test/b.test.js > ticks", closedAt: "2026-09-01T00:00:00Z" }]
      : [])),
    comments: vi.fn(async () => []),
    comment: vi.fn(async () => "u#issuecomment-1"), patchComment: vi.fn(),
  };
  const quarantine = { quarantined: [
    { id: "test/a.test.js > sorts", consecutive_passes: 30, since: "2026-09-01T00:00:00Z" },
    { id: "test/b.test.js > ticks", consecutive_passes: 0, since: "2026-01-01T00:00:00Z" },
  ] };
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), quarantine, saveQuarantine: () => {} });
  expect(gh.comment).toHaveBeenCalledWith(21, expect.stringContaining("<!-- factory-quarantine returned id=test/a.test.js > sorts -->"));
  expect(gh.comment).toHaveBeenCalledWith(22, expect.stringContaining("<!-- factory-quarantine expired id=test/b.test.js > ticks -->"));
  expect(actions).toContainEqual({ kind: "quarantine-comment", state: "returned", id: "test/a.test.js > sorts", issue: 21 });
  expect(actions).toContainEqual({ kind: "quarantine-comment", state: "expired", id: "test/b.test.js > ticks", issue: 22 });
  // 정책 적용 자체는 그대로 — 코멘트는 부수 효과다.
  expect(actions).toContainEqual({ kind: "quarantine", returned: ["test/a.test.js > sorts"], expired: ["test/b.test.js > ticks"] });
  expect(gh.issueList).toHaveBeenCalledWith({ labels: ["factory:flaky"], state: "all" });
});

test("sweep: quarantine-exit comments are best-effort — no matching issue, and a failing comment, are isolated per id", async () => {
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async () => [{ number: 31, title: "flaky: x1" }]),
    comments: vi.fn(async () => []),
    comment: vi.fn(async (n) => { if (n === 31) throw new Error("gh comment boom"); return "u"; }),
    patchComment: vi.fn(),
  };
  const quarantine = { quarantined: [
    { id: "x1", since: "2026-01-01T00:00:00Z" },        // 만료 + 이슈 있음 → 코멘트가 던진다
    { id: "x2", since: "2026-01-02T00:00:00Z" },        // 만료 + 이슈 없음 → skipped
  ] };
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), quarantine, saveQuarantine: vi.fn() });
  expect(actions).toContainEqual({ kind: "error", step: "quarantine-comment", id: "x1", error: expect.stringContaining("gh comment boom") });
  expect(actions).toContainEqual({ kind: "quarantine-comment-skipped", state: "expired", id: "x2", reason: "no flaky issue" });
  expect(actions.some((a) => a.kind === "quarantine")).toBe(true);
});

// ── F1(최종 리뷰): 만료 알림은 딱 한 번 ───────────────────────────────────
// `applyPolicy`는 만료 항목을 `quarantine.toml`에 **남긴다**(게이트 제외를 계속하려면 남아야 한다) —
// 그래서 다음 sweep도 같은 항목을 다시 만료로 판정한다. 코멘트를 그때마다 또 달면 이슈가 같은 문장으로
// 도배되고, retro는 매 창마다 "새 만료"를 보고 재작성 이슈를 영원히 다시 만든다. 이미 그 id에 대한
// 마커가 이슈에 있으면 말하지 않는다 — 마커가 곧 "이미 알렸다"는 기록이다.

test("sweep: an expired entry is announced once — the second sweep over the same entry says nothing", async () => {
  const issue = { number: 41, title: "flaky: x1", state: "OPEN" };
  const posted = [];
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async () => [issue]),
    comments: vi.fn(async () => posted.map((body, i) => ({ id: i, body, createdAt: "2026-09-11T01:00:00Z" }))),
    comment: vi.fn(async (n, body) => { posted.push(body); return "u#issuecomment-1"; }),
    patchComment: vi.fn(),
  };
  // 만료 항목은 정책 적용 후에도 파일에 남는다 — 두 번째 sweep이 같은 판정을 다시 내린다
  const quarantine = () => ({ quarantined: [{ id: "x1", since: "2026-01-01T00:00:00Z", consecutive_passes: 0 }] });
  const args = { gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), saveQuarantine: vi.fn() };

  const first = await sweep({ ...args, quarantine: quarantine() });
  expect(first).toContainEqual({ kind: "quarantine-comment", state: "expired", id: "x1", issue: 41 });

  const second = await sweep({ ...args, quarantine: quarantine() });
  expect(gh.comment).toHaveBeenCalledTimes(1);
  expect(posted).toHaveLength(1);
  expect(second).toContainEqual({ kind: "quarantine-comment-skipped", state: "expired", id: "x1", issue: 41, reason: "already notified" });
  // 정책 적용 자체는 계속 일어난다 — 침묵하는 것은 알림뿐이다
  expect(second).toContainEqual({ kind: "quarantine", returned: [], expired: ["x1"] });
});

test("sweep: the marker of a *different* id, and a re-registration, do not silence a new notification", async () => {
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async () => [{ number: 42, title: "flaky: x2", state: "OPEN" }]),
    // 다른 id의 만료 마커 + 이 id의 옛 만료 마커 뒤에 온 **재등록** 마커(retro가 남긴다)
    comments: vi.fn(async () => [
      { id: 1, body: "<!-- factory-quarantine expired id=other -->", createdAt: "2026-09-01T00:00:00Z" },
      { id: 2, body: "<!-- factory-quarantine expired id=x2 -->", createdAt: "2026-09-02T00:00:00Z" },
      { id: 3, body: "<!-- factory-quarantine registered id=x2 -->", createdAt: "2026-09-03T00:00:00Z" },
    ]),
    comment: vi.fn(async () => "u#issuecomment-1"), patchComment: vi.fn(),
  };
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), saveQuarantine: vi.fn(), quarantine: { quarantined: [{ id: "x2", since: "2026-01-01T00:00:00Z" }] } });
  expect(gh.comment).toHaveBeenCalledWith(42, expect.stringContaining("<!-- factory-quarantine expired id=x2 -->"));
  expect(actions).toContainEqual({ kind: "quarantine-comment", state: "expired", id: "x2", issue: 42 });
});

test("sweep: a failing comment read is isolated per id — the policy still applied, nothing posted twice", async () => {
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async () => [{ number: 43, title: "flaky: x3" }]),
    comments: vi.fn(async () => { throw new Error("gh comments boom"); }),
    comment: vi.fn(), patchComment: vi.fn(),
  };
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), saveQuarantine: vi.fn(), quarantine: { quarantined: [{ id: "x3", since: "2026-01-01T00:00:00Z" }] } });
  // 이미 알렸는지 알 수 없으면 말하지 않는다 — 다음 sweep이 다시 시도한다(중복보다 늦음이 낫다)
  expect(gh.comment).not.toHaveBeenCalled();
  expect(actions).toContainEqual({ kind: "error", step: "quarantine-comment", id: "x3", error: expect.stringContaining("gh comments boom") });
  expect(actions.some((a) => a.kind === "quarantine")).toBe(true);
});

test("sweep: nothing left quarantine → no flaky issue lookup at all", async () => {
  const gh = { searchIssues: vi.fn(async () => []), issueList: vi.fn(async () => []), comment: vi.fn(), patchComment: vi.fn() };
  await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), quarantine: { quarantined: [{ id: "keep", since: "2026-09-10T00:00:00Z", consecutive_passes: 0 }] }, saveQuarantine: vi.fn() });
  // KTB-18's label-set-repair arm always scans open issues — but never with a flaky-label filter.
  expect(gh.issueList).toHaveBeenCalledWith({ state: "open" });
  expect(gh.issueList.mock.calls.some(([a]) => a?.labels?.includes?.("factory:flaky"))).toBe(false);
  expect(gh.comment).not.toHaveBeenCalled();
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

test("sweep: a failing flaky-issue lookup is isolated — the policy still applied, only the comments are lost", async () => {
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async () => { throw new Error("gh issue list boom"); }),
    comment: vi.fn(), patchComment: vi.fn(),
  };
  const saveQuarantine = vi.fn();
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), quarantine: { quarantined: [{ id: "x1", since: "2026-01-01T00:00:00Z" }] }, saveQuarantine });
  // 만료 항목은 quarantine.toml에 **남는다**(applyPolicy는 플래그만 낸다) — 그래서 만료 사실의 유일한
  // 기록이 이슈 코멘트이고, 그 코멘트를 못 남기면 retro는 만료를 영영 알 수 없다.
  expect(saveQuarantine).toHaveBeenCalledWith({ quarantined: [{ id: "x1", since: "2026-01-01T00:00:00Z" }] });
  expect(actions).toContainEqual({ kind: "quarantine", returned: [], expired: ["x1"] });
  expect(actions).toContainEqual({ kind: "error", step: "quarantine-comment", error: expect.stringContaining("gh issue list boom") });
  expect(gh.comment).not.toHaveBeenCalled();
});

// ── KTB-18: label-set repair — a hand-applied label leaving 2+ factory state labels ─────────────
// The probe: a human applied `factory:approved` to an issue that still carried `backlog`.
// `run-stage` now refuses and comments (see run-stage.test.js), but it never touches the labels
// (the state is ambiguous) — the issue would sit with two labels forever unless something repairs
// it. The sweeper is that something: L1 repairing a hand edit.

const openIssue = (number, labels) => ({ number, title: `issue ${number}`, labels });

test("sweep: an open issue with 2 factory state labels is repaired to factory:needs-human (other states removed, tier kept)", async () => {
  const setFactoryLabel = vi.fn(async () => {});
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async ({ state }) => (state === "open" ? [openIssue(14, ["backlog", "factory:approved", "factory:tier-standard"])] : [])),
    comments: vi.fn(async () => []),
    comment: vi.fn(async () => "u#issuecomment-1"),
    patchComment: vi.fn(),
    setFactoryLabel,
  };
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {} });
  expect(setFactoryLabel).toHaveBeenCalledWith(14, "factory:needs-human");
  expect(gh.comment).toHaveBeenCalledWith(14, expect.stringContaining("<!-- factory-label-set-repaired from=backlog,factory:approved -->"));
  expect(actions).toContainEqual({ kind: "label-set-repaired", issue: 14, from: ["backlog", "factory:approved"] });
});

test("sweep: an open issue with a single factory state label is left untouched", async () => {
  const setFactoryLabel = vi.fn(async () => {});
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async () => [openIssue(15, ["factory:ready", "factory:tier-standard"])]),
    comments: vi.fn(async () => []),
    comment: vi.fn(async () => "u"),
    patchComment: vi.fn(),
    setFactoryLabel,
  };
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {} });
  expect(setFactoryLabel).not.toHaveBeenCalled();
  expect(gh.comment).not.toHaveBeenCalled();
  expect(actions.some((a) => a.kind === "label-set-repaired")).toBe(false);
});

test("sweep: an already-repaired issue (marker present) is skipped — no re-comment, no re-label", async () => {
  const setFactoryLabel = vi.fn(async () => {});
  const marker = "<!-- factory-label-set-repaired from=backlog,factory:approved -->";
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async () => [openIssue(16, ["backlog", "factory:approved"])]),
    comments: vi.fn(async (n) => (n === 16 ? [{ id: 1, body: `${marker}\n이미 복구했습니다.`, createdAt: "x" }] : [])),
    comment: vi.fn(async () => "u"),
    patchComment: vi.fn(),
    setFactoryLabel,
  };
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {} });
  expect(setFactoryLabel).not.toHaveBeenCalled();
  expect(gh.comment).not.toHaveBeenCalled();
  expect(actions).toContainEqual({ kind: "label-set-repair-skipped", issue: 16, reason: "already repaired" });
});

test("sweep: label-set repair isolates a failing issue — one bad apple doesn't stop the rest", async () => {
  const setFactoryLabel = vi.fn(async (n) => { if (n === 17) throw new Error("gh label boom"); });
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async () => [openIssue(17, ["backlog", "factory:approved"]), openIssue(18, ["backlog", "factory:queue"])]),
    comments: vi.fn(async () => []),
    comment: vi.fn(async () => "u"),
    patchComment: vi.fn(),
    setFactoryLabel,
  };
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {} });
  expect(actions).toContainEqual({ kind: "error", step: "label-set-repair", issue: 17, error: expect.stringContaining("gh label boom") });
  expect(actions).toContainEqual({ kind: "label-set-repaired", issue: 18, from: ["backlog", "factory:queue"] });
});

test("sweep: label-set repair is inert when gh.issueList isn't wired (older test doubles) — no error, no crash", async () => {
  const gh = { searchIssues: vi.fn(async () => []), comment: vi.fn(), patchComment: vi.fn() };
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {} });
  expect(withoutWiringSkip(actions)).toEqual([]);
});

test("sweep: a failing gh.issueList for label-set repair is isolated — recorded, sweep still completes", async () => {
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async () => { throw new Error("gh issue list boom"); }),
    comment: vi.fn(), patchComment: vi.fn(),
  };
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {} });
  expect(actions).toContainEqual({ kind: "error", step: "label-set-repair", error: expect.stringContaining("gh issue list boom") });
});

// ── ADR-020 KTB-30 — 상태 라벨이 **0개**인 이슈를 되살린다 ──────────────────────────────────────
// 데모에서 두 번 났다(#2 08:52Z, #15 08:55Z): remove+add 한 번짜리 라벨 스왑이 중간에 실패해 상태
// 라벨이 하나도 남지 않았다. 그 이슈는 `labeled` 이벤트도 못 만들고, 모든 sweeper 팔이 상태 라벨로
// 검색하므로 아무도 다시 보지 않는다 — sweeper를 통째로 빠져나가는 유일한 실패였다.

const TRANSITION_COMMENT = (from, to, at) => ({ id: 7, body: `<!-- factory-transition:v1 from=${from} to=${to} by=script -->\n${from} → ${to}`, createdAt: at });
const zeroLabelArgs = (over = {}) => ({ gh: over.gh, charter, thresholds: T, now: "2026-09-13T09:00:00Z", staleMinutes: 30, transition: vi.fn(), release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {}, ...over });

test("KTB-30: an open factory issue with NO state label is restored to the `to` of its latest transition", async () => {
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async () => [{ ...openIssue(2, ["factory:tier-standard"]), updatedAt: "2026-09-13T08:52:00Z" }]),
    comments: vi.fn(async () => [TRANSITION_COMMENT("factory:planned", "factory:in-progress", "2026-09-13T08:52:00Z")]),
    comment: vi.fn(async () => "u"),
    patchComment: vi.fn(),
    setFactoryLabel: vi.fn(async () => ({ verify: "ok" })),
  };
  const actions = await sweep(zeroLabelArgs({ gh }));
  expect(gh.setFactoryLabel).toHaveBeenCalledWith(2, "factory:in-progress");
  expect(gh.comment).toHaveBeenCalledWith(2, expect.stringContaining("<!-- factory-label-set-repaired from=(none) to=factory:in-progress -->"));
  expect(actions).toContainEqual({ kind: "state-label-restored", issue: 2, to: "factory:in-progress" });
});

test("KTB-30: with no transition comment to restore from, a label-less factory issue goes to needs-human", async () => {
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async () => [{ ...openIssue(3, ["factory:harness"]), updatedAt: "2026-09-13T08:52:00Z" }]),
    comments: vi.fn(async () => [{ id: 1, body: "사람이 쓴 코멘트", createdAt: "2026-09-13T08:00:00Z" }]),
    comment: vi.fn(async () => "u"),
    patchComment: vi.fn(),
    setFactoryLabel: vi.fn(async () => ({ verify: "ok" })),
  };
  const actions = await sweep(zeroLabelArgs({ gh }));
  expect(gh.setFactoryLabel).toHaveBeenCalledWith(3, "factory:needs-human");
  expect(actions).toContainEqual({ kind: "state-label-restored", issue: 3, to: "factory:needs-human" });
});

test("KTB-30: an issue with a transition comment but no factory label at all is still restored", async () => {
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async () => [{ ...openIssue(4, ["bug"]), updatedAt: "2026-09-13T08:55:00Z" }]),
    comments: vi.fn(async () => [TRANSITION_COMMENT("factory:awaiting-review", "factory:rework", "2026-09-13T08:55:00Z")]),
    comment: vi.fn(async () => "u"),
    patchComment: vi.fn(),
    setFactoryLabel: vi.fn(async () => ({ verify: "ok" })),
  };
  const actions = await sweep(zeroLabelArgs({ gh }));
  expect(actions).toContainEqual({ kind: "state-label-restored", issue: 4, to: "factory:rework" });
});

test("KTB-30: a plain non-factory issue (no factory label, no transition comment) is never touched", async () => {
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async () => [{ ...openIssue(5, ["bug"]), updatedAt: "2026-09-13T08:55:00Z" }]),
    comments: vi.fn(async () => [{ id: 1, body: "사람이 쓴 코멘트", createdAt: "x" }]),
    comment: vi.fn(async () => "u"),
    patchComment: vi.fn(),
    setFactoryLabel: vi.fn(async () => ({ verify: "ok" })),
  };
  const actions = await sweep(zeroLabelArgs({ gh }));
  expect(gh.setFactoryLabel).not.toHaveBeenCalled();
  expect(actions.some((a) => a.kind === "state-label-restored")).toBe(false);
});

test("KTB-30: the zero-label repair dedupes on its marker within 10 minutes", async () => {
  const prior = { id: 9, body: "<!-- factory-label-set-repaired from=(none) to=factory:in-progress -->\n복구했습니다.", createdAt: "2026-09-13T08:55:00Z" };
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async () => [{ ...openIssue(2, ["factory:tier-standard"]), updatedAt: "2026-09-13T08:55:00Z" }]),
    comments: vi.fn(async () => [TRANSITION_COMMENT("factory:planned", "factory:in-progress", "2026-09-13T08:52:00Z"), prior]),
    comment: vi.fn(async () => "u"),
    patchComment: vi.fn(),
    setFactoryLabel: vi.fn(async () => ({ verify: "ok" })),
  };
  // 09:00Z — 마커는 5분 전 것이다: 다시 손대지 않는다
  const within = await sweep(zeroLabelArgs({ gh }));
  expect(gh.setFactoryLabel).not.toHaveBeenCalled();
  expect(within).toContainEqual({ kind: "state-label-restore-skipped", issue: 2, reason: "repaired within 10m" });
  // 09:10Z 이후 — 같은 이슈가 **여전히** 라벨이 없다면 그건 새 사고다: 다시 고친다
  const after = await sweep(zeroLabelArgs({ gh, now: "2026-09-13T09:20:00Z" }));
  expect(gh.setFactoryLabel).toHaveBeenCalledWith(2, "factory:in-progress");
  expect(after).toContainEqual({ kind: "state-label-restored", issue: 2, to: "factory:in-progress" });
});

// KTB-30: add-first 스왑이 부분 실패하면 남는 것은 **상태 라벨 2개**다 — 그건 사람의 손 편집이 아니라
// 기계의 잔해이고, 어느 쪽이 진짜인지도 안다(최신 전이의 `to`). needs-human으로 접지 않고 그대로 잇는다.
test("KTB-30: exactly two state labels whose newer one is the latest transition's `to` → the older one is removed, no needs-human", async () => {
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async () => [openIssue(2, ["factory:planned", "factory:in-progress", "factory:tier-standard"])]),
    comments: vi.fn(async () => [TRANSITION_COMMENT("factory:planned", "factory:in-progress", "2026-09-13T08:52:00Z")]),
    comment: vi.fn(async () => "u"),
    patchComment: vi.fn(),
    setFactoryLabel: vi.fn(async () => ({ verify: "ok" })),
  };
  const actions = await sweep(zeroLabelArgs({ gh }));
  expect(gh.setFactoryLabel).toHaveBeenCalledWith(2, "factory:in-progress");
  expect(gh.comment).toHaveBeenCalledWith(2, expect.stringContaining("<!-- factory-label-set-repaired from=factory:planned,factory:in-progress to=factory:in-progress -->"));
  expect(actions).toContainEqual({ kind: "label-set-repaired", issue: 2, from: ["factory:planned", "factory:in-progress"], to: "factory:in-progress" });
});

test("KTB-30: two state labels with no transition backing them still collapse to needs-human (KTB-18 unchanged)", async () => {
  const gh = {
    searchIssues: vi.fn(async () => []),
    issueList: vi.fn(async () => [openIssue(14, ["backlog", "factory:approved"])]),
    comments: vi.fn(async () => []),
    comment: vi.fn(async () => "u"),
    patchComment: vi.fn(),
    setFactoryLabel: vi.fn(async () => ({ verify: "ok" })),
  };
  const actions = await sweep(zeroLabelArgs({ gh }));
  expect(gh.setFactoryLabel).toHaveBeenCalledWith(14, "factory:needs-human");
  expect(actions).toContainEqual({ kind: "label-set-repaired", issue: 14, from: ["backlog", "factory:approved"] });
});

// ── ADR-020 O20 — blocked의 **원인 등급**이 재시도 예산과 에스컬레이션 문구를 가른다 ─────────────
const CAUSE_ORIGIN = (from, stage, cause, reason, at) => ({
  id: 1,
  body: `<!-- factory-transition:v1 from=${from} to=factory:blocked by=script -->\n${from} → factory:blocked — ${reason}\n<!-- factory-blocked-origin from=${from} stage=${stage} cause=${cause} -->`,
  createdAt: at,
});

test("O20: a cancelled origin is retried once per cancel — a second cancel gets its own retry (R budget untouched)", async () => {
  const posted = [];
  let origins = [CAUSE_ORIGIN("factory:awaiting-review", "review", "cancelled", "job cancelled — retry via sweeper", "2026-09-13T08:00:00Z")];
  const gh = {
    searchIssues: vi.fn(async (l) => (l === "factory:blocked" ? [{ number: 15 }] : [])),
    comments: vi.fn(async () => [...origins, ...posted].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))),
    comment: vi.fn(async (n, body) => { posted.push({ id: 99 + posted.length, body, createdAt: "2026-09-13T08:30:00Z" }); return "u"; }),
    patchComment: vi.fn(), issueList: async () => [],
  };
  const dispatchStage = vi.fn(async () => {});
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const args = { gh, charter, thresholds: T, now: "2026-09-13T09:00:00Z", staleMinutes: 30, transition, release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {}, dispatchStage };

  const first = await sweep(args);
  expect(dispatchStage).toHaveBeenCalledWith({ stage: "review", issue: 15 });
  expect(first).toContainEqual({ kind: "blocked-retry", issue: 15, stage: "review", cause: "cancelled" });
  // 같은 취소 사건 안에서는 한 번뿐이다
  const second = await sweep(args);
  expect(dispatchStage).toHaveBeenCalledTimes(1);
  expect(second).toContainEqual({ kind: "blocked-escalated", issue: 15, cause: "cancelled" });
  // 사람이 **다시** 취소했다 = 새 사건: 다시 한 번 민다(예산을 쓰지 않는다)
  origins = [...origins, CAUSE_ORIGIN("factory:awaiting-review", "review", "cancelled", "job cancelled — retry via sweeper", "2026-09-13T09:30:00Z")];
  const third = await sweep({ ...args, now: "2026-09-13T10:00:00Z" });
  expect(dispatchStage).toHaveBeenCalledTimes(2);
  expect(third).toContainEqual({ kind: "blocked-retry", issue: 15, stage: "review", cause: "cancelled", attempt: 2 });
});

test("O20: the escalation reason names the cause instead of the generic environment/credentials line", async () => {
  const escalated = async (cause, reason) => {
    const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
    const gh = {
      searchIssues: vi.fn(async (l) => (l === "factory:blocked" ? [{ number: 9 }] : [])),
      comments: vi.fn(async () => [CAUSE_ORIGIN("backlog", "triage", cause, reason, "2026-09-13T08:00:00Z")]),
      comment: vi.fn(async () => "u"), patchComment: vi.fn(), issueList: async () => [],
    };
    await sweep({ gh, charter, thresholds: T, now: "2026-09-13T09:00:00Z", staleMinutes: 30, transition, release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {} });
    return transition.mock.calls[0][0].reason;
  };
  // `backlog` origin은 재시도 표에 없다 — 곧장 에스컬레이션 경로다
  expect(await escalated("cancelled", "job cancelled — retry via sweeper")).toBe("blocked (job cancelled) — needs human");
  expect(await escalated("timeout", "job timed_out — retry via sweeper")).toBe("blocked (job timed out) — needs human");
  expect(await escalated("api-error", "claude -p api error 429")).toBe("blocked (API quota/outage) — needs human");
  expect(await escalated("gates", "gates file status is BLOCKED")).toBe("blocked (gates undecided) — needs human");
  expect(await escalated("undecidable", "cannot compute merge-base")).toBe("blocked (undecidable) — needs human");
  expect(await escalated("other", "something else entirely")).toBe("blocked (environment/credentials) — needs human");
});

// ── ADR-020 KTB-26 — `--quick`: 스테이지 잡이 끝날 때마다 도는 이벤트 구동 sweep ────────────────
test("KTB-26 quick sweep: the state-recovery arms still run, the time-bound arms do not", async () => {
  const stale = { id: 1, body: "<!-- factory-heartbeat issue=7 -->\nlast: 2026-09-11T00:00:00Z", createdAt: "2026-09-11T00:00:00Z" };
  const gh = {
    searchIssues: async (l) => (l === "factory:in-progress" ? [{ number: 7 }] : []),
    comments: async () => [stale],
    comment: vi.fn(async () => "u#issuecomment-1"),
    issueList: async () => [],
    createIssue: vi.fn(),
  };
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const saveQuarantine = vi.fn();
  // 만료가 확정된 격리 항목 + 11개월 지난 토큰 — 일반 sweep이라면 둘 다 움직인다
  const quarantine = { quarantined: [{ id: "t1", since: "2020-01-01T00:00:00Z", consecutive_passes: 0 }] };
  const common = { gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition, release: vi.fn(async () => true), quarantine, saveQuarantine, tokenIssuedAt: "2020-01-01T00:00:00Z" };

  const quickActions = await sweep({ ...common, quick: true });
  expect(quickActions.map((a) => a.kind)).toContain("requeue");                 // 상태 복구 팔은 돈다
  expect(quickActions.map((a) => a.kind)).not.toContain("quarantine");
  expect(quickActions.map((a) => a.kind)).not.toContain("token-expiry");
  // 이 줄은 실제로 건너뛴 것을 말한다 — KTB-46의 사람-머지 반영 팔도 cron 전용이다(r5 nit 5).
  expect(quickActions[0]).toEqual({ kind: "quick-sweep", skipped: ["quarantine", "token-expiry", "human-merged"] });
  expect(saveQuarantine).not.toHaveBeenCalled();
  expect(gh.createIssue).not.toHaveBeenCalled();

  // 같은 입력을 cron sweep으로 돌리면 격리·토큰 팔이 실제로 움직인다(이 테스트가 "quick이 뭘 껐는지"의 대조군)
  const fullActions = await sweep({ ...common, quick: false });
  expect(fullActions.map((a) => a.kind)).toContain("quarantine");
  expect(saveQuarantine).toHaveBeenCalled();
  expect(gh.createIssue).toHaveBeenCalled();
});

// 이제 sweep은 cron 하나가 아니라 스테이지마다 돈다 — 두 sweep이 같은 이슈를 같은 초에 볼 수 있고,
// `gh workflow run`은 그때 실패할 수 있다. 그 실패가 그 이슈의 나머지 처리를 접으면 안 된다.
test("KTB-26: a dispatch failure is recorded and the sweep keeps going", async () => {
  const old = "2026-09-11T00:00:00Z";
  const transitionComment = { id: 1, body: "<!-- factory-transition:v1 from=factory:ready to=factory:planned by=script -->", createdAt: old };
  const gh = {
    searchIssues: async (l) => (l === "factory:planned" ? [{ number: 4 }, { number: 5 }] : []),
    comments: async () => [transitionComment],
    comment: vi.fn(async () => "u#issuecomment-1"),
    issueList: async () => [],
  };
  const dispatchStage = vi.fn(async ({ issue }) => { if (issue === 4) throw new Error("HTTP 422 workflow dispatch"); });
  const actions = await sweep({
    gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30,
    transition: vi.fn(async () => ({ ok: true })), release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {},
    dispatchStage, backPressure: async () => ({ ok: true }), quick: true,
  });
  expect(dispatchStage).toHaveBeenCalledTimes(2);                               // 4에서 죽지 않고 5까지 간다
  expect(actions).toContainEqual(expect.objectContaining({ kind: "error", step: "stalled-restart", issue: 4 }));
  expect(actions).toContainEqual(expect.objectContaining({ kind: "stalled-restart", issue: 5, stage: "implement" }));
  // 실패한 쪽은 "다시 띄웠다"로 적히지 않는다
  expect(actions.filter((a) => a.kind === "stalled-restart").map((a) => a.issue)).toEqual([5]);
});

// ── ADR-020 KTB-23 fix — 하네스 주차의 해제는 sweeper의 일이다 ──────────────────────────────────
// KTB-23은 해제를 merge 스테이지 단계 (9)에만 두었는데, 하네스 PR은 **구성상** 보호 경로를 건드려
// merge가 단계 (3)에서 자동 머지를 거부하고 사람에게 넘긴다 — 단계 (9)는 그 경로에서 아예 실행되지
// 않는다. 즉 설계대로 도는 모든 하네스 이슈에서 주차된 피처가 영원히 돌아오지 않았다.
const parkComment = (harness, at = "2026-09-11T00:00:00Z") => ({
  id: 1,
  body: `<!-- factory-transition:v1 from=factory:in-progress to=factory:needs-info by=script -->\nfactory:in-progress → factory:needs-info — waiting for harness issue #${harness}`,
  createdAt: at,
});
const unparkArgs = (over = {}) => ({
  gh: { searchIssues: async () => [], comments: async () => [], comment: vi.fn(), patchComment: vi.fn(), issueList: async () => [] },
  charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30,
  transition: vi.fn(async ({ to }) => ({ ok: true, to })), release: vi.fn(),
  quarantine: { quarantined: [] }, saveQuarantine: () => {}, quick: true,
  ...over,
});

test("KTB-23 fix: a needs-info issue parked on a CLOSED harness issue goes back to the queue, once", async () => {
  const posted = [];
  const gh = {
    searchIssues: vi.fn(async (l) => (l === "factory:needs-info" ? [{ number: 2 }] : [])),
    comments: vi.fn(async () => [parkComment(31), ...posted]),
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
    patchComment: vi.fn(), issueList: async () => [],
  };
  const harnessSettled = vi.fn(async () => ({ done: true, why: "이슈가 닫혔습니다" }));
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const actions = await sweep(unparkArgs({ gh, harnessSettled, transition }));
  expect(harnessSettled).toHaveBeenCalledWith(31);
  expect(transition).toHaveBeenCalledWith({ issue: 2, to: "factory:queue", reason: "harness issue #31 closed" });
  expect(gh.comment).toHaveBeenCalledWith(2, expect.stringContaining(harnessUnparkedComment(31, 2)));
  expect(actions).toContainEqual({ kind: "harness-unparked", issue: 2, harness: 31 });

  // 마커가 dedupe다 — 전이가 어떤 이유로 다시 이 이슈를 needs-info로 돌려놔도 두 번 풀지 않는다
  const second = await sweep(unparkArgs({ gh, harnessSettled, transition }));
  expect(second).toContainEqual({ kind: "harness-unpark-skipped", issue: 2, harness: 31, reason: "already unparked" });
  expect(transition).toHaveBeenCalledTimes(1);
});

/**
 * ADR-020 최종 리뷰 MF-1 — **주차 해제의 목적지(`factory:queue`)를 보는 팔이 하나도 없었다.**
 * 해제는 평생 dedupe 마커를 남기므로, 그 라벨 이벤트가 만든 `factory-triage` 런이 사라지면
 * (도그푸딩에서 두 번: 동시성 물결·좀비 queued) 그 피처는 **영원히** 큐에 앉는다 — KTB-23의 존재
 * 이유 전체가 거기서 끝난다. 이제 stalled 팔이 그것을 받는다.
 */
test("MF-1: after a harness unpark, a queue issue whose triage run was lost is re-dispatched by the stall arm", async () => {
  const posted = [];
  const unparkedAt = "2026-09-11T00:10:00Z";
  // 해제가 끝난 뒤의 이슈 상태: needs-info → queue 전이 한 줄 + 평생 dedupe 마커. 런은 없었다.
  const comments = () => [
    { id: 1, body: `<!-- factory-transition:v1 from=factory:needs-info to=factory:queue by=script -->\nfactory:needs-info → factory:queue — harness issue #31 closed`, createdAt: unparkedAt },
    { id: 2, body: `${harnessUnparkedComment(31, 2)}\n하네스 이슈 #31: 이슈가 닫혔습니다`, createdAt: unparkedAt },
    ...posted,
  ];
  const gh = {
    searchIssues: vi.fn(async (l) => (l === "factory:queue" ? [{ number: 2 }] : [])),
    comments: vi.fn(async () => comments()),
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
    patchComment: vi.fn(), issueList: async () => [],
  };
  const dispatchStage = vi.fn(async () => {});
  // 주차 해제 팔은 이제 아무것도 하지 않는다(이슈는 더 이상 needs-info가 아니다) — 마커도 그대로다.
  const harnessSettled = vi.fn(async () => ({ done: true, why: "이슈가 닫혔습니다" }));
  const actions = await sweep(stalledArgs({ gh, dispatchStage, harnessSettled }));
  expect(dispatchStage).toHaveBeenCalledWith({ stage: "triage", issue: 2 });
  expect(gh.comment).toHaveBeenCalledWith(2, expect.stringContaining(restartComment("triage", 2)));
  expect(actions).toContainEqual({ kind: "stalled-restart", issue: 2, stage: "triage", label: "factory:queue" });
  expect(actions.some((a) => String(a.kind).startsWith("harness-unpark"))).toBe(false);

  // 그리고 같은 창 안에서는 한 번뿐이다(다른 대기 라벨과 같은 계약).
  const second = await sweep(stalledArgs({ gh, dispatchStage, harnessSettled }));
  expect(dispatchStage).toHaveBeenCalledTimes(1);
  expect(second.some((a) => a.kind === "stalled-restart")).toBe(false);
});

// 임계는 다른 라벨들과 같다: 하트비트가 하나도 없으면 10분(KTB-31), 그 안이면 손대지 않는다 —
// triage는 `factory:queue`에 몇 분만 머물므로 30분을 기다릴 이유가 없었고, 그렇다고 방금 붙은
// 라벨을 밀면 정상적으로 뜨는 중인 런 위로 두 번째 런을 얹는다.
test("MF-1: the queue arm uses the 10-minute no-heartbeat threshold, not 30", async () => {
  const at = (min) => new Date(Date.parse("2026-09-11T01:00:00Z") - min * 60e3).toISOString();
  const mk = (createdAt) => ({
    searchIssues: async (l) => (l === "factory:queue" ? [{ number: 2 }] : []),
    comments: async () => [{ id: 1, body: "<!-- factory-transition:v1 from=factory:needs-human to=factory:queue by=human -->\nfactory:needs-human → factory:queue", createdAt }],
    comment: vi.fn(async () => "u"), patchComment: vi.fn(), issueList: async () => [],
  });
  const inside = vi.fn();
  expect((await sweep(stalledArgs({ gh: mk(at(STALL_NO_HEARTBEAT_MIN - 1)), dispatchStage: inside }))).some((a) => a.kind === "stalled-restart")).toBe(false);
  expect(inside).not.toHaveBeenCalled();
  const past = vi.fn(async () => {});
  expect(await sweep(stalledArgs({ gh: mk(at(STALL_NO_HEARTBEAT_MIN + 1)), dispatchStage: past }))).toContainEqual({ kind: "stalled-restart", issue: 2, stage: "triage", label: "factory:queue" });
  expect(past).toHaveBeenCalledWith({ stage: "triage", issue: 2 });
});

test("KTB-23 fix: an OPEN harness issue leaves the feature parked — no comment, no transition", async () => {
  const gh = {
    searchIssues: async (l) => (l === "factory:needs-info" ? [{ number: 2 }] : []),
    comments: async () => [parkComment(31)],
    comment: vi.fn(), patchComment: vi.fn(), issueList: async () => [],
  };
  const transition = vi.fn();
  const actions = await sweep(unparkArgs({ gh, transition, harnessSettled: async () => ({ done: false, why: "아직 열려 있습니다" }) }));
  expect(transition).not.toHaveBeenCalled();
  expect(gh.comment).not.toHaveBeenCalled();
  expect(actions).toContainEqual({ kind: "harness-unpark-skipped", issue: 2, harness: 31, reason: "아직 열려 있습니다" });
});

test("KTB-23 fix: needs-info that is NOT a harness park (triage's 'the issue is ambiguous') is never touched", async () => {
  const ambiguous = {
    id: 1,
    body: "<!-- factory-transition:v1 from=factory:queue to=factory:needs-info by=script -->\nfactory:queue → factory:needs-info — 이슈가 무엇을 요구하는지 알 수 없다",
    createdAt: "2026-09-11T00:00:00Z",
  };
  const gh = {
    searchIssues: async (l) => (l === "factory:needs-info" ? [{ number: 2 }] : []),
    comments: async () => [ambiguous],
    comment: vi.fn(), patchComment: vi.fn(), issueList: async () => [],
  };
  const harnessSettled = vi.fn();
  const transition = vi.fn();
  const actions = await sweep(unparkArgs({ gh, transition, harnessSettled }));
  expect(harnessSettled).not.toHaveBeenCalled();
  expect(transition).not.toHaveBeenCalled();
  expect(actions.some((a) => String(a.kind).startsWith("harness-unpark"))).toBe(false);

  // 주차 뒤에 **더 최근의** 전이가 있으면(사람이 이미 큐로 돌렸다가 다시 needs-info로 보냈다) 그것이 이긴다
  const moved = { ...ambiguous, id: 2, createdAt: "2026-09-11T00:30:00Z" };
  const gh2 = { ...gh, comments: async () => [parkComment(31), moved] };
  const t2 = vi.fn();
  await sweep(unparkArgs({ gh: gh2, transition: t2, harnessSettled: async () => ({ done: true, why: "closed" }) }));
  expect(t2).not.toHaveBeenCalled();
});

test("KTB-23 fix: a refused unpark is recorded, and one failing issue never stops the arm", async () => {
  const gh = {
    searchIssues: async (l) => (l === "factory:needs-info" ? [{ number: 2 }, { number: 3 }] : []),
    comments: async (n) => [parkComment(n === 2 ? 31 : 32)],
    comment: vi.fn(async (n) => { if (n === 2) throw new Error("comment API 502"); return "u"; }),
    patchComment: vi.fn(), issueList: async () => [],
  };
  const actions = await sweep(unparkArgs({
    gh,
    transition: async ({ issue }) => (issue === 3 ? { ok: false, reason: "no factory state label on issue" } : { ok: true }),
    harnessSettled: async () => ({ done: true, why: "이슈가 닫혔습니다" }),
  }));
  expect(actions).toContainEqual({ kind: "error", step: "harness-unpark", issue: 2, error: expect.stringContaining("comment API 502") });
  expect(actions).toContainEqual({ kind: "harness-unpark-refused", issue: 3, harness: 32, reason: "no factory state label on issue" });
});

test("KTB-23 fix: the arm runs in both the quick and the cron sweep, and is skipped when unwired", async () => {
  const gh = {
    searchIssues: async (l) => (l === "factory:needs-info" ? [{ number: 2 }] : []),
    comments: async () => [parkComment(31)],
    comment: vi.fn(async () => "u"), patchComment: vi.fn(), issueList: async () => [],
  };
  const settled = async () => ({ done: true, why: "closed" });
  for (const quick of [true, false]) {
    const transition = vi.fn(async () => ({ ok: true }));
    const actions = await sweep(unparkArgs({ gh, transition, harnessSettled: settled, quick }));
    expect(actions.some((a) => a.kind === "harness-unparked"), `quick=${quick}`).toBe(true);
  }
  // 구형 배선(harnessSettled 없음)은 조용히 건너뛴다 — "안 쓴다"와 "에러났다"를 가른다
  const t = vi.fn();
  const actions = await sweep(unparkArgs({ gh, transition: t }));
  expect(t).not.toHaveBeenCalled();
  expect(actions.some((a) => String(a.kind).startsWith("harness-unpark"))).toBe(false);
});

// ── KTB-46 — 사람이 머지한 보호 경로 PR을 이슈에 잇는다 ────────────────────────────────────────
// KTB #3(2026-09-14): 리뷰 4/4 승인 → merge 단계 (3)이 `protected paths changed — human merge
// required: …`로 거부 → 소유자가 PR #4를 손으로 머지 → **아무것도 이슈를 움직이지 않았다**
// (그래프에 엣지 없음, `Closes #n` 안 걸림, merge 단계 (9)는 이 경로에서 돌지 않음).
const HUMAN_MERGE_AT = "2026-09-11T00:30:00Z";
const MERGED_HEAD = "c".repeat(40);
const humanMergeParkComment = (from = "factory:approved", reason = "protected paths changed — human merge required: .factory/harness.toml (see PR #4)", at = HUMAN_MERGE_AT) => ({
  id: 1,
  body: `<!-- factory-transition:v1 from=${from} to=factory:needs-human by=script -->\n${from} → factory:needs-human — ${reason}`,
  createdAt: at,
});
/**
 * 최종 리뷰 A-MF2 — **이 주기가 `factory:approved`에 실제로 닿았다는 기록.** 이 팔은 이것 없이는
 * 잇지 않는다: 그 라벨의 요구조건(qa 증거 게이트를 포함한)이 이 커밋에 대해 한 번도 통과한 적 없는
 * 채로 되돌릴 수 없는 `factory:merged`가 붙는 길을 닫는다.
 */
const approvedComment = (at = "2026-09-11T00:20:00Z", id = 0) => ({
  id,
  body: "<!-- factory-transition:v1 from=factory:awaiting-review to=factory:approved by=script -->\nfactory:awaiting-review \u2192 factory:approved",
  createdAt: at,
});
/** 팩토리 계정이 머지된 head sha에 올린 리뷰·게이트 상태 — 이 팔의 게이트 증거 절반이다. */
const factoryStatuses = () => [
  { context: "factory/review", state: "success", creatorLogin: "ktb-bot" },
  { context: "factory/gates", state: "success", creatorLogin: "ktb-bot" },
];
/** 나머지 절반: 머지된 PR의 필수 체크(r3 must_fix 4 — `factory/integrity`는 check run이라 여기에만 보인다). */
const greenChecks = () => [
  { name: "factory/gates", state: "SUCCESS", bucket: "pass" },
  { name: "factory/review", state: "SUCCESS", bucket: "pass" },
  { name: "factory/integrity", state: "SUCCESS", bucket: "pass" },
];
const REQUIRED = ["factory/gates", "factory/review", "factory/integrity"];
const mergedArgs = (over = {}) => ({
  gh: { searchIssues: async () => [], comments: async () => [], comment: vi.fn(), patchComment: vi.fn(), issueList: async () => [] },
  charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30,
  transition: vi.fn(async ({ to }) => ({ ok: true, to })), release: vi.fn(),
  factoryLogins: vi.fn(async () => ({ ok: true, logins: ["ktb-bot", "ktb-owner"] })),
  reviewRoster: vi.fn(async () => ({ ok: true, roles: ["correctness", "qa"], tier: "standard" })),
  requiredChecks: REQUIRED,
  quarantine: { quarantined: [] }, saveQuarantine: () => {},
  ...over,
});
/** 이 팔이 쓰는 gh 조각 — 검색 + 머지된 PR + 머지 정보 + 커밋 상태 + PR 체크 + 이슈 상태. */
const mergedGh = (over = {}) => {
  const posted = [];
  const base = {
    searchIssues: vi.fn(async (l, opts) => (l === "factory:needs-human" && opts?.state === "all" ? [{ number: 3, updatedAt: HUMAN_MERGE_AT }] : [])),
    comments: vi.fn(async () => [approvedComment(), humanMergeParkComment(), ...posted]),
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
    patchComment: vi.fn(), issueList: async () => [],
    mergedPrForBranch: vi.fn(async () => 4),
    prMergeInfo: vi.fn(async () => ({ headSha: MERGED_HEAD, mergeSha: "d".repeat(40), mergedAt: "2026-09-11T00:45:00Z", mergedBy: "LeeHyeonKyu" })),
    commitStatuses: vi.fn(async () => factoryStatuses()),
    prChecks: vi.fn(async () => greenChecks()),
    issueState: vi.fn(async () => ({ number: 3, state: "OPEN", closedAt: null })),
    closeIssue: vi.fn(async () => {}),
  };
  return Object.assign(base, over);
};

test("KTB-46 (a): a human-merged protected-path PR moves the issue to factory:merged, marks it, and closes it", async () => {
  const gh = mergedGh();
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const actions = await sweep(mergedArgs({ gh, transition }));
  // r3 should_fix 2: 후보 자르기는 API 쪽 정렬이다(번호순 200개가 아니라 최근 갱신순 200개).
  expect(gh.searchIssues).toHaveBeenCalledWith("factory:needs-human", { state: "all", sort: "updated-desc" });
  expect(gh.mergedPrForBranch).toHaveBeenCalledWith("claude/fq-3");
  expect(gh.commitStatuses).toHaveBeenCalledWith(MERGED_HEAD);
  expect(gh.prChecks).toHaveBeenCalledWith(4);
  // r3 must_fix 1: 정족수의 자(로스터·K)가 실제로 실린다 — 이것이 없으면 검사는 무음이 된다.
  expect(transition).toHaveBeenCalledWith({
    issue: 3, to: "factory:merged",
    reason: "PR #4 merged by LeeHyeonKyu (protected paths — human merge)",
    ctxExtra: {
      issue: 3, prHeadSha: MERGED_HEAD,
      roster: ["correctness", "qa"], rosterSize: 2, maxRounds: charter.limits.K,
      humanMerged: true, statusesVerified: true,
    },
  });
  expect(gh.comment).toHaveBeenCalledWith(3, expect.stringContaining(humanMergedComment(3, 4)));
  expect(gh.closeIssue).toHaveBeenCalledWith(3);
  expect(actions).toContainEqual({ kind: "human-merged", issue: 3, pr: 4, mergedBy: "LeeHyeonKyu", closed: true });

  // 마커가 dedupe다 — 라벨이 어떤 이유로 needs-human으로 돌아와도 두 번 잇지 않는다.
  const second = await sweep(mergedArgs({ gh, transition }));
  expect(second).toContainEqual({ kind: "human-merged-skipped", issue: 3, pr: 4, reason: "already reconciled" });
  expect(transition).toHaveBeenCalledTimes(1);
});

test("KTB-46 (b): a needs-human issue stopped for any OTHER reason is left alone — and says so", async () => {
  const gh = mergedGh({ comments: vi.fn(async () => [humanMergeParkComment("factory:ready", "stalled restart limit (2) reached")]) });
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const actions = await sweep(mergedArgs({ gh, transition }));
  expect(gh.mergedPrForBranch).not.toHaveBeenCalled();
  expect(transition).not.toHaveBeenCalled();
  expect(gh.closeIssue).not.toHaveBeenCalled();
  // r3 should_fix 1: 조용한 건너뜀은 없다 — 모든 건너뜀이 사유와 함께 한 줄을 남긴다.
  expect(actions).toContainEqual({ kind: "human-merged-skipped", issue: 3, reason: expect.stringContaining("not parked on a human merge") });
});

test("KTB-46 (c): a merged PR the transition refuses is refused once — the next sweep adds no second refusal", async () => {
  const posted = [];
  const gh = mergedGh({
    comments: vi.fn(async () => [approvedComment(), humanMergeParkComment(), ...posted]),
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
  });
  /**
   * 실제 `transition()`이 요구조건 미달로 거부할 때 남기는 코멘트 — 마커는 **진짜 생성자**로 만든다
   * (r3 should_fix 3: 예전에는 같은 문자열을 테스트에 손으로 베껴 놓아서, `transition.js`의 형식이
   * 바뀌어도 테스트는 전부 초록인 채 dedupe만 조용히 죽었다).
   */
  const transition = vi.fn(async ({ issue }) => {
    await gh.comment(issue, `<!-- factory-transition:v1 from=factory:needs-human to=factory:needs-human by=script reason=refused -->\n${transitionRefusedMarker({ from: "factory:needs-human", to: "factory:merged" })}\n**전이 거부** factory:needs-human → factory:merged: review handoff missing`);
    return { ok: false, from: "factory:needs-human", to: "factory:needs-human", reason: "review handoff missing" };
  });
  const first = await sweep(mergedArgs({ gh, transition }));
  expect(first).toContainEqual({ kind: "human-merged-refused", issue: 3, pr: 4, reason: "review handoff missing" });
  expect(gh.closeIssue).not.toHaveBeenCalled();
  // r5 must_fix (b): 요구조건 거부도 **PR 범위** 마커를 남긴다 — transition 자신의 마커에는 PR 번호가
  // 없어서, 그것만으로 dedupe하면 같은 주기의 다른 PR에 대한 거부까지 삼킨다.
  expect(posted.filter((c) => c.body.includes(humanMergeRefusedComment(3, 4))).length).toBe(1);
  expect(posted.some((c) => c.body.includes(HUMAN_MERGE_REFUSED_MARKER))).toBe(true);

  const second = await sweep(mergedArgs({ gh, transition }));
  expect(second).toContainEqual({ kind: "human-merged-skipped", issue: 3, pr: 4, reason: "already refused for this PR" });
  expect(transition).toHaveBeenCalledTimes(1);
  expect(posted.filter((c) => c.body.includes(humanMergeRefusedComment(3, 4))).length).toBe(1);
});

test("KTB-46 (d): an already-CLOSED issue still carrying the label is reconciled too — no second close", async () => {
  const gh = mergedGh({ issueState: vi.fn(async () => ({ number: 3, state: "CLOSED", closedAt: "2026-09-11T00:45:00Z" })) });
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const actions = await sweep(mergedArgs({ gh, transition }));
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ issue: 3, to: "factory:merged" }));
  expect(gh.closeIssue).not.toHaveBeenCalled();
  expect(actions).toContainEqual({ kind: "human-merged", issue: 3, pr: 4, mergedBy: "LeeHyeonKyu", closed: false });
});

test("KTB-46 (e): a failing merged-PR lookup is an error line, never a transition and never a marker", async () => {
  const gh = mergedGh({ mergedPrForBranch: vi.fn(async () => { throw new Error("gh pr list 502"); }) });
  const transition = vi.fn();
  const actions = await sweep(mergedArgs({ gh, transition }));
  expect(transition).not.toHaveBeenCalled();
  expect(gh.comment).not.toHaveBeenCalled();
  expect(actions).toContainEqual({ kind: "error", step: "human-merged", issue: 3, error: expect.stringContaining("gh pr list 502") });
});

test("KTB-46: no merged PR yet (the person has not merged) → an audible skip", async () => {
  const gh = mergedGh({ mergedPrForBranch: vi.fn(async () => null) });
  const actions = await sweep(mergedArgs({ gh }));
  expect(actions).toContainEqual({ kind: "human-merged-skipped", issue: 3, reason: expect.stringContaining("no merged PR on claude/fq-3") });
});

/**
 * KTB-46 r2 — **게이트 증거는 그 커밋에 붙은 상태이고, 게시자까지 봐야 증거다.** commit status는
 * repo 스코프 토큰을 쥔 무엇이든 쓸 수 있으므로(감사 H1b) "success다"만으로는 아무것도 증명되지
 * 않는다. 확인되지 않으면 `transition()`을 **부르지도 않는다** — 부르면 거부 사유가 요구조건 미달로
 * 나가고 사람은 진짜 원인(남이 올린 상태)을 볼 수 없다.
 */
test("KTB-46 r2: a factory/gates status posted by a NON-factory login is refused — no transition", async () => {
  const gh = mergedGh({
    commitStatuses: vi.fn(async () => [
      { context: "factory/review", state: "success", creatorLogin: "ktb-bot" },
      { context: "factory/gates", state: "success", creatorLogin: "mallory" },
    ]),
  });
  const transition = vi.fn();
  const actions = await sweep(mergedArgs({ gh, transition }));
  expect(transition).not.toHaveBeenCalled();
  expect(gh.closeIssue).not.toHaveBeenCalled();
  expect(actions).toContainEqual({ kind: "human-merged-refused", issue: 3, pr: 4, reason: expect.stringMatching(/posted by @mallory.*not a factory account/s) });
  expect(gh.comment).toHaveBeenCalledWith(3, expect.stringContaining(humanMergeRefusedComment(3, 4)));
  // 그리고 그 거부는 한 번뿐이다 — 다음 sweep은 마커를 보고 침묵한다.
  const second = await sweep(mergedArgs({ gh, transition }));
  expect(second).toContainEqual({ kind: "human-merged-skipped", issue: 3, pr: 4, reason: "already refused for this PR" });
  expect(gh.comment.mock.calls.filter(([, b]) => b.includes(humanMergeRefusedComment(3, 4))).length).toBe(1);
});

test("KTB-46 r2: a failing factory/gates status is refused — a status that is not success is not evidence", async () => {
  const gh = mergedGh({
    commitStatuses: vi.fn(async () => [
      { context: "factory/review", state: "success", creatorLogin: "ktb-bot" },
      { context: "factory/gates", state: "failure", creatorLogin: "ktb-bot" },
    ]),
  });
  const transition = vi.fn();
  const actions = await sweep(mergedArgs({ gh, transition }));
  expect(transition).not.toHaveBeenCalled();
  expect(actions).toContainEqual({ kind: "human-merged-refused", issue: 3, pr: 4, reason: expect.stringContaining('factory/gates on ccccccc is "failure", not success') });
});

/**
 * r3 must_fix 4 — **필수 체크도 확인한다.** `factory/integrity`는 Actions 잡(check run)이라
 * `commitStatuses`(commit status API)에는 **절대** 나타나지 않는다 — `gh.prChecks`가 그것을 보는
 * 유일한 창이다. 그리고 "보호 브랜치가 막아 줬을 것"은 전제로 쓸 수 없다: 보호가 없는 저장소는
 * 지원되는 상태이고, `required_checks`는 L0 하나보다 넓을 수 있다.
 */
test("KTB-46 r3: a merged PR whose required checks are not all GREEN is refused — branch protection is not assumed", async () => {
  const gh = mergedGh({
    prChecks: vi.fn(async () => [
      { name: "factory/gates", state: "SUCCESS", bucket: "pass" },
      { name: "factory/review", state: "SUCCESS", bucket: "pass" },
      { name: "factory/integrity", state: "FAILURE", bucket: "fail" },
    ]),
  });
  const transition = vi.fn();
  const actions = await sweep(mergedArgs({ gh, transition }));
  expect(transition).not.toHaveBeenCalled();
  expect(actions).toContainEqual({ kind: "human-merged-refused", issue: 3, pr: 4, reason: expect.stringContaining("required checks on PR #4 are not all GREEN") });
  /**
   * r5 should_fix 1 — **체크가 하나도 없는 PR은 `gh pr checks`가 0이 아닌 코드로 끝난다**(gh
   * `checks.go`의 `populateStatusChecks`). 즉 이 어댑터에서는 빈 배열이 아니라 **throw**로 도착한다 —
   * 예전 테스트의 `async () => []`는 gh가 절대 만들지 않는 모양이었고, 그 사이 진짜 모양은 transport로
   * 분류돼 30분마다 조용히 재시도되고 있었다. merge 스테이지는 같은 throw를 판정으로 접는다.
   */
  const noChecks = mergedGh({ prChecks: vi.fn(async () => { throw new Error("gh pr checks failed (1): no checks reported on the 'claude/fq-3' branch"); }) });
  const t2 = vi.fn();
  const a2 = await sweep(mergedArgs({ gh: noChecks, transition: t2 }));
  expect(t2).not.toHaveBeenCalled();
  expect(a2).toContainEqual({ kind: "human-merged-refused", issue: 3, pr: 4, reason: expect.stringContaining("no checks reported on the merged head of PR #4") });
  expect(a2.some((a) => a.kind === "error")).toBe(false);           // transport가 아니다 — 판정이다
  expect(noChecks.comment).toHaveBeenCalledWith(3, expect.stringContaining(humanMergeRefusedComment(3, 4)));
  // 그 밖의 조회 실패는 여전히 transport다(마커 없음, 다음 sweep이 재시도).
  const boom = mergedGh({ prChecks: vi.fn(async () => { throw new Error("gh pr checks failed (1): API rate limit exceeded"); }) });
  const a3 = await sweep(mergedArgs({ gh: boom, transition: vi.fn() }));
  expect(a3).toContainEqual({ kind: "error", step: "human-merged", issue: 3, error: expect.stringContaining("rate limit") });
  expect(boom.comment).not.toHaveBeenCalled();
});

/**
 * r3 must_fix 2 — **조회 실패는 판정이 아니다.** 예전에는 `502` 하나가 영구 마커를 남겨 그 이슈에서
 * 이 팔을 영원히 껐다 — KTB-46 그 자체가 API 딸꾹질 한 번으로 되살아나는 모양이었다.
 */
test("KTB-46 r3: a transient lookup failure leaves no marker — the next healthy sweep reconciles", async () => {
  let blowUp = true;
  const posted = [];
  const gh = mergedGh({
    comments: vi.fn(async () => [approvedComment(), humanMergeParkComment(), ...posted]),
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
    commitStatuses: vi.fn(async () => { if (blowUp) throw new Error("gh api 502"); return factoryStatuses(); }),
  });
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const first = await sweep(mergedArgs({ gh, transition }));
  expect(first).toContainEqual({ kind: "error", step: "human-merged", issue: 3, error: expect.stringContaining("gh api 502") });
  expect(transition).not.toHaveBeenCalled();
  expect(posted).toEqual([]);                       // 마커도 코멘트도 남지 않았다

  blowUp = false;
  const second = await sweep(mergedArgs({ gh, transition }));
  expect(transition).toHaveBeenCalledTimes(1);
  expect(second).toContainEqual({ kind: "human-merged", issue: 3, pr: 4, mergedBy: "LeeHyeonKyu", closed: true });
});

test("KTB-46 r3: an unresolvable factory login is transient too — no marker, retried next sweep", async () => {
  const gh = mergedGh();
  const transition = vi.fn();
  const actions = await sweep(mergedArgs({ gh, transition, factoryLogins: async () => ({ ok: false, reason: "gh api user failed — 401" }) }));
  expect(transition).not.toHaveBeenCalled();
  expect(gh.comment).not.toHaveBeenCalled();
  expect(actions).toContainEqual({ kind: "error", step: "human-merged", issue: 3, error: expect.stringContaining("gh api user failed — 401") });
});

/**
 * r3 must_fix 3 — **거부는 이 PR에 대한 것이지 이 이슈에 대한 것이 아니다.** 보호 경로 이슈의
 * 정상적인 후속은 "재큐 → 새 주기 → 또 보호 경로 PR → 또 사람이 머지"다. 이슈 단위 마커는 그
 * 두 번째 머지를 영원히 막았다(그리고 `:unstick`이 탈출구라는 주석은 거짓이었다 — 새 주기의 PR도
 * 보호 경로를 건드리므로 자동 머지되지 않는다).
 */
test("KTB-46 r3: a refusal does not outlive its cycle — unstick, a new PR, a second human merge reconciles", async () => {
  const posted = [];
  const history = [approvedComment(), humanMergeParkComment()];
  const gh = mergedGh({
    comments: vi.fn(async () => [...history, ...posted]),
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
    commitStatuses: vi.fn(async () => [
      { context: "factory/review", state: "success", creatorLogin: "ktb-bot" },
      { context: "factory/gates", state: "success", creatorLogin: "mallory" },
    ]),
  });
  expect(await sweep(mergedArgs({ gh, transition: vi.fn() })))
    .toContainEqual(expect.objectContaining({ kind: "human-merged-refused", issue: 3, pr: 4 }));

  // 사람이 `:unstick`으로 재큐했고, 새 주기가 돌아 PR #9가 또 보호 경로에서 멈췄고, 또 사람이 머지했다.
  history.push(
    { id: 200, body: "<!-- factory-transition:v1 from=factory:needs-human to=factory:queue by=human -->\nfactory:needs-human → factory:queue — unstick: requeue", createdAt: "2026-09-12T00:00:00Z" },
    // A-MF2 — 주기 2도 자기 승인을 남긴다(창은 마지막 재큐 이후다: 주기 1의 승인은 여기서 쓰이지 않는다).
    approvedComment("2026-09-12T23:00:00Z", 201),
    humanMergeParkComment("factory:approved", "protected paths changed — human merge required: .factory/harness.toml (see PR #9)", "2026-09-13T00:00:00Z"),
  );
  const healthy = Object.assign(gh, {
    mergedPrForBranch: vi.fn(async () => 9),
    commitStatuses: vi.fn(async () => factoryStatuses()),
  });
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const actions = await sweep(mergedArgs({ gh: healthy, transition }));
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ issue: 3, to: "factory:merged", reason: expect.stringContaining("PR #9") }));
  expect(actions).toContainEqual({ kind: "human-merged", issue: 3, pr: 9, mergedBy: "LeeHyeonKyu", closed: true });
});

/**
 * r5 must_fix — **지난 주기에 머지된 PR이 이번 주기를 오염시키지 않는다.** `mergedPrForBranch`는
 * 브랜치 이름 하나로 찾으므로 이번 주기의 PR이 아직 머지되지 않았으면 지난 주기의 것을 돌려준다.
 * 그 PR의 옛 head에도 팩토리 상태와 초록 체크가 남아 있어 증거는 통과하고, 전이는 sha 바인딩에서
 * 거부되며, r4까지는 그 거부가 이번 주기를 막아 **진짜 두 번째 머지가 영원히 조용**했다.
 */
test("KTB-46 r5: a previous cycle's merged PR is skipped audibly, and the real second human merge still reconciles", async () => {
  const CYCLE2_HEAD = "e".repeat(40);
  const ap = (role) => ({ role, verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] });
  const reviewHandoff = (head, pr) => ({
    id: 60, createdAt: "2026-09-13T00:10:00Z",
    body: renderHandoff({ stage: "review", issue: 3, summary: "s", data: { schema: "factory.review.v1", issue: 3, pr, head_sha: head, round: 2, decision: "approved", verdicts: [ap("correctness"), ap("qa")], orchestration: "workflow", guarantee: "verified", tier_effective: "standard" } }),
  });
  const posted = [];
  // 주기 2: 재큐됐고, 새 PR #9가 또 보호 경로에서 멈췄고, 그 리뷰는 #9의 head를 서술한다.
  const history = [
    approvedComment(),
    humanMergeParkComment(),
    { id: 200, body: "<!-- factory-transition:v1 from=factory:needs-human to=factory:queue by=human -->\nfactory:needs-human → factory:queue — unstick: requeue", createdAt: "2026-09-12T00:00:00Z" },
    reviewHandoff(CYCLE2_HEAD, 9),
    // 주기 2도 자기 승인을 남긴다 — A-MF2의 창은 **마지막 재큐 이후**라 주기 1의 승인은 여기서 쓰이지 않는다.
    approvedComment("2026-09-12T23:00:00Z", 201),
    humanMergeParkComment("factory:approved", "protected paths changed — human merge required: .factory/harness.toml (see PR #9)", "2026-09-13T00:00:00Z"),
  ];
  const gh = mergedGh({
    comments: vi.fn(async () => [...history, ...posted]),
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-13T01:00:00Z" }); return "u"; }),
    // #9은 아직 머지되지 않았으므로 브랜치 조회는 **지난 주기의 #4**를 돌려준다.
    mergedPrForBranch: vi.fn(async () => 4),
  });
  const t1 = vi.fn();
  const stale = await sweep(mergedArgs({ gh, transition: t1 }));
  expect(t1).not.toHaveBeenCalled();
  expect(gh.comment).not.toHaveBeenCalled();                       // 마커도 코멘트도 남기지 않는다
  expect(stale).toContainEqual({ kind: "human-merged-skipped", issue: 3, pr: 4, reason: expect.stringMatching(/merged PR #4 head \w+ ≠ latest review head \w+/) });

  // 이제 사람이 #9을 머지했다 — 증거가 온전하므로 이어져야 한다.
  const merged = Object.assign(gh, {
    mergedPrForBranch: vi.fn(async () => 9),
    prMergeInfo: vi.fn(async () => ({ headSha: CYCLE2_HEAD, mergeSha: "f".repeat(40), mergedAt: "2026-09-13T00:45:00Z", mergedBy: "LeeHyeonKyu" })),
    commitStatuses: vi.fn(async () => factoryStatuses()),
  });
  const t2 = vi.fn(async ({ to }) => ({ ok: true, to }));
  const actions = await sweep(mergedArgs({ gh: merged, transition: t2 }));
  expect(t2).toHaveBeenCalledWith(expect.objectContaining({ issue: 3, to: "factory:merged", reason: expect.stringContaining("PR #9") }));
  expect(actions).toContainEqual({ kind: "human-merged", issue: 3, pr: 9, mergedBy: "LeeHyeonKyu", closed: true });
});

/**
 * r5 should_fix 2 — 후보에는 바닥이 있다. 30일 넘게 손대지 않은 **닫힌** 이슈는 `:unstick`의 몫이고,
 * 실제로 코멘트를 읽는 후보는 앞에서 50개까지다(목록은 이미 최근 갱신순). 둘 다 소리를 낸다.
 */
test("KTB-46 r5: the candidate list is bounded — stale closed issues and anything past the cap are skipped audibly", async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ number: 100 + i, updatedAt: HUMAN_MERGE_AT, state: "OPEN" }));
  const gh = mergedGh({
    searchIssues: vi.fn(async (l, opts) => (l === "factory:needs-human" && opts?.state === "all"
      ? [{ number: 7, updatedAt: "2026-06-01T00:00:00Z", state: "CLOSED" }, ...many]   // #7은 30일 넘게 닫혀 있다
      : [])),
    comments: vi.fn(async () => [approvedComment(), humanMergeParkComment()]),
    mergedPrForBranch: vi.fn(async () => null),
  });
  const actions = await sweep(mergedArgs({ gh }));
  expect(actions).toContainEqual({ kind: "human-merged-skipped", issue: 7, reason: expect.stringContaining("closed and untouched for over 30 days") });
  expect(gh.comments).not.toHaveBeenCalledWith(7);
  // 50개만 들여다보고 멈춘다 — 그 뒤의 첫 이슈가 왜 잘렸는지 한 줄을 남긴다.
  expect(gh.comments).toHaveBeenCalledTimes(50);
  expect(actions).toContainEqual({ kind: "human-merged-skipped", issue: 150, reason: expect.stringContaining("candidate cap (50) reached") });
});

/**
 * r3 should_fix 5(c) — `lastRealTransition`이 **진짜** 나중 전이를 가리지 않는다. 재큐된 이슈가 다른
 * 이유로 다시 needs-human이 되면 그것은 사람의 머지를 기다리는 이슈가 아니다.
 */
test("KTB-46 r3: a later genuine transition wins over the parked reason — a requeued issue is not reconciled", async () => {
  const gh = mergedGh({
    comments: vi.fn(async () => [
      humanMergeParkComment(),
      { id: 2, body: "<!-- factory-transition:v1 from=factory:needs-human to=factory:queue by=human -->\nfactory:needs-human → factory:queue — unstick: requeue", createdAt: "2026-09-12T00:00:00Z" },
      humanMergeParkComment("factory:ready", "stalled restart limit (2) reached", "2026-09-13T00:00:00Z"),
    ]),
  });
  const transition = vi.fn();
  const actions = await sweep(mergedArgs({ gh, transition }));
  expect(transition).not.toHaveBeenCalled();
  expect(actions).toContainEqual({ kind: "human-merged-skipped", issue: 3, reason: expect.stringContaining("stalled restart limit") });
});

test("KTB-46 r3: an unmerged PR (no mergedAt) is refused, independent of the mergedPrForBranch filter", async () => {
  const gh = mergedGh({ prMergeInfo: vi.fn(async () => ({ headSha: MERGED_HEAD, mergeSha: null, mergedAt: null, mergedBy: null })) });
  const transition = vi.fn();
  const actions = await sweep(mergedArgs({ gh, transition }));
  expect(transition).not.toHaveBeenCalled();
  expect(actions).toContainEqual({ kind: "human-merged-refused", issue: 3, pr: 4, reason: expect.stringContaining("is not merged") });
});

test("KTB-46 r3: an unresolvable review roster refuses — a quorum with no yardstick is not a quorum", async () => {
  const gh = mergedGh();
  const transition = vi.fn();
  const actions = await sweep(mergedArgs({ gh, transition, reviewRoster: async () => ({ ok: false, reason: "no review roster for tier weird in CHARTER" }) }));
  expect(transition).not.toHaveBeenCalled();
  expect(actions).toContainEqual({ kind: "human-merged-refused", issue: 3, pr: 4, reason: "no review roster for tier weird in CHARTER" });
  expect(gh.comment).toHaveBeenCalledWith(3, expect.stringContaining(humanMergeRefusedComment(3, 4)));
});

test("KTB-46 r3: the arm is cron-only, and is skipped when the wiring is an older double", async () => {
  // nit 3: quick sweep(스테이지 끝마다 돈다)에서는 아예 돌지 않는다 — 사람의 머지는 그 순간과 무관하다.
  const quickGh = mergedGh();
  const quickActions = await sweep(mergedArgs({ gh: quickGh, quick: true }));
  expect(quickActions.some((a) => String(a.kind).startsWith("human-merged"))).toBe(false);
  expect(quickGh.mergedPrForBranch).not.toHaveBeenCalled();
  expect((await sweep(mergedArgs({ gh: mergedGh() }))).some((a) => a.kind === "human-merged")).toBe(true);

  // 조회 함수가 하나라도 없으면 증거를 확인할 수 없다 — 이 팔은 아예 돌지 않는다. 최종 리뷰 B-nit 1:
  // 그 건너뜀은 **조용하지 않다** — 어느 dep이 빠졌는지를 액션 한 줄로 이름 붙여 남긴다(그러지 않으면
  // `bin/sweep.js`에서 dep 하나를 떨어뜨리는 리팩터가 이 팔을 통째로, 아무 신호 없이 끈다).
  for (const drop of ["prMergeInfo", "commitStatuses", "prChecks"]) {
    const old = mergedGh();
    delete old[drop];
    const transition = vi.fn();
    const actions = await sweep(mergedArgs({ gh: old, transition }));
    expect(transition, drop).not.toHaveBeenCalled();
    expect(actions.some((a) => a.kind === "human-merged"), drop).toBe(false);
    expect(actions, drop).toContainEqual({ kind: "human-merged-skipped", reason: `wiring incomplete: ${drop} — this arm did not run` });
  }
  for (const dep of ["factoryLogins", "reviewRoster"]) {
    const transition = vi.fn();
    const actions = await sweep(mergedArgs({ gh: mergedGh(), transition, [dep]: null }));
    expect(transition, dep).not.toHaveBeenCalled();
    expect(actions.some((a) => a.kind === "human-merged"), dep).toBe(false);
    expect(actions, dep).toContainEqual({ kind: "human-merged-skipped", reason: `wiring incomplete: ${dep} — this arm did not run` });
  }
});

/**
 * r4 — **tier parity.** merge 스테이지는 `base...HEAD` diff로 tier 바닥을 계산해 로스터를 넓힌다
 * (감사 H3). 이 팔은 그 diff를 다시 낼 수 없지만(브랜치가 지워졌다) **리뷰 런이 이미 계산해
 * handoff에 실어 둔 값**을 읽을 수 있다 — 그래서 로스터는 선언 tier와 그 값 중 높은 쪽이다.
 */
test("KTB-46 r4: the roster is never smaller than the review handoff's recorded tier_effective", async () => {
  const CHARTER = { ...charter, tier_default: "standard", roster: { docs: ["qa"], standard: ["correctness", "qa"], "load-bearing": ["correctness", "qa", "security", "architecture", "spec-conformance", "operator"] } };
  const ROLES = { review: { correctness: {}, qa: {}, security: {}, architecture: {}, "spec-conformance": {}, operator: {} } };
  const ap = (role) => ({ role, verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] });
  const reviewHandoff = (over = {}) => ({
    id: 50, createdAt: "2026-09-11T00:40:00Z",
    body: renderHandoff({ stage: "review", issue: 3, summary: "s", data: {
      schema: "factory.review.v1", issue: 3, pr: 4, head_sha: MERGED_HEAD, round: 2, decision: "approved",
      verdicts: [ap("correctness"), ap("qa"), ap("security"), ap("architecture")],
      orchestration: "workflow", guarantee: "verified", ...over,
    } }),
  });
  const triageHandoff = { id: 40, createdAt: "2026-09-11T00:10:00Z", body: renderHandoff({ stage: "triage", issue: 3, summary: "s", data: { schema: "factory.triage.v1", issue: 3, disposition: "ready", tier: "standard" } }) };
  // 프로덕션의 배선 그대로 — `bin/sweep.js`가 조립하는 것과 같은 모양이다.
  const roster = (comments, handoffTier = null) => resolveReviewRoster({ charter: CHARTER, roles: ROLES, comments, effectiveTier: handoffTier ? tierFromReviewHandoff(handoffTier) : null });

  // 선언은 standard(2명)인데 리뷰 런은 load-bearing(6명)으로 판정했다 → 6명짜리 로스터를 요구한다.
  const upgraded = mergedGh({ comments: vi.fn(async () => [approvedComment(), humanMergeParkComment(), triageHandoff, reviewHandoff({ tier_effective: "load-bearing", tier_source: "floor" })]) });
  const t1 = vi.fn(async ({ to }) => ({ ok: true, to }));
  const a1 = await sweep(mergedArgs({ gh: upgraded, transition: t1, reviewRoster: roster }));
  const ctx1 = t1.mock.calls[0][0].ctxExtra;
  expect(ctx1.rosterSize).toBe(6);
  expect(ctx1.roster).toContain("operator");
  expect(a1.some((a) => a.kind === "human-merged-note")).toBe(false);
  // 그리고 그 로스터로 재면 4/4 approve는 정족수 미달이다 — 이것이 parity의 실제 효과다.
  expect(requirementFor("factory:merged")({ comments: [reviewHandoff({ tier_effective: "load-bearing" })], ...ctx1 }).reason)
    .toMatch(/verdict count 4 != roster size 6/);

  // 1.2 이전 기록: `tier_effective`가 없다 → 선언 tier(2명)로 내려가되 **소리를 낸다**.
  const legacy = mergedGh({ comments: vi.fn(async () => [approvedComment(), humanMergeParkComment(), triageHandoff, reviewHandoff()]) });
  const t2 = vi.fn(async ({ to }) => ({ ok: true, to }));
  const a2 = await sweep(mergedArgs({ gh: legacy, transition: t2, reviewRoster: roster }));
  expect(t2.mock.calls[0][0].ctxExtra.roster).toEqual(["correctness", "qa"]);
  expect(a2).toContainEqual({ kind: "human-merged-note", issue: 3, pr: 4, note: expect.stringContaining("no tier_effective") });
});

/**
 * r3 must_fix 1 / should_fix 5(a) — **이음매 테스트.** 위 테스트들은 `transition`을 더블로 막아
 * 놓으므로, 팔이 만든 `ctxExtra`가 진짜 요구조건을 통과하는지는 아무도 보지 않았다. 여기서는 팔이
 * 실제로 넘긴 `ctxExtra`를 그대로 `requirementFor("factory:merged")`에 먹인다.
 */
test("KTB-46 r3: the arm's real ctxExtra meets the real factory:merged requirement — and a short roster or an over-K round does not", async () => {
  const HEAD = MERGED_HEAD;
  const ap = (role, verdict = "approve") => ({ role, verdict, confidence: "high", must_fix: verdict === "reject" ? [{ id: `${role}1`, where: "w", claim: "c", evidence: "e" }] : [], should_fix: [], verified: [] });
  const review = (over = {}) => ({ schema: "factory.review.v1", issue: 3, pr: 4, head_sha: HEAD, round: 2, decision: "approved", verdicts: [ap("correctness"), ap("qa")], orchestration: "workflow", guarantee: "verified", ...over });
  const handoff = (data) => ({ id: 50, createdAt: "2026-09-11T00:40:00Z", body: renderHandoff({ stage: "review", issue: 3, summary: "s", data }) });

  // 팔을 돌려 ctxExtra를 뽑아낸다(전이는 더블이지만, 그 인자는 프로덕션 코드가 만든 진짜 값이다).
  const capture = async (handoffData) => {
    const gh = mergedGh({ comments: vi.fn(async () => [approvedComment(), humanMergeParkComment(), handoff(handoffData)]) });
    const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
    await sweep(mergedArgs({ gh, transition, reviewRoster: async () => ({ ok: true, roles: ["correctness", "qa", "security", "perf"], tier: "load-bearing" }) }));
    const { ctxExtra } = transition.mock.calls[0][0];
    return requirementFor("factory:merged")({ comments: [handoff(handoffData)], ...ctxExtra });
  };

  // 4명짜리 로스터인데 2명만 판정했다 — r3 전에는 이것이 통과했다(로스터를 안 넘겼으므로).
  expect((await capture(review())).reason).toMatch(/verdict count 2 != roster size 4/);
  // 1명만 approve한 handoff도 마찬가지로 막힌다(리뷰가 지적한 바로 그 시나리오).
  expect((await capture(review({ verdicts: [ap("correctness")] }))).reason).toMatch(/verdict count 1 != roster size 4/);
  // 라운드가 K를 넘으면 되돌릴 수 없는 이 전이에서는 막는다 — `maxRounds`가 실려야만 무는 검사다.
  const four = [ap("correctness"), ap("qa"), ap("security"), ap("perf")];
  expect((await capture(review({ verdicts: four, round: charter.limits.K + 1 }))).reason).toMatch(new RegExp(`round ${charter.limits.K + 1} > K=${charter.limits.K}`));
  // 만장일치가 아니면 막힌다.
  expect((await capture(review({ verdicts: [ap("correctness"), ap("qa"), ap("security"), ap("perf", "reject")] }))).reason).toMatch(/not all approve/);
  // 그리고 로스터를 다 채운 4/4 approve는 통과한다.
  expect((await capture(review({ verdicts: four }))).ok).toBe(true);
});

// ── ADR-020 KTB-24 fix — review도 blocked에서 한 번은 다시 밀린다 ───────────────────────────────
test("KTB-24 fix: a blocked issue whose origin was awaiting-review gets one review retry, then escalates", async () => {
  const posted = [];
  const origin = {
    id: 1,
    body: "<!-- factory-transition:v1 from=factory:awaiting-review to=factory:blocked by=script -->\nfactory:awaiting-review → factory:blocked — job failure — retry via sweeper\n<!-- factory-blocked-origin from=factory:awaiting-review stage=review -->",
    createdAt: "2026-09-11T00:00:00Z",
  };
  const gh = {
    searchIssues: vi.fn(async (l) => (l === "factory:blocked" ? [{ number: 15 }] : [])),
    comments: vi.fn(async () => [origin, ...posted]),
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
    patchComment: vi.fn(), issueList: async () => [],
  };
  const dispatchStage = vi.fn(async () => {});
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const first = await sweep(unparkArgs({ gh, dispatchStage, transition }));
  expect(dispatchStage).toHaveBeenCalledWith({ stage: "review", issue: 15 });
  expect(gh.comment).toHaveBeenCalledWith(15, expect.stringContaining(blockedRetryComment("review", 15)));
  expect(first).toContainEqual({ kind: "blocked-retry", issue: 15, stage: "review", cause: "other" });
  expect(transition).not.toHaveBeenCalled();

  // 한 번뿐이다 — 여전히 blocked이면 다음 sweep이 사람에게 넘긴다
  const second = await sweep(unparkArgs({ gh, dispatchStage, transition }));
  expect(dispatchStage).toHaveBeenCalledTimes(1);
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ issue: 15, to: "factory:needs-human" }));
  expect(second).toContainEqual({ kind: "blocked-escalated", issue: 15, cause: "other" });
});

// ── ADR-020 KTB-28 — sweeper는 밀기 전에 **잔해 락**을 회수한다 ─────────────────────────────────
// 데모 #15: stalled 팔이 네 번 밀었고 네 번 모두 `claim()`에서 죽었다(04:39에 타임아웃으로 사라진 런의
// `lock-15`가 그대로 남아 있었다). dispatch는 락을 보지 않으므로, 락을 보는 사람이 여기 있어야 한다.
const staleLock = (over = {}) => ({ released: true, runner: "gha-34736609544", why: "stale lock released", ...over });

test("KTB-28: the stalled arm releases a stale lock before dispatching, and records it", async () => {
  const posted = [];
  const gh = {
    searchIssues: async (l) => (l === "factory:ready" ? [{ number: 15 }] : []),
    comments: async () => [TRANSITION("factory:ready", "2026-09-11T00:10:00Z"), ...posted],
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
    patchComment: vi.fn(), issueList: async () => [],
  };
  const order = [];
  const releaseIfStale = vi.fn(async () => { order.push("release"); return staleLock(); });
  const dispatchStage = vi.fn(async () => { order.push("dispatch"); });
  const actions = await sweep(stalledArgs({ gh, dispatchStage, releaseIfStale }));
  expect(releaseIfStale).toHaveBeenCalledWith(15);
  expect(order).toEqual(["release", "dispatch"]);                    // 회수가 dispatch보다 먼저다
  expect(actions).toContainEqual({ kind: "stale-lock-released", issue: 15, runner: "gha-34736609544", step: "stalled-restart" });
});

/**
 * r1 SF4 — **살아 있다고 들었으면 밀지 않는다.** 예전에는 `{released:false, why:"held by …"}`를 받고도
 * `why`를 버리고 마커를 남긴 뒤 그대로 dispatch했다. KTB-28 (b) 이후 그 런의 결말은 정해져 있다:
 * claim 거부 → 잡 실패 → `factory-claim-refused` 코멘트. 게다가 방금 남긴 마커가 재점화 예산(2회)을
 * 태우므로, 하트비트만 늦은 긴 스테이지 하나가 예산을 다 쓰고 needs-human으로 올라갈 수 있었다.
 */
test("SF4: a live lock stops the dispatch AND spends no restart marker; a throwing lookup never stops the arm", async () => {
  const mk = (releaseIfStale) => {
    const posted = [];
    return {
      searchIssues: async (l) => (l === "factory:ready" ? [{ number: 15 }] : []),
      comments: async () => [TRANSITION("factory:ready", "2026-09-11T00:10:00Z"), ...posted],
      comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
      patchComment: vi.fn(), issueList: async () => [], releaseIfStale,
    };
  };
  const live = vi.fn(async () => ({ released: false, live: true, why: "held by gha-1 (in_progress)" }));
  const d1 = vi.fn(async () => {});
  const gh1 = mk();
  const a1 = await sweep(stalledArgs({ gh: gh1, dispatchStage: d1, releaseIfStale: live }));
  expect(d1).not.toHaveBeenCalled();
  expect(gh1.comment).not.toHaveBeenCalled();                        // 마커도 남기지 않는다 = 예산을 쓰지 않는다
  expect(a1.some((a) => a.kind === "stale-lock-released")).toBe(false);
  expect(a1).toContainEqual({ kind: "stalled-restart-skipped", issue: 15, stage: "plan", label: "factory:ready", reason: "lock still live — held by gha-1 (in_progress)" });

  // MF1: 리스가 깨진 것도 "살아 있다"다(방금 누군가 다시 잡았다는 뜻) — 그 사실은 기록으로 남는다
  const raced = vi.fn(async () => ({ released: false, live: true, race: true, runner: "gha-1", why: "stale-lock-race — gha-1's lock changed between read and delete" }));
  const d3 = vi.fn(async () => {});
  const a3 = await sweep(stalledArgs({ gh: mk(), dispatchStage: d3, releaseIfStale: raced }));
  expect(d3).not.toHaveBeenCalled();
  expect(a3).toContainEqual({ kind: "stale-lock-race", issue: 15, runner: "gha-1", step: "stalled-restart" });

  // r2 MF1: 조회가 터진 것은 "살아 있다"도 "잔해다"도 아니다 — `unknown`이고, 그때는 밀지 않되
  // **사람을 부른다**(예전에는 그냥 밀었다: 살아 있는 락 위로 미는 것이고 예산도 태웠다).
  const boom = vi.fn(async () => { throw new Error("git fetch exploded"); });
  const d2 = vi.fn(async () => {});
  const t2 = vi.fn(async ({ to }) => ({ ok: true, to }));
  const a2 = await sweep(stalledArgs({ gh: mk(), dispatchStage: d2, transition: t2, releaseIfStale: boom }));
  expect(d2).not.toHaveBeenCalled();
  expect(a2).toContainEqual({ kind: "error", step: "stalled-restart-lock", issue: 15, error: expect.stringContaining("git fetch exploded") });
  expect(t2).toHaveBeenCalledWith(expect.objectContaining({ issue: 15, to: "factory:needs-human" }));
});

/**
 * ADR-020 r2 MF1 — **리뷰 finding 1: 조용한 영구 정지.** r1 SF4는 "락이 살아 있는지 증명하지 못했다"를
 * "스테이지가 돌고 있다"로 읽었다. 그래서 사람이 로컬에서 `factory run`을 돌리다 랩톱이 잠들어 남은
 * 락(`runner=local/hk-mac`) 하나가 stalled 팔을 30분마다 **영원히** 물러나게 했다 — 코멘트도, 마커도,
 * 에스컬레이션도 없이 sweep 잡의 stdout 한 줄만. 이 클러스터가 없애려던 바로 그 침묵(#15)이다.
 */
test("MF1 r2: an unknown lock owner does not dispatch — it escalates to needs-human with the reason", async () => {
  const posted = [];
  const gh = {
    searchIssues: async (l) => (l === "factory:planned" ? [{ number: 15 }] : []),
    comments: async () => [TRANSITION("factory:planned", "2026-09-11T00:10:00Z"), ...posted],
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
    patchComment: vi.fn(), issueList: async () => [],
  };
  const dispatchStage = vi.fn(async () => {});
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const unknown = async () => ({ released: false, live: false, state: "unknown", why: "owner local/hk-mac unknowable (not-a-workflow-run)" });
  const actions = await sweep(stalledArgs({ gh, dispatchStage, transition, releaseIfStale: unknown }));
  expect(dispatchStage).not.toHaveBeenCalled();                      // 살아 있을 수 있는 락 위로 밀지 않는다
  expect(transition).toHaveBeenCalledWith({ issue: 15, to: "factory:needs-human", reason: "lock owner unknowable (owner local/hk-mac unknowable (not-a-workflow-run))" });
  expect(gh.comment).toHaveBeenCalled();                             // 에스컬레이션이 stdout에만 있으면 안 된다
  expect(posted[0].body).toContain(lockOwnerUnknownComment(15));
  expect(actions).toContainEqual(expect.objectContaining({ kind: "lock-owner-unknown-escalated", issue: 15, stage: "implement", step: "stalled-restart" }));

  // 같은 창 안에서 두 번 올리지 않는다(마커 dedupe) — 다음 창의 sweep은 다시 시도한다.
  const again = await sweep(stalledArgs({ gh, dispatchStage, transition: vi.fn(async ({ to }) => ({ ok: true, to })), releaseIfStale: unknown }));
  expect(again).toContainEqual(expect.objectContaining({ kind: "stalled-restart-skipped", issue: 15, reason: expect.stringContaining("lock owner unknown") }));
});

test("MF1 r2: the blocked arm escalates on an unknown owner too — but only after the stall threshold", async () => {
  const mk = (at) => {
    const posted = [];
    return {
      searchIssues: async (l) => (l === "factory:blocked" ? [{ number: 15 }] : []),
      comments: async () => [{ id: 1, body: `<!-- factory-transition:v1 from=factory:awaiting-review to=factory:blocked by=script -->\nfactory:awaiting-review → factory:blocked — job cancelled\n<!-- factory-blocked-origin from=factory:awaiting-review stage=review cause=cancelled -->`, createdAt: at }, ...posted],
      comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
      patchComment: vi.fn(), issueList: async () => [],
    };
  };
  const unknown = async () => ({ released: false, live: false, state: "unknown", why: "lock unreadable — fatal: could not read from remote" });
  // 방금 blocked이 된 이슈: 정상적인 재시도 한 번을 빼앗지 않는다(아직 임계 안)
  const fresh = mk("2026-09-11T00:45:00Z");
  const d1 = vi.fn(async () => {});
  const t1 = vi.fn(async ({ to }) => ({ ok: true, to }));
  const a1 = await sweep(stalledArgs({ gh: fresh, dispatchStage: d1, transition: t1, releaseIfStale: unknown }));
  expect(d1).not.toHaveBeenCalled();
  expect(t1).not.toHaveBeenCalled();
  expect(a1).toContainEqual(expect.objectContaining({ kind: "blocked-retry-skipped", issue: 15, reason: expect.stringContaining("lock owner unknown") }));

  // 임계를 넘긴 뒤: 사람에게 간다(그 전이가 이 이슈를 blocked에서 꺼내는 유일한 길이다)
  const old = mk("2026-09-11T00:00:00Z");
  const d2 = vi.fn(async () => {});
  const t2 = vi.fn(async ({ to }) => ({ ok: true, to }));
  const a2 = await sweep(stalledArgs({ gh: old, dispatchStage: d2, transition: t2, releaseIfStale: unknown }));
  expect(d2).not.toHaveBeenCalled();
  expect(t2).toHaveBeenCalledWith({ issue: 15, to: "factory:needs-human", reason: expect.stringContaining("lock owner unknowable") });
  expect(a2).toContainEqual(expect.objectContaining({ kind: "lock-owner-unknown-escalated", issue: 15, step: "blocked-retry", cause: "cancelled" }));
});

test("SF4: the blocked-retry arm also stands down on a live lock — no marker, no attempt spent", async () => {
  const posted = [];
  const gh = {
    searchIssues: async (l) => (l === "factory:blocked" ? [{ number: 15 }] : []),
    comments: async () => [BLOCKED_ORIGIN("factory:awaiting-review", "2026-09-11T00:00:00Z"), ...posted],
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
    patchComment: vi.fn(), issueList: async () => [],
  };
  const dispatchStage = vi.fn(async () => {});
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const actions = await sweep(stalledArgs({ gh, dispatchStage, transition, releaseIfStale: async () => ({ released: false, live: true, why: "held by gha-1 (queued)" }) }));
  expect(dispatchStage).not.toHaveBeenCalled();
  expect(gh.comment).not.toHaveBeenCalled();
  expect(transition).not.toHaveBeenCalled();                         // 에스컬레이션도 하지 않는다 — 돌고 있다
  expect(actions).toContainEqual({ kind: "blocked-retry-skipped", issue: 15, stage: "review", cause: "other", reason: "lock still live — held by gha-1 (queued)" });
});

test("KTB-28: the blocked-retry arm releases a stale lock before its dispatch too", async () => {
  const posted = [];
  const gh = {
    searchIssues: async (l) => (l === "factory:blocked" ? [{ number: 15 }] : []),
    comments: async () => [BLOCKED_ORIGIN("factory:awaiting-review", "2026-09-11T00:00:00Z"), ...posted],
    comment: async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; },
    patchComment: vi.fn(), issueList: async () => [],
  };
  const releaseIfStale = vi.fn(async () => staleLock());
  const dispatchStage = vi.fn(async () => {});
  const actions = await sweep(stalledArgs({ gh, dispatchStage, releaseIfStale }));
  expect(releaseIfStale).toHaveBeenCalledWith(15);
  expect(actions).toContainEqual({ kind: "stale-lock-released", issue: 15, runner: "gha-34736609544", step: "blocked-retry" });
  expect(dispatchStage).toHaveBeenCalledWith({ stage: "review", issue: 15 });
});

test("KTB-28: with no releaseIfStale wired the arms are unchanged (older wiring)", async () => {
  const posted = [];
  const gh = {
    searchIssues: async (l) => (l === "factory:ready" ? [{ number: 15 }] : []),
    comments: async () => [TRANSITION("factory:ready", "2026-09-11T00:10:00Z"), ...posted],
    comment: async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; },
    patchComment: vi.fn(), issueList: async () => [],
  };
  const dispatchStage = vi.fn(async () => {});
  const actions = await sweep(stalledArgs({ gh, dispatchStage }));
  expect(dispatchStage).toHaveBeenCalled();
  expect(actions.some((a) => a.kind === "stale-lock-released")).toBe(false);
});

// KTB-28 (d): 같은 이슈+스테이지를 무한히 다시 밀지 않는다. #15는 네 번 밀렸고 네 번 다 같은 벽에
// 부딪혔다 — 두 번째까지가 "일시적일 수 있다"의 한계고, 그 뒤는 사람이 볼 일이다.
test("KTB-28: stalled restarts are capped at 2 per issue+stage, then escalate to needs-human", async () => {
  const old = (n) => ({ id: n, body: restartComment("plan", 15), createdAt: "2026-09-10T00:00:00Z" });
  const gh = {
    searchIssues: async (l) => (l === "factory:ready" ? [{ number: 15 }] : []),
    comments: async () => [TRANSITION("factory:ready", "2026-09-11T00:10:00Z"), old(2), old(3)],
    comment: vi.fn(async () => "u"), patchComment: vi.fn(), issueList: async () => [],
  };
  const dispatchStage = vi.fn(async () => {});
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const actions = await sweep(stalledArgs({ gh, dispatchStage, transition }));
  expect(dispatchStage).not.toHaveBeenCalled();
  expect(gh.comment).not.toHaveBeenCalled();                         // 마커를 또 남기지 않는다
  expect(transition).toHaveBeenCalledWith({ issue: 15, to: "factory:needs-human", reason: "stalled restart limit (2) reached" });
  expect(actions).toContainEqual({ kind: "stalled-restart-limit", issue: 15, stage: "plan", label: "factory:ready" });
});

/**
 * r1 SF3 — 그 예산도 **마지막 재큐 이후**로 센다. 이 저장소의 다른 모든 라운드 카운터가 그렇다(KTB-25):
 * 재큐는 새 주기의 시작이고, 그 앞의 시도는 다른 코드에 대한 것이다. 예전에는 이것만 이력 전체를 봐서,
 * 지난 주기에 두 번 밀렸다가 사람이 고쳐 재큐한 이슈가 **이번 주기의 첫 스톨**에서 — 재점화를 한 번도
 * 하지 않은 채 — "stalled restart limit (2) reached"로 다시 사람에게 올라갔다.
 */
test("SF3: restart markers from before the last requeue do not count toward the cap", async () => {
  const old = (n) => ({ id: n, body: restartComment("plan", 15), createdAt: "2026-09-10T00:00:00Z" });
  const requeue = { id: 50, body: "<!-- factory-transition:v1 from=factory:needs-human to=factory:queue by=human -->\nneeds-human → factory:queue", createdAt: "2026-09-10T12:00:00Z" };
  const posted = [];
  const gh = {
    searchIssues: async (l) => (l === "factory:ready" ? [{ number: 15 }] : []),
    comments: async () => [old(2), old(3), requeue, TRANSITION("factory:ready", "2026-09-11T00:10:00Z"), ...posted],
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
    patchComment: vi.fn(), issueList: async () => [],
  };
  const dispatchStage = vi.fn(async () => {});
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const actions = await sweep(stalledArgs({ gh, dispatchStage, transition }));
  expect(transition).not.toHaveBeenCalled();                         // 에스컬레이션이 아니라 재점화다
  expect(dispatchStage).toHaveBeenCalledWith({ stage: "plan", issue: 15 });
  expect(actions).toContainEqual({ kind: "stalled-restart", issue: 15, stage: "plan", label: "factory:ready" });
});

test("KTB-28: one previous restart is still below the cap — the second push happens", async () => {
  const gh = {
    searchIssues: async (l) => (l === "factory:ready" ? [{ number: 15 }] : []),
    comments: async () => [TRANSITION("factory:ready", "2026-09-11T00:10:00Z"), { id: 2, body: restartComment("plan", 15), createdAt: "2026-09-10T00:00:00Z" }],
    comment: vi.fn(async () => "u"), patchComment: vi.fn(), issueList: async () => [],
  };
  const dispatchStage = vi.fn(async () => {});
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const actions = await sweep(stalledArgs({ gh, dispatchStage, transition }));
  expect(dispatchStage).toHaveBeenCalledWith({ stage: "plan", issue: 15 });
  expect(transition).not.toHaveBeenCalled();
  expect(actions).toContainEqual({ kind: "stalled-restart", issue: 15, stage: "plan", label: "factory:ready" });
});

test("KTB-28: a refused escalation at the cap is recorded, never silent", async () => {
  const old = (n) => ({ id: n, body: restartComment("plan", 15), createdAt: "2026-09-10T00:00:00Z" });
  const gh = {
    searchIssues: async (l) => (l === "factory:ready" ? [{ number: 15 }] : []),
    comments: async () => [TRANSITION("factory:ready", "2026-09-11T00:10:00Z"), old(2), old(3)],
    comment: vi.fn(async () => "u"), patchComment: vi.fn(), issueList: async () => [],
  };
  const actions = await sweep(stalledArgs({ gh, dispatchStage: vi.fn(), transition: async () => ({ ok: false, reason: "graph refuses ready → needs-human" }) }));
  expect(actions).toContainEqual({ kind: "stalled-restart-limit-refused", issue: 15, stage: "plan", label: "factory:ready", reason: "graph refuses ready → needs-human" });
});

// ── r1 재리뷰 M3 — 실패한 unpark 전이가 억제 마커를 남기면 주차가 영구가 된다 ──────────────────
test("M3: a refused harness unpark leaves NO marker — the next sweep tries again", async () => {
  const posted = [];
  const gh = {
    searchIssues: async (l) => (l === "factory:needs-info" ? [{ number: 2 }] : []),
    comments: async () => [parkComment(31), ...posted],
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
    patchComment: vi.fn(), issueList: async () => [],
  };
  const harnessSettled = async () => ({ done: true, why: "이슈가 닫혔습니다" });
  let ok = false;
  const transition = vi.fn(async ({ to }) => (ok ? { ok: true, to } : { ok: false, reason: "no factory state label on issue" }));
  const first = await sweep(unparkArgs({ gh, harnessSettled, transition }));
  expect(first).toContainEqual({ kind: "harness-unpark-refused", issue: 2, harness: 31, reason: "no factory state label on issue" });
  expect(gh.comment).not.toHaveBeenCalled();                          // 억제 마커가 남지 않는다

  ok = true;
  const second = await sweep(unparkArgs({ gh, harnessSettled, transition }));
  expect(second).toContainEqual({ kind: "harness-unparked", issue: 2, harness: 31 });
  expect(gh.comment).toHaveBeenCalledWith(2, expect.stringContaining(harnessUnparkedComment(31, 2)));
  expect(transition).toHaveBeenCalledTimes(2);

  // 그리고 성공 뒤에는 마커가 dedupe다 — 세 번째 sweep은 조용하다
  const third = await sweep(unparkArgs({ gh, harnessSettled, transition }));
  expect(third).toContainEqual({ kind: "harness-unpark-skipped", issue: 2, harness: 31, reason: "already unparked" });
  expect(transition).toHaveBeenCalledTimes(2);
});

// ── ADR-020 r2 — SF2 · SF5 · KTB-31 ───────────────────────────────────────────
const HBC = (n, last, at = last) => ({ id: 1, body: `<!-- factory-heartbeat issue=${n} -->\nstage: implement · runner: gha-1 · started: x · last: ${last}`, createdAt: at });

/**
 * r2 SF2 — 하트비트 재큐 팔의 삭제는 MF1의 리스 경로 하나뿐이다. 하트비트는 best-effort로 패치되고
 * (에러를 삼키고 재시도하지 않는다) 30분 창은 GitHub 장애 하나면 지나간다 — 그 창에서 살아 있는 런의
 * 락을 지우고 재큐까지 하면 같은 이슈에 두 implement가 겹친다(로컬 진입에는 concurrency 그룹도 없다).
 */
test("SF2: the heartbeat-requeue arm releases only via the leased releaseIfStale; a live owner → no requeue", async () => {
  const mkgh = () => ({
    searchIssues: async (l) => (l === "factory:in-progress" ? [{ number: 7 }] : []),
    comments: async () => [HBC(7, "2026-09-11T00:00:00Z")],
    comment: vi.fn(async () => "u"), patchComment: vi.fn(), issueList: async () => [],
  });
  const gh1 = mkgh();
  const release = vi.fn(async () => true);
  const releaseIfStale = vi.fn(async () => ({ released: true, live: false, state: "none", runner: "gha-1", why: "stale lock from gha-1 released" }));
  const t1 = vi.fn(async ({ to }) => ({ ok: true, to }));
  const a1 = await sweep(stalledArgs({ gh: gh1, transition: t1, release, releaseIfStale }));
  expect(release).not.toHaveBeenCalled();                            // 무조건 삭제는 더 이상 없다
  expect(releaseIfStale).toHaveBeenCalledWith(7);
  expect(t1).toHaveBeenCalledWith(expect.objectContaining({ issue: 7, to: "factory:planned" }));
  expect(a1).toContainEqual({ kind: "stale-lock-released", issue: 7, runner: "gha-1", step: "heartbeat-requeue" });

  const gh2 = mkgh();
  const t2 = vi.fn();
  const a2 = await sweep(stalledArgs({ gh: gh2, transition: t2, release: vi.fn(), releaseIfStale: async () => ({ released: false, live: true, state: "live", why: "held by gha-9 (in_progress)" }) }));
  expect(t2).not.toHaveBeenCalled();                                 // 살아 있는 런의 R 예산을 태우지 않는다
  expect(gh2.comment).not.toHaveBeenCalled();
  expect(a2).toContainEqual({ kind: "requeue-skipped", issue: 7, reason: "lock still live — held by gha-9 (in_progress)" });

  // 최종 리뷰 MF-4: 소유자를 모르면 **재큐하지 않는다** — 두 dispatch 팔과 같은 판정이다.
  // 임계를 넘겼으므로(하트비트가 30분보다 오래됐다) 마커를 남기고 사람에게 올린다.
  const gh3 = mkgh();
  const t3 = vi.fn(async ({ to }) => ({ ok: true, to }));
  const a3 = await sweep(stalledArgs({ gh: gh3, transition: t3, release: vi.fn(), releaseIfStale: async () => ({ released: false, live: false, state: "unknown", why: "lock unreadable — fatal" }) }));
  expect(gh3.comment.mock.calls[0][1]).toContain(lockOwnerUnknownComment(7));
  expect(t3).toHaveBeenCalledWith(expect.objectContaining({ issue: 7, to: "factory:needs-human" }));
  expect(t3).not.toHaveBeenCalledWith(expect.objectContaining({ to: "factory:planned" }));
  expect(a3).toContainEqual({ kind: "lock-owner-unknown-escalated", issue: 7, step: "heartbeat-requeue", reason: "lock owner unknowable (lock unreadable — fatal)" });
  expect(a3).not.toContainEqual(expect.objectContaining({ kind: "requeue" }));
});

/**
 * ADR-020 최종 리뷰 MF-4 — **로컬 러너가 잡은 락은 영구히 `unknown`이다**(`runner=local/<host>`,
 * `ghaRunIdOf`가 null). r2까지 이 팔은 그 판정을 "락은 그냥 둔다"로만 읽고 재큐를 강행했다:
 * 살아 있는 `factory run implement <n>`이 R 예산을 태우고, 끝내 GREEN을 밀어도 라벨이 이미 `planned`라
 * `in-progress → awaiting-review`가 그래프에서 거부되어 완성된 구현이 좌초했다.
 */
test("MF-4: a local runner's lock (runner=local/<host>) is never requeued — it escalates instead", async () => {
  const gh = {
    searchIssues: async (l) => (l === "factory:in-progress" ? [{ number: 7 }] : []),
    comments: async () => [HBC(7, "2026-09-11T00:00:00Z")],
    comment: vi.fn(async () => "u"), patchComment: vi.fn(), issueList: async () => [],
  };
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const releaseIfStale = vi.fn(async () => ({ released: false, live: false, state: "unknown", why: "lock owner is not a workflow run (runner=local/mac-1)" }));
  const actions = await sweep(stalledArgs({ gh, transition, release: vi.fn(), releaseIfStale }));
  expect(transition).not.toHaveBeenCalledWith(expect.objectContaining({ to: "factory:planned" }));
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ issue: 7, to: "factory:needs-human", reason: "lock owner unknowable (lock owner is not a workflow run (runner=local/mac-1))" }));
  expect(actions).not.toContainEqual(expect.objectContaining({ kind: "requeue" }));
  // 그리고 R 예산을 세는 `factory-retry` 코멘트는 나가지 않는다 — 그것이 이 고침의 요점이다.
  expect(gh.comment.mock.calls.every(([, body]) => !body.includes("factory-retry"))).toBe(true);
});

// 임계 안(하트비트가 없고 마지막 전이가 최근)이면 에스컬레이션도 하지 않는다 — 정상적인 시작을
// 그 자리에서 사람에게 넘기지 않기 위해서다(blocked 팔의 같은 판정과 짝이다).
test("MF-4: an unknown lock inside the stall window is skipped quietly, not escalated", async () => {
  const gh = {
    searchIssues: async (l) => (l === "factory:in-progress" ? [{ number: 7 }] : []),
    comments: async () => [{ id: 1, body: "<!-- factory-transition:v1 from=factory:planned to=factory:in-progress by=script -->\nfactory:planned → factory:in-progress", createdAt: "2026-09-11T00:55:00Z" }],
    comment: vi.fn(async () => "u"), patchComment: vi.fn(), issueList: async () => [],
  };
  const transition = vi.fn();
  const actions = await sweep(stalledArgs({ gh, transition, release: vi.fn(), releaseIfStale: async () => ({ released: false, live: false, state: "unknown", why: "lock owner is not a workflow run (runner=local/mac-1)" }) }));
  expect(transition).not.toHaveBeenCalled();
  expect(gh.comment).not.toHaveBeenCalled();
  expect(actions).toContainEqual({ kind: "requeue-skipped", issue: 7, reason: "lock owner unknown — lock owner is not a workflow run (runner=local/mac-1)" });
});

/**
 * r2 SF5 — 라벨 변경 하나가 최대 13초를 자게 된 뒤(KTB-30 b), 넓은 API 장애에서는 앞선 팔들이 잡
 * 시간을 다 쓰고 두 복구 팔이 실행되지 않을 수 있었다 — 장애를 치우려고 만든 팔이 장애 때 안 도는
 * 순서였다. 이제 맨 앞이다(cron·`--quick` 둘 다).
 */
test("SF5: the two label-repair arms run FIRST in the sweep (cron and --quick)", async () => {
  const order = [];
  const gh = {
    searchIssues: async (l) => { order.push(`search:${l}`); return []; },
    issueList: async () => { order.push("issueList"); return []; },
    comments: async () => [], comment: vi.fn(), patchComment: vi.fn(),
  };
  for (const quick of [false, true]) {
    order.length = 0;
    await sweep(stalledArgs({ gh, quick, dispatchStage: vi.fn(async () => {}) }));
    expect(order.slice(0, 2), `quick=${quick}`).toEqual(["issueList", "issueList"]);
    expect(order[2], `quick=${quick}`).toBe("search:factory:in-progress");
  }
});

/**
 * ADR-020 KTB-31 — 2026-09-13 08:58Z #15: `factory:rework` 라벨 이벤트가 만든 런 34748735031이 Actions
 * 장애 직후 **잡 없이 queued인 좀비**로 굳었다. `factory:rework`은 재점화 표에 없었고 하트비트도
 * blocked 라벨도 없어 다른 팔에도 안 걸렸다 — 10:02Z에 사람이 손으로 `workflow_dispatch`를 칠 때까지
 * 65분이 그냥 갔다.
 */
test("KTB-31: a factory:rework issue with no run is restarted into implement", async () => {
  const posted = [];
  const gh = {
    searchIssues: async (l) => (l === "factory:rework" ? [{ number: 15 }] : []),
    comments: async () => [TRANSITION("factory:rework", "2026-09-11T00:10:00Z"), ...posted],
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
    patchComment: vi.fn(), issueList: async () => [],
  };
  const dispatchStage = vi.fn(async () => {});
  const actions = await sweep(stalledArgs({ gh, dispatchStage }));
  expect(dispatchStage).toHaveBeenCalledWith({ stage: "implement", issue: 15 });
  expect(actions).toContainEqual({ kind: "stalled-restart", issue: 15, stage: "implement", label: "factory:rework" });

  // 그리고 `--quick`에서도 같다(스테이지 잡 끝마다 도는 sweep이 이 사고를 몇 분 안에 잡는다)
  const posted2 = [];
  const gh2 = { ...gh, comments: async () => [TRANSITION("factory:rework", "2026-09-11T00:10:00Z"), ...posted2], comment: vi.fn(async (n, body) => { posted2.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }) };
  const d2 = vi.fn(async () => {});
  await sweep(stalledArgs({ gh: gh2, dispatchStage: d2, quick: true }));
  expect(d2).toHaveBeenCalledWith({ stage: "implement", issue: 15 });
});

test("KTB-31: a stage that never started (no heartbeat at all) uses the 10-minute threshold, not 30", async () => {
  expect(STALL_NO_HEARTBEAT_MIN).toBe(10);
  const mk = (extra = []) => {
    const posted = [];
    return {
      searchIssues: async (l) => (l === "factory:rework" ? [{ number: 15 }] : []),
      // 전이는 15분 전 — 30분 임계에는 안 걸리고 10분 임계에는 걸린다
      comments: async () => [TRANSITION("factory:rework", "2026-09-11T00:45:00Z"), ...extra, ...posted],
      comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u"; }),
      patchComment: vi.fn(), issueList: async () => [],
    };
  };
  const d1 = vi.fn(async () => {});
  await sweep(stalledArgs({ gh: mk(), dispatchStage: d1 }));
  expect(d1).toHaveBeenCalledWith({ stage: "implement", issue: 15 });

  // 이번 스테이지가 하트비트를 한 번이라도 찍었으면 임계는 그대로 30분이다 — 길게 도는 스테이지를
  // 10분 만에 두 번 돌리지 않는다(implement 한 번이 ~$20다).
  const d2 = vi.fn(async () => {});
  // 하트비트 자체는 **오래됐다**(00:20, 40분 전) — 그래서 "살아 있다"로 넘어가는 것이 아니라, 이
  // 스테이지가 시작은 했다는 사실로 임계가 30분이 된다.
  const a2 = await sweep(stalledArgs({ gh: mk([HBC(15, "2026-09-11T00:20:00Z", "2026-09-11T00:46:00Z")]), dispatchStage: d2 }));
  expect(d2).not.toHaveBeenCalled();
  expect(a2.some((a) => a.kind === "stalled-restart")).toBe(false);
});

// 리뷰 nit 9 — 원인 등급은 두 곳에 나열돼 있다(`BLOCKED_CAUSES`와 `BLOCKED_ESCALATION_REASON`).
// 일곱 번째가 한쪽에만 생기면 사람이 받는 문장이 조용히 "환경/크리덴셜"로 떨어진다 — O20이 없애려던
// 그 잘못된 문장이다. 이 한 줄이 둘을 묶는다.
test("nit 9: every blocked cause has its own escalation sentence", () => {
  expect(Object.keys(BLOCKED_ESCALATION_REASON)).toEqual(BLOCKED_CAUSES);
});

/**
 * ADR-020 KTB-35 — 일곱 번째 원인 등급. 이 blocked은 대개 일시적 인프라(포크된 워커의 stderr EPIPE)라
 * 다른 등급과 같은 계약을 받는다: **같은 스테이지를 한 번** 다시 돌리고, 그래도 blocked이면 사람에게
 * 올린다. 다른 것은 그때 사람이 받는 문장이다 — "환경/크리덴셜"이 아니라 원인을 이름으로 말한다.
 */
test("KTB-35: a gates-unhandled blocked gets one retry, then escalates with a sentence that names it", async () => {
  const posted = [];
  const origin = { id: 1, createdAt: "2026-09-11T00:00:00Z", body: "<!-- factory-transition:v1 from=factory:in-progress to=factory:blocked by=script -->\nfactory:in-progress → factory:blocked — command exited 1 with 0 failing tests — unhandled error outside tests (see gate log)\n<!-- factory-blocked-origin from=factory:in-progress stage=implement cause=gates-unhandled -->" };
  const gh = {
    searchIssues: vi.fn(async (label) => (label === "factory:blocked" ? [{ number: 3 }] : [])),
    comments: vi.fn(async (n) => (n === 3 ? [origin, ...posted] : [])),
    comment: vi.fn(async (n, body) => { posted.push({ id: 99, body, createdAt: "2026-09-11T01:00:00Z" }); return "u#issuecomment-1"; }),
    patchComment: vi.fn(),
  };
  const dispatchStage = vi.fn(async () => {});
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const args = { gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition, release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {}, dispatchStage };

  expect(await sweep(args)).toContainEqual({ kind: "blocked-retry", issue: 3, stage: "implement", cause: "gates-unhandled" });
  expect(dispatchStage).toHaveBeenCalledWith({ stage: "implement", issue: 3 });

  const second = await sweep(args);
  expect(dispatchStage).toHaveBeenCalledTimes(1);                    // 한 번뿐
  expect(second).toContainEqual({ kind: "blocked-escalated", issue: 3, cause: "gates-unhandled" });
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ issue: 3, to: "factory:needs-human", reason: BLOCKED_ESCALATION_REASON["gates-unhandled"] }));
  expect(BLOCKED_ESCALATION_REASON["gates-unhandled"]).toMatch(/0 failing tests/);
});


/**
 * ── 최종 리뷰 A-MF2 — **qa 게이트가 거부한 승인은 사람의 머지로 세탁되지 않는다.** ─────────────
 *
 * 재현한 사슬: ① 주기 1이 승인을 받고 머지 스테이지가 보호 경로에서 멈춰 `factory:needs-human
 * (… — human merge required: …)`로 주차됐다. ② 사람이 재큐했고, 주기 2의 리뷰 런이 새 head Y에
 * `factory/review`·`factory/gates`를 게이트보다 **먼저** 게시한 뒤 `factory:approved` 전이가 qa 증거
 * 게이트에서 **거부**됐다(마커는 `to=factory:needs-human … reason=refused`). ③ `lastRealTransition`은
 * 거부를 건너뛰므로 이 팔은 여전히 "사람의 머지를 기다린다"를 읽는다. ④ 사람이 Y를 머지하면
 * `verifyMergedPrEvidence`는 ②가 남긴 상태들을 찾아 통과하고, 되돌릴 수 없는 `factory:merged`가
 * **qa 증거 요구조건이 그 커밋에 대해 한 번도 통과한 적 없는 채로** 붙었다.
 *
 * 이제 이 팔은 이번 주기에 완료된 `→ factory:approved` 전이를 요구한다 — 없으면 소리를 내고 넘어간다.
 */
test("A-MF2: a head whose factory:approved was refused by the qa gate is never laundered into factory:merged", async () => {
  const REFUSED_CYCLE = [
    approvedComment("2026-09-11T00:20:00Z"),                          // 주기 1의 승인
    humanMergeParkComment(),                                          // 주기 1: 보호 경로로 주차
    { id: 200, body: "<!-- factory-transition:v1 from=factory:needs-human to=factory:queue by=human -->\nfactory:needs-human → factory:queue — unstick: requeue", createdAt: "2026-09-12T00:00:00Z" },
    // 주기 2: 승인 전이가 qa 증거 게이트에서 거부됐다 — 그 기록은 `to=factory:needs-human … reason=refused`다.
    { id: 201, body: "<!-- factory-transition:v1 from=factory:awaiting-review to=factory:needs-human by=script reason=refused -->\n**전이 거부** factory:awaiting-review → factory:approved: qa evidence manifest not verified for this transition", createdAt: "2026-09-12T23:00:00Z" },
  ];
  const CYCLE2_PARK = humanMergeParkComment("factory:approved", "protected paths changed — human merge required: .factory/harness.toml (see PR #4)", "2026-09-13T00:00:00Z");
  const gh = mergedGh({ comments: vi.fn(async () => [...REFUSED_CYCLE, CYCLE2_PARK]) });
  const transition = vi.fn();
  const actions = await sweep(mergedArgs({ gh, transition }));
  expect(transition).not.toHaveBeenCalled();
  expect(gh.comment).not.toHaveBeenCalled();                          // 판정이 아니라 건너뜀이다 — 마커를 남기지 않는다
  expect(actions).toContainEqual({ kind: "human-merged-skipped", issue: 3, pr: 4, reason: expect.stringContaining("never reached factory:approved") });

  // 그리고 그 주기가 **실제로** 승인을 받으면(같은 이력에 완료된 승인 한 줄이 더해지면) 정상적으로 이어진다.
  const healed = mergedGh({ comments: vi.fn(async () => [...REFUSED_CYCLE, approvedComment("2026-09-12T23:30:00Z", 202), CYCLE2_PARK]) });
  const t2 = vi.fn(async ({ to }) => ({ ok: true, to }));
  expect(await sweep(mergedArgs({ gh: healed, transition: t2 })))
    .toContainEqual({ kind: "human-merged", issue: 3, pr: 4, mergedBy: "LeeHyeonKyu", closed: true });
});

/**
 * 최종 리뷰 B-SF6 — **K를 못 읽으면 조용히 약해지지 않는다.** `charter.limits.K`가 없거나 정수가
 * 아니면 예전에는 `maxRounds`가 ctxExtra에서 빠졌고, `verifyReviewQuorum`이 `round > K` 검사를 액션
 * 한 줄 없이 건너뛰었다 — 되돌릴 수 없는 `factory:merged` 앞에서 한도 하나를 모른 채 지나가던 자리다.
 */
test("B-SF6: an unreadable CHARTER limits.K refuses the human-merge reconcile with a named reason", async () => {
  for (const limits of [{}, { K: "3" }]) {
    const gh = mergedGh();
    const transition = vi.fn();
    const actions = await sweep(mergedArgs({ gh, transition, charter: { ...charter, limits } }));
    expect(transition, JSON.stringify(limits)).not.toHaveBeenCalled();
    expect(actions).toContainEqual({ kind: "human-merged-refused", issue: 3, pr: 4, reason: expect.stringContaining("CHARTER limits.K is") });
    expect(gh.comment).toHaveBeenCalledWith(3, expect.stringContaining(humanMergeRefusedComment(3, 4)));
  }
});
