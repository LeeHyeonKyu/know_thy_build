#!/usr/bin/env node
/**
 * 스테이지 산출물을 **손으로** 한 번 더 검증하는 진단 CLI. CI의 판정은 `run-stage.js`가 하고,
 * 이것은 사람이 `.factory/out/`에 남은 파일로 "왜 떨어졌나"를 재현할 때 쓴다.
 *
 * KTB-7 이후 산출물의 1순위 출처는 세션 트랜스크립트의 `Workflow` tool_result다 — 그래서 이 CLI도
 * 트랜스크립트를 넘겨야 `run-stage.js`와 **같은 판정**을 낸다. 넘기지 않으면 디스패처가 요약해 버린
 * 봉투만 보고 "산출물 없음"이라 답해, 실제 CI 판정과 어긋난 진단을 준다.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { readAgentsLog } from "../lib/agents-log.js";
import { verifyStage } from "../lib/verify-stage.js";
import { readTranscript } from "../lib/stage-artifact.js";
import { ROLE_PREFIX, readFileOrNull } from "./run-stage.js";

export const USAGE = "usage: verify-stage <stage> <issue> [--transcript <path>]";

/** `--transcript <path>` / `--transcript=<path>`를 뽑고 나머지 위치 인자를 돌려준다. */
export function parseArgs(argv = []) {
  const rest = [];
  let transcript = null;
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "--transcript") { transcript = argv[++i] ?? null; continue; }
    if (a.startsWith("--transcript=")) { transcript = a.slice("--transcript=".length); continue; }
    rest.push(a);
  }
  return { stage: rest[0], issue: Number(rest[1]), transcript };
}

/**
 * `{ok, reasons, transcript}` — `transcript`는 어느 경로에서 트랜스크립트를 읽었는지(또는 왜 못 읽었는지)다.
 * 진단 도구에서 "트랜스크립트 없이 판정했다"가 조용하면 CI와 다른 답이 나온 이유를 사람이 못 찾는다.
 *
 * 트랜스크립트 경로는 두 가지로 온다: `--transcript`로 직접, 또는 봉투의 `session_id`로 자동 탐색
 * (`lib/stage-artifact.js`의 `readTranscript` — `run-stage.js`와 같은 계산이다). `session_id`는
 * **봉투에만** 있다: KTB-7 이후 `<stage>.json`은 추출에 성공하면 산출물로 덮이고 봉투는
 * `<stage>.envelope.json`으로 따로 남는다.
 */
export function verifyStageCli({ root, argv = [], home = homedir(), readFile = readFileOrNull }) {
  const { stage, issue, transcript } = parseArgs(argv);
  if (!stage || !Number.isInteger(issue) || issue <= 0) return { ok: false, usage: true, reasons: [USAGE], transcript: null };
  const readJson = (p) => { const t = readFile(p); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } };
  const raw = readJson(join(root, `.factory/out/${stage}.json`));
  // 파일은 claude -p 출력({is_error,result}) 또는 스테이지 산출 JSON 그 자체일 수 있다 — 후자는 감싼다.
  const out = raw && (typeof raw.result === "string" || "is_error" in raw) ? raw : { is_error: raw === null, result: JSON.stringify(raw) };
  const envelope = readJson(join(root, `.factory/out/${stage}.envelope.json`));
  const sessionId = envelope?.session_id ?? (typeof raw?.session_id === "string" ? raw.session_id : undefined);
  let transcriptText = "", from = null;
  if (transcript) { transcriptText = readFile(transcript) || ""; from = transcriptText ? transcript : `${transcript} (unreadable)`; }
  else {
    transcriptText = readTranscript({ root, home, sessionId, readFile }) || "";
    from = transcriptText ? `auto (session ${sessionId})` : (sessionId ? `auto (session ${sessionId}) — not found` : "none (no session_id in the envelope)");
  }
  const ctx = readJson(join(root, ".factory/out/context.json")) || {};
  const r = verifyStage({
    stage, out, transcriptText,
    agentsLog: readAgentsLog(join(root, ".factory/out/agents.jsonl")),
    roster: ctx.roster || [], rolePrefix: ROLE_PREFIX[stage] || "",
    expectedRounds: ctx.rounds, orchestration: ctx.orchestration,
    // plan 검증기(감사 Task 9)의 두 입력은 CHARTER의 상한과 이슈 본문(가드 면제)이다 — 둘 다 context.json에 있다.
    planLimits: ctx.plan, issueBody: ctx.issue?.body,
  });
  return { ok: r.ok, reasons: r.reasons, transcript: from };
}

async function main() {
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const r = verifyStageCli({ root, argv: process.argv.slice(2) });
  if (r.usage) { console.error(r.reasons[0]); process.exit(1); }
  console.log(JSON.stringify({ ok: r.ok, reasons: r.reasons, transcript: r.transcript }));
  process.exit(r.ok ? 0 : 2);
}

const isMain = process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
