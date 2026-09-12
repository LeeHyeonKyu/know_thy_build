#!/usr/bin/env node
/**
 * 로컬 진단용: 이번 변경의 새 테스트가 (1) base에서 실패하는가(= 무언가를 증명하는가),
 * (2) 반복 실행에서 흔들리지 않는가.
 * usage: prove-test.js [--base <sha>]
 * exit: 0 둘 다 통과 / 1 하나라도 실패
 */
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { loadHarness } from "../lib/config.js";
import { changedFiles } from "../lib/changed-files.js";
import { proveTest, repeatNewTests } from "../lib/prove-test.js";

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) { console.log("usage: prove-test.js [--base <sha>]"); process.exit(0); }
  const bi = args.indexOf("--base");
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  let harness;
  try { harness = loadHarness(root); } catch (e) { console.error(`prove-test: .factory/harness.toml unreadable — ${e.message}`); process.exit(1); }
  const base = bi >= 0 ? args[bi + 1] : (await run("git", ["merge-base", `origin/${harness.project?.default_branch || "main"}`, "HEAD"], { cwd: root })).stdout.trim();
  const changed = await changedFiles({ run, cwd: root, base, harness });
  // 스테이지 경로(runStageGates)와 같은 대상: 추가(A)뿐 아니라 **수정·rename된 테스트 파일**까지다
  // (§5.2.4). 진단이 스테이지와 다른 답을 내면 진단으로서 쓸모가 없다.
  const prove_test = await proveTest({ run, cwd: root, harness, base, addedTests: changed.tests });
  const new_test_repeat = await repeatNewTests({ run, cwd: root, harness, addedTests: changed.tests, times: harness.gates.thresholds.new_test_repeats });
  console.log(JSON.stringify({ base, changed_tests: changed.tests, added_tests: changed.addedTests, prove_test, new_test_repeat }, null, 2));
  process.exit(prove_test.ok && new_test_repeat.ok ? 0 : 1);
}
