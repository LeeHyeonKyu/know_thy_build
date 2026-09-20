import { test, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verdictLine } from "../lib/gates.js";
import { contextManifestLines } from "../lib/context.js";
import { usageLine } from "../bin/run-stage.js";
import { makeFakeRun } from "../lib/exec.js";
import { ownerOf, buildManifest } from "../cli/manifest.js";
import {
  RUNNER, heartbeat, realGatesDetail, vitestReport, recordOf,
  selfGateComment, selfGateDetail, refusalComment, humanDecisionComment, reviewHandoffComment,
} from "./helpers/feedback-fixtures.js";
import { analyzeCommand, buildTimeline, groupRuns, parseSections, readRecordFor } from "../cli/analyze.js";

/**
 * ── Task 5 — `factory analyze <issue>`의 회귀 핀 ────────────────────────────────────────────────
 *
 * spec §1이 인용하는 사고를 그대로 재현한다: 데모 #39의 실패 원인은 **이미 전부 기록돼 있었지만**
 * 그것을 읽으려면 5~7군데(런 기록·게이트 줄·self-gate 코멘트·전이 거부 코멘트·핸드오프·usage)를
 * 손으로 뒤져야 했다. 이 테스트가 고정하는 것은 한 문장이다 — **한 명령이 그 전부를 낸다.**
 *
 * 픽스처는 Global Constraint대로 **진짜 생산자**가 만든다: 게이트 줄은 `runGates` →
 * `gatesDetailLines`/`verdictLine`, self-gate는 `selfGateRetryComment`/`selfGateDetailLine`,
 * 전이 거부는 `transitionRefusedComment`, 컨텍스트는 `contextManifestLines`, 비용은 `usageLine`,
 * 기록은 `appendRunRecord`(`recordOf`)가 쓴다. 손으로 빚은 모양은 한 줄도 없다.
 */

const ISSUE = 39;
const REPO = "LeeHyeonKyu/own-cal";
const OWNER = "LeeHyeonKyu";

/** 데모 #39가 실제로 남긴 두 문장 — 이 테스트의 존재 이유다. */
const SELF_GATE_REASON = "spec-evidence-missing: no qa evidence manifest";
const REFUSAL = "plan roles [synthesizer,skeptic] != roster []";

const dests = new Set(buildManifest({ pkgRoot: fileURLToPath(new URL("../..", import.meta.url)) }).map((e) => e.dest));
const manifest = { ownerOf, isInstalled: dests, ktbVersion: "1.3.2", source: "test" };
const harness = { test: { source_glob: ["src/**/*.js"], test_glob: ["test/**/*.test.js"] } };

/** 스테이지 하나의 `usage:`(+ `progress:v1`) 줄 — 에이전트별 비용이 그 둘째 줄에 산다. */
function stageUsage({ cost, turns, input, output, agents }) {
  return usageLine(
    {
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 1_080_000 },
      total_cost_usd: cost, num_turns: turns, terminal_reason: "end_turn",
      modelUsage: { "claude-opus-4-20250514": { costUSD: cost } },
    },
    {
      stage: "implement", issue: ISSUE, runner: RUNNER,
      started: "2026-09-20T10:08:00Z", updated: "2026-09-20T10:41:00Z",
      step: { phase: null, label: null, since: null },
      agents, files_touched: ["src/plan.js"],
      totals: { turns, input_tokens: input, output_tokens: output, cache_read_tokens: 1_080_000, cost_usd: cost },
    },
  );
}

async function demo39() {
  // ① RED가 된 `unit` 게이트 — 진짜 `runGates`를 돌려 얻는다.
  const { result, lines: gateDetail } = await realGatesDetail({
    outcomes: { unit: { code: 1, stdout: "FAIL  test/roster.test.js\n  × plan roster contract > carries the debate roster\n\n1 failed | 3 passed\n" } },
    report: vitestReport({ passed: 3, failures: ["plan roster contract > carries the debate roster"] }),
  });

  // ② 역할별 컨텍스트 매니페스트 — 굶은 역할을 사람이 알아보는 유일한 줄.
  const ctx = { roles: { correctness: { cold_read: true }, "spec-conformance": { cold_read: false } }, issue: { number: ISSUE }, stage: "review", handoffs: {} };
  const manifestLines = contextManifestLines(ctx, { runId: "99001", runnerId: RUNNER, round: 1 });

  /**
   * **한 런은 섹션 하나가 아니다**(MF-2): `run-stage.js`는 `record([...])`를 여러 번 부르고 그때마다
   * `appendRunRecord`가 섹션 하나를 더 붙인다. 여기서도 그렇게 만든다 — implement 런 하나가
   * 섹션 셋이다.
   */
  const record = recordOf(ISSUE, "own-cal: plan roster", [
    { stage: "plan", at: "2026-09-20T10:00Z", lines: ["artifact: .factory/out/plan.json"] },
    {
      stage: "plan", at: "2026-09-20T10:04Z",
      lines: [stageUsage({
        cost: 2.1, turns: 12, input: 41_000, output: 5_200,
        agents: [{ label: "plan", kind: "orchestrator", status: "done", turns: 4, input_tokens: 11_000, output_tokens: 1_200, cache_read_tokens: 180_000, cost_usd: 0.42 },
          { label: "plan:skeptic", kind: "subagent", status: "done", turns: 8, input_tokens: 30_000, output_tokens: 4_000, cache_read_tokens: 900_000, cost_usd: 1.68 }],
      })],
    },
    { stage: "implement", at: "2026-09-20T10:08Z", lines: ["artifact: .factory/out/implement.json"] },
    { stage: "implement", at: "2026-09-20T10:30Z", lines: [verdictLine(result), ...gateDetail] },
    {
      stage: "implement", at: "2026-09-20T10:41Z",
      lines: [
        selfGateDetail({ ran: ["gates", "contract"], blocked: true, ktbVersion: "1.3.2" }),
        ...manifestLines,
        stageUsage({
          cost: 5.45, turns: 42, input: 131_000, output: 17_200,
          agents: [{ label: "implement", kind: "orchestrator", status: "done", turns: 12, input_tokens: 41_000, output_tokens: 5_200, cache_read_tokens: 380_000, cost_usd: 1.94 },
            { label: "builder:impl", kind: "subagent", status: "done", turns: 30, input_tokens: 90_000, output_tokens: 12_000, cache_read_tokens: 700_000, cost_usd: 3.51 }],
        }),
      ],
    },
  ]);

  const comments = [
    heartbeat(ISSUE, "plan", RUNNER, "2026-09-20T10:00:00Z"),
    heartbeat(ISSUE, "implement", RUNNER, "2026-09-20T10:08:00Z"),
    selfGateComment({ issue: ISSUE, head: "abc1234", attempt: 1, at: "2026-09-20T10:41:00Z", findings: [{ check: "contract", blocking: true, detail: SELF_GATE_REASON }] }),
    refusalComment({ from: "factory:in-progress", to: "factory:awaiting-review", reason: REFUSAL, at: "2026-09-20T10:44:00Z" }),
    reviewHandoffComment(ISSUE, {
      round: 1, at: "2026-09-20T11:10:00Z",
      verdicts: [
        { role: "correctness", verdict: "approve", must_fix: [] },
        { role: "spec-conformance", verdict: "reject", must_fix: [{ id: "MF-1", where: "src/plan.js:12", claim: "the roster is read from the charter default, not the tier", evidence: "roster [] on the docs tier" }] },
      ],
    }),
    humanDecisionComment({
      issue: ISSUE, skill: "unstick", decision: "retry", cause: "factory-defect", ktbFix: "1.3.3",
      author: OWNER, reason: "the implement self-gate demanded a qa manifest only review produces", at: "2026-09-20T12:02:00Z",
    }),
  ];

  return { record, comments };
}

function capture() {
  const lines = [];
  return { io: { out: (s) => lines.push(String(s)), err: (s) => lines.push(String(s)) }, lines, text: () => lines.join("\n") };
}

/**
 * **노트북에서 도는 모양 그대로**(MF-1): `factoryLogins`를 주입하지 않는다. `gh api user`는 소유자를
 * 돌려주고(`viewerLogin`), `GITHUB_ACTIONS`는 없다. 봇 이름의 유일한 출처는 하트비트 코멘트의
 * 작성자여야 한다 — 1차 구현은 여기서 소유자를 봇으로 세어 `[ktb]` 둘을 통째로 잃었다.
 */
const deps = async (over = {}) => {
  const { record, comments } = await demo39();
  return {
    root: "/repo", repo: REPO, harness,
    gh: { comments: async () => comments, viewerLogin: async () => OWNER },
    readRecord: async () => ({ text: record, source: "factory/records:docs/factory/runs/39.md (gh api)", trusted: true }),
    loadManifest: async () => manifest,
    ...over,
  };
};

// ── 회귀 핀: 5~7군데가 한 화면으로 ──────────────────────────────────────────────────────────────

test("analyze 39: one command reconstructs demo #39 — self-gate reason, refused transition, gates line, per-agent cost, both [ktb] findings", async () => {
  const cap = capture();
  const code = await analyzeCommand({ ...(await deps()), argv: ["39"], io: cap.io });
  const out = cap.text();

  expect(code).toBe(0);

  // ① self-gate가 막은 이유 — 예전에는 self-gate 재시도 코멘트를 찾아 열어야 보였다.
  expect(out).toContain(SELF_GATE_REASON);
  // ② 전이가 거부된 이유 — 예전에는 전이 거부 코멘트에만 있었다(#39의 진짜 근본 원인).
  expect(out).toContain(REFUSAL);
  // ③ 게이트 한 줄 요약 + 그 RED 게이트의 상세(실패 테스트 이름까지).
  expect(out).toMatch(/FACTORY_GATES: level=fast status=RED .*failing=unit/);
  expect(out).toContain("plan roster contract > carries the debate roster");
  // ④ 에이전트별 비용 — 스테이지 합계만이 아니라 "그 $5.45 중 누가 얼마를".
  expect(out).toContain("$5.45");
  expect(out).toContain("builder:impl");
  expect(out).toContain("$3.51");
  // ⑤ 회고가 라우팅할 바로 그 분류 — `[ktb]` 둘과 그 귀속.
  expect(out.match(/\[ktb\]/g) ?? []).toHaveLength(2);
  expect(out).toContain("human-decision");
});

/**
 * ── T5 리뷰 MF-1의 회귀 핀 ──────────────────────────────────────────────────────────────────
 * 노트북에서 `gh api user`는 **소유자**다. 그 값이 팩토리 계정으로 세어지면 소유자가 직접 적은
 * `human-decision:v1`이 기각되고 `[ktb]` 둘이 사라진다. 여기서 확인하는 것은 그 경로가 이제
 * 하트비트 작성자에서 봇 이름을 얻는다는 것이다.
 */
test("analyze 39 on a laptop: the viewer is the owner, so the owner's human-decision still counts as evidence", async () => {
  const cap = capture();
  await analyzeCommand({ ...(await deps()), argv: ["39", "--json"], io: cap.io });
  const data = JSON.parse(cap.text());

  // 해석된 팩토리 계정은 하트비트의 작성자뿐 — 소유자는 그 목록에 없다.
  expect(data.factory_logins).toEqual(["factory-bot"]);
  expect(data.factory_logins).not.toContain(OWNER);
  expect(data.findings.filter((f) => f.tags.includes("ktb"))).toHaveLength(2);
});

test("analyze: when no factory login can be resolved, it SAYS human-decision evidence cannot be evaluated (never silently [])", async () => {
  const { record, comments } = await demo39();
  const noHeartbeats = comments.filter((c) => !String(c.body).includes("factory-heartbeat"));
  const cap = capture();
  const code = await analyzeCommand({
    ...(await deps()), argv: ["39"], io: cap.io,
    gh: { comments: async () => noHeartbeats, viewerLogin: async () => OWNER },
    readRecord: async () => ({ text: record, source: "records", trusted: true }),
  });
  expect(code).toBe(0);
  const out = cap.text();
  expect(out).toMatch(/factory logins unresolved/);
  expect(out).toMatch(/human-decision evidence cannot be evaluated/);
  // 증거를 평가할 수 없으면 ktb로 보내지 않는다 — 경고 문구 자체가 "[ktb]"를 말하므로
  // **발견 줄**만 본다(발견은 `   [tag] kind — …` 모양으로 찍힌다).
  expect(out).not.toMatch(/^ {3}\[ktb\]/m);
});

// ── MF-2: 섹션은 스테이지 런이 아니다 ──────────────────────────────────────────────────────────

/**
 * 진짜 기록(`factory/records:docs/factory/runs/20.md`)의 모양: 섹션 11개, 런 셋.
 * 1차 구현은 "11 stage-runs"라고 적었고, 사람은 이 이슈가 열한 번 돌았다고 읽었다.
 */
test("stage-runs are grouped by run identity, not by appendRunRecord call (11 real sections → 3 runs)", () => {
  const sections = [
    ...Array.from({ length: 3 }, (_, i) => ({ stage: "triage", at: "2026-09-14T18:20Z", runner: "gha-34880048731", lines: [`t${i}`] })),
    ...Array.from({ length: 2 }, (_, i) => ({ stage: "plan", at: "2026-09-14T18:32Z", runner: "gha-34880188521", lines: [`p${i}`] })),
    ...Array.from({ length: 6 }, (_, i) => ({ stage: "implement", at: i < 3 ? "2026-09-14T18:32Z" : "2026-09-14T19:02Z", runner: "gha-34881426779", lines: [`i${i}`] })),
  ];
  const record = recordOf(20, "real shape", sections);

  expect(parseSections(record)).toHaveLength(11);       // 섹션은 정말 11개다
  const runs = groupRuns(parseSections(record));
  expect(runs).toHaveLength(3);                          // 그러나 런은 셋이다
  expect(runs.map((r) => r.stage)).toEqual(["triage", "plan", "implement"]);
  expect(runs.map((r) => r.run_id)).toEqual(["34880048731", "34880188521", "34881426779"]);
  expect(runs.map((r) => r.sections)).toEqual([3, 2, 6]);
  // 여러 섹션에 걸친 런은 첫 시각과 마지막 시각을 모두 안다.
  expect(runs[2].at).toBe("2026-09-14T18:32Z");
  expect(runs[2].last_at).toBe("2026-09-14T19:02Z");
});

test("a section whose runner carries no run id forms its own unbound group — it is never merged into a real run", () => {
  const record = recordOf(21, "x", [
    { stage: "implement", at: "2026-09-14T18:32Z", runner: "gha-1", lines: ["a"] },
    { stage: "implement", at: "2026-09-14T18:33Z", runner: "unknown", lines: ["b"] },
  ]);
  const runs = groupRuns(parseSections(record));
  expect(runs).toHaveLength(2);
  expect(runs.map((r) => r.bound)).toEqual([true, false]);
  expect(runs[1].run_id).toBe(null);
});

test("a run's cost sums every usage line it appended (one run can call claude several times)", () => {
  const u = (cost, turns) => usageLine({ usage: { input_tokens: 1000, output_tokens: 100 }, total_cost_usd: cost, num_turns: turns, terminal_reason: "end_turn", modelUsage: {} });
  const record = recordOf(22, "x", [
    { stage: "implement", at: "2026-09-14T18:32Z", runner: "gha-7", lines: [u(1.5, 10)] },
    { stage: "implement", at: "2026-09-14T18:40Z", runner: "gha-7", lines: [u(2.25, 5)] },
  ]);
  const [run] = groupRuns(parseSections(record));
  expect(run.sections).toBe(2);
  expect(run.cost.usd).toBe(3.75);
  expect(run.cost.turns).toBe(15);
  expect(run.cost.calls).toBe(2);
});

// ── MF-3: 시간으로 이벤트를 런에 붙이지 않는다 ────────────────────────────────────────────────

test("events are never attributed to a run they do not name: no run carries an events list", async () => {
  const cap = capture();
  await analyzeCommand({ ...(await deps()), argv: ["39", "--json"], io: cap.io });
  const data = JSON.parse(cap.text());

  // 런 객체에는 이벤트가 없다 — 붙일 근거가 없기 때문이다.
  for (const r of data.runs) expect(r.events).toBeUndefined();
  expect(data.orphan_events).toBeUndefined();          // 개념 자체가 사라졌다

  // 이벤트는 하나의 연대기에 자기 타임스탬프로 선다.
  const kinds = data.events.map((e) => e.kind);
  expect(kinds).toContain("transition-refused");
  expect(kinds).toContain("review");
  expect(kinds).toContain("self-gate-retry");
  expect(kinds).toContain("human-decision");
  for (const ev of data.events) expect(ev.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  // 연대기는 시간순이고, 런의 시작도 같은 줄에 선다(사람이 사이를 읽을 수 있도록).
  const ms = data.chronology.map((e) => e.at_ms);
  expect([...ms].sort((a, b) => a - b)).toEqual(ms);
  expect(data.chronology.filter((e) => e.kind === "run-start")).toHaveLength(2);

  // 런 id를 싣고 오는 이벤트(하트비트)만 run_id를 갖는다.
  const hb = data.chronology.find((e) => e.kind === "heartbeat");
  expect(hb.run_id).toBe("99001");
  const refused = data.events.find((e) => e.kind === "transition-refused");
  expect(refused.run_id).toBeUndefined();
});

test("the chronology renders each event with its own timestamp and claims no run for it", async () => {
  const cap = capture();
  await analyzeCommand({ ...(await deps()), argv: ["39"], io: cap.io });
  const out = cap.text();
  expect(out).toMatch(/chronology .*attributed to a run only when it carries that run's id/);
  expect(out).toMatch(/2026-09-20T10:44:00Z\s+transition REFUSED/);
  expect(out).toMatch(/▶ stage-run plan starts/);
});

// ── MF-4 + SF-5: 바인딩은 harvest와 같은 함수로, 그리고 화면에 보인다 ─────────────────────────

test("record lines are bound via the heartbeat comments (harvest's own knownRunsFor/isBoundLine), not the section header", async () => {
  const { record } = await demo39();
  // 하트비트가 하나도 없으면 harvest는 기록의 줄을 전부 무시한다 — 타임라인도 같은 판정을 보여야 한다.
  const tl = buildTimeline({ issue: ISSUE, repo: REPO, record, comments: [] });
  expect(tl.record_lines.total).toBeGreaterThan(0);
  expect(tl.record_lines.unbound).toBe(tl.record_lines.total);

  // 하트비트가 있으면 같은 줄들이 바인딩된다.
  const { comments } = await demo39();
  const bound = buildTimeline({ issue: ISSUE, repo: REPO, record, comments });
  expect(bound.record_lines.unbound).toBe(0);
  expect(bound.known_runs).toContain("99001");
});

test("unbound lines are shown, flagged UNBOUND for all three line kinds, and counted in the findings header", async () => {
  const { record } = await demo39();
  const cap = capture();
  await analyzeCommand({
    ...(await deps()), argv: ["39"], io: cap.io,
    gh: { comments: async () => [], viewerLogin: async () => OWNER },
    readRecord: async () => ({ text: record, source: "records", trusted: true }),
  });
  const out = cap.text();

  // 세 줄 종류 전부에 같은 꼬리표가 붙는다(SF-5: 예전에는 gates-detail에만 붙었다).
  expect(out).toMatch(/gate unit: RED \(.*UNBOUND/);
  expect(out).toMatch(/self-gate: BLOCKED.*UNBOUND/);
  expect(out).toMatch(/context: correctness.*UNBOUND/);

  // 그리고 "발견 0건"의 이유를 **문턱**이 아니라 **바인딩**으로 정확히 말한다(MF-4).
  expect(out).toMatch(/all \d+ evidence line\(s\) in the run record are UNBOUND/);
  expect(out).not.toMatch(/Findings: none — nothing in this issue crossed the threshold/);
});

// ── SF-6: `gates-detail:`은 FACTORY_GATES 줄이 없어도 찍힌다 ──────────────────────────────────

test("a gates-detail line prints even when its run never appended a FACTORY_GATES summary line", async () => {
  const { lines: gateDetail } = await realGatesDetail({
    outcomes: { unit: { code: 1, stdout: "FAIL  test/a.test.js\n  × widget renders\n" } },
    report: vitestReport({ passed: 0, failures: ["widget renders"] }),
  });
  const record = recordOf(ISSUE, "x", [{ stage: "implement", at: "2026-09-20T10:08Z", lines: gateDetail }]);
  const cap = capture();
  await analyzeCommand({
    ...(await deps()), argv: ["39"], io: cap.io,
    gh: { comments: async () => [heartbeat(ISSUE, "implement", RUNNER, "2026-09-20T10:08:00Z")], viewerLogin: async () => OWNER },
    readRecord: async () => ({ text: record, source: "records", trusted: true }),
  });
  const out = cap.text();
  expect(out).not.toContain("FACTORY_GATES");        // 요약 줄은 없다
  expect(out).toMatch(/gate unit: RED/);             // 그래도 원인은 보인다
  expect(out).toContain("widget renders");
});

// ── SF-7: 귀속의 증거가 되는지를 그 줄에서 말한다 / 로컬 사본은 UNVERIFIED ─────────────────────

test("a human decision shows whether its author is a factory login (and is therefore ignored by attribution)", async () => {
  const cap = capture();
  await analyzeCommand({ ...(await deps()), argv: ["39"], io: cap.io });
  expect(cap.text()).toContain(`by @${OWNER} (human)`);

  // 같은 코멘트를 봇이 적었으면 그 사실이 그 줄에 적힌다 — 발견이 왜 ktb가 아닌지가 화면에서 읽힌다.
  const { record, comments } = await demo39();
  const byBot = comments.map((c) => (String(c.body).includes("human-decision:v1") ? { ...c, author: "factory-bot" } : c));
  const cap2 = capture();
  await analyzeCommand({
    ...(await deps()), argv: ["39"], io: cap2.io,
    gh: { comments: async () => byBot, viewerLogin: async () => OWNER },
    readRecord: async () => ({ text: record, source: "records", trusted: true }),
  });
  expect(cap2.text()).toContain("(factory login — ignored by attribution)");
  expect(cap2.text()).not.toContain("[ktb]");
});

test("a record read from the local working tree is printed with an explicit UNVERIFIED warning", async () => {
  const { record } = await demo39();
  const cap = capture();
  await analyzeCommand({
    ...(await deps()), argv: ["39"], io: cap.io,
    readRecord: async () => ({ text: record, source: "docs/factory/runs/39.md (local working tree)", trusted: false }),
  });
  const out = cap.text();
  expect(out).toMatch(/UNVERIFIED/);
  expect(out).toMatch(/local scratch copy/);
  expect(out).toMatch(/stale or agent-written/);
});

// ── readRecordFor: 세 경로와 그 경계 ──────────────────────────────────────────────────────────

test("readRecordFor: the gh api path base64-decodes the records-branch content and is trusted", async () => {
  const body = "# Run · #39\n\n## plan · 2026-09-20T10:00Z · gha-1\nartifact: x\n";
  const run = makeFakeRun([{ match: (c, a) => c === "gh" && a[0] === "api", result: { code: 0, stdout: `${Buffer.from(body, "utf8").toString("base64")}\n`, stderr: "" } }]);
  const r = await readRecordFor({ run, repo: REPO, root: "/repo", issue: 39 });
  expect(r.text).toBe(body);
  expect(r.trusted).toBe(true);
  expect(r.source).toMatch(/factory\/records:docs\/factory\/runs\/39\.md/);
});

test("readRecordFor: a 404 falls through to the local working tree, which is NOT trusted", async () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-analyze-"));
  mkdirSync(join(root, "docs/factory/runs"), { recursive: true });
  writeFileSync(join(root, "docs/factory/runs/39.md"), "# local\n");
  const run = makeFakeRun([{ match: () => true, result: { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" } }]);
  const r = await readRecordFor({ run, repo: REPO, root, issue: 39 });
  expect(r.text).toBe("# local\n");
  expect(r.trusted).toBe(false);
  expect(r.source).toMatch(/local working tree/);
});

test("readRecordFor: `--jq .content` printing the literal `null` is not decoded as base64 garbage", async () => {
  const run = makeFakeRun([{ match: (c, a) => c === "gh" && a[0] === "api", result: { code: 0, stdout: "null\n", stderr: "" } },
    { match: () => true, result: { code: 1, stdout: "", stderr: "no branch" } }]);
  const r = await readRecordFor({ run, repo: REPO, root: mkdtempSync(join(tmpdir(), "ktb-empty-")), issue: 39 });
  expect(r.text).toBe("");
  expect(r.source).toBe("none");
});

// ── `--json`은 같은 것을 기계에게 ──────────────────────────────────────────────────────────────

test("analyze 39 --json: emits the same data, and it round-trips", async () => {
  const cap = capture();
  const code = await analyzeCommand({ ...(await deps()), argv: ["39", "--json"], io: cap.io });
  expect(code).toBe(0);

  const data = JSON.parse(cap.text());
  expect(JSON.parse(JSON.stringify(data))).toEqual(data);      // round-trip

  expect(data.issue).toBe(ISSUE);
  expect(data.repo).toBe(REPO);
  expect(data.runs.map((r) => r.stage)).toEqual(["plan", "implement"]);

  const impl = data.runs[1];
  expect(impl.runner).toBe(RUNNER);
  expect(impl.sections).toBe(3);
  expect(impl.artifacts).toEqual([".factory/out/implement.json"]);
  expect(impl.gates[0].status).toBe("RED");
  expect(impl.gates[0].failing).toContain("unit");
  expect(impl.gates_detail[0]).toMatchObject({ gate: "unit", parsed: true, bound: true });
  expect(impl.gates_detail[0].failing).toContain("plan roster contract > carries the debate roster");
  expect(impl.self_gate[0]).toMatchObject({ blocked: true, ktb_version: "1.3.2", bound: true });
  expect(impl.context.map((c) => c.role)).toEqual(["correctness", "spec-conformance"]);
  expect(impl.cost.usd).toBe(5.45);
  expect(impl.agents.map((a) => a.label)).toEqual(["implement", "builder:impl"]);
  expect(impl.agents[1].cost_usd).toBe(3.51);

  const refused = data.events.find((e) => e.kind === "transition-refused");
  expect(refused.reason).toBe(REFUSAL);

  // 발견은 회고가 라우팅하는 것과 같은 모양이다 — tags + causal + fingerprint + attribution.
  const ktb = data.findings.filter((f) => f.tags.includes("ktb"));
  expect(ktb).toHaveLength(2);
  expect(ktb.map((f) => f.kind).sort()).toEqual(["self-gate", "transition-refused"]);
  for (const f of ktb) {
    expect(f.attribution).toContain("human-decision");
    expect(f.fingerprint).toMatch(/^[0-9a-f]{8,}$/);
    expect(f.causal.path).toMatch(/^\.factory\/lib\//);
    expect(f.disposition).toBe("routed");
  }
  expect(data.findings.some((f) => f.kind === "review-must_fix")).toBe(true);
});

// ── 순수 빌더 ─────────────────────────────────────────────────────────────────────────────────

test("buildTimeline: pure — no gh, no fs; an empty record yields no runs but keeps the comments' events", async () => {
  const { comments } = await demo39();
  const tl = buildTimeline({ issue: ISSUE, repo: REPO, record: "", comments });
  expect(tl.runs).toEqual([]);
  // 기록이 아직 브랜치에 없어도 코멘트의 사실은 사라지지 않는다.
  expect(tl.events.map((e) => e.kind)).toContain("transition-refused");
});

test("analyze: an issue with no run record still prints the comment-side events instead of dying", async () => {
  const cap = capture();
  const code = await analyzeCommand({ ...(await deps()), argv: ["39"], io: cap.io, readRecord: async () => ({ text: "", source: "none", trusted: true }) });
  expect(code).toBe(0);
  expect(cap.text()).toContain(REFUSAL);
  expect(cap.text()).toMatch(/no run record/i);
});

// ── `--health`는 T4를 지연 import하고, 없으면 분명하게 degrade한다 ─────────────────────────────

test("analyze --health: degrades with a clear message when the health aggregation is not installed", async () => {
  const cap = capture();
  const code = await analyzeCommand({
    ...(await deps()), argv: ["--health"], io: cap.io,
    importHealth: async () => { throw new Error("Cannot find module '../bin/health.js'"); },
  });
  expect(code).toBe(1);
  const out = cap.text();
  expect(out).toMatch(/health/i);
  expect(out).toContain("factory/bin/health.js");
  expect(out).toMatch(/analyze <issue>/);
});

test("analyze --health: runs the aggregation when it is present", async () => {
  const cap = capture();
  const code = await analyzeCommand({
    ...(await deps()), argv: ["--health", "--json"], io: cap.io,
    importHealth: async () => ({ healthCommand: async ({ io }) => { io.out("health report"); return 0; } }),
  });
  expect(code).toBe(0);
  expect(cap.text()).toContain("health report");
});

test("analyze --health: degrades when the module exists but exposes no entry point this version knows", async () => {
  const cap = capture();
  const code = await analyzeCommand({ ...(await deps()), argv: ["--health"], io: cap.io, importHealth: async () => ({ somethingElse: 1 }) });
  expect(code).toBe(1);
  expect(cap.text()).toMatch(/entry point|healthCommand/);
});

test("analyze 39 --health: refused rather than silently dropping the issue (they are two different commands)", async () => {
  const cap = capture();
  let called = false;
  const code = await analyzeCommand({ ...(await deps()), argv: ["39", "--health"], io: cap.io, importHealth: async () => { called = true; return {}; } });
  expect(code).toBe(1);
  expect(called).toBe(false);
  expect(cap.text()).toMatch(/--health takes no issue/);
});

// ── 사용법 ────────────────────────────────────────────────────────────────────────────────────

test("analyze: without an issue (and without --health) it explains itself and exits non-zero", async () => {
  const cap = capture();
  const code = await analyzeCommand({ ...(await deps()), argv: [], io: cap.io });
  expect(code).toBe(1);
  expect(cap.text()).toMatch(/factory analyze <issue>/);
});

test("analyze: a non-numeric issue is refused rather than silently read as #0", async () => {
  const cap = capture();
  const code = await analyzeCommand({ ...(await deps()), argv: ["nonsense"], io: cap.io });
  expect(code).toBe(1);
  expect(cap.text()).toMatch(/issue number/i);
});

/**
 * 설치 매니페스트가 없으면 `classifyFinding`이 던진다(주인 맵 없이 분류하면 채택자의 하네스 결함이
 * 전부 상류로 간다). 그때도 **타임라인은 낸다** — 사람이 보러 온 것의 대부분은 거기 있다.
 */
test("analyze: without an install manifest the timeline still prints and the findings section says why it is empty", async () => {
  const cap = capture();
  const code = await analyzeCommand({ ...(await deps()), argv: ["39"], io: cap.io, loadManifest: async () => null });
  expect(code).toBe(0);
  const out = cap.text();
  expect(out).toContain(REFUSAL);                     // 타임라인은 그대로
  expect(out).toMatch(/install manifest/i);           // 분류는 못 한 이유를 말한다
  expect(out).not.toContain("[ktb]");                 // 지어내지 않는다
});
