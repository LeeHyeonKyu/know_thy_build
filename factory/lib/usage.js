/**
 * §9/§4.4 사용량 파싱. run 기록(`docs/factory/runs/<issue>.md`, `appendRunRecord`가 쓴 형식)을 읽어
 * 스테이지별 usage를 뽑고(§`parseRunRecord`), 이슈별·기간별로 합산한다(§`summarizeUsage`).
 *
 * 입력 형식은 두 곳에서 고정된다 — 둘 다 이 파일이 아니라 실제로 기록을 만드는 코드다:
 *   - `appendRunRecord`(lib/run-record.js): `## <stage> · <ts> · <runner>` 헤더로 섹션을 연다.
 *   - `usageLine`(bin/run-stage.js): 그 섹션 안에 한 줄로 `usage: {...} cost_usd: … num_turns: … terminal_reason: … models: …`를 남긴다.
 * 두 형식이 바뀌면 이 파일의 정규식도 같이 바뀌어야 한다 — 그래서 테스트는 이 파일이 직접 그 함수들을 불러 만든
 * 고정을 대상으로 한다(가짜 텍스트가 아니라).
 */

// 알려진 스테이지 이름만 헤더로 인정한다 — 섹션 본문(예: 리뷰 코멘트 인용문)에 우연히 "## "로
// 시작하는 줄이 섞여 들어와도 새 섹션으로 오인하지 않는다. retro/sweep은 아직 run-stage.js의
// STAGES에 없지만(§Task 16·Plan 4) 기록 포맷은 동일하게 쓸 예정이라 미리 받아둔다.
const HEADER_RE = /^## (triage|plan|implement|review|merge|retro|sweep) · (.+?) · (.+)$/gm;
const USAGE_RE = /^usage: (\{[^}]*\}) cost_usd: (\S+) num_turns: (\S+) terminal_reason: (\S+) models: (.*)$/;

/** "YYYY-MM-DDTHH:MMZ"(초 없는 short form)도, 일반 ISO도 받는다. 파싱 불가면 null. */
function toMs(at) {
  const shortForm = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})Z$/.exec(at);
  const iso = shortForm ? `${shortForm[1]}:00Z` : at;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function parseModels(s) {
  if (!s || s === "n/a") return {};
  const out = {};
  for (const part of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^(.+)=\$(.+)$/.exec(part);
    if (!m) continue;
    out[m[1]] = m[2] === "n/a" ? null : Number(m[2]);
  }
  return out;
}

/** 섹션 본문에서 찾은 `usage: …` 줄 하나를 구조화한다. 매치 실패(형식이 어긋남)면 null. */
function parseUsageLine(line) {
  const m = USAGE_RE.exec(line);
  if (!m) return null;
  let usageObj;
  try { usageObj = JSON.parse(m[1]); } catch { usageObj = {}; }
  return {
    cost_usd: m[2] === "n/a" ? null : Number(m[2]),
    input_tokens: usageObj.input_tokens ?? null,
    output_tokens: usageObj.output_tokens ?? null,
    cache_read_tokens: usageObj.cache_read_input_tokens ?? null,
    cache_creation_tokens: usageObj.cache_creation_input_tokens ?? null,
    num_turns: m[3] === "n/a" ? null : Number(m[3]),
    models: parseModels(m[5]),
  };
}

/**
 * run 기록 전체 텍스트 → 스테이지별 배열. `usage:` 줄이 없는 섹션(예: verdict만 남긴 리뷰 스테이지)은
 * usage 관련 필드 전부가 null이다 — 0이 아니다(0은 "돌았지만 비용 없음"과 혼동된다).
 */
export function parseRunRecord(text) {
  const matches = [...text.matchAll(HEADER_RE)];
  const out = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const body = text.slice(start, end);
    const usageLineText = body.split("\n").map((l) => l.trim()).find((l) => l.startsWith("usage:"));
    const parsed = usageLineText ? parseUsageLine(usageLineText) : null;
    out.push({
      stage: m[1],
      at: m[2],
      runner: m[3],
      cost_usd: parsed ? parsed.cost_usd : null,
      input_tokens: parsed ? parsed.input_tokens : null,
      output_tokens: parsed ? parsed.output_tokens : null,
      cache_read_tokens: parsed ? parsed.cache_read_tokens : null,
      cache_creation_tokens: parsed ? parsed.cache_creation_tokens : null,
      num_turns: parsed ? parsed.num_turns : null,
      models: parsed ? parsed.models : null,
    });
  }
  return out;
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Map<issue, run-기록 텍스트> → 이슈별/기간별/전체 합산. cost_usd는 n/a(null)를 무시하고 더한다
 * (n/a를 0으로 보면 "돌았지만 비용 미보고"와 "정말 비용이 0"을 구분 못 한다 — 그냥 합산에서 뺀다).
 * tokens는 input/output만 더한다(cache는 §4.4 보고 범위 밖).
 */
export function summarizeUsage(records, { now, windowDays = 7 } = {}) {
  const nowMs = toMs(now);
  const sinceMs = nowMs - windowDays * 86400000;

  let totalCost = 0, totalRuns = 0, windowCost = 0, windowRuns = 0;
  const perIssue = [];

  for (const [issue, text] of records) {
    const entries = parseRunRecord(text);
    let cost = 0, runs = 0, inputT = 0, outputT = 0;
    for (const e of entries) {
      runs += 1;
      totalRuns += 1;
      if (e.cost_usd != null) { cost += e.cost_usd; totalCost += e.cost_usd; }
      if (e.input_tokens != null) inputT += e.input_tokens;
      if (e.output_tokens != null) outputT += e.output_tokens;
      const ms = toMs(e.at);
      if (ms != null && ms >= sinceMs) {
        windowRuns += 1;
        if (e.cost_usd != null) windowCost += e.cost_usd;
      }
    }
    perIssue.push({ issue, cost_usd: round6(cost), runs, tokens: { input: inputT, output: outputT } });
  }

  perIssue.sort((a, b) => b.cost_usd - a.cost_usd);

  return {
    perIssue,
    window: { since: new Date(sinceMs).toISOString(), cost_usd: round6(windowCost), runs: windowRuns },
    total: { cost_usd: round6(totalCost), runs: totalRuns },
  };
}
