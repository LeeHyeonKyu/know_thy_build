/**
 * §4.2 진행 신호 — `progress:v1` (ADR-022, factory board Task A).
 *
 * **문제.** 한 스테이지는 8–35분을 돈다. 그동안 러너 밖으로 나오는 유일한 신호는 하트비트 코멘트
 * 두 줄(`stage · runner · started · last`)이었다. "살아 있다"는 말하지만 **무엇을 하고 있는지**는
 * 한 글자도 말하지 않는다 — 어느 스텝인지, 어떤 에이전트가 무엇을 읽고 있는지, 지금까지 토큰을
 * 얼마나 태웠는지. 그 답은 전부 **디스크 위에 이미 있다**: `claude -p`의 세션 JSONL은 러너의
 * 홈에서 한 줄씩 자라고 있고, 서브에이전트들도 각자 자기 트랜스크립트를 갖는다.
 *
 * 이 모듈이 하는 일은 하나다 — 그 파일들을 **마지막으로 읽은 자리부터** 이어 읽어(tail) 한 개의
 * 작은 객체(`progress:v1`)로 접는다. 그 객체가 하트비트 코멘트에 실려 나가고(`lib/heartbeat.js`),
 * 런 기록에도 한 줄로 남는다(`bin/run-stage.js`). 뷰어(Task B)는 그 마커만 읽는다.
 *
 * **읽는 것과 절대 읽지 않는 것.** assistant 줄의 `message.usage`(토큰)·`message.model`(가격)·
 * `content[].tool_use`(어떤 툴을 어떤 인자로 불렀는지)만 본다. `tool_result`는 **파싱조차 하지
 * 않는다** — 그 안에는 파일 전문·`env` 덤프·비밀이 그대로 들어 있고, 이 객체는 공개 이슈 코멘트로
 * 나간다. 이 경계는 테스트가 지킨다("last_tool never carries tool RESULT text").
 *
 * **모양의 근거.** 실측 `~/.claude/projects/<슬러그>/<session_id>.jsonl`(2026-09-14): 줄 하나가 이벤트 하나이고
 * `{type, timestamp, message:{model, usage:{input_tokens, output_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens}, content:[{type:"thinking"|"text"|"tool_use", name, input}]}}` 모양이다.
 * `type`은 `assistant`·`user`·`system`·`progress` 등 십수 가지가 섞여 오고 앞으로 더 는다 —
 * 그래서 **모르는 줄은 전부 조용히 건너뛴다**. 형식이 바뀌면 진행 표시가 비어 갈 뿐, 하트비트도
 * 스테이지도 죽지 않는다(그것이 `startHeartbeat`의 폴백 계약이다).
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { costFromUsage } from "./usage.js";
import { transcriptPathFrom } from "./stage-artifact.js";

/** 코멘트에 싣는 기계 계약. Task B(뷰어)와 `parseProgressMarker`가 이 한 줄만 본다. */
export const PROGRESS_MARKER_RE = /<!-- factory-progress:v1 (\{.*\}) -->/;

/**
 * 표에 싣는 에이전트 수 상한. 리뷰 로스터는 라운드마다 늘어나고(R1·R2·disputes) 재시도까지 더하면
 * 수십 개가 된다 — 40이면 어떤 실제 로스터도 덮으면서 코멘트가 사람이 읽을 수 있는 길이로 남는다.
 * 잘린 에이전트의 토큰도 `totals`에는 그대로 들어간다: 표만 짧아지고 합계는 거짓말하지 않는다.
 */
export const AGENT_CAP = 40;
/** `files_touched` 상한. 이건 "무엇을 건드렸나"의 힌트지 diff가 아니다 — 진짜 목록은 PR에 있다. */
export const FILES_CAP = 30;
/** 마커 JSON의 기본 예산. GitHub 코멘트 상한(64 KB)에서 사람용 표 몫을 뺀 값. */
export const MARKER_MAX_BYTES = 60 * 1024;

/** Edit 계열만 "건드렸다"로 센다 — Read는 읽은 것이지 바꾼 것이 아니다. */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/**
 * `last_tool`의 인자로 고를 후보, 우선순위 순. **경로·패턴·명령처럼 이미 짧고 이름에 가까운 것만**
 * 고른다 — `prompt`·`content`·`new_string`은 일부러 뺐다: 그 값들은 KB 단위이고 코드·프롬프트 전문이
 * 들어 있어, 잘라 실어도 코멘트로 새어 나가면 곤란한 종류의 텍스트다.
 */
const TOOL_ARG_KEYS = ["file_path", "notebook_path", "command", "pattern", "path", "query", "url", "skill", "subagent_type", "name"];
const ARG_MAX = 60;

/** `<ToolName> <short arg>` 한 조각. 인자를 못 고르면 툴 이름만. */
export function toolLabel(block) {
  const name = String(block?.name ?? "").trim();
  if (!name) return null;
  const input = block?.input;
  if (!input || typeof input !== "object") return name;
  for (const k of TOOL_ARG_KEYS) {
    const v = input[k];
    if (typeof v !== "string" || !v.trim()) continue;
    const one = v.replace(/\s+/g, " ").trim();
    return `${name} ${one.length > ARG_MAX ? one.slice(0, ARG_MAX) + "…" : one}`;
  }
  return name;
}

/** 접기의 항등원. `parseTranscriptLines(lines, prev)`의 `prev` 기본값이자 반환 모양. */
export function emptyFold() {
  return {
    turns: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    cost_usd: 0, started: null, ended: null, last_tool: null, files_touched: [],
  };
}

/**
 * JSONL 줄들을 `prev` 위에 **누적**한다. 순수 함수다 — 파일도 시계도 만지지 않으므로 테스트가
 * 픽스처 문자열만으로 전부 고정할 수 있고, tail은 같은 함수를 새 줄에만 다시 부르면 된다.
 * `prev`는 변형하지 않는다(복사본을 돌려준다) — 호출자가 이전 상태를 그대로 들고 있어도 안전하다.
 */
export function parseTranscriptLines(lines, prev = emptyFold()) {
  const f = { ...prev, files_touched: [...(prev.files_touched || [])] };
  const seen = new Set(f.files_touched);
  for (const line of lines || []) {
    if (!line || !String(line).trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }               // 반쪽 줄·로그 잡음 — 조용히 넘긴다
    if (typeof o?.timestamp === "string" && o.timestamp) {
      f.started ??= o.timestamp;
      f.ended = o.timestamp;                                        // "마지막 활동"은 어느 줄이든 갱신한다
    }
    if (o?.type !== "assistant") continue;                          // user(tool_result)·system·progress는 여기서 끝
    const u = o?.message?.usage || {};
    const add = {
      input_tokens: Number(u.input_tokens) || 0,
      output_tokens: Number(u.output_tokens) || 0,
      cache_read_tokens: Number(u.cache_read_input_tokens) || 0,
      cache_creation_tokens: Number(u.cache_creation_input_tokens) || 0,
    };
    f.turns += 1;
    for (const k of Object.keys(add)) f[k] += add[k];
    // 비용은 **줄마다** 그 줄의 모델로 계산해 더한다 — 한 세션이 모델을 갈아탈 수 있으므로
    // (서브에이전트 로스터는 역할마다 모델이 다르다) 합산 후 한 번에 곱하면 틀린다.
    f.cost_usd += costFromUsage({ model: o?.message?.model, ...add });
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== "tool_use") continue;
      const label = toolLabel(b);
      if (label) f.last_tool = label;                               // 같은 턴 안에서는 마지막 호출이 이긴다
      if (!WRITE_TOOLS.has(b.name)) continue;
      const p = b?.input?.file_path ?? b?.input?.notebook_path;
      if (typeof p !== "string" || !p || seen.has(p) || seen.size >= FILES_CAP) continue;
      seen.add(p);
      f.files_touched.push(p);
    }
  }
  return f;
}

// ── tail (offset을 기억하는 유일한 가변 상태) ────────────────────────────────

/**
 * 파일 경로 → `{ size, remainder, fold }`. 프로세스 수명 동안 메모리에만 산다(디스크에 쓰지 않는다):
 * 이 상태를 잃어도 다음 읽기가 파일을 처음부터 다시 접을 뿐 결과는 같다. 테스트는 자기 Map을 준다.
 */
const OFFSETS = new Map();
export const resetProgressState = (state = OFFSETS) => state.clear();

/**
 * 마지막으로 읽은 바이트 뒤부터 이어 읽어 접는다. 세 가지를 지킨다:
 *   - 파일이 **아직 없으면** null(그 에이전트는 아직 첫 줄을 쓰지 않았다 — 오류가 아니다).
 *   - 파일이 **줄어들었으면**(새 런이 같은 경로를 재사용) offset을 0으로 되돌려 처음부터 접는다.
 *   - **마지막 개행 뒤의 조각은 남겨 둔다** — 지금 이 순간에도 쓰이는 중인 줄이라 반쪽 JSON이다.
 *     남는 조각은 Buffer로 들고 있는다(문자열로 바꾸면 멀티바이트 문자가 경계에서 깨진다).
 */
function tailFold(path, state) {
  let st;
  try { st = statSync(path); } catch { return state.get(path)?.fold ?? null; }
  if (!st.isFile()) return null;
  let e = state.get(path);
  if (!e || st.size < e.size) { e = { size: 0, remainder: Buffer.alloc(0), fold: emptyFold() }; state.set(path, e); }
  if (st.size > e.size) {
    const len = st.size - e.size;
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    const fd = openSync(path, "r");
    try { read = readSync(fd, buf, 0, len, e.size); } finally { closeSync(fd); }
    e.size += read;
    const chunk = Buffer.concat([e.remainder, buf.subarray(0, read)]);
    const nl = chunk.lastIndexOf(0x0a);
    if (nl < 0) { e.remainder = chunk; }
    else {
      e.remainder = chunk.subarray(nl + 1);
      e.fold = parseTranscriptLines(chunk.subarray(0, nl).toString("utf8").split("\n"), e.fold);
    }
  }
  return e.fold;
}

// ── agents.jsonl → 이 런이 띄운 에이전트들 ───────────────────────────────────

/**
 * 훅(`hooks/record-agents.sh`)이 SubagentStart/Stop의 stdin 전문을 그대로 적어 둔다. 페이로드
 * 모양은 Claude Code 버전마다 조금씩 다르다 — 실측(2026-09-14)에서는 Stop만, 그것도
 * `{hook_event_name, agent_type, agent_transcript_path}`만 실려 왔고, 다른 버전은 `agent_id`·
 * `description`·`transcript_path`까지 싣는다. 그래서 **키를 하나도 필수로 두지 않는다**:
 *   - 신원: `agent_id` → 없으면 `agent_transcript_path`(에이전트마다 고유한 임시 경로다).
 *   - 라벨: `description`/`label`(워크플로가 준 `R1:architecture` 같은 이름) → 없으면 `agent_type`.
 *   - 트랜스크립트: `agent_transcript_path`(서브에이전트 **자신의** 것). `transcript_path`는
 *     오케스트레이터 세션을 가리키므로 여기서 쓰지 않는다 — 그건 아래 `mainTranscript`의 몫이다.
 */
export function readAgentEvents(agentsLogText) {
  const byId = new Map();
  for (const line of String(agentsLogText || "").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ev = o?.hook_event_name;
    if (ev !== "SubagentStart" && ev !== "SubagentStop") continue;
    const transcript = typeof o.agent_transcript_path === "string" ? o.agent_transcript_path : null;
    const id = o.agent_id || transcript;
    if (!id) continue;
    const cur = byId.get(id) || { id, label: null, transcript: null, stopped: false, order: byId.size };
    cur.label ||= [o.description, o.label, o.agent_type].find((v) => typeof v === "string" && v.trim()) || null;
    cur.transcript ||= transcript;
    if (ev === "SubagentStop") cur.stopped = true;
    byId.set(id, cur);
  }
  return [...byId.values()];
}

/**
 * 오케스트레이터 세션의 트랜스크립트 경로.
 *
 * 1순위는 `agents.jsonl`의 `transcript_path`(훅이 Claude Code에게서 직접 받아 적은 값) —
 * `stage-artifact.js`의 `transcriptPathFrom`과 **같은 함수**를 쓴다: 경로 계산이 두 벌이 되면
 * 산출물 추출과 진행 표시가 서로 다른 파일을 보게 된다.
 *
 * 그 값이 없을 때가 문제다(실측 페이로드에는 없었다). 스테이지가 **도는 중**이라 `session_id`도
 * 아직 모른다 — 봉투는 런이 끝나야 쓰인다. 그래서 마지막 수단으로 이 cwd의 프로젝트 디렉터리에서
 * **가장 최근에 수정된 `.jsonl`**을 고른다. CI 러너에는 이 저장소의 세션이 하나뿐이라 정확하고,
 * 로컬에서는 사람이 같은 저장소에서 딴 세션을 돌리고 있으면 그 세션을 볼 수 있다 — 진행 표시가
 * 조금 틀릴 뿐 아무것도 깨뜨리지 않는 종류의 오차라 best-effort로 둔다.
 */
export function mainTranscriptPath({ root, home = homedir(), agentsLogText = "" } = {}) {
  const fromHook = transcriptPathFrom({ agentsLogText });
  if (fromHook) return fromHook;
  const dir = join(home, ".claude", "projects", String(root).replace(/[^a-zA-Z0-9]/g, "-"));
  let best = null;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const p = join(dir, name);
      let st; try { st = statSync(p); } catch { continue; }
      if (!best || st.mtimeMs > best.mtimeMs) best = { p, mtimeMs: st.mtimeMs };
    }
  } catch { return null; }
  return best?.p ?? null;
}

// ── progress:v1 ─────────────────────────────────────────────────────────────

const round6 = (n) => Math.round(n * 1e6) / 1e6;

const agentFrom = (label, kind, status, fold) => ({
  label, kind, status,
  started: fold?.started ?? null,
  ended: status === "done" ? (fold?.ended ?? null) : null,
  last_tool: fold?.last_tool ?? null,
  turns: fold?.turns ?? 0,
  input_tokens: fold?.input_tokens ?? 0,
  output_tokens: fold?.output_tokens ?? 0,
  cache_read_tokens: fold?.cache_read_tokens ?? 0,
  cost_usd: round6(fold?.cost_usd ?? 0),
});

/**
 * 지금 이 순간의 `progress:v1`. 실패하지 않는다 — 읽을 파일이 하나도 없으면 모양만 갖춘 빈 객체다
 * (하트비트는 그걸 보고 예전의 두 줄짜리 본문으로 돌아간다).
 *
 * `step`은 **최선의 추측**이다: 지금 도는 서브에이전트 중 가장 최근에 시작한 것의 라벨이 곧 스텝이고,
 * `phase`는 그 라벨의 `:` 앞부분(`R1:architecture` → `R1`)이다. 워크플로가 `phase('R1')`과
 * `label: 'R1:${name}'`을 같은 축으로 붙여 주기 때문에 이 규칙이 성립한다(`workflows/factory-review.js`).
 * `:`가 없는 라벨(로스터 밖의 에이전트)에는 phase를 **지어내지 않는다** — null이다.
 */
export function readProgress({
  root, stage = null, issue = null, runner = null, started = null,
  now = () => new Date().toISOString(), home = homedir(), state = OFFSETS, mainTranscript = null,
} = {}) {
  let agentsLogText = "";
  try {
    const p = join(root, ".factory/out/agents.jsonl");
    if (existsSync(p)) agentsLogText = readFileSync(p, "utf8");
  } catch { /* 훅 기록이 없다 = 서브에이전트를 아직 안 띄웠다 */ }

  // 에이전트 하나 = (요약 객체, 그 에이전트의 fold) 한 쌍. fold를 옆에 들고 다녀야
  // `files_touched` 합집합을 한 번의 순회로 만들 수 있다(요약 객체에는 파일 목록을 싣지 않는다 —
  // 그건 런 전체의 성질이지 에이전트별로 보여 줄 값이 아니다).
  const pairs = [];
  // `mainTranscript`를 준 호출자는 세션 경로를 이미 안다(테스트, 그리고 언젠가 run-stage가
  // session_id를 미리 알게 되는 날). 없으면 훅 기록 → 프로젝트 디렉터리 순으로 찾는다.
  const main = mainTranscript || mainTranscriptPath({ root, home, agentsLogText });
  const mainFold = main ? tailFold(main, state) : null;
  if (mainFold) pairs.push([agentFrom(stage || "orchestrator", "orchestrator", "running", mainFold), mainFold]);

  for (const ev of readAgentEvents(agentsLogText)) {
    const fold = ev.transcript ? tailFold(ev.transcript, state) : null;
    // 상태 세 값: Stop 훅을 봤으면 done, 아니면 트랜스크립트에 활동이 있으면 running,
    // 시작은 했는데 아직 한 줄도 안 썼으면 waiting(모델 대기·컨테이너 기동 중이다).
    const status = ev.stopped ? "done" : (fold?.turns ? "running" : "waiting");
    pairs.push([agentFrom(ev.label || "agent", "subagent", status, fold), fold]);
  }

  const agents = pairs.map(([a]) => a);
  const totals = { turns: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0 };
  const files = [];
  const seen = new Set();
  for (const [a, fold] of pairs) {
    totals.turns += a.turns;
    totals.input_tokens += a.input_tokens;
    totals.output_tokens += a.output_tokens;
    totals.cache_read_tokens += a.cache_read_tokens;
    totals.cost_usd += a.cost_usd;
    for (const path of fold?.files_touched || []) {
      if (!seen.has(path) && files.length < FILES_CAP) { seen.add(path); files.push(path); }
    }
  }
  totals.cost_usd = round6(totals.cost_usd);

  // 지금 도는 서브에이전트 중 가장 늦게 시작한 것 = 사람이 "지금 무슨 일이 일어나는가"로 읽는 값.
  const live = agents.filter((a) => a.kind === "subagent" && a.status !== "done");
  live.sort((a, b) => String(a.started || "").localeCompare(String(b.started || "")));
  const current = live[live.length - 1] || null;
  const label = current?.label ?? null;
  const step = {
    phase: label && label.includes(":") ? label.slice(0, label.indexOf(":")) : null,
    label,
    since: current?.started ?? null,
  };

  const kept = agents.length > AGENT_CAP
    ? [...agents.filter((a) => a.kind === "orchestrator"), ...agents.filter((a) => a.kind === "subagent").slice(-(AGENT_CAP - agents.filter((a) => a.kind === "orchestrator").length))]
    : agents;
  return {
    stage, issue, runner, started, updated: now(),
    step, agents: kept, totals, files_touched: files,
    ...(kept.length < agents.length ? { truncated_agents: agents.length - kept.length } : {}),
  };
}

// ── 마커 (기계 계약) ────────────────────────────────────────────────────────

/**
 * `progress:v1` → 한 줄짜리 HTML 주석. **한 줄인 것이 계약의 일부다**: 코멘트에서도 런 기록에서도
 * 정규식 한 방으로 집히고, 사람이 보는 마크다운을 어지럽히지 않는다.
 *
 * 예산을 넘으면 **버리는 순서가 정해져 있다** — `files_touched` 먼저, 그다음 에이전트를 뒤에서부터.
 * `totals`는 절대 버리지 않는다: 표가 비어도 "이 런이 얼마를 태웠나"는 남아야 한다.
 */
export function progressMarker(progress, { maxBytes = MARKER_MAX_BYTES } = {}) {
  const wrap = (o) => `<!-- factory-progress:v1 ${JSON.stringify(o)} -->`;
  const fits = (s) => Buffer.byteLength(s, "utf8") <= maxBytes;
  let out = wrap(progress);
  if (fits(out)) return out;
  const shed = { ...progress, files_touched: [] };
  out = wrap(shed);
  if (fits(out)) return out;
  const agents = [...(shed.agents || [])];
  const dropped0 = Number(shed.truncated_agents) || 0;
  while (agents.length > 0) {
    agents.pop();
    const next = { ...shed, agents, truncated_agents: dropped0 + ((shed.agents?.length || 0) - agents.length) };
    out = wrap(next);
    if (fits(out)) return out;
  }
  return wrap({ ...shed, agents: [], truncated_agents: dropped0 + (shed.agents?.length || 0) });
}

/** 텍스트(코멘트 본문·런 기록 섹션) 안의 마커 → 객체. 없거나 깨졌으면 null. */
export function parseProgressMarker(text) {
  const m = PROGRESS_MARKER_RE.exec(String(text ?? ""));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
