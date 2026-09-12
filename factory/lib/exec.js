import { spawn } from "node:child_process";

/**
 * 자식 프로세스가 절대 물려받으면 안 되는 자격증명(ADR-020 fix round 1). 게이트 `[commands]`는
 * **PR이 쓴 코드**이고 머지 잡 안에서 실행된다 — 그 안에 머지 권한 토큰이 그대로 있으면 게이트
 * 스크립트 한 줄(`gh pr merge`)로 4b 검사를 건너뛸 수 있다. L2 deny는 `claude -p` 세션의 Bash에만
 * 걸리지 벤더 스크립트가 부르는 하위 프로세스에는 걸리지 않으므로, 환경에서 빼는 것이 유일하게
 * 확실한 방법이다.
 */
export const MERGE_CAPABLE_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "FACTORY_BOT_TOKEN", "FACTORY_MERGE_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];

/**
 * `scrubEnv(source, extra) → env 사본` — 자격증명 키만 뺀 **완전한** 환경이다(`PATH`·`HOME`·`CI`·
 * 언어 런타임 변수는 전부 남는다). 엄격한 allowlist가 아닌 이유: 게이트 명령은 남의 저장소의
 * 빌드 명령이라 무엇을 필요로 하는지 우리가 알 수 없다 — 모르는 것을 지우면 게이트가 환경 문제로
 * RED가 되고, 그 RED는 "코드가 틀렸다"로 잘못 읽힌다. 지울 것만 이름으로 지운다.
 */
export function scrubEnv(source = process.env, extra = []) {
  const drop = new Set([...MERGE_CAPABLE_ENV, ...extra]);
  const out = {};
  for (const [k, v] of Object.entries(source)) if (!drop.has(k) && v !== undefined) out[k] = v;
  return out;
}

/**
 * `scrubbedRunner(runner, opts) → runner` — 주입받은 실행기를 감싸 자식 env에서 자격증명을 뺀다.
 * `replaceEnv: true`로 넘기므로 `run()`이 `process.env`를 다시 얹지 않는다(그러면 지운 키가 되돌아온다).
 * 호출자가 준 `opts.env`는 그 위에 얹힌다 — 스크럽된 바탕 위의 명시적 추가는 의도된 것이다.
 */
export function scrubbedRunner(runner = run, { source = process.env, extra = [] } = {}) {
  const base = scrubEnv(source, extra);
  return (cmd, args = [], opts = {}) => runner(cmd, args, { ...opts, env: { ...base, ...(opts.env || {}) }, replaceEnv: true });
}

/**
 * 외부 프로세스 실행. 절대 throw하지 않고 {code, stdout, stderr}를 돌려준다 (spawn 실패는 code 127).
 * `opts.replaceEnv`면 `opts.env`가 **전체** 환경이다(`process.env`를 얹지 않는다) — scrubbedRunner용.
 */
export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const env = opts.replaceEnv ? { ...(opts.env || {}) } : { ...process.env, ...(opts.env || {}) };
      child = spawn(cmd, args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: String(e) });
      return;
    }
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.input != null) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** 백그라운드 셸 명령. 부모가 끝나도 살아 있어야 하므로 detached + unref. */
export function spawnBackground(cmd, { cwd, env } = {}) {
  const child = spawn("bash", ["-lc", cmd], { cwd, env: { ...process.env, ...(env || {}) }, detached: true, stdio: "ignore" });
  child.unref();
  return { pid: child.pid };
}

/** 테스트용 가짜 실행기. table: [{match(cmd,args)→bool, result|fn(cmd,args,opts)→result}] */
export function makeFakeRun(table) {
  const fake = async (cmd, args = [], opts = {}) => {
    fake.calls.push({ cmd, args, opts });
    for (const entry of table) {
      if (entry.match(cmd, args, opts)) {
        return typeof entry.result === "function" ? entry.result(cmd, args, opts) : entry.result;
      }
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
  };
  fake.calls = [];
  return fake;
}
