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
 * 위 글롭 안에서도 판정 경로인 것. CHARTER는 규칙이고, runs는 러너가 쓰는 증거이며(`[protected].runner_only`), 템플릿
 * CHARTER는 모든 채택자의 규칙이 찍혀 나오는 원본이다(#178 d1). 세션 지시문(`CLAUDE*.md`·`AGENTS*.md`·`.mcp*.json`)은
 * 어디에 있든 에이전트 세션의 주입 채널이다(`[protected].factory`와 같은 글롭).
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

/** 경로 하나가 비판정인가 — 평범한 저장소 경로이고, 목록에 걸리고, 빼기 목록에 걸리지 않는다. */
export const isNonJudgePath = (p) => isPlainRepoPath(p) && matchesAny(NON_JUDGE_GLOBS, p) && !matchesAny(NON_JUDGE_EXCLUDES, p);

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
