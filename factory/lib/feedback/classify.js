import { matchesAny } from "../glob.js";
import { fingerprint } from "./fingerprint.js";

/**
 * 한 발견(finding)을 **주인**에게 배정한다. "팩토리를 개선한다"는 말은 주인이 서로 다른 두 가지를
 * 뜻하고, 둘은 절대 섞이면 안 된다(spec §2) — 섞이는 순간 KTB는 고칠 수 없는 이슈로 뒤덮이고
 * (§3 "harness 발견이 KTB를 덮지 않게 한다"), 쓰는 저장소는 자기 설정 문제를 남의 문제로 미룬다.
 *
 *   `harness` — 쓰는 저장소 자신의 팩토리 설정(harness.toml, CHARTER, scripts/, 자기가 쓴 role 프롬프트,
 *               lessons, protected 목록). 고치는 사람: 그 저장소의 주인. 착지점: 그 저장소의 harness 이슈.
 *   `ktb`     — KTB가 **배포한** 것(설치 매니페스트에 실제로 들어 있는 dest 중 owner:factory인 것 —
 *               .factory/** 엔진, 배포된 .claude/agents/*.md 프롬프트, templates/기본값, skills).
 *               고치는 사람: KTB. 착지점: KTB의 factory-improvement 이슈.
 *   `product` — 쓰는 저장소의 **제품 코드** 결함(source_glob/test_glob). 라우팅하지 않는다 —
 *               팩토리의 평상시 일이고, escaped defect로 **결과 지표**에만 쓰인다.
 *   `ambiguous` — 인과 파일을 해석할 수 없는 것. **절대 버리지 않는다.** 두 후보를 모두 적어 사람에게
 *               올린다(오라우팅보다 미판정이 낫다).
 *
 * ## 규칙표 — 위에서부터 처음 맞는 줄 하나가 답이다
 *
 * | # | 검사                                                        | owner    | 태그        | confidence |
 * |---|-------------------------------------------------------------|----------|-------------|------------|
 * | 1 | **설치 매니페스트 멤버십** `isInstalled(path)` → `ownerOf(path)`: `project`/`script` → user, `factory` → factory | user/factory | `harness`/`ktb` | high |
 * | 2 | 생성된 증거물 `.factory/out/**`, `.factory/records/**`, `docs/factory/runs/**` | —        | `ambiguous` | low |
 * | 3 | 쓰는 저장소가 **명시한** `[test].source_glob`/`test_glob`     | product  | `product`   | high       |
 * | 4 | 매니페스트에 없지만 채택자 소유가 분명한 경로(아래 `PREFIX_USER`) | user     | `harness`   | medium     |
 * | 5 | KTB 소스 트리의 배포물 `templates/{factory,know-thy-build}/**`  | factory  | `ktb`       | medium     |
 * | 6 | **리뷰어가 이 저장소의 diff를 읽고 지목한 파일**(`review-must_fix`) | product | `product` | medium |
 * | 7 | 그 밖 전부                                                   | —        | `ambiguous` | low        |
 *
 * ## 6번 — `review-must_fix`의 경로는 **출처가 다르다**(최종 리뷰 nit 7)
 * 1~5번을 다 지나온 경로를 7번이 `ambiguous`로 받는 것은 "이 파일이 무엇인지 해석할 수 없다"는 뜻인데,
 * `review-must_fix`의 `where`에는 그 말이 성립하지 않는다: 그 값은 리뷰어가 **이 저장소의 PR diff를
 * 읽으면서** 지목한 파일이다. 팩토리가 설치한 것은 전부 매니페스트에 있고(1번), 채택자의 팩토리 설정은
 * 4번이 받고, KTB 소스 트리는 5번이 받는다 — 그 셋 중 어느 것도 아닌 저장소 안의 파일은 정의상
 * **그 저장소 자신의 파일**이다. 실제로 데모 #18에서 리뷰어가 `docs/factory/DECISIONS.md`(KTB 자신의
 * ADR 로그 — 설치되지 않는다)를 지목했고, 그 발견은 `ambiguous`로 떨어져 "harness냐 ktb냐"를 묻는
 * 소유자 노트가 됐다. 둘 다 아니다. 그리고 `[test].source_glob`을 선언하지 않은 채택자(대다수)에게는
 * **모든 제품 코드 발견**이 같은 이유로 `ambiguous`였다 — 라우팅하지 않을 것에 매번 노트를 다는 잡음이다.
 *
 * 오라우팅 위험은 없다: `product`의 disposition은 `outcome`이고 **아무 데로도 라우팅하지 않는다**
 * (`ambiguous`와 달리 노트조차 쓰지 않는다). 그리고 이 줄은 1~5번 **뒤**에 있으므로 설치된 배포물도,
 * 증거물(`.factory/out/**`·`docs/factory/runs/**` — 2번)도, 채택자의 팩토리 설정도 여기 오지 않는다.
 * 경로가 아예 없는 발견은 여전히 `ambiguous`다 — 그때는 지목된 파일 자체가 없다.
 * 게이트 발견의 경로는 러너가 **추론한** 것이라 이 줄을 태우지 않는다(7번 그대로).
 *
 * 1번이 **prefix가 아니라 멤버십**인 것이 이 파일의 핵심이다(리뷰 must_fix 1). `ownerOf`는 전역
 * 함수라 모르는 경로에도 `"factory"`라 답한다 — `.factory/`/`.claude/` prefix만 보고 넘기면
 * `.factory/out/unit.json`(채택자의 unit 명령이 쓴 출력), `.claude/agents/reviewer-<custom>.md`
 * (`:role` 스킬이 채택자 저장소에 만든 역할), `.claude/settings.local.json`이 전부 `ktb`가 되어
 * **채택자의 물건이 KTB 이슈로 올라간다.** 그래서 dest 집합(`buildManifest(...).map(e => e.dest)`)을
 * 주입받아 **실제로 배포된 파일만** 매니페스트의 판정을 받는다.
 * 3번이 4·5번보다 앞인 것도 같은 이유다(must_fix 2): `templates/`는 KTB 저장소에서만 특별하고,
 * Flask/Jinja 채택자에게는 그냥 제품 디렉터리다 — 채택자가 명시한 glob이 약한 prefix 표를 이긴다.
 * 매니페스트 dest의 owner가 틀렸다면(예: 채택자가 채우는 파일이 owner:factory로 실려 있다면) 그것은
 * **매니페스트의 버그**이고, 그 자체가 `ktb` 발견이다 — 여기서 예외로 덮지 않는다.
 *
 * ## 다중 태그 (harness + ktb)
 * 인과 파일이 `owner: user`인데 그 실수를 **KTB가 배포한 안내/기본값이 막지 못한 것**이면 `ktb`를
 * 함께 붙인다. 방아쇠는 증거여야지 **어휘여서는 안 된다**(리뷰 must_fix 3 — `default`/`template`/
 * `roster` 같은 낱말 하나로 붙이면 평범한 harness 발견의 상당수가 KTB로 흘러간다):
 *   ① `extra.guidance_path` — 호출자가 "이 배포물의 안내가 실패했다"고 지목한 owner:factory 경로(명시).
 *   ② `GUIDANCE_FAILURE_RE` — 안내 실패를 **주장하는 구절**("did not prevent", "template guidance",
 *      "shipped default", "the factory already quotes" …). 텍스트 신호이므로 confidence를 medium으로
 *      낮춘다. reason이 단지 `.factory/...` 경로를 **인용**하는 것은 방아쇠가 아니다(인용된 경로는
 *      원인이 아니라 자리다).
 * 실례: own-cal의 `test_one` 따옴표 — 하네스가 따옴표를 적었고(harness), 템플릿의 "따옴표를 붙이지
 * 말라"는 안내는 그것을 막기에 약했다(ktb).
 *
 * ## 행동(behavioural) 발견
 * `kind: "behavioural"`(rubber-stamp / dead debate / waste)의 원인은 프롬프트·티어·로스터 —
 * 전부 owner:factory이므로 **본성상 ktb**다. 그러나 **호출자가 `paired === true`로 쌍 증거를
 * 단언했을 때만** 태그를 준다(spec §5, Goodhart): 승인률만으로는, 토론 길이만으로는, 비용만으로는
 * 아무것도 판정할 수 없다. 쌍이 없으면 `tags: []` + `disposition: "withheld"` + `payload.withheld`.
 *
 * ## 결과의 `disposition` (T3/T5가 이걸로 갈라진다 — 리뷰 should_fix 3)
 *   `"routed"`   harness/ktb — 이슈로 라우팅한다
 *   `"outcome"`  product — 라우팅하지 않고 결과 지표로만 센다
 *   `"ambiguous"` 두 후보를 적은 소유자 노트를 남긴다(`candidates`)
 *   `"withheld"` 쌍 증거가 없는 행동 신호 — 라우팅하지 않는다. 다만 T3/T5는 **세어서 보고**한다
 *                (조용히 사라지면 체계적으로 쌍이 없는 신호를 아무도 못 본다).
 *
 * 순수 함수다: I/O 없음, gh 없음, 시계 없음. `ownerOf`와 `isInstalled`는 **필수**로 주입한다 —
 * 빠뜨리면 던진다(리뷰 must_fix 4: 예전에는 조용히 prefix 표로 떨어져 **정반대** 답을 냈다).
 */

/** 매니페스트 밖이지만 채택자 소유가 분명한 경로(규칙표 4번). 전부 앵커링한다 — `src/scripts/x.sh`는 걸리면 안 된다. */
const PREFIX_USER = [
  /^harness\.toml$/,                       // 저장소 루트에 적힌 하네스(설치본이 아닌 표기)
  /^docs\/factory\/CHARTER\.md$/,
  /^scripts\//,
  /^\.github\/workflows\/(?!factory-)/,    // 채택자 자신의 워크플로
  /^\.factory\/lessons\//,                 // 배포된 lessons가 아니면 채택자가 쓴 것
  /^\.claude\/agents\//,                   // 배포된 역할이 아니면 `:role`이 만든 채택자의 역할
  /^\.claude\/commands\//,
  /^\.claude\/(settings\.local\.json|CLAUDE\.md)$/,
];
/** KTB 소스 트리의 배포물(규칙표 5번). `.factory/`·`.claude/`는 여기 없다 — 1번(멤버십)이 유일한 길이다. */
const PREFIX_FACTORY = [/^templates\/(?:factory|know-thy-build)\//];
/** 실행이 남긴 증거물. 배포된 코드가 아니므로 **절대 `ktb`가 아니다**(리뷰 must_fix 1). */
const EVIDENCE = [/^\.factory\/out\//, /^\.factory\/records\//, /^docs\/factory\/runs\//];

/**
 * 안내 실패를 **주장하는 구절**만 다중 태그를 연다(must_fix 3). 낱말 하나(`default`, `template`,
 * `roster`, `tier`, `skill`)로는 절대 열리지 않는다.
 */
const GUIDANCE_FAILURE_RE = new RegExp(
  [
    "(?:did|does|do|would) not prevent",
    "(?:did ?n[o']t|failed to) (?:prevent|catch|stop)",
    "too weak to prevent",
    "template (?:guidance|says|tells|instructs|told)",
    "(?:guidance|default|defaults|template|prompt) (?:was|is|were) too weak",
    "shipped (?:guidance|default|defaults|template|prompt)",
    "the factory already (?:quotes|adds|appends|wraps|sets|provides|handles|does)",
    "ktb(?:'s)? (?:guidance|default|defaults|template|prompt) ",
  ].join("|"),
  "i",
);

/** "src/app.js:42 [commands].test_one" → { path, line, locus } */
export function parseCausalPath(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { path: null, line: null, locus: null };
  const [head, ...rest] = s.split(/\s+/);
  const locus = rest.join(" ") || null;
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(head);
  const path = (m ? m[1] : head).replace(/^\.\//, "");
  const line = m ? Number(m[2]) : null;
  // `:0`은 줄 번호가 아니다 — falsy라 하류의 `line ? … : …`가 "줄 없음"으로 렌더한다(리뷰 nit 4).
  return { path: path || null, line: Number.isInteger(line) && line >= 1 ? line : null, locus };
}

/** 주입된 멤버십(Set·배열·술어 함수 아무거나)을 술어 하나로 정규화한다. */
function toPredicate(isInstalled) {
  if (typeof isInstalled === "function") return isInstalled;
  if (isInstalled instanceof Set) return (p) => isInstalled.has(p);
  if (Array.isArray(isInstalled)) { const s = new Set(isInstalled); return (p) => s.has(p); }
  return null;
}

/**
 * 경로 하나의 주인. `"user" | "factory" | "product" | null`.
 * @returns {{owner: string|null, via: "manifest"|"evidence"|"glob"|"prefix"|"none"}}
 */
export function resolveOwner(path, { ownerOf, isInstalled, harness } = {}) {
  if (!path) return { owner: null, via: "none" };
  const installed = toPredicate(isInstalled);
  if (installed && typeof ownerOf === "function" && installed(path)) {
    const o = ownerOf(path);
    // manifest 어휘(project|script|factory) → 이 loop의 어휘(user|factory).
    // `script`(quarantine.toml)는 팩토리 스크립트가 쓰지만 **쓰는 저장소의 상태**다 — 그 항목이 남아
    // 있을지는 그 저장소 주인이 정하므로 user로 읽는다.
    return { owner: o === "factory" ? "factory" : "user", via: "manifest" };
  }
  if (EVIDENCE.some((r) => r.test(path))) return { owner: null, via: "evidence" };
  const globs = [...(harness?.test?.source_glob || []), ...(harness?.test?.test_glob || [])];
  if (globs.length && matchesAny(globs, path)) return { owner: "product", via: "glob" };
  if (PREFIX_USER.some((r) => r.test(path))) return { owner: "user", via: "prefix" };
  if (PREFIX_FACTORY.some((r) => r.test(path))) return { owner: "factory", via: "prefix" };
  return { owner: null, via: "none" };
}

const TAG_OF = { user: "harness", factory: "ktb", product: "product" };

function candidatesFor(finding, path, via) {
  const where = path ? `\`${path}\`` : "no causal file";
  const why = via === "evidence" ? " — it is generated run evidence, not shipped code; the cause is whatever wrote it" : "";
  return [
    `harness — the using repo's own factory config (harness.toml, CHARTER, scripts/, its own role prompts and lessons) may be the cause (${where}${why}; ${finding.kind})`,
    `ktb — a KTB-shipped file (.factory/** engine, a shipped .claude/agents/*.md prompt, template/default, skill) may be the cause (${where}${why}; ${finding.kind})`,
  ];
}

/**
 * @param {object} args
 * @param {object} args.finding `{ kind, issue, repo, stage, round?, causal_path?, reason, role?, context_manifest?, extra?, paired? }`
 * @param {(dest:string)=>string} args.ownerOf 설치 매니페스트의 `ownerOf`(필수, 주입)
 * @param {Set<string>|string[]|((dest:string)=>boolean)} args.isInstalled 설치 매니페스트의 dest 멤버십(필수, 주입)
 * @param {string} args.ktbVersion 이 실행이 쓴 KTB 버전(payload 증거)
 * @param {object} args.harness 로드된 harness(`[test].source_glob`/`test_glob` → product 판정)
 * @returns {{tags:string[], causal:object, payload:object, fingerprint:string,
 *            confidence:"high"|"medium"|"low", disposition:string, candidates?:string[]}}
 */
export function classifyFinding({ finding, ownerOf, isInstalled, ktbVersion = null, harness = null } = {}) {
  if (!finding || typeof finding !== "object") throw new TypeError("classifyFinding: finding is required");
  if (typeof ownerOf !== "function") throw new TypeError("classifyFinding: ownerOf is required (inject the real one from factory/cli/manifest.js) — without it every adopter harness finding would route to KTB");
  const installed = toPredicate(isInstalled);
  if (!installed) throw new TypeError("classifyFinding: isInstalled is required — a Set/array of install-manifest dests (buildManifest(...).map(e => e.dest)) or a predicate; prefixes are not membership");

  const ctx = { ownerOf, isInstalled: installed, harness };
  const { path, line, locus } = parseCausalPath(finding.causal_path);
  const extra = finding.extra || {};

  let tags = [];
  let candidates = null;
  let confidence = "low";
  let owner = null;
  let withheld = null;
  let disposition;

  if (finding.kind === "behavioural") {
    const resolved = resolveOwner(path, ctx);
    // 파일이 없거나 제품 경로여도 owner는 factory로 읽는다 — 행동 발견의 원인은 프롬프트·티어·로스터다.
    owner = resolved.owner === "factory" || resolved.owner === "user" ? resolved.owner : null;
    if (finding.paired === true) {
      tags = ["ktb"];
      confidence = resolved.via === "manifest" ? "high" : "medium";
      disposition = "routed";
    } else {
      tags = [];
      confidence = "low";
      disposition = "withheld";
      withheld = "behavioural finding withheld — the caller did not assert paired evidence (spec §5: approve-rate without escaped defects, debate length without delta, cost without risk are undecidable)";
    }
  } else {
    const resolved = resolveOwner(path, ctx);
    owner = resolved.owner;
    let via = resolved.via;
    /**
     * 규칙표 6번 — 리뷰어가 이 저장소의 diff를 읽고 지목한 파일은, 1~5번 중 무엇도 아니라면
     * **그 저장소 자신의 파일**이다(최종 리뷰 nit 7). 경로가 있어야 하고(경로 없는 발견은 여전히
     * `ambiguous`다), `via: "evidence"`(생성된 증거물)는 이 문을 통과하지 못한다 — 그것을 지목한
     * 리뷰어가 본 것은 파일이 아니라 어떤 런이 남긴 자국이고, 원인은 그것을 쓴 쪽이다.
     */
    if (!owner && path && via === "none" && finding.kind === "review-must_fix") {
      owner = "product";
      via = "repo";
    }
    if (!owner) {
      tags = ["ambiguous"];
      confidence = "low";
      disposition = "ambiguous";
      candidates = candidatesFor(finding, path, via);
    } else {
      tags = [TAG_OF[owner]];
      // 선언된 glob(`high`)과 표의 약한 추론(`medium`)을 섞지 않는다 — 6번도 후자다.
      confidence = via === "prefix" || via === "repo" ? "medium" : "high";
      disposition = owner === "product" ? "outcome" : "routed";
      if (owner === "user") {
        // 다중 태그: KTB가 배포한 안내/기본값이 이 실수를 막지 못했는가? 증거만이 방아쇠다.
        const explicit = Boolean(extra.guidance_path) && resolveOwner(parseCausalPath(extra.guidance_path).path, ctx).owner === "factory";
        const textual = !explicit && GUIDANCE_FAILURE_RE.test(String(finding.reason ?? ""));
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
  // 지문은 태그를 재료로 쓰지 않는다 — 같은 원인이 태그가 흔들린다고 상류 이슈 둘로 쪼개지면 안 된다.
  const fp = fingerprint({ path, reason: finding.reason });

  const payload = {
    issue: finding.issue ?? null,
    repo: finding.repo ?? null,
    stage: finding.stage ?? null,
    round: finding.round ?? null,
    kind: finding.kind ?? null,
    ktb_version: ktbVersion,
    // payload는 **직렬화되어 이슈 본문에 박히는 증거**다. 결과 객체와 같은 배열/객체를 공유하면
    // 호출자가 `result.tags.push(...)` 한 번으로 그 증거를 조용히 고쳐 쓴다(리뷰 should_fix 5).
    tags: [...tags],
    causal: { ...causal },
    role: finding.role ? { name: finding.role, context_manifest: finding.context_manifest ?? [] } : null,
    chain: extra.chain ?? [],
    reason: finding.reason ?? null,
    fingerprint: fp,
  };
  if (extra.cost) payload.cost = extra.cost;
  if (withheld) payload.withheld = withheld;
  if (extra.guidance_path) payload.guidance_path = extra.guidance_path;

  const out = { tags, causal, payload, fingerprint: fp, confidence, disposition };
  if (candidates) out.candidates = candidates;
  return out;
}
