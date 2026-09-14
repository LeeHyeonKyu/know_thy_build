import { matchesAny } from "./glob.js";

const SKIP_PRAGMAS = [/\.skip\s*\(/, /\bxit\s*\(/, /\bxdescribe\s*\(/, /@pytest\.mark\.skip/, /istanbul ignore/, /pragma:\s*no cover/, /Stryker disable/];

/**
 * readFileAt (base content) is accepted for interface symmetry but currently unused:
 * the additive-only position check only reads the CURRENT file (readFile) — it asks
 * "which section did this added line land in", not "what changed relative to base".
 *
 * **KTB-5/KTB-6 — 세 가지를 따로 보고한다.** `ok`(= `violations`)는 **변조**(tamper)만 본다:
 * lessons 포맷, 테스트 skip/ignore pragma, 그리고 "판정 불가". 나머지 둘은 위반이 아니라
 * **"누가 머지해도 되는가"의 정책**이라 따로 실린다:
 *   - `protected` — `[protected].factory` 매치 파일 목록 (KTB-5)
 *   - `policy`    — `[protected].additive_only` 규칙을 벗어난 편집 `{file, rule}` (KTB-6)
 *
 * 이유는 둘 다 같다: `factory/integrity`는 branch protection의 **유일한** required context다
 * (ADR-015 보강). 이 체크가 RED가 되면 `enforce_admins` 아래에서 **사람도** 머지할 수 없고,
 * 그러면 설계가 전제하는 사람 머지 경로가 통째로 막힌다 — KTB-5는 인프라 업그레이드·
 * `factory:harness` PR을, KTB-6은 **모든 역할 프롬프트 변경**(`:role` PR, 에이전트 파일을 건드리는
 * 패키지 업그레이드)을 막고 있었다. 두 정책의 집행은 자동 머지 직전의 L1(`lib/merge-stage.js`)이
 * `protectedPaths()`·`policyViolations()`로 한다 — 사람을 막지 않고 봇만 막는 자리다.
 */
export async function integrityCheck({ run, cwd, base, head = "HEAD", harness, readFile, readFileAt = () => "" }) {
  // 무결성은 "검사했더니 깨끗하다"는 주장이다. diff를 얻지 못했는데 violations가 비었다고 ok:true를
  // 돌려주면 "검사하지 못했음"이 "통과"로 둔갑한다 — base가 비었거나 git이 실패하면 fail-closed다.
  if (!base) return cannotCompute("base is empty (merge-base not resolved)");
  const ns = await run("git", NAME_STATUS(base, head), { cwd });
  if (ns.code !== 0) return cannotCompute(gitReason("git diff --name-status", ns));
  const violations = [];
  const entries = changedEntries(ns.stdout);                    // rename 줄은 경로를 둘 내놓는다 — 같은 파일을 두 번 판정하지 않는다
  const files = entries.map((e) => e.path);
  const u0r = await run("git", U0(base, head), { cwd });
  if (u0r.code !== 0) return cannotCompute(gitReason("git diff -U0", u0r));
  const u0 = u0r.stdout;
  const addedByFile = addedLines(u0), removedByFile = removedLines(u0);
  const prot = harness.protected || {};
  const protectedFiles = [], policy = [];
  for (const { path: f, deleted } of entries) {
    // 사라진 경로에는 **내용 규칙**을 적용할 수 없다(fix round 2, N2). `readFile`이 null인 것은
    // "포맷이 틀렸다"가 아니라 "읽을 파일이 없다"인데, 그것을 위반으로 읽으면 lessons 파일을
    // 지우거나 옮기는 PR이 L0 RED가 되어 아무도 머지할 수 없다(KTB-5와 같은 계열의 오진).
    const text = deleted ? null : readFile(`${cwd}/${f}`);
    const gone = deleted || text === null;
    const additive = additiveGlobFor(f, prot);
    if (additive) {
      // 정책 위반이지 변조가 아니다 — `ok`를 내리지 않고 `policy`에 실린다(KTB-6). 집행은 L1.
      // 내용이 없어도 판정은 성립한다: 삭제는 removals로 잡히고 added는 비어 있다.
      policy.push(...additiveOnlyViolations({
        file: f, allowed: prot.additive_only[additive],
        added: addedByFile.get(f) || [], removed: removedByFile.get(f) || [],
        headText: gone ? "" : text,
      }));
      if (!gone) continue;        // 살아 있는 동안만 additive 규칙이 이 파일을 전담한다 — 삭제·이동은 아래 보호 목록으로도 간다
    }
    // M9 — harness.toml의 얼어붙은 섹션. 삭제된 줄의 섹션을 알려면 **base** 내용이 필요하다:
    // `readFileAt`이 주입돼 있으면 그것으로, 아니면 `git show <base>:<f>`로 읽는다(워킹 트리가 아니다 —
    // 이 검사가 도는 트리는 PR head이므로 base 내용은 거기에 없다). 못 읽으면 빈 문자열이고, 그때는
    // 삭제 줄의 섹션 판정이 서지 않으므로 추가 줄만으로 판정한다.
    if (f === HARNESS_FILE && !gone) {
      const added = addedByFile.get(f) || [], removed = removedByFile.get(f) || [];
      // base 내용은 **삭제된 줄이 있을 때만** 필요하다 — 추가만 있는 diff에 git을 한 번 더 부르지 않는다.
      let baseText = "";
      if (removed.length) {
        baseText = readFileAt(`${cwd}/${f}`, base) || "";
        if (!baseText) { const shown = await run("git", ["show", `${base}:${f}`], { cwd }); baseText = shown.code === 0 ? shown.stdout : ""; }
      }
      policy.push(...harnessSectionViolations({ file: f, added, removed, headText: text || "", baseText }));
    }
    if (isProtectedPath(f, prot)) protectedFiles.push(f);       // 위반이 아니라 "사람이 머지해야 한다"는 사실 (KTB-5)
    // 내용 규칙은 여기서 끝 (N2) — 사라진 lessons만 정책으로 센다. `deleted`(diff가 D로 보고)와
    // "트리에는 있는데 읽히지 않음"(text === null)은 사유 문구를 다르게 낸다(M8).
    if (gone) { policy.push(...lessonsGone(f, deleted)); continue; }
    if (f.startsWith(".factory/lessons/")) violations.push(...lessonsFormat(f, text));
    if (matchesAny(harness.test?.test_glob || [], f)) {
      if ((addedByFile.get(f) || []).some((l) => SKIP_PRAGMAS.some((re) => re.test(l.text)))) violations.push({ file: f, rule: "test skip/ignore pragma added" });
    }
  }
  return { ok: violations.length === 0, violations, protected: protectedFiles, policy, checked: { files } };
}

/**
 * **사라진 lessons 파일은 정책 사안이다**(fix round 2의 "알려진 한계"를 닫는다).
 * `.factory/lessons/**`는 `[protected].except`라 보호 목록에 들어가지 않고, 삭제된 경로에는 내용 규칙도
 * 걸리지 않는다(N2) — 그래서 `.factory/lessons/reviewer-qa.md`를 지우거나 옮기는 diff는 L0에서도 L1에서도
 * **아무 신호를 만들지 않았다**. 누적된 교훈이 조용히 사라지는 경로다. 변조로 다루지는 않는다(역할을
 * 은퇴시키며 지우는 것은 정상 작업이다) — additive-only 위반과 같은 자리, 곧 `policy`(사람이 머지한다)로
 * 올린다. rename은 `--no-renames` 덕에 `D <old>`로 보이므로 출발지가 그대로 잡힌다.
 *
 * **삭제와 "못 읽음"은 다른 사건이다**(KTB-10 M8). 위의 `gone`은 둘을 합치는데 — `deleted`(diff가 D로
 * 보고) 또는 `readFile`이 null(트리에 있는데 읽히지 않음) — 사람에게 내미는 사유까지 합치면 오보가
 * 된다: 권한·인코딩 문제로 읽지 못한 파일을 "지워졌다"고 말하면 사람이 있지도 않은 삭제를 diff에서
 * 찾는다. 판정(사람 머지)은 같고 문구만 갈린다 — 둘 다 "내용 규칙을 적용할 수 없다"이기 때문이다.
 */
const LESSONS_DIR = ".factory/lessons/";
const lessonsGone = (f, deleted = true) => (f.startsWith(LESSONS_DIR) && f.endsWith(".md")
  ? [{ file: f, rule: `lessons file ${deleted ? "deleted or moved away" : "unreadable"} — human merge required` }]
  : []);
/** `lessonsGone`이 만드는 규칙 문자열의 단일 출처 — L1(`merge-stage.js`)이 거부 문구를 규칙별로 가른다. */
export const LESSONS_POLICY_RULE = /^lessons file (?:deleted or moved away|unreadable) — human merge required$/;

/**
 * additive-only 판정의 **단일 본체** — L0(`integrityCheck`)와 L1(`policyViolations`)이 같은 함수를
 * 쓴다. 둘이 갈라지면 체크가 알리는 것과 머지가 막는 것이 달라진다.
 * `headText`는 "머지될 파일의 내용"이다 — L0는 체크아웃된 워킹 트리에서, L1은 `git show <head>:<f>`로
 * 읽어 넘긴다(L1은 워킹 트리를 절대 읽지 않는다).
 */
export function additiveOnlyViolations({ file, allowed, added, removed, headText }) {
  const v = [];
  // An added '## ' header can never define a section boundary for itself or for other
  // added lines — otherwise a diff could inject "+malicious\n+## Examples" and have the
  // injected header retroactively "legitimize" the disallowed content that precedes it.
  const addedLineNos = new Set(added.map((l) => l.line));
  const headerAdded = added.some((l) => /^##\s/.test(l.text));
  const lines = (headText || "").split("\n");
  const outside = added.some((l) => !allowed.includes(sectionAt(lines, l.line, addedLineNos)));
  if (removed.length || outside) v.push({ file, rule: `additive-only sections (${allowed.join(", ")}) — removals or edits outside allowed sections` });
  if (headerAdded) v.push({ file, rule: "additive-only: header added" });
  return v;
}

// ── 외부 감사 M9: harness 모드에서도 얼어 있는 harness.toml의 세 섹션 (ADR-023) ────────────────
/**
 * `factory:harness` 이슈의 builder는 `FACTORY_HARNESS_ISSUE=1`로 `.factory/harness.toml`을 **편집할 수
 * 있다**(KTB-20: 승격이 하려는 일이 바로 그 파일의 편집이다). 그런데 그 파일 안에는 편집이 곧
 * 판정 기준의 변경인 세 섹션이 있다:
 *   `[protected]`        — 무엇이 사람 머지인가. 여기를 넓히면 자기 PR을 보호 목록 밖으로 낼 수 있다.
 *   `[gates.thresholds]` — coverage/mutation/flaky 한계. 여기를 낮추면 게이트가 통과한다.
 *   `[load_bearing]`     — 어떤 파일이 하중을 받는가. 여기를 비우면 tier 바닥이 사라진다.
 *
 * **훅 규칙으로는 이것을 막을 수 없다**. 훅이 보는 것은 명령줄(그리고 Edit/Write의 `file_path`)뿐이라
 * "이 편집이 harness.toml의 **어느 섹션**에 떨어지는가"를 알 방법이 없다 — 그 판정은 내용 기반이다.
 * 같은 이유로 L2 deny(경로 글롭)도 답이 될 수 없다: 경로는 하나고 섹션은 여럿이다. 그래서 집행은
 * diff를 읽는 이 자리(L0가 보고, L1이 자동 머지를 거부)에 있다.
 *
 * 변조(`violations`)가 아니라 **정책**(`policy`)이다 — `additive_only`와 같은 취급이다. L0가 RED가 되면
 * required context가 빨개져 사람조차 머지할 수 없다(KTB-5/KTB-6와 같은 이유).
 *
 * harness 모드가 아닐 때도 그대로 센다. 이 검사는 CI의 integrity 잡과 merge 스테이지에서 도는데 거기엔
 * `FACTORY_HARNESS_ISSUE`가 서 있지 않고(그 변수는 에이전트 세션의 env다), 평범한 이슈에서는
 * harness.toml이 이미 `[protected].factory`라 판정이 같다(사람 머지) — 조건을 달면 신뢰할 수 없는
 * 입력(=PR이 고를 수 있는 값)에 판정을 맡기게 된다.
 */
export const HARNESS_FILE = ".factory/harness.toml";
export const FROZEN_HARNESS_SECTIONS = Object.freeze(["protected", "gates.thresholds", "load_bearing"]);
const FROZEN_HEADER_RE = new RegExp(`^\\s*\\[(${FROZEN_HARNESS_SECTIONS.map((s) => s.replace(/\./g, "\\.")).join("|")})\\]`);
/** `harnessSectionViolations`가 만드는 규칙 문자열의 단일 출처 — L1이 거부 문구를 규칙별로 가른다. */
export const HARNESS_SECTION_POLICY_RULE = /^harness\.toml \[[a-z._]+\] edited — human merge required$/;

/** TOML 섹션 판정: lineNo(1-indexed)가 속한 가장 가까운 `[section]` 헤더 이름. 이번 diff가 **추가한** 헤더는 경계로 인정하지 않는다(additive-only의 `sectionAt`과 같은 이유 — 주입된 헤더가 자기 앞의 줄을 소급 정당화할 수 없다). */
function tomlSectionAt(lines, lineNo, addedLineNos = new Set()) {
  let current = null;
  for (let i = 0; i < lineNo - 1 && i < lines.length; i++) {
    const m = /^\s*\[\[?([A-Za-z0-9_.-]+)\]\]?/.exec(lines[i]);
    if (m && !addedLineNos.has(i + 1)) current = m[1];
  }
  return current;
}

/**
 * harness.toml의 얼어붙은 섹션을 건드렸는가. 추가된 줄은 **head** 내용으로, 삭제된 줄은 **base**
 * 내용으로 섹션을 판정한다 — 지워진 줄은 head에 없으므로 head만 보면 삭제가 통째로 보이지 않는다.
 * 섹션 헤더 자체를 추가·삭제한 것도 위반이다(섹션을 통째로 들이거나 없애는 것이 가장 큰 편집이다).
 */
export function harnessSectionViolations({ file = HARNESS_FILE, added = [], removed = [], headText = "", baseText = "" }) {
  const hit = new Set();
  const addedLineNos = new Set(added.map((l) => l.line));
  const headLines = (headText || "").split("\n");
  const baseLines = (baseText || "").split("\n");
  for (const l of added) {
    const h = FROZEN_HEADER_RE.exec(l.text);
    if (h) { hit.add(h[1]); continue; }
    const s = tomlSectionAt(headLines, l.line, addedLineNos);
    if (FROZEN_HARNESS_SECTIONS.includes(s)) hit.add(s);
  }
  for (const l of removed) {
    const h = FROZEN_HEADER_RE.exec(l.text);
    if (h) { hit.add(h[1]); continue; }
    const s = tomlSectionAt(baseLines, l.line);
    if (FROZEN_HARNESS_SECTIONS.includes(s)) hit.add(s);
  }
  return FROZEN_HARNESS_SECTIONS.filter((s) => hit.has(s)).map((s) => ({ file, rule: `harness.toml [${s}] edited — human merge required` }));
}

/**
 * `policyViolations({run, cwd, base, head, harness}) → { ok, files, violations, reason? }` —
 * L1(머지 스테이지)이 쓰는 **섹션 정책** 계산이다(KTB-6). `protectedPaths()`는 name-status만으로
 * 답이 나오지만 섹션 판정에는 파일 내용이 필요하다 — 그런데 머지 스테이지는 PR head를 체크아웃한
 * 트리 위에서 돌기 때문에 **워킹 트리를 읽으면 PR이 자기 판정의 재료를 고를 수 있다**. 그래서
 * 내용은 오직 `git show <rev>:<file>`로 읽는다(체크아웃 상태와 무관하게 그 revision의 blob이다).
 *
 * `additive_only` 글롭에 걸리는 파일만 본다 — 나머지는 git을 한 번도 더 부르지 않는다.
 * 삭제된 파일은 `git show <head>:<f>`가 실패하는데, 그것은 판정 불가가 아니라 **빈 내용**이다
 * (삭제 = 전부 removal = 정책 위반). 그 외 git 실패는 fail-closed `ok:false`다.
 */
export async function policyViolations({ run, cwd, base, head = "HEAD", harness }) {
  if (!base) return { ok: false, files: [], violations: [], reason: "base is empty (merge-base not resolved)" };
  const prot = harness?.protected || {};
  const ns = await run("git", NAME_STATUS(base, head), { cwd });
  if (ns.code !== 0) return { ok: false, files: [], violations: [], reason: gitReason("git diff --name-status", ns) };
  const changed = changedEntries(ns.stdout);
  const violations = [];
  // 사라진 lessons는 글롭과 무관하게 센다 — L0가 `policy`로 올린 것과 **같은 판정**이어야 한다.
  for (const e of changed) if (e.deleted) violations.push(...lessonsGone(e.path, true));
  // M9 — harness.toml의 얼어붙은 섹션도 글롭과 무관하게 센다(L0와 같은 판정). 내용은 워킹 트리가
  // 아니라 revision의 blob으로 읽는다: 이 스테이지는 PR head를 체크아웃한 트리 위에서 돌기 때문에
  // 트리를 읽으면 PR이 자기 판정의 재료를 고르게 된다.
  if (changed.some((e) => e.path === HARNESS_FILE && !e.deleted)) {
    const u0r = await run("git", U0(base, head, HARNESS_FILE), { cwd });
    if (u0r.code !== 0) return { ok: false, files: [], violations: [], reason: gitReason(`git diff -U0 -- ${HARNESS_FILE}`, u0r) };
    const headShow = await run("git", ["show", `${head}:${HARNESS_FILE}`], { cwd });
    const baseShow = await run("git", ["show", `${base}:${HARNESS_FILE}`], { cwd });
    violations.push(...harnessSectionViolations({
      file: HARNESS_FILE,
      added: addedLines(u0r.stdout).get(HARNESS_FILE) || [], removed: removedLines(u0r.stdout).get(HARNESS_FILE) || [],
      headText: headShow.code === 0 ? headShow.stdout : "", baseText: baseShow.code === 0 ? baseShow.stdout : "",
    }));
  }
  const entries = Object.keys(prot.additive_only || {}).length
    ? changed.map((e) => [e.path, additiveGlobFor(e.path, prot)]).filter(([, g]) => g)
    : [];
  for (const [f, glob] of entries) {
    const u0r = await run("git", U0(base, head, f), { cwd });
    if (u0r.code !== 0) return { ok: false, files: [], violations: [], reason: gitReason(`git diff -U0 -- ${f}`, u0r) };
    // 삭제됐으면 빈 내용이다 — 실패를 판정 불가로 올리지 않는다(삭제 자체가 정책 위반으로 잡힌다).
    const shown = await run("git", ["show", `${head}:${f}`], { cwd });
    violations.push(...additiveOnlyViolations({
      file: f, allowed: prot.additive_only[glob],
      added: addedLines(u0r.stdout).get(f) || [], removed: removedLines(u0r.stdout).get(f) || [],
      headText: shown.code === 0 ? shown.stdout : "",
    }));
  }
  return { ok: true, files: [...new Set(violations.map((v) => v.file))], violations };
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
  return { ok: true, files: [...new Set(changedEntries(ns.stdout).filter((e) => isProtectedEntry(e, prot)).map((e) => e.path))] };
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
 * `-U0` diff도 **같은 플래그**를 써야 한다(fix round 2, N1). 하나만 `--no-renames`면 두 호출이 서로
 * 다른 세계를 본다: name-status는 rename을 D+A로 펼치는데 `-U0`는 `R`로 접어서, 옮겨진 파일의
 * 추가·삭제 줄이 **빈 집합**이 된다. 그러면 additive-only 분기가 "위반 없음"을 만들고 `continue`해서
 * 보호 목록에도 닿지 않는다 — `mv .claude/agents/reviewer-qa.md docs/x.md`가 L0 GREEN에 protected
 * 빈 목록으로 빠져나간다(실측). 같은 플래그면 그 변경은 전체 삭제로 보여 removal 규칙에 걸린다.
 */
const U0 = (base, head, file) => ["diff", "--no-renames", "-U0", `${base}...${head}`, ...(file ? ["--", file] : [])];

/**
 * `git diff --name-status` 한 줄 = "<status>\t<path>"이고, rename/copy는 "<status>\told\tnew"다.
 * **모든** 경로 필드를 상태와 함께 취한다 — `--no-renames`를 이미 주고 있지만, 그 플래그가 빠진
 * 호출·다른 git 버전·미리 계산된 diff를 받아도 출발지를 잃지 않게 하는 두 번째 문이다.
 * rename의 출발지는 삭제된 것으로, copy의 출발지는 그대로 있는 것으로 편다.
 */
function changedEntries(stdout) {
  const out = new Map();                                        // path → entry (같은 경로가 두 줄에 나와도 한 번만)
  const put = (path, deleted) => { if (!path) return; const prev = out.get(path); out.set(path, { path, deleted: prev ? prev.deleted && deleted : deleted }); };
  for (const line of stdout.split("\n").filter(Boolean)) {
    const [status, p1, p2] = line.split("\t");
    if (p2 && /^R/.test(status)) { put(p1, true); put(p2, false); continue; }   // 옮겨졌다 = 출발지는 사라졌다
    if (p2) { put(p1, false); put(p2, false); continue; }                        // copy: 출발지는 그대로 있다
    put(p1, /^D/.test(status));
  }
  return [...out.values()];
}
/** additive_only가 맡은 파일은 그 규칙이 판정한다 — 보호 목록에 넣지 않는다(넣으면 retro의 다크 예시 추가가 매번 사람 머지가 된다). */
const additiveGlobFor = (f, prot) => Object.keys(prot.additive_only || {}).find((g) => matchesAny([g], f));
/** `[protected].factory` 매치 − `except`. additive_only 면제는 호출자가 건다(살아 있는 파일에만). */
const isProtectedPath = (f, prot) => matchesAny(prot.factory || [], f) && !matchesAny(prot.except || [], f);
/**
 * 사람이 머지해야 하는 경로인가. additive_only 면제는 그 파일이 **계속 존재할 때만** 적용된다 —
 * 그 면제의 근거가 "허용 섹션에 추가만 했다"(retro의 다크 경로)인데, 삭제·이동은 어떤 섹션에도
 * 추가한 것이 아니기 때문이다(fix round 2, N1).
 */
const isProtectedEntry = ({ path, deleted }, prot) => (!deleted && additiveGlobFor(path, prot) ? false : isProtectedPath(path, prot));

/** 판정 불가 — ok:false에 이유를 한 줄로 싣는다(file은 "-": 특정 파일의 위반이 아니다). */
const cannotCompute = (reason) => ({ ok: false, violations: [{ file: "-", rule: `integrity could not be computed: ${reason}` }], protected: [], policy: [], checked: { files: [] } });
const gitReason = (what, r) => `${what} exited ${r.code}${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ""}`;

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

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
    if (h) { newLine = Number(h[2]); continue; }
    if (file && line.startsWith("+") && !line.startsWith("+++")) {
      if (!m.has(file)) m.set(file, []);
      m.get(file).push({ text: line.slice(1), line: newLine });
      newLine++;
    }
  }
  return m;
}
/**
 * 삭제된 줄. `additive_only` 판정은 위치를 안 따지지만(있으면 위반), harness.toml 섹션 판정(M9)은
 * **어느 섹션에서 지워졌는가**를 물어야 해서 base 파일 기준 줄 번호(`line`, 1-indexed)를 함께 싣는다.
 * 삭제 전용 diff도 옛 파일명으로 귀속시킨다.
 */
function removedLines(u0) {
  const m = new Map(); let file = null, pendingOld = null, oldLine = 0;
  for (const line of u0.split("\n")) {
    if (line.startsWith("--- ")) { pendingOld = line.startsWith("--- a/") ? line.slice(6) : null; continue; }
    if (line.startsWith("+++ ")) { file = fileFor(line, file, pendingOld); continue; }
    const h = HUNK_HEADER.exec(line);
    if (h) { oldLine = Number(h[1]); continue; }
    if (file && line.startsWith("-") && !line.startsWith("---")) {
      if (!m.has(file)) m.set(file, []);
      m.get(file).push({ text: line.slice(1), line: oldLine });
      oldLine++;
    }
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
