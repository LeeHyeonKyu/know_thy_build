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
  // #253 — 빌더 세션(FACTORY_STAGE=implement) 안에서 mirrorStep 가족의 드리프트는 러너의 몫이다: 노트와 함께 통과.
  // 가족 밖(commands)은 RED를 지키되 재생성·커밋을 시키지 않는다. 그 밖의 세션에서 아래 판정은 오늘과 같다.
  const verdict = selfMirrorVerdict({ bad, env: process.env, hint: UPGRADE_HINT });
  if (verdict.note) return;
  if (!verdict.ok) return void expect(bad, verdict.message).toEqual([]);
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

// ── #253 — 빌더 세션 안에서 네 가족의 대조는 러너의 몫이다 ────────────────────────────────────────
// 러너의 mirrorStep은 핸드오프 **뒤에** `.factory/**`를 다시 만든다. 그 전의 빌더 세션에서 이 대조는 언제나 RED였고,
// 빌더는 그 RED를 자기 결함으로 읽어 미러를 직접 재생성·커밋했다 → 오버레이 가드가 런을 blocked으로 세웠다(#233).
// 아래 테스트는 ambient `process.env`를 읽지 않는다 — env를 주입하고, 진짜 드리프트한 가짜 픽스처(tmp)로 두 경로를 모두 핀한다.
// 이 테스트 자체가 빌더 세션(FACTORY_STAGE=implement) 안에서 돌기 때문이다(CLAUDE.md SDD 5).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { vi } from "vitest";
import { inMirrorFamily } from "../lib/mirror.js";
import { BUILDER_SESSION_NOTE, isBuilderSession, selfMirrorVerdict } from "./helpers/builder-session.js";

/** tmp에 소스와 **다른** 설치본을 써서 진짜 드리프트한 한 쌍을 만들고, 실제 생산자(`freshContent`)로 드리프트를 잰다. */
function driftedFixture(dest) {
  const dir = mkdtempSync(join(tmpdir(), "ktb-253-"));
  const src = join(dir, "src", "source.txt");
  const destAbs = join(dir, ...dest.split("/"));
  mkdirSync(dirname(src), { recursive: true });
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(src, "export const v = 2;\n");
  writeFileSync(destAbs, "export const v = 1;\n");
  const e = { src, dest, destAbs, owner: "factory" };
  const bad = freshContent(e, { readFile: (p) => readFileSync(p, "utf8"), vars: {} }) !== readFileSync(destAbs, "utf8") ? [dest] : [];
  rmSync(dir, { recursive: true, force: true });
  return bad;
}

const FAMILY_SAMPLES = [".factory/lib/x.js", ".factory/bin/run-stage.js", ".factory/actions/gate/action.yml", ".claude/hooks/block-dangerous.sh"];

test("test_253_self_mirror_passes_with_a_note_inside_a_builder_session", () => {
  expect(BUILDER_SESSION_NOTE).toBe("self-mirror: skipped inside a builder session — the runner regenerates .factory/** after the handoff (mirrorStep)");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const dest of FAMILY_SAMPLES) {
      const bad = driftedFixture(dest);
      expect(bad).toEqual([dest]); // 픽스처가 진짜로 드리프트했다 — 아니면 아래 통과는 아무것도 증명하지 않는다
      log.mockClear();
      const inside = selfMirrorVerdict({ bad, env: { FACTORY_STAGE: "implement" }, hint: UPGRADE_HINT });
      expect(inside.ok).toBe(true);
      expect(inside.note).toBe(BUILDER_SESSION_NOTE);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(BUILDER_SESSION_NOTE);

      log.mockClear();
      const outside = selfMirrorVerdict({ bad, env: {}, hint: UPGRADE_HINT });
      expect(outside.ok).toBe(false);
      expect(outside.note).toBeUndefined();
      expect(outside.message).toContain(dest);
      expect(outside.message).toContain(UPGRADE_HINT);
      expect(log).not.toHaveBeenCalled();
    }
    // 드리프트가 없으면 노트도 없다 — 진짜로 비교해 통과한 것을 "skipped"라고 적지 않는다.
    expect(selfMirrorVerdict({ bad: [], env: { FACTORY_STAGE: "implement" }, hint: UPGRADE_HINT })).toEqual({ ok: true });
    expect(log).toHaveBeenCalledTimes(0);
  } finally {
    log.mockRestore();
  }
});

test("test_253_runner_gate_env_still_byte_compares_the_mirror", () => {
  const ctxDir = mkdtempSync(join(tmpdir(), "ktb-253-ctx-"));
  mkdirSync(join(ctxDir, ".factory", "out"), { recursive: true });
  writeFileSync(join(ctxDir, ".factory", "out", "context.json"), "{}\n");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const envs = [
      {}, { FACTORY_STAGE: "" }, { FACTORY_STAGE: "review" }, { FACTORY_STAGE: "merge" }, { FACTORY_STAGE: "1" },
      { FACTORY_RUNNER_ID: "gha-1" }, // 러너의 게이트 프로세스 모양 — `root`의 .factory/out/context.json이 있다
      { GITHUB_ACTIONS: "true", FACTORY_RUNNER_ID: "gha-1" },
      { CLAUDE_PROJECT_DIR: "/repo" },
    ];
    for (const dest of FAMILY_SAMPLES) {
      const bad = driftedFixture(dest);
      expect(bad).toEqual([dest]);
      for (const env of envs) {
        expect(isBuilderSession(env)).toBe(false);
        const v = selfMirrorVerdict({ bad, env, hint: UPGRADE_HINT, root: ctxDir });
        expect(v.ok, JSON.stringify(env)).toBe(false);
        expect(v.note).toBeUndefined();
        expect(v.message).toContain(dest);
        expect(v.message).toContain(UPGRADE_HINT);
      }
    }
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    rmSync(ctxDir, { recursive: true, force: true });
  }
});

test("test_253_commands_family_is_never_skipped_because_mirror_step_does_not_regenerate_it", () => {
  const dest = ".claude/commands/factory-implement.md";
  expect(inMirrorFamily(dest)).toBe(false); // mirrorStep의 가족 밖 — 그래서 노트로 통과할 자격이 없다
  const bad = driftedFixture(dest);
  expect(bad).toEqual([dest]);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const inside = selfMirrorVerdict({ bad, env: { FACTORY_STAGE: "implement" }, hint: UPGRADE_HINT });
    expect(inside.ok).toBe(false);
    expect(inside.note).toBeUndefined();
    expect(inside.message).toContain(dest);
    expect(inside.message).not.toContain(UPGRADE_HINT);
    expect(inside.message).not.toMatch(/init --upgrade/);
    expect(inside.message).not.toMatch(/commit/i);
    expect(inside.message).toMatch(/runner or the operator/);

    // 한 묶음에 가족 안·밖이 섞여도 밖의 경로가 RED를 지킨다.
    const mixed = selfMirrorVerdict({ bad: [".factory/lib/x.js", dest], env: { FACTORY_STAGE: "implement" }, hint: UPGRADE_HINT });
    expect(mixed.ok).toBe(false);
    expect(mixed.message).toContain(dest);

    const outside = selfMirrorVerdict({ bad, env: {}, hint: UPGRADE_HINT });
    expect(outside.ok).toBe(false);
    expect(outside.message).toContain(dest);
    expect(outside.message).toContain(UPGRADE_HINT);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
  // 개수 핀은 어느 세션에서나 돈다 — 실제 매니페스트에서.
  expect(manifest().filter((e) => /^\.claude\/commands\/factory-.*\.md$/.test(e.dest)).length).toBe(5);
});
