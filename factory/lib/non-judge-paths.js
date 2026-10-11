import { posix } from "node:path";
import { matchesAny } from "./glob.js";

/**
 * #178 (S4a-1, ADR-033 첫 단계) — **비판정 경로의 양의 목록. 목록은 하나다.**
 *
 * 판정자 경로를 열거하지 않는다 — 판정자 목록은 샌다(`docs/research/s4-plan-debate.md`): "판정자"라는 이름이 붙지 않은
 * 모듈이 판정의 재료를 쥔다. 그래서 반대로 **목록에 있는 것만** 비판정이고, 목록 밖은 전부 판정 경로다. 새 파일은 기본으로
 * 판정 경로다. 운영 세션의 머지 범위(`operator-merge.js`, ADR-032 §2)도 이 목록 그대로다 — 그 파일은 재export만 한다.
 *
 * 목록은 import 닫힘 테스트(`factory/test/non-judge-paths.test.js`)가 지킨다: `JUDGE_MODULES`에서 상대 경로 정적 import
 * (`import … from`·`export … from`·부작용 `import "…"`)를 재귀로 따라간 파일과 그 `.factory/` 미러 중 하나라도 여기 걸리면 RED다.
 * 그래서 이슈 초안의 aggregate·board·heartbeat·progress·usage·agents-log·bin/scrub-artifacts(와 그 테스트)는 들어오지 못했다 —
 * 전부 판정 모듈이 닿는다(review-quorum→aggregate, gh→heartbeat→progress→usage, run-stage→board·agents-log,
 * gates→bin/scrub-artifacts; #178 plan d5). 그것들을 비판정으로 되돌리는 일은 판정 모듈의 리팩터링이고 따로 이슈다.
 *
 * 엔진 쪽 항목은 글롭이 아니라 **구체적인 파일**이다 — 목록을 넓히는 일은 리뷰에서 한 줄씩 보여야 한다. 테스트 파일은
 * 그 모듈이 목록에 있을 때만 함께 들어온다(d7).
 */
export const NON_JUDGE_GLOBS = Object.freeze([
  // 문서·리서치·운영 스크립트·보드 페이지(오늘의 운영 세션 머지 범위, ADR-032). 아래 EXCLUDES가 그 안의 판정 경로를 뺀다.
  "docs/**",
  "templates/factory/docs/**",
  // 보드의 정적 페이지 풀러 — import가 없고, 판정 모듈 누구도 닿지 않는다.
  "factory/lib/board-static.js",
  ".factory/lib/board-static.js",
  "factory/test/board-page.test.js",
  // `factory status`의 순수 렌더러 — `./labels.js`만 읽는다(비판정 → 판정 방향은 괜찮다). cli/status.js만 쓴다.
  "factory/lib/status.js",
  ".factory/lib/status.js",
  "factory/test/status.test.js",
]);

/**
 * 위 목록 중 **어느 저장소에서나** 비판정인 부분 — 문서·리서치·운영 스크립트·보드 페이지(#178 이전의 운영 세션 목록 그대로).
 * 나머지 항목(엔진 모듈과 그 `.factory/` 미러·테스트)은 **엔진 저장소에서만** 비판정이다: 채택자 저장소에서 `.factory/**`는 설치된
 * 엔진이고 `[protected].factory`(사람이 머지하는 경계)이며, 그 저장소의 `factory/**`는 엔진이 아니다(#178 rework cf1·arch1).
 * 이 글롭들은 `NON_JUDGE_GLOBS`의 부분집합이다 — 목록은 여전히 하나이고, 이것은 그 목록의 엔진 밖 단면이다.
 */
export const ANY_REPO_NON_JUDGE_GLOBS = Object.freeze(["docs/**", "templates/factory/docs/**"]);

/**
 * ADR-039 — **문은 자기 자신을 열지 못한다.** CHARTER `self_change.operator_merge_judge`가 켜져도 이 목록의 파일이 든 PR은 사람이
 * 머지한다: 운영 door의 판정 코드, 이 양의 목록, 그 bin, 그리고 그 bin을 부르는 훅 — 설치본(`.factory/**`·`.claude/hooks/`)까지.
 * 그렇지 않으면 한 세션이 자기 PR로 door를 고쳐 쓰고 그 door로 자기 PR을 머지할 수 있다(대역 리뷰는 훅이 강제하지 못하는 절차다).
 * 글롭이 아니라 정확한 경로다. 목록은 여기 하나다(#178) — `operator-merge.js`는 재export한다.
 */
export const DOOR_FILES = Object.freeze([
  "factory/lib/operator-merge.js", ".factory/lib/operator-merge.js",
  "factory/lib/non-judge-paths.js", ".factory/lib/non-judge-paths.js",
  "factory/bin/operator-merge-check.js", ".factory/bin/operator-merge-check.js",
  "factory/hooks/block-dangerous.sh", ".claude/hooks/block-dangerous.sh",
  // door가 판정에 **신뢰하는** 한 홉 — 글롭 매처(넓히면 모든 경로가 비판정이 된다)와 CHARTER 리더(스위치를 읽는다).
  "factory/lib/glob.js", ".factory/lib/glob.js",
  "factory/lib/config.js", ".factory/lib/config.js",
]);
export const isDoorFile = (p) => DOOR_FILES.includes(String(p ?? "").replace(/^\.\//, ""));

/**
 * 위 글롭 안에서도 판정 경로인 것. CHARTER는 규칙이고, runs는 러너가 쓰는 증거이며(`[protected].runner_only`), 템플릿
 * CHARTER는 모든 채택자의 규칙이 찍혀 나오는 원본이다(#178 d1). 세션 지시문(`CLAUDE*.md`·`AGENTS*.md`·`.mcp*.json`)은
 * 어디에 있든 에이전트 세션의 주입 채널이다 — 원본은 `factory/bin/run-stage.js`의 `SESSION_CONFIG_GLOBS`이고(이 lib는 그 bin을
 * import할 수 없다), `test_178_non_judge_excludes_pin_session_config_globs`가 원본의 모든 항목이 여기 있는지 지킨다.
 */
export const NON_JUDGE_EXCLUDES = Object.freeze([
  "docs/factory/CHARTER.md",
  "docs/factory/runs/**",
  "templates/factory/docs/factory/CHARTER.md",
  "**/CLAUDE*.md",
  "**/AGENTS*.md",
  "**/.mcp*.json",
]);

/**
 * import 닫힘의 시작점 — 머지 판정·게이트·전이·보호 경로·리뷰 정족수·계정 해석·CHARTER 해석을 하는 모듈(이슈 #178의 목록 그대로).
 * 여기서 빼면 닫힘이 줄어 테스트가 쉽게 통과하므로, 테스트가 이슈의 목록과 같은지 확인한다.
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
 * `..`·`.`·빈 세그먼트·절대 경로·선행 `./`가 있는 경로는 목록과 대조하지 않는다. 오늘의 매처(`glob.js`)는 문자 그대로
 * 대조하지만(`docs/../factory/lib/gh.js`는 `docs/**`에 걸린다), 경로 장난으로 목록에 들어올 수 없다는 보장은 여기서 진다.
 */
const isPlainRepoPath = (f) => typeof f === "string" && f.length > 0 && !f.startsWith("/")
  && !f.split("/").some((seg) => seg === ".." || seg === "." || seg === "");

/**
 * 경로 하나가 **엔진 저장소에서** 비판정인가 — 평범한 저장소 경로이고, 목록에 걸리고, 빼기 목록에 걸리지 않는다. 목록 소속만 보는
 * 술어다(import 닫힘 테스트가 쓴다). 저장소 맥락이 필요한 판정은 이것을 직접 쓰지 않고 `isNonJudgePathIn`·`classifyProtected`를 쓴다.
 */
export const isNonJudgePath = (p) => isPlainRepoPath(p) && matchesAny(NON_JUDGE_GLOBS, p) && !matchesAny(NON_JUDGE_EXCLUDES, p);

/**
 * 저장소 맥락을 받는 비판정 판정. `engine`이 정확히 `true`일 때만 목록 전체이고, 그 밖(채택자 저장소 — 기본값)에서는
 * `ANY_REPO_NON_JUDGE_GLOBS`에 드는 것만 비판정이다. 닫힌 쪽이 기본이다: 맥락을 모르면 엔진 파일은 판정 경로다.
 */
export const isNonJudgePathIn = (p, { engine = false } = {}) =>
  isNonJudgePath(p) && (engine === true || matchesAny(ANY_REPO_NON_JUDGE_GLOBS, p));

/**
 * 이 체크아웃이 엔진(know-thy-build 자신)인가. 하네스의 `[project].name`이 엔진의 이름이고, 엔진에만 있는 표지 파일이 **모두**
 * 있어야 한다 — 채택자의 `factory/**`는 엔진이 아니고, 이름 하나(채택자가 고를 수 있다)로는 엔진이 되지 않는다. 판단이 서지
 * 않으면 `false`(닫힌 쪽). `exists(path)`는 저장소 상대 경로를 받는다.
 */
export const ENGINE_PROJECT_NAME = "know-thy-build";
export const ENGINE_MARKERS = Object.freeze(["factory/lib/non-judge-paths.js", "templates/factory/factory/harness.toml"]);
export function isEngineCheckout({ projectName, exists } = {}) {
  if (projectName !== ENGINE_PROJECT_NAME || typeof exists !== "function") return false;
  return ENGINE_MARKERS.every((m) => exists(m) === true);
}

/**
 * 보호 경로를 비판정/판정으로 가른다. `engine`이 `true`가 아니면(채택자 저장소 — 그 저장소의 `factory/**`는 엔진이 아니다)
 * 전부 judge다. 목록 밖은 전부 judge다.
 * @returns {{ non_judge: string[], judge: string[] }}
 */
export function classifyProtected(files, { engine = false } = {}) {
  const list = Array.isArray(files) ? [...files] : [];
  if (engine !== true) return { non_judge: [], judge: list };
  const non_judge = [], judge = [];
  for (const f of list) (isNonJudgePath(f) ? non_judge : judge).push(f);
  return { non_judge, judge };
}

/**
 * 소스 하나가 정적으로 import하는 **상대 경로** 지정자 전부: `import … from`, `export … from`, 부작용 `import "…"`.
 * 문자열 리터럴 인자의 동적 `import("./x.js")`도 센다(과대 근사는 판정 쪽으로만 기운다). 계산된 동적 import·패키지 import는
 * 따라가지 않는다(#178 non_goals). 주석 안의 간선도 센다 — 역시 판정 쪽으로 기운다.
 */
export function relativeSpecifiers(source) {
  const text = String(source ?? "");
  const out = new Set();
  for (const re of [
    /\bfrom\s*(["'])(\.{1,2}\/[^"']+)\1/g,
    /\bimport\s*(["'])(\.{1,2}\/[^"']+)\1/g,
    /\bimport\s*\(\s*(["'])(\.{1,2}\/[^"']+)\1\s*\)/g,
  ]) {
    for (const m of text.matchAll(re)) out.add(m[2]);
  }
  return [...out];
}

/**
 * `entries`(저장소 상대 경로)에서 상대 import를 재귀로 따라간 닫힘. `readFile(path)`는 내용 또는 null(없는 파일).
 * @returns {{ files: Set<string>, edges: Array<[string, string]> }}
 */
export function importClosure({ entries, readFile }) {
  const files = new Set();
  const edges = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (files.has(file)) continue;
    const src = readFile(file);
    if (src == null) continue;
    files.add(file);
    for (const spec of relativeSpecifiers(src)) {
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      edges.push([file, target]);
      if (!files.has(target)) queue.push(target);
    }
  }
  return { files, edges };
}
