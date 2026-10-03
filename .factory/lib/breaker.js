import { mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
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
 * history = 자동 머지(`kind:"auto-merge"`, run 기록의 줄) + revert(`kind:"revert"`, git log). `records`는 `readRecordsDetailed`의
 * `Map<issue, text>`(또는 같은 모양의 객체). 같은 PR이 두 번 기록됐으면 처음 것 하나만 남긴다.
 */
export function buildHistory({ records, reverts = [] }) {
  const map = records instanceof Map ? records : new Map(Object.entries(records || {}));
  const merges = new Map();
  for (const text of map.values()) {
    for (const m of parseSelfMergeLines(text)) {
      const prev = merges.get(m.pr);
      if (!prev || Date.parse(m.at) < Date.parse(prev.at)) merges.set(m.pr, m);
    }
  }
  const history = [
    ...[...merges.values()].map((m) => ({ kind: "auto-merge", at: m.at, issue: m.issue, pr: m.pr, judge: m.judge })),
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
  const judge = events.filter((e) => e?.kind === "auto-merge" && e.judge === true)
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
  return { ok: true, state: p.state, blob };
}

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
export async function readBreaker({ run, cwd, defaultBranch = "main", thresholds, branch = "factory/records" }) {
  const fail = (reason) => ({ ok: false, reason });
  if (typeof run !== "function" || !cwd) return fail("the breaker reader is not wired (no run/cwd)");
  const st = await readBreakerState({ run, cwd, branch });
  if (!st.ok) return fail(`breaker state: ${st.reason}`);
  let det;
  try { det = await readRecordsDetailed({ run, cwd, branch }); }
  catch (e) { return fail(`${branch} run records could not be read — ${e?.message || e}`); }
  if (!det?.fetched) return fail(`${branch} could not be fetched — the factory's auto-merge records are unknown`);
  if (det.failures?.length) return fail(`${branch} has unreadable run records: ${det.failures.join(", ")}`);
  const b = String(defaultBranch || "main");
  const ref = `refs/remotes/origin/${b}`;
  const f = await run("git", ["fetch", "--quiet", "origin", `+refs/heads/${b}:${ref}`], { cwd });
  if (f?.code !== 0) return fail(`git fetch origin ${b} failed — the reverts on ${b} are unknown: ${String(f?.stderr || "").trim().split("\n")[0]}`);
  const log = await run("git", ["log", "--format=%cI%x09%s", ref], { cwd });
  if (log?.code !== 0) return fail(`git log origin/${b} failed — the reverts on ${b} are unknown: ${String(log?.stderr || "").trim().split("\n")[0]}`);
  let ev;
  try {
    const reverts = parseRevertLog(log.stdout);
    ev = evaluateBreaker({ history: buildHistory({ records: det.records, reverts }), thresholds, closedAt: st.state?.closed_at ?? null });
  } catch (e) { return fail(`the breaker could not be evaluated — ${e?.message || e}`); }
  const closedAt = st.state?.closed_at ?? null;
  const c = ev.counts;
  const detail = `${c.merges} self-merge record(s) (${c.judge} judge), ${c.reverts} revert(s) of PRs on origin/${b}${closedAt ? `, ${c.counted_reverts} after the reset at ${closedAt}` : ""}`;
  return { ok: true, open: ev.open, since: ev.since, reason: ev.reason, detail, latest: ev.latest, merges: ev.merges, state: st.state, blob: st.blob };
}

/** sweep이 쓰는 두 dep — 읽기는 `readBreaker`, 쓰기는 `writeBreakerState`(같은 로컬 파일 규칙). `thresholds`는 값이나 게터. */
export function makeBreakerDeps({ run, cwd, defaultBranch = "main", thresholds, branch = "factory/records" }) {
  return {
    read: async () => {
      let t;
      try { t = typeof thresholds === "function" ? thresholds() : thresholds; }
      catch (e) { return { ok: false, reason: `CHARTER self_change.breaker is invalid — ${e?.message || e}` }; }
      return readBreaker({ run, cwd, defaultBranch: typeof defaultBranch === "function" ? defaultBranch() : defaultBranch, thresholds: t, branch });
    },
    write: ({ state, blob }) => writeBreakerState({ run, cwd, branch, state, blob, message: `breaker: ${state?.open ? `open since ${state.since}` : "closed"} (sweep)` }),
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
