/**
 * `factory board` — **로컬 뷰어** (ADR-022 Task B).
 *
 * 소유자의 질문은 하나다: "지금 각 이슈가 어디에 있고, 어느 스텝이 돌고, 어떤 에이전트가 무엇을
 * 하고, 토큰을 얼마나 태웠는가 — KTB를 설치한 **모든** 저장소에 대해, 여러 이슈가 동시에 돌 때도."
 *
 * **왜 로컬 프로세스인가.** 그 답의 재료는 전부 GitHub에 있고(이슈 라벨·전이 코멘트·하트비트
 * 코멘트·`factory/records` 브랜치·Actions 런), 그 재료를 읽으려면 **누군가의 자격증명**이 필요하다.
 * 이 CLI는 그것을 만들지 않는다 — 모든 호출이 사람의 `gh` CLI를 통해 나간다(`gh api`·`gh run list`).
 * 토큰을 읽지도, 찍지도, 파일에 쓰지도 않는다. 그래서 프라이빗 저장소도 그냥 보이고(그 사람이 볼 수
 * 있는 만큼), 비밀이 새어 나갈 자리가 없다. 정적 페이지만으로는 이 성질을 가질 수 없다.
 *
 * 세 개의 엔드포인트뿐이다(의존성 없음 — node `http`):
 *   - `GET /`            설치된 페이지 그 파일(`docs/factory/board/index.html`)을 그대로 낸다.
 *   - `GET /api/board`   모델 JSON. 저장소당 `--interval`초에 한 번만 GitHub을 다시 묻는다.
 *   - `GET /api/events`  SSE. **모델이 바뀔 때만** `board` 이벤트를 민다.
 *
 * 모델을 만드는 일은 `lib/board.js`(순수 함수)가 한다. 이 파일은 조회와 캐시와 HTTP뿐이다.
 */

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run as realRun } from "../lib/exec.js";
import { makeGh, resolveRepo } from "../lib/gh.js";
import { MISSING_STATE_SCAN_HOURS } from "../lib/sweeper.js";
import { lastTransition } from "../lib/retro/issue-comments.js";
import { buildBoard, LANES, SIDE_LANES } from "../lib/board.js";

export const DEFAULT_PORT = 4173;
/**
 * 기본 60초. 하트비트 주기가 2분이므로(ADR-022 결정 2) 그보다 빨리 물어도 새 사실이 없고, 저장소
 * 하나를 한 번 훑는 데 드는 gh 호출은 대략 `3 + 이슈 수`다 — 60초면 5000/h의 REST 한도 안에서
 * 저장소 여러 개를 하루 종일 띄워 둘 수 있다.
 */
export const DEFAULT_INTERVAL_S = 60;
export const RECORDS_BRANCH = "factory/records";
export const RUNS_DIR = "docs/factory/runs";
/** 상태 라벨이 없는 이슈를 전이 코멘트로 찾을 때의 상한 — sweeper 8번 팔·`factory status`와 같은 창. */
const ORPHAN_SCAN_CAP = 20;

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export function parseBoardArgs(argv = []) {
  const out = { repos: [], port: DEFAULT_PORT, interval: DEFAULT_INTERVAL_S, host: "127.0.0.1", once: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === "--repo") {
      const v = value();
      if (!REPO_RE.test(v)) throw new Error(`--repo must be owner/name (got "${v}")`);
      out.repos.push(v);
    } else if (a === "--port") {
      const v = Number(value());
      if (!Number.isInteger(v) || v < 0 || v > 65535) throw new Error(`--port must be an integer 0–65535`);
      out.port = v;
    } else if (a === "--interval") {
      const v = Number(value());
      if (!Number.isFinite(v) || v <= 0) throw new Error(`--interval must be a positive number of seconds`);
      out.interval = v;
    } else if (a === "--host") out.host = value();
    else if (a === "--once") out.once = true;
    else if (a === "--json") out.json = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

// ── gh 조회 ─────────────────────────────────────────────────────────────────

async function ghJson(run, args) {
  const r = await run("gh", args);
  if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed (${r.code}): ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  try { return JSON.parse(r.stdout); } catch (e) { throw new Error(`gh ${args.slice(0, 2).join(" ")} returned unparsable JSON: ${e.message}`); }
}

/** `gh issue list`의 라벨은 `[{name}]`, 캐시/픽스처는 문자열 배열 — 둘 다 받는다. */
const labelNames = (labels) => (labels || []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
const normalizeIssue = (i) => ({ number: i.number, title: i.title ?? "", labels: labelNames(i.labels), createdAt: i.createdAt ?? null, updatedAt: i.updatedAt ?? null, closedAt: i.closedAt ?? null });

/**
 * 런 기록은 보호된 기본 브랜치가 아니라 `factory/records`에 산다(ADR-014). 그 브랜치를 읽는 길은 둘이다:
 *
 *   (a) `git fetch` + `git show`(`lib/records-branch.js`가 러너에서 쓰는 방법) — **로컬 클론이 있어야 한다**.
 *   (b) gh contents 엔드포인트 — 클론 없이, 사람의 gh 자격증명으로, **아무 저장소나**.
 *
 * 보드는 (b)다. 이 화면의 요구가 "KTB를 설치한 모든 저장소"이기 때문이다 — 남의 저장소를 보려고
 * 클론을 뜨게 하는 것은 뷰어가 할 짓이 아니고, `--repo o/other`가 그 자리에서 동작해야 한다.
 * 대신 디렉터리 목록을 한 번 받아 **blob sha**를 보고, 안 바뀐 기록은 본문을 다시 받지 않는다
 * (기록은 스테이지가 끝날 때만 움직이므로 대부분의 주기에서 이 호출은 전부 생략된다).
 */
async function recordIndex(run, repo) {
  try {
    const list = await ghJson(run, ["api", `repos/${repo}/contents/${RUNS_DIR}?ref=${RECORDS_BRANCH}`]);
    const out = new Map();
    for (const e of Array.isArray(list) ? list : []) if (e?.name?.endsWith(".md")) out.set(e.name, e.sha);
    return out;
  } catch {
    return new Map();   // 브랜치도 디렉터리도 아직 없다 — 첫 스테이지 전의 정상 상태다
  }
}

async function recordText(run, repo, name, sha, cache) {
  const key = `${repo}:${name}`;
  const hit = cache.get(key);
  if (hit && hit.sha === sha) return hit.text;
  try {
    const j = await ghJson(run, ["api", `repos/${repo}/contents/${RUNS_DIR}/${name}?ref=${RECORDS_BRANCH}`]);
    const text = j?.content ? Buffer.from(j.content, "base64").toString("utf8") : null;
    cache.set(key, { sha, text });
    return text;
  } catch {
    return hit?.text ?? null;
  }
}

const withinHours = (iso, hours, now) => {
  const t = Date.parse(iso ?? ""), n = Date.parse(now);
  return Number.isFinite(t) && Number.isFinite(n) && n - t <= hours * 3600e3;
};

/**
 * 저장소 하나를 한 번 훑는다 → `{repo, issues:[{issue, comments, recordText}], runs, fetchedAt}`
 * (실패하면 `{repo, error}` — 조용히 사라지지 않는다).
 *
 * **어떤 이슈를 싣는가.** `factory:*` 라벨이 하나라도 있는 열린 이슈 전부 + 최근 머지된 것 몇 개 +
 * **라벨이 하나도 없지만 전이 이력이 있는** 이슈(ADR-020 KTB-30의 그 이슈들 — 라벨 스왑이 중간에
 * 실패해 상태 라벨이 0개가 된 이슈는 라벨로는 절대 찾을 수 없다). 마지막 집합은 sweeper 8번 팔·
 * `factory status`와 **같은 24시간 창**으로 좁힌다: 세 곳이 다른 집합을 보면 사람이 보는 창구가
 * 복구 팔보다 좁아진다.
 */
export async function collectRepo({ run, repo, now, cache = new Map() }) {
  const gh = makeGh({ run, repo });
  let open, merged;
  try {
    open = (await ghJson(run, ["issue", "list", "-R", repo, "--state", "open", "--limit", "200", "--json", "number,title,labels,createdAt,updatedAt"])).map(normalizeIssue);
    merged = (await ghJson(run, ["issue", "list", "-R", repo, "--state", "closed", "--label", "factory:merged", "--limit", "20", "--json", "number,title,labels,createdAt,updatedAt,closedAt"])).map(normalizeIssue);
  } catch (e) {
    return { repo, error: e.message };
  }

  // Actions가 꺼져 있거나 권한이 없는 저장소도 보드는 뜬다 — 런 칩만 비는 것이 맞다.
  let runs = [];
  try { runs = await ghJson(run, ["run", "list", "-R", repo, "--limit", "50", "--json", "databaseId,status,conclusion,workflowName,displayTitle,url,createdAt,event"]); } catch { runs = []; }

  const tagged = open.filter((i) => i.labels.some((l) => String(l).startsWith("factory:")));
  const taggedNumbers = new Set(tagged.map((i) => i.number));
  const orphanCandidates = open
    .filter((i) => !taggedNumbers.has(i.number) && withinHours(i.updatedAt, MISSING_STATE_SCAN_HOURS, now))
    .slice(0, ORPHAN_SCAN_CAP);

  const index = await recordIndex(run, repo);
  const issues = [];
  const load = async (issue, { requireTransition = false } = {}) => {
    let comments = [];
    try { comments = await gh.comments(issue.number); } catch { /* 이슈 하나의 코멘트 실패가 보드를 죽이지 않는다 */ }
    if (requireTransition && !lastTransition(comments)) return;
    const name = `${issue.number}.md`;
    const text = index.has(name) ? await recordText(run, repo, name, index.get(name), cache) : null;
    issues.push({ issue, comments, recordText: text });
  };
  for (const i of [...tagged, ...merged]) await load(i);
  for (const i of orphanCandidates) await load(i, { requireTransition: true });

  issues.sort((a, b) => a.issue.number - b.issue.number);
  return { repo, issues, runs, fetchedAt: now };
}

// ── 페이지 ──────────────────────────────────────────────────────────────────

/**
 * CLI가 내는 페이지와 `factory init`이 설치하는 페이지는 **같은 파일이어야 한다** — 두 벌이 되면
 * 서버로 본 화면과 정적으로 연 화면이 다른 것을 보여 준다. 그래서 패키지 안의 템플릿을 1순위로,
 * (패키지가 아니라 설치된 저장소에서 도는 경우를 위해) 설치본을 2순위로 고른다.
 */
export function resolvePagePath({ pkgRoot, root }) {
  const packaged = join(pkgRoot ?? "", "templates/factory/docs/factory/board/index.html");
  if (pkgRoot && existsSync(packaged)) return packaged;
  return join(root ?? "", "docs/factory/board/index.html");
}

// ── 서버 ────────────────────────────────────────────────────────────────────

const SSE_KEEPALIVE_MS = 25_000;

export async function startBoardServer({ repos, run = realRun, now = () => new Date().toISOString(), port = DEFAULT_PORT, host = "127.0.0.1", interval = DEFAULT_INTERVAL_S, pagePath, io = null }) {
  const blobCache = new Map();
  const fetchedAt = new Map();
  const entries = new Map();
  const clients = new Set();
  let serialized = null;
  let model = null;

  const api = {
    onPush: null,
    get model() { return model; },
    async refresh({ force = true } = {}) {
      const nowIso = now();
      for (const repo of repos) {
        const last = fetchedAt.get(repo);
        if (!force && last && Date.parse(nowIso) - Date.parse(last) < interval * 1000) continue;
        entries.set(repo, await collectRepo({ run, repo, now: nowIso, cache: blobCache }));
        fetchedAt.set(repo, nowIso);
      }
      model = buildBoard({ repos: repos.map((r) => entries.get(r)).filter(Boolean), now: nowIso });
      const next = JSON.stringify(model);
      if (next === serialized) return model;               // 바뀐 게 없으면 아무도 깨우지 않는다
      serialized = next;
      for (const res of clients) res.write(`event: board\ndata: ${next}\n\n`);
      api.onPush?.(next);
      return model;
    },
  };

  await api.refresh();

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/board") {
      api.refresh({ force: false })
        .then(() => { res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(serialized); })
        .catch((e) => { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(e.message || e) })); });
      return;
    }
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
      // 붙는 순간 지금 모델을 한 번 밀어 준다 — 페이지가 첫 화면을 그리려고 /api/board를 또 부를
      // 이유가 없고, 탭을 다시 열 때마다 GitHub을 다시 묻지도 않는다.
      res.write(`event: board\ndata: ${serialized}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/") {
      let html;
      try { html = readFileSync(pagePath, "utf8"); }
      catch { res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); res.end(`board page not found: ${pagePath}\nrun: npx know-thy-build factory init --upgrade`); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const poll = setInterval(() => { api.refresh().catch((e) => io?.err?.(`factory board: refresh failed — ${e.message}`)); }, interval * 1000);
  const ping = setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, SSE_KEEPALIVE_MS);

  const addr = server.address();
  api.port = addr.port;
  api.url = `http://${host}:${addr.port}`;
  api.server = server;
  api.close = () => new Promise((resolve) => {
    clearInterval(poll); clearInterval(ping);
    for (const res of clients) { try { res.end(); } catch { /* 이미 끊긴 클라이언트 */ } }
    clients.clear();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
  return api;
}

// ── 한 번만 ─────────────────────────────────────────────────────────────────

const laneLabel = new Map([...LANES, ...SIDE_LANES].map((l) => [l.id, l.label]));

/** `--once`의 사람용 출력. `factory status`의 "진행 중" 절과 같은 사실을 레인 순서로 늘어놓은 것. */
export function renderBoardText(model) {
  const lines = [`# factory board · ${model.generated_at}`];
  for (const r of model.repos) lines.push(`- ${r.repo}: ${r.error ? `ERROR ${r.error}` : `${r.issue_count} issues`}`);
  lines.push("");
  const byKey = new Map(model.issues.map((i) => [i.key, i]));
  for (const lane of [...model.lanes, ...model.side_lanes, model.other_lane]) {
    if (!lane.issues.length) continue;
    lines.push(`## ${lane.label} (${lane.issues.length})`);
    for (const key of lane.issues) {
      const c = byKey.get(key);
      const bits = [
        `${c.repo}#${c.number} ${c.title}`,
        c.stage ? `stage ${c.stage}` : (c.expected_stage ? `${c.expected_stage} 대기` : null),
        c.heartbeat ? `${c.heartbeat.freshness} ${Math.round(c.heartbeat.age_min)}m` : null,
        c.step?.label || null,
        c.cost.total_usd ? `$${c.cost.total_usd.toFixed(2)}` : null,
        c.run ? `run ${c.run.id} ${c.run.status}` : null,
        ...c.flags.map((f) => (f.detail ? `${f.kind}(${f.detail})` : f.kind)),
      ].filter(Boolean);
      lines.push(`- ${bits.join(" · ")}`);
    }
    lines.push("");
  }
  lines.push(`총 ${model.totals.issues} issues · live ${model.totals.live} · $${model.totals.cost_usd.toFixed(2)}`);
  return lines.join("\n");
}

export async function boardCommand({ root, pkgRoot, argv = [], io, run = realRun, now = () => new Date().toISOString() }) {
  let opts;
  try { opts = parseBoardArgs(argv); }
  catch (e) { io.err(`factory board: ${e.message}`); return 1; }

  let repos = opts.repos;
  if (repos.length === 0) {
    try { repos = [await resolveRepo({ run })]; }
    catch (e) { io.err(`factory board: no --repo given and the current repository could not be resolved — ${e.message}`); return 1; }
  }

  if (opts.once) {
    const nowIso = now();
    const cache = new Map();
    const entries = [];
    for (const repo of repos) entries.push(await collectRepo({ run, repo, now: nowIso, cache }));
    const model = buildBoard({ repos: entries, now: nowIso });
    io.out(opts.json ? JSON.stringify(model) : renderBoardText(model));
    return 0;
  }

  const pagePath = resolvePagePath({ pkgRoot, root });
  let server;
  try { server = await startBoardServer({ repos, run, now, port: opts.port, host: opts.host, interval: opts.interval, pagePath, io }); }
  catch (e) { io.err(`factory board: could not start the server — ${e.message}`); return 1; }

  io.out(`factory board · ${server.url}`);
  io.out(`  repos: ${repos.join(", ")} · refresh ${opts.interval}s · page ${pagePath}`);
  io.out(`  everything goes through your local gh CLI — no token is read, stored or printed. Ctrl-C to stop.`);

  await new Promise((resolve) => {
    const stop = () => { server.close().then(resolve); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    server.server.once("close", resolve);
  });
  return 0;
}
