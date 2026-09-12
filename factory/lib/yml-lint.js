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
