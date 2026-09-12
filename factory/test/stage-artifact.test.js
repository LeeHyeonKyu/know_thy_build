import { test, expect } from "vitest";
import { extractStageArtifact, workflowResultsFromTranscript, fencedJsonError, transcriptPathFrom, readTranscript } from "../lib/stage-artifact.js";
import { validate } from "../lib/schemas.js";

const planValidate = (o) => validate("plan.v1", o);

const plan = {
  schema: "factory.plan.v1", issue: 2, tier: "standard", roles: ["product-advocate", "architect", "skeptic", "operator"],
  rounds: 3, orchestration: "workflow", guarantee: "structural",
  done_when: [{ id: "dw1", text: "201 + persisted id", verify: "integration test", level: "integration" }],
  files_expected: ["src/routes/notes.js"], dissent_log: [], non_goals: ["no migration runner"], open_risks: [],
};

/** 러너에서 실제로 쓰이는 모양: assistant의 tool_use → user의 tool_result(문자열 또는 text 블록 배열). */
function transcript(resultTexts, { arrayContent = false } = {}) {
  const lines = [];
  resultTexts.forEach((text, i) => {
    const id = `toolu_${i}`;
    lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Workflow", id, input: { name: "factory-plan" } }] } }));
    lines.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: arrayContent ? [{ type: "text", text }] : text }] } }));
  });
  lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }));
  return lines.join("\n") + "\n";
}

test("workflowResultsFromTranscript reads Workflow tool results in call order, string or text-block content", () => {
  expect(workflowResultsFromTranscript(transcript(["first", "second"]))).toEqual(["first", "second"]);
  expect(workflowResultsFromTranscript(transcript(["only"], { arrayContent: true }))).toEqual(["only"]);
  expect(workflowResultsFromTranscript("")).toEqual([]);
  expect(workflowResultsFromTranscript("not json\n{broken")).toEqual([]);
});

/**
 * KTB-7의 본체: 디스패처가 20 KB짜리 workflow 결과를 요약해 ```json 펜스를 깨뜨려도,
 * 트랜스크립트에 남은 **원본** Workflow 결과에서 계획을 복구한다.
 */
test("recovers the plan from the transcript when the dispatcher summarized it into invalid JSON", () => {
  const summarized = '```json\n{\n  "issue": 2,\n  "dissent_log": [ /* full R1 positions */ ],\n  "done_when": [{"id":"dw1","text":"t","verify":"unit","level":"fast"}]\n}\n```\n\nNote: I truncated the payload.';
  const r = extractStageArtifact({
    envelopeResult: summarized,
    transcriptText: transcript(["The workflow returned:\n```json\n" + JSON.stringify(plan) + "\n```"]),
    validate: planValidate,
  });
  expect(r.ok).toBe(true);
  expect(r.source).toMatch(/transcript Workflow result/);
  expect(r.data.done_when).toHaveLength(1);
  expect(r.data.rounds).toBe(3);
});

test("uses the LAST Workflow call when the session made several", () => {
  const stale = { ...plan, issue: 1 };
  const r = extractStageArtifact({
    envelopeResult: "no json here",
    transcriptText: transcript([JSON.stringify(stale), JSON.stringify(plan)]),
    validate: planValidate,
  });
  expect(r.ok).toBe(true);
  expect(r.data.issue).toBe(2);
});

test("falls back to the envelope fence, then bare JSON, when no transcript is available", () => {
  const fenced = extractStageArtifact({ envelopeResult: "here:\n```json\n" + JSON.stringify(plan) + "\n```", transcriptText: "", validate: planValidate });
  expect(fenced.ok).toBe(true);
  expect(fenced.source).toBe("result ```json fence");

  const bare = extractStageArtifact({ envelopeResult: "prefix " + JSON.stringify(plan) + " suffix", transcriptText: null, validate: planValidate });
  expect(bare.ok).toBe(true);
  expect(bare.source).toBe("result bare JSON");
});

/**
 * 파싱만 되는 후보는 이기지 못한다 — 계획 안의 done_when 한 항목이 "파싱은 된다"는 이유로
 * 뽑히던 것이 "issue is required; tier is required; …" 오진의 원인이었다.
 */
test("a nested object that merely parses never wins over the schema", () => {
  const brokenTop = '```json\n{ "done_when": [ /* … */ {"id":"dw1","text":"t","verify":"unit","level":"fast"} ] }\n```';
  const r = extractStageArtifact({ envelopeResult: brokenTop, transcriptText: "", validate: planValidate });
  expect(r.ok).toBe(false);
  expect(r.data).toBe(null);
  expect(r.reason).toMatch(/fence is not valid JSON/);
});

test("reason lists what each candidate failed on, not just the last schema cascade", () => {
  const r = extractStageArtifact({ envelopeResult: "nothing structured here", transcriptText: "", validate: planValidate });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/no Workflow tool result found/);
  expect(r.reason).toMatch(/no JSON object in result/);
});

/** 데모 러너의 실제 agents.jsonl 한 줄(경로·세션 id는 run 34691260727의 값). */
const AGENTS_LINE = JSON.stringify({
  session_id: "7d5d1d17-6df2-46b3-9c2d-f91379d2b2bd",
  transcript_path: "/home/runner/.claude/projects/-home-runner-work-know-thy-build-demo-know-thy-build-demo/7d5d1d17-6df2-46b3-9c2d-f91379d2b2bd.jsonl",
  cwd: "/home/runner/work/know-thy-build-demo/know-thy-build-demo",
  agent_type: "factory-loader", hook_event_name: "SubagentStart",
});

test("transcriptPathFrom prefers the hook-recorded path, else computes the project slug", () => {
  expect(transcriptPathFrom({ agentsLogText: AGENTS_LINE, sessionId: "7d5d1d17-6df2-46b3-9c2d-f91379d2b2bd" }))
    .toBe("/home/runner/.claude/projects/-home-runner-work-know-thy-build-demo-know-thy-build-demo/7d5d1d17-6df2-46b3-9c2d-f91379d2b2bd.jsonl");
  // 다른 세션의 훅 기록은 쓰지 않는다 — 계산 경로로 내려간다.
  expect(transcriptPathFrom({ agentsLogText: AGENTS_LINE, sessionId: "other", cwd: "/home/runner/work/know-thy-build-demo/know-thy-build-demo", home: "/home/runner" }))
    .toBe("/home/runner/.claude/projects/-home-runner-work-know-thy-build-demo-know-thy-build-demo/other.jsonl");
  expect(transcriptPathFrom({ agentsLogText: "", sessionId: null, cwd: "/x", home: "/h" })).toBe(null);
  expect(transcriptPathFrom({ agentsLogText: "garbage\n{broken", sessionId: "s", cwd: "/a.b/c", home: "/h" }))
    .toBe("/h/.claude/projects/-a-b-c/s.jsonl");
});

test("fencedJsonError reports the parse error only when a fence exists and is broken", () => {
  expect(fencedJsonError("```json\n{\"a\":1}\n```")).toBe(null);
  expect(fencedJsonError("no fence")).toBe(null);
  expect(fencedJsonError("```json\n{not json}\n```")).toMatch(/./);
});

// ── readTranscript — run-stage·retro·verify-stage CLI가 공유하는 경로 계산 ──
// 셋이 각자 계산을 갖고 있으면 "트랜스크립트가 1순위 출처"라는 계약이 한쪽만 고쳐지는 순간 갈라진다.
// `readFile(path) → string|null`은 주입된다 — 이 모듈은 node:fs를 import하지 않는다.

const fs = (files) => (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null);

test("readTranscript: session_id가 없고 훅 기록도 없으면 null — 추측해서 아무 파일이나 읽지 않는다", () => {
  expect(readTranscript({ root: "/repo", home: "/h", sessionId: undefined, readFile: fs({}) })).toBe(null);
  expect(readTranscript({ root: "/repo", home: "/h", sessionId: null, readFile: fs({ "/repo/.factory/out/agents.jsonl": "" }) })).toBe(null);
});

test("readTranscript: agents.jsonl이 없으면 cwd 슬러그로 경로를 계산한다", () => {
  const path = "/h/.claude/projects/-repo-work/s1.jsonl";
  expect(readTranscript({ root: "/repo/work", home: "/h", sessionId: "s1", readFile: fs({ [path]: "LINE" }) })).toBe("LINE");
});

test("readTranscript: 훅이 적어 둔 transcript_path가 계산보다 우선한다", () => {
  const hooked = "/var/hooked/abc.jsonl";
  const files = {
    "/repo/.factory/out/agents.jsonl": JSON.stringify({ session_id: "s1", transcript_path: hooked }),
    [hooked]: "HOOKED",
    "/h/.claude/projects/-repo/s1.jsonl": "COMPUTED",
  };
  expect(readTranscript({ root: "/repo", home: "/h", sessionId: "s1", readFile: fs(files) })).toBe("HOOKED");
});

test("readTranscript: 경로는 나왔는데 못 읽으면 null(빈 문자열이 아니다) — 호출자가 '없음'으로 다룬다", () => {
  expect(readTranscript({ root: "/repo", home: "/h", sessionId: "s1", readFile: fs({}) })).toBe(null);
});

test("readTranscript: readFile이 던져도 null — 트랜스크립트 읽기 실패가 스테이지를 죽이지 않는다", () => {
  expect(readTranscript({ root: "/repo", home: "/h", sessionId: "s1", readFile: () => { throw new Error("EACCES"); } })).toBe(null);
});
