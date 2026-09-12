import { test, expect } from "vitest";
import {
  QUARANTINE_KINDS, deletionCandidates, expiredFromComments, quarantineComment,
  quarantineEvents, registerFromFlakyIssues, rewriteIssuesForExpired,
} from "../lib/retro/quarantine-ops.js";

const needsHumanTransition = (n, reason, at) =>
  ({ id: `t-${n}-${at}`, createdAt: at, body: `<!-- factory-transition:v1 from=factory:in-progress to=factory:needs-human by=script -->\nfactory:in-progress → factory:needs-human — ${reason}` });

const needsHumanRefused = (n, at) =>
  ({ id: `r-${n}-${at}`, createdAt: at, body: `<!-- factory-transition-refused from=factory:rework to=factory:needs-human -->\n**전이 거부** factory:rework → factory:needs-human: rework 응답 누락\n\n라벨을 \`factory:needs-human\`으로 옮겼습니다. 산출물을 보강한 뒤 \`:unstick\`으로 재개하세요.` });

const flakyIssue = (number, { title, labels, state = "open" }) => ({ number, title, labels, state });

test("registers an open issue as soon as it carries both factory:flaky and factory:needs-human labels — arrival at needs-human already means K self-fix rounds failed, no transition counting", () => {
  const issues = [flakyIssue(50, { title: "flaky: test_sync_timing", labels: ["factory:flaky", "factory:needs-human"] })];
  // exactly ONE needs-human transition — the old (wrong) behaviour required >=K before registering.
  const commentsByIssue = new Map([[50, [needsHumanTransition(50, "1차 실패 — 원인 미상", "2026-09-09T00:00:00Z")]]]);
  const { q, registered } = registerFromFlakyIssues({ issues, commentsByIssue, quarantine: { quarantined: [] }, now: "2026-09-12T00:00:00Z" });
  expect(registered).toEqual([{ id: "test_sync_timing", issue: 50 }]);
  expect(q.quarantined).toEqual([{ id: "test_sync_timing", since: "2026-09-12T00:00:00Z", reason: "1차 실패 — 원인 미상", evidence: ["#50"], consecutive_passes: 0 }]);
});

test("K has no effect on the gate — a large K still registers on a single needs-human arrival", () => {
  const issues = [flakyIssue(51, { title: "flaky: test_a", labels: ["factory:flaky", "factory:needs-human"] })];
  const commentsByIssue = new Map([[51, [needsHumanTransition(51, "1차", "2026-09-01T00:00:00Z")]]]);
  const { registered } = registerFromFlakyIssues({ issues, commentsByIssue, quarantine: { quarantined: [] }, now: "2026-09-12T00:00:00Z", K: 1000 });
  expect(registered).toEqual([{ id: "test_a", issue: 51 }]);
});

test("registers even with zero needs-human transition comments (reason falls back)", () => {
  const issues = [flakyIssue(52, { title: "flaky: test_no_comments", labels: ["factory:flaky", "factory:needs-human"] })];
  const { q, registered } = registerFromFlakyIssues({ issues, commentsByIssue: new Map(), quarantine: { quarantined: [] }, now: "2026-09-12" });
  expect(registered).toEqual([{ id: "test_no_comments", issue: 52 }]);
  expect(q.quarantined[0].reason).toBe("self-fix exhausted");
});

test("already quarantined id is not registered again; missing flaky or needs-human label is skipped; closed issues are skipped", () => {
  const issues = [
    flakyIssue(60, { title: "flaky: already", labels: ["factory:flaky", "factory:needs-human"] }),
    flakyIssue(61, { title: "flaky: no_needs_human", labels: ["factory:flaky"] }),
    flakyIssue(62, { title: "flaky: no_flaky_label", labels: ["factory:needs-human"] }),
    flakyIssue(63, { title: "flaky: closed_one", labels: ["factory:flaky", "factory:needs-human"], state: "closed" }),
  ];
  const quarantine = { quarantined: [{ id: "already", since: "2026-01-01", reason: "r", evidence: [], consecutive_passes: 0 }] };
  const { registered } = registerFromFlakyIssues({ issues, commentsByIssue: new Map(), quarantine, now: "2026-09-12" });
  expect(registered).toEqual([]);
});

test("reason falls back to 'self-fix exhausted' when no transition reason text is available (refused-with-move case)", () => {
  const issues = [flakyIssue(70, { title: "flaky: test_x", labels: ["factory:flaky", "factory:needs-human"] })];
  const commentsByIssue = new Map([[70, [needsHumanRefused(70, "2026-09-09")]]]);
  const { q } = registerFromFlakyIssues({ issues, commentsByIssue, quarantine: { quarantined: [] }, now: "2026-09-12" });
  expect(q.quarantined[0].reason).toBe("rework 응답 누락");
});

test("the title prefix 'rewrite flaky test at another level:' also parses as the flaky id", () => {
  const issues = [flakyIssue(80, { title: "rewrite flaky test at another level: test_y", labels: ["factory:flaky", "factory:needs-human"] })];
  const { registered } = registerFromFlakyIssues({ issues, commentsByIssue: new Map(), quarantine: { quarantined: [] }, now: "n" });
  expect(registered).toEqual([{ id: "test_y", issue: 80 }]);
});

test("uses the latest needs-human transition's reason when several are present", () => {
  const issues = [flakyIssue(81, { title: "flaky: test_multi", labels: ["factory:flaky", "factory:needs-human"] })];
  const commentsByIssue = new Map([[81, [
    needsHumanTransition(81, "1차 실패", "2026-09-01T00:00:00Z"),
    needsHumanTransition(81, "2차 실패", "2026-09-05T00:00:00Z"),
    needsHumanTransition(81, "3차 실패 — 원인 미상", "2026-09-09T00:00:00Z"),
  ]]]);
  const { q } = registerFromFlakyIssues({ issues, commentsByIssue, quarantine: { quarantined: [] }, now: "2026-09-12T00:00:00Z" });
  expect(q.quarantined[0].reason).toBe("3차 실패 — 원인 미상");
});

test("rewriteIssuesForExpired creates a dedup'd rewrite issue per expired id, skipping ids that already have an open issue, and dedupes within the same batch", () => {
  const openIssues = [{ title: "rewrite flaky test at another level: test_dup" }];
  const out = rewriteIssuesForExpired({ expired: ["test_new", "test_dup", "test_new"], openIssues });
  expect(out).toHaveLength(1);
  expect(out[0].title).toBe("rewrite flaky test at another level: test_new");
  expect(out[0].labels).toEqual(["backlog", "factory:flaky"]);
  expect(out[0].body).toContain("test_new");
});

test("deletionCandidates: open rewrite issues currently labeled factory:needs-human qualify — no transition counting", () => {
  const issues = [
    { number: 90, title: "rewrite flaky test at another level: test_z", labels: ["factory:needs-human"], state: "open" },
    { number: 91, title: "rewrite flaky test at another level: test_w", labels: [], state: "open" },
    { number: 92, title: "some unrelated issue", labels: ["factory:needs-human"], state: "open" },
    { number: 93, title: "rewrite flaky test at another level: test_closed", labels: ["factory:needs-human"], state: "closed" },
  ];
  const out = deletionCandidates({ issues, commentsByIssue: new Map() });
  expect(out).toEqual([{ id: "test_z", issue: 90 }]);
});

test("deletionCandidates: K has no effect on the gate", () => {
  const issues = [{ number: 94, title: "rewrite flaky test at another level: test_k", labels: ["factory:needs-human"], state: "open" }];
  const out = deletionCandidates({ issues, commentsByIssue: new Map(), K: 9999 });
  expect(out).toEqual([{ id: "test_k", issue: 94 }]);
});

// ── 격리 사건 코멘트(sweeper가 쓰고 retro가 읽는다) ──────────────────────

test("quarantineComment is the one marker syntax sweeper writes and retro reads", () => {
  expect(quarantineComment("registered", "test/a.js > x")).toBe("<!-- factory-quarantine registered id=test/a.js > x -->");
  expect(QUARANTINE_KINDS).toEqual(["registered", "returned", "expired"]);
});

test("quarantineEvents reads registered/returned/expired markers in order and honours the since window", () => {
  const issues = [{ number: 70 }, { number: 71 }];
  const commentsByIssue = new Map([
    [70, [
      { id: 1, createdAt: "2026-09-01T00:00:00Z", body: `${quarantineComment("registered", "t1")}\n등록` },
      { id: 2, createdAt: "2026-09-10T00:00:00Z", body: `${quarantineComment("expired", "t1")}\nTTL` },
      { id: 3, createdAt: "2026-09-10T01:00:00Z", body: "그냥 사람 코멘트" },
    ]],
    [71, [{ id: 4, createdAt: "2026-09-11T00:00:00Z", body: `${quarantineComment("returned", "t2")}\n복귀` }]],
  ]);
  expect(quarantineEvents({ issues, commentsByIssue })).toEqual([
    { kind: "registered", id: "t1", issue: 70, at: "2026-09-01T00:00:00Z" },
    { kind: "expired", id: "t1", issue: 70, at: "2026-09-10T00:00:00Z" },
    { kind: "returned", id: "t2", issue: 71, at: "2026-09-11T00:00:00Z" },
  ]);
  // 지난 retro가 이미 처리한 창은 다시 보지 않는다(delta, §8.4)
  expect(quarantineEvents({ issues, commentsByIssue, since: "2026-09-05T00:00:00Z" }).map((e) => e.kind)).toEqual(["expired", "returned"]);
});

test("expiredFromComments returns only expired ids, deduped, in order — the input rewriteIssuesForExpired wants", () => {
  const issues = [{ number: 80 }];
  const commentsByIssue = new Map([[80, [
    { id: 1, createdAt: "2026-09-10T00:00:00Z", body: quarantineComment("expired", "t_a") },
    { id: 2, createdAt: "2026-09-10T01:00:00Z", body: quarantineComment("returned", "t_b") },
    { id: 3, createdAt: "2026-09-10T02:00:00Z", body: quarantineComment("expired", "t_a") },
    { id: 4, createdAt: "2026-09-10T03:00:00Z", body: quarantineComment("expired", "t_c") },
  ]]]);
  expect(expiredFromComments({ issues, commentsByIssue })).toEqual(["t_a", "t_c"]);
  expect(expiredFromComments({ issues: [], commentsByIssue })).toEqual([]);
});
