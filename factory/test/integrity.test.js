import { test, expect } from "vitest";
import { integrityCheck, protectedPaths, policyViolations } from "../lib/integrity.js";
import { makeFakeRun } from "../lib/exec.js";

const harness = { protected: { factory: [".factory/**", ".claude/**", "docs/factory/CHARTER.md"], except: [".factory/lessons/**", "docs/factory/runs/**"], additive_only: { ".claude/agents/*.md": ["## Examples", "## Perspectives"] } }, test: { test_glob: ["test/**/*.test.js"] } };
const names = (s) => ({ match: (c, a) => a[0] === "diff" && a.includes("--name-status"), result: { code: 0, stdout: s, stderr: "" } });
const u0 = (s) => ({ match: (c, a) => a[0] === "diff" && a.includes("-U0"), result: { code: 0, stdout: s, stderr: "" } });

// ── KTB-5: L0(integrity 체크) = 변조만. 보호 경로 변경은 위반이 아니라 **보고**다 ──────────
// (사람이 머지해야 한다는 신호일 뿐 — 그 신호가 체크를 RED로 만들면 사람도 머지할 수 없다)

test("KTB-5: protected file change → ok:true, violations 비어 있고 protected에 실린다; except path는 아예 안 실린다", async () => {
  const run = makeFakeRun([names("M\t.factory/harness.toml\nM\t.factory/lessons/reviewer-qa.md\nM\tsrc/a.js\n"), u0("")]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "<!-- factory-lessons:v1 role=reviewer-qa max=30 -->\n- [L-2026-09-01-01] x\n  근거: runs/1.md\n" });
  expect(r.ok).toBe(true);
  expect(r.violations).toEqual([]);
  expect(r.protected).toEqual([".factory/harness.toml"]);
});

test("KTB-5: 변조가 함께 있으면 ok:false — protected 목록은 그래도 채워진다(두 관심사가 독립적이다)", async () => {
  const run = makeFakeRun([names("M\t.factory/harness.toml\nM\ttest/a.test.js\n"), u0(`+++ b/test/a.test.js\n@@ -1,0 +2,1 @@\n+test.skip("x", () => {});\n`)]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "" });
  expect(r.ok).toBe(false);
  expect(r.violations).toEqual([{ file: "test/a.test.js", rule: "test skip/ignore pragma added" }]);
  expect(r.protected).toEqual([".factory/harness.toml"]);
});

test("KTB-5: additive_only 규칙이 보는 파일은 protected 목록에 넣지 않는다 — 그 파일의 판정은 additive-only 규칙이 한다", async () => {
  const examplesFixture = ["## Purpose", "## Lens", "## Examples", ...Array(37).fill(""), "### 좋은 발견", "- DST 25시간", "## Perspectives"].join("\n") + "\n";
  const okDiff = `+++ b/.claude/agents/reviewer-qa.md\n@@ -40,0 +41,2 @@\n+### 좋은 발견\n+- DST 25시간\n`;
  const run = makeFakeRun([names("M\t.claude/agents/reviewer-qa.md\n"), u0(okDiff)]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => examplesFixture });
  expect(r.ok).toBe(true);
  expect(r.protected).toEqual([]);
});

test("KTB-5: 판정 불가도 protected/policy를 [] 로 싣는다 — 호출자가 undefined.length로 터지지 않게", async () => {
  const r = await integrityCheck({ run: makeFakeRun([]), cwd: "/repo", base: "", head: "h", harness, readFile: () => "" });
  expect(r.ok).toBe(false);
  expect(r.protected).toEqual([]);
  expect(r.policy).toEqual([]);
});

test("KTB-6: 변조는 여전히 ok:false — policy와 함께 있어도 서로를 가리지 않는다", async () => {
  const run = makeFakeRun([
    names("M\t.claude/agents/reviewer-qa.md\nM\ttest/a.test.js\n"),
    u0(`+++ b/.claude/agents/reviewer-qa.md\n@@ -10,1 +10,1 @@\n-old lens\n+new lens\n+++ b/test/a.test.js\n@@ -1,0 +2,1 @@\n+test.skip("x", () => {});\n`),
  ]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "## Lens\nnew lens\n## Examples\n" });
  expect(r.ok).toBe(false);
  expect(r.violations).toEqual([{ file: "test/a.test.js", rule: "test skip/ignore pragma added" }]);
  expect(r.policy.some((v) => /additive-only/.test(v.rule))).toBe(true);
});

// ── KTB-6: policyViolations() — L1이 쓰는 섹션 정책 계산 ────────────────────────────
// merge 스테이지는 PR head를 체크아웃한 트리 위에서 돈다. 섹션 판정에는 파일 내용이 필요한데,
// **워킹 트리를 읽으면 PR이 판정 재료를 고를 수 있다** — 그래서 `git show <rev>:<file>`로만 읽는다.

const AGENT = ".claude/agents/reviewer-qa.md";
const show = (rev, text) => ({ match: (c, a) => a[0] === "show" && a[1] === `${rev}:${AGENT}`, result: { code: 0, stdout: text, stderr: "" } });
const fileU0 = (text) => ({ match: (c, a) => a[0] === "diff" && a.includes("-U0"), result: { code: 0, stdout: text, stderr: "" } });

test("KTB-6 policyViolations: an addition inside ## Examples is allowed → files []", async () => {
  const headText = ["## Purpose", "## Lens", "## Examples", ...Array(37).fill(""), "### 좋은 발견", "- DST 25시간", "## Perspectives"].join("\n") + "\n";
  const run = makeFakeRun([names(`M\t${AGENT}\n`), fileU0(`+++ b/${AGENT}\n@@ -40,0 +41,2 @@\n+### 좋은 발견\n+- DST 25시간\n`), show("h", headText)]);
  const r = await policyViolations({ run, cwd: "/repo", base: "b", head: "h", harness });
  expect(r).toMatchObject({ ok: true, files: [] });
  expect(r.violations).toEqual([]);
});

test("KTB-6 policyViolations: an edit outside the allowed sections → files lists the agent file", async () => {
  const run = makeFakeRun([names(`M\t${AGENT}\n`), fileU0(`+++ b/${AGENT}\n@@ -10,1 +10,1 @@\n-old lens\n+new lens\n`), show("h", "## Lens\nnew lens\n## Examples\n")]);
  const r = await policyViolations({ run, cwd: "/repo", base: "b", head: "h", harness });
  expect(r.ok).toBe(true);
  expect(r.files).toEqual([AGENT]);
  expect(r.violations[0].rule).toMatch(/additive-only/);
});

test("KTB-6 policyViolations: reads file content ONLY via git show — never the working tree", async () => {
  const run = makeFakeRun([names(`M\t${AGENT}\n`), fileU0(`+++ b/${AGENT}\n@@ -10,1 +10,1 @@\n-x\n+y\n`), show("h", "## Lens\ny\n")]);
  await policyViolations({ run, cwd: "/repo", base: "b", head: "h", harness });
  const shows = run.calls.filter((c) => c.args[0] === "show");
  expect(shows.length).toBeGreaterThan(0);
  for (const c of shows) expect(c.args[1]).toMatch(/^(b|h):/);        // 언제나 <rev>:<path> — 워킹 트리 경로가 아니다
  for (const c of run.calls) expect(c.cmd).toBe("git");              // 파일 시스템 접근이 아예 없다
});

test("KTB-6 policyViolations: only additive_only files are diffed — a plain source change costs no git show", async () => {
  const run = makeFakeRun([names("M\tsrc/a.js\nM\t.factory/harness.toml\n")]);
  const r = await policyViolations({ run, cwd: "/repo", base: "b", head: "h", harness });
  expect(r).toMatchObject({ ok: true, files: [] });
  expect(run.calls).toHaveLength(1);                                  // name-status 한 번뿐
});

test("KTB-6 policyViolations: base 없음 / git 실패는 ok:false — 빈 목록을 '정책 위반 없음'으로 읽지 않는다", async () => {
  const empty = await policyViolations({ run: makeFakeRun([]), cwd: "/repo", base: "", head: "h", harness });
  expect(empty).toMatchObject({ ok: false, files: [] });
  expect(empty.reason).toMatch(/base is empty/);
  const boomNs = makeFakeRun([{ match: (c, a) => a[0] === "diff" && a.includes("--name-status"), result: { code: 128, stdout: "", stderr: "fatal" } }]);
  expect(await policyViolations({ run: boomNs, cwd: "/repo", base: "b", head: "h", harness })).toMatchObject({ ok: false, files: [] });
  const boomDiff = makeFakeRun([names(`M\t${AGENT}\n`), { match: (c, a) => a[0] === "diff" && a.includes("-U0"), result: { code: 128, stdout: "", stderr: "fatal" } }]);
  const r = await policyViolations({ run: boomDiff, cwd: "/repo", base: "b", head: "h", harness });
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/exited 128/);
});

test("KTB-6 policyViolations: a deleted agent file is a policy violation, not a git-show failure", async () => {
  const run = makeFakeRun([
    names(`D\t${AGENT}\n`),
    fileU0(`--- a/${AGENT}\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-## Purpose\n-## Examples\n`),
    { match: (c, a) => a[0] === "show", result: { code: 128, stdout: "", stderr: "fatal: path does not exist" } },
  ]);
  const r = await policyViolations({ run, cwd: "/repo", base: "b", head: "h", harness });
  expect(r.ok).toBe(true);
  expect(r.files).toEqual([AGENT]);
});

// ── KTB-5: protectedPaths() — L1(merge 스테이지)이 쓰는 목록 전용 계산 ────────────────────
// 파일 내용을 **읽지 않는다**: merge는 PR head를 체크아웃한 트리 위에서 도는데, 그 트리의 파일을
// 읽어 판단하면 PR이 자기 판정 재료를 고를 수 있다. name-status diff만 본다.

test("KTB-5 protectedPaths: name-status만 보고 목록을 만든다 — -U0 diff도 파일 읽기도 하지 않는다", async () => {
  const run = makeFakeRun([names("M\t.factory/harness.toml\nM\tpackage.json\nM\t.factory/lessons/reviewer-qa.md\nA\tsrc/a.js\n")]);
  const h = { ...harness, protected: { ...harness.protected, factory: [...harness.protected.factory, "package.json"] } };
  const r = await protectedPaths({ run, cwd: "/repo", base: "b", head: "h", harness: h });
  expect(r).toEqual({ ok: true, files: [".factory/harness.toml", "package.json"] });
  expect(run.calls).toHaveLength(1);
  expect(run.calls[0].args).toEqual(["diff", "--no-renames", "--name-status", "b...h"]);
});

// ── fix round 1: rename/copy는 **출발지**가 보호 경로다 ─────────────────────────
// `R096\t<old>\t<new>` 줄에서 마지막 필드만 취하면, 보호 경로를 보호되지 않는 이름으로 옮기는
// diff가 검사를 통째로 빠져나간다 — 예: `.github/workflows/factory-integrity.yml` →
// `ci-integrity.yml`(잡 이름 그대로, 본문 무력화). 그 PR은 L0도(자기 워크플로), 변조 검사도,
// 보호 경로 검사도 통과해 자동 머지되고, required 체크 자신이 무력화된다.

const RENAMED = "R100\t.github/workflows/factory-integrity.yml\tci-integrity.yml\n";
const COPIED = "C075\tdocs/factory/CHARTER.md\tdocs/notes/charter-copy.md\n";
const WF_HARNESS = { ...harness, protected: { ...harness.protected, factory: [...harness.protected.factory, ".github/workflows/factory-*.yml"] } };

test("fix round 1 protectedPaths: rename 줄의 출발지가 보호 경로면 잡는다(R100)", async () => {
  const r = await protectedPaths({ run: makeFakeRun([names(RENAMED)]), cwd: "/repo", base: "b", head: "h", harness: WF_HARNESS });
  expect(r.files).toEqual([".github/workflows/factory-integrity.yml"]);
});

test("fix round 1 protectedPaths: copy 줄(C075)의 출발지도 센다 — 목적지만 보면 놓친다", async () => {
  const r = await protectedPaths({ run: makeFakeRun([names(COPIED)]), cwd: "/repo", base: "b", head: "h", harness });
  expect(r.files).toEqual(["docs/factory/CHARTER.md"]);
});

test("fix round 1 protectedPaths: --no-renames가 만드는 D+A 쌍도 출발지를 잡는다", async () => {
  const ns = "D\t.github/workflows/factory-integrity.yml\nA\tci-integrity.yml\n";
  const r = await protectedPaths({ run: makeFakeRun([names(ns)]), cwd: "/repo", base: "b", head: "h", harness: WF_HARNESS });
  expect(r.files).toEqual([".github/workflows/factory-integrity.yml"]);
});

test("fix round 1 integrityCheck: 같은 name-status도 --no-renames로 묻고, rename 출발지를 protected에 싣는다", async () => {
  const run = makeFakeRun([names(RENAMED), u0("")]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness: WF_HARNESS, readFile: () => "" });
  expect(run.calls[0].args).toEqual(["diff", "--no-renames", "--name-status", "b...h"]);
  expect(r.protected).toEqual([".github/workflows/factory-integrity.yml"]);
  expect(r.checked.files).toEqual([".github/workflows/factory-integrity.yml", "ci-integrity.yml"]);
});

test("fix round 1 integrityCheck: copy 줄의 출발지도 protected에 실린다", async () => {
  const run = makeFakeRun([names(COPIED), u0("")]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "" });
  expect(r.protected).toEqual(["docs/factory/CHARTER.md"]);
});

test("fix round 1: 같은 경로가 여러 줄에 나와도 한 번만 센다", async () => {
  const run = makeFakeRun([names("M\t.factory/harness.toml\nM\t.factory/harness.toml\n")]);
  const r = await protectedPaths({ run, cwd: "/repo", base: "b", head: "h", harness });
  expect(r.files).toEqual([".factory/harness.toml"]);
});

test("KTB-5 protectedPaths: 보호 경로가 없으면 빈 목록 — ok:true", async () => {
  const run = makeFakeRun([names("M\tsrc/a.js\nM\t.factory/lessons/reviewer-qa.md\n")]);
  const r = await protectedPaths({ run, cwd: "/repo", base: "b", head: "h", harness });
  expect(r).toEqual({ ok: true, files: [] });
});

test("KTB-5 protectedPaths: base가 없거나 git이 실패하면 ok:false — 빈 목록을 '보호 경로 없음'으로 읽지 않는다", async () => {
  const empty = await protectedPaths({ run: makeFakeRun([]), cwd: "/repo", base: "", head: "h", harness });
  expect(empty.ok).toBe(false);
  expect(empty.files).toEqual([]);
  expect(empty.reason).toMatch(/base is empty/);
  const boom = makeFakeRun([{ match: (c, a) => a[0] === "diff", result: { code: 128, stdout: "", stderr: "fatal: no merge base" } }]);
  const failed = await protectedPaths({ run: boom, cwd: "/repo", base: "b", head: "h", harness });
  expect(failed.ok).toBe(false);
  expect(failed.files).toEqual([]);
  expect(failed.reason).toMatch(/exited 128/);
});
// ── KTB-6: additive-only는 "누가 고쳐도 되는가"의 정책이지 커밋에 대한 사실이 아니다 ───────
// 그래서 L0의 violations(=ok)가 아니라 `policy` 배열로 보고되고, 자동 머지를 막는 집행은 L1이 한다.
// L0가 RED가 되면 required context가 그것 하나뿐이라 **사람도** 역할 프롬프트를 고칠 수 없다.

test("additive-only agent sections: additions in Examples ok; an edit elsewhere lands in policy, not violations", async () => {
  // 신규 파일 41~42번째 줄이 '## Examples' 아래에 오도록 채운 픽스처 (hunk: @@ -40,0 +41,2 @@)
  const examplesFixture = ["## Purpose", "## Lens", "## Examples", ...Array(37).fill(""), "### 좋은 발견", "- DST 25시간", "## Perspectives"].join("\n") + "\n";
  const okDiff = `+++ b/.claude/agents/reviewer-qa.md\n@@ -40,0 +41,2 @@\n+### 좋은 발견\n+- DST 25시간\n`;
  const run1 = makeFakeRun([names("M\t.claude/agents/reviewer-qa.md\n"), u0(okDiff)]);
  const r1 = await integrityCheck({ run: run1, cwd: "/repo", base: "b", head: "h", harness, readFile: () => examplesFixture, readFileAt: () => "## Purpose\n\n## Lens\n\n## Examples\n\n## Perspectives\n" });
  expect(r1.ok).toBe(true);
  expect(r1.policy).toEqual([]);
  const badDiff = `+++ b/.claude/agents/reviewer-qa.md\n@@ -10,1 +10,1 @@\n-old lens\n+new lens\n`;
  const run2 = makeFakeRun([names("M\t.claude/agents/reviewer-qa.md\n"), u0(badDiff)]);
  const r2 = await integrityCheck({ run: run2, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "## Lens\nnew lens\n## Examples\n", readFileAt: () => "## Lens\nold lens\n## Examples\n" });
  expect(r2.ok).toBe(true);                                    // KTB-6: 체크는 RED가 아니다 — 사람이 머지할 수 있어야 한다
  expect(r2.violations).toEqual([]);
  expect(r2.policy[0]).toMatchObject({ file: ".claude/agents/reviewer-qa.md", rule: expect.stringMatching(/additive-only/) });
});
test("additive-only is position-aware: added blank line under Lens is a policy finding even though a blank line also exists under Examples", async () => {
  const diff = `+++ b/.claude/agents/reviewer-qa.md\n@@ -2,0 +3,1 @@\n+\n`;
  const run = makeFakeRun([names("M\t.claude/agents/reviewer-qa.md\n"), u0(diff)]);
  const readFile = () => "## Purpose\n## Lens\n\n## Examples\n\n## Perspectives\n"; // line 3 (added) is the blank line under ## Lens
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile });
  expect(r.ok).toBe(true);
  expect(r.policy[0].rule).toMatch(/additive-only/);
});
test("additive-only: an added '## ' header cannot self-legitimize the disallowed content it follows", async () => {
  // base: Purpose / Lens / Examples / Perspectives. Under Lens (after line 2) inject two new
  // lines: "malicious" content, then a forged "## Examples" header — trying to make sectionAt
  // treat "malicious" as if it were inside the (already-allowed) Examples section.
  const readFile = () => "## Purpose\n## Lens\nmalicious\n## Examples\n## Examples\n## Perspectives\n";
  const diff = `+++ b/.claude/agents/reviewer-qa.md\n@@ -2,0 +3,2 @@\n+malicious\n+## Examples\n`;
  const run = makeFakeRun([names("M\t.claude/agents/reviewer-qa.md\n"), u0(diff)]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile });
  expect(r.ok).toBe(true);
  expect(r.policy.some((v) => v.rule === "additive-only: header added")).toBe(true);
  expect(r.policy.some((v) => /additive-only sections.*outside/.test(v.rule))).toBe(true);
});
test("full deletion of an additive-only file → policy finding (the file's own rule judges it, not the protected list)", async () => {
  const delDiff = `--- a/.claude/agents/reviewer-qa.md\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-## Purpose\n-## Examples\n-content\n`;
  const run = makeFakeRun([names("D\t.claude/agents/reviewer-qa.md\n"), u0(delDiff)]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => null });
  expect(r.ok).toBe(true);
  expect(r.policy.some((v) => /additive-only/.test(v.rule))).toBe(true);
});
test("skip/ignore pragmas added to tests → violation", async () => {
  const run = makeFakeRun([names("M\ttest/a.test.js\n"), u0(`+++ b/test/a.test.js\n@@ -1,0 +2,1 @@\n+test.skip("x", () => {});\n`)]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "" });
  expect(r.violations).toEqual([{ file: "test/a.test.js", rule: "test skip/ignore pragma added" }]);
});
// ── F1: 검사하지 못한 것은 통과가 아니다 ────────────────────────────────────

test("git diff가 실패하면 ok:false — 빈 diff를 '위반 없음'으로 읽지 않는다", async () => {
  const boom = { code: 128, stdout: "", stderr: "fatal: no merge base" };
  for (const table of [
    [{ match: (c, a) => a[0] === "diff" && a.includes("--name-status"), result: boom }],
    [names("M\tsrc/a.js\n"), { match: (c, a) => a[0] === "diff" && a.includes("-U0"), result: boom }],
  ]) {
    const r = await integrityCheck({ run: makeFakeRun(table), cwd: "/repo", base: "b", head: "h", harness, readFile: () => "" });
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([{ file: "-", rule: expect.stringContaining("integrity could not be computed") }]);
    expect(r.violations[0].rule).toMatch(/exited 128/);
  }
});

test("base가 비어 있으면 검사 자체가 성립하지 않는다 — git을 부르지도 않는다", async () => {
  for (const base of ["", null, undefined]) {
    const run = makeFakeRun([{ match: () => true, result: { code: 0, stdout: "", stderr: "" } }]);
    const r = await integrityCheck({ run, cwd: "/repo", base, head: "h", harness, readFile: () => "" });
    expect(r.ok, String(base)).toBe(false);
    expect(r.violations[0].rule).toMatch(/integrity could not be computed: base is empty/);
    expect(run.calls).toHaveLength(0);
  }
});

test("lessons format violation", async () => {
  const run = makeFakeRun([names("M\t.factory/lessons/reviewer-qa.md\n"), u0("")]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "<!-- factory-lessons:v1 role=reviewer-qa max=1 -->\n- [L-2026-09-01-01] a\n  근거: r\n- bad entry\n" });
  expect(r.ok).toBe(false); expect(r.violations.map((v) => v.rule)).toEqual(expect.arrayContaining([expect.stringMatching(/lessons/)]));
});
test("lessons per-entry 근거: 3 entries, 2 missing 근거 → 2 violations", async () => {
  const run = makeFakeRun([names("M\t.factory/lessons/reviewer-qa.md\n"), u0("")]);
  const text = "<!-- factory-lessons:v1 role=reviewer-qa max=10 -->\n- [L-2026-09-01-01] a\n  근거: r1\n- [L-2026-09-01-02] b\n- [L-2026-09-01-03] c\n";
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => text });
  const missing = r.violations.filter((v) => /missing 근거/.test(v.rule));
  expect(missing.length).toBe(2);
  expect(missing.map((v) => v.rule)).toEqual(expect.arrayContaining([
    expect.stringContaining("L-2026-09-01-02"),
    expect.stringContaining("L-2026-09-01-03"),
  ]));
});

// ── fix round 2 ───────────────────────────────────────────────────────────────
// N1: `-U0` diff에 `--no-renames`가 빠져 있으면 rename된 파일의 추가/삭제 줄이 **비어 있다**.
// additive_only 분기는 그 빈 집합으로 "위반 없음"을 만들고 `continue`하므로 isProtected에도
// 닿지 않는다 — 즉 `mv .claude/agents/reviewer-qa.md docs/x.md`가 L0 GREEN + protected 빈 목록으로
// 통과한다(리뷰어가 실측). 두 diff 모두 같은 플래그를 써야 한 줄의 두 경로가 같은 뜻을 갖는다.

const AGENT_PATH = ".claude/agents/reviewer-qa.md";
const RENAME_AGENT = `R100\t${AGENT_PATH}\tdocs/x.md\n`;
// --no-renames가 붙으면 같은 변경이 "전체 삭제 + 신규 추가"로 보인다
const RENAME_AGENT_U0 = `--- a/${AGENT_PATH}\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-## Purpose\n-## Examples\n-content\n--- /dev/null\n+++ b/docs/x.md\n@@ -0,0 +1,3 @@\n+## Purpose\n+## Examples\n+content\n`;

test("fix round 2 (N1): every -U0 diff is asked with --no-renames too", async () => {
  const run = makeFakeRun([names("M\tsrc/a.js\n"), u0("")]);
  await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "" });
  const u0call = run.calls.find((c) => c.args.includes("-U0"));
  expect(u0call.args).toEqual(["diff", "--no-renames", "-U0", "b...h"]);
});

test("fix round 2 (N1): renaming an additive_only file away → policy finding AND the source is protected", async () => {
  const run = makeFakeRun([names(RENAME_AGENT), u0(RENAME_AGENT_U0)]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => null });
  expect(r.policy.some((v) => v.file === AGENT_PATH && /additive-only/.test(v.rule))).toBe(true);
  // 삭제·이동은 "예시 추가"가 아니다 — additive_only 면제가 적용되지 않으므로 보호 목록에 들어간다
  expect(r.protected).toContain(AGENT_PATH);
});

test("fix round 2 (N1): renaming a protected non-additive file away → the source is protected", async () => {
  const ns = "R100\t.factory/harness.toml\tdocs/harness-old.toml\n";
  const run = makeFakeRun([names(ns), u0(`--- a/.factory/harness.toml\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-schema = 1\n`)]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => null });
  expect(r.ok).toBe(true);
  expect(r.protected).toContain(".factory/harness.toml");
});

test("fix round 2 (N1): policyViolations asks its per-file -U0 with --no-renames as well", async () => {
  const run = makeFakeRun([
    names(RENAME_AGENT),
    { match: (c, a) => a[0] === "diff" && a.includes("-U0"), result: { code: 0, stdout: RENAME_AGENT_U0, stderr: "" } },
    { match: (c, a) => a[0] === "show", result: { code: 128, stdout: "", stderr: "fatal" } },
  ]);
  const r = await policyViolations({ run, cwd: "/repo", base: "b", head: "h", harness });
  const u0call = run.calls.find((c) => c.args.includes("-U0"));
  expect(u0call.args).toEqual(["diff", "--no-renames", "-U0", "b...h", "--", AGENT_PATH]);
  expect(r.files).toEqual([AGENT_PATH]);
});

// N2: 모든 경로 필드를 세게 되면서, 삭제·이동된 lessons 파일의 **옛 경로**가 내용 규칙에 닿는다 —
// `readFile`이 null이니 `lessonsFormat("")`이 "lessons header missing"을 만들고 L0가 RED가 된다.
// 그러면 lessons 파일을 지우거나 옮기는 PR을 아무도 머지할 수 없다(KTB-5와 같은 계열의 오진).

const LESSONS = ".factory/lessons/reviewer-qa.md";

test("fix round 2 (N2): deleting a lessons file is not a false RED — content rules skip a deleted path", async () => {
  const run = makeFakeRun([names(`D\t${LESSONS}\n`), u0(`--- a/${LESSONS}\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-<!-- factory-lessons:v1 role=reviewer-qa max=30 -->\n`)]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => null });
  expect(r.ok).toBe(true);
  expect(r.violations).toEqual([]);
});

test("fix round 2 (N2): renaming a lessons file away is not a false RED either", async () => {
  const run = makeFakeRun([names(`R100\t${LESSONS}\tdocs/old-lessons.md\n`), u0(`--- a/${LESSONS}\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-<!-- factory-lessons:v1 role=reviewer-qa max=30 -->\n`)]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => null });
  expect(r.ok).toBe(true);
  expect(r.violations).toEqual([]);
});

test("fix round 2 (N2): a lessons file that still exists is judged as before — the skip is only for deleted paths", async () => {
  const run = makeFakeRun([names(`M\t${LESSONS}\n`), u0("")]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => "no header here\n" });
  expect(r.ok).toBe(false);
  expect(r.violations[0].rule).toMatch(/lessons header missing/);
});

test("fix round 2 (N2): a deleted protected path still counts as protected (only the content rules are skipped)", async () => {
  const run = makeFakeRun([names("D\t.factory/harness.toml\n"), u0(`--- a/.factory/harness.toml\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-schema = 1\n`)]);
  const r = await integrityCheck({ run, cwd: "/repo", base: "b", head: "h", harness, readFile: () => null });
  expect(r.ok).toBe(true);
  expect(r.protected).toEqual([".factory/harness.toml"]);
});

test("fix round 2 (N2): protectedPaths counts a deleted additive_only source too (the exemption is for live files)", async () => {
  const r = await protectedPaths({ run: makeFakeRun([names(RENAME_AGENT)]), cwd: "/repo", base: "b", head: "h", harness });
  expect(r.files).toContain(AGENT_PATH);
});

test("fix round 2 (N2): a live additive_only file is still exempt from the protected list (retro's dark path survives)", async () => {
  const r = await protectedPaths({ run: makeFakeRun([names(`M\t${AGENT_PATH}\n`)]), cwd: "/repo", base: "b", head: "h", harness });
  expect(r.files).toEqual([]);
});
