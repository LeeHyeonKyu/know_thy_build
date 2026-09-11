/** YAML 부분집합 파서: 스칼라(string/number/bool), 인라인 맵 {a: 1, b: [x, y]}, 인라인 배열 [a, b], 2칸 들여쓰기 1단계 중첩 맵. */
export function parseFrontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  if (!m) return { data: {}, body: md };
  return { data: parseBlock(m[1].split("\n")), body: md.slice(m[0].length) };
}

function parseBlock(lines) {
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const kv = /^([^\s:][^:]*):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`frontmatter: cannot parse line: ${line}`);
    const key = kv[1].trim(); const rest = stripComment(kv[2]).trim();   // `k:  # note` 는 값이 아니라 중첩 블록의 머리다
    if (rest === "") {
      // nested block: 들여쓰기된 줄을 모은 뒤 "공통 들여쓰기"만큼 벗긴다 — 2칸이든 4칸이든 받는다.
      const sub = [];
      i++;
      while (i < lines.length && /^\s{2,}\S/.test(lines[i])) { sub.push(lines[i]); i++; }
      const indent = sub.length ? Math.min(...sub.map((l) => /^\s*/.exec(l)[0].length)) : 0;
      data[key] = parseBlock(sub.map((l) => l.slice(indent)));
      continue;
    }
    data[key] = parseValue(rest);
    i++;
  }
  return data;
}

/** 따옴표 밖에 있는 ` #…` 꼬리 주석을 잘라낸다. `#`는 공백 뒤에 올 때만 주석이다(`a#b`는 값). */
export function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function parseValue(s) {
  s = stripComment(s).trim();
  if (s.startsWith("{")) return parseInlineMap(s);
  if (s.startsWith("[")) return parseInlineArray(s);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s.replace(/^["']|["']$/g, "");
}

/** 중괄호/대괄호 깊이를 고려해 최상위 콤마로 분할 */
function splitTop(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
function parseInlineMap(s) {
  const inner = s.slice(1, s.lastIndexOf("}")).trim();
  const obj = {};
  if (!inner) return obj;
  for (const part of splitTop(inner)) {
    const idx = part.indexOf(":");
    obj[part.slice(0, idx).trim()] = parseValue(part.slice(idx + 1));
  }
  return obj;
}
function parseInlineArray(s) {
  const inner = s.slice(1, s.lastIndexOf("]")).trim();
  if (!inner) return [];
  return splitTop(inner).map(parseValue);
}
