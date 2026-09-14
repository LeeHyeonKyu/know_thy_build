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
 * 이 도구가 그 길이다. `record`/`attach`/`na`가 유일한 쓰기 경로이고, 셋 다 같은 일을 한다:
 * ① 디렉터리를 확보하고(못 하면 **exit 2**로 즉시, 정확한 문구와 함께 죽는다 — 조용한 실패 금지),
 * ② 파일을 이슈 디렉터리 안에 두고(시크릿은 그 전에 지운다), ③ `manifest.json`에 claim을 덧붙인다.
 * `finish`는 그 매니페스트를 계약(`lib/qa-evidence.js`)으로 검사해 **커버리지 표**를 찍고,
 * `probe`는 리뷰가 시작되기 전에 러너가 부르는 같은 확인이다.
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
  const ctx = readJson(join(root, ".factory/out/context.json"));
  const qaCtx = readJson(join(root, ".factory/out/context.qa.json"));
  let doneWhen = ctx?.handoffs?.plan?.done_when ?? qaCtx?.done_when ?? null;
  const maturity = ctx?.harness?.maturity ?? qaCtx?.maturity ?? harnessMaturity(root) ?? "M0";
  const headSha = ctx?.handoffs?.implement?.head_sha ?? qaCtx?.head_sha ?? null;
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

/** 파일명에 그대로 쓸 수 있는 claim id — 도구가 만드는 경로에 리뷰어의 문자열이 그대로 들어가지 않게. */
export const safeClaim = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);

function ensureDir(root, issue, err) {
  const p = probeEvidenceDir({ root, issue });
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

function cmdRecord({ root, issue, flags, rest, env, log, err, now, spawn }) {
  const claim = flags.claim, summary = flags.summary;
  if (typeof claim !== "string" || typeof summary !== "string" || rest.length === 0) {
    err(USAGE); err("factory: record needs --claim, --summary and a command after `--`");
    return 1;
  }
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
    err(`factory: qa evidence incomplete — spec-evidence-missing: ${v.missing.join(", ") || "see reasons above"}`);
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
} = {}) {
  const { cmd, flags, rest } = parseArgs(argv);
  const root = typeof flags.root === "string" ? flags.root : cwd;
  const HANDLERS = { record: cmdRecord, attach: cmdAttach, na: cmdNa, finish: cmdFinish, probe: cmdProbe };
  const handler = HANDLERS[cmd];
  if (!handler) { err(USAGE); err(`factory: unknown command ${JSON.stringify(cmd ?? "")}`); return 1; }
  const issue = flags.issue;
  if (issue === undefined || issue === true || !/^\d+$/.test(String(issue))) {
    err(USAGE); err("factory: --issue <number> is required");
    return 1;
  }
  return handler({ root, issue: Number(issue), flags, rest, env, log, err, now, spawn });
}

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) process.exit(runCli());

export { DATA_PATH_RE, SMOKE_CLAIM, TOOL_VERSION, touchesDataPaths };
