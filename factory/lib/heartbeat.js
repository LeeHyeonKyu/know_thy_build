/**
 * §4.2 하트비트 — 러너 밖으로 나가는 **유일한 실시간 채널**(ADR-022).
 *
 * 스테이지는 GitHub Actions 안에서 8–35분을 돈다. 그동안 밖에서 볼 수 있는 것은 잡의 stdout(잡이
 * 끝나야 읽기 좋다)과 이 코멘트뿐이다. 그래서 진행 신호는 로그가 아니라 **이 코멘트 한 개**에
 * 실린다 — 이슈마다 하나, 새 코멘트를 만들지 않고 언제나 같은 코멘트를 PATCH한다(알림 폭탄 금지).
 *
 * 본문은 세 겹이다:
 *   1. `<!-- factory-heartbeat issue=N -->` + `stage · runner · started · last` — **예전 그대로**.
 *      `lib/sweeper.js`의 좀비 감시가 이 두 줄을 정규식으로 읽는다(heartbeat.test.js의 SF-4
 *      왕복 테스트가 두 쪽을 한 줄에 세워 둔다). 그래서 이 두 줄은 절대 모양이 바뀌지 않는다.
 *   2. `<!-- factory-progress:v1 {…} -->` — **기계 계약**. `factory board`(Task B)가 읽는 것은
 *      오직 이 한 줄이고, 아래 사람용 표는 전부 이 JSON에서 파생된다.
 *   3. 사람이 읽는 스텝 한 줄 + 에이전트 표.
 *
 * 두 가지 안전장치가 이 파일의 존재 이유다:
 *   - **진행 읽기가 실패해도 하트비트는 죽지 않는다.** `progress()`가 던지면 1번 두 줄만 보낸다.
 *     스테이지의 생명선이 관측 기능 때문에 끊기면 안 된다(그러면 sweeper가 살아 있는 런을 재큐한다).
 *   - **바뀐 게 없으면 PATCH하지 않는다.** 2분 주기 × 35분 = 17번의 쓰기이고, 대부분은 같은 내용이다.
 */

import { progressMarker, parseProgressMarker } from "./progress.js";

/**
 * 기본 주기 2분(예전 10분). 10분은 "살아 있는가"에는 충분했지만 "지금 무엇을 하는가"에는 쓸모가
 * 없었다 — 8분짜리 스테이지가 갱신 한 번으로 끝난다. sweeper의 stale 임계는 30분이라 2분은
 * 그 예산 안에서 넉넉하고(15번 놓쳐야 좀비 판정), 이슈당 쓰기 17회는 API 한도에 비해 무시할 수 있다.
 */
export const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;
/** GitHub 이슈 코멘트 본문 상한. 넘으면 PATCH 자체가 422로 실패한다 — 넘기기 전에 우리가 자른다. */
export const MAX_COMMENT_BYTES = 64 * 1024;
/** 사람용 표에 그리는 행 수 상한(마커 안의 `agents`는 그대로 둔다 — 뷰어는 다 보여 줄 수 있다). */
export const TABLE_ROW_CAP = 40;

const k = (n) => (Number(n) >= 1000 ? `${(Number(n) / 1000).toFixed(1)}k` : String(Number(n) || 0));
/** 파이프는 마크다운 표의 칸 구분자다 — 툴 인자에 섞여 있으면 표가 통째로 깨진다. */
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

/** ISO 두 값의 간격을 사람 단위로. 못 읽으면 null(그럼 괄호를 아예 안 그린다). */
function since(from, to) {
  const a = Date.parse(from), b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  const min = Math.floor((b - a) / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h ${min % 60}m`;
}
const shortSince = (from, to) => {
  const s = since(from, to);
  return s ? s.replace(" min", "m") : null;
};

const STATUS = {
  running: () => "● running",
  waiting: () => "○ waiting",
  done: (a, updated) => { const d = shortSince(a.started, a.ended || updated); return d ? `✓ done ${d}` : "✓ done"; },
};

/** `progress:v1` → 사람이 읽는 스텝 줄 + 표. 마커의 내용만 쓴다(딴 데서 값을 가져오지 않는다). */
export function renderProgressTable(p) {
  const lines = [];
  const dur = p.step?.since ? since(p.step.since, p.updated) : null;
  const stepBits = [p.step?.phase, p.step?.label].filter(Boolean).join(" · ");
  lines.push(`step: ${stepBits || "—"}${dur ? ` (${dur})` : ""}`
    + ` · tokens ${k(p.totals?.input_tokens)} in / ${k(p.totals?.output_tokens)} out`
    + ` · $${(Number(p.totals?.cost_usd) || 0).toFixed(2)}`);
  const rows = (p.agents || []).slice(0, TABLE_ROW_CAP);
  if (rows.length) {
    lines.push("", "| agent | status | last tool | in | out |", "|---|---|---|---|---|");
    for (const a of rows) {
      const status = (STATUS[a.status] || (() => a.status))(a, p.updated);
      lines.push(`| ${cell(a.label)} | ${status} | ${cell(a.last_tool) || "—"} | ${k(a.input_tokens)} | ${k(a.output_tokens)} |`);
    }
  }
  const hidden = ((p.agents || []).length - rows.length) + (Number(p.truncated_agents) || 0);
  if (hidden > 0) lines.push(`…and ${hidden} more agents (totals above include them)`);
  if (p.files_touched?.length) lines.push("", `files: ${p.files_touched.map(cell).join(", ")}`);
  return lines.join("\n");
}

/**
 * 코멘트 본문 한 벌. `progress`가 없거나 비면 **예전의 두 줄 그대로**다 — 그 경로가 폴백이고,
 * sweeper가 읽는 계약이며, 이 함수의 기본값이다.
 *
 * 크기: 마커는 60 KB 예산으로 스스로 줄고(`progressMarker`), 그래도 전체가 64 KB를 넘으면 표를
 * 절반씩 줄여 가며 맞춘다. 마지막까지 안 맞으면 두 줄로 돌아간다 — **본문이 안 들어가느니
 * 진행 표시를 포기한다**(PATCH가 422로 죽으면 sweeper에게는 "하트비트가 멈췄다"로 보인다).
 */
export function heartbeatBody({ issue, stage, runnerId, started, last, progress = null }) {
  const head = `<!-- factory-heartbeat issue=${issue} -->\nstage: ${stage} · runner: ${runnerId} · started: ${started} · last: ${last}`;
  if (!progress || typeof progress !== "object") return head;
  const budget = MAX_COMMENT_BYTES - Buffer.byteLength(head, "utf8") - 2;
  const marker = progressMarker(progress, { maxBytes: Math.floor(budget / 2) });
  // 표는 마커가 실제로 실어 보낸 것(잘렸을 수 있다)에서 그린다 — 두 겹이 다른 이야기를 하면 안 된다.
  const shown = parseProgressMarker(marker) || progress;
  let table = renderProgressTable(shown);
  let body = `${head}\n${marker}\n${table}`;
  while (Buffer.byteLength(body, "utf8") > MAX_COMMENT_BYTES) {
    const rows = table.split("\n");
    if (rows.length <= 1) return head;
    table = rows.slice(0, Math.floor(rows.length / 2)).join("\n") + "\n…truncated";
    body = `${head}\n${marker}\n${table}`;
  }
  return body;
}

/**
 * 코멘트를 한 번 만들고, `intervalMs`마다 같은 코멘트를 다시 쓴다.
 *
 * @param progress `() => progress:v1 | null`. 없으면 예전 동작 그대로다. 던져도 무방하다 —
 *   그 주기는 두 줄짜리 본문으로 넘어가고 다음 주기에 다시 시도한다(한 번의 실패가 영구적인
 *   기능 정지가 되지 않는다).
 */
export async function startHeartbeat({ gh, issue, stage, runnerId, intervalMs = HEARTBEAT_INTERVAL_MS, now = () => new Date().toISOString(), progress = null }) {
  const snapshot = () => { try { return progress ? progress() : null; } catch { return null; } };
  const body = (last) => heartbeatBody({ issue, stage, runnerId, started, last, progress: snapshot() });
  const started = now();
  let lastBody = body(started);
  const url = await gh.comment(issue, lastBody);
  const id = Number(/issuecomment-(\d+)/.exec(url)?.[1]);
  if (!Number.isFinite(id)) {
    console.warn("factory: heartbeat comment id unparseable; heartbeat disabled");
    return { commentId: null, stop() {} };
  }
  const timer = setInterval(() => {
    const next = body(now());
    if (next === lastBody) return;                                   // 바뀐 게 없으면 쓰지 않는다
    lastBody = next;
    gh.patchComment(id, next).catch(() => {});
  }, intervalMs);
  return { commentId: id, stop: () => clearInterval(timer) };
}
