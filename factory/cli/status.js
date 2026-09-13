import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run as realRun } from "../lib/exec.js";
import { makeGh, resolveRepo } from "../lib/gh.js";
import { readRecords as realReadRecords } from "../lib/records-branch.js";
import { loadCharter, loadHarness, THRESHOLD_DEFAULTS } from "../lib/config.js";
import { loadQuarantine } from "../lib/quarantine.js";
import { STATES } from "../lib/labels.js";
import { MISSING_STATE_SCAN_HOURS } from "../lib/sweeper.js";
import { lastTransition } from "../lib/retro/issue-comments.js";
import { summarizeUsage } from "../lib/usage.js";
import { buildStatus, renderStatus } from "../lib/status.js";

const LAST_RE = /last:\s*(\S+)/;
const STAGE_RE = /stage:\s*(\S+)/;
const RUNNER_RE = /runner:\s*(\S+)/;

// heartbeat이 있을 수 있는 상태 — lib/status.js LIVE_STATES와 같은 목록(in-progress·blocked는
// heartbeat 없이는 어느 스테이지였는지 알 길이 없고, awaiting-review·rework는 라벨 fallback이
// 있긴 하지만 실제로 review/implement가 돌고 있다면 heartbeat이 더 정확하다).
const HEARTBEAT_ELIGIBLE_STATES = new Set(["factory:in-progress", "factory:blocked", "factory:awaiting-review", "factory:rework"]);

/** readRecords가 실패하거나(브랜치 없음·fetch 실패) 비어 있을 때만 쓰는 로컬 fallback. */
function localRecords(root, dir = "docs/factory/runs") {
  const abs = join(root, dir);
  const out = new Map();
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    if (!name.endsWith(".md")) continue;
    out.set(name.slice(0, -3), readFileSync(join(abs, name), "utf8"));
  }
  return out;
}

/**
 * heartbeat 대상 이슈의 코멘트에서 `<!-- factory-heartbeat issue=<n> -->` 마커가 달린 마지막 코멘트를
 * 찾아 `{last, stage, runner}`를 뽑는다(heartbeat.js가 쓰는 `stage: <s> · runner: <r> · started: … · last: …`
 * 본문 형식). → Map<issue, {last, stage, runner}>.
 */
async function collectHeartbeats(gh, eligibleIssues) {
  const map = new Map();
  for (const i of eligibleIssues) {
    const marker = `<!-- factory-heartbeat issue=${i.number} -->`;
    const comments = await gh.comments(i.number);
    const matches = comments.filter((c) => c.body.includes(marker));
    const last = matches[matches.length - 1];
    if (!last) continue;
    const lastM = LAST_RE.exec(last.body);
    const stageM = STAGE_RE.exec(last.body);
    const runnerM = RUNNER_RE.exec(last.body);
    if (lastM) map.set(i.number, { last: lastM[1], stage: stageM ? stageM[1] : null, runner: runnerM ? runnerM[1] : null });
  }
  return map;
}

// STATES에서 status가 직접 조회할 상태 라벨 — backlog(factory 상태가 아님)·factory:merged(별도 closed
// 조회)·factory:wont-do(종결, 볼 것 없음)는 뺀다.
const STATUS_STATE_LABELS = [...STATES].filter((l) => l !== "backlog" && l !== "factory:merged" && l !== "factory:wont-do");

/**
 * `factory status [--json]` — 읽기 전용(§13 `:status`의 비대화형 버전). mutating gh 메서드는 절대
 * 호출하지 않는다: issueList/prList/comments만 쓴다.
 */
export async function statusCommand({ root, argv = [], io, gh, run = realRun, now, readRecords = realReadRecords }) {
  const json = argv.includes("--json");
  const nowIso = typeof now === "function" ? now() : (now || new Date().toISOString());

  const ghClient = gh || makeGh({ run, repo: await resolveRepo({ run }) });

  const openLists = await Promise.all(STATUS_STATE_LABELS.map((label) => ghClient.issueList({ labels: [label], state: "open" })));
  const merged = await ghClient.issueList({ labels: ["factory:merged"], state: "closed", limit: 10 });
  // ADR-020 KTB-30 — 상태 라벨이 **0개**인 이슈는 위의 라벨별 조회 어디에도 안 걸린다(라벨이 없는
  // 것을 라벨로 찾을 수는 없다). 열린 이슈 전체를 한 번 더 받아 그중 factory 라벨은 있는데 상태
  // 라벨이 없는 것만 더한다 — `buildStatus`가 그것을 Needs You의 `no-state-label`로 낸다.
  // r2 SF6 — 그 집합은 sweeper 8번 팔과 **같아야** 한다: `factory:*` 라벨이 남아 있는 이슈뿐 아니라,
  // 라벨이 하나도 없어도 **전이 이력이 있는** 이슈까지다(상태 라벨이 그 이슈의 유일한 factory 라벨이었던
  // 경우 — triage 이전, 데모 #2의 모양). 코멘트 조회는 그 팔과 같은 24시간 창으로 좁힌다.
  const seen = new Set([...openLists.flat(), ...merged].map((i) => i.number));
  const candidates = (await ghClient.issueList({ state: "open" }))
    .filter((i) => !seen.has(i.number) && !(i.labels || []).some((l) => STATES.has(l)));
  const orphans = [];
  for (const i of candidates) {
    if ((i.labels || []).some((l) => String(l).startsWith("factory:"))) { orphans.push(i); continue; }
    const updatedMs = Date.parse(i.updatedAt ?? "");
    if (!(Number.isFinite(updatedMs) && Date.parse(nowIso) - updatedMs <= MISSING_STATE_SCAN_HOURS * 3600e3)) continue;
    try {
      if (lastTransition(await ghClient.comments(i.number))) orphans.push({ ...i, factoryTransition: true });
    } catch { /* 읽기 전용 보고는 이슈 하나 때문에 죽지 않는다 */ }
  }
  const issues = [...openLists.flat(), ...merged, ...orphans];

  const [retroProposal, harness] = await Promise.all([
    ghClient.prList({ label: "factory:retro-proposal" }),
    ghClient.prList({ label: "factory:harness" }),
  ]);
  const prs = { retroProposal, harness };

  const heartbeatEligible = issues.filter((i) => (i.labels || []).some((l) => HEARTBEAT_ELIGIBLE_STATES.has(l)));
  const heartbeats = await collectHeartbeats(ghClient, heartbeatEligible);

  // CHARTER.md/harness.toml이 아직 없거나(fresh repo) 깨진 경우도 status는 죽지 않는다 — doctor가
  // 아니라 읽기 전용 보고이므로 config.js가 정의한 것과 같은 canonical 기본값으로 떨어진다
  // (fix round 1, Important #5: 전엔 undefined였다 — "cap 없음"처럼 보였다).
  let charter; try { charter = loadCharter(root); } catch { charter = { back_pressure: { awaiting_review_max: 4 } }; }
  let thresholds; try { thresholds = loadHarness(root).gates.thresholds; } catch { thresholds = { quarantine_max: THRESHOLD_DEFAULTS.quarantine_max }; }
  let quarantine; try { quarantine = loadQuarantine(root); } catch { quarantine = { quarantined: [] }; }

  let records;
  try { records = await readRecords({ run, cwd: root, branch: "factory/records", dir: "docs/factory/runs" }); }
  catch { records = new Map(); }
  if (!records || records.size === 0) records = localRecords(root);

  const usage = summarizeUsage(records, { now: nowIso, windowDays: 7 });

  const status = buildStatus({ issues, prs, heartbeats, quarantine, thresholds, charter, usage, now: nowIso });

  if (json) io.out(JSON.stringify(status));
  else io.out(renderStatus(status));
  return 0;
}
