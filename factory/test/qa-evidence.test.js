import { test, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  QA_SCHEMA, KINDS, SMOKE_CLAIM, qaDirRel, qaDir, manifestPath, newManifest,
  validateManifest, manifestDigest, coverageTable, readManifest, probeEvidenceDir,
  evidenceFor, isUiFacing, citedClaimIds, claimCounts, claimCountsLabel, ALL_NA_PREFIX,
} from "../lib/qa-evidence.js";
import { runCli, gatePayload, interpreterPayload, hookPaths, shellQuote, checkAttachSource, readDenyGlobs } from "../bin/qa-evidence.js";
import { verifyStage, qaEvidenceUnusable, QA_EVIDENCE_INCOMPLETE } from "../lib/verify-stage.js";
import { renderCiSettings } from "../cli/install.js";

const tmp = () => mkdtempSync(join(tmpdir(), "qa-evidence-"));

/** 매니페스트 하나를 손으로 짓는다 — 파일 존재는 `fileExists`로 주입하므로 디스크가 필요 없다. */
const manifest = (claims, over = {}) => ({
  schema: QA_SCHEMA, issue: 3, head_sha: "a".repeat(40), maturity: "M0",
  claims, created_at: "2026-09-14T00:00:00Z", tool_version: "1", ...over,
});
const dw = (...ids) => ids.map((id) => ({ id, text: `${id} text`, verify: "manual", level: "e2e" }));
const always = () => true;

// ── 1. 계약: 성숙도별 최소선 ──────────────────────────────────────────────────────────────────

test("validateManifest M0: every done_when id needs a command|log claim, or a not_applicable with a reason", () => {
  const good = manifest([
    { id: "dw1", kind: "command", file: "dw1-1.log", cmd: "npm test", exit: 0, summary: "suite green" },
    { id: "dw2", kind: "log", file: "dw2-1.log", summary: "server log excerpt" },
    { id: "dw3", kind: "not_applicable", summary: "no UI in this tier", reason: "this tier has no UI surface" },
  ]);
  expect(validateManifest(good, { doneWhen: dw("dw1", "dw2", "dw3"), maturity: "M0", fileExists: always }))
    .toEqual({ ok: true, missing: [], extras: [], reasons: [] });

  // 스크린샷 하나만으로는 M0도 통과하지 못한다 — 재현을 **실행**한 증거(command|log)가 최소선이다.
  const shotOnly = manifest([{ id: "dw1", kind: "screenshot", file: "dw1-1.png", summary: "the screen" }]);
  const r = validateManifest(shotOnly, { doneWhen: dw("dw1"), maturity: "M0", fileExists: always });
  expect(r.ok).toBe(false);
  expect(r.missing).toEqual(["dw1"]);
});

test("validateManifest: not_applicable without a reason does not cover anything", () => {
  const m = manifest([{ id: "dw1", kind: "not_applicable", summary: "skip" }]);
  const r = validateManifest(m, { doneWhen: dw("dw1"), maturity: "M0", fileExists: always });
  expect(r.ok).toBe(false);
  expect(r.missing).toEqual(["dw1"]);
  expect(r.reasons.join(" ")).toMatch(/not_applicable .* reason/);
});

test("validateManifest M1: an issue whose impact paths touch data needs at least one state claim", () => {
  const claims = [{ id: "dw1", kind: "command", file: "dw1-1.log", cmd: "npm test", exit: 0, summary: "ok" }];
  const opts = { doneWhen: dw("dw1"), maturity: "M1", fileExists: always };
  expect(validateManifest(manifest(claims, { maturity: "M1" }), { ...opts, touchesData: false }).ok).toBe(true);

  const r = validateManifest(manifest(claims, { maturity: "M1" }), { ...opts, touchesData: true });
  expect(r.ok).toBe(false);
  expect(r.reasons.join(" ")).toMatch(/state claim/);

  const withState = [...claims, { id: "dw1", kind: "state", file: "dw1-2.json", summary: "rows after export" }];
  expect(validateManifest(manifest(withState, { maturity: "M1" }), { ...opts, touchesData: true }).ok).toBe(true);
});

test("validateManifest M2: every UI-facing done_when needs a screenshot on top of the M0/M1 minimum", () => {
  const doneWhen = [
    { id: "dw1", text: "export downloads a csv", level: "e2e" },     // UI-facing (e2e)
    { id: "dw2", text: "the parser rejects NaN", level: "unit" },    // not UI-facing
  ];
  const claims = [
    { id: "dw1", kind: "command", file: "dw1-1.log", cmd: "npx playwright test", exit: 0, summary: "ran" },
    { id: "dw2", kind: "command", file: "dw2-1.log", cmd: "npm test", exit: 0, summary: "ran" },
  ];
  const opts = { doneWhen, maturity: "M2", fileExists: always };
  const r = validateManifest(manifest(claims, { maturity: "M2" }), opts);
  expect(r.ok).toBe(false);
  expect(r.missing).toEqual(["dw1"]);
  expect(r.reasons.join(" ")).toMatch(/screenshot/);

  const withShot = [...claims, { id: "dw1", kind: "screenshot", file: "dw1-2.png", summary: "the downloaded row" }];
  expect(validateManifest(manifest(withShot, { maturity: "M2" }), opts).ok).toBe(true);
});

test("isUiFacing: e2e level or an explicit ui flag; a unit-level done_when is not", () => {
  expect(isUiFacing({ level: "e2e" })).toBe(true);
  expect(isUiFacing({ ui: true, level: "unit" })).toBe(true);
  expect(isUiFacing({ level: "unit" })).toBe(false);
});

// ── 2. 계약: 파일은 이슈 디렉터리 안에 실재해야 한다 ────────────────────────────────────────────

test("validateManifest: a file outside the issue dir (absolute, or with ..) is invalid, and so is a missing one", () => {
  const opts = { doneWhen: dw("dw1"), maturity: "M0" };
  const outside = manifest([{ id: "dw1", kind: "log", file: "/tmp/evil.log", summary: "x" }]);
  expect(validateManifest(outside, { ...opts, fileExists: always }).ok).toBe(false);
  expect(validateManifest(outside, { ...opts, fileExists: always }).reasons.join(" ")).toMatch(/outside the issue dir/);

  const escape = manifest([{ id: "dw1", kind: "log", file: "../4/leak.log", summary: "x" }]);
  expect(validateManifest(escape, { ...opts, fileExists: always }).reasons.join(" ")).toMatch(/outside the issue dir/);

  const absent = manifest([{ id: "dw1", kind: "log", file: "dw1-1.log", summary: "x" }]);
  const r = validateManifest(absent, { ...opts, fileExists: () => false });
  expect(r.ok).toBe(false);
  expect(r.reasons.join(" ")).toMatch(/does not exist/);
});

test("validateManifest: shape errors are reasons, not crashes — schema, kind, command exit", () => {
  expect(validateManifest(null, { doneWhen: dw("dw1") }).ok).toBe(false);
  expect(validateManifest(manifest([], { schema: "nope" }), { doneWhen: [], fileExists: always }).reasons.join(" ")).toMatch(/schema/);
  const badKind = manifest([{ id: "dw1", kind: "vibes", file: "a.log", summary: "x" }]);
  expect(validateManifest(badKind, { doneWhen: dw("dw1"), fileExists: always }).reasons.join(" ")).toMatch(/kind/);
  const noExit = manifest([{ id: "dw1", kind: "command", file: "a.log", cmd: "npm test", summary: "x" }]);
  expect(validateManifest(noExit, { doneWhen: dw("dw1"), fileExists: always }).reasons.join(" ")).toMatch(/exit/);
});

test("validateManifest: claim ids outside done_when are extras, but `smoke` always belongs", () => {
  const m = manifest([
    { id: "dw1", kind: "log", file: "dw1-1.log", summary: "x" },
    { id: SMOKE_CLAIM, kind: "command", file: "smoke-1.log", cmd: "npm run smoke", exit: 0, summary: "smoke" },
    { id: "dw9", kind: "log", file: "dw9-1.log", summary: "invented" },
  ]);
  const r = validateManifest(m, { doneWhen: dw("dw1"), maturity: "M0", fileExists: always });
  expect(r.ok).toBe(true);              // extras do not invalidate — they are reported, not refused
  expect(r.extras).toEqual(["dw9"]);
});

// ── 리뷰 라운드 1 SF-2 / SF-3 — 읽지 못한 계약도, 전부 면제한 계약도 "충족"이 아니다 ─────────────

test("SF-2: an unresolved done_when is undecidable, not complete", () => {
  const m = manifest([{ id: "dw1", kind: "command", file: "dw1-1.log", cmd: "npm test", exit: 0, summary: "ok" }]);
  const r = validateManifest(m, { doneWhen: [], maturity: "M0", fileExists: always });
  expect(r.ok).toBe(false);
  expect(r.reasons.join(" ")).toMatch(/done_when could not be resolved/);
  // 빈 매니페스트도 마찬가지다 — 예전에는 이 조합이 `coverage: complete`였다.
  expect(validateManifest(manifest([]), { doneWhen: [], maturity: "M0", fileExists: always }).ok).toBe(false);
});

test("SF-2: finish exits 1 and says why when done_when cannot be resolved (no id to name)", () => {
  const root = tmp();
  runCli(["na", "--issue", "3", "--claim", "dw1", "--reason", "no context here"], cliOpts(root));
  const errs = [];
  expect(runCli(["finish", "--issue", "3"], cliOpts(root, { log: () => {}, err: (s) => errs.push(s), spawn: () => ({ status: 1, stdout: "", stderr: "" }) }))).toBe(1);
  expect(errs.join("\n")).toMatch(/qa evidence not acceptable/);
  expect(errs.join("\n")).toMatch(/done_when could not be resolved/);
  expect(errs.join("\n")).not.toMatch(/see reasons above/);
});

test("SF-3: a manifest where every done_when id is not_applicable is refused — that is a report, not a review", () => {
  const all = manifest([
    { id: "dw1", kind: "not_applicable", summary: "x", reason: "cannot reproduce" },
    { id: "dw2", kind: "not_applicable", summary: "y", reason: "cannot reproduce" },
  ]);
  const r = validateManifest(all, { doneWhen: dw("dw1", "dw2"), maturity: "M0", fileExists: always });
  expect(r.ok).toBe(false);
  expect(r.reasons.join(" ")).toMatch(/every done_when id is not_applicable/);
  // 하나라도 실제로 재현했으면 통과한다 — na 자체를 금지하는 규칙이 아니다.
  const mixed = manifest([
    { id: "dw1", kind: "command", file: "dw1-1.log", cmd: "npm test", exit: 0, summary: "ran" },
    { id: "dw2", kind: "not_applicable", summary: "y", reason: "no UI in this tier" },
  ]);
  expect(validateManifest(mixed, { doneWhen: dw("dw1", "dw2"), maturity: "M0", fileExists: always }).ok).toBe(true);
});

test("SF-3: claim counts ride to the run record so a retro can see an na-heavy approval", () => {
  const m = manifest([
    { id: "dw1", kind: "command", file: "dw1-1.log", cmd: "npm test", exit: 0, summary: "ran" },
    { id: "dw2", kind: "not_applicable", summary: "y", reason: "no UI" },
  ]);
  expect(claimCounts(m)).toEqual({ claims: 1, na: 1 });
  expect(claimCountsLabel(claimCounts(m))).toBe("1c/1na");
});

test("SF-6: the probe removes a directory it created, and leaves one it did not", () => {
  const root = tmp();
  expect(probeEvidenceDir({ root, issue: "probe" })).toMatchObject({ ok: true, created: true });
  expect(existsSync(qaDir(root, "probe"))).toBe(false);        // 진단이 사람의 저장소에 자국을 남기지 않는다

  runCli(["na", "--issue", "7", "--claim", "dw1", "--reason", "r"], cliOpts(root));
  expect(probeEvidenceDir({ root, issue: 7 })).toMatchObject({ ok: true, created: false });
  expect(existsSync(manifestPath(root, 7))).toBe(true);        // 실제 증거함은 건드리지 않는다
});

test("manifestDigest is deterministic, key-order independent, and content sensitive", () => {
  const a = manifest([{ id: "dw1", kind: "log", file: "dw1-1.log", summary: "x" }]);
  const b = { claims: a.claims, tool_version: a.tool_version, created_at: a.created_at, maturity: a.maturity, head_sha: a.head_sha, issue: a.issue, schema: a.schema };
  expect(manifestDigest(a)).toEqual(manifestDigest(b));
  expect(manifestDigest(a)).toMatch(/^[0-9a-f]{64}$/);
  expect(manifestDigest(a)).not.toEqual(manifestDigest(manifest([{ id: "dw1", kind: "log", file: "dw1-1.log", summary: "y" }])));
});

test("coverageTable names every done_when id and what is missing", () => {
  const m = manifest([{ id: "dw1", kind: "command", file: "dw1-1.log", cmd: "npm test", exit: 0, summary: "ok" }]);
  const t = coverageTable(m, { doneWhen: dw("dw1", "dw2"), maturity: "M0", fileExists: always });
  expect(t).toMatch(/dw1/);
  expect(t).toMatch(/dw2/);
  expect(t).toMatch(/MISSING/);
});

// ── 3. 도구: probe ───────────────────────────────────────────────────────────────────────────

test("probe: exit 0 when the dir can be created and written, exit 2 with a precise message when it cannot", async () => {
  const root = tmp();
  const out = [];
  expect(runCli(["probe", "--issue", "3"], { cwd: root, log: (s) => out.push(s), err: (s) => out.push(s) })).toBe(0);
  expect(existsSync(join(root, ".factory/out/qa"))).toBe(true);   // 쓸 수 있다는 것은 확인됐고
  expect(existsSync(qaDir(root, 3))).toBe(false);                 // 프로브가 만든 자국은 남지 않는다(SF-6)
  expect(out.join("\n")).toMatch(/writable/);

  // `.factory/out/qa`를 **파일**로 만들어 두면 mkdir -p 자체가 실패한다 — 루트 권한이 없는 CI에서도
  // 재현되는 유일한 "쓸 수 없음"이다(chmod 0500은 root로 도는 러너에서 무력하다).
  const blocked = tmp();
  mkdirSync(join(blocked, ".factory/out"), { recursive: true });
  writeFileSync(join(blocked, ".factory/out/qa"), "not a directory");
  const errs = [];
  expect(runCli(["probe", "--issue", "3"], { cwd: blocked, log: () => {}, err: (s) => errs.push(s) })).toBe(2);
  expect(errs.join("\n")).toMatch(/qa evidence dir not writable/);
  expect(errs.join("\n")).toMatch(/\.factory\/out\/qa\/3/);
});

test("probeEvidenceDir leaves nothing behind — the probe file is unlinked and the dir it created is removed", () => {
  const root = tmp();
  const r = probeEvidenceDir({ root, issue: 3 });
  expect(r.ok).toBe(true);
  expect(existsSync(qaDir(root, 3))).toBe(false);
  // 그래도 부모(`.factory/out/qa`)는 남는다 — 그것을 만든 것이 프로브의 일이고, 다음 `record`가 쓴다.
  expect(existsSync(join(root, ".factory/out/qa"))).toBe(true);
});

// ── 4. 도구: record / attach / na / finish ────────────────────────────────────────────────────

/**
 * 기본값으로 **페이로드 판정기를 통과시킨다**: 그 판정은 훅 스크립트 두 개를 실제로 띄우므로(초 단위),
 * 판정 자체를 검사하지 않는 테스트까지 그 값을 치를 이유가 없다. MF-1 테스트들은 `gate: undefined`로
 * 기본값(진짜 `gatePayload`)을 되살려 **실제 훅**에 대고 검사한다.
 */
const cliOpts = (root, extra = {}) => ({ cwd: root, log: () => {}, err: () => {}, now: () => "2026-09-14T00:00:00Z", gate: () => ({ ok: true }), ...extra });
/** MF-1 전용 — 진짜 훅으로 판정한다(기본 인자가 되살아나도록 `undefined`를 명시한다). */
const realGate = (root, extra = {}) => cliOpts(root, { gate: undefined, ...extra });

/**
 * 테스트가 띄우는 자식 프로세스. **`node -e`를 쓰지 않는다** — MF-1 이후 인라인 스크립트는 페이로드로
 * 거절되기 때문이다(훅이 읽을 수 없는 두 번째 명령줄이다). 그래서 리뷰어가 실제로 쓸 모양 그대로
 * **파일을 실행한다**: `node <path>`는 두 훅을 통과하고 인터프리터 검사에도 걸리지 않는다.
 */
const script = (body) => {
  const p = join(mkdtempSync(join(tmpdir(), "qa-script-")), "s.js");
  writeFileSync(p, body);
  return ["node", p];
};

test("record: runs the command, stores stdout+stderr with an exit header, and appends a command claim", () => {
  const root = tmp();
  const code = runCli(
    ["record", "--issue", "3", "--claim", "dw1", "--summary", "export returns 200", "--", ...script("console.log('hi'); console.error('warn'); process.exit(3)")],
    cliOpts(root),
  );
  expect(code).toBe(0);
  const m = JSON.parse(readFileSync(manifestPath(root, 3), "utf8"));
  expect(m.schema).toBe(QA_SCHEMA);
  expect(m.issue).toBe(3);
  expect(m.claims).toHaveLength(1);
  expect(m.claims[0]).toMatchObject({ id: "dw1", kind: "command", exit: 3, summary: "export returns 200", file: "dw1-1.log" });
  const log = readFileSync(join(qaDir(root, 3), "dw1-1.log"), "utf8");
  expect(log).toMatch(/exit: 3/);
  expect(log).toMatch(/hi/);
  expect(log).toMatch(/warn/);

  // 두 번째 record는 같은 claim 아래 `-2`로 쌓인다 — 덮어쓰지 않는다.
  runCli(["record", "--issue", "3", "--claim", "dw1", "--summary", "again", "--", ...script("1")], cliOpts(root));
  const m2 = JSON.parse(readFileSync(manifestPath(root, 3), "utf8"));
  expect(m2.claims.map((c) => c.file)).toEqual(["dw1-1.log", "dw1-2.log"]);
}, 30000);   // 이 테스트는 실제로 프로세스를 띄운다 — 전체 스위트와 함께 돌 때 기본 5s로는 모자란다

test("record: secrets in the captured output are scrubbed before they land in the evidence dir", () => {
  const root = tmp();
  const token = "ghp_" + "b".repeat(36);
  runCli(
    ["record", "--issue", "3", "--claim", "dw1", "--summary", "auth probe", "--", ...script(`console.log("token ${token}")`)],
    cliOpts(root, { env: { GITHUB_TOKEN: token } }),
  );
  const log = readFileSync(join(qaDir(root, 3), "dw1-1.log"), "utf8");
  expect(log).not.toContain(token);
  expect(log).toMatch(/\[REDACTED:/);
}, 30000);

test("record: a command that cannot be spawned is still evidence (exit recorded, not a crash)", () => {
  const root = tmp();
  const code = runCli(["record", "--issue", "3", "--claim", "dw1", "--summary", "missing binary", "--", "definitely-not-a-command-xyz"], cliOpts(root));
  expect(code).toBe(0);
  const m = JSON.parse(readFileSync(manifestPath(root, 3), "utf8"));
  expect(m.claims[0].kind).toBe("command");
  expect(Number.isInteger(m.claims[0].exit)).toBe(true);
}, 30000);

test("attach: copies the file into the issue dir and records the kind; a missing source is exit 1", () => {
  const root = tmp();
  const shot = join(tmp(), "shot.png");
  writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  expect(runCli(["attach", "--issue", "3", "--claim", "dw2", "--kind", "screenshot", "--file", shot, "--summary", "the export screen"], cliOpts(root))).toBe(0);
  const m = JSON.parse(readFileSync(manifestPath(root, 3), "utf8"));
  expect(m.claims[0]).toMatchObject({ id: "dw2", kind: "screenshot", file: "dw2-1.png", summary: "the export screen" });
  expect(existsSync(join(qaDir(root, 3), "dw2-1.png"))).toBe(true);

  const errs = [];
  expect(runCli(["attach", "--issue", "3", "--claim", "dw2", "--kind", "screenshot", "--file", "/nope/shot.png", "--summary", "x"], cliOpts(root, { err: (s) => errs.push(s) }))).toBe(1);
  expect(errs.join(" ")).toMatch(/cannot be read/);
});

test("na: records a not_applicable claim with its reason", () => {
  const root = tmp();
  expect(runCli(["na", "--issue", "3", "--claim", "dw5", "--reason", "no UI surface in this tier"], cliOpts(root))).toBe(0);
  const m = JSON.parse(readFileSync(manifestPath(root, 3), "utf8"));
  expect(m.claims[0]).toMatchObject({ id: "dw5", kind: "not_applicable", reason: "no UI surface in this tier" });
  expect(m.claims[0].file).toBeUndefined();
});

test("finish: prints the coverage table and exits 1 while a done_when id is uncovered, 0 once it is", () => {
  const root = tmp();
  mkdirSync(join(root, ".factory/out"), { recursive: true });
  writeFileSync(join(root, ".factory/out/context.json"), JSON.stringify({
    harness: { maturity: "M0" },
    handoffs: { plan: { done_when: dw("dw1", "dw2") } },
  }));
  runCli(["record", "--issue", "3", "--claim", "dw1", "--summary", "ran", "--", ...script("1")], cliOpts(root));

  const out = [];
  expect(runCli(["finish", "--issue", "3"], cliOpts(root, { log: (s) => out.push(s), err: (s) => out.push(s) }))).toBe(1);
  expect(out.join("\n")).toMatch(/dw2/);
  expect(out.join("\n")).toMatch(/MISSING/);

  runCli(["na", "--issue", "3", "--claim", "dw2", "--reason", "covered by dw1's run"], cliOpts(root));
  const ok = [];
  expect(runCli(["finish", "--issue", "3"], cliOpts(root, { log: (s) => ok.push(s) }))).toBe(0);
  expect(ok.join("\n")).toMatch(/dw1/);
}, 30000);

test("the tool stamps head_sha and maturity from the stage context, so the manifest names the commit it describes", () => {
  const root = tmp();
  mkdirSync(join(root, ".factory/out"), { recursive: true });
  writeFileSync(join(root, ".factory/out/context.json"), JSON.stringify({
    harness: { maturity: "M2" },
    handoffs: { implement: { head_sha: "c".repeat(40) }, plan: { done_when: dw("dw1") } },
  }));
  runCli(["na", "--issue", "3", "--claim", "dw1", "--reason", "x"], cliOpts(root));
  const m = JSON.parse(readFileSync(manifestPath(root, 3), "utf8"));
  expect(m.head_sha).toBe("c".repeat(40));
  expect(m.maturity).toBe("M2");
});

test("usage: an unknown subcommand or a missing --issue is exit 1 with the usage line", () => {
  const root = tmp();
  const errs = [];
  expect(runCli(["frobnicate"], cliOpts(root, { err: (s) => errs.push(s) }))).toBe(1);
  expect(runCli(["record", "--claim", "dw1"], cliOpts(root, { err: (s) => errs.push(s) }))).toBe(1);
  expect(errs.join("\n")).toMatch(/usage: qa-evidence\.js/);
});

// ── 5. 스테이지가 읽는 요약 ───────────────────────────────────────────────────────────────────

test("evidenceFor: reads the manifest off disk, validates it against done_when, and binds it to a head sha", () => {
  const root = tmp();
  mkdirSync(join(root, ".factory/out"), { recursive: true });
  writeFileSync(join(root, ".factory/out/context.json"), JSON.stringify({
    harness: { maturity: "M0" },
    handoffs: { implement: { head_sha: "d".repeat(40) }, plan: { done_when: dw("dw1") } },
  }));
  const missing = evidenceFor({ root, issue: 3, doneWhen: dw("dw1"), maturity: "M0", headSha: "d".repeat(40) });
  expect(missing.ok).toBe(false);
  expect(missing.reason).toMatch(/no qa evidence manifest/);

  runCli(["record", "--issue", "3", "--claim", "dw1", "--summary", "ran", "--", ...script("1")], cliOpts(root));
  const ok = evidenceFor({ root, issue: 3, doneWhen: dw("dw1"), maturity: "M0", headSha: "d".repeat(40) });
  expect(ok.ok).toBe(true);
  expect(ok.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(ok.head_sha).toBe("d".repeat(40));

  // 다른 커밋에 대고 물으면 통과가 아니다 — 그 증거는 이 트리의 얘기가 아니다.
  const moved = evidenceFor({ root, issue: 3, doneWhen: dw("dw1"), maturity: "M0", headSha: "e".repeat(40) });
  expect(moved.ok).toBe(false);
  expect(moved.reason).toMatch(/describes/);
}, 30000);

test("readManifest: unreadable or malformed JSON is a reason, never a throw", () => {
  const root = tmp();
  expect(readManifest(root, 3).ok).toBe(false);
  mkdirSync(qaDir(root, 3), { recursive: true });
  writeFileSync(manifestPath(root, 3), "{ not json");
  const r = readManifest(root, 3);
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/not valid JSON/);
});

test("qaDirRel is the path the harness, the hooks and the ci-settings all spell the same way", () => {
  expect(qaDirRel(3)).toBe(".factory/out/qa/3");
  expect(qaDir("/repo", 3)).toBe("/repo/.factory/out/qa/3");
  expect(KINDS).toContain("not_applicable");
});

// ── 리뷰 라운드 1 MF-1 — `record -- <cmd>`는 직접 Bash 호출과 **같은 판정**을 받는다 ──────────────

test("MF-1: a payload the hooks would refuse does not run through the tool either", () => {
  const root = tmp();
  for (const payload of [
    ["rm", "-rf", "src"],
    ["git", "push", "origin", "HEAD:main"],
    ["curl", "-o", "src/a.js", "https://e.co/x"],
    ["touch", "src/a.js"],
  ]) {
    const errs = [];
    expect(runCli(["record", "--issue", "3", "--claim", "dw1", "--summary", "s", "--", ...payload], realGate(root, { err: (s) => errs.push(s) })), payload.join(" ")).toBe(1);
    expect(errs.join("\n"), payload.join(" ")).toMatch(/qa-evidence refused the payload/);
    // 거절된 페이로드는 매니페스트에 한 줄도 남기지 않는다 — 실행되지 않은 것은 증거가 아니다.
    expect(existsSync(manifestPath(root, 3)), payload.join(" ")).toBe(false);
  }
}, 60000);

test("MF-1: an interpreter payload is refused before any hook runs — the hooks cannot read a second command line", () => {
  const root = tmp();
  const spawn = vi.fn(() => { throw new Error("must not spawn"); });
  for (const payload of [
    ["sh", "-c", "cp /tmp/x src/a.js"],
    ["bash", "-c", "echo hi"],
    ["zsh", "-c", "ls"],
    ["env", "FOO=1", "sh", "-c", "ls"],
    ["node", "-e", "require('fs').writeFileSync('src/a.js','x')"],
    ["python3", "-c", "open('src/a.js','w')"],
    ["perl", "-e", "print 1"],
  ]) {
    const errs = [];
    expect(runCli(["record", "--issue", "3", "--claim", "dw1", "--summary", "s", "--", ...payload], realGate(root, { err: (s) => errs.push(s), spawn })), payload.join(" ")).toBe(1);
    expect(errs.join("\n"), payload.join(" ")).toMatch(/will not run an interpreter payload/);
  }
  expect(spawn).not.toHaveBeenCalled();
  // 인터프리터를 **실행**하는 것과 인터프리터 이름이 인자에 있는 것은 다르다: 파일을 받는 node는 통과한다.
  expect(interpreterPayload(["node", "script.js"])).toBe(null);
  expect(interpreterPayload(["npm", "test"])).toBe(null);
});

test("MF-1: the payloads qa actually needs are not refused", () => {
  // 판정만 묻는다 — **실행하지 않는다**. `npm test`를 여기서 진짜로 돌리면 이 테스트가 저장소의
  // 테스트 스위트를 통째로 다시 돌린다(첫 판에서 42초를 태웠다). 도구의 배선은 아래 end-to-end가 본다.
  for (const payload of [
    ["npm", "test"],
    ["npx", "vitest", "run", "test/a.test.js"],
    ["flutter", "test", "test/x_test.dart"],
    ["npx", "playwright", "test", "e2e/export.spec.ts", "--output", "/tmp/qa-results"],
    ["psql", "-c", "select count(*) from reports"],
    ["node", "scripts/seed.js"],
  ]) {
    expect(gatePayload(payload, { env: {} }), payload.join(" ")).toMatchObject({ ok: true });
  }
}, 60000);

test("MF-1: end to end — a legitimate payload goes through the real gate, runs, and becomes a claim", () => {
  const root = tmp();
  const errs = [];
  expect(runCli(["record", "--issue", "3", "--claim", "dw1", "--summary", "ran the repro", "--", ...script("console.log('ok')")], realGate(root, { err: (s) => errs.push(s) }))).toBe(0);
  expect(errs).toEqual([]);
  const m = JSON.parse(readFileSync(manifestPath(root, 3), "utf8"));
  expect(m.claims).toHaveLength(1);
  expect(m.claims[0]).toMatchObject({ id: "dw1", kind: "command", exit: 0 });
}, 60000);

/**
 * ── 재리뷰 SF-2 — 래퍼 한 겹이면 인터프리터 검사가 통째로 비켜갔다 ────────────────────────────────
 * `env -S "bash -c …"`는 `-S`가 플래그로 건너뛰어지고 그 **값**이 프로그램 이름 자리에 왔다
 * (실측: 그 페이로드는 실제로 셸을 열고 파일을 만들었다). 직접 Bash도 그것을 막지 못하므로 도구가
 * 더 넓어진 것은 아니지만, 이름으로 선언한 예외가 한 플래그에 지면 그 방어는 실제보다 강해 보인다.
 */
test("re-review SF-2: wrapped interpreters are refused — env -S, xargs, timeout, nohup, command, busybox", () => {
  const refused = [
    ["env", "-S", "bash -c 'rm -rf src'"],
    ["env", "--split-string=bash -c ls"],
    ["env", "-i", "-u", "PATH", "sh", "-c", "ls"],
    ["xargs", "sh", "-c", "echo hi"],
    ["xargs", "-I", "{}", "bash", "-c", "echo {}"],
    ["timeout", "5", "sh", "-c", "echo hi"],
    ["timeout", "--kill-after", "2", "5s", "zsh", "-c", "ls"],
    ["nohup", "sh", "-c", "ls"],
    ["command", "sh", "-c", "ls"],
    ["busybox", "sh", "-c", "ls"],
    ["setsid", "nohup", "dash", "-c", "ls"],
    ["stdbuf", "-o0", "python3", "-c", "print(1)"],
    ["nice", "node", "-e", "1"],
  ];
  for (const argv of refused) expect(interpreterPayload(argv), argv.join(" ")).toBeTruthy();

  // 래퍼 자체는 죄가 없다 — 감싼 것이 인터프리터가 아니면 통과한다(천장은 직접 호출과 같은 노출이다).
  const allowed = [
    ["timeout", "300", "npm", "test"],
    ["xargs", "-n1", "npx", "vitest", "run"],
    ["env", "CI=1", "npm", "test"],
    ["nohup", "npx", "playwright", "test"],
    ["command", "flutter", "test"],
    ["busybox", "ls"],
    ["nice", "node", "scripts/seed.js"],
  ];
  for (const argv of allowed) expect(interpreterPayload(argv), argv.join(" ")).toBe(null);
});

test("re-review nit 5: the hook sees the string a person would type — arguments are shell-quoted", () => {
  // 인용하지 않으면 인자 **안의** `>`가 훅에게 리다이렉션으로 보여, 직접 호출과 판정이 갈렸다.
  expect(shellQuote("npm")).toBe("npm");
  expect(shellQuote(".a > 1")).toBe("'.a > 1'");
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  let seen = null;
  gatePayload(["jq", ".a > 1", "f.json"], { env: {}, hooks: ["/x/deny.sh"], spawn: (_c, _a, o) => { seen = JSON.parse(o.input).tool_input.command; return { status: 0 }; } });
  expect(seen).toBe(`jq '.a > 1' f.json`);
});

test("MF-1: inside a stage, a payload no hook could judge is refused (fail closed)", () => {
  const root = tmp();
  const errs = [];
  const gated = gatePayload(["npm", "test"], { env: { FACTORY_STAGE: "review" }, hooks: null });
  expect(gated.ok).toBe(false);
  expect(gated.reason).toMatch(/cannot find the hook scripts/);
  // 스테이지 밖(사람의 노트북)에서는 통과시킨다 — 거기서 이 도구는 경계가 아니라 편의다.
  expect(gatePayload(["npm", "test"], { env: {}, hooks: null })).toMatchObject({ ok: true, unchecked: true });
  expect(errs).toEqual([]);

  // 훅은 **도구 자신의 옆에서** 푼다: 이 패키지에서는 `factory/bin/` → `factory/hooks/`,
  // 설치본에서는 `.factory/bin/` → `.claude/hooks/`. 작업 트리의 경로로 풀지 않는다(KTB-37).
  const found = hookPaths();
  expect(found).toHaveLength(2);
  expect(found[0]).toMatch(/deny-all-writes\.sh$/);
  expect(found[1]).toMatch(/block-dangerous\.sh$/);
  expect(hookPaths("/nowhere/at/all/")).toBe(null);
  // 훅을 판정할 수 없는 응답(exit 1 등)도 통과가 아니다 — 판정되지 않은 페이로드는 허용된 페이로드가 아니다.
  const unjudged = gatePayload(["npm", "test"], { env: {}, hooks: ["/x/deny-all-writes.sh"], spawn: () => ({ status: 1, stdout: "", stderr: "jq missing" }) });
  expect(unjudged.ok).toBe(false);
  expect(unjudged.reason).toMatch(/could not judge the payload/);
});

/**
 * ── 재리뷰 MF — 퍼센트 인코딩된 경로에서 도구가 자기 자신을 찾지 못했다 ──────────────────────────
 * `new URL(...).pathname`은 디코딩하지 않는다: `/sp ace/`는 `/sp%20ace/`로 남고 `existsSync`가 전부
 * false가 된다 → 훅을 못 찾고 → `FACTORY_STAGE` 안에서는 **모든 페이로드가 거절된다**(qa가 아무것도
 * 기록하지 못하는 KTB #3의 모양). 공백이 든 체크아웃 경로는 실재한다.
 */
test("re-review MF: hook and tool resolution survives a path with a space (fileURLToPath, not .pathname)", async () => {
  const spaced = mkdtempSync(join(tmpdir(), "qa sp ace-"));
  cpSync(fileURLToPath(new URL("../", import.meta.url)), join(spaced, "factory"), { recursive: true, filter: (p) => !/[\\/]test[\\/]/.test(p) });
  expect(existsSync(join(spaced, "factory/hooks/deny-all-writes.sh"))).toBe(true);

  // 인자로 준 경로(공백 포함)에서 찾는다 — 그리고 이 디렉터리에는 진짜 훅 두 개가 있다.
  const viaArg = hookPaths(join(spaced, "factory", "bin"));
  expect(viaArg).toHaveLength(2);
  expect(viaArg[0]).toContain("sp ace");

  // **기본 인자**(모듈 자신의 위치)도 같은 규칙으로 풀린다: 공백 디렉터리에 복사한 사본을 import해
  // 인자 없이 부른다. `.pathname`이던 시절 이 줄은 null이었다.
  const copied = await import(pathToFileURL(join(spaced, "factory/bin/qa-evidence.js")).href);
  const viaSelf = copied.hookPaths();
  expect(viaSelf, "hookPaths() from a copy under a path with a space").toHaveLength(2);
  expect(viaSelf.every((p) => !p.includes("%20"))).toBe(true);
  // 그리고 그 사본은 실제로 페이로드를 판정할 수 있다(거절이 경로 문제로 나오지 않는다).
  expect(copied.gatePayload(["npm", "test"], { env: { FACTORY_STAGE: "review" } })).toMatchObject({ ok: true });
});

test("re-review MF: the probe refuses to fall back silently when its own bin dir does not resolve", async () => {
  // run-stage의 프로브는 자기 옆에서 도구를 푼다. 디렉터리 자체가 없다고 나오면 그것은 "설치되지
  // 않았다"가 아니라 경로가 망가졌다는 뜻이고, 그때 in-process 프로브가 `ok`를 찍으면 "qa가 쓸 수
  // 있는가"를 묻는 유일한 검사가 초록을 보고하는 동안 `record`는 죽어 있다.
  const src = readFileSync(fileURLToPath(new URL("../bin/run-stage.js", import.meta.url)), "utf8");
  expect(src).toContain("fileURLToPath(import.meta.url)");
  expect(src).not.toMatch(/new URL\("\.\/qa-evidence\.js", import\.meta\.url\)\.pathname/);
  expect(src).toContain("refusing to fall back silently");
});

test("MF-3: there is no --root — the tool always writes under the process cwd", () => {
  const root = tmp();
  const elsewhere = tmp();
  runCli(["na", "--issue", "3", "--claim", "dw1", "--reason", "x", "--root", elsewhere], cliOpts(root));
  expect(existsSync(manifestPath(root, 3))).toBe(true);
  expect(existsSync(manifestPath(elsewhere, 3))).toBe(false);
  expect(existsSync(join(elsewhere, ".factory"))).toBe(false);
});

/**
 * ── 재리뷰 SF-3 — `attach --file`의 **출처**도 가둔다 ──────────────────────────────────────────
 * MF-3이 목적지를 가뒀지만 출처는 열려 있었다: 저장소 밖의 파일도, 세션이 `Read(...)`로 막아 둔
 * `.env`도 그대로 읽혀 증거가 됐고, 거기서 spec-conformance가 읽어 handoff에 인용하면 공개 이슈로 나간다.
 */
test("re-review SF-3: attach refuses a source outside the repo and temp dirs", () => {
  const root = tmp();
  const outside = mkdtempSync(join(tmpdir(), "elsewhere-"));
  // `/tmp` 아래가 아닌 "밖"을 만들려면 뿌리 목록에 없는 곳이어야 한다 — 저장소 안에 심볼릭 링크를 두고
  // 그 링크가 밖을 가리키게 한다(realpath 이후 판정이라는 사실까지 함께 고정한다).
  const secret = join(outside, "keys.txt");
  writeFileSync(secret, "s3cret");
  const link = join(root, "innocent.txt");
  try { symlinkSync(secret, link); } catch { return; }          // 심볼릭 링크를 못 만드는 환경이면 건너뛴다

  const r = checkAttachSource(link, { root, env: {}, denyGlobs: [], realpath: (p) => (p === link ? secret : p) });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/must live inside the repo or a temp dir/);

  const errs = [];
  // env를 비워 TMPDIR를 허용 뿌리에서 뺀다 — macOS의 tmpdir는 /var/folders라, 그것이 열려 있으면
  // "밖"을 만들 자리가 없다(테스트가 자기도 모르게 아무것도 검사하지 않게 된다).
  expect(runCli(["attach", "--issue", "3", "--claim", "dw1", "--kind", "log", "--file", link, "--summary", "leak"], cliOpts(root, { env: {}, err: (s) => errs.push(s) }))).toBe(1);
  expect(errs.join("\n")).toMatch(/must live inside the repo or a temp dir/);
  expect(existsSync(manifestPath(root, 3))).toBe(false);        // 거절된 출처는 한 바이트도 남기지 않는다
});

test("re-review SF-3: attach refuses a source the session's own Read deny list covers (.env, .git, .npmrc)", () => {
  const root = tmp();
  mkdirSync(join(root, ".factory"), { recursive: true });
  // 목록은 **손으로 베끼지 않는다** — 세션이 들고 도는 그 파일에서 읽는다(여기서는 실제 템플릿을 쓴다).
  const template = readFileSync(new URL("../../templates/factory/factory/ci-settings.json", import.meta.url), "utf8");
  writeFileSync(join(root, ".factory/ci-settings.json"), template);
  expect(readDenyGlobs(root)).toContain(".env");

  for (const name of [".env", ".env.local", ".npmrc"]) {
    writeFileSync(join(root, name), "SECRET=1");
    const errs = [];
    expect(runCli(["attach", "--issue", "3", "--claim", "dw1", "--kind", "log", "--file", name, "--summary", "leak"], cliOpts(root, { err: (s) => errs.push(s) })), name).toBe(1);
    expect(errs.join("\n"), name).toMatch(/deny rule/);
  }
  // 평범한 증거 파일은 그대로 들어간다.
  writeFileSync(join(root, "shot.png"), "not really a png");
  expect(runCli(["attach", "--issue", "3", "--claim", "dw1", "--kind", "screenshot", "--file", "shot.png", "--summary", "the screen"], cliOpts(root))).toBe(0);
  expect(JSON.parse(readFileSync(manifestPath(root, 3), "utf8")).claims).toHaveLength(1);
});

test("re-review SF-3: inside a stage, an unreadable deny list is a refusal (fail closed)", () => {
  const root = tmp();
  writeFileSync(join(root, "note.txt"), "x");
  expect(checkAttachSource("note.txt", { root, env: { FACTORY_STAGE: "review" }, denyGlobs: null }).ok).toBe(false);
  expect(checkAttachSource("note.txt", { root, env: {}, denyGlobs: null })).toMatchObject({ ok: true, unchecked: true });
});

test("nit 2: a claim id that would be rewritten for the filename is refused, not silently renamed", () => {
  const root = tmp();
  const errs = [];
  for (const bad of ["a b", "dw/1", "dw:1", "x".repeat(65)]) {
    expect(runCli(["na", "--issue", "3", "--claim", bad, "--reason", "r"], cliOpts(root, { err: (s) => errs.push(s) })), bad).toBe(1);
  }
  expect(errs.join("\n")).toMatch(/--claim must be a done_when id/);
  expect(runCli(["na", "--issue", "3", "--claim", "dw1", "--reason", "r"], cliOpts(root))).toBe(0);
});

test("KTB-42: both ci-settings templates allow the tool's Bash spelling — dontAsk refuses whatever allow omits", () => {
  for (const f of ["ci-settings.json", "ci-settings-harness.json"]) {
    const j = JSON.parse(readFileSync(new URL(`../../templates/factory/factory/${f}`, import.meta.url).pathname, "utf8"));
    const allow = new Set(j.permissions.allow || []);
    for (const a of ["Bash(node .factory/bin/qa-evidence.js *)", "Bash(node ./.factory/bin/qa-evidence.js *)"]) {
      expect(allow.has(a), `${f} allow ${a}`).toBe(true);
    }
    // deny에는 도구를 막는 항목이 없다 — 그리고 매니페스트의 **직접 쓰기** 철자만 닫혀 있다(SF-1b).
    expect((j.permissions.deny || []).some((d) => /qa-evidence/.test(d)), f).toBe(false);
  }
  // 그 deny는 템플릿이 아니라 설치 시점에 생성된다(`renderCiSettings`가 경로 deny를 통째로 다시 쓴다).
  const prot = { factory: [".factory/**"], agent_writable: [], runner_only: [] };
  for (const harnessMode of [false, true]) {
    const rendered = JSON.parse(renderCiSettings(JSON.stringify({ permissions: { deny: ["Read(.env)"], allow: [] } }), prot, { harnessMode }));
    expect(rendered.permissions.deny, String(harnessMode)).toContain("Write(.factory/out/qa/**/manifest.json)");
    expect(rendered.permissions.deny, String(harnessMode)).toContain("Edit(.factory/out/qa/**/manifest.json)");
    // 증거 **디렉터리** 자체는 열려 있어야 한다 — 닫혔다면 그것이 KTB #3의 재발이다.
    expect(rendered.permissions.deny.some((d) => /\((\.factory\/out\/qa\/\*\*)\)$/.test(d))).toBe(false);
  }
});

// ── 6. review.v1 검증: qa 판정은 매니페스트의 claim id를 인용해야 한다 ──────────────────────────

test("citedClaimIds finds the manifest ids a verdict actually names", () => {
  const verdict = {
    role: "qa", verdict: "reject", confidence: "high",
    must_fix: [{ id: "qa1", where: "x", claim: "y", evidence: "claim:dw2 — dw2-1.log line 18" }],
    should_fix: [], verified: ["dw1 reproduced (claim:dw1)"],
  };
  expect(citedClaimIds(verdict, ["dw1", "dw2", "dw3"]).sort()).toEqual(["dw1", "dw2"]);
  expect(citedClaimIds({ role: "qa", must_fix: [], should_fix: [], verified: ["looks fine"] }, ["dw1"])).toEqual([]);
});

test("verify-stage: a qa verdict that cites no manifest claim id fails the review stage", () => {
  const verdicts = (evidence) => [{
    role: "qa", verdict: "reject", confidence: "high",
    must_fix: [{ id: "qa1", where: "/reports", claim: "500 on empty", evidence }],
    should_fix: [], verified: [],
  }];
  const base = {
    stage: "review", roster: ["qa"], rolePrefix: "reviewer-",
    agentsLog: { completed: ["reviewer-qa"] },
    gates: { status: "GREEN", level: "unit" },
    qaManifest: { ok: true, claimIds: ["dw1", "dw2"] },
  };
  const data = (evidence) => ({ schema: "factory.review.v1", issue: 3, pr: 9, head_sha: "a".repeat(40), round: 1, verdicts: verdicts(evidence), orchestration: "workflow", guarantee: "verified" });

  const bad = verifyStage({ ...base, out: { is_error: false, result: JSON.stringify(data("the screenshot I took")) }, transcriptText: "" });
  expect(bad.ok).toBe(false);
  expect(bad.reasons.join(" ")).toMatch(/qa verdict cites no qa evidence claim id/);

  const good = verifyStage({ ...base, out: { is_error: false, result: JSON.stringify(data("claim:dw2 — dw2-1.log:18")) }, transcriptText: "" });
  expect(good.ok).toBe(true);
});

// ── 리뷰 라운드 1 MF-2 — 없는 매니페스트는 "인용하지 않았다"가 아니다 ────────────────────────────

test("MF-2: an absent or stale manifest is named as the evidence path, not as the reviewer's citation habits", () => {
  const data = { schema: "factory.review.v1", issue: 3, pr: 9, head_sha: "a".repeat(40), round: 1, orchestration: "workflow", guarantee: "verified",
    verdicts: [{ role: "qa", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: ["dw1 reproduced"] }] };
  const base = {
    stage: "review", roster: ["qa"], rolePrefix: "reviewer-",
    agentsLog: { completed: ["reviewer-qa"] }, gates: { status: "GREEN", level: "unit" },
    out: { is_error: false, result: JSON.stringify(data) }, transcriptText: "",
  };
  for (const reason of ["no qa evidence manifest at .factory/out/qa/3/manifest.json", "qa evidence manifest describes bbbbbbb, this head is aaaaaaa"]) {
    const r = verifyStage({ ...base, qaManifest: { ok: false, reason } });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/qa evidence manifest unusable/);
    expect(r.reasons.join(" ")).toContain(reason);
    expect(r.reasons.join(" ")).toMatch(/this is the evidence path, not the builder's work/);
    // **그리고 인용 문구는 나오지 않는다** — 두 상태가 한 문장으로 뭉개지던 것이 이 결함이었다.
    expect(r.reasons.join(" ")).not.toMatch(/cites no qa evidence claim id/);
    expect(qaEvidenceUnusable(r.reasons)).toBe(true);
  }
  // 매니페스트가 멀쩡하면 예전 규칙 그대로 인용을 묻는다.
  const cited = verifyStage({ ...base, qaManifest: { ok: true, claimIds: ["dw1"] } });
  expect(cited.ok).toBe(true);
  expect(qaEvidenceUnusable(cited.reasons)).toBe(false);
});

/**
 * 재리뷰 SF-1b — **누구의 부족인가로 한 번 더 가른다.** 1라운드는 `ok !== true` 전부를 "증거 경로의
 * 고장"으로 불렀는데, 커버리지가 빈 id들과 전부 `na`인 매니페스트는 **qa 리뷰어 자신의** 부족이다.
 * 그것을 인프라(`undecidable`)로 부르면 sweeper가 같은 부족을 상대로 리뷰를 세 번 다시 돌리고,
 * "빌더의 일이 아니다"라는 문장이 사실과 어긋난다.
 */
test("re-review SF-1b: the reviewer's own shortfall is a reject naming the ids, not an infrastructure failure", () => {
  const data = { schema: "factory.review.v1", issue: 3, pr: 9, head_sha: "a".repeat(40), round: 1, orchestration: "workflow", guarantee: "verified",
    verdicts: [{ role: "qa", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: ["dw1 reproduced"] }] };
  const base = {
    stage: "review", roster: ["qa"], rolePrefix: "reviewer-",
    agentsLog: { completed: ["reviewer-qa"] }, gates: { status: "GREEN", level: "unit" },
    out: { is_error: false, result: JSON.stringify(data) }, transcriptText: "",
  };

  /**
   * (a) 커버리지 부족 — id를 부르고, **undecidable이 아니며**, 최종 리뷰 A-SF1 이후로는
   * **스테이지의 실패도 아니다**: `reasons`가 아니라 `qaShortfall`로 나가 run-stage가 이 라운드의
   * 판정(합성 must_fix → `factory:rework`)으로 접는다. 스테이지 산출물(`review.v1`)은 멀쩡하다.
   */
  const missing = verifyStage({ ...base, qaManifest: { ok: false, missing: ["dw2", "dw4"], reason: "qa evidence manifest is incomplete — missing claims for dw2, dw4", reasons: [] } });
  expect(missing.ok).toBe(true);
  expect(missing.reasons).toEqual([]);
  expect(missing.qaShortfall.ids).toEqual(["dw2", "dw4"]);
  expect(missing.qaShortfall.reason).toMatch(/^qa evidence incomplete: spec-evidence-missing: dw2, dw4/);
  expect(missing.qaShortfall.reason).not.toMatch(/not the builder's work/);
  expect(qaEvidenceUnusable(missing.reasons)).toBe(false);

  // (b) 전부 not_applicable — SF-3의 거절이 "무시해도 되는 인프라" 채널로 배달되지 않는다.
  const allNa = verifyStage({ ...base, qaManifest: { ok: false, missing: [], reason: "x", reasons: [`${ALL_NA_PREFIX} (dw1, dw2) — that is a report, not a review`] } });
  expect(allNa.ok).toBe(true);
  expect(allNa.qaShortfall.reason).toMatch(/that is a report, not a review/);
  expect(allNa.qaShortfall.reason.startsWith(QA_EVIDENCE_INCOMPLETE)).toBe(true);
  expect(qaEvidenceUnusable(allNa.reasons)).toBe(false);

  // (c) 진짜 경로 고장만 undecidable로 남는다 — 그쪽은 여전히 스테이지의 실패다.
  const absent = verifyStage({ ...base, qaManifest: { ok: false, missing: [], reasons: [], reason: "no qa evidence manifest at .factory/out/qa/3/manifest.json" } });
  expect(absent.ok).toBe(false);
  expect(absent.qaShortfall).toBe(null);
  expect(qaEvidenceUnusable(absent.reasons)).toBe(true);
});

test("verify-stage: no qa in the roster means the qa evidence rule does not fire", () => {
  const data = { schema: "factory.review.v1", issue: 3, pr: 9, head_sha: "a".repeat(40), round: 1, orchestration: "workflow", guarantee: "verified",
    verdicts: [{ role: "correctness", verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: ["read it"] }] };
  const r = verifyStage({
    stage: "review", roster: ["correctness"], rolePrefix: "reviewer-",
    agentsLog: { completed: ["reviewer-correctness"] }, gates: { status: "GREEN", level: "unit" },
    qaManifest: { ok: false, claimIds: [] },
    out: { is_error: false, result: JSON.stringify(data) }, transcriptText: "",
  });
  expect(r.ok).toBe(true);
});
