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
  // 위 두 모듈의 테스트.
  "factory/test/board-page.test.js",
  "factory/test/status.test.js",
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

/** `..` 세그먼트·절대 경로·선행 `./`가 있는 경로는 목록과 대조하지 않는다(경로 장난으로 목록에 들어올 수 없다). */
const isPlainRepoPath = (f) => typeof f === "string" && f.length > 0 && !f.startsWith("/") && !f.startsWith("./")
  && !f.split("/").some((seg) => seg === ".." || seg === "." || seg === "");

/**
 * 보호 경로를 비판정/판정자로 가른다. `engine`이 `true`가 아니면(채택자 저장소 — 그 저장소의 `factory/**`는
 * 엔진이 아니다) 전부 판정자다. 목록 밖은 전부 판정자다.
 * @returns {{ non_judge: string[], judge: string[] }}
 */
export function classifyProtected(files, { engine = false } = {}) {
  const list = Array.isArray(files) ? [...files] : [];
  if (engine !== true) return { non_judge: [], judge: list };
  const non_judge = [], judge = [];
  for (const f of list) (isPlainRepoPath(f) && matchesAny(NON_JUDGE_GLOBS, f) ? non_judge : judge).push(f);
  return { non_judge, judge };
}

/**
 * 소스 하나가 import하는 **상대 경로** 지정자 전부: `import … from`, `export … from`, 부작용 `import "…"`,
 * 문자열 리터럴 `import("…")`(백틱 포함, 보간 `${}`가 있으면 런타임 구성이라 셀 수 없다 — 제외).
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
      if (target.startsWith("../")) continue;
      edges.push([file, target]);
      if (!files.has(target)) queue.push(target);
    }
  }
  return { files, edges };
}

/** 소스 경로의 설치 미러(`factory/lib/x.js` → `.factory/lib/x.js`) — 미러 가족(`lib/mirror.js`)에 없으면 null. */
export function mirrorOf(src) {
  if (typeof src !== "string" || !src.startsWith("factory/")) return null;
  const dest = `.${src}`;
  return inMirrorFamily(dest) ? dest : null;
}
