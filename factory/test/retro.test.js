import { test, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { runRetro } from "../bin/retro.js";
import { routeMergedIssues } from "../lib/feedback/route.js";
import { ownerOf, buildManifest } from "../cli/manifest.js";

/**
 * #36 — retro의 **라우팅 팔이 내는 소리** 두 가지.
 *
 * (item 1) 창 안에 머지된 이슈가 하나도 없으면 이 팔은 예전에 run 기록에 **한 글자도** 남기지
 * 않았다. 그 침묵은 "라우팅할 것이 없었다"와 "라우팅이 죽었다"를 구별하지 못한다 — 1.4.0 도그푸드가
 * 그것을 정확히 그 모양으로 겪었다(사람이 머지한 #45가 `isMerged=false`로 보여 창이 비었는데,
 * 기록에는 아무 줄도 없어 아무도 알아차리지 못했다).
 *
 * (item 5) 라우팅 실패 하나가 `::error::` 두 줄이 됐다 — 실패 한 줄과 **운영 안내** 한 줄이 같은
 * `reasons` 배열에 들어갔기 때문이다. 안내는 실패가 아니다.
 */
const NOW = "2026-09-21T02:00:00Z";
const STATE = () => ({
  cursor: { last_retro_at: "2026-09-20T00:00:00Z", last_record_offsets: {} },
  merges_since: 0, n: 5, history: [], candidates: { lessons: [], examples: [], flaky: [], needs_human: [] }, stats: {},
});

/** light 회차만 도는 최소 배선 — `claude -p`까지 가지 않는다(판정은 `shouldRunFull`이 light다). */
function lightDeps({ routeFeedback, harvest } = {}) {
  const recorded = [];
  const deps = {
    now: NOW,
    record: (line) => recorded.push(line),
    ciSettingsPresent: async () => true,
    hydrate: vi.fn(async () => ({ records: new Map(), fetched: true, exists: true, stateBlob: "b1", stateFailed: false })),
    readState: vi.fn(async () => STATE()),
    writeState: vi.fn(async () => {}),
    sync: vi.fn(async () => ({ ok: true })),
    harvest: harvest ?? vi.fn(async () => ({ candidates: { lessons: [], examples: [], flaky: [], needs_human: [] }, stats: { merged: 0 }, issues: [], flakyIssues: [], harnessTitles: [], commentsByIssue: new Map(), first: null })),
    shouldRunFull: vi.fn(async () => ({ full: false, reason: "light" })),
    routeFeedback,
    lightOnMerge: true,
    nBounds: { min: 1, max: 20 },
  };
  return { deps, recorded };
}

/**
 * 데모 #45의 **실제 타임라인**을 `pull_request: closed`가 도착한 그 순간으로 되감는다: 사람이 PR #46을
 * 머지했고, sweeper는 아직 `factory:merged` 전이를 쓰지 않았다. 그 상태에서 회고가 보는 이슈는
 * `isMerged=false`이므로 라우팅 창은 **빈다** — 1.4.0 도그푸드에서 이 이슈의 증거가 통째로 누락된
 * 바로 그 상태이고, 그때 run 기록에는 그 사실을 말하는 줄이 한 줄도 없었다(#35).
 */
const DEMO45 = JSON.parse(readFileSync(new URL("./fixtures/demo-45-comments.json", import.meta.url), "utf8"));
const BEFORE_SWEEPER_45 = DEMO45.comments.slice(0, DEMO45.comments.findIndex((c) => c.body.includes("<!-- factory-transition:v1 from=factory:needs-human to=factory:merged")));
const dests = new Set(buildManifest({ pkgRoot: fileURLToPath(new URL("../..", import.meta.url)) }).map((e) => e.dest));

test("test_36_human_merged_routing: a retro window with no merged issue records one explicit zero line (human-merged)", async () => {
  // 라우팅 엔진은 **진짜 것**이다 — 창이 비는 이유도 실제 판정(`isMerged`)이 낸다.
  const routeFeedback = vi.fn(async ({ issues, commentsByIssue, records, since }) => routeMergedIssues({
    gh: { async comment() { throw new Error("nothing should be written"); } },
    repo: "LeeHyeonKyu/know-thy-build-demo", upstream: null,
    ownerOf, isInstalled: dests, ktbVersion: "1.4.0", harness: {},
    issues, commentsByIssue, records, since, factoryLogins: ["LeeHyeonKyu"],
  }));
  const harvest = vi.fn(async () => ({
    candidates: { lessons: [], examples: [], flaky: [], needs_human: [] }, stats: { merged: 0 },
    // 사람이 머지한 직후의 #45: 라벨은 아직 `factory:needs-human`이고 전이도 아직 안 왔다.
    issues: [{ number: 45, title: DEMO45.issue.title, state: "closed", closedAt: DEMO45.issue.closedAt, labels: ["factory:needs-human"] }],
    flakyIssues: [], harnessTitles: [], commentsByIssue: new Map([[45, BEFORE_SWEEPER_45]]), first: null,
  }));
  const { deps, recorded } = lightDeps({ routeFeedback, harvest });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(routeFeedback).toHaveBeenCalledTimes(1);
  expect(recorded).toContain("feedback-route: 0 merged issues in window");
});

test("test_36_human_merged_routing: a window that DID route says what it routed, not the zero line (human-merged)", async () => {
  const routeFeedback = vi.fn(async () => ({ issues: [45], actions: [{ kind: "upstream-created", step: "feedback-route", issue: 45, repo: "LeeHyeonKyu/know_thy_build", upstream_issue: 61 }] }));
  const { deps, recorded } = lightDeps({ routeFeedback });
  expect(await runRetro({ deps, now: NOW })).toBe(0);
  expect(recorded.some((l) => l.includes("0 merged issues in window"))).toBe(false);
  expect(recorded).toContain("feedback-route: upstream-created #45 → LeeHyeonKyu/know_thy_build#61");
});

test("test_36_record_and_annotation_wording: one routing failure is one ::error:: line and the operator guidance is not a failure (wording)", async () => {
  const out = [];
  const spy = vi.spyOn(console, "log").mockImplementation((l) => out.push(String(l)));
  try {
    const routeFeedback = vi.fn(async () => ({
      issues: [45],
      actions: [{ kind: "error", step: "feedback-route", issue: 45, reason: "upstream route failed — HTTP 403 Resource not accessible by integration" }],
    }));
    const { deps } = lightDeps({ routeFeedback });
    await runRetro({ deps, now: NOW });
  } finally { spy.mockRestore(); }
  // 예전에는 실패 하나가 `::error::` **둘**이었다(안내가 `reasons`에 섞여 있었다).
  const errors = out.filter((l) => l.startsWith("::error"));
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("HTTP 403");
  expect(errors[0]).toContain("factory doctor");          // 다음에 할 일은 같은 줄에 있다
  expect(errors[0]).not.toMatch(/\r?\n/);
});
