const MARKER = /<!--\s*factory-handoff:v1\s+stage=([a-z-]+)\s+issue=(\d+)\s*-->/;
const FENCE = /```json\s*\n([\s\S]*?)\n```/;

export function renderHandoff({ stage, issue, summary, data }) {
  const json = JSON.stringify(data, null, 2);
  return `<!-- factory-handoff:v1 stage=${stage} issue=${issue} -->\n${summary.trim()}\n\n\`\`\`json\n${json}\n\`\`\`\n`;
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
