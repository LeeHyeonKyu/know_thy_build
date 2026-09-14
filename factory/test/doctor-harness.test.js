import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { checkHarness, checkCommands } from "../lib/doctor/harness.js";
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
