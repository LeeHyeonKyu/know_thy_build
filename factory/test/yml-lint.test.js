import { test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lintWorkflow, lintLoggingHook } from "../lib/yml-lint.js";

test("flow mapping with ${{ }} is a violation; block mapping is not", () => {
  expect(lintWorkflow("with: { name: x-${{ matrix.y }}, path: .spike/ }\n")).toEqual([expect.objectContaining({ line: 1, rule: "flow-interpolation" })]);
  expect(lintWorkflow("with:\n  name: x-${{ matrix.y }}\n")).toEqual([]);
  expect(lintWorkflow("if: contains(fromJSON('[\"a\"]'), github.event.label.name)\n")).toEqual([]);   // fromJSON의 {}는 문자열 안
});

test("upload-artifact with a dot path needs include-hidden-files", () => {
  const bad = "steps:\n  - uses: actions/upload-artifact@v4\n    with:\n      name: r\n      path: .factory/out/\n  - run: echo\n";
  expect(lintWorkflow(bad)).toEqual([expect.objectContaining({ rule: "hidden-artifact" })]);
  const ok = bad.replace("path: .factory/out/\n", "path: .factory/out/\n      include-hidden-files: true\n");
  expect(lintWorkflow(ok)).toEqual([]);
  const multi = "  - uses: actions/upload-artifact@v4\n    with:\n      path: |\n        docs/x/\n        .factory/out/\n      include-hidden-files: true\n";
  expect(lintWorkflow(multi)).toEqual([]);
  expect(lintWorkflow(multi.replace("      include-hidden-files: true\n", ""))).toHaveLength(1);
});

test("logging hooks must end with exit 0", () => {
  expect(lintLoggingHook("#!/bin/bash\necho hi || true\nexit 0\n")).toEqual([]);
  expect(lintLoggingHook("#!/bin/bash\necho hi\n")).toEqual([expect.objectContaining({ rule: "exit0" })]);
});

const W = new URL("../../templates/factory/github/workflows/", import.meta.url).pathname;
const files = readdirSync(W).filter((f) => f.endsWith(".yml"));
const STAGE = { "factory-triage.yml": ["triage", 15, '"factory:queue"'], "factory-plan.yml": ["plan", 60, '"factory:ready"'], "factory-implement.yml": ["implement", 90, '"factory:planned","factory:rework"'], "factory-review.yml": ["review", 45, '"factory:awaiting-review"'], "factory-merge.yml": ["merge", 20, '"factory:approved"'] };

test("all eight workflow templates exist and pass lint", () => {
  expect(files.sort()).toEqual(["factory-implement.yml", "factory-integrity.yml", "factory-merge.yml", "factory-plan.yml", "factory-retro.yml", "factory-review.yml", "factory-sweeper.yml", "factory-triage.yml"]);
  for (const f of files) expect(lintWorkflow(readFileSync(join(W, f), "utf8")), f).toEqual([]);
});

test("stage workflows follow the §4.1 table and the token/concurrency rules", () => {
  for (const [f, [stage, timeout, labels]] of Object.entries(STAGE)) {
    const y = readFileSync(join(W, f), "utf8");
    expect(y, f).toContain(`run: node .factory/bin/run-stage.js ${stage} \${{ github.event.issue.number }}`);
    expect(y, f).toContain(`timeout-minutes: ${timeout}`);
    expect(y, f).toContain(`if: contains(fromJSON('[${labels}]'), github.event.label.name)`);
    expect(y, f).toContain("group: factory-issue-${{ github.event.issue.number }}");
    expect(y, f).toContain("cancel-in-progress: false");
    expect(y, f).toContain("FACTORY_RUNNER_ID: gha-${{ github.run_id }}");
    expect(y, f).toContain("include-hidden-files: true");
    expect(y, f).toContain("token: ${{ secrets.FACTORY_BOT_TOKEN }}");
    expect(y, f).toContain("uses: ./.factory/actions/setup");
    expect(y, f).toContain("fetch-depth: 0");
    if (stage === "merge") { expect(y).toContain("GH_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN || secrets.FACTORY_BOT_TOKEN }}"); expect(y).toContain('claude: "false"'); }
    else { expect(y).toContain("GH_TOKEN: ${{ secrets.FACTORY_BOT_TOKEN }}"); expect(y).toContain("CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"); }
    expect(y, f).toContain(["implement", "review", "merge"].includes(stage) ? 'test-env: "true"' : 'test-env: "false"');
  }
});

test("sweeper and integrity workflows", () => {
  const s = readFileSync(join(W, "factory-sweeper.yml"), "utf8");
  expect(s).toContain("cron: '*/30 * * * *'"); expect(s).toContain("workflow_dispatch:"); expect(s).toContain("run: node .factory/bin/sweep.js"); expect(s).toContain("timeout-minutes: 5");
  const i = readFileSync(join(W, "factory-integrity.yml"), "utf8");
  expect(i).toContain("name: factory/integrity"); expect(i).toContain("pull_request:"); expect(i).toContain("run: node .factory/bin/integrity.js"); expect(i).toContain("timeout-minutes: 5");
});

// retro는 스테이지가 아니다(라벨 상태 머신 밖) — 트리거도 concurrency도 §4.1 표의 스테이지 행과 다르다.
test("retro workflow is merge-triggered, serialized, and never cancelled (§8.4 / P4-R5)", () => {
  const y = readFileSync(join(W, "factory-retro.yml"), "utf8");
  expect(y).toContain("name: factory-retro");
  expect(y).toContain("pull_request:");
  expect(y).toContain("types: [closed]");
  expect(y).toContain("if: github.event.pull_request.merged == true");   // 닫히기만 한 PR은 배울 것이 없다
  expect(y).toContain("group: factory-retro");                           // 이슈별이 아니라 잡 전체가 하나의 큐다
  expect(y).toContain("cancel-in-progress: false");
  expect(y).toContain("timeout-minutes: 30");
  expect(y).toContain("fetch-depth: 0");
  // PR head/merge ref가 아니라 머지된 결과가 있는 base 브랜치를 본다 — retro는 현재 저장소 상태를 읽는다
  expect(y).toContain("ref: ${{ github.event.pull_request.base.ref }}");
  expect(y).toContain("token: ${{ secrets.FACTORY_BOT_TOKEN }}");
  expect(y).toContain("uses: ./.factory/actions/setup");
  expect(y).toContain('claude: "true"');                                 // full retro는 claude -p를 부른다
  expect(y).toContain('test-env: "false"');                              // retro는 테스트를 돌리지 않는다
  expect(y).toContain("GH_TOKEN: ${{ secrets.FACTORY_BOT_TOKEN }}");
  expect(y).toContain("CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
  expect(y).toContain("ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}");
  expect(y).toContain("FACTORY_RUNNER_ID: gha-${{ github.run_id }}");
  expect(y).toContain("run: node .factory/bin/retro.js");
  expect(y).toContain(".factory/out/");
  expect(y).toContain("include-hidden-files: true");
  // cron이 없다는 것 자체가 §8.4의 결정이다 — 머지가 없으면 배울 것도 없다.
  expect(y).not.toContain("schedule:");
  expect(y).not.toContain("cron:");
});

test("composite setup action", () => {
  const a = readFileSync(new URL("../../templates/factory/factory/actions/setup/action.yml", import.meta.url).pathname, "utf8");
  expect(a).toContain("using: composite");
  expect(a).toContain("node-version: 22");
  expect(a).toContain("npm install --prefix .factory --no-audit --no-fund");
  expect(a).toContain("npm i -g @anthropic-ai/claude-code");
  expect(a).toContain("node .factory/bin/setup-env.js");
  expect(a).toContain("node .factory/bin/test-env.js up");
  expect(a).toContain("command -v jq");
  expect(a).toContain("git config user.name");
  expect(lintWorkflow(a)).toEqual([]);
});
