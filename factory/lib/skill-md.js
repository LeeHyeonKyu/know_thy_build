import { parseFrontmatter } from "./frontmatter.js";

/** 스펙 §13.3 — 모든 스킬 `.md`가 갖춰야 하는 `## ` 섹션(순서 고정). `## Language`는 {{LANG}} 치환 문단이다. */
export const SKILL_SECTIONS = ["Language", "Trigger", "Reads", "Does", "Produces", "Must not"];

/** 사람 지점 13개(§13.1) — Define 5 + Operate 8. architect/designer는 Phase 1 보조 스킬이라 이 카탈로그 밖이다. */
export const DEFINE_SKILLS = ["project", "technical", "qa", "feature", "issue"];
export const OPERATIONAL_SKILLS = ["harness", "next", "clarify", "unstick", "proposal", "role", "digest", "status"];
export const ALL_SKILLS = [...DEFINE_SKILLS, ...OPERATIONAL_SKILLS];

/** `:digest`·`:status`는 읽기 전용 — 라벨을 전이하지도, human-decision을 남기지도 않는다(§13.3). */
const READ_ONLY_OPS = new Set(["digest", "status"]);

/** `<name>.md` → {frontmatter, sections}. `lib/agent-md.js`의 `## ` 분할 방식을 그대로 쓴다. */
export function parseSkillMd(text) {
  const { data, body } = parseFrontmatter(text);
  const frontmatter = { ...data };
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

/** `gh pr merge`를 언급하면서 같은 줄에서 그것을 금지한다고 말하는 문장이 있는가. */
function hasGhPrMergeProhibition(text) {
  const negation = /(never|must not|forbidden|prohibited|do not|don't|no\b|금지)/i;
  return text.split("\n").some((line) => /gh pr merge/i.test(line) && negation.test(line));
}

/**
 * 스펙 §13.3 규칙을 검사한다. `installed`가 true면 `.claude/commands/know-thy-build/<name>.md`(치환 완료본),
 * false(기본)면 `templates/know-thy-build/<name>.md`(치환 전 템플릿)로 본다. 위반이 없으면 [].
 */
export function lintSkillMd(text, { name, installed = false } = {}) {
  const { frontmatter, sections } = parseSkillMd(text);
  const violations = [];

  if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
    violations.push({ rule: "description", msg: "frontmatter description must be a non-empty string" });
  }

  if (!Array.isArray(frontmatter["allowed-tools"]) || frontmatter["allowed-tools"].length === 0) {
    violations.push({ rule: "allowed-tools", msg: "frontmatter allowed-tools must be a non-empty array with >=1 entries" });
  }

  if (installed) {
    if (!/^##\s+Language(\s|$)/m.test(text)) {
      violations.push({ rule: "language", msg: "installed skill must have a ## Language section" });
    }
  } else if (!text.includes("{{LANG}}")) {
    violations.push({ rule: "language", msg: "template skill must contain the {{LANG}} placeholder" });
  }

  const present = [...sections.keys()];
  for (const s of SKILL_SECTIONS) {
    if (!sections.has(s)) {
      violations.push({ rule: "section", msg: `missing required section: ## ${s}` });
      continue;
    }
    if (!sections.get(s).trim()) {
      violations.push({ rule: "section-empty", msg: `section ## ${s} must not be empty` });
    }
  }
  let lastIdx = -1;
  let outOfOrder = false;
  for (const s of SKILL_SECTIONS) {
    if (!sections.has(s)) continue;
    const idx = present.indexOf(s);
    if (idx < lastIdx) outOfOrder = true;
    lastIdx = idx;
  }
  if (outOfOrder) {
    violations.push({ rule: "section-order", msg: `sections must appear in order: ${SKILL_SECTIONS.join(", ")}` });
  }

  if (name && OPERATIONAL_SKILLS.includes(name)) {
    if (!hasGhPrMergeProhibition(text)) {
      violations.push({ rule: "ops-gh-pr-merge", msg: `operational skill '${name}' must contain a sentence prohibiting 'gh pr merge'` });
    }
    if (!READ_ONLY_OPS.has(name)) {
      if (!text.includes("transition.js")) {
        violations.push({ rule: "ops-transition", msg: `operational skill '${name}' must mention transition.js` });
      }
      if (!text.includes("human-decision:v1")) {
        violations.push({ rule: "ops-human-decision", msg: `operational skill '${name}' must mention human-decision:v1` });
      }
    }
  }

  return violations;
}
