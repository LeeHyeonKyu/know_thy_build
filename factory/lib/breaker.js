import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRecordsDetailed, syncRecords } from "./records-branch.js";

/**
 * ── #189 (S4c, ADR-033) — 자동 머지의 회로차단기 ──────────────────────────────────────────────────────────────────────
 *
 * 판정 경로 자동 머지의 조건 넷 중 하나가 "차단기 닫힘"이다. 차단기는 **2차 방어선**이다(1차는 만장일치·GREEN·거부권 창):
 * 공장이 자기 변경 경로로 머지한 판정 경로 PR이 main에서 **연속으로** `revert_streak`번 되돌려지면 열린다. revert 자체가 사람의
 * 행위이므로, 이것이 지키는 것은 "되돌린 사람이 소유자가 아니거나 소유자가 보고 있지 않을 때"다(plan d7).
 *
 * 상태는 **저장하지 않고 매번 계산한다**(plan d3): 열림/닫힘 = (merge 스테이지가 머지 순간 run 기록에 쓴 자동 머지 줄) + (origin의
 * revert 커밋) 중 **마지막 리셋(`closed_at`) 뒤의 증거**. 저장되는 것은 사람의 리셋(closed_by/closed_at)과, sweep이 열림을 한 번만
 * 알리기 위한 워터마크(open/since/reason)뿐이고, merge 스테이지는 그 워터마크를 믿지 않는다.
 *
 * 이 파일의 앞부분(`selfMergeLine`…`evaluateBreaker`, 상태 렌더/파스)은 순수 함수다. 뒷부분(`readBreaker`·`writeBreakerState`)은
 * 주입받은 `run`으로 git을 부르는 어댑터이고, 실패를 던지지 않고 `{ ok:false, reason }`으로 올린다 — 모르는 것은 닫힘이 아니다.
 */

/** 사람이 차단기를 닫는 유일한 명령. merge 스테이지의 거부 사유와 sweep의 알림이 그대로 인용한다. */
export const BREAKER_RESET_COMMAND = "factory breaker --reset --reason <text>";

// ── 자동 머지 기록 줄(merge 스테이지가 쓰고, 차단기가 읽는다 — 같은 모듈이라 두 문법이 갈라질 수 없다) ─────────────────

/**
 * merge 스테이지가 자기 변경 경로로 **머지한 직후** run 기록에 남기는 한 줄. 기록은 러너만 쓰는 `factory/records`로 간다(에이전트
 * 세션의 push는 훅이 막는다). `by=script` 전이 코멘트로 자동 머지를 가리지 않는 이유: sweeper의 사람-머지 반영 팔도 같은 표식을
 * 쓴다(plan d1). 판정 비트도 **그 순간** 적는다 — 나중에 `classifyProtected`로 다시 계산하면 비판정 목록이 바뀔 때 과거가 바뀐다.
 * 전이 마커 정규식(`retro/issue-comments.js`)은 건드리지 않는다.
 */
export const SELF_MERGE_PREFIX = "factory-self-merge:";
export const SELF_MERGE_VERSION = 1;
export function selfMergeLine({ issue, pr, kind, sha = null, at }) {
  return `${SELF_MERGE_PREFIX}v${SELF_MERGE_VERSION} ${JSON.stringify({ issue: Number(issue), pr: Number(pr), kind, sha: sha ?? null, at })}`;
}

const SELF_MERGE_LINE = /^factory-self-merge:v(\d+) (\{.*\})\s*$/;
const isIso = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));
const posInt = (v) => Number.isInteger(v) && v > 0;

/**
 * run 기록 본문에서 자동 머지 줄을 뽑는다. **merge 섹션(`## merge · …`) 안의 줄만** 센다 — 다른 스테이지의 줄(사유 문구에 실린
 * 임의의 텍스트 포함)이 자동 머지를 지어낼 수 없다. 모르는 버전·깨진 JSON·모양이 틀린 줄은 무시한다(되돌린 코드가 남긴 줄은 무해).
 */
export function parseSelfMergeLines(text) {
  const out = [];
  let inMerge = false;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("## ")) { inMerge = /^## merge(?: |$)/.test(line); continue; }
    if (!inMerge) continue;
    const m = SELF_MERGE_LINE.exec(line);
    if (!m || Number(m[1]) !== SELF_MERGE_VERSION) continue;
    let j;
    try { j = JSON.parse(m[2]); } catch { continue; }
    if (!posInt(j?.issue) || !posInt(j?.pr) || (j.kind !== "judge" && j.kind !== "non_judge") || !isIso(j.at)) continue;
    out.push({ issue: j.issue, pr: j.pr, kind: j.kind, judge: j.kind === "judge", sha: typeof j.sha === "string" ? j.sha : null, at: new Date(j.at).toISOString() });
  }
  return out;
}

// ── revert 커밋 ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `git log --format=%s`의 제목 하나가 되돌린 PR 번호. 두 모양을 받는다: `git revert`가 만든 `Revert "title (#N)"`와, revert PR이
 * squash 머지된 `Revert "title (#N)" (#M)` — 세는 것은 **따옴표 안의 마지막 (#N)**이다(바깥 (#M)은 revert PR 자신). 그 밖은 null.
 * 손으로 쓴 revert 메시지·편집된 제목은 놓친다(plan open_risks).
 */
export function revertedPr(subject) {
  const m = /^Revert "(.*)"(?:\s+\(#\d+\))?\s*$/.exec(String(subject ?? "").trim());
  if (!m) return null;
  const nums = [...m[1].matchAll(/\(#(\d+)\)/g)];
  return nums.length ? Number(nums.at(-1)[1]) : null;
}

/**
 * `git log --format=%cI%x09%s` 출력 → revert 커밋 `[{ at, pr, subject }]`. 날짜를 읽을 수 없는 줄은 **던진다**: 그 줄이 리셋 앞인지
 * 뒤인지 모르면 조용히 버릴 수도(차단기가 열리지 않는다) 셀 수도 없다 — 호출자가 ok:false로 접는다.
 */
export function parseRevertLog(stdout) {
  const out = [];
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    const when = tab > 0 ? line.slice(0, tab).trim() : "";
    if (!isIso(when)) throw new Error(`git log line without a commit date: ${JSON.stringify(line.slice(0, 120))}`);
    const subject = line.slice(tab + 1);
    const pr = revertedPr(subject);
    if (pr !== null) out.push({ at: new Date(when).toISOString(), pr, subject });
  }
  return out;
}

/**
 * rework r2 cf1 — **GitHub의 Revert 버튼 흐름은 제목만으로 PR을 말하지 않는다.** revert PR의 squash 커밋이 PR 제목을 쓰면(저장소의
 * `squash_merge_commit_title`이 PR_TITLE이거나, COMMIT_OR_PR_TITLE에서 revert PR의 커밋이 둘 이상) main에 남는 것은
 * `Revert "<원래 PR 제목>" (#M)` — 안쪽 (#N)이 없다(vercel/next.js #98715의 실제 모양). 그래서 차단기의 읽기는 제목 말고도 본문과
 * main 자신의 커밋을 본다. 순서대로 처음 맞는 것이 그 revert의 PR이다:
 *   1. 제목 안쪽의 마지막 (#N) — `git revert`와 COMMIT_OR_PR_TITLE 단일 커밋(`revertedPr`, 그대로).
 *   2. 본문의 `This reverts commit <sha>` — main에서 그 커밋의 제목이 싣는 (#N)(squash 메시지가 COMMIT_MESSAGES일 때).
 *   3. 본문의 `Reverts <owner>/<repo>#N` — GitHub이 revert PR 본문에 쓰는 문장(squash 메시지가 PR_BODY일 때).
 *   4. 제목 `Revert "<T>"` — main에서 그보다 앞선 `<T> (#N)` 커밋(squash 메시지가 BLANK여도 남는 유일한 단서).
 * 이 넷 어디에도 묶이지 않는 revert 모양의 커밋은 버리지 않고 센다(`unattributed`) — readBreaker의 detail이 사람에게 말한다.
 */
export const REVERT_LOG_FORMAT = "%x1e%H%x09%cI%x09%s%x1f%b";
const lastPrRef = (s) => { const n = [...String(s ?? "").matchAll(/\(#(\d+)\)/g)]; return n.length ? Number(n.at(-1)[1]) : null; };
const trailingPrRef = (s) => { const m = /\(#(\d+)\)\s*$/.exec(String(s ?? "")); return m ? Number(m[1]) : null; };

/**
 * `git log --format=${REVERT_LOG_FORMAT}` 출력 → `{ reverts: [{ at, pr, subject, via }], unattributed: [subject], mainPrs: Set<pr> }`.
 * `mainPrs`는 main의 squash 커밋 제목 끝 `(#N)`이 말하는 머지된 PR들이다(자동 머지 줄의 확인에 쓴다 — `buildHistory`). 날짜를 읽을
 * 수 없는 레코드는 `parseRevertLog`처럼 던진다.
 */
export function parseRevertCommits(stdout) {
  const commits = [];
  for (const rec of String(stdout ?? "").split("\x1e")) {
    if (!rec.trim()) continue;
    const us = rec.indexOf("\x1f");
    const head = us === -1 ? rec : rec.slice(0, us);
    const body = us === -1 ? "" : rec.slice(us + 1);
    const [sha = "", when = "", ...rest] = head.replace(/^\n+/, "").split("\t");
    if (!isIso(when.trim())) throw new Error(`git log record without a commit date: ${JSON.stringify(head.slice(0, 120))}`);
    commits.push({ sha: sha.trim(), at: new Date(when.trim()).toISOString(), subject: rest.join("\t").replace(/\n+$/, ""), body });
  }
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const mainPrs = new Set(commits.map((c) => trailingPrRef(c.subject)).filter((n) => n !== null));
  const reverts = [];
  const unattributed = [];
  // git log은 새것부터다 — 제목으로 찾는 4번은 "그 revert보다 앞선" 커밋만 봐야 하므로 오래된 것부터 걷는다.
  const titleToPr = new Map();
  for (const c of [...commits].reverse()) {
    const shaped = /^Revert "(.*)"(?:\s+\(#\d+\))?\s*$/.exec(c.subject.trim());
    let pr = null, via = null;
    if (shaped) {
      pr = revertedPr(c.subject); via = pr !== null ? "subject" : null;
      if (pr === null) {
        const m = /This reverts commit ([0-9a-f]{7,40})/.exec(c.body);
        const target = m ? (bySha.get(m[1]) ?? commits.find((x) => x.sha.startsWith(m[1]))) : null;
        const n = target ? lastPrRef(target.subject) : null;
        if (n !== null) { pr = n; via = "body-sha"; }
      }
      if (pr === null) {
        const m = /^Reverts [\w.-]+\/[\w.-]+#(\d+)\s*$/m.exec(c.body);
        if (m) { pr = Number(m[1]); via = "body-ref"; }
      }
      if (pr === null && titleToPr.has(shaped[1])) { pr = titleToPr.get(shaped[1]); via = "title"; }
      if (pr !== null) reverts.push({ at: c.at, pr, subject: c.subject, via });
      else unattributed.push(c.subject);
    }
    const t = /^(.*\S)\s+\(#(\d+)\)\s*$/.exec(c.subject);
    if (t) titleToPr.set(t[1], Number(t[2]));
  }
  return { reverts, unattributed, mainPrs };
}

/**
 * history = 자동 머지(`kind:"auto-merge"`, run 기록의 줄) + revert(`kind:"revert"`, git log). `records`는 `readRecordsDetailed`의
 * `Map<issue, text>`(또는 같은 모양의 객체). 같은 PR이 두 번 기록됐으면 처음 것 하나만 남긴다 — 단, **판정이 이긴다**(rework r2 sec2):
 * 같은 PR에 판정 줄이 하나라도 있으면 그 PR은 판정 경로 자동 머지다. 더 이른 비판정 줄 하나로 판정 머지를 연속에서 빼낼 수 없다
 * (위조가 할 수 있는 최악은 막는 쪽이다).
 *
 * `mainPrs`(선택, `parseRevertCommits`의 것)를 주면 각 자동 머지에 `onMain`을 단다: main에 그 PR의 squash 커밋(`… (#N)`)이 있는가.
 * `evaluateBreaker`는 main에서 확인되지 않는 revert 없는 판정 머지로 연속을 끊지 않는다(sec2 — 지어낸 머지가 연속을 끊는 것을 막는다).
 */
export function buildHistory({ records, reverts = [], mainPrs = null }) {
  const map = records instanceof Map ? records : new Map(Object.entries(records || {}));
  const merges = new Map();
  for (const text of map.values()) {
    for (const m of parseSelfMergeLines(text)) {
      const prev = merges.get(m.pr);
      const better = !prev
        || (m.judge && !prev.judge)
        || (m.judge === prev.judge && Date.parse(m.at) < Date.parse(prev.at));
      if (better) merges.set(m.pr, m);
    }
  }
  const history = [
    ...[...merges.values()].map((m) => ({ kind: "auto-merge", at: m.at, issue: m.issue, pr: m.pr, judge: m.judge, ...(mainPrs ? { onMain: mainPrs.has(m.pr) } : {}) })),
    ...reverts.map((r) => ({ kind: "revert", at: r.at, pr: r.pr })),
  ];
  return history.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.pr - b.pr);
}

/**
 * 순수 판정. 판정 경로 자동 머지를 머지 시각 순으로 세우고, **연속한** `revert_streak`개가 모두 `closedAt` 뒤에 revert됐으면 열림.
 *   - 비판정 자동 머지는 줄에 서지 않는다(연속을 끊지도 잇지도 않는다).
 *   - revert 없는(또는 revert가 리셋 앞인) 판정 자동 머지는 연속을 끊는다.
 *   - `since`는 연속을 채운 revert의 시각이고, 여러 창이 열면 가장 먼저 채워진 것.
 * 시간은 차단기를 닫지 않는다 — 입력에 시계가 없다. 닫는 것은 사람의 리셋(`closedAt`)뿐이다.
 * → `{ open, since, reason, merges: [{issue, pr}], latest, counts }`
 */
export function evaluateBreaker({ history, thresholds, closedAt = null }) {
  const streak = thresholds?.revert_streak;
  if (!Number.isInteger(streak) || streak <= 0) throw new Error(`breaker revert_streak must be a positive integer — got ${JSON.stringify(streak)}`);
  let closedMs = null;
  if (closedAt !== null && closedAt !== undefined) {
    closedMs = Date.parse(closedAt);
    if (!Number.isFinite(closedMs)) throw new Error(`breaker closed_at is not a time — ${JSON.stringify(closedAt)}`);
  }
  const events = Array.isArray(history) ? history : [];
  const counted = new Map();                                          // pr → 리셋 뒤의 첫 revert 시각(ms)
  for (const e of events) {
    if (e?.kind !== "revert") continue;
    const t = Date.parse(e.at);
    if (closedMs !== null && !(t > closedMs)) continue;
    if (!counted.has(e.pr) || t < counted.get(e.pr)) counted.set(e.pr, t);
  }
  // revert되지 않은 판정 머지가 main에서 확인되지 않으면(`onMain:false`) 줄에 세우지 않는다 — 연속을 끊을 자격은 진짜 머지에만 있다.
  const judge = events.filter((e) => e?.kind === "auto-merge" && e.judge === true && !(e.onMain === false && !counted.has(e.pr)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.pr - b.pr);
  const counts = {
    merges: events.filter((e) => e?.kind === "auto-merge").length,
    judge: judge.length,
    reverts: events.filter((e) => e?.kind === "revert").length,
    counted_reverts: counted.size,
  };
  let best = null;
  for (let i = 0; i + streak <= judge.length; i++) {
    const win = judge.slice(i, i + streak);
    if (!win.every((m) => counted.has(m.pr))) continue;
    const done = Math.max(...win.map((m) => counted.get(m.pr)));
    if (!best || done < best.done) best = { done, win };
  }
  if (!best) return { open: false, since: null, reason: null, merges: [], latest: null, counts };
  const merges = best.win.map((m) => ({ issue: m.issue, pr: m.pr }));
  return {
    open: true,
    since: new Date(best.done).toISOString(),
    reason: `revert streak: judge-path auto-merges ${merges.map((m) => `PR #${m.pr}`).join(", ")} were reverted in a row (self_change.breaker.revert_streak: ${streak})`,
    merges,
    latest: merges.at(-1),
    counts,
  };
}

// ── 상태 파일(`factory/records`의 docs/factory/runs/state/breaker.md) ────────────────────────────────────────────────

/**
 * `.md`인 이유: records 헬퍼는 `.md`만 본다(plan — 헬퍼를 바꾸지 않는다). `state/` 아래인 이유: 기본 dir의
 * `readRecordsDetailed`(status·retro·harvest)는 중첩 경로를 건너뛰므로 이 파일이 이슈 기록으로 섞이지 않는다.
 */
export const BREAKER_STATE_DIR = "docs/factory/runs/state";
export const BREAKER_STATE_FILE = "breaker.md";
const BREAKER_STATE_KEY = BREAKER_STATE_FILE.slice(0, -3);
export const BREAKER_STATE_MARKER = "<!-- factory-breaker-state:v1 -->";
export const BREAKER_STATE_VERSION = 1;
const FENCE = /```json\s*\n([\s\S]*?)\n```/;
const oneLine = (v) => (v === null || v === undefined ? "—" : String(v).replace(/\s*\n\s*/g, " "));

export function renderBreakerState(state) {
  const s = state || {};
  const head = [
    "# Auto-merge breaker",
    "",
    `- open (sweep's announce watermark): ${s.open === true ? "yes" : "no"}`,
    `- since: ${oneLine(s.since)}`,
    `- reason: ${oneLine(s.reason)}`,
    `- closed by: ${oneLine(s.closed_by)} at ${oneLine(s.closed_at)}`,
    "",
    `Open/closed is recomputed from the records and origin's reverts after closed_at on every check. Only a person closes it: \`${BREAKER_RESET_COMMAND}\`.`,
  ].join("\n");
  return `${head}\n\n${BREAKER_STATE_MARKER}\n\`\`\`json\n${JSON.stringify(s, null, 2)}\n\`\`\`\n`;
}

/** → `{ ok:true, state }` | `{ ok:false, reason }`. 마커 없음·펜스 없음·JSON 손상·모르는 버전·모양이 틀린 필드는 전부 ok:false다. */
export function parseBreakerState(text) {
  const t = String(text ?? "");
  const at = t.indexOf(BREAKER_STATE_MARKER);
  if (at === -1) return { ok: false, reason: `${BREAKER_STATE_DIR}/${BREAKER_STATE_FILE} carries no ${BREAKER_STATE_MARKER} marker` };
  const fence = FENCE.exec(t.slice(at + BREAKER_STATE_MARKER.length));
  if (!fence) return { ok: false, reason: `${BREAKER_STATE_DIR}/${BREAKER_STATE_FILE} has no json block after its marker` };
  let s;
  try { s = JSON.parse(fence[1]); } catch (e) { return { ok: false, reason: `${BREAKER_STATE_DIR}/${BREAKER_STATE_FILE} json block is unparsable — ${e.message}` }; }
  if (!s || typeof s !== "object" || Array.isArray(s)) return { ok: false, reason: "breaker state is not an object" };
  if (s.version !== BREAKER_STATE_VERSION) return { ok: false, reason: `unknown breaker state version ${JSON.stringify(s.version)} (this engine reads version ${BREAKER_STATE_VERSION})` };
  const nullOr = (v, ok) => v === null || v === undefined || ok(v);
  if (typeof s.open !== "boolean") return { ok: false, reason: "breaker state field open is not a boolean" };
  for (const k of ["since", "closed_at"]) if (!nullOr(s[k], isIso)) return { ok: false, reason: `breaker state field ${k} is not a time` };
  for (const k of ["reason", "closed_by"]) if (!nullOr(s[k], (v) => typeof v === "string")) return { ok: false, reason: `breaker state field ${k} is not a string` };
  // rework r2 sec1 — 리셋 경계(closed_at)는 사람만 세운다: 그 줄의 closed_by가 `person:<login>`이 아니면 리셋이 아니다.
  if (s.closed_at !== null && s.closed_at !== undefined && !/^person:\S+$/.test(String(s.closed_by ?? ""))) {
    return { ok: false, reason: `breaker state has closed_at ${s.closed_at} but closed_by ${JSON.stringify(s.closed_by ?? null)} is not a person — only \`${BREAKER_RESET_COMMAND}\` from a person's shell closes the breaker` };
  }
  return { ok: true, state: { version: s.version, open: s.open, since: s.since ?? null, reason: s.reason ?? null, closed_by: s.closed_by ?? null, closed_at: s.closed_at ?? null } };
}

/**
 * 브랜치의 상태 파일을 읽는다. → `{ ok:true, state|null, blob|null }` | `{ ok:false, reason, blob?, corrupt? }`.
 * 브랜치가 없다고 확정됐거나(첫 실행) 브랜치에 파일이 없으면 `state:null`(= 리셋 이력 없음). 가져오지 못했거나 읽지 못하면 ok:false.
 * `corrupt`는 "파일은 있는데 읽을 수 없다"이고, 그때도 `blob`을 함께 준다 — 사람의 리셋이 그 손상을 덮어쓸 수 있게(expectBlob).
 */
export async function readBreakerState({ run, cwd, branch = "factory/records" }) {
  let det;
  try { det = await readRecordsDetailed({ run, cwd, branch, dir: BREAKER_STATE_DIR }); }
  catch (e) { return { ok: false, reason: `${branch} could not be read — ${e?.message || e}` }; }
  if (!det?.fetched) return { ok: false, reason: `${branch} could not be fetched — the breaker state is unknown, and an unknown breaker is not a closed breaker` };
  if (det.failures?.length) return { ok: false, reason: `${branch} has unreadable state file(s): ${det.failures.join(", ")}` };
  if (!det.records.has(BREAKER_STATE_KEY)) return { ok: true, state: null, blob: null };
  const blob = det.blobs.get(BREAKER_STATE_KEY) ?? null;
  const p = parseBreakerState(det.records.get(BREAKER_STATE_KEY));
  if (!p.ok) return { ok: false, reason: p.reason, blob, corrupt: true };
  // rework r2 sec1 — **누가 이 파일을 브랜치에 올렸는가.** 이 파일을 쓰는 문은 `writeBreakerState`(리셋·sweep) 하나다. 기본 dir
  // 동기화(스테이지 끝의 `run-record: …`, retro의 `retro: …`)가 이 경로를 바꾼 커밋이면, 그것은 워크트리에 심어진 파일이 run 기록과
  // 함께 실려 간 것이다(에이전트 세션이 쓸 수 있는 스크래치 경로) — 사람의 리셋이 아니다. 손상과 같게 다룬다(사람의 리셋이 덮어쓴다).
  const path = `${BREAKER_STATE_DIR}/${BREAKER_STATE_FILE}`;
  const prov = det.parent ? await run("git", ["rev-list", "-1", `--format=%s`, det.parent, "--", path], { cwd }) : null;
  if (!prov || prov.code !== 0) return { ok: false, reason: `${branch}: the commit that wrote ${path} could not be read — ${String(prov?.stderr || "no parent").trim().split("\n")[0]}`, blob, corrupt: true };
  const subject = String(prov.stdout || "").split("\n").map((l) => l.trim()).filter((l) => l && !/^commit [0-9a-f]+$/.test(l))[0] ?? "";
  if (STAGE_SYNC_MESSAGE.test(subject)) {
    return { ok: false, reason: `${path} was last written by a records sync (${JSON.stringify(subject)}), not by \`${BREAKER_RESET_COMMAND}\` or the sweep — a breaker state planted in a worktree is not a person's reset`, blob, corrupt: true };
  }
  return { ok: true, state: p.state, blob };
}
/** 기본 dir로 run 기록을 통째로 미는 동기화들의 커밋 메시지(run-stage의 스테이지 끝·abort, retro). 상태 파일은 이 문으로 오지 않는다. */
const STAGE_SYNC_MESSAGE = /^(?:run-record|retro):/;

/**
 * 상태 파일 하나를 **교체**한다(`overwrite` + `expectBlob` — 읽은 그 blob이 아니면 아무것도 밀지 않고 `moved:true`).
 * 로컬 파일은 syncRecords가 해시하려고 잠깐 쓰고 **반드시 지운다**: `listMarkdownFiles`는 하위 디렉터리까지 걷기 때문에, 남겨 두면
 * 다음 스테이지의 기본 dir 동기화가 그것을 꼬리 병합해 JSON 블록을 깨뜨린다(그러면 차단기가 ok:false로 머지를 막는다).
 */
export async function writeBreakerState({ run, cwd, branch = "factory/records", state, blob = null, message = "breaker: state", env = {} }) {
  const absDir = join(cwd, BREAKER_STATE_DIR);
  const file = join(absDir, BREAKER_STATE_FILE);
  try {
    mkdirSync(absDir, { recursive: true });
    writeFileSync(file, renderBreakerState(state));
    return await syncRecords({ run, cwd, branch, dir: BREAKER_STATE_DIR, message, env, overwrite: [BREAKER_STATE_FILE], expectBlob: { [BREAKER_STATE_FILE]: blob ?? null } });
  } catch (e) {
    return { ok: false, reason: `${e?.message || e}` };
  } finally {
    try { rmSync(file, { force: true }); } catch { /* best-effort */ }
    try { if (!readdirSync(absDir).length) rmdirSync(absDir); } catch { /* best-effort */ }
  }
}

// ── 판정 어댑터(merge 스테이지의 d.breaker, sweep의 read) ─────────────────────────────────────────────────────────

/**
 * 지금 이 순간의 차단기. 세 가지를 읽는다: 상태 파일(리셋 시각), `factory/records`의 run 기록 전부(자동 머지 줄), origin 기본
 * 브랜치의 git log(revert). 어느 하나라도 못 읽으면 `{ ok:false, reason }` — 닫힘이 아니다. 잘 읽었는데 revert가 없으면 닫힘이고,
 * 센 수를 `detail`에 남긴다(그것이 정상 상태다 — 오류가 아니다).
 * → `{ ok:true, open, since, reason, detail, latest, merges, state, blob }`
 */
export const CLOSED_AT_SKEW_MS = 10 * 60 * 1000;
export async function readBreaker({ run, cwd, defaultBranch = "main", thresholds, branch = "factory/records", now = () => Date.now() }) {
  const fail = (reason) => ({ ok: false, reason });
  if (typeof run !== "function" || !cwd) return fail("the breaker reader is not wired (no run/cwd)");
  const st = await readBreakerState({ run, cwd, branch });
  if (!st.ok) return fail(`breaker state: ${st.reason}`);
  // rework r2 sec1 — 미래의 리셋은 리셋이 아니다: closed_at이 지금(+시계 오차)보다 뒤면 그 뒤의 모든 revert를 지우는 영구 닫힘이 된다.
  if (st.state?.closed_at) {
    const nowMs = Number(typeof now === "function" ? now() : now);
    if (!Number.isFinite(nowMs)) return fail("the breaker reader has no clock to check closed_at against");
    if (Date.parse(st.state.closed_at) > nowMs + CLOSED_AT_SKEW_MS) {
      return fail(`breaker state: closed_at ${st.state.closed_at} is in the future (now ${new Date(nowMs).toISOString()}) — a reset records the moment it ran, so this is not a person's reset`);
    }
  }
  let det;
  try { det = await readRecordsDetailed({ run, cwd, branch }); }
  catch (e) { return fail(`${branch} run records could not be read — ${e?.message || e}`); }
  if (!det?.fetched) return fail(`${branch} could not be fetched — the factory's auto-merge records are unknown`);
  if (det.failures?.length) return fail(`${branch} has unreadable run records: ${det.failures.join(", ")}`);
  const b = String(defaultBranch || "main");
  const ref = `refs/remotes/origin/${b}`;
  const f = await run("git", ["fetch", "--quiet", "origin", `+refs/heads/${b}:${ref}`], { cwd });
  if (f?.code !== 0) return fail(`git fetch origin ${b} failed — the reverts on ${b} are unknown: ${String(f?.stderr || "").trim().split("\n")[0]}`);
  const log = await run("git", ["log", `--format=${REVERT_LOG_FORMAT}`, ref], { cwd });
  if (log?.code !== 0) return fail(`git log origin/${b} failed — the reverts on ${b} are unknown: ${String(log?.stderr || "").trim().split("\n")[0]}`);
  let ev, unattributed;
  try {
    const parsed = parseRevertCommits(log.stdout);
    unattributed = parsed.unattributed;
    ev = evaluateBreaker({ history: buildHistory({ records: det.records, reverts: parsed.reverts, mainPrs: parsed.mainPrs }), thresholds, closedAt: st.state?.closed_at ?? null });
  } catch (e) { return fail(`the breaker could not be evaluated — ${e?.message || e}`); }
  const closedAt = st.state?.closed_at ?? null;
  const c = ev.counts;
  const lost = unattributed.length ? `; ${unattributed.length} revert-shaped commit(s) not attributable to a PR (${unattributed.slice(0, 3).map((s) => JSON.stringify(s)).join(", ")})` : "";
  const detail = `${c.merges} self-merge record(s) (${c.judge} judge), ${c.reverts} revert(s) of PRs on origin/${b}${closedAt ? `, ${c.counted_reverts} after the reset at ${closedAt}` : ""}${lost}`;
  return { ok: true, open: ev.open, since: ev.since, reason: ev.reason, detail, latest: ev.latest, merges: ev.merges, state: st.state, blob: st.blob };
}

/** sweep이 쓰는 두 dep — 읽기는 `readBreaker`, 쓰기는 `writeBreakerState`(같은 로컬 파일 규칙). `thresholds`는 값이나 게터. */
export function makeBreakerDeps({ run, cwd, defaultBranch = "main", thresholds, branch = "factory/records" }) {
  return {
    /** `now`(선택): sweep의 시각(ISO 또는 ms) — closed_at이 미래인지 그 시각으로 본다. 없으면 벽시계. */
    read: async ({ now } = {}) => {
      let t;
      try { t = typeof thresholds === "function" ? thresholds() : thresholds; }
      catch (e) { return { ok: false, reason: `CHARTER self_change.breaker is invalid — ${e?.message || e}` }; }
      const clock = now === undefined || now === null ? () => Date.now() : () => (typeof now === "string" ? Date.parse(now) : Number(now));
      return readBreaker({ run, cwd, defaultBranch: typeof defaultBranch === "function" ? defaultBranch() : defaultBranch, thresholds: t, branch, now: clock });
    },
    write: ({ state, blob }) => writeBreakerState({ run, cwd, branch, state, blob, message: `breaker: ${state?.open ? `open since ${state.since}` : "closed"} (sweep)` }),
  };
}

// ── rework r2 sec1·sec2 — 스테이지 끝 동기화의 업로드 가드 ──────────────────────────────────────────────────────────────

/**
 * `docs/factory/runs/**`는 에이전트 세션이 쓸 수 있는 스크래치 경로이고, 스테이지 끝의 `syncRecords`(기본 dir, 하위 디렉터리까지)는
 * 거기 있는 것을 러너의 이름으로 `factory/records`에 민다. 차단기의 증거 둘이 그 경로에 산다 — 상태 파일과 자동 머지 줄 — 그래서
 * 러너는 밀기 **직전에** 그 둘을 걸러 낸다:
 *   - `state/breaker.md`는 지운다. 그 파일의 문은 `writeBreakerState` 하나이고 그것은 쓴 뒤 로컬 파일을 반드시 지운다 — 그러니
 *     스테이지 끝에 워크트리에 있는 상태 파일은 정의상 러너가 쓴 것이 아니다.
 *   - 기록 파일(`docs/factory/runs/*.md`, 자기 것이든 남의 것이든)의 자동 머지 줄은 **이 프로세스가 쓴 줄**(`trust` — merge 스테이지의
 *     `record()`가 지나가는 문)이거나 **이미 브랜치의 그 파일에 있는 줄**(하이드레이트된 접두어)만 남긴다. 나머지는 지운다.
 * `trustLocal`은 abort 정리 스텝(다른 프로세스라 `trust`를 모른다)이 merge 스테이지에서만 켠다 — merge는 에이전트를 부르지 않는다.
 * → `{ removed: [path], dropped: [{ file, line }] }`. 브랜치를 읽지 못하면 브랜치에서 온 줄도 확인할 수 없으므로 믿지 않는다(닫히는 쪽이
 * 아니라 막히는 쪽으로 틀린다).
 */
export async function scrubPlantedBreakerEvidence({ run, cwd, branch = "factory/records", trusted = new Set(), trustLocal = false }) {
  const runsDir = join(cwd, "docs/factory/runs");
  const removed = [];
  const dropped = [];
  const statePath = join(cwd, BREAKER_STATE_DIR, BREAKER_STATE_FILE);
  if (existsSync(statePath)) { rmSync(statePath, { force: true }); removed.push(`${BREAKER_STATE_DIR}/${BREAKER_STATE_FILE}`); }
  if (trustLocal || !existsSync(runsDir)) return { removed, dropped };
  let fetched = null;
  const branchText = async (name) => {
    if (fetched === null) {
      const f = await run("git", ["fetch", "--quiet", "origin", `+refs/heads/${branch}:${GUARD_REF}`], { cwd });
      fetched = f?.code === 0;
    }
    if (!fetched) return "";
    const s = await run("git", ["show", `${GUARD_REF}:docs/factory/runs/${name}`], { cwd });
    return s?.code === 0 ? String(s.stdout ?? "") : "";
  };
  const isSelfMerge = (l) => l.replace(/\r$/, "").startsWith(SELF_MERGE_PREFIX);
  for (const e of readdirSync(runsDir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const file = join(runsDir, e.name);
    const lines = readFileSync(file, "utf8").split("\n");
    const suspect = lines.filter((l) => isSelfMerge(l) && !trusted.has(l.replace(/\r$/, "")));
    if (!suspect.length) continue;
    const known = new Set((await branchText(e.name)).split("\n").map((l) => l.replace(/\r$/, "")).filter(isSelfMerge));
    const keep = lines.filter((l) => {
      const bare = l.replace(/\r$/, "");
      if (!isSelfMerge(l) || trusted.has(bare) || known.has(bare)) return true;
      dropped.push({ file: `docs/factory/runs/${e.name}`, line: bare });
      return false;
    });
    if (keep.length !== lines.length) writeFileSync(file, keep.join("\n"));
  }
  return { removed, dropped };
}
const GUARD_REF = "refs/factory/breaker-guard";

/** 한 스테이지 프로세스의 가드: `trust(lines)`는 이 프로세스가 run 기록에 쓴 줄을 받아 두고, `scrub()`이 그것을 믿는다. */
export function makeRecordsUploadGuard({ run, cwd, branch = "factory/records" }) {
  const trusted = new Set();
  return {
    trust(lines) { for (const l of Array.isArray(lines) ? lines : [lines]) { const s = String(l ?? ""); if (s.startsWith(SELF_MERGE_PREFIX)) trusted.add(s); } },
    scrub: ({ trustLocal = false } = {}) => scrubPlantedBreakerEvidence({ run, cwd, branch, trusted, trustLocal }),
  };
}

// ── 열림 알림(sweep이 한 번만 남긴다) ─────────────────────────────────────────────────────────────────────────────────

/** 열림 알림의 마커 — `since`가 곧 dedupe 키다(같은 열림은 한 번, 리셋 뒤의 새 열림은 새 since). */
export const breakerOpenMarker = (since) => `<!-- factory-breaker-open:v1 since=${since} -->`;
export function breakerOpenComment({ since, reason }) {
  return [
    breakerOpenMarker(since),
    `**자동 머지 차단기가 열렸습니다 (ADR-033) — since ${since}.**`,
    "",
    `사유: ${reason}`,
    "",
    "차단기가 열려 있는 동안 팩토리는 자기 변경 PR(판정·비판정 경로 모두)을 자동 머지하지 않고 사람에게 넘깁니다.",
    `시간이 지나도 닫히지 않습니다 — 사람만 닫습니다: \`${BREAKER_RESET_COMMAND}\` (에이전트 세션·CI에서는 거부됩니다).`,
  ].join("\n");
}
