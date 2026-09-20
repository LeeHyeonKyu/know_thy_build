import { parseHandoffs } from "../handoff.js";
import { parseHeartbeat } from "../heartbeat.js";
import { runIdOfRunner } from "../run-record.js";
import { GATES_DETAIL_PREFIX } from "../gates.js";
import { CONTEXT_MANIFEST_PREFIX } from "../context.js";
import { SELF_GATE_DETAIL_PREFIX } from "../self-gate.js";
import {
  ACTUALLY_MOVED_TO_NEEDS_HUMAN, allSelfGateFindings, HUMAN_DECISION, NEEDS_HUMAN_LABEL,
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
 * ## ② 무엇이 발견이고 무엇이 아닌가 — **기본값은 "발견이 아니다"**
 *
 * 머지된 이슈마다 RED 게이트 한 번, self-gate 차단 한 번, must_fix 몇 개는 **정상**이다. 그것들은
 * 공장이 제 일을 한 흔적이지 공장의 결함이 아니고, 전부 라우팅하면 루프는 머지마다 이슈를 열어
 * 스스로 무의미해진다. 그래서 이 파일의 절반은 "무엇을 **버리는가**"이고, 각 소스는 자기 증거로
 * 문턱을 넘어야만 발견이 된다.
 *
 * ### RED 게이트 (`gates-detail` — T1의 줄; `parsed`/`code`가 판정의 재료다)
 * | 관측                                                      | 판정 | causal |
 * |-----------------------------------------------------------|------|--------|
 * | 테스트 게이트 + `parsed:true` + `failing[]` 있음           | 발견 아님 | — (공장이 제 일을 했다) |
 * | `reason`이 unhandled(KTB-35)                               | harness | `.factory/harness.toml [commands].<gate>` |
 * | `reason`이 broken-base                                     | 발견(제품) | 깨진 테스트의 파일 |
 * | `code` 127 · `command not found` · `No such file`          | harness | `.factory/harness.toml [runtime].setup` (툴체인이 없다) |
 * | `code` 126 · `unknown option` · `not recognized`           | harness | `.factory/harness.toml [commands].<gate>` (명령 문자열이 틀렸다) |
 * | 진단이 전부 error 미만인데 RED (`info •` 만 있음)          | harness | `.factory/harness.toml [commands].<gate>` (명령이 info를 치명으로 친다) |
 * | 테스트 게이트 + `parsed:false` + `code`가 셸 실패           | harness | `.factory/harness.toml [commands].<gate>` |
 * | 테스트 게이트 + `parsed:false` + `code` 1 (평범한 실패)    | **ambiguous** | (러너가 제품 코드에서 죽었을 수도 있다 — 단정하지 않는다) |
 * | 그 밖(리포트 없는 lint/typecheck RED 등)                   | **발견 아님** | — (제품 코드에 대한 평범한 판정이다) |
 *
 * 끝에서 두 번째 줄이 재리뷰 SF-a다: `parsed:false`의 잔여 경우는 "러너가 리포트를 쓰기 전에
 * **제품 코드에서** 죽었다"(빌더의 import 오류, 세그폴트)일 수 있다. 그것을 하네스 명령의 결함이라고
 * **단정**하면 채택자 저장소에 엉뚱한 파일을 지목하는 harness 이슈가 열린다 — 셸 수준 실패(126/127,
 * 위 두 줄)가 아닌 `parsed:false`는 두 후보를 적은 노트로 올린다(spec §2: 오라우팅보다 미판정이 낫다).
 *
 * 마지막 줄이 T3 리뷰 MF-3(b)가 잡은 자리다. 예전 규칙은 `reason`에만 걸려 있었는데 `reason`은
 * **리포트를 읽은 테스트 게이트**에만 붙는다 — 그래서 채택자의 진짜 하네스 RED(A·C 행)는 경로 없는
 * `ambiguous` 노트가 되고, 평범한 lint RED는 머지마다 노트가 됐다. 정확히 거꾸로였다.
 *
 * ### self-gate 차단 / 전이 거부 — **`attribution`을 통과해야만 `ktb`다**
 * 이 두 소스의 원시 모양에는 인과 파일이 없다. 예전 구현은 **판정 엔진이 사는 주소**
 * (`.factory/lib/self-gate.js`·`requirements.js`)를 인과 파일로 박았는데, 그러면 mutation survivor
 * ("이 테스트는 아무것도 주장하지 않는다")와 pin 회귀 — 곧 **공장이 정확히 제 일을 한 것** — 이
 * 전부 KTB의 개선 이슈로 올라간다. 책임이 정반대로 간다(T3 리뷰 MF-1, Global Constraint 1).
 *
 * 그래서 `ktb`는 **검사 자신이 틀렸다는 증거**가 있을 때만 준다. 증거는 세 종류이고, 각각이 이
 * 이슈의 durable한 기록에서 나온다(`attributionFor`에 정확한 조건이 적혀 있다):
 *   (a) `infrastructure` — finding이 `harness: true`다(검사가 이 하네스에서 못 돌았다). `ktb`가
 *       아니라 **`harness`**다: 고치는 사람은 채택자다.
 *   (b) `human-decision` — 이 이슈의 `human-decision:v1` 코멘트가 **`cause: factory-defect`라는
 *       구조화된 필드**를 달고 있고, 그 코멘트의 **작성자가 팩토리 계정이 아니다**. 산문 정규식은
 *       쓰지 않고(정직한 `:unstick` 문장이 오발한다), 작성자 검사가 없으면 아무 에이전트나
 *       그 한 줄을 적어 모든 차단을 상류로 세탁할 수 있다.
 *   (c) `check-withdrawn` — 그 검사가 막았던 런보다 **KTB 버전이 높은** 나중 런에서 그 검사가
 *       `ran`에도 없고 `skipped: no-input`에도 없다. 빌더는 테스트를 지울 수는 있어도 KTB 버전을
 *       올릴 수는 없다. 증거는 **검사 이름으로 묶인다**(`gates` 증거가 `mutation` finding을 올리지 않는다).
 * 셋 중 아무것도 없으면 → 발견의 인과 파일은 finding이 **스스로 지목한 경로**(survivor의 테스트 파일,
 * pin의 guard)이고, 그것은 `[test].test_glob`에 걸려 `product`(disposition `outcome`)로 떨어진다 —
 * 라우팅하지 않는다. 지목한 경로조차 없으면 발견으로 내지 않는다(경로 없는 `ambiguous` 노트를
 * 머지마다 다는 것이 바로 위 MF-3(b)가 막는 잡음이다).
 *
 * ### 리뷰 must_fix
 * `where`가 파일을 지목한 reject 항목만. 산문 `where`는 이미 lesson 후보다(`retro/harvest.js`).
 *
 * ## ③ 리허설 RED는 여기서 수확하지 않는다
 * 리허설의 판정은 이슈별 run 기록이 아니라 저장소 변수/commit status에 산다(`lib/rehearsal.js`) —
 * 이슈 하나에 귀속되는 durable한 줄이 없다. 저장소 단위 신호이므로 주기적 health 잡(Task 4)의 몫이고,
 * 없는 출처를 여기서 지어내지 않는다.
 */

const SECTION = /^##\s+(\S+)\s+·\s+(\S+)\s+·\s+(.+)$/;
const GATES_DETAIL_RE = new RegExp(`^${GATES_DETAIL_PREFIX}(\\{.*\\})$`);
const MANIFEST_RE = new RegExp(`^${CONTEXT_MANIFEST_PREFIX}(\\{.*\\})$`);
const SELF_GATE_DETAIL_RE = new RegExp(`^${SELF_GATE_DETAIL_PREFIX}(\\{.*\\})$`);

/** 게이트가 명령의 비정상 종료를 스스로 적은 문구(`gates.js` `unhandledReason`의 안정된 꼬리). */
const UNHANDLED_RE = /unhandled error outside tests/;
/** `main is red on …`(`gates.js` broken-base) — 원인은 하네스 설정이 아니라 기본 브랜치의 테스트다. */
const BROKEN_BASE_RE = /^main is red on /;

/** 셸이 명령 자체를 못 찾았다/못 돌렸다 — 툴체인이 없다는 뜻이고, 그것을 까는 자리는 `[runtime].setup`이다. */
const MISSING_TOOLCHAIN_RE = /command not found|: not found\b|No such file or directory|is not recognized as an internal or external command/i;
/** 명령은 찾았는데 그 인자를 거부했다 — `[commands].<gate>`의 문자열이 틀렸다(own-cal의 `test_one -t`). */
const BAD_INVOCATION_RE = /unknown option|unrecognized option|invalid option|Could not find an option named/i;
/** 진단 한 줄의 심각도 접두(flutter analyze·dart analyze·여러 린터가 쓰는 `<severity> • <msg>` 모양). */
const DIAGNOSTIC_INFO_RE = /(?:^|\n)\s*(?:info|hint|note)\s+[•·]/i;
const DIAGNOSTIC_ERROR_RE = /(?:^|\n)\s*(?:error|severe|fatal)\s+[•·]/i;
/** `[runtime].setup`이 깔아야 할 것이 없다 — 채택자의 하네스에서 이 자리의 이름. */
export const SETUP_LOCUS = ".factory/harness.toml [runtime].setup";
/** self-gate/전이 거부가 `ktb`로 갈 수 있는 유일한 문. 세 증거 중 하나 — `attributionFor` 참조. */
export const ATTRIBUTION_KINDS = Object.freeze(["infrastructure", "human-decision", "check-withdrawn"]);

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
  const selfGateLines = [];
  let section = null;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trimEnd();
    const s = SECTION.exec(line);
    if (s) { section = { stage: s[1], at: s[2], runner: s[3].trim() }; continue; }
    const g = GATES_DETAIL_RE.exec(line);
    if (g) { const o = safeJson(g[1]); if (o) gates.push({ ...o, section }); continue; }
    const m = MANIFEST_RE.exec(line);
    if (m) { const o = safeJson(m[1]); if (o) { manifests.push({ ...o, section }); } continue; }
    const sg = SELF_GATE_DETAIL_RE.exec(line);
    if (sg) { const o = safeJson(sg[1]); if (o) selfGateLines.push({ ...o, section }); }
  }
  return { gates, manifests, selfGateLines };
}

const roundOf = (v) => (Number.isInteger(v) ? v : null);

/**
 * ## `attribution` — self-gate/전이 거부가 `ktb`로 갈 수 있는 **유일한** 문 (T3 리뷰 MF-1 + 재리뷰)
 *
 * 기본값은 언제나 "공장이 제 일을 했다"다. 세 증거 중 하나가 **그 finding의 그 검사에 대해** 있을
 * 때에만 주인이 바뀐다. 1차 구현은 이 문이 (b) 산문 정규식 + (c) 부재 추론이었고, 둘 다 뚫렸다 —
 * 재리뷰가 실제 생산자로 시연했다. 지금 모양은 그 두 구멍을 각각 닫는다:
 *
 * ### (a) `infrastructure` → **`harness`** (ktb가 아니다)
 * finding이 `harness: true`(검사가 못 돌았다 — 하네스가 단일 테스트를 못 돌린다)다. 고치는 사람은
 * 채택자이고 착지점은 그 저장소의 harness 이슈다. finding 단위라 `selfGateFindings`가 본다.
 *
 * ### (b) `human-decision` → 사람이 이미 공장 탓으로 판정했다
 * 두 조건이 **모두** 필요하다(재리뷰 NEW-MF-2):
 *   ① **구조화된 필드**: 결정 yaml의 `cause: factory-defect`. 산문 정규식은 쓰지 않는다 —
 *      "the stall was caused by the self-gate blocking twice"(서술) 같은 정직한 `:unstick` 문장이
 *      셋 중 셋 트리거됐고, 그것은 `classify.js`가 자기 안내-실패 규칙에서 이미 거부한 실패 방식이다
 *      ("방아쇠는 증거여야지 어휘여서는 안 된다"). 이제 `:unstick` 스킬이 그 필드를 **쓴다**.
 *   ② **작성자가 사람이다**: `gh issue comment`는 훅이 일부러 열어 둔 문이라 어떤 스테이지
 *      에이전트든 `human-decision:v1` + `cause: factory-defect`를 적어 모든 self-gate 차단을
 *      상류로 세탁할 수 있다(시연됨). 그래서 작성자가 팩토리 계정(`resolveFactoryLogins`)이면
 *      **무시한다** — 에이전트가 적은 결정은 사람의 결정이 아니다. 작성자를 아예 모르면(옛 코멘트
 *      스냅샷) 그것도 증거가 아니다: 모르는 것은 통과가 아니다.
 *
 * ### (c) `check-withdrawn` → KTB가 그 검사를 거둬들였다
 * 1차 구현은 "나중 줄의 검사 집합에 없다"였는데, `ranChecks`는 고정 목록이 아니라 **입력이 있었던
 * 검사**의 목록이다: `mutation`은 추가된 테스트가 있어야, `pins`는 rework 핸드오프가 있어야 돈다.
 * 곧 `survivor: test/x.test.js asserts nothing`에 막힌 빌더가 **그 테스트를 지우면** 다음 줄에서
 * `mutation`이 사라지고, 그가 빠져나간 차단이 KTB의 엔진 결함으로 상류에 열렸다(시연됨).
 * 그래서 이제 세 조건을 **전부** 요구한다:
 *   ① 나중 관측의 `ran`에 그 검사가 없고,
 *   ② 그 검사가 `skipped`에 `no-input`으로 적혀 있지 **않으며**(적혀 있으면 "볼 것이 없었다"는
 *      기록된 사실이다 — 거둬들임이 아니다),
 *   ③ 나중 관측의 `ktb_version`이 막은 관측의 것보다 **높다**. 빌더는 테스트를 지울 수는 있어도
 *      KTB 버전을 올릴 수는 없다 — 그 값은 러너가 설치 매니페스트에서 읽어 줄에 싣고, 그 파일은
 *      에이전트가 쓸 수 없다(`FACTORY_ENUM` deny + 훅).
 * 그리고 증거는 **검사 이름으로 묶인다**: `gates`가 거둬들여졌다는 사실이 `mutation` finding을
 * 승격시키지 못한다(1차 구현은 이슈 단위 불리언 하나였다).
 */
/**
 * 기각된 `human-decision:v1`의 **사유 문구** — 최종 리뷰 nit 5.
 *
 * 거부는 하나지만 그 **이유는 둘**이고, 사람이 다음에 할 일이 정반대다:
 *   ① `identity.personal !== false`(사람 계정이거나 종류를 모른다) → *공유 신원*. 팩토리와 사람이
 *      같은 작성자라 **가를 수 없다**. 고치는 방법: 머신 유저/GitHub App을 팩토리 신원으로 등록한다.
 *   ② `identity.personal === false`(진짜 봇 신원) → 가를 수 **있었고**, 갈라 보니 그 결정을 적은 것이
 *      에이전트다. 공유된 것은 아무것도 없다 — "shared identity"라고 적으면 주인은 이미 제대로
 *      등록해 둔 봇 신원을 다시 등록하러 가고(할 일이 없다), 정작 진짜 사실 — *에이전트가 자기
 *      결정을 사람의 결정인 척 적었다* — 은 화면 어디에도 남지 않는다.
 *
 * 그래서 문구의 열쇠는 **작성자가 아니라 신원**이다. 신원을 모르면 ①로 떨어진다(모르는 것을
 * "봇이었다"로 적지 않는다 — 이 파일의 다른 모든 판정과 같은 규율).
 */
export function refusalWording({ author, identity = null, said = "" }) {
  const agentWritten = identity?.personal === false;
  const reason = agentWritten
    ? "authored by the factory identity — an agent-written decision is not a human decision"
    : "shared identity — author equals a factory login; cannot distinguish a person from an agent";
  const detail = agentWritten
    ? `${said} — REFUSED as evidence: @${author} is the factory identity, so this decision was written by an agent`
    : `${said} — REFUSED as evidence: @${author} is also a factory login`;
  return { reason, detail };
}

const HUMAN_DECISION_CAUSE = /^\s*cause:\s*["']?factory-defect["']?\s*$/m;
const HUMAN_DECISION_KTB_FIX = /^\s*ktb_fix:\s*["']?([^\s"']+)["']?\s*$/m;

/** `1.3.10` > `1.3.2` — 점으로 끊어 숫자로 비교한다(문자열 비교는 10을 2보다 작게 읽는다). */
export function isNewerVersion(a, b) {
  // `Number("")`는 **0**이다 — 빈 조각을 먼저 버리지 않으면 `null`/`""`이 "0.0.0"이 되어 모든
  // 실제 버전보다 낮게 읽힌다(= 버전을 모르는 런이 withdrawal 증거를 만든다).
  const parse = (v) => String(v ?? "").trim().replace(/^v/, "").split(/[.+-]/).filter((p) => p !== "").map((p) => Number(p)).filter((n) => Number.isFinite(n));
  const x = parse(a);
  const y = parse(b);
  if (!x.length || !y.length) return false;                           // 모르면 주장하지 않는다
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * `attributionFor({ comments, selfGateLines, factoryLogins }) → { evidenceFor(check), evidence }`
 * `selfGateLines`는 **`self-gate-detail:` 한 줄 JSON**이다(`self-gate.js#selfGateDetailLine`) —
 * 사람이 읽는 `self-gate: …` 줄이 아니다. 그 줄에는 `ran`/`skipped`/`ktb_version`이 없다.
 */
export function attributionFor({ comments = [], selfGateLines = [], factoryLogins = [], identity = null } = {}) {
  const evidence = [];
  /**
   * ── T7: 거부는 보이게 한다 ─────────────────────────────────────────────────────────────────
   * `FACTORY_BOT_TOKEN`이 소유자의 PAT인 저장소(= 지금의 모든 dogfood 저장소)에서는 팩토리 코멘트와
   * 소유자의 `human-decision:v1`이 **같은 작성자**다. 그러면 위의 `continue` 하나가 (b)를 조용히
   * 통째로 닫는다 — 사람은 "factory-defect라고 적었는데 아무 일도 안 일어났다"만 본다. 판정은 그대로
   * 두고(공유 신원은 사람의 결정이 **아니다**) 그 거부를 기록으로 남긴다: `evidenceFor`는 절대 세지
   * 않고, 표면(retro·analyze·health·doctor)은 그것을 읽어 보여 준다.
   *
   * 거부된 항목은 `evidence`에 **같이** 실린다(감사 목록은 하나여야 한다) — 세지 않는 일은 `evidenceFor`
   * 한 곳에서만 일어나고, `unverifiable`은 그 목록의 파생 뷰다. 두 배열에 따로 담으면 언젠가 한쪽만
   * 읽는 호출자가 생기고 그 호출자가 곧 이 구멍을 다시 연다.
   */
  // `null`은 "팩토리 계정 이름을 확인하지 못했다"이고 `[]`와 **다르다**: 봇 이름을 모르면 사람의
  // 결정과 에이전트의 결정을 가를 수 없으므로 (b)를 통째로 거부한다(모르는 것은 통과가 아니다).
  const bots = factoryLogins == null ? null : new Set(factoryLogins.filter(Boolean).map((l) => String(l).toLowerCase()));

  // (b) 구조화된 필드 + 사람 작성자.
  for (const c of bots == null ? [] : comments) {
    const body = String(c?.body ?? "");
    const hd = HUMAN_DECISION.exec(body);
    if (!hd) continue;
    if (!HUMAN_DECISION_CAUSE.test(body)) continue;                   // 산문은 증거가 아니다 — 필드만이 증거다
    const author = c?.author == null ? null : String(c.author);
    if (!author) continue;                                            // 작성자를 모르면 통과시키지 않는다
    const fix = HUMAN_DECISION_KTB_FIX.exec(body)?.[1] ?? null;
    const said = `human-decision:v1 (skill=${hd[2] ?? "unknown"}) by @${author} declares \`cause: factory-defect\`${fix ? ` (ktb_fix: ${fix})` : ""}`;
    // 에이전트가 적은 "사람의 결정"은 결정이 아니다 — 그러나 그 거부는 이제 **줄 하나로 남는다**.
    if (bots.has(author.toLowerCase())) {
      evidence.push({
        kind: "human-decision", status: "unverifiable", check: null, author,
        ...refusalWording({ author, identity, said }),
      });
      continue;
    }
    evidence.push({ kind: "human-decision", check: null, author, detail: said });
  }

  // (c) 버전이 올라간 뒤 그 검사가 더는 돌지 않는다. 줄은 시간순이다(run 기록은 append-only).
  for (let i = 0; i < selfGateLines.length; i += 1) {
    const blockedLine = selfGateLines[i];
    if (!blockedLine.blocked) continue;
    for (const check of blockedLine.ran || []) {
      for (let j = i + 1; j < selfGateLines.length; j += 1) {
        const later = selfGateLines[j];
        if ((later.ran || []).includes(check)) break;                 // 여전히 돈다 — 거둬들인 것이 아니다
        const skipped = (later.skipped || []).find((s) => s?.check === check);
        if (skipped) break;                                           // "볼 것이 없었다"는 기록된 사실이다 — 증거가 아니다
        if (!isNewerVersion(later.ktb_version, blockedLine.ktb_version)) break;  // 버전이 안 올랐다 — 빌더가 바꾼 것이다
        evidence.push({
          kind: "check-withdrawn", check,
          detail: `check \`${check}\` ran at ktb ${blockedLine.ktb_version} and is neither run nor skipped at the newer ktb ${later.ktb_version} — the check was withdrawn, not satisfied`,
        });
        break;
      }
    }
  }

  /**
   * 이 **검사**에 대한 증거만. 검사를 모르는 증거((b) — 이슈 전체에 대한 사람의 판정)는 언제나 센다.
   * `status: "unverifiable"`은 **절대** 세지 않는다 — 보이게 만드는 것과 증거로 세는 것은 다른 일이고,
   * 후자를 열면 공유 신원 저장소에서 에이전트가 적은 결정 하나가 상류 쓰기를 여는 바로 그 구멍이 된다.
   */
  const evidenceFor = (check) => evidence.filter((e) => e.status !== "unverifiable" && (e.check == null || e.check === check));
  return { evidence, evidenceFor, unverifiable: evidence.filter((e) => e.status === "unverifiable") };
}

/** RED 게이트 → 발견(§②의 표). 기본값은 "발견 아님". */
function gateFindings({ issue, repo, gates }) {
  const out = [];
  for (const g of gates) {
    const reason = String(g.reason ?? "").trim();
    const failing = Array.isArray(g.failing) ? g.failing : [];
    const snippet = String(g.snippet ?? "");
    const code = Number.isInteger(g.code) ? g.code : null;
    const isTestGate = typeof g.parsed === "boolean";

    let causalPath = null;
    let why = null;
    if (UNHANDLED_RE.test(reason)) {
      // KTB-35: 리포트는 읽었는데 실패가 0이고 명령은 죽었다 — 테스트 밖에서 무언가 터졌다.
      causalPath = `.factory/harness.toml [commands].${g.gate}`;
    } else if (BROKEN_BASE_RE.test(reason)) {
      // 기본 브랜치가 이미 빨갛다 — 원인은 그 테스트 파일이지 하네스가 아니다(대개 `product`로 떨어진다).
      causalPath = pathOfTestId(failing[0]) ?? pathOfTestId(reason.replace(BROKEN_BASE_RE, ""));
    } else if (isTestGate && g.parsed === true) {
      // 리포트를 **실제로 읽었다** — 그 판정은 제품 코드에 대한 공장의 정상적인 판단이다. 발견이 아니다.
      // (`failing`이 비어 보여도 그렇다: 그 배열은 러너 **출력**에서 이름을 주운 것이라, 리포터가
      //  이름을 stdout에 찍지 않으면 비어 있을 수 있다 — 리포트를 읽었다는 사실이 더 강한 신호다.)
      continue;
    } else if (code === 127 || MISSING_TOOLCHAIN_RE.test(snippet)) {
      // 셸이 명령을 못 찾았다. 그 툴체인을 까는 자리는 명령 문자열이 아니라 `[runtime].setup`이다
      // (계획 Task 2 (d): own-cal의 Flutter 툴체인 누락).
      causalPath = SETUP_LOCUS;
      why = `the gate command for \`${g.gate}\` could not be run at all — the toolchain it needs is not on PATH`;
    } else if (code === 126 || BAD_INVOCATION_RE.test(snippet)) {
      // 명령은 있는데 인자를 거부했다 — `[commands].<gate>`의 문자열이 틀렸다(own-cal의 `test_one -t`).
      causalPath = `.factory/harness.toml [commands].${g.gate}`;
      why = `the \`${g.gate}\` command was rejected by the tool it invokes — the command string in the harness is wrong`;
    } else if (DIAGNOSTIC_INFO_RE.test(snippet) && !DIAGNOSTIC_ERROR_RE.test(snippet)) {
      // 진단이 전부 error 미만인데 게이트는 RED — 명령이 info를 치명으로 치도록 적혀 있다
      // (own-cal의 `flutter analyze` fatal infos). 제품 코드의 문제가 아니라 명령 설정의 문제다.
      causalPath = `.factory/harness.toml [commands].${g.gate}`;
      why = `the \`${g.gate}\` command went RED with no error-severity diagnostic — it is configured to fail on info-level findings`;
    } else if (isTestGate && g.parsed === false) {
      // 테스트 게이트인데 리포트를 못 남겼다. 셸 수준 실패는 위에서 이미 걸렀으므로 남은 것은
      // "러너가 무언가에 죽었다"이고, 그 무언가는 **제품 코드일 수도 있다**(빌더의 import 오류,
      // 세그폴트). 하네스 명령의 결함이라고 단정하면 채택자 저장소에 엉뚱한 파일을 지목하는 이슈가
      // 열린다 — 경로를 비워 `ambiguous`로 올린다(재리뷰 SF-a; spec §2: 오라우팅보다 미판정이 낫다).
      causalPath = null;
      why = `the \`${g.gate}\` command exited ${code ?? "non-zero"} without writing a test report — it is not decidable from the record whether the command or the code under test died`;
    } else {
      // 리포트 없는 lint/typecheck RED 등 — 제품 코드에 대한 평범한 판정이다. 발견이 아니다.
      continue;
    }

    out.push({
      kind: "gate",
      issue, repo,
      stage: g.section?.stage ?? null,
      round: roundOf(g.round),
      causal_path: causalPath,
      reason: why || reason || `gate ${g.gate} RED`,
      extra: { test: failing[0] ?? null, snippet: g.snippet ?? null, chain: [`gate ${g.gate} RED${code == null ? "" : ` (exit ${code})`}`] },
    });
  }
  return out;
}

/** self-gate 엔진의 주소. `attribution`이 "검사 자신이 틀렸다"고 말할 때에만 인과 파일이 된다. */
export const SELF_GATE_PATH = ".factory/lib/self-gate.js";
/** 전이 거부의 판정을 내리는 엔진(`requirements.js:146`이 `plan roles … != roster …`의 실제 생산자다). */
export const REQUIREMENTS_PATH = ".factory/lib/requirements.js";
/**
 * self-gate finding이 **스스로 지목한** 경로. `self-gate.js`가 쓰는 두 모양을 읽는다:
 *   `survivor: test/date.test.js asserts nothing under mutation (…)`
 *   `regression: pin P-3 guard test/tz.test.js is red — …`
 * 못 읽으면 null — 그때는 발견으로 내지 않는다(경로 없는 노트를 만들지 않는다).
 */
const SELF_GATE_OWN_PATH = /(?:^survivor:\s+|\bguard\s+)([\w@.~+-]+(?:\/[\w@.~+-]+)*\.[A-Za-z0-9]+(?:::\S+)?)/;
export function pathOfSelfGateDetail(detail) {
  const m = SELF_GATE_OWN_PATH.exec(String(detail ?? ""));
  return m ? m[1] : null;
}

/** self-gate 차단 → 발견. 누가 잘못했는지는 `attribution`이 정한다(§② 참조). */
function selfGateFindings({ issue, repo, blocks, attribution }) {
  const out = [];
  const push = (f, causalPath, chain, extra = {}) => out.push({
    kind: "self-gate", issue, repo, stage: "implement", round: null,
    causal_path: causalPath,
    reason: String(f.detail ?? f.check ?? "self-gate blocked the handoff"),
    extra: { test: (Array.isArray(f.ids) ? f.ids : [])[0] ?? null, chain: [chain], ...extra },
  });
  for (const b of blocks) {
    for (const f of Array.isArray(b.findings) ? b.findings : []) {
      if (f?.blocking !== true) continue;                             // advisory는 라운드를 만들지 않았다
      if (f.check === "gates") continue;                              // 같은 원인이 위 RED 게이트로 이미 들어왔다
      const chain = `self-gate ${b.source ?? "retry"} on ${String(b.head ?? "?").slice(0, 7)}${b.attempt ? ` attempt ${b.attempt}` : ""} — check ${f.check}`;
      // (a) 인프라급 — 검사가 **못 돌았다**. 채택자의 하네스가 단일 테스트를 못 돌리는 것이므로 harness다.
      if (f.harness === true) {
        push(f, ".factory/harness.toml", chain, { attribution: "infrastructure" });
        continue;
      }
      // (b)/(c) — **이 검사에 대해** 검사 자신이 틀렸다는 증거가 이 이슈에 있다(이슈 단위 불리언이 아니다).
      const mine = attribution.evidenceFor(f.check);
      if (mine.length) {
        push(f, SELF_GATE_PATH, chain, { attribution: mine.map((e) => e.kind), chain_evidence: mine.map((e) => e.detail) });
        continue;
      }
      // 증거가 없다 — 검사는 옳았고 결함은 빌더의 산출물이다. finding이 지목한 파일이 주인을 정한다.
      const own = pathOfSelfGateDetail(f.detail);
      if (own) push(f, own, chain, { attribution: "none" });
      // 지목한 파일조차 없으면 발견으로 내지 않는다 — 경로 없는 `ambiguous` 노트가 바로 잡음이다.
    }
  }
  return out;
}

/** 거부 사유가 파일을 지목하면 그 파일이 인과다(SF-5) — 엔진 주소를 무조건 박지 않는다. */
const REASON_PATH = /(?:^|\s|`)([\w@.~+-]+(?:\/[\w@.~+-]+)+\.[A-Za-z0-9]+(?::\d+)?)/;

/** 전이 거부 중 **라벨을 실제로 needs-human으로 옮긴 것**만 → 발견. 주인은 `attribution`이 정한다. */
function transitionFindings({ issue, repo, comments, attribution }) {
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
    // 사유가 파일을 지목하면 그것이 인과다(산출물 결함 — 대개 product). 지목이 없을 때에만,
    // 그리고 이 이슈에 귀속 증거가 있을 때에만, 판정 엔진 자신을 인과로 적는다.
    const named = REASON_PATH.exec(reason)?.[1] ?? null;
    // 전이 거부는 self-gate의 `check`가 없다 — 이슈 전체에 대한 사람의 판정((b))만이 그것을 엔진의
    // 결함으로 만든다. 검사 이름이 붙은 (c) withdrawal은 다른 검사에 대한 사실이므로 여기 오지 않는다.
    const mine = attribution.evidenceFor(null).filter((e) => e.kind === "human-decision");
    const causalPath = named ?? (mine.length ? REQUIREMENTS_PATH : null);
    if (!causalPath) continue;                                        // 증거 없는 거부는 엔진의 평범한 판정이다
    out.push({
      kind: "transition-refused",
      issue, repo, stage: null, round: null,
      causal_path: causalPath,
      reason,
      extra: {
        chain: [chain],
        attribution: named ? "none" : mine.map((e) => e.kind),
        ...(named ? {} : { chain_evidence: mine.map((e) => e.detail) }),
      },
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
 * `harvestIssue({ issue, repo, record, comments, factoryLogins }) → { findings, unverifiable }`
 *
 * `record`는 그 이슈의 run 기록 전문(`docs/factory/runs/<issue>.md`), `comments`는 그 이슈의 코멘트
 * 전부(`{id, body, createdAt, author}`)다. 둘 다 회고가 이미 손에 들고 있는 것이고, 둘 다
 * `factory/records` 브랜치와 GitHub에 durable하게 남는다 — 7일짜리 Actions 아티팩트에 의존하는
 * 경로는 없다(spec §3). `factoryLogins`는 팩토리 계정 이름들(`resolveFactoryLogins`)이고,
 * `human-decision:v1`의 작성자가 그중 하나면 그 결정은 **사람의 결정이 아니다**(재리뷰 NEW-MF-2).
 * 절대 던지지 않는다: 한 소스가 깨져도 나머지 소스의 발견은 나온다.
 *
 * ── T7 리뷰 should_fix 1: **두 값은 평범한 객체의 두 키여야 한다.** ─────────────────────────
 * 1차 구현은 `unverifiable`을 발견 배열의 **열거 불가 속성**으로 실었다. 그 값은 `spread`·`map`·
 * `slice`·`concat`·`JSON.stringify` 어디서든 조용히 사라진다 — 곧 "거부를 보이게 한다"는 이 태스크의
 * 전부가, 중간에 배열을 한 번 베끼는 호출자가 생기는 날 다시 침묵으로 돌아간다. 그래서 진짜 반환값은
 * 이 함수이고, `harvestFindings`는 발견만 돌려주는 얇은 래퍼로 남긴다(기존 호출자와 핀은 그대로).
 */
export function harvestIssue({ issue, repo, record = "", comments = [], factoryLogins = [], identity = null } = {}) {
  const out = [];
  const push = (fn) => { try { out.push(...fn()); } catch { /* 한 소스의 실패가 나머지를 막지 않는다 */ } };
  const known = knownRunsFor(comments);
  const { gates, manifests, selfGateLines } = parseRecordEvidence(record);
  const boundGates = gates.filter((g) => isBoundLine(g, known));
  const boundManifests = manifests.filter((m) => isBoundLine(m, known));
  // `self-gate-detail:`도 다른 두 줄과 같은 provenance 계약을 진다(줄 자신의 `run_id`/`runner`).
  const boundSelfGate = selfGateLines.filter((l) => isBoundLine(l, known));
  const attribution = attributionFor({ comments, selfGateLines: boundSelfGate, factoryLogins, identity });

  // self-gate 차단의 출처는 둘이다: 재시도 코멘트(빌더가 고칠 수 있는 것)와, **하네스급 차단**의
  // run 기록 줄. 후자는 `run-stage.js`가 재시도 코멘트를 쓰지 않고 곧장 needs-human으로 가기 때문에
  // 코멘트에 흔적이 없다(T3 리뷰 SF-1) — 그런데 그것이야말로 전형적인 채택자 하네스 발견이다.
  const blocks = [
    ...allSelfGateFindings(comments).map((b) => ({ ...b, source: "retry" })),
    ...boundSelfGate.filter((l) => l.harness).map((l) => ({
      head: null, attempt: null, source: "record",
      findings: [{ check: (l.ran || []).join("+") || "self-gate", blocking: true, harness: true, detail: "self-gate blocked: a harness change is needed (the check could not run on this harness)" }],
    })),
  ];

  push(() => gateFindings({ issue, repo, gates: boundGates }));
  push(() => selfGateFindings({ issue, repo, blocks, attribution }));
  push(() => transitionFindings({ issue, repo, comments, attribution }));
  push(() => reviewFindings({ issue, repo, handoffs: parseHandoffs(comments), manifests: boundManifests }));
  // 거부된 `human-decision`은 **발견이 아니다**(라우팅할 인과가 없다) — 그래서 별도의 키다.
  return { findings: out, unverifiable: attribution.unverifiable };
}

/**
 * `harvestFindings({...}) → rawFinding[]` — 발견만 필요한 호출자를 위한 얇은 래퍼.
 * 거부된 결정까지 보여 주려면 `harvestIssue`를 쓴다(그쪽이 진짜 반환값이다).
 */
export function harvestFindings(args) {
  return harvestIssue(args).findings;
}
