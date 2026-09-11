import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { checkHarness, checkCommands } from "../lib/doctor/harness.js";
import { loadHarness } from "../lib/config.js";
import { makeFakeRun } from "../lib/exec.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T = new URL("../../templates/factory/factory/harness.toml", import.meta.url).pathname;
const tmpl = () => { const r = mkdtempSync(join(tmpdir(), "ktb-h-")); mkdirSync(join(r, ".factory"), { recursive: true }); writeFileSync(join(r, ".factory/harness.toml"), readFileSync(T, "utf8").replace("{{PROJECT_NAME}}", "d")); return loadHarness(r); };
const files = [".factory/harness.toml", ".claude/settings.json", ".github/workflows/factory-plan.yml", "docs/factory/CHARTER.md", "test/smoke.test.js", "src/a.js"];
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
  h.harness.maturity = "M9"; h.gates.thresholds.new_test_repeats = 1; h.gates.thresholds.diff_coverage_pct = 120; h.factory.orchestration = "auto"; h.factory.required_checks = []; h.commands.test_one = "vitest {file}"; h.protected.factory.push("nope/**");
  const c = by(checkHarness({ harness: h, files }));
  expect(c["harness.maturity"].level).toBe("FAIL");
  expect(c["thresholds.range"]).toMatchObject({ level: "FAIL", detail: expect.stringMatching(/new_test_repeats.*diff_coverage_pct|diff_coverage_pct.*new_test_repeats/) });
  expect(c["factory.orchestration"].level).toBe("FAIL");
  expect(c["factory.required_checks"].level).toBe("FAIL");
  expect(c["commands.placeholders"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("test_one") });
  expect(c["protected.globs-match"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("nope/**") });
});

test("maturity-level mismatch: deep listed but M0 → WARN; proof gates listed without proof commands → FAIL", () => {
  const h = tmpl(); h.gates.deep = ["lint", "unit", "e2e"]; h.commands.e2e = "x";
  expect(by(checkHarness({ harness: h, files }))["gates.levels-vs-maturity"].level).toBe("WARN");
  const h2 = tmpl(); h2.gates.full = ["lint", "unit", "diff_coverage"];
  expect(by(checkHarness({ harness: h2, files }))["proof.commands"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("coverage") });
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
