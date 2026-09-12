/**
 * §4.2 스테이지 산출물 추출(KTB-7).
 *
 * 원래 설계는 디스패처 세션의 **마지막 텍스트**가 곧 workflow의 return 값이라고 믿었다. 데모 dogfood
 * 이슈 #2의 plan에서 그 믿음이 깨졌다: workflow는 19개 에이전트로 정상 완주했는데(3,594 s,
 * $11.95), 약 20 KB짜리 return 값을 최종 메시지로 **다시 타이핑**해야 했던 디스패처가 그걸
 * 요약해 버렸다 — `"r1": [ /* full R1 … *​/ ]` 같은 JS 주석과 `"…"` 축약이 섞여 들어가
 * ```json 펜스가 유효한 JSON이 아니게 됐고, 스테이지는 needs-human으로 끝났다.
 *
 * 그래서 산출물의 출처를 하나로 믿지 않는다. 후보를 순서대로 훑고, **스키마를 통과하는 첫 후보**가
 * 이긴다(파싱만 되는 후보는 이기지 못한다 — 계획 안의 중첩 객체 하나가 "파싱은 된다"는 이유로
 * 선택되던 것이 정확히 그 오진의 원인이었다).
 *
 * **KTB-17 — 1순위 후보가 틀린 자리를 보고 있었다.** 원래 1순위는 `Workflow` tool_result였는데,
 * `Workflow` 툴은 **백그라운드**로 돈다 — 그 tool_result는 반환값이 아니라 접수증이다:
 * `"Workflow launched in background. Task ID: … Transcript dir: …"`. 실제 반환값은 한참 뒤
 * **USER 텍스트 블록**으로 온다(`<task-notification>…<status>completed</status>…<result>{…}</result>`),
 * 그리고 디스패처가 그 알림의 `<output-file>`을 `Read`로 읽으면 tool_result에 한 번 더 나타난다.
 * 데모 #2 plan 재실행(run 34700674634)이 그 증거다: 계획은 트랜스크립트 안에 **있었는데**
 * 폴백은 접수증만 보고 "no JSON object in result"라고 답했다.
 *
 * 두 가지가 더 있다: (1) 알림의 `<result>`는 길면 **잘린다**(그 런에서 45 KB → 8 KB + "truncated"),
 * (2) `Read`는 한 번에 파일 전체를 주지 않는다 — 줄 번호가 붙은(`N\t…`) **조각**으로 여러 번 온다.
 * 그래서 조각을 파일별로 줄 번호 순서대로 다시 붙인 텍스트가 하나의 후보가 된다.
 *
 * 후보 순서:
 *   1. `<task-notification>` 중 `<status>completed</status>`인 마지막 것의 `<result>`.
 *   2. `Read` tool_result를 파일별로 재조립한 내용 → 그리고 개별 tool_result 하나하나
 *      (둘 다 `^\d+\t` 줄 번호 접두를 벗기고, `{summary,agentCount,logs,result}` 봉투면 한 겹 벗긴다).
 *   3. `Workflow` tool_result — **접수증이 아닐 때만**(백그라운드가 아닌 워크플로는 여기로 온다).
 *   4. envelope.result 안의 ```json 펜스.
 *   5. envelope.result 안의 맨 JSON(균형 스캔).
 *
 * 전부 실패하면 후보별로 무엇이 어긋났는지 한 줄씩 적어 돌려준다 — 그 줄이 run 기록과 전이 사유로
 * 나가므로, "issue is required; tier is required; …" 같은 2차 증상 대신 진짜 원인이 남는다.
 */

/** ```json 펜스가 있는데 JSON.parse에 실패하면 그 이유. 펜스가 없거나 정상이면 null. */
export function fencedJsonError(text) {
  if (typeof text !== "string") return null;
  const fence = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (!fence) return null;
  try { JSON.parse(fence[1]); return null; } catch (e) { return e?.message || String(e); }
}

/** start의 '{'에 대응하는 '}' 인덱스. 문자열 리터럴과 \" 이스케이프를 건너뛴다. 없으면 -1. */
function matchBrace(text, start) {
  let depth = 0, inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (ch === "\\") i++; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 텍스트 안의 모든 균형 JSON 객체를 앞에서부터. 중첩 객체까지 전부 후보로 내놓지는 않는다(최상위만). */
function* balancedObjects(text) {
  if (typeof text !== "string") return;
  for (let start = text.indexOf("{"); start >= 0; ) {
    const end = matchBrace(text, start);
    if (end < 0) return;
    try { yield JSON.parse(text.slice(start, end + 1)); } catch { /* 다음 시작점 */ }
    start = text.indexOf("{", start + 1);
  }
}

/**
 * 텍스트의 **첫 `{`에서 시작하는 객체** 하나. 파일 내용처럼 큰 텍스트에 쓰는 싼 경로다 —
 * 전체 균형 스캔은 중괄호마다 다시 훑으므로 100 KB짜리 tool_result에서 비용이 눈에 띈다.
 * 산출물 파일은 `{`로 시작하고, 그 안쪽 중첩 객체는 애초에 후보가 아니다(KTB-7의 오진 원인).
 */
function leadingObject(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  const end = matchBrace(text, start);
  if (end < 0) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/** 펜스 안의 JSON(파싱 성공 시). 없거나 깨졌으면 null. */
function fencedObject(text) {
  if (typeof text !== "string") return null;
  const fence = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (!fence) return null;
  try { return JSON.parse(fence[1]); } catch { return null; }
}

/**
 * Claude Code 트랜스크립트(JSONL) → `Workflow` 툴이 돌려준 결과 텍스트들, 호출 순서대로.
 *
 * 한 줄이 한 이벤트다. assistant 줄의 `message.content[]`에 `{type:"tool_use", name:"Workflow", id}`가
 * 있고, 뒤따르는 user 줄의 `content[]`에 같은 `tool_use_id`를 가진 `{type:"tool_result", content}`가 온다.
 * `content`는 문자열이거나 `{type:"text", text}` 블록 배열 둘 다 나올 수 있어 양쪽을 받는다.
 * 트랜스크립트 형식이 바뀌어도 **조용히 틀리지 않는다** — 찾지 못하면 빈 배열이고, 다음 후보로 내려간다.
 */
export function workflowResultsFromTranscript(text) {
  if (typeof text !== "string" || !text) return [];
  const ids = [];                                                    // Workflow tool_use id, 호출 순서
  const byId = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use" && b?.name === "Workflow" && b?.id) ids.push(b.id);
      if (b?.type === "tool_result" && b?.tool_use_id) {
        const c = b.content;
        const s = typeof c === "string" ? c
          : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("\n")
            : c == null ? "" : JSON.stringify(c);
        if (s) byId.set(b.tool_use_id, s);
      }
    }
  }
  return ids.map((id) => byId.get(id)).filter((s) => typeof s === "string" && s.length > 0);
}

/**
 * 백그라운드 `Workflow` 호출의 tool_result는 반환값이 아니라 **접수증**이다(KTB-17). 첫 줄이
 * 이 문장이면 그 안에 산출물이 있을 수 없으므로 후보로 올리지 않는다 — 후보로 올리면 "스키마를
 * 통과하는 후보가 없다"는 이유가 접수증의 실패로 채워져, 진짜 원인(알림·Read를 안 본다)이 가려진다.
 */
const WORKFLOW_RECEIPT = /^\s*Workflow launched in background/;
export const isWorkflowReceipt = (text) => WORKFLOW_RECEIPT.test(String(text ?? ""));

/**
 * 트랜스크립트 안의 `<task-notification>` 블록들 → `{ status, result }`, 등장 순서.
 *
 * 이것이 백그라운드 워크플로의 **실제 반환값이 도착하는 자리**다. 문자열 content(사용자 턴)와
 * `{type:"text"}` 블록 둘 다에서 찾는다 — 어느 쪽으로 오든 같은 텍스트다. `<result>`가 없거나
 * 비어 있으면 그 알림은 내놓지 않는다(상태만 알리는 알림이 후보를 더럽히지 않게).
 */
export function taskNotificationsFromTranscript(text) {
  const found = [];
  if (typeof text !== "string" || !text) return found;
  for (const line of text.split("\n")) {
    if (!line.trim() || !line.includes("task-notification")) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const c = o?.message?.content;
    const texts = typeof c === "string" ? [c]
      : Array.isArray(c) ? c.filter((b) => b?.type === "text" || typeof b === "string").map((b) => (typeof b === "string" ? b : b.text ?? ""))
        : [];
    for (const t of texts) {
      for (const m of String(t).matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
        const block = m[1];
        const res = /<result>([\s\S]*?)<\/result>/.exec(block);
        if (!res || !res[1].trim()) continue;
        found.push({ status: (/<status>([\s\S]*?)<\/status>/.exec(block)?.[1] || "").trim(), result: res[1] });
      }
    }
  }
  return found;
}

/** `Read`가 붙이는 `N\t` 줄 번호 접두를 벗긴다. 접두가 없는 줄은 그대로 둔다. */
export const stripLineNumbers = (text) =>
  String(text ?? "").split("\n").map((l) => l.replace(/^\d+\t/, "")).join("\n");

/**
 * 파일 읽기 tool_result를 **파일별로 재조립**한 내용. 하나의 `Read`가 파일 전체를 주는 일은 드물다 —
 * 큰 산출물은 `offset`/`limit`으로 여러 번 나뉘어 오고(데모 #2에서는 525줄이 네 조각), 그 어느
 * 조각도 단독으로는 유효한 JSON이 아니다. 줄 번호가 붙어 오는 덕에 순서와 중복을 정확히 복원할 수
 * 있다: 같은 번호가 다시 오면 나중 것이 이긴다(다시 읽은 것이므로).
 *
 * 키는 tool_use의 `input.file_path`다 — 파일별로 나누지 않으면 서로 다른 파일의 1번 줄이 겹쳐
 * 조용히 뒤섞인 텍스트가 만들어진다. 경로를 모르는 tool_result는 여기 들어오지 않는다(개별 후보로는
 * 따로 다뤄진다).
 */
export function fileReadsFromTranscript(text) {
  const out = new Map();                                             // path → Map<lineNo, text>
  if (typeof text !== "string" || !text) return out;
  const idToPath = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use" && b?.id && typeof b?.input?.file_path === "string") idToPath.set(b.id, b.input.file_path);
      if (b?.type === "tool_result" && b?.tool_use_id && idToPath.has(b.tool_use_id)) {
        const path = idToPath.get(b.tool_use_id);
        const s = toolResultText(b.content);
        if (!s) continue;
        if (!out.has(path)) out.set(path, new Map());
        const lines = out.get(path);
        for (const l of s.split("\n")) {
          const m = /^(\d+)\t([\s\S]*)$/.exec(l);
          if (m) lines.set(Number(m[1]), m[2]);
        }
      }
    }
  }
  const joined = new Map();
  for (const [path, lines] of out) {
    if (!lines.size) continue;
    joined.set(path, [...lines.keys()].sort((a, b) => a - b).map((k) => lines.get(k)).join("\n"));
  }
  return joined;
}

/** 모든 tool_result 텍스트, 등장 순서. 어느 툴이 냈는지는 묻지 않는다 — 내용만 본다. */
export function toolResultTextsFromTranscript(text) {
  const out = [];
  if (typeof text !== "string" || !text) return out;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== "tool_result") continue;
      const s = toolResultText(b.content);
      if (s) out.push(s);
    }
  }
  return out;
}

/** tool_result의 content는 문자열이거나 `{type:"text", text}` 블록 배열이다 — 양쪽을 받는다. */
function toolResultText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("\n");
  return c == null ? "" : JSON.stringify(c);
}

/**
 * 이 런의 세션 트랜스크립트(JSONL) 경로.
 *
 * 1순위는 `agents.jsonl`의 `transcript_path` — SubagentStart/Stop 훅이 Claude Code에게서 직접
 * 받아 적은 값이라 슬러그 규칙을 우리가 흉내 낼 필요가 없다. 훅 기록이 없을 때만
 * `~/.claude/projects/<cwd 슬러그>/<session_id>.jsonl`로 계산한다(슬러그: 영숫자 아닌 문자 → `-`).
 * 둘 다 안 되면 null — 호출자는 트랜스크립트 없이 다음 후보로 내려간다.
 */
export function transcriptPathFrom({ agentsLogText, sessionId, cwd, home } = {}) {
  for (const line of String(agentsLogText || "").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (typeof o?.transcript_path === "string" && o.transcript_path) {
      if (!sessionId || o.session_id === sessionId) return o.transcript_path;
    }
  }
  if (!sessionId || !cwd || !home) return null;
  return `${home}/.claude/projects/${String(cwd).replace(/[^a-zA-Z0-9]/g, "-")}/${sessionId}.jsonl`;
}

/**
 * 이 런의 세션 트랜스크립트 **전문**. 없으면 null — 산출물 추출은 트랜스크립트 없이도 돌아간다
 * (envelope의 펜스/맨 JSON으로 내려간다). `readFile(path) → string|null`은 호출자가 주입한다:
 * 이 모듈은 `node:fs`를 import하지 않는다(순수 모듈이라 파서 테스트가 파일시스템을 만들지 않는다).
 *
 * `run-stage.js`와 `retro.js`가 같은 경로 계산을 각자 갖고 있으면 한쪽만 고쳐지는 순간
 * "트랜스크립트가 1순위 출처"라는 계약이 스테이지마다 달라진다 — 그래서 여기 한 벌만 둔다.
 */
export function readTranscript({ root, home, sessionId, readFile } = {}) {
  try {
    const agentsLogText = readFile(`${root}/.factory/out/agents.jsonl`) || "";
    const p = transcriptPathFrom({ agentsLogText, sessionId, cwd: root, home });
    return p ? (readFile(p) ?? null) : null;
  } catch { return null; }
}

/**
 * 후보들을 순서대로 훑어 스키마를 통과하는 첫 객체를 고른다.
 *
 * @param envelopeResult `claude -p --output-format json`의 `result` 문자열.
 * @param transcriptText 세션 트랜스크립트 JSONL 전문(없으면 "" 또는 null — 그냥 후보가 하나 준다).
 * @param validate 객체 하나를 받아 `{ok, errors}`를 주는 함수. 없으면 "파싱되면 통과"로 취급한다.
 * @returns `{ok:true, data, source}` 또는 `{ok:false, reason, tried}`.
 */
export function extractStageArtifact({ envelopeResult, transcriptText, validate } = {}) {
  const check = validate || (() => ({ ok: true, errors: [] }));
  const tried = [];
  const candidates = [];
  /**
   * 워크플로 러너가 반환값을 `{summary, agentCount, logs, result}` 봉투에 싸서 파일로 남긴다 —
   * 스테이지 산출물은 그 안의 `result`(또는 `data`)다. 한 겹만 벗긴다: 더 깊이 파면 "파싱은 되는"
   * 중첩 객체가 다시 후보로 밀려들어와 KTB-7이 고친 오진이 돌아온다. 봉투의 표식(`summary`·
   * `agentCount`·`logs`)이 하나라도 있을 때만 벗긴다 — 산출물 자신에게도 `summary`가 있으므로
   * "result 키가 있으면 무조건"으로 두면 멀쩡한 산출물을 엉뚱하게 벗길 수 있다.
   */
  const push = (source, obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    candidates.push({ source, obj });
    const enveloped = "summary" in obj || "agentCount" in obj || "logs" in obj;
    if (!enveloped) return;
    for (const key of ["result", "data"]) {
      const inner = obj[key];
      if (inner && typeof inner === "object" && !Array.isArray(inner)) candidates.push({ source: `${source} (.${key})`, obj: inner });
    }
  };
  /** 텍스트 하나에서 나오는 후보 전부: ```json 펜스 → 맨 위 JSON(또는 균형 스캔). */
  const pushFrom = (source, text, { scanAll = false } = {}) => {
    const fromFence = fencedObject(text);
    if (fromFence) push(`${source} (fenced)`, fromFence);
    if (scanAll) { for (const obj of balancedObjects(text)) push(source, obj); return; }
    // 큰 텍스트(파일 내용·읽기 조각)는 **선두의 객체 하나만** 본다. 전체 균형 스캔은 100 KB짜리
    // tool_result마다 O(n·중괄호수)라 스테이지 검증이 눈에 띄게 느려지고, 산출물 파일은 언제나
    // `{`로 시작한다 — 그 안쪽 중첩 객체는 애초에 후보가 아니다.
    push(source, leadingObject(text));
  };

  // (1) 백그라운드 워크플로의 실제 반환값이 도착하는 자리(KTB-17). completed만 본다 —
  // failed/cancelled 알림의 `<result>`는 산출물이 아니다. 마지막 것이 이 스테이지의 결과다.
  const notes = taskNotificationsFromTranscript(transcriptText).filter((n) => n.status === "completed");
  for (let i = notes.length - 1; i >= 0; i--) pushFrom(`transcript task-notification #${i + 1}`, notes[i].result);
  if (notes.length === 0) tried.push("transcript: no completed <task-notification> block");

  // (2) 디스패처가 알림의 output-file을 읽은 내용. 조각으로 오므로 파일별로 다시 붙인다.
  for (const [path, text] of fileReadsFromTranscript(transcriptText)) {
    pushFrom(`transcript file read ${path.split("/").pop()}`, text);
  }
  // 그리고 개별 tool_result 하나하나 — 파일 경로를 못 얻은 읽기(Bash `cat` 등)도 여기서 잡힌다.
  const results = toolResultTextsFromTranscript(transcriptText);
  for (let i = results.length - 1; i >= 0; i--) {
    if (isWorkflowReceipt(results[i])) continue;
    pushFrom(`transcript tool result #${i + 1}`, stripLineNumbers(results[i]));
  }

  // (3) `Workflow` tool_result — 접수증이 아닐 때만(전경에서 도는 워크플로는 여기로 반환값을 준다).
  const wf = workflowResultsFromTranscript(transcriptText);
  const real = wf.map((t, i) => ({ t, i })).filter(({ t }) => !isWorkflowReceipt(t));
  for (let k = real.length - 1; k >= 0; k--) pushFrom(`transcript Workflow result #${real[k].i + 1}`, real[k].t, { scanAll: true });
  if (wf.length === 0) tried.push("transcript: no Workflow tool result found (transcript missing or shape changed)");
  else if (real.length === 0) tried.push(`transcript: the Workflow tool result is a background receipt, not a return value (${wf.length} call(s))`);

  const fenceErr = fencedJsonError(envelopeResult);
  if (fenceErr) tried.push(`result \`\`\`json fence is not valid JSON: ${fenceErr}`);
  const fenced = fencedObject(envelopeResult);
  if (fenced) push("result ```json fence", fenced);
  for (const obj of balancedObjects(envelopeResult)) push("result bare JSON", obj);

  const seen = new Set();
  for (const c of candidates) {
    const key = `${c.source}::${JSON.stringify(c.obj).slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const v = check(c.obj);
    if (v.ok) return { ok: true, data: c.obj, source: c.source, tried };
    // 한 텍스트 안의 중첩 객체는 후보가 수십 개씩 나오고 대부분 같은 이유로 떨어진다 —
    // 같은 문장을 그대로 반복하면 전이 사유가 사람이 읽을 수 없는 길이가 된다. 중복은 접는다.
    const line = `${c.source}: ${v.errors.join("; ")}`;
    if (!tried.includes(line) && tried.length < 6) tried.push(line);
  }
  if (candidates.length === 0) tried.push("no JSON object in result");
  return { ok: false, data: null, reason: `no candidate matched the stage schema — ${tried.join(" | ")}`, tried };
}
