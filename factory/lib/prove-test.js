import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

/** 테스트 파일을 지정 실행하는 명령이 없으면 증명 게이트는 "실패"가 아니라 설정 오류다. */
const MISSING_TEST_FILES = { ok: false, misconfigured: true, detail: "commands.test_files missing" };

/**
 * 외부 감사 2026-09-14 M2 — **base 워크트리에는 `node_modules`가 없다.**
 *
 * `git worktree add --detach`가 만드는 것은 소스뿐이라, 이 저장소의 새 테스트를 그 위에서 돌리면
 * 거의 언제나 `Cannot find module 'vitest'`로 죽는다. 그 exit≠0을 예전 코드는 "base에서 실패했다
 * = 이 변경을 증명한다"로 읽었다 — 곧 **모든** 테스트가, 심지어 아무것도 증명하지 않는 테스트도
 * 이 게이트를 통과했다. 증명 게이트가 통째로 무의미했던 지점이다.
 *
 * 그래서 테스트를 돌리기 전에 base 워크트리에 의존성을 깐다. 하네스가 `[runtime].setup`을
 * 정의했으면 **그것이 정본이다**(pnpm·yarn·bundler 저장소는 npm을 모른다). 없으면 lockfile이 있을
 * 때 `npm ci`, `package.json`만 있으면 `npm install --no-audit`, 둘 다 없으면 설치할 것이 없다
 * (Node 저장소가 아닐 수 있다 — 없는 생태계를 발명하지 않는다).
 */
export function baseInstallCommand(harness, tmp, exists = existsSync) {
  const setup = harness?.runtime?.setup;
  if (typeof setup === "string" && setup.trim()) return setup;
  if (exists(join(tmp, "package-lock.json"))) return "npm ci";
  if (exists(join(tmp, "package.json"))) return "npm install --no-audit";
  return null;
}

/**
 * base 실행의 실패가 **이 변경에 대해 아무것도 말해주지 않는** 종류인가(감사 M2). 모듈을 못 찾거나
 * ESM/CJS 경계에서 죽은 것은 "base에 그 기능이 없다"가 아니라 "base에서 테스트가 아예 시작되지
 * 못했다"다 — 증명이 아니라 판정 불가다.
 *
 * 반대로 **넣지 않은 것**이 이 목록의 핵심이다: `does not provide an export named 'x'`와
 * `lib.parseX is not a function`은 정직한 증명의 모습 그대로다(base에는 그 export가 없다).
 * `is not a function`은 주어가 `undefined`일 때만 — 임포트 자체가 통째로 비었다는 신호일 때만 —
 * 판정 불가로 센다.
 */
const INCONCLUSIVE_ON_BASE = [
  /Cannot find module/i,
  /Cannot find package/i,
  /ERR_MODULE_NOT_FOUND/,
  /SyntaxError: (?:Unexpected token '?export'?|Cannot use import statement outside a module)/,
  /(?:^|[\s:])(?:undefined|\(intermediate value\)) is not a function/,
];
export const inconclusiveOnBase = (text) => INCONCLUSIVE_ON_BASE.some((re) => re.test(String(text || "")));

export async function proveTest({ run, cwd, harness, base, addedTests, tmp = `${cwd}/.factory/out/prove-wt`, exists = existsSync }) {
  if (!harness.commands?.test_files) return { ...MISSING_TEST_FILES };
  if (!addedTests?.length) return { ok: false, detail: "no new tests in this change (done_when must be backed by new tests)" };
  const g = (args) => run("git", args, { cwd });
  const add = await g(["worktree", "add", "--detach", tmp, base]);
  if (add.code !== 0) return { ok: false, detail: `worktree add failed: ${add.stderr}` };
  try {
    for (const f of addedTests) {
      mkdirSync(dirname(join(tmp, f)), { recursive: true });
      const cp = await run("cp", [`${cwd}/${f}`, `${tmp}/${f}`]);
      if (cp.code !== 0) return { ok: false, detail: `copy failed for ${f}: ${cp.stderr}` };
    }
    // 감사 M2 — 설치가 실패하면 그 base 실행은 무엇을 말하든 믿을 수 없다. fail closed:
    // "실패했으니 증명됐다"가 정확히 이 게이트가 죽었던 방식이다.
    const install = baseInstallCommand(harness, tmp, exists);
    if (install) {
      const ins = await run("bash", ["-lc", install], { cwd: tmp });
      if (ins.code !== 0) {
        return { ok: false, misconfigured: true, inconclusive: [...addedTests], detail: `base dependency install failed (${install}, exit ${ins.code}) — the base run cannot prove anything: ${String(ins.stderr || ins.stdout || "").trim().slice(0, 200)}` };
      }
    }
    const cmd = harness.commands.test_files.replace("{files}", addedTests.map(q).join(" "));
    const r = await run("bash", ["-lc", cmd], { cwd: tmp });
    if (r.code === 0) return { ok: false, detail: `new tests passed on base ${base.slice(0, 7)} — they do not prove the change` };
    const output = `${r.stdout || ""}\n${r.stderr || ""}`;
    if (inconclusiveOnBase(output)) {
      return { ok: false, misconfigured: true, inconclusive: [...addedTests], detail: `inconclusive on base ${base.slice(0, 7)}: the new tests did not run there (module resolution / import error), so their failure proves nothing${install ? ` — dependencies were installed with \`${install}\`` : " — no dependency install command was found for the base worktree"}` };
    }
    return { ok: true, detail: `new tests fail on base (exit ${r.code})` };
  } finally {
    await g(["worktree", "remove", "--force", tmp]);
  }
}

export async function repeatNewTests({ run, cwd, harness, addedTests, times, fullSuiteCmd = harness.commands?.unit }) {
  // 반복 횟수를 모르면 "흔들리지 않음"을 주장할 수 없다 — 통과가 아니라 설정 오류다.
  if (!(times >= 1)) return { ok: false, misconfigured: true, runs: [], detail: "new_test_repeats missing" };
  if (!harness.commands?.test_files) return { ...MISSING_TEST_FILES, runs: [] };
  if (!addedTests?.length) return { ok: true, runs: [], detail: "no new tests" };
  const cmd = harness.commands.test_files.replace("{files}", addedTests.map(q).join(" "));
  const runs = [];
  for (let i = 0; i < times; i++) {
    const noisy = i === 0 && fullSuiteCmd ? run("bash", ["-lc", fullSuiteCmd], { cwd }) : null;
    const r = await run("bash", ["-lc", cmd], { cwd });
    if (noisy) await noisy;
    runs.push({ code: r.code });
  }
  const ok = runs.every((r) => r.code === 0);
  const quietNote = fullSuiteCmd ? "" : " (quiet: no full-suite command configured)";
  return { ok, runs, detail: (ok ? `${times}/${times} passes` : `non-deterministic: exit codes ${runs.map((r) => r.code).join(",")}`) + quietNote };
}
