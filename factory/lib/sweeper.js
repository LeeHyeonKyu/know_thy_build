import { applyPolicy } from "./quarantine.js";
const HB = /<!--\s*factory-heartbeat issue=(\d+)\s*-->[\s\S]*?last:\s*(\S+)/;
const RETRY = /<!--\s*factory-retry issue=(\d+) count=(\d+)\s*-->/;

export async function sweep({ gh, charter, thresholds, now, staleMinutes = 30, transition, release, quarantine, saveQuarantine, tokenIssuedAt = null }) {
  const actions = [];
  const nowMs = Date.parse(now);
  for (const it of await gh.searchIssues("factory:in-progress")) {
    try {
      const comments = await gh.comments(it.number);
      const hb = comments.map((c) => HB.exec(c.body)).filter(Boolean).at(-1);
      const last = hb ? Date.parse(hb[2]) : null;
      if (last && nowMs - last <= staleMinutes * 60e3) continue;
      await release(it.number);
      const prev = comments.map((c) => RETRY.exec(c.body)).filter(Boolean).at(-1);
      const count = (prev ? Number(prev[2]) : 0) + 1;
      await gh.comment(it.number, `<!-- factory-retry issue=${it.number} count=${count} -->\nheartbeat stale (${hb ? hb[2] : "none"}) — lock released, retry ${count}/${charter.limits.R}`);
      if (count <= charter.limits.R) { await transition({ issue: it.number, to: "factory:planned", reason: `sweeper requeue ${count}/${charter.limits.R}` }); actions.push({ kind: "requeue", issue: it.number, count }); }
      else { await transition({ issue: it.number, to: "factory:needs-human", reason: `retries exhausted (${count - 1}/${charter.limits.R})` }); actions.push({ kind: "retries-exhausted", issue: it.number }); }
    } catch (e) {
      actions.push({ kind: "error", issue: it.number, error: String(e.message || e) });
    }
  }
  for (const it of await gh.searchIssues("factory:blocked")) {
    try {
      await transition({ issue: it.number, to: "factory:needs-human", reason: "blocked (environment/credentials) — needs human" });
      actions.push({ kind: "blocked-escalated", issue: it.number });
    } catch (e) {
      actions.push({ kind: "error", issue: it.number, error: String(e.message || e) });
    }
  }
  try {
    const pol = applyPolicy(quarantine, { now, thresholds });
    if (pol.returned.length || pol.expired.length) { saveQuarantine(pol.q); actions.push({ kind: "quarantine", returned: pol.returned, expired: pol.expired }); }
  } catch (e) {
    actions.push({ kind: "error", step: "quarantine", error: String(e.message || e) });
  }
  try {
    if (tokenIssuedAt && nowMs - Date.parse(tokenIssuedAt) > 334 * 86400e3) {
      const open = await gh.searchIssues("factory:needs-human");
      if (!open.some((i) => /토큰 갱신/.test(i.title || ""))) { const n = await gh.createIssue({ title: "factory: 토큰 갱신 필요 (11개월 경과)", body: "`claude setup-token` 재실행 후 시크릿 CLAUDE_CODE_OAUTH_TOKEN을 교체하고 FACTORY_TOKEN_ISSUED_AT을 갱신하세요.", labels: ["factory:needs-human"] }); actions.push({ kind: "token-expiry", issue: n }); }
    }
  } catch (e) {
    actions.push({ kind: "error", step: "token-expiry", error: String(e.message || e) });
  }
  return actions;
}
