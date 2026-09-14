import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planStaticPull } from "../lib/board-static.js";

/**
 * 보드 페이지의 스모크 테스트. 이 페이지에는 빌드 단계가 없다 — `factory init`이 **파일 그대로**
 * 설치하고 CLI가 그 파일을 그대로 낸다. 그래서 문법 오류 하나, 빠진 id 하나가 곧 빈 화면이고,
 * 그 사실을 알려 줄 번들러도 린터도 없다. 이 파일이 그 자리를 대신한다.
 */
const PAGE = join(new URL("../../", import.meta.url).pathname, "templates/factory/docs/factory/board/index.html");
const html = readFileSync(PAGE, "utf8");

const scriptBody = () => {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  expect(m, "the page must carry exactly one inline <script>").toBeTruthy();
  return m[1];
};

test("the page is a self-contained document: doctype, one title, balanced html/head/body", () => {
  expect(html.slice(0, 15).toLowerCase()).toContain("<!doctype html>");
  expect(html.match(/<title>/g).length).toBe(1);
  for (const tag of ["html", "head", "body", "style", "script"]) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, "g")) || []).length;
    expect(open, `<${tag}> open/close must balance`).toBe(close);
  }
  expect(html).toContain('<meta charset="utf-8">');
  expect(html).toContain('name="viewport"');
});

test("the inline script parses as JavaScript — a syntax error here is a blank page with no warning", () => {
  expect(() => new Function(scriptBody())).not.toThrow();
});

test("every element id the script reaches for actually exists in the markup", () => {
  const ids = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
  const wanted = new Set([...scriptBody().matchAll(/\$\("#([\w-]+)"\)/g)].map((m) => m[1]));
  const missing = [...wanted].filter((id) => !ids.has(id));
  expect(missing, `script reaches for #${missing.join(", #")} — no such element`).toEqual([]);
});

test("the three views the board promises are present by id", () => {
  for (const id of ["view-lanes", "view-timeline", "detail-panel"]) expect(html).toContain(`id="${id}"`);
  expect(html).toContain("레인 보드");
  expect(html).toContain("타임라인");
});

test("no external resource: every src=/href= attribute is local — no CDN, no font host, no analytics", () => {
  const attrs = [...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1]);
  const external = attrs.filter((v) => /^(?:https?:)?\/\//i.test(v));
  expect(external, `external resources: ${external.join(", ")}`).toEqual([]);
  expect(html).not.toMatch(/<link\b[^>]*rel\s*=\s*"stylesheet"/i);
  expect(html).not.toMatch(/<script\b[^>]*\bsrc\s*=/i);
});

test("the one host the page may talk to is api.github.com, and only in the static fallback", () => {
  const hosts = [...html.matchAll(/https?:\/\/([\w.-]+)/g)].map((m) => m[1]);
  expect([...new Set(hosts)]).toEqual(["api.github.com"]);
});

test("light and dark are both defined — the page never inherits an unstyled ground", () => {
  expect(html).toContain("color-scheme: light dark");
  expect(html).toContain("@media (prefers-color-scheme: dark)");
});

test("the page stays small enough to serve and to read (under 120 KB)", () => {
  expect(Buffer.byteLength(html, "utf8")).toBeLessThan(120 * 1024);
});

test("the header help documents both modes, including that the token never leaves the browser", () => {
  expect(html).toContain("?repo=owner/name");
  expect(html).toContain("localStorage");
  expect(html).toMatch(/토큰은 브라우저에 들어오지 않는다/);
});

// ── 정적 모드 호출 예산 (review 714a45d MUST-FIX 2) ─────────────────────────
//
// 헤드리스 브라우저가 없으니 실행이 아니라 텍스트 검사다: 예산 상수·함수가 페이지 안에 실제로
// 있는지, 그리고 그 로직이 `factory/lib/board-static.js`와 글자 그대로 같은 사본인지를 잡는다.

/** 스크립트 텍스트에서 `function <name>(...) { … }`의 소스를 중괄호 짝을 맞춰 그대로 뽑아낸다. */
function extractFunctionSource(text, name) {
  const start = text.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found in the inline script`).toBeGreaterThan(-1);
  const braceStart = text.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return text.slice(start, i);
}

test("planStaticPull: the page's inline copy is byte-identical to factory/lib/board-static.js", () => {
  // `planStaticPull.toString()` reflects vitest's esbuild-transformed module, not the file on disk (it can
  // reformat statements) — so this compares the two **files' own source text**, not a runtime function.
  const modulePath = join(new URL("../../", import.meta.url).pathname, "factory/lib/board-static.js");
  const moduleText = readFileSync(modulePath, "utf8");
  const pageSrc = extractFunctionSource(scriptBody(), "planStaticPull");
  const moduleSrc = extractFunctionSource(moduleText, "planStaticPull");
  expect(pageSrc).toBe(moduleSrc);
});

test("planStaticPull: skips a pull entirely while the budget is <= 3 until reset (MUST-FIX 2a)", () => {
  expect(scriptBody()).toMatch(/rate\.remaining <= 3/);
  expect(scriptBody()).toMatch(/now < rate\.reset/);
  expect(html).toContain("API 예산 소진");
  // 예산 소진일 때 이슈 목록조차 다시 받지 않는다 — pull()이 loadFromGitHub 호출 전에 건너뛴다.
  expect(scriptBody()).toMatch(/if \(plan\.skip\) \{[\s\S]*?return;\s*\}/);
});

test("planStaticPull: comments are only fetched for issues updated within 24h; the rest render stale-data (MUST-FIX 2b)", () => {
  expect(scriptBody()).toMatch(/DAY_MS = 24 \* 3600 \* 1000/);
  expect(scriptBody()).toContain("staleIssues");
  expect(scriptBody()).toContain('"stale-data"');
  expect(scriptBody()).toContain("plan.commentIssues.map");
});

test("planStaticPull: polling is 10 min untokened, 2 min tokened (MUST-FIX 2c)", () => {
  expect(scriptBody()).toMatch(/hasToken \? 120000 : 600000/);
  expect(scriptBody()).toMatch(/setInterval\(pull, planStaticPull\(/);
});

test("planStaticPull behaves: budget exhausted skips, otherwise splits fresh/stale by updated_at, and picks the interval by token presence", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");
  const exhausted = planStaticPull({ rate: { remaining: 2, reset: now + 60000 }, issues: [], now, hasToken: false });
  expect(exhausted.skip).toBe(true);
  expect(exhausted.resetAt).toBe(now + 60000);

  const notYetExhausted = planStaticPull({ rate: { remaining: 4, reset: now + 60000 }, issues: [], now, hasToken: false });
  expect(notYetExhausted.skip).toBe(false);

  const fresh = { updated_at: new Date(now - 3600e3).toISOString() };       // 1h ago
  const stale = { updated_at: new Date(now - 48 * 3600e3).toISOString() };  // 48h ago
  const plan = planStaticPull({ rate: null, issues: [fresh, stale], now, hasToken: false });
  expect(plan.commentIssues).toEqual([fresh]);
  expect(plan.staleIssues).toEqual([stale]);

  expect(planStaticPull({ hasToken: false }).intervalMs).toBe(600000);
  expect(planStaticPull({ hasToken: true }).intervalMs).toBe(120000);
});

test("?repo= is validated with the same regex as the setup form (should-fix 3)", () => {
  expect(scriptBody()).toContain("var REPO_RE = /^[\\w.-]+\\/[\\w.-]+$/;");
  const formUses = (scriptBody().match(/REPO_RE\.test\(/g) || []).length;
  expect(formUses).toBeGreaterThanOrEqual(2); // askRepo() 폼과 boot()의 ?repo= 둘 다
});
