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

/**
 * ADR-019에서 `.claude/settings.json` → `.factory/ci-settings.json`으로 옮긴 경로 deny 22개.
 *
 * 여기 **리터럴로** 적는다 — ci-settings 템플릿에서 유도하지 않는다. 그 파일에는 settings.json에
 * 한 번도 산 적 없는 CI 전용 항목(`Bash(gh secret*)`, `Read(.env*)` 등)이 함께 있어서, 유도하면
 * 사용자가 스스로 넣었을 수도 있는 그 항목까지 지우게 된다. "우리가 옮긴 것만 되돌린다"가 규칙이다.
 *
 * `mergeSettings`는 가산적이라(합집합) `--upgrade`만으로는 이 줄들이 절대 사라지지 않는다. 남아
 * 있으면 사람의 대화형 세션에서 `:harness`·`:role`·`:technical`이 자기 일을 못 한다(ADR-019).
 */
export const MOVED_DENIES_ADR_019 = Object.freeze([
  "Edit(.factory/**)", "Write(.factory/**)",
  "Edit(.claude/**)", "Write(.claude/**)",
  "Edit(.github/workflows/factory-*)", "Write(.github/workflows/factory-*)",
  "Edit(docs/factory/CHARTER.md)", "Write(docs/factory/CHARTER.md)",
  "Edit(package.json)", "Write(package.json)",
  "Edit(package-lock.json)", "Write(package-lock.json)",
  "Edit(vitest.config.*)", "Write(vitest.config.*)",
  "Edit(playwright.config.*)", "Write(playwright.config.*)",
  "Edit(tsconfig*.json)", "Write(tsconfig*.json)",
  "Edit(.eslintrc*)", "Write(.eslintrc*)",
  "Edit(eslint.config.*)", "Write(eslint.config.*)",
]);

/**
 * `settings.permissions.deny`에서 `moved`에 있는 항목만 제거한다. 순수 함수 — 입력을 바꾸지 않고
 * `{ settings, pruned }`를 돌려준다. 그 외의 deny(사용자가 직접 넣은 것 포함)는 순서까지 그대로다.
 * 멱등: 두 번째 호출은 `pruned: 0`이고 `settings`는 첫 결과와 깊은 동등이다.
 */
export function pruneMovedDenies(settings, moved = MOVED_DENIES_ADR_019) {
  const deny = settings?.permissions?.deny;
  if (!Array.isArray(deny)) return { settings, pruned: 0 };
  const drop = new Set(moved);
  const kept = deny.filter((d) => !drop.has(d));
  if (kept.length === deny.length) return { settings, pruned: 0 };
  const out = structuredClone(settings);
  out.permissions.deny = kept;
  return { settings: out, pruned: deny.length - kept.length };
}

const GITIGNORE_HEADER = "# know-thy-build factory";

/** 헤더가 이미 있으면 그 블록 뒤에 누락분만 덧붙인다 — 헤더를 중복 생성하지 않는다. */
export function ensureGitignore(text, entries) {
  const raw = text || "";
  const lines = raw.split("\n");
  const missing = entries.filter((e) => !lines.includes(e));
  if (!missing.length) return text;
  const headerIdx = lines.indexOf(GITIGNORE_HEADER);
  if (headerIdx === -1) {
    const base = raw === "" ? "" : raw.endsWith("\n") ? raw + "\n" : raw + "\n\n";
    return `${base}${GITIGNORE_HEADER}\n${missing.join("\n")}\n`;
  }
  let end = headerIdx + 1;
  while (end < lines.length && lines[end] !== "") end++;
  return [...lines.slice(0, end), ...missing, ...lines.slice(end)].join("\n");
}

export function planInstall({ manifest, root, mode, vars = {}, exists = existsSync, readFile = (p) => readFileSync(p, "utf8") }) {
  const actions = [];
  for (const e of manifest) {
    const target = join(root, e.dest);
    const fresh = e.owner === "factory" || e.owner === "project" ? render(readFile(e.src), vars) : readFile(e.src);
    const present = exists(target);
    const base = { dest: e.dest, owner: e.owner, mode: e.mode };
    if (!present) { actions.push({ ...base, action: "create", content: fresh }); continue; }
    // 병합형 항목(.claude/settings.json)은 init/upgrade 모두에서 병합한다 — 결정적, 가산적이므로 안전하다.
    if (e.merge === "settings") {
      const current = readFile(target);
      let cur; try { cur = JSON.parse(current); } catch (err) { throw new Error(`${e.dest}: existing settings.json is not valid JSON — ${err.message}`); }
      // 제거는 `--upgrade`에서만 한다(ADR-019). 최초 `init`은 남의 저장소에 이미 있던 설정을 더하기만
      // 하는 연산이고, 거기서 줄을 지우면 "설치가 내 설정을 지웠다"가 된다 — 되돌리기를 요청한 사람만 받는다.
      const pruneResult = mode === "upgrade" ? pruneMovedDenies(cur) : { settings: cur, pruned: 0 };
      const merged = JSON.stringify(mergeSettings(pruneResult.settings, JSON.parse(fresh)), null, 2) + "\n";
      actions.push({ ...base, action: merged === current ? "skip" : "merge", content: merged, pruned: pruneResult.pruned });
      continue;
    }
    if (mode === "init") { actions.push({ ...base, action: "skip" }); continue; }
    // upgrade
    if (e.owner !== "factory") { actions.push({ ...base, action: "keep" }); continue; }
    const current = readFile(target);
    actions.push(current === fresh ? { ...base, action: "skip" } : { ...base, action: "replace", content: fresh });
  }
  return actions;
}

export function applyInstall({ actions, root, writeFile = writeFileSync, mkdir = (d) => mkdirSync(d, { recursive: true }), chmod = chmodSync }) {
  const counts = { created: 0, replaced: 0, merged: 0, skipped: 0, kept: 0, pruned: 0 };
  for (const a of actions) {
    const target = join(root, a.dest);
    if (a.action === "create" || a.action === "replace" || a.action === "merge") {
      mkdir(dirname(target));
      writeFile(target, a.content);
      if (a.mode) chmod(target, a.mode);
    }
    counts[{ create: "created", replace: "replaced", merge: "merged", skip: "skipped", keep: "kept" }[a.action]]++;
    counts.pruned += a.pruned || 0;
  }
  return counts;
}
