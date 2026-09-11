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
  if (r.code !== 0) return { ok: false, detail: `coverage command failed (exit ${r.code})`, command_code: r.code };
  const text = readFile(`${cwd}/${report}`);
  if (!text) return { ok: false, detail: `coverage report not found at ${report}`, command_code: r.code };
  const changed = await changedLines({ run, cwd, base });
  const res = diffCoverage({ changedLines: changed, covered: coveredLines(JSON.parse(text), cwd), threshold: harness.gates.thresholds.diff_coverage_pct, sourceFilter: (f) => matchesAny(harness.test.source_glob, f) });
  return { ...res, command_code: r.code, threshold: harness.gates.thresholds.diff_coverage_pct };
}
