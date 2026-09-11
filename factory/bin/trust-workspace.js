#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** CI에서만 ~/.claude.json에 cwd를 trusted로 기록한다(ADR-008). 로컬에서는 아무것도 하지 않는다. */
export async function trustWorkspace({ root, home = homedir(), env = process.env }) {
  if (!env.GITHUB_ACTIONS && !env.FACTORY_RUNNER_ID) return false;
  const p = join(home, ".claude.json");
  let j = {}; if (existsSync(p)) { try { j = JSON.parse(readFileSync(p, "utf8")); } catch { j = {}; } }
  j.projects ??= {}; j.projects[root] = { ...(j.projects[root] || {}), hasTrustDialogAccepted: true };
  writeFileSync(p, JSON.stringify(j, null, 2));
  return true;
}
const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) trustWorkspace({ root: process.cwd() }).then((did) => console.log(did ? "trusted" : "skipped (not CI)"));
