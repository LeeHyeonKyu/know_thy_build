import { relative } from "node:path";
export function parseVitestJson(text, root = process.cwd()) {
  let j; try { j = JSON.parse(text); } catch { return { total: 0, passed: 0, failed: 0, failing: [], error: "unparseable" }; }
  const failing = [];
  // #157 — a test FILE can fail with no failed assertion (it did not load, or a suite-level hook threw): vitest
  // writes `status:"failed"` + `message` on the testResults entry and counts it in numFailedTestSuites only.
  // `failing` never names it, so it is reported apart — a reader that treats `failing` as the whole RED would
  // otherwise miss it. Present only when non-empty (additive: existing readers see the same object).
  const failedSuites = [];
  for (const tr of j.testResults || []) {
    const file = relative(root, tr.name);
    let any = false;
    for (const a of tr.assertionResults || []) if (a.status === "failed") { any = true; failing.push({ id: `${file}::${a.fullName}`, file, name: a.fullName }); }
    if (tr.status === "failed" && !any && !failedSuites.includes(file)) failedSuites.push(file);
  }
  return { total: j.numTotalTests ?? 0, passed: j.numPassedTests ?? 0, failed: j.numFailedTests ?? failing.length, failing, ...(failedSuites.length ? { failed_suites: failedSuites } : {}) };
}
