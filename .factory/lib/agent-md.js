import { parseFrontmatter } from "./frontmatter.js";

/** 스펙 §7.2 — 역할 `.md`가 반드시 갖춰야 하는 `## ` 섹션들. */
export const REQUIRED_SECTIONS = ["Purpose", "You receive", "You must not", "Lens", "Output", "Examples", "Perspectives", "Lessons"];

/** `.claude/agents/<name>.md` → {frontmatter, sections}. frontmatter는 lib/frontmatter.js 재사용, `tools`는 쉼표 분리 배열로 정규화한다. */
export function parseAgentMd(text) {
  const { data, body } = parseFrontmatter(text);
  const frontmatter = { ...data };
  if (typeof frontmatter.tools === "string") {
    frontmatter.tools = frontmatter.tools.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const sections = new Map();
  let title = null;
  let buf = [];
  const flush = () => { if (title !== null) sections.set(title, buf.join("\n").trim()); };
  for (const line of body.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      title = m[1].trim();
      buf = [];
    } else if (title !== null) {
      buf.push(line);
    }
  }
  flush();
  return { frontmatter, sections };
}

/**
 * REQUIRED_SECTIONS의 이름은 헤더 축약형이다 — "## Output — schema `factory.verdict.v1`"처럼 꾸며진 헤더도
 * 같은 섹션으로 인정한다. 다만 접두 일치를 그대로 쓰면 "## Lens of the reviewer"나 "## Output values" 같은
 * **다른 이름의 섹션**이 필수 섹션 자리를 차지해 lint가 조용히 통과한다. 그래서 규칙은 좁다:
 * 헤더는 `<Name>` 그 자체이거나, 바로 뒤가 ` —`(설명 대시) · `:` · ` (`(괄호 주석) 중 하나여야 한다.
 * → `## Lens`·`## Lens — 무엇을 보는가`·`## Lens:`·`## Lens (deprecated)`는 Lens 섹션이고,
 *   `## Lenses`·`## Lens of the reviewer`는 아니다.
 */
const DECORATORS = [" —", ":", " ("];

function findSection(sections, name) {
  for (const [key, val] of sections) {
    if (key === name) return val;
    if (!key.startsWith(name)) continue;
    const rest = key.slice(name.length);
    if (DECORATORS.some((d) => rest.startsWith(d))) return val;
  }
  return undefined;
}

function bulletsUnderSubheading(text, heading) {
  let inSub = false;
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const h = /^###\s+(.+)$/.exec(line);
    if (h) { inSub = h[1].trim().startsWith(heading); continue; }
    if (inSub && line.startsWith("- ")) out.push(line);
  }
  return out;
}

/**
 * 이 역할은 **아무것도 쓸 수 없어야** 하는가. 두 곳이 같은 답을 써야 한다:
 *   - `.claude/agents/<name>.md`의 PreToolUse 훅이 `deny-all-writes.sh`에 배선돼야 하고(아래 lint),
 *   - `hooks/stop-guard.sh`의 SubagentStop 면제 목록에 그 이름이 있어야 한다.
 * 둘이 어긋나면 교착이다: 쓰기가 막힌 역할이 러너가 남긴 untracked 산출물을 지우지 못한 채 가드에
 * 걸려 영원히 멈추지 못한다. 그래서 이 술어를 export한다 — 훅 테스트가 셸의 case 목록을 이 집합과
 * 역할마다 프로브로 대조한다(F5).
 */
export function needsDenyAllWritesHook(name) {
  if (!name) return false;
  // factory-retro는 제안만 낸다(P4-R4) — lessons·예시 append도, 제안 PR도, 이슈 생성도 전부 L1이 한다.
  // 이 역할이 직접 쓸 수 있게 되는 순간 "근거를 세는 쪽"과 "쓰는 쪽"이 같아져서 위조 불가 전제가 무너진다.
  return name.startsWith("reviewer-") || name.startsWith("plan-") ||
    name === "factory-triage" || name === "factory-verifier" || name === "factory-loader" ||
    name === "factory-retro";
}

/**
 * 쓰기 금지 역할의 PreToolUse matcher가 덮어야 하는 도구 전부. 훅 스크립트는 이 다섯을 전부 판정하지만,
 * matcher에서 빠진 이름은 그 판정이 **애초에 발화하지 않는다** — 빠진 이름 하나가 곧 구멍이다.
 * `Bash`(F6): 전역 `block-dangerous.sh`는 *보호 경로*만 보므로 `echo x > src/a.js`는 그 매처가 아니면
 * 아무도 막지 않는다. `MultiEdit`(KTB-13 r1): allow가 이제 `Edit`·`Write`·`MultiEdit`·`NotebookEdit`을
 * 전역으로 부여하므로, 매처가 좁으면 리뷰어가 그 한 도구로 트리를 고칠 수 있다.
 */
export const DENY_WRITES_TOOLS = Object.freeze(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);
export const DENY_WRITES_MATCHER = DENY_WRITES_TOOLS.join("|");

/** 훅 명령이 `deny-all-writes.sh`인 PreToolUse 엔트리가 있고, 그 matcher가 `DENY_WRITES_TOOLS`를 전부 덮는가. */
function denyAllWritesGap(hooks) {
  const pre = hooks?.PreToolUse;
  if (!Array.isArray(pre)) return DENY_WRITES_TOOLS;
  for (const entry of pre) {
    if (!Array.isArray(entry?.hooks)) continue;
    if (!entry.hooks.some((h) => typeof h?.command === "string" && h.command.includes("deny-all-writes.sh"))) continue;
    if (typeof entry.matcher !== "string") continue;
    const alts = new Set(entry.matcher.split("|").map((s) => s.trim()));
    const missing = DENY_WRITES_TOOLS.filter((t) => !alts.has(t));
    if (!missing.length) return null;
    return missing;   // 배선은 있는데 매처가 좁다 — 무엇이 빠졌는지 그대로 말한다
  }
  return DENY_WRITES_TOOLS;
}

/** 스펙 §7.2 규칙을 검사한다. 위반이 없으면 []. */
export function lintAgentMd(text, { expectedName } = {}) {
  const { frontmatter, sections } = parseAgentMd(text);
  const violations = [];

  if (frontmatter.name !== expectedName) {
    violations.push({ rule: "name", msg: `frontmatter name '${frontmatter.name}' !== expected '${expectedName}'` });
  }
  if (!["opus", "sonnet", "haiku"].includes(frontmatter.model)) {
    violations.push({ rule: "model", msg: `model must be one of opus|sonnet|haiku, got '${frontmatter.model}'` });
  }
  if (!Array.isArray(frontmatter.tools) || frontmatter.tools.length === 0) {
    violations.push({ rule: "tools", msg: "tools must not be empty" });
  }
  for (const s of REQUIRED_SECTIONS) {
    if (findSection(sections, s) === undefined) violations.push({ rule: "section", msg: `missing required section: ## ${s}` });
  }

  const examples = findSection(sections, "Examples");
  if (examples !== undefined) {
    const good = bulletsUnderSubheading(examples, "좋은 발견");
    const bad = bulletsUnderSubheading(examples, "나쁜 발견");
    if (good.length < 2) violations.push({ rule: "examples-good", msg: `Examples/### 좋은 발견 needs >=2 bullets, found ${good.length}` });
    if (bad.length < 2) violations.push({ rule: "examples-bad", msg: `Examples/### 나쁜 발견 needs >=2 bullets, found ${bad.length}` });
  }

  const perspectives = findSection(sections, "Perspectives");
  if (perspectives !== undefined) {
    const count = perspectives.split("\n").filter((l) => l.trim().startsWith("- ")).length;
    if (count < 3) violations.push({ rule: "perspectives", msg: `Perspectives needs >=3 bullets, found ${count}` });
  }

  const lessons = findSection(sections, "Lessons");
  if (lessons !== undefined) {
    const expected = `.factory/lessons/${expectedName}.md`;
    if (!lessons.includes(expected)) violations.push({ rule: "lessons-path", msg: `Lessons must reference ${expected}` });
  }

  if (needsDenyAllWritesHook(frontmatter.name)) {
    const missing = denyAllWritesGap(frontmatter.hooks);
    if (missing) {
      violations.push({ rule: "deny-hook", msg: `write-forbidden role must have hooks.PreToolUse wired to deny-all-writes.sh with a matcher covering ${DENY_WRITES_MATCHER} — missing: ${missing.join(", ")}` });
    }
  }

  return violations;
}
