import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as realRun } from "../lib/exec.js";
import { makeGh, resolveRepo } from "../lib/gh.js";
import { REHEARSAL_WORKFLOW, rehearsalArtifactName, renderRehearsalTable } from "../lib/rehearsal.js";

/**
 * `factory rehearse` — 리허설 워크플로를 띄우고, 기다리고, 표를 찍고, RED면 non-zero로 끝난다(ADR-025).
 *
 * **로컬에서 게이트를 돌리지 않는다**: 그것이 `doctor --run`이고, own-calendar의 세 결함은 전부 그
 * 자리에서 보이지 않았다(러너의 PATH·설치본·작업 디렉터리가 다르다). 이 명령이 하는 일은 러너 위의
 * 한 번을 **주문하고 결과를 가져오는** 것뿐이다.
 */
const POLL_MS = 15000;
const DEFAULT_WAIT_SEC = 3600;

export async function rehearseCommand({
  root, argv = [], io, run = realRun, gh = null, repo = null,
  readFile = (p) => readFileSync(p, "utf8"),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  since = () => new Date(),
  mkdtemp = (p) => mkdtempSync(p),
  waitSec = DEFAULT_WAIT_SEC,
  pollMs = POLL_MS,
}) {
  const json = argv.includes("--json");
  let client = gh;
  if (!client) {
    const r = repo || (await resolveRepo({ run }));
    client = makeGh({ run, repo: r });
  }

  const before = since();
  try {
    await client.dispatchWorkflow(REHEARSAL_WORKFLOW, {});
  } catch (e) {
    io.err(`factory rehearse: could not dispatch ${REHEARSAL_WORKFLOW} — ${e.message}`);
    return 1;
  }
  io.out(`factory rehearse: dispatched ${REHEARSAL_WORKFLOW} — waiting for the run to finish (up to ${Math.round(waitSec / 60)} min)`);

  // 이 dispatch가 만든 런을 고른다: 명령을 부른 시각 이후에 생긴 것 중 가장 최근. GitHub은 dispatch
  // 직후 몇 초 동안 런을 보여주지 않으므로 "아직 없음"은 실패가 아니라 대기다.
  const deadline = Date.now() + waitSec * 1000;
  let found = null;
  for (;;) {
    let runs = [];
    try { runs = await client.workflowRuns(REHEARSAL_WORKFLOW); } catch (e) { io.err(`factory rehearse: gh run list failed — ${e.message}`); }
    const mine = (runs || [])
      .filter((r) => !before || new Date(r.createdAt) >= new Date(before.getTime() - 60000))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    if (mine && mine.status === "completed") { found = mine; break; }
    if (Date.now() >= deadline) {
      io.err(`factory rehearse: the run did not finish within ${waitSec}s${mine ? ` (run ${mine.databaseId} is ${mine.status})` : ""} — check the Actions tab`);
      return 1;
    }
    await sleep(pollMs);
  }

  const dir = mkdtemp(join(tmpdir(), "factory-rehearsal-"));
  const name = rehearsalArtifactName(found.databaseId);
  try {
    await client.downloadRunArtifact(found.databaseId, name, dir);
  } catch (e) {
    io.err(`factory rehearse: run ${found.databaseId} finished ${found.conclusion} but its report artifact (${name}) could not be downloaded — ${e.message}`);
    return 1;
  }
  let report;
  try {
    report = JSON.parse(readFile(join(dir, "rehearsal.json")));
  } catch (e) {
    io.err(`factory rehearse: the report artifact is unreadable — ${e.message}`);
    return 1;
  }

  if (json) { io.out(JSON.stringify(report)); return report.ok ? 0 : 1; }
  io.out(renderRehearsalTable(report.steps || []));
  const red = (report.steps || []).filter((s) => s.status === "RED").map((s) => s.name);
  const skipped = (report.steps || []).filter((s) => s.status === "SKIPPED").map((s) => s.name);
  io.out("");
  io.out(report.ok
    ? `rehearsal GREEN (run ${found.databaseId}${skipped.length ? `, skipped: ${skipped.join(", ")}` : ""}) — the queue is open for harness ${String(report.hash || "").slice(0, 12)}`
    : `rehearsal RED (run ${found.databaseId}) — ${red.join(", ")}. Fix the harness and run \`factory rehearse\` again; \`→ factory:queue\` stays refused until it is GREEN`);
  return report.ok ? 0 : 1;
}
