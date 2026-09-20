import { test, expect } from "vitest";
import { makeGh, allChecksGreen, resolveRepo } from "../lib/gh.js";
import { makeFakeRun } from "../lib/exec.js";

const repo = "o/r";
test("issue() maps gh json; comments() maps id/body/createdAt", async () => {
  const run = makeFakeRun([
    { match: (c, a) => a.includes("view") && a.includes("--json"), result: { code: 0, stdout: JSON.stringify({ number: 5, title: "T", body: "B", labels: [{ name: "backlog" }, { name: "bug" }] }), stderr: "" } },
    // --slurp은 페이지마다 하나의 배열을 담은 배열을 낸다
    { match: (c, a) => a[0] === "api" && a[1].includes("/comments"), result: { code: 0, stdout: JSON.stringify([[{ id: 11, body: "x", created_at: "2026-09-11T00:00:00Z" }], [{ id: 12, body: "y", created_at: "2026-09-11T01:00:00Z" }]]), stderr: "" } },
  ]);
  const gh = makeGh({ run, repo });
  const issue = await gh.issue(5);
  expect(issue).toEqual({ number: 5, title: "T", body: "B", labels: ["backlog", "bug"] });
  expect(await gh.comments(5)).toEqual([
    { id: 11, body: "x", createdAt: "2026-09-11T00:00:00Z" },
    { id: 12, body: "y", createdAt: "2026-09-11T01:00:00Z" },
  ]);
  const api = run.calls.find((c) => c.args[0] === "api");
  expect(api.args).toEqual(["api", "repos/o/r/issues/5/comments?per_page=100", "--paginate", "--slurp"]);
});

// ── ADR-020 KTB-30 — 라벨 전이는 add-first · 재시도 · REST 폴백 · 쓴 뒤 확인 ──────────────────
// 데모에서 두 번(#2 08:52Z, #15 08:55Z) 같은 방식으로 죽었다: remove+add를 한 번의 `gh issue edit`으로
// 보내는데 GitHub이 중간에 실패해 **옛 라벨은 지워지고 새 라벨은 안 붙었다** — 상태 라벨이 0개인
// 이슈는 이벤트도 sweeper도 status도 보지 못한다. 순서를 뒤집으면 최악이 "두 개"(복구 가능)가 된다.
const labelsJson = (n, names) => ({ code: 0, stdout: JSON.stringify({ number: n, title: "", body: "", labels: names.map((name) => ({ name })) }), stderr: "" });
/** view 응답을 순서대로 돌려준다(첫 읽기 = 스왑 전, 두 번째 = 쓴 뒤 확인). */
const scriptedViews = (...snapshots) => {
  const q = [...snapshots];
  return () => (q.length > 1 ? q.shift() : q[0]);
};

test("KTB-30: setFactoryLabel ADDS the new state label first, then removes the old one (two separate calls)", async () => {
  const run = makeFakeRun([
    { match: (c, a) => a.includes("view"), result: scriptedViews(labelsJson(5, ["factory:ready", "bug"]), labelsJson(5, ["factory:planned", "bug"])) },
    { match: (c, a) => a.includes("edit"), result: { code: 0, stdout: "", stderr: "" } },
  ]);
  const gh = makeGh({ run, repo, sleep: async () => {} });
  const r = await gh.setFactoryLabel(5, "factory:planned");
  expect(run.calls.filter((c) => c.args.includes("edit")).map((c) => c.args)).toEqual([
    ["issue", "edit", "5", "-R", repo, "--add-label", "factory:planned"],
    ["issue", "edit", "5", "-R", repo, "--remove-label", "factory:ready"],
  ]);
  expect(r).toEqual({ label: "factory:planned", removed: ["factory:ready"], verify: "ok" });
});

test("KTB-30: a failing `gh issue edit` is retried with 1s/3s/9s backoff, then falls back to the REST labels endpoint", async () => {
  const slept = [];
  const run = makeFakeRun([
    { match: (c, a) => a.includes("view"), result: scriptedViews(labelsJson(2, ["factory:planned"]), labelsJson(2, ["factory:in-progress"])) },
    { match: (c, a) => a.includes("edit"), result: { code: 1, stdout: "", stderr: "GraphQL: Something went wrong while executing your query" } },
    { match: (c, a) => a[0] === "api", result: { code: 0, stdout: "[]", stderr: "" } },
  ]);
  const gh = makeGh({ run, repo, sleep: async (ms) => { slept.push(ms); } });
  const r = await gh.setFactoryLabel(2, "factory:in-progress");
  // 네 번(첫 시도 + 재시도 3회) 시도하고 그 사이에만 잔다 — add와 remove가 각자 자기 예산을 쓴다.
  expect(run.calls.filter((c) => c.args.includes("edit"))).toHaveLength(8);
  expect(slept).toEqual([1000, 3000, 9000, 1000, 3000, 9000]);
  const api = run.calls.filter((c) => c.args[0] === "api").map((c) => c.args);
  expect(api[0]).toEqual(["api", "-X", "POST", `repos/${repo}/issues/2/labels`, "-f", "labels[]=factory:in-progress"]);
  expect(api[1]).toEqual(["api", "-X", "DELETE", `repos/${repo}/issues/2/labels/factory%3Aplanned`]);
  expect(r.verify).toBe("ok");
});

test("KTB-30: when both `gh issue edit` and the REST fallback fail, the original error is thrown", async () => {
  const run = makeFakeRun([
    { match: (c, a) => a.includes("view"), result: labelsJson(2, ["factory:planned"]) },
    { match: (c, a) => a.includes("edit"), result: { code: 1, stdout: "", stderr: "EOF" } },
    { match: (c, a) => a[0] === "api", result: { code: 1, stdout: "", stderr: "HTTP 502" } },
  ]);
  const gh = makeGh({ run, repo, sleep: async () => {} });
  await expect(gh.setFactoryLabel(2, "factory:in-progress")).rejects.toThrow(/EOF[\s\S]*REST fallback/);
});

test("KTB-30: verify-after-write re-adds the state label when the read-back says it is missing", async () => {
  const run = makeFakeRun([
    // 스왑은 exit 0으로 끝났는데 읽어 보니 새 라벨이 없다(GitHub이 조용히 흘렸다) — 한 번 더 붙인다.
    { match: (c, a) => a.includes("view"), result: scriptedViews(labelsJson(2, ["factory:planned"]), labelsJson(2, [])) },
    { match: (c, a) => a.includes("edit"), result: { code: 0, stdout: "", stderr: "" } },
  ]);
  const gh = makeGh({ run, repo, sleep: async () => {} });
  const r = await gh.setFactoryLabel(2, "factory:in-progress");
  expect(r.verify).toBe("repaired");
  expect(run.calls.filter((c) => c.args.includes("--add-label")).map((c) => c.args.at(-1))).toEqual(["factory:in-progress", "factory:in-progress"]);
});

test("KTB-30: an unreadable verify read does not undo the swap — it reports `unverified`", async () => {
  let reads = 0;
  const run = makeFakeRun([
    { match: (c, a) => a.includes("view"), result: () => (++reads === 1 ? labelsJson(2, ["factory:planned"]) : { code: 1, stdout: "", stderr: "boom" }) },
    { match: (c, a) => a.includes("edit"), result: { code: 0, stdout: "", stderr: "" } },
  ]);
  const gh = makeGh({ run, repo, sleep: async () => {} });
  expect((await gh.setFactoryLabel(2, "factory:in-progress")).verify).toBe("unverified");
});

test("KTB-30: addLabels/removeLabel get the same retry + REST fallback", async () => {
  const run = makeFakeRun([
    { match: (c, a) => a.includes("edit"), result: { code: 1, stdout: "", stderr: "failed to update 1 issue" } },
    { match: (c, a) => a[0] === "api", result: { code: 0, stdout: "[]", stderr: "" } },
  ]);
  const gh = makeGh({ run, repo, sleep: async () => {} });
  await gh.addLabels(7, ["factory:flaky", "bug"]);
  await gh.removeLabel(7, "factory:flaky");
  const api = run.calls.filter((c) => c.args[0] === "api").map((c) => c.args);
  expect(api[0]).toEqual(["api", "-X", "POST", `repos/${repo}/issues/7/labels`, "-f", "labels[]=factory:flaky", "-f", "labels[]=bug"]);
  expect(api[1]).toEqual(["api", "-X", "DELETE", `repos/${repo}/issues/7/labels/factory%3Aflaky`]);
});

// KTB-9: tier는 상태와 직교한다 — setFactoryLabel(STATES만 본다)을 태우면 상태 라벨이 떨어져 나간다.
// KTB-30: tier도 add-first다(부분 실패가 "tier 0개"가 아니라 "tier 2개"로 남게).
test("setTierLabel swaps only the other factory:tier-* labels, leaving state labels alone", async () => {
  const run = makeFakeRun([
    { match: (c, a) => a.includes("view"), result: labelsJson(2, ["factory:ready", "factory:tier-docs", "bug"]) },
    { match: (c, a) => a.includes("edit"), result: { code: 0, stdout: "", stderr: "" } },
  ]);
  const gh = makeGh({ run, repo, sleep: async () => {} });
  await gh.setTierLabel(2, "factory:tier-standard");
  expect(run.calls.filter((c) => c.args.includes("edit")).map((c) => c.args)).toEqual([
    ["issue", "edit", "2", "-R", repo, "--add-label", "factory:tier-standard"],
    ["issue", "edit", "2", "-R", repo, "--remove-label", "factory:tier-docs"],
  ]);
});

test("setTierLabel on an issue with no tier yet is a plain add (one gh call, no removals)", async () => {
  const run = makeFakeRun([
    { match: (c, a) => a.includes("view"), result: labelsJson(2, ["factory:queue"]) },
    { match: (c, a) => a.includes("edit"), result: { code: 0, stdout: "", stderr: "" } },
  ]);
  const gh = makeGh({ run, repo, sleep: async () => {} });
  await gh.setTierLabel(2, "factory:tier-standard");
  expect(run.calls.filter((c) => c.args.includes("edit"))).toHaveLength(1);
  expect(run.calls.find((c) => c.args.includes("edit")).args).toEqual(["issue", "edit", "2", "-R", repo, "--add-label", "factory:tier-standard"]);
});

test("comment() posts body via --body-file from stdin", async () => {
  const run = makeFakeRun([{ match: (c, a) => a.includes("comment"), result: { code: 0, stdout: "https://x/1#issuecomment-99", stderr: "" } }]);
  const gh = makeGh({ run, repo });
  const url = await gh.comment(5, "hello");
  expect(url).toContain("issuecomment-99");
  const call = run.calls[0];
  expect(call.args).toEqual(["issue", "comment", "5", "-R", repo, "--body-file", "-"]);
  expect(call.opts.input).toBe("hello");
});

test("patchComment sends body via --input stdin JSON (avoids -f @-prefix file interpretation)", async () => {
  const run = makeFakeRun([{ match: (c, a) => a.includes("PATCH"), result: { code: 0, stdout: "", stderr: "" } }]);
  const gh = makeGh({ run, repo });
  await gh.patchComment(42, "@user hi");
  const call = run.calls[0];
  expect(call.args.slice(-2)).toEqual(["--input", "-"]);
  expect(call.opts.input).toBe(JSON.stringify({ body: "@user hi" }));
});

test("non-zero exit throws with stderr", async () => {
  const run = makeFakeRun([{ match: () => true, result: { code: 1, stdout: "", stderr: "boom" } }]);
  await expect(makeGh({ run, repo }).issue(1)).rejects.toThrow(/boom/);
});

test("searchIssues lists open issues by label", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "issue" && a[1] === "list", result: { code: 0, stdout: JSON.stringify([{ number: 1, title: "T", updatedAt: "2026-09-11T00:00:00Z" }]), stderr: "" } }]);
  const gh = makeGh({ run, repo });
  const issues = await gh.searchIssues("factory:awaiting-review");
  expect(issues).toEqual([{ number: 1, title: "T", updatedAt: "2026-09-11T00:00:00Z" }]);
  const call = run.calls[0];
  expect(call.args).toEqual(["issue", "list", "-R", repo, "--label", "factory:awaiting-review", "--state", "open", "--limit", "200", "--json", "number,title,updatedAt"]);
});

test("KTB-46: searchIssues takes state and sort options — closed issues keep their label, and ordering moves to the API", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "issue" && a[1] === "list", result: { code: 0, stdout: "[]", stderr: "" } }]);
  const gh = makeGh({ run, repo });
  await gh.searchIssues("factory:needs-human", { state: "all" });
  expect(run.calls[0].args).toEqual(["issue", "list", "-R", repo, "--label", "factory:needs-human", "--state", "all", "--limit", "200", "--json", "number,title,updatedAt"]);
  // 정렬 수식어는 `--search`로만 갈 수 있으므로 그때는 라벨도 검색 문법으로 옮긴다 — 그래야 그 200개가
  // "번호가 큰 200개"가 아니라 "가장 최근에 움직인 200개"가 된다(닫힌 이슈는 무한히 쌓인다).
  // 정렬을 쓰는 호출만 `state`도 받아 온다 — 그 팔은 닫힌 이슈까지 보므로 "열려 있는가"가 후보를
  // 자르는 기준의 절반이다(r5). 기본 호출의 필드 목록은 위 단언대로 그대로다.
  await gh.searchIssues("factory:needs-human", { state: "all", sort: "updated-desc" });
  expect(run.calls[1].args).toEqual(["issue", "list", "-R", repo, "--search", 'label:"factory:needs-human" sort:updated-desc', "--state", "all", "--limit", "200", "--json", "number,title,updatedAt,state"]);
});

test("KTB-46: prMergeInfo reports who merged the PR and on which head sha — missing fields stay null", async () => {
  const body = { number: 4, headRefOid: "c".repeat(40), mergeCommit: { oid: "d".repeat(40) }, mergedAt: "2026-09-14T13:59:00Z", mergedBy: { login: "LeeHyeonKyu" } };
  const run = makeFakeRun([{ match: (c, a) => a[0] === "pr" && a[1] === "view", result: { code: 0, stdout: JSON.stringify(body), stderr: "" } }]);
  const gh = makeGh({ run, repo });
  expect(await gh.prMergeInfo(4)).toEqual({ headSha: "c".repeat(40), mergeSha: "d".repeat(40), mergedAt: "2026-09-14T13:59:00Z", mergedBy: "LeeHyeonKyu" });
  expect(run.calls[0].args).toEqual(["pr", "view", "4", "-R", repo, "--json", "number,headRefOid,mergeCommit,mergedAt,mergedBy"]);

  // 머지되지 않은 PR: 아무것도 지어내지 않는다.
  const run2 = makeFakeRun([{ match: (c, a) => a[0] === "pr", result: { code: 0, stdout: JSON.stringify({ number: 4, headRefOid: "c".repeat(40), mergeCommit: null, mergedAt: null, mergedBy: null }), stderr: "" } }]);
  expect(await makeGh({ run: run2, repo }).prMergeInfo(4)).toEqual({ headSha: "c".repeat(40), mergeSha: null, mergedAt: null, mergedBy: null });
});

test("createIssue returns the issue number parsed from the created URL", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "issue" && a[1] === "create", result: { code: 0, stdout: "https://github.com/o/r/issues/42\n", stderr: "" } }]);
  const gh = makeGh({ run, repo });
  const n = await gh.createIssue({ title: "factory: 토큰 갱신 필요", body: "body", labels: ["factory:needs-human"] });
  expect(n).toBe(42);
  const call = run.calls[0];
  expect(call.args).toEqual(["issue", "create", "-R", repo, "--title", "factory: 토큰 갱신 필요", "--body-file", "-", "--label", "factory:needs-human"]);
  expect(call.opts.input).toBe("body");
});

test("prChecks asks for name,state,bucket; allChecksGreen is fail-closed and falls back to state", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "pr" && a[1] === "checks", result: { code: 0, stdout: JSON.stringify([{ name: "ci", state: "SUCCESS", bucket: "pass" }]), stderr: "" } }]);
  expect(await makeGh({ run, repo }).prChecks(9)).toEqual([{ name: "ci", state: "SUCCESS", bucket: "pass" }]);
  expect(run.calls[0].args).toEqual(["pr", "checks", "9", "-R", repo, "--json", "name,state,bucket"]);
  expect(allChecksGreen([{ bucket: "pass" }, { bucket: "pass" }])).toBe(true);
  expect(allChecksGreen([{ bucket: "pass" }, { bucket: "fail" }])).toBe(false);
  expect(allChecksGreen([])).toBe(false);                                  // 체크가 하나도 없으면 "확인됨"이 아니다
  expect(allChecksGreen([{ state: "SUCCESS" }])).toBe(true);               // bucket을 모르는 gh 버전
  expect(allChecksGreen([{ state: "FAILURE" }])).toBe(false);
});

test("getVariable returns trimmed value, or null on non-zero exit (missing variable)", async () => {
  const run = makeFakeRun([{ match: () => true, result: { code: 0, stdout: "2025-10-11T00:00:00Z\n", stderr: "" } }]);
  expect(await makeGh({ run, repo }).getVariable("FACTORY_TOKEN_ISSUED_AT")).toBe("2025-10-11T00:00:00Z");
  const runMissing = makeFakeRun([{ match: () => true, result: { code: 1, stdout: "", stderr: "variable not found" } }]);
  expect(await makeGh({ run: runMissing, repo }).getVariable("FACTORY_TOKEN_ISSUED_AT")).toBe(null);
});

// resolveRepo — KTB-4: FACTORY_REPO 우선, 없으면 gh repo view로 cwd 저장소를 묻는다. 실패는 삼키지 않고 throw한다
// (doctor.js가 "빈 문자열 repo"로 조용히 떨어져 거짓 "protection 없음"을 보고했던 결함, gh.js 주석 참조).
test("resolveRepo: FACTORY_REPO env wins over gh — never calls run", async () => {
  const prev = process.env.FACTORY_REPO;
  process.env.FACTORY_REPO = "env/owner-repo";
  try {
    const run = makeFakeRun([{ match: () => true, result: { code: 0, stdout: JSON.stringify({ nameWithOwner: "gh/owner-repo" }), stderr: "" } }]);
    expect(await resolveRepo({ run })).toBe("env/owner-repo");
    expect(run.calls).toHaveLength(0);
  } finally {
    if (prev === undefined) delete process.env.FACTORY_REPO; else process.env.FACTORY_REPO = prev;
  }
});

test("resolveRepo: falls back to `gh repo view --json nameWithOwner` when FACTORY_REPO is unset", async () => {
  const prev = process.env.FACTORY_REPO;
  delete process.env.FACTORY_REPO;
  try {
    const run = makeFakeRun([{ match: (c, a) => c === "gh" && a[0] === "repo" && a[1] === "view", result: { code: 0, stdout: JSON.stringify({ nameWithOwner: "LeeHyeonKyu/know-thy-build-demo" }), stderr: "" } }]);
    expect(await resolveRepo({ run })).toBe("LeeHyeonKyu/know-thy-build-demo");
    expect(run.calls[0].args).toEqual(["repo", "view", "--json", "nameWithOwner"]);
  } finally {
    if (prev === undefined) delete process.env.FACTORY_REPO; else process.env.FACTORY_REPO = prev;
  }
});

test("resolveRepo: throws (does not fall back to empty string) when gh repo view fails — not a git repo / not logged in", async () => {
  const prev = process.env.FACTORY_REPO;
  delete process.env.FACTORY_REPO;
  try {
    const run = makeFakeRun([{ match: () => true, result: { code: 1, stdout: "", stderr: "not a git repository" } }]);
    await expect(resolveRepo({ run })).rejects.toThrow(/not a git repository/);
  } finally {
    if (prev === undefined) delete process.env.FACTORY_REPO; else process.env.FACTORY_REPO = prev;
  }
});

// ── Task 9: bootstrap/status/merge surface + required_checks filter ────────

test("allChecksGreen with required: all required names present and pass → true; a missing name → false; required=null keeps old behavior", () => {
  const checks = [{ name: "factory/gates", bucket: "pass" }, { name: "lint", bucket: "fail" }];
  expect(allChecksGreen(checks, ["factory/gates"])).toBe(true);
  expect(allChecksGreen(checks, ["factory/gates", "lint"])).toBe(false);
  expect(allChecksGreen(checks, ["factory/gates", "factory/review"])).toBe(false); // absent name → false
  expect(allChecksGreen(checks, null)).toBe(false); // old behavior: every check must pass
  expect(allChecksGreen([{ bucket: "pass" }], null)).toBe(true);
});

test("allChecksGreen: a duplicate check name (commit status + check-run) must have ALL matches green, not just the first found", () => {
  const onePendingOnePass = [{ name: "factory/gates", bucket: "pass" }, { name: "factory/gates", bucket: "pending" }];
  expect(allChecksGreen(onePendingOnePass, ["factory/gates"])).toBe(false);
  const bothPass = [{ name: "factory/gates", bucket: "pass" }, { name: "factory/gates", bucket: "pass" }];
  expect(allChecksGreen(bothPass, ["factory/gates"])).toBe(true);
});

test("allChecksGreen: required=[] means 'not configured', not vacuously true — fail closed", () => {
  expect(allChecksGreen([{ name: "a", bucket: "pass" }], [])).toBe(false);
});

test("setStatus posts a status via --input stdin JSON, truncating description to 140 chars", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "api" && a[3].includes("/statuses/"), result: { code: 0, stdout: "", stderr: "" } }]);
  const gh = makeGh({ run, repo });
  const long = "x".repeat(200);
  await gh.setStatus({ sha: "a".repeat(40), context: "factory/gates", state: "success", description: long, targetUrl: "https://x" });
  const call = run.calls[0];
  expect(call.args).toEqual(["api", "-X", "POST", `repos/${repo}/statuses/${"a".repeat(40)}`, "--input", "-"]);
  const body = JSON.parse(call.opts.input);
  expect(body).toEqual({ state: "success", context: "factory/gates", description: "x".repeat(140), target_url: "https://x" });
});

test("setStatus rejects an invalid state before calling gh", async () => {
  const run = makeFakeRun([{ match: () => true, result: { code: 0, stdout: "", stderr: "" } }]);
  const gh = makeGh({ run, repo });
  await expect(gh.setStatus({ sha: "a".repeat(40), context: "factory/gates", state: "unknown" })).rejects.toThrow(/invalid state/);
  expect(run.calls).toHaveLength(0);
});

test("listSecrets/listLabels map to name arrays; createLabel forces the color/description", async () => {
  const run = makeFakeRun([
    { match: (c, a) => a[0] === "secret" && a[1] === "list", result: { code: 0, stdout: JSON.stringify([{ name: "TOKEN" }]), stderr: "" } },
    { match: (c, a) => a[0] === "label" && a[1] === "list", result: { code: 0, stdout: JSON.stringify([{ name: "bug" }, { name: "backlog" }]), stderr: "" } },
    { match: (c, a) => a[0] === "label" && a[1] === "create", result: { code: 0, stdout: "", stderr: "" } },
  ]);
  const gh = makeGh({ run, repo });
  expect(await gh.listSecrets()).toEqual(["TOKEN"]);
  expect(run.calls[0].args).toEqual(["secret", "list", "-R", repo, "--json", "name"]);
  expect(await gh.listLabels()).toEqual(["bug", "backlog"]);
  expect(run.calls[1].args).toEqual(["label", "list", "-R", repo, "--json", "name", "--limit", "200"]);
  await gh.createLabel({ name: "factory:ready", color: "00ff00", description: "ready for review" });
  expect(run.calls[2].args).toEqual(["label", "create", "factory:ready", "-R", repo, "--color", "00ff00", "--description", "ready for review", "--force"]);
});

test("listEnvSecrets: parses the name array; a 404/missing environment (or any non-zero exit, or unparsable stdout) resolves to [], never throws", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "secret" && a[1] === "list" && a.includes("--env"), result: { code: 0, stdout: JSON.stringify([{ name: "FACTORY_MERGE_TOKEN" }]), stderr: "" } }]);
  const gh = makeGh({ run, repo });
  expect(await gh.listEnvSecrets("factory-merge")).toEqual(["FACTORY_MERGE_TOKEN"]);
  expect(run.calls[0].args).toEqual(["secret", "list", "--env", "factory-merge", "-R", repo, "--json", "name"]);

  const run404 = makeFakeRun([{ match: () => true, result: { code: 1, stdout: "", stderr: "HTTP 404: Not Found (environments are a paid feature here)" } }]);
  expect(await makeGh({ run: run404, repo }).listEnvSecrets("factory-merge")).toEqual([]);

  const runBadJson = makeFakeRun([{ match: () => true, result: { code: 0, stdout: "", stderr: "" } }]);
  expect(await makeGh({ run: runBadJson, repo }).listEnvSecrets("factory-merge")).toEqual([]);
});

test("getBranchProtection returns parsed json, or null on non-zero exit (404); putBranchProtection PUTs body on stdin", async () => {
  const run = makeFakeRun([{ match: () => true, result: { code: 0, stdout: JSON.stringify({ required_status_checks: { contexts: ["ci"] } }), stderr: "" } }]);
  const gh = makeGh({ run, repo });
  expect(await gh.getBranchProtection("main")).toEqual({ required_status_checks: { contexts: ["ci"] } });
  expect(run.calls[0].args).toEqual(["api", `repos/${repo}/branches/main/protection`]);

  const run404 = makeFakeRun([{ match: () => true, result: { code: 1, stdout: "", stderr: "HTTP 404: Branch not protected" } }]);
  expect(await makeGh({ run: run404, repo }).getBranchProtection("main")).toBe(null);

  const runPut = makeFakeRun([{ match: (c, a) => a.includes("PUT"), result: { code: 0, stdout: "", stderr: "" } }]);
  const ghPut = makeGh({ run: runPut, repo });
  await ghPut.putBranchProtection("main", { required_status_checks: { contexts: ["ci"] } });
  const putCall = runPut.calls[0];
  expect(putCall.args).toEqual(["api", "-X", "PUT", `repos/${repo}/branches/main/protection`, "--input", "-"]);
  expect(JSON.parse(putCall.opts.input)).toEqual({ required_status_checks: { contexts: ["ci"] } });
});

test("getBranchProtection throws (not null) on the GitHub Free private-repo 403 — doctor needs to tell this apart from a plain 404", async () => {
  const run403 = makeFakeRun([{ match: () => true, result: { code: 1, stdout: "", stderr: "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)" } }]);
  await expect(makeGh({ run: run403, repo }).getBranchProtection("main")).rejects.toThrow(/Upgrade to GitHub Pro/);

  // the alternate GitHub wording ("make this repository public") also throws.
  const run403b = makeFakeRun([{ match: () => true, result: { code: 1, stdout: "", stderr: "gh: make this repository public or upgrade (HTTP 403)" } }]);
  await expect(makeGh({ run: run403b, repo }).getBranchProtection("main")).rejects.toThrow(/make this repository public/);

  // any other non-zero exit (404, network error, etc.) is unchanged — still resolves to null, never throws.
  const runOther = makeFakeRun([{ match: () => true, result: { code: 1, stdout: "", stderr: "HTTP 404: Branch not protected" } }]);
  expect(await makeGh({ run: runOther, repo }).getBranchProtection("main")).toBe(null);
});

test("setVariable sets a repo variable via --body", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "variable" && a[1] === "set", result: { code: 0, stdout: "", stderr: "" } }]);
  const gh = makeGh({ run, repo });
  await gh.setVariable("FACTORY_TOKEN_ISSUED_AT", "2026-09-12T00:00:00Z");
  expect(run.calls[0].args).toEqual(["variable", "set", "FACTORY_TOKEN_ISSUED_AT", "-R", repo, "--body", "2026-09-12T00:00:00Z"]);
});

test("prView maps gh json including label names", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "pr" && a[1] === "view", result: { code: 0, stdout: JSON.stringify({ number: 9, state: "OPEN", mergeable: "MERGEABLE", headRefName: "claude/fq-7", headRefOid: "a".repeat(40), baseRefName: "main", labels: [{ name: "factory:approved" }] }), stderr: "" } }]);
  const gh = makeGh({ run, repo });
  expect(await gh.prView(9)).toEqual({ number: 9, state: "OPEN", mergeable: "MERGEABLE", headRefName: "claude/fq-7", headRefOid: "a".repeat(40), baseRefName: "main", labels: ["factory:approved"] });
  expect(run.calls[0].args).toEqual(["pr", "view", "9", "-R", repo, "--json", "number,state,mergeable,headRefName,headRefOid,baseRefName,labels"]);
});

// KTB-15: implement가 여는 PR은 draft다(`gh pr create --draft`). draft는 `gh pr merge`가
// "Pull Request is still a draft"로 거부하므로, 머지 직전에 ready로 뒤집는 호출이 필요하다.
test("prReady flips a draft PR to ready for review", async () => {
  const run = makeFakeRun([{ match: () => true, result: { code: 0, stdout: "", stderr: "" } }]);
  const gh = makeGh({ run, repo });
  await gh.prReady(9);
  expect(run.calls[0].args).toEqual(["pr", "ready", "9", "-R", repo]);
});

test("mergePr defaults to squash + delete-branch; closeIssue adds --comment only when given", async () => {
  const run = makeFakeRun([{ match: () => true, result: { code: 0, stdout: "", stderr: "" } }]);
  const gh = makeGh({ run, repo });
  await gh.mergePr(9, {});
  expect(run.calls[0].args).toEqual(["pr", "merge", "9", "-R", repo, "--squash", "--delete-branch"]);
  await gh.mergePr(9, { method: "rebase", deleteBranch: false });
  expect(run.calls[1].args).toEqual(["pr", "merge", "9", "-R", repo, "--rebase"]);
  await gh.closeIssue(5);
  expect(run.calls[2].args).toEqual(["issue", "close", "5", "-R", repo]);
  await gh.closeIssue(5, "superseded");
  expect(run.calls[3].args).toEqual(["issue", "close", "5", "-R", repo, "--comment", "superseded"]);
});

test("issueList maps labels to names and forwards state/limit/labels; prList forwards label/state", async () => {
  const run = makeFakeRun([
    { match: (c, a) => a[0] === "issue" && a[1] === "list", result: { code: 0, stdout: JSON.stringify([{ number: 1, title: "T", labels: [{ name: "bug" }], updatedAt: "2026-09-11T00:00:00Z", closedAt: null }]), stderr: "" } },
    { match: (c, a) => a[0] === "pr" && a[1] === "list", result: { code: 0, stdout: JSON.stringify([{ number: 9, title: "P", body: "<!-- factory-retro:v1 period=a..b -->", headRefName: "claude/fq-7", updatedAt: "2026-09-11T00:00:00Z" }]), stderr: "" } },
  ]);
  const gh = makeGh({ run, repo });
  // KTB-23 fix: issueList도 body를 받는다 — `factory:harness` 이슈의 dedupe 키가 제목이 아니라
  // 본문의 `factory-harness-request` 마커이기 때문이다. 본문이 없는 응답은 ""로 정규화된다.
  expect(await gh.issueList({ labels: ["bug", "backlog"], state: "closed", limit: 50 })).toEqual([{ number: 1, title: "T", body: "", labels: ["bug"], updatedAt: "2026-09-11T00:00:00Z", closedAt: null }]);
  expect(run.calls[0].args).toEqual(["issue", "list", "-R", repo, "--state", "closed", "--limit", "50", "--label", "bug", "--label", "backlog", "--json", "number,title,body,labels,updatedAt,closedAt"]);
  // body도 받는다 — retro의 제안 PR dedup이 본문 마커로 같은 창을 알아본다
  expect(await gh.prList({ label: "factory:approved" })).toEqual([{ number: 9, title: "P", body: "<!-- factory-retro:v1 period=a..b -->", headRefName: "claude/fq-7", updatedAt: "2026-09-11T00:00:00Z" }]);
  expect(run.calls[1].args).toEqual(["pr", "list", "-R", repo, "--state", "open", "--label", "factory:approved", "--json", "number,title,body,headRefName,updatedAt"]);
});

test("createPr opens a non-draft PR with labels and returns the number", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "pr" && a[1] === "create", result: { code: 0, stdout: "https://github.com/o/r/pull/131\n", stderr: "" } }]);
  const gh = makeGh({ run, repo });
  const pr = await gh.createPr({ head: "factory/lessons-2026-09-12", base: "main", title: "retro: lessons", body: "B", labels: ["factory:retro-proposal"] });
  expect(pr).toBe(131);
  expect(run.calls[0].args).toEqual([
    "pr", "create", "-R", repo, "--head", "factory/lessons-2026-09-12", "--base", "main",
    "--title", "retro: lessons", "--body-file", "-", "--label", "factory:retro-proposal",
  ]);
  expect(run.calls[0].args).not.toContain("--draft");
  expect(run.calls[0].opts.input).toBe("B");
});

// ── ADR-020 KTB-23 fix — sweeper의 하네스 주차 해제 팔이 쓰는 두 조회 ───────────────────────────
// `issue()`는 state를 싣지 않는다(그 함수는 라벨·본문을 읽는 자리라 필드를 늘리면 모든 호출자가 더 큰
// 응답을 받는다) — 그래서 "닫혔는가"만 묻는 조회를 따로 둔다. 두 번째는 `Closes #n` 없이 사람이 머지한
// 경우의 폴백이다: builder는 언제나 `claude/fq-<issue>`에서 작업하므로 브랜치 이름이 곧 이슈 번호다.
test("issueState reads only state/closedAt; mergedPrForBranch finds the merged PR for a branch", async () => {
  const run = makeFakeRun([
    { match: (c, a) => a[0] === "issue" && a[1] === "view", result: { code: 0, stdout: JSON.stringify({ number: 31, state: "CLOSED", closedAt: "2026-09-13T10:00:00Z" }), stderr: "" } },
    { match: (c, a) => a[0] === "pr" && a[1] === "list", result: { code: 0, stdout: JSON.stringify([{ number: 24, mergedAt: "2026-09-13T09:00:00Z" }]), stderr: "" } },
  ]);
  const gh = makeGh({ run, repo });
  expect(await gh.issueState(31)).toEqual({ number: 31, state: "CLOSED", closedAt: "2026-09-13T10:00:00Z" });
  expect(run.calls[0].args).toEqual(["issue", "view", "31", "-R", repo, "--json", "number,state,closedAt"]);
  expect(await gh.mergedPrForBranch("claude/fq-31")).toBe(24);
  expect(run.calls[1].args).toEqual(["pr", "list", "-R", repo, "--head", "claude/fq-31", "--state", "merged", "--limit", "5", "--json", "number,mergedAt"]);
});

test("mergedPrForBranch returns null when nothing was merged from that branch", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "pr" && a[1] === "list", result: { code: 0, stdout: "[]", stderr: "" } }]);
  expect(await makeGh({ run, repo }).mergedPrForBranch("claude/fq-31")).toBeNull();
});

// ── ADR-021 fix round r1 ────────────────────────────────────────────────────

test("viewerScopes reads X-OAuth-Scopes from `gh api -i user` — the token value is never in the arguments", async () => {
  const headers = "HTTP/2.0 200 OK\r\nX-OAuth-Scopes: repo, read:org\r\nX-Accepted-OAuth-Scopes: \r\n\r\n{\"login\":\"factory-bot\"}";
  const run = makeFakeRun([{ match: (c, a) => a[0] === "api" && a[1] === "-i", result: { code: 0, stdout: headers, stderr: "" } }]);
  const gh = makeGh({ run, repo });
  expect(await gh.viewerScopes()).toEqual(["repo", "read:org"]);
  expect(run.calls[0].args).toEqual(["api", "-i", "user"]);
});

test("viewerScopes: no X-OAuth-Scopes header → null (a fine-grained PAT or an App token — the classic `workflow` scope does not exist there)", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "api", result: { code: 0, stdout: "HTTP/2.0 200 OK\r\n\r\n{}", stderr: "" } }]);
  expect(await makeGh({ run, repo }).viewerScopes()).toBeNull();

  // 빈 스코프 문자열은 "classic PAT인데 스코프가 없다"이지 "classic PAT이 아니다"가 아니다.
  const empty = makeFakeRun([{ match: (c, a) => a[0] === "api", result: { code: 0, stdout: "HTTP/2.0 200 OK\r\nx-oauth-scopes: \r\n\r\n{}", stderr: "" } }]);
  expect(await makeGh({ run: empty, repo }).viewerScopes()).toEqual([]);
});

test("viewerScopes: a failing call throws with the stderr, so doctor reports WARN instead of a silent PASS", async () => {
  const run = makeFakeRun([{ match: () => true, result: { code: 1, stdout: "", stderr: "gh: Bad credentials" } }]);
  await expect(makeGh({ run, repo }).viewerScopes()).rejects.toThrow(/Bad credentials/);
});

// ── Feedback loop Task 3 — 교차 저장소 개선 이슈(열거나 덧붙이거나) ───────────────────────────
// 이 어댑터는 **문법을 모른다**: 지문으로 검색하고, 맞는 본문을 고르는 일(match)·새 본문을 만드는
// 일(render)·증거를 덧붙이는 일(append)은 전부 호출자가 넘긴다(`lib/feedback/upstream-issue.js`가
// 유일한 문법 출처다). 모든 호출에 `-R <upstream>`이 붙는지가 이 테스트의 핵심이다.
test("upstreamIssue: 같은 지문의 열린 이슈가 없으면 -R upstream 에 새로 연다", async () => {
  const run = makeFakeRun([
    { match: (c, a) => a[0] === "issue" && a[1] === "list", result: { code: 0, stdout: "[]", stderr: "" } },
    { match: (c, a) => a[0] === "issue" && a[1] === "create", result: { code: 0, stdout: "https://github.com/o/up/issues/12\n", stderr: "" } },
  ]);
  const r = await makeGh({ run, repo }).upstreamIssue({
    repo: "o/up", fingerprint: "deadbeef",
    match: () => false,
    render: () => ({ title: "factory-improvement: x", body: "BODY", labels: ["factory-improvement", "backlog"] }),
    append: () => { throw new Error("append must not run when nothing matched"); },
  });
  expect(r).toEqual({ issue: 12, created: true, appended: false });
  expect(run.calls[0].args).toEqual(["issue", "list", "-R", "o/up", "--search", "deadbeef in:body", "--state", "open", "--limit", "50", "--json", "number,body"]);
  expect(run.calls[1].args).toEqual(["issue", "create", "-R", "o/up", "--title", "factory-improvement: x", "--body-file", "-", "--label", "factory-improvement", "--label", "backlog"]);
  expect(run.calls[1].opts.input).toBe("BODY");
});

test("upstreamIssue: 맞는 이슈가 있으면 새로 열지 않고 본문을 stdin으로 갈아 끼운다", async () => {
  const run = makeFakeRun([
    { match: (c, a) => a[0] === "issue" && a[1] === "list", result: { code: 0, stdout: JSON.stringify([{ number: 7, body: "OLD" }]), stderr: "" } },
    { match: (c, a) => a[0] === "issue" && a[1] === "edit", result: { code: 0, stdout: "", stderr: "" } },
  ]);
  const r = await makeGh({ run, repo }).upstreamIssue({
    repo: "o/up", fingerprint: "deadbeef",
    match: (b) => b === "OLD",
    render: () => { throw new Error("render must not run when an issue matched"); },
    append: (b) => `${b}\nNEW EVIDENCE`,
  });
  expect(r).toEqual({ issue: 7, created: false, appended: true });
  expect(run.calls[1].args).toEqual(["issue", "edit", "7", "-R", "o/up", "--body-file", "-"]);
  expect(run.calls[1].opts.input).toBe("OLD\nNEW EVIDENCE");
});

test("upstreamIssue: append가 본문을 바꾸지 않으면(같은 목격) 편집 호출 자체가 나가지 않는다", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "issue" && a[1] === "list", result: { code: 0, stdout: JSON.stringify([{ number: 7, body: "OLD" }]), stderr: "" } }]);
  const r = await makeGh({ run, repo }).upstreamIssue({
    repo: "o/up", fingerprint: "f", match: () => true, render: () => ({ title: "t", body: "b" }), append: (b) => b,
  });
  expect(r).toEqual({ issue: 7, created: false, appended: false });
  expect(run.calls).toHaveLength(1);
});

test("upstreamIssue: upstream 저장소 이름이 없으면 아무 호출도 하지 않고 던진다", async () => {
  const run = makeFakeRun([{ match: () => true, result: { code: 0, stdout: "[]", stderr: "" } }]);
  await expect(makeGh({ run, repo }).upstreamIssue({ fingerprint: "f", match: () => false, render: () => ({ title: "t", body: "b" }), append: (b) => b }))
    .rejects.toThrow(/upstream repo/);
  expect(run.calls).toEqual([]);
});

test("putEnvironment PUTs the deployment branch policy by stdin — the body never reaches the argv", async () => {
  const run = makeFakeRun([{ match: (c, a) => a[0] === "api" && a[1] === "-X", result: { code: 0, stdout: "{}", stderr: "" } }]);
  const body = { deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } };
  await makeGh({ run, repo }).putEnvironment("factory-merge", body);
  expect(run.calls[0].args).toEqual(["api", "-X", "PUT", `repos/${repo}/environments/factory-merge`, "--input", "-"]);
  expect(JSON.parse(run.calls[0].opts.input)).toEqual(body);
});
