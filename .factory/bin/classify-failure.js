#!/usr/bin/env node
/**
 * 로컬 진단용: 실패한 테스트가 이 변경이 깨뜨린 것인지(red/introduced), 원래 흔들리던 것인지(flaky-existing),
 * 아니면 판정 자체가 불가능한지(blocked)를 base 워크트리와 비교해 가른다.
 * usage: classify-failure.js "<file>::<test full name>" [...ids] [--base <sha>]
 * exit: 0 전부 flaky-existing / 1 red·introduced 있음 / 2 blocked 있음(판정 불가)
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { loadHarness } from "../lib/config.js";
import { changedFiles } from "../lib/changed-files.js";
import { classifyFailures } from "../lib/classify-failure.js";

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const bi = args.indexOf("--base");
  const ids = args.filter((a, i) => !(a === "--base" || (bi >= 0 && i === bi + 1)));
  const usage = 'usage: classify-failure.js "<file>::<test full name>" [...] [--base <sha>]';
  if (ids.includes("-h") || ids.includes("--help")) { console.log(usage); process.exit(0); }
  if (!ids.length) { console.error(usage); process.exit(1); }
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  let harness;
  try { harness = loadHarness(root); } catch (e) { console.error(`classify-failure: .factory/harness.toml unreadable — ${e.message}`); process.exit(2); }
  const base = bi >= 0 ? args[bi + 1] : (await run("git", ["merge-base", `origin/${harness.project?.default_branch || "main"}`, "HEAD"], { cwd: root })).stdout.trim();
  const failing = ids.map((id) => { const i = id.indexOf("::"); return i < 0 ? { id, file: id, name: "" } : { id, file: id.slice(0, i), name: id.slice(i + 2) }; });
  const changed = await changedFiles({ run, cwd: root, base, harness });
  const cls = await classifyFailures({ run, cwd: root, harness, failing, base, thresholds: harness.gates.thresholds, addedTests: changed.addedTests });
  console.log(JSON.stringify(cls, null, 2));
  process.exit(cls.some((c) => c.verdict === "blocked") ? 2 : cls.some((c) => c.verdict === "red" || c.verdict === "introduced") ? 1 : 0);
}
