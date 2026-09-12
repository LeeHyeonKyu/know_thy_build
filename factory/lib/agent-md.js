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

function needsDenyAllWritesHook(name) {
  if (!name) return false;
  return name.startsWith("reviewer-") || name.startsWith("plan-") ||
    name === "factory-triage" || name === "factory-verifier" || name === "factory-loader";
}

function hasDenyAllWritesHook(hooks) {
  const pre = hooks?.PreToolUse;
  if (!Array.isArray(pre)) return false;
  return pre.some((entry) => Array.isArray(entry?.hooks) &&
    entry.hooks.some((h) => typeof h?.command === "string" && h.command.includes("deny-all-writes.sh")));
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

  if (needsDenyAllWritesHook(frontmatter.name) && !hasDenyAllWritesHook(frontmatter.hooks)) {
    violations.push({ rule: "deny-hook", msg: "write-forbidden role must have hooks.PreToolUse wired to deny-all-writes.sh" });
  }

  return violations;
}
