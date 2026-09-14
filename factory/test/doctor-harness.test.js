import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { checkHarness, checkCommands, checkSetupDirtiesTree, checkQaEvidenceProbe, runSetupProbe, SETUP_DIRTY_NOTE } from "../lib/doctor/harness.js";
import { loadHarness, loadHarnessRaw } from "../lib/config.js";
import { makeFakeRun } from "../lib/exec.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T = new URL("../../templates/factory/factory/harness.toml", import.meta.url).pathname;
const tmplRoot = (toml) => { const r = mkdtempSync(join(tmpdir(), "ktb-h-")); mkdirSync(join(r, ".factory"), { recursive: true }); writeFileSync(join(r, ".factory/harness.toml"), toml ?? readFileSync(T, "utf8").replace("{{PROJECT_NAME}}", "d")); return r; };
const tmpl = () => loadHarness(tmplRoot());
// 템플릿 [protected].factory의 모든 글롭이 최소 하나씩 매치하는 파일 목록 — 빌드 설정 파일 포함(F9)
const files = [".factory/harness.toml", ".claude/settings.json", ".github/workflows/factory-plan.yml", "docs/factory/CHARTER.md", "test/smoke.test.js", "src/a.js",
               "package.json", "package-lock.json", "vitest.config.js", "playwright.config.js", "tsconfig.json", ".eslintrc.json", "eslint.config.js"];
const by = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

test("template harness passes every static check", () => {
  const c = by(checkHarness({ harness: tmpl(), files }));
  for (const [id, ch] of Object.entries(c)) expect(ch.level, `${id}: ${ch.detail}`).not.toBe("FAIL");
  expect(c["harness.schema"].level).toBe("PASS");
  expect(c["gates.required-in-commands"].level).toBe("PASS");
  expect(c["protected.globs-match"].level).toBe("PASS");
  expect(c["commands.placeholders"].level).toBe("PASS");
  expect(c["commands.unit"].level).toBe("PASS");
});

// KTB-16: 오타로 12가 120이 되면 잘못된 프롬프트가 몇 시간·수백 달러를 태울 수 있다.
test("factory.max_turns: 정수 3–50만 통과, 스테이지별 표도 같은 범위, 없으면 WARN(기본값 12)", () => {
  const c = by(checkHarness({ harness: tmpl(), files }));
  expect(c["factory.max_turns"]).toMatchObject({ level: "PASS", detail: "12" });

  const h = tmpl(); h.factory.max_turns = 120;
  expect(by(checkHarness({ harness: h, files }))["factory.max_turns"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("[factory].max_turns=120") });

  const h2 = tmpl(); h2.factory.max_turns = 2;
  expect(by(checkHarness({ harness: h2, files }))["factory.max_turns"].level).toBe("FAIL");

  const h3 = tmpl(); h3.factory.max_turns_by_stage = { plan: 16, review: "many" };
  expect(by(checkHarness({ harness: h3, files }))["factory.max_turns"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("[factory.max_turns_by_stage].review") });

  const h4 = tmpl(); h4.factory.max_turns_by_stage = { plan: 16 };
  expect(by(checkHarness({ harness: h4, files }))["factory.max_turns"].level).toBe("PASS");

  const h5 = tmpl(); delete h5.factory.max_turns;
  expect(by(checkHarness({ harness: h5, files }))["factory.max_turns"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("init --upgrade") });
});

// M2: `loadHarness`가 `[factory].max_turns`에 기본값 12를 항상 채우므로, doctor.js가 그 정규화된
// 객체 하나만 넘기면 위 h5 케이스(WARN)는 실제 CLI 경로에서 **절대 일어나지 않는다** — `h.factory.max_turns`가
// 늘 12로 보인다. `raw`(loadHarnessRaw, 기본값 채움 이전 파스)를 실제 파일에서 따로 읽어 넘겨야
// "파일에 키가 없다"는 사실이 살아남는다.
test("factory.max_turns WARN survives loadHarness's default-fill when doctor.js's real raw+normalized pair is used (M2)", () => {
  const missing = "schema = 1\n[project]\ndefault_branch = \"main\"\n[harness]\nmaturity = \"M0\"\n[factory]\norchestration = \"workflow\"\nrequired_checks = [\"factory/gates\"]\n[commands]\nlint = \"x\"\nunit = \"x\"\ntest_files = \"x {files}\"\n[test]\ntest_glob = [\"x\"]\n[gates]\nrequired = []\n";
  const root = tmplRoot(missing);
  const normalized = loadHarness(root);           // .factory.max_turns === 12 — the default, not user intent
  const raw = loadHarnessRaw(root);                // .factory.max_turns === undefined — the truth doctor.js needs
  expect(normalized.factory.max_turns).toBe(12);
  expect(raw.factory?.max_turns).toBeUndefined();
  expect(by(checkHarness({ harness: normalized, files: [], raw }))["factory.max_turns"])
    .toMatchObject({ level: "WARN", detail: expect.stringContaining("init --upgrade") });

  // 파일에 명시적으로 12를 적어 둔 경우(우연히 기본값과 같아도)는 PASS다 — 진짜 사용자 의도다.
  const explicit = missing.replace("[factory]\n", "[factory]\nmax_turns = 12\n");
  const root2 = tmplRoot(explicit);
  const normalized2 = loadHarness(root2);
  const raw2 = loadHarnessRaw(root2);
  expect(by(checkHarness({ harness: normalized2, files: [], raw: raw2 }))["factory.max_turns"])
    .toMatchObject({ level: "PASS", detail: "12" });
});

// M3: 오타 스테이지 이름(`"pln"`)은 stageMaxTurns가 못 찾아 조용히 공통 max_turns로 떨어진다 —
// 아무 신호 없이 오버라이드가 무효화된다. doctor가 알려진 이름(run-stage.js STAGES + retro) 밖의
// 키를 이름으로 잡아 WARN한다.
test("factory.max_turns_by_stage.keys: unknown stage names WARN by name; known ones (incl. retro) PASS (M3)", () => {
  const h = tmpl(); h.factory.max_turns_by_stage = { pln: 16, review: 20 };
  expect(by(checkHarness({ harness: h, files }))["factory.max_turns_by_stage.keys"])
    .toMatchObject({ level: "WARN", detail: expect.stringContaining("pln") });

  const h2 = tmpl(); h2.factory.max_turns_by_stage = { plan: 16, retro: 10 };
  expect(by(checkHarness({ harness: h2, files }))["factory.max_turns_by_stage.keys"].level).toBe("PASS");

  const h3 = tmpl();
  expect(by(checkHarness({ harness: h3, files }))["factory.max_turns_by_stage.keys"].level).toBe("PASS");
});

test("commands.unit missing → FAIL", () => {
  const h = tmpl(); delete h.commands.unit;
  expect(by(checkHarness({ harness: h, files }))["commands.unit"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("unit") });
});

test("required gate not in [commands] nor proof → FAIL; not in its own level → FAIL", () => {
  const h = tmpl(); h.gates.required = ["lint", "unit", "e2e"];
  expect(by(checkHarness({ harness: h, files }))["gates.required-in-commands"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("e2e") });
  const h2 = tmpl(); h2.gates.required = ["lint", "unit", "diff_coverage"]; h2.commands.proof = { coverage: "x", coverage_report: "y" };
  expect(by(checkHarness({ harness: h2, files }))["gates.required-in-levels"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("diff_coverage") });
});

test("maturity / thresholds / orchestration / required_checks / placeholders / protected globs", () => {
  const h = tmpl();
  h.harness.maturity = "M9"; h.gates.thresholds.new_test_repeats = 1; h.gates.thresholds.diff_coverage_pct = 120; h.factory.orchestration = "auto"; h.factory.required_checks = []; h.commands.test_one = "vitest {file}"; h.protected.factory.push("nope.txt");
  const c = by(checkHarness({ harness: h, files }));
  expect(c["harness.maturity"].level).toBe("FAIL");
  expect(c["thresholds.range"]).toMatchObject({ level: "FAIL", detail: expect.stringMatching(/new_test_repeats.*diff_coverage_pct|diff_coverage_pct.*new_test_repeats/) });
  expect(c["factory.orchestration"].level).toBe("FAIL");
  expect(c["factory.required_checks"].level).toBe("FAIL");
  expect(c["commands.placeholders"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("test_one") });
  expect(c["protected.globs-match"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("nope.txt") });
});

test("protected.globs-match: a wildcard glob that matches nothing is optional (PASS), a literal one is a typo (WARN)", () => {
  // playwright을 아직 안 쓰는 저장소: `playwright.config.*`는 "생기면 보호한다"는 선언이지 오류가 아니다.
  const withoutPlaywright = files.filter((f) => !f.startsWith("playwright.config"));
  const wild = by(checkHarness({ harness: tmpl(), files: withoutPlaywright }))["protected.globs-match"];
  expect(wild.level).toBe("PASS");
  expect(wild.detail).toContain("(optional, no match)");
  expect(wild.detail).toContain("playwright.config.*");

  // 리터럴 경로가 빠진 것은 실제로 고칠 것이 있다는 뜻이다.
  const h = tmpl();
  const withoutLock = files.filter((f) => f !== "package-lock.json");
  expect(by(checkHarness({ harness: h, files: withoutLock }))["protected.globs-match"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("package-lock.json") });
});

test("maturity-level mismatch: deep listed but M0 → WARN; proof gates listed without proof commands → FAIL", () => {
  const h = tmpl(); h.gates.deep = ["lint", "unit", "e2e"]; h.commands.e2e = "x";
  expect(by(checkHarness({ harness: h, files }))["gates.levels-vs-maturity"].level).toBe("WARN");
  const h2 = tmpl(); h2.gates.full = ["lint", "unit", "diff_coverage"];
  expect(by(checkHarness({ harness: h2, files }))["proof.commands"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("coverage") });
});

// ── 감사 H2 / P1-7 (Task 3) — 레벨이 전부 같고 lint가 no-op이면 실효 게이트는 하나뿐이다 ──────
// 감사 실측: `harness.toml:53-56` fast/full/deep 동일, `lint = "node -e 0"`, `MAX_LEVEL.M0 = "fast"`.
// 세 가지가 겹치면 어떤 tier의 PR이든 실제로 도는 게이트는 `unit` 하나다 — 그리고 그 구성이 템플릿
// 그대로 모든 입양자에게 배포된다. doctor가 세 갈래를 각각 잡는다.

test("H2: full이 fast에 아무것도 더하지 않으면 FAIL (gates.levels-identical)", () => {
  const h = tmpl(); h.gates.full = [...h.gates.fast]; h.gates.deep = [...h.gates.fast];
  expect(by(checkHarness({ harness: h, files }))["gates.levels-identical"])
    .toMatchObject({ level: "FAIL", detail: expect.stringContaining("full") });

  const h2 = tmpl(); h2.gates.deep = [...h2.gates.fast];
  expect(by(checkHarness({ harness: h2, files }))["gates.levels-identical"])
    .toMatchObject({ level: "FAIL", detail: expect.stringContaining("deep") });

  // 템플릿 자신은 통과해야 한다 — full = fast + 증명 게이트.
  expect(by(checkHarness({ harness: tmpl(), files }))["gates.levels-identical"].level).toBe("PASS");
});

test("H2: deep이 full과 같은데 더 설정된 게이트가 있으면 FAIL, 없으면 PASS", () => {
  const h = tmpl(); h.commands.e2e = "playwright test";        // 설정은 했는데 deep이 그것을 안 부른다
  expect(by(checkHarness({ harness: h, files }))["gates.levels-identical"])
    .toMatchObject({ level: "FAIL", detail: expect.stringContaining("e2e") });
});

test("P1-7: no-op lint는 린트가 아니다 — gates.lint-noop FAIL", () => {
  for (const cmd of ["node -e 0", 'node -e ""', "true", ":", "   ", "exit 0"]) {
    const h = tmpl(); h.commands.lint = cmd;
    expect(by(checkHarness({ harness: h, files }))["gates.lint-noop"], cmd)
      .toMatchObject({ level: "FAIL", detail: expect.stringContaining("[commands].lint") });
  }
  const h2 = tmpl(); h2.commands.lint_file = "node -e 0 {file}";
  expect(by(checkHarness({ harness: h2, files }))["gates.lint-noop"])
    .toMatchObject({ level: "FAIL", detail: expect.stringContaining("[commands].lint_file") });
  expect(by(checkHarness({ harness: tmpl(), files }))["gates.lint-noop"].level).toBe("PASS");
});

test("H2: M0의 fast 강등은 조용하지 않다 — gates.m0-downgrade WARN", () => {
  const c = by(checkHarness({ harness: tmpl(), files }));      // 템플릿은 M0이고 full/deep에 더 있는 게이트가 있다
  expect(c["gates.m0-downgrade"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("fast") });
  expect(c["gates.m0-downgrade"].detail).toContain("prove-test");
  const h = tmpl(); h.harness.maturity = "M1";
  expect(by(checkHarness({ harness: h, files }))["gates.m0-downgrade"].level).toBe("PASS");
});

test("H2: required는 도는 모든 레벨에 있어야 한다 — 한 레벨에서라도 빠지면 FAIL", () => {
  const h = tmpl(); h.gates.fast = ["unit"];                   // lint가 fast에서 빠졌다 → fast PR은 lint 없이 GREEN
  expect(by(checkHarness({ harness: h, files }))["gates.required-in-levels"])
    .toMatchObject({ level: "FAIL", detail: expect.stringContaining("lint") });
});

test("checkCommands runs each non-templated command and reports exit codes; skipRun marks WARN", async () => {
  const h = tmpl();
  const run = makeFakeRun([{ match: (c, a) => a[1].startsWith("npm run lint"), result: { code: 0, stdout: "", stderr: "" } }, { match: () => true, result: { code: 1, stdout: "", stderr: "no tests" } }]);
  const c = by(await checkCommands({ harness: h, run, cwd: "/r" }));
  expect(c["commands.run.lint"].level).toBe("PASS");
  expect(c["commands.run.unit"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("no tests") });
  expect(c["commands.run.test_files"]).toBeUndefined();   // 템플릿 명령은 실행하지 않는다
  expect(run.calls.every((x) => x.cmd === "bash" && x.args[0] === "-lc")).toBe(true);
  const skipped = by(await checkCommands({ harness: h, run, cwd: "/r", skipRun: true }));
  expect(skipped["commands.run"].level).toBe("WARN");
});

// ── 외부 감사 H3의 절반: `[load_bearing].paths`가 **아무 파일도 가리키지 않는** 드리프트 ────────
// 이 저장소의 소스는 `factory/lib/…`인데 설치본은 `.factory/lib/…`다. 한쪽만 적으면 목록은 그럴듯한데
// 매치가 0이고, 그러면 tier 바닥이 조용히 사라진다(그 PR은 load-bearing이 아니게 된다). 오타·이동·
// 레이아웃 드리프트는 전부 같은 모양으로 나타나므로 doctor가 경로별로 매치를 확인한다.
test("load-bearing.paths-exist: 매치가 0인 경로는 FAIL, 매치가 있으면 PASS", () => {
  const h = tmpl(); h.load_bearing = { paths: [".factory/lib/integrity.js"] };
  expect(by(checkHarness({ harness: h, files }))["load-bearing.paths-exist"])
    .toMatchObject({ level: "FAIL", detail: expect.stringContaining(".factory/lib/integrity.js") });
  expect(by(checkHarness({ harness: h, files: [...files, ".factory/lib/integrity.js"] }))["load-bearing.paths-exist"].level).toBe("PASS");
});

test("load-bearing.paths-exist: 목록이 비어 있으면 WARN — 모든 PR의 바닥이 standard에 머문다는 사실을 소리 내어 말한다", () => {
  const h = tmpl(); h.load_bearing = { paths: [] };
  expect(by(checkHarness({ harness: h, files }))["load-bearing.paths-exist"].level).toBe("WARN");
});

test("load-bearing.paths-exist: 글롭도 실제 파일을 가리켜야 한다", () => {
  const h = tmpl(); h.load_bearing = { paths: ["src/**"] };
  expect(by(checkHarness({ harness: h, files }))["load-bearing.paths-exist"].level).toBe("PASS");
  const h2 = tmpl(); h2.load_bearing = { paths: ["srcc/**"] };
  expect(by(checkHarness({ harness: h2, files }))["load-bearing.paths-exist"].level).toBe("FAIL");
});

// 이 저장소 자신의 하네스: 소스(`factory/…`)와 설치본(`.factory/…`) 두 레이아웃을 모두 적어야
// 실제로 도는 코드가 load-bearing이 된다 — 스테이지는 `.factory/…`의 사본을 실행한다.
test("KTB의 harness.toml [load_bearing].paths는 소스와 설치본을 모두 가리키고, 전부 실재한다", () => {
  const h = loadHarness(new URL("../..", import.meta.url).pathname);
  const paths = h.load_bearing?.paths || [];
  expect(paths.some((p) => p.startsWith("factory/"))).toBe(true);
  expect(paths.some((p) => p.startsWith(".factory/"))).toBe(true);
  for (const p of paths) expect(existsSync(new URL(`../../${p}`, import.meta.url).pathname), `${p} does not exist`).toBe(true);
});

// ── 리뷰 batch-2 MF-2 — run 기록 디렉터리는 러너의 것이어야 한다 ────────────────────────────────
// 머지 스테이지는 review handoff를 `docs/factory/runs/<n>.md`의 `review-evidence:` 줄과 대조한다.
// 그 디렉터리가 에이전트에게 열려 있으면 대조가 아무것도 증명하지 못한다(재리뷰가 rc=0으로 확인).
// 그런데 `[protected].factory`에 넣을 수는 없다 — 러너가 매 스테이지 쓰고 사람 없이 머지돼야 한다.
// 그 반쪽(쓰기 경계)이 `[protected].runner_only`이고, 이 검사가 그 둘이 갈라지지 않았는지 본다.
test("protected.runner-only: the template seals the runs dir for agents but not for L1 (review batch-2 MF-2)", () => {
  const c = by(checkHarness({ harness: tmpl(), files }));
  expect(c["protected.runner-only"]).toMatchObject({ level: "PASS", detail: expect.stringContaining("docs/factory/runs/**") });
  // 머지 경계에는 들어가지 않는다 — 들어가면 run 기록 PR마다 사람이 머지해야 한다.
  expect(tmpl().protected.factory).not.toContain("docs/factory/runs/**");
  expect(tmpl().protected.except).toContain("docs/factory/runs/**");
});

test("protected.runner-only: an empty or non-covering list is a FAIL, and so is overlap with [protected].factory", () => {
  const h = tmpl(); h.protected.runner_only = [];
  expect(by(checkHarness({ harness: h, files }))["protected.runner-only"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("docs/factory/runs/**") });

  const h2 = tmpl(); h2.protected.runner_only = [".factory/out/qa/**"];   // 다른 경로를 적어도 runs_dir가 열려 있으면 FAIL
  expect(by(checkHarness({ harness: h2, files }))["protected.runner-only"].level).toBe("FAIL");

  const h3 = tmpl(); h3.protected.factory = [...h3.protected.factory, "docs/factory/runs/**"];
  expect(by(checkHarness({ harness: h3, files }))["protected.runner-only"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("WRITE boundary") });

  // `[project].runs_dir`를 옮긴 저장소는 그 경로가 덮여야 한다(글롭이 따라오지 않으면 FAIL).
  const h4 = tmpl(); h4.project.runs_dir = "docs/runs";
  expect(by(checkHarness({ harness: h4, files }))["protected.runner-only"].level).toBe("FAIL");
  h4.protected.runner_only = ["docs/runs/**"];
  expect(by(checkHarness({ harness: h4, files }))["protected.runner-only"].level).toBe("PASS");
});

// ── ADR-020 KTB-39 — `[runtime].setup`이 추적 파일을 다시 쓰는 하네스 ─────────────────────────
// own-calendar #3: setup이 `flutter pub get`이라 스테이지가 시작하기도 전에 추적 파일이 다시 쓰였고,
// 쓰기 금지 스테이지의 클린 체크가 그것을 에이전트의 위반으로 읽었다. run-stage는 이제 그 기준선을
// 판정에서 빼지만(KTB-39), 그 하네스는 여전히 고쳐야 한다 — implement는 면제가 아니라 복원이라
// setup 산출물이 매 라운드 지워지고, setup은 잡당 한 번만 돈다. doctor가 그 사실을 미리 말한다.
test("runtime.setup-dirties-tree: a setup that rewrites tracked files is a WARN with the paths and the fix", () => {
  const h = tmpl(); h.runtime.setup = "flutter pub get";
  const c = checkSetupDirtiesTree({ harness: h, status: " M client/pubspec.lock\n M client/analysis_options.yaml\n" });
  expect(c.level).toBe("WARN");
  expect(c.detail).toContain("client/pubspec.lock");
  expect(c.detail).toContain(SETUP_DIRTY_NOTE);
});

test("runtime.setup-dirties-tree: untracked setup output is called out too — `git add -A` would commit it", () => {
  const h = tmpl(); h.runtime.setup = "flutter pub get";
  const c = checkSetupDirtiesTree({ harness: h, status: "?? client/ios/Flutter/generated_plugin_registrant.h\n" });
  expect(c.level).toBe("WARN");
  expect(c.detail).toMatch(/1 untracked file\(s\)/);
});

test("runtime.setup-dirties-tree: a clean sample passes; no setup, a skip, and no sample are never judged", () => {
  const h = tmpl();                                   // 템플릿 기본값은 `npm ci` — 추적 파일을 건드리지 않는다
  expect(checkSetupDirtiesTree({ harness: h, status: "" }).level).toBe("PASS");
  expect(checkSetupDirtiesTree({ harness: h, skipped: "--offline" })).toMatchObject({ level: "PASS", detail: expect.stringContaining("--offline") });
  expect(checkSetupDirtiesTree({ harness: h }).level).toBe("PASS");            // 표본 없음 = 판정 없음
  const h2 = tmpl(); delete h2.runtime.setup;
  expect(checkSetupDirtiesTree({ harness: h2, status: " M a.js\n" }).level).toBe("PASS");
  // setup 자신이 실패한 표본으로는 "다시 쓴다/아니다"를 말할 수 없다 — 그 사실만 WARN으로 남긴다.
  expect(checkSetupDirtiesTree({ harness: h, status: "", setupExit: 1 })).toMatchObject({ level: "WARN", detail: expect.stringContaining("exited 1") });
});

test("runSetupProbe: the sample comes from a scratch clone — the working tree is never touched", async () => {
  const h = tmpl(); h.runtime.setup = "flutter pub get";
  const seen = [];
  const run = makeFakeRun([
    { match: (c, a) => c === "git" && a[0] === "clone", result: (c, a) => { seen.push(a.at(-1)); return { code: 0, stdout: "", stderr: "" }; } },
    { match: (c) => c === "bash", result: (c, a, o) => { seen.push(`setup@${o.cwd}`); return { code: 0, stdout: "", stderr: "" }; } },
    { match: (c, a) => c === "git" && a[0] === "status", result: (c, a, o) => { seen.push(`status@${o.cwd}`); return { code: 0, stdout: " M client/pubspec.lock\n", stderr: "" }; } },
  ]);
  const removed = [];
  const r = await runSetupProbe({ run, cwd: "/repo", harness: h, mkdtemp: () => "/tmp/probe-1", rm: (p) => removed.push(p) });
  expect(r).toMatchObject({ status: " M client/pubspec.lock\n", setupExit: 0 });
  expect(seen).toEqual(["/tmp/probe-1", "setup@/tmp/probe-1", "status@/tmp/probe-1"]);   // 셋 다 스크래치 안에서
  expect(removed).toEqual(["/tmp/probe-1"]);                                             // 그리고 지우고 나온다
  // 복제가 실패하면 표본이 없다 — 없는 표본으로 판정하지 않는다(skipped).
  const failing = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "clone", result: { code: 128, stdout: "", stderr: "fatal: repository not found" } }]);
  const skipped = await runSetupProbe({ run: failing, cwd: "/repo", harness: h, mkdtemp: () => "/tmp/probe-2", rm: () => {} });
  expect(skipped.skipped).toMatch(/scratch clone failed/);
  expect(checkSetupDirtiesTree({ harness: h, ...skipped }).level).toBe("PASS");
});

// ── ADR-024 / KTB-42 — `qa.evidence-probe` ───────────────────────────────────────────────────
// review 스테이지가 `claude -p` 전에 돌리는 것과 같은 프로브를 사람의 자리에서도 한 번 돌린다.

test("KTB-42: doctor's qa.evidence-probe PASSes on a writable tree and names the KTB-42 failure mode when it cannot write", () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-qa-"));
  const ok = checkQaEvidenceProbe({ root });
  expect(ok.id).toBe("qa.evidence-probe");
  expect(ok.level).toBe("PASS");

  const blocked = mkdtempSync(join(tmpdir(), "ktb-qa-"));
  mkdirSync(join(blocked, ".factory/out"), { recursive: true });
  writeFileSync(join(blocked, ".factory/out/qa"), "not a directory");   // mkdir -p가 실패하는 유일한 이식성 있는 방법
  const bad = checkQaEvidenceProbe({ root: blocked });
  expect(bad.level).toBe("FAIL");
  expect(bad.detail).toMatch(/qa evidence dir not writable/);
  expect(bad.detail).toMatch(/spec-conformance will read that as the builder's missing evidence/);
});

test("KTB-42: --offline/--no-run cannot run the probe — that is a WARN, never a PASS", () => {
  for (const skipped of ["--offline", "--no-run"]) {
    const r = checkQaEvidenceProbe({ root: "/nonexistent", skipped, probe: () => { throw new Error("must not run"); } });
    expect(r.level).toBe("WARN");
    expect(r.detail).toContain(skipped);
  }
});

// 리뷰 라운드 1 SF-6 — qa를 부르지 않는 저장소에는 물어볼 것이 없다(그리고 자국도 남기지 않는다).
test("KTB-42/SF-6: a CHARTER with no qa in any roster is not probed; an unknown roster still is", () => {
  const skip = checkQaEvidenceProbe({ root: "/nonexistent", rosterHasQa: false, probe: () => { throw new Error("must not run"); } });
  expect(skip.level).toBe("PASS");
  expect(skip.detail).toMatch(/no review roster in this CHARTER includes qa/);

  // 모르면(null) 프로브한다 — 프로브는 싸고, 실패는 언제나 진짜 신호다.
  let asked = 0;
  expect(checkQaEvidenceProbe({ root: "/x", rosterHasQa: null, probe: () => { asked++; return { ok: true }; } }).level).toBe("PASS");
  expect(checkQaEvidenceProbe({ root: "/x", rosterHasQa: true, probe: () => { asked++; return { ok: true }; } }).level).toBe("PASS");
  expect(asked).toBe(2);
});
