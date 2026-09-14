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
  argv = [], io, run = realRun, gh = null, repo = null,
  readFile = (p) => readFileSync(p, "utf8"),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  mkdtemp = (p) => mkdtempSync(p),
  waitSec = DEFAULT_WAIT_SEC,
  pollMs = POLL_MS,
}) {
  const json = argv.includes("--json");
  let client = gh;
  if (!client) {
    // 저장소를 해석하지 못하는 것(로그인 없음·원격 없음)은 예외가 아니라 **이 명령의 실패**다 —
    // CLI는 스택 트레이스가 아니라 종료 코드와 한 줄로 말한다(doctor의 오프라인 처리와 같은 계약).
    try {
      client = makeGh({ run, repo: repo || (await resolveRepo({ run })) });
    } catch (e) {
      io.err(`factory rehearse: could not resolve the repository — ${e.message}. Run it inside the repo with \`gh auth login\` done, or set FACTORY_REPO.`);
      return 1;
    }
  }

  /**
   * 리뷰 should_fix 5 — **dispatch 전에 이미 있던 런의 id를 적어 둔다.** 시간 창(`createdAt >= 지금 -
   * 60s`)으로 고르면 30초 전에 끝난 리허설이 "내 런"으로 뽑혀, 방금 주문한 런은 읽지도 않고 옛 표를
   * 찍는다. id 집합은 그 모호함이 없다: 목록에 **없던** id, 그리고 `event === "workflow_dispatch"`.
   */
  let known = new Set();
  try { known = new Set(((await client.workflowRuns(REHEARSAL_WORKFLOW)) || []).map((r) => r.databaseId)); }
  catch (e) { io.err(`factory rehearse: could not list existing runs (${e.message}) — the newest dispatch run will be used instead`); }

  try {
    await client.dispatchWorkflow(REHEARSAL_WORKFLOW, {});
  } catch (e) {
    io.err(`factory rehearse: could not dispatch ${REHEARSAL_WORKFLOW} — ${e.message}`);
    return 1;
  }
  io.out(`factory rehearse: dispatched ${REHEARSAL_WORKFLOW} — waiting for the run to finish (up to ${Math.round(waitSec / 60)} min)`);

  // GitHub은 dispatch 직후 몇 초 동안 새 런을 보여주지 않는다 — "아직 없음"은 실패가 아니라 대기다.
  const deadline = Date.now() + waitSec * 1000;
  let found = null;
  for (;;) {
    let runs = [];
    try { runs = await client.workflowRuns(REHEARSAL_WORKFLOW); } catch (e) { io.err(`factory rehearse: gh run list failed — ${e.message}`); }
    const mine = (runs || [])
      .filter((r) => !known.has(r.databaseId) && (!r.event || r.event === "workflow_dispatch"))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    if (mine && mine.status === "completed") { found = mine; break; }
    if (Date.now() >= deadline) {
      io.err(`factory rehearse: the run did not finish within ${waitSec}s${mine ? ` (run ${mine.databaseId} is ${mine.status})` : " (no new dispatch run appeared)"} — check the Actions tab`);
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
  const stepsOk = report.steps_ok ?? !red.length;
  io.out("");
  if (!stepsOk) {
    io.out(`rehearsal RED (run ${found.databaseId}) — ${red.join(", ")}. Fix the harness and run \`factory rehearse\` again; \`→ factory:queue\` stays refused until it is GREEN`);
    return 1;
  }
  /**
   * 리뷰 must_fix 5 — 스텝이 전부 GREEN이어도 **기록이 실패했으면 큐는 닫혀 있다.** 예전에는 이
   * 경우에도 "the queue is open"을 찍고 0으로 끝났고, 사람은 첫 이슈가 거부될 때까지 그 사실을 몰랐다.
   */
  if (report.recorded && !report.recorded.via) {
    io.err(`rehearsal steps all GREEN (run ${found.databaseId}) but NOT RECORDED — the queue stays closed. variable: ${report.recorded.variable}; status: ${report.recorded.status}`);
    io.err(`Give the bot token repo-variable write (admin) or \`statuses: write\`, then run \`factory rehearse\` again.`);
    return 1;
  }
  io.out(`rehearsal GREEN (run ${found.databaseId}${skipped.length ? `, skipped: ${skipped.join(", ")}` : ""}) — the queue is open for harness ${String(report.hash || "").slice(0, 12)}${report.recorded?.via ? ` (recorded via ${report.recorded.via}${report.recorded.sha ? ` on ${String(report.recorded.sha).slice(0, 7)}` : ""})` : ""}`);
  return 0;
}
