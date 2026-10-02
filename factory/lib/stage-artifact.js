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
 *   1b. (#170, `readFile`를 받았을 때만) 이 세션의 `Workflow` **접수증의 Task ID**에 묶인 러너 알림의
 *      `<output-file>` — 워크플로 러너가 쓴 원본 결과 파일을 **잘리지 않은 채로** 읽는다.
 *      그 파일은 /tmp에 있어 에이전트도 쓸 수 있으므로, 커널의 ctime이 알림 줄 시각보다 늦지 않고 결과가
 *      알림의 인라인 사본으로 시작할 때만 후보가 된다(rework sec1, `runnerBindingFailure`).
 *   2. `Read` tool_result를 파일별로 재조립한 내용 → 그리고 개별 tool_result 하나하나
 *      (둘 다 `^\s*\d+\t` 줄 번호 접두를 벗기고, `{summary,agentCount,logs,result}` 봉투면 한 겹 벗긴다).
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
  return workflowCallsFromTranscript(text).map((c) => c.text);
}

/** `workflowResultsFromTranscript`와 같은 훑기 — 각 결과를 낳은 `Workflow` tool_use id와 함께(#170 접수증 묶기). */
function workflowCallsFromTranscript(text) {
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
  return ids.map((id) => ({ id, text: byId.get(id) })).filter((c) => typeof c.text === "string" && c.text.length > 0);
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

/**
 * `Read`가 붙이는 줄 번호 접두를 벗긴다. 접두가 없는 줄은 그대로 둔다.
 * 실제 `Read` 출력은 `cat -n`처럼 번호를 오른쪽 정렬해 공백으로 채운다(`"     1\t"`, `"    42\t"`) —
 * `^\d+\t`는 앞의 공백을 매치하지 못해 그런 줄을 통째로 못 벗기고 그대로 흘려보냈다.
 */
export const stripLineNumbers = (text) =>
  String(text ?? "").split("\n").map((l) => l.replace(/^\s*(\d+)\t/, "")).join("\n");

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
          const m = /^\s*(\d+)\t([\s\S]*)$/.exec(l);
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
 * #170 — 워크플로 러너의 원본 결과 파일을 읽을 때의 상한(바이트). 이보다 크면 후보로 올리지 않고 그 크기를
 * 사유에 적는다(운영자 요청 ~5 MB: 리뷰 판정 하나가 이보다 클 일은 없고, 넘는다면 그 파일이 이상한 것이다).
 */
export const WORKFLOW_OUTPUT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * #170 rework sec1(3차) — 결과 파일의 ctime이 러너 알림 줄의 시각보다 늦어도 되는 여유(ms). 알림의 시각은
 * 밀리초로 잘려 기록되고 파일시스템의 시계는 거칠다 — 그 반올림만큼만 둔다. 이보다 늦게 바뀐 파일은
 * 러너가 "다 썼다"고 알린 **뒤에** 누군가 다시 쓴 것이다.
 */
export const WORKFLOW_OUTPUT_CTIME_SLACK_MS = 1000;

/**
 * #170 rework sec1(3차) — 결과 파일이 **러너가 알린 그 바이트**인가. 경로는 /tmp에 있고 리뷰어는 /tmp에
 * 쓸 수 있으므로, 접수증·알림이 경로를 묶어도 내용까지 묶지는 못한다(sec1). 그래서 에이전트가 쓸 수 없는
 * 두 사실에 대 본다:
 *  ① 커널의 변경 시각 — 파일의 ctime ≤ 알림 줄의 timestamp(+여유). 알림 뒤의 쓰기·rename·link는 ctime을
 *     앞으로 밀고, 비특권 프로세스는 그것을 되돌리지 못한다(`touch -d`는 mtime만 바꾼다).
 *  ② 러너 자신의 사본 — 알림의 `<result>`(길면 앞부분 + "... (truncated …)")가 파일의 결과 직렬화의 앞부분과
 *     같아야 한다(잘리지 않았으면 전체가 같아야 한다). 결과가 나오기 전에 심어 둔 파일은 이것을 맞출 수 없다.
 * 둘 중 무엇이든 확인할 수 없으면(타임스탬프 없음, 변경 시각을 주지 못하는 리더) **쓰지 않는다** — 묶이지
 * 않은 파일이 판정이 되는 것보다 사람에게 가는 편이 싸다. 돌려주는 것은 사유(문자열) 또는 null(묶임).
 */
function runnerBindingFailure({ path, value, inline, at, ctimeMs }) {
  const unbound = (why) => `workflow output file not bound to the runner's notification (${why}): ${path}`;
  if (!Number.isFinite(at)) return unbound("no notification timestamp");
  if (!Number.isFinite(ctimeMs)) return unbound("the reader gave no change time");
  if (ctimeMs > at + WORKFLOW_OUTPUT_CTIME_SLACK_MS) {
    return `workflow output file changed after the runner's notification: ${path} (changed ${new Date(ctimeMs).toISOString()}, notified ${new Date(at).toISOString()})`;
  }
  if (typeof inline !== "string") return unbound("the notification carries no <result>");
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const cut = /\n?\.\.\. \(truncated\b[^)]*\)\s*$/.exec(inline);
  const runnerCopy = cut ? inline.slice(0, cut.index) : inline.trim();
  const same = cut ? runnerCopy.length > 0 && serialized.startsWith(runnerCopy) : serialized === runnerCopy;
  if (!same) return `workflow output file does not match the runner's notification: ${path} (its result does not ${cut ? "begin with" : "equal"} the ${runnerCopy.length} chars the runner inlined)`;
  return null;
}

/**
 * #170 — 이 세션이 띄운 백그라운드 `Workflow`의 Task ID들(접수증 순서)과, 그 Task ID에 묶인 러너 알림이
 * 적은 `<output-file>` 경로들(최신 먼저, 중복 제거).
 *
 * **신뢰의 닻은 접수증이다.** 접수증은 `Workflow` tool_use에 대한 tool_result이고, 알림은 사용자 턴의
 * 텍스트 블록으로 러너가 넣는다 — 그래서 알림은 **`type: "user"` 줄에서만** 읽는다(assistant 텍스트에 적힌
 * 알림은 모델이 쓴 것이다; tool_result 블록 안의 알림 모양 텍스트는 파일 내용이다 — 둘 다 버린다). 그래서
 * ① 접수증에 없는 task id의 알림(백그라운드 Bash 등 다른 작업)은 버리고, ② `Read` file_path나 Bash 명령에만
 * 등장하는 경로는 **아예 보지 않는다**(에이전트가 쓴 파일이 판정이 되면 안 된다), ③ scratchpad 디렉터리를
 * 훑거나 그 배치를 짐작하지 않는다 — 경로는 러너가 적어 준 그대로다. rework(cf1·sec1): ④ 알림의 **머리**만
 * 읽는다(`runnerNotificationHeader`) — `<result>` 안의 태그는 반환값의 바이트다, ⑤ `<tool-use-id>`가 있으면
 * 그 task id의 접수증을 낳은 `Workflow` 호출이어야 한다, ⑥ completed가 아닌 알림의 파일은 열지 않고
 * `rejected`로 돌려 사유에 남긴다.
 */
export function workflowOutputFilesFromTranscript(text) {
  const taskIds = [];
  /** task id → 그 접수증을 낳은 `Workflow` tool_use id들. 알림의 `<tool-use-id>`는 이 중 하나여야 한다. */
  const callsOf = new Map();
  for (const { id, text: r } of workflowCallsFromTranscript(text)) {
    if (!isWorkflowReceipt(r)) continue;
    const m = /Task ID:\s*([A-Za-z0-9_-]+)/.exec(r);
    if (!m) continue;
    if (!taskIds.includes(m[1])) taskIds.push(m[1]);
    if (!callsOf.has(m[1])) callsOf.set(m[1], new Set());
    callsOf.get(m[1]).add(id);
  }
  const files = [];
  /** 접수증에 묶인 알림이지만 completed가 아닌 것 — 파일을 열지 않고 사유에 이름만 남긴다(rework cf1). */
  const rejected = [];
  if (!taskIds.length || typeof text !== "string") return { taskIds, files, rejected };
  for (const line of text.split("\n")) {
    if (!line.trim() || !line.includes("task-notification")) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    // 러너의 알림은 **사용자 턴**으로 온다. assistant 줄의 텍스트는 모델이 쓴 것이다 — 모델이 알림을 흉내 내
    // `<output-file>`을 자기가 쓴 파일로 돌리면 그 파일이 판정이 된다(자기비판 #170). 작성자로 거른다.
    if (o?.type !== "user" || (o?.message?.role != null && o.message.role !== "user")) continue;
    const c = o?.message?.content;
    const texts = typeof c === "string" ? [c]
      : Array.isArray(c) ? c.filter((b) => b?.type === "text" || typeof b === "string").map((b) => (typeof b === "string" ? b : b.text ?? ""))
        : [];
    for (const t of texts) {
      const h = runnerNotificationHeader(t);
      if (!h || !h.taskId || !h.path || !taskIds.includes(h.taskId)) continue;
      // `<tool-use-id>`를 적은 알림은 그 task id의 접수증을 낳은 `Workflow` 호출의 것이어야 한다.
      if (h.toolUseId && !callsOf.get(h.taskId).has(h.toolUseId)) continue;
      // completed만 — (1)이 `<result>`에 적용하는 규칙 그대로다. 같은 러너 바이트가 인라인으로 오면 거절되고
      // 디스크에서 읽으면 받아들여지는 비대칭을 두지 않는다(rework cf1).
      if (h.status !== "completed") { rejected.push({ taskId: h.taskId, path: h.path, status: h.status || "(none)" }); continue; }
      // rework sec1(3차) — 그 파일이 **아직 러너의 바이트인지** 대 볼 두 사실도 같이 든다: 이 알림 줄을 기록한
      // 시각(트랜스크립트 줄의 `timestamp`)과 러너가 인라인으로 실은 결과(`<result>`, 길면 앞부분만).
      files.push({ taskId: h.taskId, path: h.path, inline: h.result, at: Date.parse(o?.timestamp ?? "") });
    }
  }
  const seen = new Set();
  const newestFirst = files.reverse().filter((f) => (seen.has(f.path) ? false : seen.add(f.path)));
  return { taskIds, files: newestFirst, rejected };
}

/**
 * #170 rework sec1 — 러너 알림의 **머리**(`<result>` 앞의 필드들)만 읽는다. `<result>`는 Workflow의 반환값이고
 * 그 안에는 리뷰어가 쓴 문자열이 그대로 실린다: 리뷰어가 `</task-notification>`으로 블록을 일찍 닫고 가짜
 * 블록을 열면, 블록 전체를 정규식으로 훑는 파서는 그 가짜 블록의 `<output-file>`을 러너의 말로 읽는다.
 * 그래서 ① 텍스트 블록은 알림으로 **시작**해야 하고(러너가 넣는 사용자 턴의 모양), ② 그 블록 하나의 머리만
 * 본다 — `<result>`(없으면 닫는 태그) 이후는 어떤 태그가 있어도 러너가 아니라 반환값의 바이트다.
 */
function runnerNotificationHeader(text) {
  const m = /^\s*<task-notification>/.exec(String(text ?? ""));
  if (!m) return null;
  const rest = String(text).slice(m[0].length);
  const cut = [rest.indexOf("<result>"), rest.indexOf("</task-notification>")].filter((i) => i >= 0);
  const head = cut.length ? rest.slice(0, Math.min(...cut)) : rest;
  const field = (tag) => (new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(head)?.[1] || "").trim();
  // `<result>`의 내용 — 머리 바로 뒤의 `<result>`부터 블록의 **마지막** `</result>`까지(반환값 안의 문자열이
  // `</result>`를 품어도 러너가 닫는 것은 마지막 것이다). 이 값은 후보가 아니라 결과 파일을 대 보는 기준이다.
  const open = rest.indexOf("<result>");
  const close = rest.lastIndexOf("</result>");
  const result = open >= 0 && open === Math.min(...cut) && close > open ? rest.slice(open + "<result>".length, close) : null;
  return { taskId: field("task-id"), toolUseId: field("tool-use-id"), path: field("output-file"), status: field("status"), result };
}

/**
 * #170 — 러너 결과 파일의 텍스트 → 레코드 하나. DECISIONS KTB-17이 본 모양은 pretty-print된 **봉투 하나**
 * (`{summary, agentCount, logs, result}`, 525줄)이고, 이슈가 적은 모양은 JSONL이다 — 둘 다 받는다:
 * 전체가 JSON 하나면 그것, 아니면 **마지막으로 파싱되는 줄**(첫 레코드가 아니다: JSONL의 첫 레코드는
 * 진행 기록이거나 이전 판정이다). 둘 다 아니면 null.
 */
function lastRecordOf(text) {
  try {
    const whole = JSON.parse(text);
    if (whole && typeof whole === "object" && !Array.isArray(whole)) return whole;
  } catch { /* JSONL로 */ }
  const lines = String(text).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith("{")) continue;
    try {
      const o = JSON.parse(l);
      if (o && typeof o === "object" && !Array.isArray(o)) return o;
    } catch { /* 앞 줄로 */ }
  }
  return null;
}

/**
 * #170 — `paths` 중 하나를 `file_path`로 받은 tool_use(`Read`)의 tool_result 텍스트들. 접수증에 묶인 러너
 * 파일의 쪽 읽기를 알아보는 데만 쓴다 — 경로를 **후보로 만드는** 데는 쓰지 않는다(그것은 접수증·알림뿐이다).
 */
function readResultsOfPaths(text, paths) {
  const out = new Set();
  if (!paths.size || typeof text !== "string") return out;
  const ids = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use" && b?.id && paths.has(b?.input?.file_path)) ids.add(b.id);
      if (b?.type === "tool_result" && ids.has(b?.tool_use_id)) { const s = toolResultText(b.content); if (s) out.add(s); }
    }
  }
  return out;
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
export function extractStageArtifact({ envelopeResult, transcriptText, validate, readFile } = {}) {
  const check = validate || (() => ({ ok: true, errors: [] }));
  const tried = [];
  const candidates = [];
  /*
   * #170 — 러너 결과 파일은 **호출자가 `readFile`을 넘기고**(옵트인) 트랜스크립트에 이 세션의 `Workflow`
   * 접수증이 있을 때만 본다. 둘 중 하나라도 없으면 아래의 새 줄(잘린 후보·결과 파일)은 하나도 생기지 않아
   * 사유가 #170 이전과 바이트 단위로 같다(retro.js·implementHeadShaOf는 넘기지 않는다).
   */
  const wfFiles = typeof readFile === "function" ? workflowOutputFilesFromTranscript(transcriptText) : { taskIds: [], files: [], rejected: [] };
  const optIn = wfFiles.taskIds.length > 0;
  /** 선두가 `{`인데 그 짝이 없는 텍스트 — `head -c`나 알림의 잘림이 만든 조각. 스키마 오류로 오진하지 않고 이름으로 부른다. */
  const truncated = [];
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
    const lead = leadingObject(text);
    push(source, lead);
    if (!lead && !fromFence && optIn && typeof text === "string") {
      const start = text.indexOf("{");
      if (start >= 0 && matchBrace(text, start) < 0) truncated.push(`${source} (${text.length} chars)`);
    }
  };

  // (1) 백그라운드 워크플로의 실제 반환값이 도착하는 자리(KTB-17). completed만 본다 —
  // failed/cancelled 알림의 `<result>`는 산출물이 아니다. 마지막 것이 이 스테이지의 결과다.
  const notes = taskNotificationsFromTranscript(transcriptText).filter((n) => n.status === "completed");
  for (let i = notes.length - 1; i >= 0; i--) pushFrom(`transcript task-notification #${i + 1}`, notes[i].result);
  if (notes.length === 0) tried.push("transcript: no completed <task-notification> block");

  // (1b) #170 — 접수증의 Task ID에 묶인 러너 결과 파일, **잘리지 않은 원본**. 알림의 `<result>`는 길면
  // 잘리고(KTB-17), 디스패처가 그 파일을 `head -c`로 읽은 조각도 잘려 있다 — 판정이 이미 있는데 사람에게
  // 가던 자리(own-calendar #124). 실패는 전부 경로를 부르는 한 줄로 남긴다: 파일이 사라졌는지(scratchpad의
  // 수명은 미검증이다), 크기를 넘었는지, JSON이 아닌지, 스키마에 어긋났는지가 서로 다른 문장이다.
  for (const { taskId, path, status } of wfFiles.rejected) tried.push(`workflow output file not used: task ${taskId} status ${status} (${path})`);
  if (optIn && wfFiles.files.length === 0) tried.push(`workflow output file: no runner notification names the output file of task ${wfFiles.taskIds.join(", ")}`);
  for (const { path, inline, at } of wfFiles.files) {
    let text = null;
    // 두 번째 인자는 **읽기 전에** 크기를 보라는 요청이다: 그것을 지키는 리더(run-stage의 `readFileOrNull`)는
    // 상한을 넘는 파일을 읽지 않고 `{ bytes }`만 돌려준다 — 상한이 판정만이 아니라 메모리 비용도 묶는다.
    // 지키지 않는 리더가 문자열을 주면 아래에서 같은 상한으로 다시 잰다.
    // `meta: true` — 내용과 함께 커널의 변경 시각을 달라는 요청(rework sec1). 그것을 주지 못하는 리더(문자열만
    // 돌려주는 것)의 파일은 아래 묶기에서 거절된다: 판정은 에이전트가 쓸 수 없는 사실에만 앵커한다.
    let ctimeMs;
    try { text = readFile(path, { maxBytes: WORKFLOW_OUTPUT_MAX_BYTES, meta: true }); } catch { text = null; }
    if (text && typeof text === "object" && text.notRegular === true) { tried.push(`workflow output file is not a regular file: ${path} (a symlink or special file is not the runner's file)`); continue; }
    if (text && typeof text === "object" && typeof text.text !== "string" && Number.isFinite(text.bytes)) { tried.push(`workflow output file too large: ${path} (${text.bytes} bytes > ${WORKFLOW_OUTPUT_MAX_BYTES})`); continue; }
    if (text && typeof text === "object" && typeof text.text === "string") { ctimeMs = text.ctimeMs; text = text.text; }
    if (typeof text !== "string") { tried.push(`workflow output file missing: ${path}`); continue; }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > WORKFLOW_OUTPUT_MAX_BYTES) { tried.push(`workflow output file too large: ${path} (${bytes} bytes > ${WORKFLOW_OUTPUT_MAX_BYTES})`); continue; }
    const record = lastRecordOf(text);
    if (!record) { tried.push(`workflow output file is not valid JSON: ${path} (${bytes} bytes)`); continue; }
    const source = `workflow output file ${path}`;
    const before = candidates.length;
    // `.result`는 **기존 봉투 규칙 그대로** 한 겹만 벗긴다(표식 `summary`·`agentCount`·`logs`가 있을 때만).
    push(source, record);
    const mine = candidates.slice(before);
    const passing = mine.filter((c) => check(c.obj).ok);
    if (!passing.length) {
      const best = mine[mine.length - 1];
      tried.push(`${best.source}: ${check(best.obj).errors.join("; ")}`);
      continue;
    }
    // 스키마를 통과한 후보만 러너의 알림에 대 본다(통과하지 못한 파일은 위 스키마 사유가 더 정확하다).
    // 묶이지 않으면 이 파일의 후보를 **전부** 거둬들인다 — 아래 후보 루프가 그것을 고르지 못하도록.
    const failure = runnerBindingFailure({ path, value: passing[0].obj, inline, at, ctimeMs });
    if (failure) { candidates.length = before; tried.push(failure); }
  }

  // (2) 디스패처가 알림의 output-file을 읽은 내용. 조각으로 오므로 파일별로 다시 붙인다.
  // `fileReadsFromTranscript`가 주는 Map은 **경로가 처음 등장한 순서**다 — 그대로 훑으면 세션 초반에
  // 읽은(그래서 나중에 다시 쓰였을 수 있는) 파일이 나중에 읽은 파일보다 먼저 후보가 되고, 둘 다
  // 스키마를 통과하면 오래된 쪽이 이긴다(위 (1)·아래 개별 tool_result·Workflow 결과는 전부 **최신이
  // 먼저**다 — 여기만 거꾸로였다, KTB-15b I3). `.reverse()`로 나머지 후보들과 같은 방향으로 맞춘다.
  /*
   * #170 — 접수증에 묶인 러너 파일을 **쪽으로** 읽은 조각(`Read` offset/limit). 첫 쪽이 빠진 재조립이나
   * 가운데 쪽 하나는 선두에 **중첩 객체**(판정 한 항목)가 오므로, 그대로 채점하면 "round is required;
   * verdicts is required"가 된다 — #124가 사람에게 간 바로 그 문장이다. 그 파일은 (1b)에서 이미 통째로
   * 읽었으니, 문서로 읽히지 않는 조각은 후보가 아니라 잘린 조각으로 부른다. 옵트인일 때만이다(dw5).
   */
  const wfPaths = new Set(wfFiles.files.map((f) => f.path));
  const isFragment = (text) => lastRecordOf(stripLineNumbers(text)) === null;
  for (const [path, text] of [...fileReadsFromTranscript(transcriptText)].reverse()) {
    const source = `transcript file read ${path.split("/").pop()}`;
    if (optIn && wfPaths.has(path) && isFragment(text)) { truncated.push(`${source} (${text.length} chars)`); continue; }
    pushFrom(source, text);
  }
  // 그리고 개별 tool_result 하나하나 — 파일 경로를 못 얻은 읽기(Bash `cat` 등)도 여기서 잡힌다.
  const pages = optIn ? readResultsOfPaths(transcriptText, wfPaths) : new Set();
  const results = toolResultTextsFromTranscript(transcriptText);
  for (let i = results.length - 1; i >= 0; i--) {
    if (isWorkflowReceipt(results[i])) continue;
    const source = `transcript tool result #${i + 1}`;
    const text = stripLineNumbers(results[i]);
    if (pages.has(results[i]) && isFragment(text)) { truncated.push(`${source} (${text.length} chars)`); continue; }
    pushFrom(source, text);
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

  // 잘린 조각들은 한 줄로 — 그리고 후보 루프 **앞에서** 넣는다: 루프의 줄은 6줄 상한에 걸리지만 이 줄은
  // 걸리지 않아야 "잘렸다"와 "없다"를 사람이 가를 수 있다(#170 dw3).
  if (truncated.length) tried.push(`truncated JSON candidate (cut off, not missing fields): ${truncated.slice(0, 8).join(", ")}${truncated.length > 8 ? `, … ${truncated.length - 8} more` : ""}`);

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
