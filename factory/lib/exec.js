import { spawn } from "node:child_process";

/** 외부 프로세스 실행. 절대 throw하지 않고 {code, stdout, stderr}를 돌려준다 (spawn 실패는 code 127). */
export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, stdio: ["pipe", "pipe", "pipe"] });
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
