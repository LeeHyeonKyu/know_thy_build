#!/usr/bin/env node
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { CODEOWNERS_PATH, TWO_ACTOR_VARIABLE } from "../lib/bootstrap.js";
import { checkCodeowners, checkAgentToken, isCiWithToken, downgradeUnknownMode } from "../lib/doctor/merge-authority.js";

/**
 * ADR-021 r1 finding 2 — **머지 권한 판정을 CI에서 실제로 돌리는 유일한 진입점.**
 *
 * 왜 `factory doctor`가 아니라 별도의 bin인가:
 * 1. **판정 주체가 달라야 한다.** `tokens.agent-is-admin`·`tokens.agent-workflow-scope`·
 *    `protection.codeowners`는 전부 "에이전트 배우가 쥔 토큰이 무엇인가"를 묻는다. 그 토큰으로
 *    `gh`가 도는 잡은 sweeper뿐이다 — 머지 잡의 `GH_TOKEN`은 **머지 배우**의 것이라, 거기서 doctor를
 *    돌리면 "에이전트가 admin이다"라고 admin PAT을 보고 말하는 거짓 FAIL이 난다.
 * 2. **설치된 트리에는 `cli/`가 없다.** `factory init`은 `factory/lib/**`·`factory/bin/**`만
 *    `.factory/`로 복사한다. `lib/doctor/factory.js`는 `../../cli/install.js`를 import하므로 설치본에서
 *    **로드조차 되지 않는다** — 그래서 머지 권한 판정만 `lib/doctor/merge-authority.js`로 떼어냈고,
 *    이 파일은 `.factory/lib/**`만으로 돈다.
 * 3. **판정할 수 없는 것을 묻지 않는다.** `gh secret list`와 `GET …/branches/{b}/protection`은 둘 다
 *    repo **admin**을 요구한다. 봇이 그것을 읽을 수 있다면 그 사실 자체가 결함이다(=`agent-is-admin`).
 *    그래서 모드는 부트스트랩이 관측해 적어 둔 저장소 변수 `FACTORY_TWO_ACTOR`에서 읽는다 — 그 값이
 *    없으면 모드를 모르는 것이고, 모르는 채로 FAIL을 찍지 않는다(아래 `unknownMode`).
 *
 * **이 스크립트는 sweeping을 깨뜨리지 않는다.** 워크플로 스텝이 `continue-on-error: true`라 FAIL이
 * 나도 잡은 초록이고, 판정 줄은 `$GITHUB_STEP_SUMMARY`에 남는다 — 락 회수·재점화·라벨 복구는
 * 팩토리가 멈췄을 때 가장 필요한 팔들이고, "doctor가 빨갛다"는 이유로 그것들이 꺼지면 안 된다.
 */

const ICON = { PASS: "✅", WARN: "⚠️", FAIL: "❌" };

async function main() {
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim() || process.cwd();
  const repo = process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner;
  const gh = makeGh({ run, repo });
  const env = process.env;

  if (!isCiWithToken(env)) {
    console.error("factory doctor-ci: no CI token (CI + GH_TOKEN/FACTORY_BOT_TOKEN) — this entry point only makes sense inside the sweeper job, where gh runs as the agent actor. Nothing checked.");
    return 2;
  }

  // 모드는 부트스트랩의 **관측 기록**이다(사람이 고르는 플래그가 아니다 — ADR-021). 없으면 모른다.
  const recorded = await gh.getVariable(TWO_ACTOR_VARIABLE);
  const unknownMode = recorded == null;
  const twoActor = recorded === "true";

  const p = join(root, CODEOWNERS_PATH);
  const codeowners = existsSync(p) ? readFileSync(p, "utf8") : null;

  let checks = [
    ...(await checkCodeowners({ gh, twoActor, codeowners, env })),
    ...(await checkAgentToken({ gh, twoActor, env })),
  ];
  if (unknownMode) {
    checks = downgradeUnknownMode(checks, TWO_ACTOR_VARIABLE);
    checks.push({ id: "tokens.mode-recorded", level: "WARN", detail: `${TWO_ACTOR_VARIABLE} is not set on this repo — CI cannot observe the mode itself (\`gh secret list\` needs admin, which the agent actor must not have). Run \`npx know-thy-build factory bootstrap\` to record it` });
  } else {
    checks.push({ id: "tokens.mode-recorded", level: "PASS", detail: `${TWO_ACTOR_VARIABLE}=${recorded} (recorded by factory bootstrap)` });
  }

  const lines = checks.map((c) => `${ICON[c.level] || c.level} \`${c.id}\` — ${c.detail}`);
  for (const c of checks) console.log(`${c.level.padEnd(4)} ${c.id}  ${c.detail}`);

  const summary = env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const worst = checks.some((c) => c.level === "FAIL") ? "FAIL" : checks.some((c) => c.level === "WARN") ? "WARN" : "PASS";
    try {
      appendFileSync(summary, `### factory doctor — merge authority (ADR-021): ${ICON[worst]} ${worst}\n\n${lines.map((l) => `- ${l}`).join("\n")}\n\n`);
    } catch (e) {
      console.error(`factory doctor-ci: could not write the job summary — ${e.message}`);
    }
  }
  return checks.some((c) => c.level === "FAIL") ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => { console.error(`factory doctor-ci: ${e.message}`); process.exit(2); },
);
