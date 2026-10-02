import { test, expect } from "vitest";
import { parseVitestJson } from "../lib/parsers/vitest-json.js";
import { coveredLines } from "../lib/parsers/istanbul-json.js";
import { mutationScore } from "../lib/parsers/stryker-json.js";
import { parseMarkers } from "../lib/parsers/marker.js";

test("vitest json → failing ids", () => {
  const j = { numTotalTests: 3, numPassedTests: 2, numFailedTests: 1, testResults: [
    { name: "/repo/test/a.test.js", assertionResults: [{ fullName: "a works", status: "passed" }, { fullName: "a edge", status: "failed" }] },
    { name: "/repo/test/b.test.js", assertionResults: [{ fullName: "b", status: "passed" }] } ] };
  const r = parseVitestJson(JSON.stringify(j), "/repo");
  expect(r).toEqual({ total: 3, passed: 2, failed: 1, failing: [{ id: "test/a.test.js::a edge", file: "test/a.test.js", name: "a edge" }] });
  expect(parseVitestJson("not json", "/repo")).toEqual({ total: 0, passed: 0, failed: 0, failing: [], error: "unparseable" });
});

test("istanbul coverage-final → covered lines per file (repo-relative)", () => {
  const j = { "/repo/src/x.js": { statementMap: { "0": { start: { line: 3 }, end: { line: 4 } }, "1": { start: { line: 9 }, end: { line: 9 } } }, s: { "0": 2, "1": 0 } } };
  const m = coveredLines(j, "/repo");
  expect([...m.get("src/x.js")].sort()).toEqual([3, 4]);
});

test("stryker mutation.json → score", () => {
  const j = { files: { "src/x.js": { mutants: [{ status: "Killed" }, { status: "Killed" }, { status: "Survived" }, { status: "Timeout" }, { status: "NoCoverage" }, { status: "Ignored" }, { status: "CompileError" }] } } };
  expect(mutationScore(j)).toEqual({ killed: 2, timeout: 1, survived: 1, noCoverage: 1, total: 5, score: 60 });
  expect(mutationScore({ files: {} }).score).toBe(null);
});

test("markers", () => {
  expect(parseMarkers("noise\nMUTATION_SCORE=72.5\nFOO=bar baz\nlower=no\n")).toEqual({ MUTATION_SCORE: "72.5", FOO: "bar baz" });
});
