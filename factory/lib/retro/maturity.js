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

const SCHEMA_GLOBS = ["prisma/schema.prisma", "**/migrations/**", "*.sql", "drizzle.config.*"];
const HTTP_SURFACE_GLOBS = ["**/routes/**", "**/router.*", "**/api/**", "**/server.*", "app.*"];

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
 * (a)는 승격이 아니므로 "이미 그 target 이상" 스킵 규칙을 타지 않는다 — target이 항상 현재
 * maturity 그대로다(경고이지 승격 신호가 아니다). (b)(c)만 "현재 maturity가 target보다 낮을 때"로
 * 걸러진다. 반환은 target으로 dedupe한다(같은 target에 여러 근거가 있으면 첫 근거만 대표로 남되
 * sdk-without-fake는 누락된 SDK 전체를 한 reason에 모아 하나의 후보로 낸다).
 */
export function detectMaturityGaps({ files = [], harness = {}, manifestDeps = [] } = {}) {
  const maturity = harness.harness?.maturity ?? "M0";
  const fakeKeys = Object.keys(harness.test?.fakes || {});
  const gaps = [];

  // (a) 매니페스트에 알려진 외부 SDK가 있는데 harness.test.fakes에 대응 키가 없음.
  const missing = [...new Set(manifestDeps)].filter((d) => isKnownSdk(d) && !hasFake(fakeKeys, d));
  if (missing.length) {
    gaps.push({
      target: maturity,
      rule: "sdk-without-fake",
      reason: `manifest declares external SDK(s) without [test.fakes] entry: ${missing.join(", ")}`,
    });
  }

  // (b) DB 스키마 파일이 있는데 M0.
  if (maturity === "M0" && files.some((f) => matchesAny(SCHEMA_GLOBS, f))) {
    gaps.push({ target: "M1", rule: "db-schema-at-m0", reason: "DB schema files present (prisma/migrations/sql) but harness maturity is M0" });
  }

  // (c) HTTP 라우트 표면(파일 경로 + 매니페스트의 웹 프레임워크 의존성)이 있는데 M1 이하.
  const hasHttpFiles = files.some((f) => matchesAny(HTTP_SURFACE_GLOBS, f));
  const hasHttpFramework = manifestDeps.some((d) => HTTP_FRAMEWORKS.includes(d));
  if ((RANK[maturity] ?? 0) <= RANK.M1 && hasHttpFiles && hasHttpFramework) {
    gaps.push({ target: "M2", rule: "http-at-m1", reason: "HTTP route surface present (express/fastify/hono/koa/next) but harness maturity is M1 or below" });
  }

  const seen = new Set();
  return gaps.filter((g) => (seen.has(g.target) ? false : (seen.add(g.target), true)));
}
