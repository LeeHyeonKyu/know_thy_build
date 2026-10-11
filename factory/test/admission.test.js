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

// ── #231 — admission의 두 파서 결함(허점 원장 E-5·E-6, P-3·P-5) ──────────────────────────────────────────────
// (1) Impact paths 파서는 백틱 안 토큰만 읽었다 — `:issue` 템플릿은 백틱이 없어서 템플릿대로 쓴 이슈는 NEVER_AUTOMATE
//     조기 차단에 아무 경로도 보이지 않았다. (2) 본문에 `Detected while implementing #N.` 한 줄을 붙여 넣으면 done_when 요구가
//     면제됐다 — 마커는 공장이 **연** 이슈일 때만(작성자가 공장 로그인일 때만) 면제한다. 상한(open_max/depth_max)의 판정은 그대로다.
import { readFileSync as readFileSync231 } from "node:fs";
import { fileURLToPath as fileURLToPath231 } from "node:url";
import { makeGh as makeGh231 } from "../lib/gh.js";
import { makeFakeRun as makeFakeRun231 } from "../lib/exec.js";
import { loadCharter as loadCharter231 } from "../lib/config.js";
import { mkdtempSync as mkdtempSync231, rmSync as rmSync231 } from "node:fs";
import { tmpdir as tmpdir231 } from "node:os";
import { join as joinPath231 } from "node:path";
import { runStageGates as runStageGates231 } from "../lib/gates.js";
import { renderUpstreamIssue as renderUpstreamIssue231, UPSTREAM_LABELS as UPSTREAM_LABELS231 } from "../lib/feedback/upstream-issue.js";

const ROOT231 = fileURLToPath231(new URL("../..", import.meta.url));

test("test_231_impact_paths_reads_backticked_and_plain_list_items", () => {
  const want = ["factory/lib/admission.js", "templates/know-thy-build/issue.md"];
  const shapes = {
    backticked: "## Impact paths\n- `factory/lib/admission.js`\n- `templates/know-thy-build/issue.md`\n",
    plain: "## Impact paths\n- factory/lib/admission.js\n- templates/know-thy-build/issue.md\n",
    h3: "### Impact paths\n- `factory/lib/admission.js`\n* templates/know-thy-build/issue.md\n",
    spacedBackticks: "## Impact paths\n- `factory/lib/admission.js templates/know-thy-build/issue.md`\n",
    notes: "## Impact paths\n- factory/lib/admission.js (신규)\n- `templates/know-thy-build/issue.md` (템플릿 예시)\n",
    multiComma: "## Impact paths\n- `factory/lib/admission.js`, `templates/know-thy-build/issue.md`\n",
    trailingPunct: "## Impact paths\n- factory/lib/admission.js,\n- templates/know-thy-build/issue.md.\n",
  };
  for (const [name, section] of Object.entries(shapes)) {
    expect(impactPathsOf(`## What\nx\n\n${section}\n## done_when (draft)\n- [ ] \`test_1_a\` — a`), name).toEqual(want);
  }
  // 산문 항목은 경로가 없으면 아무것도 내지 않는다
  expect(impactPathsOf("## Impact paths\n- 문서 전반\n- 없음\n- factory/lib/admission.js 근처의 주석\n")).toEqual(["factory/lib/admission.js"]);
  // 절이 없으면 빈 배열
  expect(impactPathsOf("## What\n- factory/lib/admission.js\n\n## done_when\n- `factory/lib/gh.js`")).toEqual([]);
  // 다음 제목(#, ##, ###)이 절을 끝낸다 — 뒤 절의 백틱 테스트 이름은 경로가 아니다
  expect(impactPathsOf("### Impact paths\n- `a/b.ts`\n\n### done_when (draft)\n- [ ] `test_9_x.y` — `not/a/path.ts`")).toEqual(["a/b.ts"]);
  expect(impactPathsOf("## Impact paths\n- a/b.ts\n# Next\n- c/d.ts")).toEqual(["a/b.ts"]);
  // 이 이슈(#231) 자신의 Impact paths 모양: 한 항목에 백틱 경로 여럿 — 두 번째 자리의 금지 경로도 읽힌다
  const own = "## Impact paths\n- `factory/lib/admission.js`, `templates/factory/harness.toml`, `factory/bin/run-stage.js`\n- `factory/test/admission.test.js`\n";
  expect(impactPathsOf(own)).toEqual(["factory/lib/admission.js", "templates/factory/harness.toml", "factory/bin/run-stage.js", "factory/test/admission.test.js"]);
  const r = queueAdmission({ issue: { ...person, body: `${own}\n## done_when\n- [ ] \`test_1_a\`` }, charter: charter({ never_automate: ["templates/factory/**"] }), ...base });
  expect(r.ok).toBe(false);
  expect(r.reasons.join(" ")).toContain("templates/factory/harness.toml (glob templates/factory/**)");
  // 백틱 없는 금지 경로도 문에서 걸린다(예전에는 빈 배열이라 통과했다)
  const plainForbidden = queueAdmission({ issue: { ...person, body: "## Impact paths\n- templates/factory/harness.toml (게이트)\n\n## done_when\n- [ ] `test_1_a`" }, charter: charter({ never_automate: ["templates/factory/**"] }), ...base });
  expect(plainForbidden.reasons.join(" ")).toContain("NEVER_AUTOMATE: templates/factory/harness.toml (glob templates/factory/**)");
  // ASCII 산문 항목도 경로가 아니다 — 경로 모양 검사(`/`·`.`)가 이것을 막는다(한글 산문은 문자 검사가 먼저 막으므로 따로 핀)
  expect(impactPathsOf("## Impact paths\n- none\n- TBD\n- see below\n- e.g.\n- i.e. the parser\n")).toEqual([]);
  // 백틱 없는 경로 뒤에 백틱 설명이 붙어도 그 경로를 읽는다(백틱 토큰도 함께 읽는다 — 넓게 읽는 쪽이 fail closed)
  expect(impactPathsOf("## Impact paths\n- templates/factory/harness.toml (see `ci.yml`)\n")).toEqual(["ci.yml", "templates/factory/harness.toml"]);
  expect(impactPathsOf("## Impact paths\n- templates/factory/harness.toml — guarded by `test_1_a`\n")).toContain("templates/factory/harness.toml");
  // 백틱 없는 쉼표 목록: 두 번째 자리의 금지 경로도 읽힌다
  expect(impactPathsOf("## Impact paths\n- factory/lib/a.js, templates/factory/harness.toml\n")).toEqual(["factory/lib/a.js", "templates/factory/harness.toml"]);
  // 번호 목록도 목록이다
  expect(impactPathsOf("## Impact paths\n1. templates/factory/harness.toml\n2) factory/lib/a.js\n")).toEqual(["templates/factory/harness.toml", "factory/lib/a.js"]);
  for (const body of ["- factory/lib/a.js, templates/factory/harness.toml", "1. templates/factory/harness.toml", "- templates/factory/harness.toml (see `ci.yml`)"]) {
    const refused = queueAdmission({ issue: { ...person, body: `## Impact paths\n${body}\n\n## done_when\n- [ ] \`test_1_a\`` }, charter: charter({ never_automate: ["templates/factory/**"] }), ...base });
    expect(refused.reasons.join(" "), body).toContain("NEVER_AUTOMATE: templates/factory/harness.toml (glob templates/factory/**)");
  }
  // self-critique (#231) — 괄호 안·링크 대상·조사가 붙은 경로·따옴표·굵게·코드 펜스 속 `#` 줄: 모두 경로를 내고, 진짜 CHARTER에서 거부된다
  const leaky = {
    link: "- [harness](templates/factory/harness.toml)",
    parenthesised: "- harness config (templates/factory/harness.toml)",
    koreanParticle: "- templates/factory/harness.toml에서",
    quoted: "- \"templates/factory/harness.toml\"",
    ideographicComma: "- templates/factory/harness.toml、x",
    bold: "- **templates/factory/harness.toml**",
    fencedHashLine: "```\n# note\n```\n- templates/factory/harness.toml",
  };
  const realCharter231 = loadCharter231(ROOT231);
  for (const [name, item] of Object.entries(leaky)) {
    const sectionBody = `## Impact paths\n${item}\n\n## done_when\n- [ ] \`test_1_a\``;
    expect(impactPathsOf(sectionBody), name).toContain("templates/factory/harness.toml");
    const refused = queueAdmission({ issue: { ...person, body: sectionBody }, charter: realCharter231, ...base });
    expect(refused.ok, name).toBe(false);
    expect(refused.reasons.join(" "), name).toContain("NEVER_AUTOMATE: templates/factory/harness.toml (glob templates/factory/**)");
  }
  // 펜스 밖의 제목은 여전히 절을 끝낸다
  expect(impactPathsOf("## Impact paths\n```\n# note\n```\n- a/b.ts\n## done_when\n- c/d.ts")).toEqual(["a/b.ts"]);
  // rework cf1·qa1 — 웹 UI로 쓴 이슈 본문은 CRLF로 저장된다: 백틱 없는 목록 항목도 LF와 똑같이 읽히고, 같은 절 끝에서 멈추며, 진짜 CHARTER에서 거부된다
  for (const [name, section] of Object.entries(shapes)) {
    expect(impactPathsOf(`## What\nx\n\n${section}\n## done_when (draft)\n- [ ] \`test_1_a\` — a`.replace(/\n/g, "\r\n")), `crlf ${name}`).toEqual(want);
  }
  const crlf = "## Impact paths\r\n- templates/factory/harness.toml\r\n- .github/workflows/publish.yml\r\n\r\n## done_when\r\n- [ ] `test_1_a`\r\n";
  expect(impactPathsOf(crlf)).toEqual(["templates/factory/harness.toml", ".github/workflows/publish.yml"]);
  const crlfRefused = queueAdmission({ issue: { ...person, body: crlf }, charter: realCharter231, ...base });
  expect(crlfRefused.ok).toBe(false);
  expect(crlfRefused.reasons.join(" ")).toContain("NEVER_AUTOMATE: templates/factory/harness.toml (glob templates/factory/**)");
});

/** 진짜 `:issue` 템플릿의 첫 마크다운 블록(Impact paths가 든 것)을 그대로 꺼내고, 자리표시자를 실제 값으로 채운다. */
function filledIssueTemplate(paths) {
  const md = readFileSync231(`${ROOT231}templates/know-thy-build/issue.md`, "utf8");
  const block = [...md.matchAll(/```markdown\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => b.includes("{{path_1}}"));
  return { md, block, body: block.replace("{{path_1}}", paths[0]).replace("{{path_2}}", paths[1]).replace(/\{\{(\w+)\}\}/g, "filled $1").replace("test_NNN_<slug>", "test_12_button_crash") };
}

test("test_231_issue_template_impact_paths_are_backticked", () => {
  const { md, block } = filledIssueTemplate(["x", "y"]);
  // 템플릿의 Impact paths 항목은 백틱이다
  expect(block).toMatch(/^## Impact paths\n- `\{\{path_1\}\}`\n- `\{\{path_2\}\}`$/m);
  expect(md).not.toMatch(/^- \{\{path_\d\}\}$/m);
  // 템플릿대로 채운 이슈 — 파서가 정확히 그 경로들을 읽는다
  const clean = filledIssueTemplate(["client/lib/screens/a.dart", "factory/lib/admission.js"]).body;
  expect(impactPathsOf(clean)).toEqual(["client/lib/screens/a.dart", "factory/lib/admission.js"]);
  // 진짜 CHARTER의 NEVER_AUTOMATE에 걸리는 경로를 템플릿대로 적으면 큐 문에서 거부되고, 이유가 경로와 글롭을 말한다
  const realCharter = loadCharter231(ROOT231);
  expect(realCharter.never_automate).toContain("templates/factory/**");
  const forbidden = filledIssueTemplate(["factory/lib/admission.js", "templates/factory/harness.toml"]).body;
  const refused = queueAdmission({ issue: { number: 12, body: forbidden, labels: ["backlog"], author: "LeeHyeonKyu" }, charter: realCharter, ...base });
  expect(refused.ok).toBe(false);
  expect(refused.reasons).toHaveLength(1);
  expect(refused.reasons[0]).toContain("NEVER_AUTOMATE: templates/factory/harness.toml (glob templates/factory/**)");
  // 같은 본문에서 금지 경로만 빼면 들어간다(템플릿의 done_when 초안이 job 모양을 채운다)
  const admitted = queueAdmission({ issue: { number: 12, body: clean, labels: ["backlog"], author: "LeeHyeonKyu" }, charter: realCharter, ...base });
  expect(admitted).toEqual({ ok: true, reasons: [], self_generated: false });
});

// ── 프로덕션 배선: 가짜는 `gh` 실행 경계에만 둔다. 작성자는 진짜 `makeGh().issue()`가 `gh issue view --json` 출력에서 읽는다.
// 작성자 모양은 gh CLI 소스 api/queries_issue.go `Author.MarshalJSON`(v2.102.0): 사람 `{is_bot:false, login, id, name}`,
// 봇(GraphQL `Bot`, `... on User`가 비어 ID 없음) `{is_bot:true, login:"app/<slug>"}`.
const ghIssueJson = (it) => JSON.stringify({ number: it.number, title: it.title ?? `#${it.number}`, body: it.body, labels: (it.labels || []).map((name) => ({ name })), ...("author" in it ? { author: it.author } : {}) });
const humanAuthor = (login) => ({ id: "MDQ6VXNlcjE=", is_bot: false, login, name: login });
const appAuthor = (slug) => ({ is_bot: true, login: `app/${slug}` });
/**
 * 진짜 flaky 생산자(gates.js의 runStageGates, review 단계의 수확 경로)를 fake exec로 돌려, 그것이 gh.createIssue에 넘긴
 * {body, labels}를 돌려준다 — gates.test.js의 "review: flaky-existing" 케이스와 같은 배선이다.
 */
async function harvestFlakyIssue(issue) {
  const cwd = mkdtempSync231(joinPath231(tmpdir231(), "adm231-flaky-"));
  const TO = "vitest run 'test/a.test.js' -t 'flaky one'";
  const ok = { code: 0, stdout: "", stderr: "" }, bad = { code: 1, stdout: "", stderr: "boom" };
  const codes = [1, 0]; let i = 0;
  const run = makeFakeRun231([
    { match: (c, a, o) => c === "bash" && a[1] === TO && o.cwd.endsWith("classify-wt"), result: () => (codes[i++] === 0 ? ok : bad) },
    { match: (c, a) => c === "bash" && a[1] === TO, result: ok },
    { match: (c, a) => c === "bash" && a[1] === "vitest --json", result: bad },
    { match: (c, a) => c === "git" && a[0] === "diff" && a[1] === "--name-status", result: { code: 0, stdout: "M\tsrc/a.js\n", stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "rev-parse", result: { code: 0, stdout: `${"h".repeat(40)}\n`, stderr: "" } },
    { match: (c, a) => c === "git" && a[0] === "worktree", result: ok },
  ]);
  const harness = {
    harness: { maturity: "M2" },
    commands: { unit: "vitest --json", test_files: "vitest run {files}", test_one: "vitest run {file} -t {name}", proof: {} },
    gates: { required: ["unit"], fast: ["unit"], full: ["unit"], deep: ["unit"], thresholds: { new_test_repeats: 1, flaky_isolation_runs: 1, flaky_base_runs: 2, flaky_max: 2, quarantine_max_effective: 3 } },
    test: { unit_report: ".factory/out/unit.json", test_glob: ["test/**"], source_glob: ["src/**"] },
  };
  const readFile = (p) => (p.endsWith("unit.json") ? JSON.stringify({ numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, testResults: [{ name: joinPath231(cwd, "test/a.test.js"), assertionResults: [{ fullName: "flaky one", status: "failed" }] }] }) : null);
  const created = [];
  const gh = { async createIssue(args) { created.push(args); return 900 + created.length; }, async searchIssues() { return []; }, async comment() { return "u"; } };
  await runStageGates231({ run, cwd, harness, stage: "review", tier: "standard", base: "b".repeat(40), gh, issue, readFile });
  rmSync231(cwd, { recursive: true, force: true });
  expect(created).toHaveLength(1);
  return { body: created[0].body, labels: created[0].labels };
}

function ghOver(issues, { lists = {} } = {}) {
  const run = makeFakeRun231([
    { match: (c, a) => c === "gh" && a[0] === "issue" && a[1] === "view", result: (c, a) => (issues[a[2]] ? { code: 0, stdout: ghIssueJson(issues[a[2]]), stderr: "" } : { code: 1, stdout: "", stderr: "Could not resolve to an issue" }) },
    { match: (c, a) => c === "gh" && a[0] === "issue" && a[1] === "list", result: (c, a) => ({ code: 0, stdout: JSON.stringify(lists[a[a.indexOf("--label") + 1]] ?? []), stderr: "" }) },
  ]);
  return makeGh231({ run, repo: "LeeHyeonKyu/know_thy_build" });
}
const FACTORY = async () => ({ ok: true, logins: ["ktb-factory[bot]"] });

test("test_231_self_generated_needs_marker_and_factory_author", async () => {
  const markers = {
    flaky: "Detected while implementing #9. evidence: {}",
    harness: "<!-- factory-harness-request for=9 -->\nharness: …",
    improvement: "<!-- factory-improvement fp=abc tags=ktb from=LeeHyeonKyu/own-calendar#17 -->\n\n## 무엇이 일어났나\n…",
  };
  const issues = { 9: { number: 9, body: person.body, labels: ["backlog"], author: humanAuthor("LeeHyeonKyu") } };
  let n = 100;
  const mk = (body, author) => { const it = { number: ++n, body, labels: ["backlog"], ...(author === undefined ? {} : { author }) }; issues[it.number] = it; return it.number; };
  const admit = (logins = FACTORY) => makeQueueAdmission({ gh: ghOver(issues), charter: charter(), factoryLogins: logins });

  for (const [kind, body] of Object.entries(markers)) {
    // 사람이 마커를 붙여 넣었다(라벨 없음, done_when 없음) — 거부, 이유가 작성자를 말하고 done_when을 요구한다
    const human = await admit()({ issue: mk(body, humanAuthor("LeeHyeonKyu")) });
    expect(human.ok, kind).toBe(false);
    const why = human.reasons.join(" ");
    expect(why, kind).toMatch(/not an explicit job/);
    expect(why, kind).toMatch(/factory marker but its author `LeeHyeonKyu` is not a factory login/);
    expect(why, kind).toMatch(/add a `done_when` section/);
    // 공장이 연 이슈(App 작성자, gh가 `app/<slug>`로 준다) — 들어간다
    const factory = await admit()({ issue: mk(body, appAuthor("ktb-factory")) });
    expect(factory, kind).toEqual({ ok: true, reasons: [], self_generated: true });
    // 작성자를 읽을 수 없다(gh가 null — 삭제된 계정) — 마커만으로는 거부, 이유가 그것을 말한다
    const ghost = await admit()({ issue: mk(body, null) });
    expect(ghost.ok, kind).toBe(false);
    expect(ghost.reasons.join(" "), kind).toMatch(/factory marker but the author could not be read/);
    // 공장 로그인을 알아내지 못했다 — 마커만으로는 거부, 이유가 그것을 말한다(로그인 해석이 던져도, ok:false여도)
    for (const logins of [async () => { throw new Error("gh api user failed"); }, async () => ({ ok: false, reason: "no factory login could be resolved" }), null]) {
      const unresolved = await admit(logins)({ issue: mk(body, appAuthor("ktb-factory")) });
      expect(unresolved.ok, kind).toBe(false);
      expect(unresolved.reasons.join(" "), kind).toMatch(/factory marker but the factory logins could not be resolved/);
    }
  }
  // 마커 없는 공장 작성자, done_when 없음 — 작성 계정만으로는 면제되지 않는다
  const bare = await admit()({ issue: mk("please fix the button", appAuthor("ktb-factory")) });
  expect(bare.ok).toBe(false);
  expect(bare.reasons).toContain("not an explicit job: the body has no `done_when` section (and no factory marker)");
  // 알려진 한계(공유 계정, ADR-038 PAT 폴백): 소유자 로그인이 곧 공장 로그인이면 소유자가 붙인 마커는 여전히 면제된다
  const shared = await admit(async () => ({ ok: true, logins: ["LeeHyeonKyu"] }))({ issue: mk("Detected while implementing #8. evidence: {}", humanAuthor("LeeHyeonKyu")) });
  expect(shared).toEqual({ ok: true, reasons: [], self_generated: true });
  // 순수 심사도 같다: 작성자 미상 + 마커는 거부
  expect(queueAdmission({ issue: { number: 300, body: markers.flaky, labels: ["backlog"] }, charter: charter(), ...base }).ok).toBe(false);
  expect(queueAdmission({ issue: { number: 301, body: markers.flaky, labels: ["backlog"], author: "bot-hk" }, charter: charter(), ...base }).ok).toBe(true);
});

test("test_231_factory_flaky_issue_under_pat_author_still_admitted", async () => {
  // 진짜 생산자의 모양: gates.js의 flaky 수확(본문·라벨)과 feedback/upstream-issue.js의 개선 이슈.
  // flaky 이슈는 손으로 짓지 않는다 — 진짜 runStageGates가 수확하며 gh.createIssue에 넘긴 본문·라벨을 그대로 쓴다.
  const harvested = {};
  for (const of of [7, 20, 50, 60]) harvested[of] = await harvestFlakyIssue(of);
  expect(harvested[7].labels).toEqual(["backlog", "factory:flaky"]);
  expect(harvested[7].body).toMatch(/^Detected while implementing #7\. evidence: \{/);
  const flakyFrom = (number, of, author) => ({ number, body: harvested[of].body, labels: [...harvested[of].labels], author });
  const up = renderUpstreamIssue231({ fingerprint: "ab12cd34ef56", tags: ["ktb"], payload: { reason: "gate misread" }, sourceRepo: "LeeHyeonKyu/own-calendar", sourceIssue: 17 });
  const issues = {
    7: { number: 7, body: person.body, labels: ["factory:in-progress"], author: humanAuthor("LeeHyeonKyu") },
    // PAT 폴백: 공장이 소유자 계정으로 연 flaky 이슈 — 작성자는 공장 로그인이 아니다
    41: flakyFrom(41, 7, humanAuthor("LeeHyeonKyu")),
    // 소비자 저장소의 공장이 이 저장소에 연 개선 이슈 — 작성자는 이 저장소의 공장 로그인이 아니다
    42: { number: 42, body: up.body, labels: [...UPSTREAM_LABELS231], author: appAuthor("own-calendar-factory") },
  };
  const admit = makeQueueAdmission({ gh: ghOver(issues), charter: charter(), factoryLogins: FACTORY });
  expect(await admit({ issue: 41 })).toEqual({ ok: true, reasons: [], self_generated: true });
  expect(await admit({ issue: 42 })).toEqual({ ok: true, reasons: [], self_generated: true });
  // 그 둘을 들여보낸 것은 **라벨**이다: 같은 본문·같은 작성자에서 라벨을 떼면 마커만으로는 면제되지 않는다
  const unlabelled = { 43: { ...issues[41], number: 43, labels: ["backlog"] }, 44: { ...issues[42], number: 44, labels: ["backlog"] } };
  const bareAdmit = makeQueueAdmission({ gh: ghOver({ ...issues, ...unlabelled }), charter: charter(), factoryLogins: FACTORY });
  expect((await bareAdmit({ issue: 43 })).reasons.join(" ")).toMatch(/author `LeeHyeonKyu` is not a factory login/);
  expect((await bareAdmit({ issue: 44 })).reasons.join(" ")).toMatch(/author `own-calendar-factory\[bot\]` is not a factory login/);

  // 상한은 그대로 센다: 공장 로그인이 아닌 작성자의 진행 중 flaky 둘이 open_max(2)를 채운다
  const busy = {
    ...issues,
    51: { ...flakyFrom(51, 7, humanAuthor("LeeHyeonKyu")), labels: ["factory:in-progress", "factory:flaky"] },
    52: { ...flakyFrom(52, 7, null), labels: ["factory:queue", "factory:flaky"] },
  };
  const capped = await makeQueueAdmission({ gh: ghOver(busy, { lists: { "factory:flaky": [{ number: 41 }, { number: 51 }, { number: 52 }] } }), charter: charter(), factoryLogins: FACTORY })({ issue: 41 });
  expect(capped.ok).toBe(false);
  expect(capped.reasons.join(" ")).toMatch(/self-generated open 2 ≥ 2/);
  expect((await makeQueueAdmission({ gh: ghOver(busy, { lists: { "factory:flaky": [{ number: 41 }, { number: 51 }, { number: 52 }] } }), charter: charter(), factoryLogins: FACTORY })({ issue: 42 })).reasons.join(" ")).toMatch(/self-generated open 2 ≥ 2/);

  // 기원 사슬도 그대로 센다: 마커만 있고 작성자가 사람(또는 미상)인 부모도 공장의 세대다
  for (const parentAuthor of [humanAuthor("LeeHyeonKyu"), null]) {
    const chain = {
      ...issues,
      60: { number: 60, body: "Detected while implementing #7. evidence: {}", labels: ["backlog"], author: parentAuthor },
      61: flakyFrom(61, 60, appAuthor("ktb-factory")),
    };
    const deep = await makeQueueAdmission({ gh: ghOver(chain), charter: charter(), factoryLogins: FACTORY })({ issue: 61 });
    expect(deep.ok).toBe(false);
    expect(deep.reasons.join(" ")).toMatch(/generation 2 > 1/);
  }
  // 상한의 판정은 마커 또는 라벨 또는 공장 작성자다(plan non_goals[1]): 사람이 붙여 넣은 마커(done_when 있음)도,
  // 라벨만 단 이슈도 상한에는 센다 — 상한을 면제 규칙(공장 작성자의 마커)으로 좁히거나 라벨 경로를 좁히면 여기서 실패한다
  const fullCaps = [1, 2].map((number) => ({ number }));
  for (const it of [
    { number: 70, body: `${person.body}\n\nDetected while implementing #7.`, labels: ["backlog"], author: "LeeHyeonKyu" },
    { number: 72, body: person.body, labels: ["backlog", "factory:flaky"], author: "LeeHyeonKyu" },
  ]) {
    const r = queueAdmission({ issue: it, charter: charter(), ...base, openSelfGenerated: fullCaps });
    expect(r.self_generated, String(it.number)).toBe(true);
    expect(r.reasons, String(it.number)).toEqual(["self-generated open 2 ≥ 2 (self_generated.open_max)"]);
  }
  // #136 세대 접기는 그대로다 — 사람 #17 → 개선 #20 → 하네스 #50 → flaky #70(소유자 작성)은 한 세대
  const spec = {
    17: { number: 17, body: person.body, labels: ["backlog"], author: humanAuthor("LeeHyeonKyu") },
    20: { ...improvement(20, "LeeHyeonKyu/own-calendar#17"), author: appAuthor("ktb-factory") },
    50: { number: 50, body: "<!-- factory-harness-request for=20 -->\nharness", labels: ["backlog", "factory:harness"], author: appAuthor("ktb-factory") },
    70: flakyFrom(70, 50, humanAuthor("LeeHyeonKyu")),
    71: flakyFrom(71, 20, humanAuthor("LeeHyeonKyu")),
  };
  const specAdmit = makeQueueAdmission({ gh: ghOver(spec), charter: charter(), factoryLogins: FACTORY });
  expect(await specAdmit({ issue: 70 })).toEqual({ ok: true, reasons: [], self_generated: true });
  expect((await specAdmit({ issue: 71 })).reasons.join(" ")).toMatch(/generation 2 > 1/);

  // rework spec1 — 상한의 판정은 plan non_goals[1]대로 **마커 또는 라벨 또는 공장 작성자**다. 마커·라벨 없이 done_when을 가진
  // 이슈도 작성자가 공장 로그인이면 open_max에 센다 — 작성자 갈래를 지우면 여기서 실패한다.
  const appFeature = { ...busy, 90: { number: 90, body: person.body, labels: ["backlog"], author: appAuthor("ktb-factory") } };
  const lists = { lists: { "factory:flaky": [{ number: 41 }, { number: 51 }, { number: 52 }] } };
  const byApp = await makeQueueAdmission({ gh: ghOver(appFeature, lists), charter: charter(), factoryLogins: FACTORY })({ issue: 90 });
  expect(byApp).toEqual({ ok: false, reasons: ["self-generated open 2 ≥ 2 (self_generated.open_max)"], self_generated: true });
  // 같은 이슈를 사람이 쓰면 자기생성이 아니다
  const byPerson = await makeQueueAdmission({ gh: ghOver({ ...appFeature, 90: { ...appFeature[90], author: humanAuthor("LeeHyeonKyu") } }, lists), charter: charter(), factoryLogins: FACTORY })({ issue: 90 });
  expect(byPerson).toEqual({ ok: true, reasons: [], self_generated: false });
  // 알려진 한계(plan non_goals[3] — 공유 계정에서는 사람과 에이전트를 가를 수 없다, 고치지 않고 핀한다): 공장이 소유자 계정으로
  // 도는 저장소(PAT 폴백)에서는 소유자가 쓴 보통 피처도 공장 작성자라 open_max에 세지고, 그 피처에서 수확한 flaky는 2세대다.
  const SHARED = async () => ({ ok: true, logins: ["LeeHyeonKyu"] });
  const full = {
    ...busy,
    80: { number: 80, body: person.body, labels: ["backlog"], author: humanAuthor("LeeHyeonKyu") },
    81: flakyFrom(81, 7, humanAuthor("LeeHyeonKyu")),
  };
  const fiveOpen = [41, 51, 52, 53, 54, 55];
  for (const k of [53, 54, 55]) full[k] = { ...flakyFrom(k, 7, humanAuthor("LeeHyeonKyu")), labels: ["factory:queue", "factory:flaky"] };
  full[41] = { ...full[41], labels: ["factory:in-progress", "factory:flaky"] };
  const sharedAdmit = makeQueueAdmission({ gh: ghOver(full, { lists: { "factory:flaky": fiveOpen.map((number) => ({ number })) } }), charter: { ...charter(), self_generated: { open_max: 5, depth_max: 1 } }, factoryLogins: SHARED });
  expect(await sharedAdmit({ issue: 80 })).toEqual({ ok: false, reasons: ["self-generated open 6 ≥ 5 (self_generated.open_max)"], self_generated: true });
  // 같은 배선에서 공장의 flaky도 open_max에 걸린다(상한은 풀리지 않았다)
  expect((await sharedAdmit({ issue: 81 })).reasons.join(" ")).toMatch(/self-generated open 6 ≥ 5/);
  // 소유자가 쓴 #7은 공유 로그인에서 공장 세대다 — 그 아래 flaky는 2세대로 depth_max에 걸린다(공장 로그인을 모르면 1세대)
  const quiet = makeQueueAdmission({ gh: ghOver({ 7: issues[7], 81: full[81] }), charter: charter(), factoryLogins: SHARED });
  expect((await quiet({ issue: 81 })).reasons).toEqual(["self-generated generation 2 > 1 (self_generated.depth_max) — an issue the factory made from an issue the factory made"]);
  const unshared = makeQueueAdmission({ gh: ghOver({ 7: issues[7], 81: full[81] }), charter: charter(), factoryLogins: FACTORY });
  expect(await unshared({ issue: 81 })).toEqual({ ok: true, reasons: [], self_generated: true });
});
