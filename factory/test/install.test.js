import { test, expect } from "vitest";
import { render, planInstall, applyInstall, mergeSettings, ensureGitignore, pruneMovedDenies, MOVED_DENIES_ADR_019 } from "../cli/install.js";

const manifest = [
  { src: "/pkg/templates/factory/factory/harness.toml", dest: ".factory/harness.toml", owner: "project" },
  { src: "/pkg/factory/lib/gates.js", dest: ".factory/lib/gates.js", owner: "factory" },
  { src: "/pkg/factory/hooks/x.sh", dest: ".claude/hooks/x.sh", owner: "factory", mode: 0o755 },
  { src: "/pkg/templates/factory/claude/settings.json", dest: ".claude/settings.json", owner: "factory", merge: "settings" },
  { src: "/pkg/templates/factory/factory/quarantine.toml", dest: ".factory/quarantine.toml", owner: "script" },
];
const srcs = {
  "/pkg/templates/factory/factory/harness.toml": 'name = "{{PROJECT_NAME}}"\n',
  "/pkg/factory/lib/gates.js": "export const v = 2;\n",
  "/pkg/factory/hooks/x.sh": "#!/bin/bash\nexit 0\n",
  "/pkg/templates/factory/claude/settings.json": JSON.stringify({ permissions: { deny: ["A", "B"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: ".claude/hooks/x.sh" }] }] } }),
  "/pkg/templates/factory/factory/quarantine.toml": "quarantined = []\n",
};
const fsOf = (files) => ({ exists: (p) => p in files, readFile: (p) => files[p] ?? srcs[p] ?? null });

test("render substitutes known vars only", () => {
  expect(render("a {{X}} {{Y}}", { X: "1" })).toBe("a 1 {{Y}}");
});

test("init creates everything missing and skips everything present, whatever the owner", () => {
  const files = { "/r/.factory/lib/gates.js": "old", "/r/.factory/harness.toml": "mine" };
  const actions = planInstall({ manifest, root: "/r", mode: "init", vars: { PROJECT_NAME: "demo" }, ...fsOf(files) });
  const by = Object.fromEntries(actions.map((a) => [a.dest, a]));
  expect(by[".factory/lib/gates.js"].action).toBe("skip");
  expect(by[".factory/harness.toml"].action).toBe("skip");
  expect(by[".claude/hooks/x.sh"]).toMatchObject({ action: "create", mode: 0o755 });
  expect(by[".claude/settings.json"].action).toBe("create");
  expect(by[".factory/quarantine.toml"].action).toBe("create");
});

test("init renders vars into created files", () => {
  const actions = planInstall({ manifest, root: "/r", mode: "init", vars: { PROJECT_NAME: "demo" }, ...fsOf({}) });
  expect(actions.find((a) => a.dest === ".factory/harness.toml").content).toBe('name = "demo"\n');
});

test("init merges an existing settings.json instead of skipping", () => {
  const existing = { permissions: { deny: ["B", "C"] }, hooks: {} };
  const files = { "/r/.claude/settings.json": JSON.stringify(existing) };
  const actions = planInstall({ manifest, root: "/r", mode: "init", vars: {}, ...fsOf(files) });
  const a = actions.find((x) => x.dest === ".claude/settings.json");
  expect(a.action).toBe("merge");
  const merged = JSON.parse(a.content);
  expect(merged.permissions.deny).toEqual(["B", "C", "A"]);
  expect(merged.hooks.Stop.map((e) => e.hooks[0].command)).toEqual([".claude/hooks/x.sh"]);

  // an existing settings.json already equal to the merge result is left alone
  const identical = { "/r/.claude/settings.json": a.content };
  const again = planInstall({ manifest, root: "/r", mode: "init", vars: {}, ...fsOf(identical) });
  expect(again.find((x) => x.dest === ".claude/settings.json").action).toBe("skip");
});

test("upgrade replaces stale factory-owned files, merges settings, keeps project/script files", () => {
  const files = {
    "/r/.factory/lib/gates.js": "old",
    "/r/.factory/harness.toml": "mine",
    "/r/.factory/quarantine.toml": "[[quarantined]]\nid='x'\n",
    "/r/.claude/settings.json": JSON.stringify({ permissions: { deny: ["B", "C"], allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "mine.sh" }] }] }, other: 1 }),
    "/r/.claude/hooks/x.sh": "#!/bin/bash\nexit 0\n",
  };
  const actions = planInstall({ manifest, root: "/r", mode: "upgrade", vars: {}, ...fsOf(files) });
  const by = Object.fromEntries(actions.map((a) => [a.dest, a]));
  expect(by[".factory/lib/gates.js"]).toMatchObject({ action: "replace", content: "export const v = 2;\n" });
  expect(by[".claude/hooks/x.sh"].action).toBe("skip");                    // 동일 내용 → 손대지 않음
  expect(by[".factory/harness.toml"].action).toBe("keep");
  expect(by[".factory/quarantine.toml"].action).toBe("keep");
  expect(by[".claude/settings.json"].action).toBe("merge");
  const merged = JSON.parse(by[".claude/settings.json"].content);
  expect(merged.permissions.deny).toEqual(["B", "C", "A"]);
  expect(merged.permissions.allow).toEqual(["Bash(ls)"]);
  expect(merged.hooks.Stop.map((e) => e.hooks[0].command)).toEqual(["mine.sh", ".claude/hooks/x.sh"]);
  expect(merged.other).toBe(1);
});

// ── ADR-019: `--upgrade`가 옮겨간 경로 deny 22개를 제거한다 ───────────────────────────────────
// mergeSettings는 합집합이라 이 줄들은 스스로 사라지지 않는다. 남아 있으면 사람의 대화형 세션에서
// :harness/:role/:technical이 자기 일을 못 한다 — 설치기가 되돌릴 수 있는 유일한 지점이 여기다.

test("MOVED_DENIES_ADR_019 is exactly the 22 path denies that left settings.json, frozen", () => {
  expect(MOVED_DENIES_ADR_019.length).toBe(22);
  expect(Object.isFrozen(MOVED_DENIES_ADR_019)).toBe(true);
  for (const d of MOVED_DENIES_ADR_019) expect(d, d).toMatch(/^(Edit|Write)\(/);
  // CI 전용 항목은 여기 없다 — 그것들은 settings.json에 산 적이 없으므로 제거 대상이 아니다.
  for (const d of ["Bash(gh secret*)", "Read(.env)"]) expect(MOVED_DENIES_ADR_019).not.toContain(d);
});

test("pruneMovedDenies removes only the moved entries, preserves order, and is idempotent", () => {
  const settings = { permissions: { deny: ["Bash(gh pr merge*)", "Edit(.factory/**)", "Read(.env)", "Edit(foo/**)", "Write(package.json)"], allow: ["Bash(ls)"] }, other: 1 };
  const once = pruneMovedDenies(settings);
  expect(once.pruned).toBe(2);
  expect(once.settings.permissions.deny).toEqual(["Bash(gh pr merge*)", "Read(.env)", "Edit(foo/**)"]);
  expect(once.settings.permissions.allow).toEqual(["Bash(ls)"]);
  expect(once.settings.other).toBe(1);
  expect(settings.permissions.deny).toHaveLength(5);                  // 순수 함수 — 입력은 그대로
  const twice = pruneMovedDenies(once.settings);
  expect(twice.pruned).toBe(0);
  expect(twice.settings).toEqual(once.settings);
  // deny 자체가 없는 설정도 던지지 않는다
  expect(pruneMovedDenies({ permissions: {} })).toEqual({ settings: { permissions: {} }, pruned: 0 });
  expect(pruneMovedDenies(null)).toEqual({ settings: null, pruned: 0 });
});

const staleSettings = () => ({
  permissions: {
    deny: ["B", "C", ...MOVED_DENIES_ADR_019, "Read(.env)", "Edit(foo/**)"],
    allow: ["Bash(ls)"],
  },
  hooks: {},
});

test("upgrade prunes the 22 moved denies and nothing else; a user's own Read(.env)/Edit(foo/**) survive", () => {
  const files = { "/r/.claude/settings.json": JSON.stringify(staleSettings()) };
  const actions = planInstall({ manifest, root: "/r", mode: "upgrade", vars: {}, ...fsOf(files) });
  const a = actions.find((x) => x.dest === ".claude/settings.json");
  expect(a.action).toBe("merge");
  expect(a.pruned).toBe(22);
  const deny = JSON.parse(a.content).permissions.deny;
  for (const d of MOVED_DENIES_ADR_019) expect(deny, d).not.toContain(d);
  expect(deny).toEqual(["B", "C", "Read(.env)", "Edit(foo/**)", "A"]);   // "A"는 템플릿이 더한 것
});

test("init never prunes — adding to someone's existing settings.json is not the same as deleting from it", () => {
  const files = { "/r/.claude/settings.json": JSON.stringify(staleSettings()) };
  const actions = planInstall({ manifest, root: "/r", mode: "init", vars: {}, ...fsOf(files) });
  const a = actions.find((x) => x.dest === ".claude/settings.json");
  expect(a.pruned).toBe(0);
  const deny = JSON.parse(a.content).permissions.deny;
  for (const d of MOVED_DENIES_ADR_019) expect(deny, d).toContain(d);
});

test("a second upgrade is a no-op — pruned 0, action skip", () => {
  const first = planInstall({ manifest, root: "/r", mode: "upgrade", vars: {}, ...fsOf({ "/r/.claude/settings.json": JSON.stringify(staleSettings()) }) })
    .find((x) => x.dest === ".claude/settings.json");
  const again = planInstall({ manifest, root: "/r", mode: "upgrade", vars: {}, ...fsOf({ "/r/.claude/settings.json": first.content }) })
    .find((x) => x.dest === ".claude/settings.json");
  expect(again.pruned).toBe(0);
  expect(again.action).toBe("skip");
});

test("applyInstall reports the pruned count in the summary counts", () => {
  const actions = planInstall({ manifest, root: "/r", mode: "upgrade", vars: {}, ...fsOf({ "/r/.claude/settings.json": JSON.stringify(staleSettings()) }) });
  const r = applyInstall({ actions, root: "/r", writeFile: () => {}, mkdir: () => {}, chmod: () => {} });
  expect(r.pruned).toBe(22);
});

test("mergeSettings is idempotent and does not duplicate hook entries", () => {
  const t = JSON.parse(srcs["/pkg/templates/factory/claude/settings.json"]);
  const once = mergeSettings(null, t);
  expect(mergeSettings(once, t)).toEqual(once);
});

test("mergeSettings with unparseable existing settings throws", () => {
  expect(() => planInstall({ manifest, root: "/r", mode: "upgrade", vars: {}, exists: () => true, readFile: (p) => (p.endsWith("settings.json") ? "{not json" : srcs[p] ?? "x") }))
    .toThrow(/settings\.json is not valid JSON/);
});

test("applyInstall writes, chmods and reports counts", () => {
  const written = {}, modes = {}, dirs = [];
  const actions = planInstall({ manifest, root: "/r", mode: "init", vars: { PROJECT_NAME: "d" }, ...fsOf({}) });
  const r = applyInstall({ actions, root: "/r", writeFile: (p, c) => (written[p] = c), mkdir: (d) => dirs.push(d), chmod: (p, m) => (modes[p] = m) });
  expect(r.created).toBe(5);
  expect(written["/r/.factory/lib/gates.js"]).toBe("export const v = 2;\n");
  expect(modes["/r/.claude/hooks/x.sh"]).toBe(0o755);
  expect(dirs).toContain("/r/.factory/lib");
});

test("ensureGitignore appends missing entries under a factory header once", () => {
  const out = ensureGitignore("node_modules/\n", [".factory/out/", ".factory/node_modules/"]);
  expect(out).toBe("node_modules/\n\n# know-thy-build factory\n.factory/out/\n.factory/node_modules/\n");
  expect(ensureGitignore(out, [".factory/out/", ".factory/node_modules/"])).toBe(out);
  expect(ensureGitignore(null, [".factory/out/"])).toBe("# know-thy-build factory\n.factory/out/\n");
});

test("ensureGitignore appends after an existing header without duplicating it", () => {
  const withHeader = "node_modules/\n\n# know-thy-build factory\n.factory/out/\n";
  const out = ensureGitignore(withHeader, [".factory/out/", ".factory/new-entry/"]);
  expect(out).toBe("node_modules/\n\n# know-thy-build factory\n.factory/out/\n.factory/new-entry/\n");
  expect(out.match(/# know-thy-build factory/g)).toHaveLength(1);
});
