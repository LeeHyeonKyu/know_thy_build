/** ADR-009 규칙을 텍스트 수준에서 검사한다. YAML 파서 없이 — 의존성 추가 금지. */
export function lintWorkflow(text) {
  const out = [];
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    // 1) flow mapping 안의 ${{ }}: 같은 줄에서 여는 '{' (단, '${{'의 일부가 아님) 뒤에 '${{'가 온다
    const stripped = l.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    if (/(^|[^$])\{[^}\n]*\$\{\{/.test(stripped)) out.push({ line: i + 1, rule: "flow-interpolation", msg: "${{ }} inside a flow mapping breaks the workflow file — use a block mapping" });
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
      if (/^\s*(?:-\s*)?(?:path:\s*)?~\//.test(b.replace(/#.*/, ""))) {
        out.push({ line: i + 2 + k, rule: "tilde-path", msg: "upload-artifact does not expand `~` — export $HOME via $GITHUB_ENV and use ${{ env.… }}" });
      }
    });
  }
  return out;
}

export function lintLoggingHook(text) {
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  return last === "exit 0" ? [] : [{ line: text.split("\n").length, rule: "exit0", msg: "logging hooks must end with `exit 0`" }];
}
