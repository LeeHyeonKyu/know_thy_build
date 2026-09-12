// 역할 파일(.claude/agents/*.md)의 `## Examples`(### 좋은 발견/### 나쁜 발견) · `## Perspectives`에
// 항목을 다크 append(§8.1). `parseAgentMd`로 섹션 존재를 확인("locate")하되, 실제 삽입은 순수 줄
// splicing으로 한다 — 다른 바이트는 절대 바꾸지 않는다(헤더 신설 금지, 기존 항목 수정·삭제 금지).

import { parseAgentMd } from "../agent-md.js";

// `##` 최상위 헤더(Examples/Perspectives)는 **정확히** 일치해야 한다 — integrity.js의
// `[protected].additive_only` 허용 목록(harness.toml)은 리터럴 문자열 "## Examples"/"## Perspectives"로
// 섹션 경계를 판정한다(sectionAt이 헤더 줄 텍스트를 그대로 비교한다). 장식된 최상위 헤더
// ("## Examples — 뭐")를 여기서 허용해 버리면, 우리는 위치를 찾아 삽입에 성공해도 그 결과 PR을
// integrity가 "허용되지 않은 섹션의 변경"으로 reject한다 — 통과할 수 없는 diff를 만드는 셈이다.
// `###` 소제목(좋은 발견/나쁜 발견)은 integrity가 보지 않는 하위 구분일 뿐이라 agent-md.js의
// DECORATORS와 같은 규칙(` —`·`:`·` (` 중 하나로 시작하는 접미)을 허용한다 — 스펙 §7.3의 실제
// 예시가 "### 나쁜 발견 (이렇게 쓰지 않는다)"처럼 장식된 헤더를 쓴다.
const DECORATORS = [" —", ":", " ("];
function subHeaderMatches(line, name) {
  const prefix = `### ${name}`;
  if (line === prefix) return true;
  if (!line.startsWith(prefix)) return false;
  return DECORATORS.some((d) => line.slice(prefix.length).startsWith(d));
}

/** `## <name>`(정확히 일치, 장식 없음) 줄의 인덱스와 그 섹션의 끝(다음 `## ` 헤더 또는 EOF)을 찾는다. */
function findTop(lines, name) {
  const header = `## ${name}`;
  const start = lines.findIndex((l) => l === header);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  return { headerIdx: start, start, end };
}

/** topRange 안에서 `### <name>`(장식 허용) 소제목의 범위(다음 `### `/`## ` 또는 topRange.end까지)를 찾는다. */
function findSub(lines, topRange, name) {
  if (!topRange) return null;
  let start = -1;
  for (let i = topRange.start + 1; i < topRange.end; i++) if (subHeaderMatches(lines[i], name)) { start = i; break; }
  if (start === -1) return null;
  let end = topRange.end;
  for (let i = start + 1; i < topRange.end; i++) if (/^### |^## /.test(lines[i])) { end = i; break; }
  return { headerIdx: start, start, end };
}

const bulletRe = /^- /;
function bulletsIn(lines, range) {
  const out = [];
  for (let i = range.start + 1; i < range.end; i++) if (bulletRe.test(lines[i])) out.push(lines[i].slice(2).trim());
  return out;
}
function lastBulletIdx(lines, range) {
  let idx = -1;
  for (let i = range.start + 1; i < range.end; i++) if (bulletRe.test(lines[i])) idx = i;
  return idx;
}

/**
 * applyRoleAdditions({ text, examples: [{kind:'good'|'bad', text}], perspectives: [{text}], caps })
 *   → { text, added: [{section, text}], skipped: [{text, reason}] }
 *
 * 대상 섹션이 텍스트에 그 헤더로 존재하지 않으면 헤더를 만들지 않고 reason 'missing-section'으로
 * skip한다. `## Examples`/`## Perspectives`는 **정확히** 일치해야 하고(integrity의 additive_only
 * 허용 목록이 리터럴 문자열이다), `### 좋은 발견`/`### 나쁜 발견`은 장식(` —`·`:`·` (`)을 허용한다
 * (integrity가 보지 않는 하위 구분이고, 스펙 §7.3 예시가 장식된 소제목을 쓴다).
 * kind가 good/bad가 아니면 'invalid-kind'로 skip. 중복 텍스트(trim 일치, 이번 배치 포함)는 'duplicate',
 * 상한(caps) 도달은 'max'로 skip. 삽입은 해당 섹션의 마지막 불릿 바로 다음 줄(없으면 헤더 바로 다음
 * 줄)에 `- <text>` 한 줄만 넣는다 — 그 외 어떤 줄도 건드리지 않는다.
 */
export function applyRoleAdditions({ text, examples = [], perspectives = [], caps = {} } = {}) {
  const capsFull = { good: 8, bad: 8, perspectives: 6, ...caps };
  const lines = (text ?? "").split("\n");

  // parseAgentMd로 섹션 존재를 확인한다("locate") — 실제 삽입 위치는 아래에서 줄 단위로 다시 찾는다.
  const { sections } = parseAgentMd(text ?? "");
  const hasTop = (name) => sections.has(name);

  const added = [];
  const skipped = [];

  function locate(kind) {
    if (kind === "perspectives") return hasTop("Perspectives") ? findTop(lines, "Perspectives") : null;
    if (!hasTop("Examples")) return null;
    const examplesRange = findTop(lines, "Examples");
    return findSub(lines, examplesRange, kind === "good" ? "좋은 발견" : "나쁜 발견");
  }

  function sectionLabel(kind) {
    if (kind === "perspectives") return "## Perspectives";
    return kind === "good" ? "### 좋은 발견" : "### 나쁜 발견";
  }

  function process(kind, rawText) {
    const norm = String(rawText ?? "").trim();
    if (kind !== "good" && kind !== "bad" && kind !== "perspectives") { skipped.push({ text: rawText, reason: "invalid-kind" }); return; }
    const range = locate(kind);
    if (!range) { skipped.push({ text: rawText, reason: "missing-section" }); return; }
    const bullets = bulletsIn(lines, range);
    if (bullets.includes(norm)) { skipped.push({ text: rawText, reason: "duplicate" }); return; }
    if (bullets.length >= capsFull[kind]) { skipped.push({ text: rawText, reason: "max" }); return; }
    const idx = lastBulletIdx(lines, range);
    const insertAt = idx === -1 ? range.start + 1 : idx + 1;
    lines.splice(insertAt, 0, `- ${norm}`);
    added.push({ section: sectionLabel(kind), text: norm });
  }

  for (const ex of examples) process(ex?.kind, ex?.text);
  for (const p of perspectives) process("perspectives", p?.text);

  return { text: lines.join("\n"), added, skipped };
}
