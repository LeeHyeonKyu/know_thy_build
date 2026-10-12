import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { run as realRun } from "../lib/exec.js";
import { resolveRepo as realResolveRepo } from "../lib/gh.js";

const STAGES = ["triage", "plan", "implement", "review"];
/** `--remote`는 merge도 받는다 — 브랜치 보호가 막는 것은 **로컬 실행**이고, dispatch는 CI에서 도는 일이다. */
const REMOTE_STAGES = [...STAGES, "merge"];
const USAGE = `usage: factory run <${STAGES.join("|")}|retro> <issue>   # retro takes no issue, optional --force
       factory run <${REMOTE_STAGES.join("|")}> <issue> --remote   # dispatch the CI workflow, run nothing locally
       factory run merge <issue>   # operator session only (not a CI runner): merge locally with your token, no veto wait (ADR-044)`;

/** 기본 spawnInherit — stdio를 그대로 물려준다(사람이 로컬에서 실시간으로 본다). */
const defaultSpawnInherit = (cmd, args, opts) => spawnSync(cmd, args, { ...opts, stdio: "inherit" }).status ?? 1;

/**
 * `factory run <stage> <issue>` — CI가 쓰는 바로 그 스크립트(`.factory/bin/run-stage.js`)를 로컬에서 돌린다(R7).
 * `factory run retro [--force]`는 같은 preflight를 지나 `.factory/bin/retro.js`를 돌린다 — retro는 이슈
 * 인자가 없고(라벨 상태 머신 밖의 잡이다) `--force`로 N을 무시한 전체 실행을 강제한다(§8.4, P4-R5).
 * 5단계 preflight: (1) 스테이지 검증 — merge는 운영 세션에서만 로컬에서 돈다(#236 dw4, ADR-044): 러너(`GITHUB_ACTIONS`가
 * 있으면, 빈 값이어도)에서는 거부한다. 그 외 미지원 스테이지는 usage.
 * (2) factory init 여부. (3) `.factory/` 런타임 의존성(smol-toml) 설치 여부 — 없으면 그 자리에서 npm install.
 * (4) gh 인증 — 두 스크립트 모두 곧바로 gh를 호출하므로 여기서 먼저 실패를 사람이 읽을 수 있게 잡는다.
 * (5) 실제 실행은 별도 프로세스로 stdio를 그대로 물려 스폰한다 — heartbeat/claude -p 등 오래 걸리는
 * 작업을 하므로 캡처하지 않고 사람이 실시간으로 본다. `FACTORY_LOCAL_ENTRY=1`을 심어 run-stage.js의
 * triage가 "락을 먼저 잡고 큐잉은 나중에" 경로(§4.2.5)를 타게 한다(retro는 이 env를 보지 않는다).
 */
export async function runCommand({ root, argv = [], io, run = realRun, spawnInherit = defaultSpawnInherit, env: injectedEnv, resolveRepo = realResolveRepo }) {
  const env = injectedEnv ?? process.env;
  // 플래그는 **위치에 상관없이** 플래그다(KTB-10 M7). 예전에는 `argv[0]`·`argv[1]`을 그대로 스테이지·
  // 이슈로 읽어서 `factory run --remote plan 5`가 stage="--remote"로 usage를 뱉었다 — 사람이 실제로
  // 그렇게 친다(sweeper가 하는 일을 손으로 할 때 `--remote`를 먼저 쓰는 게 자연스럽다).
  const [stage, issueArg] = argv.filter((a) => !a.startsWith("-"));
  const isRetro = stage === "retro";
  const remote = argv.includes("--remote");

  // (0) `--remote`: 아무것도 로컬에서 돌리지 않고 CI 워크플로만 띄운다(KTB-8). 라벨이 이미 목적 상태에
  // 있으면 `labeled` 이벤트를 다시 만들 수 없어 멈춘 스테이지를 라벨로 되살릴 수 없다 — sweeper가
  // 30분마다 하는 그 일을 사람·컨트롤러가 지금 하는 손잡이다. init 여부·`.factory` 의존성은 보지
  // 않는다(여기서는 로컬에 그것들이 있을 이유가 없다); gh 인증만 확인한다.
  if (remote) {
    if (isRetro) { io.err("factory run --remote: retro is merge-triggered, not dispatchable by issue"); return 1; }
    if (!REMOTE_STAGES.includes(stage)) { io.err(USAGE); return 1; }
    const n = Number(issueArg);
    if (!Number.isInteger(n) || n <= 0) { io.err(USAGE); return 1; }
    const auth = await run("gh", ["auth", "status"]);
    if (auth.code !== 0) { io.err("factory run: gh is not authenticated — run `gh auth login` first"); return 1; }
    // `-R`를 명시한다(KTB-10 M7). `gh workflow run`은 그것이 없으면 **cwd의 git remote**로 저장소를
    // 고르는데, 이 명령은 로컬에 체크아웃이 있을 이유가 없는 경로다(위에서 init 여부도 보지 않는다) —
    // 남의 레포 안에서 치면 조용히 그 레포의 워크플로를 띄운다. `FACTORY_REPO`가 있으면 그것이 답이고,
    // 없으면 `gh repo view`로 묻는다(`resolveRepo`, KTB-4와 같은 단일 출처).
    let repo;
    try { repo = await resolveRepo({ run }); }
    catch (e) { io.err(`factory run --remote: could not resolve the repository — ${e?.message || e}`); return 1; }
    const r = await run("gh", ["workflow", "run", `factory-${stage}.yml`, "-R", repo, "-f", `issue=${n}`]);
    if (r.code !== 0) { io.err(`factory run --remote: gh workflow run factory-${stage}.yml failed — ${(r.stderr || r.stdout || "").trim()}`); return 1; }
    io.out(`dispatched factory-${stage}.yml for issue #${n}`);
    return 0;
  }

  // (1) 스테이지 검증
  // #236 dw4 (ADR-044) — "merge는 로컬 금지"가 "merge는 운영 세션에서만 로컬 허용"이 됐다: 러너가 아니면 plain `factory run merge <n>`이
  // 로컬 merge를 돌린다. 러너(`GITHUB_ACTIONS`가 env에 있으면 — 빈 값도 러너다, sec1)에서는 거부한다 — 스테이지는 운영자가 아니다.
  // run-stage도 같은 조건을 다시 보고, 행위자가 사람 계정인지까지 확인한다(makeOperatorMergeDeps).
  // env를 주입하지 않은 호출자는 러너가 아님을 증명하지 못한다 — process.env로 추측하지 않고 예전 거부를 그대로 낸다(fail-closed;
  // integrityCommand와 같은 규칙). 실제 진입점 cli/index.js는 env를 명시로 넘기므로 운영자는 이 문구를 보지 않는다.
  if (stage === "merge" && injectedEnv === undefined) { io.err("merge runs only in CI (branch protection) for a caller that injects no env — the local operator merge needs the caller's env (cli/index.js passes it). Nothing was merged."); return 1; }
  if (stage === "merge" && env?.GITHUB_ACTIONS !== undefined) { io.err("factory run merge refused — GITHUB_ACTIONS is set, so this is a CI runner: merge runs locally only from an operator session (ADR-044), and a stage is never the operator. Nothing was merged."); return 1; }
  if (!isRetro && !STAGES.includes(stage) && stage !== "merge") { io.err(USAGE); return 1; }
  let issue = 0;
  if (!isRetro) {
    issue = Number(issueArg);
    if (!Number.isInteger(issue) || issue <= 0) { io.err(USAGE); return 1; }
  }
  const script = isRetro ? ".factory/bin/retro.js" : ".factory/bin/run-stage.js";

  // (2) factory init 여부
  if (!existsSync(join(root, script))) {
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
  const args = isRetro
    ? [script, ...(argv.includes("--force") ? ["--force"] : [])]
    : [script, stage, String(issue)];
  return spawnInherit("node", args, {
    cwd: root,
    // #236 — merge는 운영 표식을 싣는다(run-stage `isOperatorMerge`가 러너가 아님을 다시 확인한다).
    env: { ...env, FACTORY_LOCAL_ENTRY: "1", ...(stage === "merge" ? { FACTORY_OPERATOR_MERGE: "1" } : {}) },
  });
}
