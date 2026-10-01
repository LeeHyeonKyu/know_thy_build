import { neverAutomateHits } from "./verify-stage.js";

/**
 * 설계 2026-09-30 §8.2 (S2) — **큐 진입 심사: job의 형식과 상한으로, 제출자로가 아니라.**
 *
 * 큐 진입은 누구나 할 수 있다(§8.1 — 사람, 에이전트 세션, 공장 자신). 그래서 문은 하나여야 하고 그 문은 네 가지만 본다:
 *   1. **명시적으로 설계된 job인가** — 본문에 `done_when`이 있거나 공장이 쓴 마커가 있다(개선·하네스·flaky).
 *   2. **NEVER_AUTOMATE** — Impact paths가 CHARTER의 글롭에 걸리면 지금 거부한다. 예전에는 triage 뒤에야 스크립트가 `wont-do`로
 *      덮었다(L47): 이슈를 쓰고 큐에 넣은 뒤에야 알게 되는 것은 triage 한 번과 대기 시간을 버리는 일이다.
 *   3. **큐 길이**(`back_pressure.queue_max`) — 외부 에이전트의 큐 홍수. `awaiting_review_max`는 리뷰 대기 수지 큐 길이가 아니다.
 *   4. **자기생성 이슈의 상한**(`self_generated.open_max`, `depth_max`) — 실측 증식률(캠페인 28머지 → 자기생성 7 = 0.25/머지)에서
 *      루프는 이미 수렴한다. 이 상한은 지문 드리프트 같은 결함에 대한 보험이다. 자기생성인지는 **러너가 쓴 마커와 작성 계정**으로
 *      판정한다 — 제출자의 자기 신고(`by=`)가 아니다.
 *
 * 리허설(ADR-025)과 같은 자리에서, 같은 방식(배선된 검사기, fail closed)으로 돈다. 상한 상수는 CHARTER에 있고 사람만 고친다.
 */
export const SELF_GENERATED_DEFAULTS = { open_max: 5, depth_max: 1, per_merge_max: 2, queue_max: 8 };

const IMPROVEMENT_RE = /<!-- factory-improvement fp=\S+(?: tags=\S*)? from=([\w.-]+\/[\w.-]+)#(\d+) -->/;
const HARNESS_RE = /<!-- factory-harness-request for=(\d+) -->/;
const FLAKY_RE = /Detected while implementing #(\d+)\./;
const DONE_WHEN_RE = /^#{2,3}\s*done[_ ]when\b|^done_when:/im;

const labelsOf = (issue) => (Array.isArray(issue?.labels) ? issue.labels : []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);

/** 공장이 만든 이슈인가 — 마커(개선·하네스·flaky) 또는 작성 계정이 팩토리 계정. */
export function isSelfGenerated(issue, factoryLogins = []) {
  const body = String(issue?.body ?? "");
  if (IMPROVEMENT_RE.test(body) || HARNESS_RE.test(body) || FLAKY_RE.test(body)) return true;
  if (labelsOf(issue).some((l) => l === "factory-improvement" || l === "factory:flaky" || l === "factory:harness")) return true;
  const author = typeof issue?.author === "string" ? issue.author.toLowerCase() : "";
  return !!author && (Array.isArray(factoryLogins) ? factoryLogins : []).some((l) => String(l).toLowerCase() === author);
}

/** 자기생성 이슈의 기원 — 공장이 쓰는 세 가지 마커 모양. 없으면 null(발명하지 않는다). */
export function originOf(issue) {
  const body = String(issue?.body ?? "");
  let m;
  if ((m = IMPROVEMENT_RE.exec(body))) return { repo: m[1], number: Number(m[2]) };
  if ((m = HARNESS_RE.exec(body))) return { repo: null, number: Number(m[1]) };
  if ((m = FLAKY_RE.exec(body))) return { repo: null, number: Number(m[1]) };
  return null;
}

/** `## Impact paths` 절의 백틱 경로만. 다른 절의 백틱은 경로가 아니다. */
export function impactPathsOf(body) {
  const text = String(body ?? "");
  const m = /^##\s+Impact paths.*$/m.exec(text);
  if (!m) return [];
  const section = text.slice(m.index + m[0].length).split(/^##\s+/m)[0];
  const out = [];
  for (const tok of section.matchAll(/`([^`\n]+)`/g)) {
    const p = tok[1].trim();
    if (/^[\w.*/@{}!,[\]-]+$/.test(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * 순수 심사. 입력은 전부 호출자가 모아 온다(테스트가 붙는다).
 *   issue: {number, body, labels, author} · queued: 큐 라벨을 가진 이슈들 · openSelfGenerated: 진행 중인 자기생성 이슈들
 *   byNumber(n): 기원 이슈를 돌려준다(없으면 null) · factoryLogins: 팩토리 계정 이름들
 */
export function queueAdmission({ issue, charter, queued = [], openSelfGenerated = [], byNumber = () => null, factoryLogins = [] }) {
  const caps = { ...SELF_GENERATED_DEFAULTS, ...(charter?.self_generated || {}) };
  const queueMax = Number.isInteger(charter?.back_pressure?.queue_max) ? charter.back_pressure.queue_max : caps.queue_max;
  const reasons = [];
  const self = isSelfGenerated(issue, factoryLogins);
  const body = String(issue?.body ?? "");

  if (!self && !DONE_WHEN_RE.test(body)) reasons.push("not an explicit job: the body has no `done_when` section (and no factory marker)");

  const hits = neverAutomateHits(impactPathsOf(body), charter?.never_automate ?? []);
  if (hits.length) reasons.push(`NEVER_AUTOMATE: ${hits.map((h) => `${h.path} (glob ${h.glob})`).join(", ")} — this issue would end wont-do; split the automatable part or let a person fix it`);

  if (queued.length >= queueMax) reasons.push(`queue ${queued.length} ≥ ${queueMax} (back_pressure.queue_max)`);

  if (self) {
    const open = openSelfGenerated.filter((o) => o?.number !== issue?.number);
    if (open.length >= caps.open_max) reasons.push(`self-generated open ${open.length} ≥ ${caps.open_max} (self_generated.open_max)`);
    // 세대: 기원을 따라 올라가며 자기생성인 조상을 센다. 기원을 못 찾으면 거기서 멈춘다(모르는 세대를 발명하지 않는다).
    // #136 (S2b) — **하네스 요청은 세대를 더하지 않는다**(설계 §8.2 표: "개선→하네스→flaky 사슬을 한 세대로 센다"). 하네스 요청은
    // 새 일이 아니라 그 피처를 끝내는 데 필요한 것이다; 이것을 세면 depth_max=1이 자기생성 피처(flaky·개선)의 하네스 요청을 영구히
    // 거부한다. 면제는 두 칸뿐이다: (a) 하네스 마커를 단 노드 자신, (b) **하네스 이슈를 구현하다 수확한 flaky**(기원이 flaky
    // 마커이고 그 부모가 하네스 요청) — 표가 이름으로 부른 "개선→하네스→flaky" 사슬이 한 세대가 되려면 둘 다 접혀야 한다.
    // 개선의 개선, 개선에서 바로 나온 flaky, 접힌 사슬 위에서 공장이 다시 만든 개선은 여전히 한 세대씩 더한다. 부모를 읽지
    // 못하면 접을 근거가 없으니 한 세대로 센다(발명하지 않는다).
    // rework cf1 — **접기는 사슬 하나에 한 번이다.** 접힌 flaky(하네스 아래의 flaky)를 위한 하네스는 접히지 않는다: 그것은 표가 부른
    // 사슬의 연장이 아니라 그 위에 새로 선 사슬이고, 한 세대를 연다. 그렇지 않으면 flaky→하네스→flaky→하네스→… 가 끝없이 1세대로
    // 남아 depth_max가 영영 걸리지 않는다. 그 새 하네스 아래의 flaky는 다시 그 하네스의 세대에 접힌다(사슬마다 한 세대).
    const isHarness = (it) => HARNESS_RE.test(String(it?.body ?? ""));
    const flakyOnly = (it) => { const b = String(it?.body ?? ""); return FLAKY_RE.test(b) && !IMPROVEMENT_RE.test(b) && !HARNESS_RE.test(b); };
    const foldedFlaky = (it) => { if (!flakyOnly(it)) return false; const o = originOf(it); return !!o && isHarness(byNumber(o.number)); };
    const gen = (it) => {
      if (isHarness(it)) { const o = originOf(it); return o && foldedFlaky(byNumber(o.number)) ? 1 : 0; }
      if (foldedFlaky(it)) return 0;
      return 1;
    };
    let depth = gen(issue), cur = originOf(issue), hops = 0;
    while (cur && hops++ < 10) {
      const parent = byNumber(cur.number);
      if (!parent || !isSelfGenerated(parent, factoryLogins)) break;
      depth += gen(parent);
      cur = originOf(parent);
    }
    if (depth > caps.depth_max) reasons.push(`self-generated generation ${depth} > ${caps.depth_max} (self_generated.depth_max) — an issue the factory made from an issue the factory made`);
  }
  return { ok: reasons.length === 0, reasons, self_generated: self };
}

const ACTIVE = ["factory:queue", "factory:ready", "factory:planned", "factory:in-progress", "factory:rework", "factory:awaiting-review", "factory:approved", "factory:blocked"];

/**
 * gh로 입력을 모아 `queueAdmission`을 부르는 검사기. `transition({ admission })`에 배선한다.
 * 어떤 입력이든 읽지 못하면 거부다(fail closed) — 리허설 검사기와 같은 규칙. 절대 throw하지 않는다.
 */
export function makeQueueAdmission({ gh, charter, factoryLogins = null }) {
  return async ({ issue }) => {
    try {
      const it = await gh.issue(issue);
      let logins = [];
      if (typeof factoryLogins === "function") { try { const lg = await factoryLogins(); logins = Array.isArray(lg?.logins) ? lg.logins : []; } catch { logins = []; } }
      const queued = await gh.searchIssues("factory:queue");
      // 진행 중인 자기생성 이슈: 공장 라벨을 가진 열린 이슈 가운데 자기생성인 것. 본문을 읽어야 하므로 후보를 라벨로 먼저 좁힌다.
      const candidates = new Map();
      for (const label of ["factory-improvement", "factory:flaky", "factory:harness"]) {
        for (const c of await gh.searchIssues(label)) candidates.set(c.number, c);
      }
      const openSelfGenerated = [];
      for (const c of candidates.values()) {
        if (c.number === it.number) continue;
        const full = await gh.issue(c.number);
        if (labelsOf(full).some((l) => ACTIVE.includes(l)) && isSelfGenerated(full, logins)) openSelfGenerated.push({ number: c.number });
      }
      const cache = new Map();
      const byNumber = (n) => cache.get(n) ?? null;
      // 기원 사슬은 최대 10단 — 심사 전에 미리 읽어 둔다(순수 함수는 동기다).
      let cur = originOf(it), hops = 0;
      while (cur && hops++ < 10 && !cache.has(cur.number)) {
        let parent = null;
        try { parent = await gh.issue(cur.number); } catch { parent = null; }
        cache.set(cur.number, parent);
        if (!parent) break;
        cur = originOf(parent);
      }
      return queueAdmission({ issue: it, charter, queued, openSelfGenerated, byNumber, factoryLogins: logins });
    } catch (e) {
      return { ok: false, reasons: [`queue admission could not be read — ${e?.message || e}`], self_generated: null };
    }
  };
}
