#!/usr/bin/env node
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * ADR-020 최종 리뷰 SF-1 — **업로드되기 전에 크리덴셜을 지운다.**
 *
 * 다섯 스테이지 워크플로(+retro)는 `actions/upload-artifact`로 `docs/factory/runs/`·`.factory/out/`·
 * `claude -p` 세션 트랜스크립트를 올린다. 공개 저장소에서 그 아티팩트는 **레포 read 권한자 누구나**
 * 받는다. 그리고 그 트리 안에는 토큰이 실제로 있다: `actions/checkout`이 `persist-credentials: true`로
 * 심는 `.git/config`의 `http.extraheader = AUTHORIZATION: basic <base64(x-access-token:<token>)>`이다.
 * 그 값은 락 push(`claim.js`)와 run 기록 push(`records-branch.js`)가 나가는 유일한 경로라
 * **끌 수 없다**(0452b5b의 알려진 한계) — 그래서 노출 쪽을 닫는다: 업로드 직전에 한 번 훑고,
 * 보관은 7일이다(`retention-days`, `yml-lint`의 `artifact-retention` 규칙이 지킨다).
 *
 * 무엇을 지우는가(전부 `[REDACTED:<kind>]`로):
 *   (a) `AUTHORIZATION: basic <base64>` · `Authorization: Bearer …`의 **값**(헤더 이름은 남긴다)
 *   (b) GitHub 토큰 모양 `ghp_`·`gho_`·`ghu_`·`ghs_`·`ghr_`·`github_pat_`
 *   (c) Anthropic 키 모양 `sk-ant-…`
 *   (d) 스텝 env로 들어온 `FACTORY_BOT_TOKEN`·`FACTORY_MERGE_TOKEN`·`CLAUDE_CODE_OAUTH_TOKEN`·
 *       `ANTHROPIC_API_KEY`·`GITHUB_TOKEN`의 **리터럴 값** — env는 이 스텝에만 싣고 **절대 echo 하지 않는다**
 *       (`FACTORY_MERGE_TOKEN`은 머지 잡에만 실린다 — ADR-021, `yml-lint`의 `merge-token-scope`)
 *   (e) 그 값들의 `x-access-token:<token>` base64(= git이 심는 헤더의 그 형태)
 *   (f) 리뷰 3c63672 MF-1 — URL 안의 userinfo(`scheme://user:pass@host`). `git push
 *       https://x-access-token:<token>@github.com/…`(actions/checkout이 심는 그 모양 그대로, 평문이라
 *       (e)의 base64 규칙이 잡지 못한다)와 `postgres://user:pw@host/db` 같은 DSN이 실측 사례다. **모양**
 *       기반이라 env에 없는(=SECRET_ENV 밖의) 토큰도 잡는다 — 뒤의 `@`는 남겨 URL이 계속 읽힌다.
 *
 * 로그는 **종류별 개수만** 적는다. 스크럽 스텝의 stdout은 런 로그에 남고 런 로그는 아티팩트보다 더
 * 넓게 읽힌다 — 거기에 값을 적으면 스크럽 자신이 유출 경로가 된다.
 *
 * 의존성은 없다(Node 내장만). 이 파일은 `factory init`이 `.factory/bin/`으로 그대로 복사한다.
 */

/** 치환 마커. 무엇이 지워졌는지 종류로 말한다 — "빈 자리"는 사후 조사에서 읽을 수 없다. */
export const REDACTED = (kind) => `[REDACTED:${kind}]`;

/**
 * 스텝 env에서 리터럴 값을 읽는 다섯 이름. 워크플로 템플릿의 스크럽 스텝 `env:`와 같아야 한다.
 * `FACTORY_MERGE_TOKEN`(ADR-021의 머지 배우, admin PAT)은 **머지 워크플로의 스크럽 스텝에만**
 * 실린다 — 다른 워크플로에서는 이 이름이 env에 없어 조용히 건너뛴다(없는 값은 치환하지 않는다).
 * 목록에 두는 것이 옳은 이유: 가장 강한 자격증명이고, 빠뜨리면 그것만 아티팩트에 남는다.
 */
export const SECRET_ENV = ["FACTORY_BOT_TOKEN", "FACTORY_MERGE_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"];

/**
 * 리터럴 치환의 최소 길이. `GITHUB_TOKEN=x` 같은 값(플레이스홀더·테스트 더미)을 그대로 치환하면
 * 파일에서 모든 `x`가 사라진다 — 아티팩트를 지키려다 아티팩트를 망가뜨린다. 짧은 값은 건드리지 않고
 * **개수만** 보고한다(`ignored`). 모양 기반 규칙 (a)~(c)는 그 값도 여전히 덮는다.
 */
export const MIN_LITERAL = 12;

/**
 * 모양 기반 규칙. `keep`이 있으면 앞부분(헤더 이름)은 남기고 **값만** 지운다.
 *
 * 멱등성은 문자 클래스가 준다: `[REDACTED:basic]`은 `[`로 시작하는데 어느 값 클래스에도 `[`가 없어
 * 두 번째 통과에서 아무것도 맞히지 않는다. (스크럽은 `if: always()`로 돌고 재실행도 가능하므로
 * 두 번 도는 일이 실제로 있다.)
 */
const PATTERNS = [
  { kind: "basic", re: /(AUTHORIZATION:\s*basic\s+)([A-Za-z0-9+/=_-]+)/gi, keep: true },
  { kind: "bearer", re: /(Authorization:\s*Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, keep: true },
  // 길이 하한(16/20)은 산문 속의 `ghp_…` 같은 **설명**을 잡지 않기 위한 것이다 — 실제 토큰은 훨씬 길다.
  { kind: "gh-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  // (f) — `keep`이 남기는 head는 `://`; 뒤의 `@`는 **lookahead**로 남긴다(캡처가 아니다 — basic·bearer의
  // 두 번째 캡처는 지워야 할 값 자체라, 캡처를 되붙이는 방식은 그 값을 도로 살린다: 리뷰 aab3db8 뒤 실측).
  // 사이의 `user:pass`(콜론이 몇 개든)를 통째로 지운다. 문자 클래스에서 `[`·`]`를 빼 이미 찍힌
  // `[REDACTED:x-access-token]`(콜론 포함)을 다시 잡지 않는다 — 리터럴 규칙이 먼저 돈 뒤의 멱등성.
  { kind: "url-userinfo", re: /(:\/\/)[^/\s@[\]]+:[^/\s@[\]]+(?=@)/g, keep: true },
];

/**
 * 한 텍스트를 스크럽한다. 순수 함수다 — 파일 시스템도 env도 보지 않는다(그래야 테스트가 붙는다).
 * @returns {{text: string, counts: Record<string, number>, ignored: number}}
 */
export function scrubText(text, { secrets = [] } = {}) {
  const counts = {};
  const bump = (kind, n) => { if (n) counts[kind] = (counts[kind] || 0) + n; };
  let out = text;
  let ignored = 0;

  // (e)와 (d): 리터럴 먼저 — 값이 곧 토큰이므로 모양 규칙이 놓치는 자리(예: URL 안, JSON 문자열
  // 안, 줄바꿈 없는 로그 덩어리)에서도 반드시 사라져야 한다.
  const seen = new Set();
  for (const raw of secrets) {
    const value = typeof raw === "string" ? raw : "";
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (value.length < MIN_LITERAL) { ignored++; continue; }
    for (const [kind, needle] of [["x-access-token", Buffer.from(`x-access-token:${value}`).toString("base64")], ["env-value", value]]) {
      const parts = out.split(needle);
      if (parts.length > 1) { bump(kind, parts.length - 1); out = parts.join(REDACTED(kind)); }
    }
  }

  for (const p of PATTERNS) {
    let n = 0;
    // `keep`은 첫 캡처(head)만 남긴다. 그 뒤의 캡처는 지워야 할 값이므로 절대 되붙이지 않는다.
    out = out.replace(p.re, (m, head) => { n++; return p.keep ? `${head}${REDACTED(p.kind)}` : REDACTED(p.kind); });
    bump(p.kind, n);
  }
  return { text: out, counts, ignored };
}

/**
 * git의 휴리스틱과 같다: 앞 8000바이트 안에 NUL이 있으면 바이너리다(스크린샷·코어덤프·아카이브).
 * 바이너리는 **한 바이트도 건드리지 않는다** — 텍스트로 다시 쓰면 파일이 깨지고, qa 증거가 사라진다.
 */
export function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function walk(target, out) {
  let st;
  try { st = statSync(target); } catch { return out; }   // 업로드 경로는 없을 수 있다(`if-no-files-found: ignore`)
  if (st.isDirectory()) { for (const name of readdirSync(target)) walk(join(target, name), out); return out; }
  if (st.isFile()) out.push(target);
  return out;
}

/**
 * 주어진 경로들(파일 또는 디렉토리) 아래의 모든 텍스트 파일을 제자리에서 스크럽한다.
 * 없는 경로는 조용히 넘어간다 — 업로드 스텝 자신이 `if-no-files-found: ignore`다.
 * 바뀐 파일만 다시 쓴다(mtime을 흔들지 않는다).
 */
export function scrubPaths(paths, { secrets = [] } = {}) {
  const counts = {};
  let scanned = 0, changed = 0, skippedBinary = 0, ignored = 0, unreadable = 0;
  const files = [];
  for (const p of paths) if (p) walk(p, files);
  for (const file of files) {
    let buf;
    try { buf = readFileSync(file); } catch { unreadable++; continue; }
    scanned++;
    if (isBinary(buf)) { skippedBinary++; continue; }
    const src = buf.toString("utf8");
    const r = scrubText(src, { secrets });
    ignored = Math.max(ignored, r.ignored);
    for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] || 0) + v;
    if (r.text !== src) {
      try { writeFileSync(file, r.text); changed++; }
      catch { unreadable++; }
    }
  }
  return { counts, scanned, changed, skippedBinary, ignored, unreadable };
}

/** 요약 한 줄 — **개수만**. 값은 한 글자도 들어가지 않는다. */
scrubPaths.summary = ({ scanned, changed, skippedBinary, ignored, unreadable = 0, counts }) => {
  const kinds = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`);
  return `factory: scrub-artifacts scanned=${scanned} changed=${changed} skipped-binary=${skippedBinary}`
    + (unreadable ? ` unreadable=${unreadable}` : "")
    + (ignored ? ` env-values-too-short-to-match=${ignored}` : "")
    + (kinds.length ? ` — redacted ${kinds.join(" ")}` : " — nothing redacted");
};

/**
 * CLI 진입: `node .factory/bin/scrub-artifacts.js <path>…`
 *
 * 시크릿은 **env로만** 들어온다 — 인자는 러너 로그에 그대로 찍히므로 값이 인자에 실리면
 * 스크럽이 유출 경로가 된다. 종료 코드는 **언제나 0이다**: 이 스텝은 업로드 앞에 `if: always()`로
 * 서 있고, 여기서 실패해 잡을 붉히면 정작 사후 조사에 필요한 아티팩트가 올라가지 않는다
 * (읽지 못한 파일은 `unreadable=`로 요약 줄에 남는다 — 조용하지 않다).
 * `process.exit`을 여기서 부르지 않는 이유: 그래야 테스트가 이 함수를 그대로 부를 수 있다.
 */
export function runCli(argv = process.argv.slice(2), env = process.env, log = console.log) {
  const paths = argv.filter((a) => !a.startsWith("--"));
  if (!paths.length) { console.error("usage: scrub-artifacts.js <path>…"); return 2; }
  const secrets = SECRET_ENV.map((n) => env[n]).filter((v) => typeof v === "string" && v.length > 0);
  const r = scrubPaths(paths, { secrets });
  log(scrubPaths.summary(r));
  return 0;
}

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) process.exit(runCli());
