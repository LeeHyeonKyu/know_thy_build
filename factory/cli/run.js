import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { run as realRun } from "../lib/exec.js";

const STAGES = ["triage", "plan", "implement", "review"];
const USAGE = `usage: factory run <${STAGES.join("|")}> <issue>`;

/** 기본 spawnInherit — stdio를 그대로 물려준다(사람이 로컬에서 실시간으로 본다). */
const defaultSpawnInherit = (cmd, args, opts) => spawnSync(cmd, args, { ...opts, stdio: "inherit" }).status ?? 1;

/**
 * `factory run <stage> <issue>` — CI가 쓰는 바로 그 스크립트(`.factory/bin/run-stage.js`)를 로컬에서 돌린다(R7).
 * 5단계 preflight: (1) 스테이지 검증 — merge/retro는 각자 이유가 있는 전용 오류, 그 외 미지원 스테이지는 usage.
 * (2) factory init 여부. (3) `.factory/` 런타임 의존성(smol-toml) 설치 여부 — 없으면 그 자리에서 npm install.
 * (4) gh 인증 — run-stage.js가 곧바로 gh를 호출하므로 여기서 먼저 실패를 사람이 읽을 수 있게 잡는다.
 * (5) 실제 실행은 별도 프로세스로 stdio를 그대로 물려 스폰한다 — run-stage.js는 heartbeat/claude -p 등
 * 오래 걸리는 작업을 하므로 캡처하지 않고 사람이 실시간으로 본다. `FACTORY_LOCAL_ENTRY=1`을 심어
 * run-stage.js의 triage가 "락을 먼저 잡고 큐잉은 나중에" 경로(§4.2.5)를 타게 한다.
 */
export async function runCommand({ root, argv = [], io, run = realRun, spawnInherit = defaultSpawnInherit, env = process.env }) {
  const [stage, issueArg] = argv;

  // (1) 스테이지 검증
  if (stage === "merge") { io.err("merge runs only in CI (branch protection)"); return 1; }
  if (stage === "retro") { io.err("retro arrives with Plan 4"); return 1; }
  if (!STAGES.includes(stage)) { io.err(USAGE); return 1; }
  const issue = Number(issueArg);
  if (!Number.isInteger(issue) || issue <= 0) { io.err(USAGE); return 1; }

  // (2) factory init 여부
  if (!existsSync(join(root, ".factory/bin/run-stage.js"))) {
    io.err("factory not initialized — run factory init");
    return 1;
  }

  // (3) .factory 런타임 의존성
  if (!existsSync(join(root, ".factory/node_modules/smol-toml/package.json"))) {
    const install = await run("npm", ["install", "--prefix", ".factory", "--no-audit", "--no-fund"], { cwd: root });
    if (install.code !== 0) {
      io.err(`factory run: npm install --prefix .factory failed — ${(install.stderr || install.stdout || "").trim()}`);
      return 1;
    }
  }

  // (4) gh 인증 — run-stage.js가 곧바로 gh를 부르므로 미리 사람이 읽을 수 있는 실패로 바꾼다.
  const auth = await run("gh", ["auth", "status"]);
  if (auth.code !== 0) {
    io.err("factory run: gh is not authenticated — run `gh auth login` first");
    return 1;
  }

  // (5) 실제 실행 — CI와 동일한 스크립트를 로컬 락으로 먼저 잡는다(§4.2.5).
  return spawnInherit("node", [".factory/bin/run-stage.js", stage, String(issue)], {
    cwd: root,
    env: { ...env, FACTORY_LOCAL_ENTRY: "1" },
  });
}
