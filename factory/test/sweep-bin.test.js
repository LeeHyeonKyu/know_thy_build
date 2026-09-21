import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * ── #36 r1 리뷰 cf2 — **운영자가 실제로 실행하는 배선을 고정한다** ──────────────────────────────
 *
 * `sweeper.test.js`의 dw1 테스트들은 `routeMerged`를 `vi.fn()`으로 받아 `sweep()`에 바로 꽂는다.
 * 그래서 그 파일이 고정하는 것은 `lib/sweeper.js`의 **소비 측**뿐이다: `bin/sweep.js`가 그 인자를
 * 만들어 넘기는 조립(레코드 하이드레이트 → `routeFeedbackArm`)은 한 줄도 실행되지 않았고, 인자가
 * 리팩터로 떨어져도 dw1은 전부 초록이었다 — 그리고 `node .factory/bin/sweep.js`를 부르는 사람은
 * 아무 일도 일어나지 않는 것을 보게 된다.
 *
 * 그래서 이 파일은 협력자만 모킹하고 **`main()`을 그대로 실행한다**. 단언은 mock의 반환값이 아니라
 * `routeFeedbackArm`이 실제로 받은 인자다 — `issues`의 모양(닫힘 + `factory:merged`), 손에 들고 있던
 * 그 이슈의 **실물 코멘트**, run 기록에서 하이드레이트한 `records`, 커서를 다시 자르지 않는 `since: null`.
 */

const DEMO45 = JSON.parse(readFileSync(new URL("./fixtures/demo-45-comments.json", import.meta.url), "utf8"));

const run = vi.fn(async (cmd, args) => {
  if (cmd === "git" && args?.[0] === "rev-parse") return { stdout: "/repo/root\n", stderr: "", code: 0 };
  return { stdout: "", stderr: "", code: 0 };
});
vi.mock("../lib/exec.js", () => ({ run: (...a) => run(...a) }));

const gh = {
  getVariable: vi.fn(async () => null),
  dispatchWorkflow: vi.fn(async () => {}),
  issueState: vi.fn(async () => ({ state: "OPEN" })),
  mergedPrForBranch: vi.fn(async () => null),
};
vi.mock("../lib/gh.js", () => ({
  makeGh: vi.fn(() => gh),
  resolveFactoryLogins: vi.fn(async () => ["factory-bot"]),
}));

const HARNESS = { gates: { thresholds: { t: 1 } }, project: { default_branch: "main" }, factory: { required_checks: ["factory/gates"] } };
vi.mock("../lib/config.js", () => ({
  loadCharter: vi.fn(() => ({ charter: true })),
  loadHarness: vi.fn(() => HARNESS),
  loadRoles: vi.fn(() => ({ roles: true })),
}));
vi.mock("../lib/review-roster.js", () => ({
  resolveReviewRoster: vi.fn(() => ({ roster: [] })),
  tierFromReviewHandoff: vi.fn(() => "standard"),
}));
vi.mock("../lib/quarantine.js", () => ({ loadQuarantine: vi.fn(() => ({ quarantined: [] })), saveQuarantine: vi.fn() }));
vi.mock("../lib/transition.js", () => ({ transition: vi.fn(async () => ({ ok: true })) }));
vi.mock("../lib/rehearsal.js", () => ({ makeRehearsalChecker: vi.fn(() => ({ check: async () => ({ ok: true }) })) }));
vi.mock("../lib/claim.js", () => ({ release: vi.fn(async () => {}), releaseIfStale: vi.fn(async () => {}) }));
vi.mock("../lib/back-pressure.js", () => ({ backPressure: vi.fn(async () => ({ ok: true })) }));

const sweep = vi.fn(async () => []);
vi.mock("../lib/sweeper.js", () => ({ sweep: (...a) => sweep(...a) }));

const routeFeedbackArm = vi.fn(async () => ({ issues: [45], actions: [{ kind: "upstream-created", step: "feedback-route", issue: 45, upstream_issue: 61 }] }));
vi.mock("../bin/retro.js", () => ({ routeFeedbackArm: (...a) => routeFeedbackArm(...a) }));

/**
 * r1 리뷰 nit 4 — **모킹해도 모양은 실물이다.** 1차 구현은 `Map([[45, { text, lines }]])`를 돌려줬는데
 * 진짜 생산자(`lib/records-branch.js`의 `readRecordsDetailed`)는 `Map<string, string>`을 돌려준다 —
 * 키는 파일명에서 온 **문자열**이고 값은 기록 **본문**이다. 그 차이가 그대로 결함을 가렸다: 라우팅이
 * `recs.get("45")`로 찾는 동안 테스트는 숫자 키로 초록이었다. 이제 키·값 모두 실제 타입이고, 본문은
 * 데모 #45의 실제 run 기록이다(`refresh.mjs`가 `gh api`로 받아 적은 원문).
 */
const detailed = (records, extra = {}) => ({ records, blobs: new Map(), failures: [], parent: "deadbeef", fetched: true, exists: true, ...extra });
const REAL_RECORDS = () => new Map([["45", DEMO45.record]]);
const readRecordsDetailed = vi.fn(async () => detailed(REAL_RECORDS()));
// `recordsSourceOf`는 **진짜**를 쓴다 — 출처 낱말은 이 조립이 실제로 계산해 넘기는 값이다(must_fix 1).
vi.mock("../lib/records-branch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  readRecordsDetailed: (...a) => readRecordsDetailed(...a),
}));

/** `main()`은 마지막에 `process.exit(0)`을 부른다 — 러너를 죽이지 않게 잡아 둔다. */
let exitSpy, logSpy, warnSpy;
beforeEach(() => {
  vi.clearAllMocks();
  run.mockImplementation(async (cmd, args) => (cmd === "git" && args?.[0] === "rev-parse"
    ? { stdout: "/repo/root\n", stderr: "", code: 0 } : { stdout: "", stderr: "", code: 0 }));
  sweep.mockResolvedValue([]);
  readRecordsDetailed.mockResolvedValue(detailed(REAL_RECORDS()));
  routeFeedbackArm.mockResolvedValue({ issues: [45], actions: [{ kind: "upstream-created", step: "feedback-route", issue: 45, upstream_issue: 61 }] });
  process.env.FACTORY_REPO = "acme/demo";
  exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  exitSpy.mockRestore(); logSpy.mockRestore(); warnSpy.mockRestore();
  delete process.env.FACTORY_REPO;
});

/** `main()`을 한 번 돌리고 `sweep()`이 실제로 받은 인자 뭉치를 돌려준다. */
async function runMain(argv = []) {
  const saved = process.argv;
  // argv[0]/argv[1]은 러너의 것을 그대로 둔다 — `bin/sweep.js`의 `isMain`이 argv[1]을 realpath하고,
  // 바꿔치면 존재하지 않는 경로로 던지거나(ENOENT) 모듈이 스스로 `main()`을 돈다. 플래그만 얹는다.
  process.argv = [saved[0], saved[1], ...argv];
  try {
    const { main } = await import("../bin/sweep.js");
    await main();
  } finally { process.argv = saved; }
  expect(sweep).toHaveBeenCalledTimes(1);
  return sweep.mock.calls[0][0];
}

test("test_36_human_merged_routing: bin/sweep.js hands the sweeper a routeMerged — the production seam dw1 relies on (human-merged)", async () => {
  const args = await runMain();
  // 인자 하나가 리팩터로 떨어지면 여기서 빨개진다. `lib/sweeper.js`만 보는 dw1 테스트들은 그때도 전부 초록이다.
  expect(typeof args.routeMerged).toBe("function");
});

test("test_36_human_merged_routing: the assembled routeMerged routes the issue's own comments with the run record hydrated (human-merged)", async () => {
  const args = await runMain();
  const comments = DEMO45.comments;
  const out = await args.routeMerged({ issue: 45, pr: 46, comments, mergedAt: "2026-09-21T01:52:01Z" });

  // ① 기록 하이드레이트는 이 저장소의 run/cwd로 일어난다 — `gates-detail:` 줄은 run 기록에만 살아서,
  //    코멘트만으로 나르면 게이트 원인이 통째로 빠진 채 영수증만 남는다.
  expect(readRecordsDetailed).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo/root" }));

  // ② 라우팅 엔진이 받은 것은 mock의 반환값이 아니라 **이 조립이 만든 입력**이다.
  expect(routeFeedbackArm).toHaveBeenCalledTimes(1);
  const routed = routeFeedbackArm.mock.calls[0][0];
  expect(routed.repo).toBe("acme/demo");
  expect(routed.root).toBe("/repo/root");
  expect(routed.harness).toBe(HARNESS);
  expect(routed.issues).toEqual([{ number: 45, state: "closed", closedAt: "2026-09-21T01:52:01Z", labels: [{ name: "factory:merged" }] }]);
  expect(routed.since).toBe(null);                     // 창은 이 이슈 하나다 — 커서로 다시 자르지 않는다
  expect(routed.commentsByIssue).toBeInstanceOf(Map);
  expect(routed.commentsByIssue.get(45)).toBe(comments);
  // 실제 생산자의 모양 그대로다 — 문자열 키, 기록 **본문**(nit 4). 라우팅은 `recs.get("45")`로 찾는다.
  expect(routed.records.get("45")).toBe(DEMO45.record);
  expect(routed.env).toBeTruthy();                     // 1.4.0 핫픽스: env는 필수 주입이다
  // must_fix 1 — 그리고 **왜 그 Map인지**도 함께 간다. 이 값이 없으면 라우팅이 "읽지 못했다"와
  // "읽었는데 줄이 없다"를 구별할 수 없고, 후자로 보고한다.
  expect(routed.recordsSource).toBe("records-branch");

  // ③ 팔의 반환값은 sweeper가 세는 그 모양 그대로 흘러나간다.
  expect(out).toEqual({ issues: [45], actions: [{ kind: "upstream-created", step: "feedback-route", issue: 45, upstream_issue: 61 }] });
});

test("test_36_human_merged_routing: a run record that cannot be hydrated still routes on comments alone, and says so (human-merged)", async () => {
  readRecordsDetailed.mockRejectedValueOnce(new Error("records branch unreachable"));
  const args = await runMain();
  await args.routeMerged({ issue: 45, comments: DEMO45.comments, mergedAt: "2026-09-21T01:52:01Z" });

  const routed = routeFeedbackArm.mock.calls[0][0];
  expect(routed.records).toBeInstanceOf(Map);
  expect(routed.records.size).toBe(0);                 // 빈 Map이지 undefined가 아니다 — 엔진이 터지지 않는다
  // must_fix 1 — 그리고 그 빈 Map은 **읽지 못한 것**이라고 말한다. 이 낱말이 없으면 라우팅은
  // 13줄짜리 1.4.0 기록을 가진 이 이슈를 "detail 줄이 없는 1.4 이전 기록"으로 보고한다.
  expect(routed.recordsSource).toBe("records-branch-unreadable");
  expect(routed.commentsByIssue.get(45)).toBe(DEMO45.comments);
  // 그리고 그 손실은 조용하지 않다: 운영자가 "영수증은 있는데 게이트 원인이 없다"를 나중에 추측하지 않게 한다.
  expect(warnSpy.mock.calls.flat().join(" ")).toMatch(/could not hydrate run records for #45/);
});

test("test_36_human_merged_routing: --quick keeps the same routing seam (the per-stage sweep is where a merge is seen first) (human-merged)", async () => {
  const args = await runMain(["--quick"]);
  expect(args.quick).toBe(true);
  expect(typeof args.routeMerged).toBe("function");
});
