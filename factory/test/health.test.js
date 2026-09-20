import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_N, HEALTH_MARKER, MIN_BASELINE_SAMPLE, RISK_ORDER, TIER_RESOLVER_PATH,
  WASTE_MIN_EXCESS_USD, WASTE_MULTIPLE,
  costBaselineFor, diffRiskOf, diffShapeOf, findHealthIssue, healthSignals, runHealth, sameReport, tierOf,
} from "../bin/health.js";
import { roleSignalsFor } from "../lib/retro/harvest.js";
import { reviewEvidenceLine } from "../lib/run-record.js";
import { heartbeat, humanDecisionComment, recordOf, reviewHandoffComment, planHandoffComment, usageRecordLine } from "./helpers/feedback-fixtures.js";

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
function issueOf({ n, day, tier, costUsd = 5, rounds = [], plan = null, labels = null, files = null, prs = null }) {
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
    // 머지된 PR의 파일 목록 — **GitHub의 사실**이 서는 자리(r2). `files: null`이면 모양 미상이다.
    // `prs`는 그 이슈에서 머지된 PR **전부**이고 모양은 그 합집합으로 판정한다(r3).
    pr: files ? { pr: 1000 + n, prs: prs ?? [1000 + n], files } : null,
  };
}
const round2 = (x) => Math.round(x * 100) / 100;
/** 전부 docs 글롭에 맞는 경로 / 코드가 하나라도 섞인 경로 */
const DOCS_FILES = ["README.md", "docs/guide.md", "docs/factory/notes.md"];
const CODE_FILES = ["README.md", "src/app.js"];
const PANEL4 = ["architecture", "correctness", "qa", "spec-conformance"];

function windowOf(specs) {
  const issues = [];
  const commentsByIssue = new Map();
  const records = new Map();
  const prByIssue = new Map();
  for (const s of specs) {
    const b = issueOf(s);
    issues.push(b.issue);
    commentsByIssue.set(s.n, b.comments);
    records.set(String(s.n), b.record);
    if (b.pr) prByIssue.set(s.n, b.pr);
  }
  return { issues, commentsByIssue, records, prByIssue };
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

// ── diff 모양: 두 번째 위험 출처(r2 항목 1) ─────────────────────────────────────────────────

test("diffShapeOf — tier 해석기의 매처에 **위임한다**(글롭 목록을 베끼지 않는다)", () => {
  expect(diffShapeOf(["README.md", "docs/a.md"], {})).toBe("docs");
  expect(diffShapeOf(["README.md", "src/app.js"], {})).toBe("code");
  // "문서처럼 생겼지만 문서가 아닌 것"도 `tierFloor`가 이미 안다 — 여기서 다시 정의하지 않는다.
  expect(diffShapeOf(["docs/factory/CHARTER.md", ".claude/agents/reviewer-x.md"], {})).toBe("code");
  expect(diffShapeOf(["factory/test/x.test.js"], {})).toBe("code");
  expect(diffShapeOf(["CLAUDE.md"], {})).toBe("code");
  // 경로를 하나도 못 읽으면 **미상**이다 — 빈 목록을 docs로 읽으면 감사 H3의 구멍이 다시 열린다.
  expect(diffShapeOf([], {})).toBeNull();
  expect(diffShapeOf(null, {})).toBeNull();
});

test("docs **모양**의 diff를 전체 패널에 태우고 비용이 임계(1.25×)를 넘으면 waste 발견 — 라벨과 무관하게", async () => {
  const PANEL = ["architecture", "correctness", "qa", "spec-conformance"];
  const specs = [
    { n: 1, day: 1, tier: "standard", costUsd: 20, rounds: [PANEL.map(approve)], files: CODE_FILES },
    { n: 2, day: 2, tier: "standard", costUsd: 20, rounds: [PANEL.map(approve)], files: CODE_FILES },
    { n: 3, day: 3, tier: "load-bearing", costUsd: 24, rounds: [PANEL.map(approve)], files: CODE_FILES },
    { n: 4, day: 4, tier: "docs", costUsd: 3, rounds: [[approve("correctness")]], files: DOCS_FILES },
    // KTB #18이 **그랬어야 했던** 모양: docs 경로뿐인데 `standard`로 채점돼 전체 패널을 샀다.
    { n: 5, day: 5, tier: "standard", costUsd: 80, rounds: [PANEL.map(approve)], files: DOCS_FILES },
  ];
  const gh = fakeGh();
  const r = await health({ gh, ...windowOf(specs) });

  const waste = bySignal(r, "cost-vs-risk");
  expect(waste).toHaveLength(1);
  expect(waste[0]).toMatchObject({ signal: "cost-vs-risk", kind: "behavioural", paired: true, issue: 5, stage: "review", causal_path: ".factory/lib/review-roster.js" });
  // #1~#3은 파일이 코드라 판정 위험이 전부 `standard`다(라벨이 load-bearing이어도 diff가 이긴다 — r3).
  expect(waste[0].extra.cost).toEqual({ usd: 80, baseline: 20, threshold: 25, baseline_tiers: ["standard"] });
  expect(r.signals.cost_vs_risk.find((x) => x.issue === 5)).toMatchObject({ diff_shape: "docs", risk_tier: "docs", tier: "standard", tier_source: "label", panel: 4, cost: 80, baseline: 20, threshold: 25, prs: [1005] });
  // reason은 **원인만** 말한다(r3 should_fix 1) — 숫자와 번호는 chain에 있다.
  expect(waste[0].reason).toContain("DOCS-SHAPED");
  expect(waste[0].reason).not.toMatch(/\$\d|#\d/);
  expect(waste[0].extra.chain[0]).toContain("#5 (PR #1005)");
  expect(waste[0].extra.chain[0]).toContain("label tier standard");
  // 값싼 docs 이슈(#4)는 같은 모양인데도 발견이 아니다 — 패널도 작고 임계도 넘지 않는다.
  expect(waste.map((f) => f.issue)).not.toContain(4);
});

test("docs 모양 + docs가 아닌 등급 → `[ktb]` tier 오채점 발견(비용도 패널도 묻지 않는다)", async () => {
  const specs = [
    { n: 1, day: 1, tier: "standard", costUsd: 5, rounds: [[approve("a")]], files: CODE_FILES },
    { n: 2, day: 2, tier: "standard", costUsd: 5, rounds: [[approve("a")]], files: CODE_FILES },
    { n: 3, day: 3, tier: "docs", costUsd: 5, rounds: [[approve("a")]], files: DOCS_FILES },   // 제대로 채점됐다
    { n: 4, day: 4, tier: "load-bearing", costUsd: 5, rounds: [[approve("a")]], files: DOCS_FILES },
    { n: 5, day: 5, tier: "standard", costUsd: 5, rounds: [[approve("a")]], files: DOCS_FILES },
  ];
  const gh = fakeGh();
  const r = await health({ gh, ...windowOf(specs) });

  const mis = bySignal(r, "tier-misgrade").sort((a, b) => a.issue - b.issue);
  expect(mis.map((f) => f.issue)).toEqual([4, 5]);        // #3은 docs 모양에 docs 등급이라 어긋난 것이 없다
  expect(mis[1]).toMatchObject({
    signal: "tier-misgrade", kind: "behavioural", paired: true, issue: 5,
    stage: "triage", repo: "o/r", causal_path: TIER_RESOLVER_PATH,
  });
  expect(TIER_RESOLVER_PATH).toBe(".factory/lib/context.js");
  // reason은 원인만 — 등급 값도 파일 수도 여기 없다(같은 결함의 모든 관측이 한 이슈에 모여야 한다).
  expect(mis[1].reason).toContain("grades docs-shaped diffs above `docs`");
  expect(mis[1].reason).not.toMatch(/\$\d|#\d/);
  expect(mis[1].extra.chain[0]).toContain("#5 (PR #1005): 3 file(s), all docs; graded `standard`");
  expect(mis[0].extra.chain[0]).toContain("graded `load-bearing`");
  // 두 오채점의 원인은 같다 — 지문도 같고, 그래서 상류 이슈 하나에 모인다.
  expect(mis[0].reason).toBe(mis[1].reason);
  // 그리고 T3의 팔을 타고 `ktb`로 갔다 — 이것은 KTB가 배포한 기본값의 결함이다.
  expect(r.classified.filter((c) => c.payload?.kind === "behavioural").every((c) => c.tags.includes("ktb"))).toBe(true);
  // 발견은 둘이지만 원인이 하나이므로 지문도 하나다 → **상류 이슈는 하나**다(r3 should_fix 1).
  expect(mis[0].fingerprint).toBe(mis[1].fingerprint);
  expect(gh.calls.upstream).toHaveLength(1);
});

test("모양을 읽지 못하면(PR 없음/API 실패) 모양 기반 발견은 **하나도** 나지 않고 저하로 보고된다", async () => {
  const PANEL = ["architecture", "correctness", "qa", "spec-conformance"];
  const specs = [
    { n: 1, day: 1, tier: "standard", costUsd: 20, rounds: [PANEL.map(approve)], files: CODE_FILES },
    { n: 2, day: 2, tier: "standard", costUsd: 20, rounds: [PANEL.map(approve)], files: CODE_FILES },
    { n: 3, day: 3, tier: "load-bearing", costUsd: 24, rounds: [PANEL.map(approve)], files: CODE_FILES },
    { n: 4, day: 4, tier: "docs", costUsd: 5, rounds: [[approve("a")]], files: CODE_FILES },
    // 라벨은 docs이고 비용도 임계를 넘지만 **모양을 모른다** — 라벨로 추측하지 않는다.
    { n: 5, day: 5, tier: "docs", costUsd: 80, rounds: [PANEL.map(approve)], files: null },
  ];
  const gh = fakeGh();
  const r = await health({ gh, ...windowOf(specs) });
  expect(bySignal(r, "cost-vs-risk")).toEqual([]);
  expect(bySignal(r, "tier-misgrade")).toEqual([]);
  expect(r.signals.shape_unknown).toEqual([5]);
  expect(r.signals.cost_vs_risk.find((x) => x.issue === 5)).toMatchObject({ diff_shape: null, pr: null });
  expect(r.report).toContain("모양을 읽지 못한 이슈: #5");
  expect(gh.calls.upstream).toEqual([]);
});

// ── r3 — 지문은 원인에만 걸린다 ──────────────────────────────────────────────────────────────

test("같은 원인의 두 창은 **같은 지문**을 낸다 — 상류 이슈는 하나, 증거만 덧붙는다", async () => {
  const win = (costUsd, escapedRounds) => windowOf([1, 2, 3, 4, 5].map((n) => ({
    n, day: n, tier: "standard", costUsd,
    rounds: escapedRounds
      ? [[approve("correctness"), approve("security")], [approve("correctness"), reject("security")]]
      : [[approve("correctness"), approve("security")]],
    files: CODE_FILES,
  })));
  // 1주차와 2주차: 같은 원인(correctness가 도장만 찍는다)인데 **집계 숫자는 다르다**.
  const gh = fakeGh();
  const w1 = await health({ gh, ...win(10, true) });
  const first = bySignal(w1, "rubber-stamp");
  expect(first).toHaveLength(1);

  // 2주차 — 라운드가 하나 더 붙어 approves/verdicts·escaped가 전부 달라진다.
  const gh2 = fakeGh();
  const spec2 = [1, 2, 3, 4, 5].map((n) => ({
    n, day: n, tier: "standard", costUsd: 37,
    rounds: [[approve("correctness"), approve("security")], [approve("correctness"), reject("security")], [approve("correctness"), reject("security")]],
    files: CODE_FILES,
  }));
  const w2 = await health({ gh: gh2, ...windowOf(spec2) });
  const second = bySignal(w2, "rubber-stamp");
  expect(second).toHaveLength(1);

  // 집계는 달라졌는데…
  expect(w1.signals.roles.correctness.escaped_defects).not.toBe(w2.signals.roles.correctness.escaped_defects);
  // …지문은 같다. 그래서 상류는 이슈 하나에 증거만 쌓는다.
  expect(first[0].reason).toBe(second[0].reason);
  expect(first[0].fingerprint).toBe(second[0].fingerprint);
  // 흔들리는 숫자는 전부 chain에 있고(지문 재료가 아니다), 증거 코멘트에 실린다.
  expect(first[0].extra.chain.join(" ")).toContain("approve_rate");
  expect(second[0].extra.chain.join(" ")).toContain("approve_rate");
  expect(first[0].extra.chain).not.toEqual(second[0].extra.chain);
  expect(gh2.calls.upstream[0].body).toContain("approve_rate");
});

test("cost-vs-risk와 tier-misgrade의 reason에도 흔들리는 값이 없다", async () => {
  const mk = (costUsd) => [
    { n: 1, day: 1, tier: "standard", costUsd: 20, rounds: [PANEL4.map(approve)], files: CODE_FILES },
    { n: 2, day: 2, tier: "standard", costUsd: 20, rounds: [PANEL4.map(approve)], files: CODE_FILES },
    { n: 3, day: 3, tier: "load-bearing", costUsd: 24, rounds: [PANEL4.map(approve)], files: CODE_FILES },
    { n: 4, day: 4, tier: "docs", costUsd: 3, rounds: [[approve("correctness")]], files: DOCS_FILES },
    { n: 5, day: 5, tier: "standard", costUsd, rounds: [PANEL4.map(approve)], files: DOCS_FILES },
  ];
  const a = await health({ gh: fakeGh(), ...windowOf(mk(80)) });
  const b = await health({ gh: fakeGh(), ...windowOf(mk(140)) });
  for (const sig of ["cost-vs-risk", "tier-misgrade"]) {
    const x = bySignal(a, sig)[0], y = bySignal(b, sig)[0];
    expect(x, sig).toBeTruthy();
    expect(x.reason, sig).toBe(y.reason);
    expect(x.fingerprint, sig).toBe(y.fingerprint);
    // 숫자·이슈 번호는 reason에 한 글자도 없다.
    expect(x.reason, sig).not.toMatch(/\$\d|#\d|\d+\/\d+/);
  }
  expect(bySignal(a, "cost-vs-risk")[0].extra.chain[0]).toContain("$80");
  expect(bySignal(b, "cost-vs-risk")[0].extra.chain[0]).toContain("$140");
});

// ── r3 — 머지된 PR이 여럿일 때 ───────────────────────────────────────────────────────────────

test("이슈의 머지된 PR이 둘이면 모양은 **합집합**으로 판정하고 `prs`에 전부 적는다", async () => {
  const specs = [
    { n: 1, day: 1, tier: "standard", costUsd: 20, rounds: [PANEL4.map(approve)], files: CODE_FILES },
    { n: 2, day: 2, tier: "standard", costUsd: 20, rounds: [PANEL4.map(approve)], files: CODE_FILES },
    { n: 3, day: 3, tier: "load-bearing", costUsd: 24, rounds: [PANEL4.map(approve)], files: CODE_FILES },
    { n: 4, day: 4, tier: "docs", costUsd: 3, rounds: [[approve("correctness")]], files: DOCS_FILES },
    // 재작업: 첫 PR은 docs만, 두 번째가 테스트를 들고 왔다 → 합치면 `code`다.
    { n: 5, day: 5, tier: "standard", costUsd: 80, rounds: [PANEL4.map(approve)],
      files: [...DOCS_FILES, "factory/test/x.test.js"], prs: [77, 42] },
  ];
  const r = await health({ gh: fakeGh(), ...windowOf(specs) });
  const row = r.signals.cost_vs_risk.find((x) => x.issue === 5);
  expect(row).toMatchObject({ diff_shape: "code", diff_risk: "standard", prs: [77, 42] });
  // 합집합이 `code`이므로 모양 기반 규칙 둘 다 침묵한다 — 첫 PR만 봤다면 낭비로 잘못 열렸을 것이다.
  expect(bySignal(r, "cost-vs-risk")).toEqual([]);
  expect(bySignal(r, "tier-misgrade")).toEqual([]);
});

test("mergedPrsForBranch는 **머지 시각** 내림차순이다(생성 순이 아니다)", async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(args.join(" "));
    return { code: 0, stdout: JSON.stringify([
      // `gh pr list`가 주는 순서(생성 desc) — 먼저 만든 #7이 **나중에** 머지됐다.
      { number: 9, mergedAt: "2026-09-01T00:00:00Z" },
      { number: 7, mergedAt: "2026-09-05T00:00:00Z" },
    ]), stderr: "" };
  };
  const { makeGh } = await import("../lib/gh.js");
  const gh = makeGh({ run, repo: "o/r" });
  expect(await gh.mergedPrsForBranch("claude/fq-3")).toEqual([
    { number: 7, mergedAt: "2026-09-05T00:00:00Z" },
    { number: 9, mergedAt: "2026-09-01T00:00:00Z" },
  ]);
  expect(await gh.mergedPrForBranch("claude/fq-3")).toBe(7);
  expect(calls[0]).toContain("mergedAt");
});

// ── r3 — 대칭 위험 + 절대 초과분 ─────────────────────────────────────────────────────────────

test("판정 위험은 **대칭**이다 — 코드 모양에 docs 라벨이어도 기준선이 무너지지 않는다", async () => {
  const specs = [
    // 반대 방향 오채점: 코드를 건드렸는데 라벨은 docs다. 위험은 diff가 정한 `standard`여야 한다.
    { n: 1, day: 1, tier: "docs", costUsd: 20, rounds: [PANEL4.map(approve)], files: CODE_FILES },
    { n: 2, day: 2, tier: "docs", costUsd: 20, rounds: [PANEL4.map(approve)], files: CODE_FILES },
    { n: 3, day: 3, tier: "docs", costUsd: 24, rounds: [PANEL4.map(approve)], files: CODE_FILES },
    { n: 4, day: 4, tier: "docs", costUsd: 3, rounds: [[approve("correctness")]], files: DOCS_FILES },
    { n: 5, day: 5, tier: "docs", costUsd: 80, rounds: [PANEL4.map(approve)], files: DOCS_FILES },
  ];
  const r = await health({ gh: fakeGh(), ...windowOf(specs) });
  // 라벨은 전부 docs지만 판정 위험은 diff가 정한다.
  expect(r.signals.cost_vs_risk.find((x) => x.issue === 1)).toMatchObject({ tier: "docs", diff_risk: "standard", risk_tier: "standard" });
  expect(r.signals.cost_vs_risk.find((x) => x.issue === 5)).toMatchObject({ risk_tier: "docs" });
  // 그래서 기준선이 선다(standard 3건) — 라벨만 봤다면 "docs보다 위험한 것"이 0건이라 null이었다.
  const row = r.signals.cost_vs_risk.find((x) => x.issue === 5);
  expect(row.baseline).toBe(20);
  expect(row.baseline_tiers).toEqual(["standard"]);
  expect(bySignal(r, "cost-vs-risk").map((f) => f.issue)).toEqual([5]);
});

test("리뷰어의 $2/$3 시나리오 — 배수는 넘지만 차액이 $5 미만이면 낭비가 아니다", async () => {
  expect(WASTE_MIN_EXCESS_USD).toBe(5);
  const specs = [
    { n: 1, day: 1, tier: "standard", costUsd: 2, rounds: [PANEL4.map(approve)], files: CODE_FILES },
    { n: 2, day: 2, tier: "standard", costUsd: 2, rounds: [PANEL4.map(approve)], files: CODE_FILES },
    { n: 3, day: 3, tier: "load-bearing", costUsd: 2, rounds: [PANEL4.map(approve)], files: CODE_FILES },
    { n: 4, day: 4, tier: "docs", costUsd: 1, rounds: [[approve("correctness")]], files: DOCS_FILES },
    { n: 5, day: 5, tier: "docs", costUsd: 3, rounds: [PANEL4.map(approve)], files: DOCS_FILES },
  ];
  const r = await health({ gh: fakeGh(), ...windowOf(specs) });
  const row = r.signals.cost_vs_risk.find((x) => x.issue === 5);
  expect(row).toMatchObject({ baseline: 2, threshold: 2.5, cost: 3 });   // 3 > 2.5 — 배수는 넘었다
  expect(bySignal(r, "cost-vs-risk")).toEqual([]);                       // 그러나 차액 $1은 잡음이다
  // 같은 판에서 차액만 $5 이상이면 발견이 난다.
  const loud = specs.map((s) => (s.n === 5 ? { ...s, costUsd: 7 } : s));
  expect(bySignal(await health({ gh: fakeGh(), ...windowOf(loud) }), "cost-vs-risk").map((f) => f.issue)).toEqual([5]);
});

test("리뷰어 probe C — standard $6 한 건 + docs $6.50이면 발견이 없다(표본 1건, 1.25× 미만)", async () => {
  const specs = [
    { n: 1, day: 1, tier: "standard", costUsd: 6, rounds: [[approve("a"), approve("b")]], files: CODE_FILES },
    { n: 2, day: 2, tier: "docs", costUsd: 6.5, rounds: [[approve("a"), approve("b")]], files: DOCS_FILES },
    { n: 3, day: 3, tier: "docs", costUsd: 1, rounds: [[approve("a"), approve("b")]], files: DOCS_FILES },
    { n: 4, day: 4, tier: "docs", costUsd: 1, rounds: [[approve("a"), approve("b")]], files: DOCS_FILES },
    { n: 5, day: 5, tier: "docs", costUsd: 1, rounds: [[approve("a"), approve("b")]], files: DOCS_FILES },
  ];
  const r = await health({ ...windowOf(specs) });
  expect(bySignal(r, "cost-vs-risk")).toEqual([]);
  expect(bySignal(r, "tier-misgrade")).toEqual([]);      // 전부 docs 모양에 docs 등급이다
  const row = r.signals.cost_vs_risk.find((x) => x.issue === 2);
  expect(row).toMatchObject({ diff_shape: "docs", baseline: null, baseline_n: 1, threshold: null });
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
  const P4 = [approve("a"), approve("b"), approve("c"), approve("d")];
  const b1 = issueOf({ n: 11, day: 1, tier: "docs", costUsd: 90, rounds: [P4], files: DOCS_FILES });
  const b2 = issueOf({ n: 12, day: 2, tier: "standard", costUsd: 20, rounds: [P4], files: CODE_FILES });
  const b3 = issueOf({ n: 13, day: 3, tier: "load-bearing", costUsd: 20, rounds: [P4], files: CODE_FILES });
  const b4 = issueOf({ n: 14, day: 4, tier: "standard", costUsd: 20, rounds: [P4], files: CODE_FILES });
  const b5 = issueOf({ n: 15, day: 5, tier: "standard", costUsd: 20, rounds: [P4], files: CODE_FILES });
  const built = [b1, b2, b3, b4, b5];

  const listed = [];
  const gh = {
    ...fakeGh(),
    async issueList(q) { listed.push(q); if (q.labels?.includes("factory:health")) return []; return built.map((b) => b.issue); },
    async comments(n) { return built.find((b) => b.issue.number === n)?.comments ?? []; },
    async comment() {}, async createIssue() { return 900; }, async reopenIssue() {},
    async upstreamIssue({ render }) { render(); return { issue: 501, created: true }; },
    // diff 모양의 출처 — 브랜치 이름이 곧 이슈 번호다(`claude/fq-<n>`).
    async mergedPrsForBranch(branch) {
      const n = Number(/claude\/fq-(\d+)/.exec(branch)?.[1]);
      const p = built.find((b) => b.issue.number === n)?.pr;
      return p ? p.prs.map((num) => ({ number: num, mergedAt: dayOf(20) })) : [];
    },
    async prFiles(pr) { return built.find((b) => b.pr?.prs.includes(pr))?.pr.files ?? []; },
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

/** 픽스처 한 장으로 건강 잡을 돌린다 — 이슈·코멘트·기록·PR 파일 목록 전부 실제 원문이다. */
async function runReal(f) {
  const b = { number: f.issue.number, title: f.issue.title, state: f.issue.state, closedAt: f.issue.closedAt, updatedAt: f.issue.updatedAt, labels: f.issue.labels };
  const gh = fakeGh();
  const r = await health({
    gh, issues: [b],
    commentsByIssue: new Map([[b.number, f.comments]]),
    records: new Map([[String(b.number), f.record]]),
    prByIssue: f.pr ? new Map([[b.number, { pr: f.pr.number, files: f.pr.files }]]) : new Map(),
  });
  return { ...r, gh };
}

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
  const r = await runReal(f);
  expect(r.below_n).toBe(true);
  expect(r.findings).toEqual([]);
  expect(r.gh.calls.upstream).toEqual([]);
  expect(r.signals.rounds_per_issue).toEqual([{ issue: 3, review: 4 }]);
  // tier 앵커는 러너의 라벨이다. 그리고 PR #5의 경로에 Dart 테스트가 있어 모양은 `code`다.
  expect(f.pr).toMatchObject({ number: 5 });
  expect(f.pr.files).toEqual(["README.md", "client/test/test_3_readme_test.dart"]);
  expect(r.signals.per_issue[0]).toMatchObject({ tier: "standard", tier_source: "label", diff_shape: "code", pr: 5 });
  // 그래서 모양 기반 규칙 **둘 다** 침묵한다.
  expect(bySignal(r, "cost-vs-risk")).toEqual([]);
  expect(bySignal(r, "tier-misgrade")).toEqual([]);
  // 거절한 역할은 승인률이 1이 아니므로, 표본이 채워져도 rubber-stamp가 되지 않는다.
  for (const role of ["correctness", "architecture", "spec-conformance"]) expect(r.signals.roles[role].ever_rejects).toBe(true);
});

test("회귀 — KTB #18 (실제 기록+실제 PR): diff는 `code` 모양이다 → 모양 기반 발견은 **둘 다** 침묵한다", async () => {
  const f = fixture("ktb-18");
  expect(f._source).toContain("know_thy_build#18");

  const s = roleSignalsFor({ record: f.record, comments: f.comments });
  expect(s.max_round).toBe(3);
  expect(s.panel).toBe(4);
  expect(s.decisions.map((d) => d.decision)).toEqual(["rework", "rework", "rework"]);
  // qa가 세 라운드 내내 거절했고, architecture/spec-conformance는 세 번 다 승인했다.
  expect(s.roles.qa).toMatchObject({ verdicts: 3, approves: 0, rejects: 3, escaped: 0 });
  expect(s.roles.architecture).toMatchObject({ verdicts: 3, approves: 3, rejects: 0, escaped: 2 });
  expect(s.roles["spec-conformance"]).toMatchObject({ verdicts: 3, approves: 3, rejects: 0, escaped: 2 });

  /**
   * **플랜의 전제가 틀렸다.** 플랜은 #18을 "표준 4역할 패널에 올라간 docs 이슈"라고 적었지만, 머지된
   * PR #19가 실제로 건드린 것은 `README.md` · `docs/factory/DECISIONS.md` **그리고**
   * `factory/test/readme-commands.test.js`다. 테스트 파일 하나가 diff를 docs 모양이 아니게 만들고
   * (`factory/**`는 `NEVER_DOCS_GLOBS`에 있다), 그래서 러너의 `factory:tier-standard` 채점은
   * **방어 가능하다**. 초록을 만들려고 테스트 파일을 특례로 빼지 않는다 — 그러면 "리뷰어 프롬프트만
   * 고친 PR"도 docs가 되고, 그것이 바로 감사 M12가 막은 구멍이다.
   */
  expect(f.pr).toMatchObject({ number: 19 });
  expect(f.pr.files).toEqual(["README.md", "docs/factory/DECISIONS.md", "factory/test/readme-commands.test.js"]);
  expect(diffShapeOf(f.pr.files, {})).toBe("code");

  const r = await runReal(f);
  const row = r.signals.cost_vs_risk.find((x) => x.issue === 18);
  // 비용은 진짜로 읽혔다(플랜이 말한 "~$80").
  expect(row.cost).toBeGreaterThan(80);
  expect(row.cost).toBeLessThan(90);
  expect(row).toMatchObject({ tier: "standard", tier_source: "label", diff_shape: "code", pr: 19 });
  // 모양이 `code`이므로 낭비도, 오채점도 아니다. 두 규칙 모두 조용하다.
  expect(bySignal(r, "cost-vs-risk")).toEqual([]);
  expect(bySignal(r, "tier-misgrade")).toEqual([]);
  expect(r.gh.calls.upstream).toEqual([]);
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

// ── T7: 공유 신원 배너 — 주간 보고서의 **맨 위**에 선다 ───────────────────────────────────────
//
// 주인이 실제로 읽는 화면은 이 보고서 하나다. 팩토리가 사람 계정으로 돌면 아래 어떤 표도
// "사람이 factory-defect로 판정했는가"를 담지 못한다 — 그 통로가 통째로 닫혀 있기 때문이다.
// 그 사실을 표 밑 각주로 달면 아무도 읽지 않으므로, 배너는 첫 표보다 앞이어야 한다.

const BANNER = /factory identity is a personal account \(`?LeeHyeonKyu`?\)/;
const identityWindow = () => windowOf([1, 2, 3, 4, 5].map((n) => ({
  n, day: n, tier: "docs", files: DOCS_FILES, rounds: [[approve("correctness")]],
})));

test("T7 — `identity.personal === true`이면 보고서 맨 위에 배너가 선다", async () => {
  const r = await health({ ...identityWindow(), identity: { personal: true, login: "LeeHyeonKyu" }, factoryLogins: ["LeeHyeonKyu"] });
  expect(r.report).toMatch(BANNER);
  expect(r.report).toMatch(/register a machine user or GitHub App as the factory identity/);
  // 맨 위다 — 첫 표(역할)보다 앞선다.
  expect(r.report.indexOf("factory identity is a personal account")).toBeLessThan(r.report.indexOf("### 역할"));
  // 마커는 여전히 첫 줄이다(멱등 dedupe가 그 마커로 이 코멘트를 찾는다).
  expect(r.report.indexOf(HEALTH_MARKER)).toBe(0);
});

test("T7 — `personal === false`/`null`이면 배너는 없다(모르는 것은 경보가 아니다)", async () => {
  const w = identityWindow();
  expect((await health({ ...w, identity: { personal: false, login: "ktb-bot" }, factoryLogins: ["ktb-bot"] })).report).not.toMatch(BANNER);
  expect((await health({ ...w, identity: { personal: null, login: "ktb-bot" }, factoryLogins: ["ktb-bot"] })).report).not.toMatch(BANNER);
});

test("T7 — 기각된 `human-decision`은 이슈 번호와 작성자까지 보고서에 적힌다", async () => {
  const w = identityWindow();
  // 소유자가 `:unstick`으로 적은 결정 — 진짜 생산자(`humanDecisionComment`)가 만든다.
  w.commentsByIssue.set(3, [
    ...w.commentsByIssue.get(3),
    humanDecisionComment({ issue: 3, at: dayOf(3), author: "LeeHyeonKyu", cause: "factory-defect", ktbFix: "1.4.0", reason: "self-gate blocked on a check the review stage produces" }),
  ]);
  const r = await health({ ...w, identity: { personal: true, login: "LeeHyeonKyu" }, factoryLogins: ["LeeHyeonKyu"] });
  expect(r.unverifiable).toHaveLength(1);
  expect(r.unverifiable[0]).toMatchObject({ issue: 3, author: "LeeHyeonKyu", status: "unverifiable" });
  expect(r.report).toMatch(/기각된 human-decision 1건/);
  expect(r.report).toMatch(/#3 — @LeeHyeonKyu/);

  // 같은 판에서 팩토리 로그인이 다른 계정이면 기각도 배너도 없다(대조군).
  const clean = await health({ ...w, identity: { personal: false, login: "ktb-bot" }, factoryLogins: ["ktb-bot"] });
  expect(clean.unverifiable).toEqual([]);
  expect(clean.report).not.toMatch(/기각된 human-decision/);
});

/**
 * 리뷰 should_fix 3 — 창의 표는 Map으로도 **평범한 객체로도** 온다. 객체를 `Object.entries`로 접으면
 * 키가 문자열이 되는데 조회는 숫자로 하므로, 정규화가 없으면 객체로 준 창은 모든 조회가 조용히 빈
 * 값이 된다 — 공유 신원 판정도, 그 이전에 신호 자체도.
 */
test("T7 — 창을 평범한 객체로 줘도 신호·배너·기각 목록이 똑같이 나온다", async () => {
  const w = identityWindow();
  w.commentsByIssue.set(3, [
    ...w.commentsByIssue.get(3),
    humanDecisionComment({ issue: 3, at: dayOf(3), author: "LeeHyeonKyu", cause: "factory-defect", reason: "self-gate blocked wrongly" }),
  ]);
  const plain = {
    issues: w.issues,
    commentsByIssue: Object.fromEntries([...w.commentsByIssue]),
    records: Object.fromEntries([...w.records]),
    prByIssue: Object.fromEntries([...w.prByIssue]),
  };
  const asMap = await health({ ...w, identity: { personal: true, login: "LeeHyeonKyu" }, factoryLogins: ["LeeHyeonKyu"] });
  const asObj = await health({ ...plain, identity: { personal: true, login: "LeeHyeonKyu" }, factoryLogins: ["LeeHyeonKyu"] });
  // 창 자체가 비지 않았다(정규화가 없으면 여기서 0개가 된다).
  expect(asObj.signals.window).toEqual(asMap.signals.window);
  expect(asObj.signals.window.length).toBe(DEFAULT_N);
  expect(asObj.unverifiable).toEqual(asMap.unverifiable);
  expect(asObj.unverifiable).toHaveLength(1);
  expect(asObj.report).toMatch(BANNER);
  expect(asObj.report).toMatch(/#3 — @LeeHyeonKyu/);
});

/**
 * 리뷰 should_fix 4 — 팩토리 계정 이름을 **못 얻은** 회차도 조용하면 안 된다. 그때 `attributionFor`는
 * (b)를 통째로 거부하므로 "기각 0건"이 되는데, 그것은 "문제 없음"과 화면에서 구별되지 않는다.
 */
test("T7 — 팩토리 로그인을 못 얻으면 그 사실이 보고서와 stderr에 남는다", async () => {
  const errs = [];
  // 작성자가 없는 옛 코멘트 스냅샷 + `viewerLogin`이 없는 gh = 팩토리 계정 이름을 얻을 길이 없다.
  const w = identityWindow();
  for (const [n, cs] of [...w.commentsByIssue]) w.commentsByIssue.set(n, cs.map((c) => ({ ...c, author: null })));
  const r = await health({ ...w, gh: fakeGh(), log: (m) => errs.push(m) });
  expect(r.login_note).toMatch(/factory logins unresolved/);
  expect(r.report).toMatch(/factory logins unresolved/);
  expect(r.report).toMatch(/human-decision attribution cannot be evaluated/);
  expect(errs.join("\n")).toMatch(/factory logins unresolved/);
  // 그리고 그 배너도 표보다 앞이다.
  expect(r.report.indexOf("factory logins unresolved")).toBeLessThan(r.report.indexOf("### 역할"));

  // 로그인을 얻은 회차에는 그 줄이 없다(없는 경보를 만들지 않는다).
  const ok = await health({ ...identityWindow(), factoryLogins: ["ktb-bot"], identity: { personal: false, login: "ktb-bot" } });
  expect(ok.login_note).toBeNull();
  expect(ok.report).not.toMatch(/factory logins unresolved/);
});

/**
 * 리뷰 should_fix 5 — `identity`/`factoryLogins`를 **주입하지 않는** 경로(프로덕션의 유일한 경로)가
 * 실제로 `resolveFactoryLogins`를 타고 배너까지 도달하는지. 주입된 값으로만 초록이면 배선이 빠진
 * 날에도 테스트는 초록이다.
 */
test("T7 — 주입 없이 `runHealth`가 스스로 공유 신원을 알아내고 배너를 세운다", async () => {
  const w = identityWindow();
  // 하트비트(러너만 쓰는 산출물)를 **사람 계정**이 썼다 = 공유 신원. 그 사실은 코멘트의 `authorType`에 있다.
  for (const [n, cs] of [...w.commentsByIssue]) {
    w.commentsByIssue.set(n, cs.map((c) => ({ ...c, author: "LeeHyeonKyu", authorType: "User" })));
  }
  w.commentsByIssue.set(3, [
    ...w.commentsByIssue.get(3),
    humanDecisionComment({ issue: 3, at: dayOf(3), author: "LeeHyeonKyu", cause: "factory-defect", reason: "self-gate blocked wrongly" }),
  ]);
  const r = await health({ ...w, gh: fakeGh(), log: () => {} });
  expect(r.identity).toEqual({ personal: true, login: "LeeHyeonKyu" });
  expect(r.login_note).toBeNull();
  expect(r.report).toMatch(BANNER);
  expect(r.unverifiable).toHaveLength(1);
  expect(r.unverifiable[0]).toMatchObject({ issue: 3, author: "LeeHyeonKyu" });
});
