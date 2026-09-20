#!/usr/bin/env node
// 주기 건강 잡(spec §5 신호 · §7 파생 보고서 · 플랜 Task 4) — 라벨 상태 머신 밖에서 **일정으로만**
// 깨어난다. 회고가 "이번 머지가 무엇을 드러냈는가"라면, 이 잡은 "최근 N개 머지에 걸쳐 공장 자신이
// 어떻게 **행동했는가**"를 묻는다. 둘은 창이 다르다: 한 이슈의 증거로는 rubber-stamp도 dead debate도
// 비용 낭비도 판정할 수 없다.
//
// ## 이 파일의 유일한 규율 — **짝 없는 신호는 발견이 되지 않는다**
// Global Constraint이자 spec §5다. 셋 다 혼자서는 아무 뜻이 없다:
//   승인률 100%      — 도장을 찍은 것인가, 이슈가 쉬웠던 것인가?   → **귀속된 escaped 결함**과 짝짓는다
//   토론 라운드 수    — 깊었던 것인가, 길기만 했던 것인가?         → **계획이 바뀌었는가**와 짝짓는다
//   비용 $80         — 비싼 것인가, 값어치를 한 것인가?           → **diff의 실효 tier**와 짝짓는다
// 짝의 한쪽만 들고 이슈를 열면 그 지표는 그 순간 Goodhart의 표적이 된다 — 리뷰어는 거절률을 채우려
// 거절하고, 토론은 길이를 채우려 길어진다. 그래서 `classifyFinding`은 `paired: true`를 **호출자의
// 단언**으로 요구하고, 이 파일이 그 단언을 세우는 유일한 자리다. 단언할 수 없으면 신호는 보고서의
// 한 줄로만 남는다(재지 않는 것과 판정하지 않는 것은 다르다 — 둘을 섞으면 추세가 사라진다).
//
// ## N 미만이면 아무것도 방출하지 않는다
// 표본이 N(기본 5, spec §10 Q3 — ADR-026의 표본 크기)에 못 미치면 **발견을 하나도 만들지 않는다.**
// 보고서는 그대로 나간다: "표본이 모자라다"는 것 자체가 주인이 읽어야 할 상태다.
//
// ## 라우팅은 재구현하지 않는다
// 행동 발견도 다른 발견과 **같은 팔**(`routeFindings`, Task 3)을 탄다 — 분류·지문·dedupe·fail-safe가
// 전부 거기 한 번만 쓰여 있어야 한다. 이 파일이 하는 일은 발견을 **만드는 것**까지다.
//
// 모든 외부 접촉은 인자로 주입된다 — `runHealth`는 순수 오케스트레이션이고 `main()`이 조립한다.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { loadCharter, loadHarness, loadRoles, upstreamRepoOf } from "../lib/config.js";
import { HEALTH_LABEL } from "../lib/label-catalog.js";
import { routeFindings } from "../lib/feedback/route.js";
import { loadInstallManifest, INSTALL_MANIFEST_PATH } from "../lib/feedback/install-manifest.js";
import { parseHandoffs } from "../lib/handoff.js";
import { parseRunRecord } from "../lib/usage.js";
import { aggregateRoleSignals, isMerged, planDebateDelta, roleSignalsFor } from "../lib/retro/harvest.js";
import { afterSince } from "../lib/retro/issue-comments.js";
import { recordedRehearsal, rehearsalGate, rehearsalHash, FINGERPRINT_PATHS } from "../lib/rehearsal.js";
import { roleFileMap } from "./retro.js";

/** spec §10 Q3 — 행동 발견 이전의 최소 표본. ADR-026이 쓰는 것과 같은 수다. */
export const DEFAULT_N = 5;

/**
 * tier를 **위험 순서**로 세운 것(`lib/labels.js`의 `TIERS`와 같은 어휘, 여기서는 순서가 뜻을 갖는다).
 * 기준선 계산이 "이 tier보다 위험한 것들"을 골라내는 데 이 순서를 쓴다.
 */
export const RISK_ORDER = ["docs", "standard", "load-bearing"];
const riskOf = (tier) => RISK_ORDER.indexOf(String(tier ?? ""));

const round2 = (n) => Math.round(n * 100) / 100;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : round2((s[m - 1] + s[m]) / 2);
};

/**
 * `costBaselineFor(tier, perIssue) → number|null` — **그 tier의 비용 기준선**.
 *
 * 상수를 박지 않는다. 기준선은 이 창 안에서 **더 위험한 tier들이 실제로 쓴 비용의 중앙값**이다.
 * 그러면 규칙 한 줄이 곧 "비용 대 위험"이 된다: *가장 낮은 위험의 일이, 더 높은 위험의 일이 쓴
 * 만큼을 썼다.* 저장소마다 모델·패널·코드베이스 크기가 다르므로 절대 달러값은 어차피 남의 숫자이고
 * (KTB의 $20이 다른 저장소에서는 $2다), 창이 움직이면 기준선도 저절로 따라 움직인다.
 *
 * 더 위험한 tier가 창에 **하나도 없으면 `null`이다** — 비교할 것이 없으면 기준선도 없고, 기준선이
 * 없으면 발견도 없다. 전부 docs인 창에서 "docs치고 비싸다"는 말은 짝 없는 비용일 뿐이다.
 */
export function costBaselineFor(tier, perIssue = []) {
  const r = riskOf(tier);
  if (r < 0) return null;
  const higher = (perIssue || []).filter((x) => riskOf(x.tier) > r && Number.isFinite(x.cost)).map((x) => x.cost);
  return higher.length ? median(higher) : null;
}

/** 이 이슈의 run 기록이 말하는 총비용(스테이지 전부 합). 기록이 없으면 0이 아니라 null이다. */
function costOfRecord(text) {
  const entries = parseRunRecord(String(text ?? ""));
  if (!entries.length) return { total: null, by_stage: {} };
  let total = 0;
  let seen = false;
  const byStage = {};
  for (const e of entries) {
    if (e.cost_usd == null) continue;
    seen = true;
    total += e.cost_usd;
    byStage[e.stage] = round2((byStage[e.stage] || 0) + e.cost_usd);
  }
  return { total: seen ? round2(total) : null, by_stage: byStage };
}

/**
 * 이 이슈의 실효 tier — **러너가 계산한 사실**을 1순위로 읽는다(감사 H3):
 *   ① 리뷰 핸드오프의 `tier_effective`(diff에서 나온 값, `roleSignalsFor`가 실어 준다)
 *   ② 이슈의 `factory:tier-*` 라벨(triage의 판정)
 * 에이전트가 산문으로 적은 것은 읽지 않는다 — 책임 판정은 에이전트가 쓸 수 있는 채널에 앵커하지 않는다.
 */
function tierOf(issue, signals) {
  if (signals?.tier) return signals.tier;
  for (const l of Array.isArray(issue?.labels) ? issue.labels : []) {
    const name = typeof l === "string" ? l : l?.name;
    const m = /^factory:tier-(.+)$/.exec(String(name ?? ""));
    if (m && riskOf(m[1]) >= 0) return m[1];
  }
  return null;
}

const ROSTER_PATH = ".factory/lib/review-roster.js";
const ROLES_PATH = ".factory/roles.toml";

/**
 * 창 하나를 신호로 바꾼다 — 순수 함수다(gh도 fs도 만지지 않는다). 발견을 만드는 규칙과, 그 규칙이
 * 읽는 숫자를 한 자리에 둔다: 보고서가 보여 주는 표와 발견이 선 근거가 **같은 객체**여야 한다.
 */
export function healthSignals({ issues = [], commentsByIssue = new Map(), records = new Map(), N = DEFAULT_N } = {}) {
  const byIssue = commentsByIssue instanceof Map ? commentsByIssue : new Map(Object.entries(commentsByIssue || {}));
  const recs = records instanceof Map ? records : new Map(Object.entries(records || {}));

  const perIssue = [];
  for (const issue of issues || []) {
    const comments = byIssue.get(issue.number) || [];
    if (!isMerged(issue, comments)) continue;
    const handoffs = parseHandoffs(comments);
    const sig = roleSignalsFor(handoffs);
    const debate = planDebateDelta(handoffs);
    const cost = costOfRecord(recs.get(String(issue.number)) ?? recs.get(issue.number) ?? "");
    perIssue.push({
      issue: issue.number, closedAt: issue.closedAt,
      tier: tierOf(issue, sig), panel: sig.panel, rounds: sig.rounds,
      cost: cost.total, cost_by_stage: cost.by_stage,
      roles: sig.roles, escaped: sig.escaped_total, debate,
    });
  }
  // 최신 N개(머지 시각 내림차순)가 창이다 — "최근 N개 머지"가 이 잡의 스코프다.
  perIssue.sort((a, b) => (Date.parse(b.closedAt) || 0) - (Date.parse(a.closedAt) || 0));
  const window = perIssue.slice(0, N);

  const roles = aggregateRoleSignals(window);
  const fullPanel = window.reduce((mx, x) => Math.max(mx, x.panel || 0), 0);

  const costByTier = {};
  const costByRole = {};
  for (const x of window) {
    if (x.cost == null) continue;
    if (x.tier) costByTier[x.tier] = round2((costByTier[x.tier] || 0) + x.cost);
    /**
     * `cost_by_role`은 **측정이 아니라 배분**이다 — run 기록의 비용은 스테이지 단위이고(`usage:` 줄
     * 하나가 한 스테이지의 런 전부다), 역할 하나가 얼마를 썼는지는 아무도 기록하지 않는다. 그래서
     * 리뷰 스테이지 비용을 그 이슈의 패널 크기로 **균등 분배**한다. 이 값은 보고서의 참고 열일 뿐
     * 어떤 발견의 방아쇠도 아니다(waste 판정은 `cost_vs_risk`가 하고, 그쪽은 이슈 총비용을 쓴다) —
     * 추정을 판정의 근거로 쓰지 않는다는 뜻이다.
     */
    const reviewCost = x.cost_by_stage?.review;
    const names = Object.keys(x.roles || {});
    if (reviewCost != null && names.length) {
      const each = reviewCost / names.length;
      for (const r of names) costByRole[r] = round2((costByRole[r] || 0) + each);
    }
  }

  const costVsRisk = window
    .filter((x) => x.cost != null && x.tier)
    .map((x) => ({ issue: x.issue, tier: x.tier, panel: x.panel, cost: x.cost, baseline: costBaselineFor(x.tier, window.filter((y) => y.cost != null && y.tier)) }));

  return {
    N,
    merged: perIssue.length,
    window: window.map((x) => x.issue),
    below_n: window.length < N,
    per_issue: window,
    roles,
    full_panel: fullPanel,
    rounds_per_issue: window.map((x) => ({ issue: x.issue, review: x.rounds })),
    escaped_defects: window.reduce((n, x) => n + x.escaped, 0),
    debate: {
      measured: window.filter((x) => x.debate.plan_handoffs > 0).length,
      changed: window.filter((x) => x.debate.changed).length,
      per_issue: window.map((x) => ({ issue: x.issue, ...x.debate })),
    },
    cost_by_tier: costByTier,
    cost_by_role: costByRole,
    cost_vs_risk: costVsRisk,
  };
}

/**
 * 신호 → **행동 발견**. 규칙 셋 각각이 짝의 양쪽을 모두 손에 쥔 채로만 발견을 만든다.
 * 발견 하나하나가 `paired: true`를 달고 나가고, 그 단언의 근거가 `reason` 본문에 **숫자로** 박힌다
 * (이슈를 읽는 사람이 "왜 이게 발견인가"를 본문만으로 재구성할 수 있어야 한다 — T6의 계약).
 */
export function behaviouralFindings({ signals, repo, roleFile = new Map(), anchorIssue = null }) {
  const out = [];
  if (signals.below_n) return out;                     // N 미만: 규칙을 아예 돌리지 않는다
  const at = (role) => roleFile.get?.(role) || `.claude/agents/reviewer-${role}.md`;

  // ① rubber-stamp — 100% 승인(정수 비교) **그리고** 귀속된 escaped 결함 ≥ 1.
  for (const [role, r] of Object.entries(signals.roles || {})) {
    if (!r.verdicts || r.approves !== r.verdicts) continue;        // 한 번이라도 거절했으면 도장이 아니다
    if (!(r.escaped_defects >= 1)) continue;                       // 짝이 없다 — 판정하지 않는다
    out.push({
      signal: "rubber-stamp", kind: "behavioural", paired: true,
      issue: anchorIssue, repo, stage: "review", role,
      causal_path: at(role),
      reason: `role \`${role}\` approved ${r.approves}/${r.verdicts} verdicts across the last ${signals.N} merged issues (never rejected once) `
        + `while ${r.escaped_defects} defect(s) it had already approved were found in a LATER review round — `
        + `an approval that never withholds and is followed by escaped defects is not a review, it is a rubber stamp. `
        + `Paired evidence: approve_rate ${r.approve_rate} × escaped_defects ${r.escaped_defects} (issues ${signals.window.join(", ")}).`,
      extra: { chain: (signals.per_issue || []).filter((x) => x.roles?.[role]?.escaped).map((x) => `#${x.issue}: ${x.roles[role].escaped} escaped after approval`) },
    });
  }

  // ② dead debate — N개 **전부**에서 토론이 계획을 한 번도 바꾸지 않았다.
  const measured = (signals.debate?.per_issue || []).filter((x) => x.plan_handoffs > 0);
  if (measured.length >= signals.N && measured.every((x) => !x.changed)) {
    out.push({
      signal: "dead-debate", kind: "behavioural", paired: true,
      issue: anchorIssue, repo, stage: "plan",
      causal_path: roleFile.get?.("skeptic") || ".claude/agents/plan-skeptic.md",
      reason: `the plan debate changed nothing in ${measured.length}/${signals.N} of the last merged issues: `
        + `no done_when was added and no dissent was resolved (every dissent was left unresolved or deferred). `
        + `Paired evidence: the debate ran on every one of these issues and its outcome delta was zero — `
        + `length without delta is cost without review (issues ${measured.map((x) => `#${x.issue}`).join(", ")}).`,
      extra: { chain: measured.map((x) => `#${x.issue}: ${x.plan_handoffs} plan handoff(s), done_when +${x.done_when_added}, dissent resolved ${x.dissent_resolved}`) },
    });
  }

  // ③ cost vs risk — 가장 낮은 위험(docs)의 diff가 **전체 패널**에 올라가 기준선을 넘겼다.
  for (const x of signals.cost_vs_risk || []) {
    if (x.tier !== RISK_ORDER[0]) continue;                        // 규칙은 가장 낮은 위험에만 건다
    if (!signals.full_panel || x.panel < signals.full_panel) continue;  // 전체 패널이 아니면 낭비가 아니다
    if (x.baseline == null || !(x.cost > x.baseline)) continue;    // 기준선이 없거나 넘지 않았다
    out.push({
      signal: "cost-vs-risk", kind: "behavioural", paired: true,
      issue: x.issue, repo, stage: "review",
      causal_path: ROSTER_PATH,
      reason: `issue #${x.issue} resolved to tier \`${x.tier}\` — the lowest risk the factory grades — yet it ran the FULL ${x.panel}-role review panel `
        + `and cost $${x.cost}, above the $${x.baseline} baseline (the median cost of the higher-risk issues in this window). `
        + `Paired evidence: cost $${x.cost} × risk \`${x.tier}\` — a docs-shaped diff bought the review depth of load-bearing work. `
        + `The roster resolved for this tier is the cause, not the reviewers.`,
      extra: {
        cost: { usd: x.cost, baseline: x.baseline },
        chain: [`#${x.issue}: tier ${x.tier}, panel ${x.panel}/${signals.full_panel}, cost $${x.cost} vs baseline $${x.baseline}`],
      },
    });
  }
  return out;
}

const pct = (v) => (v == null ? "n/a" : `${Math.round(v * 100)}%`);
const usd = (v) => (v == null ? "n/a" : `$${v}`);

/**
 * 파생 보고서(spec §7) — 주인이 읽는 "대화"다. 원시 덤프가 아니라 **판정과 그 근거**를 같은 표에
 * 나란히 둔다: 짝의 양쪽이 한 줄에 보이지 않으면 사람도 Goodhart를 피할 수 없다.
 */
export function renderHealthReport({ signals, findings = [], rehearsal = null, now, repo, upstream = null }) {
  const L = [];
  L.push(`<!-- factory-health:v1 -->`);
  L.push(`## factory-health — ${String(now).slice(0, 10)}`);
  L.push("");
  L.push(signals.below_n
    ? `**표본 미달**: 머지된 이슈 ${signals.window.length}/${signals.N}. 행동 발견은 하나도 내지 않습니다 — 승인률도 토론도 비용도 이 표본에서는 판정할 수 없습니다(spec §10 Q3).`
    : `최근 머지 ${signals.window.length}개(${signals.window.map((n) => `#${n}`).join(", ")})를 봤습니다. 아래 표의 **모든 판정은 짝이 있는 신호**에서만 나옵니다(spec §5).`);
  L.push("");

  L.push("### 역할 — 승인률 × 귀속된 escaped 결함");
  L.push("");
  L.push("| role | verdicts | approve_rate | must_fix | ever_rejects | flips | escaped(귀속) |");
  L.push("|---|---:|---:|---:|:--:|---:|---:|");
  const roles = Object.entries(signals.roles || {}).sort((a, b) => b[1].verdicts - a[1].verdicts);
  if (!roles.length) L.push("| _(리뷰 판정 기록 없음)_ | | | | | | |");
  for (const [name, r] of roles) {
    L.push(`| \`${name}\` | ${r.verdicts} | ${pct(r.approve_rate)} | ${r.must_fix_count} | ${r.ever_rejects ? "예" : "**아니오**"} | ${r.flips} | ${r.escaped_defects} |`);
  }
  L.push("");
  L.push("> `escaped(귀속)`은 **그 역할이 이미 승인해 둔 뒤 더 나중 라운드에서 잡힌** must_fix 수입니다. 그 결함을 스스로 찾아내 판정을 뒤집은 역할에게는 귀속되지 않습니다. 승인률 100%는 이 열이 0이면 아무 뜻도 없습니다 — 쉬운 이슈였을 뿐일 수 있습니다.");
  L.push("");

  L.push("### 계획 토론 — 길이가 아니라 delta");
  L.push("");
  L.push(`토론이 측정된 이슈 ${signals.debate.measured}개 중 **계획을 실제로 바꾼 것 ${signals.debate.changed}개**.`);
  L.push("");
  L.push("| issue | plan handoffs | done_when 추가 | dissent 해소 | 바꿨나 |");
  L.push("|---|---:|---:|---:|:--:|");
  for (const d of signals.debate.per_issue || []) {
    L.push(`| #${d.issue} | ${d.plan_handoffs} | ${d.done_when_added} | ${d.dissent_resolved} | ${d.changed ? "예" : "아니오"} |`);
  }
  L.push("");

  L.push("### 비용 대 위험");
  L.push("");
  L.push(`tier별: ${Object.entries(signals.cost_by_tier).map(([t, c]) => `\`${t}\` ${usd(c)}`).join(" · ") || "n/a"}`);
  L.push("");
  L.push(`역할별(리뷰 스테이지 비용의 **균등 배분** — 측정이 아니라 참고값): ${Object.entries(signals.cost_by_role).map(([t, c]) => `\`${t}\` ${usd(c)}`).join(" · ") || "n/a"}`);
  L.push("");
  L.push("| issue | tier(실효) | panel | cost | 기준선(더 위험한 tier의 중앙값) |");
  L.push("|---|---|---:|---:|---:|");
  for (const x of signals.cost_vs_risk || []) {
    L.push(`| #${x.issue} | \`${x.tier}\` | ${x.panel}/${signals.full_panel} | ${usd(x.cost)} | ${usd(x.baseline)} |`);
  }
  L.push("");

  // 리허설은 **저장소 수준의 사실**이지 이슈별 증거가 아니다(T3: 리허설 RED는 per-issue durable 줄이
  // 없다). 그래서 건강 줄로만 싣고 발견으로 만들지 않는다 — 귀속할 이슈가 없는 것에는 주인도 없다.
  L.push("### 리허설 기록 (저장소 수준 — 판정이 아니라 상태)");
  L.push("");
  if (!rehearsal) L.push("- rehearsal: 확인하지 못했습니다.");
  else if (rehearsal.ok) L.push(`- rehearsal: GREEN이 기록돼 있습니다 (출처: \`${rehearsal.source}\`) — 큐가 열려 있습니다.`);
  else L.push(`- rehearsal: **기록이 현재 하네스와 맞지 않습니다** — ${rehearsal.reason}`);
  L.push("");
  L.push("> 리허설 RED는 이슈 하나에 귀속되는 증거가 아니라 저장소의 현재 상태입니다. 그래서 행동 발견으로 올리지 않고 이 줄로만 보고합니다.");
  L.push("");

  L.push("### 이번 회차의 발견");
  L.push("");
  if (!findings.length) {
    L.push(signals.below_n
      ? "- 없습니다(표본 미달)."
      : "- 없습니다. 짝이 선 신호 중 규칙을 넘긴 것이 없습니다 — 침묵이 정상 상태입니다.");
  }
  for (const f of findings) {
    L.push(`- **${f.signal}**${f.role ? ` \`${f.role}\`` : ""}${f.issue ? ` (#${f.issue})` : ""} — ${f.reason}`);
  }
  L.push("");
  L.push(`<sub>이 보고서는 기록에서 **파생**됐습니다(원시 덤프가 아닙니다). 발견은 ${upstream ? `\`${upstream}\`의 factory-improvement 이슈` : "이 저장소의 코멘트"}로 라우팅됩니다 — 루프는 이슈를 열 뿐 KTB도 하네스도 스스로 고치지 않습니다.</sub>`);
  return L.join("\n");
}

const HEALTH_TITLE = "factory-health — 공장 자신의 행동 지표";

/**
 * `runHealth({ gh, root, since, N }) → { ok, below_n, signals, findings, classified, actions, report, report_issue }`
 *
 * 보고서가 **먼저** 착지하고 라우팅이 그 이슈를 앵커로 쓴다. 순서가 뒤집히면 안 되는 이유가 있다:
 * T3의 팔은 출처 이슈에 라우팅 영수증(`routedMarker`)을 남기고 **그 마커로 멱등을 지킨다**. 주간으로
 * 도는 잡이 앵커를 매번 새로 만들면 같은 지문이 매주 상류에 새 이슈를 연다 — 하나의 오래 사는
 * `factory:health` 이슈가 앵커여야 그 dedupe가 성립한다.
 */
export async function runHealth({
  gh, root = ".", repo = null, since = null, N = DEFAULT_N, now = new Date().toISOString(),
  issues = null, commentsByIssue = null, records = null,
  harness = null, manifest = null, roleFile = new Map(), upstream = null,
  rehearsal = null, route = routeFindings, publish = true,
} = {}) {
  const actions = [];
  const loaded = await collect({ gh, issues, commentsByIssue, records, since });
  const signals = healthSignals({ ...loaded, N });

  // 보고서를 실을 **오래 사는** 이슈 하나. 없으면 연다(그 자리가 곧 "대화"다).
  let reportIssue = null;
  const report = renderHealthReport({ signals, findings: [], rehearsal, now, repo, upstream });
  if (publish) {
    try {
      const open = await gh.issueList({ labels: [HEALTH_LABEL], state: "open" });
      reportIssue = open?.[0]?.number ?? null;
    } catch (e) { actions.push({ kind: "error", step: "health", reason: `could not list the health issue — ${e?.message || e}` }); }
  }

  const findings = behaviouralFindings({ signals, repo, roleFile, anchorIssue: reportIssue });

  // 보고서에 이번 회차의 발견까지 실어 다시 렌더한다 — 사람이 한 화면에서 표와 판정을 같이 본다.
  const body = renderHealthReport({ signals, findings, rehearsal, now, repo, upstream });
  if (publish) {
    try {
      if (reportIssue == null) {
        reportIssue = await gh.createIssue({ title: HEALTH_TITLE, body, labels: [HEALTH_LABEL] });
        actions.push({ kind: "health-issue", step: "health", issue: reportIssue, created: true });
      } else {
        await gh.comment(reportIssue, body);
        actions.push({ kind: "health-report", step: "health", issue: reportIssue, created: false });
      }
    } catch (e) { actions.push({ kind: "error", step: "health", reason: `could not publish the health report — ${e?.message || e}` }); }
  }

  // 발견을 만들었으면 **Task 3의 팔**로 보낸다(분류·지문·dedupe·fail-safe는 전부 거기에 있다).
  let classified = [];
  if (findings.length && manifest) {
    const anchored = findings.map((f) => ({ ...f, issue: f.issue ?? reportIssue }));
    let existing = [];
    if (reportIssue != null) {
      try { existing = await gh.comments(reportIssue); } catch { /* 멱등 재료가 없으면 보수적으로 진행한다 */ }
    }
    try {
      const r = await route({
        gh, repo, issue: reportIssue, findings: anchored, upstream,
        ownerOf: manifest.ownerOf, isInstalled: manifest.isInstalled, ktbVersion: manifest.ktbVersion,
        harness, existingComments: existing,
      });
      classified = r.classified || [];
      actions.push(...(r.actions || []));
    } catch (e) { actions.push({ kind: "error", step: "health", reason: `routing failed — ${e?.message || e}` }); }
  }
  // 지문을 발견에 되돌려 붙인다 — 보고서를 읽는 사람이 상류 이슈와 같은 열쇠를 손에 쥔다.
  for (let i = 0; i < findings.length; i++) if (classified[i]?.fingerprint) findings[i].fingerprint = classified[i].fingerprint;

  return { ok: true, below_n: signals.below_n, signals, findings, classified, actions, report: body, report_issue: reportIssue };
}

/** 주입된 스냅샷이 있으면 그대로 쓰고, 없으면 gh에서 읽는다(회고의 `collectIssues`와 같은 판정 규칙). */
async function collect({ gh, issues, commentsByIssue, records, since }) {
  if (issues) return { issues, commentsByIssue: commentsByIssue || new Map(), records: records || new Map() };
  const withState = (list) => list.map((i) => ({ ...i, state: i.closedAt ? "closed" : "open" }));
  const all = withState(await gh.issueList({ state: "all", limit: 200 }));
  const sinceMs = since == null ? null : Date.parse(since);
  const by = new Map();
  for (const i of all) {
    if (!afterSince(i.closedAt, sinceMs)) continue;
    try { by.set(i.number, await gh.comments(i.number)); }
    catch (e) { console.error(`factory: health could not read comments on #${i.number} — ${e?.message || e}`); }
  }
  return { issues: all, commentsByIssue: by, records: records || new Map() };
}

/** CLI 진입: 실제 의존성 조립 */
async function main() {
  const argv = process.argv.slice(2);
  const nArg = argv.find((a) => a.startsWith("--n="));
  const sinceArg = argv.find((a) => a.startsWith("--since="));
  const N = nArg ? Math.max(1, Number(nArg.slice(4)) || DEFAULT_N) : DEFAULT_N;
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
  const gh = makeGh({ run, repo });

  let charter, harness, roles;
  try { charter = loadCharter(root); harness = loadHarness(root); }
  catch (e) { console.error(`factory: health dormant — ${e.message}`); process.exit(0); }
  if (charter.status !== "ready") { console.error(`factory: CHARTER status is ${charter.status} — health dormant`); process.exit(0); }
  try { roles = loadRoles(root); } catch { roles = {}; }

  const manifest = await loadInstallManifest(root);
  if (!manifest) console.error(`factory: ${INSTALL_MANIFEST_PATH} not found — behavioural findings will not be routed (run \`npx know-thy-build factory init --upgrade\`)`);

  // 저장소 수준의 리허설 상태 — 건강 줄 하나다(발견이 아니다).
  let rehearsal = null;
  try {
    const readText = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null);
    const harnessText = readText(FINGERPRINT_PATHS[0]);
    const current = harnessText == null ? null : rehearsalHash({ harnessText, charterText: readText(FINGERPRINT_PATHS[1]) || "" });
    const branch = harness.project?.default_branch ?? "main";
    rehearsal = rehearsalGate({ recorded: await recordedRehearsal({ gh, branch, current }), current });
  } catch (e) { console.error(`factory: health could not read the rehearsal record — ${e?.message || e}`); }

  const roleFile = new Map([...roleFileMap(roles)].map(([k, v]) => [k, v.agent]));
  const r = await runHealth({
    gh, root, repo, N, since: sinceArg ? sinceArg.slice(8) : null,
    harness, manifest, roleFile, upstream: upstreamRepoOf(harness), rehearsal,
  });
  for (const a of r.actions) console.log(`health: ${a.kind}${a.issue == null ? "" : ` #${a.issue}`}${a.reason ? ` — ${a.reason}` : ""}`);
  console.log(`health: ${r.below_n ? "below sample size" : `${r.findings.length} behavioural finding(s)`} over the last ${N} merged issues`);
  process.exit(0);
}

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
