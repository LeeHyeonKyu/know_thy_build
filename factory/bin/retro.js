#!/usr/bin/env node
// retro 잡(§8.1/§8.3/§8.4) — 라벨 상태 머신 밖에서 **머지 이벤트로만** 깨어난다(P4-R5).
// 매 머지마다 경량 수확(결정적, LLM 없음)을 하고, 누적 머지가 N에 도달하면 전체 retro를 돈다:
// `claude -p "/factory-retro"`가 후보를 보고 `factory.retro.v1`로 제안을 내놓고, **채택 여부는 전부
// 여기(L1)가 판정한다**(P4-R4 — 에이전트가 "채택"이라 해도 근거를 세지 못하면 채택하지 않는다).
//
// 세 가지 불변식:
//  1. **retro는 절대 라벨을 옮기지 않고 코드를 고치지 않는다.** 산출은 lessons/역할 예시·관점의 다크
//     append PR(자체 머지), 사람이 머지하는 제안 PR, 이슈 생성, `quarantine.toml`·`_retro.md` 갱신뿐이다.
//  2. **retro 실패는 공장을 멈추지 않는다.** 전체 분석이 죽거나 스키마를 어기면 `_retro.md`에
//     `last_full_failed`를 남기고 exit 0으로 물러난다 — `merges_since`를 리셋하지 않으므로 다음 머지가
//     다시 시도한다. 집행 단계도 각각 격리돼서, 한 단계의 실패가 나머지 단계를 막지 않는다.
//  3. **`_retro.md`의 이력은 조용히 리셋되지 않는다.** 상태 파일이 손상됐으면(파서가 던진다) 아무것도
//     쓰지 않고 exit 2로 사람을 부른다 — 덮어쓰면 누적 통계·N 조정 이력·후보 목록이 통째로 사라진다.
//
// 모든 외부 접촉(fs·git·gh·claude)은 `deps`로 주입된다 — `runRetro`는 순수 오케스트레이션이고,
// `main()`이 실제 의존성을 조립한다(bin/run-stage.js와 같은 형태).

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { loadCharter, loadHarness, loadRoles } from "../lib/config.js";
import { loadQuarantine, saveQuarantine } from "../lib/quarantine.js";
import { readRecords, syncRecords } from "../lib/records-branch.js";
import { validate } from "../lib/schemas.js";
import { extractJson } from "../lib/verify-stage.js";
import { harvest as harvestRecords, mergeCandidates } from "../lib/retro/harvest.js";
import { applyLessons as applyLessonsText } from "../lib/retro/lessons.js";
import { detectMaturityGaps } from "../lib/retro/maturity.js";
import { filterByEvidence, renderProposalPr } from "../lib/retro/proposals.js";
import { openAndMergeLessonsPr, openProposalPr } from "../lib/retro/publish.js";
import {
  deletionCandidates, expiredFromComments, quarantineComment,
  registerFromFlakyIssues, rewriteIssuesForExpired,
} from "../lib/retro/quarantine-ops.js";
import { applyRoleAdditions as applyRoleAdditionsText } from "../lib/retro/role-additions.js";
import { nextN, parseRetroState, renderRetroState, shouldRunFull } from "../lib/retro/state.js";

const QUEUE_LABEL = "factory:queue";
const HARNESS_LABEL = "factory:harness";
const MIN_EVIDENCE = 2;                                               // lesson·예시·관점의 최소 근거 run(§8.4)
const TITLE_MAX = 240;                                                // GitHub 이슈 제목 여유 — 자르기는 결정적이라 dedup을 깨지 않는다

const EMPTY_CANDIDATES = { lessons: [], examples: [], flaky: [], needs_human: [] };

/** `now`(ISO)를 브랜치·파일 이름에 쓰는 `YYYY-MM-DD-HHMM`으로. UTC로만 — 러너의 TZ와 무관하게 같은 값. */
export function stampOf(now) {
  const t = Date.parse(now);
  const d = Number.isFinite(t) ? new Date(t) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}
/** lesson id(`L-YYYY-MM-DD-NN`)의 날짜 부분. */
export const todayOf = (now) => stampOf(now).slice(0, 10);

/**
 * 제안 PR의 기간은 **날짜**로 쓴다(§8.3 `period=2026-09-01..2026-09-07`) — 커서는 delta 계산을 위해
 * 타임스탬프지만, 사람이 읽는 PR 제목·본문과 `proposals.js`의 ISO 주 계산(`isoWeek`)은 `YYYY-MM-DD`를
 * 전제한다. 타임스탬프를 그대로 넘기면 주차가 계산되지 않고 제목이 기계 문자열이 된다.
 */
export const ymdOf = (v) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? ""));
  return m ? m[1] : todayOf(v);
};

/** 서로 다른 근거 run 수 — `String(r)`로 정규화한다(에이전트가 110과 "110"을 섞어도 창은 한 번만 찬다). */
export const distinctRuns = (runs) => new Set((Array.isArray(runs) ? runs : []).map((r) => String(r))).size;

/**
 * 성숙도 격차 이슈의 제목. `target`이 있으면 §5.2.1의 승격 제목(`harness: promote to M<n> — <reason>`)
 * 그대로 — 이 문자열이 dedup 키다. `target`이 null인 규칙(외부 SDK에 fake가 없음)은 **승격이 아니라
 * 경고**라 "promote to null"이 될 수 없으므로 규칙 이름으로 제목을 만든다(dedup 키는 여전히 제목이다).
 */
export const gapTitle = (gap) =>
  (gap?.target ? `harness: promote to ${gap.target} — ${gap.reason}` : `harness: ${gap?.rule} — ${gap?.reason}`).slice(0, TITLE_MAX);

const gapBody = (gap, agentReason) => [
  `결정적 감지(\`lib/retro/maturity.js\`, 규칙 \`${gap?.rule}\`)가 성숙도 격차를 찾았습니다(§5.2.1).`,
  "",
  `- 감지 근거: ${gap?.reason}`,
  `- 목표 성숙도: ${gap?.target ?? "(승격 아님 — 하네스 보완)"}`,
  ...(agentReason ? ["", `retro 분석가의 설명: ${agentReason}`] : []),
  "",
  "이 이슈는 retro가 만들었고 라벨을 옮기지 않습니다 — 큐에 들어간 뒤 정상적인 스테이지가 처리합니다.",
].join("\n");

/** `_retro.md` 위쪽에 사람이 먼저 읽는 통계 표(§8.3 "통계" 절과 같은 수치). */
export function statsTable(stats) {
  const s = stats || {};
  const usage = s.usage || {};
  const tokens = usage.tokens || {};
  const rejects = Object.entries(s.rejects_by_role || {});
  return [
    "| metric | value |",
    "| --- | --- |",
    `| merged | ${s.merged ?? 0} |`,
    `| review rounds avg | ${s.review_rounds_avg ?? 0} |`,
    `| needs-human | ${s.needs_human ?? 0} |`,
    `| rejects by role | ${rejects.length ? rejects.map(([r, n]) => `${r} ${n}`).join(", ") : "없음"} |`,
    `| cost (usd) | ${Number(usage.cost_usd || 0).toFixed(2)} |`,
    `| tokens | input ${tokens.input || 0} / output ${tokens.output || 0} |`,
  ].join("\n");
}

const byRole = (items) => {
  const map = new Map();
  for (const it of items || []) {
    const role = it?.role;
    if (!role) continue;
    if (!map.has(role)) map.set(role, []);
    map.get(role).push(it);
  }
  return map;
};

/**
 * `runRetro({ deps, force, now }) → 0 | 1 | 2`
 *   0 = 정상(경량 수확만 했든, 전체 retro를 돌았든, 전체 분석이 실패해 다음 머지로 넘겼든)
 *   1 = 예상하지 못한 중단(오케스트레이션 자체가 터졌다 — 상태는 최선의 범위에서 저장한다)
 *   2 = `_retro.md`가 손상됐다(사람이 봐야 한다 — 아무것도 쓰지 않는다)
 *
 * `force`(`factory run retro --force`)는 두 가지를 바꾼다: N을 무시하고 전체 retro를 돌리고,
 * `merges_since`를 **올리지 않는다**(사람이 손으로 돌린 실행은 머지 이벤트가 아니다).
 */
export async function runRetro({ deps, force = false, now } = {}) {
  const d = deps;
  const at = now ?? d.now ?? new Date().toISOString();
  const record = (line) => { try { d.record(line); } catch (e) { console.error(`factory: retro record failed — ${e?.message || e}`); } };
  const applied = [];
  /** 집행 단계 격리 — 한 단계의 실패는 `applied`에 남고 나머지 단계는 그대로 진행한다. */
  const step = async (name, fn) => {
    try { return { ok: true, value: await fn() }; }
    catch (e) {
      const error = String(e?.message || e);
      applied.push({ step: name, error });
      record(`retro: ${name} failed — ${error}`);
      return { ok: false, error };
    }
  };

  let state = null;
  const persist = async () => {
    if (!state) return;
    try { await d.writeState(state, { statsTable: statsTable(state.stats) }); }
    catch (e) { record(`retro: _retro.md write failed — ${e?.message || e}`); }
    try {
      const s = await d.sync();
      if (s && s.ok === false) record(`retro: records sync failed — ${s.reason}`);
    } catch (e) { record(`retro: records sync aborted — ${e?.message || e}`); }
  };

  try {
    // ① hydrate — records 브랜치의 run 기록과 `_retro.md`를 로컬로 복원한다. 이게 없으면 fresh
    // checkout에서 상태가 "처음 실행"으로 보이고, 이어지는 sync가 브랜치의 누적 이력을 덮어쓴다.
    let hydrated = null;
    try { hydrated = await d.hydrate(); }
    catch (e) { record(`retro: hydrate failed — ${e?.message || e}`); }

    // ② 상태 — 파서가 던지면 절대 덮어쓰지 않는다(손상된 `_retro.md`는 사람의 몫이다).
    try { state = await d.readState(); }
    catch (e) {
      console.error(`factory: retro aborted — ${e?.message || e}`);
      record(`retro: _retro.md unreadable — ${e?.message || e}`);
      return 2;
    }
    state.cursor = state.cursor || { last_retro_at: null, last_record_offsets: {} };
    state.candidates = state.candidates || { ...EMPTY_CANDIDATES };
    state.history = Array.isArray(state.history) ? state.history : [];
    // N이 숫자가 아니거나 1 밑이면(손으로 고친 상태 파일, 옛 형식) 1로 되돌린다 — 0이나 NaN이면
    // shouldRunFull이 매 머지마다 full을 돌리거나 영원히 돌리지 않는다. 조용히 넘기지 않고 기록한다.
    if (!Number.isFinite(state.n) || state.n < 1) {
      record(`retro: n was ${JSON.stringify(state.n)} — reset to 1`);
      state.n = 1;
    }
    if (!Number.isFinite(state.merges_since) || state.merges_since < 0) state.merges_since = 0;

    // ③ 머지 카운터 — 트리거가 머지 이벤트일 때만 올린다.
    if (!force) state.merges_since += 1;

    // ④ 경량 수확(§8.4) — 마지막 retro 커서 이후만 본다. 실패해도 물러나지 않는다: 수확이 비면
    // 이번 머지의 후보가 없을 뿐이고, 후보는 `_retro.md`에 누적되므로 다음 머지가 다시 본다.
    const since = state.cursor.last_retro_at ?? null;
    let h = { candidates: { ...EMPTY_CANDIDATES }, stats: null, issues: [], commentsByIssue: new Map(), first: null };
    const harvested = await step("harvest", () => d.harvest({ since, records: hydrated?.records }));
    if (harvested.ok && harvested.value) h = { ...h, ...harvested.value };
    state.candidates = mergeCandidates(state.candidates, h.candidates);
    // 통계는 **창(since..now)의 값으로 교체**한다 — 누적으로 더하면 커서가 움직이지 않는 경량 실행이
    // 매 머지마다 같은 창을 다시 더해 이중 집계가 된다(delta의 단위는 창이지 실행이 아니다, §8.4).
    if (h.stats) state.stats = h.stats;

    // ⑤ full인가 — `force`는 N을 무시한다.
    const decision = await d.shouldRunFull({ state, force });
    if (!decision?.full) {
      record(`retro: light (merges_since=${state.merges_since}/${state.n})`);
      await persist();
      return 0;
    }

    // ⑥ 전체 분석 — 후보 파일을 쓰고 `claude -p "/factory-retro"`를 부른다(full일 때만 토큰을 쓴다).
    const period = { from: since ?? h.first ?? at, to: at };
    let envelope = null;
    // history는 복사해서 넘긴다 — 후보 파일은 이 호출 시점의 스냅샷이어야 하고(이 실행의 이력 항목은
    // 아직 만들어지지도 않았다), 에이전트 쪽 코드가 상태 배열을 건드릴 길을 아예 두지 않는다.
    const called = await step("claude-p", () => d.claudeP({ period, candidates: state.candidates, stats: state.stats, history: [...state.history] }));
    if (called.ok) envelope = called.value;
    const out = envelope && !envelope.is_error ? extractJson(envelope.result) : null;
    const v = out ? validate("retro.v1", out) : { ok: false, errors: [envelope ? (envelope.is_error ? "claude -p reported is_error" : "no JSON object in result") : (called.error || "claude -p failed")] };
    if (!v.ok) {
      const reason = v.errors.join("; ");
      // 실패를 상태에 남기지만 `merges_since`는 리셋하지 않는다 — 다음 머지가 다시 전체 retro를 돈다.
      state.last_full_failed = { at, reason };
      record(`retro: full analysis failed — ${reason} (retrying on the next merge)`);
      await persist();
      return 0;
    }
    delete state.last_full_failed;

    // ⑦ 집행 — 각 단계는 격리되고, 결과는 `applied`에 쌓여 `_retro.md` 이력에 남는다.
    const files = {};                                                 // 다크 PR에 실릴 변경 파일: 경로 → 새 전문
    let addedLessons = 0;
    let addedRoleItems = 0;
    let harnessIssues = 0;

    // (a) lesson — 역할별로 한 번. 근거 run ≥2(서로 다른 이슈)는 `applyLessons`가 다시 센다.
    for (const [role, items] of byRole(out.lessons)) {
      const r = await step(`lessons:${role}`, () => d.applyLessons({
        role,
        adopted: items.map((i) => ({ text: i.text, evidence_runs: i.evidence_runs })),
        today: todayOf(at),
        minEvidence: MIN_EVIDENCE,
      }));
      if (!r.ok || !r.value) continue;
      const res = r.value;
      applied.push({ step: `lessons:${role}`, added: (res.added || []).map((a) => a.id), rejected: res.rejected || [], evicted: res.evicted || [] });
      addedLessons += (res.added || []).length;
      // 실제로 바뀐 파일만 PR에 싣는다 — 채택이 하나도 없으면 `applyLessons`는 원문을 바이트 그대로
      // 돌려주므로, 넣어도 빈 diff가 되고 "변경 없음" 커밋이 실패한다.
      if (res.path && ((res.added || []).length || (res.evicted || []).length)) files[res.path] = res.text;
    }

    // (b) 역할 예시·관점 — 에이전트 파일별로 한 번. 근거 창은 `applyRoleAdditions`가 보지 않으므로
    // (그 모듈은 섹션·상한·중복만 본다) 여기서 L1이 센다.
    const roleItems = new Map();
    const push = (role, key, item) => {
      if (!role) return;
      if (!roleItems.has(role)) roleItems.set(role, { examples: [], perspectives: [], deferred: [] });
      roleItems.get(role)[key].push(item);
    };
    for (const x of out.examples || []) {
      if (distinctRuns(x?.evidence_runs) < MIN_EVIDENCE) { push(x?.role, "deferred", { kind: x?.kind, text: x?.text, reason: "insufficient-evidence" }); continue; }
      push(x?.role, "examples", { kind: x.kind, text: x.text });
    }
    for (const p of out.perspectives || []) {
      if (distinctRuns(p?.evidence_runs) < MIN_EVIDENCE) { push(p?.role, "deferred", { kind: "perspectives", text: p?.text, reason: "insufficient-evidence" }); continue; }
      push(p?.role, "perspectives", { text: p.text });
    }
    for (const [role, { examples, perspectives, deferred }] of roleItems) {
      if (!examples.length && !perspectives.length) { applied.push({ step: `role:${role}`, added: [], deferred }); continue; }
      const r = await step(`role:${role}`, () => d.applyRoleAdditions({ role, examples, perspectives }));
      if (!r.ok || !r.value) continue;
      const res = r.value;
      applied.push({ step: `role:${role}`, added: res.added || [], skipped: res.skipped || [], deferred });
      addedRoleItems += (res.added || []).length;
      if (res.path && (res.added || []).length) files[res.path] = res.text;
    }

    // (c) 다크 PR — 바뀐 파일이 하나라도 있을 때만. integrity GREEN이면 스스로 머지한다(P4-R2).
    let lessonsPr = null;
    if (Object.keys(files).length) {
      const r = await step("publish-lessons", () => d.publishLessons({ files, date: stampOf(at) }));
      if (r.ok) {
        lessonsPr = r.value;
        applied.push({ step: "publish-lessons", pr: lessonsPr?.pr ?? null, merged: lessonsPr?.merged ?? false, reason: lessonsPr?.reason ?? null, files: Object.keys(files) });
      }
    }

    // (d) 성숙도 승격 이슈 — 판정은 결정적(§5.2.1), 에이전트는 이유 문장만 보탠다. 제목으로 dedup한다
    // (열려 있는 이슈만 — 닫힌 이슈는 이미 처리됐다는 뜻이라 새 격차는 새 이슈를 받아야 한다).
    const openIssues = (h.issues || []).filter((i) => i?.state !== "closed");
    const openTitles = new Set(openIssues.map((i) => String(i?.title ?? "").trim()));
    const gapsRes = await step("maturity", () => d.maturityGaps());
    for (const gap of (gapsRes.ok && gapsRes.value) || []) {
      const title = gapTitle(gap);
      if (openTitles.has(title)) { applied.push({ step: "harness", title, skipped: "duplicate" }); continue; }
      const agentReason = (out.harness || []).find((x) => x?.target === gap?.target)?.reason;
      const r = await step(`harness:${gap?.rule}`, () => d.createIssue({ title, body: gapBody(gap, agentReason), labels: [QUEUE_LABEL, HARNESS_LABEL] }));
      if (!r.ok) continue;
      openTitles.add(title);                                          // 같은 실행에서 같은 제목을 두 번 만들지 않는다
      harnessIssues += 1;
      applied.push({ step: "harness", title, issue: r.value ?? null });
    }

    // (e) flaky 격리 등록(§5.2.5-⑤, P4-R3) — 등록은 `quarantine.toml` 저장 + 이슈 코멘트까지 한 단계다.
    const reg = await step("quarantine-register", () => d.registerQuarantine({ issues: h.issues, commentsByIssue: h.commentsByIssue, now: at }));
    const registered = (reg.ok && reg.value?.registered) || [];
    if (registered.length) applied.push({ step: "quarantine-register", registered });

    // (f) TTL 만료 → "다른 레벨에서 다시 쓰라"는 이슈. 만료 사실은 sweeper가 flaky 이슈에 남긴
    // `<!-- factory-quarantine expired id=… -->` 코멘트에만 있다(`quarantine.toml`에는 이미 없다).
    const exp = await step("quarantine-expired", () => d.expiredIds({ issues: h.issues, commentsByIssue: h.commentsByIssue, since }));
    const expired = (exp.ok && exp.value) || [];
    for (const draft of rewriteIssuesForExpired({ expired, openIssues })) {
      const r = await step("rewrite-issue", () => d.createIssue(draft));
      if (r.ok) applied.push({ step: "rewrite-issue", title: draft.title, issue: r.value ?? null });
    }

    // (g) 삭제 후보 — 재작성 이슈가 다시 needs-human에 도달한 것. 삭제는 조용히 일어나지 않는다:
    // `_retro.md`에 후보로 남기고 **제안 PR**(사람 머지)의 `test-delete` 항목으로 낸다(§5.2.5-④).
    const deletions = deletionCandidates({ issues: h.issues, commentsByIssue: h.commentsByIssue });
    state.deletion_candidates = deletions;
    const deletionProposals = deletions.map((x) => ({
      kind: "test-delete",
      title: `test-delete: ${x.id}`,
      body: [
        `격리된 테스트 \`${x.id}\`는 다른 레벨에서 다시 쓰라는 이슈(#${x.issue})마저 \`factory:needs-human\`에 도달했습니다.`,
        "이 동작을 어느 테스트가 대신 지킬지 정하고, 그것이 없다면 이 삭제를 승인하지 마세요 — 마지막 증명을 지우는 것은 단순화가 아닙니다(§5.2.5-④).",
      ].join("\n"),
      evidence_runs: [x.issue],
    }));

    // (h) 제안 PR — 최소 근거 창(§8.4)은 L1이 센다. 미달 제안은 버리지 않고 상태에 남긴다.
    const { accepted, deferred } = filterByEvidence([...(out.proposals || []), ...deletionProposals]);
    state.deferred_proposals = deferred.map((x) => x.proposal);
    if (deferred.length) applied.push({ step: "proposals", deferred: deferred.map((x) => ({ kind: x.proposal?.kind, title: x.proposal?.title, reason: x.reason })) });
    let proposalPr = null;
    if (accepted.length) {
      const { title, body } = renderProposalPr({ period: { from: ymdOf(period.from), to: ymdOf(period.to) }, proposals: accepted, stats: state.stats });
      const date = stampOf(at);
      const r = await step("publish-proposal", () => d.publishProposal({ files: { [`docs/factory/retro/${date}.md`]: body }, title, body, date }));
      if (r.ok) {
        proposalPr = r.value;
        applied.push({ step: "publish-proposal", pr: proposalPr?.pr ?? null, reason: proposalPr?.reason ?? null, proposals: accepted.map((p) => p.kind) });
      }
    }

    // ⑧ yield → N 자가 조정 → 이력 → 커서 전진(§8.4). PR이 실제로 열리지 않았으면(번호 없음) 세지 않는다.
    const proposalCount = proposalPr && proposalPr.pr != null ? 1 : 0;
    const y = addedLessons + addedRoleItems + harnessIssues + proposalCount;
    const needsHumanSince = Number(state.stats?.needs_human ?? 0) || 0;
    const bounds = d.nBounds || { min: 1, max: Infinity };
    const nBefore = state.n;
    const nAfter = nextN(nBefore, { yield: y, needsHumanSince }, bounds);
    state.n = nAfter;
    state.history.push({ at, yield: y, n_before: nBefore, n_after: nAfter, needs_human_since: needsHumanSince, applied });
    state.merges_since = 0;
    state.cursor = { ...state.cursor, last_retro_at: at };
    record(`retro: full — yield=${y} (lessons ${addedLessons}, role items ${addedRoleItems}, harness ${harnessIssues}, proposal PR ${proposalCount}) · n ${nBefore}→${nAfter}`);
    await persist();
    return 0;
  } catch (e) {
    console.error(`factory: retro aborted — ${e?.message || e}`);
    record(`retro: aborted — ${e?.message || e}`);
    await persist();
    return 1;
  }
}

/**
 * 역할 이름 → 그 역할의 lessons·agent 파일. 후보의 `role`은 handoff에 적힌 이름(예: `correctness`)이고
 * 파일 이름은 에이전트 파일의 basename(예: `reviewer-correctness`)이라 둘 다 받아야 한다 — roles.toml이
 * 유일한 출처이므로, 여기서 두 키를 같은 항목에 매달아 둔다. 모르는 역할은 파일을 만들지 않는다
 * (retro는 역할을 신설하지 않는다 — 신설은 사람이 머지하는 제안 PR의 몫이다).
 */
export function roleFileMap(roles) {
  const map = new Map();
  const add = (name, def) => {
    if (!def?.agent) return;
    const entry = { agent: def.agent, lessons: def.lessons ?? null };
    map.set(name, entry);
    map.set(def.agent.split("/").pop().replace(/\.md$/, ""), entry);
  };
  for (const [stage, block] of Object.entries(roles || {})) {
    if (stage === "schema" || typeof block !== "object" || block === null) continue;
    if (block.agent) { add(stage, block); continue; }
    for (const [name, def] of Object.entries(block)) add(name, def);
  }
  return map;
}

/** CLI 진입: 실제 의존성 조립 */
async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
  const runnerId = process.env.FACTORY_RUNNER_ID || `local/${hostname()}`;
  const gh = makeGh({ run, repo });

  // 잠드는 건 정상이지만 "왜"는 반드시 말한다. retro는 라벨을 옮기지 않으므로 잠들어도 아무것도 막지 않는다.
  let charter, harness, roles;
  try { charter = loadCharter(root); harness = loadHarness(root); }
  catch (e) { console.error(`factory: retro dormant — ${e.message}`); process.exit(0); }
  if (charter.status !== "ready") { console.error(`factory: CHARTER status is ${charter.status} — retro dormant`); process.exit(0); }
  try { roles = loadRoles(root); }
  catch (e) { console.error(`factory: .factory/roles.toml unreadable — ${e.message}`); process.exit(0); }

  const retro = charter.retro?.every_merges || {};
  const now = new Date().toISOString();
  const runsDir = join(root, "docs/factory/runs");
  const outDir = join(root, ".factory/out");
  const statePath = join(runsDir, "_retro.md");
  const readText = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const defaultBranch = harness.project?.default_branch ?? "main";
  const fileOf = roleFileMap(roles);

  const deps = {
    now,
    // 경량 실행은 매 머지마다 도므로 기록은 러너 로그로 충분하다 — `_retro.md`는 `renderRetroState`가
    // 통째로 다시 쓰는 상태 파일이라 run 기록을 append할 수 없다(append하면 다음 render가 지운다).
    record: (line) => console.log(`factory: ${line}`),
    hydrate: async () => {
      const records = await readRecords({ run, cwd: root });
      mkdirSync(runsDir, { recursive: true });
      for (const [issue, text] of records) {
        const p = join(runsDir, `${issue}.md`);
        // run 기록은 append-only 로그다 — 로컬에 이미 있으면 아직 push되지 않은 꼬리일 수 있으니
        // 건드리지 않는다(hydrateRecord와 같은 규칙). `_retro.md`는 예외다: retro만 쓰고 쓸 때마다
        // 반드시 sync하므로 **브랜치가 유일한 진실**이고, 로컬 사본은 지난 실행이 남긴 잔재일 뿐이다.
        // 그 잔재를 읽으면(오래된 체크아웃에서 `factory run retro`) 옛 상태 위에 새 이력을 쓰고
        // 브랜치의 이력을 통째로 덮어쓴다 — 그래서 여기서만 브랜치 내용으로 되돌린다.
        if (issue === "_retro" || !existsSync(p)) writeFileSync(p, text);
      }
      return { records };
    },
    readState: () => parseRetroState(readText(statePath), { initial: retro.initial ?? 1 }),
    writeState: (state, opts) => { mkdirSync(runsDir, { recursive: true }); writeFileSync(statePath, renderRetroState(state, opts)); },
    /**
     * 이슈·코멘트를 한 번만 긁어 경량 수확과 이후 격리 판정이 같은 스냅샷을 쓴다. `state`는 gh가
     * 주지 않으므로 `closedAt`에서 만든다(lib 쪽은 소문자 `open`/`closed`를 본다).
     * 코멘트는 창(`since`) 안에서 움직인 이슈만 읽는다 — 단 `factory:flaky` 이슈는 언제 갱신됐든
     * 읽는다: 격리 등록·만료 판정의 근거가 그 이슈의 코멘트에만 있다.
     */
    harvest: async ({ since, records }) => {
      const raw = await gh.issueList({ state: "all", limit: 200 });
      const issues = raw.map((i) => ({ ...i, state: i.closedAt ? "closed" : "open" }));
      const sinceMs = since == null ? null : Date.parse(since);
      const commentsByIssue = new Map();
      for (const i of issues) {
        const stale = sinceMs != null && i.updatedAt && Number.isFinite(Date.parse(i.updatedAt)) && Date.parse(i.updatedAt) <= sinceMs;
        if (stale && !(i.labels || []).includes("factory:flaky")) continue;
        try { commentsByIssue.set(i.number, await gh.comments(i.number)); }
        catch (e) { console.error(`factory: retro could not read comments on #${i.number} — ${e?.message || e}`); }
      }
      const stamps = [...commentsByIssue.values()].flat().map((c) => c?.createdAt).filter(Boolean).sort();
      const { candidates, stats } = harvestRecords({ records, issues, commentsByIssue, since });
      return { candidates, stats, issues, commentsByIssue, first: stamps[0] ?? null };
    },
    shouldRunFull: ({ state, force: f }) => shouldRunFull({ state, retro, force: f }),
    /**
     * 후보 파일을 먼저 쓰고(워크플로가 그 경로만 인자로 받는다, P4-R6) `claude -p`를 부른다.
     * 파싱에 실패해도 원본 stdout은 `.factory/out/retro.json`에 남는다 — 사후 감사의 1차 증거다.
     */
    claudeP: async ({ period, candidates, stats, history }) => {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "retro-candidates.json"), `${JSON.stringify({ period, candidates, stats, history }, null, 2)}\n`);
      const args = ["-p", "/factory-retro", "--permission-mode", "dontAsk", "--max-turns", "5", "--output-format", "json", "--settings", join(root, ".factory/ci-settings.json")];
      if (charter?.budget?.usd_per_stage) args.push("--max-budget-usd", String(charter.budget.usd_per_stage));
      const r = await run("claude", args, { cwd: root, env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", CLAUDE_PROJECT_DIR: root } });
      writeFileSync(join(outDir, "retro.json"), r.stdout);
      try { return JSON.parse(r.stdout); } catch { return { is_error: true, result: r.stdout + r.stderr }; }
    },
    applyLessons: ({ role, adopted, today, minEvidence }) => {
      const rel = fileOf.get(role)?.lessons;
      const text = rel ? readText(join(root, rel)) : "";
      // 파일이 없으면 만들지 않는다 — lessons 파일은 역할의 존재 증명이고, retro는 역할을 신설하지 않는다.
      if (!rel || !text) return { path: null, text: "", added: [], rejected: adopted.map((a) => ({ text: a.text, reason: rel ? "empty-lessons-file" : "unknown-role" })), evicted: [] };
      return { path: rel, ...applyLessonsText({ text, adopted, today, minEvidence }) };
    },
    applyRoleAdditions: ({ role, examples, perspectives }) => {
      const rel = fileOf.get(role)?.agent;
      const text = rel ? readText(join(root, rel)) : "";
      if (!rel || !text) return { path: null, text: "", added: [], skipped: [...examples, ...perspectives].map((x) => ({ text: x.text, reason: "unknown-role" })) };
      return { path: rel, ...applyRoleAdditionsText({ text, examples, perspectives }) };
    },
    publishLessons: ({ files, date }) => openAndMergeLessonsPr({ run, gh, cwd: root, defaultBranch, files, date, harness, log: (m) => console.log(m) }),
    maturityGaps: async () => {
      const ls = await run("git", ["ls-files"], { cwd: root });
      const files = ls.code === 0 ? ls.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
      let manifestDeps = [];
      try {
        const pkg = JSON.parse(readText(join(root, "package.json")) || "{}");
        manifestDeps = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})];
      } catch (e) { console.error(`factory: retro could not read package.json — ${e?.message || e}`); }
      return detectMaturityGaps({ files, harness, manifestDeps });
    },
    createIssue: (issue) => gh.createIssue(issue),
    /** 등록은 세 가지가 한 단계다: 판정 → `quarantine.toml` 저장 → 그 flaky 이슈에 마커 코멘트. */
    registerQuarantine: async ({ issues, commentsByIssue, now: at }) => {
      const { q, registered } = registerFromFlakyIssues({ issues, commentsByIssue, quarantine: loadQuarantine(root), now: at, K: charter.limits?.K });
      if (!registered.length) return { registered };
      saveQuarantine(root, q);
      for (const r of registered) {
        try {
          await gh.comment(r.issue, [
            quarantineComment("registered", r.id),
            `\`${r.id}\`를 \`.factory/quarantine.toml\`에 격리 등록했습니다 — 자가 수정이 한도(K)를 넘겨 \`factory:needs-human\`에 도달했기 때문입니다(§5.2.5-⑤).`,
            "격리된 테스트의 실패는 게이트를 RED로 만들지 않지만, 격리 수가 상한을 넘으면 back-pressure가 새 구현 착수를 막습니다 — 방치할 수 없는 부채입니다.",
          ].join("\n"));
        } catch (e) { console.error(`factory: retro could not comment on flaky issue #${r.issue} — ${e?.message || e}`); }
      }
      return { registered };
    },
    expiredIds: ({ issues, commentsByIssue, since }) => expiredFromComments({ issues, commentsByIssue, since }),
    publishProposal: ({ files, title, body, date }) => openProposalPr({ run, gh, cwd: root, defaultBranch, files, title, body, date, log: (m) => console.log(m) }),
    // `_retro.md`는 매번 통째로 다시 렌더링되는 상태 파일이라 꼬리 병합의 대상이 아니다 — 병합되면
    // 마커·JSON 펜스가 둘인 파일이 되고 다음 retro가 옛 상태를 읽는다(records-branch.js `overwrite` 참조).
    sync: () => syncRecords({ run, cwd: root, message: `retro: state update (${runnerId})`, overwrite: ["_retro.md"] }),
    nBounds: { min: retro.min ?? 1, max: retro.max ?? Infinity },
  };

  process.exit(await runRetro({ deps, force, now }));
}

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
