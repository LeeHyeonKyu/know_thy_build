import { test, expect } from "vitest";
import { operatorMergeVerdict, isOperatorMergePath, OPERATOR_MERGE_GLOBS } from "../lib/operator-merge.js";

/** 2026-10-02 — 운영 세션의 비판정 머지 판정. 양의 목록이고, 목록 밖은 전부 판정 경로다. */
const pr = (over = {}) => ({
  number: 12, isDraft: false, mergeable: "MERGEABLE", baseRefName: "main",
  files: [{ path: "docs/research/x.md" }, { path: "docs/factory/ops/watch-issue.sh" }],
  statusCheckRollup: [{ name: "factory/integrity", conclusion: "SUCCESS" }],
  ...over,
});

test("non-judge paths are a positive list: docs, research, ops scripts, the board page — nothing under factory/, .factory/, .claude/, .github/", () => {
  for (const p of ["docs/research/x.md", "docs/factory/ops/board-proxy.mjs", "docs/superpowers/plans/p.md", "docs/factory/board/index.html", "templates/factory/docs/factory/board/index.html", "docs/factory/DECISIONS.md"]) {
    expect(isOperatorMergePath(p), p).toBe(true);
  }
  for (const p of ["docs/factory/CHARTER.md", "docs/factory/runs/149.md", "templates/factory/docs/factory/CHARTER.md", "factory/lib/merge-stage.js", "factory/lib/board.js", ".factory/lib/x.js", ".claude/hooks/block-dangerous.sh", ".github/workflows/publish.yml", "package.json", "README.md", "bin/cli.js", "templates/factory/claude/agents/plan-skeptic.md"]) {
    expect(isOperatorMergePath(p), p).toBe(false);
  }
  expect(OPERATOR_MERGE_GLOBS.some((g) => g.startsWith("factory/") || g.startsWith(".factory") || g.startsWith(".claude") || g.startsWith(".github"))).toBe(false);
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
