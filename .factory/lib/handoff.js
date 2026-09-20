const MARKER = /<!--\s*factory-handoff:v1\s+stage=([a-z-]+)\s+issue=(\d+)\s*-->/;
const FENCE = /```json\s*\n([\s\S]*?)\n```/;

const arr = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : []);
/** 표·목록 한 줄에 들어갈 문자열 — 줄바꿈은 공백으로, 표 구분자는 escape. */
const line = (v) => String(v ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** 역할의 입장에서 첫 문장만. 마침표가 없으면 앞부분만 잘라 쓴다 — 다이제스트는 요약이지 전문이 아니다. */
function firstSentence(v) {
  const t = line(v);
  const m = /^[\s\S]*?[.!?。](\s|$)/.exec(t);
  const s = (m ? m[0] : t).trim();
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

const block = (heading, lines) => (lines.length ? [heading, ...lines].join("\n") : "");

/**
 * plan — 사람이 읽고 "이 계약에 서명할 수 있는가"를 판단하는 데 필요한 것만: 무엇이 done인가(done_when),
 * 누가 끝까지 반대했는가(dissent), 그리고 그 결론이 어떤 토론에서 나왔는가(R1 입장 한 줄씩·R2 반박 수·표결).
 * P3-R5: 라운드별 코멘트를 따로 달지 않고 이 하나의 본문으로 합친다.
 */
function planBody(d) {
  // Task 1: `verify`는 `check {kind:"test"}`의 옛 철자다. 옛 항목은 verify로, 새 항목은 check.ref로 렌더한다.
  const doneWhen = arr(d.done_when).map((w, i) => `${i + 1}. ${line(w.id)} · ${line(w.text)} · ${line(w.verify) || line(w.check?.ref)}@${line(w.level)}`);
  const dissent = arr(d.dissent_log).map((x) => `- ${line(x.role)}: ${line(x.objection)} → ${line(x.resolution)}`);

  const debate = d.debate || {};
  const digest = arr(debate.r1).map((p) => `- R1 ${line(p.role)}: ${firstSentence(p.position)}`);
  // workflow는 R2 전문 대신 반박 **개수**만 싣는다(F7) — 사람용 다이제스트가 쓰던 것도 그 숫자 하나였다.
  // rounds < 3이면 교차검토가 아예 돌지 않았다(docs tier) — "0 objections"는 거기서 거짓말이다.
  const skippedR2 = Number.isFinite(Number(d.rounds)) && Number(d.rounds) < 3;
  if (typeof debate.r2_objections === "number" && !skippedR2) digest.push(`- R2: ${plural(debate.r2_objections, "objection")}`);
  const votes = arr(debate.votes);
  if (votes.length) {
    const accept = votes.filter((v) => v.vote === "accept").length;
    digest.push(`- votes: ${accept} accept / ${votes.length - accept} object`);
  }

  return [block("**done_when**", doneWhen), block("**dissent**", dissent), block("**토론**", digest)].filter(Boolean).join("\n\n");
}

/** implement — PR로 가는 링크 하나, verifier의 판정, 그리고 그 판정이 걸린 테스트들. */
function implementBody(d) {
  const out = [];
  const head = [];
  // PR 번호만 굵게 — 사람이 이 본문에서 찾는 것은 "어디로 가면 되는가" 하나다. sha는 따라오는 사실이라
  // 같이 굵히면 강조가 둘이 되어 아무것도 강조되지 않는다.
  if (d.pr !== undefined && d.pr !== null && d.pr !== "") head.push(`**PR #${line(d.pr)}**`);
  if (typeof d.head_sha === "string" && d.head_sha) head.push(`head \`${line(d.head_sha).slice(0, 12)}\``);
  if (head.length) out.push(head.join(" · "));
  const v = d.verifier || {};
  if (v.verdict) out.push(`verifier: ${line(v.verdict)} (${plural(arr(v.findings).length, "finding")})`);
  const tests = arr(d.tests_added).map((t) => `\`${line(t)}\``);
  if (tests.length) out.push(`tests_added: ${tests.join(", ")}`);
  return out.join("\n");
}

/** review — 판정은 표가 제일 빨리 읽힌다. must_fix는 id만 싣는다(본문은 기계 블록에 그대로 있다). */
function reviewBody(d) {
  const verdicts = arr(d.verdicts);
  if (!verdicts.length) return "";
  const rows = verdicts.map((v) => {
    const ids = arr(v.must_fix).map((m) => line(m && m.id)).filter(Boolean);
    return `| ${line(v.role)} | ${line(v.verdict)} | ${line(v.confidence)} | ${ids.length ? ids.join(", ") : "—"} |`;
  });
  return ["| role | verdict | confidence | must_fix |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

/** triage — 통과/보류와 그 이유. needs-info면 사람이 답해야 할 질문이 본문의 전부다. */
function triageBody(d) {
  const out = [];
  if (d.disposition) out.push(`**disposition**: ${line(d.disposition)}${d.tier ? ` · tier ${line(d.tier)}` : ""}`);
  const questions = arr(d.questions).map((q, i) => `${i + 1}. ${line(q)}`);
  if (questions.length) out.push(block("**questions**", questions));
  return out.join("\n\n");
}

const BODY = { plan: planBody, implement: implementBody, review: reviewBody, triage: triageBody };

/**
 * 스테이지 handoff 코멘트를 만든다. 구조는 변하지 않는다 — 마커 한 줄, 사람용 본문, ```json 펜스 하나.
 * `parseHandoffs`는 마커와 펜스 사이를 전부 summary로 읽으므로 본문에 또 다른 ```json 블록을 넣으면 안 된다.
 * 본문은 스테이지별로 다르다(§3.4의 기계 블록은 그대로 두고, 사람이 읽을 요약만 스테이지에 맞춘다).
 */
export function renderHandoff({ stage, issue, summary, data }) {
  const json = JSON.stringify(data, null, 2);
  const body = BODY[stage] ? BODY[stage](data || {}) : "";
  const human = [String(summary ?? "").trim(), body.trim()].filter(Boolean).join("\n\n");
  return `<!-- factory-handoff:v1 stage=${stage} issue=${issue} -->\n${human}\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

export function parseHandoffs(comments) {
  const out = [];
  for (const c of comments) {
    const m = MARKER.exec(c.body || "");
    if (!m) continue;
    const f = FENCE.exec(c.body);
    if (!f) continue;
    let data;
    try { data = JSON.parse(f[1]); } catch { continue; }
    const summary = c.body.slice(m.index + m[0].length, f.index).trim();
    out.push({ stage: m[1], issue: Number(m[2]), data, summary, createdAt: c.createdAt, commentId: c.id });
  }
  return out;
}

export function latestHandoff(comments, stage) {
  const hs = parseHandoffs(comments).filter((h) => h.stage === stage);
  if (hs.length === 0) return null;
  hs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return hs[0];
}
