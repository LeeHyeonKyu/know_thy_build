import { test, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { loadHarness } from "../lib/config.js";
import { matchesAny } from "../lib/glob.js";

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

/** 이 파일이 CLI에 넘긴 모든 cwd — dw6이 "한 번도 저장소 루트가 아니었다"를 관측 가능한 값으로 센다. */
const CWDS = [];

function runShown(argv) {
  const logs = [], errs = [];
  const cwd = mkdtempSync(join(tmpdir(), "readme-cmd-"));   // 저장소 루트가 아니다 — 절대로
  CWDS.push(cwd);
  const code = cli.runCli(argv.slice(2), {
    cwd,
    env: {},
    log: (...a) => logs.push(a.join(" ")),
    err: (...a) => errs.push(a.join(" ")),
    now: () => "2026-09-14T00:00:00Z",
    spawn: () => ({ status: 0, stdout: "", stderr: "", signal: null }),   // 페이로드를 실제로 띄우지 않는다
    gate: () => ({ ok: true }),                                          // 훅 스폰도 하지 않는다(c7ef48d)
  });
  // 스냅샷 비교를 마지막 테스트 한 번에만 맡기지 않는다(리뷰 지적 #4): **호출마다** 즉시 되돌아본다.
  // 그래야 "이 파일이 도는 동안" 전체가 창(window)이 되고, 어느 호출이 범인인지도 그 자리에서 드러난다.
  expectEvidenceBoxUntouched(`after \`${argv.slice(2).join(" ")}\``);
  return { code, out: logs.join("\n"), err: errs.join("\n"), cwd };
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

/**
 * 리뷰 지적 #4에 대한 보강 두 가지.
 *
 * ① **창이 더 넓다.** 기준선을 `beforeAll`이 아니라 **모듈 로드 시점**에도 한 번 뜬다 — 이 워커에서
 *    이 파일이 관측할 수 있는 가장 이른 순간이다. 그리고 판정은 스냅샷 *비교*만이 아니라 **부재**다:
 *    갓 체크아웃한 트리에 `.factory/out/qa/`는 아예 없고(`.gitignore:8`이 `.factory/out/`를 무시한다),
 *    `record`/`attach`/`na`가 한 번이라도 저장소 루트에서 돌면 그 디렉터리는 **남는다** — 아무도 다시
 *    지우지 않는다. 그래서 "지금 없다"는 이 워커의 수명만이 아니라 *그 전에 돈 어떤 파일도 거기 쓰지
 *    않았다*를 함께 말한다. 워커 경계를 넘는 순서 보장이 없어도 성립하는 유일한 형태다.
 * ② **공허하지 않다.** dw6은 같은 argv가 임시 뿌리에서는 매니페스트를 *실제로 만든다*는 것을 양성
 *    대조로 보인다 — 그러니 "저장소 쪽에는 아무것도 생기지 않았다"가 관측이 된다.
 */
const QA_BOX = join(REPO, ".factory/out/qa");
const QA_AT_IMPORT = qaSnapshot();

function expectEvidenceBoxUntouched(when) {
  const now = qaSnapshot();
  if (!QA_AT_IMPORT.exists) {
    expect(existsSync(QA_BOX), `.factory/out/qa was absent at import and exists ${when}`).toBe(false);
  }
  expect(now, `.factory/out/qa changed ${when}`).toEqual(QA_AT_IMPORT);
}

let qaBefore;
beforeAll(() => { qaBefore = qaSnapshot(); });

// 이 파일의 마지막 테스트 *뒤*도 창이다 — teardown까지 같은 약속을 지킨다.
afterAll(() => expectEvidenceBoxUntouched("after this file's last test"));

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

  /**
   * 리뷰 지적 #3 — **이 단언들이 돌 대상이 있다는 것을 이 테스트가 스스로 세운다.** 아래 루프는
   * README가 명령을 하나도 보여 주지 않으면 한 번도 돌지 않고, 그러면 "README가 보여 주는 모든 줄이
   * 진짜다"는 빈 집합 위의 참이 된다(plan dissent s2). 그 경우 이 테스트는 여기서 **빨개져야 한다** —
   * 형제 단언이 파일을 non-zero로 끌고 가 주기를 기다리지 않고. base의 README는 이 줄에서 멈춘다.
   */
  expect(shown.length, "README shows no `node .factory/bin/qa-evidence.js` line at all — dw3 would be vacuous").toBeGreaterThanOrEqual(SUBCOMMANDS.length);
  const subsShown = new Set(shown.map((c) => argvOf(c)[2]));
  expect([...subsShown].sort(), "README does not show one runnable line per subcommand").toEqual([...SUBCOMMANDS].sort());

  for (const cmd of shown) {
    const argv = argvOf(cmd);
    expect(argv[0], cmd).toBe("node");
    expect(argv[1], cmd).toBe(CLI_REL);

    const r = runShown(argv);
    expect(r.err, `README shows a subcommand the CLI does not have: ${cmd}`).not.toMatch(/unknown command/);
    expect(r.err, `${cmd} could not be loaded`).not.toMatch(/Cannot find module/);
    expect(r.code, cmd).not.toBe(127);
    // 이슈 본문이 요구한 나머지 절반: **usage error도 아니어야 한다**. CLI는 하위 명령을 모르거나
    // `--issue`가 없거나 필수 플래그가 빠졌을 때 `USAGE` 전문을 찍는다 — 곧 README의 줄이 그 도구의
    // 인자 계약을 만족한다는 뜻이고, 그것이 "복붙해서 쓸 수 있다"의 실행 쪽 절반이다.
    expect(r.err, `README's line is a usage error, not a command: ${cmd}\n${r.err}`).not.toMatch(/usage: qa-evidence\.js/);
    expect(r.err, cmd).not.toMatch(/is required|needs --/);
  }

  // 위 단언이 무엇이든 통과시키는 것이 아님을 같은 자리에서 보인다 — 두 방향의 통제.
  const control = runShown(["node", CLI_REL, "reword", "--issue", "1"]);
  expect(control.err).toMatch(/unknown command/);
  expect(control.code).toBe(1);

  // 통제 ② — usage 단언이 진짜로 무는가: 플래그가 빠진 줄은 정확히 그 usage error를 낸다.
  const halfWritten = runShown(["node", CLI_REL, "record", "--issue", "1", "--", "true"]);
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

/** 어댑터가 읽는 마크다운 전부. 생성물(node_modules)과 러너 기록(docs/factory/runs)은 문서가 아니다. */
function adopterDocs() {
  const out = ["README.md"];
  const walk = (rel) => {
    for (const e of readdirSync(join(REPO, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === "node_modules" || p === "docs/factory/runs") continue;
        walk(p);
      } else if (e.name.endsWith(".md")) out.push(p);
    }
  };
  walk("docs");
  walk("templates");
  return out;
}

test("test_18_no_contradicting_wording_left", () => {
  // ① 어댑터가 읽는 자리에 **정정문이 있다**. base의 README에는 이 문장이 없다 — 거기서 이 테스트는 빨갛다.
  const hm = section(README, /When a person merges/i);
  expect(hm, "README.md has no `When a person merges` subsection to carry the correction").not.toBeNull();
  expect(hm, "the README does not say that the human-merge door leaves two checks un-re-derived")
    .toMatch(/not re-derive/i);
  expect(driftHits(README), "README.md itself carries the wording ADR-024/025 contradicts").toEqual([]);

  // ② 공장이 쓸 수 있는 어떤 어댑터 문서도 그 주장을 담지 않는다. 아직 남은 인스턴스가 있다면 그것은
  //    반드시 **보호 경로**여야 한다 — 이 세션이 편집을 거부당하는 파일이고(`.factory/ci-settings.json`의
  //    `Edit(docs/factory/CHARTER.md)` deny), 그래서 `harness_needed`로 넘긴 파일이다. 보호 목록은
  //    harness.toml에서 읽는다: 하드코딩한 예외 목록이었다면 그 파일이 고쳐진 날 이 테스트가 깨지고,
  //    load-bearing 규칙 때문에 아무도 고칠 수 없게 된다. 이 형태는 고쳐져도(집합이 줄어도) 초록이고,
  //    쓸 수 있는 문서에 한 줄이라도 되살아나면 빨갛다.
  const prot = loadHarness(REPO).protected || {};
  const isProtected = (f) => matchesAny(prot.factory || [], f) && !matchesAny(prot.except || [], f);
  const carriers = adopterDocs()
    .map((f) => [f, driftHits(readFileSync(join(REPO, f), "utf8"))])
    .filter(([, hits]) => hits.length);
  const writable = carriers.filter(([f]) => !isProtected(f));
  expect(writable, `adopter docs the factory can write still claim what ADR-024/025 denies: ${JSON.stringify(writable)}`).toEqual([]);

  // ③ 그리고 **옳은 문장은 살아 있다** — ADR-020의 "유일한 쓰기 스테이지" 넷(d2). 지우는 diff는 여기서 걸린다.
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
  expect(driftHits("the sweeper re-asks with the same functions the auto-merge path uses")).toEqual([]);
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

  // ② 양성 대조 — 같은 argv는 **실제로 매니페스트를 만든다**. 이것이 없으면 아래 ③은 "아무 일도
  //    일어나지 않는 명령을 돌렸다"와 구별되지 않는다(리뷰 지적 #4의 공허성). 있으면 ③은 관측이 된다:
  //    쓰기는 분명히 일어났고, 그 쓰기가 저장소가 아니라 임시 뿌리에 떨어졌다.
  const rec = runShown(bySub.get("record"));
  expect(rec.code, `the README's record line did not run: ${rec.err}`).toBe(0);
  const wrote = join(rec.cwd, ".factory/out/qa", String(bySub.get("record")[bySub.get("record").indexOf("--issue") + 1]), "manifest.json");
  expect(existsSync(wrote), "the record line wrote no manifest anywhere — the evidence-safety claim would be vacuous").toBe(true);

  // ③ 그리고 그 쓰기는 단 한 번도 이 저장소를 뿌리로 삼지 않았다 — 값으로 센다.
  expect(CWDS.length, "no command was run at all").toBeGreaterThan(0);
  for (const c of CWDS) {
    expect(c.startsWith(tmpdir()), `a shown command ran outside the temp dir: ${c}`).toBe(true);
    expect(realpathSync(c).startsWith(realpathSync(REPO)), `a shown command ran inside the repository: ${c}`).toBe(false);
  }

  // ④ 이 저장소의 증거함은 한 바이트도 쓰이지 않았다 — 두 기준선(모듈 로드·beforeAll) 모두에 대해,
  //    그리고 README가 보여 주는 **모든** 이슈 번호에 대해 매니페스트가 새로 생기지 않았다.
  expectEvidenceBoxUntouched("at the end of the guard");
  expect(qaSnapshot()).toEqual(qaBefore);
  const issues = new Set([...bySub.values()].map((a) => a[a.indexOf("--issue") + 1]).concat(["18"]));
  for (const n of issues) {
    const rel = `${n}/manifest.json`;
    const had = QA_AT_IMPORT.entries.some(([e]) => e === rel);
    expect(existsSync(join(QA_BOX, rel)), `.factory/out/qa/${rel} ${had ? "changed shape" : "was created by the guard"}`).toBe(had);
  }
});
