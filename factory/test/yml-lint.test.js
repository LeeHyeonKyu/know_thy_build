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

// KTB-15b I1: merge-stage's own draft→ready flip (KTB-15, `gh pr ready`) fires `ready_for_review` —
// any factory workflow listening for it restarts a required check mid-merge, racing `gh pr merge`.
test("KTB-15b I1: a pull_request trigger listing ready_for_review is a violation; the comment mentioning it is not", () => {
  expect(lintWorkflow("on:\n  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]\n"))
    .toEqual([expect.objectContaining({ rule: "ready-for-review-trigger", line: 3 })]);
  expect(lintWorkflow("on:\n  pull_request:\n    types: [opened, synchronize, reopened]\n")).toEqual([]);
  // a comment merely explaining why it's excluded doesn't trip the rule
  expect(lintWorkflow("on:\n  pull_request:\n    # ready_for_review is deliberately excluded (KTB-15b)\n    types: [opened, synchronize, reopened]\n")).toEqual([]);
});

test("logging hooks must end with exit 0", () => {
  expect(lintLoggingHook("#!/bin/bash\necho hi || true\nexit 0\n")).toEqual([]);
  expect(lintLoggingHook("#!/bin/bash\necho hi\n")).toEqual([expect.objectContaining({ rule: "exit0" })]);
});

const W = new URL("../../templates/factory/github/workflows/", import.meta.url).pathname;
const files = readdirSync(W).filter((f) => f.endsWith(".yml"));
// ADR-020 KTB-24 — §4.1 표의 새 값. 데모 #15의 review는 4역할 × +709줄 PR을 45분 안에 못 끝내고
// **한도에 걸려** 잘렸다(45 m 19 s). 올린 값은 그 관측에서 나왔다: review는 implement과 같은 90,
// plan은 4대 opus 직렬 구간의 실측(42 m)에 여유를 더한 75, 나머지는 정리 스텝 몫만큼 조금씩 위로.
const STAGE = { "factory-triage.yml": ["triage", 20, '"factory:queue"'], "factory-plan.yml": ["plan", 75, '"factory:ready"'], "factory-implement.yml": ["implement", 90, '"factory:planned","factory:rework"'], "factory-review.yml": ["review", 90, '"factory:awaiting-review"'], "factory-merge.yml": ["merge", 30, '"factory:approved"'] };
const ISSUE_EXPR = "${{ github.event.issue.number || inputs.issue }}";

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

// ADR-020 KTB-24 — 취소된 잡은 `run-stage.js`의 finally를 실행하지 않는다: 데모 #15는 락 고아 +
// 전이 없음 + run 기록 없음으로 끝났다. 정리 스텝이 그 셋을 덮는다.
test("every stage workflow cleans up after a cancelled or failed job (KTB-24)", () => {
  for (const [f, [stage]] of Object.entries(STAGE)) {
    const y = readFileSync(join(W, f), "utf8");
    expect(y, f).toContain("- name: Aborted cleanup");
    // KTB-24 fix: `cancelled() || failure()`는 "런이 취소됐다"와 "앞 스텝이 실패했다"만 덮는다 —
    // 잡 타임아웃·러너 소실처럼 그 어느 쪽으로도 분류되지 않는 끝맺음에서 정리가 통째로 건너뛰어진다.
    expect(y, f).toContain("if: always() && job.status != 'success'");
    expect(y, f).toContain(`node .factory/bin/run-stage.js ${stage} ${ISSUE_EXPR} --aborted "\${{ job.status }}"`);
    // 정리 코드는 base의 것이어야 한다 — implement는 에이전트 브랜치 위에, review·merge는 PR head로
    // detach된 트리 위에 있다.
    expect(y, f).toContain("git checkout ${{ github.sha }} -- .factory || true");
    // 설치는 없다(setup은 이미 돌았다) — 취소 유예 안에 끝나야 한다.
    expect(y.slice(y.indexOf("- name: Aborted cleanup")), f).not.toContain("npm install");
  }
});

// ADR-020 KTB-26 — cron sweeper만으로는 부족했다(몇 시간짜리 공백, 취소된 sweeper 런). 스테이지가
// 끝날 때마다 빠른 팔을 한 번 돌린다 — 그리고 반드시 정리 스텝 **뒤**여야 방금 세운 blocked을 본다.
test("every stage workflow and retro end with a quick sweep, after the cleanup step (KTB-26)", () => {
  for (const f of [...Object.keys(STAGE), "factory-retro.yml"]) {
    const y = readFileSync(join(W, f), "utf8");
    expect(y, f).toMatch(/- name: Sweep\n\s+if: always\(\)\n/);
    expect(y, f).toContain("node .factory/bin/sweep.js --quick");
    expect(y, f).toContain("actions: write");            // `gh workflow run`으로 재점화한다
    const names = [...y.matchAll(/^\s*-\s+name:\s*(.+?)\s*$/gm)].map((m) => m[1]);
    expect(names.at(-1), f).toBe("Sweep");
    if (f !== "factory-retro.yml") expect(names.indexOf("Aborted cleanup"), f).toBeLessThan(names.indexOf("Sweep"));
  }
});

test("yml-lint enforces the KTB-24/26 stage rules (and leaves non-stage files alone)", () => {
  const ok = readFileSync(join(W, "factory-review.yml"), "utf8");
  expect(lintWorkflow(ok)).toEqual([]);
  // 45분으로 되돌리면 하한 규칙이 잡는다 — implement·review만 ≥ 60이다
  expect(lintWorkflow(ok.replace("timeout-minutes: 90", "timeout-minutes: 45")))
    .toEqual([expect.objectContaining({ rule: "stage-timeout-floor" })]);
  expect(lintWorkflow(readFileSync(join(W, "factory-triage.yml"), "utf8").replace("timeout-minutes: 20", "timeout-minutes: 15"))).toEqual([]);
  // 정리 스텝의 조건이 예전의 좁은 모양으로 되돌아가면 잡는다(KTB-24 fix)
  expect(lintWorkflow(ok.replace("        if: always() && job.status != 'success'\n", "        if: cancelled() || failure()\n")))
    .toEqual([expect.objectContaining({ rule: "aborted-cleanup-step" })]);
  // 조건 자체가 사라져도(그냥 always()) 잡는다 — "성공한 잡에서도 정리가 돈다"는 다른 사고다
  expect(lintWorkflow(ok.replace("        if: always() && job.status != 'success'\n", "        if: always()\n")))
    .toEqual([expect.objectContaining({ rule: "aborted-cleanup-step" })]);
  // sweep 스텝이 마지막이 아니면
  const swapped = ok.replace(/ {6}- name: Sweep[\s\S]*$/, "      - name: Done\n        run: echo done\n");
  expect(lintWorkflow(swapped)).toEqual([expect.objectContaining({ rule: "sweep-step-last" })]);
  // KTB-24 fix: **이름 없는 `- uses:` 스텝**이 Sweep 뒤에 붙어도 잡는다. 예전 린트는 `- name:`만 세어
  // 이 모양을 소리 없이 통과시켰다 — 그 스텝이 실패하면 방금 sweep이 훑은 상태가 다시 흔들린다.
  expect(lintWorkflow(ok + "      - uses: actions/cache/save@v4\n"))
    .toEqual([expect.objectContaining({ rule: "sweep-step-last" })]);
  // 스테이지 워크플로가 아닌 텍스트에는 이 규칙들이 걸리지 않는다
  expect(lintWorkflow("with:\n  name: x-${{ matrix.y }}\n")).toEqual([]);
  expect(lintWorkflow(readFileSync(join(W, "factory-sweeper.yml"), "utf8"))).toEqual([]);
});

// r1 재리뷰 M5 — `Run stage`와 `Aborted cleanup`은 **같은** `FACTORY_RUNNER_ID` 식을 실어야 한다.
// 둘이 갈리면 정리 스텝이 자기 런의 락을 "남의 것"으로 읽고(KTB-24 fix의 소유자 비교가 러너 id로
// 이뤄진다) 고아 락을 그대로 남긴다 — 데모 #15의 잔해가 정확히 그 모양이었다.
test("yml-lint pins FACTORY_RUNNER_ID to the same expression in both steps (M5)", () => {
  const ok = readFileSync(join(W, "factory-review.yml"), "utf8");
  expect(lintWorkflow(ok)).toEqual([]);
  // 모든 스테이지 워크플로가 실제로 그렇다
  for (const f of Object.keys(STAGE)) {
    const ids = [...readFileSync(join(W, f), "utf8").matchAll(/^\s*FACTORY_RUNNER_ID:\s*(.+?)\s*$/gm)].map((m) => m[1]);
    expect(ids.length, f).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size, f).toBe(1);
  }
  // 정리 스텝의 값만 바꾸면 잡는다
  const at = ok.indexOf("- name: Aborted cleanup");
  const drifted = ok.slice(0, at) + ok.slice(at).replace("FACTORY_RUNNER_ID: gha-${{ github.run_id }}", "FACTORY_RUNNER_ID: gha-cleanup");
  expect(lintWorkflow(drifted)).toEqual([expect.objectContaining({ rule: "runner-id-consistent" })]);
  // 아예 빠져도 잡는다
  const missing = ok.slice(0, at) + ok.slice(at).replace("          FACTORY_RUNNER_ID: gha-${{ github.run_id }}\n", "");
  expect(lintWorkflow(missing)).toEqual([expect.objectContaining({ rule: "runner-id-consistent" })]);
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
  expect(y).toContain("timeout-minutes: 45");                            // KTB-24 — retro도 30 → 45
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

// G1: [runtime].setup (invoked via setup-env.js) must be its own composite-action step, split off from the
// npm-install/git-config step — a $GITHUB_PATH append made by [runtime].setup only takes effect starting
// with the NEXT step, never the one that wrote it, so a harness toolchain install (e.g. Flutter) needs its
// own step boundary before Claude/test-env install and before the caller workflow's gate step run later.
test("composite setup action runs [runtime].setup as its own step, not sharing one with npm install (G1)", () => {
  const a = readFileSync(new URL("../../templates/factory/factory/actions/setup/action.yml", import.meta.url).pathname, "utf8");
  const steps = a.split(/\n(?=    - )/).filter((s) => s.trim().startsWith("- "));
  const setupStep = steps.find((s) => s.includes("node .factory/bin/setup-env.js"));
  expect(setupStep, "no step runs setup-env.js").toBeTruthy();
  expect(setupStep).not.toContain("npm install --prefix .factory");
  expect(setupStep).not.toContain("git config user.name");
  expect(setupStep).not.toContain("npm i -g @anthropic-ai/claude-code");
  expect(setupStep).not.toContain("if: always()");
  // 이 스텝의 run: 값은 setup-env.js 호출 한 줄뿐이어야 한다 — 다른 명령과 여러 줄로 합쳐져 있지 않다는 뜻이다.
  expect(setupStep).toMatch(/run:\s*node \.factory\/bin\/setup-env\.js\s*\n?$/);
});
