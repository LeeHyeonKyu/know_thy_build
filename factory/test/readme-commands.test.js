import { test, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * #18 — README.md의 어댑터 문서가 1.3.0을 말하는가, 그리고 **README가 보여 주는 명령이 진짜인가**.
 *
 * 이 파일은 코드가 아니라 문서를 판정한다. 그래서 단언은 두 종류다:
 *   ① 산문 — 어댑터가 알아야 하는 사실(다섯 하위 명령, 거절 규칙 셋, 사람-머지 흐름)이 거기 있는가.
 *      산문이 *옳은지*는 어떤 단위 테스트도 말할 수 없다(plan open_risk 2 / dissent s3). 있는지만 센다.
 *   ② 실행 — README가 보여 주는 `node .factory/bin/qa-evidence.js …` 줄을 **그대로 파싱해서** 출하된
 *      CLI에 먹인다. 없는 파일(127)도, `unknown command`도, usage error도 아니어야 한다.
 *
 * ②의 값은 이 저장소에 0이어야 한다(plan dissent s1): `.factory/out/qa/`는 qa 리뷰어의 증거함이고
 * `runCli`는 `root = cwd`를 못으로 박아 두었다(`--root`는 일부러 없다 — `.factory/bin/qa-evidence.js`의
 * MF-3 주석). 그래서 여기서는 **한 번도 저장소 루트를 cwd로 주지 않는다**. 매번 새 임시 디렉터리다.
 *
 * 그리고 판정은 **부재가 아니라 델타**다(plan dw7 / dissent k1). qa 리뷰어의 정본 경로는
 * `record --issue 18 --claim <id> … -- <repro cmd>`이고, 그 repro cmd가 곧 이 파일이다 — 두 번째 claim
 * 부터 `.factory/out/qa/18/manifest.json`은 **있는 상태로** 이 스위트를 만난다. "증거함이 비어 있다"를
 * 단언하면 이 이슈의 증거를 모으는 그 명령 안에서 스위트가 빨개진다. 그래서 묻는 것은 하나다:
 * *이 파일이 도는 동안 증거함이 한 바이트라도 달라졌는가*. 그 물음의 답은 상자의 이전 내용과 무관하고,
 * `test_18_guard_indifferent_to_existing_qa_evidence`가 씨를 뿌린 상자와 빈 상자 둘에 대고 확인한다.
 */

const REPO = new URL("../../", import.meta.url).pathname;
const CLI_REL = ".factory/bin/qa-evidence.js";
const README = readFileSync(join(REPO, "README.md"), "utf8");
const SUBCOMMANDS = ["record", "attach", "na", "finish", "probe"];

/** 하위 명령마다 "복붙해서 쓸 수 있다"의 최소선 — 이 플래그들이 없으면 그 줄은 예시가 아니라 조각이다. */
const REQUIRED_FLAGS = {
  record: ["issue", "claim", "summary"],
  attach: ["issue", "claim", "kind", "file", "summary"],
  na: ["issue", "claim", "reason"],
  finish: ["issue"],
  probe: ["issue"],
};

// ── README 읽기 도구 ──────────────────────────────────────────────────────────────────────────

/** `#### 제목` 한 절 — 그 제목 줄부터 같은 깊이 이하의 다음 제목 전까지. */
function section(md, titleRe) {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^#{2,6}\s/.test(l) && titleRe.test(l));
  if (start < 0) return null;
  const depth = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,6})\s/);
    if (m && m[1].length <= depth) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

/** README가 **보여 주는** 명령 줄. 펜스 안이든 인라인 백틱 안이든, 닫는 백틱/줄 끝에서 끊는다. */
function shownCommands(md) {
  const out = [];
  for (const line of md.split("\n")) {
    const i = line.indexOf(`node ${CLI_REL}`);
    if (i < 0) continue;
    let rest = line.slice(i);
    const tick = rest.indexOf("`");
    if (tick >= 0) rest = rest.slice(0, tick);
    out.push(rest.trim());
  }
  return out;
}

const argvOf = (cmd) => (cmd.match(/"[^"]*"|'[^']*'|\S+/g) || [])
  .map((t) => (/^".*"$|^'.*'$/.test(t) ? t.slice(1, -1) : t));

/** `--` 앞의 플래그만 — 뒤는 record의 페이로드다. */
function flagsOf(argv) {
  const flags = new Set();
  for (const a of argv.slice(3)) {
    if (a === "--") break;
    if (a.startsWith("--")) flags.add(a.slice(2));
  }
  return flags;
}

const valueOf = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const payloadOf = (argv) => (argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : []);

// ── 증거함: 스냅샷과 델타 ────────────────────────────────────────────────────────────────────

/**
 * `<root>/.factory/out/qa` 전체를 경로 + 내용 해시로 뜬다. 없으면 `{ exists: false }` — 그것도 상태다.
 * 판정에 쓰이는 값은 **두 스냅샷의 같음**뿐이다. 절대적 부재("이 이슈의 manifest는 없어야 한다")를
 * 묻지 않는 이유는 dw7이다: 이 스위트를 실행하는 그 명령이 방금 그 파일을 만들었을 수 있다.
 */
function qaSnapshot(root) {
  const dir = join(root, ".factory/out/qa");
  if (!existsSync(dir)) return { exists: false, entries: [] };
  const entries = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      const rel = relative(dir, p).split("\\").join("/");
      if (e.isDirectory()) { entries.push([`${rel}/`, "dir"]); walk(p); }
      else entries.push([rel, createHash("sha256").update(readFileSync(p)).digest("hex")]);
    }
  };
  walk(dir);
  return { exists: true, entries };
}

/** 이 저장소의 증거함 기준선을 **모듈 로드 시점**에 뜬다 — 이 워커에서 관측할 수 있는 가장 이른 순간. */
const QA_AT_IMPORT = qaSnapshot(REPO);

const baselineFor = (root, given) => given ?? (root === REPO ? QA_AT_IMPORT : qaSnapshot(root));

/** 증거함이 그 사이에 달라졌는가. 관측이지 정리가 아니다 — 이 파일은 증거함에 아무것도 쓰지 않는다. */
function expectBoxUnchanged(root, baseline, when) {
  expect(qaSnapshot(root), `.factory/out/qa under ${root} changed ${when}`).toEqual(baseline);
}

// ── 출하된 CLI를 임시 cwd에서 돌린다 ─────────────────────────────────────────────────────────

let cli;
beforeAll(async () => { cli = await import(pathToFileURL(join(REPO, CLI_REL)).href); });

/** 이 파일이 CLI에 넘긴 모든 cwd — "한 번도 저장소 루트가 아니었다"를 관측 가능한 값으로 센다. */
const CWDS = [];

function cliOpts(cwd, logs, errs) {
  return {
    cwd,
    env: {},
    log: (...a) => logs.push(a.join(" ")),
    err: (...a) => errs.push(a.join(" ")),
    now: () => "2026-09-14T00:00:00Z",
    spawn: () => ({ status: 0, stdout: "", stderr: "", signal: null }),   // 페이로드를 실제로 띄우지 않는다
    gate: () => ({ ok: true }),                                          // 훅 스폰도 하지 않는다(c7ef48d)
  };
}

/** argv를 **새 임시 뿌리**에서 돌린다. 호출마다 그 자리에서 증거함 델타를 되돌아본다. */
function runAt(argv, { boxRoot = REPO, baseline } = {}) {
  const logs = [], errs = [];
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "readme-cmd-")));   // 저장소 루트가 아니다 — 절대로
  CWDS.push(cwd);
  const code = cli.runCli(argv.slice(2), cliOpts(cwd, logs, errs));
  expectBoxUnchanged(boxRoot, baselineFor(boxRoot, baseline), `after \`${argv.slice(2).join(" ")}\``);
  return { code, out: logs.join("\n"), err: errs.join("\n"), cwd };
}

/**
 * **README에 대한 판정 본체.** 값은 README 텍스트와 출하된 CLI만의 함수다 — `boxRoot`는 판정이 도는
 * 동안 관측할 증거함이고, 판정값에는 들어가지 않는다. dw7은 정확히 그것을 확인한다: 상자를 바꿔도
 * `verdict`가 같아야 한다.
 */
function judgeReadme({ readme = README, boxRoot = REPO, baseline } = {}) {
  const before = baselineFor(boxRoot, baseline);
  const lines = [];
  for (const cmd of shownCommands(readme)) {
    const argv = argvOf(cmd);
    const r = runAt(argv, { boxRoot, baseline: before });
    const issue = valueOf(argv, "--issue");
    lines.push({
      cmd,
      node: argv[0],
      cli: argv[1],
      sub: argv[2],
      code: r.code,
      unknown_command: /unknown command/.test(r.err),
      module_missing: /Cannot find module/.test(r.err),
      usage_error: /usage: qa-evidence\.js/.test(r.err) || /is required|needs --/.test(r.err),
      flags: [...flagsOf(argv)].sort(),
      issue,
      payload: payloadOf(argv),
      // 양성 대조가 판정값 안에 있다: 이 줄이 매니페스트를 **실제로** 만들었는가, 그리고 그것이
      // 저장소가 아니라 임시 뿌리 아래에 떨어졌는가. 이것이 없으면 "증거함이 안 바뀌었다"는
      // "아무 일도 일어나지 않는 명령을 돌렸다"와 구별되지 않는다.
      wrote_manifest_in_its_own_root: existsSync(join(r.cwd, ".factory/out/qa", String(issue), "manifest.json")),
    });
  }
  return {
    verdict: { subs: [...new Set(lines.map((l) => l.sub))].sort(), lines },
    box: { before, after: qaSnapshot(boxRoot) },
  };
}

// 이 파일의 마지막 테스트 *뒤*도 창이다 — teardown까지 같은 약속을 지킨다.
afterAll(() => expectBoxUnchanged(REPO, QA_AT_IMPORT, "after this file's last test"));

// ── dw1 ──────────────────────────────────────────────────────────────────────────────────────

test("test_18_status_line_names_1_3_0", () => {
  const phase2 = section(README, /Phase 2 .* factory/);
  expect(phase2, "README.md has no `### Phase 2 — factory` section").not.toBeNull();

  const status = phase2.split("\n").find((l) => /^\*\*Status\*\*:/.test(l.trim()));
  expect(status, "the Phase 2 factory section has no `**Status**:` line").toBeTruthy();

  expect(status).toMatch(/\b1\.3\.0\b/);
  expect(status).toMatch(/KTB #3[^\n]*PR #4/);
  expect(status).toMatch(/own-calendar[^\n]*#3[^\n]*PR #5/);
  expect(status).toMatch(/2026-09-14/);

  // 알파 문장은 사라져야 한다 — 낡은 사실이 남아 있으면 새 사실은 정정이 아니라 모순이다.
  expect(status).not.toMatch(/1\.0\.0-alpha/);
  expect(README).not.toMatch(/1\.0\.0-alpha/);
  expect(README).not.toMatch(/first dark completion 2026-09-12/);
});

// ── dw2 ──────────────────────────────────────────────────────────────────────────────────────

test("test_18_readme_documents_qa_evidence_contract", () => {
  const qa = section(README, /qa evidence/i);
  expect(qa, "README.md has no `qa evidence` subsection").not.toBeNull();

  for (const s of SUBCOMMANDS) expect(qa, `qa evidence subsection never names \`${s}\``).toMatch(new RegExp(`\`${s}\``));

  // 프로브가 깨졌을 때: 빌더 reject가 아니라 blocked/undecidable이다.
  expect(qa).toMatch(/`?factory:blocked`?/);
  expect(qa).toMatch(/undecidable/);
  expect(qa).toMatch(/not a (builder )?reject/i);

  // 거절 규칙 셋 — `factory/lib/qa-evidence.js`의 세 사유와 `checkAttachSource`의 두 거절.
  expect(qa, "rule 1 (all-na manifest) is not stated").toMatch(/every[^\n]{0,20}done_when[^\n]{0,24}not_applicable/);
  expect(qa, "rule 2 (unresolvable done_when) is not stated").toMatch(/done_when[^\n]{0,40}(could not be resolved|unresolvable)/);
  expect(qa, "rule 3 (attach source) is not stated").toMatch(/--file[^\n]{0,80}outside the repo/);
  expect(qa, "rule 3 never names the Read(...) deny").toMatch(/`?Read\(/);
});

// ── dw3 ──────────────────────────────────────────────────────────────────────────────────────

test("test_18_readme_qa_commands_are_real", () => {
  // 어댑터가 복사한 경로가 실제로 거기 있다 — 이것이 "127이 아니다"의 전부다.
  expect(existsSync(join(REPO, CLI_REL)), `${CLI_REL} is not in the repository`).toBe(true);

  const { verdict, box } = judgeReadme();

  /**
   * dw3의 앞 절반은 **보여 주는 줄이 있다**에서 시작한다(plan dissent s2): 아래 단언들은 README가
   * 명령을 하나도 보여 주지 않으면 빈 집합 위의 참이 되고, s1 때문에 "아무것도 보여 주지 않기"가
   * 가장 싼 통과법이 된다. 그래서 그 바닥을 여기서 먼저 세운다 — base의 README는 이 줄에서 멈춘다.
   */
  expect(verdict.lines.length, "README shows no `node .factory/bin/qa-evidence.js` line at all — dw3 would be vacuous")
    .toBeGreaterThanOrEqual(SUBCOMMANDS.length);
  expect(verdict.subs, "README does not show one runnable line per subcommand").toEqual([...SUBCOMMANDS].sort());

  for (const l of verdict.lines) {
    expect(l.node, l.cmd).toBe("node");
    expect(l.cli, l.cmd).toBe(CLI_REL);
    expect(l.unknown_command, `README shows a subcommand the CLI does not have: ${l.cmd}`).toBe(false);
    expect(l.module_missing, `${l.cmd} could not be loaded`).toBe(false);
    expect(l.code, `${l.cmd} exited 127 — the adopter's copy found no such file`).not.toBe(127);
    // 이슈 본문이 요구한 나머지 절반: **usage error도 아니어야 한다**. CLI는 하위 명령을 모르거나
    // `--issue`가 없거나 필수 플래그가 빠졌을 때 `USAGE` 전문을 찍는다 — 곧 README의 줄이 그 도구의
    // 인자 계약을 만족한다는 뜻이고, 그것이 "복붙해서 쓸 수 있다"의 실행 쪽 절반이다.
    expect(l.usage_error, `README's line is a usage error, not a command: ${l.cmd}`).toBe(false);

    // 그리고 **완결된** 줄이다: 그 하위 명령의 필수 플래그가 다 있고, `--issue`는 숫자다.
    for (const f of REQUIRED_FLAGS[l.sub]) {
      expect(l.flags, `the README's \`${l.sub}\` line is not copy-pasteable — no --${f}`).toContain(f);
    }
    expect(l.issue, `the README's \`${l.sub}\` line has a non-numeric --issue: ${l.issue}`).toMatch(/^\d+$/);
  }

  // `record`만의 최소선 — `--` 뒤에 실제로 돌릴 명령이 있어야 그 줄이 증거를 만든다.
  const rec = verdict.lines.find((l) => l.sub === "record");
  expect(rec.payload.length, "the README's `record` line has nothing after `--` — it cannot record anything").toBeGreaterThan(0);
  expect(rec.code, `the README's record line did not run: ${rec.cmd}`).toBe(0);
  expect(rec.wrote_manifest_in_its_own_root, "the record line wrote no manifest anywhere — evidence-safety would be vacuous").toBe(true);

  // dw3의 뒤 절반 — 이것을 증명하는 값이 이 저장소에 0이다. 창은 모듈 로드부터 여기까지이고,
  // 판정은 델타다(dw7): 상자에 이미 있던 매니페스트는 그대로, 새로 생긴 것은 없다.
  expect(box.after, ".factory/out/qa was written to while proving the README's commands").toEqual(box.before);
  expectBoxUnchanged(REPO, QA_AT_IMPORT, "at the end of dw3");

  // 그 쓰기는 단 한 번도 이 저장소를 뿌리로 삼지 않았다 — 값으로 센다.
  expect(CWDS.length, "no command was run at all").toBeGreaterThan(0);
  for (const c of CWDS) {
    expect(c.startsWith(realpathSync(tmpdir())), `a shown command ran outside the temp dir: ${c}`).toBe(true);
    expect(c.startsWith(realpathSync(REPO)), `a shown command ran inside the repository: ${c}`).toBe(false);
  }

  // 두 방향의 통제 — 위 단언들이 무엇이든 통과시키는 것이 아님을 같은 자리에서 보인다.
  const unknown = runAt(["node", CLI_REL, "reword", "--issue", "1"]);
  expect(unknown.err).toMatch(/unknown command/);
  expect(unknown.code).toBe(1);

  const halfWritten = runAt(["node", CLI_REL, "record", "--issue", "1", "--", "true"]);
  expect(halfWritten.err).toMatch(/usage: qa-evidence\.js/);
  expect(halfWritten.err).toMatch(/needs --claim/);
  expect(halfWritten.code).toBe(1);
});

// ── dw4 ──────────────────────────────────────────────────────────────────────────────────────

test("test_18_readme_documents_human_merge_flow", () => {
  const hm = section(README, /When a person merges/i);
  expect(hm, "README.md has no `When a person merges` subsection").not.toBeNull();

  expect(hm, "the merge stage's refusal is not described").toMatch(/refus/i);
  expect(hm).toMatch(/`?factory:needs-human`?/);
  expect(hm).toMatch(/`?factory:merged`?/);
  expect(hm, "the sweeper is not named").toMatch(/sweeper/i);
  expect(hm, "the one-sweep bound is not stated").toMatch(/(one sweep|one sweeper|≤ ?30|30 min)/i);
  expect(hm, "the review handoff / head sha check is not described").toMatch(/review handoff/i);
  expect(hm).toMatch(/head sha|head/);
  expect(hm, "the review quorum and K are not named").toMatch(/quorum/i);
  expect(hm).toMatch(/limits\.K|\bK\b/);
  expect(hm, "the factory-posted statuses / required checks are not named").toMatch(/required check/i);

  // KTB-48 — 다시 계산하지 않는 검사 둘.
  expect(hm).toMatch(/records[^\n]{0,30}provenance/i);
  expect(hm).toMatch(/qa[^\n]{0,20}(digest|manifest)/i);
  expect(hm).toMatch(/KTB-48/);

  // KTB-47 — `:unstick` 재시도가 지금은 아무것도 사지 않는다.
  expect(hm).toMatch(/:unstick/);
  expect(hm).toMatch(/KTB-47/);

  expect(hm).toMatch(/KTB-46/);
});

// ── dw5 ──────────────────────────────────────────────────────────────────────────────────────

/**
 * 드리프트 탐지기. **문장 하나가 아니라 주장 하나**를 찾는다: "사람이 머지한 PR도 자동 머지와 *똑같은*
 * 증거 검사를 지난다"(ADR-024/025 이후 거짓 — KTB-48이 다시 계산하지 *않는* 검사 둘을 남겨 두었다)와
 * "쓰기 경로는 하나 / 길은 하나"(같은 이유로 거짓).
 *
 * 반대로 **ADR-020의 "implement는 유일한 쓰기 *스테이지*"는 맞는 말이고 남아야 한다**(plan dissent d2:
 * 이슈가 적어 준 문자열 grep을 그대로 돌리면 옳은 결정 기록 넷이 지워진다). 그래서 탐지기는 `스테이지`를
 * 명시적으로 살려 둔다 — 아래 통제 두 개가 이 구분이 실제로 작동하는지 매번 다시 확인한다.
 */
const DRIFT = [
  /똑같은 증거 검사/,
  /똑같이 물렸/,
  /유일한 쓰기 (?!스테이지)/,
  /유일한 길/,
  /the same evidence check(s)? as (an? )?auto[-\s]?merge/i,
  /(only|single) write path/i,
];
const driftHits = (text) => DRIFT.filter((re) => re.test(text)).map((re) => String(re));

/**
 * 어댑터가 읽는 마크다운 **전부**. 예외는 없다 — 특히 보호 경로를 걸러내지 않는다(verifier의 v1):
 * "이 문장이 남아 있어도 되는 파일"을 목록으로 들고 있으면 그 파일이 정정된 날에도 초록이고, 정정이
 * 되돌려진 날에도 초록이다. 집합은 `git ls-files`에서 온다 — 곧 이 저장소가 **실제로 배포하는** 문서다.
 * 그래서 러너가 매 스테이지 덧붙이고 `.gitignore:11`이 무시하는 `docs/factory/runs/**`(스테이지 산문을
 * 그대로 인용하므로 스스로 이 정규식을 물 수 있다)와 `node_modules`는 자동으로 빠진다.
 */
function adopterDocs() {
  const tracked = execFileSync("git", ["-C", REPO, "ls-files", "-z", "--", "README.md", "docs", "templates"], { encoding: "utf8" });
  return tracked.split("\0").filter((f) => f.endsWith(".md")).sort();
}

test("test_18_no_contradicting_wording_left", () => {
  // ① 어댑터가 읽는 자리에 **정정문이 있다**. 절의 구조는 dw4가 맡는다 — 여기서 찾는 것은 *주장*이다:
  //    이 저장소의 README가 "사람이 머지한 PR의 문(門)은 검사 둘을 다시 계산하지 않는다"고 말하는가.
  //    base의 README는 그 주장을 하지 않는다(그리고 dw5가 금지하는 반대 주장도 하지 않는다) — 이 PR이
  //    새로 쓰는 산문이 정확히 그 주장이 들어오는 자리이고, 그래서 이 단언에는 이 PR이 깨뜨릴 것이 있다.
  expect(README, "README.md does not state that the human-merge door leaves two checks un-re-derived")
    .toMatch(/not re-derive/i);
  expect(README, "the un-re-derived checks are not pinned to the plan task that closes them").toMatch(/KTB-48/);
  expect(driftHits(README), "README.md itself carries the wording ADR-024/025 contradicts").toEqual([]);

  // ② 이 저장소가 배포하는 어떤 문서도 그 주장을 담지 않는다 — 면제 목록 없이, 보호 경로도 포함해서.
  const docs = adopterDocs();
  expect(docs.length, "no tracked adopter markdown was found — the scan would be vacuous").toBeGreaterThan(10);
  expect(docs, "README.md is not in the scanned set").toContain("README.md");
  expect(docs, "the CHARTER — the file that carried this drift — is not in the scanned set").toContain("docs/factory/CHARTER.md");

  const carriers = docs
    .map((f) => [f, driftHits(readFileSync(join(REPO, f), "utf8"))])
    .filter(([, hits]) => hits.length);
  expect(carriers, `adopter docs still claim what ADR-024/025 denies: ${JSON.stringify(carriers)}`).toEqual([]);

  // ③ 그리고 **옳은 문장은 살아 있다** — ADR-020의 "유일한 쓰기 스테이지" 넷(dissent d2). 지우는 diff는 여기서 걸린다.
  const decisions = readFileSync(join(REPO, "docs/factory/DECISIONS.md"), "utf8");
  const design = readFileSync(join(REPO, "docs/superpowers/specs/2026-09-10-factory-design.md"), "utf8");
  expect((decisions.match(/유일한 쓰기 스테이지/g) || []).length).toBeGreaterThanOrEqual(3);
  expect(design).toMatch(/유일한 쓰기 스테이지/);

  // ④ 통제 — 탐지기가 정말로 무는가, 그리고 옳은 문장을 물지 않는가. ②의 빈 집합이 "정규식이 아무것도
  //    맞히지 못한다"의 다른 이름이 아님을 같은 자리에서 보인다.
  expect(driftHits("그 전이도 자동 머지와 똑같은 증거 검사를 지나므로, 리뷰를 거치지 않은 PR을")).not.toEqual([]);
  expect(driftHits("the transition passes the same evidence check as an auto merge")).not.toEqual([]);
  expect(driftHits("증거를 남기는 유일한 쓰기 경로다")).not.toEqual([]);
  expect(driftHits("implement는 유일한 쓰기 스테이지이고 이 체크는 애초에 실행되지 않는다")).toEqual([]);
  expect(driftHits("자동 머지와 같은 함수로 다시 묻는다 — 다만 다시 계산하지 않는 검사가 둘 있다")).toEqual([]);
});

// ── dw7 ──────────────────────────────────────────────────────────────────────────────────────

/** qa 리뷰어의 정본 줄 그대로 — `record --issue 18 --claim <id> --summary … -- <repro cmd>`. */
function recordClaimAt(root, claim) {
  const logs = [], errs = [];
  const code = cli.runCli(
    ["record", "--issue", "18", "--claim", claim, "--summary", `dw${claim} reproduced`,
      "--", "npx", "vitest", "run", "factory/test/readme-commands.test.js"],
    cliOpts(root, logs, errs),
  );
  return { code, out: logs.join("\n"), err: errs.join("\n") };
}

const manifest18 = (root) => join(root, ".factory/out/qa/18/manifest.json");
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/**
 * dw7 — **이 가드는 상자 안에 이미 있는 증거에 무관심하다.**
 *
 * 이 이슈의 qa 라운드는 claim마다 `record --issue 18 … -- <이 파일을 돌리는 명령>`을 친다. 두 번째
 * claim부터 이 스위트는 `.factory/out/qa/18/manifest.json`이 **있는 상태로**, 그리고 그 파일이 그
 * 자리에 남아 있어야 하는 상태로 실행된다. 그래서 두 가지를 확인한다:
 *   ① 판정값이 상자의 내용의 함수가 아니다 — 씨를 뿌린 상자와 빈 상자에서 같은 verdict가 나온다.
 *   ② 그 매니페스트는 바이트 단위로 그대로다. 그리고 그 뒤에 claim을 더 남기는 것도 여전히 exit 0이다.
 */
test("test_18_guard_indifferent_to_existing_qa_evidence", () => {
  const seeded = realpathSync(mkdtempSync(join(tmpdir(), "readme-seeded-")));
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "readme-empty-")));

  // 씨: 정본 경로로 claim 하나. README가 보여 주는 이슈 번호(42)로도 하나 — 그 번호의 매니페스트가
  // 이미 있는 상태가 이 가드에게 가장 위험한 상태다(보여 주는 줄들이 바로 그 번호를 쓴다).
  expect(recordClaimAt(seeded, "1").code, "the canonical record line did not run at the seeded root").toBe(0);
  expect(existsSync(manifest18(seeded)), "seeding did not produce a manifest — dw7 would be vacuous").toBe(true);
  const seededOther = join(seeded, ".factory/out/qa/42/manifest.json");
  const other = cli.runCli(["na", "--issue", "42", "--claim", "dw9", "--reason", "no UI surface"], cliOpts(seeded, [], []));
  expect(other, "seeding issue 42 failed").toBe(0);
  expect(existsSync(seededOther)).toBe(true);

  const before18 = sha256(manifest18(seeded));
  const claimsBefore = JSON.parse(readFileSync(manifest18(seeded), "utf8")).claims;
  expect(claimsBefore.length, "the seeded manifest carries no claims").toBeGreaterThan(0);

  // ① 같은 판정. 상자가 채워져 있든 아예 없든.
  const withEvidence = judgeReadme({ boxRoot: seeded });
  const withoutEvidence = judgeReadme({ boxRoot: empty });
  expect(withEvidence.verdict, "the guard's verdict about the README changed with the contents of .factory/out/qa")
    .toEqual(withoutEvidence.verdict);
  // 그리고 그 판정은 공허하지 않다 — base의 README에는 이 다섯 줄이 없으므로 여기서 빨갛다.
  expect(withEvidence.verdict.subs).toEqual([...SUBCOMMANDS].sort());

  // ② 상자는 양쪽 다 그대로. 채워진 쪽은 **같은 바이트**로, 빈 쪽은 여전히 비어 있는 채로.
  expect(withEvidence.box.after).toEqual(withEvidence.box.before);
  expect(withoutEvidence.box.before.exists, "the empty root was not empty").toBe(false);
  expect(withoutEvidence.box.after).toEqual(withoutEvidence.box.before);
  expect(sha256(manifest18(seeded)), "the pre-existing manifest for issue 18 was rewritten").toBe(before18);
  expect(JSON.parse(readFileSync(manifest18(seeded), "utf8")).claims, "the pre-existing claims changed").toEqual(claimsBefore);

  // ③ 그리고 그 상자는 **살아 있다**: 다음 claim을 남기는 것도 여전히 exit 0이고, 앞의 claim은 남는다.
  expect(recordClaimAt(seeded, "3").code, "recording claim 2..n after the guard ran no longer works").toBe(0);
  const after = JSON.parse(readFileSync(manifest18(seeded), "utf8"));
  expect(after.claims.map((c) => c.id)).toEqual([...claimsBefore.map((c) => c.id), "3"]);

  // ④ 통제 — 관측기가 정말로 무는가. 상자에 한 바이트를 쓰면 같은 단언이 실패해야 한다. 이것이 없으면
  //    ②의 "달라지지 않았다"는 "아무것도 보고 있지 않다"와 구별되지 않는다.
  const control = realpathSync(mkdtempSync(join(tmpdir(), "readme-control-")));
  expect(cli.runCli(["na", "--issue", "7", "--claim", "c1", "--reason", "control"], cliOpts(control, [], []))).toBe(0);
  const base = qaSnapshot(control);
  writeFileSync(join(control, ".factory/out/qa/7/manifest.json"), "{}\n");
  expect(() => expectBoxUnchanged(control, base, "in the control")).toThrow();
  expect(() => expectBoxUnchanged(control, qaSnapshot(control), "in the control")).not.toThrow();

  // ⑤ 이 저장소의 증거함은 이 테스트가 도는 동안에도 한 바이트도 달라지지 않았다.
  expectBoxUnchanged(REPO, QA_AT_IMPORT, "at the end of dw7");
  for (const c of CWDS) expect(c.startsWith(realpathSync(REPO)), `a command ran inside the repository: ${c}`).toBe(false);
});
