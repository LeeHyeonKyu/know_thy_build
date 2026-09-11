import { join } from "node:path";
import { mkdtempSync, writeFileSync as writeFixture, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { render as renderTemplate } from "../../cli/install.js";
import { lintWorkflow, lintLoggingHook } from "../yml-lint.js";

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
  if (roles.triage?.agent) entries.push(roles.triage);
  for (const stage of ["plan", "implement", "review", "merge", "retro"]) {
    const s = roles[stage];
    if (!s) continue;
    for (const name of Object.keys(s)) entries.push(s[name]);
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
  const missingAgents = entries.filter((e) => e.agent && !exists(join(root, e.agent))).map((e) => e.agent);
  const missingLessons = entries.filter((e) => e.lessons && !exists(join(root, e.lessons))).map((e) => e.lessons);

  return [
    undefinedNames.length ? c("roles.roster-defined", "FAIL", `roster names not defined in roles.toml: ${undefinedNames.join(", ")}`) : c("roles.roster-defined", "PASS"),
    missingAgents.length ? c("roles.agent-files", "FAIL", `agent files missing (Plan 3 installs agents): ${missingAgents.join(", ")}`) : c("roles.agent-files", "PASS"),
    missingLessons.length ? c("roles.lessons-files", "WARN", `lessons files missing: ${missingLessons.join(", ")}`) : c("roles.lessons-files", "PASS"),
  ];
}

export function checkSettings({ settings, template }) {
  const out = [settings ? c("settings.present", "PASS") : c("settings.present", "FAIL", ".claude/settings.json missing")];
  const s = settings || {};
  const wantDeny = template.permissions?.deny || [];
  const haveDeny = new Set(s.permissions?.deny || []);
  const missingDeny = wantDeny.filter((d) => !haveDeny.has(d));
  out.push(missingDeny.length ? c("settings.deny", "FAIL", `deny list missing: ${missingDeny.join(", ")}`) : c("settings.deny", "PASS"));

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
    const protection = await gh.getBranchProtection(branch);
    const contexts = new Set(protection?.required_status_checks?.contexts || []);
    const required = harness.factory?.required_checks || [];
    const missingChecks = required.filter((r) => !contexts.has(r));

    return [
      hasClaude ? c("github.claude-secret", "PASS") : c("github.claude-secret", "FAIL", "set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY"),
      hasBot ? c("github.bot-token", "PASS") : c("github.bot-token", "FAIL", "set FACTORY_BOT_TOKEN"),
      issuedAt ? c("github.token-issued-at", "PASS", issuedAt) : c("github.token-issued-at", "WARN", "FACTORY_TOKEN_ISSUED_AT not set"),
      missingLabels.length ? c("github.labels", "WARN", `run factory bootstrap — missing labels: ${missingLabels.join(", ")}`) : c("github.labels", "PASS"),
      !protection || missingChecks.length
        ? c("github.protection", "WARN", `run factory bootstrap — missing required checks: ${missingChecks.join(", ")}`)
        : c("github.protection", "PASS"),
    ];
  } catch (e) {
    return [c("github.unavailable", "WARN", `gh unavailable — ${e.message}`)];
  }
}
