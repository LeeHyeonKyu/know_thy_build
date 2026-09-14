import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { replaceProtBlock, writeGlobs, ciDenyEntries, qaManifestDeny } from "../lib/protected-paths.js";

export const render = (text, vars = {}) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars && typeof vars[k] !== "object" ? String(vars[k]) : m));

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

/**
 * 죽은 훅 엔트리를 settings.json에서 **뺀다**(외부 감사 M6). `mergeSettings`는 가산적이라 한 번 들어간
 * 훅은 `--upgrade`로 절대 사라지지 않는다 — `check-merge-gate.sh`는 `$TOOL_INPUT`(Claude Code가 세우지
 * 않는 변수)을 읽어 **항상 첫 줄에서 exit 0**이었는데, 스펙 §1581이 삭제를 적어 둔 뒤에도 설치본의
 * settings.json에는 남아 "머지 게이트 훅이 걸려 있다"는 그림만 만들었다. 유령 게이트는 없는 게이트보다
 * 나쁘다: 사람이 그것을 있다고 세기 때문이다.
 * 파일도 함께 지운다(`planInstall`의 `remove` 액션).
 */
export const DEAD_HOOKS = Object.freeze(["check-merge-gate.sh"]);
export function pruneDeadHooks(settings, dead = DEAD_HOOKS) {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== "object") return { settings, pruned: 0 };
  const isDead = (h) => dead.some((d) => String(h?.command || "").includes(d));
  let pruned = 0;
  const out = structuredClone(settings);
  for (const [ev, entries] of Object.entries(out.hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = [];
    for (const entry of entries) {
      const hs = (entry.hooks || []).filter((h) => { if (isDead(h)) { pruned++; return false; } return true; });
      if (hs.length) kept.push({ ...entry, hooks: hs });
      else if (!(entry.hooks || []).length) kept.push(entry);          // 애초에 비어 있던 엔트리는 우리 것이 아니다
    }
    if (kept.length) out.hooks[ev] = kept; else delete out.hooks[ev];
  }
  return pruned ? { settings: out, pruned } : { settings, pruned: 0 };
}

/**
 * 설치 대상 한 건의 **최종 내용**. 세 단계다: 읽기 → `{{VAR}}` 치환 → 생성기.
 * 호출자가 셋이라(설치 `planInstall`, doctor의 `files.stale`, 자기 미러 테스트) 여기 한 곳에 둔다 —
 * 갈라지면 "설치되는 것"과 "설치됐는지 검사하는 것"이 서로 다른 파일이 된다.
 *
 * 생성기(외부 감사 M8)는 `harness.toml [protected]`에서 훅의 `prot`와 ci-settings의 경로 deny를 만든다.
 * `vars.PROTECTED`가 그 섹션이고, 없으면 **throw한다** — 조용히 템플릿 값을 설치하면 그게 바로 M8이다.
 */
export function freshContent(e, { readFile = (p) => readFileSync(p, "utf8"), vars = {} } = {}) {
  const raw = readFile(e.src);
  const text = e.owner === "factory" || e.owner === "project" ? render(raw, vars) : raw;
  if (!e.generate) return text;
  const prot = vars.PROTECTED;
  if (!prot || !Array.isArray(prot.factory)) throw new Error(`${e.dest}: harness.toml [protected].factory is missing — refusing to install a protected list that was not derived from it`);
  if (e.generate === "hook-protected") return replaceProtBlock(text, prot);
  if (e.generate === "ci-settings" || e.generate === "ci-settings-harness") return renderCiSettings(text, prot, { harnessMode: e.generate === "ci-settings-harness" });
  throw new Error(`${e.dest}: unknown generator ${e.generate}`);
}

/**
 * ci-settings의 `permissions.deny`에서 **경로 deny만** 갈아 끼운다. 템플릿에 남는 것은 경로가 아닌
 * 항목(`Bash(gh secret*)`·`Read(.env*)` 등)이고, `Edit(...)`/`Write(...)`는 전부 harness에서 생성된다.
 * 순서는 "템플릿의 비경로 항목 → 생성된 경로 항목"으로 고정한다(결정적이어야 diff가 읽힌다).
 *
 * KTB-40 — `permissions.allow`는 **그대로 통과시킨다**(템플릿이 출처다). 그 배열은 qa 증거 카브아웃을
 * 적극적으로 선언하지만 **카브아웃을 만들지는 않는다**: Claude Code에서 deny가 allow를 이기므로,
 * 실제로 여는 일은 `FACTORY_ENUM`의 좁은 deny가 한다. allow가 필요한 이유는 따로 있다 —
 * `--permission-mode dontAsk`에서 allow에 없는 도구 호출은 묻지 않고 **거절**된다.
 */
export function renderCiSettings(templateText, prot, { harnessMode = false } = {}) {
  const j = JSON.parse(templateText);
  j.permissions ??= {};
  const keep = (j.permissions.deny || []).filter((d) => !/^(Edit|Write)\(/.test(d));
  // KTB-42 SF-1b — 생성된 경로 deny 뒤에 매니페스트 한 쌍을 **언제나** 덧붙인다. harness의
  // `[protected]`에서 유도되는 목록이 아니라(그 목록은 qa 디렉터리를 일부러 **열어** 둔다) 이 계약이
  // 스스로 닫는 한 철자이므로, 템플릿이 아니라 여기서 못 박는다(§protected-paths.js `qaManifestDeny`).
  j.permissions.deny = [...keep, ...ciDenyEntries(writeGlobs(prot, { harnessMode, enumerateFactory: true })), ...qaManifestDeny()];
  return JSON.stringify(j, null, 2) + "\n";
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
  // M6 — 죽은 훅 파일은 설치본에서 **지운다**. 남겨 두면 settings.json에서 항목만 빼도 파일이 그대로
  // 남아 다음 사람이 다시 배선한다.
  for (const dead of DEAD_HOOKS) {
    const p = `.claude/hooks/${dead}`;
    if (exists(join(root, p))) actions.push({ dest: p, owner: "factory", action: "remove" });
  }
  for (const e of manifest) {
    const target = join(root, e.dest);
    const fresh = freshContent(e, { readFile, vars });
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
      // 죽은 훅 제거는 `init`에서도 한다(ADR-019의 deny 제거와 달리). 그 항목은 사용자가 넣은 설정이
      // 아니라 우리가 배선했던 훅이고, 지금은 **아무 일도 하지 않는** 파일을 가리킨다(M6).
      const hookPrune = pruneDeadHooks(pruneResult.settings);
      const merged = JSON.stringify(mergeSettings(hookPrune.settings, JSON.parse(fresh)), null, 2) + "\n";
      actions.push({ ...base, action: merged === current ? "skip" : "merge", content: merged, pruned: pruneResult.pruned + hookPrune.pruned });
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

export function applyInstall({ actions, root, writeFile = writeFileSync, mkdir = (d) => mkdirSync(d, { recursive: true }), chmod = chmodSync, remove = (p) => rmSync(p, { force: true }) }) {
  const counts = { created: 0, replaced: 0, merged: 0, skipped: 0, kept: 0, pruned: 0, removed: 0 };
  for (const a of actions) {
    const target = join(root, a.dest);
    if (a.action === "create" || a.action === "replace" || a.action === "merge") {
      mkdir(dirname(target));
      writeFile(target, a.content);
      if (a.mode) chmod(target, a.mode);
    }
    if (a.action === "remove") remove(target);
    counts[{ create: "created", replace: "replaced", merge: "merged", skip: "skipped", keep: "kept", remove: "removed" }[a.action]]++;
    counts.pruned += a.pruned || 0;
  }
  return counts;
}
