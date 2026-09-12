export const STATES = new Set([
  "backlog", "factory:queue", "factory:ready", "factory:needs-info", "factory:wont-do", "factory:planned",
  "factory:in-progress", "factory:awaiting-review", "factory:rework", "factory:approved", "factory:merged",
  "factory:blocked", "factory:needs-human",
]);

/**
 * §3.2 tier 라벨. 상태 라벨과 **직교**한다 — 동시에 붙어 있고 전이 그래프에 참여하지 않는다.
 * 다만 한 이슈에 하나뿐이다(tier는 triage의 단일 판정이다). 카탈로그 정의는 `label-catalog.js`.
 */
export const TIERS = ["docs", "standard", "load-bearing"];
export const tierLabel = (tier) => `factory:tier-${tier}`;
export const TIER_LABELS = new Set(TIERS.map(tierLabel));

/**
 * §3.2 전이 그래프를 스테이지 쪽에서 본 것: **이 스테이지가 진입할 때 이슈가 갖고 있어야 하는 상태**.
 * `TRANSITIONS`의 from 중 그 스테이지가 출발점으로 삼는 것들이다(implement만 두 개 — 첫 구현과 재작업).
 * run-stage의 진입 가드(KTB-10)가 이것으로 "이미 지나간 스테이지를 다시 돌리는 런"을 즉시 되돌린다.
 */
export const ENTRY_LABELS = {
  triage: ["factory:queue", "factory:blocked"],
  plan: ["factory:ready", "factory:blocked"],
  implement: ["factory:planned", "factory:rework", "factory:blocked"],
  review: ["factory:awaiting-review"],
  merge: ["factory:approved", "factory:blocked"],
};

/**
 * KTB-15b I2 — 네 스테이지 모두 `factory:blocked`에서 재진입할 수 있게 됐지만(위 ENTRY_LABELS),
 * 재시도할 값어치가 있는 것은 그 blocked이 **그 스테이지 자신의 정상 진입 라벨에서** 왔을 때뿐이다.
 * "어디서 왔는가"는 더 이상 코멘트 이력을 다시 파싱해 추측하지 않는다 — `lib/transition.js`가
 * blocked으로 가는 모든 성공한 전이에 `factory-blocked-origin` 마커를 즉시 남기고(전이가 일어나는
 * 바로 그 순간이 유일한 출처다), run-stage의 진입 가드(`ENTRY_LABELS`)와 sweeper의 blocked 팔이
 * 둘 다 그 마커 하나로 판정한다.
 *
 * `origins`: 이 값과 일치해야 재시도를 허용한다(그 외 어디서 왔든 → 거부, 전이 없이 exit 2).
 * `hop`: origin이 확인된 뒤 blocked에서 **곧장 되돌아갈** 라벨 — 그래야 스테이지의 나머지 로직이
 * "정상적으로 그 라벨에서 시작한" 것과 똑같이 이어진다. implement는 origin이 `in-progress`여도
 * `planned`로 되돌아간다 — implement 자신의 무조건적인 `planned → in-progress` 전이(맨 위)가
 * 그대로 다시 그 자리를 채우기 때문에, 두 origin을 따로 다룰 필요가 없다.
 *
 * merge만 이 표로 되돌아가지 않는다(run-stage.js가 merge를 여기서 제외하고 넘긴다) — 머지는
 * "라벨을 되돌리는 것" 자체가 게이트를 다시 GREEN으로 확인했다는 증거여야 해서, 그 hop을
 * run-stage 진입 시점이 아니라 `merge-stage.js`가 게이트를 재확인한 **뒤**에 한다(retryFromBlocked).
 */
export const BLOCKED_RETRY = {
  triage: { origins: ["factory:queue"], hop: "factory:queue" },
  plan: { origins: ["factory:ready"], hop: "factory:ready" },
  implement: { origins: ["factory:planned", "factory:in-progress"], hop: "factory:planned" },
  merge: { origins: ["factory:approved"], hop: "factory:approved" },
};

/** §3.2 전이 그래프. 키: from, 값: 허용된 to. */
export const TRANSITIONS = new Map([
  ["backlog", new Set(["factory:queue"])],
  // queue·ready에서도 blocked로 나갈 수 있어야 한다(KTB-16/KTB-14 r1). "판정 불가"(턴 한도로 잘린
  // 런, `git status`가 실패해 워크트리를 증명할 수 없는 런)는 어느 스테이지에서나 생기는데, 이 두
  // 상태에 그 출구가 없으면 triage·plan은 blocked를 요청했다가 그래프에 거부당해 **라벨이 그대로
  // 남는다** — 같은 이슈가 아무 표식 없이 제자리에 앉아 있게 된다. blocked는 막다른 곳이 아니다:
  // sweeper가 유예 뒤 needs-human으로 올리고, needs-human → queue로 다시 돈다.
  ["factory:queue", new Set(["factory:ready", "factory:needs-info", "factory:wont-do", "factory:needs-human", "factory:blocked"])],
  ["factory:needs-info", new Set(["factory:queue"])],
  ["factory:ready", new Set(["factory:planned", "factory:needs-human", "factory:blocked"])],
  ["factory:planned", new Set(["factory:in-progress", "factory:needs-human"])],
  ["factory:in-progress", new Set(["factory:awaiting-review", "factory:blocked", "factory:needs-human", "factory:planned"])],   // sweeper 재큐
  // blocked = 환경/자격증명 실패로 sweeper가 needs-human으로 에스컬레이션한다(§3.2) — review·merge
  // 게이트가 BLOCKED로 끝나는 모든 스테이지에서 겪을 수 있으므로 두 상태 모두에서 빠져나가야 한다.
  ["factory:awaiting-review", new Set(["factory:approved", "factory:rework", "factory:needs-human", "factory:blocked"])],
  ["factory:rework", new Set(["factory:in-progress", "factory:needs-human"])],
  ["factory:approved", new Set(["factory:merged", "factory:needs-human", "factory:rework", "factory:blocked"])],   // merge-stage: conflict → rework, gates/API failure → blocked
  // blocked → approved(KTB-15): merge 스테이지는 **머지만** 실패해도 blocked로 떨어진다(draft
  // 뒤집기 실패, `gh pr merge` API 실패, 게이트 판정 불가). 그 런은 리뷰까지 전부 통과한 이슈이고
  // 고쳐야 할 것은 코드가 아니라 머지 한 걸음이라, 되돌아갈 자리는 planned가 아니라 approved다
  // (planned로 보내면 이미 GREEN인 구현을 통째로 다시 돈다). 요구조건은 그대로 물린다 —
  // `requirements.js`의 `factory:approved` 규칙이 review handoff + 이번 런의 GREEN gates 파일 +
  // PR head 일치를 계속 요구하므로, 이 엣지가 "승인을 건너뛰는 문"이 되지는 않는다.
  // 사람 경로였던 `transition.js <n> factory:approved --human`은 KTB-15b로 사라졌다 — 재시도는
  // 이제 `factory run merge <n> --remote`(또는 sweeper의 한 번짜리 자동 재시도)뿐이다.
  // blocked → queue/ready(KTB-15b): triage·plan도 같은 이유로 재시도 엣지가 필요하다 — 판정 불가로
  // blocked에 떨어진 런은 코드가 아니라 그 스테이지 자체를 다시 도는 게 맞고(BLOCKED_RETRY), 그
  // hop은 언제나 **그 스테이지의 정상 진입 라벨**로 되돌아간다.
  ["factory:blocked", new Set(["factory:needs-human", "factory:queue", "factory:ready", "factory:planned", "factory:approved"])],
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
