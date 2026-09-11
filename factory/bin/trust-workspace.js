#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, realpathSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** CI에서만 ~/.claude.json에 cwd를 trusted로 기록한다(ADR-008). 로컬에서는 아무것도 하지 않는다. */
export async function trustWorkspace({ root, home = homedir(), env = process.env }) {
  if (!env.GITHUB_ACTIONS && !env.FACTORY_RUNNER_ID) return false;
  const p = join(home, ".claude.json");
  let j = {};
  // 파싱 실패는 "빈 파일"이 아니다 — 사용자의 ~/.claude.json 전체를 날릴 수 있으므로 덮어쓰지 않는다.
  if (existsSync(p)) {
    try { j = JSON.parse(readFileSync(p, "utf8")); }
    catch (e) { console.error(`factory: ${p} is not valid JSON — refusing to overwrite (${e.message})`); return false; }
  }
  j.projects ??= {}; j.projects[root] = { ...(j.projects[root] || {}), hasTrustDialogAccepted: true };
  const tmp = `${p}.tmp`;                                   // 원자적 교체: 쓰다 죽어도 원본은 온전하다
  writeFileSync(tmp, JSON.stringify(j, null, 2));
  renameSync(tmp, p);
  return true;
}
const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) trustWorkspace({ root: process.cwd() }).then((did) => console.log(did ? "trusted" : "skipped (not CI)"));
