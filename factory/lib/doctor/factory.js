import { join, basename } from "node:path";
import { mkdtempSync, writeFileSync as writeFixture, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { render as renderTemplate, MOVED_DENIES_ADR_019 } from "../../cli/install.js";
import { lintWorkflow, lintLoggingHook } from "../yml-lint.js";
import { lintAgentMd } from "../agent-md.js";
import { lintSkillMd, ALL_SKILLS } from "../skill-md.js";
import { L0_CONTEXTS } from "../bootstrap.js";
import { GH_FREE_PLAN_PROTECTION_RE } from "../gh.js";

const c = (id, level, detail = "") => ({ id, level, detail });

const WORKFLOWS = ["triage", "plan", "implement", "review", "merge", "sweeper", "integrity"].map((n) => `factory-${n}.yml`);

const HOOK_INPUT = {
  "block-dangerous.sh": { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo doctor" } },
  "lint-touched.sh": { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/nonexistent" } },
  "stop-guard.sh": { hook_event_name: "Stop" },
};
// record-agents.sh와 verdict-format.sh는 둘 다 SubagentStop을 받는 리뷰어 훅이다 — 입력 모양을 하나로 공유한다.
// transcriptPath는 반드시 실재하는 파일이어야 한다: verdict-format.sh는 `[ -f "$path" ] || exit 0`으로 fail-open이라
// 없는 경로를 주면 판정 로직 자체를 검증하지 못하고 항상 PASS로 속게 된다.
const REVIEWER_AGENT_TYPE = "reviewer-doctor";
const subagentStopPayload = (transcriptPath) => ({ hook_event_name: "SubagentStop", agent_type: REVIEWER_AGENT_TYPE, agent_transcript_path: transcriptPath });
const NEEDS_TRANSCRIPT = new Set(["record-agents.sh", "verdict-format.sh"]);
// verdict-format.sh가 jq -rs로 읽는 형식과 정확히 일치해야 한다: transcript는 assistant 메시지들의 JSON 스트림이고,
// 마지막 text 블록에 ```json/"verdict" 블록이 없으면 "판정 안 됨"으로 exit 2가 나오는 게 정상이다(=판정 훅이 실제로 판정한다는 증거).
const TRANSCRIPT_FIXTURE = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "doctor probe: no verdict block here" }] } }) + "\n";
// 판정 훅(verdict-format.sh)만 예외: reviewer-* 입력에 verdict 블록이 없으면 exit 2가 "정상 동작"이다. 나머지는 0을 기대한다.
const EXPECTED_EXIT = { "verdict-format.sh": 2 };
// 로깅형 훅은 절대 차단하면 안 되므로 스크립트 마지막 줄이 `exit 0`이어야 한다(ADR-009) — lintLoggingHook로 추가 검사한다.
const LOGGING_HOOKS = new Set(["record-agents.sh", "lint-touched.sh"]);

/** manifest 중 owner === "factory" 항목만 대상(project/script 소유 파일은 CHARTER 등 사람이 편집하므로 비교 대상이 아니다). */
export function checkFiles({ manifest, root, exists, readFile, render = renderTemplate, vars = {} }) {
  const missing = [];
  const stale = [];
  for (const e of manifest) {
    if (e.owner !== "factory") continue;
    const target = join(root, e.dest);
    if (!exists(target)) { missing.push(e.dest); continue; }
    const fresh = render(readFile(e.src), vars);
    if (readFile(target) !== fresh) stale.push(e.dest);
  }
  return [
    missing.length ? c("files.missing", "FAIL", `missing: ${missing.join(", ")}`) : c("files.missing", "PASS"),
    stale.length ? c("files.stale", "WARN", `run factory init --upgrade — stale: ${stale.join(", ")}`) : c("files.stale", "PASS"),
  ];
}

/** CHARTER.md는 사람이 작성하는 project-owned 파일이라 아직 없거나 draft여도 정상 진행 상태다(WARN) — 파싱/스키마 깨짐만 FAIL. */
export function checkCharter({ root, loadCharter }) {
  let charter;
  try {
    charter = loadCharter(root);
  } catch (e) {
    const enoent = e.code === "ENOENT" || /ENOENT/.test(e.message || "");
    return [enoent ? c("charter", "WARN", "no CHARTER yet") : c("charter", "FAIL", e.message)];
  }
  return [charter.status !== "ready" ? c("charter", "WARN", `CHARTER status is ${charter.status} (not ready)`) : c("charter", "PASS")];
}

const rosterUnion = (obj) => [...new Set(Object.values(obj || {}).flat())];

// roles.toml 자체에 정의된 모든 agent/lessons 경로를 훑는다 — CHARTER 로스터에 없는 이름(예: plan.synthesizer처럼
// 아직 어느 tier도 쓰지 않는 역할)도 파일이 실재해야 한다. roster-defined와는 독립적인 검사다.
// triage만 이름 없이 단일 agent(roles.triage.agent)고, 나머지(plan/implement/review/merge/retro)는 이름별 로스터다.
function collectAllRoleEntries(roles) {
  const entries = [];
  if (roles.triage?.agent) entries.push({ stage: "triage", name: "triage", def: roles.triage });
  for (const stage of ["plan", "implement", "review", "merge", "retro"]) {
    const s = roles[stage];
    if (!s) continue;
    for (const name of Object.keys(s)) entries.push({ stage, name, def: s[name] });
  }
  return entries;
}

export function checkRoles({ charter, roles, exists, root }) {
  const reviewNames = rosterUnion(charter.roster);
  const planNames = rosterUnion(charter.plan_roles);
  const undefinedNames = [
    ...reviewNames.filter((n) => !roles.review?.[n]),
    ...planNames.filter((n) => !roles.plan?.[n]),
  ];

  const entries = collectAllRoleEntries(roles);
  // `retro`만 예외다: `[retro.analyst]`가 가리키는 `factory-retro.md`는 Plan 4가 설치한다(ADR-015 R3 / P3-R7).
  // Plan 3까지 설치를 끝낸 저장소에서 이것을 FAIL로 보고하면 doctor가 **항상** 빨갛고, 그러면 사람은 doctor를
  // 읽지 않게 된다 — 알려진·계획된 gap은 WARN이지 FAIL이 아니다. 나머지 스테이지는 그대로 FAIL이다.
  const missingAgents = [];
  const retroMissing = [];
  for (const e of entries) {
    if (!e.def.agent || exists(join(root, e.def.agent))) continue;
    (e.stage === "retro" ? retroMissing : missingAgents).push(e.def.agent);
  }
  const missingLessons = entries.filter((e) => e.def.lessons && !exists(join(root, e.def.lessons))).map((e) => e.def.lessons);

  // 두 줄로 나눈다 — 하나로 합치면 다른 스테이지의 FAIL이 retro WARN을 가려, 사람이 FAIL을 고친 다음에야
  // "아직 Plan 4가 남았다"는 사실을 처음 본다. 서로 다른 사실은 서로 다른 줄이다.
  return [
    undefinedNames.length ? c("roles.roster-defined", "FAIL", `roster names not defined in roles.toml: ${undefinedNames.join(", ")}`) : c("roles.roster-defined", "PASS"),
    missingAgents.length ? c("roles.agent-files", "FAIL", `agent files missing (Plan 3 installs agents): ${missingAgents.join(", ")}`) : c("roles.agent-files", "PASS"),
    retroMissing.length ? c("roles.retro-agent-file", "WARN", `retro agent file arrives with Plan 4: ${retroMissing.join(", ")}`) : c("roles.retro-agent-file", "PASS"),
    missingLessons.length ? c("roles.lessons-files", "WARN", `lessons files missing: ${missingLessons.join(", ")}`) : c("roles.lessons-files", "PASS"),
  ];
}

// loader는 roles.toml에 없다 — 로스터 역할이 아니라 workflow의 첫 스텝(P3-R1)이라 어떤 [stage.<name>] 블록에도
// 속하지 않는다. 그래도 설치되는 역할 파일이고 §7.2 규칙을 그대로 지켜야 하므로 lint 대상에 직접 넣는다.
const LOADER_AGENT = ".claude/agents/factory-loader.md";

/**
 * roles.toml이 가리키는 역할 `.md`(+ loader)를 전부 §7.2 규칙으로 lint한다 — 섹션·frontmatter·Examples 개수·
 * lessons 경로·쓰기 금지 훅. 파일이 **없는** 항목은 건너뛴다: 부재는 `roles.agent-files`가 이미 FAIL로 잡고
 * 있어서, 여기서 또 잡으면 같은 사실이 서로 다른 두 줄로 보고되고 사람이 두 번 고치려 든다.
 * id는 `agents.<파일 basename>`이다 — 파일명 = frontmatter name = agent_type 규약(Global Constraints)이라
 * 이 이름이 곧 훅 로그에서 대조되는 이름이다.
 */
export function checkAgents({ roles, root, readFile, exists }) {
  const paths = [];
  for (const e of collectAllRoleEntries(roles)) if (e.def.agent && !paths.includes(e.def.agent)) paths.push(e.def.agent);
  if (!paths.includes(LOADER_AGENT)) paths.push(LOADER_AGENT);

  const out = [];
  for (const rel of paths) {
    const abs = join(root, rel);
    if (!exists(abs)) continue;
    const name = basename(rel, ".md");
    const id = `agents.${name}`;
    let violations;
    try {
      violations = lintAgentMd(readFile(abs), { expectedName: name });
    } catch (e) {
      out.push(c(id, "FAIL", `${rel} unreadable: ${e.message}`));
      continue;
    }
    out.push(violations.length ? c(id, "FAIL", violations.map((v) => `${v.rule}: ${v.msg}`).join("; ")) : c(id, "PASS"));
  }
  return out;
}

const SKILLS_DIR = ".claude/commands/know-thy-build";

/**
 * §13.3/§13.4 — `npx know-thy-build`가 설치한 스킬 카탈로그를 검사한다. 설치 안 됐으면 안내만(PASS-info).
 * 설치돼 있으면 그 디렉터리의 `*.md` 전부를 `installed:true`로 lint하고(존재하는 파일은 이름과 무관하게
 * 전부 대상 — architect/designer도 §13.3 구조를 지켜야 한다, Task 2), 13개 카탈로그 중 없는 이름은 WARN.
 */
export function checkSkills({ root, exists, readFile, list = readdirSync }) {
  const dir = join(root, SKILLS_DIR);
  if (!exists(dir)) {
    return [c("skills.installed", "PASS", "not installed — npx know-thy-build")];
  }

  const files = list(dir).filter((f) => f.endsWith(".md")).sort();
  const found = new Set();
  const out = [];
  for (const f of files) {
    const name = basename(f, ".md");
    found.add(name);
    const id = `skills.${name}`;
    let violations;
    try {
      violations = lintSkillMd(readFile(join(dir, f)), { name, installed: true });
    } catch (e) {
      out.push(c(id, "FAIL", `${f} unreadable: ${e.message}`));
      continue;
    }
    out.push(violations.length ? c(id, "FAIL", violations.map((v) => `${v.rule}: ${v.msg}`).join("; ")) : c(id, "PASS"));
  }

  const missing = ALL_SKILLS.filter((n) => !found.has(n));
  out.push(missing.length
    ? c("skills.missing", "WARN", `missing: ${missing.join(", ")} — run \`npx know-thy-build\` to (re)install`)
    : c("skills.missing", "PASS"));

  return out;
}

/**
 * L2는 두 파일에 나뉘어 산다(ADR-019).
 * - `.claude/settings.json`: 사람의 대화형 세션에도 걸리는 Bash deny + allow + 훅. 경로 deny는 여기 없다 —
 *   deny는 allow로 못 이기므로, 여기에 `Edit(.factory/**)`를 두면 `:harness`·`:role`·`:technical` 같은
 *   사람-지점 스킬이 자기 일(빌드 설정 결정)을 할 수 없다.
 * - `.factory/ci-settings.json`: CI의 `claude -p --settings`로만 로드된다(run-stage.js·retro.js) — 경로
 *   deny 전부가 여기 산다. CI 에이전트의 L2는 그대로다.
 * 둘 다 검사한다: 한쪽만 보면 "설치됐다"가 "막힌다"를 뜻하지 않게 된다.
 */
export function checkSettings({ settings, template, ciSettings, ciTemplate }) {
  const out = [settings ? c("settings.present", "PASS") : c("settings.present", "FAIL", ".claude/settings.json missing")];
  const s = settings || {};
  const wantDeny = template.permissions?.deny || [];
  const haveDeny = new Set(s.permissions?.deny || []);
  const missingDeny = wantDeny.filter((d) => !haveDeny.has(d));
  out.push(missingDeny.length ? c("settings.deny", "FAIL", `deny list missing: ${missingDeny.join(", ")}`) : c("settings.deny", "PASS"));

  // ADR-019 이전에 설치한 저장소는 옮겨간 경로 deny를 아직 들고 있다 — `mergeSettings`가 가산적이라
  // 스스로 사라지지 않는다. WARN인 이유: L2는 (더 좁아진 것이 아니라) 여전히 유효하고, 깨진 것은
  // 사람의 스킬이다. `--upgrade`가 이제 이 줄들을 제거한다.
  const stale = MOVED_DENIES_ADR_019.filter((d) => haveDeny.has(d));
  out.push(stale.length
    ? c("settings.stale-deny", "WARN", `.claude/settings.json still denies ${stale.join(", ")} — moved to .factory/ci-settings.json (ADR-019); it blocks the human-point skills — run \`npx know-thy-build factory init --upgrade\``)
    : c("settings.stale-deny", "PASS"));

  if (ciTemplate) {
    if (!ciSettings) {
      out.push(c("settings.ci-deny", "FAIL", ".factory/ci-settings.json missing — CI agents would run without the path deny list"));
    } else {
      const wantCi = ciTemplate.permissions?.deny || [];
      const haveCi = new Set(ciSettings.permissions?.deny || []);
      const missingCi = wantCi.filter((d) => !haveCi.has(d));
      out.push(missingCi.length
        ? c("settings.ci-deny", "FAIL", `.factory/ci-settings.json deny list missing: ${missingCi.join(", ")}`)
        : c("settings.ci-deny", "PASS"));
    }
  }

  const cmdsOf = (hooks) => Object.values(hooks || {}).flat().flatMap((entry) => (entry.hooks || []).map((h) => h.command));
  const haveCmds = new Set(cmdsOf(s.hooks));
  const missingHooks = [...new Set(cmdsOf(template.hooks))].filter((cmd) => !haveCmds.has(cmd));
  out.push(missingHooks.length ? c("settings.hooks", "FAIL", `hook commands missing from settings.json: ${missingHooks.join(", ")}`) : c("settings.hooks", "PASS"));

  return out;
}

/**
 * 훅을 실제로 실행해 종료 코드와(로깅 훅이면) exit-0 규칙을 검사한다. 파일이 없으면 실행하지 않고 바로 FAIL.
 * record-agents.sh/verdict-format.sh를 검사 목록에 포함하면, 그 훅들이 실제로 읽을 수 있는 transcript 파일을
 * 임시 디렉터리에 하나 만들어 공유한다(둘 다 SubagentStop이므로 같은 파일을 써도 된다) — finally에서 정리한다.
 */
export async function checkHooks({
  run, root, exists, readFile, hooks,
  hooksDir = join(root, ".claude/hooks"),
  mkTemp = () => mkdtempSync(join(tmpdir(), "ktb-doctor-")),
  writeFile = writeFixture,
  rmDir = (d) => rmSync(d, { recursive: true, force: true }),
}) {
  const out = [];
  const needsTranscript = hooks.some((h) => NEEDS_TRANSCRIPT.has(h));
  let tmpDir, transcriptPath;
  if (needsTranscript) {
    tmpDir = mkTemp();
    transcriptPath = join(tmpDir, "transcript.jsonl");
    writeFile(transcriptPath, TRANSCRIPT_FIXTURE);
  }
  try {
    for (const name of hooks) {
      const id = `hooks.${name}`;
      const path = join(hooksDir, name);
      if (!exists(path)) { out.push(c(id, "FAIL", `${path} missing`)); continue; }
      const payload = NEEDS_TRANSCRIPT.has(name) ? subagentStopPayload(transcriptPath) : HOOK_INPUT[name] || { hook_event_name: "PreToolUse" };
      const expected = EXPECTED_EXIT[name] ?? 0;
      const r = await run("bash", [path], { input: JSON.stringify(payload), cwd: root });
      const problems = [];
      if (r.code !== expected) problems.push(`exit ${r.code} (${(r.stderr || r.stdout || "").trim().slice(0, 200)}), expected ${expected}`);
      if (LOGGING_HOOKS.has(name)) {
        const violations = lintLoggingHook(readFile(path));
        if (violations.length) problems.push(violations.map((v) => `${v.rule}: ${v.msg}`).join("; "));
      }
      out.push(problems.length ? c(id, "FAIL", problems.join("; ")) : c(id, "PASS"));
    }
  } finally {
    if (tmpDir) rmDir(tmpDir);
  }
  return out;
}

export function checkWorkflows({ root, exists, readFile }) {
  const missing = WORKFLOWS.filter((w) => !exists(join(root, ".github/workflows", w)));
  const violations = [];
  for (const w of WORKFLOWS) {
    if (missing.includes(w)) continue;
    const text = readFile(join(root, ".github/workflows", w));
    for (const v of lintWorkflow(text)) violations.push(`${w}:${v.line} ${v.rule}`);
  }
  return [
    missing.length ? c("workflows.present", "FAIL", `missing: ${missing.join(", ")}`) : c("workflows.present", "PASS"),
    violations.length ? c("workflows.lint", "FAIL", violations.join("; ")) : c("workflows.lint", "PASS"),
  ];
}

/** gh 호출이 하나라도 throw하면(오프라인 등) 세부 검사를 포기하고 단일 WARN으로 떨어진다 — fail closed가 아니라 "확인 못 함"으로 취급(오프라인 허용). */
export async function checkGitHub({ gh, harness, labels }) {
  try {
    const secrets = await gh.listSecrets();
    const hasClaude = secrets.includes("CLAUDE_CODE_OAUTH_TOKEN") || secrets.includes("ANTHROPIC_API_KEY");
    const hasBot = secrets.includes("FACTORY_BOT_TOKEN");
    const issuedAt = await gh.getVariable("FACTORY_TOKEN_ISSUED_AT");
    const have = new Set(await gh.listLabels());
    const missingLabels = labels.filter((l) => !have.has(l.name)).map((l) => l.name);
    const branch = harness.project?.default_branch;
    // getBranchProtection throws only for the GitHub-Free private-repo 403 (see gh.js) — a plain 404
    // (no protection yet) still resolves to `null` below, unchanged. Catch it locally, not in the outer
    // try/catch: the rest of this function's checks (secrets, labels, …) are still valid and must still be
    // reported — falling through to `github.unavailable` would throw away all of them over one 403.
    let protection = null;
    let protectionCheck;
    try {
      protection = await gh.getBranchProtection(branch);
    } catch (e) {
      if (!GH_FREE_PLAN_PROTECTION_RE.test(e.message)) throw e;
      protectionCheck = c("github.protection", "WARN", "branch protection unavailable on this plan (private repo on GitHub Free) — L0 off; make the repo public or upgrade");
    }
    const contexts = new Set(protection?.required_status_checks?.contexts || []);
    // L0(branch protection)와 L1(머지 스테이지)은 서로 다른 목록을 강제한다(ADR-015 보강, bootstrap.js 주석).
    // 보호 규칙이 요구해야 하는 것은 `L0_CONTEXTS`뿐이다 — `harness.factory.required_checks`를 여기에 대조하면
    // 부트스트랩이 절대 넣지 않는 체크를 doctor가 계속 "빠졌다"고 보고하게 된다(=고칠 수 없는 WARN).
    // required_checks는 별도 PASS 줄로 "L1이 머지 직전에 본다"고 보고만 한다.
    const missingChecks = L0_CONTEXTS.filter((r) => !contexts.has(r));
    const l1 = harness.factory?.required_checks || [];
    if (!protectionCheck) {
      protectionCheck = !protection || missingChecks.length
        ? c("github.protection", "WARN", `run factory bootstrap — branch protection is missing L0 contexts: ${missingChecks.join(", ")}`)
        : c("github.protection", "PASS", `L0 contexts: ${L0_CONTEXTS.join(", ")}`);
    }

    return [
      hasClaude ? c("github.claude-secret", "PASS") : c("github.claude-secret", "FAIL", "set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY"),
      hasBot ? c("github.bot-token", "PASS") : c("github.bot-token", "FAIL", "set FACTORY_BOT_TOKEN"),
      issuedAt ? c("github.token-issued-at", "PASS", issuedAt) : c("github.token-issued-at", "WARN", "FACTORY_TOKEN_ISSUED_AT not set"),
      missingLabels.length ? c("github.labels", "WARN", `run factory bootstrap — missing labels: ${missingLabels.join(", ")}`) : c("github.labels", "PASS"),
      protectionCheck,
      c("github.required-checks", "PASS", `enforced by L1 at merge: ${l1.length ? l1.join(", ") : "(none configured)"}`),
    ];
  } catch (e) {
    return [c("github.unavailable", "WARN", `gh unavailable — ${e.message}`)];
  }
}
