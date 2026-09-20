import { test, expect, describe } from "vitest";
import { classifyFinding } from "../lib/feedback/classify.js";
import { fingerprint, normalizeReason } from "../lib/feedback/fingerprint.js";
import { ownerOf } from "../cli/manifest.js";

/**
 * 이 파일의 (a)~(d)는 **이번 세션의 실제 발견들**이다(계획 Task 2 "regression pinned"). 각각이
 * 올바른 주인에게 가는지를 고정한다 — 두 대상(`harness` = 쓰는 저장소가 고친다 / `ktb` = KTB가
 * 고친다)은 절대 섞이면 안 된다(spec §2).
 */
const ktbVersion = "1.3.0";
const harness = {
  test: { source_glob: ["src/**/*.js"], test_glob: ["test/**/*.test.js"] },
  protected: { paths: [".factory/harness.toml"] },
};
const classify = (finding) => classifyFinding({ finding, ownerOf, ktbVersion, harness });

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
    expect(r.tags).toContain("harness");
    expect(r.tags).toContain("ktb");
    expect(r.causal.path).toBe(".factory/harness.toml");
    expect(r.causal.owner).toBe("user");
    expect(r.causal.locus).toBe("[commands].test_one");
    expect(r.causal.command).toBe('flutter test {file} -t "{name}"');
  });

  test("(a2) 명시적 guidance_path가 없어도 reason이 KTB가 배포한 안내를 지목하면 ktb가 붙는다", () => {
    const r = classify({
      kind: "gate",
      issue: 3,
      repo: "LeeHyeonKyu/own-cal",
      stage: "implement",
      causal_path: ".factory/harness.toml",
      reason: "the shipped harness.toml template guidance about quoting was too weak to prevent this",
    });
    expect(r.tags).toEqual(["harness", "ktb"]);
    expect(r.confidence).toBe("medium"); // 텍스트 신호로 붙인 두 번째 태그는 high가 아니다
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

  test(".claude/agents 프롬프트도 ktb다(설치 매니페스트 owner: factory)", () => {
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
    expect(r.payload.role).toEqual({ name: "correctness", context_manifest: ["diff", "done_when"] });
  });

  test("docs/factory/CHARTER.md·scripts/는 쓰는 저장소의 것이다 → harness", () => {
    for (const p of ["docs/factory/CHARTER.md", "scripts/build.sh"]) {
      expect(classify({ kind: "gate", issue: 1, repo: "o/r", stage: "implement", causal_path: p, reason: "x" }).tags).toEqual(["harness"]);
    }
  });
});

describe("product / ambiguous", () => {
  test("(e) source_glob 안의 must_fix → product(라우팅하지 않는다)", () => {
    const r = classify({
      kind: "review-must_fix",
      issue: 7,
      repo: "LeeHyeonKyu/own-cal",
      stage: "review",
      causal_path: "src/app.js:42",
      reason: "null deref when the calendar has no events",
    });
    expect(r.tags).toEqual(["product"]);
    expect(r.causal.path).toBe("src/app.js");
    expect(r.causal.line).toBe(42);
    expect(r.causal.owner).toBe("product");
  });

  test("test_glob 안의 must_fix도 product다", () => {
    const r = classify({ kind: "review-must_fix", issue: 7, repo: "o/r", stage: "review", causal_path: "test/app.test.js", reason: "asserts nothing" });
    expect(r.tags).toEqual(["product"]);
  });

  test("(f) 해석할 수 있는 causal path가 없으면 ambiguous — 버리지 않고 두 후보를 모두 적는다", () => {
    const r = classify({
      kind: "review-must_fix",
      issue: 41,
      repo: "LeeHyeonKyu/know-thy-build",
      stage: "review",
      reason: "the agent lacked context and guessed",
    });
    expect(r.tags).toEqual(["ambiguous"]);
    expect(r.causal.path).toBe(null);
    expect(r.causal.owner).toBe(null);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.join("\n")).toMatch(/harness/);
    expect(r.candidates.join("\n")).toMatch(/ktb/);
    expect(r.confidence).toBe("low");
  });

  test("매니페스트에도 globs에도 없는 경로는 ambiguous다(오라우팅하지 않는다)", () => {
    const r = classify({ kind: "gate", issue: 41, repo: "o/r", stage: "implement", causal_path: "vendor/thing.rb", reason: "boom" });
    expect(r.tags).toEqual(["ambiguous"]);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.join(" ")).toMatch(/vendor\/thing\.rb/);
  });
});

describe("behavioural — 쌍(pairing)이 있을 때만 ktb", () => {
  test("(h1) paired:false면 ktb 태그가 붙지 않는다", () => {
    const r = classify({
      kind: "behavioural",
      issue: null,
      repo: "LeeHyeonKyu/know-thy-build",
      stage: "health",
      paired: false,
      reason: "role correctness approved 5/5 issues",
      extra: { signal: "rubber-stamp", role: "correctness" },
    });
    expect(r.tags).not.toContain("ktb");
    expect(r.tags).toEqual([]);
    expect(r.confidence).toBe("low");
    expect(r.payload.withheld).toMatch(/paired/i);
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
    expect(r.payload.chain).toEqual(["#31 approve", "#33 approve"]);
  });

  test("(h3) paired:true인데 파일이 없어도 ktb다 — 프롬프트/티어/로스터는 owner:factory다", () => {
    const r = classify({
      kind: "behavioural",
      issue: null,
      repo: "o/r",
      stage: "health",
      paired: true,
      reason: "cost_vs_risk: a docs-tier diff ran the full panel at $80",
      extra: { signal: "waste" },
    });
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
    expect(r.causal).toEqual({
      path: ".factory/lib/gates.js",
      line: 12,
      owner: "factory",
      locus: null,
      command: "npx vitest run",
      test: "a.test.js > x",
      snippet: "AssertionError",
    });
  });

  test("cost가 없으면 payload에 cost 키가 없다", () => {
    const r = classify({ kind: "gate", issue: 1, repo: "o/r", stage: "implement", causal_path: ".factory/lib/gates.js", reason: "x" });
    expect("cost" in r.payload).toBe(false);
    expect(r.payload.role).toBe(null);
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
    expect(classify(cause(39, "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")).fingerprint).toBe(
      classify(cause(41, "0ff1ce0ff1ce0ff1ce0ff1ce0ff1ce0ff1ce0ff1")).fingerprint,
    );
  });

  test("(g2) 다른 원인은 다른 지문을 낸다", () => {
    const a = classify(cause(39, "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")).fingerprint;
    const b = classify({
      kind: "transition-refused",
      issue: 39,
      repo: "LeeHyeonKyu/know-thy-build",
      stage: "plan",
      causal_path: ".factory/bin/run-stage.js",
      reason: "transition refused: plan roles [synthesizer,skeptic] != roster []",
    }).fingerprint;
    expect(a).not.toBe(b);
  });

  test("같은 reason이라도 causal path가 다르면 지문이 다르다", () => {
    const one = fingerprint({ tags: ["ktb"], path: ".factory/lib/a.js", reason: "boom" });
    const two = fingerprint({ tags: ["ktb"], path: ".factory/lib/b.js", reason: "boom" });
    expect(one).not.toBe(two);
    expect(one).toMatch(/^[0-9a-f]{16}$/);
  });

  test("태그 순서는 지문을 바꾸지 않는다", () => {
    expect(fingerprint({ tags: ["harness", "ktb"], path: "p", reason: "r" })).toBe(fingerprint({ tags: ["ktb", "harness"], path: "p", reason: "r" }));
  });

  test("(g3) normalizeReason이 이슈 번호·sha·줄 번호를 지우고 공백을 접는다", () => {
    expect(normalizeReason("self-gate blocked #39   on line src/a.js:123")).toBe("self-gate blocked on line src/a.js");
    expect(normalizeReason("failed at a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")).toBe("failed at");
    expect(normalizeReason("run id 34809992796 failed")).toBe("run id failed");
    expect(normalizeReason("diff coverage 88% < 90%")).toBe(normalizeReason("diff coverage 72% < 90%"));
    expect(normalizeReason(undefined)).toBe("");
  });
});
