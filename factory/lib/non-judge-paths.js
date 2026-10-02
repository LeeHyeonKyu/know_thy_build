import { posix } from "node:path";
import { matchesAny } from "./glob.js";
import { inMirrorFamily } from "./mirror.js";

/**
 * #149 (S4a, 설계 2026-09-30 §8.3) — **비판정 경로의 양의 목록.**
 *
 * 엔진 저장소에서 보호 경로(`[protected].factory`)를 건드린 PR은 사람이 머지한다(ADR-020). S4는 그 규칙을
 * "판정에 쓰이지 않는 코드"에 한해 좁힌다 — CHARTER 스위치가 켜졌을 때만, 거부권 창과 함께(merge-stage.js).
 *
 * **판정자 경로를 열거하지 않는다.** 판정자 목록은 샌다: `gh.js`가 `verifyFactoryStatuses`의 로그인 집합을,
 * `config.js`가 CHARTER 값을 만든다 — "판정자"라는 이름이 붙지 않은 모듈이 판정의 재료를 쥔다. 그래서 반대로
 * **목록에 있는 것만** 비판정이고, 목록 밖은 전부 판정자다. 새 파일은 기본으로 판정자다.
 *
 * 목록은 import 닫힘 테스트(`factory/test/non-judge-paths.test.js`)가 지킨다: `JUDGE_MODULES`에서 상대 경로
 * import를 재귀로 따라간 파일(과 그 `.factory/` 미러) 중 하나라도 여기에 걸리면 RED다. 그래서 이슈 초안의
 * 목록(aggregate·board·heartbeat·progress·usage·agents-log·bin/*)은 들어오지 못했다 — 전부 판정자가
 * import한다(review-quorum→aggregate, gh→heartbeat→progress→usage, gates→bin/scrub-artifacts,
 * run-stage→board/agents-log). `factory/bin/**`는 워크플로가 `node .factory/bin/*.js`로 직접 실행하는
 * 프로세스 간선이 import 닫힘에 보이지 않으므로 하나도 넣지 않는다.
 *
 * `docs/**`·`templates/factory/docs/**`도 넣지 않는다(#149 dissent d1, skeptic 채택). 이 함수는 **이미 보호된**
 * 파일만 받는데, `docs/` 아래 보호 경로는 CHARTER와 세션 지시문(`**\/CLAUDE*.md`·`**\/AGENTS*.md`·
 * `**\/.mcp*.json`)뿐이고 그 전부가 판정자여야 한다 — 곧 그 글롭은 정당한 파일을 하나도 비판정으로 만들지 못하고,
 * 빼기 목록이 어긋나는 순간 주입 채널만 연다. `templates/factory/**`는 CHARTER NEVER_AUTOMATE다(사람 머지).
 *
 * 항목은 글롭이 아니라 **구체적인 파일**이다 — 목록을 넓히는 일은 리뷰에서 한 줄씩 보여야 한다.
 */
export const NON_JUDGE_GLOBS = Object.freeze([
  // 보드의 정적 페이지 풀러 — import가 없다. 테스트 외에는 아무도 import하지 않는다.
  "factory/lib/board-static.js",
  ".factory/lib/board-static.js",
  // `factory status`의 순수 렌더러 — `./labels.js`만 읽는다. cli/status.js만 쓴다(판정자가 아니다).
  "factory/lib/status.js",
  ".factory/lib/status.js",
  // **테스트 파일은 하나도 없다**(#149 self-critique). 테스트는 import 닫힘에 보이지 않지만(아무도 import하지 않는다)
  // 게이트 러너가 실행하고, 그 단언이 곧 "무엇이 통과인가"다 — 단언을 약하게 하거나 지운 PR이 여기 걸리면 사람 없이
  // 자동 머지된다(`tests_are_load_bearing`). 그래서 위 모듈을 테스트와 함께 바꾼 PR은 테스트 파일 때문에 사람에게 간다.
]);

/**
 * import 닫힘의 시작점 — 머지 판정·게이트·전이·보호 경로·리뷰 정족수·계정 해석·CHARTER 해석을 하는 모듈.
 * 여기서 빼면 닫힘이 줄어 테스트가 쉽게 통과하므로, 테스트가 이슈 #149의 목록을 그대로 포함하는지 확인한다.
 */
export const JUDGE_MODULES = Object.freeze([
  "factory/lib/merge-stage.js",
  "factory/lib/integrity.js",
  "factory/lib/gates.js",
  "factory/lib/requirements.js",
  "factory/lib/self-gate.js",
  "factory/lib/admission.js",
  "factory/lib/transition.js",
  "factory/lib/labels.js",
  "factory/lib/protected-paths.js",
  "factory/lib/review-quorum.js",
  "factory/lib/gh.js",
  "factory/lib/config.js",
  "factory/bin/run-stage.js",
]);

/**
 * `..`·`.`·빈 세그먼트(`//`, 끝의 `/`)·절대 경로·선행 `./`가 있는 경로는 목록과 대조하지 않는다. 오늘의 매처(`glob.js`)는
 * 문자 그대로 대조하므로 이런 이름은 어차피 걸리지 않지만, 그 보장을 매처의 구현에 맡기지 않는다 — 매처가 경로를
 * 정규화하게 바뀌어도 경로 장난으로 목록에 들어올 수 없다(테스트가 정규화하는 매처를 주입해 이 검사를 직접 친다).
 */
const isPlainRepoPath = (f) => typeof f === "string" && f.length > 0 && !f.startsWith("/") && !f.startsWith("./")
  && !f.split("/").some((seg) => seg === ".." || seg === "." || seg === "");

/**
 * 보호 경로를 비판정/판정자로 가른다. `engine`이 `true`가 아니면(채택자 저장소 — 그 저장소의 `factory/**`는
 * 엔진이 아니다) 전부 판정자다. 목록 밖은 전부 판정자다. `match`는 목록 대조 함수(기본 `glob.js`의 matchesAny) —
 * 테스트가 경로 장난 검사를 매처와 떼어 확인하려고 주입한다. 프로덕션 호출자는 넘기지 않는다.
 * @returns {{ non_judge: string[], judge: string[] }}
 */
export function classifyProtected(files, { engine = false, match = matchesAny } = {}) {
  const list = Array.isArray(files) ? [...files] : [];
  if (engine !== true) return { non_judge: [], judge: list };
  const non_judge = [], judge = [];
  for (const f of list) (isPlainRepoPath(f) && match(NON_JUDGE_GLOBS, f) === true ? non_judge : judge).push(f);
  return { non_judge, judge };
}

/**
 * 소스 하나가 import하는 **상대 경로** 지정자 전부: `import … from`, `export … from`, 부작용 `import "…"`,
 * 문자열 리터럴 인자의 동적 import — 백틱 포함. 보간 템플릿·식 인자의 동적 import는 여기서 세지 않는다 — `computedImports`가
 * 그 자리를 따로 찾고, 닫힘은 셀 수 없는 것을 버리지 않고 `unresolved`로 낸다(#149 skeptic flaw 5).
 * 주석 안의 간선도 센다: 과대 근사는 판정자 쪽으로만 기운다.
 */
export function relativeSpecifiers(source) {
  const out = new Set();
  const text = String(source ?? "");
  const patterns = [
    /\bfrom\s*(["'`])(\.{1,2}\/[^"'`]+)\1/g,
    /\bimport\s*(["'`])(\.{1,2}\/[^"'`]+)\1/g,
    /\bimport\s*\(\s*(["'`])(\.{1,2}\/[^"'`]+)\1\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) if (!m[2].includes("${")) out.add(m[2]);
  }
  return [...out];
}

/** 동적 import 키워드 뒤의 인자가 문자열 리터럴(보간 없는 백틱 포함) 하나인가. */
const LITERAL_IMPORT_ARG = /^\s*(?:"[^"\n]*"|'[^'\n]*'|`[^`$]*`)\s*\)/;
const DYNAMIC_IMPORT = /\bimport\s*\(/g;

/**
 * #149 skeptic flaw 5 — **계산된 동적 import를 하는 판정자 닫힘의 파일**과 그것이 로드하는 대상. 인자가 식이거나 보간
 * 템플릿인 동적 import는 `relativeSpecifiers`가 셀 수 없다 — 조용히 버리면 닫힘이 작아지고(비판정 쪽으로 기운다) 그 로더가
 * 무엇을 읽든 목록에 넣을 수 있다(예전 파서가 정확히 그랬다: mirror.js→cli 생성기, install-manifest.js→cli/manifest.js).
 *
 * 그래서 그런 파일은 여기 적혀 있어야만 셀 수 있고, 적힌 사실이 **소스와 맞아야** 한다(`importClosure`가 대조한다):
 *   - `sites`: 그 파일의 계산된 동적 import 개수(주석 안의 것도 센다),
 *   - `loader`·`calls`: 그 import를 감싼 로더 함수의 이름과 그 이름을 부르는 자리의 개수(정의 자리는 세지 않는다),
 *   - `targets`: 로더가 읽는 저장소 루트 기준 경로 — 각 경로가 그 파일의 소스에 문자열로 나와야 한다.
 * 하나라도 어긋나면(새 계산된 import, 로더의 새 호출, 사라진 대상) 그 파일은 `unresolved`다 — 테스트가 RED로 읽는다.
 * 보간 템플릿은 표로도 셀 수 없다(대상이 그 자리에서 조립된다). 이 표는 판정자 파일이고(목록 밖), 그 변경은 사람이 머지한다.
 */
export const COMPUTED_IMPORT_LOADERS = Object.freeze({
  // 미러 생성기 로더: `importer(join(root, "factory/cli/…"))` 세 번(regenerateMirror·mirrorMatchesHead의 기본 로더가 두 자리).
  "factory/lib/mirror.js": Object.freeze({ sites: 2, loader: "importer", calls: 3, targets: Object.freeze(["factory/cli/manifest.js", "factory/cli/install.js", "factory/cli/init.js"]) }),
  // 설치 표가 없을 때의 폴백: 저장소의 `factory/cli/manifest.js`(엔진 저장소) 또는 node_modules의 같은 파일(채택자 — 저장소 밖).
  "factory/lib/feedback/install-manifest.js": Object.freeze({ sites: 1, loader: "importModule", calls: 1, targets: Object.freeze(["factory/cli/manifest.js"]) }),
});

/**
 * 소스 하나의 계산된 동적 import 자리 — `{ computed: 식 인자 자리[], templated: 보간 템플릿 자리[] }`. 문자열 리터럴 인자는
 * `relativeSpecifiers`의 몫이라 여기 없다.
 */
export function computedImports(source) {
  const text = String(source ?? "");
  const computed = [], templated = [];
  for (const m of text.matchAll(DYNAMIC_IMPORT)) {
    const rest = text.slice(m.index + m[0].length);
    if (LITERAL_IMPORT_ARG.test(rest)) continue;
    const site = text.slice(m.index, m.index + m[0].length + 60).split("\n")[0];
    (/^\s*`[^`]*\$\{/.test(rest) ? templated : computed).push(site);
  }
  return { computed, templated };
}

/** 표의 한 항목이 소스와 맞는가 → 어긋난 사유 목록(빈 배열 = 맞다). */
function loaderMismatches(src, c, decl) {
  if (!decl) return c.computed.map((site) => `computed dynamic import not declared in COMPUTED_IMPORT_LOADERS: ${site}`);
  const out = [];
  if (c.computed.length !== decl.sites) out.push(`declares ${decl.sites} computed dynamic imports, source has ${c.computed.length}`);
  const calls = [...src.matchAll(new RegExp(`\\b${decl.loader}\\s*\\(`, "g"))].length;
  if (calls !== decl.calls) out.push(`declares ${decl.calls} call(s) of loader ${decl.loader}, source has ${calls}`);
  for (const t of decl.targets) if (!src.includes(`"${t}"`)) out.push(`declared target ${t} does not appear in the source`);
  return out;
}

/**
 * `entries`(저장소 상대 경로)에서 import를 재귀로 따라간 닫힘. `readFile(path)`는 내용 또는 null(없는 파일).
 * 상대 지정자는 그대로 따라가고, 계산된 동적 import는 `loaders`(기본 `COMPUTED_IMPORT_LOADERS`)에 소스와 맞게 적혀 있으면
 * 그 대상을 저장소 루트 기준 간선으로 따라간다. 셀 수 없는 것은 버리지 않고 `unresolved`에 `[파일, 사유]`로 싣는다.
 * @returns {{ files: Set<string>, edges: Array<[string, string]>, unresolved: Array<[string, string]> }}
 */
export function importClosure({ entries, readFile, loaders = COMPUTED_IMPORT_LOADERS }) {
  const files = new Set();
  const edges = [];
  const unresolved = [];
  const queue = [...entries];
  const follow = (file, target) => {
    if (target.startsWith("../")) return;
    edges.push([file, target]);
    if (!files.has(target)) queue.push(target);
  };
  while (queue.length) {
    const file = queue.shift();
    if (files.has(file)) continue;
    const src = readFile(file);
    if (src == null) continue;
    files.add(file);
    for (const spec of relativeSpecifiers(src)) follow(file, posix.normalize(posix.join(posix.dirname(file), spec)));
    const c = computedImports(src);
    for (const site of c.templated) unresolved.push([file, `interpolated dynamic import cannot be followed: ${site}`]);
    const decl = Object.hasOwn(loaders, file) ? loaders[file] : null;
    if (!c.computed.length && !decl) continue;
    const bad = loaderMismatches(src, c, decl);
    if (bad.length) { for (const why of bad) unresolved.push([file, why]); continue; }
    for (const t of decl.targets) follow(file, posix.normalize(t));
  }
  return { files, edges, unresolved };
}

/** 소스 경로의 설치 미러(`factory/lib/x.js` → `.factory/lib/x.js`) — 미러 가족(`lib/mirror.js`)에 없으면 null. */
export function mirrorOf(src) {
  if (typeof src !== "string" || !src.startsWith("factory/")) return null;
  const dest = `.${src}`;
  return inMirrorFamily(dest) ? dest : null;
}
