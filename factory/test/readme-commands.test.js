import { test, expect, beforeAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * #18 — README.md의 어댑터 문서가 1.3.0을 말하는가, 그리고 **README가 보여 주는 명령이 진짜인가**.
 *
 * 이 파일은 코드가 아니라 문서를 판정한다. 그래서 단언은 두 종류다:
 *   ① 산문 — 어댑터가 알아야 하는 사실(다섯 하위 명령, 거절 규칙 셋, 사람-머지 흐름)이 거기 있는가.
 *      산문이 *옳은지*는 어떤 단위 테스트도 말할 수 없다(plan의 open_risk 4). 있는지만 센다.
 *   ② 실행 — README가 보여 주는 `node .factory/bin/qa-evidence.js …` 줄을 **그대로 파싱해서**
 *      출하된 CLI에 먹인다. 없는 파일(127)도, `unknown command`도 아니어야 한다.
 *
 * ②를 증명하는 값은 0이어야 한다(plan s1/dw6): 이 저장소의 `.factory/out/qa/`는 qa 리뷰어의 증거함이고,
 * `runCli`는 `root = cwd`를 못으로 박아 두었다(`.factory/bin/qa-evidence.js` — `--root`는 일부러 없다).
 * 그래서 여기서는 **한 번도 저장소 루트를 cwd로 주지 않는다**. 매번 새 임시 디렉터리다. 마지막 테스트가
 * 그 약속을 관측 가능한 상태로 되돌려 확인한다(파일 목록 + 내용 해시가 파일 시작 시점과 같은가).
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
  .map((t) => (/^".*"$|^'.*'$/.test(t) || /^'.*'$/.test(t) ? t.slice(1, -1) : t));

/** `--` 앞의 플래그만 — 뒤는 record의 페이로드다. */
function flagsOf(argv) {
  const flags = new Set();
  for (const a of argv.slice(3)) {
    if (a === "--") break;
    if (a.startsWith("--")) flags.add(a.slice(2));
  }
  return flags;
}

// ── 출하된 CLI를 임시 cwd에서 돌린다 ─────────────────────────────────────────────────────────

let cli;
beforeAll(async () => { cli = await import(pathToFileURL(join(REPO, CLI_REL)).href); });

function runShown(argv) {
  const logs = [], errs = [];
  const code = cli.runCli(argv.slice(2), {
    cwd: mkdtempSync(join(tmpdir(), "readme-cmd-")),   // 저장소 루트가 아니다 — 절대로
    env: {},
    log: (...a) => logs.push(a.join(" ")),
    err: (...a) => errs.push(a.join(" ")),
    now: () => "2026-09-14T00:00:00Z",
    spawn: () => ({ status: 0, stdout: "", stderr: "", signal: null }),   // 페이로드를 실제로 띄우지 않는다
    gate: () => ({ ok: true }),                                          // 훅 스폰도 하지 않는다(c7ef48d)
  });
  return { code, out: logs.join("\n"), err: errs.join("\n") };
}

// ── 증거함 스냅샷 ────────────────────────────────────────────────────────────────────────────

function qaSnapshot() {
  const dir = join(REPO, ".factory/out/qa");
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

let qaBefore;
beforeAll(() => { qaBefore = qaSnapshot(); });

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

  const shown = shownCommands(README);
  for (const cmd of shown) {
    const argv = argvOf(cmd);
    expect(argv[0], cmd).toBe("node");
    expect(argv[1], cmd).toBe(CLI_REL);

    const r = runShown(argv);
    expect(r.err, `README shows a subcommand the CLI does not have: ${cmd}`).not.toMatch(/unknown command/);
    expect(r.err, `${cmd} could not be loaded`).not.toMatch(/Cannot find module/);
    expect(r.code, cmd).not.toBe(127);
  }

  // 위 단언이 무엇이든 통과시키는 것이 아님을 같은 자리에서 보인다 — 가짜 하위 명령은 실제로 거절된다.
  const control = runShown(["node", CLI_REL, "reword", "--issue", "1"]);
  expect(control.err).toMatch(/unknown command/);
  expect(control.code).toBe(1);
});

// ── dw4 ──────────────────────────────────────────────────────────────────────────────────────

test("test_18_readme_documents_human_merge_flow", () => {
  const hm = section(README, /When a person merges/i);
  expect(hm, "README.md has no `When a person merges` subsection").not.toBeNull();

  expect(hm, "the merge stage's refusal is not described").toMatch(/refus/i);
  expect(hm).toMatch(/`?factory:needs-human`?/);
  expect(hm).toMatch(/`?factory:merged`?/);
  expect(hm, "the sweeper is not named").toMatch(/sweeper/i);
  expect(hm, "the one-sweep bound is not stated").toMatch(/(one sweep|≤ ?30|30 min)/i);
  expect(hm, "the review handoff / head sha check is not described").toMatch(/review handoff/i);
  expect(hm).toMatch(/head sha|head/);
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

// ── dw6 (마지막이어야 한다 — 이 파일이 만든 부수효과를 되돌아본다) ────────────────────────────

test("test_18_readme_command_guard_is_non_vacuous_and_evidence_safe", () => {
  // ① 검사할 것이 실제로 있다: 다섯 하위 명령이 저마다 완결된 한 줄로 보여진다.
  const shown = shownCommands(README);
  const bySub = new Map();
  for (const cmd of shown) {
    const argv = argvOf(cmd);
    if (!bySub.has(argv[2])) bySub.set(argv[2], argv);
  }
  expect([...bySub.keys()].sort()).toEqual([...SUBCOMMANDS].sort());

  for (const [sub, argv] of bySub) {
    const flags = flagsOf(argv);
    for (const f of REQUIRED_FLAGS[sub]) {
      expect(flags.has(f), `the README's \`${sub}\` line is not copy-pasteable — no --${f}`).toBe(true);
    }
    // `--issue`는 숫자여야 한다(CLI가 `--issue <number>`를 요구한다).
    const n = argv[argv.indexOf("--issue") + 1];
    expect(n, `the README's \`${sub}\` line has a non-numeric --issue: ${n}`).toMatch(/^\d+$/);
  }
  // record만의 최소선 — `--` 뒤에 실제로 돌릴 명령이 있어야 증거가 된다.
  expect(bySub.get("record")).toContain("--");
  expect(bySub.get("record").indexOf("--")).toBeLessThan(bySub.get("record").length - 1);

  // ② 그것을 증명하는 데 이 저장소의 증거함은 한 바이트도 쓰이지 않았다.
  expect(qaSnapshot()).toEqual(qaBefore);
});
