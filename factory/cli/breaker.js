import { isAgentSession, principalFromEnv, refuseHumanFlag } from "../lib/transition.js";
import { readBreakerState, writeBreakerState, BREAKER_RESET_COMMAND, BREAKER_STATE_VERSION } from "../lib/breaker.js";

/**
 * #189 (S4c, ADR-033) — `factory breaker --reset --reason <text>`: 자동 머지 차단기를 **사람이** 닫는다.
 *
 * 사람 전용이다: `transition.js --human`과 같은 판정(`refuseHumanFlag` — 에이전트 세션이나 CI면 거부)을 **네트워크 호출 전에** 한다.
 * 이것은 두 번째 자물쇠다 — 환경 변수를 지운 호출은 이 검사를 지난다(첫 자물쇠인 훅 패턴은 사람이 `block-dangerous.sh`에 더한다,
 * plan non_goals). 닫은 사람은 `gh api user`의 로그인으로 `person:<login>`이 되어 상태 파일의 `closed_by`에 남는다 — 로그인을 모르면
 * 익명으로 닫지 않고 실패한다.
 *
 * 쓰기는 상태 파일 하나의 교체이고 `expectBlob`으로 묶인다: 읽은 뒤 그 사이에 sweep이나 다른 사람이 상태를 바꿨으면 아무것도
 * 밀지 않고 다시 돌리라고 말한다(조용히 덮어쓰지 않는다). 로컬 체크아웃에는 상태 파일을 남기지 않는다(`writeBreakerState`).
 *
 * `env`·`run`·`now`는 주입받는다 — 이 함수는 `process.env`를 직접 읽지 않는다(호출자 `cli/index.js`가 넘긴다).
 */
export const BREAKER_USAGE = `usage: ${BREAKER_RESET_COMMAND}\n  Closes the auto-merge breaker (person-only; refused in agent sessions and CI). The reason is recorded with your GitHub login.`;

export function parseBreakerArgs(argv = []) {
  let reset = false, reason = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reset") reset = true;
    else if (a === "--reason") { const v = argv[i + 1]; if (v !== undefined && !String(v).startsWith("--")) { reason = String(v); i++; } }
    else if (a.startsWith("--reason=")) reason = a.slice("--reason=".length);
  }
  const r = reason === null ? null : reason.trim();
  return { reset, reason: r ? r : null };
}

export async function breakerCommand({ root, argv = [], io, run, env = process.env, now = () => Date.now(), branch = "factory/records" }) {
  const { reset, reason } = parseBreakerArgs(argv);
  if (!reset) { io.err(BREAKER_USAGE); return 1; }
  if (refuseHumanFlag(env)) {
    const where = isAgentSession(env)
      ? "an agent session (CLAUDE_PROJECT_DIR / CLAUDECODE / CLAUDE_CODE_* is set)"
      : "CI (GITHUB_ACTIONS is set)";
    io.err(`factory breaker --reset refused — closing the auto-merge breaker is person-only, and this is ${where}. Run it from a person's own shell. Nothing was written.`);
    return 2;
  }
  if (!reason) { io.err(`factory breaker --reset needs --reason <text> — the reset is recorded with why it was closed. Nothing was written.`); return 1; }

  let who;
  try { who = await run("gh", ["api", "user", "--jq", ".login"], { cwd: root }); } catch (e) { who = { code: 1, stderr: `${e?.message || e}` }; }
  const login = who?.code === 0 ? String(who.stdout ?? "").trim() : "";
  if (!login || /\s/.test(login)) {
    io.err(`factory breaker --reset could not resolve your GitHub login (gh api user) — an anonymous reset is not recorded. Run \`gh auth login\` and retry. Nothing was written.`);
    return 1;
  }

  const cur = await readBreakerState({ run, cwd: root, branch });
  if (!cur.ok && !cur.corrupt) { io.err(`factory breaker --reset could not read the breaker state: ${cur.reason}. Nothing was written.`); return 1; }
  if (!cur.ok) io.err(`warning: the current breaker state is unreadable (${cur.reason}) — the reset replaces it`);

  const closedBy = principalFromEnv(env, login);
  const state = { version: BREAKER_STATE_VERSION, open: false, since: null, reason, closed_by: closedBy, closed_at: new Date(now()).toISOString() };
  const w = await writeBreakerState({ run, cwd: root, branch, state, blob: cur.blob ?? null, message: `breaker: reset by ${closedBy}` });
  if (w?.moved) {
    io.err(`the breaker state on ${branch} changed while you were resetting it — nothing was pushed; re-run \`${BREAKER_RESET_COMMAND}\` to reset the current state.`);
    return 1;
  }
  if (!w?.ok) { io.err(`factory breaker --reset failed — ${w?.reason || "unknown"}. Nothing was recorded.`); return 1; }
  const was = cur.state?.open ? ` (it was announced open since ${cur.state.since}: ${cur.state.reason})` : "";
  io.out(`auto-merge breaker closed by ${closedBy} at ${state.closed_at}: ${reason}${was}`);
  return 0;
}
