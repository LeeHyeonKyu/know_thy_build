import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_N, HEALTH_MARKER, MIN_BASELINE_SAMPLE, RISK_ORDER, WASTE_MULTIPLE,
  costBaselineFor, findHealthIssue, healthSignals, runHealth, sameReport, tierOf,
} from "../bin/health.js";
import { roleSignalsFor } from "../lib/retro/harvest.js";
import { reviewEvidenceLine } from "../lib/run-record.js";
import { heartbeat, recordOf, reviewHandoffComment, planHandoffComment, usageRecordLine } from "./helpers/feedback-fixtures.js";

/**
 * ── Task 4 — 주기 건강 잡 ─────────────────────────────────────────────────────────────────────
 *
 * 두 규약이 이 파일의 전부다:
 *   ① **짝 없는 신호는 발견이 되지 않는다**(spec §5). 그래서 테스트마다 쌍이 **깨진** 판을 함께
 *      세워 둔다 — 100% 승인인데 escaped 0, N 미만, 기준선 표본 부족. 전부 침묵해야 한다.
 *   ② **판정의 출처는 런이 쓴 줄 하나뿐이다**(r1 must_fix 2). 역할별 verdict·라운드는 run 기록의
 *      `review-evidence:` 줄에서만 오고, 그 줄조차 하트비트가 아는 런을 지목할 때만 읽는다.
 *      핸드오프 본문(에이전트가 쓴다)은 must_fix 참고 열과 tier 폴백에만 쓰인다.
 *
 * 픽스처는 전부 진짜 생산자가 만든다: `reviewEvidenceLine`·`appendRunRecord`·`heartbeatBody`·
 * `renderHandoff`·`usageLine`. 회귀 두 건은 **실제 저장소에서 받아 온 원문**이다(`fixtures/*.json`).
 */

const dayOf = (n) => `2026-09-${String(n).padStart(2, "0")}T00:00:00Z`;
const runnerOf = (issue, round) => `gha-9${issue}00${round}`;

const shaOf = (issue) => `${issue}`.padStart(2, "0").repeat(20).slice(0, 40);
/** 한 라운드의 `review-evidence:` 줄 — **진짜 생산자**(`reviewEvidenceLine`)가 만든다. */
const evidence = (issue, round, verdicts) => reviewEvidenceLine({
  headSha: shaOf(issue),
  round, decision: verdicts.some((v) => v.verdict === "reject") ? "rework" : "approved",
  verdicts, runId: runnerOf(issue, round).replace("gha-", ""), runnerId: runnerOf(issue, round),
});

const approve = (role) => ({ role, verdict: "approve" });
const reject = (role) => ({ role, verdict: "reject" });

/**
 * 이슈 하나를 세운다: run 기록(라운드별 evidence 줄 + 비용) + 하트비트(런 바인딩의 앵커) + 선택적
 * plan 핸드오프. `rounds`는 라운드별 verdict 배열이다.
 */
function issueOf({ n, day, tier, costUsd = 5, rounds = [], plan = null, labels = null }) {
  const sections = rounds.map((verdicts, i) => ({
    stage: "review", at: dayOf(day + i), runner: runnerOf(n, i + 1),
    lines: ["verify: ok", evidence(n, i + 1, verdicts), usageRecordLine({ costUsd: round2(costUsd / rounds.length) })],
  }));
  if (!rounds.length) sections.push({ stage: "review", at: dayOf(day), runner: runnerOf(n, 1), lines: ["verify: ok", usageRecordLine({ costUsd })] });
  const comments = rounds.map((_, i) => heartbeat(n, "review", runnerOf(n, i + 1), dayOf(day + i)));
  if (!rounds.length) comments.push(heartbeat(n, "review", runnerOf(n, 1), dayOf(day)));
  if (plan) comments.push(planHandoffComment(n, { at: dayOf(day), ...plan }));
  return {
    issue: {
      number: n, title: `issue ${n}`, state: "closed", closedAt: dayOf(day), updatedAt: dayOf(day),
      labels: labels ?? [{ name: "factory:merged" }, ...(tier ? [{ name: `factory:tier-${tier}` }] : [])],
    },
    comments,
    record: recordOf(n, `issue ${n}`, sections),
  };
}
const round2 = (x) => Math.round(x * 100) / 100;

function windowOf(specs) {
  const issues = [];
  const commentsByIssue = new Map();
  const records = new Map();
  for (const s of specs) {
    const b = issueOf(s);
    issues.push(b.issue);
    commentsByIssue.set(s.n, b.comments);
    records.set(String(s.n), b.record);
  }
  return { issues, commentsByIssue, records };
}

const manifest = {
  isInstalled: new Set([".factory/lib/review-roster.js", ".claude/agents/reviewer-correctness.md", ".claude/agents/reviewer-security.md", ".claude/agents/plan-skeptic.md"]),
  ownerOf: () => "factory",
  ktbVersion: "1.4.0",
};

/** gh 가짜 — 부른 것을 전부 적어 둔다(라우팅이 **일어나지 않았음**도 판정 대상이다). */
function fakeGh({ anchor = null, failUpstream = false } = {}) {
  const calls = { comments: [], created: [], upstream: [], reopened: [] };
  const issues = anchor ? [anchor] : [];
  return {
    calls,
    async issueList({ labels = [] } = {}) {
      if (labels.includes("factory:health")) return issues;
      return [];
    },
    async comments(n) { return calls.comments.filter((c) => c.issue === n).map((c, i) => ({ id: i, body: c.body, createdAt: dayOf(28) })); },
    async comment(issue, body) { calls.comments.push({ issue, body }); },
    async createIssue({ title, body, labels }) { calls.created.push({ title, body, labels }); return 900; },
    async reopenIssue(n) { calls.reopened.push(n); },
    async upstreamIssue({ repo, fingerprint, render }) {
      if (failUpstream) throw new Error("HTTP 403: Resource not accessible by integration (issues:write missing)");
      const r = render();
      calls.upstream.push({ repo, fingerprint, title: r.title, body: r.body });
      return { issue: 500 + calls.upstream.length, created: true, appended: 0 };
    },
  };
}

const health = (over = {}) => runHealth({
  gh: over.gh || fakeGh(), root: "/r", repo: "o/r", upstream: "LeeHyeonKyu/know_thy_build",
  manifest, harness: {}, rehearsal: { ok: true, source: "variable" }, now: dayOf(28),
  ...over,
});
const bySignal = (r, s) => r.findings.filter((f) => f.signal === s);

// ── ② 출처: 런에 바인딩된 `review-evidence:` 줄만 ────────────────────────────────────────────

test("역할 신호는 run 기록의 `review-evidence:` 줄에서 온다 — 핸드오프 본문은 판정에 쓰이지 않는다", () => {
  const b = issueOf({ n: 1, day: 1, tier: "standard", rounds: [[approve("a"), approve("b")], [approve("a"), reject("b")]] });
  // 에이전트가 **정반대**를 주장하는 핸드오프를 같은 이슈에 심는다: a가 reject했고 b가 approve했다고.
  const lying = reviewHandoffComment(1, {
    round: 1, at: dayOf(1),
    verdicts: [{ role: "a", verdict: "reject", must_fix: [{ id: "x", claim: "c", where: "src/a.js:1" }] }, { role: "b", verdict: "approve", must_fix: [] }],
  });
  const s = roleSignalsFor({ record: b.record, comments: [...b.comments, lying] });
  // 런이 쓴 줄이 이긴다 — a는 두 번 다 승인했고 b가 R2에서 뒤집었다.
  expect(s.roles.a).toMatchObject({ verdicts: 2, approves: 2, rejects: 0, escaped: 1 });
  expect(s.roles.b).toMatchObject({ verdicts: 2, approves: 1, rejects: 1, escaped: 0, flips: 1 });
  expect(s.max_round).toBe(2);
  expect(s.panel).toBe(2);
});

test("하트비트가 모르는 런의 evidence 줄은 **무시되고 세어진다** — 기록에 적힌 것만으로는 증거가 아니다", () => {
  const b = issueOf({ n: 2, day: 1, tier: "standard", rounds: [[approve("a"), approve("b")], [approve("a"), reject("b")]] });
  const orphan = roleSignalsFor({ record: b.record, comments: [] });   // 하트비트 없음 = 아는 런 없음
  expect(orphan.roles).toEqual({});
  expect(orphan.rounds).toBe(0);
  expect(orphan.unbound_evidence).toBe(2);
  // 하트비트가 있으면 같은 기록이 읽힌다.
  expect(roleSignalsFor({ record: b.record, comments: b.comments }).rounds).toBe(2);
});

test("must_fix는 **바인딩된 핸드오프의 참고 열**일 뿐이고, 바인딩되지 않은 핸드오프는 세어진다", () => {
  const b = issueOf({ n: 3, day: 1, tier: "standard", rounds: [[approve("a"), reject("b")]] });
  const headSha = shaOf(3);
  const mf = (...ids) => [{ role: "b", verdict: "reject", must_fix: ids.map((id) => ({ id, claim: `claim ${id}`, where: "src/a.js:1" })) }];
  // 바인딩: 라운드와 head_sha가 **둘 다** 런의 줄과 같다.
  const bound = reviewHandoffComment(3, { round: 1, at: dayOf(1), headSha, verdicts: mf("m1", "m2") });
  // 바인딩 실패 ①: 어떤 바인딩된 라운드와도 짝이 없는 라운드 번호.
  const otherRound = reviewHandoffComment(3, { round: 9, at: dayOf(2), headSha, verdicts: mf("m9") });
  // 바인딩 실패 ②: 라운드는 맞지만 **다른 커밋**의 판정이다.
  const otherSha = reviewHandoffComment(3, { round: 1, at: dayOf(2), headSha: "f".repeat(40), verdicts: mf("m8") });

  const s = roleSignalsFor({ record: b.record, comments: [...b.comments, bound, otherRound, otherSha] });
  expect(s.roles.b.must_fix_ref).toBe(2);    // 바인딩된 핸드오프의 must_fix만 참고 열에 든다
  expect(s.unbound_handoffs).toBe(2);
  expect(s.roles.b.escaped).toBe(0);         // must_fix 개수는 방아쇠가 아니다
  expect(s.roles.a.escaped).toBe(0);         // 같은 라운드의 reject는 귀속되지 않는다
});

// ── ③ tier 앵커는 러너가 붙인 라벨이다 ───────────────────────────────────────────────────────

test("tier 앵커는 `factory:tier-*` 라벨이고, 에이전트의 자기 신고 `tier`는 절대 읽지 않는다", () => {
  const labels = [{ name: "factory:merged" }, { name: "factory:tier-docs" }];
  // 핸드오프는 load-bearing이라 주장한다(자기 신고 `tier` + `tier_effective` 둘 다).
  expect(tierOf({ labels }, { tier_handoff: "load-bearing" })).toEqual({ tier: "docs", source: "label" });
  // 라벨이 없을 때만 **바인딩된** 핸드오프의 tier_effective로 물러선다.
  expect(tierOf({ labels: [{ name: "factory:merged" }] }, { tier_handoff: "load-bearing" })).toEqual({ tier: "load-bearing", source: "handoff" });
  expect(tierOf({ labels: [] }, {})).toEqual({ tier: null, source: "none" });
  // 자기 신고 `tier`만 있는 핸드오프는 `tier_handoff`를 채우지 않는다(harvest가 `tier_effective`만 읽는다).
  const b = issueOf({ n: 4, day: 1, tier: null, rounds: [[approve("a")]] });
  const selfReported = reviewHandoffComment(4, { round: 1, at: dayOf(1), verdicts: [{ role: "a", verdict: "approve", must_fix: [] }] });
  expect(roleSignalsFor({ record: b.record, comments: [...b.comments, selfReported] }).tier_handoff).toBeNull();
});

// ── (a) rubber-stamp — 짝이 있을 때만 ────────────────────────────────────────────────────────

test("100% 승인 + 귀속된 escaped 라운드 ≥1 → `[ktb]` rubber-stamp 발견", async () => {
  const w = windowOf([1, 2, 3, 4, 5].map((n) => ({
    n, day: n, tier: "standard", costUsd: 10,
    rounds: [[approve("correctness"), approve("security")], [approve("correctness"), reject("security")]],
  })));
  const gh = fakeGh();
  const r = await health({ gh, ...w });

  const stamp = bySignal(r, "rubber-stamp");
  expect(stamp).toHaveLength(1);
  expect(stamp[0]).toMatchObject({
    signal: "rubber-stamp", kind: "behavioural", paired: true, role: "correctness",
    stage: "review", repo: "o/r", causal_path: ".claude/agents/reviewer-correctness.md", issue: 900,
  });
  // 짝의 양쪽이 **구조로** 잡혀 있다(산문 정규식이 아니라).
  expect(r.signals.roles.correctness).toMatchObject({ verdicts: 10, approves: 10, rejects: 0, approve_rate: 1, ever_rejects: false, escaped_defects: 5, issues: 5 });
  expect(r.signals.roles.security).toMatchObject({ verdicts: 10, approves: 5, rejects: 5, ever_rejects: true, escaped_defects: 0 });
  expect(stamp.map((f) => f.role)).toEqual(["correctness"]);
  expect(r.signals.attributable).toBe(5);
  // T3의 팔을 타고 상류로 갔다.
  expect(gh.calls.upstream).toHaveLength(1);
  expect(r.classified.every((c) => c.tags.includes("ktb"))).toBe(true);
  expect(r.ok).toBe(true);
});

test("100% 승인이지만 escaped 0 → **아무 발견도 없다**(승인률만으로는 판정 불가)", async () => {
  const w = windowOf([1, 2, 3, 4, 5].map((n) => ({
    n, day: n, tier: "standard", costUsd: 10, rounds: [[approve("correctness"), approve("security")]],
  })));
  const gh = fakeGh();
  const r = await health({ gh, ...w });
  expect(r.findings).toEqual([]);
  expect(gh.calls.upstream).toEqual([]);
  expect(r.signals.roles.correctness).toMatchObject({ approve_rate: 1, ever_rejects: false, escaped_defects: 0 });
});

test("귀속 가능한 이슈가 N개에 못 미치면 역할 규칙을 아예 돌리지 않는다(1.4 이전 기록의 침묵)", async () => {
  // 다섯 이슈가 머지됐지만 그중 넷은 `review-evidence:` 줄이 없다(하트비트만 있다).
  const withEvidence = { n: 1, day: 1, tier: "standard", costUsd: 10, rounds: [[approve("correctness"), approve("security")], [approve("correctness"), reject("security")]] };
  const legacy = [2, 3, 4, 5].map((n) => ({ n, day: n, tier: "standard", costUsd: 10, rounds: [] }));
  const gh = fakeGh();
  const r = await health({ gh, ...windowOf([withEvidence, ...legacy]) });
  expect(r.below_n).toBe(false);                    // 머지는 다섯이다
  expect(r.signals.attributable).toBe(1);           // 그러나 읽을 수 있었던 것은 하나뿐이다
  expect(bySignal(r, "rubber-stamp")).toEqual([]);
  expect(gh.calls.upstream).toEqual([]);
  expect(r.report).toContain("**1개**");
});

// ── (b) dead debate — 보고만 하고 라우팅하지 않는다 ─────────────────────────────────────────

test("dead-debate는 **advisory**다 — 보고서에 실리고 절대 라우팅되지 않는다", async () => {
  const w = windowOf([1, 2, 3, 4, 5].map((n) => ({
    n, day: n, tier: "standard", costUsd: 10,
    plan: { done_when: [{ id: "dw1", text: "x", verify: "t", level: "unit" }], dissent_log: [{ role: "skeptic", objection: "위험하다", resolution: "deferred" }] },
    rounds: [[approve("correctness"), reject("security")], [approve("correctness"), approve("security")]],
  })));
  const gh = fakeGh();
  const r = await health({ gh, ...w });

  expect(r.advisories).toHaveLength(1);
  expect(r.advisories[0]).toMatchObject({ signal: "dead-debate", anchored: false, stage: "plan" });
  expect(r.advisories[0].caveat).toContain("never routed");
  expect(bySignal(r, "dead-debate")).toEqual([]);           // 발견 목록에는 없다
  expect(r.findings.map((f) => f.signal)).not.toContain("dead-debate");
  expect(gh.calls.upstream).toEqual([]);                    // 상류로 나가지 않았다
  expect(r.report).toContain("앵커가 없어 라우팅하지 않음");
});

test("한 번이라도 계획을 바꿨으면 advisory도 없다", async () => {
  const specs = [1, 2, 3, 4, 5].map((n) => ({
    n, day: n, tier: "standard", costUsd: 10,
    plan: { done_when: [{ id: "dw1", text: "x", verify: "t", level: "unit" }], dissent_log: [{ role: "skeptic", objection: "위험하다", resolution: "deferred" }] },
    rounds: [[approve("correctness"), approve("security")]],
  }));
  specs[2].plan.dissent_log = [{ role: "skeptic", objection: "검증 불가다", resolution: "accepted — done_when을 하나 더 넣었다" }];
  const r = await health({ ...windowOf(specs) });
  expect(r.advisories).toEqual([]);
});

// ── (c) cost vs risk ─────────────────────────────────────────────────────────────────────────

test("costBaselineFor — 더 위험한 이슈가 2건 미만이면 기준선이 없고, 있으면 그 출처 tier를 말한다", () => {
  expect(RISK_ORDER).toEqual(["docs", "standard", "load-bearing"]);
  expect(MIN_BASELINE_SAMPLE).toBe(2);
  expect(WASTE_MULTIPLE).toBe(1.25);
  const per = [{ tier: "standard", cost: 10 }, { tier: "standard", cost: 30 }, { tier: "load-bearing", cost: 50 }];
  expect(costBaselineFor("docs", per)).toEqual({ usd: 30, tiers: ["standard", "load-bearing"], n: 3 });
  // 표본 하나짜리 "중앙값"은 중앙값이 아니다.
  expect(costBaselineFor("docs", [{ tier: "standard", cost: 6 }])).toEqual({ usd: null, tiers: [], n: 1 });
  expect(costBaselineFor("load-bearing", per)).toEqual({ usd: null, tiers: [], n: 0 });
});

test("docs diff를 전체 패널에 태우고 비용이 임계(1.25×)를 넘으면 waste 발견", async () => {
  const PANEL = ["architecture", "correctness", "qa", "spec-conformance"];
  const specs = [
    { n: 1, day: 1, tier: "standard", costUsd: 20, rounds: [PANEL.map(approve)] },
    { n: 2, day: 2, tier: "standard", costUsd: 20, rounds: [PANEL.map(approve)] },
    { n: 3, day: 3, tier: "load-bearing", costUsd: 24, rounds: [PANEL.map(approve)] },
    { n: 4, day: 4, tier: "docs", costUsd: 3, rounds: [[approve("correctness")]] },
    { n: 5, day: 5, tier: "docs", costUsd: 80, rounds: [PANEL.map(approve)] },
  ];
  const gh = fakeGh();
  const r = await health({ gh, ...windowOf(specs) });

  const waste = bySignal(r, "cost-vs-risk");
  expect(waste).toHaveLength(1);
  expect(waste[0]).toMatchObject({ signal: "cost-vs-risk", kind: "behavioural", paired: true, issue: 5, stage: "review", causal_path: ".factory/lib/review-roster.js" });
  expect(waste[0].extra.cost).toEqual({ usd: 80, baseline: 20, threshold: 25, baseline_tiers: ["standard", "load-bearing"] });
  expect(r.signals.cost_vs_risk.find((x) => x.issue === 5)).toMatchObject({ tier: "docs", tier_source: "label", panel: 4, cost: 80, baseline: 20, threshold: 25 });
  // 값싼 docs 이슈(#4)는 같은 tier인데도 발견이 아니다 — 패널도 작고 임계도 넘지 않는다.
  expect(waste.map((f) => f.issue)).not.toContain(4);
  // 발견 본문은 **실제로 존재하는** tier만 근거로 든다.
  expect(waste[0].reason).toContain("`standard`, `load-bearing`");
});

test("리뷰어 probe C — standard $6 한 건 + docs $6.50이면 발견이 없다(표본 1건, 1.25× 미만)", async () => {
  const specs = [
    { n: 1, day: 1, tier: "standard", costUsd: 6, rounds: [[approve("a"), approve("b")]] },
    { n: 2, day: 2, tier: "docs", costUsd: 6.5, rounds: [[approve("a"), approve("b")]] },
    { n: 3, day: 3, tier: "docs", costUsd: 1, rounds: [[approve("a"), approve("b")]] },
    { n: 4, day: 4, tier: "docs", costUsd: 1, rounds: [[approve("a"), approve("b")]] },
    { n: 5, day: 5, tier: "docs", costUsd: 1, rounds: [[approve("a"), approve("b")]] },
  ];
  const r = await health({ ...windowOf(specs) });
  expect(bySignal(r, "cost-vs-risk")).toEqual([]);
  const row = r.signals.cost_vs_risk.find((x) => x.issue === 2);
  expect(row).toMatchObject({ baseline: null, baseline_n: 1, threshold: null });
});

// ── (d) N 미만 ───────────────────────────────────────────────────────────────────────────────

test("머지 이슈가 N개에 못 미치면 **아무것도 방출하지 않는다**", async () => {
  expect(DEFAULT_N).toBe(5);
  const w = windowOf([1, 2, 3, 4].map((n) => ({
    n, day: n, tier: "standard", costUsd: 10,
    rounds: [[approve("correctness"), approve("security")], [approve("correctness"), reject("security")]],
  })));
  const gh = fakeGh();
  const r = await health({ gh, ...w });
  expect(r.below_n).toBe(true);
  expect(r.findings).toEqual([]);
  expect(r.advisories).toEqual([]);
  expect(gh.calls.upstream).toEqual([]);
  expect(gh.calls.created).toHaveLength(1);          // 보고서는 그래도 나간다
});

test("표본 미달 보고서는 **바뀐 것이 있을 때만** 다시 적는다(주마다 같은 줄을 붙이지 않는다)", async () => {
  const w = windowOf([1, 2].map((n) => ({ n, day: n, tier: "standard", costUsd: 10, rounds: [[approve("a")]] })));
  const anchor = { number: 77, state: "open", body: HEALTH_MARKER, labels: [{ name: "factory:health" }] };
  const gh = fakeGh({ anchor });
  await health({ gh, ...w });
  expect(gh.calls.comments.filter((c) => c.issue === 77)).toHaveLength(1);
  // 같은 창을 **다른 날** 다시 돌린다 — 내용이 같으므로 새 코멘트는 없다.
  const r2 = await health({ gh, ...w, now: dayOf(29) });
  expect(gh.calls.comments.filter((c) => c.issue === 77)).toHaveLength(1);
  expect(r2.actions.some((a) => a.kind === "health-report-skipped")).toBe(true);
});

test("sameReport는 제목 줄의 날짜만 다른 두 보고서를 같다고 본다", () => {
  const a = `${HEALTH_MARKER}\n## factory-health — 2026-09-28\n\nbody`;
  const b = `${HEALTH_MARKER}\n## factory-health — 2026-10-05\n\nbody`;
  expect(sameReport(a, b)).toBe(true);
  expect(sameReport(a, `${b}\nmore`)).toBe(false);
  expect(sameReport(null, b)).toBe(false);
});

// ── 앵커 이슈: 본문 마커로 dedupe, 닫혀 있으면 다시 연다 ────────────────────────────────────

test("건강 이슈는 본문 마커로 찾는다 — 닫혀 있어도 새로 열지 않고 **다시 연다**", async () => {
  const w = windowOf([1, 2, 3, 4, 5].map((n) => ({ n, day: n, tier: "standard", costUsd: 10, rounds: [[approve("a")]] })));
  const closed = { number: 42, state: "closed", body: `${HEALTH_MARKER}\n## factory-health — 2026-09-01`, labels: [] };
  const gh = fakeGh({ anchor: closed });

  const a = await health({ gh, ...w });
  expect(gh.calls.created).toEqual([]);              // 두 번째 이슈를 만들지 않는다
  expect(gh.calls.reopened).toEqual([42]);
  expect(a.report_issue).toBe(42);

  const b = await health({ gh, ...w, now: dayOf(29) });
  expect(gh.calls.created).toEqual([]);
  expect(b.report_issue).toBe(42);
  expect(gh.calls.reopened).toEqual([42, 42]);       // 여전히 닫혀 있다고 보고되므로 다시 연다
});

test("findHealthIssue — 라벨이 없어도 본문 마커면 찾고, 여럿이면 가장 오래된 것이 정본이다", async () => {
  const gh = {
    async issueList({ labels = [] }) {
      if (labels.includes("factory:health")) return [];
      return [
        { number: 9, state: "open", body: "무관한 이슈", labels: [] },
        { number: 5, state: "closed", body: `${HEALTH_MARKER}\nold`, labels: [] },
        { number: 7, state: "open", body: `${HEALTH_MARKER}\nnewer`, labels: [] },
      ];
    },
  };
  expect((await findHealthIssue(gh)).number).toBe(5);
});

// ── 실패 경로 ────────────────────────────────────────────────────────────────────────────────

test("상류 쓰기가 권한으로 거부되면 `ok:false`이고 실패가 위로 올라온다(조용한 exit 0이 아니다)", async () => {
  const w = windowOf([1, 2, 3, 4, 5].map((n) => ({
    n, day: n, tier: "standard", costUsd: 10,
    rounds: [[approve("correctness"), approve("security")], [approve("correctness"), reject("security")]],
  })));
  const gh = fakeGh({ failUpstream: true });
  const r = await health({ gh, ...w });
  expect(bySignal(r, "rubber-stamp")).toHaveLength(1);       // 발견은 났다
  expect(r.ok).toBe(false);                                   // 그런데 나르지 못했다
  expect(r.failures).toHaveLength(1);
  expect(r.failures[0].reason).toContain("403");
});

test("설치 매니페스트가 없으면 발견을 분류조차 못 한다 — `ok:false`", async () => {
  const w = windowOf([1, 2, 3, 4, 5].map((n) => ({
    n, day: n, tier: "standard", costUsd: 10,
    rounds: [[approve("correctness"), approve("security")], [approve("correctness"), reject("security")]],
  })));
  const r = await health({ ...w, manifest: null });
  expect(r.ok).toBe(false);
  expect(r.failures[0].reason).toContain("install manifest not found");
});

test("리허설 기록은 **건강 줄**이지 발견이 아니다 — RED여도 행동 발견을 만들지 않는다", async () => {
  const w = windowOf([1, 2, 3, 4, 5].map((n) => ({ n, day: n, tier: "standard", costUsd: 10, rounds: [[approve("a")]] })));
  const gh = fakeGh();
  const r = await health({ gh, ...w, rehearsal: { ok: false, reason: "harness changed since the last rehearsal — run `factory rehearse`" } });
  expect(r.report).toContain("harness changed since the last rehearsal");
  expect(r.findings).toEqual([]);
  expect(gh.calls.upstream).toEqual([]);
  expect(r.ok).toBe(true);                                    // 리허설 RED는 이 잡의 실패가 아니다
});

// ── collect(): 주입 없이 gh + records 브랜치에서 읽는다 ─────────────────────────────────────

test("주입 없이 돌면 이슈는 gh에서, 비용은 **records 브랜치**에서 하이드레이트된다", async () => {
  const b1 = issueOf({ n: 11, day: 1, tier: "docs", costUsd: 90, rounds: [[approve("a"), approve("b"), approve("c"), approve("d")]] });
  const b2 = issueOf({ n: 12, day: 2, tier: "standard", costUsd: 20, rounds: [[approve("a"), approve("b"), approve("c"), approve("d")]] });
  const b3 = issueOf({ n: 13, day: 3, tier: "load-bearing", costUsd: 20, rounds: [[approve("a"), approve("b"), approve("c"), approve("d")]] });
  const b4 = issueOf({ n: 14, day: 4, tier: "standard", costUsd: 20, rounds: [[approve("a"), approve("b"), approve("c"), approve("d")]] });
  const b5 = issueOf({ n: 15, day: 5, tier: "standard", costUsd: 20, rounds: [[approve("a"), approve("b"), approve("c"), approve("d")]] });
  const built = [b1, b2, b3, b4, b5];

  const listed = [];
  const gh = {
    ...fakeGh(),
    async issueList(q) { listed.push(q); if (q.labels?.includes("factory:health")) return []; return built.map((b) => b.issue); },
    async comments(n) { return built.find((b) => b.issue.number === n)?.comments ?? []; },
    async comment() {}, async createIssue() { return 900; }, async reopenIssue() {},
    async upstreamIssue({ render }) { render(); return { issue: 501, created: true }; },
  };

  // `readRecordsDetailed`가 부르는 git을 가짜 run으로 받는다 — records 브랜치를 **실제로 통과**한다.
  const files = new Map(built.map((b) => [`docs/factory/runs/${b.issue.number}.md`, b.record]));
  const run = async (cmd, args) => {
    const a = args.join(" ");
    if (cmd !== "git") return { code: 0, stdout: "", stderr: "" };
    if (a.startsWith("fetch")) return { code: 0, stdout: "", stderr: "" };
    if (a.startsWith("rev-parse")) return { code: 0, stdout: "deadbeef\n", stderr: "" };
    if (a.startsWith("ls-remote")) return { code: 0, stdout: "deadbeef\trefs/heads/factory/records\n", stderr: "" };
    if (a.startsWith("ls-tree")) return { code: 0, stdout: [...files.keys()].map((p, i) => `100644 blob ${String(i).repeat(40)}\t${p}`).join("\n"), stderr: "" };
    if (a.startsWith("show")) {
      const p = a.slice(a.indexOf(":") + 1);
      return files.has(p) ? { code: 0, stdout: files.get(p), stderr: "" } : { code: 1, stdout: "", stderr: "no such path" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const r = await runHealth({ gh, run, root: "/r", repo: "o/r", upstream: "u/p", manifest, harness: {}, now: dayOf(28) });

  // 이슈 조회는 머지된 것으로 좁혔다(nit 9) — 창은 "최근 머지된 N개"다.
  expect(listed).toContainEqual({ labels: ["factory:merged"], state: "all", limit: 200 });
  // 비용이 **실제로** 들어왔다 — 주입 없이.
  expect(r.signals.records_source).toBe("records-branch");
  expect(r.signals.priced).toBe(5);
  expect(r.signals.cost_by_tier.docs).toBeGreaterThan(80);
  // 그리고 그 비용 위에서 규칙이 실제로 돈다.
  expect(bySignal(r, "cost-vs-risk").map((f) => f.issue)).toEqual([11]);
});

test("records 브랜치가 없으면 비용 신호가 비고, 그 사실이 보고서에 적힌다(지어낸 0이 아니다)", async () => {
  const built = [1, 2, 3, 4, 5].map((n) => issueOf({ n, day: n, tier: "standard", costUsd: 10, rounds: [[approve("a")]] }));
  const gh = {
    ...fakeGh(),
    async issueList(q) { return q.labels?.includes("factory:health") ? [] : built.map((b) => b.issue); },
    async comments(n) { return built.find((b) => b.issue.number === n)?.comments ?? []; },
    async comment() {}, async createIssue() { return 900; }, async reopenIssue() {},
  };
  // `ls-remote --exit-code`는 브랜치가 없으면 **2**로 끝난다 — 그것이 "브랜치 자체가 없다"의 신호다.
  const run = async (cmd, args) => (args.join(" ").startsWith("ls-remote") ? { code: 2, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "" });
  const r = await runHealth({ gh, run, root: "/r", repo: "o/r", manifest, harness: {}, now: dayOf(28) });
  expect(r.signals.records_source).toBe("no-records-branch");
  expect(r.signals.priced).toBe(0);
  expect(r.signals.cost_vs_risk).toEqual([]);
  expect(r.report).toContain("no-records-branch");
});

// ── 고정된 회귀 — **실제 저장소에서 받아 온 원문** ──────────────────────────────────────────

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

test("회귀 — own-calendar #3 (실제 기록): 리뷰 4라운드에 리뷰어가 REJECT했다 → rounds 4, rubber-stamp 없음", async () => {
  const f = fixture("own-calendar-3");
  expect(f._source).toContain("own-calendar#3");
  const s = roleSignalsFor({ record: f.record, comments: f.comments });

  // 실제 기록이 말하는 것: 라운드 4개, 4역할 패널, 마지막에 승인.
  expect(s.max_round).toBe(4);
  expect(s.rounds).toBe(4);
  expect(s.panel).toBe(4);
  expect(s.decisions).toEqual([
    { round: 1, decision: "rework" }, { round: 2, decision: "rework" },
    { round: 3, decision: "rework" }, { round: 4, decision: "approved" },
  ]);
  // 세 역할이 실제로 거절했다 — 그들에게는 어떤 규칙도 걸리지 않는다.
  expect(s.roles.correctness).toMatchObject({ verdicts: 4, rejects: 2 });
  expect(s.roles.architecture).toMatchObject({ verdicts: 4, rejects: 1 });
  expect(s.roles["spec-conformance"]).toMatchObject({ verdicts: 4, rejects: 1 });

  // 이 이슈 하나로 돌린 건강 잡: 표본 미달이라 **아무 발견도 없다**.
  const b = { number: f.issue.number, title: f.issue.title, state: f.issue.state, closedAt: f.issue.closedAt, updatedAt: f.issue.updatedAt, labels: f.issue.labels };
  const gh = fakeGh();
  const r = await health({
    gh, issues: [b], commentsByIssue: new Map([[b.number, f.comments]]), records: new Map([[String(b.number), f.record]]),
  });
  expect(r.below_n).toBe(true);
  expect(r.findings).toEqual([]);
  expect(gh.calls.upstream).toEqual([]);
  expect(r.signals.rounds_per_issue).toEqual([{ issue: 3, review: 4 }]);
  // tier 앵커는 러너의 라벨이다.
  expect(r.signals.per_issue[0]).toMatchObject({ tier: "standard", tier_source: "label" });
  // 거절한 역할은 승인률이 1이 아니므로, 표본이 채워져도 rubber-stamp가 되지 않는다.
  for (const role of ["correctness", "architecture", "spec-conformance"]) expect(r.signals.roles[role].ever_rejects).toBe(true);
});

test("회귀 — KTB #18 (실제 기록): 러너는 이 이슈를 `standard`로 채점했다 → cost_vs_risk는 침묵한다", async () => {
  const f = fixture("ktb-18");
  expect(f._source).toContain("know_thy_build#18");
  // 실제 라벨이 그렇다 — 플랜의 "docs 이슈"는 diff의 **내용**을 가리킨 말이고, 러너의 채점은 standard다.
  expect(f.issue.labels.map((l) => l.name)).toContain("factory:tier-standard");

  const s = roleSignalsFor({ record: f.record, comments: f.comments });
  expect(s.max_round).toBe(3);
  expect(s.panel).toBe(4);
  expect(s.decisions.map((d) => d.decision)).toEqual(["rework", "rework", "rework"]);
  // qa가 세 라운드 내내 거절했고, architecture/spec-conformance는 세 번 다 승인했다.
  expect(s.roles.qa).toMatchObject({ verdicts: 3, approves: 0, rejects: 3, escaped: 0 });
  expect(s.roles.architecture).toMatchObject({ verdicts: 3, approves: 3, rejects: 0, escaped: 2 });
  expect(s.roles["spec-conformance"]).toMatchObject({ verdicts: 3, approves: 3, rejects: 0, escaped: 2 });

  const b = { number: f.issue.number, title: f.issue.title, state: f.issue.state, closedAt: f.issue.closedAt, updatedAt: f.issue.updatedAt, labels: f.issue.labels };
  const gh = fakeGh();
  const r = await health({
    gh, issues: [b], commentsByIssue: new Map([[b.number, f.comments]]), records: new Map([[String(b.number), f.record]]),
  });
  const row = r.signals.cost_vs_risk.find((x) => x.issue === 18);
  // 비용은 진짜로 읽혔다(플랜이 말한 "~$80").
  expect(row.cost).toBeGreaterThan(80);
  expect(row.cost).toBeLessThan(90);
  // 그러나 tier 앵커가 `standard`이므로 **가장 낮은 위험**에만 거는 waste 규칙은 이 이슈에 걸리지 않는다.
  expect(row).toMatchObject({ tier: "standard", tier_source: "label" });
  expect(bySignal(r, "cost-vs-risk")).toEqual([]);
  expect(gh.calls.upstream).toEqual([]);
});

test("회귀 — KTB의 실제 창: 6개 머지 중 `review-evidence:`를 가진 것은 2개뿐이라 귀속이 안 된다", () => {
  // 1.4 이전 런은 그 줄을 쓰지 않았다. 그 침묵을 "리뷰어가 깨끗했다"로 읽으면 안 된다 —
  // `attributable`이 그 둘을 가른다(위 "귀속 가능한 이슈가 N개에 못 미치면" 테스트가 규칙을 고정한다).
  const ktb18 = fixture("ktb-18");
  const owncal3 = fixture("own-calendar-3");
  for (const f of [ktb18, owncal3]) {
    expect((f.record.match(/^review-evidence:/gm) || []).length).toBeGreaterThan(0);
  }
  // 그리고 evidence 줄이 없는 기록은 역할 신호를 하나도 내지 않는다(하트비트가 있어도).
  const legacy = roleSignalsFor({ record: "## review · 2026-09-01T00:00Z · gha-1\nverify: ok\n", comments: [heartbeat(9, "review", "gha-1", dayOf(1))] });
  expect(legacy.roles).toEqual({});
  expect(legacy.rounds).toBe(0);
});
