#!/usr/bin/env node
/**
 * `gh pr merge <n>`을 운영 세션이 쳐도 되는가 — 훅(`hooks/block-dangerous.sh`)이 부르는 두 번째 자물쇠.
 *   node .factory/bin/operator-merge-check.js <pr-number>
 * exit 0 = 허용(모든 파일이 `OPERATOR_MERGE_GLOBS` 안, 체크 GREEN, draft 아님, 기본 브랜치 대상), exit 2 = 거부(사유를 stderr에).
 * 읽기만 한다(`gh pr view`). 판정은 `lib/operator-merge.js`(순수). CI 러너(`GITHUB_ACTIONS`)에서는 언제나 거부 — 스테이지는 머지 배우가 아니다.
 * 의존성 없음(`smol-toml` 불필요) — 갓 받은 클론에서도 돈다.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { operatorMergeVerdict } from "../lib/operator-merge.js";
import { isEngineCheckout } from "../lib/non-judge-paths.js";

const refuse = (why) => { process.stderr.write(`operator-merge: refused — ${why}\n`); process.exit(2); };
if (process.env.GITHUB_ACTIONS) refuse("a CI runner is a stage, not the operator — stages never merge through this door");
const n = String(process.argv[2] || "").trim();
if (!/^[0-9]+$/.test(n)) refuse(`usage: operator-merge-check.js <pr-number> (got ${JSON.stringify(n)})`);

// 저장소 정체성은 한 곳에서만 온다(#178 rework arch1): 이 bin이 놓인 체크아웃(`<root>/.factory/bin` 또는 `<root>/factory/bin`).
// PR 조회(gh는 cwd로 저장소를 고른다)·기본 브랜치·엔진 판정 셋 다 이 root에 묶는다 — 세션 cwd가 다른 클론이어도 섞이지 않는다.
const root = fileURLToPath(new URL("../../", import.meta.url));
const gh = spawnSync("gh", ["pr", "view", n, "--json", "number,isDraft,mergeable,baseRefName,files,statusCheckRollup"], { encoding: "utf8", cwd: root });
if (gh.status !== 0) refuse(`gh pr view ${n} failed: ${(gh.stderr || "").trim() || `exit ${gh.status}`}`);
let pr;
try { pr = JSON.parse(gh.stdout); } catch (e) { refuse(`gh pr view ${n} returned no JSON: ${e.message}`); }

// 기본 브랜치: root의 harness.toml의 [project].default_branch가 있으면 그것, 없으면 main. toml 파서 없이 한 줄만 읽는다.
let defaultBranch = "main";
for (const p of [join(root, ".factory", "harness.toml")]) {
  if (!existsSync(p)) continue;
  const m = /^\s*default_branch\s*=\s*"([^"]+)"/m.exec(readFileSync(p, "utf8"));
  if (m) defaultBranch = m[1];
}

// 엔진 저장소인가(#178 rework cf1): 같은 root의 하네스 이름과 엔진 표지로 정한다. 아니면(채택자 저장소, 또는 판단 불가)
// 엔진 파일은 판정 경로다 — 채택자의 `.factory/**`는 사람이 머지한다.
const harnessAt = join(root, ".factory", "harness.toml");
const projectName = existsSync(harnessAt) ? /^\s*name\s*=\s*"([^"]+)"/m.exec(readFileSync(harnessAt, "utf8"))?.[1] : undefined;
const engine = isEngineCheckout({ projectName, exists: (rel) => existsSync(join(root, rel)) });

const v = operatorMergeVerdict(pr, { defaultBranch, engine });
if (!v.ok) refuse(`PR #${n}: ${v.reasons.join("; ")}`);
process.stdout.write(`operator-merge: PR #${n} — ${pr.files.length} file(s), all non-judge paths, checks green — the operator may merge\n`);
