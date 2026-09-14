#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { latestHandoff } from "../lib/handoff.js";
import { isBinary, scrubText, SECRET_ENV } from "./scrub-artifacts.js";
import {
  DATA_PATH_RE, KINDS, QA_SCHEMA, SMOKE_CLAIM, TOOL_VERSION, coverageTable, evidenceFor, manifestPath,
  newManifest, probeEvidenceDir, qaDir, qaDirRel, readManifest, touchesDataPaths, validateManifest,
} from "../lib/qa-evidence.js";

/**
 * ── ADR-024 / KTB-42 — **증거를 남기는 길은 하나다.** ──────────────────────────────────────────
 *
 * KTB #3의 8라운드는 "qa가 증거를 못 남겼다"가 "빌더가 뭔가 빠뜨렸다"로 읽힌 사고였다. 원인의 절반은
 * 권한(KTB-36/37/40)이었지만 나머지 절반은 **경로**였다: 증거는 `printf … > …/x.log` 같은 즉흥
 * 리다이렉션으로 남았고, 그래서 실패가 조용했다. 리다이렉션이 거절되면 남는 것은 아무것도 없고,
 * 리뷰어는 "증거를 못 남겼다"를 자기 판정 문장 안에 적을 방법조차 없었다.
 *
 * 이 도구가 그 길이다. `record`/`attach`/`na`가 증거를 남기는 **정본 경로**이고, 셋 다 같은 일을 한다:
 * ① 디렉터리를 확보하고(못 하면 **exit 2**로 즉시, 정확한 문구와 함께 죽는다 — 조용한 실패 금지),
 * ② 파일을 이슈 디렉터리 안에 두고(시크릿은 그 전에 지운다), ③ `manifest.json`에 claim을 덧붙인다.
 * `finish`는 그 매니페스트를 계약(`lib/qa-evidence.js`)으로 검사해 **커버리지 표**를 찍고,
 * `probe`는 리뷰가 시작되기 전에 러너가 부르는 같은 확인이다.
 *
 * **"유일한"이 아니라 "정본"인 이유**(리뷰 라운드 1 SF-1): qa 역할은 `.factory/out/qa/` 아래에 쓸 수
 * 있고, 그 권한으로 `manifest.json`을 손으로 지어낼 수도 있다. ci-settings의 deny와 `deny-all-writes.sh`가
 * 그 **직접 쓰기 철자**(Write/Edit 도구, 리다이렉션, tee, cp)를 막지만 그것은 진위 경계가 아니라 비용이다 —
 * 이 도구를 거친 claim도 결국 qa가 적은 문장이다. 계약이 주는 것은 위조 불가가 아니라 **형태와 가시성**이고,
 * 판정의 신뢰는 여전히 로스터가 준다(자세한 재진술은 `../lib/qa-evidence.js` 머리말).
 *
 * 의존성은 Node 내장뿐이다(같은 디렉터리의 `scrub-artifacts.js`와 `../lib/`만 쓴다) — `factory init`이
 * 이 파일을 `.factory/bin/`으로 그대로 복사하고, 거기엔 npm 설치가 없을 수 있다.
 *
 * 종료 코드: 0 성공 · 1 사용법/검증 실패 · 2 **증거 디렉터리에 쓸 수 없음**(판정 불가).
 * 2를 따로 두는 이유: 그 실패만이 "리뷰의 판정"이 아니라 **인프라**이고, run-stage가 그것을
 * `factory:blocked`(cause `undecidable`)로 올린다.
 */

export const USAGE = [
  "usage: qa-evidence.js <command> --issue N [options]",
  "  record --issue N --claim <id> --summary <text> [--timeout ms] -- <cmd…>",
  "  attach --issue N --claim <id> --kind screenshot|log|state|command --file <path> --summary <text>",
  "  na     --issue N --claim <id> --reason <text>",
  "  finish --issue N",
  "  probe  --issue N",
].join("\n");

/** 명령 하나의 기본 상한. 증거 수집이 리뷰 스테이지의 예산을 통째로 먹지 않게. */
export const DEFAULT_TIMEOUT_MS = 300000;

/**
 * ── 리뷰 라운드 1 MF-1 — **`record -- <cmd>`는 훅을 우회하는 실행 표면이었다.** ─────────────────
 *
 * `ci-settings`의 allow는 접두 매치라(`Bash(node .factory/bin/qa-evidence.js *)`) `--` 뒤의 무엇이든
 * 통과하고, `deny-all-writes.sh`의 규칙은 **명령 위치**에 앵커돼 있다(`CMD` 클래스에 공백이 없다) —
 * 곧 `… record … -- rm -rf src`는 그 훅에 **보이지 않는다**(리뷰어가 실측: 직접 `rm -rf src`는 exit 2,
 * 도구로 감싸면 exit 0). 쓰기 금지 역할에게 그 훅은 **유일한** 셸 경계이므로 그것은 경계가 뚫린 것이다.
 *
 * 자유 형식 페이로드 자체는 남긴다 — qa의 일은 즉흥적인 재현이고, 실행할 수 있는 명령을 설정 파일에
 * 미리 다 적어 둘 수 있다는 가정이 틀렸다는 것이 이 역할의 존재 이유다. 대신 **직접 Bash 호출과 같은
 * 판정을 받게** 한다: 스폰 전에 안쪽 명령줄을 재구성해 두 훅에 그대로 먹이고, 어느 하나라도 exit 2면
 * 거절한다(exit 1, 훅의 문구를 그대로 인용한다).
 *
 * 그리고 **인터프리터는 페이로드가 될 수 없다**. `sh -c '<무엇이든>'`은 훅이 볼 수 없는 두 번째 셸을
 * 여는 것이고(따옴표 안은 토큰이 아니라 문자열이다), 그 안에서 무엇을 하든 위의 재구성 검사는
 * `sh -c …` 한 줄만 본다. 실행할 프로그램이 인터프리터면 그 자체로 거절한다 — 증거 수집에 필요한 것은
 * 테스트 러너·CLI이지 셸이 아니고, 파이프라인이 필요하면 그것을 `.factory/scenarios/`의 스크립트로
 * 만들어 파일로 실행하면 된다.
 */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "csh", "tcsh", "fish", "eval", "exec", "source"]);
/** 프로그램 이름 → 그 이름이 **인라인 스크립트 모드**로 도는 플래그. 그 플래그가 있을 때만 인터프리터다. */
const INLINE_FLAGS = [
  { re: /^node[0-9.]*$/, flags: /^(-[a-zA-Z]*[ep][a-zA-Z]*|--eval|--print)/ },
  { re: /^python[0-9.]*$/, flags: /^(-[a-zA-Z]*c|--command)/ },
  { re: /^(perl|ruby)[0-9.]*$/, flags: /^-[a-zA-Z]*e/ },
];
const baseName = (p) => String(p ?? "").split(/[\\/]/).pop();

/**
 * 페이로드의 프로그램이 인터프리터인가. `env VAR=1 sh -c …`처럼 `env`로 감싼 것도 같은 대접을 받는다
 * (그 래퍼가 정확히 이 검사를 우회하려고 존재하는 모양이다). 아니면 null.
 */
export function interpreterPayload(argv = []) {
  let i = 0;
  while (i < argv.length && baseName(argv[i]) === "env") {
    i++;
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(argv[i]))) i++;   // env VAR=VAL …
    while (i < argv.length && /^-/.test(String(argv[i]))) i++;                          // env -i, env -u X
  }
  const prog = baseName(argv[i]);
  if (!prog) return null;
  if (SHELLS.has(prog)) return `${prog} — a shell payload opens a second command line the hooks cannot read`;
  for (const { re, flags } of INLINE_FLAGS) {
    if (!re.test(prog)) continue;
    if (argv.slice(i + 1).some((a) => flags.test(String(a)))) return `${prog} with an inline-script flag — the hooks cannot read the script body`;
  }
  return null;
}

/**
 * 이 도구 옆의 훅 스크립트를 찾는다. 두 레이아웃이다 — 설치본(`.factory/bin/` → `../../.claude/hooks/`)과
 * 이 패키지 자신(`factory/bin/` → `../hooks/`). **도구 자신의 위치에서** 푸는 이유는 KTB-37과 같다:
 * 작업 트리의 경로로 풀면 PR이 심어 둔 훅을 그 PR의 리뷰가 쓰게 된다.
 */
export function hookPaths(here = new URL(".", import.meta.url).pathname) {
  const names = ["deny-all-writes.sh", "block-dangerous.sh"];
  const roots = [join(here, "..", "hooks"), join(here, "..", "..", ".claude", "hooks")];
  for (const dir of roots) {
    const found = names.map((n) => join(dir, n));
    if (found.every((p) => existsSync(p))) return found;
  }
  return null;
}

/**
 * 페이로드가 **직접 Bash로 쳤을 때와 같은 판정**을 받는가. 훅을 찾지 못하면: 스테이지 안
 * (`FACTORY_STAGE`)에서는 **거절**한다(확인되지 않은 강제는 강제가 아니다), 스테이지 밖(사람의 노트북)
 * 에서는 통과시킨다 — 거기서 이 도구는 경계가 아니라 편의이고, 사람의 셸에는 이미 같은 권한이 있다.
 */
export function gatePayload(argv, { env = process.env, spawn = spawnSync, hooks = hookPaths() } = {}) {
  const interp = interpreterPayload(argv);
  if (interp) return { ok: false, reason: `factory: qa-evidence will not run an interpreter payload (${interp}). Run the test runner or CLI directly, or put the pipeline in a script file and run that.` };
  if (!hooks) {
    return env.FACTORY_STAGE
      ? { ok: false, reason: "factory: qa-evidence cannot find the hook scripts next to itself — refusing to run a payload no boundary has judged (run `npx know-thy-build factory init --upgrade`)" }
      : { ok: true, unchecked: true };
  }
  // 훅이 보는 것과 **같은 모양**으로 만든다: 따옴표를 씌우지 않는다. 인자 안의 `;`·`>`가 그대로
  // 남아야 훅이 그것을 구분자로 읽고 더 엄하게 판정한다(관용은 이 방향으로 기울면 안 된다).
  const line = argv.join(" ");
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: line } });
  for (const hook of hooks) {
    const r = spawn("bash", [hook], { input, encoding: "utf8", env });
    if (r?.status === 2) {
      return { ok: false, reason: `factory: qa-evidence refused the payload — ${baseName(hook)} says: ${String(r.stderr || r.stdout).trim().split("\n").pop()}` };
    }
    if (r?.status !== 0) {
      return { ok: false, reason: `factory: ${baseName(hook)} could not judge the payload (exit ${r?.status ?? "none"}) — refusing (an unjudged payload is not an allowed payload)` };
    }
  }
  return { ok: true };
}

/** `--k v` 플래그와 `--` 뒤의 원문 명령을 가른다. 값이 없는 플래그는 `true`다. */
export function parseArgs(argv = []) {
  const [cmd, ...rest] = argv;
  const flags = {};
  const tail = [];
  let afterDashDash = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (afterDashDash) { tail.push(a); continue; }
    if (a === "--") { afterDashDash = true; continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next === "--" || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
      continue;
    }
    tail.push(a);
  }
  return { cmd, flags, rest: tail, hadDashDash: afterDashDash };
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

/**
 * `done_when`·성숙도·head sha를 **스테이지가 이미 써 둔 자리**에서 읽는다. 순서가 곧 신뢰 순서다:
 * 전체 컨텍스트 → qa 역할 컨텍스트(cold read라 done_when만 실린다) → `gh`로 plan handoff.
 * 마지막 수단으로만 네트워크를 친다 — 리뷰 세션 안에서 도는 도구이고, 그 세션의 `gh`는 느리다.
 */
export function stageContext(root, issue, { spawn = spawnSync, allowGh = true } = {}) {
  // 리뷰 nit 4 — **역할 컨텍스트를 먼저 읽는다.** `context.json`은 전체 문맥이고, 리뷰 워크플로는
  // cold-read 역할에게 그 파일을 열지 말라고 명시한다(`factory-review.js`). 이 도구가 거기서 꺼내는
  // 것은 `done_when` id·성숙도·커밋뿐이라 지금은 유출이 없지만, 순서를 뒤집어 두면 나중에 `finish`가
  // 더 많이 찍게 될 때 그 금지가 조용히 깨진다. qa의 파일이 있으면 그것이 정본이다.
  const qaCtx = readJson(join(root, ".factory/out/context.qa.json"));
  const ctx = readJson(join(root, ".factory/out/context.json"));
  let doneWhen = qaCtx?.done_when ?? ctx?.handoffs?.plan?.done_when ?? null;
  const maturity = qaCtx?.maturity ?? ctx?.harness?.maturity ?? harnessMaturity(root) ?? "M0";
  const headSha = qaCtx?.head_sha ?? ctx?.handoffs?.implement?.head_sha ?? null;
  const impact = ctx?.handoffs?.triage?.impact_paths ?? [];
  if (!Array.isArray(doneWhen) && allowGh) {
    const r = spawn("gh", ["issue", "view", String(issue), "--json", "comments"], { cwd: root, encoding: "utf8" });
    if (r?.status === 0) {
      let comments = [];
      try { comments = JSON.parse(r.stdout)?.comments ?? []; } catch { comments = []; }
      doneWhen = latestHandoff(comments, "plan")?.data?.done_when ?? null;
    }
  }
  return { doneWhen: Array.isArray(doneWhen) ? doneWhen : [], maturity, headSha, touchesData: touchesDataPaths(impact) };
}

/**
 * `harness.toml`의 성숙도. TOML 파서를 끌어오지 않는 이유는 하나다 — 이 파일은 `.factory/bin/`에서
 * npm 설치 없이 돌아야 한다. 못 읽으면 null이고, 호출자가 M0로 읽는다(모르면 최소선만 요구한다).
 */
export function harnessMaturity(root, { readFile = (p) => readFileSync(p, "utf8") } = {}) {
  try {
    const t = readFile(join(root, ".factory/harness.toml"));
    return /^\s*maturity\s*=\s*["'](M\d)["']/m.exec(t)?.[1] ?? null;
  } catch { return null; }
}

/**
 * 파일명에 그대로 쓸 수 있는 claim id — 도구가 만드는 경로에 리뷰어의 문자열이 그대로 들어가지 않게.
 * 리뷰 nit 2: 치환은 **충돌한다**(`a b`와 `a_b`가 같은 파일명이 되는데 `nextIndex`는 id별로 센다 →
 * 두 claim이 한 파일을 가리키고 뒤엣것이 앞엣것을 덮는다). 그래서 치환한 결과가 원본과 다르면
 * 파일명을 지어내는 대신 **거절한다** — `done_when` id는 애초에 이 문자 집합 안에 있다.
 */
export const safeClaim = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
export const claimIdOk = (id) => typeof id === "string" && id.length > 0 && safeClaim(id) === id;
const CLAIM_ID_REFUSAL = "factory: --claim must be a done_when id made of [A-Za-z0-9._-] (≤64 chars) — the id is also the evidence file name, and a rewritten id would collide with another claim's files";

function ensureDir(root, issue, err) {
  // `keep: true` — 이 디렉터리는 바로 다음 줄에서 쓰인다(진단이 아니라 준비다).
  const p = probeEvidenceDir({ root, issue, keep: true });
  if (p.ok) return true;
  err(`factory: qa evidence dir not writable: ${p.reason} (dir: ${qaDirRel(issue)})`);
  return false;
}

/**
 * 매니페스트를 읽고, 없거나 **다른 커밋의 것**이면 새로 연다. 후자가 중요하다: rework 뒤의 라운드는
 * 새 트리를 판정하는 라운드이고, 지난 커밋의 claim이 그대로 남으면 "이 커밋의 증거"라는 주장이
 * 조용히 거짓이 된다(게이트 파일의 head_sha 바인딩과 같은 규칙).
 */
export function loadOrOpenManifest(root, issue, { headSha, maturity, now }) {
  const r = readManifest(root, issue);
  const fresh = newManifest({ issue: Number(issue), headSha, maturity, now });
  if (!r.ok || r.manifest?.schema !== QA_SCHEMA) return fresh;
  const m = r.manifest;
  if (headSha && m.head_sha && m.head_sha !== headSha) return fresh;
  if (headSha && !m.head_sha) m.head_sha = headSha;
  if (maturity && !m.maturity) m.maturity = maturity;
  if (!Array.isArray(m.claims)) m.claims = [];
  return m;
}

function saveManifest(root, issue, m) {
  mkdirSync(qaDir(root, issue), { recursive: true });
  writeFileSync(manifestPath(root, issue), JSON.stringify(m, null, 2) + "\n");
}

/** 같은 claim id 아래 이미 몇 개의 **파일**이 있는가 → 다음 번호. 덮어쓰지 않는다. */
const nextIndex = (m, claim) => m.claims.filter((c) => String(c.id) === String(claim) && c.file).length + 1;

const secretsFrom = (env) => SECRET_ENV.map((n) => env[n]).filter((v) => typeof v === "string" && v.length > 0);

// ── 하위 명령 ────────────────────────────────────────────────────────────────────────────────

function cmdRecord({ root, issue, flags, rest, env, log, err, now, spawn, gate }) {
  const claim = flags.claim, summary = flags.summary;
  if (typeof claim !== "string" || typeof summary !== "string" || rest.length === 0) {
    err(USAGE); err("factory: record needs --claim, --summary and a command after `--`");
    return 1;
  }
  if (!claimIdOk(claim)) { err(CLAIM_ID_REFUSAL); return 1; }
  // MF-1 — 스폰보다 **먼저**: 이 페이로드가 직접 Bash로 쳤을 때와 같은 판정을 받는가(§gatePayload).
  const judged = gate(rest, { env, spawn });
  if (!judged.ok) { err(judged.reason); return 1; }
  if (!ensureDir(root, issue, err)) return 2;
  const timeout = Number(flags.timeout) > 0 ? Number(flags.timeout) : DEFAULT_TIMEOUT_MS;
  const r = spawn(rest[0], rest.slice(1), { cwd: root, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  // spawn이 아예 실패한 것(ENOENT)도 증거다 — "그 명령이 이 환경에 없다"는 발견이므로 기록하고 계속한다.
  const exit = Number.isInteger(r?.status) ? r.status : r?.signal ? 124 : 127;
  const cmdText = [rest[0], ...rest.slice(1)].join(" ");
  const at = now();
  const body = [
    `# factory qa-evidence · issue ${issue} · claim ${claim}`,
    `# cmd: ${cmdText}`,
    `# exit: ${exit}`,
    `# at: ${at}`,
    ...(r?.error ? [`# spawn error: ${r.error.message}`] : []),
    "--- stdout ---",
    String(r?.stdout ?? ""),
    "--- stderr ---",
    String(r?.stderr ?? ""),
    "",
  ].join("\n");
  const m = loadOrOpenManifest(root, issue, { ...stageStamp(root, issue, spawn), now: at });
  const file = `${safeClaim(claim)}-${nextIndex(m, claim)}.log`;
  writeFileSync(join(qaDir(root, issue), file), scrubText(body, { secrets: secretsFrom(env) }).text);
  m.claims.push({ id: String(claim), kind: "command", file, cmd: cmdText, exit, summary });
  saveManifest(root, issue, m);
  log(`factory: qa evidence recorded — ${qaDirRel(issue)}/${file} (claim ${claim}, exit ${exit})`);
  return 0;
}

function cmdAttach({ root, issue, flags, env, log, err, now, spawn }) {
  const { claim, kind, file: src, summary } = flags;
  if (typeof claim !== "string" || typeof src !== "string" || typeof summary !== "string") {
    err(USAGE); err("factory: attach needs --claim, --file and --summary");
    return 1;
  }
  if (!claimIdOk(claim)) { err(CLAIM_ID_REFUSAL); return 1; }
  const k = typeof kind === "string" ? kind : "log";
  if (!KINDS.includes(k) || k === "not_applicable") {
    err(`factory: --kind must be one of ${KINDS.filter((x) => x !== "not_applicable").join("|")} (use \`na\` for not_applicable)`);
    return 1;
  }
  if (!ensureDir(root, issue, err)) return 2;
  let buf;
  try { buf = readFileSync(src); } catch (e) { err(`factory: --file cannot be read: ${src} (${e?.message || e})`); return 1; }
  const at = now();
  const m = loadOrOpenManifest(root, issue, { ...stageStamp(root, issue, spawn), now: at });
  const ext = extname(basename(src)) || ".bin";
  const file = `${safeClaim(claim)}-${nextIndex(m, claim)}${ext}`;
  const dest = join(qaDir(root, issue), file);
  // 바이너리(스크린샷)는 한 바이트도 건드리지 않는다 — 텍스트로 다시 쓰면 증거가 깨진다.
  if (isBinary(buf)) copyFileSync(src, dest);
  else writeFileSync(dest, scrubText(buf.toString("utf8"), { secrets: secretsFrom(env) }).text);
  m.claims.push({ id: String(claim), kind: k, file, summary });
  saveManifest(root, issue, m);
  log(`factory: qa evidence attached — ${qaDirRel(issue)}/${file} (claim ${claim}, ${k})`);
  return 0;
}

function cmdNa({ root, issue, flags, log, err, now, spawn }) {
  const { claim, reason } = flags;
  if (typeof claim !== "string" || typeof reason !== "string" || !reason.trim()) {
    err(USAGE); err("factory: na needs --claim and a non-empty --reason — an exemption without a reason is a gap, not an exemption");
    return 1;
  }
  if (!claimIdOk(claim)) { err(CLAIM_ID_REFUSAL); return 1; }
  if (!ensureDir(root, issue, err)) return 2;
  const at = now();
  const m = loadOrOpenManifest(root, issue, { ...stageStamp(root, issue, spawn), now: at });
  m.claims.push({ id: String(claim), kind: "not_applicable", summary: typeof flags.summary === "string" ? flags.summary : reason, reason });
  saveManifest(root, issue, m);
  log(`factory: qa evidence — claim ${claim} marked not_applicable (${reason})`);
  return 0;
}

function cmdFinish({ root, issue, log, err, spawn }) {
  const sc = stageContext(root, issue, { spawn });
  const r = readManifest(root, issue);
  if (!r.ok) { err(`factory: ${r.reason} — record at least one claim before finishing (\`qa-evidence.js record …\`)`); return 1; }
  const table = coverageTable(r.manifest, {
    doneWhen: sc.doneWhen, maturity: sc.maturity, touchesData: sc.touchesData,
    fileExists: (rel) => existsSync(join(qaDir(root, issue), rel)),
  });
  log(table);
  const v = validateManifest(r.manifest, {
    doneWhen: sc.doneWhen, maturity: sc.maturity, touchesData: sc.touchesData,
    fileExists: (rel) => existsSync(join(qaDir(root, issue), rel)),
  });
  if (!v.ok) {
    // 비어 있는 자리는 **id로** 부른다. 그런데 id를 하나도 댈 수 없는 실패도 있다(계약 자체를 읽지
    // 못한 경우 — `done_when` 미해결, 전부 `not_applicable`): 그때는 사유를 그대로 싣는다.
    // "see reasons above"는 사람에게 아무것도 말해 주지 않는다.
    err(v.missing.length
      ? `factory: qa evidence incomplete — spec-evidence-missing: ${v.missing.join(", ")}`
      : `factory: qa evidence not acceptable — ${v.reasons.join("; ")}`);
    return 1;
  }
  const ev = evidenceFor({ root, issue, doneWhen: sc.doneWhen, maturity: sc.maturity, touchesData: sc.touchesData });
  log(`factory: qa evidence complete — manifest ${ev.digest?.slice(0, 12)} for ${String(r.manifest.head_sha ?? "unknown").slice(0, 7)}`);
  return 0;
}

function cmdProbe({ root, issue, log, err }) {
  const p = probeEvidenceDir({ root, issue });
  if (!p.ok) { err(`factory: qa evidence dir not writable: ${p.reason} (dir: ${qaDirRel(issue)})`); return 2; }
  log(`factory: qa evidence dir writable — ${qaDirRel(issue)}`);
  return 0;
}

/**
 * record/attach/na가 매니페스트를 열 때 찍는 도장(커밋·성숙도). `finish`의 판정과 같은 출처를 쓰되
 * **`gh`는 부르지 않는다**(`allowGh: false`): 도장에 필요한 것은 `done_when`이 아니라 커밋과 성숙도뿐이고,
 * 그 둘은 언제나 로컬 파일에 있다. 여기서 네트워크를 치면 claim 하나 남길 때마다 `gh issue view`가
 * 한 번씩 도는데, 그것은 리뷰 세션 안에서 **매우** 비싸다(그리고 실패해도 도장은 찍혀야 한다).
 */
function stageStamp(root, issue, spawn) {
  const sc = stageContext(root, issue, { spawn, allowGh: false });
  return { headSha: sc.headSha, maturity: sc.maturity };
}

export function runCli(argv = process.argv.slice(2), {
  cwd = process.cwd(), env = process.env, log = console.log, err = console.error,
  now = () => new Date().toISOString(), spawn = spawnSync,
  // `gate`는 페이로드 판정기다(§gatePayload). 주입 가능한 이유는 **비용** 때문이다: 판정은 훅 스크립트
  // 두 개를 실제로 띄우므로, 그 판정 자체를 검사하지 않는 테스트까지 매번 그 값을 치를 이유는 없다.
  // 프로덕션 경로에는 주입점이 없다(CLI는 언제나 기본값으로 돈다).
  gate = gatePayload,
} = {}) {
  const { cmd, flags, rest } = parseArgs(argv);
  /**
   * 리뷰 라운드 1 MF-3 — **`--root`는 없다.** 있었을 때 그것은 훅이 볼 수 없는 탈출구였다:
   * `deny-all-writes.sh`는 쓰기 금지 역할을 `/tmp`·`$TMPDIR`·`.factory/out/qa/`에 가두는데,
   * `--root /elsewhere`는 두 훅을 그대로 통과하면서(명령줄에 쓰기 동사가 없다) 저장소 밖에
   * `<root>/.factory/out/qa/…`를 만들었다. 뿌리는 언제나 프로세스의 cwd다 — 테스트는
   * `runCli(argv, { cwd })`로 그 자리를 바꾼다(프로덕션 호출자는 아무도 이 플래그를 쓰지 않았다).
   */
  const root = cwd;
  const HANDLERS = { record: cmdRecord, attach: cmdAttach, na: cmdNa, finish: cmdFinish, probe: cmdProbe };
  const handler = HANDLERS[cmd];
  if (!handler) { err(USAGE); err(`factory: unknown command ${JSON.stringify(cmd ?? "")}`); return 1; }
  const issue = flags.issue;
  if (issue === undefined || issue === true || !/^\d+$/.test(String(issue))) {
    err(USAGE); err("factory: --issue <number> is required");
    return 1;
  }
  return handler({ root, issue: Number(issue), flags, rest, env, log, err, now, spawn, gate });
}

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) process.exit(runCli());

export { DATA_PATH_RE, SMOKE_CLAIM, TOOL_VERSION, touchesDataPaths };
