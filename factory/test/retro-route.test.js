import { test, expect, describe } from "vitest";
import { fileURLToPath } from "node:url";
import { ownerOf, buildManifest } from "../cli/manifest.js";
import { routeFindings, routeMergedIssues, feedbackNoteMarker } from "../lib/feedback/route.js";
import { harvestFindings, SETUP_LOCUS, SELF_GATE_PATH } from "../lib/feedback/harvest-findings.js";
import { UPSTREAM_LABELS, parseUpstreamIssue, evidenceEntries } from "../lib/feedback/upstream-issue.js";
import { HARNESS_LABEL } from "../lib/harness-request.js";
import {
  RUNNER, gatesHarness, heartbeat, realGatesDetail, recordOf, refusalComment,
  reviewHandoffComment, selfGateComment, vitestReport,
} from "./helpers/feedback-fixtures.js";

/**
 * Task 3 — 라우팅 팔. 고정하는 계약은 **두 대상이 절대 섞이지 않는다**(spec §2), **같은 원인은 상류
 * 이슈 하나로 모인다**(§6), 그리고 T3 리뷰의 근본 교훈: **모든 픽스처는 진짜 생산자가 만든다**
 * (`helpers/feedback-fixtures.js`). 손으로 적은 모양은 생산자가 낼 수 없는 조합을 만들어 내고,
 * 그러면 테스트는 초록인 채 라우팅만 틀린다.
 */
const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
const dests = new Set(buildManifest({ pkgRoot }).map((e) => e.dest));
const ktbVersion = "1.3.2";
const harness = { test: { source_glob: ["src/**/*.js"], test_glob: ["test/**/*.test.js"] } };
const REPO = "LeeHyeonKyu/know-thy-build-demo";
const UPSTREAM = "LeeHyeonKyu/know_thy_build";

/** 실제 gh 어댑터의 모양만 흉내 낸다 — 열린 이슈 목록은 이 배열이 곧 저장소다(dedupe가 실제로 걸린다). */
function fakeGh({ upstreamIssues = [], throwUpstream = false } = {}) {
  const calls = { createIssue: [], comment: [], upstreamIssue: [], issueList: [] };
  let seq = 500;
  const local = [];
  return {
    calls, upstreamIssues, local,
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
    async editIssueBody(n, body) { const i = local.find((x) => x.number === n); if (i) i.body = body; },
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

// ── 실물 생산자로 만든 #39 ────────────────────────────────────────────────────────────────────
// 아래 세 조각은 데모 저장소 #39의 **실제 텍스트**에서 왔다
// (`gh api repos/LeeHyeonKyu/know-thy-build-demo/issues/39/comments` + records 브랜치의 39.md):
//   · self-gate 차단: check `contract`, detail `spec-evidence-missing: no qa evidence manifest at …`
//   · 전이 거부: `plan roles [synthesizer,skeptic] != roster []` → 라벨이 needs-human으로 이동
//   · `:unstick`의 `human-decision:v1`: "caused by two self-gate defects (fixed in know-thy-build 1.3.2)"
//   · run 기록의 self-gate 줄: `gates+contract → BLOCKED …` 뒤에 `gates → ok` (= contract가 거둬들여졌다)
const HEAD_39 = "9ddb6e54a93a61487658b2e7f9f85cd157d17ad8";
const RUNNER_39A = "gha-35503791948";
const RUNNER_39B = "gha-35506437572";

const RECORD_39 = recordOf(39, "Add GET /version endpoint returning the package version", [
  { stage: "implement", at: "2026-09-20T10:08Z", runner: RUNNER_39A, lines: [
    "verify: ok",
    "self-gate: gates+contract → BLOCKED — attempt 1 → factory:planned — contract: spec-evidence-missing: no qa evidence manifest at .factory/out/qa/39/manifest.json",
    "transition refused: plan roles [synthesizer,skeptic] != roster []",
    "FACTORY_GATES: level=full status=GREEN passed=4 failed=0 failing=none skipped=none misconfigured=none excluded=none",
  ] },
  { stage: "implement", at: "2026-09-20T11:02Z", runner: RUNNER_39B, lines: [
    "self-gate: gates → ok",
  ] },
]);

const COMMENTS_39 = [
  heartbeat(39, "implement", RUNNER_39A, "2026-09-20T09:59:50Z"),
  selfGateComment({
    issue: 39, head: HEAD_39, attempt: 1, at: "2026-09-20T10:08:46Z",
    findings: [{ check: "contract", blocking: true, ids: [], detail: "spec-evidence-missing: no qa evidence manifest at .factory/out/qa/39/manifest.json" }],
  }),
  refusalComment({ from: "factory:in-progress", to: "factory:planned", reason: "plan roles [synthesizer,skeptic] != roster []", at: "2026-09-20T10:08:48Z" }),
  { id: 5749358312, createdAt: "2026-09-20T10:56:14Z", body: [
    "<!-- human-decision:v1 issue=39 skill=unstick -->",
    "```yaml",
    "decision: retry",
    'reason: "needs-human was caused by two self-gate defects (fixed in know-thy-build 1.3.2, now installed): the implement self-gate demanded a qa manifest that only the review stage produces, and its one-retry route was refused. Re-running implement on the fixed factory."',
    "```",
  ].join("\n") },
  heartbeat(39, "implement", RUNNER_39B, "2026-09-20T10:56:55Z"),
  { id: 5749529498, createdAt: "2026-09-20T11:32:34Z", body: "<!-- factory-transition:v1 from=factory:approved to=factory:merged by=script -->\nfactory:approved → factory:merged" },
];

/** own-cal 계열의 하네스 RED — 실제로 `runGates`를 돌려 만든 `gates-detail:` 줄에서 수확한다. */
async function harnessGateFinding({ issue = 7, outcomes, report = null, commands } = {}) {
  const h = gatesHarness(commands ? { commands } : {});
  const { lines } = await realGatesDetail({ outcomes, report, harness: h });
  const record = recordOf(issue, "feat", [{ stage: "implement", at: "2026-09-20T10:05Z", lines }]);
  return harvestFindings({ issue, repo: REPO, record, comments: [heartbeat(issue, "implement")] });
}

const FLUTTER_NOT_FOUND = { code: 127, stdout: "", stderr: "/usr/bin/bash: line 1: flutter: command not found" };

describe("(a) harness 발견은 쓰는 저장소의 harness 이슈 하나로만 간다", () => {
  test("Flutter 툴체인 누락(exit 127) → harness 이슈 하나, 상류 호출 0", async () => {
    const findings = await harnessGateFinding({ outcomes: { unit: FLUTTER_NOT_FOUND } });
    expect(findings.map((f) => f.causal_path)).toContain(SETUP_LOCUS);
    const gh = fakeGh();
    const r = await route({ gh, issue: 7, upstream: UPSTREAM, findings });
    expect(gh.calls.createIssue).toHaveLength(1);
    expect(gh.calls.createIssue[0].labels).toEqual(["factory:queue", HARNESS_LABEL]);
    expect(gh.calls.createIssue[0].body).toContain("[runtime].setup");
    expect(gh.calls.upstreamIssue).toEqual([]);
    expect(r.actions.map((a) => a.kind)).toContain("harness-issue");
  });

  // 본문은 사실이어야 한다: 이 요청은 implement handoff의 `harness_needed`가 아니고, 가리키는
  // 이슈는 이미 머지됐다(`factory:merged`는 막다른 상태라 `Blocks:`는 거부되는 전이만 만든다).
  test("피드백 루프가 연 harness 이슈는 implement handoff를 사칭하지 않고 Blocks: 줄도 싣지 않는다", async () => {
    const findings = await harnessGateFinding({ outcomes: { unit: FLUTTER_NOT_FOUND } });
    const gh = fakeGh();
    await route({ gh, issue: 7, upstream: UPSTREAM, findings });
    const body = gh.calls.createIssue[0].body;
    expect(body).toContain("<!-- factory-harness-request for=7 -->");
    expect(body).toContain("피드백 루프");
    expect(body).not.toContain("harness_needed");
    expect(body).not.toMatch(/^Blocks: /m);
  });

  test("같은 이슈의 harness 발견이 둘이어도 이슈는 하나", async () => {
    const findings = await harnessGateFinding({
      outcomes: { unit: FLUTTER_NOT_FOUND, lint: { code: 127, stderr: "bash: line 1: dart: command not found" } },
    });
    expect(findings).toHaveLength(2);
    const gh = fakeGh();
    await route({ gh, issue: 7, upstream: UPSTREAM, findings });
    expect(gh.calls.createIssue).toHaveLength(1);
    expect(gh.calls.createIssue[0].body.match(/\n\| `/g)).toHaveLength(2);      // 표에 두 줄
  });
});

describe("(b) ktb 발견은 upstream 이슈 하나로 — 두 번째 머지는 증거를 덧붙인다", () => {
  const ktb39 = () => harvestFindings({ issue: 39, repo: REPO, record: RECORD_39, comments: COMMENTS_39 })
    .filter((f) => f.kind === "self-gate");

  test("첫 머지: fingerprint 마커 + UPSTREAM_LABELS를 단 이슈가 열린다", async () => {
    const gh = fakeGh();
    const r = await route({ gh, issue: 39, upstream: UPSTREAM, findings: ktb39() });
    expect(gh.upstreamIssues).toHaveLength(1);
    const opened = gh.upstreamIssues[0];
    expect(opened.labels).toEqual(UPSTREAM_LABELS);
    const parsed = parseUpstreamIssue(opened.body);
    expect(parsed.fingerprint).toBe(r.classified[0].fingerprint);
    expect(parsed.from).toBe(`${REPO}#39`);
    expect(gh.calls.createIssue).toEqual([]);               // 쓰는 저장소에는 아무것도 열지 않는다
  });

  test("같은 원인이 다른 이슈에서 다시 나오면 새 이슈가 아니라 증거가 붙는다", async () => {
    const gh = fakeGh();
    await route({ gh, issue: 39, upstream: UPSTREAM, findings: ktb39() });
    await route({ gh, issue: 41, upstream: UPSTREAM, findings: ktb39().map((f) => ({ ...f, issue: 41 })) });
    expect(gh.upstreamIssues).toHaveLength(1);
    const entries = evidenceEntries(gh.upstreamIssues[0].body);
    expect(entries).toHaveLength(2);
    expect(entries.join("\n")).toContain(`${REPO}#39`);
    expect(entries.join("\n")).toContain(`${REPO}#41`);
  });

  test("같은 머지를 두 번 돌아도 증거는 한 번만 쌓인다(멱등)", async () => {
    const gh = fakeGh();
    await route({ gh, issue: 39, upstream: UPSTREAM, findings: ktb39() });
    await route({ gh, issue: 39, upstream: UPSTREAM, findings: ktb39() });
    expect(gh.upstreamIssues).toHaveLength(1);
    expect(evidenceEntries(gh.upstreamIssues[0].body)).toHaveLength(1);
  });
});

describe("(c) upstream 미설정 — 로컬 코멘트만, 교차 저장소 호출 0", () => {
  const ktb39 = () => harvestFindings({ issue: 39, repo: REPO, record: RECORD_39, comments: COMMENTS_39 }).filter((f) => f.kind === "self-gate");

  test("코멘트 하나, upstreamIssue 호출 0, harness 이슈 0", async () => {
    const gh = fakeGh();
    const r = await route({ gh, issue: 39, upstream: null, findings: ktb39() });
    expect(gh.calls.upstreamIssue).toEqual([]);
    expect(gh.calls.createIssue).toEqual([]);
    expect(gh.calls.comment).toHaveLength(1);
    expect(gh.calls.comment[0].body).toContain(feedbackNoteMarker(r.classified[0].fingerprint));
    expect(gh.calls.comment[0].body).toMatch(/upstream/);
  });

  test("같은 마커가 이미 이슈에 있으면 다시 쓰지 않는다", async () => {
    const first = await route({ gh: fakeGh(), issue: 39, upstream: null, findings: ktb39() });
    const gh2 = fakeGh();
    await route({ gh: gh2, issue: 39, upstream: null, findings: ktb39(), existingComments: [{ body: feedbackNoteMarker(first.classified[0].fingerprint) }] });
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
    expect(gh.calls.comment[0].body).toContain("harness —");
    expect(gh.calls.comment[0].body).toContain("ktb —");
    expect(r.classified[0].candidates).toHaveLength(2);
    expect(r.actions.map((a) => a.kind)).toContain("ambiguous-note");
    expect(r.actions.find((a) => a.kind === "ambiguous-summary").count).toBe(1);
  });
});

describe("(e) 상류 gh가 던져도 retro는 계속된다", () => {
  test("에러 액션 한 줄이 남고, 나머지 라우팅은 그대로 일어난다", async () => {
    const gh = fakeGh({ throwUpstream: true });
    const ktb = harvestFindings({ issue: 39, repo: REPO, record: RECORD_39, comments: COMMENTS_39 }).filter((f) => f.kind === "self-gate");
    const harnessFindings = await harnessGateFinding({ issue: 39, outcomes: { unit: FLUTTER_NOT_FOUND } });
    const r = await route({ gh, issue: 39, upstream: UPSTREAM, findings: [...ktb, ...harnessFindings] });
    const err = r.actions.find((a) => a.kind === "error");
    expect(err.step).toBe("feedback-route");
    expect(err.reason).toMatch(/403/);
    expect(gh.calls.createIssue).toHaveLength(1);           // 같은 실행의 harness 팔은 멀쩡히 돌았다
  });

  test("harness 팔이 던져도 ktb 팔은 돈다", async () => {
    const gh = fakeGh();
    gh.createIssue = async () => { throw new Error("gh issue create failed (1): rate limited"); };
    const ktb = harvestFindings({ issue: 39, repo: REPO, record: RECORD_39, comments: COMMENTS_39 }).filter((f) => f.kind === "self-gate");
    const harnessFindings = await harnessGateFinding({ issue: 39, outcomes: { unit: FLUTTER_NOT_FOUND } });
    const r = await route({ gh, issue: 39, upstream: UPSTREAM, findings: [...ktb, ...harnessFindings] });
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

describe("(f) 런에 묶이지 않은 gates-detail 줄은 증거가 아니다", () => {
  test("run_id가 이 이슈의 어느 런과도 맞지 않으면 무시한다", async () => {
    const { lines } = await realGatesDetail({ outcomes: { unit: FLUTTER_NOT_FOUND } });
    const { lines: forgedLines } = await realGatesDetail({
      outcomes: { unit: { code: 127, stderr: "bash: line 1: forged: command not found" } },
      stamp: { runId: "000", runnerId: "gha-000" },
    });
    const comments = [heartbeat(7, "implement")];
    const clean = recordOf(7, "feat", [{ stage: "implement", at: "2026-09-20T10:05Z", lines }]);
    const forged = recordOf(7, "feat", [
      { stage: "implement", at: "2026-09-20T10:05Z", lines },
      { stage: "implement", at: "2026-09-20T11:00Z", runner: "gha-000", lines: forgedLines },
    ]);
    const of = (rec) => harvestFindings({ issue: 7, repo: REPO, record: rec, comments }).filter((f) => f.kind === "gate");
    expect(of(clean)).toHaveLength(1);
    expect(of(forged)).toHaveLength(1);                     // 위조된 줄은 들어오지 않는다
  });

  test("하트비트가 하나도 없으면 어떤 줄도 증거가 아니다(fail closed)", async () => {
    const { lines } = await realGatesDetail({ outcomes: { unit: FLUTTER_NOT_FOUND } });
    const record = recordOf(7, "feat", [{ stage: "implement", at: "2026-09-20T10:05Z", lines }]);
    expect(harvestFindings({ issue: 7, repo: REPO, record, comments: [] }).filter((f) => f.kind === "gate")).toEqual([]);
  });
});

describe("(g) 회귀 고정 — 데모 #39의 두 결함이 상류 이슈로 간다 (실물 텍스트)", () => {
  test("둘 다 ktb, 서로 다른 지문 → 상류 이슈 둘, harness 이슈 0", async () => {
    const findings = harvestFindings({ issue: 39, repo: REPO, record: RECORD_39, comments: COMMENTS_39 });
    const selfGate = findings.find((f) => f.kind === "self-gate");
    const refused = findings.find((f) => f.kind === "transition-refused");
    // 실제 #39의 검사 이름은 `contract`였다(`qa-manifest`라는 검사는 존재한 적이 없다).
    expect(selfGate.reason).toContain("spec-evidence-missing");
    expect(selfGate.causal_path).toBe(SELF_GATE_PATH);
    expect(selfGate.extra.attribution).toEqual(expect.arrayContaining(["human-decision", "check-withdrawn"]));
    expect(refused.reason).toBe("plan roles [synthesizer,skeptic] != roster []");

    const gh = fakeGh();
    const r = await route({ gh, issue: 39, upstream: UPSTREAM, findings: [selfGate, refused] });
    const ktb = r.classified.filter((c) => c.tags.includes("ktb"));
    expect(ktb).toHaveLength(2);
    for (const c of ktb) expect(c.tags).toEqual(["ktb"]);
    expect(new Set(ktb.map((c) => c.fingerprint)).size).toBe(2);
    expect(gh.upstreamIssues).toHaveLength(2);
    for (const i of gh.upstreamIssues) expect(i.labels).toEqual(UPSTREAM_LABELS);
    // 사람이 코멘트를 읽어 찾아내는 대신 이슈가 열렸다는 것이 이 회귀의 전부다
    expect(gh.calls.createIssue.filter((c) => c.labels.includes(HARNESS_LABEL))).toEqual([]);
  });

  // MF-1의 반대편: 귀속 증거가 없으면 **같은 모양의 차단**이 ktb로 가지 않는다.
  test("`human-decision`도 `check-withdrawn`도 없으면 같은 #39 차단은 ktb가 아니다", async () => {
    const noEvidence = COMMENTS_39.filter((c) => !String(c.body).includes("human-decision:v1"));
    const recordNoWithdraw = recordOf(39, "x", [{ stage: "implement", at: "2026-09-20T10:08Z", runner: RUNNER_39A, lines: [
      "self-gate: gates+contract → BLOCKED — attempt 1 → factory:planned — contract: spec-evidence-missing: …",
    ] }]);
    const findings = harvestFindings({ issue: 39, repo: REPO, record: recordNoWithdraw, comments: noEvidence });
    // 차단이 스스로 지목한 파일이 없으므로 발견으로도 내지 않는다(경로 없는 노트를 만들지 않는다).
    expect(findings.filter((f) => f.kind === "self-gate")).toEqual([]);
    // 거부도 마찬가지 — 엔진 주소를 무조건 박지 않는다.
    expect(findings.filter((f) => f.kind === "transition-refused")).toEqual([]);
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
  const args = { repo: REPO, upstream: UPSTREAM, issues, commentsByIssue, records, since: "2026-09-19T00:00:00Z", ownerOf, isInstalled: dests, ktbVersion, harness };

  test("창 밖 머지와 열린 이슈는 건드리지 않는다", async () => {
    const gh = fakeGh();
    const r = await routeMergedIssues({ gh, ...args });
    expect(r.issues).toEqual([39]);
    expect(gh.upstreamIssues).toHaveLength(2);
    expect(r.actions.length).toBeGreaterThan(0);
  });

  test("매니페스트 주입이 없으면 라우팅하지 않고 에러 액션만 남긴다(조용한 오라우팅 금지)", async () => {
    const gh = fakeGh();
    const r = await routeMergedIssues({ gh, ...args, ownerOf: null, isInstalled: null });
    expect(gh.calls.createIssue).toEqual([]);
    expect(gh.calls.upstreamIssue).toEqual([]);
    expect(r.actions.every((a) => a.kind === "error")).toBe(true);
  });

  // SF-4 — 같은 머지는 창 안에서 여러 번 다시 읽힌다(커서는 full 회차에만 전진한다). 상류 이슈를
  // 사람이 닫아도 두 번째 이슈가 열리면 안 된다: 출처 이슈 쪽 마커가 그것을 막는다.
  test("사람이 상류 이슈를 닫아도 같은 머지가 새 이슈를 열지 않는다", async () => {
    const gh = fakeGh();
    await routeMergedIssues({ gh, ...args });
    const opened = gh.upstreamIssues.length;
    gh.upstreamIssues.length = 0;                            // 사람이 전부 닫았다(열린 검색에 안 잡힌다)
    const again = await routeMergedIssues({ gh, ...args, commentsByIssue: new Map([[39, [...COMMENTS_39, ...gh.calls.comment.map((c) => ({ body: c.body }))]]]) });
    expect(gh.upstreamIssues).toHaveLength(0);
    expect(again.actions.filter((a) => a.kind === "routed-already").length).toBe(opened);
  });
});
