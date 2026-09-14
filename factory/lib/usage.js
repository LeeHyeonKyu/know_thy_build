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
// 블롭은 `[^}]*`로 잡지 않는다 — 실제 `claude -p`의 usage는 중첩 객체를 싣는다
// (`output_tokens_details`·`server_tool_use`·`cache_creation`·`iterations`). 탐욕 `\{.*\}`가
// 마지막 ` cost_usd: ` 앞의 `}`까지 되돌아가므로 중첩 깊이와 무관하게 한 줄을 통째로 집는다.
const USAGE_RE = /^usage: (\{.*\}) cost_usd: (\S+) num_turns: (\S+) terminal_reason: (\S+) models: (.*)$/;

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
 * §4.4 — **모델별 list price (USD / 1M 토큰), 이 저장소의 유일한 가격표**(ADR-022).
 *
 * 여기 있는 이유: 끝난 런의 비용은 `claude -p` 봉투가 직접 말해 주지만(`total_cost_usd`·`modelUsage`),
 * **도는 중인** 런은 아무도 말해 주지 않는다 — 트랜스크립트에는 모델 이름과 토큰 수만 있다. 그래서
 * `lib/progress.js`가 실시간 비용을 여기서 계산한다. 표를 두 벌 두면 "라이브 $0.41 / 최종 $0.38"처럼
 * 조용히 어긋나므로, 가격을 아는 곳은 이 파일 하나다.
 *
 * 매칭은 **패턴 순서대로 첫 히트**다(정확한 ID 목록이 아니다): 모델 ID는 계속 늘어나고, 로스터는
 * `opus`/`sonnet`/`haiku` 별칭으로도 적힌다(`roles.toml`). 어느 패턴에도 걸리지 않으면 `null`이고,
 * 비용은 **0으로 더해진다** — 모르는 모델에 아무 가격이나 붙여 그럴듯한 숫자를 만드는 것보다
 * "비용 미상"이 낫다(`summarizeUsage`가 `n/a`를 합산에서 빼는 것과 같은 원칙).
 *
 * 값의 출처: Anthropic 공개 list price(2026-06 기준). 캐시는 파생값이다 — 읽기 0.1×, 쓰기 1.25×.
 */
export const MODEL_PRICES = [
  [/fable|mythos/, { input: 10, output: 50 }],
  [/opus/, { input: 5, output: 25 }],
  [/sonnet-4|sonnet-3/, { input: 3, output: 15 }],
  [/sonnet/, { input: 2, output: 10 }],
  [/haiku/, { input: 1, output: 5 }],
];
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** 모델 이름(또는 별칭) → `{input, output}` USD/1M. 모르는 모델은 null. */
export function modelPrice(model) {
  const m = String(model ?? "").toLowerCase();
  if (!m) return null;
  for (const [re, price] of MODEL_PRICES) if (re.test(m)) return price;
  return null;
}

/** 한 번의 응답(또는 합산된 usage) → USD. 모르는 모델이면 0 — 지어내지 않는다. */
export function costFromUsage({ model, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_creation_tokens = 0 } = {}) {
  const p = modelPrice(model);
  if (!p) return 0;
  const perToken = (rate) => rate / 1e6;
  return (input_tokens * perToken(p.input))
    + (output_tokens * perToken(p.output))
    + (cache_read_tokens * perToken(p.input) * CACHE_READ_MULTIPLIER)
    + (cache_creation_tokens * perToken(p.input) * CACHE_WRITE_MULTIPLIER);
}

/**
 * Map<issue, run-기록 텍스트> → 이슈별/기간별/전체 합산. cost_usd는 n/a(null)를 무시하고 더한다
 * (n/a를 0으로 보면 "돌았지만 비용 미보고"와 "정말 비용이 0"을 구분 못 한다 — 그냥 합산에서 뺀다).
 *
 * tokens.input(O12 리뷰): `input_tokens` **만** 더하면 실제 청구 입력의 대부분을 빠뜨린다 — 프롬프트
 * 캐싱을 쓰는 세션은 컨텍스트 대부분이 `cache_creation_input_tokens`(캐시에 새로 쓴 것)나
 * `cache_read_input_tokens`(캐시에서 읽은 것)로 잡히고, `input_tokens`는 그 나머지(예: 데모 세션
 * 하나가 input 50 / cache_read 170334였다 — "50"은 실제 입력의 0.03%다). 그래서 `tokens.input`은
 * 세 필드를 **합산**한다 — 과금 관점의 "이 런이 모델에 넣은 입력 토큰 총량"이 그것이다.
 * `parseRunRecord`의 개별 필드(`input_tokens`/`cache_read_tokens`/`cache_creation_tokens`)는 원본
 * 그대로 남아 있다 — 여기서 더하는 건 이 합산 보고서 하나뿐이다.
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
      inputT += (e.input_tokens ?? 0) + (e.cache_creation_tokens ?? 0) + (e.cache_read_tokens ?? 0);
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
