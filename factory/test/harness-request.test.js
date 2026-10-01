import { test, expect, vi } from "vitest";
import { harnessNeeded, harnessIssueTitle, harnessIssueBody, parseBlocks, parkedReason, ensureHarnessIssue, harnessRequestMarker, parseHarnessRequestFor, HARNESS_LABEL } from "../lib/harness-request.js";
import { validate } from "../lib/schemas.js";

/**
 * ADR-020 KTB-23 — 데모 #2: feature 001이 `pg` 패키지를 필요로 했는데 builder는 `package.json`을 편집할
 * 수 없다(의도된 설계다). 프롬프트가 시킨 대응은 "PR 본문에 'Harness change needed'라고 쓰고 마무리"였고,
 * 그 산문을 읽는 기계는 없었다 — verifier가 "done_when에 대응하는 테스트가 없다"로 reject → needs-human →
 * 사람이 재큐 → 같은 일. 네 라운드, ≈$67, 머지 0건. 이 파일은 그 산문이 필드가 된 뒤의 계약을 고정한다.
 */
const PG = { file: "package.json", change: "add dependency pg@^8 to dependencies", why: "done_when dw1/dw3/dw4 need a Postgres client" };
const COMPOSE = { file: "docker-compose.test.yml", change: "add a postgres:16 service", why: "dw3 is an integration test against a real DB" };

test("harnessNeeded keeps only well-formed entries — a half-filled request is not a request", () => {
  expect(harnessNeeded(undefined)).toEqual([]);
  expect(harnessNeeded({ harness_needed: [] })).toEqual([]);
  expect(harnessNeeded({ harness_needed: "package.json" })).toEqual([]);
  expect(harnessNeeded({ harness_needed: [PG] })).toEqual([PG]);
  expect(harnessNeeded({ harness_needed: [PG, { file: "x", change: "", why: "y" }, { file: "z" }, null] })).toEqual([PG]);
});

test("the title is the human line: issue-scoped, one line, and it says how many entries there are", () => {
  expect(harnessIssueTitle([PG], 2)).toBe("harness: add dependency pg@^8 to dependencies — for #2");
  expect(harnessIssueTitle([PG, COMPOSE], 2)).toBe("harness: add dependency pg@^8 to dependencies (+1 more) — for #2");
  expect(harnessIssueTitle([PG], 2)).toBe(harnessIssueTitle([{ ...PG }], 2));
  // 다른 이슈의 같은 요청은 다른 이슈다
  expect(harnessIssueTitle([PG], 5)).not.toBe(harnessIssueTitle([PG], 2));
  // 줄바꿈·파이프가 들어와도 제목은 한 줄이고, 길면 잘린다
  const long = harnessIssueTitle([{ ...PG, change: `x|y\n${"a".repeat(200)}` }], 2);
  expect(long.split("\n")).toHaveLength(1);
  expect(long.length).toBeLessThan(140);
});

test("the body carries every entry and ends with the Blocks line merge-stage reads back", () => {
  const body = harnessIssueBody({ entries: [PG, COMPOSE], issue: 2, pr: 17 });
  for (const e of [PG, COMPOSE]) { expect(body).toContain(e.file); expect(body).toContain(e.change); expect(body).toContain(e.why); }
  expect(body).toContain("PR #17");
  expect(body.trim().split("\n").at(-1)).toBe("Blocks: #2");
  // 왕복: 본문을 쓴 쪽과 읽는 쪽이 같은 문법을 쓴다(두 곳이 갈라지면 피처 이슈가 영원히 주차된다)
  expect(parseBlocks(body)).toEqual([2]);
  expect(harnessIssueBody({ entries: [PG], issue: 2 })).not.toContain("PR #");
  // ADR-020 KTB-23 fix — dedupe 키는 제목이 아니라 본문 첫 줄의 기계 마커다
  expect(body.split("\n")[0]).toBe(harnessRequestMarker(2));
  expect(parseHarnessRequestFor(body)).toBe(2);
});

test("parseHarnessRequestFor reads the namespaced marker, and only that (KTB-23 fix)", () => {
  expect(harnessRequestMarker(2)).toBe("<!-- factory-harness-request for=2 -->");
  expect(parseHarnessRequestFor(harnessRequestMarker(31))).toBe(31);
  expect(parseHarnessRequestFor("Blocks: #2")).toBeNull();        // `Blocks:`는 사람의 줄이다 — 키가 아니다
  expect(parseHarnessRequestFor(null)).toBeNull();
  expect(parseHarnessRequestFor(undefined)).toBeNull();
});

test("parseBlocks: several targets, several lines, dedupe — and silence for a body that has none", () => {
  expect(parseBlocks("Blocks: #2, #5")).toEqual([2, 5]);
  expect(parseBlocks("Blocks: #2\nsomething\nBlocks: #2, #9")).toEqual([2, 9]);
  expect(parseBlocks("a normal issue body\nfixes #4")).toEqual([]);       // `Blocks:` 줄만 본다
  expect(parseBlocks(null)).toEqual([]);
  expect(parseBlocks(undefined)).toEqual([]);
});

test("parkedReason names the harness issue — the feature issue's transition comment is the only pointer a human gets", () => {
  expect(parkedReason(31)).toBe("waiting for harness issue #31");
});

test("ensureHarnessIssue opens ONE issue, labelled queue + harness, and reuses the open one that carries this issue's marker", async () => {
  const gh = { issueList: vi.fn(async () => []), createIssue: vi.fn(async () => 31) };
  const first = await ensureHarnessIssue({ gh, issue: 2, entries: [PG], pr: 17 });
  // #136 (S2b): 큐가 아니라 backlog로 태어난다 — 큐로 가는 한 걸음은 주입된 문만이 만든다(여기엔 문이 없다)
  expect(first).toEqual({ issue: 31, created: true, title: harnessIssueTitle([PG], 2), queued: false, queue_reason: HARNESS_TRANSITION_UNWIRED });
  expect(gh.issueList).toHaveBeenCalledWith({ labels: [HARNESS_LABEL], state: "open" });
  expect(gh.createIssue).toHaveBeenCalledWith(expect.objectContaining({ labels: ["backlog", HARNESS_LABEL] }));
  expect(gh.createIssue.mock.calls[0][0].body).toContain(harnessRequestMarker(2));

  // ADR-020 KTB-23 fix: 두 번째 라운드의 요청이 **다르게 적혀도**(제목이 달라져도) 이슈는 하나다 —
  // 예전에는 제목이 dedupe 키라 `change` 한 글자만 바뀌면 같은 피처에 두 번째 하네스 이슈가 열렸다.
  const existing = { number: 31, title: "사람이 고쳐 쓴 제목", body: harnessIssueBody({ entries: [PG], issue: 2 }) };
  const gh2 = { issueList: async () => [existing], createIssue: vi.fn() };
  const reused = await ensureHarnessIssue({ gh: gh2, issue: 2, entries: [{ ...PG, change: "add dependency pg@^8.11" }] });
  expect(reused).toEqual({ issue: 31, created: false, appended: 0, title: "사람이 고쳐 쓴 제목" });
  expect(gh2.createIssue).not.toHaveBeenCalled();

  // 다른 피처의 마커를 단 열린 하네스 이슈는 재사용 대상이 아니다
  const gh3 = { issueList: async () => [{ number: 31, title: "x", body: harnessIssueBody({ entries: [PG], issue: 5 }) }], createIssue: vi.fn(async () => 40) };
  expect((await ensureHarnessIssue({ gh: gh3, issue: 2, entries: [PG] })).issue).toBe(40);
});

test("ensureHarnessIssue fails closed: an unreadable list or a create that returns no number throws (never a duplicate)", async () => {
  await expect(ensureHarnessIssue({ gh: { issueList: async () => { throw new Error("gh down"); } }, issue: 2, entries: [PG] })).rejects.toThrow(/gh down/);
  await expect(ensureHarnessIssue({ gh: { issueList: async () => [], createIssue: async () => null }, issue: 2, entries: [PG] })).rejects.toThrow(/no issue number/);
});

// 스키마: 선택 필드다 — 없는 것이 정상이고, 있으면 세 문자열을 다 갖춰야 한다.
test("implement.v1 accepts a handoff without harness_needed, and validates the entries when it is there", () => {
  const base = {
    issue: 2, head_sha: "a".repeat(40), pr: 17,
    gates: { status: "GREEN" }, verifier: { verdict: "rejected" },
    orchestration: "workflow", guarantee: "structural",
  };
  expect(validate("implement.v1", base).ok).toBe(true);
  expect(validate("implement.v1", { ...base, harness_needed: [PG] }).ok).toBe(true);
  expect(validate("implement.v1", { ...base, harness_needed: [] }).ok).toBe(true);
  const bad = validate("implement.v1", { ...base, harness_needed: [{ file: "package.json" }] });
  expect(bad.ok).toBe(false);
  expect(bad.errors.join("; ")).toMatch(/harness_needed\[0\]\.change is required/);
  expect(validate("implement.v1", { ...base, harness_needed: "package.json" }).ok).toBe(false);
});

// ── T3 리뷰 SF-2 — 재사용은 **덧붙이기**여야 한다 ───────────────────────────────────────────────
// 조기 반환이 재진입 멱등성을 사 주지만, 그 대가로 **새로** 나온 요청이 조용히 사라졌다.
test("ensureHarnessIssue: 열린 이슈에 빠진 줄만 덧붙인다(같은 파일은 다시 넣지 않는다)", async () => {
  const { appendHarnessEntries } = await import("../lib/harness-request.js");
  const existing = { number: 31, title: "t", body: harnessIssueBody({ entries: [PG], issue: 2 }) };
  const edits = [];
  const gh = { issueList: async () => [existing], createIssue: vi.fn(), editIssueBody: async (n, body) => edits.push({ n, body }) };

  // 같은 파일 → 덧붙일 것이 없다. 본문을 건드리지 않는다(같은 머지를 다시 읽어도 표가 자라지 않는다).
  const same = await ensureHarnessIssue({ gh, issue: 2, entries: [{ ...PG, change: "reworded" }] });
  expect(same).toMatchObject({ issue: 31, created: false, appended: 0 });
  expect(edits).toEqual([]);

  // 다른 파일 → 표에 한 줄이 붙는다
  const more = { file: "docs/factory/CHARTER.md", change: "add a docs tier roster", why: "the docs roster is empty" };
  const appended = await ensureHarnessIssue({ gh, issue: 2, entries: [PG, more] });
  expect(appended).toMatchObject({ issue: 31, created: false, appended: 1 });
  expect(edits).toHaveLength(1);
  expect(edits[0].body).toContain("docs/factory/CHARTER.md");
  expect(edits[0].body.match(/^\| `/gm)).toHaveLength(2);
  // 표 아래의 산문은 그대로다(사람이 덧붙인 메모를 밀어내지 않는다)
  expect(edits[0].body).toContain("Blocks: #2");

  // 순수 함수도 같은 계약을 지킨다
  expect(appendHarnessEntries("no table here", [PG]).added).toHaveLength(1);
  expect(appendHarnessEntries(existing.body, [PG]).body).toBe(existing.body);
});

test("ensureHarnessIssue: 본문 편집을 못 하는 어댑터에서는 예전 그대로 동작한다", async () => {
  const existing = { number: 31, title: "t", body: harnessIssueBody({ entries: [PG], issue: 2 }) };
  const gh = { issueList: async () => [existing], createIssue: vi.fn() };
  const r = await ensureHarnessIssue({ gh, issue: 2, entries: [{ file: "x.json", change: "c", why: "w" }] });
  expect(r).toMatchObject({ issue: 31, created: false, appended: 0 });
  expect(gh.createIssue).not.toHaveBeenCalled();
});

// ── #136 (S2b, 설계 2026-09-30 §8.2) — 하네스 이슈는 **문**을 지나 큐로 간다 ─────────────────────────
// 예전에는 `factory:queue`로 태어났다 — 리허설·큐 길이·자기생성 상한을 지나지 않는 유일한 큐 진입 경로였다.
// 이제 `backlog`로 태어나고, 큐로 가는 한 걸음은 호출자가 넘긴 `transitionIssue`(= 문)만이 만든다. 여기의
// 문은 **진짜** `transition()` + **진짜** `makeQueueAdmission`을 가짜 gh 위에 합성한 것이다(합성은 이 테스트
// 파일에만 있다 — lib/harness-request.js는 transition.js도 admission.js도 import하지 않는다). 판정은 mock
// 호출 횟수가 아니라 가짜 gh의 **최종 라벨 상태**로 한다.
import { HARNESS_TRANSITION_UNWIRED, stillBacklogReason } from "../lib/harness-request.js";
import { transition as realTransition } from "../lib/transition.js";
import { makeQueueAdmission } from "../lib/admission.js";
import { STATES } from "../lib/labels.js";
import { REHEARSAL_STALE } from "../lib/rehearsal.js";
import { readFileSync as readSrc } from "node:fs";
import { createHash } from "node:crypto";

/** 이슈 저장소를 흉내 내는 가짜 gh — 라벨·코멘트가 실제로 바뀐다(진짜 transition()이 그 위에서 돈다). */
function doorGh({ queued = 0, feature = { number: 2, author: "LeeHyeonKyu", labels: ["factory:in-progress"], body: "## done_when\n- [ ] x" }, failComment = false } = {}) {
  const store = new Map();
  let seq = 30;
  const put = (i) => store.set(i.number, { state: "open", title: `#${i.number}`, author: "factory-bot", comments: [], ...i, labels: [...i.labels] });
  if (feature) put(feature);
  for (let k = 0; k < queued; k++) put({ number: 100 + k, labels: ["factory:queue"], author: "LeeHyeonKyu", body: "## done_when\n- [ ] q" });
  const gh = {
    store,
    async issueList({ labels = [] } = {}) { return [...store.values()].filter((i) => i.state === "open" && labels.every((l) => i.labels.includes(l))); },
    async createIssue({ title, body, labels = [] }) { const number = (seq += 1); put({ number, title, body, labels }); return number; },
    async issue(n) { const i = store.get(Number(n)); if (!i) throw new Error(`no issue #${n}`); return { ...i, labels: [...i.labels] }; },
    async comments(n) { return (store.get(Number(n))?.comments ?? []).map((c) => ({ ...c })); },
    async comment(n, body) {
      if (failComment && body.includes("factory-harness-not-queued")) throw new Error("gh comment failed (1): HTTP 502");
      store.get(Number(n)).comments.push({ body, author: "factory-bot" });
    },
    async setFactoryLabel(n, to) { const i = store.get(Number(n)); i.labels = [...i.labels.filter((l) => !STATES.has(l)), to]; },
    async searchIssues(label) { return [...store.values()].filter((i) => i.state === "open" && i.labels.includes(label)).map((i) => ({ number: i.number, title: i.title })); },
  };
  return gh;
}
const doorCharter = (over = {}) => ({ never_automate: [], back_pressure: { queue_max: 3 }, self_generated: { open_max: 5, depth_max: 1 }, ...over });
/** 진짜 문: rehearsal + admission을 배선한 진짜 transition(). run-stage의 `transitionIssue`와 같은 모양이다. */
const door = (gh, { rehearsal = async () => ({ ok: true }), charter = doorCharter() } = {}) =>
  ({ issue: n, to, reason }) => realTransition({ gh, issue: n, to, reason, rehearsal, admission: makeQueueAdmission({ gh, charter }), env: {} });
const notQueued = (gh, n) => gh.store.get(n).comments.filter((c) => c.body.includes(`<!-- factory-harness-not-queued issue=${n} -->`));

test("test_136_harness_issue_born_in_backlog", async () => {
  // (a) 문이 열려 있다(리허설 ok, 큐 여유) → 이슈는 backlog로 태어나 문을 지나 factory:queue에 선다
  const gh = doorGh({ queued: 1 });
  const created = [];
  const spyGh = { ...gh, createIssue: async (a) => { created.push(a); return gh.createIssue(a); } };
  const calls = [];
  const t = door(gh);
  const r = await ensureHarnessIssue({ gh: spyGh, issue: 2, entries: [PG], pr: 17, transitionIssue: async (a) => { calls.push(a); return t(a); } });
  expect(created[0].labels).toEqual(["backlog", HARNESS_LABEL]);
  expect(r).toMatchObject({ issue: 31, created: true, queued: true });
  expect(gh.store.get(31).labels).toEqual([HARNESS_LABEL, "factory:queue"]);
  // 큐로 가는 한 걸음은 **새 하네스 이슈**에 대한 문 한 번뿐이다 — 피처 이슈(#2)는 건드리지 않는다
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ issue: 31, to: "factory:queue" });
  expect(gh.store.get(2).labels).toEqual(["factory:in-progress"]);
  // 문을 지났다는 기록은 진짜 transition()의 전이 코멘트다
  expect(gh.store.get(31).comments.some((c) => c.body.includes("from=backlog to=factory:queue"))).toBe(true);
  expect(notQueued(gh, 31)).toEqual([]);

  // (b) 큐가 가득 찼다(queue_max 3, 이미 3건) → 진짜 심사가 거부하고 이슈는 backlog에 남는다
  const full = doorGh({ queued: 3 });
  const r2 = await ensureHarnessIssue({ gh: full, issue: 2, entries: [PG], transitionIssue: door(full) });
  expect(r2).toMatchObject({ issue: 31, created: true, queued: false });
  expect(full.store.get(31).labels).toEqual(["backlog", HARNESS_LABEL]);
  expect(r2.queue_reason).toMatch(/queue 3 ≥ 3 \(back_pressure\.queue_max\)/);

  // 모듈 경계: 이 lib은 문을 import하지 않는다(문은 호출자가 주입한다)
  const src = readSrc(new URL("../lib/harness-request.js", import.meta.url), "utf8");
  expect(src).not.toMatch(/from\s+["'][^"']*transition\.js["']/);
  expect(src).not.toMatch(/from\s+["'][^"']*admission\.js["']/);
});

test("test_136_harness_issue_stays_backlog_when_refused", async () => {
  // (1) 리허설 거부 — 사유를 그대로 싣고, 다음 걸음은 `factory rehearse` 뒤 `:next`
  const gh1 = doorGh();
  const r1 = await ensureHarnessIssue({ gh: gh1, issue: 2, entries: [PG], transitionIssue: door(gh1, { rehearsal: async () => ({ ok: false, reason: `${REHEARSAL_STALE} — recorded fp abc, current def` }) }) });
  expect(r1).toMatchObject({ issue: 31, created: true, queued: false });
  expect(r1.queue_reason).toContain(`${REHEARSAL_STALE} — recorded fp abc, current def`);
  expect(gh1.store.get(31).labels).toEqual(["backlog", HARNESS_LABEL]);
  const c1 = notQueued(gh1, 31);
  expect(c1).toHaveLength(1);
  expect(c1[0].body).toContain(`${REHEARSAL_STALE} — recorded fp abc, current def`);
  expect(c1[0].body).toContain("factory rehearse");
  expect(c1[0].body).toContain("/know-thy-build:next");

  // (2) 심사 거부(열린 자기생성 상한 open_max) — 발동한 상한을 이름으로 대고, `:next`만으로는 다시 거부된다고 말한다.
  //     세대 상한(depth_max)의 코멘트는 test_136_not_queued_next_step_matches_refusal_kind가 고정한다.
  const gh2 = doorGh({ feature: null });
  const tight = doorCharter({ self_generated: { open_max: 0, depth_max: 1 } });
  const r2 = await ensureHarnessIssue({ gh: gh2, issue: 2, entries: [PG], transitionIssue: door(gh2, { charter: tight }) });
  expect(r2).toMatchObject({ queued: false });
  expect(gh2.store.get(31).labels).toEqual(["backlog", HARNESS_LABEL]);
  const c2 = notQueued(gh2, 31);
  expect(c2).toHaveLength(1);
  expect(c2[0].body).toContain(r2.queue_reason);
  expect(c2[0].body).toContain("self_generated.open_max");
  expect(c2[0].body).toMatch(/`?\/know-thy-build:next`? alone will be refused again/);
  expect(c2[0].body).not.toContain("factory rehearse");

  // (3) 문이 던진다 — 이슈는 backlog, 코멘트 하나, ensureHarnessIssue는 던지지 않는다
  const gh3 = doorGh();
  const r3 = await ensureHarnessIssue({ gh: gh3, issue: 2, entries: [PG], transitionIssue: async () => { throw new Error("gh api 500 on label swap"); } });
  expect(r3).toMatchObject({ issue: 31, created: true, queued: false });
  expect(r3.queue_reason).toContain("gh api 500 on label swap");
  expect(gh3.store.get(31).labels).toEqual(["backlog", HARNESS_LABEL]);
  expect(notQueued(gh3, 31)).toHaveLength(1);
  expect(notQueued(gh3, 31)[0].body).toContain("gh api 500 on label swap");

  // (4) 코멘트 쓰기마저 실패해도 던지지 않고, 반환값이 진실을 말한다
  const gh4 = doorGh({ failComment: true });
  const r4 = await ensureHarnessIssue({ gh: gh4, issue: 2, entries: [PG], transitionIssue: door(gh4, { rehearsal: async () => ({ ok: false, reason: REHEARSAL_STALE }) }) });
  expect(r4).toMatchObject({ issue: 31, created: true, queued: false });
  expect(r4.queue_reason).toContain(REHEARSAL_STALE);
  expect(gh4.store.get(31).labels).toEqual(["backlog", HARNESS_LABEL]);

  // (5) 문이 배선되지 않았다 — 큐에 넣지 않고, 라벨도 안 바뀌고, 반환값이 그 사실을 말한다
  const gh5 = doorGh();
  const r5 = await ensureHarnessIssue({ gh: gh5, issue: 2, entries: [PG] });
  expect(r5).toMatchObject({ issue: 31, created: true, queued: false });
  expect(r5.queue_reason).toMatch(/no transition (is )?wired/);
  expect(gh5.store.get(31).labels).toEqual(["backlog", HARNESS_LABEL]);
  expect(gh5.store.get(31).comments.filter((c) => /factory-transition:v1/.test(c.body))).toEqual([]);
});

test("test_136_not_queued_next_step_matches_refusal_kind", async () => {
  // (a) 세대 상한(depth_max) — 진짜 심사가 자기생성 사슬의 세대로 거부한다. 다음 걸음은 사람이 직접 하거나 CHARTER를 바꾸는 것이고,
  //     `:next`만으로는 다시 거부되며, 리허설은 답이 아니다.
  //     사슬: 사람 #10 ← 개선 #2(공장이 #10에서 만든 개선) ← 개선 #3(#2에서 만든 개선, 하네스가 아님) — #3의 하네스 요청은
  //     하네스이니 세대를 더하지 않지만, #3 자체가 이미 2세대라 depth_max=1이 걸린다.
  const gh = doorGh({ feature: { number: 10, author: "LeeHyeonKyu", labels: ["factory:done"], body: "## done_when\n- [ ] p" } });
  gh.store.set(2, { number: 2, state: "open", title: "#2", author: "factory-bot", comments: [], labels: ["factory:in-progress"], body: "<!-- factory-improvement fp=a1 from=o/r#10 -->\n## done_when\n- [ ] a" });
  gh.store.set(3, { number: 3, state: "open", title: "#3", author: "factory-bot", comments: [], labels: ["factory:in-progress"], body: "<!-- factory-improvement fp=b2 from=o/r#2 -->\n## done_when\n- [ ] b" });
  const ra = await ensureHarnessIssue({ gh, issue: 3, entries: [PG], transitionIssue: door(gh) });
  expect(ra).toMatchObject({ created: true, queued: false });
  expect(ra.queue_reason).toMatch(/^queue admission refused/);
  expect(ra.queue_reason).toContain("self_generated.depth_max");
  expect(gh.store.get(ra.issue).labels).toEqual(["backlog", HARNESS_LABEL]);
  const ca = notQueued(gh, ra.issue);
  expect(ca).toHaveLength(1);
  expect(ca[0].body).toContain(ra.queue_reason);
  expect(ca[0].body).toContain("`self_generated.depth_max`");
  expect(ca[0].body).toMatch(/alone will be refused again/);
  expect(ca[0].body).toContain("CHARTER");
  expect(ca[0].body).not.toContain("factory rehearse");

  // (b) 문 배선 누락(심사기 없음) — 고칠 것은 공장 배선이다. 리허설도, 상한 해제도 답이 아니다.
  const gh2 = doorGh();
  const unwired = ({ issue: n, to, reason }) => realTransition({ gh: gh2, issue: n, to, reason, rehearsal: async () => ({ ok: true }), env: {} });
  const rb = await ensureHarnessIssue({ gh: gh2, issue: 2, entries: [PG], transitionIssue: unwired });
  expect(rb).toMatchObject({ created: true, queued: false });
  expect(rb.queue_reason).toMatch(/no queue admission is wired/);
  const cb = notQueued(gh2, rb.issue);
  expect(cb).toHaveLength(1);
  expect(cb[0].body).toContain(rb.queue_reason);
  expect(cb[0].body).not.toContain("factory rehearse");
  expect(cb[0].body).not.toMatch(/alone will be refused again/);
  expect(cb[0].body).toMatch(/배선/);
  expect(cb[0].body).toContain("/know-thy-build:next");

  // (c) 상태 그래프·라벨 거부(문이 리허설·심사가 아닌 이유로 거부) — 리허설 권유를 하지 않는다
  const gh3 = doorGh();
  const rc = await ensureHarnessIssue({ gh: gh3, issue: 2, entries: [PG], transitionIssue: async () => ({ ok: false, reason: "no factory state label on issue" }) });
  expect(rc).toMatchObject({ created: true, queued: false, queue_reason: "no factory state label on issue" });
  const cc = notQueued(gh3, rc.issue);
  expect(cc).toHaveLength(1);
  expect(cc[0].body).toContain("no factory state label on issue");
  expect(cc[0].body).not.toContain("factory rehearse");
  expect(cc[0].body).toMatch(/라벨/);
  expect(cc[0].body).toContain("/know-thy-build:next");
});

test("test_136_reuse_does_not_retransition", async () => {
  // 같은 for=<n> 마커를 단 열린 하네스 이슈가 있으면: 새 이슈 없음, 문 호출 없음, 표 덧붙이기는 예전 그대로
  const gh = doorGh();
  const existingBody = harnessIssueBody({ entries: [PG], issue: 2 });
  gh.store.set(31, { number: 31, title: "사람이 고쳐 쓴 제목", body: existingBody, labels: ["backlog", HARNESS_LABEL], state: "open", comments: [], author: "factory-bot" });
  gh.editIssueBody = async (n, body) => { gh.store.get(n).body = body; };
  let createCalls = 0, doorCalls = 0;
  const spy = { ...gh, createIssue: async (a) => { createCalls += 1; return gh.createIssue(a); } };
  const t = door(gh);
  const r = await ensureHarnessIssue({ gh: spy, issue: 2, entries: [PG, COMPOSE], transitionIssue: async (a) => { doorCalls += 1; return t(a); } });
  // 재사용은 문을 다시 두드리지 않지만, 이슈가 아직 backlog라는 사실은 말한다(skeptic #136 f2/f3)
  expect(r).toEqual({ issue: 31, created: false, appended: 1, title: "사람이 고쳐 쓴 제목", queued: false, queue_reason: stillBacklogReason(31) });
  expect(createCalls).toBe(0);
  expect(doorCalls).toBe(0);
  expect(gh.store.get(31).labels).toEqual(["backlog", HARNESS_LABEL]);      // 재사용 경로는 다시 문을 두드리지 않는다
  expect(gh.store.get(31).body).toContain("docker-compose.test.yml");

  // 기본 경로(implement)의 본문 바이트는 한 글자도 안 바뀐다 — #136 이전 본문의 sha256으로 고정한다
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  expect(sha(harnessIssueBody({ entries: [PG, COMPOSE], issue: 2, pr: 17 }))).toBe(PINNED_BODY_SHA);
  const fresh = doorGh();
  await ensureHarnessIssue({ gh: fresh, issue: 2, entries: [PG, COMPOSE], pr: 17, transitionIssue: door(fresh) });
  expect(sha(fresh.store.get(31).body)).toBe(PINNED_BODY_SHA);
  // 대조군: **새로 만든** 이슈는 문을 한 번 지났다(backlog → queue 전이 코멘트) — 재사용 경로와의 차이가 곧 계약이다
  expect(fresh.store.get(31).comments.filter((c) => c.body.includes("from=backlog to=factory:queue"))).toHaveLength(1);
});

/** #136 이전의 `harnessIssueBody({ entries: [PG, COMPOSE], issue: 2, pr: 17 })` — 기본 경로 본문의 바이트 고정값. */
const PINNED_BODY_SHA = "94b6cd5d1f651ec690ae86d18aa77671bb6986fa441737f551e8fcf4f6ad012f";

// ── #136 skeptic f2/f3 — 재사용 경로도 **backlog에 서 있는** 하네스 이슈를 사실대로 말한다 ─────────────────────
// 재사용 경로는 문을 다시 두드리지 않는다(plan non_goals). 그런데 첫 라운드에 거부돼 backlog에 남은 이슈를 재사용하면서
// `queued`를 싣지 않으면, 호출자(피드백 영수증·주차 사유·런 기록)는 "고쳐지는 중"이라는 예전 문구로 떨어진다 — 아무도 그 이슈를
// 집지 않는데. 재사용 반환값은 이슈의 **현재 라벨**을 보고 backlog면 queued:false와 그 이유를 싣는다.
test("test_136_reuse_reports_backlogged_harness", async () => {
  // 첫 라운드: 큐가 가득 차 문이 거부했다 → #31은 backlog에 남는다
  const gh = doorGh({ queued: 3 });
  gh.editIssueBody = async (n, body) => { gh.store.get(n).body = body; };
  const first = await ensureHarnessIssue({ gh, issue: 2, entries: [PG], transitionIssue: door(gh) });
  expect(first).toMatchObject({ issue: 31, created: true, queued: false });
  expect(gh.store.get(31).labels).toEqual(["backlog", HARNESS_LABEL]);
  // 둘째 라운드: 같은 피처의 다른 요청 → 같은 #31을 재사용하고 한 줄을 덧붙인다. 문은 다시 두드리지 않는다.
  let doorCalls = 0;
  const t = door(gh);
  const again = await ensureHarnessIssue({ gh, issue: 2, entries: [PG, COMPOSE], transitionIssue: async (a) => { doorCalls += 1; return t(a); } });
  expect(doorCalls).toBe(0);
  expect(again).toMatchObject({ issue: 31, created: false, appended: 1, queued: false });
  expect(again.queue_reason).toContain("#31");
  expect(again.queue_reason).toMatch(/backlog/);
  expect(again.queue_reason).toMatch(/\/know-thy-build:next/);
  expect(gh.store.get(31).labels).toEqual(["backlog", HARNESS_LABEL]);
  // 편집 능력이 없는 어댑터(덧붙이기 없음)에서도 같은 사실을 말한다
  const plain = { ...gh, editIssueBody: undefined };
  expect(await ensureHarnessIssue({ gh: plain, issue: 2, entries: [PG] })).toMatchObject({ issue: 31, created: false, appended: 0, queued: false });

  // 대조군: 이미 큐(또는 그 뒤)에 선 하네스 이슈를 재사용하면 backlog라고 말하지 않는다
  gh.store.get(31).labels = [HARNESS_LABEL, "factory:queue"];
  const queuedReuse = await ensureHarnessIssue({ gh, issue: 2, entries: [PG] });
  expect(queuedReuse.queued).not.toBe(false);
  expect(queuedReuse).not.toHaveProperty("queue_reason");
  // 라벨을 모르면(라벨 없는 목록) 발명하지 않는다 — 예전 반환값 그대로
  const unknown = await ensureHarnessIssue({ gh: { issueList: async () => [{ number: 31, title: "t", body: gh.store.get(31).body }] }, issue: 2, entries: [PG] });
  expect(unknown).toEqual({ issue: 31, created: false, appended: 0, title: "t" });
});
