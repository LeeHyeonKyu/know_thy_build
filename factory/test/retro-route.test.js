import { test, expect, describe } from "vitest";
import { fileURLToPath } from "node:url";
import { ownerOf, buildManifest } from "../cli/manifest.js";
import { routeFindings, routeMergedIssues, feedbackNoteMarker } from "../lib/feedback/route.js";
import { harvestFindings } from "../lib/feedback/harvest-findings.js";
import { UPSTREAM_LABELS, parseUpstreamIssue, evidenceEntries } from "../lib/feedback/upstream-issue.js";
import { HARNESS_LABEL } from "../lib/harness-request.js";

/**
 * Task 3 — 라우팅 팔. 여기서 고정하는 계약은 **두 대상이 절대 섞이지 않는다**(spec §2)와
 * **같은 원인은 상류 이슈 하나로 모인다**(spec §6)이다. 매니페스트는 실물을 쓴다(classify 테스트와
 * 같은 이유: prefix 근사로 바꾸면 채택자의 파일이 KTB 이슈로 올라간다).
 */
const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
const dests = new Set(buildManifest({ pkgRoot }).map((e) => e.dest));
const ktbVersion = "1.3.0";
const harness = { test: { source_glob: ["src/**/*.js"], test_glob: ["test/**/*.test.js"] } };
const REPO = "LeeHyeonKyu/own-cal";
const UPSTREAM = "LeeHyeonKyu/know_thy_build";

/** 실제 gh 어댑터의 모양만 흉내 낸다 — 열린 이슈 목록은 이 배열이 곧 저장소다(dedupe가 실제로 걸린다). */
function fakeGh({ upstreamIssues = [], throwUpstream = false } = {}) {
  const calls = { createIssue: [], comment: [], upstreamIssue: [], issueList: [] };
  let seq = 500;
  const local = [];
  return {
    calls,
    upstreamIssues,
    async issueList({ labels = [], state = "open" } = {}) {
      calls.issueList.push({ labels, state });
      return local.filter((i) => labels.every((l) => i.labels.includes(l)));
    },
    async createIssue({ title, body, labels = [] }) {
      calls.createIssue.push({ title, body, labels });
      const number = (seq += 1);
      local.push({ number, title, body, labels });
      return number;
    },
    async comment(n, body) { calls.comment.push({ issue: n, body }); return `https://x/#issuecomment-${(seq += 1)}`; },
    async upstreamIssue({ repo, fingerprint, render, append, match }) {
      calls.upstreamIssue.push({ repo, fingerprint });
      if (throwUpstream) throw new Error("gh issue list failed (1): HTTP 403 Resource not accessible by integration");
      const found = upstreamIssues.find((i) => match(String(i.body ?? "")));
      if (found) {
        const next = append(String(found.body ?? ""));
        const appended = next !== found.body;
        found.body = next;
        return { issue: found.number, created: false, appended };
      }
      const { title, body, labels } = render();
      const number = (seq += 1);
      upstreamIssues.push({ number, title, body, labels });
      return { issue: number, created: true, appended: false };
    },
  };
}

const route = (over = {}) => routeFindings({
  repo: REPO, ownerOf, isInstalled: dests, ktbVersion, harness, existingComments: [], ...over,
});

/** 채택자 소유(harness) 발견 하나 — own-cal의 Flutter 툴체인 누락 계열. */
const harnessFinding = (issue = 7) => ({
  kind: "gate", issue, repo: REPO, stage: "implement", round: 2,
  causal_path: ".factory/harness.toml [commands].unit",
  reason: "command exited 1 with 0 failing tests — unhandled error outside tests (see gate log)",
  extra: { snippet: "flutter: command not found" },
});

/** KTB 소유(ktb) 발견 하나 — 데모 #39의 self-gate qa-manifest 오차단. */
const ktbFinding = (issue = 39) => ({
  kind: "self-gate", issue, repo: REPO, stage: "implement", round: 1,
  causal_path: ".factory/lib/self-gate.js",
  reason: "self-gate blocked the transition: qa-manifest missing, but the issue carries no qa requirement",
  extra: { snippet: "qa-manifest: no manifest at .factory/out/qa/39/manifest.json" },
});

describe("(a) harness 발견은 쓰는 저장소의 harness 이슈 하나로만 간다", () => {
  test("harness 이슈 정확히 하나, 상류 호출 0", async () => {
    const gh = fakeGh();
    const r = await route({ gh, issue: 7, upstream: UPSTREAM, findings: [harnessFinding(7)] });
    expect(gh.calls.createIssue).toHaveLength(1);
    expect(gh.calls.createIssue[0].labels).toEqual(["factory:queue", HARNESS_LABEL]);
    expect(gh.calls.createIssue[0].body).toContain(".factory/harness.toml");
    expect(gh.calls.upstreamIssue).toEqual([]);
    expect(r.actions.map((a) => a.kind)).toContain("harness-issue");
  });

  // 본문은 **사실이어야 한다**: 이 요청은 implement handoff의 `harness_needed`가 아니고, 가리키는
  // 이슈는 이미 머지됐다(`factory:merged`는 막다른 상태라 `Blocks:`는 거부되는 전이만 만든다).
  test("피드백 루프가 연 harness 이슈는 implement handoff를 사칭하지 않고 Blocks: 줄도 싣지 않는다", async () => {
    const gh = fakeGh();
    await route({ gh, issue: 7, upstream: UPSTREAM, findings: [harnessFinding(7)] });
    const body = gh.calls.createIssue[0].body;
    expect(body).toContain("<!-- factory-harness-request for=7 -->");   // dedupe 키는 그대로다
    expect(body).toContain("피드백 루프");
    expect(body).not.toContain("harness_needed");
    expect(body).not.toMatch(/^Blocks: /m);
  });

  test("같은 이슈의 harness 발견이 둘이어도 이슈는 하나(entries가 두 줄)", async () => {
    const gh = fakeGh();
    const second = { ...harnessFinding(7), causal_path: "docs/factory/CHARTER.md", reason: "the roster for `docs` tier is empty" };
    await route({ gh, issue: 7, upstream: UPSTREAM, findings: [harnessFinding(7), second] });
    expect(gh.calls.createIssue).toHaveLength(1);
    expect(gh.calls.createIssue[0].body).toContain("CHARTER.md");
  });
});

describe("(b) ktb 발견은 upstream 이슈 하나로 — 두 번째 머지는 증거를 덧붙인다", () => {
  test("첫 머지: fingerprint 마커 + UPSTREAM_LABELS를 단 이슈가 열린다", async () => {
    const gh = fakeGh();
    const r = await route({ gh, issue: 39, upstream: UPSTREAM, findings: [ktbFinding(39)] });
    expect(gh.upstreamIssues).toHaveLength(1);
    const opened = gh.upstreamIssues[0];
    expect(opened.labels).toEqual(UPSTREAM_LABELS);
    const parsed = parseUpstreamIssue(opened.body);
    expect(parsed).not.toBeNull();
    expect(parsed.fingerprint).toBe(r.classified[0].fingerprint);
    expect(parsed.from).toBe(`${REPO}#39`);
    expect(gh.calls.createIssue).toEqual([]);               // 쓰는 저장소에는 아무것도 열지 않는다
  });

  test("같은 원인이 다른 이슈에서 다시 나오면 새 이슈가 아니라 증거가 붙는다", async () => {
    const gh = fakeGh();
    await route({ gh, issue: 39, upstream: UPSTREAM, findings: [ktbFinding(39)] });
    await route({ gh, issue: 41, upstream: UPSTREAM, findings: [ktbFinding(41)] });
    expect(gh.upstreamIssues).toHaveLength(1);
    const entries = evidenceEntries(gh.upstreamIssues[0].body);
    expect(entries).toHaveLength(2);
    expect(entries.join("\n")).toContain(`${REPO}#39`);
    expect(entries.join("\n")).toContain(`${REPO}#41`);
  });

  test("같은 머지를 두 번 돌아도 증거는 한 번만 쌓인다(멱등)", async () => {
    const gh = fakeGh();
    await route({ gh, issue: 39, upstream: UPSTREAM, findings: [ktbFinding(39)] });
    await route({ gh, issue: 39, upstream: UPSTREAM, findings: [ktbFinding(39)] });
    expect(gh.upstreamIssues).toHaveLength(1);
    expect(evidenceEntries(gh.upstreamIssues[0].body)).toHaveLength(1);
  });
});

describe("(c) upstream 미설정 — 로컬 코멘트만, 교차 저장소 호출 0", () => {
  test("코멘트 하나, upstreamIssue 호출 0, harness 이슈 0", async () => {
    const gh = fakeGh();
    const r = await route({ gh, issue: 39, upstream: null, findings: [ktbFinding(39)] });
    expect(gh.calls.upstreamIssue).toEqual([]);
    expect(gh.calls.createIssue).toEqual([]);
    expect(gh.calls.comment).toHaveLength(1);
    expect(gh.calls.comment[0].issue).toBe(39);
    expect(gh.calls.comment[0].body).toContain(feedbackNoteMarker(r.classified[0].fingerprint));
    expect(gh.calls.comment[0].body).toMatch(/upstream/);
  });

  test("같은 마커가 이미 이슈에 있으면 다시 쓰지 않는다", async () => {
    const gh = fakeGh();
    const first = await route({ gh, issue: 39, upstream: null, findings: [ktbFinding(39)] });
    const fp = first.classified[0].fingerprint;
    const gh2 = fakeGh();
    await route({ gh: gh2, issue: 39, upstream: null, findings: [ktbFinding(39)], existingComments: [{ body: feedbackNoteMarker(fp) }] });
    expect(gh2.calls.comment).toEqual([]);
  });
});

describe("(d) ambiguous — 두 후보를 적은 노트 하나", () => {
  test("후보 둘이 본문에 그대로 실리고 어느 이슈도 열리지 않는다", async () => {
    const gh = fakeGh();
    const finding = {
      kind: "review-must_fix", issue: 12, repo: REPO, stage: "review", round: 1, role: "correctness",
      causal_path: ".factory/out/unit.json",
      reason: "the unit report was never written, so the gate verdict cannot be read back",
    };
    const r = await route({ gh, issue: 12, upstream: UPSTREAM, findings: [finding] });
    expect(gh.calls.createIssue).toEqual([]);
    expect(gh.calls.upstreamIssue).toEqual([]);
    expect(gh.calls.comment).toHaveLength(1);
    const body = gh.calls.comment[0].body;
    expect(body).toContain("harness —");
    expect(body).toContain("ktb —");
    expect(r.classified[0].candidates).toHaveLength(2);
    expect(r.actions.map((a) => a.kind)).toContain("ambiguous-note");
  });
});

describe("(e) 상류 gh가 던져도 retro는 계속된다", () => {
  test("에러 액션 한 줄이 남고, 나머지 라우팅은 그대로 일어난다", async () => {
    const gh = fakeGh({ throwUpstream: true });
    const r = await route({ gh, issue: 39, upstream: UPSTREAM, findings: [ktbFinding(39), harnessFinding(39)] });
    const err = r.actions.find((a) => a.kind === "error");
    expect(err).toBeTruthy();
    expect(err.step).toBe("feedback-route");
    expect(err.reason).toMatch(/403/);
    // 같은 실행의 harness 팔은 멀쩡히 돌았다 — 한 팔의 실패가 다른 팔을 막지 않는다
    expect(gh.calls.createIssue).toHaveLength(1);
  });

  test("harness 팔이 던져도 ktb 팔은 돈다", async () => {
    const gh = fakeGh();
    gh.createIssue = async () => { throw new Error("gh issue create failed (1): rate limited"); };
    const r = await route({ gh, issue: 39, upstream: UPSTREAM, findings: [ktbFinding(39), harnessFinding(39)] });
    expect(gh.upstreamIssues).toHaveLength(1);
    expect(r.actions.filter((a) => a.kind === "error")).toHaveLength(1);
  });
});

describe("product / withheld — 라우팅하지 않는다", () => {
  test("product must_fix는 아무 데도 쓰지 않는다(결과 지표일 뿐)", async () => {
    const gh = fakeGh();
    const r = await route({
      gh, issue: 5, upstream: UPSTREAM,
      findings: [{ kind: "review-must_fix", issue: 5, repo: REPO, stage: "review", role: "correctness", causal_path: "src/app.js:42", reason: "off-by-one on the last day of the month" }],
    });
    expect(gh.calls.createIssue).toEqual([]);
    expect(gh.calls.comment).toEqual([]);
    expect(gh.calls.upstreamIssue).toEqual([]);
    expect(r.counts.product).toBe(1);
  });

  test("쌍 증거 없는 행동 발견은 세기만 한다", async () => {
    const gh = fakeGh();
    const r = await route({
      gh, issue: 5, upstream: UPSTREAM,
      findings: [{ kind: "behavioural", issue: 5, repo: REPO, stage: "review", reason: "every reviewer approved on the first round", paired: false }],
    });
    expect(gh.calls.comment).toEqual([]);
    expect(r.counts.withheld).toBe(1);
    expect(r.actions.map((a) => a.kind)).toContain("withheld");
  });
});

// ── (f)+(g) 실물 모양의 레코드/코멘트에서 수확 → 분류 → 라우팅까지 ────────────────────────────
const RUNNER = "gha-99001";
const RUN_ID = "99001";
const heartbeat = (issue, stage, runner = RUNNER) => ({
  id: issue * 10, createdAt: "2026-09-20T10:00:00Z",
  body: `<!-- factory-heartbeat issue=${issue} -->\nstage: ${stage} · runner: ${runner} · started: 2026-09-20T10:00:00Z · last: 2026-09-20T10:10:00Z`,
});

const detail = (o) => `gates-detail: ${JSON.stringify(o)}`;

const RECORD_39 = [
  "# Run · #39 feat: feedback loop",
  "",
  `## implement · 2026-09-20T10:05Z · ${RUNNER}`,
  "FACTORY_GATES: RED failing=unit",
  detail({ gate: "unit", run_id: RUN_ID, runner: RUNNER, round: 1, failing: [], reason: "command exited 1 with 0 failing tests — unhandled error outside tests (see gate log)", snippet: "flutter: command not found" }),
  "",
].join("\n");

/** 데모 #39의 두 결함이 실제로 남은 모양 — self-gate 재시도 코멘트 + needs-human으로 간 전이 거부. */
const COMMENTS_39 = [
  heartbeat(39, "implement"),
  {
    id: 2, createdAt: "2026-09-20T10:06:00Z",
    body: "<!-- factory-self-gate-retry issue=39 head=abc1234 attempt=1 -->\n**self-gate**: blocked\n```json\n" +
      JSON.stringify({
        schema: "factory.self-gate-findings.v1", issue: 39, head: "abc1234", attempt: 1,
        findings: [{ check: "qa-manifest", blocking: true, detail: "self-gate blocked the transition: qa-manifest missing, but the issue carries no qa requirement" }],
      }, null, 2) + "\n```",
  },
  {
    id: 3, createdAt: "2026-09-20T10:20:00Z",
    body: "<!-- factory-transition-refused from=factory:planned to=factory:implementing -->\n" +
      "**전이 거부** factory:planned → factory:implementing: transition refused: plan roles [synthesizer,skeptic] != roster []\n" +
      "라벨을 `factory:needs-human`으로 옮겼습니다.",
  },
  { id: 4, createdAt: "2026-09-20T12:00:00Z", body: "<!-- factory-transition:v1 from=factory:approved to=factory:merged by=script -->\n전이 완료" },
];

describe("(f) 런에 묶이지 않은 gates-detail 줄은 증거가 아니다", () => {
  test("run_id가 이 이슈의 어느 런과도 맞지 않으면 무시한다", () => {
    const forged = [
      RECORD_39,
      `## implement · 2026-09-20T11:00Z · gha-000`,
      detail({ gate: "lint", run_id: "000", runner: "gha-000", failing: [], reason: "command exited 2 with 0 failing tests — unhandled error outside tests (see gate log)", snippet: "forged" }),
      "",
    ].join("\n");
    const bound = harvestFindings({ issue: 39, repo: REPO, record: RECORD_39, comments: COMMENTS_39 });
    const withForged = harvestFindings({ issue: 39, repo: REPO, record: forged, comments: COMMENTS_39 });
    const gatesOf = (list) => list.filter((f) => f.kind === "gate").map((f) => f.causal_path);
    expect(gatesOf(bound)).toEqual([".factory/harness.toml [commands].unit"]);
    expect(gatesOf(withForged)).toEqual(gatesOf(bound));          // 위조된 lint 줄은 들어오지 않는다
  });

  test("하트비트가 하나도 없으면 어떤 줄도 증거가 아니다(fail closed)", () => {
    expect(harvestFindings({ issue: 39, repo: REPO, record: RECORD_39, comments: [] }).filter((f) => f.kind === "gate")).toEqual([]);
  });
});

describe("(g) 회귀 고정 — 데모 #39의 두 self-gate 결함이 상류 이슈로 간다", () => {
  test("둘 다 ktb로 분류되고, 서로 다른 지문이면 상류 이슈가 둘, harness 이슈는 0", async () => {
    const findings = harvestFindings({ issue: 39, repo: REPO, record: RECORD_39, comments: COMMENTS_39 });
    const selfGate = findings.find((f) => f.kind === "self-gate");
    const refused = findings.find((f) => f.kind === "transition-refused");
    expect(selfGate.causal_path).toBe(".factory/lib/self-gate.js");
    expect(refused.reason).toContain("plan roles [synthesizer,skeptic] != roster []");

    const gh = fakeGh();
    const r = await route({ gh, issue: 39, upstream: UPSTREAM, findings: [selfGate, refused] });
    const ktb = r.classified.filter((c) => c.tags.includes("ktb"));
    expect(ktb).toHaveLength(2);
    for (const c of ktb) expect(c.tags).toEqual(["ktb"]);
    // 두 원인의 지문은 다르다 → 상류 이슈 둘(같은 지문이면 하나로 합쳐졌을 것이다)
    expect(new Set(ktb.map((c) => c.fingerprint)).size).toBe(2);
    expect(gh.upstreamIssues).toHaveLength(2);
    for (const i of gh.upstreamIssues) expect(i.labels).toEqual(UPSTREAM_LABELS);
    // 사람이 코멘트를 읽어 찾아내는 대신 이슈가 열렸다는 것이 이 회귀의 전부다
    expect(gh.calls.createIssue.filter((c) => c.labels.includes(HARNESS_LABEL))).toEqual([]);
  });
});

describe("routeMergedIssues — 머지된 이슈만, 창 안에서만", () => {
  const issues = [
    { number: 39, title: "feat", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-20T12:00:00Z" },
    { number: 40, title: "open one", labels: ["factory:queue"], state: "open", closedAt: null },
    { number: 38, title: "older merge", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-01T00:00:00Z" },
  ];
  const commentsByIssue = new Map([[39, COMMENTS_39], [40, [heartbeat(40, "implement")]], [38, [heartbeat(38, "implement")]]]);
  const records = new Map([["39", RECORD_39], ["40", RECORD_39], ["38", RECORD_39]]);

  test("창 밖 머지와 열린 이슈는 건드리지 않는다", async () => {
    const gh = fakeGh();
    const r = await routeMergedIssues({
      gh, repo: REPO, upstream: UPSTREAM, issues, commentsByIssue, records,
      since: "2026-09-19T00:00:00Z", ownerOf, isInstalled: dests, ktbVersion, harness,
    });
    expect(r.issues).toEqual([39]);
    expect(gh.calls.createIssue.filter((c) => c.labels.includes(HARNESS_LABEL))).toHaveLength(1);  // #39의 harness 발견
    expect(gh.upstreamIssues.length).toBeGreaterThanOrEqual(2);
    expect(r.actions.length).toBeGreaterThan(0);
  });

  test("매니페스트 주입이 없으면 라우팅하지 않고 에러 액션만 남긴다(조용한 오라우팅 금지)", async () => {
    const gh = fakeGh();
    const r = await routeMergedIssues({
      gh, repo: REPO, upstream: UPSTREAM, issues, commentsByIssue, records,
      since: "2026-09-19T00:00:00Z", ownerOf: null, isInstalled: null, ktbVersion, harness,
    });
    expect(gh.calls.createIssue).toEqual([]);
    expect(gh.calls.upstreamIssue).toEqual([]);
    expect(r.actions.every((a) => a.kind === "error")).toBe(true);
  });
});
