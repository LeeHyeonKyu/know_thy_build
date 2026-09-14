import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boardCommand, parseBoardArgs, startBoardServer, collectRepo, resolvePagePath, DEFAULT_PORT, DEFAULT_INTERVAL_S } from "../cli/board.js";
import { progressMarker } from "../lib/progress.js";

const repoRoot = new URL("../../", import.meta.url).pathname;
const NOW = "2026-09-15T12:00:00Z";
const ago = (min) => new Date(Date.parse(NOW) - min * 60000).toISOString();
const io = () => { const o = { out: [], err: [] }; return { io: { out: (s) => o.out.push(s), err: (s) => o.err.push(s) }, o }; };

const progress = {
  stage: "implement", issue: 7, runner: "gha-42", started: ago(20), updated: ago(1),
  step: { phase: "R1", label: "R1:architecture", since: ago(6) },
  agents: [{ label: "R1:architecture", kind: "subagent", status: "running", started: ago(6), ended: null, last_tool: "Read src/a.js", turns: 3, input_tokens: 500, output_tokens: 100, cache_read_tokens: 0, cost_usd: 0.3 }],
  totals: { turns: 3, input_tokens: 500, output_tokens: 100, cache_read_tokens: 0, cost_usd: 0.3 },
  files_touched: ["src/a.js"],
};

const heartbeat = `<!-- factory-heartbeat issue=7 -->
stage: implement · runner: gha-42 · started: ${ago(20)} · last: ${ago(1)}
${progressMarker(progress)}
step: R1 · R1:architecture`;

const RECORD = `# issue #7

## plan · 2026-09-15T10:00Z · gha-41
usage: {"input_tokens":100,"output_tokens":50} cost_usd: 1.25 num_turns: 9 terminal_reason: end_turn models: claude-opus-5=$1.25
`;

/** 한 저장소 분량의 가짜 GitHub. 키는 그대로 gh 호출이 조회하는 것들이다. */
function repoFixture() {
  return {
    issues: [{ number: 7, title: "a thing", labels: ["factory:in-progress", "factory:tier-standard"], createdAt: ago(300), updatedAt: ago(1) }],
    closed: [],
    comments: {
      7: [
        { id: 1, body: "<!-- factory-transition:v1 from=factory:planned to=factory:in-progress by=script -->\nfactory:planned → factory:in-progress", created_at: ago(180) },
        { id: 2, body: heartbeat, created_at: ago(1) },
      ],
    },
    runs: [{ databaseId: 42, status: "in_progress", conclusion: null, workflowName: "factory-implement", displayTitle: "a thing", url: "https://gh/run/42", createdAt: ago(20), event: "issues" }],
    records: { "7.md": { sha: "abc123", text: RECORD } },
  };
}

/**
 * gh 호출 하나하나를 인자 모양으로 가른다 — 정확한 플래그 순서에 묶지 않으려고 느슨한 술어를 쓴다.
 * `calls`는 "레코드 본문을 몇 번 받아 갔는가"(blob 캐시) 같은 것을 세는 데 쓴다.
 */
function fakeGh(repos, { failRepo = null } = {}) {
  const calls = [];
  const ok = (stdout) => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr = "boom") => ({ code: 1, stdout: "", stderr });
  const fn = async (cmd, args = []) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd !== "gh") return fail(`unexpected command ${cmd}`);
    const line = args.join(" ");
    if (args[0] === "repo" && args[1] === "view") return ok(JSON.stringify({ nameWithOwner: Object.keys(repos)[0] }));

    const repoFlag = args[args.indexOf("-R") + 1];
    const apiRepo = /repos\/([^/]+\/[^/]+)\//.exec(line)?.[1];
    const name = repoFlag && args.includes("-R") ? repoFlag : apiRepo;
    if (name === failRepo) return fail("gh: HTTP 404");
    const fx = repos[name];
    if (!fx) return fail(`no fixture for ${name}`);

    if (args[0] === "issue" && args[1] === "list") return ok(JSON.stringify(args.includes("closed") ? fx.closed : fx.issues));
    if (args[0] === "run" && args[1] === "list") return ok(JSON.stringify(fx.runs));
    if (args[0] === "api") {
      const m = /repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments/.exec(line);
      if (m) return ok(JSON.stringify([fx.comments[m[1]] || []]));
      const dir = /contents\/docs\/factory\/runs\?ref=/.test(line);
      if (dir) return ok(JSON.stringify(Object.entries(fx.records).map(([n, r]) => ({ name: n, sha: r.sha, type: "file" }))));
      const file = /contents\/docs\/factory\/runs\/([^?]+)\?ref=/.exec(line);
      if (file) {
        const rec = fx.records[file[1]];
        return rec ? ok(JSON.stringify({ content: Buffer.from(rec.text, "utf8").toString("base64"), encoding: "base64", sha: rec.sha })) : fail("404");
      }
    }
    return fail(`unexpected gh ${line}`);
  };
  fn.calls = calls;
  return fn;
}

// ── argv ────────────────────────────────────────────────────────────────────

test("parseBoardArgs: defaults, repeatable --repo, numeric --port/--interval, --once --json", () => {
  expect(parseBoardArgs([])).toMatchObject({ repos: [], port: DEFAULT_PORT, interval: DEFAULT_INTERVAL_S, once: false, json: false });
  const a = parseBoardArgs(["--repo", "o/a", "--repo", "o/b", "--port", "0", "--interval", "5", "--once", "--json"]);
  expect(a.repos).toEqual(["o/a", "o/b"]);
  expect(a.port).toBe(0);
  expect(a.interval).toBe(5);
  expect(a.once && a.json).toBe(true);
});

test("parseBoardArgs refuses a nonsense repo and a nonsense port instead of guessing", () => {
  expect(() => parseBoardArgs(["--repo", "not-a-repo"])).toThrow(/owner\/name/);
  expect(() => parseBoardArgs(["--port", "abc"])).toThrow(/--port/);
  expect(() => parseBoardArgs(["--interval", "-3"])).toThrow(/--interval/);
});

test("parseBoardArgs refuses a `..` segment in --repo (review 714a45d should-fix 1b)", () => {
  expect(() => parseBoardArgs(["--repo", "../.."])).toThrow(/owner\/name/);
  expect(() => parseBoardArgs(["--repo", "owner/.."])).toThrow(/owner\/name/);
  expect(() => parseBoardArgs(["--repo", "../name"])).toThrow(/owner\/name/);
});

// ── --host (ADR-022 decision 1: loopback only) ──────────────────────────────

test("parseBoardArgs defaults --host to 127.0.0.1 and accepts the other two loopback spellings", () => {
  expect(parseBoardArgs([]).host).toBe("127.0.0.1");
  expect(parseBoardArgs(["--host", "localhost"]).host).toBe("localhost");
  expect(parseBoardArgs(["--host", "::1"]).host).toBe("::1");
});

test("parseBoardArgs refuses a non-loopback --host and names ADR-022 decision 1 (review 714a45d MUST-FIX 1)", () => {
  expect(() => parseBoardArgs(["--host", "0.0.0.0"])).toThrow(/ADR-022 decision 1/);
  expect(() => parseBoardArgs(["--host", "0.0.0.0"])).toThrow(/loopback/);
});

test("boardCommand exits 2 (not 1) on a rejected --host — a policy refusal, not a generic flag error", async () => {
  const { io: i, o } = io();
  const code = await boardCommand({ root: repoRoot, pkgRoot: repoRoot, argv: ["--host", "0.0.0.0"], io: i, run: fakeGh({ "o/r": repoFixture() }), now: () => NOW });
  expect(code).toBe(2);
  expect(o.err.join("\n")).toMatch(/ADR-022 decision 1/);
});

// ── --once --json ───────────────────────────────────────────────────────────

test("--once --json prints the whole model on one line and exits 0", async () => {
  const { io: i, o } = io();
  const code = await boardCommand({ root: repoRoot, pkgRoot: repoRoot, argv: ["--repo", "o/r", "--once", "--json"], io: i, run: fakeGh({ "o/r": repoFixture() }), now: () => NOW });
  expect(code).toBe(0);
  expect(o.out.length).toBe(1);
  const model = JSON.parse(o.out[0]);
  expect(model.generated_at).toBe(NOW);
  expect(model.repos).toEqual([{ repo: "o/r", error: null, issue_count: 1, fetched_at: NOW }]);
  const card = model.issues[0];
  expect(card.key).toBe("o/r#7");
  expect(card.stage).toBe("implement");
  expect(card.heartbeat.freshness).toBe("fresh");
  expect(card.progress.step.label).toBe("R1:architecture");
  expect(card.run).toMatchObject({ id: 42, status: "in_progress", matched_by: "runner" });
  expect(card.cost).toMatchObject({ finished_usd: 1.25, live_usd: 0.3, total_usd: 1.55 });
  expect(model.lanes.find((l) => l.id === "in-progress").issues).toEqual(["o/r#7"]);
});

test("--once without --json prints a human summary naming the lane and the live step", async () => {
  const { io: i, o } = io();
  expect(await boardCommand({ root: repoRoot, pkgRoot: repoRoot, argv: ["--repo", "o/r", "--once"], io: i, run: fakeGh({ "o/r": repoFixture() }), now: () => NOW })).toBe(0);
  const text = o.out.join("\n");
  expect(text).toContain("구현 중");
  expect(text).toContain("#7");
  expect(text).toContain("R1:architecture");
});

test("with no --repo the board asks gh for the current repository (the same resolution `factory status` uses)", async () => {
  const { io: i, o } = io();
  const run = fakeGh({ "o/current": repoFixture() });
  const before = process.env.FACTORY_REPO;
  delete process.env.FACTORY_REPO;
  try {
    expect(await boardCommand({ root: repoRoot, pkgRoot: repoRoot, argv: ["--once", "--json"], io: i, run, now: () => NOW })).toBe(0);
  } finally { if (before !== undefined) process.env.FACTORY_REPO = before; }
  expect(JSON.parse(o.out[0]).repos[0].repo).toBe("o/current");
  expect(run.calls.some((c) => c.startsWith("gh repo view"))).toBe(true);
});

test("a repo whose issue list fails becomes an error row — the other repo still renders", async () => {
  const { io: i, o } = io();
  const run = fakeGh({ "o/a": repoFixture(), "o/b": repoFixture() }, { failRepo: "o/b" });
  expect(await boardCommand({ root: repoRoot, pkgRoot: repoRoot, argv: ["--repo", "o/a", "--repo", "o/b", "--once", "--json"], io: i, run, now: () => NOW })).toBe(0);
  const model = JSON.parse(o.out[0]);
  expect(model.repos.map((r) => r.repo)).toEqual(["o/a", "o/b"]);
  expect(model.repos[1].error).toMatch(/404/);
  expect(model.issues.map((c) => c.key)).toEqual(["o/a#7"]);
});

// ── collectRepo ─────────────────────────────────────────────────────────────

test("collectRepo reads the run record off the records branch through the gh contents endpoint", async () => {
  const run = fakeGh({ "o/r": repoFixture() });
  const entry = await collectRepo({ run, repo: "o/r", now: NOW, cache: new Map() });
  expect(entry.issues[0].recordText).toContain("cost_usd: 1.25");
  expect(run.calls.some((c) => c.includes("contents/docs/factory/runs/7.md?ref=factory/records"))).toBe(true);
});

test("collectRepo re-fetches a record only when its blob sha moved — an unchanged record costs one directory call", async () => {
  const fx = repoFixture();
  const run = fakeGh({ "o/r": fx });
  const cache = new Map();
  await collectRepo({ run, repo: "o/r", now: NOW, cache });
  const contentCalls = () => run.calls.filter((c) => c.includes("runs/7.md")).length;
  expect(contentCalls()).toBe(1);

  const second = await collectRepo({ run, repo: "o/r", now: NOW, cache });
  expect(contentCalls()).toBe(1);                       // sha가 그대로다 — 본문을 다시 받지 않는다
  expect(second.issues[0].recordText).toContain("cost_usd: 1.25");

  fx.records["7.md"] = { sha: "def456", text: `${RECORD}\n## review · 2026-09-15T11:30Z · gha-50\nusage: {} cost_usd: 0.5 num_turns: 1 terminal_reason: end_turn models: n/a\n` };
  const third = await collectRepo({ run, repo: "o/r", now: NOW, cache });
  expect(contentCalls()).toBe(2);
  expect(third.issues[0].recordText).toContain("cost_usd: 0.5");
});

test("collectRepo survives a repo with no records branch at all (a fresh install has none)", async () => {
  const fx = repoFixture();
  const run = async (cmd, args = []) => (args.join(" ").includes("contents/docs/factory/runs") ? { code: 1, stdout: "", stderr: "Not Found" } : fakeGh({ "o/r": fx })(cmd, args));
  const entry = await collectRepo({ run, repo: "o/r", now: NOW, cache: new Map() });
  expect(entry.error).toBeUndefined();
  expect(entry.issues[0].recordText).toBe(null);
});

// ── server ──────────────────────────────────────────────────────────────────

/** 서버 하나를 띄우고 반드시 닫는다 — 열어 둔 리스너는 vitest를 매달아 놓는다. */
async function withServer(opts, body) {
  const server = await startBoardServer({
    repos: ["o/r"], run: fakeGh({ "o/r": repoFixture() }), now: () => NOW,
    port: 0, host: "127.0.0.1", interval: 3600, pagePath: resolvePagePath({ pkgRoot: repoRoot, root: repoRoot }),
    ...opts,
  });
  try { return await body(server); } finally { await server.close(); }
}

test("GET / serves the installed page and GET /api/board serves the model, from a real listener", async () => {
  await withServer({}, async (s) => {
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const page = await fetch(`${s.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    const html = await page.text();
    expect(html).toContain('id="view-lanes"');
    expect(html).toContain('id="view-timeline"');

    const api = await fetch(`${s.url}/api/board`);
    expect(api.status).toBe(200);
    expect(api.headers.get("content-type")).toMatch(/application\/json/);
    const model = await api.json();
    expect(model.issues[0].key).toBe("o/r#7");
    expect(model.issues[0].progress.step.label).toBe("R1:architecture");

    expect((await fetch(`${s.url}/nope`)).status).toBe(404);
  });
});

test("GET /api/events opens an SSE stream and pushes one board event right away", async () => {
  await withServer({}, async (s) => {
    const res = await fetch(`${s.url}/api/events`);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body.getReader();
    let buf = "";
    while (!buf.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
    }
    expect(buf).toContain("event: board");
    const data = JSON.parse(/^data: (.*)$/m.exec(buf)[1]);
    expect(data.issues[0].key).toBe("o/r#7");
    await reader.cancel();
  });
});

test("a refresh that changes nothing pushes no second event; a changed model pushes one", async () => {
  const fx = repoFixture();
  const run = fakeGh({ "o/r": fx });
  await withServer({ run }, async (s) => {
    const events = [];
    s.onPush = (payload) => events.push(payload);
    await s.refresh();
    expect(events.length).toBe(0);                       // 같은 모델 — 아무것도 밀지 않는다
    fx.issues[0].labels = ["factory:awaiting-review"];
    await s.refresh();
    expect(events.length).toBe(1);
    expect(JSON.parse(events[0]).issues[0].state).toBe("factory:awaiting-review");
  });
});

/**
 * `now: () => NOW`로 시계를 고정해 둔 테스트는 dedupe가 죽어 있어도 `JSON.stringify(model)`이 그대로
 * 같아서 통과한다 — 실서비스에서는 매 폴마다 `now`가 움직이고, `generated_at`·`fetched_at`·`since_min`·
 * `heartbeat.age_min`·열린 타임라인 구간의 `duration_min`/`to`가 사실과 무관하게 바뀐다(review 714a45d
 * should-fix 5). 이 테스트는 시계를 **직접 전진**시켜서 그 차이가 push를 만들지 않는다는 것과, 진짜
 * 상태 변화는 여전히 push를 만든다는 것을 함께 증명한다.
 */
test("advancing the clock alone pushes nothing; a real state change still pushes exactly one event", async () => {
  const fx = repoFixture();
  const run = fakeGh({ "o/r": fx });
  let clock = Date.parse(NOW);
  const advancingNow = () => new Date(clock).toISOString();
  // 30초씩만 전진시킨다 — 하트비트는 ago(1)(NOW보다 1분 전)이라, FRESH_MIN(5분) 문턱을 넘으면
  // freshness 자체가 fresh→stale로 바뀌는 **진짜** 변화가 생겨 이 테스트의 전제(시간만 지났다)가
  // 깨진다. 문턱에서 충분히 떨어진 폭을 쓴다.
  await withServer({ run, now: advancingNow }, async (s) => {
    const events = [];
    s.onPush = (payload) => events.push(payload);

    clock += 30_000;                                      // 30초 지남 — 사실은 그대로
    await s.refresh();
    expect(events.length).toBe(0);

    clock += 30_000;                                       // 또 30초 — 여전히 사실은 그대로
    await s.refresh();
    expect(events.length).toBe(0);

    fx.issues[0].labels = ["factory:awaiting-review"];     // 이번엔 진짜 변화
    clock += 30_000;
    await s.refresh();
    expect(events.length).toBe(1);
    expect(JSON.parse(events[0]).issues[0].state).toBe("factory:awaiting-review");

    clock += 30_000;                                       // 다시 시간만 지남 — 더 밀지 않는다
    await s.refresh();
    expect(events.length).toBe(1);
  });
});

// ── page ────────────────────────────────────────────────────────────────────

test("resolvePagePath prefers the packaged template and falls back to the installed copy", () => {
  expect(resolvePagePath({ pkgRoot: repoRoot, root: repoRoot })).toBe(join(repoRoot, "templates/factory/docs/factory/board/index.html"));
  expect(resolvePagePath({ pkgRoot: "/nowhere", root: repoRoot })).toBe(join(repoRoot, "docs/factory/board/index.html"));
});

test("the page the CLI serves is the same file `factory init` installs", () => {
  const packaged = readFileSync(join(repoRoot, "templates/factory/docs/factory/board/index.html"), "utf8");
  const installed = readFileSync(join(repoRoot, "docs/factory/board/index.html"), "utf8");
  expect(installed).toBe(packaged);
});
