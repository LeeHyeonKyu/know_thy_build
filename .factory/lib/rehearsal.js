import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { matchesAny } from "./glob.js";
import { q, baseInstallCommand } from "./prove-test.js";

/**
 * ── KTB-44 — **리허설: 첫 이슈 전에 하네스를 러너에서 한 번 돌린다**(ADR-025) ───────────────────
 *
 * own-calendar의 첫 다크 이슈(2026-09-14)는 하네스 초안의 결함 **세 개**를 라운드마다 하나씩 드러냈다:
 * `[runtime].setup`이 Flutter 설치를 빠뜨려 게이트가 exit 127, `flutter analyze`가 기존 info에
 * 걸려 exit 1, `cd client` 뒤의 `test_files`/`test_one`이 레포 루트 기준 경로를 받아 파일을 못 찾음.
 * 셋 다 **러너에서 명령이 실제로 돌 때만** 보이는 사실이다 — `doctor --no-run`/`--offline`은 정적
 * 검사라 구조적으로 볼 수 없고, `doctor --run`은 사람의 노트북에서 돌아 러너의 PATH·설치본·
 * 작업 디렉터리를 증명하지 않는다. 결함 하나에 다크 라운드 하나씩, 3라운드가 하네스 디버깅으로 갔다.
 *
 * 리허설은 그 세 라운드를 **한 번의 잡**으로 바꾼다: 스테이지가 러너에서 하는 일을 이슈 없이 그대로
 * 한 번 한다(게이트 명령 · 파일 지정 실행 · 테스트 하나 지정 실행 · qa 증거 쓰기 · 쓰기 금지 클린
 * 체크 · prove-test 기계 · gh 권한). 판정은 표 하나이고, GREEN이어야만 큐가 열린다.
 */

/** 저장소 변수 — 값은 "무엇에 대해 GREEN이었는가"(해시)이지 "GREEN이었다"(불리언)가 아니다. */
export const REHEARSAL_VARIABLE = "FACTORY_REHEARSED";
/** 변수 쓰기가 admin을 요구하는 저장소의 폴백: 기본 브랜치 head의 commit status. */
export const REHEARSAL_STATUS_CONTEXT = "factory/rehearsal";
export const REHEARSAL_WORKFLOW = "factory-rehearse.yml";
/** 거부 문구는 **한 문장**이다 — 없음·어긋남·읽지 못함이 사람에게는 같은 행동을 요구한다. */
export const REHEARSAL_STALE = "harness changed since the last rehearsal — run `factory rehearse`";
export const rehearsalArtifactName = (runId) => `factory-rehearsal-${runId}`;

/** 스텝별 상한(초). 러너에서 무한히 도는 게이트는 리허설이 아니라 새 사고다. */
export const REHEARSAL_TIMEOUT_SEC = {
  lint: 600, unit: 1800, test_files: 900, test_one: 600, lint_file: 300,
  "prove-test": 1800, "gh-auth": 60, "gh-labels": 120, "gh-push": 180,
};
/** `timeout`은 coreutils의 것이다(러너에 항상 있다). 124 = 상한에 걸렸다 — 실패와 구별해 적는다. */
export const timedCommand = (cmd, sec) => `timeout -k 10 ${sec} bash -lc ${q(cmd)}`;

/** 판정 재료는 앞 세 줄이다 — 표는 증거이지 로그 덤프가 아니다(로그는 잡 화면에 그대로 있다). */
export const firstLines = (text, n = 3) =>
  String(text || "").split("\n").map((s) => s.trimEnd()).filter(Boolean).slice(0, n).join("\n");

/**
 * CHARTER의 **프론트매터만** 지문에 들어간다. 산문(NEVER_AUTOMATE 설명, Definition of Done의 문장)은
 * 사람이 읽는 것이고 러너의 동작을 바꾸지 않는다 — 그것까지 세면 문서 한 줄을 고칠 때마다 큐가 닫힌다.
 */
export function charterFrontmatter(text = "") {
  const m = /^---\n([\s\S]*?)\n---/.exec(String(text || ""));
  return m ? m[1] : "";
}

/**
 * 리허설이 무엇에 대해 GREEN이었는지의 지문. harness.toml 전체 + CHARTER 프론트매터.
 *
 * 구분자는 **`\u0000` 이스케이프로 적는다**(리터럴 NUL 바이트가 아니라 — 리뷰 must_fix 1). 해시되는
 * 바이트는 같지만, 파일에 0x00이 들어가는 순간 git이 이 모듈을 **binary**로 분류해 `git diff`가
 * 내용을 영영 보여주지 않는다 — 게이트를 정의하는 파일이 구조적으로 리뷰 면제가 되고(ADR-021/025가
 * 막으려는 바로 그것), `grep`/`rg`도 기본값으로 건너뛴다. 구분자 자체는 계속 필요하다: 없으면
 * harness의 꼬리와 프론트매터의 머리가 이어져 서로 다른 두 입력이 같은 지문을 낼 수 있다.
 * `factory/bin/lint.js`의 `nul-byte` 규칙이 리터럴 NUL의 재발을 막는다.
 */
export function rehearsalHash({ harnessText = "", charterText = "" } = {}) {
  return createHash("sha256")
    .update(String(harnessText))
    .update("\u0000factory-rehearsal\u0000")
    .update(charterFrontmatter(charterText))
    .digest("hex");
}

/**
 * 지문이 사는 두 파일. 폴백 commit status는 **이 파일들을 건드린 커밋들**에 붙는다 — 기본 브랜치
 * head가 아니다(리뷰 r1 MF2: head는 무관한 머지마다 움직여 **첫 머지부터** 기록을 고아로 만들었다).
 * 그 폴백은 예외가 아니라 본선이다: 저장소 변수 쓰기는 repo admin을 요구하고, ADR-021의 권장 구성에서
 * 워크플로가 쥔 것은 비-admin 봇 토큰이다.
 *
 * **쓰기와 읽기가 같은 커밋을 고르지 않아도 된다**(리뷰 r2 MF2 잔여 + nf-5). r1은 쓰기를 러너의
 * `git log -1 -- <두 경로>`로, 읽기를 경로별 최신 커밋의 날짜 비교로 했는데 그 둘은 **커밋 시각이
 * 같은 초**일 때 다른 커밋을 골랐고(git의 날짜 해상도는 1초다), 그러면 리허설을 몇 번 다시 돌려도
 * 큐가 영영 열리지 않았다 — 쓰는 곳과 읽는 곳이 결정론적으로 엇갈린 채 고정된다. 그래서:
 *   · 쓰기: **경로마다 최신 커밋**에 하나씩 올린다(같은 커밋이면 한 번).
 *   · 읽기: 경로마다 **최근 N개** 커밋을 후보로 훑어 `factory/rehearsal` 상태에서 지금의 해시를
 *     찾으면 그 자리에서 통과시킨다. 그러면 해시를 바꾸지 않는 편집(harness의 주석 한 줄, CHARTER의
 *     산문)이 새 커밋을 만들어도 기록은 여전히 후보 안에 있다(nf-5) — 그 편집은 러너의 동작을 바꾸지
 *     않으므로 큐를 닫을 이유가 없다.
 * 어느 쪽도 느슨하지 않다: 통과의 조건은 여전히 **지금의 지문과 같은 해시**이고, 후보 어디에서도
 * 그것을 찾지 못하면 거부한다.
 */
export const FINGERPRINT_PATHS = [".factory/harness.toml", "docs/factory/CHARTER.md"];

/** 읽기가 훑는 경로별 커밋 수. 10은 "산문 편집 몇 번은 견디되 저장소의 역사를 뒤지지는 않는다"의 선이다. */
export const FINGERPRINT_LOOKBACK = 10;

/** 쓰기 대상: 경로마다 **최신** 커밋(중복 제거). 둘이 같은 커밋이면 한 번만 올린다. */
export async function fingerprintTargets({ gh, branch = "main" }) {
  const out = [];
  for (const p of FINGERPRINT_PATHS) {
    try {
      const c = (await gh.commitsForPath(branch, p, 1))?.[0];
      if (c?.sha && !out.includes(c.sha)) out.push(c.sha);
    } catch { /* 없는 경로(CHARTER 이전)·조회 실패는 나머지 한쪽으로 떨어진다 */ }
  }
  return out;
}

/** 읽기 후보: 경로마다 최근 `lookback`개 커밋을, 경로 순서대로, 중복 없이. */
export async function fingerprintCandidates({ gh, branch = "main", lookback = FINGERPRINT_LOOKBACK }) {
  const out = [];
  for (const p of FINGERPRINT_PATHS) {
    try {
      for (const c of (await gh.commitsForPath(branch, p, lookback)) || []) {
        if (c?.sha && !out.includes(c.sha)) out.push(c.sha);
      }
    } catch { /* 같은 이유 */ }
  }
  return out;
}

/**
 * ADR-025 / 리뷰 r1 must_fix 4 · r2 nf-8 — **기본 브랜치가 아닌 ref에서는 리허설을 돌리지 않는다.**
 * 순수 술어라서 프로세스를 띄우지 않고 시험된다. `refName`이 없으면(로컬 실행) 거부하지 않는다 —
 * 그 자리에는 GitHub의 ref라는 개념이 없고, 기록은 어차피 gh 권한이 판정한다.
 */
export const refuseRef = ({ refName = null, defaultBranch = "main" } = {}) => Boolean(refName) && refName !== defaultBranch;

/** 글롭에 맞는 **실재하는** 첫 파일. 없으면 null — 리허설은 없는 파일을 발명하지 않는다. */
export function pickFile(files = [], globs = []) {
  if (!globs?.length) return null;
  return files.find((f) => matchesAny(globs, f)) ?? null;
}

/**
 * 그 파일의 **첫 테스트 이름**. `test_one`은 이름 하나를 받는 명령이라, 이름을 지어내면 리허설이
 * "0 tests matched"를 GREEN으로 읽는다(vitest는 매치가 없어도 0을 낼 수 있다). 못 읽으면 SKIPPED다.
 */
export function firstTestName(text = "") {
  const m = /(?:^|\s)(?:test|it)(?:\.\w+)?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/.exec(String(text || ""));
  return m ? m[2] : null;
}

export const rehearsalOk = (steps = []) => !steps.some((s) => s.status === "RED");

const step = (name, status, { cmd = null, ms = 0, detail = "" } = {}) => ({ name, status, cmd, ms, detail });

/**
 * 러너 위의 리허설 한 번. **모든 외부 효과는 주입받는다**(`run`·`qaProbe`·`cleanCheck`·`readFile`) —
 * 이 함수의 판정 로직은 가짜 실행 결과 위에서 그대로 시험된다.
 *
 * 한 스텝이 RED여도 **멈추지 않는다**: own-calendar의 3라운드는 결함이 하나씩 드러났기 때문에 생긴
 * 비용이다. 한 번의 리허설은 결함을 전부 보여줘야 한다.
 */
export async function runRehearsal({
  run, cwd, harness, files = [], runId = "local", baseline = null,
  readFile = () => "", qaProbe = async () => ({ ok: true }), cleanCheck = async () => ({ ok: true, dirty: [] }),
  now = () => Date.now(), exists = existsSync, tmp = null,
}) {
  const steps = [];
  const cmds = harness?.commands || {};
  const scratch = tmp || `${cwd}/.factory/out/rehearse-prove-wt`;
  const branch = `factory/rehearsal-${String(runId).replace(/[^\w.-]/g, "") || "local"}`;

  const timed = async (name, cmd, opts = {}) => {
    const sec = REHEARSAL_TIMEOUT_SEC[name] ?? 600;
    const t0 = now();
    const r = await run("bash", ["-lc", timedCommand(cmd, sec)], { cwd, ...opts });
    const ms = Math.max(0, now() - t0);
    const out = firstLines(`${r.stderr || ""}\n${r.stdout || ""}`.trim() || `exit ${r.code}`);
    // 124는 `timeout`이 SIGTERM으로 끝낸 경우이고, **>128은 시그널로 죽은 경우**다(`timeout -k 10`이
    // SIGTERM을 무시하는 명령을 SIGKILL로 올리면 셸은 137로 보고한다 — 상한이 존재하는 이유인 바로 그
    // "멈춘 게이트"가 가장 그렇게 끝난다). 둘 다 "실패"가 아니라 "끝나지 않았다"로 적는다(리뷰 should_fix 7).
    const killed = r.code > 128 ? ` (killed by signal ${r.code - 128})` : "";
    const detail = r.code === 0 ? "" : (r.code === 124 || r.code > 128) ? `timed out after ${sec}s${killed}\n${out}` : out;
    return step(name, r.code === 0 ? "GREEN" : "RED", { cmd, ms, detail });
  };
  const skip = (name, why) => step(name, "SKIPPED", { detail: why });

  // ── 게이트 명령: 스테이지가 러너에서 부르는 것 그대로 ─────────────────────────────
  steps.push(cmds.lint ? await timed("lint", cmds.lint) : skip("lint", "no [commands].lint"));
  steps.push(cmds.unit ? await timed("unit", cmds.unit) : skip("unit", "no [commands].unit"));

  const testFile = pickFile(files, harness?.test?.test_glob || []);
  if (!cmds.test_files) steps.push(skip("test_files", "no [commands].test_files"));
  else if (!testFile) steps.push(skip("test_files", "no file matches [test].test_glob — nothing to run a file-scoped gate against"));
  else steps.push(await timed("test_files", cmds.test_files.replaceAll("{files}", q(testFile))));

  const testName = testFile ? firstTestName(readFile(testFile)) : null;
  if (!cmds.test_one) steps.push(skip("test_one", "no [commands].test_one"));
  else if (!testFile) steps.push(skip("test_one", "no file matches [test].test_glob"));
  // nit 4 — 읽을 수 있는 모양을 문장에 싣는다: pytest·go·rspec 하네스에서 이 SKIPPED는 결함이 아니라
  // "이 파서가 그 모양을 모른다"는 사실이고, 그걸 모르면 사람이 하네스를 의심하며 시간을 쓴다.
  else if (!testName) steps.push(skip("test_one", `no test name could be parsed from ${testFile} (this parser reads \`test("…")\`/\`it('…')\` only — pytest/go/rspec shapes are not recognised) — classify-failure would have nothing to re-run`));
  else steps.push(await timed("test_one", cmds.test_one.replaceAll("{file}", q(testFile)).replaceAll("{name}", q(testName))));

  const sourceFile = pickFile(files, harness?.test?.source_glob || []);
  if (!cmds.lint_file) steps.push(skip("lint_file", "no [commands].lint_file — the lint-touched hook logs nothing"));
  else if (!sourceFile) steps.push(skip("lint_file", "no file matches [test].source_glob"));
  else steps.push(await timed("lint_file", cmds.lint_file.replaceAll("{file}", q(sourceFile))));

  // ── qa 증거 쓰기(KTB-36/KTB-40의 카브아웃이 러너에서도 열려 있는가) ───────────────
  {
    const t0 = now();
    const r = await qaProbe();
    steps.push(step("qa-evidence", r?.ok ? "GREEN" : "RED", { ms: Math.max(0, now() - t0), detail: r?.ok ? "" : firstLines(r?.detail || "write probe failed") }));
  }

  // ── 쓰기 금지 스테이지의 클린 체크(KTB-39 기준선 대비) ───────────────────────────
  {
    const t0 = now();
    const r = await cleanCheck(baseline);
    const detail = r?.ok ? "" : firstLines(r?.dirty?.length ? `worktree dirty after the gate commands: ${r.dirty.join(", ")}` : (r?.reason || "clean check failed"));
    steps.push(step("clean-check", r?.ok ? "GREEN" : "RED", { ms: Math.max(0, now() - t0), detail }));
  }

  // ── prove-test 기계(감사 M2): base 워크트리 + 의존성 설치 ────────────────────────
  {
    const t0 = now();
    let status = "GREEN", detail = "", cmd = null;
    // 치우기는 `finally`에 있다(리뷰 should_fix 2). 던지는 경로(주입된 `exists`가 throw, spawn ENOENT로
    // reject되는 `run`)에서 정리를 건너뛰면 남은 워크트리가 **다음 런의 `worktree add`를 죽이고**
    // 스크럽이 훑는 트리를 배로 만든다 — 리허설이 다음 리허설을 막는 모양이다.
    try {
      const add = await run("git", ["worktree", "add", "--detach", scratch, "HEAD"], { cwd });
      if (add.code !== 0) {
        status = "RED";
        detail = firstLines(`${add.stderr || ""}\n${add.stdout || ""}`.trim() || `git worktree add exit ${add.code}`);
      } else {
        const install = baseInstallCommand(harness, scratch, exists);
        cmd = install;
        if (install) {
          const ins = await timed("prove-test", install, { cwd: scratch });
          status = ins.status; detail = ins.detail;
        } else {
          detail = "no dependency install command for the base worktree (not a Node repo?) — prove-test would run the new tests without deps";
        }
      }
    } catch (e) {
      status = "RED";
      detail = firstLines(`prove-test machinery threw: ${e?.message || e}`);
    } finally {
      // 만들었든 못 만들었든 한 번 부른다 — 없는 워크트리의 remove는 그냥 실패하고, 그 실패는 판정이 아니다.
      try { await run("git", ["worktree", "remove", "--force", scratch], { cwd }); } catch { /* best-effort */ }
    }
    steps.push(step("prove-test", status, { cmd, ms: Math.max(0, now() - t0), detail }));
  }

  // ── gh 권한: 스테이지가 실제로 쓰는 세 가지 ──────────────────────────────────────
  steps.push(await timed("gh-auth", "gh api user"));
  steps.push(await timed("gh-labels", "gh label list --limit 200"));
  steps.push(await timed("gh-push", [
    "set -e",
    `git push --dry-run origin HEAD:refs/heads/${branch}`,
    // --dry-run은 아무것도 만들지 않는다 — 그래도 지운다(예전 런이 진짜로 만든 스크래치가 남아 있을 수 있다).
    `git push origin --delete ${branch} >/dev/null 2>&1 || true`,
  ].join("\n")));

  return { steps, ok: rehearsalOk(steps) };
}

/** 잡 요약과 CLI가 **같은** 표를 쓴다 — 사람이 두 자리에서 다른 것을 읽으면 그 표는 증거가 아니다. */
export function renderRehearsalTable(steps = []) {
  const esc = (s) => String(s || "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
  const rows = steps.map((s) => `| ${s.name} | ${s.status} | ${(Number(s.ms || 0) / 1000).toFixed(1)}s | ${esc(s.detail)} |`);
  return ["| step | status | duration | first lines of failure |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

/**
 * `recorded`(리뷰 must_fix 5) — **기록의 성패가 판정의 일부다.** 예전에는 표가 전부 GREEN이면
 * `ok: true`였고 기록 실패는 잡 로그에만 남았다: 잡은 빨간데 아티팩트는 `ok: true`라 `factory rehearse`가
 * "the queue is open"을 찍고 0으로 끝났다 — 그러고 나면 첫 이슈가 "harness changed…"로 거부된다.
 * 이제 `ok`는 스텝 전부 GREEN **그리고** 두 기록 중 하나가 성공했을 때만 참이다(기록을 시도하지
 * 않았으면 — 로컬 실행·RED — `recorded`는 null이고 `ok`는 스텝만으로 정해진다).
 */
export function rehearsalReport({ steps = [], hash = null, runId = "local", at = new Date().toISOString(), recorded = null } = {}) {
  const stepsOk = rehearsalOk(steps);
  return {
    schema: "factory.rehearsal.v1",
    ok: stepsOk && (recorded == null || Boolean(recorded.via)),
    steps_ok: stepsOk,
    hash,
    run_id: String(runId),
    generated_at: at,
    recorded,
    steps: steps.map((s) => ({ name: s.name, status: s.status, ms: s.ms, cmd: s.cmd ?? null, detail: s.detail || "" })),
  };
}

/**
 * 큐가 열려 있는가. **읽지 못한 것은 통과가 아니다**(fail closed): 지금의 해시를 계산하지 못했으면
 * 이 저장소가 리허설한 그 하네스인지 증명할 수 없다.
 */
export function rehearsalGate({ recorded = null, current = null } = {}) {
  if (!current) return { ok: false, reason: `${REHEARSAL_STALE} (the current harness+CHARTER fingerprint could not be computed — .factory/harness.toml unreadable?)` };
  // 문자열 하나를 받던 옛 호출자도 받는다 — 그 값은 변수 쪽 기록으로 읽는다.
  const rec = typeof recorded === "string" ? { variable: recorded, status: null } : (recorded || {});
  const have = [["variable", rec.variable], ["status", rec.status]].filter(([, h]) => h);
  /**
   * 리뷰 should_fix 1 — **둘 다 읽고, 하나라도 맞으면 연다.** 변수를 먼저 보고 무조건 그것으로
   * 판정하면, 한때 admin 토큰으로 변수를 썼다가 문서가 권하는 비-admin 봇 토큰으로 옮긴 저장소는
   * 얼어붙은 옛 해시를 영원히 읽고 **큐를 다시 열 방법이 없다**. 여전히 fail closed다: 둘 다
   * 어긋나면(또는 아무 기록도 없으면) 거부한다.
   */
  const matched = have.filter(([, h]) => h === current).map(([k]) => k);
  if (matched.length) return { ok: true, source: matched.join("+") };
  if (!have.length) return { ok: false, reason: `${REHEARSAL_STALE} — no GREEN rehearsal is recorded (${REHEARSAL_VARIABLE} / ${REHEARSAL_STATUS_CONTEXT})` };
  return { ok: false, reason: `${REHEARSAL_STALE} — recorded ${have.map(([k, h]) => `${k} ${h.slice(0, 12)}`).join(", ")}, current ${current.slice(0, 12)}` };
}

const hashInText = (s) => (/\b([0-9a-f]{64})\b/.exec(String(s || "")) || [])[1] || null;

/**
 * 기록된 리허설 해시 — **두 출처를 모두 읽는다**: 저장소 변수와, 지문 경로를 건드린 최근 커밋들의
 * `factory/rehearsal` commit status. 어느 쪽도 우선하지 않는다(`rehearsalGate`가 "하나라도 맞으면"으로
 * 판정한다). `current`를 주면 후보를 훑다가 **그것과 같은 해시를 만나는 순간 멈춘다** — 그 조기 종료가
 * 곧 tolerant binding이다(r2 MF2). 못 만나면 가장 새 후보에서 읽은 해시를 돌려준다: 거부 메시지가
 * "무엇이 기록돼 있는가"를 말할 수 있어야 사람이 다음 행동을 안다.
 *
 * gh가 통째로 말을 안 해도 throw하지 않는다 — 호출자가 "확인 못 함"으로 fail closed 한다.
 */
export async function recordedRehearsal({ gh, branch = "main", current = null, lookback = FINGERPRINT_LOOKBACK }) {
  let variable = null;
  try { variable = hashInText(await gh.getVariable(REHEARSAL_VARIABLE)); }
  catch { /* 변수를 못 읽는 것은 그 기록이 없는 것과 같은 행동을 요구한다 */ }

  let status = null, sha = null;
  for (const candidate of await fingerprintCandidates({ gh, branch, lookback })) {
    let found = null;
    try {
      const statuses = await gh.commitStatuses(candidate);
      found = hashInText((statuses || []).find((x) => x.context === REHEARSAL_STATUS_CONTEXT && x.state === "success")?.description);
    } catch { continue; }
    if (!found) continue;
    if (current && found === current) { status = found; sha = candidate; break; }
    if (!status) { status = found; sha = candidate; }   // 최신 후보의 기록 — 거부 메시지의 재료
  }
  const sources = [variable ? "variable" : null, status ? "status" : null].filter(Boolean);
  return { variable, status, sha, source: sources.join("+") || null };
}

/**
 * GREEN인 리허설만 기록한다. 변수가 1순위이고(성공하면 그것으로 끝), admin을 요구해 실패하면
 * **지문 경로마다 최신 커밋**에 commit status를 올린다 — 둘이 같은 커밋이면 한 번이다. 러너도 이
 * 원격 조회를 쓴다(r2 MF2: 러너만 `git log`로 고르던 시절에는 쓰는 커밋과 읽는 커밋이 엇갈릴 수 있었다).
 *
 * 돌려주는 것은 판정 재료다(`rehearsal.json`의 `recorded`): 어느 쪽이 성공/실패했고 어느 sha에 붙었는가.
 */
export async function recordRehearsal({ gh, hash, branch = "main", targets = null, targetUrl = undefined }) {
  const out = { via: null, variable: null, status: null, sha: null };
  try {
    await gh.setVariable(REHEARSAL_VARIABLE, hash);
    out.via = "variable";
    out.variable = "ok";
    out.status = "not attempted (the repo variable was written)";
    return out;
  } catch (e) {
    out.variable = `error: ${e?.message || e}`;
  }
  try {
    const shas = targets || (await fingerprintTargets({ gh, branch }));
    if (!shas.length) throw new Error(`could not resolve any fingerprint commit (${FINGERPRINT_PATHS.join(", ")} on ${branch})`);
    const posted = [], failed = [];
    for (const sha of shas) {
      try {
        await gh.setStatus({ sha, context: REHEARSAL_STATUS_CONTEXT, state: "success", description: `rehearsal GREEN ${hash}`, targetUrl });
        posted.push(sha);
      } catch (e) { failed.push(`${String(sha).slice(0, 7)}: ${e?.message || e}`); }
    }
    // 하나라도 붙으면 기록은 성립한다 — 읽기는 후보를 전부 훑기 때문이다.
    if (!posted.length) throw new Error(failed.join("; ") || "no status could be posted");
    out.via = "status";
    out.status = failed.length ? `ok on ${posted.map((x) => x.slice(0, 7)).join(", ")}; failed on ${failed.join("; ")}` : "ok";
    out.sha = posted.join(",");
  } catch (e2) {
    out.status = `error: ${e2?.message || e2}`;
  }
  return out;
}

/**
 * **프로덕션 호출자가 전부 쓰는 하나의 배선**(리뷰 must_fix 3). `transition()`은 이제 큐로 가는
 * 전이에 배선된 검사기를 요구하고, 그 검사기는 어디서 불리든 같아야 한다: 지문은 **로컬 파일**에서
 * 계산하고(러너·사람의 셸 모두 체크아웃을 갖고 있다), 기록은 **저장소**에서 읽는다.
 * `bin/transition.js`(사람)·`bin/sweep.js`(sweeper의 하네스 주차 해제)·merge 스테이지(step 9)가
 * 이 함수 하나를 부른다 — 거부된 로봇 재큐는 다음 sweep에서 다시 시도된다(그 팔은 이미 실패 편향이다).
 */
export function makeRehearsalChecker({ gh, root, branch = "main", readFile = (p) => readFileSync(p, "utf8") }) {
  return async () => {
    // `branch`는 값이거나 **지연 함수**다(통합 1.3.0): run-stage는 deps를 조립할 때 아직 harness.toml을
    // 읽지 않았으므로(`charterReady`가 나중에 읽는다) 값으로 넘기면 언제나 "main"으로 굳는다 — 기본
    // 브랜치가 `master`/`trunk`인 저장소에서는 기록을 엉뚱한 브랜치에서 찾아 큐가 영영 닫힌다.
    const branchNow = typeof branch === "function" ? (branch() || "main") : branch;
    const read = (p) => { try { return readFile(join(root, p)); } catch { return null; } };
    const harnessText = read(FINGERPRINT_PATHS[0]);
    const current = harnessText == null ? null : rehearsalHash({ harnessText, charterText: read(FINGERPRINT_PATHS[1]) || "" });
    // `current`를 함께 넘긴다 — 읽기가 후보를 훑다가 일치를 만나면 그 자리에서 멈춘다(r2 MF2).
    const recorded = await recordedRehearsal({ gh, branch: branchNow, current });
    return rehearsalGate({ recorded, current });
  };
}

/**
 * doctor `rehearsal.current`. 등급이 셋인 이유: 어긋난 기록은 **큐가 실제로 막히는 상태**라 FAIL이고,
 * 기록이 아예 없는 것은 설치 직후의 정상 상태(채택 순서는 install → doctor → rehearse → 첫 이슈)라
 * WARN이며, 오프라인은 판정 불가라 WARN이다.
 */
export function checkRehearsalCurrent({ recorded = null, current = null, skipped = null } = {}) {
  const id = "rehearsal.current";
  if (skipped) return { id, level: "WARN", detail: `not checked: ${skipped} — a stale rehearsal is only visible against the repo (variable ${REHEARSAL_VARIABLE} / status ${REHEARSAL_STATUS_CONTEXT})` };
  if (!current) return { id, level: "FAIL", detail: "could not compute the harness+CHARTER fingerprint — .factory/harness.toml unreadable" };
  const rec = typeof recorded === "string" ? { variable: recorded, status: null } : (recorded || {});
  const have = [["variable", rec.variable], ["status", rec.status]].filter(([, h]) => h);
  if (!have.length) return { id, level: "WARN", detail: "no rehearsal on record — run `factory rehearse` before the first issue (transition → factory:queue is refused until it is GREEN)" };
  const gate = rehearsalGate({ recorded: rec, current });
  // 두 출처를 함께 적는다 — "변수는 낡았지만 상태는 맞다"가 실제로 일어나는 상태이고(권한이 바뀐 저장소),
  // 그때 사람이 보아야 하는 것은 "무엇이 무엇과 어긋났는가"다.
  const shown = have.map(([k, h]) => `${k} ${h.slice(0, 12)}`).join(", ");
  if (!gate.ok) return { id, level: "FAIL", detail: `${REHEARSAL_STALE} — recorded ${shown}, current ${current.slice(0, 12)}${rec.sha ? ` (status read on ${String(rec.sha).slice(0, 7)})` : ""}` };
  return { id, level: "PASS", detail: `${current.slice(0, 12)} (${gate.source})` };
}
