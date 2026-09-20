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
 * 본문 **첫 줄**의 기계 마커. `fp`가 Task 3의 dedupe 키다: 같은 fingerprint를 가진 열린 이슈가 있으면
 * 새 이슈를 열지 않고 그 이슈의 `## Evidence`에 덧붙인다. `tags`·`from`은 사람이 이슈 목록에서
 * "이게 하네스 얘기인가 KTB 얘기인가", "어느 저장소의 어느 이슈에서 왔나"를 본문을 열지 않고 알게 한다.
 *
 * 형식(한 글자도 바뀌면 안 된다):
 *   `<!-- factory-improvement fp=<fingerprint> tags=<a,b> from=<owner/repo>#<n> -->`
 */
export const upstreamMarker = ({ fingerprint, tags = [], from }) =>
  `<!-- factory-improvement fp=${markerValue(fingerprint)} tags=${markerValue([].concat(tags).join(","))} from=${markerValue(from)} -->`;

export const UPSTREAM_MARKER_RE = /<!--\s*factory-improvement\s+fp=(\S+)\s+tags=(\S*)\s+from=(\S+?)\s*-->/;

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
  const head = [path, why.replace(/#\d+/g, "#N")].filter(Boolean).join(" — ") || `unclassified finding ${markerValue(payload?.fingerprint) || "(no fingerprint)"}`;
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
 * 증거 한 항목. 머리 줄(`- **<ref>** — …`)이 **항목의 정체성**이다: `appendEvidence`가 같은 머리 줄이
 * 이미 있으면 덧붙이지 않는다(retro가 같은 머지를 두 번 돌아도 증거가 두 번 쌓이지 않는다).
 */
function evidenceEntry(payload = {}, ref) {
  const c = payload?.causal ?? {};
  const where = c.path ? `\`${oneLine(c.path)}${c.line ? `:${c.line}` : ""}\`` : "";
  const when = [payload.stage, payload.round == null ? "" : `round ${payload.round}`].filter(Boolean).join(" / ");
  const head = `- **${ref}**${[when, where].filter(Boolean).length ? ` — ${[when, where].filter(Boolean).join(" · ")}` : ""}`;
  const lines = [head];
  const reason = oneLine(payload.reason);
  if (reason) lines.push(`  ${reason}`);
  if (c.command) lines.push(`  명령: \`${oneLine(c.command)}\``);
  if (c.snippet) lines.push(snippetBlock(c.snippet));
  return lines.join("\n");
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
    oneLine(payload.reason) || "(소견에 reason이 없다 — 아래 증거와 payload가 전부다.)",
    "",
    ...facts,
    "",
    EVIDENCE_HEADING,
    "",
    evidenceEntry(payload, from),
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

/** 본문에서 `## Payload`의 첫 JSON 펜스를 읽는다. 없거나 깨졌으면 null — 파싱 자체는 실패하지 않는다. */
function parsePayloadBlock(body) {
  const lines = String(body).split("\n");
  const open = lines.findIndex((l) => l.trim() === "```json");
  if (open === -1) return null;
  const close = lines.findIndex((l, i) => i > open && l.trim() === "```");
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
  const start = lines.findIndex((l) => l.trim() === EVIDENCE_HEADING);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
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
 * 같은 머리 줄이 이미 있으면 본문을 **그대로** 돌려준다 — retro가 같은 머지를 두 번 돌아도, 같은
 * 런이 재시도돼도 증거가 두 번 쌓이지 않는다(멱등).
 * `## Evidence` 절이 없는 본문(사람이 이슈 템플릿으로 연 이슈)에는 절을 만들어 붙인다.
 */
export function appendEvidence(existingBody, payload = {}, ref) {
  const body = String(existingBody ?? "");
  const entry = evidenceEntry(payload, markerValue(ref) || sourceRef(payload?.repo, payload?.issue));
  const head = entry.split("\n")[0];
  const lines = body.split("\n");
  const range = evidenceRange(lines);

  if (range) {
    if (lines.slice(range[0] + 1, range[1]).some((l) => l === head)) return body;
    const before = lines.slice(0, range[1]);
    while (before.length > range[0] + 1 && before[before.length - 1].trim() === "") before.pop();
    return [...before, "", entry, "", ...lines.slice(range[1])].join("\n");
  }

  const payloadAt = lines.findIndex((l) => l.trim() === PAYLOAD_HEADING);
  const section = [EVIDENCE_HEADING, "", entry, ""];
  if (payloadAt === -1) {
    const tail = [...lines];
    while (tail.length && tail[tail.length - 1].trim() === "") tail.pop();
    return [...tail, "", ...section].join("\n");
  }
  const before = lines.slice(0, payloadAt);
  while (before.length && before[before.length - 1].trim() === "") before.pop();
  return [...before, "", ...section, ...lines.slice(payloadAt)].join("\n");
}
