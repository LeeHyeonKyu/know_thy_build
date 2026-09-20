import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * ── Feedback loop — **설치된 러너가 주인 표를 읽는 자리** (spec §2, T3 리뷰 MF-2) ────────────────
 *
 * `classifyFinding`은 `ownerOf`와 dest 멤버십을 **필수**로 받는다(빠뜨리면 던진다): 없으면 예전
 * 구현처럼 prefix 표로 떨어져 채택자가 쓴 `.claude/`·`.factory/` 파일이 전부 KTB 이슈로 올라간다.
 * 그런데 그 두 함수가 사는 `factory/cli/**`는 **설치되지 않고**(`buildManifest`가 싣는 것은
 * `factory/lib`·`factory/bin`·`factory/hooks`·`templates/factory`뿐이다), 배포는 `npx know-thy-build`라
 * 채택자 저장소에는 `node_modules/know-thy-build`도 생기지 않는다(`setup` 액션의
 * `npm install --prefix .factory`는 `.factory/package.json`의 `smol-toml` 하나만 깐다).
 *
 * 그래서 출처가 셋이고, **순서가 계약이다**:
 *   ① `.factory/install-manifest.json` — `factory init`이 설치 시점에 떨어뜨린 표. 채택자 저장소에서
 *      유일하게 존재하는 출처이고, **실제로 설치된 버전의** 표라 분류가 원하는 바로 그 값이다.
 *   ② 저장소 루트의 `factory/cli/manifest.js` — KTB 자신을 개발하는 저장소(도그푸드).
 *   ③ `node_modules/know-thy-build/…` — 패키지를 의존성으로 깐 드문 경우.
 * 셋 다 없으면 `null`이고, 호출자는 **라우팅하지 않는다**. 주인을 모르는 채 라우팅하는 것보다 이번
 * 창을 넘기는 편이 낫다 — 잘못 간 이슈는 사람이 손으로 치워야 한다.
 *
 * ①의 `owner`는 매니페스트 어휘 그대로다(`factory|project|script`) — `classify.js`가 그 어휘를
 * 읽으므로 여기서 번역하지 않는다. 표에 없는 경로에 대한 `ownerOf`의 답도 실물과 같게 `"factory"`다
 * (`cli/manifest.js`의 전역 기본값) — 다만 멤버십 검사가 먼저 걸리므로 그 답이 쓰이는 일은 없다.
 */

export const INSTALL_MANIFEST_PATH = ".factory/install-manifest.json";
export const INSTALL_MANIFEST_SCHEMA = "factory.install-manifest.v1";

/** 표 한 장 → 분류기가 먹는 `{ ownerOf, isInstalled, ktbVersion }`. 비어 있거나 깨졌으면 null. */
export function fromEntries(doc) {
  const entries = Array.isArray(doc?.entries) ? doc.entries : null;
  if (!entries || !entries.length) return null;
  const map = new Map();
  for (const e of entries) if (e && typeof e.dest === "string") map.set(e.dest, typeof e.owner === "string" ? e.owner : "factory");
  if (!map.size) return null;
  return {
    ownerOf: (dest) => map.get(dest) ?? "factory",
    isInstalled: new Set(map.keys()),
    ktbVersion: typeof doc.ktb_version === "string" ? doc.ktb_version : null,
    source: INSTALL_MANIFEST_PATH,
  };
}

/**
 * `loadInstallManifest(root) → { ownerOf, isInstalled, ktbVersion, source } | null`. 절대 던지지 않는다.
 * fs와 동적 import를 주입받는다(테스트가 "채택자 레이아웃"을 그대로 세울 수 있도록).
 */
export async function loadInstallManifest(root, {
  exists = existsSync,
  read = (p) => readFileSync(p, "utf8"),
  importModule = (href) => import(href),
} = {}) {
  // ① 설치된 표
  const file = join(root, INSTALL_MANIFEST_PATH);
  if (exists(file)) {
    try {
      const doc = JSON.parse(read(file));
      if (doc?.schema !== INSTALL_MANIFEST_SCHEMA) throw new Error(`unexpected schema ${JSON.stringify(doc?.schema)}`);
      const resolved = fromEntries(doc);
      if (resolved) return resolved;
      console.error(`factory: ${INSTALL_MANIFEST_PATH} has no entries — falling back (run \`npx know-thy-build factory init --upgrade\`)`);
    } catch (e) {
      console.error(`factory: could not read ${INSTALL_MANIFEST_PATH} — ${e?.message || e}`);
    }
  }
  // ②③ 패키지 소스가 손에 있으면 거기서 직접 계산한다(도그푸드/의존성 설치).
  for (const cand of [join(root, "factory/cli/manifest.js"), join(root, "node_modules/know-thy-build/factory/cli/manifest.js")]) {
    if (!exists(cand)) continue;
    const pkgRoot = join(cand, "..", "..", "..");
    try {
      const mod = await importModule(pathToFileURL(cand).href);
      const dests = new Set(mod.buildManifest({ pkgRoot }).map((e) => e.dest));
      let ktbVersion = null;
      try { ktbVersion = JSON.parse(read(join(pkgRoot, "package.json"))).version ?? null; } catch { ktbVersion = null; }
      return { ownerOf: mod.ownerOf, isInstalled: dests, ktbVersion, source: cand };
    } catch (e) {
      console.error(`factory: could not read the install manifest at ${cand} — ${e?.message || e}`);
    }
  }
  return null;
}
