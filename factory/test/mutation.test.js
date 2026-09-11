import { test, expect } from "vitest";
import { mutationGate } from "../lib/mutation.js";
import { makeFakeRun } from "../lib/exec.js";

const H = (proof) => ({ commands: { proof }, gates: { thresholds: { mutation_score_pct: 70 } } });
const report = JSON.stringify({ files: { "src/a.js": { mutants: [{ status: "Killed" }, { status: "Killed" }, { status: "Killed" }, { status: "Survived" }] } } });

test("stryker report → score vs threshold", async () => {
  const run = makeFakeRun([{ match: (c, a) => c === "bash" && a[1].includes("src/a.js"), result: { code: 0, stdout: "", stderr: "" } }]);
  const r = await mutationGate({ run, cwd: "/repo", harness: H({ mutation: "stryker run --mutate {files}", mutation_report: "reports/mutation/mutation.json" }), changedSources: ["src/a.js"], readFile: () => report });
  expect(r).toMatchObject({ score: 75, ok: true, threshold: 70 });
});
test("marker fallback and threshold failure", async () => {
  const run = makeFakeRun([{ match: (c) => c === "bash", result: { code: 0, stdout: "MUTATION_SCORE=55\n", stderr: "" } }]);
  const r = await mutationGate({ run, cwd: "/repo", harness: H({ mutation: "mutmut run --paths {files}" }), changedSources: ["src/a.py"], readFile: () => null });
  expect(r).toMatchObject({ score: 55, ok: false });
});
test("no changed sources → ok; no command → misconfigured", async () => {
  expect((await mutationGate({ run: makeFakeRun([]), cwd: "/", harness: H({}), changedSources: [], readFile: () => null })).ok).toBe(true);
  expect((await mutationGate({ run: makeFakeRun([]), cwd: "/", harness: H({}), changedSources: ["x"], readFile: () => null })).misconfigured).toBe(true);
});
test("F9: [commands.proof] 블록 자체가 없어도 터지지 않고 MISCONFIGURED다", async () => {
  const bare = { commands: {}, gates: { thresholds: { mutation_score_pct: 70 } } };
  const r = await mutationGate({ run: makeFakeRun([]), cwd: "/", harness: bare, changedSources: ["src/a.js"], readFile: () => null });
  expect(r).toEqual({ ok: false, misconfigured: true, threshold: 70, detail: "commands.proof.mutation missing" });
});
