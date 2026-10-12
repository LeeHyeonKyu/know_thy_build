import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

/** 테스트 파일을 지정 실행하는 명령이 없으면 증명 게이트는 "실패"가 아니라 설정 오류다. */
const MISSING_TEST_FILES = { ok: false, misconfigured: true, detail: "commands.test_files missing" };

/**
 * 외부 감사 2026-09-14 M2 — **base 워크트리에는 `node_modules`가 없다.**
 *
 * `git worktree add --detach`가 만드는 것은 소스뿐이라, 이 저장소의 새 테스트를 그 위에서 돌리면
 * 거의 언제나 `Cannot find module 'vitest'`로 죽는다. 그 exit≠0을 예전 코드는 "base에서 실패했다
 * = 이 변경을 증명한다"로 읽었다 — 곧 **모든** 테스트가, 심지어 아무것도 증명하지 않는 테스트도
 * 이 게이트를 통과했다. 증명 게이트가 통째로 무의미했던 지점이다.
 *
 * 그래서 테스트를 돌리기 전에 base 워크트리에 의존성을 깐다. 하네스가 `[runtime].setup`을
 * 정의했으면 **그것이 정본이다**(pnpm·yarn·bundler 저장소는 npm을 모른다). 없으면 lockfile이 있을
 * 때 `npm ci`, `package.json`만 있으면 `npm install --no-audit`, 둘 다 없으면 설치할 것이 없다
 * (Node 저장소가 아닐 수 있다 — 없는 생태계를 발명하지 않는다).
 */
export function baseInstallCommand(harness, tmp, exists = existsSync) {
  const setup = harness?.runtime?.setup;
  if (typeof setup === "string" && setup.trim()) return setup;
  if (exists(join(tmp, "package-lock.json"))) return "npm ci";
  if (exists(join(tmp, "package.json"))) return "npm install --no-audit";
  return null;
}

/**
 * base 실행의 실패가 **이 변경에 대해 아무것도 말해주지 않는** 종류인가(감사 M2). 모듈을 못 찾거나
 * ESM/CJS 경계에서 죽은 것은 "base에 그 기능이 없다"가 아니라 "base에서 테스트가 아예 시작되지
 * 못했다"다 — 증명이 아니라 판정 불가다.
 *
 * 반대로 **넣지 않은 것**이 이 목록의 핵심이다: `does not provide an export named 'x'`와
 * `lib.parseX is not a function`은 정직한 증명의 모습 그대로다(base에는 그 export가 없다).
 * `is not a function`은 주어가 `undefined`일 때만 — 임포트 자체가 통째로 비었다는 신호일 때만 —
 * 판정 불가로 센다.
 */
const INCONCLUSIVE_ON_BASE = [
  /Cannot find module/i,
  /Cannot find package/i,
  /ERR_MODULE_NOT_FOUND/,
  /SyntaxError: (?:Unexpected token '?export'?|Cannot use import statement outside a module)/,
  /(?:^|[\s:])(?:undefined|\(intermediate value\)) is not a function/,
  // 1.4.13 (own-calendar #31) — node만 알던 목록에 Dart/Flutter·Python을 더한다. 이 패턴이 없으면 base 워크트리에서
  // 패키지를 못 푼 Dart 테스트의 exit≠0이 "증명"(prove) 또는 "특성화 실패"(characterization)로 읽힌다.
  /Target of URI doesn't exist/,
  /Couldn't resolve the package/,
  /Error: Could not find a file named "pubspec\.yaml"/,
  /pub get failed/,
  /ModuleNotFoundError/,
  /ImportError: cannot import name/,
];
export const inconclusiveOnBase = (text) => INCONCLUSIVE_ON_BASE.some((re) => re.test(String(text || "")));

/**
 * 1.4.8 (데모 #58): 새 테스트가 **이 변경에서 새로 생긴 모듈**을 임포트하면 base에는 그 모듈이 없어 임포트 오류로
 * 죽는다 — 그것은 "판정 불가"가 아니라 base에서 **반드시** 실패한다는 증명이다(모듈이 없으니 통과할 길이 없다).
 * 임포트 오류 출력에 새로 추가된 비-테스트 파일의 이름이 보이면 증명으로 친다. 이름이 안 보이면 예전처럼 판정 불가다.
 */
export const addedModuleNamedIn = (output, addedFiles = []) => {
  const text = String(output || "");
  // 1.4.30 (L36, own-calendar #51/#52) — 임포트 오류는 대개 **확장자 없이** 모듈을 부른다(vitest: `Failed to resolve import
  // "../src/lib/logger"`; node ESM: `Cannot find module '.../logger'`). basename(`logger.ts`)만 찾으면 이 변경이 추가한 모듈이
  // 눈앞에 있어도 "판정 불가"로 읽혀 MISCONFIGURED가 났다 — stem(`logger`)도 경로 구분자·따옴표 경계에서 찾는다.
  return addedFiles.find((f) => {
    const b = f.split("/").pop();
    if (!b) return false;
    if (text.includes(b)) return true;
    const stem = b.replace(/\.[^.]+$/, "");
    if (!stem || stem === b) return false;
    const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`[/'"\`]${esc}(?:['"\`]|\\?|$|\\s)`).test(text);
  }) || null;
};

/**
 * 1.4.9 (own-calendar #28/#29): **테스트만 바뀐 diff**(source_glob 변경 0)는 기존 동작을 특성화하는 이슈다 — 그 테스트는
 * base에서도 **통과해야** 한다(base와 head의 소스가 같다). "base에서 실패해야 증명"이라는 기본 규칙을 여기에 적용하면
 * 빌더는 통과시키려고 프로덕션 코드를 덧붙이고(라이브: `operator ==`·`toString` 추가) 검증자가 계약 위반으로 거부한다.
 * 모드는 diff 형태에서 러너가 정한다 — 에이전트가 고를 수 없다.
 */
export const CHARACTERIZATION = "characterization";
/**
 * 1.4.14 (own-calendar #31, L16) — 모드 선택의 **단일 본체**. 스테이지 게이트(gates.js)와 검증자가 읽는 진단 CLI
 * (bin/prove-test.js)가 같은 diff에 다른 모드를 대면, 게이트는 특성화 GREEN인데 CLI는 "base에서 통과 — 증명 아님"이라
 * 하고 검증자가 그 CLI 출력으로 거부한다 — #31에서 실제로 일어난 일이다. 1.4.10의 규칙 그대로: 바뀐 파일이 전부 테스트일 때만 특성화.
 */
export const proveModeFor = (changed) => (changed?.tests?.length && changed.all.every((f) => changed.tests.includes(f)) ? CHARACTERIZATION : "prove");

/**
 * 1.4.13 (own-calendar #31, KTB #75) — **자기 자신을 단언하는 테스트는 증명이 아니다.** 빌더가 "이 테스트 파일이 git에
 * 추적돼야 한다"(`git ls-files <자기 경로>`)를 단언해 base 워크트리(복사본이라 미추적)에서만 실패하게 만들었다 — prove-test
 * 메커니즘 자체를 재료로 "base에서 실패"를 제조한 것이다. 새 테스트 파일이 **자기 경로**를 본문에 적으면 그 테스트는 저장소가
 * 아니라 자기 자신에 대한 것이므로 게이트가 RED로 이름을 붙여 돌려보낸다. 다른 파일의 추적 여부를 묻는 가드 테스트는 막지 않는다.
 * → `[{file, hit}]` (비어 있으면 통과).
 */
const COMMENT_LINE = /^\s*(?:\/\/|#|\*|\/\*|\*\/|---|'''|""")/;
const SELF_ASSERT_CONTEXT = /\bgit|ls[-_ ]?files|exists|\bstat\b|mtime|File\(|Directory\(|readFile|readdir|os\.path|Path\(|fs\./i;
export function selfReferentialTests(addedTests = [], readFile) {
  const hits = [];
  for (const f of addedTests) {
    let text;
    try { text = String(readFile(f)); } catch { continue; }
    const base = f.split("/").pop();
    const stem = base.replace(/\.[^.]+$/, "");
    // 1.4.22 (L25, own-calendar #31) — **주석은 단언이 아니다.** 첫 판은 본문 어디든 자기 파일명이 보이면 잡았고, "the changeset
    // adds exactly one file: client/test/…_test.dart"라는 머리말 주석에 걸려 정직한 특성화 테스트를 RED로 세웠다. 이제 주석 줄을
    // 빼고, 자기 경로가 **파일·git 상태를 묻는 호출과 같은 줄**에 있을 때만 잡는다 — #31의 원래 속임수(`git ls-files <자기 경로>`)는
    // 그대로 걸리고, 이름을 적기만 한 줄은 지나간다.
    const line = text.split("\n").find((l) => !COMMENT_LINE.test(l) && [f, base, stem].some((n) => n && l.includes(n)) && SELF_ASSERT_CONTEXT.test(l));
    if (line) hits.push({ file: f, hit: [f, base, stem].find((n) => n && line.includes(n)), line: line.trim().slice(0, 160) });
  }
  return hits;
}

export async function proveTest({ run, cwd, harness, base, addedTests, addedFiles = [], mode = "prove", tmp = `${cwd}/.factory/out/prove-wt`, exists = existsSync }) {
  if (!harness.commands?.test_files) return { ...MISSING_TEST_FILES };
  if (!addedTests?.length) return { ok: false, detail: "no new tests in this change (done_when must be backed by new tests)" };
  const g = (args) => run("git", args, { cwd });
  const add = await g(["worktree", "add", "--detach", tmp, base]);
  if (add.code !== 0) return { ok: false, detail: `worktree add failed: ${add.stderr}` };
  try {
    for (const f of addedTests) {
      mkdirSync(dirname(join(tmp, f)), { recursive: true });
      const cp = await run("cp", [`${cwd}/${f}`, `${tmp}/${f}`]);
      if (cp.code !== 0) return { ok: false, detail: `copy failed for ${f}: ${cp.stderr}` };
    }
    // 1.4.13 (own-calendar #31) — 복사한 테스트를 base 워크트리의 인덱스에 **의도 추가**한다. `cp`만 하면 그 파일은 미추적이라
    // `git ls-files`·`git status`를 읽는 테스트(가드 테스트가 흔히 그렇다)가 head와 base에서 다른 세계를 본다. 인덱스에 이름만
    // 올리면(-N) 내용은 그대로이고 워크트리는 `remove --force`로 지워지므로 base 커밋은 건드리지 않는다. 실패해도 증명 자체를
    // 막지는 않는다(추적 여부에 무관한 테스트가 대부분이다) — 이유만 남긴다.
    const ita = await g(["-C", tmp, "add", "--intent-to-add", "--", ...addedTests]);
    const indexNote = ita.code === 0 ? "" : ` (note: intent-to-add of the copied tests failed in the base worktree: ${String(ita.stderr || "").trim().slice(0, 120)})`;
    // 감사 M2 — 설치가 실패하면 그 base 실행은 무엇을 말하든 믿을 수 없다. fail closed:
    // "실패했으니 증명됐다"가 정확히 이 게이트가 죽었던 방식이다.
    const install = baseInstallCommand(harness, tmp, exists);
    if (install) {
      const ins = await run("bash", ["-lc", install], { cwd: tmp });
      if (ins.code !== 0) {
        return { ok: false, misconfigured: true, inconclusive: [...addedTests], detail: `base dependency install failed (${install}, exit ${ins.code}) — the base run cannot prove anything: ${String(ins.stderr || ins.stdout || "").trim().slice(0, 200)}` };
      }
    }
    // KTB-44 리뷰 should_fix 8 — `replaceAll`이다. `replace`는 **첫 번째** 자리표시자만 채우므로
    // `{files}`가 두 번 나오는 하네스(`cd client && npx vitest {files} --reporter=… {files}` 같은
    // 모양)에서는 두 번째가 리터럴 `{files}`로 셸에 남아, 게이트가 "그런 파일 없음"으로 죽는다.
    // 리허설(rehearsal.js)은 처음부터 `replaceAll`이었다 — 리허설이 스테이지와 다르게 돌면 리허설이
    // 증명하는 것은 스테이지가 아니다.
    const cmd = harness.commands.test_files.replaceAll("{files}", addedTests.map(q).join(" "));
    const r = await run("bash", ["-lc", cmd], { cwd: tmp });
    if (mode === CHARACTERIZATION) {
      if (r.code === 0) return { ok: true, mode, detail: `characterization: test-only diff — the new tests pass on base ${base.slice(0, 7)} too (they pin existing behaviour; nothing to prove by failing)` };
      const out = `${r.stdout || ""}\n${r.stderr || ""}`;
      if (inconclusiveOnBase(out)) return { ok: false, misconfigured: true, inconclusive: [...addedTests], mode, detail: `characterization: the new tests did not run on base ${base.slice(0, 7)} (import/module error)` };
      return { ok: false, mode, detail: `characterization: test-only diff but the new tests FAIL on base ${base.slice(0, 7)} (exit ${r.code}) — they do not pin existing behaviour, or the base worktree differs from head in test setup${indexNote}` };
    }
    if (r.code === 0) return { ok: false, detail: `new tests passed on base ${base.slice(0, 7)} — they do not prove the change` };
    const output = `${r.stdout || ""}\n${r.stderr || ""}`;
    if (inconclusiveOnBase(output)) {
      const added = addedModuleNamedIn(output, addedFiles.filter((f) => !addedTests.includes(f)));
      if (added) return { ok: true, detail: `new tests fail on base ${base.slice(0, 7)}: they import \`${added}\`, which this change adds — the module under test does not exist on base, so the tests cannot pass there` };
      return { ok: false, misconfigured: true, inconclusive: [...addedTests], detail: `inconclusive on base ${base.slice(0, 7)}: the new tests did not run there (module resolution / import error), so their failure proves nothing${install ? ` — dependencies were installed with \`${install}\`` : " — no dependency install command was found for the base worktree"}` };
    }
    return { ok: true, detail: `new tests fail on base (exit ${r.code})${indexNote}` };
  } finally {
    await g(["worktree", "remove", "--force", tmp]);
  }
}

/**
 * 1.4.15 (own-calendar #31, L17) — **프로젝트 락을 잡는 툴체인은 동시 실행이 곧 실패다.** `flutter test` 둘을 같은 프로젝트에서
 * 동시에 돌리면(실측: 스크래치 클론) 하나는 "Waiting for another flutter command to release the startup lock"에서, 다른 하나는
 * `build/native_assets` 경쟁(`lipo: can't move temporary file`)에서 **둘 다** exit 1이다. repeatNewTests의 첫 반복은 전체
 * 스위트와 **동시에** 도는 것이 설계였고(부하 아래의 흔들림을 보려고), 그것이 #31의 "non-deterministic: exit codes 1,0,0"을
 * 만들었다 — 테스트가 아니라 게이트가 흔들렸다. 명령이 그런 툴체인을 부르면 전체 스위트를 먼저 끝내고 반복을 돈다.
 * 하네스가 `[gates].repeat_alongside_suite`를 명시하면 그것이 정본이다(true/false).
 */
const PROJECT_LOCK_TOOLCHAINS = /\b(?:flutter|dart)\s+test\b|\bgradlew?\b|\bcargo\s+test\b|\bswift\s+test\b|\bxcodebuild\b|\bsbt\b|\bmvn\b/;
export function repeatAlongsideSuite(harness) {
  const v = harness?.gates?.repeat_alongside_suite;
  if (typeof v === "boolean") return v;
  const cmds = [harness?.commands?.test_files, harness?.commands?.unit].filter(Boolean).join("\n");
  return !PROJECT_LOCK_TOOLCHAINS.test(cmds);
}

export async function repeatNewTests({ run, cwd, harness, addedTests, times, fullSuiteCmd = harness.commands?.unit, alongside = repeatAlongsideSuite(harness) }) {
  // 반복 횟수를 모르면 "흔들리지 않음"을 주장할 수 없다 — 통과가 아니라 설정 오류다.
  if (!(times >= 1)) return { ok: false, misconfigured: true, runs: [], detail: "new_test_repeats missing" };
  if (!harness.commands?.test_files) return { ...MISSING_TEST_FILES, runs: [] };
  if (!addedTests?.length) return { ok: true, runs: [], detail: "no new tests" };
  const cmd = harness.commands.test_files.replaceAll("{files}", addedTests.map(q).join(" "));
  const runs = [];
  // 락을 잡는 툴체인: 전체 스위트를 **먼저** 끝낸다(동시 실행이 아니라 순차 — 결과는 여전히 "전체 스위트 뒤의 반복"이다).
  if (fullSuiteCmd && !alongside) await run("bash", ["-lc", fullSuiteCmd], { cwd });
  for (let i = 0; i < times; i++) {
    const noisy = i === 0 && fullSuiteCmd && alongside ? run("bash", ["-lc", fullSuiteCmd], { cwd }) : null;
    const r = await run("bash", ["-lc", cmd], { cwd });
    if (noisy) await noisy;
    // 1.4.14 (own-calendar #31) — 실패한 반복은 **출력 꼬리를 남긴다**. exit 코드만 남으면 "1,0,0"이 테스트의 흔들림인지
    // 툴체인 락(flutter·gradle의 startup lock, 첫 반복은 전체 스위트와 동시에 돈다)인지 아무도 가릴 수 없다.
    runs.push(r.code === 0 ? { code: r.code } : { code: r.code, noisy: Boolean(noisy), tail: String(r.stderr || r.stdout || "").trim().slice(-300) });
  }
  const ok = runs.every((r) => r.code === 0);
  const quietNote = fullSuiteCmd ? (alongside ? "" : " (full suite ran before the repeats, not alongside — the toolchain holds a project lock)") : " (quiet: no full-suite command configured)";
  const failedTail = ok ? "" : runs.filter((r) => r.code !== 0).map((r, i) => ` — run ${runs.indexOf(r) + 1}${r.noisy ? " (alongside the full suite)" : ""}: ${r.tail || "(no output)"}`).join("");
  return { ok, runs, detail: (ok ? `${times}/${times} passes` : `non-deterministic: exit codes ${runs.map((r) => r.code).join(",")}${failedTail}`) + quietNote };
}

/**
 * 1.4.15 (KTB #53, own-calendar #21) — **기존 테스트를 고친 변경의 증명.** "6 group tests fail on main — make them green"
 * 이슈의 빌더는 소스만 고치고 테스트를 추가하지 않는다(추가할 것이 없다: 테스트는 이미 있다). 예전 prove-test는 그것을
 * "no new tests"로 RED 처리했고 유일한 출구는 사람 머지였다. 이슈 본문의 `fixes_tests:` 목록(사람이 적는다)을 base 워크트리
 * 에서 돌려 **RED**(판정 불가 아님)를 확인하고 head에서 **GREEN**을 확인한다 — 그 둘이 이 변경의 증명이다.
 * 목록의 파일은 base에도 있으므로 복사하지 않는다; base에서 통과하면 "고친 것이 없다"(RED), base에서 모듈 오류면 판정 불가.
 */
export async function proveFixedTests({ run, cwd, harness, base, tests, tmp = `${cwd}/.factory/out/prove-wt`, exists = existsSync }) {
  if (!harness.commands?.test_files) return { ...MISSING_TEST_FILES };
  if (!tests?.length) return { ok: false, detail: "fixes_tests: list is empty" };
  const g = (args) => run("git", args, { cwd });
  const add = await g(["worktree", "add", "--detach", tmp, base]);
  if (add.code !== 0) return { ok: false, detail: `worktree add failed: ${add.stderr}` };
  try {
    const missing = tests.filter((f) => !exists(join(tmp, f)));
    if (missing.length) return { ok: false, misconfigured: true, detail: `fixes_tests names files that do not exist on base ${base.slice(0, 7)}: ${missing.join(", ")} — the marker must list EXISTING tests that are red on base` };
    const install = baseInstallCommand(harness, tmp, exists);
    if (install) {
      const ins = await run("bash", ["-lc", install], { cwd: tmp });
      if (ins.code !== 0) return { ok: false, misconfigured: true, inconclusive: [...tests], detail: `base dependency install failed (${install}, exit ${ins.code}) — the base run cannot prove anything: ${String(ins.stderr || ins.stdout || "").trim().slice(0, 200)}` };
    }
    const cmd = harness.commands.test_files.replaceAll("{files}", tests.map(q).join(" "));
    const onBase = await run("bash", ["-lc", cmd], { cwd: tmp });
    if (onBase.code === 0) return { ok: false, detail: `fixes_tests: ${tests.join(", ")} already pass on base ${base.slice(0, 7)} — nothing was fixed (the proof of a fix is red on base, green on head)` };
    const out = `${onBase.stdout || ""}\n${onBase.stderr || ""}`;
    if (inconclusiveOnBase(out)) return { ok: false, misconfigured: true, inconclusive: [...tests], detail: `fixes_tests: the listed tests did not run on base ${base.slice(0, 7)} (module resolution / import error) — inconclusive` };
    const onHead = await run("bash", ["-lc", cmd], { cwd });
    if (onHead.code !== 0) return { ok: false, detail: `fixes_tests: ${tests.join(", ")} are red on base ${base.slice(0, 7)} (exit ${onBase.code}) but still red on head (exit ${onHead.code}) — not fixed` };
    return { ok: true, detail: `fixed ${tests.length} existing test file(s): ${tests.join(", ")} — red on base ${base.slice(0, 7)} (exit ${onBase.code}), green on head` };
  } finally {
    await g(["worktree", "remove", "--force", tmp]);
  }
}
