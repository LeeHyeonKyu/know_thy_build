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

// KTB-7(재리뷰): `~`는 셸 확장이지 glob이 아니다. upload-artifact는 경로를 셸에 넘기지 않으므로
// `~/.claude/...`는 0 파일을 올리고, `if-no-files-found: ignore`라 실패조차 하지 않는다 — 트랜스크립트가
// 산출물 추출의 1순위 출처인데 아티팩트가 조용히 비어 있었다.
test("a `~` path in an upload-artifact step is a violation; an env-resolved absolute path is not", () => {
  const bad = "steps:\n  - uses: actions/upload-artifact@v4\n    with:\n      path: |\n        .factory/out/\n        ~/.claude/projects/**/*.jsonl\n      include-hidden-files: true\n";
  expect(lintWorkflow(bad)).toEqual([expect.objectContaining({ rule: "tilde-path", line: 6 })]);
  expect(lintWorkflow(bad.replace("        ~/.claude/projects/**/*.jsonl\n", "        ${{ env.CLAUDE_TRANSCRIPTS || format('{0}/.factory/out', github.workspace) }}/**/*.jsonl\n"))).toEqual([]);
  // 단일 값 형태와 리스트 항목 형태 둘 다 잡는다
  expect(lintWorkflow("  - uses: actions/upload-artifact@v4\n    with:\n      path: ~/x/*.log\n      include-hidden-files: true\n")).toEqual([expect.objectContaining({ rule: "tilde-path" })]);
  // upload-artifact 스텝 **밖**의 `~`는 건드리지 않는다(셸 run 줄에서는 진짜로 확장된다)
  expect(lintWorkflow('  - run: ls ~/.claude/projects\n')).toEqual([]);
  // 따옴표 하나로 비켜 갈 수 있으면 규칙이 아니다 — YAML이 따옴표를 떼고 나면 남는 건 같은 `~/x`다(KTB-10 M3)
  expect(lintWorkflow('  - uses: actions/upload-artifact@v4\n    with:\n      path: "~/x"\n      include-hidden-files: true\n')).toEqual([expect.objectContaining({ rule: "tilde-path" })]);
  expect(lintWorkflow("  - uses: actions/upload-artifact@v4\n    with:\n      path: |\n        '~/.claude/**/*.jsonl'\n      include-hidden-files: true\n")).toEqual([expect.objectContaining({ rule: "tilde-path" })]);
});

// KTB-10 I1: `${{ env.X }}`로 시작하는 경로는 그 env를 세우는 스텝이 실패하면 `/**/*.jsonl` — 곧
// 러너 **루트**에 앵커된 glob — 으로 접힌다. 업로드 스텝은 `if: always()`라 그때도 돌고,
// `if-no-files-found: ignore`라 아무 소리도 내지 않는다. 폴백이 없으면 그 사고는 보이지 않는다.
test("an artifact path starting with ${{ env.… }} needs a `||` fallback", () => {
  const step = (p) => `  - uses: actions/upload-artifact@v4\n    with:\n      path: |\n        .factory/out/\n${p}      include-hidden-files: true\n`;
  expect(lintWorkflow(step("        ${{ env.CLAUDE_TRANSCRIPTS }}/**/*.jsonl\n")))
    .toEqual([expect.objectContaining({ rule: "env-path-no-fallback", line: 5 })]);
  expect(lintWorkflow(step("        ${{ env.CLAUDE_TRANSCRIPTS || format('{0}/.factory/out', github.workspace) }}/**/*.jsonl\n"))).toEqual([]);
  // 단일 값 형태와 따옴표 형태도 같다
  expect(lintWorkflow("  - uses: actions/upload-artifact@v4\n    with:\n      path: ${{ env.X }}/out\n"))
    .toEqual([expect.objectContaining({ rule: "env-path-no-fallback" })]);
  expect(lintWorkflow('  - uses: actions/upload-artifact@v4\n    with:\n      path: "${{ env.X }}/out"\n'))
    .toEqual([expect.objectContaining({ rule: "env-path-no-fallback" })]);
  // env로 **시작하지 않는** 경로는 접혀도 워크스페이스 안에 남는다 — 규칙 밖이다
  expect(lintWorkflow("  - uses: actions/upload-artifact@v4\n    with:\n      path: out/${{ env.X }}/*.log\n")).toEqual([]);
  // upload-artifact 스텝 밖의 env 표현식은 건드리지 않는다
  expect(lintWorkflow("  - run: echo ${{ env.X }}\n")).toEqual([]);
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
    expect(y, f).toContain(`run: node .factory/bin/run-stage.js ${stage} \${{ github.event.issue.number || inputs.issue }}`);
    expect(y, f).toContain(`timeout-minutes: ${timeout}`);
    expect(y, f).toContain(`if: github.event_name == 'workflow_dispatch' || contains(fromJSON('[${labels}]'), github.event.label.name)`);
    expect(y, f).toContain(`group: factory-issue-\${{ github.event.issue.number || inputs.issue }}-${stage}`);
    expect(y, f).toContain("cancel-in-progress: false");
    expect(y, f).toContain("FACTORY_RUNNER_ID: gha-${{ github.run_id }}");
    expect(y, f).toContain("include-hidden-files: true");
    // KTB-7/O4: 세션 트랜스크립트가 산출물 추출의 1순위 출처다 — 실패했을 때 사후에 볼 수 있어야 한다.
    // merge는 claude를 띄우지 않으므로(script-only) 트랜스크립트가 없다.
    if (stage !== "merge") {
      // `~`는 upload-artifact가 펼치지 않는다 — 러너의 실제 $HOME을 선행 스텝이 GITHUB_ENV로 굳힌다
      expect(y, f).toContain('run: echo "CLAUDE_TRANSCRIPTS=$HOME/.claude/projects" >> "$GITHUB_ENV"');
      // env가 비면(resolve 스텝이 돌지 못했으면) 경로가 루트 앵커 glob으로 접힌다 — 폴백은 워크스페이스 안이다(KTB-10 I1)
      expect(y, f).toContain("${{ env.CLAUDE_TRANSCRIPTS || format('{0}/.factory/out', github.workspace) }}/**/*.jsonl");
      // 그리고 그 resolve 스텝은 **첫 스텝**이고 `if: always()`다 — setup이 실패해도 값이 선다
      expect(y.indexOf("- name: Resolve the session transcript directory"), f).toBeLessThan(y.indexOf("- uses: actions/checkout@v4"));
      expect(y, f).toMatch(/- name: Resolve the session transcript directory\n {8}if: always\(\)\n/);
      expect(y, f).not.toContain("            ~/.claude");
      expect(y, f).toContain("if-no-files-found: ignore");
    }
    expect(y, f).toContain("token: ${{ secrets.FACTORY_BOT_TOKEN }}");
    expect(y, f).toContain("uses: ./.factory/actions/setup");
    expect(y, f).toContain("fetch-depth: 0");
    if (stage === "merge") { expect(y).toContain("GH_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN || secrets.FACTORY_BOT_TOKEN }}"); expect(y).toContain('claude: "false"'); }
    else { expect(y).toContain("GH_TOKEN: ${{ secrets.FACTORY_BOT_TOKEN }}"); expect(y).toContain("CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"); }
    expect(y, f).toContain(["implement", "review", "merge"].includes(stage) ? 'test-env: "true"' : 'test-env: "false"');
  }
});

// KTB-8: 라벨 이벤트 하나가 스테이지 워크플로 5개의 런을 만든다(GitHub는 `issues: labeled`에 라벨 이름
// 필터를 주지 않는다). 다섯이 한 concurrency 그룹을 공유하면 한 대기 슬롯을 두고 서로를 취소해서,
// 조건이 맞는 유일한 런이 밀려나고 이슈가 기록 하나 없이 멈춘다(데모 #2 `factory:ready` 영구 정지).
test("the five stage workflows never share a concurrency group (KTB-8)", () => {
  const groups = Object.keys(STAGE).map((f) => /^\s*group:\s*(.+)$/m.exec(readFileSync(join(W, f), "utf8"))[1].trim());
  expect(new Set(groups).size).toBe(5);
  for (const g of groups) expect(g).toContain("github.event.issue.number || inputs.issue");
});

// 그룹을 갈라도 "런이 아예 만들어지지 않은 채 멈춘 스테이지"는 라벨로 되살릴 수 없다 — 라벨이 이미
// 목적 상태에 있어 `labeled` 이벤트가 다시 나지 않기 때문이다. dispatch가 유일한 재점화 경로다.
test("every stage workflow can be dispatched with an issue input (KTB-8)", () => {
  for (const [f, [stage]] of Object.entries(STAGE)) {
    const y = readFileSync(join(W, f), "utf8");
    expect(y, f).toContain("workflow_dispatch:");
    expect(y, f).toMatch(/inputs:\n {6}issue:\n(?: {8}.*\n)* {8}required: true\n/);
    expect(y, f).toContain("type: string");
    // dispatch에는 label이 없다 — 잡 조건이 이벤트 이름을 먼저 보지 않으면 재점화가 통째로 죽는다
    expect(y, f).toContain("if: github.event_name == 'workflow_dispatch' ||");
    expect(y, f).toContain(`run-stage.js ${stage} \${{ github.event.issue.number || inputs.issue }}`);
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
  // retro도 트랜스크립트를 1순위 출처로 쓴다(KTB-7 재리뷰) — 그러면 사후 조사에도 있어야 한다
  expect(y).toContain('run: echo "CLAUDE_TRANSCRIPTS=$HOME/.claude/projects" >> "$GITHUB_ENV"');
  expect(y).toContain("${{ env.CLAUDE_TRANSCRIPTS || format('{0}/.factory/out', github.workspace) }}/**/*.jsonl");
  expect(y.indexOf("- name: Resolve the session transcript directory")).toBeLessThan(y.indexOf("- uses: actions/checkout@v4"));
  expect(y).toMatch(/- name: Resolve the session transcript directory\n {8}if: always\(\)\n/);
  expect(y).toContain("if-no-files-found: ignore");
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
