import { test, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { verdictLine } from "../lib/gates.js";
import { contextManifestLines } from "../lib/context.js";
import { usageLine } from "../bin/run-stage.js";
import { ownerOf, buildManifest } from "../cli/manifest.js";
import {
  RUNNER, heartbeat, realGatesDetail, vitestReport, recordOf,
  selfGateComment, selfGateDetail, refusalComment, humanDecisionComment, reviewHandoffComment,
} from "./helpers/feedback-fixtures.js";
import { analyzeCommand, buildTimeline } from "../cli/analyze.js";

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
const LOGINS = ["factory-bot"];

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

  const record = recordOf(ISSUE, "own-cal: plan roster", [
    {
      stage: "plan", at: "2026-09-20T10:00Z",
      lines: [
        "artifact: .factory/out/plan.json",
        stageUsage({
          cost: 2.1, turns: 12, input: 41_000, output: 5_200,
          agents: [{ label: "plan", kind: "orchestrator", status: "done", turns: 4, input_tokens: 11_000, output_tokens: 1_200, cache_read_tokens: 180_000, cost_usd: 0.42 },
            { label: "plan:skeptic", kind: "subagent", status: "done", turns: 8, input_tokens: 30_000, output_tokens: 4_000, cache_read_tokens: 900_000, cost_usd: 1.68 }],
        }),
      ],
    },
    {
      stage: "implement", at: "2026-09-20T10:08Z",
      lines: [
        "artifact: .factory/out/implement.json",
        verdictLine(result),
        ...gateDetail,
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
      author: "LeeHyeonKyu", reason: "the implement self-gate demanded a qa manifest only review produces", at: "2026-09-20T12:02:00Z",
    }),
  ];

  return { record, comments };
}

function capture() {
  const lines = [];
  return { io: { out: (s) => lines.push(String(s)), err: (s) => lines.push(String(s)) }, lines, text: () => lines.join("\n") };
}

const deps = async () => {
  const { record, comments } = await demo39();
  return {
    root: "/repo", repo: REPO, harness, factoryLogins: LOGINS,
    gh: { comments: async () => comments },
    readRecord: async () => ({ text: record, source: "records-branch" }),
    loadManifest: async () => manifest,
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

  // 그리고 그것이 **한 번의 출력**이다: 사람이 다른 곳을 열 이유가 없다.
  expect(cap.lines.length).toBeGreaterThan(10);
});

test("analyze 39: the timeline carries every stage-run section in record order", async () => {
  const cap = capture();
  await analyzeCommand({ ...(await deps()), argv: ["39"], io: cap.io });
  const out = cap.text();

  // 스테이지 런이 기록 순서대로 — plan 먼저, implement 다음.
  expect(out.indexOf("plan · 2026-09-20T10:00Z")).toBeGreaterThan(-1);
  expect(out.indexOf("plan · 2026-09-20T10:00Z")).toBeLessThan(out.indexOf("implement · 2026-09-20T10:08Z"));
  // 산출물 포인터·self-gate 줄·역할 컨텍스트 매니페스트·리뷰 판정이 전부 있다.
  expect(out).toContain(".factory/out/implement.json");
  expect(out).toMatch(/self-gate: BLOCKED/);
  expect(out).toMatch(/context: correctness .*cold-read/);
  expect(out).toMatch(/spec-conformance=reject/);
  expect(out).toContain("MF-1");
  expect(out).toContain("the roster is read from the charter default, not the tier");
  // 러너/런 id가 붙는다 — 어느 런의 증거인지가 판정의 재료다.
  expect(out).toContain(RUNNER);
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
  expect(impl.artifact).toBe(".factory/out/implement.json");
  expect(impl.gates.status).toBe("RED");
  expect(impl.gates.failing).toContain("unit");
  expect(impl.gates_detail[0]).toMatchObject({ gate: "unit", parsed: true });
  expect(impl.gates_detail[0].failing).toContain("plan roster contract > carries the debate roster");
  expect(impl.self_gate).toMatchObject({ blocked: true, ktb_version: "1.3.2" });
  expect(impl.context.map((c) => c.role)).toEqual(["correctness", "spec-conformance"]);
  expect(impl.cost.usd).toBe(5.45);
  expect(impl.agents.map((a) => a.label)).toEqual(["implement", "builder:impl"]);
  expect(impl.agents[1].cost_usd).toBe(3.51);

  // 이벤트(전이·리뷰·self-gate·사람의 결정)가 시간순으로 붙는다.
  const kinds = data.runs.flatMap((r) => r.events.map((e) => e.kind));
  expect(kinds).toContain("transition-refused");
  expect(kinds).toContain("review");
  expect(kinds).toContain("self-gate-retry");
  expect(kinds).toContain("human-decision");
  const refused = data.runs.flatMap((r) => r.events).find((e) => e.kind === "transition-refused");
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
  // 기록이 아직 브랜치에 없어도 코멘트의 사실은 사라지지 않는다 — 고아 이벤트로 남는다.
  expect(tl.orphan_events.map((e) => e.kind)).toContain("transition-refused");
});

test("analyze: an issue with no run record still prints the comment-side events instead of dying", async () => {
  const cap = capture();
  const code = await analyzeCommand({ ...(await deps()), argv: ["39"], io: cap.io, readRecord: async () => ({ text: "", source: "none" }) });
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
  // 분명해야 한다: 사람이 무엇을 할 수 있는지까지.
  expect(out).toMatch(/analyze <issue>/);
  // 그리고 절대 던지지 않는다(위 await이 통과한 것이 곧 증거다).
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
