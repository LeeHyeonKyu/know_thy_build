const ORDER = { FAIL: 0, WARN: 1, PASS: 2 };
const MARK = { FAIL: "✗", WARN: "!", PASS: "✓" };

/** doctor 종료 코드: FAIL이 하나라도 있으면 1, 아니면 0. */
export const exitCode = (checks) => (checks.some((c) => c.level === "FAIL") ? 1 : 0);

/** 레벨별 개수 집계 — renderReport의 요약 줄과 --json의 summary가 같은 구현을 공유한다. */
export function summarize(checks) {
  const s = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const c of checks) s[c.level]++;
  return s;
}

/** 사람이 읽는 리포트: FAIL → WARN → PASS 순, 같은 레벨 안에서는 id 사전순. 마지막 줄은 요약. */
export function renderReport(checks) {
  const sorted = [...checks].sort((a, b) => ORDER[a.level] - ORDER[b.level] || a.id.localeCompare(b.id));
  const n = summarize(checks);
  return [...sorted.map((c) => `${MARK[c.level]} ${c.id}${c.detail ? ` — ${c.detail}` : ""}`), "", `doctor: PASS ${n.PASS} · WARN ${n.WARN} · FAIL ${n.FAIL}`].join("\n");
}
