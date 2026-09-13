import { test, expect } from "vitest";
import { BLOCKED_CAUSES, blockedCause, blockedOrigin, blockedOriginMarker, commentsSinceRequeue, countTransitionsTo, extractNeedsHuman, lastTransition, transitionFailedMarker } from "../lib/retro/issue-comments.js";
import { renderHandoff } from "../lib/handoff.js";

// ── KTB-15b I2: factory-blocked-origin marker parsing ──────────────────────────────────────────
// lib/transition.js writes this marker at the moment a transition into factory:blocked succeeds —
// run-stage's entry guard (BLOCKED_RETRY) and the sweeper's blocked arm both read it back through
// this helper instead of re-deriving the fact from transition-comment history.

const marker = (from, stage, at) => ({ id: 1, body: `<!-- factory-transition:v1 from=${from} to=factory:blocked by=script -->\n${from} → factory:blocked — x\n<!-- factory-blocked-origin from=${from} stage=${stage} -->`, createdAt: at });

test("blockedOrigin returns null when no marker is present", () => {
  expect(blockedOrigin([])).toBeNull();
  expect(blockedOrigin([{ id: 1, body: "just a human note", createdAt: "x" }])).toBeNull();
});

test("blockedOrigin returns {from, stage, reason} from the marker", () => {
  const comments = [marker("factory:approved", "merge", "2026-09-11T00:00:00Z")];
  expect(blockedOrigin(comments)).toEqual({ from: "factory:approved", stage: "merge", reason: "x", cause: "other" });
});

test("blockedOrigin takes the LAST marker when an issue was blocked more than once", () => {
  const comments = [
    marker("factory:in-progress", "implement", "2026-09-11T00:00:00Z"),
    { id: 2, body: "<!-- factory-transition:v1 from=factory:blocked to=factory:planned by=script -->\nblocked → planned", createdAt: "2026-09-11T00:05:00Z" },
    marker("factory:approved", "merge", "2026-09-11T01:00:00Z"),
  ];
  expect(blockedOrigin(comments)).toEqual({ from: "factory:approved", stage: "merge", reason: "x", cause: "other" });
});

// ── KTB-22: the reason text (used by the sweeper to detect an api-error origin) ─────────────────

test("blockedOrigin: reason is '' when the marker was re-posted without a transition line (merge-stage's toBlocked self-retry)", () => {
  const comments = [{ id: 1, body: "<!-- factory-blocked-origin from=factory:approved stage=merge -->\n머지 재시도가 다시 판정 불가로 멈췄습니다. 사유: gates BLOCKED", createdAt: "x" }];
  expect(blockedOrigin(comments)).toEqual({ from: "factory:approved", stage: "merge", reason: "", cause: "other" });
});

test("blockedOrigin: reason carries the api-error provider message when that's why the transition landed on blocked", () => {
  const body = `<!-- factory-transition:v1 from=factory:planned to=factory:blocked by=script -->\nfactory:planned → factory:blocked — claude -p api error 429: You've hit your org's monthly spend limit\n<!-- factory-blocked-origin from=factory:planned stage=implement -->`;
  expect(blockedOrigin([{ id: 1, body, createdAt: "x" }])).toEqual({ from: "factory:planned", stage: "implement", reason: "claude -p api error 429: You've hit your org's monthly spend limit", cause: "api-error" });
});

// ── ADR-020 O20/KTB-30 — origin 마커가 **원인 등급**을 싣는다 ──────────────────────────────────
// "왜 blocked인가"는 재시도 예산과 에스컬레이션 문구를 동시에 가른다: 사람이 취소한 잡과 크리덴셜
// 문제를 같은 문장("환경/크리덴셜")으로 사람에게 넘기면 사람이 잘못된 곳을 본다.

test("blockedOriginMarker carries the cause class; blockedOrigin reads it back", () => {
  expect(blockedOriginMarker({ from: "factory:awaiting-review", stage: "review", cause: "cancelled" }))
    .toBe("<!-- factory-blocked-origin from=factory:awaiting-review stage=review cause=cancelled -->");
  const body = `<!-- factory-transition:v1 from=factory:awaiting-review to=factory:blocked by=script -->\nfactory:awaiting-review → factory:blocked — job cancelled — retry via sweeper\n${blockedOriginMarker({ from: "factory:awaiting-review", stage: "review", cause: "cancelled" })}`;
  expect(blockedOrigin([{ id: 1, body, createdAt: "x" }])).toEqual({
    from: "factory:awaiting-review", stage: "review", reason: "job cancelled — retry via sweeper", cause: "cancelled",
  });
});

test("blockedOriginMarker without a cause stays byte-identical to the old marker (old issues keep parsing)", () => {
  expect(blockedOriginMarker({ from: "factory:planned", stage: "implement" })).toBe("<!-- factory-blocked-origin from=factory:planned stage=implement -->");
});

test("blockedCause classifies the reason text into the six classes", () => {
  expect(blockedCause("claude -p api error 429: org monthly spend limit")).toBe("api-error");
  expect(blockedCause("gh workflow run failed: HTTP 500")).toBe("api-error");
  expect(blockedCause("job cancelled — retry via sweeper")).toBe("cancelled");
  expect(blockedCause("job timed_out — retry via sweeper")).toBe("timeout");
  expect(blockedCause("cannot compute merge-base (shallow clone?)")).toBe("undecidable");
  expect(blockedCause("gates file status is BLOCKED")).toBe("gates");
  expect(blockedCause("job failure — retry via sweeper")).toBe("other");
  expect(blockedCause("")).toBe("other");
  expect(blockedCause(null)).toBe("other");
  expect(new Set(BLOCKED_CAUSES)).toEqual(new Set(["api-error", "timeout", "cancelled", "gates", "undecidable", "other"]));
});

test("extractNeedsHuman is unaffected by the presence of a blocked-origin marker on an unrelated comment", () => {
  const comments = [marker("factory:approved", "merge", "2026-09-11T00:00:00Z")];
  expect(extractNeedsHuman(7, comments)).toEqual([]);
});

// ── ADR-020 KTB-23 fix — sweeper의 하네스 주차 해제 팔은 "마지막 전이의 사유"로 판정한다 ────────
// `factory:needs-info`는 두 가지 뜻을 겸한다: triage의 "이슈가 모호하다"(사람이 보강해야 한다)와
// 하네스 대기. 전자를 자동으로 큐에 되돌리면 같은 모호함으로 triage를 다시 돌린다.
test("lastTransition returns the most recent transition comment with its reason", () => {
  const c = (from, to, reason, at) => ({ id: 1, body: `<!-- factory-transition:v1 from=${from} to=${to} by=script -->\n${from} → ${to}${reason ? ` — ${reason}` : ""}`, createdAt: at });
  expect(lastTransition([])).toBeNull();
  expect(lastTransition([{ id: 1, body: "사람이 쓴 코멘트", createdAt: "x" }])).toBeNull();
  expect(lastTransition([c("factory:in-progress", "factory:needs-info", "waiting for harness issue #31", "t1")])).toEqual({
    from: "factory:in-progress", to: "factory:needs-info", by: "script", reason: "waiting for harness issue #31", at: "t1",
  });
  // 마지막 것이 이긴다 — 주차 뒤에 사람이 움직였으면 그 사실이 최신이다
  const moved = lastTransition([
    c("factory:in-progress", "factory:needs-info", "waiting for harness issue #31", "t1"),
    c("factory:needs-info", "factory:queue", "human unstick", "t2"),
  ]);
  expect(moved.to).toBe("factory:queue");
  // 사유가 없는 전이는 빈 문자열이다(null이 아니다 — 호출자가 정규식을 그대로 걸 수 있어야 한다)
  expect(lastTransition([c("backlog", "factory:queue", "", "t")]).reason).toBe("");
});

// ── ADR-020 KTB-29 r1(SF2) — 리뷰 라운드는 handoff가 아니라 **완료된 rework 전이**로 센다 ─────────
// handoff 코멘트는 전이보다 **먼저** 나간다. 그래서 "handoff는 남겼는데 전이에서 죽은" 런(그래프·요구사항
// 거부, 전이 직전의 잡 사망)이 재작업을 한 적도 없이 라운드를 하나 태웠고, KTB-29로 K에 이빨이 생긴
// 뒤로는 그 사고 두 번 + 진짜 reject 한 번이면 멀쩡한 이슈가 needs-human으로 올라갔다.
test("SF2: rework rounds count completed `to=factory:rework` transitions since the last requeue — a dead handoff burns nothing", () => {
  const handoff = (n) => ({ id: n, body: renderHandoff({ stage: "review", issue: 18, summary: "r", data: { issue: 18, round: n } }), createdAt: `t${n}` });
  const refused = (n) => ({ id: n, body: "<!-- factory-transition-refused from=factory:awaiting-review to=factory:rework -->\n**전이 거부** …: gates file missing", createdAt: `t${n}` });
  const to = (state, n) => ({ id: n, body: `<!-- factory-transition:v1 from=factory:awaiting-review to=${state} by=script -->\nawaiting-review → ${state}`, createdAt: `t${n}` });
  const rounds = (comments) => countTransitionsTo(commentsSinceRequeue(comments), "factory:rework");

  expect(rounds([])).toBe(0);                                          // 첫 리뷰는 round 1이 된다(+1)
  // 라운드 하나 = handoff + 실제로 성공한 rework 전이
  expect(rounds([handoff(1), to("factory:rework", 2)])).toBe(1);
  // handoff는 남았는데 전이가 거부됐다 — 재작업은 일어나지 않았으므로 예산도 쓰지 않는다
  expect(rounds([handoff(1), refused(2), handoff(3), to("factory:rework", 4)])).toBe(1);
  // 재큐 이전의 라운드는 다른 코드에 대한 판정이다(KTB-25)
  const requeue = { id: 9, body: "<!-- factory-transition:v1 from=factory:needs-human to=factory:queue by=human -->\nneeds-human → factory:queue", createdAt: "t9" };
  expect(rounds([to("factory:rework", 1), to("factory:rework", 2), requeue])).toBe(0);
  expect(rounds([to("factory:rework", 1), requeue, to("factory:rework", 3)])).toBe(1);
  // approve로 끝난 라운드는 rework이 아니다
  expect(rounds([to("factory:approved", 1)])).toBe(0);
});

/**
 * ADR-020 r2 (리뷰 (c)) — SF2의 전제에 남아 있던 마지막 창. 전이 코멘트가 라벨 스왑보다 **먼저**
 * 나가게 된 뒤로(KTB-30 r1), 스왑이 4번의 CLI 시도 + REST까지 전부 실패하면 "일어나지 않은 rework"의
 * 코멘트가 이슈에 남는다 — K=3에서 그런 장애 두 번이면 멀쩡한 이슈가 라운드를 다 쓴다.
 */
test("(c): a rework transition cancelled by a following transition-failed marker does not burn a round", () => {
  const to = (state, n) => ({ id: n, body: `<!-- factory-transition:v1 from=factory:awaiting-review to=${state} by=script -->\nawaiting-review → ${state}`, createdAt: `t${n}` });
  const failed = (state, n) => ({ id: n, body: `${transitionFailedMarker({ from: "factory:awaiting-review", to: state })}\n**라벨 스왑 실패**`, createdAt: `t${n}` });
  const rounds = (comments) => countTransitionsTo(commentsSinceRequeue(comments), "factory:rework");

  expect(rounds([to("factory:rework", 1), failed("factory:rework", 2)])).toBe(0);
  // 다른 목적지의 실패는 rework 예산을 건드리지 않는다
  expect(rounds([to("factory:rework", 1), failed("factory:approved", 2)])).toBe(1);
  // 진짜 라운드 하나 + 장애 하나 = 라운드 하나
  expect(rounds([to("factory:rework", 1), to("factory:rework", 2), failed("factory:rework", 3)])).toBe(1);
  // 실패 마커는 그 자체로 전이가 아니다(다음 전이를 앞당겨 지우지 않는다)
  expect(rounds([failed("factory:rework", 1), to("factory:rework", 2)])).toBe(1);
});

// r2 SF3 — 요구사항 미달 거부가 `factory-transition:v1 … reason=refused` 마커를 달아도 needs-human
// 수확은 그대로 한 건이고, 사유는 여전히 "**전이 거부** …: " 뒤의 문장이다.
test("SF3: a refusal carrying the transition marker is harvested once, with its refusal reason", () => {
  const body = "<!-- factory-transition:v1 from=factory:ready to=factory:needs-human by=script reason=refused -->\n<!-- factory-transition-refused from=factory:ready to=factory:planned -->\n**전이 거부** factory:ready → factory:planned: plan handoff missing\n\n라벨을 `factory:needs-human`으로 옮겼습니다. 산출물을 보강한 뒤 `:unstick`으로 재개하세요.";
  expect(extractNeedsHuman(7, [{ body, createdAt: "t1" }])).toEqual([{ issue: 7, reason: "plan handoff missing", at: "t1" }]);
});
