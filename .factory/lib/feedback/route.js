import { ensureHarnessIssue } from "../harness-request.js";
import { isMerged } from "../retro/harvest.js";
import { afterSince } from "../retro/issue-comments.js";
import { classifyFinding } from "./classify.js";
import { harvestFindings } from "./harvest-findings.js";
import {
  appendEvidence, parseUpstreamIssue, renderUpstreamIssue, sourceRef, upstreamIssueTitle,
} from "./upstream-issue.js";

/**
 * ── Feedback loop Task 3 — **라우팅 팔**(spec §7) ────────────────────────────────────────────────
 *
 * 분류(`classifyFinding`)는 순수 함수이고, 문법(`upstream-issue.js`)도 순수 함수다. 이 파일만이
 * gh를 만진다 — 그리고 만지는 방식이 이 파일의 전부다:
 *
 *   `harness`   → **쓰는 저장소**의 harness 이슈(`ensureHarnessIssue`, 기존 dedupe: 피처 이슈 하나당
 *                 열린 harness 이슈 하나). 한 이슈의 harness 발견이 여럿이면 **이슈 하나에 줄 여럿**이다.
 *   `ktb`       → `[factory].upstream`이 설정돼 있으면 상류 저장소의 factory-improvement 이슈.
 *                 같은 fingerprint의 **열린** 이슈가 있으면 새로 열지 않고 증거만 덧붙인다(spec §6).
 *                 설정이 없으면 **교차 저장소 호출을 한 번도 하지 않고** 원래 이슈에 코멘트 하나를
 *                 남긴다 — 라우팅은 설정으로 여는 옵트인이고, 시크릿은 팩토리가 만들지 않는다(§7).
 *   `ambiguous` → 두 후보를 그대로 적은 코멘트 하나. **절대 추측해서 라우팅하지 않는다**(§2).
 *   `product`   → 아무것도 하지 않는다(escaped defect로 결과 지표에만 쓰인다).
 *   `withheld`  → 아무것도 하지 않되 **센다** — 쌍 증거 없는 행동 신호가 조용히 사라지면 "체계적으로
 *                 쌍이 없는 신호"를 아무도 못 본다(classify.js의 disposition 주석과 같은 이유).
 *
 * ## fail-safe — 라우팅은 공장을 멈추지 않는다
 * 팔마다 try/catch가 따로 걸린다. 상류 호출이 403으로 죽어도 같은 실행의 harness 팔은 돌고, 그 반대도
 * 같다. 실패는 `{kind: "error", step: "feedback-route", …}` 액션 한 줄로 남고 호출자(retro)는 계속한다.
 * 회고가 라우팅 때문에 죽으면 그 회차의 lessons·통계·커서까지 함께 사라진다 — 잃는 것이 훨씬 크다.
 *
 * ## 멱등 — 같은 창을 여러 번 봐도 쌓이지 않는다
 * 경량 회고는 **매 머지마다** 돌지만 커서는 full 회차에서만 전진한다. 그래서 같은 머지 이슈가 여러
 * 번 라우팅을 통과하는 것이 정상이고, 네 경로가 각각 자기 열쇠로 그것을 흡수한다:
 *   harness → `for=<issue>` 마커 / 상류 → fingerprint + `appendEvidence`의 `출처|스테이지/라운드` 키 /
 *   로컬 코멘트 → 아래 `feedbackNoteMarker(fp)`(이미 그 마커를 단 코멘트가 있으면 쓰지 않는다).
 */

/** 로컬 노트(ktb-미설정 / ambiguous)의 dedupe 키. 코멘트 본문 첫 줄에 선다. */
export const feedbackNoteMarker = (fingerprint) => `<!-- factory-feedback fp=${String(fingerprint ?? "none").replace(/\s+/g, "")} -->`;

/**
 * **출처 이슈 쪽** 라우팅 영수증(T3 리뷰 SF-4). 상류에 이슈를 열거나 증거를 붙인 뒤 이 마커를 단
 * 코멘트를 출처 이슈에 남긴다. 두 가지를 동시에 한다:
 *   ① 사람에게 "이 머지의 이 원인은 저기로 갔다"를 이슈 안에서 보여 준다(링크가 여기 있다).
 *   ② **같은 머지를 다시 읽어도 두 번 라우팅하지 않는다.** 상류 dedupe는 *대상이 열려 있는 동안*만
 *      흡수한다 — 사람이 상류 이슈를 닫으면 다음 경량 회고가 같은 옛 증거로 새 이슈를 연다(커서는
 *      full 회차에만 전진하므로 같은 머지를 N번까지 다시 본다). 출처 쪽 마커는 대상의 상태와 무관하다.
 */
export const routedMarker = (fingerprint) => `<!-- factory-feedback routed fp=${String(fingerprint ?? "none").replace(/\s+/g, "")} -->`;
/** 두 마커를 한 번에 읽는다 — 어느 쪽이 남아 있든 "이 지문은 이 이슈에서 이미 처리했다"는 뜻이다. */
const ANY_FEEDBACK_MARKER = /<!--\s*factory-feedback (?:routed )?fp=(\S+)\s*-->/g;

const oneLine = (v) => String(v ?? "").replace(/\s*\n\s*/g, " ").trim();
const clip = (v, n) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);

/** harness 이슈의 표 한 줄. `file`/`change`/`why` 셋 다 비어 있으면 `harnessNeeded`가 떨어뜨린다. */
function harnessEntryOf({ causal, payload, fingerprint }) {
  const file = [causal.path, causal.locus].filter(Boolean).join(" ") || "(unresolved)";
  const change = clip(oneLine(payload.reason) || `fix ${file}`, 160);
  const why = oneLine([
    `#${payload.issue}`,
    payload.stage ? `${payload.stage}${payload.round == null ? "" : ` r${payload.round}`}` : null,
    `이 파일의 주인은 이 저장소입니다(설치 매니페스트 owner: user)`,
    `fp=${fingerprint}`,
  ].filter(Boolean).join(" · "));
  return { file, change, why };
}

/** 노트 본문 — 사람이 먼저 읽을 것이 위, 기계가 쓴 payload가 아래(upstream 이슈와 같은 순서). */
function noteBody({ marker, headline, lines = [], payload }) {
  return [
    marker,
    `**피드백 루프**: ${headline}`,
    "",
    ...lines,
    "",
    "<details><summary>full payload (기계가 쓴 것 — 스펙 §6)</summary>",
    "",
    "```json",
    JSON.stringify(payload ?? {}, null, 2),
    "```",
    "",
    "</details>",
  ].join("\n");
}

const errorAction = (issue, reason, extra = {}) => ({ kind: "error", step: "feedback-route", issue, reason: String(reason), ...extra });

/**
 * `routeFindings({...}) → { actions, classified, counts }` — **한 이슈**의 발견들을 주인에게 보낸다.
 *
 * @param gh              gh 어댑터(`issueList`/`createIssue`/`comment`/`upstreamIssue`)
 * @param repo            이 발견이 난 저장소 `owner/name`
 * @param issue           그 발견이 난 이슈 번호(= 상류 증거의 `from`, harness 이슈의 dedupe 키)
 * @param findings        `harvestFindings`가 뽑은 원시 발견들
 * @param upstream        `[factory].upstream` — 없으면 교차 저장소 호출을 하지 않는다
 * @param ownerOf,isInstalled  설치 매니페스트(필수 — 없으면 `classifyFinding`이 던지고 라우팅하지 않는다)
 * @param existingComments 이 이슈에 이미 달린 코멘트(로컬 노트 멱등의 재료)
 */
export async function routeFindings({
  gh, repo, issue, findings = [], upstream = null,
  ownerOf, isInstalled, ktbVersion = null, harness = null, existingComments = [],
} = {}) {
  const actions = [];
  const classified = [];
  const counts = { harness: 0, ktb: 0, product: 0, ambiguous: 0, withheld: 0 };

  for (const finding of findings) {
    let c;
    try { c = classifyFinding({ finding, ownerOf, isInstalled, ktbVersion, harness }); }
    catch (e) { actions.push(errorAction(issue, `classify failed — ${e?.message || e}`)); continue; }
    classified.push(c);
    if (c.disposition === "outcome") counts.product += 1;
    else if (c.disposition === "withheld") counts.withheld += 1;
    else if (c.disposition === "ambiguous") counts.ambiguous += 1;
    if (c.tags.includes("harness")) counts.harness += 1;
    if (c.tags.includes("ktb")) counts.ktb += 1;
  }

  // 이 이슈가 **이미 처리한 지문**(로컬 노트의 마커든, 어느 팔의 영수증이든). 같은 머지를 여러 번
  // 다시 읽어도(커서는 full 회차에만 전진한다) 두 번 쓰지 않는다 — 대상의 상태와 무관하다(SF-4).
  const seenFingerprints = new Set();
  for (const c of existingComments || []) {
    for (const m of String(c?.body ?? "").matchAll(ANY_FEEDBACK_MARKER)) seenFingerprints.add(m[1]);
  }
  const fpKey = (fingerprint) => String(fingerprint ?? "none").replace(/\s+/g, "");

  // ── harness: 쓰는 저장소의 harness 이슈 하나(여러 발견이면 표의 여러 줄) ───────────────────────
  // 재리뷰 SF-b — 이 팔에도 출처 쪽 영수증이 필요하다. `ensureHarnessIssue`의 dedupe는 **열린**
  // `for=<issue>` 이슈만 보므로, 사람이 그 이슈를 닫으면 창 안의 남은 경량 회고가 같은 옛 증거로
  // 그것을 다시 연다. 이미 영수증이 있는 지문은 아예 entry로 만들지 않는다.
  const harnessOnes = classified.filter((c) => c.tags.includes("harness"));
  const harnessFresh = harnessOnes.filter((c) => !seenFingerprints.has(fpKey(c.fingerprint)));
  if (harnessOnes.length && !harnessFresh.length) {
    for (const c of harnessOnes) actions.push({ kind: "routed-already", step: "feedback-route", issue, fingerprint: c.fingerprint, arm: "harness" });
  } else if (harnessFresh.length) {
    try {
      const r = await ensureHarnessIssue({ gh, issue, entries: harnessFresh.map(harnessEntryOf), pr: null, origin: "feedback" });
      actions.push({ kind: "harness-issue", step: "feedback-route", issue, harness_issue: r.issue, created: r.created, appended: r.appended ?? 0, findings: harnessFresh.length });
      try {
        await gh.comment(issue, [
          harnessFresh.map((c) => routedMarker(c.fingerprint)).join("\n"),
          `**피드백 루프**: 이 이슈의 발견 ${harnessFresh.length}건은 **이 저장소**가 고칠 것입니다(설치 매니페스트 owner: user) — harness 이슈 #${r.issue}${r.created ? "를 열었습니다" : "에 실었습니다"}.`,
          "",
          ...harnessFresh.map((c) => `- \`${[c.causal.path, c.causal.locus].filter(Boolean).join(" ")}\` — ${oneLine(c.payload.reason)} (fp \`${c.fingerprint}\`)`),
        ].join("\n"));
        for (const c of harnessFresh) seenFingerprints.add(fpKey(c.fingerprint));
      } catch (e) {
        actions.push(errorAction(issue, `harness receipt failed — ${e?.message || e}`));
      }
    } catch (e) {
      actions.push(errorAction(issue, `harness issue failed — ${e?.message || e}`, { tags: ["harness"] }));
    }
  }
  const note = async (fingerprint, body, kind, extra) => {
    if (seenFingerprints.has(fpKey(fingerprint))) { actions.push({ kind: `${kind}-skipped`, step: "feedback-route", issue, reason: "already noted", ...extra }); return; }
    await gh.comment(issue, body);
    seenFingerprints.add(fpKey(fingerprint));
    actions.push({ kind, step: "feedback-route", issue, ...extra });
  };

  // ── ktb: 지문 하나당 상류 이슈 하나(또는 upstream 미설정이면 로컬 노트 하나) ──────────────────
  const byFingerprint = new Map();
  for (const c of classified) {
    if (!c.tags.includes("ktb")) continue;
    if (!byFingerprint.has(c.fingerprint)) byFingerprint.set(c.fingerprint, c);
  }
  for (const [fingerprint, c] of byFingerprint) {
    try {
      if (seenFingerprints.has(fpKey(fingerprint))) {
        actions.push({ kind: "routed-already", step: "feedback-route", issue, fingerprint });
        continue;
      }
      if (upstream) {
        const res = await gh.upstreamIssue({
          repo: upstream,
          fingerprint,
          match: (body) => parseUpstreamIssue(body)?.fingerprint === fingerprint,
          render: () => renderUpstreamIssue({ fingerprint, tags: c.tags, payload: c.payload, sourceRepo: repo, sourceIssue: issue }),
          append: (body) => appendEvidence(body, c.payload, sourceRef(repo, issue)),
        });
        actions.push({
          kind: res.created ? "upstream-created" : (res.appended ? "upstream-appended" : "upstream-unchanged"),
          step: "feedback-route", issue, repo: upstream, upstream_issue: res.issue, fingerprint,
        });
        // 출처 쪽 영수증(SF-4). 실패해도 라우팅은 이미 일어났다 — 에러 한 줄만 남기고 계속한다.
        try {
          await gh.comment(issue, [
            routedMarker(fingerprint),
            `**피드백 루프**: 이 이슈의 발견 하나를 상류 저장소로 보냈습니다 — ${upstream}#${res.issue} (${res.created ? "새 이슈" : "기존 이슈에 증거 추가"}).`,
            "",
            `- **무엇:** ${oneLine(c.payload.reason)}`,
            c.causal.path ? `- **원인 파일:** \`${c.causal.path}\` (owner: \`${c.causal.owner}\`)` : "",
            `- **지문:** \`${fingerprint}\``,
          ].filter(Boolean).join("\n"));
          seenFingerprints.add(fpKey(fingerprint));
        } catch (e) {
          actions.push(errorAction(issue, `routed receipt failed — ${e?.message || e}`, { fingerprint }));
        }
      } else {
        const marker = feedbackNoteMarker(fingerprint);
        await note(fingerprint, noteBody({
          marker,
          headline: "이 발견의 주인은 **KTB**(팩토리가 배포한 것)입니다 — `.factory/harness.toml`의 `[factory].upstream`이 비어 있어 상류 저장소에 이슈를 열지 않고 여기 남깁니다(spec §7: 라우팅은 설정으로 여는 옵트인입니다).",
          lines: [
            `- **제목이 될 문장:** ${upstreamIssueTitle({ ...c.payload, fingerprint })}`,
            c.causal.path ? `- **원인 파일:** \`${c.causal.path}${c.causal.line ? `:${c.causal.line}` : ""}\` (owner: \`${c.causal.owner}\`)` : "- **원인 파일:** (확정 못 함)",
            `- **무엇:** ${oneLine(c.payload.reason)}`,
            `- **지문:** \`${fingerprint}\``,
            "",
            "`[factory].upstream = \"owner/repo\"`를 적고 그 저장소에 `issues:write`를 준 토큰을 `FACTORY_BOT_TOKEN`으로 넘기면 다음 머지부터 상류 이슈로 갑니다.",
          ],
          payload: c.payload,
        }), "ktb-note", { fingerprint });
      }
    } catch (e) {
      actions.push(errorAction(issue, `upstream route failed — ${e?.message || e}`, { fingerprint, repo: upstream ?? null }));
    }
  }

  // ── ambiguous: 두 후보를 그대로 올린다(오라우팅보다 미판정이 낫다) ─────────────────────────────
  for (const c of classified) {
    if (c.disposition !== "ambiguous") continue;
    const marker = feedbackNoteMarker(c.fingerprint);
    try {
      await note(c.fingerprint, noteBody({
        marker,
        headline: "인과 파일의 **주인을 확정하지 못했습니다** — 라우팅하지 않고 두 후보를 그대로 올립니다(spec §2: ambiguous는 절대 버리지 않습니다).",
        lines: [
          `- **무엇:** ${oneLine(c.payload.reason)}`,
          c.causal.path ? `- **어디:** \`${c.causal.path}${c.causal.line ? `:${c.causal.line}` : ""}\`` : "- **어디:** (경로를 지목하지 못했습니다)",
          `- **언제:** ${c.payload.stage ?? "?"}${c.payload.round == null ? "" : ` / round ${c.payload.round}`}`,
          "",
          "후보:",
          ...(c.candidates || []).map((x) => `- ${x}`),
        ],
        payload: c.payload,
      }), "ambiguous-note", { fingerprint: c.fingerprint });
    } catch (e) {
      actions.push(errorAction(issue, `ambiguous note failed — ${e?.message || e}`, { fingerprint: c.fingerprint }));
    }
  }

  // 미판정은 **세어서 보고한다**(리뷰 nit 2) — 노트는 이슈마다 따로 달리지만, "이번 머지가 판정하지
  // 못한 발견이 몇 개였나"는 run 기록 한 줄로 보여야 추세가 보인다.
  if (counts.ambiguous) actions.push({ kind: "ambiguous-summary", step: "feedback-route", issue, count: counts.ambiguous });
  if (counts.withheld) actions.push({ kind: "withheld", step: "feedback-route", issue, count: counts.withheld });
  if (counts.product) actions.push({ kind: "product", step: "feedback-route", issue, count: counts.product });
  return { actions, classified, counts };
}

/**
 * `routeMergedIssues({...}) → { issues, actions }` — **이번 창에 머지된 이슈들**을 수확하고 라우팅한다.
 * retro의 팔이 부르는 자리이고, `factory analyze`(Task 5)가 같은 엔진을 다시 쓴다.
 *
 * 대상은 `harvest.js`와 **같은 판정**(`isMerged` + `afterSince(closedAt)`)으로 고른다 — 창 통계가 센
 * 머지와 루프가 본 머지가 다르면 "머지마다 한 번"이라는 계약이 이슈마다 달라진다. 기록이 없는 이슈는
 * 코멘트만으로 수확한다(전이 거부·self-gate는 코멘트에 산다).
 */
export async function routeMergedIssues({
  gh, repo, upstream = null, issues = [], commentsByIssue = new Map(), records = new Map(),
  since = null, ownerOf, isInstalled, ktbVersion = null, harness = null, factoryLogins = [],
} = {}) {
  const sinceMs = since == null ? null : Date.parse(since);
  const byIssue = commentsByIssue instanceof Map ? commentsByIssue : new Map(Object.entries(commentsByIssue || {}));
  const recs = records instanceof Map ? records : new Map(Object.entries(records || {}));
  const actions = [];
  const routed = [];

  for (const issue of issues || []) {
    const comments = byIssue.get(issue.number) || [];
    if (!isMerged(issue, comments)) continue;
    if (!afterSince(issue.closedAt, sinceMs)) continue;
    routed.push(issue.number);
    let findings = [];
    try { findings = harvestFindings({ issue: issue.number, repo, record: recs.get(String(issue.number)) ?? recs.get(issue.number) ?? "", comments, factoryLogins }); }
    catch (e) { actions.push(errorAction(issue.number, `harvest failed — ${e?.message || e}`)); continue; }
    if (!findings.length) continue;
    const r = await routeFindings({
      gh, repo, issue: issue.number, findings, upstream,
      ownerOf, isInstalled, ktbVersion, harness, existingComments: comments,
    });
    actions.push(...r.actions);
  }
  return { issues: routed, actions };
}
