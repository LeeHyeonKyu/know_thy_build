import { parseHandoffs } from "../handoff.js";
import { parseHeartbeat } from "../heartbeat.js";
import { runIdOfRunner } from "../run-record.js";
import { GATES_DETAIL_PREFIX } from "../gates.js";
import { CONTEXT_MANIFEST_PREFIX } from "../context.js";
import {
  ACTUALLY_MOVED_TO_NEEDS_HUMAN, allSelfGateFindings, NEEDS_HUMAN_LABEL,
  REFUSAL_REASON, TRANSITION_REFUSED, TRANSITION_TO,
} from "../retro/issue-comments.js";

/**
 * ── Feedback loop Task 3 — **머지된 이슈 하나에서 원시 발견(raw finding)을 뽑는다** (spec §4) ────
 *
 * 순수 함수다: fs도 gh도 시계도 만지지 않는다. 입력은 그 이슈의 run 기록 전문과 이슈 코멘트 전부이고,
 * 출력은 `classifyFinding`(Task 2)이 그대로 먹는 모양의 배열이다 — 여기서는 **아무것도 분류하지
 * 않는다**. 주인을 정하는 규칙은 한 곳(`classify.js`)에만 있어야 하고, 수확이 미리 `harness`/`ktb`를
 * 판단하기 시작하면 그 규칙이 두 벌이 되어 조용히 갈라진다.
 *
 * ## ① 런 바인딩 — 묶이지 않은 줄은 증거가 아니다
 *
 * `docs/factory/runs/**`는 no-write 스테이지의 **스크래치 경로**라 에이전트 세션이 줄을 덧붙일 수 있고
 * (`reviewEvidenceLine`의 batch-2 MF-2가 닫은 바로 그 구멍), `syncRecords`는 그 파일을 있는 그대로
 * `factory/records`로 민다. 곧 `gates-detail:` 한 줄을 손으로 적어 두면 상류 저장소에 이슈가 열린다.
 * 그래서 Task 1은 두 줄에 `run_id`/`runner`를 실었고, 여기서는 **그 이슈에 실제로 돌았던 런**과
 * 맞는 줄만 증거로 센다. "실제로 돌았던 런"의 출처는 run 기록이 아니라 **이슈의 하트비트 코멘트**다
 * (`parseHeartbeat`): 스테이지 런마다 새 코멘트가 하나씩 생기므로 이슈 이력이 곧 런 목록이고,
 * 그 채널은 러너가 직접 쓴다. 하트비트가 하나도 없으면 아무 줄도 믿지 않는다(fail closed):
 * 증거 없이 상류에 이슈를 여는 것보다 이번 머지를 조용히 넘기는 편이 낫다.
 *
 * (한계 — 숨기지 않는다: 하트비트는 공개 코멘트이므로 에이전트가 거기 적힌 러너 이름을 **베껴** 줄을
 * 위조할 수는 있다. 그 마지막 한 칸을 막는 것은 `[protected].runner_only`의 훅/L2 deny이지 이 파서가
 * 아니다. 여기서 막는 것은 "아무 줄이나 증거가 되는" 상태다.)
 *
 * ## ② 무엇이 발견이고 무엇이 아닌가
 *
 * | 소스                   | 발견인 것                                               | 발견이 아닌 것 |
 * |------------------------|---------------------------------------------------------|----------------|
 * | RED 게이트(`gates-detail`) | 게이트가 **이름을 대지 못한** RED, 또는 게이트가 스스로 적은 `reason`(unhandled·broken-base) | 깨진 테스트 이름이 있는 RED — 그건 공장이 제 일을 한 것이다 |
 * | self-gate 차단         | blocking인 것(단, `check: "gates"` 제외 — 위 RED와 같은 원인이다) | advisory(비차단) |
 * | 전이 거부              | **라벨을 실제로 `factory:needs-human`으로 옮긴** 거부      | 다음 라운드가 푼 평범한 거부 |
 * | 리뷰 must_fix          | `where`가 **파일을 지목한** reject 항목                    | 산문 `where` — 이미 lesson 후보다(`retro/harvest.js`) |
 *
 * 이 표의 오른쪽 칸이 이 파일의 절반이다. 머지된 이슈마다 RED 게이트 한 번과 must_fix 몇 개는
 * **정상**이고, 그것을 전부 라우팅하면 루프는 머지마다 이슈를 열어 스스로 무의미해진다(spec §3
 * "harness 발견이 KTB를 덮지 않게 한다"의 같은 논리가 여기서는 *공장이 자기 일을 이슈로 옮기지
 * 않는다*로 나타난다). 남는 것은 **공장이 스스로 만든 라운드**뿐이다.
 *
 * ## ③ 리허설 RED는 여기서 수확하지 않는다
 * 리허설의 판정은 이슈별 run 기록이 아니라 저장소 변수/commit status에 산다(`lib/rehearsal.js`) —
 * 이슈 하나에 귀속되는 durable한 줄이 없다. 저장소 단위 신호이므로 주기적 health 잡(Task 4)의 몫이고,
 * 없는 출처를 여기서 지어내지 않는다.
 */

const SECTION = /^##\s+(\S+)\s+·\s+(\S+)\s+·\s+(.+)$/;
const GATES_DETAIL_RE = new RegExp(`^${GATES_DETAIL_PREFIX}(\\{.*\\})$`);
const MANIFEST_RE = new RegExp(`^${CONTEXT_MANIFEST_PREFIX}(\\{.*\\})$`);

/** 게이트가 명령의 비정상 종료를 스스로 적은 문구(`gates.js` `unhandledReason`의 안정된 꼬리). */
const UNHANDLED_RE = /unhandled error outside tests/;
/** `main is red on …`(`gates.js` broken-base) — 원인은 하네스 설정이 아니라 기본 브랜치의 테스트다. */
const BROKEN_BASE_RE = /^main is red on /;

/** 테스트 id에서 파일 경로만(`tests/a.py::test_x` → `tests/a.py`). 못 읽으면 null — 지어내지 않는다. */
const TEST_ID_PATH = /^([\w@.~+-]+(?:\/[\w@.~+-]+)*\.[A-Za-z0-9]+)(?:::|\s|$)/;
export function pathOfTestId(id) {
  const m = TEST_ID_PATH.exec(String(id ?? "").trim());
  return m ? m[1] : null;
}

/**
 * must_fix의 `where`가 파일을 지목하는가. 백틱은 벗기고 **첫 토큰**만 본다 —
 * `` `src/app.js:42` (the else branch) `` 같은 모양이 정상이고, `parseCausalPath`가 뒤를 locus로 읽는다.
 */
const WHERE_PATH = /^[\w@.~+-]+(?:\/[\w@.~+-]+)*\.[A-Za-z0-9]+(?::\d+)*$/;
export function causalFromWhere(where) {
  const s = String(where ?? "").replace(/`/g, "").trim();
  if (!s) return null;
  const head = s.split(/\s+/)[0].replace(/^\.\//, "");
  return WHERE_PATH.test(head) ? s.replace(/^\.\//, "") : null;
}

/** 이 이슈에 실제로 돌았던 런의 식별자 — 하트비트 코멘트가 유일한 출처다(§① 참조). */
export function knownRunsFor(comments) {
  const out = new Set();
  for (const c of comments || []) {
    const hb = parseHeartbeat(c?.body);
    if (!hb?.runner) continue;
    out.add(String(hb.runner));
    const id = runIdOfRunner(hb.runner);
    if (id) out.add(String(id));
  }
  return out;
}

/** 한 줄(`gates-detail:`/`context-manifest:`)이 아는 런을 지목하는가. */
export function isBoundLine(line, known) {
  if (!(known instanceof Set) || known.size === 0) return false;
  const runner = line?.runner == null ? null : String(line.runner);
  const runId = line?.run_id == null ? null : String(line.run_id);
  if (runId && known.has(runId)) return true;
  if (runner && known.has(runner)) return true;
  if (runner) { const id = runIdOfRunner(runner); if (id && known.has(String(id))) return true; }
  return false;
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * run 기록 전문 → `{ gates: [...], manifests: [...] }`. 각 줄에 그 줄을 감싼 섹션 헤더
 * (`## <stage> · <at> · <runner>`)를 `section`으로 붙인다. **섹션은 서술일 뿐 권위가 아니다**:
 * 헤더는 누구나 줄 앞에 놓을 수 있으므로 판정(=바인딩)은 언제나 줄 자신의 `run_id`/`runner`로 한다.
 */
export function parseRecordEvidence(text) {
  const gates = [];
  const manifests = [];
  let section = null;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trimEnd();
    const s = SECTION.exec(line);
    if (s) { section = { stage: s[1], at: s[2], runner: s[3].trim() }; continue; }
    const g = GATES_DETAIL_RE.exec(line);
    if (g) { const o = safeJson(g[1]); if (o) gates.push({ ...o, section }); continue; }
    const m = MANIFEST_RE.exec(line);
    if (m) { const o = safeJson(m[1]); if (o) manifests.push({ ...o, section }); }
  }
  return { gates, manifests };
}

const roundOf = (v) => (Number.isInteger(v) ? v : null);

/** RED 게이트 → 발견(§② 표의 첫 줄). 이름 댄 실패는 건너뛴다. */
function gateFindings({ issue, repo, gates }) {
  const out = [];
  for (const g of gates) {
    const reason = String(g.reason ?? "").trim();
    const failing = Array.isArray(g.failing) ? g.failing : [];
    if (!reason && failing.length) continue;                          // 깨진 테스트가 있다 — 공장이 제 일을 했다
    let causalPath = null;
    if (UNHANDLED_RE.test(reason)) {
      // 명령 자체가 죽었다 — 그 명령을 적은 자리는 하네스다(own-cal의 `test_one` 따옴표가 이 계열이다).
      causalPath = `.factory/harness.toml [commands].${g.gate}`;
    } else if (BROKEN_BASE_RE.test(reason)) {
      // 기본 브랜치가 이미 빨갛다 — 원인은 그 테스트 파일이지 하네스가 아니다(대개 `product`로 떨어진다).
      causalPath = pathOfTestId(failing[0]) ?? pathOfTestId(reason.replace(BROKEN_BASE_RE, ""));
    }
    out.push({
      kind: "gate",
      issue, repo,
      stage: g.section?.stage ?? null,
      round: roundOf(g.round),
      causal_path: causalPath,
      reason: reason || `gate ${g.gate} went RED but named no failing test`,
      extra: { test: failing[0] ?? null, snippet: g.snippet ?? null, chain: [`gate ${g.gate} RED`] },
    });
  }
  return out;
}

/** self-gate 차단 → 발견. `harness: true`(빌더가 못 고치는 보호 경로/하네스 일)는 채택자의 자리다. */
function selfGateFindings({ issue, repo, blocks }) {
  const out = [];
  for (const b of blocks) {
    for (const f of Array.isArray(b.findings) ? b.findings : []) {
      if (f?.blocking !== true) continue;                             // advisory는 차단하지 않았다 = 라운드를 만들지 않았다
      if (f.check === "gates") continue;                              // 같은 원인이 위 RED 게이트로 이미 들어왔다
      out.push({
        kind: "self-gate",
        issue, repo, stage: "implement", round: null,
        // 하네스가 못 준 것이면 채택자의 `.factory/harness.toml`, 아니면 그 판정을 내린 엔진 자신이다.
        causal_path: f.harness === true ? ".factory/harness.toml" : ".factory/lib/self-gate.js",
        reason: String(f.detail ?? f.check ?? "self-gate blocked the handoff"),
        extra: {
          test: (Array.isArray(f.ids) ? f.ids : [])[0] ?? null,
          chain: [`self-gate attempt ${b.attempt} on ${String(b.head).slice(0, 7)} — check ${f.check}`],
        },
      });
    }
  }
  return out;
}

/** 전이 거부 중 **라벨을 실제로 needs-human으로 옮긴 것**만 → 발견. 요구사항 엔진이 그 판정의 자리다. */
export const REQUIREMENTS_PATH = ".factory/lib/requirements.js";
function transitionFindings({ issue, repo, comments }) {
  const out = [];
  for (const c of comments || []) {
    const body = String(c?.body ?? "");
    const refused = TRANSITION_REFUSED.exec(body);
    const moved = TRANSITION_TO.exec(body);
    let chain = null;
    if (refused && body.includes(ACTUALLY_MOVED_TO_NEEDS_HUMAN)) chain = `${refused[1]} → ${refused[2]} (refused)`;
    else if (moved && moved[2] === NEEDS_HUMAN_LABEL && moved[4] === "refused") chain = `${moved[1]} → ${moved[2]} (refused)`;
    else continue;
    const rm = REFUSAL_REASON.exec(body);
    const reason = rm ? rm[1].trim() : "";
    if (!reason) continue;                                            // 사유 없는 거부는 라우팅할 것이 없다
    out.push({
      kind: "transition-refused",
      issue, repo, stage: null, round: null,
      causal_path: REQUIREMENTS_PATH,
      reason,
      extra: { chain: [chain] },
    });
  }
  return out;
}

/** 이 역할·이 라운드에 실제로 준 필드 목록(없으면 라운드를 무시하고 그 역할의 마지막 것). */
function manifestFor(manifests, role, round) {
  const mine = manifests.filter((m) => m?.role === role);
  if (!mine.length) return null;
  const exact = mine.filter((m) => roundOf(m.round) === roundOf(round));
  const pick = (exact.length ? exact : mine).at(-1);
  return Array.isArray(pick?.fields) ? pick.fields : null;
}

/** reject 판정의 must_fix 중 **파일을 지목한 것**만 → 발견. 역할의 컨텍스트 매니페스트를 함께 싣는다. */
function reviewFindings({ issue, repo, handoffs, manifests }) {
  const out = [];
  for (const h of handoffs) {
    if (h.stage !== "review") continue;
    const round = roundOf(h.data?.round);
    for (const v of Array.isArray(h.data?.verdicts) ? h.data.verdicts : []) {
      if (v?.verdict !== "reject") continue;
      for (const mf of Array.isArray(v.must_fix) ? v.must_fix : []) {
        const causalPath = causalFromWhere(mf?.where);
        if (!causalPath || !mf?.claim) continue;
        const fields = manifestFor(manifests, v.role, round);
        out.push({
          kind: "review-must_fix",
          issue, repo, stage: "review", round,
          role: v.role ?? null,
          ...(fields ? { context_manifest: fields } : {}),
          causal_path: causalPath,
          reason: String(mf.claim),
          extra: { snippet: mf.evidence ? String(mf.evidence) : null, chain: [`review round ${round ?? "?"}: ${v.role} reject (${mf.id ?? "?"})`] },
        });
      }
    }
  }
  return out;
}

/**
 * `harvestFindings({ issue, repo, record, comments }) → rawFinding[]`
 *
 * `record`는 그 이슈의 run 기록 전문(`docs/factory/runs/<issue>.md`), `comments`는 그 이슈의 코멘트
 * 전부(`{id, body, createdAt}`)다. 둘 다 회고가 이미 손에 들고 있는 것이고, 둘 다 `factory/records`
 * 브랜치와 GitHub에 durable하게 남는다 — 7일짜리 Actions 아티팩트에 의존하는 경로는 없다(spec §3).
 * 절대 던지지 않는다: 한 소스가 깨져도 나머지 소스의 발견은 나온다.
 */
export function harvestFindings({ issue, repo, record = "", comments = [] } = {}) {
  const out = [];
  const push = (fn) => { try { out.push(...fn()); } catch { /* 한 소스의 실패가 나머지를 막지 않는다 */ } };
  const known = knownRunsFor(comments);
  const { gates, manifests } = parseRecordEvidence(record);
  const boundGates = gates.filter((g) => isBoundLine(g, known));
  const boundManifests = manifests.filter((m) => isBoundLine(m, known));

  push(() => gateFindings({ issue, repo, gates: boundGates }));
  push(() => selfGateFindings({ issue, repo, blocks: allSelfGateFindings(comments) }));
  push(() => transitionFindings({ issue, repo, comments }));
  push(() => reviewFindings({ issue, repo, handoffs: parseHandoffs(comments), manifests: boundManifests }));
  return out;
}
