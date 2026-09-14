import { test, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  QA_SCHEMA, KINDS, SMOKE_CLAIM, qaDirRel, qaDir, manifestPath, newManifest,
  validateManifest, manifestDigest, coverageTable, readManifest, probeEvidenceDir,
  evidenceFor, isUiFacing, citedClaimIds,
} from "../lib/qa-evidence.js";
import { runCli } from "../bin/qa-evidence.js";
import { verifyStage } from "../lib/verify-stage.js";

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
  expect(existsSync(qaDir(root, 3))).toBe(true);
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

test("probeEvidenceDir leaves nothing behind — the probe file is unlinked", () => {
  const root = tmp();
  const r = probeEvidenceDir({ root, issue: 3 });
  expect(r.ok).toBe(true);
  expect(readdirSync(qaDir(root, 3))).toEqual([]);
});

// ── 4. 도구: record / attach / na / finish ────────────────────────────────────────────────────

const cliOpts = (root, extra = {}) => ({ cwd: root, log: () => {}, err: () => {}, now: () => "2026-09-14T00:00:00Z", ...extra });

test("record: runs the command, stores stdout+stderr with an exit header, and appends a command claim", () => {
  const root = tmp();
  const code = runCli(
    ["record", "--issue", "3", "--claim", "dw1", "--summary", "export returns 200", "--", "node", "-e", "console.log('hi'); console.error('warn'); process.exit(3)"],
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
  runCli(["record", "--issue", "3", "--claim", "dw1", "--summary", "again", "--", "node", "-e", "1"], cliOpts(root));
  const m2 = JSON.parse(readFileSync(manifestPath(root, 3), "utf8"));
  expect(m2.claims.map((c) => c.file)).toEqual(["dw1-1.log", "dw1-2.log"]);
}, 30000);   // 이 테스트는 실제로 프로세스를 띄운다 — 전체 스위트와 함께 돌 때 기본 5s로는 모자란다

test("record: secrets in the captured output are scrubbed before they land in the evidence dir", () => {
  const root = tmp();
  const token = "ghp_" + "b".repeat(36);
  runCli(
    ["record", "--issue", "3", "--claim", "dw1", "--summary", "auth probe", "--", "node", "-e", `console.log("token ${token}")`],
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
  runCli(["record", "--issue", "3", "--claim", "dw1", "--summary", "ran", "--", "node", "-e", "1"], cliOpts(root));

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

  runCli(["record", "--issue", "3", "--claim", "dw1", "--summary", "ran", "--", "node", "-e", "1"], cliOpts(root));
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

test("KTB-42: both ci-settings templates allow the tool's Bash spelling — dontAsk refuses whatever allow omits", () => {
  for (const f of ["ci-settings.json", "ci-settings-harness.json"]) {
    const j = JSON.parse(readFileSync(new URL(`../../templates/factory/factory/${f}`, import.meta.url).pathname, "utf8"));
    const allow = new Set(j.permissions.allow || []);
    for (const a of ["Bash(node .factory/bin/qa-evidence.js *)", "Bash(node ./.factory/bin/qa-evidence.js *)"]) {
      expect(allow.has(a), `${f} allow ${a}`).toBe(true);
    }
    // deny는 여전히 경로 deny만 담는다 — 도구를 막는 항목이 새로 들어오지 않았는지 본다.
    expect((j.permissions.deny || []).some((d) => /qa-evidence/.test(d)), f).toBe(false);
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
