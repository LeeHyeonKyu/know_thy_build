import { test, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
const posixNormalize = (p) => posix.normalize(p);
import { NON_JUDGE_GLOBS, JUDGE_MODULES, classifyProtected, relativeSpecifiers, importClosure, mirrorOf } from "../lib/non-judge-paths.js";
import { COMPUTED_IMPORT_LOADERS } from "../lib/non-judge-paths.js";
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

// ── #149 self-critique — 테스트 파일과 경로 장난 ────────────────────────────────────────────────────

test("test_149_non_judge_is_a_positive_list — a test file is never non-judge: the gate runner executes it and its assertions are the verdict", () => {
  // 테스트 파일은 import 닫힘에 보이지 않는다(아무도 import하지 않는다) — 그러나 게이트 러너가 실행하고, 그 단언이 곧
  // "무엇이 통과인가"다. 단언을 약하게 하거나 지운 PR이 비판정으로 분류되면 사람 없이 자동 머지된다(tests_are_load_bearing).
  const testFiles = readdirSync(join(ROOT, "factory/test")).filter((f) => f.endsWith(".test.js")).map((f) => `factory/test/${f}`);
  expect(testFiles).toContain("factory/test/status.test.js");
  expect(testFiles).toContain("factory/test/board-page.test.js");
  expect(testFiles.length).toBeGreaterThan(50);
  for (const f of testFiles) expect(classifyProtected([f], { engine: true }), f).toEqual({ non_judge: [], judge: [f] });
  // 목록 자체에 테스트 파일이 없다(미래의 테스트 디렉터리·다른 확장자 포함).
  for (const g of NON_JUDGE_GLOBS) expect(/(^|\/)test\/|\.test\.|\.spec\./.test(g), g).toBe(false);
  // 그래도 그 모듈 자신은 비판정이다 — 테스트와 함께 바꾼 PR은 테스트 파일 때문에 사람에게 간다.
  expect(classifyProtected(["factory/lib/status.js", "factory/test/status.test.js"], { engine: true }))
    .toEqual({ non_judge: ["factory/lib/status.js"], judge: ["factory/test/status.test.js"] });
});

test("test_149_non_judge_is_a_positive_list — a path trick aimed at a listed file stays judge, even under a matcher that normalizes paths", () => {
  const tricks = [
    "./factory/lib/board-static.js", "factory//lib/board-static.js", "factory/lib/../lib/board-static.js",
    "factory/lib/./board-static.js", "/factory/lib/board-static.js", "factory/lib/board-static.js/",
  ];
  // 오늘의 글롭 매처는 경로를 문자 그대로 대조한다. 목록 대조가 경로 정규화를 하는 매처로 바뀌어도(혹은 누가 그렇게 바꿔도)
  // 이런 이름은 목록에 들어올 수 없어야 한다 — 그 보장은 매처가 아니라 classifyProtected의 평범한-경로 검사가 진다.
  const normalizing = (globs, f) => matchesAny(globs, posixNormalize(f).replace(/^\/+|\/+$/g, ""));
  expect(normalizing(NON_JUDGE_GLOBS, "factory/lib/../lib/board-static.js")).toBe(true);   // 대조군: 이 매처는 실제로 정규화한다
  for (const f of tricks) {
    expect(classifyProtected([f], { engine: true }), f).toEqual({ non_judge: [], judge: [f] });
    expect(classifyProtected([f], { engine: true, match: normalizing }), f).toEqual({ non_judge: [], judge: [f] });
  }
  // 평범한 경로는 같은 매처로 그대로 비판정이다(매처 주입이 판정을 통째로 끄는 것이 아니다).
  expect(classifyProtected(["factory/lib/board-static.js"], { engine: true, match: normalizing })).toEqual({ non_judge: ["factory/lib/board-static.js"], judge: [] });
});

// ── #149 skeptic self-critique (flaw 5) — 셀 수 없는 동적 import는 "간선 없음"이 아니라 RED다 ──────────────────────────

test("test_149_judge_import_closure_excludes_non_judge — a computed import() the parser cannot follow fails the closure instead of being dropped (skeptic flaw 5)", () => {
  // 보간 템플릿·식 인자의 import()는 런타임에 정해진다 — 그 간선을 조용히 버리면 닫힘이 작아지고(비판정 쪽으로 기운다),
  // 그 파일이 무엇을 로드하든 목록에 넣을 수 있다. 그래서 닫힘은 그런 자리를 `unresolved`로 내고, 테스트는 그것을 RED로 읽는다.
  const tree = {
    "factory/lib/judge.js": "const m = await import(`./${name}.js`);\nimport { a } from \"./a.js\";",
    "factory/lib/a.js": "const load = (p) => import(pathToFileURL(p).href);\nexport const a = 1;",
    "factory/lib/plain.js": "const n = await import(\"./a.js\");",
  };
  const c = importClosure({ entries: ["factory/lib/judge.js", "factory/lib/plain.js"], readFile: (p) => tree[p] ?? null });
  expect(c.unresolved.map(([f]) => f).sort()).toEqual(["factory/lib/a.js", "factory/lib/judge.js"]);
  expect(c.unresolved.find(([f]) => f === "factory/lib/judge.js")[1]).toContain("${name}");

  // 계산된 import를 셀 수 있게 하는 유일한 길: 로더 표(`COMPUTED_IMPORT_LOADERS`)에 그 파일의 계산된 import 개수·로더 이름과
  // 호출 수·대상을 적고, 그 사실이 소스와 맞는 것. 대상은 저장소 루트 기준 간선이 된다.
  const loaderSrc = [
    "const importer = (p) => import(pathToFileURL(p).href);",
    "await importer(join(root, \"factory/cli/tool.js\"));",
  ].join("\n");
  const declared = { "factory/lib/loader.js": loaderSrc, "factory/cli/tool.js": "export const t = 1;" };
  const table = { "factory/lib/loader.js": { sites: 1, loader: "importer", calls: 1, targets: ["factory/cli/tool.js"] } };
  const d = importClosure({ entries: ["factory/lib/loader.js"], readFile: (p) => declared[p] ?? null, loaders: table });
  expect(d.unresolved).toEqual([]);
  expect(d.edges).toContainEqual(["factory/lib/loader.js", "factory/cli/tool.js"]);
  expect(d.files.has("factory/cli/tool.js")).toBe(true);
  // 표가 없으면 같은 소스가 셀 수 없다.
  expect(importClosure({ entries: ["factory/lib/loader.js"], readFile: (p) => declared[p] ?? null, loaders: {} }).unresolved.map(([f]) => f)).toEqual(["factory/lib/loader.js"]);
  // 표와 소스가 어긋나면(로더를 한 번 더 부른다·계산된 import가 하나 더 생긴다·대상이 소스에서 사라진다) 셀 수 없다.
  for (const [name, src] of Object.entries({
    "a new loader call": loaderSrc + "\nawait importer(somePath);",
    "a new computed import": loaderSrc + "\nawait import(other);",
    "the target is gone": loaderSrc.replace("factory/cli/tool.js", "factory/cli/other.js"),
  })) {
    const c = importClosure({ entries: ["factory/lib/loader.js"], readFile: (p) => (p === "factory/lib/loader.js" ? src : declared[p] ?? null), loaders: table });
    expect(c.unresolved.length, name).toBeGreaterThan(0);
    expect(c.unresolved.every(([f]) => f === "factory/lib/loader.js"), name).toBe(true);
    expect(c.files.has("factory/cli/tool.js"), name).toBe(false);
  }

  // 실제 저장소: 판정자 닫힘에 셀 수 없는 import가 하나도 없다. mirror.js·feedback/install-manifest.js의 계산된 import는
  // 표로 세어지고, 그 대상(cli 생성기)과 그것이 import하는 것까지 닫힘에 들어온다 — 그리고 여전히 목록과 겹치지 않는다.
  const real = importClosure({ entries: JUDGE_MODULES, readFile: readRepo });
  expect(real.unresolved).toEqual([]);
  expect(real.files.has("factory/lib/mirror.js")).toBe(true);
  for (const t of ["factory/cli/manifest.js", "factory/cli/install.js", "factory/cli/init.js"]) {
    expect(real.edges, t).toContainEqual(["factory/lib/mirror.js", t]);
    expect(real.files.has(t), t).toBe(true);
  }
  expect(real.edges).toContainEqual(["factory/lib/feedback/install-manifest.js", "factory/cli/manifest.js"]);
  // 표의 모든 항목이 실제로 닫힘에 있는 파일이다(죽은 항목으로 표가 부풀지 않는다).
  for (const f of Object.keys(COMPUTED_IMPORT_LOADERS)) expect(real.files.has(f), f).toBe(true);
  const reached = [...real.files].flatMap((f) => [f, mirrorOf(f)]).filter(Boolean);
  expect(reached.filter((f) => matchesAny(NON_JUDGE_GLOBS, f))).toEqual([]);
  // 대조군: 계산된 import로만 닿는 파일을 목록에 넣으면 이 닫힘이 그것을 잡는다(예전 파서는 놓쳤다).
  expect([...real.files].filter((f) => matchesAny([...NON_JUDGE_GLOBS, "factory/cli/install.js"], f))).toEqual(["factory/cli/install.js"]);
});
