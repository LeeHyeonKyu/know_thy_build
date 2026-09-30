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
  expect(first).toEqual({ issue: 31, created: true, queued: false, queue_reason: expect.stringMatching(/no transition wiring supplied/), title: harnessIssueTitle([PG], 2) });
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

// ── #130 (S2b) — 하네스 이슈는 `backlog`로 태어나 **큐 진입 심사를 지나** 큐로 간다 ──────────────────────
// 예전에는 `factory:queue`로 태어나 심사(리허설·큐 길이·자기생성 상한)를 통째로 비켜 갔다 — 큐로 가는
// 유일한 뒷문이었다. 이제 한 걸음은 호출자가 넘긴 `transition`이 내딛고, 거부되면 이슈는 backlog에 남는다.
import { transition as realTransition } from "../lib/transition.js";
import { makeQueueAdmission } from "../lib/admission.js";
import { STATES } from "../lib/labels.js";

/** 이 배열이 곧 저장소인 gh 더블 — 라벨·코멘트가 실제로 바뀌므로 "큐에 들어갔는가"를 상태로 본다. */
function fakeRepo(seed = []) {
  const issues = new Map(seed.map((i) => [i.number, { comments: [], state: "open", ...i }]));
  let next = 100;
  return {
    issues,
    labelsOf: (n) => issues.get(n)?.labels ?? null,
    commentsOf: (n) => (issues.get(n)?.comments ?? []).map((c) => c.body),
    async issueList({ labels = [], state = "open" } = {}) {
      return [...issues.values()].filter((i) => i.state === state && labels.every((l) => i.labels.includes(l)));
    },
    async createIssue({ title, body, labels = [] }) {
      const number = (next += 1);
      issues.set(number, { number, title, body, labels: [...labels], comments: [], state: "open", author: "factory-bot" });
      return number;
    },
    async issue(n) { const it = issues.get(n); if (!it) throw new Error(`404 #${n}`); return { ...it, labels: [...it.labels] }; },
    async comments(n) { return [...(issues.get(n)?.comments ?? [])]; },
    async comment(n, body) { issues.get(n)?.comments.push({ body }); return `https://x/${n}#issuecomment-1`; },
    async setFactoryLabel(n, to) { const it = issues.get(n); it.labels = [...it.labels.filter((l) => !STATES.has(l)), to]; },
    async searchIssues(label) { return [...issues.values()].filter((i) => i.state === "open" && i.labels.includes(label)).map((i) => ({ number: i.number, title: i.title })); },
  };
}

const NOT_QUEUED = (n) => `<!-- factory-harness-not-queued issue=${n} -->`;

test("test_130_harness_issue_born_in_backlog — created in backlog, queued once through the injected transition bound to the NEW issue; reuse never transitions", async () => {
  const repo = fakeRepo([{ number: 2, title: "feature", body: "## done_when\n- x", labels: ["factory:in-progress"] }]);
  const calls = [];
  const transition = vi.fn(async (args) => { calls.push({ args, labels: [...repo.labelsOf(args.issue)] }); await repo.setFactoryLabel(args.issue, args.to); return { ok: true, from: "backlog", to: args.to }; });
  const r = await ensureHarnessIssue({ gh: repo, issue: 2, entries: [PG], pr: 17, transition });
  const n = r.issue;
  expect(n).not.toBe(2);
  expect(r).toMatchObject({ issue: n, created: true, queued: true });
  // 태어날 때의 라벨은 정확히 backlog + harness — queue는 절대 아니다
  expect(calls).toHaveLength(1);
  expect(calls[0].labels).toEqual(["backlog", HARNESS_LABEL]);
  expect(transition).toHaveBeenCalledTimes(1);
  expect(transition.mock.calls[0][0]).toMatchObject({ issue: n, to: "factory:queue" });
  // 큐로 옮긴 것은 전이이고, 피처 이슈는 건드리지 않았다
  expect(repo.labelsOf(n)).toEqual([HARNESS_LABEL, "factory:queue"]);
  expect(repo.labelsOf(2)).toEqual(["factory:in-progress"]);
  expect(repo.commentsOf(n).join("\n")).not.toContain("factory-harness-not-queued");

  // 재사용: 표가 자라든 말든 전이를 다시 부르지 않고, not-queued 코멘트도 남기지 않는다. 반환 모양은 예전 그대로다.
  const again = vi.fn(async () => ({ ok: true }));
  const same = await ensureHarnessIssue({ gh: repo, issue: 2, entries: [PG], transition: again });
  expect(same).toEqual({ issue: n, created: false, appended: 0, title: harnessIssueTitle([PG], 2) });
  const grown = await ensureHarnessIssue({ gh: { ...repo, editIssueBody: async (m, body) => { repo.issues.get(m).body = body; } }, issue: 2, entries: [PG, COMPOSE], transition: again });
  expect(grown).toEqual({ issue: n, created: false, appended: 1, title: harnessIssueTitle([PG], 2) });
  expect(again).not.toHaveBeenCalled();
  expect(repo.commentsOf(n)).toEqual([]);
});

test("test_130_harness_issue_stays_backlog_when_refused — refused, thrown or missing transition leaves it in backlog with a marker comment, the reason, and a next step that fits", async () => {
  const setup = () => fakeRepo([{ number: 2, title: "feature", body: "## done_when\n- x", labels: ["factory:in-progress"] }]);

  // (a) 심사 거부 — `factory rehearse`는 해법이 아니다; `:next`도 같은 이유로 거부된다고 말한다
  const capReason = "queue admission refused — queue 8 ≥ 8 (back_pressure.queue_max)";
  let repo = setup();
  let r = await ensureHarnessIssue({ gh: repo, issue: 2, entries: [PG], transition: async () => ({ ok: false, to: "factory:queue", reason: capReason }) });
  expect(r).toMatchObject({ issue: r.issue, created: true, queued: false, queue_reason: capReason });
  expect(repo.labelsOf(r.issue)).toEqual(["backlog", HARNESS_LABEL]);
  let cs = repo.commentsOf(r.issue);
  expect(cs).toHaveLength(1);
  expect(cs[0]).toContain(NOT_QUEUED(r.issue));
  expect(cs[0]).toContain(capReason);
  expect(cs[0]).toContain("/know-thy-build:next");
  expect(cs[0]).toMatch(/refused the same way/);
  expect(cs[0]).not.toContain("factory rehearse");

  // (b) 리허설 거부(낡음) — 다음 걸음은 `factory rehearse` 그리고 `:next`
  const stale = "harness changed since the last rehearsal — run `factory rehearse` — recorded main abc, current def";
  repo = setup();
  r = await ensureHarnessIssue({ gh: repo, issue: 2, entries: [PG], transition: async () => ({ ok: false, to: "factory:queue", reason: stale }) });
  expect(r).toMatchObject({ created: true, queued: false, queue_reason: stale });
  expect(repo.labelsOf(r.issue)).toEqual(["backlog", HARNESS_LABEL]);
  cs = repo.commentsOf(r.issue);
  expect(cs).toHaveLength(1);
  expect(cs[0]).toContain(NOT_QUEUED(r.issue));
  expect(cs[0]).toContain(stale);
  const after = cs[0].slice(cs[0].indexOf(stale) + stale.length);
  expect(after).toMatch(/factory rehearse[\s\S]*\/know-thy-build:next/);

  // (c) 전이가 던진다 — 던지지 않고, 예외 메시지가 사유다
  repo = setup();
  r = await ensureHarnessIssue({ gh: repo, issue: 2, entries: [PG], transition: async () => { throw new Error("gh api 502 on label swap"); } });
  expect(r).toMatchObject({ created: true, queued: false });
  expect(r.queue_reason).toContain("gh api 502 on label swap");
  expect(repo.labelsOf(r.issue)).toEqual(["backlog", HARNESS_LABEL]);
  cs = repo.commentsOf(r.issue);
  expect(cs).toHaveLength(1);
  expect(cs[0]).toContain(NOT_QUEUED(r.issue));
  expect(cs[0]).toContain("gh api 502 on label swap");

  // (d) 전이가 없다 — 큐에 넣지 않고, 그 사실을 반환값과 코멘트에 적는다(기본값이 큐가 되는 일은 없다)
  repo = setup();
  r = await ensureHarnessIssue({ gh: repo, issue: 2, entries: [PG] });
  expect(r).toMatchObject({ created: true, queued: false });
  expect(r.queue_reason).toMatch(/no transition wiring supplied/);
  expect(repo.labelsOf(r.issue)).toEqual(["backlog", HARNESS_LABEL]);
  cs = repo.commentsOf(r.issue);
  expect(cs).toHaveLength(1);
  expect(cs[0]).toContain(NOT_QUEUED(r.issue));
  expect(cs[0]).toContain(r.queue_reason);

  // (e) 코멘트가 실패해도 던지지 않는다 — 기록의 실패가 이슈 생성의 실패는 아니다
  repo = setup();
  const noComment = { ...repo, comment: async () => { throw new Error("comment 403"); } };
  r = await ensureHarnessIssue({ gh: noComment, issue: 2, entries: [PG], transition: async () => ({ ok: false, reason: capReason }) });
  expect(r).toMatchObject({ created: true, queued: false, queue_reason: capReason });
  expect(repo.labelsOf(r.issue)).toEqual(["backlog", HARNESS_LABEL]);
});

test("test_130_harness_issue_refused_by_real_admission_stays_backlog — a harness issue for a self-generated feature is generation 2 and the real door refuses it", async () => {
  // #9는 사람의 이슈, #40은 그것을 구현하다 공장이 수확한 flaky 이슈(1세대). #40의 하네스 이슈는 2세대다.
  const repo = fakeRepo([
    { number: 9, title: "person", body: "## done_when\n- x", labels: ["factory:merged"], author: "LeeHyeonKyu" },
    { number: 40, title: "flaky: t", body: "Detected while implementing #9. evidence: {}", labels: ["factory:in-progress", "factory:flaky"], author: "factory-bot" },
  ]);
  const charter = { never_automate: [], back_pressure: { awaiting_review_max: 4, queue_max: 8 }, self_generated: { open_max: 5, depth_max: 1 } };
  const admission = makeQueueAdmission({ gh: repo, charter, factoryLogins: async () => ({ ok: true, logins: ["factory-bot"] }) });
  const rehearsal = async () => ({ ok: true });
  const transition = ({ issue: n, to, reason }) => realTransition({ gh: repo, issue: n, to, reason, stage: "implement", rehearsal, admission });

  const r = await ensureHarnessIssue({ gh: repo, issue: 40, entries: [PG], transition });
  expect(r).toMatchObject({ created: true, queued: false });
  expect(r.queue_reason).toMatch(/queue admission refused/);
  expect(r.queue_reason).toMatch(/generation 2 > 1 \(self_generated\.depth_max\)/);
  expect(repo.labelsOf(r.issue)).toEqual(["backlog", HARNESS_LABEL]);
  const cs = repo.commentsOf(r.issue);
  expect(cs).toHaveLength(1);
  expect(cs[0]).toContain(NOT_QUEUED(r.issue));
  expect(cs[0]).toContain(r.queue_reason);
  expect(cs[0]).not.toContain("factory rehearse");

  // 대조: 같은 문을 사람의 피처(#9 계열이 아닌 1세대)로 열면 통과한다 — 거부는 문의 판정이지 배선 결함이 아니다
  const repo2 = fakeRepo([{ number: 12, title: "person", body: "## done_when\n- x", labels: ["factory:in-progress"], author: "LeeHyeonKyu" }]);
  const admission2 = makeQueueAdmission({ gh: repo2, charter, factoryLogins: async () => ({ ok: true, logins: ["factory-bot"] }) });
  const t2 = ({ issue: n, to, reason }) => realTransition({ gh: repo2, issue: n, to, reason, stage: "implement", rehearsal, admission: admission2 });
  const ok = await ensureHarnessIssue({ gh: repo2, issue: 12, entries: [PG], transition: t2 });
  expect(ok).toMatchObject({ created: true, queued: true });
  expect(repo2.labelsOf(ok.issue)).toEqual([HARNESS_LABEL, "factory:queue"]);
});
