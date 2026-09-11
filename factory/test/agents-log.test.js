import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readAgentsLog, normalizeAgentType } from "../lib/agents-log.js";

test("pairs starts and stops by agent_id and lists completed agent types", () => {
  const dir = mkdtempSync(join(tmpdir(), "al-"));
  const p = join(dir, "agents.jsonl");
  writeFileSync(p, [
    JSON.stringify({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "reviewer-correctness" }),
    JSON.stringify({ hook_event_name: "SubagentStart", agent_id: "a2", agent_type: "reviewer-qa" }),
    JSON.stringify({ hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "reviewer-correctness" }),
    "not json",
    "",
  ].join("\n"));
  const log = readAgentsLog(p);
  expect(log.starts).toHaveLength(2);
  expect(log.completed).toEqual(["reviewer-correctness"]);
  expect(log.orphans).toEqual(["reviewer-qa"]);
});

test("missing file → empty log", () => {
  expect(readAgentsLog("/nonexistent/agents.jsonl")).toEqual({ starts: [], stops: [], completed: [], orphans: [] });
});

test("normalizeAgentType is identity for plain names (confirmed by spike-9: hook agent_type equals frontmatter name verbatim)", () => {
  expect(normalizeAgentType("reviewer-correctness")).toBe("reviewer-correctness");
});
