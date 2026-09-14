import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseTranscriptLines, emptyFold, toolLabel, readProgress, progressMarker,
  parseProgressMarker, PROGRESS_MARKER_RE, AGENT_CAP, FILES_CAP,
} from "../lib/progress.js";
import { costFromUsage, modelPrice } from "../lib/usage.js";

/**
 * 트랜스크립트 픽스처는 **전부 여기서 손으로 짓는다**(합성 모양). 진짜 세션 JSONL을 저장소에 복사하면
 * 그 안의 프롬프트·파일 내용·비밀이 그대로 커밋된다 — 모양만 필요하고 내용은 필요 없다.
 * 모양의 근거: `~/.claude/projects/<슬러그>/<session_id>.jsonl` 실측(2026-09-14) — assistant 줄은
 * `{type:"assistant", timestamp, message:{model, usage:{input_tokens,cache_creation_input_tokens,
 * cache_read_input_tokens,output_tokens}, content:[{type:"thinking"|"text"|"tool_use"}]}}`이다.
 */
const asst = (o) => JSON.stringify({
  type: "assistant",
  timestamp: o.at,
  message: {
    model: o.model || "claude-opus-4-6",
    usage: { input_tokens: o.in ?? 0, output_tokens: o.out ?? 0, cache_read_input_tokens: o.cr ?? 0, cache_creation_input_tokens: o.cc ?? 0 },
    content: o.content || [{ type: "text", text: o.text ?? "hello" }],
  },
});
const toolUse = (name, input) => ({ type: "tool_use", id: `t${name}`, name, input });

// ── parseTranscriptLines ────────────────────────────────────────────────────

test("usage accumulates across turns; started/ended bracket the fold", () => {
  const f = parseTranscriptLines([
    asst({ at: "2026-09-14T10:00:00Z", in: 10, out: 5, cr: 1000, cc: 200 }),
    asst({ at: "2026-09-14T10:01:00Z", in: 20, out: 7, cr: 3000 }),
  ]);
  expect(f.turns).toBe(2);
  expect(f.input_tokens).toBe(30);
  expect(f.output_tokens).toBe(12);
  expect(f.cache_read_tokens).toBe(4000);
  expect(f.cache_creation_tokens).toBe(200);
  expect(f.started).toBe("2026-09-14T10:00:00Z");
  expect(f.ended).toBe("2026-09-14T10:01:00Z");
});

test("folding is incremental — feeding two halves equals feeding the whole", () => {
  const a = asst({ at: "2026-09-14T10:00:00Z", in: 10, out: 5 });
  const b = asst({ at: "2026-09-14T10:01:00Z", in: 20, out: 7 });
  const whole = parseTranscriptLines([a, b]);
  const halves = parseTranscriptLines([b], parseTranscriptLines([a]));
  expect(halves).toEqual(whole);
});

test("junk, blank, user and system lines never break the fold and never add turns", () => {
  const f = parseTranscriptLines([
    "not json",
    "",
    JSON.stringify({ type: "system", timestamp: "2026-09-14T10:00:30Z", subtype: "hook" }),
    JSON.stringify({ type: "progress", timestamp: "2026-09-14T10:00:40Z" }),
    JSON.stringify({ type: "user", timestamp: "2026-09-14T10:00:50Z", message: { content: [{ type: "tool_result", tool_use_id: "tRead", content: "AWS_SECRET_ACCESS_KEY=hunter2" }] } }),
    asst({ at: "2026-09-14T10:01:00Z", in: 1, out: 1 }),
  ]);
  expect(f.turns).toBe(1);
  // 결과 텍스트는 **어느 필드로도** 새어 나오지 않는다 — tool_result는 읽지도 않는다.
  expect(JSON.stringify(f)).not.toContain("hunter2");
  expect(f.ended).toBe("2026-09-14T10:01:00Z");    // user/system 줄도 "마지막 활동" 시각은 갱신한다
});

test("cost uses the per-model list price table in usage.js (input+output+cache read+cache write)", () => {
  const f = parseTranscriptLines([asst({ at: "2026-09-14T10:00:00Z", model: "claude-opus-4-6", in: 1e6, out: 1e6, cr: 1e6, cc: 1e6 })]);
  const p = modelPrice("claude-opus-4-6");
  expect(p.input).toBe(5);
  expect(p.output).toBe(25);
  // 5(input) + 25(output) + 0.5(cache read = 0.1×) + 6.25(cache write = 1.25×)
  expect(f.cost_usd).toBeCloseTo(36.75, 6);
  expect(f.cost_usd).toBeCloseTo(costFromUsage({ model: "claude-opus-4-6", input_tokens: 1e6, output_tokens: 1e6, cache_read_tokens: 1e6, cache_creation_tokens: 1e6 }), 9);
});

test("an unknown model costs nothing rather than guessing a price", () => {
  expect(modelPrice("some-model-we-have-never-seen")).toBe(null);
  const f = parseTranscriptLines([asst({ at: "2026-09-14T10:00:00Z", model: "some-model-we-have-never-seen", in: 1e6, out: 1e6 })]);
  expect(f.cost_usd).toBe(0);
});

// ── last_tool ───────────────────────────────────────────────────────────────

test("last_tool is '<Tool> <short arg>' — path, or the first 60 chars of a command", () => {
  expect(toolLabel(toolUse("Read", { file_path: "factory/cli/status.js" }))).toBe("Read factory/cli/status.js");
  expect(toolLabel(toolUse("Bash", { command: "x".repeat(200), description: "d" }))).toBe(`Bash ${"x".repeat(60)}…`);
  expect(toolLabel(toolUse("Grep", { pattern: "startHeartbeat" }))).toBe("Grep startHeartbeat");
  expect(toolLabel(toolUse("Workflow", {}))).toBe("Workflow");          // 인자를 못 고르면 이름만
});

test("last_tool is the most recent tool_use; a turn with no tool_use keeps the previous one", () => {
  const f = parseTranscriptLines([
    asst({ at: "2026-09-14T10:00:00Z", content: [toolUse("Read", { file_path: "a.js" })] }),
    asst({ at: "2026-09-14T10:01:00Z", content: [toolUse("Read", { file_path: "b.js" }), toolUse("Bash", { command: "npm test" })] }),
    asst({ at: "2026-09-14T10:02:00Z", content: [{ type: "text", text: "done" }] }),
  ]);
  expect(f.last_tool).toBe("Bash npm test");                            // 같은 턴 안에서는 마지막 블록이 이긴다
});

test("last_tool never carries tool RESULT text — only the tool_use input", () => {
  const f = parseTranscriptLines([
    asst({ at: "2026-09-14T10:00:00Z", content: [toolUse("Read", { file_path: ".env" })] }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tRead", content: "OPENAI_API_KEY=sk-do-not-leak" }] } }),
  ]);
  expect(f.last_tool).toBe("Read .env");
  expect(JSON.stringify(f)).not.toContain("sk-do-not-leak");
});

// ── files_touched ───────────────────────────────────────────────────────────

test("files_touched comes from Edit/Write/MultiEdit/NotebookEdit inputs, deduped and capped", () => {
  const f = parseTranscriptLines([
    asst({ at: "2026-09-14T10:00:00Z", content: [toolUse("Edit", { file_path: "a.js" }), toolUse("Read", { file_path: "never.js" })] }),
    asst({ at: "2026-09-14T10:01:00Z", content: [toolUse("Write", { file_path: "b.js" }), toolUse("Edit", { file_path: "a.js" })] }),
    asst({ at: "2026-09-14T10:02:00Z", content: [toolUse("MultiEdit", { file_path: "c.js" }), toolUse("NotebookEdit", { notebook_path: "d.ipynb" })] }),
  ]);
  expect(f.files_touched).toEqual(["a.js", "b.js", "c.js", "d.ipynb"]);  // Read는 "touched"가 아니다
});

test(`files_touched is capped at ${FILES_CAP}`, () => {
  const lines = [];
  for (let i = 0; i < FILES_CAP + 15; i++) lines.push(asst({ at: "2026-09-14T10:00:00Z", content: [toolUse("Edit", { file_path: `f${i}.js` })] }));
  expect(parseTranscriptLines(lines).files_touched).toHaveLength(FILES_CAP);
});

// ── readProgress ────────────────────────────────────────────────────────────

/** agents.jsonl + 트랜스크립트 파일들을 실제로 만든 임시 저장소. 훅이 쓰는 모양 그대로. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "prog-"));
  mkdirSync(join(root, ".factory/out"), { recursive: true });
  const agents = join(root, ".factory/out/agents.jsonl");
  const main = join(root, "main.jsonl");
  const write = (p, lines) => writeFileSync(p, lines.join("\n") + "\n");
  const append = (p, lines) => appendFileSync(p, lines.join("\n") + "\n");
  const hook = (o) => append(agents, [JSON.stringify(o)]);
  return { root, agents, main, write, append, hook, state: new Map() };
}

test("readProgress: orchestrator + subagents, statuses from SubagentStart/Stop", () => {
  const f = fixture();
  const subA = join(f.root, "a.jsonl"), subB = join(f.root, "b.jsonl");
  f.write(f.main, [asst({ at: "2026-09-14T10:00:00Z", in: 100, out: 20, content: [toolUse("Workflow", { name: "factory-review" })] })]);
  f.hook({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "reviewer-correctness", description: "R1:correctness", transcript_path: f.main, agent_transcript_path: subA });
  f.hook({ hook_event_name: "SubagentStart", agent_id: "a2", agent_type: "reviewer-architecture", description: "R1:architecture", transcript_path: f.main, agent_transcript_path: subB });
  f.hook({ hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "reviewer-correctness", agent_transcript_path: subA });
  f.write(subA, [asst({ at: "2026-09-14T10:01:00Z", in: 12100, out: 1900, content: [toolUse("Read", { file_path: "x.js" })] })]);
  f.write(subB, [asst({ at: "2026-09-14T10:02:00Z", in: 8000, out: 600, content: [toolUse("Read", { file_path: "factory/cli/status.js" })] })]);

  const p = readProgress({ root: f.root, stage: "review", issue: 7, runner: "gha-1", started: "2026-09-14T09:59:00Z", now: () => "2026-09-14T10:03:00Z", state: f.state });

  expect(p.stage).toBe("review");
  expect(p.issue).toBe(7);
  expect(p.runner).toBe("gha-1");
  expect(p.started).toBe("2026-09-14T09:59:00Z");
  expect(p.updated).toBe("2026-09-14T10:03:00Z");
  expect(p.agents.map((a) => [a.label, a.kind, a.status])).toEqual([
    ["review", "orchestrator", "running"],
    ["R1:correctness", "subagent", "done"],
    ["R1:architecture", "subagent", "running"],
  ]);
  expect(p.agents[1].ended).toBe("2026-09-14T10:01:00Z");
  expect(p.agents[2].last_tool).toBe("Read factory/cli/status.js");
  expect(p.totals.input_tokens).toBe(100 + 12100 + 8000);
  expect(p.totals.output_tokens).toBe(20 + 1900 + 600);
  expect(p.totals.turns).toBe(3);
  // step은 지금 도는 서브에이전트에서 나온다 — phase는 라벨의 `:` 앞부분
  expect(p.step).toEqual({ phase: "R1", label: "R1:architecture", since: "2026-09-14T10:02:00Z" });
});

test("readProgress: a started agent whose transcript has no activity yet is 'waiting'", () => {
  const f = fixture();
  f.write(f.main, [asst({ at: "2026-09-14T10:00:00Z", in: 5, out: 1 })]);
  f.hook({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "reviewer-qa", description: "R1:qa", transcript_path: f.main, agent_transcript_path: join(f.root, "missing.jsonl") });
  const p = readProgress({ root: f.root, stage: "review", now: () => "T", state: f.state });
  expect(p.agents[1]).toMatchObject({ label: "R1:qa", status: "waiting", turns: 0, input_tokens: 0 });
  expect(p.step.label).toBe("R1:qa");
});

test("readProgress tails: a second read only folds the bytes appended since the first", () => {
  const f = fixture();
  f.write(f.main, [asst({ at: "2026-09-14T10:00:00Z", in: 100, out: 10 })]);
  const args = { root: f.root, stage: "plan", now: () => "T", state: f.state, mainTranscript: f.main };
  expect(readProgress(args).totals.input_tokens).toBe(100);
  f.append(f.main, [asst({ at: "2026-09-14T10:01:00Z", in: 50, out: 5 })]);
  const p2 = readProgress(args);
  expect(p2.totals.input_tokens).toBe(150);                             // 200이면 처음부터 다시 접은 것이다
  expect(p2.totals.turns).toBe(2);
});

test("readProgress tails: a half-written last line is held back until its newline arrives", () => {
  const f = fixture();
  const line = asst({ at: "2026-09-14T10:00:00Z", in: 100, out: 10 });
  writeFileSync(f.main, line.slice(0, 40));                             // JSON 한 줄의 앞토막만 도착
  const args = { root: f.root, stage: "plan", now: () => "T", state: f.state, mainTranscript: f.main };
  expect(readProgress(args).totals.turns).toBe(0);
  writeFileSync(f.main, line + "\n");
  expect(readProgress(args).totals.turns).toBe(1);
});

test("readProgress: missing agents.jsonl and missing transcripts degrade to an empty-but-shaped object", () => {
  const root = mkdtempSync(join(tmpdir(), "prog-empty-"));
  const p = readProgress({ root, stage: "triage", issue: 3, runner: "r", now: () => "T", state: new Map() });
  expect(p).toMatchObject({ stage: "triage", issue: 3, runner: "r", updated: "T", agents: [], files_touched: [] });
  expect(p.totals).toEqual({ turns: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0 });
  expect(p.step).toEqual({ phase: null, label: null, since: null });
});

test(`readProgress caps the agent list at ${AGENT_CAP} and keeps the orchestrator`, () => {
  const f = fixture();
  f.write(f.main, [asst({ at: "2026-09-14T10:00:00Z", in: 1, out: 1 })]);
  for (let i = 0; i < AGENT_CAP + 10; i++) {
    const sub = join(f.root, `s${i}.jsonl`);
    f.write(sub, [asst({ at: `2026-09-14T${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`, in: 1, out: 1 })]);
    f.hook({ hook_event_name: "SubagentStart", agent_id: `a${i}`, agent_type: "r", description: `R1:role${i}`, transcript_path: f.main, agent_transcript_path: sub });
  }
  const p = readProgress({ root: f.root, stage: "review", now: () => "T", state: f.state });
  expect(p.agents).toHaveLength(AGENT_CAP);
  expect(p.agents[0].kind).toBe("orchestrator");
  expect(p.truncated_agents).toBe(11);                                  // AGENT_CAP+10 서브 + 오케스트레이터 − AGENT_CAP
  // 잘린 에이전트의 토큰도 totals에는 남는다 — 표가 짧아질 뿐 합계는 거짓말하지 않는다
  expect(p.totals.turns).toBe(AGENT_CAP + 11);
});

test("readProgress falls back to agent_type when the hook payload carries no label", () => {
  const f = fixture();
  f.write(f.main, [asst({ at: "2026-09-14T10:00:00Z", in: 1, out: 1 })]);
  const sub = join(f.root, "s.jsonl");
  f.write(sub, [asst({ at: "2026-09-14T10:01:00Z", in: 1, out: 1 })]);
  // 실측된 훅 페이로드 그대로 — `agent_id`도 `description`도 `transcript_path`도 없다
  f.hook({ hook_event_name: "SubagentStop", agent_type: "reviewer-doctor", agent_transcript_path: sub });
  const p = readProgress({ root: f.root, stage: "review", now: () => "T", state: f.state, mainTranscript: f.main });
  expect(p.agents[1]).toMatchObject({ label: "reviewer-doctor", kind: "subagent", status: "done" });
  expect(p.step.phase).toBe(null);                                      // `:`가 없는 라벨은 phase를 지어내지 않는다
});

// ── the marker (the machine contract Task B reads) ──────────────────────────

test("progressMarker round-trips through parseProgressMarker and is a single line", () => {
  const p = { stage: "review", issue: 7, runner: "gha-1", started: "S", updated: "U", step: { phase: "R1", label: "R1:qa", since: "S" }, agents: [], totals: { turns: 1, input_tokens: 2, output_tokens: 3, cache_read_tokens: 4, cost_usd: 0.5 }, files_touched: [] };
  const m = progressMarker(p);
  expect(m.split("\n")).toHaveLength(1);
  expect(m).toMatch(PROGRESS_MARKER_RE);
  expect(parseProgressMarker(`prefix\n${m}\nsuffix`)).toEqual(p);
  expect(parseProgressMarker("nothing here")).toBe(null);
});

test("progressMarker sheds files_touched, then agents, to stay under the byte budget", () => {
  const agents = Array.from({ length: 40 }, (_, i) => ({ label: `R1:role${i}`, kind: "subagent", status: "done", started: "S", ended: "E", last_tool: "Read " + "p".repeat(200), turns: 3, input_tokens: 1, output_tokens: 1, cache_read_tokens: 1, cost_usd: 0 }));
  const p = { stage: "review", issue: 7, runner: "r", started: "S", updated: "U", step: { phase: "R1", label: null, since: null }, agents, totals: { turns: 1, input_tokens: 1, output_tokens: 1, cache_read_tokens: 1, cost_usd: 0 }, files_touched: Array.from({ length: 30 }, (_, i) => "x".repeat(300) + i) };
  const m = progressMarker(p, { maxBytes: 2000 });
  expect(Buffer.byteLength(m, "utf8")).toBeLessThanOrEqual(2000);
  const back = parseProgressMarker(m);
  expect(back.totals).toEqual(p.totals);                                // 합계는 절대 버리지 않는다
  expect(back.files_touched).toEqual([]);
  expect(back.agents.length).toBeLessThan(40);
});
