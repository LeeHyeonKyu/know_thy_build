import { mutationScore } from "./parsers/stryker-json.js";
import { parseMarkers } from "./parsers/marker.js";

export async function mutationGate({ run, cwd, harness, changedSources, readFile }) {
  const threshold = harness.gates.thresholds.mutation_score_pct;
  if (!changedSources?.length) return { ok: true, score: null, threshold, detail: "no changed sources" };
  const { mutation, mutation_report } = harness.commands.proof;
  if (!mutation) return { ok: false, misconfigured: true, threshold, detail: "commands.proof.mutation missing" };
  const r = await run("bash", ["-lc", mutation.replace("{files}", changedSources.join(","))], { cwd });
  let score = null, detail;
  const text = mutation_report ? readFile(`${cwd}/${mutation_report}`) : null;
  if (text) { const s = mutationScore(JSON.parse(text)); score = s.score; detail = `killed=${s.killed} timeout=${s.timeout} survived=${s.survived} noCoverage=${s.noCoverage}`; }
  else { const m = parseMarkers(r.stdout); if (m.MUTATION_SCORE != null) { score = Number(m.MUTATION_SCORE); detail = "from MUTATION_SCORE marker"; } }
  if (score == null) return { ok: false, threshold, detail: `no mutation score (exit ${r.code})`, command_code: r.code };
  return { ok: score >= threshold, score, threshold, detail, command_code: r.code };
}
