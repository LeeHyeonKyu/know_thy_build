import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHarness, loadCharter } from "../lib/config.js";
import { buildHouseRules } from "../lib/house-rules.js";

/**
 * Fixtures use the **real** loaders (loadHarness/loadCharter) so the test asserts against the
 * actual object shapes buildHouseRules will get in production — no invented fields. `root` is a
 * temp dir carrying `.factory/harness.toml` + `docs/factory/CHARTER.md` (+ optional `CLAUDE.md`),
 * because the `## Preserve` block and a top-level CLAUDE.md are mined from files, not from the
 * normalized charter object (loadCharter drops both).
 */
const CHARTER = ({ preserve = true, neverAutomate = true } = {}) => `---
schema: factory.charter.v1
status: ready
tier_default: standard
---
# Charter

## Definition of Done
- gates GREEN

${neverAutomate ? `## NEVER_AUTOMATE
- deploy is human: \`.github/workflows/publish.yml\` and the \`version\` field in \`package.json\`
- changing gate thresholds: \`harness.toml [gates.thresholds]\`
` : ""}
${preserve ? `## Preserve (바꾸면 안 되는 동작)
- every stage transition goes through transition.js
- tests are load-bearing (no skips)
` : ""}
## Retro
light_on_merge: true
`;

function fixture({ harness, charter = CHARTER(), claude = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hr-"));
  mkdirSync(join(root, ".factory"), { recursive: true });
  mkdirSync(join(root, "docs/factory"), { recursive: true });
  writeFileSync(join(root, ".factory/harness.toml"), harness);
  writeFileSync(join(root, "docs/factory/CHARTER.md"), charter);
  if (claude != null) writeFileSync(join(root, "CLAUDE.md"), claude);
  return root;
}

const HARNESS = `schema = 1
[project]
name = "demo"
[runtime]
setup = "npm ci"
node = "22"
[commands]
lint = "node bin/lint.js"
unit = "npx vitest run"
test_files = "npx vitest run {files}"
[harness]
maturity = "M0"
[gates]
required = ["lint","unit"]
fast = ["lint","unit"]
full = ["lint","unit"]
deep = ["lint","unit"]
[load_bearing]
paths = ["lib/integrity.js", "lib/merge-stage.js", "bin/run-stage.js"]
`;

test("digest names the run recipe (a [commands] entry) and every load-bearing path", () => {
  const root = fixture({ harness: HARNESS });
  const s = buildHouseRules({ root, charter: loadCharter(root), harness: loadHarness(root) });
  // a command from [commands]
  expect(s).toContain("npx vitest run");
  // the runtime recipe (setup + node version)
  expect(s).toContain("npm ci");
  expect(s).toContain("22");
  // each load-bearing path is named
  for (const p of ["lib/integrity.js", "lib/merge-stage.js", "bin/run-stage.js"]) expect(s).toContain(p);
  // the "must…" list mined from CHARTER ## Preserve
  expect(s).toContain("every stage transition goes through transition.js");
  expect(s).toContain("tests are load-bearing");
});

/**
 * Regression pinned — own-calendar #3 R2 cf1/cf2: the README run recipe pointed at the production
 * API and the server bring-up dropped `prisma migrate`. The class of bug is a required step that
 * exists in the repo but is missing from the recipe the implementer follows. The digest must
 * surface the FULL recipe — every [commands] entry — so a `db:migrate`-style command that is a
 * separate script (not part of the primary run line) is still visible to the reader.
 */
test("regression (own-cal R2): a migrate step present as a separate script is surfaced in the digest", () => {
  const harness = `schema = 1
[runtime]
setup = "npm ci"
node = "22"
[commands]
serve = "node server.js"
migrate = "npx prisma migrate deploy"
unit = "npx vitest run"
[harness]
maturity = "M0"
[gates]
required = ["unit"]
fast = ["unit"]
full = ["unit"]
deep = ["unit"]
[load_bearing]
paths = ["server.js"]
`;
  const root = fixture({ harness });
  const s = buildHouseRules({ root, charter: loadCharter(root), harness: loadHarness(root) });
  // the omission is visible: migrate is in the digest even though the primary "serve" line drops it
  expect(s).toContain("npx prisma migrate deploy");
  expect(s).toContain("migrate");
  // and the serve command too — nothing is silently cherry-picked out of the recipe
  expect(s).toContain("node server.js");
});

test("never throws on a missing ## Preserve / no CLAUDE.md — those sections are just omitted", () => {
  const root = fixture({ harness: HARNESS, charter: CHARTER({ preserve: false }) });
  let s;
  expect(() => { s = buildHouseRules({ root, charter: loadCharter(root), harness: loadHarness(root) }); }).not.toThrow();
  // still a usable digest: recipe + paths survive
  expect(s).toContain("npx vitest run");
  expect(s).toContain("lib/integrity.js");
  // no CLAUDE.md heading when the file is absent
  expect(s).not.toContain("CLAUDE.md");
});

test("NEVER_AUTOMATE globs feed the 'must…' list; a top-level CLAUDE.md is folded in", () => {
  const root = fixture({ harness: HARNESS, claude: "# Project rules\nUse the dev config, never prod.\n" });
  const s = buildHouseRules({ root, charter: loadCharter(root), harness: loadHarness(root) });
  // a NEVER_AUTOMATE **glob** (a token with / or *; `package.json`/`version` are prose, excluded by neverAutomateGlobs)
  expect(s).toContain(".github/workflows/publish.yml");
  expect(s).toContain("Use the dev config, never prod."); // CLAUDE.md content folded in
  expect(s).toContain("CLAUDE.md"); // and pointed at
});

test("bounds size: an over-long CLAUDE.md is truncated with a pointer (loader style)", () => {
  const big = "# Rules\n" + "x".repeat(20000);
  const root = fixture({ harness: HARNESS, claude: big });
  const s = buildHouseRules({ root, charter: loadCharter(root), harness: loadHarness(root) });
  expect(s.length).toBeLessThan(8000);        // the whole digest stays bounded
  expect(s).toContain("…");                    // truncation marker
  expect(s).toContain("CLAUDE.md");            // pointer back to the source
});
