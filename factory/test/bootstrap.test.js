import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABELS } from "../lib/label-catalog.js";
import { bootstrapPlan, applyBootstrap } from "../lib/bootstrap.js";
import { bootstrapCommand } from "../cli/bootstrap.js";

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

const PROTECTION_BODY = (contexts) => ({
  required_status_checks: { strict: true, contexts },
  enforce_admins: true,
  required_pull_request_reviews: null,
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

test("bootstrapPlan: protection op body matches the exact required shape, contexts from harness.factory.required_checks", () => {
  const existing = { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: "2026-01-01" }, secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY"] };
  const ops = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing });
  const protectionOps = ops.filter((o) => o.kind === "protection");
  expect(protectionOps.length).toBe(1);
  expect(protectionOps[0]).toEqual({ kind: "protection", branch: "main", body: PROTECTION_BODY(["factory/gates", "factory/review", "factory/integrity"]) });
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
  expect(opsGreen.some((o) => o.kind === "note" && /BOT_TOKEN|OAUTH_TOKEN|ANTHROPIC_API_KEY/.test(o.message))).toBe(false);

  const existingAnthropic = { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: "2026-01-01" }, secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY"] };
  const opsGreen2 = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing: existingAnthropic });
  expect(opsGreen2.some((o) => o.kind === "note" && /BOT_TOKEN|OAUTH_TOKEN|ANTHROPIC_API_KEY/.test(o.message))).toBe(false);
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
  expect(notes.length).toBe(2); // two missing secrets
  expect(logs.length).toBeGreaterThan(0);
});

test("applyBootstrap: note ops never call any gh method", async () => {
  const existing = { labels: [], variables: { FACTORY_TOKEN_ISSUED_AT: "2026-01-01" }, secrets: ["FACTORY_BOT_TOKEN", "ANTHROPIC_API_KEY"] };
  const ops = bootstrapPlan({ harness: HARNESS, today: "2026-09-12", existing });
  expect(ops.some((o) => o.kind === "note")).toBe(true); // the token-issued-at note
  const gh = fakeGh();
  const { applied, notes } = await applyBootstrap({ gh, ops, log: () => {} });
  expect(gh.calls.setVariable.length).toBe(0);
  expect(notes.length).toBe(1);
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
