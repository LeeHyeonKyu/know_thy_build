import { matchesAny } from "./glob.js";

const SKIP_PRAGMAS = [/\.skip\s*\(/, /\bxit\s*\(/, /\bxdescribe\s*\(/, /@pytest\.mark\.skip/, /istanbul ignore/, /pragma:\s*no cover/, /Stryker disable/];

/**
 * readFileAt (base content) is accepted for interface symmetry but currently unused:
 * the additive-only position check only reads the CURRENT file (readFile) — it asks
 * "which section did this added line land in", not "what changed relative to base".
 */
export async function integrityCheck({ run, cwd, base, head = "HEAD", harness, readFile, readFileAt = () => "" }) {
  // 무결성은 "검사했더니 깨끗하다"는 주장이다. diff를 얻지 못했는데 violations가 비었다고 ok:true를
  // 돌려주면 "검사하지 못했음"이 "통과"로 둔갑한다 — base가 비었거나 git이 실패하면 fail-closed다.
  if (!base) return cannotCompute("base is empty (merge-base not resolved)");
  const ns = await run("git", ["diff", "--name-status", `${base}...${head}`], { cwd });
  if (ns.code !== 0) return cannotCompute(gitReason("git diff --name-status", ns));
  const violations = [];
  const files = ns.stdout.split("\n").filter(Boolean).map((l) => l.split("\t").pop());
  const u0r = await run("git", ["diff", "-U0", `${base}...${head}`], { cwd });
  if (u0r.code !== 0) return cannotCompute(gitReason("git diff -U0", u0r));
  const u0 = u0r.stdout;
  const addedByFile = addedLines(u0), removedByFile = removedLines(u0);
  const prot = harness.protected || {};
  for (const f of files) {
    const additive = Object.keys(prot.additive_only || {}).find((g) => matchesAny([g], f));
    if (additive) {
      const allowed = prot.additive_only[additive];
      const removed = removedByFile.get(f) || [];
      const added = addedByFile.get(f) || [];
      // An added '## ' header can never define a section boundary for itself or for other
      // added lines — otherwise a diff could inject "+malicious\n+## Examples" and have the
      // injected header retroactively "legitimize" the disallowed content that precedes it.
      const addedLineNos = new Set(added.map((l) => l.line));
      const headerAdded = added.some((l) => /^##\s/.test(l.text));
      const lines = (readFile(`${cwd}/${f}`) || "").split("\n");
      const outside = added.some((l) => !allowed.includes(sectionAt(lines, l.line, addedLineNos)));
      if (removed.length || outside) violations.push({ file: f, rule: `additive-only sections (${allowed.join(", ")}) — removals or edits outside allowed sections` });
      if (headerAdded) violations.push({ file: f, rule: "additive-only: header added" });
      continue;
    }
    if (matchesAny(prot.factory || [], f) && !matchesAny(prot.except || [], f)) violations.push({ file: f, rule: "protected path changed" });
    if (f.startsWith(".factory/lessons/")) violations.push(...lessonsFormat(f, readFile(`${cwd}/${f}`) || ""));
    if (matchesAny(harness.test?.test_glob || [], f)) {
      if ((addedByFile.get(f) || []).some((l) => SKIP_PRAGMAS.some((re) => re.test(l.text)))) violations.push({ file: f, rule: "test skip/ignore pragma added" });
    }
  }
  return { ok: violations.length === 0, violations, checked: { files } };
}

/** 판정 불가 — ok:false에 이유를 한 줄로 싣는다(file은 "-": 특정 파일의 위반이 아니다). */
const cannotCompute = (reason) => ({ ok: false, violations: [{ file: "-", rule: `integrity could not be computed: ${reason}` }], checked: { files: [] } });
const gitReason = (what, r) => `${what} exited ${r.code}${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ""}`;

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** 파일 귀속: "+++ b/X" → X, 삭제 diff의 "+++ /dev/null"은 직전 "--- a/X"의 X로 귀속시킨다 */
function fileFor(line, current, pendingOld) {
  if (line.startsWith("+++ b/")) return line.slice(6);
  if (line.startsWith("+++ /dev/null")) return pendingOld;
  return current;
}
/** git diff -U0 파싱: "+" 줄마다 신규 파일 기준 줄 번호(line, 1-indexed)를 함께 기록한다 */
function addedLines(u0) {
  const m = new Map(); let file = null, pendingOld = null, newLine = 0;
  for (const line of u0.split("\n")) {
    if (line.startsWith("--- ")) { pendingOld = line.startsWith("--- a/") ? line.slice(6) : null; continue; }
    if (line.startsWith("+++ ")) { file = fileFor(line, file, pendingOld); continue; }
    const h = HUNK_HEADER.exec(line);
    if (h) { newLine = Number(h[1]); continue; }
    if (file && line.startsWith("+") && !line.startsWith("+++")) {
      if (!m.has(file)) m.set(file, []);
      m.get(file).push({ text: line.slice(1), line: newLine });
      newLine++;
    }
  }
  return m;
}
/** 삭제된 줄은 위치를 안 따진다(있으면 위반) — 삭제 전용 diff도 옛 파일명으로 귀속시킨다 */
function removedLines(u0) {
  const m = new Map(); let file = null, pendingOld = null;
  for (const line of u0.split("\n")) {
    if (line.startsWith("--- ")) { pendingOld = line.startsWith("--- a/") ? line.slice(6) : null; continue; }
    if (line.startsWith("+++ ")) { file = fileFor(line, file, pendingOld); continue; }
    if (file && line.startsWith("-") && !line.startsWith("---")) { if (!m.has(file)) m.set(file, []); m.get(file).push({ text: line.slice(1) }); }
  }
  return m;
}
/**
 * 현재 파일(lines, 1-indexed lineNo 기준)에서 lineNo가 속한 가장 가까운 '## ' 헤더.
 * addedLineNos에 속한 헤더 줄(이번 diff가 새로 추가한 헤더)은 경계로 인정하지 않는다 —
 * 오직 base에 이미 있던(추가되지 않은) 헤더만 섹션을 정의한다.
 */
function sectionAt(lines, lineNo, addedLineNos = new Set()) {
  let current = null;
  for (let i = 0; i < lineNo && i < lines.length; i++) {
    if (/^## /.test(lines[i]) && !addedLineNos.has(i + 1)) current = lines[i].trim();
  }
  return current;
}
export function lessonsFormat(file, text) {
  const v = [];
  const head = /<!--\s*factory-lessons:v1\s+role=([\w-]+)\s+max=(\d+)\s*-->/.exec(text);
  if (!head) return [{ file, rule: "lessons header missing" }];
  const lines = text.split("\n");
  const entryIdx = [];
  lines.forEach((l, i) => { if (/^- /.test(l)) entryIdx.push(i); });
  const entries = entryIdx.map((i) => lines[i]);
  for (const e of entries) if (!/^- \[L-\d{4}-\d{2}-\d{2}-\d{2}\]/.test(e)) v.push({ file, rule: `lessons entry malformed: ${e.slice(0, 40)}` });
  if (entries.length > Number(head[2])) v.push({ file, rule: `lessons over max ${head[2]}` });
  // 항목별 근거: 블록 = "- [L-...]" 줄부터 다음 "- [L-...]" 줄 직전(또는 EOF)까지
  const idIdx = entryIdx.filter((i) => /^- \[L-\d{4}-\d{2}-\d{2}-\d{2}\]/.test(lines[i]));
  idIdx.forEach((start, k) => {
    const end = k + 1 < idIdx.length ? idIdx[k + 1] : lines.length;
    const block = lines.slice(start, end).join("\n");
    if (!/근거:/.test(block)) {
      const id = /^- (\[L-\d{4}-\d{2}-\d{2}-\d{2}\])/.exec(lines[start])?.[1] || lines[start].slice(0, 40);
      v.push({ file, rule: `lessons entry missing 근거: ${id}` });
    }
  });
  return v;
}
