import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { q } from "./prove-test.js";

/**
 * **new-test mutation check — the DUAL of prove-test (Structure D', spec §4).**
 *
 * prove-test proves a new test fails WITHOUT the implementation (run it on the base worktree, expect
 * red). This proves a new test fails when the asserted PROPERTY is violated: apply a cheap structural
 * mutation to the SOURCE the test exercises and confirm the test goes red. A test that stays GREEN
 * under mutation is a `survivor` — it asserts nothing / is not fail-closed (own-cal R1 cf1: deleting
 * the safety warning still passed 5/5). Deterministic, no LLM.
 *
 * **This deliberately UNDER-fires (structural, not semantic).** The mutations are text transforms, not
 * a real mutation engine (no Stryker AST, no coverage-guided operator selection). A test can be a real
 * asserting test and still survive one of these mutations (the mutation didn't touch what it asserts),
 * and a mutation can turn a source uncompilable and make an honest test go red for the wrong reason.
 * Both are acceptable: the check's job is to catch the *blatant* "asserts nothing" case cheaply, before
 * review — never to certify that a test is complete. A found survivor is a real signal; the absence of
 * survivors is not a proof of quality.
 */

const defaultRead = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const defaultWrite = (p, c) => writeFileSync(p, c);

/** A path that looks like a test/spec file — never a mutation target (we mutate the SOURCE under test). */
const isTestPath = (p) => /\.(test|spec)\./.test(p);

/**
 * The mutation set (ordered, deterministic). Each mutator changes the FIRST eligible occurrence and is
 * applied cumulatively on top of the previous — so a source can carry several small mutations at once,
 * maximising the chance a fail-closed test notices at least one. Every transform is syntax-preserving
 * (a broken parse would turn *every* test red and hide survivors), and all deliberately shallow:
 *   1. boolean  — first `true`/`false` literal is flipped
 *   2. comparison — first `===`/`!==`/`==`/`!=`/`<=`/`>=` operator is inverted (bare `<`/`>` are left
 *                   alone: they collide with generics/JSX/arrows and would break syntax)
 *   3. string   — first non-import string literal's contents are replaced with the `__MUTATED__`
 *                 sentinel (import/require/from lines are skipped so module resolution still works —
 *                 this is the mutator that kills own-cal R1 cf1: the asserted warning text)
 *   4. numeric  — first standalone integer literal is bumped by one
 *   5. logical  — first `&&` becomes `||`
 * Keep this list and its stated limits in sync with the harness.toml comment.
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

/** Apply the whole mutation set. Returns `{ mutated, applied }`; `applied` is empty when nothing changed. */
export function mutateSource(text) {
  let mutated = text;
  const applied = [];
  for (const [name, fn] of MUTATORS) {
    const next = fn(mutated);
    if (next != null && next !== mutated) { mutated = next; applied.push(name); }
  }
  return { mutated, applied };
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
 * `checkNewTestsFailOnMutation({ root, newTests, run, harness }) → { ok, survivors, skipped }`.
 *
 * For each new/changed test, mutate the source it asserts on (in a throwaway worktree, so the real
 * tree is never touched) and run just that test file. Green under mutation → survivor. Restores every
 * mutated source and removes the worktree on every path (try/finally), exactly like prove-test.
 *
 * `newTests` entries are either a test-file path string or `{ file, target? }` (an explicit target
 * skips import resolution). `run` is the injected async command runner (git + the harness test command),
 * so tests can drive it with a double. `ok` is `survivors.length === 0`.
 */
export async function checkNewTestsFailOnMutation({
  root, newTests, run, harness,
  ref = "HEAD",
  tmp = join(root, ".factory/out/mutation-wt"),
  exists = existsSync, readFile = defaultRead, writeFile = defaultWrite,
}) {
  const testFilesCmd = harness?.commands?.test_files;
  // No per-file test command → we cannot run a single test, so we cannot say anything. Like prove-test,
  // that is a harness setup error, not a pass and not a survivor.
  if (!testFilesCmd) return { ok: false, misconfigured: true, survivors: [], skipped: [], detail: "commands.test_files missing" };
  const entries = (newTests || []).map((e) => (typeof e === "string" ? { file: e } : e));
  if (!entries.length) return { ok: true, survivors: [], skipped: [], detail: "no new tests" };

  const survivors = [], skipped = [], checked = [];
  const g = (args) => run("git", args, { cwd: root });
  const add = await g(["worktree", "add", "--detach", tmp, ref]);
  // Couldn't build the worktree → couldn't check. Report as skipped; do NOT fail closed (that would
  // block legitimate work on an infra hiccup — spec's "deliberately under-fires" stance).
  if (add.code !== 0) {
    for (const e of entries) skipped.push({ file: e.file, reason: `worktree add failed: ${add.stderr || add.code}` });
    return { ok: true, survivors, skipped };
  }
  try {
    for (const e of entries) {
      const targets = e.target ? [e.target] : resolveTargets({ testFile: e.file, tmp, exists, readFile });
      if (!targets.length) { skipped.push({ file: e.file, reason: "no resolvable source target for the assertion" }); continue; }
      const mutations = [];
      for (const tgt of targets) {
        const orig = readFile(join(tmp, tgt));
        if (orig == null) continue;
        const { mutated, applied } = mutateSource(orig);
        if (!applied.length) continue;
        mutations.push({ tgt, orig, mutated, applied });
      }
      if (!mutations.length) { skipped.push({ file: e.file, reason: "no applicable structural mutation in target(s)" }); continue; }
      for (const mu of mutations) writeFile(join(tmp, mu.tgt), mu.mutated);
      let r;
      try {
        const cmd = testFilesCmd.replaceAll("{files}", q(e.file));
        r = await run("bash", ["-lc", cmd], { cwd: tmp });
      } finally {
        for (const mu of mutations) writeFile(join(tmp, mu.tgt), mu.orig); // restore the source on every path
      }
      checked.push({ file: e.file, targets: mutations.map((mu) => mu.tgt) });
      if (r.code === 0) {
        survivors.push({ file: e.file, targets: mutations.map((mu) => mu.tgt), mutations: [...new Set(mutations.flatMap((mu) => mu.applied))] });
      }
    }
  } finally {
    await g(["worktree", "remove", "--force", tmp]);
  }
  return { ok: survivors.length === 0, survivors, skipped, checked };
}
