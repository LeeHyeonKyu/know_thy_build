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
 * 유일한 쓰기 카브아웃은 qa 증거 디렉터리이고, 그것은 아래 `FACTORY_ENUM`의 `.factory/out/*.<ext>`
 * 열거(KTB-36 → KTB-40)와 훅의 `$qa` sed가 함께 표현한다.
 */

/**
 * `.factory/**`는 `[protected]`에서는 글롭 하나지만, 두 소비자가 그 안에서 **카브아웃**을 표현해야 해서
 * 열거로 편다.
 *  - KTB-36: `.factory/out/qa/**`는 qa 리뷰어의 증거 디렉터리라 열려 있어야 한다. Claude Code에서는
 *    **deny가 allow를 이기므로** allow로 뺄 수 없다 — 형제 경로를 열거하는 것이 유일한 방법이다.
 *  - **KTB-40**: KTB-36의 좁히기는 **모자랐다**. 그때 남긴 `.factory/out/*`는 우리 `globToRegex`에서
 *    "직계 자식만"이지만, 직계 자식에는 **`qa` 디렉터리 자신이 포함된다** — 그리고 Claude Code의 매처는
 *    그보다 관대해서 `.factory/out/qa/test1.log`까지 문 것으로 관측됐다. 라이브 KTB #3 리뷰 R2
 *    (run 34840944244)에서 qa 리뷰어의 Bash 9건이 훅이 아니라 **Claude Code의 권한 계층**에 거절당했다:
 *    `mkdir -p .factory/out/qa/`, `printf … > .factory/out/qa/test1.log`, `node … > …/qa/3-repro-…log`.
 *    그래서 이제 `*` 하나를 남기지 않고 **확장자까지 적은 파일 패턴**만 열거한다: `*.json`·`*.jsonl`·
 *    `*.pids`. 그것이 `.factory/out/` 직계에 실제로 쓰이는 전부다(`grep -r '\.factory/out/'`:
 *    run-stage의 `<stage>.json`/`<stage>.envelope.json`·`context*.json`, 게이트의 `gates*.json`·
 *    `unit|e2e|integration.json`, `loaded.json`, `retro*.json`, `agents.jsonl`, `test-env.pids`).
 *    확장자가 없는 `.factory/out/qa`는 어떤 읽기에서도 이 중 무엇과도 맞지 않는다.
 *
 *    **`.md`·`.log`·`.txt`는 일부러 넣지 않는다.** 관대한 읽기에서 `*`가 `/`를 넘으면
 *    `.factory/out/*.log`가 `.factory/out/qa/a/b.log`를 문다 — 그리고 qa의 증거는 정확히 `.log`·`.md`·
 *    `.png`다. 즉 그 세 줄은 KTB-36이 만들려던 카브아웃을 **다시** 지운다. 지금 `.factory/out/` 직계에
 *    그 확장자로 쓰는 코드도 없다. 새로 생긴다면 그때 **qa가 쓰지 않는 이름**으로 못 박을 것 —
 *    이 열거의 규칙은 "직계를 막되 `out/qa/` 아래의 어떤 이름도 접미사로 겹치지 않는다"이다.
 *
 *    카브아웃을 **적극적으로** 말하는 `permissions.allow`도 두 ci-settings 템플릿에 함께 넣었다 —
 *    선언이지 우선권이 아니다(deny가 여전히 이긴다). `--permission-mode dontAsk`에서 allow에 걸리지
 *    않는 도구 호출은 묻지 않고 거절되므로, 그 선언이 없으면 `mkdir -p .factory/out/qa`가 다시 막힌다.
 *  - KTB-20/KTB-23: `factory:harness` 이슈의 builder에게는 `.factory/harness.toml`이 열려야 한다
 *    (승격이 하려는 일이 바로 그 파일의 편집이다). 열거가 없으면 `.factory/**`를 통째로 열게 된다.
 * 순서는 그대로 출력 순서다 — 생성물이 결정적이어야 diff가 읽힌다.
 */
export const FACTORY_ENUM = Object.freeze([
  ".factory/bin/**", ".factory/lib/**", ".factory/actions/**", ".factory/lessons/**",
  ".factory/scenarios/**", ".factory/node_modules/**",
  ".factory/out/*.json", ".factory/out/*.jsonl", ".factory/out/*.pids",
  ".factory/out/coverage/**", ".factory/out/prove-wt/**", ".factory/out/classify-wt/**",
  ".factory/harness.toml", ".factory/ci-settings*.json", ".factory/roles.toml", ".factory/quarantine.toml",
  ".factory/package.json", ".factory/package-lock.json",
  // 설치 매니페스트(피드백 루프의 주인 표). 에이전트가 이 표를 고칠 수 있으면 "내 파일의 주인은
  // 채택자다"라고 다시 써서 KTB 이슈를 피하거나, 반대로 채택자의 파일을 KTB에 떠넘길 수 있다 —
  // 분류의 근거가 되는 파일이므로 다른 생성물과 같은 대접을 받는다(`factory init`만 쓴다).
  ".factory/install-manifest.json",
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

/**
 * ── ADR-024 / KTB-42(리뷰 라운드 1 SF-1b) — 매니페스트의 **직접 쓰기 철자**만 닫는다 ──────────────
 * `.factory/out/qa/**`는 qa가 쓸 수 있어야 한다(그것이 이 카브아웃의 존재 이유다). 그런데 그 안의
 * `manifest.json`은 **도구가 자식 프로세스로** 쓰는 파일이라, `Write`/`Edit` 도구와 셸 리다이렉션으로
 * 가는 길은 합법 경로에 하나도 쓰이지 않는다. 그 철자만 막으면 정당한 사용은 아무 비용도 치르지 않고,
 * 손으로 매니페스트를 지어내는 길만 한 겹 시끄러워진다.
 *
 * **진위 경계가 아니다**(ADR-024의 정직한 재진술): qa 역할은 여전히 도구를 거쳐 임의의 claim을 남길 수
 * 있고, 이 deny는 그것을 막지 않는다. 막는 것은 "도구를 한 번도 부르지 않고 매니페스트만 손으로 쓰는"
 * 가장 값싼 철자뿐이다.
 */
export const QA_MANIFEST_GLOB = ".factory/out/qa/**/manifest.json";
export const qaManifestDeny = () => ciDenyEntries([QA_MANIFEST_GLOB]);

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
