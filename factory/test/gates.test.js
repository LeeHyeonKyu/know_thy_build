import { test, expect, vi } from "vitest";
import { runGates, verdictLine, recomputeStatus, runStageGates, levelForTier, reUpTestEnv } from "../lib/gates.js";
import { makeFakeRun } from "../lib/exec.js";
import { mkdtempSync, readFileSync } from "node:fs";
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

// ── KTB-21: 게이트가 [commands]를 돌리기 전에 test env를 한 번 더 re-up한다(멱등) ────────────────
// 데모 #18: qa 리뷰어가 증거 수집 중 env를 내렸고, 28분 뒤 게이트가 죽은 env에 대고 돌아 4/4 승인인데도
// unit이 RED였다. 훅(deny-all-writes.sh)이 그 세션 안의 명령은 이제 막지만, 게이트 자신도 방어해야
// 한다 — 다른 경로로 env가 내려가 있어도 "죽은 env에 대고 돈 GREEN/RED"를 신뢰하면 안 된다.

test("reUpTestEnv: harness.test.env.compose가 없으면 아무것도 부르지 않는다", async () => {
  const run = makeFakeRun([{ match: () => true, result: bad }]);   // 불렸으면 실패했을 것 — 안 불렸는지 확인
  const r = await reUpTestEnv({ run, cwd: "/repo", harness: {} });
  expect(r).toEqual({ ran: false, ok: true });
  expect(run.calls).toEqual([]);
});

test("reUpTestEnv: compose가 있으면 .factory/bin/test-env.js up을 부른다 — 성공/실패 모두 detail을 싣는다", async () => {
  const h = { test: { env: { compose: "docker-compose.test.yml" } } };
  const runOk = makeFakeRun([{ match: (c, a) => c === "node" && a[0] === ".factory/bin/test-env.js" && a[1] === "up", result: ok }]);
  expect(await reUpTestEnv({ run: runOk, cwd: "/repo", harness: h })).toEqual({ ran: true, ok: true, detail: "" });

  const runBad = makeFakeRun([{ match: (c, a) => c === "node" && a[0] === ".factory/bin/test-env.js" && a[1] === "up", result: { code: 2, stdout: "", stderr: "test-env: BLOCKED — compose: exit 1" } }]);
  const r = await reUpTestEnv({ run: runBad, cwd: "/repo", harness: h });
  expect(r.ran).toBe(true); expect(r.ok).toBe(false);
  expect(r.detail).toContain("compose: exit 1");
});

test("runStageGates: re-up 실패 → [commands]는 한 줄도 돌지 않고 BLOCKED(판정 불가)", async () => {
  const h = { ...stageHarness, test: { ...stageHarness.test, env: { compose: "docker-compose.test.yml" } } };
  const run = makeFakeRun([
    { match: (c, a) => c === "node" && a[0] === ".factory/bin/test-env.js" && a[1] === "up", result: { code: 2, stdout: "", stderr: "test-env: BLOCKED — compose: exit 1: service db failed to start" } },
    revParse,
    { match: () => true, result: bad },   // 불렸으면 [commands]가 돈 것 — 안 돌았는지 확인
  ]);
  const r = await runStageGates({ run, cwd: stageCwd, harness: h, stage: "review", tier: "standard", base: "b".repeat(40), readFile: () => null });
  expect(r.status).toBe("BLOCKED");
  expect(r.blocked_reason).toMatch(/test-env re-up failed.*service db failed to start/);
  expect(r.test_env_reup).toEqual({ ran: true, ok: false, detail: expect.stringContaining("service db failed to start") });
  expect(r.gates).toEqual({});
  expect(run.calls.some((c) => c.cmd === "bash")).toBe(false);   // vitest --json은 한 번도 안 불렸다
});

test("runStageGates: re-up 성공은 (compose가 있을 때만) 결과에 test_env_reup으로 남는다", async () => {
  const h = { ...stageHarness, test: { ...stageHarness.test, env: { compose: "docker-compose.test.yml" } } };
  const run = makeFakeRun([
    { match: (c, a) => c === "node" && a[0] === ".factory/bin/test-env.js" && a[1] === "up", result: ok },
    unitOk, diffOf("M\tsrc/a.js\n"), revParse,
  ]);
  const r = await runStageGates({ run, cwd: stageCwd, harness: h, stage: "review", tier: "standard", base: "b".repeat(40), readFile: () => null });
  expect(r.test_env_reup).toEqual({ ran: true, ok: true, detail: "" });
  expect(r.status).toBe("GREEN");

  // compose가 없는 하네스(기존 동작)는 test_env_reup이 "부르지 않았다"로 남는다.
  const run2 = makeFakeRun([unitOk, diffOf("M\tsrc/a.js\n"), revParse]);
  const r2 = await runStageGates({ run: run2, cwd: stageCwd, harness: stageHarness, stage: "review", tier: "standard", base: "b".repeat(40), readFile: () => null });
  expect(r2.test_env_reup).toEqual({ ran: false, ok: true });
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

// ── ADR-020 fix round 1: 게이트 하위 프로세스에서 자격증명이 빠진다 ─────────────────
// `[commands]`는 PR이 쓴 코드다. merge 잡의 토큰이 그 안에 있으면 게이트 스크립트가
// `gh pr merge`로 보호 경로 검사를 건너뛸 수 있다 — runStageGates가 실행기를 한 번 감싼다.

const TOKENS = ["GH_TOKEN", "GITHUB_TOKEN", "FACTORY_BOT_TOKEN", "FACTORY_MERGE_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];

test("runStageGates scrubs merge-capable credentials from every child process it spawns", async () => {
  const scrubHarness = {
    harness: { maturity: "M0" },
    commands: { unit: "vitest --json" },
    gates: { required: ["unit"], fast: ["unit"], full: ["unit"], deep: ["unit"], thresholds: {} },
    test: { unit_report: ".factory/out/unit.json", test_glob: ["test/**"], source_glob: ["src/**"] },
  };
  const run = makeFakeRun([
    { match: (c, a) => c === "bash" && a[1] === "vitest --json", result: ok },
    diffNames, revParse,
  ]);
  const r = await runStageGates({ run, cwd: stageCwd, harness: scrubHarness, stage: "merge", tier: "docs", base: "b".repeat(40), issue: 7, readFile: () => null });
  expect(r.status).toBe("GREEN");
  expect(run.calls.length).toBeGreaterThan(0);
  for (const { cmd, args, opts } of run.calls) {
    const where = `${cmd} ${args.join(" ")}`;
    expect(opts.replaceEnv, where).toBe(true);                 // process.env가 다시 얹히지 않는다
    for (const k of TOKENS) expect(opts.env, `${where} / ${k}`).not.toHaveProperty(k);
    expect(opts.env.PATH, where).toBeTruthy();                 // 환경은 지우지 않는다 — 자격증명만 뺀다
  }
  // 게이트 명령 자체도 그 환경으로 돌았다(git 호출만 스크럽된 것이 아니다)
  expect(run.calls.some((c) => c.cmd === "bash" && c.args[1] === "vitest --json")).toBe(true);
});

// ── ADR-020 KTB-35 — 명령은 exit≠0인데 리포트의 실패 테스트는 0개 ───────────────────────────────
//
// 라이브: KTB #3 implement R2(run 34809992796)에서 `unit` 게이트가 code 1로 RED인데 `unit.json`은
// 1715/1715 통과였다(그 전 publish CI에서는 vitest가 포크된 워커의 console.error에서 `write EPIPE`로
// 죽었다). 판정은 그대로 RED다(fail closed — 무엇이 죽었는지 모르는 채 GREEN으로 부르지 않는다).
// 바뀌는 것은 **사람이 받는 문장**이다: "failing=unit"은 테스트가 깨졌다고 말하지만, 깨진 테스트는
// 하나도 없었다.
const REPORT_ALL_PASS = JSON.stringify({ numTotalTests: 1715, numPassedTests: 1715, numFailedTests: 0, testResults: [] });

test("KTB-35: exit≠0 with 0 failing tests stays RED but says why, and carries the stderr tail", async () => {
  const stderr = "Error: write EPIPE\n    at afterWriteDispatched (node:internal/stream_base_commons:161:15)";
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh(harness.commands.unit, { code: 1, stdout: "", stderr })]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "fast", quarantine: { quarantined: [] }, readFile: (p) => (p.endsWith("unit.json") ? REPORT_ALL_PASS : null) });
  expect(r.status).toBe("RED");                                  // fail closed — 뒤집지 않는다
  expect(r.failing).toEqual(["unit"]);
  expect(r.gates.unit.status).toBe("RED");
  expect(r.gates.unit.reason).toBe("command exited 1 with 0 failing tests — unhandled error outside tests (see gate log)");
  expect(r.gates.unit.log).toContain("write EPIPE");
});

test("KTB-35: the captured tail is the last 20 stderr lines, scrubbed of secrets", async () => {
  const stderr = [...Array(30)].map((_, i) => `line ${i + 1}`).concat([`token ghp_${"a".repeat(30)} leaked`]).join("\n");
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh(harness.commands.unit, { code: 1, stdout: "", stderr })]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "fast", quarantine: { quarantined: [] }, readFile: (p) => (p.endsWith("unit.json") ? REPORT_ALL_PASS : null) });
  const log = r.gates.unit.log;
  expect(log.split("\n")).toHaveLength(20);
  expect(log).toContain("line 30");
  expect(log).not.toContain("line 11");
  expect(log).not.toContain("ghp_");
  expect(log).toContain("[REDACTED:gh-token]");
});

test("KTB-35: an ordinary RED (the report names failing tests) carries no unhandled reason", async () => {
  const report = JSON.stringify({ numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, testResults: [{ name: "/repo/test/a.test.js", assertionResults: [{ fullName: "broken", status: "failed" }] }] });
  const run = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh(harness.commands.unit, bad)]);
  const r = await runGates({ run, cwd: "/repo", harness, level: "fast", quarantine: { quarantined: [] }, readFile: (p) => (p.endsWith("unit.json") ? report : null) });
  expect(r.gates.unit.status).toBe("RED");
  expect(r.gates.unit.reason).toBeUndefined();
  // 리포트를 아예 못 읽은 RED도 이 경로가 아니다 — 그 RED의 이유는 "모른다"이지 "테스트 밖 오류"가 아니다.
  const blind = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh(harness.commands.unit, bad)]);
  const rb = await runGates({ run: blind, cwd: "/repo", harness, level: "fast", quarantine: { quarantined: [] }, readFile: () => null });
  expect(rb.gates.unit.reason).toBeUndefined();
  // 명령이 exit 0인데 리포트에 실패가 있는 경우(리포터가 삼킴)도 그대로 RED이고, 이 사유는 아니다.
  const swallowed = makeFakeRun([sh("npm run lint", ok), sh("tsc", ok), sh(harness.commands.unit, ok)]);
  const rs = await runGates({ run: swallowed, cwd: "/repo", harness, level: "fast", quarantine: { quarantined: [] }, readFile: (p) => (p.endsWith("unit.json") ? report : null) });
  expect(rs.gates.unit.status).toBe("RED");
  expect(rs.gates.unit.reason).toBeUndefined();
});

/**
 * KTB-35 ①: 워커가 파이프가 끊긴 stdout/stderr에 테스트 콘솔 출력을 쓰다 죽는 것이 원인이었다
 * (`Error: write EPIPE` from console.error in a forked worker). `silent: true`가 그 쓰기를 막는다 —
 * 리포터 출력(그리고 JSON 리포터 **파일**)은 그대로다. 이 저장소 자신의 `unit` 게이트가 그 파일을
 * 읽으므로, 설정과 하네스 명령은 서로를 붙들어야 한다.
 */
test("KTB-35: the repo's own vitest config is silent, and the JSON report file is untouched", async () => {
  const cfg = readFileSync(new URL("../../vitest.config.js", import.meta.url), "utf8");
  expect(cfg).toMatch(/silent:\s*true/);
  const toml = readFileSync(new URL("../../.factory/harness.toml", import.meta.url), "utf8");
  expect(toml).toContain("--reporter=json");
  expect(toml).toContain("--outputFile=.factory/out/unit.json");
});
