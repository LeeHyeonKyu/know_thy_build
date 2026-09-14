import { test, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCharter, neverAutomateGlobs, TRIAGE_DEFAULT_VALUES } from "../lib/config.js";
import { checkTriageDefault } from "../lib/doctor/factory.js";
import { neverAutomateHits, verifyStage } from "../lib/verify-stage.js";
import { buildContext } from "../lib/context.js";
// #20 — 사람 머지 문(門)에 대한 CHARTER의 문장을 **그 문 자체**에 대고 확인하기 위한 것들.
import { sweep } from "../lib/sweeper.js";
import { requirementFor, QA_EVIDENCE_NOT_BOUND } from "../lib/requirements.js";
import { renderHandoff } from "../lib/handoff.js";

const by = (cs) => Object.fromEntries(cs.map((c) => [c.id, c]));
const TEMPLATE_CHARTER = new URL("../../templates/factory/docs/factory/CHARTER.md", import.meta.url).pathname;
const REPO_CHARTER = new URL("../../docs/factory/CHARTER.md", import.meta.url).pathname;
const TRIAGE_AGENT = new URL("../../templates/factory/claude/agents/factory-triage.md", import.meta.url).pathname;

function charterRoot(frontmatterExtra = "", body = "") {
  const r = mkdtempSync(join(tmpdir(), "charter-"));
  mkdirSync(join(r, ".factory"), { recursive: true });
  mkdirSync(join(r, "docs/factory"), { recursive: true });
  writeFileSync(join(r, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: ready\ntier_default: standard\n${frontmatterExtra}---\n${body}`);
  return r;
}

// --- 감사 M1: triage의 기본 판정은 기본값이 아니라 CHARTER가 적어 두는 선택이다 ---

test("loadCharter surfaces triage.default and leaves it undefined when the CHARTER never says", () => {
  expect(loadCharter(charterRoot("triage: { default: ready }\n")).triage.default).toBe("ready");
  expect(loadCharter(charterRoot("triage: { default: needs-info }\n")).triage.default).toBe("needs-info");
  // 기본값을 채우지 않는다 — 없는 것과 고른 것은 다른 사실이고, doctor가 그 둘을 가른다.
  expect(loadCharter(charterRoot()).triage.default).toBeUndefined();
  expect(TRIAGE_DEFAULT_VALUES).toEqual(["needs-info", "ready"]);
});

test("neverAutomateGlobs pulls only path-glob-shaped items out of the NEVER_AUTOMATE section", () => {
  const body = [
    "# Charter",
    "",
    "## NEVER_AUTOMATE (triage가 wont-do로 보냄)",
    "- `auth/**` 아래의 인증 흐름",
    "- 결제(`billing/**`)와 `package.json`의 `version` 필드",
    "- `harness.toml [protected]`를 바꾸는 변경",
    "- `.env*`, 시크릿",
    "",
    "## Definition of Done",
    "- `docs/**`는 여기 있어도 대상이 아니다",
  ].join("\n");
  expect(neverAutomateGlobs(body)).toEqual(["auth/**", "billing/**", ".env*"]);
  expect(neverAutomateGlobs("")).toEqual([]);
});

test("loadCharter carries the NEVER_AUTOMATE globs from the body, not just the frontmatter", () => {
  const r = charterRoot("", "## NEVER_AUTOMATE\n- `billing/**`\n");
  expect(loadCharter(r).never_automate).toEqual(["billing/**"]);
});

test("doctor: triage.default unset is a FAIL, needs-info a PASS, ready a stated WARN, garbage a FAIL", () => {
  expect(by(checkTriageDefault({ triage: { default: "needs-info" } }))["charter.triage-default"].level).toBe("PASS");
  const ready = by(checkTriageDefault({ triage: { default: "ready" } }))["triage.default-allow"];
  expect(ready.level).toBe("WARN");
  expect(ready.detail).toMatch(/ready/);
  for (const charter of [{}, { triage: {} }, { triage: { default: "" } }]) {
    expect(by(checkTriageDefault(charter))["charter.triage-default-unset"].level).toBe("FAIL");
  }
  expect(by(checkTriageDefault({ triage: { default: "yes-please" } }))["charter.triage-default-unset"].level).toBe("FAIL");
});

test("the template CHARTER stops on silence (needs-info); KTB's says ready out loud with a reason", () => {
  const tpl = readFileSync(TEMPLATE_CHARTER, "utf8");
  expect(/triage:\s*\{\s*default:\s*needs-info\s*\}/.test(tpl)).toBe(true);
  expect(tpl).toMatch(/charter\.triage-default-unset/);               // 지우면 FAIL이라는 사실이 주석에 있다
  const ktb = readFileSync(REPO_CHARTER, "utf8");
  expect(/triage:\s*\{\s*default:\s*ready\s*\}/.test(ktb).valueOf()).toBe(true);
  expect(ktb).toMatch(/## triage 기본 판정/);                          // 이유가 본문에 적혀 있다
});

test("the triage prompt reads the charter default and never invents `ready`", () => {
  const md = readFileSync(TRIAGE_AGENT, "utf8");
  expect(md).toMatch(/triage\.default/);
  expect(md).toMatch(/loaded\.triage\.default/);
  expect(md).toMatch(/\[ready\]/);                                    // 이슈가 직접 들고 오는 예외 표식
  expect(md).toMatch(/NEVER_AUTOMATE.*→\s*`wont-do`/);
  expect(md).toMatch(/done_when.*→\s*`needs-info`/);
});

test("triage context carries the charter's triage default and never-automate globs into loaded.json", async () => {
  const r = mkdtempSync(join(tmpdir(), "ctx-triage-"));
  mkdirSync(join(r, ".factory"), { recursive: true });
  mkdirSync(join(r, "docs/factory"), { recursive: true });
  writeFileSync(join(r, ".factory/harness.toml"), `schema = 1\n[harness]\nmaturity = "M0"\n[factory]\norchestration = "workflow"\n[commands]\nunit = "npm test"\n[gates]\nrequired = ["unit"]\nfast = ["unit"]\nfull = ["unit"]\ndeep = ["unit"]\n`);
  writeFileSync(join(r, "docs/factory/CHARTER.md"), `---\nschema: factory.charter.v1\nstatus: ready\ntier_default: standard\ntriage: { default: needs-info }\nroster:\n  standard: [correctness]\n---\n## NEVER_AUTOMATE\n- \`billing/**\`\n`);
  writeFileSync(join(r, ".factory/roles.toml"), `[triage]\nagent = ".claude/agents/factory-triage.md"\nmodel = "sonnet"\n[review.correctness]\nagent = ".claude/agents/reviewer-correctness.md"\nmodel = "opus"\n`);
  const gh = { issue: vi.fn(async () => ({ number: 4, title: "T", body: "", labels: ["factory:queue"] })), comments: vi.fn(async () => []) };
  const ctx = await buildContext({ root: r, gh, issue: 4, stage: "triage" });
  expect(ctx.triage).toEqual({ default: "needs-info", never_automate: ["billing/**"] });
  expect(JSON.parse(readFileSync(join(r, ".factory/out/loaded.json"), "utf8")).triage).toEqual({ default: "needs-info", never_automate: ["billing/**"] });
});

// --- 감사 M1 (b): 글롭으로 적을 수 있는 NEVER_AUTOMATE 항목은 스크립트가 다시 센다 ---

test("neverAutomateHits matches the issue's impact paths against the charter globs", () => {
  const globs = ["auth/**", "billing/**", ".env*"];
  expect(neverAutomateHits(["src/app.js", "auth/session.js"], globs)).toEqual([{ path: "auth/session.js", glob: "auth/**" }]);
  expect(neverAutomateHits(["src/app.js"], globs)).toEqual([]);
  expect(neverAutomateHits(null, globs)).toEqual([]);
  expect(neverAutomateHits(["auth/x.js"], [])).toEqual([]);
});

test("verifyStage forces wont-do when an impact path hits a NEVER_AUTOMATE glob, whatever the agent said", () => {
  const out = { is_error: false, result: JSON.stringify({ schema: "factory.triage.v1", issue: 9, disposition: "ready", tier: "standard", impact_paths: ["billing/invoice.js"], reason: "small" }) };
  const v = verifyStage({ stage: "triage", out, agentsLog: { completed: [] }, neverAutomate: ["billing/**"] });
  expect(v.ok).toBe(true);
  expect(v.data.disposition).toBe("wont-do");
  expect(v.data.never_automate_hit).toEqual([{ path: "billing/invoice.js", glob: "billing/**" }]);
  expect(v.data.reason).toMatch(/NEVER_AUTOMATE/);
});

test("verifyStage leaves a clean triage verdict alone", () => {
  const out = { is_error: false, result: JSON.stringify({ schema: "factory.triage.v1", issue: 9, disposition: "ready", tier: "standard", impact_paths: ["src/app.js"] }) };
  const v = verifyStage({ stage: "triage", out, agentsLog: { completed: [] }, neverAutomate: ["billing/**"] });
  expect(v.data.disposition).toBe("ready");
  expect(v.data.never_automate_hit).toBeUndefined();
});

// ── #20 (#18의 harness 후속) — 사람 머지 문(門)에 대해 CHARTER가 말하는 것과 그 문이 실제로 하는 것 ──
//
// docs/factory/CHARTER.md의 "머지 권한 — 사람 게이트" 절은 sweeper의 needs-human → factory:merged
// 전이를 두고 "그 전이도 자동 머지와 똑같은 증거 검사를 지나므로"라고 적어 두었다. KTB-46이 들어간
// 뒤로 그것은 사실이 아니다: 그 문은 **두 검사를 다시 계산하지 않는다** — ① `factory/records` run
// 기록과의 리뷰 provenance 대조(자동 머지의 §(6b)), ② 그 기록의 `qa_manifest=` 다이제스트 재대조.
// sweep 잡에 records 브랜치 체크아웃이 없어서이고, KTB-48이 둘 다 덮는다.
// templates/factory/docs/factory/CHARTER.md:82-91이 이미 그 문장을 정확히 들고 있다(채택 저장소용).
// 아래 두 테스트는 그 문장을 **두 방향**으로 묶는다: 문서가 그것을 말하는가, 그리고 코드가 여전히
// 그러한가. 둘 중 하나가 어긋나면 어느 쪽이 낡았는지를 이름이 말한다.

/** CHARTER 본문에서 사람 머지 절만 떼어 낸다 — 다른 절의 "자동 머지" 언급에 걸리지 않게. */
function humanMergeSection(md) {
  // `$`는 쓰지 않는다 — `m` 플래그 아래에서는 **줄 끝**이라 첫 줄에서 끊긴다(#20 구현 중 실제로 그랬다).
  const m = /^##[^\n]*사람 게이트[^\n]*\n([\s\S]*?)(?=\n##\s|(?![\s\S]))/m.exec(md);
  return m ? m[1] : "";
}

/** 사람이 CHARTER에 적용해야 하는 문장의 내용(templates/factory/docs/factory/CHARTER.md:82-91). */
const THE_TWO_GAPS = [
  "① `factory/records` run 기록과의 리뷰 provenance 대조(자동 머지의 §(6b))",
  "② 그 기록의 `qa_manifest=` 다이제스트 재대조 — sweep 잡에 records 브랜치 체크아웃이 없어서이고,",
  "KTB-48이 둘 다 덮습니다. 그 둘을 뺀 나머지는 자동 머지와 같습니다.",
].join("\n");

test("test_20_charter_human_merge_names_the_two_gaps", () => {
  const section = humanMergeSection(readFileSync(REPO_CHARTER, "utf8"));
  expect(section, "docs/factory/CHARTER.md에서 사람 머지 절(`## 머지 권한 — 사람 게이트 …`)을 찾지 못했다").not.toBe("");

  // ① 더 이상 "그 전이도 자동 머지와 똑같은 증거 검사를 지난다"를 가르치지 않는다.
  //    (줄바꿈으로 끊겨 있어도 잡히게 `\s*`로 잇는다.)
  expect(
    /똑같은\s*증거\s*검사/.test(section),
    `docs/factory/CHARTER.md의 사람 머지 절이 아직 "자동 머지와 똑같은 증거 검사"를 주장한다. KTB-46 이후 거짓이다.\n적용할 문장:\n${THE_TWO_GAPS}`,
  ).toBe(false);

  // ② 대신 **다시 계산하지 않는 검사 둘**을 이름으로 말한다.
  for (const [what, re] of [
    ["다시 계산하지 않는 검사가 있다는 사실", /다시\s*계산하지\s*않는/],
    ["① records 브랜치의 run 기록", /factory\/records/],
    ["① 리뷰 provenance 대조", /provenance/],
    ["② qa_manifest 다이제스트", /qa_manifest/],
    ["둘 다 덮는 티켓(KTB-48)", /KTB-48/],
  ]) {
    expect(
      re.test(section),
      `docs/factory/CHARTER.md의 사람 머지 절이 ${what}을(를) 말하지 않는다 — 지우기만 해서는 독자에게 구멍이 남는다.\n적용할 문장:\n${THE_TWO_GAPS}`,
    ).toBe(true);
  }

  // ③ 그래도 바뀌지 않는 사실: 리뷰를 거치지 않은 PR을 머지하면 이슈는 needs-human에 그대로 남는다.
  expect(/리뷰를\s*거치지\s*않은\s*PR/.test(section)).toBe(true);
  expect(/needs-human/.test(section)).toBe(true);
});

test("test_20_human_merge_door_still_skips_the_two_the_charter_names", async () => {
  const head = "c".repeat(40);
  const ISSUE = 20;
  const stale = "docs/factory/CHARTER.md의 사람 머지 절이 낡았다 — 그 문이 이제 이 검사를 다시 계산한다(KTB-48?). 문서를 고쳐라.";
  const v = (role) => ({ role, verdict: "approve", confidence: "high", must_fix: [], should_fix: [], verified: [] });
  const review = {
    schema: "factory.review.v1", issue: ISSUE, pr: 21, head_sha: head, round: 1,
    verdicts: [v("correctness"), v("qa")], orchestration: "workflow", guarantee: "verified", tier_effective: "standard",
  };
  const reviewHandoff = { id: 3, createdAt: "2026-09-11T00:25:00Z", body: renderHandoff({ stage: "review", issue: ISSUE, summary: "s", data: review }) };
  const posted = [];
  const history = [
    { id: 1, createdAt: "2026-09-11T00:20:00Z", body: "<!-- factory-transition:v1 from=factory:awaiting-review to=factory:approved by=script -->\nfactory:awaiting-review → factory:approved" },
    reviewHandoff,
    { id: 2, createdAt: "2026-09-11T00:30:00Z", body: "<!-- factory-transition:v1 from=factory:approved to=factory:needs-human by=script -->\nfactory:approved → factory:needs-human — protected paths changed — human merge required: docs/factory/CHARTER.md (see PR #21)" },
  ];
  const gh = {
    searchIssues: async (label, opts) => (label === "factory:needs-human" && opts?.state === "all" ? [{ number: ISSUE, updatedAt: "2026-09-11T00:30:00Z" }] : []),
    comments: async () => [...history, ...posted],
    comment: async (n, body) => { posted.push({ id: 90 + posted.length, createdAt: "2026-09-11T01:00:00Z", body }); return "u"; },
    patchComment: async () => {}, issueList: async () => [],
    mergedPrForBranch: async () => 21,
    prMergeInfo: async () => ({ headSha: head, mergeSha: "d".repeat(40), mergedAt: "2026-09-11T00:45:00Z", mergedBy: "a-person" }),
    commitStatuses: async () => [
      { context: "factory/review", state: "success", creatorLogin: "ktb-bot" },
      { context: "factory/gates", state: "success", creatorLogin: "ktb-bot" },
    ],
    prChecks: async () => [
      { name: "factory/gates", state: "SUCCESS", bucket: "pass" },
      { name: "factory/review", state: "SUCCESS", bucket: "pass" },
      { name: "factory/integrity", state: "SUCCESS", bucket: "pass" },
    ],
    issueState: async () => ({ number: ISSUE, state: "OPEN", closedAt: null }),
    closeIssue: async () => {},
  };
  const seen = [];
  await sweep({
    gh, charter: { limits: { K: 3, M: 3, R: 2 }, back_pressure: { awaiting_review_max: 4 } },
    thresholds: { quarantine_max: 5, quarantine_ttl_days: 28, quarantine_return_after: 30 },
    now: "2026-09-11T01:00:00Z", staleMinutes: 30,
    transition: async (args) => { seen.push(args); return { ok: true, to: args.to }; },
    release: async () => true, quarantine: { quarantined: [] }, saveQuarantine: () => {},
    factoryLogins: async () => ({ ok: true, logins: ["ktb-bot"] }),
    reviewRoster: async () => ({ ok: true, roles: ["correctness", "qa"], tier: "standard" }),
    requiredChecks: ["factory/gates", "factory/review", "factory/integrity"],
  });

  const door = seen.find((t) => t.to === "factory:merged");
  expect(door, "사람 머지 반영 팔이 전이를 부르지 않았다 — 이 테스트는 그 문을 재고 있으므로 먼저 그 문이 열려야 한다").toBeTruthy();
  const ctx = door.ctxExtra;

  // 전제: qa 증거 규칙은 로스터에 `qa`가 있을 때만 발화한다. 이 로스터에는 있다 — 곧 아래 통과는
  // "규칙이 꺼져 있어서"가 아니라 이 문이 그 검사를 **면제하기 때문**이다.
  expect(ctx.roster).toContain("qa");

  // ① records 브랜치 provenance도, qa_manifest 다이제스트도 이 문의 재료에 들어 있지 않다.
  for (const k of Object.keys(ctx)) {
    expect(/records|provenance|qaManifest|qaEvidence|digest/i.test(k), `${stale} (ctxExtra.${k})`).toBe(false);
  }

  // ② 그 둘이 없는 채로도 이 문은 열린다 — CHARTER가 말하는 "다시 계산하지 않는 검사 둘"이 이것이다.
  const decided = requirementFor("factory:merged")({ comments: [reviewHandoff], ...ctx });
  expect(decided.ok, `${stale} (${decided.reason || ""})`).toBe(true);

  // ③ 그리고 그것은 **예외**이지 검사의 부재가 아니다: 같은 증거를 자동 머지 문에 대면 다이제스트를 요구한다.
  const auto = requirementFor("factory:merged")({
    comments: [reviewHandoff],
    issue: ISSUE, prHeadSha: head, roster: ctx.roster, rosterSize: ctx.rosterSize, maxRounds: ctx.maxRounds,
    gatesChecked: true, gatesFile: { status: "GREEN", head_sha: head }, checksGreen: true, integrityGreen: true,
  });
  expect(auto.ok, "자동 머지 문이 qa_manifest 다이제스트를 더 이상 요구하지 않는다 — 그러면 CHARTER의 '둘을 뺀 나머지는 자동 머지와 같다'도 뜻이 달라진다").toBe(false);
  expect(auto.reason).toBe(QA_EVIDENCE_NOT_BOUND);
});
