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
  expect(first).toEqual({ issue: 31, created: true, title: harnessIssueTitle([PG], 2) });
  expect(gh.issueList).toHaveBeenCalledWith({ labels: [HARNESS_LABEL], state: "open" });
  expect(gh.createIssue).toHaveBeenCalledWith(expect.objectContaining({ labels: ["factory:queue", HARNESS_LABEL] }));
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
