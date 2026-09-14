import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABELS } from "../lib/label-catalog.js";
import { bootstrapPlan, applyBootstrap, formatBootstrapFailure, isTwoActor } from "../lib/bootstrap.js";
import { bootstrapCommand } from "../cli/bootstrap.js";
import { makeFakeRun } from "../lib/exec.js";

/** loadHarness가 읽을 최소 harness.toml — default_branch·required_checks만 있으면 충분하다. */
function makeHarnessRoot() {
  const root = mkdtempSync(join(tmpdir(), "ktb-bootstrap-cli-"));
  mkdirSync(join(root, ".factory"), { recursive: true });
  writeFileSync(join(root, ".factory/harness.toml"), `
[project]
name = "demo"
default_branch = "main"

[factory]
required_checks = ["factory/gates", "factory/review", "factory/integrity"]
`);
  return root;
}

const HARNESS = { project: { default_branch: "main" }, factory: { required_checks: ["factory/gates", "factory/review", "factory/integrity"] } };

const PROTECTION_BODY = (contexts, { twoActor = false } = {}) => ({
  required_status_checks: { strict: false, contexts },
  enforce_admins: true,
  required_pull_request_reviews: twoActor ? { required_approving_review_count: 1, dismiss_stale_reviews: true } : null,
  restrictions: null,
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
  required_conversation_resolution: false,
});

const io = () => { const o = { out: [], err: [] }; return { io: { out: (s) => o.out.push(s), err: (s) => o.err.push(s) }, o }; };

test("LABELS: unique names, all factory:*-or-backlog, colors are bare 6-hex", () => {
  const names = LABELS.map((l) => l.name);
  expect(new Set(names).size).toBe(names.length);
  for (const l of LABELS) {
    expect(l.name === "backlog" || l.name.startsWith("factory:")).toBe(true);
    expect(l.color).toMatch(/^[0-9a-f]{6}$/);
    expect(typeof l.description).toBe("string");
    expect(l.description.length).toBeGreaterThan(0);
  }
  // backlog(1) + 12 §3.1 factory:* states + 6 aux (tier-docs/-standard/-load-bearing, retro-proposal, flaky, harness)
  expect(names).toContain("backlog");
  for (const s of ["queue", "ready", "needs-info", "wont-do", "planned", "in-progress", "awaiting-review", "rework", "approved", "merged", "blocked", "needs-human"]) {
    expect(names).toContain(`factory:${s}`);
  }
  for (const a of ["tier-docs", "tier-standard", "tier-load-bearing", "retro-proposal", "flaky", "harness"]) {
    expect(names).toContain(`factory:${a}`);
  }
  expect(names.length).toBe(19);
});

test("bootstrapPlan: always emits every label op (existing is report-only, never filters)", () => {
  const existing = { labels: LABELS.map((l) => l.name), variables: { FACTORY_TOKEN_ISSUED_AT: "2026-01-01" }, secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY"] };
  const ops = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing });
  const labelOps = ops.filter((o) => o.kind === "label");
  expect(labelOps.length).toBe(LABELS.length);
  expect(new Set(labelOps.map((o) => o.name)).size).toBe(LABELS.length);
  for (const l of LABELS) {
    expect(labelOps).toContainEqual({ kind: "label", name: l.name, color: l.color, description: l.description });
  }
});

test("bootstrapPlan: protection op body matches the exact required shape — L0 contexts are integrity only (ADR-015 보강)", () => {
  const existing = { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: "2026-01-01" }, secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY"] };
  const ops = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing });
  const protectionOps = ops.filter((o) => o.kind === "protection");
  expect(protectionOps.length).toBe(1);
  // factory/gates·factory/review는 이슈 파이프라인을 타는 PR에만 게시자가 있다 — L0에 넣으면 사람이
  // 머지하는 retro-proposal·harness PR과 첫 push가 영영 막힌다. 둘은 L1(allChecksGreen)이 계속 강제한다.
  expect(protectionOps[0]).toEqual({ kind: "protection", branch: "main", twoActor: false, body: PROTECTION_BODY(["factory/integrity"]) });
  expect(protectionOps[0].body.required_status_checks.strict).toBe(false);   // F3: 게이트는 sha 바인딩 — strict는 factory가 하지 않는 rebase를 요구한다
  // 하네스의 required_checks는 그대로다 — 머지 스테이지(L1)가 세 개 전부를 본다
  expect(HARNESS.factory.required_checks).toEqual(["factory/gates", "factory/review", "factory/integrity"]);
});

test("bootstrapPlan: FACTORY_TOKEN_ISSUED_AT absent → variable op with today's date", () => {
  const existing = { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: null }, secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY"] };
  const ops = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing });
  const varOps = ops.filter((o) => o.kind === "variable");
  expect(varOps).toEqual([{ kind: "variable", name: "FACTORY_TOKEN_ISSUED_AT", value: "2026-09-12" }]);
  expect(ops.some((o) => o.kind === "note" && /FACTORY_TOKEN_ISSUED_AT/.test(o.message))).toBe(false);
});

test("bootstrapPlan: FACTORY_TOKEN_ISSUED_AT present → note instead of variable op", () => {
  const existing = { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: "2026-01-01" }, secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY"] };
  const ops = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing });
  expect(ops.some((o) => o.kind === "variable")).toBe(false);
  expect(ops.some((o) => o.kind === "note" && /FACTORY_TOKEN_ISSUED_AT/.test(o.message))).toBe(true);
});

test("bootstrapPlan: missing secrets → note ops that never carry a value; present secrets → no note", () => {
  const existing = { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: "2026-01-01" }, secrets: [] };
  const ops = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing });
  const notes = ops.filter((o) => o.kind === "note").map((o) => o.message);
  expect(notes.some((m) => m.includes("FACTORY_BOT_TOKEN") && m.includes("gh secret set") && m.includes("bootstrap never writes secret values"))).toBe(true);
  expect(notes.some((m) => (m.includes("CLAUDE_CODE_OAUTH_TOKEN") || m.includes("ANTHROPIC_API_KEY")) && m.includes("gh secret set"))).toBe(true);

  const existingClaude = { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: "2026-01-01" }, secrets: ["FACTORY_BOT_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] };
  const opsGreen = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing: existingClaude });
  expect(opsGreen.some((o) => o.kind === "note" && /gh secret set/.test(o.message))).toBe(false);

  const existingAnthropic = { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: "2026-01-01" }, secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY"] };
  const opsGreen2 = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing: existingAnthropic });
  expect(opsGreen2.some((o) => o.kind === "note" && /gh secret set/.test(o.message))).toBe(false);
});

// ── ADR-021 two-actor mode ──────────────────────────────────────────────────

test("bootstrapPlan (ADR-021): FACTORY_MERGE_TOKEN present → two-actor protection (1 approving review, dismiss stale), enforce_admins kept, restrictions null", () => {
  const existing = { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: "2026-01-01" }, secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY", "FACTORY_MERGE_TOKEN"] };
  const ops = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing });
  const protection = ops.find((o) => o.kind === "protection");
  expect(protection).toEqual({ kind: "protection", branch: "main", twoActor: true, body: PROTECTION_BODY(["factory/integrity"], { twoActor: true }) });
  // 이 두 줄이 "에이전트 토큰으로는 머지가 불가능하다"의 전부다 — 작성자는 자기 PR을 승인할 수 없다.
  expect(protection.body.required_pull_request_reviews).toEqual({ required_approving_review_count: 1, dismiss_stale_reviews: true });
  expect(protection.body.enforce_admins).toBe(true);
  expect(protection.body.restrictions).toBe(null);          // Free 플랜에는 push 제한이 없다 — 승인 요건이 그 자리를 대신한다
  expect(protection.body.required_status_checks).toEqual({ strict: false, contexts: ["factory/integrity"] });
});

test("bootstrapPlan (ADR-021): no FACTORY_MERGE_TOKEN → single-actor protection unchanged (no review requirement — dark merge would be impossible)", () => {
  const existing = { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: "2026-01-01" }, secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY"] };
  const protection = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing }).find((o) => o.kind === "protection");
  expect(protection.twoActor).toBe(false);
  expect(protection.body.required_pull_request_reviews).toBe(null);
});

test("bootstrapPlan (ADR-021): the mode is always named in a note — single-actor says merge power is reachable from agent stages", () => {
  const single = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing: { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: "x" }, secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY"] } });
  const singleNote = single.filter((o) => o.kind === "note").map((o) => o.message).find((m) => /single-actor mode/.test(m));
  expect(singleNote).toMatch(/merge power is reachable from agent stages/);
  expect(singleNote).toMatch(/FACTORY_MERGE_TOKEN/);

  const two = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing: { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: "x" }, secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY", "FACTORY_MERGE_TOKEN"] } });
  const twoNote = two.filter((o) => o.kind === "note").map((o) => o.message).find((m) => /two-actor mode/.test(m));
  expect(twoNote).toMatch(/cannot merge it/);
  // 노트는 시크릿의 **이름**만 말한다 — 값은 bootstrap이 읽지도 쓰지도 않는다.
  expect(two.filter((o) => o.kind === "note").every((o) => !/ghp_|github_pat_/.test(o.message))).toBe(true);
});

test("isTwoActor: the mode comes from the observed secret list, never from a flag", () => {
  expect(isTwoActor(["FACTORY_BOT_TOKEN"])).toBe(false);
  expect(isTwoActor(["FACTORY_BOT_TOKEN", "FACTORY_MERGE_TOKEN"])).toBe(true);
  expect(isTwoActor()).toBe(false);
});

function fakeGh() {
  const calls = { createLabel: [], putBranchProtection: [], setVariable: [] };
  return {
    calls,
    async createLabel(args) { calls.createLabel.push(args); },
    async putBranchProtection(branch, body) { calls.putBranchProtection.push({ branch, body }); },
    async setVariable(name, value) { calls.setVariable.push({ name, value }); },
  };
}

test("applyBootstrap: calls createLabel once per label op, putBranchProtection once, setVariable once; returns applied + notes", async () => {
  const existing = { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: null }, secrets: [] };
  const ops = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing });
  const gh = fakeGh();
  const logs = [];
  const { applied, notes } = await applyBootstrap({ gh, ops, log: (m) => logs.push(m) });

  expect(gh.calls.createLabel.length).toBe(LABELS.length);
  expect(gh.calls.putBranchProtection.length).toBe(1);
  expect(gh.calls.putBranchProtection[0].branch).toBe("main");
  expect(gh.calls.setVariable.length).toBe(1);
  expect(gh.calls.setVariable[0]).toEqual({ name: "FACTORY_TOKEN_ISSUED_AT", value: "2026-09-12" });

  expect(applied.length).toBe(LABELS.length + 1 + 1); // labels + protection + variable
  expect(notes.length).toBe(3); // two missing secrets + the ADR-021 mode note
  expect(logs.length).toBeGreaterThan(0);
});

test("applyBootstrap: note ops never call any gh method", async () => {
  const existing = { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: "2026-01-01" }, secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY"] };
  const ops = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing });
  expect(ops.some((o) => o.kind === "note")).toBe(true); // the token-issued-at note
  const gh = fakeGh();
  const { applied, notes } = await applyBootstrap({ gh, ops, log: () => {} });
  expect(gh.calls.setVariable.length).toBe(0);
  expect(notes.length).toBe(2);   // token-issued-at + the ADR-021 mode note
  expect(applied.length).toBe(LABELS.length + 1); // labels + protection only, no variable
});

function fakeGhCli({ labels = [], secrets = [], variable = null } = {}) {
  const calls = { createLabel: [], putBranchProtection: [], setVariable: [] };
  return {
    calls,
    async listLabels() { return labels; },
    async listSecrets() { return secrets; },
    async getVariable() { return variable; },
    async createLabel(args) { calls.createLabel.push(args); },
    async putBranchProtection(branch, body) { calls.putBranchProtection.push({ branch, body }); },
    async setVariable(name, value) { calls.setVariable.push({ name, value }); },
  };
}

test("bootstrapCommand --dry-run: prints ops, calls no mutating gh method", async () => {
  const gh = fakeGhCli({ labels: [], secrets: [], variable: null });
  const { io: i, o } = io();
  const root = makeHarnessRoot();
  const code = await bootstrapCommand({ root, argv: ["--dry-run"], io: i, gh, today: "2026-09-12" });
  expect(code).toBe(0);
  expect(gh.calls.createLabel.length).toBe(0);
  expect(gh.calls.putBranchProtection.length).toBe(0);
  expect(gh.calls.setVariable.length).toBe(0);
  const printed = o.out.join("\n");
  expect(printed).toContain("label");
  expect(printed).toContain("protection");
});

test("bootstrapCommand: applies ops against injected gh, honors --token-issued-at override", async () => {
  const gh = fakeGhCli({ labels: [], secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY"], variable: "2020-01-01" });
  const { io: i } = io();
  const root = makeHarnessRoot();
  const code = await bootstrapCommand({ root, argv: ["--token-issued-at", "2026-09-12"], io: i, gh, today: "2026-01-01" });
  expect(code).toBe(0);
  expect(gh.calls.createLabel.length).toBe(LABELS.length);
  expect(gh.calls.putBranchProtection.length).toBe(1);
  expect(gh.calls.setVariable.length).toBe(1);
  expect(gh.calls.setVariable[0]).toEqual({ name: "FACTORY_TOKEN_ISSUED_AT", value: "2026-09-12" });
});

// ── fix round 1 ─────────────────────────────────────────────────────────────

test("bootstrapCommand: --token-issued-at rejects a non-date value before any gh call, exit 1", async () => {
  const gh = fakeGhCli();
  const { io: i, o } = io();
  const root = makeHarnessRoot();
  const code = await bootstrapCommand({ root, argv: ["--token-issued-at", "banana"], io: i, gh, today: "2026-01-01" });
  expect(code).toBe(1);
  expect(o.err.join("\n")).toContain("--token-issued-at expects YYYY-MM-DD");
  expect(gh.calls.createLabel.length).toBe(0);
  expect(gh.calls.putBranchProtection.length).toBe(0);
  expect(gh.calls.setVariable.length).toBe(0);
});

test("bootstrapCommand: --token-issued-at as the last arg (no value) → exit 1, no gh call", async () => {
  const gh = fakeGhCli();
  const { io: i, o } = io();
  const root = makeHarnessRoot();
  const code = await bootstrapCommand({ root, argv: ["--token-issued-at"], io: i, gh, today: "2026-01-01" });
  expect(code).toBe(1);
  expect(o.err.join("\n")).toContain("--token-issued-at expects YYYY-MM-DD");
  expect(gh.calls.createLabel.length).toBe(0);
});

test("bootstrapCommand: valid --token-issued-at forces the variable op even when the variable already exists", async () => {
  const gh = fakeGhCli({ labels: [], secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY"], variable: "2020-01-01" });
  const { io: i } = io();
  const root = makeHarnessRoot();
  const code = await bootstrapCommand({ root, argv: ["--token-issued-at", "2026-09-12"], io: i, gh, today: "2026-01-01" });
  expect(code).toBe(0);
  expect(gh.calls.setVariable).toEqual([{ name: "FACTORY_TOKEN_ISSUED_AT", value: "2026-09-12" }]);
});

test("applyBootstrap: a failing op is isolated — the rest still run, failure is reported, not thrown", async () => {
  const existing = { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: null }, secrets: [] };
  const ops = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing });
  const gh = fakeGh();
  gh.createLabel = async (args) => {
    if (args.name === LABELS[0].name) throw new Error("gh: permission denied");
    gh.calls.createLabel.push(args);
  };
  const { applied, failed, notes } = await applyBootstrap({ gh, ops, log: () => {} });
  expect(failed).toEqual([{ op: ops.find((o) => o.kind === "label" && o.name === LABELS[0].name), error: "gh: permission denied" }]);
  expect(gh.calls.createLabel.length).toBe(LABELS.length - 1); // every other label still attempted
  expect(gh.calls.putBranchProtection.length).toBe(1); // protection still ran after the failed label
  expect(gh.calls.setVariable.length).toBe(1); // variable still ran too
  expect(applied.length).toBe(LABELS.length - 1 + 1 + 1); // labels(minus the failed one) + protection + variable
  expect(notes.length).toBe(3);   // two missing secrets + the ADR-021 mode note
});

test("bootstrapCommand: a failing gh op → exit 1, failure printed", async () => {
  const gh = fakeGhCli({ labels: [], secrets: [], variable: null });
  gh.createLabel = async () => { throw new Error("gh: rate limited"); };
  const { io: i, o } = io();
  const root = makeHarnessRoot();
  const code = await bootstrapCommand({ root, argv: [], io: i, gh, today: "2026-09-12" });
  expect(code).toBe(1);
  expect(o.err.join("\n")).toContain("rate limited");
});

// ── fix round 2 (GitHub Free branch-protection 403) ─────────────────────────

const GH_FREE_403 = "gh api -X failed (1): gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)";
const GH_FREE_403_LINE = "protection main: not available on this plan (private repo on GitHub Free) — make the repo public or upgrade; L0 required-check enforcement is off, L1 (merge script requires all checks GREEN) and L2 still apply";

test("formatBootstrapFailure: protection op + GitHub Free 403 message → the actionable line; other failures keep their old text", () => {
  const protectionOp = { kind: "protection", branch: "main", body: {} };
  expect(formatBootstrapFailure({ op: protectionOp, error: GH_FREE_403 })).toBe(GH_FREE_403_LINE);

  const labelOp = { kind: "label", name: LABELS[0].name };
  expect(formatBootstrapFailure({ op: labelOp, error: "gh: permission denied" }))
    .toBe(`failed: label ${LABELS[0].name} — gh: permission denied`);

  // a protection failure that is NOT the GitHub Free wording keeps the old generic text too.
  expect(formatBootstrapFailure({ op: protectionOp, error: "gh: permission denied" }))
    .toBe("failed: protection main — gh: permission denied");
});

test("applyBootstrap: a 403 protection failure is isolated like any other — every other op (labels, variable) still applied", async () => {
  const existing = { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: null }, secrets: [] };
  const ops = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing });
  const gh = fakeGh();
  gh.putBranchProtection = async () => { throw new Error(GH_FREE_403); };
  const { applied, failed } = await applyBootstrap({ gh, ops, log: () => {} });
  expect(failed).toEqual([{ op: ops.find((o) => o.kind === "protection"), error: GH_FREE_403 }]);
  expect(gh.calls.createLabel.length).toBe(LABELS.length);   // every label still attempted
  expect(gh.calls.setVariable.length).toBe(1);               // variable still ran after the failed protection op
  expect(applied.length).toBe(LABELS.length + 1);            // labels + variable (protection failed, not counted)
});

test("bootstrapCommand: branch protection 403 on GitHub Free — single actionable line on stderr, exit 1, every other op still applied", async () => {
  const gh = fakeGhCli({ labels: [], secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY"], variable: null });
  gh.putBranchProtection = async () => { throw new Error(GH_FREE_403); };
  const { io: i, o } = io();
  const root = makeHarnessRoot();
  const code = await bootstrapCommand({ root, argv: [], io: i, gh, today: "2026-09-12" });

  expect(code).toBe(1);
  // printed exactly once, and only that one actionable line — not the raw "Upgrade to GitHub Pro…" gh text.
  const matches = [...o.out, ...o.err].filter((l) => l.includes("not available on this plan"));
  expect(matches).toEqual([GH_FREE_403_LINE]);
  expect(o.err).toEqual([GH_FREE_403_LINE]);
  expect(o.out.join("\n")).not.toContain("Upgrade to GitHub Pro");
  // every other op still ran despite the protection failure.
  expect(gh.calls.createLabel.length).toBe(LABELS.length);
  expect(gh.calls.setVariable.length).toBe(1);
  expect(o.out.join("\n")).toContain(`bootstrap: applied ${LABELS.length + 1} ops`); // labels + variable, not protection
});

test("bootstrapCommand: no gh injected → builds one via the injected run, including the `gh repo view` repo-detect fallback", async () => {
  const prevRepo = process.env.FACTORY_REPO;
  delete process.env.FACTORY_REPO;
  try {
    const fakeRun = makeFakeRun([
      { match: (c, a) => c === "gh" && a[0] === "repo" && a[1] === "view", result: { code: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" } },
      { match: (c, a) => c === "gh" && a[0] === "label" && a[1] === "list", result: { code: 0, stdout: "[]", stderr: "" } },
      { match: (c, a) => c === "gh" && a[0] === "variable" && a[1] === "get", result: { code: 1, stdout: "", stderr: "not found" } },
      { match: (c, a) => c === "gh" && a[0] === "secret" && a[1] === "list", result: { code: 0, stdout: "[]", stderr: "" } },
    ]);
    const { io: i, o } = io();
    const root = makeHarnessRoot();
    const code = await bootstrapCommand({ root, argv: ["--dry-run"], io: i, run: fakeRun, today: "2026-09-12" });
    expect(code).toBe(0);
    expect(fakeRun.calls.some((c) => c.cmd === "gh" && c.args[0] === "repo" && c.args[1] === "view")).toBe(true);
    expect(o.out.join("\n")).toContain("label");
  } finally {
    if (prevRepo === undefined) delete process.env.FACTORY_REPO; else process.env.FACTORY_REPO = prevRepo;
  }
});

test("bootstrapCommand: missing harness.toml → exit 1, message mentions harness.toml", async () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-bootstrap-noharness-"));
  const { io: i, o } = io();
  const code = await bootstrapCommand({ root, argv: [], io: i, gh: fakeGhCli(), today: "2026-09-12" });
  expect(code).toBe(1);
  expect(o.err.join("\n")).toContain("harness.toml");
  rmSync(root, { recursive: true, force: true });
});
