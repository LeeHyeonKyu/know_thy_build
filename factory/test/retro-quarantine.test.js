import { test, expect } from "vitest";
import { registerFromFlakyIssues, rewriteIssuesForExpired, deletionCandidates } from "../lib/retro/quarantine-ops.js";

const needsHumanTransition = (n, reason, at) =>
  ({ id: `t-${n}-${at}`, createdAt: at, body: `<!-- factory-transition:v1 from=factory:in-progress to=factory:needs-human by=script -->\nfactory:in-progress → factory:needs-human — ${reason}` });

const needsHumanRefused = (n, at) =>
  ({ id: `r-${n}-${at}`, createdAt: at, body: `<!-- factory-transition-refused from=factory:rework to=factory:needs-human -->\n**전이 거부** factory:rework → factory:needs-human: rework 응답 누락\n\n라벨을 \`factory:needs-human\`으로 옮겼습니다. 산출물을 보강한 뒤 \`:unstick\`으로 재개하세요.` });

const flakyIssue = (number, { title, labels, state = "open" }) => ({ number, title, labels, state });

test("registers an open flaky+needs-human issue that reached needs-human >= K times, using the latest transition reason", () => {
  const issues = [flakyIssue(50, { title: "flaky: test_sync_timing", labels: ["factory:flaky", "factory:needs-human"] })];
  const commentsByIssue = new Map([[50, [
    needsHumanTransition(50, "1차 실패", "2026-09-01T00:00:00Z"),
    needsHumanTransition(50, "2차 실패", "2026-09-05T00:00:00Z"),
    needsHumanTransition(50, "3차 실패 — 원인 미상", "2026-09-09T00:00:00Z"),
  ]]]);
  const { q, registered } = registerFromFlakyIssues({ issues, commentsByIssue, quarantine: { quarantined: [] }, now: "2026-09-12T00:00:00Z", K: 3 });
  expect(registered).toEqual([{ id: "test_sync_timing", issue: 50 }]);
  expect(q.quarantined).toEqual([{ id: "test_sync_timing", since: "2026-09-12T00:00:00Z", reason: "3차 실패 — 원인 미상", evidence: ["#50"], consecutive_passes: 0 }]);
});

test("fewer than K needs-human events → not registered", () => {
  const issues = [flakyIssue(51, { title: "flaky: test_a", labels: ["factory:flaky", "factory:needs-human"] })];
  const commentsByIssue = new Map([[51, [needsHumanTransition(51, "1차", "2026-09-01T00:00:00Z")]]]);
  const { registered } = registerFromFlakyIssues({ issues, commentsByIssue, quarantine: { quarantined: [] }, now: "2026-09-12T00:00:00Z", K: 3 });
  expect(registered).toEqual([]);
});

test("already quarantined id is not registered again; missing flaky or needs-human label is skipped; closed issues are skipped", () => {
  const events3 = [needsHumanTransition(1, "a", "2026-09-01"), needsHumanTransition(1, "b", "2026-09-02"), needsHumanTransition(1, "c", "2026-09-03")];
  const issues = [
    flakyIssue(60, { title: "flaky: already", labels: ["factory:flaky", "factory:needs-human"] }),
    flakyIssue(61, { title: "flaky: no_needs_human", labels: ["factory:flaky"] }),
    flakyIssue(62, { title: "flaky: no_flaky_label", labels: ["factory:needs-human"] }),
    flakyIssue(63, { title: "flaky: closed_one", labels: ["factory:flaky", "factory:needs-human"], state: "closed" }),
  ];
  const commentsByIssue = new Map([[60, events3], [61, events3], [62, events3], [63, events3]]);
  const quarantine = { quarantined: [{ id: "already", since: "2026-01-01", reason: "r", evidence: [], consecutive_passes: 0 }] };
  const { registered } = registerFromFlakyIssues({ issues, commentsByIssue, quarantine, now: "2026-09-12", K: 3 });
  expect(registered).toEqual([]);
});

test("reason falls back to 'self-fix exhausted' when no transition reason text is available (refused-with-move case)", () => {
  const issues = [flakyIssue(70, { title: "flaky: test_x", labels: ["factory:flaky", "factory:needs-human"] })];
  const commentsByIssue = new Map([[70, [needsHumanRefused(70, "2026-09-01"), needsHumanRefused(70, "2026-09-05"), needsHumanRefused(70, "2026-09-09")]]]);
  const { q } = registerFromFlakyIssues({ issues, commentsByIssue, quarantine: { quarantined: [] }, now: "2026-09-12", K: 3 });
  expect(q.quarantined[0].reason).toBe("rework 응답 누락");
});

test("the title prefix 'rewrite flaky test at another level:' also parses as the flaky id", () => {
  const events3 = [needsHumanTransition(1, "a", "1"), needsHumanTransition(1, "b", "2"), needsHumanTransition(1, "c", "3")];
  const issues = [flakyIssue(80, { title: "rewrite flaky test at another level: test_y", labels: ["factory:flaky", "factory:needs-human"] })];
  const { registered } = registerFromFlakyIssues({ issues, commentsByIssue: new Map([[80, events3]]), quarantine: { quarantined: [] }, now: "n", K: 3 });
  expect(registered).toEqual([{ id: "test_y", issue: 80 }]);
});

test("rewriteIssuesForExpired creates a dedup'd rewrite issue per expired id, skipping ids that already have an open issue", () => {
  const openIssues = [{ title: "rewrite flaky test at another level: test_dup" }];
  const out = rewriteIssuesForExpired({ expired: ["test_new", "test_dup"], openIssues });
  expect(out).toHaveLength(1);
  expect(out[0].title).toBe("rewrite flaky test at another level: test_new");
  expect(out[0].labels).toEqual(["backlog", "factory:flaky"]);
  expect(out[0].body).toContain("test_new");
});

test("deletionCandidates: only open rewrite issues that reached needs-human >= K times qualify", () => {
  const events3 = [needsHumanTransition(1, "a", "1"), needsHumanTransition(1, "b", "2"), needsHumanTransition(1, "c", "3")];
  const events1 = [needsHumanTransition(1, "a", "1")];
  const issues = [
    { number: 90, title: "rewrite flaky test at another level: test_z", labels: ["factory:needs-human"], state: "open" },
    { number: 91, title: "rewrite flaky test at another level: test_w", labels: ["factory:needs-human"], state: "open" },
    { number: 92, title: "some unrelated issue", labels: ["factory:needs-human"], state: "open" },
    { number: 93, title: "rewrite flaky test at another level: test_closed", labels: ["factory:needs-human"], state: "closed" },
  ];
  const commentsByIssue = new Map([[90, events3], [91, events1], [92, events3], [93, events3]]);
  const out = deletionCandidates({ issues, commentsByIssue, K: 3 });
  expect(out).toEqual([{ id: "test_z", issue: 90 }]);
});
