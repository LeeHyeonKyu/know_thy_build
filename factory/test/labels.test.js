import { test, expect } from "vitest";
import { STATES, canTransition, factoryLabelOf, STAGE_OF_TARGET, ENTRY_LABELS, BLOCKED_RETRY, HUMAN_RETRY_TARGETS, HUMAN_ONLY_TRANSITIONS } from "../lib/labels.js";
import { HARNESS_LABEL } from "../lib/label-catalog.js";
import { HARNESS_LABEL as HARNESS_LABEL_RUN_STAGE } from "../bin/run-stage.js";
import { HARNESS_LABEL as HARNESS_LABEL_RETRO } from "../bin/retro.js";

test("states are the spec's 13 labels", () => {
  expect([...STATES].sort()).toEqual([
    "backlog", "factory:approved", "factory:awaiting-review", "factory:blocked", "factory:in-progress",
    "factory:merged", "factory:needs-human", "factory:needs-info", "factory:planned", "factory:queue",
    "factory:ready", "factory:rework", "factory:wont-do",
  ]);
});

test("graph edges from §3.2", () => {
  expect(canTransition("backlog", "factory:queue")).toBe(true);
  expect(canTransition("factory:queue", "factory:ready")).toBe(true);
  expect(canTransition("factory:queue", "factory:needs-info")).toBe(true);
  expect(canTransition("factory:queue", "factory:wont-do")).toBe(true);
  expect(canTransition("factory:queue", "factory:needs-human")).toBe(true);
  expect(canTransition("factory:needs-info", "factory:queue")).toBe(true);
  // KTB-16/KTB-14 r1: "판정 불가"(턴 한도, git status 실패)는 어느 스테이지에서나 생긴다 —
  // 출구가 없으면 triage·plan은 blocked를 요청했다가 거부당해 라벨이 그대로 남는다.
  expect(canTransition("factory:queue", "factory:blocked")).toBe(true);
  expect(canTransition("factory:ready", "factory:blocked")).toBe(true);
  expect(canTransition("factory:ready", "factory:planned")).toBe(true);
  expect(canTransition("factory:planned", "factory:in-progress")).toBe(true);
  expect(canTransition("factory:in-progress", "factory:awaiting-review")).toBe(true);
  expect(canTransition("factory:in-progress", "factory:blocked")).toBe(true);
  expect(canTransition("factory:in-progress", "factory:needs-human")).toBe(true);
  expect(canTransition("factory:awaiting-review", "factory:approved")).toBe(true);
  expect(canTransition("factory:awaiting-review", "factory:rework")).toBe(true);
  expect(canTransition("factory:awaiting-review", "factory:blocked")).toBe(true);   // review gates BLOCKED
  // 리뷰 효율 Task 8 (Structure G): 리뷰 진입 가드가 이 피처를 막는 열린 harness 이슈를 발견하면
  // 여기 주차한다(KTB-23의 in-progress → needs-info 주차와 같은 계열, sweepHarnessUnpark가 복귀시킨다).
  // 이 엣지가 없으면 park 전이가 그래프에 거부돼 runStage가 2로 죽는다 — 다른 모든 awaiting-review 엣지가
  // 여기 열거돼 있으므로 이것도 반드시 핀으로 고정한다.
  expect(canTransition("factory:awaiting-review", "factory:needs-info")).toBe(true);   // Task 8 harness park
  expect(canTransition("factory:rework", "factory:in-progress")).toBe(true);
  expect(canTransition("factory:rework", "factory:needs-human")).toBe(true);
  expect(canTransition("factory:approved", "factory:merged")).toBe(true);
  expect(canTransition("factory:approved", "factory:rework")).toBe(true);   // merge conflict — rebase and rework
  expect(canTransition("factory:approved", "factory:blocked")).toBe(true);   // merge gates BLOCKED / merge API failure
  expect(canTransition("factory:blocked", "factory:needs-human")).toBe(true);
  expect(canTransition("factory:blocked", "factory:planned")).toBe(true);   // sweeper 재큐
  expect(canTransition("factory:blocked", "factory:approved")).toBe(true);  // KTB-15: 머지만 실패한 런의 재시도
  // KTB-15b: triage·plan도 자신의 정상 진입 라벨로 되돌아가는 재시도 엣지를 얻는다(BLOCKED_RETRY).
  expect(canTransition("factory:blocked", "factory:queue")).toBe(true);
  expect(canTransition("factory:blocked", "factory:ready")).toBe(true);
  // KTB-19 review I-2: a merge retry-from-blocked can find the PR CONFLICTING before the label
  // hops back to approved — that's a rework outcome, not a graph dead end.
  expect(canTransition("factory:blocked", "factory:rework")).toBe(true);
  expect(canTransition("factory:needs-human", "factory:queue")).toBe(true);
});

/**
 * KTB-46 — 보호 경로 PR을 사람이 머지한 뒤 이슈를 잇는 엣지(스펙 §12.3-2의 예외 경로). **사람 전용이
 * 아니다**: 이것을 밟는 것은 sweeper라는 스크립트이고, 대신 `requirements.js`의 `factory:merged`
 * 증거 검사(review handoff·정족수·K·게이트·PR head sha)가 한 칸도 깎이지 않은 채 그대로 물린다.
 */
test("KTB-46: needs-human → merged is a normal graph edge, and merged stays a dead end", () => {
  expect(canTransition("factory:needs-human", "factory:merged")).toBe(true);
  expect(HUMAN_RETRY_TARGETS.has("factory:merged")).toBe(false);
  // 들어가는 문 하나가 늘었을 뿐 나오는 문은 없다 — merged는 여전히 막다른 상태다.
  for (const to of [...STATES]) expect(canTransition("factory:merged", to), to).toBe(false);
  for (const to of [...STATES]) expect(canTransition("factory:merged", to, { human: true }), `human ${to}`).toBe(false);
  // needs-human의 출구는 정확히 둘이다 — 다른 상태로 새 문이 열리지 않았다.
  const opened = [...STATES].filter((to) => canTransition("factory:needs-human", to));
  expect(opened.sort()).toEqual(["factory:merged", "factory:queue"]);
});

// ── KTB-15b I2: blocked에서 재진입할 수 있는 네 스테이지, 그리고 재시도가 허용되는 origin ──────
test("ENTRY_LABELS: every stage — review included (KTB-24 fix) — accepts factory:blocked", () => {
  expect(ENTRY_LABELS.triage).toEqual(["factory:queue", "factory:blocked"]);
  expect(ENTRY_LABELS.plan).toEqual(["factory:ready", "factory:blocked"]);
  expect(ENTRY_LABELS.implement).toEqual(["factory:planned", "factory:rework", "factory:blocked"]);
  expect(ENTRY_LABELS.merge).toEqual(["factory:approved", "factory:blocked"]);
  // KTB-24가 만든 `Aborted cleanup`이 잘린 review 잡의 awaiting-review를 blocked으로 세운다 —
  // review만 재진입을 못 하면 그 이슈는 **언제나** 곧장 needs-human이다(원인은 판정이 아니라 시간인데도).
  expect(ENTRY_LABELS.review).toEqual(["factory:awaiting-review", "factory:blocked"]);
});

test("BLOCKED_RETRY: each stage's allowed origins and hop-back label", () => {
  expect(BLOCKED_RETRY.triage).toEqual({ origins: ["factory:queue"], hop: "factory:queue" });
  expect(BLOCKED_RETRY.plan).toEqual({ origins: ["factory:ready"], hop: "factory:ready" });
  // implement의 hop은 origin이 in-progress여도 planned다 — implement 자신의 무조건적인
  // planned → in-progress 전이가 그 자리를 다시 채운다.
  expect(BLOCKED_RETRY.implement).toEqual({ origins: ["factory:in-progress"], hop: "factory:planned" });
  expect(BLOCKED_RETRY.merge).toEqual({ origins: ["factory:approved"], hop: "factory:approved" });
  // KTB-24 fix: review도 자기 진입 라벨로 되돌아간다. 라운드 카운터는 handoff 개수로 세므로
  // (`reviewRounds` — 완료된 rework 전이) 재작업까지 가지 못하고 잘린 런은 K 예산을 쓰지 않는다.
  expect(BLOCKED_RETRY.review).toEqual({ origins: ["factory:awaiting-review"], hop: "factory:awaiting-review" });
  expect(canTransition("factory:blocked", "factory:awaiting-review")).toBe(true);
  // 매 hop 자체가 그래프에서 유효한 엣지여야 한다 — 표와 그래프가 어긋나면 재시도가 조용히 거부된다.
  for (const { hop } of Object.values(BLOCKED_RETRY)) expect(canTransition("factory:blocked", hop), hop).toBe(true);
});

// 최종 리뷰 nit 1 — **origin은 실제로 생길 수 있는 것만 적는다.** `factory:planned`가 implement의
// origins에 있었지만 그 마커는 만들어질 수 없다: 그래프에 `planned → blocked` 엣지가 없고
// (`transition()`이 그래서 거부한다), `abortStage`는 라벨이 그 스테이지의 in-flight 라벨일 때만 민다.
// 죽은 항목은 다음 독자에게 "planned에서도 blocked이 될 수 있다"고 거짓말한다.
test("every BLOCKED_RETRY origin is a label that can actually reach factory:blocked (nit 1)", () => {
  for (const [stage, { origins }] of Object.entries(BLOCKED_RETRY)) {
    for (const from of origins) expect(canTransition(from, "factory:blocked"), `${stage}: ${from}`).toBe(true);
  }
  expect(canTransition("factory:planned", "factory:blocked")).toBe(false);
});

// ── ADR-020 KTB-32: needs-human에서 **중단 지점으로** 되돌아가는 사람 전용 엣지 ────────────────
// 이 엣지는 그래프(TRANSITIONS)에 없다 — `canTransition`에 `{human:true}`를 넘길 때만 열린다.
// 스크립트는 어떤 경로로도 이 엣지를 밟을 수 없다(전이 코멘트의 `by=`가 그 증거다).
test("KTB-32: needs-human → resume point is a human-only edge (script refused)", () => {
  expect([...HUMAN_RETRY_TARGETS].sort()).toEqual([
    "factory:awaiting-review", "factory:planned", "factory:ready", "factory:rework",
  ]);
  for (const to of HUMAN_RETRY_TARGETS) {
    expect(canTransition("factory:needs-human", to), `script ${to}`).toBe(false);
    expect(canTransition("factory:needs-human", to, { human: true }), `human ${to}`).toBe(true);
  }
  // queue는 사람 전용 엣지가 아니다 — 그래프의 정규 출구 그대로다(스크립트도 밟는다).
  expect(HUMAN_RETRY_TARGETS.has("factory:queue")).toBe(false);
  expect(canTransition("factory:needs-human", "factory:queue")).toBe(true);
  // 사람이라고 아무 데나 가지는 않는다 — 이 네 개 + queue + merged(KTB-46, 사람 전용이 아니라
  // 그래프의 정규 엣지다)가 전부다.
  for (const to of ["factory:approved", "factory:in-progress", "factory:wont-do"]) {
    expect(canTransition("factory:needs-human", to, { human: true }), to).toBe(false);
  }
  expect(HUMAN_RETRY_TARGETS.has("factory:merged")).toBe(false);
  // 사람 전용 엣지는 needs-human에만 있다 — `{human:true}`가 그래프 전체를 느슨하게 만들지 않는다.
  expect(canTransition("factory:merged", "factory:queue", { human: true })).toBe(false);
  expect(canTransition("factory:queue", "factory:planned", { human: true })).toBe(false);
});

/**
 * KTB-32 확장 — `factory:needs-info`도 같은 문을 받는다. 그 라벨의 유일한 출구는 `→ queue`이고
 * (§3.2), 하네스 대기 주차(KTB-23)가 바로 그 자리에 이슈를 세운다: 사람이 하네스 이슈를 손으로
 * 고쳐 머지한 뒤 `queue`로 돌아가면 plan을 처음부터 다시 돈다 — 플랜이 한 글자도 바뀌지 않았는데도.
 * 그래서 `needs-human`과 **같은** 사람 전용 엣지를 준다(같은 목적지 넷, 같은 두 번째 자물쇠).
 * sweeper의 주차 해제 팔은 그대로 `→ queue`다(스크립트 경로는 이 엣지를 밟을 수 없다).
 */
test("KTB-32: needs-info → resume point is the same human-only edge (script refused, queue unchanged)", () => {
  for (const to of HUMAN_RETRY_TARGETS) {
    expect(canTransition("factory:needs-info", to), `script ${to}`).toBe(false);
    expect(canTransition("factory:needs-info", to, { human: true }), `human ${to}`).toBe(true);
  }
  // 그래프의 정규 출구는 그대로다 — sweeper의 주차 해제가 계속 쓴다.
  expect(canTransition("factory:needs-info", "factory:queue")).toBe(true);
  // 사람이라고 아무 데나 가지 않는다.
  for (const to of ["factory:merged", "factory:approved", "factory:in-progress", "factory:wont-do"]) {
    expect(canTransition("factory:needs-info", to, { human: true }), to).toBe(false);
  }
  // 사람 전용 엣지는 이 둘에만 있다.
  expect([...HUMAN_ONLY_TRANSITIONS.keys()].sort()).toEqual(["factory:needs-human", "factory:needs-info"]);
});

test("every human-only retry target is a label the factory can actually resume from (an ENTRY_LABEL)", () => {
  const entry = new Set(Object.values(ENTRY_LABELS).flat());
  for (const to of HUMAN_RETRY_TARGETS) expect(entry.has(to), to).toBe(true);
});

test("non-edges are rejected", () => {
  expect(canTransition("backlog", "factory:approved")).toBe(false);
  expect(canTransition("factory:queue", "factory:planned")).toBe(false);
  expect(canTransition("factory:merged", "factory:queue")).toBe(false);
  expect(canTransition("nonsense", "factory:queue")).toBe(false);
});

test("factoryLabelOf picks the single factory:* label; backlog counts as a state", () => {
  expect(factoryLabelOf(["bug", "factory:ready"])).toBe("factory:ready");
  expect(factoryLabelOf(["backlog", "enhancement"])).toBe("backlog");
  expect(factoryLabelOf(["bug"])).toBe(null);
  expect(() => factoryLabelOf(["factory:ready", "factory:planned"])).toThrow(/exactly one/);
  expect(() => factoryLabelOf(["backlog", "factory:queue"])).toThrow(/exactly one/);
});

test("target state → stage that must have produced the handoff", () => {
  expect(STAGE_OF_TARGET["factory:planned"]).toBe("plan");
  expect(STAGE_OF_TARGET["factory:approved"]).toBe("review");
});

// 리뷰 leftover: `HARNESS_LABEL`이 `bin/run-stage.js`·`bin/retro.js`·`lib/label-catalog.js` 셋에
// 각자 리터럴로 있었다 — 셋이 갈라지면 retro가 만든 `factory:harness` 이슈를 run-stage의 implement
// 진입 판정이 못 알아보는 조용한 드리프트가 생긴다. 이제 label-catalog.js가 유일한 출처이고, 두
// bin 파일은 재수출만 한다 — import equality로 그것을 못 박는다.
test("HARNESS_LABEL has a single source of truth — run-stage.js and retro.js re-export label-catalog.js's constant", () => {
  expect(HARNESS_LABEL).toBe("factory:harness");
  expect(HARNESS_LABEL_RUN_STAGE).toBe(HARNESS_LABEL);
  expect(HARNESS_LABEL_RETRO).toBe(HARNESS_LABEL);
});
