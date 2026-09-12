// 역할 파일(.claude/agents/*.md)의 `## Examples`(### 좋은 발견/### 나쁜 발견) · `## Perspectives`에
// 항목을 다크 append(§8.1). `parseAgentMd`로 섹션 존재를 확인("locate")하되, 실제 삽입은 순수 줄
// splicing으로 한다 — 다른 바이트는 절대 바꾸지 않는다(헤더 신설 금지, 기존 항목 수정·삭제 금지).

import { parseAgentMd } from "../agent-md.js";

// agent-md.js의 DECORATORS와 동일한 규칙: 헤더는 `<marker> <name>` 그 자체이거나, 이름 바로 뒤가
// ` —`(설명 대시) · `:` · ` (`(괄호 주석) 중 하나여야 매칭한다 — 스펙 §7.3의 실제 예시가
// "### 나쁜 발견 (이렇게 쓰지 않는다)"처럼 장식된 헤더를 쓴다.
const DECORATORS = [" —", ":", " ("];
function headerMatches(line, marker, name) {
  const prefix = `${marker} ${name}`;
  if (line === prefix) return true;
  if (!line.startsWith(prefix)) return false;
  return DECORATORS.some((d) => line.slice(prefix.length).startsWith(d));
}

/** `## <name>`(장식 허용) 줄의 인덱스와 그 섹션의 끝(다음 `## ` 헤더 또는 EOF)을 찾는다. */
function findTop(lines, name) {
  const start = lines.findIndex((l) => headerMatches(l, "##", name));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  return { headerIdx: start, start, end };
}

/** topRange 안에서 `### <name>`(장식 허용) 소제목의 범위(다음 `### `/`## ` 또는 topRange.end까지)를 찾는다. */
function findSub(lines, topRange, name) {
  if (!topRange) return null;
  let start = -1;
  for (let i = topRange.start + 1; i < topRange.end; i++) if (headerMatches(lines[i], "###", name)) { start = i; break; }
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
 * 대상 섹션이 텍스트에 정확히 그 헤더(`## Examples`/`### 좋은 발견`/`### 나쁜 발견`/`## Perspectives`,
 * 데코레이터 없이)로 존재하지 않으면 헤더를 만들지 않고 reason 'missing-section'으로 skip한다.
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
