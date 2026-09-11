import { test, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trustWorkspace } from "../bin/trust-workspace.js";

test("does nothing outside CI; writes projects[root].hasTrustDialogAccepted in CI", async () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  expect(await trustWorkspace({ root: "/repo", home, env: {} })).toBe(false);
  expect(existsSync(join(home, ".claude.json"))).toBe(false);
  expect(await trustWorkspace({ root: "/repo", home, env: { GITHUB_ACTIONS: "true" } })).toBe(true);
  expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).projects["/repo"].hasTrustDialogAccepted).toBe(true);
  expect(existsSync(join(home, ".claude.json.tmp"))).toBe(false);        // 임시 파일은 rename으로 사라진다
});

test("an unparseable ~/.claude.json is left untouched and trustWorkspace returns false", async () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const p = join(home, ".claude.json");
  const corrupt = '{"projects": {"/other": {"hasTrustDialogAccepted": true}';   // 닫는 괄호 없음
  writeFileSync(p, corrupt);
  expect(await trustWorkspace({ root: "/repo", home, env: { GITHUB_ACTIONS: "true" } })).toBe(false);
  expect(readFileSync(p, "utf8")).toBe(corrupt);
});

test("an existing valid ~/.claude.json keeps its other keys", async () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const p = join(home, ".claude.json");
  writeFileSync(p, JSON.stringify({ theme: "dark", projects: { "/other": { hasTrustDialogAccepted: true } } }));
  expect(await trustWorkspace({ root: "/repo", home, env: { FACTORY_RUNNER_ID: "gha-1" } })).toBe(true);
  const j = JSON.parse(readFileSync(p, "utf8"));
  expect(j.theme).toBe("dark");
  expect(j.projects["/other"].hasTrustDialogAccepted).toBe(true);
  expect(j.projects["/repo"].hasTrustDialogAccepted).toBe(true);
});
