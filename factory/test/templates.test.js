import { test, expect } from "vitest";
import { MERGE_ENVIRONMENT } from "../lib/bootstrap.js";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as toml } from "smol-toml";
import { parseFrontmatter } from "../lib/frontmatter.js";
import { matchesAny } from "../lib/glob.js";
import { readdirRecursive } from "../cli/manifest.js";
import { renderCiSettings } from "../cli/install.js";

const T = new URL("../../templates/factory/", import.meta.url).pathname;
const readRaw = (p) => readFileSync(join(T, p), "utf8");
/**
 * 2026-09-14 외부 감사 M8 이후 `ci-settings*.json`의 경로 deny는 **생성물**이다 — 템플릿 파일에는
 * 비경로 항목(`Bash(gh secret*)`·`Read(.env*)`)만 남고, `Edit(...)`/`Write(...)`는 `factory init`이
 * `harness.toml [protected]`에서 만든다. 아래 테스트들이 묻는 것은 "채택자에게 설치되는 L2가 무엇을
 * 막는가"이므로, 그 두 파일만 생성 결과로 읽는다(나머지 템플릿은 파일 그대로).
 */
const TEMPLATE_PROTECTED = toml(readRaw("factory/harness.toml")).protected;
const read = (p) => (/^factory\/ci-settings[^/]*\.json$/.test(p)
  ? renderCiSettings(readRaw(p), TEMPLATE_PROTECTED, { harnessMode: p.includes("harness") })
  : readRaw(p));

test("harness.toml template parses and is an M0 fast-only harness", () => {
  const h = toml(read("factory/harness.toml"));
  expect(h.schema).toBe(1);
  expect(h.project.name).toBe("{{PROJECT_NAME}}");
  expect(h.project.default_branch).toBe("main");
  expect(h.harness.maturity).toBe("M0");
  expect(h.factory.orchestration).toBe("workflow");
  expect(h.factory.required_checks).toEqual(["factory/gates", "factory/review", "factory/integrity"]);
  for (const g of h.gates.required) expect(h.gates.fast).toContain(g);
  for (const c of ["lint", "unit", "test_files", "test_one", "lint_file"]) expect(typeof h.commands[c]).toBe("string");
  expect(h.commands.test_files).toContain("{files}");
  expect(h.commands.test_one).toContain("{file}"); expect(h.commands.test_one).toContain("{name}");
  expect(h.commands.lint_file).toContain("{file}");
  expect(h.protected.factory).toContain(".factory/**");
  expect(h.test.test_glob.length).toBeGreaterThan(0);
});

// G1: [runtime].setup only runs actions/setup-node + itself — a repo needing another toolchain (Flutter,
// Python, …) has to express it inline in `setup` and extend PATH via $GITHUB_PATH. The harness.toml template
// documents that contract with a Flutter example right next to the key it governs; the parser doesn't see
// this (it's a comment), so assert it on the raw text.
test("harness.toml template documents [runtime].setup_note with the $GITHUB_PATH / Flutter example (G1)", () => {
  const raw = read("factory/harness.toml");
  const runtimeStart = raw.indexOf("[runtime]");
  const runtimeBlock = raw.slice(runtimeStart, raw.indexOf("\n[", runtimeStart + 1));
  expect(runtimeBlock).toContain("setup_note");
  expect(runtimeBlock).toContain("$GITHUB_PATH");
  expect(runtimeBlock).toContain("own step");
  expect(runtimeBlock.toLowerCase()).toContain("flutter");
  // 여전히 유효한 TOML이어야 한다 — 주석은 smol-toml이 그냥 건너뛴다
  expect(toml(raw).runtime).toEqual({ setup: "npm ci", node: "22" });
});

test("harness.toml template protects the build-config files the gate commands resolve through (F9)", () => {
  const h = toml(read("factory/harness.toml"));
  for (const g of ["package.json", "package-lock.json", "vitest.config.*", "playwright.config.*", "tsconfig*.json", ".eslintrc*", "eslint.config.*"]) {
    expect(h.protected.factory, g).toContain(g);
  }
  // 기존 보호 대상은 그대로다
  // ADR-021 r1 MF-2 c — 워크플로 일곱 장이 아니라 `.github/**` 전부다(다른 이름의 워크플로도, CODEOWNERS도).
  for (const g of [".factory/**", ".claude/**", ".github/**", "docs/factory/CHARTER.md"]) {
    expect(h.protected.factory, g).toContain(g);
  }
  expect(h.protected.except).toContain(".factory/lessons/**");
  // F3: qa 리뷰어의 증거 디렉터리 — 쓸 수 없으면 "증거 없는 재현은 일어나지 않은 재현"이 성립하지 않는다.
  expect(h.protected.except).toContain(".factory/out/qa/**");
  expect(h.evidence.qa_artifacts).toBe(".factory/out/qa/**");
});

test("roles.toml template defines every role the CHARTER template names", () => {
  const roles = toml(read("factory/roles.toml"));
  const { data: charter } = parseFrontmatter(read("docs/factory/CHARTER.md"));
  for (const names of Object.values(charter.roster)) for (const n of names) expect(roles.review[n], `review.${n}`).toBeDefined();
  for (const names of Object.values(charter.plan_roles)) for (const n of names) expect(roles.plan[n], `plan.${n}`).toBeDefined();
  expect(roles.triage.agent).toBe(".claude/agents/factory-triage.md");
  expect(roles.implement.builder.agent).toBe(".claude/agents/factory-builder.md");
  for (const [stage, block] of Object.entries(roles)) {
    if (stage === "schema") continue;
    const entries = block.agent ? { _: block } : block;
    for (const [n, def] of Object.entries(entries)) {
      expect(def.agent, `${stage}.${n}`).toMatch(/^\.claude\/agents\/[\w-]+\.md$/);
      if (def.lessons) expect(existsSync(join(T, "factory/lessons", def.lessons.replace(".factory/lessons/", ""))), def.lessons).toBe(true);
    }
  }
});

test("CHARTER template is a draft with the §5.3 frontmatter", () => {
  const { data } = parseFrontmatter(read("docs/factory/CHARTER.md"));
  expect(data.schema).toBe("factory.charter.v1");
  expect(data.status).toBe("draft");
  expect(data.limits).toEqual({ K: 3, M: 3, R: 2 });
  expect(data.retro.every_merges).toEqual({ initial: 1, min: 1, max: 20 });
});

test("lessons skeletons carry the integrity header", () => {
  const files = readdirSync(join(T, "factory/lessons"));
  expect(files.length).toBe(14);   // 감사 M5 — factory-loader의 lessons 파일이 역할과 함께 사라졌다
  for (const f of files) {
    const role = f.replace(/\.md$/, "");
    expect(read(`factory/lessons/${f}`)).toMatch(new RegExp(`<!--\\s*factory-lessons:v1\\s+role=${role}\\s+max=\\d+\\s*-->`));
  }
});

test("settings.json template has the §6.3 deny list, all four hook events, and record-agents on Subagent*", () => {
  const s = JSON.parse(read("claude/settings.json"));
  for (const d of ["Bash(gh pr merge*)", "Bash(git push --force*)", "Bash(git merge*)", "Bash(gh api -X PUT /repos/*/branches/*/protection*)"]) expect(s.permissions.deny).toContain(d);
  // ADR-019: 경로 deny는 여기 없다 — deny는 사람의 대화형 세션에도 걸리고 allow로 못 이기므로,
  // 여기 두면 `:harness`·`:role`·`:technical`이 자기 일을 할 수 없다. 전부 ci-settings.json으로 옮겼다.
  for (const d of s.permissions.deny) expect(d, d).toMatch(/^Bash\(/);
  const cmds = (ev) => s.hooks[ev].flatMap((e) => e.hooks.map((h) => h.command));
  expect(cmds("PreToolUse")).toContain(".claude/hooks/block-dangerous.sh");
  expect(cmds("PostToolUse")).toContain(".claude/hooks/lint-touched.sh");
  expect(cmds("Stop")).toContain(".claude/hooks/stop-guard.sh");
  expect(cmds("SubagentStart")).toContain(".claude/hooks/record-agents.sh");
  // stop-guard는 Stop만이 아니라 SubagentStop에도 걸린다(F6): 실제로 일하는 것은 서브에이전트다 —
  // builder는 자기 서브에이전트가 끝나기 전에 commit+push를 마쳐야 하고, reviewer는 트리를 깨끗이 두고 나가야
  // 한다. 메인 세션의 Stop에서만 검사하면 그 사실이 workflow가 다 끝난 뒤에야 드러난다.
  expect(cmds("SubagentStop")).toEqual(expect.arrayContaining([".claude/hooks/record-agents.sh", ".claude/hooks/verdict-format.sh", ".claude/hooks/stop-guard.sh"]));
  const hooksDir = new URL("../hooks/", import.meta.url).pathname;
  for (const ev of Object.keys(s.hooks)) for (const c of cmds(ev)) expect(existsSync(join(hooksDir, c.replace(".claude/hooks/", ""))), c).toBe(true);
});

// KTB-13: `--permission-mode dontAsk`는 allow에 걸리지 않는 도구 호출을 **자동 거절**한다("묻지 않는다"가
// "승인한다"가 아니다 — ADR-002/008의 스파이크 관측은 지금 CLI에서 더는 성립하지 않는다). allow 목록이
// 곧 에이전트가 가진 도구다: builder가 Edit/Write 없이 코드를 쓸 수 없고, 좁은 Bash 목록은 `mkdir`·
// `cat > file` 같은 정당한 명령까지 막았다. 가드는 deny(두 파일) + block-dangerous.sh + integrity다.
test("settings.json allow grants the tools the factory agents actually need under dontAsk (KTB-13)", () => {
  const s = JSON.parse(read("claude/settings.json"));
  for (const a of ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS",
    "Agent", "Workflow", "TodoWrite", "Bash(*)"]) {
    expect(s.permissions.allow, a).toContain(a);
  }
  // 좁은 Bash allow는 남지 않는다 — `Bash(*)`가 그것을 포함하고, 좁은 목록이 곧 차단 목록이었다.
  expect(s.permissions.allow.filter((a) => a.startsWith("Bash("))).toEqual(["Bash(*)"]);
  // 머지는 여전히 builder의 일이 아니다 — allow가 넓어져도 deny가 이긴다.
  for (const d of ["Bash(gh pr merge*)", "Bash(git push --force*)"]) expect(s.permissions.deny).toContain(d);
});

test("ci-settings.json deny covers the build-config files, matching [protected].factory (F9 / ADR-019)", () => {
  const s = JSON.parse(read("factory/ci-settings.json"));
  const h = toml(read("factory/harness.toml"));
  for (const g of ["package.json", "package-lock.json", "vitest.config.*", "playwright.config.*", "tsconfig*.json", ".eslintrc*", "eslint.config.*"]) {
    expect(s.permissions.deny, `Edit(${g})`).toContain(`Edit(${g})`);
    expect(s.permissions.deny, `Write(${g})`).toContain(`Write(${g})`);
    expect(h.protected.factory, g).toContain(g);   // 두 목록이 갈라지면 L2가 막는 것과 L1 integrity가 보는 것이 달라진다
  }
  // 팩토리 소유 경로도 여기 있다 — 스펙 §6.3의 목록이 통째로 CI 파일로 옮겨왔다는 뜻이다.
  // KTB-36: `.factory/**` 한 줄은 더 이상 없다(그 한 줄이 qa의 증거 디렉터리까지 덮었다) — 열거가 대신한다.
  for (const d of ["Edit(.factory/bin/**)", "Write(.factory/bin/**)", "Edit(.factory/harness.toml)",
    "Edit(.claude/**)", "Write(.claude/**)",
    "Edit(.github/**)", "Write(.github/**)",
    "Edit(docs/factory/CHARTER.md)", "Write(docs/factory/CHARTER.md)"]) expect(s.permissions.deny, d).toContain(d);
  for (const d of ["Edit(.factory/**)", "Write(.factory/**)"]) expect(s.permissions.deny, d).not.toContain(d);
  // CI 전용 deny(비밀·삭제)는 그대로 남아 있다.
  for (const d of ["Bash(gh secret*)", "Read(.env)"]) expect(s.permissions.deny, d).toContain(d);
});

// ── KTB-36: L2의 `.factory/**` 통짜 deny가 qa의 증거 디렉터리를 덮고 있었다 ────────────────────
// 라이브 KTB #3(라운드 R3 → 하네스 이슈 #7): qa 리뷰어는 증거를 `.factory/out/qa/**`에 남기도록
// **명령받고**(`reviewer-qa.md`, `[evidence].qa_artifacts`), 두 훅은 정확히 그 디렉터리를 카브아웃
// 해 두었다(F3). 그런데 모든 스테이지가 `--settings .factory/ci-settings.json`으로 받는 L2는
// `Edit/Write(.factory/**)`를 deny하고 있었고, **Claude Code에서 deny는 allow를 이긴다** — allow에
// 한 줄을 더해도 카브아웃이 되지 않는다. 결과: qa는 증거를 한 줄도 남기지 못하고,
// spec-conformance는 "증거가 없다"로 매 라운드를 거부했다. 통짜 deny를 **열거**로 바꿔 푼다.
//
// 매처는 저장소의 `lib/glob.js`(`**` = 디렉터리 임의 깊이, `*` = 슬래시를 넘지 않음)를 쓴다 —
// Claude Code의 경로 글롭 의미와 같고, 그래서 `.factory/out/*`는 **직계 자식만** 잡는다.
const QA_EVIDENCE = [
  ".factory/out/qa/3-shot.png", ".factory/out/qa/3-server.log", ".factory/out/qa/deep/3.log",
];
// 열거가 반드시 덮어야 하는 것들. 런타임에만 생기는 경로(bin·lib·out·node_modules)는 템플릿 트리를
// 훑어도 보이지 않으므로 여기서 이름으로 못 박는다(KTB-20의 같은 이유).
const PROTECTED_FACTORY = [
  ".factory/harness.toml", ".factory/roles.toml", ".factory/quarantine.toml",
  ".factory/ci-settings.json", ".factory/ci-settings-harness.json",
  ".factory/package.json", ".factory/package-lock.json",
  ".factory/bin/run-stage.js", ".factory/lib/gates.js", ".factory/actions/setup/action.yml",
  ".factory/lessons/factory-builder.md", ".factory/scenarios/export.md",
  ".factory/node_modules/smol-toml/index.js",
  ".factory/out/gates.json", ".factory/out/context.json", ".factory/out/agents.jsonl",
  ".factory/out/test-env.pids", ".factory/out/unit.json", ".factory/out/triage.envelope.json",
  ".factory/out/coverage/coverage-final.json", ".factory/out/prove-wt/src/a.js",
  ".factory/out/classify-wt/src/a.js",
];
const denyGlobs = (file, tool) =>
  JSON.parse(read(file)).permissions.deny.map((d) => new RegExp(`^${tool}\\((.+)\\)$`).exec(d)?.[1]).filter(Boolean);

test("ci-settings.json lets qa write its mandated evidence — no deny pattern matches .factory/out/qa/** (KTB-36)", () => {
  for (const f of ["factory/ci-settings.json", "factory/ci-settings-harness.json"]) {
    for (const tool of ["Edit", "Write"]) {
      const globs = denyGlobs(f, tool);
      for (const p of QA_EVIDENCE) expect(matchesAny(globs, p), `${f} ${tool} ${p}`).toBe(false);
    }
  }
});

test("ci-settings.json still denies every other .factory path — the enumeration replaces the blanket, it does not open it (KTB-36)", () => {
  for (const tool of ["Edit", "Write"]) {
    const globs = denyGlobs("factory/ci-settings.json", tool);
    for (const p of PROTECTED_FACTORY) expect(matchesAny(globs, p), `${tool} ${p}`).toBe(true);
    // 템플릿 트리의 모든 파일도 같은 대접을 받는다 — 새 `.factory` 템플릿 파일이 생기면 여기서 걸린다.
    const fRoot = join(T, "factory");
    for (const p of readdirRecursive(fRoot)) {
      const dest = `.factory/${p.slice(fRoot.length + 1)}`;
      expect(matchesAny(globs, dest), `${tool} ${dest}`).toBe(true);
    }
  }
});

// ADR-020 최종 리뷰 SF-1 — 크리덴셜은 `.env`에만 있는 것이 아니다. CI 트리의 `.git/config`에는
// `actions/checkout`이 심은 `AUTHORIZATION: basic <base64(x-access-token:<token>)>`가 **실제로**
// 들어 있고(락 push 때문에 끌 수 없다), 그것을 읽은 에이전트의 출력은 트랜스크립트를 타고 아티팩트로
// 나간다. 업로드 직전 스크럽이 마지막 방어라면, 이 deny는 **애초에 읽지 않게 하는** 첫 방어다.
// 두 변형 모두에 있어야 한다 — 하네스 이슈의 에이전트라고 해서 토큰을 읽을 이유는 없다.
test("both CI settings deny reading credential files — .git/config, .netrc, .npmrc (SF-1)", () => {
  for (const f of ["factory/ci-settings.json", "factory/ci-settings-harness.json"]) {
    const deny = new Set(JSON.parse(read(f)).permissions.deny);
    for (const d of ["Read(.git/config)", "Read(.git/**)", "Read(**/.netrc)", "Read(**/.npmrc)"]) {
      expect(deny.has(d), `${f} ${d}`).toBe(true);
    }
  }
});

// ── KTB-20: `factory:harness` 이슈 전용 변형 ─────────────────────────────────────────────────────
// 도그푸딩 관측: retro가 만든 `harness: promote to M2` 이슈(#15)에서 builder는 `.factory/harness.toml`·
// 컴포즈·e2e 설정을 **하나도** 건드릴 수 없었다 — ci-settings.json이 `Edit/Write(.factory/**)`를 막고
// block-dangerous.sh가 셸 쓰기를 막는다. 그래서 "승격 PR"에 승격이 들어 있지 않았고 전부 사람에게
// 미뤄졌다. 스펙의 의도(§5.2.1)는 정반대다: **인프라 작업은 factory가 하고 사람은 그 diff를 머지한다.**
// 변형 설정 파일은 그 의도를 성립시키되, 열리는 것은 테스트 인프라 파일뿐이다.
test("ci-settings-harness.json opens exactly the test-infra files a promotion touches, and nothing else (KTB-20)", () => {
  const base = JSON.parse(read("factory/ci-settings.json"));
  const hv = JSON.parse(read("factory/ci-settings-harness.json"));
  const baseDeny = new Set(base.permissions.deny);
  const deny = new Set(hv.permissions.deny);

  // ① 열린 것: harness.toml + 러너 설정 파일 + 매니페스트. `.factory/**` 통짜 deny도 같이 사라진다(대신 ③).
  // package.json/락파일은 KTB-23이 더했다 — 의존성 추가가 바로 하네스 이슈가 하려는 일이라, 그것을
  // 막으면 데모 #2의 벽("Harness change needed" → verifier reject → needs-human)이 하네스 이슈 안에서
  // 그대로 재현된다. 머지는 그대로 사람이다(`[protected].factory`가 package.json을 계속 들고 있다).
  // KTB-36: base의 `.factory/**` 통짜 deny는 열거로 바뀌었다 — 이 변형이 빼는 `.factory` 항목도
  // 이제 `harness.toml` **한 줄**이다(나머지 `.factory` 열거는 base와 글자 그대로 같다).
  for (const d of ["Edit(.factory/harness.toml)", "Write(.factory/harness.toml)",
    "Edit(vitest.config.*)", "Write(vitest.config.*)",
    "Edit(playwright.config.*)", "Write(playwright.config.*)",
    "Edit(package.json)", "Write(package.json)",
    "Edit(package-lock.json)", "Write(package-lock.json)"]) {
    expect(baseDeny.has(d), `base must deny ${d}`).toBe(true);
    expect(deny.has(d), `harness variant must NOT deny ${d}`).toBe(false);
  }
  // 단 `.factory/package.json`(러너 자신의 매니페스트)은 이름으로 다시 막힌다 — 그것을 열면 게이트를
  // 돌리는 런타임 자체를 바꿀 수 있다.
  for (const d of ["Edit(.factory/package.json)", "Write(.factory/package.json)"]) expect(deny.has(d), d).toBe(true);
  // docker-compose.test.yml·.env.test는 어느 목록에도 없다 — 이미 쓸 수 있으므로 뺄 것이 없다.
  for (const d of [...baseDeny]) expect(d, d).not.toMatch(/docker-compose|\.env\.test/);

  // ② 나머지는 한 줄도 느슨해지지 않았다 — 변형은 base의 **부분집합**에 ③의 추가 deny만 얹는다.
  for (const d of baseDeny) {
    if (/\(\.factory\/harness\.toml\)|vitest\.config|playwright\.config|\((package\.json|package-lock\.json)\)/.test(d)) continue;
    expect(deny.has(d), `harness variant dropped ${d}`).toBe(true);
  }

  // ③ `.factory/**`를 통짜로 여는 대신, harness.toml을 뺀 나머지를 이름으로 다시 막는다.
  //    새 `.factory` 템플릿 파일이 생기면 이 루프가 그것이 빠졌다고 말한다 — 열거는 조용히 늙는다.
  const editGlobs = [...deny].map((d) => /^Edit\((.+)\)$/.exec(d)?.[1]).filter(Boolean);
  const writeGlobs = [...deny].map((d) => /^Write\((.+)\)$/.exec(d)?.[1]).filter(Boolean);
  const fRoot = join(T, "factory");
  for (const p of readdirRecursive(fRoot)) {
    const dest = `.factory/${p.slice(fRoot.length + 1)}`;
    const open = dest === ".factory/harness.toml";               // 이것 하나가 이 변형의 존재 이유다
    expect(matchesAny(editGlobs, dest), `Edit ${dest}`).toBe(!open);
    expect(matchesAny(writeGlobs, dest), `Write ${dest}`).toBe(!open);
  }
});

// 리뷰 leftover: 위 KTB-20 테스트의 ③ 열거는 `templates/factory/factory/`를 그대로 훑는다 — 그런데
// `.factory/bin/**`·`.factory/lib/**`·`.factory/out/**`는 **템플릿 파일이 아니다**(bin·lib는 npm
// 패키지 코드가 설치 시 복사되고, out은 게이트가 실행 중에 만든다 — 셋 다 `templates/factory/factory/`
// 아래에 존재하지 않는다). 그래서 열거는 이 세 글롭이 harness 변형에서 빠지는 사고를 절대 잡지 못한다
// — 여기서 이름으로 못 박는다.
test("ci-settings-harness.json explicitly denies .factory/bin, .factory/lib, .factory/out — the enumeration can't see them (KTB-20)", () => {
  const hv = JSON.parse(read("factory/ci-settings-harness.json"));
  const deny = new Set(hv.permissions.deny);
  // KTB-36: `.factory/out/**`는 qa의 증거 디렉터리까지 덮으므로 더는 쓰지 않는다 — 직계 파일
  // (`out/*`)과 qa가 아닌 하위 디렉터리를 이름으로 막는다. 두 변형의 out 열거는 글자 그대로 같다.
  for (const dir of [".factory/bin/**", ".factory/lib/**", ".factory/out/*",
    ".factory/out/coverage/**", ".factory/out/prove-wt/**", ".factory/out/classify-wt/**"]) {
    expect(deny.has(`Edit(${dir})`), `Edit(${dir})`).toBe(true);
    expect(deny.has(`Write(${dir})`), `Write(${dir})`).toBe(true);
  }
  for (const d of ["Edit(.factory/out/**)", "Write(.factory/out/**)"]) expect(deny.has(d), d).toBe(false);
  // 그리고 그 열거가 실제로 qa만 남기는지는 매처로 확인한다(KTB-36 테스트와 같은 의미).
  for (const tool of ["Edit", "Write"]) {
    const globs = denyGlobs("factory/ci-settings-harness.json", tool);
    for (const p of PROTECTED_FACTORY) {
      if (p === ".factory/harness.toml") continue;                 // 이 변형의 존재 이유
      expect(matchesAny(globs, p), `${tool} ${p}`).toBe(true);
    }
  }
  // KTB-23 fix: 러너의 락파일도 템플릿 파일이 아니다(npm이 만든다) — 열거가 못 보므로 이름으로 못 박는다.
  // 매니페스트만 막고 락을 열어 두면 "설치되는 코드"는 여전히 바뀐다.
  for (const f of [".factory/package.json", ".factory/package-lock.json"]) {
    expect(deny.has(`Edit(${f})`), `Edit(${f})`).toBe(true);
    expect(deny.has(`Write(${f})`), `Write(${f})`).toBe(true);
  }
});

test("dispatcher commands exist for the four LLM stages plus retro, and each names its workflow", () => {
  for (const s of ["triage", "plan", "implement", "review"]) {
    const t = read(`claude/commands/factory-${s}.md`);
    expect(t).toMatch(new RegExp(`allowed-tools: Workflow\\(factory-${s}\\)`));
    expect(t).toContain("`factory-" + s + "`");
    // 감사 M5 — 네 디스패처 모두 `.factory/out/loaded.json`(Node가 만든 문맥 payload)을 넘긴다.
    // review만은 `context.json` 경로를 args에 아예 싣지 않는다 — 리뷰어는 역할별 파일만 본다(H4).
    expect(t).toContain(".factory/out/loaded.json");
    if (s !== "review") expect(t).toContain(".factory/out/context.json");
  }
  // retro는 스테이지가 아니다(라벨 상태 머신 밖의 잡) — context.json이 아니라 L1이 써 둔 후보 파일을 받는다.
  const retro = read("claude/commands/factory-retro.md");
  expect(retro).toMatch(/allowed-tools: Workflow\(factory-retro\)/);
  expect(retro).toContain("`factory-retro`");
  expect(retro).toContain(".factory/out/retro-candidates.json");
  expect(retro).not.toContain("context.json");
  expect(readdirSync(join(T, "claude/commands")).sort()).toEqual([
    "factory-implement.md", "factory-plan.md", "factory-retro.md", "factory-review.md", "factory-triage.md",
  ]);
  expect(existsSync(join(T, "claude/commands/factory-merge.md"))).toBe(false);
});

// ADR-020 KTB-27 fix — Claude Code does not substitute positional `$1`/`$2` in a command md, only
// `$ARGUMENTS` (verified live: `claude -p "/argtest 42 true"` turned `$1` into "true" and left `$2`
// as the literal text "$2"; `$ARGUMENTS` alone came through as "42 true"). KTB-23 r1's `$1`/`$2` form
// would have malformed every implement Workflow call, so implement carries both tokens in one
// `$ARGUMENTS` string (`raw`) and the workflow itself splits them — no dispatcher md ever contains
// a bare `$1` or `$2`.
test("the implement dispatcher passes $ARGUMENTS as raw — no $1/$2 (KTB-27 fix)", () => {
  const t = read("claude/commands/factory-implement.md");
  expect(t).toContain('{ "raw": "$ARGUMENTS", "context": ".factory/out/context.json", "loaded": <that object> }');
  expect(t).toContain("`true` or `false`");
  expect(t).not.toMatch(/\$1\b/);
  expect(t).not.toMatch(/\$2\b/);
  // 나머지 세 디스패처는 한 글자도 바뀌지 않는다 — 인자가 하나뿐이다
  for (const s of ["triage", "plan", "review"]) {
    const o = read(`claude/commands/factory-${s}.md`);
    expect(o, s).toContain(s === "review" ? '{ "issue": $ARGUMENTS, "loaded": <that object> }' : '{ "issue": $ARGUMENTS, "context": ".factory/out/context.json", "loaded": <that object> }');
    expect(o, s).not.toContain("harness_issue");
  }
});

// KTB-27: no command md anywhere in the template set may read a positional `$1`/`$2` — Claude Code
// only substitutes `$ARGUMENTS`, so a bare `$1`/`$2` is always a bug, not a valid dispatcher shape.
test("no command md contains an unsubstituted positional $1/$2 (KTB-27)", () => {
  for (const s of ["triage", "plan", "implement", "review", "retro"]) {
    const t = read(`claude/commands/factory-${s}.md`);
    expect(t, s).not.toMatch(/\$1\b/);
    expect(t, s).not.toMatch(/\$2\b/);
  }
});

/**
 * KTB-7: 데모 #2 plan에서 디스패처가 약 20 KB짜리 workflow 결과를 "요약"해 최종 메시지에
 * JS 주석과 `…` 축약을 섞어 넣었고, 스테이지가 needs-human으로 끝났다($11.95·60분 소각).
 * "verbatim"만으로는 부족했다 — 요약이 **하드 실패**라는 것과 형식(생 JSON 한 덩어리)을 못 박는다.
 */
test("dispatcher commands forbid summarizing the workflow result and pin the output shape", () => {
  for (const s of ["triage", "plan", "implement", "review", "retro"]) {
    const t = read(`claude/commands/factory-${s}.md`);
    expect(t, s).toMatch(/complete and\s+verbatim/i);
    expect(t, s).toMatch(/summariz|truncat/i);
    expect(t, s).toMatch(/hard failure/i);
    expect(t, s).toMatch(/raw JSON/i);
  }
});

// ── Task 6: the Claude-side templates the four stages actually load ──────────────────────────
// ADR-015 / P3-R7: there is no merge workflow (merge is a script). retro is the fifth workflow but
// not a fifth stage — it is the Plan 4 job that runs outside the label state machine.
const WORKFLOW_STAGES = ["triage", "plan", "implement", "review"];
const WORKFLOW_SCRIPTS = [...WORKFLOW_STAGES, "retro"];

test("the five workflows exist, each meta.name is its own basename, and there is no factory-merge.js", () => {
  const dir = join(T, "claude/workflows");
  expect(readdirSync(dir).sort()).toEqual(WORKFLOW_SCRIPTS.map((s) => `factory-${s}.js`).sort());
  for (const s of WORKFLOW_SCRIPTS) {
    const src = read(`claude/workflows/factory-${s}.js`);
    // `agentType`/`Workflow(factory-<s>)` 배선이 파일명을 그대로 쓴다 — meta.name이 어긋나면 디스패처가 못 찾는다.
    const m = /^\s*name:\s*['"]([^'"]+)['"]/m.exec(src);
    expect(m && m[1], `factory-${s}.js meta.name`).toBe(`factory-${s}`);
    expect(src.startsWith("export const meta = {"), `factory-${s}.js first line`).toBe(true);
  }
  expect(existsSync(join(dir, "factory-merge.js"))).toBe(false);
});

test("every roles.toml agent path resolves to a real agent template — retro included (Plan 4)", () => {
  const roles = toml(read("factory/roles.toml"));
  const agentPath = (p) => join(T, "claude", p.replace(".claude/", ""));
  // triage/plan/implement/review/retro의 모든 역할 파일은 실재해야 한다 — roles.toml의 경로가 곧 설치 대상이다.
  const entries = [["triage", roles.triage]];
  for (const stage of ["plan", "implement", "review", "retro"]) {
    for (const [name, def] of Object.entries(roles[stage])) entries.push([`${stage}.${name}`, def]);
  }
  for (const [id, def] of entries) expect(existsSync(agentPath(def.agent)), `${id} → ${def.agent}`).toBe(true);
  // 외부 감사 2026-09-14 M5 — loader는 없어졌다: workflow의 첫 스텝은 이제 LLM 호출이 아니라
  // `factory/lib/context.js`가 쓰는 `.factory/out/loaded.json`이다. 설치되는 파일도 없어야 한다.
  expect(existsSync(agentPath(".claude/agents/factory-loader.md"))).toBe(false);
  // merge에는 역할 블록 자체가 없다(F5 / ADR-015 R3 — merge는 `claude -p`를 부르지 않는 스크립트 전용이라
  // integrator를 정의해 두면 "언젠가 에이전트가 머지한다"는 약속이 roles.toml에 남는다).
  expect(roles.merge).toBeUndefined();
  // Plan 4가 `[retro.analyst]`의 파일을 채웠다 — doctor의 `roles.retro-agent-file` WARN은 이제 PASS다.
  expect(roles.retro.analyst.agent).toBe(".claude/agents/factory-retro.md");
  expect(existsSync(agentPath(roles.retro.analyst.agent)), roles.retro.analyst.agent).toBe(true);
  expect(roles.retro.analyst.lessons).toBe(".factory/lessons/factory-retro.md");
  expect(roles.retro.analyst.model).toBe("opus");
  expect(roles.retro.analyst.output).toBe("factory.retro.v1");
});

test("ci-settings, package.json, quarantine templates parse", () => {
  expect(JSON.parse(read("factory/ci-settings.json")).permissions.deny.length).toBeGreaterThan(0);
  const p = JSON.parse(read("factory/package.json"));
  expect(p.type).toBe("module"); expect(p.private).toBe(true); expect(p.dependencies["smol-toml"]).toMatch(/^\d+\.\d+\.\d+$/);
  expect(toml(read("factory/quarantine.toml"))).toEqual({ quarantined: [] });
});


// ── ADR-021 fix round r1 — the shipped workflow templates carry the new wiring ───────────────

test("r1 MF-2 b: the merge job declares the `factory-merge` environment — a repo secret is readable from any same-repo branch", () => {
  const merge = read("github/workflows/factory-merge.yml");
  expect(merge).toMatch(/^\s{4}environment: factory-merge$/m);
  // 그 환경 이름은 bootstrap이 만드는 이름과 같아야 한다 — 갈라지면 시크릿이 해석되지 않고 머지가 조용히 실패한다.
  expect(merge).toContain(MERGE_ENVIRONMENT);
});

test("r1 finding 5: every credential-scrub step declares `id: scrub-artifacts` — the lint exception is keyed on it", () => {
  for (const f of ["triage", "plan", "implement", "review", "merge", "retro"]) {
    const text = read(`github/workflows/factory-${f}.yml`);
    expect(text, f).toMatch(/^\s+- name: Scrub credentials from the artifacts$/m);
    expect(text, f).toMatch(/^\s+id: scrub-artifacts$/m);
  }
});

test("r1 finding 2: the sweeper runs the merge-authority doctor under the bot token, and cannot break sweeping", () => {
  const sweeper = read("github/workflows/factory-sweeper.yml");
  expect(sweeper).toContain("node .factory/bin/doctor-ci.js");
  expect(sweeper).toMatch(/continue-on-error: true/);
  // 그 스텝의 토큰은 **에이전트 배우의 것**이어야 한다 — 머지 배우의 토큰으로 물으면 엉뚱한 계정을 판정한다.
  expect(sweeper).not.toContain("FACTORY_MERGE_TOKEN");
  expect(sweeper).toContain("FACTORY_BOT_TOKEN");
});
