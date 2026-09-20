import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

/**
 * ── Structure C (review-efficiency plan Task 2 / design §4.C) ─────────────────────────────────
 *
 * `buildHouseRules({ root, charter, harness }) → string` — a bounded, markdown-ish digest of a
 * repo's conventions, handed to a future implement stage so the builder writes to the same rules
 * the reviewers already hold. The bug class it kills is own-calendar #3 R2 cf1/cf2: a README run
 * command that pointed at the production API, and a server bring-up that dropped `prisma migrate`
 * — a *required step that exists in the repo but is missing from the recipe the builder follows*.
 *
 * The digest carries three things:
 *   1. the build/run/test recipe — `[runtime].setup`/`node` and **every** `[commands]` entry, so a
 *      migrate-like step that lives as its own script is never cherry-picked out of view;
 *   2. the `[load_bearing].paths` (irreversible / hard-to-roll-back; a change here forces full+deep
 *      review — CHARTER Tiers table);
 *   3. a "a correct change here must…" list mined from CHARTER `## Preserve`, the NEVER_AUTOMATE
 *      globs (`charter.never_automate`, already extracted by loadCharter), and any top-level
 *      `CLAUDE.md`.
 *
 * **Bounded.** This drops into a role-filtered cold-read context later, so it must not balloon.
 * Long prose (CLAUDE.md, a Preserve block) is clipped with a `…` + a pointer to its source file,
 * matching the loader/handoff truncation style (`lib/harness-request.js` `clip`, `lib/handoff.js`
 * `line`). Long lists show a head then `…and N more (see <pointer>)`. It **never throws**: an
 * absent `## Preserve`, no NEVER_AUTOMATE, or no `CLAUDE.md` simply omits that section.
 */

// Truncation style borrowed from lib/harness-request.js `clip` — clip to n chars with a trailing `…`.
const clip = (v, n) => (typeof v === "string" && v.length > n ? `${v.slice(0, n - 1).trimEnd()}…` : v);

const MAX_PATHS = 30;          // load-bearing paths listed inline before pointing at the harness
const MAX_MUST = 24;           // "must…" bullets before pointing at the CHARTER
const MAX_CLAUDE_CHARS = 1200; // CLAUDE.md prose budget before pointing at the file
const MAX_PRESERVE_CHARS = 800;// ## Preserve prose budget before pointing at the CHARTER

/** Pull a top-level `## <name>` section body (up to the next `## `). Absent → "". */
function section(body, name) {
  const re = new RegExp(`^##\\s+${name}\\b.*$`, "im");
  const m = re.exec(body || "");
  if (!m) return "";
  const rest = String(body).slice(m.index + m[0].length);
  return rest.split(/^##\s+/m)[0].trim();
}

/** Bullet lines (`- ` / `* `) of a markdown block, stripped of the marker. */
function bullets(block) {
  return String(block || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

function recipeSection(harness) {
  const lines = ["## Build / run / test recipe"];
  const rt = harness?.runtime ?? {};
  if (rt.node) lines.push(`- node: ${rt.node}`);
  if (typeof rt.setup === "string" && rt.setup) lines.push(`- setup: \`${rt.setup}\``);
  // Every string-valued [commands] entry, in declaration order. `proof` is a nested table, not a
  // command — skip it. Listing all of them is the point (own-cal R2): a required step present as a
  // separate script must not be dropped from the recipe the builder reads.
  const cmds = harness?.commands ?? {};
  for (const [name, val] of Object.entries(cmds)) {
    if (typeof val === "string" && val) lines.push(`- ${name}: \`${val}\``);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function loadBearingSection(harness) {
  const raw = Array.isArray(harness?.load_bearing?.paths) ? harness.load_bearing.paths : [];
  const paths = [...new Set(raw.filter((p) => typeof p === "string" && p))];
  if (!paths.length) return "";
  const lines = ["## Load-bearing paths (hard to roll back; a change here forces full+deep review)"];
  for (const p of paths.slice(0, MAX_PATHS)) lines.push(`- ${p}`);
  if (paths.length > MAX_PATHS) lines.push(`- …and ${paths.length - MAX_PATHS} more (see \`.factory/harness.toml\` [load_bearing])`);
  return lines.join("\n");
}

function mustSection({ root, charter }) {
  const items = [];
  // ## Preserve — invariants that must survive any change.
  try {
    const { body } = parseFrontmatter(readFileSync(join(root, "docs/factory/CHARTER.md"), "utf8"));
    for (const b of bullets(section(body, "Preserve"))) items.push({ text: b });
  } catch { /* no CHARTER / unreadable → no Preserve lines */ }
  // NEVER_AUTOMATE globs (already extracted by loadCharter) — a change touching these is human-merged.
  for (const g of Array.isArray(charter?.never_automate) ? charter.never_automate : []) {
    items.push({ text: `must not automate a change to \`${g}\` (NEVER_AUTOMATE — human-merged)` });
  }
  if (!items.length) return "";
  const lines = ["## A correct change here must…"];
  for (const it of items.slice(0, MAX_MUST)) lines.push(`- ${clip(it.text, MAX_PRESERVE_CHARS)}`);
  if (items.length > MAX_MUST) lines.push(`- …and ${items.length - MAX_MUST} more (see \`docs/factory/CHARTER.md\` ## Preserve / ## NEVER_AUTOMATE)`);
  return lines.join("\n");
}

function claudeSection(root) {
  const p = join(root, "CLAUDE.md");
  if (!existsSync(p)) return "";
  let text;
  try { text = readFileSync(p, "utf8").trim(); } catch { return ""; }
  if (!text) return "";
  const clipped = clip(text, MAX_CLAUDE_CHARS);
  const pointer = clipped === text ? "(see `CLAUDE.md`)" : "(truncated — see `CLAUDE.md` for the rest)";
  return `## Project rules (CLAUDE.md) ${pointer}\n${clipped}`;
}

export function buildHouseRules({ root, charter, harness } = {}) {
  const parts = [
    "# House rules for this repo",
    "_A change that breaks a Preserve/load-bearing invariant, or skips a step in the recipe, is a defect._",
    recipeSection(harness),
    loadBearingSection(harness),
    mustSection({ root, charter }),
    claudeSection(root),
  ].filter(Boolean);
  return parts.join("\n\n") + "\n";
}
