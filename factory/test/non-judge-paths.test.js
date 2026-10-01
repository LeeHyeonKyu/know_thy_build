import { test, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NON_JUDGE_GLOBS, JUDGE_MODULES, classifyProtected, relativeSpecifiers, importClosure, mirrorOf } from "../lib/non-judge-paths.js";
import { matchesAny } from "../lib/glob.js";

/**
 * #149 (S4a) — 비판정 경로는 **양의 목록**이고, 판정자 모듈의 import 닫힘과 겹치지 않는다.
 *
 * 저장소 루트는 이 파일의 위치에서 구한다 — 닫힘은 고정 목록이 아니라 **실제 파일**에서 센다.
 */
const ROOT = join(new URL("../../", import.meta.url).pathname);
const readRepo = (p) => {
  const abs = join(ROOT, p);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
};

// ── dw1 ───────────────────────────────────────────────────────────────────────────────────────────

test("test_149_non_judge_is_a_positive_list", () => {
  // 목록 안의 파일(소스 + 설치 미러)만이면 judge가 비어 있다.
  const listed = ["factory/lib/board-static.js", ".factory/lib/board-static.js"];
  expect(classifyProtected(listed, { engine: true })).toEqual({ non_judge: listed, judge: [] });

  // 목록 밖 파일이 하나라도 섞이면 **그 파일**이 judge에 간다(나머지는 그대로 non_judge).
  const mixed = classifyProtected(["factory/lib/board-static.js", "factory/lib/unlisted-new-module.js"], { engine: true });
  expect(mixed).toEqual({ non_judge: ["factory/lib/board-static.js"], judge: ["factory/lib/unlisted-new-module.js"] });

  // 판정자가 닿는 코드·CHARTER·세션 지시문은 언제나 judge다 — 목록이 무엇이든.
  const alwaysJudge = [
    "factory/lib/aggregate.js", "factory/lib/board.js", "factory/lib/heartbeat.js", "factory/lib/progress.js",
    "factory/lib/usage.js", "factory/lib/agents-log.js",
    "factory/bin/scrub-artifacts.js", "factory/bin/board.js", "factory/bin/run-stage.js", ".factory/bin/board.js",
    "docs/factory/CHARTER.md", "templates/factory/docs/factory/CHARTER.md",
    "docs/CLAUDE.md", "docs/AGENTS.md", "docs/nested/dir/.mcp.json", "templates/factory/docs/factory/board/index.html",
    "factory/lib/merge-stage.js", ".factory/lib/merge-stage.js", "factory/lib/non-judge-paths.js",
  ];
  for (const f of alwaysJudge) {
    expect(classifyProtected([f], { engine: true }), f).toEqual({ non_judge: [], judge: [f] });
  }
  // 경로 장난(`..`, 선행 `./`)으로 목록에 들어올 수 없다.
  expect(classifyProtected(["factory/lib/../bin/run-stage.js"], { engine: true }).judge).toEqual(["factory/lib/../bin/run-stage.js"]);

  // engine:false(채택자 저장소) — 목록 안 파일조차 전부 judge.
  expect(classifyProtected(listed, { engine: false })).toEqual({ non_judge: [], judge: listed });
  expect(classifyProtected(listed, {})).toEqual({ non_judge: [], judge: listed });
  expect(classifyProtected(listed)).toEqual({ non_judge: [], judge: listed });
});

test("test_149_non_judge_is_a_positive_list — the list names concrete files, never a docs/templates/bin glob", () => {
  for (const g of NON_JUDGE_GLOBS) {
    expect(g, g).not.toMatch(/\*/);
    expect(g.startsWith("docs/") || g.startsWith("templates/") || /(^|\/)bin\//.test(g), g).toBe(false);
  }
  expect(NON_JUDGE_GLOBS.length).toBeGreaterThan(0);
});

// ── dw2 ───────────────────────────────────────────────────────────────────────────────────────────

/** 이슈 #149 본문의 JUDGE_MODULES 그대로 — 닫힘의 시작점을 줄여서 테스트를 통과시킬 수 없다. */
const ISSUE_JUDGE_MODULES = [
  "factory/lib/merge-stage.js", "factory/lib/integrity.js", "factory/lib/gates.js", "factory/lib/requirements.js",
  "factory/lib/self-gate.js", "factory/lib/admission.js", "factory/lib/transition.js", "factory/lib/labels.js",
  "factory/lib/protected-paths.js", "factory/lib/review-quorum.js", "factory/lib/gh.js", "factory/lib/config.js",
  "factory/bin/run-stage.js",
];

test("test_149_judge_import_closure_excludes_non_judge", () => {
  for (const m of ISSUE_JUDGE_MODULES) expect(JUDGE_MODULES, m).toContain(m);
  for (const m of JUDGE_MODULES) expect(existsSync(join(ROOT, m)), m).toBe(true);

  const { files, edges } = importClosure({ entries: JUDGE_MODULES, readFile: readRepo });
  const has = (from, to) => edges.some(([a, b]) => a === from && b === to);
  // 파서가 실제로 그 간선들을 찾는다 — `./`, `../lib`, `../bin` 모두. 간선을 버리는 좁은 파서는 여기서 RED다.
  expect(has("factory/lib/review-quorum.js", "factory/lib/aggregate.js")).toBe(true);
  expect(has("factory/lib/gates.js", "factory/bin/scrub-artifacts.js")).toBe(true);
  expect(has("factory/bin/run-stage.js", "factory/lib/board.js")).toBe(true);
  expect(has("factory/lib/gh.js", "factory/lib/heartbeat.js")).toBe(true);
  expect(has("factory/lib/merge-stage.js", "factory/lib/non-judge-paths.js")).toBe(true);
  // 재귀다: 직접 import가 아니라 두 단계 너머(gh → heartbeat → progress → usage)까지 닿는다.
  expect(files.has("factory/lib/usage.js")).toBe(true);
  expect(files.size).toBeGreaterThan(40);

  // 닫힘의 모든 파일과 그 설치 미러 — 어느 것도 양의 목록에 걸리지 않는다.
  const reached = [...files].flatMap((f) => [f, mirrorOf(f)]).filter(Boolean);
  expect(reached).toContain(".factory/lib/aggregate.js");
  const leaked = reached.filter((f) => matchesAny(NON_JUDGE_GLOBS, f));
  expect(leaked).toEqual([]);
});

test("test_149_judge_import_closure_excludes_non_judge — the parser follows every relative specifier form", () => {
  const src = [
    `import { a } from "./a.js";`,
    `import {\n  b,\n  c,\n} from '../lib/b.js';`,
    `export { d } from "../bin/d.js";`,
    `export * from "./e.js";`,
    `import "./side-effect.js";`,
    `const m = await import("../lib/dyn.js");`,
    "const t = await import(`./tpl.js`);",
    "const skip = await import(`./${name}.js`);",
    `import { readFileSync } from "node:fs";`,
    `import { parse } from "smol-toml";`,
  ].join("\n");
  expect(relativeSpecifiers(src).sort()).toEqual(["../bin/d.js", "../lib/b.js", "../lib/dyn.js", "./a.js", "./e.js", "./side-effect.js", "./tpl.js"].sort());

  // 합성 트리: `../` 간선과 동적 import를 따라 재귀한다.
  const tree = {
    "factory/lib/judge.js": `import { x } from "../bin/tool.js";`,
    "factory/bin/tool.js": `const y = await import("../lib/deep.js");`,
    "factory/lib/deep.js": `export { z } from "./leaf.js";`,
    "factory/lib/leaf.js": `export const z = 1;`,
  };
  const c = importClosure({ entries: ["factory/lib/judge.js"], readFile: (p) => tree[p] ?? null });
  expect([...c.files].sort()).toEqual(Object.keys(tree).sort());

  expect(mirrorOf("factory/lib/aggregate.js")).toBe(".factory/lib/aggregate.js");
  expect(mirrorOf("factory/bin/run-stage.js")).toBe(".factory/bin/run-stage.js");
  expect(mirrorOf("factory/test/x.test.js")).toBe(null);
  expect(mirrorOf("docs/x.md")).toBe(null);
});

test("test_149_judge_import_closure_excludes_non_judge — widening the list with a reached module goes RED", () => {
  // 가드가 진짜로 무언가를 지키는지: 닫힘에 있는 모듈을 목록에 넣은 가상의 목록은 누수를 낸다.
  const { files } = importClosure({ entries: JUDGE_MODULES, readFile: readRepo });
  const widened = [...NON_JUDGE_GLOBS, "factory/lib/aggregate.js"];
  expect([...files].filter((f) => matchesAny(widened, f))).toEqual(["factory/lib/aggregate.js"]);
  // 실제 저장소의 lib 디렉터리가 읽힌다(빈 트리로 공허하게 통과하지 않는다).
  expect(readdirSync(join(ROOT, "factory/lib")).length).toBeGreaterThan(20);
});
