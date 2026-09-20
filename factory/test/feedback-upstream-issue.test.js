import { test, expect } from "vitest";
import {
  UPSTREAM_LABELS, upstreamMarker, upstreamIssueTitle,
  renderUpstreamIssue, parseUpstreamIssue, appendEvidence, evidenceEntries,
} from "../lib/feedback/upstream-issue.js";

/** 이 세션의 실제 소견(KTB #39 self-gate qa-manifest false-block)을 그대로 payload로 쓴다. */
const PAYLOAD = {
  issue: 39,
  repo: "LeeHyeonKyu/know-thy-build-demo",
  stage: "implement",
  round: 2,
  ktb_version: "1.3.2",
  tags: ["ktb"],
  reason: "self-gate blocked issue #39 for a missing qa manifest the tier never required",
  causal: {
    path: ".factory/lib/self-gate.js",
    line: 118,
    owner: "factory",
    command: "node .factory/bin/self-gate.js implement",
    test: "self-gate/qa-manifest",
    snippet: "self-gate: qa evidence manifest missing (tier=standard)",
  },
  chain: [{ event: "transition-refused", at: "2026-09-20T04:11:00Z" }],
  cost: { usd: 1.24, tokens: 41_000 },
  fingerprint: "ab12cd34ef56",
};

const RENDER = () => renderUpstreamIssue({
  fingerprint: "ab12cd34ef56",
  tags: ["ktb"],
  payload: PAYLOAD,
  sourceRepo: "LeeHyeonKyu/know-thy-build-demo",
  sourceIssue: 39,
});

test("renderUpstreamIssue: backlog + factory-improvement 라벨로 뜬다(사람이 트리아지한다 — 스펙 §10 Q4)", () => {
  const { labels } = RENDER();
  expect(labels).toEqual(["factory-improvement", "backlog"]);
  expect(UPSTREAM_LABELS).toEqual(["factory-improvement", "backlog"]);
});

test("renderUpstreamIssue: 본문 **첫 줄**이 기계 마커다 — fp·tags·from (Task 3의 dedupe 키)", () => {
  const { body } = RENDER();
  expect(body.split("\n")[0]).toBe("<!-- factory-improvement fp=ab12cd34ef56 tags=ktb from=LeeHyeonKyu/know-thy-build-demo#39 -->");
  expect(upstreamMarker({ fingerprint: "x1", tags: ["ktb", "harness"], from: "o/r#7" }))
    .toBe("<!-- factory-improvement fp=x1 tags=ktb,harness from=o/r#7 -->");
});

test("renderUpstreamIssue: 사람이 읽는 절 — 무엇이 일어났나·원인 파일:줄+owner·증거 스니펫·KTB 버전", () => {
  const { title, body } = RENDER();
  expect(title).toContain(".factory/lib/self-gate.js");
  expect(body).toContain("self-gate blocked issue #39");
  expect(body).toContain("`.factory/lib/self-gate.js:118`");
  expect(body).toContain("factory");                                   // owner
  expect(body).toContain("1.3.2");                                     // KTB 버전
  expect(body).toContain("self-gate: qa evidence manifest missing");   // 스니펫
  expect(body).toContain("## Evidence");
  expect(body).toMatch(/```json\n[\s\S]*"fingerprint": "ab12cd34ef56"[\s\S]*\n```/);
});

test("render → parse 왕복: fingerprint·tags·from·payload가 그대로 돌아온다", () => {
  const { body } = RENDER();
  expect(parseUpstreamIssue(body)).toEqual({
    fingerprint: "ab12cd34ef56",
    tags: ["ktb"],
    from: "LeeHyeonKyu/know-thy-build-demo#39",
    payload: PAYLOAD,
  });
});

test("parseUpstreamIssue: JSON 블록이 없어도 마커가 주는 것은 돌려준다(사람이 손으로 연 이슈)", () => {
  const body = [
    "<!-- factory-improvement fp=deadbeef tags=ktb,harness from=LeeHyeonKyu/own-cal#3 -->",
    "",
    "테스트 명령에 따옴표를 넣었더니 test_one이 아무 테스트도 안 돌렸다.",
  ].join("\n");
  expect(parseUpstreamIssue(body)).toEqual({
    fingerprint: "deadbeef",
    tags: ["ktb", "harness"],
    from: "LeeHyeonKyu/own-cal#3",
    payload: null,
  });
});

test("parseUpstreamIssue: 마커가 없으면 null(팩토리가 연 이슈가 아니다)", () => {
  expect(parseUpstreamIssue("그냥 사람이 쓴 이슈")).toBe(null);
  expect(parseUpstreamIssue("")).toBe(null);
  expect(parseUpstreamIssue(undefined)).toBe(null);
});

test("appendEvidence: 증거가 하나 늘고, 마커는 정확히 하나로 남는다(새 이슈를 열지 않는다)", () => {
  const { body } = RENDER();
  expect(evidenceEntries(body).length).toBe(1);

  const next = appendEvidence(body, { ...PAYLOAD, issue: 41, round: 1, causal: { ...PAYLOAD.causal, line: 120 } }, "LeeHyeonKyu/know-thy-build-demo#41");
  expect(evidenceEntries(next).length).toBe(2);
  expect(next.match(/<!-- factory-improvement /g).length).toBe(1);
  expect(next.split("\n")[0]).toBe(body.split("\n")[0]);          // 마커 줄은 그대로(첫 목격의 from을 유지)
  expect(next).toContain("#41");
  expect(parseUpstreamIssue(next).payload).toEqual(PAYLOAD);      // 첫 payload 블록은 보존된다
});

test("appendEvidence: 같은 출처를 두 번 넣어도 항목은 늘지 않는다(retro 재실행에 멱등)", () => {
  const { body } = RENDER();
  const once = appendEvidence(body, { ...PAYLOAD, issue: 41 }, "LeeHyeonKyu/know-thy-build-demo#41");
  const twice = appendEvidence(once, { ...PAYLOAD, issue: 41 }, "LeeHyeonKyu/know-thy-build-demo#41");
  expect(twice).toBe(once);
  expect(evidenceEntries(twice).length).toBe(2);
});

test("appendEvidence: Evidence 절이 없는 본문(사람이 템플릿으로 연 이슈)에는 절을 만들어 붙인다", () => {
  const body = [
    "<!-- factory-improvement fp=deadbeef tags=ktb from=LeeHyeonKyu/own-cal#3 -->",
    "",
    "## 무엇이 일어났나",
    "손으로 적은 개선 요청.",
  ].join("\n");
  const next = appendEvidence(body, PAYLOAD, "LeeHyeonKyu/know-thy-build-demo#39");
  expect(next).toContain("## Evidence");
  expect(evidenceEntries(next).length).toBe(1);
  expect(next.match(/<!-- factory-improvement /g).length).toBe(1);
  expect(parseUpstreamIssue(next).fingerprint).toBe("deadbeef");
});

test("upstreamIssueTitle: 같은 원인이면 같은 제목(중복 이슈를 눈으로도 알아본다)", () => {
  const a = upstreamIssueTitle({ ...PAYLOAD, issue: 39 });
  const b = upstreamIssueTitle({ ...PAYLOAD, issue: 41, round: 3 });
  expect(a).toBe(b);
  expect(a.startsWith("factory-improvement: ")).toBe(true);
  expect(a.length).toBeLessThanOrEqual(120);
  expect(a).not.toContain("\n");
});

test("마커는 한 줄로 유지된다 — 줄바꿈·`-->`가 섞인 값이 들어와도 마커를 깨지 않는다", () => {
  const line = upstreamMarker({ fingerprint: "a\nb", tags: ["k t b", "x-->y"], from: "o/r#1\n" });
  expect(line.split("\n").length).toBe(1);
  expect(line.endsWith("-->")).toBe(true);
  expect(line.slice(0, -3)).not.toContain("-->");
});

test("payload가 비어도 render는 마커와 사람이 읽는 골격을 낸다(증거가 얇은 소견도 버리지 않는다)", () => {
  const { body, labels } = renderUpstreamIssue({ fingerprint: "f1", tags: ["ambiguous"], payload: {}, sourceRepo: "o/r", sourceIssue: 7 });
  expect(labels).toEqual(["factory-improvement", "backlog"]);
  expect(body.split("\n")[0]).toBe("<!-- factory-improvement fp=f1 tags=ambiguous from=o/r#7 -->");
  expect(parseUpstreamIssue(body)).toMatchObject({ fingerprint: "f1", tags: ["ambiguous"], from: "o/r#7", payload: {} });
});
