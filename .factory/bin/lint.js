#!/usr/bin/env node
/**
 * KTB 자신의 `lint` 게이트(감사 P1-7).
 *
 * 감사가 실측한 구성은 `lint = "node -e 0"`이었다 — required에 이름이 올라 있고, 판정 파일에는
 * "lint GREEN"이 남지만, 검사한 것은 아무것도 없다. 아무것도 검사하지 않는 게이트는 게이트가 아니라
 * **사람을 속이는 초록불**이므로 doctor가 이제 그것을 FAIL로 잡는다(`gates.lint-noop`). 그 검사가
 * 자기 저장소에서 거짓말이 되지 않으려면 KTB에도 진짜 린트가 있어야 한다. 새 의존성은 쓰지 않는다 —
 * 이미 이 저장소가 자기 검사를 위해 갖고 있는 것 셋을 한 명령으로 묶는다:
 *
 *   ① `node --check`   — 바뀐 JS의 파스 오류(문법이 깨진 채 머지되는 것을 막는다)
 *   ② `yml-lint`       — `.github/workflows/**`의 ADR-009/ADR-021 규칙(시크릿 범위·아티팩트 보관·
 *                        flow interpolation·`ready_for_review` 트리거 …)
 *   ③ `skill-md`       — `templates/know-thy-build/*.md` 스킬 문서의 프런트매터·섹션 계약
 *
 * usage: lint.js [--base <ref>] [--file <path>]… [--all]
 *   기본값은 `--all`(추적 중인 파일 전부). `--base`를 주면 그 ref와의 diff에 있는 파일만 본다.
 * exit: 0 문제 없음 / 1 위반 있음 / 2 린트 자체를 돌릴 수 없음(fail-closed — 판정 불가는 통과가 아니다)
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { lintWorkflow, isFactoryWorkflowFile } from "../lib/yml-lint.js";
import { lintSkillMd, ALL_SKILLS } from "../lib/skill-md.js";

const JS = new Set([".js", ".mjs", ".cjs"]);
/**
 * Workflow 툴 스크립트(`.claude/workflows/**`, 그리고 그 템플릿 원본)는 **독립 모듈이 아니다** —
 * 최상위 `return`을 쓰는 함수 본문으로 평가되므로 `node --check`는 전부 파스 오류로 읽는다.
 * 이 파일들의 계약은 `factory/test/workflows.test.js`가 따로 검사한다.
 */
const NOT_A_MODULE = /(^|\/)\.?claude\/workflows\//;
const WORKFLOW_DIR = ".github/workflows";
const SKILL_DIR = "templates/know-thy-build";

/** 한 파일에 대한 위반 목록. 읽을 수 없는 파일은 "문제 없음"이 아니다 — 그 자체가 위반이다. */
export function lintFile(file, { root = process.cwd() } = {}) {
  const abs = join(root, file);
  const out = [];
  if (!existsSync(abs)) return out;                       // 삭제된 파일은 린트 대상이 아니다
  if (JS.has(extname(file)) && !NOT_A_MODULE.test(file)) {
    const r = spawnSync(process.execPath, ["--check", abs], { encoding: "utf8" });
    if (r.status !== 0) out.push({ file, rule: "parse", msg: (r.stderr || "").trim().split("\n").slice(0, 3).join(" ") });
    return out;
  }
  let text;
  try { text = readFileSync(abs, "utf8"); }
  catch (e) { return [{ file, rule: "unreadable", msg: e.message }]; }
  if (file.startsWith(`${WORKFLOW_DIR}/`) && /\.ya?ml$/.test(file)) {
    const name = basename(file);
    for (const v of lintWorkflow(text, { file: name, factoryOwned: isFactoryWorkflowFile(name) })) {
      out.push({ file, rule: v.rule, msg: `${v.line ? `line ${v.line}: ` : ""}${v.msg}` });
    }
    return out;
  }
  if (file.startsWith(`${SKILL_DIR}/`) && file.endsWith(".md")) {
    const name = basename(file, ".md");
    if (!ALL_SKILLS.includes(name)) return out;           // 스킬이 아닌 문서(README 등)는 이 규칙의 대상이 아니다
    for (const v of lintSkillMd(text, { name })) out.push({ file, rule: v.rule, msg: v.msg });
  }
  return out;
}

const git = (args, root) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);

export function targets({ root, base = null, files = [] }) {
  if (files.length) return files;
  if (!base) return git(["ls-files"], root);
  // `A\tpath` / `R100\told\tnew` — 마지막 칸이 현재 경로다. 삭제(D)는 lintFile이 걸러낸다.
  return git(["diff", "--name-only", `${base}...HEAD`], root);
}

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) { console.log("usage: lint.js [--base <ref>] [--file <path>]… [--all]"); process.exit(0); }
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const files = args.flatMap((a, i) => (a === "--file" && args[i + 1] ? [args[i + 1]] : []));
  let root, list;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    list = targets({ root, base: flag("--base"), files });
  } catch (e) {
    // 대상을 정하지 못했으면 "위반 없음"이 아니라 판정 불가다(fail-closed).
    console.error(`lint: cannot determine targets — ${e.message}`);
    process.exit(2);
  }
  const violations = list.flatMap((f) => lintFile(f, { root }));
  for (const v of violations) console.error(`${v.file}: ${v.rule}: ${v.msg}`);
  console.log(`lint: ${list.length} file(s), ${violations.length} violation(s)`);
  process.exit(violations.length ? 1 : 0);
}
