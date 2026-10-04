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

/**
 * #196 (ADR-036) — **engine-crash 줄.** `runStage`의 catch가 프로그래밍 오류(TypeError 등)를 잡았을 때만 러너가 쓴다
 * (`bin/run-stage.js`) — 그 섹션은 이 런이 던지기 전에 모은 `usage:` 줄을 함께 싣고, `lib/budget.js`가 그 비용을 평생 상한에서
 * 빼 따로 보고한다. 생성자와 정규식이 이 파일 한 곳에 있는 이유는 `usageLine`/`USAGE_RE`와 같다: 쓰는 쪽과 읽는 쪽이 어긋나면
 * 테스트가 전부 초록인 채로 아무것도 세지 않는다.
 *
 * 줄은 **자기 런을 지목한다**(`runner=`): 섹션 헤더의 러너와 같은 줄만 센다. 다른 러너를 지목한 줄(복사·위조)은 무시하고, 그
 * 섹션은 보통 런으로 센다 — 모르는 것은 세는 쪽으로 기운다(엔진 런을 세면 사람이 조금 일찍 볼 뿐이고, 보통 런을 빼면 상한이 샌다).
 * 메시지는 한 줄로 접는다(개행이 들어간 오류 문구가 다음 줄을 흉내 내지 못하게).
 *
 * **위조 방어는 겹으로 건다**(①·①'·② — ADR-036 2. skeptic sc2 — 러너는 게이트 사유·의존성 오류 메시지처럼 남이 만든 문구를 기록에 옮겨 적고, 그 문구의
 * 개행은 기록에서 제 줄이 된다):
 *   ① 쓰는 쪽 — `runStage`의 `record()`는 진짜 크래시 줄이 아닌 모든 줄에서 줄머리의 `engine-crash:`를 `quoteEngineCrashLines`로
 *      인용 표시한다(문구는 감사용으로 남고, 크래시 줄로는 읽히지 않는다).
 *   ② 읽는 쪽 — 크래시 줄은 **자리**까지 맞아야 센다: 섹션 본문의 첫 줄이 `error: <섹션 스테이지> aborted — `이고 바로 다음 줄이
 *      그 스테이지·그 러너의 크래시 줄일 때만이다(`runStage` catch가 쓰는 모양 그대로). 다른 자리의 크래시 줄은 세지 않는다.
 */
export const ENGINE_CRASH_PREFIX = "engine-crash:";
const ENGINE_CRASH_RE = /^engine-crash: stage=(\S+) runner=(\S+) run_id=(\S+) error=(\w+) —/;
export const engineCrashLine = ({ stage, runnerId, runId = null, error }) => {
  const name = /^\w+$/.test(String(error?.name ?? "")) ? error.name : "Error";
  const msg = String(error?.message ?? error ?? "").replace(/https?:\/\/\S+/g, "<url>").replace(/\s+/g, " ").trim().slice(0, 200);
  return `${ENGINE_CRASH_PREFIX} stage=${stage} runner=${runnerId} run_id=${runId ?? "n/a"} error=${name} — ${msg}`;
};
/**
 * #196 rework sec1 — **"줄머리"는 읽는 쪽이 정한다.** 파서는 줄을 `.trim()`하고(그 공백 집합은 JS `\s`와 같다: NBSP·\v·\f·\r·
 * U+2028·BOM·U+3000…), `HEADER_RE`의 `^`(/m)는 \n뿐 아니라 \r·U+2028·U+2029 뒤에서도 선다. 그래서 인용은 그 줄 끝 넷 뒤의
 * **`\s` 전부**를 건너뛰고 본다 — `[ \t]`만 보던 예전 모양은 NBSP 한 글자로 뚫렸다.
 */
const LINE_TERMINATOR_RE = /[\n\r\u2028\u2029]/;
/** 진짜 크래시 줄이 아닌 텍스트에서, 어느 줄이든 줄머리의 `engine-crash:`를 인용 표시한다(①). */
export const quoteEngineCrashLines = (text) => String(text).replace(/(^|[\n\r\u2028\u2029])(\s*)engine-crash:/g, "$1$2(quoted) engine-crash:");
/** 어느 줄이든 줄머리의 `## `(섹션 헤더 모양)를 인용 표시한다 — 기록에 옮겨 적힌 문구가 섹션을 열지 못하게(①'). */
export const quoteRecordHeaders = (text) => String(text).replace(/(^|[\n\r\u2028\u2029])(\s*)## /g, "$1$2(quoted) ## ");
/**
 * `appendRunRecord`가 **모든** 기록 줄에 거는 정리(sec1): 줄 하나(배열 원소 하나)는 섹션 헤더를 세우지 못하고, 그 줄 **안의**
 * 개행 뒤 조각은 크래시 줄도 `usage:` 줄도 되지 못한다. 원소의 첫 조각은 그대로 둔다 — 진짜 크래시 줄·usage 줄은 러너가 원소
 * 하나로 넘기고, 그 밖의 원소는 이미 `record()`가 크래시 머리를 통째로 인용했다. 이렇게 하면 `record()`를 거치지 않는 기록자
 * (abortStage·main의 recordLine)도 개행 하나로 헤더·크래시 줄·비용 줄을 지어내지 못한다(파서는 섹션의 **첫** `usage:` 줄을 센다 —
 * 옮겨 적힌 문구가 진짜 usage보다 앞서면 그 런의 비용을 바꿔 쓸 수 있었다).
 */
export const neutralizeRecordLine = (line) => {
  const s = quoteRecordHeaders(line);
  const m = LINE_TERMINATOR_RE.exec(s);
  if (!m) return s;
  const rest = quoteEngineCrashLines(s.slice(m.index)).replace(/(^|[\n\r\u2028\u2029])(\s*)usage:/g, "$1$2(quoted) usage:");
  return s.slice(0, m.index) + rest;
};
/**
 * 섹션이 `runStage` catch가 쓴 크래시 섹션인가(②): 첫 줄 `error: <stage> aborted — `, 둘째 줄 그 스테이지·그 러너의 크래시 줄.
 * `lines`는 **trim하지 않은** 줄이다(sec1): 러너는 두 줄을 줄 맨 앞부터 쓴다 — 앞에 공백이 붙은 줄은 러너가 쓴 모양이 아니므로 세지 않는다.
 */
function sectionEngineCrash(lines, stage, runner) {
  const body = lines.filter((l) => l.trim() !== "");
  if (body.length < 2 || !body[0].startsWith(`error: ${stage} aborted — `)) return false;
  const m = ENGINE_CRASH_RE.exec(body[1]);
  return Boolean(m && m[1] === stage && m[2] === runner);
}

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
    const bodyLines = body.split("\n").map((l) => l.trim());
    const usageLineText = bodyLines.find((l) => l.startsWith("usage:"));
    const parsed = usageLineText ? parseUsageLine(usageLineText) : null;
    // #196 — 키는 크래시 섹션에만 선다: 크래시 줄이 없는 기록의 항목은 바이트 하나 안 바뀐다(옛 소비자·고정이 그대로 본다).
    const engineCrash = sectionEngineCrash(body.split("\n"), m[1], m[3].trim());
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
      ...(engineCrash ? { engine_crash: true } : {}),
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
