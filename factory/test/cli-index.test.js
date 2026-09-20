import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot, HELP, main } from "../cli/index.js";
import { makeFakeRun, run as realRun } from "../lib/exec.js";

// ── fix round 2 (F15): `factory init`을 하위 디렉터리에서 실행해도 repo 루트에 설치한다 ──

test("repoRoot: resolves the git toplevel, not the current working directory", async () => {
  const run = makeFakeRun([{ match: (c, a) => c === "git" && a[0] === "rev-parse", result: { code: 0, stdout: "/repo\n", stderr: "" } }]);
  expect(await repoRoot({ run, cwd: "/repo/src/deep" })).toBe("/repo");
});

test("repoRoot: falls back to cwd when this is not a git repo (git exits non-zero)", async () => {
  const run = makeFakeRun([{ match: () => true, result: { code: 128, stdout: "", stderr: "fatal: not a git repository" } }]);
  expect(await repoRoot({ run, cwd: "/not/a/repo" })).toBe("/not/a/repo");
});

test("repoRoot: falls back to cwd when git prints nothing (or is missing entirely)", async () => {
  const empty = makeFakeRun([{ match: () => true, result: { code: 0, stdout: "\n", stderr: "" } }]);
  expect(await repoRoot({ run: empty, cwd: "/x" })).toBe("/x");
  const missing = makeFakeRun([{ match: () => true, result: { code: 127, stdout: "", stderr: "spawn git ENOENT" } }]);
  expect(await repoRoot({ run: missing, cwd: "/x" })).toBe("/x");
});

test("repoRoot: against a real repo, a subdirectory resolves to the repo root", async () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-root-"));
  await realRun("git", ["init", "-q", "-b", "main"], { cwd: root });
  const sub = join(root, "packages", "app");
  mkdirSync(sub, { recursive: true });
  const resolved = await repoRoot({ cwd: sub });
  // macOS의 /var → /private/var 심볼릭 링크 때문에 문자열 비교 대신 끝부분으로 확인한다
  expect(resolved.endsWith(root.replace(/^\/private/, ""))).toBe(true);
  expect(resolved).not.toBe(sub);
}, 20000);   // 실제 git 프로세스를 두 번 띄운다 — 전체 스위트 병렬 실행에서는 기본 5s로 모자란다

test("HELP still lists the five factory subcommands", () => {
  for (const s of ["init", "doctor", "bootstrap", "run", "status"]) expect(HELP).toContain(`factory ${s}`);
});

// ── F4: `main()`은 doctorCommand에 `run`을 주입해야 한다 ──────────────────────────────────────
// doctorCommand({root, pkgRoot, argv, io})에는 `run` 기본값이 없다 — 빠뜨리면 첫 `run("git", ["ls-files"])`
// 에서 "run is not a function"으로 죽는다. 단위 테스트는 doctorCommand를 직접 부르며 항상 run을 넘겨 왔기
// 때문에 이 배선만 아무도 밟지 않았다. 여기서는 CLI 진입점을 그대로 통과시킨다.
test("main(['doctor','--no-run','--offline']) wires a real run() — it returns an exit code instead of throwing", async () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-cli-doctor-"));
  await realRun("git", ["init", "-q", "-b", "main"], { cwd: root });
  const cwd = process.cwd();
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    process.chdir(root);
    // harness.toml이 없는(=아직 init하지 않은) 저장소이므로 exit 1이 정상이다 — 확인하는 것은
    // "throw하지 않고 숫자를 돌려준다"이다.
    const code = await main(["doctor", "--no-run", "--offline"]);
    expect(typeof code).toBe("number");
  } finally {
    process.chdir(cwd);
    console.log = log; console.error = err;
  }
}, 30000);

// ── KTB-44 (리뷰 nit 7): `factory rehearse`의 디스패치 줄을 실제로 밟는다 ─────────────────────
// 스위치의 오타는 런타임에만 드러난다 — HELP에 적혀 있는 명령이 `unknown factory command`로 떨어지는
// 사고는 사람이 그 명령을 처음 부르는 순간에야 보인다.
test("main(['rehearse']) reaches the rehearse command (not the unknown-command branch)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-cli-rehearse-"));
  await realRun("git", ["init", "-q", "-b", "main"], { cwd: root });
  const cwd = process.cwd();
  const log = console.log, err = console.error;
  const lines = [];
  console.log = (s) => lines.push(String(s)); console.error = (s) => lines.push(String(s));
  try {
    process.chdir(root);
    // gh 세션이 없는 임시 저장소라 repo 해석이나 dispatch에서 실패한다 — 확인하는 것은 "그 명령에
    // 닿았다"이지 성공이 아니다(unknown 분기였다면 HELP가 찍힌다).
    const code = await main(["rehearse"]);
    expect(typeof code).toBe("number");
    expect(lines.join("\n")).not.toMatch(/unknown factory command/);
  } finally {
    process.chdir(cwd);
    console.log = log; console.error = err;
  }
}, 30000);

test("HELP names rehearse — the adoption order is install → doctor → rehearse → first issue", () => {
  expect(HELP).toMatch(/factory rehearse/);
});

// ── 피드백 루프 T5: `factory analyze`의 디스패치 줄 ───────────────────────────────────────────
// `rehearse`와 같은 이유로 여기 있다 — 스위치의 오타는 런타임에만 드러나고, 그 순간은 사람이 실패한
// 런을 조사하려고 이 명령을 처음 부르는 때다(즉 가장 나쁜 때). 단위 테스트는 `analyzeCommand`를
// 직접 부르므로 이 배선만 아무도 밟지 않는다.
test("main(['analyze']) reaches the analyze command (not the unknown-command branch)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-cli-analyze-"));
  await realRun("git", ["init", "-q", "-b", "main"], { cwd: root });
  const cwd = process.cwd();
  const log = console.log, err = console.error;
  const lines = [];
  console.log = (s) => lines.push(String(s)); console.error = (s) => lines.push(String(s));
  try {
    process.chdir(root);
    // 이슈 번호 없이 부르면 analyze는 usage를 내고 1로 끝난다 — 확인하는 것은 "그 명령에 닿았다"이다.
    const code = await main(["analyze"]);
    expect(code).toBe(1);
    expect(lines.join("\n")).not.toMatch(/unknown factory command/);
    expect(lines.join("\n")).toMatch(/factory analyze <issue>/);
  } finally {
    process.chdir(cwd);
    console.log = log; console.error = err;
  }
}, 30000);

test("HELP names analyze — both arms (an issue's timeline, and the health report)", () => {
  expect(HELP).toMatch(/factory analyze <issue>/);
  expect(HELP).toMatch(/factory analyze --health/);
});
