// 제안 PR 본문 렌더링과 최소 근거 창 검사(§8.3/§8.4). 순수 함수 — fs도 gh도 만지지 않는다.
// 근거가 창에 못 미치는 제안은 버리는 게 아니라 `deferred`로 돌려준다: L1이 `_retro.md` 후보
// 목록에 남겨 다음 retro가 다시 본다(Global Constraints "조건 미달 후보는 남긴다").

/**
 * 종류별 최소 근거 창(§8.4, N과 무관하게 고정). `test-delete`는 여기 없다 — 삭제 제안은 근거 수로
 * 판단하는 것이 아니라 언제나 사람이 본다(§5.2.5-④ "삭제는 조용히 일어나지 않는다").
 */
export const DEFAULT_WINDOWS = { gate: 3, threshold: 20, "role-change": 10, "role-new": 10 };

const KIND_LABEL = {
  gate: "lesson 승격 → gate",
  threshold: "임계 조정",
  "role-change": "역할 변경",
  "role-new": "역할 신설",
  "test-delete": "테스트 삭제",
};

const ALWAYS_ACCEPTED = new Set(["test-delete"]);

/** 서로 다른 run — 비교는 `String(r)`로 정규화한다(에이전트가 110과 "110"을 섞어 써도 창은 한 번만 찬다). */
const distinctRuns = (runs) => {
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(runs) ? runs : []) {
    const k = String(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
};

/**
 * `filterByEvidence(proposals, { windows }) → { accepted, deferred:[{proposal, reason}] }`
 * 근거는 **서로 다른** run 수로 센다 — 같은 이슈를 여러 번 인용해도 창은 차지 않는다.
 * `windows`는 기본값 위에 덮어쓴다(일부만 넘겨도 나머지 종류는 §8.4 기본값을 지킨다).
 * 창이 정의되지 않은 종류는 **defer**한다(fail closed) — 스키마가 5종만 허용하므로 모르는 kind는
 * 검증을 거치지 않은 출력이라는 뜻이고, "창이 없으니 통과"로 읽으면 근거 검사를 우회하는 구멍이 된다.
 */
export function filterByEvidence(proposals = [], { windows = {}, knownRuns = null } = {}) {
  const w = { ...DEFAULT_WINDOWS, ...windows };
  const accepted = [];
  const deferred = [];
  for (const p of proposals || []) {
    const kind = p?.kind;
    // `test-delete`는 근거 수로 판단하지 않고 **언제나 사람이 본다** — 그 제안이 인용하는 것도 run
    // 기록이 아니라 재작성 이슈 번호다. 그래서 아래 실재 검사도 지나간다.
    if (ALWAYS_ACCEPTED.has(kind)) { accepted.push(p); continue; }
    if (!(kind in w)) { deferred.push({ proposal: p, reason: `unknown-kind: ${kind}` }); continue; }
    /*
     * 감사 M10/M11 — **근거는 실재해야 한다.** 길이만 세던 검사는 "숫자 두 개를 타이핑했는가"를
     * 물었을 뿐이다. `knownRuns`(records 브랜치의 run id 집합)가 주어지면 그 안에 없는 id를 든
     * 제안은 미룬다 — 버리지 않는 이유는 나머지와 같다: 다음 retro가 진짜 근거와 함께 다시 본다.
     */
    if (knownRuns instanceof Set && knownRuns.size) {
      const unknown = [...new Set((Array.isArray(p?.evidence_runs) ? p.evidence_runs : []).map(String))].filter((r) => !knownRuns.has(r));
      if (unknown.length) { deferred.push({ proposal: p, reason: `unknown-evidence-run: ${unknown.join(", ")} (no such run record on the records branch)` }); continue; }
    }
    const need = w[kind];
    const have = distinctRuns(p?.evidence_runs).length;
    if (have >= need) accepted.push(p);
    else deferred.push({ proposal: p, reason: `insufficient-evidence: ${have} distinct runs < ${need} (${kind})` });
  }
  return { accepted, deferred };
}

/** ISO 8601 주 표기(`2026-W36`) — 제안 PR 제목 줄의 주차. UTC로만 계산한다(러너의 TZ와 무관하게 같은 값). */
export function isoWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(dateStr ?? "");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);       // 그 주의 목요일 = 그 주가 속한 해
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  jan4.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((d - jan4) / (7 * 24 * 3600 * 1000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function statsBlock(stats) {
  const s = stats || {};
  const usage = s.usage || {};
  const tokens = usage.tokens || {};
  const rejects = Object.entries(s.rejects_by_role || {});
  return [
    "### 통계",
    `- 이슈 ${s.merged || 0}건 머지, 평균 리뷰 라운드 ${s.review_rounds_avg || 0}, needs-human ${s.needs_human || 0}건`,
    `- 리뷰어별 reject 기여: ${rejects.length ? rejects.map(([role, n]) => `${role} ${n}`).join(", ") : "없음"}`,
    `- 사용량: ${money(usage.cost_usd)} (토큰 input(+cache) ${tokens.input || 0} / output ${tokens.output || 0})`,
  ].join("\n");
}

/**
 * `renderProposalPr({ period:{from,to}, proposals, stats }) → { title, body }` — §8.3 형식.
 * 본문 첫 줄은 기계 마커(`factory-retro:v1 period=…`)다: 사람이 머지하는 PR이지만 `:proposal`
 * 스킬과 다음 retro가 이 PR을 자기 산출물로 알아볼 수 있어야 한다.
 * 주차는 기간의 **시작**(`from`)이 속한 ISO 주로 적는다 — §8.3 예시(`2026-09-01..2026-09-07` →
 * `2026-W36`)가 그 규칙이다. 기간은 주 경계에 정확히 맞지 않을 수 있고(머지 수로 깨어나므로),
 * 그때 사람이 "어느 주를 돌아본 retro인가"로 읽는 것은 기간이 시작된 주다.
 */
export function renderProposalPr({ period = {}, proposals = [], stats } = {}) {
  const from = period.from ?? "";
  const to = period.to ?? "";
  const list = proposals || [];
  const sections = list.map((p, i) => {
    const label = KIND_LABEL[p?.kind] || p?.kind || "제안";
    const lines = [`### P${i + 1} · ${label}  (label: factory:retro-proposal)`, "", `**${p?.title ?? ""}**`, "", String(p?.body ?? "").replace(/\n+$/, "")];
    const runs = distinctRuns(p?.evidence_runs);
    if (runs.length) lines.push("", `근거: ${runs.map((n) => `runs/${n}.md`).join(", ")}`);
    return lines.join("\n");
  });
  const body = [
    `<!-- factory-retro:v1 period=${from}..${to} -->`,
    `## Retro ${isoWeek(from)} — 제안 ${list.length}건`,
    ...sections,
    statsBlock(stats),
  ].join("\n\n");
  return { title: `retro proposals ${from}..${to}`, body: `${body}\n` };
}
