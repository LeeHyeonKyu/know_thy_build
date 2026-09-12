import { applyPolicy } from "./quarantine.js";
import { quarantineComment } from "./retro/quarantine-ops.js";
const HB = /<!--\s*factory-heartbeat issue=(\d+)\s*-->[\s\S]*?last:\s*(\S+)/;
const RETRY = /<!--\s*factory-retry issue=(\d+) count=(\d+)\s*-->/;

const FLAKY_LABEL = "factory:flaky";
const NOTE = {
  returned: "격리에서 복귀했습니다 — 연속 통과 임계를 넘겨 `quarantine.toml`에서 내렸습니다. 이제 이 테스트의 실패는 다시 게이트를 RED로 만듭니다.",
  expired: "격리 TTL을 넘겨 `quarantine.toml`에서 내렸습니다 — retro가 이 코멘트를 읽고 \"다른 레벨에서 다시 쓰라\"는 이슈를 만듭니다(§5.2.5-⑤).",
};

/**
 * 격리에서 내려간(복귀·만료) id마다 그 flaky 이슈(제목 `flaky: <id>`)에 마커 코멘트를 남긴다.
 * `quarantine.toml`은 현재 상태만 담으므로 항목이 내려가는 순간 그 사실은 어디에도 남지 않는다 —
 * 이력은 사람이 보는 이슈에 남아야 하고(§5.2.5-⑤), retro는 그 코멘트만으로 만료를 알 수 있다(P4-R3).
 * 전부 best-effort다: 이슈를 못 찾거나 코멘트가 실패해도 이미 끝난 정책 적용을 되돌리지 않고
 * actions에 흔적만 남긴다(sweeper는 절대 한 항목 때문에 통째로 죽지 않는다).
 */
async function commentOnQuarantineExit({ gh, actions, returned, expired }) {
  const groups = [["returned", returned], ["expired", expired]].filter(([, ids]) => ids.length);
  if (!groups.length) return;
  let issues;
  try {
    issues = await gh.searchIssues(FLAKY_LABEL);
  } catch (e) {
    actions.push({ kind: "error", step: "quarantine-comment", error: String(e.message || e) });
    return;
  }
  for (const [kind, ids] of groups) {
    for (const id of ids) {
      try {
        const it = issues.find((i) => String(i.title ?? "").trim() === `flaky: ${id}`);
        if (!it) { actions.push({ kind: "quarantine-comment-skipped", state: kind, id, reason: "no open flaky issue" }); continue; }
        await gh.comment(it.number, `${quarantineComment(kind, id)}\n${NOTE[kind]}`);
        actions.push({ kind: "quarantine-comment", state: kind, id, issue: it.number });
      } catch (e) {
        actions.push({ kind: "error", step: "quarantine-comment", id, error: String(e.message || e) });
      }
    }
  }
}

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
    if (pol.returned.length || pol.expired.length) {
      saveQuarantine(pol.q);
      actions.push({ kind: "quarantine", returned: pol.returned, expired: pol.expired });
      await commentOnQuarantineExit({ gh, actions, returned: pol.returned, expired: pol.expired });
    }
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
