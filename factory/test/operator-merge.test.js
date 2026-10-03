import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { operatorMergeVerdict, isOperatorMergePath, OPERATOR_MERGE_GLOBS, OPERATOR_MERGE_EXCLUDES } from "../lib/operator-merge.js";
import { NON_JUDGE_GLOBS, NON_JUDGE_EXCLUDES, classifyProtected } from "../lib/non-judge-paths.js";

/** 2026-10-02 — 운영 세션의 비판정 머지 판정. 양의 목록이고, 목록 밖은 전부 판정 경로다. */
const pr = (over = {}) => ({
  number: 12, isDraft: false, mergeable: "MERGEABLE", baseRefName: "main",
  files: [{ path: "docs/research/x.md" }, { path: "docs/factory/ops/watch-issue.sh" }],
  statusCheckRollup: [{ name: "factory/integrity", conclusion: "SUCCESS" }],
  ...over,
});

test("non-judge paths are a positive list: docs, research, ops scripts, the board page, engine modules outside the judge closure — nothing under .claude/, .github/", () => {
  for (const p of ["docs/research/x.md", "docs/factory/ops/board-proxy.mjs", "docs/superpowers/plans/p.md", "docs/factory/board/index.html", "templates/factory/docs/factory/board/index.html", "docs/factory/DECISIONS.md"]) {
    expect(isOperatorMergePath(p), p).toBe(true);
  }
  for (const p of ["docs/factory/CHARTER.md", "docs/factory/runs/149.md", "templates/factory/docs/factory/CHARTER.md", "factory/lib/merge-stage.js", "factory/lib/board.js", ".factory/lib/x.js", ".claude/hooks/block-dangerous.sh", ".github/workflows/publish.yml", "package.json", "README.md", "bin/cli.js", "templates/factory/claude/agents/plan-skeptic.md"]) {
    expect(isOperatorMergePath(p), p).toBe(false);
  }
  // #178: 목록은 non-judge-paths.js의 하나다 — 엔진 모듈은 판정 import 닫힘 밖의 것만(board-static·status), .claude/.github은 없다.
  expect(OPERATOR_MERGE_GLOBS.some((g) => g.startsWith(".claude") || g.startsWith(".github"))).toBe(false);
  expect(OPERATOR_MERGE_GLOBS.filter((g) => g.startsWith("factory/lib/") || g.startsWith(".factory/")).every((g) => /(^|\/)lib\/(board-static|status)\.js$/.test(g))).toBe(true);
});

test("test_178_operator_merge_list_is_the_non_judge_list", () => {
  // 같은 객체다 — NON_JUDGE_GLOBS를 바꾸면 운영 세션의 답이 바뀐다(목록이 둘이 될 수 없다).
  expect(OPERATOR_MERGE_GLOBS).toBe(NON_JUDGE_GLOBS);
  expect(OPERATOR_MERGE_EXCLUDES).toBe(NON_JUDGE_EXCLUDES);
  // operator-merge.js는 자체 글롭 상수를 선언하지 않는다 — 경로 리터럴·`Object.freeze([`가 없고, non-judge-paths.js에서 가져온다.
  const src = readFileSync(new URL("../lib/operator-merge.js", import.meta.url), "utf8");
  expect(src).not.toMatch(/Object\.freeze\(\[/);
  expect(src).not.toMatch(/["'`](?:docs|templates|factory|\.factory)\//);
  expect(src).not.toMatch(/["'`][^"'`\n]*\*\*[^"'`\n]*["'`]/);
  expect(src).toMatch(/from\s+["']\.\/non-judge-paths\.js["']/);
  // 표본 경로마다 같은 답 — 엔진 저장소 분류(classifyProtected)와 운영 세션 판정(isOperatorMergePath)이 갈라지지 않는다.
  const samples = [
    "docs/research/x.md", "docs/factory/DECISIONS.md", "docs/factory/ops/watch-issue.sh", "templates/factory/docs/factory/board/index.html",
    "factory/lib/board-static.js", ".factory/lib/status.js", "factory/test/status.test.js",
    "docs/factory/CHARTER.md", "docs/factory/runs/149.md", "templates/factory/docs/factory/CHARTER.md", "docs/CLAUDE.md",
    "factory/lib/aggregate.js", "factory/lib/board.js", "factory/lib/heartbeat.js", "factory/lib/gh.js", "factory/test/aggregate.test.js",
    ".claude/hooks/block-dangerous.sh", "package.json", "README.md", "docs/../factory/lib/gh.js",
  ];
  for (const p of samples) {
    const nonJudge = classifyProtected([p], { engine: true }).non_judge.length === 1;
    expect(isOperatorMergePath(p), p).toBe(nonJudge);
  }
  // 합쳐진 목록이 운영 세션에 새로 연 것과, 여전히 사람에게 가는 것.
  expect(isOperatorMergePath("factory/lib/status.js")).toBe(true);
  expect(isOperatorMergePath("factory/lib/aggregate.js")).toBe(false);
  // CHARTER 둘은 여전히 판정 경로다 — operatorMergeVerdict가 그 PR을 사람에게 보낸다.
  for (const p of ["docs/factory/CHARTER.md", "templates/factory/docs/factory/CHARTER.md"]) {
    const v = operatorMergeVerdict(pr({ files: [{ path: "docs/research/x.md" }, { path: p }] }));
    expect(v.ok, p).toBe(false);
    expect(v.judge, p).toEqual([p]);
  }
  // 운영 세션 범위가 넓어진 자리: 판정 닫힘 밖의 엔진 모듈만 바꾼 GREEN PR은 허용된다.
  expect(operatorMergeVerdict(pr({ files: [{ path: "factory/lib/status.js" }, { path: "factory/test/status.test.js" }] }))).toEqual({ ok: true, reasons: [], judge: [] });
});

test("a docs-only, green, non-draft PR against the default branch is allowed; each failed lock names itself", () => {
  expect(operatorMergeVerdict(pr())).toEqual({ ok: true, reasons: [], judge: [] });
  const judge = operatorMergeVerdict(pr({ files: [{ path: "docs/research/x.md" }, { path: "factory/lib/gh.js" }] }));
  expect(judge.ok).toBe(false); expect(judge.judge).toEqual(["factory/lib/gh.js"]); expect(judge.reasons[0]).toMatch(/judge path/);
  expect(operatorMergeVerdict(pr({ isDraft: true })).reasons.join()).toMatch(/draft/);
  expect(operatorMergeVerdict(pr({ mergeable: "CONFLICTING" })).reasons.join()).toMatch(/not mergeable \(CONFLICTING\)/);
  expect(operatorMergeVerdict(pr({ baseRefName: "release/1.4.42" })).reasons.join()).toMatch(/targets release\/1\.4\.42, not main/);
  expect(operatorMergeVerdict(pr({ statusCheckRollup: [{ name: "factory/integrity", conclusion: "FAILURE" }] })).reasons.join()).toMatch(/factory\/integrity=FAILURE/);
  expect(operatorMergeVerdict(pr({ statusCheckRollup: [{ context: "ci", state: "PENDING" }] })).reasons.join()).toMatch(/ci=PENDING/);
  expect(operatorMergeVerdict(pr({ files: [] })).reasons.join()).toMatch(/no changed files/);
  // 체크가 하나도 없는 저장소(채택 저장소)는 체크 조건을 통과한다 — 경로·draft·mergeable이 문이다
  expect(operatorMergeVerdict(pr({ statusCheckRollup: [] })).ok).toBe(true);
  // 기본 브랜치는 호출자가 준다
  expect(operatorMergeVerdict(pr({ baseRefName: "trunk" }), { defaultBranch: "trunk" }).ok).toBe(true);
});
