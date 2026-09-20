import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  UPSTREAM_LABELS, upstreamMarker, upstreamIssueTitle,
  renderUpstreamIssue, parseUpstreamIssue, appendEvidence, evidenceEntries,
} from "../lib/feedback/upstream-issue.js";

const ISSUE_TEMPLATE = new URL("../../.github/ISSUE_TEMPLATE/factory-improvement.md", import.meta.url).pathname;

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

test("리뷰 must_fix 1 — 증거 스니펫 안의 ```json 블록이 진짜 payload를 가로채지 못한다", () => {
  const hostile = {
    ...PAYLOAD,
    causal: { ...PAYLOAD.causal, snippet: 'gate output:\n```json\n{"evil": true}\n```\ndone' },
  };
  const { body } = renderUpstreamIssue({ fingerprint: "ab12cd34ef56", tags: ["ktb"], payload: hostile, sourceRepo: "o/r", sourceIssue: 39 });
  // 스니펫은 본문에 그대로 실린다(증거를 잘라내지 않는다) — 그런데도 읽히는 payload는 기계가 쓴 것이다.
  expect(body).toContain('{"evil": true}');
  expect(parseUpstreamIssue(body).payload).toEqual(hostile);

  // 덧붙인 증거가 또 하나의 ```json을 들고 와도 마찬가지다(append로 악화되지 않는다).
  const next = appendEvidence(body, { ...hostile, issue: 41 }, "o/r#41");
  expect(parseUpstreamIssue(next).payload).toEqual(hostile);
});

test("리뷰 must_fix 1b — `## Payload` 절이 아예 없으면 다른 펜스를 주워 읽지 않는다(null)", () => {
  const body = [
    "<!-- factory-improvement fp=f1 tags=ktb from=o/r#1 -->",
    "",
    "## Evidence",
    "",
    "- **o/r#1** — implement / round 1",
    "  ```json",
    '  {"evil": true}',
    "  ```",
  ].join("\n");
  expect(parseUpstreamIssue(body).payload).toBe(null);
});

test("리뷰 must_fix 2 — fingerprint가 비어도 왕복이 깨지지 않는다(dedupe가 영영 안 맞는 일을 막는다)", () => {
  for (const fingerprint of ["", undefined, null]) {
    const { body } = renderUpstreamIssue({ fingerprint, tags: ["ambiguous"], payload: {}, sourceRepo: "o/r", sourceIssue: 1 });
    expect(body.split("\n")[0]).toBe("<!-- factory-improvement fp=none tags=ambiguous from=o/r#1 -->");
    const parsed = parseUpstreamIssue(body);
    expect(parsed).not.toBe(null);
    expect(parsed.fingerprint).toBe("none");
  }
  // 사람이 `fp=`를 비운 채 연 이슈도 읽는다(마커가 있으면 읽는다 — null로 떨어뜨리지 않는다).
  expect(parseUpstreamIssue("<!-- factory-improvement fp= tags=ktb from=o/r#2 -->"))
    .toEqual({ fingerprint: "", tags: ["ktb"], from: "o/r#2", payload: null });
});

test("리뷰 must_fix 3 — reason 안의 `<!--`가 이슈 본문 나머지를 숨기지 못한다", () => {
  const payload = { ...PAYLOAD, reason: "the gate printed <!-- weird --> and stopped" };
  const { body } = renderUpstreamIssue({ fingerprint: "ab12", tags: ["ktb"], payload, sourceRepo: "o/r", sourceIssue: 39 });
  // 마커 줄과 payload 펜스(펜스 안은 GFM이 코드로 escape 한다) 사이의 산문에는 주석을 열지 않는다.
  const lines = body.split("\n");
  const human = lines.slice(1, lines.findIndex((l) => l === "## Payload")).join("\n");
  expect(human).not.toContain("<!--");
  expect(body).toContain("the gate printed");                // 그래도 reason은 읽힌다
  expect(body).toContain("## Evidence");
  // payload 블록 안의 원본은 그대로다(기계가 읽는 것은 손대지 않는다).
  expect(parseUpstreamIssue(body).payload).toEqual(payload);
});

test("리뷰 should_fix 1 — 들여쓴 `## Evidence`/`## Payload` 줄(사람이 붙인 로그 안의)을 절 제목으로 오인하지 않는다", () => {
  // 사람이 로그를 붙여 연 이슈: 코드 펜스 **안에** 절 제목처럼 생긴 줄이 있고, 진짜 절은 그 뒤에 온다.
  const withSection = [
    "<!-- factory-improvement fp=f1 tags=ktb from=o/r#1 -->",
    "",
    "```",
    "  ## Evidence",
    "  ## Payload",
    "```",
    "",
    "## Evidence",
    "",
    "- **o/r#1** — implement / round 1",
    "",
    "## Payload",
    "",
    "```json",
    "{}",
    "```",
  ].join("\n");
  const a = appendEvidence(withSection, PAYLOAD, "o/r#39");
  const lines = a.split("\n");
  expect(lines.indexOf("- **o/r#39** — implement / round 2 · `.factory/lib/self-gate.js:118`"))
    .toBeGreaterThan(lines.indexOf("## Evidence"));      // 펜스 안이 아니라 진짜 절 안에 들어갔다
  expect(evidenceEntries(a).length).toBe(2);
  expect(parseUpstreamIssue(a).payload).toEqual({});

  // 그리고 `## Evidence` 절이 없는 본문에서는, 펜스 안의 가짜 `## Payload`가 삽입 위치를 끌어가지 않는다.
  const noSection = ["<!-- factory-improvement fp=f1 tags=ktb from=o/r#1 -->", "", "```", "  ## Payload", "```", "", "## Payload", "", "```json", "{}", "```"].join("\n");
  const b = appendEvidence(noSection, PAYLOAD, "o/r#39");
  expect(b.split("\n").indexOf("## Evidence")).toBeGreaterThan(b.split("\n").indexOf("```"));
  expect(b.split("\n").indexOf("## Evidence")).toBeLessThan(b.split("\n").indexOf("## Payload"));
  expect(evidenceEntries(b).length).toBe(1);
  expect(parseUpstreamIssue(b).payload).toEqual({});
});

test("리뷰 should_fix 2 — 저장소의 이슈 템플릿이 같은 문법으로 파싱된다(사람이 연 이슈도 dedupe에 참여한다)", () => {
  const raw = readFileSync(ISSUE_TEMPLATE, "utf8");
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
  const parsed = parseUpstreamIssue(body);
  expect(parsed).not.toBe(null);
  expect(parsed.fingerprint.startsWith("manual-")).toBe(true);   // 기본값은 그대로 쓰면 안 되는 placeholder 모양이다
  expect(parsed.tags).toEqual(["ktb"]);
  expect(parsed.from).toBe("owner/repo#0");
  expect(parsed.payload).toBe(null);
  expect(raw).toMatch(/labels:.*factory-improvement.*backlog/);
  // 그리고 팩토리가 그 이슈에 증거를 덧붙일 수 있다(절이 이미 있으므로 항목만 하나 는다).
  const next = appendEvidence(body, PAYLOAD, "o/r#39");
  expect(next.match(/<!-- factory-improvement /g).length).toBe(1);
  expect(evidenceEntries(next).length).toBe(evidenceEntries(body).length + 1);
});

test("리뷰 should_fix 5 — 멱등 키는 출처+스테이지+라운드다(줄 번호가 밀려도 항목이 늘지 않는다)", () => {
  const { body } = RENDER();
  const shifted = appendEvidence(body, { ...PAYLOAD, causal: { ...PAYLOAD.causal, line: 131 } }, "LeeHyeonKyu/know-thy-build-demo#39");
  expect(shifted).toBe(body);
  // 같은 이슈라도 라운드가 다르면 새 목격이다.
  expect(evidenceEntries(appendEvidence(body, { ...PAYLOAD, round: 3 }, "LeeHyeonKyu/know-thy-build-demo#39")).length).toBe(2);
});

test("payload가 비어도 render는 마커와 사람이 읽는 골격을 낸다(증거가 얇은 소견도 버리지 않는다)", () => {
  const { body, labels } = renderUpstreamIssue({ fingerprint: "f1", tags: ["ambiguous"], payload: {}, sourceRepo: "o/r", sourceIssue: 7 });
  expect(labels).toEqual(["factory-improvement", "backlog"]);
  expect(body.split("\n")[0]).toBe("<!-- factory-improvement fp=f1 tags=ambiguous from=o/r#7 -->");
  expect(parseUpstreamIssue(body)).toMatchObject({ fingerprint: "f1", tags: ["ambiguous"], from: "o/r#7", payload: {} });
});
