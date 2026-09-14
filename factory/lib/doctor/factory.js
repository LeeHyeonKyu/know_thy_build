import { join, basename } from "node:path";
import { mkdtempSync, writeFileSync as writeFixture, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { render as renderTemplate, mergeSettings, freshContent, MOVED_DENIES_ADR_019 } from "../../cli/install.js";
import { findProtBlock, protBlock, writeGlobs, ciDenyEntries, qaManifestDeny } from "../protected-paths.js";
import { lintWorkflow, lintLoggingHook, isFactoryWorkflowFile } from "../yml-lint.js";
import { lintAgentMd } from "../agent-md.js";
import { lintSkillMd, ALL_SKILLS } from "../skill-md.js";
import { L0_CONTEXTS, CODEOWNERS_PATH, RECORDS_BRANCH } from "../bootstrap.js";
import { checkMergeAuthority, checkHumanGate } from "./merge-authority.js";
import { GH_FREE_PLAN_PROTECTION_RE } from "../gh.js";
import { checkRehearsalCurrent, recordedRehearsal, rehearsalHash } from "../rehearsal.js";
import { TRIAGE_DEFAULT_VALUES } from "../config.js";

const c = (id, level, detail = "") => ({ id, level, detail });

// KTB-44 — `factory-rehearse.yml`이 여덟 번째다(ADR-025). 스테이지 워크플로가 아니라 **첫 이슈 전에
// 한 번 도는 잡**이지만, 없으면 `factory rehearse`가 띄울 것이 없고 큐가 영영 닫힌 채로 남는다.
const WORKFLOWS = ["triage", "plan", "implement", "review", "merge", "sweeper", "integrity", "rehearse"].map((n) => `factory-${n}.yml`);
const WORKFLOWS_DIR = ".github/workflows";

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

/**
 * merge:"settings" 항목(`.claude/settings.json`)의 "stale"을 바이트 동등이 아니라 `mergeSettings`
 * 자체로 정의한다(KTB-11). init/upgrade가 이 파일을 `mergeSettings(installed, template)`로 병합하므로
 * (manifest.js, install.js) — 병합해도 설치된 내용이 그대로면(=템플릿의 deny/allow/훅을 전부 갖고 있으면)
 * 사용자가 자기 항목을 더 넣었어도 stale이 아니다. 병합 결과가 달라지면(=템플릿 항목이 빠졌으면) stale이다.
 * 둘 중 하나라도 JSON으로 못 읽으면(사람이 깨뜨린 파일 등) 안전하게 바이트 비교로 되돌아간다.
 */
function settingsIsStale(installedText, freshText) {
  let installed, template;
  try {
    installed = JSON.parse(installedText);
    template = JSON.parse(freshText);
  } catch {
    return installedText !== freshText;
  }
  return !isDeepStrictEqual(mergeSettings(installed, template), installed);
}

/**
 * manifest 중 owner === "factory" 항목만 대상(project/script 소유 파일은 CHARTER 등 사람이 편집하므로
 * 비교 대상이 아니다). "신선한 내용"은 `freshContent` 하나로 계산한다 — 설치가 쓰는 것과 여기서
 * 비교하는 것이 같은 함수여야 생성물(M8의 훅 `prot`·ci-settings 경로 deny)이 매번 stale로 뜨지 않는다.
 */
export function checkFiles({ manifest, root, exists, readFile, render = renderTemplate, vars = {} }) {
  const missing = [];
  const stale = [];
  for (const e of manifest) {
    if (e.owner !== "factory") continue;
    const target = join(root, e.dest);
    if (!exists(target)) { missing.push(e.dest); continue; }
    const fresh = e.generate ? freshContent(e, { readFile, vars }) : render(readFile(e.src), vars);
    const installed = readFile(target);
    const isStale = e.merge === "settings" ? settingsIsStale(installed, fresh) : installed !== fresh;
    if (isStale) stale.push(e.dest);
  }
  return [
    missing.length ? c("files.missing", "FAIL", `missing: ${missing.join(", ")}`) : c("files.missing", "PASS"),
    stale.length ? c("files.stale", "WARN", `run factory init --upgrade — stale: ${stale.join(", ")}`) : c("files.stale", "PASS"),
  ];
}

// factory init이 디스크에 쓰는 것과 그 파일이 커밋되는 것은 별개다(KTB-12) — 생성물로서 의도적으로
// gitignore된 경로는 이 검사 대상이 아니다(디스크에 있어도 정상).
const GITIGNORED_BY_DESIGN = [".factory/out/", ".factory/node_modules/"];

/**
 * 설치된 manifest 파일이 실제로 git에 추적되는지 검사한다(KTB-12, 결함은 KTB 자신에서 관찰됨:
 * `.gitignore`가 `.claude/commands/`를 통째로 무시해 `factory init`이 쓴 `.claude/commands/factory-*.md`
 * 디스패처가 untracked였다 → CI 체크아웃엔 그 파일이 없고 `claude -p /factory-<stage>`가 전부 실패한다).
 * `git check-ignore --stdin`을 한 번에 배치로 돌려 디스크에 있는 manifest 대상 중 무시되는 것만 골라낸다.
 * git 저장소가 아니면(예: 격리된 픽스처) 추적 여부를 판단할 수 없으니 PASS-info로 넘어간다 — fail-closed로
 * FAIL을 내면 git 없는 환경에서 이 검사가 항상 빨갛게 고정된다.
 */
export async function checkFilesTracked({ manifest, root, exists, run }) {
  const paths = manifest
    .map((e) => e.dest)
    .filter((dest) => !GITIGNORED_BY_DESIGN.some((p) => dest.startsWith(p)))
    .filter((dest) => exists(join(root, dest)));

  if (!paths.length) return [c("files.tracked", "PASS")];

  const r = await run("git", ["check-ignore", "--stdin"], { cwd: root, input: paths.join("\n") + "\n" });
  // check-ignore exits 0(하나 이상 매치)/1(매치 없음)일 때만 정상 응답이다 — 그 외(127 spawn 실패,
  // 128 "not a git repository" 등)는 git을 신뢰할 수 없다는 뜻이라 "not a git repo"로 뭉뚱그린다.
  if (r.code !== 0 && r.code !== 1) {
    return [c("files.tracked", "PASS", "not a git repo")];
  }
  const ignored = (r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
  return [ignored.length
    ? c("files.tracked", "FAIL", `ignored by .gitignore: ${ignored.join(", ")} — un-ignore in .gitignore (e.g. \`!.claude/commands/factory-*.md\`) — CI checks out only tracked files`)
    : c("files.tracked", "PASS")];
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
  return [
    charter.status !== "ready" ? c("charter", "WARN", `CHARTER status is ${charter.status} (not ready)`) : c("charter", "PASS"),
    // 외부 감사 H6 — 사람 게이트는 gh를 전혀 필요로 하지 않는 CHARTER-only 판정이라 여기에 산다
    // (`checkGitHub`은 gh가 없으면 통째로 WARN 하나로 접힌다 — 이 선언은 그 침묵에 묻히면 안 된다).
    ...checkHumanGate(charter),
    // 외부 감사 M1 — 같은 모양의 CHARTER-only 선언. gh를 필요로 하지 않는다.
    ...checkTriageDefault(charter),
  ];
}

/**
 * 외부 감사 2026-09-14 M1 — **triage의 기본 판정은 기본값이 아니라 선언이다.**
 *
 * 감사 이전의 `factory-triage.md`는 "NEVER_AUTOMATE도 아니고 done_when도 쓸 수 있으면 `ready`"였다.
 * 곧 **판단이 서지 않는 이슈의 기본값이 통과**였고, 그것을 고른 저장소는 하나도 없었다 —
 * 침묵이 곧 승인이었다.
 *
 * 세 상태를 가른다(`merge.human_gate`와 같은 규칙):
 *  - `triage.default: needs-info` → PASS. 애매하면 멈춘다 — 템플릿의 기본이고, 침묵은 정지다.
 *  - `triage.default: ready`      → WARN `triage.default-allow`. 틀린 설정이 아니다(KTB·데모처럼
 *    다크 루프 자체가 산출물인 저장소는 이쪽을 고른다). 하지만 "애매한 이슈가 그냥 들어온다"는
 *    사실은 매 실행에서 소리 내어 말해야 한다.
 *  - 없거나 두 값이 아님 → FAIL `charter.triage-default-unset`.
 */
export function checkTriageDefault(charter) {
  const v = charter?.triage?.default;
  if (v === "needs-info") return [c("charter.triage-default", "PASS", "triage.default: needs-info — an issue the triage agent cannot write a concrete done_when for stops for a person; silence is not approval (audit M1)")];
  if (v === "ready") return [c("triage.default-allow", "WARN", "triage.default: ready — an issue that matches nothing in NEVER_AUTOMATE and carries a writable done_when goes straight into the factory without a person. That is a deliberate CHARTER choice; set `triage: { default: needs-info }` to make silence stop instead (audit M1)")];
  return [c("charter.triage-default-unset", "FAIL", `CHARTER declares no \`triage.default\` — whether an ambiguous issue stops or proceeds is not a default, it is a choice that has to be written down. Add \`triage: { default: needs-info }\` (silence stops) or \`triage: { default: ready }\` (default-allow, stated on purpose) to the CHARTER frontmatter; allowed values are ${TRIAGE_DEFAULT_VALUES.join(" | ")} (audit M1)`)];
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

// 외부 감사 2026-09-14 M5 — `factory-loader`는 없어졌다. workflow의 첫 스텝이 LLM 호출이 아니라
// `factory/lib/context.js`가 Node에서 만드는 `.factory/out/loaded.json`이 되면서, roles.toml에 없는데도
// lint 대상에 따로 넣어야 했던 역할 파일 하나가 통째로 사라졌다. 그래서 여기엔 예외 목록이 없다 —
// lint 대상은 `roles.toml`이 가리키는 경로 전부이고, 그것으로 끝이다.

/**
 * roles.toml이 가리키는 역할 `.md`를 전부 §7.2 규칙으로 lint한다 — 섹션·frontmatter·Examples 개수·
 * lessons 경로·쓰기 금지 훅. 파일이 **없는** 항목은 건너뛴다: 부재는 `roles.agent-files`가 이미 FAIL로 잡고
 * 있어서, 여기서 또 잡으면 같은 사실이 서로 다른 두 줄로 보고되고 사람이 두 번 고치려 든다.
 * id는 `agents.<파일 basename>`이다 — 파일명 = frontmatter name = agent_type 규약(Global Constraints)이라
 * 이 이름이 곧 훅 로그에서 대조되는 이름이다.
 */
export function checkAgents({ roles, root, readFile, exists }) {
  const paths = [];
  for (const e of collectAllRoleEntries(roles)) if (e.def.agent && !paths.includes(e.def.agent)) paths.push(e.def.agent);

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
export function checkSettings({ settings, template, ciSettings, ciTemplate, ciHarness, ciHarnessTemplate }) {
  const out = [settings ? c("settings.present", "PASS") : c("settings.present", "FAIL", ".claude/settings.json missing")];
  const s = settings || {};
  const wantDeny = template.permissions?.deny || [];
  const haveDeny = new Set(s.permissions?.deny || []);
  const missingDeny = wantDeny.filter((d) => !haveDeny.has(d));
  out.push(missingDeny.length
    ? c("settings.deny", "FAIL", `deny list missing: ${missingDeny.join(", ")} — run \`npx know-thy-build factory init --upgrade\``)
    : c("settings.deny", "PASS"));

  // allow도 deny와 같은 무게로 검사한다(KTB-13). `--permission-mode dontAsk`는 allow에 걸리지 않는 도구
  // 호출을 묻지 않고 **거절**한다 — "묻지 않는다"가 "승인한다"가 아니다(ADR-002/ADR-008의 스파이크 관측은
  // 지금 CLI에서 더는 성립하지 않는다). 그래서 allow는 편의 목록이 아니라 **에이전트가 가진 도구 목록**이고,
  // 항목이 빠진 설치본은 builder가 파일을 쓰지 못하는 설치본이다 — WARN이 아니라 FAIL이다.
  const wantAllow = template.permissions?.allow || [];
  const haveAllow = new Set(s.permissions?.allow || []);
  const missingAllow = wantAllow.filter((a) => !haveAllow.has(a));
  out.push(missingAllow.length
    ? c("settings.allow", "FAIL", `allow list missing: ${missingAllow.join(", ")} — under \`dontAsk\` an un-allowed tool call is denied; run \`npx know-thy-build factory init --upgrade\``)
    : c("settings.allow", "PASS"));

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

  // KTB-20: `factory:harness` 이슈의 implement가 `--settings`로 싣는 변형 파일(§5.2.1). 없으면 run-stage가
  // 그 이슈에서 needs-human으로 멈춘다(조용한 fallback은 승격 없는 승격 PR을 재현한다) — 그래서 FAIL이다.
  // ci-settings.json과 같은 무게로 deny 목록까지 본다: "설치됐다"가 "막는다"를 뜻해야 한다.
  if (ciHarnessTemplate) {
    if (!ciHarness) {
      out.push(c("settings.ci-harness", "FAIL", `.factory/ci-settings-harness.json missing — a factory:harness issue would stop at needs-human instead of doing the promotion; run \`npx know-thy-build factory init --upgrade\``));
    } else {
      const have = new Set(ciHarness.permissions?.deny || []);
      const missing = (ciHarnessTemplate.permissions?.deny || []).filter((d) => !have.has(d));
      out.push(missing.length
        ? c("settings.ci-harness", "FAIL", `.factory/ci-settings-harness.json deny list missing: ${missing.join(", ")}`)
        : c("settings.ci-harness", "PASS"));
    }
  }

  const cmdsOf = (hooks) => Object.values(hooks || {}).flat().flatMap((entry) => (entry.hooks || []).map((h) => h.command));
  const haveCmds = new Set(cmdsOf(s.hooks));
  const missingHooks = [...new Set(cmdsOf(template.hooks))].filter((cmd) => !haveCmds.has(cmd));
  out.push(missingHooks.length ? c("settings.hooks", "FAIL", `hook commands missing from settings.json: ${missingHooks.join(", ")}`) : c("settings.hooks", "PASS"));

  return out;
}

/**
 * `protected.parity` — 보호 목록 세 곳이 **한 출처에서 나왔는가**(2026-09-14 외부 감사 M8 / ADR-023).
 *
 * 감사가 확인한 상태: `harness.toml [protected].factory`, `.factory/ci-settings*.json`의 Edit/Write deny,
 * `.claude/hooks/block-dangerous.sh`의 `prot` 정규식이 **손으로 유지되는 세 목록**이었고 실제로 갈라져
 * 있었다. 갈라진 목록은 "Edit는 막히는데 `echo > x`는 통과한다"를 만든다.
 * 리뷰 batch-2 MF-2 — 생성의 출처는 `[protected].factory` **하나가 아니다**: `[protected].runner_only`
 * (러너만 쓰는 경로, 예: `docs/factory/runs/**`)가 쓰기 경계 쪽에만 더해진다(`writeGlobs`). 이 검사는
 * 그 합을 그대로 비교하므로, runner_only를 고치고 `--upgrade`를 안 돌린 것도 FAIL로 잡힌다.
 *
 * 이제 `factory init`이 나머지 둘을 harness에서 생성하므로, 이 검사는 "생성 후에 손으로 고쳤는가 /
 * harness를 고치고 `--upgrade`를 안 돌렸는가"를 묻는다. 드리프트는 **FAIL**이다 — WARN이면 그 경고를
 * 안고 사는 동안 훅과 L2가 서로 다른 파일을 막는다.
 *
 * 파일을 못 읽는 것도 FAIL이다(판정 불능은 "안전"이 아니다). 목록이 비어 있는 것도 FAIL이다 — 빈
 * `[protected].factory`는 보호가 없다는 뜻이고, 그러면 생성된 `prot`가 아무것도 막지 않는다.
 */
export function checkProtectedParity({ root, exists, readFile, harness }) {
  const prot = harness?.protected;
  if (!prot || !Array.isArray(prot.factory) || !prot.factory.length) {
    return [c("protected.parity", "FAIL", "harness.toml [protected].factory is missing or empty — nothing derives the hook's protected list or the CI path denies")];
  }
  const problems = [];
  const hookPath = join(root, ".claude/hooks/block-dangerous.sh");
  if (!exists(hookPath)) {
    problems.push(".claude/hooks/block-dangerous.sh missing");
  } else {
    let text; try { text = readFile(hookPath); } catch (e) { text = null; problems.push(`block-dangerous.sh unreadable: ${e.message}`); }
    if (text != null) {
      const found = findProtBlock(text);
      if (found === null) problems.push("block-dangerous.sh has no `factory:protected` generated block (hand-maintained list)");
      else if (found !== protBlock(prot)) problems.push("block-dangerous.sh `prot` list differs from harness.toml [protected]");
    }
  }
  for (const [file, harnessMode] of [[".factory/ci-settings.json", false], [".factory/ci-settings-harness.json", true]]) {
    const p = join(root, file);
    if (!exists(p)) { problems.push(`${file} missing`); continue; }
    let deny;
    try { deny = JSON.parse(readFile(p))?.permissions?.deny || []; } catch (e) { problems.push(`${file} unreadable: ${e.message}`); continue; }
    const have = deny.filter((d) => /^(Edit|Write)\(/.test(d));
    // ADR-024 / KTB-42(리뷰 라운드 1 SF-1b) — 매니페스트 한 쌍은 `[protected]`에서 **유도되지 않는다**:
    // 그 목록은 qa 디렉터리를 일부러 열어 두고, 이 한 파일만 그 안에서 다시 닫는 것은 증거 계약의
    // 결정이다(`install.js` renderCiSettings가 언제나 덧붙인다). parity가 그것을 "유도되지 않은 항목"으로
    // 읽으면 갓 설치한 저장소가 FAIL이 된다 — 기대값에 포함시켜, 빠진 경우도 여기서 잡히게 한다.
    const want = [...ciDenyEntries(writeGlobs(prot, { harnessMode, enumerateFactory: true })), ...qaManifestDeny()];
    const missing = want.filter((d) => !have.includes(d));
    const extra = have.filter((d) => !want.includes(d));
    if (missing.length) problems.push(`${file} deny missing: ${missing.join(", ")}`);
    if (extra.length) problems.push(`${file} deny has entries not derived from harness.toml [protected]: ${extra.join(", ")}`);
  }
  return [problems.length
    ? c("protected.parity", "FAIL", `${problems.join("; ")} — run \`npx know-thy-build factory init --upgrade\` (the hook's prot list and the CI path denies are generated from harness.toml [protected]; edit that file, not the generated ones)`)
    : c("protected.parity", "PASS")];
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

/**
 * **존재 검사는 팩토리의 일곱 파일에만, lint는 `.github/workflows/*.yml` 전부에** 건다(ADR-021 r1 MF-2 d).
 *
 * 예전에는 둘 다 그 일곱 이름만 돌았고, 그것이 `merge-token-scope`의 파일 범위 갈래를 무력하게
 * 만들었다: 목록에 없는 이름(`ci.yml`·`x.yml`·에이전트가 방금 밀어 넣은 아무 파일)은 머지 토큰을
 * 통째로 env에 실어도 린트가 **쳐다보지도 않았다**. 규칙의 넓이가 목록의 길이였던 셈이다.
 * 이제 디렉터리를 읽어 실재하는 모든 워크플로를 돈다 — 규칙이 저장소를 따라다닌다.
 *
 * 디렉터리를 못 읽으면(`.github/workflows`가 없는 저장소) 일곱 파일의 부재가 이미 FAIL로 보고되므로
 * lint 쪽은 조용히 빈 목록으로 둔다 — 같은 사실을 두 줄로 말하지 않는다.
 */
export function checkWorkflows({ root, exists, readFile, list = readdirSync }) {
  const dir = join(root, WORKFLOWS_DIR);
  const missing = WORKFLOWS.filter((w) => !exists(join(dir, w)));
  let files = [];
  try {
    files = list(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch {
    files = WORKFLOWS.filter((w) => exists(join(dir, w)));
  }
  const violations = [];
  for (const w of files) {
    let text;
    try {
      text = readFile(join(dir, w));
    } catch (e) {
      violations.push(`${w}: unreadable — ${e.message}`);
      continue;
    }
    // 파일명을 함께 넘긴다(ADR-021) — `merge-token-scope`의 파일 범위 갈래는 "이 텍스트가 어느
    // 워크플로인가"를 알아야만 판정할 수 있다(이름 없는 스니펫에서는 침묵한다).
    //
    // KTB-34: 소유권도 여기서 판정해 넘긴다 — "어떤 이름이 팩토리 것인가"는 `factory init`이 무엇을
    // 설치하는지 아는 이 모듈의 지식이지, 순수 텍스트 린터(`lintWorkflow`)의 지식이 아니다. 소유가
    // 아니면(예: 입양자의 `build.yml`) 팩토리 템플릿 모양을 가정하는 규칙들은 침묵하고,
    // `merge-token-scope`(ADR-021)만 어느 파일에서든 그대로 판정한다.
    const factoryOwned = isFactoryWorkflowFile(w);
    for (const v of lintWorkflow(text, { file: w, factoryOwned })) violations.push(`${w}:${v.line} ${v.rule}`);
  }
  return [
    missing.length ? c("workflows.present", "FAIL", `missing: ${missing.join(", ")}`) : c("workflows.present", "PASS"),
    violations.length ? c("workflows.lint", "FAIL", violations.join("; ")) : c("workflows.lint", "PASS", `linted ${files.length} file(s) in ${WORKFLOWS_DIR}`),
  ];
}

/**
 * KTB-44 / ADR-025 — `rehearsal.current`. **기록된 리허설이 지금의 하네스에 대한 것인가.**
 * 지문은 로컬에서 계산하고(harness.toml + CHARTER 프론트매터), 기록은 저장소에서 읽는다 — 변수
 * `FACTORY_REHEARSED`와 **지문 커밋**의 `factory/rehearsal` 상태를 **둘 다** 본다(하나라도 맞으면 PASS,
 * 리뷰 should_fix 1). gh가 없으면(오프라인) 호출자가 `skipped`로 WARN을 세운다.
 *
 * `recordedRehearsal`은 자기 안에서 모든 throw를 삼키고 항상 resolve한다 — 그래서 여기에 catch를 두지
 * 않는다(리뷰 nit 2: 죽은 코드였다). 조회가 통째로 실패한 경우는 "기록 없음"과 같은 모양으로 도착하고,
 * 그 등급은 WARN이다(설치 직후와 구별되지 않는다 — 그 구별은 `factory rehearse`의 출력이 한다).
 */
export async function checkRehearsal({ gh, root, readFile, harness }) {
  const read = (p) => { try { return readFile(join(root, p)); } catch { return null; } };
  const harnessText = read(".factory/harness.toml");
  if (harnessText == null) return [checkRehearsalCurrent({ current: null })];
  const current = rehearsalHash({ harnessText, charterText: read("docs/factory/CHARTER.md") || "" });
  /**
   * 최종 리뷰 B-SF2 — **`current`를 같이 넘긴다.** `makeRehearsalChecker`는 넘기고 doctor만 넘기지
   * 않아서, 두 독자가 같은 기록을 다르게 읽었다: `current`가 있으면 후보를 훑다 **일치를 만나는 순간
   * 멈추고**(= r2의 tolerant binding), 없으면 가장 새 후보에서 읽은 해시를 끝까지 들고 간다. 되돌아보는
   * 창 안에 기록된 해시가 둘이고 지금 지문이 옛 쪽이면(harness.toml 되돌리기, CHARTER 프론트매터 토글)
   * `→ factory:queue`는 통과하는데 doctor는 FAIL로 1을 뱉는다.
   */
  const recorded = await recordedRehearsal({ gh, branch: harness?.project?.default_branch || "main", current });
  return [checkRehearsalCurrent({ recorded, current })];
}

/** gh 호출이 하나라도 throw하면(오프라인 등) 세부 검사를 포기하고 단일 WARN으로 떨어진다 — fail closed가 아니라 "확인 못 함"으로 취급(오프라인 허용). */
/**
 * 리뷰 batch-1 MF-2 — `protection.records`. 머지 스테이지가 리뷰 handoff를 대조하는 상대는
 * `factory/records`의 run 기록이다. 그 브랜치가 force-push/삭제로 다시 쓰일 수 있으면 대조는
 * 아무것도 증명하지 않는다 — 그래서 "보호가 없다"는 조용히 넘어갈 사실이 아니라 매 실행에서
 * 소리 내어 말할 사실이다(WARN: 플랜·권한 때문에 못 거는 저장소가 정당하게 존재한다. 그때 증거를
 * 지키는 것은 block-dangerous 훅 하나뿐이고, 그 문장이 그대로 detail에 실린다).
 */
export async function checkRecordsProtection({ gh }) {
  let p = null;
  try {
    p = await gh.getBranchProtection(RECORDS_BRANCH);
  } catch (e) {
    return [c("protection.records", "WARN", `records branch unprotected — evidence relies on hooks (${RECORDS_BRANCH}: ${e.message})`)];
  }
  if (!p) return [c("protection.records", "WARN", `records branch unprotected — evidence relies on hooks. The merge stage checks every review handoff against the run record on ${RECORDS_BRANCH}; without force-push/deletion protection that record can be rewritten. Run \`factory bootstrap\` (the branch must exist first — the first stage run creates it)`)];
  const force = p.allow_force_pushes?.enabled ?? p.allow_force_pushes;
  const del = p.allow_deletions?.enabled ?? p.allow_deletions;
  if (force || del) return [c("protection.records", "WARN", `records branch unprotected — evidence relies on hooks: ${RECORDS_BRANCH} allows ${force ? "force pushes" : ""}${force && del ? " and " : ""}${del ? "deletion" : ""}, so a recorded review verdict can be rewritten. Run \`factory bootstrap\``)];
  return [c("protection.records", "PASS", `${RECORDS_BRANCH}: no force pushes, no deletion — the review evidence the merge stage checks against is append-only (the single-credential residual stands: the runner and the agent share one token, ADR-023)`)];
}

export async function checkGitHub({ gh, harness, labels, env = process.env, root = null, exists = null, readFile = null }) {
  // ADR-021 r1 MF-1 — CODEOWNERS는 **저장소의 파일**이지 API 상태가 아니다. gh가 하나라도 실패해
  // 아래 catch로 떨어지면 이 값은 쓰이지 않는다 — 읽기 자체는 부수효과가 없으므로 먼저 읽어 둔다.
  let codeowners = null;
  if (root && exists && readFile) {
    const p = join(root, CODEOWNERS_PATH);
    if (exists(p)) { try { codeowners = readFile(p); } catch { codeowners = null; } }
  }
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
    let protectionUnavailable = false;
    try {
      protection = await gh.getBranchProtection(branch);
    } catch (e) {
      if (!GH_FREE_PLAN_PROTECTION_RE.test(e.message)) throw e;
      protectionUnavailable = true;
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
      ...(await checkRecordsProtection({ gh })),
      ...(await checkMergeAuthority({ gh, secrets, branch, protection, protectionUnavailable, env, codeowners })),
    ];
  } catch (e) {
    return [c("github.unavailable", "WARN", `gh unavailable — ${e.message}`)];
  }
}
