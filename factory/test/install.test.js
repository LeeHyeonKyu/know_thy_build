import { test, expect } from "vitest";
import { render, planInstall, applyInstall, mergeSettings, ensureGitignore } from "../cli/install.js";

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
