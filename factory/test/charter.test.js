import { test, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCharter, neverAutomateGlobs, TRIAGE_DEFAULT_VALUES } from "../lib/config.js";
import { checkTriageDefault } from "../lib/doctor/factory.js";
import { neverAutomateHits, verifyStage } from "../lib/verify-stage.js";
import { buildContext } from "../lib/context.js";

const by = (cs) => Object.fromEntries(cs.map((c) => [c.id, c]));
const TEMPLATE_CHARTER = new URL("../../templates/factory/docs/factory/CHARTER.md", import.meta.url).pathname;
const REPO_CHARTER = new URL("../../docs/factory/CHARTER.md", import.meta.url).pathname;
const TRIAGE_AGENT = new URL("../../templates/factory/claude/agents/factory-triage.md", import.meta.url).pathname;

function charterRoot(frontmatterExtra = "", body = "") {
  const r = mkdtempSync(join(tmpdir(), "charter-"));
  mkdirSync(join(r, ".factory"), { recursive: true });
  mkdirSync(join(r, "docs/factory"), { recursive: true });
  writeFileSync(join(r, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: ready\ntier_default: standard\n${frontmatterExtra}---\n${body}`);
  return r;
}

// --- 감사 M1: triage의 기본 판정은 기본값이 아니라 CHARTER가 적어 두는 선택이다 ---

test("loadCharter surfaces triage.default and leaves it undefined when the CHARTER never says", () => {
  expect(loadCharter(charterRoot("triage: { default: ready }\n")).triage.default).toBe("ready");
  expect(loadCharter(charterRoot("triage: { default: needs-info }\n")).triage.default).toBe("needs-info");
  // 기본값을 채우지 않는다 — 없는 것과 고른 것은 다른 사실이고, doctor가 그 둘을 가른다.
  expect(loadCharter(charterRoot()).triage.default).toBeUndefined();
  expect(TRIAGE_DEFAULT_VALUES).toEqual(["needs-info", "ready"]);
});

test("neverAutomateGlobs pulls only path-glob-shaped items out of the NEVER_AUTOMATE section", () => {
  const body = [
    "# Charter",
    "",
    "## NEVER_AUTOMATE (triage가 wont-do로 보냄)",
    "- `auth/**` 아래의 인증 흐름",
    "- 결제(`billing/**`)와 `package.json`의 `version` 필드",
    "- `harness.toml [protected]`를 바꾸는 변경",
    "- `.env*`, 시크릿",
    "",
    "## Definition of Done",
    "- `docs/**`는 여기 있어도 대상이 아니다",
  ].join("\n");
  expect(neverAutomateGlobs(body)).toEqual(["auth/**", "billing/**", ".env*"]);
  expect(neverAutomateGlobs("")).toEqual([]);
});

test("loadCharter carries the NEVER_AUTOMATE globs from the body, not just the frontmatter", () => {
  const r = charterRoot("", "## NEVER_AUTOMATE\n- `billing/**`\n");
  expect(loadCharter(r).never_automate).toEqual(["billing/**"]);
});

test("doctor: triage.default unset is a FAIL, needs-info a PASS, ready a stated WARN, garbage a FAIL", () => {
  expect(by(checkTriageDefault({ triage: { default: "needs-info" } }))["charter.triage-default"].level).toBe("PASS");
  const ready = by(checkTriageDefault({ triage: { default: "ready" } }))["triage.default-allow"];
  expect(ready.level).toBe("WARN");
  expect(ready.detail).toMatch(/ready/);
  for (const charter of [{}, { triage: {} }, { triage: { default: "" } }]) {
    expect(by(checkTriageDefault(charter))["charter.triage-default-unset"].level).toBe("FAIL");
  }
  expect(by(checkTriageDefault({ triage: { default: "yes-please" } }))["charter.triage-default-unset"].level).toBe("FAIL");
});

test("the template CHARTER stops on silence (needs-info); KTB's says ready out loud with a reason", () => {
  const tpl = readFileSync(TEMPLATE_CHARTER, "utf8");
  expect(/triage:\s*\{\s*default:\s*needs-info\s*\}/.test(tpl)).toBe(true);
  expect(tpl).toMatch(/charter\.triage-default-unset/);               // 지우면 FAIL이라는 사실이 주석에 있다
  const ktb = readFileSync(REPO_CHARTER, "utf8");
  expect(/triage:\s*\{\s*default:\s*ready\s*\}/.test(ktb).valueOf()).toBe(true);
  expect(ktb).toMatch(/## triage 기본 판정/);                          // 이유가 본문에 적혀 있다
});

test("the triage prompt reads the charter default and never invents `ready`", () => {
  const md = readFileSync(TRIAGE_AGENT, "utf8");
  expect(md).toMatch(/triage\.default/);
  expect(md).toMatch(/loaded\.triage\.default/);
  expect(md).toMatch(/\[ready\]/);                                    // 이슈가 직접 들고 오는 예외 표식
  expect(md).toMatch(/NEVER_AUTOMATE.*→\s*`wont-do`/);
  expect(md).toMatch(/done_when.*→\s*`needs-info`/);
});

test("triage context carries the charter's triage default and never-automate globs into loaded.json", async () => {
  const r = mkdtempSync(join(tmpdir(), "ctx-triage-"));
  mkdirSync(join(r, ".factory"), { recursive: true });
  mkdirSync(join(r, "docs/factory"), { recursive: true });
  writeFileSync(join(r, ".factory/harness.toml"), `schema = 1\n[harness]\nmaturity = "M0"\n[factory]\norchestration = "workflow"\n[commands]\nunit = "npm test"\n[gates]\nrequired = ["unit"]\nfast = ["unit"]\nfull = ["unit"]\ndeep = ["unit"]\n`);
  writeFileSync(join(r, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: ready\ntier_default: standard\ntriage: { default: needs-info }\nroster:\n  standard: [correctness]\n---\n## NEVER_AUTOMATE\n- \`billing/**\`\n`);
  writeFileSync(join(r, ".factory/roles.toml"), `[triage]\nagent = ".claude/agents/factory-triage.md"\nmodel = "sonnet"\n[review.correctness]\nagent = ".claude/agents/reviewer-correctness.md"\nmodel = "opus"\n`);
  const gh = { issue: vi.fn(async () => ({ number: 4, title: "T", body: "", labels: ["factory:queue"] })), comments: vi.fn(async () => []) };
  const ctx = await buildContext({ root: r, gh, issue: 4, stage: "triage" });
  expect(ctx.triage).toEqual({ default: "needs-info", never_automate: ["billing/**"] });
  expect(JSON.parse(readFileSync(join(r, ".factory/out/loaded.json"), "utf8")).triage).toEqual({ default: "needs-info", never_automate: ["billing/**"] });
});

// --- 감사 M1 (b): 글롭으로 적을 수 있는 NEVER_AUTOMATE 항목은 스크립트가 다시 센다 ---

test("neverAutomateHits matches the issue's impact paths against the charter globs", () => {
  const globs = ["auth/**", "billing/**", ".env*"];
  expect(neverAutomateHits(["src/app.js", "auth/session.js"], globs)).toEqual([{ path: "auth/session.js", glob: "auth/**" }]);
  expect(neverAutomateHits(["src/app.js"], globs)).toEqual([]);
  expect(neverAutomateHits(null, globs)).toEqual([]);
  expect(neverAutomateHits(["auth/x.js"], [])).toEqual([]);
});

test("verifyStage forces wont-do when an impact path hits a NEVER_AUTOMATE glob, whatever the agent said", () => {
  const out = { is_error: false, result: JSON.stringify({ schema: "factory.triage.v1", issue: 9, disposition: "ready", tier: "standard", impact_paths: ["billing/invoice.js"], reason: "small" }) };
  const v = verifyStage({ stage: "triage", out, agentsLog: { completed: [] }, neverAutomate: ["billing/**"] });
  expect(v.ok).toBe(true);
  expect(v.data.disposition).toBe("wont-do");
  expect(v.data.never_automate_hit).toEqual([{ path: "billing/invoice.js", glob: "billing/**" }]);
  expect(v.data.reason).toMatch(/NEVER_AUTOMATE/);
});

test("verifyStage leaves a clean triage verdict alone", () => {
  const out = { is_error: false, result: JSON.stringify({ schema: "factory.triage.v1", issue: 9, disposition: "ready", tier: "standard", impact_paths: ["src/app.js"] }) };
  const v = verifyStage({ stage: "triage", out, agentsLog: { completed: [] }, neverAutomate: ["billing/**"] });
  expect(v.data.disposition).toBe("ready");
  expect(v.data.never_automate_hit).toBeUndefined();
});
