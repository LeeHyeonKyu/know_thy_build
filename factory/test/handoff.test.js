import { test, expect } from "vitest";
import { parseHandoffs, latestHandoff, renderHandoff } from "../lib/handoff.js";

const planBody = `<!-- factory-handoff:v1 stage=plan issue=123 -->
### Plan · round 3 합의

**접근**: 증분 동기화

\`\`\`json
{"schema":"factory.plan.v1","issue":123,"tier":"standard","done_when":[{"id":"dw1","text":"x","verify":"test_123_x","level":"unit"}]}
\`\`\`
`;

test("renderHandoff produces marker + summary + json fence, and parses back", () => {
  const body = renderHandoff({ stage: "plan", issue: 123, summary: "### Plan\n\n**접근**: 증분 동기화", data: { schema: "factory.plan.v1", issue: 123 } });
  expect(body.startsWith("<!-- factory-handoff:v1 stage=plan issue=123 -->")).toBe(true);
  expect(body).toContain("```json\n");
  const [h] = parseHandoffs([{ id: 1, body, createdAt: "2026-09-11T00:00:00Z" }]);
  expect(h.stage).toBe("plan");
  expect(h.issue).toBe(123);
  expect(h.data.schema).toBe("factory.plan.v1");
  expect(h.summary).toContain("**접근**");
});

test("parseHandoffs ignores non-handoff comments and malformed json", () => {
  const comments = [
    { id: 1, body: "just a comment", createdAt: "2026-09-11T00:00:00Z" },
    { id: 2, body: planBody, createdAt: "2026-09-11T00:01:00Z" },
    { id: 3, body: "<!-- factory-handoff:v1 stage=plan issue=123 -->\n```json\n{not json\n```", createdAt: "2026-09-11T00:02:00Z" },
  ];
  const hs = parseHandoffs(comments);
  expect(hs).toHaveLength(1);
  expect(hs[0].commentId).toBe(2);
});

// ── Task 6: 스테이지별 사람용 본문 (마커·JSON 펜스는 그대로) ────────────────────────────────
const roundTrip = (stage, issue, data, summary = "s") => {
  const body = renderHandoff({ stage, issue, summary, data });
  const [h] = parseHandoffs([{ id: 1, body, createdAt: "2026-09-11T00:00:00Z" }]);
  return { body, h, human: body.split("```json")[0] };   // 사람용 본문만 — 기계 블록에는 원문이 통째로 들어 있다
};

const PLAN_DATA = {
  schema: "factory.plan.v1", issue: 42, tier: "standard", roles: ["product-advocate", "architect"], rounds: 3,
  done_when: [
    { id: "dw1", text: "CSV 내보내기에 헤더 행이 있다", verify: "test_42_csv_header", level: "unit" },
    { id: "dw2", text: "빈 결과도 헤더만 있는 파일을 낸다", verify: "test_42_csv_empty", level: "integration" },
  ],
  files_expected: ["src/export/csv.js"],
  dissent_log: [{ role: "architect", objection: "동기 내보내기는 타임아웃이 난다", resolution: "10k행 이하로 제한" }],
  non_goals: ["XLSX"], open_risks: [],
  debate: {
    r1: [
      { role: "product-advocate", position: "사용자는 CSV를 지금 원한다. 나머지는 나중이다." },
      { role: "architect", position: "내보내기는 서비스 경계 밖에 둔다. 그래야 되돌릴 수 있다." },
    ],
    r2_objections: 1,
    votes: [{ role: "product-advocate", vote: "accept", reason: "ok" }, { role: "architect", vote: "object", reason: "여전히 범위가 넓다" }],
  },
};

test("renderHandoff plan: done_when list, dissent list, debate digest — and the JSON still round-trips", () => {
  const { body, h, human } = roundTrip("plan", 42, PLAN_DATA, "### Plan · 합의");
  expect(body.startsWith("<!-- factory-handoff:v1 stage=plan issue=42 -->")).toBe(true);
  expect(h.summary).toContain("### Plan · 합의");                       // summary는 맨 위에 그대로
  expect(h.data).toEqual(PLAN_DATA);                                    // 기계 블록은 손대지 않는다

  expect(body).toContain("**done_when**");
  expect(body).toContain("dw1 · CSV 내보내기에 헤더 행이 있다 · test_42_csv_header@unit");
  expect(body).toContain("dw2 · 빈 결과도 헤더만 있는 파일을 낸다 · test_42_csv_empty@integration");
  expect(body).toContain("**dissent**");
  expect(body).toContain("architect: 동기 내보내기는 타임아웃이 난다 → 10k행 이하로 제한");
  expect(body).toContain("**토론**");
  expect(body).toContain("R1 product-advocate: 사용자는 CSV를 지금 원한다.");   // 첫 문장만
  expect(human).not.toContain("나머지는 나중이다");                              // 다이제스트는 전문이 아니다
  expect(body).toContain("R2: 1 objection");
  expect(body).toContain("votes: 1 accept / 1 object");
});

test("renderHandoff plan: the docs tier (rounds 2) never ran cross-examination — no R2 line, not '0 objections'", () => {
  const data = { ...PLAN_DATA, issue: 7, tier: "docs", rounds: 2, debate: { ...PLAN_DATA.debate, r2_objections: 0 } };
  const { human } = roundTrip("plan", 7, data);
  expect(human).toContain("**토론**");
  expect(human).toContain("R1 product-advocate:");
  expect(human).not.toContain("R2:");
  // rounds 3이면 0이라도 줄이 나온다 — "교차검토했고 아무도 반박하지 않았다"는 사실이다
  const three = roundTrip("plan", 7, { ...data, rounds: 3 }).human;
  expect(three).toContain("R2: 0 objections");
});

test("renderHandoff plan: an empty debate/dissent renders no empty headings and still round-trips", () => {
  const data = { issue: 7, tier: "docs", done_when: [{ id: "dw1", text: "문서가 갱신된다", verify: "test_7_docs", level: "unit" }], dissent_log: [], files_expected: [], non_goals: [], open_risks: [] };
  const { human, h } = roundTrip("plan", 7, data);
  expect(h.data).toEqual(data);
  expect(human).toContain("**done_when**");
  expect(human).not.toContain("**dissent**");
  expect(human).not.toContain("**토론**");
});

test("renderHandoff implement: PR number, verifier verdict with finding count, tests_added", () => {
  const data = {
    schema: "factory.implement.v1", issue: 42, pr: 31, head_sha: "0123456789abcdef0123456789abcdef01234567",
    tests_added: ["test_42_csv_header", "test_42_csv_empty"],
    verifier: { verdict: "accepted-with-reservations", findings: [{ where: "src/a.js:1", claim: "c", evidence: "e" }] },
    orchestration: "workflow", guarantee: "structural",
  };
  const { body, h } = roundTrip("implement", 42, data);
  expect(h.data).toEqual(data);
  expect(body).toContain("**PR #31** · head `0123456789ab`");   // 강조는 PR 번호 하나뿐 — sha는 따라오는 사실이다
  expect(body).not.toContain("**PR #31** · head `0123456789ab`**");
  expect(body).toContain("verifier: accepted-with-reservations (1 finding)");
  expect(body).toContain("test_42_csv_header");
  expect(body).toContain("test_42_csv_empty");
});

test("renderHandoff review: one table row per reviewer with role/verdict/confidence/must_fix", () => {
  const data = {
    schema: "factory.review.v1", issue: 42, pr: 31, round: 2,
    verdicts: [
      { role: "correctness", verdict: "reject", confidence: "high", must_fix: [{ id: "cf1", where: "src/a.js:8", claim: "c", evidence: "e" }, { id: "cf2", where: "src/a.js:9", claim: "c", evidence: "e" }], should_fix: [], verified: [] },
      { role: "spec-conformance", verdict: "approve", confidence: "medium", must_fix: [], should_fix: [], verified: ["dw1"] },
    ],
    orchestration: "workflow", guarantee: "structural",
  };
  const { body, h } = roundTrip("review", 42, data);
  expect(h.data).toEqual(data);
  expect(body).toContain("| role | verdict | confidence | must_fix |");
  expect(body).toContain("| --- | --- | --- | --- |");
  expect(body).toContain("| correctness | reject | high | cf1, cf2 |");
  expect(body).toContain("| spec-conformance | approve | medium | — |");
});

test("renderHandoff triage: disposition, tier and the questions that block it", () => {
  const data = { schema: "factory.triage.v1", issue: 42, disposition: "needs-info", questions: ["어느 인코딩인가?", "헤더 이름은?"] };
  const { body, h } = roundTrip("triage", 42, data);
  expect(h.data).toEqual(data);
  expect(body).toContain("**disposition**: needs-info");
  expect(body).toContain("**questions**");
  expect(body).toContain("어느 인코딩인가?");
  const ready = roundTrip("triage", 42, { disposition: "ready", tier: "standard" });
  expect(ready.body).toContain("**disposition**: ready · tier standard");
  expect(ready.human).not.toContain("**questions**");
});

test("renderHandoff: an unknown stage and a missing summary still render and parse", () => {
  // summary를 아예 넘기지 않는다(`write-handoff.js`는 항상 넘기지만, 마커/펜스 구조는 그것과 무관해야 한다)
  const body = renderHandoff({ stage: "retro", issue: 3, data: { issue: 3, note: "later" } });
  expect(body.startsWith("<!-- factory-handoff:v1 stage=retro issue=3 -->")).toBe(true);
  const [h] = parseHandoffs([{ id: 1, body, createdAt: "2026-09-11T00:00:00Z" }]);
  expect(h.summary).toBe("");
  expect(h.data).toEqual({ issue: 3, note: "later" });
});

test("latestHandoff returns the newest for a stage by createdAt", () => {
  const older = { id: 1, body: planBody.replace('"tier":"standard"', '"tier":"docs"'), createdAt: "2026-09-10T00:00:00Z" };
  const newer = { id: 2, body: planBody, createdAt: "2026-09-11T00:00:00Z" };
  expect(latestHandoff([newer, older], "plan").data.tier).toBe("standard");
  expect(latestHandoff([older], "review")).toBe(null);
});
