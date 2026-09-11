import { matchesAny } from "./glob.js";
import { changedLines } from "./changed-files.js";

const SKIP_PRAGMAS = [/\.skip\s*\(/, /\bxit\s*\(/, /\bxdescribe\s*\(/, /@pytest\.mark\.skip/, /istanbul ignore/, /pragma:\s*no cover/, /Stryker disable/];

export async function integrityCheck({ run, cwd, base, head = "HEAD", harness, readFile, readFileAt = () => "" }) {
  const violations = [];
  const ns = await run("git", ["diff", "--name-status", `${base}...${head}`], { cwd });
  const files = ns.stdout.split("\n").filter(Boolean).map((l) => l.split("\t").pop());
  const u0 = (await run("git", ["diff", "-U0", `${base}...${head}`], { cwd })).stdout;
  const addedByFile = addedLines(u0), removedByFile = removedLines(u0);
  const prot = harness.protected || {};
  for (const f of files) {
    const additive = Object.keys(prot.additive_only || {}).find((g) => matchesAny([g], f));
    if (additive) {
      const allowed = prot.additive_only[additive];
      const removed = removedByFile.get(f) || [];
      const outside = (addedByFile.get(f) || []).filter((l) => !inAllowedSection(readFile(`${cwd}/${f}`), allowed, l.text));
      if (removed.length || outside.length) violations.push({ file: f, rule: `additive-only sections (${allowed.join(", ")}) — removals or edits outside allowed sections` });
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

function addedLines(u0) { return collect(u0, "+"); }
function removedLines(u0) { return collect(u0, "-"); }
function collect(u0, sign) {
  const m = new Map(); let file = null;
  for (const line of u0.split("\n")) {
    if (line.startsWith("+++ ")) { file = line.startsWith("+++ b/") ? line.slice(6) : file; continue; }
    if (line.startsWith("--- ")) continue;
    if (file && line.startsWith(sign) && !line.startsWith(sign + sign + sign)) { if (!m.has(file)) m.set(file, []); m.get(file).push({ text: line.slice(1) }); }
  }
  return m;
}
/** 파일 전체 텍스트에서 해당 줄 텍스트가 허용 섹션(## 헤더 ~ 다음 ## 헤더) 안에 있는가 */
function inAllowedSection(fullText, allowedHeaders, lineText) {
  let current = null;
  for (const l of (fullText || "").split("\n")) {
    if (/^## /.test(l)) current = l.trim();
    if (l === lineText && current && allowedHeaders.includes(current)) return true;
  }
  return false;
}
function lessonsFormat(file, text) {
  const v = [];
  const head = /<!--\s*factory-lessons:v1\s+role=([\w-]+)\s+max=(\d+)\s*-->/.exec(text);
  if (!head) return [{ file, rule: "lessons header missing" }];
  const entries = text.split("\n").filter((l) => /^- /.test(l));
  for (const e of entries) if (!/^- \[L-\d{4}-\d{2}-\d{2}-\d{2}\]/.test(e)) v.push({ file, rule: `lessons entry malformed: ${e.slice(0, 40)}` });
  if (entries.length > Number(head[2])) v.push({ file, rule: `lessons over max ${head[2]}` });
  if (!/근거:/.test(text) && entries.length) v.push({ file, rule: "lessons entries need 근거:" });
  return v;
}
