// lessons 파일(.factory/lessons/<role>.md) 다크 append(§7.4, §8.1). 순수 문자열 조작 — fs를 만지지
// 않는다. 출력은 integrity의 `lessonsFormat`을 통과해야 한다(테스트가 그 검사 함수로 직접 확인한다).
// 채택 여부(근거 run 수·중복·상한)를 이 모듈이 결정한다 — L1은 결과를 그대로 파일에 쓴다.

import { normalizeItemText } from "./text.js";

const HEADER = /<!--\s*factory-lessons:v1\s+role=([\w-]+)\s+max=(\d+)\s*-->/;
const ENTRY_START = /^- \[(L-(\d{4}-\d{2}-\d{2})-(\d{2}))\]\s?(.*)$/;
const CITATION = /인용:\s*(\d+)회/;

/**
 * 외부 감사 2026-09-14 M11 — **인용 표식.** `인용: N회`는 §7.4가 정한 필드인데 그것을 올리는 코드가
 * 어디에도 없었다: 15개 전 항목이 영원히 0회였고, 곧 은퇴 규칙("인용 0회인 것부터")은 "가장 오래된
 * 것부터"의 다른 이름이었다 — 실제로 쓰인 교훈과 아무도 읽지 않은 교훈이 구별되지 않았다.
 *
 * 표식은 판정문 본문에 **에이전트가 직접 적는다**: `lesson:L-2026-09-12-01`. 별도 필드가 아니라
 * 마커인 이유는, 그 자리가 곧 "이 교훈을 여기서 썼다"는 문맥이기 때문이다(리뷰어 프롬프트가
 * must_fix 문장 안에 그대로 쓰게 한다). 파싱은 id 형식을 그대로 요구한다 — `lesson:` 뒤가
 * `L-YYYY-MM-DD-NN`이 아니면 인용이 아니다(사람이 산문으로 쓴 "lesson: 타임존"은 세지 않는다).
 */
export const LESSON_CITATION_RE = /\blesson:(L-\d{4}-\d{2}-\d{2}-\d{2})\b/g;
export function citedLessonIds(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(LESSON_CITATION_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** 텍스트를 {preamble, entries[]}로 나눈다. entries[]의 각 항목은 원본 블록(raw 줄들)을 그대로 보존
 * 하고, `isNew:false`로 시작한다 — 이번 호출에서 파일에 이미 있던 항목임을 표시한다. */
function splitEntries(text) {
  const lines = (text || "").split("\n");
  const starts = [];
  lines.forEach((l, i) => { if (ENTRY_START.test(l)) starts.push(i); });
  if (!starts.length) return { preamble: text ?? "", entries: [] };
  const preamble = lines.slice(0, starts[0]).join("\n");
  const entries = starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const block = lines.slice(s, end);
    // 블록 끝의 빈 줄(다음 항목과의 구분용)은 raw에서 떼어 둔다 — 재조립 시 항목 사이 공백을
    // 우리가 직접 통제해 evict로 빈 항목이 남거나 이중 개행이 남는 일을 막는다.
    while (block.length && block[block.length - 1] === "") block.pop();
    const m = ENTRY_START.exec(block[0]);
    const cite = block.map((l) => CITATION.exec(l)?.[1]).find((v) => v !== undefined);
    return { id: m[1], date: m[2], nn: Number(m[3]), text: m[4], raw: block.join("\n"), citations: cite === undefined ? 0 : Number(cite), isNew: false };
  });
  return { preamble, entries };
}

// 에이전트가 준 문장은 **한 줄**이어야 한다(§7.4의 `- [id] <문장>` + 다음 줄 `근거:`) — 개행이 섞이면
// integrity의 `lessonsFormat`이 형식 위반으로 읽고 다크 PR이 RED가 되어 영원히 머지되지 않는다.
const norm = (s) => normalizeItemText(s);

/**
 * 오늘 날짜의 기존 최대 NN 다음 번호부터 새 id를 발급하는 카운터. NN은 2자리(01~99)까지만
 * integrity의 `lessonsFormat`이 허용하는 형식(`L-\d{4}-\d{2}-\d{2}-\d{2}`)을 만족한다 — 100을
 * 넘으면(오늘 날짜로 항목이 99개를 초과) 잘못된 id를 만드는 대신 `null`을 돌려준다.
 */
function idCounter(entries, today) {
  let nn = entries.filter((e) => e.date === today).reduce((mx, e) => Math.max(mx, e.nn), 0);
  return () => {
    nn += 1;
    if (nn > 99) return null;
    return `L-${today}-${String(nn).padStart(2, "0")}`;
  };
}

function formatRuns(evidenceRuns) {
  const distinct = [];
  for (const r of evidenceRuns || []) if (!distinct.includes(r)) distinct.push(r);
  return { distinct, refs: distinct.map((n) => `runs/${n}.md`).join(", ") };
}

/**
 * `entries` 중 이번 호출에서 evict할 수 있는 후보 — **이번 호출에서 새로 추가된 항목은 절대
 * 대상이 아니다**(`isNew`) — 방금 채택한 걸 자리 부족을 이유로 곧바로 지우는 건 모순이다.
 *
 * 감사 M11 — 은퇴 순서는 **인용 0회 먼저, 그 다음 나이**다. 예전 규칙은 인용 0회만 후보로 삼았고
 * (그래서 자리가 없으면 채택이 'max'로 거부됐다), 어차피 카운터가 한 번도 오르지 않아 그 필터는
 * 아무것도 걸러내지 않았다 — 사실상 "가장 오래된 것부터"였다. 이제 카운터가 실제로 오르므로 그
 * 순서가 의미를 갖는다: 한 번이라도 쓰인 교훈은 **마지막에** 나간다. 그래도 자리는 유한하므로,
 * 인용된 것만 남았을 때는 그중 가장 오래된 것이 나간다 — 예전 규칙(인용 항목은 절대 evict 불가)은
 * 파일이 상한에 닿는 순간 **새 교훈을 영원히 받지 못하게** 만들었다(전부 'max' 거부).
 * 키는 둘뿐이다: (1) 인용 0회인가, (2) 나이. 인용 **횟수**로 줄을 세우지 않는다 — 많이 인용된
 * 교훈이 더 오래 버티는 것은 이 규칙의 목적이 아니고(그건 인기 투표다), 순서를 읽는 사람에게
 * "한 번도 안 쓰인 것부터"라는 한 문장이 남아야 한다.
 */
function oldestEvictable(entries, count) {
  const rank = (e) => (e.citations === 0 ? 0 : 1);
  const pool = entries.filter((e) => !e.isNew);
  pool.sort((a, b) => (rank(a) !== rank(b)
    ? rank(a) - rank(b)
    : a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.nn - b.nn));
  return pool.slice(0, count);
}

/**
 * 감사 M11 — 인용 카운터를 항목의 원문(raw) 안에서 올린다. `인용: N회` 표식이 있으면 그 숫자만
 * 바꾸고(나머지 바이트는 그대로), 없으면(옛 형식) `근거:` 줄 끝에 붙인다 — 표식이 없다는 이유로
 * 조용히 세지 않으면 그 항목은 영원히 은퇴 1순위로 남는다.
 */
function bumpCitations(entries, citations) {
  const cited = [];
  for (const [id, add] of Object.entries(citations || {})) {
    const n = Number(add);
    if (!Number.isFinite(n) || n <= 0) continue;
    const e = entries.find((x) => x.id === id);
    if (!e) continue;                                                 // 이 역할의 파일에 없는 id — 발명하지 않는다
    const from = e.citations;
    const to = from + n;
    e.citations = to;
    e.raw = CITATION.test(e.raw)
      ? e.raw.replace(CITATION, `인용: ${to}회`)
      : e.raw.replace(/(근거:[^\n]*?)\s*$/m, `$1 인용: ${to}회.`);
    cited.push({ id, from, to });
  }
  return cited;
}

/**
 * applyLessons({ text, adopted, today, minEvidence = 2 })
 *   → { text, added:[{id, text}], rejected:[{text, reason}], evicted:[id] }
 *
 * adopted 항목마다: (1) 근거 run이 서로 다른 이슈 ≥minEvidence개 아니면 reason 'insufficient-evidence'로
 * 거부. (2) 텍스트(trim)가 기존 항목 또는 이번 배치의 앞선 채택과 정확히 같으면 reason 'duplicate'로
 * 거부. (3) id 발급이 오늘 날짜의 NN 공간(01~99)을 넘으면 reason 'id-space'로 거부. (4) 그 외에는
 * 채택을 **시도**한다 — 필요한 evict 수를 먼저 계산하고, 그만큼의 evict 가능한(인용 0회, 이번 호출
 * 이전부터 있던) 항목이 실제로 있을 때만 evict를 **실행**하고 채택을 확정한다. evict 가능한 항목이
 * 모자라면 아무것도 evict하지 않고 reason 'max'로 거부한다(evict를 하고 나서야 실패를 아는, 자리를
 * 낭비하는 일이 없다). `added[]`는 언제나 반환된 `text`에 실제로 반영된 항목과 정확히 일치한다.
 */
export function applyLessons({ text, adopted = [], today, minEvidence = 2, citations = {} } = {}) {
  const head = HEADER.exec(text || "");
  const max = head ? Number(head[2]) : Infinity;
  const { preamble, entries } = splitEntries(text);

  // 감사 M11 — **인용을 먼저 센다.** 순서가 중요하다: 이번 회차에 인용된 항목은 같은 회차의 evict
  // 대상에서 뒤로 밀려야 한다(방금 쓰인 교훈을 자리 부족으로 지우는 것은 정확히 반대 방향이다).
  const cited = bumpCitations(entries, citations);
  const nextId = idCounter(entries, today);
  const added = [];
  const rejected = [];
  const evicted = [];
  const existingTexts = new Set(entries.map((e) => norm(e.text)));

  for (const item of adopted) {
    const itemText = norm(item?.text);
    const { distinct, refs } = formatRuns(item?.evidence_runs);

    // 빈 문장은 채택할 수 없다 — `- [L-…] ` 뒤가 비면 사람에게도 integrity에게도 의미가 없는 항목이다.
    if (!itemText) { rejected.push({ text: item?.text, reason: "empty" }); continue; }
    if (distinct.length < minEvidence) { rejected.push({ text: item?.text, reason: "insufficient-evidence" }); continue; }
    if (existingTexts.has(itemText)) { rejected.push({ text: item?.text, reason: "duplicate" }); continue; }

    const id = nextId();
    if (id === null) { rejected.push({ text: item?.text, reason: "id-space" }); continue; }

    // 자리 계산을 먼저 하고, 성공할 때만 실행한다 — 부분적으로 evict한 뒤 그래도 실패하는 일은 없다.
    const roomNeeded = Math.max(0, entries.length + 1 - max);
    const victims = roomNeeded > 0 ? oldestEvictable(entries, roomNeeded) : [];
    if (victims.length < roomNeeded) { rejected.push({ text: item?.text, reason: "max" }); continue; }

    for (const v of victims) {
      entries.splice(entries.indexOf(v), 1);
      // 집합에는 **정규화된** 텍스트가 들어 있다(`norm(e.text)`) — 원문으로 지우면 그 항목이 집합에
      // 남아, evict된 문장을 같은 배치에서 다시 채택하려 할 때 엉뚱하게 'duplicate'로 거부된다.
      existingTexts.delete(norm(v.text));
      evicted.push(v.id);
    }

    const raw = `- [${id}] ${itemText}\n  근거: ${refs}. 인용: 0회.`;
    entries.push({ id, date: today, nn: Number(id.slice(-2)), text: itemText, raw, citations: 0, isNew: true });
    existingTexts.add(itemText);
    added.push({ id, text: itemText });
  }

  // 아무것도 채택/evict/인용되지 않았으면 원문을 바이트 그대로 돌려준다 — 실패한 시도가 포맷을
  // 재조립하며 개행 하나라도 바꿔서는 안 된다.
  if (!added.length && !evicted.length && !cited.length) return { text: text ?? "", added, rejected, evicted, cited };

  const body = entries.map((e) => e.raw).join("\n");
  const joined = preamble
    ? (body ? `${preamble.replace(/\n$/, "")}\n${body}\n` : (preamble.endsWith("\n") ? preamble : `${preamble}\n`))
    : (body ? `${body}\n` : "");

  return { text: joined, added, rejected, evicted, cited };
}
