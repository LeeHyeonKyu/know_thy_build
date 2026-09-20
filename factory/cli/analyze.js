import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run as realRun } from "../lib/exec.js";
import { makeGh, resolveRepo, resolveFactoryLogins } from "../lib/gh.js";
import { readRecords } from "../lib/records-branch.js";
import { loadHarness } from "../lib/config.js";
import { runIdOfRunner } from "../lib/run-record.js";
import { GATES_DETAIL_PREFIX } from "../lib/gates.js";
import { CONTEXT_MANIFEST_PREFIX } from "../lib/context.js";
import { SELF_GATE_DETAIL_PREFIX } from "../lib/self-gate.js";
import { parseProgressMarker } from "../lib/progress.js";
import { parseHandoffs } from "../lib/handoff.js";
import { parseHeartbeat } from "../lib/heartbeat.js";
import {
  ACTUALLY_MOVED_TO_NEEDS_HUMAN, HUMAN_DECISION, NEEDS_HUMAN_LABEL,
  REFUSAL_REASON, SELF_GATE_RETRY, TRANSITION_REFUSED, TRANSITION_TO,
} from "../lib/retro/issue-comments.js";
import { harvestFindings, knownRunsFor, isBoundLine } from "../lib/feedback/harvest-findings.js";
import { classifyFinding } from "../lib/feedback/classify.js";
import { loadInstallManifest, INSTALL_MANIFEST_PATH } from "../lib/feedback/install-manifest.js";

/**
 * ── Feedback loop Task 5 — `factory analyze` (spec §1, §4의 **수동 경로**) ─────────────────────
 *
 * 문제는 데이터가 없다는 것이 아니었다. 데모 #39가 왜 멈췄는지는 **이미 전부 기록돼 있었다**:
 * self-gate가 막은 이유는 재시도 코멘트에, 전이가 거부된 이유(`plan roles … != roster []` — 진짜
 * 근본 원인)는 거부 코멘트에, 게이트 판정은 런 기록의 `FACTORY_GATES:` 한 줄에, 실패한 테스트
 * 이름은 그 옆의 `gates-detail:`에, 역할이 무엇을 봤는지는 `context-manifest:`에, 누가 얼마를
 * 태웠는지는 `usage:`와 그 둘째 줄의 `progress:v1`에 있었다. 없었던 것은 **한 화면**이다: 사람은
 * 그 다섯~일곱 자리를 손으로 뒤져야 했고, 그래서 대개 뒤지지 않았다.
 *
 * 이 명령은 새 사실을 만들지 않는다. 이미 durable한 두 출처(`factory/records`의 런 기록 + 이슈
 * 코멘트)를 **읽기만** 해서 한 타임라인으로 편다. 그래서:
 *
 * ① **Actions 아티팩트를 요구하지 않는다.** 7일이 지난 런도 똑같이 읽힌다(Global Constraint —
 *    durable before ephemeral). T1이 게이트 상세와 컨텍스트 매니페스트를 기록에 실어 둔 덕이다.
 * ② **records 브랜치를 로컬에 클론하지 않아도 된다.** 기본 읽기는 `gh api .../contents?ref=` 한
 *    번이다(노트북에서 그대로 돈다). 클론이 손에 있으면 `readRecords`로, 그것도 없으면 작업본으로
 *    떨어진다 — 세 경로 모두 같은 텍스트를 낸다.
 * ③ **분류는 회고와 글자 그대로 같은 함수로 한다** (`harvestFindings` + `classifyFinding`).
 *    사람이 여기서 보는 `[ktb]`/`[harness]`는 회고가 머지 때 실제로 라우팅할 바로 그 판정이다.
 *    두 벌의 규칙을 두면 "CLI는 ktb라는데 회고는 이슈를 안 열었다"가 되고, 그 순간 이 명령은
 *    신뢰를 잃는다. 여기서는 아무것도 라우팅하지 않는다 — 읽기 전용이다.
 *
 * 무엇을 **하지 않는가**: 이슈를 열지 않고, 라벨을 만지지 않고, 코멘트를 쓰지 않고, 기록을 고치지
 * 않는다. `factory status`와 같은 계약이다(읽기 전용 보고는 무엇 때문에도 죽지 않는다).
 */

const RECORDS_BRANCH = "factory/records";
const RECORDS_DIR = "docs/factory/runs";

/** `## <stage> · <at> · <runner>` — `usage.js`의 HEADER_RE와 같은 스테이지 allowlist다. */
const SECTION = /^## (triage|plan|implement|review|merge|retro|sweep) · (.+?) · (.+)$/;
const GATES_LINE = /^FACTORY_GATES: (.+)$/;
const ARTIFACT_LINE = /^artifact: (.+)$/;
const USAGE_LINE = /^usage: (\{.*\}) cost_usd: (\S+) num_turns: (\S+) terminal_reason: (\S+) models: (.*)$/;

const jsonAfter = (line, prefix) => {
  if (!line.startsWith(prefix)) return null;
  try { return JSON.parse(line.slice(prefix.length)); } catch { return null; }
};

/** "none" 은 빈 목록이다(`verdictLine`의 `list()`가 쓰는 표기) — 이름이 "none"인 게이트가 아니다. */
const listOf = (v) => (v == null || v === "none" || v === "" ? [] : String(v).split(",").filter(Boolean));

/** `level=fast status=RED passed=1 …` → 객체. 모르는 키도 그대로 싣는다(형식이 자라도 안 잃는다). */
function parseGatesLine(rest) {
  const out = { line: `FACTORY_GATES: ${rest}` };
  for (const m of String(rest).matchAll(/(\w+)=(\S*)/g)) {
    const [, k, v] = m;
    if (k === "passed" || k === "failed") out[k] = Number(v);
    else if (k === "level" || k === "status") out[k] = v;
    else out[k] = listOf(v);
  }
  return out;
}

function parseUsage(m) {
  let usage = {};
  try { usage = JSON.parse(m[1]); } catch { usage = {}; }
  const models = {};
  if (m[5] && m[5] !== "n/a") {
    for (const part of m[5].split(",").map((s) => s.trim()).filter(Boolean)) {
      const mm = /^(.+)=\$(.+)$/.exec(part);
      if (mm) models[mm[1]] = mm[2] === "n/a" ? null : Number(mm[2]);
    }
  }
  return {
    // `n/a`는 0이 아니라 **모름**이다 — 0으로 적으면 "공짜로 돌았다"가 되어 합계가 조용히 거짓말한다.
    usd: m[2] === "n/a" ? null : Number(m[2]),
    input_tokens: usage.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null,
    cache_read_tokens: usage.cache_read_input_tokens ?? null,
    cache_creation_tokens: usage.cache_creation_input_tokens ?? null,
    turns: m[3] === "n/a" ? null : Number(m[3]),
    terminal_reason: m[4] === "n/a" ? null : m[4],
    models,
  };
}

/** short form(`2026-09-20T10:08Z`)도 일반 ISO도 받는다. 못 읽으면 null — 지어내지 않는다. */
function toMs(at) {
  const short = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})Z$/.exec(String(at ?? ""));
  const t = Date.parse(short ? `${short[1]}:00Z` : String(at ?? ""));
  return Number.isNaN(t) ? null : t;
}

/**
 * 런 기록 전문 → 스테이지 런의 배열. 각 런은 자기 섹션의 줄들에서 아는 접두사만 뽑아 쓰고, 모르는
 * 줄은 `notes`로 남긴다(형식이 자라도 사람이 보는 화면에서 사라지지 않는다).
 *
 * **섹션 헤더는 서술이지 권위가 아니다**: `gates-detail:`/`context-manifest:`/`self-gate-detail:`은
 * 저마다 `run_id`/`runner`를 싣고 있고, 그 값이 헤더와 어긋나면 여기서는 **양쪽 다 보여 준다**
 * (`bound: false`). 판정하는 자리(`harvestFindings`)는 어긋난 줄을 증거에서 뺀다 — 사람이 보는
 * 화면에서까지 지워 버리면 위조를 발견할 방법이 사라지기 때문에, 보고는 숨기지 않고 표시한다.
 */
export function parseSections(record) {
  const sections = [];
  let cur = null;
  for (const raw of String(record ?? "").split("\n")) {
    const line = raw.trimEnd();
    const s = SECTION.exec(line);
    if (s) {
      const runner = s[3].trim();
      cur = {
        stage: s[1], at: s[2], runner, run_id: runIdOfRunner(runner),
        artifacts: [], gates: [], gates_detail: [], self_gate: [],
        context: [], usage: [], progress: [], notes: [],
      };
      sections.push(cur);
      continue;
    }
    if (!cur) continue;                                   // 첫 헤더 앞의 줄(제목)은 런의 것이 아니다
    if (!line.trim()) continue;

    const a = ARTIFACT_LINE.exec(line);
    if (a) { cur.artifacts.push(a[1].trim()); continue; }

    const g = GATES_LINE.exec(line);
    if (g) { cur.gates.push(parseGatesLine(g[1])); continue; }

    const gd = jsonAfter(line, GATES_DETAIL_PREFIX);
    if (gd) { cur.gates_detail.push(gd); continue; }

    const cm = jsonAfter(line, CONTEXT_MANIFEST_PREFIX);
    if (cm) { cur.context.push(cm); continue; }

    const sg = jsonAfter(line, SELF_GATE_DETAIL_PREFIX);
    if (sg) { cur.self_gate.push(sg); continue; }

    const u = USAGE_LINE.exec(line);
    if (u) { cur.usage.push(parseUsage(u)); continue; }

    const p = parseProgressMarker(line);
    if (p) { cur.progress.push(p); continue; }

    cur.notes.push(line);
  }
  return sections;
}

/**
 * ── T5 리뷰 MF-2: **섹션은 스테이지 런이 아니다.** ────────────────────────────────────────────
 *
 * `appendRunRecord`는 한 런 안에서 **여러 번** 불린다 — `run-stage.js`의 `record([...])` 한 번이
 * `## <stage> · <at> · <runner>` 섹션 하나를 더 붙인다(검증 한 줄, 게이트 한 줄, self-gate 한 줄,
 * usage 한 줄이 저마다 다른 호출에서 나온다). 그래서 진짜 기록인 `factory/records`의
 * `docs/factory/runs/20.md`는 섹션이 11개인데 **런은 셋**이다(triage·plan·implement 각 하나).
 * 섹션을 세어 "11 stage-runs"라고 적으면 사람은 이 이슈가 열한 번 돌았다고 읽는다 — 거짓이다.
 *
 * 그러므로 묶는 기준은 **런의 정체**다: 섹션 헤더의 러너에서 얻은 `run_id` + 그 런이 돈 스테이지.
 * (GHA에서 `run_id` 하나는 스테이지 하나를 돌므로 실제 데이터에서는 `run_id`만으로도 같은 답이
 * 나오지만, 스테이지를 키에 넣어 두면 한 런이 두 스테이지를 도는 날에도 둘을 합치지 않는다.)
 * 인접이 아니라 **키로** 묶는다 — 꼬리 병합으로 두 러너의 섹션이 교차해 들어와도 옳게 갈린다.
 *
 * 러너 이름에서 식별자를 못 얻는 섹션(`none`/`unknown`/빈 값)은 `bound:false`인 자기 그룹으로
 * 모인다 — 버리지 않는다: 그 섹션들이 존재한다는 사실 자체가 사람이 봐야 할 것이다.
 */
export function groupRuns(sections) {
  const byKey = new Map();
  for (const s of sections) {
    const key = s.run_id == null ? `unbound:${s.stage}` : `${s.run_id} ${s.stage}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        stage: s.stage, runner: s.runner, run_id: s.run_id, bound: s.run_id != null,
        at: s.at, last_at: s.at, sections: 0,
        artifacts: [], gates: [], gates_detail: [], self_gate: [], context: [],
        cost: null, agents: [], files_touched: [], notes: [],
      };
      byKey.set(key, g);
    }
    g.sections += 1;
    g.last_at = s.at;
    for (const a of s.artifacts) if (!g.artifacts.includes(a)) g.artifacts.push(a);
    g.gates.push(...s.gates);
    g.gates_detail.push(...s.gates_detail);
    g.self_gate.push(...s.self_gate);
    g.context.push(...s.context);
    g.notes.push(...s.notes);
    // 한 런은 `claude -p`를 여러 번 부를 수 있고 usage 줄도 그만큼 나온다 — **더한다**.
    for (const u of s.usage) g.cost = addCost(g.cost, u);
    /**
     * `progress:v1`은 런 전체의 트랜스크립트를 매번 다시 접어 만드는 **누적** 스냅숏이므로,
     * 마지막 마커가 가장 완전하다. 이어붙이면 같은 에이전트를 두 번 세게 된다.
     */
    for (const p of s.progress) {
      if (Array.isArray(p.agents)) g.agents = p.agents;
      if (Array.isArray(p.files_touched)) g.files_touched = p.files_touched;
      if (Number.isInteger(p.truncated_agents)) g.truncated_agents = p.truncated_agents;
    }
  }
  return [...byKey.values()];
}

function addCost(acc, u) {
  const a = acc || { usd: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null, turns: null, calls: 0, models: {}, terminal_reason: null };
  const add = (x, y) => (x == null && y == null ? null : (x ?? 0) + (y ?? 0));
  const out = {
    // `n/a`(모름)는 0으로 접지 않는다 — 합계가 "공짜로 돌았다"고 말하면 안 된다.
    usd: a.usd == null && u.usd == null ? null : Math.round(((a.usd ?? 0) + (u.usd ?? 0)) * 1e6) / 1e6,
    input_tokens: add(a.input_tokens, u.input_tokens),
    output_tokens: add(a.output_tokens, u.output_tokens),
    cache_read_tokens: add(a.cache_read_tokens, u.cache_read_tokens),
    cache_creation_tokens: add(a.cache_creation_tokens, u.cache_creation_tokens),
    turns: add(a.turns, u.turns),
    calls: a.calls + 1,
    models: { ...a.models },
    terminal_reason: u.terminal_reason ?? a.terminal_reason,
  };
  for (const [m, c] of Object.entries(u.models || {})) {
    out.models[m] = c == null ? (out.models[m] ?? null) : Math.round(((out.models[m] ?? 0) + c) * 1e6) / 1e6;
  }
  return out;
}

/**
 * 코멘트 → 타임라인 이벤트. 런 기록이 "무엇이 돌았나"라면 이쪽은 "그래서 무슨 일이 벌어졌나"다 —
 * 전이(거부 포함)·리뷰 판정과 must_fix·self-gate 재시도·사람의 결정. 전부 durable한 이슈 코멘트다.
 */
export function eventsFrom(comments) {
  const out = [];
  for (const c of comments || []) {
    const body = String(c?.body ?? "");
    const at = c?.createdAt ?? null;
    const base = { at, at_ms: toMs(at), comment_id: c?.id ?? null, author: c?.author ?? null };

    const refused = TRANSITION_REFUSED.exec(body);
    const moved = TRANSITION_TO.exec(body);
    if (refused && body.includes(ACTUALLY_MOVED_TO_NEEDS_HUMAN)) {
      out.push({ ...base, kind: "transition-refused", from: refused[1], to: refused[2], moved_to: NEEDS_HUMAN_LABEL, reason: (REFUSAL_REASON.exec(body)?.[1] ?? "").trim() || null });
    } else if (moved) {
      out.push({ ...base, kind: "transition", from: moved[1], to: moved[2], by: moved[3], reason: moved[4] ?? null });
    }

    const sg = SELF_GATE_RETRY.exec(body);
    if (sg) {
      out.push({ ...base, kind: "self-gate-retry", head: sg[2], attempt: Number(sg[3]), findings: selfGateFindingsIn(body) });
    }

    const hd = HUMAN_DECISION.exec(body);
    if (hd) {
      out.push({
        ...base, kind: "human-decision", skill: hd[2] ?? null,
        decision: /^\s*decision:\s*(\S+)\s*$/m.exec(body)?.[1] ?? null,
        cause: /^\s*cause:\s*["']?([^\s"']+)["']?\s*$/m.exec(body)?.[1] ?? null,
        reason: /^\s*reason:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? null,
      });
    }

    /**
     * 하트비트는 **런 id를 싣고 오는 유일한 코멘트**다(러너 이름이 곧 런 식별자다). 그래서 이
     * 이벤트만은 "어느 런의 것"이라고 말할 자격이 있고, 그 사실이 곧 `knownRunsFor`가 기록의 줄을
     * 검증하는 재료이기도 하다.
     */
    const hb = parseHeartbeat(body);
    if (hb?.runner) out.push({ ...base, kind: "heartbeat", stage: hb.stage ?? null, runner: hb.runner, run_id: runIdOfRunner(hb.runner) });
  }

  for (const h of parseHandoffs(comments || [])) {
    const verdicts = Array.isArray(h.data?.verdicts) ? h.data.verdicts : null;
    out.push({
      at: h.createdAt ?? null, at_ms: toMs(h.createdAt), comment_id: h.commentId ?? null, author: null,
      kind: verdicts ? "review" : "handoff", stage: h.stage,
      round: Number.isInteger(h.data?.round) ? h.data.round : null,
      summary: h.summary || null,
      verdicts: verdicts
        ? verdicts.map((v) => ({
          role: v?.role ?? null, verdict: v?.verdict ?? null,
          must_fix: (Array.isArray(v?.must_fix) ? v.must_fix : []).map((mf) => ({
            id: mf?.id ?? null, where: mf?.where ?? null, claim: mf?.claim ?? null, evidence: mf?.evidence ?? null,
          })),
        }))
        : null,
    });
  }

  out.sort((a, b) => (a.at_ms ?? 0) - (b.at_ms ?? 0));
  return out;
}

const SELF_GATE_FINDINGS_JSON = /```json\s*(\{[\s\S]*?"schema"\s*:\s*"factory\.self-gate-findings\.v1"[\s\S]*?\})\s*```/;
function selfGateFindingsIn(body) {
  const m = SELF_GATE_FINDINGS_JSON.exec(body);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    return Array.isArray(parsed?.findings) ? parsed.findings : [];
  } catch { return []; }
}

/**
 * 런 기록 + 코멘트 → 한 타임라인. **순수 함수다**: gh도 fs도 시계도 만지지 않는다.
 *
 * ── T5 리뷰 MF-3: **시간으로 이벤트를 런에 붙이지 않는다.** ───────────────────────────────────
 *
 * 1차 구현은 "자기보다 앞선 마지막 런"에 이벤트를 붙였다. 그 추론의 재료는 섹션 헤더의 시각인데,
 * 그 값은 **분 단위로 잘린** 문자열(`2026-09-20T10:08Z`)이고 같은 분에 섹션이 여럿 생기며, 게다가
 * 섹션은 런이 아니라 append 한 번이다. 리뷰어는 plan 런의 전이가 여섯 번째 런에 붙는 것을
 * 재현했다 — 그리고 **틀린 귀속은 없는 것보다 나쁘다**: 사람은 그 화면을 읽고 엉뚱한 런의 로그를
 * 파러 간다.
 *
 * 그래서 규칙은 하나다: **런 id를 싣고 오지 않는 이벤트는 어느 런의 것이라고도 말하지 않는다.**
 * 전이·사람의 결정·self-gate 재시도·핸드오프는 전부 그 부류이므로, 자기 타임스탬프만 달고 하나의
 * 연대기에 선다. 그 연대기에는 스테이지 런의 **시작**도 함께 서므로(런은 자기 첫 섹션의 시각을
 * 안다) 사람은 무엇이 무엇 사이에 벌어졌는지 여전히 읽을 수 있다 — 다만 그 판단을 이 도구가
 * 대신 내리지 않을 뿐이다. 하트비트만은 러너 이름을 싣고 오므로 `run_id`가 붙는다.
 *
 * ── T5 리뷰 MF-4: **줄의 바인딩은 harvest와 같은 함수로 판정한다.** ──────────────────────────
 * 1차 구현은 줄을 자기 **섹션 헤더**와 대조했는데, 헤더는 누구나 줄 앞에 놓을 수 있으므로 위조된
 * 줄은 위조된 헤더와 언제나 일치한다. 권위는 **하트비트 코멘트**다(러너만 쓰는 채널). 그래서
 * `knownRunsFor` + `isBoundLine` — `harvestFindings`가 증거를 고를 때 쓰는 바로 그 두 함수 — 로
 * 판정한다. 판정이 두 벌이면 "CLI는 증거라는데 회고는 무시한" 줄이 생긴다.
 */
export function buildTimeline({ issue, repo = null, record = "", comments = [] } = {}) {
  const runs = groupRuns(parseSections(record));
  const events = eventsFrom(comments);

  // 권위는 하트비트다 — 기록의 섹션 헤더가 아니다(harvest와 같은 출처, 같은 술어).
  const known = knownRunsFor(comments);
  const lines = { total: 0, unbound: 0 };
  const mark = (arr) => arr.map((l) => {
    const bound = isBoundLine(l, known);
    lines.total += 1;
    if (!bound) lines.unbound += 1;
    return { ...l, bound };
  });
  for (const r of runs) {
    r.gates_detail = mark(r.gates_detail);
    r.context = mark(r.context);
    r.self_gate = mark(r.self_gate);
    r.unbound_lines = [...r.gates_detail, ...r.context, ...r.self_gate].filter((l) => !l.bound).length;
  }

  // 연대기: 런의 시작과 코멘트 이벤트가 **각자의 타임스탬프로** 한 줄에 선다.
  const chronology = [
    ...runs.map((r) => ({ kind: "run-start", at: r.at, at_ms: toMs(r.at), stage: r.stage, runner: r.runner, run_id: r.run_id, sections: r.sections })),
    ...events,
  ].sort((a, b) => (a.at_ms ?? 0) - (b.at_ms ?? 0));

  const totals = { cost_usd: 0, cost_known: 0, cost_unknown: 0, input_tokens: 0, output_tokens: 0, turns: 0 };
  for (const r of runs) {
    if (!r.cost) continue;
    if (r.cost.usd == null) totals.cost_unknown += 1;
    else { totals.cost_usd += r.cost.usd; totals.cost_known += 1; }
    totals.input_tokens += r.cost.input_tokens ?? 0;
    totals.output_tokens += r.cost.output_tokens ?? 0;
    totals.turns += r.cost.turns ?? 0;
  }
  totals.cost_usd = Math.round(totals.cost_usd * 1e6) / 1e6;

  return {
    issue: Number(issue), repo, runs, events, chronology,
    record_lines: lines,
    known_runs: [...known],
    runners: [...new Set(runs.map((r) => r.runner).filter(Boolean))],
    totals,
  };
}

/**
 * 원시 발견 → 분류된 발견. **회고와 같은 두 함수**를 같은 순서로 부른다(`route.js`의 팔과 대조).
 * 매니페스트가 없으면 분류하지 않는다 — `classifyFinding`이 던지는 것이 옳고(주인 맵 없이 나누면
 * 채택자의 하네스 결함이 전부 상류로 간다), 여기서는 그 이유를 사람에게 말해 준다.
 */
export function classifyAll({ findings, manifest, harness }) {
  if (!manifest) {
    return { findings: [], skipped: `no install manifest (${INSTALL_MANIFEST_PATH}) and no factory/cli/manifest.js — refusing to classify without the real owner map; run \`npx know-thy-build factory init --upgrade\`` };
  }
  const out = [];
  for (const f of findings) {
    try {
      const c = classifyFinding({ finding: f, ownerOf: manifest.ownerOf, isInstalled: manifest.isInstalled, ktbVersion: manifest.ktbVersion, harness });
      const attribution = f.extra?.attribution ?? null;
      out.push({
        kind: f.kind, stage: f.stage ?? null, round: f.round ?? null, role: f.role ?? null,
        reason: f.reason ?? null,
        tags: c.tags, causal: c.causal, confidence: c.confidence, disposition: c.disposition,
        fingerprint: c.fingerprint, payload: c.payload,
        ...(c.candidates ? { candidates: c.candidates } : {}),
        attribution: Array.isArray(attribution) ? attribution : (attribution ? [attribution] : []),
        chain: f.extra?.chain ?? [],
      });
    } catch (e) {
      out.push({ kind: f.kind, reason: f.reason ?? null, tags: [], error: `classify failed — ${e?.message || e}` });
    }
  }
  return { findings: out, skipped: null };
}

// ── 렌더 ──────────────────────────────────────────────────────────────────────────────────────

const k = (n) => (n == null ? "?" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const money = (n) => (n == null ? "n/a" : `$${n.toFixed(2)}`);
const joinOr = (a, empty = "none") => (a && a.length ? a.join(",") : empty);

/** 스니펫은 **머리 몇 줄**만 — 사람이 한 화면에서 원인을 알아보는 데 필요한 만큼이다. */
function snippetHead(s, max = 4) {
  return String(s ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(0, max);
}

/** 바인딩되지 않은 줄에 붙는 꼬리표 — 세 줄 종류 전부에 같은 문구로 붙는다(리뷰 SF-5). */
const UNBOUND = "UNBOUND — no heartbeat names this run, so harvest ignores this line as evidence";

export function renderTimeline(tl, classified, { factoryLogins = null, recordSource = null, recordTrusted = true, loginNote = null } = {}) {
  const L = [];
  const bots = new Set((factoryLogins || []).map((s) => String(s).toLowerCase()));
  // `null`(해석 실패)과 배열(해석 성공)은 다르다 — 전자에서는 작성자를 사람이라고 단정할 수 없다.
  const loginsKnown = Array.isArray(factoryLogins);
  L.push(`Run · #${tl.issue}${tl.repo ? ` · ${tl.repo}` : ""}`);
  const runnerNote = tl.runners.length ? ` · runners: ${tl.runners.join(", ")}` : "";
  L.push(`${tl.runs.length} stage-run${tl.runs.length === 1 ? "" : "s"}${runnerNote} · total ${money(tl.totals.cost_usd)}${tl.totals.cost_unknown ? ` (+${tl.totals.cost_unknown} run(s) with no usage line)` : ""}`);

  // 경고는 **읽히는 자리**에 둔다 — 발견 목록 뒤에 붙이면 사람은 이미 "0건"을 결론으로 읽은 뒤다.
  if (loginNote) L.push(`!! ${loginNote}`);

  if (!recordTrusted && recordSource) {
    L.push(`!! UNVERIFIED — the run record came from ${recordSource}, a local scratch copy under docs/factory/runs/.`);
    L.push("   That path is writable by no-write stage agents and may be stale or agent-written; the records branch is the durable one.");
  }

  if (!tl.runs.length) {
    L.push("");
    L.push("no run record on the records branch for this issue — showing the comment-side events only");
  }

  for (const [i, r] of tl.runs.entries()) {
    L.push("");
    const id = r.bound ? `${r.runner}${r.run_id && r.run_id !== r.runner ? ` (run ${r.run_id})` : ""}` : `${r.runner} — NO RUN ID`;
    const span = r.last_at && r.last_at !== r.at ? `${r.at} → ${r.last_at}` : r.at;
    L.push(`── ${i + 1}. ${r.stage} · ${span} · ${id}`);
    L.push(`   ${r.sections} record section${r.sections === 1 ? "" : "s"} appended by this run${r.unbound_lines ? ` · ${r.unbound_lines} unbound line(s)` : ""}`);
    for (const a of r.artifacts) L.push(`   artifact: ${a}`);

    for (const g of r.gates) L.push(`   ${g.line}`);
    // 리뷰 SF-6 — `gates-detail:`은 `FACTORY_GATES:` 줄이 없어도 찍는다. 둘은 각각 다른 append에서
    // 나오므로, 상세를 요약 아래에 가두면 요약을 못 받은 런의 RED 원인이 통째로 사라진다.
    for (const d of r.gates_detail) {
      const bits = [];
      if (Number.isInteger(d.code)) bits.push(`exit ${d.code}`);
      if (typeof d.parsed === "boolean") bits.push(d.parsed ? "report parsed" : "report NOT parsed");
      if (d.bound === false) bits.push(UNBOUND);
      L.push(`   gate ${d.gate}: RED${bits.length ? ` (${bits.join(", ")})` : ""}`);
      if (d.reason) L.push(`     reason: ${d.reason}`);
      if (d.failing?.length) L.push(`     failing: ${d.failing.join(", ")}`);
      if (d.note) L.push(`     note: ${d.note}`);
      for (const s of snippetHead(d.snippet)) L.push(`     | ${s}`);
    }

    for (const sg of r.self_gate) {
      const state = sg.blocked ? (sg.harness ? "BLOCKED (harness-level — the check could not run here)" : "BLOCKED") : "ran, did not block";
      L.push(`   self-gate: ${state} · ran=${joinOr(sg.ran)} · skipped=${joinOr((sg.skipped || []).map((s) => `${s.check}(${s.reason})`))}${sg.ktb_version ? ` · ktb ${sg.ktb_version}` : ""}${sg.bound === false ? ` · ${UNBOUND}` : ""}`);
    }

    for (const c of r.context) {
      L.push(`   context: ${c.role} — ${c.cold_read ? "cold-read" : "full-ctx"}${Number.isInteger(c.round) ? ` (round ${c.round})` : ""}, fields: ${joinOr(c.fields, "(none)")}${c.bound === false ? ` · ${UNBOUND}` : ""}`);
    }

    if (r.cost) {
      const cost = r.cost;
      const calls = cost.calls > 1 ? ` · ${cost.calls} agent calls` : "";
      L.push(`   cost: ${money(cost.usd)} · ${k(cost.input_tokens)} in / ${k(cost.output_tokens)} out · ${k(cost.cache_read_tokens)} cache-read · ${cost.turns ?? "?"} turns${calls}`);
      for (const a of r.agents) {
        L.push(`     agent ${a.label} (${a.kind}${a.status ? `/${a.status}` : ""}): ${money(a.cost_usd)} · ${k(a.input_tokens)} in / ${k(a.output_tokens)} out · ${a.turns ?? "?"} turns`);
      }
      if (Number.isInteger(r.truncated_agents) && r.truncated_agents > 0) L.push(`     (+${r.truncated_agents} agent(s) dropped from the marker to fit its byte budget)`);
    }
    for (const note of r.notes) L.push(`   ${note}`);
  }

  if (tl.chronology.length) {
    L.push("");
    L.push("── chronology (each line is placed by its own timestamp; an event is attributed to a run only when it carries that run's id)");
    for (const line of renderChronology(tl.chronology, bots, loginsKnown)) L.push(line);
  }

  L.push("");
  L.push(renderFindingsHeader(classified, tl));
  for (const line of renderFindings(classified)) L.push(line);
  return L;
}

function renderChronology(chronology, bots, loginsKnown) {
  const L = [];
  for (const ev of chronology) {
    const at = (ev.at ?? "?").padEnd(20);
    if (ev.kind === "run-start") {
      L.push(`   ${at} ▶ stage-run ${ev.stage} starts · ${ev.runner}${ev.run_id ? ` (run ${ev.run_id})` : " (no run id)"}`);
    } else if (ev.kind === "heartbeat") {
      L.push(`   ${at} heartbeat · ${ev.stage ?? "?"} · ${ev.runner}${ev.run_id ? ` (run ${ev.run_id})` : ""}`);
    } else {
      const lines = renderEvent(ev, bots, loginsKnown);
      if (!lines.length) continue;
      L.push(`   ${at} ${lines[0]}`);
      for (const extra of lines.slice(1)) L.push(`   ${extra}`);
    }
  }
  return L;
}

/** 이벤트 한 건 → 줄들. 첫 줄만 타임스탬프를 받고 이어지는 줄은 그 아래로 정렬한다. */
function renderEvent(ev, bots, loginsKnown) {
  const L = [];
  const cont = " ".repeat(21);
  if (ev.kind === "transition-refused") {
    L.push(`transition REFUSED: ${ev.from} → ${ev.to}${ev.reason ? ` — ${ev.reason}` : ""}`);
    L.push(`${cont}(the label was moved to ${ev.moved_to})`);
  } else if (ev.kind === "transition") {
    L.push(`transition: ${ev.from} → ${ev.to} by ${ev.by}${ev.reason ? ` (${ev.reason})` : ""}`);
  } else if (ev.kind === "self-gate-retry") {
    L.push(`self-gate retry (attempt ${ev.attempt}, head ${ev.head}):`);
    for (const f of ev.findings) L.push(`${cont}  ${f.check}${f.blocking ? " [blocking]" : ""}${f.harness ? " [harness]" : ""}: ${f.detail ?? ""}`);
  } else if (ev.kind === "review") {
    const verdicts = (ev.verdicts || []).map((v) => `${v.role}=${v.verdict}`).join(", ");
    L.push(`review round ${ev.round ?? "?"}: ${verdicts || "(no verdicts)"}`);
    for (const v of ev.verdicts || []) {
      for (const mf of v.must_fix) {
        L.push(`${cont}  must_fix [${v.role}] ${mf.id ?? "?"} where=${mf.where ?? "?"} — ${mf.claim ?? ""}`);
        if (mf.evidence) L.push(`${cont}    evidence: ${mf.evidence}`);
      }
    }
  } else if (ev.kind === "handoff") {
    L.push(`handoff: ${ev.stage}${ev.summary ? ` — ${ev.summary}` : ""}`);
  } else if (ev.kind === "human-decision") {
    /**
     * 리뷰 SF-7 — 이 줄이 **귀속의 증거가 되는지**를 그 자리에서 말한다. 작성자가 팩토리 계정이면
     * `attributionFor`가 그 결정을 무시하므로(에이전트가 적은 "사람의 결정"은 결정이 아니다),
     * 사람이 "내가 factory-defect라고 적었는데 왜 ktb가 아니지"를 여기서 바로 읽을 수 있어야 한다.
     */
    const who = ev.author == null ? "(author unknown — not usable as evidence)"
      // 팩토리 계정 목록을 못 얻었으면 "사람"이라고 말할 수 없다 — 셋째 상태가 필요하다(재리뷰 nit).
      : !loginsKnown ? `@${ev.author} (author unverifiable — factory logins unresolved)`
        : bots.has(String(ev.author).toLowerCase()) ? `@${ev.author} (factory login — ignored by attribution)`
          : `@${ev.author} (human)`;
    L.push(`human decision (${ev.skill ?? "?"}) by ${who}: ${ev.decision ?? "?"}${ev.cause ? ` · cause=${ev.cause}` : ""}`);
    if (ev.reason) L.push(`${cont}  ${ev.reason}`);
  }
  return L;
}

/**
 * 리뷰 MF-4 — 발견이 0건일 때 **왜 0건인지**를 말한다. "문턱을 넘은 것이 없다"는 그 이유가 사실일
 * 때에만 참이다: 하트비트가 하나도 없거나 줄의 런 식별자가 어긋나면 harvest는 기록의 줄을 **전부**
 * 무시하므로, 증거가 가득한 이슈도 0건이 된다. 그 두 경우를 한 문장으로 구별해 주지 않으면 사람은
 * "이 런은 깨끗했다"로 읽는다.
 */
function renderFindingsHeader(classified, tl) {
  if (classified.skipped) return "Findings: not classified";
  const n = classified.findings.length;
  const { total = 0, unbound = 0 } = tl?.record_lines || {};
  if (!n) {
    if (total && unbound === total) {
      return `Findings: none — but all ${total} evidence line(s) in the run record are UNBOUND (no heartbeat comment names their run), so harvest ignored every one of them`;
    }
    if (unbound) {
      return `Findings: none crossed the threshold — note ${unbound} of ${total} evidence line(s) are UNBOUND and were ignored by harvest`;
    }
    return "Findings: none — nothing in this issue crossed the threshold for a factory finding";
  }
  const routed = classified.findings.filter((f) => f.disposition === "routed").length;
  const note = unbound ? ` · ${unbound} of ${total} record line(s) UNBOUND and ignored` : "";
  return `Findings · ${n} (${routed} the retro would route) — the same classification the retro applies on merge${note}`;
}

function renderFindings(classified) {
  const L = [];
  if (classified.skipped) { L.push(`   ${classified.skipped}`); return L; }
  for (const f of classified.findings) {
    if (f.error) { L.push(`   [!] ${f.kind}: ${f.error}`); continue; }
    const tags = f.tags.length ? f.tags.map((t) => `[${t}]`).join("") : "[untagged]";
    L.push(`   ${tags} ${f.kind}${f.role ? ` (${f.role})` : ""} — ${f.reason ?? ""}`);
    L.push(`       causal: ${f.causal.path ?? "?"}${f.causal.line ? `:${f.causal.line}` : ""}${f.causal.locus ? ` ${f.causal.locus}` : ""} · owner=${f.causal.owner ?? "unknown"} · ${f.confidence} confidence · ${f.disposition}`);
    if (f.attribution.length) L.push(`       attribution: ${f.attribution.join(", ")}`);
    for (const c of f.chain) L.push(`       chain: ${c}`);
    if (f.candidates) L.push(`       candidates: ${JSON.stringify(f.candidates)}`);
    L.push(`       fingerprint: ${f.fingerprint}`);
  }
  return L;
}

// ── 읽기 ──────────────────────────────────────────────────────────────────────────────────────

/**
 * 이 이슈의 런 기록 전문. 세 경로를 순서대로 시도하고 **첫 성공을 쓴다**:
 *   ① `gh api repos/<repo>/contents/<dir>/<issue>.md?ref=factory/records` — records 브랜치를 로컬에
 *      클론하지 않아도 되는 유일한 경로다(이 명령의 자리는 노트북이다).
 *   ② `readRecords` — 저장소 클론이 있으면 브랜치를 fetch해 읽는다(`status.js`와 같은 경로).
 *   ③ 로컬 작업본 `docs/factory/runs/<issue>.md` — 기록이 아직 브랜치로 안 나간 런.
 * 셋 다 실패하면 빈 텍스트다. 절대 던지지 않는다 — 기록이 없어도 코멘트 쪽 타임라인은 낸다.
 */
export async function readRecordFor({ run, repo, root, issue, branch = RECORDS_BRANCH, dir = RECORDS_DIR }) {
  if (repo) {
    try {
      const r = await run("gh", ["api", `repos/${repo}/contents/${dir}/${issue}.md?ref=${branch}`, "--jq", ".content"]);
      // `--jq .content`는 파일이 없으면 비거나(404) 디렉터리/심볼릭 링크면 `null`을 찍는다 —
      // 그 네 글자를 base64로 풀면 조용히 쓰레기가 된다(리뷰 nit 8). 문자열 "null"도 거른다.
      const raw = r.code === 0 ? r.stdout.trim() : "";
      if (raw && raw !== "null") {
        const text = Buffer.from(raw.replace(/\s/g, ""), "base64").toString("utf8");
        if (text.trim()) return { text, source: `${branch}:${dir}/${issue}.md (gh api)`, trusted: true };
      }
    } catch { /* 다음 경로 */ }
  }
  try {
    const recs = await readRecords({ run, cwd: root, branch, dir });
    const text = recs?.get?.(String(issue)) ?? "";
    if (text.trim()) return { text, source: `${branch} (fetched)`, trusted: true };
  } catch { /* 다음 경로 */ }
  try {
    const local = join(root, dir, `${issue}.md`);
    if (existsSync(local)) {
      const text = readFileSync(local, "utf8");
      /**
       * 리뷰 SF-7 — 이 사본은 **신뢰 앵커가 아니다**. `docs/factory/runs/**`는 no-write 스테이지의
       * 스크래치 경로라 에이전트 세션이 줄을 덧붙일 수 있고, 브랜치로 나가기 전이라 오래됐을 수도
       * 있다. 그래서 읽되 `trusted:false`로 표시하고, 보고는 그 사실을 화면에 적는다.
       */
      if (text.trim()) return { text, source: `${dir}/${issue}.md (local working tree)`, trusted: false };
    }
  } catch { /* 아래 */ }
  return { text: "", source: "none", trusted: true };
}

/**
 * `--health` — Task 4의 집계를 **지연 import**한다. T4와 이 명령은 병렬로 만들어졌으므로, 그 파일이
 * 아직(또는 이 버전에) 없을 수 있다. 그때 이 명령 전체가 죽으면 안 된다: `analyze <issue>`는 T4와
 * 아무 상관이 없다. 그래서 import는 `--health`를 실제로 부를 때에만 일어나고, 실패는 **사람이 다음에
 * 무엇을 할 수 있는지까지 말해 주는 한 줄**로 떨어진다.
 */
async function healthReport({ root, argv, io, run, importHealth }) {
  let mod;
  try { mod = await importHealth(); }
  catch (e) {
    io.err(`factory analyze --health: the health aggregation (factory/bin/health.js) is not available in this install — ${e?.message || e}`);
    io.err("  it ships with the factory feedback loop; upgrade know-thy-build to get it.");
    io.err("  meanwhile `factory analyze <issue>` reconstructs a single issue's timeline and needs nothing from it.");
    return 1;
  }
  const entry = mod?.healthCommand ?? mod?.runHealth ?? mod?.healthReport ?? null;
  if (typeof entry !== "function") {
    io.err("factory analyze --health: factory/bin/health.js is installed but exposes no entry point this version knows (healthCommand / runHealth / healthReport).");
    io.err("  known-good pairing ships together — upgrade know-thy-build so the CLI and the aggregation match.");
    io.err("  `factory analyze <issue>` is unaffected.");
    return 1;
  }
  const code = await entry({ root, argv: argv.filter((a) => a !== "--health"), io, run });
  return Number.isInteger(code) ? code : 0;
}

// ── 명령 ──────────────────────────────────────────────────────────────────────────────────────

export const ANALYZE_USAGE = [
  "usage: factory analyze <issue> [--json]",
  "       factory analyze --health [--json]",
  "",
  "  <issue>    print that issue's stage-by-stage timeline from the records branch and its comments:",
  "             artifact, gates + per-gate failure detail, self-gate, role context, review verdicts and",
  "             must_fix, transitions (with refusals), cost per stage and per agent — then the findings",
  "             classified exactly as the retro classifies them on merge. Read-only.",
  "  --health   run the health aggregation over recent issues and print its report.",
  "  --json     emit the same data as machine-readable JSON.",
].join("\n");

export async function analyzeCommand({
  root, argv = [], io, run = realRun,
  gh = null, repo = null, harness = null,
  readRecord = null, loadManifest = loadInstallManifest,
  factoryLogins = undefined,
  importHealth = () => import("../bin/health.js"),
} = {}) {
  const json = argv.includes("--json");
  const rest = argv.filter((a) => !a.startsWith("-"));

  if (argv.includes("--help") || argv.includes("-h")) { io.out(ANALYZE_USAGE); return 0; }
  if (argv.includes("--health")) {
    // 리뷰 nit 9 — `analyze 39 --health`는 두 명령을 한 줄에 적은 것이다. 이슈를 조용히 버리면
    // 사람은 #39의 건강 보고를 받았다고 믿는다(그런 것은 없다). 섞였으면 거절한다.
    if (rest.length) { io.err(`factory analyze: --health takes no issue (got "${rest[0]}") — it aggregates across issues.\n${ANALYZE_USAGE}`); return 1; }
    return healthReport({ root, argv, io, run, importHealth });
  }

  if (!rest.length) { io.err(ANALYZE_USAGE); return 1; }
  if (!/^#?\d+$/.test(rest[0])) { io.err(`factory analyze: "${rest[0]}" is not an issue number.\n${ANALYZE_USAGE}`); return 1; }
  const issue = Number(rest[0].replace(/^#/, ""));

  const theRepo = repo || await resolveRepo({ run });
  const ghClient = gh || makeGh({ run, repo: theRepo });

  let comments = [];
  try { comments = await ghClient.comments(issue); }
  catch (e) { io.err(`factory analyze: could not read #${issue}'s comments — ${e?.message || e}`); return 1; }

  const rec = readRecord ? await readRecord({ issue, repo: theRepo, root, run }) : await readRecordFor({ run, repo: theRepo, root, issue });

  // CHARTER/harness가 없거나 깨진 저장소에서도 죽지 않는다 — 읽기 전용 보고다(`status.js`와 같은 규칙).
  let theHarness = harness;
  if (theHarness === null) { try { theHarness = loadHarness(root); } catch { theHarness = null; } }

  /**
   * `human-decision:v1`을 **권한**으로 읽으려면 작성자가 봇인지 알아야 한다(T3 재리뷰 NEW-MF-2).
   *
   * ── T5 리뷰 MF-1 ─────────────────────────────────────────────────────────────────────────
   * 이 명령의 자리는 **노트북**이고, 거기서 `gh api user`는 봇이 아니라 **소유자**를 돌려준다.
   * 1차 구현은 그 값을 팩토리 계정으로 셌고, 그래서 소유자가 직접 적은 `human-decision:v1`이
   * "에이전트가 쓴 결정"으로 기각돼 데모 #39의 `[ktb]` 발견 둘이 통째로 사라졌다. 고친 자리는
   * 여기가 아니라 `lib/gh.js`다(판정이 한 곳이어야 회고와 갈라지지 않는다) — 이 호출이 넘기는
   * `comments`가 그 함수에 **하트비트 작성자**라는 출처를 준다: 하트비트는 러너만 쓰므로
   * 노트북에서도 봇 이름을 정확히 알 수 있다.
   *
   * 그래도 못 알아내면 `null`을 넘긴다 — `[]`가 아니다: 봇 이름을 모르는 것은 "봇이 없다"가
   * 아니므로 그 증거 통로를 닫는 쪽이 옳다. 그리고 그 사실을 **화면에 적는다**: 조용히 닫으면
   * 사람은 발견 0건을 "깨끗한 런"으로 읽는다.
   */
  let logins = factoryLogins;
  let loginNote = null;
  if (logins === undefined) {
    const who = await resolveFactoryLogins({ gh: ghClient, comments });
    logins = who.ok ? who.logins : null;
    if (!who.ok) loginNote = `factory logins unresolved (${who.reason}) — human-decision evidence cannot be evaluated, so no self-gate or transition-refused finding can reach [ktb] (the retro refuses it the same way)`;
  }
  if (loginNote) io.err(`factory analyze: ${loginNote}`);

  const tl = buildTimeline({ issue, repo: theRepo, record: rec.text, comments });
  tl.record_source = rec.source;
  tl.record_trusted = rec.trusted !== false;
  tl.factory_logins = logins;
  if (loginNote) tl.factory_logins_note = loginNote;

  let raw = [];
  try { raw = harvestFindings({ issue, repo: theRepo, record: rec.text, comments, factoryLogins: logins }); }
  catch (e) { io.err(`factory analyze: harvest failed — ${e?.message || e}`); }

  const manifest = await loadManifest(root);
  const classified = classifyAll({ findings: raw, manifest, harness: theHarness });

  if (json) {
    io.out(JSON.stringify({
      schema: "factory.analyze.v1",
      ...tl,
      findings: classified.findings,
      ...(classified.skipped ? { findings_skipped: classified.skipped } : {}),
      ktb_version: manifest?.ktb_version ?? manifest?.ktbVersion ?? null,
    }, null, 2));
    return 0;
  }

  const rendered = renderTimeline(tl, classified, { factoryLogins: logins, recordSource: rec.source, recordTrusted: tl.record_trusted, loginNote });
  for (const line of rendered) io.out(line);
  io.out("");
  io.out(`record: ${rec.source}`);
  return 0;
}
