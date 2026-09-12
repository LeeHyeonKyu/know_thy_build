// docs/factory/runs/_retro.md의 상태를 읽고 쓴다. 순수 모듈 — fs를 만지지 않는다
// (하이드레이트/싱크는 records-branch.js가 하고, 여기는 텍스트만 받는다).
// 형식: 사람용 표 + 마커(RETRO_STATE_MARKER) + ```json 펜스 하나(§9, §8.4).

export const RETRO_STATE_MARKER = "<!-- factory-retro-state:v1 -->";

const FENCE = /```json\s*\n([\s\S]*?)\n```/;

const defaultState = (initial) => ({
  cursor: { last_retro_at: null, last_record_offsets: {} },
  merges_since: 0,
  n: initial,
  history: [],
  candidates: { lessons: [], examples: [], flaky: [], needs_human: [] },
  stats: {},
});

/**
 * `_retro.md`를 파싱한다. md가 없거나 비어 있거나 마커가 없으면(첫 실행) 기본 상태를
 * 돌려준다 — N은 CHARTER `## Retro`의 `every_merges.initial`(`initial` 옵션)에서 온다.
 * 마커는 있는데 JSON 펜스가 없거나 안이 손상됐으면 **던진다**: retro는 절대 조용히
 * 이력(누적 통계·N 조정 이력·후보 목록)을 리셋하지 않는다 — 손상은 사람이 봐야 한다.
 */
export function parseRetroState(md, { initial = 1 } = {}) {
  const text = md || "";
  const markerIdx = text.indexOf(RETRO_STATE_MARKER);
  if (markerIdx === -1) return defaultState(initial);

  const rest = text.slice(markerIdx + RETRO_STATE_MARKER.length);
  const fence = FENCE.exec(rest);
  if (!fence) {
    throw new Error(
      `${RETRO_STATE_MARKER} 마커는 있으나 뒤에 \`\`\`json 펜스를 찾을 수 없습니다 — _retro.md가 손상되었습니다. ` +
        "retro 이력을 잃을 수 있어 자동 복구하지 않습니다.",
    );
  }

  try {
    return JSON.parse(fence[1]);
  } catch (e) {
    throw new Error(
      `${RETRO_STATE_MARKER} 뒤의 JSON 펜스가 손상되었습니다 — retro 이력을 잃을 수 있어 중단합니다: ${e.message}`,
    );
  }
}

const cell = (v) => String(v ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();

/** 이력 마지막 5줄 표. 전체 이력은 JSON 펜스에 그대로 있다 — 표는 사람이 훑어보는 용도. */
function historyTable(history) {
  const rows = (Array.isArray(history) ? history : []).slice(-5);
  if (!rows.length) return "_이력 없음_";
  const body = rows.map(
    (h) => `| ${cell(h.at)} | ${cell(h.yield)} | ${cell(h.n_before)} | ${cell(h.n_after)} | ${cell(h.needs_human_since)} |`,
  );
  return ["| at | yield | n_before | n_after | needs_human_since |", "| --- | --- | --- | --- | --- |", ...body].join("\n");
}

/**
 * 상태를 `_retro.md` 전체 텍스트로 렌더링한다. `statsTable`(옵션)은 L1이 계산한
 * 사람용 통계(§8.3 "통계" 절 — 리뷰 라운드 평균 등)를 그대로 끼워 넣는다.
 * `parseRetroState(renderRetroState(state)) ≡ state` — 사람용 부분은 파서가 읽지 않는다.
 */
export function renderRetroState(state, { statsTable } = {}) {
  const s = state || {};
  const cursor = s.cursor || {};
  const summary = [
    "# Retro State",
    "",
    `- last retro: ${cursor.last_retro_at ?? "없음"}`,
    `- merges since last retro: ${s.merges_since ?? 0}`,
    `- current N: ${s.n ?? "?"}`,
    "",
    "## History (last 5)",
    "",
    historyTable(s.history),
  ].join("\n");

  const stats = statsTable ? `\n\n## Stats\n\n${statsTable}` : "";
  const json = JSON.stringify(s, null, 2);

  return `${summary}${stats}\n\n${RETRO_STATE_MARKER}\n\`\`\`json\n${json}\n\`\`\`\n`;
}

/**
 * §8.4의 N 자가 조정 표. yield는 "직전 retro에서 채택된 lesson·예시/관점 추가·
 * harness 이슈·제안 PR 수"(호출자가 센다 — 이 함수는 세지 않는다).
 * 우선순위: (yield≥3 또는 needsHumanSince≥2) → ×0.5가 yield 0/1/2 규칙보다 앞선다
 * (표의 "또는"이 그 뜻 — needs-human이 많으면 수확이 적어도 N을 줄인다).
 */
export function nextN(n, { yield: y, needsHumanSince } = {}, { min = 1, max = Infinity } = {}) {
  let next;
  if (y >= 3 || (needsHumanSince ?? 0) >= 2) next = Math.round(n * 0.5);
  else if (y === 0) next = Math.round(n * 1.5);
  else next = n; // 1~2 → 유지

  next = Math.min(max, Math.max(min, next));
  return Math.max(1, next); // N은 절대 1 밑으로 내려가지 않는다(min 설정과 무관하게)
}

/**
 * 이번 머지에 전체 retro를 돌릴지(full) 경량 추출만 할지(light) 결정한다.
 * `force`(`factory run retro`)는 N을 무시한다. 그 외에는 "이번 머지를 포함해서"
 * 누적 머지 수가 N에 도달했는지로 판정한다(`merges_since + 1 >= n`) — `merges_since`는
 * 아직 이번 머지를 반영하지 않은 값이라 +1을 더한다.
 */
export function shouldRunFull({ state, retro, force } = {}) {
  if (force) return { full: true, reason: "forced" };
  if (state.merges_since + 1 >= state.n) return { full: true, reason: "merges_since+1 >= n" };
  return { full: false, reason: "merges_since+1 < n" };
}
