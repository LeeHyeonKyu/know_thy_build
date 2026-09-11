import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadQuarantine, saveQuarantine, isQuarantined, recordResult, applyPolicy, overCap } from "../lib/quarantine.js";

const T = { quarantine_max: 2, quarantine_ttl_days: 28, quarantine_return_after: 3 };
const root = () => { const r = mkdtempSync(join(tmpdir(), "q-")); mkdirSync(join(r, ".factory")); return r; };

test("missing file → empty; save/load round-trip", () => {
  const r = root();
  expect(loadQuarantine(r)).toEqual({ quarantined: [] });
  const q = { quarantined: [{ id: "t::a", since: "2026-09-01T00:00:00Z", reason: "r", evidence: ["e"], consecutive_passes: 0 }] };
  saveQuarantine(r, q);
  expect(readFileSync(join(r, ".factory/quarantine.toml"), "utf8")).toMatch(/\[\[quarantined\]\]/);
  expect(loadQuarantine(r)).toEqual(q);
  expect(isQuarantined(q, "t::a")).toBe(true); expect(isQuarantined(q, "t::b")).toBe(false);
});

test("recordResult counts consecutive passes; applyPolicy returns after N and flags TTL", () => {
  let q = { quarantined: [
    { id: "t::a", since: "2026-09-01T00:00:00Z", reason: "r", evidence: [], consecutive_passes: 2 },
    { id: "t::old", since: "2026-08-01T00:00:00Z", reason: "r", evidence: [], consecutive_passes: 0 } ] };
  q = recordResult(q, "t::a", true);
  q = recordResult(q, "t::old", false);
  const { q: q2, returned, expired } = applyPolicy(q, { now: "2026-09-11T00:00:00Z", thresholds: T });
  expect(returned).toEqual(["t::a"]);
  expect(q2.quarantined.map((x) => x.id)).toEqual(["t::old"]);
  expect(expired).toEqual(["t::old"]);
  expect(overCap(q2, T)).toBe(false);
  expect(overCap({ quarantined: [{}, {}] }, T)).toBe(true);
});
