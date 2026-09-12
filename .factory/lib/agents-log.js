import { existsSync, readFileSync } from "node:fs";

/** Task 1(spike-9)의 관측에 맞춰 조정한다. 관측값이 frontmatter name과 같으면 항등. */
export function normalizeAgentType(raw) {
  return String(raw ?? "").trim();
}

export function readAgentsLog(path) {
  const empty = { starts: [], stops: [], completed: [], orphans: [] };
  if (!existsSync(path)) return empty;
  const starts = [], stops = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const rec = { agent_id: j.agent_id, agent_type: normalizeAgentType(j.agent_type) };
    if (j.hook_event_name === "SubagentStart") starts.push(rec);
    else if (j.hook_event_name === "SubagentStop") stops.push(rec);
  }
  const stopped = new Set(stops.map((s) => s.agent_id));
  const completed = starts.filter((s) => stopped.has(s.agent_id)).map((s) => s.agent_type);
  const orphans = starts.filter((s) => !stopped.has(s.agent_id)).map((s) => s.agent_type);
  return { starts, stops, completed, orphans };
}
