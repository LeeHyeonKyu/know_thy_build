import { test, expect } from "vitest";
import { STATES, canTransition, factoryLabelOf, STAGE_OF_TARGET, ENTRY_LABELS, BLOCKED_RETRY } from "../lib/labels.js";
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
  expect(BLOCKED_RETRY.implement).toEqual({ origins: ["factory:planned", "factory:in-progress"], hop: "factory:planned" });
  expect(BLOCKED_RETRY.merge).toEqual({ origins: ["factory:approved"], hop: "factory:approved" });
  // KTB-24 fix: review도 자기 진입 라벨로 되돌아간다. 라운드 카운터는 handoff 개수로 세므로
  // (`reviewRounds` — 완료된 rework 전이) 재작업까지 가지 못하고 잘린 런은 K 예산을 쓰지 않는다.
  expect(BLOCKED_RETRY.review).toEqual({ origins: ["factory:awaiting-review"], hop: "factory:awaiting-review" });
  expect(canTransition("factory:blocked", "factory:awaiting-review")).toBe(true);
  // 매 hop 자체가 그래프에서 유효한 엣지여야 한다 — 표와 그래프가 어긋나면 재시도가 조용히 거부된다.
  for (const { hop } of Object.values(BLOCKED_RETRY)) expect(canTransition("factory:blocked", hop), hop).toBe(true);
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
