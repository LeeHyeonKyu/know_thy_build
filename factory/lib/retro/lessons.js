// lessons 파일(.factory/lessons/<role>.md) 다크 append(§7.4, §8.1). 순수 문자열 조작 — fs를 만지지
// 않는다. 출력은 integrity의 `lessonsFormat`을 통과해야 한다(테스트가 그 검사 함수로 직접 확인한다).
// 채택 여부(근거 run 수·중복·상한)를 이 모듈이 결정한다 — L1은 결과를 그대로 파일에 쓴다.

const HEADER = /<!--\s*factory-lessons:v1\s+role=([\w-]+)\s+max=(\d+)\s*-->/;
const ENTRY_START = /^- \[(L-(\d{4}-\d{2}-\d{2})-(\d{2}))\]\s?(.*)$/;
const CITATION = /인용:\s*(\d+)회/;

/** 텍스트를 {preamble, entries[]}로 나눈다. entries[]의 각 항목은 원본 블록(raw 줄들)을 그대로 보존한다. */
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
    return { id: m[1], date: m[2], nn: Number(m[3]), text: m[4], raw: block.join("\n"), citations: cite === undefined ? 0 : Number(cite) };
  });
  return { preamble, entries };
}

const norm = (s) => String(s ?? "").trim();

/** 오늘 날짜의 기존 최대 NN 다음 번호부터 새 id를 발급하는 카운터. */
function idCounter(entries, today) {
  let nn = entries.filter((e) => e.date === today).reduce((mx, e) => Math.max(mx, e.nn), 0);
  return () => { nn += 1; return `L-${today}-${String(nn).padStart(2, "0")}`; };
}

function formatRuns(evidenceRuns) {
  const distinct = [];
  for (const r of evidenceRuns || []) if (!distinct.includes(r)) distinct.push(r);
  return { distinct, refs: distinct.map((n) => `runs/${n}.md`).join(", ") };
}

/** entries 중 인용 0회인 것 오직 대상 — 가장 오래된 것(date 오름차순, 동일 date는 nn 오름차순) 하나. */
function oldestEvictable(entries) {
  const candidates = entries.filter((e) => e.citations === 0);
  if (!candidates.length) return null;
  return candidates.reduce((oldest, e) => {
    if (!oldest) return e;
    if (e.date !== oldest.date) return e.date < oldest.date ? e : oldest;
    return e.nn < oldest.nn ? e : oldest;
  }, null);
}

/**
 * applyLessons({ text, adopted, today, minEvidence = 2 })
 *   → { text, added:[{id, text}], rejected:[{text, reason}], evicted:[id] }
 *
 * adopted 항목마다: (1) 근거 run이 서로 다른 이슈 ≥minEvidence개 아니면 reason 'insufficient-evidence'로
 * 거부. (2) 텍스트(trim)가 기존 항목 또는 이번 배치의 앞선 채택과 정확히 같으면 reason 'duplicate'로
 * 거부. (3) 그 외에는 채택 시도 — 현재 항목 수가 헤더 max 이상이면 인용 0회·최오래 항목부터 evict해
 * 자리를 만들고, evict할 것이 더 없으면 reason 'max'로 거부(뒤에 남은 adopted 항목들도 같은 이유로
 * 거부된다 — 자리가 나지 않는 한 계속 그렇다).
 */
export function applyLessons({ text, adopted = [], today, minEvidence = 2 } = {}) {
  const head = HEADER.exec(text || "");
  const max = head ? Number(head[2]) : Infinity;
  const { preamble, entries } = splitEntries(text);

  const nextId = idCounter(entries, today);
  const added = [];
  const rejected = [];
  const evicted = [];
  const existingTexts = new Set(entries.map((e) => norm(e.text)));

  for (const item of adopted) {
    const itemText = norm(item?.text);
    const { distinct, refs } = formatRuns(item?.evidence_runs);

    if (distinct.length < minEvidence) { rejected.push({ text: item?.text, reason: "insufficient-evidence" }); continue; }
    if (existingTexts.has(itemText)) { rejected.push({ text: item?.text, reason: "duplicate" }); continue; }

    let madeRoom = true;
    while (entries.length >= max) {
      const victim = oldestEvictable(entries);
      if (!victim) { madeRoom = false; break; }
      entries.splice(entries.indexOf(victim), 1);
      evicted.push(victim.id);
    }
    if (!madeRoom) { rejected.push({ text: item?.text, reason: "max" }); continue; }

    const id = nextId();
    const raw = `- [${id}] ${itemText}\n  근거: ${refs}. 인용: 0회.`;
    entries.push({ id, date: today, nn: Number(id.slice(-2)), text: itemText, raw, citations: 0 });
    existingTexts.add(itemText);
    added.push({ id, text: itemText });
  }

  // 아무것도 채택/evict되지 않았으면 원문을 바이트 그대로 돌려준다 — 실패한 시도가 포맷을
  // 재조립하며 개행 하나라도 바꿔서는 안 된다.
  if (!added.length && !evicted.length) return { text: text ?? "", added, rejected, evicted };

  const body = entries.map((e) => e.raw).join("\n");
  const joined = preamble
    ? (body ? `${preamble.replace(/\n$/, "")}\n${body}\n` : (preamble.endsWith("\n") ? preamble : `${preamble}\n`))
    : (body ? `${body}\n` : "");

  return { text: joined, added, rejected, evicted };
}
