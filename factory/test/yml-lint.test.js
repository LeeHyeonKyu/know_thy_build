import { test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lintWorkflow, lintLoggingHook, isFactoryWorkflowFile } from "../lib/yml-lint.js";
import { lintFile, NUL_RULE } from "../bin/lint.js";

test("flow mapping with ${{ }} is a violation; block mapping is not", () => {
  expect(lintWorkflow("with: { name: x-${{ matrix.y }}, path: .spike/ }\n")).toEqual([expect.objectContaining({ line: 1, rule: "flow-interpolation" })]);
  expect(lintWorkflow("with:\n  name: x-${{ matrix.y }}\n")).toEqual([]);
  expect(lintWorkflow("if: contains(fromJSON('[\"a\"]'), github.event.label.name)\n")).toEqual([]);   // fromJSON의 {}는 문자열 안
});

// SF-1 이후 모든 upload-artifact 스텝은 `retention-days`를 **명시**해야 한다(아래 artifact-retention).
// 그래서 이 파일의 스니펫들은 자기 규칙만 남기기 위해 그 줄을 함께 싣는다.
const RETENTION = "      retention-days: 7\n";

test("upload-artifact with a dot path needs include-hidden-files", () => {
  const bad = "steps:\n  - uses: actions/upload-artifact@v4\n    with:\n      name: r\n      path: .factory/out/\n" + RETENTION + "  - run: echo\n";
  expect(lintWorkflow(bad)).toEqual([expect.objectContaining({ rule: "hidden-artifact" })]);
  const ok = bad.replace("path: .factory/out/\n", "path: .factory/out/\n      include-hidden-files: true\n");
  expect(lintWorkflow(ok)).toEqual([]);
  const multi = "  - uses: actions/upload-artifact@v4\n    with:\n      path: |\n        docs/x/\n        .factory/out/\n      include-hidden-files: true\n" + RETENTION;
  expect(lintWorkflow(multi)).toEqual([]);
  expect(lintWorkflow(multi.replace("      include-hidden-files: true\n", ""))).toHaveLength(1);
});

// KTB-7(재리뷰): `~`는 셸 확장이지 glob이 아니다. upload-artifact는 경로를 셸에 넘기지 않으므로
// `~/.claude/...`는 0 파일을 올리고, `if-no-files-found: ignore`라 실패조차 하지 않는다 — 트랜스크립트가
// 산출물 추출의 1순위 출처인데 아티팩트가 조용히 비어 있었다.
test("a `~` path in an upload-artifact step is a violation; an env-resolved absolute path is not", () => {
  const bad = "steps:\n  - uses: actions/upload-artifact@v4\n    with:\n      path: |\n        .factory/out/\n        ~/.claude/projects/**/*.jsonl\n      include-hidden-files: true\n" + RETENTION;
  expect(lintWorkflow(bad)).toEqual([expect.objectContaining({ rule: "tilde-path", line: 6 })]);
  expect(lintWorkflow(bad.replace("        ~/.claude/projects/**/*.jsonl\n", "        ${{ env.CLAUDE_TRANSCRIPTS || format('{0}/.factory/out', github.workspace) }}/**/*.jsonl\n"))).toEqual([]);
  // 단일 값 형태와 리스트 항목 형태 둘 다 잡는다
  expect(lintWorkflow("  - uses: actions/upload-artifact@v4\n    with:\n      path: ~/x/*.log\n      include-hidden-files: true\n" + RETENTION)).toEqual([expect.objectContaining({ rule: "tilde-path" })]);
  // upload-artifact 스텝 **밖**의 `~`는 건드리지 않는다(셸 run 줄에서는 진짜로 확장된다)
  expect(lintWorkflow('  - run: ls ~/.claude/projects\n')).toEqual([]);
  // 따옴표 하나로 비켜 갈 수 있으면 규칙이 아니다 — YAML이 따옴표를 떼고 나면 남는 건 같은 `~/x`다(KTB-10 M3)
  expect(lintWorkflow('  - uses: actions/upload-artifact@v4\n    with:\n      path: "~/x"\n      include-hidden-files: true\n' + RETENTION)).toEqual([expect.objectContaining({ rule: "tilde-path" })]);
  expect(lintWorkflow("  - uses: actions/upload-artifact@v4\n    with:\n      path: |\n        '~/.claude/**/*.jsonl'\n      include-hidden-files: true\n" + RETENTION)).toEqual([expect.objectContaining({ rule: "tilde-path" })]);
});

// KTB-10 I1: `${{ env.X }}`로 시작하는 경로는 그 env를 세우는 스텝이 실패하면 `/**/*.jsonl` — 곧
// 러너 **루트**에 앵커된 glob — 으로 접힌다. 업로드 스텝은 `if: always()`라 그때도 돌고,
// `if-no-files-found: ignore`라 아무 소리도 내지 않는다. 폴백이 없으면 그 사고는 보이지 않는다.
test("an artifact path starting with ${{ env.… }} needs a `||` fallback", () => {
  const step = (p) => `  - uses: actions/upload-artifact@v4\n    with:\n      path: |\n        .factory/out/\n${p}      include-hidden-files: true\n${RETENTION}`;
  expect(lintWorkflow(step("        ${{ env.CLAUDE_TRANSCRIPTS }}/**/*.jsonl\n")))
    .toEqual([expect.objectContaining({ rule: "env-path-no-fallback", line: 5 })]);
  expect(lintWorkflow(step("        ${{ env.CLAUDE_TRANSCRIPTS || format('{0}/.factory/out', github.workspace) }}/**/*.jsonl\n"))).toEqual([]);
  // 단일 값 형태와 따옴표 형태도 같다
  expect(lintWorkflow("  - uses: actions/upload-artifact@v4\n    with:\n      path: ${{ env.X }}/out\n" + RETENTION))
    .toEqual([expect.objectContaining({ rule: "env-path-no-fallback" })]);
  expect(lintWorkflow('  - uses: actions/upload-artifact@v4\n    with:\n      path: "${{ env.X }}/out"\n' + RETENTION))
    .toEqual([expect.objectContaining({ rule: "env-path-no-fallback" })]);
  // env로 **시작하지 않는** 경로는 접혀도 워크스페이스 안에 남는다 — 규칙 밖이다
  expect(lintWorkflow("  - uses: actions/upload-artifact@v4\n    with:\n      path: out/${{ env.X }}/*.log\n" + RETENTION)).toEqual([]);
  // upload-artifact 스텝 밖의 env 표현식은 건드리지 않는다
  expect(lintWorkflow("  - run: echo ${{ env.X }}\n")).toEqual([]);
});

// ADR-020 최종 리뷰 SF-1: 아티팩트에는 크리덴셜이 닿은 텍스트가 들어갈 수 있고(트랜스크립트 ·
// `.git/config`를 읽은 어떤 출력이든), 공개 저장소에서 그 아티팩트는 **레포 read 권한자 누구나**
// 받는다. `retention-days`를 적지 않으면 기본이 90일이다 — 노출이 석 달 간다는 뜻이고, 그 사실은
// 파일 어디에도 쓰여 있지 않다. 값이 **명시적으로** 있어야 하고 14일을 넘지 않아야 한다.
test("every upload-artifact step needs an explicit retention-days ≤ 14 (artifact-retention)", () => {
  const step = (extra) => `steps:\n  - uses: actions/upload-artifact@v4\n    with:\n      name: r\n      path: out/\n${extra}`;
  expect(lintWorkflow(step(""))).toEqual([expect.objectContaining({ rule: "artifact-retention", line: 2 })]);
  expect(lintWorkflow(step("      retention-days: 90\n"))).toEqual([expect.objectContaining({ rule: "artifact-retention" })]);
  expect(lintWorkflow(step("      retention-days: 0\n"))).toEqual([expect.objectContaining({ rule: "artifact-retention" })]);
  expect(lintWorkflow(step("      retention-days: 7\n"))).toEqual([]);
  expect(lintWorkflow(step("      retention-days: 14\n"))).toEqual([]);
  // 표현식은 린트가 값을 읽을 수 없다 — 읽을 수 없는 값은 통과시키지 않는다(`vars.X`가 비면 90일이다)
  expect(lintWorkflow(step("      retention-days: ${{ vars.R }}\n"))).toEqual([expect.objectContaining({ rule: "artifact-retention" })]);
  // 규칙을 설명하는 **주석**은 규칙을 만족시키지 않는다 — 자기 설명문을 읽는 린트는 린트가 아니다
  expect(lintWorkflow(step("      # retention-days: 7\n"))).toEqual([expect.objectContaining({ rule: "artifact-retention" })]);
  // upload-artifact 스텝이 아닌 곳은 건드리지 않는다
  expect(lintWorkflow("steps:\n  - uses: actions/download-artifact@v4\n    with:\n      name: r\n")).toEqual([]);
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

test("all nine workflow templates exist and pass lint", () => {
  // KTB-44 — 아홉 번째는 `factory-rehearse.yml`(ADR-025): 스테이지가 아니라 **첫 이슈 전에** 하네스를
  // 러너에서 한 번 돌리는 잡이다. 스테이지 규칙(`STAGE` 표)에는 들어가지 않는다 — run-stage를 부르지 않는다.
  expect(files.sort()).toEqual(["factory-implement.yml", "factory-integrity.yml", "factory-merge.yml", "factory-plan.yml", "factory-rehearse.yml", "factory-retro.yml", "factory-review.yml", "factory-sweeper.yml", "factory-triage.yml"]);
  // 파일명을 함께 넘긴다 — `merge-token-scope`(ADR-021)의 파일 범위 갈래는 그래야 판정한다(doctor가 그렇게 부른다).
  for (const f of files) expect(lintWorkflow(readFileSync(join(W, f), "utf8"), { file: f }), f).toEqual([]);
});

test("stage workflows follow the §4.1 table and the token/concurrency rules", () => {
  for (const [f, [stage, timeout, labels]] of Object.entries(STAGE)) {
    const y = readFileSync(join(W, f), "utf8");
    // MF-2: 이슈 번호는 스텝 `env:`의 `ISSUE`로만 들어오고, 스크립트는 `"$ISSUE"`만 읽는다.
    expect(y, f).toContain(`ISSUE: ${ISSUE_EXPR}`);
    expect(y, f).toContain(`node .factory/bin/run-stage.js ${stage} "$ISSUE"`);
    expect(y, f).not.toContain(`run-stage.js ${stage} ${ISSUE_EXPR}`);
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
    expect(y, f).toContain(`node .factory/bin/run-stage.js ${stage} "$ISSUE"`);
  }
});

// ADR-020 최종 리뷰 MF-2 — dispatch 입력은 **env로** 들어오고, 스크립트는 `"$ISSUE"`만 읽으며,
// 모양이 아니면 소리내어 죽는다. `${{ inputs.issue }}`를 `run:`에 붙여 넣던 옛 모양은 `gh workflow run`
// 권한(= 레포 write)을 시크릿 읽기로 승격시키는 주입 싱크였다 — 그 스텝의 env에 세 토큰이 다 있다.
test("MF-2: the issue input is bound via env and validated, never interpolated into run:", () => {
  for (const [f, [stage]] of Object.entries(STAGE)) {
    const y = readFileSync(join(W, f), "utf8");
    expect(y, f).toContain(`          ISSUE: ${ISSUE_EXPR}\n`);
    expect(y, f).toContain('[[ "$ISSUE" =~ ^[0-9]+$ ]] ||');
    expect(y, f).toContain(`node .factory/bin/run-stage.js ${stage} "$ISSUE"`);
    expect(y, f).toContain(`node .factory/bin/run-stage.js ${stage} "$ISSUE" --aborted "\${{ job.status }}"`);
    // 두 스텝(Run stage · Aborted cleanup) 모두 자기 env에 ISSUE를 싣는다 — 잡 레벨 env는 안 쓴다.
    expect([...y.matchAll(/^ {10}ISSUE: /gm)], f).toHaveLength(2);
    expect([...y.matchAll(/\[\[ "\$ISSUE" =~ \^\[0-9\]\+\$ \]\]/g)], f).toHaveLength(2);
    // 그리고 린터가 그 모양을 붙들고 있다 — 어느 워크플로에도 run: 안의 inputs/github.event는 없다.
    expect(lintWorkflow(y), f).toEqual([]);
  }
  // 여덟 템플릿 전부(스테이지가 아닌 것 포함)가 이 규칙을 통과한다
  for (const f of files) expect(lintWorkflow(readFileSync(join(W, f), "utf8"), { file: f }).filter((v) => v.rule === "no-expression-in-run"), f).toEqual([]);
});

test("yml-lint rejects ${{ inputs.* }} / ${{ github.event.* }} inside a run: block (no-expression-in-run)", () => {
  // 한 줄짜리 run
  expect(lintWorkflow("  - run: node x.js ${{ inputs.issue }}\n")).toEqual([expect.objectContaining({ rule: "no-expression-in-run", line: 1 })]);
  expect(lintWorkflow("  - run: gh issue view ${{ github.event.issue.number }}\n")).toEqual([expect.objectContaining({ rule: "no-expression-in-run", line: 1 })]);
  // 블록 스칼라 — 본문 줄 번호를 가리킨다
  expect(lintWorkflow("  - name: x\n    run: |\n      echo ok\n      node x.js ${{ github.event.issue.number || inputs.issue }}\n"))
    .toEqual([expect.objectContaining({ rule: "no-expression-in-run", line: 4 })]);
  // 셸 주석 안이어도 치환은 셸보다 **먼저** 일어난다 — 벗기지 않는다
  expect(lintWorkflow("  - run: |\n      # ${{ inputs.issue }}\n      echo ok\n")).toEqual([expect.objectContaining({ rule: "no-expression-in-run", line: 2 })]);
  // env 바인딩 + `\"$ISSUE\"`는 깨끗하다
  expect(lintWorkflow('  - name: x\n    env:\n      ISSUE: ${{ github.event.issue.number || inputs.issue }}\n    run: |\n      [[ "$ISSUE" =~ ^[0-9]+$ ]] || exit 1\n      node x.js "$ISSUE"\n')).toEqual([]);
  // 공격자가 고를 수 없는 컨텍스트는 규칙 밖이다 — 넓히면 정당한 자리까지 잡아 규칙이 꺼진다
  expect(lintWorkflow("  - run: |\n      git checkout ${{ github.sha }} -- .factory\n      echo ${{ job.status }} ${{ github.run_id }} ${{ env.X }}\n")).toEqual([]);
  // `run:` 블록 **밖**(with:·concurrency:·if:)은 셸이 아니다 — 잡지 않는다
  expect(lintWorkflow("concurrency:\n  group: x-${{ github.event.issue.number || inputs.issue }}\n")).toEqual([]);
  expect(lintWorkflow("  - uses: actions/checkout@v4\n    with:\n      ref: ${{ github.event.pull_request.base.ref }}\n")).toEqual([]);
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
    expect(y, f).toContain(`node .factory/bin/run-stage.js ${stage} "$ISSUE" --aborted "\${{ job.status }}"`);
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
  expect(lintWorkflow(drifted)).toEqual([expect.objectContaining({ rule: "runner-id-consistent", msg: expect.stringContaining("DIFFERENT") })]);
  // 아예 빠져도 잡는다
  const missing = ok.slice(0, at) + ok.slice(at).replace("          FACTORY_RUNNER_ID: gha-${{ github.run_id }}\n", "");
  expect(lintWorkflow(missing)).toEqual([expect.objectContaining({ rule: "runner-id-consistent" })]);

  // r1 nit 11: 세 실패는 세 문장이다 — 스텝 이름이 다른 것을 "값이 어긋났다"고 말하면 읽는 사람을
  // 없는 문제로 보낸다(그 이름은 이 파일의 다른 규칙들도 함께 본다).
  const renamed = ok.replace("- name: Run stage", "- name: Run the stage");
  const both = lintWorkflow(renamed).filter((f) => f.rule === "runner-id-consistent");
  expect(both).toHaveLength(1);
  expect(both[0].msg).toMatch(/missing: "Run stage"/);
  expect(both[0].msg).not.toMatch(/DIFFERENT/);
  const noValue = lintWorkflow(missing).find((f) => f.rule === "runner-id-consistent");
  expect(noValue.msg).toMatch(/own `env:` block/);
});

// ADR-020 최종 리뷰 SF-1 — 업로드하는 모든 템플릿은 ① 업로드 **직전에** 스크럽 스텝을 돌리고,
// ② 보관을 7일로 적는다. `if: always()`인 이유는 업로드 스텝과 같다: 사후 조사가 가장 필요한 런은
// **실패한 런**이고, 크리덴셜은 그 런의 아티팩트에도 똑같이 들어 있다.
test("every uploading template scrubs credentials immediately before the upload, and keeps artifacts 7 days (SF-1)", () => {
  const uploading = [...Object.keys(STAGE), "factory-retro.yml"];
  for (const f of uploading) {
    const y = readFileSync(join(W, f), "utf8");
    const scrub = y.indexOf("      - name: Scrub credentials from the artifacts\n");
    const upload = y.indexOf("      - name: Upload ");
    expect(scrub, f).toBeGreaterThan(-1);
    expect(scrub, f).toBeLessThan(upload);                       // 업로드 **뒤**의 스크럽은 아무것도 지키지 않는다
    expect(y.slice(scrub, upload), f).toMatch(/\n {8}if: always\(\)\n/);
    // 네 시크릿은 **이 스텝의 env로만** 들어온다 — 값이 인자나 `echo`에 실리면 런 로그에 그대로 남는다
    for (const n of ["FACTORY_BOT_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) {
      expect(y.slice(scrub, upload), `${f} ${n}`).toContain(`          ${n}: \${{ secrets.${n} }}\n`);
    }
    expect(y.slice(scrub, upload), f).toContain("node .factory/bin/scrub-artifacts.js ");
    expect(y.slice(scrub, upload), f).not.toContain("echo $");
    // 스크럽이 훑는 경로는 업로드가 올리는 경로를 덮어야 한다(트랜스크립트는 merge에만 없다)
    expect(y.slice(scrub, upload), f).toContain(".factory/out");
    if (f !== "factory-merge.yml") expect(y.slice(scrub, upload), f).toContain('"${CLAUDE_TRANSCRIPTS:-$GITHUB_WORKSPACE/.factory/out}"');
    if (f !== "factory-retro.yml") expect(y.slice(scrub, upload), f).toContain("docs/factory/runs");
    expect(y, f).toContain("          retention-days: 7\n");
  }
  // 업로드가 없는 두 템플릿은 스크럽할 것도 없다 — 규칙이 자기 자리를 넘지 않는지 함께 못 박는다.
  for (const f of ["factory-sweeper.yml", "factory-integrity.yml"]) {
    const y = readFileSync(join(W, f), "utf8");
    expect(y, f).not.toContain("upload-artifact");
    expect(y, f).not.toContain("scrub-artifacts");
  }
});

test("sweeper and integrity workflows", () => {
  const s = readFileSync(join(W, "factory-sweeper.yml"), "utf8");
  expect(s).toContain("cron: '*/30 * * * *'"); expect(s).toContain("workflow_dispatch:"); expect(s).toContain("run: node .factory/bin/sweep.js");
  // r2 SF5 — 5분은 라벨 변경이 `gh` 한 번이던 시절의 예산이다. KTB-30의 재시도(스왑당 최대 ~39초)와
  // 여덟 팔의 라벨 뮤테이션을 합치면, 넓은 API 장애에서 복구 팔에 닿기 전에 잡이 잘렸다.
  expect(s).toContain("timeout-minutes: 15");
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

// ── 외부 감사 2026-09-14 M7 — merge-token-required-when-two-actor ────────────

/**
 * 감사가 짚은 한 줄: `GH_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN || secrets.FACTORY_BOT_TOKEN }}`.
 * 단일 배우 모드에는 그 폴백이 정답이지만, 두 배우 모드에서도 **똑같이 조용히** 작동한다 —
 * 환경이 적용되지 않으면 머지가 에이전트 배우의 토큰으로 나가고 ADR-021이 로그 없이 사라진다.
 */
test("merge-token-required-when-two-actor: the `|| FACTORY_BOT_TOKEN` fallback needs a guard step that fails the job when the mode says two-actor", () => {
  // 스테이지 규칙(KTB-24/26)까지 함께 발화하지 않도록 `run-stage.js <stage> "$ISSUE"` 줄은 넣지 않는다 —
  // 이 테스트가 묻는 것은 토큰 폴백 하나다.
  const fallback = [
    "  - name: Run stage",
    "    env:",
    "      GH_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN || secrets.FACTORY_BOT_TOKEN }}",
    "    run: echo merge",
    "",
  ].join("\n");
  expect(lintWorkflow(fallback, { file: "factory-merge.yml" }))
    .toEqual([expect.objectContaining({ rule: "merge-token-required-when-two-actor", line: 3 })]);

  // 가드 스텝이 있으면 폴백은 그대로 둔다 — 막는 것은 폴백이 아니라 **무성 강등**이다.
  const guarded = [
    "  - name: Require the merge token in two-actor mode",
    "    id: two-actor-token-guard",
    "    env:",
    "      TWO_ACTOR_DECLARED: ${{ vars.FACTORY_TWO_ACTOR }}",
    "      MERGE_TOKEN_PRESENT: ${{ secrets.FACTORY_MERGE_TOKEN != '' }}",
    "    run: |",
    "      if [[ \"$TWO_ACTOR_DECLARED\" == \"true\" && \"$MERGE_TOKEN_PRESENT\" != \"true\" ]]; then exit 1; fi",
    fallback,
  ].join("\n");
  expect(lintWorkflow(guarded, { file: "factory-merge.yml" })).toEqual([]);

  // 스텝 **이름**만 흉내 낸 것은 열쇠가 아니다 — `id:`가 열쇠다(merge-token-scope의 스크럽 예외와 같다).
  const nameOnly = ["  - name: two-actor-token-guard", "    run: echo hi", fallback].join("\n");
  expect(lintWorkflow(nameOnly, { file: "factory-merge.yml" }))
    .toEqual([expect.objectContaining({ rule: "merge-token-required-when-two-actor" })]);

  // 주석 안의 언급은 발화시키지 않는다 — 이 규칙을 설명하는 주석이 바로 그 파일 안에 있다.
  expect(lintWorkflow("      # GH_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN || secrets.FACTORY_BOT_TOKEN }}\n", { file: "factory-merge.yml" })).toEqual([]);
  // 폴백이 없으면 규칙은 침묵한다.
  expect(lintWorkflow("      GH_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN }}\n", { file: "factory-merge.yml" })).toEqual([]);
});

test("the factory-merge template carries the two-actor token guard as its FIRST step (audit M7)", () => {
  const y = readFileSync(join(W, "factory-merge.yml"), "utf8");
  expect(y).toContain("id: two-actor-token-guard");
  // 첫 스텝이어야 한다 — 체크아웃보다도, 어떤 토큰이 쓰이기도 전에 죽는다.
  expect(y.indexOf("id: two-actor-token-guard")).toBeLessThan(y.indexOf("uses: actions/checkout@v4"));
  expect(y).toContain("vars.FACTORY_TWO_ACTOR");
  // 감사 H1b — 머지 잡은 에이전트 배우의 **로그인 이름**을 해석해 상태 게시자 대조에 쓴다(토큰이 아니다).
  expect(y).toContain("FACTORY_BOT_LOGIN=$login");
});

// ── ADR-021 merge-token-scope ───────────────────────────────────────────────

test("merge-token-scope: FACTORY_MERGE_TOKEN in any workflow but factory-merge.yml is a violation", () => {
  const step = "  - name: x\n    env:\n      GH_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN }}\n";
  expect(lintWorkflow(step, { file: "factory-implement.yml" }))
    .toEqual([expect.objectContaining({ rule: "merge-token-scope", line: 3 })]);
  expect(lintWorkflow(step, { file: "factory-sweeper.yml" }))
    .toEqual([expect.objectContaining({ rule: "merge-token-scope" })]);
  // 머지 워크플로에서는 정상이다 — 거기가 유일한 자리다.
  expect(lintWorkflow(step, { file: "factory-merge.yml" })).toEqual([]);
  // 파일명 없이 부르면(스니펫) 파일 범위 갈래는 침묵한다 — lintWorkflow는 이름 없는 조각도 받는다.
  expect(lintWorkflow(step)).toEqual([]);
});

test("merge-token-scope: the merge token never shares a step with an agent token — that step is where `claude -p` runs", () => {
  const agentStep = [
    "  - name: Run stage",
    "    env:",
    "      GH_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN }}",
    "      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    "    run: |",
    "      claude -p ok",
    "",
  ].join("\n");
  // 파일명이 factory-merge.yml이어도(=파일 범위는 통과) 스텝 범위가 잡는다.
  expect(lintWorkflow(agentStep, { file: "factory-merge.yml" }))
    .toEqual([expect.objectContaining({ rule: "merge-token-scope", msg: expect.stringMatching(/same step as CLAUDE_CODE_OAUTH_TOKEN/) })]);
  expect(lintWorkflow(agentStep.replace("CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}", "ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}"), { file: "factory-merge.yml" }))
    .toEqual([expect.objectContaining({ rule: "merge-token-scope" })]);
  // 이름 없는 스니펫에서도 스텝 범위 갈래는 언제나 발화한다.
  expect(lintWorkflow(agentStep)).toEqual([expect.objectContaining({ rule: "merge-token-scope" })]);
  // 다른 스텝에 있으면 위반이 아니다 — 같은 파일이어도 자리가 다르다.
  const separate = [
    "  - name: Run stage",
    "    env:",
    "      GH_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN }}",
    "    run: node run-stage.js",
    "  - name: Agent",
    "    env:",
    "      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    "    run: claude -p ok",
    "",
  ].join("\n");
  expect(lintWorkflow(separate, { file: "factory-merge.yml" })).toEqual([]);
});

test("merge-token-scope: the credential-scrub step is the one exception — it holds every secret to redact it, and starts no agent", () => {
  const scrub = [
    "  - name: Scrub credentials from the artifacts",
    "    id: scrub-artifacts",
    "    env:",
    "      FACTORY_MERGE_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN }}",
    "      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    "    run: |",
    "      node .factory/bin/scrub-artifacts.js docs/factory/runs",
    "",
  ].join("\n");
  expect(lintWorkflow(scrub, { file: "factory-merge.yml" })).toEqual([]);
});

test("merge-token-scope: a comment naming the token is not an occurrence — the rule must not read its own rationale", () => {
  const commented = [
    "  - name: Agent",
    "    env:",
    "      # FACTORY_MERGE_TOKEN is deliberately absent here (ADR-021)",
    "      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    "    run: claude -p ok",
    "",
  ].join("\n");
  expect(lintWorkflow(commented, { file: "factory-implement.yml" })).toEqual([]);
});

test("merge-token-scope: the shipped templates obey it — only factory-merge.yml names the token, and never beside an agent token", () => {
  for (const f of files) {
    const y = readFileSync(join(W, f), "utf8");
    const names = y.split("\n").some((l) => l.replace(/#.*/, "").includes("FACTORY_MERGE_TOKEN"));
    expect(names, f).toBe(f === "factory-merge.yml");
    expect(lintWorkflow(y, { file: f }).filter((v) => v.rule === "merge-token-scope"), f).toEqual([]);
  }
  // 그리고 머지 템플릿은 값이 아니라 **불리언**으로 모드를 옮긴다(사본을 하나 더 만들지 않는다).
  const merge = readFileSync(join(W, "factory-merge.yml"), "utf8");
  expect(merge).toContain("FACTORY_TWO_ACTOR: ${{ secrets.FACTORY_MERGE_TOKEN != '' }}");
  expect(merge).toContain("GH_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN || secrets.FACTORY_BOT_TOKEN }}");
});


// ── ADR-021 fix round r1 finding 5 — the scrub exception has TWO keys ───────

test("merge-token-scope (r1 finding 5): the scrub exception needs BOTH `id: scrub-artifacts` and a `run:` that actually invokes the script", () => {
  const step = (lines) => ["  - name: Scrub", ...lines, ""].join("\n");
  const env = [
    "    env:",
    "      FACTORY_MERGE_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN }}",
    "      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
  ];
  const both = step(["    id: scrub-artifacts", ...env, "    run: node .factory/bin/scrub-artifacts.js out"]);
  expect(lintWorkflow(both, { file: "factory-merge.yml" })).toEqual([]);

  // id는 있는데 run이 스크럽을 부르지 않는다 — 선언만으로는 예외가 아니다.
  const idOnly = step(["    id: scrub-artifacts", ...env, "    run: claude -p go"]);
  expect(lintWorkflow(idOnly, { file: "factory-merge.yml" }).map((v) => v.rule)).toEqual(["merge-token-scope"]);

  // run은 스크럽을 부르는데 id가 없다 — 예전에는 이것만으로 통과였다.
  const runOnly = step([...env, "    run: node .factory/bin/scrub-artifacts.js out"]);
  expect(lintWorkflow(runOnly, { file: "factory-merge.yml" }).map((v) => v.rule)).toEqual(["merge-token-scope"]);
});

test("merge-token-scope (r1 finding 5): the old spoof — the script name in a step NAME or a COMMENT — no longer buys the exception", () => {
  const byName = [
    "  - name: run scrub-artifacts.js and also the agent",
    "    env:",
    "      FACTORY_MERGE_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN }}",
    "      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}",
    "    run: claude -p go",
    "",
  ].join("\n");
  expect(lintWorkflow(byName, { file: "factory-merge.yml" }).map((v) => v.rule)).toEqual(["merge-token-scope"]);

  const byComment = [
    "  - name: Agent",
    "    # this step is NOT .factory/bin/scrub-artifacts.js, whatever this comment says",
    "    env:",
    "      FACTORY_MERGE_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN }}",
    "      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}",
    "    run: claude -p go",
    "",
  ].join("\n");
  expect(lintWorkflow(byComment, { file: "factory-merge.yml" }).map((v) => v.rule)).toEqual(["merge-token-scope"]);
});

// ── KTB-34 own-calendar — rule scope split: factory-shaped rules vs repo-wide merge-token-scope ────

test("isFactoryWorkflowFile: factory-*.yml is owned; other names — including this repo's own publish.yml — are not", () => {
  expect(isFactoryWorkflowFile("factory-merge.yml")).toBe(true);
  expect(isFactoryWorkflowFile("factory-retro.yml")).toBe(true);   // not in doctor's WORKFLOWS list, but still factory-owned by prefix
  expect(isFactoryWorkflowFile("publish.yml")).toBe(false);
  expect(isFactoryWorkflowFile("build.yml")).toBe(false);
  expect(isFactoryWorkflowFile(null)).toBe(false);
});

test("KTB-34: a non-factory workflow (an adopter's own build.yml) is not held to factory-shaped rules", () => {
  const build = [
    "on:",
    "  push:",
    "jobs:",
    "  build:",
    "    steps:",
    "      - run: echo ${{ github.event.head_commit.message }}",     // would trip no-expression-in-run if scoped as factory
    "      - uses: actions/upload-artifact@v4",
    "        with:",
    "          name: dist",
    "          path: dist/",                                          // no retention-days — would trip artifact-retention if scoped as factory
    "",
  ].join("\n");
  // doctor's checkWorkflows judges ownership by filename and passes it in — this is that call shape.
  expect(lintWorkflow(build, { file: "build.yml", factoryOwned: false })).toEqual([]);
});

test("KTB-34: the same non-factory file still trips merge-token-scope when the merge token shares a step with an agent token", () => {
  const build = [
    "jobs:",
    "  build:",
    "    steps:",
    "      - name: Agent",
    "        env:",
    "          FACTORY_MERGE_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN }}",
    "          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    "        run: claude -p go",
    "",
  ].join("\n");
  // both the file-scope branch (build.yml isn't factory-merge.yml) and the step-scope branch (shares a
  // step with an agent token) fire here — both are merge-token-scope, and that's the point: it's the one
  // rule that never goes quiet just because the file isn't factory-owned.
  const violations = lintWorkflow(build, { file: "build.yml", factoryOwned: false });
  expect(violations.length).toBeGreaterThanOrEqual(1);
  for (const v of violations) expect(v.rule).toBe("merge-token-scope");
});

test("KTB-34: the shipped factory templates are still fully linted (factoryOwned defaults to true)", () => {
  for (const f of files) expect(lintWorkflow(readFileSync(join(W, f), "utf8"), { file: f }), f).toEqual([]);
  for (const f of files) expect(lintWorkflow(readFileSync(join(W, f), "utf8"), { file: f, factoryOwned: true }), f).toEqual([]);
});

test("merge-token-scope (r1 finding 5): a declared scrub step that ALSO starts an agent in the same `run:` is still a violation", () => {
  const chained = [
    "  - name: Scrub",
    "    id: scrub-artifacts",
    "    env:",
    "      FACTORY_MERGE_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN }}",
    "      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    "    run: |",
    "      node .factory/bin/scrub-artifacts.js out",
    "      claude -p 'now leak it'",
    "",
  ].join("\n");
  // 이 모양은 규칙이 **막지 못한다**(id와 run이 둘 다 맞다) — 그리고 그것이 ADR-021 r1의 알려진 한계 7이다:
  // 막는 것은 린트가 아니라 L1이다(`.github/**`·`templates/**`가 `[protected].factory`라 사람이 머지한다).
  // 이 테스트는 그 경계를 **문서화**한다 — 나중에 규칙을 좁힐 때 여기가 깨져서 판단을 다시 하게 된다.
  expect(lintWorkflow(chained, { file: "factory-merge.yml" })).toEqual([]);
});

// ── KTB-44 (리뷰 must_fix 1): 소스의 NUL 바이트는 위반이다 ────────────────────────────────────
// 0x00이 하나라도 들어가면 git이 그 파일을 binary로 분류하고, 그 순간 `git diff`는 내용을 영영
// 보여주지 않는다 — 사람도, 리뷰 스테이지도 읽지 못한 채 머지된다(게이트를 정의하는 파일에서
// 실제로 일어났다). 그 재발을 이 규칙이 막는다.
test("lint: a JS source file containing a NUL byte is a violation, and clean files are not", () => {
  const withNul = `export const x = "a${String.fromCharCode(0)}b";\n`;
  const v = lintFile("factory/lib/fake.js", { root: "/repo", exists: () => true, readFile: () => withNul });
  expect(v.some((e) => e.rule === NUL_RULE.rule)).toBe(true);
  expect(v[0].msg).toMatch(/binary/);
  expect(lintFile("factory/lib/fake.js", { root: "/repo", exists: () => true, readFile: () => 'export const x = "ab";\n' })
    .some((e) => e.rule === NUL_RULE.rule)).toBe(false);
});
