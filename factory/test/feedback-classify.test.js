import { test, expect, describe } from "vitest";
import { fileURLToPath } from "node:url";
import { classifyFinding } from "../lib/feedback/classify.js";
import { fingerprint, normalizeReason } from "../lib/feedback/fingerprint.js";
import { ownerOf, buildManifest } from "../cli/manifest.js";

/**
 * 이 파일의 (a)~(d)는 **이번 세션의 실제 발견들**이다(계획 Task 2 "regression pinned"). 각각이
 * 올바른 주인에게 가는지를 고정한다 — 두 대상(`harness` = 쓰는 저장소가 고친다 / `ktb` = KTB가
 * 고친다)은 절대 섞이면 안 된다(spec §2).
 *
 * 매니페스트는 **실물**을 쓴다: `ownerOf`도, dest 멤버십도 `buildManifest`가 실제로 설치하는
 * 목록에서 나온다. prefix 근사로 바꾸면 채택자가 쓴 파일이 KTB 이슈로 올라간다(리뷰 must_fix 1).
 */
const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
const dests = new Set(buildManifest({ pkgRoot }).map((e) => e.dest));
const ktbVersion = "1.3.0";
const harness = {
  test: { source_glob: ["src/**/*.js"], test_glob: ["test/**/*.test.js"] },
  protected: { paths: [".factory/harness.toml"] },
};
const classify = (finding, h = harness) => classifyFinding({ finding, ownerOf, isInstalled: dests, ktbVersion, harness: h });
const at = (causal_path, reason, rest = {}) => ({ kind: "gate", issue: 1, repo: "o/r", stage: "implement", causal_path, reason, ...rest });

describe("설치 매니페스트가 실제로 배포하는 파일만 ktb다", () => {
  test("매니페스트는 이 테스트가 기대하는 dest들을 실제로 담고 있다(테스트가 공허하지 않음을 보장)", () => {
    for (const d of [".factory/lib/self-gate.js", ".factory/bin/run-stage.js", ".claude/agents/reviewer-correctness.md", ".factory/harness.toml"]) {
      expect(dests.has(d)).toBe(true);
    }
    for (const d of [".factory/out/unit.json", ".claude/agents/reviewer-dart-idiom.md", ".claude/settings.local.json"]) {
      expect(dests.has(d)).toBe(false);
    }
  });

  // must_fix 1 — prefix는 멤버십이 아니다. 아래 경로들은 전부 `.factory/`·`.claude/` 밑이지만
  // 배포물이 아니다: 채택자의 실행 출력이거나 채택자가 직접 쓴 파일이다.
  test("`.factory/out/**`·`docs/factory/runs/**`는 실행이 남긴 증거물이다 — 절대 ktb가 아니다", () => {
    for (const p of [".factory/out/unit.json", ".factory/out/qa/3/manifest.json", "docs/factory/runs/3.md", ".factory/records/39.md"]) {
      const r = classify(at(p, "the unit report is missing"));
      expect(r.tags).toEqual(["ambiguous"]);
      expect(r.disposition).toBe("ambiguous");
      expect(r.candidates).toHaveLength(2);
    }
  });

  test("채택자가 `:role`로 만든 역할 프롬프트는 harness다 — 같은 역할의 lessons와 주인이 같아야 한다", () => {
    expect(classify(at(".claude/agents/reviewer-dart-idiom.md", "the role never asks for the failing command")).tags).toEqual(["harness"]);
    expect(classify(at(".factory/lessons/reviewer-dart-idiom.md", "the lesson is stale")).tags).toEqual(["harness"]);
  });

  test("배포된 factory-* 워크플로는 ktb, 배포되지 않은 동명 워크플로는 ambiguous다", () => {
    expect(classify(at(".github/workflows/factory-implement.yml", "the job never uploads the artifact")).tags).toEqual(["ktb"]);
    expect(classify(at(".github/workflows/factory-run.yml", "the job never uploads the artifact")).tags).toEqual(["ambiguous"]);
  });

  test("채택자 자신의 Claude 설정·워크플로도 harness다", () => {
    for (const p of [".claude/settings.local.json", ".claude/CLAUDE.md", ".claude/commands/deploy.md", ".github/workflows/ci.yml"]) {
      expect(classify(at(p, "wrong value")).tags).toEqual(["harness"]);
    }
  });

  test("배포된 역할 프롬프트는 ktb다(매니페스트 dest)", () => {
    const r = classify({
      kind: "review-must_fix",
      issue: 39,
      repo: "LeeHyeonKyu/know-thy-build",
      stage: "review",
      role: "correctness",
      context_manifest: ["diff", "done_when"],
      causal_path: ".claude/agents/reviewer-correctness.md",
      reason: "the reviewer prompt never asks for the failing command",
    });
    expect(r.tags).toEqual(["ktb"]);
    expect(r.confidence).toBe("high");
    expect(r.payload.role).toEqual({ name: "correctness", context_manifest: ["diff", "done_when"] });
  });

  // must_fix 4 — 주입을 빠뜨리면 예전 구현은 조용히 **정반대** 답(`ktb`)을 냈다.
  test("ownerOf / isInstalled 주입이 없으면 던진다(조용한 반전 금지)", () => {
    const finding = at(".factory/harness.toml", "x");
    expect(() => classifyFinding({ finding, isInstalled: dests, harness })).toThrow(/ownerOf is required/);
    expect(() => classifyFinding({ finding, ownerOf, harness })).toThrow(/isInstalled is required/);
    expect(() => classifyFinding({ finding, ownerOf: {}, isInstalled: dests, harness })).toThrow(/ownerOf is required/);
  });
});

describe("causal-file owner → tag", () => {
  // (a) own-cal `test_one` 따옴표: 하네스가 따옴표를 적었다(harness) + 템플릿의 "따옴표를 붙이지
  //     말라"는 안내가 그것을 막기엔 약했다(ktb). 한 발견이 두 태그를 가진다.
  test("(a) own-cal test_one quoting → harness AND ktb", () => {
    const r = classify({
      kind: "gate",
      issue: 3,
      repo: "LeeHyeonKyu/own-cal",
      stage: "implement",
      round: 2,
      causal_path: ".factory/harness.toml [commands].test_one",
      reason:
        'test_one RED: no tests matched — the harness wrote -t "{name}" but the factory already quotes {name}; the harness.toml template guidance ("do not add quotes") did not prevent it',
      extra: { command: 'flutter test {file} -t "{name}"', guidance_path: "templates/factory/factory/harness.toml" },
    });
    expect(r.tags).toEqual(["harness", "ktb"]);
    expect(r.causal.path).toBe(".factory/harness.toml");
    expect(r.causal.owner).toBe("user");
    expect(r.causal.locus).toBe("[commands].test_one");
    expect(r.causal.command).toBe('flutter test {file} -t "{name}"');
    expect(r.disposition).toBe("routed");
  });

  test("(a2) guidance_path가 없어도 reason이 안내 실패를 주장하면 ktb가 붙는다(confidence는 내려간다)", () => {
    const r = classify(at(".factory/harness.toml", "the shipped harness.toml template guidance about quoting was too weak to prevent this"));
    expect(r.tags).toEqual(["harness", "ktb"]);
    expect(r.confidence).toBe("medium");
  });

  test("(b) demo #39 self-gate qa-manifest false-block → ktb", () => {
    const r = classify({
      kind: "self-gate",
      issue: 39,
      repo: "LeeHyeonKyu/know-thy-build",
      stage: "implement",
      round: 1,
      causal_path: ".factory/lib/self-gate.js",
      reason: "self-gate blocked the transition: qa-manifest missing, but the issue carries no qa requirement",
    });
    expect(r.tags).toEqual(["ktb"]);
    expect(r.causal.owner).toBe("factory");
    expect(r.confidence).toBe("high");
  });

  test("(c) demo #39 transition refused: plan roles != roster → ktb", () => {
    const r = classify({
      kind: "transition-refused",
      issue: 39,
      repo: "LeeHyeonKyu/know-thy-build",
      stage: "plan",
      causal_path: ".factory/bin/run-stage.js",
      reason: "transition refused: plan roles [synthesizer,skeptic] != roster []",
    });
    expect(r.tags).toEqual(["ktb"]);
    expect(r.causal.owner).toBe("factory");
  });

  test("(d) own-cal Flutter toolchain missing → harness only", () => {
    const r = classify({
      kind: "gate",
      issue: 4,
      repo: "LeeHyeonKyu/own-cal",
      stage: "implement",
      causal_path: "harness.toml [runtime].setup",
      reason: "flutter: command not found — the runtime setup never installs the Flutter toolchain",
    });
    expect(r.tags).toEqual(["harness"]);
    expect(r.causal.owner).toBe("user");
    expect(r.causal.path).toBe("harness.toml");
    expect(r.causal.locus).toBe("[runtime].setup");
  });

  test("docs/factory/CHARTER.md·scripts/는 쓰는 저장소의 것이다 → harness", () => {
    for (const p of ["docs/factory/CHARTER.md", "scripts/build.sh"]) expect(classify(at(p, "x")).tags).toEqual(["harness"]);
  });

  test("KTB 소스 트리의 배포물(templates/factory, templates/know-thy-build)은 ktb다", () => {
    for (const p of ["templates/factory/factory/harness.toml", "templates/know-thy-build/role.md"]) {
      const r = classify(at(p, "the default is wrong"));
      expect(r.tags).toEqual(["ktb"]);
      expect(r.confidence).toBe("medium"); // prefix 표는 약한 신호다
    }
  });
});

describe("다중 태그는 증거로만 열린다 (must_fix 3 — §3 'KTB를 덮지 않는다')", () => {
  // 전부 causal `.factory/harness.toml`(owner user, 순수 채택자 수정). 예전 구현은 낱말 하나로
  // 이 중 8개에 `ktb`를 붙여 KTB에 이슈를 열었다.
  const INNOCUOUS = [
    "the default timeout of 30s is too low",
    "the template literal in scripts/build.sh is unterminated",
    "skill issue: the command uses the wrong flag",
    "the roster in CHARTER.md is empty",
    "prompt the user before deleting",
    "shipped artifact missing",
    "tier resolution picked docs but the diff touched src",
    "the unit command points at .factory/out/unit.json which no longer exists",
    "default_branch is wrong",
    "the test_one command is missing the {name} placeholder",
    "lint command exits 127 — the binary is not installed",
    "the protected list does not cover .github/workflows/factory-run.yml",
    "setup does not install the project's own toolchain",
  ];
  test.each(INNOCUOUS)("무해한 harness 사유는 harness로만 남는다: %s", (reason) => {
    const r = classify(at(".factory/harness.toml", reason));
    expect(r.tags).toEqual(["harness"]);
  });

  test("인용된 .factory/ 경로는 방아쇠가 아니다 — 인용은 자리이지 원인이 아니다", () => {
    const r = classify(at(".factory/harness.toml", "the command references .factory/lib/gates.js and .claude/agents/reviewer-qa.md but neither exists here"));
    expect(r.tags).toEqual(["harness"]);
  });

  test("안내 실패를 주장하는 구절이면 열린다", () => {
    for (const reason of [
      "the template says to leave {name} unquoted; that guidance did not prevent the harness from quoting it",
      "the shipped default for review_rounds is too low and it failed to prevent the loop",
      "the factory already quotes {name}, so the harness's own quotes broke the gate",
    ]) {
      expect(classify(at(".factory/harness.toml", reason)).tags).toEqual(["harness", "ktb"]);
    }
  });

  test("guidance_path가 owner:factory가 아니면 명시 방아쇠도 열리지 않는다", () => {
    const r = classify(at(".factory/harness.toml", "x", { extra: { guidance_path: "src/app.js" } }));
    expect(r.tags).toEqual(["harness"]);
    expect(r.payload.guidance_path).toBe("src/app.js");
  });

  test("ktb 발견에는 다중 태그를 붙이지 않는다(이미 KTB의 것이다)", () => {
    expect(classify(at(".factory/lib/gates.js", "the shipped default did not prevent this")).tags).toEqual(["ktb"]);
  });
});

describe("product / ambiguous", () => {
  test("(e) source_glob 안의 must_fix → product(라우팅하지 않는다)", () => {
    const r = classify({ kind: "review-must_fix", issue: 7, repo: "LeeHyeonKyu/own-cal", stage: "review", causal_path: "src/app.js:42", reason: "null deref when the calendar has no events" });
    expect(r.tags).toEqual(["product"]);
    expect(r.causal.path).toBe("src/app.js");
    expect(r.causal.line).toBe(42);
    expect(r.causal.owner).toBe("product");
    expect(r.disposition).toBe("outcome");
  });

  test("test_glob 안의 must_fix도 product다", () => {
    expect(classify({ kind: "review-must_fix", issue: 7, repo: "o/r", stage: "review", causal_path: "test/app.test.js", reason: "asserts nothing" }).tags).toEqual(["product"]);
  });

  // must_fix 2 — `templates/`는 KTB에서만 특별하다. Jinja 채택자에게는 제품 디렉터리다.
  test("채택자가 명시한 glob이 약한 prefix 표를 이긴다: templates/index.html → product", () => {
    const flask = { test: { source_glob: ["templates/**", "app/**/*.py"], test_glob: ["tests/**/*.py"] } };
    expect(classify(at("templates/index.html", "the calendar grid renders empty"), flask).tags).toEqual(["product"]);
    expect(classify(at("templates/emails/welcome.html", "broken link"), flask).tags).toEqual(["product"]);
    expect(classify(at("app/main.py", "500 on /"), flask).tags).toEqual(["product"]);
  });

  test("하지만 매니페스트 멤버십은 glob보다 세다 — 넓은 glob도 배포물의 주인을 못 바꾼다", () => {
    const wide = { test: { source_glob: ["**/*"], test_glob: [] } };
    expect(classify(at(".factory/harness.toml", "x"), wide).tags).toEqual(["harness"]);
    expect(classify(at(".factory/lib/self-gate.js", "x"), wide).tags).toEqual(["ktb"]);
  });

  test("(f) 해석할 수 있는 causal path가 없으면 ambiguous — 버리지 않고 두 후보를 모두 적는다", () => {
    const r = classify({ kind: "review-must_fix", issue: 41, repo: "LeeHyeonKyu/know-thy-build", stage: "review", reason: "the agent lacked context and guessed" });
    expect(r.tags).toEqual(["ambiguous"]);
    expect(r.causal.path).toBe(null);
    expect(r.causal.owner).toBe(null);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.join("\n")).toMatch(/harness/);
    expect(r.candidates.join("\n")).toMatch(/ktb/);
    expect(r.confidence).toBe("low");
    expect(r.disposition).toBe("ambiguous");
  });

  test("매니페스트에도 globs에도 없는 경로는 ambiguous다(오라우팅하지 않는다)", () => {
    for (const p of ["vendor/thing.rb", "src/harness.toml", "src/scripts/x.sh", "README.md"]) {
      const r = classify(at(p, "boom"));
      expect(r.tags).toEqual(["ambiguous"]);
      expect(r.candidates).toHaveLength(2);
    }
    expect(classify(at("vendor/thing.rb", "boom")).candidates.join(" ")).toMatch(/vendor\/thing\.rb/);
  });
});

describe("behavioural — 쌍(pairing)이 있을 때만 ktb", () => {
  test("(h1) paired:false면 ktb 태그가 붙지 않는다", () => {
    const r = classify({ kind: "behavioural", issue: null, repo: "o/r", stage: "health", paired: false, reason: "role correctness approved 5/5 issues", extra: { signal: "rubber-stamp" } });
    expect(r.tags).toEqual([]);
    expect(r.confidence).toBe("low");
    expect(r.disposition).toBe("withheld");     // T3는 이것으로 ambiguous 노트와 구분한다
    expect(r.candidates).toBeUndefined();
    expect(r.payload.withheld).toMatch(/paired/i);
  });

  test("paired가 엄밀히 true가 아니면 전부 보류다", () => {
    for (const paired of [undefined, "true", 1, null]) {
      expect(classify({ kind: "behavioural", issue: null, repo: "o/r", stage: "health", paired, reason: "x" }).tags).toEqual([]);
    }
  });

  test("(h2) paired:true인 rubber-stamp → ktb", () => {
    const r = classify({
      kind: "behavioural",
      issue: null,
      repo: "LeeHyeonKyu/know-thy-build",
      stage: "health",
      paired: true,
      role: "correctness",
      causal_path: ".claude/agents/reviewer-correctness.md",
      reason: "rubber-stamp: role correctness approved 5/5 issues while 2 defects escaped downstream",
      extra: { signal: "rubber-stamp", chain: ["#31 approve", "#33 approve"] },
    });
    expect(r.tags).toEqual(["ktb"]);
    expect(r.disposition).toBe("routed");
    expect(r.payload.chain).toEqual(["#31 approve", "#33 approve"]);
  });

  test("(h3) paired:true인데 파일이 없어도 ktb다 — 프롬프트/티어/로스터는 owner:factory다", () => {
    const r = classify({ kind: "behavioural", issue: null, repo: "o/r", stage: "health", paired: true, reason: "cost_vs_risk: a docs-tier diff ran the full panel at $80", extra: { signal: "waste" } });
    expect(r.tags).toEqual(["ktb"]);
    expect(r.confidence).toBe("medium");
  });
});

describe("payload (spec §6)", () => {
  test("발견 하나가 증거 payload 하나로 접힌다", () => {
    const r = classify({
      kind: "gate",
      issue: 39,
      repo: "LeeHyeonKyu/know-thy-build",
      stage: "implement",
      round: 2,
      role: "correctness",
      context_manifest: ["diff"],
      causal_path: ".factory/lib/gates.js:12",
      reason: "unit gate RED",
      extra: { command: "npx vitest run", test: "a.test.js > x", snippet: "AssertionError", chain: ["r1 reject"], cost: { usd: 3.2, tokens: 1000 } },
    });
    expect(r.payload).toEqual({
      issue: 39,
      repo: "LeeHyeonKyu/know-thy-build",
      stage: "implement",
      round: 2,
      kind: "gate",
      ktb_version: "1.3.0",
      tags: ["ktb"],
      causal: r.causal,
      role: { name: "correctness", context_manifest: ["diff"] },
      chain: ["r1 reject"],
      reason: "unit gate RED",
      cost: { usd: 3.2, tokens: 1000 },
      fingerprint: r.fingerprint,
    });
    expect(r.causal).toEqual({ path: ".factory/lib/gates.js", line: 12, owner: "factory", locus: null, command: "npx vitest run", test: "a.test.js > x", snippet: "AssertionError" });
  });

  test("payload는 결과 객체와 배열/객체를 공유하지 않는다 — 증거는 나중에 조용히 바뀌면 안 된다", () => {
    const r = classify(at(".factory/lib/gates.js", "x"));
    r.tags.push("harness");
    r.causal.path = "/etc/passwd";
    expect(r.payload.tags).toEqual(["ktb"]);
    expect(r.payload.causal.path).toBe(".factory/lib/gates.js");
  });

  test("cost가 없으면 payload에 cost 키가 없다", () => {
    const r = classify(at(".factory/lib/gates.js", "x"));
    expect("cost" in r.payload).toBe(false);
    expect(r.payload.role).toBe(null);
  });

  test("`:0`은 줄 번호가 아니다", () => {
    expect(classify(at(".factory/lib/gates.js:0", "x")).causal.line).toBe(null);
  });
});

describe("fingerprint (spec §10 Q2)", () => {
  const cause = (issue, sha) => ({
    kind: "self-gate",
    issue,
    repo: "LeeHyeonKyu/know-thy-build",
    stage: "implement",
    round: issue === 39 ? 1 : 3,
    causal_path: ".factory/lib/self-gate.js",
    reason: `self-gate blocked the transition on #${issue} (${sha}): qa-manifest missing at .factory/lib/self-gate.js:88`,
  });

  test("(g1) 같은 원인이 #39와 #41에서 같은 지문을 낸다", () => {
    expect(classify(cause(39, "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")).fingerprint).toBe(classify(cause(41, "0ff1ce0ff1ce0ff1ce0ff1ce0ff1ce0ff1ce0ff1")).fingerprint);
  });

  test("(g2) 다른 원인은 다른 지문을 낸다", () => {
    const a = classify(cause(39, "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")).fingerprint;
    const b = classify({ kind: "transition-refused", issue: 39, repo: "LeeHyeonKyu/know-thy-build", stage: "plan", causal_path: ".factory/bin/run-stage.js", reason: "transition refused: plan roles [synthesizer,skeptic] != roster []" }).fingerprint;
    expect(a).not.toBe(b);
  });

  test("같은 reason이라도 causal path가 다르면 지문이 다르다", () => {
    const one = fingerprint({ path: ".factory/lib/a.js", reason: "boom" });
    expect(one).not.toBe(fingerprint({ path: ".factory/lib/b.js", reason: "boom" }));
    expect(one).toMatch(/^[0-9a-f]{16}$/);
  });

  // should_fix 2 — 태그가 재료였다면 다중 태그 방아쇠가 흔들릴 때 한 원인이 상류 이슈 둘로 쪼개진다.
  test("태그는 지문의 재료가 아니다 — 같은 원인이 [harness]든 [harness,ktb]든 한 이슈로 모인다", () => {
    const base = ".factory/harness.toml";
    const reason = "test_one RED: no tests matched";
    const one = classify(at(base, reason));
    const two = classify(at(base, reason, { extra: { guidance_path: "templates/factory/factory/harness.toml" } }));
    expect(one.tags).toEqual(["harness"]);
    expect(two.tags).toEqual(["harness", "ktb"]);
    expect(one.fingerprint).toBe(two.fingerprint);
  });

  test("(g3) normalizeReason이 이슈 번호·sha·run id·줄 번호를 지우고 공백을 접는다", () => {
    expect(normalizeReason("self-gate blocked #39   on line src/a.js:123")).toBe("self-gate blocked on line src/a.js");
    expect(normalizeReason("failed at a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")).toBe("failed at");
    expect(normalizeReason("run id 34809992796 failed")).toBe("run id failed");
    expect(normalizeReason(undefined)).toBe("");
  });

  // should_fix 1 — 숫자를 전부 지우면 exit 127(툴체인 부재)과 exit 1(진짜 RED)이 한 이슈에 섞인다.
  test("식별자에 붙은 숫자는 남는다 — 서로 다른 원인이 한 이슈로 뭉치지 않는다", () => {
    for (const [a, b] of [
      ["lint exits 127", "lint exits 1"],
      ["HTTP 404 from gh", "HTTP 500 from gh"],
      ["node 20 required", "node 22 required"],
      ["timeout after 30s", "timeout after 300s"],
    ]) {
      expect(normalizeReason(a)).not.toBe(normalizeReason(b));
      expect(fingerprint({ path: "p", reason: a })).not.toBe(fingerprint({ path: "p", reason: b }));
    }
  });
});
