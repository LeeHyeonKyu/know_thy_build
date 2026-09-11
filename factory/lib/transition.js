import { canTransition, factoryLabelOf } from "./labels.js";
import { requirementFor } from "./requirements.js";

export async function transition({ gh, issue, to, ctxExtra = {}, human = false, reason = "" }) {
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
  await gh.comment(issue, `<!-- factory-transition:v1 from=${from} to=${to} by=${human ? "human" : "script"} -->\n${from} → ${to}${reason ? ` — ${reason}` : ""}`);
  return { ok: true, from, to };
}
