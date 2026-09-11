import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";

const short = (iso) => iso.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}(\.\d+)?Z$/, "$1Z"); // 2026-09-08T09:02:00Z → 2026-09-08T09:02Z; already-short values pass through unchanged

export function appendRunRecord({ root, issue, title = "", stage, runnerId, lines = [], now = new Date().toISOString() }) {
  const p = join(root, "docs/factory/runs", `${issue}.md`);
  mkdirSync(dirname(p), { recursive: true });
  if (!existsSync(p)) writeFileSync(p, `# Run · #${issue}${title ? " " + title : ""}\n`);
  appendFileSync(p, `\n## ${stage} · ${short(now)} · ${runnerId}\n${lines.join("\n")}\n`);
  return p;
}
