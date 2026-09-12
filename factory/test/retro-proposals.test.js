import { test, expect } from "vitest";
import { filterByEvidence, renderProposalPr, DEFAULT_WINDOWS } from "../lib/retro/proposals.js";

const p = (kind, runs, extra = {}) => ({ kind, title: `${kind} 제안`, body: `${kind} 본문`, evidence_runs: runs, ...extra });

test("gate proposals need >=3 distinct evidence runs", () => {
  const { accepted, deferred } = filterByEvidence([p("gate", [1, 2]), p("gate", [1, 2, 3])]);
  expect(accepted.map((x) => x.evidence_runs.length)).toEqual([3]);
  expect(deferred).toHaveLength(1);
  expect(deferred[0].proposal.evidence_runs).toEqual([1, 2]);
  expect(deferred[0].reason).toContain("2");
  expect(deferred[0].reason).toContain("3");
});

test("threshold needs 20, role-change/role-new need 10 runs", () => {
  const runs = (n) => Array.from({ length: n }, (_, i) => i + 1);
  const { accepted, deferred } = filterByEvidence([
    p("threshold", runs(19)),
    p("threshold", runs(20)),
    p("role-change", runs(9)),
    p("role-change", runs(10)),
    p("role-new", runs(9)),
    p("role-new", runs(10)),
  ]);
  expect(accepted.map((x) => `${x.kind}:${x.evidence_runs.length}`)).toEqual(["threshold:20", "role-change:10", "role-new:10"]);
  expect(deferred.map((d) => `${d.proposal.kind}:${d.proposal.evidence_runs.length}`)).toEqual(["threshold:19", "role-change:9", "role-new:9"]);
});

test("test-delete is always accepted — deletion is a human judgment, not an evidence count", () => {
  const { accepted, deferred } = filterByEvidence([p("test-delete", []), p("test-delete", undefined)]);
  expect(accepted).toHaveLength(2);
  expect(deferred).toEqual([]);
});

test("distinct runs are counted — the same issue repeated does not fill the window", () => {
  const { accepted, deferred } = filterByEvidence([p("gate", [7, 7, 7, 7])]);
  expect(accepted).toEqual([]);
  expect(deferred[0].reason).toContain("1");
});

test("a partial windows override keeps the defaults for the other kinds", () => {
  const { accepted, deferred } = filterByEvidence([p("gate", [1, 2, 3, 4, 5]), p("role-new", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])], { windows: { gate: 6 } });
  expect(accepted.map((x) => x.kind)).toEqual(["role-new"]);
  expect(deferred.map((d) => d.proposal.kind)).toEqual(["gate"]);
  expect(DEFAULT_WINDOWS).toEqual({ gate: 3, threshold: 20, "role-change": 10, "role-new": 10 });
});

test("an empty proposal list yields empty buckets", () => {
  expect(filterByEvidence([])).toEqual({ accepted: [], deferred: [] });
  expect(filterByEvidence()).toEqual({ accepted: [], deferred: [] });
});

const STATS = {
  merged: 12,
  review_rounds_avg: 1.6,
  rejects_by_role: { "reviewer-correctness": 7, "reviewer-spec-conformance": 3, "reviewer-security": 0 },
  needs_human: 1,
  usage: { cost_usd: 12.345, tokens: { input: 1200000, output: 340000 } },
};

test("renderProposalPr matches the §8.3 shape", () => {
  const { title, body } = renderProposalPr({
    period: { from: "2026-09-01", to: "2026-09-06" },
    proposals: [
      { kind: "gate", title: "lesson L-2026-09-05-03 → eslint rule", body: "`Promise.all` 부분 실패가 3주간 4회 인용.", evidence_runs: [110, 112, 118, 121] },
      { kind: "role-new", title: "`reviewer-performance` 신설", body: "최근 30 run 중 reject 4건이 N+1 쿼리.", evidence_runs: [104, 110] },
    ],
    stats: STATS,
  });

  expect(title).toBe("retro proposals 2026-09-01..2026-09-06");
  expect(body.split("\n")[0]).toBe("<!-- factory-retro:v1 period=2026-09-01..2026-09-06 -->");
  expect(body).toContain("## Retro 2026-W36 — 제안 2건");
  expect(body).toContain("### P1 · lesson 승격 → gate  (label: factory:retro-proposal)");
  expect(body).toContain("lesson L-2026-09-05-03 → eslint rule");
  expect(body).toContain("`Promise.all` 부분 실패가 3주간 4회 인용.");
  expect(body).toContain("근거: runs/110.md, runs/112.md, runs/118.md, runs/121.md");
  expect(body).toContain("### P2 · 역할 신설  (label: factory:retro-proposal)");
  expect(body).toContain("근거: runs/104.md, runs/110.md");
  expect(body).toContain("### 통계");
  expect(body).toContain("이슈 12건 머지, 평균 리뷰 라운드 1.6, needs-human 1건");
  expect(body).toContain("리뷰어별 reject 기여: reviewer-correctness 7, reviewer-spec-conformance 3, reviewer-security 0");
  expect(body).toContain("사용량: $12.35");
  expect(body).toContain("input 1200000");
  expect(body).toContain("output 340000");
  expect(body.endsWith("\n")).toBe(true);
});

test("every proposal kind renders a Korean label", () => {
  const { body } = renderProposalPr({
    period: { from: "2026-09-01", to: "2026-09-06" },
    proposals: [p("gate", [1]), p("threshold", [1]), p("role-change", [1]), p("role-new", [1]), p("test-delete", [1])],
    stats: STATS,
  });
  for (const [i, label] of ["lesson 승격 → gate", "임계 조정", "역할 변경", "역할 신설", "테스트 삭제"].entries()) {
    expect(body).toContain(`### P${i + 1} · ${label}  (label: factory:retro-proposal)`);
  }
});

test("a proposal with no evidence runs renders no 근거 line", () => {
  const { body } = renderProposalPr({
    period: { from: "2026-09-01", to: "2026-09-06" },
    proposals: [{ kind: "test-delete", title: "flaky 테스트 삭제", body: "TTL 만료 후 재작성도 실패.", evidence_runs: [] }],
    stats: STATS,
  });
  expect(body).toContain("### P1 · 테스트 삭제  (label: factory:retro-proposal)");
  expect(body).not.toContain("근거:");
});

test("zero proposals still renders the marker, the count and the stats block", () => {
  const { body } = renderProposalPr({ period: { from: "2026-09-01", to: "2026-09-06" }, proposals: [], stats: STATS });
  expect(body).toContain("## Retro 2026-W36 — 제안 0건");
  expect(body).not.toContain("### P1");
  expect(body).toContain("### 통계");
});

test("missing stats degrade to zeros instead of undefined", () => {
  const { body } = renderProposalPr({ period: { from: "2026-01-01", to: "2026-01-01" }, proposals: [] });
  expect(body).toContain("## Retro 2026-W01 — 제안 0건");
  expect(body).toContain("이슈 0건 머지, 평균 리뷰 라운드 0, needs-human 0건");
  expect(body).toContain("리뷰어별 reject 기여: 없음");
  expect(body).toContain("사용량: $0.00");
});
