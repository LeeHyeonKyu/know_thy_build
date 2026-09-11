import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHarness, loadCharter, loadRoles, rosterFor } from "../lib/config.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ktb-"));
  mkdirSync(join(root, ".factory"), { recursive: true });
  mkdirSync(join(root, "docs/factory"), { recursive: true });
  writeFileSync(join(root, ".factory/harness.toml"), `schema = 1\n[harness]\nmaturity = "M1"\n[factory]\norchestration = "workflow"\n[commands]\nlint = "npm run lint"\nunit = "npm test"\n[gates]\nrequired = ["lint","unit"]\nfast = ["lint","unit"]\nfull = ["lint","unit"]\ndeep = ["lint","unit"]\n`);
  writeFileSync(join(root, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: ready\ntier_default: standard\nlimits: { K: 3, M: 3, R: 2 }\nroster:\n  docs: [correctness, spec-conformance]\n  standard: [correctness, architecture, spec-conformance, qa]\n  load-bearing: [correctness, security, architecture, spec-conformance, qa]\nplan_roles:\n  docs: [architect, skeptic]\n  default: [product-advocate, architect, skeptic, operator]\nplan_rounds: { docs: 2, default: 3 }\nback_pressure: { awaiting_review_max: 4, quarantine_max: 5 }\nbudget: {}\n---\n# Charter\n`);
  writeFileSync(join(root, ".factory/roles.toml"), `schema = 1\n[review.correctness]\nagent = ".claude/agents/reviewer-correctness.md"\n[review.security]\nagent = ".claude/agents/reviewer-security.md"\n[review.architecture]\nagent = "x"\n[review.spec-conformance]\nagent = "x"\n[review.qa]\nagent = "x"\n[plan.architect]\nagent = "x"\n[plan.skeptic]\nagent = "x"\n[plan.product-advocate]\nagent = "x"\n[plan.operator]\nagent = "x"\n`);
  return root;
}

test("loads harness.toml, CHARTER frontmatter, roles.toml", () => {
  const root = fixture();
  expect(loadHarness(root).harness.maturity).toBe("M1");
  expect(loadHarness(root).factory.orchestration).toBe("workflow");
  const ch = loadCharter(root);
  expect(ch.status).toBe("ready");
  expect(ch.limits.K).toBe(3);
  expect(loadRoles(root).review.security.agent).toContain("security");
});

test("rosterFor: review roster by tier must exist in roles.toml; plan roster by tier", () => {
  const root = fixture();
  const ch = loadCharter(root), roles = loadRoles(root);
  expect(rosterFor(ch, roles, "review", "docs")).toEqual(["correctness", "spec-conformance"]);
  expect(rosterFor(ch, roles, "review", "load-bearing")).toHaveLength(5);
  expect(rosterFor(ch, roles, "plan", "docs")).toEqual(["architect", "skeptic"]);
  expect(rosterFor(ch, roles, "plan", "standard")).toEqual(["product-advocate", "architect", "skeptic", "operator"]);
  expect(() => rosterFor({ ...ch, roster: { docs: ["ghost"] } }, roles, "review", "docs")).toThrow(/not defined in roles.toml: ghost/);
});

test("loadCharter reports status verbatim (dormancy는 호출자가 판단한다)", () => {
  const root = fixture();
  expect(loadCharter(root).status).toBe("ready");
  writeFileSync(join(root, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: draft\n---\n`);
  expect(loadCharter(root).status).toBe("draft");
  writeFileSync(join(root, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\n---\n`);
  expect(loadCharter(root).status).toBe("draft");                       // 기본값
  writeFileSync(join(root, "docs/factory/CHARTER.md"), `---\nschema: nope.v1\n---\n`);
  expect(() => loadCharter(root)).toThrow(/factory.charter.v1/);
});

test("limits는 부분 오버라이드를 받는다 — 빠진 키는 기본값으로 채운다", () => {
  const root = fixture();
  writeFileSync(join(root, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: ready\nlimits: { K: 5 }\n---\n`);
  expect(loadCharter(root).limits).toEqual({ K: 5, M: 3, R: 2 });
});

test("loadHarness fills gates.thresholds / test / commands.proof defaults and keeps overrides", () => {
  const root = fixture();
  const h = loadHarness(root);
  expect(h.gates.thresholds).toEqual({ diff_coverage_pct: 90, mutation_score_pct: 70, new_test_repeats: 3, flaky_isolation_runs: 3, flaky_base_runs: 5, quarantine_max: 5, quarantine_ttl_days: 28, quarantine_return_after: 30 });
  expect(h.test.unit_report).toBe(".factory/out/unit.json");
  expect(h.test.test_glob).toEqual([]);
  expect(h.commands.proof).toEqual({});
  writeFileSync(join(root, ".factory/harness.toml"), readFileSync(join(root, ".factory/harness.toml"), "utf8") + `\n[gates.thresholds]\ndiff_coverage_pct = 80\n[test]\ntest_glob = ["test/**/*.test.js"]\n`);
  const h2 = loadHarness(root);
  expect(h2.gates.thresholds.diff_coverage_pct).toBe(80);
  expect(h2.gates.thresholds.mutation_score_pct).toBe(70);
  expect(h2.test.test_glob).toEqual(["test/**/*.test.js"]);
});
