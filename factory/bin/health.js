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

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { makeGh, resolveFactoryLogins } from "../lib/gh.js";
import { attributionFor } from "../lib/feedback/harvest-findings.js";
import { errorAnnotation, stepSummary } from "../lib/gha.js";
import { loadCharter, loadHarness, loadRoles, upstreamRepoOf } from "../lib/config.js";
import { HEALTH_LABEL } from "../lib/label-catalog.js";
import { readRecordsDetailed, recordsSourceOf, recordsWereRead } from "../lib/records-branch.js";
import { tierFloor } from "../lib/gates.js";
import { routeFindings } from "../lib/feedback/route.js";
import { classifyFinding } from "../lib/feedback/classify.js";
import { loadInstallManifest, INSTALL_MANIFEST_PATH } from "../lib/feedback/install-manifest.js";
import { parseHandoffs } from "../lib/handoff.js";
import { parseRunRecord } from "../lib/usage.js";
import { aggregateRoleSignals, isMerged, planDebateDelta, roleSignalsFor } from "../lib/retro/harvest.js";
import { afterSince } from "../lib/retro/issue-comments.js";
import { recordedRehearsal, rehearsalGate, rehearsalHash, FINGERPRINT_PATHS } from "../lib/rehearsal.js";
import { roleFileMap } from "./retro.js";

/** spec §10 Q3 — 행동 발견 이전의 최소 표본. ADR-026이 쓰는 것과 같은 수다. */
export const DEFAULT_N = 5;
/** 창의 대상 — 머지된 이슈만이 "공장이 한 일"이다(`lib/retro/harvest.js`의 `isMerged`와 같은 라벨). */
const MERGED_LABEL = "factory:merged";

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
 * 더 위험한 tier가 창에 **둘 미만이면 `null`이다**(리뷰 r1 should_fix 5) — 하나짜리 "중앙값"은
 * 중앙값이 아니라 그 이슈 한 건이고, 그 한 건이 우연히 싼 이슈였으면 정상적인 저위험 작업이 전부
 * 낭비로 찍힌다. 기준선이 없으면 발견도 없다: 전부 docs인 창에서 "docs치고 비싸다"는 짝 없는 비용이다.
 *
 * `tiers`에는 그 중앙값이 **어느 tier에서 나왔는지**를 함께 돌려준다 — 발견 본문이 있지도 않은
 * load-bearing을 근거로 들먹이면 안 된다(같은 리뷰 지적).
 */
export function costBaselineFor(tier, perIssue = []) {
  const r = riskOf(tier);
  if (r < 0) return { usd: null, tiers: [], n: 0 };
  const higher = (perIssue || []).filter((x) => riskOf(x.tier) > r && Number.isFinite(x.cost));
  if (higher.length < MIN_BASELINE_SAMPLE) return { usd: null, tiers: [], n: higher.length };
  return {
    usd: median(higher.map((x) => x.cost)),
    tiers: [...new Set(higher.map((x) => x.tier))].sort((a, b) => riskOf(a) - riskOf(b)),
    n: higher.length,
  };
}
/** 기준선을 만들려면 더 위험한 이슈가 최소 몇 건 필요한가. 하나로는 중앙값을 말할 수 없다. */
export const MIN_BASELINE_SAMPLE = 2;
/**
 * 기준선을 **얼마나** 넘겨야 낭비인가. 같은 tier의 정상 변동(모델 선택·라운드 수)이 기준선을 살짝
 * 넘기는 일은 흔하므로, 딱 1.0×로 자르면 규칙이 잡음을 이슈로 만든다. 1.25×는 "같은 값을 썼다"가
 * 아니라 "확실히 더 썼다"를 뜻한다(리뷰 r1 should_fix 5, 리뷰어의 probe C: standard $6 + docs $6.50).
 */
export const WASTE_MULTIPLE = 1.25;
/**
 * 그리고 **절대 초과분**도 이만큼은 돼야 한다. 배수만으로 자르면 기준선이 작을 때 규칙이 잡음을 이슈로
 * 만든다: 기준선 $2에 docs PR $3이면 1.5×지만 차액은 $1이고, 그 $1은 모델 선택이나 라운드 하나의
 * 흔들림으로도 난다 — 사람이 고칠 것이 없는 이슈를 상류에 여는 셈이다. `WASTE_MULTIPLE`과 함께
 * **저장소가 조정하는 상수**로 둔다(둘 다 넘겨야 낭비다). 작은 저장소는 낮추고, 런이 비싼 저장소는
 * 올린다 — 값이 여기 한 줄로 서 있는 이유가 그것이다.
 */
export const WASTE_MIN_EXCESS_USD = 5;

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
 * 이 이슈의 실효 tier. **앵커는 러너가 붙인 `factory:tier-*` 라벨이다**(리뷰 r1 must_fix 3):
 *   ① `factory:tier-*` 라벨 — triage 스테이지의 러너가 `setTierLabel`로 붙인다. 에이전트가 산문으로
 *      바꿀 수 없는 저장소 상태이고, 그래서 유일한 앵커다.
 *   ② 라벨이 **없을 때만** 폴백: 바인딩된 리뷰 핸드오프의 `tier_effective`(러너가 diff에서 계산해
 *      핸드오프에 실어 준 값 — 감사 H3). 바인딩되지 않은 핸드오프의 값은 읽지 않는다.
 * 에이전트가 적는 자기 신고 `tier`는 **어느 경로로도 읽지 않는다.** 그것을 읽으면 채점 대상이 제
 * 채점 기준을 고르게 된다 — `load-bearing`이라 적어 두면 비용 규칙이 영원히 침묵한다.
 * @returns {{tier: string|null, source: "label"|"handoff"|"none"}}
 */
export function tierOf(issue, signals) {
  for (const l of Array.isArray(issue?.labels) ? issue.labels : []) {
    const name = typeof l === "string" ? l : l?.name;
    const m = /^factory:tier-(.+)$/.exec(String(name ?? ""));
    if (m && riskOf(m[1]) >= 0) return { tier: m[1], source: "label" };
  }
  if (signals?.tier_handoff && riskOf(signals.tier_handoff) >= 0) return { tier: signals.tier_handoff, source: "handoff" };
  return { tier: null, source: "none" };
}

const ROSTER_PATH = ".factory/lib/review-roster.js";
/** `resolveTier`가 사는 배포물 — tier 오채점 발견의 인과 파일(설치 매니페스트에서 owner: factory). */
export const TIER_RESOLVER_PATH = ".factory/lib/context.js";

/**
 * `diffShapeOf(files, harness) → "docs" | "code" | null` — **두 번째 위험 출처**(r2 항목 1).
 *
 * tier 라벨은 triage 에이전트의 신고에서 출발하고, 틀리는 방향은 언제나 가벼운 쪽이다. 그런데 그
 * 라벨 하나에만 앵커하면 규칙은 **정반대 실수**를 영영 볼 수 없다: docs 모양의 diff가 `standard`로
 * 채점돼 전체 패널을 사 버린 경우다. 라벨을 고친 것이 문제가 아니라 라벨이 유일한 눈이었던 것이
 * 문제였다. 그래서 GitHub이 diff에서 계산한 **경로 목록**을 나란히 둔다 — 에이전트가 적을 수 없는 사실.
 *
 * 판정은 `tierFloor`에 **위임한다**(글롭 목록을 여기 베끼지 않는다). 그 함수가 이미 `DOC_GLOBS`와
 * `NEVER_DOCS_GLOBS`(CHARTER·리뷰어 프롬프트·워크플로 — "문서처럼 생겼지만 문서가 아닌 것")와
 * `[protected].factory`를 함께 본다. 목록을 복제하면 두 판정이 갈라지는 날이 오고, 그날 이 규칙은
 * 리뷰어 프롬프트 변경을 docs라 부른다.
 *
 * 경로가 **하나도 없으면 `null`이다** — 빈 목록에 `tierFloor`는 "docs"라 답하지만(어느 경로도 검사에
 * 걸리지 않으므로) 그것은 "문서다"가 아니라 "읽지 못했다"이다. 모르는 것을 docs로 읽으면 감사 H3이
 * 지적한 구멍이 정확히 이 규칙 안에서 다시 열린다.
 */
export function diffRiskOf(files, harness = {}) {
  if (!Array.isArray(files) || files.length === 0) return null;
  try {
    const floor = tierFloor({ changed: { all: files }, harness: harness || {} });
    return riskOf(floor) >= 0 ? floor : null;
  } catch { return null; }
}
/** 같은 판정의 두 갈래 요약 — 규칙은 `"docs"` 하나만 묻고, 표는 둘을 나란히 보여 준다. */
export function diffShapeOf(files, harness = {}) {
  const risk = diffRiskOf(files, harness);
  return risk == null ? null : (risk === RISK_ORDER[0] ? "docs" : "code");
}

/**
 * 창 하나를 신호로 바꾼다 — 순수 함수다(gh도 fs도 만지지 않는다). 발견을 만드는 규칙과, 그 규칙이
 * 읽는 숫자를 한 자리에 둔다: 보고서가 보여 주는 표와 발견이 선 근거가 **같은 객체**여야 한다.
 */
/**
 * 이슈 번호로 조회하는 세 표(`commentsByIssue`·`records`·`prByIssue`)를 **한 가지 모양**으로 만든다.
 *
 * 호출자마다 Map을 주기도 하고 평범한 객체를 주기도 하는데, 객체를 `Object.entries`로 접으면 키가
 * **문자열**이 된다 — 그런데 조회는 `issue.number`(숫자)로 한다. 그대로 두면 객체로 준 창은 모든
 * 조회가 조용히 빈 값이 되고, 그 침묵은 보고서에서 "리뷰어가 깨끗했다"와 구별되지 않는다(T7 리뷰
 * should_fix 3: 같은 이유로 공유 신원 판정이 객체 입력에서 통째로 침묵했다). 그래서 숫자로 읽히는
 * 키는 숫자와 문자열 **양쪽**으로 넣어 둔다 — 어느 형태로 물어도 같은 답이 나온다.
 */
export function toIssueMap(v) {
  const src = v instanceof Map ? v : new Map(Object.entries(v || {}));
  const out = new Map();
  for (const [k, val] of src) {
    out.set(k, val);
    if (!out.has(String(k))) out.set(String(k), val);
    const n = Number(k);
    if (Number.isFinite(n) && !out.has(n)) out.set(n, val);
  }
  return out;
}

export function healthSignals({ issues = [], commentsByIssue = new Map(), records = new Map(), prByIssue = new Map(), harness = {}, N = DEFAULT_N, records_source = "injected" } = {}) {
  const byIssue = toIssueMap(commentsByIssue);
  const recs = toIssueMap(records);
  const prs = toIssueMap(prByIssue);

  const perIssue = [];
  for (const issue of issues || []) {
    const comments = byIssue.get(issue.number) || [];
    if (!isMerged(issue, comments)) continue;
    const record = recs.get(String(issue.number)) ?? recs.get(issue.number) ?? "";
    const sig = roleSignalsFor({ record, comments });
    const debate = planDebateDelta(parseHandoffs(comments));
    const cost = costOfRecord(record);
    const t = tierOf(issue, sig);
    // 두 번째 위험 출처 — GitHub이 계산한 경로 목록(라벨과 **독립**이다).
    const prInfo = prs.get(issue.number) ?? prs.get(String(issue.number)) ?? null;
    const diffRisk = diffRiskOf(prInfo?.files, harness);
    const shape = diffRisk == null ? null : (diffRisk === RISK_ORDER[0] ? "docs" : "code");
    perIssue.push({
      issue: issue.number, closedAt: issue.closedAt,
      tier: t.tier, tier_source: t.source,
      // r2 항목 1의 모양: 위험을 말하는 두 출처를 한 자리에 나란히 둔다.
      risk: { tier: { value: t.tier, source: t.source }, diff_shape: shape, diff_risk: diffRisk, prs: prInfo?.prs ?? [] },
      diff_shape: shape, diff_risk: diffRisk,
      pr: prInfo?.pr ?? null, prs: prInfo?.prs ?? [], pr_files: prInfo?.files?.length ?? null,
      panel: sig.panel, rounds: sig.max_round, bound_rounds: sig.rounds,
      cost: cost.total, cost_by_stage: cost.by_stage,
      roles: sig.roles, escaped: sig.escaped_total, debate,
      // 귀속이 **가능했는가** — 런에 묶인 리뷰 증거가 한 줄도 없으면 이 이슈는 역할 신호에 기여하지
      // 않는다(1.4 이전 기록이 그렇다). 그 사실이 보이지 않으면 "리뷰어가 깨끗했다"와 "읽을 수 없었다"가
      // 같은 침묵으로 보인다.
      attributable: sig.rounds > 0,
      unbound_evidence: sig.unbound_evidence,
      unbound_handoffs: sig.unbound_handoffs,
      conflicting_rounds: sig.conflicting_rounds,
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

  /**
   * 한 이슈의 **판정 위험**. 모양을 읽었으면 모양이 이기고, 못 읽었으면 라벨로 물러선다.
   *
   * 기준선을 라벨로 고르면 규칙이 제 꼬리를 문다: 오채점된 docs 모양 diff는 라벨이 `standard`라
   * "나보다 위험한 것"이 load-bearing뿐이 되고, 그 표본이 2건에 못 미쳐 기준선이 영영 서지 않는다 —
   * 곧 **오채점된 이슈만 정확히 심사를 면한다.** 모양이 docs라면 비교 대상은 "docs보다 위험한 일"
   * 전부(standard + load-bearing)다.
   */
  /**
   * 그리고 그 대체는 **대칭이어야 한다**(r3 항목 3). `docs` 방향으로만 덮어쓰면 반대 오채점 —
   * 코드를 건드린 diff가 `docs` 라벨을 달고 있는 경우 — 에서 위험이 `docs`로 남고, "docs보다 위험한
   * 것"의 표본이 무너져 기준선이 null이 된다. `tierFloor`는 이미 `docs`/`standard`/`load-bearing`
   * 셋을 구분해 답한다 — 둘로 접어서 받던 것이 그 비대칭의 원인이었다.
   */
  const riskOfIssue = (x) => x.diff_risk ?? x.tier;
  const priced = window.filter((y) => y.cost != null && (y.tier || y.diff_shape));
  const pricedRisk = priced.map((y) => ({ tier: riskOfIssue(y), cost: y.cost }));
  const costVsRisk = priced.map((x) => {
    const risk = riskOfIssue(x);
    const b = costBaselineFor(risk, pricedRisk);
    return {
      issue: x.issue, tier: x.tier, tier_source: x.tier_source,
      diff_shape: x.diff_shape, diff_risk: x.diff_risk, pr: x.pr, prs: x.prs,
      risk_tier: risk, panel: x.panel, cost: x.cost,
      baseline: b.usd, baseline_tiers: b.tiers, baseline_n: b.n,
      threshold: b.usd == null ? null : round2(b.usd * WASTE_MULTIPLE),
    };
  });
  // 모양을 읽지 못한 이슈 — 모양 기반 규칙은 이들에 대해 **아무 말도 하지 않는다**(라벨로 추측하지 않는다).
  const shapeUnknown = window.filter((x) => x.diff_shape == null).map((x) => x.issue);

  return {
    N,
    merged: perIssue.length,
    window: window.map((x) => x.issue),
    below_n: window.length < N,
    // 비용 신호를 **읽을 수 있었는가**. `records-branch`가 아니면 비용 표가 비는 이유가 여기 있다.
    records_source,
    priced: priced.length,
    // diff 모양을 읽을 수 있었는가(r2 항목 4) — 못 읽은 것은 저하로 **보고**하고 추측하지 않는다.
    shape_known: window.filter((x) => x.diff_shape != null).length,
    shape_unknown: shapeUnknown,
    per_issue: window,
    roles,
    full_panel: fullPanel,
    // 귀속 가능한 이슈 수 — 역할 규칙이 실제로 읽을 수 있었던 표본이다(1.4 이전 기록은 여기 안 든다).
    attributable: window.filter((x) => x.attributable).length,
    unbound_handoffs: window.reduce((n, x) => n + (x.unbound_handoffs || 0), 0),
    unbound_evidence: window.reduce((n, x) => n + (x.unbound_evidence || 0), 0),
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
 * 신호 → **행동 발견**. 규칙 둘 각각이 짝의 양쪽을 모두 손에 쥔 채로만 발견을 만든다.
 * 발견 하나하나가 `paired: true`를 달고 나가고, 그 단언의 근거가 `reason` 본문에 **숫자로** 박힌다
 * (이슈를 읽는 사람이 "왜 이게 발견인가"를 본문만으로 재구성할 수 있어야 한다 — T6의 계약).
 *
 * 규칙은 **둘**이다. dead-debate는 여기서 나오지 않는다(아래 `advisories` 참조).
 * @returns {{findings: object[], advisories: object[]}}
 */
export function behaviouralFindings({ signals, repo, roleFile = new Map(), anchorIssue = null }) {
  const out = [];
  const advisories = [];
  const at = (role) => roleFile.get?.(role) || `.claude/agents/reviewer-${role}.md`;

  // ── ② dead debate는 **보고서 전용**이다(리뷰 r1 should_fix 6) ───────────────────────────────
  // 유일한 입력이 `dissent_log[].resolution` — plan 에이전트가 **자기 토론에 대해 스스로 쓴 산문**이다.
  // 러너가 검증하는 값이 아니므로, 그것으로 상류에 이슈를 열면 채점 대상이 제 성적표를 쓰는 것이 된다
  // ("accepted"라고만 적으면 규칙이 영원히 침묵한다). 그래서 보고서에는 싣되 라우팅하지 않는다 —
  // 이 신호가 앵커를 얻으려면 러너가 쓰는 plan 증거 줄이 먼저 있어야 한다(후속 작업).
  const measured = (signals.debate?.per_issue || []).filter((x) => x.plan_handoffs > 0);
  if (!signals.below_n && measured.length >= signals.N && measured.every((x) => !x.changed)) {
    advisories.push({
      signal: "dead-debate", anchored: false, stage: "plan",
      reason: `the plan debate changed nothing in ${measured.length}/${signals.N} of the last merged issues: `
        + `no done_when was added and no dissent was resolved (every dissent was left unresolved or deferred) `
        + `(issues ${measured.map((x) => `#${x.issue}`).join(", ")}).`,
      caveat: "unanchored (agent-written `dissent_log[].resolution`) — reported, never routed",
    });
  }

  if (signals.below_n) return { findings: out, advisories };   // N 미만: 규칙을 아예 돌리지 않는다

  // ── ① rubber-stamp — 100% 승인(정수 비교) **그리고** 귀속된 escaped 라운드 ≥ 1 ──────────────
  // 둘 다 run 기록의 `review-evidence:` 줄에서만 온다(런에 바인딩된 줄만) — 에이전트가 쓴 본문이
  // 아니다. 귀속이 가능했던 이슈가 N개에 못 미치면 규칙 자체를 돌리지 않는다: 1.4 이전 기록에는 그
  // 줄이 없어서 모든 역할이 "깨끗해" 보이고, 그 침묵을 판정으로 읽으면 안 된다.
  if (signals.attributable >= signals.N) {
    for (const [role, r] of Object.entries(signals.roles || {})) {
      if (!r.verdicts || r.approves !== r.verdicts) continue;      // 한 번이라도 거절했으면 도장이 아니다
      if (!(r.escaped_defects >= 1)) continue;                     // 짝이 없다 — 판정하지 않는다
      out.push({
        signal: "rubber-stamp", kind: "behavioural", paired: true,
        issue: anchorIssue, repo, stage: "review", role,
        causal_path: at(role),
        // **원인만** 적는다 — 창마다 움직이는 숫자는 한 글자도 넣지 않는다(r3 should_fix 1).
        reason: `role \`${role}\` never withholds approval, and defects it had already approved are found in later review rounds `
          + `— a review that only ever approves while defects escape past it is a rubber stamp, not a review. `
          + `Both halves are read from run-bound \`review-evidence:\` lines written by the runner. `
          + `Per-window counts are in the evidence entries below, not here: this sentence is the cause and must stay identical across runs.`,
        extra: {
          chain: [
            `approve_rate ${r.approve_rate} (${r.approves}/${r.verdicts} verdicts) × escaped_defects ${r.escaped_defects}, over the last ${signals.N} merged issues (${signals.window.map((n) => `#${n}`).join(", ")})`,
            ...(signals.per_issue || []).filter((x) => x.roles?.[role]?.escaped).map((x) => `#${x.issue}: ${x.roles[role].escaped} round(s) with a later reject after this role approved`),
          ],
        },
      });
    }
  }

  // ── ③ cost vs risk — **docs 모양의 diff**가 전체 패널에 올라가 기준선을 확실히 넘겼다 ─────────
  // 방아쇠는 이제 라벨이 아니라 **diff 모양**이다(r2 항목 2). 라벨에만 걸던 규칙은 정확히 놓쳐야 할
  // 것을 놓쳤다: triage가 docs 모양을 `standard`로 채점하면 그 순간 규칙의 눈이 감긴다.
  for (const x of signals.cost_vs_risk || []) {
    if (x.diff_shape !== "docs") continue;                         // 모양 미상(null)도 여기서 걸러진다
    if (!signals.full_panel || x.panel < signals.full_panel) continue;  // 전체 패널이 아니면 낭비가 아니다
    if (x.baseline == null || x.threshold == null) continue;       // 기준선을 만들 표본이 없다
    if (!(x.cost > x.threshold)) continue;                         // 확실히 넘지 않았다(1.25×)
    if (!(x.cost - x.baseline >= WASTE_MIN_EXCESS_USD)) continue;  // 차액이 잡음 수준이다
    out.push({
      signal: "cost-vs-risk", kind: "behavioural", paired: true,
      issue: x.issue, repo, stage: "review",
      causal_path: ROSTER_PATH,
      // **원인만** — 이슈/PR 번호도 달러도 넣지 않는다. 같은 원인이 주마다 새 이슈를 열면 안 된다.
      reason: `a DOCS-SHAPED diff — every path GitHub lists for its merged PR matches the docs globs the tier resolver itself uses — `
        + `ran the FULL review panel and cost materially more than the higher-risk work in the same window. `
        + `The roster resolved for this diff is the cause, not the reviewers: docs-shaped work is buying the review depth of load-bearing work. `
        + `The per-window costs, baselines and issue numbers are in the evidence entries below, not here.`,
      extra: {
        cost: { usd: x.cost, baseline: x.baseline, threshold: x.threshold, baseline_tiers: x.baseline_tiers },
        chain: [`#${x.issue} (PR ${x.prs.length ? x.prs.map((p) => `#${p}`).join("+") : "n/a"}): diff_shape docs, label tier ${x.tier} (${x.tier_source}), panel ${x.panel}/${signals.full_panel}, cost $${x.cost} vs threshold $${x.threshold} (baseline $${x.baseline} from ${x.baseline_n} issue(s) at ${x.baseline_tiers.join("+")}, excess $${round2(x.cost - x.baseline)} ≥ $${WASTE_MIN_EXCESS_USD})`],
      },
    });
  }

  // ── ④ tier 오채점 — docs 모양의 diff에 docs가 아닌 등급이 붙었다(r2 항목 3) ──────────────────
  // 이것이 낭비의 **원인**이다. ③은 증상(비싼 리뷰)을 말하고 이것은 원인(해석기의 채점)을 말한다.
  // 그리고 이 원인은 KTB가 배포한 기본값의 결함이다 — 루프가 존재하는 이유가 정확히 이것이다.
  // 짝: "경로는 전부 docs다"(GitHub의 사실) × "등급은 docs가 아니다"(러너의 라벨). 둘 다 에이전트가
  // 쓸 수 없는 채널이고, 둘이 어긋났다는 것 자체가 판정이다 — 비용도 패널도 묻지 않는다.
  for (const x of signals.per_issue || []) {
    if (x.diff_shape !== "docs") continue;
    if (!x.tier || x.tier === RISK_ORDER[0]) continue;             // 등급이 docs면 어긋난 것이 없다
    out.push({
      signal: "tier-misgrade", kind: "behavioural", paired: true,
      issue: x.issue, repo, stage: "triage",
      causal_path: TIER_RESOLVER_PATH,
      // **원인만** — 등급 값도 파일 수도 이슈 번호도 넣지 않는다. 같은 결함의 모든 관측이 한 이슈에 모인다.
      reason: `the tier resolver grades docs-shaped diffs above \`docs\`: every path GitHub lists for the merged PR matches the docs globs `
        + `the resolver itself uses, yet the runner-applied tier is higher. `
        + `That buys the heavier roster and the heavier gate level for work that needs neither — and, because a label-anchored waste check `
        + `reads the very grade that is wrong, it can never see it. `
        + `Paired evidence: the GitHub file list for the merged PR × the runner-applied tier label — two channels no agent can write. `
        + `The affected issues and grades are in the evidence entries below, not here.`,
      extra: {
        chain: [`#${x.issue} (PR ${x.prs.length ? x.prs.map((p) => `#${p}`).join("+") : "n/a"}): ${x.pr_files} file(s), all docs; graded \`${x.tier}\` via ${x.tier_source}`],
      },
    });
  }
  return { findings: out, advisories };
}

const pct = (v) => (v == null ? "n/a" : `${Math.round(v * 100)}%`);
const usd = (v) => (v == null ? "n/a" : `$${v}`);

/**
 * 파생 보고서(spec §7) — 주인이 읽는 "대화"다. 원시 덤프가 아니라 **판정과 그 근거**를 같은 표에
 * 나란히 둔다: 짝의 양쪽이 한 줄에 보이지 않으면 사람도 Goodhart를 피할 수 없다.
 */
export function renderHealthReport({ signals, findings = [], advisories = [], rehearsal = null, now, repo, upstream = null, identity = null, unverifiable = [], loginNote = null }) {
  const L = [];
  L.push(HEALTH_MARKER);
  L.push(`## factory-health — ${String(now).slice(0, 10)}`);
  L.push("");
  /**
   * T7 배너 — 표보다 **먼저** 선다. 이 저장소가 공유 신원이면 아래 어떤 숫자도 "사람이 factory-defect로
   * 판정했는가"를 담지 못한다(그 통로가 통째로 닫혀 있다). 그 사실을 표 밑에 각주로 달면 아무도 안 읽는다.
   */
  if (identity?.personal === true) {
    L.push(`> ⚠️ **factory identity is a personal account (\`${identity.login}\`)** — author-based attribution (human-decision) is disabled; register a machine user or GitHub App as the factory identity.`);
    L.push("> 팩토리 코멘트와 소유자의 코멘트가 **같은 작성자**라 `cause: factory-defect` 결정을 사람의 판정으로 셀 수 없습니다 — 아래 표의 어떤 값도 그 통로가 닫혀 있다는 사실을 보정하지 않습니다.");
    L.push("");
  }
  // 못 알아낸 것도 배너다 — "기각 0건"이 "문제 없음"으로 읽히는 것을 막는 유일한 줄이다.
  if (loginNote) {
    L.push(`> ⚠️ **factory logins unresolved** — human-decision attribution cannot be evaluated.`);
    L.push(`> ${loginNote}`);
    L.push("");
  }
  if (unverifiable.length) {
    L.push(`> **기각된 human-decision ${unverifiable.length}건**(공유 신원이라 사람과 에이전트를 가를 수 없습니다):`);
    for (const u of unverifiable) L.push(`> - #${u.issue} — @${u.author}: ${u.reason}`);
    L.push("");
  }
  L.push(signals.below_n
    ? `**표본 미달**: 머지된 이슈 ${signals.window.length}/${signals.N}. 행동 발견은 하나도 내지 않습니다 — 승인률도 토론도 비용도 이 표본에서는 판정할 수 없습니다(spec §10 Q3).`
    : `최근 머지 ${signals.window.length}개(${signals.window.map((n) => `#${n}`).join(", ")})를 봤습니다. 아래 표의 **모든 판정은 짝이 있는 신호**에서만 나옵니다(spec §5).`);
  L.push("");
  // 무엇을 **읽을 수 있었는가** — 이 줄이 없으면 "리뷰어가 깨끗했다"와 "증거가 없었다"가 같아 보인다.
  L.push(`읽을 수 있었던 증거: 창의 ${signals.window.length}개 중 **${signals.attributable}개**가 런에 바인딩된 \`review-evidence:\` 줄을 갖고 있습니다`
    + `(역할 규칙은 이 수가 ${signals.N} 이상일 때만 돕니다).`
    + (signals.unbound_handoffs ? ` 바인딩되지 않아 무시한 리뷰 핸드오프 ${signals.unbound_handoffs}개.` : "")
    + (signals.unbound_evidence ? ` 바인딩되지 않아 무시한 evidence 줄 ${signals.unbound_evidence}개.` : ""));
  /**
   * #36 item 4 — **0/N의 이유를 말한다.** 귀속이 0인데 바인딩에 실패한 줄도 0이면, 그것은 "리뷰어가
   * 깨끗했다"도 "하트비트가 어긋났다"도 아니다 — 창의 기록에 읽을 줄이 **아예 없다**는 뜻이다.
   * 그 사실과 그 흔한 원인(1.4 이전 기록에는 detail 줄이 없다)을 함께 적는다. 기록의 나이를 사실로
   * 단정하지는 않는다 — 여기서 관측되는 것은 부재뿐이다(`factory analyze`의 같은 문장과 같은 규율).
   */
  /**
   * r1 리뷰 should_fix 2 — 위 문장의 **전제는 "기록을 읽었다"**이다. `records_source`가
   * `records-branch-unreadable`/`no-records-branch`/`records-branch-empty`면 이 창의 기록은 한 글자도
   * 손에 없었고, 그때 "detail 줄이 없습니다"는 관측이 아니라 추측이다 — 그리고 그 추측이 곧바로
   * "1.4 이전 기록"이라는 두 번째 추측을 낳는다. 사람이 할 일도 정반대다(전자는 아무것도 아니고,
   * 후자는 브랜치·토큰을 봐야 한다). `lib/feedback/route.js`의 같은 갈림과 같은 술어를 쓴다.
   */
  if (signals.window.length && !signals.attributable && !signals.unbound_evidence) {
    L.push("");
    L.push(recordsWereRead(signals.records_source)
      ? "> 창의 어느 run 기록에도 detail 줄이 없습니다(`review-evidence:`/`gates-detail:`/`context-manifest:`) — 귀속을 판정할 재료 자체가 없습니다. 1.4 이전에 쓰인 기록에는 그 줄이 없습니다(그 창에서는 역할·비용 판정을 하지 않습니다)."
      : `> **이 창의 run 기록을 읽지 못했습니다**(\`${signals.records_source}\`) — 귀속 0은 기록에 detail 줄이 없어서가 아니라 기록이 손에 없어서입니다. 줄의 유무도, 그 기록이 1.4 이전의 것인지도 여기서는 판정할 수 없습니다(먼저 \`factory/records\` 브랜치와 토큰을 확인하세요).`);
  }
  L.push("");
  L.push(`비용 기록: \`${signals.records_source}\` — 비용을 읽은 이슈 ${signals.priced}/${signals.window.length}개.`
    + (signals.records_source === "records-branch" ? "" : " 비용 규칙은 run 기록 없이는 아무것도 판정하지 않습니다."));
  L.push("");

  L.push("### 역할 — 승인률 × 귀속된 escaped 라운드");
  L.push("");
  L.push("| role | verdicts | approve_rate | ever_rejects | flips | escaped(귀속) | must_fix(참고) |");
  L.push("|---|---:|---:|:--:|---:|---:|---:|");
  const roles = Object.entries(signals.roles || {}).sort((a, b) => b[1].verdicts - a[1].verdicts);
  if (!roles.length) L.push("| _(런에 바인딩된 리뷰 판정 없음)_ | | | | | | |");
  for (const [name, r] of roles) {
    L.push(`| \`${name}\` | ${r.verdicts} | ${pct(r.approve_rate)} | ${r.ever_rejects ? "예" : "**아니오**"} | ${r.flips} | ${r.escaped_defects} | ${r.must_fix_ref} |`);
  }
  L.push("");
  L.push("> `verdicts`·`approve_rate`·`escaped(귀속)`은 전부 런이 쓴 `review-evidence:` 줄에서 읽습니다 — 에이전트가 쓴 핸드오프 본문이 아닙니다. `escaped(귀속)`은 **그 역할이 이미 승인해 둔 뒤 더 나중 라운드에서 누군가 reject한** 횟수입니다. 그 결함을 스스로 찾아내 판정을 뒤집은 역할에게는 귀속되지 않습니다. 승인률 100%는 이 열이 0이면 아무 뜻도 없습니다 — 쉬운 이슈였을 뿐일 수 있습니다. `must_fix(참고)`는 바인딩된 핸드오프에서 읽은 **참고값**이며 어떤 판정에도 쓰이지 않습니다.");
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
  L.push("> 이 표의 입력은 plan 에이전트가 **자기 토론에 대해 스스로 쓴** `dissent_log[].resolution`입니다. 러너가 검증하지 않는 값이라 여기서 나오는 신호는 **보고만 하고 절대 이슈로 라우팅하지 않습니다** — 채점 대상이 제 성적표를 쓰게 둘 수는 없습니다.");
  L.push("");

  L.push("### 비용 대 위험");
  L.push("");
  L.push(`tier별: ${Object.entries(signals.cost_by_tier).map(([t, c]) => `\`${t}\` ${usd(c)}`).join(" · ") || "n/a"}`);
  L.push("");
  L.push(`역할별(리뷰 스테이지 비용의 **균등 배분** — 측정이 아니라 참고값): ${Object.entries(signals.cost_by_role).map(([t, c]) => `\`${t}\` ${usd(c)}`).join(" · ") || "n/a"}`);
  L.push("");
  L.push(`| issue | PR | diff 모양(등급) | tier(라벨) | 판정 위험 | panel | cost | 기준선 | 임계(${WASTE_MULTIPLE}× / +$${WASTE_MIN_EXCESS_USD}) |`);
  L.push("|---|---|---|---|---|---:|---:|---:|---:|");
  for (const x of signals.cost_vs_risk || []) {
    const base = x.baseline == null ? `n/a (더 위험한 이슈 ${x.baseline_n}건 — ${MIN_BASELINE_SAMPLE}건 필요)` : `${usd(x.baseline)} (${x.baseline_tiers.join("+")}, n=${x.baseline_n})`;
    const shape = x.diff_shape == null ? "**미상**" : `\`${x.diff_shape}\` (\`${x.diff_risk}\`)`;
    const prs = x.prs?.length ? x.prs.map((p) => `#${p}`).join(", ") : "n/a";
    L.push(`| #${x.issue} | ${prs} | ${shape} | \`${x.tier}\` (${x.tier_source}) | \`${x.risk_tier}\` | ${x.panel}/${signals.full_panel} | ${usd(x.cost)} | ${base} | ${usd(x.threshold)} |`);
  }
  L.push("");
  L.push("> 위험을 말하는 출처는 **둘**이고 둘 다 에이전트가 쓸 수 없는 채널입니다. `tier(라벨)`은 러너가 붙인 `factory:tier-*`입니다(라벨이 없을 때만 런에 바인딩된 핸드오프의 `tier_effective`로 물러섭니다 — 에이전트의 자기 신고 `tier`는 읽지 않습니다). `diff 모양(등급)`은 이슈의 **머지된 PR 전부**에 대해 GitHub이 계산한 경로 목록의 합집합을 tier 해석기와 **같은 글롭**으로 판정한 값입니다(재작업으로 PR이 둘 머지되면 모양은 둘을 합친 것입니다). `판정 위험`은 그 등급이고, 읽지 못했을 때만 라벨로 물러섭니다 — 어느 방향의 오채점에도 대칭입니다. 낭비 판정은 모양에 겁니다: 라벨 하나에만 걸면 '문서 모양인데 standard로 채점된' 경우를 영영 보지 못합니다.");
  if (signals.shape_unknown?.length) {
    L.push("");
    L.push(`> 모양을 읽지 못한 이슈: ${signals.shape_unknown.map((n) => `#${n}`).join(", ")} (머지된 PR이나 그 파일 목록을 얻지 못했습니다). 이들에 대해 모양 기반 규칙은 **아무 말도 하지 않습니다** — 라벨로 추측하지 않습니다.`);
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

  L.push("### 이번 회차의 발견 (라우팅됨)");
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

  if (advisories.length) {
    L.push("### 참고 신호 (앵커가 없어 라우팅하지 않음)");
    L.push("");
    for (const a of advisories) L.push(`- **${a.signal}** — ${a.reason}\n  - _${a.caveat}_`);
    L.push("");
  }
  L.push(`<sub>이 보고서는 기록에서 **파생**됐습니다(원시 덤프가 아닙니다). 발견은 ${upstream ? `\`${upstream}\`의 factory-improvement 이슈` : "이 저장소의 코멘트"}로 라우팅됩니다 — 루프는 이슈를 열 뿐 KTB도 하네스도 스스로 고치지 않습니다.</sub>`);
  return L.join("\n");
}

const HEALTH_TITLE = "factory-health — 공장 자신의 행동 지표";
/** 보고서 본문의 첫 줄. **이 마커가 건강 이슈의 신원**이다(라벨이 아니라 — 아래 `findHealthIssue`). */
export const HEALTH_MARKER = "<!-- factory-health:v1 -->";

/**
 * 오래 사는 건강 이슈를 찾는다 — **본문 마커로, `state: all`에서**(리뷰 r1 must_fix 4).
 *
 * 라벨과 열림 상태만 보던 옛 모양은 두 번째 이슈를 만드는 길이 둘이나 있었다: 사람이 이슈를 닫으면
 * 다음 주에 새 이슈가 열리고(그러면 T3의 라우팅 영수증 마커가 앵커를 잃어 같은 지문이 매주 상류에
 * 새 이슈를 연다), 라벨을 실수로 떼면 역시 새로 열렸다. 마커는 본문에 박혀 있어 사람이 라벨을 만져도
 * 남는다. 닫혀 있으면 **다시 연다** — 그 이슈가 이 대화의 자리이고, 자리를 옮기지 않는다.
 * 여러 개가 걸리면 가장 **오래된** 것이 정본이다(가장 많은 이력이 쌓인 자리).
 */
export async function findHealthIssue(gh) {
  const seen = new Map();
  for (const q of [{ labels: [HEALTH_LABEL], state: "all" }, { state: "all", limit: 200 }]) {
    let list = [];
    try { list = await gh.issueList(q); } catch { continue; }
    for (const i of list || []) if (i?.number != null && !seen.has(i.number)) seen.set(i.number, i);
    if (seen.size) break;                 // 라벨 조회가 물건을 주면 넓은 조회는 하지 않는다
  }
  const mine = [...seen.values()].filter((i) => String(i.body ?? "").includes(HEALTH_MARKER) || (i.labels || []).some((l) => (typeof l === "string" ? l : l?.name) === HEALTH_LABEL));
  mine.sort((a, b) => a.number - b.number);
  return mine[0] ?? null;
}

const errorAction = (reason, extra = {}) => ({ kind: "error", step: "health", reason: String(reason), ...extra });

/**
 * `runHealth({ gh, root, since, N }) → { ok, below_n, signals, findings, advisories, classified, actions, report, report_issue }`
 *
 * 보고서가 **먼저** 착지하고 라우팅이 그 이슈를 앵커로 쓴다. 순서가 뒤집히면 안 되는 이유가 있다:
 * T3의 팔은 출처 이슈에 라우팅 영수증(`routedMarker`)을 남기고 **그 마커로 멱등을 지킨다**. 주간으로
 * 도는 잡이 앵커를 매번 새로 만들면 같은 지문이 매주 상류에 새 이슈를 연다 — 하나의 오래 사는
 * `factory:health` 이슈가 앵커여야 그 dedupe가 성립한다.
 *
 * `ok: false`는 **설정·권한 문제**다(리뷰 r1 should_fix 7): 보고서를 실을 자리를 못 만들었거나 상류
 * 쓰기가 거부당한 경우다. 그 회차는 조용히 지나가면 안 된다 — 아무도 보지 않는 잡이 매주 초록으로
 * 도는 동안 루프는 한 줄도 나르지 못한다. `main()`이 그것을 `::error::` + 비-0 종료로 옮긴다.
 *
 * ── `publish: false`는 **이 실행이 아무것도 쓰지 않는다**는 뜻이다 ───────────────────────────
 * 최종 리뷰 must_fix 1: `factory analyze --health`의 자리는 노트북이고 README가 "이슈를 열지
 * 않는다"고 약속한다. 그런데 이 깃발이 보고서 이슈만 막고 **라우팅 팔은 그대로 돌았다** — gh가
 * 제대로 배선된 순간 읽기 전용이라던 명령이 `factory:health` 이슈와 상류 `factory-improvement`
 * 이슈를 열었을 것이다. 그래서 이 깃발은 이제 쓰기 표면 **전부**를 닫는다: 발견은 라우팅 팔이
 * 쓰는 것과 **같은 함수**(`classifyFinding`)로 분류만 하고, gh에는 한 글자도 쓰지 않는다.
 */
export async function runHealth({
  gh, root = ".", repo = null, since = null, N = DEFAULT_N, now = new Date().toISOString(),
  issues = null, commentsByIssue = null, records = null, prByIssue = null, run: runner = run,
  harness = null, manifest = null, roleFile = new Map(), upstream = null,
  rehearsal = null, route = routeFindings, publish = true, env,
  identity = undefined, factoryLogins = undefined, log = console.error,
} = {}) {
  /**
   * 1.4.0 핫픽스 — `env`는 **필수 주입**이다(`process.env`라는 기본값은 `assembleHealth` 한 줄에만
   * 산다). 이 값 하나가 `resolveFactoryLogins`의 ② 갈래(= Actions의 뷰어가 곧 봇이다)를 열고 닫으므로,
   * 주변 환경에서 읽으면 같은 입력이 러너와 노트북에서 다른 보고서를 낸다. 늦게 조용히 갈리는 것보다
   * 여기서 소리 내어 죽는 편이 낫다.
   */
  if (!env || typeof env !== "object") {
    throw new TypeError("runHealth: env is required — pass the caller's env explicitly (assembleHealth supplies it; tests must pass `{}` for a laptop or `{ GITHUB_ACTIONS: \"true\" }` for a runner)");
  }
  const actions = [];
  const loaded = await collect({ gh, run: runner, cwd: root, issues, commentsByIssue, records, prByIssue, since, log });
  const signals = healthSignals({ ...loaded, harness, N });

  /**
   * ── T7: 공유 신원은 **보고서의 맨 위**에 선다 ─────────────────────────────────────────────
   * 팩토리가 사람 계정(소유자의 PAT)으로 돌면 `human-decision:v1` 귀속은 원리상 불가능하다 — 그
   * 저장소의 모든 `cause: factory-defect`가 조용히 기각된다. 주간 보고서는 주인이 실제로 읽는 유일한
   * 화면이므로, 그 사실과 **이번 창에서 기각된 결정들**이 표보다 먼저 보여야 한다.
   */
  // 창의 코멘트를 **한 번** 정규화한다 — 아래 두 조회(전체 평탄화, 이슈별)가 Map이든 객체든 같이 돈다.
  const byIssue = toIssueMap(loaded.commentsByIssue);
  let theIdentity = identity;
  let logins = factoryLogins;
  let loginNote = null;
  if (theIdentity === undefined || logins === undefined) {
    // `values()`는 숫자·문자열 두 키에 같은 배열을 담고 있으므로 중복을 접는다(같은 코멘트를 두 번 세지 않는다).
    const allComments = [...new Set([...byIssue.values()])].flat();
    let who = { ok: false, reason: "resolveFactoryLogins was never reached" };
    try { who = await resolveFactoryLogins({ gh, env, comments: allComments }); }
    catch (e) { who = { ok: false, reason: `resolveFactoryLogins threw — ${e?.message || e}` }; }
    if (theIdentity === undefined) theIdentity = who.identity ?? null;
    if (logins === undefined) logins = who.ok ? who.logins : null;
    /**
     * T7 리뷰 should_fix 4 — **못 알아낸 것도 말한다.** 팩토리 계정 이름을 못 얻으면 `attributionFor`는
     * (b)를 통째로 거부한다(모르는 것은 통과가 아니다). 그 거부를 안 적으면 보고서는 "기각 0건"으로
     * 보이고, 그것은 "문제 없음"과 구별되지 않는다 — 이 태스크가 고치는 바로 그 침묵이 한 칸 옆에서
     * 되살아나는 자리다.
     */
    if (!who.ok) {
      loginNote = `factory logins unresolved (${who.reason}) — human-decision attribution cannot be evaluated, so no \`cause: factory-defect\` decision in this window can reach [ktb]`;
      log(`factory: health ${loginNote}`);
    }
  }
  const unverifiable = [];
  for (const n of signals.window) {
    try {
      for (const u of attributionFor({ comments: byIssue.get(n) || [], factoryLogins: logins, identity: theIdentity }).unverifiable) unverifiable.push({ issue: n, ...u });
    } catch { /* 한 이슈의 실패가 보고서를 막지 않는다 */ }
  }

  // 보고서를 실을 **오래 사는** 이슈 하나(본문 마커가 신원, state:all, 닫혀 있으면 다시 연다).
  let reportIssue = null;
  let anchor = null;
  if (publish) {
    try { anchor = await findHealthIssue(gh); reportIssue = anchor?.number ?? null; }
    catch (e) { actions.push(errorAction(`could not look up the health issue — ${e?.message || e}`, { fatal: true })); }
  }

  const { findings, advisories } = behaviouralFindings({ signals, repo, roleFile, anchorIssue: reportIssue });

  // 보고서에 이번 회차의 발견까지 실어 다시 렌더한다 — 사람이 한 화면에서 표와 판정을 같이 본다.
  const body = renderHealthReport({ signals, findings, advisories, rehearsal, now, repo, upstream, identity: theIdentity, unverifiable, loginNote });
  if (publish) {
    try {
      if (reportIssue == null) {
        reportIssue = await gh.createIssue({ title: HEALTH_TITLE, body, labels: [HEALTH_LABEL] });
        actions.push({ kind: "health-issue", step: "health", issue: reportIssue, created: true });
      } else {
        if (anchor?.state === "closed") {
          await gh.reopenIssue(reportIssue);
          actions.push({ kind: "health-reopened", step: "health", issue: reportIssue });
        }
        // 표본 미달 회차는 **바뀐 것이 있을 때만** 적는다(리뷰 r1 should_fix 7): 같은 "표본이 모자랍니다"를
        // 매주 붙이면 그 이슈는 읽히지 않는 이슈가 되고, 정작 첫 진짜 발견도 그 잡음 속에 묻힌다.
        const dup = signals.below_n && sameReport(await latestHealthComment(gh, reportIssue), body);
        if (dup) actions.push({ kind: "health-report-skipped", step: "health", issue: reportIssue, reason: "below sample size and nothing changed since the last run" });
        else {
          await gh.comment(reportIssue, body);
          actions.push({ kind: "health-report", step: "health", issue: reportIssue, created: false });
        }
      }
    } catch (e) { actions.push(errorAction(`could not publish the health report — ${e?.message || e}`, { fatal: true })); }
  }

  // 발견을 만들었으면 **Task 3의 팔**로 보낸다(분류·지문·dedupe·fail-safe는 전부 거기에 있다).
  let classified = [];
  if (findings.length && !manifest) {
    actions.push(errorAction(`install manifest not found (${INSTALL_MANIFEST_PATH}) — ${findings.length} behavioural finding(s) cannot be classified or routed`, { fatal: true }));
  } else if (findings.length && !publish) {
    /**
     * 읽기 전용 회차 — 분류는 하되 라우팅 팔은 **부르지 않는다**. 분류기는 `routeFindings`가 쓰는
     * 바로 그 함수이므로 사람이 화면에서 보는 태그·지문은 워크플로가 실제로 라우팅할 값과 같다.
     * (다르면 이 명령은 그 순간 신뢰를 잃는다 — `analyze.js`의 `classifyAll`과 같은 규율이다.)
     */
    for (const f of findings) {
      try { classified.push(classifyFinding({ finding: f, ownerOf: manifest.ownerOf, isInstalled: manifest.isInstalled, ktbVersion: manifest.ktbVersion, harness })); }
      catch (e) { actions.push(errorAction(`classify failed — ${e?.message || e}`)); classified.push(null); }
    }
    actions.push({ kind: "read-only", step: "health", reason: `publish:false — ${findings.length} finding(s) classified but not routed (no issue opened, no comment written)` });
  } else if (findings.length) {
    // 앵커 이슈는 보고서를 **연 뒤에야** 번호를 얻는다(첫 회차). 창 단위 발견(rubber-stamp)은 그때까지
    // `issue: null`이었으므로 여기서 메운다 — 돌려주는 객체와 라우팅에 넘기는 객체가 달라서는 안 된다.
    for (const f of findings) if (f.issue == null) f.issue = reportIssue;
    const anchored = findings.map((f) => ({ ...f }));
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
      // 라우팅 팔은 fail-safe라 상류 403을 **액션 한 줄로** 삼킨다(회고를 죽이지 않기 위해서다).
      // 건강 잡에는 회고 같은 다른 산출물이 없다 — 그 줄이 곧 이 회차의 실패이므로 위로 올린다.
      for (const a of r.actions || []) if (a.kind === "error") a.fatal = true;
    } catch (e) { actions.push(errorAction(`routing failed — ${e?.message || e}`, { fatal: true })); }
  }
  // 지문을 발견에 되돌려 붙인다 — 보고서를 읽는 사람이 상류 이슈와 같은 열쇠를 손에 쥔다.
  for (let i = 0; i < findings.length; i++) if (classified[i]?.fingerprint) findings[i].fingerprint = classified[i].fingerprint;

  const failures = actions.filter((a) => a.kind === "error" && a.fatal);
  return {
    ok: failures.length === 0, failures,
    below_n: signals.below_n, signals, findings, advisories, classified, actions,
    identity: theIdentity, unverifiable, login_note: loginNote,
    report: body, report_issue: reportIssue,
  };
}

/** 앵커 이슈의 **가장 마지막** 건강 보고서 코멘트 본문(없으면 null). 표본 미달 중복을 막는 재료다. */
async function latestHealthComment(gh, issue) {
  let comments = [];
  try { comments = await gh.comments(issue); } catch { return null; }
  const mine = (comments || []).filter((c) => String(c?.body ?? "").includes(HEALTH_MARKER));
  return mine.length ? String(mine[mine.length - 1].body) : null;
}

/**
 * 두 보고서가 **내용상** 같은가 — 제목 줄의 날짜만 다른 것은 같은 것이다. 날짜까지 비교하면 중복
 * 방지가 영원히 성립하지 않는다(주마다 날짜가 다르므로 언제나 "달라졌다"고 답한다).
 */
export const sameReport = (a, b) => a != null && b != null
  && String(a).replace(/^## factory-health — .*$/m, "").trim() === String(b).replace(/^## factory-health — .*$/m, "").trim();

/**
 * 창의 재료를 모은다. 주입된 스냅샷이 있으면 그대로 쓰고(테스트), 없으면 **gh와 records 브랜치에서**
 * 읽는다 — 회고의 `collectIssues`와 같은 판정 규칙이다.
 *
 * 비용은 `factory/records` 브랜치의 run 기록에만 있다(리뷰 r1 must_fix 1). 그것을 하이드레이트하지
 * 않으면 `cost_by_tier`·`cost_vs_risk`가 통째로 비고, 비용 규칙은 프로덕션에서 **영원히 침묵한다** —
 * 테스트가 records를 주입해 주는 동안에만 초록인 종류의 결함이다. 그래서 여기가 유일한 출처다.
 *
 * 이슈 조회는 `factory:merged`로 좁힌다(nit 9): 창은 "최근 머지된 N개"이고, 머지되지 않은 이슈의
 * 코멘트를 읽는 것은 그냥 API 왕복 낭비다. 라벨이 없는 저장소를 위해 닫힌 이슈로 한 번 더 물러선다.
 */
async function collect({ gh, run: runner = run, cwd = null, issues, commentsByIssue, records, prByIssue, since, log = console.error }) {
  if (issues) {
    return {
      issues, commentsByIssue: commentsByIssue || new Map(), records: records || new Map(),
      prByIssue: prByIssue || new Map(), records_source: "injected",
    };
  }

  const withState = (list) => (list || []).map((i) => ({ ...i, state: i.closedAt ? "closed" : "open" }));
  let all = [];
  try { all = withState(await gh.issueList({ labels: [MERGED_LABEL], state: "all", limit: 200 })); }
  catch (e) { log(`factory: health could not list ${MERGED_LABEL} issues — ${e?.message || e}`); }
  if (!all.length) {
    try { all = withState(await gh.issueList({ state: "closed", limit: 200 })); }
    catch (e) { log(`factory: health could not list closed issues — ${e?.message || e}`); }
  }

  const sinceMs = since == null ? null : Date.parse(since);
  const by = new Map();
  const prs = new Map();
  for (const i of all) {
    if (!afterSince(i.closedAt, sinceMs)) continue;
    try { by.set(i.number, await gh.comments(i.number)); }
    catch (e) { log(`factory: health could not read comments on #${i.number} — ${e?.message || e}`); }
    /**
     * 머지된 PR과 그 파일 목록 — **diff 모양**의 유일한 출처(r2 항목 1). builder는 언제나
     * `claude/fq-<issue>`에서 작업하므로 브랜치 이름이 곧 이슈 번호다(implement 규칙 1). 어느
     * 단계든 실패하면 그 이슈의 모양은 **미상**이고, 미상은 미상으로 보고된다 — 라벨을 보고
     * "아마 docs였겠지"라고 메우는 순간 이 두 번째 출처의 존재 이유가 사라진다(r2 항목 4).
     */
    try {
      // **머지된 PR 전부**다(r3 should_fix 2). 재작업은 같은 브랜치에 PR을 두 번 머지할 수 있고,
      // 그때 diff의 모양은 둘을 **합친** 것이다 — 첫 PR만 보면 docs만 고친 것처럼 보인다.
      const merged = await gh.mergedPrsForBranch(`claude/fq-${i.number}`);
      if (!merged.length) { log(`factory: health found no merged PR on claude/fq-${i.number} — diff shape unknown for #${i.number}`); continue; }
      const union = new Set();
      for (const m of merged) for (const f of await gh.prFiles(m.number)) union.add(f);
      prs.set(i.number, { pr: merged[0].number, prs: merged.map((m) => m.number), files: [...union] });
    } catch (e) { log(`factory: health could not read the PR file list for #${i.number} — ${e?.message || e}`); }
  }

  // run 기록 — 회고와 **같은 읽기**다(`readRecordsDetailed`). 못 읽으면 비용 신호가 없는 것이고,
  // 그 사실을 `records_source`로 위에 올린다(지어낸 0으로 채우지 않는다).
  let recs = records || new Map();
  let source = records ? "injected" : "none";
  if (!records) {
    try {
      const r = await readRecordsDetailed({ run: runner, cwd: cwd ?? "." });
      // 출처 낱말은 라우팅 팔과 **같은 함수**에서 나온다(r1 should_fix 2) — 두 벌이면 같은 창을
      // 두 도구가 다르게 설명한다.
      source = recordsSourceOf(r);
      if (source === "records-branch") recs = r.records;
      for (const f of r.failures || []) log(`factory: health could not read a run record — ${f?.reason ?? f}`);
    } catch (e) { source = "records-branch-unreadable"; log(`factory: health could not hydrate the records branch — ${e?.message || e}`); }
  }
  return { issues: all, commentsByIssue: by, records: recs, prByIssue: prs, records_source: source };
}

/** `--n=`/`--since=` — 두 호출자(워크플로와 CLI)가 **같은 문법**을 읽는다. */
export function parseHealthArgv(argv = []) {
  const nArg = (argv || []).find((a) => a.startsWith("--n="));
  const sinceArg = (argv || []).find((a) => a.startsWith("--since="));
  return {
    N: nArg ? Math.max(1, Number(nArg.slice("--n=".length)) || DEFAULT_N) : DEFAULT_N,
    since: sinceArg ? sinceArg.slice("--since=".length) || null : null,
  };
}

/**
 * `assembleHealth({...}) → { ok, dormant?, reason?, deps }` — **실제 의존성 조립, 단 한 벌**.
 *
 * ── 최종 리뷰 must_fix 1 ────────────────────────────────────────────────────────────────────
 * `runHealth`는 gh·하네스·설치 매니페스트·역할 파일 맵·리허설 상태를 **전부 주입받는** 순수
 * 오케스트레이션이다. 그 조립이 `main()` 안에만 있었기 때문에 `factory analyze --health`는
 * `runHealth({root, argv, io, run})`를 맨손으로 불렀고 — `gh`가 `undefined`라 `collect`의 첫 줄에서
 * 터진 뒤 `TypeError: Cannot read properties of undefined (reading 'issueList')` 한 줄만 stderr로
 * 떨어지고 stdout은 0바이트, 종료 코드는 0이었다. 조립이 두 벌이면 언제나 한 벌이 썩는다.
 * 그래서 조립은 **이 함수 하나**이고 호출자는 둘이다(워크플로의 `main()`과 CLI의 `healthCommand`).
 *
 * 어떤 자리도 쓰기를 하지 않는다 — 읽기만으로 조립되므로 노트북에서도 그대로 돈다.
 */
export async function assembleHealth({
  root = null, argv = [], run: runner = run, env = process.env, log = console.error,
} = {}) {
  const { N, since } = parseHealthArgv(argv);
  /**
   * #36 item 5 — **어느 스텝이 실패했는지를 이름으로 말한다.** 예전에는 이 두 줄 중 어느 것이 던져도
   * 호출자가 `could not assemble the health aggregation — <raw error>` 한 줄만 냈다. `HTTP 401: Bad
   * credentials`만 보고는 `git rev-parse`인지 `gh repo view`인지, 곧 **작업 트리가 없는 것인지 토큰이
   * 죽은 것인지** 사람이 가릴 수 없다 — 그 둘은 고치는 자리가 다르다.
   */
  const step = async (what, fn) => {
    try { return await fn(); }
    catch (e) { throw new Error(`${what} failed — ${e?.message || e}`); }
  };
  const theRoot = root || (await step("git rev-parse --show-toplevel", async () => (await runner("git", ["rev-parse", "--show-toplevel"])).stdout.trim()));
  const repo = env?.FACTORY_REPO || await step("gh repo view --json nameWithOwner", async () => JSON.parse((await runner("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner);
  const gh = makeGh({ run: runner, repo });

  let charter;
  let harness;
  let roles;
  try { charter = loadCharter(theRoot); harness = loadHarness(theRoot); }
  catch (e) { return { ok: false, dormant: true, reason: `health dormant — ${e.message}` }; }
  if (charter.status !== "ready") return { ok: false, dormant: true, reason: `CHARTER status is ${charter.status} — health dormant` };
  try { roles = loadRoles(theRoot); } catch { roles = {}; }

  const manifest = await loadInstallManifest(theRoot);
  if (!manifest) log(`factory: ${INSTALL_MANIFEST_PATH} not found — behavioural findings will not be routed (run \`npx know-thy-build factory init --upgrade\`)`);

  // 저장소 수준의 리허설 상태 — 건강 줄 하나다(발견이 아니다).
  let rehearsal = null;
  try {
    const readText = (p) => (existsSync(join(theRoot, p)) ? readFileSync(join(theRoot, p), "utf8") : null);
    const harnessText = readText(FINGERPRINT_PATHS[0]);
    const current = harnessText == null ? null : rehearsalHash({ harnessText, charterText: readText(FINGERPRINT_PATHS[1]) || "" });
    const branch = harness.project?.default_branch ?? "main";
    rehearsal = rehearsalGate({ recorded: await recordedRehearsal({ gh, branch, current }), current });
  } catch (e) { log(`factory: health could not read the rehearsal record — ${e?.message || e}`); }

  const roleFile = new Map([...roleFileMap(roles)].map(([k, v]) => [k, v.agent]));
  return {
    ok: true,
    deps: {
      gh, root: theRoot, repo, N, since, run: runner,
      harness, manifest, roleFile, upstream: upstreamRepoOf(harness), rehearsal,
      // 조립이 본 바로 그 `env`를 싣는다 — `runHealth`가 주변 환경을 다시 읽는 일이 없게(핫픽스).
      env,
    },
  };
}

/**
 * `factory analyze --health`의 **진짜 진입점**(리뷰 must_fix 1). `analyze.js`는 이 이름 하나만
 * import한다 — 예전의 세 이름 탐침(`healthCommand ?? runHealth ?? healthReport`)은 "있는 것 중
 * 아무거나"를 불렀고, 실제로 걸린 것은 시그니처가 전혀 다른 `runHealth`였다.
 *
 * 계약 셋:
 *   ① **`publish: false`를 언제나 넘긴다.** 조건부가 아니다 — 이 명령은 노트북에서 도는 읽기 전용
 *      보고이고, README가 "이슈를 열지 않는다"고 적어 둔 그 명령이다. `runHealth`에서 그 깃발은
 *      이슈 생성·코멘트·재오픈과 라우팅 팔 **전부**를 닫는다.
 *   ② `--json`이면 신호·발견·참고 신호·신원을 기계가 읽는 한 덩어리로 낸다(보고서 마크다운도 함께).
 *   ③ 보고서는 `io.out`으로, 진단은 `io.err`로. 종료 코드는 CLI의 나머지와 같다 — 보고서를 낸 회차는 0.
 */
export async function healthCommand({
  root = null, argv = [], io, run: runner = run, env = process.env,
  assemble = assembleHealth, aggregate = runHealth,
} = {}) {
  const json = (argv || []).includes("--json");
  let assembled;
  try { assembled = await assemble({ root, argv, run: runner, env, log: io.err }); }
  catch (e) {
    io.err(`factory analyze --health: could not assemble the health aggregation — ${e?.message || e}`);
    return 1;
  }
  if (!assembled?.ok) {
    /**
     * 휴면(CHARTER가 ready가 아니다, 하네스를 못 읽는다)은 **이 명령의 실패가 아니다** — 저장소의
     * 상태다. 워크플로의 `main()`이 exit 0으로 지나가는 것과 같은 판정을 하되, 조용히 0바이트를
     * 내는 짓은 하지 않는다: 사람이 읽을 한 줄을 stdout에 낸다(그 침묵이 이 태스크가 고친 버그다).
     */
    const reason = assembled?.reason || "health dormant";
    if (json) io.out(JSON.stringify({ schema: "factory.health.v1", ok: false, dormant: true, reason }, null, 2));
    else io.out(`factory-health: ${reason}`);
    return 0;
  }

  // `publish: false`는 **마지막에** 온다 — 조립이 무엇을 담아 오든 이 자리에서 덮어쓴다.
  const r = await aggregate({ ...assembled.deps, publish: false, log: io.err });

  if (json) {
    io.out(JSON.stringify({
      schema: "factory.health.v1",
      ok: r.ok, below_n: r.below_n, published: false, report_issue: null,
      repo: assembled.deps.repo, N: assembled.deps.N, since: assembled.deps.since,
      signals: r.signals, findings: r.findings, advisories: r.advisories, classified: r.classified,
      identity: r.identity, unverifiable: r.unverifiable, login_note: r.login_note,
      actions: r.actions, failures: r.failures,
      ktb_version: assembled.deps.manifest?.ktbVersion ?? null,
      report: r.report,
    }, null, 2));
    return 0;
  }

  for (const line of String(r.report ?? "").split("\n")) io.out(line);
  io.out("");
  io.out(`read-only: no issue was opened, no comment was written, nothing was routed (window ${r.signals.window.length}/${assembled.deps.N}, records ${r.signals.records_source})`);
  for (const f of r.failures || []) io.err(`factory analyze --health: ${f.reason}`);
  return 0;
}

/** CLI 진입: 워크플로가 부르는 자리 — 조립은 `assembleHealth` 한 벌을 그대로 쓴다(쓰기는 켠다). */
async function main() {
  const argv = process.argv.slice(2);
  const assembled = await assembleHealth({ argv });
  if (!assembled.ok) { console.error(`factory: ${assembled.reason}`); process.exit(0); }
  const { root, N } = assembled.deps;
  const r = await runHealth(assembled.deps);

  // 산출물을 **파일로** 떨어뜨린다(nit 10) — 그러지 않으면 워크플로의 scrub·upload 스텝이 빈 디렉터리
  // 위를 도는 no-op이고, 실패한 회차를 사후에 들여다볼 것이 아무것도 남지 않는다.
  writeHealthOutputs(root, r);

  for (const a of r.actions) console.log(`health: ${a.kind}${a.issue == null ? "" : ` #${a.issue}`}${a.reason ? ` — ${a.reason}` : ""}`);
  const summary = `health: ${r.below_n ? `below sample size (${r.signals.window.length}/${N})` : `${r.findings.length} behavioural finding(s)`} over the last ${N} merged issues`
    + `; evidence ${r.signals.attributable}/${r.signals.window.length} attributable; records ${r.signals.records_source}`
    + (r.advisories.length ? `; ${r.advisories.length} advisory (not routed)` : "");
  console.log(summary);
  stepSummary(`## factory-health\n\n${summary}\n\n${r.failures.map((f) => `- **failed:** ${f.reason}`).join("\n")}\n`, { what: "factory-health" });

  /**
   * 설정·권한 실패는 **소리내어 죽는다**(리뷰 r1 should_fix 7). 상류 토큰에 `issues:write`가 없거나
   * `factory:health` 라벨이 없으면 루프는 한 줄도 나르지 못하는데, exit 0 + stdout 한 줄로 끝나면
   * 초록 체크 표시만 주마다 쌓인다 — 아무도 보지 않는 잡의 침묵이 고장의 증상과 똑같아진다.
   */
  healthFailureAnnotations(r.failures);
  process.exit(r.ok ? 0 : 1);
}

/**
 * #36 item 5 — 설정·권한 실패의 **주석 한 줄**. 형식은 `errorAnnotation` 한 곳에서만 만든다:
 * 예전에는 이 호출자가 `::error title=factory-health::…`를 손으로 조립했고, 그러면 그 형식이 바뀌는
 * 날 여기만 뒤처진다 — 그리고 그 드리프트는 러너에서만 보인다(`HARNESS_LABEL`이 끝낸 그 모양).
 * 워크플로 명령은 **한 줄**이어야 하므로 개행 접기도 그 함수의 계약이다.
 */
export const healthFailureAnnotations = (failures = [], { out } = {}) =>
  (failures || []).map((f) => errorAnnotation("factory-health", f?.reason ?? f, out ? { out } : {}));

/** 보고서(마크다운)와 신호(JSON)를 `.factory/out/health/`에 남긴다. 실패해도 잡을 죽이지 않는다. */
export function writeHealthOutputs(root, r, { log = console.error } = {}) {
  const dir = join(root, ".factory/out/health");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), `${r.report}\n`);
    writeFileSync(join(dir, "signals.json"), `${JSON.stringify({
      schema: "factory.health.v1",
      ok: r.ok, below_n: r.below_n, report_issue: r.report_issue,
      signals: r.signals, findings: r.findings, advisories: r.advisories,
      actions: r.actions, failures: r.failures,
    }, null, 2)}\n`);
    return dir;
  } catch (e) { log(`factory: health could not write ${dir} — ${e?.message || e}`); return null; }
}

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
