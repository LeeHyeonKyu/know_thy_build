import { matchesAny } from "./glob.js";

const SKIP_PRAGMAS = [/\.skip\s*\(/, /\bxit\s*\(/, /\bxdescribe\s*\(/, /@pytest\.mark\.skip/, /istanbul ignore/, /pragma:\s*no cover/, /Stryker disable/];

/**
 * readFileAt (base content) is accepted for interface symmetry but currently unused:
 * the additive-only position check only reads the CURRENT file (readFile) — it asks
 * "which section did this added line land in", not "what changed relative to base".
 *
 * **KTB-5 — 두 관심사는 나뉜다.** `ok`는 **변조**(tamper)만 본다: additive-only 위반, 헤더 추가,
 * lessons 포맷, 테스트 skip/ignore pragma, 그리고 "판정 불가". 보호 경로(`[protected].factory`)
 * 변경은 위반이 아니라 **사실 보고**다 — `protected` 배열에 실릴 뿐 `ok`를 내리지 않는다.
 * 이유: `factory/integrity`는 branch protection의 **유일한** required context다(ADR-015 보강).
 * 보호 경로 변경으로 이 체크가 RED가 되면 `enforce_admins` 아래에서 **사람도** 머지할 수 없고,
 * 그러면 설계가 전제하는 사람 머지 경로(retro-proposal PR, `factory:harness` 승격 PR, 인프라
 * 업그레이드 PR)가 통째로 막힌다. "보호 경로는 사람이 머지한다"는 판단은 자동 머지 직전의 L1
 * (`lib/merge-stage.js`)이 `protectedPaths()`로 내린다 — 사람을 막지 않고 봇만 막는 자리다.
 */
export async function integrityCheck({ run, cwd, base, head = "HEAD", harness, readFile, readFileAt = () => "" }) {
  // 무결성은 "검사했더니 깨끗하다"는 주장이다. diff를 얻지 못했는데 violations가 비었다고 ok:true를
  // 돌려주면 "검사하지 못했음"이 "통과"로 둔갑한다 — base가 비었거나 git이 실패하면 fail-closed다.
  if (!base) return cannotCompute("base is empty (merge-base not resolved)");
  const ns = await run("git", NAME_STATUS(base, head), { cwd });
  if (ns.code !== 0) return cannotCompute(gitReason("git diff --name-status", ns));
  const violations = [];
  const files = [...new Set(changedFiles(ns.stdout))];          // rename 줄은 경로를 둘 내놓는다 — 같은 파일을 두 번 판정하지 않는다
  const u0r = await run("git", ["diff", "-U0", `${base}...${head}`], { cwd });
  if (u0r.code !== 0) return cannotCompute(gitReason("git diff -U0", u0r));
  const u0 = u0r.stdout;
  const addedByFile = addedLines(u0), removedByFile = removedLines(u0);
  const prot = harness.protected || {};
  const protectedFiles = [];
  for (const f of files) {
    const additive = additiveGlobFor(f, prot);
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
    if (isProtected(f, prot)) protectedFiles.push(f);            // 위반이 아니라 "사람이 머지해야 한다"는 사실 (KTB-5)
    if (f.startsWith(".factory/lessons/")) violations.push(...lessonsFormat(f, readFile(`${cwd}/${f}`) || ""));
    if (matchesAny(harness.test?.test_glob || [], f)) {
      if ((addedByFile.get(f) || []).some((l) => SKIP_PRAGMAS.some((re) => re.test(l.text)))) violations.push({ file: f, rule: "test skip/ignore pragma added" });
    }
  }
  return { ok: violations.length === 0, violations, protected: protectedFiles, checked: { files } };
}

/**
 * `protectedPaths({run, cwd, base, head, harness}) → { ok, files, reason? }` — L1(머지 스테이지)이
 * 쓰는 **목록만** 계산한다(KTB-5). `integrityCheck`와 달리 `git diff -U0`도, 파일 내용 읽기도 하지
 * 않는다: 머지 스테이지는 PR head를 체크아웃한 트리 위에서 돌기 때문에, 그 트리의 파일을 읽어
 * 판단하면 PR이 자기 판정의 재료를 고를 수 있다. name-status diff 하나면 "어떤 경로가 바뀌었나"는
 * 답이 나오고, 그 답만이 사람 머지 여부를 가른다.
 *
 * 빈 목록을 "보호 경로 없음"으로 읽지 않는다 — base가 없거나 git이 실패하면 `ok:false`로,
 * `integrityCheck`의 cannot-compute와 같은 fail-closed 계약이다.
 */
export async function protectedPaths({ run, cwd, base, head = "HEAD", harness }) {
  if (!base) return { ok: false, files: [], reason: "base is empty (merge-base not resolved)" };
  const ns = await run("git", NAME_STATUS(base, head), { cwd });
  if (ns.code !== 0) return { ok: false, files: [], reason: gitReason("git diff --name-status", ns) };
  const prot = harness?.protected || {};
  return { ok: true, files: [...new Set(changedFiles(ns.stdout).filter((f) => isProtected(f, prot)))] };
}

/**
 * `--no-renames`가 핵심이다(fix round 1). rename 탐지가 켜져 있으면 한 줄이 `R096\t<old>\t<new>`가
 * 되는데, 보호 경로를 **보호되지 않는 이름으로 옮기는** diff가 바로 그 모양이다: 예를 들어
 * `.github/workflows/factory-integrity.yml` → `ci-integrity.yml`(잡 이름은 그대로, 본문은 무력화)은
 * 목적지가 보호 경로가 아니므로 출발지를 놓치면 검사에 걸리지 않고, 그대로 자동 머지되면 required
 * 체크 자신이 무력화된다. `--no-renames`면 같은 변경이 `D <old>` + `A <new>` 두 줄로 나와 출발지가
 * 반드시 목록에 들어온다(git config `diff.renames`도 이 플래그가 이긴다).
 */
const NAME_STATUS = (base, head) => ["diff", "--no-renames", "--name-status", `${base}...${head}`];

/**
 * `git diff --name-status` 한 줄 = "<status>\t<path>"이고, rename/copy는 "<status>\told\tnew"다.
 * **모든** 경로 필드를 취한다(마지막 것만이 아니라) — `--no-renames`를 이미 주고 있지만, 그 플래그가
 * 빠진 호출·다른 git 버전·미리 계산된 diff를 받아도 출발지를 잃지 않게 하는 두 번째 문이다.
 */
const changedFiles = (stdout) => stdout.split("\n").filter(Boolean).flatMap((l) => l.split("\t").slice(1)).filter(Boolean);
/** additive_only가 맡은 파일은 그 규칙이 판정한다 — 보호 목록에 넣지 않는다(넣으면 retro의 다크 예시 추가가 매번 사람 머지가 된다). */
const additiveGlobFor = (f, prot) => Object.keys(prot.additive_only || {}).find((g) => matchesAny([g], f));
/** 사람이 머지해야 하는 경로인가: `[protected].factory` 매치 − `except` − `additive_only`. */
const isProtected = (f, prot) => !additiveGlobFor(f, prot) && matchesAny(prot.factory || [], f) && !matchesAny(prot.except || [], f);

/** 판정 불가 — ok:false에 이유를 한 줄로 싣는다(file은 "-": 특정 파일의 위반이 아니다). */
const cannotCompute = (reason) => ({ ok: false, violations: [{ file: "-", rule: `integrity could not be computed: ${reason}` }], protected: [], checked: { files: [] } });
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
