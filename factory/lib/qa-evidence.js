import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ── ADR-024 / KTB-42 — **qa 증거는 디렉터리가 아니라 계약이다.** ───────────────────────────────
 *
 * KTB #3은 implement를 8라운드 태웠다. 매 라운드 `reviewer-spec-conformance`가 같은 문장으로 거부했다:
 * `spec1: qa evidence missing`. 그런데 그 문장이 가리키는 것은 빌더의 결함이 아니었다 — qa 리뷰어가
 * `.factory/out/qa/`에 **한 글자도 쓸 수 없었다**(KTB-36/37/40: deny 목록, PR head의 설정, Claude Code의
 * 관대한 매처). 빌더는 자기가 만들지 않은 결함을 여덟 번 고치려 했고, 사람은 그 여덟 라운드가 끝난 뒤에야
 * 원인을 봤다. 권한은 KTB-40에서 고쳤지만, 고장의 나머지 절반은 그대로 남아 있었다:
 *
 *   ① 증거의 **모양**이 산문이었다. `[evidence].qa_artifacts = ".factory/out/qa/**"` 한 줄과 프롬프트의
 *      문단 몇 개. "무엇이 있으면 충분한가"에 대해 두 리뷰어가 서로 다른 답을 들고 있었다.
 *   ② 증거를 남기는 **경로**가 즉흥적이었다(`printf … > …/x.log`). 그래서 권한이 막히면 그 사실이
 *      "리뷰어의 판단"으로 둔갑했다 — 도구가 없으면 실패는 언제나 판정처럼 보인다.
 *   ③ 아무도 **미리** 확인하지 않았다. 쓸 수 있는지는 리뷰가 끝난 뒤에야 드러났다.
 *
 * 이 파일이 ①의 답이다: 증거는 `manifest.json` 하나로 선언되고, `done_when` id 단위로 채워지며,
 * 성숙도가 최소선을 정한다. ②는 `bin/qa-evidence.js`(모든 쓰기가 그 도구를 지난다), ③은 review
 * 스테이지의 `probe`(오버레이 직후, `claude -p` 이전)가 맡는다.
 *
 * **매니페스트는 커밋되지 않는다**(`.factory/out/`는 gitignore다). 그래서 머지 스테이지는 파일을 볼 수
 * 없고, 대신 review 런이 run 기록에 남긴 `qa_manifest=<sha256>` 한 줄을 본다 — 러너가 쓰고 에이전트는
 * 쓸 수 없는 자리다(`lib/run-record.js`).
 */

/** 매니페스트의 스키마 이름. 모양이 바뀌면 `v2`이고, 옛 파일은 그 이름으로 거부된다. */
export const QA_SCHEMA = "factory.qa-evidence.v1";
/** 도구 버전 — 어떤 도구가 쓴 매니페스트인지 사후 조사에서 읽는 값. */
export const TOOL_VERSION = "1";

/**
 * claim의 종류. 다섯뿐인 이유: 각각이 **다른 질문**에 답한다.
 *  - `command` — 실행했다(명령과 종료 코드가 함께 남는다). 재현의 최소 단위.
 *  - `log`     — 관측했다(서버·브라우저 로그 발췌).
 *  - `state`   — 데이터가 실제로 그렇게 됐다(DB 덤프, API 응답). M1의 추가 최소선.
 *  - `screenshot` — 사용자가 그 화면을 봤다. M2의 추가 최소선.
 *  - `not_applicable` — 이 done_when은 이번 이슈에서 재현할 수 없다. **사유가 필수다** —
 *    사유 없는 면제는 면제가 아니라 공백이다.
 */
export const KINDS = Object.freeze(["command", "screenshot", "log", "state", "not_applicable"]);
/** `done_when`에 없지만 언제나 정당한 claim id — 하네스의 스모크를 돌린 증거. */
export const SMOKE_CLAIM = "smoke";
/** 성숙도 사다리. 모르는 값은 M0로 읽는다(없는 규칙을 발명하지 않는다). */
export const MATURITIES = Object.freeze(["M0", "M1", "M2", "M3"]);

/** M0 최소선을 실제로 만족시키는 종류 — "실행했다/관측했다". 스크린샷 하나는 재현이 아니다. */
const RUN_KINDS = new Set(["command", "log"]);

export const qaDirRel = (issue) => `.factory/out/qa/${issue}`;
export const qaDir = (root, issue) => join(root, ".factory", "out", "qa", String(issue));
export const manifestPath = (root, issue) => join(qaDir(root, issue), "manifest.json");

export const maturityRank = (m) => {
  const i = MATURITIES.indexOf(String(m ?? "").trim());
  return i < 0 ? 0 : i;
};

/**
 * 이 `done_when`은 사용자가 **보는** 것인가. plan handoff는 `level`(unit|integration|e2e)을 싣고,
 * 일부 프로젝트는 `ui: true`를 명시한다. 둘 중 하나면 UI-facing이다 — M2에서 스크린샷을 요구하는
 * 대상이 바로 이 집합이고, 그 밖(파서·마이그레이션 같은 unit 레벨)에 스크린샷을 요구하면 리뷰어는
 * 찍을 수 없는 것을 찍으려다 `not_applicable`을 남발하게 된다.
 */
export const isUiFacing = (w) => w?.ui === true || String(w?.level ?? "").toLowerCase() === "e2e";

/**
 * 이 이슈가 **데이터를 건드리는가** — M1의 state claim 최소선이 걸리는 조건. triage handoff의
 * `impact_paths`를 본다. 알려진 조잡한 필터다(이 열거에 없는 이름으로 데이터를 두는 프로젝트는
 * 놓친다). 기울기는 일부러 한쪽이다 — **놓치면 요구하지 않는다**: 없는 규칙을 발명해 리뷰어에게
 * 뜰 수 없는 증거를 요구하는 쪽이 더 나쁜 고장이다(KTB #3이 정확히 그 모양이었다).
 */
export const DATA_PATH_RE = /(^|\/)(migrations?|schema|schemas|models?|entities|prisma|db|database|sql|repositor(y|ies)|store)(\/|$)|\.sql$|\.prisma$/i;
export const touchesDataPaths = (paths) => (Array.isArray(paths) ? paths : []).some((p) => DATA_PATH_RE.test(String(p ?? "")));

export function newManifest({ issue, headSha = null, maturity = null, now = new Date().toISOString(), toolVersion = TOOL_VERSION } = {}) {
  return {
    schema: QA_SCHEMA,
    issue: Number(issue),
    head_sha: headSha,
    maturity: maturity,
    claims: [],
    created_at: now,
    tool_version: toolVersion,
  };
}

/**
 * `file`은 **이슈 디렉터리 기준 상대 경로**여야 한다. 절대 경로도, `..`가 섞인 경로도 거부한다 —
 * 증거를 가리키는 포인터가 디렉터리 밖을 가리킬 수 있으면 "증거가 있다"는 주장은 어디로든 갈 수 있다
 * (훅의 qa 카브아웃이 `..`에서 통째로 꺼지는 것과 같은 규칙이다).
 */
export function fileInsideIssueDir(file) {
  const f = String(file ?? "");
  if (!f) return false;
  if (f.startsWith("/") || /^[A-Za-z]:[\\/]/.test(f)) return false;
  return !f.split(/[\\/]/).includes("..");
}

const str = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * 매니페스트 하나를 계약으로 검사한다. 순수 함수다 — 파일 존재 여부는 `fileExists(relPath)`로 주입한다
 * (그래야 스테이지·도구·테스트가 같은 판정을 쓴다).
 *
 * @returns {{ok: boolean, missing: string[], extras: string[], reasons: string[]}}
 *   `missing` — 최소선을 채우지 못한 `done_when` id들. 거부 문구가 "디렉터리가 비었다"가 아니라
 *   **id를 부르도록** 하는 것이 이 필드의 존재 이유다(KTB #3에서 사람이 여덟 라운드를 태운 지점).
 */
export function validateManifest(manifest, { doneWhen = [], maturity = "M0", touchesData = false, fileExists = () => true } = {}) {
  const reasons = [];
  const missing = [];
  const extras = [];
  if (!manifest || typeof manifest !== "object") {
    return { ok: false, missing: (Array.isArray(doneWhen) ? doneWhen : []).map((w) => String(w?.id ?? "")).filter(Boolean), extras, reasons: ["manifest is not an object"] };
  }
  if (manifest.schema !== QA_SCHEMA) reasons.push(`schema must be ${QA_SCHEMA}, got ${JSON.stringify(manifest.schema)}`);
  if (!Number.isInteger(manifest.issue)) reasons.push("issue must be an integer");
  if (manifest.head_sha != null && !/^[0-9a-f]{40}$/.test(String(manifest.head_sha))) reasons.push("head_sha must be a 40-hex sha");
  const claims = Array.isArray(manifest.claims) ? manifest.claims : [];
  if (!Array.isArray(manifest.claims)) reasons.push("claims must be an array");

  claims.forEach((c, i) => {
    const at = `claims[${i}]`;
    if (!str(c?.id)) { reasons.push(`${at}.id must be a non-empty string`); return; }
    if (!KINDS.includes(c.kind)) { reasons.push(`${at} (${c.id}) kind must be one of ${KINDS.join("|")}, got ${JSON.stringify(c?.kind)}`); return; }
    if (!str(c.summary) && c.kind !== "not_applicable") reasons.push(`${at} (${c.id}) summary must be a non-empty string`);
    if (c.kind === "not_applicable") {
      if (!str(c.reason)) reasons.push(`${at} (${c.id}) not_applicable needs a reason — an exemption without one is a gap, not an exemption`);
      return;
    }
    if (!str(c.file)) { reasons.push(`${at} (${c.id}) file must be a non-empty string`); return; }
    if (!fileInsideIssueDir(c.file)) { reasons.push(`${at} (${c.id}) file is outside the issue dir: ${c.file}`); return; }
    if (!fileExists(c.file)) reasons.push(`${at} (${c.id}) file does not exist: ${c.file}`);
    if (c.kind === "command") {
      if (!str(c.cmd)) reasons.push(`${at} (${c.id}) command claim needs the cmd it ran`);
      if (!Number.isInteger(c.exit)) reasons.push(`${at} (${c.id}) command claim needs an integer exit code`);
    }
  });

  const ws = (Array.isArray(doneWhen) ? doneWhen : []).filter((w) => str(w?.id));
  const ids = new Set(ws.map((w) => String(w.id)));
  for (const c of claims) {
    if (!str(c?.id)) continue;
    if (c.id !== SMOKE_CLAIM && !ids.has(String(c.id)) && !extras.includes(String(c.id))) extras.push(String(c.id));
  }

  const rank = maturityRank(maturity);
  const by = (id) => claims.filter((c) => String(c?.id) === id);
  const exempt = (cs) => cs.some((c) => c.kind === "not_applicable" && str(c.reason));
  for (const w of ws) {
    const id = String(w.id);
    const cs = by(id);
    if (exempt(cs)) continue;
    if (!cs.some((c) => RUN_KINDS.has(c.kind))) {
      missing.push(id);
      reasons.push(`done_when ${id} has no command|log claim (and no not_applicable with a reason)`);
      continue;
    }
    // M2 — 사용자가 보는 done_when은 **본 것**이 증거다.
    if (rank >= 2 && isUiFacing(w) && !cs.some((c) => c.kind === "screenshot")) {
      missing.push(id);
      reasons.push(`done_when ${id} is UI-facing and this project is ${maturity} — it needs a screenshot claim`);
    }
  }
  // M1 — 데이터를 건드리는 이슈는 "화면이 그랬다"로 끝나지 않는다. 상태를 한 번은 떠서 보여야 한다.
  if (rank >= 1 && touchesData && !claims.some((c) => c?.kind === "state")) {
    reasons.push(`this issue's impact paths touch data and the project is ${maturity} — it needs at least one state claim (a DB/API state dump)`);
  }

  return { ok: reasons.length === 0, missing, extras, reasons };
}

/** 키 순서에 독립적인 정규형 — 같은 내용이 두 자리에서 같은 문자열이 되도록. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * 매니페스트의 지문. review 런이 run 기록에 남기고(`qa_manifest=<digest>`), 머지 스테이지가 그 한 줄로
 * "이 커밋에 대해 유효한 증거가 실제로 있었다"를 읽는다 — 매니페스트 파일 자신은 커밋되지 않으므로
 * 머지가 볼 수 있는 것은 이 문자열뿐이다.
 */
export const manifestDigest = (manifest) => createHash("sha256").update(canonical(manifest)).digest("hex");

/** `finish`가 찍고 spec-conformance가 읽는 표. 사람이 한 눈에 **어느 id가 비었는지** 보게 만든다. */
export function coverageTable(manifest, { doneWhen = [], maturity = "M0", touchesData = false, fileExists = () => true } = {}) {
  const v = validateManifest(manifest, { doneWhen, maturity, touchesData, fileExists });
  const claims = Array.isArray(manifest?.claims) ? manifest.claims : [];
  const rows = [];
  const ws = (Array.isArray(doneWhen) ? doneWhen : []).filter((w) => str(w?.id));
  const seen = new Set();
  const row = (id, note) => {
    const cs = claims.filter((c) => String(c?.id) === id);
    const kinds = [...new Set(cs.map((c) => c.kind))].join("+") || "—";
    rows.push([id, kinds, String(cs.filter((c) => c.file).length), v.missing.includes(id) ? "MISSING" : note].join("\t"));
  };
  for (const w of ws) { seen.add(String(w.id)); row(String(w.id), "ok"); }
  for (const c of claims) {
    const id = String(c?.id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    row(id, id === SMOKE_CLAIM ? "smoke" : "extra");
  }
  const head = `claim\tkinds\tfiles\tstatus   (maturity ${maturity}${touchesData ? ", impact paths touch data" : ""})`;
  const tail = v.ok ? "coverage: complete" : `coverage: INCOMPLETE — ${v.reasons.join("; ")}`;
  return [head, ...rows, tail].join("\n");
}

/** 디스크의 매니페스트. 없거나 깨졌으면 **사유**를 돌려준다 — throw하지 않는다(판정 불능은 통과가 아니다). */
export function readManifest(root, issue, { readFile = (p) => readFileSync(p, "utf8"), exists = existsSync } = {}) {
  const p = manifestPath(root, issue);
  if (!exists(p)) return { ok: false, reason: `no qa evidence manifest at ${qaDirRel(issue)}/manifest.json` };
  let text;
  try { text = readFile(p); } catch (e) { return { ok: false, reason: `qa evidence manifest unreadable: ${e?.message || e}` }; }
  try { return { ok: true, manifest: JSON.parse(text) }; }
  catch (e) { return { ok: false, reason: `qa evidence manifest is not valid JSON: ${e?.message || e}` }; }
}

/**
 * 스테이지가 묻는 한 가지: **이 커밋에 대한 유효한 증거가 있는가.** 있으면 지문까지 돌려준다.
 * `headSha`가 주어지면 매니페스트가 말하는 커밋과 대조한다 — 지난 라운드의 증거는 이번 트리의 얘기가
 * 아니다(게이트 파일의 `head_sha` 바인딩과 같은 규칙).
 */
export function evidenceFor({ root, issue, doneWhen = [], maturity = "M0", touchesData = false, headSha = null, exists = existsSync }) {
  const r = readManifest(root, issue, { exists });
  if (!r.ok) return { ok: false, reason: r.reason };
  const m = r.manifest;
  const v = validateManifest(m, {
    doneWhen, maturity, touchesData,
    fileExists: (rel) => exists(join(qaDir(root, issue), rel)),
  });
  const digest = manifestDigest(m);
  if (!v.ok) {
    const named = v.missing.length ? `missing claims for ${v.missing.join(", ")}` : v.reasons[0];
    return { ok: false, digest, head_sha: m?.head_sha ?? null, missing: v.missing, reason: `qa evidence manifest is incomplete — ${named}`, reasons: v.reasons };
  }
  if (headSha && m.head_sha && m.head_sha !== headSha) {
    return { ok: false, digest, head_sha: m.head_sha, missing: [], reason: `qa evidence manifest describes ${String(m.head_sha).slice(0, 7)}, this head is ${String(headSha).slice(0, 7)}` };
  }
  return { ok: true, digest, head_sha: m.head_sha ?? null, missing: [], claimIds: [...new Set(m.claims.map((c) => String(c.id)))] };
}

/**
 * ③ — **쓸 수 있는지는 리뷰 전에 묻는다.** `mkdir -p` + 파일 하나 쓰기 + 지우기. 그게 전부인 이유:
 * KTB #3에서 실제로 실패한 것이 정확히 그 세 동작이었다(`mkdir -p .factory/out/qa/`가 첫 거절이었다).
 * 남기는 것은 없다 — 프로브 파일은 지운다(쓰기 금지 스테이지의 클린 트리 검사가 바로 뒤에 있다).
 */
export function probeEvidenceDir({ root, issue = "probe", now = Date.now() } = {}) {
  const dir = qaDir(root, issue);
  const file = join(dir, `.probe-${now}`);
  try { mkdirSync(dir, { recursive: true }); }
  catch (e) { return { ok: false, dir, reason: `mkdir -p ${qaDirRel(issue)} failed: ${e?.message || e}` }; }
  try { writeFileSync(file, "factory qa evidence probe\n"); }
  catch (e) { return { ok: false, dir, reason: `writing into ${qaDirRel(issue)} failed: ${e?.message || e}` }; }
  try { unlinkSync(file); }
  catch (e) { return { ok: false, dir, reason: `the probe file in ${qaDirRel(issue)} could not be removed: ${e?.message || e}` }; }
  return { ok: true, dir };
}

/**
 * qa 판정이 **실제로 부른** 매니페스트 claim id들. 인용 규약은 `claim:<id>`지만 매칭은 단어 경계로
 * 관대하게 한다 — 리뷰어가 `dw2-1.log:18`처럼 파일명으로 인용해도 그 안의 id를 읽는다. 관대한 쪽이
 * 맞는 이유: 이 규칙이 잡으려는 것은 "증거를 만들고 인용하지 않은 판정"이 아니라 **"증거 없이 쓴
 * 판정"**이다.
 */
export function citedClaimIds(verdict, claimIds = []) {
  const hay = [
    ...(Array.isArray(verdict?.must_fix) ? verdict.must_fix.map((m) => `${m?.evidence ?? ""} ${m?.claim ?? ""} ${m?.where ?? ""}`) : []),
    ...(Array.isArray(verdict?.should_fix) ? verdict.should_fix.map((s) => (typeof s === "string" ? s : JSON.stringify(s))) : []),
    ...(Array.isArray(verdict?.verified) ? verdict.verified.map((s) => (typeof s === "string" ? s : JSON.stringify(s))) : []),
  ].join("\n");
  const out = [];
  for (const id of claimIds) {
    const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^A-Za-z0-9_])${esc}([^A-Za-z0-9_]|$)`).test(hay)) out.push(String(id));
  }
  return out;
}
