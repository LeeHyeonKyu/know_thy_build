import { test, expect, describe } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { ownerOf, buildManifest } from "../cli/manifest.js";
import { routeFindings, routeMergedIssues, feedbackNoteMarker } from "../lib/feedback/route.js";
import { attributionFor, harvestFindings, harvestIssue, SETUP_LOCUS, SELF_GATE_PATH } from "../lib/feedback/harvest-findings.js";
import { sharedIdentityWarning } from "../bin/retro.js";
import { UPSTREAM_LABELS, parseUpstreamIssue, evidenceEntries } from "../lib/feedback/upstream-issue.js";
import { HARNESS_LABEL } from "../lib/harness-request.js";
import {
  RUNNER, gatesHarness, heartbeat, humanDecisionComment, realGatesDetail, recordOf, refusalComment,
  reviewHandoffComment, selfGateComment, selfGateDetail, vitestReport,
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
// 아래 조각들은 데모 저장소 #39의 **실제 텍스트**에서 왔다
// (`gh api repos/LeeHyeonKyu/know-thy-build-demo/issues/39/comments` + records 브랜치의 39.md):
//   · self-gate 차단: check `contract`, detail `spec-evidence-missing: no qa evidence manifest at …`
//   · 전이 거부: `plan roles [synthesizer,skeptic] != roster []` → 라벨이 needs-human으로 이동
//   · `:unstick`의 `human-decision:v1`: 사람이 쓴 **산문만** 있고 `cause:` 필드는 없다(그 필드는
//     이번 라운드에 생겼다) — 그래서 #39는 (b)가 아니라 **(c)만으로** ktb에 도달해야 한다.
//   · 두 implement 런: 1.3.1에서 `gates+contract`가 막았고, 데모를 1.3.2로 올린 뒤의 런은
//     `contract`를 아예 돌리지 않았다(`ran: ["gates"]`, `skipped`에도 없다) = 검사가 거둬들여졌다.
// `self-gate-detail:` 줄 자체는 이 라운드에 생긴 계약이라 #39의 원본에는 없다 — 그래서 **진짜
// 생산자**(`selfGateDetailLine`)에 #39가 실제로 가졌던 값을 먹여 만든다.
const HEAD_39 = "9ddb6e54a93a61487658b2e7f9f85cd157d17ad8";
const RUNNER_39A = "gha-35503791948";
const RUNNER_39B = "gha-35506437572";

const RECORD_39 = recordOf(39, "Add GET /version endpoint returning the package version", [
  { stage: "implement", at: "2026-09-20T10:08Z", runner: RUNNER_39A, lines: [
    "verify: ok",
    "self-gate: gates+contract → BLOCKED — attempt 1 → factory:planned — contract: spec-evidence-missing: no qa evidence manifest at .factory/out/qa/39/manifest.json",
    selfGateDetail({ ran: ["gates", "contract"], blocked: true, ktbVersion: "1.3.1", runner: RUNNER_39A, runId: "35503791948" }),
    "transition refused: plan roles [synthesizer,skeptic] != roster []",
    "FACTORY_GATES: level=full status=GREEN passed=4 failed=0 failing=none skipped=none misconfigured=none excluded=none",
  ] },
  { stage: "implement", at: "2026-09-20T11:02Z", runner: RUNNER_39B, lines: [
    "self-gate: gates → ok",
    selfGateDetail({ ran: ["gates"], skipped: ["mutation", "pins"], ktbVersion: "1.3.2", runner: RUNNER_39B, runId: "35506437572" }),
  ] },
]);

const COMMENTS_39 = [
  heartbeat(39, "implement", RUNNER_39A, "2026-09-20T09:59:50Z"),
  selfGateComment({
    issue: 39, head: HEAD_39, attempt: 1, at: "2026-09-20T10:08:46Z",
    findings: [{ check: "contract", blocking: true, ids: [], detail: "spec-evidence-missing: no qa evidence manifest at .factory/out/qa/39/manifest.json" }],
  }),
  refusalComment({ from: "factory:in-progress", to: "factory:planned", reason: "plan roles [synthesizer,skeptic] != roster []", at: "2026-09-20T10:08:48Z" }),
  // #39의 실제 unstick — 사람(LeeHyeonKyu)이 썼지만 `cause:` 필드가 없다. 산문은 증거가 아니다.
  humanDecisionComment({
    issue: 39, id: 5749358312, at: "2026-09-20T10:56:14Z", author: "LeeHyeonKyu",
    reason: "needs-human was caused by two self-gate defects (fixed in know-thy-build 1.3.2, now installed): the implement self-gate demanded a qa manifest that only the review stage produces, and its one-retry route was refused. Re-running implement on the fixed factory.",
  }),
  heartbeat(39, "implement", RUNNER_39B, "2026-09-20T10:56:55Z"),
  { id: 5749529498, createdAt: "2026-09-20T11:32:34Z", author: "factory-bot", body: "<!-- factory-transition:v1 from=factory:approved to=factory:merged by=script -->\nfactory:approved → factory:merged" },
];
/** 팩토리 계정 이름 — `human-decision:v1`의 작성자가 이 중 하나면 그 결정은 사람의 것이 아니다. */
const FACTORY_LOGINS = ["factory-bot"];
const harvest39 = (over = {}) => harvestFindings({ issue: 39, repo: REPO, record: RECORD_39, comments: COMMENTS_39, factoryLogins: FACTORY_LOGINS, ...over });

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
  const ktb39 = () => harvest39().filter((f) => f.kind === "self-gate");

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
  const ktb39 = () => harvest39().filter((f) => f.kind === "self-gate");

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
    const ktb = harvest39().filter((f) => f.kind === "self-gate");
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
    const ktb = harvest39().filter((f) => f.kind === "self-gate");
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
  // #39의 실제 `:unstick` 코멘트는 **산문뿐**이다(`cause:` 필드는 이번 라운드에 생겼다). 그래서
  // 오늘의 실물 #39에서 (b)는 성립하지 않고, self-gate 차단은 (c) 하나로 ktb에 간다. 전이 거부는
  // 검사 이름이 없어 (c)가 닿지 않으므로 **사람이 `cause: factory-defect`를 적어야** 간다 —
  // 두 경우를 모두 못 박는다(오늘의 실물 그대로, 그리고 `:unstick`이 그 필드를 쓰게 된 뒤).
  test("(c)만으로: self-gate 차단은 상류 이슈 하나, harness 이슈 0", async () => {
    const findings = harvest39();
    const selfGate = findings.find((f) => f.kind === "self-gate");
    // 실제 #39의 검사 이름은 `contract`였다(`qa-manifest`라는 검사는 존재한 적이 없다).
    expect(selfGate.reason).toContain("spec-evidence-missing");
    expect(selfGate.causal_path).toBe(SELF_GATE_PATH);
    expect(selfGate.extra.attribution).toEqual(["check-withdrawn"]);
    // 산문뿐인 unstick은 전이 거부를 열지 못한다 — 그 거부의 유일한 문은 (b)다
    expect(findings.find((f) => f.kind === "transition-refused")).toBeUndefined();

    const gh = fakeGh();
    const r = await route({ gh, issue: 39, upstream: UPSTREAM, findings });
    const ktb = r.classified.filter((c) => c.tags.includes("ktb"));
    expect(ktb).toHaveLength(1);
    expect(ktb[0].tags).toEqual(["ktb"]);
    expect(gh.upstreamIssues).toHaveLength(1);
    expect(gh.upstreamIssues[0].labels).toEqual(UPSTREAM_LABELS);
    // 사람이 코멘트를 읽어 찾아내는 대신 이슈가 열렸다는 것이 이 회귀의 전부다
    expect(gh.calls.createIssue.filter((c) => c.labels.includes(HARNESS_LABEL))).toEqual([]);
  });

  test("`cause: factory-defect`를 적은 unstick이면 두 결함이 상류 이슈 둘이 된다", async () => {
    const withCause = COMMENTS_39.map((c) => (String(c.body).includes("human-decision:v1")
      ? humanDecisionComment({ issue: 39, author: "LeeHyeonKyu", cause: "factory-defect", ktbFix: "1.3.2", at: c.createdAt, reason: "the implement self-gate demanded a qa manifest only review produces, and its one-retry route was refused" })
      : c));
    const findings = harvest39({ comments: withCause });
    const selfGate = findings.find((f) => f.kind === "self-gate");
    const refused = findings.find((f) => f.kind === "transition-refused");
    expect(selfGate.extra.attribution).toEqual(expect.arrayContaining(["human-decision", "check-withdrawn"]));
    expect(refused.reason).toBe("plan roles [synthesizer,skeptic] != roster []");
    expect(refused.causal_path).toBe(".factory/lib/requirements.js");

    const gh = fakeGh();
    const r = await route({ gh, issue: 39, upstream: UPSTREAM, findings: [selfGate, refused] });
    const ktb = r.classified.filter((c) => c.tags.includes("ktb"));
    expect(ktb).toHaveLength(2);
    for (const c of ktb) expect(c.tags).toEqual(["ktb"]);
    expect(new Set(ktb.map((c) => c.fingerprint)).size).toBe(2);
    expect(gh.upstreamIssues).toHaveLength(2);
    for (const i of gh.upstreamIssues) expect(i.labels).toEqual(UPSTREAM_LABELS);
    expect(gh.calls.createIssue.filter((c) => c.labels.includes(HARNESS_LABEL))).toEqual([]);
  });

  // #39의 실제 unstick은 **산문뿐**이다(`cause:` 필드가 없다) — 그래서 (b)는 성립하지 않고,
  // ktb에 도달하는 경로는 (c) 하나뿐이어야 한다. 그 사실을 여기서 못 박는다.
  test("#39는 (b)가 아니라 (c) check-withdrawn **하나만으로** ktb에 도달한다", () => {
    const selfGate = harvest39().find((f) => f.kind === "self-gate");
    expect(selfGate.extra.attribution).toEqual(["check-withdrawn"]);
    expect(selfGate.extra.chain_evidence.join(" ")).toMatch(/ktb 1\.3\.1.*newer ktb 1\.3\.2/);
    // 사람의 산문이 "self-gate defects (fixed in 1.3.2)"라고 말해도 그 자체로는 아무 문도 열지 않는다
    expect(harvest39({ record: "" }).filter((f) => f.kind === "self-gate")).toEqual([]);
  });

  // MF-1의 반대편: 귀속 증거가 없으면 **같은 모양의 차단**이 ktb로 가지 않는다.
  test("`human-decision`도 `check-withdrawn`도 없으면 같은 #39 차단은 ktb가 아니다", () => {
    const noEvidence = COMMENTS_39.filter((c) => !String(c.body).includes("human-decision:v1"));
    const recordNoWithdraw = recordOf(39, "x", [{ stage: "implement", at: "2026-09-20T10:08Z", runner: RUNNER_39A, lines: [
      selfGateDetail({ ran: ["gates", "contract"], blocked: true, ktbVersion: "1.3.1", runner: RUNNER_39A, runId: "35503791948" }),
    ] }]);
    const findings = harvestFindings({ issue: 39, repo: REPO, record: recordNoWithdraw, comments: noEvidence, factoryLogins: FACTORY_LOGINS });
    // 차단이 스스로 지목한 파일이 없으므로 발견으로도 내지 않는다(경로 없는 노트를 만들지 않는다).
    expect(findings.filter((f) => f.kind === "self-gate")).toEqual([]);
    // 거부도 마찬가지 — 엔진 주소를 무조건 박지 않는다.
    expect(findings.filter((f) => f.kind === "transition-refused")).toEqual([]);
  });
});

// ── T7: 공유 신원 — **거부는 판정을 안 바꾸고, 침묵만 바꾼다** ──────────────────────────────
//
// 표본은 데모 #39의 **실제 코멘트 전문**이다(`fixtures/demo-39-comments.json`, `gh api`로 받아 적었다).
// 그 22개 코멘트의 작성자는 **전부 `LeeHyeonKyu` (type User)**다 — `FACTORY_BOT_TOKEN`이 소유자의
// PAT이기 때문이다. 곧 하트비트(러너가 쓴다)와 `:unstick`의 결정(사람이 쓴다)이 같은 작성자이고,
// `attributionFor`는 그 결정을 **증거로 셀 수 없다**. 그 판정은 옳다(에이전트가 적은 결정을 통과시키면
// 그 한 줄이 상류 쓰기를 연다). 이 라운드가 고치는 것은 그 거부가 **한 줄도 안 남는다**는 사실이다.
describe("T7 공유 신원 — (b) 거부를 보이게 한다", () => {
  const REAL_39 = JSON.parse(readFileSync(new URL("./fixtures/demo-39-comments.json", import.meta.url), "utf8"));

  test("픽스처는 실물이다: #39의 모든 코멘트가 한 사람 계정(LeeHyeonKyu/User)에서 나왔다", () => {
    expect(REAL_39.comments.length).toBeGreaterThan(0);
    expect([...new Set(REAL_39.comments.map((c) => `${c.author}:${c.authorType}`))]).toEqual(["LeeHyeonKyu:User"]);
    // GitHub App을 통한 코멘트가 하나도 없다 = 팩토리와 사람을 가를 두 번째 사실도 없다.
    expect(REAL_39.comments.every((c) => c.viaApp === null)).toBe(true);
    // 그리고 그 계정이 하트비트(러너만 쓰는 산출물)도 썼다 — 이것이 "공유 신원"의 정의다.
    expect(REAL_39.comments.some((c) => c.body.indexOf("<!-- factory-heartbeat") === 0)).toBe(true);
  });

  /**
   * 오늘의 `:unstick`이 이 멈춤에 대해 쓸 코멘트 — 모양은 스킬 템플릿(`templates/know-thy-build/unstick.md`
   * "`cause:` — 멈춤의 **책임**을 한 필드로 적는다")이 정하고, 값은 #39의 **실제** 결정에서 왔다
   * (decision/reason은 실물 코멘트 5749358312 그대로, `cause`/`ktb_fix`는 그 산문이 말하던 것을
   * 이번 라운드에 생긴 필드로 옮긴 것이다). 작성자는 물론 소유자 — 그래서 팩토리 로그인과 같다.
   */
  const realDecision = REAL_39.comments.find((c) => /human-decision:v1/.test(c.body));
  /** 실물 본문에서 그 줄을 그대로 읽어 온다 — 생산자의 기본값에 기대면 표본이 더는 #39가 아니다. */
  const fieldOf = (name) => {
    const m = new RegExp(`^${name}: (.*)$`, "m").exec(realDecision.body);
    expect(m, `#39's real human-decision must carry a \`${name}:\` line`).not.toBeNull();
    return m[1].trim().replace(/^"|"$/g, "");
  };
  const unstickToday = humanDecisionComment({
    issue: 39, id: realDecision.id, at: realDecision.createdAt, author: realDecision.author,
    skill: /skill=(\S+?)\s*-->/.exec(realDecision.body)?.[1] ?? "unstick",
    cause: "factory-defect", ktbFix: "1.3.2",
    decision: fieldOf("decision"), reason: fieldOf("reason"),
  });
  const sharedComments = [...REAL_39.comments.filter((c) => c.id !== realDecision.id), unstickToday];

  test("Pin 1 — factoryLogins=[LeeHyeonKyu]: 결정은 `unverifiable` 한 건이 되고 증거로는 세어지지 않는다", () => {
    const a = attributionFor({ comments: sharedComments, factoryLogins: ["LeeHyeonKyu"] });
    expect(a.unverifiable).toHaveLength(1);
    expect(a.unverifiable[0]).toMatchObject({
      kind: "human-decision", status: "unverifiable", check: null, author: "LeeHyeonKyu",
      reason: "shared identity — author equals a factory login; cannot distinguish a person from an agent",
    });
    // 세지 않는다 — 보이게 하는 것과 증거로 세는 것은 다른 일이다.
    expect(a.evidenceFor(null).filter((e) => e.kind === "human-decision")).toEqual([]);
    expect(a.evidenceFor("contract").filter((e) => e.kind === "human-decision")).toEqual([]);
  });

  test("Pin 1 — #39의 분류는 그대로다: (c) check-withdrawn **하나만으로** ktb에 도달한다", () => {
    const { findings, unverifiable } = harvestIssue({ issue: 39, repo: REPO, record: RECORD_39, comments: sharedComments, factoryLogins: ["LeeHyeonKyu"] });
    const selfGate = findings.find((f) => f.kind === "self-gate");
    expect(selfGate.extra.attribution).toEqual(["check-withdrawn"]);
    // 거부된 결정은 발견이 아니다 — 그래서 **두 번째 키**로 나온다(회고·analyze·health가 보여 준다).
    expect(unverifiable).toHaveLength(1);
    expect(findings.some((f) => f.extra?.attribution?.includes?.("human-decision"))).toBe(false);
    // 얇은 래퍼는 발견만 돌려준다 — 기존 호출자와 `toEqual([...])` 핀이 그대로 성립한다.
    expect(harvestFindings({ issue: 39, repo: REPO, record: RECORD_39, comments: sharedComments, factoryLogins: ["LeeHyeonKyu"] })).toEqual(findings);
  });

  /**
   * 리뷰 should_fix 1 — 1차 구현은 `unverifiable`을 배열의 **열거 불가 속성**으로 실었다. 그러면
   * 중간에 배열을 한 번 베끼는 호출자가 생기는 날(`spread`·`map`·`filter`·`JSON`) 이 태스크의 전부가
   * 조용히 사라진다. 평범한 객체의 두 키는 그 사고를 구조적으로 못 내게 한다.
   */
  test("`harvestIssue`의 두 키는 spread·map·JSON을 지나도 살아남는다", () => {
    const h = harvestIssue({ issue: 39, repo: REPO, record: RECORD_39, comments: sharedComments, factoryLogins: ["LeeHyeonKyu"] });
    expect({ ...h }.unverifiable).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(h)).unverifiable).toHaveLength(1);
    expect(h.unverifiable.map((u) => u.author)).toEqual(["LeeHyeonKyu"]);
  });

  test("Pin 2 — 대조군: factoryLogins=[factory-bot]이면 같은 결정이 증거 (b)로 세어진다", () => {
    const a = attributionFor({ comments: sharedComments, factoryLogins: ["factory-bot"] });
    expect(a.unverifiable).toEqual([]);
    const hd = a.evidenceFor(null).filter((e) => e.kind === "human-decision");
    expect(hd).toHaveLength(1);
    expect(hd[0].detail).toMatch(/ktb_fix: 1\.3\.2/);
  });

  test("Pin 3 — 경보는 `personal === true`일 때만, 런당 한 번", () => {
    expect(sharedIdentityWarning({ personal: true, login: "LeeHyeonKyu" })).toEqual({
      kind: "warning", step: "feedback-route", login: "LeeHyeonKyu",
      reason: "factory identity is a personal account (LeeHyeonKyu) — author-based attribution (human-decision) is disabled; register a machine user or GitHub App as the factory identity",
    });
    expect(sharedIdentityWarning({ personal: false, login: "factory-bot" })).toBeNull();
    // 모르는 것은 경보의 근거가 아니다 — `null`은 "괜찮다"도 "문제다"도 아니다.
    expect(sharedIdentityWarning({ personal: null, login: "factory-bot" })).toBeNull();
    expect(sharedIdentityWarning(null)).toBeNull();
  });

  test("거부는 이슈마다 라우팅 액션 한 줄로 남는다 — 발견이 0건인 이슈에서도", async () => {
    const gh = fakeGh();
    const r = await routeMergedIssues({
      gh, repo: REPO, upstream: UPSTREAM, ownerOf, isInstalled: dests, ktbVersion, harness,
      issues: [{ number: 39, title: "feat", labels: ["factory:merged"], state: "closed", closedAt: "2026-09-20T12:00:00Z" }],
      commentsByIssue: new Map([[39, sharedComments]]),
      records: new Map(),                                             // 기록이 없다 = 발견 0건
      since: "2026-09-19T00:00:00Z", factoryLogins: ["LeeHyeonKyu"],
    });
    const notes = r.actions.filter((a) => a.kind === "unverifiable-decision");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ step: "feedback-route", issue: 39, author: "LeeHyeonKyu" });
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
    // 오늘의 실물 #39: self-gate 차단 하나만 (c)로 상류에 간다(전이 거부의 문은 (b)이고, 그
    // 이슈의 `:unstick`에는 `cause:` 필드가 없다 — 그 필드는 이번 라운드에 생겼다).
    expect(gh.upstreamIssues).toHaveLength(1);
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

/**
 * ── 재리뷰 NEW-MF-1/2 — `ktb`로 가는 **유일한 문**의 두 구멍을 막는 회귀 ─────────────────────────
 * 두 시나리오 모두 재리뷰가 진짜 생산자로 시연한 것이고, 둘 다 "공장이 제 일을 한 것"이 KTB의
 * 엔진 결함으로 상류에 열리는 결과였다(Global Constraint 1 위반).
 */
describe("attribution의 두 구멍 (재리뷰 NEW-MF-1/2)", () => {
  const survivor = { check: "mutation", blocking: true, detail: "survivor: test/date.test.js asserts nothing under mutation (return null in src/date.js)" };
  const blocked = selfGateComment({ issue: 9, head: "abc1234", attempt: 1, at: "2026-09-20T10:00:00Z", findings: [survivor] });
  const harvest9 = (record, extra = [], logins = FACTORY_LOGINS) =>
    harvestFindings({ issue: 9, repo: REPO, record, comments: [heartbeat(9, "implement"), blocked, ...extra], factoryLogins: logins })
      .filter((f) => f.kind === "self-gate");
  const cls = (f) => routeFindings({ gh: fakeGh(), repo: REPO, issue: 9, findings: [f], upstream: null, ownerOf, isInstalled: dests, ktbVersion, harness });
  const two = (a, b) => recordOf(9, "x", [
    { stage: "implement", at: "2026-09-20T10:00Z", lines: [selfGateDetail(a)] },
    { stage: "implement", at: "2026-09-20T11:00Z", lines: [selfGateDetail(b)] },
  ]);

  // NEW-MF-1 (1) — 빌더가 막힌 **테스트를 지우면** `addedTests`가 비고 다음 런에서 mutation이 사라진다.
  // 그 사라짐은 "KTB가 거둬들였다"가 아니라 "이번 라운드에 볼 것이 없었다"이고, 이제 줄이 그것을 말한다.
  test("delete-the-test: 다음 런에 mutation이 `skipped: no-input`이면 survivor는 product다", async () => {
    const [f] = harvest9(two(
      { ran: ["gates", "mutation"], blocked: true, ktbVersion: "1.3.2" },
      { ran: ["gates"], skipped: ["mutation"], ktbVersion: "1.3.2" },
    ));
    expect(f.causal_path).toBe("test/date.test.js");
    expect(f.extra.attribution).toBe("none");
    const r = await cls(f);
    expect(r.classified[0]).toMatchObject({ tags: ["product"], disposition: "outcome" });
    expect(r.counts.product).toBe(1);
  });

  // NEW-MF-1 (2) — `skipped`에 적히지 않았더라도 **KTB 버전이 그대로**면 거둬들여진 것이 아니다.
  // 빌더는 테스트를 지울 수 있어도 설치된 팩토리의 버전을 올릴 수는 없다.
  test("같은 ktb 버전에서 검사가 사라진 것은 증거가 아니다 — 버전이 오르면 (c)가 된다", async () => {
    const same = await cls(harvest9(two(
      { ran: ["gates", "mutation"], blocked: true, ktbVersion: "1.3.2" },
      { ran: ["gates"], ktbVersion: "1.3.2" },
    ))[0]);
    expect(same.classified[0]).toMatchObject({ tags: ["product"], disposition: "outcome" });
    const upgraded = await cls(harvest9(two(
      { ran: ["gates", "mutation"], blocked: true, ktbVersion: "1.3.2" },
      { ran: ["gates"], ktbVersion: "1.4.0" },
    ))[0]);
    expect(upgraded.classified[0]).toMatchObject({ tags: ["ktb"], disposition: "routed" });
  });

  // NEW-MF-1 (3) — 증거는 **검사 이름으로 묶인다**: `pins`의 withdrawal이 `mutation`을 올리지 않는다.
  test("다른 검사의 withdrawal은 이 finding을 승격시키지 않는다", async () => {
    const r = await cls(harvest9(two(
      { ran: ["gates", "mutation", "pins"], blocked: true, ktbVersion: "1.3.2" },
      { ran: ["gates", "mutation"], ktbVersion: "1.4.0" },
    ))[0]);
    expect(r.classified[0]).toMatchObject({ tags: ["product"], disposition: "outcome" });
  });

  // NEW-MF-2 (1) — `gh issue comment`는 열려 있다. 에이전트가 적은 "사람의 결정"은 결정이 아니다.
  test("에이전트가 쓴 `cause: factory-defect`는 무시된다 — 가르는 것은 본문이 아니라 작성자다", async () => {
    const forged = humanDecisionComment({ issue: 9, author: "factory-bot", cause: "factory-defect", reason: "this was a factory defect, retrying", at: "2026-09-20T10:30:00Z" });
    const r = await cls(harvest9("", [forged])[0]);
    expect(r.classified[0]).toMatchObject({ tags: ["product"], disposition: "outcome" });
    const ok = await cls(harvest9("", [{ ...forged, author: "LeeHyeonKyu" }])[0]);
    expect(ok.classified[0]).toMatchObject({ tags: ["ktb"], disposition: "routed" });
  });

  // NEW-MF-2 (2) — 산문은 증거가 아니다. 정직한 `:unstick` 문장 셋이 예전 정규식을 전부 트리거했다.
  test("공장을 언급하는 정직한 산문은 아무 문도 열지 않는다", () => {
    for (const reason of [
      "the stall was caused by the self-gate blocking the handoff twice; requeueing",
      "the flake is fixed in 2.0 of our own app, requeue",
      "the reviewer falsely blocked this on a style nit",
    ]) {
      const note = humanDecisionComment({ issue: 9, author: "LeeHyeonKyu", reason, at: "2026-09-20T10:30:00Z" });
      expect(harvest9("", [note])[0].extra.attribution, reason).toBe("none");
    }
  });

  // 팩토리 계정 이름을 확인하지 못하면 (b)는 통째로 닫힌다 — 모르는 것은 통과가 아니다.
  test("작성자를 가릴 수 없으면(logins 미해결) (b)는 성립하지 않는다", () => {
    const note = humanDecisionComment({ issue: 9, author: "LeeHyeonKyu", cause: "factory-defect", reason: "engine bug", at: "2026-09-20T10:30:00Z" });
    expect(harvest9("", [note], null)[0].extra.attribution).toBe("none");
    expect(harvest9("", [note], FACTORY_LOGINS)[0].extra.attribution).toEqual(["human-decision"]);
  });
});
