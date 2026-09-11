import { test, expect } from "vitest";
import { existsSync } from "node:fs";
import { buildManifest, ownerOf } from "../cli/manifest.js";

const pkgRoot = new URL("../../", import.meta.url).pathname;

test("manifest maps package dirs and templates to their destinations with owners", () => {
  const m = buildManifest({ pkgRoot });
  const by = Object.fromEntries(m.map((e) => [e.dest, e]));
  expect(by[".factory/bin/run-stage.js"].owner).toBe("factory");
  expect(by[".factory/lib/gates.js"].owner).toBe("factory");
  expect(by[".factory/lib/parsers/vitest-json.js"].owner).toBe("factory");
  expect(by[".claude/hooks/block-dangerous.sh"].mode).toBe(0o755);
  expect(by[".factory/harness.toml"].owner).toBe("project");
  expect(by["docs/factory/CHARTER.md"].owner).toBe("project");
  expect(by[".factory/lessons/reviewer-qa.md"].owner).toBe("project");
  expect(by[".factory/quarantine.toml"].owner).toBe("script");
  expect(by[".claude/settings.json"].merge).toBe("settings");
  expect(by[".github/workflows/factory-implement.yml"]?.owner ?? "factory").toBe("factory");   // yml은 Task 3에서 추가된다
  expect(by[".claude/commands/factory-triage.md"].owner).toBe("factory");
  for (const e of m) expect(existsSync(e.src), e.src).toBe(true);
  expect(m.some((e) => e.dest.includes("/test/"))).toBe(false);          // 테스트는 설치하지 않는다
  expect(new Set(m.map((e) => e.dest)).size).toBe(m.length);              // dest 중복 없음
});

test("ownerOf", () => {
  expect(ownerOf(".factory/harness.toml")).toBe("project");
  expect(ownerOf(".factory/lessons/x.md")).toBe("project");
  expect(ownerOf(".factory/quarantine.toml")).toBe("script");
  expect(ownerOf(".factory/roles.toml")).toBe("factory");
});
