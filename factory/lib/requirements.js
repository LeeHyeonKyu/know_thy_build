import { latestHandoff } from "./handoff.js";
import { validate } from "./schemas.js";
import { verifyReviewQuorum } from "./review-quorum.js";

const fail = (reason) => ({ ok: false, reason });
const pass = { ok: true };

/** ctx.issue가 주어지면 handoff 마커의 issue 번호까지 맞춘다 — 다른 이슈의 산출물이 게이트를 통과하지 못하게. */
function need(ctx, stage, schema) {
  const h = latestHandoff(ctx.comments, stage);
  if (!h) return { err: fail(`${stage} handoff missing`) };
  if (ctx.issue != null && h.issue !== Number(ctx.issue)) return { err: fail(`${stage} handoff issue mismatch: handoff issue ${h.issue} != ${ctx.issue}`) };
  const v = validate(schema, h.data);
  if (!v.ok) return { err: fail(`${stage} handoff invalid: ${v.errors.join("; ")}`) };
  return { h };
}
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/**
 * 게이트를 통과했다는 주장의 출처는 러너가 쓴 `.factory/out/gates.json` 하나뿐이다 — handoff의
 * 자기 신고는 대체재가 아니다(워크플로가 자기 성적표를 쓰는 것이므로). 파일을 읽지 않은 호출자
 * (`gatesChecked !== true`)는 "게이트가 GREEN이더라"를 주장할 자격이 없다 — 거부한다.
 *
 * 예외는 **선행 확인**(`ctx.prerequisite === true`)뿐이다: assertHandoff와 bin/assert-handoff는
 * "직전 스테이지가 산출물을 남겼는가"를 묻는 것이지 이번 런의 게이트를 묻는 게 아니다 — 그 시점엔
 * 이번 런의 게이트도 sha 바인딩도 존재하지 않는다(resetGates가 지운 직후다).
 */
/**
 * ADR-020 KTB-32 — **사람의 재시도(`transition.js --human --retry`)도 같은 종류의 "복구"다.**
 * 인프라가 끊은 자리로 되돌아가는 것이지 새 성취를 주장하는 것이 아니다: 사람의 노트북에는 이번
 * 런의 `.factory/out/gates.json`도 그 sha 바인딩도 존재할 수 없고(fresh checkout조차 아니다),
 * 실제 판정은 되돌아간 스테이지가 다시 돌며 만든다. 그래서 `prerequisite`와 **정확히 같은 것만**
 * 면제한다 — handoff의 존재·유효성·내용 검사(verifier 판정 등)는 그대로 물린다.
 */
const restoring = (ctx) => ctx.prerequisite === true || ctx.humanRetry === true;

export const GATES_UNVERIFIED = "gates not verified for this transition";
export const HUMAN_MERGE_STATUSES_UNVERIFIED = "human-merge reconcile: factory commit statuses not verified";
/**
 * `to`: 이 게이트를 부른 목적 상태. KTB-46의 사람-머지 분기 **하나 때문에** 생긴 인자다 —
 * 이 함수는 `awaiting-review`·`approved`·`merged` 셋이 공유하므로, 목적지를 묻지 않으면 그 분기가
 * 세 문을 한꺼번에 연다(사람이 머지한 적도 없는 PR을 `factory:approved`로 올리는 문까지). 나머지
 * 검사는 목적지와 무관하므로 `to`를 보지 않는다.
 */
function gatesGate(ctx, to) {
  if (restoring(ctx)) return null;
  /**
   * KTB-46 — **사람이 이미 머지한 보호 경로 PR의 사후 기록**(스펙 §12.3-2). 이 경로의 게이트 증거는
   * 러너의 로컬 파일이 아니라 **러너가 그 커밋에 올린 `factory/gates` 상태**다: sweeper가 머지된 PR의
   * head sha로 `verifyFactoryStatuses`를 돌려 그 상태가 success이고 **팩토리 계정이 올린 것**임을
   * 확인한 뒤에만 `statusesVerified`를 세운다(merge 스테이지 §(6b) 판정 (d)와 같은 함수다).
   *
   * 파일을 요구할 수 없는 이유는 그 파일이 존재할 수 없기 때문이다 — sweep 잡에는 체크아웃이 없고,
   * 애초에 merge 스테이지는 보호 경로를 이유로 단계 (3)에서 물러나 게이트(단계 4)를 돌지도 못했다.
   * 그렇다고 이 자리를 열어 두면 되돌릴 수 없는 라벨이 증거 없이 붙는다 — 그래서 **두 플래그를 함께**
   * 요구한다: `humanMerged`만으로는 아무것도 열리지 않고, 확인에 실패한 sweeper는 전이를 부르지도
   * 않는다. 이 둘의 유일한 생산자는 `lib/sweeper.js`의 `sweepHumanMerged`다(`bin/transition.js`는
   * `gatesChecked`·`gatesFile`만 담은 닫힌 리터럴을 넘기고, 알 수 없는 플래그는 파서가 거절한다).
   *
   * 면제되는 것은 **이 검사 하나**이고, 그것도 **`factory:merged` 한 목적지에서만**이다: 이 함수는
   * `awaiting-review`·`approved`도 부르는데 거기서 열리면, 사람이 머지한 적도 없는 PR을 승인 상태로
   * 올리는 문이 된다(그 전제 자체가 없다). `shaBound`는 그대로라 review handoff가 이 PR head sha에
   * 묶여야 하고, `factory:merged` 규칙의 정족수 all-approve·K 재계산도 그대로 돈다 — 사람이 리뷰를
   * 거치지 않은 PR을 머지하면 이슈는 `needs-human`에 그대로 남는다. 그것이 이 설계의 요점이다.
   */
  if (ctx.humanMerged === true && to === "factory:merged") return ctx.statusesVerified === true ? null : fail(HUMAN_MERGE_STATUSES_UNVERIFIED);
  if (ctx.gatesChecked !== true) return fail(GATES_UNVERIFIED);
  if (!ctx.gatesFile) return fail("gates file missing");
  if (ctx.gatesFile.diagnostic === true) return fail("gates file is diagnostic output");
  if (ctx.gatesFile.status !== "GREEN") return fail(`gates file status is ${ctx.gatesFile.status}`);
  // 판정 파일이 **어떤 커밋**을 검사한 것인지까지 묶는다. 게이트가 돈 뒤에 커밋이 더 붙었으면
  // 그 GREEN은 지금 머지하려는 트리의 얘기가 아니다.
  const head = ctx.prHeadSha || ctx.headSha;
  const of = ctx.gatesFile.head_sha;
  if (head && of && of !== head) return fail(`gates file describes ${of.slice(0, 7)}, PR head is ${head.slice(0, 7)}`);
  return null;
}
const shaBound = (ctx) => !restoring(ctx);

const RULES = {
  "factory:ready"(ctx) {
    const { h, err } = need(ctx, "triage", "triage.v1"); if (err) return err;
    if (h.data.disposition !== "ready") return fail(`triage disposition is ${h.data.disposition}, not ready`);
    return pass;
  },
  "factory:planned"(ctx) {
    const { h, err } = need(ctx, "plan", "plan.v1"); if (err) return err;
    if (ctx.roster && !sameSet(h.data.roles, ctx.roster)) return fail(`plan roles [${h.data.roles}] != roster [${ctx.roster}]`);
    if (ctx.expectedRounds != null && h.data.rounds !== ctx.expectedRounds) return fail(`plan rounds ${h.data.rounds} != expected ${ctx.expectedRounds}`);
    return pass;
  },
  "factory:awaiting-review"(ctx) {
    const { h, err } = need(ctx, "implement", "implement.v1"); if (err) return err;
    // 게이트 판정의 출처는 handoff가 아니라 러너가 쓴 파일이다 — handoff의 자기 신고는 대체재가 아니다.
    const g = gatesGate(ctx, "factory:awaiting-review"); if (g) return g;
    if (shaBound(ctx) && ctx.headSha && h.data.head_sha !== ctx.headSha) return fail(`implement head_sha ${h.data.head_sha.slice(0, 7)} != branch head ${ctx.headSha.slice(0, 7)}`);
    if (h.data.verifier.verdict === "rejected") return fail("verifier rejected");
    return pass;
  },
  "factory:approved"(ctx) {
    const { h, err } = need(ctx, "review", "review.v1"); if (err) return err;
    const g = gatesGate(ctx, "factory:approved"); if (g) return g;
    if (shaBound(ctx) && ctx.prHeadSha && h.data.head_sha !== ctx.prHeadSha) return fail(`review head_sha ${h.data.head_sha.slice(0, 7)} != PR head ${ctx.prHeadSha.slice(0, 7)}`);
    // 정족수·all-approve의 판정은 `lib/review-quorum.js` 한 곳이다(외부 감사 H1c) — handoff가 스스로
    // 적은 `decision`이 아니라 `must_fix`에서 aggregate로 다시 계산한다.
    // ADR-020 KTB-29 r1(SF1): **여기에 K 검사는 없다**(maxRounds를 넘기지 않는다). 예전에는 `round > K`면
    // approve까지 거부했다 — 그러면 라운드 4의 만장일치 통과가 그래프에서 튕기고, 이슈는
    // `awaiting-review`에 남아 stalled 팔에 두 번 재점화된 뒤 같은 사람에게 훨씬 느리고 시끄럽게
    // 올라간다. K는 **실패를 끊는 한도**이지 성공을 막는 한도가 아니다(스펙 §3.2의 엣지는
    // `rework → needs_human`이다) — 그 자리는 `nextState`다. 되돌릴 수 없는 `factory:merged`만 예외다(아래).
    const q = verifyReviewQuorum({ data: h.data, rosterSize: ctx.rosterSize ?? null, rosterRoles: ctx.roster || [] });
    if (!q.ok) return fail(q.reason);
    return pass;
  },
  "factory:merged"(ctx) {
    const { h, err } = need(ctx, "review", "review.v1"); if (err) return err;
    const g = gatesGate(ctx, "factory:merged"); if (g) return g;
    if (shaBound(ctx) && ctx.prHeadSha && h.data.head_sha !== ctx.prHeadSha) return fail(`approved handoff head_sha != PR head`);
    /**
     * 외부 감사 2026-09-14 H1c — **정족수를 여기서 다시 묻는다.** 예전에는 이 규칙이 `need(review)`로
     * handoff의 존재·스키마만 보고, 정족수·all-approve는 `factory:approved`에만 있었다. 그런데
     * `factory:approved` 라벨은 라벨 편집 한 번(훅 우회 — H1a)으로도 붙고, `merge-stage.js`는
     * `mergePr`를 **이 규칙이 평가되기 전에** 부른다(:476 merge → :487 transition). 곧 이 규칙이
     * 리뷰를 다시 세지 않는 동안, "리뷰어가 한 번도 뜨지 않은 머지"의 마지막 방어선이 비어 있었다.
     *
     * 여기서는 K도 묻는다(`factory:approved`와 달리 — 위 참고). KTB-29 이후 `nextState`가 `round >= K`인
     * rework을 곧장 needs-human으로 보내므로 `round > K`인 approve는 정상 경로에서 만들어지지 않는다 —
     * 그런 handoff는 이 그래프를 거치지 않고 생긴 것이고, 되돌릴 수 없는 단계 앞에서 통과시킬 이유가 없다.
     */
    const q = verifyReviewQuorum({ data: h.data, rosterSize: ctx.rosterSize ?? null, rosterRoles: ctx.roster || [], maxRounds: ctx.maxRounds ?? null });
    if (!q.ok) return fail(q.reason);
    if (ctx.prerequisite === true) return pass;
    /**
     * KTB-46 — 아래 두 검사는 **"지금 머지해도 되는가"**를 묻는다. 사람 머지 반영 경로에서 그 질문은
     * 이미 답이 나와 있다: 머지는 **일어났고**, 그것도 보호된 base 브랜치로 들어갔다 — `factory/integrity`는
     * 그 브랜치의 **required status check**라(ADR-015, `bootstrap.js`의 `L0_CONTEXTS`) 통과하지 않으면
     * GitHub이 사람의 머지 버튼조차 막는다. 즉 이 두 줄이 확인하려던 사실을 GitHub이 이미 강제했고,
     * sweeper가 그것을 다시 "확인"한다고 주장하는 것이야말로 지어낸 증거다.
     *
     * 반대로 **리뷰**는 GitHub이 강제하지 않는다 — 그래서 위의 정족수 all-approve·K 재계산과 handoff의
     * head sha 바인딩은 이 분기보다 **앞**에 있고, 여기까지 오려면 전부 통과해야 한다. `statusesVerified`를
     * 함께 요구하는 것은 `gatesGate`와 같은 이유다: `humanMerged` 한 플래그만으로는 아무것도 열리지 않는다.
     */
    if (ctx.humanMerged === true) return ctx.statusesVerified === true ? pass : fail(HUMAN_MERGE_STATUSES_UNVERIFIED);
    // 머지는 되돌릴 수 없다 — "확인하지 않았음"과 "확인해보니 RED"를 같게 취급한다(fail closed).
    if (ctx.checksGreen !== true) return fail("required checks not verified GREEN");
    if (ctx.integrityGreen !== true) return fail("integrity check not verified GREEN");
    return pass;
  },
};

export function requirementFor(toState) {
  return RULES[toState] || (() => pass);
}
