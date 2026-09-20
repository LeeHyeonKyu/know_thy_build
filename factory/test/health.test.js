import { test, expect } from "vitest";
import { runHealth, DEFAULT_N, costBaselineFor, RISK_ORDER } from "../bin/health.js";
import { reviewHandoffComment, planHandoffComment, recordOf, usageRecordLine } from "./helpers/feedback-fixtures.js";

/**
 * ── Task 4 — 주기 건강 잡 ─────────────────────────────────────────────────────────────────────
 *
 * 이 파일이 지키는 단 하나의 규약은 **짝 없는 신호에서는 아무 발견도 나오지 않는다**는 것이다
 * (Global Constraint / spec §5). 그래서 테스트마다 쌍이 **깨진** 판을 함께 세워 둔다: 100% 승인인데
 * escaped 0, 토론이 계획을 바꾼 창, N에 못 미치는 창. 셋 다 침묵해야 한다.
 *
 * 픽스처는 전부 진짜 생산자가 만든다(T3 교훈): 핸드오프는 `renderHandoff`(→ `reviewHandoffComment`·
 * `planHandoffComment`), run 기록은 `appendRunRecord`(→ `recordOf`), `usage:` 줄은 `usageLine`
 * (→ `usageRecordLine`). 손으로 빚은 모양은 라우팅이 뒤집혀 있어도 초록으로 남는다.
 */

const approve = (role) => ({ role, verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] });
const reject = (role, ids = ["mf1"]) =>
  ({ role, verdict: "reject", confidence: "high", must_fix: ids.map((id) => ({ id, where: "src/a.js:1", claim: `${id} broken`, evidence: "e" })), should_fix: [], verified: [] });

const PANEL = ["correctness", "spec-conformance", "security", "simplicity"];
const dayOf = (n) => `2026-09-${String(n).padStart(2, "0")}T00:00:00Z`;

/** 머지된 이슈 한 장(라벨이 머지 사실이다 — `isMerged`가 그것으로 판정한다). */
const mergedIssue = (number, day, title = `issue ${number}`) =>
  ({ number, title, labels: [{ name: "factory:merged" }], state: "closed", closedAt: dayOf(day), updatedAt: dayOf(day) });

/** run 기록 한 장 — review 스테이지의 비용이 `usageLine`이 쓴 진짜 `usage:` 줄로 들어간다. */
const recordFor = (issue, { costUsd, day }) =>
  recordOf(issue, `issue ${issue}`, [
    { stage: "review", at: dayOf(day), lines: ["verify: ok", usageRecordLine({ costUsd })] },
  ]);

/**
 * 창 하나를 세운다. `spec[]`의 각 항목은 이슈 하나다:
 *   `{ n, day, tier, panel, costUsd, rounds }` — `rounds`는 라운드별 verdict 배열.
 */
function windowOf(spec) {
  const issues = [];
  const commentsByIssue = new Map();
  const records = new Map();
  for (const s of spec) {
    issues.push(mergedIssue(s.n, s.day));
    const comments = [];
    if (s.plan) comments.push(planHandoffComment(s.n, { at: dayOf(s.day), ...s.plan }));
    (s.rounds || []).forEach((verdicts, i) => {
      comments.push(reviewHandoffComment(s.n, { round: i + 1, at: dayOf(s.day + i), verdicts, tier: s.tier }));
    });
    commentsByIssue.set(s.n, comments);
    records.set(String(s.n), recordFor(s.n, { costUsd: s.costUsd ?? 5, day: s.day }));
  }
  return { issues, commentsByIssue, records };
}

/** 설치 매니페스트 — 행동 발견의 인과 경로는 전부 배포물(owner: factory)이다. */
const manifest = {
  isInstalled: new Set([
    ".factory/lib/review-roster.js",
    ".claude/agents/reviewer-correctness.md",
    ".claude/agents/reviewer-spec-conformance.md",
    ".claude/agents/reviewer-security.md",
    ".claude/agents/reviewer-simplicity.md",
    ".claude/agents/plan-skeptic.md",
  ]),
  ownerOf: () => "factory",
  ktbVersion: "1.4.0",
};

const roleFile = new Map(PANEL.map((r) => [r, `.claude/agents/reviewer-${r}.md`]));

/** gh 가짜 — 부른 것을 전부 적어 둔다(라우팅이 **일어나지 않았음**도 판정 대상이다). */
function fakeGh({ healthIssue = null } = {}) {
  const calls = { comments: [], created: [], upstream: [] };
  return {
    calls,
    async issueList({ labels = [] } = {}) {
      if (labels.includes("factory:health") && healthIssue) return [{ number: healthIssue, title: "factory-health", labels: [{ name: "factory:health" }] }];
      return [];
    },
    async comments(n) { return calls.comments.filter((c) => c.issue === n).map((c, i) => ({ id: i, body: c.body, createdAt: dayOf(28) })); },
    async comment(issue, body) { calls.comments.push({ issue, body }); },
    async createIssue({ title, body, labels }) { calls.created.push({ title, body, labels }); return 900; },
    async upstreamIssue({ repo, fingerprint, render }) {
      // `render()`는 `{title, body, labels}`를 돌려준다(`renderUpstreamIssue`) — 본문만 집는다.
      const r = render();
      calls.upstream.push({ repo, fingerprint, title: r.title, body: r.body, labels: r.labels });
      return { issue: 500 + calls.upstream.length, created: true, appended: 0 };
    },
  };
}

const health = (over = {}) => runHealth({
  gh: over.gh || fakeGh(), root: "/r", repo: "o/r", upstream: "LeeHyeonKyu/know_thy_build",
  manifest, roleFile, harness: { factory: { upstream: "LeeHyeonKyu/know_thy_build" } },
  rehearsal: { ok: true, source: "variable" }, now: dayOf(28),
  ...over,
});

const signalsOf = (r, kind) => r.findings.filter((f) => f.signal === kind);

// ── (a) rubber-stamp — 짝이 있을 때만 ────────────────────────────────────────────────────────

test("100% 승인 + 귀속된 escaped 결함 ≥1 → `[ktb]` rubber-stamp 발견", async () => {
  // 다섯 이슈 모두: correctness가 R1에 승인 → R2에서 security가 결함을 찾는다.
  // correctness는 매번 100% 승인이고, 그때마다 escaped 결함이 그에게 귀속된다.
  const w = windowOf([1, 2, 3, 4, 5].map((n) => ({
    n, day: n, tier: "standard", costUsd: 10,
    rounds: [
      [approve("correctness"), approve("security")],
      [approve("correctness"), reject("security", ["late1"])],
    ],
  })));
  const gh = fakeGh();
  const r = await health({ gh, ...w });

  const stamp = signalsOf(r, "rubber-stamp");
  expect(stamp).toHaveLength(1);
  expect(stamp[0]).toMatchObject({ kind: "behavioural", paired: true, role: "correctness" });
  expect(stamp[0].causal_path).toBe(".claude/agents/reviewer-correctness.md");
  // 짝의 **양쪽 숫자가** 본문에 박혀 있어야 한다 — 승인률만 적힌 발견은 읽는 사람이 판정할 수 없다.
  expect(stamp[0].reason).toMatch(/10\/10 verdicts/);          // 다섯 이슈 × 두 라운드, 전부 승인
  expect(stamp[0].reason).toMatch(/escaped_defects 5/);        // 그리고 그때마다 귀속된 결함이 있었다
  expect(stamp[0].reason).toMatch(/last 5 merged issues/);
  // security는 결함을 찾아낸 쪽이다 — 절대 발견이 되지 않는다.
  expect(stamp.map((f) => f.role)).not.toContain("security");
  // 그리고 T3의 팔을 타고 상류로 갔다(라우팅은 재구현하지 않는다).
  expect(gh.calls.upstream).toHaveLength(1);
  expect(r.classified.every((c) => c.tags.includes("ktb"))).toBe(true);
});

test("100% 승인이지만 escaped 0 → **아무 발견도 없다**(승인률만으로는 판정 불가)", async () => {
  const w = windowOf([1, 2, 3, 4, 5].map((n) => ({
    n, day: n, tier: "standard", costUsd: 10,
    rounds: [[approve("correctness"), approve("security")]],   // 한 라운드에 전원 승인, 그 뒤 결함 없음
  })));
  const gh = fakeGh();
  const r = await health({ gh, ...w });

  expect(signalsOf(r, "rubber-stamp")).toHaveLength(0);
  expect(gh.calls.upstream).toHaveLength(0);
  // 그러나 신호 자체는 **보고서에 남는다** — 판정하지 않는 것과 재지 않는 것은 다르다.
  expect(r.signals.roles.correctness).toMatchObject({ approve_rate: 1, escaped_defects: 0, ever_rejects: false });
  expect(r.report).toContain("correctness");
});

// ── (b) dead debate ──────────────────────────────────────────────────────────────────────────

test("회의론자가 N개 이슈 내내 계획을 한 번도 바꾸지 않으면 dead-debate 발견", async () => {
  const w = windowOf([1, 2, 3, 4, 5].map((n) => ({
    n, day: n, tier: "standard", costUsd: 10,
    plan: { done_when: [{ id: "dw1", text: "x", verify: "t", level: "unit" }],
      dissent_log: [{ role: "skeptic", objection: "위험하다", resolution: "deferred" }] },
    rounds: [[approve("correctness"), reject("security")], [approve("correctness"), approve("security")]],
  })));
  const r = await health({ ...w });
  const dead = signalsOf(r, "dead-debate");
  expect(dead).toHaveLength(1);
  expect(dead[0]).toMatchObject({ kind: "behavioural", paired: true, stage: "plan" });
  expect(dead[0].reason).toMatch(/5/);
});

test("한 번이라도 계획을 바꿨으면 dead-debate 발견은 없다", async () => {
  const spec = [1, 2, 3, 4, 5].map((n) => ({
    n, day: n, tier: "standard", costUsd: 10,
    plan: { done_when: [{ id: "dw1", text: "x", verify: "t", level: "unit" }],
      dissent_log: [{ role: "skeptic", objection: "위험하다", resolution: "deferred" }] },
    rounds: [[approve("correctness"), reject("security")], [approve("correctness"), approve("security")]],
  }));
  // 다섯 중 **하나**만 이의가 실제로 해소됐다 — 토론은 살아 있다.
  spec[2].plan.dissent_log = [{ role: "skeptic", objection: "done_when이 검증 불가다", resolution: "accepted — done_when을 하나 더 넣었다" }];
  const r = await health({ ...windowOf(spec) });
  expect(signalsOf(r, "dead-debate")).toHaveLength(0);
});

// ── (c) cost vs risk ─────────────────────────────────────────────────────────────────────────

test("docs diff를 전체 패널에 태우고 비용이 그 tier의 기준선을 넘으면 waste 발견", async () => {
  const spec = [
    { n: 1, day: 1, tier: "standard", costUsd: 20, rounds: [PANEL.map(approve)] },
    { n: 2, day: 2, tier: "standard", costUsd: 20, rounds: [PANEL.map(approve)] },
    { n: 3, day: 3, tier: "load-bearing", costUsd: 25, rounds: [PANEL.map(approve)] },
    { n: 4, day: 4, tier: "docs", costUsd: 3, rounds: [[approve("correctness")]] },      // 제대로 된 docs 이슈
    { n: 18, day: 5, tier: "docs", costUsd: 80, rounds: [PANEL.map(approve)] },          // KTB #18
  ];
  const gh = fakeGh();
  const r = await health({ gh, ...windowOf(spec) });

  const waste = signalsOf(r, "cost-vs-risk");
  expect(waste).toHaveLength(1);
  expect(waste[0]).toMatchObject({ kind: "behavioural", paired: true, issue: 18 });
  // 인과는 로스터를 푼 자리다 — docs diff에 전체 패널을 붙인 것이 그 발견의 내용이다.
  expect(waste[0].causal_path).toBe(".factory/lib/review-roster.js");
  expect(waste[0].extra.cost.usd).toBe(80);
  expect(waste[0].reason).toMatch(/docs/);
  expect(waste[0].reason).toMatch(/4/);              // 패널 크기가 짝의 절반이다
  // 값싼 docs 이슈(#4)는 같은 tier인데도 발견이 아니다 — 비용만으로는 아무것도 판정하지 않는다.
  expect(waste.map((f) => f.issue)).not.toContain(4);
  expect(r.signals.cost_by_tier.docs).toBe(83);
  expect(r.signals.cost_by_tier["load-bearing"]).toBe(25);
});

test("비교할 상위 위험 tier가 창에 없으면 기준선이 없고, 기준선이 없으면 waste 발견도 없다", async () => {
  // 전부 docs다 — "docs치고 비싸다"를 말할 기준이 이 창 안에 없다(짝 없는 비용이다).
  const spec = [1, 2, 3, 4, 5].map((n) => ({ n, day: n, tier: "docs", costUsd: n === 5 ? 80 : 3, rounds: [PANEL.map(approve)] }));
  const r = await health({ ...windowOf(spec) });
  expect(signalsOf(r, "cost-vs-risk")).toHaveLength(0);
  expect(costBaselineFor("docs", [])).toBeNull();
});

test("RISK_ORDER는 위험 순서이고 기준선은 **더 위험한** tier들의 중앙값이다", () => {
  expect(RISK_ORDER).toEqual(["docs", "standard", "load-bearing"]);
  const per = [
    { tier: "standard", cost: 10 }, { tier: "standard", cost: 30 }, { tier: "load-bearing", cost: 50 },
  ];
  expect(costBaselineFor("docs", per)).toBe(30);          // median(10, 30, 50)
  expect(costBaselineFor("load-bearing", per)).toBeNull(); // 그 위가 없다
});

// ── (d) N 미만 ───────────────────────────────────────────────────────────────────────────────

test("머지 이슈가 N개에 못 미치면 **아무것도 방출하지 않는다**", async () => {
  expect(DEFAULT_N).toBe(5);
  // (a)와 **똑같이** rubber-stamp 모양인데 이슈가 넷뿐이다.
  const w = windowOf([1, 2, 3, 4].map((n) => ({
    n, day: n, tier: "standard", costUsd: 10,
    rounds: [[approve("correctness"), approve("security")], [approve("correctness"), reject("security", ["late1"])]],
  })));
  const gh = fakeGh();
  const r = await health({ gh, ...w });

  expect(r.below_n).toBe(true);
  expect(r.findings).toEqual([]);
  expect(gh.calls.upstream).toHaveLength(0);
  // 보고서는 그래도 나간다 — 표본이 모자란다는 것 자체가 주인이 읽어야 할 상태다.
  expect(r.report).toMatch(/4\s*\/\s*5|표본/);
  expect(gh.calls.created.length + gh.calls.comments.length).toBeGreaterThan(0);
});

// ── 고정된 회귀 ──────────────────────────────────────────────────────────────────────────────

test("회귀 — own-cal #3: 리뷰 4라운드에 리뷰어가 **REJECT**했다 → rounds는 높고 rubber-stamp는 없다", async () => {
  // 실제 모양: 라운드가 네 번 돌았고 리뷰어들이 계속 거절했다. 라운드 수만 보는 지표라면 이 이슈가
  // 가장 시끄럽지만, 그것은 리뷰가 **일하고 있다**는 뜻이지 도장 찍기가 아니다.
  const three = {
    n: 3, day: 3, tier: "standard", costUsd: 40,
    rounds: [
      [reject("correctness", ["a"]), reject("spec-conformance", ["b"])],
      [reject("correctness", ["c"]), approve("spec-conformance")],
      [reject("correctness", ["d"]), approve("spec-conformance")],
      [approve("correctness"), approve("spec-conformance")],
    ],
  };
  const others = [1, 2, 4, 5].map((n) => ({
    n, day: n, tier: "standard", costUsd: 10,
    rounds: [[reject("correctness", ["x"])], [approve("correctness"), approve("spec-conformance")]],
  }));
  const gh = fakeGh();
  const r = await health({ gh, ...windowOf([three, ...others]) });

  expect(r.signals.rounds_per_issue.find((x) => x.issue === 3).review).toBe(4);
  expect(signalsOf(r, "rubber-stamp")).toHaveLength(0);
  // correctness는 계속 거절했다 — 100% 승인이 아니다.
  expect(r.signals.roles.correctness.ever_rejects).toBe(true);
  expect(r.signals.roles.correctness.approve_rate).toBeLessThan(1);
  expect(gh.calls.upstream).toHaveLength(0);
});

test("회귀 — KTB #18: 4역할 표준 패널에 올라간 docs 이슈(~$80 리뷰)가 cost_vs_risk waste로 잡힌다", async () => {
  const spec = [
    { n: 15, day: 1, tier: "standard", costUsd: 18, rounds: [PANEL.map(approve)] },
    { n: 16, day: 2, tier: "standard", costUsd: 22, rounds: [PANEL.map(approve)] },
    { n: 17, day: 3, tier: "load-bearing", costUsd: 30, rounds: [PANEL.map(approve)] },
    { n: 19, day: 4, tier: "standard", costUsd: 20, rounds: [PANEL.map(approve)] },
    { n: 18, day: 5, tier: "docs", costUsd: 80, rounds: [PANEL.map(approve)] },
  ];
  const gh = fakeGh();
  const r = await health({ gh, ...windowOf(spec) });

  const waste = signalsOf(r, "cost-vs-risk");
  expect(waste).toHaveLength(1);
  expect(waste[0].issue).toBe(18);
  expect(waste[0].extra.cost.usd).toBe(80);
  expect(r.signals.cost_vs_risk.find((x) => x.issue === 18)).toMatchObject({ tier: "docs", panel: 4, cost: 80 });
  // 상류로 하나 갔고, 그 본문에 지문이 박혀 있다(T3의 dedupe 열쇠).
  expect(gh.calls.upstream).toHaveLength(1);
  expect(gh.calls.upstream[0].body).toContain(waste[0].fingerprint ?? "");
});

// ── 보고서와 리허설 줄 ───────────────────────────────────────────────────────────────────────

test("보고서는 `factory:health` 이슈에 실린다 — 없으면 열고, 있으면 코멘트로 잇는다", async () => {
  const w = windowOf([1, 2, 3, 4, 5].map((n) => ({ n, day: n, tier: "standard", costUsd: 10, rounds: [[approve("correctness")]] })));

  const fresh = fakeGh();
  const a = await health({ gh: fresh, ...w });
  expect(fresh.calls.created).toHaveLength(1);
  expect(fresh.calls.created[0].labels).toContain("factory:health");
  expect(a.report_issue).toBe(900);

  const existing = fakeGh({ healthIssue: 77 });
  const b = await health({ gh: existing, ...w });
  expect(existing.calls.created).toHaveLength(0);
  expect(existing.calls.comments.some((c) => c.issue === 77)).toBe(true);
  expect(b.report_issue).toBe(77);
});

test("리허설 기록은 **건강 줄**이지 발견이 아니다 — RED여도 행동 발견을 만들지 않는다", async () => {
  const w = windowOf([1, 2, 3, 4, 5].map((n) => ({ n, day: n, tier: "standard", costUsd: 10, rounds: [[approve("correctness")]] })));
  const gh = fakeGh();
  const r = await health({ gh, ...w, rehearsal: { ok: false, reason: "harness changed since the last rehearsal — run `factory rehearse`" } });

  expect(r.report).toContain("rehearsal");
  expect(r.report).toContain("harness changed since the last rehearsal");
  expect(r.findings).toEqual([]);          // 리허설 RED는 이슈별 durable 줄이 없다(T3) — 발견이 아니다
  expect(gh.calls.upstream).toHaveLength(0);
});
