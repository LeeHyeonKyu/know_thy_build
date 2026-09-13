import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubText, scrubPaths, isBinary, REDACTED, SECRET_ENV, runCli } from "../bin/scrub-artifacts.js";

/**
 * ADR-020 최종 리뷰 SF-1 — 업로드되는 아티팩트에서 크리덴셜을 지운다.
 *
 * **이 파일에는 진짜 토큰이 한 글자도 없다.** 픽스처는 전부 조각을 이어 붙여 만든다: 모양만 같고
 * 값은 없다(그래야 이 테스트 파일 자체가 스캐너의 대상이 되지 않는다). 실제 토큰으로 테스트하는
 * 순간 그 토큰은 저장소 이력에 영원히 남는다 — 우리가 고치려는 바로 그 사고다.
 */
const gh = (p) => `${p}_` + "AbCd0123" + "EfGh4567" + "IjKl89mn" + "OpQr";     // ghp_… 모양, 36자
const PAT = "github_pat_" + "11ABCDEFG0" + "abcdefghijklmnopqrstuvwxyz012345";
const ANT = "sk-ant-" + "api03-" + "FIXTURE0000000000000000-not-a-real-key";
const BASIC = "eC1hY2Nlc3MtdG9rZW46ZmFrZQ==";                                  // base64("x-access-token:fake")
const BEARER = "eyJmaXh0dXJlIjoxfQ.c2lnbmF0dXJl-fixture";

test("every ruled pattern is redacted, and the kind is named in the marker", () => {
  const { text, counts } = scrubText(
    `[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic ${BASIC}\n` +
    `curl -H "Authorization: Bearer ${BEARER}" https://api.anthropic.com\n` +
    `token=${gh("ghp")} ${gh("gho")} ${gh("ghu")} ${gh("ghs")} ${gh("ghr")} ${PAT}\n` +
    `ANTHROPIC_API_KEY=${ANT}\n`);
  for (const s of [BASIC, BEARER, ANT, PAT, gh("ghp"), gh("gho"), gh("ghu"), gh("ghs"), gh("ghr")]) expect(text).not.toContain(s);
  // 헤더 **이름**은 남는다 — 무엇이 지워졌는지 사람이 읽을 수 있어야 사후 조사가 된다.
  expect(text).toContain(`AUTHORIZATION: basic ${REDACTED("basic")}`);
  expect(text).toContain(`Authorization: Bearer ${REDACTED("bearer")}`);
  expect(counts).toEqual({ basic: 1, bearer: 1, "gh-token": 6, "anthropic-key": 1 });
});

test("the literal values of the four secret env vars are redacted, with their x-access-token base64", () => {
  const token = "FIXTURE-bot-token-" + "0123456789abcdef";
  const oauth = "FIXTURE-oauth-token-" + "9876543210fedcba";
  const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
  const { text, counts } = scrubText(
    `remote add origin https://x-access-token:${token}@github.com/o/r\nheader ${b64}\nsession ${oauth}\n`,
    { secrets: [token, oauth] });
  expect(text).not.toContain(token);
  expect(text).not.toContain(oauth);
  expect(text).not.toContain(b64);
  expect(counts).toEqual({ "x-access-token": 1, "env-value": 2 });
});

// 값이 짧으면 리터럴 치환이 **본문을 망가뜨린다**(`GITHUB_TOKEN=x`면 모든 `x`가 사라진다).
// 그런 값은 건드리지 않고, 그 사실만 소리 내어 적는다 — 값은 절대 적지 않는다.
test("a too-short env value is ignored rather than shredding the file", () => {
  const { text, counts, ignored } = scrubText("xyz xyz xyz\n", { secrets: ["xyz"] });
  expect(text).toBe("xyz xyz xyz\n");
  expect(counts).toEqual({});
  expect(ignored).toBe(1);
});

test("scrubbing is idempotent — a second pass changes nothing and counts zero", () => {
  const token = "FIXTURE-bot-token-" + "0123456789abcdef";
  const src = `AUTHORIZATION: basic ${BASIC}\nAuthorization: Bearer ${BEARER}\n${gh("ghp")} ${PAT} ${ANT} ${token}\n`;
  const once = scrubText(src, { secrets: [token] });
  const twice = scrubText(once.text, { secrets: [token] });
  expect(twice.text).toBe(once.text);
  expect(twice.counts).toEqual({});
});

test("clean text is returned untouched (and no marker is invented)", () => {
  const clean = "gates: 3 GREEN\nghp_short\nsk-ant\nAuthorization: Basic\n";
  const { text, counts } = scrubText(clean);
  expect(text).toBe(clean);
  expect(counts).toEqual({});
});

test("isBinary: a NUL byte in the first 8000 bytes means skip; UTF-8 text does not", () => {
  expect(isBinary(Buffer.from("전이 코멘트\n{\"ok\":true}\n"))).toBe(false);
  expect(isBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]))).toBe(true);
});

test("scrubPaths rewrites every text file under the given paths, skips binaries and missing paths", () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-scrub-"));
  try {
    const token = "FIXTURE-bot-token-" + "0123456789abcdef";
    mkdirSync(join(root, "out/nested"), { recursive: true });
    writeFileSync(join(root, "out/transcript.jsonl"), `{"text":"AUTHORIZATION: basic ${BASIC}"}\n`);
    writeFileSync(join(root, "out/nested/record.md"), `pushed with ${token} and ${gh("ghs")}\n`);
    writeFileSync(join(root, "out/clean.txt"), "nothing to see\n");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, ...Buffer.from(gh("ghp"))]);
    writeFileSync(join(root, "out/shot.png"), png);

    const r = scrubPaths([join(root, "out"), join(root, "does-not-exist")], { secrets: [token] });

    expect(readFileSync(join(root, "out/transcript.jsonl"), "utf8")).toContain(REDACTED("basic"));
    const rec = readFileSync(join(root, "out/nested/record.md"), "utf8");
    expect(rec).not.toContain(token);
    expect(rec).not.toContain(gh("ghs"));
    expect(readFileSync(join(root, "out/clean.txt"), "utf8")).toBe("nothing to see\n");
    // 바이너리는 **건드리지 않는다** — 바이트가 그대로다.
    expect(Buffer.compare(readFileSync(join(root, "out/shot.png")), png)).toBe(0);
    expect(r.scanned).toBe(4);
    expect(r.skippedBinary).toBe(1);
    expect(r.changed).toBe(2);
    expect(r.counts).toEqual({ basic: 1, "env-value": 1, "gh-token": 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 로그는 **개수만** 말한다. 스크럽 스텝의 stdout은 런 로그에 남고, 런 로그는 아티팩트보다
// 더 넓게 읽힌다 — 거기에 값을 적으면 스크럽이 스스로 유출 경로가 된다.
test("the summary line names kinds and counts, never a value", () => {
  const token = "FIXTURE-bot-token-" + "0123456789abcdef";
  const line = scrubPaths.summary({ scanned: 4, changed: 2, skippedBinary: 1, ignored: 0, counts: { basic: 1, "env-value": 2 } });
  expect(line).toContain("scanned=4");
  expect(line).toContain("changed=2");
  expect(line).toContain("skipped-binary=1");
  expect(line).toContain("basic=1");
  expect(line).toContain("env-value=2");
  expect(line).not.toContain(token);
  expect(line).not.toContain(BASIC);
});

// 워크플로 스텝이 실제로 부르는 모양 그대로 — 시크릿은 **env로만** 들어오고, 인자에는 경로만 있다
// (인자는 런 로그에 그대로 찍힌다). 네 이름은 템플릿의 `env:` 블록과 같아야 한다.
test("CLI: secrets arrive through env only, and stdout carries counts — never a value", () => {
  const root = mkdtempSync(join(tmpdir(), "ktb-scrub-cli-"));
  try {
    const token = "FIXTURE-bot-token-" + "0123456789abcdef";
    writeFileSync(join(root, "run.md"), `pushed with ${token}\nheader AUTHORIZATION: basic ${BASIC}\n`);
    const lines = [];
    // 없는 경로가 섞여 있어도 죽지 않는다 — 업로드 스텝 자신이 `if-no-files-found: ignore`다.
    const code = runCli([root, join(root, "nope")], { FACTORY_BOT_TOKEN: token }, (l) => lines.push(l));
    expect(code).toBe(0);
    const body = readFileSync(join(root, "run.md"), "utf8");
    expect(body).not.toContain(token);
    expect(body).toContain(REDACTED("env-value"));
    expect(body).toContain(REDACTED("basic"));
    const out = lines.join("\n");
    expect(out).toContain("env-value=1");
    expect(out).toContain("basic=1");
    expect(out).not.toContain(token);
    expect(out).not.toContain(BASIC);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 이 스텝은 업로드 **앞**에 `if: always()`로 선다 — 여기서 죽으면 사후 조사에 필요한 아티팩트가
// 통째로 올라가지 않는다. 인자가 없을 때만 사용법을 적고 2로 끝난다(워크플로의 오타).
test("CLI: no paths is the only non-zero exit", () => {
  const err = [];
  const spy = console.error;
  console.error = (l) => err.push(l);
  try { expect(runCli([], {}, () => {})).toBe(2); } finally { console.error = spy; }
  expect(err.join("")).toContain("usage:");
});

test("SECRET_ENV names the four env vars the workflow templates pass to the scrub step", () => {
  expect(SECRET_ENV).toEqual(["FACTORY_BOT_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"]);
});
