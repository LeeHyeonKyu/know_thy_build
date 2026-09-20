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
  // review도 blocked에서 재진입한다(ADR-020 KTB-24 fix): KTB-24가 만든 `Aborted cleanup`이
  // 잘린 review 잡의 `factory:awaiting-review`를 `factory:blocked`으로 세우는데, review만 재시도
  // 표에 없어서 그 이슈는 **항상** 곧장 needs-human으로 갔다 — 잘린 원인이 "판정이 틀렸다"가 아니라
  // "시간이 모자랐다"인데도. 45분에 잘린 데모 #15가 정확히 그 경우다(한도는 90으로 올랐다).
  review: ["factory:awaiting-review", "factory:blocked"],
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
  // 최종 리뷰 nit 1 — origin은 `factory:in-progress` 하나다. `factory:planned`는 **도달할 수 없었다**:
  // 그래프에 `planned → blocked` 엣지가 없고(아래 TRANSITIONS), `abortStage`는 라벨이 그 스테이지의
  // in-flight 라벨일 때만(`implement` → `in-progress`) blocked으로 민다. hop이 여전히 `planned`인 것은
  // 그대로다 — implement 자신의 무조건적인 `planned → in-progress` 전이가 그 자리를 다시 채운다.
  implement: { origins: ["factory:in-progress"], hop: "factory:planned" },
  // review(ADR-020 KTB-24 fix): origin이 `factory:awaiting-review`면 그 blocked은 리뷰가
  // **끝나기 전에** 잘렸다는 뜻이다(잡 타임아웃·취소 → `abortStage`, 또는 게이트 판정 불가).
  // 되돌아갈 자리는 그 스테이지 자신의 진입 라벨이고, 라운드 카운터는 **완료된 rework 전이**로 세므로
  // (`reviewRounds`, r1 SF2) 재작업까지 가지 못한 런은 예산을 쓰지 않는다 — 재시도는 공짜에 가깝다.
  review: { origins: ["factory:awaiting-review"], hop: "factory:awaiting-review" },
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
  // in-progress → needs-info(ADR-020 KTB-23): builder가 보호 경로 변경 없이는 done_when을 끝낼 수
  // 없다고 보고하면(implement handoff의 `harness_needed`) L1이 `factory:harness` 이슈를 하나 열고 이
  // 이슈를 **주차**한다. 그건 "사람이 판단할 것이 있다"(needs-human)도 "판정 불가"(blocked)도 아니다 —
  // 무엇이 필요한지는 정확히 알고 있고, 그것이 머지되면 다시 큐로 돌아온다. needs-info의 기존 출구
  // (`needs-info → queue`)가 그 복귀 경로이고, merge 스테이지가 하네스 PR을 머지한 뒤 그 전이를 만든다.
  ["factory:in-progress", new Set(["factory:awaiting-review", "factory:blocked", "factory:needs-human", "factory:needs-info", "factory:planned"])],   // sweeper 재큐
  // blocked = 환경/자격증명 실패로 sweeper가 needs-human으로 에스컬레이션한다(§3.2) — review·merge
  // 게이트가 BLOCKED로 끝나는 모든 스테이지에서 겪을 수 있으므로 두 상태 모두에서 빠져나가야 한다.
  // awaiting-review → needs-info(리뷰 효율 Task 8, Structure G): 리뷰 진입 가드가 이 피처를 막는 열린
  // `factory:harness` 이슈를 발견하면, 이슈 안의 어떤 변경으로도 못 고칠 must_fix를 리뷰어에게 다시
  // 재보고시키는 대신(KTB #3 spec1×2) 하네스 주차와 같은 문법으로 여기 세운다. KTB-23의
  // `in-progress → needs-info` 주차와 같은 계열의 엣지이고, 복귀 경로도 같다(`sweepHarnessUnpark`가
  // 하네스 이슈가 닫히면 `needs-info → queue`로 되돌린다).
  ["factory:awaiting-review", new Set(["factory:approved", "factory:rework", "factory:needs-human", "factory:blocked", "factory:needs-info"])],
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
  // blocked → rework(KTB-19 review I-2): a merge retry-from-blocked (label still `factory:blocked`
  // until step (4b) re-confirms gates GREEN) can find the PR CONFLICTING at step (2) — that's a
  // "rebase and rework" outcome, not "needs a human to decide", and previously had no edge here at
  // all (the graph refused it and posted a confusing graph-refusal comment instead of routing to rework).
  // blocked → awaiting-review(ADR-020 KTB-24 fix): 잘린 review 잡이 세운 blocked을 되돌리는 엣지다.
  // 그 hop은 "리뷰가 통과했다"는 주장이 아니라 **이미 얻었던 라벨의 복구**이므로, run-stage가 그
  // 전이를 `prerequisite: true`로 건다 — 이번 런에는 아직 게이트 파일도 sha 바인딩도 없다(방금
  // resetGates 직전이고, 애초에 fresh checkout이다). 실제 판정은 이 스테이지가 다시 돌면서 만든다.
  ["factory:blocked", new Set(["factory:needs-human", "factory:queue", "factory:ready", "factory:planned", "factory:awaiting-review", "factory:approved", "factory:rework"])],
  /**
   * KTB-46 — **`needs-human → merged`.** 스펙 §12.3-2의 예외 경로(보호 경로 PR은 사람이 머지한다)가
   * 이 엣지 없이는 끝나지 않았다: merge 스테이지가 단계 (3)에서 자동 머지를 거부하고 이슈를
   * `factory:needs-human`으로 올린 뒤 사람이 GitHub에서 squash-merge 하면, 그 이슈를 `factory:merged`로
   * 옮길 길이 그래프에 **하나도** 없었다(KTB #3: `Closes #n`도 안 걸려 이슈는 열린 채였고, 머지 뒤
   * 실행되는 merge 단계 (9)는 이 경로에서 아예 돌지 않는다). 운영자가 손으로 라벨을 붙이고 닫았다.
   *
   * 이 엣지는 **평범한 그래프 엣지**다 — `HUMAN_RETRY_TARGETS`(사람 전용)가 아니다. 이유는 방향이
   * 반대이기 때문이다: 사람 전용 엣지는 "사람의 판단이 요구조건을 대신한다"는 자리이고, 여기서
   * 필요한 것은 그 반대 — sweeper라는 **스크립트**가 밟아야 하고, 대신 `requirementFor("factory:merged")`
   * 의 증거 검사(review handoff · 정족수 all-approve · K · 게이트 · PR head sha 바인딩)는 한 칸도
   * 깎이지 않는다. 사람이 리뷰를 거치지 않은 `claude/fq-<n>` PR을 머지해 버리면 그 전이는 거부되고
   * 이슈는 needs-human에 그대로 남는다. **사람의 머지가 예외이지 증거가 예외인 것이 아니다.**
   *
   * `factory:merged`는 여전히 막다른 상태다(아래 `["factory:merged", new Set([])]`) — 이 엣지는
   * 들어가는 문 하나를 더 여는 것이지 나오는 문을 만들지 않는다.
   */
  ["factory:needs-human", new Set(["factory:queue", "factory:merged"])],
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

/**
 * ADR-020 KTB-32 — **`needs-human`에서 중단 지점으로 되돌아가는 사람 전용 엣지.**
 *
 * 라운드 10의 데모 #2는 implement가 끝나 PR(+1239/−11, 실제 pg 통합 테스트)이 온전한 채 review에서
 * 429로 죽었는데, `factory:needs-human`의 유일한 출구가 `→ factory:queue`(§3.2)라 사람이 내릴 수
 * 있는 결정은 "plan부터 다시"(이슈당 ≈ 1시간·$40)뿐이었다. 잃은 것은 코드가 아니라 **라벨 한 칸**이다.
 *
 * 이 엣지들은 `TRANSITIONS`에 넣지 않는다 — 그래프에 넣으면 스크립트도 밟을 수 있고, 그러면 어떤
 * 스테이지든 판정을 건너뛰고 자기가 원하는 자리로 이슈를 옮길 수 있다. 대신 `canTransition`의
 * `{human:true}`에서만 열리고, 그 위에 `lib/transition.js`가 두 번째 자물쇠를 건다: 목적 라벨이
 * 이 이슈의 **중단 지점**(`resumePoint`, 마지막 `→ blocked|needs-human` 전이의 `from`)과 정확히
 * 같아야 한다. 사람의 의도만으로는 부족하고, 이슈에 남은 기록이 그 자리를 증언해야 한다.
 *
 * 목록에 `factory:queue`가 없는 이유: 그것은 사람 전용이 아니라 그래프의 정규 출구다(`:unstick`의
 * 재큐·분할·범위 축소가 계속 쓴다). 목록의 넷은 전부 어느 스테이지의 **정상 진입 라벨**이다 —
 * 되돌아간 자리에서 그 스테이지가 처음부터 정상적으로 이어진다.
 *
 * **확장(KTB-36 라운드): `factory:needs-info`도 같은 문을 받는다.** 그 라벨은 두 가지 뜻을 겸하는데
 * (triage의 "이슈가 모호하다"와 KTB-23의 하네스 대기 주차), 후자는 implement **한가운데서** 선다:
 * builder가 `harness_needed`를 채우면 L1이 하네스 이슈를 하나 열고 이 이슈를 `in-progress →
 * needs-info`로 주차한다. 그리고 그 하네스 PR은 구성상 보호 경로를 건드리므로 **사람이** 머지한다.
 * 사람이 손으로 고치고 돌아왔을 때 §3.2가 준 길은 `→ queue` 하나뿐이라, 플랜이 한 글자도 바뀌지
 * 않았는데 plan을 처음부터 다시 돌았다 — KTB-32가 `needs-human`에서 고친 것과 **같은** 낭비다.
 * sweeper의 자동 해제 팔은 그대로 `→ queue`다(스크립트는 이 엣지를 밟을 수 없다): 사람이 플랜을
 * 건드리지 않았다고 **판단**했을 때만 `--retry`가 중단 지점으로 되돌린다. triage의 needs-info는
 * `queue`에서 왔으므로 `resumePoint`가 재개할 자리를 찾지 못하고 재시도가 거부된다 — 그 이슈는
 * 실제로 보강 후 재큐가 맞다.
 */
export const HUMAN_RETRY_TARGETS = new Set([
  "factory:ready",              // triage까지 끝났다 → plan부터
  "factory:planned",            // plan까지 끝났다 → implement부터
  "factory:rework",             // implement까지 끝났고 리뷰 지적이 있었다 → implement(재작업)부터
  "factory:awaiting-review",    // implement가 끝났다 → review만 다시 돈다(#2·KTB #3이 이 자리였다)
]);
export const HUMAN_ONLY_TRANSITIONS = new Map([
  ["factory:needs-human", HUMAN_RETRY_TARGETS],
  ["factory:needs-info", HUMAN_RETRY_TARGETS],
]);
/** 사람의 `--retry`가 열리는 출발 라벨. `transition.js`의 두 번째 자물쇠가 이 집합을 읽는다. */
export const HUMAN_RETRY_FROM = new Set(HUMAN_ONLY_TRANSITIONS.keys());

/**
 * `opts.human`은 **사람이 직접 실행했다**는 사실(transition.js `--human`)이지 "검사를 건너뛴다"가
 * 아니다 — 그래프의 나머지는 사람에게도 그대로 물린다(merged → 어디로도 못 간다).
 */
export function canTransition(from, to, { human = false } = {}) {
  const tos = TRANSITIONS.get(from);
  if (tos && tos.has(to)) return true;
  if (!human) return false;
  const humanTos = HUMAN_ONLY_TRANSITIONS.get(from);
  return Boolean(humanTos && humanTos.has(to));
}

/** 이슈 라벨 배열에서 factory 상태 라벨 하나를 고른다. 0개면 null, 2개 이상이면 throw. */
export function factoryLabelOf(labelNames) {
  const found = labelNames.filter((l) => STATES.has(l));
  if (found.length === 0) return null;
  if (found.length > 1) throw new Error(`issue must carry exactly one factory state label, found: ${found.join(", ")}`);
  return found[0];
}
