# Factory Plan 1b — L1 Gates & Proof Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에이전트 프로세스 밖에서 실행되는 결정적 게이트 — `gates`(harness.toml 명령 실행 + 한 줄 판정 + fail-closed), `prove-test`, 새 테스트 반복, diff coverage, incremental mutation, flaky 분류(`classify-failure`), 격리(`quarantine`), `integrity`, `sweeper` — 를 구현해 Plan 1a의 `run-stage`에 연결한다. 이 계획이 끝나면 implement/review/merge 스테이지의 판정이 에이전트의 말이 아니라 파일에서 나온다.

**Architecture:** Plan 1a와 같은 구조(`factory/lib/*.js` 순수 모듈 + `factory/bin/*.js` CLI + `factory/hooks/*.sh`), 모든 외부 프로세스는 주입된 `run()`. 게이트 결과는 `.factory/out/gates.json`(기계) + 한 줄 `FACTORY_GATES: …`(사람·로그). `run-stage`의 `d.gates()`가 이 모듈을 호출하고, `verify-stage`·`requirements`는 handoff의 `gates` 필드 대신 **파일**을 신뢰한다. 테스트 도구 의존성(vitest/playwright/stryker)은 `harness.toml`의 명령 문자열로 추상화하고, 파서만 도구별로 둔다(vitest JSON reporter, istanbul `coverage-final.json`, Stryker `mutation.json`; 그 외는 stdout 마커).

**Tech Stack:** Node ≥22 ESM, `smol-toml`(기존), vitest, git worktree, bash + jq(훅), `gh`.

**Spec:** §4.2.1 step 5·6 (gates는 에이전트 밖, verify는 파일만), §5.1 `harness.toml [commands] [gates] [gates.thresholds] [test]`, §5.2.4 증명 게이트, §5.2.5 flaky 5단계, §5.3 CHARTER hard limits·back_pressure, §6.1 L0 integrity, §6.2 L1 스크립트 목록, §4.3 sweeper. ADR-004(러너 자원), ADR-009(로깅 훅 exit 0, yml 관례).

## Global Constraints

- Plan 1a의 제약 전부 상속: Node ≥22 ESM, 런타임 의존성 `smol-toml`만, `run()` 주입, 테스트는 프로세스를 실제로 띄우지 않음(예외: 훅 테스트의 bash, git 테스트의 임시 repo).
- **게이트 판정은 파일이 진실이다.** `.factory/out/gates.json`이 없거나 `status !== "GREEN"`이면 implement→awaiting-review 전이 거부. handoff 안의 `gates` 필드는 파일 내용을 **복사**한 것이어야 하며 다르면 verify-stage가 거부한다.
- **재시도로 GREEN을 만들지 않는다.** 재실행은 오직 `classify-failure`의 분류 목적(격리 3회·base 5회·새 테스트 3회)이며, 그 결과는 판정에 "제외" 또는 "귀책"으로만 반영된다.
- fail-closed: `[gates].required`에 있는 게이트가 현재 레벨의 명령 목록·`[commands]`에 없으면 `MISCONFIGURED`(exit 2). 성숙도(`[harness].maturity`)가 허용하지 않는 레벨은 그 성숙도의 최고 레벨로 강등하고 gates.json에 `downgraded_from`을 기록한다.
- 판정 한 줄 형식(고정): `FACTORY_GATES: level=<fast|full|deep> status=<GREEN|RED|MISCONFIGURED> passed=<n> failed=<n> failing=<a,b|none> skipped=<a,b|none> misconfigured=<a,b|none> excluded=<test ids|none>`.
- 임계값·반복 횟수는 전부 `harness.toml [gates.thresholds]`에서 읽는다: `diff_coverage_pct`(90), `mutation_score_pct`(70), `new_test_repeats`(3), `flaky_isolation_runs`(3), `flaky_base_runs`(5), `quarantine_max`(5), `quarantine_ttl_days`(28), `quarantine_return_after`(30). 코드에 숫자를 박지 않는다(기본값은 `config.js`의 defaults에만).
- 도구별 파서는 `lib/parsers/*.js`에 격리한다: `vitest-json.js`, `istanbul-json.js`, `stryker-json.js`, `marker.js`(stdout `KEY=value`). 새 도구 지원 = 파서 파일 1개.
- 훅: 판정 훅(`lint-touched.sh`는 **로깅형** — exit 0, `verdict-format.sh`는 판정형 — exit 2 가능). 둘 다 stdin JSON.
- 커밋은 `know_thy_build`의 `spec/factory-1.0`에, push 금지. TDD, 모듈당 테스트 파일 1개.

---

## File Structure

```
factory/
├── lib/
│   ├── parsers/
│   │   ├── vitest-json.js       # parseVitestJson(text) → {total, passed, failed, failing:[{id, file, name}]}
│   │   ├── istanbul-json.js     # coveredLines(json) → Map<file, Set<line>>
│   │   ├── stryker-json.js      # mutationScore(json) → {killed, survived, timeout, noCoverage, score}
│   │   └── marker.js            # parseMarkers(stdout) → {KEY: value}
│   ├── changed-files.js         # changedFiles({run,cwd,base}) → {all, tests, sources, addedTests}; changedLines({run,cwd,base}) → Map<file, Set<line>>
│   ├── gates.js                 # runGates({run,cwd,harness,charter,level,base,head,quarantine}) → gatesResult; verdictLine(result)
│   ├── prove-test.js            # proveTest({run,cwd,harness,base,addedTests}) → {ok, detail}
│   ├── repeat-tests.js          # repeatNewTests({run,cwd,harness,addedTests,times}) → {ok, runs:[...]}
│   ├── diff-coverage.js         # diffCoverage({changedLines, covered, threshold}) → {pct, ok, uncovered:[...]}
│   ├── mutation.js              # mutationGate({run,cwd,harness,changedSources,threshold}) → {score, ok, detail}
│   ├── quarantine.js            # loadQuarantine/saveQuarantine/isQuarantined/recordResult/applyPolicy
│   ├── classify-failure.js      # classifyFailures({run,cwd,harness,failing,base,thresholds}) → [{id, verdict: "red"|"introduced"|"flaky-existing", evidence}]
│   ├── integrity.js             # integrityCheck({run,cwd,base,head,harness}) → {ok, violations:[...]}
│   ├── back-pressure.js         # backPressure({gh, charter, quarantine}) → {ok, reasons}
│   └── sweeper.js               # sweep({gh, run, cwd, charter, now}) → actions[]
├── bin/
│   ├── gates.js                 # gates <level> [--base <sha>] → writes .factory/out/gates.json, prints verdict line, exit 0|1|2
│   ├── prove-test.js
│   ├── classify-failure.js
│   ├── integrity.js             # exit 0|1 (required check용)
│   ├── sweep.js
│   └── run-stage.js             # (수정) d.gates 실제 연결, back-pressure, 파일 기반 requirements
├── hooks/
│   ├── lint-touched.sh          # PostToolUse(Edit|Write): [commands].lint_file 실행, 결과를 stderr로 (exit 0)
│   └── verdict-format.sh        # SubagentStop(reviewer-*|factory-verifier): 마지막 메시지에 ```json 없으면 exit 2
└── test/ (모듈당 1개 + 픽스처 factory/test/fixtures/*.json)
```

`harness.toml`에 이 계획이 추가로 요구하는 키(§5.1에 반영, Task 14):
```toml
[commands]
test_files = "pnpm vitest run --reporter=json --outputFile=.factory/out/test-files.json {files}"   # 새 테스트만
test_one   = "pnpm vitest run --reporter=json --outputFile=.factory/out/test-one.json {file} -t {name}"
lint_file  = "pnpm eslint {file}"
[commands.proof]
coverage        = "pnpm vitest run --coverage --coverage.reporter=json --coverage.reportsDirectory=.factory/out/coverage"
coverage_report = ".factory/out/coverage/coverage-final.json"
mutation        = "pnpm stryker run --incremental --mutate {files} --reporters json"
mutation_report = "reports/mutation/mutation.json"
[test]
test_glob   = ["test/**/*.test.*", "e2e/**/*.spec.*"]
source_glob = ["src/**/*.{ts,js}"]
unit_report = ".factory/out/unit.json"            # [commands].unit이 남기는 vitest JSON
[test.env]
services_check = "docker compose -f docker-compose.test.yml ps --status running -q"
```

---

### Task 1: 이월 항목 — `assert-handoff.js` issue 바인딩, `stop-guard` pathspec, `config` defaults 확장

**Files:**
- Modify: `factory/bin/assert-handoff.js`, `factory/hooks/stop-guard.sh`, `factory/lib/config.js`, `factory/test/hooks.test.js`, `factory/test/config.test.js`

**Interfaces:**
- Produces: `loadHarness(root)`가 `thresholds`·`test`·`commands.proof` 기본값을 채운 객체를 돌려준다: `harness.gates.thresholds = {diff_coverage_pct:90, mutation_score_pct:70, new_test_repeats:3, flaky_isolation_runs:3, flaky_base_runs:5, quarantine_max:5, quarantine_ttl_days:28, quarantine_return_after:30, ...toml}`; `harness.test = {test_glob:[], source_glob:[], unit_report:".factory/out/unit.json", ...toml}`; `harness.commands.proof = {...toml}`.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/config.test.js`에 추가:
```js
test("loadHarness fills gates.thresholds / test / commands.proof defaults and keeps overrides", () => {
  const root = fixture();
  const h = loadHarness(root);
  expect(h.gates.thresholds).toEqual({ diff_coverage_pct: 90, mutation_score_pct: 70, new_test_repeats: 3, flaky_isolation_runs: 3, flaky_base_runs: 5, quarantine_max: 5, quarantine_ttl_days: 28, quarantine_return_after: 30 });
  expect(h.test.unit_report).toBe(".factory/out/unit.json");
  expect(h.test.test_glob).toEqual([]);
  expect(h.commands.proof).toEqual({});
  writeFileSync(join(root, ".factory/harness.toml"), readFileSync(join(root, ".factory/harness.toml"), "utf8") + `\n[gates.thresholds]\ndiff_coverage_pct = 80\n[test]\ntest_glob = ["test/**/*.test.js"]\n`);
  const h2 = loadHarness(root);
  expect(h2.gates.thresholds.diff_coverage_pct).toBe(80);
  expect(h2.gates.thresholds.mutation_score_pct).toBe(70);
  expect(h2.test.test_glob).toEqual(["test/**/*.test.js"]);
});
```
`factory/test/hooks.test.js`의 stop-guard 테스트에 추가: 서브디렉토리 `sub/`에서 실행해도 루트의 dirty 파일이 잡히는지:
```js
  // dirty file at root, hook run from a subdirectory → still blocked
  await run("bash", ["-c", "mkdir -p sub && echo y > root-dirty.txt"], { cwd });
  const r3 = await run("bash", [join(H, "stop-guard.sh")], { input: "{}", cwd: join(cwd, "sub") });
  expect(r3.code).toBe(2);
```
(이 케이스는 upstream이 없는 상태이므로 "uncommitted"에서 이미 2가 나와야 한다 — 현재 `-- .`는 `sub/`만 보므로 실패한다.)

- [ ] **Step 2: 실패 확인** — config 1건, hooks 1건 FAIL.

- [ ] **Step 3: 구현**

`factory/lib/config.js`의 `loadHarness`:
```js
export const THRESHOLD_DEFAULTS = { diff_coverage_pct: 90, mutation_score_pct: 70, new_test_repeats: 3, flaky_isolation_runs: 3, flaky_base_runs: 5, quarantine_max: 5, quarantine_ttl_days: 28, quarantine_return_after: 30 };
export function loadHarness(root) {
  const h = parseToml(readFileSync(join(root, ".factory/harness.toml"), "utf8"));
  h.gates ??= {}; h.gates.thresholds = { ...THRESHOLD_DEFAULTS, ...(h.gates.thresholds || {}) };
  h.test = { test_glob: [], source_glob: [], unit_report: ".factory/out/unit.json", ...(h.test || {}) };
  h.commands ??= {}; h.commands.proof = { ...(h.commands.proof || {}) };
  return h;
}
```
`factory/hooks/stop-guard.sh` 7행: `git status --porcelain -- ':(top)' ':(exclude,top).factory/out'`.
`factory/bin/assert-handoff.js`: `requirementFor(target)({ comments, issue })` (issue를 Number로 넘김).

- [ ] **Step 4: 통과·커밋** — `git commit -m "fix(factory): carry-overs from plan 1a review (assert-handoff issue binding, stop-guard top pathspec, harness defaults)"`

---

### Task 2: 파서 4종 — `lib/parsers/*`

**Interfaces:**
- `parseVitestJson(text) → {total, passed, failed, failing: [{id, file, name}]}` — id는 `${file}::${fullName}`. vitest JSON reporter 형식: `{numTotalTests, numPassedTests, numFailedTests, testResults:[{name:<file>, assertionResults:[{fullName, status:"passed"|"failed"|"skipped"}]}]}`.
- `coveredLines(json) → Map<file, Set<line>>` — istanbul `coverage-final.json`: `{ [file]: { statementMap: {id:{start:{line}, end:{line}}}, s: {id: count} } }`; count>0인 statement의 start..end 줄을 covered로.
- `mutationScore(json) → {killed, survived, timeout, noCoverage, total, score}` — Stryker `mutation.json`: `{files: {[f]: {mutants:[{status:"Killed"|"Survived"|"Timeout"|"NoCoverage"|"RuntimeError"|"CompileError"|"Ignored"}]}}}`; score = killed+timeout / (killed+timeout+survived+noCoverage) × 100 (Stryker 정의).
- `parseMarkers(stdout) → {KEY: "value"}` — `^[A-Z_]+=.*$` 줄.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/parsers.test.js`:
```js
import { test, expect } from "vitest";
import { parseVitestJson } from "../lib/parsers/vitest-json.js";
import { coveredLines } from "../lib/parsers/istanbul-json.js";
import { mutationScore } from "../lib/parsers/stryker-json.js";
import { parseMarkers } from "../lib/parsers/marker.js";

test("vitest json → failing ids", () => {
  const j = { numTotalTests: 3, numPassedTests: 2, numFailedTests: 1, testResults: [
    { name: "/repo/test/a.test.js", assertionResults: [{ fullName: "a works", status: "passed" }, { fullName: "a edge", status: "failed" }] },
    { name: "/repo/test/b.test.js", assertionResults: [{ fullName: "b", status: "passed" }] } ] };
  const r = parseVitestJson(JSON.stringify(j), "/repo");
  expect(r).toEqual({ total: 3, passed: 2, failed: 1, failing: [{ id: "test/a.test.js::a edge", file: "test/a.test.js", name: "a edge" }] });
  expect(parseVitestJson("not json", "/repo")).toEqual({ total: 0, passed: 0, failed: 0, failing: [], error: "unparseable" });
});

test("istanbul coverage-final → covered lines per file (repo-relative)", () => {
  const j = { "/repo/src/x.js": { statementMap: { "0": { start: { line: 3 }, end: { line: 4 } }, "1": { start: { line: 9 }, end: { line: 9 } } }, s: { "0": 2, "1": 0 } } };
  const m = coveredLines(j, "/repo");
  expect([...m.get("src/x.js")].sort()).toEqual([3, 4]);
});

test("stryker mutation.json → score", () => {
  const j = { files: { "src/x.js": { mutants: [{ status: "Killed" }, { status: "Killed" }, { status: "Survived" }, { status: "Timeout" }, { status: "NoCoverage" }, { status: "Ignored" }, { status: "CompileError" }] } } };
  expect(mutationScore(j)).toEqual({ killed: 2, timeout: 1, survived: 1, noCoverage: 1, total: 5, score: 60 });
  expect(mutationScore({ files: {} }).score).toBe(null);
});

test("markers", () => {
  expect(parseMarkers("noise\nMUTATION_SCORE=72.5\nFOO=bar baz\nlower=no\n")).toEqual({ MUTATION_SCORE: "72.5", FOO: "bar baz" });
});
```

- [ ] **Step 2: 실패 확인** — module not found ×4.

- [ ] **Step 3: 구현**

`factory/lib/parsers/vitest-json.js`:
```js
import { relative } from "node:path";
export function parseVitestJson(text, root = process.cwd()) {
  let j; try { j = JSON.parse(text); } catch { return { total: 0, passed: 0, failed: 0, failing: [], error: "unparseable" }; }
  const failing = [];
  for (const tr of j.testResults || []) {
    const file = relative(root, tr.name);
    for (const a of tr.assertionResults || []) if (a.status === "failed") failing.push({ id: `${file}::${a.fullName}`, file, name: a.fullName });
  }
  return { total: j.numTotalTests ?? 0, passed: j.numPassedTests ?? 0, failed: j.numFailedTests ?? failing.length, failing };
}
```
`factory/lib/parsers/istanbul-json.js`:
```js
import { relative, isAbsolute } from "node:path";
export function coveredLines(json, root = process.cwd()) {
  const m = new Map();
  for (const [file, cov] of Object.entries(json)) {
    const rel = isAbsolute(file) ? relative(root, file) : file;
    const set = new Set();
    for (const [id, loc] of Object.entries(cov.statementMap || {})) {
      if ((cov.s?.[id] ?? 0) > 0) for (let l = loc.start.line; l <= (loc.end?.line ?? loc.start.line); l++) set.add(l);
    }
    m.set(rel, set);
  }
  return m;
}
```
`factory/lib/parsers/stryker-json.js`:
```js
export function mutationScore(json) {
  let killed = 0, survived = 0, timeout = 0, noCoverage = 0;
  for (const f of Object.values(json.files || {})) for (const m of f.mutants || []) {
    if (m.status === "Killed") killed++; else if (m.status === "Survived") survived++;
    else if (m.status === "Timeout") timeout++; else if (m.status === "NoCoverage") noCoverage++;
  }
  const total = killed + survived + timeout + noCoverage;
  return { killed, timeout, survived, noCoverage, total, score: total ? Math.round(((killed + timeout) / total) * 1000) / 10 : null };
}
```
`factory/lib/parsers/marker.js`:
```js
export function parseMarkers(stdout) {
  const out = {};
  for (const line of String(stdout).split("\n")) { const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim()); if (m) out[m[1]] = m[2]; }
  return out;
}
```

- [ ] **Step 4: 통과·커밋** — `git commit -m "feat(factory): result parsers (vitest json, istanbul, stryker, markers)"`

---

### Task 3: `lib/changed-files.js` — 변경 파일·줄 (git diff)

**Interfaces:**
- `changedFiles({run, cwd, base, head = "HEAD", harness}) → {all, added, tests, sources, addedTests}` — `git diff --name-status base...head`; `tests`/`sources`는 `harness.test.test_glob`/`source_glob`으로 분류(간단 glob: `**`, `*`, `{a,b}` 지원 — `lib/glob.js`로 분리).
- `changedLines({run, cwd, base, head}) → Map<file, Set<line>>` — `git diff -U0 base...head`의 `+++ b/<file>`와 `@@ -a,b +c,d @@` 헤더에서 추가·수정 줄 계산.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/changed-files.test.js`:
```js
import { test, expect } from "vitest";
import { changedFiles, changedLines } from "../lib/changed-files.js";
import { globToRegex } from "../lib/glob.js";
import { makeFakeRun } from "../lib/exec.js";

const harness = { test: { test_glob: ["test/**/*.test.js", "e2e/**/*.spec.{js,ts}"], source_glob: ["src/**/*.js"] } };

test("globToRegex handles **, *, {a,b}", () => {
  expect(globToRegex("test/**/*.test.js").test("test/a/b/c.test.js")).toBe(true);
  expect(globToRegex("test/**/*.test.js").test("src/c.test.js")).toBe(false);
  expect(globToRegex("e2e/**/*.spec.{js,ts}").test("e2e/x.spec.ts")).toBe(true);
  expect(globToRegex("src/**/*.js").test("src/a.js")).toBe(true);
});

test("changedFiles classifies by status and globs", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "diff" && a.includes("--name-status"), result: { code: 0, stdout: "A\ttest/new.test.js\nM\tsrc/a.js\nM\ttest/old.test.js\nA\tdocs/x.md\nD\tsrc/gone.js\n", stderr: "" } }]);
  const r = await changedFiles({ run, cwd: "/repo", base: "abc", harness });
  expect(r.all).toEqual(["test/new.test.js", "src/a.js", "test/old.test.js", "docs/x.md", "src/gone.js"]);
  expect(r.added).toEqual(["test/new.test.js", "docs/x.md"]);
  expect(r.tests).toEqual(["test/new.test.js", "test/old.test.js"]);
  expect(r.addedTests).toEqual(["test/new.test.js"]);
  expect(r.sources).toEqual(["src/a.js", "src/gone.js"]);
  expect(run.calls[0].args).toEqual(["diff", "--name-status", "abc...HEAD"]);
});

test("changedLines parses -U0 hunks (added/modified lines only)", async () => {
  const diff = `diff --git a/src/a.js b/src/a.js
--- a/src/a.js
+++ b/src/a.js
@@ -10,0 +11,2 @@
+x
+y
@@ -20 +22 @@
-old
+new
diff --git a/src/gone.js b/src/gone.js
--- a/src/gone.js
+++ /dev/null
@@ -1,3 +0,0 @@
-a
-b
-c
`;
  const run = makeFakeRun([{ match: (c, a) => a[0] === "diff" && a.includes("-U0"), result: { code: 0, stdout: diff, stderr: "" } }]);
  const m = await changedLines({ run, cwd: "/repo", base: "abc" });
  expect([...m.get("src/a.js")].sort((a, b) => a - b)).toEqual([11, 12, 22]);
  expect(m.has("src/gone.js")).toBe(false);
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/glob.js`:
```js
/** 최소 glob → RegExp: ** (any dirs), * (no slash), ? , {a,b} */
export function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") { if (glob[i + 1] === "*") { re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += glob[i + 2] === "/" ? 2 : 1; } else re += "[^/]*"; }
    else if (ch === "?") re += "[^/]";
    else if (ch === "{") { const end = glob.indexOf("}", i); re += "(?:" + glob.slice(i + 1, end).split(",").map(escape).join("|") + ")"; i = end; }
    else re += escape(ch);
  }
  return new RegExp("^" + re + "$");
}
const escape = (s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&");
export const matchesAny = (globs, file) => globs.some((g) => globToRegex(g).test(file));
```
`factory/lib/changed-files.js`:
```js
import { matchesAny } from "./glob.js";
export async function changedFiles({ run, cwd, base, head = "HEAD", harness }) {
  const r = await run("git", ["diff", "--name-status", `${base}...${head}`], { cwd });
  if (r.code !== 0) throw new Error(`git diff failed: ${r.stderr}`);
  const rows = r.stdout.split("\n").filter(Boolean).map((l) => { const [status, ...rest] = l.split("\t"); return { status: status[0], file: rest[rest.length - 1] }; });
  const all = rows.map((x) => x.file), added = rows.filter((x) => x.status === "A").map((x) => x.file);
  const tests = all.filter((f) => matchesAny(harness.test.test_glob, f));
  const sources = all.filter((f) => matchesAny(harness.test.source_glob, f));
  return { all, added, tests, sources, addedTests: added.filter((f) => tests.includes(f)) };
}
export async function changedLines({ run, cwd, base, head = "HEAD" }) {
  const r = await run("git", ["diff", "-U0", `${base}...${head}`], { cwd });
  if (r.code !== 0) throw new Error(`git diff failed: ${r.stderr}`);
  const m = new Map(); let file = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("+++ ")) { file = line.startsWith("+++ b/") ? line.slice(6) : null; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) { const start = Number(h[1]), count = h[2] === undefined ? 1 : Number(h[2]); if (!m.has(file)) m.set(file, new Set()); for (let i = 0; i < count; i++) m.get(file).add(start + i); }
  }
  return m;
}
```

- [ ] **Step 4: 통과·커밋** — `git commit -m "feat(factory): changed files/lines from git diff, minimal glob"`

---

### Task 4: `lib/quarantine.js` — 격리 상태 파일과 정책

**Interfaces:**
- 파일 `.factory/quarantine.toml`(스크립트만 씀):
```toml
[[quarantined]]
id = "test/sync.test.js::handles DST"
since = "2026-09-11T00:00:00Z"
reason = "flaky-existing after K=3 fix attempts (issue #131)"
evidence = ["docs/factory/runs/131.md"]
consecutive_passes = 12
```
- `loadQuarantine(root) → {quarantined: [...]}`; `saveQuarantine(root, q)`; `isQuarantined(q, id)`; `recordResult(q, id, passed) → q'` (pass면 `consecutive_passes+1`, fail이면 0); `applyPolicy(q, {now, thresholds}) → {q', returned: [ids], expired: [ids]}` — `consecutive_passes ≥ quarantine_return_after` → 복귀(목록에서 제거, `returned`), `since + ttl_days < now` → `expired`(제거하지 않고 표시; retro가 재작성 이슈를 만든다); `overCap(q, thresholds) → bool`.
- `smol-toml`의 `stringify`로 저장.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/quarantine.test.js`:
```js
import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadQuarantine, saveQuarantine, isQuarantined, recordResult, applyPolicy, overCap } from "../lib/quarantine.js";

const T = { quarantine_max: 2, quarantine_ttl_days: 28, quarantine_return_after: 3 };
const root = () => { const r = mkdtempSync(join(tmpdir(), "q-")); mkdirSync(join(r, ".factory")); return r; };

test("missing file → empty; save/load round-trip", () => {
  const r = root();
  expect(loadQuarantine(r)).toEqual({ quarantined: [] });
  const q = { quarantined: [{ id: "t::a", since: "2026-09-01T00:00:00Z", reason: "r", evidence: ["e"], consecutive_passes: 0 }] };
  saveQuarantine(r, q);
  expect(readFileSync(join(r, ".factory/quarantine.toml"), "utf8")).toMatch(/\[\[quarantined\]\]/);
  expect(loadQuarantine(r)).toEqual(q);
  expect(isQuarantined(q, "t::a")).toBe(true); expect(isQuarantined(q, "t::b")).toBe(false);
});

test("recordResult counts consecutive passes; applyPolicy returns after N and flags TTL", () => {
  let q = { quarantined: [
    { id: "t::a", since: "2026-09-01T00:00:00Z", reason: "r", evidence: [], consecutive_passes: 2 },
    { id: "t::old", since: "2026-08-01T00:00:00Z", reason: "r", evidence: [], consecutive_passes: 0 } ] };
  q = recordResult(q, "t::a", true);
  q = recordResult(q, "t::old", false);
  const { q: q2, returned, expired } = applyPolicy(q, { now: "2026-09-11T00:00:00Z", thresholds: T });
  expect(returned).toEqual(["t::a"]);
  expect(q2.quarantined.map((x) => x.id)).toEqual(["t::old"]);
  expect(expired).toEqual(["t::old"]);
  expect(overCap(q2, T)).toBe(false);
  expect(overCap({ quarantined: [{}, {}] }, T)).toBe(true);
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/quarantine.js`:
```js
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";

const P = (root) => join(root, ".factory/quarantine.toml");
export function loadQuarantine(root) { return existsSync(P(root)) ? { quarantined: [], ...parse(readFileSync(P(root), "utf8")) } : { quarantined: [] }; }
export function saveQuarantine(root, q) { writeFileSync(P(root), stringify(q)); }
export const isQuarantined = (q, id) => q.quarantined.some((x) => x.id === id);
export function recordResult(q, id, passed) {
  return { quarantined: q.quarantined.map((x) => x.id === id ? { ...x, consecutive_passes: passed ? (x.consecutive_passes || 0) + 1 : 0 } : x) };
}
export function applyPolicy(q, { now, thresholds }) {
  const nowMs = Date.parse(now), ttlMs = thresholds.quarantine_ttl_days * 86400e3;
  const returned = q.quarantined.filter((x) => (x.consecutive_passes || 0) >= thresholds.quarantine_return_after).map((x) => x.id);
  const kept = q.quarantined.filter((x) => !returned.includes(x.id));
  const expired = kept.filter((x) => Date.parse(x.since) + ttlMs < nowMs).map((x) => x.id);
  return { q: { quarantined: kept }, returned, expired };
}
export const overCap = (q, thresholds) => q.quarantined.length >= thresholds.quarantine_max;
```

- [ ] **Step 4: 통과·커밋** — `git commit -m "feat(factory): quarantine state and policy"`

---

### Task 5: `lib/gates.js` — 레벨별 명령 실행, 판정 파일, 한 줄 verdict

**Interfaces:**
- `runGates({run, cwd, harness, level, quarantine, now}) → result` where
```js
result = { schema: "factory.gates.v1", level, requested_level, downgraded_from: null|level, status: "GREEN"|"RED"|"MISCONFIGURED",
  gates: { [name]: { status: "GREEN"|"RED"|"SKIPPED"|"MISCONFIGURED", code, duration_ms, log: "<last 2000 chars>" } },
  passed, failed, failing: [names], skipped: [names], misconfigured: [names],
  tests: { total, passed, failed, failing: [{id,file,name}], excluded: [ids] } | null, ran_at }
```
- 규칙: 레벨 `harness.gates[level]`의 각 이름에 대해 `harness.commands[name]`(또는 `harness.commands.proof[name]`)이 없으면 그 게이트 `MISCONFIGURED`; `required`에 있으면 전체 `MISCONFIGURED`. 명령 실행 exit 0 → GREEN, 아니면 RED. 이름이 `unit`/`integration`/`e2e`이고 `harness.test.<name>_report`(기본 `.factory/out/<name>.json`) 파일이 있으면 vitest JSON을 파싱해 `tests`를 채우고, **격리된 id의 실패는 `excluded`로 옮겨 그 게이트 판정에서 제외**(남은 실패 0이면 GREEN). 성숙도 강등: `M0→fast`, `M1→full`, `M2→deep`; 요청 레벨이 더 높으면 강등하고 `downgraded_from` 기록. `coverage`/`mutation` 게이트는 이 모듈에서 **실행하지 않는다**(Task 7·8이 별도 결과를 합친다); 이름이 목록에 있으면 `SKIPPED`로 두고 `merge` 단계에서 합산.
- `verdictLine(result) → string` (Global Constraints 형식).
- `readReport(cwd, path)`는 파일 읽기; 테스트에서는 `readFile` 주입.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/gates.test.js`:
```js
import { test, expect } from "vitest";
import { runGates, verdictLine } from "../lib/gates.js";
import { makeFakeRun } from "../lib/exec.js";

const harness = {
  harness: { maturity: "M1" },
  commands: { lint: "npm run lint", typecheck: "tsc", unit: "vitest run --reporter=json --outputFile=.factory/out/unit.json", integration: "vitest run --project integration", build: "npm run build", proof: { coverage: "vitest --coverage" } },
  gates: { required: ["lint", "typecheck", "unit", "integration", "build"], fast: ["lint", "typecheck", "unit"], full: ["lint", "typecheck", "unit", "integration", "build", "diff_coverage"], deep: ["lint", "typecheck", "unit", "integration", "build", "diff_coverage", "e2e"], thresholds: {} },
  test: { unit_report: ".factory/out/unit.json" },
};
const ok = { code: 0, stdout: "", stderr: "" }, bad = { code: 1, stdout: "", stderr: "boom" };
const sh = (cmd, res) => ({ match: (c, a) => c === "bash" && a[1] === cmd, result: res });

test("all GREEN → GREEN; verdict line format", async () => {
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh(harness.commands.unit, ok), sh("vitest run --project integration", ok), sh("npm run build", ok)]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "full", quarantine: { quarantined: [] }, readFile: () => null, now: "2026-09-11T00:00:00Z" });
  expect(r.status).toBe("GREEN"); expect(r.passed).toBe(5); expect(r.skipped).toEqual(["diff_coverage"]);
  expect(verdictLine(r)).toBe("FACTORY_GATES: level=full status=GREEN passed=5 failed=0 failing=none skipped=diff_coverage misconfigured=none excluded=none");
});

test("one RED → RED with failing list; log captured", async () => {
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", bad), sh(harness.commands.unit, ok), sh("vitest run --project integration", ok), sh("npm run build", ok)]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "full", quarantine: { quarantined: [] }, readFile: () => null });
  expect(r.status).toBe("RED"); expect(r.failing).toEqual(["typecheck"]); expect(r.gates.typecheck.log).toContain("boom");
});

test("required gate without a command → MISCONFIGURED (fail-closed)", async () => {
  const h = { ...harness, commands: { ...harness.commands, integration: undefined } };
  const run = makeFakeRun([{ match: () => true, result: ok }]);
  const r = await runGates({ run, cwd: "/repo", harness: h, level: "full", quarantine: { quarantined: [] }, readFile: () => null });
  expect(r.status).toBe("MISCONFIGURED"); expect(r.misconfigured).toEqual(["integration"]);
});

test("maturity downgrade: M1 asked for deep → full, recorded", async () => {
  const run = makeFakeRun([{ match: () => true, result: ok }]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "deep", quarantine: { quarantined: [] }, readFile: () => null });
  expect(r.level).toBe("full"); expect(r.requested_level).toBe("deep"); expect(r.downgraded_from).toBe("deep");
});

test("quarantined test failures are excluded from the unit verdict", async () => {
  const report = JSON.stringify({ numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, testResults: [{ name: "/repo/test/a.test.js", assertionResults: [{ fullName: "flaky one", status: "failed" }, { fullName: "solid", status: "passed" }] }] });
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh(harness.commands.unit, bad)]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "fast", quarantine: { quarantined: [{ id: "test/a.test.js::flaky one" }] }, readFile: (p) => p.endsWith("unit.json") ? report : null });
  expect(r.gates.unit.status).toBe("GREEN"); expect(r.status).toBe("GREEN");
  expect(r.tests.excluded).toEqual(["test/a.test.js::flaky one"]); expect(r.tests.failing).toEqual([]);
  expect(verdictLine(r)).toContain("excluded=test/a.test.js::flaky one");
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/gates.js`:
```js
import { parseVitestJson } from "./parsers/vitest-json.js";
import { isQuarantined } from "./quarantine.js";

const LEVELS = ["fast", "full", "deep"];
const MAX_LEVEL = { M0: "fast", M1: "full", M2: "deep" };
const PROOF_GATES = new Set(["diff_coverage", "mutation"]);          // Task 7/8가 채움
const TEST_GATES = new Set(["unit", "integration", "e2e"]);

export async function runGates({ run, cwd, harness, level, quarantine, readFile, now = new Date().toISOString() }) {
  const requested_level = level;
  const max = MAX_LEVEL[harness.harness?.maturity] || "deep";
  if (LEVELS.indexOf(level) > LEVELS.indexOf(max)) level = max;
  const names = harness.gates[level] || [];
  const gates = {}, failing = [], skipped = [], misconfigured = [];
  let tests = null;
  for (const name of names) {
    if (PROOF_GATES.has(name)) { gates[name] = { status: "SKIPPED" }; skipped.push(name); continue; }
    const cmd = harness.commands[name];
    if (!cmd) { gates[name] = { status: "MISCONFIGURED" }; misconfigured.push(name); continue; }
    const t0 = Date.now();
    const r = await run("bash", ["-lc", cmd], { cwd });
    let status = r.code === 0 ? "GREEN" : "RED";
    if (TEST_GATES.has(name)) {
      const report = readFile(`${cwd}/${harness.test[`${name}_report`] || `.factory/out/${name}.json`}`);
      if (report) {
        const parsed = parseVitestJson(report, cwd);
        const excluded = parsed.failing.filter((f) => isQuarantined(quarantine, f.id)).map((f) => f.id);
        const remaining = parsed.failing.filter((f) => !excluded.includes(f.id));
        tests = { ...(tests || { total: 0, passed: 0, failed: 0, failing: [], excluded: [] }) };
        tests.total += parsed.total; tests.passed += parsed.passed; tests.failed += remaining.length;
        tests.failing.push(...remaining); tests.excluded.push(...excluded);
        if (status === "RED" && remaining.length === 0 && parsed.failed > 0) status = "GREEN";   // 실패가 전부 격리 대상
      }
    }
    gates[name] = { status, code: r.code, duration_ms: Date.now() - t0, log: (r.stderr + r.stdout).slice(-2000) };
    if (status === "RED") failing.push(name);
  }
  const requiredMissing = (harness.gates.required || []).filter((n) => misconfigured.includes(n));
  const status = requiredMissing.length ? "MISCONFIGURED" : failing.length ? "RED" : "GREEN";
  const passed = Object.values(gates).filter((g) => g.status === "GREEN").length;
  return { schema: "factory.gates.v1", level, requested_level, downgraded_from: level === requested_level ? null : requested_level, status, gates, passed, failed: failing.length, failing, skipped, misconfigured, tests, ran_at: now };
}

const list = (a) => (a && a.length ? a.join(",") : "none");
export function verdictLine(r) {
  return `FACTORY_GATES: level=${r.level} status=${r.status} passed=${r.passed} failed=${r.failed} failing=${list(r.failing)} skipped=${list(r.skipped)} misconfigured=${list(r.misconfigured)} excluded=${list(r.tests?.excluded)}`;
}
```

- [ ] **Step 4: 통과·커밋** — `git commit -m "feat(factory): gates runner with fail-closed, maturity downgrade, quarantine exclusion"`

---

### Task 6: `lib/prove-test.js` + `lib/repeat-tests.js` — 테스트가 수정을 증명하는가, 새 테스트는 결정적인가

**Interfaces:**
- `proveTest({run, cwd, harness, base, addedTests}) → {ok, detail, skipped?}`: `addedTests`가 비면 `{ok: true, skipped: "no new tests"}` — **아니다**: §5.2.4 "이슈당 done_when 수 ≤ 새 테스트 수"이므로 새 테스트가 없으면 `{ok:false, detail:"no new tests"}` (docs tier 예외는 호출자가 처리). 절차: `git worktree add <tmp> <base>` → 새 테스트 파일을 tmp로 복사(`cp`는 `run`으로) → tmp에서 `harness.commands.test_files`의 `{files}` 치환 명령 실행 → **exit≠0이어야 ok** → `git worktree remove --force <tmp>`. base에 없는 import 때문에 실패하는 것도 "실패"이므로 통과로 본다(보수적으로 허용, detail에 기록).
- `repeatNewTests({run, cwd, harness, addedTests, times, fullSuiteCmd}) → {ok, runs:[{code}], detail}`: `times`회 `test_files` 명령을 실행하되, **첫 회는 전체 스위트(`fullSuiteCmd`, 보통 `commands.unit`)를 동시에 띄운 채** 실행(시끄러운 조건). 한 번이라도 exit≠0이면 `{ok:false}`.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/prove-test.test.js`:
```js
import { test, expect } from "vitest";
import { proveTest, repeatNewTests } from "../lib/prove-test.js";
import { makeFakeRun } from "../lib/exec.js";

const harness = { commands: { test_files: "vitest run {files}", unit: "vitest run" } };
const wt = (res) => ({ match: (c, a) => c === "git" && a[0] === "worktree", result: res });
const ok = { code: 0, stdout: "", stderr: "" }, fail = { code: 1, stdout: "", stderr: "FAIL" };

test("proveTest ok when new tests FAIL on base", async () => {
  const run = makeFakeRun([wt(ok), { match: (c) => c === "cp", result: ok }, { match: (c, a) => c === "bash" && a[1].includes("vitest run test/new.test.js"), result: fail }]);
  const r = await proveTest({ run, cwd: "/repo", harness, base: "abc", addedTests: ["test/new.test.js"], tmp: "/tmp/wt" });
  expect(r.ok).toBe(true);
  expect(run.calls.some((c) => c.cmd === "git" && c.args.join(" ") === "worktree add --detach /tmp/wt abc")).toBe(true);
  expect(run.calls.at(-1).args.join(" ")).toBe("worktree remove --force /tmp/wt");
});

test("proveTest NOT ok when new tests PASS on base (test proves nothing)", async () => {
  const run = makeFakeRun([wt(ok), { match: (c) => c === "cp", result: ok }, { match: (c) => c === "bash", result: ok }]);
  const r = await proveTest({ run, cwd: "/repo", harness, base: "abc", addedTests: ["test/new.test.js"], tmp: "/tmp/wt" });
  expect(r.ok).toBe(false); expect(r.detail).toMatch(/passed on base/);
});

test("proveTest fails when there are no new tests", async () => {
  const r = await proveTest({ run: makeFakeRun([]), cwd: "/repo", harness, base: "abc", addedTests: [] });
  expect(r.ok).toBe(false); expect(r.detail).toMatch(/no new tests/);
});

test("repeatNewTests runs N times, first alongside the full suite; any failure → not ok", async () => {
  let n = 0;
  const run = makeFakeRun([
    { match: (c, a) => c === "bash" && a[1] === "vitest run", result: ok },
    { match: (c, a) => c === "bash" && a[1].includes("{files}") === false && a[1].includes("test/new.test.js"), result: () => (++n === 2 ? fail : ok) },
  ]);
  const r = await repeatNewTests({ run, cwd: "/repo", harness, addedTests: ["test/new.test.js"], times: 3 });
  expect(r.ok).toBe(false); expect(r.runs.map((x) => x.code)).toEqual([0, 1, 0]);
  expect(run.calls.filter((c) => c.args[1] === "vitest run")).toHaveLength(1);
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/prove-test.js`:
```js
export async function proveTest({ run, cwd, harness, base, addedTests, tmp = `${cwd}/.factory/out/prove-wt` }) {
  if (!addedTests?.length) return { ok: false, detail: "no new tests in this change (done_when must be backed by new tests)" };
  const g = (args) => run("git", args, { cwd });
  const add = await g(["worktree", "add", "--detach", tmp, base]);
  if (add.code !== 0) return { ok: false, detail: `worktree add failed: ${add.stderr}` };
  try {
    for (const f of addedTests) {
      const mk = await run("bash", ["-lc", `mkdir -p "$(dirname "${tmp}/${f}")"`], { cwd });
      if (mk.code !== 0) return { ok: false, detail: `mkdir failed for ${f}` };
      const cp = await run("cp", [`${cwd}/${f}`, `${tmp}/${f}`]);
      if (cp.code !== 0) return { ok: false, detail: `copy failed for ${f}: ${cp.stderr}` };
    }
    const cmd = harness.commands.test_files.replace("{files}", addedTests.join(" "));
    const r = await run("bash", ["-lc", cmd], { cwd: tmp });
    if (r.code === 0) return { ok: false, detail: `new tests passed on base ${base.slice(0, 7)} — they do not prove the change` };
    return { ok: true, detail: `new tests fail on base (exit ${r.code})` };
  } finally {
    await g(["worktree", "remove", "--force", tmp]);
  }
}

export async function repeatNewTests({ run, cwd, harness, addedTests, times, fullSuiteCmd = harness.commands.unit }) {
  if (!addedTests?.length) return { ok: true, runs: [], detail: "no new tests" };
  const cmd = harness.commands.test_files.replace("{files}", addedTests.join(" "));
  const runs = [];
  for (let i = 0; i < times; i++) {
    const noisy = i === 0 && fullSuiteCmd ? run("bash", ["-lc", fullSuiteCmd], { cwd }) : null;
    const r = await run("bash", ["-lc", cmd], { cwd });
    if (noisy) await noisy;
    runs.push({ code: r.code });
  }
  const ok = runs.every((r) => r.code === 0);
  return { ok, runs, detail: ok ? `${times}/${times} passes` : `non-deterministic: exit codes ${runs.map((r) => r.code).join(",")}` };
}
```
테스트의 두 번째 매처는 `{files}`가 치환된 명령만 잡는다(치환 전 문자열은 실행되지 않음).

- [ ] **Step 4: 통과·커밋** — `git commit -m "feat(factory): prove-test (fail-on-base) and noisy repeat of new tests"`

---

### Task 7: `lib/diff-coverage.js`

**Interfaces:**
- `diffCoverage({changedLines, covered, threshold, sourceFilter}) → {pct, ok, total, coveredCount, uncovered: [{file, lines:[...]}]}` — `changedLines`(Task 3)에서 `sourceFilter(file)`가 참인 파일만 대상; `covered`(Task 2 istanbul)에 있는 줄 수/전체. 대상 줄이 0이면 `{pct: 100, ok: true, total: 0}`.
- `runDiffCoverage({run, cwd, harness, base, readFile}) → 위 결과 + {command_code}` — `harness.commands.proof.coverage` 실행 후 `coverage_report` 파일을 읽어 계산.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/diff-coverage.test.js`:
```js
import { test, expect } from "vitest";
import { diffCoverage } from "../lib/diff-coverage.js";

test("computes % of changed source lines executed; lists uncovered", () => {
  const changed = new Map([["src/a.js", new Set([1, 2, 3, 4])], ["test/a.test.js", new Set([9])], ["src/b.js", new Set([7])]]);
  const covered = new Map([["src/a.js", new Set([1, 2, 3])], ["src/b.js", new Set()]]);
  const r = diffCoverage({ changedLines: changed, covered, threshold: 80, sourceFilter: (f) => f.startsWith("src/") });
  expect(r.total).toBe(5); expect(r.coveredCount).toBe(3); expect(r.pct).toBe(60); expect(r.ok).toBe(false);
  expect(r.uncovered).toEqual([{ file: "src/a.js", lines: [4] }, { file: "src/b.js", lines: [7] }]);
});
test("no changed source lines → 100%, ok", () => {
  expect(diffCoverage({ changedLines: new Map(), covered: new Map(), threshold: 90, sourceFilter: () => true })).toMatchObject({ pct: 100, ok: true, total: 0 });
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/diff-coverage.js`:
```js
import { coveredLines } from "./parsers/istanbul-json.js";
import { changedLines } from "./changed-files.js";
import { matchesAny } from "./glob.js";

export function diffCoverage({ changedLines: changed, covered, threshold, sourceFilter }) {
  let total = 0, coveredCount = 0; const uncovered = [];
  for (const [file, lines] of changed) {
    if (!sourceFilter(file)) continue;
    const cov = covered.get(file) || new Set(); const miss = [];
    for (const l of lines) { total++; if (cov.has(l)) coveredCount++; else miss.push(l); }
    if (miss.length) uncovered.push({ file, lines: miss.sort((a, b) => a - b) });
  }
  const pct = total === 0 ? 100 : Math.round((coveredCount / total) * 1000) / 10;
  return { pct, ok: pct >= threshold, total, coveredCount, uncovered };
}

export async function runDiffCoverage({ run, cwd, harness, base, readFile }) {
  const cmd = harness.commands.proof.coverage, report = harness.commands.proof.coverage_report;
  if (!cmd || !report) return { ok: false, misconfigured: true, detail: "commands.proof.coverage / coverage_report missing" };
  const r = await run("bash", ["-lc", cmd], { cwd });
  const text = readFile(`${cwd}/${report}`);
  if (!text) return { ok: false, detail: `coverage report not found at ${report}`, command_code: r.code };
  const changed = await changedLines({ run, cwd, base });
  const res = diffCoverage({ changedLines: changed, covered: coveredLines(JSON.parse(text), cwd), threshold: harness.gates.thresholds.diff_coverage_pct, sourceFilter: (f) => matchesAny(harness.test.source_glob, f) });
  return { ...res, command_code: r.code, threshold: harness.gates.thresholds.diff_coverage_pct };
}
```

- [ ] **Step 4: 통과·커밋** — `git commit -m "feat(factory): diff coverage gate"`

---

### Task 8: `lib/mutation.js`

**Interfaces:**
- `mutationGate({run, cwd, harness, changedSources, readFile}) → {score, ok, threshold, detail, misconfigured?}` — `changedSources`가 비면 `{ok:true, score:null, detail:"no changed sources"}`; `harness.commands.proof.mutation`의 `{files}` 치환 후 실행; `mutation_report`가 있으면 Stryker 파서, 없으면 stdout 마커 `MUTATION_SCORE`; 둘 다 없으면 `misconfigured`.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/mutation.test.js`:
```js
import { test, expect } from "vitest";
import { mutationGate } from "../lib/mutation.js";
import { makeFakeRun } from "../lib/exec.js";

const H = (proof) => ({ commands: { proof }, gates: { thresholds: { mutation_score_pct: 70 } } });
const report = JSON.stringify({ files: { "src/a.js": { mutants: [{ status: "Killed" }, { status: "Killed" }, { status: "Killed" }, { status: "Survived" }] } } });

test("stryker report → score vs threshold", async () => {
  const run = makeFakeRun([{ match: (c, a) => c === "bash" && a[1].includes("src/a.js"), result: { code: 0, stdout: "", stderr: "" } }]);
  const r = await mutationGate({ run, cwd: "/repo", harness: H({ mutation: "stryker run --mutate {files}", mutation_report: "reports/mutation/mutation.json" }), changedSources: ["src/a.js"], readFile: () => report });
  expect(r).toMatchObject({ score: 75, ok: true, threshold: 70 });
});
test("marker fallback and threshold failure", async () => {
  const run = makeFakeRun([{ match: (c) => c === "bash", result: { code: 0, stdout: "MUTATION_SCORE=55\n", stderr: "" } }]);
  const r = await mutationGate({ run, cwd: "/repo", harness: H({ mutation: "mutmut run --paths {files}" }), changedSources: ["src/a.py"], readFile: () => null });
  expect(r).toMatchObject({ score: 55, ok: false });
});
test("no changed sources → ok; no command → misconfigured", async () => {
  expect((await mutationGate({ run: makeFakeRun([]), cwd: "/", harness: H({}), changedSources: [], readFile: () => null })).ok).toBe(true);
  expect((await mutationGate({ run: makeFakeRun([]), cwd: "/", harness: H({}), changedSources: ["x"], readFile: () => null })).misconfigured).toBe(true);
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/mutation.js`:
```js
import { mutationScore } from "./parsers/stryker-json.js";
import { parseMarkers } from "./parsers/marker.js";

export async function mutationGate({ run, cwd, harness, changedSources, readFile }) {
  const threshold = harness.gates.thresholds.mutation_score_pct;
  if (!changedSources?.length) return { ok: true, score: null, threshold, detail: "no changed sources" };
  const { mutation, mutation_report } = harness.commands.proof;
  if (!mutation) return { ok: false, misconfigured: true, threshold, detail: "commands.proof.mutation missing" };
  const r = await run("bash", ["-lc", mutation.replace("{files}", changedSources.join(","))], { cwd });
  let score = null, detail;
  const text = mutation_report ? readFile(`${cwd}/${mutation_report}`) : null;
  if (text) { const s = mutationScore(JSON.parse(text)); score = s.score; detail = `killed=${s.killed} timeout=${s.timeout} survived=${s.survived} noCoverage=${s.noCoverage}`; }
  else { const m = parseMarkers(r.stdout); if (m.MUTATION_SCORE != null) { score = Number(m.MUTATION_SCORE); detail = "from MUTATION_SCORE marker"; } }
  if (score == null) return { ok: false, threshold, detail: `no mutation score (exit ${r.code})`, command_code: r.code };
  return { ok: score >= threshold, score, threshold, detail, command_code: r.code };
}
```

- [ ] **Step 4: 통과·커밋** — `git commit -m "feat(factory): incremental mutation gate"`

---

### Task 9: `lib/classify-failure.js` — flaky 귀책 (§5.2.5 ③)

**Interfaces:**
- `classifyFailures({run, cwd, harness, failing, base, thresholds, addedTests}) → [{id, verdict: "red"|"introduced"|"flaky-existing"|"new-test-nondeterministic", evidence: {pr_isolation: [codes], base: [codes]}}]`
  - 새 테스트(`addedTests`에 속한 file)의 실패 → `"red"`(새 테스트는 ②에서 3회 반복으로 이미 다뤘으므로 분류 없이 RED).
  - 기존 테스트: PR 코드에서 `test_one` 명령으로 `flaky_isolation_runs`회 → 하나라도 실패면 `"red"`; 전부 통과면 base worktree에서 `flaky_base_runs`회 → 전부 통과면 `"introduced"`(이 PR이 비결정성 도입), 하나라도 실패면 `"flaky-existing"`.
  - `test_one`의 `{file}`·`{name}` 치환. base worktree는 prove-test와 같은 방식(`worktree add --detach`).

- [ ] **Step 1: 실패하는 테스트**

`factory/test/classify-failure.test.js`:
```js
import { test, expect } from "vitest";
import { classifyFailures } from "../lib/classify-failure.js";
import { makeFakeRun } from "../lib/exec.js";

const harness = { commands: { test_one: "vitest run {file} -t '{name}'" } };
const T = { flaky_isolation_runs: 3, flaky_base_runs: 5 };
const ok = { code: 0, stdout: "", stderr: "" }, fail = { code: 1, stdout: "", stderr: "" };
const f = { id: "test/a.test.js::x", file: "test/a.test.js", name: "x" };
const base = (codes) => { let i = 0; return { match: (c, a, o) => c === "bash" && o.cwd === "/tmp/wt", result: () => (codes[i++] === 0 ? ok : fail) }; };
const pr = (codes) => { let i = 0; return { match: (c, a, o) => c === "bash" && o.cwd === "/repo", result: () => (codes[i++] === 0 ? ok : fail) }; };
const wt = { match: (c) => c === "git", result: ok };

test("new test failure → red without reruns", async () => {
  const run = makeFakeRun([]);
  const r = await classifyFailures({ run, cwd: "/repo", harness, failing: [f], base: "b", thresholds: T, addedTests: ["test/a.test.js"] });
  expect(r).toEqual([{ id: f.id, verdict: "red", evidence: { reason: "new test in this change" } }]);
});
test("fails in PR isolation → red", async () => {
  const run = makeFakeRun([wt, pr([0, 1, 0])]);
  const [r] = await classifyFailures({ run, cwd: "/repo", harness, failing: [f], base: "b", thresholds: T, addedTests: [], tmp: "/tmp/wt" });
  expect(r.verdict).toBe("red"); expect(r.evidence.pr_isolation).toEqual([0, 1, 0]);
});
test("passes in PR isolation, never fails on base → introduced", async () => {
  const run = makeFakeRun([wt, pr([0, 0, 0]), base([0, 0, 0, 0, 0])]);
  const [r] = await classifyFailures({ run, cwd: "/repo", harness, failing: [f], base: "b", thresholds: T, addedTests: [], tmp: "/tmp/wt" });
  expect(r.verdict).toBe("introduced"); expect(r.evidence.base).toEqual([0, 0, 0, 0, 0]);
});
test("passes in PR isolation, fails on base too → flaky-existing", async () => {
  const run = makeFakeRun([wt, pr([0, 0, 0]), base([0, 1, 0, 0, 0])]);
  const [r] = await classifyFailures({ run, cwd: "/repo", harness, failing: [f], base: "b", thresholds: T, addedTests: [], tmp: "/tmp/wt" });
  expect(r.verdict).toBe("flaky-existing");
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/classify-failure.js`:
```js
export async function classifyFailures({ run, cwd, harness, failing, base, thresholds, addedTests = [], tmp = `${cwd}/.factory/out/classify-wt` }) {
  const out = [];
  const existing = [];
  for (const f of failing) {
    if (addedTests.includes(f.file)) out.push({ id: f.id, verdict: "red", evidence: { reason: "new test in this change" } });
    else existing.push(f);
  }
  if (!existing.length) return out;
  const one = (f, dir) => run("bash", ["-lc", harness.commands.test_one.replace("{file}", f.file).replace("{name}", f.name.replace(/'/g, "'\\''"))], { cwd: dir });
  let wtReady = false;
  try {
    for (const f of existing) {
      const pr_isolation = [];
      for (let i = 0; i < thresholds.flaky_isolation_runs; i++) pr_isolation.push((await one(f, cwd)).code);
      if (pr_isolation.some((c) => c !== 0)) { out.push({ id: f.id, verdict: "red", evidence: { pr_isolation } }); continue; }
      if (!wtReady) { const a = await run("git", ["worktree", "add", "--detach", tmp, base], { cwd }); if (a.code !== 0) { out.push({ id: f.id, verdict: "red", evidence: { pr_isolation, error: "worktree failed" } }); continue; } wtReady = true; }
      const baseRuns = [];
      for (let i = 0; i < thresholds.flaky_base_runs; i++) baseRuns.push((await one(f, tmp)).code);
      out.push({ id: f.id, verdict: baseRuns.every((c) => c === 0) ? "introduced" : "flaky-existing", evidence: { pr_isolation, base: baseRuns } });
    }
  } finally {
    if (wtReady) await run("git", ["worktree", "remove", "--force", tmp], { cwd });
  }
  return out;
}
```

- [ ] **Step 4: 통과·커밋** — `git commit -m "feat(factory): flaky classification (isolation reruns vs base)"`

---

### Task 10: `lib/integrity.js` + `bin/integrity.js` — L0 required check의 실체

**Interfaces:**
- `integrityCheck({run, cwd, base, head, harness, readFile}) → {ok, violations: [{file, rule}], checked: {...}}`:
  1. `harness.protected.factory` glob에 매치되는 변경 파일 → 위반, 단 `protected.except` 매치는 제외, `protected.additive_only`에 등록된 파일은 diff가 해당 섹션(`## Examples`/`## Perspectives`)의 **추가 줄만**인지 검사(삭제 줄·다른 섹션 변경 있으면 위반).
  2. `.factory/lessons/**` 변경 파일은 포맷 검사: 각 항목이 `- [L-YYYY-MM-DD-NN]`로 시작하고 `근거:` 줄이 있으며 항목 수 ≤ `<!-- factory-lessons:v1 role=… max=N -->`의 N.
  3. 테스트 파일에 `.skip(`, `xit(`, `@pytest.mark.skip`, `/* istanbul ignore`, `# pragma: no cover`, `// Stryker disable` **추가** 줄이 있으면 위반(`git diff -U0`의 `+` 줄만).
- `bin/integrity.js [--base <sha>]` → 위반 목록 출력, exit 0/1. (PR에서 GitHub required check `factory/integrity`로 사용 — yml은 Plan 2.)

- [ ] **Step 1: 실패하는 테스트**

`factory/test/integrity.test.js`:
```js
import { test, expect } from "vitest";
import { integrityCheck } from "../lib/integrity.js";
import { makeFakeRun } from "../lib/exec.js";

const harness = { protected: { factory: [".factory/**", ".claude/**", "docs/factory/CHARTER.md"], except: [".factory/lessons/**", "docs/factory/runs/**"], additive_only: { ".claude/agents/*.md": ["## Examples", "## Perspectives"] } }, test: { test_glob: ["test/**/*.test.js"] } };
const names = (s) => ({ match: (c, a) => a[0] === "diff" && a.includes("--name-status"), result: { code: 0, stdout: s, stderr: "" } });
const u0 = (s) => ({ match: (c, a) => a[0] === "diff" && a.includes("-U0"), result: { code: 0, stdout: s, stderr: "" } });

test("protected file change → violation; except path passes", async () => {
  const run = makeFakeRun([names("M\t.factory/harness.toml\nM\t.factory/lessons/reviewer-qa.md\nM\tsrc/a.js\n"), u0("")]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "<!-- factory-lessons:v1 role=reviewer-qa max=30 -->\n- [L-2026-09-01-01] x\n  근거: runs/1.md\n" });
  expect(r.ok).toBe(false); expect(r.violations).toEqual([{ file: ".factory/harness.toml", rule: "protected path changed" }]);
});
test("additive-only agent sections: additions in Examples ok; deletion or other section → violation", async () => {
  const okDiff = `+++ b/.claude/agents/reviewer-qa.md\n@@ -40,0 +41,2 @@\n+### 좋은 발견\n+- DST 25시간\n`;
  const run1 = makeFakeRun([names("M\t.claude/agents/reviewer-qa.md\n"), u0(okDiff)]);
  const r1 = await integrityCheck({ run: run1, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "## Purpose\n\n## Lens\n\n## Examples\n\n### 좋은 발견\n- DST 25시간\n\n## Perspectives\n" , readFileAt: () => "## Purpose\n\n## Lens\n\n## Examples\n\n## Perspectives\n" });
  expect(r1.ok).toBe(true);
  const badDiff = `+++ b/.claude/agents/reviewer-qa.md\n@@ -10,1 +10,1 @@\n-old lens\n+new lens\n`;
  const run2 = makeFakeRun([names("M\t.claude/agents/reviewer-qa.md\n"), u0(badDiff)]);
  const r2 = await integrityCheck({ run: run2, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "## Lens\nnew lens\n## Examples\n", readFileAt: () => "## Lens\nold lens\n## Examples\n" });
  expect(r2.ok).toBe(false); expect(r2.violations[0].rule).toMatch(/additive-only/);
});
test("skip/ignore pragmas added to tests → violation", async () => {
  const run = makeFakeRun([names("M\ttest/a.test.js\n"), u0(`+++ b/test/a.test.js\n@@ -1,0 +2,1 @@\n+test.skip("x", () => {});\n`)]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "" });
  expect(r.violations).toEqual([{ file: "test/a.test.js", rule: "test skip/ignore pragma added" }]);
});
test("lessons format violation", async () => {
  const run = makeFakeRun([names("M\t.factory/lessons/reviewer-qa.md\n"), u0("")]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "<!-- factory-lessons:v1 role=reviewer-qa max=1 -->\n- [L-2026-09-01-01] a\n  근거: r\n- bad entry\n" });
  expect(r.ok).toBe(false); expect(r.violations.map((v) => v.rule)).toEqual(expect.arrayContaining([expect.stringMatching(/lessons/)]));
});
```

- [ ] **Step 2: 실패 확인** — module not found.

- [ ] **Step 3: 구현**

`factory/lib/integrity.js`:
```js
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
```
`factory/bin/integrity.js`:
```js
#!/usr/bin/env node
import { realpathSync, readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { loadHarness } from "../lib/config.js";
import { integrityCheck } from "../lib/integrity.js";
const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2); const bi = args.indexOf("--base");
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const base = bi >= 0 ? args[bi + 1] : (await run("git", ["merge-base", "origin/main", "HEAD"], { cwd: root })).stdout.trim();
  const r = await integrityCheck({ run, cwd: root, base, harness: loadHarness(root), readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null) });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
```

- [ ] **Step 4: 통과·커밋** — `git commit -m "feat(factory): integrity check (protected paths, additive-only, lessons format, skip pragmas)"`

---

### Task 11: `lib/back-pressure.js` + `lib/sweeper.js` + `bin/sweep.js`

**Interfaces:**
- `backPressure({gh, charter, quarantine, now}) → {ok, reasons}`: `gh.searchIssues(label)`(gh.js에 추가: `gh issue list -R repo --label <l> --state open --json number,updatedAt`)로 `factory:awaiting-review` 수 ≥ `charter.back_pressure.awaiting_review_max` → 거부; `overCap(quarantine, thresholds)` → 거부.
- `sweep({gh, run, cwd, charter, thresholds, now}) → actions[]`: 
  - `factory:in-progress` 이슈마다 heartbeat 코멘트(`<!-- factory-heartbeat issue=N -->`)의 `last:` 시각을 파싱; `now - last > 30min` → lock 해제(`release`) + 재시도 코멘트 `<!-- factory-retry issue=N count=k -->` 갱신; `k ≤ charter.limits.R` → `transition(planned)`(그래프상 in-progress→planned 없음 → **엣지 추가**: `factory:in-progress → factory:planned` "sweeper 재큐"), 초과 → `needs-human`.
  - `factory:blocked` 이슈 → `needs-human` (사유 코멘트).
  - 격리 정책 적용(`applyPolicy`) 후 저장, `expired`는 `factory:retro-input` 코멘트로 표시(retro가 읽음, Plan 4).
  - 토큰 만료 경고: repo variable `FACTORY_TOKEN_ISSUED_AT`(`gh variable get`)이 11개월 지났으면 `needs-human` 이슈 생성(제목 "factory: 토큰 갱신 필요", 중복 방지 — 같은 제목 open 이슈 있으면 skip).
- `bin/sweep.js`: 위를 실행하고 actions를 JSON으로 출력.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/sweeper.test.js`:
```js
import { test, expect, vi } from "vitest";
import { backPressure } from "../lib/back-pressure.js";
import { sweep } from "../lib/sweeper.js";
import { canTransition } from "../lib/labels.js";

const charter = { limits: { K: 3, M: 3, R: 2 }, back_pressure: { awaiting_review_max: 2, quarantine_max: 5 } };
const T = { quarantine_max: 5, quarantine_ttl_days: 28, quarantine_return_after: 30 };

test("backPressure refuses when awaiting-review ≥ max or quarantine over cap", async () => {
  const gh = { searchIssues: vi.fn(async (label) => (label === "factory:awaiting-review" ? [{ number: 1 }, { number: 2 }] : [])) };
  const r = await backPressure({ gh, charter, quarantine: { quarantined: [] }, thresholds: T });
  expect(r.ok).toBe(false); expect(r.reasons[0]).toMatch(/awaiting-review 2 ≥ 2/);
  const r2 = await backPressure({ gh: { searchIssues: async () => [] }, charter, quarantine: { quarantined: new Array(5).fill({}) }, thresholds: T });
  expect(r2.ok).toBe(false); expect(r2.reasons[0]).toMatch(/quarantine/);
});

test("graph gained the sweeper re-queue edge", () => { expect(canTransition("factory:in-progress", "factory:planned")).toBe(true); });

test("sweep: stale heartbeat → release + retry comment + planned; retries exhausted → needs-human; blocked → needs-human", async () => {
  const hb = (last) => ({ id: 9, body: `<!-- factory-heartbeat issue=7 -->\nstage: implement · runner: gha-1 · started: x · last: ${last}`, createdAt: last });
  const gh = {
    searchIssues: vi.fn(async (label) => label === "factory:in-progress" ? [{ number: 7 }, { number: 8 }] : label === "factory:blocked" ? [{ number: 9 }] : []),
    comments: vi.fn(async (n) => n === 7 ? [hb("2026-09-11T00:00:00Z")] : n === 8 ? [hb("2026-09-11T00:00:00Z"), { id: 10, body: "<!-- factory-retry issue=8 count=2 -->", createdAt: "x" }] : []),
    comment: vi.fn(async () => "u#issuecomment-1"), patchComment: vi.fn(async () => {}),
  };
  const transition = vi.fn(async ({ to }) => ({ ok: true, to }));
  const release = vi.fn(async () => true);
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition, release, quarantine: { quarantined: [] }, saveQuarantine: () => {} });
  expect(release).toHaveBeenCalledTimes(2);
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ issue: 7, to: "factory:planned" }));
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ issue: 8, to: "factory:needs-human" }));
  expect(transition).toHaveBeenCalledWith(expect.objectContaining({ issue: 9, to: "factory:needs-human" }));
  expect(actions.map((a) => a.kind)).toEqual(expect.arrayContaining(["requeue", "retries-exhausted", "blocked-escalated"]));
});

test("sweep: fresh heartbeat is left alone", async () => {
  const gh = { searchIssues: async (l) => (l === "factory:in-progress" ? [{ number: 7 }] : []), comments: async () => [{ id: 1, body: "<!-- factory-heartbeat issue=7 -->\nlast: 2026-09-11T00:50:00Z", createdAt: "x" }], comment: vi.fn(), patchComment: vi.fn() };
  const transition = vi.fn();
  const actions = await sweep({ gh, charter, thresholds: T, now: "2026-09-11T01:00:00Z", staleMinutes: 30, transition, release: vi.fn(), quarantine: { quarantined: [] }, saveQuarantine: () => {} });
  expect(transition).not.toHaveBeenCalled(); expect(actions).toEqual([]);
});
```

- [ ] **Step 2: 실패 확인** — module not found; labels 테스트 1건 FAIL(엣지 없음).

- [ ] **Step 3: 구현**

`factory/lib/labels.js`: `["factory:in-progress", new Set([... , "factory:planned"])]` 추가 (sweeper 재큐). `factory/test/labels.test.js`의 non-edge 목록에 이 엣지가 없음을 확인.

`factory/lib/gh.js`에 추가:
```js
    async searchIssues(label) {
      return JSON.parse(await gh(["issue", "list", "-R", repo, "--label", label, "--state", "open", "--limit", "200", "--json", "number,title,updatedAt"]));
    },
    async createIssue({ title, body, labels = [] }) {
      const out = await gh(["issue", "create", "-R", repo, "--title", title, "--body-file", "-", ...labels.flatMap((l) => ["--label", l])], { input: body });
      const m = /\/issues\/(\d+)/.exec(out); return m ? Number(m[1]) : null;
    },
    async getVariable(name) { const r = await run("gh", ["variable", "get", name, "-R", repo]); return r.code === 0 ? r.stdout.trim() : null; },
```

`factory/lib/back-pressure.js`:
```js
import { overCap } from "./quarantine.js";
export async function backPressure({ gh, charter, quarantine, thresholds }) {
  const reasons = [];
  const waiting = await gh.searchIssues("factory:awaiting-review");
  if (waiting.length >= charter.back_pressure.awaiting_review_max) reasons.push(`awaiting-review ${waiting.length} ≥ ${charter.back_pressure.awaiting_review_max}`);
  if (overCap(quarantine, thresholds)) reasons.push(`quarantine ${quarantine.quarantined.length} ≥ ${thresholds.quarantine_max}`);
  return { ok: reasons.length === 0, reasons };
}
```

`factory/lib/sweeper.js`:
```js
import { applyPolicy } from "./quarantine.js";
const HB = /<!--\s*factory-heartbeat issue=(\d+)\s*-->[\s\S]*?last:\s*(\S+)/;
const RETRY = /<!--\s*factory-retry issue=(\d+) count=(\d+)\s*-->/;

export async function sweep({ gh, charter, thresholds, now, staleMinutes = 30, transition, release, quarantine, saveQuarantine, tokenIssuedAt = null }) {
  const actions = [];
  const nowMs = Date.parse(now);
  for (const it of await gh.searchIssues("factory:in-progress")) {
    const comments = await gh.comments(it.number);
    const hb = comments.map((c) => HB.exec(c.body)).filter(Boolean).at(-1);
    const last = hb ? Date.parse(hb[2]) : null;
    if (last && nowMs - last <= staleMinutes * 60e3) continue;
    await release(it.number);
    const prev = comments.map((c) => RETRY.exec(c.body)).filter(Boolean).at(-1);
    const count = (prev ? Number(prev[2]) : 0) + 1;
    await gh.comment(it.number, `<!-- factory-retry issue=${it.number} count=${count} -->\nheartbeat stale (${hb ? hb[2] : "none"}) — lock released, retry ${count}/${charter.limits.R}`);
    if (count <= charter.limits.R) { await transition({ issue: it.number, to: "factory:planned", reason: `sweeper requeue ${count}/${charter.limits.R}` }); actions.push({ kind: "requeue", issue: it.number, count }); }
    else { await transition({ issue: it.number, to: "factory:needs-human", reason: `retries exhausted (${count - 1}/${charter.limits.R})` }); actions.push({ kind: "retries-exhausted", issue: it.number }); }
  }
  for (const it of await gh.searchIssues("factory:blocked")) {
    await transition({ issue: it.number, to: "factory:needs-human", reason: "blocked (environment/credentials) — needs human" });
    actions.push({ kind: "blocked-escalated", issue: it.number });
  }
  const pol = applyPolicy(quarantine, { now, thresholds });
  if (pol.returned.length || pol.expired.length) { saveQuarantine(pol.q); actions.push({ kind: "quarantine", returned: pol.returned, expired: pol.expired }); }
  if (tokenIssuedAt && nowMs - Date.parse(tokenIssuedAt) > 334 * 86400e3) {
    const open = await gh.searchIssues("factory:needs-human");
    if (!open.some((i) => /토큰 갱신/.test(i.title || ""))) { const n = await gh.createIssue({ title: "factory: 토큰 갱신 필요 (11개월 경과)", body: "`claude setup-token` 재실행 후 시크릿 CLAUDE_CODE_OAUTH_TOKEN을 교체하고 FACTORY_TOKEN_ISSUED_AT을 갱신하세요.", labels: ["factory:needs-human"] }); actions.push({ kind: "token-expiry", issue: n }); }
  }
  return actions;
}
```
`factory/bin/sweep.js`: 실제 의존성 조립(`makeGh`, `loadCharter`, `loadHarness().gates.thresholds`, `loadQuarantine/saveQuarantine`, `transition` from lib, `release` from claim.js, `tokenIssuedAt = await gh.getVariable("FACTORY_TOKEN_ISSUED_AT")`), actions를 JSON 출력, exit 0.

- [ ] **Step 4: 통과·커밋** — `git commit -m "feat(factory): back-pressure, sweeper (stale locks, blocked, quarantine policy, token expiry)"`

---

### Task 12: `run-stage` 통합 — 파일 기반 판정, prove/repeat/coverage/mutation 합산, classify, back-pressure

**Files:**
- Modify: `factory/bin/run-stage.js`, `factory/bin/gates.js`(신설), `factory/lib/requirements.js`, `factory/lib/verify-stage.js`, `factory/test/run-stage.test.js`, `factory/test/requirements.test.js`, `factory/test/verify-stage.test.js`
- Create: `factory/bin/gates.js`, `factory/bin/prove-test.js`, `factory/bin/classify-failure.js`

**Interfaces / 동작 변경:**
1. `d.gates(ctx)`(implement·review·merge): 
   - level = CHARTER tier → `docs: fast, standard: full, load-bearing: deep`(`ctx.tier`).
   - `base = git merge-base origin/<default_branch> HEAD`.
   - `runGates` → 실패 테스트가 있으면 `classifyFailures` → `flaky-existing`인 id는 `tests.excluded`에 추가하고 판정에서 제외 + `flakyIssues` 액션(`gh.createIssue` "flaky: <id>" label `backlog`,`factory:flaky`) — **implement에서만**(review/merge는 재분류 없이 RED); `introduced`/`red`는 RED 유지.
   - implement: `changedFiles` → `proveTest`(docs tier 제외) + `repeatNewTests`(`new_test_repeats`) → 결과를 `gates.gates["prove-test"]`, `["new-test-repeat"]`로 합산(둘 다 GREEN/RED).
   - level에 `diff_coverage` 있으면 `runDiffCoverage` → `gates.gates.diff_coverage`; `mutation` 있으면 `mutationGate` → `gates.gates.mutation`. 각각 ok면 GREEN, 아니면 RED; `misconfigured`면 MISCONFIGURED(required에 있으면 전체).
   - 최종 status 재계산, `.factory/out/gates.json` 저장, verdict line을 stdout과 run 기록에.
2. `verifyStage`에 `gates` 인자 추가: implement/review/merge에서 `gates == null` → reason "gates file missing"; handoff `data.gates`가 있으면 `{status, level}`이 파일과 같아야 함(다르면 "handoff gates mismatch") — 없으면 파일 값으로 채운다(`data.gates = {status, level}`).
3. `requirements` `factory:awaiting-review`: `ctx.gatesFile`이 주어지면 handoff의 `gates.status` 대신 **파일의 status**를 본다; `main()`이 `.factory/out/gates.json`을 읽어 넘긴다.
4. `factory:merged`의 `checksGreen`: main()이 `gh pr checks <pr> --json name,state`로 required 체크 전부 `SUCCESS`인지 계산; `integrityGreen`: `integrityCheck` 직접 실행 결과. 두 값이 `ctxExtra`로 들어간다 → Plan 1a의 strict 규칙이 실제로 통과 가능해진다.
5. implement 시작 시(`claim` 전) `backPressure` 검사 → 거부면 record + exit 0(다음 sweeper/이벤트 때 재시도; 라벨 불변).
6. 새 CLI: `bin/gates.js <level> [--base <sha>]`(파일 저장 + verdict 출력 + exit 0 GREEN / 1 RED / 2 MISCONFIGURED), `bin/prove-test.js [--base]`, `bin/classify-failure.js <ids…>` — 로컬 진단용.

- [ ] **Step 1: 실패하는 테스트**

`factory/test/run-stage.test.js`에 추가(기존 deps 팩토리 재사용):
```js
test("implement: gates RED → verify fails → needs-human; gates file status wins over handoff claim", async () => {
  const gates = { schema: "factory.gates.v1", level: "full", status: "RED", failing: ["unit"], passed: 3, failed: 1, skipped: [], misconfigured: [], tests: { failing: [{ id: "t::x" }], excluded: [] } };
  const d = base({ gates: async () => gates, claudeP: async () => ({ is_error: false, result: JSON.stringify({ schema: "factory.implement.v1", issue: 7, head_sha: "a".repeat(40), pr: 9, gates: { status: "GREEN", level: "full" }, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" }) }) });
  const code = await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" });
  expect(code).toBe(2);
  expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ to: "factory:needs-human", reason: expect.stringMatching(/gates mismatch|gates RED/) }));
});
test("implement: back-pressure refusal exits 0 before claim", async () => {
  const d = base({ backPressure: async () => ({ ok: false, reasons: ["awaiting-review 4 ≥ 4"] }), claim: vi.fn() });
  expect(await runStage({ stage: "implement", issue: 7, deps: d, runnerId: "r" })).toBe(0);
  expect(d.claim).not.toHaveBeenCalled();
});
```
`factory/test/verify-stage.test.js`에 추가:
```js
test("implement/review/merge require a gates file; handoff gates must match the file", () => {
  const impl = { schema: "factory.implement.v1", issue: 7, head_sha: "a".repeat(40), pr: 9, gates: { status: "GREEN", level: "full" }, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" };
  const noFile = verifyStage({ stage: "implement", out: out(impl), agentsLog: log([]), roster: [], orchestration: "workflow", gates: null });
  expect(noFile.reasons).toContain("gates file missing");
  const mismatch = verifyStage({ stage: "implement", out: out(impl), agentsLog: log([]), roster: [], orchestration: "workflow", gates: { status: "RED", level: "full" } });
  expect(mismatch.reasons.join()).toMatch(/gates mismatch/);
  const filled = verifyStage({ stage: "implement", out: out({ ...impl, gates: undefined }), agentsLog: log([]), roster: [], orchestration: "workflow", gates: { status: "GREEN", level: "full" } });
  expect(filled.ok).toBe(true); expect(filled.data.gates).toEqual({ status: "GREEN", level: "full" });
});
```
`factory/test/requirements.test.js`에 추가:
```js
test("awaiting-review trusts the gates file over the handoff", () => {
  const impl = { schema: "factory.implement.v1", issue: 7, head_sha: sha, pr: 9, gates: { status: "GREEN", level: "full" }, verifier: { verdict: "accepted" }, orchestration: "workflow", guarantee: "verified" };
  const r = requirementFor("factory:awaiting-review");
  expect(r({ comments: [c("implement", impl)], headSha: sha, gatesFile: { status: "RED" } }).reason).toMatch(/gates file/);
  expect(r({ comments: [c("implement", impl)], headSha: sha, gatesFile: { status: "GREEN" } }).ok).toBe(true);
});
```

- [ ] **Step 2: 실패 확인** — 3개 파일에서 새 테스트 FAIL.

- [ ] **Step 3: 구현**

`factory/lib/verify-stage.js` — `verifyStage({..., gates})`에 추가:
```js
  if (["implement", "review", "merge"].includes(stage)) {
    if (!gates) reasons.push("gates file missing");
    else if (data) {
      if (data.gates && (data.gates.status !== gates.status || data.gates.level !== gates.level)) reasons.push(`handoff gates mismatch: handoff says ${data.gates.status}/${data.gates.level}, file says ${gates.status}/${gates.level}`);
      else data.gates = { status: gates.status, level: gates.level };
      if (stage === "implement" && gates.status !== "GREEN") reasons.push(`gates ${gates.status}: failing=${(gates.failing || []).join(",") || "none"}`);
    }
  }
```
(schema 검증은 `data.gates` 채운 뒤에 실행되도록 순서 조정.)

`factory/lib/requirements.js` awaiting-review: `const status = ctx.gatesFile ? ctx.gatesFile.status : h.data.gates.status; if (status !== "GREEN") return fail(ctx.gatesFile ? \`gates file status is ${status}\` : \`gates status is ${status}\`);`

`factory/bin/run-stage.js` — `runStage`: implement 진입 시 `if (stage === "implement" && d.backPressure) { const bp = await d.backPressure(); if (!bp.ok) { d.runRecord([\`back-pressure: refused — ${bp.reasons.join("; ")}\`]); return 0; } }` (charterReady 다음, trust 전). `d.gates(ctx)` 결과를 `verifyStage({..., gates})`에 전달(이미 전달됨), `writeHandoff`는 `v.data`(gates 채워짐). `main()`의 `gates` dep:
```js
    gates: async (ctx) => {
      if (!["implement", "review", "merge"].includes(stage)) return null;
      const level = { docs: "fast", standard: "full", "load-bearing": "deep" }[ctx.tier] || "full";
      const base = (await run("git", ["merge-base", `origin/${harness.project?.default_branch || "main"}`, "HEAD"], { cwd: root })).stdout.trim();
      const quarantine = loadQuarantine(root);
      const readFile = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
      const result = await runGates({ run, cwd: root, harness, level, quarantine, readFile });
      if (stage === "implement" && result.tests?.failing?.length) {
        const changed = await changedFiles({ run, cwd: root, base, harness });
        const cls = await classifyFailures({ run, cwd: root, harness, failing: result.tests.failing, base, thresholds: harness.gates.thresholds, addedTests: changed.addedTests });
        for (const c of cls) if (c.verdict === "flaky-existing") { result.tests.excluded.push(c.id); result.tests.failing = result.tests.failing.filter((f) => f.id !== c.id); await gh.createIssue({ title: `flaky: ${c.id}`, body: `Detected while implementing #${issue}. evidence: ${JSON.stringify(c.evidence)}`, labels: ["backlog", "factory:flaky"] }); }
        result.classification = cls;
        if (result.tests.failing.length === 0) { for (const n of Object.keys(result.gates)) if (result.gates[n].status === "RED" && ["unit", "integration", "e2e"].includes(n)) result.gates[n].status = "GREEN"; result.failing = result.failing.filter((n) => !["unit", "integration", "e2e"].includes(n)); }
      }
      if (stage === "implement") {
        const changed = await changedFiles({ run, cwd: root, base, harness });
        if (ctx.tier !== "docs") { const pt = await proveTest({ run, cwd: root, harness, base, addedTests: changed.addedTests }); result.gates["prove-test"] = { status: pt.ok ? "GREEN" : "RED", log: pt.detail }; }
        const rp = await repeatNewTests({ run, cwd: root, harness, addedTests: changed.addedTests, times: harness.gates.thresholds.new_test_repeats });
        result.gates["new-test-repeat"] = { status: rp.ok ? "GREEN" : "RED", log: rp.detail };
        if (result.skipped.includes("diff_coverage")) { const dc = await runDiffCoverage({ run, cwd: root, harness, base, readFile }); result.gates.diff_coverage = { status: dc.misconfigured ? "MISCONFIGURED" : dc.ok ? "GREEN" : "RED", log: `pct=${dc.pct} threshold=${dc.threshold} uncovered=${JSON.stringify(dc.uncovered || []).slice(0, 500)}` }; }
        if (result.skipped.includes("mutation")) { const mu = await mutationGate({ run, cwd: root, harness, changedSources: changed.sources, readFile }); result.gates.mutation = { status: mu.misconfigured ? "MISCONFIGURED" : mu.ok ? "GREEN" : "RED", log: `score=${mu.score} threshold=${mu.threshold} ${mu.detail || ""}` }; }
      }
      recomputeStatus(result, harness);            // failing/skipped/misconfigured/passed/status 재계산 (gates.js에서 export)
      mkdirSync(join(root, ".factory/out"), { recursive: true });
      writeFileSync(join(root, ".factory/out/gates.json"), JSON.stringify(result, null, 2));
      console.log(verdictLine(result));
      return result;
    },
```
`gates.js`에 `recomputeStatus(result, harness)` export 추가(gates 맵에서 failing/skipped/misconfigured/passed/status 재계산; required 중 MISCONFIGURED면 전체 MISCONFIGURED). 

`main()`의 `transition` dep `ctxExtra`: `gatesFile: readJson(".factory/out/gates.json")`; merge 시 `checksGreen: await allChecksGreen(gh, pr)`(gh.js에 `prChecks(pr)` 추가: `gh pr checks <pr> -R repo --json name,state,bucket` → 모두 `bucket === "pass"`), `integrityGreen: (await integrityCheck({run, cwd: root, base, harness, readFile})).ok`. `backPressure` dep: `() => backPressure({ gh, charter, quarantine: loadQuarantine(root), thresholds: harness.gates.thresholds })`. `runRecord`에 verdict line 포함.

`bin/gates.js`, `bin/prove-test.js`, `bin/classify-failure.js`: main()의 해당 로직을 인자로 호출하는 얇은 CLI(exit 코드: gates 0/1/2).

- [ ] **Step 4: 통과·커밋** — 전체 스위트 GREEN. `git commit -m "feat(factory): wire gates/prove/repeat/coverage/mutation/classify/back-pressure into run-stage; file-based gate verdicts"`

---

### Task 13: 훅 — `lint-touched.sh`, `verdict-format.sh`

**Interfaces:**
- `lint-touched.sh` (PostToolUse Edit|Write, 로깅형 exit 0): stdin `.tool_input.file_path`; `.factory/harness.toml`의 `[commands].lint_file`이 있으면(`grep`로 추출 — toml 파서 없이 `lint_file *= *"(.*)"`) `{file}` 치환 실행, 실패 시 마지막 20줄을 stderr로(에이전트에 피드백), **항상 exit 0**.
- `verdict-format.sh` (SubagentStop, 판정형): `.agent_type`이 `reviewer-` 접두 또는 `factory-verifier`면 `.agent_transcript_path`의 마지막 assistant 메시지 텍스트에 ```` ```json ```` 펜스가 있고 `"verdict"` 키가 있어야 통과; 없으면 stderr에 "reply with the verdict JSON block" + exit 2(중지 거부 → 에이전트가 계속). jq 없거나 transcript 없으면 exit 0(판정 불가 시 통과 — 이 훅은 보조선).

- [ ] **Step 1: 실패하는 테스트**

`factory/test/hooks.test.js`에 추가:
```js
test("lint-touched: runs lint_file for the touched file, never blocks", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lt-")); mkdirSync(join(cwd, ".factory"));
  writeFileSync(join(cwd, ".factory/harness.toml"), `[commands]\nlint_file = "bash -c 'echo LINT {file}; exit 1'"\n`);
  const r = await run("bash", [join(H, "lint-touched.sh")], { input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "src/a.js" } }), cwd, env: { CLAUDE_PROJECT_DIR: cwd } });
  expect(r.code).toBe(0); expect(r.stderr).toMatch(/LINT src\/a\.js/);
});
test("verdict-format: reviewer stop without verdict json → exit 2; with → 0; non-reviewer → 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-"));
  const t = join(dir, "t.jsonl");
  const msg = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  writeFileSync(t, msg("thinking...") + "\n" + msg("Here is my verdict:\n```json\n{\"verdict\":\"approve\",\"confidence\":\"high\",\"must_fix\":[],\"should_fix\":[],\"verified\":[]}\n```") + "\n");
  const ok = await run("bash", [join(H, "verdict-format.sh")], { input: JSON.stringify({ hook_event_name: "SubagentStop", agent_type: "reviewer-qa", agent_transcript_path: t }) });
  expect(ok.code).toBe(0);
  writeFileSync(t, msg("I approve, looks fine.") + "\n");
  const bad = await run("bash", [join(H, "verdict-format.sh")], { input: JSON.stringify({ hook_event_name: "SubagentStop", agent_type: "reviewer-qa", agent_transcript_path: t }) });
  expect(bad.code).toBe(2); expect(bad.stderr).toMatch(/verdict JSON/);
  const other = await run("bash", [join(H, "verdict-format.sh")], { input: JSON.stringify({ hook_event_name: "SubagentStop", agent_type: "factory-builder", agent_transcript_path: t }) });
  expect(other.code).toBe(0);
});
```

- [ ] **Step 2: 실패 확인** — 훅 파일 없음 → code 127.

- [ ] **Step 3: 구현**

`factory/hooks/lint-touched.sh`:
```bash
#!/usr/bin/env bash
# PostToolUse(Edit|Write) 로깅형 훅: 건드린 파일에 lint_file을 돌려 결과를 stderr로 돌려준다. 절대 차단하지 않는다(exit 0).
input=$(cat) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
[ -n "$file" ] || exit 0
root="${CLAUDE_PROJECT_DIR:-.}"
cmd=$(grep -E '^\s*lint_file\s*=\s*"' "$root/.factory/harness.toml" 2>/dev/null | head -1 | sed -E 's/^[^"]*"(.*)"[[:space:]]*$/\1/') || exit 0
[ -n "$cmd" ] || exit 0
cmd=${cmd//\{file\}/$file}
out=$(cd "$root" && bash -lc "$cmd" 2>&1); code=$?
if [ $code -ne 0 ]; then printf 'factory lint (%s) exit %s:\n%s\n' "$file" "$code" "$(printf '%s' "$out" | tail -20)" >&2; fi
exit 0
```
`factory/hooks/verdict-format.sh`:
```bash
#!/usr/bin/env bash
# SubagentStop 판정형 훅: 리뷰어/검증자는 마지막 메시지에 verdict JSON 블록이 있어야 멈출 수 있다.
input=$(cat) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
type=$(printf '%s' "$input" | jq -r '.agent_type // empty' 2>/dev/null) || exit 0
case "$type" in reviewer-*|factory-verifier) ;; *) exit 0 ;; esac
path=$(printf '%s' "$input" | jq -r '.agent_transcript_path // empty' 2>/dev/null) || exit 0
[ -f "$path" ] || exit 0
last=$(jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' "$path" 2>/dev/null | tail -c 20000)
if printf '%s' "$last" | grep -q '```json' && printf '%s' "$last" | grep -q '"verdict"'; then exit 0; fi
echo "factory: reply with the verdict JSON block (\`\`\`json … \"verdict\": approve|reject … \`\`\`) before stopping" >&2
exit 2
```
`chmod +x` 둘 다.

- [ ] **Step 4: 통과·커밋** — `git commit -m "feat(factory): lint-touched and verdict-format hooks"`

---

### Task 14: 스펙·ADR 갱신

- [ ] **Step 1: 스펙** (`docs/superpowers/specs/2026-09-10-factory-design.md`)
  1. §5.1 `harness.toml` 예시에 이 계획의 키 추가(`[commands] test_files/test_one/lint_file`, `[commands.proof] coverage/coverage_report/mutation/mutation_report`, `[test] test_glob/source_glob/unit_report`).
  2. §4.2.1 step 5·6: "gates.json이 진실; handoff의 gates는 복사본, 불일치는 verify 거부", "prove-test·new-test-repeat·diff_coverage·mutation은 gates.json의 게이트 항목으로 합산", "implement에서만 flaky 재분류, flaky-existing은 excluded + `factory:flaky` 이슈 자동 생성".
  3. §3.2에 `in_progress --> planned: sweeper 재큐` 엣지 추가; §4.3 sweeper 절차를 Task 11 동작으로 구체화(30분, R, blocked, 격리 정책, 토큰 만료).
  4. §5.2.5 ⑤ 격리 파일 `.factory/quarantine.toml` 스키마(Task 4) 명시; `quarantine_return_after` 임계값 추가(§5.1 `[gates.thresholds]`).
  5. §6.1 integrity의 검사 항목을 Task 10의 세 가지로 명시.
  6. §6.3 훅 목록에 `lint-touched.sh`(로깅형), `verdict-format.sh`(판정형) 추가.
- [ ] **Step 2: DECISIONS.md** — ADR-010 "게이트 판정은 파일이 진실(handoff 복사본 불일치 거부)", ADR-011 "flaky 귀책은 implement에서만 재분류; review/merge는 RED" 추가(날짜·근거: 이 계획).
- [ ] **Step 3: 커밋** — `git commit -m "docs(spec): gates layer — file-based verdicts, harness keys, sweeper edge, quarantine schema (plan 1b)"`

---

## Self-Review

**Spec coverage:** §4.2.1 step 5(T5, T12) · step 6 파일 신뢰(T12) · §5.1 명령/임계(T1, T14) · §5.2.4 prove-test(T6) · diff coverage(T7) · mutation(T8) · 무시 주석 reject(T10) · §5.2.5 ① 규칙은 QA.md/lint 영역(Plan 5), ② 반복(T6), ③ 분류(T9), ④ 자가 수정 이슈 생성(T12 `factory:flaky`), ⑤ 격리·상한·복귀·TTL(T4, T11) · §5.3 back_pressure(T11, T12) · §6.1 integrity(T10) · §6.2 스크립트 목록: gates·prove-test·classify·aggregate(1a)·transition(1a)·write-lessons(Plan 4) · §6.3 훅(T13) · §4.3 sweeper(T11) · ADR-005 소비 보고(1a) · 이월 3건(T1). **Plan 4로 넘긴 것:** retro, write-lessons, TTL 만료 시 재작성 이슈 생성(T11은 `expired` 표시만).

**Placeholder scan:** T12 Step 3의 `recomputeStatus`는 이름·역할을 명시했고 gates.js에 export한다고 적었다 — 구현자는 `runGates` 말미의 status 계산을 함수로 추출하면 된다. `bin/gates.js` 등 CLI 3개는 "main()의 해당 로직을 인자로 호출"로 축약 — Plan 1a T17의 래퍼 패턴을 그대로 따른다.

**Type consistency:** `runGates` 반환 `{gates, failing, skipped, misconfigured, passed, status, tests:{failing, excluded}}` ↔ T12가 그 필드를 수정·재계산 ↔ `verifyStage({gates})`는 `status/level/failing`만 읽음 ↔ `requirements` `ctx.gatesFile.status`. `changedFiles → {addedTests, sources}` ↔ T6/T8/T9/T12. `classifyFailures` 입력 `failing:[{id,file,name}]` = `parseVitestJson` 출력. `quarantine` 객체 `{quarantined:[{id,…}]}` ↔ `isQuarantined`/`overCap`/`applyPolicy`. `gh.searchIssues/createIssue/getVariable/prChecks`는 T11·T12에서 gh.js에 추가.

**Known unknowns:** vitest JSON reporter의 `testResults[].name`이 절대 경로인지(현재 버전은 절대 경로) — T2 파서가 `relative()`로 흡수. `gh pr checks --json`의 `bucket` 필드 존재 여부 — 없으면 `state === "SUCCESS"`로 대체(T12 구현 시 `gh pr checks --help`로 확인). Stryker `--incremental --mutate` 조합의 report 경로 기본값 `reports/mutation/mutation.json`.
