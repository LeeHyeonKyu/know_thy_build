import { canTransition, factoryLabelOf, HUMAN_RETRY_TARGETS } from "./labels.js";
import { requirementFor } from "./requirements.js";
import { blockedCause, blockedOriginMarker, lastHumanDecision, resumePoint, transitionFailedMarker } from "./retro/issue-comments.js";

export const NEEDS_HUMAN = "factory:needs-human";
export const RETRY_SCRIPT_REFUSED = "retry from factory:needs-human is human-only (transition.js --human)";
export const NO_RESUME_POINT = "cannot resolve a resume point from this issue's history — no transition into factory:blocked/needs-human names a label the factory can resume from";

/**
 * ADR-020 r2 (리뷰 (c)) — **전이 코멘트가 스왑보다 먼저 나가는 대가를 여기서 갚는다.** 그 순서는
 * 복구 팔이 부분 실패를 앞으로 잇게 하려고 고른 것인데(KTB-30 r1), 스왑이 **통째로** 실패하면 이슈에
 * 일어나지 않은 전이의 코멘트가 남는다. 그 한 줄은 두 곳에서 거짓이 된다: 사람이 읽는 이력(라벨은
 * 그대로인데 "옮겼다"고 적혀 있다)과 라운드 카운터(`countTransitionsTo`가 rework 하나로 센다 —
 * K=3에서 장애 두 번이면 멀쩡한 이슈가 예산을 다 쓴다). 그래서 실패한 스왑은 **실패했다고 적는다**:
 * `factory-transition-failed:v1`이 앞의 전이 하나를 무효로 만든다.
 *
 * 마커 코멘트 자체가 실패해도 원래 예외를 삼키지 않는다 — 호출자가 보고 기록해야 하는 것은 스왑
 * 실패이지 그 기록의 실패가 아니다.
 */
async function swapLabel({ gh, issue, from, to }) {
  try {
    return await gh.setFactoryLabel(issue, to);
  } catch (e) {
    try { await gh.comment(issue, `${transitionFailedMarker({ from, to })}\n**라벨 스왑 실패** ${from} → ${to}: ${String(e?.message || e).split("\n")[0].slice(0, 200)}\n\n바로 위의 전이 코멘트는 **일어나지 않았습니다** — 이 이슈의 상태 라벨은 \`${from}\` 그대로입니다(ADR-020 KTB-30).`); }
    catch { /* 기록의 실패가 원인을 가리지 않는다 */ }
    throw e;
  }
}

/**
 * `stage`(선택): 이 전이를 만든 스테이지 이름 — `to === "factory:blocked"`일 때만 쓰인다. run-stage의
 * 진입 가드(`lib/labels.js`의 `BLOCKED_RETRY`)와 sweeper의 blocked 팔이 "이 blocked이 어디서
 * 왔는가"를 다시 코멘트 이력을 파싱해 추측하지 않도록(KTB-15b I2), 그 사실을 전이가 일어나는
 * **바로 이 순간** 마커로 남긴다 — 이 함수가 유일한 출처다.
 */
export async function transition({ gh, issue, to, ctxExtra = {}, human = false, retry = false, reason = "", stage, cause }) {
  const it = await gh.issue(issue);
  const from = factoryLabelOf(it.labels);
  if (!from) return { ok: false, from, to, reason: "no factory state label on issue" };
  /**
   * ADR-020 KTB-32 — **사람의 재시도.** `needs-human`에서 중단 지점으로 되돌아가는 엣지는 그래프에
   * 없다(`labels.js`의 `HUMAN_RETRY_TARGETS`) — 여기서 두 자물쇠를 모두 풀어야 열린다:
   *   (a) `by=human`(`transition.js --human`)일 것. 스크립트는 이 분기에 들어오지도 못하고, 아래
   *       `canTransition`이 평소처럼 "그래프에 없는 전이"로 거부한다(라벨 불변, 거부 코멘트).
   *   (b) 목적 라벨이 이 이슈의 **중단 지점**과 같을 것(`resumePoint` — 이슈에 남은 기록만이 출처다).
   * `--retry`(라벨 없이)는 (b)를 그대로 목적 라벨로 삼는 축약이고, 라벨을 명시한 사람 전이도 **같은**
   * 검사를 지난다 — "사람이 골랐다"가 아무 자리로나 가는 문이 되지 않게.
   */
  let humanRetry = false, resume = null, comments = null;
  if (from === NEEDS_HUMAN && (retry || HUMAN_RETRY_TARGETS.has(to)) && human) {
    comments = await gh.comments(issue);
    resume = resumePoint(comments);
    if (!resume?.target) return { ok: false, from, to, reason: `${NO_RESUME_POINT}${resume ? ` (stopped at ${resume.stoppedAt})` : ""}` };
    if (to == null) to = resume.target;
    else if (to !== resume.target) return { ok: false, from, to, reason: `retry target ${to} is not this issue's resume point — it stopped at ${resume.stoppedAt}, so the only allowed target is ${resume.target}` };
    humanRetry = true;
  }
  // 스크립트가 이 엣지를 시도하면 아래 `canTransition`이 평소의 그래프 거부로 떨어뜨린다 — 라벨은
  // 그대로이고 거부 코멘트가 남는다(사람이 볼 수 있게). 목적 라벨조차 없는 `--retry`만 여기서
  // 끊는다: 거부 코멘트에 적을 `to`가 없고, 그 요청은 애초에 사람 전용 문법이다.
  if (to == null) return { ok: false, from, to, reason: retry ? RETRY_SCRIPT_REFUSED : "no target label (use `--retry` only from factory:needs-human)" };
  if (!canTransition(from, to, { human: humanRetry })) {
    const graphReason = `transition ${from} → ${to} not allowed`;
    // 그래프에 없는 전이는 라벨을 건드리지 않는다(어느 쪽으로도 안전한 기본값이 없다 — 예: merged/wont-do는
    // needs-human으로도 못 나간다) — 하지만 조용히 실패하지는 않는다. 사람이 볼 수 있게 코멘트는 남긴다.
    if (!human) await gh.comment(issue, `<!-- factory-transition-refused from=${from} to=${to} -->\n**전이 거부** ${from} → ${to}: ${graphReason}`);
    return { ok: false, from, to, reason: graphReason };
  }
  comments ??= await gh.comments(issue);
  // KTB-32: `humanRetry`는 `prerequisite`와 같은 것만 면제한다(이번 런의 게이트 파일·sha 바인딩 —
  // 사람의 노트북에는 존재할 수 없고, 그 판정은 스테이지가 다시 돌며 만든다). handoff의 존재와
  // 유효성은 그대로 물린다: 그것이 "구현이 온전하다"의 증거다. ctxExtra가 이 값을 덮지 못한다.
  const req = requirementFor(to)({ comments, ...ctxExtra, ...(humanRetry ? { humanRetry: true } : {}) });
  if (!req.ok) {
    if (human) return { ok: false, from, to, reason: req.reason };
    /**
     * ADR-020 r2 SF3 — **이 거부도 완료된 전이다**(`… → factory:needs-human`), 그래서 성공 경로와
     * 정확히 같은 두 가지를 한다: 코멘트가 스왑보다 **먼저** 나가고, 그 코멘트가 `factory-transition:v1`
     * 마커를 단다(`reason=refused`가 문법을 구분한다).
     *
     * r1까지는 반대였다(스왑 → 코멘트, 마커는 `factory-transition-refused`뿐). 그 순서에서 스왑이
     * 반만 성공하면(add는 됐고 remove가 실패) 라벨은 `{옛 것, needs-human}` 두 개이고 코멘트는 아예
     * 나가지 못했다 — 그러면 sweeper의 라벨-셋 복구 팔이 "최신 전이의 `to`"를 찾는데 그게 **이전**
     * 전이(옛 라벨)라, 방금 세운 에스컬레이션을 조용히 **되돌린다**. 사람은 아무것도 못 보고, 그
     * 스테이지는 같은 자리에서 두 번 더 죽는다(리뷰 finding 3: 리뷰 라운드 ~$10 × 2).
     */
    await gh.comment(issue, `<!-- factory-transition:v1 from=${from} to=factory:needs-human by=script reason=refused -->\n<!-- factory-transition-refused from=${from} to=${to} -->\n**전이 거부** ${from} → ${to}: ${req.reason}\n\n라벨을 \`factory:needs-human\`으로 옮겼습니다. 산출물을 보강한 뒤 \`:unstick\`으로 재개하세요.`);
    await swapLabel({ gh, issue, from, to: "factory:needs-human" });
    return { ok: false, from, to: "factory:needs-human", reason: req.reason };
  }
  // KTB-15b I2: blocked으로 가는 모든 성공한 전이는 그 자리에서 "어디서 왔는가"를 마커로 남긴다.
  // O20: 거기에 **왜**(원인 등급)도 싣는다 — 호출자가 알면 그 값이 이기고(잡 상태를 직접 본
  // `abortStage`), 모르면 사유 문구에서 되짚는다. sweeper의 blocked 팔이 재시도 예산과 에스컬레이션
  // 문구를 이 등급 하나로 가른다.
  const originMarker = to === "factory:blocked" ? `\n${blockedOriginMarker({ from, stage, cause: cause ?? blockedCause(reason) })}` : "";
  /**
   * ADR-020 KTB-30 r1 — **전이 코멘트가 라벨 스왑보다 먼저 나간다.** KTB-30이 라벨 스왑을 add-first로
   * 뒤집고(부분 실패의 모양이 "0개"에서 "2개"로 바뀌었다), sweeper의 두 복구 팔이 그 부분 실패를
   * **가장 최근 전이 코멘트의 `to`**로 잇는다. 그런데 그 코멘트가 스왑 **뒤에** 나가면, 스왑이 중간에
   * 끊긴 바로 그 순간(새 라벨은 붙었고 옛 라벨은 안 떨어졌다 = 라벨 2개)에는 코멘트가 아직 없다 —
   * 이슈에 남은 "가장 최근 전이"는 **이전** 전이이고 그 `to`는 옛 라벨이다. 복구는 그 옛 라벨 하나로
   * 이슈를 정리한다: 방금 성공한 전이를 조용히 되돌리는 것이고, 그 되돌림은 전이 코멘트조차 남기지
   * 않는다. 그래서 순서를 뒤집었다 — 기록이 의도를 먼저 말하고, 라벨이 그 뒤를 따른다.
   *
   * 반대 방향의 위험(코멘트는 나갔는데 스왑이 **통째로** 실패)은 훨씬 얕다: 라벨은 하나(옛 것) 그대로라
   * 두 복구 팔(2개일 때·0개일 때) 어느 쪽도 반응하지 않고, 스왑 실패는 예외로 튀어나가 호출자가
   * 기록한다. "거짓 성공 한 줄"과 "성공한 전이의 조용한 되돌림" 사이에서 앞을 골랐다.
   */
  // KTB-32: 재시도는 마커에 `reason=retry`를 싣는다 — 라운드 카운터(`countTransitionsTo`)가 그 한
  // 필드로 "이것은 새 재작업 주기가 아니다"를 읽고, 사람은 본문에서 근거(human-decision)와 중단
  // 지점을 함께 본다.
  const decision = humanRetry ? lastHumanDecision(comments) : null;
  const retryNote = humanRetry
    ? `\n\n중단 지점 \`${resume.stoppedAt}\`으로 되돌립니다(ADR-020 KTB-32) — 인프라가 끊은 자리이고 산출물은 그대로입니다. 근거: ${decision ? `이 이슈의 \`human-decision:v1\` 코멘트(skill=${decision.skill ?? "unknown"}${decision.at ? `, ${decision.at}` : ""})` : "`human-decision:v1` 코멘트를 찾지 못했습니다 — `:unstick`을 거치지 않은 수동 복구입니다"}. 이 전이는 리뷰 라운드로 세지 않습니다(재큐가 아닙니다).`
    : "";
  await gh.comment(issue, `<!-- factory-transition:v1 from=${from} to=${to} by=${human ? "human" : "script"}${humanRetry ? " reason=retry" : ""} -->\n${from} → ${to}${reason ? ` — ${reason}` : ""}${retryNote}${originMarker}`);
  const set = await swapLabel({ gh, issue, from, to });
  // KTB-30: 라벨을 쓴 뒤 확인에서 되살렸다면 그 사실은 이슈 이력에 남아야 한다 — 조용히 고친 라벨은
  // 다음 사고의 원인을 지운다(`setFactoryLabel`이 없는 구형 더블은 undefined를 돌려준다). 전이 코멘트가
  // 이미 나간 뒤이므로 별도의 한 줄로 남긴다 — 이 코멘트는 전이 마커를 들고 있지 않아 `lastTransition`을
  // 흔들지 않는다.
  const repaired = set?.verify === "repaired";
  if (repaired) await gh.comment(issue, `<!-- factory-label-verify issue=${issue} to=${to} -->\nlabel verify: repaired — \`${to}\`가 쓰기 직후 조회에 없어 다시 붙였습니다(KTB-30).`);
  return { ok: true, from, to, ...(repaired ? { labelVerify: "repaired" } : {}) };
}

/**
 * `bin/transition.js`의 인자 파서. **그 파일은 import되는 즉시 실행되므로**(gh·git을 부른다) 파싱만
 * 여기로 내려 테스트가 붙을 수 있게 한다.
 *
 * 형태: `<issue> [<to-label>] [--human] [--retry] [--reason <text>]`. 라벨은 생략할 수 있고
 * (그때는 `--retry`가 중단 지점을 목적 라벨로 삼는다), 플래그 순서는 자유다.
 * 오류는 던지지 않고 `{ error }`로 돌려준다 — 호출자가 usage와 함께 exit 1 한다.
 */
export function parseTransitionArgs(argv = []) {
  const positional = [];
  let human = false, retry = false, reason = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--human") human = true;
    else if (a === "--retry") retry = true;
    else if (a === "--reason") reason = argv[++i] ?? "";
    else if (String(a).startsWith("--")) return { error: `unknown option ${a}` };
    else positional.push(a);
  }
  const [issue, to = null] = positional;
  if (!issue || !Number(issue)) return { error: "usage: issue number is required" };
  if (!to && !retry) return { error: "usage: a target label is required (or `--human --retry` to resume from the stop point)" };
  if (retry && !human) return { error: "--retry is human-only: add --human (the retry edge exists only for a person's decision, ADR-020 KTB-32)" };
  return { issue: Number(issue), to, human, retry, reason };
}
