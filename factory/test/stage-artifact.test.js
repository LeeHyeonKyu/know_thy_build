import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractStageArtifact, workflowResultsFromTranscript, taskNotificationsFromTranscript, fileReadsFromTranscript, isWorkflowReceipt, stripLineNumbers, fencedJsonError, transcriptPathFrom, readTranscript } from "../lib/stage-artifact.js";
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
  // 출처 이름은 KTB-17에서 바뀌었다 — 같은 텍스트를 더 앞선 후보(모든 tool_result를 훑는 팔)가
  // 먼저 집는다. 중요한 건 봉투가 아니라 **트랜스크립트**에서 복구했다는 것이다.
  expect(r.source).toMatch(/^transcript /);
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

// ── KTB-17: 백그라운드 Workflow의 반환값은 tool_result에 없다 ──────────────────────────────────

const RECEIPT = "Workflow launched in background. Task ID: w6xdqhynw\nSummary: Issue plan via a role debate\nTranscript dir: /home/runner/.claude/…/subagents/workflows/wf_bfbb171a-4b3\nYou will be notified when it completes.";

/** 접수증 + `<task-notification>` + 줄 번호가 붙은 Read 조각들 — 실제 러너가 남기는 모양. */
function bgTranscript({ notificationResult = null, status = "completed", fileChunks = null, file = "/tmp/tasks/w6xdqhynw.output" } = {}) {
  const lines = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Workflow", id: "toolu_wf", input: { name: "factory-plan" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_wf", content: RECEIPT }] } }),
  ];
  if (notificationResult != null) {
    lines.push(JSON.stringify({ type: "user", message: { content: `<task-notification>\n<task-id>w6xdqhynw</task-id>\n<output-file>${file}</output-file>\n<status>${status}</status>\n<result>${notificationResult}</result>\n</task-notification>` } }));
  }
  (fileChunks || []).forEach(([from, text], i) => {
    const id = `toolu_read_${i}`;
    lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", id, input: { file_path: file, offset: from } }] } }));
    const numbered = text.split("\n").map((t, j) => `${from + j}\t${t}`).join("\n");
    lines.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: numbered }] } }));
  });
  return lines.join("\n") + "\n";
}

test("the Workflow tool_result is recognised as a background receipt, never as a return value", () => {
  expect(isWorkflowReceipt(RECEIPT)).toBe(true);
  expect(isWorkflowReceipt('{"schema":"factory.plan.v1"}')).toBe(false);
  expect(stripLineNumbers("1\t{\n2\t  \"a\": 1\n3\t}")).toBe('{\n  "a": 1\n}');
});

test("the completed task-notification's <result> wins when it is not truncated", () => {
  const r = extractStageArtifact({
    envelopeResult: "I ran out of turns before I could print the plan.",
    transcriptText: bgTranscript({ notificationResult: JSON.stringify(plan) }),
    validate: planValidate,
  });
  expect(r.ok).toBe(true);
  expect(r.source).toMatch(/task-notification/);
  expect(r.data.issue).toBe(2);
});

test("a notification that did not complete is not a candidate", () => {
  const r = extractStageArtifact({
    envelopeResult: "",
    transcriptText: bgTranscript({ notificationResult: JSON.stringify(plan), status: "failed" }),
    validate: planValidate,
  });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/no completed <task-notification> block/);
});

/**
 * 실제 런에서 알림의 `<result>`는 잘린다(45 KB → 8 KB). 그때 유일하게 남은 온전한 출처는
 * 디스패처가 `Read`로 읽은 output 파일인데, 그것도 **조각**으로 온다 — 어느 조각도 단독으로는
 * 유효한 JSON이 아니다. 줄 번호를 키로 다시 붙여야 비로소 산출물이 나온다.
 */
test("chunked Read results are reassembled by line number, and the {summary,agentCount,logs,result} envelope is unwrapped one level", () => {
  const body = JSON.stringify({ summary: "workflow summary", agentCount: 14, logs: [], result: plan }, null, 2).split("\n");
  const r = extractStageArtifact({
    envelopeResult: "",
    transcriptText: bgTranscript({
      notificationResult: JSON.stringify(plan).slice(0, 300) + "\n... (truncated 36707 chars)",
      fileChunks: [[1, body.slice(0, 20).join("\n")], [21, body.slice(20).join("\n")]],
    }),
    validate: planValidate,
  });
  expect(r.ok).toBe(true);
  expect(r.source).toMatch(/file read .*\.output \(\.result\)/);
  expect(r.data.issue).toBe(2);
});

test("a receipt-only transcript falls through and says so — not 'no JSON object in result'", () => {
  const r = extractStageArtifact({ envelopeResult: "boom", transcriptText: bgTranscript({}), validate: planValidate });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/background receipt, not a return value/);
  expect(r.reason).toMatch(/no completed <task-notification> block/);
});

/**
 * 데모 #2 plan 재실행(run 34700674634)의 실제 트랜스크립트를 다듬은 것 — 구조는 그대로이고
 * 토론 산문만 줄였다. envelope은 `is_error: true` · `terminal_reason: max_turns`였지만
 * **계획은 트랜스크립트 안에 있었다**. 이 픽스처가 초록이 아니면 KTB-17은 고쳐지지 않은 것이다.
 */
const FIXTURE = readFileSync(fileURLToPath(new URL("./fixtures/plan-max-turns.jsonl", import.meta.url)), "utf8");

test("the real demo #2 transcript (max_turns) yields the plan — the notification is truncated, the reassembled file read wins", () => {
  expect(FIXTURE.split("\n").filter(Boolean)).toHaveLength(11);
  const notes = taskNotificationsFromTranscript(FIXTURE);
  expect(notes).toHaveLength(1);
  expect(notes[0].status).toBe("completed");
  expect(() => JSON.parse(notes[0].result)).toThrow();            // 잘려 있다 — 그래서 이 후보만으로는 부족하다
  expect([...fileReadsFromTranscript(FIXTURE).values()][0]).toMatch(/^\{/);
  expect(workflowResultsFromTranscript(FIXTURE).every(isWorkflowReceipt)).toBe(true);

  const r = extractStageArtifact({ envelopeResult: undefined, transcriptText: FIXTURE, validate: planValidate });
  expect(r.ok).toBe(true);
  expect(r.source).toMatch(/file read/);
  expect(r.data.issue).toBe(2);
  expect(r.data.rounds).toBe(3);
  expect(r.data.orchestration).toBe("workflow");
  expect(r.data.done_when.length).toBeGreaterThan(0);
  expect(planValidate(r.data).ok).toBe(true);
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
