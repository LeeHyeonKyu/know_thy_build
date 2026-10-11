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
function drifted(pairs, { root = repoRoot, vars: v = vars } = {}) {
  return pairs
    .filter((e) => !existsSync(e.destAbs) || freshContent(e, { readFile: (p) => readFileSync(p, "utf8"), vars: v }) !== readFileSync(e.destAbs, "utf8"))
    .map(({ destAbs }) => relative(root, destAbs).split(sep).join("/"));
}

/**
 * #253 — 빌더 세션(FACTORY_STAGE=implement) 안에서 mirrorStep 가족의 드리프트는 러너의 몫이다: 노트와 함께 통과.
 * 가족 밖(commands)은 RED를 지키되 재생성·커밋을 시키지 않는다. 그 밖의 세션에서 아래 판정은 오늘과 같다.
 * `env`·`root`·`vars`는 주입할 수 있다 — test_253_*가 가짜 드리프트 픽스처로 **이 함수 자체**(바이트 대조 → 판정 → expect)를
 * 두 env 경로 모두에서 돌린다. 위의 실제 self-mirror 테스트는 기본값(ambient `process.env`, 이 저장소)으로 부른다.
 * @returns 통과한 판정(`{ok:true}` 또는 `{ok:true, note}`). RED는 expect가 던진다.
 */
function assertMirrored(pairs, { env = process.env, root = repoRoot, vars: v = vars } = {}) {
  const bad = drifted(pairs, { root, vars: v });
  const verdict = selfMirrorVerdict({ bad, env, hint: UPGRADE_HINT });
  if (verdict.note) return verdict;
  if (!verdict.ok) return void expect(bad, verdict.message).toEqual([]);
  expect(bad, bad.length ? `${bad.join(", ")} — ${UPGRADE_HINT}` : undefined).toEqual([]);
  return verdict;
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

/**
 * tmp에 소스와 **다른** 설치본을 써서 진짜 드리프트한 한 쌍을 만든다. 쌍과 그 루트를 돌려준다 — 바이트 대조는 여기서 하지
 * 않고, 각 env 아래에서 `assertMirrored`가 실제 생산자(`freshContent`)로 매번 다시 한다. `withContext`면 픽스처 루트에
 * `.factory/out/context.json`을 둔다(러너 게이트 프로세스의 모양). 판정은 파일을 읽지 않는다 — 그 파일이 있어도 RED여야 한다.
 */
function driftedFixture(dest, { withContext = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ktb-253-"));
  const src = join(root, "src", "source.txt");
  const destAbs = join(root, ...dest.split("/"));
  mkdirSync(dirname(src), { recursive: true });
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(src, "export const v = 2;\n");
  writeFileSync(destAbs, "export const v = 1;\n");
  if (withContext) {
    mkdirSync(join(root, ".factory", "out"), { recursive: true });
    writeFileSync(join(root, ".factory", "out", "context.json"), "{}\n");
  }
  const pairs = [{ src, dest, destAbs, owner: "factory" }];
  return { pairs, root, opts: { root, vars: {} }, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** assertMirrored가 던진 RED의 메시지(던지지 않으면 null). */
function redOf(fn) {
  try { fn(); return null; } catch (err) { return String(err?.message ?? err); }
}

const FAMILY_SAMPLES = [".factory/lib/x.js", ".factory/bin/run-stage.js", ".factory/actions/gate/action.yml", ".claude/hooks/block-dangerous.sh"];
const COMMAND_SAMPLES = ["implement", "plan", "review", "merge", "triage"].map((n) => `.claude/commands/factory-${n}.md`);

/** 여러 dest가 전부 진짜로 드리프트한 tmp 트리(각 dest마다 자기 소스). */
function driftedTree(dests) {
  const root = mkdtempSync(join(tmpdir(), "ktb-253-"));
  const pairs = dests.map((dest, i) => {
    const src = join(root, "src", `source-${i}.txt`);
    const destAbs = join(root, ...dest.split("/"));
    mkdirSync(dirname(src), { recursive: true });
    mkdirSync(dirname(destAbs), { recursive: true });
    writeFileSync(src, `export const v${i} = 2;\n`);
    writeFileSync(destAbs, `export const v${i} = 1;\n`);
    return { src, dest, destAbs, owner: "factory" };
  });
  return { pairs, opts: { root, vars: {} }, done: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * 이 파일에 있는 실제 `self-mirror: …` 테스트 본문들을 소스 그대로 꺼내 함수로 만든다(`hasDotFactory`·`manifest`·
 * `assertMirrored`·`expect`를 주입). 본문을 손으로 옮겨 적지 않는다 — 그러면 본문이 바뀌어도 이 가드는 모른다.
 */
function realSelfMirrorBodies() {
  const src = readFileSync(new URL(import.meta.url), "utf8");
  return [...src.matchAll(/^test\("(self-mirror: [^"]*)", \(\) => \{\n([\s\S]*?)\n\}\);$/gm)].map(([, title, text]) => ({
    title,
    body: new Function("hasDotFactory", "manifest", "assertMirrored", "expect", text),
  }));
}

test("test_253_self_mirror_passes_with_a_note_inside_a_builder_session", () => {
  expect(BUILDER_SESSION_NOTE).toBe("self-mirror: skipped inside a builder session — the runner regenerates .factory/** after the handoff (mirrorStep)");
  // mockImplementation 없이 엿본다 — 노트는 실제로 출력된다(삼키지 않는다).
  const log = vi.spyOn(console, "log");
  try {
    for (const dest of FAMILY_SAMPLES) {
      const fx = driftedFixture(dest);
      try {
        expect(drifted(fx.pairs, fx.opts)).toEqual([dest]); // 픽스처가 진짜로 드리프트했다 — 아니면 아래 통과는 아무것도 증명하지 않는다
        log.mockClear();
        // 실제 self-mirror 테스트가 판정하는 그 함수(assertMirrored)를 env 주입으로 돈다.
        const inside = assertMirrored(fx.pairs, { ...fx.opts, env: { FACTORY_STAGE: "implement" } });
        expect(inside).toEqual({ ok: true, note: BUILDER_SESSION_NOTE });
        expect(log).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith(BUILDER_SESSION_NOTE);

        log.mockClear();
        const red = redOf(() => assertMirrored(fx.pairs, { ...fx.opts, env: {} }));
        expect(red).not.toBeNull();
        expect(red).toContain(dest);
        expect(red).toContain(UPGRADE_HINT);
        expect(log).not.toHaveBeenCalled();
      } finally { fx.done(); }
    }
    // 드리프트가 없으면 노트도 없다 — 진짜로 비교해 통과한 것을 "skipped"라고 적지 않는다.
    const clean = driftedFixture(".factory/lib/x.js");
    try {
      writeFileSync(clean.pairs[0].destAbs, readFileSync(clean.pairs[0].src, "utf8"));
      log.mockClear();
      expect(assertMirrored(clean.pairs, { ...clean.opts, env: { FACTORY_STAGE: "implement" } })).toEqual({ ok: true });
      expect(log).not.toHaveBeenCalled();
    } finally { clean.done(); }

    // 기본값 배선: env를 넘기지 않으면 assertMirrored는 ambient process.env를 읽는다(실제 self-mirror 테스트의 경로).
    // vi.stubEnv로 바꾸고 unstubAllEnvs로 반드시 되돌린다.
    const fx = driftedFixture(".factory/lib/x.js");
    try {
      vi.stubEnv("FACTORY_STAGE", "implement");
      log.mockClear();
      expect(assertMirrored(fx.pairs, fx.opts)).toEqual({ ok: true, note: BUILDER_SESSION_NOTE });
      expect(log).toHaveBeenCalledTimes(1);
      vi.stubEnv("FACTORY_STAGE", "review");
      expect(redOf(() => assertMirrored(fx.pairs, fx.opts))).toContain(UPGRADE_HINT);
    } finally { vi.unstubAllEnvs(); fx.done(); }

    // 내보낸 테스트 쪽 진입점도 env 인자 없이 부르면 ambient process.env를 따른다(그리고 되돌린 뒤에는 원래 값이다).
    const before = process.env.FACTORY_STAGE;
    try {
      vi.stubEnv("FACTORY_STAGE", "implement");
      expect(isBuilderSession()).toBe(true);
      log.mockClear();
      expect(selfMirrorVerdict({ bad: [".factory/lib/x.js"], hint: UPGRADE_HINT })).toEqual({ ok: true, note: BUILDER_SESSION_NOTE });
      expect(log).toHaveBeenCalledTimes(1);
      vi.stubEnv("FACTORY_STAGE", undefined);
      expect(isBuilderSession()).toBe(false);
      expect(selfMirrorVerdict({ bad: [".factory/lib/x.js"], hint: UPGRADE_HINT })).toEqual({ ok: false, message: `.factory/lib/x.js — ${UPGRADE_HINT}` });
    } finally { vi.unstubAllEnvs(); }
    expect(process.env.FACTORY_STAGE).toBe(before);

    // 실제 self-mirror 테스트 다섯 개의 **본문 그대로**를 진짜 드리프트한 픽스처 위에서 돌린다. 본문 하나라도 env를 무시하는
    // 대조(`{ env: {} }`, `drifted()`를 직접 expect 등)를 부르면 빌더 세션 쪽 기대가 깨진다.
    const realBodies = realSelfMirrorBodies();
    expect(realBodies.map((b) => b.title)).toEqual([
      "self-mirror: .factory/lib/** is byte-identical to factory/lib/**",
      "self-mirror: .factory/bin/** is byte-identical to factory/bin/**",
      "self-mirror: .factory/actions/** is byte-identical to templates/factory/factory/actions/**",
      "self-mirror: .claude/hooks/*.sh is byte-identical to factory/hooks/*.sh",
      "self-mirror: the five .claude/commands/factory-*.md match templates/factory/claude/commands/",
    ]);
    const tree = driftedTree([...FAMILY_SAMPLES, ...COMMAND_SAMPLES]);
    try {
      expect(drifted(tree.pairs, tree.opts)).toEqual([...FAMILY_SAMPLES, ...COMMAND_SAMPLES]);
      const runBody = ({ body }) => body(true, () => tree.pairs, (pairs, o) => assertMirrored(pairs, { ...tree.opts, ...o }), expect);
      for (const real of realBodies) {
        const isCommands = real.title.includes(".claude/commands/");
        vi.stubEnv("FACTORY_STAGE", "implement");
        log.mockClear();
        const inside = redOf(() => runBody(real));
        if (isCommands) {
          expect(inside, real.title).not.toBeNull();
          expect(inside).not.toContain(UPGRADE_HINT);
          expect(inside).toMatch(/runner or the operator/);
          expect(log).not.toHaveBeenCalled();
        } else {
          expect(inside, real.title).toBeNull();
          expect(log).toHaveBeenCalledTimes(1);
          expect(log).toHaveBeenCalledWith(BUILDER_SESSION_NOTE);
        }
        vi.stubEnv("FACTORY_STAGE", undefined);
        const outside = redOf(() => runBody(real));
        expect(outside, real.title).not.toBeNull();
        expect(outside).toContain(UPGRADE_HINT);
      }
    } finally { vi.unstubAllEnvs(); tree.done(); }
  } finally {
    log.mockRestore();
  }
});

test("test_253_runner_gate_env_still_byte_compares_the_mirror", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const envs = [
      {}, { FACTORY_STAGE: "" }, { FACTORY_STAGE: "review" }, { FACTORY_STAGE: "merge" }, { FACTORY_STAGE: "1" },
      { FACTORY_RUNNER_ID: "gha-1" }, // 러너의 게이트 프로세스 모양 — 픽스처 루트에 .factory/out/context.json이 있다
      { GITHUB_ACTIONS: "true", FACTORY_RUNNER_ID: "gha-1" },
      { CLAUDE_PROJECT_DIR: "/repo" },
    ];
    for (const dest of FAMILY_SAMPLES) {
      const fx = driftedFixture(dest, { withContext: true });
      const cwd = process.cwd();
      try {
        // 판정은 root를 받지 않으므로, cwd 기준으로 context.json을 찾는 대체 판정도 이 픽스처를 보게 cwd를 픽스처 루트로 옮긴다
        // (ambient 저장소의 .gitignore된 .factory/out/context.json 유무에 기대지 않는다).
        process.chdir(fx.root);
        expect(existsSync(join(".factory", "out", "context.json"))).toBe(true);
        for (const env of envs) {
          expect(isBuilderSession(env)).toBe(false);
          // 각 env 아래에서 바이트 대조부터 다시 한다(assertMirrored → drifted → freshContent).
          const red = redOf(() => assertMirrored(fx.pairs, { ...fx.opts, env }));
          expect(red, JSON.stringify(env)).not.toBeNull();
          expect(red).toContain(dest);
          expect(red).toContain(UPGRADE_HINT);
          expect(red).not.toContain(BUILDER_SESSION_NOTE);
        }
      } finally { process.chdir(cwd); fx.done(); }
    }
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test("test_253_commands_family_is_never_skipped_because_mirror_step_does_not_regenerate_it", () => {
  const dest = ".claude/commands/factory-implement.md";
  expect(inMirrorFamily(dest)).toBe(false); // mirrorStep의 가족 밖 — 그래서 노트로 통과할 자격이 없다
  const fx = driftedFixture(dest);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(drifted(fx.pairs, fx.opts)).toEqual([dest]);
    const inside = redOf(() => assertMirrored(fx.pairs, { ...fx.opts, env: { FACTORY_STAGE: "implement" } }));
    expect(inside).not.toBeNull();
    expect(inside).toContain(dest);
    expect(inside).not.toContain(UPGRADE_HINT);
    expect(inside).not.toMatch(/init --upgrade/);
    expect(inside).not.toMatch(/commit/i);
    expect(inside).toMatch(/runner or the operator/);

    // 한 묶음에 가족 안·밖이 섞여도 밖의 경로가 RED를 지킨다.
    const mixed = selfMirrorVerdict({ bad: [".factory/lib/x.js", dest], env: { FACTORY_STAGE: "implement" }, hint: UPGRADE_HINT });
    expect(mixed.ok).toBe(false);
    expect(mixed.message).toContain(dest);

    const outside = redOf(() => assertMirrored(fx.pairs, { ...fx.opts, env: {} }));
    expect(outside).not.toBeNull();
    expect(outside).toContain(dest);
    expect(outside).toContain(UPGRADE_HINT);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    fx.done();
  }
  // 개수 핀은 어느 세션에서나 돈다 — 실제 매니페스트에서.
  expect(manifest().filter((e) => /^\.claude\/commands\/factory-.*\.md$/.test(e.dest)).length).toBe(5);
});
