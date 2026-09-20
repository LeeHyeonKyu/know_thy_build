import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGates, gatesDetailLines } from "../../lib/gates.js";
import { makeFakeRun } from "../../lib/exec.js";
import { heartbeatBody } from "../../lib/heartbeat.js";
import { selfGateRetryComment, transitionRefusedComment } from "../../lib/retro/issue-comments.js";
import { renderHandoff } from "../../lib/handoff.js";
import { appendRunRecord } from "../../lib/run-record.js";
import { selfGateDetailLine } from "../../lib/self-gate.js";
import { usageLine } from "../../bin/run-stage.js";

/**
 * ── T3 리뷰의 근본 교훈: **픽스처는 진짜 생산자가 만든 것이어야 한다** ───────────────────────────
 *
 * 1차 구현의 테스트는 전부 초록이었는데 라우팅은 틀려 있었다. 이유 하나였다: 손으로 적은 픽스처가
 * 생산자가 **낼 수 없는 모양**이었다(리포트 없는 게이트에 `reason`이 붙어 있고, 존재한 적 없는
 * self-gate 검사 이름 `qa-manifest`가 쓰였다). 그래서 이 헬퍼는 `gates-detail:` 줄을 `runGates` →
 * `gatesDetailLines`로 **실제로 만들고**, self-gate 코멘트는 `selfGateRetryComment`로, 전이 거부는
 * `transitionRefusedMarker` + `transition.js`가 쓰는 문구로, 하트비트는 `heartbeatBody`로 만든다.
 */

export const RUNNER = "gha-99001";
export const RUN_ID = "99001";

export const heartbeat = (issue, stage, runner = RUNNER, at = "2026-09-20T10:00:00Z") => ({
  id: issue * 100 + stage.length, createdAt: at, author: "factory-bot",
  body: heartbeatBody({ issue, stage, runnerId: runner, started: at, last: at }),
});

/** 하네스 한 장 — 테스트 게이트 하나(`unit`)와 리포트를 쓰지 않는 게이트 하나(`lint`). */
export const gatesHarness = (over = {}) => ({
  harness: { maturity: "M2" },
  commands: { lint: "npm run lint", unit: "npx vitest run --reporter=json --outputFile=.factory/out/unit.json", ...(over.commands || {}) },
  gates: { required: ["lint", "unit"], fast: ["lint", "unit"], full: ["lint", "unit"], deep: ["lint", "unit"], thresholds: {} },
  test: { unit_report: ".factory/out/unit.json", test_glob: ["test/**/*.test.js"], source_glob: ["src/**/*.js"], ...(over.test || {}) },
  ...(over.rest || {}),
});

/**
 * 게이트를 **진짜로 돌려** `gates-detail:` 줄(들)을 얻는다. `outcomes`는 게이트 이름 → `{code, stdout,
 * stderr}`이고, `report`는 `.factory/out/unit.json`에 있을 내용(없으면 리포트가 없는 것이다).
 */
export async function realGatesDetail({ outcomes, report = null, harness = gatesHarness(), level = "fast", stamp = { runId: RUN_ID, runnerId: RUNNER } }) {
  const run = makeFakeRun([{
    match: (cmd) => cmd === "bash",
    result: (cmd, args) => {
      for (const [name, o] of Object.entries(outcomes)) {
        if (String(args[1]).includes(harness.commands[name])) return { code: o.code, stdout: o.stdout ?? "", stderr: o.stderr ?? "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  }]);
  const result = await runGates({
    run, cwd: "/r", harness, level, quarantine: { quarantined: [] },
    readFile: (p) => (report != null && p.endsWith("unit.json") ? report : null),
    now: "2026-09-20T10:05:00Z",
  });
  return { result, lines: gatesDetailLines(result, stamp) };
}

/** vitest `--reporter=json` 리포트 한 장(게이트 파서가 읽는 모양). */
export const vitestReport = ({ passed = 1, failures = [] } = {}) => JSON.stringify({
  numTotalTests: passed + failures.length,
  numPassedTests: passed,
  numFailedTests: failures.length,
  testResults: [{
    name: "/r/test/a.test.js",
    assertionResults: [
      ...Array.from({ length: passed }, (_, i) => ({ fullName: `ok ${i}`, title: `ok ${i}`, status: "passed" })),
      ...failures.map((f) => ({ fullName: f, title: f, status: "failed", failureMessages: ["expected 1 to be 2"] })),
    ],
  }],
});

/**
 * run 기록 한 장 — **`appendRunRecord`가 실제로 쓴 파일**을 그대로 읽어 온다(임시 디렉터리에 쓰고
 * 지운다). 섹션 헤더 문법을 손으로 다시 적으면 그것이 곧 "생산자가 낼 수 없는 모양"의 다음 판본이다.
 */
export function recordOf(issue, title, sections) {
  const root = mkdtempSync(join(tmpdir(), "ktb-fixture-"));
  try {
    let p = null;
    for (const s of sections) {
      p = appendRunRecord({ root, issue, title, stage: s.stage, runnerId: s.runner ?? RUNNER, lines: s.lines, now: s.at });
    }
    return p ? readFileSync(p, "utf8") : "";
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export const selfGateComment = ({ issue, head, attempt, findings, at }) => ({
  id: Number(`${issue}${attempt}`), createdAt: at,
  body: selfGateRetryComment({ issue, head, attempt, findings }),
});

/** `transition.js`가 거부를 적는 코멘트 전문 — 이제 그 생산자가 라이브러리에 있다. */
export const refusalComment = ({ from, to, reason, at, id = 9001 }) => ({
  id, createdAt: at, author: "factory-bot",
  body: transitionRefusedComment({ from, to, reason }),
});

/**
 * `self-gate-detail:` 한 줄 — `selfGateDetailLine`이 만든다. `ran`/`skipped`/`ktb_version`을 직접
 * 주는 짧은 길을 둔다(그 값들을 만드는 `runSelfGate`는 실제 mutation 실행을 요구하므로, 이 테스트가
 * 고정하려는 것 — **줄의 문법과 그 줄을 읽는 판정** — 에는 과한 비용이다).
 */
export const selfGateDetail = ({ ran = [], skipped = [], blocked = false, harness = false, ktbVersion = "1.3.2", runner = RUNNER, runId = RUN_ID }) =>
  selfGateDetailLine(
    { ok: !blocked, ranChecks: ran, skippedChecks: skipped.map((s) => (typeof s === "string" ? { check: s, reason: "no-input" } : s)) },
    { runId, runnerId: runner, ktbVersion, harnessBlock: harness },
  );

/** `:unstick`이 남기는 결정 코멘트. `cause`는 선택 — 그 필드만이 귀속의 증거다(재리뷰 NEW-MF-2). */
export const humanDecisionComment = ({ issue, skill = "unstick", decision = "retry", reason, cause = null, ktbFix = null, author = "LeeHyeonKyu", at, id = 7001 }) => ({
  id, createdAt: at, author,
  body: [
    `<!-- human-decision:v1 issue=${issue} skill=${skill} -->`,
    "```yaml",
    `decision: ${decision}`,
    ...(cause ? [`cause: ${cause}`] : []),
    ...(ktbFix ? [`ktb_fix: "${ktbFix}"`] : []),
    `reason: ${JSON.stringify(reason)}`,
    "```",
  ].join("\n"),
});

export const reviewHandoffComment = (issue, { round = 1, verdicts, at, tier = null }) => ({
  id: Number(`${issue}7${round}`), createdAt: at,
  body: renderHandoff({
    stage: "review", issue, summary: `round ${round}`,
    data: {
      schema: "factory.review.v1", issue, pr: issue, head_sha: "a".repeat(40), round, verdicts,
      orchestration: "workflow", guarantee: "verified",
      // 감사 H3 — 러너가 계산한 실효 tier가 핸드오프에 실린다(run-stage.js `writeHandoff`). 건강
      // 잡의 "위험"은 이것이다: 에이전트의 자기 신고가 아니라 **diff에서 나온 사실**이다.
      ...(tier ? { tier_effective: tier, tier_source: "promoted-by-diff" } : {}),
    },
  }),
});

/**
 * plan 핸드오프 한 장 — `renderHandoff`가 만든다. `done_when`/`dissent_log`는 `handoff.js`가 실제로
 * 렌더하는 두 블록이고(§plan), Task 4의 `debate_delta`가 읽는 것이 정확히 그 둘이다.
 */
export const planHandoffComment = (issue, { round = 1, done_when = [], dissent_log = [], at }) => ({
  id: Number(`${issue}8${round}`), createdAt: at,
  body: renderHandoff({
    stage: "plan", issue, summary: `plan ${round}`,
    data: { schema: "factory.plan.v1", issue, tier: "standard", done_when, dissent_log, files_expected: [] },
  }),
});

/**
 * run 기록의 `usage:` 줄 — **`run-stage.js`의 `usageLine`이 만든다**(그 형식을 읽는 정규식이
 * `usage.js`에 있고, 손으로 적으면 둘이 조용히 어긋난다). `claude -p` 봉투의 모양 그대로 넘긴다.
 */
export const usageRecordLine = ({ costUsd, turns = 7, input = 1000, output = 500, model = "claude-opus-4" }) =>
  usageLine({
    usage: { input_tokens: input, output_tokens: output },
    total_cost_usd: costUsd,
    num_turns: turns,
    terminal_reason: "end_turn",
    modelUsage: { [model]: { costUSD: costUsd } },
  });
