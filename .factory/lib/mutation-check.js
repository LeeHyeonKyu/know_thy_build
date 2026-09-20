import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { q, baseInstallCommand } from "./prove-test.js";

/**
 * **new-test mutation check — the DUAL of prove-test (Structure D', spec §4).**
 *
 * prove-test proves a new test fails WITHOUT the implementation (run it on the base worktree, expect
 * red). This proves a new test fails when the asserted PROPERTY is violated: apply a cheap structural
 * mutation to the SOURCE the test exercises and confirm the test goes red *because an assertion failed*.
 * A test that stays GREEN under a mutation that actually ran is a `survivor` — it asserts nothing / is
 * not fail-closed (own-cal R1 cf1: deleting the safety warning still passed 5/5). Deterministic, no LLM.
 *
 * **The environment is the whole game (audit M2, the same trap prove-test defends against).** A fresh
 * `git worktree add --detach` is source-only — no `node_modules` — so `npx vitest …` dies with
 * `Cannot find module 'vitest'` and EVERY run is red *for the wrong reason*. If we read "red = the test
 * noticed the mutation," no survivor is ever reported and the check is inert. Two defenses, both
 * mandatory:
 *   1. **Provision the worktree** — run `baseInstallCommand(harness)` after the copy, exactly like
 *      prove-test. Install failure → `misconfigured` for the whole run (not a clear/ok).
 *   2. **Baseline, then classify.** For each test: run it UNMUTATED first; it MUST be green (loads,
 *      passes). If it can't run green unmutated → `inconclusive`/skipped for that test — never a kill,
 *      never a survivor (you cannot judge a test you cannot run). A **kill** = baseline green → mutated
 *      red where the red is an ASSERTION failure. A red that is a module-resolution / parse / SyntaxError
 *      / transform error is `inconclusive` for that mutation (the mutation didn't "run") → try the next
 *      mutator. A **survivor** = baseline green AND at least one mutation ran cleanly (parsed, loaded,
 *      reached assertions) AND the test stayed green.
 *
 * **Operates on the implementer's UNCOMMITTED working changes.** Task 3's self-gate runs BEFORE commit,
 * so the changed sources and new tests do not exist at `base`. Like prove-test copying added tests, this
 * copies the caller's changed SOURCE files and new TEST files from the working tree into the base
 * worktree before installing/running. The caller passes plain paths (`newTests`, `changedSources`).
 *
 * **Deliberately UNDER-fires (structural, not semantic).** The mutations are shallow, syntax-preserving
 * text transforms, NOT a real mutation engine (no AST, no coverage guidance). Only one applicable
 * mutation, chosen by falling through the ordered set on FRESH source, decides kill-vs-survivor. A found
 * survivor is a real signal; the absence of survivors is not proof a test is complete.
 */

const defaultRead = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const defaultWrite = (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };

/** A path that looks like a test/spec file — never a mutation target (we mutate the SOURCE under test). */
const isTestPath = (p) => /\.(test|spec)\./.test(p);

/**
 * A mutated-source run is red **for the wrong reason** — the mutation broke loading/parsing rather than
 * violating the asserted property, so the test never reached its assertions. Such a red is NOT a "kill"
 * (the test did not notice anything); it is `inconclusive` for that mutation and we fall through to the
 * next. Superset of prove-test's `inconclusiveOnBase` (which is about the base worktree lacking deps):
 * a structural mutation can itself produce any SyntaxError, an unexpected token, or a vite transform
 * failure, none of which is evidence the test asserts something.
 */
const WRONG_REASON_RED = [
  /Cannot find module/i,
  /Cannot find package/i,
  /ERR_MODULE_NOT_FOUND/,
  /Cannot use import statement outside a module/i,
  /SyntaxError/i,
  /Unexpected (?:token|identifier|end of)/i,
  /Failed to (?:parse|load|resolve|transform)/i,
  /Transform failed/i,
  /Parse (?:error|failure)/i,
  /does not provide an export named/i,
];
export const isWrongReasonRed = (text) => WRONG_REASON_RED.some((re) => re.test(String(text || "")));

/**
 * The mutation set (ordered, deterministic). Each mutator changes the FIRST eligible occurrence of the
 * ORIGINAL source (NOT cumulatively — a parse-breaking mutation must never poison a later one or mask a
 * survivor). Every transform is syntax-preserving where it can be; the caller falls through the list
 * until one applies AND runs cleanly. Kept in sync with the harness.toml comment:
 *   1. boolean  — first `true`/`false` literal is flipped
 *   2. comparison — first `===`/`!==`/`==`/`!=`/`<=`/`>=` operator is inverted (bare `<`/`>` are left
 *                   alone: they collide with generics/JSX/arrows and would break syntax)
 *   3. string   — first non-import string literal's contents are replaced with the `__MUTATED__`
 *                 sentinel; this is the mutator that kills own-cal R1 cf1 (the asserted warning text).
 *                 NOTE: it swallows a template literal's `${…}` interpolations (the whole `` `…` `` is
 *                 replaced) — under-firing and syntactically safe, but it will not surface a bug that
 *                 lives only inside an interpolation.
 *   4. numeric  — first standalone integer literal is bumped by one
 *   5. logical  — first `&&` becomes `||`
 */
const MUTATORS = [
  ["boolean", (t) => {
    const m = /\b(true|false)\b/.exec(t);
    if (!m) return null;
    const rep = m[1] === "true" ? "false" : "true";
    return t.slice(0, m.index) + rep + t.slice(m.index + m[1].length);
  }],
  ["comparison", (t) => {
    const flip = { "===": "!==", "!==": "===", "==": "!=", "!=": "==", "<=": ">=", ">=": "<=" };
    const m = /===|!==|<=|>=|==|!=/.exec(t);
    if (!m) return null;
    return t.slice(0, m.index) + flip[m[0]] + t.slice(m.index + m[0].length);
  }],
  ["string", (t) => {
    const lines = t.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/\b(?:import|require|from)\b/.test(lines[i])) continue; // never a module path
      const m = /(['"`])(?:\\.|(?!\1).)*\1/.exec(lines[i]);
      if (!m) continue;
      const quote = m[0][0];
      const next = `${quote}__MUTATED__${quote}`;
      if (m[0] === next) continue;
      lines[i] = lines[i].slice(0, m.index) + next + lines[i].slice(m.index + m[0].length);
      return lines.join("\n");
    }
    return null;
  }],
  ["numeric", (t) => {
    const m = /(?<![\w.])\d+(?![\w.])/.exec(t);
    if (!m) return null;
    return t.slice(0, m.index) + String(Number(m[0]) + 1) + t.slice(m.index + m[0].length);
  }],
  ["logical", (t) => {
    const i = t.indexOf("&&");
    if (i < 0) return null;
    return t.slice(0, i) + "||" + t.slice(i + 2);
  }],
];

/** Every applicable single mutation of `text`, each applied to the ORIGINAL (not cumulative): `[{ name, mutated }]`. */
export function structuralMutations(text) {
  const out = [];
  for (const [name, fn] of MUTATORS) {
    const mutated = fn(text);
    if (mutated != null && mutated !== text) out.push({ name, mutated });
  }
  return out;
}

/**
 * The source file(s) a test exercises: its relative (non-test) imports that resolve to a real file in
 * the worktree. Returns worktree-relative paths. Empty → the check cannot target this test (reported
 * as `skipped`, never a survivor — we do not fail closed on "couldn't figure out what to mutate").
 */
export function resolveTargets({ testFile, tmp, exists = existsSync, readFile = defaultRead }) {
  const text = readFile(join(tmp, testFile));
  if (text == null) return [];
  const base = dirname(testFile);
  const found = new Set();
  const re = /(?:from|import|require\s*\()\s*['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text))) {
    const cand = normalize(join(base, m[1]));
    for (const p of [cand, `${cand}.js`, `${cand}.mjs`, `${cand}.ts`, join(cand, "index.js")]) {
      if (isTestPath(p)) continue;
      if (exists(join(tmp, p))) { found.add(p); break; }
    }
  }
  return [...found];
}

/**
 * `checkNewTestsFailOnMutation({ root, newTests, changedSources, run, harness, base }) →
 *   { ok, survivors, skipped, checked, misconfigured?, detail? }`.
 *
 * `ok` is `survivors.length === 0`. `survivors[]` = tests that stayed green under a cleanly-run mutation.
 * `skipped[]` = `{ file, reason }` for tests we could not judge (no target, no applicable mutation,
 * baseline not green, or every mutation only produced wrong-reason red) — never fail-closed. `checked[]`
 * = tests that produced a decisive result (kill or survivor). `misconfigured` (with `detail`) is a
 * whole-run harness error: no `test_files` command, or a base dependency install that failed.
 *
 * `newTests` entries are either a test-file path string or `{ file, target? }` (an explicit target
 * skips import resolution). `changedSources` are the working-tree source paths to copy in so the
 * baseline runs on the implementer's real (uncommitted) code and the mutation target is that code.
 */
export async function checkNewTestsFailOnMutation({
  root, newTests, changedSources = [], run, harness,
  base = "HEAD",
  tmp = join(root, ".factory/out/mutation-wt"),
  exists = existsSync, readFile = defaultRead, writeFile = defaultWrite,
}) {
  const testFilesCmd = harness?.commands?.test_files;
  // No per-file test command → we cannot run a single test, so we cannot say anything. Like prove-test,
  // that is a harness setup error, not a pass and not a survivor.
  if (!testFilesCmd) return { ok: false, misconfigured: true, survivors: [], skipped: [], checked: [], detail: "commands.test_files missing" };
  const entries = (newTests || []).map((e) => (typeof e === "string" ? { file: e } : e));
  if (!entries.length) return { ok: true, survivors: [], skipped: [], checked: [], detail: "no new tests" };

  const survivors = [], skipped = [], checked = [];
  const g = (args) => run("git", args, { cwd: root });
  const runTest = (file) => run("bash", ["-lc", testFilesCmd.replaceAll("{files}", q(file))], { cwd: tmp });
  const skipAll = (reason) => entries.forEach((e) => skipped.push({ file: e.file, reason }));

  // nit 1 — a stale worktree from a crashed prior run would make `add` fail and silently skip every
  // test. Best-effort remove first (ignore its result: a missing worktree is the normal case).
  await g(["worktree", "remove", "--force", tmp]).catch(() => {});
  const add = await g(["worktree", "add", "--detach", tmp, base]);
  // Couldn't build the worktree → couldn't check. Report as skipped; do NOT fail closed (that would
  // block legitimate work on an infra hiccup — spec's "deliberately under-fires" stance).
  if (add.code !== 0) { skipAll(`worktree add failed: ${add.stderr || add.code}`); return { ok: true, survivors, skipped, checked }; }

  try {
    // Overlay the implementer's UNCOMMITTED working files (changed sources + new tests) onto the base
    // worktree — they are not at `base`. prove-test copies added tests for exactly this reason.
    const copySet = [...new Set([...(changedSources || []), ...entries.map((e) => e.file)])];
    for (const f of copySet) {
      const content = readFile(join(root, f));
      if (content != null) writeFile(join(tmp, f), content);
    }

    // audit M2 — a source-only worktree has no runner. Install deps before running anything; a failed
    // install means every run below is meaningless, so the whole check is misconfigured (fail-closed at
    // the harness level, never a silent clear).
    const install = baseInstallCommand(harness, tmp, exists);
    if (install) {
      const ins = await run("bash", ["-lc", install], { cwd: tmp });
      if (ins.code !== 0) {
        skipAll(`base dependency install failed (${install}, exit ${ins.code})`);
        return { ok: false, misconfigured: true, survivors, skipped, checked, detail: `base dependency install failed (${install}, exit ${ins.code}) — mutation runs cannot be judged: ${String(ins.stderr || ins.stdout || "").trim().slice(0, 200)}` };
      }
    }

    for (const e of entries) {
      const targets = e.target ? [e.target] : resolveTargets({ testFile: e.file, tmp, exists, readFile });
      if (!targets.length) { skipped.push({ file: e.file, reason: "no resolvable source target for the assertion" }); continue; }

      // Read the (already-copied) originals and pre-compute their single-mutation variants.
      const attempts = [];
      for (const tgt of targets) {
        const orig = readFile(join(tmp, tgt));
        if (orig == null) continue;
        for (const { name, mutated } of structuralMutations(orig)) attempts.push({ tgt, orig, name, mutated });
      }
      if (!attempts.length) { skipped.push({ file: e.file, reason: "no applicable structural mutation in target(s)" }); continue; }

      // BASELINE — the unmutated test must be green, or we cannot judge it (can't run / red on its own).
      const baseRun = await runTest(e.file);
      if (baseRun.code !== 0) {
        const why = isWrongReasonRed(`${baseRun.stdout || ""}\n${baseRun.stderr || ""}`) ? "could not load/parse in the worktree" : "red at baseline (fails on its own)";
        skipped.push({ file: e.file, reason: `inconclusive — the test is not green unmutated (${why})` });
        continue;
      }

      // Try ALL applicable mutations on FRESH source. Do NOT break on the first survived mutation:
      // mutations are emitted in fixed operator order, independent of file position, so a target that
      // carries an unrelated token (a stray `env === "prod"`) ordered before the value the test pins
      // would be mutated first, survive correctly, and — if we stopped there — falsely brand a genuinely
      // fail-closed test a `survivor` before ever trying the mutation that WOULD kill it (a false
      // positive that blocks legitimate work). The gate's question is "does the test notice ANY
      // mutation": a KILL wins as soon as one cleanly-run mutation goes assertion-red; a SURVIVOR is
      // declared only after EVERY cleanly-run mutation was survived (with ≥1 having run cleanly).
      let kill = null;      // { target, mutation } — first assertion-red seen
      const survived = [];  // mutations that ran cleanly and the test stayed green
      let wrongReason = 0;  // mutations whose red was module/parse/transform — they never ran
      for (const a of attempts) {
        writeFile(join(tmp, a.tgt), a.mutated);
        let r;
        try { r = await runTest(e.file); } finally { writeFile(join(tmp, a.tgt), a.orig); }
        if (r.code === 0) { survived.push({ target: a.tgt, mutation: a.name }); continue; } // test did not notice this one
        if (isWrongReasonRed(`${r.stdout || ""}\n${r.stderr || ""}`)) { wrongReason++; continue; } // never ran — inconclusive
        kill = { target: a.tgt, mutation: a.name }; break; // assertion red → the test noticed a violation → fail-closed
      }

      if (kill) { checked.push({ file: e.file, verdict: "kill", target: kill.target, mutation: kill.mutation }); continue; }
      if (survived.length) {
        const rep = survived[0], names = survived.map((s) => s.mutation);
        checked.push({ file: e.file, verdict: "survivor", target: rep.target, mutation: rep.mutation, survived: names });
        survivors.push({ file: e.file, target: rep.target, mutation: rep.mutation, survived: names });
        continue;
      }
      skipped.push({ file: e.file, reason: `inconclusive — all ${wrongReason} applicable mutation(s) failed to load/parse, none reached assertions` });
    }
  } finally {
    await g(["worktree", "remove", "--force", tmp]);
  }
  return { ok: survivors.length === 0, survivors, skipped, checked };
}
