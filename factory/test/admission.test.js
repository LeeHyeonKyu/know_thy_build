import { test, expect, vi } from "vitest";
import { queueAdmission, isSelfGenerated, originOf, impactPathsOf, makeQueueAdmission, SELF_GENERATED_DEFAULTS } from "../lib/admission.js";

/**
 * 설계 2026-09-30 §8.2 (S2) — **큐 진입은 job의 형식과 상한으로 심사한다, 제출자로가 아니라.**
 * 누구나 제출할 수 있으므로(§8.1) 문은 하나여야 하고, 그 문이 보는 것은 (1) 명시적으로 설계된 job인가(done_when 또는 공장 마커),
 * (2) NEVER_AUTOMATE에 걸리는가(지금은 triage 뒤에야 알았다 — L47), (3) 큐가 넘치는가(`queue_max`), (4) 자기생성 이슈의 개수·세대 상한.
 * 실측 증식률(0.25/머지)에서 루프는 이미 수렴한다 — 개수 상한은 지문 드리프트 같은 결함에 대한 보험이다.
 */
const charter = (over = {}) => ({
  never_automate: ["server/src/services/auth.service.ts", "client/lib/services/api_service.dart", "auth/**"],
  back_pressure: { awaiting_review_max: 4, queue_max: 3 },
  self_generated: { ...SELF_GENERATED_DEFAULTS, open_max: 2, depth_max: 1 },
  ...over,
});
const person = { number: 10, body: "## What\nx\n\n## Impact paths\n- `client/lib/screens/a.dart`\n\n## done_when (draft)\n- [ ] `test_10_a` — a", labels: ["backlog"], author: "LeeHyeonKyu" };
const improvement = (n, from = "LeeHyeonKyu/own-calendar#17") => ({
  number: n, author: "bot-hk", labels: ["backlog", "factory-improvement"],
  body: `<!-- factory-improvement fp=abc tags=ktb from=${from} -->\n\n## 무엇이 일어났나\n…\n\n## Evidence\n…`,
});
const base = { queued: [], openSelfGenerated: [], byNumber: () => null, factoryLogins: ["bot-hk"] };

test("a person's issue with a done_when draft and clean impact paths is admitted", () => {
  const r = queueAdmission({ issue: person, charter: charter(), ...base });
  expect(r).toEqual({ ok: true, reasons: [], self_generated: false });
});

test("job shape: no done_when and no factory marker is not an explicit job", () => {
  const r = queueAdmission({ issue: { ...person, body: "please fix the button" }, charter: charter(), ...base });
  expect(r.ok).toBe(false);
  expect(r.reasons.join(" ")).toMatch(/done_when/);
});

test("NEVER_AUTOMATE is checked at the door: an impact path under a charter glob is refused before triage", () => {
  const body = person.body.replace("client/lib/screens/a.dart", "client/lib/services/api_service.dart");
  const r = queueAdmission({ issue: { ...person, body }, charter: charter(), ...base });
  expect(r.ok).toBe(false);
  expect(r.reasons.join(" ")).toMatch(/NEVER_AUTOMATE/);
  expect(r.reasons.join(" ")).toContain("client/lib/services/api_service.dart");
});

test("queue_max: a full queue refuses new entries, whoever submits", () => {
  const r = queueAdmission({ issue: person, charter: charter(), ...base, queued: [{ number: 1 }, { number: 2 }, { number: 3 }] });
  expect(r.ok).toBe(false);
  expect(r.reasons.join(" ")).toMatch(/queue 3 ≥ 3/);
});

test("self-generated issues are recognised by the factory's markers or by the factory account as author", () => {
  expect(isSelfGenerated(improvement(20), ["bot-hk"])).toBe(true);
  expect(isSelfGenerated({ number: 21, author: "bot-hk", labels: ["backlog"], body: "x" }, ["bot-hk"])).toBe(true);
  expect(isSelfGenerated({ number: 22, author: "LeeHyeonKyu", labels: ["backlog", "factory:flaky"], body: "Detected while implementing #9. evidence: {}" }, ["bot-hk"])).toBe(true);
  expect(isSelfGenerated({ number: 23, author: "LeeHyeonKyu", labels: ["backlog"], body: "<!-- factory-harness-request for=9 -->\nharness: …" }, ["bot-hk"])).toBe(true);
  expect(isSelfGenerated(person, ["bot-hk"])).toBe(false);
});

test("originOf reads the issue a self-generated issue came from, in every marker shape the factory writes", () => {
  expect(originOf(improvement(20, "LeeHyeonKyu/own-calendar#17"))).toEqual({ repo: "LeeHyeonKyu/own-calendar", number: 17 });
  expect(originOf({ body: "<!-- factory-harness-request for=9 -->" })).toEqual({ repo: null, number: 9 });
  expect(originOf({ body: "Detected while implementing #31. evidence: {}" })).toEqual({ repo: null, number: 31 });
  expect(originOf(person)).toBe(null);
});

test("open_max: the factory may not have more than N of its own issues in flight", () => {
  const r = queueAdmission({ issue: improvement(20), charter: charter(), ...base, openSelfGenerated: [{ number: 18 }, { number: 19 }] });
  expect(r.ok).toBe(false);
  expect(r.self_generated).toBe(true);
  expect(r.reasons.join(" ")).toMatch(/self-generated open 2 ≥ 2/);
  // 사람의 이슈는 이 상한과 무관하다
  expect(queueAdmission({ issue: person, charter: charter(), ...base, openSelfGenerated: [{ number: 18 }, { number: 19 }] }).ok).toBe(true);
});

test("depth_max: an issue the factory generated from an issue the factory generated is one generation too deep", () => {
  // #20은 사람의 #17에서 나왔다(1세대) — 통과. #30은 공장의 #20에서 나왔다(2세대) — 거부.
  const byNumber = (n) => (n === 20 ? improvement(20, "LeeHyeonKyu/own-calendar#17") : n === 17 ? person : null);
  expect(queueAdmission({ issue: improvement(20, "LeeHyeonKyu/own-calendar#17"), charter: charter(), ...base, byNumber }).ok).toBe(true);
  const r = queueAdmission({ issue: improvement(30, "LeeHyeonKyu/own-calendar#20"), charter: charter(), ...base, byNumber });
  expect(r.ok).toBe(false);
  expect(r.reasons.join(" ")).toMatch(/generation 2 > 1/);
  // 기원을 찾을 수 없으면 세대를 모른다 — 1세대로 본다(발명하지 않는다), 통과
  expect(queueAdmission({ issue: improvement(31, "LeeHyeonKyu/own-calendar#99"), charter: charter(), ...base, byNumber }).ok).toBe(true);
});

test("charter without the new keys uses the defaults — the door exists in every repo", () => {
  const c = { never_automate: [], back_pressure: { awaiting_review_max: 4 } };
  const r = queueAdmission({ issue: person, charter: c, ...base, queued: new Array(SELF_GENERATED_DEFAULTS.queue_max).fill({}) });
  expect(r.ok).toBe(false);
  expect(r.reasons.join(" ")).toMatch(new RegExp(`queue ${SELF_GENERATED_DEFAULTS.queue_max} ≥ ${SELF_GENERATED_DEFAULTS.queue_max}`));
});

test("impactPathsOf reads backticked paths under '## Impact paths' only", () => {
  expect(impactPathsOf(person.body)).toEqual(["client/lib/screens/a.dart"]);
  expect(impactPathsOf("## Impact paths\n- `a/b.ts` (why)\n- `c/**`\n\n## done_when\n- `not/a/path.ts`")).toEqual(["a/b.ts", "c/**"]);
  expect(impactPathsOf("no section")).toEqual([]);
});

test("makeQueueAdmission gathers its inputs from gh and never throws — an unreadable input refuses (fail closed)", async () => {
  const issues = { 10: person, 18: improvement(18), 19: improvement(19), 20: improvement(20) };
  const gh = {
    issue: vi.fn(async (n) => { const it = issues[n]; if (!it) throw new Error("404"); return { ...it, labels: it.labels }; }),
    searchIssues: vi.fn(async (label) => label === "factory:queue" ? [] : label === "factory-improvement" ? [{ number: 18 }, { number: 19 }, { number: 20 }] : []),
  };
  const admit = makeQueueAdmission({ gh, charter: charter(), factoryLogins: async () => ({ ok: true, logins: ["bot-hk"] }) });
  expect((await admit({ issue: 10 })).ok).toBe(true);
  // 열린 자기생성 이슈는 큐·진행 중 라벨을 가진 것만 센다 — 여기서는 셋 다 backlog라 0
  expect((await admit({ issue: 20 })).ok).toBe(true);
  const broken = makeQueueAdmission({ gh: { ...gh, issue: async () => { throw new Error("boom"); } }, charter: charter(), factoryLogins: async () => ({ ok: true, logins: ["bot-hk"] }) });
  const r = await broken({ issue: 10 });
  expect(r.ok).toBe(false);
  expect(r.reasons.join(" ")).toMatch(/could not be read/);
});

// ── #136 (S2b) — 하네스 요청은 세대를 하나 더하지 않는다(설계 §8.2 표: "개선→하네스→flaky 사슬을 한 세대로 센다") ──
// 하네스 이슈가 이 문을 지나게 된 순간, depth_max=1은 **자기생성 피처**(flaky·개선·공장 작성)를 위한 하네스 요청을 전부 영구히
// 거부한다 — 그 피처를 끝낼 유일한 길이 막힌다. 하네스 요청은 "그 피처를 끝내는 데 필요한 것"이지 새 세대가 아니다.
test("test_136_harness_request_not_extra_generation", () => {
  const flakyFeature = { number: 40, author: "LeeHyeonKyu", labels: ["factory:needs-info", "factory:flaky"], body: "Detected while implementing #10. evidence: {}" };
  const improvementFeature = improvement(20, "LeeHyeonKyu/own-calendar#17");
  const harnessFor = (n, number = 50) => ({ number, author: "bot-hk", labels: ["backlog", "factory:harness"], body: `<!-- factory-harness-request for=${n} -->\n#${n}의 implement가 …\n\nBlocks: #${n}` });
  const byNumber = (n) => ({ 10: person, 17: person, 20: improvementFeature, 40: flakyFeature }[n] ?? null);

  // flaky 피처(사람의 #10에서 나왔다 — 1세대)를 위한 하네스 요청: 다른 상한이 안 걸리면 들어간다
  const r1 = queueAdmission({ issue: harnessFor(40), charter: charter(), ...base, byNumber });
  expect(r1).toEqual({ ok: true, reasons: [], self_generated: true });
  // 개선 피처(사람의 #17에서 나왔다 — 1세대)를 위한 하네스 요청도 같다
  expect(queueAdmission({ issue: harnessFor(20), charter: charter(), ...base, byNumber }).ok).toBe(true);
  // 사람의 피처를 위한 하네스 요청은 예전처럼 들어간다
  expect(queueAdmission({ issue: harnessFor(10), charter: charter(), ...base, byNumber }).ok).toBe(true);

  // 하네스 요청이라도 다른 상한은 그대로다(open_max) — 면제는 세대 하나뿐이다
  const capped = queueAdmission({ issue: harnessFor(40), charter: charter(), ...base, byNumber, openSelfGenerated: [{ number: 18 }, { number: 19 }] });
  expect(capped.ok).toBe(false);
  expect(capped.reasons.join(" ")).toMatch(/self-generated open 2 ≥ 2/);
  expect(capped.reasons.join(" ")).not.toMatch(/generation/);

  // 공장이 만든 이슈에서 공장이 만든 이슈(개선의 개선)는 여전히 2세대로 거부된다
  const deep = queueAdmission({ issue: improvement(30, "LeeHyeonKyu/own-calendar#20"), charter: charter(), ...base, byNumber });
  expect(deep.ok).toBe(false);
  expect(deep.reasons.join(" ")).toMatch(/generation 2 > 1/);
  // 하네스 요청을 사슬 **가운데** 끼워도 세대가 사라지지 않는다: 개선(#20)을 위한 하네스(#50)에서 나온 개선은 2세대다
  const viaHarness = (n) => (n === 50 ? harnessFor(20) : byNumber(n));
  const r2 = queueAdmission({ issue: improvement(60, "LeeHyeonKyu/own-calendar#50"), charter: charter(), ...base, byNumber: viaHarness });
  expect(r2.ok).toBe(false);
  expect(r2.reasons.join(" ")).toMatch(/generation 2 > 1/);
  // 하네스 이슈를 구현하다 수확한 flaky(사람의 #10 → 하네스 #50 → flaky #70)는 한 세대다 — 하네스 조상은 세대를 더하지 않는다
  const viaHarnessForPerson = (n) => (n === 50 ? harnessFor(10) : byNumber(n));
  const flakyOfHarness = { number: 70, author: "LeeHyeonKyu", labels: ["backlog", "factory:flaky"], body: "Detected while implementing #50. evidence: {}" };
  expect(queueAdmission({ issue: flakyOfHarness, charter: charter(), ...base, byNumber: viaHarnessForPerson })).toEqual({ ok: true, reasons: [], self_generated: true });

  // 설계 §8.2 표가 **이름으로 부른 사슬**: 사람 #17 → 개선 #20 → 하네스 #50(for=20) → flaky #70("Detected while implementing #50.")은
  // 한 세대다. 하네스 이슈를 구현하다 수확한 flaky는 그 하네스가 끝내려는 피처(#20)를 끝내는 일의 일부다 — 새 세대가 아니다.
  // 이것을 2로 세면 자기생성 피처의 하네스 수리 중에 나온 flaky가 영구히 거부된다(skeptic #136 f1).
  const specChain = (n) => (n === 50 ? harnessFor(20) : byNumber(n));
  expect(queueAdmission({ issue: flakyOfHarness, charter: charter(), ...base, byNumber: specChain })).toEqual({ ok: true, reasons: [], self_generated: true });
  // 같은 사슬에서 하네스를 빼면(개선 #20을 구현하다 수확한 flaky) 여전히 2세대다 — 면제는 "하네스 아래의 flaky"뿐이다
  const flakyOfImprovement = { number: 71, author: "LeeHyeonKyu", labels: ["backlog", "factory:flaky"], body: "Detected while implementing #20. evidence: {}" };
  const direct = queueAdmission({ issue: flakyOfImprovement, charter: charter(), ...base, byNumber: specChain });
  expect(direct.ok).toBe(false);
  expect(direct.reasons.join(" ")).toMatch(/generation 2 > 1/);
  // 하네스 아래의 flaky에서 공장이 다시 만든 개선은 2세대다 — 접힌 사슬 위에 한 세대가 더해진다
  const withFlaky = (n) => (n === 70 ? flakyOfHarness : specChain(n));
  const overFlaky = queueAdmission({ issue: improvement(80, "LeeHyeonKyu/own-calendar#70"), charter: charter(), ...base, byNumber: withFlaky });
  expect(overFlaky.ok).toBe(false);
  expect(overFlaky.reasons.join(" ")).toMatch(/generation 2 > 1/);
  // 하네스 부모를 읽지 못하면(byNumber가 null) 접을 근거가 없다 — flaky는 한 세대로 센다(발명하지 않는다)
  expect(queueAdmission({ issue: flakyOfHarness, charter: charter(), ...base, byNumber: () => null }).ok).toBe(true);
});

test("test_136_spec_chain_through_real_gh_admission", async () => {
  // 같은 사슬을 진짜 makeQueueAdmission(가짜 gh가 기원 사슬을 읽는다)으로: 사람 #17 → 개선 #20 → 하네스 #50 → flaky #70
  const issues = {
    17: { ...person, number: 17 },
    20: improvement(20, "LeeHyeonKyu/own-calendar#17"),
    50: { number: 50, author: "bot-hk", labels: ["backlog", "factory:harness"], body: "<!-- factory-harness-request for=20 -->\nharness" },
    70: { number: 70, author: "LeeHyeonKyu", labels: ["backlog", "factory:flaky"], body: "Detected while implementing #50. evidence: {}" },
    71: { number: 71, author: "LeeHyeonKyu", labels: ["backlog", "factory:flaky"], body: "Detected while implementing #20. evidence: {}" },
  };
  const gh = {
    issue: async (n) => { const it = issues[n]; if (!it) throw new Error("404"); return { ...it, labels: [...it.labels] }; },
    searchIssues: async () => [],
  };
  const admit = makeQueueAdmission({ gh, charter: charter(), factoryLogins: async () => ({ ok: true, logins: ["bot-hk"] }) });
  expect(await admit({ issue: 70 })).toEqual({ ok: true, reasons: [], self_generated: true });
  const r = await admit({ issue: 71 });
  expect(r.ok).toBe(false);
  expect(r.reasons.join(" ")).toMatch(/generation 2 > 1/);
});

// ── #136 rework cf1 — 접기는 사슬 하나에 한 번이다: 하네스→flaky가 번갈아 이어지는 사슬은 세대를 쌓는다 ──
// 설계 표는 "개선→하네스→flaky" **한** 사슬을 한 세대로 센다. 접힌 flaky(하네스 아래의 flaky)를 위한 하네스는 새 세대다 — 그렇지 않으면
// flaky→하네스→flaky→하네스→… 가 끝없이 1세대로 남아 depth_max가 영영 걸리지 않는다(리뷰 cf1: F20 ← H30 ← F40 ← H50 ← … 이 전부 들어갔다).
test("test_136_harness_flaky_alternation_is_bounded", async () => {
  const flaky = (number, of) => ({ number, author: "LeeHyeonKyu", labels: ["backlog", "factory:flaky"], body: `Detected while implementing #${of}. evidence: {}` });
  const harness = (number, forN) => ({ number, author: "bot-hk", labels: ["backlog", "factory:harness"], body: `<!-- factory-harness-request for=${forN} -->\nharness\n\nBlocks: #${forN}` });
  // 사람 #10 ← F20 ← H30 ← F40 ← H50 ← F60 ← H70 ← F80
  const issues = {
    10: { ...person, number: 10 },
    20: flaky(20, 10), 30: harness(30, 20), 40: flaky(40, 30), 50: harness(50, 40), 60: flaky(60, 50), 70: harness(70, 60), 80: flaky(80, 70),
  };
  const byNumber = (n) => issues[n] ?? null;
  const admitPure = (n) => queueAdmission({ issue: issues[n], charter: charter(), ...base, byNumber });

  // 첫 사슬(F20 → 하네스 H30 → 그 하네스에서 수확한 F40)은 한 세대다 — 표가 부른 모양 그대로
  expect(admitPure(20)).toEqual({ ok: true, reasons: [], self_generated: true });
  expect(admitPure(30)).toEqual({ ok: true, reasons: [], self_generated: true });
  expect(admitPure(40)).toEqual({ ok: true, reasons: [], self_generated: true });
  // 접힌 flaky(F40)를 위한 하네스는 새 세대를 연다 — 2세대로 거부된다. 그 아래 고리도 전부 거부된다(세대는 줄지 않는다)
  for (const [n, g] of [[50, 2], [60, 2], [70, 3], [80, 3]]) {
    const r = admitPure(n);
    expect(r.ok, `#${n}`).toBe(false);
    expect(r.reasons.join(" "), `#${n}`).toMatch(new RegExp(`generation ${g} > 1`));
  }
  // depth_max를 올리면 다음 사슬 하나가 그 한 칸만큼 들어간다 — 고리마다가 아니라 사슬마다 한 세대
  const wide = (n) => queueAdmission({ issue: issues[n], charter: charter({ self_generated: { ...SELF_GENERATED_DEFAULTS, open_max: 2, depth_max: 2 } }), ...base, byNumber });
  expect(wide(60).ok).toBe(true);
  expect(wide(70).ok).toBe(false);

  // 사람의 피처에서 시작해도 같다: 사람 #10 ← H11 ← F12 ← H13 ← F14 ← H15 — 사람의 사슬은 0세대, 접힌 F12의 하네스부터 1세대
  const fromPerson = { 10: issues[10], 11: harness(11, 10), 12: flaky(12, 11), 13: harness(13, 12), 14: flaky(14, 13), 15: harness(15, 14) };
  const admitP = (n) => queueAdmission({ issue: fromPerson[n], charter: charter(), ...base, byNumber: (k) => fromPerson[k] ?? null });
  expect(admitP(12).ok).toBe(true);
  expect(admitP(14).ok).toBe(true);
  const r15 = admitP(15);
  expect(r15.ok).toBe(false);
  expect(r15.reasons.join(" ")).toMatch(/generation 2 > 1/);

  // 진짜 makeQueueAdmission(가짜 gh가 기원 사슬을 읽는다)으로도 같다
  const gh = {
    issue: async (n) => { const it = issues[n]; if (!it) throw new Error("404"); return { ...it, labels: [...it.labels] }; },
    searchIssues: async () => [],
  };
  const admit = makeQueueAdmission({ gh, charter: charter(), factoryLogins: async () => ({ ok: true, logins: ["bot-hk"] }) });
  expect((await admit({ issue: 40 })).ok).toBe(true);
  for (const n of [50, 60, 70, 80]) expect((await admit({ issue: n })).ok, `#${n}`).toBe(false);
});

// ── #230 — refusals carry structured codes, and the triage entry maps them without reading reason text ──────────────
import { entryRecheck, admissionRefusedReason } from "../lib/admission.js";

test("test_230_admission_codes_classify_per_issue_vs_capacity_refusals", async () => {
  const noJob = { ...person, body: "## Impact paths\n- `auth/login.ts`" };                     // no done_when + NEVER_AUTOMATE
  const r = queueAdmission({ issue: noJob, charter: charter(), ...base, queued: [{ number: 1 }, { number: 2 }, { number: 3 }] });
  expect(r.codes).toEqual(["no-done-when", "never-automate", "queue-max"]);
  expect(r.codes).toHaveLength(r.reasons.length);
  // the entry re-check keeps the per-issue facts only, in transition()'s wording; NEVER_AUTOMATE wins the target
  expect(entryRecheck(r)).toEqual({ verdict: "refuse", to: "factory:wont-do", reason: admissionRefusedReason({ reasons: r.reasons.slice(0, 2) }) });
  expect(admissionRefusedReason({ reasons: r.reasons.slice(0, 2) })).toBe(`queue admission refused — ${r.reasons[0]}; ${r.reasons[1]}`);
  const missing = queueAdmission({ issue: { ...person, body: "please" }, charter: charter(), ...base });
  expect(entryRecheck(missing)).toEqual({ verdict: "refuse", to: "factory:needs-info", reason: `queue admission refused — ${missing.reasons[0]}` });
  // capacity alone is not re-judged at the entry
  const full = queueAdmission({ issue: person, charter: charter(), ...base, queued: [{ number: 1 }, { number: 2 }, { number: 3 }] });
  expect(full.codes).toEqual(["queue-max"]);
  expect(entryRecheck(full)).toEqual({ verdict: "pass" });
  expect(entryRecheck({ ok: true, reasons: [] })).toEqual({ verdict: "pass" });
  // an unreadable read — or a refusal that does not say why in codes — is never a verdict
  const broken = await makeQueueAdmission({ gh: { issue: async () => { throw new Error("boom"); } }, charter: charter() })({ issue: 10 });
  expect(broken.codes).toEqual(["unreadable"]);
  expect(entryRecheck(broken)).toMatchObject({ verdict: "unreadable", reason: expect.stringContaining("boom") });
  expect(entryRecheck({ ok: false, reasons: ["something"] })).toMatchObject({ verdict: "unreadable" });
  expect(entryRecheck(null)).toMatchObject({ verdict: "unreadable" });
});
