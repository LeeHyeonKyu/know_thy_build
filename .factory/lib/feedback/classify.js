import { matchesAny } from "../glob.js";
import { fingerprint } from "./fingerprint.js";

/**
 * 한 발견(finding)을 **주인**에게 배정한다. "팩토리를 개선한다"는 말은 주인이 서로 다른 두 가지를
 * 뜻하고, 둘은 절대 섞이면 안 된다(spec §2) — 섞이는 순간 KTB는 고칠 수 없는 이슈로 뒤덮이고,
 * 쓰는 저장소는 자기 설정 문제를 남의 문제로 미룬다.
 *
 *   `harness` — 쓰는 저장소 자신의 팩토리 설정(harness.toml, CHARTER, scripts/, protected 목록).
 *               고치는 사람: 그 저장소의 주인. 착지점: 그 저장소의 harness 이슈.
 *   `ktb`     — KTB가 배포하는 것(.factory/** 엔진, .claude/agents/*.md 프롬프트, templates/기본값,
 *               skills, tier/roster 정책). 고치는 사람: KTB. 착지점: KTB의 factory-improvement 이슈.
 *   `product` — 쓰는 저장소의 **제품 코드** 결함(source_glob/test_glob). 라우팅하지 않는다 —
 *               팩토리의 평상시 일이고, escaped defect로 **결과 지표**에만 쓰인다.
 *   `ambiguous` — 인과 파일을 해석할 수 없는 것. **절대 버리지 않는다.** 두 후보를 모두 적어 사람에게
 *               올린다(오라우팅보다 미판정이 낫다).
 *
 * ## 규칙표 (결정적 — 인과 파일의 설치 매니페스트 owner가 결정한다)
 *
 * | 인과 경로                                   | owner 해석                      | 태그        | confidence |
 * |--------------------------------------------|---------------------------------|-------------|------------|
 * | `.factory/harness.toml`, `.factory/lessons/**` | `ownerOf` → `project`        | `harness`   | high       |
 * | `.factory/quarantine.toml`                  | `ownerOf` → `script` *          | `harness`   | high       |
 * | `.factory/**`(그 밖 전부), `.claude/**`, `.github/workflows/factory-*` | `ownerOf` → `factory` | `ktb` | high |
 * | `harness.toml`(맨 이름), `docs/factory/CHARTER.md`, `scripts/**` | prefix 표 → user | `harness` | medium |
 * | `templates/**`, `templates/know-thy-build/**` | prefix 표 → factory           | `ktb`       | medium     |
 * | 위에 없고 `source_glob`/`test_glob`에 걸림    | 제품 코드                       | `product`   | high       |
 * | 그 밖 / 경로 없음                            | 해석 불가                       | `ambiguous` | low        |
 *
 *  * `script`는 팩토리 스크립트가 쓰지만 **쓰는 저장소의 상태**(격리된 테스트 목록)다 — 그 항목이
 *    남아 있을지는 그 저장소 주인이 정하므로 `harness`로 읽는다.
 *
 * ## 다중 태그 (harness + ktb)
 * 인과 파일이 `owner: user`인데 그 실수를 **KTB가 배포한 안내/기본값이 막지 못한 것**이면 `ktb`를
 * 함께 붙인다. 방아쇠는 둘 중 하나:
 *   ① `extra.guidance_path`가 owner:factory로 해석된다(명시 — confidence 유지),
 *   ② reason이 KTB가 배포한 안내를 지목한다(`template`/`guidance`/`default`/`prompt`/`shipped`/
 *      owner:factory로 해석되는 경로 토큰 — 텍스트 신호이므로 confidence를 medium으로 낮춘다).
 * 실례: own-cal의 `test_one` 따옴표 — 하네스가 따옴표를 적었고(harness), 템플릿의 "따옴표를 붙이지
 * 말라"는 안내는 그것을 막기에 약했다(ktb).
 *
 * ## 행동(behavioural) 발견
 * `kind: "behavioural"`(rubber-stamp / dead debate / waste)의 원인은 프롬프트·티어·로스터 —
 * 전부 owner:factory이므로 **본성상 ktb**다. 그러나 **호출자가 `paired === true`로 쌍 증거를
 * 단언했을 때만** 태그를 준다(spec §5, Goodhart): 승인률만으로는, 토론 길이만으로는, 비용만으로는
 * 아무것도 판정할 수 없다. 쌍이 없으면 태그는 비어 있고(`tags: []`) `payload.withheld`가 이유를
 * 적는다 — 호출자(T4/T3)는 빈 태그 발견을 라우팅하지 않는다.
 *
 * 순수 함수다: I/O 없음, gh 없음. `ownerOf`는 주입한다(`factory/cli/manifest.js`의 실물).
 */

/** 설치 매니페스트가 실제로 다루는 경로인가 — `ownerOf`는 전역 함수라 모르는 경로도 "factory"라 답한다. */
const INSTALLED = [/^\.factory\//, /^\.claude\//, /^\.github\/workflows\/factory-/, /^docs\/factory\/CHARTER\.md$/];
/** 매니페스트 밖의 prefix 표(설치본이 아닌 저장소에서 온 경로). */
const PREFIX_USER = [/^harness\.toml$/, /^factory\/harness\.toml$/, /^docs\/factory\/CHARTER\.md$/, /^scripts\//, /^\.github\/workflows\/(?!factory-)/];
const PREFIX_FACTORY = [/^templates\//, /^\.claude\//, /^\.factory\//, /^\.github\/workflows\/factory-/];
/** KTB가 배포한 안내/기본값을 지목하는 텍스트 신호(다중 태그 방아쇠 ②). */
const GUIDANCE_RE = /\b(template|templates|guidance|default|defaults|prompt|prompts|skill|roster|tier|shipped|factory already)\b/i;
const PATH_TOKEN_RE = /(?:^|[\s"'`([])((?:\.factory|\.claude|\.github|templates|docs\/factory)\/[\w./*-]+)/g;

/** "src/app.js:42 [commands].test_one" → { path, line, locus } */
export function parseCausalPath(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { path: null, line: null, locus: null };
  const [head, ...rest] = s.split(/\s+/);
  const locus = rest.join(" ") || null;
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(head);
  const path = (m ? m[1] : head).replace(/^\.\//, "");
  return { path: path || null, line: m ? Number(m[2]) : null, locus };
}

/**
 * 경로 하나의 주인. `"user" | "factory" | "product" | null`.
 * 설치본 경로면 매니페스트가 답하고(권위), 아니면 prefix 표, 그래도 아니면 제품 globs, 끝내 모르면 null.
 */
export function resolveOwner(path, { ownerOf, harness } = {}) {
  if (!path) return { owner: null, via: "none" };
  if (INSTALLED.some((r) => r.test(path)) && typeof ownerOf === "function") {
    const o = ownerOf(path);
    // manifest 어휘(project|script|factory) → 이 loop의 어휘(user|factory)
    return { owner: o === "factory" ? "factory" : "user", via: "manifest" };
  }
  if (PREFIX_USER.some((r) => r.test(path))) return { owner: "user", via: "prefix" };
  if (PREFIX_FACTORY.some((r) => r.test(path))) return { owner: "factory", via: "prefix" };
  const globs = [...(harness?.test?.source_glob || []), ...(harness?.test?.test_glob || [])];
  if (globs.length && matchesAny(globs, path)) return { owner: "product", via: "glob" };
  return { owner: null, via: "none" };
}

const TAG_OF = { user: "harness", factory: "ktb", product: "product" };

/** reason 안에서 owner:factory로 해석되는 경로 토큰을 찾는다(다중 태그 방아쇠 ②의 강한 형태). */
function factoryPathInText(text, ctx) {
  for (const m of String(text ?? "").matchAll(PATH_TOKEN_RE)) {
    const { path } = parseCausalPath(m[1]);
    if (resolveOwner(path, ctx).owner === "factory") return path;
  }
  return null;
}

function candidatesFor(finding, path) {
  const where = path ? `\`${path}\`` : "no causal file";
  return [
    `harness — the using repo's own factory config (harness.toml, CHARTER, scripts/, protected list) may be the cause (${where}; ${finding.kind})`,
    `ktb — a KTB-shipped file (.factory/** engine, .claude/agents/*.md prompt, template/default, skill) may be the cause (${where}; ${finding.kind})`,
  ];
}

/**
 * @param {object} args
 * @param {object} args.finding `{ kind, issue, repo, stage, round?, causal_path?, reason, role?, context_manifest?, extra?, paired? }`
 * @param {(dest:string)=>string} args.ownerOf 설치 매니페스트의 `ownerOf`(주입)
 * @param {string} args.ktbVersion 이 실행이 쓴 KTB 버전(payload 증거)
 * @param {object} args.harness 로드된 harness(`[test].source_glob`/`test_glob` → product 판정)
 * @returns {{tags:string[], causal:object, payload:object, fingerprint:string, confidence:"high"|"medium"|"low", candidates?:string[]}}
 */
export function classifyFinding({ finding, ownerOf, ktbVersion = null, harness = null } = {}) {
  if (!finding || typeof finding !== "object") throw new TypeError("classifyFinding: finding is required");
  const ctx = { ownerOf, harness };
  const { path, line, locus } = parseCausalPath(finding.causal_path);
  const extra = finding.extra || {};

  let tags = [];
  let candidates = null;
  let confidence = "low";
  let owner = null;
  let withheld = null;

  if (finding.kind === "behavioural") {
    // 쌍 증거가 없는 행동 신호는 발견이 아니다(spec §5). 태그를 주지 않되 이유는 남긴다.
    const resolved = resolveOwner(path, ctx);
    owner = resolved.owner === "product" ? null : resolved.owner || "factory";
    if (finding.paired === true) {
      tags = ["ktb"];
      confidence = resolved.via === "manifest" ? "high" : "medium";
    } else {
      tags = [];
      confidence = "low";
      withheld = "behavioural finding withheld — the caller did not assert paired evidence (spec §5: approve-rate without escaped defects, debate length without delta, cost without risk are undecidable)";
      candidates = [`ktb — behavioural causes (prompts, tiers, rosters) are owner:factory, but ${withheld}`];
    }
  } else {
    const resolved = resolveOwner(path, ctx);
    owner = resolved.owner;
    if (!owner) {
      tags = ["ambiguous"];
      confidence = "low";
      candidates = candidatesFor(finding, path);
    } else {
      tags = [TAG_OF[owner]];
      confidence = resolved.via === "prefix" ? "medium" : "high";
      if (owner === "user") {
        // 다중 태그: KTB가 배포한 안내/기본값이 이 실수를 막지 못했는가?
        const explicit = extra.guidance_path && resolveOwner(parseCausalPath(extra.guidance_path).path, ctx).owner === "factory";
        const textual = !explicit && (factoryPathInText(finding.reason, ctx) || GUIDANCE_RE.test(String(finding.reason ?? "")));
        if (explicit || textual) {
          tags = ["harness", "ktb"];
          if (textual) confidence = "medium";
        }
      }
    }
  }

  const causal = {
    path,
    line,
    owner,
    locus,
    command: extra.command ?? null,
    test: extra.test ?? null,
    snippet: extra.snippet ?? null,
  };
  const fp = fingerprint({ tags, path, reason: finding.reason });

  const payload = {
    issue: finding.issue ?? null,
    repo: finding.repo ?? null,
    stage: finding.stage ?? null,
    round: finding.round ?? null,
    kind: finding.kind ?? null,
    ktb_version: ktbVersion,
    tags,
    causal,
    role: finding.role ? { name: finding.role, context_manifest: finding.context_manifest ?? [] } : null,
    chain: extra.chain ?? [],
    reason: finding.reason ?? null,
    fingerprint: fp,
  };
  if (extra.cost) payload.cost = extra.cost;
  if (withheld) payload.withheld = withheld;
  if (extra.guidance_path) payload.guidance_path = extra.guidance_path;

  const out = { tags, causal, payload, fingerprint: fp, confidence };
  if (candidates) out.candidates = candidates;
  return out;
}
