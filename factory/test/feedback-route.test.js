import { test, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { ownerOf, buildManifest } from "../cli/manifest.js";
import { routeMergedIssues, routedMarker, NO_DETAIL_LINES_REASON, recordNotReadReason } from "../lib/feedback/route.js";
import { selfGateComment } from "./helpers/feedback-fixtures.js";

/**
 * #36 — 라우팅 팔이 **같은 머지를 두 번 나르지 않는다**(item 1의 후반부)와, **발견이 0건인 이유가
 * "깨끗해서"가 아니라 "읽을 줄이 없어서"일 때 그렇게 말한다**(item 4).
 *
 * 재료는 데모 #45의 실물이다(`factory/test/fixtures/demo-45-comments.json` — `refresh.mjs`가
 * `gh api`로 받아 적은 원문). 그 이슈는 사람이 PR #46을 머지했고 sweeper가 `factory:merged`로
 * 이었지만, 23개 코멘트 어디에도 라우팅 영수증이 없다 — retro가 `pull_request: closed`에서
 * `isMerged=false`를 봤기 때문이다.
 */
const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
const dests = new Set(buildManifest({ pkgRoot }).map((e) => e.dest));
const REPO = "LeeHyeonKyu/know-thy-build-demo";
const UPSTREAM = "LeeHyeonKyu/know_thy_build";
const harness = { test: { source_glob: ["src/**/*.js"], test_glob: ["test/**/*.test.js"] } };

const DEMO45 = JSON.parse(readFileSync(new URL("./fixtures/demo-45-comments.json", import.meta.url), "utf8"));
const ISSUE_45 = { number: 45, title: DEMO45.issue.title, labels: DEMO45.issue.labels.map((l) => l.name), state: "closed", closedAt: DEMO45.issue.closedAt };

/** 열린 이슈 목록이 곧 저장소인 gh 더블 — dedupe가 실제로 걸린다(retro-route 테스트와 같은 모양). */
function fakeGh() {
  const calls = { createIssue: [], comment: [], upstreamIssue: [] };
  const upstreamIssues = [];
  let seq = 600;
  return {
    calls, upstreamIssues,
    async issueList() { return []; },
    async createIssue({ title, body, labels = [] }) { calls.createIssue.push({ title, body, labels }); return (seq += 1); },
    async editIssueBody() {},
    async comment(n, body) { calls.comment.push({ issue: n, body }); return `https://x/#issuecomment-${(seq += 1)}`; },
    async upstreamIssue({ repo, fingerprint, render, append, match }) {
      calls.upstreamIssue.push({ repo, fingerprint });
      const found = upstreamIssues.find((i) => match(String(i.body ?? "")));
      if (found) { const next = append(String(found.body ?? "")); const appended = next !== found.body; found.body = next; return { issue: found.number, created: false, appended }; }
      const { title, body, labels } = render();
      const number = (seq += 1);
      upstreamIssues.push({ number, title, body, labels });
      return { issue: number, created: true, appended: false };
    },
  };
}

const route = (gh, comments, records, recordsSource = "records-branch") => routeMergedIssues({
  gh, repo: REPO, upstream: UPSTREAM, ownerOf, isInstalled: dests, ktbVersion: "1.4.0", harness,
  issues: [ISSUE_45], commentsByIssue: new Map([[45, comments]]), records, recordsSource,
  since: "2026-09-20T00:00:00Z", factoryLogins: ["LeeHyeonKyu"],
});

/**
 * 데모 #45의 실제 기록은 발견을 **0건** 낸다(`gates-detail:`의 `prove-test` RED는 리포트를 읽은
 * 정상 판정이다 — `gateFindings`가 의도적으로 떨어뜨린다). 멱등을 재려면 나를 것이 하나는 있어야
 * 하므로, 그 실물 타임라인 위에 **진짜 생산자**(`selfGateRetryComment`)가 만든 self-gate 차단
 * 하나를 얹는다 — 손으로 빚은 모양이 아니고, 나머지 23개 코멘트는 원문 그대로다.
 */
const ROUTABLE_45 = selfGateComment({
  issue: 45, head: "cf903191da4537a2d5bf3f6890daa88727f659d8", attempt: 1, at: "2026-09-21T01:10:00Z",
  findings: [{ check: "mutation", blocking: true, harness: true, ids: [], detail: "self-gate blocked: a harness change is needed (the check could not run on this harness)" }],
});

test("test_36_human_merged_routing: routing demo #45 twice opens no second upstream issue and writes no second comment (human-merged)", async () => {
  const gh = fakeGh();
  const records = new Map([["45", DEMO45.record]]);
  let comments = [...DEMO45.comments.map((c) => ({ ...c })), ROUTABLE_45];

  const first = await route(gh, comments, records);
  expect(first.issues).toEqual([45]);
  // 이 머지에는 나를 것이 있었다 — self-gate가 하네스 변경을 요구하며 handoff를 막았다.
  const opened = gh.upstreamIssues.length + gh.calls.createIssue.length;
  expect(first.actions.some((a) => /^(upstream-created|harness-issue|ktb-note|ambiguous-note)$/.test(a.kind))).toBe(true);
  expect(gh.calls.comment.some((c) => /<!--\s*factory-feedback/.test(c.body))).toBe(true);

  // 두 번째 회차는 첫 회차가 남긴 **영수증**을 본다 — 커서는 full 회차에만 전진하므로 정상적인 상황이다.
  comments = [...comments, ...gh.calls.comment.map((c, i) => ({ id: 8000 + i, createdAt: "2026-09-21T02:00:00Z", author: "ktb-bot", body: c.body }))];
  const commentsBefore = gh.calls.comment.length;
  const second = await route(gh, comments, records);
  expect(gh.upstreamIssues.length + gh.calls.createIssue.length).toBe(opened);
  expect(gh.calls.comment.length).toBe(commentsBefore);
  expect(second.actions.some((a) => a.kind === "routed-already")).toBe(true);
  // 영수증 마커가 곧 그 열쇠다.
  const fps = second.actions.filter((a) => a.fingerprint).map((a) => a.fingerprint);
  for (const fp of fps) expect(comments.some((c) => c.body.includes(routedMarker(fp)))).toBe(true);
});

test("test_36_record_and_annotation_wording: a merged issue whose record has no detail lines says so, instead of nothing (wording)", async () => {
  const gh = fakeGh();
  // 1.4 이전 기록의 모양: 섹션은 있지만 `gates-detail:`/`context-manifest:`/`self-gate-detail:`이 없다.
  const preV14 = "# Run · #45\n\n## implement · 2026-09-20T10:00Z · gha-1\nverify: ok\ntransition: factory:awaiting-review\n";
  const r = await route(gh, DEMO45.comments.filter((c) => !/factory-transition|human-decision/.test(c.body)), new Map([["45", preV14]]));
  expect(r.actions).toContainEqual({ kind: "no-detail-lines", step: "feedback-route", issue: 45, reason: NO_DETAIL_LINES_REASON });
  expect(NO_DETAIL_LINES_REASON).toMatch(/attribution is unavailable/);
  expect(NO_DETAIL_LINES_REASON).toMatch(/before 1\.4/);
  expect(gh.calls.comment).toEqual([]);                                 // 보고일 뿐 — 아무것도 쓰지 않는다
});

test("test_36_record_and_annotation_wording: a 1.4+ record with detail lines and no findings says nothing of the kind (wording)", async () => {
  const gh = fakeGh();
  const clean = "# Run · #45\n\n## implement · 2026-09-20T10:00Z · gha-1\ncontext-manifest: {\"role\":\"builder\",\"cold_read\":false,\"run_id\":\"1\",\"runner\":\"gha-1\",\"fields\":[]}\n";
  const r = await route(gh, [], new Map([["45", clean]]));
  expect(r.actions.some((a) => a.kind === "no-detail-lines")).toBe(false);
});

/**
 * ── r1 리뷰 must_fix 1 — **읽지 못한 기록을 "1.4 이전 기록"이라고 부르지 않는다** ─────────────────
 *
 * 리뷰어의 프로브 그대로다: 데모 #45의 **실물**(1.4.0 기록, detail 줄 13개)을 가진 이슈를
 * `records: new Map()`으로 — `bin/sweep.js`의 하이드레이트가 실패했을 때 라우팅 팔이 실제로 받는
 * 바로 그 값으로 — 나른다. 고치기 전에는 `hasDetailLines("")`가 거짓이라 `no-detail-lines`가 나갔다.
 * 두 경우를 **같은 픽스처로** 함께 고정한다: 읽었을 때와 읽지 못했을 때 문장이 갈려야 한다.
 */
test("test_36_record_and_annotation_wording: an UNREAD record is reported as unread, not as a pre-1.4 record (wording)", async () => {
  // 이 기록에는 detail 줄이 실제로 있다 — 그러니 "줄이 없다"는 어느 쪽이든 거짓이다.
  expect((DEMO45.record.match(/^(gates-detail:|context-manifest:|self-gate-detail:)/gm) || []).length).toBeGreaterThan(0);
  const quiet = DEMO45.comments.filter((c) => !/factory-transition|human-decision/.test(c.body));

  // ① 하이드레이트 실패 — 손에 든 기록이 없다. 사람이 볼 것은 브랜치·토큰이지 기록의 나이가 아니다.
  const unread = await route(fakeGh(), quiet, new Map(), "records-branch-unreadable");
  expect(unread.actions).toContainEqual({
    kind: "record-not-read", step: "feedback-route", issue: 45,
    reason: recordNotReadReason("records-branch-unreadable"),
  });
  expect(recordNotReadReason("records-branch-unreadable")).toBe("record not read — records-branch-unreadable");
  expect(unread.actions.some((a) => a.kind === "no-detail-lines")).toBe(false);

  // ② 같은 이슈, 같은 코멘트 — 이번엔 기록을 읽었다. 1.4.0 기록이므로 어느 문장도 나가지 않는다.
  const read = await route(fakeGh(), quiet, new Map([["45", DEMO45.record]]), "records-branch");
  expect(read.actions.some((a) => a.kind === "record-not-read")).toBe(false);
  expect(read.actions.some((a) => a.kind === "no-detail-lines")).toBe(false);
});

/** 배선하지 않은 호출자도 **거짓말은 하지 않는다** — 출처를 모르면 모른다고 적는다. */
test("test_36_record_and_annotation_wording: an unwired caller still says 'not read', with the source unknown (wording)", async () => {
  const r = await routeMergedIssues({
    gh: fakeGh(), repo: REPO, upstream: UPSTREAM, ownerOf, isInstalled: dests, ktbVersion: "1.4.0", harness,
    issues: [ISSUE_45], commentsByIssue: new Map([[45, []]]), records: new Map(), since: "2026-09-20T00:00:00Z",
    factoryLogins: ["LeeHyeonKyu"],
  });
  expect(r.actions).toContainEqual({ kind: "record-not-read", step: "feedback-route", issue: 45, reason: "record not read — unknown" });
});
