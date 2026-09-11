export const STATES = new Set([
  "backlog", "factory:queue", "factory:ready", "factory:needs-info", "factory:wont-do", "factory:planned",
  "factory:in-progress", "factory:awaiting-review", "factory:rework", "factory:approved", "factory:merged",
  "factory:blocked", "factory:needs-human",
]);

/** §3.2 전이 그래프. 키: from, 값: 허용된 to. */
export const TRANSITIONS = new Map([
  ["backlog", new Set(["factory:queue"])],
  ["factory:queue", new Set(["factory:ready", "factory:needs-info", "factory:wont-do", "factory:needs-human"])],
  ["factory:needs-info", new Set(["factory:queue"])],
  ["factory:ready", new Set(["factory:planned", "factory:needs-human"])],
  ["factory:planned", new Set(["factory:in-progress", "factory:needs-human"])],
  ["factory:in-progress", new Set(["factory:awaiting-review", "factory:blocked", "factory:needs-human", "factory:planned"])],   // sweeper 재큐
  // blocked = 환경/자격증명 실패로 sweeper가 needs-human으로 에스컬레이션한다(§3.2) — review·merge
  // 게이트가 BLOCKED로 끝나는 모든 스테이지에서 겪을 수 있으므로 두 상태 모두에서 빠져나가야 한다.
  ["factory:awaiting-review", new Set(["factory:approved", "factory:rework", "factory:needs-human", "factory:blocked"])],
  ["factory:rework", new Set(["factory:in-progress", "factory:needs-human"])],
  ["factory:approved", new Set(["factory:merged", "factory:needs-human", "factory:rework", "factory:blocked"])],   // merge-stage: conflict → rework, gates/API failure → blocked
  ["factory:blocked", new Set(["factory:needs-human", "factory:planned"])],
  ["factory:needs-human", new Set(["factory:queue"])],
  ["factory:merged", new Set([])],
  ["factory:wont-do", new Set([])],
]);

/** 목적 상태에 도달하려면 어느 스테이지의 handoff가 있어야 하는가 (§3.3). */
export const STAGE_OF_TARGET = {
  "factory:ready": "triage",
  "factory:planned": "plan",
  "factory:awaiting-review": "implement",
  "factory:approved": "review",
  "factory:merged": "merge",
};

export function canTransition(from, to) {
  const tos = TRANSITIONS.get(from);
  return Boolean(tos && tos.has(to));
}

/** 이슈 라벨 배열에서 factory 상태 라벨 하나를 고른다. 0개면 null, 2개 이상이면 throw. */
export function factoryLabelOf(labelNames) {
  const found = labelNames.filter((l) => STATES.has(l));
  if (found.length === 0) return null;
  if (found.length > 1) throw new Error(`issue must carry exactly one factory state label, found: ${found.join(", ")}`);
  return found[0];
}
