// 성숙도 승격 감지(§5.2.1 초기 규칙 3) — 결정적, LLM 없음. retro(L1)가 부른다: 감지된 gap마다
// `factory:harness` 이슈를 만드는 건 L1의 몫이고, 이 모듈은 판정만 낸다(순수 함수, fs를 만지지 않는다).

import { matchesAny } from "../glob.js";

const RANK = { M0: 0, M1: 1, M2: 2 };

// §5.2.1 "매니페스트에 외부 SDK가 추가됐는데 [test.fakes]에 없음"의 "외부 SDK" 어휘 목록.
// 스코프 패키지는 `<scope>/*` 와일드카드로 등록한다.
const KNOWN_SDKS = [
  "@googleapis/*", "googleapis", "stripe", "@slack/*", "twilio",
  "@sendgrid/*", "aws-sdk", "@aws-sdk/*", "openai", "@anthropic-ai/sdk",
];

const HTTP_FRAMEWORKS = ["express", "fastify", "hono", "koa", "next"];

// `*.sql`은 `**/*.sql`로 — 루트 파일만 잡던 원래 glob은 `db/migrations/x.sql`처럼 중첩된 스키마
// 파일을 놓친다. `app.*`는 소스 확장자로 좁힌다 — 장식 없는 `app.*`는 `app.md`·`app.json` 같은
// 문서/설정 파일까지 "HTTP 표면"으로 오판한다.
const SCHEMA_GLOBS = ["prisma/schema.prisma", "**/migrations/**", "**/*.sql", "drizzle.config.*"];
const HTTP_SURFACE_GLOBS = ["**/routes/**", "**/router.*", "**/api/**", "**/server.*", "app.{js,ts,jsx,tsx,mjs,cjs}"];

const isKnownSdk = (dep) => KNOWN_SDKS.some((g) => (g.endsWith("/*") ? dep.startsWith(g.slice(0, -1)) : dep === g));

/** dep 이름이 harness.test.fakes의 어떤 키와 대응하는가 — 정확히 같은 이름, 또는 스코프를 뺀 마지막 세그먼트. */
function hasFake(fakeKeys, dep) {
  if (fakeKeys.includes(dep)) return true;
  const short = dep.split("/").pop();
  return fakeKeys.includes(short);
}

/**
 * detectMaturityGaps({ files, harness, manifestDeps }) → [{target, reason, rule}]
 *   - files: 저장소(또는 이번 diff)의 파일 경로 배열.
 *   - harness: harness.toml 파싱 결과 — `harness.harness.maturity`, `harness.test.fakes`를 읽는다.
 *   - manifestDeps: package.json 등 매니페스트의 의존성 이름 배열(버전 무관, 이름만).
 *
 * (a)는 승격이 아니라 경고다 — `target`은 항상 `null`("no promotion", 컨트롤러 판정 round 1).
 * (b)(c)만 "현재 maturity가 target보다 낮을 때"로 걸러진다("이미 그 target 이상"이면 skip).
 * (c)는 "또는"이다(플랜 원문) — routes 스타일 파일과 프레임워크 의존성 중 **하나만** 있어도 HTTP
 * 표면으로 본다(AND가 아니다).
 * 반환은 dedupe한다: target이 있으면 target으로, (a)처럼 target이 null이면 **rule 이름**으로
 * dedupe 키를 삼는다(target만으로는 여러 null-target 후보를 구별할 수 없다).
 */
export function detectMaturityGaps({ files = [], harness = {}, manifestDeps = [] } = {}) {
  const maturity = harness.harness?.maturity ?? "M0";
  const fakeKeys = Object.keys(harness.test?.fakes || {});
  const gaps = [];

  // (a) 매니페스트에 알려진 외부 SDK가 있는데 harness.test.fakes에 대응 키가 없음 — 승격 아님.
  const missing = [...new Set(manifestDeps)].filter((d) => isKnownSdk(d) && !hasFake(fakeKeys, d));
  if (missing.length) {
    gaps.push({
      target: null,
      rule: "sdk-without-fake",
      reason: `manifest declares external SDK(s) without [test.fakes] entry: ${missing.join(", ")}`,
    });
  }

  // (b) DB 스키마 파일이 있는데 M0.
  if (maturity === "M0" && files.some((f) => matchesAny(SCHEMA_GLOBS, f))) {
    gaps.push({ target: "M1", rule: "db-schema-at-m0", reason: "DB schema files present (prisma/migrations/sql) but harness maturity is M0" });
  }

  // (c) HTTP 라우트 표면 — routes 스타일 파일 또는 웹 프레임워크 의존성 중 하나만 있어도, M1 이하일 때.
  const hasHttpFiles = files.some((f) => matchesAny(HTTP_SURFACE_GLOBS, f));
  const hasHttpFramework = manifestDeps.some((d) => HTTP_FRAMEWORKS.includes(d));
  if ((RANK[maturity] ?? 0) <= RANK.M1 && (hasHttpFiles || hasHttpFramework)) {
    gaps.push({ target: "M2", rule: "http-at-m1", reason: "HTTP route surface present (express/fastify/hono/koa/next dependency, or routes-style files) but harness maturity is M1 or below" });
  }

  const seen = new Set();
  return gaps.filter((g) => {
    const key = g.target === null ? g.rule : g.target;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
