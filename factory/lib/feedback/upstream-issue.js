import { IMPROVEMENT_LABEL } from "../label-catalog.js";

/**
 * 피드백 루프가 **upstream 저장소(know-thy-build 자신)에** 여는 개선 이슈의 본문 계약(스펙 §2·§6·§7).
 *
 * 이 모듈은 순수 함수만 둔다(fs도 gh도 만지지 않는다) — `harness-request.js`와 같은 이유다. 이슈를
 * **쓰는 쪽**(retro의 라우팅 팔)과 **읽는 쪽**(같은 fingerprint의 기존 이슈에 증거를 덧붙이는 dedupe,
 * 그리고 `factory analyze`)이 서로 다른 스테이지·서로 다른 저장소에서 도는데, 문법이 한 글자라도
 * 갈라지면 같은 원인으로 이슈가 무한히 쌓인다. 그래서 렌더·파싱·덧붙이기가 한 파일에 있고,
 * 왕복(render → parse)은 테스트가 박아 둔 계약이다.
 *
 * 본문의 모양은 **세 겹**이고 순서가 계약이다:
 *   ① 첫 줄의 기계 마커 — `fp`가 dedupe 키다(제목도 라벨도 아니다: 사람이 고쳐도 되는 줄이기 때문).
 *   ② 사람이 읽는 절 — 무엇이 일어났나 / 원인 파일:줄 + owner / 스테이지·라운드 / KTB 버전 / 출처.
 *   ③ `## Evidence` 목록 + `## Payload`의 JSON 블록 — 기계가 쓴 전체 payload(스펙 §6).
 * 사람이 먼저 읽을 것이 위에, 기계가 쓴 덩어리가 아래에 온다. 스펙 §7의 "사람이 읽는 것은 구조화된
 * 기록에서 **파생**된 것이지 원본 덤프가 아니다"가 이 순서다.
 *
 * 라벨은 언제나 `factory-improvement` + `backlog`다(스펙 §10 Q4) — 루프는 이슈를 열 뿐, 팩토리가
 * 자기 자신에 대해 무엇을 먼저 고칠지는 사람이 고른다.
 */

/** 새 upstream 이슈에 붙는 라벨. 순서까지 계약이다(첫 번째가 분류, 두 번째가 착지 상태). */
export const UPSTREAM_LABELS = [IMPROVEMENT_LABEL, "backlog"];

export const EVIDENCE_HEADING = "## Evidence";
export const PAYLOAD_HEADING = "## Payload";

/** 제목 한 줄의 상한. 넘으면 자른다 — 목록에서 한 줄로 읽혀야 한다. */
const TITLE_MAX = 120;
/** 증거 스니펫의 상한(줄 수·글자 수). 이슈 본문은 증거이지 로그 보관소가 아니다. */
const SNIPPET_LINES = 40;
const SNIPPET_CHARS = 2000;

/**
 * 마커 한 줄에 실리는 값의 정규화. 공백을 **전부 지우고** `-->`를 무력화한다 — 이 줄은 반드시
 * 한 줄이어야 하고(줄바꿈이 섞이면 파싱이 첫 줄에서 끊긴다), 본문의 아무 값이 주석을 조기에 닫으면
 * 그 뒤가 통째로 사람 눈에 노출된다. 세 필드(fp·tags·from)는 모두 식별자라 공백을 잃어도 잃을 뜻이 없다.
 */
const markerValue = (v) => String(v ?? "").replace(/\s+/g, "").replace(/--+>/g, "->");

const oneLine = (v) => String(v ?? "").replace(/\s*\n\s*/g, " ").trim();
const clip = (v, n) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);

/**
 * 산문(=백틱으로도 펜스로도 감싸지 않고 본문에 그대로 놓이는 것)의 정규화. 현재 그런 필드는
 * `reason` 하나이고, 두 자리(사람이 읽는 문단과 증거 항목)에 나온다.
 *
 * **HTML 주석 구분자를 무력화한다.** `reason`에 `<!--`가 하나 섞이면 GitHub은 그 아래 전부 —
 * 원인 파일 목록도, `## Evidence`도, `## Payload`도 — 주석으로 먹어 치운다. 기계 파싱은 첫 줄
 * 마커만 보므로 **멀쩡히 성공하고**, 루프는 "이슈를 잘 열었다"고 보고하는데 정작 트리아지할
 * 사람은 잘린 이슈를 본다. 게이트 출력이나 마크다운 템플릿에 관한 소견이면 `<!--`는 충분히
 * 나올 수 있는 글자다(이 저장소의 이슈 템플릿 자체가 그렇다).
 */
const prose = (v) => oneLine(v).replace(/<!--+/g, "<!-").replace(/--+>/g, "->");

/**
 * 본문 **첫 줄**의 기계 마커. `fp`가 Task 3의 dedupe 키다: 같은 fingerprint를 가진 열린 이슈가 있으면
 * 새 이슈를 열지 않고 그 이슈의 `## Evidence`에 덧붙인다. `tags`·`from`은 사람이 이슈 목록에서
 * "이게 하네스 얘기인가 KTB 얘기인가", "어느 저장소의 어느 이슈에서 왔나"를 본문을 열지 않고 알게 한다.
 *
 * 형식(한 글자도 바뀌면 안 된다):
 *   `<!-- factory-improvement fp=<fingerprint> tags=<a,b> from=<owner/repo>#<n> -->`
 *
 * fingerprint가 없으면 **빈 칸이 아니라 `none`**을 쓴다(`NO_FINGERPRINT`). 빈 칸으로 두면 사람 눈에도
 * 기계 눈에도 "값이 있는데 못 읽는 줄"과 구별되지 않고, 무엇보다 dedupe가 영원히 어긋난다 —
 * 소견마다 새 이슈가 열리는 것이 ADR-027 ⑤가 막으려는 바로 그 실패다. `none`은 사람에게도
 * "이 소견은 fingerprint를 못 얻었다"고 말한다(얇은 소견도 버리지 않으므로 도달 가능한 상태다).
 */
export const NO_FINGERPRINT = "none";

export const upstreamMarker = ({ fingerprint, tags = [], from }) =>
  `<!-- factory-improvement fp=${markerValue(fingerprint) || NO_FINGERPRINT} tags=${markerValue([].concat(tags).join(","))} from=${markerValue(from)} -->`;

/**
 * `fp`도 `tags`처럼 `\S*`다 — 읽는 쪽은 쓰는 쪽보다 관대해야 한다. 사람이 `fp=`를 비운 채 템플릿으로
 * 연 이슈까지 읽어야 dedupe에 참여시킬 수 있고, 여기서 `null`로 떨어뜨리면 그 이슈는 영영 보이지 않는다.
 */
export const UPSTREAM_MARKER_RE = /<!--\s*factory-improvement\s+fp=(\S*)\s+tags=(\S*)\s+from=(\S+?)\s*-->/;

/** `owner/repo#n` — 마커의 `from`이자 증거 항목의 머리. */
export const sourceRef = (repo, issue) => `${markerValue(repo)}#${markerValue(issue)}`;

/**
 * 사람이 읽는 제목. **원인만으로** 짓는다 — 이슈 번호는 `#N`으로 지워서, 같은 원인이 다른 이슈에서
 * 다시 나와도 제목이 같게 만든다(dedupe는 fp가 하지만, 제목까지 흔들리면 사람이 목록에서 같은 원인을
 * 두 개로 읽는다). 라운드·비용처럼 인스턴스마다 다른 값은 제목에 싣지 않는다.
 */
export function upstreamIssueTitle(payload = {}) {
  const path = oneLine(payload?.causal?.path);
  const why = oneLine(payload?.reason ?? payload?.causal?.test ?? payload?.causal?.command ?? "");
  const head = [path, why.replace(/#\d+/g, "#N")].filter(Boolean).join(" — ") || `unclassified finding ${markerValue(payload?.fingerprint) || NO_FINGERPRINT}`;
  return clip(`factory-improvement: ${head}`, TITLE_MAX);
}

/** 스니펫을 감쌀 펜스. 내용에 백틱이 있으면 그보다 한 칸 긴 펜스를 쓴다(증거가 본문을 깨지 않는다). */
function fenceFor(text) {
  const runs = String(text).match(/`+/g) ?? [];
  return "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
}

function snippetBlock(snippet, indent = "  ") {
  const text = clip(String(snippet).split("\n").slice(0, SNIPPET_LINES).join("\n"), SNIPPET_CHARS);
  const f = fenceFor(text);
  return [`${indent}${f}`, ...text.split("\n").map((l) => `${indent}${l}`), `${indent}${f}`].join("\n");
}

/**
 * 증거 한 항목과 그 **멱등 키**.
 *
 * 키는 `출처 + 스테이지 + 라운드`이지 머리 줄 전체가 아니다(리뷰 should_fix 5). 머리 줄에는 원인
 * 파일의 **줄 번호**가 실리는데, 그것은 같은 원인이라도 무관한 커밋 하나에 밀린다 — 키에 넣으면
 * "같은 목격"이 줄 번호 하나 때문에 두 항목이 된다. 곧 Task 3이 기대도 되는 것은 *같은 런을 다시
 * 돌려도 안 쌓인다*이지 *같은 원인이면 절대 안 쌓인다*가 아니다: 같은 이슈의 **다른 라운드**는
 * 새 목격이 맞다(그게 "몇 번이나 이랬나"라는 증거다).
 */
function evidenceEntry(payload = {}, ref) {
  const c = payload?.causal ?? {};
  const where = c.path ? `\`${oneLine(c.path)}${c.line ? `:${c.line}` : ""}\`` : "";
  const when = [payload.stage, payload.round == null ? "" : `round ${payload.round}`].filter(Boolean).join(" / ");
  const head = `- **${ref}**${[when, where].filter(Boolean).length ? ` — ${[when, where].filter(Boolean).join(" · ")}` : ""}`;
  const lines = [head];
  const reason = prose(payload.reason);
  if (reason) lines.push(`  ${reason}`);
  /**
   * `chain`은 **이 관측의 흔들리는 숫자들**이다(Task 4 r3 should_fix 1). 그 숫자는 `reason`에 있으면
   * 안 된다 — `reason`은 지문의 재료이고, 창마다 움직이는 값이 섞이면 **같은 원인이 주마다 새 상류
   * 이슈를 연다**. 그래서 원인은 `reason`에, 관측은 여기에 둔다. 지금까지 이 배열은 payload에 실리기만
   * 하고 증거 항목에는 한 줄도 나오지 않았다 — 덧붙이는 증거가 "언제·무엇이 얼마였나"를 말하지
   * 못하면 한 이슈에 여러 관측을 모으는 일 자체가 값을 잃는다.
   */
  for (const step of Array.isArray(payload.chain) ? payload.chain : []) {
    const t = oneLine(step);
    if (t) lines.push(`  - ${t}`);
  }
  if (c.command) lines.push(`  명령: \`${oneLine(c.command)}\``);
  if (c.snippet) lines.push(snippetBlock(c.snippet));
  return { text: lines.join("\n"), key: `${ref}|${when}` };
}

/** 이미 실린 머리 줄에서 같은 키를 되읽는다(`- **<ref>** — <when> · <where>` → `<ref>|<when>`). */
function headKey(line) {
  const m = /^- \*\*(.+?)\*\*(?:\s+—\s+(.*))?$/.exec(line);
  if (!m) return null;
  return `${m[1]}|${(m[2] ?? "").split(" · ")[0].trim()}`;
}

/**
 * 새 upstream 이슈 하나. `{ title, body, labels }` — 그대로 `gh issue create`에 실을 수 있는 모양이다.
 * `payload`가 비어도 골격은 낸다: 증거가 얇은 소견도 버리지 않는 것이 스펙 §2의 "ambiguous는 절대
 * 떨어뜨리지 않는다"와 같은 원칙이다.
 */
export function renderUpstreamIssue({ fingerprint, tags = [], payload = {}, sourceRepo, sourceIssue }) {
  const from = sourceRef(sourceRepo, sourceIssue);
  const c = payload?.causal ?? {};
  const facts = [
    c.path ? `- **원인 파일:** \`${oneLine(c.path)}${c.line ? `:${c.line}` : ""}\` (owner: \`${oneLine(c.owner) || "unknown"}\`)` : "- **원인 파일:** (확정 못 함 — 아래 payload의 후보를 볼 것)",
    payload.stage ? `- **스테이지/라운드:** ${oneLine(payload.stage)}${payload.round == null ? "" : ` / round ${payload.round}`}` : "",
    c.command ? `- **재현 명령:** \`${oneLine(c.command)}\`` : "",
    c.test ? `- **테스트:** \`${oneLine(c.test)}\`` : "",
    payload.ktb_version ? `- **KTB 버전:** \`${oneLine(payload.ktb_version)}\`` : "",
    `- **분류(tags):** ${[].concat(tags).join(", ") || "(없음)"}`,
    `- **최초 출처:** ${from}`,
    payload.cost ? `- **비용:** ${payload.cost.usd == null ? "?" : `$${payload.cost.usd}`} / ${payload.cost.tokens ?? "?"} tokens` : "",
  ].filter(Boolean);

  const body = [
    upstreamMarker({ fingerprint, tags, from }),
    "",
    "## 무엇이 일어났나",
    "",
    prose(payload.reason) || "(소견에 reason이 없다 — 아래 증거와 payload가 전부다.)",
    "",
    ...facts,
    "",
    EVIDENCE_HEADING,
    "",
    evidenceEntry(payload, from).text,
    "",
    PAYLOAD_HEADING,
    "",
    "<details><summary>full payload (기계가 쓴 것 — 스펙 §6)</summary>",
    "",
    "```json",
    JSON.stringify(payload ?? {}, null, 2),
    "```",
    "",
    "</details>",
    "",
  ].join("\n");

  return { title: upstreamIssueTitle({ ...payload, fingerprint: payload?.fingerprint ?? fingerprint }), body, labels: [...UPSTREAM_LABELS] };
}

/**
 * 절 제목·펜스는 **0열에서만** 읽는다(리뷰 must_fix 1 / should_fix 1). 이 모듈은 제 제목과 payload
 * 펜스를 언제나 0열에 쓰고, 증거 스니펫은 언제나 두 칸 들여쓴다 — 그래서 "들여쓴 줄은 내용이고
 * 0열의 줄만 구조다"가 이 본문의 규칙이다. `trim()`으로 비교하면 그 규칙이 무너져, 사람이 붙인 로그
 * 안의 줄이 절 제목 행세를 한다.
 */
const at0 = (re) => (l) => re.test(l);
const IS_EVIDENCE_HEADING = at0(/^##[ \t]+Evidence[ \t]*$/);
const IS_PAYLOAD_HEADING = at0(/^##[ \t]+Payload[ \t]*$/);
const IS_HEADING = at0(/^##[ \t]/);
const IS_JSON_FENCE = at0(/^```json[ \t]*$/);
const IS_FENCE = at0(/^```[ \t]*$/);

/**
 * **`## Payload` 절 아래의** 첫 JSON 펜스를 읽는다. 없거나 깨졌으면 null — 파싱 자체는 실패하지 않는다.
 *
 * 제목에 닻을 내리는 것이 핵심이다(리뷰 must_fix 1). 본문 처음부터 아무 ```json이나 주우면, JSON
 * 리포트를 찍는 게이트의 출력이 증거 스니펫으로 실리는 순간 **그 로그의 JSON이 기계 payload 행세를
 * 한다** — `parseUpstreamIssue`는 여전히 멀쩡한 객체를 돌려주므로 아무도 오류를 보지 못한 채 T3/T5가
 * 엉뚱한 것을 읽는다. 증거가 덧붙을수록 그 확률은 올라간다.
 */
function parsePayloadBlock(body) {
  const lines = String(body).split("\n");
  const at = lines.findIndex(IS_PAYLOAD_HEADING);
  if (at === -1) return null;
  const open = lines.findIndex((l, i) => i > at && IS_JSON_FENCE(l));
  if (open === -1) return null;
  const close = lines.findIndex((l, i) => i > open && IS_FENCE(l));
  if (close === -1) return null;
  try { return JSON.parse(lines.slice(open + 1, close).join("\n")); } catch { return null; }
}

/**
 * 마커가 주는 것(+ 있으면 payload)을 돌려준다. **관대하다**: JSON 블록이 없거나 깨졌어도 fingerprint·
 * tags·from은 그대로 나온다 — 사람이 템플릿으로 손수 연 이슈도 같은 dedupe에 참여해야 하기 때문이다.
 * 마커가 아예 없으면 `null`(팩토리가 아는 이슈가 아니다).
 */
export function parseUpstreamIssue(body) {
  const m = UPSTREAM_MARKER_RE.exec(String(body ?? ""));
  if (!m) return null;
  return {
    fingerprint: m[1],
    tags: m[2] ? m[2].split(",").filter(Boolean) : [],
    from: m[3],
    payload: parsePayloadBlock(body),
  };
}

/** `## Evidence` 절의 범위 `[start, end)` — start는 제목 줄. 절이 없으면 null. */
function evidenceRange(lines) {
  const start = lines.findIndex(IS_EVIDENCE_HEADING);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (IS_HEADING(lines[i])) { end = i; break; }
  return [start, end];
}

/** 증거 항목의 머리 줄 목록(사람이 센 것과 기계가 센 것이 같아야 한다). */
export function evidenceEntries(body) {
  const lines = String(body ?? "").split("\n");
  const range = evidenceRange(lines);
  if (!range) return [];
  return lines.slice(range[0] + 1, range[1]).filter((l) => /^- \*\*/.test(l));
}

/**
 * 같은 원인(=같은 fingerprint)이 다시 나왔을 때 **새 이슈를 열지 않고** 증거만 덧붙인다(스펙 §6).
 * 마커는 건드리지 않는다 — 첫 목격의 `from`이 그대로 남아야 "언제부터 이랬나"가 보인다. 첫 payload
 * 블록도 그대로 둔다(최초 증거는 나중 증거가 덮어쓸 것이 아니다).
 *
 * 같은 목격(=같은 `출처|스테이지/라운드`)이 이미 있으면 본문을 **그대로** 돌려준다 — retro가 같은
 * 머지를 두 번 돌아도, 같은 런이 재시도돼도 증거가 두 번 쌓이지 않는다(멱등). 원인 파일의 줄 번호는
 * 그 키에 들어가지 않는다(`evidenceEntry` 주석 참고).
 * `## Evidence` 절이 없는 본문(사람이 이슈 템플릿으로 연 이슈)에는 절을 만들어 붙인다.
 */
export function appendEvidence(existingBody, payload = {}, ref) {
  const body = String(existingBody ?? "");
  const entry = evidenceEntry(payload, markerValue(ref) || sourceRef(payload?.repo, payload?.issue));
  const lines = body.split("\n");
  const range = evidenceRange(lines);

  if (range) {
    if (lines.slice(range[0] + 1, range[1]).some((l) => headKey(l) === entry.key)) return body;
    const before = lines.slice(0, range[1]);
    while (before.length > range[0] + 1 && before[before.length - 1].trim() === "") before.pop();
    return [...before, "", entry.text, "", ...lines.slice(range[1])].join("\n");
  }

  const payloadAt = lines.findIndex(IS_PAYLOAD_HEADING);
  const section = [EVIDENCE_HEADING, "", entry.text, ""];
  if (payloadAt === -1) {
    const tail = [...lines];
    while (tail.length && tail[tail.length - 1].trim() === "") tail.pop();
    return [...tail, "", ...section].join("\n");
  }
  const before = lines.slice(0, payloadAt);
  while (before.length && before[before.length - 1].trim() === "") before.pop();
  return [...before, "", ...section, ...lines.slice(payloadAt)].join("\n");
}
