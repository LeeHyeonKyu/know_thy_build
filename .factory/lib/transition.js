import { canTransition, factoryLabelOf } from "./labels.js";
import { requirementFor } from "./requirements.js";

/**
 * `stage`(선택): 이 전이를 만든 스테이지 이름 — `to === "factory:blocked"`일 때만 쓰인다. run-stage의
 * 진입 가드(`lib/labels.js`의 `BLOCKED_RETRY`)와 sweeper의 blocked 팔이 "이 blocked이 어디서
 * 왔는가"를 다시 코멘트 이력을 파싱해 추측하지 않도록(KTB-15b I2), 그 사실을 전이가 일어나는
 * **바로 이 순간** 마커로 남긴다 — 이 함수가 유일한 출처다.
 */
export async function transition({ gh, issue, to, ctxExtra = {}, human = false, reason = "", stage }) {
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
  await gh.setFactoryLabel(issue, to);
  // KTB-15b I2: blocked으로 가는 모든 성공한 전이는 그 자리에서 "어디서 왔는가"를 마커로 남긴다.
  const originMarker = to === "factory:blocked" ? `\n<!-- factory-blocked-origin from=${from} stage=${stage ?? "unknown"} -->` : "";
  await gh.comment(issue, `<!-- factory-transition:v1 from=${from} to=${to} by=${human ? "human" : "script"} -->\n${from} → ${to}${reason ? ` — ${reason}` : ""}${originMarker}`);
  return { ok: true, from, to };
}
