import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse as toml } from "smol-toml";
import { matchesAny, globToRegex } from "../lib/glob.js";
import { renderCiSettings } from "../cli/install.js";
import { FACTORY_ENUM } from "../lib/protected-paths.js";

/**
 * ── KTB-40 — CI deny가 `.factory/out/qa`를 **그림자 지운다** ───────────────────────────────────
 *
 * KTB-36은 L2의 통짜 `Edit/Write(.factory/**)`를 열거로 바꿔 qa의 증거 디렉터리를 비웠다. 그 열거에
 * 남은 `.factory/out/*`는 **우리 매처**(`lib/glob.js`)에서 직계 자식만 문다 — 그래서 KTB-36의 테스트는
 * 초록이었다. 그런데 라이브 KTB #3 리뷰 R2(run 34840944244)에서 qa 리뷰어의 Bash는 9번 거절당했다:
 *
 *   Permission to use Bash with command mkdir -p .factory/out/qa/ has been denied
 *   Permission to use Bash with command printf 'hello\n' > .factory/out/qa/test1.log ... denied
 *   Permission to use Bash with command node /tmp/qa3_repro.mjs > .../.factory/out/qa/3-repro-fix-after.log ... denied
 *
 * 거절한 것은 훅이 아니라 **Claude Code의 권한 계층**이었다. 즉 Claude Code의 글롭 매처는 우리가 가정한
 * 의미로 읽지 않는다: `.factory/out/*`가 중첩 경로/`mkdir`의 대상 디렉터리까지 문다. 우리 매처 하나로만
 * 검사하면 이 고장은 **영원히 보이지 않는다** — 그래서 이 파일은 두 매처로 같은 질문을 한다.
 *
 * 고침: `.factory/out/*`를 **qa의 증거와 접미사가 겹치지 않는 파일 패턴들**로 편다 —
 * `*.json`·`*.jsonl`·`*.pids`, 즉 `.factory/out/` 직계에 실제로 쓰이는 전부다. 확장자가 없는
 * `.factory/out/qa`는 어떤 읽기에서도 이 중 무엇과도 맞지 않는다. `.log`·`.md`·`.txt`는 **일부러**
 * 뺐다: 관대한 읽기에서 `.factory/out/*.log`는 `.factory/out/qa/a/b.log`를 물고, qa의 증거가 정확히
 * 그 확장자들이다(= 카브아웃이 다시 지워진다). 그리고 ci-settings에 `permissions.allow`로 카브아웃을 **적극적으로 말한다** —
 * Claude Code에서 deny가 allow를 이기므로 allow만으로는 부족하지만(그래서 deny도 좁혔다), 선언이
 * 없으면 `--permission-mode dontAsk`에서 allow에 없는 도구 호출은 **묻지 않고 거절**된다.
 */

const T = new URL("../../templates/factory/", import.meta.url).pathname;
const readRaw = (p) => readFileSync(T + p, "utf8");
const TEMPLATE_PROTECTED = toml(readRaw("factory/harness.toml")).protected;
const CI_FILES = ["factory/ci-settings.json", "factory/ci-settings-harness.json"];
const ci = (p) => JSON.parse(renderCiSettings(readRaw(p), TEMPLATE_PROTECTED, { harnessMode: p.includes("harness") }));
const denyGlobs = (p, tool) =>
  ci(p).permissions.deny.map((d) => new RegExp(`^${tool}\\((.+)\\)$`).exec(d)?.[1]).filter(Boolean);

/**
 * **두 번째 매처** — Claude Code의 관대한 읽기를 모델한다: `*`가 `/`를 넘는다. 실제 매처를 우리가
 * 볼 수 없으므로, 관측된 거절(`mkdir -p .factory/out/qa/`가 `.factory/out/*`에 걸렸다)이 성립하는
 * 가장 단순한 의미를 고른다. 두 읽기 **모두**에서 qa가 열려 있어야 고침이 실제로 고침이다.
 */
const permissiveRegex = (glob) => new RegExp("^" + glob.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*") + "$");
const permissiveAny = (globs, file) => globs.some((g) => permissiveRegex(g).test(file));

/** Claude Code가 `mkdir -p X`에서 볼 수 있는 대상 표기들 — 어느 것도 deny에 걸리면 안 된다. */
const QA_TARGETS = [
  ".factory/out/qa", ".factory/out/qa/", "./.factory/out/qa", "./.factory/out/qa/",
  ".factory/out/qa/x.png", ".factory/out/qa/a/b.log",
  ".factory/out/qa/3-repro-fix-after.log", ".factory/out/qa/test1.log",
  // qa가 실제로 남기는 나머지 확장자들 — 이것들이 걸리면 열거가 다시 카브아웃을 지운 것이다.
  ".factory/out/qa/7.md", ".factory/out/qa/notes.txt", ".factory/out/qa/7.ipynb", ".factory/out/qa/deep/3.log",
];

/** 열거가 계속 막아야 하는 `.factory/out/` **직계 파일**들 — run-stage/gates/progress/러너가 쓴다. */
const OUT_TOP_LEVEL = [
  ".factory/out/gates.json", ".factory/out/gates.diagnostic.json", ".factory/out/context.json",
  ".factory/out/context.qa.json", ".factory/out/loaded.json", ".factory/out/unit.json",
  ".factory/out/triage.envelope.json", ".factory/out/retro.json", ".factory/out/retro-candidates.json",
  ".factory/out/e2e.json", ".factory/out/integration.json", ".factory/out/scratch.json",
  ".factory/out/agents.jsonl", ".factory/out/test-env.pids",
];

test("KTB-40: no ci-settings deny pattern touches .factory/out/qa — under our matcher AND a permissive `*` reading", () => {
  for (const f of CI_FILES) {
    for (const tool of ["Edit", "Write"]) {
      const globs = denyGlobs(f, tool);
      for (const p of QA_TARGETS) {
        expect(matchesAny(globs, p), `${f} ${tool} strict ${p}`).toBe(false);
        expect(permissiveAny(globs, p), `${f} ${tool} permissive ${p}`).toBe(false);
      }
    }
  }
});

test("KTB-40: FACTORY_ENUM itself has no pattern that can reach .factory/out/qa under either reading", () => {
  for (const p of QA_TARGETS) {
    expect(matchesAny([...FACTORY_ENUM], p), `strict ${p}`).toBe(false);
    expect(permissiveAny([...FACTORY_ENUM], p), `permissive ${p}`).toBe(false);
  }
  // 그리고 `.factory/out/*` 자체는 더 이상 목록에 없다 — 그 패턴 하나가 이 고장의 원인이었다.
  expect(FACTORY_ENUM).not.toContain(".factory/out/*");
});

test("KTB-40: every previously-denied top-level .factory/out file is still denied in both variants", () => {
  for (const f of CI_FILES) {
    for (const tool of ["Edit", "Write"]) {
      const globs = denyGlobs(f, tool);
      for (const p of OUT_TOP_LEVEL) expect(matchesAny(globs, p), `${f} ${tool} ${p}`).toBe(true);
    }
    // 그리고 qa가 아닌 하위 디렉터리는 그대로 `**`로 막힌다.
    for (const tool of ["Edit", "Write"]) {
      const globs = denyGlobs(f, tool);
      for (const p of [".factory/out/coverage/coverage-final.json", ".factory/out/prove-wt/src/a.js", ".factory/out/classify-wt/src/a.js"]) {
        expect(matchesAny(globs, p), `${f} ${tool} ${p}`).toBe(true);
      }
    }
  }
});

/**
 * allow는 **선언**이다 — Claude Code에서 deny가 allow를 이기므로 이 배열이 카브아웃을 만들어 주지는
 * 않는다(그래서 deny도 좁혔다). 그러나 `--permission-mode dontAsk`에서 allow에 없는 호출은 묻지 않고
 * 거절되므로, qa가 실제로 쓰려면 이 줄들이 **있어야 한다**(ADR-019: allow는 `.claude/settings.json`에
 * 살지만 CI 세션은 `--settings .factory/ci-settings.json`도 함께 읽는다).
 */
test("KTB-40: both ci-settings state the qa carve-out positively in permissions.allow", () => {
  for (const f of CI_FILES) {
    const allow = new Set(ci(f).permissions.allow || []);
    for (const a of ["Write(.factory/out/qa/**)", "Edit(.factory/out/qa/**)",
      "Bash(mkdir -p .factory/out/qa*)", "Bash(mkdir -p ./.factory/out/qa*)"]) {
      expect(allow.has(a), `${f} allow ${a}`).toBe(true);
    }
  }
});

test("KTB-40: the out enumeration is literally identical in both variants", () => {
  const outOf = (f) => denyGlobs(f, "Edit").filter((g) => g.startsWith(".factory/out/"));
  expect(outOf(CI_FILES[0])).toEqual(outOf(CI_FILES[1]));
  expect(outOf(CI_FILES[0]).length).toBeGreaterThan(3);
});

// 우리 매처의 계약 자체는 그대로다 — 이 고침은 "우리가 틀렸다"가 아니라 "소비자가 다르게 읽는다"이다.
test("KTB-40: globToRegex still says `*` stops at a slash (the assumption that was not portable)", () => {
  expect(globToRegex(".factory/out/*").test(".factory/out/gates.json")).toBe(true);
  expect(globToRegex(".factory/out/*").test(".factory/out/qa/x.png")).toBe(false);
  expect(permissiveRegex(".factory/out/*").test(".factory/out/qa/x.png")).toBe(true);
});
