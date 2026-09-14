/**
 * 보호 경로의 **단일 출처**(외부 감사 M8, ADR-023).
 *
 * 2026-09-14 외부 감사가 확인한 사실: 같은 목록이 세 곳에 손으로 적혀 있었고 셋이 갈라져 있었다 —
 * `harness.toml [protected].factory`(머지 권한), `.factory/ci-settings*.json`의 Edit/Write deny(L2),
 * `block-dangerous.sh`의 `prot` 정규식(훅). 실제 드리프트: 훅은 `.github/workflows/factory-`만 막는데
 * harness는 `.github/**` 전부를 보호하고, ci-settings는 `.factory/scenarios/**`·`.factory/node_modules/**`를
 * 막는데 훅의 harness 변형은 `(bin|lib|actions|lessons|out)`만 열거한다. 갈라진 목록은 "Edit는 막히는데
 * `echo > x`는 통과한다"를 만든다 — 그리고 어느 쪽이 맞는지 아무도 모른다.
 *
 * 그래서 이 파일이 **`[protected]` 섹션 하나에서** 나머지 둘을 유도한다. `factory init`/`--upgrade`가
 * 훅과 ci-settings를 생성하고, `doctor`의 `protected.parity`가 드리프트를 FAIL로 잡는다.
 *
 * ## 세 층은 같은 목록이지만 같은 질문이 아니다
 * - `[protected].factory`  = **머지** 경계. 이 경로를 건드린 PR은 사람이 머지한다(L1).
 * - 생성된 deny/`prot`     = **쓰기** 경계. 에이전트 세션이 그 파일을 만들지 못하게 한다(L2/훅).
 * 둘은 대부분 같지만 한 군데서 갈라져야 한다: 이 저장소에서 `factory/**`·`templates/**`·`bin/**`는
 * "사람이 머지해야 하지만 에이전트가 **정상 업무로 편집하는**" 경로다(팩토리의 소스가 곧 제품이다).
 * 그 예외는 `[protected].agent_writable`로 harness.toml 안에 **선언**된다 — 코드가 아니라 설정에.
 *
 * `[protected].except`는 여기서 빼지 **않는다**. `except`는 "자동 머지해도 되는 경로"(머지 면제)이지
 * "에이전트가 써도 되는 경로"가 아니다 — `.factory/lessons/**`는 retro만 쓰고 builder는 못 쓴다.
 * 유일한 쓰기 카브아웃은 qa 증거 디렉터리이고, 그것은 아래 `FACTORY_ENUM`의 `.factory/out/*`
 * 열거(KTB-36)와 훅의 `$qa` sed가 함께 표현한다.
 */

/**
 * `.factory/**`는 `[protected]`에서는 글롭 하나지만, 두 소비자가 그 안에서 **카브아웃**을 표현해야 해서
 * 열거로 편다.
 *  - KTB-36: `.factory/out/qa/**`는 qa 리뷰어의 증거 디렉터리라 열려 있어야 한다. Claude Code에서는
 *    **deny가 allow를 이기므로** allow로 뺄 수 없다 — 형제 경로를 열거하는 것이 유일한 방법이다
 *    (`.factory/out/*`는 직계 자식만 맞고 `.factory/out/qa/…`에는 닿지 않는다).
 *  - KTB-20/KTB-23: `factory:harness` 이슈의 builder에게는 `.factory/harness.toml`이 열려야 한다
 *    (승격이 하려는 일이 바로 그 파일의 편집이다). 열거가 없으면 `.factory/**`를 통째로 열게 된다.
 * 순서는 그대로 출력 순서다 — 생성물이 결정적이어야 diff가 읽힌다.
 */
export const FACTORY_ENUM = Object.freeze([
  ".factory/bin/**", ".factory/lib/**", ".factory/actions/**", ".factory/lessons/**",
  ".factory/scenarios/**", ".factory/node_modules/**",
  ".factory/out/*", ".factory/out/coverage/**", ".factory/out/prove-wt/**", ".factory/out/classify-wt/**",
  ".factory/harness.toml", ".factory/ci-settings*.json", ".factory/roles.toml", ".factory/quarantine.toml",
  ".factory/package.json", ".factory/package-lock.json",
]);

/**
 * `FACTORY_HARNESS_ISSUE=1`(= `factory:harness` 이슈의 implement)에서만 열리는 경로(§5.2.1, KTB-20/23).
 * 승격이 실제로 건드리는 테스트 인프라·빌드 설정이다. `.factory/package.json`과 그 락파일은 **열리지
 * 않는다**: 그것을 열면 게이트를 돌리는 런타임 자체를 바꿀 수 있다.
 * 머지는 그대로 사람이다 — 이 경로들은 `[protected].factory`에 남아 있어 L1이 자동 머지를 거부한다.
 */
export const HARNESS_OPENS = Object.freeze([
  ".factory/harness.toml", "package.json", "package-lock.json", "vitest.config.*", "playwright.config.*",
]);

/**
 * ── 리뷰 batch-2 MF-2 — `[protected].runner_only`: **러너만 쓰는 경로** ─────────────────────────
 * `docs/factory/runs/**`는 머지 스테이지가 리뷰 증거로 읽는 run 기록이 사는 곳이다. 그런데 그 디렉터리는
 * `[protected].factory`에 넣을 수 **없다**: 넣으면 L1이 그 파일을 건드린 PR을 전부 사람 머지로 돌리는데,
 * 러너 스크립트가 매 스테이지 그 파일에 줄을 덧붙인다(그래서 `[protected].except`에 있다).
 * 필요한 것은 머지 경계가 아니라 **쓰기 경계**다 — 이 키가 정확히 그 반쪽만 표현한다: 생성되는 훅 `prot`와
 * ci-settings deny에는 들어가고(에이전트 세션이 못 쓴다), `[protected].factory`에는 들어가지 않는다
 * (L1은 그대로 자동 머지한다). doctor의 `protected.runner-only`가 그 둘이 갈라지지 않았는지 본다.
 */

/**
 * 쓰기 경계의 글롭 목록. `[protected].factory` − `agent_writable` (− harness 모드에서 `HARNESS_OPENS`)
 * + `[protected].runner_only`, `.factory/**`는 필요할 때 `FACTORY_ENUM`으로 편다.
 * @param {object} prot harness.toml의 `[protected]` 객체
 * @param {{harnessMode?: boolean, enumerateFactory?: boolean}} opts
 */
export function writeGlobs(prot = {}, { harnessMode = false, enumerateFactory = harnessMode } = {}) {
  const drop = new Set([...(prot.agent_writable || []), ...(harnessMode ? HARNESS_OPENS : [])]);
  const out = [];
  for (const g of prot.factory || []) {
    if (drop.has(g)) continue;
    if (g === ".factory/**" && enumerateFactory) { for (const e of FACTORY_ENUM) if (!drop.has(e)) out.push(e); continue; }
    out.push(g);
  }
  for (const g of prot.runner_only || []) if (!out.includes(g)) out.push(g);
  return out;
}

/**
 * 글롭 하나 → ERE 조각. 훅의 `prot`는 **앵커 없는 부분 문자열** 매칭이라(명령줄 어디에 경로가 나올지
 * 모른다) 접두만 맞으면 충분하다:
 *   `x/**` → `x/`      (그 아래 전부)      `vitest.config.*` → `vitest\.config\.`
 *   `tsconfig*.json` → `tsconfig[a-zA-Z0-9._-]*\.json`      `.eslintrc*` → `\.eslintrc`
 * 중간의 `*`는 경로 한 세그먼트 안의 문자만 받는다(`/`를 넘지 않는다) — 넘으면 `tsconfig*.json`이
 * `tsconfig` 이후 아무 경로나 삼킨다.
 *
 * 리뷰 batch-2 MF-3 — 선두의 "모든 디렉터리" 접두(이중 별표 + 슬래시)는 **지운다**. 이 정규식은 애초에
 * 앵커가 없는 부분 문자열 매칭이라 `CLAUDE[a-zA-Z0-9._-]*\.md` 하나가 `CLAUDE.md`·`docs/CLAUDE.md`·
 * `CLAUDE.local.md`를 전부 문다. 그대로 두면 `[a-zA-Z0-9._-]*` 뒤에 슬래시가 붙어 **루트의 파일이
 * 빠져나간다** — 깊이를 넓히려다 루트를 잃는 것이 정확히 이 계열의 고장이다(그 글롭은 0개 디렉터리도 맞는다).
 */
export function globToEre(glob) {
  if (/'/.test(glob)) throw new Error(`protected glob contains a single quote — it cannot be embedded in the hook: ${glob}`);
  const body = glob.replace(/^\*\*\//, "").replace(/\/\*\*(\/\*)?$/, "/");
  const parts = body.split("*");
  // 끝의 `*`(마지막 조각이 빈 문자열)는 버린다 — 접두 매칭이므로 남길 필요가 없다.
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts.map((p) => p.replace(/[.[\]{}()+?^$|\\]/g, "\\$&")).join("[a-zA-Z0-9._-]*");
}

/**
 * 글롭 목록 → `block-dangerous.sh`의 `prot` 값(괄호로 감싼 교대).
 * 빈 목록은 `prot=''`이 될 수 없다 — 빈 패턴은 **모든 명령에 맞아** 훅이 전부를 막는다. 그래서 실제
 * 명령줄에 나올 수 없는 리터럴 하나를 넣어 "아무것도 맞지 않는다"를 명시한다(그리고 doctor가
 * `protected.parity`로 빈 목록 자체를 FAIL로 잡는다).
 */
export const EMPTY_PROT_SENTINEL = "(factory-protected-list-is-empty)";
export const hookProtRe = (globs) => (globs.length ? `(${globs.map(globToEre).join("|")})` : EMPTY_PROT_SENTINEL);

/** 글롭 목록 → ci-settings의 `Edit(...)`/`Write(...)` deny 쌍. 순서는 글롭 순서 그대로. */
export const ciDenyEntries = (globs) => globs.flatMap((g) => [`Edit(${g})`, `Write(${g})`]);

// ── block-dangerous.sh의 생성 블록 ───────────────────────────────────────────────────────────
// 훅은 셸 스크립트라 `{{VAR}}` 치환으로도 되지만, 그러면 `factory/hooks/block-dangerous.sh` 원본이
// 그 자체로 실행되지 않는다(테스트도 doctor의 `checkHooks`도 원본을 그대로 돌린다). 그래서 원본은
// **템플릿 harness.toml에서 생성된 블록**을 들고 있고(=새 채택자가 받는 그 목록), `factory init`이
// 프로젝트의 harness.toml로 그 블록만 다시 쓴다.
export const PROT_BEGIN = "# >>> factory:protected — generated by `factory init` from harness.toml [protected] (audit M8) — do not edit by hand";
export const PROT_END = "# <<< factory:protected";

export function protBlock(prot) {
  return [
    PROT_BEGIN,
    `prot='${hookProtRe(writeGlobs(prot))}'`,
    `if [ "\${FACTORY_HARNESS_ISSUE:-}" = "1" ]; then`,
    `  prot='${hookProtRe(writeGlobs(prot, { harnessMode: true }))}'`,
    "fi",
    PROT_END,
  ].join("\n");
}

const BLOCK_RE = new RegExp(`^${PROT_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$[\\s\\S]*?^${PROT_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");

/** 훅 본문에서 생성 블록을 찾아 돌려준다(없으면 null) — doctor의 parity 검사가 쓴다. */
export const findProtBlock = (text) => BLOCK_RE.exec(text)?.[0] ?? null;

/**
 * 훅 본문의 생성 블록을 프로젝트 harness.toml로 다시 쓴다. 마커가 없으면 **원본을 그대로 돌려주지
 * 않고 throw한다**: 조용히 넘어가면 생성되지 않은 목록이 설치되고, 그게 바로 M8이다(판정 불능은
 * "안전"이 아니다).
 */
export function replaceProtBlock(text, prot) {
  if (!BLOCK_RE.test(text)) throw new Error("block-dangerous.sh has no `factory:protected` generated block — cannot install a harness-derived protected list");
  return text.replace(BLOCK_RE, protBlock(prot));
}
