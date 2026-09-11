import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run as realRun } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { readRecords as realReadRecords } from "../lib/records-branch.js";
import { loadCharter, loadHarness } from "../lib/config.js";
import { loadQuarantine } from "../lib/quarantine.js";
import { STATES } from "../lib/labels.js";
import { summarizeUsage } from "../lib/usage.js";
import { buildStatus, renderStatus } from "../lib/status.js";

const LAST_RE = /last:\s*(\S+)/;

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

/** in-progress 이슈의 heartbeat 코멘트(`<!-- factory-heartbeat issue=<n> -->`)에서 마지막 `last:` 값을 읽는다. */
async function collectHeartbeats(gh, inProgressIssues) {
  const map = new Map();
  for (const i of inProgressIssues) {
    const marker = `<!-- factory-heartbeat issue=${i.number} -->`;
    const comments = await gh.comments(i.number);
    const matches = comments.filter((c) => c.body.includes(marker));
    const last = matches[matches.length - 1];
    if (!last) continue;
    const m = LAST_RE.exec(last.body);
    if (m) map.set(i.number, m[1]);
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

  const ghClient = gh || makeGh({ run, repo: process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner });

  const openLists = await Promise.all(STATUS_STATE_LABELS.map((label) => ghClient.issueList({ labels: [label], state: "open" })));
  const merged = await ghClient.issueList({ labels: ["factory:merged"], state: "closed", limit: 10 });
  const issues = [...openLists.flat(), ...merged];

  const [retroProposal, harness] = await Promise.all([
    ghClient.prList({ label: "factory:retro-proposal" }),
    ghClient.prList({ label: "factory:harness" }),
  ]);
  const prs = { retroProposal, harness };

  const inProgressIssues = issues.filter((i) => (i.labels || []).includes("factory:in-progress"));
  const heartbeats = await collectHeartbeats(ghClient, inProgressIssues);

  let charter; try { charter = loadCharter(root); } catch { charter = { back_pressure: {} }; }
  let thresholds; try { thresholds = loadHarness(root).gates.thresholds; } catch { thresholds = {}; }
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
