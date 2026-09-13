import { test, expect, vi } from "vitest";
import { harnessNeeded, harnessIssueTitle, harnessIssueBody, parseBlocks, parkedReason, ensureHarnessIssue, HARNESS_LABEL } from "../lib/harness-request.js";
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

test("the title is the dedupe key: stable, issue-scoped, one line, and it says how many entries there are", () => {
  expect(harnessIssueTitle([PG], 2)).toBe("harness: add dependency pg@^8 to dependencies — for #2");
  expect(harnessIssueTitle([PG, COMPOSE], 2)).toBe("harness: add dependency pg@^8 to dependencies (+1 more) — for #2");
  // 같은 요청은 같은 문자열을 낸다(dedupe가 성립하는 유일한 조건)
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

test("ensureHarnessIssue opens ONE issue, labelled queue + harness, and reuses an open one with the same title", async () => {
  const gh = { issueList: vi.fn(async () => []), createIssue: vi.fn(async () => 31) };
  const first = await ensureHarnessIssue({ gh, issue: 2, entries: [PG], pr: 17 });
  expect(first).toEqual({ issue: 31, created: true, title: harnessIssueTitle([PG], 2) });
  expect(gh.issueList).toHaveBeenCalledWith({ labels: [HARNESS_LABEL], state: "open" });
  expect(gh.createIssue).toHaveBeenCalledWith(expect.objectContaining({ labels: ["factory:queue", HARNESS_LABEL] }));
  // 두 번째 라운드가 같은 요청을 또 내놓아도 이슈는 하나다
  const gh2 = { issueList: async () => [{ number: 31, title: ` ${harnessIssueTitle([PG], 2)} ` }], createIssue: vi.fn() };
  expect(await ensureHarnessIssue({ gh: gh2, issue: 2, entries: [PG] })).toEqual({ issue: 31, created: false, title: harnessIssueTitle([PG], 2) });
  expect(gh2.createIssue).not.toHaveBeenCalled();
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
