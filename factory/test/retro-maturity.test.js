import { test, expect } from "vitest";
import { detectMaturityGaps } from "../lib/retro/maturity.js";

const harnessAt = (maturity, fakes = {}) => ({ harness: { maturity }, test: { fakes } });

test("(a) known external SDK in manifest without a matching [test.fakes] key → sdk-without-fake, target = current maturity (no promotion)", () => {
  const gaps = detectMaturityGaps({ files: [], harness: harnessAt("M1"), manifestDeps: ["stripe", "lodash"] });
  expect(gaps).toEqual([{ target: "M1", rule: "sdk-without-fake", reason: "manifest declares external SDK(s) without [test.fakes] entry: stripe" }]);
});

test("(a) scoped wildcard SDKs match by prefix; a matching fake key (exact or unscoped short name) satisfies the rule", () => {
  const gaps = detectMaturityGaps({
    files: [],
    harness: harnessAt("M0", { "@slack/web-api": "fake:slack" }),
    manifestDeps: ["@slack/web-api", "@aws-sdk/client-s3"],
  });
  expect(gaps).toEqual([{ target: "M0", rule: "sdk-without-fake", reason: "manifest declares external SDK(s) without [test.fakes] entry: @aws-sdk/client-s3" }]);
});

test("(a) unscoped short-name fake key also satisfies the rule", () => {
  const gaps = detectMaturityGaps({ files: [], harness: harnessAt("M0", { "client-s3": "fake:s3" }), manifestDeps: ["@aws-sdk/client-s3"] });
  expect(gaps).toEqual([]);
});

test("(a) no known SDKs in manifest → no gap", () => {
  expect(detectMaturityGaps({ files: [], harness: harnessAt("M2"), manifestDeps: ["lodash", "react"] })).toEqual([]);
});

test("(b) schema files present at M0 → db-schema-at-m0, target M1", () => {
  const gaps = detectMaturityGaps({ files: ["prisma/schema.prisma", "src/index.js"], harness: harnessAt("M0"), manifestDeps: [] });
  expect(gaps).toEqual([{ target: "M1", rule: "db-schema-at-m0", reason: "DB schema files present (prisma/migrations/sql) but harness maturity is M0" }]);
});

test("(b) migrations dir and *.sql also trigger; not at M0 → skipped", () => {
  expect(detectMaturityGaps({ files: ["db/migrations/0001_init.sql"], harness: harnessAt("M0"), manifestDeps: [] }).map((g) => g.rule)).toEqual(["db-schema-at-m0"]);
  expect(detectMaturityGaps({ files: ["schema.sql"], harness: harnessAt("M1"), manifestDeps: [] })).toEqual([]);
});

test("(c) HTTP surface files + a web framework dep at M1 or below → http-at-m1, target M2", () => {
  const gaps = detectMaturityGaps({ files: ["src/routes/users.js"], harness: harnessAt("M1"), manifestDeps: ["express"] });
  expect(gaps).toEqual([{ target: "M2", rule: "http-at-m1", reason: "HTTP route surface present (express/fastify/hono/koa/next) but harness maturity is M1 or below" }]);
});

test("(c) requires both the file pattern and the framework dep — either alone is not enough", () => {
  expect(detectMaturityGaps({ files: ["src/routes/users.js"], harness: harnessAt("M0"), manifestDeps: [] })).toEqual([]);
  expect(detectMaturityGaps({ files: ["src/index.js"], harness: harnessAt("M0"), manifestDeps: ["fastify"] })).toEqual([]);
});

test("(c) already at M2 → skipped (already at/above target)", () => {
  expect(detectMaturityGaps({ files: ["api/server.js"], harness: harnessAt("M2"), manifestDeps: ["koa"] })).toEqual([]);
});

test("all three rules can fire together with distinct targets, order a→b→c", () => {
  const gaps = detectMaturityGaps({
    files: ["prisma/schema.prisma", "src/api/users.js"],
    harness: harnessAt("M0"),
    manifestDeps: ["stripe", "next"],
  });
  expect(gaps).toEqual([
    { target: "M0", rule: "sdk-without-fake", reason: "manifest declares external SDK(s) without [test.fakes] entry: stripe" },
    { target: "M1", rule: "db-schema-at-m0", reason: "DB schema files present (prisma/migrations/sql) but harness maturity is M0" },
    { target: "M2", rule: "http-at-m1", reason: "HTTP route surface present (express/fastify/hono/koa/next) but harness maturity is M1 or below" },
  ]);
});

test("dedupe by target: two sdk-without-fake candidates would share target=current maturity — only one gap is returned", () => {
  const gaps = detectMaturityGaps({ files: [], harness: harnessAt("M0"), manifestDeps: ["stripe", "twilio"] });
  expect(gaps).toHaveLength(1);
  expect(gaps[0].target).toBe("M0");
  expect(gaps[0].reason).toContain("stripe");
  expect(gaps[0].reason).toContain("twilio");
});

test("no files, no manifest deps, M0 → empty", () => {
  expect(detectMaturityGaps({ files: [], harness: harnessAt("M0"), manifestDeps: [] })).toEqual([]);
});

test("defaults: missing harness/manifestDeps do not throw and maturity defaults to M0", () => {
  expect(detectMaturityGaps({ files: ["prisma/schema.prisma"] })).toEqual([
    { target: "M1", rule: "db-schema-at-m0", reason: "DB schema files present (prisma/migrations/sql) but harness maturity is M0" },
  ]);
});
