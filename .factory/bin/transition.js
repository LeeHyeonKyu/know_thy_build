#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { parseTransitionArgs, refuseHumanFlag, transition } from "../lib/transition.js";
import { makeRehearsalChecker } from "../lib/rehearsal.js";
import { loadHarness } from "../lib/config.js";

const USAGE = [
  "usage: transition <issue> [<to-label>] [--human] [--retry] [--reason <text>]",
  "",
  "  --human   전이 거부를 needs-human으로 옮기지 않고 이유만 돌려준다.",
  "            게이트 파일(.factory/out/gates.json) 요구는 --human으로도 건너뛸 수 없다 —",
  "            사람이 실행해도 awaiting-review/approved/merged는 이번 런의 GREEN 판정 파일을 요구한다.",
  "  --retry   (--human 전용, ADR-020 KTB-32) factory:needs-human에서 **중단 지점**으로 되돌린다.",
  "            목적 라벨은 이슈에 남은 기록이 정한다 — 마지막으로 blocked/needs-human으로 간 전이의",
  "            출발 라벨(awaiting-review면 review만 다시 돈다). 라벨을 명시해도 같은 검사를 지난다:",
  "            중단 지점이 아닌 자리로는 전이하지 않는다(exit 2, 라벨 불변).",
].join("\n");

const args = parseTransitionArgs(process.argv.slice(2));
if (args.error) { console.error(`transition: ${args.error}\n\n${USAGE}`); process.exit(1); }
const { issue, to, human, retry, reason } = args;

// 리뷰 3c63672 MF-2 — 두 번째 자물쇠(`refuseHumanFlag`의 근거는 `lib/transition.js`에 있다). 첫 번째는
// `hooks/block-dangerous.sh`(셸 경계)고, 이것은 그 훅을 뚫고 여기까지 온 호출을 위한 방어선이다.
// `gh`를 부르기 전에(네트워크 호출 없이) 거절한다.
if ((human || retry) && refuseHumanFlag(process.env)) {
  console.error(
    "transition: --human/--retry refused — this looks like an agent session or CI runner " +
    "(CLAUDE_PROJECT_DIR or GITHUB_ACTIONS is set), not a person's own shell. " +
    "--human/--retry is the person's edge (ADR-020 KTB-32, review 3c63672 MF-2) — stages transition in-process."
  );
  process.exit(2);
}

const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
// 전이 경로다 — 게이트 판정 파일을 읽어서 넘긴다(gatesChecked). 파일이 없으면 없는 대로 넘기고
// requirements가 "확인 안 됨"으로 거부한다. 사람이 실행해도 판정 파일을 대신 써주지는 않는다.
const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
const gatesPath = join(root, ".factory/out/gates.json");
let gatesFile = null;
if (existsSync(gatesPath)) {
  try { gatesFile = JSON.parse(readFileSync(gatesPath, "utf8")); }
  catch (e) { console.error(`transition: ${gatesPath} unreadable — ${e.message}`); }
}
const ctxExtra = { gatesChecked: true, ...(gatesFile ? { gatesFile } : {}) };
const gh = makeGh({ run, repo });

/**
 * KTB-44 / ADR-025 — **큐로 가는 전이만** 리허설을 묻는다. 지문은 로컬에서 계산하고(harness.toml +
 * CHARTER 프론트매터), 기록은 저장소에서 읽는다. 읽지 못하면 통과가 아니라 거부다(fail closed) —
 * own-calendar의 3라운드는 "러너에서 한 번도 돌려보지 않은 하네스로 이슈를 시작한" 대가였다.
 * 검사기는 목적 라벨이 `factory:queue`일 때만 불린다(다른 전이는 gh 호출 하나도 더 하지 않는다).
 */
let defaultBranch = "main";
try { defaultBranch = loadHarness(root)?.project?.default_branch || "main"; } catch { /* 기본값 그대로 */ }
const rehearsal = makeRehearsalChecker({ gh, root, branch: defaultBranch });

const r = await transition({ gh, issue, to, human, retry, reason, ctxExtra, rehearsal });
console.log(JSON.stringify(r));
process.exit(r.ok ? 0 : 2);
