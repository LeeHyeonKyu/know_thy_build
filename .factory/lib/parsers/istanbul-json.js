import { relative, isAbsolute } from "node:path";
export function coveredLines(json, root = process.cwd()) {
  const m = new Map();
  for (const [file, cov] of Object.entries(json)) {
    const rel = isAbsolute(file) ? relative(root, file) : file;
    const set = new Set();
    for (const [id, loc] of Object.entries(cov.statementMap || {})) {
      if ((cov.s?.[id] ?? 0) > 0) for (let l = loc.start.line; l <= (loc.end?.line ?? loc.start.line); l++) set.add(l);
    }
    m.set(rel, set);
  }
  return m;
}
