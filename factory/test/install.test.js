import { test, expect } from "vitest";
import { render, planInstall, applyInstall, mergeSettings, ensureGitignore, pruneMovedDenies, freshContent, MOVED_DENIES_ADR_019 } from "../cli/install.js";
import { parse as parseToml } from "smol-toml";
import { readFileSync } from "node:fs";
import { matchesAny } from "../lib/glob.js";

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
/** 이 패키지가 배포하는 템플릿 harness의 `[protected]` — 생성기의 입력이다(M8). */
const templateProtected = () => parseToml(readFileSync(new URL("../../templates/factory/factory/harness.toml", import.meta.url).pathname, "utf8")).protected;

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

/**
 * KTB-36 — 이미 설치된 저장소의 `.factory/ci-settings.json`은 옛 통짜 `Edit/Write(.factory/**)`를
 * 들고 있다. 그 한 줄이 살아 있는 동안 qa는 `[evidence].qa_artifacts`에 증거를 한 줄도 못 남기고
 * (deny가 allow를 이긴다), spec-conformance는 매 라운드를 "증거 없음"으로 거부한다 — 라이브 KTB #3.
 * 이 파일은 **팩토리 소유**라 `--upgrade`가 통째로 교체한다: 여기서 그 사실을 실제 템플릿으로 고정한다.
 */
test("upgrade replaces an old blanket-deny ci-settings.json with the enumerated one that spares qa (KTB-36)", () => {
  const src = new URL("../../templates/factory/factory/ci-settings.json", import.meta.url).pathname;
  const m = [{ src, dest: ".factory/ci-settings.json", owner: "factory", generate: "ci-settings" }];
  const files = { "/r/.factory/ci-settings.json": JSON.stringify({ permissions: { deny: ["Edit(.factory/**)", "Write(.factory/**)"] } }, null, 2) };
  const io = { exists: (p) => p in files, readFile: (p) => files[p] ?? readFileSync(p, "utf8") };
  const vars = { PROTECTED: templateProtected() };

  const [a] = planInstall({ manifest: m, root: "/r", mode: "upgrade", vars, ...io });
  expect(a.action).toBe("replace");
  const deny = JSON.parse(a.content).permissions.deny;
  for (const d of ["Edit(.factory/**)", "Write(.factory/**)"]) expect(deny, d).not.toContain(d);
  // KTB-40: 남아 있던 `.factory/out/*` 한 줄이 qa 디렉터리 자신(`out`의 직계 자식이다)을 물어
  // 카브아웃을 지웠다 — 이제 하위 디렉터리에 닿을 수 없는 파일 패턴만 열거한다.
  expect(deny).toContain("Edit(.factory/out/*.json)");
  expect(deny).not.toContain("Edit(.factory/out/*)");
  for (const tool of ["Edit", "Write"]) {
    const globs = deny.map((d) => new RegExp(`^${tool}\\((.+)\\)$`).exec(d)?.[1]).filter(Boolean);
    expect(matchesAny(globs, ".factory/out/qa/3-shot.png"), tool).toBe(false);
    expect(matchesAny(globs, ".factory/out/qa"), `${tool} qa dir`).toBe(false);
    expect(matchesAny(globs, ".factory/out/gates.json"), tool).toBe(true);
    expect(matchesAny(globs, ".factory/out/agents.jsonl"), tool).toBe(true);
  }
  // 최초 `init`은 남의 저장소에 이미 있는 파일을 건드리지 않는다 — 이 교체는 `--upgrade` 전용이다.
  expect(planInstall({ manifest: m, root: "/r", mode: "init", vars, ...io })[0].action).toBe("skip");
});

// ── 2026-09-14 외부 감사 M8: 보호 목록의 단일 출처 (ADR-023) ────────────────────────────────────
// 감사 전에는 같은 목록이 세 곳에 손으로 적혀 있었고 갈라져 있었다. 이제 훅의 `prot`도 ci-settings의
// 경로 deny도 `harness.toml [protected]`에서 **생성된다** — harness에 글롭 하나를 더하면 셋이 함께 움직인다.
test("M8: the ci-settings path denies are generated from harness.toml [protected], not hand-listed", () => {
  const src = new URL("../../templates/factory/factory/ci-settings.json", import.meta.url).pathname;
  const readFile = (p) => readFileSync(p, "utf8");
  const e = { src, dest: ".factory/ci-settings.json", owner: "factory", generate: "ci-settings" };

  // 템플릿 자체에는 경로 deny가 한 줄도 없다(= 세 번째 손 목록이 사라졌다)
  expect(JSON.parse(readFile(src)).permissions.deny.some((d) => /^(Edit|Write)\(/.test(d))).toBe(false);

  const prot = templateProtected();
  const deny = JSON.parse(freshContent(e, { readFile, vars: { PROTECTED: prot } })).permissions.deny;
  // harness에 새 글롭을 더하면 deny에 그대로 나타난다
  const withExtra = JSON.parse(freshContent(e, { readFile, vars: { PROTECTED: { ...prot, factory: [...prot.factory, "Makefile"] } } })).permissions.deny;
  expect(deny).not.toContain("Edit(Makefile)");
  expect(withExtra).toContain("Edit(Makefile)");
  expect(withExtra).toContain("Write(Makefile)");
  // 비경로 항목(CI 전용)은 그대로 남는다
  expect(deny).toContain("Bash(gh secret*)");
  expect(deny).toContain("Read(.git/**)");
  // `agent_writable`은 **쓰기** 경계에서만 빠진다 — 머지 경계(`[protected].factory`)에는 그대로 남는다
  const dog = JSON.parse(freshContent(e, { readFile, vars: { PROTECTED: { ...prot, factory: [...prot.factory, "factory/**"], agent_writable: ["factory/**"] } } })).permissions.deny;
  expect(dog).not.toContain("Edit(factory/**)");

  // harness 변형은 승격이 건드리는 파일만 연다 — 러너 자신의 매니페스트는 계속 막힌다(KTB-23)
  const h = JSON.parse(freshContent({ ...e, dest: ".factory/ci-settings-harness.json", generate: "ci-settings-harness" }, { readFile, vars: { PROTECTED: prot } })).permissions.deny;
  expect(h).not.toContain("Edit(.factory/harness.toml)");
  expect(h).not.toContain("Edit(package.json)");
  expect(h).toContain("Edit(.factory/package.json)");
  expect(h).toContain("Edit(.claude/**)");
});

test("M8: freshContent refuses to install a protected list that was not derived from harness.toml", () => {
  const src = new URL("../../templates/factory/factory/ci-settings.json", import.meta.url).pathname;
  const e = { src, dest: ".factory/ci-settings.json", owner: "factory", generate: "ci-settings" };
  expect(() => freshContent(e, { readFile: (p) => readFileSync(p, "utf8"), vars: {} })).toThrow(/\[protected\]\.factory is missing/);
});

// ── 외부 감사 M6: 유령 게이트는 없는 게이트보다 나쁘다 ──────────────────────────────────────────
// `check-merge-gate.sh`는 `$TOOL_INPUT`(Claude Code가 세우지 않는 변수)을 읽어 항상 첫 줄에서 exit 0이었다.
// `mergeSettings`는 가산적이라 `--upgrade`로는 절대 사라지지 않는다 — 그래서 따로 뺀다.
test("M6: upgrade unwires and deletes the dead check-merge-gate.sh hook", () => {
  const existing = {
    hooks: { PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "bash .claude/hooks/check-merge-gate.sh" }] },
      { matcher: "Bash", hooks: [{ type: "command", command: ".claude/hooks/block-dangerous.sh" }, { type: "command", command: "bash .claude/hooks/check-merge-gate.sh" }] },
    ] },
  };
  const files = { "/r/.claude/settings.json": JSON.stringify(existing, null, 2), "/r/.claude/hooks/check-merge-gate.sh": "#!/bin/bash\nexit 0\n" };
  const actions = planInstall({ manifest, root: "/r", mode: "upgrade", vars: {}, ...fsOf(files) });
  const rm = actions.find((a) => a.dest === ".claude/hooks/check-merge-gate.sh");
  expect(rm?.action).toBe("remove");
  const s = actions.find((a) => a.dest === ".claude/settings.json");
  expect(s.content).not.toMatch(/check-merge-gate/);
  expect(s.pruned).toBe(2);
  expect(JSON.parse(s.content).hooks.PreToolUse.some((e) => e.hooks.some((h) => h.command === ".claude/hooks/block-dangerous.sh"))).toBe(true);
  const counts = applyInstall({ actions, root: "/r", writeFile: () => {}, mkdir: () => {}, chmod: () => {}, remove: () => {} });
  expect(counts.removed).toBe(1);
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

// ── Feedback loop (T3 리뷰 MF-2) — 설치된 러너가 읽을 **주인 표**를 설치 시점에 떨어뜨린다 ────────
// `factory/cli/**`는 설치되지 않고 배포는 `npx`라 채택자 저장소에는 `node_modules/know-thy-build`도
// 없다. 그래서 이 파일이 없으면 피드백 루프는 채택자 저장소에서 영원히 에러 액션 한 줄만 남긴다.
test("install-manifest: 생성기가 dest→owner 표를 결정적으로 낸다", async () => {
  const { renderInstallManifest } = await import("../cli/install.js");
  const template = JSON.stringify({ schema: "factory.install-manifest.v1", note: "n", ktb_version: null, entries: [] }, null, 2) + "\n";
  const vars = { KTB_VERSION: "1.3.2", MANIFEST: [
    { dest: ".factory/lib/gates.js", owner: "factory" },
    { dest: ".factory/harness.toml", owner: "project" },
    { dest: ".factory/quarantine.toml", owner: "script" },
  ] };
  const out = JSON.parse(renderInstallManifest(template, vars));
  expect(out.ktb_version).toBe("1.3.2");
  expect(out.entries.map((e) => e.dest)).toEqual([".factory/harness.toml", ".factory/lib/gates.js", ".factory/quarantine.toml"]);  // 정렬 = 결정적
  expect(out.entries.find((e) => e.dest === ".factory/harness.toml").owner).toBe("project");
  expect(renderInstallManifest(template, vars)).toBe(renderInstallManifest(template, vars));
  // 매니페스트를 못 받은 호출자에게는 템플릿 원문 그대로 — 빈 표를 지어내 "설치된 것이 없다"고 굳히지 않는다
  expect(renderInstallManifest(template, {})).toBe(template);
});

test("install-manifest: freshContent가 [protected] 없이도 이 생성기를 돌린다", async () => {
  const { freshContent: fc } = await import("../cli/install.js");
  const e = { src: "/pkg/templates/factory/factory/install-manifest.json", dest: ".factory/install-manifest.json", owner: "factory", generate: "install-manifest" };
  const template = JSON.stringify({ schema: "factory.install-manifest.v1", note: "n", ktb_version: null, entries: [] }, null, 2) + "\n";
  const out = fc(e, { readFile: () => template, vars: { MANIFEST: [{ dest: ".factory/lib/a.js", owner: "factory" }], KTB_VERSION: "9.9.9" } });
  expect(JSON.parse(out).entries).toEqual([{ dest: ".factory/lib/a.js", owner: "factory" }]);
});

// 채택자 레이아웃 그대로 — `.factory/**`만 있고 `factory/cli`도 `node_modules`도 없다.
test("loadInstallManifest: .factory/install-manifest.json 하나로 라우팅이 산다", async () => {
  const { loadInstallManifest, INSTALL_MANIFEST_PATH } = await import("../lib/feedback/install-manifest.js");
  const doc = JSON.stringify({
    schema: "factory.install-manifest.v1", ktb_version: "1.3.2",
    entries: [
      { dest: ".factory/lib/self-gate.js", owner: "factory" },
      { dest: ".factory/harness.toml", owner: "project" },
    ],
  });
  const files = { [`/adopter/${INSTALL_MANIFEST_PATH}`]: doc };
  const m = await loadInstallManifest("/adopter", {
    exists: (p) => p in files,
    read: (p) => files[p],
    importModule: () => { throw new Error("must not import: the adopter has no factory/cli and no node_modules"); },
  });
  expect(m.source).toBe(INSTALL_MANIFEST_PATH);
  expect(m.ktbVersion).toBe("1.3.2");
  expect(m.ownerOf(".factory/lib/self-gate.js")).toBe("factory");
  expect(m.ownerOf(".factory/harness.toml")).toBe("project");
  expect(m.isInstalled.has(".factory/lib/self-gate.js")).toBe(true);
  expect(m.isInstalled.has(".claude/settings.local.json")).toBe(false);   // 배포물이 아니다 → 멤버십 밖
});

test("loadInstallManifest: 표가 없으면 저장소 소스로, 그것도 없으면 null(라우팅하지 않는다)", async () => {
  const { loadInstallManifest } = await import("../lib/feedback/install-manifest.js");
  expect(await loadInstallManifest("/nowhere", { exists: () => false, read: () => "", importModule: () => { throw new Error("nope"); } })).toBeNull();
  // 도그푸드: 저장소 루트에 factory/cli/manifest.js가 있다
  const m = await loadInstallManifest("/pkg", {
    exists: (p) => p === "/pkg/factory/cli/manifest.js" || p === "/pkg/package.json",
    read: () => JSON.stringify({ version: "7.0.0" }),
    importModule: async () => ({ ownerOf: () => "factory", buildManifest: () => [{ dest: ".factory/lib/x.js" }] }),
  });
  expect(m.source).toBe("/pkg/factory/cli/manifest.js");
  expect(m.ktbVersion).toBe("7.0.0");
});

test("이 저장소의 .factory/install-manifest.json은 실제 매니페스트와 어긋나지 않는다", async () => {
  const { buildManifest } = await import("../cli/manifest.js");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const doc = JSON.parse(readFileSync(`${root}/.factory/install-manifest.json`, "utf8"));
  const live = buildManifest({ pkgRoot: root }).map((e) => ({ dest: e.dest, owner: e.owner })).sort((a, b) => (a.dest < b.dest ? -1 : 1));
  expect(doc.entries).toEqual(live);
  expect(doc.ktb_version).toBe(JSON.parse(readFileSync(`${root}/package.json`, "utf8")).version);
});
