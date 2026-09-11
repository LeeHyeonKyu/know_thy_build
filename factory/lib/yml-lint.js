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
  }
  return out;
}

export function lintLoggingHook(text) {
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  return last === "exit 0" ? [] : [{ line: text.split("\n").length, rule: "exit0", msg: "logging hooks must end with `exit 0`" }];
}
