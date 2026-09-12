import { test, expect, vi } from "vitest";
import { backPressure } from "../lib/back-pressure.js";
import { sweep, restartComment } from "../lib/sweeper.js";
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

test("sweep: a fresh factory:ready transition, and one whose stage is alive (fresh heartbeat), are left alone", async () => {
  const fresh = {
    searchIssues: async (l) => (l === "factory:ready" ? [{ number: 2 }] : []),
    comments: async () => [TRANSITION("factory:ready", "2026-09-11T00:50:00Z")],
    comment: vi.fn(), patchComment: vi.fn(),
  };
  const d1 = vi.fn();
  expect(await sweep(stalledArgs({ gh: fresh, dispatchStage: d1 }))).toEqual([]);
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
  expect(await sweep(stalledArgs({ gh: alive, dispatchStage: d2 }))).toEqual([]);
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
  expect(await sweep(stalledArgs({ gh, dispatchStage }))).toEqual([]);
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
  ["factory:planned", "implement"],
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
  expect(first).toContainEqual({ kind: "blocked-retry", issue: 9, stage });

  // still blocked next sweep — the restart marker is already there, so this time it escalates
  const second = await sweep(args);
  expect(dispatchStage).toHaveBeenCalledTimes(1);
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ issue: 9, to: "factory:needs-human" }));
  expect(second).toContainEqual({ kind: "blocked-escalated", issue: 9 });
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
  expect(actions).toContainEqual({ kind: "blocked-retry", issue: 9, stage: "merge" });
  expect(transition).not.toHaveBeenCalledWith(expect.objectContaining({ issue: 9 }));
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
  expect(actions).toContainEqual({ kind: "blocked-escalated", issue: 10 });
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
  expect(actions).toEqual([]);
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
