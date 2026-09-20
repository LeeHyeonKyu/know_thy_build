import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const PREFIX = { factory: ".factory", claude: ".claude", github: ".github", docs: "docs" };
const PROJECT_OWNED = [/^\.factory\/harness\.toml$/, /^docs\/factory\/CHARTER\.md$/, /^\.factory\/lessons\/[\w-]+\.md$/];
const SCRIPT_OWNED = [/^\.factory\/quarantine\.toml$/];

export function ownerOf(dest) {
  if (PROJECT_OWNED.some((r) => r.test(dest))) return "project";
  if (SCRIPT_OWNED.some((r) => r.test(dest))) return "script";
  return "factory";
}

export function readdirRecursive(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...readdirRecursive(p)); else out.push(p);
  }
  return out;
}

/** 설치 대상 목록. 테스트 파일·픽스처는 제외. dest는 항상 "/" 구분자. */
export function buildManifest({ pkgRoot, list = readdirRecursive }) {
  const rel = (from, p) => relative(from, p).split(sep).join("/");
  const entries = [];
  for (const p of list(join(pkgRoot, "factory/lib"))) if (p.endsWith(".js")) entries.push({ src: p, dest: `.factory/lib/${rel(join(pkgRoot, "factory/lib"), p)}`, owner: "factory" });
  for (const p of list(join(pkgRoot, "factory/bin"))) if (p.endsWith(".js")) entries.push({ src: p, dest: `.factory/bin/${rel(join(pkgRoot, "factory/bin"), p)}`, owner: "factory" });
  for (const p of list(join(pkgRoot, "factory/hooks"))) {
    if (!p.endsWith(".sh")) continue;
    const dest = `.claude/hooks/${rel(join(pkgRoot, "factory/hooks"), p)}`;
    const e = { src: p, dest, owner: "factory", mode: 0o755 };
    // 외부 감사 M8 — `prot` 목록은 harness.toml `[protected]`에서 생성한다(install.js `freshContent`).
    if (dest === ".claude/hooks/block-dangerous.sh") e.generate = "hook-protected";
    entries.push(e);
  }
  const tRoot = join(pkgRoot, "templates/factory");
  for (const p of list(tRoot)) {
    const r = rel(tRoot, p);
    const [head, ...rest] = r.split("/");
    if (!PREFIX[head]) throw new Error(`template path outside known prefixes: ${r}`);
    const dest = [PREFIX[head], ...rest].join("/");
    const e = { src: p, dest, owner: ownerOf(dest) };
    if (dest === ".claude/settings.json") e.merge = "settings";
    // 피드백 루프(spec §2): 분류는 **인과 파일의 주인**으로 한다 — 그 주인 표가 바로 이 매니페스트다.
    // 그런데 `factory/cli/**`는 설치되지 않고(위 세 루프가 싣는 것은 lib·bin·hooks·templates뿐이다)
    // 배포는 `npx`라 채택자 저장소에는 `node_modules/know-thy-build`도 없다. 그래서 설치 시점에
    // 이 표를 **파일로 떨어뜨린다** — 설치된 러너가 주인을 읽을 수 있는 유일한 자리다(T3 리뷰 MF-2).
    if (dest === ".factory/install-manifest.json") e.generate = "install-manifest";
    // 외부 감사 M8 — 경로 deny는 harness.toml `[protected]`에서 생성한다(install.js `freshContent`).
    if (dest === ".factory/ci-settings.json") e.generate = "ci-settings";
    if (dest === ".factory/ci-settings-harness.json") e.generate = "ci-settings-harness";
    entries.push(e);
  }
  const seen = new Set();
  for (const e of entries) { if (seen.has(e.dest)) throw new Error(`duplicate manifest dest: ${e.dest}`); seen.add(e.dest); }
  return entries;
}
