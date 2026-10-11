import { neverAutomateHits } from "./verify-stage.js";

/**
 * 설계 2026-09-30 §8.2 (S2) — **큐 진입 심사: job의 형식과 상한으로, 제출자로가 아니라.**
 *
 * 큐 진입은 누구나 할 수 있다(§8.1 — 사람, 에이전트 세션, 공장 자신). 그래서 문은 하나여야 하고 그 문은 네 가지만 본다:
 *   1. **명시적으로 설계된 job인가** — 본문에 `done_when`이 있거나, 공장 라벨이 있거나, 공장 마커(개선·하네스·flaky)가 있고
 *      **그 이슈를 공장 로그인이 열었다**(#231 — 마커는 본문이라 누구나 붙여 넣을 수 있다; `doneWhenExemption`).
 *   2. **NEVER_AUTOMATE** — Impact paths가 CHARTER의 글롭에 걸리면 지금 거부한다. 예전에는 triage 뒤에야 스크립트가 `wont-do`로
 *      덮었다(L47): 이슈를 쓰고 큐에 넣은 뒤에야 알게 되는 것은 triage 한 번과 대기 시간을 버리는 일이다.
 *   3. **큐 길이**(`back_pressure.queue_max`) — 외부 에이전트의 큐 홍수. `awaiting_review_max`는 리뷰 대기 수지 큐 길이가 아니다.
 *   4. **자기생성 이슈의 상한**(`self_generated.open_max`, `depth_max`) — 실측 증식률(캠페인 28머지 → 자기생성 7 = 0.25/머지)에서
 *      루프는 이미 수렴한다. 이 상한은 지문 드리프트 같은 결함에 대한 보험이다. 자기생성인지는 **러너가 쓴 마커와 작성 계정**으로
 *      판정한다 — 제출자의 자기 신고(`by=`)가 아니다. 상한의 판정(`isSelfGenerated`)은 넓은 쪽(마커 또는 라벨 또는 공장 작성자)
 *      그대로다(#231 plan non_goals[1]): 좁히면 공장이 사람 계정(PAT 폴백)으로 연 이슈가 세지지 않아 증식 상한이 조용히 풀린다.
 *      다만 저장소 소유자 로그인은 작성자 갈래에서 뺀다(`capFactoryLogins`) — 공유 계정(PAT 폴백)에서 소유자의 사람 일이 상한에 막히지 않게.
 *
 * 리허설(ADR-025)과 같은 자리에서, 같은 방식(배선된 검사기, fail closed)으로 돈다. 상한 상수는 CHARTER에 있고 사람만 고친다.
 */
export const SELF_GENERATED_DEFAULTS = { open_max: 5, depth_max: 1, per_merge_max: 2, queue_max: 8 };

const IMPROVEMENT_RE = /<!-- factory-improvement fp=\S+(?: tags=\S*)? from=([\w.-]+\/[\w.-]+)#(\d+) -->/;
const HARNESS_RE = /<!-- factory-harness-request for=(\d+) -->/;
const FLAKY_RE = /Detected while implementing #(\d+)\./;
const DONE_WHEN_RE = /^#{2,3}\s*done[_ ]when\b|^done_when:/im;

const labelsOf = (issue) => (Array.isArray(issue?.labels) ? issue.labels : []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
const hasFactoryMarker = (issue) => { const body = String(issue?.body ?? ""); return IMPROVEMENT_RE.test(body) || HARNESS_RE.test(body) || FLAKY_RE.test(body); };
const hasFactoryLabel = (issue) => labelsOf(issue).some((l) => l === "factory-improvement" || l === "factory:flaky" || l === "factory:harness");
const authorOf = (issue) => (typeof issue?.author === "string" && issue.author.trim() ? issue.author.trim() : null);
const isFactoryLogin = (login, factoryLogins) => !!login && (Array.isArray(factoryLogins) ? factoryLogins : []).some((l) => String(l).toLowerCase() === login.toLowerCase());

/**
 * 공장이 만든 이슈인가 — 마커(개선·하네스·flaky) **또는** 공장 라벨 **또는** 작성 계정이 팩토리 계정.
 * **상한(open_max·depth_max)·진행 중 자기생성 수·기원 사슬**이 쓰는 넓은 판정이다. #231은 이것을 좁히지 않는다: 공장이 소유자 PAT으로
 * 연 이슈(ADR-038 폴백)와 마커만 남은 옛 이슈도 상한에는 세져야 한다 — 좁히면 증식 상한이 조용히 풀린다(fail open).
 * done_when 면제는 더 좁은 `doneWhenExemption`이 따로 판정한다.
 */
export function isSelfGenerated(issue, factoryLogins = []) {
  if (hasFactoryMarker(issue)) return true;
  if (hasFactoryLabel(issue)) return true;
  return isFactoryLogin(authorOf(issue), factoryLogins);
}

const NO_DONE_WHEN = "not an explicit job: the body has no `done_when` section";

/**
 * #231 (허점 원장 E-6) — **done_when 없이 들어갈 수 있는가.** 본문 마커는 본문이라 누구나 붙여 넣을 수 있다 — 마커 한 줄로
 * done_when 요구가 면제되면 "제출자의 자기 신고가 아니다"가 거짓이 된다. 그래서:
 *   - 공장 라벨(`factory-improvement`·`factory:flaky`·`factory:harness`)은 그대로 면제한다 — 소비자 저장소의 공장이 연 개선 이슈와
 *     PAT 폴백으로 열린 flaky 이슈는 작성자가 이 저장소의 공장 로그인이 아니다. 라벨 경로를 좁히는 것은 이 이슈의 범위가 아니다.
 *   - 마커는 **작성자가 공장 로그인일 때만** 면제한다. 작성자를 읽지 못했거나 공장 로그인을 알아내지 못했으면 면제하지 않는다(닫힌 쪽).
 *   - 마커 없는 공장 작성자는 면제하지 않는다 — 에이전트 세션도 같은 계정으로 이슈를 쓴다.
 * 알려진 한계: 공장이 소유자 계정으로 도는 저장소(PAT 폴백)에서는 소유자가 곧 공장 로그인이라 사람과 에이전트를 가를 수 없다.
 * 반환하는 `why`는 거부 이유 문장 그대로다 — 사람이 그 문장만 보고 done_when을 쓸지, 로그인 조회를 고칠지 알 수 있어야 한다.
 */
export function doneWhenExemption(issue, factoryLogins = [], { loginsResolved = Array.isArray(factoryLogins) && factoryLogins.length > 0 } = {}) {
  if (hasFactoryLabel(issue)) return { exempt: true, why: null };
  if (!hasFactoryMarker(issue)) return { exempt: false, why: `${NO_DONE_WHEN} (and no factory marker)` };
  const author = authorOf(issue);
  const only = "a marker exempts only an issue the factory itself opened";
  if (!author) return { exempt: false, why: `${NO_DONE_WHEN}; it carries a factory marker but the author could not be read — ${only}, so add a \`done_when\` section` };
  // #249 — `unreadable`: 이 거부는 이슈의 사실이 아니라 읽지 못한 로그인이다(`queueAdmission`이 코드를 `unreadable`로 단다).
  if (!loginsResolved) return { exempt: false, why: `${NO_DONE_WHEN}; it carries a factory marker but the factory logins could not be resolved, so author \`${author}\` cannot be checked — fix the login lookup (FACTORY_BOT_LOGIN) or add a \`done_when\` section`, unreadable: true };
  if (isFactoryLogin(author, factoryLogins)) return { exempt: true, why: null };
  return { exempt: false, why: `${NO_DONE_WHEN}; it carries a factory marker but its author \`${author}\` is not a factory login — ${only}, so add a \`done_when\` section` };
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

const PATH_CHARS_RE = /^[\w.*/@{}!,[\]-]+$/;
/** 목록 항목 — 글머리표(`-`·`*`·`+`)와 번호(`1.`·`1)`). */
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])[ \t]+(.*)$/;
/** 점이 든 산문 약어(`e.g`·`i.e`) — 경로 모양이지만 경로가 아니다. */
const ABBREV_RE = /^(?:[a-z]\.)+[a-z]?$/i;
/** 버전 번호(`v1.2`·`2.0.1`) — 경로 모양이지만 경로가 아니다(self-critique, #231). */
const VERSION_RE = /^v?\d+(?:\.\d+)+$/i;

/**
 * `## Impact paths`(또는 `###`) 절의 경로. 다른 절의 백틱은 경로가 아니다 — 절은 다음 `#`·`##`·`###` 제목에서 끝난다.
 * #231 (허점 원장 E-5) — 예전에는 백틱 안 토큰만 읽어서, 백틱 없이 쓴 목록(`:issue` 템플릿이 그랬다)·`###` 제목·공백이 섞인
 * 백틱은 빈 배열이 됐고 NEVER_AUTOMATE 조기 차단이 아무 경로도 보지 못했다. 이제:
 *   - 백틱 토큰은 어디에 있든 전부 읽는다(공백이 섞이면 공백으로 나눠 각각). 백틱은 쓴 사람이 "이것은 경로다"라고 말한 것이므로
 *     `/`·`.` 모양 검사는 하지 않는다(`Dockerfile`도 경로다) — 예전 규칙 그대로다.
 *   - 목록 항목(`- `·`* `·`+ `·`1. `·`1) `)은 백틱 밖의 글도 읽는다: 백틱 구간을 떼고, 경로 문자가 아닌 글자(공백·쉼표·괄호·
 *     따옴표·한글 조사·`、`…)에서 끊은 **모든** 조각 중 경로 모양(`/`나 `.`을 포함하고 `e.g`·`i.e` 같은 약어가 아닌 것)만 받는다 —
 *     산문 항목(`- 없음`, `- none`)을 경로로 읽지 않기 위해서다. 끝의 `,`·`.`·`;`·`:`는 떼고, `**굵게**`로 감싼 조각은 속도 읽는다.
 *     괄호는 버리지 않고 끊는 자리일 뿐이다: `(신규)` 설명은 경로 모양이 아니라 떨어지고, `(templates/x.toml)`·`[링크](a/b.toml)`의
 *     경로는 읽힌다. 조사가 붙은 `a/b.toml에서`도 `a/b.toml`이 된다(self-critique, #231).
 *   - 절의 끝을 찾을 때 코드 펜스(```·~~~) 안의 `# …` 줄은 제목이 아니다.
 * 넓게 읽는 쪽은 fail closed 쪽이다: 경로를 더 보면 거부가 늘 뿐이다.
 */
export function impactPathsOf(body) {
  const text = String(body ?? "");
  const m = /^#{2,3}[ \t]+Impact paths.*$/m.exec(text);
  if (!m) return [];
  const lines = [];
  let fence = false;
  // rework cf1·qa1 — 웹 UI로 쓴 본문은 CRLF다: `\r`이 남으면 LIST_ITEM_RE의 `(.*)$`가 맞지 않아 백틱 없는 항목이 사라진다.
  for (const line of text.slice(m.index + m[0].length).split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) fence = !fence;
    else if (!fence && /^#{1,3}\s/.test(line)) break;
    lines.push(line);
  }
  const out = [];
  const keep = (raw, { shaped }) => {
    const p = String(raw).trim().replace(/[,.;:]+$/, "");
    if (!p || !PATH_CHARS_RE.test(p)) return;
    if (shaped && (!/[/.]/.test(p) || ABBREV_RE.test(p) || VERSION_RE.test(p))) return;
    if (!out.includes(p)) out.push(p);
  };
  for (const line of lines) {
    for (const t of line.matchAll(/`([^`\n]+)`/g)) for (const tok of t[1].trim().split(/\s+/)) keep(tok, { shaped: false });
    const item = LIST_ITEM_RE.exec(line);
    if (!item) continue;
    const plain = item[1].replace(/`[^`\n]*`/g, " ");
    for (const tok of plain.split(/[^\w.*/@{}!\[\]-]+/)) {
      // `**굵게**`는 속만 읽는다 — 별표째로 받으면 `**a/b.toml**`이라는 찌꺼기 항목이 함께 나온다(self-critique, #231)
      const bold = /^(\*\*|__)([^/].*[^/])\1$/.exec(tok);
      keep(bold ? bold[2] : tok, { shaped: true });
    }
  }
  return out;
}

/**
 * 순수 심사. 입력은 전부 호출자가 모아 온다(테스트가 붙는다).
 *   issue: {number, body, labels, author} · queued: 큐 라벨을 가진 이슈들 · openSelfGenerated: 진행 중인 자기생성 이슈들
 *   byNumber(n): 기원 이슈를 돌려준다(없으면 null) · factoryLogins: 팩토리 계정 이름들
 *   factoryLoginsResolved: 그 이름들을 실제로 알아냈는가(생략하면 목록이 비었는지로 본다) — #231의 거부 이유를 가른다
 *   repoOwner: 저장소 소유자 로그인 — 상한의 작성자 갈래에서 뺀다(`capFactoryLogins`)
 */
export function queueAdmission({ issue, charter, queued = [], openSelfGenerated = [], byNumber = () => null, factoryLogins = [], factoryLoginsResolved = undefined, repoOwner = null }) {
  const caps = { ...SELF_GENERATED_DEFAULTS, ...(charter?.self_generated || {}) };
  const queueMax = Number.isInteger(charter?.back_pressure?.queue_max) ? charter.back_pressure.queue_max : caps.queue_max;
  const reasons = [];
  // #230 — 사유마다 구조화된 코드 하나(같은 순서). 호출자는 사유 문구를 정규식으로 되읽지 않고 이것으로 가른다(`entryRecheck`).
  const codes = [];
  const refuse = (code, reason) => { codes.push(code); reasons.push(reason); };
  // rework spec1 — 세 상한 입력(이 이슈, openSelfGenerated, 기원 사슬)은 plan non_goals[1]의 판정(마커 또는 라벨 또는 공장 작성자)을 쓴다.
  const capLogins = capFactoryLogins(factoryLogins, repoOwner);
  const self = isSelfGenerated(issue, capLogins);
  const body = String(issue?.body ?? "");

  // #231 — done_when 면제는 상한의 판정(`self`)보다 좁다: 마커는 공장 로그인이 연 이슈에서만 면제한다(`doneWhenExemption`).
  if (!DONE_WHEN_RE.test(body)) {
    const ex = doneWhenExemption(issue, factoryLogins, factoryLoginsResolved === undefined ? {} : { loginsResolved: !!factoryLoginsResolved });
    // #249 (main 병합) — 로그인을 읽지 못한 거부는 `unreadable`이다: 문은 그대로 거부하지만(fail closed, 같은 문장), triage 진입 재심사가
    // 큐에 있는 공장 이슈를 `gh api` 한 번의 실패로 needs-info로 내리지 않는다(`entryRecheck`).
    if (!ex.exempt) refuse(ex.unreadable ? ADMISSION_CODES.unreadable : ADMISSION_CODES.noDoneWhen, ex.why);
  }

  const hits = neverAutomateHits(impactPathsOf(body), charter?.never_automate ?? []);
  if (hits.length) refuse(ADMISSION_CODES.neverAutomate, `NEVER_AUTOMATE: ${hits.map((h) => `${h.path} (glob ${h.glob})`).join(", ")} — this issue would end wont-do; split the automatable part or let a person fix it`);

  // #247 — 심사받는 이슈 자신은 세지 않는다(아래 open_max의 자기 제외와 같은 규칙). backlog에서 오는 이슈는 이 목록에 없으므로
  // `transition()`·로컬 진입의 판정은 그대로이고, 이미 큐에 있는 이슈의 triage 진입 재심사에서만 차이가 난다 — 꽉 찬 큐의 N번째가
  // 자기 자신을 세어 쫓겨나지 않는다.
  // #247 (skeptic) — 큐에 있는 이슈는 형제 전부가 아니라 **자기보다 앞선 형제**만 센다(이슈 번호 순 — 검색 결과의 순서가 아니라
  // 모든 판정이 같이 보는 순서). 큐는 N+1을 들 수 있다(문의 count-then-write 경합, 손 라벨 — blocked 재시도 hop은 #249 sec1 이후
  // 같은 문의 상한을 지나므로 큐를 넘겨 채우지 않는다). 형제 전부를 세면 그 큐의 **모든** 구성원이 차례로 거부돼 꽉 찬 큐가 통째로 needs-human으로 비워진다. 앞선 형제만 세면 번호 순으로
  // 첫 N개는 언제나 통과하고, 그 뒤에 선 (구성원 수 − N)개만 상한에 걸린다 — 그것이 문을 비켜 들어온 이슈인지는 이 입력으로 알 수 없다.
  const inQueue = queued.some((q) => q?.number === issue?.number);
  const queuedOthers = queued.filter((q) => q?.number !== issue?.number && (!inQueue || Number(q?.number) < Number(issue?.number)));
  if (queuedOthers.length >= queueMax) refuse(ADMISSION_CODES.queueMax, `queue ${queuedOthers.length} ≥ ${queueMax} (back_pressure.queue_max)`);

  if (self) {
    const open = openSelfGenerated.filter((o) => o?.number !== issue?.number);
    if (open.length >= caps.open_max) refuse(ADMISSION_CODES.selfOpenMax, `self-generated open ${open.length} ≥ ${caps.open_max} (self_generated.open_max)`);
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
      if (!parent || !isSelfGenerated(parent, capLogins)) break;
      depth += gen(parent);
      cur = originOf(parent);
    }
    if (depth > caps.depth_max) refuse(ADMISSION_CODES.selfDepth, `self-generated generation ${depth} > ${caps.depth_max} (self_generated.depth_max) — an issue the factory made from an issue the factory made`);
  }
  // 통과한 결과의 모양은 예전 그대로다(`codes`는 거부에만 실린다).
  // #249 (main 병합) — `codes`는 열거되지 않는 속성으로 싣는다: 거부 결과의 열거되는 모양 `{ok, reasons, self_generated}`는 #231·#260이
  // 그대로 핀했고(admission.test.js, 고치지 않는다), 같은 프로세스의 `entryRecheck`는 속성을 직접 읽으므로 코드를 잃지 않는다.
  // 펼치기(`{...a}`)나 JSON을 지나면 코드는 사라지고, 그때 `entryRecheck`는 판정하지 않고 `unreadable`로 둔다(내보내지 않는 쪽).
  const out = { ok: reasons.length === 0, reasons, self_generated: self };
  if (codes.length) Object.defineProperty(out, "codes", { value: codes, enumerable: false });
  return out;
}

/**
 * #230 — 거부 사유의 구조화된 코드. `unreadable`은 판정이 아니다: 입력을 읽지 못했다는 사실이다(fail closed인 문에서는
 * 거부와 같은 결과지만, 이미 큐에 있는 이슈를 내보내는 근거가 될 수는 없다 — `entryRecheck`).
 */
export const ADMISSION_CODES = Object.freeze({
  noDoneWhen: "no-done-when", neverAutomate: "never-automate", queueMax: "queue-max", selfOpenMax: "self-open-max", selfDepth: "self-depth", unreadable: "unreadable",
});

/** 심사 거부를 사람에게 말하는 한 문장 — `transition()`의 큐 문, 로컬 진입, triage 진입이 모두 이 함수로 쓴다(문구가 갈리지 않게). */
export const admissionRefusedReason = (a) => `queue admission refused — ${(Array.isArray(a?.reasons) && a.reasons.length ? a.reasons : [a?.reason || "unknown"]).join("; ")}`;

/**
 * #230 — **triage 진입의 재심사.** 이미 `factory:queue`에 있는 이슈를 에이전트 앞에서 다시 본다(손 라벨·라벨 달고 태어난 이슈·
 * 대기 중 본문 변화 — 어느 길로 왔든 여기서 걸린다). 다시 판정하는 것은 **이슈 자신의 사실**뿐이다:
 *   - `no-done-when` → `factory:needs-info`(본문을 고치면 `needs-info → queue`로 돌아온다)
 *   - `never-automate` → `factory:wont-do`(triage가 같은 사실을 만나면 스크립트가 강제하는 바로 그 상태 — 한 사실에 끝 상태는 하나다)
 * 상한(`queue-max`·`self-open-max`)과 세대(`self-depth`)는 기본으로 다시 보지 않는다: 큐에 들어온 이슈는 형제를 세므로 꽉 찬 큐가
 * 통째로 비워지고, `factory:queue → backlog`는 그래프에 없다(lib/labels.js). 상한은 `transition()`과 로컬 진입의 문에 남는다.
 * #247 — 예외 하나: 호출자가 `{ queueMax: true }`를 주면(triage 진입 — blocked 재시도 hop으로 복구된 진입도 똑같이, #249 sec1) `queue-max`도
 * 다시 본다. `queueAdmission`이 큐에 있는 이슈에게는 번호가 앞선 형제만 세므로(자기 제외 + 순위) 번호 순 첫 N개는 통과하고, 그 뒤에
 * 선 (구성원 수 − N)개만 걸린다 — 문을 비켜 들어온 이슈가 꼭 그것이라는 보장은 없다(`test_247_full_queue_triage_never_evicts_its_first_n_members`). 이슈 자신의 사실이 함께 걸렸으면 그 사실의 상태로 가고, 상한만 걸렸으면 `factory:needs-human` — 고칠 본문(needs-info)도
 * 끝낼 이유(wont-do)도 아니며, triage를 다시 띄우지 않는 `factory:queue`의 출구다. 큐가 비면 사람이 `needs-human → queue`(문이
 * 상한을 다시 잰다)로 되돌린다. `self-open-max`·세대는 묻든 말든 다시 보지 않는다(형제끼리 서로를 쫓아낸다).
 * 읽지 못했으면(`unreadable`, 또는 코드 없는 거부 — 모르는 모양) 판정이 아니다: 호출자는 이슈를 내보내지 않고 재시도 가능한 자리에 세운다.
 * 반환: `{ verdict: "pass" }` | `{ verdict: "refuse", to, reason }` | `{ verdict: "unreadable", reason }`.
 */
const ENTRY_TARGET = { [ADMISSION_CODES.noDoneWhen]: "factory:needs-info", [ADMISSION_CODES.neverAutomate]: "factory:wont-do" };
export function entryRecheck(a, { queueMax = false } = {}) {
  if (!a || typeof a !== "object") return { verdict: "unreadable", reason: `admission returned ${a === null ? "null" : typeof a}` };
  if (a.ok === true) return { verdict: "pass" };
  const reasons = Array.isArray(a.reasons) ? a.reasons : [];
  const codes = Array.isArray(a.codes) ? a.codes : null;
  if (!codes || codes.length !== reasons.length || codes.includes(ADMISSION_CODES.unreadable)) {
    return { verdict: "unreadable", reason: reasons.join("; ") || a.reason || "admission refused without a reason code" };
  }
  const own = codes.map((c, i) => [c, reasons[i]]).filter(([c]) => c in ENTRY_TARGET);
  if (!own.length) {
    const cap = queueMax === true ? codes.indexOf(ADMISSION_CODES.queueMax) : -1;
    return cap === -1 ? { verdict: "pass" } :{ verdict: "refuse", to: "factory:needs-human", reason: admissionRefusedReason({ reasons: [reasons[cap]] }) };
  }
  const to = own.some(([c]) => c === ADMISSION_CODES.neverAutomate) ? ENTRY_TARGET[ADMISSION_CODES.neverAutomate] : ENTRY_TARGET[ADMISSION_CODES.noDoneWhen];
  return { verdict: "refuse", to, reason: admissionRefusedReason({ reasons: own.map(([, r]) => r) }) };
}

/**
 * 상한의 작성자 갈래가 쓰는 공장 로그인 — **저장소 소유자 로그인은 뺀다**(self-critique, #231 dw5 "factory work is not refused").
 * 공장이 소유자 계정으로 도는 저장소(PAT 폴백)에서는 소유자가 공장 로그인 목록에 든다. #231 전에는 gh.issue()가 작성자를 싣지 않아
 * 작성자 갈래가 돈 적이 없었는데, 이제 돌면 소유자의 보통 피처가 전부 자기생성이 되어 open_max에 막히고, 그 피처에서 수확한 flaky는
 * 2세대로 depth_max에 막힌다. 소유자 로그인은 사람과 에이전트를 가를 수 없는 공유 신원이다 — gh.js `identityOf`가 같은 규칙(팩토리
 * 로그인 = 저장소 소유자 → `personal`)으로 작성자 귀속을 끈다. 공장이 연 이슈는 마커·라벨 갈래로 여전히 세지고, 앱·머신 유저 작성자도
 * 그대로 센다. done_when 면제(`doneWhenExemption`)는 이 목록이 아니라 전체 목록을 쓴다(공유 계정의 한계는 plan non_goals[3]로 핀).
 */
function capFactoryLogins(factoryLogins, repoOwner) {
  const all = Array.isArray(factoryLogins) ? factoryLogins : [];
  const owner = typeof repoOwner === "string" && repoOwner.trim() ? repoOwner.trim().toLowerCase() : null;
  return owner ? all.filter((l) => String(l).toLowerCase() !== owner) : all;
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
      // #231 — 작성자는 `gh.issue()`가 함께 싣는다(gh.js). 로그인을 알아내지 못한 것(던짐·ok:false·빈 목록·배선 없음)은
      // "공장 로그인이 아니다"와 다른 거부 이유가 되도록 따로 넘긴다.
      let logins = [], loginsResolved = false;
      if (typeof factoryLogins === "function") { try { const lg = await factoryLogins(); logins = Array.isArray(lg?.logins) ? lg.logins : []; loginsResolved = lg?.ok !== false && logins.length > 0; } catch { logins = []; } }
      const queued = await gh.searchIssues("factory:queue");
      // 진행 중인 자기생성 이슈: 공장 라벨을 가진 열린 이슈 가운데 자기생성인 것. 본문을 읽어야 하므로 후보를 라벨로 먼저 좁힌다.
      const candidates = new Map();
      for (const label of ["factory-improvement", "factory:flaky", "factory:harness"]) {
        for (const c of await gh.searchIssues(label)) candidates.set(c.number, c);
      }
      const repoOwner = typeof gh?.repo === "string" ? gh.repo.split("/")[0] : null;
      const capLogins = capFactoryLogins(logins, repoOwner);
      const openSelfGenerated = [];
      for (const c of candidates.values()) {
        if (c.number === it.number) continue;
        const full = await gh.issue(c.number);
        if (labelsOf(full).some((l) => ACTIVE.includes(l)) && isSelfGenerated(full, capLogins)) openSelfGenerated.push({ number: c.number });
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
      return queueAdmission({ issue: it, charter, queued, openSelfGenerated, byNumber, factoryLogins: logins, factoryLoginsResolved: loginsResolved, repoOwner });
    } catch (e) {
      return { ok: false, reasons: [`queue admission could not be read — ${e?.message || e}`], codes: [ADMISSION_CODES.unreadable], self_generated: null };
    }
  };
}
