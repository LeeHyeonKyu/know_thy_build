import { test, expect, vi } from "vitest";
import { runGates, verdictLine, recomputeStatus, runStageGates, levelForTier } from "../lib/gates.js";
import { makeFakeRun } from "../lib/exec.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  // required(lint/typecheck/unit/integration/build)가 fast 목록(lint/typecheck/unit)의 상위집합이어도
  // fast에 없는 required는 이 레벨의 실패가 아니다 — 트림된 fastHarness 없이 harness를 그대로 쓴다.
  const report = JSON.stringify({ numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, testResults: [{ name: "/repo/test/a.test.js", assertionResults: [{ fullName: "flaky one", status: "failed" }, { fullName: "solid", status: "passed" }] }] });
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh(harness.commands.unit, bad)]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "fast", quarantine: { quarantined: [{ id: "test/a.test.js::flaky one" }] }, readFile: (p) => p.endsWith("unit.json") ? report : null });
  expect(r.gates.unit.status).toBe("GREEN"); expect(r.status).toBe("GREEN");
  expect(r.tests.excluded).toEqual(["test/a.test.js::flaky one"]); expect(r.tests.failing).toEqual([]);
  expect(verdictLine(r)).toContain("excluded=test/a.test.js::flaky one");
});

test("runGates without readFile uses the default (real fs); no report file → unit gate stays by exit code, still GREEN", async () => {
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh(harness.commands.unit, ok), sh("vitest run --project integration", ok), sh("npm run build", ok)]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "full", quarantine: { quarantined: [] }, now: "2026-09-11T00:00:00Z" });
  expect(r.status).toBe("GREEN"); expect(r.passed).toBe(5);
});

// ── runStageGates: 명령 게이트 + 실패 분류 + 증명 게이트를 한 판정으로 합산 ───────────

const stageHarness = {
  harness: { maturity: "M2" },
  commands: { unit: "vitest --json", test_files: "vitest run {files}", test_one: "vitest run {file} -t {name}", proof: {} },
  gates: { required: ["unit"], fast: ["unit"], full: ["unit", "diff_coverage", "mutation"], deep: ["unit"], thresholds: { new_test_repeats: 1, flaky_isolation_runs: 1, flaky_base_runs: 1 } },
  test: { unit_report: ".factory/out/unit.json", test_glob: ["test/**"], source_glob: ["src/**"] },
};
// 수정된 테스트 파일(test/a.test.js)도 증명 대상이므로 test_files 명령에 함께 실린다.
// {name}도 lib이 따옴표를 붙인다(§5.1 test_one 계약) — 하네스는 맨 플레이스홀더만 쓴다.
const TF = "vitest run 'test/a.test.js' 'test/new.test.js'", TO = "vitest run 'test/a.test.js' -t 'flaky one'";
const diffOut = { code: 0, stdout: "M\tsrc/a.js\nM\ttest/a.test.js\nA\ttest/new.test.js\n", stderr: "" };
const HEAD = "h".repeat(40);
const revParse = { match: (c, a) => c === "git" && a[0] === "rev-parse", result: { code: 0, stdout: `${HEAD}\n`, stderr: "" } };
const diffNames = { match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--name-status", result: diffOut };
// proveTest가 실제로 mkdir/cp를 하므로 cwd는 진짜 디렉터리여야 한다.
const stageCwd = mkdtempSync(join(tmpdir(), "stage-gates-"));
const readUnit = (p) => (p.endsWith("unit.json") ? JSON.stringify({ numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, testResults: [{ name: join(stageCwd, "test/a.test.js"), assertionResults: [{ fullName: "flaky one", status: "failed" }] }] }) : null);

test("levelForTier: docs→fast, standard→full, load-bearing→deep, unknown→full", () => {
  expect([levelForTier("docs"), levelForTier("standard"), levelForTier("load-bearing"), levelForTier(undefined)]).toEqual(["fast", "full", "deep", "full"]);
});

test("implement: flaky-existing 실패는 제외 + 이슈화되고, prove-test·반복·증명 게이트가 같은 판정에 합산된다", async () => {
  const run = makeFakeRun([
    { match: (c, a, o) => c === "bash" && a[1] === TF && o.cwd.endsWith("prove-wt"), result: { code: 1, stdout: "", stderr: "" } },   // 새 테스트는 base에서 실패해야 한다
    { match: (c, a) => c === "bash" && a[1] === TF, result: ok },                                                                     // PR 코드에서는 통과
    { match: (c, a, o) => c === "bash" && a[1] === TO && o.cwd.endsWith("classify-wt"), result: bad },                                // base에서도 실패 → 원래 흔들리던 테스트
    { match: (c, a) => c === "bash" && a[1] === TO, result: ok },                                                                     // PR 격리 실행은 통과
    { match: (c, a) => c === "bash" && a[1] === "vitest --json", result: bad },
    diffNames, revParse,
    { match: (c, a) => c === "git" && a[0] === "worktree", result: ok },
    { match: (c) => c === "cp", result: ok },
  ]);
  const gh = { createIssue: vi.fn(async () => 101), searchIssues: vi.fn(async () => []) };
  const r = await runStageGates({ run, cwd: stageCwd, harness: stageHarness, stage: "implement", tier: "standard", base: "b".repeat(40), gh, issue: 7, readFile: readUnit });
  expect(r.level).toBe("full");
  expect(r.tests.excluded).toEqual(["test/a.test.js::flaky one"]);
  expect(r.tests.failing).toEqual([]);
  expect(r.gates.unit.status).toBe("GREEN");                       // 남은 실패가 없으면 테스트 게이트의 RED는 이 변경 책임이 아니다
  expect(r.gates["prove-test"].status).toBe("GREEN");
  expect(r.gates["new-test-repeat"].status).toBe("GREEN");
  expect(r.gates.diff_coverage.status).toBe("MISCONFIGURED");      // commands.proof.coverage 없음
  expect(r.gates.mutation.status).toBe("MISCONFIGURED");
  expect(r.status).toBe("GREEN");                                  // required는 unit뿐 — misconfigured가 required면 전체 MISCONFIGURED
  expect(gh.createIssue).toHaveBeenCalledWith(expect.objectContaining({ title: "flaky: test/a.test.js::flaky one", labels: ["factory:queue", "factory:flaky"] }));
  expect(r.flaky_issues).toEqual([101]);
  // 증명 대상은 추가된 테스트만이 아니라 수정된 테스트 파일까지다
  expect(run.calls.some((c) => c.cmd === "bash" && c.args[1] === TF && c.opts.cwd.endsWith("prove-wt"))).toBe(true);
});

test("이미 열려 있는 flaky 이슈는 다시 만들지 않는다", async () => {
  const run = makeFakeRun([
    { match: (c, a, o) => c === "bash" && a[1] === TF && o.cwd.endsWith("prove-wt"), result: { code: 1, stdout: "", stderr: "" } },
    { match: (c, a) => c === "bash" && a[1] === TF, result: ok },
    { match: (c, a, o) => c === "bash" && a[1] === TO && o.cwd.endsWith("classify-wt"), result: bad },
    { match: (c, a) => c === "bash" && a[1] === TO, result: ok },
    { match: (c, a) => c === "bash" && a[1] === "vitest --json", result: bad },
    diffNames, revParse,
    { match: (c, a) => c === "git" && a[0] === "worktree", result: ok },
    { match: (c) => c === "cp", result: ok },
  ]);
  const gh = { createIssue: vi.fn(async () => 999), searchIssues: vi.fn(async () => [{ number: 55, title: "flaky: test/a.test.js::flaky one", updatedAt: "2026-09-11T00:00:00Z" }]) };
  const r = await runStageGates({ run, cwd: stageCwd, harness: stageHarness, stage: "implement", tier: "standard", base: "b".repeat(40), gh, issue: 7, readFile: readUnit });
  expect(gh.searchIssues).toHaveBeenCalledWith("factory:flaky");
  expect(gh.createIssue).not.toHaveBeenCalled();
  expect(r.flaky_issues).toEqual([55]);
});

test("리포트를 못 읽은 RED 테스트 게이트는 flaky 제외로도 뒤집히지 않는다", async () => {
  const h = { ...stageHarness, commands: { ...stageHarness.commands, e2e: "playwright" }, gates: { ...stageHarness.gates, required: ["unit", "e2e"], full: ["unit", "e2e"] } };
  const run = makeFakeRun([
    { match: (c, a, o) => c === "bash" && a[1] === TF && o.cwd.endsWith("prove-wt"), result: { code: 1, stdout: "", stderr: "" } },
    { match: (c, a) => c === "bash" && a[1] === TF, result: ok },
    { match: (c, a, o) => c === "bash" && a[1] === TO && o.cwd.endsWith("classify-wt"), result: bad },
    { match: (c, a) => c === "bash" && a[1] === TO, result: ok },
    { match: (c, a) => c === "bash" && a[1] === "vitest --json", result: bad },
    { match: (c, a) => c === "bash" && a[1] === "playwright", result: bad },        // e2e RED, 리포트 없음
    diffNames, revParse,
    { match: (c, a) => c === "git" && a[0] === "worktree", result: ok },
    { match: (c) => c === "cp", result: ok },
  ]);
  const gh = { createIssue: vi.fn(async () => 101), searchIssues: vi.fn(async () => []) };
  const r = await runStageGates({ run, cwd: stageCwd, harness: h, stage: "implement", tier: "standard", base: "b".repeat(40), gh, issue: 7, readFile: readUnit });
  expect(r.gates.unit.status).toBe("GREEN");        // 리포트를 읽었고 실패가 전부 제외됨
  expect(r.gates.e2e.status).toBe("RED");           // 왜 RED인지 모르는 게이트는 그대로 둔다
  expect(r.gates.e2e.parsed).toBe(false);
  expect(r.status).toBe("RED");
  expect(r.failing).toEqual(["e2e"]);
});

test("implement: 판정 불가(blocked) 분류는 BLOCKED로 올라가고 증명 게이트는 아예 돌지 않는다", async () => {
  const run = makeFakeRun([
    { match: (c, a) => c === "bash" && a[1] === TO, result: ok },
    { match: (c, a) => c === "bash" && a[1] === "vitest --json", result: bad },
    diffNames, revParse,
    { match: (c, a) => c === "git" && a[0] === "worktree" && a[1] === "add", result: { code: 128, stdout: "", stderr: "fatal: disk full" } },
  ]);
  const r = await runStageGates({ run, cwd: stageCwd, harness: stageHarness, stage: "implement", tier: "standard", base: "b".repeat(40), readFile: readUnit });
  expect(r.status).toBe("BLOCKED");
  expect(r.blocked_reason).toMatch(/worktree add failed.*disk full/);
  expect(r.gates["prove-test"]).toBeUndefined();
  expect(r.classification[0].verdict).toBe("blocked");
});

test("review/merge는 실패를 재분류하지 않는다 — RED는 RED", async () => {
  const run = makeFakeRun([{ match: (c, a) => c === "bash" && a[1] === "vitest --json", result: bad }, diffNames, revParse]);
  const r = await runStageGates({ run, cwd: stageCwd, harness: { ...stageHarness, gates: { ...stageHarness.gates, full: ["unit"] } }, stage: "review", tier: "standard", base: "b".repeat(40), readFile: readUnit });
  expect(r.status).toBe("RED");
  expect(r.classification).toBeUndefined();
  expect(r.gates["prove-test"]).toBeUndefined();
  // 재분류를 위한 워크트리도 격리 재실행도 없다 — diff는 tier 승격 때문에 읽지만 판정은 뒤집지 않는다
  expect(run.calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree")).toEqual([]);
  expect(run.calls.filter((c) => c.cmd === "bash" && c.args[1] === TO)).toEqual([]);
});

// ── F2: tier는 diff가 바닥을 깐다 ─────────────────────────────────────────

const diffOf = (stdout) => ({ match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--name-status", result: { code: 0, stdout, stderr: "" } });
const unitOk = { match: (c, a) => c === "bash" && a[1] === "vitest --json", result: ok };
const stageArgs = { cwd: () => stageCwd, base: "b".repeat(40) };

test("F2: 선언 tier가 docs여도 코드가 바뀌었으면 standard로 승격된다", async () => {
  const run = makeFakeRun([unitOk, diffOf("M\tdocs/a.md\nM\tsrc/a.js\n"), revParse]);
  const r = await runStageGates({ run, cwd: stageCwd, harness: stageHarness, stage: "review", tier: "docs", base: stageArgs.base, readFile: () => null });
  expect([r.tier_declared, r.tier_effective, r.tier_source]).toEqual(["docs", "standard", "promoted-by-diff"]);
  expect(r.level).toBe("full");
});

test("F2: 문서만 바뀐 docs 변경은 선언대로 docs로 남는다", async () => {
  const run = makeFakeRun([unitOk, diffOf("M\tdocs/a.md\nM\tREADME.md\n"), revParse]);
  const r = await runStageGates({ run, cwd: stageCwd, harness: stageHarness, stage: "review", tier: "docs", base: stageArgs.base, readFile: () => null });
  expect([r.tier_effective, r.tier_source, r.level]).toEqual(["docs", "declared", "fast"]);
});

test("F2: load_bearing 경로가 diff에 있으면 standard 선언도 load-bearing으로 승격된다", async () => {
  const h = { ...stageHarness, load_bearing: { paths: ["src/auth/**"] } };
  const run = makeFakeRun([unitOk, diffOf("M\tsrc/auth/token.js\n"), revParse]);
  const r = await runStageGates({ run, cwd: stageCwd, harness: h, stage: "review", tier: "standard", base: stageArgs.base, readFile: () => null });
  expect([r.tier_declared, r.tier_effective, r.tier_source]).toEqual(["standard", "load-bearing", "promoted-by-diff"]);
  expect(r.level).toBe("deep");
});

test("F6: 판정 파일은 어떤 커밋을 무엇과 비교해 잰 것인지(head_sha/base)를 싣는다", async () => {
  const run = makeFakeRun([unitOk, diffOf("M\tsrc/a.js\n"), revParse]);
  const r = await runStageGates({ run, cwd: stageCwd, harness: stageHarness, stage: "review", tier: "standard", base: stageArgs.base, readFile: () => null });
  expect(r.head_sha).toBe(HEAD);
  expect(r.base).toBe(stageArgs.base);
});

test("F3: 증명 게이트는 implement뿐 아니라 review에서도 돈다", async () => {
  const h = { ...stageHarness, commands: { ...stageHarness.commands, proof: { coverage: "cov", coverage_report: "cov.json" } }, gates: { ...stageHarness.gates, full: ["unit", "diff_coverage"] } };
  const run = makeFakeRun([unitOk, { match: (c, a) => c === "bash" && a[1] === "cov", result: { code: 2, stdout: "", stderr: "" } }, diffOf("M\tsrc/a.js\n"), revParse]);
  const r = await runStageGates({ run, cwd: stageCwd, harness: h, stage: "review", tier: "standard", base: stageArgs.base, readFile: () => null });
  expect(r.gates.diff_coverage.status).toBe("RED");
  expect(r.gates.diff_coverage.log).toContain("coverage command failed");
  expect(r.gates["prove-test"]).toBeUndefined();                   // 증명 게이트만 돌고 prove-test는 implement 전용
});

test("F7: 격리 항목의 consecutive_passes는 게이트 실행마다 갱신되고 저장된다", async () => {
  const run = makeFakeRun([{ match: (c, a) => c === "bash" && a[1] === "vitest --json", result: bad }, diffNames, revParse]);
  const saved = [];
  const q = { quarantined: [
    { id: "test/a.test.js::flaky one", since: "2026-09-01T00:00:00Z", consecutive_passes: 4 },
    { id: "test/b.test.js::calm", since: "2026-09-01T00:00:00Z", consecutive_passes: 2 },
  ] };
  const h = { ...stageHarness, gates: { ...stageHarness.gates, full: ["unit"] } };
  const r = await runStageGates({ run, cwd: stageCwd, harness: h, stage: "review", tier: "standard", base: stageArgs.base, quarantine: q, readFile: readUnit, saveQuarantine: async (x) => saved.push(x) });
  expect(r.quarantine_updates).toEqual([
    { id: "test/a.test.js::flaky one", passed: false, consecutive_passes: 0 },   // 이번에도 실패 → 0으로 리셋
    { id: "test/b.test.js::calm", passed: true, consecutive_passes: 3 },         // 계속 통과 → 복귀에 한 걸음
  ]);
  expect(saved).toHaveLength(1);
  expect(saved[0].quarantined.find((x) => x.id === "test/b.test.js::calm").consecutive_passes).toBe(3);
});

test("F7: 리포트를 하나도 못 읽었으면 격리 통계를 건드리지 않는다 — 안 돌린 것은 통과가 아니다", async () => {
  const run = makeFakeRun([unitOk, diffNames, revParse]);
  const saved = [];
  const q = { quarantined: [{ id: "test/b.test.js::calm", since: "2026-09-01T00:00:00Z", consecutive_passes: 2 }] };
  const h = { ...stageHarness, gates: { ...stageHarness.gates, full: ["unit"] } };
  const r = await runStageGates({ run, cwd: stageCwd, harness: h, stage: "review", tier: "standard", base: stageArgs.base, quarantine: q, readFile: () => null, saveQuarantine: async (x) => saved.push(x) });
  expect(r.quarantine_updates).toBeUndefined();
  expect(saved).toHaveLength(0);
});

// ── F3: required는 "선택된 레벨 안에서, 돌아서 GREEN이었는가"를 묻는다(§6.2) ──────
// spec 기준 하네스: required는 8개 상위집합, fast(3)/full(6)/deep(8)은 그 부분집합이다.
const specHarness = {
  harness: { maturity: "M2" },
  commands: { lint: "npm run lint", typecheck: "tsc", unit: "vitest run", integration: "vitest run --project integration", build: "npm run build", e2e: "playwright test", proof: {} },
  gates: {
    required: ["lint", "typecheck", "unit", "integration", "build", "e2e", "diff_coverage", "mutation"],
    fast: ["lint", "typecheck", "unit"],
    full: ["lint", "typecheck", "unit", "integration", "build", "e2e"],
    deep: ["lint", "typecheck", "unit", "integration", "build", "e2e", "diff_coverage", "mutation"],
    thresholds: {},
  },
  test: {},
};

test("F3: fast 레벨은 목록 밖 required를 묻지 않는다 — 목록에 있는 것만 GREEN이면 fast도 GREEN", async () => {
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh("vitest run", ok)]);
  const r = await runGates({ run, cwd: "/repo", harness: specHarness, level: "fast", quarantine: { quarantined: [] }, readFile: () => null });
  expect(r.status).toBe("GREEN");
  expect(r.required_missing).toEqual([]);
});

test("F3: full 레벨도 마찬가지로 목록에 있는 required가 전부 GREEN이면 GREEN", async () => {
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh("vitest run", ok), sh("vitest run --project integration", ok), sh("npm run build", ok), sh("playwright test", ok)]);
  const r = await runGates({ run, cwd: "/repo", harness: specHarness, level: "full", quarantine: { quarantined: [] }, readFile: () => null });
  expect(r.status).toBe("GREEN");
  expect(r.required_missing).toEqual([]);
});

test("F3: 레벨 목록 안의 required 게이트에 명령이 없으면 MISCONFIGURED", async () => {
  const h = { ...specHarness, commands: { ...specHarness.commands, integration: undefined } };
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh("vitest run", ok), sh("npm run build", ok), sh("playwright test", ok)]);
  const r = await runGates({ run, cwd: "/repo", harness: h, level: "full", quarantine: { quarantined: [] }, readFile: () => null });
  expect(r.status).toBe("MISCONFIGURED");
  expect(r.required_missing).toEqual(["integration"]);
});

test("F3: 레벨 목록 안의 required 게이트가 SKIPPED로 남으면 MISCONFIGURED", async () => {
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh("vitest run", ok), sh("vitest run --project integration", ok), sh("npm run build", ok), sh("playwright test", ok)]);
  const r = await runGates({ run, cwd: "/repo", harness: specHarness, level: "deep", quarantine: { quarantined: [] }, readFile: () => null });
  expect(r.skipped).toEqual(expect.arrayContaining(["diff_coverage", "mutation"]));
  expect(r.status).toBe("MISCONFIGURED");
  expect(r.required_missing).toEqual(expect.arrayContaining(["diff_coverage", "mutation"]));
});

test("F3: required 게이트가 SKIPPED여도 MISCONFIGURED", async () => {
  const h = { ...harness, gates: { ...harness.gates, required: ["lint", "diff_coverage"], full: ["lint", "diff_coverage"] } };
  const run = makeFakeRun([{ match: () => true, result: ok }]);
  const r = await runGates({ run, cwd: "/repo", harness: h, level: "full", quarantine: { quarantined: [] }, readFile: () => null });
  expect(r.skipped).toEqual(["diff_coverage"]);
  expect(r.status).toBe("MISCONFIGURED");
  expect(r.required_missing).toEqual(["diff_coverage"]);
});

test("F3: 레벨 목록이 비어 있으면 GREEN이 아니라 MISCONFIGURED다", async () => {
  const run = makeFakeRun([{ match: () => true, result: ok }]);
  for (const gates of [{ required: [], fast: [], thresholds: {} }, { required: [], thresholds: {} }]) {
    const r = await runGates({ run, cwd: "/repo", harness: { ...harness, gates }, level: "fast", quarantine: { quarantined: [] }, readFile: () => null });
    expect(r.status).toBe("MISCONFIGURED");
    expect(r.misconfigured).toContain("<level list empty>");
  }
});

test("SKIPPED/MISCONFIGURED 엔트리도 다른 게이트와 같은 모양(code/duration_ms/log)을 갖는다", async () => {
  const h = { ...harness, commands: { ...harness.commands, integration: undefined } };
  const run = makeFakeRun([{ match: () => true, result: ok }]);
  const r = await runGates({ run, cwd: "/repo", harness: h, level: "full", quarantine: { quarantined: [] }, readFile: () => null });
  expect(r.gates.integration).toEqual({ status: "MISCONFIGURED", code: null, duration_ms: 0, log: "commands.integration missing" });
  expect(r.gates.diff_coverage).toEqual({ status: "SKIPPED", code: null, duration_ms: 0, log: expect.stringContaining("proof gate") });
});

test("리포트가 격리 대상 아닌 실패를 보여주면 exit 0이어도 RED다", async () => {
  const report = JSON.stringify({ numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, testResults: [{ name: "/repo/test/a.test.js", assertionResults: [{ fullName: "real failure", status: "failed" }] }] });
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh(harness.commands.unit, ok)]);   // 명령은 exit 0 — 리포터가 삼켰다
  const r = await runGates({ run, cwd: "/repo", harness, level: "fast", quarantine: { quarantined: [] }, readFile: (p) => (p.endsWith("unit.json") ? report : null) });
  expect(r.gates.unit.status).toBe("RED");
  expect(r.status).toBe("RED");
  expect(r.tests.failing.map((f) => f.id)).toEqual(["test/a.test.js::real failure"]);
});

test("recomputeStatus recomputes after a caller mutates result.gates", async () => {
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh(harness.commands.unit, ok), sh("vitest run --project integration", ok), sh("npm run build", ok)]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "full", quarantine: { quarantined: [] }, readFile: () => null });
  expect(r.status).toBe("GREEN");
  r.gates.unit.status = "RED";
  const r2 = recomputeStatus(r, harness);
  expect(r2.status).toBe("RED");
  expect(r2.failing).toContain("unit");
});
