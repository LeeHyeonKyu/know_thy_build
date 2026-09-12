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
