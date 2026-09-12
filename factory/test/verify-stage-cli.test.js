import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, verifyStageCli, USAGE } from "../bin/verify-stage.js";

/**
 * `bin/verify-stage.js`는 사람이 `.factory/out/`에 남은 파일로 CI 판정을 재현하는 진단 CLI다.
 * KTB-7 이후 산출물의 1순위 출처는 세션 트랜스크립트이므로, 트랜스크립트를 넘기지 않으면 이 CLI는
 * **CI와 다른 답**을 낸다 — 디스패처가 요약해 버린 봉투만 보고 "산출물 없음"이라 말한다.
 */

const TRIAGE = { schema: "factory.triage.v1", issue: 7, disposition: "ready", tier: "standard", reason: "done_when is concrete", summary: "add CSV export", orchestration: "workflow", guarantee: "structural" };
/** 디스패처가 요약해 버린 봉투 — 펜스 안에 JS 주석이 섞여 JSON.parse 자체가 실패한다(데모 #2의 모양). */
const SUMMARIZED = '결과입니다.\n```json\n{ "disposition": "ready", /* 나머지 생략 */ }\n```\n';
const transcriptOf = (obj) => [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Workflow", id: "tu1" }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: JSON.stringify(obj) }] } }),
].join("\n") + "\n";

function makeRoot({ envelope, stageJson, agentsLog } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vs-cli-"));
  mkdirSync(join(root, ".factory/out"), { recursive: true });
  writeFileSync(join(root, ".factory/out/context.json"), JSON.stringify({ roster: [], orchestration: "workflow" }));
  if (stageJson !== undefined) writeFileSync(join(root, ".factory/out/triage.json"), stageJson);
  if (envelope !== undefined) writeFileSync(join(root, ".factory/out/triage.envelope.json"), envelope);
  if (agentsLog !== undefined) writeFileSync(join(root, ".factory/out/agents.jsonl"), agentsLog);
  return root;
}

test("parseArgs pulls --transcript out of the positional arguments, in both spellings", () => {
  expect(parseArgs(["triage", "7"])).toEqual({ stage: "triage", issue: 7, transcript: null });
  expect(parseArgs(["triage", "7", "--transcript", "/t/a.jsonl"])).toEqual({ stage: "triage", issue: 7, transcript: "/t/a.jsonl" });
  expect(parseArgs(["--transcript=/t/b.jsonl", "triage", "7"])).toEqual({ stage: "triage", issue: 7, transcript: "/t/b.jsonl" });
});

test("a missing stage or issue is usage, not a verdict", () => {
  const root = makeRoot({ stageJson: "{}" });
  expect(verifyStageCli({ root, argv: [] })).toMatchObject({ ok: false, usage: true, reasons: [USAGE] });
  expect(verifyStageCli({ root, argv: ["triage", "zero"] })).toMatchObject({ usage: true });
});

test("--transcript rescues a summarized envelope — the same files without it fail", () => {
  const root = makeRoot({ stageJson: JSON.stringify({ is_error: false, result: SUMMARIZED }) });
  const tPath = join(root, "session.jsonl");
  writeFileSync(tPath, transcriptOf(TRIAGE));

  const without = verifyStageCli({ root, argv: ["triage", "7"], home: root });
  expect(without.ok).toBe(false);
  expect(without.transcript).toMatch(/no session_id/);

  const with_ = verifyStageCli({ root, argv: ["triage", "7", "--transcript", tPath], home: root });
  expect(with_.ok).toBe(true);
  expect(with_.reasons).toEqual([]);
  expect(with_.transcript).toBe(tPath);
});

test("with no --transcript the envelope's session_id locates the transcript under home", () => {
  const root = makeRoot({
    stageJson: JSON.stringify(TRIAGE),                                  // KTB-7 이후 <stage>.json은 산출물로 덮인다
    envelope: JSON.stringify({ is_error: false, session_id: "sess-1", result: SUMMARIZED }),
  });
  const home = mkdtempSync(join(tmpdir(), "vs-home-"));
  const slug = root.replace(/[^a-zA-Z0-9]/g, "-");
  mkdirSync(join(home, ".claude/projects", slug), { recursive: true });
  writeFileSync(join(home, ".claude/projects", slug, "sess-1.jsonl"), transcriptOf(TRIAGE));

  const r = verifyStageCli({ root, argv: ["triage", "7"], home });
  expect(r.ok).toBe(true);
  expect(r.transcript).toBe("auto (session sess-1)");
});

test("a session_id whose transcript is gone says so instead of pretending it had one", () => {
  const root = makeRoot({
    stageJson: JSON.stringify({ is_error: false, result: SUMMARIZED }),
    envelope: JSON.stringify({ session_id: "sess-missing", result: SUMMARIZED }),
  });
  const r = verifyStageCli({ root, argv: ["triage", "7"], home: mkdtempSync(join(tmpdir(), "vs-home-")) });
  expect(r.ok).toBe(false);
  expect(r.transcript).toBe("auto (session sess-missing) — not found");
});

test("an unreadable --transcript path is reported, and the verdict falls back to the envelope", () => {
  const root = makeRoot({ stageJson: JSON.stringify({ is_error: false, result: JSON.stringify(TRIAGE) }) });
  const r = verifyStageCli({ root, argv: ["triage", "7", "--transcript", join(root, "nope.jsonl")], home: root });
  expect(r.transcript).toMatch(/nope\.jsonl \(unreadable\)/);
  expect(r.ok).toBe(true);                                              // 봉투의 맨 JSON이 그대로 스키마를 통과한다
});

test("no .factory/out/<stage>.json at all is a verdict (is_error), never a crash", () => {
  const root = makeRoot({});
  const r = verifyStageCli({ root, argv: ["triage", "7"], home: root });
  expect(r.ok).toBe(false);
  expect(r.reasons.join(" ")).toMatch(/is_error/);
});
