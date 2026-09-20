import { runGates, gatesDetailLines } from "../../lib/gates.js";
import { makeFakeRun } from "../../lib/exec.js";
import { heartbeatBody } from "../../lib/heartbeat.js";
import { selfGateRetryComment } from "../../lib/retro/issue-comments.js";
import { renderHandoff } from "../../lib/handoff.js";
import { transitionRefusedMarker } from "../../lib/retro/issue-comments.js";

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
  id: issue * 100 + stage.length, createdAt: at,
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

/** run 기록 한 장을 `appendRunRecord`와 같은 문법으로 조립한다(섹션 헤더 + 줄들). */
export function recordOf(issue, title, sections) {
  const out = [`# Run · #${issue}${title ? ` ${title}` : ""}`];
  for (const s of sections) {
    out.push("", `## ${s.stage} · ${s.at} · ${s.runner ?? RUNNER}`, ...s.lines);
  }
  return `${out.join("\n")}\n`;
}

export const selfGateComment = ({ issue, head, attempt, findings, at }) => ({
  id: Number(`${issue}${attempt}`), createdAt: at,
  body: selfGateRetryComment({ issue, head, attempt, findings }),
});

/** `transition.js`가 거부를 적는 모양 그대로(마커 두 줄 + 사유 + 라벨 이동 문장). */
export const refusalComment = ({ from, to, reason, at, id = 9001 }) => ({
  id, createdAt: at,
  body: [
    `<!-- factory-transition:v1 from=${from} to=factory:needs-human by=script reason=refused -->`,
    transitionRefusedMarker({ from, to }),
    `**전이 거부** ${from} → ${to}: ${reason}`,
    "",
    "라벨을 `factory:needs-human`으로 옮겼습니다. 산출물을 보강한 뒤 `:unstick`으로 재개하세요.",
  ].join("\n"),
});

export const reviewHandoffComment = (issue, { round = 1, verdicts, at }) => ({
  id: Number(`${issue}7${round}`), createdAt: at,
  body: renderHandoff({
    stage: "review", issue, summary: `round ${round}`,
    data: { schema: "factory.review.v1", issue, pr: issue, head_sha: "a".repeat(40), round, verdicts, orchestration: "workflow", guarantee: "verified" },
  }),
});
