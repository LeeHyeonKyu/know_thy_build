import { test, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trustWorkspace } from "../bin/trust-workspace.js";

test("does nothing outside CI; writes projects[root].hasTrustDialogAccepted in CI", async () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  expect(await trustWorkspace({ root: "/repo", home, env: {} })).toBe(false);
  expect(existsSync(join(home, ".claude.json"))).toBe(false);
  expect(await trustWorkspace({ root: "/repo", home, env: { GITHUB_ACTIONS: "true" } })).toBe(true);
  expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).projects["/repo"].hasTrustDialogAccepted).toBe(true);
});
