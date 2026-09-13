import { canTransition, factoryLabelOf } from "./labels.js";
import { requirementFor } from "./requirements.js";
import { blockedCause, blockedOriginMarker } from "./retro/issue-comments.js";

/**
 * `stage`(선택): 이 전이를 만든 스테이지 이름 — `to === "factory:blocked"`일 때만 쓰인다. run-stage의
 * 진입 가드(`lib/labels.js`의 `BLOCKED_RETRY`)와 sweeper의 blocked 팔이 "이 blocked이 어디서
 * 왔는가"를 다시 코멘트 이력을 파싱해 추측하지 않도록(KTB-15b I2), 그 사실을 전이가 일어나는
 * **바로 이 순간** 마커로 남긴다 — 이 함수가 유일한 출처다.
 */
export async function transition({ gh, issue, to, ctxExtra = {}, human = false, reason = "", stage, cause }) {
  const it = await gh.issue(issue);
  const from = factoryLabelOf(it.labels);
  if (!from) return { ok: false, from, to, reason: "no factory state label on issue" };
  if (!canTransition(from, to)) {
    const graphReason = `transition ${from} → ${to} not allowed`;
    // 그래프에 없는 전이는 라벨을 건드리지 않는다(어느 쪽으로도 안전한 기본값이 없다 — 예: merged/wont-do는
    // needs-human으로도 못 나간다) — 하지만 조용히 실패하지는 않는다. 사람이 볼 수 있게 코멘트는 남긴다.
    if (!human) await gh.comment(issue, `<!-- factory-transition-refused from=${from} to=${to} -->\n**전이 거부** ${from} → ${to}: ${graphReason}`);
    return { ok: false, from, to, reason: graphReason };
  }
  const comments = await gh.comments(issue);
  const req = requirementFor(to)({ comments, ...ctxExtra });
  if (!req.ok) {
    if (human) return { ok: false, from, to, reason: req.reason };
    await gh.setFactoryLabel(issue, "factory:needs-human");
    await gh.comment(issue, `<!-- factory-transition-refused from=${from} to=${to} -->\n**전이 거부** ${from} → ${to}: ${req.reason}\n\n라벨을 \`factory:needs-human\`으로 옮겼습니다. 산출물을 보강한 뒤 \`:unstick\`으로 재개하세요.`);
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
  await gh.comment(issue, `<!-- factory-transition:v1 from=${from} to=${to} by=${human ? "human" : "script"} -->\n${from} → ${to}${reason ? ` — ${reason}` : ""}${originMarker}`);
  const set = await gh.setFactoryLabel(issue, to);
  // KTB-30: 라벨을 쓴 뒤 확인에서 되살렸다면 그 사실은 이슈 이력에 남아야 한다 — 조용히 고친 라벨은
  // 다음 사고의 원인을 지운다(`setFactoryLabel`이 없는 구형 더블은 undefined를 돌려준다). 전이 코멘트가
  // 이미 나간 뒤이므로 별도의 한 줄로 남긴다 — 이 코멘트는 전이 마커를 들고 있지 않아 `lastTransition`을
  // 흔들지 않는다.
  const repaired = set?.verify === "repaired";
  if (repaired) await gh.comment(issue, `<!-- factory-label-verify issue=${issue} to=${to} -->\nlabel verify: repaired — \`${to}\`가 쓰기 직후 조회에 없어 다시 붙였습니다(KTB-30).`);
  return { ok: true, from, to, ...(repaired ? { labelVerify: "repaired" } : {}) };
}
