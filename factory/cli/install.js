import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";

export const render = (text, vars = {}) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

const uniq = (arr) => [...new Set(arr)];
/** 결정적 병합: deny/allow는 합집합(기존 순서 유지), 훅은 command가 없을 때만 append, 그 외 키는 기존 값 유지. */
export function mergeSettings(existing, template) {
  const out = existing ? structuredClone(existing) : {};
  out.permissions ??= {};
  for (const k of ["deny", "allow"]) if (template.permissions?.[k]) out.permissions[k] = uniq([...(out.permissions[k] || []), ...template.permissions[k]]);
  out.hooks ??= {};
  for (const [ev, entries] of Object.entries(template.hooks || {})) {
    out.hooks[ev] ??= [];
    const have = new Set(out.hooks[ev].flatMap((e) => (e.hooks || []).map((h) => h.command)));
    for (const entry of entries) {
      const missing = entry.hooks.filter((h) => !have.has(h.command));
      if (missing.length) { out.hooks[ev].push({ ...entry, hooks: missing }); missing.forEach((h) => have.add(h.command)); }
    }
  }
  return out;
}

export function ensureGitignore(text, entries) {
  const lines = (text || "").split("\n");
  const missing = entries.filter((e) => !lines.includes(e));
  if (!missing.length) return text;
  const base = text == null || text === "" ? "" : text.endsWith("\n") ? text + "\n" : text + "\n\n";
  return `${base}# know-thy-build factory\n${missing.join("\n")}\n`;
}

export function planInstall({ manifest, root, mode, vars = {}, exists = existsSync, readFile = (p) => readFileSync(p, "utf8") }) {
  const actions = [];
  for (const e of manifest) {
    const target = join(root, e.dest);
    const fresh = e.owner === "factory" || e.owner === "project" ? render(readFile(e.src), vars) : readFile(e.src);
    const present = exists(target);
    const base = { dest: e.dest, owner: e.owner, mode: e.mode };
    if (!present) { actions.push({ ...base, action: "create", content: fresh }); continue; }
    if (mode === "init") { actions.push({ ...base, action: "skip" }); continue; }
    // upgrade
    if (e.owner !== "factory") { actions.push({ ...base, action: "keep" }); continue; }
    const current = readFile(target);
    if (e.merge === "settings") {
      let cur; try { cur = JSON.parse(current); } catch (err) { throw new Error(`${e.dest}: existing settings.json is not valid JSON — ${err.message}`); }
      const merged = JSON.stringify(mergeSettings(cur, JSON.parse(fresh)), null, 2) + "\n";
      actions.push({ ...base, action: merged === current ? "skip" : "merge", content: merged });
      continue;
    }
    actions.push(current === fresh ? { ...base, action: "skip" } : { ...base, action: "replace", content: fresh });
  }
  return actions;
}

export function applyInstall({ actions, root, writeFile = writeFileSync, mkdir = (d) => mkdirSync(d, { recursive: true }), chmod = chmodSync }) {
  const counts = { created: 0, replaced: 0, merged: 0, skipped: 0, kept: 0 };
  for (const a of actions) {
    const target = join(root, a.dest);
    if (a.action === "create" || a.action === "replace" || a.action === "merge") {
      mkdir(dirname(target));
      writeFile(target, a.content);
      if (a.mode) chmod(target, a.mode);
    }
    counts[{ create: "created", replace: "replaced", merge: "merged", skip: "skipped", keep: "kept" }[a.action]]++;
  }
  return counts;
}
