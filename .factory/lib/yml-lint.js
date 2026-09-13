/** ADR-009 규칙을 텍스트 수준에서 검사한다. YAML 파서 없이 — 의존성 추가 금지. */
export function lintWorkflow(text) {
  const out = [];
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    // 1) flow mapping 안의 ${{ }}: 같은 줄에서 여는 '{' (단, '${{'의 일부가 아님) 뒤에 '${{'가 온다
    const stripped = l.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    if (/(^|[^$])\{[^}\n]*\$\{\{/.test(stripped)) out.push({ line: i + 1, rule: "flow-interpolation", msg: "${{ }} inside a flow mapping breaks the workflow file — use a block mapping" });
    // 1b) `ready_for_review`는 어떤 factory 워크플로의 트리거에도 있으면 안 된다(KTB-15b I1) —
    // merge-stage가 머지 직전 draft PR을 ready로 뒤집으면(`gh pr ready`, KTB-15) 그 자체가
    // `ready_for_review` 이벤트를 만든다. 그 이벤트를 듣는 워크플로(예: factory-integrity)가 diff는
    // 그대로인데 새 필수 체크 런을 또 시작하고, 그 런이 끝나기 전에 `gh pr merge`가 먼저 불려
    // required-checks 판정이 흔들릴 수 있다(레이스). 주석에서의 언급은 괜찮다 — 실제 트리거 목록에
    // 있는 토큰만 본다.
    if (/\bready_for_review\b/.test(l.replace(/#.*/, ""))) {
      out.push({ line: i + 1, rule: "ready-for-review-trigger", msg: "pull_request types must not include ready_for_review — the merge stage's own draft→ready flip (KTB-15) would retrigger this workflow and race `gh pr merge`" });
    }
  });
  // 2) upload-artifact 스텝: 스텝 블록(다음 '- '까지) 안에 dot-경로가 있으면 include-hidden-files: true 필수
  for (let i = 0; i < lines.length; i++) {
    if (!/uses:\s*actions\/upload-artifact@/.test(lines[i])) continue;
    const indent = lines[i].search(/\S/);
    let j = i + 1; const block = [];
    while (j < lines.length && (lines[j].trim() === "" || lines[j].search(/\S/) > indent || (lines[j].search(/\S/) === indent && !lines[j].trim().startsWith("- ")))) {
      if (lines[j].search(/\S/) === indent && lines[j].trim().startsWith("- ")) break;
      block.push(lines[j]); j++;
    }
    const hidden = block.some((b) => /(^|\s|\|)\.[\w-]+\//.test(b.replace(/#.*/, "")) && !/include-hidden-files/.test(b));
    const has = block.some((b) => /include-hidden-files:\s*true/.test(b));
    if (hidden && !has) out.push({ line: i + 1, rule: "hidden-artifact", msg: "upload-artifact with a dot-directory path needs include-hidden-files: true" });
    // 3) `~`는 **셸 확장**이지 glob이 아니다. upload-artifact는 경로를 셸에 넘기지 않고 그대로 glob으로
    // 쓰므로 `~/.claude/projects/**/*.jsonl`은 아무것도 맞히지 못한다 — `if-no-files-found: ignore`까지
    // 붙어 있으면 **실패조차 하지 않고** 빈 아티팩트가 올라간다(KTB-7 재리뷰: 트랜스크립트가 산출물
    // 추출의 1순위 출처인데 몇 회차째 비어 있었다). $HOME은 선행 스텝에서 GITHUB_ENV로 넘긴다.
    block.forEach((b, k) => {
      // 인용부호는 벗기고 본다 — `path: "~/x"`도 같은 버그다(YAML이 따옴표를 떼고 나면 남는 건 `~/x`이고,
      // upload-artifact는 그것을 셸이 아니라 glob으로 쓴다). 따옴표 하나로 규칙을 비켜 갈 수 있으면 규칙이 아니다.
      const bare = unquotePathValue(b.replace(/#.*/, ""));
      if (/^\s*(?:-\s*)?(?:path:\s*)?~\//.test(bare)) {
        out.push({ line: i + 2 + k, rule: "tilde-path", msg: "upload-artifact does not expand `~` — export $HOME via $GITHUB_ENV and use ${{ env.… }}" });
      }
      // 4) `${{ env.X }}`로 시작하는 경로에 `||` 폴백이 없으면, 그 env를 세우는 스텝이 실패했을 때
      // 경로가 `/**/*.jsonl`로 — 곧 **루트 앵커 glob**으로 — 접힌다. 업로드 스텝은 `if: always()`라
      // 그때도 돌고, `if-no-files-found: ignore`라 조용하다: 러너 파일시스템 전체를 훑는 일이
      // 아무 경고 없이 일어난다(KTB-10 I1). 폴백은 반드시 워크스페이스 안을 가리켜야 한다.
      if (/^\s*(?:-\s*)?(?:path:\s*)?\$\{\{\s*env\./.test(bare) && !/\|\|/.test(bare)) {
        out.push({ line: i + 2 + k, rule: "env-path-no-fallback", msg: "an artifact path starting with ${{ env.… }} needs a `||` fallback — an unset env collapses it to a root-anchored glob" });
      }
    });
  }
  const stage = STAGE_RUN.exec(text);
  if (stage) out.push(...lintStageWorkflow(text, lines, stage[1]));
  return out;
}

/**
 * ADR-020 KTB-24/KTB-26 — 스테이지 워크플로에만 거는 세 규칙. "이 텍스트가 스테이지 워크플로다"의
 * 표식은 `run-stage.js <stage> <issue>`를 **정리 플래그 없이** 실행하는 줄 하나다: 그래야 설정 조각·
 * composite action·정리 스텝만 있는 스니펫이 규칙에 걸리지 않는다(`lintWorkflow`는 파일 이름을 받지 않는다).
 */
const STAGE_RUN = /run:\s*node \.factory\/bin\/run-stage\.js\s+(triage|plan|implement|review|merge)\b(?![^\n]*--aborted)/;

/**
 * KTB-24 — review·implement의 `timeout-minutes` 하한. 데모 #15의 review는 4역할 × +709줄 PR을
 * 45분 안에 못 끝내고 **한도에 걸려** 잘렸다(45 m 19 s, 취소로 기록돼 사람의 `gh run cancel`과
 * 로그상 구분되지 않았다). 이 둘은 에이전트가 실제로 코드를 읽고 쓰는 유일한 스테이지라, 상한이
 * 짧으면 "작업이 실패했다"가 아니라 **"작업이 끝나기 전에 잘렸다"**가 반복된다 — 그 런의 비용은
 * 전액 매몰되고 재실행은 같은 크기의 일을 같은 한도로 다시 한다. 값은 상수다(하네스 설정이 아니다):
 * 워크플로 파일은 `factory init`이 **그대로** 설치하는 템플릿이라 설치 시점의 치환 지점이 없고,
 * 치환을 도입하면 `--upgrade`가 프로젝트가 손으로 올린 값을 매번 되돌린다.
 */
const TIMEOUT_FLOOR = { review: 60, implement: 60 };

/**
 * 정리 스텝의 `if:` (ADR-020 KTB-24 fix). 공백은 넉넉히 받되 세 토큰(`always()`, `job.status`,
 * `success`)은 모두 있어야 한다 — 따옴표는 `'`·`"` 둘 다 허용한다(YAML에서 둘 다 유효하다).
 * **줄 앞에 `#`가 없어야 한다**: 이 규칙이 요구하는 문자열을 설명하는 주석이 바로 그 위에 있고,
 * 주석까지 세면 실제 `if:`를 예전 모양으로 되돌려도 린트가 통과한다(규칙이 자기 설명문을 읽는다).
 */
const ABORTED_IF = /^[^#\n]*\bif:\s*always\(\)\s*&&\s*job\.status\s*!=\s*['"]success['"]/m;

function lintStageWorkflow(text, lines, stage) {
  const out = [];
  const floor = TIMEOUT_FLOOR[stage];
  if (floor != null) {
    const i = lines.findIndex((l) => /^\s*timeout-minutes:\s*\d+\s*$/.test(l));
    const minutes = i === -1 ? null : Number(/(\d+)/.exec(lines[i])[1]);
    if (minutes == null || minutes < floor) {
      out.push({ line: i + 1 || 1, rule: "stage-timeout-floor", msg: `the ${stage} stage needs timeout-minutes ≥ ${floor} — a shorter cap cancels the job mid-work and the whole run's cost is sunk (KTB-24)` });
    }
  }
  // 스텝 목록에는 `- name:`뿐 아니라 **이름 없는 `- uses:` 스텝**도 센다(KTB-24 fix). `sweep-step-last`는
  // "Sweep이 마지막 스텝인가"를 묻는데, 이름 없는 스텝을 못 보면 `Sweep` 뒤에 붙은 `- uses: …` 한 줄이
  // 규칙을 소리 없이 빠져나간다 — 그 스텝이 실패하면 방금 sweep이 훑은 상태가 다시 흔들린다.
  const steps = [];
  lines.forEach((l, i) => {
    const m = /^\s*-\s+(name|uses):\s*(.+?)\s*$/.exec(l);
    if (m) steps.push({ name: m[1] === "name" ? m[2] : `uses:${m[2]}`, line: i + 1 });
  });
  const aborted = steps.findIndex((s) => s.name === "Aborted cleanup");
  const sweep = steps.findIndex((s) => s.name === "Sweep");
  // (1) 취소·실패 정리 스텝이 있고, 그 스텝이 실제로 `--aborted`를 이 스테이지 이름으로 부른다.
  // 조건은 `always() && job.status != 'success'`여야 한다(KTB-24 fix): `cancelled() || failure()`는
  // "런이 취소됐다"와 "앞 스텝이 실패했다"만 덮어서, 잡 타임아웃·러너 소실처럼 그 어느 쪽으로도
  // 분류되지 않는 끝맺음에서 정리가 통째로 건너뛰어진다.
  if (aborted === -1 || !new RegExp(`run-stage\\.js ${stage} [^\\n]*--aborted`).test(text) || !ABORTED_IF.test(text)) {
    out.push({ line: aborted === -1 ? 1 : steps[aborted].line, rule: "aborted-cleanup-step", msg: `a stage workflow needs an "Aborted cleanup" step with \`if: always() && job.status != 'success'\` running \`run-stage.js ${stage} <issue> --aborted\` — a job that ends any way but success never reaches run-stage's finally, so the lock is orphaned and nothing is recorded (KTB-24)` });
  }
  // (2) 마지막 스텝은 `Sweep`이고 `--quick`으로 돈다 — 정리보다 **뒤**여야 방금 세운 blocked까지 훑는다.
  if (sweep === -1 || sweep !== steps.length - 1 || !/node \.factory\/bin\/sweep\.js --quick/.test(text) || !/- name: Sweep\n\s+if: always\(\)/.test(text)) {
    out.push({ line: sweep === -1 ? lines.length : steps[sweep].line, rule: "sweep-step-last", msg: "a stage workflow must end with a `Sweep` step (`if: always()`, `sweep.js --quick`) — the cron sweeper alone is not reliable enough (KTB-26)" });
  } else if (aborted !== -1 && aborted > sweep) {
    out.push({ line: steps[sweep].line, rule: "sweep-step-last", msg: "the Sweep step must come after the Aborted cleanup step — sweeping before the cleanup cannot see the blocked label it is meant to pick up (KTB-26)" });
  }
  // (3) `Run stage`와 `Aborted cleanup`은 **같은** FACTORY_RUNNER_ID 식을 실어야 한다(r1 재리뷰 M5).
  // KTB-24 fix 이후 정리 스텝은 락 커밋 제목의 `runner=`와 자기 `FACTORY_RUNNER_ID`를 비교해 "내 락인가"를
  // 가른다. 둘이 갈리면 정리가 자기 런의 락을 남의 것으로 읽고 그대로 두고 나간다 — 고아 락이 남고,
  // 그 뒤의 모든 dispatch가 claim에서 죽는다(데모 #15). 값이 무엇인지는 묻지 않는다(러너마다 다를 수
  // 있다) — **같은가**만 묻는다.
  const runStage = steps.findIndex((s) => s.name === "Run stage");
  const runnerIdOf = (i) => {
    if (i === -1) return null;
    const end = i + 1 < steps.length ? steps[i + 1].line - 1 : lines.length;
    for (let k = steps[i].line - 1; k < end; k++) {
      // YAML의 줄 끝 주석은 **공백 뒤의** `#`다 — 값 안의 `#`(`gha-#1`)를 주석으로 읽어 자르지 않는다.
      const m = /^\s*FACTORY_RUNNER_ID:\s*(.+?)\s*$/.exec(lines[k].replace(/\s+#.*$/, ""));
      if (m) return m[1];
    }
    return null;
  };
  const runId = runnerIdOf(runStage);
  const abortId = runnerIdOf(aborted);
  // r1 nit 11: 세 가지 실패를 **세 문장**으로 가른다. 예전에는 스텝 이름이 `Run stage`가 아닐 때도
  // "FACTORY_RUNNER_ID가 어긋났다"고 말해서, 읽는 사람을 없는 문제로 보냈다.
  const missingStep = [runStage === -1 ? '"Run stage"' : null, aborted === -1 ? '"Aborted cleanup"' : null].filter(Boolean);
  const noValue = [runId == null && runStage !== -1 ? '"Run stage"' : null, abortId == null && aborted !== -1 ? '"Aborted cleanup"' : null].filter(Boolean);
  const at = aborted === -1 ? 1 : steps[aborted].line;
  if (missingStep.length) {
    out.push({ line: at, rule: "runner-id-consistent", msg: `a stage workflow needs both a "Run stage" and an "Aborted cleanup" step, named exactly that — missing: ${missingStep.join(", ")}. The cleanup tells its own lock from someone else's by comparing FACTORY_RUNNER_ID with the lock's \`runner=\` field, and this rule reads that value per step (KTB-24 fix / KTB-28)` });
  } else if (noValue.length) {
    out.push({ line: at, rule: "runner-id-consistent", msg: `FACTORY_RUNNER_ID is not set in the step's own \`env:\` block on: ${noValue.join(", ")} — a job-level \`env:\` is not read by this rule, so set it on both steps. Without it the cleanup cannot prove the lock is its own and leaves it alone, and the orphan lock stalls every later dispatch (KTB-24 fix / KTB-28)` });
  } else if (runId !== abortId) {
    out.push({ line: at, rule: "runner-id-consistent", msg: `the "Run stage" and "Aborted cleanup" steps set DIFFERENT FACTORY_RUNNER_ID expressions (${runId} vs ${abortId}) — the cleanup compares it against the lock's \`runner=\` field, so a drifted value makes every run read its own lock as a stranger's (KTB-24 fix / KTB-28)` });
  }
  return out;
}

/**
 * `path: "~/x"` / `- '${{ env.X }}/**'` 처럼 값만 따옴표로 감싼 줄에서 따옴표를 벗긴다.
 * 들여쓰기와 `- `·`path:` 접두는 그대로 둔다 — 위 정규식들이 그것으로 줄 모양을 가른다.
 */
function unquotePathValue(line) {
  return line.replace(/^(\s*(?:-\s*)?(?:path:\s*)?)(['"])(.*)\2\s*$/, "$1$3");
}

export function lintLoggingHook(text) {
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  return last === "exit 0" ? [] : [{ line: text.split("\n").length, rule: "exit0", msg: "logging hooks must end with `exit 0`" }];
}
