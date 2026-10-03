/**
 * §3.1 라벨 카탈로그. `factory bootstrap`이 이 목록 그대로 `gh label create --force`를 돌려 색·설명을
 * 항상 최신으로 맞춘다. 색상은 `#` 없는 6-hex(gh label create --color가 받는 형식) 그대로 둔다.
 *
 * 참고(§3.1 표): 스펙 표는 backlog를 포함해 13행이지만, `factory:` 접두가 붙는 "상태" 라벨은
 * queue/ready/needs-info/wont-do/planned/in-progress/awaiting-review/rework/approved/merged/blocked/needs-human
 * 12개뿐이다(backlog는 "factory 라벨이 아니"라고 스펙이 명시). 이 파일의 소스오브트루스는 아래 12개 색상
 * 쌍(§3.1과 1:1 대응)이며, 총 라벨 수는 backlog(1) + 상태(12) + 보조(7) = 20개다.
 *
 * **상태 라벨과 분류 라벨은 다른 것이다.** 전이 그래프(`labels.js`의 `STATES`/`TRANSITIONS`)에 있는
 * 것만 상태다. `factory:harness`·`factory:flaky`·`factory-improvement`는 그래프 밖의 분류로, 상태
 * 라벨과 **동시에** 붙는다 — 그래서 이 파일에 라벨을 더하는 것이 전이 그래프를 건드리지 않는다.
 */
/**
 * `factory:harness` 라벨 이름의 단일 출처. `bin/run-stage.js`(implement 진입 시 harness 이슈 판정)와
 * `bin/retro.js`(승격 이슈 생성·dedup 조회)가 각자 리터럴을 갖고 있던 것을 여기로 모은다 — 세 곳이
 * 갈라지면 retro가 만든 이슈를 run-stage가 못 알아보는 조용한 드리프트가 생긴다.
 */
export const HARNESS_LABEL = "factory:harness";

/**
 * 피드백 루프(스펙 §2·§7)가 **upstream 저장소(know-thy-build 자신)에** 여는 이슈의 라벨.
 *
 * 이름에 `factory:` 접두가 없는 것은 의도다: 이 라벨은 팩토리가 도는 저장소의 상태가 아니라 **KTB
 * 저장소 자신의 백로그 분류**이고, 그 저장소에서 `factory:*`는 이미 제 이슈들의 상태 궤적을 뜻한다.
 * 두 뜻이 한 접두를 나눠 쓰면 `factoryLabelOf`가 이 분류를 상태로 읽는 순간이 온다.
 *
 * 스펙 §10 Q4 — 이 이슈는 `backlog`으로 착지한다(`factory:queue`가 아니다). 팩토리가 자기 자신에
 * 대해 무엇을 먼저 고칠지는 사람이 고른다. 루프는 이슈를 열 뿐 KTB도 하네스도 스스로 고치지 않는다.
 */
export const IMPROVEMENT_LABEL = "factory-improvement";

/**
 * Task 4 — 주기 건강 보고서가 사는 **오래 사는 이슈 하나**의 표식. 상태 라벨이 아니다(전이 그래프는
 * 이 라벨을 모른다): 이 이슈는 공장이 처리하는 일감이 아니라 주인이 읽는 대화다. 하나뿐이어야 하는
 * 이유는 멱등이다 — 주간 잡이 매번 새 이슈를 열면 T3의 라우팅 영수증 마커가 앵커를 잃고, 같은 지문이
 * 매주 상류에 새 이슈를 연다.
 */
export const HEALTH_LABEL = "factory:health";

/**
 * #178 (S4a-1, ADR-033) — **소유자의 거부권.** 엔진 저장소가 판정 경로 PR을 스스로 머지하기 전 여는 창 동안 이 라벨이
 * 붙으면 머지는 사람에게 넘어간다 — 그 창과 읽는 쪽은 S4a-2다. 지금은 카탈로그에 정의만 있고 아무도 붙이거나 읽지 않는다.
 * 상태 라벨이 아니다: tier 라벨처럼 상태와 공존하고, 전이 그래프(`labels.js`의 `STATES`/`TRANSITIONS`)는 이 라벨을 모른다.
 */
export const VETO_LABEL = "factory:veto";
/**
 * 그 라벨의 정의(색·설명). **`LABELS` 배열 밖에 둔다** — `bootstrap.test.js`가 bootstrap이 만드는 라벨 수를 21로 못 박고
 * 있고, #178은 그 테스트를 `tests_changed_allowed:`에 올리지 않았다. bootstrap에 합치는 것은 후속 이슈의 몫이다.
 * 정의를 얻는 쪽은 `catalogLabel`로 이름을 찾는다.
 */
export const VETO_LABEL_SPEC = Object.freeze({ name: VETO_LABEL, color: "000000", description: "소유자의 거부권 — 엔진의 자동 머지를 막고 사람 머지로 돌린다" });

/** 카탈로그 조회 — `LABELS`(bootstrap이 만드는 21개)와 `VETO_LABEL_SPEC`을 이름으로 한 곳에서 찾는다. 없으면 null. */
export function catalogLabel(name) {
  if (name === VETO_LABEL) return { ...VETO_LABEL_SPEC };
  const l = LABELS.find((x) => x.name === name);
  return l ? { ...l } : null;
}

export const LABELS = [
  { name: "backlog", color: "c5def5", description: "스펙은 있으나 착수하지 않음" },

  { name: "factory:queue", color: "0e8a16", description: "착수 요청 — triage 대상" },
  { name: "factory:ready", color: "1d76db", description: "triage 통과, tier 결정됨" },
  { name: "factory:needs-info", color: "fbca04", description: "이슈가 모호함 — 사람이 보강 후 queue로" },
  { name: "factory:wont-do", color: "cccccc", description: "CHARTER NEVER_AUTOMATE 해당" },
  { name: "factory:planned", color: "5319e7", description: "토론 완료, plan handoff 있음" },
  { name: "factory:in-progress", color: "0052cc", description: "브랜치 claim됨, 구현 중" },
  { name: "factory:awaiting-review", color: "d4c5f9", description: "PR 있음, gates GREEN" },
  { name: "factory:rework", color: "e99695", description: "리뷰 reject, must_fix 있음" },
  { name: "factory:approved", color: "0e8a16", description: "리뷰어 전원 approve" },
  { name: "factory:merged", color: "6f42c1", description: "머지 완료, 이슈 closed" },
  { name: "factory:blocked", color: "b60205", description: "환경·크리덴셜 문제 — sweeper 대상" },
  { name: "factory:needs-human", color: "b60205", description: "하드 한계 초과 또는 handoff 불일치" },

  { name: "factory:tier-docs", color: "bfdadc", description: "문서 tier — 가벼운 리뷰 로스터" },
  { name: "factory:tier-standard", color: "bfdadc", description: "표준 tier — 기본 리뷰 로스터" },
  { name: "factory:tier-load-bearing", color: "bfdadc", description: "핵심 tier — 강화된 리뷰 로스터" },
  { name: "factory:retro-proposal", color: "f9d0c4", description: "retro가 만든 개선 제안 PR" },
  { name: "factory:flaky", color: "fef2c0", description: "불안정한 테스트로 격리됨" },
  { name: HARNESS_LABEL, color: "c2e0c6", description: "harness 자체에 관한 이슈" },
  { name: IMPROVEMENT_LABEL, color: "d93f0b", description: "팩토리가 제 증거로 올린 KTB 개선 요청 (사람이 트리아지)" },
  { name: HEALTH_LABEL, color: "bfd4f2", description: "주기 건강 보고서가 사는 이슈 — 공장 자신의 행동 지표" },
];
