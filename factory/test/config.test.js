import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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

test("loadCharter throws when status != ready is requested strictly", () => {
  const root = fixture();
  const ch = loadCharter(root);
  expect(ch.status).toBe("ready");
});
