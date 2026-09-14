import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
