import { test, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  NON_JUDGE_GLOBS, NON_JUDGE_EXCLUDES, JUDGE_MODULES, isNonJudgePath, classifyProtected, relativeSpecifiers, importClosure,
} from "../lib/non-judge-paths.js";

/**
 * #178 (S4a-1) — 비판정 경로는 **양의 목록**이고(목록 밖은 전부 판정 경로), 판정 모듈의 정적 import 닫힘과 겹치지 않는다.
 * 닫힘은 고정 목록이 아니라 **이 저장소의 실제 파일**에서 센다.
 */
const ROOT = new URL("../../", import.meta.url).pathname;
const readRepo = (p) => {
  const abs = join(ROOT, p);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
};
/** 소스 경로와 그 설치 미러(`factory/x` → `.factory/x`) — 스테이지가 실제로 실행하는 것은 미러다. */
const withMirror = (f) => (f.startsWith("factory/") ? [f, `.${f}`] : [f]);
const E = { engine: true };

// ── dw1 ───────────────────────────────────────────────────────────────────────────────────────────

test("test_178_non_judge_is_a_positive_list", () => {
  // 목록 안의 파일만이면 judge가 비어 있다 — 문서, 리서치, 보드 페이지, 판정 닫힘 밖의 엔진 모듈과 그 미러·테스트.
  const inside = [
    "docs/research/x.md", "docs/factory/DECISIONS.md", "docs/factory/ops/watch-issue.sh",
    "templates/factory/docs/factory/board/index.html",
    "factory/lib/board-static.js", ".factory/lib/board-static.js", "factory/lib/status.js", ".factory/lib/status.js",
    "factory/test/board-page.test.js", "factory/test/status.test.js",
  ];
  expect(classifyProtected(inside, E)).toEqual({ non_judge: inside, judge: [] });

  // 목록 밖: 판정 모듈, 미지의 새 모듈, 저장소 루트 파일 — 전부 judge.
  const outside = ["factory/lib/merge-stage.js", "factory/lib/brand-new-module.js", "README.md", "bin/cli.js", ".github/workflows/x.yml"];
  expect(classifyProtected(outside, E)).toEqual({ non_judge: [], judge: outside });

  // 섞이면 **목록 밖의 그 파일만** judge로 간다.
  expect(classifyProtected(["docs/research/x.md", "factory/lib/gh.js", "factory/lib/status.js"], E))
    .toEqual({ non_judge: ["docs/research/x.md", "factory/lib/status.js"], judge: ["factory/lib/gh.js"] });

  // docs/** 안에서도 판정 경로인 셋: CHARTER(규칙), runs(러너가 쓰는 증거), 템플릿 CHARTER(#178 d1).
  for (const f of ["docs/factory/CHARTER.md", "docs/factory/runs/x.md", "templates/factory/docs/factory/CHARTER.md"]) {
    expect(classifyProtected([f], E), f).toEqual({ non_judge: [], judge: [f] });
  }
  // 세션 지시문(주입 채널)은 docs 아래에 있어도 judge다.
  for (const f of ["docs/CLAUDE.md", "docs/sub/AGENTS.md", "docs/x/.mcp.json", "templates/factory/docs/CLAUDE.local.md"]) {
    expect(classifyProtected([f], E), f).toEqual({ non_judge: [], judge: [f] });
  }

  // 판정 닫힘이 닿는 모듈(#178 d5) — 이슈 초안에는 있었지만 판정 모듈이 import하므로 judge다. 미러와 그 테스트도.
  for (const m of ["aggregate", "heartbeat", "progress", "usage", "board", "agents-log"]) {
    for (const f of [`factory/lib/${m}.js`, `.factory/lib/${m}.js`, `factory/test/${m}.test.js`]) {
      expect(classifyProtected([f], E), f).toEqual({ non_judge: [], judge: [f] });
    }
  }
  for (const f of ["factory/bin/scrub-artifacts.js", ".factory/bin/scrub-artifacts.js", "factory/test/scrub-artifacts.test.js"]) {
    expect(classifyProtected([f], E), f).toEqual({ non_judge: [], judge: [f] });
  }
  // 목록 자체를 담은 파일도 목록 밖이다(새 파일은 기본으로 judge).
  expect(classifyProtected(["factory/lib/non-judge-paths.js"], E).judge).toEqual(["factory/lib/non-judge-paths.js"]);

  // 경로 장난으로 목록에 들어올 수 없다.
  for (const f of ["./docs/x.md", "docs/../factory/lib/gh.js", "docs//x.md", "/docs/x.md", "docs/./x.md"]) {
    expect(classifyProtected([f], E), f).toEqual({ non_judge: [], judge: [f] });
  }

  // engine:false(채택자 저장소) — 목록 안의 파일조차 전부 judge. engine을 주지 않아도 같다.
  expect(classifyProtected(inside, { engine: false })).toEqual({ non_judge: [], judge: inside });
  expect(classifyProtected(inside)).toEqual({ non_judge: [], judge: inside });
});

test("test_178_non_judge_is_a_positive_list — a listed test file belongs to a listed module; tests of judge modules stay judge", () => {
  const testFiles = readdirSync(join(ROOT, "factory/test")).filter((f) => f.endsWith(".test.js")).map((f) => `factory/test/${f}`);
  expect(testFiles.length).toBeGreaterThan(50);
  const listedTests = testFiles.filter((f) => isNonJudgePath(f));
  expect(listedTests.sort()).toEqual(["factory/test/board-page.test.js", "factory/test/status.test.js"]);
  // 각 비판정 테스트는 비판정 모듈을 실제로 import한다(모듈과 함께 들어오고 함께 나간다 — d7).
  for (const t of listedTests) {
    const targets = relativeSpecifiers(readRepo(t)).map((s) => join("factory/test", s).replace(/\\/g, "/"));
    expect(targets.some((m) => m.startsWith("factory/lib/") && isNonJudgePath(m)), t).toBe(true);
  }
});

// ── dw3 ───────────────────────────────────────────────────────────────────────────────────────────

/** 이슈 #178 본문의 JUDGE_MODULES 그대로 — 닫힘의 시작점을 줄여서 테스트를 통과시킬 수 없다. */
const ISSUE_JUDGE_MODULES = [
  "factory/lib/merge-stage.js", "factory/lib/integrity.js", "factory/lib/gates.js", "factory/lib/requirements.js",
  "factory/lib/self-gate.js", "factory/lib/admission.js", "factory/lib/transition.js", "factory/lib/labels.js",
  "factory/lib/protected-paths.js", "factory/lib/review-quorum.js", "factory/lib/gh.js", "factory/lib/config.js",
  "factory/bin/run-stage.js",
];

test("test_178_judge_import_closure_excludes_non_judge", () => {
  expect([...JUDGE_MODULES].sort()).toEqual([...ISSUE_JUDGE_MODULES].sort());
  for (const m of JUDGE_MODULES) expect(existsSync(join(ROOT, m)), m).toBe(true);

  const { files, edges } = importClosure({ entries: JUDGE_MODULES, readFile: readRepo });
  const has = (from, to) => edges.some(([a, b]) => a === from && b === to);
  // 파서가 실제 간선을 찾는다 — `./`, `../lib`, `../bin` 모두.
  expect(has("factory/lib/review-quorum.js", "factory/lib/aggregate.js")).toBe(true);
  expect(has("factory/lib/gh.js", "factory/lib/heartbeat.js")).toBe(true);
  expect(has("factory/bin/run-stage.js", "factory/lib/board.js")).toBe(true);
  expect(has("factory/lib/gates.js", "factory/bin/scrub-artifacts.js")).toBe(true);
  // 재귀다: gh → heartbeat → progress → usage, 두 단계 너머까지.
  expect(has("factory/lib/progress.js", "factory/lib/usage.js")).toBe(true);
  expect(files.has("factory/lib/usage.js")).toBe(true);
  expect(files.size).toBeGreaterThan(40);

  // 닫힘의 모든 파일과 그 설치 미러 — 어느 것도 비판정 목록에 걸리지 않는다.
  const reached = [...files].flatMap(withMirror);
  expect(reached).toContain(".factory/lib/aggregate.js");
  expect(reached.filter((f) => isNonJudgePath(f))).toEqual([]);
});

test("test_178_judge_import_closure_excludes_non_judge — the parser follows import/export from and side-effect imports", () => {
  const src = [
    `import { a } from "./a.js";`,
    `import {\n  b,\n  c,\n} from '../lib/b.js';`,
    `export { d } from "../bin/d.js";`,
    `export * from "./e.js";`,
    `import * as ns from "./ns.js";`,
    `import "./side-effect.js";`,
    `import { readFileSync } from "node:fs";`,
    `import { parse } from "smol-toml";`,
  ].join("\n");
  expect(relativeSpecifiers(src).sort()).toEqual(["../bin/d.js", "../lib/b.js", "./a.js", "./e.js", "./ns.js", "./side-effect.js"].sort());

  // 합성 트리: `../` 간선과 `export … from`을 따라 재귀한다.
  const tree = {
    "factory/lib/judge.js": `import { x } from "../bin/tool.js";`,
    "factory/bin/tool.js": `export { y } from "../lib/deep.js";`,
    "factory/lib/deep.js": `export * from "./leaf.js";`,
    "factory/lib/leaf.js": `export const z = 1;`,
  };
  const c = importClosure({ entries: ["factory/lib/judge.js"], readFile: (p) => tree[p] ?? null });
  expect([...c.files].sort()).toEqual(Object.keys(tree).sort());
});

test("test_178_judge_import_closure_excludes_non_judge — a judge module that reaches a non-judge module is caught", () => {
  // 심어 둔 위반: 판정 모듈이 re-export를 거쳐 비판정 모듈(status.js)에 닿는다.
  const tree = {
    "factory/lib/gh.js": `import { h } from "./helper.js";`,
    "factory/lib/helper.js": `export { renderStatus } from "./status.js";`,
    "factory/lib/status.js": `export const renderStatus = () => "";`,
  };
  const { files } = importClosure({ entries: ["factory/lib/gh.js"], readFile: (p) => tree[p] ?? null });
  expect([...files].flatMap(withMirror).filter((f) => isNonJudgePath(f))).toEqual(["factory/lib/status.js", ".factory/lib/status.js"]);

  // 실제 저장소: 닫힘에 닿는 모듈을 목록에 더한 가상의 목록은 누수를 낸다(가드가 무언가를 지킨다).
  const real = importClosure({ entries: JUDGE_MODULES, readFile: readRepo });
  const widened = (f) => isNonJudgePath(f) || f === "factory/lib/aggregate.js";
  expect([...real.files].filter(widened)).toEqual(["factory/lib/aggregate.js"]);
});

test("test_178_judge_import_closure_excludes_non_judge — every engine glob in the list names a concrete file outside the closure", () => {
  // 엔진 쪽 항목(`factory/`·`.factory/`)은 글롭이 아니라 구체적인 파일이다 — 목록을 넓히는 일은 리뷰에서 한 줄씩 보여야 한다.
  const engine = NON_JUDGE_GLOBS.filter((g) => g.startsWith("factory/") || g.startsWith(".factory/"));
  expect(engine.length).toBeGreaterThan(0);
  for (const g of engine) {
    expect(g, g).not.toMatch(/[*?{]/);
    expect(existsSync(join(ROOT, g)), g).toBe(true);
  }
  for (const g of NON_JUDGE_GLOBS) expect(/^(\.claude|\.github)\/|^bin\/|^package/.test(g), g).toBe(false);
  expect(NON_JUDGE_EXCLUDES).toEqual(expect.arrayContaining(["docs/factory/CHARTER.md", "docs/factory/runs/**", "templates/factory/docs/factory/CHARTER.md"]));
});
