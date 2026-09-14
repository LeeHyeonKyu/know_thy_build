import { test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { buildManifest } from "../cli/manifest.js";
import { freshContent } from "../cli/install.js";
import { projectVars } from "../cli/init.js";

/**
 * KTB dogfoods itself (ADR-020): this repo carries its own `.factory/**` mirror, installed by
 * `factory init` from the very `factory/**`/`templates/factory/**` sources this package ships. The two
 * copies drift the moment one is edited without re-running init — and a stale mirror is exactly what a
 * *user's* installed repo would look like if they upgraded the package but forgot `--upgrade`. So this
 * guard is doubly useful: it keeps KTB's own dogfood honest, and it's a live rehearsal of the drift
 * `doctor`'s `files.stale` WARN (lib/doctor/factory.js) is meant to catch in every other repo.
 *
 * A **fresh clone of the package** (npm install of `know-thy-build`, no `factory init` run yet) has no
 * `.factory/` at all — nothing to mirror, nothing to check. Only this repo, which installed itself, has
 * `.factory/` sitting next to the source it was installed from.
 *
 * Scope is deliberately narrower than `buildManifest`'s full install list: harness.toml/roles.toml/CHARTER
 * etc. are project-owned or content-negotiated (`.claude/settings.json` merges rather than mirrors — see
 * `files.stale` for that), so byte-identity is the wrong bar for them. The four families below are the
 * ones `factory init` always overwrites verbatim, so "byte-identical to the packaged source" is exactly
 * the invariant that should hold.
 */
const repoRoot = new URL("../../", import.meta.url).pathname;
const dotFactory = join(repoRoot, ".factory");
const hasDotFactory = existsSync(dotFactory);

const UPGRADE_HINT = "run `node bin/cli.js factory init --upgrade` and commit the mirror";

/** buildManifest(dest는 항상 "/" 구분자)의 dest를 저장소 루트 기준 절대경로로 편다. */
const manifest = () => buildManifest({ pkgRoot: repoRoot }).map((e) => ({ ...e, destAbs: join(repoRoot, ...e.dest.split("/")) }));

/**
 * 비교 기준은 "패키지 소스의 바이트"가 아니라 **`factory init`이 쓸 내용**이다(`freshContent`).
 * 외부 감사 M8 이후 일부 파일은 생성물이다: `block-dangerous.sh`의 `prot` 블록과 ci-settings의 경로
 * deny가 이 저장소의 `harness.toml [protected]`에서 나온다. 소스 바이트로 비교하면 그 파일들이 항상
 * 드리프트로 보이고(그러면 이 가드가 꺼진다), 설치가 실제로 쓰는 것과 다른 것을 검사하게 된다.
 * 생성기가 없는 파일에는 `freshContent`가 바이트 그대로를 돌려주므로 기존 불변식은 그대로다.
 */
const vars = projectVars(repoRoot, repoRoot);
function drifted(pairs) {
  return pairs
    .filter((e) => !existsSync(e.destAbs) || freshContent(e, { readFile: (p) => readFileSync(p, "utf8"), vars }) !== readFileSync(e.destAbs, "utf8"))
    .map(({ destAbs }) => relative(repoRoot, destAbs).split(sep).join("/"));
}

function assertMirrored(pairs) {
  const bad = drifted(pairs);
  expect(bad, bad.length ? `${bad.join(", ")} — ${UPGRADE_HINT}` : undefined).toEqual([]);
}

test("self-mirror: .factory/lib/** is byte-identical to factory/lib/**", () => {
  if (!hasDotFactory) return; // fresh clone of the package — nothing installed yet, nothing to check
  assertMirrored(manifest().filter((e) => e.dest.startsWith(".factory/lib/")));
});

test("self-mirror: .factory/bin/** is byte-identical to factory/bin/**", () => {
  if (!hasDotFactory) return;
  assertMirrored(manifest().filter((e) => e.dest.startsWith(".factory/bin/")));
});

test("self-mirror: .factory/actions/** is byte-identical to templates/factory/factory/actions/**", () => {
  if (!hasDotFactory) return;
  assertMirrored(manifest().filter((e) => e.dest.startsWith(".factory/actions/")));
});

test("self-mirror: .claude/hooks/*.sh is byte-identical to factory/hooks/*.sh", () => {
  if (!hasDotFactory) return;
  assertMirrored(manifest().filter((e) => e.dest.startsWith(".claude/hooks/") && e.dest.endsWith(".sh")));
});

test("self-mirror: the five .claude/commands/factory-*.md match templates/factory/claude/commands/", () => {
  if (!hasDotFactory) return;
  const pairs = manifest().filter((e) => /^\.claude\/commands\/factory-.*\.md$/.test(e.dest));
  expect(pairs.length).toBe(5); // pin the count so a sixth command file silently added later isn't missed
  assertMirrored(pairs);
});
