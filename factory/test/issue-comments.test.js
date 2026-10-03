import { test, expect } from "vitest";
import { BLOCKED_CAUSES, blockedCause, blockedOrigin, blockedOriginMarker, commentsSinceRequeue, commentsSinceCycleStart, countTransitionsTo, extractNeedsHuman, lastTransition, transitionFailedMarker } from "../lib/retro/issue-comments.js";
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
  // ADR-020 KTB-35 — 일곱 번째 등급: 테스트 명령이 exit≠0인데 리포트의 실패 테스트는 0개.
  // `gates` 규칙(`/gates?\b/`)보다 **먼저** 물려야 한다 — 사유 문구에 "gate log"가 들어 있다.
  expect(blockedCause("command exited 1 with 0 failing tests — unhandled error outside tests (see gate log)")).toBe("gates-unhandled");
  expect(new Set(BLOCKED_CAUSES)).toEqual(new Set(["api-error", "timeout", "cancelled", "gates", "gates-unhandled", "undecidable", "other", "engine-crash"]));
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

/**
 * 설계 2026-09-30 §8.1 (S1) — **재시작 창은 사람의 전이에서만 리셋되고, 사람인지는 계정으로 판정한다.**
 * 예전에는 본문에 `by=human`이 있으면 누가 썼든 창이 리셋됐다. 봇 계정은 이슈에 코멘트를 쓸 수 있으므로(`gh.js`가 인정)
 * 스테이지의 에이전트가 마커를 흉내 내 sweeper의 `stalled restart limit`과 self-gate의 backstop 창을 되돌릴 수 있었다.
 * 재큐(`to=factory:queue`)는 누가 했든 새 주기다 — 그것은 라벨 그래프가 이미 통제한다.
 */
const tr = (from, to, by, author, i) => ({ id: i, body: `<!-- factory-transition:v1 from=${from} to=${to} by=${by} -->\n${from} → ${to}`, createdAt: `2026-09-30T0${i}:00:00Z`, author, authorType: "User", viaApp: null });
const note = (i) => ({ id: i, body: `note ${i}`, createdAt: `2026-09-30T0${i}:00:00Z`, author: "bot-hk" });

test("S1: a human marker written by the factory account does not start a new cycle; one written by another account does", () => {
  const comments = [note(1), tr("factory:needs-human", "factory:rework", "human", "bot-hk", 2), note(3)];
  expect(commentsSinceCycleStart(comments, { factoryLogin: "bot-hk" }).map((c) => c.id)).toEqual([1, 2, 3]);
  const real = [note(1), tr("factory:needs-human", "factory:rework", "human", "LeeHyeonKyu", 2), note(3)];
  expect(commentsSinceCycleStart(real, { factoryLogin: "bot-hk" }).map((c) => c.id)).toEqual([3]);
});

test("S1: an author-less human marker never resets; a re-queue resets whoever wrote it; the legacy call without factoryLogin resets only on known non-empty authors", () => {
  const noAuthor = [note(1), { ...tr("factory:needs-human", "factory:rework", "human", null, 2) }, note(3)];
  expect(commentsSinceCycleStart(noAuthor, { factoryLogin: "bot-hk" }).map((c) => c.id)).toEqual([1, 2, 3]);
  const requeue = [note(1), tr("backlog", "factory:queue", "agent:hk", "bot-hk", 2), note(3)];
  expect(commentsSinceCycleStart(requeue, { factoryLogin: "bot-hk" }).map((c) => c.id)).toEqual([3]);
  const legacy = [note(1), tr("factory:needs-human", "factory:rework", "human", "LeeHyeonKyu", 2), note(3)];
  expect(commentsSinceCycleStart(legacy).map((c) => c.id)).toEqual([3]);
  expect(commentsSinceCycleStart(noAuthor).map((c) => c.id)).toEqual([1, 2, 3]);
});

// ── #174 — K 재시작 브리프의 생산자/독자 한 쌍 ─────────────────────────────────────────────────
import { kRestartComment, kRestartState, wherePaths, K_RESTART, countedTransitionIndices } from "../lib/retro/issue-comments.js";
test("test_174_where_paths_and_restart_state_share_one_rule", () => {
  expect(wherePaths("factory/bin/run-stage.js:1306-1311")).toEqual(["factory/bin/run-stage.js"]);
  expect(wherePaths("`a.js:1`, README.md and factory/lib/x.js:3:9")).toEqual(["a.js", "README.md", "factory/lib/x.js"]);
  expect(wherePaths("/reports")).toEqual([]);
  expect(wherePaths("the summary heading")).toEqual([]);
  expect(wherePaths("https://example.com/a.js")).toEqual([]);
  expect(wherePaths(undefined)).toEqual([]);

  const rw = (by = "factory:run-1") => ({ body: `<!-- factory-transition:v1 from=factory:awaiting-review to=factory:rework by=${by} -->\nx` });
  const fail = { body: transitionFailedMarker({ from: "factory:awaiting-review", to: "factory:rework" }) };
  const brief = (head) => ({ body: kRestartComment({ issue: 9, pr: 3, head, findings: [{ id: "a", where: "src/a.js:1", claim: "c" }] }) });
  // countTransitionsTo와 같은 규칙: failed 마커가 앞의 전이 하나를 지운다.
  const list = [rw(), brief("h1"), rw(), fail, rw()];
  expect(countedTransitionIndices(list, "factory:rework")).toEqual([0, 4]);
  expect(countedTransitionIndices(list, "factory:rework")).toHaveLength(countTransitionsTo(list, "factory:rework"));
  // 쓰인 재시작: 마커 뒤에 살아남은 rework 전이가 있다 → offset은 그 전이까지 센 rework 수.
  const s = kRestartState(list);
  expect(s.used).toBe(true);
  expect(s.offset).toBe(2);
  expect(s.brief).toMatchObject({ pr: 3, head: "h1", paths: ["src/a.js"] });
  // 마커만 있고 전이가 실패했다 → 쓰이지 않았다, 대기 중인 마커는 있다.
  const p = kRestartState([rw(), brief("h1"), rw(), fail]);
  expect(p.used).toBe(false);
  expect(p.pending).toMatchObject({ head: "h1" });
  expect(K_RESTART.test(brief("h1").body)).toBe(true);
});

// ── #174 self-critique — the brief's size is measured AFTER escaping, and a `where` widens the brief only by a file ──
test("test_174_brief_stays_under_the_comment_limit_after_escaping", () => {
  // Claims full of `"`, `\` and control characters: JSON.stringify doubles (or sextuples) each one, and every finding is
  // printed twice (prose + block). The cap must hold on the FINAL body, not on the pre-escape lengths.
  const nasty = '"\\'.repeat(200);
  const findings = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, where: `factory/lib/f${i}.js:1 ${'"'.repeat(180)}`, claim: nasty }));
  const body = kRestartComment({ issue: 174, pr: 31, head: "c".repeat(40), findings });
  expect(body.length).toBeLessThanOrEqual(65536);
  const omitted = Number(/(\d+) more omitted/.exec(body)?.[1]);
  expect(omitted).toBeGreaterThan(0);
  const block = JSON.parse(/```json\s*([\s\S]*?)\s*```/.exec(body)[1]);
  expect(block.omitted).toBe(omitted);
  expect(block.findings.length + block.omitted).toBe(40);
  expect(block.findings.map((f) => f.id)).toEqual(findings.slice(0, block.findings.length).map((f) => f.id));
  // the reader still parses it into a usable brief
  const s = kRestartState([{ body }, { body: "<!-- factory-transition:v1 from=factory:awaiting-review to=factory:rework by=factory:run-7 -->\nx" }]);
  expect(s.used).toBe(true);
  expect(s.brief.error).toBeUndefined();
  expect(s.brief.findings).toHaveLength(block.findings.length);
});

test("test_174_where_directories_and_prose_never_widen_the_brief", () => {
  expect(wherePaths("factory/lib (aggregate)")).toEqual([]);
  expect(wherePaths("factory/")).toEqual([]);
  expect(wherePaths("docs/ and/or factory/test")).toEqual([]);
  expect(wherePaths("factory/lib/self-gate.js:278 and/or factory/lib/")).toEqual(["factory/lib/self-gate.js"]);
});
